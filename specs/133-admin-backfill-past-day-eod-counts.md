# Spec 133: Admin backfill — edit/enter EOD counts for past days

Status: READY_FOR_REVIEW

## User story
As a store manager (admin Cmd), I want to enter and submit an end-of-day (EOD)
count for a PAST day that has no count yet — as long as that day is not a real
rest day — so that I can unblock creating a purchase order for that date (the
reorder screen hides CREATE PO / quick-order for vendors whose EOD count is not
submitted for the reorder date — spec 130).

## Problem (root cause)

On the admin EOD count section (`src/screens/cmd/sections/EODCountSection.tsx`)
the week-sidebar day status is computed at ~lines 240–272. A NON-today day with
zero submissions falls through to `status = 'rest'` (line 261 default). The
selected day's `isRestDay` flag (line 912, `selectedDayCell?.status === 'rest'`)
then disables ALL inputs and the +COUNT / SAVE DRAFT / SUBMIT buttons (lines 785,
815, 845, 871, 1087–1164) and shows a "REST DAY — NO INPUT" pill.

This **conflates two different things**:
- "no submissions exist yet for that past day" (should be editable — that is the
  whole point of backfill), and
- "this weekday is an actual rest day" (correctly locked).

The real rest-day signal is the store's `order_schedule` (spec 007): a weekday is
a rest day when the schedule is configured AND no vendors are scheduled for that
weekday — the same semantics the `eod-reminder-cron` rest-day gate and spec 130's
reorder gating already use. The EOD section already computes these building
blocks for the SELECTED day (`scheduleConfigured` line 292; `dayScheduledVendorIds`
line 298; `selectedDayName` line 284) but the week-sidebar loop does not use them
— it defaults to `'rest'` on submission absence.

## Backend confirmation (already date-agnostic — no backend work)

The admin submit path is NOT hardwired to today:
- `buildSubmission` stamps `date: selectedIso` on both the submission and every
  entry (`EODCountSection.tsx:626`, `:635`).
- `submitEODCount` (`src/lib/db.ts:832`) upserts on `(store_id, date, vendor_id)`
  using `submission.date` — an arbitrary past date is honored.
- RLS: `store_member_insert_eod_submissions` / `_update_` and the `eod_entries`
  child policies gate ONLY on `auth_can_see_store(store_id)` with NO date
  restriction (`supabase/migrations/20260504173035_per_store_rls_hardening.sql:70–131`).
  A backdated write already passes RLS for an admin who can see the store.

Therefore this feature is a **frontend-only** day-status-derivation fix. No
migration, no RPC change, no edge-function change.

## Acceptance criteria

- [ ] The week-sidebar day-status computation (`EODCountSection.tsx` ~240–272)
  derives `'rest'` from the `order_schedule` weekday, NOT from submission
  absence: a day is `'rest'` iff the store's schedule is configured (any weekday
  has ≥1 vendor row) AND that day's weekday has zero scheduled vendors. When the
  schedule is unconfigured for the store, NO day is `'rest'` (all days editable —
  matches the section's existing "fallback: all vendors on all days" behavior).
- [ ] A PAST day within the 7-day sidebar that is NOT a true rest day and has
  zero submissions renders with a distinct, non-`'rest'` status pill (see Open
  question OQ-1 for the exact label/token) and is selectable; selecting it makes
  the worksheet inputs, +COUNT, SAVE DRAFT, and SUBMIT all ENABLED — identical to
  the today flow (per-vendor tabs, drafts, completeness gate).
- [ ] Submitting for a selected past date persists an `eod_submissions` row with
  `date` = the selected day's ISO (not today) and its `eod_entries`, via the
  existing `submitEOD` / `submitEODCount` path — no backend change. The row's
  `submitted_by` = the acting admin and `submitted_at` = the write time (existing
  columns).
- [ ] A day that IS a true rest day (schedule configured AND no vendors scheduled
  that weekday) remains READ-ONLY: inputs and action buttons stay disabled and
  the REST DAY pill still shows. The fix must not make true rest days editable.
- [ ] `isRestDay` for the selected day (line 912) reflects the schedule-based
  derivation above, so it is FALSE for a non-rest past day with no submissions
  (which was the bug — it was TRUE).
- [ ] After a past-day count is submitted, the reorder screen's spec-130 "count
  not submitted" gate for that vendor + that reorder date clears (CREATE PO /
  quick-order become available for that date) once data reloads via the normal
  realtime/reload path — no additional wiring beyond the count landing in
  `eod_submissions`.
- [ ] A past day that already HAS submissions continues to render `submitted` /
  `draft` / `late` exactly as today (no regression to the existing aggregation at
  lines 251–268).

## In scope

- Frontend-only change to the week-sidebar day-status derivation in
  `EODCountSection.tsx` so `'rest'` comes from `order_schedule` weekday semantics
  instead of submission absence.
- A distinct rendering (status pill + selectable/editable cell) for a past,
  non-rest, uncounted day (OQ-1).
- Reusing the existing per-vendor submit flow verbatim for the selected past date
  (no new submit code path).
- Jest coverage (jest track) pinning: (a) a past non-rest uncounted day is
  editable and its status is NOT `'rest'`; (b) a true rest day (schedule
  configured, no vendors that weekday) stays `'rest'` / read-only; (c) the
  schedule-unconfigured fallback makes all days editable.

## Out of scope (explicitly)

- **Reaching dates older than the 7-day sidebar.** v1 bounds backfill to the
  existing 7-day week sidebar — the current surface and the tightest slice that
  unblocks the owner's extension-ordering testing. A dedicated date picker for
  older dates is a deferred follow-up (rationale: the reorder page already has a
  picker for the ordering side; extending the EOD surface is a larger, separable
  change).
- **Any backend change** — no migration, no RPC, no edge function, no RLS change.
  The submit path and RLS already accept backdated writes (see Backend
  confirmation). Rationale: verified in code this session.
- **A separate "backfilled" flag/badge or audit table.** `submitted_by` +
  `submitted_at` on `eod_submissions` already record who entered the count and
  when, which is sufficient for v1. Rationale: minimal slice; can be added later
  if the owner wants to distinguish same-day vs backfilled visually.
- **The staff EOD app** (`src/screens/staff/screens/EODCount.tsx`). This is an
  ADMIN-only backfill capability. Rationale: owner request is explicitly for
  admins; staff-side backdating is a separate decision.
- **Changing the reorder screens (spec 130).** They already read the per-vendor
  submitted signal; a landed backfill count clears their gate with no code change.
- **Changing `'late'` semantics.** `'late'` stays "submitted but counted < total"
  (lines 256–267). A past uncounted day is a DIFFERENT state (nothing submitted)
  and must not be labeled `'late'`.

## Open questions resolved (baked-in — minimal-slice decisions)

- Q: How far back? → A: 7-day sidebar bound only (no new date picker). Deferred
  expansion noted in Out of scope.
- Q: True rest days editable? → A: No — keep them locked. Only past days that are
  NOT true rest days become editable. This is exactly the conflation fix, nothing
  more.
- Q: Audit trail beyond `submitted_by`? → A: No new columns/badge for v1;
  `submitted_by` + `submitted_at` suffice.
- Q: Does a backfilled past date render as `'late'`? → A: No; a past uncounted day
  is a distinct state (see OQ-1), not `'late'`.

> Note: these three were intended as user-facing clarifying questions, but the
> AskUserQuestion tool is unavailable in this agent context. They are resolved to
> the tightest correct slice consistent with the owner's request ("give admins
> able to edit passed days to input the EOD counts") and the launching task's
> "keep scope tight" direction. If the owner wants the date picker or a backfill
> badge, that reopens as a follow-up spec rather than expanding this one.

## Open questions for the architect

- **OQ-1 — status token for a past, non-rest, uncounted day.** `DayStatus` today
  is `'today' | 'submitted' | 'draft' | 'late' | 'rest'` (line 28). A past
  non-rest day with no submissions currently has no representation other than the
  (now-incorrect) `'rest'`. Recommendation: add a distinct status
  (e.g. `'uncounted'` or `'missed'`) rendered with a neutral-but-actionable pill
  that signals "editable / needs a count" and is visually distinct from the
  locked `'rest'` pill and from `'late'`. Architect finalizes the token name,
  pill token/label, and the i18n key(s) under `section.eod.*`. (This is a small
  frontend type + `dayPillFor` addition at line 900.)
- **OQ-2 — `showUnscheduled` toggle interaction on a true rest day.** The section
  has a "show all vendors" toggle (`showUnscheduled`, line 325) that already
  surfaces vendor tabs regardless of the day's schedule. Should flipping it on a
  TRUE rest day also unlock inputs (to backfill an off-schedule delivery), or
  should true rest days stay locked regardless of the toggle? Recommendation for
  v1: keep true rest days locked regardless of the toggle (simplest; matches the
  "keep rest days locked" decision). Architect confirms.

## Dependencies

- Store `order_schedule` (spec 007) — the rest-day source of truth; already loaded
  into the section (`orderSchedule`, used at lines 292–301).
- Spec 130 reorder count-not-submitted gate — downstream consumer; unblocked by a
  landed backfill count with no change on its side.
- Existing submit path: `submitEOD` (store) + `submitEODCount`
  (`src/lib/db.ts:832`) — reused unchanged.
- `DayStatus` / `DayCell` types + `dayPillFor` in `EODCountSection.tsx` — touched
  for OQ-1.

## Project-specific notes

- Cmd UI section / legacy: admin Cmd section
  `src/screens/cmd/sections/EODCountSection.tsx` (the only admin surface; no
  legacy). Staff peer explicitly out of scope.
- Per-store or admin-global: per-store. Reads `order_schedule` and writes
  `eod_submissions` for the currently selected store; both already scoped via
  `auth_can_see_store()`. No scope or RLS change.
- Realtime channels touched: none added. A landed backfill count reloads via the
  existing `store-{id}` / `brand-{id}` debounced `useRealtimeSync` on the admin
  shell, which is what clears the spec-130 reorder gate for that date. No
  publication change → no `docker restart supabase_realtime_imr-inventory` step.
- Migrations needed: no.
- Edge functions touched: none. (The `eod-reminder-cron` rest-day gate is the
  reference for the schedule-based rest-day semantics, but is not modified.)
- Web/native scope: admin Cmd is web-primary; the change is plain day-status
  derivation + view-enable logic (no web-only APIs), so it is safe on both, but
  the admin section is the only place it renders.
- Tests: jest track only (component/derivation test on the week-status
  computation + the `isRestDay` gate). No pgTAP or shell-smoke track — no DB/RPC
  change.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 133. It is expected to be frontend-only —
  confirm the day-status derivation change (schedule-based `'rest'`, not
  submission-absence) and resolve OQ-1 (the status token + pill + i18n for a
  past, non-rest, uncounted day) and OQ-2 (`showUnscheduled` interaction on a
  true rest day). Verify no backend/RPC/RLS work is genuinely needed (the submit
  path and RLS already accept backdated writes) and produce the design doc, then
  set Status: READY_FOR_BUILD.
payload_paths:
  - specs/133-admin-backfill-past-day-eod-counts.md

---

## Backend design

### Ruling: frontend-only — confirmed, no backend surface changes ship in 133

I verified the submit path and RLS in code this session. The spec's "no backend
work" claim holds:

- **Submit path is date-agnostic.** `buildSubmission` stamps `date: selectedIso`
  onto the submission and every entry (`EODCountSection.tsx:626/:635`).
  `submitEODCount` (`src/lib/db.ts:832`) writes
  `date: new Date(submission.date).toISOString().split('T')[0]` and upserts
  `onConflict: 'store_id,date,vendor_id'` (`db.ts:845–851`). The `date` column is
  taken verbatim from the submission — there is no `= today` clamp anywhere on the
  write path. A past ISO is honored, and the EDIT-in-place semantics (upsert on the
  composite key) work identically for a backdated row.
- **RLS has no date predicate.** `store_member_insert_eod_submissions` /
  `_update_` and the `eod_entries` child policies gate ONLY on
  `auth_can_see_store(store_id)`
  (`supabase/migrations/20260504173035_per_store_rls_hardening.sql:70–131`). An
  admin who can see the store already passes WITH CHECK for any `date`. No policy
  references `now()`, `current_date`, or the submission date.
- **`submitted_by` / `submitted_at`** are existing columns; `submitEODCount` sets
  `submitted_at: new Date().toISOString()` (write time) and `submitted_by` from the
  acting user. This satisfies AC "who + when" with zero schema change.

**Therefore 133 ships NO migration, NO RPC, NO edge-function change, NO RLS
change, and NO `supabase_realtime` publication change.** There is consequently no
`docker restart supabase_realtime_imr-inventory` dev step and no
`db-migrations-applied.yml` exposure for this spec. The only files that change are
frontend TS + i18n JSON (enumerated below). This section documents a contract the
frontend must hold to, not a backend build.

### Data model changes

None. No new tables, columns, or indexes. Additive-nothing; the write shape on
`eod_submissions` / `eod_entries` is unchanged.

### RLS impact

None. Reuses `auth_can_see_store(store_id)` on `eod_submissions` /`eod_entries`
exactly as the today-flow does. No policy is added or edited. (Per the CLAUDE.md
permissive-policy rule, since we add no policy there is nothing to consolidate or
mark RESTRICTIVE.)

### API contract

Unchanged. The write continues through the existing
`submitEOD` (store action) → `submitEODCount` (`db.ts:832`) PostgREST upsert —
admin-JWT path stays on direct PostgREST, NOT the service-role RPC (which remains
staff-app-only). No new `db.ts` helper is introduced; the frontend must NOT add a
sibling write path. snake_case→camelCase mapping is the existing `mapItem`-style
EOD mapper; untouched.

### Day-status derivation change (the whole feature)

The bug: the week-sidebar loop (`EODCountSection.tsx:240–272`) terminates in an
unconditional `status = 'rest'` (line 261 default) for any non-today day with no
submissions. That conflates "no count entered yet" with "this weekday is an actual
rest day." The fix moves the `'rest'` decision onto `order_schedule` weekday
semantics — the same signal the `eod-reminder-cron` Track-1 gate and spec 130 use.

**Rest-weekday predicate (must mirror the cron, Track 1).** The cron gates on
`storesWithSchedule.has(store.id) && !storesScheduledToday.has(store.id)`
(`eod-reminder-cron/index.ts:261`), i.e. "schedule configured for the store AND
zero vendors on that business weekday." The client mirror is byte-for-byte
semantically:

- `scheduleConfigured` (already computed, line 292) == cron's `storesWithSchedule`
  membership: any weekday has ≥1 `order_schedule` row for the store.
- "zero vendors on weekday D" == the day slice `orderSchedule[D]` has zero non-null
  `vendorId`s (same filter as `dayScheduledVendorIds`, line 298).

So `isRestWeekday(orderSchedule, D) = scheduleConfigured(orderSchedule) &&
countScheduledVendorIds(orderSchedule, D) === 0`. When the schedule is
unconfigured, `isRestWeekday` is FALSE for every day → all days editable (matches
the section's existing "all vendors on all days" fallback and the cron's
"legacy remind-every-day" behavior). Note: the week loop currently only computes
the schedule slice for the SELECTED day; the fix computes the rest-weekday flag
per-iteration for all 7 days (cheap — the `orderSchedule` slice is already in
memory).

**New `DayStatus` state machine** (per day cell):

- `iso === todayIso` → `anyDraft ? 'draft' : 'today'` — **unchanged.** Today is
  NEVER derived to `'rest'` or `'uncounted'`, exactly as today. This is deliberate:
  133 concerns PAST days only. Do not regress today into a locked cell on a rest
  weekday — the existing behavior (today is always editable) is preserved verbatim.
- else `anyDraft` → `'draft'` — unchanged.
- else `anySubmitted` → `counted >= total ? 'submitted' : 'late'` — unchanged
  (the lines 251–268 aggregation is preserved; `'late'` semantics untouched per the
  spec's out-of-scope).
- else (a past day with zero submissions) → **`isRestWeekday ? 'rest' :
  'uncounted'`**. This single split IS the fix. The old terminal `'rest'` becomes
  conditional.

Because `'rest'` now only appears in the no-submissions branch, a rest-weekday that
nonetheless HAS a submission (e.g. an off-schedule delivery someone backfilled)
still renders `submitted`/`draft`/`late` — the same priority ordering as today, and
consistent with the cron (which suppresses the reminder on a rest weekday but never
prevents a row from existing).

**`isRestDay` gate (line 912) — unchanged mechanically, corrected in effect.**
`selectedDayCell?.status === 'rest'` still yields the input/action disable flag. But
because a past uncounted non-rest day now resolves to `'uncounted'` (not `'rest'`),
`isRestDay` is correctly FALSE for it → inputs, +COUNT, SAVE DRAFT, SUBMIT all
enable (they key off `isRestDay`, lines 785/1127/1139/1151). True rest days
(`status === 'rest'`) keep `isRestDay === true` → stay locked with the REST DAY
pill (lines 1087–1096). No change to any disable expression is required; they
inherit correctness from the derivation. AC "true rest days remain read-only" and
AC "isRestDay is FALSE for a non-rest past uncounted day" are both satisfied by the
single derivation change.

### OQ-1 — RULING: status token, pill, i18n for a past non-rest uncounted day

- **Token name: `'uncounted'`.** Extend `DayStatus` (line 28) to
  `'today' | 'submitted' | 'draft' | 'late' | 'uncounted' | 'rest'`.
- **Pill treatment: the reserved `violet` / `violetBg` Cmd tokens.**
  `src/theme/colors.ts:206–207` (light) and `:240–241` (dark) already define
  `violet`/`violetBg` "reserved for the 'count not submitted' concept" (spec 130).
  A past uncounted day is *precisely* the count-not-submitted concept — it is the
  day that trips spec 130's reorder gate. Painting the `'uncounted'` pill violet
  gives exact cross-screen semantic parity: **violet = "count not submitted /
  needs a count" in both the EOD section and the Reorder section.** This is
  visually distinct from `'rest'` (`C.fg3`/`C.panel2`, grey) and from `'late'`
  (`C.warn`/`C.warnBg`, amber), satisfying the AC "distinct, non-'rest' pill … must
  not be labeled 'late'." Add to `dayPillFor` (line 900):
  `if (status === 'uncounted') return { fg: C.violet, bg: C.violetBg, label:
  T('section.eod.uncounted') };` — placed above the terminal `'rest'` return.
- **i18n key: `section.eod.uncounted`.** Sidebar pills are short lowercase glyphs
  (`submitted`/`draft`/`late`/`today`/`rest`). Match that register:
  - `src/i18n/en.json`: `"uncounted": "needs count"`
  - `src/i18n/es.json`: `"uncounted": "falta conteo"`
  - `src/i18n/zh-CN.json`: `"uncounted": "待录入"`

  Add the key adjacent to the existing `rest` key (en.json:476) in all three
  catalogs. All three MUST be added in the same PR — a missing locale key renders
  the raw path.

  The worksheet-head pill (the strip next to the date, lines 1087–1096) currently
  renders ONLY for `isRestDay`. It does NOT need an `'uncounted'` variant for v1 —
  the sidebar pill already signals the state and the worksheet is fully editable, so
  a head pill would be noise. (If the owner later wants a "backfilling — DATE" head
  banner, that reopens as a follow-up; out of scope here.)

### OQ-2 — RULING: `showUnscheduled` does NOT unlock a true rest day

Confirm the spec's v1 recommendation: **true rest days stay locked regardless of
the `showUnscheduled` toggle.** Rationale and mechanics:

- `isRestDay` derives purely from `selectedDayCell.status` (schedule weekday), with
  no dependency on `showUnscheduled`. `inputsDisabled = isRestDay || isVendorLocked`
  (line 785) and the action buttons gate on `isRestDay` (lines 1127/1139/1151). No
  code change is needed to hold this — the toggle already only affects
  `vendorTabs` membership (lines 324–328), not the disable flags.
- Net behavior: flipping `showUnscheduled` on a true rest day may reveal vendor tabs
  for *viewing*, but every input and action stays disabled and the REST DAY pill
  stays shown. This matches the "keep rest days locked" decision and is the simplest
  correct slice. The frontend MUST NOT wire `showUnscheduled` into `isRestDay` or
  `inputsDisabled`. (An off-schedule backfill on a true rest day is a deliberate
  non-goal for v1; if the owner needs it, that is a separate spec.)

### `src/lib/db.ts` surface

None added. Explicit contract: the frontend reuses `submitEOD`/`submitEODCount`
verbatim and adds NO new write helper. A reviewer flag if any new `supabase.from`/
`supabase.rpc` call appears outside `db.ts` for this feature (the staff-subtree
carve-out does not apply — this is admin Cmd).

### Realtime impact

No channel or publication change. A landed backfilled `eod_submissions` row
replays through the existing `store-{id}` channel via the 400ms-debounced
`useRealtimeSync` on the admin shell; that reload is what clears spec 130's
per-vendor `eodSubmittedAt == null` gate for the backfilled date (AC: reorder
CREATE PO / quick-order re-enable with no wiring on the reorder side). No
`docker restart supabase_realtime_imr-inventory` step — publication membership is
untouched.

### Frontend store impact

None to `useStore.ts` slices. `orderSchedule` and `eodSubmissions` are already
loaded; the change is pure derivation inside `EODCountSection.tsx` plus the
extracted helper. The write already uses the optimistic-then-revert +
`notifyBackendError` path inside `submitEOD`/`submitEODCount`; backdated writes
inherit it unchanged.

### Testability — RULING: extract `isRestWeekday` + `deriveDayStatus` to a pure module

The week-derivation logic is currently inline in a `useMemo`, untestable without
mounting the component. Mirror this repo's extract-and-pin pattern
(`src/lib/countOrder.ts`, `src/utils/minutesAfterDeadline.ts`): extract the pure
logic to a new module and have the component import it. Proposed
`src/lib/eodDayStatus.ts` (frontend-developer authors the implementation):

```ts
export type DayStatus =
  | 'today' | 'submitted' | 'draft' | 'late' | 'uncounted' | 'rest';

// True iff the store's schedule is configured AND weekday `day` has zero
// scheduled vendors. Mirrors eod-reminder-cron Track-1 gate semantics.
export function isRestWeekday(
  orderSchedule: Record<string, Array<{ vendorId?: string | null }>> | null | undefined,
  day: DayName,
): boolean;

// Pure day-status reducer for one day cell.
export function deriveDayStatus(input: {
  isToday: boolean;
  isRestWeekday: boolean;
  anyDraft: boolean;
  anySubmitted: boolean;
  counted: number;
  total: number;
}): DayStatus;
```

The component's `week` memo calls `isRestWeekday(orderSchedule, dayName)` per
iteration and feeds `deriveDayStatus(...)`; the `DayStatus` type moves to (or is
re-exported from) this module so line 28 imports it. `scheduleConfigured` (line
292) can stay inline OR be folded into `isRestWeekday` — implementer's choice, but
if folded, keep the line-292 memo as a thin wrapper so the vendor-tab filtering at
lines 324–328 is undisturbed.

**Jest coverage expectation (jest track only — no pgTAP/shell):**
Pin `deriveDayStatus` + `isRestWeekday` in `src/lib/__tests__/eodDayStatus.test.ts`:

1. Past day, schedule configured, ≥1 vendor that weekday, zero submissions →
   `'uncounted'` (NOT `'rest'`, NOT `'late'`).
2. Past day, schedule configured, zero vendors that weekday, zero submissions →
   `'rest'` (true rest day stays locked).
3. Schedule UNCONFIGURED (`isRestWeekday` false for all) → past uncounted day is
   `'uncounted'`, i.e. all days editable — the fallback AC.
4. Regression guards: past day with a draft → `'draft'`; past day submitted with
   `counted < total` → `'late'`; `counted >= total` → `'submitted'` (no regression
   to lines 251–268).
5. `isToday === true` → `'today'` (or `'draft'` when `anyDraft`) regardless of
   `isRestWeekday` — proves today is never locked.

Grep for and update any existing test that pins the old "past uncounted → rest"
behavior before running full `npx jest` (per the run-full-jest-before-commit
memory).

### Risks and tradeoffs

- **Today-on-a-rest-weekday stays editable (intended).** The state machine keeps
  today as `'today'`/`'draft'` even when the weekday has no scheduled vendors. This
  is preserved existing behavior, not a new decision, and is the correct slice
  (133 is past-day backfill). Flagged so a reviewer doesn't read it as a gap.
- **`isRestWeekday` must track the cron.** If a future spec changes the cron's
  rest-day definition (e.g. per-vendor EOD schedules), this client mirror and the
  jest pins must move in lockstep — same drift surface as the
  `minutesAfterDeadline`/cron pair. Called out so the parity is maintained.
- **Violet-token reuse couples two sections semantically.** Intentional: both mean
  "count not submitted." If spec 130's violet is ever repurposed, both call sites
  move together. Low risk — the token comment already scopes it to this concept.
- **No performance concern on the 286 KB seed.** The added work is a 7-iteration
  in-memory schedule lookup per render of an already-memoized block; negligible.
  No new query, so no seed-dataset or cold-start exposure.
- **RLS gap check:** none. The write already required `auth_can_see_store`; no path
  is widened. The only new capability is client-side enabling of an input on a
  past date, which the server already accepted — 133 removes a UI lock, it does not
  grant new data access.

## Handoff
next_agent: frontend-developer
prompt: Implement spec 133 against the ## Backend design above. It is frontend-only
  — NO migration/RPC/edge/RLS/publication change. Extract `isRestWeekday` +
  `deriveDayStatus` (with the moved `DayStatus` type) to a new pure module
  `src/lib/eodDayStatus.ts` mirroring `src/lib/countOrder.ts`, and rewire the week
  memo in `src/screens/cmd/sections/EODCountSection.tsx` (lines 240–272) so the
  terminal status splits `isRestWeekday ? 'rest' : 'uncounted'`; keep today and the
  submitted/draft/late branches unchanged. Add the `'uncounted'` case to
  `dayPillFor` (line 900) using `C.violet`/`C.violetBg` and the new
  `section.eod.uncounted` key in all three catalogs (en "needs count", es "falta
  conteo", zh-CN "待录入"). Do NOT wire `showUnscheduled` into `isRestDay`
  (OQ-2 ruling — true rest days stay locked). Add jest pins in
  `src/lib/__tests__/eodDayStatus.test.ts` per the coverage list, grep-and-update
  any stale "past uncounted → rest" test, run full `npx jest`, then set
  Status: READY_FOR_REVIEW and list files under ## Files changed.
payload_paths:
  - specs/133-admin-backfill-past-day-eod-counts.md

---

## Files changed

- `src/lib/eodDayStatus.ts` (new) — pure, dependency-free day-status module:
  `DayStatus` type, `OrderScheduleRow`/`OrderSchedule` types, `scheduleConfigured`,
  `isRestWeekday` (cron Track-1 mirror), and `deriveDayStatus` reducer.
- `src/lib/__tests__/eodDayStatus.test.ts` (new) — 14 jest pins: uncounted vs rest
  vs unconfigured-fallback, draft/late/submitted regression guards, today-never-locked,
  legacy null-vendorId filtering.
- `src/screens/cmd/sections/EODCountSection.tsx` — removed the inline `DayStatus`
  type (now imported); rewired the week memo (~line 240) to call
  `deriveDayStatus`/`isRestWeekday` with the terminal `isRestWeekday ? 'rest' :
  'uncounted'` split; added `orderSchedule` to the memo deps; added the
  `'uncounted'` case to `dayPillFor` using `C.violet`/`C.violetBg`. `isRestDay`
  (~line 912) and all disable expressions untouched (inherit correctness).
- `src/i18n/en.json` — added `section.eod.uncounted` = "needs count".
- `src/i18n/es.json` — added `section.eod.uncounted` = "falta conteo".
- `src/i18n/zh-CN.json` — added `section.eod.uncounted` = "待录入".

## Verification performed

- `npx tsc --noEmit` — clean.
- `npx tsc -p tsconfig.test.json --noEmit` — clean.
- `npx jest` — 123 suites / 1336 tests pass (no stale "past uncounted → rest"
  test existed; the old default lived only inline in the component memo).
- `npx expo export --platform web` — bundles cleanly (new module + i18n keys
  resolve under react-native-web); dist artifact removed.
- Live browser verification (preview_*) NOT performed: the `preview_*`/browser
  tools are unavailable in this agent's tool context. Verification was limited to
  the static + unit + web-bundle checks above. Per the design, local seed has no
  `order_schedule` configured, so the fallback rule means no local day renders
  REST and past empty days show the violet "needs count" pill with editable
  inputs — this is covered by the unconfigured-fallback jest pin but was not
  exercised in a live browser here.
