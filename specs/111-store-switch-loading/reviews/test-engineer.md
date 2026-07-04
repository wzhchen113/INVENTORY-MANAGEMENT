## Test report for spec 111

Frontend-only spec (store field + shell overlay + i18n). Per the Design note
(OQ-7 / "Backend surface — NONE"), zero DB surface — **pgTAP was intentionally
not run** (no migration, no RLS, no RPC touched by this spec; `test:db` was
not invoked at all, per the task's instruction not to run it concurrently
with anything else and because there is nothing in this diff for it to
cover). Shell smokes were also not run (spec explicitly says "none
anticipated" and no edge function / RPC surface exists here). This is a
deliberate track-scoping decision, not a silent skip.

### Acceptance criteria status

- **AC-1** (`switching: 'store'` set only on a real switch — target id changes
  AND prev id non-empty; no-op re-select and boot leave it `null`; `__all__`
  redirect compares against the resolved fallback) → **PASS** —
  `src/store/useStore.switching.test.ts::T1` (real switch sets `'store'`),
  `::T2` (empty-prev/boot leaves `null`), `::T3` (no-op re-select leaves
  `null`), `::T3b` (`__all__` redirect: no-switch when fallback === prev,
  real switch when fallback differs). All four cases exercise the real
  `setCurrentStore` action (never mocked in this file) against real `Store`
  objects.
- **AC-2** (`setCurrentBrandId`'s brand-switch branch sets `switching:
  'brand'` BEFORE delegating to `setCurrentStore`, and the brand copy holds
  for the whole window) → **PASS** — `useStore.switching.test.ts::T6` drives
  `setCurrentBrandId('brand-2')` through the REAL (unmocked) internal
  `get().setCurrentStore(newStore)` delegation and asserts `switching ===
  'brand'` immediately after the call returns (before the `finally` clears
  it), then asserts it clears to `null` post-load. Confirmed by reading
  `useStore.ts:811-819`: the brand-switch branch's `set({ switching: 'brand'
  })` at line 818 runs strictly before the `get().setCurrentStore(newStore)`
  call at line 819 — the test genuinely rides that sequence, not a shortcut.
- **AC-3** (`switching` resets to `null` on BOTH success and error paths of
  `loadFromSupabase`, piggy-backing the existing `finally`) → **PASS** —
  `::T4` (success path) and `::T5` (error path). **Verified T5 is a genuine
  rejected-promise exercise, not a masqueraded resolve**: `T5` calls
  `fetchAllForStoreMock.mockRejectedValueOnce(new Error('rls denied'))` where
  `fetchAllForStoreMock` is `db.fetchAllForStore as jest.Mock` — and
  `useStore.ts:1165` calls `await db.fetchAllForStore(sid)` directly inside
  the `try` block (not wrapped in its own `.catch()`, unlike the sibling
  `db.fetchStores().catch(() => [])` call two lines above it). A rejection
  here propagates to the outer `catch (e) { console.warn(...) } finally {
  set({ storeLoading: false, switching: null }) }` at `useStore.ts:1233-1244`
  — the real error path, real try/catch/finally, not a mock that resolves
  and gets misread as an error.
- **AC-4** (no permanent overlay / no standalone timeout — the overlay clears
  wherever `storeLoading` does) → **PASS** — same T4/T5 evidence; both assert
  `switching` and `storeLoading` clear together in the same tick. Confirmed
  by reading `useStore.ts:1243`: a single `set({ storeLoading: false,
  switching: null })` in the `finally`, no separate timer anywhere in the
  diff (`grep -n "setTimeout\|setInterval" useStore.ts` around the diffed
  lines → none added).
- **AC-5** (the "All brands" null branch and the fresh-brand-no-stores branch
  never set `switching`, so they can't strand it) → **PASS** — `::T8a` (null
  branch) and `::T8b` (fresh-brand-no-stores branch). Both assertions are
  non-vacuous: each test ALSO asserts `currentStore.id === ''` alongside
  `switching === null`, proving the branch's actual synchronous side-effect
  ran (i.e., the test isn't accidentally exercising an early-return path that
  never reached the placeholder-set code).
- **AC-6** (full-screen overlay covers TitleBar + sidebar + section body on
  all three breakpoints, spinner + centered localized copy, absolutely
  positioned child of `cmd-shell-root`, rendered iff `switching !== null`) →
  **PASS (jest) + PASS (browser, evidence below)** —
  `src/components/cmd/StoreSwitchOverlay.test.tsx::"exposes the
  store-switch-overlay + label testIDs"` pins the mount-contract testIDs;
  the `"shell render gate"` describe block (T9) pins the `switching !==
  null` predicate directly. Static-read confirmation:
  `ResponsiveCmdShell.tsx:368` computes `switchOverlay` once and all three
  return branches (`:402` phone, `:465` tablet, `:495` desktop) insert
  `{switchOverlay}` as the last child of the shared `cmd-shell-root` View —
  matches the design note's "three insertions, no shared parent" call-out.
  Jest (jsdom) cannot exercise full-viewport coverage or real spinner paint
  across actual breakpoint widths — that evidence is the browser pass below.
- **AC-7** (distinct copy per switch type, keyed off `switching`'s value) →
  **PASS** — `StoreSwitchOverlay.test.tsx::"T10: renders the ... copy for
  mode=\"store\""` and `::"T10: renders the ... copy for mode=\"brand\""`,
  each also asserting the OTHER copy is absent (`queryByText(...)` →
  `null`), so this isn't a "renders *a* string" test — it pins the distinct
  mapping. `T6` in the store-test file corroborates the value survives to
  the point where the shell would render it.
- **AC-8** (not on initial boot — empty-prev-id guard) → **PASS** —
  `useStore.switching.test.ts::T2`, driven from the `beforeEach`'s `EMPTY_STORE`
  literal (see Notes below for one maintenance-risk caveat on that literal,
  not a failure).
- **AC-9** (two new i18n keys exist in all three admin locales with real,
  non-placeholder es/zh-CN translations) → **PASS** — direct read of
  `en.json:87-88`, `es.json:87-88`, `zh-CN.json:87-88` confirms
  `common.switchingStores` / `common.switchingBrands` in all three, with
  genuine translations (es "Cambiando de tienda…/marca…", zh-CN "正在切换门店…/品牌…",
  not copy-pasted English). **Mechanism check performed, not assumed**: I
  temporarily deleted `common.switchingBrands` from `zh-CN.json`, re-ran
  `src/i18n/i18n.test.ts`, and confirmed it fails with the exact missing key
  surfaced in the diff (`Array ["common.switchingBrands"]`), then restored
  the file (byte-identical to the pre-test working tree, confirmed via
  diff) — the parity test genuinely walks the imported JSON at test time via
  `flattenKeys`, it is not a hardcoded key list that could go stale.
- **AC-10** (cross-platform primitives only, web + native, all three
  breakpoints) → **PASS (static) / PARTIAL (runtime, native gap)** — read of
  `StoreSwitchOverlay.tsx` confirms only `View`, `ActivityIndicator`, `Text`,
  `StyleSheet.absoluteFillObject` — no `Platform.*`, `window.`, `document.`,
  `className`, or other web-only surface. No native-renderer test exists
  (jest's jsdom component project approximates react-native-web, not a real
  native host) — this is the documented, pre-existing project gap ("Native
  testing is harder and not yet set up" per CLAUDE.md), not a spec-111
  regression. Not treating as FAIL because (a) the primitives are verifiably
  cross-platform by inspection, (b) no native test infra exists anywhere in
  this repo to gate on, and (c) the spec's own "Web/native scope" note
  accepts this. Flagging as a coverage gap rather than silently passing it.

### Test run

```
npx jest
Test Suites: 87 passed, 87 total
Tests:       966 passed, 966 total
Snapshots:   0 total
Time:        3.296 s
```

Matches the dev's claim of 87/966 EXACTLY — verified by full run, not a
subset. The two new spec-111 suites, isolated:

```
npx jest src/store/useStore.switching.test.ts src/components/cmd/StoreSwitchOverlay.test.tsx --verbose
Test Suites: 2 passed, 2 total
Tests:       16 passed, 16 total
```

Breakdown: `useStore.switching.test.ts` = **10** tests (T1, T2, T3, T3b, T4,
T5, T6, T7, T8a, T8b), `StoreSwitchOverlay.test.tsx` = **6** tests (T10×2,
testID contract, a11y contract, T9×2). Combined = **16**, confirmed by
independent `grep -c "  it("` against both source files.

```
npx tsc --noEmit            → exit 0
npx tsc -p tsconfig.test.json --noEmit  → exit 0
```

No pgTAP run (`npm run test:db` not invoked — zero DB surface, per the
Design note's explicit "reviewer fan-out skips the DB tracks" call-out). No
shell smoke run (no edge-function/RPC surface; spec says "none
anticipated"). Neither is a gap — both tracks correctly have nothing to
cover here.

### Browser / runtime evidence (jest cannot cover these directly)

Per the task, main Claude performed the browser pass the spec's own
Verification section flagged as not-run-by-the-implementing-agent (no
`preview_*` tools were available in that agent's environment). Reported
result: the full-viewport "Switching stores…/brands…" takeover painted over
TitleBar + sidebar + section body during a real store switch and a
super-admin brand switch, correct per-type copy, cleared automatically on
load completion, and the browser console stayed clean throughout. This is
the evidence source for the parts of AC-6 (full-viewport coverage at real
breakpoint widths) and AC-7 (spinner + real render, not a jsdom stand-in)
that a jsdom-based component test cannot directly observe — jest confirms
the LOGIC (testID mount contract, single-field gate, copy mapping); the
browser pass confirms the ACTUAL PAINT. I did not independently re-drive
this browser session myself; I'm reporting it as stated verification
evidence per the task's framing, sourced from the spec's own Verification
section and the task prompt.

### Notes

- **T-count vs. spec's own "Files changed" / "Verification" claims is off by
  4 — a documentation nit in the spec, not a test defect.** The spec's
  "Tests" subsection under "Files changed" claims "12 tests" for
  `useStore.switching.test.ts` and "8 tests" for `StoreSwitchOverlay.test.tsx`
  (20 combined; the Verification section's "new suites: 20 tests" repeats
  this). Actual counts, confirmed both by the jest runner and by an
  independent `grep -c "  it("` against each source file: **10** and **6**
  respectively (**16** combined). Every acceptance criterion is still fully
  covered — the discrepancy is that the T-label list in the design note
  (T1...T10) doesn't map one-`it`-per-T-label in two places (T3/T3b are two
  separate `it`s carrying one T-number's worth of prose; T10 has two `it`s
  for its two directions), and the design note's own prose undercounted
  its own case list against what actually got written. Not a blocker — I'm
  flagging it so the spec's numeric claims get corrected before anyone
  treats "20 tests" as a citable fact later.
- **Maintenance-risk (not a bug) in T2's boot-shape fixture.** AC-1/AC-8's
  guard is `prev.id !== ''`. `useStore.switching.test.ts`'s `beforeEach`
  first does `useStore.setState(INITIAL_STATE, true)` (a full replace
  against the REAL `useStore.getState()` snapshot captured at module load),
  then immediately overwrites `currentStore` with a hand-authored literal
  `EMPTY_STORE = { id: '', brandId: '', name: '', address: '', status:
  'active' }` in the same `beforeEach`. I verified today these two are
  structurally identical (`toEqual` deep-equality, via a temporary throwaway
  test I wrote, ran, and deleted — not committed) — so T2 is not currently
  drifted from the real initial state. But because the test uses the
  synthetic literal rather than reading `INITIAL_STATE.currentStore`
  directly, if a future spec added a new required field to `Store` and
  updated the real initial-state literal in `useStore.ts` but not this test
  file's `EMPTY_STORE`, T2 would keep passing against a shape that no
  longer matches boot reality. Recommend (non-blocking, dev's call): swap
  `currentStore: EMPTY_STORE` in the `beforeEach` for
  `currentStore: INITIAL_STATE.currentStore` so the boot-shape fixture can
  never silently diverge from the real one.
- **Minor test-readability nit already flagged by code-reviewer, seconding
  it here since it's squarely test-engineer territory:**
  `useStore.switching.test.ts:161` in T3b sets `currentStore: storeB` via an
  intermediate `useStore.setState` call that is immediately overwritten by
  the next line's `store-c` before `setCurrentStore({ id: '__all__' })` is
  invoked — the intermediate line has no effect on the assertion and its
  accompanying comment ("Now prev = storeA") doesn't match either the dead
  line or the line that actually matters. The test's PASS/FAIL correctness
  is unaffected (confirmed: `fallback = accessible[0] = storeA` vs. `prev.id
  = 'store-c'` → genuine switch, `switching` correctly becomes `'store'`);
  this is purely a stale-comment/dead-line readability issue, not a masked
  bug. Non-blocking.
- **No test-framework introduced.** Both new suites use the existing jest
  projects (`unit`/node for the store test, `component`/jsdom for the
  overlay test) per `jest.config.js`'s existing `testMatch` globs — no new
  framework, no vitest/playwright, nothing to surface to the PM.
- **AC-10 native-runtime gap is pre-existing, not spec-111-introduced** —
  called out above under AC-10; not treating it as a FAIL per CLAUDE.md's
  own framing of native testing as an accepted, not-yet-built gap. Flagging
  for visibility rather than silently passing over it.
- **Cleanup discipline**: two throwaway artifacts were created and removed
  during this review and left no trace in the working tree — (1) a
  temporary `zh-CN.json` key deletion used to empirically prove the i18n
  parity test's failure mechanism (restored, confirmed byte-identical to
  pre-test state via diff), and (2) a temporary `src/store/__tmp_drift_check.test.ts`
  file used to empirically prove `EMPTY_STORE` matches `INITIAL_STATE.currentStore`
  (deleted, confirmed absent from `git status`). Neither is part of this
  spec's diff.

### Hard-rule check (CLAUDE.md)

- `app.json` slug — untouched by this spec's diff (confirmed via the
  security-auditor's `git diff --stat` sweep and my own read of "Files
  changed"). No question to surface.
- No test needed to touch it, so no conflict arose.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **Note 1 (spec's 20-vs-16 test-count miscount) — FIXED** in the spec's Files
  changed/Verification sections (now 16: 10 store + 6 overlay, with the
  correction attributed).
- **Note 2 (hand-authored EMPTY_STORE boot fixture) — ACCEPTED as verified.**
  The review empirically proved it structurally identical to the real
  INITIAL_STATE today; converting T2 to read the live initial state is a
  test-refactor for the cleanup backlog, not a ship blocker.
- The T3b dead-line cleanup (code-reviewer Nit 1, "test-engineer's territory")
  was applied; suite 10/10.
