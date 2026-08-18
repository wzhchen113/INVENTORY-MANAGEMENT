-- ============================================================
-- Spec 160 — truthful "last counted" indicator on admin Inventory.
-- Backend design §0.2 / §1.
--
-- GENERALIZE BY EXTRACTION. The per-(store, item) "last physically counted"
-- aggregate already existed inside spec 128's staff_items_updated
-- (20260722000000_ingredient_changed_badge.sql:119-132). The admin Inventory
-- column needs the SAME semantics — a divergence between the staff "Updated"
-- badge and the admin "last counted" column would be a bug — so instead of
-- copy-pasting the union (a fork that drifts on the first one-sided edit) the
-- block is lifted VERBATIM into its own function and staff_items_updated is
-- rewritten to consume it. One definition, two callers.
--
--   (a) items_last_counted(p_store_id) — new. SECURITY INVOKER set-returning
--       RPC. One row per inventory_items row in the store; last_counted_at is
--       max(submitted_at) over the UNION of SUBMITTED eod counts
--       (eod_submissions ⨝ eod_entries) and SUBMITTED inventory_counts
--       (inventory_counts ⨝ inventory_count_entries) for that (store, item).
--       NULL = never counted, in this store, by any kind.
--   (b) staff_items_updated(p_store_id) — `create or replace` with a
--       BYTE-IDENTICAL signature and return table. Only the inline `lc`
--       lateral is replaced by a LEFT JOIN to (a). Behavior-preserving; the
--       live staff badge must not move. supabase/tests/
--       ingredient_changed_badge.test.sql is the regression gate and passes
--       UNEDITED.
--
-- Why the join in (b) MUST stay a LEFT JOIN (design §0.3, R1): an inner join
-- would drop never-counted items from the badge result set, and a
-- never-counted item with a changed photo is exactly the row that SHOULD read
-- "Updated" (changed_at is not null and last_counted_at is null → updated =
-- true, pinned by assertions 14/15 of the gate test).
--
-- Why (a) deliberately does NOT join catalog_ingredients the way
-- staff_items_updated does: an inventory_items row whose catalog_id is
-- dangling or whose catalog row is RLS-invisible would be silently OMITTED
-- from the result set, and the admin client cannot distinguish "omitted" from
-- "never counted" — an AC-9 violation delivered by the backend. The driver is
-- inventory_items alone, so row presence is never load-bearing for the client:
-- a NULL value is the one and only never-counted signal.
--
-- RLS: no new policies, no policy edits. SECURITY INVOKER on both sides means
-- every read rides the existing per-store policies (auth_can_see_store on
-- inventory_items / eod_submissions / inventory_counts, transitive EXISTS
-- policies on the two entry tables). AC-6 is structural: a caller who cannot
-- see the store gets zero driver rows, so the function returns the EMPTY SET —
-- not "rows with NULL". No explicit 42501 gate, matching spec 128's posture.
--
-- Indexes: NONE added. All three access paths are already covered —
-- idx_eod_entries_submission_id (spec 151), eod_entries_item_id_idx (spec 128),
-- inventory_count_entries_item_created_idx (spec 019). No index build means no
-- SHARE lock on eod_entries and none of spec 151's off-peak-apply caveat.
--
-- Realtime: NO publication change. This migration creates two functions and
-- nothing else, so the `docker restart supabase_realtime_imr-inventory`
-- gotcha does NOT apply to spec 160.
--
-- Idempotent for the local + prod (MCP) double-apply: two `create or replace
-- function` statements, no `drop`, no data change. Rollback = re-apply spec
-- 128's staff_items_updated body + `drop function public.items_last_counted(uuid)`.
-- ============================================================

-- ─── RPC: items_last_counted(p_store_id) ────────────────────────────────────
-- The union-max block below is copied CHARACTER-FOR-CHARACTER from spec 128's
-- staff_items_updated so a reviewer can diff it against the original. Do not
-- "tidy" it into a `group by` — textual identity to the pinned original is the
-- point of the extraction.
create or replace function public.items_last_counted(p_store_id uuid)
returns table(item_id uuid, last_counted_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select
    ii.id,
    lc.last_counted_at
  from public.inventory_items ii
  left join lateral (
    select max(t.submitted_at) as last_counted_at
    from (
      select es.submitted_at
        from public.eod_submissions es
        join public.eod_entries ee on ee.submission_id = es.id
       where es.store_id = p_store_id and ee.item_id = ii.id and es.status = 'submitted'
      union all
      select ic.submitted_at
        from public.inventory_counts ic
        join public.inventory_count_entries ice on ice.count_id = ic.id
       where ic.store_id = p_store_id and ice.item_id = ii.id and ic.status = 'submitted'
    ) t
  ) lc on true
  where ii.store_id = p_store_id;
$$;

revoke execute on function public.items_last_counted(uuid) from public, anon;
grant  execute on function public.items_last_counted(uuid) to authenticated;

-- ─── RPC: staff_items_updated(p_store_id) — rewritten, behavior-preserving ──
-- Signature and `returns table(...)` are byte-identical to spec 128, so
-- `create or replace` succeeds without a `drop` and there is no window in
-- which the staff RPC is absent. The catalog_ingredients join and the
-- greatest() changed_at lateral are unchanged; ONLY the `lc` lateral becomes a
-- LEFT JOIN to items_last_counted. `updated` is still derived from the same
-- last_counted_at, so preserving that value preserves the badge by
-- construction.
create or replace function public.staff_items_updated(p_store_id uuid)
returns table(item_id uuid, changed_at timestamptz, last_counted_at timestamptz, updated boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select
    ii.id,
    ge.changed_at,
    lc.last_counted_at,
    (ge.changed_at is not null
       and (lc.last_counted_at is null or ge.changed_at > lc.last_counted_at)) as updated
  from public.inventory_items ii
  join public.catalog_ingredients ci on ci.id = ii.catalog_id
  cross join lateral (
    select greatest(ci.image_changed_at, ii.vendor_changed_at) as changed_at
  ) ge
  left join public.items_last_counted(p_store_id) lc on lc.item_id = ii.id
  where ii.store_id = p_store_id;
$$;

revoke execute on function public.staff_items_updated(uuid) from public, anon;
grant  execute on function public.staff_items_updated(uuid) to authenticated;
