# Spec 105: Par-status indicators on the inventory-count history detail

Status: READY_FOR_REVIEW

> **Owner sign-off complete.** All five open questions (OQ-1..OQ-5) are
> resolved — see "Open questions resolved". The most consequential decision
> is **OQ-2**: the owner chose the REAL reorder math inline (suggested cases
> + usage-forecast + next-delivery timing), NOT the lightweight par-gap hint
> the DRAFT body was written against. This flips the feature from
> frontend-only into **backend-touching** and reopens the DRAFT's "do NOT
> duplicate the reorder engine" stance. **The architect owns the key design
> decision:** how to source on-hand for the reorder suggestion when the
> engine currently computes on-hand from `current_stock`/EOD, not from an
> arbitrary counted value. See OQ-2 below and the ⚠ ARCHITECT FORK block.

## User story

As a store manager reviewing a past inventory count in the history detail,
I want each item row marked against its par level — a green check when the
counted total was at or above par, and a red "needs to order" indicator with
the ACTUAL reorder suggestion (suggested cases, usage-forecast, next-delivery
timing) when it was below — so that I can see at a glance which items were
short at the time I look at the record AND what I would have ordered given
that count, without hand-comparing each row to par or opening the reorder
screen.

## Acceptance criteria

Scope note: all criteria target the **read-only history detail view**
(`DetailFrame` → `entries.tsv` table) in
`src/screens/cmd/sections/InventoryCountSection.tsx`. The live count form
(`count.tsx`) and the EOD count are explicitly out of scope (OQ-3).

- [ ] Each entry row in the `entries.tsv` detail table renders a par-status
      indicator derived from comparing the entry's counted total
      (`InventoryCountEntry.actualRemaining`) against the item's **current**
      par level (OQ-1).
- [ ] **At/above par** (`actualRemaining >= parLevel`, with a par > 0):
      row shows a **green check (✓)** indicator inline on the item/total
      cell (OQ-5). No reorder suggestion text.
- [ ] **Below par** (`actualRemaining < parLevel`, with a par > 0):
      row shows a **red** dot inline on the item/total cell (OQ-5) plus an
      inline reorder suggestion rendered in the NOTE area / an inline cell
      (NO new column — the 5-column phone layout ITEM | CASES | LOOSE UNITS
      | TOTAL | NOTE is preserved). The suggestion is the **actual reorder
      math** (OQ-2), not a raw par-gap: suggested cases + usage-forecast +
      next-delivery timing, the same fields the Reorder screen surfaces
      (`ReorderSection.tsx` / `report_reorder_list`).
- [ ] The reorder suggestion for a below-par row is computed using **the
      counted total (`actualRemaining`) as the on-hand basis** — the count
      IS the on-hand snapshot for that record — combined with **live**
      usage-forecast and **live** next-delivery schedule. Semantic to pin:
      "what you'd have ordered given this count." This MIXES historical
      on-hand with live forecast/timing; the caveat MUST be surfaced to the
      manager (see the "current par" / basis caption criterion below).
- [ ] **⚠ ARCHITECT-OWNED (OQ-2 fork):** `report_reorder_list` currently
      derives on-hand from `current_stock`/EOD, so it CANNOT be fed "the
      counted total from this history record" as-is. The architect decides
      HOW to source the counted on-hand — one of:
      (a) parameterize/extend `report_reorder_list` (or a sibling RPC) to
      accept a caller-supplied on-hand; (b) a new focused RPC that takes the
      counted on-hand and returns the reorder suggestion; or (c) replicate
      the `par_replacement` / `usage_forecasted` / `suggested_cases` math
      client-side. The architect's design doc names the chosen path and the
      resulting shape (RPC signature or client util contract). Acceptance of
      THIS criterion is: the design doc pins one path and the implementation
      matches it. The DRAFT's "do not duplicate the engine" line is
      explicitly REOPENED by this decision — option (c) is now permissible if
      the architect judges it the right call.
- [ ] **No par set** (`parLevel <= 0`, or the item is not resolvable — see
      below): **no indicator** is drawn for that row (OQ-4). No ✓, no red
      dot, no reorder suggestion. The row renders exactly as it does today.
- [ ] **Item no longer resolvable** (the entry's `itemId` has no matching
      row in the store's current `inventory`, e.g. the item was deleted
      since the count): treated as "no par" → **no indicator**, no crash,
      no error toast, no reorder call for that row. The existing columns
      still render from the entry's own persisted fields.
- [ ] The par comparison uses the item's **current** `parLevel` (OQ-1),
      joined client-side from the Zustand `inventory` array by
      `entry.itemId`. No new fetch and no migration are introduced *for the
      par join*. (The reorder suggestion in OQ-2 may introduce a backend
      call — that is the architect's fork, separate from this par-join
      criterion.)
- [ ] The indicator + suggestion are **read-only display** — no button, no
      write, no mutation. If OQ-2 resolves to an RPC, that RPC is a
      read-only report call (like `report_reorder_list`), not a write.
- [ ] `actualRemaining == null` on an entry (no total recorded) →
      **no indicator** and **no reorder call** (nothing to compare / no
      on-hand basis); row renders as today.
- [ ] When par-at-count-time differs from current par, the indicator
      reflects **current** par (accepted caveat of OQ-1). A one-line
      caption on the detail header notes (a) the par comparison is against
      **current par**, and (b) the reorder suggestion mixes this record's
      counted on-hand with **live** usage-forecast + delivery timing — so
      the manager isn't misled into thinking either is a pure point-in-time
      value. Exact caption copy is architect/frontend choice, but it MUST
      state both: current-par basis AND live-forecast/timing basis.
- [ ] Indicator colors come from Cmd palette tokens (`useCmdColors()`):
      green from the existing "ok" token, red from the existing "danger"
      token. No hard-coded hex.
- [ ] Existing `entries.tsv` columns (ITEM | CASES | LOOSE UNITS | TOTAL |
      NOTE) and their values are unchanged, and **no 6th column is added**
      (OQ-5 — phone layout preserved). The indicator is a ✓/red dot inline
      on an existing cell; the reorder suggestion renders inline (NOTE area
      / inline cell).
- [ ] Jest: a component/unit test covers the three states (at/above par →
      green ✓, below par → red + reorder suggestion, no par → no indicator)
      plus the unresolvable-item and null-total edge cases. If OQ-2 resolves
      to a new/parameterized RPC, the reorder-suggestion path is exercised
      with a mocked RPC response; if OQ-2 resolves to client-side
      replication, the math util is unit-tested against known par /
      usage-forecast / schedule inputs. Track: **jest** (see
      `tests/README.md`).
- [ ] If OQ-2 resolves to a new or parameterized **RPC** (options a/b), a
      **pgTAP** DB test covers the counted-on-hand parameter path — that the
      RPC returns the expected `suggested_cases` / forecast shape when fed a
      supplied on-hand, and respects `auth_can_see_store()`. Track: **pgTAP**
      (see `tests/README.md`). (No pgTAP if OQ-2 resolves to pure client-side
      replication with no DB change — architect confirms which in the design
      doc.)

## In scope

- A par-status indicator (✓ green / red dot) inline on each row of the
  read-only history detail `entries.tsv` table, computed client-side by
  joining the entry's `itemId` to the store's current `inventory` (which
  already carries `parLevel`, `caseQty`, `unit`).
- For **below-par** rows: the **actual reorder suggestion** shown inline —
  suggested cases + usage-forecast + next-delivery timing — using the
  counted total as the on-hand basis and live forecast/schedule (OQ-2). The
  mechanism (RPC parameterization / new RPC / client-side replication) is the
  architect's decision.
- Three visual states: at/above par (green ✓), below par (red + inline
  reorder suggestion), no-par / unresolvable / null-total (no indicator).
- A header caption on the detail view clarifying (a) the par comparison is
  against **current** par and (b) the reorder suggestion uses **live**
  forecast/timing over this record's counted on-hand.
- Jest coverage of the three states + the two edge cases, and (conditionally)
  pgTAP coverage if OQ-2 lands as a DB change.

## Out of scope (explicitly)

- **The live count form (`count.tsx` tab).** Adding par status to the active
  data-entry screen is a follow-up (OQ-3). Different UX (live, as-you-type).
- **The EOD count and the staff weekly count.** Different app surface
  (`src/screens/staff/`), different data path (spec 063 carve-out). Follow-up
  per OQ-3.
- **A muted "no par set" pill.** No-par / unset-par rows get NO marker at all
  (OQ-4) — not even an explicit "no par" affordance.
- **A 6th indicator column.** Placement is inline on existing cells (OQ-5);
  the 5-column phone layout is preserved. No dedicated PAR column.
- **A "→ Reorder" navigation link** from the detail row. The owner chose the
  inline real suggestion (OQ-2), not a jump-to-screen link. No nav target
  added to `ReorderSection`.
- **Any $ / cost figure.** This is a quantity/par/order-count feature. No
  cost display, so spec 104's per-each cost basis is not engaged. (Called out
  only to confirm it stays out — note the reorder engine may internally use
  cost, but this feature surfaces only quantity/timing fields.)
- **Persisting par into the count entry** (par-snapshot). OQ-1 resolved to
  CURRENT par via client-side join — no par column added to the count entry,
  no write-path change, no backfill.
- **Sorting / filtering the detail table by par status**, badge counts of
  below-par items, export of the indicator or the reorder suggestion. Not
  requested.
- **Realtime.** The detail view is a point-in-time historical record; par or
  forecast changing live mid-view does not need to push. No new channel.
  (The reorder suggestion is computed on view/open with then-current live
  forecast — it does not subscribe to updates.)

## Open questions resolved

- **OQ-1 — Which par? → CURRENT par.** Client-side join
  `entry.itemId → inventory_items.parLevel` against the active-store
  `inventory` array in the Zustand store. No migration, no new fetch for the
  par value. Accepted caveat: re-opening an old count re-colors as par
  drifts — mitigated by a "vs current par" caption so the basis is honest.

- **OQ-2 — What is the "how many"? → REAL reorder math inline.** For each
  below-par entry, show the ACTUAL reorder suggestion (suggested cases +
  usage-forecast + next-delivery timing — the same logic the Reorder screen
  uses), NOT the lightweight par-gap hint the DRAFT body assumed. This
  reopens the DRAFT's "do not duplicate the reorder engine" stance and makes
  the feature backend-touching.

  > **⚠ ARCHITECT FORK — key design decision for this spec.**
  > `report_reorder_list` computes on-hand from `current_stock`/EOD, NOT from
  > an arbitrary supplied value, so it cannot be fed "the counted total from
  > this history record" as-is. The architect must decide HOW to source the
  > counted on-hand:
  > - **(a)** parameterize/extend `report_reorder_list` (or a sibling RPC) to
  >   accept a caller-supplied on-hand;
  > - **(b)** a new focused RPC that takes the counted on-hand and returns the
  >   reorder suggestion;
  > - **(c)** replicate the `par_replacement` / `usage_forecasted` /
  >   `suggested_cases` math client-side.
  >
  > **Semantic the architect MUST pin:** the reorder suggestion uses **the
  > counted total (`actualRemaining`) as the on-hand basis** (the count IS the
  > on-hand snapshot for that record) combined with **live** usage-forecast +
  > **live** next-delivery schedule — i.e. "what you'd have ordered given this
  > count." This MIXES historical on-hand with live forecast/timing; the
  > design doc documents that caveat and the user-facing caption surfaces it.
  > Options (a)/(b) pull in a pgTAP DB test; option (c) is jest-only. The
  > design doc names the path, the exact shape (RPC signature or client util
  > contract), and which test track applies.

- **OQ-3 — Scope? → History detail only (v1).** The screenshotted read-only
  `DetailFrame` view. The live count form (`count.tsx`) and the EOD count are
  explicit follow-ups, not this spec.

- **OQ-4 — No-par items (par 0 / unset)? → No marker.** Rows whose current
  `parLevel <= 0`, or whose item is not resolvable, get NO indicator — no ✓,
  no red dot, no reorder suggestion. Row renders exactly as today.

- **OQ-5 — Display form + placement? → Inline on the row, no new column.**
  A ✓ (green) / red dot on the item/total cell, and the reorder suggestion
  shown inline (e.g. in the NOTE area / an inline cell). The 5-column phone
  layout (ITEM | CASES | LOOSE UNITS | TOTAL | NOTE) is preserved — NO 6th
  column.

## Dependencies

- **Par join (OQ-1): no migration, no new fetch.** `fetchInventoryCount`
  already returns `entries[]` with `itemId`, `actualRemaining`, `unit`; the
  Zustand `inventory` array already carries `parLevel` / `caseQty` / `unit`
  per item.
- **Reorder suggestion (OQ-2): backend-touching — architect's fork.** Depends
  on the existing reorder engine (`report_reorder_list`,
  `ReorderSection.tsx`). One of:
  - (a) a parameterized/extended `report_reorder_list` or sibling RPC (new
    optional on-hand parameter) — **migration + pgTAP + backend-developer**;
  - (b) a new focused read-only RPC taking counted on-hand — **migration +
    pgTAP + backend-developer**;
  - (c) client-side replication of `par_replacement` / `usage_forecasted` /
    `suggested_cases` — **no migration; frontend-developer; jest-only**, but
    the architect must confirm all inputs (usage-forecast window, delivery
    schedule) are already available client-side or fetchable read-only.
- Existing types: `InventoryCountEntry` (`src/types/index.ts:388`),
  `InventoryItem` (`src/types/index.ts` — `parLevel`, `caseQty`).
- Cmd palette tokens via `useCmdColors()` (existing ok/danger tokens).
- Touch points: `DetailFrame` in
  `src/screens/cmd/sections/InventoryCountSection.tsx` (detail row map at
  ~lines 1465-1524; column header at ~lines 1390-1464); the reorder engine in
  `ReorderSection.tsx` / `report_reorder_list` (for the OQ-2 math source).

## Project-specific notes

- **Cmd UI section / legacy:** Admin Cmd UI —
  `src/screens/cmd/sections/InventoryCountSection.tsx`, `DetailFrame`. No
  legacy surface (spec 025 deleted it).
- **Per-store or admin-global:** Per-store. The history detail is only
  reachable with a single store selected; count rows are store-scoped and
  reads already flow through `auth_can_see_store()` RLS. The par join re-uses
  `inventory` already loaded for the active store — no new data access. If
  OQ-2 lands as an RPC, that RPC MUST respect `auth_can_see_store()` for the
  store the count belongs to (and pgTAP must assert it).
- **Edge function or PostgREST?** If OQ-2 resolves to an RPC (options a/b),
  it is a Postgres RPC called via `src/lib/db.ts` (mirroring how
  `report_reorder_list` is invoked), NOT an edge function. Read-only report
  call, JWT-protected by default.
- **Realtime channels touched:** None. Point-in-time historical view; no new
  subscription. The reorder suggestion is computed on open with then-current
  live forecast; it does not subscribe. (The section already owns an
  `inventory_counts` subscription for the recent-list refresh — untouched.)
- **Migrations needed:** Depends on OQ-2. No migration for the par join
  (OQ-1). Migration YES if OQ-2 → (a) parameterized RPC or (b) new RPC;
  NO if OQ-2 → (c) client-side replication. Architect confirms in the design
  doc.
- **Edge functions touched:** None.
- **Web/native scope:** Both web and native — display-only change in a shared
  RN component using existing tokens; no web-only API. Frontend confirms the
  inline indicator + inline reorder suggestion lay out on the phone
  breakpoint (`useIsPhone`) without breaking the current 5-column detail
  table.
- **Tests:** jest track always (three states + two edge cases; reorder path
  with mocked RPC or unit-tested math util). pgTAP track additionally IF
  OQ-2 lands as a DB change (a/b) — covering the counted-on-hand parameter
  path and `auth_can_see_store()`. Architect pins which tracks apply.
- **`app.json` slug:** Not touched. (No build-identifier / push-cert surface
  in this feature.)

## Backend design

### OQ-2 decision — the one decision that matters

**Chosen path: (b) — a NEW focused, read-only sibling RPC**
`public.report_reorder_for_counted_onhand(p_store_id uuid, p_on_hand jsonb, p_params jsonb)`
that takes the store + a caller-supplied `{item_id → counted_on_hand}` map
and returns per-item reorder math keyed by `item_id`. **Not** (a), **not** (c).

**Why not (a) — parameterize `report_reorder_list`.** The engine's on-hand is
not a single overridable value; it is a three-branch `CASE` (A/B/C) inside the
`item_on_hand` CTE (`…_multi_vendor.sql:231-269`) that is computed per
`(item, vendor)` after the `item_vendors` explosion (spec 102 Hunk 1), then
threaded through **eleven** downstream CTEs that all key on `(vendor_id,
item_id)`. To inject counted on-hand you would branch that `CASE` on a
`p_on_hand` param and touch the load-bearing core of a ~600-line RPC that five
specs (087/088/100/102/104) layered onto — each with a pgTAP suite
(`report_reorder_list_cases`, `_i18n_names`, the per-each cost suites) that
would have to keep passing. Worse, the return shape is **vendor-grouped and
item-exploded**: a shared item appears under N vendor cards, but this feature
needs exactly ONE suggestion per count-entry `item_id`. Consuming the full
vendor envelope and de-exploding it client-side (pick "which vendor's card is
the answer?") re-introduces exactly the ambiguity spec 102's `pending_po_qty`
`select distinct` fix was written to kill. The regression blast radius of (a)
is out of proportion to a read-only history badge. Rejected.

**Why not (c) — client-side replication.** `usage_forecasted` needs
`pos_daily_per_item` (7-day POS window flattened through the **recursive**
prep-recipe graph with a depth-5 cap and cycle detection — `all_ri` +
`recursive_prep`, ~90 lines of `with recursive`), and `days_until` needs
`vendor_delivery_offsets` (the multi-delivery-day MIN-over-offset logic with
`order_cutoff_time` handling — `…_multi_vendor.sql:349-403`). Neither the
per-item daily rate nor the next-delivery offset exists in the Zustand store as
a computed value (verified: `db.ts` carries raw `orderSchedule` rows and
`usagePerPortion` per item, but **not** `qtyPerDay` or `daysUntil` — those are
server-only). Replicating this faithfully in TypeScript means porting the
recursive recipe explosion AND issuing new reads for `pos_imports` +
`recipe_ingredients` + `prep_recipe_ingredients` + `order_schedule`, then
hand-maintaining a second copy of the forecast formula that drifts the instant
the engine changes (as it did four times in five specs). The spec explicitly
reopened "do not duplicate the engine," but the honest read is that (c) is the
**most** duplication, not the least. Rejected.

**Why (b) wins.** The new RPC copies the engine's proven CTE chain **verbatim
from `…_multi_vendor.sql`** — `direct_ri` / `recursive_prep` / `all_ri` /
`recipe_meta` / `pos_daily_per_item` / `vendor_delivery_offsets` /
`vendor_delivery` and the `par_replacement` / `usage_forecasted` /
`suggested_qty` / `suggested_cases` formulae are byte-for-byte identical — with
exactly two structural departures, both isolated to the on-hand source and the
output grain:

1. **On-hand source.** The `item_on_hand` CTE's three-branch EOD/stock `CASE`
   is **replaced** by a single lookup into the caller-supplied `p_on_hand`
   map: `on_hand := (p_on_hand->>item_id::text)::numeric`. Items absent from
   the map are dropped (no row) — the FE only sends the below-par entries it
   wants suggestions for. No `eod_submissions` / `eod_entries` read at all;
   the count IS the snapshot.
2. **Output grain.** Instead of the vendor-grouped/item-exploded envelope, the
   RPC returns a **flat array keyed by `item_id`**. For delivery timing it
   still explodes by `item_vendors` internally (an item can have multiple
   vendors with different schedules), then collapses to the item's
   **soonest** next delivery — `min(days_until)` across the item's linked
   vendors — so `days_until` answers "when does the next truck that carries
   this item arrive." This is the one semantic the FE cannot get from the
   vendor-grouped engine without de-exploding, and it is computed
   authoritatively server-side here.

This isolates all risk to a brand-new function with its own pgTAP suite; the
live `report_reorder_list` and its four suites are untouched. The
verbatim-copy-with-two-deltas discipline is the same pattern the engine
migrations already use (each `create or replace` copies the prior body and
calls out its hunks) and the backend-developer MUST carry the same
header-comment convention naming the two deltas.

**The semantic caveat (pin this — AC line 52/93).** The suggestion mixes a
**historical** on-hand (the counted total from this record) with **live**
usage-forecast (trailing-7-day POS as of *today*) and **live** delivery
timing (next delivery relative to *today*, not the count date). It answers
"what would you order **right now** if this count were your current on-hand,"
NOT "what would you have ordered on the count date." `p_params.as_of_date`
defaults to the store-local today (same contract as `report_reorder_list`), so
the forecast window and delivery offset are live. The FE header caption MUST
state both bases (current-par comparison AND live-forecast/timing) — this is
already an acceptance criterion; the design confirms it is load-bearing, not
cosmetic, because the numbers genuinely are not point-in-time.

### Data model changes

**None.** No new tables, columns, or indexes. Additive `create function` only.

- Migration filename: `supabase/migrations/20260701000000_report_reorder_for_counted_onhand.sql`
- Additive, non-destructive. Pure new function — no `alter`, no data
  migration, no backfill. Rollout-safe: a `drop function if exists` +
  `create` (or plain `create or replace` since it's a new signature) with no
  dependents. Rollback = `drop function`.
- Ordering: dated after the latest on-disk migration (`20260630000100_…`).
  Depends on `item_vendors`, `catalog_ingredients`, `order_schedule`,
  `pos_imports`, the recipe tables, and `auth_can_see_store()` — all of which
  predate it. No ordering hazard.

### RPC contract

```sql
create or replace function public.report_reorder_for_counted_onhand(
  p_store_id uuid,
  p_on_hand  jsonb,                       -- { "<item_id>": <counted_total_numeric>, ... }
  p_params   jsonb default '{}'::jsonb    -- { "as_of_date": "YYYY-MM-DD" } (optional)
) returns jsonb
language plpgsql
security invoker                          -- MATCHES report_reorder_list; RLS applies as the caller
set search_path = public
as $$ … $$;
```

- **`security invoker` + `set search_path = public`** — identical to
  `report_reorder_list` (`…_multi_vendor.sql:72-73`). MUST be invoker, not
  definer: the auth gate relies on the caller's own RLS context.
- **Auth gate is the FIRST statement**, byte-identical to the engine
  (`…_multi_vendor.sql:84-88`):
  ```sql
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id using errcode = '42501';
  end if;
  ```
  This is the store the COUNT belongs to (the FE passes `detail.storeId`).
  Confirmed: `auth_can_see_store(store_id)`, not `auth_is_admin()` — the
  history detail is a per-store read, and pgTAP MUST assert a non-member
  caller gets `42501`.
- **Grants:** mirror the engine exactly —
  `revoke all on function … from public, anon; grant execute on function … to authenticated;`.
  (The engine relies on `create or replace` preserving its ACL; this is a NEW
  function, so the migration MUST state the grant/revoke explicitly.)

**Request shape.** `p_on_hand` is a JSONB object mapping `item_id` (text) →
counted total (number, the item's unit total = `actualRemaining`). The FE
builds it from ONLY the below-par, resolvable, non-null-total entries — so the
RPC never wastes work on rows that won't render a suggestion. Empty map →
empty array (guard: `coalesce(nullif(p_on_hand,'{}'::jsonb), …)` → return
`'[]'`, don't scan).

**Response shape** (flat, item-keyed — NOT the vendor envelope):

```jsonc
{
  "as_of_date": "2026-07-01",
  "items": [
    {
      "item_id":          "uuid",
      "on_hand":          6,          // echoes the supplied counted total
      "par_level":        10,
      "par_replacement":  4,          // greatest(0, par - on_hand - pending_po)   (pending_po = 0 in v1)
      "usage_forecasted": 3.5,        // greatest(0, usage_per_portion * qty_per_day * days_until - on_hand - pending_po)
      "suggested_qty":    4,          // greatest(par_replacement, usage_forecasted)
      "case_qty":         4,          // catalog units-per-case (1 = no case size)
      "suggested_cases":  1,          // ceil(suggested_qty / case_qty), null when case_qty <= 1
      "suggested_units":  4,          // suggested_cases * case_qty, else suggested_qty
      "days_until":       2,          // MIN across the item's linked vendors' next-delivery offsets
      "next_delivery_date": "2026-07-03",
      "schedule_known":   true,       // false → 7-day A5 fallback was used for ALL the item's vendors
      "flags":            ["no_usage_rate"]   // same token vocabulary as the engine, item-grain subset
    }
  ],
  "_warnings": []                     // reserved; may stay [] in v1
}
```

- Field semantics are **identical to the engine's per-item object** so the
  frontend renders the same numbers the Reorder screen shows. `suggested_cases`
  / `suggested_units` follow the spec 088 case math verbatim. `days_until` /
  `next_delivery_date` follow the spec 087/102 delivery math, collapsed to the
  item's soonest vendor.
- **No `$`/cost fields.** `estimated_cost` / `cost_per_unit` / `vendor_total_cost`
  are DELIBERATELY OMITTED (spec 105 out-of-scope: no cost display → spec 104's
  per-each basis stays disengaged). The FE surfaces only quantity/timing.
- **Error cases:** non-member caller → `42501` (PostgREST → HTTP 403/401,
  surfaced by the tracked chain). Malformed `p_on_hand` value (non-numeric) →
  the `::numeric` cast raises `22P02`; the FE builds the map from typed
  `number` fields so this is defense-in-depth, but pgTAP should confirm the
  behavior is a clean error, not a silent 0.
- **`items[]` may be shorter than the request** when a supplied item has
  `suggested_qty < 0.001` (nothing to order — engine's `per_item_filtered`
  `where` clause is preserved). The FE MUST treat "item_id present in request
  but absent from response" as "nothing to reorder" (render the red dot from
  the par comparison, but no suggestion text, or a muted "at forecast" — FE
  copy choice). This is expected, not an error.

### `src/lib/db.ts` surface

New fetcher, mirroring `fetchReorderSuggestions` (`db.ts:3147`) — routed
through the tracked `useInflight.getState().track(...)` chain, `kind: 'read'`:

```ts
export interface CountedReorderItem {
  itemId: string;
  onHand: number;
  parLevel: number;
  parReplacement: number;
  usageForecasted: number;
  suggestedQty: number;
  caseQty: number;
  suggestedCases: number | null;
  suggestedUnits: number;
  daysUntil: number;
  nextDeliveryDate: string;        // YYYY-MM-DD ('' if unknown)
  scheduleKnown: boolean;
  flags: string[];
}

export async function fetchReorderForCountedOnHand(
  storeId: string,
  onHandByItemId: Record<string, number>,   // { itemId: countedTotal }
  asOfDate?: string,
): Promise<Record<string, CountedReorderItem>>;   // keyed by itemId for O(1) row lookup
```

- Calls `supabase.rpc('report_reorder_for_counted_onhand', { p_store_id, p_on_hand, p_params })`.
- **snake_case → camelCase** via a local `mapCountedReorderItem` helper
  mirroring `mapReorderVendor`'s per-item block (`db.ts:3192-3224`), MINUS the
  cost/vendor keys. Returns a `Record<itemId, CountedReorderItem>` (not an
  array) so the render loop does `byItem[e.itemId]` per row without an
  O(entries × items) scan.
- `asOfDate` optional, same contract as `fetchReorderSuggestions` — the FE
  passes the store-local today so the live forecast/timing is correct across
  tz. If omitted the RPC defaults to server `current_date` (UTC).
- Type `CountedReorderItem` lives in `src/types/index.ts` next to
  `ReorderItem` (it is a cost-free subset; do NOT reuse `ReorderItem`
  directly — the missing cost fields would be misleading `0`s).
- **Carve-out note:** this stays in `db.ts` (NOT a staff-subtree or auth-path
  exception). The admin history detail is inside the Cmd surface and all its
  reads already flow through `db.ts`.

### API contract decision — PostgREST vs RPC vs edge function

**Postgres RPC via `db.ts`**, exactly like `report_reorder_list`. Not a
table/view (the output is computed, not a stored row set). Not an edge
function (no service-token surface, no third-party call, no HTML/email — it is
a read-only report over store-scoped data, JWT-protected by default, gated by
`auth_can_see_store()` in-SQL). `verify_jwt` / service-token discussion is
**N/A** — no edge function is added or modified.

### Frontend store impact

**None on `src/store/useStore.ts`.** The detail view does NOT use the Zustand
store for its data — it lazy-fetches into component-local state via
`fetchInventoryCount(selectedCountId)` in a `useEffect`
(`InventoryCountSection.tsx:350-369`). The new call is a **companion fetch in
that same effect**: after `detail` resolves, build the below-par on-hand map
from `detail.entries` joined to the store `inventory` array (for `parLevel`),
and fire `fetchReorderForCountedOnHand(detail.storeId, map, storeLocalToday)`
into a second local state slot (e.g. `reorderByItem`), with its own
loading/error handling. The `inventory` array IS read from the Zustand store
(active-store-filtered) for the par join — no new fetch for par (OQ-1).

- **Optimistic-then-revert / `notifyBackendError` does NOT apply** — this is a
  read, not a mutation. On RPC failure the FE degrades gracefully: render the
  ✓/red par indicators (which need no backend) and simply omit the suggestion
  text for below-par rows (optionally a muted "reorder unavailable"). A failed
  read here MUST NOT toast-spam or block the par badges. Match the existing
  `fetchInventoryCount` `.catch` that just `console.warn`s
  (`InventoryCountSection.tsx:362-364`).
- The par comparison (✓ vs red) is **pure client-side** off `inventory` +
  `entry.actualRemaining` and renders **independently** of the RPC — so the
  green-check / red-dot states satisfy their acceptance criteria even if the
  reorder RPC is slow or fails. Only the below-par *suggestion text* depends
  on the RPC.

### Inline display data the FE needs (OQ-5)

Per entry row, the FE computes/consumes:

- **Par join (client-side, no fetch):** `item = inventory.find(i => i.id === e.itemId)`.
  - `item == null` OR `item.parLevel <= 0` OR `e.actualRemaining == null`
    → **no indicator, no suggestion, no RPC entry** (row unchanged). Covers
    the unresolvable-item, no-par, and null-total criteria.
  - `e.actualRemaining >= item.parLevel` (par > 0) → **green ✓** inline on the
    item/total cell. `useCmdColors().ok`. No suggestion.
  - `e.actualRemaining < item.parLevel` (par > 0) → **red dot** inline on the
    item/total cell (`useCmdColors().danger`) + include `{ [e.itemId]:
    e.actualRemaining }` in the on-hand map sent to the RPC.
- **Suggestion text (from `reorderByItem[e.itemId]`, when present):** rendered
  inline in the NOTE area / an inline sub-line — **no 6th column**. Fields to
  surface (quantity/timing only): `suggestedCases` (or `suggestedUnits` when
  `caseQty <= 1`), `usageForecasted` (the forecast component), and
  `nextDeliveryDate` / `daysUntil` (the timing). Exact string composition is
  FE choice, but it must draw from these fields and NOTHING cost-related.
- **Colors** come from `useCmdColors()` `ok` / `danger` tokens
  (`src/theme/colors.ts:193/197/223/227`) — no hard-coded hex (AC).
- **Header caption** (AC line 93): one line stating BOTH (a) par comparison is
  vs **current** par and (b) the reorder suggestion uses **live**
  forecast/timing over this record's counted on-hand. Copy is FE choice.

### Realtime impact

**None.** No table membership in the `supabase_realtime` publication changes,
so **the `docker restart supabase_realtime_imr-inventory` publication gotcha
does NOT apply** to this spec — no migration touches publication membership.
The detail view is a point-in-time historical read; the reorder suggestion is
computed once on open with then-current live forecast and does not subscribe.
The section's existing `inventory_counts` subscription (recent-list refresh)
is untouched. The two channels (`store-{id}` / `brand-{id}`) are not engaged.

### Test tracks

- **jest (always).** Component/unit test in the `InventoryCountSection`
  suite covering the three par states (≥par → green ✓; <par → red + suggestion
  from a **mocked `fetchReorderForCountedOnHand`**; no-par → no indicator) plus
  the two edge cases (unresolvable `itemId` → no indicator/no RPC entry;
  `actualRemaining == null` → no indicator/no RPC entry). Also assert the FE
  builds the on-hand map from ONLY below-par resolvable non-null rows (so the
  RPC isn't handed at/above-par items), and that an item present in the request
  but absent from the mocked response renders the red dot without a suggestion
  (the `suggested_qty < 0.001` collapse). Mock the RPC via the `db.ts` fetcher,
  matching how existing reorder tests stub `report_reorder_list`.
- **pgTAP (required — OQ-2 landed as a DB change, option b).** New suite
  `supabase/tests/report_reorder_for_counted_onhand.test.sql` asserting:
  1. a supplied on-hand below par yields the expected
     `par_replacement` / `suggested_qty` / `suggested_cases` (case-math from
     spec 088);
  2. `days_until` collapses to the **soonest** vendor for a multi-vendor item;
  3. an item at/above the supplied on-hand (suggested_qty < 0.001) is **absent**
     from `items[]`;
  4. a non-member caller (RLS) gets `42501` — the `auth_can_see_store()` gate
     (the pgTAP MUST set the JWT/role context the way the engine's suites do);
  5. empty `p_on_hand` → `items: []` with no scan/error.
  Seed against the 286 KB prod-pulled `seed.sql`; reuse the fixtures the
  existing `report_reorder_list_cases` suite already establishes for case-qty
  items so the case-math assertions share ground truth.

### Risks and tradeoffs (explicit)

- **Verbatim-copy drift (the main risk of option b).** The forecast/case/
  delivery CTEs are copied from `report_reorder_list`. If a FUTURE spec
  changes the engine's forecast formula, this sibling silently keeps the old
  math. **Mitigation:** the migration header MUST name its source migration +
  the two deltas (on-hand source, output grain) using the same
  copied-from-latest-body convention the engine migrations already enforce
  (`…_multi_vendor.sql:6-13`), so a future engine-editing spec sees the
  sibling and updates both. This is the accepted cost of NOT touching the
  load-bearing RPC. Flag for `code-reviewer`: verify the copied CTEs are
  byte-identical to the current engine body except the two documented deltas.
- **RLS gap check.** The gate is store-scoped (`auth_can_see_store`), matching
  the count's own read path. No `auth_is_admin()` — correct, since managers
  (per-store) view their own history. pgTAP item #4 is the guard. No new
  permissive policy is added (no table change), so the spec 053 permissive-lint
  probe is not engaged.
- **Performance on the 286 KB seed.** The RPC runs the same recursive
  prep-recipe walk + 7-day POS aggregation as the engine, but for a BOUNDED
  input set (only the below-par entries the FE sends, typically << full
  catalog). The recursive CTEs still scan the full recipe graph (they're not
  parameterized by the on-hand map), so worst-case cost ≈ one
  `report_reorder_list` call. Acceptable: it fires once per detail-open, not
  per keystroke, and the detail view is already an on-demand drill-in. If a
  count has hundreds of below-par entries the map is large but the JSONB
  lookup is O(1) per item — no N² blowup.
- **Edge-function cold start.** N/A — no edge function.
- **Migration ordering.** Single additive function dated after the latest
  on-disk migration; no dependency inversion. Manual verification is the
  current reality (no CI migration-apply gate blocks merge, but the
  `db-migrations-applied` drift gate WILL flag it red until `db push` /
  MCP-applied to prod — the backend-developer must apply it to prod and insert
  the version row, per the prod-migration-via-MCP memory, or the gate sits
  red).
- **De-explosion correctness.** Collapsing multi-vendor items to `min(days_until)`
  is a genuine product decision (the count is per-item, but delivery is
  per-vendor). "Soonest truck" is the defensible answer for "when could I have
  this back at par." If the manager wanted per-vendor breakdown that would be
  the vendor-grouped engine — explicitly out of scope here (OQ-5: inline, one
  line per entry).

### Open question surfaced to PM (non-blocking)

- **`items[]`-absent-means-nothing-to-order rendering.** When a below-par row's
  item is supplied but `suggested_qty < 0.001` (par gap exists but forecast +
  par-replacement both net to ~0 after subtracting on-hand/pending), the RPC
  omits it. The row still shows the **red dot** (it IS below par) but has no
  suggestion. Is a bare red dot with no text acceptable, or should the FE show
  a muted "at forecast / nothing to order"? Defaulting to **bare red dot, no
  text** (simplest, matches "no suggestion" literally). FE/PM can override the
  copy without a contract change — surfaced so it's a conscious choice, not an
  accident.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend:
  author migration supabase/migrations/20260701000000_report_reorder_for_counted_onhand.sql
  — a security-invoker, auth_can_see_store()-gated RPC copying the
  report_reorder_list forecast/case/delivery CTEs VERBATIM (header must name
  the source migration + the two deltas: on-hand-from-p_on_hand and flat
  item-keyed output), add the fetchReorderForCountedOnHand fetcher +
  CountedReorderItem type + mapper in src/lib/db.ts, and the pgTAP suite
  supabase/tests/report_reorder_for_counted_onhand.test.sql (five assertions
  incl. the 42501 RLS gate). Frontend: in InventoryCountSection.tsx DetailFrame,
  add the client-side par join (✓/red inline via useCmdColors ok/danger, no 6th
  column), the companion fetch in the existing lazy-detail useEffect, the inline
  below-par suggestion (quantity/timing only, NO cost), the dual-basis header
  caption, and jest coverage of the three states + two edge cases with a mocked
  fetcher. Then set Status: READY_FOR_REVIEW and list files under ## Files changed.
payload_paths:
  - specs/105-count-history-par-status-indicators.md

## Files changed

> **Both slices now landed.** The backend slice (RPC + `db.ts` fetcher +
> `CountedReorderItem` type + pgTAP) landed first; the frontend slice
> (DetailFrame par join + companion fetch + inline suggestion + dual-basis
> caption + jest) landed this pass and flipped the status to
> `READY_FOR_REVIEW`. Backend subsection is preserved below unchanged; the
> **### frontend** subsection at the end is new.
>
> **⚠ Filename correction vs the design's §"Data model changes":** the design
> named `20260701000000_report_reorder_for_counted_onhand.sql`, but that
> timestamp is ALREADY taken by spec 104
> (`20260701000000_spec104_per_each_cost_basis.sql`, already on disk +
> applied to prod). To avoid the collision this migration uses
> **`20260702000000`** (still dated after the latest on-disk migration; no
> ordering hazard). No other design departure.
>
> **⚠ Prod-apply PENDING (user-gated via MCP).** The migration is applied to
> the LOCAL stack only. It has NOT been pushed to prod (project
> `ebwnovzzkwhsdxkpyjka`). Until it is applied via MCP + its version row is
> inserted into `supabase_migrations.schema_migrations`, the
> `db-migrations-applied` drift gate will sit RED for this migration (expected
> — per the prod-migration-via-MCP memory). Apply is deferred to the user.

### migrations
- `supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql`
  — NEW security-invoker RPC `report_reorder_for_counted_onhand(uuid, jsonb,
  jsonb)`. Copies `report_reorder_list`'s (…_multi_vendor.sql) forecast/case/
  delivery CTEs verbatim with exactly the two named deltas (on-hand from
  `p_on_hand`; flat item-keyed output collapsing multi-vendor items to
  `min(days_until)`, no cost fields). `auth_can_see_store(p_store_id)` gate is
  the first statement (raises `42501`). Grants mirror `report_reorder_list`
  (revoke from public/anon; grant to authenticated). Applied to LOCAL only.

### src/lib/db.ts
- Added `fetchReorderForCountedOnHand(storeId, onHandByItemId, asOfDate?)`
  (tracked read, returns `Record<itemId, CountedReorderItem>`) + the
  `mapCountedReorderItem` snake→camel helper (mirrors `mapReorderVendor`'s
  per-item block minus cost). Added `CountedReorderItem` to the `../types`
  import.

### src/types/index.ts
- Added the `CountedReorderItem` interface (a cost-free subset of
  `ReorderItem`) next to `ReorderItem` / `ReorderPayload`.

### supabase/tests
- `supabase/tests/report_reorder_for_counted_onhand.test.sql` — NEW pgTAP
  suite (9 assertions): below-par case math (par_replacement / suggested_qty /
  suggested_cases / suggested_units), multi-vendor `min(days_until)` collapse,
  at/above-par item absent from `items[]`, empty-`p_on_hand` fast path, and the
  `42501` non-member RLS gate.

### Verification (local)
- Migration applied cleanly to the local stack; RPC verified end-to-end
  (below-par item → non-zero suggested_qty/cases; at/above-par → omitted;
  multi-vendor → soonest-truck `days_until`; empty map → `items: []`; RPC
  signature is `security invoker`, granted to `authenticated` only).
- `bash scripts/test-db.sh` — all 59 DB test files pass (incl. the new suite +
  all 7 sibling reorder suites: no regression).
- `npx tsc --noEmit` — clean.
- `npx jest` — 74 suites / 783 tests pass (no jest added this slice; the
  component/unit test belongs to the frontend slice per the handoff).

### frontend (this pass)

Built ON TOP of the parked `each` → `loose units` header edit already staged in
`InventoryCountSection.tsx` (not reverted). No 6th column added; the 5-column
phone layout (ITEM | CASES | LOOSE UNITS | TOTAL | NOTE) is preserved — the
✓/● marker renders inline on the item cell, the below-par suggestion inline in
the NOTE cell.

- `src/screens/cmd/sections/countHistoryPar.ts` — NEW pure (framework-free)
  helper module: `parStateFor` (the three states — above/below/none per
  OQ-1/OQ-4), `buildCountedOnHandMap` (the `{ itemId → countedTotal }` map from
  ONLY below-par/resolvable/non-null rows), `formatCountedReorderSuggestion`
  (inline quantity/timing string, NO cost — `order N cases · M unit · forecast
  … · deliver <date> (in N days)`), and `daysUntilLabel`. Pure so the jest
  contract stays cheap (same pattern as `reorderExport.ts` /
  `InventoryCountSection.customOrder`).
- `src/screens/cmd/sections/InventoryCountSection.tsx` —
  * imports `fetchReorderForCountedOnHand` + `CountedReorderItem` +
    the `countHistoryPar` helpers;
  * builds `inventoryById` (store's CURRENT inventory keyed by id — the par-join
    source, OQ-1, no fetch);
  * companion fetch in the EXISTING lazy-detail `useEffect`: after `detail`
    resolves, build the below-par on-hand map and call
    `fetchReorderForCountedOnHand(detail.storeId, map, todayIso())` into a new
    component-local `reorderByItem` slot; empty map short-circuits (no RPC); on
    RPC failure `.catch` → `console.warn` + `reorderByItem = {}` (NO toast, par
    badges still render — read-only degradation, no `notifyBackendError`);
  * `DetailFrame` now takes `inventoryById` + `reorderByItem` props; per entry
    row renders the ✓ (`C.ok`) / ● (`C.danger`) inline on the item cell (none →
    no marker), the inline below-par suggestion in the NOTE cell (bare red dot
    when the item is absent from the response — `suggested_qty < 0.001`
    collapse), and the dual-basis honesty caption near the `entries.tsv` header
    (vs current par + live forecast/timing). All colors via `useCmdColors()`
    tokens — no inline hex.
- `src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx`
  — NEW jest suite (15 tests): the three par states + null-total + unresolvable
  edge cases (`parStateFor`), the on-hand-map build (only below-par resolvable
  non-null rows), the suggestion-string composition (quantity/timing, NO `$`),
  and the companion-fetch flow with a MOCKED `fetchReorderForCountedOnHand` —
  incl. the requested-but-absent → bare-red-dot collapse and the failed/empty
  fetch degradation. Mirrors the sibling `InventoryCountSection.customOrder`
  test harness (supabase + db.ts mocked at the boundary; `.test.tsx` for the
  jsdom `component` project).

### Verification (frontend, local)
- `npx tsc --noEmit` — clean.
- `npx jest` — 75 suites / 798 tests pass (this slice added 1 suite / 15
  tests; no existing suite regressed). The lone `act(...)` warning is
  pre-existing noise from an unrelated staff `EODCount.tsx` focus effect, not
  this change.
- **Live RPC math (browser verification substitute).** The committed seed has
  ZERO saved `inventory_count` records, so the history-detail DetailFrame is
  UNREACHABLE in the browser (empty history list → no row to open) — browser
  verification is blocked exactly as the task flagged. Validated instead
  against the live local RPC on real seeded inventory: a below-par item (par 3,
  on_hand 1) → `suggested_qty 2 / suggested_cases 1 / suggested_units 450 /
  days_until 7 / next_delivery_date 2026-07-08`, NO cost fields; empty map →
  `items: []`; a non-member caller → SQLSTATE `42501` "Not authorized for
  store" (the FE `.catch` degrades to par badges only). These are the exact
  shapes the FE mapper + `formatCountedReorderSuggestion` consume.
