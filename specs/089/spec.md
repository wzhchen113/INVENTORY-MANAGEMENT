# Spec 089: Staff Reorder page (view + cross-platform export/share)

Status: READY_FOR_REVIEW

## User story
As a store **manager** working in the **staff app** (`src/screens/staff/`), I want a
**Reorder** page for my currently-selected store that shows the same per-vendor "what to
order" list the admin desktop Reorder shows — by-the-case display, the order-out calendar
look-back, and the KPI cards — so that I can **export or share** that list (CSV / PDF /
plain text) to send to the vendor, **without** needing the admin desktop shell. Ordering
happens externally; this page is read-only for the data plus an export/share affordance.

## Context (verified against code)

**Backend is already manager-callable and already returns every field this needs — no
backend change is required for the data path.**

- `report_reorder_list(p_store_id uuid, p_params jsonb)`
  ([supabase/migrations/20260514130000_report_reorder_list.sql](../../supabase/migrations/20260514130000_report_reorder_list.sql))
  is `security invoker`, `revoke … from public, anon` + `grant execute … to authenticated`
  (lines 606-609), and gates **only** on `auth_can_see_store(p_store_id)` (lines 119-122) —
  NOT an admin-role check. A manager (role `user`) with a `user_stores` grant for the store
  can call it for that store.
- The latest reorder migration `20260602000000_reorder_suggested_cases.sql` (spec 088, just
  shipped) adds the case fields to the per-item JSON: `case_qty` (always present; 1 when no
  case size), `suggested_cases` (`ceil`; JSON null when `case_qty ≤ 1`), `suggested_units`
  (the ordered base-unit total) — lines 391, 437-441, 490+. So the staff page can render the
  spec-088 by-the-case display with no migration.
- The RPC supports spec-087's calendar look-back via the `as_of_date` param
  (`p_params->>'as_of_date'`, lines 128-131); omitting it falls back to `current_date`.
- `order_schedule` SELECT policy is `using (auth_can_see_store(store_id))`
  ([supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:24-26](../../supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql)).
  A manager with a `user_stores` grant **can read** their store's `order_schedule` rows. The
  staff EOD screen ALREADY reads `order_schedule` directly via `supabase.from('order_schedule')`
  (`fetchVendorsForToday`, [src/screens/staff/screens/EODCount.tsx:82-94](../../src/screens/staff/screens/EODCount.tsx)).
  So the data the spec-087 calendar/order-out filter needs (active-days highlight + order-out
  partition) is already RLS-readable by managers. **No RLS / grant gap found.**

**Frontend pieces — what's reusable vs. what must be re-implemented.**

- `src/utils/reorderDayFilter.ts` is a PURE, framework-free util (no React / store / supabase
  imports): `weekdayName`, `activeWeekdaysFromSchedule`, `partitionReorderVendors`,
  `computeReorderKpis`. It is **directly importable from the staff subtree** as-is.
- The cases-aware string formatters `formatSuggested` / `formatSuggestedPdf` and the CSV
  builder `buildReorderCsv` currently live INSIDE
  [src/screens/cmd/sections/ReorderSection.tsx](../../src/screens/cmd/sections/ReorderSection.tsx)
  (lines 62-78, 433-476), alongside private helpers `formatQty` / `formatMoney` /
  `slugifyStore`. They are pure logic but **not currently extracted**. They are already
  exported "for jest" but importing them from the staff screen would couple the staff subtree
  to a Cmd-themed admin component module.
- The admin export is **web-only**: `triggerDownload` uses `document.createElement('a')`
  (lines 416-427) and `handlePdfExport` uses `jsPDF.save()` (line 593) — both DOM-only, gated
  by `Platform.OS === 'web'` (export buttons hidden on native, line 692). The "Native port
  (expo-file-system + expo-sharing) is a separate spec" note at lines 405-406 of ReorderSection
  **is this spec's hardest item.**
- `expo-sharing` (~14.0.8) and `expo-file-system` (~19.0.21) are ALREADY in
  [package.json](../../package.json) (lines 43, 47) but are **NOT imported anywhere in `src/`
  today** (greenfield — no in-repo precedent for the native share sheet). `papaparse`,
  `jspdf`, `jspdf-autotable` are also already deps.
- The admin fetch is `fetchReorderSuggestions(storeId, asOfDate?)`
  ([src/lib/db.ts:2706-2748](../../src/lib/db.ts)) which calls `report_reorder_list` and maps
  the payload through `mapReorderVendor`. The admin caches it in the `useStore.orderSchedule`
  + `reorderPayload` slices. The staff app has its **own** Zustand store
  ([src/screens/staff/store/useStaffStore.ts](../../src/screens/staff/store/useStaffStore.ts) —
  auth + active-store + EOD queue slices only; NO reorder/order-schedule data slices) and a
  documented db carve-out (direct `supabase.*` calls allowed in the staff subtree —
  CLAUDE.md "DB access centralized"), so it needs its own fetch.
- `ReorderDatePicker` ([src/components/cmd/ReorderDatePicker.tsx](../../src/components/cmd/ReorderDatePicker.tsx))
  is an RN Modal calendar that is cross-platform (web + native) BUT themed via `useCmdColors()`
  — NOT usable in the staff light/dark theme as-is.

**Staff subtree shape (the target surface).**

- Light/dark theme that follows the OS (`useStaffColors()` /
  [src/screens/staff/theme.ts](../../src/screens/staff/theme.ts)) — NOTE: spec 070 added a dark
  palette, so "light-only" in the original request is slightly stale; the staff theme is now
  OS-driven light/dark. Mobile-first, glove-on, portrait-phone design constraints.
- Own i18n catalog (`t()` over `en.json` at
  [src/screens/staff/i18n/](../../src/screens/staff/i18n/)).
- `StaffStack` ([src/screens/staff/navigation/StaffStack.tsx](../../src/screens/staff/navigation/StaffStack.tsx))
  is a render-branch state machine: `Splash` (transient) → `StorePicker` (signed-in, no active
  store, >1 store) → `EODCount` (signed-in, active store). There is currently NO multi-screen
  navigation once you have an active store — EODCount is the only mounted screen in that branch.
- The active-store pattern: `useStaffStore.activeStore` (`{ id, name }`), set via
  `setActiveStore`; `StorePicker` selects it. This is the per-store scope to reuse.
- Staff `notifyBackendError` ([src/screens/staff/lib/notifyBackendError.ts](../../src/screens/staff/lib/notifyBackendError.ts)),
  imported as `notifyStaffBackendError` in App.tsx.

## Acceptance criteria

**Data + scope (manager-RLS-scoped):**
- [ ] A new staff Reorder screen renders the per-vendor reorder list for the manager's
      **currently-selected `activeStore`** (one store at a time), by calling
      `report_reorder_list` with `{ p_store_id: activeStore.id, p_params: { as_of_date } }`
      through a staff-subtree fetch (carve-out). It does NOT call the admin `db.ts`
      `fetchReorderSuggestions` (different store/slice/theme).
- [ ] The screen is gated on an active store: if `activeStore` is null it does not attempt a
      fetch (mirrors the StorePicker → screen gate; reuse the existing EOD active-store pattern).
- [ ] A manager (role `user`) with a `user_stores` grant for the store (e.g.
      `manager@local.test` granted Towson + Frederick) can load the screen and see vendors;
      a store the manager is NOT granted yields the RPC's 42501 surfaced as a non-crashing
      error state (not a silent blank).

**Full parity with admin Reorder (adapted to the staff theme + mobile layout):**
- [ ] **By-the-case display (spec 088):** for an item where the server returns
      `suggestedCases != null`, the Suggested figure reads `N cases · M unit` (singular
      `1 case`); the FE uses the server-authoritative `suggestedUnits` for `M` and does NO
      cost math (Est $ reads the server-rounded `estimatedCost`). Non-case items read
      `{suggestedQty} {unit}`. Byte-for-byte matches the admin `formatSuggested` output.
- [ ] **Calendar look-back (spec 087):** a date picker (staff-themed) lets the manager pick an
      as-of date no later than today; picking a date re-fetches with that `as_of_date`. The
      picker highlights the store's order-out weekdays (active-days) derived from
      `order_schedule` via `activeWeekdaysFromSchedule`.
- [ ] **Order-out filter (spec 087):** the rendered list is the PRIMARY "order today" set —
      vendors scheduled to order out on the selected weekday (`partitionReorderVendors`);
      vendors with no `order_schedule` row (`scheduleKnown === false`) surface in a secondary
      "no schedule" group, not silently dropped.
- [ ] **KPI cards:** the screen shows the KPI strip (vendor count, item count, est. total,
      EOD-sourced vs. stock-fallback vendor counts) computed CLIENT-SIDE from the filtered
      primary set via `computeReorderKpis` (so the strip, the on-screen list, and the export
      all agree — same invariant the admin enforces).
- [ ] **Empty / warning / loading / error states:** mobile-appropriate equivalents of the
      admin's "no suggestions" vs. "nothing to order for this day" distinction, the
      `_warnings` (schedule-unknown) surface, an initial-load state, and a retry-able error pane.

**Cross-platform export/share (web AND native — the highest-complexity AC):**
- [ ] On **web**, an export affordance downloads the list (a file download, mirroring the
      admin's `triggerDownload` blob+anchor pattern), reflecting the on-screen FILTERED +
      as-of view (derived payload = primary vendors + client-recomputed KPIs).
- [ ] On **native (Expo / iOS + Android)**, an export/share affordance opens the OS share
      sheet via `expo-sharing` (writing a temp file via `expo-file-system` first), so the
      manager can send the list to the vendor (email / messages / etc.).
- [ ] The export contents match the on-screen data (same filtered primary set, same
      cases-aware Suggested formatting, same server-rounded costs — no FE cost re-derivation).
- [ ] Export is hidden / disabled when there is nothing meaningful to export (filtered list
      empty, or error, or initial load) — mirror the admin's `showExport` gate.

**Navigation / entry point:**
- [ ] The manager can reach the Reorder screen from within the staff app once an active store
      is selected (exact entry-point mechanism — tab bar vs. button vs. menu — is an architect/UX
      decision; see open question (E)). EOD count remains reachable; Reorder does not replace it.

## In scope
- A new staff Reorder screen under `src/screens/staff/screens/`, themed via `useStaffColors()`,
  mobile-first, for the active store.
- A staff-subtree data fetch (carve-out) calling `report_reorder_list` with `as_of_date`, plus
  the `order_schedule` read needed for the active-days highlight + order-out partition.
- Full parity: per-vendor list, by-the-case display (088), calendar look-back + order-out
  filter (087), KPI cards.
- Cross-platform export/share (web download + native share sheet).
- A staff-themed date picker (adapt `ReorderDatePicker` or build staff-native — see (A)/(D)).
- Wiring the screen into `StaffStack` + an entry point.
- Reuse of the pure `reorderDayFilter.ts` util (directly importable).
- Tests: jest for the staff screen + the staff fetch + any shared/extracted formatter util;
  e2e (Track 4) for the staff Reorder happy path if feasible (precedent exists — see Dependencies).

## Out of scope (explicitly)
- **PO write-path / "mark ordered" / "Create PO".** Explicitly excluded per the user's choice —
  ordering happens externally; the admin's "Create PO" is disabled anyway (ReorderSection
  `DisabledCreatePoButton`). The staff page is read-only-for-data + export.
- **Any change to the admin Reorder** (`ReorderSection.tsx` rendering/behavior). If the
  architect chooses to EXTRACT the pure formatters out of `ReorderSection.tsx` into a shared
  util so both surfaces import one copy (see (A)), that refactor must be byte-for-byte
  behavior-preserving for the admin and is the ONLY admin-file touch permitted.
- **The reorder MATH.** `report_reorder_list` is unchanged; the FE re-derives nothing the
  server computes (suggested units, cases, costs all ride the server values).
- **Multi-store-at-once.** One active store at a time (reuse the EOD active-store pattern).
- **A backend change** — unless the architect finds a grant/RLS gap the PM did not (the PM's
  read confirms `report_reorder_list` and `order_schedule` SELECT are both manager-callable).
  If a gap IS found, it becomes an additive migration → flag the migration-drift gate + pgTAP.
- **Realtime.** The staff stack does not use realtime in v1 (per spec 062); the Reorder screen
  fetches on mount / date-change / manual refresh, same as the admin section (which is also not
  realtime-driven for this payload). Not adding a realtime channel here.
- **Dark-mode toggle UI.** The staff theme already follows the OS (spec 070); no toggle is added.
- **`app.json` slug.** Not touched (load-bearing `towson-inventory` value pending user approval).

## Open questions for the architect (the meat — do not pre-decide)

**(A) Reuse strategy for the spec-087/088 pure logic.**
`reorderDayFilter.ts` is directly importable from the staff subtree — confirm reusing it as-is
(vs. duplicating). For the cases-aware formatters (`formatSuggested` / `formatSuggestedPdf`)
and CSV builder (`buildReorderCsv`) that currently live INSIDE the Cmd-themed
`ReorderSection.tsx`: decide between (a) EXTRACT them into a shared pure util (e.g. alongside
`reorderDayFilter.ts`) that BOTH admin and staff import — behavior-preserving for admin — vs.
(b) RE-IMPLEMENT a small staff copy. Goal: minimize duplication of the 087/088 logic while
keeping the staff screen on the staff theme and not importing a Cmd component module.

**(B) Staff-side data fetch (carve-out).**
Design the staff fetch fn calling `report_reorder_list` (with `as_of_date`) + the
`order_schedule` read the 087 calendar/filter needs (active-days + order-out partition).
Confirm shape: a new file under `src/screens/staff/lib/`? Does it map the payload to the
existing `ReorderPayload`/`ReorderVendor`/`ReorderItem` types (which the pure util consumes), or
a staff-local type mirror? RLS for `order_schedule` read is confirmed OK (manager-readable);
note the staff store has no reorder slice today — decide local screen state vs. a new
`useStaffStore` slice.

**(C) Cross-platform export/share — HIGHEST COMPLEXITY, greenfield (no in-repo precedent).**
Design export/share for BOTH native (Expo) and web. Native = `expo-sharing` /
`expo-file-system` share sheet (deps installed but unused anywhere in `src/` today — this is
the first use). Web = download (admin pattern). **Decide which formats ship in v1: CSV / PDF /
plain text.** Flag specifically: **`jsPDF` is DOM-only** (`document` / blob / `doc.save()`),
so PDF-on-native is awkward — either find a native PDF path or scope PDF to web-only and ship
**text + CSV share** as the leaner native v1. This is the one decision that may need to go BACK
to the user (see "Status / phasing" below). The export must reflect the filtered + as-of view
(derived payload = primary + client-recomputed KPIs), same invariant the admin enforces.

**(D) Mobile layout for "full parity."**
The admin Reorder is a desktop table (fixed-width numeric columns, dense mono rows, a column
header strip). Design a mobile-friendly layout for: the calendar control, the KPI cards, the
per-vendor grouping, the per-item rows (item name + on-hand/par/suggested + the cases display),
the secondary "no schedule" collapsible group, and the warnings pane — on a portrait phone.

**(E) Navigation + entry point.**
Where does Reorder live in `StaffStack`, and how does the manager reach it? Today the
signed-in+active-store branch mounts ONLY `EODCount` (no inner navigation). Options: a bottom
tab bar (EOD | Reorder), a button/link on EODCount, or a menu. EOD must stay reachable; Reorder
does not replace it. Decide whether this introduces the staff app's first multi-destination
navigation and how the render-branch state machine in `StaffStack.tsx` changes.

**(F) Active-store scoping.**
Confirm reuse of the EOD active-store + `StorePicker` pattern: the manager must have an active
store selected before Reorder loads (mirror EOD's store-gate). Decide whether Reorder shares
the SAME active store as EOD (likely yes — one selection) or has its own.

## Feature SIZE + phasing recommendation

**This is a LARGE feature** — the single biggest line item is **(C) cross-platform export/share**,
which is greenfield (no in-repo use of `expo-sharing`/`expo-file-system`), spans web + 2 native
platforms, and the admin's PDF path (`jsPDF`) does not port cleanly to native. The rest
(parity list + calendar + cases + KPIs + a staff date picker + new staff navigation) is
substantial but lower-risk because the pure logic (`reorderDayFilter.ts`) and the backend
(`report_reorder_list` with case fields + `as_of_date`) already exist.

**Recommended phasing (architect/user to weigh):** the user asked for full parity, so the
DEFAULT is one shippable spec. But if the team wants to de-risk, a natural seam is:
- **Phase 1:** staff Reorder screen for the active store with the per-vendor list + by-the-case
  display (088) + KPI cards + export/share in the LEANEST cross-platform format set (text + CSV
  share on native, download on web). This delivers the core "manager sends the list to the
  vendor" outcome.
- **Phase 2:** the calendar look-back + order-out filter (087) and/or PDF-on-native, if PDF
  turns out to be awkward on Expo.

I am NOT splitting the spec by default (full parity was requested). The architect should either
(a) accept full parity in one design, or (b) recommend the phase seam above if (C)'s native-PDF
risk is high enough — and surface that to the user.

## Open questions resolved
- Q: Is the staff Reorder page read-only, or does it write POs / "mark ordered"? →
  A: Read-only for the data + an export/share affordance (CSV / PDF / text) to send to the
  vendor. No PO write-path / no "mark ordered" (ordering is external; admin "Create PO" is
  disabled anyway).
- Q: How much parity with the admin Reorder? → A: Full parity — calendar look-back (087) +
  by-the-case display (088) + KPI cards + exports — adapted to the staff app's mobile-first
  (now OS-light/dark) surface.
- Q: What store scope? → A: The manager's currently-selected store (one at a time), reusing the
  existing EOD active-store / StorePicker pattern.
- Q: Which app? → A: The staff app (`src/screens/staff/`), NOT the admin Cmd UI and NOT the
  customer PWA.

## Dependencies
- `report_reorder_list` RPC — already manager-callable + returns spec-088 case fields + supports
  `as_of_date`. No change expected.
- `order_schedule` SELECT RLS (`auth_can_see_store`) — already manager-readable. No change expected.
- `src/utils/reorderDayFilter.ts` — pure util, directly importable from staff.
- Pure formatters currently inside `ReorderSection.tsx` — extract-vs-reimplement decision (A).
- `expo-sharing` (~14.0.8) + `expo-file-system` (~19.0.21) — already deps; first use in `src/`.
- `papaparse` / `jspdf` / `jspdf-autotable` — already deps (PDF is DOM-only; see (C)).
- Staff subtree: `useStaffStore`, `useStaffColors()`/theme, `src/screens/staff/i18n/`, the
  staff `notifyBackendError`, `StaffStack`, the `confirmAction` cross-platform helper.
- e2e precedent (Track 4): `e2e/eod.spec.ts` (staff happy-path e2e) + `e2e/reorder.spec.ts`
  (admin reorder e2e) + the `e2e/.auth/staff.json` auth fixture all exist — a staff Reorder e2e
  is feasible.

## Project-specific notes
- **Cmd UI section / staff / legacy:** STAFF subtree (`src/screens/staff/`). Not a Cmd UI
  section; not legacy. Touches the admin `ReorderSection.tsx` ONLY if the architect chooses the
  shared-extraction path (A), and then only behavior-preservingly.
- **Per-store or admin-global:** Per-store, scoped to the manager's `activeStore`; respects the
  per-store RLS hardening (`auth_can_see_store`) — verified manager-callable.
- **Realtime channels touched:** NONE (staff stack is not realtime in v1; this payload is
  fetch-on-demand on both surfaces).
- **Migrations needed:** NO (expected). Both `report_reorder_list` and `order_schedule` SELECT
  are already manager-accessible and the RPC already returns the case fields + honors
  `as_of_date`. IF the architect finds an unanticipated grant/RLS gap → additive migration →
  flag the `db-migrations-applied` drift gate + add pgTAP (DB test track).
- **Edge functions touched:** NONE.
- **Web/native scope:** BOTH. The data + list + calendar + KPIs are cross-platform RN. The
  export/share is the cross-platform crux (web download + native share sheet) — see (C). PDF on
  native is the specific risk.
- **Tests:** jest (staff screen + staff fetch + extracted/shared formatter util if (A)→extract);
  e2e Track 4 (staff Reorder happy path) if feasible. pgTAP ONLY if a backend change is
  introduced.

---

## Backend design (architect)

Despite the agent name, **this design confirms NO backend change** and is a
frontend (staff-subtree) contract. I verified the PM's read against the actual
migrations and confirm it. The "backend" deliverable here is: (1) a verdict that
the data path is open, (2) a small **shared pure-util extraction** out of the
Cmd-themed admin component (the only admin-file touch), and (3) the staff-subtree
data + export contract. The frontend-developer owns all implementation.

### 0. Verdicts on the PM's verified facts (confirm / refute)

| Claim | Verdict | Evidence |
|---|---|---|
| `report_reorder_list` is manager-callable (`grant … to authenticated`, gates on `auth_can_see_store(p_store_id)` only) | **CONFIRMED** | [supabase/migrations/20260514130000_report_reorder_list.sql:119](../../supabase/migrations/20260514130000_report_reorder_list.sql) gate; lines 603-606 grants. Re-asserted in the spec-088 migration [supabase/migrations/20260602000000_reorder_suggested_cases.sql:83](../../supabase/migrations/20260602000000_reorder_suggested_cases.sql). |
| RPC returns spec-088 case fields (`case_qty`/`suggested_cases`/`suggested_units`) | **CONFIRMED** | 20260602000000 lines 391, 437-441, 496-499. `mapReorderVendor` ([src/lib/db.ts:2768](../../src/lib/db.ts)) already reads them into `ReorderItem`. |
| RPC honors `as_of_date` (spec 087) | **CONFIRMED** | 20260514130000 lines 128-131. Omitting → `current_date`. |
| `order_schedule` SELECT is `using (auth_can_see_store(store_id))` (manager-readable) and the staff EOD screen already reads it | **CONFIRMED** | `fetchVendorsForToday` ([src/screens/staff/screens/EODCount.tsx:82-112](../../src/screens/staff/screens/EODCount.tsx)) reads `order_schedule` directly today. |
| `src/utils/reorderDayFilter.ts` is pure (no RN/store/supabase) → importable from staff | **CONFIRMED** | Imports only `./enumLabels` (types) + `../types` (types). Zero runtime framework deps. |
| `expo-sharing` (~14) + `expo-file-system` (~19) are deps but unused in `src/` | **CONFIRMED** | [package.json:43,47](../../package.json); no imports found anywhere in `src/`. |
| Admin export is web-only (`triggerDownload` DOM, `jsPDF.save()` DOM) | **CONFIRMED** | ReorderSection.tsx lines 416-427, 593; gated `Platform.OS === 'web'` line 693. |
| **`expo-print` is NOT a dependency** | **NEW FINDING** | Not in [package.json](../../package.json). This is the crux of decision (C) — native PDF would require ADDING a dependency. See (C). |

**No migration. No RLS change. No grant change. No edge-function change. No
realtime change. No pgTAP.** The data path is fully open to a manager (role
`user`) with a `user_stores` grant. If implementation uncovers a gap, STOP and
re-escalate — an additive migration would re-engage the `db-migrations-applied`
drift gate + pgTAP, which this spec is explicitly NOT scoped for.

---

### (A) Reuse strategy — EXTRACT the formatters into the existing pure util

**Decision: EXTRACT.** Move the three pure helpers `formatSuggested`,
`formatSuggestedPdf`, `buildReorderCsv` (and their private dependencies
`formatQty`, `formatMoney`, `slugifyStore`, `todayLocalIso`) OUT of the
Cmd-themed `ReorderSection.tsx` and INTO a new pure util that BOTH surfaces
import. `reorderDayFilter.ts` is imported directly from staff as-is (no copy).

**Where:** new file `src/utils/reorderExport.ts` (sibling to `reorderDayFilter.ts`).
Rationale for a *new* file rather than appending to `reorderDayFilter.ts`:
`reorderDayFilter.ts` is the *day-filter / KPI* concern (spec 087); export
formatting + CSV building is a distinct concern (spec 025/088). Keeping them
separate mirrors the existing one-concern-per-util convention (`reportDates.ts`,
`enumLabels.ts`) and keeps each jest file focused.

**Why extract over re-implement:**
- The spec-088 cases·units logic (`N cases · M unit`, singular `1 case`, the `cs`
  PDF abbreviation, the CSV `Cases`/`Units Per Case` columns) is **byte-for-byte
  load-bearing** — AC requires the staff Suggested string to "byte-for-byte match
  the admin `formatSuggested` output" and the export to carry identical
  cases-aware formatting. A re-implementation is a guaranteed drift surface the
  moment spec 088's rounding rule or column set changes. One copy = one source of
  truth, enforced by the type system.
- `reorderExport.ts` will be framework-free (it already is — `Papa.unparse`,
  string math, no React/theme), so the staff screen imports it **without pulling
  in the Cmd theme**. This satisfies the spec's "do not import a Cmd component
  module" constraint while still being DRY.

**The functions stay byte-for-byte behavior-preserving for the admin.**
`ReorderSection.tsx` changes ONLY its import lines: it deletes the local
definitions of those seven helpers and imports them from `../../../utils/reorderExport`.
The `handleCsvExport` / `handlePdfExport` / `triggerDownload` orchestrators (which
ARE DOM-coupled and admin-web-only) **stay in `ReorderSection.tsx`** — they are
not pure and the staff surface needs a *different* (cross-platform) orchestration
(see (C)). Only the pure builders move.

**Exact extraction manifest for `src/utils/reorderExport.ts` (all pure):**
```ts
export function formatQty(n: number): string                 // mono qty, ≤2dp, trailing-zero trim
export function formatMoney(n: number): string               // `$${...toFixed(2)}`
export function slugifyStore(name: string): string           // filename-safe slug
export function todayLocalIso(): string                      // YYYY-MM-DD local
export function formatSuggested(item: ReorderItem): string   // `N cases · M unit` (spec 088)
export function formatSuggestedPdf(item: ReorderItem): string// `N cs · M unit` (spec 088 PDF)
export function buildReorderCsv(payload: ReorderPayload): string // PapaParse, fixed columns
// NEW (this spec) — shared plain-text builder, see (C):
export function buildReorderText(payload: ReorderPayload, storeName: string): string
```
`ReorderSection.tsx` re-imports `formatSuggested`/`formatSuggestedPdf`/`formatQty`/
`formatMoney` (used in `VendorCard`/`BreakdownLine`/PDF) and `buildReorderCsv`/
`slugifyStore`/`todayLocalIso` (used in its web export orchestrators).

**Regression risk + mitigation:** This touches the admin `ReorderSection.tsx`
(the one permitted admin touch per the spec's "Out of scope"). The admin's
existing reorder jest (which imports `formatSuggested`/`formatSuggestedPdf`/
`buildReorderCsv` "for jest" — see the `export` comments at ReorderSection.tsx
lines 61, 72, 432) **must stay green**. Mitigation: those jest tests must be
re-pointed to import from `src/utils/reorderExport.ts` (or a thin re-export kept
on `ReorderSection.tsx` for back-compat). The frontend-developer must run the
admin reorder jest after the extraction and confirm zero behavioral diff. The
test-engineer will verify the byte-for-byte invariant in review.

---

### (B) Staff-side data fetch (carve-out) + state

**New file: `src/screens/staff/lib/fetchReorder.ts`** (staff db carve-out —
direct `supabase.*` is sanctioned for the `src/screens/staff/` subtree per
CLAUDE.md "DB access centralized"). Two exports:

```ts
// 1. The reorder RPC — mirrors db.ts:fetchReorderSuggestions's mapping EXACTLY,
//    but staff-local (does NOT use useInflight.track() — that's an admin-store
//    construct; staff uses plain await + AbortController-free fetch like
//    fetchVendorsForToday). Returns the SHARED ReorderPayload type.
export async function fetchStaffReorder(
  storeId: string,
  asOfDate: string,            // always passed (store-local today or picked date)
): Promise<ReorderPayload>

// 2. The order_schedule read — returns the SHARED OrderSchedule slice shape
//    ({ [day]: OrderDayVendor[] }) that activeWeekdaysFromSchedule +
//    partitionReorderVendors consume. Mirrors the admin's order_schedule
//    hydration shape, not EODCount's per-day fetchVendorsForToday (we need ALL
//    weekdays for the calendar highlight, not just today's).
export async function fetchStaffOrderSchedule(
  storeId: string,
): Promise<OrderSchedule>
```

**Type reuse — use the SHARED types, not a staff mirror.** `fetchStaffReorder`
returns the existing `ReorderPayload` / `ReorderVendor` / `ReorderItem` from
`src/types/index.ts`, and `fetchStaffOrderSchedule` returns the existing
`OrderSchedule` / `OrderDayVendor`. Rationale: `reorderDayFilter.ts` and
`reorderExport.ts` are typed against exactly those shapes; a staff-local mirror
would force a parallel type that drifts. The staff subtree already imports shared
non-staff modules (`confirmAction`, `supabase`), so importing shared *types* is
consistent. (Contrast: the staff `EodItem`/`Vendor` mirrors in
`src/screens/staff/lib/types.ts` exist because those are EOD-queue-specific
shapes with no admin equivalent; `ReorderPayload` has a perfect admin equivalent.)

**Mapping:** `fetchStaffReorder` copies `mapReorderVendor` ([src/lib/db.ts:2750-2772](../../src/lib/db.ts))
verbatim into the staff lib (it's ~25 lines, already snake_case→camelCase, and
duplicating a flat mapper is lower-risk than coupling the staff lib to the admin
`db.ts` module — same isolation rationale the EOD fetch helpers follow). The
`order_schedule` read maps `day_of_week` (capitalized `DayName` per the column) →
`{ [day]: [{ vendorId, vendorName, deliveryDay }] }`. Error handling: throw on
PostgREST error; the SCREEN catches and routes to `notifyStaffBackendError` +
a retry-able error pane (mirrors EODCount's `fetchVendorsForToday` catch).

**The 42501 (forbidden) path:** a store the manager is NOT granted yields a
PostgREST RLS error (`auth_can_see_store` false). The screen surfaces this as the
non-crashing error pane (AC: "not a silent blank"). In practice the StorePicker
only lists granted stores, so this is a defense-in-depth path; the screen must
still render the error pane rather than an empty list.

**State location — SCREEN-LOCAL, not a `useStaffStore` slice.** Decision:
`useState` inside the new `Reorder` screen (payload, orderSchedule, loading,
error, selectedDate), mirroring EODCount's all-`useState` pattern. Rationale:
- The staff store is deliberately minimal (auth + active-store + offline-queue
  ONLY — it has no data-cache slices at all). The reorder payload is **fetch-on-
  demand, single-screen, non-shared, non-persisted** (no offline queue, no
  cross-screen read). Adding a store slice would be the first data-cache slice in
  `useStaffStore` for no benefit.
- The admin caches reorder in `useStore` ONLY because the realtime sync + the
  desktop multi-section shell re-read it; the staff stack has neither (no realtime
  per spec 062; single screen). EODCount already proves the screen-local pattern
  for store-scoped fetched data.

**Fetch orchestration (mirror ReorderSection's store-switch-aware effect,
adapted):** one effect keyed on `[activeStore?.id, selectedDate]`. On active-store
change, reset `selectedDate` to today and fetch as-of-today directly (avoid the
stale-as-of-on-switch bug ReorderSection.tsx:639-651 fixes). `fetchStaffOrderSchedule`
runs alongside `fetchStaffReorder` (Promise.all) so the calendar highlight + the
partition have the schedule. A manual Refresh re-runs both for `selectedDate`.

---

### (C) Cross-platform export/share — **DECISION + ESCALATION**

This is the highest-risk decision and the one that may need the user. Here is my
recommendation AND the crisp escalation.

**The constraint:** `jsPDF` is DOM-only (`document`, `Blob`, `doc.save()`). It
cannot run under React Native (native). `expo-print` (HTML→PDF on native) is
**NOT a dependency** — adding it is a user-facing native-dependency decision
(new native module, EAS rebuild, app-size + maintenance cost).

**My recommendation (RECOMMENDED v1): CSV + plain-text share, cross-platform;
NO PDF in the staff v1.**

| Format | Web | Native | v1? |
|---|---|---|---|
| CSV | `triggerDownload` blob+anchor (admin pattern) | `expo-file-system` write temp `.csv` → `expo-sharing` share sheet | **YES** |
| Plain text | download `.txt` (or share-sheet) | write temp `.txt` → share sheet | **YES** |
| PDF | `jsPDF.save()` (admin pattern works on web) | **NOT in v1** — needs `expo-print` (new dep) | **NO (escalate)** |

Why this is the right v1:
- It delivers the core outcome — "manager sends the list to the vendor" — on
  **both** native and web with **zero new dependencies** (`expo-sharing` +
  `expo-file-system` are already installed; `papaparse` is already installed).
- CSV is the vendor-friendliest format (spreadsheet-summable; the admin's primary
  export). Plain text is the share-sheet-friendliest (drops straight into an
  email/SMS body to a vendor) — and it's the format that most justifies the
  native share sheet existing at all.
- PDF-on-native is the ONE thing that forces a new native dependency. Shipping
  CSV+text now and treating PDF as a fast-follow keeps this spec dependency-clean.

**Proposed export module: `src/screens/staff/lib/shareReorder.ts`** (staff-local;
platform-branched). It imports the **pure** `buildReorderCsv` + the new
`buildReorderText` from `src/utils/reorderExport.ts` (shared), then branches on
`Platform.OS`:

```ts
// Pure content builders live in src/utils/reorderExport.ts (shared, jest-covered).
// This module is the IMPURE platform-branched I/O orchestrator (staff-local).
export async function shareReorderCsv(payload: ReorderPayload, storeName: string): Promise<void>
export async function shareReorderText(payload: ReorderPayload, storeName: string): Promise<void>

// internal:
//   web    → new Blob([content]) + anchor download (same shape as admin triggerDownload)
//   native → FileSystem.writeAsStringAsync(`${cacheDirectory}${filename}`, content)
//            then Sharing.isAvailableAsync() → Sharing.shareAsync(uri, { mimeType, dialogTitle })
// Both wrap in try/catch → success/failure Toast (staff bottom-position toasts).
// Native availability: if Sharing.isAvailableAsync() is false, Toast an error
// (some platforms/web-in-Expo-Go lack the share sheet) — do not crash.
```
`expo-file-system` v19 API note for the developer: write to
`FileSystem.cacheDirectory` (ephemeral, no permission prompt) — NOT
`documentDirectory`. Use `EncodingType.UTF8`. Filename:
`IMR_Reorder_${slugifyStore(storeName)}_${asOfDate}.csv|txt` (reuse the shared
`slugifyStore`).

**The export MUST reflect the on-screen FILTERED + as-of view** — identical
invariant to the admin (ReorderSection.tsx:683-686). Build a derived payload
`{ ...payload, vendors: primary, kpis: computeReorderKpis(primary) }` and pass
THAT to the share builders, so the CSV/text rows + footer match the cards. The
`showExport` gate mirrors the admin: enabled iff `primary.length > 0 && !error &&
!(loading && !payload)`. (Drop the admin's `Platform.OS === 'web'` clause — the
staff export is cross-platform.)

> ### ESCALATION FOR THE USER (decision (C)) — answer BEFORE the build starts
>
> The user asked for **full parity**, and the admin Reorder exports **PDF**. But
> native PDF (`jsPDF` is DOM-only) requires **adding `expo-print` as a new native
> dependency** (EAS rebuild + app-size + maintenance). The architect recommends
> shipping **CSV + plain-text share cross-platform with zero new deps** and
> treating PDF as a fast-follow. **Three options for the user:**
>
> 1. **RECOMMENDED — CSV + text, cross-platform, no new dep.** Full parity on the
>    *list/calendar/cases/KPIs*; export parity is CSV+text everywhere, PDF deferred.
> 2. **PDF-everywhere via `expo-print` (new dep).** Adds `expo-print`; staff PDF
>    renders HTML→PDF on native and shares it; web keeps `jsPDF`. Full export
>    parity, but a new native dependency + EAS rebuild + a second PDF code path
>    (HTML template) to maintain.
> 3. **Web-only PDF (asymmetric).** Staff PDF button shows on web only (reuse the
>    admin `jsPDF` path); native gets CSV+text only. Cheapest-to-PDF but a
>    platform-asymmetric UX (PDF appears/disappears by platform) — I do **not**
>    recommend this; it's the most confusing for a manager who switches devices.
>
> **The build can proceed on Option 1 immediately** (it's the lean, dependency-
> clean default and satisfies every AC except literal PDF-on-native). If the user
> wants Option 2, the frontend-developer adds `expo-print` + an HTML-template PDF
> builder for native. Main Claude should surface this to the user; absent a
> response, **build Option 1.**

---

### (D) Mobile layout for full parity (staff theme, portrait phone)

The admin is a dense desktop table (fixed-width numeric columns). The staff
surface must reflow to a single-column phone layout using `useStaffColors()` +
the staff `spacing`/`radius`/`typography` tokens (NO `useCmdColors`, NO `mono`
font — staff uses its system sans tokens). Structure top-to-bottom inside a
`SafeAreaView` (`edges={['top','bottom']}`, matching EODCount/StorePicker):

- **Header bar** (`c.surface`): store name + the date-picker trigger + a Refresh
  affordance. Mirror EODCount's header (store name tappable to switch store is
  OPTIONAL here — keep it consistent; see (E)/(F)).
- **KPI strip:** the 4 admin StatCards (Vendors / Items / Est. total /
  On-hand-source) reflow to a 2×2 grid of staff-themed cards (soft `c.surface`
  cards with `useStaffElevation().card`), values from `computeReorderKpis(primary)`.
  A horizontal scroll row is the fallback if 2×2 is too tight on a small phone.
- **Warnings pane** (when `payload.warnings.length > 0`): `c.warningBg` / `c.warning`
  banner, mirroring EODCount's `Banner tone="error|info"` component shape.
- **Per-vendor cards (primary set):** one soft card per vendor. Card header =
  vendor name + a source badge (EOD / STOCK FALLBACK) + next-delivery line. Each
  item is a STACKED row (NOT a wide table): item name on top; a secondary line
  `on hand · par · → order: {formatSuggested(item)}` (reuse the shared
  `formatSuggested` — byte-for-byte the admin cases·units string); est cost via
  `formatMoney`. This is the mobile analog of `BreakdownLine`, vertical instead of
  horizontal. Flag chips render inline under the name.
- **Secondary "no schedule" group:** a collapsible (default-collapsed) section
  below the primary cards, same `partitionReorderVendors().noSchedule` source +
  the same toggle affordance pattern as ReorderSection.tsx:976-1010, restyled.
- **Empty/loading/error states:** the staff analogs of the admin's distinct
  "NO REORDER SUGGESTIONS" (payload empty) vs. "NOTHING TO ORDER" (day-filtered
  empty) vs. initial-load vs. retry-able error pane (AC requires all four).

**Date picker — build STAFF-NATIVE, do not adapt the Cmd one.** Decision: new
`src/screens/staff/components/ReorderDatePicker.tsx`, a structural port of
`src/components/cmd/ReorderDatePicker.tsx` but themed via `useStaffColors()` and
sized for touch (≥44pt cells per the staff `touchTarget.min`). Rationale: the Cmd
picker is hard-wired to `useCmdColors()` + `mono()` throughout (every cell, every
glyph) — "adapting" it means threading a theme prop through the whole component,
which is messier than a focused staff copy. It imports the **shared**
`weekdayName` from `reorderDayFilter.ts` (the locale-invariant parser — do NOT
re-implement; trap #1/#2 in that file are load-bearing) and takes the same props
(`value`, `onChange`, `maxDate`, `activeWeekdays`). The active-day highlight uses
`activeWeekdaysFromSchedule(orderSchedule)`.

---

### (E) Navigation + entry point — introduce a bottom tab bar in `StaffStack`

**Decision: a bottom tab bar (EOD | Reorder) for the signed-in+active-store
branch.** `@react-navigation/bottom-tabs` is already a dependency
([package.json:35](../../package.json)). This is the staff app's first
multi-destination navigation.

**How `StaffStack.tsx` changes (the render-branch state machine):** the
`else if (activeStore)` branch currently mounts a single-screen
`<Stack.Navigator>` with `EODCount`. Replace that branch's body with a
`<Tab.Navigator>` (staff-themed `tabBar`, `headerShown: false`, `c.bg` scene) that
mounts two tabs: `EODCount` (unchanged) and `Reorder` (the new screen). The
`Splash` and `StorePicker` branches are **untouched**. So:

```
authState transient → Splash                 (unchanged)
signed-in + activeStore → Tab.Navigator{ EOD, Reorder }   (CHANGED: was single EODCount screen)
signed-in + no activeStore → StorePicker      (unchanged)
```

**Why a tab bar over a header button/menu:**
- Two co-equal destinations (count vs. reorder) map cleanly to two tabs; a manager
  switches between "I'm counting" and "I'm ordering" as distinct modes.
- It keeps EOD reachable at all times (AC: "EOD must stay reachable; Reorder does
  not replace it") with zero extra taps, vs. a button that buries one mode.
- It's the idiomatic RN pattern and the dep is already present.

**Tab-bar theming:** the `tabBar` must use `useStaffColors()` (active =
`c.primary`, inactive = `c.textSecondary`, bar bg = `c.surface`, top border
`c.border`) so it matches the OS-light/dark staff theme — a default RN tab bar
would flash white in dark mode (same concern the `cardStyle` comment at
StaffStack.tsx:63-72 documents). Use `@expo/vector-icons` (already a dep) for the
two tab icons. Tap targets ≥44pt.

**Risk — the sign-out / switch-store affordances live in EODCount's header.**
Today EODCount owns sign-out + switch-store. With a tab bar, the Reorder tab needs
those too (a manager on the Reorder tab must be able to sign out / switch store).
Decision: the Reorder screen gets its OWN header (store name + sign-out, mirroring
EODCount's header) — do NOT lift sign-out into the tab bar (keeps the change
localized; both screens already need a header for the store name + date context).
The switch-store affordance (tap the store name → `setActiveStore(null)`) is
preserved on both. The frontend-developer should factor the shared header shape if
trivial, but duplicating it per-screen is acceptable (EODCount's header is ~40
lines of inline JSX; a shared `StaffScreenHeader` component is a nice-to-have, not
required).

---

### (F) Active-store scoping — share the EOD active store; gate identically

**Decision: Reorder shares the SAME `useStaffStore.activeStore` as EOD (one
selection, not a separate one).** The StorePicker gate is upstream of the tab bar
(the tab bar only mounts in the `signed-in + activeStore` branch), so BOTH tabs
are guaranteed an active store — there is no "pick a store for Reorder
separately" state. This mirrors the admin (one `currentStore` drives every
section) and the AC ("reuse the existing EOD active-store pattern").

- The Reorder screen reads `useStaffStore((s) => s.activeStore)` and re-fetches on
  store switch (the effect keyed on `activeStore.id` — same as EODCount's
  `useEffect(..., [activeStore])`).
- Switching stores (tap store name → `setActiveStore(null)`) drops BOTH tabs back
  to the StorePicker branch (the whole tab navigator unmounts when `activeStore`
  becomes null) — consistent, no per-tab store drift.
- Defensive `if (!activeStore)` guard at the top of the Reorder screen (after all
  hooks, to keep hook-count stable across renders — same discipline as
  ReorderSection.tsx:709-724 and EODCount.tsx:433).

---

### New / changed files (exact manifest)

**New (frontend-developer):**
- `src/utils/reorderExport.ts` — pure, shared. The extracted formatters +
  `buildReorderCsv` + NEW `buildReorderText`. (A)
- `src/screens/staff/screens/Reorder.tsx` — the staff Reorder screen. (B)(D)(F)
- `src/screens/staff/components/ReorderDatePicker.tsx` — staff-themed calendar. (D)
- `src/screens/staff/lib/fetchReorder.ts` — `fetchStaffReorder` +
  `fetchStaffOrderSchedule` (carve-out). (B)
- `src/screens/staff/lib/shareReorder.ts` — platform-branched CSV/text share. (C)
- (Optional) `src/screens/staff/components/StaffScreenHeader.tsx` — shared header
  if the developer factors EODCount's header. Nice-to-have. (E)

**Changed (frontend-developer):**
- `src/screens/cmd/sections/ReorderSection.tsx` — **import-only change**: delete
  the seven local pure-helper definitions, import them from
  `../../../utils/reorderExport`. Behavior byte-for-byte preserved. The ONLY
  permitted admin touch. (A)
- `src/screens/staff/navigation/StaffStack.tsx` — the `activeStore` branch becomes
  a `Tab.Navigator{ EOD, Reorder }`. (E)
- `src/screens/staff/i18n/en.json` — new `reorder.*` keys (title, KPI labels,
  empty/nothing-to-order/error/retry copy, no-schedule group title/hint, export
  button labels + success/failure toast copy, tab labels). Mirror the admin's
  `section.reorder.*` keys' meanings, staff-worded.
- The admin reorder jest test file — re-point its imports of
  `formatSuggested`/`formatSuggestedPdf`/`buildReorderCsv` from `ReorderSection`
  to `src/utils/reorderExport` (so admin coverage stays green after extraction).

**No changes to:** `useStaffStore.ts` (no new slice — (B)), any migration, any
RLS, any edge function, `config.toml`, `useRealtimeSync.ts`, `src/lib/db.ts`
(admin reorder fetch unchanged), `app.json`.

---

### API contract (no new endpoints)

- **`report_reorder_list` (RPC, existing):** request `{ p_store_id: activeStore.id,
  p_params: { as_of_date: 'YYYY-MM-DD' } }`. Response = the spec-021/087/088
  envelope (vendors[] with case fields, kpis, `_warnings`, `as_of_date`). Errors:
  RLS 42501 if the store isn't granted → screen error pane. Mapping = verbatim
  copy of `mapReorderVendor` ([src/lib/db.ts:2750](../../src/lib/db.ts)) into the
  staff lib.
- **`order_schedule` (PostgREST table SELECT, existing):**
  `.from('order_schedule').select('day_of_week, vendor_id, vendor_name').eq('store_id', storeId)`.
  Response mapped to `OrderSchedule` (`{ [DayName]: OrderDayVendor[] }`). RLS
  `auth_can_see_store(store_id)` — manager-readable, confirmed.

### `src/lib/db.ts` surface

**No change.** The staff fetch lives in the staff carve-out
(`src/screens/staff/lib/fetchReorder.ts`), NOT `db.ts`. This is consistent with
the documented staff-subtree carve-out (CLAUDE.md "DB access centralized" — the
entire `src/screens/staff/` subtree may call `supabase.*` directly). snake_case→
camelCase mapping happens locally in `fetchReorder.ts` (copying `mapReorderVendor`'s
shape), mirroring how `EODCount.tsx`'s helpers already map their reads.

### Realtime impact

**NONE.** The staff stack is not realtime (spec 062). The Reorder payload is
fetch-on-mount / date-change / manual-refresh — identical to the admin
ReorderSection, which is also not realtime-driven for this payload. No
`supabase_realtime` publication change → **the publication-restart gotcha does
NOT apply to this spec.** (Flagging explicitly per the architect checklist: there
is no `docker restart supabase_realtime_imr-inventory` step here.)

### Frontend store impact

**NONE to `src/store/useStore.ts`** (that's the admin store; untouched). **NONE
to `useStaffStore.ts`** — the reorder payload is screen-local `useState`, not a
new slice (decision (B)). The optimistic-then-revert + `notifyBackendError`
pattern **does not apply** — this is read-only data fetch (no mutation, no
optimistic write). Errors surface via `notifyStaffBackendError` + a retry-able
error pane, mirroring EODCount's read-fetch error handling.

---

### Phasing recommendation

**Ship full parity in ONE spec** (the user asked for full parity), with decision
(C) drawing the *only* phase line: **CSV + text export ships now (Option 1);
PDF-on-native is the explicit fast-follow** if the user picks Option 1. So:

- **This spec (one PR):** staff Reorder screen + per-vendor list + by-the-case
  display (088) + calendar look-back + order-out filter (087) + KPI cards +
  tab-bar navigation + **CSV + plain-text cross-platform export/share** + the
  shared-util extraction.
- **Deferred (only if user picks Option 1 on (C)):** PDF-on-native via
  `expo-print`. NOT a separate spec unless the user wants Option 2 up front.

I am NOT splitting the list/calendar/cases/KPIs into phases — the pure logic
(`reorderDayFilter.ts`) and the backend already exist, so that work is low-risk
and lands together. The ONLY genuinely de-riskable item is native PDF, which the
(C) escalation already isolates.

---

### Test contract

- **jest (`src/utils/reorderExport.ts`):** the moved `formatSuggested` /
  `formatSuggestedPdf` / `buildReorderCsv` keep their existing coverage (re-point
  the admin test imports here). NEW: `buildReorderText` (cases·units lines, footer
  totals, filtered-payload input). This is the byte-for-byte spec-088 guard.
- **jest (admin `ReorderSection`):** the existing admin reorder jest MUST stay
  green post-extraction — this is the regression gate for the one admin touch.
- **jest (`fetchReorder.ts`):** mock `supabase.rpc`/`.from` → assert the
  `mapReorderVendor`-shape mapping (case fields preserved) and the `OrderSchedule`
  mapping; assert RLS-error throw is propagated (the screen renders the error pane).
- **jest (`Reorder.tsx` screen):** render with a mocked payload + schedule →
  assert KPI strip uses `computeReorderKpis(primary)`, the primary/no-schedule
  partition renders, the four states (loading / empty / nothing-to-order / error)
  render, and `showExport` gates on `primary.length`. Mirror the existing
  EODCount/StorePicker staff screen-test pattern (jest-expo, light palette via the
  `useColorScheme()→null→light` default in `theme.ts`).
- **jest (`shareReorder.ts`):** mock `Platform.OS` + `expo-file-system` +
  `expo-sharing` → assert native path writes a temp file + calls `shareAsync`, web
  path builds a blob; both wrap errors → toast (no throw). Mock the
  `Sharing.isAvailableAsync()===false` branch → error toast, no crash.
- **e2e (Track 4, web — feasible):** new `e2e/staff-reorder.spec.ts` using the
  existing `e2e/.auth/staff.json` fixture (precedent: `e2e/eod.spec.ts`). Sign in
  as staff → land on the tab bar → tap the Reorder tab → assert the reorder list
  renders for the active store → exercise Refresh round-trip + the date picker.
  Follow `e2e/reorder.spec.ts`'s DEFENSIVE export-gate pattern (assert export
  controls only WHEN the payload is non-empty; do NOT assert a file download — the
  admin e2e explicitly excludes download assertions as a flake surface). The
  developer must add stable testIDs: `staff-reorder-root`, `staff-reorder-refresh`,
  `staff-reorder-export-csv`, `staff-reorder-export-text`, `staff-tab-eod`,
  `staff-tab-reorder`.
- **pgTAP:** NONE (no backend change).

---

## Handoff
next_agent: frontend-developer
prompt: Implement spec 089 against the "## Backend design (architect)" section.
  This is a staff-subtree (`src/screens/staff/`) feature with ONE permitted admin
  touch — extracting the pure formatters from `ReorderSection.tsx` into a new
  shared `src/utils/reorderExport.ts` (decision (A); admin behavior MUST stay
  byte-for-byte identical and the admin reorder jest MUST stay green). Build the
  staff Reorder screen + staff-themed date picker + staff fetch carve-out
  (`src/screens/staff/lib/fetchReorder.ts`) + cross-platform share
  (`src/screens/staff/lib/shareReorder.ts`) + the bottom-tab-bar wiring in
  `StaffStack.tsx` (decision (E)) + i18n keys. NO backend-developer needed — NO
  migration / RLS / edge / realtime change (verified §0). **READ THE (C)
  ESCALATION FIRST:** native PDF needs a NEW dependency (`expo-print`); the
  architect recommends shipping CSV + plain-text cross-platform with zero new deps
  (Option 1) and deferring PDF. **Main Claude should ask the user to confirm (C)
  Option 1 vs Option 2 (add `expo-print` for PDF-everywhere) BEFORE the build
  proceeds** — absent a response, build Option 1. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/089/spec.md

---

## Files changed (frontend-developer)

**Decision (C) = Option 2 (PDF EVERYWHERE), per the user's resolved choice.** The
export/share offers **CSV + plain-text + PDF on BOTH web AND native**. This added
`expo-print` (`~15.0.8`) as the only new dependency for native HTML→PDF (and web
PDF via its react-native-web `printAsync` shim, replacing jsPDF on the staff
surface). `expo-sharing` + `expo-file-system` (already deps) drive the native
share sheet. The admin `ReorderSection.tsx` PDF path (jsPDF) is UNCHANGED.

**New (frontend):**
- `src/utils/reorderExport.ts` — pure, shared export util. Decision (A): the seven
  formatters (`formatQty` / `formatMoney` / `formatSuggested` / `formatSuggestedPdf`
  / `slugifyStore` / `todayLocalIso` / `buildReorderCsv`) extracted **verbatim** out
  of the Cmd-themed `ReorderSection.tsx`, PLUS two NEW shared builders for the
  cross-platform export: `buildReorderText` (plain text) and `buildReorderPdfHtml`
  (HTML→PDF source, with `escapeHtml` on every interpolated value).
- `src/utils/reorderExport.test.ts` — unit coverage for the moved formatters + the
  new `buildReorderText` / `buildReorderPdfHtml` (byte-for-byte spec-088 guard +
  HTML-escape guard).
- `src/screens/staff/lib/fetchReorder.ts` — staff carve-out. `fetchStaffReorder`
  (RPC, copies `mapReorderVendor` verbatim) + `fetchStaffOrderSchedule` (all-weekday
  `order_schedule` read). Returns the SHARED `ReorderPayload` / `OrderSchedule` types.
- `src/screens/staff/lib/fetchReorder.test.ts` — mapping (case fields preserved) +
  schedule mapping + 42501 propagation.
- `src/screens/staff/lib/shareReorder.ts` — platform-branched CSV/text/PDF
  orchestrator (Option 2). Web = Blob+anchor download / `Print.printAsync`; native =
  `expo-file-system` temp file → `expo-sharing` share sheet / `Print.printToFileAsync`
  → share. All wrapped → staff bottom Toast, never throws.
- `src/screens/staff/lib/shareReorder.test.ts` — native write+share, web download,
  PDF-everywhere, `Sharing.isAvailableAsync()===false` → error toast, error→toast.
- `src/screens/staff/components/ReorderDatePicker.tsx` — staff-themed month-grid
  calendar (Decision (D); NOT the Cmd `ReorderDatePicker` — staff theme + ≥44pt
  cells; imports the shared `weekdayName`).
- `src/screens/staff/screens/Reorder.tsx` — the staff Reorder screen (B)(D)(F):
  per-vendor cards + by-the-case display (088) + calendar look-back + order-out
  filter (087) + KPI 2×2 grid + the four states + cross-platform export menu.
  Screen-local `useState` (no `useStaffStore` slice). Shares the EOD `activeStore`.
- `src/screens/staff/screens/Reorder.test.tsx` — happy path (cases·units string),
  export-gate + derived-payload, the four states, no-schedule group, warnings,
  SafeAreaView root.

**Changed (frontend):**
- `src/screens/cmd/sections/ReorderSection.tsx` — **import-only** (Decision (A)):
  deleted the seven local pure-helper definitions + the `papaparse` import; imports
  them from `../../../utils/reorderExport` and **re-exports**
  `formatSuggested`/`formatSuggestedPdf`/`buildReorderCsv` so the existing admin
  jest (`ReorderSectionCases.test.tsx`) stays green unchanged. The DOM-coupled
  web orchestrators (`triggerDownload`/`handleCsvExport`/`handlePdfExport`) stay.
  Net: −99/+27 lines, behavior byte-for-byte preserved (admin reorder jest: 22/22 green).
- `src/screens/staff/navigation/StaffStack.tsx` — Decision (E): the `activeStore`
  branch now mounts a staff-themed **bottom tab bar** (`Count` | `Reorder`) via
  `@react-navigation/bottom-tabs` + `@expo/vector-icons` (both already deps).
  Splash + StorePicker branches untouched.
- `src/screens/staff/i18n/en.json` — new `reorder.*` + `eodTab.label` keys.
- `src/screens/staff/i18n/i18n.test.ts` — parity coverage for the new keys.
- `jest.config.js` — added `expo-print` to `RN_TRANSPILE_DEPS` (untranspiled ESM).
- `package.json` + `package-lock.json` — added `expo-print` (~15.0.8). **Only new dep.**

**NOT changed (per design §"New / changed files"):** `useStaffStore.ts`, any
migration / RLS / edge function / `config.toml` / `useRealtimeSync.ts`, `src/lib/db.ts`
(admin reorder fetch), `app.json`. No backend / pgTAP work (verified §0 — data path
already manager-callable).

**Verification:**
- jest: full suite **553/553 green** (55 suites) incl. the new staff Reorder tests +
  the admin reorder regression (`ReorderSectionCases.test.tsx` 22/22).
- typecheck: `npx tsc --noEmit` (base) **exit 0**; `npx tsc -p tsconfig.test.json
  --noEmit` (test graph) **exit 0**.
- web bundle: the real Expo web entry (`expo/AppEntry.bundle`) compiles error-free
  (HTTP 200, 14.5 MB) with all new staff Reorder modules included
  (`staff-reorder-root`, `shareReorderCsv`/`buildReorderPdfHtml`, `staff-tab-reorder`).
- real-RPC payload: signed in as `manager@local.test` (role `user`, granted Towson +
  Frederick) and called `report_reorder_list` for Towson — returns spec-088 case
  fields (e.g. Dr Pepper: case_qty 36 → 2 cases · 72 units). Local seed had NO
  `order_schedule` rows (so every vendor was no-schedule); I seeded 3 Towson rows
  (BJs+COSTCO on Tuesday, BJs on Friday — **local DB state only, not a repo change**)
  and confirmed the screen's exact pure partition/KPI logic yields a non-empty
  PRIMARY set (BJs+COSTCO, 15 items, $647.66), the no-schedule group (8 vendors),
  active weekdays (Tue+Fri), and `showExport: true`.
- Browser-driving note: **no `preview_*` / Chrome-MCP tools were available in this
  session**, so per the project rule I verified via the running web server (bundle
  compiles + new code included) + the real manager-JWT RPC payload + the pure
  partition logic the screen consumes (the spec-088 verification approach). The
  native share path (`expo-file-system` temp file + `expo-sharing` share sheet +
  `expo-print` PDF) is unit-tested at the orchestrator boundary but NOT driven on a
  physical device in this session — flag for device QA.
