## Test report for spec 133

### Acceptance criteria status

- AC1: Week-sidebar day-status derives `'rest'` from `order_schedule` weekday
  (schedule configured AND zero vendors that weekday), not submission absence;
  unconfigured schedule → no day is `'rest'` →
  PASS — `src/lib/__tests__/eodDayStatus.test.ts::isRestWeekday` (4 tests:
  configured+zero-vendor weekday, configured+has-vendor weekday, legacy
  null-vendorId filtering, unconfigured-fallback across all 7 weekdays) +
  `::deriveDayStatus` "rest (stays locked)" / "uncounted (the fix)" /
  "schedule-unconfigured fallback" tests. Wiring confirmed by code read:
  `EODCountSection.tsx:239-271` calls `isRestWeekday(orderSchedule, dayName)`
  and `deriveDayStatus(...)` per day-cell iteration, with `orderSchedule` in
  the `useMemo` deps (line 271).

- AC2: A PAST, non-rest, uncounted day renders a distinct non-`'rest'` pill and
  is selectable; selecting it enables inputs/+COUNT/SAVE DRAFT/SUBMIT identical
  to today →
  PASS (derivation + disable-wiring) / NOT TESTED (component-level
  interaction) — derivation: `eodDayStatus.test.ts::deriveDayStatus` "past day,
  configured, vendors that weekday, zero submissions → uncounted (the fix)".
  Pill: `dayPillFor` at `EODCountSection.tsx:907` adds the `'uncounted'` branch
  (`C.violet`/`C.violetBg`, `section.eod.uncounted`) verified by code read, no
  dedicated unit test of `dayPillFor` itself (it's an inline closure, not
  extracted — acceptable, it's a 4-line lookup table with the color tokens
  already jest-covered indirectly by the theme file existing). Enable-wiring:
  `isRestDay = selectedDayCell?.status === 'rest'` (line 915) is a strict
  equality, so `'uncounted'` correctly yields `isRestDay === false`, which
  every disable expression keys off (`inputsDisabled` line 784,
  `disabled={isRestDay}` lines 1130/1142/1154) — verified by code read, not by
  an RTL test that mounts the section, selects an uncounted day, and asserts
  enabled inputs. Day-cell selection itself has no status-based guard
  (`onPress={() => setSelectedIso(d.iso)}` at lines 974/1042, unconditional for
  every day) — every day is always selectable, rest included (read-only
  selection to view the pill), confirmed by code read. The actual "select a
  past uncounted day, type a count, verify inputs are live" flow is a live-DOM
  interaction that jest's react-test-renderer setup here does not exercise for
  this section (no existing `EODCountSection` RTL harness drives day
  selection). Per this task's instruction, the golden-path live-browser check
  is being run separately by the orchestrating session — treating the
  UI-interaction half of this AC as covered there, not blocking.

- AC3: Submitting for a selected past date persists an `eod_submissions` row
  with `date` = selected ISO (not today) + `eod_entries`, via unchanged
  `submitEOD`/`submitEODCount`; `submitted_by`/`submitted_at` populated →
  NOT TESTED (no jest, pgTAP, or smoke coverage exists for this — and none is
  claimed by the spec, which explicitly scopes this feature to "jest track
  only... no DB/RPC change"). `buildSubmission` stamping `date: selectedIso`
  (`EODCountSection.tsx:626/635`) and `submitEODCount`'s upsert on
  `(store_id, date, vendor_id)` (`db.ts:832-851`) are unchanged by this spec —
  verified unchanged by code read — but "unchanged" is not the same as
  "tested"; no pre-existing test pins this write path against a real Supabase
  instance either, so there is no regression-guard for a backdated write
  actually landing correctly. This is a real DB write and needs live-Supabase
  verification per project policy ("Hit a real local Supabase, not mocks").
  Flagging as covered-by-main-session per this task's note (the live-browser
  golden path necessarily submits a past-day count to demonstrate the fix) —
  not blocking on that basis, but noting no automated regression test exists
  going forward.

- AC4: A true rest day (schedule configured, no vendors that weekday) stays
  read-only — inputs/buttons disabled, REST DAY pill shows →
  PASS — `eodDayStatus.test.ts::deriveDayStatus` "past day, configured, zero
  vendors that weekday, zero submissions → rest (stays locked)"; `isRestDay`
  strict-equality wiring (line 915) and the disable expressions
  (lines 784/1130/1142/1154) and REST DAY pill render (`isRestDay ? ... :
  null` at line 1090) are unchanged code, confirmed by code read — this is the
  "inherits correctness from the derivation" claim in the design, and the unit
  test on `deriveDayStatus` is the load-bearing regression guard for it.

- AC5: `isRestDay` for the selected day is FALSE for a non-rest past day with
  no submissions (was the bug: previously TRUE) →
  PASS — direct consequence of AC1/AC2's `deriveDayStatus` unit tests
  returning `'uncounted'` (not `'rest'`) for that case, combined with the
  trivial `=== 'rest'` equality at line 915 (verified by code read; no
  separate unit exists for the one-line equality itself, which is appropriately
  thin to not need its own test).

- AC6: After a past-day count is submitted, spec-130's reorder
  "count not submitted" gate clears for that vendor + date via the existing
  realtime/reload path, with no additional wiring →
  NOT TESTED at the jest level (no new code path — the design explicitly
  states no reorder-side change and no realtime/publication change) and no
  pgTAP/smoke test exists to exercise it end-to-end. This is a genuine
  cross-section, real-DB, realtime-dependent flow (EOD submit → realtime
  reload → reorder gate reads `eodSubmittedAt`) that only a live-browser /
  live-Supabase run can actually prove. Treating as covered-by-main-session
  per this task's instruction — not blocking — but noting this is the AC with
  the least automated coverage of the seven; if the live-browser check is ever
  skipped in a future regression, there is nothing in CI that would catch a
  break here.

- AC7: A past day that already has submissions continues to render
  `submitted`/`draft`/`late` exactly as before (no regression) →
  PASS — `eodDayStatus.test.ts::deriveDayStatus` "regression: past day with a
  draft → draft" (incl. draft-wins-over-rest-weekday case), "regression: past
  day submitted with counted < total → late", "regression: past day submitted
  with counted >= total → submitted" (both boundary and over-total cases).
  Additional regression guard beyond the AC text: "today is NEVER locked"
  (2 tests) and "today with a draft → draft" pin that today's pre-existing
  behavior is untouched by this change.

### Test run

```
npx tsc --noEmit                       → clean, no output
npx tsc -p tsconfig.test.json --noEmit → clean, no output
npx jest                               → 123 suites passed / 123 total
                                          1336 tests passed / 1336 total
                                          (console act()-warning noise from
                                          pre-existing staff EODCount tests,
                                          unrelated to spec 133, not failures)
npx jest src/lib/__tests__/eodDayStatus.test.ts --verbose
                                        → 14/14 tests pass:
  scheduleConfigured (2): null/undefined/empty → false; ≥1 row → true
  isRestWeekday (4): configured+zero-vendor weekday → true;
    configured+has-vendor weekday → false; legacy null-vendorId rows
    filtered/ignored; unconfigured schedule → false for all 7 weekdays
  deriveDayStatus (8): uncounted-fix case; rest-stays-locked case;
    unconfigured-fallback case; draft regression (incl. draft-over-rest-
    weekday); late regression; submitted regression (boundary + over-total);
    today-never-locked (×2); today-with-draft → draft
```

Grep for a pre-existing test pinning the old "past uncounted day → rest"
behavior: none found. Searched every test file that references
`EODCountSection` or `eodDayStatus`
(`EODCountSection.countedOnce.test.tsx`, `EODCountSection.customOrder.test.tsx`,
`InventoryCountSection.customOrder.test.tsx`, `InventoryDesktopLayout.test.tsx`)
for `'rest'` / "rest day" / "REST DAY" / `status ===` — zero matches. The old
default lived only inline in the component's `useMemo` (never independently
pinned), consistent with the frontend-developer's verification note in the
spec. No stale test needed updating.

### Notes

- **Testing-reality fit.** This spec correctly stayed on the jest track only —
  no migration/RPC/RLS/publication change, so no pgTAP or shell-smoke work was
  warranted, and none was introduced. No new test framework was added
  (matches the jest/pgTAP/shell-smoke constraint).
- **Extraction pattern followed.** `src/lib/eodDayStatus.ts` mirrors the
  existing `src/lib/countOrder.ts` / `src/utils/minutesAfterDeadline.ts`
  extract-and-pin pattern the design called for — pure, dependency-free,
  directly unit-testable without mounting the component. This is the right
  shape for testing behavior-not-implementation: the 14 pins exercise the
  actual decision table (rest vs. uncounted vs. today vs. draft vs. late vs.
  submitted) rather than internal wiring, and would survive a refactor of the
  component's rendering.
- **Coverage gap — no component/integration test for the EOD section's day
  selection + enable/disable wiring.** The unit tests fully pin the pure
  derivation function; the wiring from `DayStatus` → `isRestDay` → disabled
  props is a one-line equality and is not independently exercised by an RTL
  test that mounts `EODCountSection`, selects a past uncounted day, and
  asserts the inputs/buttons are enabled. Given the wiring is trivial
  (`=== 'rest'`, unchanged from before this spec) this is low-risk, but it is
  the honest boundary of jest's coverage here — the actual UI behavior (AC2's
  "selecting it makes inputs/buttons ENABLED") is verified by code read plus
  the separate live-browser golden-path check, not by an automated jest
  assertion. Same applies to AC3 (persistence of the backdated submission)
  and AC6 (reorder gate clearing) — both are real-DB / realtime flows with
  zero automated coverage (jest, pgTAP, or smoke) either before or after this
  spec; per this task's instruction these are being verified live by the
  orchestrating session and are not treated as blocking findings here, but
  they are flagged as a durable gap: if the live-browser check is skipped on
  a future change to this code path, nothing in CI would catch a regression
  in the actual persisted date or the reorder-gate-clearing behavior.
- **i18n completeness verified.** `section.eod.uncounted` present in all three
  catalogs (`en.json:477` "needs count", `es.json:477` "falta conteo",
  `zh-CN.json:477` "待录入"), adjacent to the existing `rest` key as the design
  specified. `C.violet`/`C.violetBg` tokens already exist in both
  light/dark palettes (`src/theme/colors.ts:206-207`/`:240-241`), reused
  without modification per the OQ-1 ruling.
- **OQ-2 (`showUnscheduled` does not unlock true rest days) confirmed by code
  read**, not a dedicated test: `isRestDay` has no dependency on
  `showUnscheduled` (only `vendorTabs` at lines 323-327 reads that toggle),
  so the "true rest days stay locked regardless of toggle" ruling holds
  mechanically. No jest pin exists for this specific interaction (toggle +
  rest day + still-disabled), which is a minor coverage gap given it's an
  explicit ruling in the design — recommend a one-line addition if this spec
  is revisited, not blocking for this review.
- **No `app.json` slug or other hard-rule file touched.** Files changed are
  exactly as declared: `src/lib/eodDayStatus.ts` (new),
  `src/lib/__tests__/eodDayStatus.test.ts` (new),
  `src/screens/cmd/sections/EODCountSection.tsx`, and the three i18n catalogs.
