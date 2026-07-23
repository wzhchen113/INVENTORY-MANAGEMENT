# Backend-architect drift review — spec 138

Mode: post-implementation architectural-drift review. Scope: the five rulings
requested (AC-7 resolution, the two-engine migration, `upsertVendorDraftOrder`,
extension RPC surface, dormant-not-dropped posture). No `Status:` change, no code
change.

**Verdict: no Critical or Should-fix drift. The implementation matches the design
and the OPTION A ruling. Two Minor notes below, neither blocking.**

---

## 1. AC-7 conflict resolution — CONFIRMED CORRECT

The frontend developer's revert is the right call and is now coherent across both
files.

- `src/store/useStore.ts:1311-1321` — `loadFromSupabase`'s store-switch `set()`
  block resets `reorderPayload` but **explicitly does NOT** reset `reorderEdits`,
  with a comment naming the exact failure mode: this `set` runs on every 400ms
  realtime reload (`CmdNavigator handleSync → loadFromSupabase`), including the
  `purchase_orders` change Fill cart itself emits, so clearing the buffer here
  would wipe in-progress edits mid-session and break AC-7. This is factually
  correct — `loadFromSupabase` is the realtime reload entry point, not a
  store-switch-only path, so the backend developer's original `reorderEdits: {}`
  line there would indeed have wiped the buffer on the reload Fill cart triggers.
- `src/screens/cmd/sections/ReorderSection.tsx:1311-1331` — the reset now lives in
  the section effect, gated on `currentStore?.id` / `selectedDate`. `clearReorderEdits()`
  fires on store switch (inside the `storeChanged` branch, alongside
  `setExpandedKeys(new Set())` — the spec-135 `expandedKeys` precedent cited in
  design §3) and on same-store as-of-date change (else branch). The effect deps
  `[currentStore?.id, selectedDate, loadReorderSuggestions, clearReorderEdits]` do
  not change on a realtime reload, so edits correctly survive the debounce. This
  is exactly design §3's "reset wholesale on store switch and on selectedDate
  change (both already have effects in ReorderSection)."

Minor (non-blocking): the reset is broader than the spec-135 `expandedKeys`
precedent it cites — `expandedKeys` only resets on store switch, whereas
`clearReorderEdits()` also fires on as-of-date change. That extra reset is
**intended** (AC-7: a different day means different suggestions), so this is a
correct divergence, not drift — worth noting only because the "mirroring
spec-135" framing understates it.

## 2. Migration `20260726000000_reorder_drop_inbound_term.sql` — CONFIRMED MATCHES THE TWO-ENGINE RULING

- **Verbatim latest-owner bodies.** `report_reorder_list(uuid, jsonb)` is built off
  the `20260718000000_reorder_list_has_po.sql` body (has_po EXISTS at
  `:603-610` preserved, spec-102/104 CTEs intact). `report_reorder_for_counted_onhand`
  is built off the `20260704000000_po_loop.sql:1087` spec-107 body (the counted
  `p_on_hand`-map `item_on_hand`, the DELTA-2 per-item collapse, no cost output) —
  NOT the superseded `20260702000000` v1. Both correct owners.
- **Minimum-diff, byte-parallel `(4g)` change.** Both engines' `pending_po_qty`
  CTE is replaced identically with `select pit.item_id, sum(0)::numeric ... from
  public.po_items pit where false group by pit.item_id`. I diffed against the base
  bodies: the original CTE (`20260718000000:244-254` and `20260704000000:1266-1276`)
  was `sum(greatest(0, ordered-received)) ... join purchase_orders ... where status
  in ('sent','partial') and received_at is null`. The replacement drops the join +
  predicates in addition to flipping to `where false`. This is slightly more than
  the "only the predicate flips" phrasing in design §1 and the migration header
  comment claims — the `join public.purchase_orders` is also removed — BUT it is
  the exact form the architect wrote in the design §1 code block, and it is
  semantically equivalent (no rows either way) and cleaner (no dead join). Not
  drift; the header-comment wording is just imprecise. **Minor.**
- **Downstream references preserved.** `left join pending_po_qty ppq on
  ppq.item_id = ioh.item_id`, all three `coalesce(ppq.pending_po_qty, 0)` sites
  (output key line 537 / `par_replacement` / `usage_forecasted`) on the admin
  engine, and the two on the counted engine, are textually intact. Output column
  shape (`item_id`, numeric `pending_po_qty`) and `group by pit.item_id`
  preserved, so join column types are unchanged.
- **Envelope stability.** `report_reorder_list` keeps `'pending_po_qty',
  pif.pending_po_qty` in the per-item object (now constant 0). `report_reorder_for_counted_onhand`
  never surfaced the key (internal-only), flat item envelope unchanged. Both keep
  auth gate, `security invoker`, `set search_path = public`, byte-identical
  signatures (ACLs preserved via `CREATE OR REPLACE`).
- **Statement separation.** Two independent `CREATE OR REPLACE FUNCTION ... ;`
  statements separated by a banner comment. No transaction wrapper needed; no
  DROP anywhere.

Matches the OPTION A ruling verbatim.

## 3. `upsertVendorDraftOrder` — CONFIRMED MATCHES §4 CONTRACT

`src/lib/db.ts:1641`:

- **Draft-only `(store, vendor, date)` match.** Select filters `.eq('status',
  'draft')` plus store/vendor and an explicit `reference_date` match (`.eq(date)`
  when supplied, `.is(null)` otherwise so a null-dated legacy draft never collides
  with a dated Fill-cart key). A `'sent'` PO for the same key is never returned →
  the INSERT path fires → a fresh draft, exactly per §4 ("A 'sent' PO ... is a
  placed order — do NOT mutate it; create a new draft").
- **Per-counted-unit snapshot.** `po_items.cost_per_unit = ln.costPerUnitCounted`;
  the caller (`fillCartForVendor`, `useStore.ts:2887`) computes it as `it.costPerUnit
  * subUnitSize` — the spec-104 per-each → per-counted-unit ★ bridge, same basis
  as `createPoDraft`. `total_cost = Σ orderedQty × costPerUnitCounted`.
- **`expected_delivery` omitted with the starvation rationale documented.** The
  INSERT payload has no `expected_delivery` key (line 1714-1722) with an inline
  `NB:` marker, and the function doc comment (`:1630-1633`) spells out the spec-125
  auto-receive-inert-by-starvation reasoning and a "Do NOT add an `expected_delivery`
  here" guard. Exactly design §2/§4.
- Idempotent update path deletes + reinserts `po_items` and updates `total_cost`;
  insert path cleans up an orphan header if line insert fails; returns `poId` or
  `null` on empty lines / RLS denial / insert failure (§4 error contract). Runs
  inside `useInflight().track` with an abort signal — consistent with the rest of
  `db.ts`, stays inside the centralized DB layer (no carve-out violation).

## 4. Extension RPC surface — CONFIRMED BYTE-UNTOUCHED

`get_pending_extension_orders` / `get_extension_order_payload` live only in
`supabase/migrations/20260723000000_extension_ordering.sql` (and the unrelated
`20260724000000` product-page-url column migration). The spec-138 migration adds
no `CREATE OR REPLACE` for either RPC and no new migration edits that file. The
handoff reuses them purely by writing a `draft` row they already read. Zero
extension churn, per AC-10 and the out-of-scope guard.

## 5. Dormant-not-dropped posture — CONFIRMED

- The migration contains no `DROP FUNCTION` / `DROP TABLE` and no reference to
  `receive_purchase_order` / `auto_receive_*` / cost-on-receipt / the staff
  price-gate RPC (grep: 0 matches). It is purely two `CREATE OR REPLACE`s of
  read RPCs.
- `ReceivingSection.tsx`, `POsSection.tsx`, and staff `Receiving.tsx` remain on
  disk (unmounted from the sidebar / StaffStack, per the frontend Files-changed).
- Auto-receive stays inert by starvation, not by a drop: with the PO tab's
  `createPoDraft` call removed and `upsertVendorDraftOrder` omitting
  `expected_delivery`, no live path sets `expected_delivery`, so the spec-125 cron
  has nothing to act on. Matches design §2/§6.

---

## Minor findings (advisory, non-blocking)

- **M1.** The migration header comment and design §1 describe the `(4g)` change as
  "only the predicate flips to `where false`," but the implementation also drops
  the `join public.purchase_orders` and its store/status/`received_at` predicates.
  This is the exact form the architect specified in the design §1 code block and is
  semantically equivalent, so it is not drift — but the "only the predicate flips"
  wording in the migration comment (`:36-37`, `:871-872`) slightly understates the
  edit. Cosmetic; safe to leave.
- **M2.** `clearReorderEdits()` resets on as-of-date change in addition to store
  switch, which is broader than the cited spec-135 `expandedKeys` precedent (store
  switch only). This is the intended AC-7 behavior, flagged only so the
  "mirroring spec-135" framing isn't read as literal parity.

No Critical, no Should-fix. The AC-7 revert, the two-engine migration, the
`upsertVendorDraftOrder` contract, the untouched extension RPCs, and the
dormant-not-dropped posture all land as designed.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor
  (both cosmetic/wording, non-blocking). AC-7 revert, two-engine migration,
  upsertVendorDraftOrder contract, untouched extension RPCs, and the
  dormant-not-dropped posture all match the design + OPTION A ruling.
payload_paths:
  - specs/138-reorder-only-retire-po-receiving/reviews/backend-architect.md
