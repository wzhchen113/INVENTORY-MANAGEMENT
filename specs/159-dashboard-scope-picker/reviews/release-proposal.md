# Release proposal — spec 159 (Dashboard scope picker)

Release coordinator, 2026-08-16. **Second pass — supersedes the FIXES_NEEDED verdict of the
first pass.** Sources read in full: `specs/159-dashboard-scope-picker.md` (including the new
"Fix pass" section), all four reviewer files in `specs/159-dashboard-scope-picker/reviews/`
(the rewritten `test-engineer.md` plus the unchanged `code-reviewer.md`,
`security-auditor.md`, `backend-architect.md`), and the changed source itself. Advisory only
— no spec field, source file or reviewer file was modified by me.

I did not take the break-and-revert report at face value. Every sensitivity claim below was
re-derived from the fixtures and the render path.

## Verdict

verdict: SHIP_READY
rationale: All five must-fix items are applied and independently verified effective — the two
tests whose insensitivity was the original block now provably bite, the one edit outside the
declared file set is inert, and no reviewer holds a Critical.

The first pass was a **coverage** block, not a correctness block: nobody found a defect in
shipped behavior. That block is now cleared. The 12 NOT-TESTED acceptance criteria are covered
by assertions I confirmed would fail on a regression, not by test names.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix, 4 Nits — **Should-fix now resolved.** The
  duplicated waste predicate is gone: `wasteWeek` (`DashboardSection.tsx:412`) and
  `wasteEventCount` (`:449`) both read one `scopedWaste` memo (`:408-411`) calling the single
  extracted reducer. Nits remain open by explicit choice (see out-of-scope).
- **security-auditor**: 0 Critical / High / Medium, 3 Low — **Low #2 now fixed.**
  `fetchWasteLogForStores`'s select list (`db.ts:857`) no longer requests `notes` /
  `logged_by`; both are sparse-filled, and a test pins the column list itself
  (`db.crossStoreLoaders.test.ts:334-340`) so a re-add fails CI rather than a code-review pass.
  Lows #1/#3 remain deferred as sibling-wide follow-ups, correctly.
- **test-engineer**: **BLOCK lifted → all ACs PASS except AC-P1 (PARTIAL).** 12 previously
  untested criteria closed; AC-V1/AC-V3/AC-I2/AC-I3 upgraded from PARTIAL. Full suite
  212 suites / 2399 tests (+16), both typecheck gates clean, Playwright 17/17 against the live
  local stack. One prose slip in the report, not a coverage gap: the AC-T1 line says
  `cmdSelectors.scopedRollups.test.ts` is "now 36 cases (was 24)" — the file actually holds
  30 `it(` blocks, which is 24 + 6 and matches the run output quoted in the same file. No test
  is missing; the "36" is a transcription error.
- **backend-architect**: 0 Critical, 2 Should-fix, 5 Minor — **S-1 resolved** (the waste
  reducer now has a test that catches the exact spec-104 R1 regression he described);
  **S-2 resolved as requested** (native-tablet stacking recorded as a written accepted
  limitation in the spec's Fix pass section, naming the portal/`Modal` remedy and pairing it
  with M-5, rather than silently shipped); **M-3 fixed** (`DashboardSection.tsx:626` keeps
  `null` brandIds in the distinct set and gates on `brandIds[0]` truthiness). M-1/M-2/M-4/M-5
  remain open by design.

### Verification of the two sensitivity claims (the original block)

**Item 1 — `sumScopedWaste` genuinely bites.** The reducer (`cmdSelectors.ts:1180-1196`) sums
`w.quantity * w.costPerUnit`, unbridged. The load-bearing fixture injects `subUnitSize: 6`
onto a row with `quantity: 4, costPerUnit: 10` and asserts `result.dollars` is `40`
(`cmdSelectors.scopedRollups.test.ts:456-466`). 4 × 10 = 40 unbridged; 4 × 10 × 6 = 240
bridged — the reported `Expected: 40, Received: 240` is arithmetically exactly what that
fixture produces, so the claim holds on my own derivation, not on the report. The other five
cases each carry a deliberately oversized poison row (999 × 999, 100 × 100), so a broken
scope filter, window cutoff or `isFinite` guard fails loudly rather than drifting.

**Item 4 — the AC-B6 component test genuinely bites.** I traced the render path rather than
trusting the red: `CogsCard` prints `$${Math.round(theoretical).toLocaleString()}`
(`DashboardSection.tsx:1092`), so the fixture's Towson-only $40 theoretical / $110 actual
render as the literal `$40` and `$110` the test asserts
(`DashboardSection.scopePicker.spec159.test.tsx:443-444`). Adding a recipe for the
out-of-brand catalog id raises Σtheoretical above 40, the `$40` text stops rendering, and the
assertion goes red — the mechanism is sound. The test runs at the layer where R-B actually
lives (`currentBrandId: null`, `visibleStores` spanning two brands, `recipes` covering one),
and it additionally asserts the hero title does not claim a brand, tying the M-3 mitigation to
the same case. The old pure-function test is now honestly re-labeled
(`cmdSelectors.scopedRollups.test.ts:285-303`): it states outright that it is
documentation-only, **cannot** become a regression guard, and points at the component test.
The false-signal finding is fully resolved.

**Item 3 — the Heatmap edit is inert.** Grep across the repo returns exactly two files
referencing `Heatmap`: its own definition and `DashboardSection.tsx`. The single-consumer
claim is verified, not asserted. The change is one `testID={`heatmap-row-${rIdx}`}` prop added
to an existing row `View` (`Heatmap.tsx:103-113`) — no style, structure, or prop-interface
change, and `testID` is render-inert. AC-R2 holds.

**The new assertions are real.** Spot-checked each: AC-S2/B2 flips `1 out · 1 low` →
`2 out · 1 low` across a scope switch; AC-S5/B5 walks `1/1` → `0/1` → `1/2` across three
scopes; AC-S8/B8 counts 1 → 2 rows with the out-of-brand store excluded; AC-V2 asserts the
exact fetch arg arrays and explicitly `not.toContain('store-3')` (the security-relevant half);
AC-S10/B10 assert exact string equality on `dashboard-hero-title` in all three label states.
The mechanical `queryByText`→`queryAllByText` rewrite visible in the tooling log is
strength-preserving — presence stayed presence (`.length > 0`), absence stayed absence
(`toHaveLength(0)`), with the pre-existing distinguishable `$1.0k`/`$2.0k`/`$3.0k` values and
their explicit absence assertions intact.

### One weakness I found that no reviewer named — non-blocking

**AC-P3's test is weaker than its description.** It does
`jest.spyOn(useStore, 'setState')` and asserts zero calls
(`DashboardSection.scopePicker.spec159.test.tsx:325-338`). But zustand actions close over the
raw `setState` reference captured at store-creation time, while `useStore.setState` is a
*property* on the bound hook — spying the property does not intercept `set(...)` inside an
action. I confirmed `setCurrentStore` (`useStore.ts:1406-1436`) uses the closure `set({...})`.
So a regression where the picker called `setCurrentStore` — the primary risk AC-P3 names —
would slip past this spy.

Why this does not hold the ship: `onSelect={setScope}` is a plain `React.useState` setter
(`DashboardSection.tsx:191`, `:709`), correct by construction and independently read by three
reviewers; and the path is indirectly guarded — a `setCurrentStore` regression would move
`currentStore.id`, firing the AC-P4 render-phase reset and flipping the AC-B9 test from 2
cards to 1. This is a partially-insensitive test, the same *class* as the original AC-B6
problem but far lower stakes: AC-B6's test gave a false green about a knowingly shipped
incorrectness, whereas this one guards behavior that is currently correct, directly
inspectable, and covered in effect elsewhere. Filed as a follow-up, not a block.

### AC-P1 — acceptable to ship as-is

The label-text/ordering gap was explicitly scoped optional in my first proposal, excluded from
the five items, and the test-engineer correctly declined to expand into it. My judgement on
whether to ship with it open: **yes.** Ordering is structural in the JSX (aggregate option
first, then `.map` over `visibleStores` — and that same ordering is what gives AC-B8 its
"in `visibleStores` order" guarantee, which the row-count test does cover); the aggregate
label's resolver branch is asserted through the hero-title tests, which exercise the identical
`aggregateLabelFor` function with a different fallback key; per-store option labels are
`store.name` data, not strings; and the e2e drives an option by testID, so existence is gated
on every run. The residual risk is a cosmetic, immediately-visible mislabel with no data
consequence. Close it opportunistically in the next spec that touches the picker's option
rendering.

## Recommended next steps (ordered)

SHIP_READY.

1. **Commit and push.** All changes are staged and uncommitted on `main`. Per the standing
   preference, the user runs the commit.
2. **Confirm the gates after the push** (see the section below — three of them, not two).
3. Optional follow-ups, none blocking ship:
   - Strengthen AC-P3 by one line: also assert `useStore.getState().currentStore.id` and
     `.currentBrandId` are unchanged after a pick. That catches the store-action path the
     `setState` spy structurally cannot see.
   - Scope the AC-B6 `$40` / `$110` queries to the CoGS card rather than the whole page. They
     bite today because nothing else in that fixture emits those strings; card-scoping makes
     that robust against future fixture growth.
   - Close AC-P1 (option label text + ordering).
   - Correct "36 cases" → "30 cases" in `reviews/test-engineer.md` if the file is kept as a
     record.

### CI gates — what to confirm after any eventual push

Nothing has been pushed yet, so the CLAUDE.md post-push rule has not engaged and there is no
red gate to report. After the push, confirm **all three** before treating this as landed:

- **`.github/workflows/test.yml`** — must be green on `main`. It gains the new and expanded
  jest suites; note `typecheck:test` is a gate that a plain jest run misses.
- **`.github/workflows/db-migrations-applied.yml`** — content-wise a genuine **no-op** for
  this spec (zero paths under `supabase/migrations/`, independently confirmed by the architect
  and the security-auditor, and re-confirmed here — the spec-159 source footprint contains no
  SQL). The hard rule is nevertheless about **each gate's latest run on `main`**, not about
  this spec's diff, so it must be green regardless.
- **`.github/workflows/e2e.yml`** — green as of `63dd9ab` but **not yet promoted into the
  CLAUDE.md gate checklist**, so the standard two-gate check will not catch it. **Check it
  manually.** This spec changes what renders on default Dashboard load and repairs
  `e2e/dashboard-window.spec.ts` to match (spec Risk R1: "e2e breakage is guaranteed, not
  hypothetical"), which makes it the single most likely gate to catch a mistake here. I
  verified the repair is in place and card-scoped (`dashboard-window.spec.ts:240-246`), and
  that it strengthened rather than weakened the spec-080 assertions.

## Out of scope for this review

Confirmed still deferred — I checked the source rather than assuming. The spec-159 footprint
is exactly `db.ts`, `cmdSelectors.ts`, `storeVisibility.ts`, `DashboardSection.tsx`,
`Heatmap.tsx`, `e2e/dashboard-window.spec.ts`, four test files and the three i18n catalogs.
Other "fix-pass" strings in the tree belong to specs 004 / 070 / 078, not this one.
**Nothing expanded into the correctly-deferred list.**

- **AVG FOOD COST % is still a mock** (`30 + (entries.length % 5)`), now aggregated across
  stores in `all` mode, with the `SYNTHETIC_KPI_SERIES` comments updated to say so. → **OQ-4.**
- **The 4 synthetic sparklines** — `synthSeries` intact, re-seeded by `scopeKey`. → **OQ-4.**
- **The R-B cross-brand CoGS gap itself** stays deferred; only its *test* was a must-fix, and
  that is now a real call-site guard. Documented in three layers.
- **Security Low #1 (transport failure → `$0`) and Low #3 (no `.limit()`).** Verified
  untouched: `fetchWasteLogForStores` still warns and returns `[]`, with no `.limit()` — which
  is correct, because fixing either here alone would create asymmetry with the four sibling
  loaders. → **one follow-up spec covering all five.**
- **R-A: `WasteEntry.timestamp` as a locale string on the focal half.** `fetchWasteLog` is
  untouched; the guard now lives in one place inside `sumScopedWaste`. The architect's M-1
  warning stands: do not "fix" this by dropping the focal-last merge. → own spec.
- **Native-tablet ScopePicker stacking (architect S-2) and M-5 (no outside-press dismissal).**
  Now a written accepted limitation in the spec, naming the backdrop-`Pressable` /
  portal remedy. Noted, not silently shipped — which is exactly what was asked for.
- **R2 staleness in all-stores mode**, **per-store food-cost targets**, **a global `'__all__'`
  mode**, **a period selector**, **any phone UI change** — all untouched. `useStore.ts`,
  `TabStrip.tsx`, `TitleBar.tsx`, `PhoneDashboard.tsx` and its acReg test are all absent from
  the footprint; the phone still got the OQ-1 fix for free with zero phone-file edits.
- **Code-reviewer nits and architect M-1/M-2/M-4** — left open by explicit choice; M-2 and the
  `computeScopedCogs` short-circuit asymmetry were filed "no change requested".
- **Process note for the PM (unchanged from the first pass):** AC-B6's acceptance-criterion
  text was amended by the implementer rather than the PM. Faithful to what the architect's
  §12.3 asked for and explicitly labeled, so nothing is misrepresented — but an AC edited by
  the implementer to describe shipped behavior is a pattern to be aware of, not to normalize.
- **Housekeeping, not a finding:** `.claude/settings.local.json` accumulated tool-permission
  entries during the fix pass. It is gitignored (`.gitignore:17`), so it will not be committed.

## Handoff
next_agent: NONE
prompt: SHIP_READY — all 5 must-fix items verified applied and effective by independent derivation (the waste reducer's unbridged assertion and the AC-B6 call-site guard both provably bite; the Heatmap testID is inert with a single consumer); one non-blocking follow-up found (AC-P3's `useStore.setState` spy cannot see zustand action-internal `set()`, so a `setCurrentStore` regression would slip past it — behavior is correct by construction and indirectly guarded). Confirm test.yml, db-migrations-applied.yml (content no-op, but the rule is per-gate latest run on main) and e2e.yml (manual — green at 63dd9ab, not yet promoted) after the push.
payload_paths:
  - specs/159-dashboard-scope-picker/reviews/release-proposal.md
