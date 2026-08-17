# Release proposal — spec 159 (Dashboard scope picker)

Release coordinator, 2026-08-16. Sources read in full: `specs/159-dashboard-scope-picker.md`
and all four files in `specs/159-dashboard-scope-picker/reviews/` (`code-reviewer.md`,
`security-auditor.md`, `test-engineer.md`, `backend-architect.md`). Advisory only — no spec
field, source file or reviewer file was modified.

## Verdict

verdict: FIXES_NEEDED
rationale: The implementation is correct by three independent inspections, but 12 acceptance
criteria (10 per-KPI + AC-V2 + AC-P3) have no automated test at any layer — including the hero
title the spec's own Risk R-F designates Critical-if-wrong — so the "uncovered acceptance
criteria block SHIP_READY" hard rule fires.

**Nobody found a defect in the shipped behavior.** Code-reviewer: 0 Critical. Security-auditor:
0 Critical / High / Medium. Backend-architect: 0 Critical, "matches the design contract on every
load-bearing point." Test-engineer ran everything green (2383 jest tests, both typecheck gates,
17/17 Playwright against a live stack). This is a **coverage** block, not a correctness block —
which matters for how the fix pass should be scoped: it is additive test work plus two small
refactors, not a redo.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix, 4 Nits. Should-fix is the waste-filter predicate
  duplicated byte-for-byte between `wasteWeek` (`DashboardSection.tsx:393-411`) and
  `wasteEventCount` (`:446-453`) — new duplication introduced by this diff, carrying the new R-A
  `Number.isFinite(Date.parse(...))` guard in two places. Nits: exported-but-unconsumed
  `DashboardScope` type, `ScopePickerProps.stores` naming, an asymmetric single-store
  short-circuit between `computeScopedFoodCostSeries` and `computeScopedCogs`, and a
  twice-per-render `aggregateLabelFor` call (explicitly noted as intentional). Verified every row
  of the architect's §6.4 re-keying table by hand and found no missed consumer, no stale dep
  array, no mixed-scope regression.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 3 Low. Re-derived the `waste_log` policy
  chain against the live DB (single permissive SELECT policy, no wide OR-tail survivor) and ran a
  behavioural proof as a non-privileged manager: the unauthorized store's row is silently
  filtered, not errored. Confirms the `.in('store_id', …)` fan-out with no server-side pre-filter
  is sound, `brandNameFor` fails closed, and the picker is display-only (never an authz
  boundary). Notes the spec **closes** a pre-existing cross-brand leak in TOTAL INV VALUE for
  super-admins and tightens the four existing cross-store reads as a side effect. Lows:
  (1) transport/session failure renders as a confident `$0` — pre-existing, byte-identical in all
  four sibling loaders; (2) the new select pulls `notes` + `logged_by` it never consumes;
  (3) no `.limit()` on the fan-out — informational, consistent with all four siblings.
- **test-engineer**: **BLOCK.** NOT TESTED at any layer: AC-S2, AC-S3, AC-S5, AC-S8, AC-S10,
  AC-B2, AC-B3, AC-B5, AC-B8, AC-B10, AC-V2, AC-P3. PARTIAL: AC-P1 (option label text/ordering),
  AC-V1/AC-V3 (heatmap + `x/N` denominator unverified), AC-I2/AC-I3 (wired, content untested).
  PASS: AC-P2/P4/P5/P6/P7, AC-S1/S4/S6/S7/S9, AC-B1/B4/B6-math/B7/B9, all AC-I18N, all AC-REG,
  all AC-T. Diagnosis: the pure-function tests prove the *formulas* (the single-element-`storeIds`
  identity checks are strong), but nothing guards that the component calls them with the right
  arguments and renders the result under the right testID. Separately: the AC-B6 "documented
  limitation" pinning test passes `recipes: []`, so it would remain green unmodified **after** the
  limitation it claims to pin is fixed — insensitive to the fix, and worse than no test because a
  future engineer reads green CI as signal. Also confirms no test was deleted or weakened, and
  that the e2e repair is strictly stronger than what it replaced.
- **backend-architect** (post-impl drift): 0 Critical, 2 Should-fix, 5 Minor. **S-1**: the waste
  reducer — the sole consumer of this spec's entire backend surface — has no test at any level;
  adding `× (subUnitSize || 1)` there (the exact spec-104 R1 mistake, and one that looks correct
  next to `totalInvValue` two memos above) would pass all 2383 jest tests and both e2e projects.
  **S-2**: the `zIndex: 50` stacking fix is *proven* sound on react-native-web but unverified on
  native; on Android the panel would clip and on iOS touches outside the parent frame are not
  delivered — and native tablet is inside this spec's declared web/native scope. Minors: M-1
  (R-A residual — in all-stores mode the *focal* store is now the one that can silently drop out),
  M-2 (`delta` gained an unspecified `.toFixed(2)`, render-invisible, no change requested), M-3
  (`.filter(Boolean)` lets a brand-less store hide inside a confident brand label), M-4
  (`scopeIdsKey.split(',')` round-trip assumes no comma in a store id), M-5 (no outside-press
  dismissal on the picker panel). Process note, non-blocking: **AC-B6's text was amended by the
  implementer rather than the PM** — faithful to what §12.3 asked for and explicitly labeled, but
  an acceptance criterion edited to describe shipped behavior is worth naming out loud.

**The convergence.** The test-engineer's AC-S3/AC-B3 gap, the architect's S-1, and the
code-reviewer's Should-fix are three views of one risk: an untested, drift-prone, duplicated
reducer that carries the spec-104 R1 unbridged-cost invariant. Fix #1 below treats them as a
single item.

## Recommended next steps (ordered)

FIXES_NEEDED — 5 must-fix items before merge, then a clean follow-up list.

### Must-fix before merge

1. **Extract and test the waste reducer.** *(Severity: highest — the only load-bearing invariant
   in this diff with zero coverage; also unblocks #2 by establishing the fixture shape.)*
   Extract `sumScopedWaste(entries, scopeIds, nowMs): { dollars: number; events: number }` into
   `src/lib/cmdSelectors.ts` beside the other scoped rollups, and have both `wasteWeek` and
   `wasteEventCount` call it. This single change closes **three findings at once**: architect S-1
   (no test at any level), code-reviewer Should-fix (duplicated predicate → one copy of the
   invariant), and test-engineer AC-S3/AC-B3 (NOT TESTED). Add ~4-5 cases: two stores summed;
   an out-of-7-day-window row excluded; an unparseable focal `timestamp` (the R-A guard) dropped
   explicitly; and — the one that actually matters — **a `subUnitSize`-bearing row proving no
   `× subUnitSize` bridge is applied** (spec 104 R1). Without that last assertion the exact
   regression the architect describes stays invisible to CI.
2. **Test the hero title in both modes (AC-S10 / AC-B10).** *(Severity: the spec's own Risk R-F
   says "a reviewer should treat a missing/incorrect hero title as a Critical, not a Minor" — it
   is the sole mitigation for the owner-accepted R-F/R3 divergence, and the `dashboard-hero-title`
   testID already exists.)* Assert rendered text in three states: single-store (`Towson · day in
   progress`), same-brand aggregate (`2AM PROJECT · 4 stores · …`), and the cross-brand /
   unresolved fallback (`All stores (N) · …`). This is also the only test that would exercise the
   OQ-2 label resolver at all — today it is verified solely by the developer's manual browser
   pass. Add `dashboard-greeting` text assertions in the same block to close AC-I2/AC-I3.
3. **Close the remaining NOT-TESTED acceptance criteria in the existing component suite.**
   *(Severity: same rule as #2, lower individual blast radius; batched because the mount/mock
   scaffolding in `DashboardSection.scopePicker.spec159.test.tsx` already exists and no new file,
   hook or framework is needed.)* Stock-alert count + `out`/`low` sub-label (AC-S2/B2); EOD `x/N`
   text (AC-S5/B5); heatmap row count (AC-S8/B8, which also closes the test-engineer's AC-V1/V3
   breadth gap on the heatmap and the `x/N` denominator); AC-V2 as a `toHaveCalledWith` assertion
   on the existing db mocks confirming the mount effect requests only visible-store ids (this one
   is the security-relevant half — it guards the leak this spec just closed); AC-P3 as a
   one-line `jest.spyOn` diff-check around a picker click. Optionally assert picker option label
   text + ordering to upgrade AC-P1 from PARTIAL.
4. **Fix or honestly re-label the AC-B6 pinning test.** *(Severity: a test that stays green after
   the bug it pins is fixed is a false signal, and this one guards the spec's single knowingly
   shipped incorrectness.)* Two acceptable resolutions, developer's choice: (a) replace it with a
   **component** test at the layer where R-B actually lives — `currentBrandId: null`,
   `visibleStores` spanning two brands, `recipes` populated only for the focal brand's catalog
   ids, asserting the rendered CoGS `theoretical` excludes brand B while `actual` includes it; or
   (b) keep the pure-function test but rewrite its comment to say it is documentation-only and
   **cannot** detect the OQ-4 fix. What must not ship is the current comment, which claims "pinned
   so it stays visible" and "this expectation is expected to change" — both false at the level the
   test runs.
5. **Two one-line hardening fixes in the new code.** *(Severity: Minor each, but both are inside
   this diff's own new surface, cost one line, and one of them protects the mitigation for the
   AC-B6 limitation above — which is why it lands before merge rather than after.)*
   - Architect **M-3**: `aggregateLabelFor`'s `.filter(Boolean)` on the brand-id set. Map to
     `s.brandId ?? null` and keep nulls in the set, so a scope mixing a brand-less store with a
     brand-A store falls through to the generic label instead of printing `2AM PROJECT · 2 stores`
     over it. `stores.brand_id` is nullable in the schema, so the state is representable, and this
     resolver is the *only* thing stopping the R-B-affected CoGS number from claiming a brand.
   - Security-auditor **Low #2**: drop `notes` and `logged_by` from
     `fetchWasteLogForStores`'s select and sparse-fill them like `itemName` / `loggedBy` already
     are. Data minimization on a fan-out across every visible store. Unlike Low #1 and Low #3,
     this creates **no asymmetry** — each sibling loader already selects only what it consumes.

### Should accompany the merge (cheap, no code risk)

6. **Record the native-tablet limitation in the spec (architect S-2).** The design explicitly
   asked for a native-tablet check and only web-at-1000px was performed. My judgement on
   "does this matter given the surface": **it does not block merge, but it must not be silent.**
   D3 names the desktop/tablet Cmd surface as the target and the section's declared scope is
   "web **and** native"; today's real users are on web, and the architect's analysis proves the
   web mechanism is correct-by-construction rather than lucky. So the proportionate action is a
   one-line accepted-limitation note in the spec ("desktop-web verified at 1000px + dark mode;
   native tablet stacking unverified") rather than holding the merge for a native build. If the
   panel does clip on Android, the remedy is a design change (portal / `Modal`-hosted panel), not
   a style tweak — which is exactly why it deserves to be written down instead of discovered by a
   user. Pair it with M-5 (no outside-press dismissal) in the same follow-up, since a backdrop
   `Pressable` is the standard fix for both.
7. **Nits, at the developer's discretion, in the same pass:** un-export `DashboardScope`; rename
   `ScopePickerProps.stores` → `visibleStores`; add M-4's one-line comment naming the
   no-comma-in-a-uuid assumption behind `scopeIdsKey.split(',')`. None of these change behavior.
   The code-reviewer's `computeScopedCogs` short-circuit asymmetry and architect M-2 (`delta`'s
   extra `.toFixed(2)`) were both explicitly filed as "no change requested" — leave them.

### CI gates — status and what to confirm

**Nothing has been pushed.** All 13 files are staged in the working tree on `main`, uncommitted,
so the CLAUDE.md post-push CI rule has not engaged yet and there is no red gate to report.
After the fix pass is committed and pushed, confirm **all three** before treating this as landed:

- `.github/workflows/test.yml` — must be green on `main`. It gains three jest suites plus
  whatever #1-#4 add; `typecheck:test` is a gate jest alone misses.
- `.github/workflows/db-migrations-applied.yml` — content-wise a genuine **no-op** for this spec
  (zero paths under `supabase/migrations/`, independently verified by both the architect and the
  security-auditor), but the hard rule is about the gate's *latest run on main*, not about this
  spec's diff. It must be green regardless.
- `.github/workflows/e2e.yml` — green as of `63dd9ab` but **not yet promoted into the CLAUDE.md
  gate checklist**, so it will not be caught by the standard two-gate check. This spec changes
  what renders on default Dashboard load and repairs `e2e/dashboard-window.spec.ts` to match
  (spec Risk R1/R-G: "e2e breakage is guaranteed, not hypothetical"), which makes it the single
  most likely gate to catch a mistake here. **Check it manually post-push.**

## Out of scope for this review

Correctly deferred — these were named as deferrals by the PM/architect *before* implementation
and nothing in the four reviews changes that assessment:

- **AVG FOOD COST % is still a mock** (`30 + (entries.length % 5)`), and `all` mode now averages
  it across stores (spec R4 / architect R-C). Still correctly deferred: it is strictly more honest
  than today's *focal-store* mock under an *All stores* title, and an honest number needs daily
  rollups plus a revenue-weighting decision. The `SYNTHETIC_KPI_SERIES` comments were updated to
  say the mock is now aggregated, which was R-C's easy-to-forget requirement — the architect
  confirms it landed. → **OQ-4 follow-up spec.**
- **The 4 synthetic KPI sparklines** — `synthSeries` stays, re-seeded by `scopeKey`. Same
  rationale. → **OQ-4.**
- **The super-admin / All-brands CoGS theoretical gap (R-B).** Correctly deferred and now
  documented in three layers (the `computeScopedCogs` docblock, the call site, and AC-B6). The
  architect withdrew his request for a PM amendment on the grounds that code-level documentation
  is more durable than spec prose — I agree. Note the residual he flagged: the label mitigation
  covers the *multi*-brand case only; a single-brand scope whose recipes aren't the loaded ones
  would still label confidently. That path is currently unreachable, and it is a note for the
  OQ-4 spec, not a finding here. The *test* for this limitation is a must-fix (#4) even though the
  limitation itself stays deferred.
- **Security Low #1 (transport failure → `$0`) and Low #3 (no `.limit()`).** Both are
  **pre-existing and shared byte-for-byte by all four sibling cross-store loaders**
  (`fetchEodSubmissionsForStores`, `fetchPosImportsForStores`, `fetchOrderScheduleForStores`,
  `fetchOrderSubmissionsForStores`), and the warn-and-return-`[]` posture was locked deliberately
  by the architect (§3: "do not call `notifyBackendError`"). The auditor's own words: filing them
  against this spec's helper alone "would just create asymmetry." → **One follow-up spec covering
  all five loaders**, distinguishing "loaded, empty" from "failed to load" and rendering an
  em-dash instead of a zero. Note the auditor established the failure direction is under-report
  (fail-closed) and that no *authorization* failure can be masked, because RLS denials are silent
  row filters rather than errors.
- **R-A: `WasteEntry.timestamp` as a locale string on the focal half.** Pre-existing; this spec
  contains it (cross-store rows carry raw ISO, and the new `isFinite` guard makes the drop
  explicit). The architect re-affirms the follow-up: make `timestamp` ISO end-to-end and format at
  the renderer — it touches `WasteLogSection.tsx:218` and `:608`, which is why it is its own spec.
  His M-1 warning stands: **do not** "fix" it by dropping the focal-last merge, which would trade
  a locale bug for a staleness bug. Item #1 above tests the *guard*, not the underlying asymmetry.
- **R2 staleness in all-stores mode** (non-focal stores are mount-time only), **per-store
  food-cost targets** (`TARGET_FOOD_COST_PCT_DEFAULT = 30`), **a global `'__all__'` store mode**,
  **a period selector**, and **any phone UI change** — all explicitly out of scope by owner
  decision or pre-existing follow-up. Confirmed untouched by three reviewers independently
  (`useStore.ts`, `TabStrip.tsx`, `TitleBar.tsx`, `PhoneDashboard.tsx` and its acReg test all
  outside the diff). The phone did get the OQ-1 fix for free — its KPIs are now single-store
  correct under its single-store header — with zero phone-file edits.
- **`brandNameFor` / `TitleBar` near-duplication** — noted in the new function's docblock as a
  cheap follow-up; refactoring `TitleBar` (which needs initials, not names) was correctly kept
  out of AC-R2's blast radius.
- **Process note for the PM, not a code finding:** AC-B6's acceptance-criterion text was amended
  by the implementer rather than the PM. The wording is faithful to what the architect's §12.3
  requested and is explicitly labeled "(architect R-B, recorded at build time)", so nothing is
  misrepresented — but an AC edited by the implementer to describe shipped behavior is a pattern
  the owner should be aware of, not one to normalize silently.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 5 must-fix items, top: extract + test the waste reducer (closes architect S-1, code-reviewer's duplicated predicate, and AC-S3/AC-B3 in one change — today `× subUnitSize` could be added there and pass all 2383 jest tests and both e2e projects).
payload_paths:
  - specs/159-dashboard-scope-picker/reviews/release-proposal.md
