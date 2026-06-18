# Release proposal — Spec 096 (Shared custom units + dual case/each cost display)

_Re-synthesis after the completed fix cycle. Supersedes the prior FIXES_NEEDED proposal (5 items: 1 Critical, 1 security Medium, 3 Should-fix), all of which are now resolved and re-reviewed._

## Verdict
verdict: SHIP_READY
rationale: All five prior findings are resolved and re-reviewed — no reviewer flags a Critical (0 across all four), the full jest suite is green at 655/655, and the latest `test.yml` on `main` is green — so both CLAUDE.md SHIP_READY hard-rule conditions hold.

## Findings summary
- **code-reviewer**: 0 Critical, 0 Should-fix, 2 Nits. All 3 prior Should-fixes resolved and traced: S1 (per-each label now `unitLabel(g.primary.subUnitUnit || 'each', T)` → Black Pepper renders `/lb`, not hardcoded `/each`), S2 ("· custom" suffix dropped for recognized shared names via the verified-correct `inPool` conditional-label approach — keeps lowercase option values so the `validateCustomUnit` snap/de-dupe still holds, only changes the displayed label), S3 (`perEach!.toFixed(2)` replaces the `(perEach as number)` cast; the non-null assertion is sound because `showPerEach` gates on `perEach !== null`). The 2 remaining Nits were already on the prior proposal's "Out of scope" list.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 non-actionable Low. Prior Medium (cross-brand unit-name leak via the `inventory` axis) RESOLVED with no residual exposure. `deriveBrandUnitPool` no longer accepts `inventory`; it sources from the brand-scoped `catalogIngredients` slice, verified three layers deep against store-population code (server-side `.eq('brand_id', brandId)` filter on the single-store load `db.ts:3441`; single-brand catalog copy on the `__all__` load `useStore.ts:979-981`). The previously-incorrect load-bearing comments are corrected. The Low (dual-cost `<Text>` interpolation) is unchanged and remains injection-safe.
- **test-engineer**: Critical RESOLVED — full suite now `Tests: 655 passed, 655 total` (was 15 failed / 640 passed; root cause was the store selector iterating `args.inventory`, absent from two mocks — fixed by both the `inventory→catalogIngredients` source swap and adding `catalogIngredients: []` to the two mocks). AC9 now has a passing component-level proof (`IngredientForm.spec093.test.tsx`, 9 tests, including the "1 case = 20 lbs" render and the "no inverted arithmetic" guard). AC1/AC4/AC5/AC7/AC8/AC10 PASS. AC2/AC3/AC6 remain untested-but-structurally-satisfied, explicitly flagged by test-engineer as acceptable follow-ups, not ship blockers. No new Criticals.
- **backend-architect**: 0 Critical, 0 Should-fix, 3 Minor, NO architectural drift (unchanged from the prior cycle — the fixes are display-only + a frontend store-selector swap of one brand-scoped slice for another, so no architect re-review was warranted; confirmed by re-reading the file). Implementation honors the design: single shared `piecesPerCase` helper (both surfaces import, neither re-implements), AC7 12×-error guard intact (`db.ts:3769-3779` byte-for-byte unchanged), zero DB/contract/RLS/realtime drift. The 3 Minors (the "2000 cases" empty-`sub_unit_unit` readback, the generic `/each` label — now superseded by the S1 fix, and a well-tested-but-dormant fallback branch) are non-blocking.

**Manual browser verification (both UI-visible changes, running web app, no console errors):**
- Catalog cost row reads e.g. `Black Pepper … $42.00/case · $8.40/lbs` — correct sub-unit suffix, confirming the S1 fix (not hardcoded `/each`).
- A Togo box's DEFAULT UNIT / PACK UNIT dropdowns list the shared brand pool (`loaves`, `cases`, `bags`) with no "· custom" suffix — confirming Issue-1 brand-wide sharing and the AC1 suffix drop.

**CI:** latest `.github/workflows/test.yml` run on `main` is GREEN (`completed / success`). Spec 096 changes are not yet committed (working tree); the local jest suite CI mirrors is green at 655/655.

## Recommended next steps (ordered)

SHIP_READY:
1. The spec is ready to ship. The user runs the commit themselves (per project policy — main Claude does not auto-commit on SHIP_READY). After the commit lands on `main`, confirm the next `test.yml` run is green before continuing pipeline work (the standard post-push CI check).
2. The deferred / follow-up items below are NOT blocking ship — carried forward so nothing is silently dropped.

## Deferred / follow-up (NOT blocking ship)
- **"1 case = 2000 cases" empty-`sub_unit_unit` readback — opt-in re-model spec.** For the subset of legacy rows where `sub_unit_unit` is empty and `unit='cases'`, the preview noun falls through to the tracking unit, yielding a tautological-looking "1 case = 2000 cases". Accepted-by-design by both code-reviewer (Nit 3) and backend-architect (Minor #1 / Risk #1): the NUMBER is now correct (the spec-096 goal); inferring the noun is the "guess what the data means" hazard §Q-A deliberately avoided at display time. The clean fix (populating `sub_unit_unit` on those rows) is a SEPARATE spec with a migration in the `>= 20260617000000_*.sql` slot + EOD/Reorder revalidation + pgTAP backfill coverage.
- **Managed CRUD screen for the unit pool** (rename/delete/merge entries). Explicitly out of scope per the spec; lifecycle management of the derived pool is a possible follow-up.
- **AC2 / AC3 / AC6 UI-test coverage follow-ups.** AC2 (picking a pool entry leaves `caseQty`/`subUnitSize` untouched), AC3 (two-brand isolation through `deriveBrandUnitPool`), and AC6 (the rendered `$X/case · $Y/each` catalog-row string) hold by construction / have unit-level math coverage but lack UI-level assertions. test-engineer flags all three as acceptable new-coverage gaps, not regressions. Recommended follow-up: an `InventoryCatalogMode.test.tsx` dual-price render assertion (AC6) and a multi-brand `deriveBrandUnitPool` isolation test (AC3).
- **Test-name nit** (`perEachCost.test.ts:33-36` — `piecesPerCase(1, 1)` is a normal multiply, not a defaulting case) and the **double `piecesPerCase` call per catalog row** (code-reviewer Nits, O(1), no runtime concern). Trivial polish; bundle into whichever PR next touches these files or defer.
- **`perEachCost` `costPerUnit`-fallback branch dormant in the catalog UI** (architect Minor #3). Well-tested defense-in-depth, intended, not dead code. No action.

## Out of scope for this review
- All items in the "Deferred / follow-up" list above belong in separate specs or future polish PRs; none gate this ship.

## Handoff
next_agent: NONE
prompt: SHIP_READY — all 5 prior findings resolved and re-reviewed (0 Critical across all four reviewers), jest green 655/655, latest test.yml on main green. User runs the commit. Deferred follow-ups: empty-sub_unit_unit re-model spec, unit-pool CRUD screen, AC2/AC3/AC6 UI tests, test-name nit.
payload_paths:
  - specs/096/reviews/release-proposal.md
