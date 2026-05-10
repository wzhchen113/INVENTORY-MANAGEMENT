# Release proposal — spec 013 (recipe_categories super-admin RLS fix)

## Verdict
verdict: FIXES_NEEDED
rationale: Migration is correct and SQL-layer behavior is fully verified, but test-engineer flagged a Critical on AC9 (UI probe targets a Cmd UI surface that does not exist), and per project hard rules any Critical blocks SHIP_READY; the fix is a small spec-text correction, not a code change.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, 3 Nits — all minor. Comments on optional explicit `begin/commit` wrapping (consistent with prior-art `20260510020000_*` shape, so non-blocking), and two presentation notes on the migration header. No application-code, store, or legacy-file findings. Migration is clean and faithful to the order_schedule prior art.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 Low. Strict-superset claim confirmed via truth table — no principal loses access, only the intended `super_admin` is newly admitted. SELECT policy untouched. All four helpers in the call graph (`auth_is_admin`, `auth_is_super_admin`, `auth_is_privileged`, `auth_can_see_store`) are SECURITY DEFINER with locked `search_path = public, auth`. The `auth_is_super_admin()` profile probe is not a privilege-escalation surface — `profiles.role` cannot be self-promoted to `super_admin` via PostgREST due to the `super_admin_manage_profiles` policy. The single Low is documentation drift in `specs/013-recipe-categories-super-admin-rls.md:31` and line 67 referencing a non-existent `brand_id` column on `recipe_categories`; security posture unaffected.

- **test-engineer**: 8 PASS, 0 FAIL, 1 NOT TESTED. AC1–AC8 all PASS via static analysis of the migration plus implementer-reported psql probes (positive `super_admin`, negative `user`, regression `admin`, regression `master`). AC9 (UI probe in Cmd UI recipes section) NOT TESTED because no Cmd UI section under `src/screens/cmd/sections/` implements `recipe_categories` CRUD — the only callers of `addRecipeCategory` / `updateRecipeCategory` / `deleteRecipeCategory` are the frozen legacy `src/screens/AdminScreens.tsx` and the store actions in `useStore.ts`. `CategoriesSection.tsx` manages `ingredient_categories`, not `recipe_categories`. Test-engineer labeled this **Critical for release purposes**. Secondary finding: spec's positive-probe text references a `brand_id` column on `recipe_categories` that does not exist in any migration (table is `(id, name, created_at)`).

- **backend-architect (post-impl)**: 0 Critical, 0 Should-fix, 0 Minor. No drift. Implementation matches design line-for-line: single `drop policy if exists` + `create policy` against `public.recipe_categories` only, SELECT policy untouched, no scope creep, no helper changes, no grants, idempotent. Filename slot `20260510030000_*` correctly slotted after the dependency `20260509000000_multi_brand_schema_rls.sql` and the sibling `20260510020000_order_schedule_super_admin_rls.sql`.

## Recommended next steps (ordered)

1. **Reconcile AC9 in the spec** (Critical per hard rule, but cheap to resolve) — Amend `specs/013-recipe-categories-super-admin-rls.md` AC9 to match what is actually verifiable. The recipe_categories management UI lives in the legacy frozen `src/screens/AdminScreens.tsx`, which per CLAUDE.md must not be modified for new functionality and is out of scope for new testing. Two acceptable resolutions:
   - **Preferred:** Reword AC9 to read "Manual verification: a super-admin can use the legacy recipe categories management surface (AdminScreens.tsx) to create a category and the row persists; this is a read-only smoke check, no code changes to the legacy screen." Then run the smoke check once and record the result alongside the existing psql probe block. The RLS path is identical regardless of UI caller, so this is a thin manual touch.
   - **Alternative:** Remove AC9 entirely and document in the spec that UI verification is deferred until recipe_categories management is ported into a Cmd UI section, with the SQL-layer probes (AC6–AC8) standing as the authoritative behavior check. This is justified because the migration is policy-only and the call site is identical for any caller; the regression risk is bounded by the strict-superset proof in security-auditor's review.
   The release-coordinator does not pick between these — that is the user's call. Either resolution clears the AC9 NOT TESTED.

2. **Correct the `brand_id` documentation drift in the spec** (Low severity, also raised by security-auditor and test-engineer) — Fix `specs/013-recipe-categories-super-admin-rls.md` line 31 (probe description) and line 67 (table description) to remove references to a non-existent `brand_id` column. The actual `recipe_categories` schema is `(id uuid, name text, created_at timestamptz)`, keyed globally by name (see `src/lib/db.ts:1237-1250`). The migration itself does not reference `brand_id`, so this is a pure spec-record cleanup. Suggested edit: change probe text from `INSERT INTO recipe_categories (name, brand_id) VALUES (...)` to `INSERT INTO recipe_categories (name) VALUES (...)` and remove the "brand-scoped (has `brand_id`)" wording at line 67. This brings the spec record in line with the implementation that was actually run and verified.

3. **(Optional, non-blocking)** Consider porting recipe_categories CRUD into a Cmd UI section in a follow-up spec — the absence of this surface from the new shell is what made AC9 unverifiable in the first place, and the legacy `AdminScreens.tsx` is slated for removal "next month" per CLAUDE.md. Out of scope for spec 013.

After steps 1 and 2 land in the spec, the migration itself can ship as-is — no code changes are required to the migration file. The migration is correct and reviewer-clean.

## Out of scope for this review

- Porting recipe_categories management from `AdminScreens.tsx` into a Cmd UI section. Belongs in a future frontend spec; not a defect in spec 013.
- Adding a test runner / wiring jest or vitest. CLAUDE.md explicitly notes "No test framework" as a known gap; the spec accepts this in its out-of-scope clause.
- Any changes to the four helper functions (`auth_is_admin`, `auth_is_super_admin`, `auth_is_privileged`, `auth_can_see_store`). They are correct, hardened, and out of scope.
- The `npm audit` step — `package.json` was not changed.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 2 items, top: AC9 NOT TESTED because the Cmd UI recipe-categories surface does not exist; resolve via spec amendment (no code change to the migration).
payload_paths:
  - specs/013-recipe-categories-super-admin-rls/reviews/release-proposal.md
