-- supabase/tests/reports_anon_revoke.test.sql
--
-- Spec 023 / A6 — retroactive coverage for spec 016 anon revoke.
-- Verifies the `revoke execute on function ... from public, anon`
-- declarations stay in place across the entire reports + EOD + count
-- surface. Closes the
-- `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes lesson
-- at GRANT time (before any RLS evaluation).
--
-- 12 RPCs covered (all share the same end-state shape: anon → 42501).
-- (Header was stale at "8 RPCs covered" pre-spec-035 — spec 034 added
-- the waste arm without bumping the comment; spec 035 fixed that and
-- added the vendor arm; spec 036 added the velocity arm; spec 037 added
-- the custom arm. Net: comment goes 8 → 12 across spec-034/035/036/037.)
--   • report_run(text, uuid, jsonb)                — dispatcher
--   • report_run_stub(uuid, jsonb)                 — spec 016
--   • report_run_cogs(uuid, jsonb)                 — spec 017
--   • report_run_variance(uuid, jsonb)             — spec 018
--   • report_run_waste(uuid, jsonb)                — spec 034
--   • report_run_vendor(uuid, jsonb)               — spec 035
--   • report_run_velocity(uuid, jsonb)             — spec 036
--   • report_run_custom(uuid, jsonb)               — spec 037
--   • report_reorder_list(uuid, jsonb)             — spec 021
--   • submit_inventory_count(...)                  — spec 019
--   • staff_submit_eod(...)                        — spec 020 (only
--     granted to service_role; anon → permission denied for function,
--     same 42501 SQLSTATE)
--
-- Background: Postgres' default `EXECUTE TO PUBLIC` lets `anon` (which
-- inherits from PUBLIC) bypass a bare `... from anon` revoke, so each
-- of these migrations explicitly revokes from BOTH `public` and `anon`.
-- This test verifies the lockdown end-to-end as the anon role.
--
-- Caveat documented in the architect's design: `set local role anon`
-- requires the test runner to be a superuser, which pgTAP under
-- `psql` is. The `current_setting('request.jwt.claims')` reflects an
-- 'anon' role JWT (the shape PostgREST sends for anonymous traffic).

begin;
create extension if not exists pgtap;

select plan(12);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_frederick uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  perform set_config('test.frederick_id', v_frederick::text, true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── Switch to anon role and set anon JWT claims ──────────────
-- This matches what PostgREST sends when no JWT is present.
set local role anon;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'anon'
  )::text,
  true
);

-- ─── (1) report_run dispatcher: anon → 42501 ──────────────────
-- The dispatcher is granted only to `authenticated`. Anon's call
-- fails at GRANT time (before the auth_can_see_store check inside
-- the function body) with SQLSTATE 42501.
select throws_ok(
  format(
    $q$select public.report_run('stub', %L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run dispatcher denied to anon (42501 at GRANT time)'
);

-- ─── (2) report_run_stub: anon → 42501 ────────────────────────
select throws_ok(
  format(
    $q$select public.report_run_stub(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_stub denied to anon (42501 at GRANT time)'
);

-- ─── (3) report_run_cogs: anon → 42501 ────────────────────────
select throws_ok(
  format(
    $q$select public.report_run_cogs(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_cogs denied to anon (42501 at GRANT time)'
);

-- ─── (4) report_run_variance: anon → 42501 ────────────────────
select throws_ok(
  format(
    $q$select public.report_run_variance(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_variance denied to anon (42501 at GRANT time)'
);

-- ─── (5) report_run_waste: anon → 42501 ───────────────────────
-- Spec 034 — `revoke from public, anon; grant to authenticated`
-- mirrors the spec 016 convention. Anon's call fails at GRANT time
-- before the auth_can_see_store check inside the function body.
select throws_ok(
  format(
    $q$select public.report_run_waste(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_waste denied to anon (42501 at GRANT time)'
);

-- ─── (6) report_run_vendor: anon → 42501 ──────────────────────
-- Spec 035 — same `revoke from public, anon; grant to authenticated`
-- convention. Anon's call fails at GRANT time before the
-- auth_can_see_store check inside the function body.
select throws_ok(
  format(
    $q$select public.report_run_vendor(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_vendor denied to anon (42501 at GRANT time)'
);

-- ─── (7) report_run_velocity: anon → 42501 ────────────────────
-- Spec 036 — same `revoke from public, anon; grant to authenticated`
-- convention. Anon's call fails at GRANT time before the
-- auth_can_see_store check inside the function body.
select throws_ok(
  format(
    $q$select public.report_run_velocity(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_velocity denied to anon (42501 at GRANT time)'
);

-- ─── (8) report_run_custom: anon → 42501 ──────────────────────
-- Spec 037 — same `revoke from public, anon; grant to authenticated`
-- convention. Anon's call fails at GRANT time before either the
-- auth_can_see_store check OR the auth_is_privileged() check inside
-- the function body — the GRANT denial fires first.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_custom denied to anon (42501 at GRANT time)'
);

-- ─── (9) report_reorder_list: anon → 42501 ────────────────────
select throws_ok(
  format(
    $q$select public.report_reorder_list(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_reorder_list denied to anon (42501 at GRANT time)'
);

-- ─── (10) submit_inventory_count: anon → 42501 ────────────────
-- 7-arg signature: (client_uuid, store_id, kind, counted_at, status,
-- entries, notes). All-NULL args are fine — the GRANT denial fires
-- before any param parsing.
select throws_ok(
  format(
    $q$select public.submit_inventory_count(
         null::uuid, %L::uuid, 'spot', null::timestamptz, 'submitted',
         '[]'::jsonb, null::text)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'submit_inventory_count denied to anon (42501 at GRANT time)'
);

-- ─── (11) staff_submit_eod: anon → 42501 ──────────────────────
-- Only granted to service_role; anon's call fails at GRANT time. Same
-- SQLSTATE as the other arms even though the underlying grant rule
-- differs (`grant ... to service_role` vs `grant ... to authenticated`).
select throws_ok(
  format(
    $q$select public.staff_submit_eod(
         null::uuid, %L::uuid, current_date, null::text, 'submitted',
         '[]'::jsonb, null::uuid)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'staff_submit_eod denied to anon (42501 at GRANT time; service_role-only)'
);

select * from finish();
rollback;
