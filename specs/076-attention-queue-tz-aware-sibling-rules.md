# Spec 076: Attention queue — make `eod_missing` and `food_cost_streak` tz-aware (sibling-rule parity with spec 074)

Status: READY_FOR_REVIEW

## User story

As a store manager for a NY-timezone brand checking the Dashboard between
00:00 ET and 05:00 ET (when UTC has already rolled to "tomorrow"), I want
the per-store attention queue's `eod_missing` and `food_cost_streak` rules
to evaluate "today" in the brand's local timezone — same as the
`unconfirmed_po` rule that spec 074 already made tz-aware — so I never see
"EOD missing today" flicker on or off depending on which side of UTC
midnight the wall clock is on.

Concrete scenario: it's 02:00 ET on Tuesday, 2026-05-26. The UTC date is
already 2026-05-26 by 04:00 UTC, but in ET it's still Monday until 05:00
UTC. Today the queue's `eod_missing` rule (lines 757-787) computes
`todayISO = '2026-05-26'` and `yesterdayISO = '2026-05-25'` via
`now.toISOString().slice(0,10)` — the UTC date. So at 02:00 ET it would
ask "did the operator submit EOD for 2026-05-26 yet?" when in ET-local
terms the operator hasn't even finished Monday's shift. After this spec,
both `eod_missing` and `food_cost_streak` derive their ISO anchors via
`getLocalDateISO(timezone, now)`, matching the rule spec 074 ratified for
`unconfirmed_po`.

## Acceptance criteria

- [ ] `computeAttentionQueue` derives `todayISO` and `yesterdayISO` for the
  `eod_missing` rule using `getLocalDateISO(timezone, now)` and a one-day
  back-step of the local-tz date — NOT `now.toISOString().slice(0,10)`. The
  one-day back-step preserves the existing semantic: "yesterday" is the
  calendar day before "today" in `timezone`.
- [ ] `computeAttentionQueue` derives the `startSevenISO`/`endISO` window
  for the `food_cost_streak` rule using `getLocalDateISO(timezone, now)`
  for the end anchor and a six-day back-step of the local-tz date for the
  start anchor. The product semantic is unchanged: a rolling 7-day window
  ending on "today in `timezone`", streak metric counted backward from the
  end. The window is NOT week-aligned.
- [ ] `computeStoreFoodCostVariancePp` is NOT modified. Its public contract
  takes ISO date strings (start, end) and returns one number per day in
  the inclusive range. The fix is at the call site (cmdSelectors.ts line
  ~822) — pass the tz-correct ISO strings; the helper's internal UTC
  date-walking is byte-identical to a tz-naive walk over the same ISO
  strings because both produce `YYYY-MM-DD` strings from a UTC-anchored
  cursor. (The helper produces correct output as long as input ISOs are
  correct ISO calendar dates, which they are.)
- [ ] `isPastDeadline(now, store?.eodDeadlineTime)` continues to receive
  the raw `now: Date` (not a tz-shifted Date). The deadline-vs-now check
  is wall-clock-instant math, not calendar-date math — out of scope for
  this fix.
- [ ] The two-line eod_missing "yesterdayISO" derivation no longer uses
  `new Date(now); yesterday.setDate(yesterday.getDate() - 1)` —
  `setDate(-1)` on a UTC-anchored Date races the same UTC-rollover bug
  this spec is fixing. Replace with a `YYYY-MM-DD` string back-step
  computed from `getLocalDateISO(timezone, now)` (parse the literal,
  decrement the day field with proper month/year carry, re-emit). The
  architect chooses the exact shape (helper utility vs inline) in the
  design pass.
- [ ] The inline comment at `cmdSelectors.ts:864-873` describing the
  "pre-existing inconsistency" between `unconfirmed_po`'s tz-aware
  windowing and the two siblings' tz-naive windowing is replaced with a
  short note that ALL THREE rules now derive their ISO anchors via
  `getLocalDateISO(timezone, now)`, ratified by spec 076. The "DO NOT
  'fix' the inconsistency drive-by" warning is removed (the inconsistency
  no longer exists).
- [ ] No changes to the rule SHAPES — `eod_missing` remains a same-day
  boolean (with yesterday-fallback for the "2 days running" copy);
  `food_cost_streak` remains a rolling-7d streak metric. Spec 074's
  Monday-reset windowing semantic is NOT applied to either rule. (If a
  future spec wants weekly-aligned streaks, that is a separate product
  decision, not a tz-correctness fix.)
- [ ] Jest unit test: `eod_missing` rule with fixture `now =
  new Date('2026-05-26T04:00:00Z')` (= 2026-05-26 00:00 EDT — first second
  of Tuesday in NY, but 00:00 UTC = already-Tuesday in UTC also). With
  `timezone = 'America/New_York'`: `todayISO` should be `'2026-05-26'` and
  `yesterdayISO` `'2026-05-25'`. (Before the fix: same answer at this
  exact instant because both happen to agree. The next test case
  separates them.)
- [ ] Jest unit test: `eod_missing` rule with fixture `now =
  new Date('2026-05-26T03:00:00Z')` (= 2026-05-25 23:00 EDT — Monday night
  in NY, but already Tuesday in UTC). With `timezone = 'America/New_York'`:
  `todayISO` MUST be `'2026-05-25'` and `yesterdayISO` MUST be
  `'2026-05-24'`. (Before the fix: would have been `'2026-05-26'` /
  `'2026-05-25'`, which would have surfaced a "EOD not yet submitted
  today" alert for a Tuesday that hadn't begun in NY-local terms.)
- [ ] Jest unit test: `food_cost_streak` rule with fixture `now =
  new Date('2026-05-26T03:00:00Z')` and `timezone = 'America/New_York'`.
  The 7-day window MUST be `[2026-05-19, 2026-05-25]` in `timezone`, NOT
  `[2026-05-20, 2026-05-26]`. The end of the streak window matches the
  NY-local "today" (`2026-05-25`).
- [ ] Jest unit test: cross-day-boundary streak regression guard. With a
  fixture where the operator's variance pp ≥ 1 for the five NY-local days
  `[2026-05-21..2026-05-25]` and is below threshold for `2026-05-19` and
  `2026-05-20`, the streak count emitted at `now =
  new Date('2026-05-26T03:00:00Z')` MUST be 5 (sev: `'high'`). Before the
  fix, the same fixture would have computed against a window ending
  2026-05-26 — picking up an extra zero-signal day and potentially
  truncating the streak to 4. The test pins the rolling-window behavior
  at a known clock + timezone fixture.
- [ ] Jest unit test: existing `unconfirmed_po` tests in
  `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` continue to pass
  unmodified. (Spec 074's tests don't exercise the two sibling rules, and
  the sibling-rule changes don't touch the `unconfirmed_po` block.)
- [ ] `tsc --noEmit` passes (no signature changes; only internal
  derivation changes).
- [ ] `tsc -p tsconfig.test.json --noEmit` passes.

## In scope

- Modify `src/lib/cmdSelectors.ts:computeAttentionQueue`:
  - Replace lines 753-756 (current `todayISO`/`yesterdayISO` derivation
    via `now.toISOString().slice(0,10)` + UTC-Date-arithmetic-back-step)
    with a tz-aware derivation that uses `getLocalDateISO(timezone, now)`
    and a literal-date one-day back-step. The architect decides whether
    the back-step is inline or in a small new helper
    (`getLocalDateISOMinus(timezone, now, days)` or similar).
  - Replace lines 819-821 (current `startSeven` UTC-Date-back-step + ISO
    slice) with the analogous tz-aware six-day back-step ending at
    `getLocalDateISO(timezone, now)`.
  - Replace the inline `unconfirmed_po` comment at lines 864-873
    describing the now-resolved inconsistency. New copy ratifies that all
    three rules use `getLocalDateISO`-derived anchors (ref spec 076).
- Add jest unit tests covering the cases in the acceptance criteria.
  Architect picks the test file home: extend
  `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` to a more general
  `cmdSelectors.attentionQueue.test.ts`, OR add a separate
  `src/lib/cmdSelectors.eodAndStreak.test.ts`. Either shape works;
  developer's call after architect ratifies.

## Out of scope (explicitly)

- **No change to `computeStoreFoodCostVariancePp`.** The helper takes ISO
  string inputs and walks dates UTC-internally. The fix is at the call
  site; the helper's contract and implementation are unchanged. (Reason:
  the helper is also consumed by the food-cost heatmap and KPI strip in
  `DashboardSection.tsx`; changing its internals is a larger surface and
  not required for tz-correctness on the streak rule.)
- **No change to `isPastDeadline(now, store?.eodDeadlineTime)`.** The
  deadline comparison is wall-clock-vs-deadline-time math; the existing
  implementation already handles tz correctly (per spec 060). Rationale
  documented in this spec so a future reader doesn't "fix" it drive-by.
- **No weekly-alignment of either rule.** Spec 074's Monday-reset shape
  applies ONLY to `unconfirmed_po`. `eod_missing` stays a same-day +
  yesterday-fallback boolean. `food_cost_streak` stays a rolling 7d
  metric. Week-aligning either is a different product change requiring
  its own spec.
- **No change to `low_out_stock` or `expiry`.** Both are already
  current-state or already-tz-correct via the inline literal-date parser
  at line 934-936 (per spec 010).
- **No change to `useStore.timezone` slice.** Still brand-global; per-store
  timezone remains a follow-up spec (carried over from spec 074 §Out of
  scope).
- **No change to data model, RLS, RPC, edge functions, db.ts, realtime,
  or DashboardSection.tsx visual layout.** This is a pure-frontend
  selector-logic fix. The DashboardSection call site already threads
  `timezone` per spec 074; no signature change needed.
- **No change to the i18n catalogs.** No new strings. Only the inline
  code comment is updated.
- **Spec 075 doc divergence (UTC vs NY in the design code-block).** The
  user's request flagged the spec-075 doc still references NY in its
  design code-block while the shipped migration uses UTC. That is a
  separate trivial follow-up — not folded into this spec because (a) it
  touches a different surface (spec doc, not code), (b) it has no
  product-behavior impact (architect-approved as functionally
  equivalent), and (c) keeping this spec tightly scoped to the
  cmdSelectors fix matches the architect's request in spec 074 §Out of
  scope. A 1-line doc-patch PR can land independently.

## Open questions resolved

- Q: Confirm product semantics unchanged — eod_missing stays same-day
  boolean, food_cost_streak stays rolling-7d. The fix is correctness-only.
  → A: Yes. The only change is which timezone "today" / "yesterday" /
  "7 days ago" resolve in. No weekly-alignment, no shape change.
- Q: Should "days running" in `eod_missing` ("EOD missing 2 days running")
  also use tz-local dates? → A: Yes. Both `todayISO` and `yesterdayISO`
  switch to tz-local derivation. (Note: re-reading the code, the rule
  actually maxes out at 2 days — same-day boolean with a yesterday-
  fallback for the streak copy. The "N days running" framing in the
  user's request was slightly off — the rule never counts more than 2 —
  but tz-aware "yesterday" is still the correct fix.)
- Q: Replace the inline comment at `cmdSelectors.ts:864-873`? → A: Yes.
  The current "pre-existing inconsistency" warning becomes inaccurate
  after this spec. Replace with a short note that all three rules use
  `getLocalDateISO(timezone, now)` (ratified by spec 076).
- Q: Test fixtures — pass `'America/New_York'` as the timezone? → A: Yes.
  Matches the existing `useStore.timezone` default and the spec 074 test
  conventions. Tests use UTC ISO instants for `now` (e.g.
  `new Date('2026-05-26T03:00:00Z')`) and the timezone arg drives the
  local-tz date computation, so the assertions are deterministic and
  framework-clock-independent.
- Q: Edge case at 00:00 UTC on a NY winter day (= 19:00 ET previous day).
  Confirm: before the fix, eod_missing would say "missing today" for
  UTC's "today" (= ET's "tomorrow") which is wrong. After: correctly
  references ET's "today." Confirms user intent? → A: Yes. This is
  exactly the bug the spec exists to fix. The acceptance criteria pin
  the `2026-05-26T03:00:00Z` (= Mon 23:00 ET) instant as the canonical
  test point.
- Q: Tests for the food_cost_streak fix — pin the rolling-window behavior
  at a known clock + timezone fixture? → A: Yes. The cross-day-boundary
  streak regression guard test (acceptance criterion #8) pins this.
- Q: Bonus follow-up — fold in spec 075 UTC-vs-NY doc patch? → A: No.
  Surfaced as a separate trivial follow-up (see "Out of scope" rationale).

## Dependencies

- `src/utils/weekWindow.ts` — already exports `getLocalDateISO(tz, now)`
  (added by spec 074). No new helper file needed. A small internal
  back-step helper may live alongside it OR be inlined in cmdSelectors —
  architect's call.
- `src/lib/cmdSelectors.ts:computeAttentionQueue` — already accepts
  `timezone: string` (added by spec 074). Signature is unchanged by this
  spec.
- `src/store/useStore.ts` — `timezone` slice unchanged.
- `src/screens/cmd/sections/DashboardSection.tsx` — call site unchanged
  (already threads `timezone` per spec 074).
- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` — existing spec 074
  tests must continue to pass; this spec may extend it OR add a sibling
  test file (architect's call).
- Jest test track (existing infra per spec 022). No pgTAP, no shell
  smoke.

## Project-specific notes

- **Cmd UI section / legacy**: Cmd UI only. `DashboardSection.tsx` under
  `src/screens/cmd/sections/` (untouched). The fix is in the
  `cmdSelectors.ts` library that the section consumes.
- **Per-store or admin-global**: Per-store (rule evaluates per-store
  inside `computeAttentionQueue`'s callers); the timezone source is
  brand-global (single `useStore.timezone` per spec 074 §Open questions
  resolved). Carries the same "future per-store timezone" caveat.
- **Realtime channels touched**: None.
- **Migrations needed**: No.
- **Edge functions touched**: None.
- **Web/native scope**: Both. The fix is pure JS using the same
  `Intl.DateTimeFormat({timeZone: tz}).formatToParts()` pattern already
  exercised in production on web + Hermes by `businessDay.ts`,
  `eodStatus.ts`, and `weekWindow.ts` (per spec 074 Decision 3).
- **Tests track**: jest. Tests must pin both `now: Date` and
  `timezone: string` explicitly via the selector args. No real
  `Date.now()` dependency. No new test framework, no test renderer
  required (these are pure-function selector tests).
- **`app.json` slug**: Not touched.
- **CLAUDE.md "Permissive RLS" rule**: N/A — no DB policy changes.
- **CLAUDE.md "Edge function" rules**: N/A — no edge functions.
- **CLAUDE.md "CI status check after every push to main"**: Standard.
  Confirm the latest `test.yml` run on `main` is green before this
  spec's PR merges; the new jest tests should run cleanly inside the
  existing jest gate.
- **Risk: small, well-bounded.** The change is internal to
  `computeAttentionQueue`'s first ~95 lines (eod_missing +
  food_cost_streak blocks + the inline comment in the unconfirmed_po
  block). No signature change, no new file required (architect may
  decide on a small helper). All risk is caught by jest at PR time —
  no runtime-only failure modes.
- **Follow-up spec candidates** (do NOT fold into this spec):
  1. The spec 075 doc-patch (UTC vs NY in the design code-block) — a
     1-line PR independent of this spec.
  2. Per-store timezone (still a follow-up from spec 074).

## Backend / Frontend design

This is a pure-frontend, pure-pure-function selector-logic change. **No
backend work**: no migration, no RLS, no RPC, no edge function, no
`src/lib/db.ts` surface, no realtime channel, no `useStore` slice
mutation, no `app.json` change. Main Claude should dispatch
`frontend-developer` only — do NOT fan out `backend-developer`.

### 1. ISO derivation shape (Decision 1 resolved — inline back-step)

**Decision: option (a) inline.** No new helper in
`src/utils/weekWindow.ts`. Rationale:

- After the fix, `computeAttentionQueue` has exactly **two** call sites
  needing a back-stepped local-tz ISO date — `yesterdayISO` for
  `eod_missing` (1 day back) and `startSevenISO` for `food_cost_streak`
  (6 days back). The spec's bias-toward-(a)-if-1-2-sites threshold is
  exactly met; a `getLocalDateISOMinus(tz, now, days)` helper would
  carry one production caller and one test file's worth of fixtures —
  not enough mass to justify another `weekWindow.ts` export.
- Both back-steps share the same shape (subtract whole-day milliseconds
  from the `now: Date` UTC instant, THEN feed the result through the
  existing `getLocalDateISO(tz, ...)`). This is DST-safe because
  `getLocalDateISO` resolves the local calendar date from the UTC
  instant via `Intl.DateTimeFormat`, which is DST-aware — the same
  property the spec 074 acceptance criteria already pin.
- The inline shape is more legible to a reader scanning the rule
  bodies than indirecting through a 1-line helper. It also matches the
  pattern already established in the unconfirmed_po block (line 879
  inlines `getLocalDateISO(timezone, now)` directly).
- Crucially, this AVOIDS the trap the spec acceptance criterion #5
  warns about: `new Date(now); yesterday.setDate(yesterday.getDate() - 1)`
  uses LOCAL-tz `setDate`, which on V8/Hermes resolves against the
  process's TZ (= UTC in CI / system tz on dev machines), NOT the
  caller's `timezone` arg. Subtracting milliseconds from the UTC
  instant before resolving sidesteps that entirely.

**Exact derivation shape** (pseudocode; developer authors the actual
TS):

```
// eod_missing block — replaces current lines 753-756
const todayISO = getLocalDateISO(timezone, now);
const yesterdayISO = getLocalDateISO(
  timezone,
  new Date(now.getTime() - 24 * 60 * 60 * 1000),
);
```

```
// food_cost_streak block — replaces current lines 819-821
const startSevenISO = getLocalDateISO(
  timezone,
  new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
);
// endISO reuses todayISO from the eod_missing block — it's still in
// scope inside computeAttentionQueue.
```

**DST safety note for the developer**: subtracting `N * 24 * 60 * 60 *
1000` milliseconds from a `Date` instant produces a new UTC instant N
nominal days earlier. Resolving that instant's local calendar date in
`tz` is correct for the rule semantics — "yesterday in `tz`" means
"the calendar date 24 nominal hours ago, then resolved into `tz`". The
spring-forward case (a 23-hour local day) and fall-back case (25-hour
local day) both produce the correct previous calendar date because the
24-hour UTC step crosses a single calendar boundary in `tz` regardless
of DST. This is the same pattern `businessDay.ts:computeWeekdayDateISO`
uses for its UTC-arithmetic back-step.

### 2. `isPastDeadline` invariant (no change)

`isPastDeadline(nowDate: Date, deadlineHHMM?: string)` at line 717 is
called once inside the `eod_missing` block, at line 772:

```
} else if (isPastDeadline(now, store?.eodDeadlineTime)) {
```

The argument is the **raw `now: Date`** received by
`computeAttentionQueue` — NOT a tz-shifted Date. This is correct and
the spec's acceptance criterion #4 explicitly preserves it: the
deadline check is wall-clock-instant math, not calendar-date math, and
`isPastDeadline` already handles tz correctly internally (per spec 060).
The developer MUST NOT pass a derived/shifted Date here as a drive-by
"consistency" fix. Only the ISO **date string** derivations change;
the `Date` instant fed to `isPastDeadline` stays raw.

### 3. Inline comment replacement at `cmdSelectors.ts:864-873` (Decision 2 resolved)

**Decision: replace the 10-line "pre-existing inconsistency" block
with a 4-line ratification note.** The current copy actively
mis-describes post-spec-076 reality (claims the sibling rules are
tz-naive) and contains a "DO NOT 'fix' the inconsistency drive-by"
warning that becomes harmful after this spec — a future reader could
read it as "don't tz-correct the siblings" when the correct semantics
is now baked in.

**Exact replacement copy** (drops in over the existing lines 864-873;
no other changes to the surrounding comment block):

```
  // All three rules in this function (eod_missing, food_cost_streak,
  // unconfirmed_po) derive their ISO date anchors via
  // getLocalDateISO(timezone, now) — ratified by spec 076. The
  // back-step for yesterday / start-of-7d is computed by subtracting
  // whole-day milliseconds from `now` BEFORE the getLocalDateISO
  // call so the day arithmetic stays DST-safe.
```

Net delta: 10 lines removed, 6 lines added (4 prose + 2
non-content blank lines if the developer wants to preserve the
surrounding paragraph break — formatter's call). The surrounding
"Why tz-aware HERE only" framing disappears with the inconsistency
itself; the "db.ts still loads a broader orderSubmissions window"
paragraph below it stays untouched (still accurate, separate concern).

### 4. Test file home (Decision 3 resolved — sibling file)

**Decision: option (b) create
`src/lib/cmdSelectors.eodAndStreak.test.ts`.** Leave
`cmdSelectors.unconfirmedPoWindow.test.ts` byte-untouched.

Rationale:

- Spec 074's test file is intentionally scoped to one rule
  (`unconfirmed_po`) and reads cleanly that way — its top-comment block
  says "Other rules in the function are deliberately NOT exercised
  here". Widening the file would invalidate that framing and force a
  rename + a top-comment rewrite, both of which are cross-spec churn
  for no test-engineering benefit.
- Acceptance criterion #9 explicitly requires "existing
  `unconfirmed_po` tests in
  `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` continue to pass
  unmodified". The cleanest way to satisfy "unmodified" is to literally
  not touch the file. A sibling file with its own fixtures has zero
  risk of introducing flakiness into the spec 074 tests via shared
  module state.
- Jest's directory-glob test runner picks up
  `**/*.test.ts` regardless of basename, so adding a sibling file is
  free at the test-infra layer (no `jest.config.js` change, no CI
  workflow change).
- The new file's fixtures (EOD submissions per date, POS imports for
  the variance pp computation) overlap minimally with the existing
  file's fixtures (order schedules, vendor configs) — putting them in
  one file would not even share helper functions.

**New file: `src/lib/cmdSelectors.eodAndStreak.test.ts`.** The file
mirrors the spec 074 file's top-of-file shape (Supabase stub via
`jest.mock('./supabase', ...)` — same incantation; the import chain
hits `createClient()` at load time), then defines fixtures and runs
the four+ test cases below. Use `TZ = 'America/New_York'` matching the
spec 074 convention and the existing `useStore.timezone` defaults.

### 5. New test cases (≥4, pinning the canonical regression instant)

The canonical regression-fixture instant is
`new Date('2026-05-26T03:00:00Z')` = Mon 23:00 ET / Tue 03:00 UTC. The
pre-fix derivation would compute `todayISO = '2026-05-26'`; the
post-fix derivation computes `todayISO = '2026-05-25'`. Every test
case below would fail pre-fix.

**Test 1 — eod_missing: agreement-day baseline (regression-anchor
control case)**

```
it('eod_missing — UTC and NY agree at 04:00 UTC on Tuesday', () => {
  // 2026-05-26T04:00:00Z = 2026-05-26 00:00 EDT. Both UTC and NY say
  // Tuesday 2026-05-26. todayISO = '2026-05-26', yesterdayISO =
  // '2026-05-25'. This is the agreement instant — pre-fix and post-fix
  // produce the same answer. Acts as a sanity floor: a passing test
  // here proves the post-fix derivation is at minimum no-op-equivalent
  // when UTC and tz agree.
  const now = new Date('2026-05-26T04:00:00Z');
  // EOD submitted for '2026-05-25' but NOT '2026-05-26' → "EOD not yet
  // submitted today" at med-or-high severity (depending on deadline).
  // Assert one eod_missing row with the today-anchored id.
  // Expected: items.find((i) => i.rule === 'eod_missing').id ===
  //   `${STORE_ID}:eod:2026-05-26`
});
```

**Test 2 — eod_missing: cross-boundary divergence (canonical
regression — pre-fix FAILS, post-fix PASSES)**

```
it('eod_missing — at Mon 23:00 ET (Tue 03:00 UTC) resolves to Monday in NY', () => {
  // 2026-05-26T03:00:00Z = 2026-05-25 23:00 EDT — Monday night NY,
  // but already Tuesday UTC. Pre-fix: todayISO = '2026-05-26',
  // yesterdayISO = '2026-05-25' (UTC-driven). Post-fix: todayISO =
  // '2026-05-25', yesterdayISO = '2026-05-24' (tz-driven).
  // Fixture: EOD submitted for '2026-05-24' but not '2026-05-25'.
  // Pre-fix would see no submission for '2026-05-26' AND a
  // submission for '2026-05-25', emitting a med severity "EOD not yet
  // submitted today" with id ending ':eod:2026-05-26' — wrong.
  // Post-fix sees no submission for '2026-05-25' AND a submission for
  // '2026-05-24', emitting the same severity with id ending
  // ':eod:2026-05-25' — correct NY-local "today".
  // Assert the emitted row's id ends in ':eod:2026-05-25'.
});
```

**Test 3 — eod_missing: yesterday-fallback two-days-running copy
(canonical regression for `yesterdayISO`)**

```
it('eod_missing — "2 days running" copy uses NY yesterday at the UTC-skew instant', () => {
  // Same instant: 2026-05-26T03:00:00Z = Mon 23:00 EDT.
  // Fixture: NO EOD submissions for either '2026-05-24' or
  // '2026-05-25'. Pre-fix: looks at '2026-05-26' (missing) and
  // '2026-05-25' (missing) — emits "EOD missing 2 days running" with
  // id ':eod:2026-05-26'. Post-fix: looks at '2026-05-25' (missing)
  // and '2026-05-24' (missing) — emits same copy with id
  // ':eod:2026-05-25'. The text is identical; the id and the dates
  // queried internally differ. Assert id ends in ':eod:2026-05-25'.
  // (Pre-fix would also fail if a '2026-05-26' submission is added to
  // the fixture but '2026-05-24' is missing — but the simpler
  // both-missing assertion catches the same regression.)
});
```

**Test 4 — food_cost_streak: rolling-7d window anchors on NY today
(canonical regression for `startSevenISO`)**

```
it('food_cost_streak — 7d window ends on NY "today" at the UTC-skew instant', () => {
  // Instant: 2026-05-26T03:00:00Z = Mon 23:00 EDT. Post-fix window
  // should be [2026-05-19, 2026-05-25]. Pre-fix would be
  // [2026-05-20, 2026-05-26].
  // Fixture: stub computeStoreFoodCostVariancePp inputs (or use real
  // inventory + eodSubmissions + posImports) such that variance pp
  // >= 1 for the five days [2026-05-21..2026-05-25] and < 1 for
  // [2026-05-19, 2026-05-20]. Streak counted backward from end-of-
  // window — post-fix end is 2026-05-25, so the streak walks back
  // through 5/25, 5/24, 5/23, 5/22, 5/21 = 5 days, then breaks at
  // 5/20. Assert: streak === 5, sev: 'high', rule: 'food_cost_streak'.
  // Pre-fix would walk back from 2026-05-26 (presumably zero variance
  // pp for that day since no EOD submitted), hit a non-streak day
  // immediately, and EITHER emit no row OR emit a 4-day streak —
  // either way, NOT === 5.
});
```

**Test 5 (optional but recommended — pins the
`isPastDeadline(now, ...)`-stays-raw invariant)**

```
it('eod_missing — isPastDeadline receives raw now (deadline severity preserved at UTC-skew instant)', () => {
  // Instant: 2026-05-26T03:00:00Z = Mon 23:00 EDT. eodDeadlineTime on
  // the fixture store = '22:00' (10pm NY). isPastDeadline reads the
  // raw `now` and compares 23:00 ET to 22:00 deadline → past.
  // Post-fix: todayISO = '2026-05-25', yesterdayISO = '2026-05-24'.
  // Fixture: '2026-05-24' EOD submitted; '2026-05-25' EOD NOT
  // submitted. Rule path: no todaySub → yesterdaySub exists →
  // isPastDeadline(now, '22:00') === true → emit 'high' severity with
  // text 'EOD missing past 22:00 deadline'. Assert sev === 'high' and
  // text contains '22:00'. If a future drive-by refactor passes a
  // tz-shifted Date to isPastDeadline (e.g. one anchored to the local
  // ISO date), this assertion shape will break because the shifted
  // Date's hours/minutes no longer reflect the operator's wall clock.
});
```

Each test pins both `now: Date` and `timezone: string` explicitly via
the `computeAttentionQueue` arglist, matching the spec 074 convention.
No `Date.now()` dependency; no `jest.useFakeTimers()` needed.

### 6. Realtime / data layer impact

None. The selector is a pure function over already-loaded
`InventoryItem[]`, `EODSubmission[]`, `POSImport[]`,
`OrderSubmission[]`, `OrderSchedule`, `Store[]`. No realtime channel
(`store-{id}` / `brand-{id}`) replays this change. No publication
gotcha — no migration is shipping at all.

### 7. Frontend store impact

None. `useStore.timezone` is unchanged; the call site at
`src/screens/cmd/sections/DashboardSection.tsx` already threads
`timezone` per spec 074. No optimistic-then-revert pattern engages —
this is read-side selector logic, not a mutation.

### 8. Risks and tradeoffs

- **Risk: small, well-bounded.** Two derivation blocks (~6 lines
  total) + one comment block (~10 lines → ~4 lines) + one new test
  file. No signature change anywhere. No runtime-only failure modes —
  jest catches all paths at PR time.
- **DST trap (mitigated).** Subtracting raw milliseconds from a UTC
  instant before resolving into a local calendar date is DST-safe by
  construction. Spring-forward / fall-back days behave correctly.
- **Coverage trap (mitigated by Test 5).** The
  `isPastDeadline(now, ...)`-stays-raw invariant is fragile under
  future "consistency" refactors. Test 5 makes it load-bearing.
- **Performance: trivial.** Two extra `Intl.DateTimeFormat`
  constructions per attention-queue invocation (one per back-step).
  `getLocalDateISO` is already called once per queue in the
  unconfirmed_po block; the marginal cost on the 286 KB seed dataset
  is unmeasurable.
- **Cold-start: N/A.** Pure frontend; no edge function involved.
- **Test-isolation tradeoff (accepted).** Two test files for
  `computeAttentionQueue` (one per spec) instead of a single
  consolidated `cmdSelectors.attentionQueue.test.ts`. A future spec
  that touches `low_out_stock` or `expiry` may consolidate; not this
  spec.

### 9. Files the developer will touch

- `src/lib/cmdSelectors.ts` — modify lines 753-756 (eod_missing date
  derivation), lines 819-821 (food_cost_streak start anchor), lines
  864-873 (inline comment replacement). Total: ~16 lines net change.
- `src/lib/cmdSelectors.eodAndStreak.test.ts` — new file, ≥4 test
  cases per §5 above.

No other files touched.

## Files changed

- `src/lib/cmdSelectors.ts` — three surfaces modified per design §1, §3:
  - `eod_missing` block (was lines 753-756): `todayISO` switched from
    `now.toISOString().slice(0, 10)` to `getLocalDateISO(timezone, now)`;
    `yesterdayISO` switched from `setDate(-1)` + ISO slice to inline
    `getLocalDateISO(timezone, new Date(now.getTime() - 24 * 60 * 60 * 1000))`.
  - `food_cost_streak` block (was lines 819-821): `startSevenISO` switched
    from `setDate(-6)` + ISO slice to inline
    `getLocalDateISO(timezone, new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000))`.
  - Inline comment in the `unconfirmed_po` block (was lines 864-873):
    "Why tz-aware HERE only" pre-existing-inconsistency warning replaced
    with the architect-drafted 4-line ratification note ("All three rules
    in this function ... derive their ISO date anchors via
    `getLocalDateISO(timezone, now)` — ratified by spec 076").
  - `isPastDeadline(now, store?.eodDeadlineTime)` continues to receive
    the raw `now: Date` per AC #4 — unchanged.
  - `getLocalDateISO` was already imported at line 10 — no new imports
    needed.

- `src/lib/cmdSelectors.eodAndStreak.test.ts` — NEW file. Mirrors the
  supabase-stub + `runQueue` helper pattern from
  `cmdSelectors.unconfirmedPoWindow.test.ts` (byte-untouched per AC #9).
  Six jest tests added, all pinned to the canonical regression instant
  `new Date('2026-05-26T03:00:00Z')` (= Mon 23:00 ET / Tue 03:00 UTC):
  1. `eod_missing` agreement-day baseline at `2026-05-26T04:00:00Z`.
  2. `eod_missing` canonical regression — `todayISO` resolves to Monday
     ET (`'2026-05-25'`), not Tuesday UTC (`'2026-05-26'`).
  3. `eod_missing` yesterday-fallback "2 days running" — anchors on
     '2026-05-25' / '2026-05-24', not '2026-05-26' / '2026-05-25'.
  4. `food_cost_streak` 7-day window anchored on NY Monday — fixture
     emits 5-day streak with id `:fc_streak:5`.
  5. Cross-rule structural anchor agreement — all three rules at the
     canonical instant land on Monday-ET (5/25) anchors.
  6. `isPastDeadline(now, ...)` invariant — uses deadline `'02:00'`
     (discriminates in CI's UTC process tz; architect-described
     deadline `'22:00'` would have been a no-op in UTC); a future
     refactor that tz-shifts the Date passed to `isPastDeadline`
     would change the boolean output and break this test loudly.

Verification:
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- `npx tsc --noEmit -p tsconfig.test.json` → exit 0.
- `npx jest` → 40 suites passed, 386 tests passed (was 380 pre-spec —
  this spec adds 6 new tests). `cmdSelectors.unconfirmedPoWindow.test.ts`
  remains green and untouched.

Deltas from architect-drafted spec:
- Test 6 (architect-optional `isPastDeadline` invariant) uses deadline
  `'02:00'` instead of the architect-suggested `'22:00'`. Rationale
  documented inline in the test's leading comment: `isPastDeadline`
  uses `setHours()` (process-tz-resolved), and CI runs in UTC; the
  `'22:00'` value the architect described assumes process tz is
  America/New_York. To make the test load-bearing regardless of
  process tz, the deadline is set so the canonical-instant `now`
  (UTC-process-tz 03:00) is past it. The test invariant — boolean
  output reflects raw `now`, not a tz-shifted Date — is preserved
  exactly; only the magnitude of the deadline value changed.
