# Security audit for spec 138

Reviewed: the one migration (`20260726000000_reorder_drop_inbound_term.sql`), the
new `upsertVendorDraftOrder` db helper + `fillCartForVendor` store action, the
`reorderEdits` buffer, the extension-RPC contract, and the admin/staff UI
retirement (sidebar, palette, dispatch, staff nav). Scope owned: auth, authz,
secrets, validation, dependencies. No package.json change — dependency audit
skipped.

**Verdict: no Critical, no High, no Medium, no Low security findings.** The
implementation holds the line on every item the task flagged.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- None.

### What was verified (clean)

**Migration SECURITY posture / grants / search_path unchanged.**
- `report_reorder_list(uuid, jsonb)` — new body header (`20260726000000:42-46`)
  is byte-identical to its latest-owner header (`20260718000000_reorder_list_has_po.sql:14-18`):
  `LANGUAGE plpgsql SET search_path TO 'public'`, default SECURITY INVOKER. The
  only diff is the `(4g) pending_po_qty` CTE (`20260726000000:269-275` vs
  `20260718000000:244-254`) flipping to `where false` / `sum(0)`. Auth gate
  (`auth_can_see_store`, `:57-60`), `has_po` EXISTS (`:603-610`), and the
  `left join pending_po_qty` + three `coalesce(ppq.pending_po_qty,0)` references
  are textually preserved. Signature byte-identical → ACLs preserved.
- `report_reorder_for_counted_onhand(uuid, jsonb, jsonb)` — new body header
  (`20260726000000:697-705`) is byte-identical to its latest-owner header
  (`20260704000000_po_loop.sql:1087-1095`): explicit `security invoker`,
  `set search_path = public`. Only the `(4g)` CTE changed (`:874-880` vs
  `20260704000000:1266-1276`). Auth gate preserved (`:716-719`). Signature
  byte-identical → ACLs preserved.
- Non-destructive: no table/column/index/policy/grant/publication change, no
  RLS touched. Both are `CREATE OR REPLACE` of SECURITY-INVOKER read RPCs.

**`upsertVendorDraftOrder` (db.ts:1641-1744) respects RLS, no service-role.**
- Uses the anon RLS-enforced `supabase` client throughout — no service-role key,
  no `Deno.env`/`process.env` secret access. Stays inside the sanctioned `db.ts`
  layer (`track()` + carve-out rules honored).
- Store-scoped writes only: insert/update/delete on `purchase_orders` /
  `po_items` are gated by `store_member_insert/update/delete_purchase_orders`
  (`20260504173035_per_store_rls_hardening.sql:186-201`, all
  `auth_can_see_store(store_id)`) and the `po_items` policies resolve to the
  parent PO's store. **Cannot write another store's draft:** an insert with a
  `store_id` the caller can't see is rejected by the WITH CHECK; the update path
  filters by `id` but the USING clause re-gates by store. The keyed select is
  RLS-filtered too.
- Input handling: empty `storeId`/`vendorId`/`lines` short-circuit to `null`
  (`:1653`); numeric coercion guards NaN in the total (`:1655-1658`). No dynamic
  SQL / string interpolation (PostgREST bound params only). `expected_delivery`
  correctly omitted (design §2 — keeps the retired auto-receive path starved).
- Error handling: `console.warn` logs only Supabase error messages — no tokens,
  keys, or row PII leaked.

**`fillCartForVendor` (useStore.ts:2866-2924) routes through db.ts, no bypass.**
- Calls `db.upsertVendorDraftOrder` (no raw `supabase.from/rpc` added). `storeId`
  read from `currentStore`, guarded against `__all__`. The only `supabase.from/rpc`
  calls elsewhere in `useStore.ts` (broadcast_notification, profiles dark_mode)
  are pre-existing, not spec-138 additions.

**Extension RPC auth model untouched.** `get_pending_extension_orders` /
`get_extension_order_payload` (`20260723000000_extension_ordering.sql`) last
modified in commit 02678ac (specs 131/132) and NOT referenced or replaced by the
new migration — byte-untouched. The Fill-cart path is a pure PostgREST upsert of
a `draft` `purchase_orders` row those RPCs already read; no signature/behavior
change, no new privileged surface.

**`reorderEdits` buffer holds only quantities.** Typed
`Record<string /*vendorId*/, Record<string /*itemId*/, number /*base units*/>>`
(useStore.ts:795, types/index.ts). No costs, PII, tokens, or credentials — just
per-session order-quantity overrides.

**Retired UI surfaces are truly unreachable.**
- Admin Receiving: dropped from `cmdSelectors.ts` OPERATIONS group and palette
  (no `Receiving`/`pos` entries remain); `InventoryDesktopLayout.tsx` has zero
  `Receiving`/`POsSection`/`ReceivingSection` references (dispatch branch + import
  removed). `OrderingSection.tsx` imports only `ReorderSection` — no `TabStrip`,
  no `POsSection`, so the PO editor UI is not mounted or deep-linkable.
- Staff Receiving: `StaffStack.tsx` has no `Receiving` `Tab.Screen` (only a
  comment). Removing a route does not widen staff access — it withdraws a UI
  surface; no policy or capability is granted.
- Sidebar-override fallback: `sidebarLayout.ts:84` `REMOVED_SIDEBAR_IDS =
  {'Receiving'}` filtered out in `remapLegacySidebarOverrideIds` (`:105`);
  `PurchaseOrders → Ordering` alias retained. A saved legacy layout resolves with
  no dangling/privileged entry.

**Secrets / PII.** No new `EXPO_PUBLIC_*`, no service-role key, no third-party
key introduced. The two `db.ts` secret-adjacent hits are pre-existing comments
(`:835`, `:3032`). History panel reads `orderSubmissions` via the existing
store-scoped `fetchRecentPurchaseOrders(storeId)` (RLS-enforced) — date/vendor/
total only, admin-visible store data.

### Dependencies
No package.json changes — skipped.
