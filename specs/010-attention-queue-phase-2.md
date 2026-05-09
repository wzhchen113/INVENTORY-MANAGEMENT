# Spec 010: Expiry tracking & spoilage alerts

Status: READY_FOR_REVIEW

> **PM note (2026-05-06 / narrowed 2026-05-08).** This spec was filed as a
> "Phase 2 attention queue" placeholder during the Spec 009 lock-in,
> originally covering three deferred alert types: expiry tracking,
> invoice matching, and temperature logging. After scoping with the user
> on 2026-05-08:
>
> - **Temperature logging**: out — user has no need.
> - **Invoice matching**: out — no driver. 5-6 invoices/week per store
>   is comfortably manual; user has never been overcharged; pay-on-receipt
>   workflow has no reconciliation problems. Defer indefinitely; revisit
>   only if real reconciliation pain emerges.
> - **Expiry tracking**: in. This spec narrows to expiry tracking only.
>
> If invoice matching or temperature logging ever become drivers, file a
> separate spec then. They are NOT scheduled.

## User story

As an admin overseeing the 2AM PROJECT chain, I want to see which
inventory items are expiring soon and the dollar value at risk, so that I
can prevent spoilage waste before it hits the food-cost line.

## Background

Spec 009 (Dashboard v2) shipped per-store attention queues with 4 alert
types. The 4 Phase-1 types (EOD missing, out/low stock, food-cost streak,
unconfirmed PO) all derive from data the system already tracks. Expiry
tracking does not — there is no `expires_at` (or equivalent) data flow
today, so no alert can fire.

This spec adds the data flow + the alert.

## Acceptance criteria

- [ ] Inventory items can carry an expiry date. Either (a) a per-item
      `expires_at` column on `inventory_items`, or (b) a per-lot expiry
      via a new `inventory_lots` table. Architect picks based on §0
      probe (see "Open questions for architect" below).
- [ ] The expiry data has at least one user-facing entry path. Two
      candidates, architect picks based on existing receiving/UI shape:
      - **Receiving screen** — when a delivery lands, manager enters
        expiry per line item.
      - **Ingredient form** — admin sets a "default shelf life days"
        per ingredient; system auto-computes `expires_at` on receipt.
      - Both, if architect determines they're complementary.
- [ ] Spec 009's per-store attention queue
      (`computeAttentionQueue` in `src/lib/cmdSelectors.ts`) gains a new
      `expiry` alert type. Severity rules:
      - **High**: any item expiring within 24h.
      - **Medium**: any item expiring within 24-72h.
      - **Low**: any item expiring within 72h-7d.
      - Items beyond 7d are not surfaced in the queue.
      - Aggregate text: `"X items expiring <Yh, $Z at risk"` per
        severity bucket (one row per bucket, not one row per item).
- [ ] A drill-down view shows the per-item expiring list (item name,
      store, days/hours to expiry, dollar value at risk = `currentStock
      × costPerUnit`). Where this drill-down lives is architect's call
      (modal from the alert? new section in the existing Inventory tab?
      new tab on the Catalog detail?).
- [ ] Migration adds the schema element architect picks (column on
      `inventory_items` OR new `inventory_lots` table). Additive;
      idempotent; row-scoped RLS via existing `auth_can_see_store()`.
- [ ] Spec 009's `computeAttentionQueue` selector consumes the new
      data without forking — the existing client-derived attention
      queue remains the surface. Spec 009's Q4b decision (no
      server-computed `/stores/:id/attention` endpoint) holds for this
      spec; revisit when alert volume warrants.
- [ ] Standard project conventions: `src/lib/db.ts` for any new
      reads/writes, optimistic-then-revert with `notifyBackendError`,
      no touch on `AdminScreens.tsx`/legacy stores/`app.json` slug.

## In scope

- Schema element to carry expiry data (architect picks lot-level vs
  row-level).
- One or more user-facing data-entry surfaces (architect picks
  receiving screen, ingredient form, or both).
- New `expiry` alert type wired into `computeAttentionQueue`
  (`src/lib/cmdSelectors.ts`).
- Drill-down list of expiring items (architect picks placement).
- Migration adding the schema element + backfill (existing rows get
  null expiry; alert simply doesn't fire for them until set).

## Out of scope (explicitly)

- **Invoice matching** — user said no driver. Defer.
- **Temperature logging** — user said no.
- **Server-computed `/stores/:id/attention` endpoint** — Spec 009 Q4b
  defer holds. Client-derived from existing slices.
- **Auto-discount UX** — automatically markdowning expiring items in
  recipes / menus is a downstream feature, not this spec.
- **Vendor recall workflow** — recall handling (vendor-issued recall
  → flag affected lots → block from use) is its own spec if needed.
- **Multi-lot inventory accounting** — even if the architect picks
  `inventory_lots`, this spec does NOT change how the rest of the
  system reports inventory value, depletion, etc. — those still
  aggregate by item. Lots are a metadata layer for expiry tracking
  only. Promoting lots to first-class inventory accounting is a
  separate spec.

## Open questions resolved

Locked 2026-05-08 by user — narrowed scope from 3 alert types to 1.

- **Spec scope**: expiry tracking only. Invoice + temp out per user
  direction (no driver / not needed).
- **Server endpoint vs client-derived (Q3 in placeholder spec)**:
  client-derived. No new edge function. Spec 009's Q4b decision holds.
- **Cross-cutting Q5**: per-store scope, standard `auth_can_see_store()`
  RLS, daily-refresh OK, web-first. Native data-entry deferred unless
  architect surfaces a strong case (e.g., receiving screen on mobile
  is high value because managers stand in the walk-in with deliveries).

## Open questions for architect (probed at design time, not user-blocking)

These are the implementation choices the architect probes during
design. PM-recommended defaults below; architect can override or flag
back to user if any choice has substantive UX or schema impact.

### A1 — Lot-level vs row-level expiry

The biggest data-model decision.

- **(a) Row-level**: add `expires_at TIMESTAMPTZ` to `inventory_items`.
  Tracks one expiry per item. When a new delivery lands, do we
  overwrite (newest) or keep earliest? PM lean: keep earliest
  (worst-case visibility). Simpler schema, simpler UI. Loses fidelity
  when an item has multiple lots with different expiries.
- **(b) Lot-level**: new `inventory_lots(item_id, quantity, expires_at,
  received_at, ...)` table. Each receipt creates a lot row; lots
  deplete FIFO. More accurate; supports multi-lot; matches how
  ground-beef-style items actually work. Bigger schema delta + more
  UI.

PM lean: **(a) row-level for v1.** Spec 009's Phase-1 attention queue
is intentionally simple; row-level fits that posture. Lot-level is a
bigger product call; revisit if row-level leaves visible blind spots.

Architect probe: check if `InventoryItem.expiryDate?` already exists
in `src/types/index.ts` (PM flagged this from earlier inspection but
didn't verify against current code). If yes, the schema delta is
nil for option (a).

### A2 — Where does expiry data enter the system?

- **(a) Receiving screen only** — when a delivery lands, manager
  enters expiry per PO line item. Highest-friction (manual entry per
  receipt) but most accurate.
- **(b) Ingredient form only** — admin sets `default_shelf_life_days`
  per ingredient; system auto-computes `expires_at` from receive
  date. Lowest-friction, set-it-once. Loses accuracy when actual
  shelf life varies (vendor delivery freshness, storage conditions).
- **(c) Both** — default shelf life as fallback; manual override on
  receiving when manager wants precision.

PM lean: **(c) both** — default-from-shelf-life-days is the
"happy path" (most items use it), manual override on receiving is the
escape hatch. Frontend dev surface: a "Default shelf life (days)"
field on the ingredient form + an expiry input on the receiving
screen line item.

Architect probe: read `src/screens/cmd/sections/ReceivingSection.tsx`
to confirm the current receiving UX has somewhere to slot the per-line
expiry input. If receiving is a stub, escalate to user.

### A3 — Alert thresholds

PM-defaulted to 24h / 72h / 7d (high/med/low). Architect can adjust
based on operator input (e.g., highly perishable categories like
seafood may need 12h/24h thresholds; dry goods 30d/60d).

Architect's call: ship the defaults as configurable per-category in v1
(simple) OR per-item (more flexibility, more UI), OR system-wide
constants for now (ship-fast).

PM lean: **system-wide constants for v1**. Per-category or per-item
is a follow-up.

### A4 — Drill-down placement

The expiring-items list. Three candidates:
- **(a) Modal from the alert** — click the queue item → modal opens
  with the per-item list. Lightweight; fits Spec 009's existing alert
  pattern.
- **(b) New section in Inventory** — a "Expiring" view alongside
  items.tsv and catalog.tsv. More discoverable; more surface to maintain.
- **(c) New tab on Catalog detail** — per-ingredient expiry history.

PM lean: **(a) modal** for v1. Cheapest to ship; matches the existing
attention queue interaction model.

## Dependencies

- **Spec 009** must have shipped (it has — commit `5fa63d3`). This
  spec extends `computeAttentionQueue`.
- `src/lib/cmdSelectors.ts` — extension point.
- `src/screens/cmd/sections/ReceivingSection.tsx` — surface for A2.
- `src/components/cmd/IngredientForm.tsx` — surface for A2 (default
  shelf life days field).
- `src/lib/db.ts` — any new reads (`fetchExpiringItems`?) or writes
  (`updateInventoryExpiry`).
- Existing `auth_can_see_store()` RLS — no new policies.
- Realtime publication — N/A (no publication change expected; alert
  recomputes on existing brand realtime channel reload).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. Don't touch
  `AdminScreens.tsx` or `IngredientsScreen.tsx`.
- **Per-store or admin-global:** per-store via existing
  `auth_can_see_store()` (no new policy work).
- **Realtime channels touched:** none new. Alert recomputes via
  existing brand-channel debounced reload.
- **Migrations needed:** one (architect's A1 decision drives the
  shape).
- **Edge functions touched:** none.
- **Web/native scope:** web. Architect can flag native receiving
  if A2 = (a) or (c) and managers actually receive in the walk-in.
- **Tests:** no test framework wired up. Pure-function selector
  additions in `cmdSelectors.ts` are highly testable IF a test
  runner existed; flag for test-engineer.
- **Conventions to honor:**
  - Hydrator-vs-setter (Spec 008) — N/A unless a new useStore action
    needs hydration.
  - Pre-mutation per-prep assertion ordering (Spec 003) — N/A.
  - Optimistic-then-revert + `notifyBackendError` — applies to any
    new write paths.
  - All DB access via `src/lib/db.ts` — already enforced.
  - "No dupes / utilize existing" — extend `computeAttentionQueue`
    instead of forking; reuse Cmd atoms.

## Backend design

### §0 — Probe results

Probed the four call-out files plus immediately adjacent code. Findings
that change the PM lean:

- **A1 (lot vs row).** `InventoryItem.expiryDate?: string` already
  exists in `src/types/index.ts:68`. The DB column
  `inventory_items.expiry_date date` exists in
  `supabase/migrations/20260405000759_init_schema.sql:63`. Both
  `mapItem` (`src/lib/db.ts:1778`) and the write path
  `updateInventoryItem` (`src/lib/db.ts:152`) already round-trip
  `expiry_date`. `createInventoryItem` accepts it too
  (`src/lib/db.ts:113`). **Schema delta for option (a) is effectively
  nil.** No evidence anywhere in the seed data or selectors of multi-lot
  tracking — there is no `inventory_lots`-shaped data flow. Confirms
  PM lean (a) row-level. **Decision: A1 = (a) row-level.**
- **A2 (data-entry surface).** `ReceivingSection.tsx` is a
  Tier-1 mock per its own header comment (`src/screens/cmd/sections/ReceivingSection.tsx:18`):
  the line-items table is **synthesized client-side** from inventory
  rows for the matching vendor (`lineItems` useMemo at line 66) and
  there is no `purchase_orders`/`po_items` schema yet. The `commitReceive`
  handler bumps `inventory_items.current_stock` and writes an audit
  event — that is the only durable surface. There is **no row anywhere
  to attach a per-line `expires_at` to**. Adding a per-line expiry
  input here would be theatre: it would persist to nothing, or it would
  conflate "expiry of this batch I just received" with the row-level
  `inventory_items.expiry_date` (clobbering whatever was there before).
  This is exactly the case the PM said "escalate to user" for — but
  the PM lean has a graceful degrade: **A2=(c)** with the "default from
  shelf life days, manual override on receiving" semantics still works
  if we replace "manual override on receiving" with **"manual override
  on the ingredient row from the Inventory section"**. The receiving
  surface gets a *display-only* expiry indicator (read from `expiryDate`
  on the synthesized line) and a one-click "set expiry from default
  shelf life" affordance that writes through `updateItem({ expiryDate })`
  on the underlying `inventory_items.id`. **Decision: A2 = (c) with
  the receiving-side surface narrowed to default-application + display,
  not per-line override.** The override channel is the existing
  IngredientFormDrawer (gain a "shelf life" / "expires" pair of fields)
  + the existing inventory list per-row. Calling this out as an
  architect-flag in §9 — if the user wants a true per-line override
  with persistence, that requires a `po_items` schema spec first.
- **A3 (thresholds).** No existing config plumbing for per-category or
  per-item thresholds (would need a new `expiry_thresholds` table or
  jsonb column). PM lean (system-wide constants) holds — ship-fast,
  matches Spec 009 D3's `TARGET_FOOD_COST_PCT_DEFAULT` precedent
  (`src/lib/cmdSelectors.ts:556`). **Decision: A3 = system-wide
  constants exported from `cmdSelectors.ts`.**
- **A4 (drill-down).** Spec 009's queue rows
  (`src/screens/cmd/sections/DashboardSection.tsx:836-879`) are
  static `<View>` rows — no click handler today. PM lean (modal from
  alert) requires adding a `TouchableOpacity` wrapper + an `onSelect`
  prop on the queue row + a host-managed modal in `DashboardSection`.
  Per-store column already has the natural state (each `<StoreCol />`
  is one store; the modal opens with that store's expiring-items list).
  **Decision: A4 = (a) modal, hosted by `DashboardSection`, click-to-open
  on the new expiry row only** (other 4 alert types stay click-inert
  for v1 — broaden later if drill-down is wanted across rules).

Existing `inventory_items` schema confirmation (init migration L52-68):
already carries `expiry_date date`, `store_id uuid references
stores(id)`, RLS via `auth_can_see_store(store_id)` per
`20260504173035_per_store_rls_hardening.sql:46-61`. No publication
membership change needed — `inventory_items` is already a member of
`supabase_realtime`, so the existing brand/store-channel debounced
reload (`useRealtimeSync.ts`) replays expiry mutations like any other
inventory edit.

Spec 009 dashboard alert UX confirmed at
`src/screens/cmd/sections/DashboardSection.tsx:805-880` — queue items
are rendered inside `StoreCol` with a sev pill + label; we extend that
component rather than fork a new render path.

### §1 — Schema changes

One migration. Filename:
`supabase/migrations/20260506120000_expiry_tracking.sql` (date-stamped
today; final timestamp is the dev's call when they author it — must
sort after `20260505*` brand-catalog phases).

Two columns, both additive + idempotent:

```sql
-- Per-ingredient default shelf life used to auto-compute expires_at on
-- receipt. NULL = no default; receipt won't auto-stamp expiry.
alter table public.catalog_ingredients
  add column if not exists default_shelf_life_days int;

comment on column public.catalog_ingredients.default_shelf_life_days is
  'Spec 010: default days from receipt to expiry. NULL = no auto-compute. '
  'Per-store inventory_items.expiry_date can override on a per-row basis.';

-- expiry_date already exists on inventory_items per init schema; no
-- column add. Promote to timestamptz only if a follow-up needs hour
-- granularity — `date` is enough for the 24h/72h/7d buckets in §3.
```

Rationale:
- `default_shelf_life_days` lives on `catalog_ingredients` (brand-level)
  because shelf life is a property of the ingredient (chicken
  vs. dry goods), not of one store's stock. Matches the brand-catalog
  refactor's "shape lives once at the brand level" pattern.
- Keep `inventory_items.expiry_date` as `date` (not `timestamptz`).
  The 24h/72h/7d severity buckets in §3 are computed in JS against a
  start-of-day projection of today; midnight-precision is fine for v1
  and avoids a destructive type change. The frontend already maps
  `expiryDate?: string` (ISO date).
- Backfill: none. Existing rows get NULL for `default_shelf_life_days`
  and keep their existing `expiry_date` (probably mostly NULL already).
  Items with NULL on both never fire the alert — degrades silently.
- Rollout: additive only. Safe to ship without coordinated frontend
  release; old clients ignore the new column.
- Realtime publication: **no membership change**. `catalog_ingredients`
  is already in `supabase_realtime` (writes from
  CatalogIngredientsTab realtime-sync today). N/A on the
  `docker restart supabase_realtime_imr-inventory` gotcha.

### §2 — Read/write contracts

All flows through `src/lib/db.ts` (no new edge function).

**Catalog read — extend the existing `fetchCatalogIngredients`** to
include `default_shelf_life_days` in the SELECT and the mapped output:

```ts
// Mutation to existing helper, not a new function.
// src/lib/db.ts:1563-1582 — change select '*' is already a wildcard so
// no select change needed; add to the .map():
//   defaultShelfLifeDays: c.default_shelf_life_days ?? null,
```

The new field on `CatalogIngredient` (in `src/types/index.ts`):

```ts
export interface CatalogIngredient {
  // ... existing fields
  defaultShelfLifeDays: number | null;
}
```

**Catalog write — new helper.** The existing
`updateCatalogIngredient` path (the dev should grep for the function;
write through the catalog edit flow if it exists; otherwise add):

```ts
// src/lib/db.ts — add or extend
export async function updateCatalogIngredient(
  catalogId: string,
  patch: { defaultShelfLifeDays?: number | null; /* future fields */ }
): Promise<void>;
// Maps defaultShelfLifeDays → default_shelf_life_days. RLS via
// existing catalog_ingredients policy (brand-scoped writer). Standard
// Supabase error shape; throw on .error.
```

If a generic catalog updater doesn't exist yet, the helper is a thin
wrapper around `supabase.from('catalog_ingredients').update({...})
.eq('id', catalogId)`.

**Inventory write — already exists.** `db.updateInventoryItem(id,
{ expiryDate })` at `src/lib/db.ts:152` already round-trips
`expiry_date`. No change. The store's `updateItem` action
(`src/store/useStore.ts:393`) is the optimistic-then-revert wrapper
and already accepts `expiryDate` via `Partial<InventoryItem>`.

**No new fetch helper needed for the alert/drill-down.** The expiring
items list derives 100% from `useStore.inventory[]` (already loaded
per-store and per `__all__` mode for the dashboard). Filtering + bucketing
happens in `cmdSelectors.ts` (§3 below).

**Receipt-time auto-compute helper (new):**

```ts
// src/lib/db.ts — new pure helper, no DB call
export function computeExpiryFromShelfLife(
  receivedAtISO: string,            // 'YYYY-MM-DD' or full ISO
  defaultShelfLifeDays: number | null,
): string | null;
// Returns 'YYYY-MM-DD' or null when shelf life is not set.
// Used by the receiving "set expiry from default" affordance.
```

Could live in `src/utils/` instead — dev's call. PM-equivalent suggestion:
`src/lib/db.ts` adjacent to `mapItem` since it's a one-liner used in
exactly one place.

### §3 — `computeAttentionQueue` extension

Extend `src/lib/cmdSelectors.ts` (the `AttentionItem` rule type and
`computeAttentionQueue` body).

**Type changes:**

```ts
// src/lib/cmdSelectors.ts
export interface AttentionItem {
  // ... existing
  rule:
    | 'eod_missing'
    | 'low_out_stock'
    | 'food_cost_streak'
    | 'unconfirmed_po'
    | 'expiry';                    // NEW
  /**
   * Spec 010: structured payload for the drill-down modal. Populated
   * only when rule === 'expiry'; undefined otherwise. Pure-function
   * output stays JSON-serializable (no Date objects, no functions).
   */
  expiryDetail?: {
    sev: 'high' | 'med' | 'low';
    items: Array<{
      itemId: string;              // inventory_items.id
      itemName: string;
      hoursToExpiry: number;       // negative if already expired
      dollarAtRisk: number;        // currentStock × costPerUnit
      unit: string;
    }>;
    totalDollarAtRisk: number;
  };
}
```

**Constants (alongside `TARGET_FOOD_COST_PCT_DEFAULT`):**

```ts
export const EXPIRY_HIGH_HOURS = 24;
export const EXPIRY_MED_HOURS = 72;
export const EXPIRY_LOW_HOURS = 24 * 7;     // 7 days
```

**Rule body** — fires inside `computeAttentionQueue`, after the
`unconfirmed_po` block, before the final sort. Pseudocode:

```
storeInventory = inventory.filter(i => i.storeId === storeId
                                    && i.expiryDate)

for each item in storeInventory:
  hoursToExpiry = (Date(item.expiryDate end-of-day) - now) / 3600_000
  // end-of-day so a "today" expiry isn't already negative at 9am
  if hoursToExpiry > EXPIRY_LOW_HOURS: skip
  bucket = hoursToExpiry <= 0           ? 'high'      // already expired
         : hoursToExpiry <= EXPIRY_HIGH_HOURS ? 'high'
         : hoursToExpiry <= EXPIRY_MED_HOURS  ? 'med'
         : 'low'
  bucketed[bucket].push({ itemId, itemName, hoursToExpiry,
                          dollarAtRisk: currentStock × costPerUnit,
                          unit })

for each (bucket, items) in bucketed where items.length > 0:
  totalDollar = sum(items[*].dollarAtRisk)
  hoursLabel = bucket === 'high' ? '24h'
             : bucket === 'med'  ? '72h'
             : '7d'
  out.push({
    id: `${storeId}:expiry:${bucket}`,
    sev: bucket,
    text: `${items.length} item${s} expiring <${hoursLabel}, $${Math.round(totalDollar)} at risk`,
    rule: 'expiry',
    expiryDetail: { sev: bucket, items, totalDollarAtRisk: totalDollar }
  })
```

Notes:
- One row per severity bucket (per spec acceptance criteria), not one
  row per item.
- "Already expired" rolls into `high` per the literal reading of the
  rule (≤ 24h includes ≤ 0h). The drill-down modal shows the actual
  hours so the operator can distinguish.
- `text` uses the same template the spec called out: `"X items expiring
  <Yh, $Z at risk"`. Singular form when items.length === 1
  ("1 item expiring …"). `Math.round` on the dollar to keep the queue
  visually compact; the modal shows precise.
- Items get sorted in the bucket by ascending `hoursToExpiry` so the
  modal opens with most-urgent at top.
- `expiryDetail` is a snapshot — the drill-down does not re-derive,
  it just renders. Cheaper than asking the modal to call the selector
  again with another store filter.

**Hook wrapper:** existing `computeAttentionQueue` is called from
`DashboardSection.tsx:245` with the cross-store inventory slice; no
hook change needed. The new rule rides for free.

### §4 — Drill-down UX (per A4)

**Surface:** new modal component
`src/components/cmd/ExpiringItemsModal.tsx` (new file). Cmd UI atom
conventions — reuse `useCmdColors`, `Type`, `mono`/`sans`, `CmdRadius`,
`StatusPill`. Pattern reference: `IngredientFormDrawer.tsx` for the
backdrop-click-out modal shape on web/native; `AuditHistory.tsx` for
the per-row table layout.

**Props:**

```ts
interface ExpiringItemsModalProps {
  visible: boolean;
  storeName: string;
  detail: AttentionItem['expiryDetail'];   // undefined → render nothing
  onClose: () => void;
}
```

**Contents:**
- Header: "Expiring soon · {storeName}" + sev pill (`StatusPill` in
  the bucket's color: high=danger, med=warn, low=info) + close X.
- Subhead: `${items.length} items · $${totalDollarAtRisk.toFixed(2)}
  at risk`.
- Table (one row per item, sorted ascending by `hoursToExpiry`):
  - item name
  - days/hours to expiry as a human label (`'expired N days ago'` for
    negative, `'<24h'` / `'2 days'` / `'5 days'` etc. for positive)
  - dollar at risk (right-aligned, mono, tabular-nums)
  - unit
- Footer: just "esc to close" hint, matching IngredientFormDrawer.
- No "navigate to item" link in v1 — the modal is read-only; user can
  close and navigate manually. Add deep-link in a follow-up if the
  user requests it.

**Wiring in `DashboardSection.tsx`:**
- Add modal state `[expiryDrillDown, setExpiryDrillDown] = useState<{
  storeName: string; detail: AttentionItem['expiryDetail'] } | null>(null)`.
- Pass an `onSelectExpiry` callback into `<StoreCol />` props.
- Inside `StoreCol`, when rendering each queue row, if
  `item.rule === 'expiry'` wrap the row in `TouchableOpacity` and
  call `props.onSelectExpiry({ storeName: store.name, detail:
  item.expiryDetail })`. Other rule types stay non-clickable in v1.
- Render `<ExpiringItemsModal visible={!!expiryDrillDown}
  storeName={expiryDrillDown?.storeName ?? ''} detail={expiryDrillDown?
  .detail} onClose={() => setExpiryDrillDown(null)} />` once at the
  bottom of `DashboardSection`'s JSX (one modal serves all stores).
- Esc/close → sets state to `null`.

**Why a modal not a new section:** Spec 009's attention queue is the
existing alert affordance and the Cmd UI's two-pane sections
(InventoryDesktopLayout) don't have a slot for an "expiring" view
between items.tsv and catalog.tsv without a sidebar layout migration.
Modal is the lowest-cost surface that matches the existing alert
interaction. A dedicated section is a follow-up if expiry becomes a
daily workflow.

### §5 — Receiving screen UX (per A2 — narrowed)

Per §0 probe, the receiving screen is a Tier-1 mock. The narrowed
A2=(c) shape:

**On the line-items table (`ReceivingSection.tsx`'s `lineItems` map +
the row render around line 287):**
- Add a 5th data column: **"expires"** between `received` and `line $`,
  width ~80, mono. Renders the underlying `inventory_items.expiry_date`
  (already on the InventoryItem object) — formatted as a short date
  ("May 11"), or "—" when null.
- The existing `commitReceive` handler (line 93) — extend to **stamp
  expiry alongside the stock bump** when (a) the item has no current
  expiry and (b) the catalog row has `defaultShelfLifeDays != null`.
  Resolve the catalog row via `inventory.find(i => i.id ===
  li.id)?.catalogId` then `useStore.catalogIngredients.find(c => c.id
  === catalogId)?.defaultShelfLifeDays`. Compute via
  `computeExpiryFromShelfLife(new Date().toISOString().slice(0,10),
  shelfLife)`. Call `updateItem(item.id, { expiryDate: computed })` in
  the same optimistic batch as the `adjustStock`.
- No per-line override input (per §0 — would need `po_items` to land
  somewhere). Operator wanting to override goes to the IngredientForm
  drawer (§6) or the inventory list inline.

The "expires" column doubles as feedback — once `commitReceive` lands,
the row re-renders showing the newly-stamped date, so the operator can
see it auto-applied.

### §6 — Ingredient form UX (per A2)

Two field additions to `src/components/cmd/IngredientForm.tsx` and
`IngredientFormValues` (lines 21-44):

```ts
export interface IngredientFormValues {
  // ... existing
  defaultShelfLifeDays: string;    // text for input control; cast on save
  expiryDate: string;              // 'YYYY-MM-DD' or '' for none
}
```

**`blankValues()` updates:** `defaultShelfLifeDays: '', expiryDate: ''`.

**`fromItem()` (in `IngredientFormDrawer.tsx:23`) updates:** populate
`expiryDate` from `it.expiryDate || ''` and `defaultShelfLifeDays`
from the catalog row lookup (resolve via `it.catalogId` →
`useStore.catalogIngredients.find(c => c.id === it.catalogId)
?.defaultShelfLifeDays`).

**`toUpdates()` updates** (in `IngredientFormDrawer.tsx:39`): include
`expiryDate: v.expiryDate || undefined` in the `Partial<InventoryItem>`
returned. **`defaultShelfLifeDays` does NOT go into `toUpdates()` because
that helper writes to `inventory_items` only.** Catalog write goes
through a separate call:

```ts
// In IngredientFormDrawer's handleSave, after updateItem:
const catalogId = item?.catalogId;
const newShelfLife = parseInt(values.defaultShelfLifeDays, 10) || null;
const oldShelfLife = catalogIngredients.find(c => c.id === catalogId)
  ?.defaultShelfLifeDays ?? null;
if (catalogId && newShelfLife !== oldShelfLife) {
  // Optimistic: update local catalogIngredients slice, then call DB,
  // revert on error. Pattern match useStore's existing optimistic
  // mutations (e.g. addIngredientConversion at useStore.ts:~720s).
  updateCatalogIngredient(catalogId, { defaultShelfLifeDays: newShelfLife });
}
```

This requires a new useStore action `updateCatalogIngredient(catalogId,
patch)` mirroring the optimistic-then-revert + `notifyBackendError`
pattern of `updateItem`.

**Form layout** — add a new SectionCaption block between THRESHOLDS
and COSTING titled "EXPIRY · spec 010":

```
┌─ EXPIRY · spec 010 ────────────────────────────────────────┐
│ [ default shelf life (days)  ]    [ this row · expires    ]│
│   numeric, blank = no auto      ISO date or '—'            │
│   help: "Default applied on receipt; overridable per row." │
└────────────────────────────────────────────────────────────┘
```

Reuse the existing `InputLine` atom (from same file) for both. The
`expires` field uses `monoFont` and either accepts `YYYY-MM-DD` text
or — preferred — renders a native `<input type="date">` on web. Since
`InputLine` doesn't currently handle date type, the dev has two
options (their call):
- (a) Add a `dateOnly?: boolean` prop to `InputLine` that swaps the
  underlying `<input>` to type="date" on web, falling back to text
  validation on native.
- (b) Just accept `YYYY-MM-DD` text with a help string. Lower-effort,
  matches the existing form's "everything is a string until save".

PM lean: (b) for v1; promote to (a) if the user complains.

**No duplicate fields:** confirmed — there is no existing "shelf life"
or "use by days" or "expiry" field on `IngredientForm` today. The
form has a STUB block for `reorderPoint` / `max` (lines 36-38, 449-454)
that is read-only and disabled — leave those untouched, this is a
separate field.

### §7 — RLS impact

**N/A.** Confirmed:
- `catalog_ingredients` already has brand-scoped RLS from the brand-catalog
  refactor (P1-P5, 2026-05-04). Adding a column does not touch policies.
- `inventory_items` already has per-store RLS via
  `auth_can_see_store(store_id)` from
  `20260504173035_per_store_rls_hardening.sql:46-61`. The new
  `expires_at`-driven derivation is read-only on already-policy'd rows.
- No new tables → no new policies.
- No new edge functions → no service-token validation surface.
- Realtime publication: no membership change. The existing brand
  channel (catalog_ingredients) and store channel (inventory_items)
  replay every update under the existing debounced 400ms reload
  (`useRealtimeSync.ts`). N/A on the
  `docker restart supabase_realtime_imr-inventory` gotcha.

### §8 — Verification probes (post-impl, browser walk)

To run after `backend-developer` and `frontend-developer` land their
changes, against `npm run dev:db` local stack as
`admin@local.test / password`:

1. **Default shelf-life round-trip.** Open Inventory → pick any
   ingredient → IngredientFormDrawer → set "default shelf life (days)"
   to `5` → SAVE. Reopen the form. Field still says `5`. Open the SQL
   editor: `select default_shelf_life_days from catalog_ingredients
   where id = '<that-id>'` returns `5`.
2. **Receipt auto-compute.** Inventory section: confirm the chosen
   item has no `expiry_date` (blank in form). Receiving section → pick
   an "in flight" PO whose vendor matches the item → click the row to
   commit receive. Inventory list re-renders showing the item now has
   an expiry date `today + 5 days`.
3. **Manual override.** IngredientFormDrawer for the same item → edit
   "this row · expires" to a different date → SAVE. Confirm the new
   date persists across reload.
4. **High severity fires (<24h).** SQL editor: `update inventory_items
   set expiry_date = current_date where id = '<id>'`. Wait for the
   realtime channel to fire (debounced 400ms). Dashboard → store
   column → expiry alert with sev=high. Click it. Modal opens with
   that item, dollar-at-risk = current_stock × cost_per_unit.
5. **Med severity (72h).** SQL: `update inventory_items set
   expiry_date = current_date + interval '2 days' where id = '<id>'`.
   Dashboard re-renders, item drops into `med` row.
6. **Low severity (7d).** SQL: `update inventory_items set
   expiry_date = current_date + interval '5 days' where id = '<id>'`.
   Item drops into `low` row.
7. **Beyond 7d clears.** SQL: `update inventory_items set
   expiry_date = current_date + interval '14 days' where id = '<id>'`.
   Alert clears entirely.
8. **Reset.** SQL: `update inventory_items set expiry_date = null
   where id = '<id>'`. Alert stays cleared, no row in any bucket.
9. **Aggregate text shape.** SQL: bulk-update 3 items in one store to
   expire tomorrow. Dashboard renders `"3 items expiring <72h, $X at
   risk"` in the med bucket.
10. **Cross-store isolation (RLS).** Switch to a non-admin store
    member (if applicable) — confirm they see only their store's
    expiring items in the modal.

### §9 — Architect-level open flags

These are decisions the architect made that the user might want to
override — surface for review before/after the build:

1. **A2 narrowed.** Per-line expiry override on the receiving screen
   is **not** in scope for this spec because there's no `po_items`
   row to persist it on. The receiving screen gets the auto-stamp +
   display only. **Deviates from PM lean (c) which implied a per-line
   input.** If the user wants the override channel on receiving
   specifically (vs the IngredientForm), this needs a `po_items`
   schema spec first. PM was told this might come back; flagging
   explicitly here.
2. **Click-to-drill scope.** Only the new `expiry` rule rows get the
   click handler in v1. Other 4 alert types (`eod_missing`,
   `low_out_stock`, `food_cost_streak`, `unconfirmed_po`) stay
   click-inert. Broaden if the pattern reads well to the user.
3. **`expiry_date` stays `date`, not `timestamptz`.** Avoids a
   destructive type change. The 24h granularity is fine for
   restaurant-prep horizons. If sub-day precision becomes needed
   (e.g., line-cooked items expiring within a shift), a follow-up
   migration can `alter column type` with USING.
4. **Already-expired items roll into `high`.** Spec is silent on
   this; the literal reading of "≤ 24h" includes ≤ 0h. The modal
   shows actual hours so the operator can see "expired 2 days ago"
   distinctly. Could split into a 4th `'critical'` severity if the
   user wants the visual distinction.
5. **No notification push.** This spec adds an in-app alert only.
   No edge-function-driven push/email reminder for expiring items.
   That's a follow-up if managers don't notice in-app.

## Build notes

### Backend pass

Implementation (2026-05-08, backend slice). Frontend slice runs in
parallel; this section covers only the backend-developer ownership
items called out in the architect's Handoff.

**Migration filename + apply output.** Picked timestamp
`20260508130000` — sorts after Spec 008's `20260508120000` and after
the unrelated 003/006 unapplied migrations (which I did NOT run; not
this spec's scope). New file:
`supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql`.
Single additive `alter table public.catalog_ingredients add column if
not exists default_shelf_life_days int` plus a column comment. Applied
locally via `docker exec ... psql < migration` then recorded in
`supabase_migrations.schema_migrations` so the local tracker stays in
sync. Verified post-apply:

```
column_name             | data_type | is_nullable
default_shelf_life_days | integer   | YES
```

Round-trip write/read also confirmed via psql on the first
catalog_ingredients row (`'#1 Togo Box'` → set to 5, then nulled).
**Did NOT push to prod (`supabase db push --linked`) per the prompt's
DO-NOT list — that's a separate user-authorized gate.**

**Type extensions.**
- `CatalogIngredient.defaultShelfLifeDays?: number | null` added in
  `src/types/index.ts:46`. Optional with explicit-`null` semantics so
  the mapper coerces `undefined` → `null` for shape stability.
- `AttentionItem.rule` widened with `'expiry'`; new optional
  `expiryDetail` snapshot field added in `src/lib/cmdSelectors.ts:644`
  (the type lives in cmdSelectors, not types/index, per architect's
  §3). Snapshot shape is JSON-serializable per the design — frontend
  reads it directly to render the modal without re-deriving. **This is
  the coordination point for frontend-dev** — the modal in
  `ExpiringItemsModal.tsx` reads `detail.items[]` and
  `detail.totalDollarAtRisk`.

**db.ts mapper updates.**
- `fetchCatalogIngredients` (db.ts:1572) now maps
  `default_shelf_life_days` → `defaultShelfLifeDays` (with `Number()`
  coerce + null-safety).
- New `updateCatalogIngredient(catalogId, patch)` (db.ts:~1592) — thin
  wrapper around `supabase.from('catalog_ingredients').update`; only
  honors known patch keys today (`defaultShelfLifeDays`); auto-stamps
  `updated_at`. Returns `Promise<void>` to mirror `updateInventoryItem`
  rather than the `IngredientConversion`-style "return saved row"
  shape — the optimistic-revert pattern in useStore doesn't need the
  echo for catalog metadata.
- New pure helper `computeExpiryFromShelfLife(receivedAtISO,
  defaultShelfLifeDays)` (db.ts:~1620) — returns 'YYYY-MM-DD' or null.
  Smoke-tested 8 cases (null/undefined shelf life, negative, NaN,
  garbage date, 0/3/5 days, full ISO timestamp input). Lives in db.ts
  per architect's PM-equivalent suggestion (§2: "adjacent to mapItem
  since it's a one-liner used in exactly one place").

**useStore changes.** Added `updateCatalogIngredient` action
(useStore.ts:~474) — snapshot prev catalogIngredients slice, mutate
local, on error revert + `notifyBackendError('Update catalog
ingredient', e)`. Mirrors the `updateIngredientConversion` pattern
(useStore.ts:553) since both touch a brand-level slice rather than
the per-row inventory pattern. No audit-log entry (catalog metadata
diffs aren't operator-facing).

**cmdSelectors extension.**
- New constants `EXPIRY_HIGH_HOURS=24`, `EXPIRY_MED_HOURS=72`,
  `EXPIRY_LOW_HOURS=168` exported alongside `TARGET_FOOD_COST_PCT_DEFAULT`.
- New rule body inserted between `unconfirmed_po` and the final sort
  in `computeAttentionQueue`. Builds three buckets, one queue row per
  non-empty bucket. Uses `noun = items.length === 1 ? 'item' : 'items'`
  for grammar; `Math.round` on the dollar in the queue text per design
  (the modal shows precise via `dollarAtRisk: +(...).toFixed(2)`).

**Deviation from architect's design — date parsing.** Architect's §3
pseudocode had `new Date(item.expiryDate)` then `.setHours(23,59,59,999)`.
That treats the date string as UTC midnight and then end-of-day in
*local* time — which double-shifts and breaks the "expires today" =
"you have until close" semantic on machines outside UTC. Verified via
node REPL: at 10am local time on a UTC-4 box, `new Date('2026-05-08')`
+ `setHours(23,59,59)` lands at `2026-05-08T03:59:59Z` (i.e. negative
relative to "now"). Replaced with explicit local-time construction:

```ts
const m = String(item.expiryDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
if (!m) continue;
const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
```

This honors the architect's stated intent and matches `isPastDeadline`
(cmdSelectors.ts:700-701) which is the file's existing local-clock
helper. Surfacing as a deviation per the prompt — it's a correctness
fix, not a redesign.

**STOP conditions.** All cleared:
- `InventoryItem.expiryDate?` exists at `src/types/index.ts:68` ✓
- `inventory_items.expiry_date` column exists in init schema ✓
- `catalog_ingredients` had no pre-existing `default_shelf_life_days`
  column (verified via `information_schema.columns`) ✓
- Receive-time auto-stamp hook is the existing
  `commitReceive(lid)` in `ReceivingSection.tsx:93` (frontend-dev's
  call to make), and the helper `computeExpiryFromShelfLife` plus
  `updateItem({ expiryDate })` give it everything it needs — confirmed
  in the architect's §5 narrowed shape.

**What's NOT done (frontend-dev's slice — flagged for coordination).**
- `src/components/cmd/IngredientForm.tsx` form field additions.
- `src/components/cmd/IngredientFormDrawer.tsx` `fromItem` / `toUpdates`
  / save-handler wiring of `updateCatalogIngredient`.
- `src/components/cmd/ExpiringItemsModal.tsx` (new modal).
- `src/screens/cmd/sections/DashboardSection.tsx` modal state + click
  wiring on `expiry` rows only.
- `src/screens/cmd/sections/ReceivingSection.tsx` "expires" column +
  auto-stamp branch in `commitReceive`.

**Browser-preview verification.** Bundle compiles
(`/node_modules/expo/AppEntry.bundle?...` returns 200 from
`http://localhost:8082`). No browser-interaction probe — Chrome MCP
not loaded in this session and computer-use is "read"-only on
browsers; the in-browser dashboard alert can't be visually verified
without seeded `expiry_date` values + frontend-dev's modal landing.
The §8 verification probes (admin@local.test, set expiry via SQL,
watch the bucket fire) will run as part of the post-frontend-pass
review per the spec's standard gate.

## Files changed (planned)

Backend developer:
- `supabase/migrations/20260506120000_expiry_tracking.sql` (new)
- `src/lib/db.ts` (extend `fetchCatalogIngredients` mapping; add
  `updateCatalogIngredient`; add `computeExpiryFromShelfLife`)
- `src/types/index.ts` (add `defaultShelfLifeDays` to
  `CatalogIngredient`)
- `src/store/useStore.ts` (add `updateCatalogIngredient` action with
  optimistic-then-revert)
- `src/lib/cmdSelectors.ts` (extend `AttentionItem`, add `EXPIRY_*`
  constants, extend `computeAttentionQueue` with the expiry rule)

Frontend developer:
- `src/components/cmd/IngredientForm.tsx` (add EXPIRY section with two
  new fields; extend `IngredientFormValues` + `blankValues()`)
- `src/components/cmd/IngredientFormDrawer.tsx` (extend `fromItem` /
  `toUpdates`; wire new `updateCatalogIngredient` call on save)
- `src/components/cmd/ExpiringItemsModal.tsx` (new)
- `src/screens/cmd/sections/DashboardSection.tsx` (modal state, pass
  `onSelectExpiry` to `StoreCol`, render `<ExpiringItemsModal />`,
  wrap expiry queue rows in `TouchableOpacity`)
- `src/screens/cmd/sections/ReceivingSection.tsx` (add "expires"
  column, extend `commitReceive` with the auto-stamp branch)

### Backend slice

Migrations:
- `supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql`
  (new) — additive `int` column on `catalog_ingredients`. Architect's
  planned filename `20260506120000_expiry_tracking.sql` was bumped to
  `20260508130000` to sort after Spec 008's `20260508120000` migration
  per the prompt's "later than 20260508120000" requirement, and
  renamed to namespace with the `spec010_*` convention used by recent
  migrations.

Types:
- `src/types/index.ts` — `CatalogIngredient.defaultShelfLifeDays?:
  number | null` added.

Backend lib (db.ts):
- `src/lib/db.ts` — `fetchCatalogIngredients` map extended with
  `defaultShelfLifeDays` mapping; new `updateCatalogIngredient`
  helper; new pure helper `computeExpiryFromShelfLife`.

Selectors:
- `src/lib/cmdSelectors.ts` — `AttentionItem.rule` widened with
  `'expiry'`; new optional `expiryDetail` snapshot field;
  `EXPIRY_HIGH_HOURS` / `EXPIRY_MED_HOURS` / `EXPIRY_LOW_HOURS`
  constants exported; new expiry rule body inserted into
  `computeAttentionQueue` between `unconfirmed_po` and the final
  sort.

Store:
- `src/store/useStore.ts` — new `updateCatalogIngredient` action
  (optimistic-then-revert with `notifyBackendError`); imports
  `CatalogIngredient` from `../types` for the snapshot type
  annotation.

### Frontend pass

Implementation (2026-05-08, frontend slice). Backend slice landed
first; this pass consumes the `AttentionItem.expiryDetail` snapshot
shape and the new `updateCatalogIngredient` store action exactly as
shipped — no shape negotiation needed.

**IngredientForm.tsx.** Added `defaultShelfLifeDays: string` and
`expiryDate: string` to `IngredientFormValues`; both default to `''`
in `blankValues()`. New `EXPIRY · spec 010` SectionCaption block sits
between THRESHOLDS and COSTING. Two `InputLine`s side-by-side at 50%
width each — `default shelf life (days)` (numericOnly, branded
"brand-wide · auto-applied on receipt") + `this row · expires`
(YYYY-MM-DD text per architect §6 option (b), "lower-effort, matches
the existing form's everything-is-a-string-until-save" — option (a)
date-input promotion deferred per the PM lean). On NEW mode the
per-row expiry input is hidden because the inventory_items row doesn't
exist yet — auto-stamp applies on first receipt instead.

**IngredientFormDrawer.tsx.** `fromItem` widened to take
`defaultShelfLifeDays: number | null | undefined` (caller resolves via
`catalogIngredients.find(c.id === item.catalogId)?.defaultShelfLifeDays`)
and populates both `defaultShelfLifeDays` (stringified) and
`expiryDate` (from the row). `toUpdates` includes
`expiryDate: v.expiryDate ? v.expiryDate : undefined` so an empty
input clears the date, matching the existing "blank string → undefined
patch" convention. New `catalogRow` useMemo + `updateCatalogIngredient`
zustand subscription hooked in. `handleSave` extension — after the
`updateItem` for `inventory_items`, compute `newShelf = parseInt('')`
→ NaN coerce to null vs `oldShelf` from the catalog row; if changed,
call `updateCatalogIngredient(catalogId, { defaultShelfLifeDays:
newShelf })`. Architect-spec'd no-op when unchanged so we don't
generate spurious DB writes on every save.

**ExpiringItemsModal.tsx (new).** Per architect §4 — read-only
drill-down opened from per-store attention queue rows. Shape:
centered `Modal` with backdrop click-out (matches `AddCountModal`),
header (storeName + sev `StatusPill` mapped to out/low/info for
high/med/low + close X), subhead (item count + total `$ at risk`),
column headers (`item / expires in / unit / $ at risk`), and a
scrollable item table sorted by ascending `hoursToExpiry`.
`formatHours()` helper renders human-readable labels: negative →
"expired N days ago" / "expired today"; positive → "<24h" / "Nh" /
"~1 day" / "N days". Esc-to-close on web. No "navigate to item"
link in v1 per architect §4 ("Add deep-link in a follow-up if the
user requests it"). Reads `detail.items[]` and
`detail.totalDollarAtRisk` directly from the snapshot — does not
re-derive.

**DashboardSection.tsx.** Imported `ExpiringItemsModal` +
`TouchableOpacity`. New component-level state
`expiryDrillDown: { storeName, detail } | null`. Passed
`onSelectExpiry` callback into `<StoreCol />`. Modal rendered once at
the bottom of the section JSX (one modal serves all per-store columns
per architect §4). `StoreColProps` extended with `onSelectExpiry`.
The queue-row render now wraps each row in `TouchableOpacity` only
when `item.rule === 'expiry' && !!item.expiryDetail` (other rule
types stay click-inert per architect §9 flag #2). Clickable rows get
a small `→` indicator on the right edge so the affordance is visible
without changing the existing visual rhythm.

**ReceivingSection.tsx.** Imported `computeExpiryFromShelfLife` from
`db.ts` + new `catalogIngredients` and `updateItem` zustand
subscriptions. The synthetic `lineItems` map now includes
`expiryDate: i.expiryDate` (read from the underlying inventory row).
New "expires" column added to the line-items table header (between
`received` and `line $`, width 80) and each row, formatted via a
small `shortExpiry` helper ("May 11" / "—"). `commitReceive` extended
with the auto-stamp branch per architect §5: when the row has no
`expiryDate` AND the catalog row has a non-null `defaultShelfLifeDays`,
compute `today + shelfLife` via `computeExpiryFromShelfLife` and call
`updateItem(item.id, { expiryDate: computed })` alongside the existing
`adjustStock`. The "expires" column in that row's next render reflects
the auto-stamped date — operator sees the side effect immediately.

**Browser-preview verification gap.** Preview/Chrome MCP tools are
not loaded in this session and computer-use is "read"-tier on
browsers, so the §8 verification probes (set
`default_shelf_life_days = 5` → save → reload → field persists, then
trigger receive → confirm `expires_at` auto-stamps, then mutate to
<72h → confirm dashboard alert + click → modal opens) could not be
exercised here. The dev server is running (`http://localhost:8082` →
200) and the local DB has the migration applied
(`information_schema.columns` confirms `default_shelf_life_days
integer YES`). Typecheck on the touched files is clean
(`npx tsc --noEmit | grep -E 'IngredientForm|IngredientFormDrawer|
ExpiringItemsModal|DashboardSection|ReceivingSection'` returns
nothing). **The browser walk-through from §8 must run as part of the
review pass.**

## Cleanup bundle (applied 2026-05-08, pre-commit)

Applied inline after release-coordinator returned **SHIP_READY** with two
Should-fix items called out by code-reviewer + post-impl architect.

- **Item 1** — `src/components/cmd/IngredientFormDrawer.tsx:62`. Changed
  `expiryDate: v.expiryDate ? v.expiryDate : undefined` to
  `expiryDate: v.expiryDate || null`. Without the change, blanking the
  THIS ROW EXPIRES input silently kept the previous date because the
  PATCH mapper in `src/lib/db.ts` skips `undefined` fields. Verified in
  browser: opened Dish Detergent (had `2026-05-09`), blanked input,
  saved, reopened — value persists empty. ✅
- **Item 2** — `src/screens/cmd/sections/ReceivingSection.tsx:129-141`.
  Replaced `new Date().toISOString().slice(0, 10)` (UTC-today) with
  local-component construction mirroring the canonical pattern at
  `src/lib/cmdSelectors.ts:886-888`. Same Spec 007 TZ class — at the
  exact moment of fix verification (Fri May 08 2026 23:02:44 EDT), the
  old code returned `2026-05-09` (UTC-tomorrow) while the new code
  returned `2026-05-08` (correct local-today). The bug was real: at
  any local time past the UTC boundary, Receiving auto-stamp would
  use tomorrow's date as the basis for shelf-life math, pushing the
  computed expiry one day further out than intended. ✅

## Apply log (2026-05-08)

User authorized prod push at 2026-05-08 (after cleanup bundle landed
and was browser-re-verified against the expo-web preview).

Ran:

    npx supabase db push --linked

Output: applied `20260508130000_spec010_catalog_default_shelf_life.sql`
to the linked prod project (`ebwnovzzkwhsdxkpyjka`). Single statement,
additive, idempotent.

§5 post-apply verification probes (all green):

1. **Column exists.** `information_schema.columns` confirms
   `public.catalog_ingredients.default_shelf_life_days` is `integer`,
   nullable, default NULL. ✅
2. **Backfill check.** 144 catalog rows total, 0 with shelf-life set,
   144 NULL. Clean additive landing — no surprise data, no operator
   work needed before the column becomes useful. ✅
3. **Migration ledger.** Registered in prod as `20260508130000 /
   spec010_catalog_default_shelf_life`. ✅
4. **Security advisor.** Zero new lints from the migration. The new
   column inherits `catalog_ingredients`' existing RLS exactly as
   designed (the migration adds no policy, per architect §7). All
   listed warnings are pre-existing and unrelated to this change. ✅

## Handoff
next_agent: backend-developer, frontend-developer
prompt: |
  Implement Spec 010 (Expiry tracking & spoilage alerts) against the
  ## Backend design section. Split ownership:

  Backend developer owns:
    - The new migration (`20260506120000_expiry_tracking.sql`).
    - All `src/lib/db.ts` changes (fetchCatalogIngredients map extend,
      updateCatalogIngredient new helper, computeExpiryFromShelfLife
      pure helper).
    - `src/types/index.ts` `CatalogIngredient` field add.
    - `src/store/useStore.ts` new `updateCatalogIngredient` action with
      optimistic-then-revert + `notifyBackendError`.
    - `src/lib/cmdSelectors.ts` AttentionItem type extend, EXPIRY_*
      constants, computeAttentionQueue rule body per §3.

  Frontend developer owns:
    - `src/components/cmd/IngredientForm.tsx` — new EXPIRY section,
      IngredientFormValues + blankValues extends per §6.
    - `src/components/cmd/IngredientFormDrawer.tsx` — fromItem /
      toUpdates extends; call the new useStore.updateCatalogIngredient
      action on save when shelf-life changed.
    - `src/components/cmd/ExpiringItemsModal.tsx` — new, per §4.
    - `src/screens/cmd/sections/DashboardSection.tsx` — modal state,
      onSelectExpiry callback, StoreCol queue-row TouchableOpacity
      wrap (only for rule==='expiry') per §4.
    - `src/screens/cmd/sections/ReceivingSection.tsx` — "expires"
      column, commitReceive auto-stamp branch per §5.

  Coordinate on the `AttentionItem` type shape (backend lands the
  type extension first; frontend consumes `expiryDetail`).

  Per §8, run the verification probes in browser via the
  preview/Chrome MCP after typecheck passes. Do NOT skip the realtime
  round-trip checks — they're the highest-risk area (catalog
  realtime is in the brand channel, inventory is in the store
  channel; expiry mutations on inventory should fire the per-store
  attention queue recompute via the existing 400ms debounce).

  After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed. Reviewer fan-out follows.
payload_paths:
  - specs/010-attention-queue-phase-2.md
  - specs/009-dashboard-v2.md
  - src/lib/cmdSelectors.ts
  - src/lib/db.ts
  - src/store/useStore.ts
  - src/types/index.ts
  - src/components/cmd/IngredientForm.tsx
  - src/components/cmd/IngredientFormDrawer.tsx
  - src/screens/cmd/sections/DashboardSection.tsx
  - src/screens/cmd/sections/ReceivingSection.tsx
