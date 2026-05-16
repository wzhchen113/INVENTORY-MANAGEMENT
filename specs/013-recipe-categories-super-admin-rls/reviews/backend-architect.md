# Architectural drift review — Spec 013 (recipe_categories super-admin RLS)

Re-review on the amended spec (AC9 deferred wording, brand_id doc drift removed); migration code unchanged. Findings still 0/0/0.

Reviewer: backend-architect (post-impl mode, re-review)
Spec: `specs/013-recipe-categories-super-admin-rls.md` (Status: READY_FOR_REVIEW)
Implementation: `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`
Helper dependency: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (`public.auth_is_privileged()`)
Prior-art reference: `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`

## Summary

No drift. The implementation still matches the (amended) design exactly. The migration is a single-policy patch: one `drop policy if exists` + one `create policy` against `public.recipe_categories` only. No scope creep, no extra tables, no schema changes, no helper churn, no grants. SELECT policy left untouched as designed.

The spec amendments since the prior review touched only documentation:
- AC9 (UI probe) now explicitly framed as deferred because the recipe-category CRUD surface lives only in the frozen legacy `src/screens/AdminScreens.tsx` with no Cmd UI equivalent — verification leans on the SQL-layer probes.
- "Project-specific notes" now accurately states `recipe_categories` is global (no `brand_id` column; schema is `id`, `name`, `created_at`), removing the earlier doc drift that implied per-brand scope.

Neither amendment changed the contract the migration must satisfy. The implemented DDL still lands the contract precisely.

## Drift check (line by line against amended design contract)

| Design requirement | Implementation | Verdict |
|---|---|---|
| New file at `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` | File exists at exactly that path/name | OK |
| Drop existing `"Admins can write categories"` policy on `public.recipe_categories` | `drop policy if exists "Admins can write categories" on public.recipe_categories;` (line 22) | OK |
| Recreate as `for all` with `using (public.auth_is_privileged())` and `with check (public.auth_is_privileged())` | Lines 24-27 — exactly that shape, no extra clauses | OK |
| SELECT policy `"Authenticated can read categories"` not modified | Migration body contains zero references to the SELECT policy | OK |
| No other table touched | Only `public.recipe_categories` appears in DDL statements | OK |
| Idempotent / re-runnable (`drop policy if exists`) | Uses `drop policy if exists` (line 22) | OK |
| No data changes — policy-only DDL | No DML present; only `drop policy` + `create policy` | OK |
| Filename slot `20260510030000_*` clean after staged `20260510020000_*` | Slot used as designed | OK |
| Helper `public.auth_is_privileged()` exists at point of use | Defined in `20260509000000_multi_brand_schema_rls.sql:235-239` (admin OR super-admin), granted to authenticated/anon at line 243 | OK |
| `recipe_categories` is global (no `brand_id`); helper without brand argument is correct shape | Confirmed in spec "Project-specific notes" and matched by helper signature (no args) | OK |
| Mirrors prior-art `20260510020000_order_schedule_super_admin_rls.sql` shape minus the SELECT swap | Confirmed — only the WRITE policy is touched here, while the order_schedule fix touched both because that table needed the SELECT swap. Correct deviation, justified in design section | OK |
| AC9 (UI probe) deferred wording matches frozen-legacy reality | Amended spec acknowledges no Cmd UI surface exists and instructs not to extend `AdminScreens.tsx`; no frontend change made or expected | OK |

## Findings

### Critical
None.

### Should-fix
None.

### Minor
None.

## Notes (non-findings)

- **Header comment quality.** The migration's preface (lines 1-20) accurately recaps the bug, the 012a helper introduction, the trigger that mirrors `profiles.role` into JWT, and the strict-superset reasoning. Consistent with the design's "Risks and tradeoffs" framing and helpful for future readers. No action needed.
- **Verification claim trust.** The spec's "Verification (run, not committed)" block (lines 127-139) documents psql probes (positive super_admin, negative user, regression admin, regression master). These are runtime claims I cannot independently re-execute in review mode; from a static-review standpoint the policy text itself is correct and the claims are plausible given the helper definition in 012a.
- **No realtime publication impact, as designed.** The migration touches only RLS, not `supabase_realtime` membership. The CLAUDE.md `docker restart supabase_realtime_imr-inventory` gotcha does not apply here, and the design correctly called this out.
- **No `src/lib/db.ts` changes expected or made.** Recipe-category helpers continue to work unchanged for all privileged roles, as designed.
- **AC9 deferred is the right call.** Per CLAUDE.md "Legacy admin screens" note, agents must not extend `src/screens/AdminScreens.tsx`. Building a Cmd UI surface for recipe-category CRUD just to satisfy a UI probe would be scope creep outside this spec's stated boundary. SQL-layer verification is sufficient for a server-side RLS fix.
- **Global-vs-brand-scoped framing is now accurate.** The amended "Project-specific notes" correctly identifies `recipe_categories` as a global lookup table (no `brand_id`) — which is precisely why `auth_is_privileged()` without a brand argument is the right helper here, rather than something like the brand-scoped `auth_can_see_brand(brand_id)` pattern used by `catalog_ingredients` / `recipes` / `vendors` in 012a §(6b)-(6e).

## Verdict

The implementation lands the (amended) design with zero deviation. Single policy swap on `recipe_categories` WRITE only, SELECT untouched, no other tables, no schema drift, no helper churn. Strict superset of prior permissions — `admin` and `master` JWTs continue to pass via `auth_is_privileged()`; `super_admin` newly passes. Safe to ship.

## Handoff
next_agent: NONE
prompt: Architectural drift re-review complete on amended spec. 0 findings by severity (0 Critical, 0 Should-fix, 0 Minor). No code changes since prior review; spec amendments were doc-only (AC9 deferred wording, brand_id global-scope clarification) and did not alter the contract.
payload_paths:
  - specs/013-recipe-categories-super-admin-rls/reviews/backend-architect.md
