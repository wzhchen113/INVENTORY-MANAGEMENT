# Spec 013: Fix `recipe_categories` RLS to allow super-admin writes

Status: READY_FOR_REVIEW

## Problem statement

`recipe_categories` WRITE policy at [supabase/migrations/20260424211733_security_fixes.sql:119-122](supabase/migrations/20260424211733_security_fixes.sql) gates INSERT/UPDATE/DELETE on a raw JWT check:

```sql
using      (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));
```

Spec 012a ([20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql)) introduced the `super_admin` role plus the `auth_is_super_admin()` / `auth_is_privileged()` / `auth_can_see_store()` helpers. The `profiles_sync_role` trigger ([20260424211732_recover_undeclared_tables.sql:120-137](supabase/migrations/20260424211732_recover_undeclared_tables.sql)) mirrors `profiles.role` verbatim into JWT `app_metadata.role`, so a super-admin's JWT carries `'super_admin'` — which is NOT in `array['admin','master']`. Result: super-admins are rejected on INSERT/UPDATE/DELETE against `recipe_categories`.

The 012a audit comment at [20260509000000_multi_brand_schema_rls.sql:1009-1013](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) explicitly anticipated this kind of follow-up. Sibling fix for `order_schedule` already shipped (staged) as [supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql](supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql) — verified end-to-end. This spec applies the same shape to `recipe_categories`.

The SELECT policy ([20260424211733_security_fixes.sql:115-117](supabase/migrations/20260424211733_security_fixes.sql)) reads `auth.uid() is not null`, which is already permissive for any authenticated user including super-admins. No SELECT change needed.

## User story

As a super-admin, I want to create / rename / delete recipe categories so that I can administer the brand catalog without being silently rejected by RLS.

## Acceptance criteria

- [ ] A new migration at `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` drops the existing `"Admins can write categories"` policy on `public.recipe_categories` and recreates it with `using (public.auth_is_privileged())` and `with check (public.auth_is_privileged())`.
- [ ] The SELECT policy `"Authenticated can read categories"` is **not** modified.
- [ ] No other table is touched by this migration.
- [ ] Migration is idempotent and re-runnable (uses `drop policy if exists`).
- [ ] No data changes — policy-only DDL.
- [ ] Positive psql probe: with a JWT carrying `app_metadata.role = 'super_admin'`, `INSERT INTO recipe_categories (name) VALUES (...)` succeeds.
- [ ] Negative psql probe: with a JWT carrying `app_metadata.role = 'user'`, the same INSERT is rejected by RLS.
- [ ] Regression probe: with a JWT carrying `app_metadata.role = 'admin'` or `'master'`, INSERT still succeeds (strict superset of prior behavior).
- [ ] UI probe deferred — the recipe-category CRUD surface exists only in the frozen legacy `src/screens/AdminScreens.tsx` and has no equivalent in `src/screens/cmd/sections/`. Per CLAUDE.md, agents must not extend the legacy file. Verification leans on the SQL-layer probes above; if a Cmd UI surface is later built (out of scope), it should be exercised end-to-end at that time.

## In scope

- Single new migration file targeting only the `recipe_categories` WRITE policy.
- Replacement of the raw JWT role check with `public.auth_is_privileged()` for both USING and WITH CHECK.
- Mirrors the prior-art shape of the order_schedule fix.

## Out of scope (explicitly)

- The SELECT policy on `recipe_categories` — already permissive enough; not changing what we don't need to change.
- Any other table flagged by the 012a audit comment (those are separate follow-ups, one per table, on demand).
- Cmd UI changes — the bug is purely server-side RLS; no frontend work needed.
- Tests / test framework — there is no test runner wired up in this repo (see CLAUDE.md "No test framework"). Verification is psql probes + manual UI probe.
- Refactoring the `profiles_sync_role` trigger or `app_metadata` shape.
- `app.json` changes (load-bearing slug; off-limits per CLAUDE.md).

## Open questions resolved

- Q: Bundle other tables flagged by the 012a audit comment? → A: No, fix only `recipe_categories` in this spec.
- Q: Patch shape? → A: Drop and recreate the WRITE policy using `public.auth_is_privileged()` for both USING and WITH CHECK — same shape as the order_schedule fix.
- Q: Touch the SELECT policy? → A: No, it's already permissive (`auth.uid() is not null`).
- Q: Migration filename? → A: `20260510030000_recipe_categories_super_admin_rls.sql` (next slot after the staged order_schedule fix).
- Q: Urgency / blocked users? → A: Not specified; treat as proactive / normal-priority.

## Dependencies

- 012a helpers (`public.auth_is_privileged()`) from [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) — already shipped.
- Prior art / reference pattern: [supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql](supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql) (staged, not yet committed at time of writing).

## Project-specific notes

- Cmd UI section / legacy: N/A — backend RLS only. The recipe-category CRUD surface lives only in the frozen legacy `src/screens/AdminScreens.tsx` (per CLAUDE.md, agents must not extend it). No equivalent Cmd UI section exists; verification is SQL-layer only.
- Per-store or admin-global: `recipe_categories` is **global** (no `brand_id` column — schema is `id`, `name`, `created_at`). The helper `auth_is_privileged()` covers admin / master / super_admin uniformly, which is the desired behavior.
- Realtime channels touched: none. RLS-only change; no publication / channel impact.
- Migrations needed: yes — one new file, `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`.
- Edge functions touched: none.
- Web/native scope: N/A — server-side only.

## Backend design

This is a one-policy patch. Mirrors [supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql](supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql) exactly, minus the SELECT swap (which `order_schedule` needed and `recipe_categories` does not).

### Data model changes

None. Policy-only DDL. No tables, columns, indexes, or data touched.

Migration file: `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`. Additive in effect (strict superset of prior WRITE permissions — `admin` and `master` continue to pass; `super_admin` now also passes). Idempotent: `drop policy if exists` then `create policy`. No rollout choreography needed; safe to apply during normal deploy.

### RLS impact

`public.recipe_categories` — WRITE policy only.

- Drop `"Admins can write categories"` (currently at [supabase/migrations/20260424211733_security_fixes.sql:119-122](supabase/migrations/20260424211733_security_fixes.sql), gated on raw `auth.jwt() -> 'app_metadata' ->> 'role'` against `array['admin','master']`).
- Recreate `"Admins can write categories"` with `for all`, `using (public.auth_is_privileged())`, `with check (public.auth_is_privileged())`. Helper defined in [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql), already covers `admin` / `master` / `super_admin` uniformly.

`"Authenticated can read categories"` SELECT policy is **not modified** — its `auth.uid() is not null` predicate already passes for super-admins.

No other tables, no helper changes, no grants.

### API contract

No change. `recipe_categories` is exposed via PostgREST and accessed through existing helpers in [src/lib/db.ts](src/lib/db.ts) (e.g. `listRecipeCategories`, `createRecipeCategory`, etc.). Request and response shapes unchanged. The only observable difference: super-admin INSERT/UPDATE/DELETE calls that previously returned an empty result + RLS rejection now succeed and return the affected row.

### Edge function changes

None. No function in [supabase/functions/](supabase/functions/) writes to `recipe_categories`. `verify_jwt` settings in [supabase/config.toml](supabase/config.toml) untouched.

### `src/lib/db.ts` surface

No new helpers. Existing recipe-category helpers continue to work for all privileged roles. No mapping changes (snake_case → camelCase paths unchanged).

### Realtime impact

No publication membership changes. `recipe_categories` is global (no `brand_id`) and is already a member of the `supabase_realtime` publication. The realtime publication restart gotcha (`docker restart supabase_realtime_imr-inventory`) does **not** apply here — this migration touches only RLS policies, not `supabase_realtime` membership.

### Frontend store impact

None. No slice of [src/store/useStore.ts](src/store/useStore.ts) changes. The optimistic-then-revert pattern was already wired and was being silently reverted for super-admins; after this fix it will commit normally. No code change in the store, no `notifyBackendError` adjustments.

### Risks and tradeoffs

- **Migration ordering.** Filename `20260510030000_*` slots cleanly after the staged `20260510020000_order_schedule_super_admin_rls.sql`. If the order_schedule migration is rolled back or re-timestamped, this one is independent and still applies cleanly — its only dependency is `auth_is_privileged()` from 012a (`20260509000000_*`), which is already shipped.
- **RLS gap closure, not creation.** This is a strict superset of prior WRITE permissions. `admin` and `master` JWTs continue to pass via `auth_is_privileged()`. `super_admin` JWTs newly pass. No role loses access. No risk of broadening to unintended principals — `auth_is_privileged()` is the canonical helper for this exact decision.
- **Performance.** Negligible. Replacing an inline JWT lookup with a `STABLE` SQL function call; planner inlines. The 286 KB seed dataset has a tiny `recipe_categories` row count; no index considerations.
- **Edge function cold-start.** N/A; no edge function involved.
- **Verification path.** No test framework in repo (per CLAUDE.md "No test framework"). Verification is via the psql probes listed in acceptance criteria plus the manual UI probe in the Cmd UI recipes section. Surface-level: confirm a super-admin user can create a recipe category and the row persists across a realtime debounce reload.

## Files changed

### Migrations
- `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` — new file. Drops and recreates the `"Admins can write categories"` policy on `public.recipe_categories` to use `public.auth_is_privileged()` for both USING and WITH CHECK. SELECT policy `"Authenticated can read categories"` left untouched. Idempotent + re-runnable; no data changes.

### Verification (run, not committed)

Applied locally via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` — output: `DROP POLICY` then `CREATE POLICY`.

Live policy dump on `public.recipe_categories` confirms:
- `Admins can write categories` (FOR ALL) — USING `auth_is_privileged()`, WITH CHECK `auth_is_privileged()`.
- `Authenticated can read categories` (FOR SELECT) — USING `auth.uid() IS NOT NULL` (unchanged).

psql probes (all rolled back, no data persisted):
- Positive (`app_metadata.role = 'super_admin'`, real super_admin uid `11111111-1111-1111-1111-111111111111`): INSERT succeeded.
- Negative (`app_metadata.role = 'user'`): INSERT rejected with `new row violates row-level security policy for table "recipe_categories"`.
- Regression (`app_metadata.role = 'admin'`): INSERT succeeded.
- Regression (`app_metadata.role = 'master'`): INSERT succeeded.
