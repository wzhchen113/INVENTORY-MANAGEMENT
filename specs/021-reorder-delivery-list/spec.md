# Spec 021: Reorder / delivery list

Status: DRAFT

## User story

As a store manager who just finished an EOD count, I want to see one page per
vendor that tells me exactly what to order from that vendor for their next
delivery — quantity per item, taking into account what's on hand, what's
already on the way (pending POs), and the vendor's delivery schedule — so I
can place the order quickly without re-deriving the math from the count
screen myself.

## Background — what's there today and what isn't

The user said this used to exist in legacy. After audit, **it didn't.** Both
`src/screens/AdminScreens.tsx` (legacy) and
`src/screens/cmd/sections/RestockSection.tsx` (Cmd UI) compute a "suggested"
quantity, but neither:

- groups suggestions by vendor for delivery,
- uses the most recent EOD `actual_remaining` as input,
- subtracts pending PO quantities,
- respects each vendor's delivery schedule / cutoff.

`RestockSection.tsx` uses
`suggested = ceil((parLevel - currentStock) × 1.2)`, store-wide, with no
vendor grouping and no PO subtraction. The "1.2" buffer is hardcoded.

The feature gap is real even if the legacy reference is wrong. SURFACE THIS
DISCREPANCY GENTLY TO THE USER — they may be remembering a different feature
or a different repo. (One possibility: the staff-app PWA they use may have
this view and they're confusing the two apps.)

## Acceptance criteria

- [ ] A new Cmd UI section "Reorder" (or similar — name TBD by user) appears
  in `CmdNavigator.tsx` sidebar.
- [ ] The section renders one card or panel per vendor whose
  `order_schedule` says today is a valid order day OR whose next-cutoff is
  imminent — exact rule depends on A2 below.
- [ ] Each vendor card lists per-item suggested quantities computed from a
  defined formula — exact formula depends on A1 and A2 below.
- [ ] Suggested quantity is reduced by the qty already on outstanding (draft
  / sent / partially-received) POs for the same item — depends on A3.
- [ ] Each vendor card has a "Create PO" action that pre-fills a draft PO
  with the suggested items + quantities.
- [ ] If a vendor has zero suggested items, the card is hidden (or collapsed
  with a "nothing to order" state).
- [ ] Vendors with no `order_schedule` row are surfaced per A5.
- [ ] Cost-per-unit is shown per item; vendor totals are shown per card.
- [ ] Page refreshes when underlying `eod_submissions`, `purchase_orders`, or
  `inventory_items` change — realtime via the existing `store-{id}` channel.
- [ ] Vendor list is store-scoped via `auth_can_see_store()`.

## In scope

- New Cmd UI section file at
  `src/screens/cmd/sections/ReorderSection.tsx`.
- Wiring into `src/navigation/CmdNavigator.tsx` sidebar.
- A new database read RPC `report_reorder_list(p_store_id uuid, p_params
  jsonb)` OR a client-side composition reading from the existing tables —
  exact path depends on architect's call, but if RPC, the migration goes
  with this spec.
- "Create PO" hookup to the existing PO flow.
- Empty / loading / error states.

## Out of scope (explicitly)

- Replacing `RestockSection.tsx`. This section is parallel, not a
  replacement. The user can choose later (A4).
- Automated ordering / vendor API integrations.
- Forecasting beyond next delivery — no ML, no time-series modeling.
- POS-sales-based usage forecasting beyond what's already available in
  `inventory_items.usage_per_portion` and existing recipe / POS data.
- Touching `src/screens/AdminScreens.tsx` (legacy, frozen per CLAUDE.md).
- Order placement (email / EDI / phone) — output is a draft PO only.

## Open questions pending user confirm

### A1 — Input signal: which "on hand" do we use?

The reorder formula's "on hand" term — which value?

**Options:**
- **Most recent EOD submission's `actual_remaining`** per item. Time-stamped,
  audit-trail backed. Risky if no EOD has been done yet today / yesterday.
- **`inventory_items.current_stock`** — the post-EOD-overwrite value. Stays
  fresh as POs are received, but means the reorder list silently drifts
  between EODs.
- **Explicit "snapshot now" button** — user clicks → server snapshots
  `current_stock` per item into a temporary buffer and computes the reorder
  list off the snapshot. Predictable, traceable, but adds a click.

⟪OPEN — PENDING USER CONFIRM⟫. Recommend `current_stock` for v1 (it already
reflects the latest EOD via `staff_submit_eod`'s overwrite at
`supabase/migrations/20260504000001_staff_submit_eod_rpc.sql:83-87` AND any
since-then receiving). The EOD-as-source-of-truth interpretation only makes
sense if A1 is coupled to a vendor's last-count timestamp.

### A2 — Reorder window

The formula needs a "demand-over-window" term. What window?

**Options:**
- **Until next delivery from this vendor** — read `order_schedule` for the
  vendor's next delivery date. Suggest enough to cover usage between now
  and then. Vendor-specific, schedule-aware.
- **Next 1 day** — flat 1-day buffer. Simple, ignores schedule.
- **Next 7 days** — flat weekly buffer.
- **`par_level` only — replace whatever's missing.** Same as
  `RestockSection.tsx`'s current model, vendor-grouped.

⟪OPEN — PENDING USER CONFIRM⟫. Recommend "until next delivery" since the
data is there (`order_schedule` table per
`supabase/migrations/20260424001643_vendor_order_cutoff.sql` and friends).
The exact formula candidates:

- **Par-replacement**: `max(0, par_level - on_hand - pending_po_qty)`
- **Usage-forecasted**: `max(0, (usage_per_portion × days_until_next_delivery) - on_hand - pending_po_qty)`
- **Hybrid**: `max(par-replacement, usage-forecasted)`

### A3 — Pending PO subtraction

If there's an outstanding PO from vendor X with 10 cases of item Y, does the
suggestion subtract 10 from the suggested-order qty?

**Options:**
- **Yes, always subtract.** Pending = `purchase_orders.status IN ('draft',
  'sent', 'partial_received')`.
- **Yes, but only for `sent` / `partial_received` POs** — `draft` POs are
  manager-still-deciding and shouldn't reduce.
- **No subtraction** — the manager judges by eye.
- **Subtract, but show the breakdown** — surface "on hand: 4 | inbound: 6 |
  par: 12 → order: 2" so the manager sees the math.

⟪OPEN — PENDING USER CONFIRM⟫. Recommend "yes, subtract sent / partial_received
PO qty, show the breakdown inline."

### A4 — Relationship to `RestockSection.tsx`

The existing Restock section uses a similar but different formula and is
store-wide (no vendor grouping). Two options:

- **Sibling**: keep Restock for store-wide-by-category and add Reorder as a
  separate section, vendor-grouped for delivery. Two sidebar entries.
- **Replace**: deprecate `RestockSection.tsx` and absorb its functionality
  into the new section with a "view by vendor / view by category" toggle.
- **Supplement**: keep Restock visible but link from it to the new Reorder
  section.

⟪OPEN — PENDING USER CONFIRM⟫. Recommend sibling (cheapest, lowest risk of
breaking what works for stores that use Restock today).

### A5 — Vendors with no `order_schedule` row

How are they treated?

**Options:**
- Show with a "Schedule unknown — using default 7-day buffer" badge.
- Hide entirely.
- Show inside a dedicated "Vendors without schedules" section at the bottom.

Recommend default-buffer-with-badge. Tentative default — proceed unless
user pushes back.

### A6 — Legacy reference

The user said legacy had this feature. Audit confirms it didn't —
`RestockSection.tsx` is the closest existing analog, and it doesn't match
the user's description. SURFACE THIS GENTLY in the user clarification turn:

> "Quick note — I checked both the legacy `AdminScreens.tsx` and the current
> Cmd UI `RestockSection.tsx`. Neither does vendor-grouped reorder lists
> tied to delivery schedules. The closest existing thing is RestockSection,
> which uses `ceil((par - current_stock) × 1.2)` store-wide. You may be
> remembering a different repo (staff app?) or a spec that was discussed
> but not built. The feature itself is reasonable to build — just want to
> set expectations that this is a new feature, not a port."

### A7 — Series of "delivery days" or one-shot today?

When the manager opens the page, do they see:
- **One delivery's worth**: today's order for tomorrow's delivery (or
  whatever vendor X's next delivery is). One vendor card. Move on.
- **All upcoming deliveries for the next week**: vendor cards for every
  vendor with a delivery in the next 7 days. Multi-tab inside the page.

Recommend "one delivery's worth" by default with a date picker to look ahead.
Tentative default — proceed unless user pushes back.

## Dependencies

- `order_schedule` table — already exists (see
  `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`).
- `purchase_orders` + `po_items` tables — already exist.
- `inventory_items.par_level` / `usage_per_portion` /
  `current_stock` — already exist in init schema.
- `vendors.order_cutoff_time` — already exists per
  `supabase/migrations/20260424001643_vendor_order_cutoff.sql`.
- Most recent EOD lookup — exists via existing reads.
- Spec 020 — if A1 picks "most recent EOD's `actual_remaining`", this spec
  depends on spec 020 landing first because the per-vendor EOD shape
  changes what "most recent EOD for vendor X" means.

## Project-specific notes

- **Cmd UI section / legacy**: New file at
  `src/screens/cmd/sections/ReorderSection.tsx`. Sidebar wiring in
  `src/navigation/CmdNavigator.tsx`. NOT in `AdminScreens.tsx`.
- **Per-store or admin-global**: Per-store. Vendor list is filtered by
  inventory's `store_id`. RLS via `auth_can_see_store()`.
- **Realtime channels touched**: `store-{id}` — when a PO is received or an
  EOD is submitted, the reorder list should re-render.
- **Migrations needed**: MAYBE — depends on whether the architect wants a
  server-side RPC `report_reorder_list` (recommended for testability) or
  a client-side composition. Architect's call.
- **Edge functions touched**: None expected.
- **Web/native scope**: Both. No web-only or native-only branches.
- **Tests**: No test framework. test-engineer should flag and recommend.
- **app.json**: No changes.

## Risk register

- **Formula choice is product-loaded.** Different stores prefer different
  buffer rules. v1 needs ONE formula committed but the architect should
  surface the per-store-override question as a future-spec note.
- **Pending PO definition is fuzzy.** `purchase_orders.status` lifecycle
  (`'draft'` / `'sent'` / `'received'` / `'partial_received'`) needs to be
  audited before the formula sets a status filter — exact statuses in use
  may differ from the assumed list.
- **Empty-state risk.** New stores with no EOD history, no POs, no usage
  data will see an empty page. Need a friendly first-run state.
- **Spec 020 dependency.** If user picks A1=EOD-based, this work blocks on
  spec 020. Surface during architect handoff.

## Handoff

Pending user resolution of A1, A3, A4. Architect not yet dispatched.
