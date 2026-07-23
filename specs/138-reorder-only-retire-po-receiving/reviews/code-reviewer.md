# Code review for spec 138

Scope: ReorderSection inline-editing integration, `reorderEdits` buffer semantics
and the frontend's correction of the backend's `loadFromSupabase` reset,
`upsertVendorDraftOrder` in `db.ts`, Fill-cart gating, the `OrderingSection`
history panel, the retirement wiring (cmdSelectors / InventoryDesktopLayout /
StaffStack / sidebarLayout REMOVED_SIDEBAR_IDS / palette), the migration SQL,
and dead-code status of `POsSection.tsx`.

## Critical

None found. No direct `supabase.from/rpc` calls introduced outside `db.ts`, no
legacy-file re-creation, no `app.json` slug touch, no raw `window.confirm` /
`Alert.alert`, no forked `poCaseDisplay` conversion logic, no new realtime
channel, and the two `CREATE OR REPLACE`s in the migration are non-destructive
with signatures preserved.

## Should-fix

- `src/lib/db.ts:1687-1709` (`upsertVendorDraftOrder` UPDATE path) — the
  existing-draft branch does **delete all `po_items` → reinsert → update
  `total_cost`** as three sequential round-trips with no compensating action.
  If `reinsertErr` fires (line 1700) after `delErr` already succeeded (line
  1694), the function returns `null` (so the operator sees a "Fill cart
  failed" toast) but the previously-filled draft is now left with **zero
  lines** — a silent regression of a prior successful Fill-cart. Contrast with
  the INSERT path a few lines down (1732-1740) and with
  `createPurchaseOrderDraft` (1605-1609), both of which best-effort clean up
  the orphan on a lines-insert failure. The UPDATE path has no equivalent
  remediation (e.g., re-inserting the deleted rows on `reinsertErr`, or
  ordering insert-then-delete instead of delete-then-insert so a failure
  leaves the OLD lines intact rather than none). Worth a follow-up: insert the
  new lines first, then delete the old ones only after the insert succeeds,
  so a mid-operation failure never leaves the draft empty.

- `src/screens/cmd/sections/POsSection.tsx` — the spec's Design §6
  ("Dormant-not-dropped backend") and the backend Files-changed section both
  describe this file as "left on disk, unmounted." That's not accurate:
  `src/screens/cmd/sections/VendorsSection.tsx:9,444` still imports and
  renders `POHistoryTab` (a named export of `POsSection.tsx`) inside the
  Vendors detail screen, which IS live and mounted. Only the file's
  `export default function POsSection()` (the case-editor / CreatePoButton
  tab UI) is unmounted; `POHistoryTab` and its `useOrderingHandoff` import (in
  the default export only) are unaffected but the file as a whole is not dead.
  This matters because a future "cleanup spec" that deletes `POsSection.tsx`
  wholesale on the strength of this spec's "unmounted" claim would silently
  break the Vendors page's PO-history tab. Please correct the claim (or note
  the carve-out) so the next cleanup pass doesn't trust it at face value.

- Missing jest coverage for `upsertVendorDraftOrder` / `fillCartForVendor`'s
  core branching. Design §12 (jest / AC-14) explicitly calls for: "create when
  no draft, update the existing draft when one exists, new draft when only a
  `'sent'` exists, `expected_delivery` omitted (mock db)." Grepping the repo
  turns up no such test — `fillCartForVendor` / `upsertVendorDraftOrder` only
  appear as `jest.fn()` stubs inside the various `ReorderSection.*.test.tsx`
  mocked-store states, never exercised against the real store action or the
  real (mocked-`supabase`) db helper. The three-branch idempotency logic in
  `db.ts` (find-existing-draft / replace-lines / insert-fresh, keyed on
  `status='draft'` + `reference_date`) and the omit-`expected_delivery`
  invariant are exactly the kind of logic that regresses silently without a
  test pinning it. Primarily test-engineer's call, but flagging since the
  spec's own test plan promised this and it isn't there.

## Nits

- `src/screens/cmd/sections/ReorderSection.tsx:1282-1284` — `subUnitSizeFor`
  already falls back to `1` (`?.subUnitSize || 1`), and the one call site
  inside `applyReorderEdits` (line 107) re-applies `|| 1` on top of the
  callback's return value (`subUnitSizeFor(item.itemId) || 1`). Harmless
  (subUnitSizeFor never returns a falsy non-1 value) but redundant — drop one
  of the two fallbacks for clarity.
- `src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx:8-10` —
  the file-header comment still describes the retired "+ CREATE PO becomes a
  disabled PO CREATED chip" behavior even though the `describe` block it
  refers to (line 277 onward) was rewritten to the spec-138 Fill-cart
  extension-gating behavior. Update the header so it doesn't describe removed
  behavior.
- `e2e/reorder.spec.ts:69-84` (out-of-scope, pre-existing) — the "defensive"
  export-buttons check reads `page.getByTestId('reorder-export-csv')`
  (no vendor suffix), but the real testID has been per-vendor
  (`reorder-export-csv-${vendor.vendorId}`) since spec 123. `exportVisible` is
  therefore always `false` and the enabled-state assertions never run. Not
  introduced by spec 138 (this file was only touched for the sidebar-nav
  click change per the Files-changed notes), but worth a follow-up since the
  test silently stopped covering what its comments say it covers.
- `src/store/useStore.ts:2883` (`fillCartForVendor`) —
  `edits[it.itemId] ?? (it.suggestedUnits || it.suggestedQty || 0)`
  re-derives the same override `applyReorderEdits` already baked into
  `vendor.items[*].suggestedUnits` upstream (the `vendor` passed in is already
  buffer-overlaid). It's harmless — both paths agree — but it's a second,
  independent implementation of the same "buffer overrides suggestion" rule.
  A one-line comment noting this is intentionally defensive (so
  `fillCartForVendor` is correct even if a future caller passes a
  non-overlaid vendor) would save the next reader a double-take.

## What's solid (no finding, noted for context)

- `applyReorderEdits` (ReorderSection.tsx:95-119) is pure, returns the input
  vendor unchanged when there's no edit (verified by test), and the
  per-each→per-counted-unit bridge (`base × costPerUnit × subUnitSize`)
  matches the spec-104 convention and `createPoDraft`'s established bridge
  exactly — jest-pinned against a `subUnitSize > 1` case row.
- `reorderEdits` buffer semantics: `loadFromSupabase` (useStore.ts:1314-1321)
  correctly does NOT clear the buffer (the frontend's documented revert of
  the backend developer's original line), and the reset instead lives in
  `ReorderSection`'s store-switch/date-change effect (lines 1311-1331),
  mirroring the spec-135 `expandedKeys` precedent. The two developers'
  halves converge coherently — the in-code comments on both sides
  cross-reference each other and agree on the final shape.
- `upsertVendorDraftOrder`'s INSERT path and idempotency key (store, vendor,
  `status='draft'`, `reference_date`) match Design §4 exactly, including the
  documented `expected_delivery` omission (keeps spec-125 auto-receive inert
  by starvation).
- Fill-cart gating (`FillCartButton`) is confirm-gated via `confirmAction`
  (no raw `window.confirm`/`Alert.alert`), renders `null` for
  non-`extensionOrdering` vendors, uses only `useCmdColors()` tokens (no
  inline hex), and hooks are called unconditionally before the early return.
- Migration `20260726000000_reorder_drop_inbound_term.sql` is a clean
  minimum-diff `CREATE OR REPLACE` on both engines (`where false` /
  `sum(0)`), leaves every downstream `coalesce(...)` reference, `has_po`
  EXISTS, and auth gate textually intact, and is exercised by both a new
  pgTAP file and updated `po_loop.test.sql` cases with the byte-parity guard
  retained.
- Sidebar retirement wiring (`cmdSelectors.ts`, `InventoryDesktopLayout.tsx`,
  `StaffStack.tsx`, `sidebarLayout.ts` `REMOVED_SIDEBAR_IDS`) is complete and
  consistent — no dangling `Receiving` references, `remapLegacySidebarOverrideIds`
  is unit-tested for the remove-only path, and `ReceivingSection.tsx` /
  `orderingHandoff.ts` are confirmed genuinely unmounted (unlike `POsSection.tsx`,
  see Should-fix above).
- i18n coverage for the new `section.reorder.fillCart*` / `history*` /
  `orderedLabel` keys is complete across `en` / `es` / `zh-CN`.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 3 Should-fix, 4 Nits.
payload_paths:
  - specs/138-reorder-only-retire-po-receiving/reviews/code-reviewer.md
