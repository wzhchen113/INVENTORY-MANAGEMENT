-- supabase/tests/public_grants_explicit.test.sql
--
-- Spec 097 — regression-guard probe for the explicit Supabase-role
-- grant posture restored by
-- supabase/migrations/20260618000000_public_grants_explicit.sql.
--
-- WHY THIS EXISTS
-- ---------------
-- Supabase CLI 2.106.0+ ships a Postgres image that REVOKES the
-- implicit broad `GRANT ... ON public.* TO {anon, authenticated,
-- service_role}` older images granted by default. Because the pgTAP
-- suite runs as `authenticated` (it reaches RLS via auth.uid()
-- JWT-claim injection), a missing TABLE grant raises
-- `permission denied (42501)` BEFORE the RLS check is even evaluated.
-- That is exactly how 34 of 46 pgTAP files broke when `version: latest`
-- floated 2.105.0 -> 2.106.0 (the documented local-green/CI-red
-- asymmetry, specs 060/067). Migration 20260618000000 makes the grants
-- schema-explicit; this probe pins that posture so the next grant
-- regression surfaces as ONE targeted, named failure rather than a
-- 34-file scatter that took 7 runs / 3 days to diagnose.
--
-- DECISION: iterate-all-tables-with-allowlist, modeled on spec 053's
-- supabase/tests/permissive_policy_lint.test.sql. The grant posture is
-- a SCHEMA-WIDE INVARIANT ("every public base table grants the asserted
-- privilege to all three roles, except an explicit role-keyed
-- allowlist"), so an iterate-all probe catches a FUTURE table that a
-- developer adds without the `ALTER DEFAULT PRIVILEGES` inheritance
-- taking effect — the precise durability failure mode this spec exists
-- to prevent. A hardcoded per-table list would silently not cover new
-- tables.
--
-- TWO KINDS OF ASSERTION (the corrected shape — see spec §4a)
-- ----------------------------------------------------------
-- The probe has a POSITIVE arm (the broad grant IS present everywhere
-- except the allowlist) AND two NEGATIVE arms that pin the two deliberate
-- REVOKEs the migration preserves. The negative arm on profiles.TRUNCATE
-- is precisely the assertion that would have caught the original flaw —
-- the SUPERSEDED probe asserted only positive SELECT + an EMPTY allowlist,
-- so it would have stayed green while a blanket `GRANT ALL` re-opened the
-- spec-041 TRUNCATE escalation AND re-granted the spec-093 audit table.
--
-- SENTINEL = SELECT (positive arm). We assert `has_table_privilege(<role>,
-- 'public.<table>', 'SELECT')` is true for anon, authenticated, AND
-- service_role across every base table in public (minus the allowlist).
-- SELECT is the privilege the 34 broken files actually needed (they read
-- tables to reach the RLS check), and the one arm (6) of
-- username_resolve_rate_limit.test.sql depends on. It is a faithful,
-- low-noise sentinel for "the broad grant is present." NOTE: profiles is
-- NOT allowlisted — it still holds SELECT for all three roles (only
-- TRUNCATE was removed), so the positive sentinel passes on it; the
-- TRUNCATE removal is asserted by the dedicated negative arm (5).
--
-- TABLE privileges ONLY — never routine EXECUTE. The migration uses
-- approach 7(a): it does NOT retroactively `GRANT ... ON ALL ROUTINES`,
-- because that would sort after — and re-open — the ~15 per-RPC
-- `REVOKE EXECUTE ... FROM anon, authenticated` hardening migrations
-- (specs 016/061/095). Asserting routine EXECUTE for anon/authenticated
-- here would directly CONTRADICT those REVOKEs, so this probe stays at
-- the table layer and keeps probe + migration aligned. Routine grants
-- are covered (for FUTURE functions) by the migration's
-- `ALTER DEFAULT PRIVILEGES ... ON functions` line; existing-function
-- EXECUTE is asserted by reports_anon_revoke.test.sql, not here.
--
-- ALLOWLIST = 1 ROW, role-keyed (the single most important correctness
-- point). An allowlist entry means a table INTENTIONALLY withholds the
-- table-level GRANT from a Supabase role AT THE GRANT LAYER (a deliberate
-- `REVOKE ... from <role>`) — i.e. has_table_privilege is EXPECTED to be
-- false. There is a sharp two-category distinction:
--
--   Category A — "no grant by design" → ON the allowlist.
--     public.spec093_case_qty_backfill_audit (spec 093,
--     20260602120000:68) AND public.spec104_per_each_cost_audit (spec 104,
--     20260701000000): each runs `revoke all ... from anon, authenticated`. They
--     receive NO table grant for those two roles by deliberate design, so
--     the positive SELECT sentinel SKIPS them for anon/authenticated — and only
--     for anon and authenticated; service_role RETAINS its grant, so the
--     (audit_table, service_role) pair is NOT allowlisted and is asserted
--     SELECT-true. These are the two current allowlist tables (4 role-keyed rows).
--
--   Category B — "has grant but RLS-unreachable" → OFF the allowlist.
--     public.username_resolve_rate_limit (spec 095) and public._edge_auth
--     (20260424211733) are RLS-enabled / no-permissive-policy, so
--     anon/authenticated cannot reach a single row over PostgREST. BUT they
--     still HOLD the broad SELECT grant — proven by
--     username_resolve_rate_limit.test.sql arm (6) returning 0 rows under
--     `set local role authenticated` instead of raising 42501 (a missing
--     grant would raise 42501). They are unreachable via *RLS*, a different
--     layer than the *grant* ("grant present != row-reachable"). They MUST
--     NOT be allowlisted — the probe asserts the grant IS present on them,
--     faithfully pinning the historical posture. Allowlisting them would
--     wrongly stop asserting their grant and let a future grant-strand on
--     them pass unnoticed.
--
-- The litmus test for an allowlist row: "does this table run
-- `REVOKE ... on <table> ... from {anon|authenticated}` at the GRANT
-- layer?" spec093_case_qty_backfill_audit and spec104_per_each_cost_audit both
-- answer yes. RLS-on-no-policy is NOT the test — that is Category B and stays
-- off the list. Add a row ONLY if a future migration deliberately REVOKEs a
-- table-level grant from a role, with a one-line justification in the same PR —
-- AND add a matching negative assertion (cf. arms 5/6/7).
--
-- Plan (13 assertions across 7 arms — arms (1)-(4) are 1 is() call each,
-- arms (5)-(7) are 3 ok() calls each: 1+1+1+1+3+3+3 = 13):
--   (1) positive — count of (table, role) pairs missing SELECT, minus the
--       role-keyed allowlist, is 0. (1 is() call.)
--   (2) positive — string_agg of the offending `public.<table> / <role>`
--       pairs (after the allowlist subtraction) is '' (log-readability). (1 is() call.)
--   (3) negative — a throwaway public table with SELECT REVOKEd from
--       `authenticated` IS caught by the same detection CTE
--       (drop-then-assert; count = 1). (1 is() call.)
--   (4) false-positive guard — a throwaway public table left with its
--       inherited grant intact is NOT flagged (count = 0). (1 is() call.)
--   (5) negative — profiles.TRUNCATE is FALSE for authenticated AND anon
--       (the arm that would have caught the original flaw), TRUE for
--       service_role. (3 ok() calls.)
--   (6) negative — spec093_case_qty_backfill_audit.SELECT is FALSE for
--       authenticated AND anon, TRUE for service_role. (3 ok() calls.)
--   (7) negative — spec104_per_each_cost_audit.SELECT is FALSE for
--       authenticated AND anon, TRUE for service_role (spec 104's audit table,
--       same Category-A `revoke all from anon, authenticated` posture). (3 ok() calls.)
--
-- ROLE: the probe runs as `postgres` (the scripts/test-db.sh connection
-- role). `has_table_privilege('<role>', ...)` queries the catalog for an
-- ARBITRARY role regardless of session role, so NO `set role` dance is
-- needed for the positive/negative arms — cleaner and crash-free (the same
-- reason reports_anon_revoke.test.sql switched off `set role` + `throws_ok`
-- to `has_function_privilege` after the CI segfault noted in that file).
--
-- HERMETIC ISOLATION: `begin; ... rollback;`. The synthetic arms (3)/(4)
-- create a throwaway table inside the outer transaction, capture the
-- detector's hit count into a session variable, then explicitly DROP the
-- synthetic table BEFORE running the pgTAP `is()` assertion. A
-- `savepoint + rollback to savepoint` after an `is()` inside the savepoint
-- would discard the assertion from pgTAP's temp-table counters and trip
-- scripts/test-db.sh's "planned N but ran M" silent-skip detector — hence
-- the drop-then-assert pattern (spec 053 arm 3).
--
-- SUBTLETY (inverse of spec 053 arm 3): a freshly created throwaway table
-- is owned by the test's current_user (postgres). The migration's
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` means the synthetic table is
-- BORN with the (no-TRUNCATE) grant for anon/authenticated and ALL for
-- service_role already attached. So arm 3 must explicitly REVOKE SELECT ...
-- FROM authenticated to manufacture the violation (spec 053 arm 3 ADDS a
-- wide policy; here we REMOVE a grant). Arm 4 leaves the inherited grant
-- intact to prove the detector does not false-flag a correctly-granted
-- table — which incidentally proves the §1b future-table default-privileges
-- inheritance actually fired (the durability mechanism this spec rests on).

begin;
create extension if not exists pgtap;

select plan(13);


-- ─── Detection CTE shape (reused across arms 1-4) ──────────────
--
-- The detection CTE is repeated at each arm's call site (pgTAP `is()`
-- requires a scalar subquery, and CTEs cannot persist across
-- statements) — the cost is duplicated lines, the benefit is each arm
-- reads as a standalone unit. It cross-joins every public base table
-- against the three roles and flags any (table, role) pair where
-- has_table_privilege(..., 'SELECT') is false. `format('%I.%I', ...)`
-- builds the privilege argument from the live schema-qualified table name.
--
-- The allowlist is a role-keyed VALUES list: the spec-093 AND spec-104 audit
-- tables for anon + authenticated (Category A, 4 rows). It is keyed
-- (schemaname, tablename, rolename) — NOT just table — so each table
-- is allowlisted for anon/authenticated while still asserted for
-- service_role. RLS-locked / no-policy tables (username_resolve_rate_limit,
-- _edge_auth) still receive the GRANT and are NOT listed here (Category B).


-- ─── Arm (1): missing-grant count under allowlist is 0 ─────────
select is(
  (
    with target_tables as (
      select schemaname, tablename
      from pg_tables
      where schemaname = 'public'
    ),
    target_roles (rolename) as (values ('anon'), ('authenticated'), ('service_role')),
    flagged as (
      select t.schemaname, t.tablename, r.rolename
      from target_tables t
      cross join target_roles r
      where not has_table_privilege(
        r.rolename,
        format('%I.%I', t.schemaname, t.tablename),
        'SELECT'
      )
    ),
    allowlist (schemaname, tablename, rolename) as (values
      ('public', 'spec093_case_qty_backfill_audit', 'anon'),
      ('public', 'spec093_case_qty_backfill_audit', 'authenticated'),
      -- Spec 104's audit table — same Category-A `revoke all from anon,
      -- authenticated` posture (20260701000000). Negative arm (7) asserts the
      -- lock actually holds for these two roles.
      ('public', 'spec104_per_each_cost_audit', 'anon'),
      ('public', 'spec104_per_each_cost_audit', 'authenticated')
      -- Category A only (a deliberate table-level REVOKE). RLS-locked tables
      -- (username_resolve_rate_limit, _edge_auth) HOLD the grant and are NOT
      -- listed (Category B). See header. Add a row + a matching negative
      -- assertion in the same PR for any future deliberate REVOKE.
    )
    select count(*)::int
    from flagged
    where (schemaname, tablename, rolename) not in (select * from allowlist)
  ),
  0,
  'arm (1): public_grants_explicit — every public base table grants SELECT to anon, authenticated, AND service_role (minus the 1-row role-keyed allowlist). ' ||
  'If this arm fails, the explicit-grant migration 20260618000000_public_grants_explicit.sql did not cover a table — most likely a NEW table whose ' ||
  '`ALTER DEFAULT PRIVILEGES FOR ROLE postgres` inheritance did not fire (created by a non-postgres role?). ' ||
  'Inspect arm (2) output for the exact `public.<table> / <role>` pairs, then either fix the grant inheritance or — if the omission is INTENTIONAL ' ||
  '(a deliberate table-level REVOKE) — add a role-keyed row to the allowlist VALUES list in supabase/tests/public_grants_explicit.test.sql (plus a ' ||
  'matching negative assertion like arms 5/6) with a one-line justification in the same PR. NOTE: RLS-locked tables (username_resolve_rate_limit, ' ||
  '_edge_auth) still HOLD the grant and are NOT allowlist entries. See CLAUDE.md ''CI status check after every push to main'' + spec 097.'
);


-- ─── Arm (2): string_agg of offending pairs is empty ───────────
-- Same detection CTE as arm (1); aggregates offenders into a single
-- string for log-readability. On a fail, the TAP output shows the exact
-- `public.<table> / <role>` pairs without a re-query.
select is(
  (
    with target_tables as (
      select schemaname, tablename
      from pg_tables
      where schemaname = 'public'
    ),
    target_roles (rolename) as (values ('anon'), ('authenticated'), ('service_role')),
    flagged as (
      select t.schemaname, t.tablename, r.rolename
      from target_tables t
      cross join target_roles r
      where not has_table_privilege(
        r.rolename,
        format('%I.%I', t.schemaname, t.tablename),
        'SELECT'
      )
    ),
    allowlist (schemaname, tablename, rolename) as (values
      ('public', 'spec093_case_qty_backfill_audit', 'anon'),
      ('public', 'spec093_case_qty_backfill_audit', 'authenticated'),
      ('public', 'spec104_per_each_cost_audit', 'anon'),
      ('public', 'spec104_per_each_cost_audit', 'authenticated')
    )
    select coalesce(
      string_agg(
        format('%s.%s / %s', schemaname, tablename, rolename),
        ', '
        order by schemaname, tablename, rolename
      ),
      ''
    )
    from flagged
    where (schemaname, tablename, rolename) not in (select * from allowlist)
  ),
  '',
  'arm (2): public_grants_explicit — offending (public.<table> / <role>) pairs list is empty. ' ||
  'If this arm fails the TAP output above includes the comma-separated pairs. The explicit-grant migration ' ||
  '20260618000000_public_grants_explicit.sql did not cover this table — check `ALTER DEFAULT PRIVILEGES` inheritance, ' ||
  'or add a role-keyed grant-allowlist row (+ a matching negative assertion) if the omission is intentional. See arm (1) remediation block.'
);


-- ─── Arm (3): throwaway table missing SELECT IS caught (regression
-- guard) ───────────────────────────────────────────────────────
-- Create a throwaway public table (born WITH the no-TRUNCATE grant for
-- anon/authenticated + ALL for service_role via the migration's ALTER
-- DEFAULT PRIVILEGES FOR ROLE postgres), REVOKE SELECT from authenticated
-- to manufacture a violation, run the same detection CTE scoped to that
-- table, capture the count into a session variable, DROP the synthetic
-- table, THEN run the pgTAP `is()`. If a future drive-by edit breaks the
-- detector (e.g. flips the `not`, mis-quotes the privilege), this arm
-- fails — the synthetic table is the only known-missing-grant table in the
-- test transaction, and the detector MUST trip on it.
--
-- EXPECTED COUNT = 1, NOT 3: the detection CTE scans all three roles, but
-- only `authenticated`'s SELECT is revoked here. `anon` retains SELECT from
-- the migration's ALTER DEFAULT PRIVILEGES inheritance and `service_role`
-- retains ALL, so exactly 1 of the 3 role checks reports a missing grant.
--
-- drop-then-assert (not savepoint+rollback): pgTAP's counters are temp
-- tables; a `rollback to savepoint` after an `is()` inside the savepoint
-- discards the assertion and trips scripts/test-db.sh's "planned N but
-- ran M" silent-skip detector. The synthetic table uses a
-- double-underscore prefix as a clear test-fixture marker, unique
-- against current + projected prod tables.
create table public.__grant_probe_negative_test (id uuid primary key);
revoke select on public.__grant_probe_negative_test from authenticated;

do $$
declare
  v_hit_count int;
begin
  with target_roles (rolename) as (values ('anon'), ('authenticated'), ('service_role'))
  select count(*)::int into v_hit_count
  from target_roles r
  where not has_table_privilege(
    r.rolename,
    'public.__grant_probe_negative_test',
    'SELECT'
  );

  perform set_config('test.grant_negative_hit_count', v_hit_count::text, true);
end $$;

-- Drop the synthetic table BEFORE the pgTAP assertion so the negative-arm
-- mutation is gone from the catalog by the time finish() runs. The outer
-- rollback would also clean it up; explicit drop keeps the arm scoped.
drop table public.__grant_probe_negative_test;

select is(
  current_setting('test.grant_negative_hit_count', true)::int,
  1,
  'arm (3): public_grants_explicit — a throwaway public table with SELECT REVOKEd from `authenticated` IS caught by the detection CTE (exactly 1 missing-grant pair — only `authenticated` is revoked; `anon` retains SELECT from ALTER DEFAULT PRIVILEGES and `service_role` retains ALL, so 1 of the 3 roles is flagged). ' ||
  'If this arm fails, the missing-grant detector (or the synthetic table setup) has regressed — inspect arms (1) + (2) and ensure the ' ||
  '`not has_table_privilege(..., ''SELECT'')` predicate is intact. See spec 097.'
);


-- ─── Arm (4): correctly-granted throwaway table is NOT flagged
-- (false-positive guard) ────────────────────────────────────────
-- Counterpart to arm (3): create a second throwaway public table and
-- leave its INHERITED grant intact (no REVOKE). The migration's
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres means it is born with SELECT
-- for all three roles, so the detector MUST NOT flag any (table, role)
-- pair. This guards against a future edit that makes the detector flag
-- correctly-granted tables (e.g. an inverted predicate), AND doubles as a
-- live proof that the default-privileges inheritance actually fires for a
-- postgres-owned table — the durability mechanism this whole spec rests on.
create table public.__grant_probe_positive_test (id uuid primary key);

do $$
declare
  v_hit_count int;
begin
  with target_roles (rolename) as (values ('anon'), ('authenticated'), ('service_role'))
  select count(*)::int into v_hit_count
  from target_roles r
  where not has_table_privilege(
    r.rolename,
    'public.__grant_probe_positive_test',
    'SELECT'
  );

  perform set_config('test.grant_positive_hit_count', v_hit_count::text, true);
end $$;

drop table public.__grant_probe_positive_test;

select is(
  current_setting('test.grant_positive_hit_count', true)::int,
  0,
  'arm (4): public_grants_explicit — a throwaway public table left with its inherited grant intact is NOT flagged (0 missing-grant pairs). ' ||
  'This both prevents detector false-positives AND proves the migration''s `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... GRANT` (SELECT for all ' ||
  'three roles) inheritance actually fires for a new postgres-owned table — the durability mechanism of spec 097. ' ||
  'If this arm fails, either the detector regressed OR the default-privileges grant is not being inherited (check migration 20260618000000).'
);


-- ─── Arm (5): profiles.TRUNCATE is locked for anon/authenticated ──
-- THE ARM THAT WOULD HAVE CAUGHT THE ORIGINAL FLAW. The migration's
-- anon/authenticated table grant OMITS TRUNCATE (it grants
-- select,insert,update,delete,references,trigger — NOT `GRANT ALL`),
-- preserving the spec-041 round-3 anti-escalation revoke
-- (20260517040000_auth_can_see_store_brand_scope.sql:305) AT THE SOURCE.
-- If the migration ever reverts to `GRANT ALL` for these roles, TRUNCATE
-- is re-granted and the spec-041 TRUNCATE+INSERT privilege-escalation
-- Critical re-opens — this arm goes red. service_role legitimately RETAINS
-- TRUNCATE (separate grant audience), asserted true for documentation of
-- the asymmetry. No synthetic table — has_table_privilege reads the live
-- catalog for an arbitrary role regardless of session role.
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
  'arm (5a): public_grants_explicit — `authenticated` does NOT hold TRUNCATE on public.profiles. ' ||
  'If this fails, the broad table grant in 20260618000000_public_grants_explicit.sql re-granted TRUNCATE to anon/authenticated — ' ||
  'it must use the explicit no-TRUNCATE privilege list (select,insert,update,delete,references,trigger), NOT `GRANT ALL`. ' ||
  'Re-opens the spec-041 round-3 TRUNCATE+INSERT escalation (20260517040000_auth_can_see_store_brand_scope.sql:305). See spec 097 §1a.'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'TRUNCATE'),
  'arm (5b): public_grants_explicit — `anon` does NOT hold TRUNCATE on public.profiles. ' ||
  'Same guard as 5a for the anon role. See 20260517040000_auth_can_see_store_brand_scope.sql:305 + spec 097 §1a.'
);
select ok(
  has_table_privilege('service_role', 'public.profiles', 'TRUNCATE'),
  'arm (5c): public_grants_explicit — `service_role` DOES retain TRUNCATE on public.profiles (separate grant audience; the spec-041 revoke ' ||
  'deliberately scoped only anon/authenticated). Documents the asymmetry; if this fails the service_role table grant lost its `GRANT ALL`.'
);


-- ─── Arm (6): spec093 audit table grant-locked for anon/authenticated ──
-- The migration's broad anon/authenticated table grant re-granted SELECT
-- on the audit table, then a targeted `revoke ... from anon, authenticated`
-- (emitted AFTER the broad grant) restored its deliberate spec-093 lock
-- (20260602120000_spec093_case_qty_backfill.sql:68). This arm asserts the
-- lock holds — it is the half that truly guards the re-lock REVOKE: the
-- allowlist (arm 1) merely STOPS the positive arm asserting the grant,
-- while THIS arm asserts the grant is actually ABSENT. Without it, a future
-- drive-by that drops the §1a re-lock REVOKE would slip past (the audit
-- table would still be on the allowlist, so the positive arm wouldn't flag
-- the re-opened grant). service_role keeps its grant (asserted true).
select ok(
  not has_table_privilege('authenticated', 'public.spec093_case_qty_backfill_audit', 'SELECT'),
  'arm (6a): public_grants_explicit — `authenticated` does NOT hold SELECT on public.spec093_case_qty_backfill_audit. ' ||
  'If this fails, the broad table grant re-opened the spec-093 audit table — the §1a `revoke ... from anon, authenticated` re-lock is ' ||
  'missing or was emitted BEFORE the broad grant (it must follow it). See 20260602120000_spec093_case_qty_backfill.sql:68 + spec 097 §1a.'
);
select ok(
  not has_table_privilege('anon', 'public.spec093_case_qty_backfill_audit', 'SELECT'),
  'arm (6b): public_grants_explicit — `anon` does NOT hold SELECT on public.spec093_case_qty_backfill_audit. ' ||
  'Same guard as 6a for the anon role. See 20260602120000_spec093_case_qty_backfill.sql:68 + spec 097 §1a.'
);
select ok(
  has_table_privilege('service_role', 'public.spec093_case_qty_backfill_audit', 'SELECT'),
  'arm (6c): public_grants_explicit — `service_role` DOES retain SELECT on public.spec093_case_qty_backfill_audit (spec 093 revoked only ' ||
  'anon/authenticated; service_role keeps its grant). Documents the asymmetry; if this fails the service_role table grant lost its `GRANT ALL`.'
);


-- ─── Arm (7): spec104 audit table grant-locked for anon/authenticated ──
-- Identical guard to arm (6) for the spec-104 per-each-cost audit table
-- (20260701000000_spec104_per_each_cost_basis.sql). The migration creates the
-- table then `revoke all on public.spec104_per_each_cost_audit from anon,
-- authenticated`, and (like spec 093) the broad grant migration's default-
-- privileges inheritance would otherwise re-grant SELECT — so this arm asserts
-- the deliberate lock actually holds for those two roles, while service_role
-- retains its grant. Without this arm, dropping the migration's revoke would
-- slip past the allowlisted positive arm unnoticed.
select ok(
  not has_table_privilege('authenticated', 'public.spec104_per_each_cost_audit', 'SELECT'),
  'arm (7a): public_grants_explicit — `authenticated` does NOT hold SELECT on public.spec104_per_each_cost_audit. ' ||
  'If this fails, the broad table grant re-opened the spec-104 audit table — the `revoke all ... from anon, authenticated` in ' ||
  '20260701000000_spec104_per_each_cost_basis.sql is missing or was emitted BEFORE the broad grant (it must follow it). See spec 097 §1a.'
);
select ok(
  not has_table_privilege('anon', 'public.spec104_per_each_cost_audit', 'SELECT'),
  'arm (7b): public_grants_explicit — `anon` does NOT hold SELECT on public.spec104_per_each_cost_audit. ' ||
  'Same guard as 7a for the anon role. See 20260701000000_spec104_per_each_cost_basis.sql + spec 097 §1a.'
);
select ok(
  has_table_privilege('service_role', 'public.spec104_per_each_cost_audit', 'SELECT'),
  'arm (7c): public_grants_explicit — `service_role` DOES retain SELECT on public.spec104_per_each_cost_audit (spec 104 revoked only ' ||
  'anon/authenticated; service_role keeps its grant). Documents the asymmetry; if this fails the service_role table grant lost its `GRANT ALL`.'
);


select * from finish();
rollback;
