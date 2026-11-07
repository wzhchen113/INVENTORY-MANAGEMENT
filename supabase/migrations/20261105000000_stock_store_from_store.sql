-- ============================================================
-- Spec 184 — stock a store in bulk by copying what it lacks from another store
-- of the same brand, plus the read that feeds the stock dialog.
--
-- Creating a store inserts only a `stores` row, so a new store has nothing to
-- count or order until each item is added by hand. Two functions fix that:
--
--   public.stock_store_from_store(target, source, extra_catalog_ids)
--     Atomic write. Copies each eligible source row whose catalog_id the target
--     lacks, plus its same-brand vendor links, and adds any ticked catalog rows
--     still carried by no store in the brand. Never changes an existing row.
--
--   public.stock_store_preview(brand, target)
--     One-snapshot read of the same numbers, per source, so the dialog's counts
--     come from the same rules as the write (pinned by T-34).
--
-- STRICTLY ADDITIVE: two functions, their comments and their grants. No table,
-- column, index, constraint, policy, trigger or publication change, therefore
-- NO `docker restart supabase_realtime_imr-inventory` step.
--
-- SECURITY INVOKER on both (design N1, the create_inventory_item_with_catalog
-- precedent), so RLS stays a second check beneath the gates. It is safe because
-- of gate G-7: privileged AND auth_can_see_brand(b) implies every store of b is
-- visible (a super-admin through auth_can_see_store arm (i); otherwise
-- auth_is_admin() is true and arm (ii) passes for every store of b), so an
-- invoker read of "carried by no store in the brand" cannot under-count. The two
-- store checks alone do not imply this: auth_can_see_store has a user_stores arm
-- that a stale admin JWT can pass without seeing the brand (design F-4, T-26).
--
-- Items and links are SEPARATE statements, deliberately. The
-- store_member_insert_item_vendors WITH CHECK reads inventory_items in a
-- subquery, which runs on the statement's snapshot and cannot see a parent row
-- inserted by the same statement, so a writable-CTE copy is refused with 42501
-- under `authenticated` (design F-3; T-05b executes that refusal).
--
-- PROD-APPLY (spec 064 gate, project MEMORY): ONLY on the owner's explicit
-- go-ahead, BEFORE the push that carries this file. Spec 184 §10: apply this
-- file line 1 to the final `commit;` as one MCP execute_sql call, then
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261105000000', 'stock_store_from_store')
--   on conflict (version) do nothing;
-- as a separate call, verify the normalized md5s, and run the raise-always
-- probes. NOT `apply_migration`, which mints its own version.
-- ============================================================

begin;

set local lock_timeout = '5s';

create or replace function public.stock_store_from_store(
  p_target_store_id   uuid,
  p_source_store_id   uuid,
  p_extra_catalog_ids uuid[] default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_target_brand   uuid;
  v_source_brand   uuid;
  v_brand          uuid;
  v_source_name    text;

  v_ticks          uuid[];

  -- The plan: one statement, one snapshot (D-3).
  v_eligible_count int;
  v_plan_items     public.inventory_items[];
  v_plan_links     public.item_vendors[];   -- same-brand links of the items to add
  v_foreign_links  uuid[];                  -- one source item id per cross-brand link

  -- What statement 1 actually inserted (N3: only these rows get links).
  v_new_ids        uuid[];
  v_new_catalogs   uuid[];
  v_new_vendors    uuid[];

  v_items_copied   int;
  v_links_added    int;
  v_links_skipped  int;
  v_no_link        int;
  v_extras_added   int := 0;
  v_extras_skipped int := 0;
  v_has_schedule   boolean;
  v_uncarried      int;
begin
  -- ─── Gates, in the design's order, before any write. Visibility precedes
  --     existence on purpose: a brand admin gets 42501 for both a missing and a
  --     foreign store, so there is no existence oracle.
  if not public.auth_is_privileged() then                                  -- G-1
    raise exception 'stock_store: privileged only' using errcode = '42501';
  end if;

  if p_target_store_id is null or p_source_store_id is null then           -- G-2
    raise exception 'stock_store: target and source store are required'
      using errcode = '22023';
  end if;

  if p_target_store_id = p_source_store_id then                            -- G-3
    raise exception 'stock_store: source and target must differ'
      using errcode = '22023';
  end if;

  if not public.auth_can_see_store(p_target_store_id) then                 -- G-4
    raise exception 'stock_store: target store not accessible'
      using errcode = '42501';
  end if;

  if not public.auth_can_see_store(p_source_store_id) then                 -- G-4b
    raise exception 'stock_store: source store not accessible'
      using errcode = '42501';
  end if;

  select s.brand_id into v_target_brand
    from public.stores s where s.id = p_target_store_id;
  select s.brand_id, s.name into v_source_brand, v_source_name
    from public.stores s where s.id = p_source_store_id;

  if v_target_brand is null or v_source_brand is null then                 -- G-5
    raise exception 'stock_store: store not found' using errcode = '22023';
  end if;

  if v_target_brand <> v_source_brand then                                 -- G-6
    raise exception 'stock_store: stores must be in the same brand'
      using errcode = '22023';
  end if;
  v_brand := v_target_brand;

  if not public.auth_can_see_brand(v_brand) then                           -- G-7
    raise exception 'stock_store: brand not accessible' using errcode = '42501';
  end if;

  -- G-8: the left join also catches a null element (its c.id is null too).
  if exists (
    select 1
      from unnest(p_extra_catalog_ids) as t(catalog_id)
      left join public.catalog_ingredients c
        on c.id = t.catalog_id and c.brand_id = v_brand
     where c.id is null
  ) then
    raise exception 'stock_store: catalog id not in this brand'
      using errcode = '22023';
  end if;

  -- AC-16: a null and an empty array both mean no ticks. Duplicates collapse.
  select coalesce(array_agg(distinct t.catalog_id), '{}') into v_ticks
    from unnest(p_extra_catalog_ids) as t(catalog_id);

  -- ─── D-1. Serialize per brand, not per target, so "carried by no store"
  --     holds between runs on different targets. After the gates, so a refused
  --     caller holds nothing. Released at transaction end. ON CONFLICT below
  --     stays too (D-2): create_inventory_item_with_catalog and direct inserts
  --     don't take this lock.
  perform pg_advisory_xact_lock(hashtext('stock_store:' || v_brand::text));

  -- ─── D-3. Read the plan in one statement, so items and links share a snapshot
  --     and a concurrent edit at the source can't split a scalar from its links.
  --     Vendors are left-joined with a brand predicate rather than inner-joined:
  --     under RLS a foreign vendor is invisible to a brand admin and excluded by
  --     the predicate for a super-admin, so both callers count it the same way.
  with to_add as (
    select i.id
      from public.inventory_items i
      join public.catalog_ingredients c
        on c.id = i.catalog_id and c.brand_id = v_brand
     where i.store_id = p_source_store_id
       and not exists (
         select 1 from public.inventory_items t
          where t.store_id = p_target_store_id
            and t.catalog_id = i.catalog_id
       )
  )
  select
    (select count(*)::int
       from public.inventory_items i
       join public.catalog_ingredients c
         on c.id = i.catalog_id and c.brand_id = v_brand
      where i.store_id = p_source_store_id),
    (select coalesce(array_agg(i), '{}')
       from public.inventory_items i
      where i.id in (select a.id from to_add a)),
    (select coalesce(array_agg(iv), '{}')
       from public.item_vendors iv
       join public.vendors v on v.id = iv.vendor_id and v.brand_id = v_brand
      where iv.item_id in (select a.id from to_add a)),
    (select coalesce(array_agg(iv.item_id), '{}')
       from public.item_vendors iv
       left join public.vendors v on v.id = iv.vendor_id and v.brand_id = v_brand
      where iv.item_id in (select a.id from to_add a)
        and v.id is null)
  into v_eligible_count, v_plan_items, v_plan_links, v_foreign_links;

  -- ─── D-4 + D-5. Statement 1: insert the items. The target's vendor_id is
  --     derived from the links it will actually have: the link matching the
  --     source's scalar (SD-1, the scalar wins), else the flagged primary, else
  --     null. Identical to a plain copy on a consistent row; a scalar with no
  --     link becomes null, so a target never has a scalar without its link.
  with plan as (
    select * from unnest(v_plan_items)
  ), links as (
    select * from unnest(v_plan_links)
  ), primaries as (
    select distinct on (l.item_id) l.item_id, l.vendor_id
      from links l
      join plan p on p.id = l.item_id
     where l.vendor_id = p.vendor_id or l.is_primary
     order by l.item_id, (l.vendor_id is not distinct from p.vendor_id) desc
  ), ins as (
    insert into public.inventory_items (
      store_id, catalog_id, vendor_id,
      cost_per_unit, case_price,
      par_level, safety_stock, usage_per_portion,
      current_stock, eod_remaining, average_daily_usage
    )
    select
      p_target_store_id, p.catalog_id, pr.vendor_id,
      p.cost_per_unit, p.case_price,
      p.par_level, p.safety_stock, p.usage_per_portion,
      0, 0, 0
    from plan p
    left join primaries pr on pr.item_id = p.id
    on conflict (store_id, catalog_id) do nothing
    returning id, catalog_id, vendor_id
  )
  select coalesce(array_agg(n.id), '{}'),
         coalesce(array_agg(n.catalog_id), '{}'),
         coalesce(array_agg(n.vendor_id), '{}')
    into v_new_ids, v_new_catalogs, v_new_vendors
    from ins n;

  v_items_copied := cardinality(v_new_ids);

  -- ─── D-6. Statement 2: links, for rows this call really inserted (N3, AC-8).
  --     A separate statement on purpose; see the file header (F-3).
  insert into public.item_vendors (
    item_id, vendor_id, cost_per_unit, case_price, is_primary,
    order_code, product_page_url
  )
  select
    n.new_id, l.vendor_id, l.cost_per_unit, l.case_price,
    l.vendor_id is not distinct from n.new_vendor,
    l.order_code, l.product_page_url
  from unnest(v_new_ids, v_new_catalogs, v_new_vendors)
         as n(new_id, catalog_id, new_vendor)
  join unnest(v_plan_items) p on p.catalog_id = n.catalog_id
  join unnest(v_plan_links) l on l.item_id = p.id;

  get diagnostics v_links_added = row_count;

  select count(*)::int into v_links_skipped
    from unnest(v_foreign_links) as f(item_id)
    join unnest(v_plan_items) p on p.id = f.item_id
   where p.catalog_id = any (v_new_catalogs);

  select count(*)::int into v_no_link
    from unnest(v_new_ids) as n(id)
   where not exists (
     select 1 from public.item_vendors iv where iv.item_id = n.id
   );

  -- ─── D-7. Statement 3: ticked rows still carried by no store in the brand,
  --     any status, evaluated now, after statement 1. R-3 values: all zeros,
  --     null vendor, no links. default_cost is deliberately not used.
  if cardinality(v_ticks) > 0 then
    insert into public.inventory_items (
      store_id, catalog_id,
      par_level, cost_per_unit, case_price, safety_stock, usage_per_portion,
      current_stock, eod_remaining, average_daily_usage
    )
    select
      p_target_store_id, t.catalog_id,
      0, 0, 0, 0, 0,
      0, 0, 0
    from unnest(v_ticks) as t(catalog_id)
    where not exists (
      select 1
        from public.inventory_items ii
        join public.stores s on s.id = ii.store_id
       where ii.catalog_id = t.catalog_id
         and s.brand_id = v_brand
    )
    on conflict (store_id, catalog_id) do nothing;

    get diagnostics v_extras_added = row_count;
    v_extras_skipped := cardinality(v_ticks) - v_extras_added;
  end if;

  -- ─── D-8. One audit row per call that added something, atomic with the writes.
  --     created_at is omitted: the default applies before the spec 170
  --     audit_log_restrict_insert_created_at_now WITH CHECK runs.
  if v_items_copied + v_extras_added > 0 then
    insert into public.audit_log (store_id, user_id, action, item_ref, detail, value)
    values (
      p_target_store_id,
      auth.uid(),
      'Store stocked',
      v_source_name,
      format(
        'Copied %s items and %s vendor links, skipped %s; added %s catalog rows, skipped %s',
        v_items_copied, v_links_added, v_eligible_count - v_items_copied,
        v_extras_added, v_extras_skipped
      ),
      (v_items_copied + v_extras_added)::text
    );
  end if;

  -- ─── D-9. Return.
  select exists (
    select 1 from public.order_schedule o where o.store_id = p_target_store_id
  ) into v_has_schedule;

  select count(*)::int into v_uncarried
    from public.catalog_ingredients c
   where c.brand_id = v_brand
     and not exists (
       select 1
         from public.inventory_items ii
         join public.stores s on s.id = ii.store_id
        where ii.catalog_id = c.id
          and s.brand_id = v_brand
     );

  return jsonb_build_object(
    'items_copied',              v_items_copied,
    'items_skipped',             v_eligible_count - v_items_copied,
    'links_added',               v_links_added,
    'links_skipped_cross_brand', v_links_skipped,
    'extras_added',              v_extras_added,
    'extras_skipped',            v_extras_skipped,
    'items_no_vendor_link',      v_no_link + v_extras_added,
    'target_has_order_schedule', v_has_schedule,
    'uncarried_remaining',       v_uncarried
  );
end;
$$;

comment on function public.stock_store_from_store(uuid, uuid, uuid[]) is
  'Spec 184: atomically copy what the target store lacks from a source store of the same brand (fresh ids, stock reset to 0, same-brand vendor links), plus ticked catalog rows carried by no store in the brand. Never changes an existing row. Writes one audit_log row when it adds something. Does not touch order_schedule. SECURITY INVOKER: gates plus RLS.';

create or replace function public.stock_store_preview(
  p_brand_id        uuid,
  p_target_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_target_brand uuid;
  v_target_count int;
  v_has_schedule boolean;
  v_sources      jsonb;
  v_uncarried    jsonb;
begin
  if not public.auth_is_privileged() then
    raise exception 'stock_store: privileged only' using errcode = '42501';
  end if;

  if p_brand_id is null then
    raise exception 'stock_store: brand is required' using errcode = '22023';
  end if;

  if not public.auth_can_see_brand(p_brand_id) then
    raise exception 'stock_store: brand not accessible' using errcode = '42501';
  end if;

  if p_target_store_id is not null then
    if not public.auth_can_see_store(p_target_store_id) then
      raise exception 'stock_store: target store not accessible'
        using errcode = '42501';
    end if;

    select s.brand_id into v_target_brand
      from public.stores s where s.id = p_target_store_id;

    if v_target_brand is distinct from p_brand_id then
      raise exception 'stock_store: target not in this brand'
        using errcode = '22023';
    end if;

    select count(*)::int into v_target_count
      from public.inventory_items i where i.store_id = p_target_store_id;

    select exists (
      select 1 from public.order_schedule o where o.store_id = p_target_store_id
    ) into v_has_schedule;
  end if;

  -- The eligibility rule is D-3's: a row counts only if its catalog row is in
  -- the brand. With no target, nothing is "already at the target".
  with brand_rows as (
    select i.id as item_id, i.store_id, i.catalog_id
      from public.inventory_items i
      join public.stores s
        on s.id = i.store_id and s.brand_id = p_brand_id
      join public.catalog_ingredients c
        on c.id = i.catalog_id and c.brand_id = p_brand_id
  ), per_source as (
    select
      s.id as store_id, s.name, s.status,
      count(*)::int as item_count,
      count(*) filter (where t.catalog_id is null)::int as items_to_add,
      count(*) filter (where t.catalog_id is not null)::int as items_already_at_target,
      count(*) filter (
        where t.catalog_id is null
          and not exists (
            select 1
              from public.item_vendors iv
              join public.vendors v
                on v.id = iv.vendor_id and v.brand_id = p_brand_id
             where iv.item_id = r.item_id
          )
      )::int as items_no_vendor_link
    from brand_rows r
    join public.stores s on s.id = r.store_id
    left join brand_rows t
      on t.store_id = p_target_store_id and t.catalog_id = r.catalog_id
    where r.store_id is distinct from p_target_store_id
    group by s.id, s.name, s.status
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'store_id',                ps.store_id,
           'name',                    ps.name,
           'status',                  ps.status,
           'item_count',              ps.item_count,
           'items_to_add',            ps.items_to_add,
           'items_already_at_target', ps.items_already_at_target,
           'items_no_vendor_link',    ps.items_no_vendor_link,
           'carried_elsewhere_count', (
             select count(distinct e.catalog_id)
               from brand_rows e
              where not exists (
                      select 1 from brand_rows x
                       where x.store_id = ps.store_id
                         and x.catalog_id = e.catalog_id)
                and not exists (
                      select 1 from brand_rows x
                       where x.store_id = p_target_store_id
                         and x.catalog_id = e.catalog_id)
           )
         ) order by ps.name, ps.store_id), '[]'::jsonb)
    into v_sources
    from per_source ps;

  select coalesce(jsonb_agg(jsonb_build_object(
           'catalog_id', c.id,
           'name',       c.name,
           'unit',       c.unit,
           'category',   c.category,
           'i18n_names', c.i18n_names
         ) order by c.name, c.id), '[]'::jsonb)
    into v_uncarried
    from public.catalog_ingredients c
   where c.brand_id = p_brand_id
     and not exists (
       select 1
         from public.inventory_items ii
         join public.stores s on s.id = ii.store_id
        where ii.catalog_id = c.id
          and s.brand_id = p_brand_id
     );

  return jsonb_build_object(
    'brand_id',                  p_brand_id,
    'target_item_count',         v_target_count,
    'target_has_order_schedule', v_has_schedule,
    'sources',                   v_sources,
    'uncarried',                 v_uncarried
  );
end;
$$;

comment on function public.stock_store_preview(uuid, uuid) is
  'Spec 184: one-snapshot read for the stock dialog. Per source, how many items would be added to the target, how many it already has, how many have no vendor link, and how many rows other stores carry that neither has; plus catalog rows carried by no store in the brand. Same eligibility rules as stock_store_from_store (T-34). SECURITY INVOKER.';

-- REVOKE FROM `public` IS LOAD-BEARING: CREATE FUNCTION grants EXECUTE to
-- PUBLIC (anon inherits it), and spec 097's ALTER DEFAULT PRIVILEGES gives
-- anon an EXPLICIT grant on new public functions — so both must be revoked.
revoke all on function public.stock_store_from_store(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.stock_store_from_store(uuid, uuid, uuid[]) to authenticated;

revoke all on function public.stock_store_preview(uuid, uuid) from public, anon;
grant execute on function public.stock_store_preview(uuid, uuid) to authenticated;

commit;
