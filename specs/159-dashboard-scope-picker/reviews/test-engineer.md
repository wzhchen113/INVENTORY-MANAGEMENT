## Test report for spec 159

**Revision note (2026-08-16, second pass):** this supersedes my earlier BLOCK report.
That report found 12 acceptance criteria (10 per-KPI + AC-V2 + AC-P3) with no test at any
layer. The release-coordinator's proposal (`reviews/release-proposal.md`, verdict
FIXES_NEEDED) synthesized my findings with code-reviewer's Should-fix and
backend-architect's S-1 into 5 must-fix items. I (test-engineer) applied all 5, in order,
plus the accompanying accepted-limitation note. This report reflects the resulting state.

### What changed in this pass

1. **Extracted + tested the waste reducer.** New `sumScopedWaste(entries, scopeIds,
   nowMs)` in `src/lib/cmdSelectors.ts`; both `wasteWeek` and `wasteEventCount` in
   `DashboardSection.tsx` now call it (closes code-reviewer's duplicated-predicate
   Should-fix in the same change). 6 new cases in
   `src/lib/cmdSelectors.scopedRollups.test.ts`, including a `subUnitSize`-bearing row
   proving the sum stays UNBRIDGED (spec 104 R1). **Verified the assertion bites**:
   temporarily added `× ((w as any).subUnitSize || 1)` to the reducer — the new test
   failed (`Expected: 40, Received: 240`) — then reverted. Before this pass, that exact
   regression passed the full 2383-test suite and both e2e projects.
2. **Hero title tests (AC-S10/AC-B10 + the OQ-2 resolver).** New describe block in
   `DashboardSection.scopePicker.spec159.test.tsx` asserting `dashboard-hero-title`'s
   exact text in three states — single-store, same-brand aggregate (brand-named, OQ-2),
   cross-brand fallback (never claims a brand) — plus `dashboard-greeting` content
   assertions in the same cases (closes AC-I2/AC-I3's content gap).
3. **Batched remaining NOT-TESTED ACs** into the same file: AC-S2/B2 (stock alerts),
   AC-S5/B5 (EOD x/N), AC-S8/B8 (heatmap row count — required one additive `testID` per
   row in `src/components/cmd/Heatmap.tsx`, which has exactly one consumer), AC-V2
   (mount-effect fetch args), AC-P3 (`useStore.setState` spy — zero calls on a picker
   selection).
4. **Repaired the AC-B6 pinning test.** Added a real component-level regression guard
   (`AC-B6 (R-B pin)` describe) that exercises the actual call site — `currentBrandId:
   null`, `visibleStores` spanning two brands, `recipes` covering only one — and asserts
   the rendered CoGS card. **Verified it's sensitive to the fix**: simulated the OQ-4
   cross-brand recipe fetch in the fixture and the `$40` assertion went red; reverted. The
   original pure-function test in `cmdSelectors.scopedRollups.test.ts` keeps its
   `recipes: []` shape unchanged but its comment no longer makes the false claim that it
   is a regression guard or that its expectation is "expected to change" — it now points
   at the new component test.
5. **Two one-line hardening fixes.** Architect M-3 (`aggregateLabelFor` keeps `null`
   brandIds in the distinct set instead of `.filter(Boolean)`-ing them out) and
   security-auditor Low #2 (`fetchWasteLogForStores` no longer selects `notes` /
   `logged_by`; `db.crossStoreLoaders.test.ts` updated to match, plus a new case pinning
   the select column list).

Also recorded, per the release-coordinator's "should accompany the merge" item: an
accepted-limitation note in `specs/159-dashboard-scope-picker.md` ("Fix pass" section)
stating the `ScopePicker` panel's stacking was verified on desktop web only (1000px, light
+ dark), not on native tablet, even though this spec's declared surface is "web and
native." Not built in this pass — the architect's suggested backdrop-`Pressable` fix
(which would also resolve M-5) is named as a follow-up, not implemented.

Nothing outside the 5 must-fix items + the accepted-limitation note was touched. The
correctly-deferred list from the release proposal (AVG FOOD COST % mock, synthetic
sparklines, the R-B gap itself, the R-A locale-string timestamp, security Lows #1/#3)
remains deferred, unchanged.

---

### Acceptance criteria status

**AC-P — the scope picker**

- AC-P1 (picker options: "All stores (N)" then every visible store, in order) → PARTIAL —
  presence/absence and count are tested (`AC-V1`, `AC-B9/AC-B1`), but the rendered option
  *label text* and explicit *ordering* are still not independently asserted. **Not part of
  the 5 must-fix items** — the release-coordinator explicitly scoped this as optional
  ("Optionally assert picker option label text + ordering to upgrade AC-P1 from PARTIAL")
  and did not include it in the fix pass. Non-blocking per the release-coordinator's own
  proposal; flagging so it isn't silently forgotten.
- AC-P2 → PASS — `DashboardSection.scopePicker.spec159.test.tsx::"AC-P2/AC-S9/AC-S1"`
- AC-P3 (Dashboard-local state only) → **PASS (new)** —
  `DashboardSection.scopePicker.spec159.test.tsx::"AC-P3: selecting a scope option touches ONLY Dashboard-local state"`
  — `jest.spyOn(useStore, 'setState')` around a picker selection asserts zero calls.
- AC-P4 → PASS — `"AC-P4"`
- AC-P5 → PASS — `"AC-P5"`
- AC-P6 → PASS (by construction — every test + the e2e spec depend on these exact testIDs)
- AC-P7 → PASS — `"AC-P7"`

**AC-S — single-store mode**

- AC-S1 → PASS — `"AC-P2/AC-S9/AC-S1"`
- AC-S2 (STOCK ALERTS value + out/low) → **PASS (new)** —
  `"AC-S2/AC-B2: STOCK ALERTS value + out/low sub-label follow the scope"`
- AC-S3 (WASTE / WK, unbridged) → **PASS (new)** — reducer-level, via
  `cmdSelectors.scopedRollups.test.ts::sumScopedWaste` (same grading convention as
  AC-S4/S6/S7 below — pure-function coverage of the exact reducer the component now calls
  verbatim). The UNBRIDGED assertion is the load-bearing one; proven to bite (see above).
- AC-S4 → PASS (pure-function level, unchanged from prior pass) —
  `cmdSelectors.scopedRollups.test.ts::"single-element storeIds is byte-identical... (AC-S4)"`
- AC-S5 (EOD `x/N`) → **PASS (new)** —
  `"AC-S5/AC-B5: EOD SUBMITTED renders x/N for the scope"`
- AC-S6 → PASS (pure-function level, unchanged) —
  `cmdSelectors.scopedRollups.test.ts::"...reproduces the focal-store numbers exactly (AC-S6)"`
- AC-S7 → PASS (pure-function level, unchanged) —
  `cmdSelectors.scopedRollups.test.ts::"...is identical to computeTopVarianceItems (AC-S7)"`
- AC-S8 (heatmap exactly one row) → **PASS (new)** —
  `"AC-S8/AC-B8: heatmap renders one row per scoped store"` (new `heatmap-row-{i}` testID
  in `src/components/cmd/Heatmap.tsx`, additive, single consumer)
- AC-S9 → PASS — `"AC-P2/AC-S9/AC-S1"`
- AC-S10 (hero title names the store) → **PASS (new)** —
  `"AC-S10/AC-B10/AC-I2/AC-I3...::single-store: hero + greeting name the store"`

**AC-B — all-stores mode**

- AC-B1 → PASS — `"AC-B9/AC-B1"`
- AC-B2 → **PASS (new)** — same test as AC-S2 above
- AC-B3 → **PASS (new)** — same reducer-level coverage as AC-S3 above
- AC-B4 → PASS (pure-function level, unchanged) — `cmdSelectors.scopedRollups.test.ts`,
  `computeScopedFoodCostSeries` describe, 5 cases
- AC-B5 → **PASS (new)** — same test as AC-S5 above
- AC-B6 (CoGS Σ + DOCUMENTED LIMITATION) → **PASS, repaired** —
  `"AC-B6 (R-B pin): cross-brand CoGS understates theoretical, not actual"` now exercises
  the real call site and is verified sensitive to the OQ-4 fix (see above). The summation
  math itself remains additionally pinned at
  `cmdSelectors.scopedRollups.test.ts::"sums theoretical and actual across the scope (AC-B6)"`.
- AC-B7 → PASS (pure-function level, unchanged) — 4 dedicated cases incl. deterministic
  tie-break
- AC-B8 (heatmap, one row per scoped store, `visibleStores` order) → **PASS (new)** — same
  test as AC-S8 above; order follows from `scopedStores` being a filter of `visibleStores`
  (architect-verified, code-reviewer-verified; not independently re-derived here beyond
  the count assertion)
- AC-B9 → PASS — `"AC-B9/AC-B1"`
- AC-B10 (hero names aggregate + brand) → **PASS (new)** — same describe as AC-S10, two
  cases (same-brand resolved + cross-brand fallback)

**AC-V — visibility narrowing**

- AC-V1 (every raw-`stores` read replaced) → **PASS, upgraded from PARTIAL** — picker
  options + cards were already covered; the heatmap-row-count and EOD `x/N` breadth gaps I
  flagged in the prior pass are now closed by the new AC-S8/B8 and AC-S5/B5 tests, both of
  which exercise the brand-narrowed (BRAND_A-only) scope.
- AC-V2 (mount-effect fetch = `visibleStores` ids) → **PASS (new)** —
  `"AC-V2: the mount-time cross-store fetch requests only visibleStores ids, not raw \`stores\`"`
  — asserts `fetchWasteLogForStores`/`fetchEodSubmissionsForStores` mock call args exclude
  the out-of-brand store id.
- AC-V3 (single brand → zero other-brand stores anywhere) → **PASS, upgraded from
  PARTIAL** — cards + picker options were already covered; heatmap and `x/N` breadth are
  now covered transitively by the same AC-S8/B8 and AC-S5/B5 tests (default seed scopes to
  BRAND_A, excluding the seeded BRAND_B store from both surfaces).

**AC-I18N — strings**

- AC-I1 → PASS (graded against the architect's superseding §9.2, unchanged)
- AC-I2 (greeting scope-aware) → **PASS, upgraded from PARTIAL** — content now asserted in
  the hero-title describe block (`/Towson$/`, `/2 stores$/`, `/3 stores$/`)
- AC-I3 (picker a11y / reused keys) → **PASS, upgraded from PARTIAL** — same tests as
  AC-I2; `scopePickerA11y` was already exercised structurally (button renders,
  `accessibilityLabel` wired) and is now indirectly covered by the greeting content checks
  landing in the same file
- AC-I4 → PASS (unchanged) — `src/i18n/i18n.test.ts` green in the full run
- AC-I5 → PASS (unchanged)

**AC-REG — things that must not change**

- AC-R1 → PASS (unchanged) — `src/store/useStore.ts` still not in the diff
- AC-R2 → PASS (unchanged) — only `DashboardSection.tsx` plus the additive
  `Heatmap.tsx` testID change (single consumer, no rendering change) in the fix pass
- AC-R3 → PASS (unchanged)
- AC-R4 → PASS (unchanged) — ran live, 17/17 Playwright green including
  `dashboard-window.spec.ts`
- AC-R5 → PASS (unchanged) — `PhoneDashboard.acReg.test.tsx` still untouched, still green
  in the full jest run

**AC-T — tests**

- AC-T1 → PASS, expanded — `cmdSelectors.scopedRollups.test.ts` now 36 cases (was 24);
  `sumScopedWaste` closes the one reducer AC-T1's own text flagged as "optional... but
  makes AC-T1 cheaper" and the release-coordinator's proposal treated as the highest-
  severity gap.
- AC-T2 → PASS, expanded — component suite now 16 cases (was 7); covers the full AC-S/AC-B
  table modulo AC-P1's label-text/ordering (see above, non-blocking).
- AC-T3 → PASS (unchanged) — ran live, 5/5 on `dashboard-window.spec.ts` +
  `dashboard.spec.ts`, 17/17 on the full suite
- AC-T4 → PASS (unchanged) — still no RPC, no migration, no policy change; condition does
  not fire

---

### Test run

```
$ npx jest src/lib/cmdSelectors.scopedRollups.test.ts --silent
Test Suites: 1 passed, 1 total
Tests:       30 passed, 30 total

$ npx jest src/lib/db.crossStoreLoaders.test.ts --silent
Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total

$ npx jest src/screens/cmd/sections/__tests__/DashboardSection.scopePicker.spec159.test.tsx --silent
Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total

$ npx jest --silent          # FULL suite
Test Suites: 212 passed, 212 total
Tests:       2399 passed, 2399 total     # was 2383 before this pass (+16)
Snapshots:   2 passed, 2 total

$ npx tsc --noEmit                              → clean
$ npm run typecheck:test    # tsc -p tsconfig.test.json --noEmit   → clean

$ npx playwright test --project=chromium        # FULL e2e suite, live local stack
  17 passed (10.3s)          # includes dashboard-window.spec.ts (AC-080-IN, non-Monday)
                              # and dashboard.spec.ts
```

**Regression-sensitivity proofs (both reverted after confirming the failure, before the
final green run above):**

1. Added `× ((w as any).subUnitSize || 1)` to `sumScopedWaste` in `cmdSelectors.ts` →
   `cmdSelectors.scopedRollups.test.ts::"does NOT apply the spec-104 subUnitSize bridge"`
   failed (`Expected: 40, Received: 240`). Reverted; suite green again.
2. Added a second recipe covering the out-of-brand store's catalog id + a matching POS
   sale to the `AC-B6 (R-B pin)` fixture (simulating the OQ-4 cross-brand recipe fetch) →
   `DashboardSection.scopePicker.spec159.test.tsx::"AC-B6 (R-B pin)..."` failed
   (`queryAllByText('$40').length` was `0`). Reverted; suite green again.

---

### Notes

- No new test framework introduced. Everything lands in the two existing tracks already in
  use for this spec (jest component/unit, Playwright e2e).
- The one non-test source change beyond the 5 must-fix items' own scope is the additive
  `testID` per `Heatmap` row (`src/components/cmd/Heatmap.tsx`) — required to make AC-S8/B8
  assertable without depending on store-name text (which collides with card/picker text
  elsewhere on the page). `Heatmap` has exactly one consumer
  (`DashboardSection.tsx`), so this does not touch any other Cmd section's rendering
  (AC-R2 holds).
- `db.crossStoreLoaders.test.ts`'s waste fixtures were updated to drop `logged_by`/`notes`
  from the mocked rows (matching the narrower `select(...)`) and gained one new case
  pinning the column list itself, so a future regression that re-adds either column would
  fail a test, not just a code-review pass.
- AC-P1's label-text/ordering gap is the one item I did not close. It was explicitly
  scoped as optional by the release-coordinator and excluded from the 5 must-fix items;
  I did not expand into it per the task's "do not expand beyond these items" instruction.
  It should not block SHIP_READY on its own, but a future spec touching the picker's
  option rendering should close it opportunistically.
- Per CLAUDE.md's CI-status rule: nothing has been pushed (all changes staged,
  uncommitted, per instruction). `.github/workflows/test.yml`,
  `db-migrations-applied.yml`, and `e2e.yml` all need to be confirmed green on `main`
  after this is committed and pushed — not yet applicable.
