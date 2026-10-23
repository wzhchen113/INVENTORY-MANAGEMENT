-- ============================================================
-- Spec 172 — EOD "NO NEED" mark (we have more than enough).
--
-- What (design §1, §3.2, §3.3):
--
--   (a) eod_entries.no_need — boolean NOT NULL DEFAULT false. On PG 17 a
--       constant default is metadata-only: no row rewrite, every
--       pre-existing row reads false the moment this commits (AC-1).
--
--   (b) CHECK eod_entries_no_need_no_quantity_check:
--         not no_need or (actual_remaining, actual_remaining_cases,
--                          actual_remaining_each all NULL)
--       A NO NEED row carries no quantity (23514 on violation, AC-2).
--       no_need = false rows are NOT newly constrained — legacy null-total
--       rows stay valid.
--
--   (c) create or replace public.staff_submit_eod(uuid, uuid, date, text,
--       text, jsonb, uuid). Body copied VERBATIM from its latest owner
--       (20260630000200_staff_submit_eod_multi_vendor.sql) with EXACTLY
--       these hunks (each marked `Spec 172 — Hunk Sn` inline):
--         S1  recordset gains `no_need boolean` (absent key → NULL).
--         S2  eod_entries INSERT writes coalesce(v_entry.no_need, false).
--             A NO NEED element carrying a number fails the CHECK (23514)
--             and the whole call rolls back, parent upsert included (AC-5).
--         S3  on-hand UPDATE skips NO NEED entries (current_stock,
--             eod_remaining, updated_at untouched — AC-3 b/c).
--         S4  audit value is the literal 'NO NEED' for those entries
--             (AC-3d); the else-branch is the old expression verbatim.
--         S5  NO NEED entries are not appended to stock_updates (AC-3e).
--
--   (d) CREATE OR REPLACE public.report_reorder_list(uuid, jsonb). Body
--       copied VERBATIM from its latest owner
--       (20260726000000_reorder_drop_inbound_term.sql, spec 138) with
--       EXACTLY these hunks (each marked `SPEC 172 — Hunk Rn` inline):
--         R1  new CTE (4e2) no_need_items — item-wide, cycle-scoped
--             (store, as_of_date, 'submitted') set of NO NEED items.
--         R2  item_on_hand left-joins it: new no_need_for_item column (not
--             case A AND item in set), a middle 'eod' source arm when the
--             row's own vendor submitted (D7), and eod_missing_for_item
--             gains `and nn.item_id is null`. on_hand is UNCHANGED.
--         R3  per_item zeroes par_replacement / usage_forecasted for
--             no_need_for_item rows → suggested_qty 0, needs_order false.
--         R4  per_item_filtered flags gain 'no_need'.
--       Envelope keys are byte-stable; only the flag vocabulary grows.
--       report_reorder_for_counted_onhand (spec 105) is NOT touched.
--
-- RLS: NO policy change. eod_entries stays store-scoped through its parent
-- (store_member_read/insert_eod_entries via auth_can_see_store, plus the
-- eod_entries_check_store BEFORE trigger). permissive_policy_lint is
-- unaffected.
--
-- Grants: the column rides the table-level grants from spec 097
-- (20260618000000_public_grants_explicit.sql); no column-level grant. Both
-- functions keep byte-identical signatures, so `create or replace`
-- preserves their ACLs — grants are deliberately NOT re-emitted (pgTAP
-- eod_no_need.test.sql pins them).
--
-- Realtime: NONE. eod_entries is NOT in supabase_realtime and
-- eod_submissions gains no column, so the
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- Locking: ADD COLUMN takes a brief AccessExclusive lock and the CHECK
-- validation scan holds it until commit. lock_timeout = 5s makes the
-- migration fail fast instead of queueing behind a long reader and
-- stalling staff submits; re-run off-peak if it times out.
--
-- Idempotent for the local + prod (MCP) double-apply: `add column if not
-- exists`, `drop constraint if exists` + `add constraint`, and
-- `create or replace` for both functions.
--
-- Rollback: roll-forward only once NO NEED rows exist. A deliberate DB
-- rollback (after client rollback, queues drained) restores the two prior
-- bodies verbatim from their owners above, then drops the constraint and
-- the column.
-- ============================================================

begin;

set local lock_timeout = '5s';

-- (a) Column ---------------------------------------------------------------
alter table public.eod_entries
  add column if not exists no_need boolean not null default false;

-- (b) CHECK (drop-then-add keeps the definition deterministic on re-run) ----
alter table public.eod_entries
  drop constraint if exists eod_entries_no_need_no_quantity_check;
alter table public.eod_entries
  add constraint eod_entries_no_need_no_quantity_check
  check (not no_need or (actual_remaining is null
                         and actual_remaining_cases is null
                         and actual_remaining_each is null));

comment on column public.eod_entries.no_need is
  'Spec 172: NO NEED mark — "we have more than enough; not counted '
  'numerically". The CHECK eod_entries_no_need_no_quantity_check forces '
  'actual_remaining / actual_remaining_cases / actual_remaining_each to NULL '
  'when true. Numeric readers (variance, COGS, usage, stock series) must treat '
  'the row as ABSENT. report_reorder_list treats it as suggest-0 for its '
  '(store, date) submitted count cycle only — it never carries over.';

-- (c) staff_submit_eod ------------------------------------------------------
create or replace function public.staff_submit_eod(
  p_client_uuid uuid,
  p_store_id uuid,
  p_date date,
  p_submitted_by text,
  p_status text,
  p_entries jsonb,
  p_vendor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id    uuid;
  v_submission_id  uuid;
  v_vendor_name    text;
  v_entry          record;
  v_entry_ids      uuid[] := array[]::uuid[];
  v_stock_updates  jsonb := '[]'::jsonb;
  v_entry_id       uuid;
  v_actor          text;
begin
  -- (1) Vendor presence check. Q1 — strict NOT NULL on the parameter.
  if p_vendor_id is null then
    raise exception
      'staff_submit_eod: vendor_id is required as of spec 020'
      using errcode = '22023';
  end if;

  -- (1.5) Per-spec-061 store-membership gate. The RPC runs security
  -- definer so RLS doesn't auto-enforce on its INSERTs; we explicitly
  -- check the caller has membership for the target store. Same shape
  -- as report_run's caller-can-see-store guard
  -- (20260510120000_report_runs.sql:35).
  --
  -- For service_role callers, auth.uid() is NULL and so is
  -- auth_can_see_store; service_role is REVOKE'd from EXECUTE on this
  -- function in the GRANT block at the bottom anyway, so a service_role
  -- caller cannot get past the GRANT check to reach this line. This
  -- gate fires for authenticated callers only.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'staff_submit_eod: caller cannot see store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) Hydrate the vendor name once for audit-log detail. NULL is
  -- tolerated (audit row falls back to 'unknown' to mirror v1's
  -- 'staff:unknown' fallback shape). vendors is brand-shared and
  -- visible to service_role.
  select v.name into v_vendor_name
    from public.vendors v
   where v.id = p_vendor_id;

  -- (3) Resolve the audit-log actor string. Three-tier fallback per
  -- spec 061 §2: auth.uid() (the per-user JWT path) wins when present
  -- so the staff caller cannot spoof; p_submitted_by is the legacy
  -- compat path for non-JWT callers (now removed via the edge-function
  -- deprecation, but the fallback stays for defense in depth); the
  -- 'staff:unknown' literal is the v1 fallback shape.
  v_actor := coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown');

  -- (4) Idempotency check on p_client_uuid (per-attempt). If a row
  -- with this client_uuid already exists — even under a different
  -- (store_id, date, vendor_id) triple — return its id with
  -- conflict=true. Same behavior as v1.
  if p_client_uuid is not null then
    select id into v_existing_id
      from public.eod_submissions
      where client_uuid = p_client_uuid;
    if v_existing_id is not null then
      return jsonb_build_object(
        'submission_id', v_existing_id,
        'conflict', true,
        'reason', 'client_uuid already processed'
      );
    end if;
  end if;

  -- (5) Upsert parent submission on (store_id, date, vendor_id). The
  -- EDIT path (same triple, new client_uuid) hits DO UPDATE which
  -- preserves the row id; eod_entries.submission_id FKs stay valid.
  --
  -- submitted_by stays NULL on the explicit write; the BEFORE INSERT
  -- trigger eod_submissions_set_submitted_by_trg overrides it to
  -- auth.uid() (spec 020 round-2,
  -- 20260514120030_eod_submissions_consistency.sql:78-94). Under the
  -- new per-user JWT path auth.uid() is the staff user's id; under
  -- the legacy service-role path it's NULL. Same posture either way.
  insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at, client_uuid)
  values (p_store_id, p_date, p_vendor_id, null, p_status, now(), p_client_uuid)
  on conflict (store_id, date, vendor_id) do update
    set status = excluded.status,
        submitted_at = excluded.submitted_at,
        client_uuid = coalesce(public.eod_submissions.client_uuid, excluded.client_uuid)
  returning id into v_submission_id;

  -- (6) Replace entries: drop old set, insert new. Avoids diff logic.
  delete from public.eod_entries where submission_id = v_submission_id;

  -- (7) Insert new entries + capture ids + bump inventory (junction-
  -- membership per spec 102) + audit per row.
  --
  -- Spec 086 — Hunk A: the recordset destructure gains
  -- actual_remaining_cases / actual_remaining_each so the staff screen's
  -- two split inputs ride inside the same p_entries jsonb. Elements
  -- WITHOUT these keys read as NULL (backward-compatible — the admin
  -- direct-PostgREST path and any older staff client still parse).
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      ingredient_id uuid,
      actual_remaining numeric,
      actual_remaining_cases numeric,
      actual_remaining_each numeric,
      unit text,
      notes text,
      -- Spec 172 — Hunk S1: optional NO NEED flag. Absent key → NULL,
      -- coalesced to false at every use below (AC-4 byte-identical).
      no_need boolean
    )
  loop
    -- Spec 086 — Hunk B: write the two split columns alongside the
    -- existing actual_remaining (the client-computed total). The RPC
    -- stores what it receives; it does NOT recompute the total, and
    -- caseQty is never sent to or known by the RPC. Legacy callers
    -- omit the split keys → both columns insert as NULL.
    --
    -- Spec 172 — Hunk S2: persist the NO NEED flag. A NO NEED element
    -- that also carries any quantity fails
    -- eod_entries_no_need_no_quantity_check (23514) and the whole call
    -- rolls back, parent upsert included (AC-5).
    insert into public.eod_entries
      (submission_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, no_need)
    values
      (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       coalesce(v_entry.notes, ''), coalesce(v_entry.no_need, false))
    returning id into v_entry_id;
    v_entry_ids := array_append(v_entry_ids, v_entry_id);

    -- Spec 102 — JUNCTION-MEMBERSHIP on-hand write (was: vendor-scoped
    -- `and ii.vendor_id = p_vendor_id`). The on-hand is keyed by ITEM,
    -- not (item, vendor): write current_stock/eod_remaining for the item
    -- itself whenever it has an item_vendors link for the submitting
    -- vendor — so a SHARED item counted under ANY of its vendors updates
    -- the single shared on-hand (AC-E / AC-F), regardless of which link
    -- is "primary". Items with NO link to p_vendor_id (the
    -- unscheduled-item escape hatch / a truly off-vendor entry) have the
    -- EXISTS yield false → no row matches → the on-hand mutation is
    -- skipped, exactly as the vendor-equality predicate skipped it before.
    -- The audit_log row below STILL emits for that off-vendor entry so
    -- the count remains traceable (escape-hatch invariant preserved).
    --
    -- Unchanged for spec 086: this continues to use the total
    -- (v_entry.actual_remaining), NOT the raw splits.
    --
    -- Spec 172 — Hunk S3: a NO NEED entry carries no quantity, so it
    -- never writes the on-hand (current_stock / eod_remaining /
    -- updated_at untouched — AC-3 b/c).
    update public.inventory_items ii
      set current_stock = v_entry.actual_remaining,
          eod_remaining = v_entry.actual_remaining,
          updated_at = now()
      where ii.id = v_entry.ingredient_id
        and exists (select 1 from public.item_vendors iv
                     where iv.item_id = ii.id
                       and iv.vendor_id = p_vendor_id)
        and not coalesce(v_entry.no_need, false);

    -- Audit row — append ` · vendor: <vendor_name>` to detail so the
    -- audit log surfaces vendor identification per spec 020 AC.
    -- Spec 061: the actor prefix is auth.uid()::text when present so
    -- the audit trail is spoof-proof under the per-user JWT path.
    -- The v1 'staff:unknown' fallback shape is preserved when
    -- auth.uid() and p_submitted_by are both NULL.
    --
    -- Unchanged for spec 086: the value string renders the total +
    -- unit. The human-readable cases+units breakdown is explicitly out
    -- of v1 (spec 086 OQ-3).
    --
    -- Spec 172 — Hunk S4: a NO NEED entry audits the stored English
    -- literal 'NO NEED' (N6) instead of a NULL value; the else-branch is
    -- the pre-172 expression verbatim (AC-4).
    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    select
      p_store_id,
      null,
      'EOD entry',
      v_actor || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
      ci.name,
      case when coalesce(v_entry.no_need, false) then 'NO NEED'
           else v_entry.actual_remaining::text || ' ' || coalesce(v_entry.unit, ci.unit, '') end
    from public.inventory_items ii
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where ii.id = v_entry.ingredient_id;

    -- Spec 172 — Hunk S5: NO NEED entries wrote no on-hand, so they are
    -- omitted from stock_updates (AC-3e).
    if not coalesce(v_entry.no_need, false) then
      v_stock_updates := v_stock_updates || jsonb_build_object(
        'ingredient_id', v_entry.ingredient_id,
        'new_stock', v_entry.actual_remaining
      );
    end if;
  end loop;

  return jsonb_build_object(
    'submission_id', v_submission_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids),
    'stock_updates', v_stock_updates
  );
end;
$$;

-- (d) report_reorder_list ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_reorder_list(p_store_id uuid, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_as_of_date              date;
  v_today_dow_num           int;
  v_today_time              time;
  v_vendors                 jsonb;
  v_kpis                    jsonb;
  v_warnings                jsonb;
  v_truncated_recipe_count  bigint;
begin
  -- (1) AUTH GATE — first statement. Mirrors variance / cogs lines.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) AS-OF DATE RESOLUTION. Frontend passes the store-local "today"
  -- as YYYY-MM-DD via p_params. When omitted, fall back to the server's
  -- current_date (UTC). Same caveat as variance / cogs runners — caller
  -- supplies for correctness across time zones.
  v_as_of_date := coalesce(
    nullif(p_params->>'as_of_date', '')::date,
    current_date
  );
  v_today_dow_num := extract(dow from v_as_of_date)::int; -- 0=Sun..6=Sat
  v_today_time    := (now() at time zone 'utc')::time;

  -- (3) DEPTH-CAP PRE-WALK — recipe-graph depth cap is 5, same as
  -- variance / cogs. The 'truncated' flag propagates to per-item rows.
  -- Independent of the main aggregation so the count is computed once.
  with recursive _walk as (
    select rpi.recipe_id, rpi.prep_recipe_id, pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited, 1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select w.recipe_id, w.prep_recipe_id, pri.sub_recipe_id,
           w.visited || w.sub_recipe_id, w.depth + 1
      from _walk w
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = w.sub_recipe_id
     where w.sub_recipe_id is not null
       and not (w.sub_recipe_id = any (w.visited))
       and w.depth < 5
  )
  select count(distinct recipe_id) into v_truncated_recipe_count
    from _walk
   where depth = 5
     and sub_recipe_id is not null
     and not (sub_recipe_id = any (visited));

  if v_truncated_recipe_count > 0 then
    raise notice 'Reorder report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (4) MAIN AGGREGATION. One CTE chain emits the per-vendor payload
  -- and the warnings array. Structure mirrors the variance runner.
  with recursive
  -- (4a) Direct (non-prep) ingredients per recipe, reduced to
  -- (recipe, catalog, qty). Same shape as variance lines 321-325.
  direct_ri as (
    select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
     where ri.catalog_id is not null
  ),
  -- (4b) Recursive flatten with depth cap + cycle detection.
  recursive_prep as (
    select
      rpi.recipe_id, pri.catalog_id, pri.sub_recipe_id,
      (rpi.quantity * pri.quantity)::numeric as qty,
      array[rpi.prep_recipe_id]              as visited,
      1                                       as depth
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id
    union all
    select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
           (rp.qty * pri.quantity)::numeric,
           rp.visited || rp.sub_recipe_id, rp.depth + 1
      from recursive_prep rp
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = rp.sub_recipe_id
     where rp.sub_recipe_id is not null
       and not (rp.sub_recipe_id = any (rp.visited))
       and rp.depth < 5
  ),
  truncated_recipes as (
    select distinct recipe_id
      from recursive_prep
     where depth = 5
       and sub_recipe_id is not null
       and not (sub_recipe_id = any (visited))
  ),
  prep_leaves as (
    select recipe_id, catalog_id, qty
      from recursive_prep
     where catalog_id is not null
  ),
  -- (4c) Combined per-recipe ingredient quantities (direct + prep
  -- flattened). Joined to inventory_items via catalog_id below.
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (
        select * from direct_ri
        union all
        select recipe_id, catalog_id, qty from prep_leaves
      ) u
     group by recipe_id, catalog_id
  ),
  -- (4d) Per-recipe truncation flag (rolls up to sales_depletion).
  recipe_meta as (
    select ari.recipe_id,
           bool_or(tr.recipe_id is not null) as truncated
      from all_ri ari
      left join truncated_recipes tr on tr.recipe_id = ari.recipe_id
     group by ari.recipe_id
  ),
  -- (4e) PER-VENDOR EOD LOOKUP. Post-spec-020, (store, date, vendor)
  -- is unique with at most one row. Filter 'submitted' status only.
  -- A vendor with a submission today is 'eod'-sourced; otherwise
  -- 'stock' fallback. eod_submitted_at is surfaced for the UI badge.
  latest_eod_per_vendor as (
    select s.vendor_id,
           s.id          as submission_id,
           s.submitted_at
      from public.eod_submissions s
     where s.store_id = p_store_id
       and s.date = v_as_of_date
       and s.status = 'submitted'
  ),
  -- (4e2) SPEC 172 — Hunk R1: item-wide NO NEED set for THIS count cycle.
  -- Reuses (4e)'s (store, as_of_date, 'submitted') filter, so it is
  -- cycle-scoped (never carries over — AC-11) and ignores drafts (AC-13).
  -- Item-wide: a NO NEED mark under ANY vendor's submission covers every
  -- linked-vendor row of that item (AC-12). distinct → no fan-out below.
  no_need_items as (
    select distinct e.item_id
      from latest_eod_per_vendor lev
      join public.eod_entries e
        on e.submission_id = lev.submission_id
     where e.no_need
  ),
  -- (4f) Per-item on_hand — SPEC 102: now item × LINKED-VENDOR (was item
  -- 1:1 inventory_items.vendor_id). The item→vendor source is a JOIN on
  -- public.item_vendors, so a shared item produces ONE ROW PER LINKED
  -- vendor. The three on_hand cases are unchanged:
  --   case A: vendor has EOD today AND this item has a non-null
  --           actual_remaining → on_hand = actual_remaining, source=eod.
  --   case B: vendor has EOD today but THIS item's entry is missing/null
  --           → on_hand = inventory_items.current_stock, source=eod
  --           (vendor-level), 'eod_missing_for_item' flag attached.
  --   case C: vendor has no EOD today → on_hand = current_stock,
  --           source=stock.
  --
  -- SPEC 102 changes (and ONLY these):
  --   • vendor_id is iv.vendor_id (from the junction), not ii.vendor_id.
  --   • cost_per_unit is the PER-VENDOR cost from the junction, FALLING
  --     BACK to the item cost when null/0 (OQ-5):
  --       coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0).
  --   • the source table gains `join public.item_vendors iv on
  --     iv.item_id = ii.id`, and latest_eod_per_vendor / eod_entries join
  --     on iv.vendor_id.
  --   • the `ii.vendor_id IS NOT NULL` filter is DROPPED — membership is
  --     now expressed by the inner JOIN to item_vendors (an item with no
  --     link produces no row, exactly as a null vendor_id did before).
  -- par_level / usage_per_portion / current_stock stay PER-ITEM (OQ-3).
  item_on_hand as (
    select
      ii.id                                              as item_id,
      ii.store_id,
      iv.vendor_id,                                      -- from junction, not ii.vendor_id
      ii.catalog_id,
      ii.par_level::numeric                              as par_level,       -- OQ-3: per-item, shared
      coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
      -- OQ-5: per-vendor cost from the junction, fallback to item cost.
      coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)::numeric as cost_per_unit,
      coalesce(ii.current_stock, 0)::numeric             as current_stock,
      lev.submission_id,
      lev.submitted_at,
      e.actual_remaining,
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then e.actual_remaining::numeric
        else coalesce(ii.current_stock, 0)::numeric
      end                                                as on_hand,
      -- SPEC 172 — Hunk R2(b): middle arm — a NO NEED override row whose OWN
      -- vendor submitted this cycle is EOD-sourced (AC-10). A cross-vendor
      -- override on a vendor that has NOT submitted keeps 'stock' (D7).
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then 'eod'::text
        when lev.submission_id is not null
         and nn.item_id is not null
        then 'eod'::text
        else 'stock'::text
      end                                                as item_on_hand_source,
      -- SPEC 172 — Hunk R2(d): a NO NEED override row is not "EOD missing".
      (lev.submission_id is not null
        and (e.id is null or e.actual_remaining is null)
        and nn.item_id is null)
                                                         as eod_missing_for_item,
      -- SPEC 172 — Hunk R2(c): the override applies to every row that is NOT
      -- case A. A vendor row with its own numeric entry keeps it (OQ-2).
      -- on_hand above is unchanged: a non-case-A row already resolves to
      -- current_stock (AC-8 — never fabricated as 0).
      (nn.item_id is not null
        and not (lev.submission_id is not null and e.actual_remaining is not null))
                                                         as no_need_for_item
      from public.inventory_items ii
      join public.item_vendors iv
        on iv.item_id = ii.id                            -- explode by link
      left join latest_eod_per_vendor lev
        on lev.vendor_id = iv.vendor_id
      left join public.eod_entries e
        on e.submission_id = lev.submission_id
       and e.item_id = ii.id
      -- SPEC 172 — Hunk R2(a): item-wide NO NEED set (distinct, no fan-out).
      left join no_need_items nn
        on nn.item_id = ii.id
     where ii.store_id = p_store_id
  ),
  -- (4f2) SPEC 102: per item, the full set of linked vendors (id + name)
  -- + the count. Feeds the OQ-1 coincident-schedule "also from N" hint
  -- (Hunk 3). Keyed by item; store-scoped via the inventory_items join.
  item_vendor_set as (
    select iv.item_id,
           jsonb_agg(jsonb_build_object('vendor_id', iv.vendor_id,
                                        'vendor_name', v.name)
                     order by v.name) as vendor_links,
           count(*)                   as vendor_link_count
      from public.item_vendors iv
      join public.vendors v          on v.id = iv.vendor_id
      join public.inventory_items ii on ii.id = iv.item_id
     where ii.store_id = p_store_id
     group by iv.item_id
  ),
  -- (4g) Pending PO quantity. SPEC 138: the inbound-netting term is RETIRED
  -- with receiving. This CTE now returns ZERO ROWS (`where false`), so the
  -- `left join pending_po_qty ppq` below always misses and every
  -- `coalesce(ppq.pending_po_qty, 0)` reads 0 — the emitted per-item
  -- `pending_po_qty` is always 0 and par_replacement / usage_forecasted no
  -- longer subtract inbound. Rationale (Design §1/§2): with no receive path,
  -- a cart-filled order that goes draft→'sent' would enter pending forever and
  -- suppress that item's reorder permanently. Reorder now plans purely off
  -- counted on-hand vs par (+ usage forecast). The `group by pit.item_id` +
  -- ::numeric shape is preserved verbatim so the join column types are
  -- unchanged; only the predicate flips to `where false`. Envelope key stays
  -- present (value 0) — byte-stable for every consumer.
  pending_po_qty as (
    select pit.item_id,
           sum(0)::numeric as pending_po_qty
      from public.po_items pit
     where false            -- spec 138: inbound netting retired with receiving
     group by pit.item_id
  ),
  -- (4h) Sales depletion average (per-day). For each item, flatten
  -- recipes-touching-this-item × qty_sold in the trailing 7d window
  -- and divide by 7 to get the per-day rate. Structurally identical
  -- to variance's sales_depletion CTE but with a different window
  -- and divided to per-day. Items not in any recipe yield no row.
  pos_daily_per_item as (
    select
      ii.id                                                  as item_id,
      sum(pii.qty_sold::numeric * ari.qty)::numeric / 7.0    as qty_per_day,
      bool_or(coalesce(rm.truncated, false))                 as truncated
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join all_ri ari                  on ari.recipe_id = pii.recipe_id
      join public.inventory_items ii   on ii.catalog_id = ari.catalog_id
                                      and ii.store_id   = p_store_id
      left join recipe_meta rm         on rm.recipe_id   = pii.recipe_id
     where pi.store_id    = p_store_id
       and pi.import_date >  (v_as_of_date - 7)
       and pi.import_date <= v_as_of_date
       and pii.recipe_id is not null
       and pii.recipe_mapped = true
     group by ii.id
  ),
  -- (4i) NEXT-DELIVERY computation. For each vendor in this store
  -- with inventory items, compute days_offset to the next delivery_day.
  --
  -- CORRECTNESS NOTE: MIN must operate on the OFFSET DISTANCE
  -- ((dow - today_dow + 7) % 7), NOT on the raw DOW number. The
  -- previous shape ran MIN over the raw DOW which picked the
  -- numerically-smallest day-of-week — wrong for multi-delivery-day
  -- vendors. Example bug: a vendor delivering Wednesday (DOW=3) and
  -- Friday (DOW=5), called on Thursday (DOW=4): MIN(3,5)=3 →
  -- offset = (3-4+7)%7 = 6 days. Correct: per-day offsets are
  -- Wed=(3-4+7)%7=6 and Fri=(5-4+7)%7=1, MIN(6,1)=1. We compute the
  -- per-row distance first inside the lateral, push to next-week
  -- (+7) on the same row when today-is-delivery-and-cutoff-passed,
  -- then MIN over those distances.
  --
  -- Edge cases handled inline:
  --   • No order_schedule rows for vendor → COALESCE to 7 (A5 default).
  --   • Multiple delivery_days → MIN of per-day distances.
  --   • Today is a delivery day AND vendor's order_cutoff_time has
  --     already passed → force that day's offset to 7 (next cycle).
  --   • order_cutoff_time IS NULL → treat as "no cutoff", today's
  --     delivery counts (offset = 0).
  vendor_delivery_offsets as (
    select
      v.id            as vendor_id,
      v.name          as vendor_name,
      v.order_cutoff_time,
      os.days_offset  as days_offset
      from public.vendors v
      cross join lateral (
        -- Per delivery-day row: compute the naive distance from today,
        -- then push to +7 when this row is today-the-delivery-day AND
        -- the cutoff has already passed. Finally MIN over the
        -- resulting per-row distances.
        select min(per_day.distance) as days_offset
          from (
            select
              case
                when per_dow.dow is null then null
                when per_dow.dow = v_today_dow_num then
                  case
                    when v.order_cutoff_time is not null
                     and v_today_time > v.order_cutoff_time::time
                    then 7
                    else 0
                  end
                else
                  ((per_dow.dow - v_today_dow_num + 7) % 7)
              end as distance
              from (
                select distinct
                  case lower(os2.delivery_day)
                    when 'sunday'    then 0
                    when 'monday'    then 1
                    when 'tuesday'   then 2
                    when 'wednesday' then 3
                    when 'thursday'  then 4
                    when 'friday'    then 5
                    when 'saturday'  then 6
                    else null
                  end as dow
                  from public.order_schedule os2
                 where os2.store_id  = p_store_id
                   and os2.vendor_id = v.id
                   and os2.delivery_day is not null
              ) per_dow
             where per_dow.dow is not null
          ) per_day
      ) os
     where exists (
       select 1
         from public.inventory_items ii
         join public.item_vendors iv on iv.item_id = ii.id
        where ii.store_id  = p_store_id
          and iv.vendor_id = v.id
     )
  ),
  -- (4j) Resolve next-delivery metadata per vendor (handle the
  -- A5 fallback explicitly). Always pick a numeric days_offset so
  -- the downstream forecast multiplication is total.
  vendor_delivery as (
    select
      vdo.vendor_id,
      vdo.vendor_name,
      coalesce(vdo.days_offset, 7)                       as days_until,
      (vdo.days_offset is not null)                       as schedule_known,
      v_as_of_date + coalesce(vdo.days_offset, 7)         as next_delivery_date
      from vendor_delivery_offsets vdo
  ),
  -- (4k) PER-ITEM MATH. Compute par_replacement / usage_forecasted /
  -- suggested_qty per the hybrid formula. Join through
  -- catalog_ingredients for the item name (since inventory_items.name
  -- was dropped in P3). Filter rows with suggested_qty < 0.001 — the
  -- "nothing to order" case at the item grain.
  --
  -- Spec 088 hunk (1): surface the catalog's units-per-case from the
  -- EXISTING `ci` join. coalesce(…, 1) so a NULL case_qty reads as 1
  -- (= "no case size") downstream; the `> 1` predicate then treats it
  -- as base-unit. No ::int cast — keep `numeric` so a fractional
  -- case_qty isn't silently truncated.
  --
  -- Spec 100 hunk (1): surface ci.i18n_names from the SAME `ci` join so
  -- the staff reorder screen can render localized item names via
  -- getLocalizedName the way EOD/Weekly already do. JSONB; NULL → JSON
  -- null → mapper coalesces to {} → silent English fallback. No new
  -- join, no new scan.
  --
  -- Spec 104 hunk (1): surface the catalog's sub_unit_size from the SAME
  -- `ci` join (no new join, no new scan). coalesce(…, 1) so a NULL reads
  -- as 1 (= "tracking unit IS the smallest unit") downstream. It threads
  -- through per_item_suggested (pi.*) and per_item_filtered (pis.*) with
  -- no further edit, and feeds the estimated_cost × sub_unit_size bridge
  -- in per_item_filtered (OQ-1: keeps reorder totals numerically identical
  -- now that cost_per_unit is per-each).
  per_item as (
    select
      ioh.vendor_id,
      ioh.item_id,
      ci.name                                                       as item_name,
      ci.i18n_names                                                 as i18n_names,
      coalesce(ci.unit, '')                                         as unit,
      coalesce(ci.case_qty, 1)::numeric                             as case_qty,
      coalesce(ci.sub_unit_size, 1)::numeric                        as sub_unit_size,
      ioh.on_hand,
      ioh.item_on_hand_source,
      ioh.eod_missing_for_item,
      ioh.no_need_for_item,                                          -- SPEC 172 — Hunk R3(a)
      coalesce(ppq.pending_po_qty, 0)                                as pending_po_qty,
      ioh.par_level,
      case when ioh.usage_per_portion > 0 then ioh.usage_per_portion else null end
                                                                     as usage_per_portion,
      coalesce(pos.qty_per_day, 0)::numeric                          as qty_per_day,
      coalesce(pos.truncated, false)                                 as truncated,
      vd.days_until,
      ioh.cost_per_unit,
      -- SPEC 172 — Hunk R3(b): a NO NEED row suggests 0 — both terms zero,
      -- so suggested_qty / suggested_cases / estimated_cost / suggested_units
      -- are 0 and needs_order is false downstream with no further edit. The
      -- else-branches are the pre-172 expressions verbatim.
      case when ioh.no_need_for_item then 0::numeric else
      greatest(0,
        coalesce(ioh.par_level, 0) - ioh.on_hand - coalesce(ppq.pending_po_qty, 0)
      )::numeric end                                                 as par_replacement,
      case when ioh.no_need_for_item then 0::numeric else
      greatest(0,
        coalesce(ioh.usage_per_portion, 0)
        * coalesce(pos.qty_per_day, 0)
        * vd.days_until
        - ioh.on_hand
        - coalesce(ppq.pending_po_qty, 0)
      )::numeric end                                                 as usage_forecasted
      from item_on_hand ioh
      join public.catalog_ingredients ci on ci.id = ioh.catalog_id
      join vendor_delivery vd            on vd.vendor_id = ioh.vendor_id
      left join pending_po_qty ppq       on ppq.item_id = ioh.item_id
      left join pos_daily_per_item pos   on pos.item_id = ioh.item_id
  ),
  per_item_suggested as (
    select
      pi.*,
      greatest(pi.par_replacement, pi.usage_forecasted)              as suggested_qty
      from per_item pi
  ),
  -- Spec 088 hunk (2): derive the case-aware values. "Has a case size"
  -- ⇔ case_qty > 1 (null/0/1 are normalized to 1 above, so the strict
  -- `> 1` test correctly excludes them).
  --   • suggested_cases = ceil(suggested_qty / case_qty) when case-size,
  --     else NULL.
  --   • estimated_cost is case-rounded: whole-case cost for case-size
  --     items, unchanged (suggested_qty * cost_per_unit) otherwise.
  -- This is the SINGLE cost source — vendor_total_cost (sum below) and
  -- kpis.total_estimated_cost inherit the rounding with no other edit.
  --
  -- Spec 104 hunk (2): cost_per_unit is now per-EACH (smallest unit), but
  -- suggested_qty / suggested_cases are in COUNTED units. Multiply BOTH
  -- branches by pis.sub_unit_size UNCONDITIONALLY so the dollar total stays
  -- numerically IDENTICAL to the pre-spec figure (per ★: cost_old =
  -- cost_per_unit × sub_unit_size). Under option (b) cost_per_unit is uniformly
  -- per-each on every row, so the bridge needs no discriminator: a sub_unit_size
  -- = 1 row had its flip be a no-op (× 1), and a cost_old = 0 row is 0 on both
  -- bases. Reorder remains case-accurate (OQ-1) — the cases/units display below
  -- is unchanged; only the cost derivation adapts to the new basis.
  per_item_filtered as (
    select
      pis.*,
      case when pis.case_qty > 1
           then ceil(pis.suggested_qty / pis.case_qty)
           else null end                                            as suggested_cases,
      case when pis.case_qty > 1
           then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty * pis.cost_per_unit * pis.sub_unit_size)
           else (pis.suggested_qty * pis.cost_per_unit * pis.sub_unit_size) end
                                                                     as estimated_cost,
      -- Per-item flag list (jsonb array of lowercase tokens).
      (
        case when coalesce(pis.par_level, 0) <= 0 then jsonb_build_array('no_par')
             else '[]'::jsonb end
        ||
        case when pis.usage_per_portion is null or coalesce(pis.qty_per_day, 0) = 0
                  then jsonb_build_array('no_usage_rate')
             else '[]'::jsonb end
        ||
        case when pis.eod_missing_for_item then jsonb_build_array('eod_missing_for_item')
             else '[]'::jsonb end
        ||
        -- SPEC 172 — Hunk R4: NO NEED flag token.
        case when pis.no_need_for_item then jsonb_build_array('no_need')
             else '[]'::jsonb end
        ||
        case when pis.truncated then jsonb_build_array('truncated')
             else '[]'::jsonb end
      )                                                              as flags
      from per_item_suggested pis
     -- Spec (2026-07): when p_params.include_stocked is true, keep EVERY item
     -- (including at/above par) so the staff Reorder screen can show a
     -- "Have enough stock" section. Absent/false (the admin default) → the
     -- original below-par-only filter, byte-for-byte unchanged.
     where (coalesce((p_params->>'include_stocked')::boolean, false)
            or pis.suggested_qty >= 0.001)
  ),
  -- (4l) VENDOR ROLLUP. Vendors with zero rows are filtered OUT here
  -- (matches AC line 62 — "If a vendor has zero suggested items, the
  -- card is hidden"). on_hand_source rolls up to 'eod' iff any item
  -- under the vendor came from EOD; else 'stock'.
  vendors_with_items as (
    select
      vd.vendor_id,
      vd.vendor_name,
      vd.schedule_known,
      vd.next_delivery_date,
      vd.days_until,
      -- vendor-level source: 'eod' if any item drew from EOD.
      case when bool_or(pif.item_on_hand_source = 'eod') then 'eod'
           else 'stock' end                                          as on_hand_source,
      -- earliest submitted_at across this vendor's items (one
      -- submission per vendor per day post-spec-020, so this collapses).
      max(ioh_lev.submitted_at)                                      as eod_submitted_at,
      sum(pif.estimated_cost)::numeric                               as vendor_total_cost,
      jsonb_agg(
        jsonb_build_object(
          'item_id',          pif.item_id,
          'item_name',        pif.item_name,
          -- Spec 100 hunk (2): additive per-item localized-name key.
          -- JSONB object (e.g. {"zh-CN":"虾仁去头"}) or JSON null when the
          -- catalog row has no overrides; the staff mapper coalesces
          -- null/absent to {} so getLocalizedName falls through to the
          -- English item_name. The admin mapper ignores this key.
          'i18n_names',       pif.i18n_names,
          'unit',             pif.unit,
          'on_hand',          pif.on_hand,
          'pending_po_qty',   pif.pending_po_qty,
          'par_level',        pif.par_level,
          'usage_forecasted', pif.usage_forecasted,
          'par_replacement',  pif.par_replacement,
          'suggested_qty',    pif.suggested_qty,
          -- Spec (2026-07): true when the item is below par and should be
          -- ordered; false for at/above-par items surfaced by include_stocked.
          -- Always present (admin items are all true, so admin is unaffected).
          'needs_order',      (pif.suggested_qty >= 0.001),
          -- Spec 088 hunk (3): three additive case keys. case_qty is
          -- always present (1 when no case size); suggested_cases is the
          -- ceil (JSON null when case_qty ≤ 1); suggested_units is the
          -- ordered base-unit total M (= cases * case_qty for case
          -- items, else the raw suggested_qty). One server-authoritative
          -- M so the FE display / CSV / PDF never re-derive cases×qty.
          'case_qty',         pif.case_qty,
          'suggested_cases',  pif.suggested_cases,
          'suggested_units',  case when pif.suggested_cases is not null
                                   then pif.suggested_cases * pif.case_qty
                                   else pif.suggested_qty end,
          'cost_per_unit',    pif.cost_per_unit,
          'estimated_cost',   pif.estimated_cost,
          'flags',            pif.flags,
          -- Spec 102 hunk (3): OQ-1 coincident-schedule "also from N"
          -- hint. ADVISORY ONLY — does not change which card the item
          -- appears on. other_vendor_count is 0 for a single-vendor item
          -- (existing rendering unaffected). also_from_vendors is the set
          -- of the item's OTHER linked vendors (excluding THIS card's
          -- vendor) for the UI to name. The mapper ignores both keys
          -- until taught; envelope shape is unchanged.
          'other_vendor_count', greatest(0, coalesce(ivs.vendor_link_count, 1) - 1),
          'also_from_vendors',  coalesce(
             (select jsonb_agg(l)
                from jsonb_array_elements(coalesce(ivs.vendor_links, '[]'::jsonb)) l
               where (l->>'vendor_id')::uuid <> pif.vendor_id),
             '[]'::jsonb)
        )
        order by pif.suggested_qty desc, pif.item_name asc
      )                                                              as items
      from per_item_filtered pif
      join vendor_delivery vd on vd.vendor_id = pif.vendor_id
      left join item_on_hand ioh_lev on ioh_lev.item_id = pif.item_id
                                    and ioh_lev.vendor_id = pif.vendor_id
      left join item_vendor_set ivs  on ivs.item_id = pif.item_id
     group by vd.vendor_id, vd.vendor_name, vd.schedule_known,
              vd.next_delivery_date, vd.days_until
  ),
  -- (4m) VENDOR ROW JSON. Sorted by next_delivery_date ASC then
  -- vendor_name ASC so the manager sees imminent deliveries first.
  vendor_rows as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'vendor_id',                vwi.vendor_id,
        'vendor_name',              vwi.vendor_name,
        'schedule_known',           vwi.schedule_known,
        'next_delivery_date',       to_char(vwi.next_delivery_date, 'YYYY-MM-DD'),
        'days_until_next_delivery', vwi.days_until,
        'on_hand_source',           vwi.on_hand_source,
        'eod_submitted_at',         vwi.eod_submitted_at,
        'items',                    vwi.items,
        'vendor_total_cost',        vwi.vendor_total_cost,
        -- Spec 123: per-vendor "PO CREATED" signal. TRUE when a
        -- non-cancelled purchase_orders row exists for this store + this
        -- vendor keyed on the SAME v_as_of_date the reorder list is
        -- computed for. Legacy null-reference_date drafts never match
        -- (null = date is never true) — by design, no backfill.
        'has_po', exists (
          select 1
            from public.purchase_orders po
           where po.store_id       = p_store_id
             and po.vendor_id      = vwi.vendor_id
             and po.reference_date = v_as_of_date
             and po.status <> 'cancelled'
        )
      )
      order by vwi.next_delivery_date asc, vwi.vendor_name asc
    ), '[]'::jsonb)                                                  as rows
      from vendors_with_items vwi
  ),
  -- (4n) KPI rollup. Reads off vendors_with_items (post-vendor-filter)
  -- so empty-vendor cards don't inflate counts.
  kpi_calc as (
    select
      count(*)::bigint                                               as vendor_count,
      coalesce(sum(jsonb_array_length(vwi.items)), 0)::bigint        as item_count,
      coalesce(sum(vwi.vendor_total_cost), 0)::numeric               as total_estimated_cost,
      count(*) filter (where vwi.on_hand_source = 'eod')::bigint     as eod_sourced_vendor_count,
      count(*) filter (where vwi.on_hand_source = 'stock')::bigint   as stock_fallback_vendor_count
      from vendors_with_items vwi
  )
  select vr.rows,
         jsonb_build_object(
           'vendor_count',                k.vendor_count,
           'item_count',                  k.item_count,
           'total_estimated_cost',        k.total_estimated_cost,
           'eod_sourced_vendor_count',    k.eod_sourced_vendor_count,
           'stock_fallback_vendor_count', k.stock_fallback_vendor_count
         )
    into v_vendors, v_kpis
    from vendor_rows vr
    cross join kpi_calc k;

  -- (5) WARNINGS — vendors that surfaced suggestions but have no
  -- order_schedule row (A5 fallback applied). Scoped to vendors that
  -- ACTUALLY appear in the final `v_vendors` payload so the warnings
  -- the user sees match the cards on screen. A vendor whose items
  -- are all at par (filtered out at per_item_filtered) won't generate
  -- a `schedule_unknown` warning even if it has no order_schedule row,
  -- because there's no card to attach the warning to.
  with surfaced_vendor_ids as (
    -- Extract vendor_ids from the already-built v_vendors envelope.
    -- jsonb_array_elements is a no-op when v_vendors is [].
    select (elem->>'vendor_id')::uuid as vendor_id
      from jsonb_array_elements(coalesce(v_vendors, '[]'::jsonb)) elem
  ),
  vendors_no_schedule as (
    select v.id as vendor_id, v.name as vendor_name
      from public.vendors v
      join surfaced_vendor_ids svi on svi.vendor_id = v.id
     where not exists (
         select 1
           from public.order_schedule os
          where os.store_id  = p_store_id
            and os.vendor_id = v.id
            and os.delivery_day is not null
       )
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'code',    'schedule_unknown',
      'message', 'Vendor "' || vns.vendor_name
                  || '" has no order schedule — using 7-day buffer.'
    )
  ), '[]'::jsonb) into v_warnings
    from vendors_no_schedule vns;

  -- (6) FINAL ENVELOPE.
  return jsonb_build_object(
    'as_of_date', to_char(v_as_of_date, 'YYYY-MM-DD'),
    'vendors',    coalesce(v_vendors, '[]'::jsonb),
    'kpis',       v_kpis,
    '_warnings',  coalesce(v_warnings, '[]'::jsonb)
  );
end;
$function$;

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 172: optional per-entry no_need key in p_entries — a NO NEED entry inserts no_need = true with NULL numerics (CHECK raises 23514 if a quantity is sent), skips the on-hand write, is omitted from stock_updates, and audits value ''NO NEED''. spec 102: on-hand write is JUNCTION-MEMBERSHIP scoped (item has an item_vendors link for p_vendor_id) so a shared item counted under any of its vendors updates the single shared on-hand; off-vendor entries skip the on-hand write but still audit. spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';

commit;
