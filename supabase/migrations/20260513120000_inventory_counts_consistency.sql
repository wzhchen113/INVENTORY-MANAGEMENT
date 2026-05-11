-- ============================================================
-- Spec 019 — Any-time inventory count, round-2 consistency fixes.
--
-- Closes the security-auditor's 4 Critical findings against
-- `20260513000000_inventory_counts.sql`. All four were live-PoC verified
-- under `manager@local.test` JWT impersonation
-- (`specs/019-any-time-inventory-count/reviews/security-auditor.md`).
-- This is the **third** time the
-- `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes pattern
-- has produced Criticals on this codebase: REPORTS-1 round-1, REPORTS-1
-- round-2, now Spec 019. The fix template is the same as
-- `20260510130000_report_runs_consistency.sql`.
--
-- Findings closed here:
--
--   C-Sec-1 (submitted_by forgery via direct PostgREST INSERT). The RLS
--     INSERT policy only gates on `auth_can_see_store(store_id)`; the
--     column has no default and no override, so a hand-crafted INSERT
--     can attribute the row to any user. Closed by a BEFORE INSERT/UPDATE
--     trigger that overrides `new.submitted_by := auth.uid()`
--     unconditionally — the same shape as
--     `report_runs_check_definition_consistency` overrides `ran_by`
--     (`20260510130000_report_runs_consistency.sql:48-88`).
--
--   C-Sec-2 (cross-store `item_id` spoof via direct entry INSERT). The
--     entries RLS scopes through the parent count via `EXISTS`, but
--     never asserts that the entry's `item_id.store_id` matches the
--     parent's `store_id`. The RPC's `exists … inventory_items where
--     id = … and store_id = p_store_id` check is bypassed by a direct
--     PostgREST entry INSERT. Closed by a BEFORE INSERT/UPDATE trigger
--     on `inventory_count_entries` that re-asserts the relationship.
--
--   C-Sec-3 (UPDATE allows audit-field rewrite) and C-Sec-4 (DELETE
--     allows audit-trail destruction). Append-only posture chosen over
--     admin-only-edit: counts are advisory historical snapshots and the
--     frontend never UPDATEs or DELETEs them. Drop the policies entirely
--     — without a policy, RLS denies the operation under any caller.
--     If a real "edit a typo'd count" use case emerges, a separate spec
--     can add admin-only UPDATE/DELETE policies with column-level
--     lockdown.
--
-- Note on store-cascade-delete. The parent `stores(id) on delete
-- cascade` (migration L72) still works through the cascade path because
-- the cascade runs as the postgres role under a normal admin store-
-- deletion flow, not via PostgREST.
-- ============================================================

-- ─── (1) submitted_by override trigger on inventory_counts ───
-- BEFORE INSERT/UPDATE on `inventory_counts`. The function overrides
-- `submitted_by` with `auth.uid()` regardless of what the client passed.
-- `security invoker` — RLS already gates which rows the caller can see.
-- For service-role callers (e.g. a future cron) `auth.uid()` returns
-- NULL, which is the right "system" attribution.
create or replace function public.inventory_counts_set_submitted_by()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.submitted_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists inventory_counts_set_submitted_by_trg
  on public.inventory_counts;
create trigger inventory_counts_set_submitted_by_trg
  before insert or update on public.inventory_counts
  for each row execute function public.inventory_counts_set_submitted_by();

-- ─── (2) cross-store consistency trigger on entries ──────────
-- BEFORE INSERT/UPDATE on `inventory_count_entries`. The function reads
-- the parent count's `store_id` and the entry's `item_id.store_id` and
-- refuses the write if they don't match (or if either lookup fails
-- under the caller's RLS). Raises `42501` so the dispatcher and trigger
-- speak the same error class to the frontend — same pattern as
-- `report_runs_check_definition_consistency`.
create or replace function public.inventory_count_entries_check_store()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count_store_id uuid;
  v_item_store_id  uuid;
begin
  select store_id into v_count_store_id
    from public.inventory_counts
   where id = new.count_id;
  if v_count_store_id is null then
    raise exception 'inventory_count_entries: parent count not found or not visible'
      using errcode = '42501';
  end if;

  select store_id into v_item_store_id
    from public.inventory_items
   where id = new.item_id;
  if v_item_store_id is null or v_item_store_id is distinct from v_count_store_id then
    raise exception 'inventory_count_entries: item store mismatch with parent count'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists inventory_count_entries_check_store_trg
  on public.inventory_count_entries;
create trigger inventory_count_entries_check_store_trg
  before insert or update on public.inventory_count_entries
  for each row execute function public.inventory_count_entries_check_store();

-- ─── (3) Lock down UPDATE — append-only ──────────────────────
-- Drop the UPDATE policies on both tables. Without a policy, RLS denies
-- UPDATE under any non-superuser caller. The frontend never UPDATEs
-- counts; the RPC commits the row atomically and is done.
drop policy if exists "store_member_update_inventory_counts"
  on public.inventory_counts;
drop policy if exists "store_member_update_inventory_count_entries"
  on public.inventory_count_entries;

-- ─── (4) Lock down DELETE — append-only ──────────────────────
-- Drop the DELETE policies on both tables. Same posture as UPDATE.
-- Store-cascade-delete (stores(id) on delete cascade) still works
-- because the cascade runs as the postgres role.
drop policy if exists "store_member_delete_inventory_counts"
  on public.inventory_counts;
drop policy if exists "store_member_delete_inventory_count_entries"
  on public.inventory_count_entries;
