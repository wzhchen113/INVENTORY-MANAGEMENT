## Test report for spec 013

### Acceptance criteria status

- AC1: New migration at `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` drops `"Admins can write categories"` and recreates it with `using (public.auth_is_privileged())` and `with check (public.auth_is_privileged())` → PASS — File exists. Lines 22-27 of the migration issue `drop policy if exists "Admins can write categories" on public.recipe_categories` followed by `create policy "Admins can write categories" on public.recipe_categories for all using (public.auth_is_privileged()) with check (public.auth_is_privileged())`. Exact helper names match the spec.

- AC2: The SELECT policy `"Authenticated can read categories"` is **not** modified → PASS — Migration file touches only `recipe_categories` and only the named WRITE policy. No `drop` or `create` statement references `"Authenticated can read categories"` or any SELECT policy. The spec's live policy dump in the verification notes confirms the SELECT policy still reads `auth.uid() IS NOT NULL`.

- AC3: No other table is touched by this migration → PASS — Migration contains exactly two DDL statements, both scoped to `public.recipe_categories`. No other table name appears in any DML or DDL.

- AC4: Migration is idempotent and re-runnable (uses `drop policy if exists`) → PASS — Line 22 uses `drop policy if exists` before recreating, satisfying the idempotency requirement. A second run would drop-then-recreate with identical semantics.

- AC5: No data changes — policy-only DDL → PASS — Migration contains no INSERT, UPDATE, DELETE, COPY, or TRUNCATE. Only `drop policy if exists` and `create policy`.

- AC6: Positive psql probe — JWT `app_metadata.role = 'super_admin'` can INSERT → PASS (implementer evidence) — The spec's verification notes record: "Positive (`app_metadata.role = 'super_admin'`, real super_admin uid `11111111-1111-1111-1111-111111111111`): INSERT succeeded." The probe methodology is sound because `auth_is_privileged()` is defined as `auth_is_admin() OR auth_is_super_admin()`, and `auth_is_super_admin()` reads `profiles.role` (not the JWT), so this correctly exercises the new code path. Evidence is reported, not re-runnable from this review; see caveats below.

- AC7: Negative psql probe — JWT `app_metadata.role = 'user'` is rejected → PASS (implementer evidence) — Recorded as "INSERT rejected with `new row violates row-level security policy for table "recipe_categories"`." The failure message is the correct Postgres RLS rejection string. `auth_is_privileged()` returns false for a user with `profiles.role = 'user'` because neither `auth_is_admin()` (which checks JWT for `admin`/`master`) nor `auth_is_super_admin()` (which checks `profiles.role` for `super_admin`) would match. The probe is logically complete.

- AC8: Regression probe — `app_metadata.role = 'admin'` or `'master'` still succeeds → PASS (implementer evidence) — Recorded as "Regression (`app_metadata.role = 'admin'`): INSERT succeeded" and "Regression (`app_metadata.role = 'master'`): INSERT succeeded." Both roles pass through `auth_is_admin()` which checks the JWT against `['admin', 'master']`. This confirms the superset property — no prior access was removed.

- AC9: UI probe — super-admin can create a new category in the Cmd UI recipes section and the row persists → NOT TESTED — See critical finding below.

---

### Test run

No automated test framework exists (CLAUDE.md "No test framework"). There is no test runner command to invoke. Verification is based on:

1. Static analysis of `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` against the spec's DDL requirements.
2. Cross-referencing the `auth_is_privileged()` function definition in `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (lines 235-239) to confirm the helper correctly covers `admin`, `master`, and `super_admin`.
3. Review of the implementer's four reported psql probes as documented in the spec's verification notes section.

Pass count: 8 AC (AC1–AC8). Not tested: 1 AC (AC9).

---

### Notes

**Critical finding — AC9 (UI probe) is NOT TESTED and cannot be verified from static analysis alone.**

The spec's UI probe states: "in the Cmd UI recipes section (recipe categories management surface in `src/screens/cmd/sections/`), a super-admin user can create a new category and the row persists."

After auditing the Cmd UI directory, `recipe_categories` CRUD is **not implemented in any Cmd UI section**. The only callers of `addRecipeCategory`, `updateRecipeCategory`, and `deleteRecipeCategory` are:
- `src/screens/AdminScreens.tsx` (lines 652, 699, 721) — the legacy frozen mega-screen that must not be modified per CLAUDE.md.
- `src/store/useStore.ts` (lines 946–971) — the store actions that call `src/lib/db.ts`.

None of the 16 Cmd UI sections under `src/screens/cmd/sections/` import or call any recipe-category function. The `CategoriesSection.tsx` component that does exist manages `ingredient_categories`, not `recipe_categories`.

Consequence: the UI probe as written cannot be executed against the Cmd UI because no Cmd UI surface exists for recipe category management. The spec's "UI probe" is either (a) intended to target the legacy `AdminScreens.tsx` interface, which exists but is out of scope for new testing per project policy, or (b) based on an incorrect assumption that a Cmd UI section for recipe categories exists.

**Secondary finding — probe description references non-existent `brand_id` column.**

The spec's positive probe description says `INSERT INTO recipe_categories (name, brand_id) VALUES (...)`. The actual `recipe_categories` schema (defined in `20260424211732_recover_undeclared_tables.sql` lines 24-28, with no subsequent `brand_id` addition across any migration) is `(id uuid, name text, created_at timestamptz)`. There is no `brand_id` column on this table. The actual INSERT the implementer ran must have been `INSERT INTO recipe_categories (name) VALUES (...)`. This is a documentation inconsistency in the spec's probe description — it does not affect correctness of the migration itself, but the recorded probe command cannot be reproduced as written.

**Probe reproducibility.**

The four psql probes are reported as "all rolled back, no data persisted." They were run interactively and are not stored as a script in the repo. They cannot be mechanically re-run to confirm results from this review. The evidence is implementer-reported only. This is accepted by the spec's own out-of-scope clause ("Tests / test framework — there is no test runner wired up in this repo") but means AC6–AC8 rely on trust in the implementer's reporting.

**Migration ordering is correct.** The file timestamp `20260510030000` slots after the dependency `20260509000000_multi_brand_schema_rls.sql` (which provides `auth_is_privileged()`) and after the sibling `20260510020000_order_schedule_super_admin_rls.sql`. The helper `auth_is_privileged()` is already granted to `authenticated` at line 243 of the 012a migration, so no additional `GRANT EXECUTE` is needed here.

**SELECT policy verified untouched.** The spec's live dump confirms `"Authenticated can read categories"` (FOR SELECT, USING `auth.uid() IS NOT NULL`) was not altered. This is consistent with the migration file, which contains no SELECT-related DDL.

**AC9 disposition for release-coordinator.** AC9 is NOT TESTED because the required Cmd UI surface does not exist. Depending on whether the spec intended the legacy screen or a hypothetical new section, this is either a gap in the spec's testability or a missing frontend deliverable. The RLS fix itself is correct; the AC9 gap is a testing infrastructure and UI-coverage issue, not a defect in the migration.
