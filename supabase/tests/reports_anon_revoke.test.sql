-- supabase/tests/reports_anon_revoke.test.sql
--
-- Spec 023 / A6 — retroactive coverage for spec 016 anon revoke.
-- Verifies the `revoke execute on function ... from public, anon`
-- declarations stay in place across the entire reports + EOD + count
-- surface. Closes the
-- `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes lesson
-- at GRANT time (before any RLS evaluation).
--
-- 13 RPCs covered (each: anon lacks EXECUTE):
--   • report_run(text, uuid, jsonb)                — dispatcher
--   • report_run_stub(uuid, jsonb)                 — spec 016
--   • report_run_cogs(uuid, jsonb)                 — spec 017
--   • report_run_variance(uuid, jsonb)             — spec 018
--   • report_run_waste(uuid, jsonb)                — spec 034
--   • report_run_vendor(uuid, jsonb)               — spec 035
--   • report_run_velocity(uuid, jsonb)             — spec 036
--   • report_run_custom(uuid, jsonb)               — spec 037
--   • report_reorder_list(uuid, jsonb)             — spec 021
--   • submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text)  — spec 019
--   • staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)               — spec 020 (only
--     granted to service_role; anon still lacks EXECUTE)
--   • copy_catalog_rows(uuid, uuid, text, uuid[])  — spec 049 (super-admin
--     gated; anon still lacks EXECUTE at the GRANT layer)
--   • compute_menu_capacity(uuid)                  — spec 060 (belt-and-
--     suspenders for spec 067; arm 10 of compute_menu_capacity.test.sql
--     covers the same assertion via the same catalog pattern)
--
-- Background: Postgres' default `EXECUTE TO PUBLIC` lets `anon` (which
-- inherits from PUBLIC) bypass a bare `... from anon` revoke, so each
-- of these migrations explicitly revokes from BOTH `public` and `anon`.
-- This test verifies the lockdown end-to-end as the anon role.
--
-- IMPLEMENTATION NOTE (rewritten 2026-05-18, post-spec-045):
-- Prior version used `set local role anon` + `throws_ok` to verify the
-- 42501 SQLSTATE at runtime. That pattern segfaulted Postgres in CI
-- under the supabase/setup-cli@v1 `latest` image (newer pg-version), and
-- the resulting server crash cascaded into 3 unrelated tests failing
-- with "database system is in recovery mode". Switched to
-- `has_function_privilege('anon', <sig>, 'EXECUTE')` which queries the
-- catalog directly — same end-state assertion (anon has no EXECUTE),
-- no role switch, no dynamic-EXECUTE crash. Functions reach the same
-- 42501 path at runtime via the missing GRANT; the test no longer
-- depends on Postgres being willing to execute a permission-denied
-- function call as the anon role.

begin;
create extension if not exists pgtap;

select plan(13);

-- ─── (1) report_run dispatcher ────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run(text, uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run dispatcher'
);

-- ─── (2) report_run_stub ──────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_stub(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_stub'
);

-- ─── (3) report_run_cogs ──────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_cogs(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_cogs'
);

-- ─── (4) report_run_variance ──────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_variance(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_variance'
);

-- ─── (5) report_run_waste ─────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_waste(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_waste'
);

-- ─── (6) report_run_vendor ────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_vendor(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_vendor'
);

-- ─── (7) report_run_velocity ──────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_velocity(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_velocity'
);

-- ─── (8) report_run_custom ────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_run_custom(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_run_custom'
);

-- ─── (9) report_reorder_list ──────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.report_reorder_list(uuid, jsonb)', 'EXECUTE'),
  'anon lacks EXECUTE on report_reorder_list'
);

-- ─── (10) submit_inventory_count ──────────────────────────────
select ok(
  not has_function_privilege(
    'anon',
    'public.submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text)',
    'EXECUTE'
  ),
  'anon lacks EXECUTE on submit_inventory_count'
);

-- ─── (11) staff_submit_eod ────────────────────────────────────
-- Only granted to service_role; anon still lacks EXECUTE.
select ok(
  not has_function_privilege(
    'anon',
    'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)',
    'EXECUTE'
  ),
  'anon lacks EXECUTE on staff_submit_eod (service_role-only)'
);

-- ─── (12) copy_catalog_rows ───────────────────────────────────
-- Spec 049: super-admin only; granted to authenticated, revoked from
-- public + anon. Anon must lack EXECUTE at the GRANT layer regardless
-- of the in-function auth_is_super_admin() gate.
select ok(
  not has_function_privilege(
    'anon',
    'public.copy_catalog_rows(uuid, uuid, text, uuid[])',
    'EXECUTE'
  ),
  'anon lacks EXECUTE on copy_catalog_rows (super_admin-only)'
);

-- ─── (13) compute_menu_capacity ───────────────────────────────
-- Spec 060: per-store gated via auth_can_see_store; revoked from
-- public + anon. Belt-and-suspenders coverage alongside arm 10 of
-- supabase/tests/compute_menu_capacity.test.sql (which uses the
-- same catalog pattern; see spec 067).
select ok(
  not has_function_privilege('anon', 'public.compute_menu_capacity(uuid)', 'EXECUTE'),
  'anon lacks EXECUTE on compute_menu_capacity'
);

select * from finish();
rollback;
