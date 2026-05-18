-- Spec 049: Cross-brand catalog row copy (UI-driven, per-row + bulk).
--
-- Adds the per-row variant of catalog cross-brand copy on top of the
-- existing whole-catalog `copy_brand_catalog` RPC. Super-admin only.
--
-- Three pieces:
--   1. Pre-flight DO block that aborts cleanly if `vendors` has
--      case-variant duplicates per brand, so the new unique-index add
--      cannot fail loudly mid-deploy. Operator dedupes manually before
--      re-applying. Same pattern as the spec-012a pre-flight in
--      20260509000000_multi_brand_schema_rls.sql:256.
--   2. New unique index `vendors_brand_name_lower_unique` on
--      `vendors (brand_id, lower(name))` to support
--      `ON CONFLICT (brand_id, lower(name)) DO NOTHING` for the vendors
--      branch of the new RPC. catalog_ingredients already has the
--      equivalent index from spec P1.
--   3. Composite result type + `public.copy_catalog_rows(uuid, uuid,
--      text, uuid[])` RPC. Mirrors the SECURITY DEFINER + explicit
--      auth_is_super_admin() gate from the existing `copy_brand_catalog`
--      precedent, dispatches on `p_table` ∈ {catalog_ingredients,
--      vendors}, returns a typed (copied int, skipped int,
--      skipped_names text[]) envelope, and writes ONE target-brand
--      audit_log row per successful call. SECURITY DEFINER is the
--      single auth path; RLS policies on writes are bypassed by
--      definer-as-postgres which is the desired posture per spec
--      Backend design §D.
--
-- REALTIME: this migration does NOT touch the supabase_realtime
-- publication. Both target tables (`catalog_ingredients`, `vendors`)
-- are already in the publication per
-- 20260514140000_realtime_publication_tighten.sql; target-brand
-- subscribers on `brand-{target-id}` pick up the inserts via the
-- existing channel. No `docker restart supabase_realtime_imr-inventory`
-- needed.

-- ─── (1) PRE-FLIGHT: vendors (brand_id, lower(name)) collisions ─────
-- Mirrors the spec-012a pre-flight shape (20260509000000:256). If any
-- existing (brand_id, lower(name)) pair has > 1 row, the unique index
-- creation below would fail; surface a clear message and let the
-- operator dedupe manually rather than dying with a generic
-- "could not create unique index" error.
do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes
    from (
      select brand_id, lower(name) as lname, count(*) as n
        from public.vendors
       where brand_id is not null
       group by brand_id, lower(name)
      having count(*) > 1
    ) collisions;

  if v_dupes > 0 then
    raise exception '049: pre-flight failed: % vendor (brand_id, lower(name)) collision group(s) exist; dedupe before applying',
      v_dupes;
  end if;
end $$;

-- ─── (2) UNIQUE INDEX ON vendors (brand_id, lower(name)) ────────────
-- Matches the catalog_ingredients_brand_name_lower_unique shape from
-- spec P1 (20260504060452_brand_catalog_p1_additive.sql:51). The
-- composite key supports `ON CONFLICT (brand_id, lower(name)) DO NOTHING`
-- in the new RPC's vendors branch.
create unique index if not exists vendors_brand_name_lower_unique
  on public.vendors (brand_id, lower(name));

-- ─── (3) COMPOSITE RESULT TYPE ──────────────────────────────────────
-- PostgREST unwraps composite return types into a single typed object
-- (`{copied, skipped, skipped_names}`), preferable to jsonb because the
-- TS wrapper can read fields by name with no JSON parse step. The type
-- is owned by this RPC for now; if a future spec adds another
-- copy/dedupe RPC with the same shape, it can reuse the type.
do $$
begin
  if not exists (
    select 1 from pg_type
     where typname = 'copy_catalog_result'
       and typnamespace = 'public'::regnamespace
  ) then
    create type public.copy_catalog_result as (
      copied        int,
      skipped       int,
      skipped_names text[]
    );
  end if;
end $$;

-- ─── (4) RPC: copy_catalog_rows ─────────────────────────────────────
-- Super-admin-only RPC that copies a caller-selected set of source rows
-- from one brand into another. ON CONFLICT (brand_id, lower(name)) DO
-- NOTHING — skip semantics match the existing whole-catalog
-- `copy_brand_catalog` precedent. One audit_log row per call lands in
-- the target brand (store_id=NULL cross-cutting event); none in source.
--
-- Authorization (single gate; SECURITY DEFINER bypasses RLS policies
-- on the write path so this explicit check is the only path):
--   • auth_is_super_admin() — raises 'super_admin only' (P0001) on
--     miss. Admin AND master are rejected, per spec AC. Match the
--     `copy_brand_catalog` precedent which uses plain `raise exception`
--     mapped to SQLSTATE P0001 — NOT 42501.
--   • auth_can_see_brand(source) — defense in depth.
--   • auth_can_see_brand(target) — defense in depth.
--   • source <> target — same shape as `copy_brand_catalog`.
--   • p_table whitelist — only 'catalog_ingredients' and 'vendors' for
--     v1; recipes / prep_recipes deferred to v2.
--
-- Audit_log row uses the existing column shape (no schema change here):
--   store_id  NULL                                  -- cross-cutting
--   user_id   auth.uid()                            -- actor
--   action    'catalog_copy'                        -- constant
--   item_ref  p_table                               -- which table
--   detail    p_target_brand_id::text               -- cheap join key
--   value     json_build_object(...)::text         -- full payload
create or replace function public.copy_catalog_rows(
  p_source_brand_id uuid,
  p_target_brand_id uuid,
  p_table           text,
  p_source_ids      uuid[]
) returns public.copy_catalog_result
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_copied        int := 0;
  v_skipped       int := 0;
  v_skipped_names text[] := '{}'::text[];
  v_copied_names  text[] := '{}'::text[];
begin
  -- ── (a) Gate set
  if not public.auth_is_super_admin() then
    raise exception 'super_admin only' using errcode = 'P0001';
  end if;
  if not public.auth_can_see_brand(p_source_brand_id) then
    raise exception 'source brand not accessible' using errcode = 'P0001';
  end if;
  if not public.auth_can_see_brand(p_target_brand_id) then
    raise exception 'target brand not accessible' using errcode = 'P0001';
  end if;
  if p_source_brand_id = p_target_brand_id then
    raise exception 'source and target brands must differ' using errcode = 'P0001';
  end if;
  if p_table not in ('catalog_ingredients', 'vendors') then
    raise exception 'invalid table: %', p_table using errcode = 'P0001';
  end if;

  -- ── (b) Empty selection short-circuit. Return (0,0,'{}') with no
  --       audit row; nothing happened, no need to log noise.
  if p_source_ids is null or array_length(p_source_ids, 1) is null then
    return row(0, 0, '{}'::text[])::public.copy_catalog_result;
  end if;

  -- ── (c) Dispatch — INSERT … SELECT … ON CONFLICT DO NOTHING. The
  --       INSERT's RETURNING captures rows that actually landed. The
  --       skip set is the source rows NOT in the inserted set (after
  --       intersecting with names actually present in the source
  --       under p_source_ids).
  if p_table = 'catalog_ingredients' then
    with src as (
      select
        name, unit, category, case_qty, sub_unit_size, sub_unit_unit,
        default_cost, default_case_price, coalesce(i18n_names, '{}'::jsonb) as i18n_names
      from public.catalog_ingredients
       where brand_id = p_source_brand_id
         and id = any(p_source_ids)
    ),
    inserted as (
      insert into public.catalog_ingredients (
        brand_id, name, unit, category, case_qty, sub_unit_size,
        sub_unit_unit, default_cost, default_case_price, i18n_names
      )
      select
        p_target_brand_id, name, unit, category, case_qty, sub_unit_size,
        sub_unit_unit, default_cost, default_case_price, i18n_names
      from src
      on conflict (brand_id, lower(name)) do nothing
      returning name
    )
    select
      array_agg(name order by name)
    into v_copied_names
    from inserted;

    -- skipped = (source names) − (inserted names)
    select
      array_agg(name order by name)
    into v_skipped_names
    from (
      select distinct s.name
        from public.catalog_ingredients s
       where s.brand_id = p_source_brand_id
         and s.id = any(p_source_ids)
         and lower(s.name) not in (
           select lower(name)
             from unnest(coalesce(v_copied_names, '{}'::text[])) as t(name)
         )
       order by 1
       limit 20
    ) skipped_q;

    v_copied  := coalesce(array_length(v_copied_names,  1), 0);
    -- Bounded skipped count is the true unbounded count below; cap
    -- v_skipped_names to 20 (already done by the LIMIT) but report the
    -- full skipped count in v_skipped.
    select coalesce(count(distinct lower(s.name)), 0)::int
      into v_skipped
      from public.catalog_ingredients s
     where s.brand_id = p_source_brand_id
       and s.id = any(p_source_ids)
       and lower(s.name) not in (
         select lower(name)
           from unnest(coalesce(v_copied_names, '{}'::text[])) as t(name)
       );

  elsif p_table = 'vendors' then
    with src as (
      select
        name, contact_name, phone, email, account_number, lead_time_days,
        delivery_days, categories, order_cutoff_time, eod_deadline_time
      from public.vendors
       where brand_id = p_source_brand_id
         and id = any(p_source_ids)
    ),
    inserted as (
      insert into public.vendors (
        brand_id, name, contact_name, phone, email, account_number,
        lead_time_days, delivery_days, categories, order_cutoff_time,
        eod_deadline_time
      )
      select
        p_target_brand_id, name, contact_name, phone, email, account_number,
        lead_time_days, delivery_days, categories, order_cutoff_time,
        eod_deadline_time
      from src
      on conflict (brand_id, lower(name)) do nothing
      returning name
    )
    select
      array_agg(name order by name)
    into v_copied_names
    from inserted;

    select
      array_agg(name order by name)
    into v_skipped_names
    from (
      select distinct s.name
        from public.vendors s
       where s.brand_id = p_source_brand_id
         and s.id = any(p_source_ids)
         and lower(s.name) not in (
           select lower(name)
             from unnest(coalesce(v_copied_names, '{}'::text[])) as t(name)
         )
       order by 1
       limit 20
    ) skipped_q;

    v_copied := coalesce(array_length(v_copied_names, 1), 0);
    select coalesce(count(distinct lower(s.name)), 0)::int
      into v_skipped
      from public.vendors s
     where s.brand_id = p_source_brand_id
       and s.id = any(p_source_ids)
       and lower(s.name) not in (
         select lower(name)
           from unnest(coalesce(v_copied_names, '{}'::text[])) as t(name)
       );
  end if;

  v_copied_names  := coalesce(v_copied_names,  '{}'::text[]);
  v_skipped_names := coalesce(v_skipped_names, '{}'::text[]);

  -- ── (d) Audit: ONE row in target brand per successful call.
  --       Skip if nothing happened (empty selection or every source
  --       id missed the WHERE filter and the insert was a true no-op).
  if v_copied > 0 or v_skipped > 0 then
    insert into public.audit_log (
      store_id, user_id, action, item_ref, detail, value
    ) values (
      null,
      auth.uid(),
      'catalog_copy',
      p_table,
      p_target_brand_id::text,
      json_build_object(
        'source_brand_id', p_source_brand_id,
        'target_brand_id', p_target_brand_id,
        'table',           p_table,
        'names',           v_copied_names,
        'copied_count',    v_copied,
        'skipped_count',   v_skipped
      )::text
    );
  end if;

  return row(v_copied, v_skipped, v_skipped_names)::public.copy_catalog_result;
end
$$;

-- ─── (5) GRANTS / REVOKES ───────────────────────────────────────────
-- Spec 016 / 023 anon-revoke shape: revoke from PUBLIC and anon so the
-- function is invisible at GRANT time before any RLS evaluation, then
-- grant to authenticated. The internal auth_is_super_admin() gate is
-- the second-line defense if the GRANT is ever loosened.
revoke execute on function public.copy_catalog_rows(uuid, uuid, text, uuid[]) from public, anon;
grant  execute on function public.copy_catalog_rows(uuid, uuid, text, uuid[]) to authenticated;
