-- ============================================================
-- Spec 151 (§1, §2) — public.report_last_order_context(uuid, uuid[], date):
-- the "LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS" annotation read.
--
-- STRICTLY ADDITIVE: one new function + one new index. No new table, no new
-- column, no column type change, no policy created/modified, no destructive
-- DDL. report_reorder_list / report_reorder_for_counted_onhand are NOT touched
-- (AC-18 / AC-REG-1). No publication change — order_approvals stays unpublished
-- per spec 149 R-5 — therefore NO `docker restart supabase_realtime_imr-inventory`
-- step is required by this migration (AC-REG-7).
--
-- DEPENDS ON (all already on main and applied to prod):
--   20260405000759_init_schema.sql          — purchase_orders, po_items,
--                                             eod_submissions, eod_entries
--   20260502071736_remote_schema.sql        — purchase_orders.reference_date
--   20260514120000_eod_submissions_vendor_id.sql
--                                           — eod_submissions.vendor_id + the
--                                             (store_id, date, vendor_id) unique key
--   20260704000000_po_loop.sql              — the draft|sent|partial|received|
--                                             cancelled status vocabulary
--   20260801000100_order_approvals.sql      — public.order_approvals (spec 149)
--
-- AUTHORIZATION (AC-20, design R-B): SECURITY INVOKER with ONE explicit
-- auth_can_see_store(p_store_id) top gate raising 42501 before any read. There
-- is deliberately NO top-level auth_is_privileged() gate: order_approvals'
-- privilege conjunct is a ROW FILTER, not a feature gate, and invoker preserves
-- that distinction for free. A store member who is not privileged therefore
-- reads zero order_approvals rows and resolves an anchor from the PO tiers
-- (1 and 4) or not at all — the shipped spec-149 RLS doing its job (R-5), and
-- exactly what supabase/tests/report_last_order_context.test.sql pins.
--
-- PROD-APPLY (spec 064 gate, project MEMORY project_prod_migration_via_mcp):
-- execute_sql this body via the Supabase MCP against ebwnovzzkwhsdxkpyjka,
-- INSERT the exact version '20260803000000' into
-- supabase_migrations.schema_migrations, then VERIFY the function by
-- NORMALIZED-MD5 of prosrc and the index by presence in pg_indexes.
-- The db-migrations-applied.yml gate is RED between the commit and that apply.
-- That is EXPECTED — flag it, do not "fix" it by deleting the migration.
--
-- ROLLBACK: drop function public.report_last_order_context(uuid, uuid[], date);
-- The FE degrades to AC-17's silent no-context state on its own, so a rollback
-- needs no coordinated FE deploy.
--
-- Design authority: specs/151-last-order-context.md "## Backend design"
-- §0 (R-B / R-C / R-D / R-E), §1, §2, §3.
-- ============================================================

begin;

-- ─── Part 1: the RPC (§2) ─────────────────────────────────────────────────
create or replace function public.report_last_order_context(
  p_store_id   uuid,
  p_vendor_ids uuid[],
  p_as_of_date date default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_raw_n   integer;
  v_ids     uuid[];
  v_as_of   date;
  v_vendors jsonb;
begin
  -- ── (1) TOP GATES — before any read (§2.1) ──────────────────────────────
  if p_store_id is null then
    raise exception 'invalid request: store id is required' using errcode = '22023';
  end if;

  if not public.auth_can_see_store(p_store_id) then
    raise exception 'not authorized for this store' using errcode = '42501';
  end if;

  -- AC-22 input bound. Checked on the RAW input length, BEFORE de-duplication:
  -- a hostile 10 000-element array of one repeated uuid must be REFUSED, not
  -- silently collapsed to one.
  --
  -- cardinality(), NOT array_length(..., 1): array_length reports the FIRST
  -- DIMENSION only, so a caller posting a nested JSON array (PostgREST happily
  -- coerces it to a 2-D uuid[]) sails past a dim-1 bound of 100 while the
  -- unnest() below flattens EVERY element into v_ids. cardinality() counts
  -- elements across all dimensions and is the only form that actually enforces
  -- the bound this comment claims. Pinned by (B5) in
  -- supabase/tests/report_last_order_context.test.sql.
  v_raw_n := coalesce(cardinality(p_vendor_ids), 0);
  if v_raw_n > 100 then
    raise exception 'invalid vendor list: expected 0..100 vendor ids, got %', v_raw_n
      using errcode = '22023';
  end if;

  select array_agg(distinct x) into v_ids
    from unnest(coalesce(p_vendor_ids, '{}'::uuid[])) x
   where x is not null;

  v_as_of := coalesce(p_as_of_date, current_date);

  -- An empty / null vendor list is a NORMAL return, not 22023. An empty reorder
  -- payload is an ordinary state (nothing orders out today) and AC-17 says the
  -- absence of context is never an error.
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'vendors',    '[]'::jsonb
    );
  end if;

  -- ── (2) THE READ ────────────────────────────────────────────────────────
  with
  -- (2a) ANCHOR CANDIDATES, source 1 of 2 — purchase orders (AC-2 tiers 1 + 4).
  --
  -- Notes the reader must NOT "clean up":
  --   • `< v_as_of` is STRICT — today's own PO is not "last time".
  --   • coalesce(reference_date, created_at::date): reference_date is nullable
  --     with no default and legacy prod rows carry NULL
  --     (20260502071736_remote_schema.sql:149). Without the coalesce those rows
  --     would silently never anchor. The cast goes through `at time zone 'utc'`
  --     explicitly so the derived date is deterministic regardless of the
  --     session TimeZone GUC.
  --   • 'cancelled' is EXCLUDED in the WHERE, not filtered later — a CASE that
  --     mapped it to a high tier would let a cancelled order win when it is the
  --     only candidate. A cancelled order is not an order.
  po_candidates as (
    select po.vendor_id,
           case when po.status in ('sent','partial','received') then 1 else 4 end   as tier,
           case when po.status in ('sent','partial','received')
                then 'placed' else 'recorded' end                                   as confidence,
           'purchase_order'::text                                                   as source,
           po.id                                                                    as source_id,
           coalesce(po.reference_date, (po.created_at at time zone 'utc')::date)    as anchor_date,
           po.created_at                                                            as created_at
      from public.purchase_orders po
     where po.store_id  = p_store_id
       and po.vendor_id = any (v_ids)
       and po.status in ('sent','partial','received','draft')   -- 'cancelled' EXCLUDED
       and coalesce(po.reference_date, (po.created_at at time zone 'utc')::date) < v_as_of
  ),
  -- (2b) ANCHOR CANDIDATES, source 2 of 2 — order approvals (AC-2 tiers 2 + 3).
  -- 'pending' is EXCLUDED for the same reason 'cancelled' is: an un-actioned
  -- approval is not an order.
  --
  -- Under SECURITY INVOKER this CTE returns ZERO rows for a caller who is not
  -- auth_is_privileged(), so tiers 2 and 3 are simply invisible to them and no
  -- explicit privilege branch is needed in the SQL. That is R-B working as
  -- designed, and R-5's "two users can honestly see different last orders".
  oa_candidates as (
    select oa.vendor_id,
           case when oa.status = 'ordered' then 2 else 3 end                        as tier,
           case when oa.status = 'ordered' then 'placed' else 'recorded' end        as confidence,
           'order_approval'::text                                                   as source,
           oa.id                                                                    as source_id,
           oa.business_date                                                         as anchor_date,
           oa.created_at                                                            as created_at
      from public.order_approvals oa
     where oa.store_id  = p_store_id
       and oa.vendor_id = any (v_ids)
       and oa.status in ('ordered','approved')                  -- 'pending' EXCLUDED
       and oa.business_date < v_as_of
  ),
  -- (2c) THE PICK (R-C). AC-2's precedence table is literally visible here:
  -- tier ASC dominates, then recency, then created_at. A `sent` PO from six
  -- weeks ago therefore OUTRANKS a `draft` PO from yesterday — that is what
  -- AC-2 specifies and it is pinned by pgTAP (see risk R-2 for the one-line
  -- recency-first alternative the owner may prefer; do not change it here).
  anchors as (
    select distinct on (u.vendor_id) u.*
      from (select * from po_candidates
            union all
            select * from oa_candidates) u
     order by u.vendor_id, u.tier asc, u.anchor_date desc, u.created_at desc
  ),
  -- (2d) THE COUNTED ANCHOR (AC-6 / R-E).
  --   (a) exact provenance — the approval's own source_submission_id;
  --   (b) identity match on the anchor's own business date. (store_id, date,
  --       vendor_id) is eod_submissions' UNIQUE key, so this matches at most one
  --       row: an identity relation, not a heuristic.
  -- Precedence (a) → (b) is R-E: an approval whose source_submission_id is NULL
  -- degrades to the SAME date match the PO path uses rather than losing its
  -- counted figure. Both joins are LEFT, so no match ⇒ AC-7.
  --
  -- FORBIDDEN SUBSTITUTIONS (AC-6 / AC-10): inventory_items.current_stock,
  -- inventory_counts / inventory_count_entries, or anything from the current
  -- reorder payload. None appears in this function; one appearing here is a
  -- Critical.
  counted_sub as (
    select a.vendor_id,
           coalesce(direct.id,   bydate.id)   as submission_id,
           coalesce(direct.date, bydate.date) as counted_date
      from anchors a
      left join public.eod_submissions direct
             on a.source = 'order_approval'
            and direct.id = (select oa.source_submission_id
                               from public.order_approvals oa
                              where oa.id = a.source_id)
            and direct.store_id  = p_store_id     -- defense in depth over RLS
            and direct.vendor_id = a.vendor_id
            and direct.status    = 'submitted'
      left join public.eod_submissions bydate
             on bydate.store_id  = p_store_id
            and bydate.vendor_id = a.vendor_id
            and bydate.date      = a.anchor_date
            and bydate.status    = 'submitted'
  ),
  -- (2e) WHAT WAS ORDERED on the anchor (§2.4). sum() on both branches: a PO or
  -- an approval snapshot may legally carry two lines for the same item, and the
  -- context reports the TOTAL ordered for that item on that order.
  -- Quantities stay in BASE / COUNTED units, UNCONVERTED — no case_qty
  -- arithmetic in SQL (design guidance 4); only the render layer converts.
  ordered_lines as (
      select a.vendor_id                                 as vendor_id,
             pit.item_id                                 as item_id,
             sum(coalesce(pit.ordered_qty, 0))::numeric  as ordered_qty_base
        from anchors a
        join public.po_items pit on pit.po_id = a.source_id
       where a.source = 'purchase_order'
       group by a.vendor_id, pit.item_id
    union all
      -- The approval branch re-reads order_approvals under RLS. Redundant (the
      -- row already passed once in oa_candidates) but harmless, and it keeps the
      -- RLS story uniform — no security-definer shortcut anywhere.
      -- The jsonb_typeof(...) = 'number' guard mirrors create_order_approval's
      -- own validation so a hand-written row cannot crash the cast.
      --
      -- The uuid-SHAPE regex is the other half of that promise and is NOT
      -- optional: non-emptiness alone lets '"item_id": "wings"' through the
      -- WHERE and then raises 22P02 in the cast — and because this RPC returns
      -- ONE envelope for the whole screen, a single malformed lines[] element
      -- would fail the read for every vendor and every caller in that store.
      -- order_approvals has no CHECK on lines[] shape and
      -- privileged_store_insert_order_approvals permits a direct PostgREST
      -- INSERT that bypasses create_order_approval's validation, so this is
      -- reachable. A malformed element is SKIPPED: that item renders no
      -- context, which is AC-9's honest state at row grain. Pinned by
      -- (G1)/(G2).
      select a.vendor_id                        as vendor_id,
             (l->>'item_id')::uuid              as item_id,
             sum((l->>'qty_base')::numeric)     as ordered_qty_base
        from anchors a
        join public.order_approvals oa on oa.id = a.source_id
        cross join lateral jsonb_array_elements(oa.lines) l
       where a.source = 'order_approval'
         and nullif(btrim(coalesce(l->>'item_id', '')), '') is not null
         and l->>'item_id' ~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and jsonb_typeof(l->'qty_base') = 'number'
       group by a.vendor_id, (l->>'item_id')::uuid
  ),
  -- (2f) WHAT WAS COUNTED on the anchoring submission. actual_remaining is the
  -- client-computed total in COUNTED units — staff_submit_eod stores what it
  -- receives and never recomputes it from the _cases / _each splits (R-6). One
  -- basis for counted AND ordered, so both go through the same client-side
  -- conversion path.
  --
  -- DISTINCT ON, and deliberately NOT sum(): eod_entries has no uniqueness on
  -- (submission_id, item_id) and both writers delete-then-insert straight from
  -- a client-supplied array, so one submission CAN legally hold two rows for
  -- the same item. Left un-deduped, the row fans out through the
  -- `left join counted_lines using (vendor_id, item_id)` below and produces a
  -- duplicated items[] element, an inflated total_n (so items_truncated can
  -- read true below 500 DISTINCT items) and a silent last-write-wins pick in
  -- the client mapper. sum() would be worse than the fan-out: adding two counts
  -- for the same item INVENTS a counted total the staff never entered, which
  -- the AC-10 honesty rule forbids. Last-written wins, matching what the EOD
  -- screen itself shows; e.id is a stable final tiebreak so the pick stays
  -- deterministic when two rows share created_at. The unique index on
  -- (submission_id, item_id) — plus the matching hardening of
  -- report_reorder_list, which carries the identical un-deduped shape today —
  -- needs a prod dedupe pass and is a FOLLOW-UP SPEC, not a constraint smuggled
  -- into a display feature. Pinned by (D1)/(D2).
  counted_lines as (
    select distinct on (cs.vendor_id, e.item_id)
           cs.vendor_id                     as vendor_id,
           e.item_id                        as item_id,
           e.actual_remaining::numeric      as counted_qty_base
      from counted_sub cs
      join public.eod_entries e on e.submission_id = cs.submission_id
     where e.actual_remaining is not null
     order by cs.vendor_id, e.item_id, e.created_at desc, e.id desc
  ),
  -- (2g) item_union is the UNION (not a join) of ordered and counted item ids —
  -- that is what makes AC-7 (ordered present, counted NULL) and AC-8 (counted
  -- present, ordered NULL) both expressible in ONE row shape. Do NOT turn it
  -- into an inner join.
  item_union as (
      select vendor_id, item_id from ordered_lines
    union
      select vendor_id, item_id from counted_lines
  ),
  -- (2h) AC-22 output bound. Deterministic order (biggest ordered quantity
  -- first, item_id as the stable tiebreak) so a truncated payload is
  -- reproducible rather than arbitrary. Truncation is NOT an error — the
  -- dropped rows simply render no context, which is AC-9's honest state at row
  -- grain (R-8).
  items_ranked as (
    select iu.vendor_id,
           iu.item_id,
           ol.ordered_qty_base,
           cl.counted_qty_base,
           row_number() over (partition by iu.vendor_id
                              order by ol.ordered_qty_base desc nulls last, iu.item_id) as rn,
           count(*)     over (partition by iu.vendor_id)                                as total_n
      from item_union iu
      left join ordered_lines ol using (vendor_id, item_id)
      left join counted_lines cl using (vendor_id, item_id)
  ),
  vendor_items as (
    select ir.vendor_id,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'item_id',          ir.item_id,
                 'ordered_qty_base', ir.ordered_qty_base,
                 'counted_qty_base', ir.counted_qty_base
               ) order by ir.rn
             ) filter (where ir.rn <= 500),
             '[]'::jsonb
           )                          as items,
           bool_or(ir.total_n > 500)  as items_truncated
      from items_ranked ir
     group by ir.vendor_id
  )
  -- (2i) ENVELOPE (§2.5 / §3.2). A vendor with no anchor never appears in
  -- `anchors`, so it never appears in vendors[] — R-D makes "no anchor"
  -- STRUCTURAL rather than a nullable field a future FE change could misread
  -- into an unanchored "NOT ORDERED" (design guidance 7).
  select jsonb_agg(
           jsonb_build_object(
             'vendor_id',       a.vendor_id,
             'last_order_date', to_char(a.anchor_date, 'YYYY-MM-DD'),
             'confidence',      a.confidence,
             'source',          a.source,
             'source_id',       a.source_id,
             'counted_date',    to_char(cs.counted_date, 'YYYY-MM-DD'),
             'items_truncated', coalesce(vi.items_truncated, false),
             'items',           coalesce(vi.items, '[]'::jsonb)
           ) order by a.vendor_id
         )
    into v_vendors
    from anchors a
    left join counted_sub   cs on cs.vendor_id = a.vendor_id
    left join vendor_items  vi on vi.vendor_id = a.vendor_id;

  return jsonb_build_object(
    'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
    'vendors',    coalesce(v_vendors, '[]'::jsonb)
  );
end $$;

comment on function public.report_last_order_context(uuid, uuid[], date) is
  'spec 151 (§2, AC-18/AC-19/AC-20/AC-22/AC-23): the last-order context read '
  'behind the "LAST {date} · COUNTED {n} · ORDERED {n}" annotation on the '
  'ordering surfaces. SECURITY INVOKER with an explicit '
  'auth_can_see_store(p_store_id) top gate raising 42501 before any read, and '
  'NO top-level auth_is_privileged() gate (R-B): order_approvals'' privilege '
  'conjunct is a row filter, so a non-privileged store member simply resolves '
  'anchors from the purchase_orders tiers instead (R-5). Picks ONE anchor per '
  'vendor by the AC-2 precedence — sent/partial/received PO (1) > ordered '
  'approval (2) > approved approval (3) > draft PO (4), ties by anchor date '
  'then created_at — with ''cancelled'' POs and ''pending'' approvals excluded '
  'from every tier, strictly BEFORE p_as_of_date. Returns quantities in BASE / '
  'COUNTED units, UNCONVERTED (no case_qty arithmetic in SQL); items[] is the '
  'UNION of the anchor order''s lines and the anchoring eod_submissions row''s '
  'entries, so a JSON-null ordered_qty_base means "not on that order" (AC-8) '
  'and a JSON-null counted_qty_base means "no count entry" (AC-7) — neither is '
  'ever coerced to 0. Bounds: > 100 vendor ids raises 22023; per-vendor items '
  'are capped at 500 with items_truncated flagged. A vendor with no anchor is '
  'OMITTED from vendors[] entirely (R-D). Reads only existing tables; creates '
  'no table, no policy and no publication change.';

-- New function ⇒ the grants must be emitted (a create-or-replace of an existing
-- signature would have preserved them). Byte-mirrors create_order_approval's
-- grant block (20260801000100_order_approvals.sql:461-464).
revoke all     on function public.report_last_order_context(uuid, uuid[], date)
  from public, anon;
grant  execute on function public.report_last_order_context(uuid, uuid[], date)
  to authenticated;


-- ─── Part 2: the one new index (§1.2, AC-23) ──────────────────────────────
-- eod_entries has NO index on submission_id today — eod_entries_item_id_idx is
-- on item_id only. This function drives from up to 100 resolved submissions and
-- reads every entry of each; without the index that is a seq scan of the whole
-- entries table per call, and eod_entries is the fastest-growing table in this
-- schema (one row per item per vendor per day, forever). report_reorder_list
-- tolerates the same gap today only because it resolves at most one submission
-- per vendor for a single date.
--
-- Additive and idempotent. Incidentally improves report_reorder_list (4f) and
-- the spec-122 ingredient-changed-badge query.
--
-- PROD-APPLY LOCK NOTE (operational, not a code change): a NON-concurrent
-- `create index` inside this begin;…commit; takes a SHARE lock on
-- public.eod_entries for the duration of the build, which BLOCKS staff EOD
-- writes while it runs — and eod_entries is the fastest-growing table in this
-- schema. Apply OFF-PEAK. If the prod row count is large, check it first and
-- run this one statement as `create index concurrently` OUTSIDE a transaction
-- instead (concurrently cannot run inside begin;…commit;, which is why it is
-- not written that way here — the local/CI path wants the hermetic transaction).
-- Local and CI tables are small enough for the lock to be immaterial.
create index if not exists idx_eod_entries_submission_id
  on public.eod_entries (submission_id);

commit;
