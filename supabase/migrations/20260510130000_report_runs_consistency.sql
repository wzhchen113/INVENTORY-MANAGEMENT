-- ============================================================
-- Spec 016 (REPORTS-1) — Reports Runner Foundation, follow-up
--
-- Closes the security-auditor's Critical and High #1 findings against
-- the foundation migration `20260510120000_report_runs.sql`:
--
--   1. Cross-store `report_runs` INSERT spoof — an attacker member of
--      store A could INSERT a row with `definition_id` pointing at a
--      saved definition in store B while passing `store_id = A` to pass
--      the per-store `WITH CHECK`. The forged row then becomes the
--      "latest run" for that foreign definition because
--      `db.fetchLatestRun({ definitionId })` filters only on
--      `definition_id` with no `store_id` constraint. Closed here with a
--      BEFORE INSERT/UPDATE trigger that asserts
--      `(NEW.store_id, NEW.template_id)` matches the parent
--      `report_definitions` row whenever `definition_id` is non-null.
--      Raises `42501` so the dispatcher and trigger speak the same
--      error class to the frontend.
--
--   2. `ran_by` audit-trail forgery — the column had no default, so the
--      client could attribute a run to any user id. Closed by (a) setting
--      `default auth.uid()` on the column, AND (b) having the consistency
--      trigger override `NEW.ran_by := auth.uid()` unconditionally — the
--      `default` only fires on column omission, so without the trigger
--      override a hand-crafted PostgREST request that includes `ran_by`
--      in its body could still forge the value (security-auditor round-2
--      finding). The trigger override makes the server-side value
--      canonical regardless of whether the client supplied one. For
--      service-role callers (e.g. a future scheduled-run cron),
--      `auth.uid()` returns NULL, which is the right "system" attribution.
--
-- The architect's preferred Path A (minimal-diff) is taken. The two-step
-- RPC-then-INSERT pattern in `db.runReport` is unchanged — REPORTS-2/3
-- inherit the contract as-is. Path B (move INSERT into the dispatcher)
-- is deferred to a separate spec if/when COGS RPC latency makes the
-- two-step race material.
-- ============================================================

-- ─── (1) Cross-table consistency trigger ─────────────────────
-- BEFORE INSERT/UPDATE on `report_runs`. When `definition_id` is set,
-- the row's `store_id` and `template_id` MUST match the parent
-- `report_definitions` row. Otherwise we raise `42501`. The function
-- runs as `security invoker` — RLS already gates which definitions are
-- visible to the caller via `auth_can_see_store(store_id)`, so there's
-- no need to escalate. The lookup against `report_definitions` will
-- only succeed when the caller can see the parent row, which is exactly
-- the property that prevents the spoof.
create or replace function public.report_runs_check_definition_consistency()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_def_store_id    uuid;
  v_def_template_id text;
begin
  -- Override any client-supplied `ran_by` with the authenticated caller.
  -- The column-level `default auth.uid()` only fires on omission; this
  -- closes the case where a client explicitly names `ran_by` in the body.
  new.ran_by := auth.uid();

  if new.definition_id is null then
    return new;
  end if;

  select store_id, template_id
    into v_def_store_id, v_def_template_id
    from public.report_definitions
   where id = new.definition_id;

  -- If the parent definition is not visible to the caller (RLS hides it,
  -- or it doesn't exist), refuse the write. Without this, an attacker
  -- could pass a fabricated UUID and the lookup would silently return
  -- nothing, letting the row through.
  if v_def_store_id is null then
    raise exception 'report_runs row inconsistent with parent definition'
      using errcode = '42501';
  end if;

  if (new.store_id, new.template_id) is distinct from (v_def_store_id, v_def_template_id) then
    raise exception 'report_runs row inconsistent with parent definition'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists report_runs_check_definition_consistency_trg
  on public.report_runs;
create trigger report_runs_check_definition_consistency_trg
  before insert or update on public.report_runs
  for each row execute function public.report_runs_check_definition_consistency();

-- ─── (2) ran_by default = auth.uid() ──────────────────────────
-- Closes High #1: the column was nullable + no default, so a client
-- could attribute a run to anyone. The client INSERT in `db.runReport`
-- drops the `ran_by` field; this default makes the server canonical.
alter table public.report_runs
  alter column ran_by set default auth.uid();
