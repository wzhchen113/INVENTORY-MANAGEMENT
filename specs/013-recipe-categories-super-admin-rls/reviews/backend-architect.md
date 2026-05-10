# Architectural drift review — Spec 013 (recipe_categories super-admin RLS)

Reviewer: backend-architect (post-impl mode)
Spec: `specs/013-recipe-categories-super-admin-rls.md`
Implementation: `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`

## Summary

No drift. The implementation matches the design exactly. The migration is a single-policy patch: one `drop policy if exists` + one `create policy` against `public.recipe_categories` only. No scope creep, no extra tables, no schema changes, no helper changes, no grants. SELECT policy left untouched as designed.

## Drift check (line by line against design contract)

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
| Mirrors prior-art `20260510020000_order_schedule_super_admin_rls.sql` shape minus the SELECT swap | Confirmed — only the WRITE policy is touched here, while the order_schedule fix touched both because that table needed the SELECT swap. Correct deviation, justified in design Sec "Backend design" line 75 | OK |

## Findings

### Critical
None.

### Should-fix
None.

### Minor
None.

## Notes (non-findings)

- **Header comment quality.** The migration's preface (lines 1-20) accurately recaps the bug, the 012a helper introduction, the trigger that mirrors `profiles.role` into JWT, and the strict-superset reasoning. This is consistent with the design's "Risks and tradeoffs" framing and helpful for future readers. No action needed.
- **Verification claim trust.** The spec's "Verification (run, not committed)" block at lines 127-139 documents psql probes (positive super_admin, negative user, regression admin, regression master). These are runtime claims I cannot independently re-execute in review mode; from a static-review standpoint the policy text itself is correct and the claims are plausible given the helper definition in 012a.
- **No realtime publication impact, as designed.** The migration touches only RLS, not `supabase_realtime` membership. The CLAUDE.md `docker restart supabase_realtime_imr-inventory` gotcha does not apply here, and the design correctly called this out.
- **No `src/lib/db.ts` changes expected or made.** Recipe-category helpers continue to work unchanged for all privileged roles, as designed.

## Verdict

The implementation lands the design with zero deviation. Single policy swap on `recipe_categories` WRITE only, SELECT untouched, no other tables, no schema drift, no helper churn. Strict superset of prior permissions — `admin` and `master` JWTs continue to pass via `auth_is_privileged()`; `super_admin` newly passes. Safe to ship.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity (0 Critical, 0 Should-fix, 0 Minor).
payload_paths:
  - specs/013-recipe-categories-super-admin-rls/reviews/backend-architect.md
