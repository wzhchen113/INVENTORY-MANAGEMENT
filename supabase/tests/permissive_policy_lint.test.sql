-- supabase/tests/permissive_policy_lint.test.sql
--
-- Spec 053 / defense-in-depth pgTAP lint probe for the OR-shadow
-- footgun class of bug that spec 051 closed on
-- supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql.
--
-- Scans pg_policies for every PERMISSIVE policy in public.* whose
-- normalized USING (qual) or WITH CHECK (with_check) text matches
-- a "trivially-wide" shape — i.e. is OR-equivalent to admitting
-- any authenticated caller. Such a policy ORed alongside a scoped
-- permissive policy on the same (table, command) pair shadows the
-- scoped policy because Postgres composes permissive policies via
-- OR. This is exactly how the Bobby cross-brand-stores leak (spec
-- 041 → 051) shipped to prod.
--
-- The probe asserts that every trivially-wide policy is on a
-- hardcoded inline allowlist. The seed allowlist contains the two
-- *_categories SELECT policies spec 051 intentionally rewrote as
-- `using (true) to authenticated` (cross-brand reference data per
-- spec 004 / spec 013).
--
-- Plan (3 arms):
--   (1) positive — violation count under allowlist is 0.
--   (2) positive — string_agg of offending triples is empty (for
--       log-readability in CI on a fail).
--   (3) negative — synthetic wide policy on a throwaway table
--       inside a savepoint IS caught by the same detection CTE.
--       This is the regex-regression guard: if a future drive-by
--       edit breaks the regex (e.g. a missing parenthesis or a
--       lost anchor), arm (3) fails because the synthetic policy
--       no longer trips the detector.
--
-- Detection regex (head + OR-tail, two passes — see spec 053 §6):
--   - Head: `^\s*\(*\s*(auth.uid() is not null | true |
--           auth.role() = 'authenticated')\s*\)*(\s+or\s+.*)?\s*$`
--     Matches a predicate whose head token is trivially-wide,
--     optionally followed by `OR <anything>` (the spec 051
--     user_stores OR-tail shape). An AND-tail does NOT match
--     because the trailing `(\s+or\s+.*)?\s*$` group is anchored
--     and requires either OR or end-of-string.
--   - OR-tail: `\bor\s+\(*\s*(auth.uid() is not null | true |
--             auth.role() = 'authenticated')\s*\)*`
--     Matches a trivially-wide token in the OR-tail of any
--     predicate. Catches `(user_id = auth.uid()) OR (auth.uid()
--     IS NOT NULL)` — the spec 051 `user_stores` "Users can
--     manage own store links" shape.
--
-- Normalization: lower(regexp_replace(qual, '\s+', ' ', 'g'))
-- absorbs whitespace + case drift. Postgres' qual formatter is
-- version-stable enough that structural reformatting (infix →
-- prefix, etc.) is the only failure mode; arm (3) guards against
-- that by re-running the detection CTE on a known-wide synthetic
-- policy.
--
-- Hermetic isolation: `begin; ... rollback;`. The negative arm
-- mutates schema (creates a table, enables RLS, declares a wide
-- policy) inside the outer transaction, captures the detector's
-- hit count into a session variable, then explicitly drops the
-- synthetic table + policy BEFORE running the pgTAP `is()`
-- assertion on the stashed value. The outer rollback also cleans
-- the schema; the explicit drop keeps the negative arm visibly
-- scoped. A `savepoint + rollback to savepoint` after an `is()`
-- inside the savepoint would discard the assertion from pgTAP's
-- temp-table counters and trip `scripts/test-db.sh`'s
-- "planned N tests but ran M" silent-skip detector — hence the
-- drop-then-assert pattern.
--
-- Known limitation: this probe scans pg_policies against the
-- local + CI database, which reflects only the policies declared
-- in supabase/migrations/. A wide policy applied directly to prod
-- via the Supabase dashboard SQL editor — without a corresponding
-- migration file — would not be caught here. Closing that gap
-- requires the db-migrations-applied.yml CI workflow (referenced
-- in README.md but not yet landed per CLAUDE.md §"CI workflow").
-- Until that gate exists, treat this probe as catching the
-- migration-file class of leak only.

begin;
create extension if not exists pgtap;

select plan(4);


-- ─── Allowlist + detection CTE shape (reusable across arms) ─────
--
-- The detection CTE shape is repeated in arms (1)+(2) and arm (3).
-- We declare it inline at each call site (pgTAP `is()` requires a
-- scalar subquery, and CTEs cannot persist across statements) —
-- the cost is ~20 duplicated lines, the benefit is each arm reads
-- as a standalone unit.
--
-- The allowlist is a 2-row VALUES literal. Add a row here in the
-- same PR that introduces a new intentional cross-brand wide
-- policy; the PR reviewer sees the allowlist exception and the
-- policy text side-by-side.


-- ─── Arm (1): violation count under allowlist is 0 ──────────────
-- Head-position trivially-wide OR OR-tail trivially-wide, in
-- either USING or WITH CHECK, minus the allowlist. Every flagged
-- triple must be on the allowlist.
select is(
  (
    with normalized as (
      select
        schemaname, tablename, policyname,
        lower(regexp_replace(coalesce(qual, ''),       '\s+', ' ', 'g')) as nq,
        lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g')) as nc
      from pg_policies
      where schemaname = 'public'
        and permissive = 'PERMISSIVE'
    ),
    flagged as (
      select schemaname, tablename, policyname
      from normalized
      where
        -- head-position trivially-wide on USING or WITH CHECK
        nq ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        or nc ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        -- OR-tail trivially-wide on USING or WITH CHECK
        or nq ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
        or nc ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
    ),
    allowlist (schemaname, tablename, policyname) as (values
      ('public', 'ingredient_categories', 'Authenticated can read ingredient categories'),
      ('public', 'recipe_categories',     'Authenticated can read categories')
    )
    select count(*)::int
    from flagged
    where (schemaname, tablename, policyname) not in (select * from allowlist)
  ),
  0,
  'arm (1): permissive_policy_lint — every trivially-wide permissive policy in public.* is on the spec 053 allowlist. ' ||
  'If this arm fails, run: `select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies ' ||
  'where permissive = ''PERMISSIVE'' and schemaname = ''public'';` then inspect arm (2) output for the offending triples. ' ||
  'Remediation options: (a) drop the policy if unused; (b) narrow the predicate to a scoped helper ' ||
  '(auth_can_see_store / auth_can_see_brand / auth_is_admin / auth_is_privileged); ' ||
  '(c) if the policy is an intentional cross-brand reference-data read, add a row to the allowlist VALUES list in ' ||
  'supabase/tests/permissive_policy_lint.test.sql with a one-line justification in the same PR that creates the policy. ' ||
  'See CLAUDE.md §"Permissive RLS policies on the same (table, command) pair are ORed" + spec 053.'
);


-- ─── Arm (2): string_agg of offending triples is empty ─────────
-- Same detection CTE as arm (1); aggregates the offenders into a
-- single string for log-readability. On a fail, the TAP output
-- shows the exact `public.<table> / <policy>` triples without
-- requiring the developer to re-run the underlying query.
select is(
  (
    with normalized as (
      select
        schemaname, tablename, policyname,
        lower(regexp_replace(coalesce(qual, ''),       '\s+', ' ', 'g')) as nq,
        lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g')) as nc
      from pg_policies
      where schemaname = 'public'
        and permissive = 'PERMISSIVE'
    ),
    flagged as (
      select schemaname, tablename, policyname
      from normalized
      where
        nq ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        or nc ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        or nq ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
        or nc ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
    ),
    allowlist (schemaname, tablename, policyname) as (values
      ('public', 'ingredient_categories', 'Authenticated can read ingredient categories'),
      ('public', 'recipe_categories',     'Authenticated can read categories')
    )
    select coalesce(
      string_agg(
        format('%s.%s / %s', schemaname, tablename, policyname),
        ', '
        order by schemaname, tablename, policyname
      ),
      ''
    )
    from flagged
    where (schemaname, tablename, policyname) not in (select * from allowlist)
  ),
  '',
  'arm (2): permissive_policy_lint — offending (schema.table / policy) triples list is empty. ' ||
  'If this arm fails the TAP output above includes the comma-separated triples. ' ||
  'See arm (1) remediation block for actions.'
);


-- ─── Arm (3): synthetic wide policy IS caught (regex regression
-- guard) ───────────────────────────────────────────────────────
-- Create a throwaway table in public, enable RLS, declare a
-- permissive SELECT policy with `using (auth.uid() is not null)`,
-- run the same detection CTE, capture the count into a session
-- variable, drop the synthetic table + policy, THEN run the
-- pgTAP `is()` assertion on the stashed count. If a future
-- drive-by edit breaks the regex (e.g. an accidental `^^` or a
-- removed paren group), this arm fails — the synthetic policy is
-- the only known-wide policy outside the allowlist in the test
-- transaction, and the detector MUST trip on it.
--
-- Why drop-then-assert instead of savepoint+rollback: pgTAP's
-- internal counters (`__tcache__`, `__tresults__`) are PostgreSQL
-- temp tables. A `rollback to savepoint` after an `is()` inside
-- the savepoint discards the assertion from the counters and
-- pgTAP's `finish()` reports `# Looks like you planned 3 tests
-- but ran 2` — exactly the silent-skip mode `scripts/test-db.sh`
-- explicitly catches. The alternative (`do $$ ... drop ... $$;
-- then is()`) keeps the synthetic policy creation hermetic
-- without losing the assertion count. The synthetic table and
-- policy are explicitly dropped before the `is()` so they do not
-- leak into arms below (currently none, but future-proofing).
--
-- The synthetic table name `__lint_probe_negative_test` uses a
-- double-underscore prefix as a clear test-fixture marker; it is
-- unique against current and projected prod tables.
create table public.__lint_probe_negative_test (id uuid primary key);
alter table public.__lint_probe_negative_test enable row level security;
create policy "__lint_probe_negative_wide"
  on public.__lint_probe_negative_test
  for select
  to authenticated
  using (auth.uid() is not null);

-- Compute the detector count against the live catalog (which now
-- includes the synthetic table's wide policy) and stash for the
-- post-cleanup assertion.
do $$
declare
  v_hit_count int;
begin
  with normalized as (
    select
      schemaname, tablename, policyname,
      lower(regexp_replace(coalesce(qual, ''),       '\s+', ' ', 'g')) as nq,
      lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g')) as nc
    from pg_policies
    where schemaname = 'public'
      and permissive = 'PERMISSIVE'
  ),
  flagged as (
    select schemaname, tablename, policyname
    from normalized
    where
      nq ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
      or nc ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
      or nq ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
      or nc ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
  )
  select count(*)::int into v_hit_count
  from flagged
  where tablename = '__lint_probe_negative_test';

  perform set_config('test.negative_arm_hit_count', v_hit_count::text, true);
end $$;

-- Drop the synthetic policy + table BEFORE the pgTAP assertion so
-- the negative-arm mutation is gone from the catalog by the time
-- `finish()` runs. The outer `rollback;` would also clean these
-- up, but explicit drop keeps the negative arm visibly scoped.
drop policy "__lint_probe_negative_wide" on public.__lint_probe_negative_test;
drop table public.__lint_probe_negative_test;

select is(
  current_setting('test.negative_arm_hit_count', true)::int,
  1,
  'arm (3): permissive_policy_lint — synthetic wide policy (using (auth.uid() is not null)) on a throwaway table IS caught by the detection CTE. ' ||
  'If this arm fails, the head-position regex (or synthetic-policy creation) has regressed — inspect arms (1) + (2) and ensure the regex is intact. ' ||
  'See CLAUDE.md §"Permissive RLS policies on the same (table, command) pair are ORed" + spec 053 §6.'
);


-- ─── Arm (4): AND-guarded OR-arm must NOT trip (false-positive
-- guard) ───────────────────────────────────────────────────────
-- Counterpart to arm (3): create a synthetic policy whose OR-arm
-- is AND-guarded (`(user_id = auth.uid()) OR (auth.uid() IS NOT
-- NULL AND auth_is_admin())`). This is a LEGITIMATE narrowed
-- predicate — the AND-guard means the OR-arm is not trivially
-- wide. The detector MUST NOT flag it.
--
-- This is the regression guard for the OR-tail regex's negative-
-- lookahead `(?!\s+and\b)`. If a future drive-by edit removes the
-- lookahead, this arm fails. Without this arm, the probe would
-- silently false-fail on a legitimate AND-guarded OR-arm policy
-- in CI for the next developer who tries to land that shape.
create table public.__lint_probe_negative_test_and_guarded (id uuid primary key);
alter table public.__lint_probe_negative_test_and_guarded enable row level security;
create policy "__lint_probe_negative_and_guarded"
  on public.__lint_probe_negative_test_and_guarded
  for select
  to authenticated
  using ((id = auth.uid()) or (auth.uid() is not null and public.auth_is_admin()));

do $$
declare
  v_hit_count int;
begin
  with normalized as (
    select
      schemaname, tablename, policyname,
      lower(regexp_replace(coalesce(qual, ''),       '\s+', ' ', 'g')) as nq,
      lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g')) as nc
    from pg_policies
    where schemaname = 'public'
      and permissive = 'PERMISSIVE'
  ),
  flagged as (
    select schemaname, tablename, policyname
    from normalized
    where
      nq ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
      or nc ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
      or nq ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
      or nc ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)'
  )
  select count(*)::int into v_hit_count
  from flagged
  where tablename = '__lint_probe_negative_test_and_guarded';

  perform set_config('test.and_guarded_arm_hit_count', v_hit_count::text, true);
end $$;

drop policy "__lint_probe_negative_and_guarded" on public.__lint_probe_negative_test_and_guarded;
drop table public.__lint_probe_negative_test_and_guarded;

select is(
  current_setting('test.and_guarded_arm_hit_count', true)::int,
  0,
  'arm (4): permissive_policy_lint — AND-guarded OR-arm (`OR (auth.uid() IS NOT NULL AND auth_is_admin())`) is NOT flagged by the detection CTE. ' ||
  'If this arm fails, the OR-tail regex''s AND-guard exclusion (negative-lookahead `(?!\\s+and\\b)`) has regressed. ' ||
  'Restoring the lookahead unblocks legitimate AND-guarded OR-arm policies. See spec 053 §6.'
);


select * from finish();
rollback;
