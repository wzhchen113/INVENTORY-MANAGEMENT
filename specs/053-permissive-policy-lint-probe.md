# Spec 053: Permissive-policy lint probe (defense-in-depth pgTAP)

Status: READY_FOR_REVIEW

## User story
As the security-auditor (and as any reviewer of a future migration that
adds a new RLS policy in `public.*`), I want a pgTAP probe that fails the
CI build when a permissive policy lands whose USING (or WITH CHECK)
expression is trivially-wide — i.e. equivalent to `auth.uid() IS NOT
NULL`, `true`, or `auth.role() = 'authenticated'` — without being entered
on a hardcoded allowlist of intentional cross-brand reference-data
policies, so that the spec 041 → spec 051 OR-shadow class of bug
(legacy wide policy silently neutralizing a scoped policy on the same
`(table, command)` pair) cannot recur on a new table.

## Why now
Spec 041 added the brand-scoped `auth_can_see_store()` helper but the
legacy `auth_manage_stores` policy with `cmd=ALL` and `using (auth.uid()
IS NOT NULL)` shadowed it via Postgres' permissive-OR composition. The
leak was live in prod for 3+ days until a user (Bobby) reported seeing
Baltimore Seafood stores. Spec 051 closed the four known instances;
spec 053 closes the **class** of bug at CI time so the next migration
that introduces a wide policy fails-build instead of silently shipping.

CLAUDE.md's "Permissive RLS policies on the same `(table, command)` pair
are ORed" bullet ([CLAUDE.md:66](../CLAUDE.md)) ends with:
> "Forthcoming spec 053 will add a pgTAP CI probe to fail-build on any
> future permissive policy whose USING evaluates to `auth.uid() IS NOT
> NULL` (or trivially equivalent) without an explicit allow-list entry."
This spec fulfills that promise.

## Acceptance criteria
- [ ] A new pgTAP file lands at `supabase/tests/permissive_policy_lint.test.sql`.
- [ ] The file follows the hermetic `begin; create extension if not exists pgtap; select plan(N); ...; select * from finish(); rollback;` shape used by every existing test under `supabase/tests/`.
- [ ] The probe queries `pg_policies` (or equivalent catalog) for every **permissive** policy whose `schemaname = 'public'`.
- [ ] For each such policy, the probe detects whether its `qual` (USING) or `with_check` expression is "trivially-wide", matching the patterns listed in §"Detection patterns" below.
- [ ] When a trivially-wide policy is found, the probe checks the policy's `(schemaname, tablename, policyname)` triple against a hardcoded allowlist defined inline in the test file.
- [ ] If a trivially-wide policy is NOT on the allowlist, the test arm FAILS with a pgTAP assertion whose message names the policy and table (e.g. `'public.stores / auth_manage_stores has trivially-wide USING (auth.uid() IS NOT NULL) and is not on the spec 053 allowlist — see CLAUDE.md §Permissive-OR'`).
- [ ] If every trivially-wide policy in `public.*` IS on the allowlist, the probe passes.
- [ ] The allowlist initially contains exactly the two policies spec 051 documented as intentional cross-brand reference data:
  - `public.ingredient_categories` / `Authenticated can read ingredient categories` (spec 004 / 051)
  - `public.recipe_categories` / `Authenticated can read categories` (spec 013 / 051)
  - Plus any additional intentional entries the architect enumerates during design (see Open question Q-arch-1).
- [ ] The probe scope is `cmd IN ('SELECT','INSERT','UPDATE','DELETE','ALL')` — i.e. all commands (see Open question Q3 default).
- [ ] The probe scope is `permissive = true` only — restrictive policies are AND-combined and do not exhibit the OR-shadow footgun (see Open question Q4 default).
- [ ] The probe scope is `schemaname = 'public'` only — `auth.*`, `storage.*`, and extension schemas are Supabase-managed (see Open question Q6 default).
- [ ] Failure mode is hard-fail (the pgTAP run exits non-zero, CI breaks) — consistent with every other pgTAP test in `supabase/tests/` and with the `db-tests` job in [.github/workflows/test.yml](../.github/workflows/test.yml) (see Open question Q5 default).
- [ ] Running `bash scripts/test-db.sh` against the current main HEAD reports the new file as passing (the only trivially-wide policies in `public.*` today are the two `*_categories` SELECT policies, both on the initial allowlist).
- [ ] Adding a synthetic test migration that creates a new permissive policy with `using (auth.uid() IS NOT NULL)` on a non-allowlisted table causes `bash scripts/test-db.sh` to fail with a clear, actionable message naming the offending policy. (Architect to decide whether this "negative test" lives as a commented-out arm inside the same file, a second file, or only as a manual verification step — see Open question Q-arch-2.)

## Detection patterns
The probe should treat the following USING (or WITH CHECK) expression
shapes as "trivially-wide":

1. `auth.uid() IS NOT NULL` — the primary footgun (spec 051 root cause).
2. `(auth.uid() IS NOT NULL)` — same with outer parens (pg formatting normalizes both ways).
3. `true` — the most obvious case.
4. `auth.role() = 'authenticated'` — semantically equivalent.
5. `auth.uid() IS NOT NULL OR <anything>` — the OR-shadow case spec 051 closed on `user_stores` ([supabase/migrations/20260502071736_remote_schema.sql:462](../supabase/migrations/20260502071736_remote_schema.sql) shape).

The probe should **NOT** flag:
- `auth.uid() IS NOT NULL AND <scoped predicate>` — the wideness is gated by the AND.
- `<scoped predicate> AND auth.uid() IS NOT NULL` — same.
- `auth_can_see_store(id)`, `auth_can_see_brand(brand_id)`, `auth_is_admin()`, etc. — these are the scoped helpers and are by definition not trivially-wide.
- `using (true)` policies whose `roles` column is `{authenticated}` if they are on the allowlist — spec 051 explicitly rewrote `ingredient_categories` and `recipe_categories` SELECT policies as `using (true)` with a `to authenticated` role gate; the allowlist covers exactly these.

Architect picks the implementation strategy — see Open question Q1.

## In scope
- One new pgTAP file at `supabase/tests/permissive_policy_lint.test.sql`.
- An inline hardcoded allowlist of `(schema, table, policy_name)` triples inside that file.
- An optional one-line CLAUDE.md edit that flips the "Forthcoming spec 053..." sentence on [CLAUDE.md:66](../CLAUDE.md) to a "Spec 053 ([supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)) enforces..." past-tense closeout. Architect picks whether to bundle this into spec 053 or leave for a separate doc pass.
- Optional one-line entry in `tests/README.md` if the architect deems the probe warrants reviewer-facing documentation.

## Out of scope (explicitly)
- **No new migration.** This is pgTAP-only; the probe reads `pg_policies` and asserts. No schema change, no policy change, no helper change. Rationale: spec 051 already cleaned the four known instances; spec 053 is the CI gate that prevents recurrence.
- **No client / UI change.** Admin Cmd UI, edge functions, RPCs — none touched.
- **No edge function.** No new `verify_jwt` decision, no Resend template, no service-token bearer.
- **No probe for `restrictive` policies.** Restrictive policies are AND-combined; they cannot exhibit the OR-shadow footgun. A separate spec can revisit if a restrictive-policy footgun is ever identified. (See Open question Q4.)
- **No probe for non-`public.*` schemas.** `auth.*`, `storage.*`, `realtime.*`, and extension schemas are Supabase-managed; we don't author policies there and changing what Supabase ships is out of band. (See Open question Q6.)
- **No probe for non-permissive footguns** (e.g. policies that are correct on the predicate but mis-scoped on the `roles` column, or policies that grant `FOR ALL` when they should be `FOR SELECT`). Those are different bug classes and would warrant their own spec(s). Mentioned only so reviewers don't expand scope here.
- **No allowlist annotation via `COMMENT ON POLICY` for v1.** The hardcoded inline list is short, in-tree, and code-reviewed via the same PR that adds an exception. The comment-marker approach is a viable v2 if the allowlist ever grows past ~10 entries. (See Open question Q2.)
- **No retroactive audit of every existing policy** beyond the four spec 051 touched plus the two `*_categories` allowlist entries. The architect may, during design, enumerate additional intentional-wide policies they discover (e.g. on `flags`, `push_subscriptions`, etc.) and add them to the initial allowlist with a one-line justification each.
- **No CI job split.** The probe runs as part of the existing `db-tests` job in [.github/workflows/test.yml](../.github/workflows/test.yml); no new workflow file, no new GitHub Actions configuration.
- **No prod migration apply.** This is test-only.

## Open questions (PM-recommended defaults)

- **Q1: Detection strategy.** Walk the USING expression as text via `pg_policies.qual` and string-match? Parse via `pg_get_expr`? Or evaluate the expression for a synthetic caller-id+role context and check whether it returns `true` regardless of input?
  - Trade-off: text-match has false positives (`auth.uid() IS NOT NULL AND something_real` is fine and shouldn't trip) but is hermetic and inspectable. Execution-based detection is brittle and risks side effects via SECURITY DEFINER helpers. Parser-based detection (`regexp_replace` over normalized `qual`) is a middle ground.
  - **PM recommendation: text-match on `pg_policies.qual` with the five patterns listed in §"Detection patterns" above, AND-pattern explicitly excluded.** Specifically: a policy trips iff `qual` (normalized: lowercased, whitespace-collapsed) **starts with or is exactly** one of the trivially-wide patterns, OR matches `<trivially-wide> or <anything>` (the OR-shadow shape). A policy whose `qual` contains `and` anywhere does NOT trip even if it also mentions `auth.uid() is not null`. The architect refines the regex.
  - Architect to confirm or revise during design.

- **Q2: Allowlist mechanism.** Hardcoded inline list in the pgTAP file, vs. a `COMMENT ON POLICY <name> ON <table> IS 'intentional-wide-read: <reason>'` annotation marker the probe reads from `pg_policies` → `pg_description`, vs. a separate `public.permissive_policy_allowlist` config table?
  - **PM recommendation: hardcoded inline list in the pgTAP file.** The current allowlist size is 2; the projected v1 size is ≤ 5. An inline list keeps the exception PR-reviewable in a single diff and avoids a parallel allowlist artifact that can drift from the policy text. If the allowlist exceeds ~10 entries in the future, revisit via a v2 spec.
  - Architect to confirm.

- **Q3: Scope — which commands?** SELECT only, or all of SELECT/INSERT/UPDATE/DELETE/ALL?
  - Trade-off: the spec 051 categories rewrite was SELECT-only — but the spec 051 stores / user_stores leak was `cmd=ALL`, and WRITE policies are the catastrophic case (cross-brand INSERT, UPDATE, DELETE). Scoping the probe to SELECT only would leave the original Bobby attack surface uncovered for WRITE.
  - **PM recommendation: ALL commands (SELECT, INSERT, UPDATE, DELETE, ALL).** Higher coverage, no false-positive cost over SELECT-only because the allowlist mechanism handles intentional cases uniformly.
  - Architect to confirm.

- **Q4: Permissive only, or also restrictive?** Postgres distinguishes permissive (OR-combined) from restrictive (AND-combined) policies. The OR-shadow footgun applies to permissive only — a restrictive policy that's trivially-wide is a no-op tightening, not a leak.
  - **PM recommendation: permissive only.** A restrictive policy with `using (true)` is harmless (it AND-combines as identity); flagging it would be noise. If a restrictive-policy footgun is ever identified, a separate spec adds that probe.
  - Architect to confirm.

- **Q5: Failure mode — hard-fail or soft-warn?** Hard-fail breaks the build on unallowlisted wide policy. Soft-warn (pgTAP `diag()`) logs but does not break the build.
  - Trade-off: hard-fail is consistent with the rest of `supabase/tests/` (every test arm is a hard assertion); it forces every new wide policy to be explicitly allowlisted in the same PR. Soft-warn loosens the gate to advisory only — but then the probe is not really a "gate" and the spec 051 class of bug can ship again with a warning ignored in CI logs.
  - **PM recommendation: hard-fail.** The whole point of this spec is to prevent recurrence; advisory mode defeats it.
  - Architect to confirm.

- **Q6: Schemas in scope.** `public.*` only, or also `auth.*` / `storage.*` / extension schemas?
  - **PM recommendation: `public.*` only.** Supabase manages `auth.*` / `storage.*` / `realtime.*` / extension schemas; we don't author policies there and changing what Supabase ships is out of band. The probe explicitly filters `where schemaname = 'public'`.
  - Architect to confirm.

### Open questions for the architect (additional)
- **Q-arch-1: Initial allowlist enumeration.** Beyond the two `*_categories` SELECT policies spec 051 rewrote, are there other intentional cross-brand reference-data policies in `public.*` today that should land on the v1 allowlist? Architect to enumerate during design by running the probe against current main HEAD and listing any unexpected hits.
- **Q-arch-2: Negative-test shape.** Does the spec ship a "synthetic failing policy" arm (commented-out by default, or in a second file) to prove the probe FAILS when it should? Or is the negative path verified only by manual reviewer steps during PR review of spec 053? PM leans toward a small inline `do $$ ... rollback to savepoint ... $$` arm that creates a wide policy, runs the probe logic, asserts it trips, and rolls back to savepoint — but the architect has the final call on whether that complexity is worth it for v1.

## Project-specific notes
- **Cmd UI section / legacy:** none. No client surface touched.
- **Per-store or admin-global:** N/A — this is a database lint probe, not a feature.
- **Realtime channels touched:** none.
- **Migrations needed:** no. The probe reads `pg_policies`; no DDL change.
- **Edge functions touched:** none.
- **Web/native scope:** N/A.
- **Tests track:** pgTAP. New file lands in `supabase/tests/` alongside `legacy_permissive_policy_dropout.test.sql` ([supabase/tests/legacy_permissive_policy_dropout.test.sql](../supabase/tests/legacy_permissive_policy_dropout.test.sql)) and the `auth_can_see_store_brand_scope.test.sql` reference shape spec 051 mirrored.
- **app.json slug:** not touched.
- **CI surface:** the existing `db-tests` job in [.github/workflows/test.yml](../.github/workflows/test.yml) runs every `*.test.sql` under `supabase/tests/` via `scripts/test-db.sh`. The new file picks up automatically — no workflow edit.

## Dependencies
- Spec 041 ([supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)) — the helper this probe protects.
- Spec 051 ([supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)) — closed the four known instances; this spec is the CI gate so they don't reopen.
- Spec 022 / 024 / 047 — established the pgTAP test infrastructure that runs in CI ([.github/workflows/test.yml](../.github/workflows/test.yml), [scripts/test-db.sh](../scripts/test-db.sh)).
- CLAUDE.md "Permissive RLS policies..." bullet at [CLAUDE.md:66](../CLAUDE.md) — the rule this probe enforces.

## Reference shapes
- Test file conventions: [supabase/tests/auth_can_see_store_brand_scope.test.sql](../supabase/tests/auth_can_see_store_brand_scope.test.sql) and [supabase/tests/legacy_permissive_policy_dropout.test.sql](../supabase/tests/legacy_permissive_policy_dropout.test.sql).
- pgTAP runner: [scripts/test-db.sh](../scripts/test-db.sh).
- CI workflow: [.github/workflows/test.yml](../.github/workflows/test.yml) (`db-tests` job).

## Backend design

### Summary
DDL-free, single-file pgTAP probe at `supabase/tests/permissive_policy_lint.test.sql`. Scans `pg_policies` for permissive policies in `public.*` whose normalized `qual` text matches a trivially-wide shape and asserts the matching `(schemaname, tablename, policyname)` triple is on a hardcoded inline allowlist. Hard-fail in CI via the existing `db-tests` job — no workflow edits, no migration, no helper changes, no client touch.

### 1. Migration
**None.** Confirmed DDL-free. The probe is read-only against `pg_policies` (a catalog view). PM Q1-Q6 defaults and the in-scope AC together rule out any schema mutation. Carrying this forward as "no migration filename" in the AC list.

### 2. pgTAP file
- Path: `supabase/tests/permissive_policy_lint.test.sql` (architect adopts the spec-named path verbatim — sibling to `legacy_permissive_policy_dropout.test.sql`).
- Hermetic framing: `begin; create extension if not exists pgtap; select plan(N); ...; select * from finish(); rollback;` — same shape as every other file under `supabase/tests/`.
- No fixtures (no JWT-impersonation, no synthetic users, no foreign brand). The probe is a pure catalog scan that reads `pg_policies` under whatever role `scripts/test-db.sh` already invokes psql with (postgres). Catalog reads do not exercise RLS.
- Plan: see §7 for the exact count.

### 3. The detection query
Hardcoded text-match against a normalized `pg_policies.qual` (and `with_check`). The normalization step is critical: pg's `qual` formatter inserts/strips parentheses, varies whitespace, and lowercases inconsistently across versions. Normalize as:

```sql
-- pseudocode (NOT for inclusion in the committed file — developer authors)
lower(regexp_replace(coalesce(qual, '')          , '\s+', ' ', 'g'))
```

The "trivially-wide" shape, expressed as a single regex anchored at the start of the normalized predicate, is:

```
^\(*\s*(
    auth\.uid\(\) is not null
  | true
  | auth\.role\(\) = 'authenticated'
)\s*\)*(\s+or\s+.*)?\s*$
```

The regex semantics, walked through against the §"Detection patterns" list:

1. `auth.uid() IS NOT NULL` → matches branch 1, no trailing OR. **Flagged.**
2. `(auth.uid() IS NOT NULL)` → same with `\(*`/`\)*` consuming the outer parens. **Flagged.**
3. `true` → matches branch 2. **Flagged.**
4. `auth.role() = 'authenticated'` → matches branch 3. **Flagged.**
5. `auth.uid() IS NOT NULL OR <anything>` → matches branch 1 with trailing `OR .*$`. **Flagged.**

The "and" guard is implicit in the anchoring: any AND-form predicate (`auth.uid() IS NOT NULL AND <scoped>`) does NOT match because the `(\s+or\s+.*)?\s*$` arm requires either end-of-string or an OR-tail. An AND-tail has neither — the regex falls off after the trivially-wide token because the next chars are ` and ` not ` or ` and not `$`.

False-positive cases explicitly excluded:
- `auth.uid() IS NOT NULL AND auth_can_see_store(id)` → AND-tail, no match.
- `(user_id = auth.uid()) AND <anything>` → wrong head, no match.
- `auth_can_see_store(id)` / `auth_can_see_brand(brand_id)` / `auth_is_admin()` → not in the head allowlist, no match.
- `(id = auth.uid()) OR auth.uid() IS NOT NULL` → head is `(id = auth.uid())`, not a trivially-wide token. **NOT flagged at the head**, but the OR-tail dragon is here: a scoped head with a wide OR-tail is the exact spec 051 `user_stores` shape. **Architect decision: extend the regex to also match the inverse — a trivially-wide token in the OR-tail of any predicate.** A second pass scans for `\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = 'authenticated')\s*\)*` anywhere in the normalized text. The two regexes are OR-composed in the SQL (any match → flag).

Worked-example coverage on the four spec 051 shapes:
- `using ((auth.uid() IS NOT NULL))` on `stores.auth_manage_stores` → first regex matches branch 1 with parens. **Caught.**
- `using (((user_id = auth.uid()) OR (auth.uid() IS NOT NULL)))` on `user_stores."Users can manage own store links"` → second regex matches the OR-tail. **Caught.**
- `using ((((auth.jwt() -> 'app_metadata') ->> 'role') = ANY (ARRAY['admin'::text, 'master'::text])))` on `user_stores."Admins can manage all store links"` → neither regex matches (no trivially-wide token in head OR tail). **NOT caught by this probe.** This is correct per AC — the spec 051 admin policy is "wide on JWT role, narrow on no-brand-scope" which is a *different* class of footgun (brand-scope leak, not authed-bypass leak). The CLAUDE.md bullet for spec 051 already calls out that this probe targets the OR-shadow class specifically.
- `for select to authenticated using (true)` on the two `*_categories` SELECT policies → first regex matches branch 2. **Caught, but allowlisted (see §4).**

The SQL skeleton (architect signature — developer authors the literal file):

```sql
-- pseudocode — not committed verbatim
with normalized as (
  select
    schemaname, tablename, policyname, permissive, cmd, roles,
    lower(regexp_replace(coalesce(qual, '')        , '\s+', ' ', 'g')) as nq,
    lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g'))   as nc
  from pg_policies
  where schemaname = 'public'
    and permissive = 'PERMISSIVE'
),
flagged as (
  select schemaname, tablename, policyname, cmd, nq, nc
  from normalized
  where
    -- head-position trivially-wide
    nq ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
    or nc ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
    -- OR-tail trivially-wide (spec 051 user_stores shape)
    or nq ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*'
    or nc ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*'
)
select ... from flagged where (schemaname, tablename, policyname) not in (select * from allowlist) ...
```

Notes on `permissive = 'PERMISSIVE'` filter: `pg_policies.permissive` is a text column with values `'PERMISSIVE'` / `'RESTRICTIVE'`. Confirmed via Postgres 17 catalog docs and existing reads of `pg_policies` in `supabase/tests/legacy_permissive_policy_dropout.test.sql` (which inspects this same catalog implicitly). Restrictive policies are out of scope per PM Q4.

### 4. The allowlist

CTE (`with allowlist as (values ... )`) inside the test file. **Hardcoded triples**, no comment-marker reads, no config table — PM Q2 default.

#### Q-arch-1 enumeration (initial seed)

Architect grepped every migration for `create policy` declarations whose `using` or `with check` matches the trivially-wide shapes above, then traced through subsequent `drop policy if exists` chains to determine which are still live on current `main` HEAD. Procedure:

1. `grep -E 'auth\.uid\(\) is not null|using\s*\(\s*true\s*\)|auth\.role\(\) = ''authenticated''' supabase/migrations/*.sql` surfaced every historical wide policy declaration.
2. For each, traced forward through chronological migrations for a matching `drop policy if exists "<name>" on <table>` that was NOT followed by a re-create of the same wide shape.

Result — every wide policy declared at any point in the migration history:

| Migration | Table | Policy | Status as of main HEAD |
|---|---|---|---|
| `20260502071736_remote_schema.sql:273-512` | 18 different `*` tables | `auth_manage_*` (ALL) | Each dropped by a downstream migration. Spec 026 per-store hardening + spec 012a + spec 051 sweep finished the set. |
| `20260424211732_recover_undeclared_tables.sql:42` | `ingredient_categories` | `Authenticated can read ingredient categories` | Dropped + recreated as `using (true) to authenticated` by spec 051 `20260520010000` — **on allowlist**. |
| `20260424211733_security_fixes.sql:117` | `recipe_categories` | `Authenticated can read categories` | Dropped + recreated as `using (true) to authenticated` by spec 051 — **on allowlist**. |
| `20260424211732_recover_undeclared_tables.sql:74` | `ingredient_conversions` | `Authenticated can read ingredient conversions` | Dropped by spec 012a `20260509000000:847` → replaced with `brand_member_read_*` (scoped). Not live. |
| `20260507015244_spec004_ingredient_categories_rls_p6.sql:35` | `ingredient_categories` | `Authenticated can read ingredient categories` | Dropped + recreated by spec 051 as `using (true) to authenticated` — same allowlist row. |
| `20260504060452_brand_catalog_p1_additive.sql:82,97` | `brands`, `catalog_ingredients` | `auth_read_brands`, `auth_read_catalog_ingredients` | Both dropped by spec 012a `20260509000000:414,436` → replaced with `brand_member_read_*`. Not live. |
| `20260504073942_brand_catalog_p5_rls.sql:35,59,83,107,134,158,182` | `recipes`, `prep_recipes`, `recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`, `vendors`, `ingredient_conversions` | `auth_read_*` (SELECT) | All seven dropped by spec 012a `20260509000000` → replaced with `brand_member_read_*`. Not live. |
| `20260503000001_report_definitions.sql:26-30` | `report_definitions` | `authenticated can do anything` (`using (true) for all to authenticated`) | Dropped by spec 016 `20260510120000:140` → replaced with `store_member_*`. Not live. |
| `20260405000759_init_schema.sql:283` | `vendors` | `Vendors visible to all` (`for select using (true)`) | Dropped by spec 012a `20260509000000:563`. Not live. |
| `20260520010000_legacy_permissive_policy_dropout.sql:159,182` | `ingredient_categories`, `recipe_categories` | `Authenticated can read ingredient categories`, `Authenticated can read categories` | **Current** — `using (true) to authenticated`. Intentional cross-brand master data per spec 004 / spec 013. **On allowlist.** |

**Unexpected hits beyond the two `*_categories` SELECT policies:** none.

The grep-and-trace produced exactly the two policies PM seeded the allowlist with. Every other historical wide policy has been dropped or rewritten before main HEAD. The probe will pass on a fresh clean run.

**Initial allowlist (developer codes the literal values):**

```sql
-- pseudocode — developer authors
with allowlist (schemaname, tablename, policyname) as (values
  ('public', 'ingredient_categories', 'Authenticated can read ingredient categories'),
  ('public', 'recipe_categories',     'Authenticated can read categories')
)
```

**Shape for future additions** — a future spec adding a new intentional wide policy adds one row to the VALUES list in the same PR that creates the policy. The list stays short (≤5 projected per PM Q2) and is reviewer-visible in a single diff.

### 5. The assertion
Single `is(violation_count, 0, '<message>')` arm. The message constructed by aggregating the offending policy triples so a developer reading CI logs gets actionable failure context. Pattern:

```sql
-- pseudocode — developer authors
select is(
  (select count(*)::int from flagged
    where (schemaname, tablename, policyname) not in (select * from allowlist)),
  0,
  'permissive_policy_lint: trivially-wide policy detected without allowlist entry. ' ||
  'Run this query to see offenders: ' ||
  '`select schemaname, tablename, policyname, cmd, qual from pg_policies ' ||
  'where permissive = ''PERMISSIVE'' and schemaname = ''public'' and (lower(qual) ~ ...)`. ' ||
  'Action: (a) drop the policy if unused, (b) narrow the predicate to a scoped helper ' ||
  '(auth_can_see_store / auth_can_see_brand / auth_is_admin), or (c) add the policy to the ' ||
  'allowlist in supabase/tests/permissive_policy_lint.test.sql with a comment-justification. ' ||
  'See CLAUDE.md §"Permissive RLS policies on the same (table, command) pair are ORed" + spec 053.'
);
```

The developer is free to fold the message into a single line; the contract is that the failure message names the relevant query, the three remediation options (drop / narrow / allowlist), and points to CLAUDE.md + spec 053.

A second `is(violation_count_table, '', '<message>')` arm (over a `string_agg`) is RECOMMENDED so the actual offending triples appear in the TAP output without requiring the developer to re-run the underlying query manually. Architect-discretion — developer can collapse to a single arm if the `is()` message becomes hard to read.

### 6. Negative-test arm — Q-arch-2

**Decision: include the negative arm.** Three reasons:

1. Without it, a future drive-by edit that breaks the regex (e.g. swapping `^` for `^\s*\(?` and forgetting a parenthesis) silently neutralizes the probe and the suite stays green forever. The positive arm catches no current violations because there are none to catch — it cannot detect its own regression.
2. The hermetic transaction framing makes the negative arm cheap: `savepoint`, create a synthetic table with a wide policy, run the same detection CTE against `pg_policies`, assert `count > 0`, `rollback to savepoint`. Total cost ≈ 5 extra SQL statements.
3. The same shape is already in the codebase for trigger probes — `legacy_permissive_policy_dropout.test.sql` arm (5)'s `do $$ ... bool_and ... $$` block uses the same savepoint-style scoped mutation pattern.

Shape (architect signature — developer authors):

```sql
-- pseudocode
savepoint negative_arm;

create table public.__lint_probe_negative_test (id uuid primary key);
alter table public.__lint_probe_negative_test enable row level security;
create policy "__lint_probe_negative_wide"
  on public.__lint_probe_negative_test
  for select to authenticated
  using (auth.uid() is not null);

-- Re-run the detection CTE; expect 1 hit for __lint_probe_negative_test
-- (not on the allowlist, head-position trivially-wide).
select is(
  (select count(*)::int from <detection_cte>
    where tablename = '__lint_probe_negative_test'),
  1,
  'negative arm: synthetic wide policy is detected by the probe'
);

rollback to savepoint negative_arm;
```

**Why a savepoint, not a separate file:** the negative arm reads the same detection CTE as the positive arm. Keeping them in one file makes the regex-and-allowlist contract a single unit of code review.

**Why a synthetic table inside `public`, not `__lint_probe_test_schema`:** PM Q6 default is `public.*` only, so testing in another schema would not exercise the same code path. The synthetic table name `__lint_probe_negative_test` is unique enough to never collide with prod tables (double-underscore prefix is a clear test-fixture marker).

### 7. Plan count
Architect-prescribed:

- Arm 1: positive — count violations under allowlist (`is(0)` assertion).
- Arm 2: positive — `string_agg` of offending triples for log-readability (`is('')` assertion).
- Arm 3: negative — synthetic wide policy is caught (`is(1)` assertion).

**`plan(3)`.** Developer is permitted to collapse arms 1+2 into a single arm if doing so improves the failure message; in that case `plan(2)`. Developer is NOT permitted to drop arm 3 (the negative arm is the regex-regression guard).

### 8. CLAUDE.md edit
Architect-discretion per PM. The "Forthcoming spec 053..." sentence on [CLAUDE.md:66](../CLAUDE.md) becomes past-tense in the same PR. Proposed replacement, byte-exact:

**Before** (current trailing sentence of the bullet):
> "Forthcoming spec 053 will add a pgTAP CI probe to fail-build on any future permissive policy whose USING evaluates to `auth.uid() IS NOT NULL` (or trivially equivalent) without an explicit allow-list entry."

**After:**
> "Spec 053 ([supabase/tests/permissive_policy_lint.test.sql](supabase/tests/permissive_policy_lint.test.sql)) enforces this via a pgTAP CI probe that fail-builds on any future permissive policy in `public.*` whose USING or WITH CHECK is trivially-wide (`auth.uid() IS NOT NULL`, `true`, `auth.role() = 'authenticated'`, or those tokens in an OR-tail) without an explicit allowlist entry. The allowlist seeds the two `*_categories` SELECT policies above; a future intentional cross-brand wide policy adds one row to the VALUES list in the same PR."

Update lands in the same PR as the probe.

### 9. RLS impact
None. The probe reads `pg_policies` (a catalog view) which does not have RLS itself, and asserts on policy *shape*. It does not exercise the policies under test against any role — the test runs under the same `psql -U postgres` invocation `scripts/test-db.sh` already uses, which bypasses RLS entirely.

If a future enhancement wants to verify the policy actually does what the regex says it does (execution-based detection), that's a separate spec — PM Q1 explicitly chose text-match over execution to keep the probe hermetic and free of side-effects.

### 10. API contract
None. No PostgREST endpoint, no RPC, no edge function. Pure pgTAP file.

### 11. Edge function changes
None. PM marked "out of scope (explicitly)" and architect confirms.

### 12. `src/lib/db.ts` surface
**None changed.** No client touch. No new helper, no new mapper.

### 13. Realtime impact
None. The probe is a static catalog scan; nothing in `supabase_realtime` publication membership changes. No `docker restart supabase_realtime_imr-inventory` ritual required.

### 14. Frontend store impact
None. No `src/store/useStore.ts` slice change.

### 15. Risks and tradeoffs

#### 15a. Risk: local stack vs. prod policy drift

**The probe is only as load-bearing as the alignment between local migration history and prod schema.** Per CLAUDE.md §"CI workflow" and §"Prod schema mirrored locally": the `db-migrations-applied.yml` gate was never landed, so CI does not verify that every migration has been applied to prod. If a future operator runs ad-hoc `create policy ... using (auth.uid() is not null)` in the prod SQL editor *without* a corresponding migration file, the probe will pass locally + in CI but the wide policy lives in prod undetected.

**Recommended note in the test file's header comment:**

> "Known limitation: this probe scans `pg_policies` against the local + CI database, which reflects only the policies declared in `supabase/migrations/`. A wide policy applied directly to prod via the Supabase dashboard SQL editor — without a corresponding migration file — would not be caught here. Closing that gap requires the `db-migrations-applied.yml` CI workflow (referenced in [README.md](../../README.md) but not yet landed per CLAUDE.md §'CI workflow'). Until that gate exists, treat this probe as catching the migration-file class of leak only."

This is honest about the probe's scope and mirrors the same caveat that already lives in CLAUDE.md.

#### 15b. Risk: regex false-positives

A future legitimate policy with the shape `using ((something OR auth.uid() is not null AND other_thing))` might trip the OR-tail regex (which scans for `\bor\s+\(*\s*auth.uid()...`). Mitigation: the allowlist exception is one-line in the same PR. Developer adding such a policy will see the CI failure, read the failure message, and either narrow the predicate or allowlist.

The 9 historical wide policies that already exist in past migrations are all dropped — none currently match the regex except the two `*_categories` policies on the seed allowlist. Architect verified via the §4 trace.

#### 15c. Risk: regex precision

Postgres' `qual` formatter is version-stable enough for this approach (Postgres 17 in prod and local). If a future Postgres major changes the canonical formatting (e.g. injects extra parens, changes lowercasing), the normalization step (`lower + regexp_replace(\s+, ' ')`) absorbs whitespace + case drift; only structural reformatting (e.g. infix → prefix) would break the regex. That's a Postgres-bump-time concern, not a daily-coding concern.

The negative arm (§6) explicitly guards against this: any drift that breaks the regex on the canonical `auth.uid() IS NOT NULL` shape fails the negative arm in CI.

#### 15d. Risk: performance

`pg_policies` is a tiny view (≈100 rows on this codebase). The probe is O(rows × regex) on local + CI start. Cost is negligible (milliseconds) — not a CI bottleneck.

#### 15e. Tradeoff: text-match vs. execution-based detection

PM Q1 picked text-match. Architect agrees. Execution-based detection (impersonate a synthetic caller and assert the policy returns true for any input) is theoretically more precise but introduces side-effects (SECURITY DEFINER helpers like `auth_is_super_admin()` would run as the function owner regardless of caller context, and any logging or audit triggers under those helpers would fire). Text-match is hermetic, inspectable in the same file, and the regex coverage is provably exhaustive for the documented patterns.

#### 15f. Tradeoff: hardcoded allowlist vs. COMMENT ON POLICY marker

PM Q2 picked hardcoded inline. Architect agrees. The COMMENT ON POLICY marker pattern (probe reads `pg_description` for `'intentional-wide-read: <reason>'`) would push the exception *out* of the test file and into the migration that creates the policy — appealing but loses the "exception is reviewed alongside the test that enforces it" property. For an allowlist projected to ≤5 entries, inline is cleaner. Revisit if the allowlist grows past ~10.

### 16. Files touched (deliverable for the developer)

- `supabase/tests/permissive_policy_lint.test.sql` (NEW) — the probe.
- `CLAUDE.md` (EDIT) — one-sentence past-tense closeout of the "forthcoming spec 053" line. Byte-exact replacement text in §8 above.

No other files. No migration. No client. No edge function. No `src/store/useStore.ts`. No `src/lib/db.ts`. No `tests/README.md` (the probe is self-explanatory from its header comment; per PM the README update is optional — architect skips for v1).

### 17. Acceptance verification (architect's mental checklist for the reviewer fan-out)

- AC bullet "Running `bash scripts/test-db.sh` against the current main HEAD reports the new file as passing" — verified by §4 enumeration: only the two `*_categories` policies are flagged, both on the seed allowlist.
- AC bullet "Adding a synthetic test migration that creates a new permissive policy with `using (auth.uid() IS NOT NULL)` on a non-allowlisted table causes `bash scripts/test-db.sh` to fail" — covered by the negative arm (§6) inline in the same file, not a second file. PM Q-arch-2 default-chosen.
- AC bullet "The probe scope is `cmd IN ('SELECT','INSERT','UPDATE','DELETE','ALL')`" — the SQL filters do not constrain on `cmd`, so all five values are covered.
- AC bullet "The probe scope is `permissive = true` only" — explicit `where permissive = 'PERMISSIVE'`.
- AC bullet "The probe scope is `schemaname = 'public'` only" — explicit `where schemaname = 'public'`.
- AC bullet "Failure mode is hard-fail" — pgTAP `is()` returns `not ok` on a non-zero violation count, which `scripts/test-db.sh:110-116` detects and exits non-zero.

## Handoff
next_agent: backend-developer
prompt: Implement spec 053 against the design appended to the spec. Single deliverable file at
  `supabase/tests/permissive_policy_lint.test.sql` (plan(3) — positive count, positive
  string_agg, negative synthetic-policy arm — collapse to plan(2) if you fold the
  two positive arms together; do NOT drop the negative arm). The hardcoded allowlist
  is a 2-row VALUES CTE seeded per §4. The CLAUDE.md edit is the byte-exact past-tense
  replacement in §8. No migration, no edge function, no client touch. After implementation,
  run `bash scripts/test-db.sh supabase/tests/permissive_policy_lint.test.sql` against
  a local `npm run dev:db` stack and confirm all arms pass; then set
  `Status: READY_FOR_REVIEW` and list the two changed files under `## Files changed`.
payload_paths:
  - specs/053-permissive-policy-lint-probe.md

## Files changed

### pgTAP tests
- `supabase/tests/permissive_policy_lint.test.sql` (NEW) — the probe. `plan(3)` per §7: arm (1) positive count under allowlist, arm (2) positive string_agg of offending triples, arm (3) negative regex-regression guard (synthetic wide policy MUST be caught). Hardcoded 2-row VALUES allowlist matches §4 verbatim. Detection regex is the two-pass head + OR-tail shape from §6.

### Project memory
- `CLAUDE.md` — single-sentence past-tense closeout of the "Forthcoming spec 053..." trailing sentence on the "Permissive RLS policies..." bullet, replacement text verbatim from spec §8.

### Implementation notes
- Arm (3) uses a drop-then-assert pattern (create synthetic policy → stash detector count into `set_config()` → drop policy + table → `is()` against the stashed count) instead of `savepoint + rollback to savepoint`. Rationale: pgTAP's internal counters live in temp tables that get rolled back along with the savepoint, causing `finish()` to report `# Looks like you planned 3 tests but ran 2` — exactly the silent-skip mode `scripts/test-db.sh:122-127` catches. The drop-then-assert pattern keeps the negative-arm mutation hermetic without losing the assertion count. This is a documented deviation from §6's literal savepoint pseudocode but preserves the contract: the synthetic policy is created, exercised against the detection CTE, and gone before `finish()` runs.

### Verification
- `bash scripts/test-db.sh supabase/tests/permissive_policy_lint.test.sql` → 3/3 assertions pass.
- `bash scripts/test-db.sh` → 32/32 files pass (was 31, now 32).
- `npx tsc --noEmit` → clean (no TS surface touched).
