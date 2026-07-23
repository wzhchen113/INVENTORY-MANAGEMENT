# Spec 138: Reorder as the single ordering surface — inline case editing, per-vendor cart-filler button, retire the PO & Receiving pages

Status: READY_FOR_REVIEW

> **Owner request (verbatim, right after spec 137 shipped):** "actually no need
> purchasing order page nor receiving page, since it can't connect to none API
> Vendors, just Ordering page or reorder is good, but with this that can edit the
> count like on purchasing order page. not need to have the button for 'CREATE
> PO' just with CSV PDF TEXT file are good enogh"
>
> **Q1 follow-up (verbatim):** "keep cart-filler, create a separate bottom for
> cart-filler function" — keep the BJ's/Sam's cart-filler working and give it its
> OWN BUTTON on the Reorder vendor card, replacing the generic "+ CREATE PO".

---

## PM summary (plain language, for the owner)

You order by phone, text, or the cart-filler — so the "purchase order → edit →
mark sent → receive" paperwork is busywork. This spec makes **Reorder the one
ordering screen**: you adjust each item's order quantity right on the card (in
cases, like the PO editor), then either export it (CSV / PDF / quick-order text)
or, for the BJ's/Sam's vendors, hit a dedicated **"Fill cart"** button that hands
the order straight to your extension. No more "purchase order" tab, no "CREATE
PO", no Receiving page.

Under the hood we keep one small thing invisible: the order record the cart-
filler already reads. Your "Fill cart" button quietly creates/updates that record
(no changes to the extension itself — it keeps working exactly as tuned on BJ's),
just re-branded from "CREATE PO" to the cart-filler handoff. You never see it.

**One thing you chose with eyes open (stated plainly):** with Receiving fully
gone, **your item costs will no longer follow delivery invoices automatically.**
Stock moves at your EOD / weekly counts, and when a vendor's price changes you
update the cost by hand in the catalog. The old "record what I actually paid on
delivery day" flow (spec 109) is retired.

---

## User story
As a store manager doing my evening ordering, I want ONE "Ordering" screen — the
reorder list — where I adjust each item's order quantity in cases and then either
export it (CSV / PDF / text) or, for my cart-filler vendors, push it straight to
the browser extension with one button, without ever creating or managing a
"purchase order" by hand or working a receiving screen, so that ordering matches
how I actually work.

## Acceptance criteria

### The Ordering surface
- [ ] **AC-1.** Selecting **"Ordering"** in the sidebar lands directly on the
      **reorder list** — no tab strip. The spec-137 Purchase-orders tab is
      removed; `OrderingSection` collapses to the reorder pane (plus the history
      affordance in AC-8).
- [ ] **AC-2.** The **admin Receiving section is removed from the sidebar**
      (the `Receiving` item in the OPERATIONS group, `cmdSelectors.ts:1102`).
- [ ] **AC-3.** The **staff app's Receiving tab**
      (`src/screens/staff/screens/Receiving.tsx` + its `StaffStack` entry) is
      removed from the staff UI — it is PO/receiving-driven and becomes
      purposeless once receiving is retired.
- [ ] **AC-4.** Sidebar-override fallback: a saved custom layout (spec-008)
      referencing the removed `PurchaseOrders` and/or `Receiving` ids resolves
      cleanly — no dead/dangling entry, no crash — extending the spec-137
      `remapLegacySidebarOverrideIds` remap (both remove-only; no target
      destination needed for `Receiving`).

### Inline case-quantity editing (the "edit like the PO page" ask)
- [ ] **AC-5.** Each reorder line's **order quantity is editable inline**, using
      the spec-134 case conventions: a line whose item comes more than one to a
      case (`caseQty > 1`) edits in **cases** with the `× N / case` sub-caption;
      a `caseQty <= 1` line edits in units. Reuse `src/utils/poCaseDisplay.ts`
      (`isCaseRow` / `poOrderedDisplay` / `poResolveEdit` / `poCasesToBase`) — no
      forked conversion logic.
- [ ] **AC-6.** The edited quantity is what flows into **every** order artifact
      for that vendor — CSV, PDF, quick-order text, and the cart-filler handoff.
      The on-screen `est cost` / KPI figures for the card reflect the edited
      quantities.
- [ ] **AC-7 (edit persistence).** A vendor's edited quantities **persist until
      that vendor's order is exported or sent to the cart-filler**; after an
      export / cart-fill for that vendor, the next reorder cycle starts fresh
      from the computed suggestions for that vendor. (Storage mechanism —
      draft-order lines vs. a per-vendor edit buffer — is the architect's call;
      see Design guidance.) An untouched line always shows the computed
      suggestion.

### History
- [ ] **AC-8.** A small **read-only past-orders history** is reachable from the
      Ordering surface (unobtrusive — e.g. a "History" link/panel, not a second
      sidebar item): a simple list of past orders showing at least **date,
      vendor, and order total**. Read-only — no edit, no receive, no re-open.

### Cart-filler button (Q1)
- [ ] **AC-9.** On a vendor with `vendors.extension_ordering = true`, the vendor
      card shows a **dedicated cart-filler button** (e.g. "Fill cart") in place
      of the removed "+ CREATE PO". Pressing it hands that vendor's current
      (edited) order to the browser extension.
- [ ] **AC-10.** The cart-filler button keeps the **existing extension RPC
      contract working unchanged**: `get_pending_extension_orders` /
      `get_extension_order_payload`
      (`supabase/migrations/20260723000000_extension_ordering.sql`) return the
      operator's order for extension-enabled vendors with **no signature or
      behavior change to those RPCs, and no change to the extension code** (specs
      131/132). The natural implementation is B1: the button creates/updates the
      hidden draft-order record those RPCs already read — see Design guidance.
- [ ] **AC-11.** On a vendor with `extension_ordering = false`, there is **no
      cart-filler button** — only the CSV / PDF / quick-order-text exports.
- [ ] **AC-12.** The **"+ CREATE PO" button and the "PO CREATED" chip are
      removed** from all reorder vendor cards (`vendorHasPo` / `hasPo` chip in
      `ReorderSection.tsx`).

### Exports (unchanged capability, fed edited qty)
- [ ] **AC-13.** Per-vendor **CSV, PDF, and quick-order text** exports remain
      available on every vendor card and reflect the edited quantities (AC-6).
      No behavior regression to the existing export builders (specs 088/115/123).

### Tests
- [ ] **AC-14 (jest).** Inline-edit → each export/handoff reflects the edited
      qty (case→base conversion via `poResolveEdit`); edit persistence + reset-
      after-export (AC-7); sidebar-override fallback for removed ids (AC-4);
      cart-filler button present only when `extension_ordering` (AC-9/AC-11).
- [ ] **AC-15 (pgTAP / shell smoke — only if the reorder RPC or an extension RPC
      changes).** If the architect resolves the inbound-term lifecycle by
      editing `report_reorder_list` (see Design guidance), pin the new behavior
      in pgTAP; if the cart-filler handoff touches any RPC contract, add a shell
      smoke round-trip. If the change is frontend-only (B1 reuses existing RPCs),
      this AC is N/A.

## In scope
- Collapsing "Ordering" to the reorder list only (remove the spec-137 PO tab).
- Removing the admin Receiving section and the staff Receiving tab from the UI.
- Inline per-line case/units order-quantity editing on reorder cards (reuse
  `poCaseDisplay.ts`), with edited qty flowing to all exports + the handoff.
- Edit persistence until export/cart-fill, then reset to suggestions (AC-7).
- A small read-only past-orders history (date / vendor / total).
- Replacing "+ CREATE PO" with a per-vendor cart-filler button on
  `extension_ordering` vendors; removing the "PO CREATED" chip.
- The invisible draft-order plumbing that keeps the extension RPCs working.
- Sidebar-override fallback for the removed ids.

## Out of scope (explicitly)
- **Changing the browser extension itself** (specs 131/132). It keeps reading the
  same two RPCs unchanged. Rationale: it was live-tuned on BJ's two days ago; the
  whole point of B1 is zero extension churn.
- **Rebuilding the extension to read the reorder list directly** (the rejected
  "B2"). Rationale: rewrites a just-tuned contract for no owner-visible gain.
- **Any delivery-price / cost-on-receipt tracking.** Spec 109 (cost-on-receipt)
  and spec 113 (staff price gate) go **dormant** with the receiving flow. Item
  costs no longer follow delivery invoices — owner chose this (see PM summary).
- **Dropping backend receiving records/RPCs.** This spec retires the **UI**;
  whether `receive_purchase_order`, `auto_receive_*`, cost-on-receipt columns,
  and the staff price-gate RPC are dropped vs. left dormant is the architect's
  call (owner asked for UI retirement, not a schema purge).
- **Changing the reorder math** (pars, run-rate, counted-on-hand from EOD) —
  except the inbound-term lifecycle decision forced by retiring receiving (see
  Design guidance; that is a required architect decision, not an expansion).
- **On-hand from EOD counts.** Untouched — remains the stock source of truth.
- **`app.json` slug / identity drift / repo-root spreadsheet** — untouched
  (CLAUDE.md DO-NOT-AUTO-FIX).

## Open questions resolved
- **Q1 — direction (CUSTOM owner answer).** → Keep the cart-filler working and
  give it its **own per-vendor button** on the reorder card, replacing "+ CREATE
  PO". PO/Receiving *screens* go away; on `extension_ordering` vendors the card
  shows a "Fill cart" button that hands the edited order to the extension. Non-
  extension vendors get CSV/PDF/TEXT only. Implementation = the PM's **B1**
  plumbing: the button creates/updates the hidden draft-order record the
  extension's existing RPCs already read (zero extension changes), re-branded as
  the cart-filler handoff. (PM's original B1 recommendation, adapted to a
  dedicated button — see Design guidance for the one contract risk to resolve.)
- **Q2 — deliveries.** → **No receiving at all.** Stock updates via EOD / weekly
  counts only; delivery prices tracked manually in the catalog. Retire the admin
  Receiving section AND the staff Receiving tab. Spec 109 cost-on-receipt + spec
  113 price gate go dormant. **Item costs no longer follow delivery invoices
  automatically — owner chose this with eyes open.**
- **Q3 — order history.** → A small **read-only** past-orders list (date, vendor,
  total), unobtrusive (AC-8).
- **Q4 — inline editing unit.** → **Cases**, per the spec-134 `poCaseDisplay`
  conventions (units when 1 unit = 1 case) (AC-5).
- **Q5 — edit memory.** → **Persist until exported / sent to cart-filler**, then
  the next cycle starts fresh from suggestions for that vendor (AC-7).
- **Q6 — staff Receiving tab.** → Removed (folded into Q2 — PO-driven, purposeless
  without receiving) (AC-3).

## Design guidance for the architect (not owner questions — do not reopen)

1. **Cart-filler handoff contract (Q1 = B1).** The recommended contract is:
   the "Fill cart" button calls the existing `createPoDraft` / `updatePoLineQty`
   path to materialize/update a **draft** `purchase_orders` row for that vendor
   from the edited reorder quantities, then the extension picks it up via the
   unchanged `get_pending_extension_orders` / `get_extension_order_payload`. No
   new RPC, no extension change. This is the lowest-risk reading of the owner's
   "own button" answer and preserves specs 131/132 byte-for-byte. If you see a
   materially cleaner contract, note it — but the owner's decision (keep the
   extension, own button) is fixed.

2. **Inbound-term lifecycle — REQUIRED decision (the real risk this spec
   creates).** The reorder RPC's `pending_po_qty` ("inbound / on the way")
   subtracts open POs in status `('sent','partial')`
   (`20260718000000_reorder_list_has_po.sql:244-251`). With receiving fully
   retired, a cart-filled order that the extension transitions `draft → 'sent'`
   (`markPurchaseOrderSent`) would enter `pending_po_qty` and **never clear** (no
   receive, and spec 125 auto-receive is being retired with the flow) — so it
   would suppress re-ordering that item **forever**. The architect MUST resolve
   this. Options, PM-ranked:
   - **(a) Drop the `pending_po_qty` inbound term from `report_reorder_list`**
     (simplest, honest given "no receiving"): reorder plans purely off counted
     on-hand vs par. Trade-off: two orders placed before the next count aren't
     netted against each other — acceptable for short order cycles + frequent
     counts, and matches the "no inbound record" world the owner chose.
   - **(b) Keep the spec-125 auto-receive cron** purely to clear sent orders on
     `expected_delivery` (stock-bump is self-correcting at the next EOD count;
     the cost path stays off). Keeps inbound honest without any receiving UI.
   - **(c) Leave cart-filled orders in `'draft'`** and stop the extension marking
     them `'sent'` — REJECTED: breaks the extension's tuned mark-sent /
     re-fill-idempotency behavior (out-of-scope extension churn).
   Recommend (a) unless the owner's order cadence makes double-counting likely,
   in which case (b). Whichever you pick, AC-15 pins it.

3. **History source (AC-8).** The draft/sent `purchase_orders` rows are a natural
   backing store for the read-only history (date = created/sent, vendor, total =
   Σ `ordered_qty × cost_per_unit`) — no new table needed. Confirm during design.

4. **Edit persistence storage (AC-7).** Persisting edits **as draft-PO lines**
   unifies AC-7 with AC-9/AC-10 (the same draft feeds the cart-filler) and AC-8
   (history) — a first edit materializes/updates the vendor's draft; export or
   cart-fill closes the cycle (mark sent/exported); next cycle a fresh
   suggestion set replaces it. A per-vendor client buffer is the lighter
   alternative but then needs a separate persistence path for cart-filler +
   history. PM leans draft-PO-lines; architect's call.

## Dependencies
- `src/screens/cmd/sections/OrderingSection.tsx` (spec 137) — collapse to
  reorder-only + host the history affordance.
- `src/screens/cmd/sections/ReorderSection.tsx` — inline case editing, cart-
  filler button, remove "+ CREATE PO" + "PO CREATED" chip, feed edited qty to
  CSV/PDF/quick-order exports (specs 088/115/123).
- `src/screens/cmd/sections/POsSection.tsx` — the case-aware inline editor UX to
  port; likely no longer mounted after the PO tab is removed.
- `src/utils/poCaseDisplay.ts` (spec 134) — reused for the inline edit.
- `src/screens/cmd/sections/ReceivingSection.tsx` — retired from the sidebar.
- `src/screens/staff/screens/Receiving.tsx` + `StaffStack` — retired from staff UI.
- `supabase/migrations/20260723000000_extension_ordering.sql` — the two extension
  RPCs kept unchanged (AC-10).
- `supabase/migrations/20260718000000_reorder_list_has_po.sql` — `pending_po_qty`
  inbound term + `has_po`; inbound-term lifecycle decision (Design guidance 2).
- `supabase/migrations/20260705000000_cost_on_receipt.sql` (spec 109),
  `20260707000000_staff_receiving_price_gate.sql` (spec 113),
  `20260719000000_auto_receive_due_purchase_orders.sql` (spec 125) — dormant/
  retired per Q2 + Design guidance 2.
- `src/lib/cmdSelectors.ts` + `src/lib/sidebarLayout.ts` — remove `PurchaseOrders`
  (already spec-137-merged) + `Receiving` sidebar items; extend the spec-008
  override remap for the removed ids (AC-4).
- `src/store/useStore.ts` — `createPoDraft`, `updatePoLineQty`,
  `loadReorderSuggestions`, `refreshPurchaseOrders`, `markPurchaseOrderSent`.

## Project-specific notes
- **Cmd UI section / legacy:** admin Cmd UI — `OrderingSection` / `ReorderSection`
  / `POsSection` / `ReceivingSection`. No legacy admin surface (spec 025).
- **Which app:** this repo (admin) **and** the staff surface (staff Receiving tab
  removal, AC-3). The cart-filler is a sibling browser extension (specs 131/132)
  — kept working, not modified. Customer PWA unaffected.
- **Per-store or admin-global:** per-store — reorder, POs, receiving all scope via
  `auth_can_see_store()`.
- **Edge function or PostgREST:** PostgREST/RPC. B1 reuses existing RPCs (no edge
  fn). Any inbound-term change edits `report_reorder_list` (SECURITY-INVOKER RPC).
- **Realtime channels touched:** none new expected (`store-{id}` / `brand-{id}`
  already carry `purchase_orders` / `po_items`). If a migration changes
  publication membership, apply the `docker restart supabase_realtime_imr-inventory`
  gotcha.
- **Migrations needed:** none for B1 UI/plumbing; **one** iff the architect edits
  `report_reorder_list` for the inbound-term decision (Design guidance 2). Any
  prod SQL applies via Supabase MCP + `schema_migrations` insert (project MEMORY).
- **Edge functions touched:** none.
- **Web/native scope:** admin Cmd shell (web-primary, native parity via the
  responsive shell) + staff app (Receiving tab removal). Per-vendor PDF export
  stays web-only (unchanged).
- **Tests (spec 022 tracks):** jest (AC-14); pgTAP + shell smoke only if a
  reorder/extension RPC changes (AC-15).
- **app.json slug:** untouched (load-bearing, do-not-auto-fix).

## Backend design

Authored by backend-architect. Reviewed the current reorder RPC
(`20260718000000_reorder_list_has_po.sql`), the two extension RPCs
(`20260723000000_extension_ordering.sql`), `poCaseDisplay.ts` (spec 134), the
reorder / PO store slice (`useStore.ts` §PO-loop), the PO db helpers in
`db.ts`, the sidebar wiring (`cmdSelectors.ts` / `sidebarLayout.ts` /
`InventoryDesktopLayout.tsx`), and the staff `StaffStack`. Latest migration on
disk is `20260725000000_po_items_cpu_precision.sql`.

### 0. Decisions at a glance (the two required calls)

- **Inbound-term lifecycle → PM option (a): drop the `pending_po_qty` inbound
  term.** One migration `CREATE OR REPLACE`s `report_reorder_list` so the
  `pending_po_qty` CTE yields zero rows; every `coalesce(ppq.pending_po_qty,0)`
  reads `0`, so `par_replacement` / `usage_forecasted` no longer subtract inbound
  and the emitted per-item `pending_po_qty` is always `0`. Envelope shape is
  byte-stable (the key stays, value 0). Rationale below (§2).
- **Cart-filler handoff → B1, client-buffer edits + materialize-on-fill.** Inline
  edits live in a client `reorderEdits` buffer (not draft-PO lines); the
  **Fill cart** button materializes/refreshes a single **draft** `purchase_orders`
  row for `(store, vendor, reorder date)` from the buffer-overridden quantities,
  which the unchanged extension RPCs pick up. Divergence from the PM's
  draft-PO-lines lean is deliberate and justified in §3.

### 1. Data model changes

**One migration. Additive-in-spirit / non-destructive.** No table, column, index,
policy, grant, or publication change. It `CREATE OR REPLACE`s **both** reorder
engines — `public.report_reorder_list(uuid, jsonb)` (admin) and
`public.report_reorder_for_counted_onhand(...)` (staff). See the "Architect
ruling" addendum at the end of this section — the original single-function wording
here was an oversight the backend developer correctly caught; §11 and the build
task already named the staff engine, and the §2 rationale applies to both.

- Proposed filename: `supabase/migrations/20260726000000_reorder_drop_inbound_term.sql`
  (next free slot after `20260725000000`).
- Base body = the VERBATIM current live definition from
  `20260718000000_reorder_list_has_po.sql`. The **single** change is the `(4g)
  pending_po_qty` CTE (lines 244–254): rewrite it to return **zero rows**, e.g.

  ```
  pending_po_qty as (
    select pit.item_id,
           sum(0)::numeric as pending_po_qty
      from public.po_items pit
     where false            -- spec 138: inbound netting retired with receiving
     group by pit.item_id
  ),
  ```

  Nothing else in the function changes: the `left join pending_po_qty ppq`, the
  three `coalesce(ppq.pending_po_qty, 0)` references (output key, `par_replacement`,
  `usage_forecasted`), the `has_po` per-vendor EXISTS, the auth gate, `security
  invoker`, and `set search_path = public` are all preserved. This is the
  minimum-diff form — it touches only the CTE body, leaving every downstream
  reference textually intact (lowest risk on a ~640-line function; keeps the
  normalized-md5 verify tractable).
- **Destructive vs additive:** non-destructive. `CREATE OR REPLACE` of an existing
  SECURITY-INVOKER read RPC. No data touched. Instant on PG 17.
- **Rollout safety:** the reorder card's "inbound" figure drops to a constant 0
  the moment the function is replaced; that is the intended behavior (no receiving
  → no honest inbound signal). No consumer breaks — the JSON key is still present.
- **Prod apply (spec 064 gate — `db push` lacks the prod password, per MEMORY):**
  1. `execute_sql` the whole migration body via Supabase MCP (project
     `ebwnovzzkwhsdxkpyjka`).
  2. INSERT version `'20260726000000'` into
     `supabase_migrations.schema_migrations` so `db-migrations-applied.yml` goes
     back green.
  3. VERIFY by normalized-md5 of the function body (it is `CREATE OR REPLACE
     FUNCTION` — the md5 path applies). Developer FLAGS this in the handoff and
     does NOT push it; the gate is red between commit and apply (expected).

### 2. Inbound-term lifecycle — why option (a)

With receiving retired, a cart-filled order that the extension transitions
`draft → 'sent'` (`markPurchaseOrderSent`) would enter `pending_po_qty` and
**never clear** — suppressing that item's reorder forever. Option (a) removes the
term entirely: reorder plans purely off counted on-hand vs par (+ usage forecast),
which is the honest model for a "no inbound record" world. Chosen over (b)
(keep the spec-125 auto-receive cron to clear sent orders) because:

- (b) keeps a whole cron + `receive_purchase_order` path *live* (not dormant) and
  does an on-`expected_delivery` **stock bump**, contradicting Q2's "stock moves at
  EOD/weekly counts only." The owner explicitly retired receiving.
- The store counts frequently (EOD daily); the double-count window option (a)
  trades away is short and self-corrects at the next count.

**Critical coupling — auto-receive stays inert by starvation, not by a drop.**
The spec-125 auto-receive job only acts on POs with a due `expected_delivery`.
The new Fill-cart path (§4) MUST omit `expected_delivery` (leave it NULL) so no
cart-filled draft is ever auto-received. `createPoDraft` already documents "Undefined
omits the key → expected_delivery stays NULL → never auto-receives." With the PO
tab and its `createPoDraft` call removed, **no live path sets `expected_delivery`
after spec 138**, so the cron has nothing to act on. It stays dormant without a
schema change (§6).

### 3. Edit-persistence + history storage (AC-7 / AC-8 / AC-9)

**Edit store = client `reorderEdits` buffer (NOT draft-PO lines).** A store slice
`reorderEdits: Record<string /*vendorId*/, Record<string /*itemId*/, number /*base
units*/>>`. This diverges from the PM's draft-PO-lines lean (guidance #4) —
justified:

- The extension picks up **any** `status='draft'` PO for an extension vendor. If a
  draft materialized on the *first keystroke* (draft-as-edit-store), a half-edited
  order would leak to the extension mid-edit, and every reorder glance would churn
  PO rows. A client buffer keeps editing local until the operator commits with
  Fill cart / export.
- Draft-as-edit-store forces a per-vendor `po_items` read-merge on every render
  plus a client cost recompute (RPC `estimated_cost`/KPIs are computed from
  suggestions, not edits). The buffer overlays suggestions purely on the client —
  same recompute, no extra fetch.
- Precedent: spec-135 per-card collapse state is explicitly per-session, no
  persistence, resets on store switch. `reorderEdits` follows that exact posture,
  so "persist until exported/cart-filled" (AC-7) is satisfied within the working
  session; a browser reload starting fresh is consistent with spec-135 and with
  "an untouched line always shows the computed suggestion."

**Buffer lifecycle:**
- Read for display/est-cost/KPI/exports: `base = reorderEdits[vendorId]?.[itemId]
  ?? item.suggestedUnits`.
- Write on inline blur via `poResolveEdit` (§5).
- Reset **per vendor** after that vendor's export OR Fill cart (AC-7).
- Reset **wholesale** on store switch and on `selectedDate` change (both already
  have effects in `ReorderSection` — clear `reorderEdits` alongside `expandedKeys`).

**History (AC-8) = `purchase_orders` rows, read-only.** No new table (guidance #3).
The existing `fetchRecentPurchaseOrders(storeId)` already returns exactly `date`
(`referenceDate`), `vendorName`, `totalCost`, `status` (mapped in
`mapPurchaseOrderRow`) and lands in `orderSubmissions`. The history affordance
renders `orderSubmissions` filtered to non-cancelled, showing date / vendor /
total. Refresh via `refreshPurchaseOrders()` on history open/mount.

**Scope boundary (explicit, flag to PM):** only the Fill-cart handoff materializes
a PO, so **history captures cart-filler orders only**. CSV/PDF/quick-order exports
stay pure client artifacts and are NOT logged — consistent with the owner's own
"I order by phone/text" workflow (those orders are off-system by nature) and with
retiring PO paperwork. If the PM later wants every export logged, that is a small
additive follow-up (materialize a `'sent'` PO on export behind a store+vendor+date
guard so the extension never sees it) — noted as an OPEN QUESTION, not built here.

### 4. API contract — cart-filler handoff (B1)

**No new RPC, no extension change (AC-10).** The extension keeps reading the
unchanged `get_pending_extension_orders` / `get_extension_order_payload`
(`20260723000000_extension_ordering.sql`) and keeps marking `draft → 'sent'` via
`markPurchaseOrderSent`. All new work is a PostgREST upsert under the existing
`store_member_*` RLS on `purchase_orders` / `po_items`.

**Fill cart is idempotent per `(store, vendor, reorder date)`:**
- If a **non-cancelled `draft`** PO exists for that key: replace its lines with the
  current buffer-overridden quantities and update `total_cost`.
- Else: insert a fresh `draft` header + lines (reuse `createPoDraft` shape).
- Match only `status='draft'`. A `'sent'` PO for the same key is a placed order —
  do NOT mutate it; create a new draft (a legitimate second order; safe now that
  the inbound term is gone).
- **Omit `expected_delivery`** (see §2 — keeps auto-receive inert).

**New db helper** (`src/lib/db.ts`, camelCase mapping via existing `mapPoItemRow`/
`mapPurchaseOrderRow`; carve-out rules unchanged — this stays inside `db.ts`):

```ts
// Find an existing non-cancelled DRAFT for (store, vendor, referenceDate);
// if found, delete its po_items + reinsert lines + update total_cost; else
// insert header (status 'draft', NO expected_delivery) + lines. Returns poId.
export async function upsertVendorDraftOrder(params: {
  storeId: string;
  vendorId: string;
  createdByUserId?: string;
  referenceDate?: string;                 // YYYY-MM-DD → reference_date (spec 123 keying)
  lines: Array<{ itemId: string; orderedQty: number; costPerUnitCounted: number }>;
}): Promise<string | null>;
```

- Request: store/vendor/date + resolved lines (buffer-overridden qty; per-counted-
  unit cost snapshot `costPerUnit(per-each) × subUnitSize`, exactly as
  `createPoDraft` computes today).
- Response: `poId` (string) or `null` on failure.
- Errors: RLS denial / insert failure → `null` + `notifyBackendError` (existing
  optimistic-then-revert toast pattern). Empty lines → `null`.
- Reuses `updatePoItemQty` / `deletePoItem` / `createPurchaseOrderDraft` building
  blocks; no new PostgREST surface beyond a keyed select on `purchase_orders`.

**RLS impact:** none new. `purchase_orders` / `po_items` writes flow through the
existing `store_member_insert/update/delete_*` policies (per-store via
`auth_can_see_store`). No new table → no new policy. The extension RPCs are
untouched. No `auth_is_admin()` path involved.

### 5. Inline case-quantity editing (AC-5 / AC-6)

Reuse `src/utils/poCaseDisplay.ts` verbatim (spec 134) — no forked conversion:
- Seed the per-item `TextInput` `defaultValue` with `poOrderedDisplay(base,
  caseQty)` where `base = reorderEdits[vendorId]?.[itemId] ?? item.suggestedUnits`.
- `isCaseRow(item.caseQty)` decides cases vs units + the `× N / case` sub-caption.
- On blur: `poResolveEdit(rawText, base, caseQty)` → `{ write, base }`; on `write`,
  set `reorderEdits[vendorId][itemId] = base` (base units).
- The edit field lives in the card BODY (below the spec-135 collapse guard) — you
  expand a card to edit; the header actions (Fill cart / CSV / PDF / quick-order)
  operate on the buffer whether collapsed or not. Consistent with spec-135.

**Cost basis — load-bearing detail.** `poCaseDisplay.poCasePrice` expects a
**per-COUNTED-unit** cost, but `ReorderItem.costPerUnit` from the RPC is
**per-EACH** (spec 104). Any recomputed est-$ / KPI from an edited base qty MUST
bridge: `estCost = editedBaseUnits × item.costPerUnit × subUnitSize`, where
`subUnitSize` comes from `inventory.find(i => i.id === itemId)?.subUnitSize ?? 1`
(the same `costPerUnitCounted` bridge `createPoDraft` already uses). Do NOT feed
the raw per-each `costPerUnit` into `poCasePrice` — it would be off by
`subUnitSize`. Untouched lines keep the server `estimated_cost` verbatim.

Every artifact reads the buffer-overridden base qty: CSV (`buildReorderCsv` /
`planUsFoodsExport` / `planSyscoExport`), PDF (`handlePdfExport`), quick-order
(`buildPoQuickOrderText` — currently fed `it.suggestedUnits`; feed the overridden
base), and Fill cart. The card's est-cost / KPI figures recompute from the same.

### 6. Dormant-not-dropped backend (explicit)

**No destructive schema drops.** Stays dormant (in DB, unused by UI):
- `receive_purchase_order` RPC; spec-125 `auto_receive_due_purchase_orders`
  (inert by starvation — no path sets `expected_delivery`, §2); spec-109
  cost-on-receipt columns/logic; spec-113 staff receiving price-gate RPC.
- `ReceivingSection.tsx`, staff `Receiving.tsx`, `orderingHandoff.ts` — left on
  disk, fully unmounted (a future cleanup spec may remove; leaving them avoids
  churning their tests now).
- `POsSection.tsx` — **partially** unmounted. Its `export default function
  POsSection()` (the case-editor / CreatePoButton tab UI) is no longer mounted.
  BUT its named export `POHistoryTab` is STILL LIVE — `VendorsSection.tsx:9,444`
  imports and renders it inside the Vendors detail screen. **Do NOT delete this
  file in a future cleanup pass** without first relocating `POHistoryTab`; a
  wholesale delete would silently break the Vendors page's PO-history tab.
  (Corrected 2026-07-23 per code-review fix #4 — the earlier "unmounted" wording
  was inaccurate for this one file.)

**Stays LIVE / changes:**
- `report_reorder_list` — the one changed RPC (§1).
- `purchase_orders` / `po_items` tables — live (Fill-cart drafts + history).
- `get_pending_extension_orders` / `get_extension_order_payload` /
  `markPurchaseOrderSent` — live, UNCHANGED (extension contract).
- New `upsertVendorDraftOrder` db helper + `fillCartForVendor` store action.

### 7. `src/lib/db.ts` surface

- **New:** `upsertVendorDraftOrder(params)` (§4).
- **Reused unchanged:** `createPurchaseOrderDraft`, `updatePoItemQty`,
  `deletePoItem`, `fetchRecentPurchaseOrders`, `fetchReorderList`,
  `markPurchaseOrderSent`.
- snake↔camel via the existing `mapPurchaseOrderRow` / `mapPoItemRow` — no new
  mapper. `extension_ordering ↔ extensionOrdering` already mapped (db.ts:1909).

### 8. Frontend store impact (`useStore.ts`)

- **New slice:** `reorderEdits` (§3) + actions `setReorderEditQty(vendorId,
  itemId, base)`, `clearReorderEditsForVendor(vendorId)`, `clearReorderEdits()`.
- **New action:** `fillCartForVendor(vendor)` — builds buffer-overridden lines,
  calls `db.upsertVendorDraftOrder`, then `refreshPurchaseOrders()` (so history +
  extension see it) and `clearReorderEditsForVendor(vendorId)`. Optimistic-then-
  revert with `notifyBackendError` on failure (existing pattern — the buffer is
  the optimistic state; keep it on error so the operator can retry).
- **Retire:** the `createPoDraft`-from-reorder-card path and its `onPoCreated` /
  `orderingHandoff` deep-link glue (no PO tab to jump to). `createPoDraft` itself
  may stay (dormant) or be removed with POsSection; leave dormant to avoid churn.

### 9. UI retirement (AC-1/2/3/4/12) and wiring

- **`OrderingSection.tsx`** → thin wrapper: renders `<ReorderSection />` (no
  `TabStrip`, no `POsSection`) plus the AC-8 History affordance (an unobtrusive
  "History" link/panel reading `orderSubmissions`). Drop `onPoCreated` /
  `useOrderingHandoff`.
- **`ReorderSection.tsx`** → inline edit fields (§5); replace `CreatePoButton`
  with a `FillCartButton` rendered **only when `vendor.extensionOrdering === true`**
  (AC-9/AC-11) — resolve via `vendors.find(v => v.id === vendor.vendorId)
  ?.extensionOrdering`; remove the `vendorHasPo` "+ CREATE PO" / "PO CREATED" chip
  entirely (AC-12). Keep spec-135 collapsible cards + header-action layout.
- **Admin Receiving removal:** drop `{ id: 'Receiving' }` from `cmdSelectors.ts`
  OPERATIONS group (:1102), drop the `Receiving` palette entry (:171) and the
  `Ordering`+`pos` palette alias (:180, no PO surface — keep the `reorder` alias),
  and remove the `Receiving` switch branch + `ReceivingSection` import in
  `InventoryDesktopLayout.tsx` (:41,:300–301).
- **Staff Receiving removal:** drop the `Receiving` `Tab.Screen` + import in
  `StaffStack.tsx` (:43,:141–152).
- **Sidebar-override fallback (AC-4):** extend `sidebarLayout.ts`. `Reorder` /
  `PurchaseOrders` → `Ordering` aliases stay. Add a **remove-only** path for
  `Receiving` (and `PurchaseOrders` is already remapped): a `REMOVED_SIDEBAR_IDS =
  new Set(['Receiving'])` that `remapLegacySidebarOverrideIds` filters OUT (the
  merge already silently drops ids absent from `defaultGroups`, but make it
  explicit + unit-testable per the spec-137 precedent, no crash, no dangling
  entry).
- **EODCountSection deep-link (:749–750):** `request({ section: 'Ordering' })`
  stays valid (Ordering still exists, now reorder-only). No change — verify it
  lands on the reorder pane.
- **i18n:** ADD keys for `Fill cart` (label + aria), History (title, date/vendor/
  total headers, empty state), inline-edit aria. Leave `sidebar.items.receiving`,
  `sidebar.items.purchaseOrders`, `section.reorder.createPo*` / `poCreated*`, and
  the staff `receiving.*` catalog dormant (unused; a cleanup spec removes them).

### 10. Realtime impact

No new channel. `purchase_orders` / `po_items` already ride `store-{id}` (Fill-cart
drafts + history reconcile on the 400ms debounce). The one migration does NOT
change `supabase_realtime` publication membership, so the
`docker restart supabase_realtime_imr-inventory` gotcha does NOT apply here.

### 11. Risks and tradeoffs

- **Double-order window (accepted).** Dropping the inbound term means two orders
  before the next count aren't netted. Acceptable per Q2 + frequent counts; pinned
  by pgTAP.
- **Existing pgTAP that asserts inbound netting must be updated.** Audit
  `report_reorder_for_counted_onhand.test.sql`, `report_reorder_list_hybrid_formula.test.sql`,
  and any test asserting `pending_po_qty` reduces the suggestion — they go red
  under the dropped term and must be updated to expect `pending_po_qty = 0` /
  no-subtraction. The new test (§12) pins the new behavior; the has_po test
  (`reorder_list_has_po.test.sql`) is unaffected (has_po is a separate EXISTS).
- **History gap for non-extension vendors** (§3 scope boundary) — flagged to PM.
- **Cost-basis bridge** (§5) — the per-each vs per-counted-unit factor is the
  easiest thing to get wrong; jest must assert edited est-$ against a case row
  with `subUnitSize > 1`.
- **Migration ordering** — single migration, next free slot `20260726000000`;
  prod-apply via MCP, gate red until `schema_migrations` insert (expected).
- **Performance** — the migration REMOVES a per-item PO aggregate scan; net a
  small win on the 286 KB seed. No cold-start concern (no edge function).
- **Extension untouched** — its vitest suite must stay green (out of scope).

### 12. Test plan (spec 022 tracks)

- **jest (AC-14):**
  - inline edit → `poResolveEdit` → `reorderEdits` write → each of CSV /
    quick-order / PDF builders + Fill-cart lines reflect the edited base qty
    (case→base via `poCasesToBase`); est-$/KPI recompute (assert the
    `× costPerUnit × subUnitSize` bridge on a `subUnitSize > 1` case row).
  - edit persistence + reset-after-export and reset-after-Fill-cart per vendor
    (AC-7); reset on store switch / date change.
  - `FillCartButton` present iff `extensionOrdering` (AC-9/AC-11); `+ CREATE PO` /
    `PO CREATED` gone (AC-12).
  - `fillCartForVendor` / `upsertVendorDraftOrder`: create when no draft, update
    the existing draft when one exists, new draft when only a `'sent'` exists,
    `expected_delivery` omitted (mock db).
  - `remapLegacySidebarOverrideIds`: `Receiving` dropped, `Reorder`/`PurchaseOrders`
    → `Ordering`, no crash/dangling (AC-4).
  - History panel renders date/vendor/total from `orderSubmissions`, read-only.
- **pgTAP (AC-15 — REQUIRED, the reorder RPC changed):** new
  `supabase/tests/report_reorder_list_no_inbound.test.sql` — an item with an open
  `'sent'` PO now emits `pending_po_qty = 0` and its `suggested_qty` no longer
  subtracts inbound (par-vs-on-hand only); envelope shape unchanged (key present);
  auth gate + `has_po` intact. Update the existing inbound-asserting tests (§11).
- **shell smoke (recommended):** Fill cart → `upsertVendorDraftOrder` writes a
  draft → `get_pending_extension_orders` returns it → `get_extension_order_payload`
  returns its lines. Confirms the B1 handoff end-to-end against the unchanged RPCs.
- **extension vitest:** UNTOUCHED — must remain green (no extension change).
- **e2e nav:** Receiving gone (admin sidebar + staff tab bar); Ordering =
  reorder-only (no PO tab); Fill cart on extension vendors.

### 13. Spec-134/135 conventions verified

- Inline case editing reuses `poCaseDisplay` helpers (`isCaseRow` /
  `poOrderedDisplay` / `poResolveEdit` / `poCasesToBase`) — mandated, no fork (§5).
- Collapsible cards + header actions (spec 135) survive: Fill cart / CSV / PDF /
  quick-order stay in the header name row; edit fields sit in the collapsible body.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement spec 138 against the "## Backend design" section. Backend:
  the one migration 20260726000000_reorder_drop_inbound_term.sql (drop the
  pending_po_qty inbound term per §1/§2 — minimum-diff CTE-returns-zero-rows
  form), the new upsertVendorDraftOrder db helper (§4, omit expected_delivery),
  the new report_reorder_list pgTAP + update the inbound-asserting tests (§11/§12),
  and FLAG the MCP prod-apply (don't push). Frontend: reorderEdits buffer +
  fillCartForVendor store action, inline case editing on reorder cards (poCaseDisplay,
  per-each→per-counted-unit cost bridge), FillCartButton (extension vendors only,
  replaces + CREATE PO / PO CREATED), OrderingSection→reorder-only + History panel,
  admin+staff Receiving removal, sidebar-override fallback for removed ids. After
  implementation set Status: READY_FOR_REVIEW and list files under ## Files changed.
payload_paths:
  - specs/138-reorder-only-retire-po-receiving.md

## Files changed (backend)

Backend slice (items 1–4 of the build task) implemented by backend-developer.
Status left at `READY_FOR_BUILD` because the FRONTEND half is not yet marked
done (no frontend `## Files changed` section; `ReorderSection.tsx` is still being
edited by frontend-developer, `OrderingSection.tsx` still passes the removed
`onPoCreated` prop). Flip to `READY_FOR_REVIEW` once the frontend lands.

**Migrations**
- `supabase/migrations/20260726000000_reorder_drop_inbound_term.sql` — NEW.
  Per the architect's OPTION A ruling, `CREATE OR REPLACE`s **BOTH** reorder
  engines in one migration with the IDENTICAL `(4g) pending_po_qty` CTE change
  (`where false` / `sum(0)`), so every `coalesce(ppq.pending_po_qty,0)` reads 0:
  - `report_reorder_list(uuid, jsonb)` — off the verbatim latest body
    (`20260718000000_reorder_list_has_po.sql`, confirmed latest owner). Emitted
    per-item `pending_po_qty` byte-stable at 0; `has_po` EXISTS preserved.
  - `report_reorder_for_counted_onhand(uuid, jsonb, jsonb)` — the STAFF
    counted-on-hand engine, off its verbatim latest-owner body
    (`20260704000000_po_loop.sql:1087`, the spec-107 real-netting version — NOT
    the `20260702000000` v1). Its pending key is internal-only, so the flat item
    envelope is unchanged; the two engines stay byte-parallel.
  Both are non-destructive `CREATE OR REPLACE`s of SECURITY-INVOKER read RPCs,
  signatures byte-identical (ACLs preserved). NOT applied to prod — flagged for
  MCP apply below.

**src/lib/db.ts**
- NEW `upsertVendorDraftOrder(params)` — materialize/refresh ONE `draft`
  purchase_orders row per `(store, vendor, referenceDate)` from
  buffer-overridden lines; matches only `status='draft'`; per-counted-unit cost
  snapshot (`costPerUnit × subUnitSize`); OMITS `expected_delivery` to keep the
  spec-125 auto-receive cron inert by starvation (design §2/§4).

**src/store/useStore.ts**
- NEW state `reorderEdits` (per-session `vendorId → itemId → base` overlay) +
  actions `setReorderEditQty`, `clearReorderEditsForVendor`, `clearReorderEdits`.
- NEW action `fillCartForVendor(vendor)` — buffer-overridden lines →
  `db.upsertVendorDraftOrder` → `refreshPurchaseOrders()` (history + extension
  RPCs see it) → `clearReorderEditsForVendor` (AC-7); optimistic-then-revert
  keeps the buffer on error.
- `loadFromSupabase` store-switch reset now also clears `reorderEdits`.
- History read path REUSES existing `refreshPurchaseOrders()` / `orderSubmissions`
  (design §3) — no new store read added.

**src/types/index.ts**
- `AppState.reorderEdits` field added (typed `Record<string, Record<string, number>>`).

**supabase/tests/**
- NEW `report_reorder_list_no_inbound.test.sql` — pins `pending_po_qty = 0` /
  no inbound subtraction on `report_reorder_list` for an item with an open
  `'sent'` PO, envelope key still present, `has_po` intact (6 assertions, all
  pass).
- UPDATED `po_loop.test.sql` (per the OPTION A ruling) — cases (P) 20/21/22
  re-pinned to the no-netting values: `report_reorder_list` pending 0 /
  suggested 140; `report_reorder_for_counted_onhand` suggested 140. Byte-parity
  test 23 KEPT (now `0 == 140 − 140`, parity at the un-netted baseline). The
  (H/P) cancel case re-labelled (suggestion stays 140; inbound already ignored).
  File-level `(P)` header comment updated. 30/30 assertions pass.

### Verification (run against the live local stack; honest results — FINAL)
- `npx tsc --noEmit`: **0 errors**. (The frontend `OrderingSection.tsx`
  `onPoCreated` error surfaced during the first pass was the frontend developer's
  concurrent mid-flight edit and is now resolved on their side.)
- `npx tsc -p tsconfig.test.json --noEmit`: **0 errors**.
- `scripts/test-db.sh` (after applying the finalized 2-function migration to the
  local DB): **76/76 DB test files pass** — incl. `po_loop.test.sql` 30/30,
  `report_reorder_list_no_inbound.test.sql` 6/6, and
  `report_reorder_for_counted_onhand.test.sql` 10/10.
- `npx jest`: not re-run for the final backend pass (backend files unchanged
  since the first pass; the earlier 14 failures were all FRONTEND suites mid-edit
  — `cmdSelectors.paletteScreens`, `OrderingSection`, `ReorderSection.spec{123,130,135}`
  — the frontend developer owns those). Zero backend (db/store) jest failures
  were observed.

### ✅ RESOLVED — inbound-term contradiction (architect ruled OPTION A)
The surfaced contradiction was ruled OPTION A (see "✅ Architect ruling" above):
BOTH engines drop the inbound term in the same migration. Implemented as
described in the migration bullet; `po_loop.test.sql` updated to pin the
no-netting behavior with the byte-parity guard retained. `po_loop.test.sql` is
now GREEN. No open backend blockers.

### ✅ Architect ruling — drop the inbound term on BOTH engines (option A)

**Ruling: OPTION A.** The same migration `20260726000000_reorder_drop_inbound_term.sql`
ALSO `CREATE OR REPLACE`s `report_reorder_for_counted_onhand` off its verbatim
latest-owner body (`20260704000000_po_loop.sql`, the `:1266` netting CTE — NOT the
`20260702000000` v1 body), applying the identical `where false` change so its
`pending_po_qty` reads 0 and it stops subtracting inbound. Update `po_loop.test.sql`
cases 20/21/22 to the no-netting values and KEEP the parity test 23 (both engines
now emit no inbound reduction → both suggest 140; parity holds, just at the
un-netted baseline). The developer's recommended resolution is correct.

**Rationale:**
1. **The §2 bug is live on staff under option B.** The staff Reorder screen
   (spec 105, `report_reorder_for_counted_onhand`) reads the SAME store
   `purchase_orders`. A Fill-cart draft the extension marks `draft → 'sent'` enters
   its `pending_po_qty` CTE and never clears (receiving retired for staff too —
   AC-3 removes the staff Receiving tab), suppressing that item on the staff
   reorder screen **forever**. Option B knowingly ships the exact bug this spec
   exists to prevent.
2. **Divergence is incoherent, not a feature.** Both engines are the same reorder
   math on the same data; the vendor engine uses EOD/stock on-hand and the counted
   engine takes on-hand as a supplied param, but "net open POs against par" is
   identical intent. Admin planning off par-vs-on-hand while staff nets a
   permanently-stuck inbound would produce two different order suggestions for the
   same store on the same day — a support trap.
3. **Consistency with the rest of the design.** §11 and build-task item 4 already
   named `report_reorder_for_counted_onhand` as a suite to update; §1's
   "single function" phrasing was the outlier and is now corrected above. This is
   a wording fix, not a scope expansion — the intent was always both engines.
4. **Non-destructive + same blast radius.** Two `CREATE OR REPLACE`s of
   SECURITY-INVOKER read RPCs in one migration; no table/policy/publication change;
   the CTE-returns-zero-rows form keeps each function's downstream references
   textually intact and normalized-md5-verifiable. The counted engine's
   `CREATE OR REPLACE` applies in the SAME MCP prod step (below).

**Developer action:** add the counted-engine `CREATE OR REPLACE` to the same
migration file; update `po_loop.test.sql` 20/21/22 to no-netting, keep test 23 as
the (now-un-netted) parity guard; re-run `scripts/test-db.sh` to green. No other
design change. This does NOT block the frontend slice.

### ⚑ Prod-apply FLAG (MCP, per project MEMORY — NOT pushed)
`20260726000000_reorder_drop_inbound_term.sql` (the FINAL 2-function form —
`report_reorder_list` + `report_reorder_for_counted_onhand`) was applied to the
LOCAL stack only (for pgTAP). Prod apply is out of my scope: `execute_sql` the
WHOLE migration body via Supabase MCP (project `ebwnovzzkwhsdxkpyjka`) — both
`CREATE OR REPLACE`s land in the same step — INSERT version `'20260726000000'`
into `supabase_migrations.schema_migrations`, then normalized-md5 verify BOTH
function bodies. The `db-migrations-applied.yml` gate will be red between commit
and apply (expected).

## Files changed (frontend)

Frontend slice implemented by frontend-developer. Both halves are complete on
disk (backend migration + db helper + store slice + pgTAP, frontend UI + tests),
so Status is flipped to `READY_FOR_REVIEW`.

**src/screens/cmd/sections/ReorderSection.tsx**
- Inline per-item ORDER-qty editing (AC-5) in the card body via the spec-134
  `poCaseDisplay` helpers (`isCaseRow` / `poOrderedDisplay` / `poResolveEdit`) —
  cases when `caseQty > 1`, else units; writes `setReorderEditQty` on blur.
- NEW exported pure `applyReorderEdits(vendor, vendorEdits, subUnitSizeFor)` —
  overlays the buffer for display / est-$ / KPI / exports, recomputing est-$ via
  the load-bearing `base × costPerUnit × subUnitSize` per-each→per-counted-unit
  bridge (§5); untouched items keep the server `estimated_cost` verbatim.
- Section applies the overlay to the needs / enough / no-schedule vendor lists
  and the KPI strip (AC-6); every export (CSV / PDF / quick-order) + Fill cart
  reads the overridden qty.
- `CreatePoButton` / `vendorHasPo` "PO CREATED" chip REMOVED (AC-12); NEW
  `FillCartButton` rendered only when `vendors.find(...).extensionOrdering`
  (AC-9/AC-11), confirm-gated → `fillCartForVendor`.
- Dropped the spec-137 `onPoCreated` prop + `OnPoCreatedContext`.
- Edit buffer reset in the store-switch / as-of-date effect via
  `clearReorderEdits()` (design §3, mirroring spec-135 `expandedKeys`).

**src/screens/cmd/sections/OrderingSection.tsx**
- Collapsed to reorder-only (AC-1): renders `<ReorderSection />`, no `TabStrip` /
  `POsSection` / `useOrderingHandoff`.
- NEW read-only `OrderHistoryPanel` (AC-8) — collapsible bottom panel reading
  `orderSubmissions` (non-cancelled), date / vendor / total; refreshes via
  `refreshPurchaseOrders()` on open.

**src/lib/cmdSelectors.ts** — removed the `Receiving` OPERATIONS sidebar item
(AC-2), the `Receiving` palette entry, and the `Ordering` `pos` palette alias
(kept `ordering` + `reorder` searchable).

**src/screens/cmd/InventoryDesktopLayout.tsx** — removed the `Receiving` dispatch
branch + `ReceivingSection` import.

**src/screens/staff/navigation/StaffStack.tsx** — removed the `Receiving`
`Tab.Screen` + import (AC-3). The `receiving.*` staff i18n + `Receiving.tsx`
screen stay on disk, dormant.

**src/lib/sidebarLayout.ts** — added `REMOVED_SIDEBAR_IDS = {'Receiving'}` and a
remove-only filter in `remapLegacySidebarOverrideIds` (AC-4); the `Reorder` /
`PurchaseOrders` → `Ordering` aliases stay.

**src/i18n/{en,es,zh-CN}.json** — added `section.reorder.fillCart*`,
`orderedLabel` / `orderedEditAria` / `perCaseCaption`, and `history*` keys. The
`createPo*` / `poCreated*` keys are left dormant (a cleanup spec removes them).

**src/store/useStore.ts (AC-7 correction — flag for drift review)** — REVERTED
the `reorderEdits: {}` line the backend developer added to the `loadFromSupabase`
store-switch `set()` block. That `set` runs on EVERY realtime reload
(`CmdNavigator` `handleSync` → `loadFromSupabase` on the 400ms debounce, incl.
the `purchase_orders` change Fill cart itself emits), so clearing the buffer
there would wipe a vendor's in-progress edits mid-session and break AC-7. Per
design §3 the buffer is reset in the ReorderSection effect (store switch /
as-of-date change), mirroring spec-135 `expandedKeys` — which is what this slice
now does. Replaced the line with an explanatory comment. (The backend Files-changed
note "loadFromSupabase store-switch reset now also clears reorderEdits" is
superseded by this correction.)

**Tests**
- NEW `src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx` —
  `applyReorderEdits` est-$ bridge on a `subUnitSize > 1` case row; inline edit →
  `poResolveEdit` → buffer write (cases) + seed no-op; edited qty flows to the
  breakdown + CSV builder.
- REWROTE `OrderingSection.test.tsx` — reorder-only shell (no PO tab), History
  panel (refresh / rows / cancelled-filter / empty), remap incl. dropped
  `Receiving`.
- REWROTE `ReorderSection.spec123.test.tsx` "PO CREATED" block → Fill-cart
  extension gating (AC-9/AC-11/AC-12); kept narrow + per-vendor export tests.
- UPDATED `ReorderSection.spec130/spec135` create-po assertions → Fill cart
  (extension vendor); added the new slice fields to every reorder store mock
  (`ReorderSection.test`, `ReorderSectionCases`, spec123/130/135).
- UPDATED `cmdSelectors.paletteScreens.test.ts` — 2 Ordering entries (no `pos`),
  no retired Receiving route.
- UPDATED `e2e/reorder.spec.ts` + `e2e/fixtures/constants.ts` — Ordering lands
  directly on the reorder pane (no `ordering-tab-reorder` click).

**Verification (honest, real exit codes):**
- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- `npx jest` → exit 0, 131 suites / 1388 tests pass.
- Browser pass NOT run: this agent has no preview/browser tooling. Main Claude
  should exercise the golden path (edit a case qty → est-$ updates → export/Fill
  cart consumes it → buffer resets), the History panel, and the 1100px boundary /
  dark mode.

## Release-proposal fixes applied (2026-07-23, frontend-developer)

Applied the ordered fix plan from
`reviews/release-proposal.md` (owner ruling: implement TO SPEC — "persist until
exported/ordered" means exports DO reset the buffer). Status stays
`READY_FOR_REVIEW`.

**Fix 1 — AC-7 reset-after-export (the blocker).** Wired
`clearReorderEditsForVendor(vendorId)` into the per-vendor CSV, PDF, AND
quick-order export handlers, firing on SUCCESS ONLY (a failed / cancelled export
preserves the operator's edits so they can retry). Fill-cart already reset.
- `src/screens/cmd/sections/ReorderSection.tsx`:
  - `handleCsvExport` / `handleImportExport` / `handlePdfExport` now return a
    `boolean` success (true only after the download/emit actually fired; false in
    the catch).
  - `ReorderVendorExportButtons.onCsv` / `onPdf` → `if (ok)
    clearReorderEditsForVendor(vendor.vendorId)`.
  - `ReorderQuickOrderButton.onShareQuickOrder` → resets on
    `sharePurchaseOrder`'s `shared === true` (a user-dismiss / hard failure
    returns `shared: false` → no reset).
- NEW `src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx`
  (8 tests): CSV/PDF/quick-order success each reset the vendor buffer; CSV
  failure (builder throws) and quick-order dismiss preserve edits; reset is
  scoped to the exported vendor only.

**Fix 2 — Fill-cart write-path tests (AC-9/AC-10).**
- NEW `src/lib/db.upsertVendorDraftOrder.test.ts` (8 tests): insert-when-no-draft
  (header `status:'draft'`, summed `total_cost`, `expected_delivery` OMITTED, cost
  snapshot verbatim); matches only `status='draft'` (a `sent` order → find null →
  fresh draft); null `reference_date` branch; empty-lines → null with no query;
  UPDATE path reads old ids → inserts new → deletes only the captured old ids →
  updates total; insert-failure leaves old lines intact (no delete issued);
  no-old-lines skips the delete.
- NEW `src/store/useStore.fillCartForVendor.spec138.test.ts` (7 tests): passes the
  EDITED (buffer-overlaid) qty + per-counted-unit cost + `referenceDate =
  reorderPayload.asOfDate`; falls back to the server suggestion when unedited;
  on success clears the vendor buffer + refreshes POs/suggestions; on `null` and
  on throw the buffer is PRESERVED; no-active-store short-circuits without an
  upsert.

**Fix 3 — `upsertVendorDraftOrder` UPDATE-path atomicity.**
`src/lib/db.ts` — reordered the existing-draft branch from delete-then-reinsert
to **capture-old-ids → insert-new → delete-old-by-id → update-total**, per the
code-reviewer's concrete recommendation. A mid-operation failure now never
leaves a previously-filled draft empty (the prior lines stay until the new ones
commit), and targeting the delete at the captured old ids keeps the sequence
re-runnable/idempotent (a failed delete collapses on the next Fill cart).
FOLLOW-UP noted inline: a true all-or-nothing guarantee (no transient
doubled-lines window) would need a single SECURITY-INVOKER RPC — deferred, not
built here.

**Fix 4 — doc correction.** Design §6 now records that `POsSection.tsx` is only
**partially** unmounted: its named export `POHistoryTab` is still live via
`VendorsSection.tsx:9,444`. Do not delete the file in a future cleanup pass
without relocating `POHistoryTab`.

**Fix 5 — nits.** Applied 3 quick ones: dropped the redundant `|| 1` at the
`subUnitSizeFor` call site (kept the single fallback in the pure
`applyReorderEdits`); refreshed the stale `ReorderSection.spec123.test.tsx`
header comment to describe the spec-138 Fill-cart gating; added the
intentional-defensiveness comment on `fillCartForVendor`'s buffer re-derivation.
**Deferred nit:** `e2e/reorder.spec.ts:69-84` reads the pre-spec-123
non-suffixed `reorder-export-csv` testID (so `exportVisible` is always false) —
pre-existing, out of scope per the release-proposal, left for a test-hygiene
follow-up.

**Verification (honest, real exit codes — no grep-piping jest):**
- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- `npx jest` → exit 0, **134 suites / 1407 tests pass** (was 131/1388; +3 suites,
  +19 tests).
- `scripts/test-db.sh` → **76/76 DB test files pass** (unchanged — no SQL
  touched by these fixes).
- `cd extension && npx vitest run` → **31/31 pass** (extension untouched).
- Browser pass NOT run: this agent has no preview/browser tooling available.
  Main Claude should still exercise the golden path (edit a case qty → est-$
  updates → CSV/PDF/quick-order/Fill cart consumes it → that vendor's buffer
  resets → a fresh suggestion returns), the History panel, and the 1100px
  boundary / dark mode.

**Files changed (this pass):**
- `src/screens/cmd/sections/ReorderSection.tsx` (Fix 1 + Fix 5 nits)
- `src/lib/db.ts` (Fix 3)
- `src/store/useStore.ts` (Fix 5 nit — defensiveness comment only)
- `src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx` (Fix 5 nit — header comment)
- NEW `src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx` (Fix 1 tests)
- NEW `src/lib/db.upsertVendorDraftOrder.test.ts` (Fix 2 tests)
- NEW `src/store/useStore.fillCartForVendor.spec138.test.ts` (Fix 2 tests)
- `specs/138-reorder-only-retire-po-receiving.md` (Fix 4 doc correction + this section)

## Original PM handoff (superseded — kept for provenance)
next_agent: backend-architect
prompt: Design the contract for spec 138. Read the acceptance criteria and the
  "Design guidance for the architect" section — especially guidance #2, the
  REQUIRED inbound-term (`pending_po_qty`) lifecycle decision forced by retiring
  receiving (a cart-filled order that goes draft→sent would otherwise inflate
  reorder "inbound" forever). Confirm the B1 cart-filler handoff contract keeps
  the specs-131/132 extension RPCs unchanged, decide the edit-persistence + history
  storage (draft-PO-lines recommended), and specify the sidebar/staff UI retirement
  + override fallback. Produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/138-reorder-only-retire-po-receiving.md
