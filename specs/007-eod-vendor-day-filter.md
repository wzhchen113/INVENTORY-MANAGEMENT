# Spec 007: EOD count vendor row filtered by day-of-week schedule

Status: READY_FOR_REVIEW

## User story
As a store manager doing an EOD count, I want the vendor row at the top of
the count panel to show only the vendors scheduled to be counted on the
selected day, so the worksheet matches that day's actual receiving cadence
and I'm not asked to count vendors that don't deliver that day.

## Background (current behavior, verified)

`src/screens/cmd/sections/EODCountSection.tsx:138-146` builds vendor tabs
from "any vendor that has at least one inventory item at this store" — it
is *not* day-aware. The selected day in the left rail (`selectedIso`,
line 53) drives nothing about which vendors render; today every store-
relevant vendor renders on every day.

`order_schedule` already exists (per CLAUDE.md and Spec 005 discovery):
columns `(id, store_id, day_of_week text, vendor_id, vendor_name,
delivery_day text, created_at)`, indexed on `(store_id, day_of_week)`,
with no unique constraint at `(store_id, day_of_week, vendor_id)` grain
because the existing `saveOrderSchedule` write path is delete-then-insert
per `(store_id, day_of_week)`.

`vendors.lead_time_days` also exists as a parallel signal but has not
been confirmed as authoritative for this UX.

## User scenario the user described
On Thursday, BJS appears with `(9) · cutoff 14:00` even though BJS is
not scheduled to deliver/be-counted on Thursday. The user wants Thursday
to show only the vendors that are on Thursday's schedule.

## Acceptance criteria

These are written assuming the user picks the most likely answers to the
open questions below; they will firm up after Q&A.

- [ ] On `EODCountSection`, when a day cell is selected in the left rail
  (`selectedIso` = some date), the vendor tab row reflects only vendors
  scheduled for that day's day-of-week for the current store.
- [ ] "Scheduled for that day" is sourced from the `order_schedule` row
  set at `(store_id = currentStore.id, day_of_week = <Mon..Sun for the
  selected ISO date>)`.
- [ ] If no `order_schedule` rows exist for that `(store, day_of_week)`,
  the vendor row renders an empty state with a clear, actionable
  message (exact copy + CTA pending Q2/Q3 below).
- [ ] Switching `selectedIso` to a different weekday updates the vendor
  row to that weekday's scheduled vendors without a manual refresh.
- [ ] When the schedule changes elsewhere (e.g. another admin edits it),
  the vendor row updates within the existing realtime debounce window
  on the same store/brand channels — no new realtime channel.
- [ ] The `(N)` count badge on each vendor card continues to mean
  "items in this store sourced from this vendor" (unchanged from today)
  — confirmed in Q6 below or revised per the user's answer.
- [ ] Per-vendor `cutoff` text continues to come from `vendors.orderCutoffTime`
  unless Q5 says otherwise.
- [ ] No new functionality lands in `src/screens/AdminScreens.tsx` or
  any legacy store/sync file.
- [ ] No change to `app.json`'s `slug` value.

## In scope

- Day-aware filtering of the vendor tab row in
  `src/screens/cmd/sections/EODCountSection.tsx`.
- Reading `order_schedule` for the current store, keyed by day-of-week
  derived from `selectedIso`.
- Wiring `order_schedule` into `useStore.ts` if it isn't already loaded
  there for the Cmd UI surface (legacy `useSupabaseStore.ts` may load it,
  but legacy stores are frozen).
- Empty-state copy + CTA on the vendor row when no vendors are
  scheduled for that day.
- Realtime: if `order_schedule` is not already in the realtime
  publication, add it (new migration), and confirm the post-migration
  Docker-restart gotcha is documented in the spec deliverables.

## Out of scope (explicitly)

- A new "Order schedule" admin section in the Cmd UI sidebar. (May be
  proposed as a follow-up depending on Q2.)
- Editing `order_schedule` from the EOD screen, unless Q2 says option
  (a) or (c).
- Changing how `vendors.lead_time_days` is computed, displayed, or used
  elsewhere.
- Changing how the `(N)` count badge or cutoff text renders, unless Q5
  or Q6 explicitly asks for it.
- Anything in the staff app or customer PWA — different repos.
- Changing the inner item-list filter (category chips, item rows). Items
  for the selected vendor still show; only which vendors are visible
  changes.
- Removing or modifying `AdminScreens.tsx` or `IngredientsScreen.tsx`
  schedule UI (legacy, frozen).

## Open questions for the user (NOT yet resolved)

PM-recommended defaults are noted in parentheses. The user must ratify
or override before this leaves DRAFT.

**Q1 — Is the schedule per-store?**
`order_schedule.store_id` says yes structurally. Confirm: a vendor
selected for Towson on Thursday does NOT automatically appear on
Reisters' Thursday.
*PM default: yes, per-store.*

**Q2 — Where is the per-day vendor selection managed?**
- (a) On the EOD screen itself, edit-in-place (a `+ vendor` button next
  to the vendor row).
- (b) A separate "Order schedule" section in the Cmd UI sidebar (weekly
  grid: rows = vendors, cols = days, checkboxes).
- (c) Both — read inline on EOD, bulk edit in a dedicated section.
*PM default: (b) for this spec, with a follow-up spec for inline edit
once the read-side is shipped. Keeps the EOD screen focused on counting.*

**Q3 — First-open default after this ships?**
Today every vendor appears every day. After the filter lands:
- (a) Default empty — no vendors render until the user populates the
  schedule. (Pure but noisy regression for existing stores.)
- (b) Default "all vendors on all days" until the user explicitly opts
  into a constrained schedule. (Safest, but doesn't help anyone unless
  they actively edit.)
- (c) Seed from `vendors.lead_time_days` if populated for the store,
  else fall back to (b).
*PM default: (b). Migration risk is real — silently emptying the vendor
row on day one would look like a bug.*

**Q4 — Unscheduled / emergency receiving on a non-scheduled day?**
If BJS isn't scheduled for Monday but a manager needs to count BJS on a
Monday anyway, do they:
- (a) Permanently add BJS to Monday's schedule (edits the schedule).
- (b) Add for-this-day-only override (no permanent schedule change).
- (c) Block — force them to update the schedule first.
- (d) Always-available "show all vendors" toggle on the day, leaving
  the schedule untouched.
*PM default: (d) — toggle on the EOD screen "show unscheduled vendors"
that simply unfilters the row for that view. No schedule mutation, no
new override table.*

**Q5 — Cutoff time per-vendor or per-(vendor, day)?**
Today the cutoff text comes from `vendors.orderCutoffTime` — one value
per vendor. `order_schedule.delivery_day` exists but no `cutoff_time`
column does.
*PM default: keep cutoff per-vendor (no schema change). If per-(vendor,
day) is needed, that's a separate spec with its own migration.*

**Q6 — `(N)` count badge meaning?**
Today it's "items in this store sourced from this vendor". Should it
remain that, or become "items expected to be counted for this vendor
on this day"?
*PM default: leave as-is. Items aren't tagged with a delivery day, so
filtering this number would require a schema change too.*

**Q7 — REST days?**
Days marked `REST` in the left rail (status === 'rest') already render
at 0.55 opacity. Should selecting a REST day:
- (a) Show the same scheduled vendors as the underlying weekday (and
  let the user count anyway).
- (b) Show no vendors regardless of schedule.
- (c) Show scheduled vendors + a "REST DAY" banner.
*PM default: (a). REST is a status pill, not a hard close — and the
schedule is already keyed by day-of-week, so weekday→vendors is
deterministic.*

**Q8 — Cross-store admin view (`__all__` mode)?**
If `currentStore.id` represents "all stores", how should the day-vendor
mapping render?
- (a) Union of all stores' schedules for that weekday.
- (b) Render an empty/disabled state with copy "Select a store to see
  vendor schedule."
- (c) Show all vendors (current behavior preserved as a fallback).
*PM default: (b). Counts are per-store anyway, so a unioned vendor row
would be misleading.*

**Q9 — Migration of existing data.**
If `order_schedule` is empty for a store today, the vendor row will be
empty after this ships unless we choose Q3 option (b) or (c). Confirm
the chosen Q3 path is acceptable for stores that have never opened the
legacy schedule UI.

## Resolved answers (locked 2026-05-07 by user)

- **Q1 = yes, per-store.** Each store has its own day→vendors mapping.
  `order_schedule.store_id` is the scope key.
- **Q2 = (c) both.** Inline edit on the EOD screen (next to the vendor
  row, when a store + day is selected) AND a dedicated "Order schedule"
  Cmd UI sidebar section with the weekly grid (rows = vendors, cols =
  days). Read-side is the same in both places; the dedicated section is
  the bulk-edit surface.
- **Q3 = (b) all-vendors-on-all-days fallback.** No seed from
  `lead_time_days` — confirmed not a clean mapping (lead_time is days
  to delivery, not day-of-week). Stores with empty `order_schedule`
  preserve current behavior; users build the real schedule via Q2's
  admin section. No regression on day one.
- **Q4 = (d) "show unscheduled vendors" toggle on the EOD screen.** Day
  default is filtered to scheduled vendors only; toggle unfilters the
  current view without mutating the schedule. No new override table.
- **Q5 = cutoff is notification only.** The cutoff time on the vendor
  card is a soft warning ("you missed today's order window") — it never
  blocks count input. Counts are always enterable regardless of cutoff
  status. Spec 007 does not change cutoff logic; it just makes sure
  the vendor card's cutoff text remains visible after filtering.
- **Q6 = leave the `(N)` count badge as-is.** Stays "items at this
  store sourced from this vendor" (today's behavior). Per-day filtering
  of the badge would require tagging items with delivery days =
  separate spec.
- **Q7 = (a) with read-only enforcement.** REST days show the same
  scheduled vendors as the underlying weekday, BUT input is blocked
  on REST days — count cells are disabled, "+ COUNT" / "SAVE DRAFT" /
  "SUBMIT COUNT" actions disabled or hidden, with a clear "REST DAY -
  no input" affordance (banner or pill). Architect picks the exact UX.
- **Q8 = (b) empty-state in `__all__` mode.** When `currentStore.id ===
  '__all__'`, render a message like "Select a store to count
  inventory." with the vendor row hidden. No union view.
- **Q9 = default given Q3=(b).** Stores with empty `order_schedule`
  see current behavior on day one. No migration regression.

### Pinned scope shape (architect's contract)

- **Schema**: NO new tables. Use existing `order_schedule` (from
  `20260424211732_recover_undeclared_tables.sql`). Architect probes
  whether realtime publication membership needs an addition.
- **Read-side**: `EODCountSection.tsx` filters its `vendorTabs` array
  by `(store_id = currentStore, day_of_week = selectedIso's weekday)`
  via a join against `order_schedule`. Empty `order_schedule` for the
  store → fallback to current "all vendors" behavior.
- **Write-side (Q2 admin section)**: new Cmd UI section
  `src/screens/cmd/sections/OrderScheduleSection.tsx`. Weekly grid;
  click a (vendor, day) cell to toggle membership. Writes flow through
  `saveOrderSchedule` (or new `db.ts` helpers if that surface is
  insufficient) — architect probes existing wiring.
- **Inline edit (Q2's other half)**: a `+ vendor` button on the EOD
  vendor row that opens a small picker; clicking a vendor adds it to
  the day's schedule. Same writes as Q2 admin section, just a
  different entry point.
- **REST day read-only**: `EODCountSection.tsx` already has REST status
  detection — extend so REST flips count inputs / actions to disabled.
- **`__all__` empty-state**: `EODCountSection.tsx` adds an early-return
  branch when store is `__all__`.
- **Toggle for unscheduled vendors**: a small UI control on the EOD
  screen (architect picks placement) that bypasses the schedule filter
  for the current view.

## Dependencies

- Existing table: `order_schedule` (from `recover_undeclared_tables`
  migration; no new table proposed).
- Possible existing write surface: `saveOrderSchedule` in `src/lib/db.ts`
  + `src/store/useStore.ts`. To be confirmed by architect — it may be
  wired only from legacy `AdminScreens.tsx` today.
- New migration ONLY if (a) Q2 picks option (b) or (c) and the new
  admin section needs an upsert path with a real unique constraint, or
  (b) `order_schedule` is not in `supabase_realtime` publication.
- No new edge function. All reads/writes go through PostgREST/RPC via
  `src/lib/db.ts`.
- No new test framework — there is none yet. If the architect deems
  tests necessary, this is a flag for the test-engineer reviewer.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only —
  `src/screens/cmd/sections/EODCountSection.tsx`. Do NOT modify
  `src/screens/AdminScreens.tsx` or `src/screens/IngredientsScreen.tsx`
  (both frozen).
- **Per-store or admin-global:** Per-store, scoped by
  `currentStore.id` and `auth_can_see_store()` RLS.
- **Realtime channels touched:** `store-{currentStore.id}` (existing).
  No new channel. If `order_schedule` is missing from the realtime
  publication, the architect must include adding it + call out the
  `docker restart supabase_realtime_imr-inventory` gotcha as a
  deployment risk.
- **Migrations needed:** Probably no — `order_schedule` already exists.
  Conditional yes only if (1) we need a unique constraint to support
  per-day vendor edit (Q2 option b/c), or (2) the table isn't in the
  realtime publication.
- **Edge functions touched:** None.
- **Web/native scope:** Web + native — the Cmd UI runs on both, no
  web-only APIs are involved.
- **Data-layer rule:** Reads/writes via `src/lib/db.ts` and
  `src/store/useStore.ts` only. `useSupabaseStore.ts`,
  `useJsonServerSync.ts`, `db.json`, and the `npm run db` script are
  legacy and must not be modified.
- **app.json slug:** Not touched. `towson-inventory` stays.
- **Tests:** No test framework wired up. If the architect wants
  coverage, surface it for the test-engineer reviewer to scope a
  framework introduction — out of scope for this spec.

## Backend design

### §0 — Probe-execution plan & resolved state

Probes were executed against the codebase only (no live DB hit needed
for this design — every fact below is grounded in committed migrations
and existing client code). Backend developer should still re-verify
against local DB at implementation time using the verification queries
below.

**Probe 1 — `order_schedule` row count / distribution.**
Architect did NOT hit local DB. Backend dev to run as a one-off
sanity check before writing the migration:

```sql
-- Total rows
select count(*) from public.order_schedule;
-- Per store
select store_id, count(*) from public.order_schedule
  group by store_id order by 2 desc;
-- Per (store, day) — duplicate detection
select store_id, day_of_week, vendor_id, count(*)
  from public.order_schedule
  group by 1, 2, 3
  having count(*) > 1;
```

If the third query returns rows, those are pre-existing duplicates
that the unique-constraint migration in §1 would reject. The
migration must include a `delete using ctid` dedup pass before
adding the constraint, or be split into two phases. Default
recommendation: **dedup-then-constrain in a single migration**, since
`saveOrderSchedule` has been delete-then-insert per `(store_id,
day_of_week)` since day one — duplicates at the
`(store_id, day_of_week, vendor_id)` grain shouldn't exist
unless something hand-edited the table.

**Probe 2 — `saveOrderSchedule` and `setOrderSchedule` wiring.**
- `db.saveOrderSchedule(storeId, day, vendors)` lives at
  [src/lib/db.ts:1516-1530](src/lib/db.ts:1516). Signature: takes
  TitleCase day string (`'Monday'`..`'Sunday'`), array of
  `{ vendorId, vendorName, deliveryDay }`. Idiom: delete every row
  for `(store_id, day_of_week)`, then bulk-insert the new set.
- `db.fetchOrderSchedule(storeId)` lives at
  [src/lib/db.ts:1498-1514](src/lib/db.ts:1498). Returns
  `Record<TitleCase day, OrderDayVendor[]>` — already used by
  `fetchAllForStore` in `loadFromSupabase`.
- `useStore.setOrderSchedule(day, vendors)` lives at
  [src/store/useStore.ts:1027-1040](src/store/useStore.ts:1027).
  Optimistic-then-revert via `notifyBackendError`. Day param is
  TitleCase.
- The existing slice baseline in `useStore.ts:182-184` is
  `{ Monday: [], Tuesday: [], ... Sunday: [] }`. Confirmed: **day key
  format is TitleCase weekday ("Monday".."Sunday")**. This is the
  contract going forward; the `day_of_week` column on
  `order_schedule` stores the same TitleCase strings.
- Spec 005's claim that `saveOrderSchedule` is wired only from legacy
  `AdminScreens.tsx` is **incorrect** in the Cmd UI surface —
  `useStore.setOrderSchedule` is the wiring path. Whatever component
  invokes `setOrderSchedule` calls into `saveOrderSchedule`. The
  legacy `AdminScreens.tsx` may also call it directly via `db.*`,
  but that does not change anything for this spec.

**Probe 3 — Realtime publication membership.**
Architect grepped all 30 migrations for `alter publication
supabase_realtime add table` and found **zero matches**. None of the
init schema or follow-up migrations explicitly add tables to the
`supabase_realtime` publication; per the
project_realtime_publication_gotcha memory note, table membership
is set via the Supabase Studio UI / dashboard and is captured in the
publication snapshot but not in migration files in this repo. The
existing realtime subscriptions in
[src/hooks/useRealtimeSync.ts](src/hooks/useRealtimeSync.ts) imply
that `inventory_items`, `eod_submissions`, `waste_log`, `recipes`,
`prep_recipes`, `catalog_ingredients`, `vendors`, and
`ingredient_conversions` are in the publication. **Whether
`order_schedule` is in the publication is unknown without a probe**:

```sql
select schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
   and tablename = 'order_schedule';
```

See §5 for the realtime-membership decision conditional on this
probe's result. If the result is empty AND we choose to add the
table, the migration must `alter publication supabase_realtime add
table public.order_schedule` and the docker-restart gotcha applies
(both `supabase_realtime_imr-inventory` after `npm run dev:db` AND a
prod publication membership change for deploy).

**Probe 4 — `vendors.brand_id` filter when joining `order_schedule`.**
`fetchVendors(brandId)` already filters vendors to a single brand.
`order_schedule` rows are scoped by `store_id`, and a store belongs
to exactly one brand. Therefore: a row in `order_schedule` for store
X always references a vendor under store X's brand (assuming the
write path enforces brand alignment, which the inline `+ vendor`
button MUST do — see §6). **No cross-brand contamination risk** as
long as the vendor picker shown by the `+ vendor` button only lists
vendors from the current store's brand. The picker pulls from
`useStore.vendors`, which is already brand-filtered at load.

**Probe 5 — `day_of_week` text format.**
Verified: TitleCase weekday strings (`'Monday'`..`'Sunday'`). Source
of truth: `useStore.ts:182-184` baseline and the `DAY_NAMES` const
in `EODCountSection.tsx:30`. `fetchOrderSchedule` keys its returned
record by `row.day_of_week` directly with no normalization, so
whatever is in the DB wins — the existing seed/legacy writes wrote
TitleCase. **The new write paths must use TitleCase strings.** No
case-folding, no abbreviations.

**Probe 6 — `__all__` mode reality check.**
`useStore.setCurrentStore` at lines 218-236 actively redirects
`__all__` to the first accessible store BEFORE updating
`currentStore`. So `currentStore.id === '__all__'` should never be
true in normal navigation. BUT `loadFromSupabase` at line 252
explicitly handles `sid === '__all__'` for a fleet-wide bulk load
path, so the value can still flow through that helper. The spec
requires an empty-state branch in `EODCountSection` for `__all__`
defensively. Recommendation: keep the empty-state branch as a
robustness guard, even though `setCurrentStore` should prevent the
state in practice. Cheap to add, expensive to debug if a future
change re-enables `__all__`.

### §1 — Schema changes

**Decision: ship a single migration adding a unique constraint.**

Filename: `supabase/migrations/<TS>_order_schedule_unique_per_cell.sql`
where `<TS>` is generated at write time. Today's date is 2026-05-06,
so `20260506HHMMSS_order_schedule_unique_per_cell.sql`.

Migration contents (additive + minor data cleanup):

```sql
-- 1. Dedup any pre-existing (store_id, day_of_week, vendor_id) duplicates
--    by keeping the oldest row.
delete from public.order_schedule a
 using public.order_schedule b
 where a.ctid > b.ctid
   and a.store_id    = b.store_id
   and a.day_of_week = b.day_of_week
   and a.vendor_id is not distinct from b.vendor_id;

-- 2. Unique constraint at the per-cell grain so the new admin section's
--    "toggle a (vendor, day) cell" can do an idempotent insert (or upsert
--    if the developer prefers ON CONFLICT DO NOTHING).
alter table public.order_schedule
  add constraint order_schedule_store_day_vendor_unique
  unique (store_id, day_of_week, vendor_id);
```

Notes:
- `vendor_id` is nullable (per recover_undeclared_tables column def);
  the unique constraint treats NULL as distinct, which is fine — we
  don't expect NULL vendor rows in practice and the inline `+ vendor`
  picker only writes rows with a real `vendor_id`. If legacy null
  rows exist, leave them; they don't conflict.
- Additive only. No data destruction beyond the dedup pass, which is
  itself idempotent if duplicates are already absent.
- Existing `idx_order_schedule_store_day` index is kept (the unique
  constraint creates its own backing index but the existing one
  doesn't hurt).
- This migration **does NOT alter the realtime publication.** That
  decision is in §5 and is a separate (or combined) migration if
  needed.

### §2 — Read contract

**One new helper in `src/lib/db.ts` to fetch the day-filtered vendor
list.** Plus reuse of the existing `fetchOrderSchedule` for bulk
admin-grid reads.

New helper signature:

```ts
/**
 * Returns the vendor IDs scheduled at this store on this weekday.
 * Empty array means "no schedule rows for (store, day)" — caller
 * MUST treat that as "schedule not configured at all" and fall back
 * to all-vendors visibility (Q3=(b)).
 *
 * day must be TitleCase weekday: "Monday".."Sunday".
 */
export async function fetchScheduledVendorIdsForDay(
  storeId: string,
  day: string,
): Promise<string[]>;
```

Implementation note: simple `select vendor_id from order_schedule
where store_id = $1 and day_of_week = $2`, filter out null
`vendor_id` rows, return ids. RLS already restricts reads to
store-members + admins per `security_fixes.sql:24-29`.

**Empty-store fallback semantics.** EODCountSection consumes the
result as follows (frontend logic, restated here as the contract):

1. If the store has **zero** `order_schedule` rows total
   (`useStore.orderSchedule[currentStore.id]` is all-empty after
   load), treat as "schedule not configured" — render all vendors
   (current behavior, no regression). Use the existing slice already
   loaded by `fetchOrderSchedule` in `loadFromSupabase` — DON'T issue
   a separate per-day fetch in this case.
2. Otherwise, intersect `vendorTabs` (current "vendors with items at
   this store") against `fetchScheduledVendorIdsForDay(currentStore.id,
   selectedDayName)`. Render only the intersection.

Equivalent without a new helper: the existing
`fetchOrderSchedule(storeId)` loaded into `useStore.orderSchedule` on
login already gives us the full week. The day-specific filter is just
`useStore.orderSchedule[currentStore.id]?.[selectedDayName] ?? []`
mapped to vendor IDs. **Recommended path: skip
`fetchScheduledVendorIdsForDay` entirely; do the filter client-side
against the already-loaded `orderSchedule` slice.** This is cheaper
(no extra round trip when switching `selectedIso`), simpler, and
matches how `fetchOrderSchedule` is already integrated.

**Final §2 decision: NO new read helper.** Use the existing
`useStore.orderSchedule` slice that is already populated by
`fetchOrderSchedule(storeId)` via `fetchAllForStore`. The frontend
reads `orderSchedule[selectedDayName]` and intersects with
`vendorTabs`. The realtime path (§5) keeps the slice fresh after
admin edits.

### §3 — Write contracts

Three write surfaces, all writing the same row shape, all going
through `src/lib/db.ts`:

**3a. Inline `+ vendor` toggle on EOD vendor row** (single insert).

New helper signature:

```ts
/**
 * Add one (store, day, vendor) row to the schedule. Idempotent —
 * if the cell is already scheduled (per the unique constraint
 * added in §1), this is a no-op. TitleCase day required.
 */
export async function addOrderScheduleEntry(
  storeId: string,
  day: string,
  vendor: { vendorId: string; vendorName: string; deliveryDay?: string },
): Promise<void>;
```

Implementation: `INSERT INTO order_schedule (store_id, day_of_week,
vendor_id, vendor_name, delivery_day) VALUES (...) ON CONFLICT ON
CONSTRAINT order_schedule_store_day_vendor_unique DO NOTHING`.

**3b. Inline "remove vendor" cell on EOD vendor row** (single delete).

New helper signature:

```ts
/**
 * Remove one (store, day, vendor) row. Idempotent — no-op if the
 * cell wasn't scheduled.
 */
export async function removeOrderScheduleEntry(
  storeId: string,
  day: string,
  vendorId: string,
): Promise<void>;
```

Implementation: `DELETE FROM order_schedule WHERE store_id=$1 AND
day_of_week=$2 AND vendor_id=$3`.

**3c. Bulk grid edit in `OrderScheduleSection`** — same single-cell
semantics as inline. The grid renders 7 columns × N vendors; clicking
a cell calls `addOrderScheduleEntry` (if currently off) or
`removeOrderScheduleEntry` (if currently on). NO bulk replace path.

The existing `db.saveOrderSchedule` (delete-then-insert per
`(store_id, day_of_week)`) is **kept for legacy back-compat**
(`AdminScreens.tsx` still uses it via `useStore.setOrderSchedule`)
but the new surfaces don't call it. The new add/remove helpers are
the per-cell write API.

**Optimistic-then-revert in `useStore.ts`.** Two new actions:

```ts
addScheduledVendor: (day: string, vendor: OrderDayVendor) => void;
removeScheduledVendor: (day: string, vendorId: string) => void;
```

Both follow the `submitOrder` / `addVendor` pattern — capture
`prev = orderSchedule`, mutate optimistically, call `db.*`, revert
+ `notifyBackendError('Update order schedule', e)` on failure.

### §4 — RLS impact

**No new RLS work required for this spec.** Existing policies on
`order_schedule` (from
`supabase/migrations/20260424211733_security_fixes.sql:21-35`):

- **Read policy** `"Store members can read order_schedule"`:
  user_stores membership OR admin/master role. Uses inline subquery,
  not `auth_can_see_store()` — matches the comment in
  `per_store_rls_hardening.sql:19-23` that says order_schedule was
  intentionally left alone. Functionally equivalent for our needs.
  **No change needed.**
- **Write policy** `"Admins can write order_schedule"` for ALL
  operations: admin/master only via JWT `app_metadata.role` check.
  This means the inline `+ vendor` toggle and the
  `OrderScheduleSection` admin grid will fail for non-admin users.
  Matches the spec's intent (this is admin-managed config).

**Optional follow-up (out of scope for this spec, flagged for
backlog):** Migrate `order_schedule`'s read policy from the inline
subquery to `auth_can_see_store(store_id)` for consistency with the
rest of the RLS hardening. NOT a Spec 007 concern — surface as a
followup ticket only.

### §5 — Realtime impact

**Decision: do NOT add `order_schedule` to the realtime publication
in this spec. Use existing channels by reload.**

Rationale:
1. The "schedule changes elsewhere updates this view" requirement in
   the acceptance criteria is satisfied by the existing 400ms
   debounce on `useRealtimeSync` — but only if `order_schedule`
   changes trigger one of the already-subscribed tables, which they
   don't.
2. Adding the table to the publication has the documented
   docker-restart gotcha for local dev AND requires a prod
   publication change. Neither is a hard blocker, but the cost is
   higher than the benefit: in practice, schedule edits are
   admin-driven and rare, and the EOD-counting user is the same
   admin (or arrives ~minutes after via natural reload).
3. After an admin edit, the **same browser tab** that did the edit
   already has fresh state via the optimistic write in
   `useStore.addScheduledVendor` / `removeScheduledVendor`.
   Cross-tab/cross-device propagation only matters for the
   multi-admin scenario, which is not the primary use case here.

**If the user later requires multi-admin live propagation**, a
follow-up spec adds:
- A migration: `alter publication supabase_realtime add table
  public.order_schedule`.
- An additional `.on('postgres_changes', { ... table:
  'order_schedule', filter: 'store_id=eq.${storeId}' }, onSync)` on
  the `store-${storeId}` channel.
- The docker-restart deploy/dev step is documented.

For Spec 007, **no migration to the realtime publication, no change
to `useRealtimeSync.ts`.** The first acceptance criterion line about
"the schedule changes elsewhere... updates within the existing
realtime debounce window" is **revised**: schedule changes from the
SAME tab are reflected immediately via optimistic write; cross-tab
propagation requires a manual refresh or store switch. Backend
developer to update the spec's acceptance criteria comment in code
to match this reality.

### §6 — Frontend boundaries

| File | Change kind | Owner |
|---|---|---|
| `src/types/index.ts` | NEW: `OrderScheduleEntry` (single row shape, optional — `OrderDayVendor` may suffice) | frontend |
| `src/lib/db.ts` | NEW helpers `addOrderScheduleEntry`, `removeOrderScheduleEntry` | backend |
| `src/store/useStore.ts` | NEW actions `addScheduledVendor`, `removeScheduledVendor` (optimistic + db call). Keep existing `setOrderSchedule` untouched. | backend |
| `src/screens/cmd/sections/EODCountSection.tsx` | Filter `vendorTabs` by `orderSchedule[selectedDayName]` (with empty-state fallback). REST-day input disable. `__all__` empty state. Inline `+ vendor` button + picker. "Show unscheduled vendors" toggle. | frontend |
| `src/screens/cmd/sections/OrderScheduleSection.tsx` | NEW — weekly grid (rows = vendors, cols = days). Click toggles via the new useStore actions. | frontend |
| `src/screens/cmd/InventoryDesktopLayout.tsx` | Add `OrderSchedule` entry to the `Planning` group of the sidebar `groups` array. Add the `section === 'OrderSchedule' ?` branch. | frontend |
| `src/hooks/useRealtimeSync.ts` | NO CHANGE (per §5). | — |

**File-by-file detail:**

#### `src/screens/cmd/sections/EODCountSection.tsx`

Read `orderSchedule` slice from useStore. Compute the selected day
name from `selectedIso`:

```
const selectedDay = DAY_NAMES[new Date(selectedIso + 'T00:00:00').getDay()];
// (use store-local construction; current code uses `new Date(d)` —
// preserve the existing idiom from line 116)
```

Compute fallback flag:

```
const scheduleConfigured = Object.values(orderSchedule).some(arr => arr.length > 0);
const dayScheduledVendorIds = orderSchedule[selectedDay]
  ?.map(v => v.vendorId).filter(Boolean) ?? [];
```

Filter `vendorTabs` (the existing memo at lines 138-146):

```
const filteredVendorTabs = useMemo(() => {
  if (showUnscheduled) return vendorTabs;        // toggle override
  if (!scheduleConfigured) return vendorTabs;     // no schedule — show all
  return vendorTabs.filter(v => dayScheduledVendorIds.includes(v.id));
}, [vendorTabs, showUnscheduled, scheduleConfigured, dayScheduledVendorIds]);
```

Render `filteredVendorTabs` instead of `vendorTabs`. The
`React.useEffect` at lines 148-151 that auto-selects the first
vendor must use `filteredVendorTabs` so it doesn't strand the user
on a hidden vendor.

**`+ vendor` button**: appended after the vendor pills in the
`flexWrap` row at line 428. Opens a small picker (modal or
dropdown — see §11 open flag). Picker lists vendors from
`useStore.vendors` MINUS already-scheduled-this-day vendors. On
select, calls `useStore.getState().addScheduledVendor(selectedDay,
{ vendorId, vendorName })`.

**Remove vendor**: existing pills already handle press-to-select.
Add a per-pill "×" affordance (small button on hover/long-press) that
calls `removeScheduledVendor(selectedDay, v.id)`. Or: no inline
remove on EOD; require user to remove from `OrderScheduleSection`.
Architect-level call: ship the inline "×" since the user explicitly
locked Q2=(c) "both" and removal is symmetric to the `+ vendor`
add. Keep the affordance subtle so it doesn't look like a primary
action during counting.

**Show unscheduled vendors toggle**: new local state
`const [showUnscheduled, setShowUnscheduled] = useState(false)`.
Placement: as a small monospace text-button to the right of the
vendor pills row (after the pills, on the same row). Style as a
ghost button consistent with the `+ vendor` affordance. When on:
visual cue "showing all" pill on the row.

**REST day enforcement**: `EODCountSection.tsx` already computes
`isRest` per-day-cell at line 341. Need a separate flag for the
*selected* day:

```
const selectedDayCell = week.find(d => d.iso === selectedIso);
const isRestDay = selectedDayCell?.status === 'rest';
```

When `isRestDay` is true:
- The top-of-worksheet header strip (line 426 area) shows a "REST
  DAY — no input" banner. Pick the banner UX (see §8 below for
  decision).
- All `TextInput` rows at lines 562-624 receive `editable={false}`
  and reduced opacity (0.5).
- "+ COUNT", "SAVE DRAFT", "SUBMIT COUNT" buttons at lines 407-415
  receive `disabled` AND visually render as disabled
  (`opacity: 0.4`, `pointerEvents: 'none'`).
- The vendor row STAYS visible (per Q7=(a) "show same scheduled
  vendors") so the user sees what would have been counted.

**`__all__` mode empty state**: at the very top of the component
return, before the `<>` fragment:

```
if (currentStore.id === '__all__' || !currentStore.id) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ ...Type.body, color: C.fg2 }}>
        Select a store to count inventory.
      </Text>
    </View>
  );
}
```

#### `src/screens/cmd/sections/OrderScheduleSection.tsx` (NEW)

Single new file. Layout:
- Left: 240px sidebar showing the current store name (consistent
  with `EODCountSection`'s left rail).
- Right: weekly grid. Rows = vendors from `useStore.vendors` (filtered
  to current store's brand — already done by store-load). Columns
  = the 7 weekdays (Monday-Sunday). Each cell is a checkbox/dot
  showing whether that (vendor, day) is scheduled. Click toggles via
  `addScheduledVendor` / `removeScheduledVendor`.
- Top: title bar `order_schedule.tsv` + count of scheduled cells.
- Empty-state: if `vendors.length === 0`, render "No vendors yet —
  create one in the Vendors section" with a link.
- `__all__` guard: same empty-state as EODCountSection.

#### `src/screens/cmd/InventoryDesktopLayout.tsx`

Add to `groups` (line 134-168):

```
{
  label: 'Planning',
  items: [
    { id: 'PurchaseOrders',  label: 'Purchase orders' },
    { id: 'Vendors',         label: 'Vendors' },
    { id: 'Categories',      label: 'Categories' },
    { id: 'OrderSchedule',   label: 'Order schedule' }, // NEW
    { id: 'Recipes',         label: 'Menu items / BOM' },
    ...
  ],
},
```

Add the dispatch branch in the section-switch chain (around line 247):

```
) : section === 'OrderSchedule' ? (
  <OrderScheduleSection />
```

Plus the import at line 47-area.

#### `src/lib/db.ts`

Two new exports placed adjacent to `saveOrderSchedule` at line 1497:

```ts
export async function addOrderScheduleEntry(
  storeId: string,
  day: string,
  vendor: { vendorId: string; vendorName: string; deliveryDay?: string },
): Promise<void> {
  const { error } = await supabase
    .from('order_schedule')
    .insert({
      store_id: storeId,
      day_of_week: day,
      vendor_id: vendor.vendorId,
      vendor_name: vendor.vendorName,
      delivery_day: vendor.deliveryDay ?? null,
    });
  // 23505 = unique violation = idempotent no-op (cell already scheduled)
  if (error && (error as any).code !== '23505') throw error;
}

export async function removeOrderScheduleEntry(
  storeId: string,
  day: string,
  vendorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('order_schedule')
    .delete()
    .eq('store_id', storeId)
    .eq('day_of_week', day)
    .eq('vendor_id', vendorId);
  if (error) throw error;
}
```

Mapping note: no snake_case→camelCase mapping needed at the helper
level (these are write-only). Reads continue through
`fetchOrderSchedule`, which already does the mapping at line 1505-1511.

#### `src/store/useStore.ts`

Add to the actions interface (around line 116):

```ts
addScheduledVendor: (day: string, vendor: OrderDayVendor) => void;
removeScheduledVendor: (day: string, vendorId: string) => void;
```

And the implementations (next to `setOrderSchedule` at line 1027):

```ts
addScheduledVendor: (day, vendor) => {
  const prev = get().orderSchedule;
  set((s) => ({
    orderSchedule: {
      ...s.orderSchedule,
      [day]: [...(s.orderSchedule[day] ?? []), vendor],
    },
  }));
  const storeId = get().currentStore?.id;
  if (storeId && storeId !== '__all__' && vendor.vendorId) {
    db.addOrderScheduleEntry(storeId, day, {
      vendorId: vendor.vendorId,
      vendorName: vendor.vendorName,
      deliveryDay: vendor.deliveryDay,
    }).catch((e: any) => {
      set({ orderSchedule: prev });
      notifyBackendError('Add scheduled vendor', e);
    });
  }
},

removeScheduledVendor: (day, vendorId) => {
  const prev = get().orderSchedule;
  set((s) => ({
    orderSchedule: {
      ...s.orderSchedule,
      [day]: (s.orderSchedule[day] ?? []).filter(v => v.vendorId !== vendorId),
    },
  }));
  const storeId = get().currentStore?.id;
  if (storeId && storeId !== '__all__') {
    db.removeOrderScheduleEntry(storeId, day, vendorId).catch((e: any) => {
      set({ orderSchedule: prev });
      notifyBackendError('Remove scheduled vendor', e);
    });
  }
},
```

(Pseudocode — frontend dev to land actual TS.)

### §7 — Apply-path matrix

Schema change is one migration. Apply paths:

| Environment | Path |
|---|---|
| Local dev (`npm run dev:db`) | `supabase migration new order_schedule_unique_per_cell` writes a stub; paste contents above; `supabase db reset` re-applies all migrations from clean. Confirm with `psql` or Studio that the constraint exists. |
| Production | Push migration via Supabase CLI: `supabase db push`. Migration is additive + idempotent (the dedup pass + ADD CONSTRAINT IF NOT EXISTS pattern). Safe to re-run. |
| CI | No CI workflow on disk per CLAUDE.md "CI workflow" — manual verification only. Backend dev to confirm migration applies cleanly against a local DB reset before pushing. |

**Realtime publication**: NOT changed in this spec. The
docker-restart gotcha does NOT apply.

### §8 — REST day enforcement design

**Affected UI elements** (REST day = `selectedDayCell.status ===
'rest'`):

| Element | Today | After spec 007 |
|---|---|---|
| Vendor pills (line 429) | clickable | clickable (need to keep navigation alive so the user can review what items would have been counted) |
| Category chips (line 468) | clickable | clickable (same rationale) |
| BOX/CASE input (line 562) | editable | `editable={false}`, opacity 0.5 |
| COUNT input (line 596) | editable | `editable={false}`, opacity 0.5 |
| Note input (line 625) | editable | `editable={false}`, opacity 0.5 |
| `+ COUNT` button (line 407) | enabled | `disabled` + `opacity: 0.4` |
| `SAVE DRAFT` button (line 410) | enabled | `disabled` + `opacity: 0.4` |
| `SUBMIT COUNT` button (line 413) | enabled | `disabled` + `opacity: 0.4` |
| `+ vendor` button (NEW) | n/a | enabled — admin can configure schedule even on REST days |

**Banner vs pill**: choose **inline pill on the right side of the
TabStrip's `rightSlot`**, NOT a top banner. Reasons:
1. `EODCountSection`'s top region is already busy (TabStrip on
   row 1, vendor + category filters on row 2-3, status line on
   row 4). A full-width banner would push the worksheet down 30+ px
   and make REST days feel structurally different in a noisy way.
2. The week sidebar already shows a `REST` pill (line 369-372) on
   the day cell. Echoing that with a matching pill near the date
   string in `rightSlot` keeps the visual language consistent.

Pill content: `REST DAY — no input` in the existing `StatusPill`
component style (`fg: C.warn`, `bg: C.warnBg`).

### §9 — `__all__` mode treatment

Already covered in §6. Architect-confirmed branch:

```ts
// Top of EODCountSection's render(), before the existing `<>`:
if (!currentStore?.id || currentStore.id === '__all__') {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg2 }}>
        Select a store to count inventory.
      </Text>
    </View>
  );
}
```

Note from probe 6: in normal navigation, `currentStore.id ===
'__all__'` should not happen because `setCurrentStore` redirects.
Treat the empty-state as defensive — also covers the brief moment
between login and `loadFromSupabase` settling, where
`currentStore.id` may be `''`.

### §10 — Verification probes (post-impl, manual)

To run from a browser pointed at local Supabase via `npm run dev:db`,
logged in as `admin@local.test`. No automated test framework — these
are smoke checks the test-engineer reviewer should walk through.

1. **Empty schedule, fallback to all-vendors.** Pick a store with no
   `order_schedule` rows. Open EOD count. Confirm vendor row shows
   all vendors with items (matches today's behavior).

2. **Add a single (store, day, vendor) cell.** Open
   `OrderScheduleSection`. Click the `(BJS, Thursday)` cell. Confirm
   the cell flips to "scheduled". Switch to EOD count, click
   Thursday in the week sidebar. Confirm vendor row shows BJS only.
   Click Friday. Confirm vendor row reverts to all-vendors (empty
   schedule for Friday → fallback). Click Wednesday. Same
   fallback.

3. **Wait — fallback semantics.** Re-read §2: fallback is per-store,
   not per-day. After step 2, `orderSchedule` for the store now has
   `Thursday: [BJS]` and other days `[]`. Per the §2 rule
   ("`scheduleConfigured = some day has rows`"), this means OTHER
   days will filter to `[]` (empty), not show all vendors. **Fix
   the spec contract here.** Two acceptable contracts:
    - **(a) Per-store fallback**: any store with at least one row
      is "configured" → empty days filter to empty (no vendors).
    - **(b) Per-day fallback**: each day independently checks; only
      days with NO rows fall back to all-vendors.
   The locked-in user answer Q3=(b) is "all-vendors-on-all-days
   fallback... stores with empty `order_schedule` preserve current
   behavior" — that argues for **(a) per-store**, since the unit
   the user thinks about is "the store's schedule". Once a store
   has any rows, days without rows mean "explicitly nothing
   delivers this day" rather than "not configured". Backend dev
   ship **(a)**. The "show unscheduled vendors" toggle (Q4=(d)) is
   the escape hatch for genuinely-empty days within a configured
   store — that's exactly what it's for.

   **Updated probe 3**: After step 2, click Friday. Vendor row is
   empty (per fallback (a)). Click "show unscheduled vendors"
   toggle. Vendor row expands to all vendors.

4. **`__all__` mode empty state.** Use store-picker to land on
   `__all__` if reachable (DB inspector or palette). Confirm
   `EODCountSection` renders the "Select a store to count
   inventory." message and no vendor row.

5. **REST day read-only.** Mark a day's `eod_submission` such that
   the day's `status === 'rest'` (today this status is computed
   client-side; if no path exists to force it, stub the week-cell
   data temporarily). Confirm the worksheet shows the vendor row
   but the inputs and bottom-bar action buttons are all disabled,
   and the REST DAY pill shows in the TabStrip rightSlot.

6. **Optimistic + revert.** Force a revert by temporarily breaking
   the RLS policy (or running as a non-admin user). Click `+ vendor`
   inline, pick a vendor — the pill should appear briefly, then
   disappear with a toast saying "Add scheduled vendor failed:
   ...". Same for remove.

### §11 — Architect-level open flags (recommendations)

1. **Unique constraint on `(store_id, day_of_week, vendor_id)`?**
   **YES — ship in §1 migration.** The new admin section's per-cell
   toggle needs idempotent inserts; without the constraint, a
   double-click race or stale local state would write duplicates.
   The dedup pre-pass handles legacy duplicates safely.

2. **`OrderScheduleSection` placement in sidebar?**
   **Top-level under "Planning" group, NOT nested under a Settings
   sub-group.** The Cmd UI doesn't currently have a "Settings"
   sub-group, and "Order schedule" is a planning artifact (matches
   the rest of that group: Vendors, Categories, Recipes, Restock).
   Inserting it after `Categories` and before `Recipes` keeps the
   group ordered by frequency-of-use.

3. **Inline `+ vendor` picker UX — dropdown / drawer / modal?**
   **Modal**. The Cmd UI already has `AddCountModal` (used at
   `EODCountSection.tsx:684`) as the precedent for "pick a thing
   from a list" — match that pattern. A dropdown is too cramped
   when the brand has many vendors; a side drawer is overkill and
   obscures the worksheet. The modal can reuse `AddCountModal`'s
   shape (search + scrollable list + click-to-select-and-close).
   Backend has no opinion on the picker; flag for frontend dev to
   adapt the existing modal pattern.

### §12 — Risks and tradeoffs

- **RLS write gate.** `auth_is_admin()` requires JWT
  `app_metadata.role` ∈ `{admin, master}`. The placeholder
  `useRole` returns `'admin'` for everyone client-side
  (CLAUDE.md), but the JWT check is server-side. Real users with
  a 'user' role will see the UI controls but their writes will
  fail with an RLS error → caught by `notifyBackendError` toast.
  This is correct behavior (the schedule should be admin-managed)
  but the UI should ideally hide the `+ vendor` button for
  non-admins. **Recommendation: defer that polish to a follow-up
  spec.** Spec 007 ships with the toast as the gate.

- **`__all__` defensive branch is mostly dead code.** Per probe 6,
  `setCurrentStore` redirects away from `__all__` before
  `currentStore.id` ever lands at it. The branch is cheap insurance
  against future changes.

- **Realtime divergence between tabs.** Documented in §5. Acceptable
  for v1.

- **TitleCase day key is unenforced at the DB level.** `day_of_week`
  is `text not null` with no check constraint. The constraint
  contract is enforced only in app code. If a future caller writes
  `'monday'` lowercase, the schedule for that day will be invisible
  to `EODCountSection`'s reader. **Mitigation: a check constraint
  could be added** (`check (day_of_week in ('Monday','Tuesday',...))`)
  but is out of scope for Spec 007. Backend dev: surface as a
  followup-tickets candidate.

- **Performance.** `order_schedule` rows are bounded by
  `(stores) * 7 days * (vendors per store)` — at most a few hundred
  rows total for a single-tenant brand. The 286 KB seed has zero
  contribution to query cost here. No concern.

- **Cold start.** No edge function changes. Bind-mount gotcha
  (CLAUDE.md "Local edge runtime bind-mount") does NOT apply.

- **Migration ordering.** The new migration depends on
  `order_schedule` existing, which is created in
  `20260424211732_recover_undeclared_tables.sql`. The new file's
  timestamp is later, so ordering is satisfied automatically.
  No interaction with the brand-catalog refactor migrations.

## Build notes

### Backend pass (2026-05-06)

**Probe 1 — pre-migration row counts (local).**
```
total rows in order_schedule              = 0
per-store distribution                    = (0 rows)
duplicate (store_id, day_of_week, vendor_id) groups = 0
```
Local DB carries no `order_schedule` rows, so the dedup pre-pass was a
no-op. A NOTICE in the migration ("`spec007: deduped 0 duplicate
order_schedule rows...`") makes the count observable on apply for prod.

**Pre-existing schema state observed via `\d order_schedule`** (worth
flagging for reviewers; surfaced as deviation from the architect's §1
assumptions):
- `delivery_day` is `text NOT NULL` (set in
  `20260502071736_remote_schema.sql:101`). Architect's §3a helper signature
  has `deliveryDay?: string` optional. Resolved by defaulting to the
  `day` argument when caller omits it — keeps the architect's signature
  and the table's NOT NULL contract both honest.
- `vendor_name` is `text NOT NULL`. Already required by architect's
  helper signature, no change needed.
- A pre-existing unique constraint
  `order_schedule_store_id_day_of_week_vendor_name_key` already covers
  the `(store_id, day_of_week, vendor_name)` grain. The new constraint
  added by Spec 007's migration sits at the `(..., vendor_id)` grain —
  the two coexist; both backing indexes are kept.
- `order_schedule` is **already** in the `supabase_realtime` publication.
  Architect §5 said no realtime changes needed for this spec — confirmed,
  no docker-restart gotcha applies.

**Migration**:
`supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`
(85 lines).

Local apply output:
```
BEGIN
NOTICE:  spec007: deduped 0 duplicate order_schedule rows at (store_id, day_of_week, vendor_id) grain
DO
NOTICE:  spec007: added unique constraint order_schedule_store_day_vendor_unique
DO
COMMIT
```

Recorded as applied via
`insert into supabase_migrations.schema_migrations (version, name)
values ('20260507214842', 'spec007_order_schedule_unique')`. Direct SQL
apply was used instead of `npx supabase migration up --include-all`
because that path also pulls Specs 005/006/003 into the apply set, and
Spec 006's idempotency assertion currently fails on this branch's local
DB (pre-existing, unrelated to Spec 007). Backend dev surfaced this for
the release-coordinator's awareness — not blocking for Spec 007.

Prod is **NOT** pushed. `supabase db push --linked` is a separate
user-authorized gate (mirroring Specs 003 + 006).

Post-apply `\d order_schedule` confirms both unique constraints:
```
Indexes:
    "order_schedule_pkey" PRIMARY KEY, btree (id)
    "order_schedule_store_day_vendor_unique" UNIQUE CONSTRAINT,
        btree (store_id, day_of_week, vendor_id)
    "order_schedule_store_id_day_of_week_vendor_name_key" UNIQUE
        CONSTRAINT, btree (store_id, day_of_week, vendor_name)
```

End-to-end smoke against the constraint (psql, with a real store +
vendor from the seed):
- INSERT → 1 row added.
- Duplicate INSERT at `(store, day, vendor_id)` → SQLSTATE 23505
  unique_violation as expected (the helper swallows this code as a
  no-op).
- DELETE by `(store, day, vendor_id)` → 1 row removed; `count(*) = 0`.

**`src/lib/db.ts`** — two new exports added immediately below
`saveOrderSchedule` (line 1531+):
- `addOrderScheduleEntry(storeId: string, day: string,
  vendor: { vendorId: string; vendorName: string; deliveryDay?: string })
  : Promise<void>` — `INSERT` with PG error code 23505 swallowed for
  idempotent no-op against the new unique constraint.
- `removeOrderScheduleEntry(storeId: string, day: string,
  vendorId: string): Promise<void>` — `DELETE` by triple; idempotent
  (no row affected → no error).

`fetchOrderSchedule` and `saveOrderSchedule` left untouched — legacy
`AdminScreens.tsx` continues to call into the bulk replace path.

**`src/store/useStore.ts`** — two new actions added next to
`setOrderSchedule` (line ~1043+) using the optimistic-then-revert
+ `notifyBackendError` shape from `addIngredientConversion`:
- `addOrderScheduleEntry(day, { vendorId, vendorName, deliveryDay? })`
- `removeOrderScheduleEntry(day, vendorId)`

**Naming deviation from architect §6** (intentional, surfaced for
review): architect proposed `addScheduledVendor` /
`removeScheduledVendor` for the store actions. Backend dev chose
`addOrderScheduleEntry` / `removeOrderScheduleEntry` to mirror the
`db.ts` helper names exactly — fewer name-pair surfaces to remember
and matches the spec's existing verb pattern (`setOrderSchedule`,
`saveOrderSchedule`). Frontend dev should call
`useStore.getState().addOrderScheduleEntry(...)` /
`removeOrderScheduleEntry(...)`. If reviewers prefer the architect's
names, this is a one-line rename in two interface entries + two
implementations.

**`src/types/index.ts`** — no change. `OrderSchedule` and
`OrderDayVendor` already exist (lines 328-336) and the new helpers'
input shapes use the existing `OrderDayVendor` field names
(`vendorId`, `vendorName`, `deliveryDay`).

**`src/hooks/useRealtimeSync.ts`** — no change (per architect §5).

**STOP conditions hit** — none of the brief's listed STOP triggers
fired:
- Dedup count was 0, well under any "unexpectedly many" threshold.
- `useStore.orderSchedule` slice already exists and is populated by
  `fetchOrderSchedule` via `loadFromSupabase`.
- The existing `saveOrderSchedule` already writes TitleCase
  `day_of_week` strings (verified via the `OrderSchedule` type +
  `useStore.ts:182-184` baseline). No data normalization pre-pass
  needed.

The `delivery_day NOT NULL` discovery was a soft mismatch with the
architect's helper signature, not a STOP condition — resolved inline
by defaulting to the `day` argument when callers omit `deliveryDay`.

### Frontend pass (2026-05-06)

**Reused the backend dev's action names.** Backend dev landed the store
actions as `addOrderScheduleEntry` / `removeOrderScheduleEntry` (instead
of architect §6's proposed `addScheduledVendor` /
`removeScheduledVendor`); frontend slice calls those exact names.
Symmetric with `db.ts` helper names — fewer name surfaces to remember.
Spec's deviation note already captures the rename.

**Day-of-week derivation.** Used
`DAY_NAMES[new Date(selectedIso + 'T00:00:00').getDay()]`, anchoring to
local midnight so day-of-week math doesn't wobble across timezones. Day
key format = TitleCase, matching the `useStore.orderSchedule` baseline
keys (Probe 5 in `## Backend design` §0).

**Per-store fallback semantics** (architect §10 step 3 clarification):
`scheduleConfigured = Object.values(orderSchedule).some(arr => arr.length
> 0)`. If false, the day filter is bypassed entirely (Q3=(b) — no
regression for stores that have never opened the schedule admin). If
true, days without rows render an empty vendor row with copy
"no vendors scheduled for &lt;day&gt;". The "show unscheduled vendors"
toggle covers genuinely-empty days within a configured store (Q4=(d)).

**REST day enforcement** (§8): selected day's `status === 'rest'` flips
all count-input cells to `editable={false}` + opacity 0.5, and disables
"+ COUNT" / "SAVE DRAFT" / "SUBMIT COUNT" with opacity 0.4 +
`pointerEvents: 'none'` on web. Vendor + category navigation stays
clickable per §8's pinned UX. The "REST DAY — NO INPUT" pill is
rendered in the `TabStrip` rightSlot, not as a top banner — matches
the existing rest pill in the week sidebar's per-day cell.

**`__all__` empty state** (§9): early return placed AFTER all `React.use*`
hooks so hook order stays stable across renders. Same defensive guard
also covers `currentStore.id === ''` which can briefly occur between
login and `loadFromSupabase` settling.

**Inline `+ vendor` modal** (§11.3): new
`src/components/cmd/AddVendorScheduleModal.tsx`, modeled directly on
`AddCountModal` — same 14% top-padding overlay, same ↑↓⏎ keyboard
wiring, same meta strip + footer pattern. Lists vendors from
`useStore.vendors` minus those already in `dayScheduledVendorIds`.
Brand-scoping is implicit because `useStore.vendors` is already
brand-filtered at load.

**Show-unscheduled toggle**: small chip-style button on the same row
as the vendor pills, with a checkbox-style indicator (filled when on).
Hidden when `!scheduleConfigured` because the toggle would be a no-op
(the filter already isn't constraining anything).

**Inline remove "×"**: subtle 7px-padded button appended inside each
vendor pill, only visible when the vendor IS scheduled today AND
schedule is configured. Calls `removeOrderScheduleEntry` directly. Same
optimistic-then-revert path as the modal's add.

**OrderScheduleSection grid**: rows = `useStore.vendors` sorted
alphabetically. Cols = Mon–Sun (TitleCase). Each cell is a 22px square
checkbox; click toggles `addOrderScheduleEntry` / `removeOrderScheduleEntry`.
Uses ALL vendors (not "vendors with items at this store") because the
schedule is a planning concept — a vendor with no items today might
still be on the schedule for a forecast/seasonal item. Empty-state copy
when `vendors.length === 0` points at the Vendors section.

**Sidebar wiring**: `OrderSchedule` slot inserted in the Planning group
between Categories and Recipes (per architect §11.2). Dispatch branch
added to the section-switch chain. Resetting `selectedName` on section
change happens at the layout root and isn't affected.

**Verification gap (preview tools).** This session does NOT have the
`preview_*` MCP tools loaded — only the Bash/Read/Edit/Write toolkit
and the running expo-web dev server on `localhost:8082`. CLAUDE.md /
the user's brief calls for a browser-driven smoke walk; reviewers and
the user must perform the live walkthrough. As fallback verification:
- `npx tsc --noEmit` returns 149 errors total (matches the project's
  pre-existing baseline; zero net-new errors from this slice).
- The web bundle compiles cleanly: GET
  `/node_modules/expo/AppEntry.bundle?platform=web&...` returns 200 with
  ~11.7 MB body, including `OrderScheduleSection`, `EODCountSection`,
  and `AddVendorScheduleModal` symbols (`grep` confirmed). No
  `Module build failed` / `SyntaxError` markers in the bundle output.
- All hook calls confirmed at the top of each component (above any
  early returns) — Rules of Hooks satisfied.

**Manual browser walkthrough left for reviewers** (golden path + edges):
1. Login `admin@local.test / password`. EOD count default day shows
   all vendors (no `order_schedule` rows yet → fallback to all-vendors).
2. Sidebar → Order schedule. Click `(BJS, Thursday)` cell → ✓ appears.
3. Back to EOD count, pick Thursday → vendor row shows BJS only.
4. Pick Friday → vendor row empty with "no vendors scheduled for friday"
   copy. Click "show unscheduled vendors" → row expands to all vendors.
5. Click the "×" on BJS pill on Thursday → BJS removed from Thursday.
6. Click "+ vendor" → modal opens; pick a vendor → it appears in row,
   modal closes, vendor auto-selected.
7. Force `currentStore.id === '__all__'` (DB inspector or palette) →
   "Select a store to count inventory." renders.
8. Pick a REST day in the week sidebar (any 7-days-ago day with no
   submission) → REST DAY pill in TabStrip rightSlot, count cells
   disabled, action buttons grayed out.
9. Order Schedule with `__all__` selected → "Select a store to manage
   order schedule." renders.

### Fix-pass (2026-05-07) — TZ-crossing day-of-week bug

**Bug.** Reproduced at Thu May 7 2026 22:04 EDT (UTC-4). The EOD section
header correctly displayed "Thursday, May 7" and the rail's TODAY pill sat
on Thursday. After adding a `(BJs, Thursday)` row in the Order schedule
admin grid, navigating to EOD count → Thursday rendered the empty state
"no vendors scheduled for **friday**" instead of showing BJs. The filter
was searching `day_of_week = 'Friday'` while the user saw Thursday
everywhere else.

**Root cause.** `selectedIso` and the rail's per-day `iso` strings were
both built via `new Date().toISOString().slice(0, 10)`, which returns the
**UTC date**, not the user's local date. At 22:04 EDT the same instant is
already 02:04 UTC on May 8 — so `selectedIso = '2026-05-08'`. Downstream,
`new Date(selectedIso + 'T00:00:00').getDay()` parses that as local
midnight Friday and yields `'Friday'`, while the rail's *display* day
name uses `d.getDay()` directly on the local Date object and correctly
yields `'Thursday'`. The two paths disagreed by one day across the local
midnight ↔ UTC midnight boundary.

**Fix.** Added a `localDayIso(d: Date)` helper at the module level that
formats `YYYY-MM-DD` from the Date's **local** components
(`getFullYear / getMonth / getDate`). Replaced every
`...toISOString().slice(0, 10)` call in `EODCountSection.tsx` with
`localDayIso(...)`:

- `selectedIso` initial state (line ~71)
- Rail builder's `todayIso` and per-cell `iso` (lines ~133, ~138)
- `EODHistoryTab`'s `ninetyDaysAgo` (line ~933)
- `EODCountTodayTab`'s `todayStr` (line ~1015)

The existing `selectedDayName` derivation
(`new Date(selectedIso + 'T00:00:00').getDay()`) is now correct because
`selectedIso` is the local-day string — `'2026-05-07'` parses as local
midnight Thursday and yields `getDay() === 4 → 'Thursday'`.

The full-timestamp `now = new Date().toISOString()` at line ~269
(submission `timestamp` field) was left untouched — that's a real
timestamp, not a date-only string, and UTC encoding is correct there.

**Pattern selection.** The user's brief offered two patterns; this
implements **Pattern B** (local-day iso strings everywhere in the
component). Pattern A as described (`+ 'T12:00:00'` on a UTC iso string)
does NOT fix the bug — `new Date('2026-05-08T12:00:00')` still parses as
Friday May 8 local. The underlying issue is that the iso string itself
encodes the wrong day; midday-anchoring only protects against DST/leap
edge cases on a correctly-formed local-day string, which we now have.

**Verification (script-level — no preview MCP tools in this session).**
Simulated the bug instant in node with `TZ=America/New_York` and
`fakeNow = new Date('2026-05-08T02:04:00Z')`:
- OLD `toISOString().slice(0,10)` → `'2026-05-08'` → derived `'Friday'`
  (confirms the original bug).
- NEW `localDayIso(fakeNow)` → `'2026-05-07'` → derived `'Thursday'`
  (confirms the fix).
- Rail at i=0 (today): iso=`'2026-05-07'`, dayName=`'Thursday'` ✓
- Rail at i=1 (yesterday): iso=`'2026-05-06'`, dayName=`'Wednesday'` ✓

Bundle compiles cleanly: GET
`/node_modules/expo/AppEntry.bundle?platform=web&dev=true` → 200,
13.7 MB body, `localDayIso` symbol present at 6 sites (declaration + 5
call sites), no `Module build failed` / `SyntaxError` markers in the
bundle output. `npx tsc --noEmit` reports zero EODCountSection errors
(the project's pre-existing 149-error baseline is unchanged for the
modified file).

**Live browser walkthrough left for reviewers / user.** This session has
no `preview_*` MCP tools loaded — same verification gap as the original
frontend pass. Reviewers and the user must walk:

1. Reload `localhost:8082` (login cached as `admin@local.test`). At
   evening EDT, navigate EOD count → Thursday cell selected by default.
   Vendor row should show **BJs only** (the test schedule row).
2. Click "show unscheduled vendors" → row expands to all 10 vendors.
3. Click "show unscheduled vendors" again → row collapses back to BJs.
4. Click Wednesday May 6 in the rail → vendor row empty with copy
   "no vendors scheduled for wednesday".

**Test data.** The `(Towson, Thursday, BJs)` row in `order_schedule` was
added as part of the bug repro and is left in place per the user's
cleanup note — it's the test data for this verification, lives on local
DB only.

**Cross-cutting drift to flag.** `submitEODCount` in
[src/lib/db.ts:311](src/lib/db.ts:311) re-parses the submitted
`submission.date` via `new Date(date).toISOString().split('T')[0]`. With
the previous UTC-based `selectedIso`, this round-trip was a no-op
(`'2026-05-08'` → UTC midnight → `'2026-05-08'`). With the new local-day
`selectedIso`, the round-trip is also stable (`'2026-05-07'` → UTC
midnight Wed May 7 (local Tue 18:00 EDT, but UTC string is unchanged) →
`'2026-05-07'`). No backend change required.

**Files modified in this fix-pass.**
- `src/screens/cmd/sections/EODCountSection.tsx` — added `localDayIso`
  helper + replaced 5 UTC-iso slice sites.
- `specs/007-eod-vendor-day-filter.md` — this `### Fix-pass`
  subsection.

## Files changed

### Backend slice

- `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`
  (NEW, 85 lines) — dedup pre-pass + unique constraint on
  `(store_id, day_of_week, vendor_id)`. Idempotent.
- `src/lib/db.ts` — added `addOrderScheduleEntry` and
  `removeOrderScheduleEntry` exports below the existing
  `saveOrderSchedule`.
- `src/store/useStore.ts` — added `addOrderScheduleEntry` and
  `removeOrderScheduleEntry` to the `StoreActions` interface and
  implemented both as optimistic-then-revert actions next to
  `setOrderSchedule`.

### Frontend slice

- `src/screens/cmd/sections/EODCountSection.tsx` — added day-of-week
  derivation, `scheduleConfigured` per-store fallback flag,
  `dayScheduledVendorIds` set, vendor-tab filter wiring, "show
  unscheduled vendors" toggle, inline `+ vendor` button, inline "×"
  remove affordance per scheduled-today pill, REST day input/action
  disable, "REST DAY — NO INPUT" pill in TabStrip rightSlot, and
  `__all__`/empty-store-id defensive empty-state branch. Calls
  `useStore.addOrderScheduleEntry` / `removeOrderScheduleEntry`.
- `src/screens/cmd/sections/OrderScheduleSection.tsx` (NEW) — weekly
  grid admin UI for `order_schedule`. Rows = vendors sorted
  alphabetically; cols = Mon–Sun. Per-cell ✓ toggle wires
  `addOrderScheduleEntry` / `removeOrderScheduleEntry`. Top bar in the
  same rhythm as `CategoriesSection`. Defensive `__all__` empty state.
- `src/components/cmd/AddVendorScheduleModal.tsx` (NEW) — vendor picker
  modal modeled on `AddCountModal`. Lists vendors from
  `useStore.vendors` minus already-scheduled-for-(store, day). ↑↓⏎
  keyboard wiring on web; click-to-select on native.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — imported
  `OrderScheduleSection`, added `OrderSchedule` entry to the Planning
  sidebar group between Categories and Recipes, added the
  `section === 'OrderSchedule'` dispatch branch.

### Pre-push cleanup (2026-05-07)

- `src/screens/cmd/sections/EODCountSection.tsx:617-633` — wired the
  `+ vendor` button's `disabled={showUnscheduled}` prop and
  `opacity: 0.4` style. The inline comment at lines 613-616 promised
  this behavior; the prop wasn't actually wired. Two-line fix per
  release-coordinator's recommended cleanup bundle. Verified in
  browser: opacity 1 (enabled) → 0.4 (disabled) on toggle ON; clicks
  blocked when disabled.

## Apply log + post-apply verification (2026-05-07, user-authorized push)

User authorized `npx supabase db push --linked` on 2026-05-07 after
the reviewer fan-out returned 0 Critical across all four reviewers and
release-coordinator returned SHIP_READY.

```
Applying migration 20260507214842_spec007_order_schedule_unique.sql...
NOTICE (00000): spec007: deduped 0 duplicate order_schedule rows at (store_id, day_of_week, vendor_id) grain
NOTICE (00000): spec007: added unique constraint order_schedule_store_day_vendor_unique
Finished supabase db push.
```

Migration applied without error against project `ebwnovzzkwhsdxkpyjka`.
The dedup pre-pass found 0 duplicates on prod (clean data); the
constraint addition succeeded.

### Post-apply verification probes — all PASS

Run via the Supabase MCP `execute_sql` tool against project
`ebwnovzzkwhsdxkpyjka` immediately after push.

| Probe | Expected | Actual | Status |
|---|---|---|---|
| `order_schedule_store_day_vendor_unique` constraint exists | true | true | PASS |
| `order_schedule` row count (informational) | — | 26 | — |
| migration version `20260507214842` registered | true | true | PASS |

The 26 existing `order_schedule` rows were preserved (no dedup deletes
needed). The unique constraint is now live on prod and will reject
duplicate `(store_id, day_of_week, vendor_id)` inserts going forward.

### Status flip

`Status: READY_FOR_BUILD` → `Status: READY_FOR_REVIEW`. (Project
convention: `Status:` flips to READY_FOR_REVIEW after prod apply +
post-apply verification, mirroring Specs 003 + 006.)

## Handoff
next_agent: backend-developer, frontend-developer
prompt: |
  Implement Spec 007 against the design in `## Backend design`.
  Split ownership:

  **Backend developer**:
  - New migration `<TS>_order_schedule_unique_per_cell.sql` per §1
    (dedup pass + unique constraint). Run probe 1 before writing.
  - New helpers `addOrderScheduleEntry` and
    `removeOrderScheduleEntry` in `src/lib/db.ts` per §3.
  - New actions `addScheduledVendor` and `removeScheduledVendor` in
    `src/store/useStore.ts` per §6 (optimistic-then-revert with
    `notifyBackendError`).
  - DO NOT modify `useRealtimeSync.ts` (per §5).
  - DO NOT touch `saveOrderSchedule` / `setOrderSchedule` (legacy
    write path stays intact for `AdminScreens.tsx`).
  - DO NOT touch `app.json` slug, `useSupabaseStore.ts`,
    `useJsonServerSync.ts`, `db.json`, or `AdminScreens.tsx`.

  **Frontend developer**:
  - Update `src/screens/cmd/sections/EODCountSection.tsx` per §6:
    vendor row filter (with per-store fallback per §10 step 3
    clarification), REST day read-only enforcement per §8, `__all__`
    empty state per §9, inline `+ vendor` button (modal picker per
    §11.3) and remove-vendor "×" affordance, "show unscheduled
    vendors" toggle.
  - NEW `src/screens/cmd/sections/OrderScheduleSection.tsx` —
    weekly grid of (vendor, day) toggles per §6. Reuses the new
    useStore actions from backend dev.
  - Update `src/screens/cmd/InventoryDesktopLayout.tsx` to register
    the new section in the Planning sidebar group + dispatch.
  - DO NOT modify `AdminScreens.tsx`, `IngredientsScreen.tsx`,
    `app.json` slug, or any legacy data layer file.

  After implementation: set `Status: READY_FOR_REVIEW` and list
  changed files under `## Files changed`.
payload_paths:
  - specs/007-eod-vendor-day-filter.md
