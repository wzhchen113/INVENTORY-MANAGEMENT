# Spec 151: Last-order context on count and ordering rows

Status: READY_FOR_REVIEW

> **Owner request (verbatim intent — the thing being built).**
> "Want to show an ordered amount for the ingredients that is ordered since last
> order — e.g. Wednesday was US FOOD 'Wings': July 29th Counted 5 cases, Ordered
> 13 cases — so that admins or users know how much was ordered last week and
> whether to increase or lower the amount depending on sales; if the week was
> slow they might need to order less to avoid overstock."
>
> **Shape.** Every order line — on the spec-149 phone **Approve Order** screen,
> on the spec-143 phone **Ordering** vendor cards, and on the desktop
> **ReorderSection** vendor cards — gains ONE compact, muted "last time" context
> line under the item name:
>
> ```
> LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS        ▲ +3 CS
> ```
>
> plus an optional trend marker (this count vs. the count that drove that order)
> so a slow week is visible without arithmetic.
>
> **Honesty rule (binding, not negotiable).** We never fabricate an "ordered"
> figure. Where the ordered quantity for a line is not persisted, the line says
> so or renders nothing — it never falls back to the suggested quantity, the par
> level, or "today's" stock. See AC-8/AC-9/AC-10 and "Out of scope".

---

## PM summary (plain language, for the owner)

Right now the Ordering screen tells you what the math thinks you should order
tonight. It tells you nothing about what you actually decided last time. So you
either remember, or you guess, or you scroll into the POs section and open last
week's order in another tab.

After this spec, each line carries one small grey line under the item name:

> **WINGS** — `LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS   ▲ +3 CS`

Read that as: "last Wednesday you had 5 cases left and you ordered 13. Tonight
you have 3 cases MORE left than you did then." The up-arrow means slower —
you're sitting on more stock than last cycle, so 13 is probably too many this
week. A down-arrow means the opposite.

Three things stated plainly, with eyes open:

1. **The app does not change the suggested number.** The suggestion still comes
   from `report_reorder_list`, untouched. This spec adds context so *you* can
   judge it. Auto-adjusting pars from the trend is a different, larger feature
   and is an explicit non-goal here.
2. **Some past orders genuinely have no line-level record.** If you exported a
   quick-order list and phoned the vendor, nothing in the database knows what
   you asked for. Those lines show no "ordered" figure rather than a made-up
   one. See the honesty ladder below.
3. **"Ordered" vs. "confirmed ordered" are different things and we label them.**
   A cart-filled BJ's order is recorded as a `draft` purchase order until
   somebody marks it sent. We show the number, tagged **NOT CONFIRMED**, instead
   of either hiding a real decision or overstating it.

### What the data actually supports today (investigated, not assumed)

| Path | Per-line ordered qty persisted? | Where |
|---|---|---|
| Desktop **CREATE PO** (`createPurchaseOrderDraft`) | **Yes** | `po_items.ordered_qty` (BASE/counted units), header `purchase_orders` `status='draft'` |
| **FILL CART** / Chrome cart-filler (spec 138 `upsertVendorDraftOrder`) | **Yes** | same — `status='draft'` until an admin taps MARK-SENT in `POsSection` |
| PO marked sent / received (`markPurchaseOrderSent`, `receive_purchase_order`) | **Yes** | same rows, `status` `sent`/`partial`/`received` |
| **APPROVE & ORDER** (spec 149, all four channels) | **Yes** | `order_approvals.lines[].qty_base` + `status` `pending`/`approved`/`ordered` |
| Quick-order text / CSV / PDF export → phone/email the vendor | **NO** | nothing is written. This is the gap. |
| Instacart checkout completion | **NO webhook** (spec 149 AC-20) — only the admin's MARK ORDERED tap | `order_approvals.status='ordered'` |

There is **no separate extension audit trail** — the cart-filler reads the same
`purchase_orders` / `po_items` rows via `get_extension_order_payload`, so the PO
*is* the extension's record. One less source to reconcile.

The "counted N at that time" figure comes from `eod_entries`
(`actual_remaining` / `actual_remaining_cases` / `actual_remaining_each`) on the
`eod_submissions` row that anchors that order — exactly, via
`order_approvals.source_submission_id` where present, or by matching
`purchase_orders.reference_date` to `eod_submissions.date` for the same
`(store, vendor)`.

## User stories

- **US-1 (the recall).** As a store admin looking at tonight's suggested order,
  I want each line to show what I ordered for that item last time and what the
  count was then, so I can judge the suggestion against my own last decision
  without opening another screen.
- **US-2 (the slow week).** As a store admin, I want to see at a glance whether
  I'm holding more or less stock than at the last order, so a slow week makes me
  order less instead of overstocking.
- **US-3 (approve with context).** As a store admin reviewing a spec-149
  **Approve Order** screen on my phone, I want the same context on each line
  before I tap APPROVE & ORDER, because that is the moment the decision is made.
- **US-4 (no lies).** As a store admin, I would rather see nothing than see a
  number the system guessed. If the last order's quantities were never recorded,
  say so.
- **US-5 (desktop parity).** As an admin working on the desktop Ordering
  section, I want the same context line there, because that is where I do the
  weekly planning pass.

## Acceptance criteria

### A. The context line — content and honesty

- [ ] **AC-1 (the line).** For each rendered order line, when a last-order
      record resolves for that `(store, vendor, item)`, a single muted context
      sub-line renders directly beneath the item name reading
      `LAST {date} · COUNTED {counted} · ORDERED {ordered}` (copy via i18n, not
      hard-coded). `{date}` is the anchor order's business date rendered in the
      existing short form (e.g. `JUL 29`).
- [ ] **AC-2 (anchor selection — deterministic and pinned).** The "last order"
      for a `(store_id, vendor_id)` is the most recent non-cancelled record
      **strictly before** the currently-viewed as-of date, chosen by this
      precedence, which a test must pin row-by-row:
      1. `purchase_orders` with `status IN ('sent','partial','received')` →
         confidence **placed**
      2. `order_approvals` with `status = 'ordered'` → confidence **placed**
      3. `order_approvals` with `status = 'approved'` → confidence **recorded**
      4. `purchase_orders` with `status = 'draft'` → confidence **recorded**

      Ties within a tier break by the later of `reference_date` /
      `business_date`, then `created_at`. `purchase_orders.status='cancelled'`
      and `order_approvals.status='pending'` are **excluded from every tier** —
      a cancelled order and an un-actioned approval are not orders.
- [ ] **AC-3 (confidence label).** A **recorded** (not confirmed placed) anchor
      renders an additional muted qualifier — working copy `NOT CONFIRMED` — in
      the same sub-line, at `C.fg3`, without changing the numbers' tone. A
      **placed** anchor renders no qualifier. Both variants are i18n keys in all
      three catalogs.
- [ ] **AC-4 (units — case-aware, spec-134 conventions).** The backend returns
      quantities in **BASE / counted units** (the same basis `po_items.ordered_qty`
      and `order_approvals.lines[].qty_base` already persist). The client renders
      **cases** with the `CS` suffix when `isCaseRow(item.caseQty)` and base
      units with `item.unit` otherwise, converting through the existing
      `poCaseDisplay` helpers (`poOrderedToCases`). No new conversion helper is
      written. A test pins a `caseQty > 1` line ("13 CS") and a `caseQty <= 1`
      line ("13 lb") from the same base number.
- [ ] **AC-5 (no cost in the context line).** The line shows quantities and a
      date only — **no dollar figure**. Rationale: it sidesteps the spec-104
      per-each → per-counted-unit bridge entirely, which is the single most
      error-prone conversion in this area. A reviewer seeing no `costPerUnit`
      arithmetic in this feature is seeing correct behavior, not an omission.
- [ ] **AC-6 (counted comes from the anchoring count only).** `{counted}` is
      sourced from `eod_entries` on the `eod_submissions` row that anchors the
      order — resolved via `order_approvals.source_submission_id` when the anchor
      is an approval, else by matching `purchase_orders.reference_date` to
      `eod_submissions.date` for the same `(store_id, vendor_id)` with
      `status='submitted'`. It is **never** substituted from
      `inventory_items.current_stock`, from a weekly/spot `inventory_counts` row,
      or from the current reorder payload.
- [ ] **AC-7 (partial data — counted missing).** Anchor found, ordered qty
      found, but no matching count entry ⇒ the line renders
      `LAST {date} · ORDERED {ordered}` with the counted clause **omitted
      entirely**. No `0`, no `—` in the counted slot.
- [ ] **AC-8 (partial data — item not on that order).** Anchor found for the
      vendor, but this item has no line on it ⇒ the line renders
      `LAST {date} · COUNTED {counted} · NOT ORDERED` (i18n key). This claim is
      only made when an anchor order genuinely exists for that vendor — it is a
      statement about that order, not about the world.
- [ ] **AC-9 (no anchor at all).** When no anchor resolves for the vendor, **no
      per-line context renders at all**. Instead the vendor card shows ONE muted
      card-level line — working copy `NO PRIOR ORDER ON RECORD` — so the empty
      state is stated once, not repeated on every row.
- [ ] **AC-10 (never fabricate).** No code path may populate `{ordered}` from
      `suggestedQty` / `suggestedUnits`, `parLevel`, `parReplacement`,
      `usageForecasted`, `pendingPoQty`, or a reorder edit buffer. A reviewer
      finding any such fallback treats it as a **Critical**.

### B. Trend marker (this count vs. the anchoring count)

- [ ] **AC-11 (delta).** When BOTH the current on-hand and the anchor's counted
      figure are available, a trailing marker renders on the same sub-line:
      `▲ +{n}` when current on-hand exceeds the anchor count (more stock left ⇒
      slower), `▼ −{n}` when it is lower, and an i18n "same as last count" token
      when the delta rounds to zero. `{n}` uses the AC-4 unit rendering.
- [ ] **AC-12 (delta suppressed on a stock fallback).** The marker renders ONLY
      when the vendor's current figures come from a real count —
      `ReorderVendor.onHandSource === 'eod'`. When `onHandSource === 'stock'`,
      the marker is **suppressed** (the context line itself still renders):
      comparing a running stock estimate to a real physical count is exactly the
      fabricate trap AC-10 forbids. Pinned by a test.
- [ ] **AC-13 (neutral, non-prescriptive).** The marker uses muted `C.fg3`
      tokens — **not** danger/ok semantic colors — and carries no
      "order less" / "order more" instruction. Rationale: a higher on-hand is
      not universally bad (a delivery may have landed), so the app reports the
      delta and the human decides. No copy in this feature tells the user what
      quantity to pick.

### C. Surfaces (both tiers)

- [ ] **AC-14 (phone — one insertion point, two screens).** The context line is
      added inside the **exported** `VendorOrderCard` in
      `src/screens/cmd/sections/phone/PhoneOrdering.tsx`, which is already
      consumed by BOTH `PhoneOrdering` (spec 143) and `PhoneApproveOrder`
      (spec 149, `PhoneApproveOrder.tsx:406`). Adding it once covers both
      surfaces; forking the component is a review finding.
- [ ] **AC-15 (desktop).** The desktop `ReorderSection` vendor-card item row
      gains the same context line, placed beneath `BreakdownLine`, following the
      existing "also available from …" advisory sub-line idiom
      (`ReorderSection.tsx:857-868`) for tone, size, and placement.
- [ ] **AC-16 (phone-tier a11y bar).** On phone: full item names (flex:1,
      ellipsize only past full width), no horizontal scroll, no new tappable
      target (the line is non-interactive text), both themes via tokens only —
      the spec-140/142/143 bar.
- [ ] **AC-17 (graceful degradation — never blocks the order list).** The
      context data loads independently of `report_reorder_list`. If it fails,
      times out, or has not arrived yet, the order lines render **exactly as they
      do today** with no context sub-line, no error toast, no spinner, and no
      layout shift beyond the absent line. An order screen must never be
      unusable because a nice-to-have annotation failed.

### D. Backend — the read

- [ ] **AC-18 (new read, `report_reorder_list` frozen).** The context is
      delivered by a **new** store-scoped Postgres RPC (working name
      `report_last_order_context`) called through `src/lib/db.ts`.
      `report_reorder_list` and `report_reorder_for_counted_onhand` are **not
      modified** — spec 149 already declared `report_reorder_list` read-only and
      three shipped surfaces depend on its envelope. (See Design guidance 1 for
      why a separate RPC beats widening the envelope; the architect may overrule
      with a written rationale in the design.)
- [ ] **AC-19 (contract shape).** The RPC accepts `(p_store_id uuid,
      p_vendor_ids uuid[], p_as_of_date date)` and returns one envelope per call
      shaped roughly:
      ```
      { "vendors": [ { "vendor_id": uuid,
                       "last_order_date": "2026-07-29",
                       "confidence": "placed" | "recorded",
                       "source": "purchase_order" | "order_approval",
                       "counted_date": "2026-07-29" | null,
                       "items": [ { "item_id": uuid,
                                    "ordered_qty_base": 13,   // null ⇒ AC-8
                                    "counted_qty_base": 5 } ] // null ⇒ AC-7
                     } ] }
      ```
      A vendor with no anchor is either omitted or returned with
      `last_order_date: null` (architect's call, pinned by a test either way).
      `items` is the UNION of lines on the anchor order and item entries on the
      anchoring count, so AC-7 and AC-8 are both expressible.
- [ ] **AC-20 (per-store authorization).** The RPC refuses a store the caller
      cannot see. Default posture: `security invoker` with an explicit
      `auth_can_see_store(p_store_id)` top gate raising `42501` before any read,
      mirroring `create_order_approval` (spec 149 §1.2) and
      `vendor_order_channel`. `order_approvals` additionally requires
      `auth_is_privileged()` per its shipped RLS — if the architect chooses
      `security definer` for planner reasons, BOTH gates must be re-implemented
      explicitly inside the function and pinned by pgTAP.
- [ ] **AC-21 (no new RLS policy, lint stays green).** This spec reads only
      existing tables (`purchase_orders`, `po_items`, `order_approvals`,
      `eod_submissions`, `eod_entries`) and creates **no new table and no new RLS
      policy**. The spec-053 `permissive_policy_lint` pgTAP probe must stay green
      with **no allowlist row added**.
- [ ] **AC-22 (input bounds).** `p_vendor_ids` is bounded (default: ≤ 100
      vendors) and per-vendor `items` output is bounded (default: ≤ 500) so a
      hostile or accidental call cannot fan out unboundedly. Over-bound input
      returns a structured `22023` error, not a hang.
- [ ] **AC-23 (indexed reads, no N+1).** ONE RPC call covers all visible vendors
      for the screen — not one call per vendor and not one per line. The
      supporting predicates ride existing indexes
      (`idx_purchase_orders_store_status_open`, `idx_po_items_po_id`,
      `order_approvals_store_approved_idx`, `eod_submissions` store/date keys);
      the architect adds an index only if the plan demands it, and says so.
- [ ] **AC-24 (client call path).** The read goes through `src/lib/db.ts` with a
      snake→camel mapper, wrapped in `useInflight.getState().track(...)` with
      `{ kind: 'read', label: … }`, matching `fetchReorderSuggestions`. No new
      `supabase.from/rpc` call site outside `db.ts` (the CLAUDE.md carve-out list
      is not extended). No edge function is added — this is PostgREST/RPC only.

### E. Regression group (AC-REG — nothing already shipped changes behavior)

- [ ] **AC-REG-1 (`report_reorder_list` byte-frozen).** Its signature, envelope,
      and every mapped field in `mapReorderVendor` are unchanged. Spec 149's
      "read-only here; not modified" holds through this spec too.
- [ ] **AC-REG-2 (suggested quantities unchanged).** `suggestedQty` /
      `suggestedUnits` / `suggestedCases` / `estimatedCost` and the
      `applyReorderEdits` / `setReorderEditQty` / `poCaseDisplay` write path are
      untouched. This feature is **display-only** — it must not write, seed, or
      nudge a single quantity.
- [ ] **AC-REG-3 (phone/desktop fork intact).** The spec-143 `isPhone` guard in
      `ReorderSection.tsx` stays placed AFTER all hooks; desktop (≥1100px) and
      tablet (768–1099px) continue to render the desktop tree and phone continues
      to render `PhoneOrdering`. The existing `PhoneOrdering.acReg` suite stays
      green; a new `acReg` case pins that the context line appears on the correct
      tier's tree.
- [ ] **AC-REG-4 (spec-149 Approve Order behavior).** `approveOrderState`,
      `disclosureKeyForChannel`, the channel routing, the fee/markup disclosure,
      the single APPROVE & ORDER primary, and the `order_approvals` write path
      are unchanged. The context line is additive decoration inside the card.
- [ ] **AC-REG-5 (extension contract frozen).** `get_pending_extension_orders`,
      `get_extension_order_payload`, `upsertVendorDraftOrder`,
      `markPurchaseOrderSent`, and the `extension/` build are unchanged; the
      extension vitest suite stays green. This spec **reads** the PO rows the
      extension pipeline writes; it never writes them.
- [ ] **AC-REG-6 (staff surface untouched).** `src/screens/staff/` is unchanged.
      Staff count; they do not see order history.
- [ ] **AC-REG-7 (no realtime publication change).** No table is added to or
      removed from `supabase_realtime`. `order_approvals` stays unpublished per
      spec 149 R-5. Therefore **no `docker restart supabase_realtime_imr-inventory`
      step is required** — and if a later revision does touch publication
      membership, the project MEMORY `project_realtime_publication_gotcha` ritual
      applies and must be called out.

### F. i18n

- [ ] **AC-25 (three catalogs, parity green).** Every new string is an i18n key
      present in `src/i18n/en.json`, `es.json`, and `zh-CN.json` under
      `section.reorder.*`. The existing i18n parity test stays green. Working key
      set (names are the architect's/dev's to finalize):
      `lastOrderLine`, `lastOrderCounted`, `lastOrderOrdered`,
      `lastOrderNotOrdered`, `lastOrderNotConfirmed`, `lastOrderNone`,
      `lastOrderDeltaUp`, `lastOrderDeltaDown`, `lastOrderDeltaSame`.
- [ ] **AC-26 (no string concatenation across locales).** The composed line is
      built from a single interpolated template per variant, not by `+`-joining
      localized fragments, so `es` / `zh-CN` word order stays correct.

### G. Tests (spec 022 tracks — the test-engineer routes by track name)

- [ ] **AC-27 (jest).** A **pure** formatter/selector (e.g.
      `buildLastOrderContext(item, vendor, context)`) is extracted and unit
      tested independently of rendering, covering: the four AC-2 anchor tiers and
      the cancelled/pending exclusions; case vs. unit rendering from one base
      number (AC-4); counted-missing (AC-7); item-not-on-order (AC-8); no-anchor
      card-level empty state (AC-9); delta up/down/same (AC-11); delta suppressed
      on `onHandSource === 'stock'` (AC-12); confidence qualifier (AC-3). Plus
      component tests that the line renders in `VendorOrderCard` (covering both
      `PhoneOrdering` and `PhoneApproveOrder`) and in the desktop
      `ReorderSection` item row, and the AC-REG-3 tier-fork pin. Plus an AC-17
      test: context fetch rejects ⇒ the order list still renders, no toast.
- [ ] **AC-28 (pgTAP).** `report_last_order_context` — anchor precedence across
      all four tiers with cancelled/pending excluded (AC-2); the counted figure
      resolves only from the anchoring `eod_submissions` row (AC-6); a
      `NULL` ordered qty for an item absent from the anchor order (AC-8);
      cross-store caller gets zero rows / `42501` (AC-20); a non-privileged
      caller cannot read `order_approvals`-sourced anchors (AC-20); over-bound
      `p_vendor_ids` returns `22023` (AC-22); the `permissive_policy_lint` probe
      stays green with no allowlist addition (AC-21).
- [ ] **AC-29 (shell smoke — explicitly N/A).** No edge function is added or
      modified, so **no shell smoke is required** for this spec. Stated
      explicitly so the test-engineer does not invent one and a reviewer does not
      flag its absence as a gap.

## In scope

- One new store-scoped read RPC (working name `report_last_order_context`) over
  existing tables, plus its `src/lib/db.ts` fetcher + mapper.
- A pure `buildLastOrderContext`-style formatter shared by phone and desktop.
- The context sub-line in the exported `VendorOrderCard` (covers
  `PhoneOrdering` **and** `PhoneApproveOrder`).
- The context sub-line in the desktop `ReorderSection` item row.
- The neutral trend marker (AC-11/12/13).
- The card-level `NO PRIOR ORDER ON RECORD` empty state.
- i18n keys in all three catalogs.
- Tests on the jest and pgTAP tracks (AC-27/28).

## Out of scope (explicitly — non-goals)

- **Changing the reorder math, pars, run-rate, or the suggested quantity.**
  Rationale: the owner asked to *see* last week's decision, not to have the app
  make this week's. `report_reorder_list` stays frozen (AC-REG-1/2).
- **Auto-adjusting pars or suggestions from the trend delta.** Rationale: that
  is a forecasting feature with its own failure modes (a delivery mid-cycle, a
  holiday week, a menu change) and deserves its own spec. This one reports.
- **Backfilling line quantities for orders that never recorded them.** Rationale:
  the data does not exist and inventing it would violate AC-10. Forward-only.
- **Adding a write path so quick-order-text / CSV / PDF exports record an order.**
  Rationale: real and tempting, but it changes the export flows (three shipped
  surfaces) and belongs in its own spec. Surfaced as **OQ-5** instead.
- **Auto-marking cart-filled drafts as sent.** Rationale: it would convert
  AC-3's honest **NOT CONFIRMED** into a fabricated **placed**. The
  `markPurchaseOrderSent` path stays a deliberate human action (AC-REG-5).
- **A full per-item order-history panel / sparkline / N-cycle trend.** Rationale:
  the owner asked for "last time", singular. Multi-cycle history is a follow-up.
  Deliberately not designed around here.
- **Surfacing the context in `POsSection`, `OrderingSection`, `ReceivingSection`,
  `InventoryCountSection`, `PhoneWeeklyCount`, the desktop `EODCountSection`, or
  any staff surface.** Rationale: the owner named the ordering decision points;
  three surfaces is the scope. Adding a fourth is a one-line follow-up once the
  formatter exists.
- **Weekly / spot `inventory_counts` as a counted source.** Rationale: the
  ordering cycle is anchored on EOD (`eod_submissions`), matching spec 121/149
  scoping. Flagged as **OQ-3**.
- **Any edge function, any new table, any new RLS policy, any realtime
  publication change.** (AC-21, AC-24, AC-REG-7.)
- **`app.json` slug / identity drift.** Untouched — this feature adds no build
  identifier, store listing, or push-cert change (CLAUDE.md DO-NOT-AUTO-FIX).

## Open questions resolved (PM defaults chosen from the owner's request)

- Q: Does "ordered since last order" mean the quantity ON the last order, or a
  cumulative total ordered since then? → A: **The quantity on the last order** —
  a point-in-time snapshot. The owner's own example ("July 29th Counted 5 cases,
  Ordered 13 cases") is a single dated pair. (Alternative reading flagged as
  OQ-1.)
- Q: Which surfaces? → A: The spec-149 phone **Approve Order** screen, the
  spec-143 phone **Ordering** vendor cards, and the desktop **ReorderSection**
  vendor cards. Both tiers.
- Q: Is there a trend hint? → A: **Yes** — a neutral `▲ +n` / `▼ −n` delta of
  current on-hand vs. the anchoring count, suppressed on a stock fallback, with
  no prescriptive copy (AC-11/12/13).
- Q: Where does the ordered figure come from? → A: `po_items.ordered_qty` and
  `order_approvals.lines[].qty_base`, by the AC-2 precedence. There is no
  separate extension audit trail — the cart-filler reads the same PO rows.
- Q: What about orders with no line record (exported + phoned in)? → A: They
  produce no context. AC-9's card-level empty state, never a guessed number.
- Q: Cart-filled drafts that were never marked sent? → A: Shown, tagged
  **NOT CONFIRMED** (AC-3). Hiding them would blank the owner's primary
  BJ's/Sam's flow; presenting them as placed would be a lie.
- Q: Money on the context line? → A: **No** (AC-5) — avoids the spec-104
  per-each bridge entirely.
- Q: Edge function or PostgREST? → A: **PostgREST/RPC only.** No secret, no
  upstream, no HTML — nothing an edge function buys here.

## Open questions (non-blocking — defaults chosen so the architect is unblocked)

Each has a PM default. The owner can override any at architect review without
reshaping the contract.

- **OQ-1 — the cumulative reading.** If the owner actually meant "total ordered
  *since* the last order/count" (a running sum), the RPC would aggregate rather
  than pick an anchor. **Default: point-in-time snapshot of the last order**, per
  the owner's example. If overridden, AC-2's precedence becomes a filter over a
  date window instead of a pick, and AC-8's "NOT ORDERED" copy changes — the
  surfaces and the formatter contract are otherwise unaffected.
- **OQ-2 — case-size drift.** `caseQty` can change between the anchor order and
  today, so 13 base units may have been "1 case" then and "0.5 cases" now.
  **Default: render using the CURRENT `item.caseQty`** (the only value the client
  has) and accept the drift; pin the behavior with a test that documents it
  rather than hides it. Alternative the architect may take: persist/return the
  anchor's own `case_qty` from `po_items` / `order_approvals.lines[].case_qty`
  (the approval snapshot already carries `case_qty`) and render each figure in
  its own era's cases. Slightly more honest, slightly more plumbing.
- **OQ-3 — weekly/spot counts as a counted source.** **Default: EOD only**
  (`eod_submissions` + `eod_entries`), matching spec 121/149 scoping. If the
  owner wants a weekly count to anchor a weekly-cadence vendor,
  `inventory_counts` / `inventory_count_entries` becomes a second source and
  AC-6's resolution grows a tier.
- **OQ-4 — separate RPC vs. widening `report_reorder_list`.** **Default:
  separate RPC** (AC-18, Design guidance 1). The architect may fold it into the
  reorder envelope if the extra round trip proves to be the wrong trade, but must
  then account for AC-17 (independent failure) and AC-REG-1 (three shipped
  consumers of the current envelope) in writing.
- **OQ-5 — closing the "exported and phoned it in" gap.** Should the
  quick-order-text / CSV / PDF export paths start recording a `draft` PO so those
  orders gain a line record going forward? **Default: NO in this spec** — it
  changes three shipped export flows and is a write-path change hiding inside a
  display feature. Flagged for a follow-up spec. Until then, those vendors show
  AC-9's empty state, which is honest and self-explaining.
- **OQ-6 — "NOT CONFIRMED" copy and prominence.** **Default: a muted inline
  qualifier** at `C.fg3`. If the owner finds it either too shouty or too easy to
  miss, the alternatives are a small chip or dropping the qualifier and excluding
  `recorded`-tier anchors entirely (which loses the BJ's/Sam's case — flagged as
  the cost of that choice).
- **OQ-7 — how far back to look.** **Default: unbounded** (the most recent
  qualifying record, however old), with the date always shown so a stale
  reference is self-evident. If the owner prefers a cutoff (e.g. "nothing older
  than 60 days"), it becomes an RPC parameter with a default.

## Design guidance for the architect (not owner questions — do not reopen)

1. **Separate RPC, and let it fail alone.** The reorder list is the screen's
   load-bearing payload; the context is decoration. Coupling them means a slow or
   broken annotation query can break ordering. Keep the call separate, fire it
   after (or in parallel with) the reorder load, and make the UI's absence of
   context a normal state rather than an error state (AC-17). `report_reorder_list`
   also has three shipped consumers whose envelope tests would all move if it
   widened.

2. **Extract the formatter as a pure function before touching either surface.**
   Phone (`VendorOrderCard`) and desktop (`ReorderSection` item row) must not
   drift. Put `buildLastOrderContext(...)` in `src/utils/` (peer to
   `poCaseDisplay` / `reorderExport`), have it return a discriminated result
   (`{ kind: 'none' } | { kind: 'line', … }`) rather than a pre-formatted string,
   and let each tier render its own tokens. That is also what makes AC-27's pure
   unit tests possible without mounting anything.

3. **One insertion point for phone.** `VendorOrderCard` is already exported from
   `PhoneOrdering.tsx` and already consumed by `PhoneApproveOrder.tsx:406`
   (spec-149 §9 reuse). Add the line there. Copy-pasting into
   `PhoneApproveOrder` is a review finding, not a shortcut.

4. **Base units in, display units out.** `po_items.ordered_qty`,
   `order_approvals.lines[].qty_base`, and `eod_entries.actual_remaining` are all
   BASE/counted units. The RPC returns base; only the render layer converts, via
   the existing `poCaseDisplay` helpers. Do not convert in SQL and do not add a
   second conversion helper. (The `eod_entries.actual_remaining_cases` /
   `_each` columns exist and are tempting — prefer `actual_remaining` as the
   single basis and let the client convert, so counted and ordered go through the
   same code path.)

5. **The anchor query wants care, not cleverness.** Two candidate sources with
   four status tiers and a tie-break is easy to get subtly wrong and hard to
   notice. Prefer one readable CTE per source, a `union all` with an explicit
   `tier` integer, and a single `distinct on (vendor_id) … order by tier,
   anchor_date desc, created_at desc`. Then AC-2's precedence table is literally
   visible in the SQL and pgTAP can walk it row by row.

6. **`security invoker` unless you can justify otherwise.** The five source
   tables all carry working RLS today (`order_approvals` additionally demands
   `auth_is_privileged()`, spec 149 §2). Invoker means the caller's own policies
   do the clipping and there is no new privilege surface to audit. If the planner
   forces DEFINER, both gates get re-implemented explicitly at the top of the
   function, before any read, and pgTAP pins both refusals.

7. **Watch the "not ordered" claim.** AC-8 asserts something about the world. It
   is only safe because it is scoped to a specific, identified anchor order. If
   the RPC ever starts returning a vendor block without a resolved anchor, the
   copy must fall back to AC-9's empty state — a bare "NOT ORDERED" with no
   anchor date is unfalsifiable and would be worse than silence.

8. **No publication change, no restart ritual.** Nothing here is realtime.
   `order_approvals` stays unpublished (spec 149 R-5). A second admin device sees
   the context on its next reload, which is fine for a historical annotation.
   Keep it that way and the `project_realtime_publication_gotcha` ritual never
   enters this spec (AC-REG-7).

## Dependencies

- `supabase/migrations/20260405000759_init_schema.sql` — `purchase_orders`
  (`store_id`, `vendor_id`, `status`, `created_at`), `po_items`
  (`ordered_qty`, `received_qty`, `cost_per_unit`), `eod_submissions`
  (`store_id`, `date`, `status`), `eod_entries` (`actual_remaining`).
- `supabase/migrations/20260502071736_remote_schema.sql` —
  `purchase_orders.reference_date`.
- `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql` —
  `eod_submissions.vendor_id`, the join key for the counted anchor.
- `supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql` —
  `eod_entries.actual_remaining_cases` / `actual_remaining_each`.
- `supabase/migrations/20260704000000_po_loop.sql` — the
  `draft | sent | partial | received | cancelled` status vocabulary AC-2's
  precedence is written against, plus `idx_purchase_orders_store_status_open`
  and `idx_po_items_po_id`.
- `supabase/migrations/20260723000000_extension_ordering.sql` (specs 131/132) —
  the MARK-ORDERED write-back is `status draft→'sent'`, which is why AC-3's
  **NOT CONFIRMED** tier exists. Frozen (AC-REG-5).
- `supabase/migrations/20260801000100_order_approvals.sql` (spec 149) —
  `order_approvals` table, `lines[].qty_base` / `case_qty`, `status`
  `pending|approved|ordered`, `source_submission_id`, `business_date`,
  `order_approvals_store_approved_idx`, and the
  `privileged_store_read_order_approvals` policy AC-20 must respect.
- `supabase/migrations/20260726000000_reorder_drop_inbound_term.sql` — current
  owner of `report_reorder_list`. **Read-only here; not modified** (AC-REG-1).
- `supabase/migrations/20260504173035_per_store_rls_hardening.sql` —
  `auth_can_see_store()`; `auth_is_privileged()` for the `order_approvals` read.
- `src/lib/db.ts` — `fetchReorderSuggestions` / `mapReorderVendor` (the shape the
  context must line up with), `fetchPurchaseOrderLines`,
  `createPurchaseOrderDraft`, `upsertVendorDraftOrder`, `markPurchaseOrderSent`,
  `useInflight.track` conventions; new fetcher + mapper land here.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (spec 143) — the exported
  `VendorOrderCard` (single phone insertion point) and `LineStepper`.
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` (spec 149) — consumer of
  `VendorOrderCard` at line 406; `approveOrderState` / `disclosureKeyForChannel`
  unchanged (AC-REG-4).
- `src/screens/cmd/sections/ReorderSection.tsx` — the desktop item row,
  `BreakdownLine`, the "also available from" advisory-line idiom, the spec-143
  `isPhone` guard (AC-REG-3), `applyReorderEdits` / `narrowReorderToVendor`.
- `src/utils/poCaseDisplay.ts` (spec 134) — `isCaseRow` / `poOrderedToCases`
  (AC-4); `src/utils/reorderExport.ts` — `formatQty`.
- `src/store/useStore.ts` — `reorderPayload`, `orderSubmissions` (header-only —
  it carries **no** line items, which is why a new read is required), the load
  lifecycle the context fetch hangs off.
- `src/i18n/en.json` / `es.json` / `zh-CN.json` + the i18n parity test (AC-25).
- New migration (the RPC only); prod apply via the Supabase MCP path (`db push`
  lacks the prod password) with the exact version inserted into
  `supabase_migrations.schema_migrations` so `db-migrations-applied.yml` stays
  green (project MEMORY).

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI. Desktop
  `src/screens/cmd/sections/ReorderSection.tsx`; phone
  `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (`VendorOrderCard`) which
  also serves `PhoneApproveOrder.tsx`. No legacy admin surface exists (spec 025).
- **Which app:** this repo (admin) only. `src/screens/staff/` is untouched
  (AC-REG-6); the customer PWA and the Chrome extension are siblings — the
  extension is an unmodified upstream writer of the `purchase_orders` rows this
  spec reads (AC-REG-5).
- **Per-store or admin-global:** **per-store.** The RPC gates on
  `auth_can_see_store(p_store_id)`; the `order_approvals` source additionally
  inherits its shipped `auth_is_privileged()` conjunct (AC-20). No new policy is
  created, so the spec-053 `permissive_policy_lint` probe stays green with **no
  allowlist addition** (AC-21).
- **Edge function or PostgREST:** **PostgREST/RPC only.** No secret to hold, no
  upstream to call, no HTML to render — an edge function would buy nothing and
  add an auth surface. Client access through `src/lib/db.ts` (AC-24); the
  CLAUDE.md `supabase.from/rpc` carve-out list is **not** extended.
- **Realtime channels touched:** **none.** No table is added to or removed from
  the `supabase_realtime` publication (`order_approvals` stays unpublished per
  spec 149 R-5), so the
  `docker restart supabase_realtime_imr-inventory` re-snapshot ritual
  (project MEMORY `project_realtime_publication_gotcha`) does **not** apply.
  Existing `store-{id}` / `brand-{id}` sync is unchanged; the context refreshes
  on the next reorder load. If a revision does touch publication membership, that
  is a scope change and the gotcha must be raised (AC-REG-7).
- **Migrations needed:** **yes — one**, creating `report_last_order_context` (+
  an index only if the plan demands it, with justification). Strictly additive;
  no destructive DDL, no column change, no policy change. Prod apply via MCP +
  `schema_migrations` insert.
- **Edge functions touched:** **none.**
- **Web/native scope:** admin app, **both** web (Vercel) and native (EAS), phone
  and desktop tiers. Nothing here is web-only — no CSS-specific behavior, no
  web-push, no `Linking` / external URL.
- **Tests (spec 022 tracks):** jest (AC-27) and pgTAP (AC-28). **Shell smoke is
  explicitly N/A** (AC-29) — no edge function exists to smoke.
- **`app.json` slug:** untouched. Nothing in this spec touches build identifiers,
  store listings, or push certs (CLAUDE.md DO-NOT-AUTO-FIX).
- **CI:** both gates (`test.yml`, `db-migrations-applied.yml`) must be green on
  `main` before this ships; the migration gate will be red between commit and MCP
  prod-apply, which is expected and must be flagged, not "fixed".

## Handoff

next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_REVIEW.
payload_paths:
  - specs/151-last-order-context.md

---

# Backend design

Design authority for spec 151. Read §0 before anything else — it resolves the
three items the PM routed to the architect (AC-2 precedence shape, AC-20 auth
posture, OQ-4) plus seven rulings where the ACs were ambiguous or arithmetically
impossible as literally written.

Nothing here re-opens a resolved open question. Nothing here changes
`report_reorder_list`, any write path, any RLS policy, any publication, or any
edge function.

---

## §0 — Rulings up front

| # | Question | Ruling |
|---|---|---|
| **R-A** | **OQ-4 — separate RPC vs. widening `report_reorder_list`?** | **Separate RPC.** PM default UPHELD. No written overrule. See §0.1 for the AC-17 / AC-REG-1 accounting the PM required of an overrule — recorded here so it is on the record that the trade was actually evaluated, not defaulted into. |
| **R-B** | **AC-20 — invoker or definer?** | **`security invoker`**, one explicit `auth_can_see_store(p_store_id)` top gate raising `42501` before any read. **NO** top-level `auth_is_privileged()` gate. See §0.2 — this is the load-bearing decision of the whole spec. |
| **R-C** | **AC-2 — anchor query shape.** | `union all` of two CTEs with an explicit `tier` integer, then `distinct on (vendor_id) … order by vendor_id, tier asc, anchor_date desc, created_at desc`. Design guidance 5 UPHELD verbatim. §2.2. |
| **R-D** | **AC-19 — vendor with no anchor: omitted or `last_order_date: null`?** | **OMITTED from `vendors[]` entirely.** Design guidance 7 makes this structural rather than a nullable field a future FE change could misread into an unanchored "NOT ORDERED". Pinned by pgTAP + jest. §3.2. |
| **R-E** | **AC-6 — approval anchor whose `source_submission_id` is NULL.** | Falls back to the **same** `(store_id, vendor_id, business_date) → eod_submissions` date match the PO path uses. It is the identical identity relation (that triple is `eod_submissions`' unique key), not a looser one. Not a fabrication. §2.3. |
| **R-F** | **AC-12 — delta suppression grain.** | **Tightened.** Suppress when `vendor.onHandSource !== 'eod'` **OR** `item.flags` contains `'eod_missing_for_item'`. The flag means *this row* fell back to `current_stock` even though the vendor rolled up to `'eod'` — the exact fabricate trap AC-12 forbids, at row grain. Architect addition, in AC-12's spirit; pinned by jest so a reviewer reads it as intent. §5.3. |
| **R-G** | **AC-9 — "no anchor" vs. "not loaded yet" are different states.** | The store slice is `LastOrderContext \| **null**`. `null` ⇒ render **nothing** (no per-line context, no card-level line). Non-null map + vendor absent ⇒ AC-9's card-level line. Without this tri-state every card would read `NO PRIOR ORDER ON RECORD` for the whole load window — a lie the honesty rule forbids, and an AC-17 layout-shift violation. §5.4. |
| **R-H** | **AC-4's literal test text is arithmetically impossible.** | AC-4 asks a test to pin `"13 CS"` and `"13 lb"` "from the same base number". `13 base ÷ caseQty > 1` can never be `13`. Read as intent, not arithmetic: the test pins ONE base value through both branches — `base 78, caseQty 6 → "13 CS"` and `base 13, caseQty 1 → "13 lb"`. No conversion helper is added either way (AC-4's real requirement). §5.2. |
| **R-I** | **A fourth line variant the AC-25 key set is missing.** | An anchor exists, the item is on neither the anchor order nor the anchoring count. AC-8's copy needs a `{counted}` that does not exist. New key `lastOrderNotOrderedNoCounted` → `LAST {date} · NOT ORDERED`. Still anchored (guidance 7 satisfied — the claim is about an identified order). §6. |

### §0.1 — R-A accounting (OQ-4)

The PM allowed an overrule with written rationale covering AC-17 and AC-REG-1.
I am **not** overruling; here is why, so nobody re-litigates it in review:

- **AC-17 is unachievable inside the reorder envelope.** One RPC = one failure
  domain. A slow or erroring anchor CTE would take the whole order list with it.
  AC-17's "never blocks the order list" is a *structural* property of two calls,
  not something a `try`/`exception when others` inside one PL/pgSQL body can
  honestly deliver (an exception block that swallows a planner OOM or a
  statement timeout is a fiction).
- **AC-REG-1 has three shipped consumers.** `report_reorder_list` feeds
  `fetchReorderSuggestions` → desktop `ReorderSection`, `PhoneOrdering`, and
  `PhoneApproveOrder`, plus `mapReorderVendor`'s envelope tests and the staff
  reorder screen's own mapper. Widening it moves all of those, and spec 149
  already declared it read-only.
- **Cost of the extra round trip: one RPC per screen open/date change.** Not per
  vendor, not per line (AC-23). On the 286 KB seed that is a single sub-10 ms
  query. The trade is not close.

### §0.2 — R-B, the authorization posture (AC-20)

The five source tables all carry working per-store RLS today:

| Table | SELECT policy | Predicate |
|---|---|---|
| `purchase_orders` | `store_member_read_purchase_orders` | `auth_can_see_store(store_id)` |
| `po_items` | `store_member_read_po_items` | `exists(purchase_orders … auth_can_see_store)` |
| `eod_submissions` | `store_member_read_eod_submissions` | `auth_can_see_store(store_id)` |
| `eod_entries` | `store_member_read_eod_entries` | `exists(eod_submissions … auth_can_see_store)` |
| `order_approvals` | `privileged_store_read_order_approvals` | `auth_is_privileged() **and** auth_can_see_store(store_id)` |

`auth_can_see_store()` and `auth_is_privileged()` are both
`language sql stable security definer` — the planner treats them as constants
per statement, so invoker costs nothing here.

**Decision: `security invoker`, gate on `auth_can_see_store(p_store_id)` only.**

The consequence, stated explicitly because a reviewer will ask: a caller who can
see the store but is **not** privileged reads **zero** `order_approvals` rows,
so tiers 2 and 3 are invisible to them and their anchor resolves from the PO
tiers (1 and 4) or not at all. That is not a bug — it is the shipped spec-149
RLS doing its job, and it is exactly what AC-28's "a non-privileged caller
cannot read `order_approvals`-sourced anchors" asks the pgTAP suite to prove.

**Do NOT add a top-level `auth_is_privileged()` gate.** It would refuse the
entire context read (including the PO-sourced anchors that user can already
read directly via PostgREST) to a legitimate non-privileged store member, which
is a regression dressed as hardening. `order_approvals`' privilege conjunct is
a *row filter*, not a *feature gate*, and invoker preserves that distinction for
free.

**Do NOT convert to `security definer`.** There is no planner reason to (all
predicates are indexed and store-scoped), and definer would require
re-implementing both gates by hand — a second copy of an authorization rule
that already exists, i.e. exactly the drift surface CLAUDE.md's
inline-not-shared rationale warns about. If a future revision ever does need
definer, AC-20's requirement stands: **both** gates re-implemented at the top,
before any read, both pinned by pgTAP.

This mirrors `create_order_approval` ([supabase/migrations/20260801000100_order_approvals.sql:278-311](supabase/migrations/20260801000100_order_approvals.sql)),
`receive_purchase_order` / `close_short_purchase_order` / `cancel_purchase_order`
([supabase/migrations/20260704000000_po_loop.sql:160-416](supabase/migrations/20260704000000_po_loop.sql)),
and `report_reorder_list` itself (same file, `:459-462`) — invoker + explicit
`42501` top gate is the house shape for a store-scoped read.

---

## §1 — Data model changes

**No new table. No new column. No column type change. No destructive DDL.**
This spec reads only tables that already exist.

### 1.1 `supabase/migrations/20260803000000_report_last_order_context.sql`

Strictly additive. Contents, in this order, in one `begin; … commit;`:

1. `create or replace function public.report_last_order_context(uuid, uuid[], date) returns jsonb` (§2).
2. `comment on function` — the house convention (every RPC in this repo carries one).
3. `revoke all on function … from public, anon;` + `grant execute … to authenticated;` — byte-mirroring `create_order_approval`'s grant block. This is a **new** function so the grants must be emitted (unlike a `create or replace` of an existing signature, which preserves them).
4. `create index if not exists idx_eod_entries_submission_id on public.eod_entries (submission_id);` (§1.2).

**Rollout safety.** Additive-only; a re-run is idempotent (`create or replace`,
`create index if not exists`). There is no state to migrate, no backfill, no
lock beyond the brief `ACCESS EXCLUSIVE` of the index build on a small table.
Rolling back is `drop function public.report_last_order_context(uuid, uuid[], date);`
— the FE degrades to AC-17's no-context state on its own, so a rollback needs no
coordinated FE deploy.

**Prod apply.** Via the Supabase MCP `execute_sql` path against
`ebwnovzzkwhsdxkpyjka` (`db push` lacks the prod password — project MEMORY
`project_prod_migration_via_mcp`), then `INSERT` the exact version
`'20260803000000'` into `supabase_migrations.schema_migrations`. Post-apply
verification: the function by **normalized-md5** of `prosrc`, and the index by
presence in `pg_indexes`. **The `db-migrations-applied.yml` gate will be RED
between the commit and the MCP apply. That is expected. Flag it; do not "fix"
it by deleting the migration.**

### 1.2 The one new index — justification (AC-23)

Existing indexes already cover four of the five reads:

| Read | Index | New? |
|---|---|---|
| `purchase_orders` anchor scan (`store_id`, date) | `idx_purchase_orders_store_reference_date (store_id, reference_date)` ([20260502071736:177](supabase/migrations/20260502071736_remote_schema.sql)) | no |
| `po_items` line fetch by `po_id` | `idx_po_items_po_id` ([20260704000000:144](supabase/migrations/20260704000000_po_loop.sql)) | no |
| `order_approvals` anchor scan | `order_approvals_store_vendor_date_uidx (store_id, vendor_id, business_date)` — an exact match for the predicate ([20260801000100:80](supabase/migrations/20260801000100_order_approvals.sql)) | no |
| `eod_submissions` counted match | the `eod_submissions_store_id_date_vendor_id_key` unique constraint's index — exact match ([20260514120000:119](supabase/migrations/20260514120000_eod_submissions_vendor_id.sql)) | no |
| **`eod_entries` by `submission_id`** | **none exists** — `eod_entries_item_id_idx` is on `item_id` only | **YES** |

`eod_entries` has **no index on `submission_id`**. This function drives from up
to 100 resolved submissions and reads every entry of each — without the index
that is a seq scan of the whole entries table per call, and `eod_entries` is
the fastest-growing table in this schema (one row per item per vendor per day,
forever). `report_reorder_list` tolerates the same gap today only because it
resolves at most one submission per vendor for a single date.

So: **one index, `idx_eod_entries_submission_id`.** Additive, ~nothing on the
seed, and it incidentally improves `report_reorder_list` (4f) and the spec-122
ingredient-changed-badge query. The dev should still run `explain (analyze,
buffers)` on the seed for the full RPC and paste the plan into the PR body —
if any other node comes back a seq scan on a table above ~10k rows, say so
rather than adding a second index silently.

---

## §2 — The RPC

```sql
public.report_last_order_context(
  p_store_id   uuid,
  p_vendor_ids uuid[],
  p_as_of_date date default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
```

Signature exactly as AC-19 specifies. `p_as_of_date` is nullable and defaults
to `current_date` inside the body — same UTC caveat `report_reorder_list`
carries, and the FE always passes the store-local date it already computed.

### 2.1 Top gates (before any read)

```
(1) if not auth_can_see_store(p_store_id)
       raise '42501'  'not authorized for this store'
(2) v_raw_n := coalesce(array_length(p_vendor_ids, 1), 0)
    if v_raw_n > 100
       raise '22023'  'invalid vendor list: expected 0..100 vendor ids, got %'
(3) v_ids := distinct non-null elements of p_vendor_ids
    if v_ids is empty  →  return { "as_of_date": …, "vendors": [] }   -- NOT an error
(4) v_as_of := coalesce(p_as_of_date, current_date)
```

The bound check runs on the **raw** input length, before de-duplication — a
hostile 10 000-element array of one repeated uuid must be refused, not silently
collapsed to one (AC-22).

An empty / null vendor list is a **normal** return, not `22023`. An empty
reorder payload is an ordinary state (no vendors order out today) and AC-17
says the absence of context is never an error.

### 2.2 Anchor selection (AC-2) — the shape

Design guidance 5 verbatim. Two readable CTEs, one `union all`, an explicit
`tier` integer, one `distinct on`. The precedence table is literally visible in
the SQL and pgTAP walks it row by row.

```
po_candidates as (
  select po.vendor_id,
         case when po.status in ('sent','partial','received') then 1 else 4 end  as tier,
         case when po.status in ('sent','partial','received')
              then 'placed' else 'recorded' end                                   as confidence,
         'purchase_order'::text                                                   as source,
         po.id                                                                    as source_id,
         coalesce(po.reference_date, (po.created_at at time zone 'utc')::date)    as anchor_date,
         po.created_at
    from public.purchase_orders po
   where po.store_id = p_store_id
     and po.vendor_id = any(v_ids)
     and po.status in ('sent','partial','received','draft')     -- 'cancelled' EXCLUDED
     and coalesce(po.reference_date, (po.created_at at time zone 'utc')::date) < v_as_of
),
oa_candidates as (
  select oa.vendor_id,
         case when oa.status = 'ordered' then 2 else 3 end                        as tier,
         case when oa.status = 'ordered' then 'placed' else 'recorded' end        as confidence,
         'order_approval'::text                                                   as source,
         oa.id                                                                    as source_id,
         oa.business_date                                                         as anchor_date,
         oa.created_at
    from public.order_approvals oa
   where oa.store_id = p_store_id
     and oa.vendor_id = any(v_ids)
     and oa.status in ('ordered','approved')                    -- 'pending' EXCLUDED
     and oa.business_date < v_as_of
),
anchors as (
  select distinct on (vendor_id) *
    from (select * from po_candidates union all select * from oa_candidates) u
   order by vendor_id, tier asc, anchor_date desc, created_at desc
)
```

Notes the dev must not "clean up":

- **`< v_as_of` is STRICT.** Today's own PO/approval is not "last time".
- **`coalesce(reference_date, created_at::date)`** — `reference_date` is
  nullable with no default and legacy prod rows carry NULL
  ([20260502071736:149](supabase/migrations/20260502071736_remote_schema.sql)).
  Without the coalesce those rows would silently never anchor. Cast through
  `at time zone 'utc'` explicitly so the derived date is deterministic
  regardless of the session `TimeZone` GUC.
- **Status exclusions are in the `where`, not filtered later.** `cancelled` and
  `pending` must never enter the union — a `case` that maps them to a high tier
  would let a cancelled order win when it is the only row.
- **`tier` DOMINATES recency.** A `sent` PO from six weeks ago outranks a
  `draft` PO from yesterday. That is what AC-2 says ("chosen by this
  precedence"), and it is pinned. See R-2 in §9 for the alternative and why the
  owner may want it.
- **RLS does the rest.** Under invoker, `oa_candidates` returns zero rows for a
  non-privileged caller — no explicit privilege branch in the SQL. That is R-B
  working as designed.

### 2.3 The counted anchor (AC-6, R-E)

```
counted_sub as (
  select a.vendor_id,
         coalesce(direct.id,   bydate.id)   as submission_id,
         coalesce(direct.date, bydate.date) as counted_date
    from anchors a
    -- (a) exact provenance: the approval's own source_submission_id
    left join public.eod_submissions direct
           on a.source = 'order_approval'
          and direct.id = (select oa.source_submission_id
                             from public.order_approvals oa
                            where oa.id = a.source_id)
          and direct.store_id  = p_store_id          -- defense in depth over RLS
          and direct.vendor_id = a.vendor_id
          and direct.status    = 'submitted'
    -- (b) identity match on the anchor's own business date
    left join public.eod_submissions bydate
           on bydate.store_id  = p_store_id
          and bydate.vendor_id = a.vendor_id
          and bydate.date      = a.anchor_date
          and bydate.status    = 'submitted'
)
```

`(store_id, date, vendor_id)` is `eod_submissions`' unique key, so `bydate`
matches at most one row — this is an identity relation, not a heuristic.
Precedence `direct` → `bydate` is R-E: an approval with a NULL
`source_submission_id` degrades to the same date match the PO path uses rather
than losing its counted figure. Both joins are `left`, so no match ⇒ AC-7.

**Forbidden substitutions (AC-6, AC-10).** `inventory_items.current_stock`,
`inventory_counts` / `inventory_count_entries`, `ReorderItem.onHand`, or
anything from the current reorder payload. Not present in this function; a
reviewer finding one treats it as a Critical.

### 2.4 Lines (AC-7 / AC-8 / AC-19)

```
ordered_lines as (
    select a.vendor_id, pit.item_id,
           sum(coalesce(pit.ordered_qty, 0))::numeric as ordered_qty_base
      from anchors a
      join public.po_items pit on pit.po_id = a.source_id
     where a.source = 'purchase_order'
     group by a.vendor_id, pit.item_id
  union all
    select a.vendor_id, (l->>'item_id')::uuid,
           sum((l->>'qty_base')::numeric)
      from anchors a
      join public.order_approvals oa on oa.id = a.source_id
      cross join lateral jsonb_array_elements(oa.lines) l
     where a.source = 'order_approval'
       and nullif(btrim(coalesce(l->>'item_id','')), '') is not null
       and jsonb_typeof(l->'qty_base') = 'number'
     group by a.vendor_id, (l->>'item_id')::uuid
),
counted_lines as (
    select cs.vendor_id, e.item_id, e.actual_remaining::numeric as counted_qty_base
      from counted_sub cs
      join public.eod_entries e on e.submission_id = cs.submission_id
     where e.actual_remaining is not null
),
item_union as (   select vendor_id, item_id from ordered_lines
                  union
                  select vendor_id, item_id from counted_lines ),
items_ranked as (
  select iu.vendor_id, iu.item_id, ol.ordered_qty_base, cl.counted_qty_base,
         row_number() over (partition by iu.vendor_id
                            order by ol.ordered_qty_base desc nulls last, iu.item_id)
           as rn,
         count(*)  over (partition by iu.vendor_id) as total_n
    from item_union iu
    left join ordered_lines ol using (vendor_id, item_id)
    left join counted_lines cl using (vendor_id, item_id)
)
```

- `sum(...)` on both branches: a PO or an approval snapshot may legally carry
  two lines for the same item; the context reports the total ordered for that
  item on that order.
- The approval branch re-reads `order_approvals` under RLS. Redundant (the row
  already passed once in `oa_candidates`) but harmless, and it keeps the
  RLS story uniform — no `security definer` shortcut anywhere.
- The `jsonb_typeof(... ) = 'number'` guard mirrors `create_order_approval`'s
  own validation so a hand-written prod row can't crash the cast.
- **`item_union` is the UNION** of ordered and counted item ids — that is what
  makes AC-7 (`ordered` present, `counted` NULL) and AC-8 (`counted` present,
  `ordered` NULL) both expressible in one row shape. Do not turn it into an
  inner join.
- **AC-22 output bound:** emit only `rn <= 500` per vendor, plus
  `items_truncated := (total_n > 500)`. Deterministic order (biggest ordered
  quantity first, `item_id` as the stable tiebreak) so a truncated payload is
  reproducible, not arbitrary. Truncation is **not** an error — the dropped
  items simply render no context, which is AC-9's honest state at row grain.
- `ordered_qty_base` / `counted_qty_base` are emitted in **BASE units,
  unconverted** (design guidance 4). **No `case_qty` arithmetic in SQL.**

### 2.5 Envelope assembly

`jsonb_agg` per vendor over `items_ranked`, then one outer object. Vendors with
no anchor never appear in `anchors`, so they never appear in `vendors[]` (R-D).

---

## §3 — API contract

### 3.1 PostgREST vs RPC

**RPC.** Not a table/view read: four candidate sources, a tier precedence, a
`distinct on`, a jsonb-array unnest, and a per-vendor cap. A PostgREST view
would either need a `security_invoker` view with the same body (same object,
worse ergonomics, no parameter binding for `p_vendor_ids`/`p_as_of_date`) or
N+1 client round trips, which AC-23 forbids. **No edge function** — no secret,
no upstream, no HTML (AC-24, and the PM already ruled).

### 3.2 Response

```jsonc
{
  "as_of_date": "2026-08-03",
  "vendors": [
    {
      "vendor_id":       "…uuid…",
      "last_order_date": "2026-07-29",              // never null (R-D)
      "confidence":      "placed",                  // "placed" | "recorded"
      "source":          "purchase_order",          // "purchase_order" | "order_approval"
      "source_id":       "…uuid…",                  // the PO / approval row id
      "counted_date":    "2026-07-29",              // null ⇒ AC-7 for every row
      "items_truncated": false,                     // AC-22
      "items": [
        { "item_id": "…", "ordered_qty_base": 78,   "counted_qty_base": 30   },
        { "item_id": "…", "ordered_qty_base": 12,   "counted_qty_base": null },  // AC-7
        { "item_id": "…", "ordered_qty_base": null, "counted_qty_base": 4    }   // AC-8
      ]
    }
  ]
}
```

`source_id` is additive beyond AC-19's sketch and is **not rendered** — it
exists so a support question ("which order is this line quoting?") is answerable
from a network trace without re-running the precedence by hand. Cheap, and it
makes the pgTAP precedence assertions read as `is(… source_id, po_b_id)` rather
than as indirect inferences.

### 3.3 Errors

| Case | SQLSTATE | HTTP | Message |
|---|---|---|---|
| Caller cannot see the store | `42501` | 403 | `not authorized for this store` |
| `> 100` vendor ids | `22023` | 400 | `invalid vendor list: expected 0..100 vendor ids, got %` |
| `p_store_id` null | `22023` | 400 | `invalid request: store id is required` |
| Empty / null vendor list | — | 200 | `{ "as_of_date": …, "vendors": [] }` |
| No anchor for any vendor | — | 200 | `{ "as_of_date": …, "vendors": [] }` |

Message strings are **stable contract** — pgTAP asserts on SQLSTATE, jest
asserts on nothing (the FE never surfaces these; AC-17).

---

## §4 — RLS impact

**No new table. No new policy. No policy modified. No allowlist row added.**

- Every read rides an existing SELECT policy (§0.2 table). The function is
  `security invoker`, so those policies apply unchanged.
- The spec-053 `permissive_policy_lint` pgTAP probe
  ([supabase/tests/permissive_policy_lint.test.sql](supabase/tests/permissive_policy_lint.test.sql))
  must stay green **with no new VALUES row**. If a developer finds themselves
  wanting to add one, they have gone off-design — stop and escalate (AC-21).
- **Permissive-OR audit (CLAUDE.md rule):** N/A — zero policies are created, so
  there is no new permissive predicate to OR against an existing one.
- The only privilege statements in the migration are the function's own
  `revoke … from public, anon` / `grant execute … to authenticated`, matching
  `create_order_approval` and the reorder engines. Do **not** revoke from
  `authenticated` on any table — that would trip the spec-097 grant lint.

---

## §5 — `src/lib/db.ts` surface + the pure formatter

### 5.1 Types — `src/types/index.ts`, beside `ReorderPayload`

```ts
export type LastOrderConfidence = 'placed' | 'recorded';
export type LastOrderSource     = 'purchase_order' | 'order_approval';

export interface LastOrderContextItem {
  itemId: string;
  orderedQtyBase: number | null;   // null ⇒ AC-8 (not on that order)
  countedQtyBase: number | null;   // null ⇒ AC-7 (no matching count entry)
}

export interface LastOrderContextVendor {
  vendorId: string;
  lastOrderDate: string;                       // YYYY-MM-DD, never ''
  confidence: LastOrderConfidence;
  source: LastOrderSource;
  sourceId: string;
  countedDate: string | null;
  itemsTruncated: boolean;
  items: Record<string, LastOrderContextItem>; // keyed by itemId
}

/** Keyed by vendorId. `null` at the slice level means NOT LOADED (R-G). */
export type LastOrderContext = Record<string, LastOrderContextVendor>;
```

Both maps are `Record`, not arrays — the render loop does `ctx.items[itemId]`
per row. Same rationale and same precedent as
`fetchReorderForCountedOnHand`'s `Record<itemId, CountedReorderItem>`
([src/lib/db.ts:4594](src/lib/db.ts)): avoids an O(lines × items) scan inside
`VendorOrderCard`.

Types live in `src/types/index.ts` (not `db.ts`) because the pure util in §5.2
needs them and **must not import `db.ts`** — importing the supabase client into
a `src/utils` module would break its jest purity.

### 5.2 Fetcher — `src/lib/db.ts`, immediately after `mapCountedReorderItem`

```ts
export async function fetchLastOrderContext(
  storeId: string,
  vendorIds: string[],
  asOfDate?: string,
): Promise<LastOrderContext>;
```

- Wrapped in `useInflight.getState().track(async (signal) => …, { kind: 'read', label: 'fetchLastOrderContext' })` with `.abortSignal(signal)` — byte-mirroring `fetchReorderSuggestions` ([src/lib/db.ts:4464](src/lib/db.ts)).
- `supabase.rpc('report_last_order_context', { p_store_id, p_vendor_ids, p_as_of_date })`. Array param precedent: `copyCatalogRows` → `copy_catalog_rows(…, uuid[])` ([src/lib/db.ts:4901](src/lib/db.ts)).
- `if (error) throw error;` — **do not swallow.** The caller decides (and the caller, per AC-17, swallows to a silent no-context state). Same posture as `fetchReorderSuggestions` / `fetchReorderForCountedOnHand`.
- Private `mapLastOrderVendor(v: any): LastOrderContextVendor` doing snake→camel, in the same shape as `mapReorderVendor` / `mapCountedReorderItem`:

  | wire | mapped |
  |---|---|
  | `vendor_id` | `vendorId` |
  | `last_order_date` | `lastOrderDate` |
  | `confidence` | `confidence` (narrow: `=== 'recorded' ? 'recorded' : 'placed'`) |
  | `source` | `source` (narrow: `=== 'order_approval' ? … : 'purchase_order'`) |
  | `source_id` | `sourceId` |
  | `counted_date` | `countedDate` (`null` when falsy) |
  | `items_truncated` | `itemsTruncated` (`Boolean(…)`) |
  | `items[].item_id` | `items[itemId].itemId` |
  | `items[].ordered_qty_base` | `orderedQtyBase` — **`== null ? null : Number(…)`** |
  | `items[].counted_qty_base` | `countedQtyBase` — **same** |

  **The `?? 0` coercion used everywhere else in this file is FORBIDDEN on the
  two quantity fields.** `null` and `0` are semantically different here
  (`null` = "not on that order" / "no count entry"; `0` = "ordered zero"), and
  collapsing them would silently violate AC-7/AC-8. Call it out in a comment;
  a reviewer seeing `?? 0` there treats it as a Critical.
- **AC-22 client complement:** if `vendorIds.length > 100`, take the first 100
  in the order given (the payload is already sorted by next delivery date) and
  `console.warn` once. One call, never a chunked fan-out (AC-23); the excess
  vendors render AC-9's empty state, which is honest. The server bound stays
  the hard gate.
- **No `notifyBackendError` here.** `db.ts` never toasts.
- **No new `supabase.from/rpc` call site outside `db.ts`.** The CLAUDE.md
  carve-out list is not extended (AC-24).

### 5.3 Pure formatter — `src/utils/lastOrderContext.ts` (NEW)

Peer to `poCaseDisplay.ts` / `reorderExport.ts`. **Zero** React, supabase,
theme, or i18n imports. Only `isCaseRow` / `poOrderedToCases` from
`./poCaseDisplay` and types from `../types` (AC-4: no new conversion helper).

```ts
export type LastOrderQty = { value: number; unitLabel: string };

export type LastOrderLine =
  | { kind: 'none' }
  | {
      kind: 'line';
      dateIso: string;                 // the anchor's YYYY-MM-DD; the tier formats it
      counted: LastOrderQty | null;    // null ⇒ omit the COUNTED clause (AC-7)
      ordered: LastOrderQty | null;    // null ⇒ NOT ORDERED (AC-8)
      notConfirmed: boolean;           // AC-3, confidence === 'recorded'
      delta:
        | { direction: 'up' | 'down' | 'same'; value: number; unitLabel: string }
        | null;                        // null ⇒ suppressed (AC-12 / R-F)
    };

export function buildLastOrderContext(args: {
  item: Pick<ReorderItem, 'itemId' | 'caseQty' | 'unit' | 'onHand' | 'flags'>;
  vendorContext: LastOrderContextVendor | null;
  onHandSource: OnHandSource;
}): LastOrderLine;

export type LastOrderCardState = 'hidden' | 'empty' | 'present';

/** R-G tri-state. `context === null` (not loaded / failed) ⇒ 'hidden'. */
export function lastOrderCardState(
  context: LastOrderContext | null,
  vendorId: string,
): LastOrderCardState;
```

Behavior, exhaustively (this list is the jest test plan for AC-27):

1. `vendorContext == null` ⇒ `{ kind: 'none' }`.
2. Unit rendering (AC-4, R-H): `isCaseRow(caseQty)` ⇒ `value = poOrderedToCases(base, caseQty)`, `unitLabel = 'CS'`; else `value = base`, `unitLabel = item.unit`. **Exact, not rounded** — a historical `85/6` renders `14.17`, matching `poOrderedDisplay`'s honesty rule. The tier formats with `formatQty`.
3. `entry = vendorContext.items[itemId]`. Absent ⇒ `counted: null, ordered: null` (R-I's fourth variant). Present ⇒ each side null-preserved.
4. `notConfirmed = vendorContext.confidence === 'recorded'` (AC-3).
5. **Delta (AC-11 / AC-12 / R-F).** `null` unless ALL of: `onHandSource === 'eod'`; `!item.flags.includes('eod_missing_for_item')`; `entry?.countedQtyBase != null`. Otherwise `deltaBase = item.onHand - countedQtyBase`, converted to display units by the same rule as (2); `direction = 'same'` when `Math.abs(displayDelta) < 0.005` (below `formatQty`'s 2-dp resolution), else `'up'` / `'down'`; `value = Math.abs(displayDelta)`.
6. **Never** read `suggestedQty`, `suggestedUnits`, `suggestedCases`, `parLevel`, `parReplacement`, `usageForecasted`, `pendingPoQty`, `estimatedCost`, `costPerUnit`, or any `reorderEdits` entry. AC-10 / AC-5. The `Pick<>` on the argument type enforces this **at the type level** — the function literally cannot see those fields. That is deliberate; do not widen it to `ReorderItem`.

### 5.4 Store slice — `src/store/useStore.ts`

```ts
lastOrderContext: null as LastOrderContext | null,      // R-G: null = not loaded
loadLastOrderContext: (vendorIds: string[], asOfDate?: string) => Promise<void>;
```

- Sits beside `reorderPayload` / `reorderLoading` / `reorderError` (`useStore.ts:943-945`).
- **Reset to `null`** in the store-switch reset block (`useStore.ts:1559-1561`, next to `reorderPayload: null`). Stale cross-store context would be a correctness bug, not a cosmetic one — this line is load-bearing.
- Action body: `const storeId = get().currentStore?.id; if (!storeId || !vendorIds.length) { set({ lastOrderContext: {} }); return; }` then `try { set({ lastOrderContext: await db.fetchLastOrderContext(storeId, vendorIds, asOfDate) }) } catch (e) { console.warn('[Supabase] loadLastOrderContext:', …); set({ lastOrderContext: null }); }`.
- **The optimistic-then-revert + `notifyBackendError` pattern does NOT apply.** This is a pure read with no write to revert, and AC-17 explicitly forbids a toast. Precedent for a deliberately silent read: `loadLatestRun` (`useStore.ts:3794`) and `loadReorderSuggestions` (`useStore.ts:3812`, which routes to an in-section pane rather than a toast). Failure ⇒ `null` ⇒ `'hidden'` ⇒ the screen renders exactly as it does today.
- **`loadReorderSuggestions` is NOT modified.** No chaining inside it. See §7.
- No new loading flag. A boolean the UI never reads is dead state; `null` already means "nothing to render".

---

## §6 — i18n (AC-25 / AC-26)

All keys under `section.reorder.*` in **all three** of
[src/i18n/en.json](src/i18n/en.json), `es.json`, `zh-CN.json`. The parity test
stays green.

| Key | en (working copy) | Notes |
|---|---|---|
| `lastOrderFull` | `LAST {date} · COUNTED {counted} · ORDERED {ordered}` | AC-1 |
| `lastOrderNoCounted` | `LAST {date} · ORDERED {ordered}` | AC-7 |
| `lastOrderNotOrdered` | `LAST {date} · COUNTED {counted} · NOT ORDERED` | AC-8 |
| `lastOrderNotOrderedNoCounted` | `LAST {date} · NOT ORDERED` | **R-I** — beyond the AC-25 working set |
| `lastOrderNotConfirmed` | `NOT CONFIRMED` | AC-3, rendered as a **sibling** `<Text>` |
| `lastOrderNone` | `NO PRIOR ORDER ON RECORD` | AC-9, card level |
| `lastOrderDeltaUp` | `▲ +{qty}` | AC-11 |
| `lastOrderDeltaDown` | `▼ −{qty}` | AC-11 (U+2212 minus, not hyphen) |
| `lastOrderDeltaSame` | `SAME AS LAST COUNT` | AC-11 |

**AC-26 compliance.** Each sentence variant is ONE template with all its
placeholders — never `T(a) + ' · ' + T(b)`. `{counted}` / `{ordered}` / `{qty}`
are interpolated as `` `${formatQty(v.value)} ${v.unitLabel}` `` — a number plus
a unit token (`CS`, `lb`), neither of which is translated prose, so this is not
fragment-joining. `NOT CONFIRMED` and the delta marker are **separate `<Text>`
elements** with their own styling, not string-concatenated into the sentence —
which is what makes AC-3's "without changing the numbers' tone" achievable and
keeps `es` / `zh-CN` word order intact.

The four `lastOrder*` sentence keys drop the three others' vocabulary — the
translator sees complete sentences.

---

## §7 — Frontend wiring

### 7.1 The fetch trigger — ONE place: `ReorderSection.tsx`

A new `React.useEffect` placed **with the other hooks, ABOVE the `isPhone`
guard** (`ReorderSection.tsx:1470`) — the guard-after-hooks discipline
AC-REG-3 freezes.

```
const vendorIdsKey = useMemo(
  () => (reorderPayload?.vendors ?? []).map(v => v.vendorId).sort().join(','),
  [reorderPayload?.vendors],
);
useEffect(() => {
  if (!currentStore?.id || currentStore.id === '__all__') return;
  if (!vendorIdsKey) { /* nothing to annotate */ return; }
  void loadLastOrderContext(vendorIdsKey.split(','), reorderPayload?.asOfDate?.slice(0,10));
}, [currentStore?.id, vendorIdsKey, reorderPayload?.asOfDate, loadLastOrderContext]);
```

Why this is the only insertion point:

- `ReorderSection`'s hooks run before the phone fork, so `PhoneOrdering` **and**
  `PhoneApproveOrder` are both hydrated by it — the same arrangement that
  already hydrates `reorderPayload` for them
  (`ReorderSection.tsx:1460-1477`). **One RPC call covers every visible vendor
  on every one of the three surfaces** (AC-23).
- `PhoneApproveOrder` re-runs `loadReorderSuggestions(businessDate)` for its own
  business date (`PhoneApproveOrder.tsx:137-142`); that changes
  `reorderPayload.asOfDate`, the effect re-fires, and the approve screen gets
  its context. **`PhoneApproveOrder.tsx` needs no edit at all** — which is how
  AC-REG-4 is satisfied structurally rather than by inspection.
- Depending on the **derived string key** (not the `vendors` array identity)
  is load-bearing: a 400 ms-debounced realtime reload produces a fresh array
  with identical ids, and an identity dep would refetch on every replay. With
  the string key it does not. Staleness cost is nil — the anchor is strictly
  before the as-of date, so nothing that happens today can change it.
- **Do not chain the fetch inside `loadReorderSuggestions`.** Keeping it in a
  separate effect is what makes AC-17's independent failure real rather than
  asserted, and it leaves the shipped loader byte-unchanged.

### 7.2 Phone — `VendorOrderCard` in `PhoneOrdering.tsx` (AC-14)

One insertion, inside the **exported** `VendorOrderCard`
(`PhoneOrdering.tsx:146`), which `PhoneApproveOrder.tsx:406` already consumes.
**Forking it is a review finding** (design guidance 3).

- Subscribe in-component: `const lastOrderContext = useStore((s) => s.lastOrderContext);` — precedented (the component already subscribes to `setReorderEditQty`, `fillCartForVendor`, `vendors`). **No new prop**, so `PhoneApproveOrder` is untouched.
- `cardState = lastOrderCardState(lastOrderContext, vendor.vendorId)`.
  - `'hidden'` ⇒ render nothing anywhere (AC-17).
  - `'empty'` ⇒ ONE card-level muted line, `testID={\`phone-order-last-order-none-${vendor.vendorId}\`}`, placed with the existing header sub-lines (below the `phoneCardStats` line, `PhoneOrdering.tsx:285-293`), `mono(400) / 10.5 / C.fg3`. **Not** repeated per row (AC-9).
  - `'present'` ⇒ per-line sub-line.
- Per-line placement: inside the existing `<View style={{ flex: 1, minWidth: 0 }}>` (`PhoneOrdering.tsx:377-384`), directly **below** the `sub` caption, `testID={\`phone-order-last-order-${item.itemId}\`}`. Style mirrors `sub`: `mono(400) / 10.5 / C.fg3 / numberOfLines={1}` — AC-16 (flex:1, no horizontal scroll, non-interactive, tokens only, no new tappable target).
- `NOT CONFIRMED` and the delta marker render as sibling `<Text>` at `C.fg3` — **never** `C.danger` / `C.ok` / `C.warn` (AC-13).

### 7.3 Desktop — `ReorderSection.tsx` `VendorCard` (AC-15)

- `'present'` ⇒ a new `<View style={{ paddingLeft: 2 }}>` directly **below** `<BreakdownLine>` (`ReorderSection.tsx:813-815`) and **above** the inline ORDER `TextInput` block, `testID={\`reorder-last-order-${item.itemId}\`}`. Tone/size copied from the spec-102 "also available from …" advisory line (`ReorderSection.tsx:857-868`): `mono(400) / 10.5 / C.fg3`. Not italic — italic there marks an *advisory*; this is a *fact*.
- `'empty'` ⇒ one line in the card footer strip (`ReorderSection.tsx:885-895`), beside the existing `eod counted:` caption, `testID={\`reorder-last-order-none-${vendor.vendorId}\`}`.
- `'hidden'` ⇒ nothing.
- `VendorCard` subscribes to `lastOrderContext` the same way (it is a component; it already calls hooks).
- Desktop copy goes through `T()` like the rest of the new strings (AC-25), even though neighbouring lines in this section are English-literal.

### 7.4 What must NOT change

`applyReorderEdits`, `setReorderEditQty`, `narrowReorderToVendor`,
`poCaseDisplay`, `partitionReorderVendors`, `splitReorderVendorsByNeed`,
`computeReorderKpis`, the CSV/PDF/quick-order builders, `fillCartForVendor`,
`approveOrderState`, `disclosureKeyForChannel`, `mapReorderVendor`,
`fetchReorderSuggestions`, `loadReorderSuggestions`, and every
`src/screens/staff/` file. AC-REG-1/2/4/5/6.

---

## §8 — Realtime impact

**None. No publication change. No restart ritual.**

- No table is added to or removed from `supabase_realtime`. `order_approvals`
  stays unpublished per spec 149 R-5. **Therefore
  `docker restart supabase_realtime_imr-inventory` after `npm run dev:db` is
  NOT required** by this spec (AC-REG-7). Stated explicitly so nobody performs
  a ritual that is not needed — and so that if a later revision *does* touch
  publication membership, the project MEMORY `project_realtime_publication_gotcha`
  step becomes a mandatory, called-out deploy/dev step rather than a surprise.
- Replay path that already exists: `purchase_orders` **is** published
  ([20260514140000_realtime_publication_tighten.sql](supabase/migrations/20260514140000_realtime_publication_tighten.sql)),
  so a PO write on another device fires the `store-{id}` channel and
  `useRealtimeSync`'s 400 ms-debounced reload re-runs `loadReorderSuggestions`.
  Per §7.1 the context effect does **not** re-fire on that replay (the derived
  key is unchanged) — deliberate, and harmless, because the anchor is strictly
  before the as-of date.
- The `brand-{id}` channel is not involved (nothing here is brand-scoped).
- An approval made on a second admin device is not replayed at all (unpublished
  by design); the context updates on the next store/date change. Acceptable for
  a historical annotation — design guidance 8.

---

## §9 — Risks and tradeoffs

- **R-1 — Migration ordering.** `20260803000000` sorts after `20260801000200`.
  It has one hard dependency: `public.order_approvals` must exist (spec 149,
  `20260801000100`). Already on `main` and applied to prod. No ordering hazard.
  The `db-migrations-applied` gate goes red between commit and MCP apply —
  expected; flag, do not "fix".

- **R-2 — Tier dominates recency (AC-2 as written).** A `sent` PO from six
  weeks ago outranks a `draft` PO from yesterday, so the owner may see
  `LAST JUN 18` when a cart was filled last Wednesday. This IS what AC-2
  specifies and it is pinned by pgTAP, but it is a real product judgment the
  owner has not seen rendered yet. **The alternative is a one-line change** —
  `order by vendor_id, anchor_date desc, tier asc, created_at desc` (recency
  first, tier as the tie-break). Surface this at owner review; do not change it
  unilaterally.

- **R-3 — `reference_date` NULL on legacy POs.** Coalesced to
  `created_at::date` (§2.2). For the six legacy prod rows (all normalized to
  `sent` by spec 107) the created-at date is a reasonable proxy for the business
  date, but it is a proxy. The date is always rendered, so a wrong-looking date
  is visible rather than silent. pgTAP pins a NULL-`reference_date` row
  anchoring on its created-at date.

- **R-4 — OQ-2 case-size drift, accepted.** PM default taken: render with the
  **current** `item.caseQty`. Beyond the PM's rationale, there is a decisive
  structural reason not to take the "more honest" alternative: `po_items` has
  **no** `case_qty` column, so the per-era rendering is only available for
  approval-sourced anchors. Taking it would make the same visual line switch
  conversion basis depending on which tier won — strictly more confusing than a
  uniform current-`caseQty` basis. Pinned by a jest test that **documents** the
  drift (`caseQty` 6 → 12 between anchor and today) rather than hiding it.

- **R-5 — Non-privileged callers see a different anchor.** Under invoker
  (R-B), a store member without `auth_is_privileged()` never sees tiers 2/3, so
  their anchor may be an older PO — or absent. Two users can honestly see
  different "last orders". This is the shipped spec-149 RLS, not new behavior,
  and every rendered figure is still true for that reader. pgTAP pins it
  (AC-28). If the owner ever wants uniform context for all store members, that
  is a change to `privileged_store_read_order_approvals`, not a `security
  definer` workaround here (spec 149 §10.6 makes the same point).

- **R-6 — `actual_remaining` basis.** The counted figure is
  `eod_entries.actual_remaining`, the **client-computed total** in counted
  units — `staff_submit_eod` stores what it receives and never recomputes it
  from the `_cases` / `_each` splits
  ([20260630000200:174-184](supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql)).
  Design guidance 4 is right that this keeps counted and ordered on one basis,
  but it inherits any client-side error in that total. pgTAP pins a cases+each
  submission rendering the expected counted figure so the basis assumption is
  a tested claim, not a comment.

- **R-7 — Performance on the 286 KB seed.** Anchor scan touches at most
  `100 × 2` candidate sets, each store-scoped and index-backed. Line fetch is
  ≤ 100 POs' worth of `po_items` (indexed) or ≤ 100 jsonb arrays of ≤ 200
  elements each (`create_order_approval` caps `lines` at 200). Counted fetch is
  ≤ 100 submissions' entries — the one seq-scan risk, closed by
  `idx_eod_entries_submission_id` (§1.2). Expect single-digit ms on the seed;
  the dev pastes the `explain analyze` into the PR.

- **R-8 — The `> 500` items cap could hide a row the user is looking at.**
  Ordered descending by `ordered_qty_base`, so the biggest lines survive and
  the tail (small or count-only rows) degrades to AC-9's honest empty state.
  A vendor with > 500 distinct items on one order is not a shape this business
  has. `items_truncated` is returned so a future UI can say so if it ever
  happens.

- **R-9 — Edge-function cold start.** N/A. No edge function is added or
  modified (AC-24, AC-29). Stated so the absence is read as design.

- **R-10 — `null` vs `0` in the mapper.** The single most likely
  implementation bug in this spec is a reflexive `?? 0` on
  `ordered_qty_base` / `counted_qty_base`, which silently converts AC-8's
  "NOT ORDERED" into "ORDERED 0" and AC-7's omission into "COUNTED 0". Called
  out in §5.2, in the mapper's own comment, and covered by a jest case.
  Reviewers: check this line first.

---

## §10 — Test map (AC-27 / AC-28 / AC-29)

### pgTAP — `supabase/tests/report_last_order_context.test.sql` (AC-28)

Rollback-framed, seeding its own store/vendor/items/POs/approvals/submissions.

1. **Anchor precedence, tier by tier** — construct all four candidate kinds for one vendor and assert the winner's `source_id` as each higher tier is removed: tier 1 `sent` PO → tier 2 `ordered` approval → tier 3 `approved` approval → tier 4 `draft` PO. Four `is()` assertions; the AC-2 table walked row by row.
2. **Exclusions** — a `cancelled` PO and a `pending` approval, each as the *only* candidate ⇒ vendor **omitted** from `vendors[]` (also pins R-D).
3. **Tie-break** — two `sent` POs, different `reference_date` ⇒ later wins; same `reference_date`, different `created_at` ⇒ later wins.
4. **Strictly-before** — a `sent` PO dated exactly `p_as_of_date` is NOT an anchor.
5. **NULL `reference_date`** anchors on `created_at::date` (R-3).
6. **AC-6 counted resolution** — (a) approval with `source_submission_id` uses that submission even when a *different* same-date submission exists; (b) approval with NULL `source_submission_id` falls back to the `(store, vendor, business_date)` match (R-E); (c) a PO anchor uses `reference_date → eod_submissions.date`; (d) a `status <> 'submitted'` submission does **not** match ⇒ `counted_date` null.
7. **AC-7** — an item on the anchor order with no count entry ⇒ `counted_qty_base` is **JSON null** (assert `jsonb_typeof(... ) = 'null'`, not `= 0`).
8. **AC-8** — an item in the anchoring count but not on the anchor order ⇒ `ordered_qty_base` is **JSON null**.
9. **AC-20a** — a caller who cannot see the store gets `42501` (`throws_ok`), and gets it for a store that exists but is not theirs (not just a bogus uuid).
10. **AC-20b** — a store-linked, **non-privileged** caller: an `order_approvals`-only vendor is **omitted**; a PO-sourced vendor still resolves. Both in one test, both `set local role` / `request.jwt.claims` framed like [supabase/tests/order_approvals.test.sql](supabase/tests/order_approvals.test.sql).
11. **AC-22** — 101 vendor ids ⇒ `22023`; 100 ⇒ OK; `'{}'::uuid[]` and `null` ⇒ `vendors: []` with no exception.
12. **R-6** — a cases+each submission's `actual_remaining` surfaces as `counted_qty_base` unchanged.
13. **Multi-line same item** — two `po_items` rows for one item on the anchor PO ⇒ summed.
14. **AC-21** — reuse the existing [supabase/tests/permissive_policy_lint.test.sql](supabase/tests/permissive_policy_lint.test.sql) probe unchanged; assert here only that `pg_policies` count for the five source tables is unchanged by this migration. **No allowlist row.**
15. **Grants** — `has_function_privilege('authenticated', …, 'EXECUTE')` true, `anon` false (mirrors `reports_anon_revoke.test.sql`).

### jest

- **`src/utils/lastOrderContext.test.ts`** (new, co-located per the `poCaseDisplay.test.ts` convention) — the pure suite: all four AC-2 tiers as fixtures; `caseQty > 1` vs `<= 1` rendering (R-H: `78/6 → 13 CS`, `13/1 → 13 lb`); exact fractional (`85/6 → 14.1666…`); AC-7; AC-8; R-I's fourth variant; AC-9 via `lastOrderCardState`; R-G's `'hidden'` on `null`; delta up/down/same; AC-12 suppression on `onHandSource === 'stock'`; **R-F** suppression on `eod_missing_for_item`; AC-3 `notConfirmed`; **R-10** — `orderedQtyBase: 0` renders `ORDERED 0`, `null` renders `NOT ORDERED`, and the two are distinguishable; **R-4** — the documented case-drift case.
- **`src/lib/db.test.ts`** (or the existing db mapper suite) — `mapLastOrderVendor` null-preservation, the `> 100` truncation warn, the `Record` keying.
- **`src/screens/cmd/sections/phone/__tests__/PhoneOrdering.test.tsx`** — the line renders in `VendorOrderCard`; **and the same assertion via `PhoneApproveOrder`**, proving AC-14's single insertion point actually covers both.
- **`ReorderSection`** component test — desktop line renders below `BreakdownLine`; card-level empty line renders once, not per row.
- **`PhoneOrdering.acReg.test.tsx` / `PhoneApproveOrder.acReg.test.tsx`** — existing suites stay green; ONE new `acReg` case per AC-REG-3 pinning that the context line appears on the correct tier's tree (phone tree at < 768 px, desktop tree at ≥ 1100 px) and that the `isPhone` guard is still after all hooks.
- **AC-17** — mock `db.fetchLastOrderContext` to reject; assert the order list still renders every line, `Toast.show` was not called, and no context/empty node is in the tree (R-G).
- **i18n parity** — the existing parity test covers the nine new keys once they land in all three catalogs.
- **`npm run typecheck:test`** — a CI gate jest alone misses (project MEMORY `project_phone_tier_state`). Run it.

### Shell smoke — **explicitly N/A** (AC-29)

No edge function is added or modified. Do not invent one; its absence is not a
gap.

---

## §11 — Split of work

**backend-developer**
- `supabase/migrations/20260803000000_report_last_order_context.sql` (§1, §2).
- `supabase/tests/report_last_order_context.test.sql` (§10).
- `src/lib/db.ts`: `fetchLastOrderContext` + `mapLastOrderVendor` (§5.2).
- `src/types/index.ts`: the four new types (§5.1).
- Local verification: `npm run dev:db`, `scripts/test-db.sh`, and the
  `explain (analyze, buffers)` plan pasted into the PR body.
- **Prod apply is owner-gated.** Do not apply; hand the exact SQL + the
  `schema_migrations` insert to the user.

**frontend-developer**
- `src/utils/lastOrderContext.ts` + `src/utils/lastOrderContext.test.ts` (§5.3) — **write this first**; both tiers consume it (design guidance 2).
- `src/store/useStore.ts`: slice, action, store-switch reset (§5.4).
- `src/screens/cmd/sections/ReorderSection.tsx`: the fetch effect above the `isPhone` guard + the desktop line (§7.1, §7.3).
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: `VendorOrderCard` only (§7.2).
- `src/i18n/{en,es,zh-CN}.json`: the nine keys (§6).
- Component + acReg + AC-17 tests (§10).
- **`PhoneApproveOrder.tsx` should end up in the "files NOT changed" column.** If it needs an edit, the AC-14 single-insertion-point design was missed — stop and say so.

Shared boundary: `src/types/index.ts` (backend adds the types; frontend imports
them). Frontend can stub against the types before the migration lands.

---

## Files changed

Combined list — the backend pass (migration + pgTAP) and the frontend pass
(types, `db.ts` read, pure formatter, store slice, both tiers, i18n, jest).

### Frontend — new

- `src/utils/lastOrderContext.ts` — **NEW.** The pure formatter (§5.3): zero
  React / supabase / theme / i18n imports; only `isCaseRow` /
  `poOrderedToCases` from `./poCaseDisplay` and types. Exports
  `buildLastOrderContext` (discriminated `{ kind: 'none' } | { kind: 'line' }`),
  `lastOrderCardState` (R-G tri-state), `lastOrderSentence` +
  `lastOrderDeltaText` (i18n KEY + vars selection, shared so the two tiers
  cannot drift — see "Deviations" below), and `formatLastOrderDate`
  (`2026-07-29 → "JUL 29"`, parsed from the ISO parts so no UTC day shift).
  The `Pick<ReorderItem, …>` argument type makes AC-10 unreachable at the type
  level.
- `src/utils/lastOrderContext.test.ts` — **NEW**, 29 cases: the four AC-2 tiers
  → AC-3 qualifier; AC-4 case-vs-unit rendering read per R-H (`78/6 → 13 CS`,
  `13/1 → 13 lb`) plus the exact-fraction case; AC-7 / AC-8 / R-I's fourth
  variant; R-4's documented case-size drift; **R-10 (`0` vs `null` render
  differently and are distinguishable)**; delta up/down/same; AC-12 suppression
  on `'stock'`; **R-F suppression on `eod_missing_for_item`**; R-G's `'hidden'`;
  and an AC-10 pin that suggestion/par fields are ignored at runtime too.
- `src/lib/db.lastOrderContext.spec151.test.ts` — **NEW.** `mapLastOrderVendor`
  through its public caller with a stubbed client: the RPC name/params, the
  AC-22 >100 truncation (ONE call, never a chunked fan-out), error
  non-swallowing, `Record` keying, union narrowing, and **R-10 null
  preservation**.
- `src/store/useStore.lastOrderContext.spec151.test.ts` — **NEW.** The R-G
  tri-state, the empty-vendor-list `{}` short circuit, the `__all__` guard,
  **AC-17 (failure ⇒ `null`, `console.warn` only, `Toast.show` NOT called,
  `reorderPayload` / `reorderError` untouched)**, and the store-switch reset.
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.lastOrderContext.spec151.test.tsx`
  — **NEW.** Every rendering assertion runs TWICE via `describe.each`, once
  through `PhoneOrdering` and once through `PhoneApproveOrder`, which is the
  executable proof of AC-14's single insertion point (fork the card and the
  approve half goes red). Plus the AC-REG group (KPI strip / stepper / line
  cost / approve primary + disclosure unchanged with the context `null`) and
  the AC-16 non-interactive pin.
- `src/screens/cmd/sections/__tests__/ReorderSection.lastOrderContext.spec151.test.tsx`
  — **NEW.** The §7.1 effect (one call for all vendors, the derived-key
  no-refetch on a realtime replay, no call with nothing to annotate), the
  desktop row line + delta + AC-12 suppression, AC-9's single card-level line,
  R-G's hidden state, and AC-REG-2 (the ORDER input still seeds from
  `suggestedUnits`).

### Frontend — modified

- `src/types/index.ts` — added `LastOrderConfidence`, `LastOrderSource`,
  `LastOrderContextItem`, `LastOrderContextVendor`, `LastOrderContext` (§5.1)
  beside `ReorderPayload`, and the `lastOrderContext: LastOrderContext | null`
  field on `AppState` with the R-G tri-state documented. No existing type
  changed.
- `src/lib/db.ts` — added `fetchLastOrderContext` + the private
  `mapLastOrderVendor` (§5.2), immediately after `mapCountedReorderItem`.
  `useInflight.track({ kind: 'read', label: 'fetchLastOrderContext' })` +
  `.abortSignal(signal)`, errors re-thrown (not swallowed), the >100 client
  truncation, and an explicit comment banning `?? 0` on the two quantity
  fields (R-10). No existing function touched; no new
  `supabase.from/rpc` call site outside `db.ts`.
- `src/store/useStore.ts` — the `lastOrderContext` slice (initial `null`), the
  `loadLastOrderContext` action (silent on failure — no toast, no error slice,
  no loading flag), its `StoreActions` declaration, and the store-switch reset
  to `null` in `loadFromSupabase`. `loadReorderSuggestions` is byte-unchanged.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` — the ONE phone insertion
  point, inside the exported `VendorOrderCard` (§7.2): an in-component
  `lastOrderContext` subscription (no new prop, so `PhoneApproveOrder` needs no
  edit), the per-row line at `mono(400)/10.5/C.fg3` `numberOfLines={1}` under
  the `sub` caption, and AC-9's card-level line under `phoneCardStats`.
  `NOT CONFIRMED` and the delta are sibling `<Text>` at `C.fg3` (AC-13).
- `src/screens/cmd/sections/ReorderSection.tsx` — the §7.1 fetch effect placed
  with the other hooks ABOVE the `isPhone` guard (AC-REG-3), keyed on the
  derived vendor-id string; the desktop row line below `<BreakdownLine>` and
  above the ORDER input (§7.3); AC-9's card-level line in the ALWAYS-VISIBLE
  stats row beside `est cost:` (fix round — see below; it was originally in the
  collapse-gated footer). The items `.map()` gained a block body to compute the
  per-row context — no JSX inside it changed.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — the nine
  §6 keys under `section.reorder.*` in all three catalogs (parity test green).
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx` — ONE
  new AC-REG-3 case: the context line lands on the tier that is actually
  rendering (phone testID on the phone tree, desktop testID on the desktop
  tree, never both). Existing cases untouched.
- `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx`,
  `ReorderSectionCases.test.tsx`, `ReorderSection.spec123.test.tsx`,
  `ReorderSection.spec130.test.tsx`, `ReorderSection.spec135.test.tsx`,
  `ReorderSection.spec138.test.tsx`,
  `ReorderSection.resetAfterExport.spec138.test.tsx` — each of these suites
  mocks the store wholesale; added `lastOrderContext: null` +
  `loadLastOrderContext: jest.fn()` to the mocked state so the new effect can
  run. **No assertion in any of these suites changed** — the added state is
  `null`, so those trees render exactly as before (which is itself the AC-17
  regression evidence).

### Frontend — deliberately NOT changed

`src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` (AC-14 / §11 — the
single insertion point in `VendorOrderCard` covers it, and the §7.1 effect
above the phone fork hydrates it), `applyReorderEdits`, `setReorderEditQty`,
`narrowReorderToVendor`, `poCaseDisplay`, `partitionReorderVendors`,
`splitReorderVendorsByNeed`, `computeReorderKpis`, the CSV/PDF/quick-order
builders, `fillCartForVendor`, `approveOrderState`, `disclosureKeyForChannel`,
`mapReorderVendor`, `fetchReorderSuggestions`, `loadReorderSuggestions`,
`src/screens/staff/**`, `extension/**`, `app.json`.

### Frontend deviations from the design (both additive, neither re-opens a ruling)

1. **`lastOrderSentence` / `lastOrderDeltaText` in the pure module.** §5.3
   specifies only `buildLastOrderContext` + `lastOrderCardState`. Selecting
   which of the four AC-26 templates a result maps to is identical logic on
   both tiers, so it lives in the pure module and is unit-tested there; each
   tier still owns `T()`, `formatQty` (injected, so the module stays free of
   the reorderExport/papaparse chain) and every style token. The discriminated
   result the design mandates is unchanged.
2. **`formatLastOrderDate` in the pure module.** §5.3 says "the tier formats
   it". There was no existing shared short-date helper, and two hand-rolled
   copies would drift (and `new Date('2026-07-29')` shifts a day west of UTC),
   so one deterministic helper is shared. `LastOrderLine.dateIso` still carries
   the raw ISO date exactly as designed.

### Frontend verification

- `npx tsc --noEmit` clean; `npm run typecheck:test` clean;
  `npx jest` → **189 suites / 1923 tests green**.

---

## Fix round — frontend review findings (2026-08-03)

Addresses code-reviewer SF + nit, security-auditor Low, and backend-architect
M-1 / M-2. Backend findings (security-auditor Medium `cardinality()`, architect
SF-1 / SF-2 / SF-3) are **out of scope for this pass** — `supabase/**` was not
touched here; they run in the parallel backend fix round.

1. **Code-reviewer SF — desktop AC-9 line was behind the collapse guard.**
   `ReorderSection.tsx`: the card-level "NO PRIOR ORDER ON RECORD" line moved
   out of the footer strip (inside `{!collapsed ? … : null}`, and desktop cards
   default to collapsed) into the always-visible stats row beside
   `est cost:` — mirroring the phone tier's unconditional header placement and
   AC-9's "stated once, glanceable" rationale. Size normalized to the stats
   row's `11.5`; testID unchanged (`reorder-last-order-none-<vendorId>`). The
   footer keeps a pointer comment so the placement decision is legible there.
   Test updated: the AC-9 case now asserts **without** `expandAll()` and adds a
   structural pin that the line is inside `reorder-vendor-stats-*` (plus a
   second case that it stays a SINGLE line after expanding, and the R-G/AC-17
   case now checks the collapsed first paint too).
2. **Security-auditor Low — `logout()` did not clear `lastOrderContext`.**
   `useStore.ts` `logout()` now sets `lastOrderContext: null`, the same
   treatment `loadFromSupabase` gives it on a store switch, closing the
   shared-machine window where the next sign-in could reach the Ordering
   section before `loadFromSupabase` resolves. Pinned by a new case in
   `useStore.lastOrderContext.spec151.test.ts` (`../lib/webPush` newly mocked in
   that suite so `logout()`'s dynamic import resolves). **Not done:** the
   auditor's optional "clean up the whole reorder group in one pass"
   (`reorderPayload` / `orderSubmissions` are still not cleared on logout) —
   pre-existing, out of this spec's scope, surfaced as a follow-up.
3. **Architect M-2 — nothing pinned the module's hard-coded i18n keys.**
   `lastOrderContext.test.ts` gained a `describe` that harvests the key from
   the formatter at RUNTIME for all four sentence variants + all three delta
   variants (so a rename inside the module is caught too), adds the two keys
   the tiers reference directly (`lastOrderNotConfirmed`, `lastOrderNone`), and
   asserts all nine resolve to a non-empty string in **en, es and zh-CN** via a
   direct dot-path walk (deliberately not `t()`, which falls back to English and
   would hide a missing es/zh-CN key).
4. **Architect M-1 — the §7.1 "no refetch on realtime replay" comment was
   false.** Comment-only in `ReorderSection.tsx`: the derived-string-key dep is
   now documented for what it actually buys (a payload swap with identical ids
   does not refetch) with an explicit note that `loadFromSupabase` nulls
   `reorderPayload` alongside `lastOrderContext` on every debounced replay, so
   the key goes `'a,b' → '' → 'a,b'` and the effect DOES fire once per replay —
   correct behaviour under AC-17, and not to be "optimized" against the
   opposite claim. The corresponding test's title/comment were corrected to the
   narrower claim. No behaviour change.
5. **Code-reviewer nit — redundant Zustand selector.** The second
   `useStore((s) => s.reorderPayload?.vendors)` subscription is gone; the
   `vendorIdsKey` memo now reads `reorderPayload?.vendors` off the subscription
   already in scope.

### Fix-round verification

- `npx tsc --noEmit` clean; `npm run typecheck:test` clean;
  `npx jest` → **189 suites / 1929 tests green** (1923 + the 6 new/split cases).
- `npx expo export --platform web` builds clean (web bundle emitted).
- **Browser verification not performed:** no `preview_*` tooling was available
  in this session, so the desktop collapsed-first-paint claim is proven by the
  component test (real store, real i18n catalog, real desktop tree — the
  structural `reorder-vendor-stats-*` assertion) plus the successful web export,
  not by a screenshot. Flagging explicitly rather than claiming a visual pass.

### Fix-round files changed

- `src/screens/cmd/sections/ReorderSection.tsx`
- `src/screens/cmd/sections/__tests__/ReorderSection.lastOrderContext.spec151.test.tsx`
- `src/store/useStore.ts`
- `src/store/useStore.lastOrderContext.spec151.test.ts`
- `src/utils/lastOrderContext.test.ts`
- `specs/151-last-order-context.md`
- `npx expo export --platform web` → bundle builds clean (no import/bundling
  regression on the Vercel path).
- **End-to-end contract check against the LOCAL stack** (browser preview tools
  were not available in this session — stated plainly rather than claimed):
  seeded one `sent` PO (78 base) + its anchoring `submitted` EOD submission
  (30 base on the ordered item, 4 base on an item NOT on the order), called
  `report_last_order_context` over PostgREST as `admin@local.test`, and fed the
  RETURNED envelope through `mapLastOrderVendor`'s mapping rules +
  `buildLastOrderContext`:
  - `LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS` with `▲ +3 CS` (caseQty 6,
    on-hand 48) — the owner's example line, rendered from real RPC output;
  - `LAST JUL 29 · COUNTED 4 each · NOT ORDERED` with `▼ −2 each` for the item
    absent from the anchor order (AC-8 arriving as JSON `null`, not `0`);
  - the second vendor (no anchor) was **omitted** from `vendors[]` (R-D) and
    therefore renders AC-9's card-level line.
  The seeded rows were deleted afterwards; the local DB is back to 0 POs / 0
  EOD submissions.

### Migrations

- `supabase/migrations/20260803000000_report_last_order_context.sql` — **NEW.**
  Strictly additive, one `begin; … commit;`:
  1. `create or replace function public.report_last_order_context(uuid, uuid[], date) returns jsonb`
     — `language plpgsql`, **`security invoker`**, `set search_path = public`.
     Top gates in order: NULL `p_store_id` ⇒ `22023`; `auth_can_see_store(p_store_id)`
     ⇒ `42501 'not authorized for this store'` before any read; raw
     `cardinality(p_vendor_ids) > 100` ⇒ `22023` (checked BEFORE de-duplication;
     `cardinality`, not `array_length(…,1)` — see the fix round below);
     empty/NULL vendor list ⇒ `{ as_of_date, vendors: [] }`, not an error.
     **No top-level `auth_is_privileged()` gate (R-5/R-B)** — the
     `order_approvals` privilege conjunct stays a row filter under invoker.
     Body is §2 verbatim: `po_candidates` ∪ `oa_candidates` with an explicit
     `tier` integer → `distinct on (vendor_id) … order by vendor_id, tier asc,
     anchor_date desc, created_at desc` (R-C); `coalesce(reference_date,
     (created_at at time zone 'utc')::date)` legacy guard (R-3); `cancelled` /
     `pending` excluded in the `where`; strict `< v_as_of`; `counted_sub` with
     `direct` (source_submission_id) → `bydate` precedence (R-E); `item_union`
     as a UNION so `ordered_qty_base` / `counted_qty_base` stay JSON-null-preserving
     (AC-7/AC-8, never `0`); 500-item cap + `items_truncated`; BASE units only,
     no `case_qty` arithmetic in SQL.
  2. `comment on function …` (house convention).
  3. `revoke all … from public, anon;` + `grant execute … to authenticated;`
     (new function ⇒ grants must be emitted).
  4. `create index if not exists idx_eod_entries_submission_id on public.eod_entries (submission_id);`
     — §1.2's one justified index.

  No new table, no new column, no policy created or modified, **no
  `supabase_realtime` publication change ⇒ no
  `docker restart supabase_realtime_imr-inventory` step** (AC-REG-7).

### pgTAP tests

- `supabase/tests/report_last_order_context.test.sql` — **NEW.** 41 arms (32 at
  first landing + 9 from the backend fix round below),
  rollback-framed, seeding its own foreign brand/store, 21 vendors, 505 catalog
  ingredients + store items, 19 POs, 506 po_items, 10 approvals, 8 submissions and
  10 entries. Covers: the AC-2 precedence walked tier-by-tier on four isolated
  vendors (A1–A4, incl. R-2 "tier dominates recency"); cancelled/pending
  exclusion ⇒ vendor OMITTED (X1/X2, pinning R-D); both tie-breaks (T1/T2);
  the strict `<` window (T3); the NULL-`reference_date` anchor (T4, R-3);
  all four counted-resolution paths (F1–F4, incl. R-E); multi-line summing and
  AC-7/AC-8 asserted via `jsonb_typeof(...) = 'null'` (L1–L4); the R-6
  cases+each basis (Q1); `42501` for a foreign-brand store AND an unknown store
  (Z1/Z2); **R-5's non-privileged tier visibility — an approvals-only vendor is
  omitted while a PO-sourced vendor still resolves for the same caller
  (Z3/Z4)**; AC-22 bounds 101⇒`22023` / 100⇒ok / `'{}'`⇒`[]` / NULL⇒`[]`
  (B1–B4) plus the nested-array bypass (B5) and the real 501-item truncation
  (U1–U3); the counted fan-out and malformed-`lines[]` pins (D1/D2, G1/G2); the
  five source tables' named SELECT policies and their quals (P1a/P1b); grants
  authenticated/anon (P2/P3); the new index (P4); and `prosecdef = false`
  so a future flip to `security definer` fails this suite (P5).

### Not changed by the backend pass

`src/**` (the §5.1/§5.2 types + `fetchLastOrderContext` / `mapLastOrderVendor`
and the whole §5.3–§7 surface were delivered in the parallel frontend pass),
`report_reorder_list`, `report_reorder_for_counted_onhand`, every RLS policy,
`supabase/config.toml`, every edge function, `src/screens/staff/**`,
`app.json`.

### Verification (local only — NOT applied to prod)

- Migration applied to the local stack; version `20260803000000` inserted into
  the local `supabase_migrations.schema_migrations`. **Prod apply is
  owner-gated** via the MCP `execute_sql` path — `db-migrations-applied.yml`
  will be RED between commit and that apply, which is expected (R-1).
- `npm run test:db` → **80/80 files green** (the new file: 32/32).
- `npx jest` → 189 suites / 1923 tests green. `npx tsc --noEmit` and
  `npm run typecheck:test` → clean.
- `explain (analyze, buffers)` on the seed with the test fixtures loaded: every
  source-table access is an **index scan** —
  `idx_purchase_orders_store_reference_date`,
  `order_approvals_store_vendor_date_uidx`, `idx_po_items_po_id`,
  `eod_submissions_store_id_date_vendor_id_key` and the new
  `idx_eod_entries_submission_id`. No seq scan on any of the five source
  tables. Execution ≈ 12 ms, dominated by the per-row `auth_can_see_store()` /
  `auth_is_privileged()` RLS calls.

---

## Fix round — backend review findings (2026-08-03)

Addresses security-auditor **Medium** + both Lows, backend-architect **SF-1 /
SF-2 / SF-3**, and test-engineer **AC-22 PARTIAL**. Scope was `supabase/**`
only — **`src/**` was not touched in this pass** (the frontend fix round above
is a separate, already-landed change). Every fix is inside the still-unpushed
migration `20260803000000_report_last_order_context.sql` and its pgTAP suite;
no new migration file was added, so the prod-apply story is unchanged.

1. **Security-auditor Medium — the AC-22 vendor bound was bypassable with a
   multi-dimensional array.** `array_length(p_vendor_ids, 1)` reports the FIRST
   DIMENSION only, while the `unnest()` two lines later flattens every element,
   so a nested JSON array posted to the RPC (PostgREST coerces it to a 2-D
   `uuid[]`) passed a dim-1 length of 2 and carried 10 000+ ids through. Now
   `cardinality(p_vendor_ids)`, which counts elements across all dimensions —
   the auditor's one-word fix, verified at the SQL level
   (`array_length(array[[a,b],[c,d]], 1) = 2` vs `cardinality(...) = 4`). New
   arm **(B5)**: a nested `2 × 51` array is refused with `22023`, sitting
   directly beside (B1)/(B2) so the flat and nested forms are read together.
2. **Architect SF-3 — `counted_lines` fan-out.** `eod_entries` has no
   uniqueness on `(submission_id, item_id)` and both writers delete-then-insert
   from a client array, so one submission can legally hold two rows for one
   item; the un-deduped `left join counted_lines using (vendor_id, item_id)`
   then duplicated an `items[]` element, inflated `total_n` (so
   `items_truncated` could read `true` below 500 *distinct* items) and left the
   client mapper with a silent last-write-wins pick. `counted_lines` is now
   `distinct on (cs.vendor_id, e.item_id) … order by cs.vendor_id, e.item_id,
   e.created_at desc, e.id desc` — **not** `sum()`, per the architect: adding
   two counts for one item would invent a total the staff never entered, which
   AC-10 forbids. New arms **(D1)** exactly one `items[]` element from a
   duplicated fixture and **(D2)** its value is the last-written `9`, never the
   summed `12`. *(One deliberate addition beyond the architect's stated ORDER
   BY: `e.id desc` as a final tiebreak, so the pick stays deterministic when two
   rows share `created_at`. Behaviour-neutral where `created_at` differs.)*
   **Not done, per the architect's explicit instruction:** the unique index on
   `(submission_id, item_id)` and the matching hardening of the identical
   un-deduped shape in `report_reorder_list` — prod may already hold duplicate
   rows, so that needs a dedupe pass and a migration of its own. **Follow-up
   spec.**
3. **Architect SF-1 — the approval-branch `(l->>'item_id')::uuid` cast was
   unguarded.** Non-emptiness let `"item_id": "wings"` through the `WHERE` and
   into a `22P02` in the `SELECT`/`GROUP BY` — and because the RPC returns ONE
   envelope for the whole screen, a single malformed row failed the read for
   every vendor and every caller in that store. Added a uuid-shape regex
   (`~* '^[0-9a-f]{8}-…-[0-9a-f]{12}$'`) beside the existing non-empty and
   `jsonb_typeof(l->'qty_base') = 'number'` guards, so a malformed element is
   **skipped** (AC-9's honest state at row grain) rather than fatal. Reachable
   in prod: `order_approvals` has no CHECK on `lines[]` shape and
   `privileged_store_insert_order_approvals` permits a direct PostgREST INSERT
   that never sees `create_order_approval`'s validation. New arms **(G1)** the
   well-formed sibling line still resolves and **(G2)** the malformed element
   contributes no `items[]` row. The malformed vendor is deliberately part of
   the MAIN `_ctx` call, so a regression takes the whole file down rather than
   one arm — which is the actual blast radius.
4. **Architect SF-2 — the drifted spec-053 regex echo is gone.** The old (P1)
   re-implemented the trivially-wide detector in its **pre-arm-4 form** (missing
   the negative lookahead + anchor), so a legitimately AND-guarded OR-arm would
   have gone red inside *this* file for an unrelated spec's policy. Deleted, not
   repaired: `permissive_policy_lint.test.sql` already scans all of `public.*`,
   which covers these five tables, and a second copy is the CLAUDE.md
   "inline-not-shared is invisible drift surface" failure mode with no
   one-function-per-deploy justification. Replaced with the claim that is
   specific to this spec and stated nowhere else — **(P1a)** the five source
   tables carry exactly their expected NAMED `SELECT` policies
   (`store_member_read_purchase_orders`, `store_member_read_po_items`,
   `privileged_store_read_order_approvals`,
   `store_member_read_eod_submissions`, `store_member_read_eod_entries`) and
   **(P1b)** every one of those quals still routes through `auth_can_see_store`,
   with `order_approvals` still carrying its `auth_is_privileged` conjunct.
   Under `security invoker` those five policies **are** this function's entire
   authorization story, so a rename or a loosening now fails loudly here.
5. **Test-engineer AC-22 PARTIAL — the per-vendor 500-item cap was
   unexercised.** The only `items_truncated` coverage was a jest mapper test
   fed a hand-supplied boolean, which proves the snake→camel mapping and
   nothing about the backend. Added a generated fixture: 501 catalog rows +
   store items and a 501-line PO for one dedicated vendor, `ordered_qty = i` so
   the ranking is total and the cut unambiguous, read through its own
   `_ctx_trunc` call. New arms **(U1)** `jsonb_array_length(items) = 500` and
   `items_truncated = true`, **(U2)** the dropped element is the LOWEST
   `ordered_qty_base` (rank 501), **(U3)** rank 500 is retained — i.e. the cap
   keeps the top 500 by quantity and a truncated payload is reproducible.
6. **Security-auditor Low (index lock) — comment only.** The non-concurrent
   `create index` takes a `SHARE` lock on `eod_entries` (the fastest-growing
   table in the schema) for the build, blocking staff EOD writes. Added an
   explicit PROD-APPLY LOCK NOTE next to the statement: apply off-peak, or check
   the prod row count first and run that one statement as `create index
   concurrently` OUTSIDE the transaction. No code change — `concurrently`
   cannot run inside the `begin; … commit;` the local/CI path needs.
7. **Security-auditor Low (`logout()` does not clear `lastOrderContext`) — not
   in this pass.** Frontend scope; already handled in the frontend fix round
   above (item 2 there).

### Backend fix-round verification

- `npm run test:db` → **80/80 files green**; the new file **41/41** (32 → 41).
- `npx jest` → 189 suites / **1929 tests green** (unchanged by this pass —
  no `src/**` file was touched).
- `npx tsc --noEmit` clean; `npm run typecheck:test` clean.
- `permissive_policy_lint.test.sql` still 4/4 green with **zero diff** to that
  file and no allowlist row added (AC-21 unaffected by deleting the echo).
- The updated function was applied to the local stack and re-verified; the
  local `schema_migrations` row for `20260803000000` is unchanged. **Prod apply
  is still owner-gated** — `db-migrations-applied.yml` stays RED between commit
  and that apply, as designed (R-1).

### Backend fix-round files changed

**Migrations**

- `supabase/migrations/20260803000000_report_last_order_context.sql` —
  `cardinality()` bound, `distinct on` in `counted_lines`, the uuid-shape guard
  in the approval branch, and the index prod-apply lock note.

**pgTAP tests**

- `supabase/tests/report_last_order_context.test.sql` — `plan(41)`; new
  fixtures (3 vendors, 501 catalog rows + store items, 2 POs, 502 po_items,
  1 submission, 2 duplicate entries, 1 malformed approval); new arms B5, D1,
  D2, G1, G2, U1, U2, U3; (P1) replaced by (P1a)/(P1b).

**Spec**

- `specs/151-last-order-context.md` — this section, plus the two stale claims
  it invalidates (the `array_length` bound and the "32 arms" pgTAP summary).

**Deliberately NOT changed by this pass**

`src/**` (all of it — including the security-auditor's `logout()` Low, which is
frontend scope), `report_reorder_list` / `report_reorder_for_counted_onhand`,
`supabase/tests/permissive_policy_lint.test.sql`, every RLS policy,
`supabase/config.toml`, every edge function, `src/screens/staff/**`,
`extension/**`, `app.json`.
