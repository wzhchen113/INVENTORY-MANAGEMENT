# Release proposal — Spec 012a

## Verdict

**SHIP_READY** — conditional on the cleanup bundle below being applied **before
prod push** (not just before commit). This is the security-boundary spec; the
cleanup bundle includes one load-bearing frontend fix that the new RLS makes
required for brand-admin write paths.

## Reviewer roll-up

| Reviewer | Critical | Should-fix | Notes / Nits | Output file |
|---|---|---|---|---|
| code-reviewer | 0 | 3 | 5 nits | `specs/012a-multi-brand-schema-rls/reviews/code-reviewer.md` |
| security-auditor | 0 | 0 (warnings) | 14 notes | `specs/012a-multi-brand-schema-rls/reviews/security-auditor.md` |
| test-engineer | 0 (19/19 ACs PASS) | 1 behavioral pre-prod-push fix + smoke-script ship recommendation | — | `specs/012a-multi-brand-schema-rls/reviews/test-engineer.md` |
| backend-architect | 0 (drift) | 0 actionable | 6 acceptable deviations (incl. `master` role endorsement) | `specs/012a-multi-brand-schema-rls/reviews/backend-architect.md` |

Zero Criticals across all four reviewers. Hard rule satisfied for SHIP_READY.

## Cleanup bundle (apply pre-commit AND pre-prod-push if SHIP_READY)

Ordered by severity. Items 1 and 2 must land before prod push because the new
RLS will reject (item 1) or silently mis-document (item 2) behavior the user
will rely on for brand-admin onboarding next.

1. **`src/lib/db.ts` — `createStore()` INSERT payload omits `brand_id`** (test-engineer cleanup #4).
   Post-012a, `stores` INSERT RLS is
   `auth_is_privileged() AND auth_can_see_brand(brand_id)`. With `brand_id`
   absent from the payload, the column lands NULL, `auth_can_see_brand(NULL)`
   returns false for non-super-admins, and the INSERT fails with 42501 for
   every brand-admin. **Load-bearing for the user's stated next step
   (brand-admin onboarding for 012b).** Fix: resolve the caller's brand
   (super-admin chooses; brand-admin uses their own `profiles.brand_id`) and
   include it in the INSERT. Severity: should-fix elevated to pre-prod-push
   blocker because the user explicitly relies on this path next.

2. **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:836–841` — section 6j comment claims a `inventory_items.store_id` fallback that the SQL does not implement** (code-reviewer should-fix #2).
   Comment promises "falls back to the inventory_items.store_id chain for
   legacy rows whose catalog_id is not yet backfilled," but every policy
   condition is `EXISTS (SELECT 1 FROM catalog_ingredients ci WHERE ci.id =
   ingredient_conversions.catalog_id …)`. Any row with `catalog_id IS NULL`
   becomes invisible to everyone including admins. Fix: rewrite the comment
   to state "P3 forced `catalog_id NOT NULL` on `ingredient_conversions`;
   there are no legacy NULL rows" with a citation to the P3 migration
   filename. (No SQL change needed if P3's NOT NULL is in fact in force —
   verify before editing.)

3. **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:229–234` — comment references a non-existent `sync_role_to_app_metadata` trigger** (code-reviewer should-fix #1).
   Underlying logic is correct; the comment fabricates a mechanism. A future
   reader auditing security will look for the trigger, fail to find it, and
   doubt the design paragraph. Fix: keep the factual statement — "super-admin
   promotion via `profiles.role` does NOT also set `app_metadata.role` to
   `'admin'`, so `auth_is_admin()` returns false for super-admins" — and
   delete the trigger sentence.

4. **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:321–328` — final invariant check omits `master` role** (code-reviewer should-fix #3, also flagged by test-engineer cleanup #2 and backend-architect notes).
   Current check: `WHERE role = 'admin' AND brand_id IS NULL`. The
   `profiles_role_brand_consistent` CHECK already enforces `master ⇒ brand_id
   NOT NULL`, so a violation cannot reach this point in practice — but the
   invariant as written silently passes a `master` row with NULL `brand_id`
   if one ever slipped through. Fix: change to
   `WHERE role IN ('admin', 'master') AND brand_id IS NULL`. One-line
   correctness widening, defense in depth.

5. **Add `scripts/smoke-multi-brand.sh`** (test-engineer recommendation).
   The 9 §6 probes are the verification recipe for a security-boundary
   change. Shipping them as an executable script in 012a (matching the
   `scripts/smoke-edge.sh` pattern) gives the user a one-command re-run path
   for prod after `supabase db push --linked`, consistent with how Specs 010
   and 011 were verified. The test-engineer's review includes the
   ready-to-paste script body. Side with the test-engineer: ship in 012a,
   not 012b — re-typing 9 SQL/curl statements by hand for a security-boundary
   change is the operational gap to close now.

The 5 nits from code-reviewer (file header style, search_path comment on
trigger function, drop-list comments, seed.sql positive attestation,
pre-flight cross-brand check honesty comment) are deferrable — none affect
behavior. Apply them only if the user wants a tidier diff; otherwise roll
them into a future cleanup spec.

## Justification

(1) Zero Criticals from any reviewer; the hard rule for SHIP_READY is
satisfied. (2) The migration's 9 §6 probes are all PASSING locally and the
backend-architect's drift review found zero critical drift and explicitly
endorsed the `master` role addition as a correct "design met reality" fix.
(3) The single behavioral finding (`createStore` brand_id omission) is not a
defect of the migration itself but a frontend write path the new RLS makes
required — fixing it inline pre-prod-push matches the user's session pattern
across Specs 003 / 006 / 007 / 008 / 009 / 010 / 011 and unblocks the user's
stated next step (brand-admin onboarding in 012b) without a separate spec.
This is the security-boundary spec, so the cleanup bundle being applied
**before prod push** (not only before commit) is non-negotiable.

## Out-of-scope follow-ups

- **`'master'` ↔ `'admin'` role unification.** Test-engineer cleanup #1 and
  backend-architect acceptable-deviation #1 both note that `'master'` exists
  as an admin-equivalent because real seed and prod rows carry it, and the
  spec text does not acknowledge it. Decide in a future cleanup spec whether
  to migrate `master → admin` or formally adopt `master` in the role model.
  Not 012a's job.
- **Tighten all helper `search_path` to `''`** (security-auditor note #1).
  Pre-existing tracked debt that grows by 3 functions in 012a. Not a
  regression — same pattern as `auth_is_admin()` and the prior
  `auth_can_see_store()`.
- **`pos_recipe_aliases` `(recipe_id, store_id)` cross-brand check at the UI
  layer** (security-auditor note #10). The new policy gates on
  `recipes.brand_id`, not `stores.brand_id`; a brand-admin could in principle
  insert a row with `store_id` from another brand. The row would be inert
  (only their brand can read it) and the UI doesn't surface such a path
  today. Tighten in 012b's UI work by filtering the store picker to the
  recipe's brand.
- **`fetchIngredientConversions()` RLS-only scoping in `fetchAllForStore`**
  (test-engineer cleanup #3). Correct today (one brand in prod), worth an
  explicit brand filter when 012b/012c introduces a second brand.
- **Automated integration tests for the 9 §6 probes.** Test-engineer's
  recurring framework note: when vitest/jest is adopted, 012a's probes are
  the highest-value first tests in the codebase. Continues to be deferred
  per the umbrella spec.
- **Externalize the migration's verbatim §6 verification probe block to a
  sibling `docs/specs/012a-verification.md`** (backend-architect note).
  Either keep colocated or move; user preference, not a defect.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 5 cleanup-bundle items (top: createStore brand_id omission — load-bearing for brand-admin onboarding, must land before prod push)
payload_paths:
  - specs/012a-multi-brand-schema-rls/reviews/release-proposal.md
