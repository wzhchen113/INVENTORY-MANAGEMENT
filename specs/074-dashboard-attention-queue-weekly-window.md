# Spec 074: Dashboard Attention Queue — weekly window (Monday-reset)

Status: READY_FOR_REVIEW

## User story

As a store manager browsing the admin Cmd UI Dashboard, I want the per-store
"Attention Queue" to show only the current work-week's actionable items so
the cards stay short and recent, and I want anything older to remain
discoverable elsewhere (existing AuditLogSection, future logs surface) so I
can still investigate past misses when I need to.

Concrete scenario: it's Wednesday morning. Last week a vendor order was
missed on Thursday, Friday, and Saturday. Today the queue currently shows
all three (plus this Monday and Tuesday if applicable). After this spec,
the queue shows ONLY Monday + Tuesday of the current week — the older three
items have rolled off because the week reset on Monday 00:00.

## Acceptance criteria

- [ ] `computeAttentionQueue` accepts a `now: Date` and uses it to derive
  `weekStartISO` = the most recent Monday 00:00 in the store's configured
  timezone (`useStore.timezone`, e.g. `America/New_York`). On a Monday,
  `weekStartISO === todayISO`; on a Sunday, `weekStartISO === todayISO - 6`.
- [ ] The `unconfirmed_po` rule loop no longer iterates a fixed `lookback`
  of 4..7 days. Instead it iterates each ISO date from `weekStartISO`
  through `todayISO - 1` (yesterday) inclusive, in the store's timezone, and
  emits one row per (vendor, date) miss. Today is excluded — a vendor
  order scheduled for today may still be placed; today's miss only fires
  on the next day's pass.
- [ ] On a Monday morning, the `unconfirmed_po` loop emits ZERO rows
  (range is empty: weekStart through yesterday is yesterday-only, and
  yesterday was Sunday — Monday morning sees no Sunday-vs-prior-week
  carryover). Verified with a deterministic `now` injected into the
  selector.
- [ ] No other attention rule's window changes:
  - `eod_missing` still uses today/yesterday (unchanged).
  - `low_out_stock` still uses live `getItemStatus(i)` (unchanged).
  - `food_cost_streak` still uses trailing-7-day variance computation
    (unchanged). Rationale documented in spec as "streak metric is
    intentionally a rolling 7d; not week-aligned."
  - `expiry` still forward-looking (unchanged).
- [ ] The DashboardSection per-store column visual format does not change.
  Only the contents of `queue` shorten on dates past Monday.
- [ ] Unit test: `computeAttentionQueue` invoked with `now = 2026-05-27T10:00:00` (a Wednesday)
  in a fixture where vendor V was scheduled Mon/Tue/Wed/Thu/Fri and only
  Tue had a matching `OrderSubmission` → returns ONE `unconfirmed_po` row
  for the Monday miss (Wed is excluded as "today"; Thu/Fri are in the
  future).
- [ ] Unit test: same fixture but `now = 2026-05-25T10:00:00` (a Monday)
  → returns ZERO `unconfirmed_po` rows.
- [ ] Unit test: same fixture but `now = 2026-05-31T23:00:00` (a Sunday) →
  returns rows for Mon/Wed/Thu/Fri (Tue had a match) — five candidate
  days, four misses.
- [ ] Timezone is honored: a `now` of `2026-05-26T03:00:00Z` evaluated with
  `timezone = 'America/New_York'` (where local time is `2026-05-25 23:00`,
  still Monday) MUST treat `weekStartISO` as `2026-05-25` (this Monday),
  not roll the week forward. The selector must NOT use naive
  `Date#toISOString().slice(0,10)` for this derivation.

## In scope

- Modify `src/lib/cmdSelectors.ts:computeAttentionQueue` to:
  - Accept the store's `timezone` string (IANA format, e.g.
    `America/New_York`) as a new required argument.
  - Derive `weekStartISO` and `todayISO` in that timezone (helper utility,
    pure function, suitable for jest test track).
  - Replace the `for (let lookback = 4; lookback <= 7; lookback++)` block
    with a loop over the [weekStart, yesterday] inclusive ISO date range.
- Update the single call site in `src/screens/cmd/sections/DashboardSection.tsx`
  (line ~280) to pass `useStore.timezone` as the new argument.
- Add jest unit tests covering the three deterministic-`now` cases listed
  in acceptance criteria, plus the timezone-boundary case. Tests live
  alongside any existing `cmdSelectors`-shaped tests OR under
  `src/lib/cmdSelectors.test.ts` if no co-located test exists yet.
- Update inline comment in cmdSelectors.ts above the `unconfirmed_po`
  block to document the new windowing rule (replacing the
  "Look back 3-7 days" comment).

## Out of scope (explicitly)

- **No new audit-log surface for missed orders.** The user's "longer
  timeline can be look back on logs" intent points at the existing
  AuditLogSection, but missed-order events are NOT in `AuditAction` today
  (the audit log tracks user actions, not system-derived alerts). Building
  a missed-order log surface is a separate, larger feature — flagged as a
  follow-up spec. AuditLogSection.tsx is untouched here.
- **No "weekly reset — clean slate" banner.** The existing per-store
  empty-state ("All clear ✓") already handles the Monday-morning case;
  adding new copy is scope creep.
- **No changes to `food_cost_streak` windowing.** It's a rolling-7d metric
  by design — week-aligning a streak would mislead operators on Monday
  morning ("streak: 0 days" right after a 4-day streak on Sunday).
- **No changes to `low_out_stock`, `expiry`, or `eod_missing` windows.**
  All inherently current-state or already correctly scoped.
- **No SQL/RPC refactor.** The attention queue is computed client-side
  from already-loaded slices; no new RPC, no new edge function, no new
  migration. (The architect may flag a different approach in the design
  doc — that's their call.)
- **No DashboardSection visual redesign.** Per-store column layout, KPI
  strip, CoGS card, heatmap are all unchanged.
- **No per-brand vs per-store change.** Queue stays per-store.
- **No realtime channel changes.**

## Open questions resolved

- Q: Window semantics — Monday-reset vs trailing 7 days? → A: Monday-reset
  in the store's timezone. On a Monday the window opens fresh.
- Q: Which timezone? → A: Use the existing `useStore.timezone`
  (single brand-wide setting, settable by admin/master via TimezoneBar).
  No per-store timezone field exists today; one timezone covers all stores.
  This may break for a multi-region brand later — flag as follow-up.
- Q: What gets windowed? → A: Only `unconfirmed_po` (vendor order missed
  rows). Other rules' windows are unchanged because they're already
  current-state or already-scoped correctly. Rationale in "Out of scope."
- Q: AuditLog parity — does this spec also create a missed-order log? →
  A: No. Out of scope. Missed-order events are not in `AuditAction` today;
  creating that surface is a larger separate feature.
- Q: Empty-state copy on Monday morning? → A: No new copy. Existing
  "All clear ✓" handles it.
- Q: Per-brand vs per-store? → A: Per-store (unchanged).

## Dependencies

- `src/lib/cmdSelectors.ts` — signature change to
  `computeAttentionQueue` adds a `timezone` argument. Existing call site
  in `DashboardSection.tsx:280` is the only caller (verified via grep).
  No external consumers; no breaking change beyond the one file.
- `src/store/useStore.ts` — `timezone` slice already exists and is
  exposed; no slice change needed.
- Pure utility for ISO-date-in-IANA-timezone math (e.g. `Intl.DateTimeFormat`
  with `timeZone` option). May add a small helper to `src/utils/` or
  inline within cmdSelectors. Architect's call.
- Jest test track (existing infra per spec 022). No pgTAP, no shell smoke.

## Project-specific notes

- **Cmd UI section / legacy**: Cmd UI only. `DashboardSection.tsx` under
  `src/screens/cmd/sections/`. No legacy admin surface remains
  (spec 025 deleted it).
- **Per-store or admin-global**: Per-store. The attention queue is
  computed per-store in a loop over `stores`. The timezone, however, is
  brand-global (single `useStore.timezone`), which is a known
  approximation — flagged as a future-spec concern.
- **Realtime channels touched**: None.
- **Migrations needed**: No.
- **Edge functions touched**: None.
- **Web/native scope**: Both. DashboardSection renders identically on web
  and native; the timezone-aware ISO math must work on both Hermes and
  V8 (Intl.DateTimeFormat with `timeZone` is supported on RN 0.81 via
  the Hermes Intl variant — architect to confirm bundle behavior; if
  Intl is unavailable on a target, fall back to a manual offset
  computation derived from `Intl.DateTimeFormat({...}).format(now)`
  parsing).
- **Tests track**: jest. Tests must use a deterministic `now: Date`
  injected into `computeAttentionQueue` (the selector already accepts
  `now` per current signature line 748). No real Date.now()
  dependency in tests.
- **`app.json` slug**: Not touched.
- **CLAUDE.md "Permissive RLS" rule**: N/A — no DB policy changes.
- **CLAUDE.md "Edge function" rules**: N/A — no edge functions.
- **Follow-up spec candidates** (do NOT fold into this spec):
  1. Missed-order audit-log surface so the user's "look back on logs"
     intent actually works for missed orders specifically.
  2. Per-store timezone (today the brand has one TZ). Required if 2AM
     PROJECT expands beyond a single region.

## Frontend design

### Path correction

The spec body refers to `src/store/cmdSelectors.ts` and `src/lib/cmdSelectors.ts`
interchangeably. The file actually lives at
[src/lib/cmdSelectors.ts](src/lib/cmdSelectors.ts). The `unconfirmed_po` loop
is at lines 849-878 and `computeAttentionQueue` signature is at line 739.
This is a documentation fix only — no code move.

### Decision 1 — Client-side filter is correct; do NOT push the window to RPC

**Verdict: client-side, no RPC change.**

The attention queue is computed in `cmdSelectors.ts` from already-loaded
slices (`inventory`, `eodSubmissions`, `orderSubmissions`, etc.) that the
Dashboard needs anyway for the heatmap, KPI strip, CoGS card, and food-cost
variance computation. The `unconfirmed_po` rule reads from
`orderSubmissions` and `orderSchedule`. Both are loaded via
`db.fetchOrderSubmissionsForStores(...)` / `useStore.orderSchedule` for the
Dashboard's existing 30-day date range — not for the attention queue
specifically. Shrinking the loader window from 30d to 7d to "save wire" would
break the heatmap and the trailing-7-day food-cost streak that also reads
from the same buffer.

The wire savings on a 7-day-vs-30-day window for one brand's
`orderSubmissions` rows are sub-kilobyte. The actual win — fewer rows
iterated in the `for` loop — is from the [weekStart, yesterday] range
being at most 6 entries, vs. the current 4 fixed entries: this is a wash.

Pushing the window into a new RPC would: (a) require a migration adding a
function that takes a `tz` argument and computes Monday-reset server-side
in Postgres (`date_trunc('week', now() AT TIME ZONE tz)`), (b) bypass the
existing client store, (c) re-introduce the "old events still on the
wire for the heatmap" condition anyway. Not worth it for this spec.

**"Old events on the wire" question, answered:** It's fine that `db.ts`
keeps loading the broader window — other surfaces (heatmap, food-cost
variance) consume those rows. The window is a presentation filter for the
attention queue specifically. Document this in the inline comment on the
`unconfirmed_po` loop so future readers don't assume the loader needs
tightening.

### Decision 2 — Helper goes in `src/utils/`, NOT inline

**Verdict: new file [src/utils/weekWindow.ts](src/utils/weekWindow.ts).**

Rationale:
- [src/utils/businessDay.ts](src/utils/businessDay.ts) already establishes
  the codebase pattern of timezone-aware date helpers as pure functions
  under `src/utils/`. It exports `getBusinessTodayParts(tz)` and
  `computeWeekdayDateISO(weekday, tz)` and is consumed by
  `cmdSelectors.ts`-adjacent code (eodStatus.ts, OrderScheduleSection,
  EODCount). Putting the new helper in the same neighborhood keeps the
  timezone-math surface coherent.
- The "Monday 00:00 in IANA tz" computation is a plausible building block
  for follow-up surfaces: spec body §"Follow-up spec candidates" #1
  (missed-order audit-log surface) will want the same window. The PM
  also flagged a future per-store-timezone refactor as a candidate —
  centralizing the helper makes that one-file change instead of grep-
  and-replace.
- Inline in `cmdSelectors.ts` would force a jest test of the helper to
  spin up the full selector or to re-export the helper just for testing,
  both worse than a standalone unit test on a focused pure function.

### Decision 3 — Hermes Intl is reliable on RN 0.81; no polyfill, no fallback

**Verdict: use `Intl.DateTimeFormat({timeZone: tz}).formatToParts()` directly.
No `date-fns-tz`, no `formatjs/intl` polyfill.**

Evidence:
- `date-fns-tz` is NOT in [package.json](package.json) (only `date-fns@3.6.0`).
- [src/utils/businessDay.ts:29](src/utils/businessDay.ts) and
  [src/utils/eodStatus.ts:91](src/utils/eodStatus.ts) already ship
  `Intl.DateTimeFormat('en-US', {timeZone: tz, ...}).formatToParts(...)`
  in production on both web and Hermes — this is a load-bearing pattern,
  not an experiment. RN 0.81 ships Hermes with Intl on by default
  (`hermes.enable_intl=true` is the SDK 54 default). Spec 009's
  `getBusinessTodayParts` and the spec 060 EOD-status code path both
  exercise it.
- If a future RN upgrade ships Hermes without Intl, the failure mode is
  a thrown `RangeError` at app boot from `businessDay.ts`'s existing
  call sites, not a silent miscompute in the new helper. That's a loud
  signal, and the fix is one place (add the polyfill in [App.tsx](App.tsx)),
  not per-helper.
- No fallback path needed for this spec.

### Decision 4 — `timezone` is REQUIRED (no default)

**Verdict: required positional argument; existing `now` stays optional with
default `new Date()`.**

Rationale (confirming PM's lean):
- A silent default like `'UTC'` or `'America/New_York'` would silently
  miswindow the queue for multi-region brands or a misconfigured store. A
  miscompute in this surface looks like "valid data, wrong day" — the
  worst class of bug for an operator dashboard.
- The single call site in [DashboardSection.tsx:280](src/screens/cmd/sections/DashboardSection.tsx)
  has `useStore.timezone` in scope already (the same slice that powers the
  TimezoneBar). Adding one argument is trivial.
- TypeScript's `tsc --noEmit` (CI gate per spec 022) will fail loudly at
  the call site if anyone forgets to thread it through.
- Future-proofing: when per-store timezone lands (follow-up #2), every
  call site must change anyway — a required arg means the compiler hands
  the developer the full audit list for free.

### Exact signature change

```ts
// src/lib/cmdSelectors.ts (line 739)
export function computeAttentionQueue(
  storeId: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  orderSubmissions: OrderSubmission[],
  orderSchedule: OrderSchedule,
  stores: Store[],
  getItemStatus: (i: InventoryItem) => ItemStatus,
  timezone: string,         // NEW — required, positional, BEFORE now
  now: Date = new Date(),
): AttentionItem[]
```

Positional ordering: `timezone` goes between `getItemStatus` and `now` so
that the `now` default keeps working at the call site (TS would otherwise
reject `(..., getItemStatus, undefined, new Date())`). Tests pin both
`timezone` and `now` explicitly.

### Helper signature

```ts
// src/utils/weekWindow.ts (new file)

/**
 * Returns ISO date strings for the current week-window in the given IANA
 * timezone. Week starts on Monday 00:00 local. On a Monday, weekStartISO
 * equals todayISO. On a Sunday, weekStartISO is six days earlier.
 *
 * `now` is injectable for deterministic tests; defaults to current wall
 * clock. Pure function — no side effects, no module-level state.
 */
export interface WeekWindow {
  /** ISO YYYY-MM-DD for the most recent Monday at 00:00 in `tz`. */
  weekStartISO: string;
  /** ISO YYYY-MM-DD for "today" in `tz` (NOT business-day shifted). */
  todayISO: string;
}

export function getWeekWindow(tz: string, now: Date = new Date()): WeekWindow;

/**
 * Inclusive ISO date range [startISO, endISO]. Returns [] when start > end.
 * Used by the unconfirmed_po loop to walk weekStart..yesterday.
 */
export function isoDateRange(startISO: string, endISO: string): string[];
```

**Important nuance — NOT using `getBusinessTodayParts`.** The existing
`businessDay.ts` helper shifts back 3 hours so that 02:30 AM still reads
as "yesterday" for restaurant closing-shift semantics. That's correct for
EOD counting but WRONG for the attention queue: an operator checking the
dashboard at 02:30 AM Monday expects the queue to have already reset
(today is Monday, business-day-shifted "today" is Sunday). The new helper
uses the raw `Intl.DateTimeFormat(...).formatToParts(now)` without the
3-hour shift. Inline comment in `weekWindow.ts` must call this out so a
future reader doesn't "refactor" the two into one.

Day-of-week math: use `Intl.DateTimeFormat('en-US', { timeZone: tz,
weekday: 'long' }).formatToParts(now)` to get the localized weekday name,
map through the `DAY_NAMES`/`WEEKDAY_INDEX` constant pattern already in
[businessDay.ts:45](src/utils/businessDay.ts), then UTC-arithmetic backwards
to Monday using the year/month/day parts (same `Date.UTC(...)` + `setUTCDate`
shape as `computeWeekdayDateISO`).

### Loop replacement in cmdSelectors.ts

Replace lines 855-878 (the current `for (lookback = 4; lookback <= 7; ...)`
block) with:

```ts
// Monday-reset window per spec 074. We iterate dates from weekStart
// through yesterday inclusive; today is excluded because a vendor order
// scheduled for today may still be placed before EOD. Note: db.ts still
// loads a broader orderSubmissions window for the heatmap + food-cost
// surfaces; this is a presentation filter, not a loader change.
const { weekStartISO, todayISO: todayISOInTz } = getWeekWindow(timezone, now);
const yesterdayISOInTz = isoDateRange(weekStartISO, todayISOInTz).slice(0, -1);
for (const pastISO of yesterdayISOInTz) {
  const past = parseISOToLocalDate(pastISO); // see helper note below
  const pastDayName = DAY_NAMES[past.getDay()];
  const scheduled = orderSchedule[pastDayName] || [];
  for (const v of scheduled) { ... unchanged matching loop ... }
}
```

Note: the existing block uses `todayISO` derived from
`now.toISOString().slice(0,10)`. That stays for the other rules in the
function (eod_missing, food_cost_streak — both are tz-naive today and OUT
of scope per spec). The new `todayISOInTz` shadow is scoped to the
`unconfirmed_po` block.

The `parseISOToLocalDate` helper is a one-liner already inlined at
[cmdSelectors.ts:906](src/lib/cmdSelectors.ts) for the expiry block —
reuse the same pattern (regex-match the YYYY-MM-DD, construct
`new Date(y, m-1, d)`).

### Call site change

[src/screens/cmd/sections/DashboardSection.tsx:280](src/screens/cmd/sections/DashboardSection.tsx)
adds one argument:

```ts
const timezone = useStore((s) => s.timezone);
// ...
out[s.id] = computeAttentionQueue(
  s.id, inventory, allEod, allPos,
  orderSubmissions, orderSchedule, stores, getItemStatus,
  timezone,   // NEW
);
```

The `useMemo` dependency array must add `timezone`.

### Test injection points

Two layers of jest tests; both purely synchronous, no mocks beyond the
function arguments themselves.

**Layer 1 — `src/utils/weekWindow.test.ts` (new file).** Pure-function
tests on `getWeekWindow(tz, now)`:
- `('America/New_York', 2026-05-27T14:00:00Z)` → Wednesday in NY local
  (10:00 AM) → `weekStartISO = '2026-05-25'`, `todayISO = '2026-05-27'`.
- `('America/New_York', 2026-05-25T14:00:00Z)` → Monday in NY → both
  ISOs are `'2026-05-25'`.
- `('America/New_York', 2026-05-26T03:00:00Z)` → in NY this is Mon
  23:00 local → both ISOs are `'2026-05-25'` (the timezone-boundary case
  in acceptance criteria).
- `('Asia/Tokyo', 2026-05-31T15:00:00Z)` → Mon 00:00 in Tokyo →
  `weekStartISO = '2026-06-01'`, `todayISO = '2026-06-01'` (week
  rolls forward at JP midnight, not US midnight).
- `isoDateRange('2026-05-25', '2026-05-27')` → `['2026-05-25',
  '2026-05-26', '2026-05-27']`. Start-after-end returns `[]`.

**Layer 2 — `src/lib/cmdSelectors.test.ts` (new file OR extend
existing).** Selector-level tests with a fixture matching the spec
acceptance criteria:
- Fixture: `orderSchedule = { Monday: [V], Tuesday: [V], Wednesday: [V],
  Thursday: [V], Friday: [V] }`, one matching submission for V on
  Tuesday.
- `now = new Date('2026-05-27T14:00:00Z'), timezone = 'America/New_York'`
  → exactly ONE `unconfirmed_po` row (Monday miss; Tue matched; Wed is
  "today" — excluded; Thu/Fri are future weekdays not yet reached).
- `now = new Date('2026-05-25T14:00:00Z'), timezone = 'America/New_York'`
  → ZERO `unconfirmed_po` rows.
- `now = new Date('2026-05-31T18:00:00Z'), timezone = 'America/New_York'`
  → 4 rows (Mon/Wed/Thu/Fri misses; Tue matched).
- Smoke: existing rules (`eod_missing`, `low_out_stock`, `expiry`) still
  return the same shape they did before the signature change. This is
  defense-in-depth against accidentally breaking the un-windowed rules.

Both layers run in the existing jest infra ([.github/workflows/test.yml](.github/workflows/test.yml));
no pgTAP, no smoke, no migration test.

### Data model / RLS / API / Edge function / db.ts / Realtime / Store impact

| Surface | Change |
|---|---|
| Data model | NONE. |
| RLS | NONE. |
| API (PostgREST/RPC) | NONE. |
| Edge functions | NONE. |
| `src/lib/db.ts` | NONE. (Carve-out: the spec is selector-only; no loader change.) |
| Realtime | NONE. Publication membership unchanged; no `docker restart supabase_realtime_imr-inventory` step. |
| `src/store/useStore.ts` slice | NONE — `timezone` slice already exists at line 518; we just READ it at the call site. |
| Optimistic-then-revert | N/A — no mutations. |

### Risks and tradeoffs

- **Critical: tz drift across the function.** The selector still derives
  a tz-naive `todayISO` (line 751) and tz-naive `yesterdayISO` (line 754)
  for the `eod_missing` rule, AND a tz-naive 7-day window for
  `food_cost_streak` (line 819). This spec explicitly leaves those
  untouched (out of scope per body §"No other attention rule's window
  changes"). The result is that at 23:30 Sunday Eastern (= 03:30 Monday
  UTC), the `unconfirmed_po` block correctly sees "still Sunday, queue
  still has last week's misses", while `eod_missing` may incorrectly see
  "Monday already, today's EOD missing." This pre-existing inconsistency
  predates spec 074 and is not introduced by it — but a developer reading
  the code will see two windows side-by-side and may "fix" one or the
  other. Mitigation: inline comment in the `unconfirmed_po` block stating
  "this rule uses tz-aware ISOs; the other rules in this function are
  tz-naive by intent — see spec 074 §scope."
- **Should-fix: `'en-US'` locale lock-in.** The new helper hardcodes
  `'en-US'` for `Intl.DateTimeFormat` to get a stable English weekday
  name to lookup into `WEEKDAY_INDEX`. This is the same pattern
  `businessDay.ts` uses today and is correct, but worth a comment.
- **Minor: jest fixture flakiness on real `new Date()`.** Tests MUST pass
  `now` explicitly; an accidental `computeAttentionQueue(..., timezone)`
  without `now` would default to wall-clock and break randomly. The
  required-arg ordering (timezone before now) helps the compiler catch
  this but doesn't fully prevent it. Mitigation: a single inline lint
  comment in the test file ("never omit `now` here").
- **No edge function cold-start, no seed dataset performance issue, no
  migration ordering.** All risks are isolated to client-side selector
  math.

### CI gates

- jest passes (new unit tests).
- `tsc --noEmit` passes (new positional arg threaded through the one
  call site).
- `tsc -p tsconfig.test.json --noEmit` passes (test file types).
- No pgTAP changes; no `db-migrations-applied` impact.

## Handoff

next_agent: frontend-developer
prompt: Implement against the design in this spec. There is NO backend
  work — the entire change is client-side in src/lib/cmdSelectors.ts +
  one new util file under src/utils/. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/074-dashboard-attention-queue-weekly-window.md

## Files changed

- `src/utils/weekWindow.ts` — NEW. `getWeekWindow(tz, now)` returns the
  `[mondayStart, nextMondayStart)` Date window for the work-week
  containing `now` in the supplied IANA timezone. Boundary instants are
  UTC-anchored "logical dates" — their UTC Y/M/D fields equal the local
  Monday's calendar date in `tz`. Companion helpers: `isoDateRange(start,
  end)` enumerates `YYYY-MM-DD` strings for the half-open `[start, end)`
  range; `getLocalDateISO(tz, now)` reads today's local date in `tz` for
  the today-excluded check. Inline header comment calls out the
  intentional divergence from `getBusinessTodayParts` (which is wrong
  for calendar-week reset).
- `src/utils/weekWindow.test.ts` — NEW. 11 tests covering UTC, NY,
  Tokyo, the UTC-late-night Monday boundary, the JST-midnight Monday
  rollover, the Sunday "still this week" case, the spring-forward DST
  week, single-day and month-boundary ranges for `isoDateRange`, and
  the start >= end empty case.
- `src/lib/cmdSelectors.ts` — `computeAttentionQueue` signature gains
  `timezone: string` as a required positional argument before the
  optional `now`. The `unconfirmed_po` block replaces its fixed
  `lookback = 4..7` loop with iteration over the ISO dates in
  `[mondayStart, today)` in `timezone`. Inline comment documents (a)
  why this rule diverges from the other two tz-naive rules in the
  function and (b) the load-bearing "presentation filter, not loader
  change" intent so future devs don't tighten the broader cross-store
  loader window. `eod_missing` and `food_cost_streak` are deliberately
  untouched per spec scope.
- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` — NEW. 8 tests
  matching the architect's acceptance criteria: Monday 00:01 empty,
  Wed afternoon → one Monday miss, Tue afternoon → one Monday miss,
  Sunday night → 4 misses (Mon/Wed/Thu/Fri with Tue matched), the
  Monday 00:00 edge case (previous week immediately drops), an
  in-window row included, an out-of-window row excluded, and the
  UTC-late-night NY tz boundary case.
- `src/screens/cmd/sections/DashboardSection.tsx` — Reads `timezone`
  from `useStore`, passes it through to `computeAttentionQueue`, and
  adds it to the queue `useMemo` deps. Comment notes that brand-global
  timezone is a known approximation (per-store tz is a follow-up
  spec).
