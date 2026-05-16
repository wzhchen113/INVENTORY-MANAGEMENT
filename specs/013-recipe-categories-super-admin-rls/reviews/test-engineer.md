## Test report for spec 013

_Re-review on the amended spec (AC9 text updated at spec line 34 to defer UI probe; prior Critical cleared if AC9 deferral is acceptable per CLAUDE.md policy)._

### Acceptance criteria status

- AC1: New migration at `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` drops `"Admins can write categories"` and recreates it with `using (public.auth_is_privileged())` and `with check (public.auth_is_privileged())` → PASS — File confirmed at lines 22-27: `drop policy if exists "Admins can write categories" on public.recipe_categories` followed by `create policy "Admins can write categories" on public.recipe_categories for all using (public.auth_is_privileged()) with check (public.auth_is_privileged())`. Live policy dump on the running DB confirms the policy is active: `pg_policy` shows `polcmd='*'` (FOR ALL) with funcid 19502 for both USING and WITH CHECK, resolving to `auth_is_privileged()`.

- AC2: The SELECT policy `"Authenticated can read categories"` is **not** modified → PASS — Migration contains no DDL referencing the SELECT policy. Live `pg_policy` confirms `"Authenticated can read categories"` (FOR SELECT, `auth.uid() IS NOT NULL`) remains intact and unmodified.

- AC3: No other table is touched by this migration → PASS — Migration contains exactly two DDL statements, both scoped to `public.recipe_categories`. Live `\d public.recipe_categories` confirms schema is `(id uuid, name text, created_at timestamptz)` — no `brand_id` column was added. No other table name appears in any DDL.

- AC4: Migration is idempotent and re-runnable (uses `drop policy if exists`) → PASS — Line 22 uses `drop policy if exists` before recreating. Verified by static inspection; a second run would issue DROP then CREATE with identical semantics.

- AC5: No data changes — policy-only DDL → PASS — Migration contains no INSERT, UPDATE, DELETE, COPY, or TRUNCATE. Only `drop policy if exists` and `create policy`.

- AC6: Positive psql probe — JWT `app_metadata.role = 'super_admin'` can INSERT → PASS — `supabase/tests/recipe_categories_super_admin_rls.test.sql::AC6: super_admin profile INSERT succeeds (auth_is_super_admin() path)`. pgTAP assertion `ok 2` confirmed live against `supabase_db_imr-inventory`. JWT carries `app_metadata.role='user'` (not admin/master) to prove the passing path is `auth_is_super_admin()` (profiles-based), not `auth_is_admin()` (JWT-based).

- AC7: Negative psql probe — JWT `app_metadata.role = 'user'` is rejected → PASS — `supabase/tests/recipe_categories_super_admin_rls.test.sql::AC7: plain user INSERT rejected by RLS (SQLSTATE 42501)`. pgTAP assertion `ok 3` confirmed live; `throws_ok` matched SQLSTATE `42501`.

- AC8: Regression probe — `app_metadata.role = 'admin'` or `'master'` still succeeds → PASS — `supabase/tests/recipe_categories_super_admin_rls.test.sql::AC8a` (admin) and `::AC8b` (master). pgTAP assertions `ok 4` and `ok 5` confirmed live. Both roles pass via `auth_is_admin()` which reads JWT against `['admin', 'master']`.

- AC9: UI probe deferred — spec line 34 now reads: "UI probe deferred — the recipe-category CRUD surface exists only in the frozen legacy `src/screens/AdminScreens.tsx` and has no equivalent in `src/screens/cmd/sections/`. Per CLAUDE.md, agents must not extend the legacy file. Verification leans on the SQL-layer probes above; if a Cmd UI surface is later built (out of scope), it should be exercised end-to-end at that time." → DEFERRED (ACCEPTABLE) — The deferral is consistent with CLAUDE.md: agents must not modify the frozen legacy screen; no Cmd UI section for `recipe_categories` exists; CLAUDE.md restricts new Cmd UI surfaces to `src/screens/cmd/sections/`. The prior Critical is cleared. The SQL-layer probes (AC6-AC8) now run as live automated pgTAP tests, providing stronger coverage than the implementer's manual one-shot probes recorded in the original spec. If a Cmd UI section for recipe categories is ever built, it must be tested end-to-end at that time.

---

### Test run

```
bash scripts/test-db.sh supabase/tests/recipe_categories_super_admin_rls.test.sql
```

```
== supabase/tests/recipe_categories_super_admin_rls.test.sql ==
  PASS supabase/tests/recipe_categories_super_admin_rls.test.sql (5 assertion(s) passed)

✓ 1/1 DB test file(s) passed
```

All 5 pgTAP assertions passed. Test file written to `supabase/tests/recipe_categories_super_admin_rls.test.sql` — permanent hermetic test in the pgTAP track (Spec 022 Track 2), runnable via `npm run test:db`.

AC1-AC5: verified by static analysis of the migration file and live policy dump.
AC6-AC8: verified by live pgTAP execution against `supabase_db_imr-inventory`.
AC9: deferred per amended spec and CLAUDE.md policy.

Pass count: 8 AC (AC1-AC8). Deferred/acceptable: 1 AC (AC9).

---

### Notes

**AC9 deferral is acceptable per CLAUDE.md.** The amended spec text at line 34 precisely matches the resolution the prior test-engineer review's release-proposal recommended (remove the untestable AC9 and document that UI verification is deferred). CLAUDE.md states agents must not extend the frozen legacy `src/screens/AdminScreens.tsx`, and no Cmd UI section for `recipe_categories` exists under `src/screens/cmd/sections/`. Requiring a UI probe would mean either (a) building a new Cmd UI section that is out of scope for a migration-only RLS patch, or (b) modifying the legacy file, which is prohibited. The SQL-layer probes AC6-AC8 provide adequate functional coverage for the migration's correctness. The prior Critical is cleared.

**AC6-AC8 are now live automated pgTAP tests, not implementer-reported one-shot probes.** The new permanent test file `supabase/tests/recipe_categories_super_admin_rls.test.sql` runs hermetically inside a `begin; ... rollback;` block, leaving the seed untouched. It is a peer of `supabase/tests/invitations_super_admin_rls.test.sql` and follows the same fixture pattern (reusing the seeded master user's UUID as the super_admin fixture, promoting via `UPDATE profiles` inside the transaction, then rolling back).

**auth_is_super_admin() reads profiles.role, not the JWT.** This is a critical implementation detail correctly exercised by AC6: the test JWT carries `app_metadata.role='user'` while the profiles row is promoted to `super_admin`. This proves the passing code path is `auth_is_super_admin()` (profiles-based), not `auth_is_admin()` (JWT-based). AC8b exercises the orthogonal JWT-based path by setting `app_metadata.role='master'` directly.

**Prior documentation inconsistency (brand_id column) — clarified.** The original spec's probe description mentioned `INSERT INTO recipe_categories (name, brand_id) VALUES (...)`. The actual schema is `(id uuid, name text, created_at timestamptz)` — no `brand_id` column. This was a spec documentation error, not a migration defect. The pgTAP test uses `INSERT INTO public.recipe_categories (name) VALUES (...)`, which is the correct form.

**Migration ordering and dependency confirmed.** `20260510030000_recipe_categories_super_admin_rls.sql` depends only on `auth_is_privileged()` from `20260509000000_multi_brand_schema_rls.sql`. The function exists and is granted to `authenticated` (confirmed by live DB query). No additional GRANT EXECUTE is needed in this migration.

**SELECT policy verified untouched.** Live `pg_policy` confirms `"Authenticated can read categories"` (FOR SELECT, `auth.uid() IS NOT NULL`) is present and unmodified — polcmd='r' with the NULL-test predicate.

**No realtime restart needed.** This migration touches only RLS policies; it does not change `supabase_realtime` publication membership. The realtime container restart gotcha does not apply.
