# Spec 081: Dashboard attention-queue `unconfirmed_po` shows each card its own store's missed orders

Status: READY_FOR_REVIEW

## Problem / context

On the admin Dashboard (`src/screens/cmd/sections/DashboardSection.tsx`), the
per-store "Attention Queue" cards render the `unconfirmed_po`
("VENDOR order missed (DATE)") rows from the **currently-focal store's** order
schedule and submissions — not each card's own store. On a multi-store
dashboard every store card therefore shows a near-identical "order missed"
list (this was visible in the original spec-074 screenshot: all four store
cards showed the same vendor/date misses).

### Root cause (grounded — confirmed by reading the code)

- `DashboardSection.tsx:281-298` — the per-store loop calls
  `computeAttentionQueue(s.id, inventory, allEod, allPos, orderSubmissions, orderSchedule, stores, getItemStatus, timezone)` for **every** store `s`,
  but passes the FOCAL-store slices `orderSubmissions` (line 117, from
  `useStore`) and `orderSchedule` (line 118, from `useStore`) **unchanged** to
  every card.
- `orderSchedule` in the store (`src/store/useStore.ts:514`) is a
  `Record<weekday, Vendor[]>` — it has **no store dimension** — so
  `computeAttentionQueue` literally cannot filter it by `s.id`. Every card's
  `unconfirmed_po` derives from the focal store's weekday schedule.
- `orderSubmissions` in the store is the focal store's submissions only
  (populated by `loadFromSupabase` at `useStore.ts:1017`). The
  `unconfirmed_po` block in `cmdSelectors.ts:890-895` does filter by
  `o.storeId === storeId`, but the slice only *contains* the focal store's
  rows, so non-focal cards match nothing and over-report misses against the
  focal store's schedule.

### The fix pattern already exists in the same file

`eod_missing`, `low_out_stock`, `food_cost_streak`, and `expiry` are all
correct per-store today:
- `allEod` / `allPos` (`DashboardSection.tsx:150-189`) are fetched cross-store
  via `db.fetchEodSubmissionsForStores` / `db.fetchPosImportsForStores` into
  component-local state and merged with the focal slice.
- `inventory` is the full multi-store array (the live dashboard shows
  per-store-varying out-of-stock counts, e.g. 142/143), so the inventory-keyed
  rules filter correctly by `storeId`.

`unconfirmed_po` simply never got the same cross-store treatment. This spec
gives it that treatment.

## User story

As a multi-store manager on the admin Dashboard, I want each store card's
"order missed" list to reflect **that store's own** vendor schedule and order
submissions, so that I can tell at a glance which specific store missed which
vendor order — instead of seeing the focal store's misses cloned onto every
card.

## Acceptance criteria

- [ ] A new read helper `db.fetchOrderScheduleForStores(storeIds: string[])`
      returns a **store-indexed** schedule (e.g. `Record<storeId,
      OrderSchedule>`), queries `order_schedule` with `.in('store_id',
      storeIds)`, chains `.abortSignal(signal)` inside
      `useInflight.getState().track(..., { kind: 'read', label:
      'fetchOrderScheduleForStores' })`, and returns `{}` (or empty per the
      architect's chosen shape) when `storeIds.length === 0`. Mirrors the
      single-store `fetchOrderSchedule` (`db.ts:3401`) row→object mapping
      (`vendorId`, `vendorName`, `deliveryDay`) and the
      `fetchEodSubmissionsForStores` / `fetchPosImportsForStores` cross-store
      shape.
- [ ] A new read helper `db.fetchOrderSubmissionsForStores(storeIds: string[],
      sinceDate: string)` returns the order submissions for all passed stores
      since `sinceDate`, queries with `.in('store_id', storeIds)`, chains
      `.abortSignal(signal)` inside `track(..., { kind: 'read', label:
      'fetchOrderSubmissionsForStores' })`, and returns `[]` when
      `storeIds.length === 0`. Each returned row carries `storeId`, `date`,
      `vendorName` (and `vendorId` if present) so the existing
      `unconfirmed_po` schedule-vs-submission predicate
      (`cmdSelectors.ts:890-895`) matches unchanged.
- [ ] `DashboardSection` holds the results of both new helpers in
      component-local state, fetched in a `useEffect` keyed on
      `stores.map(s => s.id).join(',')` + `currentStore.id` (mirroring the
      existing cross-store EOD/POS effect at `DashboardSection.tsx:153-177`),
      with the same `cancelled` guard and `console.warn` catch.
- [ ] The per-store attention-queue loop (`DashboardSection.tsx:281-298`)
      passes **each store its own** schedule and submissions into
      `computeAttentionQueue(s.id, ...)` — never the focal-store slices for a
      non-focal card.
- [ ] On a dashboard with ≥ 2 stores that have *different* order schedules
      and/or different missed orders, each store card's `unconfirmed_po` rows
      reflect that card's store only. Two stores with different misses no
      longer show identical "order missed" lists.
- [ ] The focal store's card continues to reflect realtime updates to its own
      schedule/submissions (focal slice merged over the cross-store fetch, same
      pattern as `allEod`/`allPos` at `DashboardSection.tsx:181-189`), to the
      extent the architect adopts the merge for these slices.
- [ ] The other four attention rules (`eod_missing`, `low_out_stock`,
      `food_cost_streak`, `expiry`) are unchanged in behavior and output.
- [ ] Existing jest suite stays green:
      `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` (8 tests) and
      `src/utils/weekWindow.test.ts`. If the architect changes
      `computeAttentionQueue`'s signature, these callers are updated in lockstep
      and still assert the spec-074 Monday-reset window behavior.
- [ ] No regression to the spec-074 Monday-reset window semantics: today is
      still excluded; only this work-week's (store-tz) missed orders show.

## In scope

- New cross-store read helpers in `src/lib/db.ts`:
  `fetchOrderScheduleForStores` and `fetchOrderSubmissionsForStores`.
- Wiring those into `DashboardSection` component-local state + passing the
  correct per-store slice into each `computeAttentionQueue(s.id, ...)` call.
- Whichever of these two the architect picks (this is the core design choice):
  - **(A)** Change `computeAttentionQueue`'s signature to accept a per-store
    schedule + submissions (and update the jest callers), OR
  - **(B)** Keep the signature; have the `DashboardSection` loop index a
    store-keyed map and pass the right slice per iteration.
- Optional: a new jest test asserting the per-store **wiring** (each card gets
  its own store's schedule/submissions) — see Open Questions Q4.

## Out of scope (explicitly)

- The spec-074 Monday-reset window math itself — unchanged; this is a
  data-plumbing fix, not a logic change. Rationale: the windowing is already
  pinned by 8 deterministic jest tests and is correct.
- Per-store timezone — the queue still anchors on the single brand-global
  `timezone` (`DashboardSection.tsx:127`). Per-store tz is a separate
  follow-up, same as noted in spec 074.
- A real `purchase_orders.confirmed/status` field — `unconfirmed_po` still
  means "scheduled vendor with no matching submission" per Decision D6;
  deprecating this rule for a real PO-confirmation schema stays a future spec.
- Realtime subscription to all stores' `order_schedule` / `order_submissions`
  channels — the new loaders inherit the existing mount + `currentStore.id`
  refresh caveat (D2 / R4). Promoting to subscribed-to-all-store-channels is a
  follow-up if it bites, same as the EOD/POS precedent.
- Building the spec-080 E2E itself — this spec **un-blocks** it but does not
  build it (see Dependencies).
- Any change to the focal-store `orderSchedule` / `orderSubmissions` slices in
  `useStore.ts` or their `loadFromSupabase` population — the cross-store data
  lives in component-local state, not the store, matching the EOD/POS
  precedent.

## Open questions resolved

- Q: Is `unconfirmed_po` the ONLY focal-contaminated attention rule, or are
  `low_out_stock` / `expiry` / `food_cost_streak` / `eod_missing` also broken?
  → A (PM, confirmed by reading `cmdSelectors.ts` + `DashboardSection.tsx`):
  **Only `unconfirmed_po` is broken.** `eod_missing` and `food_cost_streak`
  read the cross-store `allEod`/`allPos`; `low_out_stock` and `expiry` filter
  the full multi-store `inventory` array by `storeId` (corroborated by the
  live per-store-varying out-of-stock counts 142/143). `unconfirmed_po` is the
  only rule that reads the store-dimensionless `orderSchedule` plus the
  focal-only `orderSubmissions` slice. **Scope is exactly `unconfirmed_po`** —
  there is no phantom inventory issue to chase. The architect should re-confirm
  during design and say so explicitly if anything contradicts this.
- Q: Is there a migration? → A: **No.** This is frontend + `db.ts` read
  helpers only. `order_schedule` and `order_submissions` (the source tables
  for the single-store `fetchOrderSchedule` and the focal `orderSubmissions`
  slice) already exist. No schema change.

## Open questions for the architect (real design surface — resolve in design mode)

1. **Signature vs caller-side (the core decision).** `orderSchedule` is
   weekday-keyed with no store dimension, so the cross-store version MUST be
   store-indexed somewhere. Either (A) change `computeAttentionQueue`'s
   signature to take a per-store schedule + submissions — blast radius: the 8
   jest callers in `cmdSelectors.unconfirmedPoWindow.test.ts` (all route
   through the `runQueue` helper, so the update is localized) — OR (B) keep the
   signature and have the `DashboardSection` loop index a store-keyed map
   (`Record<storeId, OrderSchedule>` + pre-filtered submissions) and pass the
   right slice per iteration. The architect picks and pins the type.
2. **Store-indexed schedule type.** If (A): what is the precise type the helper
   returns and the selector accepts — `Record<storeId, OrderSchedule>`, or a
   pre-filtered `OrderSchedule` per call? If (B): does
   `fetchOrderScheduleForStores` return `Record<storeId, OrderSchedule>` and
   the loop dereferences `byStore[s.id]`? Name the canonical shape.
3. **Realtime caveat acceptable?** The existing cross-store EOD/POS only refresh
   on mount + `currentStore.id` change (the D2/R4 comment at
   `DashboardSection.tsx:144-149`). The new schedule/submissions loaders inherit
   the same caveat. PM read: almost certainly acceptable — match the
   established pattern. Confirm.
4. **`sinceDate` window for submissions.** The existing cross-store fetchers use
   a 14-day lookback (`DashboardSection.tsx:158`). The `unconfirmed_po` rule
   only looks back to this week's Monday (≤ 7 days). Architect: reuse the same
   14-day `since` for symmetry, or scope the submissions fetch to the
   work-week window? (PM lean: reuse 14-day `since` for simplicity; the
   selector's window filter trims anyway.)

## Dependencies

- Existing cross-store loaders to mirror: `db.fetchEodSubmissionsForStores`
  (`src/lib/db.ts:719`), `db.fetchPosImportsForStores` (`src/lib/db.ts:1005`).
- Existing single-store loader whose row mapping to mirror:
  `db.fetchOrderSchedule` (`src/lib/db.ts:3401`).
- The pure selector under change/wiring: `computeAttentionQueue`
  (`src/lib/cmdSelectors.ts:740-975`).
- The consuming UI: `DashboardSection` (`src/screens/cmd/sections/DashboardSection.tsx`).
- The `useInflight` track + `.abortSignal()` discipline (db.ts header note,
  lines 4-25) — every new helper must comply.
- **Un-blocks spec 080** (`specs/080-e2e-dashboard-attention-queue-window.md`,
  currently `Status: DEFERRED`). Spec 080's E2E asserts the spec-074-windowed
  `unconfirmed_po` result renders in the real `DashboardSection` against
  DB-loaded slices. Today that E2E is non-deterministic / not meaningful on a
  multi-store dashboard because every card shows the focal store's data;
  **once 081 lands, each card shows its own store's data**, so a per-store
  E2E assertion (and a dedicated non-focal store fixture) becomes deterministic
  and meaningful. 081 is the data-plumbing prerequisite that makes 080 worth
  building. This linkage should be noted in 080 if/when it is revived.

## Project-specific notes

- Cmd UI section / legacy: **Cmd UI** — `src/screens/cmd/sections/DashboardSection.tsx`.
- Per-store or admin-global: **Per-store data, rendered in the admin-global
  dashboard.** The new loaders read across all visible stores; per-store RLS
  (`auth_can_see_store()`) still gates which `order_schedule` /
  `order_submissions` rows the caller can read — mirror the RLS posture of the
  existing `fetchEodSubmissionsForStores` / `fetchPosImportsForStores`
  (`.in('store_id', storeIds)` returns only rows the caller is allowed to see).
- Realtime channels touched: **None added.** New loaders are mount +
  `currentStore.id` refresh only (D2/R4 caveat inherited). Note the realtime
  publication gotcha is NOT in play here (no publication change).
- Migrations needed: **No.** Frontend + `db.ts` read helpers only;
  `order_schedule` and `order_submissions` tables already exist.
- Edge functions touched: **None** — PostgREST reads via `db.ts`.
- Web/native scope: **Both** — the Dashboard renders on web and native; the
  fix is platform-agnostic (React state + db.ts reads, no web-only APIs).
- Tests (spec 022 tracks): **jest** is the relevant track. Existing
  `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` must stay green; the
  architect decides whether to add a new jest test for the per-store wiring
  (Open Question Q4 above) and the test-engineer routes accordingly.
- `app.json` slug: **Not touched.** No build-identifier / push-cert surface in
  this spec.

---

## Backend / Frontend design

### Scope re-confirmation (architect, grounded in code)

Confirmed by reading `cmdSelectors.ts:740-975` and `DashboardSection.tsx:113-298`:
`unconfirmed_po` is the **only** focal-contaminated attention rule.

- `eod_missing` (`cmdSelectors.ts:761`) and `food_cost_streak`
  (`cmdSelectors.ts:824`) read `eodSubmissions`/`posImports`, which the
  Dashboard passes as the **cross-store** `allEod`/`allPos`
  (`DashboardSection.tsx:181-189`) — correct per-store today.
- `low_out_stock` (`cmdSelectors.ts:791`) and `expiry` (`cmdSelectors.ts:924`)
  filter the full multi-store `inventory` array by `storeId` — correct today.
- `unconfirmed_po` (`cmdSelectors.ts:853-905`) is the only rule that reads
  `orderSchedule` (store-dimensionless `Record<weekday, OrderDayVendor[]>`) +
  the focal-only `orderSubmissions` slice. Every non-focal card therefore
  derives its missed-order rows from the **focal** store's weekday schedule.
  This is exactly the bug. Scope is `unconfirmed_po` and nothing else.

### Source-table correction — READ THIS FIRST (the spec mislabels the table)

The spec body repeatedly names an `order_submissions` table as the source for
the `orderSubmissions` slice (AC lines 68-76, Open Questions, Project notes).
**No `order_submissions` table exists.** Grep of `supabase/migrations/` and
`supabase/seed.sql` returns zero hits. The `orderSubmissions` slice is sourced
from the **`purchase_orders`** table:

- `fetchAllForStore` (`db.ts:3386`) populates the `orderSubmissions` field of
  its return object from `fetchRecentPurchaseOrders(storeId)` (`db.ts:1090`),
  which queries `purchase_orders` with a `created_at >= now - 14d` cutoff and
  maps each row to `{ id, storeId, vendorId, vendorName, submittedBy,
  submittedByUserId, submittedAt, totalCost, date, referenceDate, timestamp,
  status, day }`. `date` is `reference_date` (fallback: `created_at`'s UTC day).
- `useStore.loadFromSupabase` (`useStore.ts:1017`) then backfills `storeName`
  onto each row and stores it as `orderSubmissions`.
- The `unconfirmed_po` predicate (`cmdSelectors.ts:890-895`) matches on
  `o.storeId === storeId && o.date === pastISO &&
  o.vendorName.toLowerCase() === v.vendorName.toLowerCase()`. So the only fields
  the rule actually consumes are `storeId`, `date`, `vendorName`.

**This does not change the design intent** — it only fixes the table name.
`fetchOrderSubmissionsForStores` is, concretely, the cross-store sibling of
`fetchRecentPurchaseOrders`, querying `purchase_orders` with `.in('store_id',
storeIds)`. The acceptance criteria all still hold against `purchase_orders`.
Developers: ignore every literal `order_submissions` in the AC text; the table
is `purchase_orders`. Surfaced here, not silently — flagging so the PM and
reviewers know the AC text drifted from the implementation reality.

`order_schedule` IS a real table (`recover_undeclared_tables.sql:86`,
columns `store_id, day_of_week, vendor_id, vendor_name, delivery_day`). The
single-store `fetchOrderSchedule` (`db.ts:3401`) is the correct mapping model.

### D1 — Core decision: caller-side map dereference (Option B), not signature change

**Decision: Option B.** Keep `computeAttentionQueue`'s 10-arg signature
unchanged. In `DashboardSection`, build two store-keyed lookups and pass the
**per-store slice** into each iteration's call:

- `crossStoreOrderSchedule: Record<storeId, OrderSchedule>` → dereference
  `byStore[s.id] ?? EMPTY_SCHEDULE` and pass as the `orderSchedule` arg.
- `crossStoreOrderSubmissions: OrderSubmission[]` (flat, already carries
  `storeId`) → the selector self-filters by `o.storeId === storeId`
  (`cmdSelectors.ts:892`), so we pass the flat merged list as the
  `orderSubmissions` arg. No pre-grouping needed — the predicate does it.

**Rationale (why B wins despite the spec inviting either):**

1. **Lower blast radius, and the selector is already store-self-filtering.**
   The `unconfirmed_po` block already filters submissions by
   `o.storeId === storeId`. The ONLY thing broken is that the *schedule* has no
   store dimension and the *submissions list* only contains focal rows. Option
   B fixes both at the call site: pass this store's schedule slice + a
   submissions list that actually contains all stores' rows. The selector's
   existing predicate then does the right thing unchanged.
2. **Signature stability.** `computeAttentionQueue` is consumed by two jest
   suites (`cmdSelectors.unconfirmedPoWindow.test.ts` — 8 tests via a local
   `runQueue` helper at line 89; `cmdSelectors.eodAndStreak.test.ts` — via a
   local `runQueue` at line 98). Option A would force both `runQueue` helpers
   to grow a 9th/changed arg. Option B touches **zero** test files and zero
   selector lines — the suites stay green by construction, satisfying AC
   "Existing jest suite stays green" with no lockstep edit.
3. **Encapsulation argument for A is weak here.** A's "selector filters
   internally" framing would have the selector accept a `Record<storeId,
   OrderSchedule>` and index it — but the selector already takes `storeId` as
   arg 1 and already filters submissions by it. Moving the schedule indexing
   inside buys no real encapsulation; it just relocates one `byStore[s.id]`
   lookup from the loop into the function and forces the test churn. The
   store-keyed map is fundamentally a *data-loading* concern (the loaders are
   store-keyed; the pure selector is single-store), so it belongs at the
   call-site boundary, exactly where `allEod`/`allPos` already live.

**Canonical shapes (pinned):**
- `fetchOrderScheduleForStores(storeIds: string[]): Promise<Record<string, OrderSchedule>>`
  — outer key = `storeId`, value = the same weekday-keyed `OrderSchedule` the
  single-store `fetchOrderSchedule` returns.
- `fetchOrderSubmissionsForStores(storeIds: string[], sinceDate: string): Promise<OrderSubmission[]>`
  — flat list, each row carries `storeId`/`date`/`vendorName` so the predicate
  matches unchanged.

### Data model changes

**None.** No migration. Both source tables exist:
- `public.purchase_orders` — `init_schema.sql:152`; `reference_date` column +
  `idx_purchase_orders_store_reference_date` index referenced at
  `report_run_variance.sql:47`.
- `public.order_schedule` — `recover_undeclared_tables.sql:86`;
  `idx_order_schedule_store_day` on `(store_id, day_of_week)`.

Both already carry `store_id`, so the `.in('store_id', storeIds)` selects are
index-eligible. Confirmed: read-helpers + wiring only. (Spec AC + Open Q2 both
assert "No migration" — confirmed.)

### RLS impact

**No policy changes.** The two `.in('store_id', storeIds)` selects rely on
existing per-store SELECT RLS to silently drop rows the caller can't see — the
identical posture to `fetchEodSubmissionsForStores`/`fetchPosImportsForStores`.

- `purchase_orders` SELECT: `store_member_read_purchase_orders` USING
  `auth_can_see_store(store_id)` (`per_store_rls_hardening.sql:186-188`).
- `order_schedule` SELECT: `"Store members can read order_schedule"` USING
  `auth_can_see_store(store_id)` (`order_schedule_super_admin_rls.sql:24-26`).
  Note: the hardening migration's comment (line 19-23) said `order_schedule`
  was "left alone," but a later migration (20260510020000) DID route its SELECT
  through `auth_can_see_store`. Verified the live policy is per-store-scoped,
  not trivially-wide — so the cross-store `.in(...)` select is correctly
  RLS-gated and will not leak another store's schedule to a caller who can't
  see that store. No spec-053 permissive-lint concern (neither policy is wide).

Because RLS already filters, the helpers do **not** pre-validate `storeIds`
against the caller's visible set — same as the EOD/POS precedent (`db.ts:715`).

### API contract

**PostgREST table reads** via `db.ts` (no RPC, no view, no edge function).
Decision: PostgREST, because (a) the single-store equivalents are already plain
table selects, (b) the `unconfirmed_po` windowing math lives client-side in the
pure selector (spec 074) and stays there, and (c) RLS already scopes rows. An
RPC would add a SECURITY-DEFINER surface for zero benefit.

**`fetchOrderScheduleForStores`**
- Request: `.from('order_schedule').select('*').in('store_id', storeIds)`,
  chained `.abortSignal(signal)`, inside `track(..., { kind: 'read', label:
  'fetchOrderScheduleForStores' })`.
- Response: `Record<storeId, OrderSchedule>`. Group rows by `store_id`, then
  within each store by `day_of_week`, pushing `{ vendorId: row.vendor_id,
  vendorName: row.vendor_name, deliveryDay: row.delivery_day }` — the EXACT
  per-vendor shape of single-store `fetchOrderSchedule` (`db.ts:3412-3416`).
- Empty/error cases: `storeIds.length === 0` → return `{}` before the call.
  On PostgREST error → `console.warn('[Supabase] fetchOrderScheduleForStores:',
  error.message)` and return `{}` (mirror the cross-store fetchers'
  warn-and-return-empty posture at `db.ts:736` / `db.ts:1021`; do NOT `throw`
  the way the single-store `fetchOrderSchedule` does — the cross-store callers
  must degrade, not crash the Dashboard).

**`fetchOrderSubmissionsForStores`**
- Request: `.from('purchase_orders').select('id, store_id, vendor_id,
  vendor:vendors(name), created_by, creator:profiles!created_by(name),
  created_at, reference_date, status, total_cost').in('store_id',
  storeIds).gte('created_at', sinceCutoffISO).order('created_at', { ascending:
  false })`, chained `.abortSignal(signal)`, inside `track(..., { kind: 'read',
  label: 'fetchOrderSubmissionsForStores' })`. (Same column projection as
  `fetchRecentPurchaseOrders` at `db.ts:1096`.)
- Response: `OrderSubmission[]`, each row mapped EXACTLY as
  `fetchRecentPurchaseOrders` (`db.ts:1102-1138`): `date = reference_date ??
  created_at.split('T')[0]`; `day` derived from `refDate`; `vendorName =
  r.vendor?.name ?? ''`; `submittedAt` pre-formatted; `storeId = r.store_id`.
  The three predicate-critical fields (`storeId`, `date`, `vendorName`) are all
  populated. (`OrderSubmission` has no `vendorId` field — `db.ts:478-494`; the
  predicate keys on `vendorName`, so this is fine. The mapped object also
  carries extra fields like `vendorId`/`status`/`totalCost` that `OrderSubmission`
  doesn't declare; `fetchRecentPurchaseOrders` already returns `any[]` for this
  reason — `fetchOrderSubmissionsForStores` should likewise return a superset
  cast to `OrderSubmission[]`, or extract a shared row-mapper; see D5 below.)
- `sinceDate` semantics: see D3.
- Empty/error: `storeIds.length === 0` → `[]` before the call; PostgREST error
  → `console.warn('[Supabase] fetchOrderSubmissionsForStores:', error.message)`
  + return `[]`.

### Edge function changes

**None.** No new or modified edge function. No `verify_jwt` surface.

### D2 — `src/lib/db.ts` surface

Two new exports, placed adjacent to the existing cross-store fetchers / the
order-schedule block:

```ts
// Cross-store sibling of fetchOrderSchedule (db.ts:3401). Store-keyed so the
// Dashboard can pass each card its own weekday schedule. RLS (auth_can_see_store)
// drops unseen stores' rows. Returns {} on empty input or error (degrade, don't throw).
export async function fetchOrderScheduleForStores(
  storeIds: string[],
): Promise<Record<string, OrderSchedule>>;

// Cross-store sibling of fetchRecentPurchaseOrders (db.ts:1090). Source table is
// purchase_orders (NOT "order_submissions"). `sinceDate` is an ISO date string
// compared against created_at. Returns [] on empty input or error.
export async function fetchOrderSubmissionsForStores(
  storeIds: string[],
  sinceDate: string,
): Promise<OrderSubmission[]>;
```

snake_case → camelCase mapping:
- schedule: `day_of_week` (outer group key, kept as-is — the weekday string),
  `vendor_id → vendorId`, `vendor_name → vendorName`, `delivery_day →
  deliveryDay`. Store key from `store_id`.
- submissions: reuse the `fetchRecentPurchaseOrders` mapper verbatim
  (`reference_date → date`/`referenceDate`, `vendor.name → vendorName`,
  `store_id → storeId`, `created_at → timestamp`, etc.).

### D3 — `sinceDate` window for `fetchOrderSubmissionsForStores`

**Decision: reuse the existing 14-day lookback** that the cross-store EOD/POS
effect already computes (`DashboardSection.tsx:158`:
`isoDay(new Date(Date.now() - 14 * 24 * 3600 * 1000))`). Pass that same `since`
into all three cross-store fetchers.

Rationale: the `unconfirmed_po` selector only inspects this work-week's Monday→
yesterday window (≤ 7 days) and trims anything outside it
(`cmdSelectors.ts:876-905`), so a 14-day fetch is a strict superset — correct
and over-fetches at most ~one extra week of small PO rows. Reusing the one
`since` constant keeps the effect to a single date computation and matches the
established precedent (and the single-store `fetchRecentPurchaseOrders` default
is itself `days = 14`, so the windows align). `order_schedule` has no date
column and ignores `since` entirely.

### Realtime impact

**No publication change. No realtime channel added.** The publication gotcha
(restart `supabase_realtime_imr-inventory`) is **NOT in play** — no migration
touches `supabase_realtime` membership.

Channel that replays focal changes: the existing per-store `store-{id}` channel
(`useRealtimeSync.ts`) already fires the debounced reload that refreshes the
**focal** store's `orderSchedule`/`orderSubmissions` slices via
`loadFromSupabase`. The new cross-store loaders inherit the existing **mount +
`currentStore.id`-change** refresh caveat (D2/R4) — non-focal cards do not
live-update on a realtime event for another store; they refresh when the
operator switches focus or remounts the Dashboard.

### D4 — Realtime caveat is acceptable (confirmed)

Confirmed acceptable — match the precedent. The cross-store EOD/POS
(`crossStoreEod`/`crossStorePos`) accept exactly this caveat and have shipped
since spec 009. The new `crossStoreOrderSchedule`/`crossStoreOrderSubmissions`
adopt the identical posture: fetched in the SAME `useEffect`
(`DashboardSection.tsx:153-177`) keyed on `[stores.map(s=>s.id).join(','),
currentStore.id]`, with the same `cancelled` guard + `console.warn` catch, and
merged with the focal slice so the FOCAL card stays realtime-fresh:

```ts
// focal stays live; others are mount-time
const allOrderSubmissions = useMemo(() => {
  const others = crossStoreOrderSubmissions.filter(o => o.storeId !== currentStore.id);
  return [...others, ...orderSubmissions];          // focal slice from useStore
}, [crossStoreOrderSubmissions, orderSubmissions, currentStore.id]);

const scheduleByStore = useMemo<Record<string, OrderSchedule>>(() => ({
  ...crossStoreOrderSchedule,
  [currentStore.id]: orderSchedule,                 // focal overrides cross-store
}), [crossStoreOrderSchedule, orderSchedule, currentStore.id]);
```

Then in the `queueByStore` loop (`DashboardSection.tsx:281-298`), replace the
two focal args:

```ts
out[s.id] = computeAttentionQueue(
  s.id, inventory, allEod, allPos,
  allOrderSubmissions,                       // was: orderSubmissions (focal-only)
  scheduleByStore[s.id] ?? EMPTY_ORDER_SCHEDULE,  // was: orderSchedule (focal-only)
  stores, getItemStatus, timezone,
);
```

`EMPTY_ORDER_SCHEDULE` = a module-const `{}` (stable identity, avoids a fresh
object each iteration). The `queueByStore` `useMemo` dep array gains
`allOrderSubmissions` + `scheduleByStore` and drops the raw `orderSubmissions`/
`orderSchedule` (which now flow in through the merged values).

### D5 — Frontend store impact

**No change to `useStore.ts`.** The cross-store data lives in
`DashboardSection` component-local state (`crossStoreOrderSchedule`,
`crossStoreOrderSubmissions`), exactly like `crossStoreEod`/`crossStorePos`.
The focal `orderSchedule`/`orderSubmissions` slices and their
`loadFromSupabase` population are untouched (spec "Out of scope" line 135-138).
The optimistic-then-revert / `notifyBackendError` pattern does **not** apply —
these are read-only dashboard loaders, not mutations (mirrors EOD/POS, which
also skip it). Errors degrade to `console.warn` + empty data, same as the
precedent.

Shared-mapper note (D2): to avoid duplicating the ~35-line
`fetchRecentPurchaseOrders` row mapper, the backend dev SHOULD extract a private
`mapPurchaseOrderRow(r): OrderSubmission`-shaped helper in `db.ts` and call it
from both `fetchRecentPurchaseOrders` and `fetchOrderSubmissionsForStores`.
This is the lower-drift choice (one mapper, two callers) and is consistent with
the `mapItem`-style local helpers already in `db.ts`. Acceptable alternative if
the dev judges the extraction risky: inline-duplicate the mapper with a comment
pointing at `db.ts:1102` as the source of truth. Either is fine; the extraction
is preferred.

### D6 — Test strategy + spec-080 linkage

The 8 jest tests in `cmdSelectors.unconfirmedPoWindow.test.ts` pin the
**windowing LOGIC** (Monday-reset, exclude-today, DST edges) via a local
`runQueue` helper. This fix is the **DATA PLUMBING** — Option B means the
selector and both `runQueue` helpers are untouched, so those 8 tests (plus
`cmdSelectors.eodAndStreak.test.ts` and `weekWindow.test.ts`) stay green by
construction. No lockstep test edit is required (this is a direct consequence
of choosing B over A).

**New coverage — db.ts mapping unit tests (recommended, owned by
backend-developer):** add a small jest suite for the two new helpers asserting
the row→object grouping/mapping, mirroring how existing pure-ish db mappers are
covered. Specifically:
- `fetchOrderScheduleForStores`: given mocked rows for store A (Mon: Vendor V)
  and store B (Tue: Vendor W), the result is
  `{ A: { Monday: [...] }, B: { Tuesday: [...] } }` — proving the store
  dimension is preserved and not flattened across stores. (This is the unit
  that most directly proves the bug-fix invariant: store A's schedule never
  bleeds into store B.)
- `fetchOrderSubmissionsForStores`: `storeIds: []` → `[]`; a mocked multi-store
  result maps `reference_date → date` and `vendor.name → vendorName` for each
  store's rows. These mock `supabase.from(...).select(...).in(...)...` the same
  way the suite already stubs `./supabase` (`unconfirmedPoWindow.test.ts:19`).

**The per-store WIRING assertion** (each card receives its own store's schedule,
not the focal store's) is **better left to the un-deferred spec-080 E2E.** A
jest test of `DashboardSection`'s `queueByStore` would require rendering the RN
component + mocking `db.fetchOrderScheduleForStores`/`...Submissions`, which is
heavier than the jest track's current scope (pure-function + mapper units) and
duplicates exactly what 080's E2E will assert deterministically against
DB-loaded slices. Recommend: the db.ts mapper units above land with this spec;
the end-to-end per-store render assertion lands with spec 080.

**Spec-080 linkage (recorded):** landing 081 **un-blocks spec 080**
(`specs/080-e2e-dashboard-attention-queue-window.md`, currently `DEFERRED`).
Until 081, every card shows the focal store's `unconfirmed_po` rows, so an E2E
per-store assertion is non-deterministic / meaningless on a multi-store
dashboard. Once 081 lands, each card shows its own store's data, so 080's
per-store assertion (plus a dedicated non-focal-store fixture) becomes
deterministic and worth building. This should be noted in 080 when it is
revived. 081 does NOT build 080's E2E (spec "Out of scope" line 133-134).

### Risks and tradeoffs (explicit)

1. **AC text names a non-existent `order_submissions` table.** Mitigated by the
   Source-table correction section above — the real table is `purchase_orders`.
   Risk if ignored: a developer wires `.from('order_submissions')` and gets a
   PostgREST `42P01` (undefined_table), silently caught by the warn-and-return-
   empty path, producing a Dashboard where NO card shows missed orders — a
   regression masquerading as "fixed." **Highest-priority callout for the
   backend dev.** Surfaced to PM here, not worked around silently.
2. **Migration ordering: N/A.** No migration. No drift-check exposure in
   `db-migrations-applied.yml`.
3. **Performance on the 286 KB seed / multi-store.** Two extra `.in('store_id',
   [...])` selects per Dashboard mount + per `currentStore.id` change. Both hit
   covering indexes (`idx_order_schedule_store_day`,
   `idx_purchase_orders_store_reference_date` — though the latter indexes
   `reference_date` while we filter `created_at`; the `store_id` prefix still
   prunes, and `purchase_orders` row counts are small relative to inventory, so
   this is acceptable). `order_schedule` is tiny (≤ 7 days × vendors × stores).
   No N+1 — single round-trip each. Net cost is comparable to the EOD/POS
   fetchers already firing in the same effect.
4. **RLS gap: none identified.** Both SELECT policies route through
   `auth_can_see_store`. Re-confirmed `order_schedule`'s policy is per-store
   (the hardening-migration "left alone" comment is stale; 20260510020000
   tightened it). A caller with no visibility to store B sees zero of B's
   schedule rows, so B's card simply shows no `unconfirmed_po` rows — correct
   degradation, not a leak.
5. **Cold-start: N/A** — no edge function.
6. **Merge-order subtlety.** `scheduleByStore` must spread `crossStore...` FIRST
   then override `[currentStore.id]: orderSchedule`, so the realtime-fresh focal
   schedule wins over the (possibly staler) mount-time cross-store copy — the
   same precedence the `allEod`/`allPos` `filter-then-concat` achieves. Flagged
   so the frontend dev doesn't invert it.
7. **`getItemStatus` identity.** Unchanged — already a selector dep
   (`DashboardSection.tsx:298`); the new merged values just join the dep array.

### Developer split (explicit + disjoint)

- **backend-developer — owns `src/lib/db.ts` (and any jest there).**
  - Add `fetchOrderScheduleForStores` + `fetchOrderSubmissionsForStores` per
    D2 / API-contract above (PostgREST, `track()` + `.abortSignal()`,
    warn-and-return-empty).
  - Source table is `purchase_orders` (Risk 1). Prefer the shared
    `mapPurchaseOrderRow` extraction (D5).
  - Add the db.ts mapper jest units (D6).
  - `cmdSelectors.ts` is **NOT touched** (Option B). If a future reviewer
    forces Option A, the `runQueue` updates in BOTH test files travel with this
    owner — but as designed, no `cmdSelectors`/test edits are needed.
- **frontend-developer — owns `src/screens/cmd/sections/DashboardSection.tsx`.**
  - Add `crossStoreOrderSchedule`/`crossStoreOrderSubmissions` state + fetch
    them in the EXISTING cross-store `useEffect` (`:153-177`) using the same
    `since` (D3) + `cancelled` guard + `console.warn` catch.
  - Add the `allOrderSubmissions` + `scheduleByStore` merge memos (D4, mind the
    spread-then-override order — Risk 6) and a module-const
    `EMPTY_ORDER_SCHEDULE`.
  - Swap the two focal args in the `queueByStore` loop (`:281-298`) + update
    that memo's dep array.
  - `db.ts` is **NOT touched** by this owner (consumes `db.fetchOrder*` only).

Disjoint boundary: backend-developer owns everything in `db.ts`;
frontend-developer owns everything in `DashboardSection.tsx`. No shared file.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec's `## Backend / Frontend
  design` section. backend-developer: add the two cross-store read helpers
  (`fetchOrderScheduleForStores`, `fetchOrderSubmissionsForStores`) in
  `src/lib/db.ts` per D2 + the API contract — note the source table is
  `purchase_orders`, NOT the AC's mislabeled `order_submissions` (Risk 1) — plus
  the db.ts mapper jest units (D6); do NOT touch `cmdSelectors.ts` (Option B).
  frontend-developer: wire the two new component-local-state slices into the
  existing cross-store `useEffect` in `DashboardSection.tsx`, add the
  focal-merge memos (`allOrderSubmissions`, `scheduleByStore` — spread cross-store
  then override the focal id, Risk 6), and pass each store its own slice into the
  `computeAttentionQueue(s.id, ...)` loop. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under `## Files changed`.
payload_paths:
  - specs/081-dashboard-attention-queue-per-store-unconfirmed-po.md

---

## Files changed (backend/db)

backend-developer half (the `src/lib/db.ts` surface only — Option B, so
`cmdSelectors.ts` is untouched; the frontend-developer wired
`DashboardSection.tsx` in parallel and lists their files separately).

### src/lib (helpers + mapper)
- `src/lib/db.ts`
  - Imported `OrderSchedule`, `OrderSubmission` from `../types` (the existing
    single-store `fetchOrderSchedule` returned untyped `Record<string, any[]>`;
    the pinned cross-store signatures need the named types).
  - Extracted a private `mapPurchaseOrderRow(r)` helper (spec 081 D5 preferred
    path) — the verbatim `fetchRecentPurchaseOrders` row→object mapper, now one
    source of truth for the snake→camel mapping.
  - Refactored `fetchRecentPurchaseOrders` to call `mapPurchaseOrderRow`
    (behavior unchanged — same projection, same mapping).
  - Added `fetchOrderSubmissionsForStores(storeIds, sinceDate): Promise<OrderSubmission[]>`
    — cross-store sibling of `fetchRecentPurchaseOrders`, querying
    **`purchase_orders`** (NOT `order_submissions`, per Risk 1) with
    `.in('store_id', storeIds).gte('created_at', sinceDate)`, inside
    `track(..., { kind: 'read', label: 'fetchOrderSubmissionsForStores' })`,
    `.abortSignal(signal)`, warn-and-return-`[]` on empty input or error.
  - Added `fetchOrderScheduleForStores(storeIds): Promise<Record<string, OrderSchedule>>`
    — cross-store sibling of `fetchOrderSchedule`, store-keyed then weekday-keyed,
    `.in('store_id', storeIds)`, inside
    `track(..., { kind: 'read', label: 'fetchOrderScheduleForStores' })`,
    `.abortSignal(signal)`, warn-and-return-`{}` on empty input or error.

### tests (jest, spec 022 Track 1 — unit/node project)
- `src/lib/db.crossStoreLoaders.test.ts` (new) — 10 mapper units (D6).
  Proves the store-keying invariant (store A's schedule never bleeds into
  store B's), the empty-input short-circuits, the `reference_date → date` /
  `vendor.name → vendorName` mapping, the `created_at` fallback, and the
  warn-and-return-empty error posture. Mocks `./supabase` (chainable builder),
  `./inflight` (`track` runs the thunk directly), and `./auth`.

### NOT touched (Option B + disjoint split)
- `src/lib/cmdSelectors.ts` — selector signature unchanged; the 8
  `unconfirmedPoWindow` + `eodAndStreak` jest tests stay green by construction.
- `src/screens/cmd/sections/DashboardSection.tsx` — owned by the
  frontend-developer (parallel).
- No migration, no edge function, no `cmdSelectors`/test-caller edits.

### Verification
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- `npx jest` → 41 suites / 396 tests passing (was 386; +10 new mapper units).

---

## Files changed (frontend/wiring)

frontend-developer half — the `DashboardSection.tsx` call-site wiring only
(Option B). The backend-developer's `db.ts` helpers
(`fetchOrderScheduleForStores`, `fetchOrderSubmissionsForStores`) landed FIRST;
this half consumed the frozen contract verbatim — no `db.ts` / `cmdSelectors.ts`
edits.

### src/screens/cmd/sections
- `src/screens/cmd/sections/DashboardSection.tsx`
  - Imported `OrderSchedule`, `OrderSubmission` from `../../../types`.
  - Added a module-const `EMPTY_ORDER_SCHEDULE: OrderSchedule = {}` (stable
    identity for the per-store fallback — avoids a fresh `{}` per loop
    iteration; D4).
  - Added two component-local state slices alongside `crossStoreEod`/
    `crossStorePos`: `crossStoreOrderSchedule` (`Record<string, OrderSchedule>`,
    default `{}`) + `crossStoreOrderSubmissions` (`OrderSubmission[]`, default
    `[]`).
  - In the EXISTING cross-store `useEffect` (keyed `[stores…join(','),
    currentStore.id]`), added `db.fetchOrderScheduleForStores(storeIds)` →
    `setCrossStoreOrderSchedule` and `db.fetchOrderSubmissionsForStores(
    storeIds, since)` → `setCrossStoreOrderSubmissions`, reusing the SAME 14-day
    `since` (D3) + the SAME `cancelled` guard + `console.warn` catch.
  - Added two focal-merge memos mirroring `allEod`/`allPos`:
    `allOrderSubmissions` (`[...crossStoreOrderSubmissions.filter(o => o.storeId
    !== currentStore.id), ...orderSubmissions]`) and `scheduleByStore`
    (`{ ...crossStoreOrderSchedule, [currentStore.id]: orderSchedule }` —
    spread-then-override so the realtime-fresh focal schedule wins, Risk 6).
  - In the `queueByStore` loop, swapped the two focal args: submissions arg →
    `allOrderSubmissions` (the selector self-filters by `o.storeId === storeId`);
    schedule arg → `scheduleByStore[s.id] ?? EMPTY_ORDER_SCHEDULE`. Updated the
    `useMemo` dep array — `allOrderSubmissions`/`scheduleByStore` replace the raw
    `orderSubmissions`/`orderSchedule`.

### NOT touched (Option B + disjoint split)
- `src/lib/db.ts` — owned by the backend-developer (helpers landed first;
  consumed as a frozen contract).
- `src/lib/cmdSelectors.ts` — selector signature unchanged (Option B); the
  8 `unconfirmedPoWindow` + `eodAndStreak` jest tests stay green by
  construction.
- No migration, no edge function, no `e2e/` change.

### Verification (frontend/wiring)
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- `npx jest` → 41 suites / 396 tests passing (unchanged from the BE dev's run;
  this wiring touches no jest-covered surface — DashboardSection has no jest
  test).
- Web bundle: forced a Metro transform of the web target
  (`/node_modules/expo/AppEntry.bundle?platform=web`, the entry the running
  Expo server serves on :8081) → HTTP 200, 14 MB, the new symbols
  (`EMPTY_ORDER_SCHEDULE`, `crossStoreOrderSchedule`,
  `fetchOrderScheduleForStores`, `fetchOrderSubmissionsForStores`) present in
  the transformed graph with zero `TransformError`/`Unable to resolve`
  failures. Proves the wiring compiles into the real web target, not just
  under `tsc`.
- VISUAL gap (noted honestly): the project's expected `preview_*` MCP was not
  in this session's tool loadout, and the local seed has limited
  `order_schedule` data, so the deferred-to-080 per-store render assertion was
  not eyeballed here. The deterministic per-store proof is (a) the BE dev's
  10 db.ts mapper units (the store-keying invariant — store A's schedule never
  bleeds into store B), and (b) the now-unblocked spec-080 E2E. This half's
  responsibility — the wiring compiles + bundles + passes the full jest suite —
  is met.
