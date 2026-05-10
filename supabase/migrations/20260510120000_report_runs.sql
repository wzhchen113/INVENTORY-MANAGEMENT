-- ============================================================
-- Spec 016 (REPORTS-1) — Reports Runner Foundation
--
-- Persists per-run output for saved (and ad-hoc) report definitions
-- and tightens RLS on `report_definitions` from the early-dev permissive
-- policy down to the per-store `auth_can_see_store(store_id)` shape used
-- by the rest of the per-store tables (see
-- `20260504173035_per_store_rls_hardening.sql:46-61`).
--
-- This migration also lays the groundwork for the per-template RPC
-- contract that REPORTS-2 (cogs) and REPORTS-3 (variance) build on. Only
-- the foundation lands here:
--
--   • `report_run_stub` — dev/test envelope used by the foundation work.
--   • `report_run`      — dispatcher; routes by `template_id`. Anything
--                         not yet wired returns a `not_implemented` envelope
--                         so the frontend frame can render a graceful
--                         "Runner coming soon" branch without bespoke
--                         UI per template.
--
-- ─── Per-template RPC convention ─────────────────────────────
-- Every future template runner (REPORTS-2 onward) MUST follow this
-- signature exactly. The dispatcher in `report_run` will gain one `when`
-- branch per template:
--
--   create or replace function public.report_run_<template>(
--     p_store_id uuid,
--     p_params   jsonb
--   ) returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = public
--   as $$
--   begin
--     if not public.auth_can_see_store(p_store_id) then
--       raise exception 'Not authorized for store %', p_store_id
--         using errcode = '42501';
--     end if;
--     -- ... compute and return the uniform envelope ...
--   end;
--   $$;
--   revoke execute on function public.report_run_<template>(uuid, jsonb)
--     from public, anon;
--   grant execute on function public.report_run_<template>(uuid, jsonb)
--     to authenticated;
--
-- (Postgres' default `EXECUTE TO PUBLIC` would leave the function callable
-- by `anon` even after a bare `... from anon`, since `anon` inherits from
-- PUBLIC. Mirror `20260505065303_admin_rpcs_lock_anon.sql:24`.)
--
-- Return shape (the uniform envelope) is exactly:
--
--   {
--     "kpis":    [{ "label": "string", "value": "string|number",
--                   "tone": "ok|warn|danger|null" }],
--     "columns": [{ "key": "string", "label": "string",
--                   "align": "left|right|null" }],
--     "rows":    [{ "<col-key>": "value", ... }],
--     "series":  [{ "label": "string", "x": "string", "y": "number" }] | null
--   }
--
-- For not-yet-implemented templates the dispatcher returns:
--
--   { "kpis": [], "columns": [], "rows": [], "series": null,
--     "_status": "not_implemented",
--     "_message": "Runner coming soon · definition saved" }
--
-- Hard rules:
--   • `security invoker` — RLS gates the data; never `security definer`.
--   • `set search_path = public` — locks the schema for safety.
--   • The runner MUST validate `auth_can_see_store(p_store_id)` and raise
--     `42501` on false; the wrapping dispatcher does this too, but inner
--     runners stay independently safe so they can be invoked directly.
--   • Granted to `authenticated`; revoked from `public, anon`.
-- ============================================================

-- ─── Table: report_runs ──────────────────────────────────────
create table if not exists public.report_runs (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid null references public.report_definitions(id) on delete cascade,
  template_id     text not null,
  store_id        uuid not null references public.stores(id) on delete cascade,
  params          jsonb not null default '{}'::jsonb,
  output          jsonb null,
  status          text not null default 'pending'
                    check (status in ('pending','ok','error')),
  error_message   text null,
  ran_at          timestamptz not null default now(),
  ran_by          uuid null references public.profiles(id)
);

-- Read pattern: `fetchLatestRun({ definitionId })` →
--   `where definition_id = $1 order by ran_at desc limit 1`.
-- The partial predicate keeps the index narrow by excluding ad-hoc rows
-- (those use the second index instead).
create index if not exists report_runs_definition_ran_at_idx
  on public.report_runs(definition_id, ran_at desc)
  where definition_id is not null;

-- Read pattern: `fetchLatestRun({ templateId, storeId })` for ad-hoc runs
-- (definition_id IS NULL) → `where store_id = $1 and template_id = $2
--  order by ran_at desc limit 1`.
create index if not exists report_runs_store_template_ran_at_idx
  on public.report_runs(store_id, template_id, ran_at desc);

alter table public.report_runs enable row level security;

-- ─── RLS: report_runs (per-store via auth_can_see_store) ─────
drop policy if exists "store_member_read_report_runs"   on public.report_runs;
drop policy if exists "store_member_insert_report_runs" on public.report_runs;
drop policy if exists "store_member_update_report_runs" on public.report_runs;
drop policy if exists "store_member_delete_report_runs" on public.report_runs;

create policy "store_member_read_report_runs"
  on public.report_runs for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_report_runs"
  on public.report_runs for insert
  with check (public.auth_can_see_store(store_id));

-- Update is included so the client can flip status pending → ok|error
-- after the RPC returns. Without this, the optimistic-then-resolve flow
-- in `db.runReport` would have to delete-and-reinsert.
create policy "store_member_update_report_runs"
  on public.report_runs for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_report_runs"
  on public.report_runs for delete
  using (public.auth_can_see_store(store_id));

-- ─── RLS: report_definitions (replace permissive) ────────────
-- The early-dev `"authenticated can do anything"` policy from
-- `20260503000001_report_definitions.sql:25-30` is replaced with the same
-- per-store shape as the rest of the hardened tables. Cross-store
-- visibility for super-admin / admin / master is preserved because
-- `auth_can_see_store` short-circuits to `auth_is_admin()`.
drop policy if exists "authenticated can do anything"   on public.report_definitions;
drop policy if exists "store_member_read_report_definitions"   on public.report_definitions;
drop policy if exists "store_member_insert_report_definitions" on public.report_definitions;
drop policy if exists "store_member_update_report_definitions" on public.report_definitions;
drop policy if exists "store_member_delete_report_definitions" on public.report_definitions;

create policy "store_member_read_report_definitions"
  on public.report_definitions for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_report_definitions"
  on public.report_definitions for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_report_definitions"
  on public.report_definitions for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_report_definitions"
  on public.report_definitions for delete
  using (public.auth_can_see_store(store_id));

-- ─── RPC: report_run_stub (dev/test only) ────────────────────
-- Hand-rolled envelope used by the foundation work to exercise the
-- frontend detail frame end-to-end. Not wired to any production
-- template tile. `p_params` is accepted for signature stability but
-- ignored in REPORTS-1.
create or replace function public.report_run_stub(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'kpis', jsonb_build_array(
      jsonb_build_object('label', 'Stub KPI', 'value', '42', 'tone', 'ok')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'item',  'label', 'Item',  'align', 'left'),
      jsonb_build_object('key', 'value', 'label', 'Value', 'align', 'right')
    ),
    'rows', jsonb_build_array(
      jsonb_build_object('item', 'Alpha', 'value', 12),
      jsonb_build_object('item', 'Beta',  'value', 30)
    ),
    'series', jsonb_build_array(
      jsonb_build_object('label', 'series-1', 'x', '2026-05-06', 'y', 10),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-07', 'y', 12),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-08', 'y',  9),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-09', 'y', 14),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-10', 'y', 11)
    )
  );
end;
$$;

-- REVOKE from public + anon mirrors `20260505065303_admin_rpcs_lock_anon.sql`.
-- Postgres' default for new functions is `EXECUTE TO PUBLIC`, and `anon` is a
-- member of `PUBLIC`, so a `revoke ... from anon` alone leaves the function
-- callable by anon via the inherited PUBLIC grant. Revoking from PUBLIC closes
-- that path; the explicit `from anon` is belt-and-suspenders for clarity.
revoke execute on function public.report_run_stub(uuid, jsonb) from public, anon;
grant execute on function public.report_run_stub(uuid, jsonb) to authenticated;

-- ─── RPC: report_run (dispatcher) ────────────────────────────
-- Single entry point the client calls. Routes by `template_id`. REPORTS-2
-- and REPORTS-3 will add `when 'cogs'` and `when 'variance'` branches.
-- Every other template returns the not-implemented envelope so the
-- frontend frame renders a graceful "Runner coming soon" branch.
--
-- Two layers of `auth_can_see_store` (here + inner runner) — redundant
-- but cheap (the helper is `stable`) and means inner runners stay
-- independently safe when called directly.
create or replace function public.report_run(
  p_template_id text,
  p_store_id    uuid,
  p_params      jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  case p_template_id
    when 'stub' then
      return public.report_run_stub(p_store_id, p_params);
    -- REPORTS-2 will add: when 'cogs'     then return public.report_run_cogs(p_store_id, p_params);
    -- REPORTS-3 will add: when 'variance' then return public.report_run_variance(p_store_id, p_params);
    else
      return jsonb_build_object(
        'kpis',     '[]'::jsonb,
        'columns',  '[]'::jsonb,
        'rows',     '[]'::jsonb,
        'series',   null,
        '_status',  'not_implemented',
        '_message', 'Runner coming soon · definition saved'
      );
  end case;
end;
$$;

revoke execute on function public.report_run(text, uuid, jsonb) from public, anon;
grant execute on function public.report_run(text, uuid, jsonb) to authenticated;
