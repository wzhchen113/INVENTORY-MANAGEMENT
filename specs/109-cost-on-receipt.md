# Spec 109: Cost-on-receipt

Status: READY_FOR_REVIEW

> This is the flagged fast-follow of **spec 107 OQ-2**. Spec 107 (live in prod)
> shipped receiving as STOCK-ONLY and explicitly deferred cost-on-receipt to
> "Future work". Spec 108 (live) added share-based sending. The owner picked
> cost-on-receipt as the next build ("go with your recommendation"), then
> answered all six owner-sign-off questions — folded into scope below.
>
> **Owner override to keep prominent for the architect and reviewers:** on OQ-1
> the owner deliberately chose the AGGRESSIVE option over the PM recommendation.
> A changed price on ANY vendor's delivery updates BOTH the `item_vendors` link
> AND the `inventory_items` scalar, regardless of `is_primary`. The item's
> headline cost always reflects the LAST real price paid from ANY vendor. This
> is a conscious decision with an accepted whipsaw caveat (see "Open questions
> resolved" OQ-1 and the WHIPSAW CAVEAT callout) — not contract drift.

## User story

As a **store manager / receiver (admin Cmd UI)**, when a delivery arrives at a
DIFFERENT case price than the PO expected, I want to enter the new price during
the PO receive, and have the item's vendor cost AND item-level headline cost
update through the established spec-104 costing pipeline — so that food-cost %,
variance, and menu-impact stay true without anyone having to remember to
hand-edit items later.

## Verified current state (grounded — reused, not re-derived)

Line refs are current-state anchors, not prescriptions.

- **Receive flow (spec 107, live):** `ReceivingSection` PO-mode commits via
  `receive_purchase_order(p_po_id uuid, p_lines jsonb, p_client_uuid uuid)`.
  Lines are `[{ po_item_id, received_qty }]`, applied as **ADDITIVE deltas**
  (a second partial receive adds the newly-arrived quantity, not a restatement),
  idempotent on the `purchase_orders.receive_client_uuid` column, **stock-only**
  (increments `inventory_items.current_stock` in counted units + writes
  `po_items.received_qty`; touches NO cost column), `SECURITY INVOKER` +
  `set search_path = public`, gated by `auth_can_see_store(<po's store_id>)`, and
  writes **one `audit_log` row per call**. Returns
  `{ po_id, status, conflict, lines[] }`.
- **Costing model (spec 104, live):** the stored `cost_per_unit` is **PER-EACH**
  = `case_price / (case_qty × sub_unit_size)` (= `case_price / piecesPerCase`).
  Per-vendor cost lives in `item_vendors.case_price` + `item_vendors.cost_per_unit`
  (spec 102); item-level values live in `inventory_items.case_price` /
  `inventory_items.cost_per_unit` (editor input + the fallback consumers read when
  a vendor link's cost is 0). The editor derives `cost/each` **read-only** from
  case price + packing (spec 104) — `case_price` + packing are the authoritative
  inputs; `cost_per_unit` is a derived scalar.
- **`item_vendors` linkage:** each link carries `is_primary`, which mirrors the
  item's scalar `inventory_items.vendor_id` (the SD-1 convention). So "is this
  PO's vendor the item's primary vendor?" is answerable as
  `item_vendors.is_primary` for the (item, `po.vendor_id`) link — equivalently
  `inventory_items.vendor_id = po.vendor_id`. **Note (OQ-1 resolved AGGRESSIVE):**
  this spec updates the item scalar regardless of `is_primary`, so the primary
  test is NOT gating the item-scalar write — it is documented here only because
  the whipsaw caveat below turns on it (a non-primary delivery rewriting the
  headline).
- **`po_items.cost_per_unit`** snapshots the **per-COUNTED-unit** cost at
  PO-create time (spec 107 OQ-6; documented in a column comment). This is the
  **"expected price" baseline** to compare a delivery against — it is
  per-counted-unit, NOT a case price, so the guardrail comparison must bridge it
  to a comparable basis (see OQ-4 / OQ-3).
- **`purchase_orders.vendor_id`** references `vendors(id)` — this is the single
  vendor whose `item_vendors` link a receipt against this PO updates.
- **Column types (spec 104, live):** `inventory_items.cost_per_unit` and
  `item_vendors.cost_per_unit` are **`numeric(12,6)`** (widened by spec 104 to
  hold sub-cent per-each values). `item_vendors.case_price` is `numeric(10,2)`;
  `inventory_items.case_price` is unconstrained `numeric`;
  `catalog_ingredients.default_cost` is unconstrained `numeric`. `po_items.cost_per_unit`
  is `numeric(10,2)` (per-counted-unit, no widening — spec 107 OQ-6).
- **Audit convention:** `audit_log` rows on sensitive transitions. Cost changes
  are sensitive — the 2026-06-26 prod correction history shows cost-entry errors
  are THE recurring data-quality problem, so an old→new price audit trail is
  high-value. (This is doubly load-bearing given the OQ-1 whipsaw caveat: the
  audit trail is the primary mitigation for a secondary vendor rewriting the
  headline.)
- **Signature evolution note (for the architect):** adding a price to the receive
  lines can be done WITHOUT changing the RPC signature — the jsonb `p_lines`
  objects can gain an OPTIONAL `new_case_price` key (older callers omit it; the
  RPC only updates cost for lines that carry it). Flagged as the likely clean
  path; the exact key name is the architect's call, but the basis is fixed by
  OQ-3 (a **case** price). `create or replace` on the byte-identical
  `(uuid, jsonb, uuid)` signature preserves the existing GRANT/REVOKE.

## Scope shape (what the feature looks like)

In `ReceivingSection` PO-driven mode, the per-line table gains an optional
**"case price this delivery"** input, prefilled/ghosted with the current
expected price. Only an **entered AND different** value triggers a cost update;
leaving it as the ghosted default is a pure stock receive (spec 107 behavior,
unchanged). On commit, `receive_purchase_order` (evolved per the architect)
does — for each changed line, inside the same idempotent transaction:

1. Updates `item_vendors.case_price` for (item, `po.vendor_id`) and recomputes
   that link's per-each `item_vendors.cost_per_unit` via the ★ spec-104 formula
   (`case_price / (case_qty × sub_unit_size)`).
2. **ALWAYS** updates `inventory_items.case_price` for that item and recomputes
   `inventory_items.cost_per_unit` via the **same ★ formula** — regardless of
   whether `po.vendor_id` is the item's primary vendor (OQ-1 AGGRESSIVE). The
   item's headline cost tracks the last real price paid from any vendor.
3. Writes an **audit_log row recording old→new** for each changed line's price.

All of this rides inside the existing idempotent receive — a retry with the same
`p_client_uuid` must NOT re-apply the price change (return the prior result). The
price-update path MUST sit INSIDE the existing `receive_client_uuid` dedup gate
that already covers the whole call.

> ### ⚠ WHIPSAW CAVEAT (OQ-1, accepted by the owner)
> Because the item scalar is updated on ANY vendor's delivery, a **secondary
> vendor's one-off price** will REWRITE `inventory_items.case_price` /
> `cost_per_unit` — the headline cost — even though the primary vendor's price
> is unchanged. Example: primary vendor's case is normally \$40; a backup vendor
> delivers one case at \$55 during a shortage; the item's headline cost jumps to
> \$55-basis until the next primary-vendor receive (or a manual edit) restores it.
> This is a **conscious owner decision**, not drift. Mitigations, both already in
> scope: (1) the **old→new audit trail** makes every headline rewrite recoverable
> and attributable; (2) the **30% fat-finger guard** (OQ-4) catches the largest
> swings at entry. The architect and reviewers should treat the always-update
> semantics as intended and NOT "fix" it back to primary-only.

## Acceptance criteria

Backend / data:

- [ ] `receive_purchase_order` accepts an **optional per-line new case price**
      without a breaking signature change (architect's mechanism — likely an
      optional `new_case_price` key on each `p_lines` object). A line WITHOUT the
      key behaves exactly as spec 107 (stock-only). A line WITH a price that
      **differs** from the current `item_vendors.case_price` for (item,
      `po.vendor_id`) triggers the cost update; a price EQUAL to the current one
      is a no-op (no cost write, no audit row).
- [ ] For each price-changed line, the RPC updates `item_vendors.case_price` to
      the entered value and recomputes `item_vendors.cost_per_unit` =
      `case_price / (case_qty × sub_unit_size)` (the ★ spec-104 per-each formula),
      for the (item, `po.vendor_id`) link. The result persists (a subsequent read
      of that link returns the new case price and the new per-each cost).
- [ ] **(OQ-1 AGGRESSIVE)** For each price-changed line, the RPC **ALSO ALWAYS**
      updates `inventory_items.case_price` to the entered value and recomputes
      `inventory_items.cost_per_unit` via the **same ★ formula** — for EVERY
      delivery, regardless of whether `po.vendor_id` is the item's primary vendor
      (`is_primary` is NOT a gate on this write). A subsequent read of the item
      returns the new case price and the new per-each cost. Both the `item_vendors`
      recompute and the `inventory_items` recompute MUST use the ★ formula
      consistently (same `case_qty × sub_unit_size` divisor, piecesPerCase-
      consistent), so the link's per-each and the item's per-each agree when the
      packing is identical.
- [ ] **(OQ-2)** The RPC **NEVER** writes `catalog_ingredients.default_cost`. A
      per-store receipt does not move the brand-wide catalog seed.
- [ ] Every price-changed line writes an `audit_log` row recording **old→new**:
      the prior `item_vendors.case_price` (and prior per-each cost) and the new
      values, plus the item reference and the PO reference. House shape
      `(store_id, user_id, action, detail, item_ref, value)`; `user_id =
      auth.uid()` (INVOKER, spoof-proof). **The old→new price per item MUST be
      recoverable from `audit_log`.** The architect decides the granularity — one
      audit row per changed line, or one row per call whose detail enumerates each
      changed item's old→new — and whether it is a distinct `action` (e.g.
      `'PO price change'`) or folded into the receive row's detail. The recovery
      guarantee (old and new price per item) is the fixed requirement; the row
      shape is the architect's call. (This trail is the primary mitigation for the
      OQ-1 whipsaw caveat.)
- [ ] The cost update is **fully inside the existing idempotent receive**. A
      second call with the same `p_client_uuid` returns the first call's result
      and does NOT re-apply the price change (no double cost write on either
      `item_vendors` OR `inventory_items`, no duplicate audit row) — same
      guarantee spec 107 gives for stock. The price-update path sits INSIDE the
      `receive_client_uuid` dedup gate (the architect must confirm the dedup
      short-circuits BEFORE the cost writes, exactly as it does for the stock
      writes).
- [ ] Stock-receive behavior from spec 107 is **unchanged** for lines with no
      price entered: `current_stock` increments by the received delta in counted
      units, `po_items.received_qty` accumulates, status flips
      `partial`/`received`, `received_at` stamps only on full receive. The cost
      path is strictly additive to the existing RPC — it does not alter the stock
      or status logic.
- [ ] `receive_purchase_order` remains `SECURITY INVOKER`, `set search_path =
      public`, and refuses when `auth_can_see_store(<po's store_id>)` is false —
      the guard fires BEFORE any cost or stock write (both the `item_vendors` and
      the `inventory_items` write).
- [ ] **(OQ-4)** The >30%-delta guard is **client-side confirm by default** (the
      RPC has no "already-confirmed" signal to key on, and a server refusal would
      need a force-flag round-trip). The AC pins that a >30% delta CANNOT be
      committed without an explicit human confirm. **Division of responsibility is
      the architect's call:** the RPC MAY additionally enforce and/or echo the
      guard (e.g. return the expected baseline it compared against, or raise a
      distinguishable warning the FE turns into the confirm) if the architect
      judges a server-side backstop worthwhile — but the client-side confirm is
      the required mechanism and the RPC itself otherwise **accepts what is sent**.
- [ ] **(OQ-6)** Any receive (partial or full) that enters a new price applies
      the cost update; a later receive that enters a DIFFERENT price supersedes it
      — **last entry wins**. Each price change writes its own old→new audit row
      (or its own enumerated entry, per the granularity decision above), so two
      sequential receives with different prices leave the LAST price on both
      `item_vendors` and `inventory_items` and a recoverable trail of BOTH changes.

Frontend (admin Cmd UI, `ReceivingSection` PO-mode):

- [ ] Each line in PO-driven receive mode shows an optional **"case price this
      delivery"** input, prefilled/ghosted with the current expected case price
      (derived from the `po_items.cost_per_unit` per-counted-unit snapshot bridged
      to a case figure, or read from the current `item_vendors.case_price` for the
      PO's vendor — architect/FE picks the prefill source; it must read as "the
      price we expected"). A ghosted-but-unchanged value does NOT trigger a cost
      update.
- [ ] **(OQ-3)** The input is a **CASE price** (matches the invoice); the per-each
      recompute happens server-side from case price + packing via the ★ formula.
      Entering a value that DIFFERS from the ghosted expected price marks the line
      as a cost change (visually distinct) and, on commit, sends the new case price
      to the RPC.
- [ ] **(OQ-4)** When the entered case price differs from the expected by more
      than **30%**, committing surfaces a `confirmAction` (cross-platform per
      `src/utils/confirmAction.ts`) naming the item and the old→new values before
      the receive proceeds. Confirming commits; cancelling returns to the form with
      the value intact. **Basis-bridging note (load-bearing):** the ghosted
      expected baseline the client compares against derives from
      `po_items.cost_per_unit`, which is **per-COUNTED-unit**, NOT a case price —
      the client-side 30% comparison MUST bridge both sides to the SAME basis
      (compare case-to-case, or per-each-to-per-each) before computing the delta,
      or the guard fires on the wrong number. The architect/FE fixes the exact
      bridge; the AC pins that the compared quantities are on a consistent basis.
- [ ] After a commit that changed prices, the updated cost is reflected in
      cost-consuming surfaces (item editor's read-only `cost/each`, the per-vendor
      card, reorder `estimated_cost`) within one realtime debounce — driven by the
      existing `purchase_orders` UPDATE that receiving already fires on the
      `store-{id}` channel (no new subscription; see Project notes). Because OQ-1
      is AGGRESSIVE, the item editor's headline `cost/each` reflects the change for
      ANY vendor's delivery, not only the primary vendor's.
- [ ] **(OQ-5)** The price-on-receive input appears **ONLY** in the admin
      `ReceivingSection` PO-driven mode. No staff surface is touched.

## In scope

- Evolving `receive_purchase_order` to accept an optional per-line new **case**
  price (non-breaking; architect's mechanism) and, for changed lines, update
  `item_vendors.case_price` + recompute the per-each `item_vendors.cost_per_unit`,
  inside the same idempotent, store-scoped, audited receive.
- **(OQ-1 AGGRESSIVE)** ALWAYS also updating `inventory_items.case_price` +
  recomputing `inventory_items.cost_per_unit` via the same ★ formula on any
  vendor's changed-price delivery, so the item's headline cost tracks the last
  real price paid — with the whipsaw caveat consciously accepted and documented.
- An **old→new price audit trail** on every price-changed line (granularity per
  the architect, recovery of old→new per item guaranteed).
- The `ReceivingSection` PO-mode **per-line "case price this delivery" input**
  (ghosted with the expected price; only an entered+different value updates cost).
- The **fat-finger guardrail** — a client-side confirm on a >30% delta (OQ-4),
  with the basis-bridged comparison.
- **Last-entry-wins** partial-receive price updates, each change audited (OQ-6).
- pgTAP + jest coverage (see Tests / Project notes).

## Out of scope (explicitly)

- **Re-opening the spec-104 costing formula or column types.** The per-each basis
  and the `numeric(12,6)` widening are live and correct; this spec REUSES the ★
  formula, it does not change it. Rationale: cost-on-receipt is a new write path
  into an established pipeline, not a re-derivation of the pipeline.
- **"Fixing" OQ-1 back to primary-vendor-only.** The always-update-the-scalar
  behavior is the owner's deliberate choice; the whipsaw is accepted. Rationale:
  the owner wants the headline to always reflect the last real price paid, and
  chose it over the PM's primary-only recommendation — reverting it downstream is
  drift, not a bug fix.
- **Retroactive cost correction of already-received POs.** This spec updates cost
  going forward, at receive time. Bulk-fixing historical PO costs or re-pricing
  past deliveries is not in scope. Rationale: the owner asked for cost-at-receive,
  not a historical repricing tool.
- **Changing what `receive_purchase_order` does to stock or status.** The stock
  increment, additive-delta semantics, status flip, `received_at` stamping, and
  idempotency from spec 107 are unchanged — the cost update is strictly additive.
  Rationale: keep the spec-107 receive contract stable.
- **Vendor case-price history / a price-trend view.** The `audit_log` old→new row
  is the durable record; a dedicated price-history table or a trend chart is a
  later spec. Rationale: the ACs need an audit trail, not a reporting surface.
- **Staff-app receiving with price entry** (OQ-5 resolved admin-only).
  Cost-on-receipt is admin Cmd only in v1, matching spec 107's admin-only
  receiving. Rationale: staff receiving is itself still future work per spec 107.
- **Auto-applying a price without human review when the delta is large** (OQ-4).
  A >30%-delta price always passes through an explicit confirm. Rationale: the
  recurring cost-entry error history — doubly important under the OQ-1 whipsaw.
- **Moving catalog `default_cost` off a per-store receipt** (OQ-2 resolved never).
  A single store's invoice does not touch the brand-wide catalog default.
  Rationale: `default_cost` seeds newly-created items in EVERY store.
- **The freeform (non-PO) receiving fallback.** Spec 107 retained a freeform
  receive path with no `po_items` backing; it has no PO vendor and no expected
  price, so cost-on-receipt does not apply to it. It is untouched. Rationale:
  cost-on-receipt is keyed on a real PO line's vendor + expected price.
- **The `app.json` slug**, identity drift, and the repo-root spreadsheet —
  untouched (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

- **OQ-1 — Propagation to the item scalar.** Update ONLY the vendor link
  (`item_vendors`), or ALSO `inventory_items.case_price` / `cost_per_unit`?
  → **A: VENDOR LINK + ITEM SCALAR — ALWAYS.** ⚠ The owner deliberately chose the
  AGGRESSIVE option over the PM recommendation (which was "item scalar only when
  the PO's vendor is primary"). A changed price on **ANY** vendor's delivery
  updates BOTH `item_vendors.case_price`/`cost_per_unit` for (item,
  `po.vendor_id`) AND `inventory_items.case_price`/`cost_per_unit` — regardless of
  `is_primary`. Semantics: the item's headline cost always reflects the LAST real
  price paid from ANY vendor. **Accepted whipsaw caveat (documented above):** a
  secondary vendor's one-off price rewrites the headline until the next
  primary-vendor receive or a manual edit; mitigated by the old→new audit trail +
  the 30% guard. This is a conscious decision — the architect and reviewers must
  treat it as intended, not drift.

- **OQ-2 — Brand-shared catalog `default_cost`.** Does a per-store receipt ever
  move `catalog_ingredients.default_cost`?
  → **A: NEVER touched by a store receipt.** Receiving updates per-store cost
  only (`item_vendors` + `inventory_items`). `default_cost` seeds newly-created
  items in EVERY store; one store's invoice must not move the brand-wide default.

- **OQ-3 — Price entry unit.** CASE price or per-unit?
  → **A: CASE price** (what the invoice says). The receiver enters the case price
  straight off the invoice; the per-each `cost_per_unit` recomputes server-side
  via the ★ spec-104 formula (`case_price / (case_qty × sub_unit_size)`,
  piecesPerCase-consistent) for BOTH the vendor link and the item scalar.

- **OQ-4 — Fat-finger guardrail.** Warn on a large delta, or accept silently?
  → **A: 30% guard.** An entered price differing from the expected by **>30%**
  triggers an extra confirm showing old → new before commit. **Client-side** is
  the required mechanism (the RPC has no "already-confirmed" signal); the RPC
  itself accepts what is sent. Whether the RPC additionally enforces/echoes the
  guard (e.g. returns the baseline it compared, or offers a server-side backstop)
  is the architect's call — the client-side confirm is the fixed requirement. The
  expected-price baseline is `po_items.cost_per_unit` (per-counted-unit), so the
  client comparison must bridge bases to compare like-for-like.

- **OQ-5 — Who sees it.** Admin only, or staff too?
  → **A: admin `ReceivingSection` only.** Staff price-on-receive is later work,
  gated behind staff receiving landing at all (matches spec 107 OQ-5).

- **OQ-6 — Partial receives.** Which receive applies the price?
  → **A: any receive can update; LAST ENTRY WINS; each change audited.** A partial
  receive that enters a new price updates the cost; a later receive can enter a
  different price and supersede it. Each change writes its own old→new audit trail
  so the full history is recoverable.

## Dependencies

- **Spec 107 (live)** — `receive_purchase_order`, the `receive_client_uuid`
  idempotency column, the PO-driven `ReceivingSection` mode, and the
  `purchase_orders` realtime wiring. This spec EXTENDS the 107 receive RPC; it
  does not replace it. **Critical reuse:** the price-update path must sit inside
  the existing `receive_client_uuid` dedup so replay does not re-apply price
  changes.
- **Spec 104 (live)** — the ★ per-each cost formula (`case_price / (case_qty ×
  sub_unit_size)`), the `numeric(12,6)` cost columns, and the consumer bridge
  (`× sub_unit_size`). BOTH the vendor-link recompute AND the item-scalar
  recompute reuse this formula verbatim and consistently.
- **Spec 102 (live)** — `item_vendors` per-vendor cost (`case_price`,
  `cost_per_unit`, `is_primary`). The receipt updates the (item, `po.vendor_id`)
  link. (`is_primary` is NOT a gate under the OQ-1 AGGRESSIVE resolution.)
- **A new migration** — to `create or replace` `receive_purchase_order` with the
  optional-price handling + dual (link + scalar) cost recompute + audit rows.
  Apply to prod via Supabase MCP (`db push` lacks the prod password — project
  memory), then insert the exact version into `schema_migrations` so the
  `db-migrations-applied` gate stays green.
- **`src/lib/db.ts`** — the existing `receivePurchaseOrder` helper (spec 107)
  gains the per-line **case** price field on its `lines` argument; the
  receive-form mapper surfaces the expected price for the ghosted prefill.
- **No new edge function.** Cost-on-receipt is a Postgres RPC path; no Resend / no
  service-token function. (Spec 107's `send-po-email` is unrelated.)

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI only. Section touched:
  `ReceivingSection` (PO-driven mode) under `src/screens/cmd/sections/`. No legacy
  admin surface (spec 025 deleted it). Staff receiving is out of scope (OQ-5).
- **Which app:** this repo (admin). Customer PWA unaffected. Staff app not in play
  (OQ-5).
- **Per-store or admin-global:** per-store. `item_vendors` / `inventory_items` cost
  is store-scoped via `auth_can_see_store()`; the receive RPC's existing store
  guard covers BOTH cost writes (link + scalar). Catalog `default_cost` is
  brand-shared and is NOT written (OQ-2) — no cross-store blast radius.
- **Realtime channels touched:** `store-{id}` (via the existing `purchase_orders`
  UPDATE that receiving fires — spec 107 §6 confirmed `purchase_orders` is already
  in the `supabase_realtime` publication and subscribed on `store-{id}`). The cost
  change rides the same receive that already triggers the reload; the item/vendor
  cost re-reads on the debounced full reload. **No publication membership change**
  — so the realtime-publication gotcha (mid-session pub change needs `docker
  restart supabase_realtime_imr-inventory`) does NOT apply. Flag in the migration
  header, mirroring spec 107.
- **Migrations needed:** yes — one migration `create or replace`-ing
  `receive_purchase_order` with the optional-price + dual cost-recompute + audit
  logic. Additive to the RPC body; no schema/column change expected (the cost
  columns are already `numeric(12,6)` per spec 104, and `receive_client_uuid`
  already exists). `create or replace` on the byte-identical `(uuid, jsonb, uuid)`
  signature preserves the existing GRANT/REVOKE — do NOT re-emit them. Apply to
  prod via MCP + insert into `schema_migrations`.
- **Edge functions touched:** none.
- **Web/native scope:** web + native for the admin Cmd surface. The receive is a
  normal RPC (not web-push, no web-only CSS), so it is cross-platform.
- **Tests (spec 022 tracks):**
  - **pgTAP** — the primary track. Pin: (a) a line WITH a new case price updates
    `item_vendors.case_price` + recomputes the per-each `cost_per_unit` correctly
    via ★; (b) the SAME line ALSO updates `inventory_items.case_price` +
    recomputes `inventory_items.cost_per_unit` via ★ — **including when the PO's
    vendor is NOT the item's primary vendor** (the OQ-1 AGGRESSIVE pin: a
    non-primary delivery still rewrites the item scalar); (c) a line with the SAME
    price (no diff) writes no cost change and no audit row on EITHER table; (d)
    idempotency — a second call with the same `client_uuid` does NOT re-apply the
    price change on link OR scalar, and does not duplicate the audit row; (e) the
    `auth_can_see_store` refusal still fires before any cost write; (f)
    `catalog_ingredients.default_cost` is NEVER written (OQ-2); (g) last-wins
    (OQ-6) — two sequential receives with different prices leave the LAST price on
    both `item_vendors` and `inventory_items` and a recoverable old→new trail of
    both changes.
  - **jest** — the `db.ts` receive mapper carries the per-line **case** price
    field through to the RPC arguments, and the ghosted-expected-price prefill
    maps correctly; the >30%-delta confirm predicate (client-side) with the
    basis-bridged comparison (per-counted-unit baseline vs entered case price
    brought to a common basis).
  - **shell smoke** — optional; a receive-with-price round-trip if the architect
    adds one.
- **app.json slug:** untouched. This feature does not touch build identifiers,
  store listings, or push certs. `slug` stays `towson-inventory` (load-bearing,
  do-not-auto-fix per CLAUDE.md).

---

## Backend design

Grounded against the LIVE artifacts (read in full this pass):
`supabase/migrations/20260704000000_po_loop.sql` (the current
`receive_purchase_order` body, lines 160-301), `supabase/tests/po_loop.test.sql`
(the pgTAP harness I extend), `supabase/migrations/20260630000000_item_vendors.sql`
(the junction: `case_price numeric(10,2)`, `cost_per_unit numeric(12,6)`,
`is_primary`, `(item_id, vendor_id)` unique), `supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql`
(the ★ per-each basis + `numeric(12,6)` widening), and `src/lib/db.ts`
(`createPurchaseOrderDraft` L1444, `PoLine` + `mapPoItemRow` L1404-1428,
`receivePurchaseOrder` L1565). This design is **additive to the spec-107 RPC** —
it does not touch the stock/status/idempotency logic, only slots a cost-write
block into the existing per-line loop and adds an audit block + envelope key.

### 0. The whipsaw caveat is held, not fixed

Per OQ-1 (owner override, restated at the top of this spec): a changed price on
ANY vendor's delivery updates BOTH the `item_vendors` link AND the
`inventory_items` scalar, with NO `is_primary` gate on the item-scalar write. I
have designed to that line. Reviewers: the always-update-the-scalar semantics is
intended; the audit trail (§4) + the 30% client confirm (§5) are the accepted
mitigations. Do not propose reverting to primary-only.

### 1. Data model changes

**No schema change.** Every column the cost writes touch already exists at the
right type:

| Target column | Type | Source migration |
|---|---|---|
| `item_vendors.case_price` | `numeric(10,2)` | 20260630000000 (spec 102) |
| `item_vendors.cost_per_unit` | `numeric(12,6)` | widened 20260701000000 (spec 104) |
| `inventory_items.case_price` | `numeric` (unconstrained, default 0) | 20260502071736 |
| `inventory_items.cost_per_unit` | `numeric(12,6)` | widened 20260701000000 (spec 104) |
| `catalog_ingredients.case_qty` / `sub_unit_size` | `numeric` (defaulted) | brand-catalog P1 / spec 093 / spec 104 |
| `purchase_orders.receive_client_uuid` | `uuid` + partial unique idx | 20260704000000 (spec 107) |
| `audit_log (store_id, user_id, action, detail, item_ref, value)` | all text bodies | init_schema:196 |

The migration is **RPC-only** — one `create or replace function
public.receive_purchase_order(uuid, jsonb, uuid)` re-CREATE. Additive and
rollout-safe: the signature is byte-identical, so `create or replace` PRESERVES
the existing `revoke … from public, anon` + `grant … to authenticated` (do NOT
re-emit them — matching the spec-107 discipline for the reorder-RPC re-CREATEs).
Older callers that omit the new key get exactly spec-107 stock-only behavior
(§2). Not destructive.

**Proposed migration filename:** `supabase/migrations/20260705000000_cost_on_receipt.sql`
(next free slot — the on-disk latest is `20260704000000_po_loop.sql`; the seed's
`schema_migrations` high-water is also 20260704000000).

**Source discipline (verbatim-copy):** the new file copies the CURRENT on-disk
`receive_purchase_order` body **verbatim** from
`20260704000000_po_loop.sql:160-301` and applies EXACTLY the four hunks in §2.
The other two RPCs in that file (`close_short_purchase_order`,
`cancel_purchase_order`) and the two reorder re-CREATEs are NOT re-emitted here —
only `receive_purchase_order` changes. Name the source file in the migration
header so the reviewer can diff hunk-by-hunk.

### 2. The `p_lines` evolution + the cost-write block (the ★ formula)

**Signature: unchanged.** `receive_purchase_order(p_po_id uuid, p_lines jsonb,
p_client_uuid uuid)`. The evolution rides on the jsonb objects gaining one
OPTIONAL key.

**The key (decided):** `new_case_price` — `numeric`, the CASE price as invoiced
(OQ-3). Chosen over `case_price` (too close to the column, reads as a
restatement) — `new_case_price` reads as "the price on THIS delivery's invoice."
Each `p_lines` entry evolves from `{ po_item_id, received_qty }` to
`{ po_item_id, received_qty, new_case_price? }`.

**Absent-vs-explicit distinction in `jsonb_to_recordset` (decided + verified).**
The current loop projects `as x(po_item_id uuid, received_qty numeric)`
(20260704000000:224). Add the third column so the projection becomes
`as x(po_item_id uuid, received_qty numeric, new_case_price numeric)`.
`jsonb_to_recordset` yields SQL `NULL` for a column whose key is **absent** from
the object OR whose value is JSON `null`. So the disambiguator is
**`v_line.new_case_price is not null`**: NULL ⇒ "no price entered, stock-only
line" (spec-107 path, no cost read/write, no audit); non-NULL ⇒ candidate cost
change. Absent key and explicit JSON `null` collapse to the same "no change" — the
FE simply omits the key for unchanged lines (§ frontend), which is the cleanest
older-caller-compatible shape (the existing `db.ts` mapper emits objects with no
`new_case_price` at all → NULL → no-op — spec-107 callers are unaffected with zero
code change).

**Input validation (decided): reject the LINE, not the call, and only for a
genuinely bad value.** Guard placement is INSIDE the loop, evaluated only when
`new_case_price is not null`:
- `new_case_price < 0` → **raise `P0001`** `'invalid new_case_price % for po_item %'`
  (a negative case price is nonsense and almost certainly a client bug; a hard
  refusal is safer than silently clamping). Because the whole RPC is one
  transaction, this raise aborts the ENTIRE receive (stock writes included) and
  PostgREST maps `P0001` → HTTP 400. That is the correct blast radius: a negative
  price means the payload is malformed, so failing the whole call (rather than
  half-applying stock and skipping one cost) is the safer, more debuggable
  outcome. Non-numeric input cannot reach here — `jsonb_to_recordset`'s
  `numeric` projection already raises `22P02` (invalid_text_representation) at
  parse time for a non-numeric JSON scalar, before the loop body runs, which also
  aborts the call. We rely on that built-in cast guard rather than re-checking.
- `new_case_price = 0` is **NOT rejected** — it is treated as "no price entered"
  by the change test below (a 0 case price is the column's own default/"unknown"
  sentinel; the draft snapshot uses 0 for costless items). Concretely: the
  change test is `new_case_price is not null AND new_case_price > 0 AND
  new_case_price <> v_current_case_price`. A `new_case_price = 0` fails the `> 0`
  clause → no cost write, no audit. This prevents a stray 0 from a mis-mapped FE
  field zeroing out a real cost. (The FE also never sends 0 for an unchanged
  line — it omits the key — so this is defense-in-depth.)

**The change test (decided).** A cost write fires for a line iff:
```
v_line.new_case_price is not null
  and v_line.new_case_price > 0
  and v_line.new_case_price is distinct from v_current_case_price
```
where `v_current_case_price` is read from the (item, `po.vendor_id`) link (see
below). `is distinct from` handles a NULL current (link exists with NULL
case_price) correctly. Equal price ⇒ no-op (AC: no cost write, no audit row on
EITHER table).

**Reading the packing divisor (coalesce discipline).** Inside the loop, after the
existing `update public.po_items … returning pit.item_id into v_item_id`, resolve
the catalog packing for the item via the catalog join, mirroring the reorder
RPCs' `coalesce(ci.case_qty, 1)` / `coalesce(ci.sub_unit_size, 1)` idiom
(20260704000000:829-830):
```
select coalesce(ci.case_qty, 1), coalesce(ci.sub_unit_size, 1)
  into v_case_qty, v_sub_unit_size
  from public.inventory_items ii
  join public.catalog_ingredients ci on ci.id = ii.catalog_id
 where ii.id = v_item_id;
```
`greatest(v_case_qty * v_sub_unit_size, <guard>)` is NOT needed because both
coalesce to ≥ 1, so the product (the ★ divisor) is ≥ 1 and never zero. (If a
future catalog row carried an explicit 0 case_qty the division would divide by
zero; the coalesce only guards NULL. I judged an extra `nullif(...,0)` unwarranted
— the reorder RPCs don't guard it either and 0 is not a legal case_qty — but I
flag it as a **known non-guard** for the reviewer. If reviewers want belt-and-
suspenders, wrap the divisor in `greatest(v_case_qty * v_sub_unit_size, 1)`.)

**The two cost writes (both use the ★ formula, same divisor).** When the change
test passes, capture old values first (for audit §4), then write both targets:

*Target 1 — the vendor link (item, `po.vendor_id`).* Read the PO's `vendor_id`
once near the top (add to the initial `select store_id, status, received_at`
that already runs at 20260704000000:183 → also select `vendor_id` into
`v_vendor_id`). Then **upsert-or-update** the link (see §3 for the
link-missing decision):
```
insert into public.item_vendors (item_id, vendor_id, case_price, cost_per_unit, is_primary)
values (v_item_id, v_vendor_id, v_line.new_case_price,
        v_line.new_case_price / (v_case_qty * v_sub_unit_size), false)
on conflict (item_id, vendor_id) do update
   set case_price    = excluded.case_price,
       cost_per_unit = excluded.cost_per_unit,
       updated_at    = now();
```
The `(item_id, vendor_id)` composite unique (`item_vendors_item_vendor_unique`,
20260630000000:73) is the conflict target. `is_primary = false` on INSERT is
correct: a newly-created link is NOT the primary (the SD-1 primary is the item's
scalar `vendor_id`; we do not touch it). On UPDATE we leave `is_primary`
untouched — a receive against a link that happens to be primary keeps it primary.

*Target 2 — the item scalar (ALWAYS, no `is_primary` gate — OQ-1).*
```
update public.inventory_items ii
   set case_price    = v_line.new_case_price,
       cost_per_unit = v_line.new_case_price / (v_case_qty * v_sub_unit_size),
       updated_at    = now()
 where ii.id = v_item_id
   and ii.store_id = v_store_id;   -- store pin (defense-in-depth, matches the stock write:238)
```
Both writes use the IDENTICAL divisor `v_case_qty * v_sub_unit_size`, so the
link's per-each and the item's per-each AGREE when packing is identical (AC:
piecesPerCase-consistent). This is the ★ formula verbatim from spec 104
(`case_price / (case_qty × sub_unit_size)`).

**`catalog_ingredients.default_cost` is NEVER written (OQ-2).** The design touches
only `item_vendors` + `inventory_items`. No `catalog_ingredients` UPDATE exists in
the new body. pgTAP pins this (§7 case f).

**Ordering within the loop (final):** per line — (a) UPDATE `po_items` +
`returning item_id`; (b) stock UPDATE (unchanged spec-107 block); (c) IF
`new_case_price` passes the change test: resolve packing, capture old link
values, INSERT…ON CONFLICT the link, UPDATE the item scalar, accumulate an audit
entry (§4). Stock (b) and cost (c) are independent per line — a stock-only line
skips (c) entirely; a cost line with `received_qty = 0` still writes cost (OQ-6:
"any receive that enters a new price applies the cost update" — a pure re-price
with zero quantity is legal, though the FE always sends a positive qty).

### 3. Link-missing decision (INSERT-or-update, not skip+flag)

A PO line's item might have NO `item_vendors` row for the PO's `vendor_id` (e.g.
the item was linked to a different vendor, or the link was deleted after the
draft was created). **Decision: INSERT the link (via `on conflict do update`
above), do NOT skip+flag.** Rationale:
- The receipt is ground truth — the store DID buy this item from this vendor at
  this price. Recording that as a link is the correct model (it makes the vendor
  card show the item next time, and the per-vendor cost is now real).
- Skip-and-flag would silently drop a cost the operator explicitly entered — the
  worse failure mode given the recurring cost-entry-error history this spec cites.
- The RLS `store_member_insert_item_vendors` policy (20260630000000:126) admits
  the INSERT because the RPC is INVOKER and the caller can see the item's store
  (the store gate already fired). No policy change needed.
- `is_primary = false` on the new link keeps the SD-1 invariant intact (the
  item's scalar `vendor_id` is untouched, so exactly-one-primary is preserved;
  the new link is non-primary).

The item-scalar write (Target 2) is unconditional regardless of whether the link
pre-existed — that is OQ-1. So even a brand-new-link receive rewrites the
headline. pgTAP pins the link-missing path (§7 case h).

### 4. Idempotency: dedup fires BEFORE any cost write (verified)

The live body's step (2) (20260704000000:198-213) short-circuits: if
`p_client_uuid` already matches `purchase_orders.receive_client_uuid` for this
PO, it rebuilds the envelope from `po_items.received_qty` and `RETURN`s with
`conflict:true` — **before** the step-(3) loop where BOTH stock and (now) cost
writes live. The cost block is added INSIDE that step-(3) loop, strictly AFTER
the dedup `return`. Therefore a replay with the same `p_client_uuid` never
reaches the cost writes: no double `item_vendors`/`inventory_items` write, no
duplicate audit row. This is the SAME guarantee spec-107 already gives for stock,
inherited for free by placement. **The ordering holds; no change to the dedup
block is required.** pgTAP pins replay-no-reapply on link AND scalar AND audit
(§7 case d).

One subtlety to preserve: the dedup keys on `receive_client_uuid`, and the
status-UPDATE at the end (20260704000000:265-271) overwrites it with
`coalesce(p_client_uuid, receive_client_uuid)` (latest-wins, per the spec-107
developer note). The cost block does NOT touch `receive_client_uuid` — it rides
the existing key. So sequential DIFFERENT receives (each its own fresh uuid) each
pass the dedup gate and each apply their price (OQ-6 last-wins); only a REPLAY of
the same uuid short-circuits. This is exactly the OQ-6 requirement.

### 5. Audit granularity: one row PER CHANGED LINE (decided)

**Decision: one `audit_log` row per price-changed line**, with a distinct
`action = 'PO price change'`, written INSIDE the loop as each cost change lands.
This is separate from the existing one-per-call `'PO received'` row (§ that row
stays, unchanged — the receive still logs its per-call summary). Rationale for
per-line over per-call-enumeration:
- The recovery guarantee (old→new price per item) is trivially satisfied and
  queryable (`where action = 'PO price change'` filters exactly the cost events).
- `item_ref` is a single text column — one row per item lets `item_ref` hold that
  item's name cleanly, rather than cramming N items into one detail string.
- It mirrors how a reviewer would want to reconstruct a whipsaw: one row per
  headline rewrite, attributable to the receive + vendor + operator.

Row shape (all bodies are text — `audit_log` columns are text per init_schema):
```
insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
values (
  v_store_id,
  auth.uid(),                              -- INVOKER → real caller, spoof-proof
  'PO price change',
  'PO ' || left(p_po_id::text, 8) || ' · ' || v_vendor_name
        || ' · case ' || coalesce(v_old_case_price::text, '—')
        || ' → ' || v_line.new_case_price::text,      -- old→new CASE price
  v_item_name,                             -- catalog name (best-effort, from the packing join)
  'each ' || coalesce(v_old_cost_per_unit::text, '—')
        || ' → ' || (v_line.new_case_price / (v_case_qty * v_sub_unit_size))::text
);
```
- `v_old_case_price` / `v_old_cost_per_unit` are captured from the link (Target 1)
  BEFORE the upsert — the link's prior `case_price` + `cost_per_unit`. On a
  link-missing INSERT both are NULL → rendered `'—'` (the "no prior price"
  case; the row still records the NEW values, satisfying recoverability of the
  transition even for a first-time link).
- `detail` carries old→new CASE price (matches the invoice basis the operator
  entered); `value` carries old→new PER-EACH cost (the derived headline figure).
  Both directions of the ★ bridge are in the trail, so a reviewer can reconstruct
  either basis without re-deriving.
- `v_item_name` is pulled in the same packing `select` (add `ci.name` to the
  join in §2). `v_vendor_name` is already resolved for the `'PO received'` row
  (20260704000000:275-278) — reuse it.

pgTAP asserts a `'PO price change'` row exists with the expected old→new after a
changed-price receive, and that NO such row exists after an equal-price or
stock-only receive, and that a replay does not duplicate it (§7).

### 6. The 30% guard — client-side confirm REQUIRED; RPC stays permissive + echoes (decided)

**Division of responsibility (decided):**
- **The RPC accepts what is sent** (no server refusal on a large delta — there is
  no "already-confirmed" signal to key on, and a force-flag round-trip is
  gold-plating the spec explicitly did not ask for). The client-side confirm is
  the REQUIRED mechanism (OQ-4).
- **The RPC additionally ECHOES the applied price changes in the return envelope**
  (§ below) so the FE can (a) toast/refresh costs and (b) — as defense-in-depth —
  the envelope carries the server's own view of old→new for each changed line. I
  am NOT adding a separate server-computed `price_warnings` array: the guard is a
  UI concern and the baseline the client compares against
  (`po_items.cost_per_unit`) is data the client already holds (it drives the
  ghost prefill). A second server-side baseline computation would be redundant
  surface. The echo (§ return) is the server backstop — it lets a reviewer or a
  future audit confirm what actually changed, without the RPC gatekeeping the
  30%.

**The basis-bridge the CLIENT compares (pinned — load-bearing).** The ghost
"expected" baseline derives from `po_items.cost_per_unit`, which is
**per-COUNTED-unit** (spec 107 OQ-6, column comment at 20260704000000:1529). The
entered value is a **CASE price**. The client MUST bridge to a common basis
before computing the delta. The exact bridge, verified against how the draft
snapshot was computed:

- Draft-create stored `costPerUnitCounted = inventory_items.costPerUnit(per-each)
  × subUnitSize` (db.ts:2415, `it.costPerUnit * subUnitSize`) into
  `po_items.cost_per_unit`.
- Per the ★ formula, per-each `= case_price / (case_qty × sub_unit_size)`, so
  `costPerUnitCounted = case_price / case_qty`.
- **Therefore `expected_case_price = po_items.cost_per_unit × case_qty`** — this
  reconstructs the exact case price the draft was built from. **Confirmed
  self-consistent with the spec-107 snapshot.**

So the client comparison is **case-to-case**:
```
expected_case_price = poLine.costPerUnit * caseQty      // po_items.cost_per_unit × case_qty
delta_fraction      = abs(enteredCasePrice - expected_case_price) / expected_case_price
if expected_case_price > 0 && delta_fraction > 0.30 → confirmAction(item, old→new)
```
Guard the `expected_case_price > 0` case (an item with a 0 snapshot has no
meaningful baseline — skip the 30% check for it; still send the price, still audit
server-side). This requires the FE to have `case_qty` on the line — see the
`db.ts` surface change below (the mapper must add `case_qty`, which it does not
currently expose).

**Prefill source (decided): the snapshot-derived expected case price**
(`po_items.cost_per_unit × case_qty`), NOT a live `item_vendors.case_price` read.
Rationale: it is the price the PO was created at ("the price we expected"), it is
already on the line the FE holds (no extra fetch), and it is the SAME quantity the
30% guard bridges against — so the ghost and the guard baseline are identical, no
drift between "what's shown" and "what's compared." (The alternative — reading the
live link case_price — could disagree with the PO snapshot if the link was
re-priced after the draft was created, making the ghost and the guard baseline
diverge. Rejected.)

### 7. Return envelope

**Extend the existing `{ po_id, status, conflict, lines[] }`** with an additive
`price_changes` array (empty `[]` when no line changed price, including on the
idempotent-replay path — a replay re-applies nothing, so it returns
`price_changes: []`). Shape:
```
jsonb_build_object(
  'po_id', p_po_id, 'status', v_new_status, 'conflict', false,
  'lines', v_lines_out,                      -- unchanged (cumulative received_qty per line)
  'price_changes', v_price_changes           -- NEW: [] or [{...}, ...]
)
```
each `price_changes` element:
```
{ 'po_item_id': <uuid>, 'item_id': <uuid>,
  'old_case_price': <numeric|null>, 'new_case_price': <numeric>,
  'old_cost_per_unit': <numeric|null>, 'new_cost_per_unit': <numeric> }
```
Accumulate into `v_price_changes jsonb` (init `'[]'::jsonb`,
`v_price_changes := v_price_changes || jsonb_build_object(...)` inside the change
branch). The FE uses this to toast "N prices updated" and does not strictly need
it to refresh (the realtime `purchase_orders` UPDATE already drives the reload,
§ realtime), but it lets the toast name the count and gives the reviewer/audit an
in-envelope record. **Additive** — spec-107 callers ignoring the key are
unaffected; the dedup-replay path returns `price_changes: []` so a retry toast
reads "no changes" correctly.

### 8. RLS impact

**No new table, no new policy.** Both cost writes ride existing policies:
- `inventory_items` UPDATE — the item's own store policy (init_schema "Store
  access", tightened by the 2026-05-04 hardening). The RPC is `security invoker`
  so the caller's RLS applies; the explicit `and ii.store_id = v_store_id` pin +
  the top-of-function `auth_can_see_store(v_store_id)` gate (20260704000000:191)
  are defense-in-depth. The gate fires FIRST (before any cost or stock write) —
  unchanged from spec 107.
- `item_vendors` INSERT/UPDATE — `store_member_insert_item_vendors` /
  `store_member_update_item_vendors` (20260630000000:126-137), each an
  `exists(… auth_can_see_store(ii.store_id))` join to the parent item. INVOKER
  means these apply automatically to the upsert.
- `audit_log` INSERT — existing "Store access" policy (init_schema:278),
  store-scoped; the row's `store_id = v_store_id` is within the caller's set.

The function stays `SECURITY INVOKER` + `set search_path = public` (AC). No
`auth_is_admin()` path — this is store-member-scoped, consistent with the rest of
the receive RPC.

### 9. Edge function changes

**None.** Cost-on-receipt is a pure Postgres RPC path. No new function, no
`verify_jwt` change, no service-token surface. (Spec 107's `send-po-email` is
unrelated and untouched.)

### 10. `src/lib/db.ts` surface

Two touched helpers, both existing:

**(a) `receivePurchaseOrder` (db.ts:1565) — add the per-line case price + return
the price changes.** New signature:
```ts
export async function receivePurchaseOrder(
  poId: string,
  lines: Array<{ poItemId: string; receivedQty: number; newCasePrice?: number }>,
  clientUuid: string,
): Promise<{
  status: string;
  conflict: boolean;
  priceChanges: Array<{
    poItemId: string; itemId: string;
    oldCasePrice: number | null; newCasePrice: number;
    oldCostPerUnit: number | null; newCostPerUnit: number;
  }>;
} | null>
```
Mapping: the RPC arg builder maps `newCasePrice` → `new_case_price` ONLY when it
is a finite number (omit the key otherwise so an unchanged line stays a
spec-107-shaped object → server NULL → no-op). Snake→camel on the way back:
`price_changes[].po_item_id → poItemId`, `item_id → itemId`,
`old_case_price → oldCasePrice`, `new_case_price → newCasePrice`,
`old_cost_per_unit → oldCostPerUnit`, `new_cost_per_unit → newCostPerUnit`
(each `Number(...)`, with `null` preserved for the old-* fields via
`x == null ? null : Number(x)`). Default `priceChanges` to `[]` when the RPC
omits the key (older server / replay).

**(b) `PoLine` + `mapPoItemRow` (db.ts:1404-1428) — expose `caseQty`.** The
mapper currently selects `catalog_ingredients(name, unit, sub_unit_size)` and
exposes `subUnitSize` but NOT `case_qty`. The FE needs `case_qty` for both the
ghost prefill (`costPerUnit × caseQty`) and the 30% bridge. Change:
- `fetchPurchaseOrderLines` select (db.ts:1514): add `case_qty` to the
  `catalog_ingredients(...)` projection →
  `catalog_ingredients(name, unit, sub_unit_size, case_qty)`.
- `PoLine`: add `caseQty: number;` (comment: "catalog case_qty; 1 when null —
  for the case-price ghost + 30% bridge").
- `mapPoItemRow`: add `caseQty: Number(ci.case_qty) || 1,`.

This is the ONLY read-path change; it is additive and does not alter existing
`PoLine` consumers (POsSection reads by field name).

### 11. Frontend store impact (`src/store/useStore.ts`)

**Slice touched: the `receivePurchaseOrder` action (useStore.ts:2446-2471) + its
interface signature (L413-416).**
- Interface signature gains the optional per-line price:
  `lines: Array<{ poItemId: string; receivedQty: number; newCasePrice?: number }>`
  and the return type widens to surface the price-change count (or the action can
  keep returning `status: string | null` and toast the count internally — FE's
  call; the envelope carries `priceChanges` regardless).
- The action passes `newCasePrice` straight through to `db.receivePurchaseOrder`
  and, on success, may toast the `priceChanges.length`. The existing post-receive
  refresh chain (`loadPurchaseOrderLines` → `refreshPurchaseOrders` →
  `loadFromSupabase` → `loadReorderSuggestions`, L2462-2465) ALREADY re-reads
  inventory (which now carries the new `cost_per_unit`/`case_price`) and reorder
  (which re-reads the per-vendor cost) — so **no new refresh is needed**; the cost
  change lands in the item editor / per-vendor card / reorder estimated_cost on
  the existing reload. `notifyBackendError` on throw stays as-is.

**Optimistic-then-revert:** NOT applicable here — this action is already
non-optimistic (it awaits the RPC, then refreshes from the server; it does not
locally mutate then revert). Cost is server-authoritative and re-read, so the
established await-then-refresh pattern is correct and unchanged. No
`notifyBackendError` revert semantics to add beyond the existing catch.

### 12. Frontend surface (`ReceivingSection` PO-mode)

The PO-driven line table (`PoReceivingMode`, ReceivingSection.tsx:99-342) gains
ONE column and the guard:
- **New per-line "case price this delivery" input**, ghosted with
  `expected_case_price = ln.costPerUnit * ln.caseQty` (from the PoLine). Held in a
  new `prices` state map keyed by `poItemId` (parallel to the existing `entries`
  qty map), seeded from the ghost on load. A value EQUAL to the ghost (or empty)
  is NOT sent (omit `newCasePrice`); a DIFFERENT value marks the line visually and
  sends `newCasePrice`.
- **The 30% confirm** rides the existing `confirmAction` at commit
  (ReceivingSection.tsx:167). Before (or folded into) the current commit confirm,
  compute per changed line `abs(entered − expected)/expected > 0.30` (with
  `expected > 0`), and if any line trips it, surface a `confirmAction` naming the
  item + old→new (cross-platform per `src/utils/confirmAction.ts`). Confirm
  commits; cancel returns with the values intact. The existing commit confirm
  (stock mutation gate) stays — the 30% confirm is an ADDITIONAL gate that only
  appears when a large delta is present.
- The commit builds each delta as
  `{ poItemId, receivedQty, newCasePrice? }` — `newCasePrice` present only for
  changed lines.
- **i18n ×3:** new keys under `section.receiving.*` for the column header (e.g.
  `caseThisDeliveryCol`), the 30%-confirm title/body/cta (e.g.
  `priceGuardTitle` / `priceGuardBody` with `{item, old, new}` params /
  `priceGuardCta`), and any "N prices updated" toast — added to ALL THREE locale
  catalogs (English + the two others the `section.receiving.*` namespace already
  carries). OQ-5: this input is ONLY in the admin `ReceivingSection` PO-mode; NO
  staff surface is touched.

### 13. Realtime impact

**Channel: `store-{id}`.** The cost change rides the SAME `purchase_orders`
UPDATE the receive already fires (status + received_at + receive_client_uuid at
20260704000000:265) — `purchase_orders` is already in the `supabase_realtime`
publication (20260514140000) and subscribed on `store-{id}` (spec 107 §6). Other
admin clients pick up the change on the debounced 400ms full reload, which
re-reads `inventory_items` (new cost) + `item_vendors` (new per-vendor cost) +
reorder. **No new subscription.**

**Publication gotcha: DOES NOT APPLY.** This migration makes NO
`supabase_realtime` publication membership change (no `alter publication … add
table`) — it only re-CREATEs a function. So the `docker restart
supabase_realtime_imr-inventory` step is NOT needed after `npm run dev:db`. Flag
this explicitly in the migration header (mirroring spec 107's header note), as a
"no-op, do not restart" clarification rather than a step.

### 14. Migration + prod apply

- **File:** `supabase/migrations/20260705000000_cost_on_receipt.sql` — one
  `create or replace function public.receive_purchase_order(uuid, jsonb, uuid)`,
  body copied verbatim from `20260704000000_po_loop.sql:160-301` + the four §2
  hunks. NO grant/revoke re-emit (signature-identical → ACL preserved). NO schema
  change. Header must: (a) name the verbatim source, (b) note "no publication
  change → no realtime container restart", (c) carry the prod-apply-via-MCP note.
- **Prod apply (owner-gated, `db push` lacks the prod password — project
  memory):** apply the `create or replace` via Supabase MCP `execute_sql` against
  `ebwnovzzkwhsdxkpyjka`, then INSERT the exact version `20260705000000` into
  `supabase_migrations.schema_migrations` so the `db-migrations-applied` gate
  stays green. Post-apply manual verify (a DDL/function change is invisible to the
  migration-list drift gate — same caveat spec 104/107 documented): confirm the
  function's new source is live via a normalized-md5 compare (project memory
  pattern) OR a smoke `select public.receive_purchase_order(...)` against a
  throwaway PO. RPC-only, no schema column to check.

### 15. Tests

**pgTAP — the primary track. New file
`supabase/tests/cost_on_receipt.test.sql`** (models the harness of
`supabase/tests/po_loop.test.sql`: master JWT, `set_config`, temp-table fixtures,
`throws_ok`/`is`/`ok`, hermetic `begin;…rollback;`, no `set role anon`). Fixtures
add a second vendor link so the non-primary case is real. Pin every AC:

- **(a) link recompute:** a line with `new_case_price` updates
  `item_vendors.case_price` to the entered value AND
  `item_vendors.cost_per_unit = new_case_price / (case_qty × sub_unit_size)` for
  (item, `po.vendor_id`); a subsequent read returns both.
- **(b) item-scalar recompute INCLUDING non-primary (the OQ-1 pin):** the SAME
  line updates `inventory_items.case_price` + `cost_per_unit` via ★ **when the
  PO's vendor is NOT the item's primary** (`inventory_items.vendor_id` points at a
  DIFFERENT vendor; the delivery vendor's link is `is_primary = false`). Assert
  the item scalar STILL rewrote. Also assert link-per-each == item-per-each when
  packing is identical.
- **(c) equal price = no-op:** a line whose `new_case_price` equals the current
  link `case_price` writes NO cost change on either table AND NO `'PO price
  change'` audit row. (Plus: an omitted key / a `new_case_price = 0` are no-ops.)
- **(d) idempotency:** a second call with the same `client_uuid` (a changed-price
  first call) does NOT re-apply the price on link OR scalar, does NOT duplicate
  the `'PO price change'` audit row, and returns `price_changes: []` on the
  replay.
- **(e) auth gate before cost write:** a non-member caller is refused (P0002
  under INVOKER RLS, per the spec-107 note at po_loop.test.sql:255) BEFORE any
  cost write — assert link + scalar unchanged after the refused call.
- **(f) `catalog_ingredients.default_cost` NEVER written (OQ-2):** capture
  default_cost before/after a changed-price receive; assert unchanged.
- **(g) last-wins (OQ-6):** two sequential receives (distinct uuids) with
  DIFFERENT prices leave the LAST price on both `item_vendors` and
  `inventory_items`, and TWO `'PO price change'` audit rows exist (both
  transitions recoverable).
- **(h) link-missing INSERT:** an item with NO `item_vendors` link for the PO's
  vendor, receiving with a price, CREATES the link (case_price + per-each set,
  `is_primary = false`) AND rewrites the item scalar; the audit row renders the
  old side as `'—'` (NULL old) and records the new values.
- **(i) validation errcodes:** `new_case_price < 0` raises `P0001` and aborts the
  whole call (stock unchanged too); a non-numeric JSON scalar in `new_case_price`
  raises `22P02` (the cast guard). (Optional/defensive.)
- **(j) stock unchanged by cost path:** a changed-price line still increments
  `current_stock` by the received delta exactly as spec 107 (the cost block is
  additive, not a replacement) — reuse the spec-107 stock assertions alongside a
  price.

**jest — `db.ts` mapper + the client guard predicate:**
- `receivePurchaseOrder` arg builder carries `newCasePrice` through to
  `new_case_price` ONLY when finite (omits the key otherwise); maps the
  `price_changes` envelope snake→camel with `null` preservation on the old-*
  fields.
- `mapPoItemRow` surfaces `caseQty` (1 when null).
- The 30%-confirm predicate (pure function, unit-tested): given
  `costPerUnit` (per-counted), `caseQty`, and `enteredCasePrice`, it computes
  `expected = costPerUnit × caseQty` and returns true iff
  `expected > 0 && abs(entered − expected)/expected > 0.30`. Test the
  basis-bridge explicitly (per-counted baseline vs entered CASE price brought to
  case-to-case) with a case_qty > 1 fixture so a naive per-counted-vs-case
  comparison would give the WRONG delta — the test pins that the bridge is
  applied.

**shell smoke — optional:** a receive-with-price round-trip against the local
stack (login `admin@local.test`), asserting the item's `cost_per_unit` moved.
Not required; the pgTAP + jest tracks are authoritative.

### 16. Risks and tradeoffs (explicit)

- **Whipsaw (OQ-1) — accepted, not a bug.** A secondary vendor's one-off price
  rewrites the headline. Mitigated by the per-line audit trail (§5) + the 30%
  client confirm (§6). Held per owner override; reviewers must not revert.
- **Migration ordering.** `20260705000000` sorts strictly after
  `20260704000000` (the spec-107 body it copies). If the two are ever applied
  out of order (e.g. a hand-run), the verbatim copy would fail to find the
  spec-107 body it assumes — but `schema_migrations` orders by version, so a
  normal `db push` / MCP apply is safe. The header names the source to make a
  hand-diff possible.
- **Divide-by-zero non-guard.** The ★ divisor `case_qty × sub_unit_size` is
  `coalesce(…,1)`-guarded against NULL but not against an explicit 0 (no legal
  catalog row carries a 0 case_qty; the reorder RPCs don't guard it either). Flagged
  for reviewer; a `greatest(divisor, 1)` wrap is the belt-and-suspenders option if
  they want it.
- **`inventory_items.case_price` is unconstrained `numeric` while
  `item_vendors.case_price` is `numeric(10,2)`.** The SAME `new_case_price` writes
  both; the link column rounds to 2dp, the item column stores full precision. For
  a normal invoice case price (2dp) they agree. A >2dp entered price would round
  on the link and not on the item — a sub-cent divergence, cosmetically harmless
  and within the spec-104 `numeric(12,6)` per-each reconstruction tolerance
  ($0.001). Noted, not blocking; the FE input is a normal 2dp currency field.
- **Performance on the 286 KB seed.** The cost block adds, per CHANGED line, one
  small `select` (packing, PK-indexed via `inventory_items.id` +
  `catalog_ingredients.id`), one `item_vendors` upsert (composite-unique-indexed),
  one `inventory_items` UPDATE (PK), and one `audit_log` INSERT. A receive touches
  a handful of lines; this is O(changed_lines) tiny writes — negligible. The
  seed carries 0 PO rows, so the path is exercised only by pgTAP (which builds PO
  rows in-transaction). No new index needed (`idx_po_items_po_id` +
  `item_vendors_item_vendor_unique` + the PKs already cover every access).
- **Edge-function cold-start: N/A** — no edge function in this path.
- **RLS gap: none identified.** The INSERT-a-missing-link path is admitted by the
  existing `store_member_insert_item_vendors` policy under INVOKER + the fired
  store gate; no policy widening.

### 17. Push-back / open questions for the PM

None blocking — the six architect decisions above (key name, validation errcode,
link-missing INSERT, per-line audit, permissive-RPC-plus-echo, snapshot-derived
ghost) all sit within the resolved OQs and the owner override. Two items surfaced
as NON-blocking notes for reviewers (not PM escalations): the divide-by-zero
non-guard on the ★ divisor, and the `item_vendors.case_price` 2dp vs
`inventory_items.case_price` unconstrained rounding divergence. The `app.json`
slug is untouched (do-not-auto-fix). No acceptance criterion is unclear or
contradicts the per-store-RLS system.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend owns
  §2/§3/§4/§5/§7 (the `20260705000000_cost_on_receipt.sql` migration —
  verbatim-copy `receive_purchase_order` from `20260704000000_po_loop.sql:160-301`
  + the four hunks: the `new_case_price` projection + change test + validation,
  the dual ★ cost writes with the link INSERT-or-update, the per-line `'PO price
  change'` audit rows, and the `price_changes` envelope key), the §10(a)
  `db.ts receivePurchaseOrder` signature + snake↔camel mapping, and the §15 pgTAP
  file `supabase/tests/cost_on_receipt.test.sql` (all ten cases, esp. the
  non-primary item-scalar-rewrite pin (b), replay-no-reapply (d), link-missing
  (h)). Flag the prod-apply-via-MCP + schema_migrations insert (RPC-only, no
  schema change). Frontend owns §10(b) (the `PoLine`/`mapPoItemRow` `caseQty`
  add), §11 (the `useStore.receivePurchaseOrder` action + interface passing
  `newCasePrice` through), §12 (the `ReceivingSection` PO-mode case-price column,
  the ghost = `costPerUnit × caseQty`, the basis-bridged 30% `confirmAction`, and
  the i18n ×3 keys), and the §15 jest track (mapper `caseQty`, the arg builder's
  finite-only `new_case_price` omission, and the pure 30%-bridge predicate with a
  case_qty > 1 fixture). After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/109-cost-on-receipt.md

## Files changed

> Status is now `READY_FOR_REVIEW` — BOTH slices are implemented and green on
> the LOCAL stack. The backend-developer implemented §2/§3/§4/§5/§7 (migration),
> §10(a)+§10(b) (`db.ts`), and the §15 pgTAP file. §10(b) (`caseQty` on
> `PoLine`/`mapPoItemRow`) was implemented in the backend slice, not the FE slice,
> because it is a `db.ts` (data-layer) change even though the FE consumes the
> field — per the build-task reconciliation. The frontend-developer then
> implemented §11 (store action + interface), §12 (`ReceivingSection` PO-mode
> case-price column + basis-bridged 30% confirm + i18n ×3), and the §15 jest
> tracks (the pure 30%-bridge predicate + the section tests). Prod apply of the
> migration remains user-gated (MCP) — the LOCAL stack has it applied.

### Backend (backend-developer)

**Migrations**
- `supabase/migrations/20260705000000_cost_on_receipt.sql` — NEW. One
  `create or replace function public.receive_purchase_order(uuid, jsonb, uuid)`,
  body copied VERBATIM from `20260704000000_po_loop.sql:160-301` + EXACTLY the
  four design hunks: (H1) `new_case_price numeric` on both `jsonb_to_recordset`
  projections; (H2) per changed line — `v_vendor_id` resolve, packing coalesce
  join, old-value capture, `item_vendors` UPSERT (INSERT `is_primary=false` when
  missing) + unconditional `inventory_items` UPDATE, both via the identical ★
  divisor `case_qty × sub_unit_size`; (H3) one `'PO price change'` audit row per
  changed line (old→new CASE in `detail`, old→new PER-EACH in `value`, old='—'
  on a link-missing INSERT); (H4) additive `price_changes[]` envelope (`[]` on
  the replay short-circuit). Negative price → P0001; `=0`/absent/equal → no-op.
  No grant/revoke re-emit (signature unchanged → ACL preserved); no schema
  change; no publication change (header documents "no realtime container
  restart"). Header names the verbatim source + carries the prod-apply-via-MCP +
  `schema_migrations` insert note (RPC-only, no schema column to verify;
  `pg_get_functiondef … like '%new_case_price%'` post-apply check). Applied to
  the LOCAL stack only; prod apply is user-gated (MCP) later.

**Data layer**
- `src/lib/db.ts` — (§10a) `receivePurchaseOrder`: the per-line arg type gains
  optional `newCasePrice` (mapped to `new_case_price` ONLY when a finite number,
  else the key is omitted so an unchanged line stays a spec-107-shaped object);
  the return widens to `{ status, conflict, priceChanges }` with the
  `price_changes[]` envelope mapped snake→camel (`null` preserved on the `old_*`
  fields, `Number(...)` on the rest, defaulting to `[]` when the key is absent).
  (§10b) `PoLine` gains `caseQty: number` (1 when null); `mapPoItemRow` populates
  `caseQty: Number(ci.case_qty) || 1`; `fetchPurchaseOrderLines`' select projection
  adds `case_qty` to the `catalog_ingredients(...)` join. Additive; existing
  `PoLine` consumers (POsSection) are unaffected.

**Tests**
- `supabase/tests/cost_on_receipt.test.sql` — NEW pgTAP file (40 assertions, all
  ten design cases): dual-target ★-consistent price change (1); NON-PRIMARY
  vendor delivery still rewrites the item scalar + leaves the primary link
  untouched (2, OQ-1 pin); idempotent replay does NOT re-apply link/scalar/stock
  and does NOT duplicate the audit row, returns `price_changes: []` (3);
  link-missing → link INSERTED `is_primary=false` + scalar updated + audit old='—'
  (4); `<0` → P0001 with no half-applied stock (5); `=0`/equal/absent → no cost
  change, no audit row, stock still received (6/7); audit old→new CASE + PER-EACH
  recoverable + INVOKER `user_id` (8); envelope `price_changes[]` shape (9); stock
  math unchanged from spec 107 (10). Hermetic `begin;…rollback;`, master JWT,
  in-transaction fixtures; runner picks it up automatically.
- `src/lib/db.poLoop.test.ts` — UPDATED (existing spec-107 file, pins `db.ts`):
  `fetchPurchaseOrderLines` fixture + expectation gain `case_qty`/`caseQty`; the
  `receivePurchaseOrder` describe block updated to the new `{ status, conflict,
  priceChanges }` return, plus a new case pinning `new_case_price` emitted ONLY
  for finite-priced lines and the `price_changes` snake→camel mapping (incl.
  `old_*` JSON-null → `null`), and an older-server `priceChanges` default-`[]`
  case.

**Validation (all green, LOCAL):** `scripts/test-db.sh` full (62/62 files —
`cost_on_receipt` 40, `po_loop` 30 unchanged); `npx jest` full (82 suites / 898
tests); `npx tsc --noEmit` (exit 0); `npx tsc -p tsconfig.test.json --noEmit`
(exit 0). Migration re-applies cleanly on a fresh `supabase db reset`.

### Frontend (frontend-developer)

**Store action (§11)**
- `src/store/useStore.ts` — the `receivePurchaseOrder` action + its interface
  signature: the per-line `lines` type gains optional `newCasePrice?: number`
  (threaded straight through to `db.receivePurchaseOrder`); the return WIDENS from
  `Promise<string | null>` to `Promise<{ status; priceChanges } | null>` so the
  section can toast the applied price-change count alongside the received toast.
  The existing await-then-refresh chain (`loadPurchaseOrderLines` →
  `refreshPurchaseOrders` → `loadFromSupabase` → `loadReorderSuggestions`) is
  UNCHANGED — it already re-reads inventory (new `cost_per_unit`/`case_price`) +
  reorder (per-vendor cost), so the item editor / per-vendor card / reorder
  `estimated_cost` reflect the new cost with no new refresh (§11 guidance). Not
  optimistic; `notifyBackendError` on throw unchanged.

**Section (§12)**
- `src/screens/cmd/sections/ReceivingSection.tsx` — `PoReceivingMode`: a new
  per-line **"case price this delivery"** input (new `prices` state map keyed by
  `poItemId`, parallel to `entries`), seeded/ghosted on load with
  `expected_case_price = ln.costPerUnit × ln.caseQty` (per-COUNTED-unit ×
  caseQty — the pinned bridge; NOT the item's live per-each cost). A value equal
  to the ghost (rounded 2dp) or empty is a pure stock receive (no `newCasePrice`);
  a DIFFERENT value marks the line visually (accent border + tint) and attaches
  `newCasePrice`. On commit: the existing spec-107 commit confirm STAYS; if any
  changed line trips the >30% guard (basis-bridged, via `lib/priceGuard`), a
  SECOND nested `confirmAction` fires BEFORE the RPC listing each flagged line as
  `item: $old → $new` (declining aborts the WHOLE commit — nothing received). On
  success, the received toast plus a `pricesUpdatedToast` when `priceChanges` is
  non-empty. New table column header added.
- `src/screens/cmd/lib/priceGuard.ts` — NEW pure helper module (no RN dep):
  `expectedCasePrice(costPerUnit, caseQty)` (the ★ bridge) + `isPriceGuardTripped`
  (case-to-case >30% predicate, guards `expected > 0`) + `PRICE_GUARD_FRACTION`.
  Exported for jest and consumed by the section.

**i18n ×3 (§12)**
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — new
  `section.receiving.*` keys in ALL THREE locales (parity-test-clean):
  `caseThisDeliveryCol` (column header), `caseThisDeliveryPlaceholder` (ghost
  placeholder when no baseline), `pricesUpdatedToast` (`{count}`),
  `priceGuardTitle` / `priceGuardBody` (`{lines}`) / `priceGuardLine`
  (`{item} ${old} → ${new}`) / `priceGuardCta`.

**Tests (§15 jest)**
- `src/screens/cmd/lib/priceGuard.test.ts` — NEW: the pure predicate — exact
  bridge math (per-counted × caseQty), >30% up AND down flagged, ≤30% not flagged
  (incl. exactly 30% boundary), no-baseline (`expected ≤ 0`) → not flagged,
  non-finite entered → not flagged, and the load-bearing `caseQty > 1` BRIDGE PIN
  (a naive per-counted-vs-case comparison would flag the wrong number). Plus a
  real-`t()` interpolation block pinning the guard copy renders old→new + count
  across all three locales.
- `src/screens/cmd/sections/__tests__/ReceivingSection.test.tsx` — UPDATED:
  store mock `receivePurchaseOrder` returns `{ status, priceChanges }`; `line()`
  factory gains `caseQty`; Toast mock cleared per-test; `confirmResponses` queue
  lets a test decline the nested confirm. New cases: ghost = `costPerUnit ×
  caseQty`; a changed price threads `newCasePrice`; an unchanged/empty price sends
  NO `newCasePrice`; the SECOND (30%) confirm fires ONLY when flagged and proceeds
  on confirm; DECLINING the 30% confirm aborts (RPC NOT called); the
  `pricesUpdatedToast` fires on a price change and does NOT fire when
  `priceChanges` is `[]`.

**Validation (all green, LOCAL):** `npx jest` full (83 suites / 925 tests — the
new `priceGuard` suite + the added section cases); `npx tsc --noEmit` (exit 0);
`npx tsc -p tsconfig.test.json --noEmit` (exit 0). Browser (preview) verification
is main Claude's to run — the section is admin Cmd UI PO-mode; the 1100px
breakpoint is not touched by this change (the table is inside the existing
detail-pane ScrollView). No new library; no `app.json`/slug touch.
