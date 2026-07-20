# Spec 131 — Backend-architect drift review (post-implementation)

Reviewer: backend-architect (post-impl mode)
Verdict: **No Critical drift.** The implementation faithfully realizes the D-2/D-3/D-4/D-7 contract. Two flagged deviations ruled below; one Should-fix handoff to spec 132; three Minor notes.

Files inspected against the design:
`supabase/migrations/20260723000000_extension_ordering.sql`, `src/lib/db.ts`
(vendor threading + item_vendors embed/mappers + `markPurchaseOrderSent`),
`src/utils/poQuickOrderText.ts`, `src/components/cmd/IngredientForm.tsx`,
`src/types/index.ts`, `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql`,
`supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql` (schema
cross-check), `src/i18n/{en,es,zh-CN}.json`.

---

## Rulings on the two flagged deviations

### (a) Migration filename `20260723000000` instead of design's `20260720000000` — RULING: ACCEPTABLE, no action

Confirmed on disk: `20260720000000_staff_reports_issue_notifications.sql`,
`20260721000000_ingredient_photos.sql`, `20260722000000_ingredient_changed_badge.sql`
all exist; `20260723000000` is the genuine next-free slot. The design's slot
assertion was simply stale (tree moved on between design and build). The migration
body is byte-for-byte the design's intent: 3 additive columns + 2 SECURITY INVOKER
RPCs, no policy/publication change. The prod-apply block (header lines 90-106)
correctly updates the `schema_migrations` version string to `20260723000000`
throughout. This is a filename bump only, not a contract change. Nothing to fix.

### (b) `item_vendors.product_page_url` EDITOR field built in `IngredientForm` despite D-2/D-13 deferring it — RULING: **KEEP**

The developer surfaced a real spec-internal contradiction: design D-2/D-13 say
"NOT built here / spec-132 follow-up," while the build task item 4 explicitly
directed building it "per design." Resolving toward the explicit task instruction
was the right call, and keeping it is correct on the merits:

- **Harmless + additive.** The field is threaded identically to spec-114's
  `order_code` (an established, reviewed pattern): `FormValues` /
  `VendorLinkRow.productPageUrl` (IngredientForm.tsx:82,192), `blank()` seed (:223),
  `updateVendorLinkField` union widened (:242), `vendorRowsToLinkPayload`
  empty→`undefined`→NULL (:275), handler + per-vendor `InputLine` (:900,1321-1326).
  Nullable column, no backfill, no RLS/behavior change.
- **The column + read-mapper stay either way** (D-7 required them, and they are
  present: db.ts:240 embed, :5232/:5246 hydration, create/update upserts :376/:522).
  Reverting only the editor hunks would leave the column populated exclusively by
  direct DB writes — a strictly worse operator experience with no offsetting benefit.
- **It does not harm spec 132.** 132 consumes the column; having the editor already
  wired is a head-start, not a conflict.

**One condition on the KEEP (handoff to spec 132):** spec 132's builder MUST NOT
re-build this editor field — it already exists. Note it in the 132 build brief to
avoid a double-build. Also note the i18n keys `section.inventory.productPageUrl*`
(×3, confirmed present in all locales) now live in the 131 catalog delta, not 132 —
a bookkeeping detail, not a defect.

---

## Contract verification (design vs implementation)

### RPC shapes — MATCH the D-3 contract exactly ✓

- `get_pending_extension_orders(p_vendor_id uuid default null)` → jsonb array of
  `{ poId, storeId, vendorId, vendorName, orderPageUrl, orderUnit, lineCount, unmappedCount }`,
  pending = `status='draft' AND v.extension_ordering`, `p_vendor_id` NULL → all,
  never errors, `[]` on empty. SECURITY INVOKER, `set search_path = public`, revoke
  public/anon, grant authenticated. Matches D-3 RPC 1 field-for-field.
- `get_extension_order_payload(p_po_id uuid)` → `{ poId, storeId, vendorId,
  vendorName, orderPageUrl, orderUnit, lines: [{ itemId, itemName, orderCode /* nullif
  blank */, orderedQty /* verbatim po_items.ordered_qty, NOT case-converted */,
  caseQty, productPageUrl }] }`. P0002 not-found / 42501 store-not-visible gate
  (plpgsql, INVOKER). Matches D-3 RPC 2 field-for-field.
- The unmapped line is surfaced (`orderCode: null` via `nullif(btrim(...),'')`),
  never dropped (left join on `item_vendors`). AC-4 honored. RPC 1's `unmappedCount`
  predicate (null-or-blank code, or no link) is consistent with the `computePoQuickOrderLines`
  "unmapped" definition (blank/absent code). ✓

### D-1 single-builder invariant — PRESERVED ✓

`computePoQuickOrderLines` (poQuickOrderText.ts:128) is the one case-math/code-resolution
core; `buildPoQuickOrderText` (:212) now derives its text from it and its per-line
format is byte-identical (`<code>\tqty` / `??? <name>\tqty`). The RPC does NOT ceil
in SQL — it returns raw `orderedQty` + `caseQty` + `orderUnit` and the shared builder
does the spec-115 ceil at the extension entry point. No forked builder. AC-5 held.
The existing `buildPoQuickOrderText` byte-pins are unaffected (signature + output
unchanged). Reported green in the build notes (122 suites / 1318 tests).

### Mark-ordered semantics + spec-120 trigger guard — verified, with a caveat (see Should-fix)

- OQ-2 resolved to reuse `status draft→'sent'` (no new column) — consistent with
  the design D-4 rationale (keeps the spec-107 reorder loop closed; an `ordered_at`
  marker would leave the PO in `draft` and re-trigger the double-order bug). Correct.
- **spec-120 duplicate-notification guard CONFIRMED present:**
  `20260715000000_submission_notifications.sql:256` guards
  `(tg_op = 'INSERT' or old.status is distinct from 'sent')`, so a sent→sent replay
  emits no duplicate `po` notification. The design's belt-and-suspenders requirement
  is satisfied by the trigger itself.

---

## Should-fix

### S-1. AC-6 idempotency/no-resurrection is guaranteed by the TRIGGER guard, not the UPDATE guard — spec 132's extension UPDATE must carry `and status='draft'` itself

Design D-4 attributed AC-6's idempotency + no-resurrection to "the `and status='draft'`
guard the extension uses." But the in-app reuse path — `db.ts markPurchaseOrderSent`
(db.ts:1768-1778) — is `update purchase_orders set status='sent' where id = :poId`
with **no** `and status='draft'` guard. Consequences:

- **In-app path:** a re-mark of an already-`sent` PO still executes the UPDATE
  (touches the row sent→sent); it is saved from a duplicate notification ONLY by the
  spec-120 trigger's `old.status is distinct from 'sent'` WHEN clause (confirmed).
  More notably, this pre-existing helper can transition a `received`/`partial`/
  `cancelled` PO back to `sent` — the exact resurrection D-4 claimed the guard
  prevents. This is **pre-existing spec-107 behavior**, not introduced by 131
  (131 correctly did not modify this helper), and the in-app "mark as sent" button
  is only surfaced on draft POs — so it is not a live regression here. Flagging it
  so the AC-6 observable is understood correctly, not attributed to a guard that
  isn't on the in-app path.
- **Extension path (spec 132):** the AC-6 "idempotent + cannot resurrect" observable
  depends entirely on spec 132's own UPDATE carrying `and status='draft'`. The
  extension MUST NOT reuse `markPurchaseOrderSent` verbatim (unguarded) — it must
  issue `update ... set status='sent' where id=:id and status='draft'`. **Carry this
  as an explicit spec-132 build requirement.** Recommend the pgTAP for the guarded
  UPDATE (design D-12) assert the guarded shape, not the unguarded helper.

---

## Minor

### M-1. `apply_item_vendors_to_brand` does not propagate `product_page_url` — follow-up (correctly flagged)

Confirmed: the upsert in `20260714000000_apply_item_vendors_to_brand.sql:136-146`
handles `order_code` only; there is no `product_page_url` column in its INSERT/
DO-UPDATE. So "Apply vendors to all stores" copies order codes but not product-page
URLs. Low severity: for v1 the column is populated ad-hoc/direct-DB and consumed
opportunistically by the extension. Threading it would touch that SECURITY DEFINER
RPC (a migration surface 131 did not scope). Accept as-is; the build's follow-up
flag is accurate. Recommend it ride the same spec-132 follow-up that owns the
column's operator workflow.

### M-2. RPC 2 caseQty/name source — implementation is MORE correct than the design text (no action)

Design D-1/D-3 pseudocode said `caseQty (inventory_items.case_qty)` and implied the
name from `inventory_items`. The implementation instead joins
`inventory_items → catalog_ingredients` and reads `ci.name` + `coalesce(ci.case_qty,1)`
(migration lines 245,251-253). This matches the post-brand-catalog schema and the
existing reorder RPC (`20260630000100_report_reorder_list_multi_vendor.sql:418,437,440`
— "catalog_ingredients for the item name since inventory_items.name [is deprecated]").
The design text was stale; the implementation resolved it correctly. Positive
deviation, no action.

### M-3. RPC 2's explicit `42501` gate is effectively unreachable under INVOKER RLS (harmless defense-in-depth)

Because the function is SECURITY INVOKER, the initial `select po.store_id ... where
po.id = p_po_id` is already RLS-bounded: a PO in an invisible store returns 0 rows →
`v_store_id is null` → `P0002` fires first, before the `auth_can_see_store` check can
raise `42501`. The `42501` branch only differs if the `purchase_orders` SELECT policy
were ever broadened wider than `auth_can_see_store`. This is exactly the belt-and-
suspenders posture the design asked for (mirroring `receive_purchase_order §3`) —
noted so a test author does not write a case expecting `42501` from a simple
non-member read (they'll get `P0002`). No change needed.

### M-4. `computePoQuickOrderLines` now invokes `resolveName` for EVERY line (was unmapped-only) — byte-identical, intentional

The extracted core resolves the name for all lines so the structured payload always
carries it (poQuickOrderText.ts:163-165); the text blob still emits it only on the
unmapped path, so `buildPoQuickOrderText` output is byte-identical. `resolveName` is
a pure lookup (no side effects, cheap), so the extra calls are immaterial. Intentional
and correct; noted only so it isn't mistaken for a behavior change.

---

## Summary

- Critical: 0
- Should-fix: 1 (S-1 — extension mark-ordered UPDATE must self-carry `and status='draft'`; the shared `markPurchaseOrderSent` is unguarded — spec-132 build requirement)
- Minor: 4 (M-1 apply-to-brand non-propagation follow-up; M-2 caseQty source is more-correct-than-design; M-3 unreachable 42501 branch; M-4 resolveName-per-line)
- Deviation (a) migration filename: ACCEPTABLE, no action.
- Deviation (b) product_page_url editor field: KEEP (condition: spec 132 must not re-build it).

The backend contract (columns, RLS inheritance, both RPC shapes + auth boundary,
status→sent reuse, shared-builder invariant, realtime-restart absence) landed as
designed. No RLS gap introduced; nothing bypasses the intended surfaces; AC-7
never-check-out invariant is intact (RPCs read only I.M.R data).
