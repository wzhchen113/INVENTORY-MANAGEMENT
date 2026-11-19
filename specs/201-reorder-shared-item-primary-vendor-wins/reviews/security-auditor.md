## Security audit for spec 201

Scope: the staged spec 201 changes only. I read each file with `git diff --cached -- <path>`. Files reviewed:
- `supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql` (diffed hunk by hunk against the 20261024000000 L319-999 baseline);
- `supabase/migrations/20261118120100_set_item_primary_vendor.sql`;
- `supabase/tests/set_item_primary_vendor.test.sql` (authz arms);
- `src/lib/db.ts` (staged hunks), `src/screens/staff/lib/fetchReorder.ts`, `src/types/index.ts`;
- `src/store/useStore.ts`, `src/screens/cmd/lib/primaryVendorSwitch.ts`;
- the UI diffs in `ReorderSection.tsx`, `PhoneOrdering.tsx` and staff `Reorder.tsx`.

I checked live posture against the local DB (`supabase_db_imr-inventory`, where both migrations are applied):
- `pg_proc` ACL, `prosecdef` and `proconfig`;
- `pg_policies` on every table the new code reads or writes;
- the trigger security mode on `inventory_items` and `item_vendors`;
- the normalized md5 of `set_item_primary_vendor`, which matches the file.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low

- **`supabase/migrations/20261118120100_set_item_primary_vendor.sql:87-91`: the "admin only" gate covers only this RPC. The tables underneath are still writable by staff (pre-existing; not introduced here).**
  - **What the gate does.** `auth_is_privileged()` correctly makes the RPC admin-only.
  - **Why it isn't a full boundary.** The RPC is `SECURITY INVOKER`, and its writes go through the existing permissive policies. Both `store_member_update_inventory_items` and `store_member_update_item_vendors` are gated only by `auth_can_see_store(...)`. So any `role = user` store member can still set `inventory_items.vendor_id` / `item_vendors.is_primary` with a direct PostgREST PATCH. Staff users of the in-repo staff app are such members. A raw `is_primary` flip still hits the `item_vendors_one_primary_per_item` index, but a demote-then-promote pair or a `vendor_id`-only PATCH does not.
  - **Impact.** Low. A staff member could move which card a shared item lands on during a coincident day, or cause `vendor_id` / `is_primary` drift. The same policies already let them edit par, stock and cost. No cross-store or cross-brand reach.
  - **Doc correction.** Design §5.1 reason 4 ("'Admin only' is enforced server-side") is true of the switch path only. It must not be cited later as proof that primary-vendor changes are admin-gated.
  - **Fix.** Don't block 201. If the owner wants a real boundary, a follow-up spec could add a `RESTRICTIVE` UPDATE policy, or a column-level guard trigger on `inventory_items.vendor_id` / `item_vendors.is_primary` that requires `auth_is_privileged()`. Run `pg_policies` first, per the CLAUDE.md permissive-OR rule. Also check that the staff app never writes these columns.

- **`supabase/tests/set_item_primary_vendor.test.sql:164-200`: two authz principals are untested.**
  - **What's covered.** A `role = user` member (expects 42501, no write) and a master principal.
  - **Gap 1, cross-brand admin.** No arm covers an `admin` whose brand can't see the item's store. Expected: P0001 `'item not found'`, because RLS hides the row at step 3. Step 4's `'caller cannot see store'` is therefore effectively unreachable. That's fine as defense-in-depth, but the cross-brand denial path isn't pinned.
  - **Gap 2, super_admin.** No arm covers a `super_admin`, whose role comes from `profiles.role` through `auth_is_super_admin()` and not the JWT. This is the spec 026/027 parity concern.
  - **Fix.** Add one cross-brand admin arm (P0001, nothing written) and one super_admin arm (succeeds) in a follow-up.

- **`supabase/migrations/20261118120100_set_item_primary_vendor.sql:131-146`: the in-transaction 3c re-check narrows the race but doesn't close it.** Not a security boundary; recorded because the header and §5.1 reason 3 say it "closes the client pre-check TOCTOU".
  - **Why.** Under READ COMMITTED, a concurrent FILL CART that hasn't committed its `po_items` insert is invisible to the `exists(...)`. The `FOR UPDATE` lock on `inventory_items` doesn't serialize against `po_items` inserts.
  - **Impact.** The rare stale draft line that spec 201's Residual risk already describes. No authz impact.
  - **Fix.** Optional: reword the comment to "narrows". If owners want it closed, also take `FOR UPDATE` on the matching `purchase_orders` row(s) before the check.

### Verified, no finding

**`report_reorder_list` (20261118120000)**
- **Posture unchanged.** `prosecdef = f`, `proconfig = {search_path=public}`. The ACL is `postgres, authenticated, service_role` with no `anon` and no PUBLIC (`=X`) entry, so the `reports_anon_revoke` state is preserved by `create or replace` without re-emitting grants.
- **Gate unchanged.** The `auth_can_see_store(p_store_id)` gate is still the first statement.
- **No cross-store leak in the borrow source (B1).** It reads only `latest_eod_per_vendor`, which filters `s.store_id = p_store_id`, `s.date = v_as_of_date` and `s.status = 'submitted'`. B2 joins it to `inventory_items ii` with `ii.store_id = p_store_id`. `eod_entries_check_store` also keeps another store's item ids out of a store's submission.
- **The new CTEs are store-scoped and invoker-RLS'd.** `order_out_today` filters `os.store_id = p_store_id`. `item_primary_wins` filters `ii.store_id = p_store_id`. Vendor names (`yielded_from_vendors`, `on_hand_borrowed_from`) come from `public.vendors` under `brand_member_read_vendors`; the left and inner joins mean a hidden vendor yields null or no row, never a leaked name.
- **No new visibility for staff callers.** Borrowed counts come from the same store's submissions, which `store_member_read_eod_entries` / `_eod_submissions` already expose to the caller.
- **No dynamic SQL and no `EXECUTE`.** The new `p_params` reads are only the existing `as_of_date` / `include_stocked` casts.

**`set_item_primary_vendor` (20261118120100)**
- **Posture.** `SECURITY INVOKER` with pinned `search_path = public`. The ACL is `postgres, authenticated, service_role`: revoked from PUBLIC and anon, granted to authenticated.
- **Every guard fires before any write:** null-arg (22023), `auth_is_privileged()` (42501), row lock / not-found (P0001), `auth_can_see_store` (42501), link exists (P0001), no-op, then 3c (P0001).
- **`auth_is_privileged()` = `auth_is_admin()` (JWT admin or master) OR `auth_is_super_admin()`.** All three privileged roles are admitted; no spec 026/027 regression.
- **RLS ↔ gate symmetry.** The `item_vendors` UPDATE/SELECT policies resolve through `inventory_items.store_id` → `auth_can_see_store`, the same predicate as gate 4. A caller who passes the gates can't hit a silent 0-row demote or promote while the scalar update succeeds, so RLS can't cause `vendor_id` / `is_primary` drift.
- **Triggers are SECURITY INVOKER except the tombstone pair.** The definer triggers fire on insert and delete only, and this RPC does neither. `trg_item_vendor_changed_at` is invoker.
- **Error strings carry no SQL fragments, row data or PII.** "Item not found" covers both nonexistent and RLS-hidden rows, so it is not an existence oracle.
- **The self-guard and last-of-role conventions don't apply.** No profile is targeted and nothing is deleted.

**Client**
- **`db.ts` and the staff mapper.** Both mappers use `String(...)` coercion. `setItemPrimaryVendor` uses `supabase.rpc` with bound params. `isItemOnOpenOrder` uses PostgREST filter builders with no string-built filters.
- **Staff carve-out.** `fetchReorder.ts` is a mapper-only change inside the documented staff carve-out.
- **No client-side security boundary.** No new code uses `useRole()` as a boundary; the switch's authorization is the server gate. On a non-privileged caller the switch fails closed (42501 → `notifyBackendError` + revert). The PhoneApproveOrder `footer === 'none'` hiding is UX only, not a boundary, which is acceptable.
- **No injection path in rendering.** Vendor and item names render through React Native `<Text>` / `T()` interpolation and `confirmAction` (`window.confirm` / `Alert.alert`). None of these is an HTML sink, and there is no `dangerouslySetInnerHTML`.
- **No secrets.** `notifyBackendError` receives only the PostgREST error object: stable strings, no tokens, no PII.

**Out of scope for this spec:** edge functions (none touched), `config.toml`, realtime publications (none changed) and `EXPO_PUBLIC_*` variables (none added).

### Dependencies
No `package.json` or `package-lock.json` changes, staged or unstaged, so `npm audit` was skipped.
