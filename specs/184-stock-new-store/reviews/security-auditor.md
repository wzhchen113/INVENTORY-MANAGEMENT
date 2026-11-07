## Security audit for spec 184

**Result: 0 Critical, 0 High, 0 Medium, 5 Low. Nothing blocks.** I found no path where a non-privileged user, a store-scoped manager or another brand's admin can read another brand's preview data or write rows through either RPC. One stale-JWT case does pass every gate, but it grants nothing that caller's token doesn't already allow (L-2).

### How this was checked

- **Executed locally:** gate probes as simulated callers (`set local role authenticated` plus `request.jwt.claims`), each inside `begin read only ... rollback`, so no data could change. The write probe that passed the gates took the brand advisory lock until rollback.
- **Read, not executed:** the cross-brand conclusions. The local DB has one brand and no super-admin, and read-only transactions can't hold fixtures. Those conclusions rest on the function bodies, the live helper and policy definitions, and the assertions in `supabase/tests/stock_store_from_store.test.sql` (T-13, T-22 to T-27, T-30, T-30b, T-35). I read those tests but did not run them.
- **Not checked:** prod, including its policies and `max_rows`.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **L-1. `supabase/migrations/20261105000000_stock_store_from_store.sql:294-306` — the `'Store stocked'` audit action can be forged, and D-8 understates who can do it.** Any caller who passes `auth_can_see_store(store_id)` can insert this row through PostgREST with any `item_ref`, `detail` and `value`, so a fake "Copied 149 items" entry looks real.
  - **Non-privileged forger:** `audit_log_restrict_insert_actor_is_caller` forces `user_id` to be their own, so the row still names them. Probe P11 confirmed the permissive and server-only predicates pass for `manager@local.test`, and that the manager is not privileged.
  - **Privileged forger:** that policy's `OR auth_is_privileged()` arm lets them put another user's id on the row. D-8 doesn't mention this.
  - **Other brands:** with H1 still open (see Pre-existing), NULL-brand staff can self-grant a store in any brand and forge rows there. This is from reading the policy and `user_stores_brand_match`; I did not run it.
  - **Impact:** the log is misleading, but no data changes or leaks, and nothing in `src/` branches on this action beyond tone and kind. Other client-written actions have the same exposure.
  - **Fix:** D-8 is right that the server-only list would refuse this INVOKER writer, but that isn't the only option. A separate RESTRICTIVE policy, `action <> 'Store stocked' OR auth_is_privileged()`, still admits the RPC (it has passed G-1) and removes every non-privileged forger, including the H1 path. AC-20 rules out policy changes in this spec, so make it a follow-up. It would not stop a privileged forger.

- **L-2. `supabase/migrations/20261105000000_stock_store_from_store.sql:92,131,359,367` — a stale admin JWT on a `role='user'` profile that still has its brand passes every gate.**
  - **Proof:** probes P4 and P5 used `manager@local.test` (`role=user`, brand 2AM) with `app_metadata.role=admin`. The preview returned all 4 sources. The write passed every gate and failed only at its first INSERT, on the read-only transaction.
  - **Reachability is narrow:** `demote_profile_to_user` clears `brand_id`, so the normal demotion lands on G-7, which is the F-4 case. I found no app path that demotes and keeps the brand. It takes an out-of-band edit, or re-adding the user to a brand while the old token is still valid.
  - **Impact:** nothing new. The same token already passes `auth_can_see_store` arm (ii) and can read and insert these rows directly. The window is the token lifetime (`jwt_expiry = 3600` locally).
  - **Test gap:** T-26 only pins the null-brand case and only on the write. The preview has no stale-JWT case, though it uses the same G-7 check. Probe P6 (admin JWT, no profile row) was refused.
  - **Fix:** leave it to the queued M2 work on JWT versus profile role staleness.

- **L-3. `supabase/migrations/20261105000000_stock_store_from_store.sql:299` — the audit row shows the source store's name to staff who can't otherwise see that store.** `store_member_read_audit_log` lets any member of the target read `item_ref`, while `stores` RLS hides sibling stores from them (P11: the manager sees only Frederick and Towson). Same brand, and only a name and counts. The copied costs and pars also become readable at the target, which R-2 asks for. No change needed unless store names are considered sensitive.

- **L-4. `extension/src/background/service-worker.ts:146-147` — stocking copies `product_page_url` to another store, and the extension navigates to it with no origin check.** `item_vendors` has no CHECK constraint on the column, and `store_member_update_item_vendors` lets a store member edit it. `isSafeHttpUrl` blocks `javascript:` and `data:` but allows any http(s) host. So a member of the source store can plant a URL that, after stocking (migration line 244), opens in an admin's tab when they run the target store's order. The exposure already exists at the member's own store; spec 184 extends it to the stores stocked from it. `host_permissions` should keep the adapters from running script on another host, which limits this to a phishing page. **Fix:** a follow-up that requires `safeOrigin(url)` to match the adapter's origin before navigating.

- **L-5. `src/lib/db.ts:322-334` with `src/store/useStore.ts:2249` — paging lengthens a window where one user's rows can land under another user.** The stale-load guard compares only the store id, not the identity. If user A signs out and user B signs in on the same store while A's load is running, A's rows can reach B's slice until the next reload. A multi-page read can also mix pages from both sessions. This race exists today, and paging widens it only once a load passes 1000 rows. It needs a fast switch on a shared terminal. From reading the code; not reproduced. **Fix:** bump a generation counter on identity change and check it alongside the store id.

### Checked and found sound

**Gates and grants**
- **Non-privileged callers:** G-1 refuses a manager with `user_stores` rows on both stores, on both RPCs (P1, P2). A `user_metadata.role=admin` spoof is ignored (P3).
- **Grants:** `anon` and PUBLIC have no EXECUTE (P9, `proacl`). `service_role` has EXECUTE but is refused at G-1 without user claims (P10).
- **INVOKER safety:** the G-7 invariant holds against the live helper definitions. Privileged plus `auth_can_see_brand(b)` makes every store of `b` visible, so "carried by no store" can't under-count.
- **Search path:** `search_path = public`, every table reference is schema-qualified, `authenticated` has no CREATE on `public`, and there is no `EXECUTE` dynamic SQL. `format()` only receives integers.

**Cross-brand isolation**
- **Source and target:** G-6 refuses a mixed-brand pair. A `user_stores` row on another brand's store gets past G-4 but stops at G-6 or G-7 (T-26). A non-NULL-brand admin also can't create such a row (`user_stores_brand_match`).
- **Ticked catalog ids:** G-8 gives one message for foreign, missing and null ids, so there is no existence oracle (P8).
- **Vendor links:** only same-brand links enter `v_plan_links` (lines 184-187), and `vendor_id` is derived from those links (lines 205-209), so a foreign scalar can't carry over. Both predicates are explicit, so they also hold for a super-admin (T-30b).
- **Foreign-catalog rows at a source:** excluded by both RPCs (lines 166-167, 400-401).

**`stock_store_preview` leak check**
- **Scope:** every read is limited by `p_brand_id`: `brand_rows`, `items_no_vendor_link`, `carried_elsewhere_count` and `uncarried`.
- **No cross-brand signal:** "carried" counts only stores in that brand (lines 462-464), so another brand's rows can't change the list or reveal anything.
- **Existence oracle:** missing and foreign brands give the same 42501 (P7).
- **Same-brand staff:** they can already read catalog names (P12), but G-1 keeps per-store counts from them.

**Client and other surfaces**
- **`fetchInventory` filter injection:** none. The cursor comes from the server's own last row id (`db.ts:334`), and postgrest-js adds it through `searchParams.append`. A `gt` filter isn't parsed as a logic tree.
- **`fetchInventory` exposure:** no widening of what a caller is allowed to read. The select is the same string as before and RLS is unchanged. Rows that used to be cut off at 1000 were already readable by that caller.
- **New client reads:** D-15 shows vendor names only, not the customer-number map. No new code calls `supabase` directly from a component or uses `useRole`. The super-admin check in `BrandsSection` is UI only, and the server gate is the boundary (R-7).
- **Rendering and errors:** values render through React Native `Text`. RPC refusal messages are static.
- **Realtime:** no publication change. `item_vendors` is unfiltered, but subscribers are still subject to its `store_member_read_item_vendors` policy. `audit_log` isn't published.
- **Advisory lock:** taken after the gates, per brand, and bounded by `statement_timeout` and `lock_timeout`, so a refused caller holds nothing.
- **Destructive-action rules:** not applicable. Both RPCs only add rows.

### Pre-existing, for the owner

Spec 184 doesn't cause these, and none blocks it.

- **H1 is still open at repo head.** The `Users can manage own store links` policy is live on the local DB. NULL-brand staff can self-grant a store in any brand and read its rows, which now include whatever is stocked there. Both new RPCs refuse these users. The backlog guidance still applies: no staff invites with no stores ticked.
- **`pwa-catalog`** (`supabase/functions/pwa-catalog/index.ts:114`) returns `cost_per_unit` and `case_price` to the service-token holder, and a newly stocked store now returns rows there. This isn't a new auth path, but the design notes the PWA's handling wasn't checked, and that code isn't in this repo.

### For code-reviewer (not a security finding)

`src/lib/db.ts:333` assumes prod's `max_rows` is at least 1000. If it's lower, the first page comes back short, the loop stops, and the list is silently truncated as before. That contradicts F-2's "harmless at any value". Adding a check of the prod value to the runbook's Step 1 would settle it.

### Dependencies

No `package.json` or lockfile changes, so `npm audit` was skipped.
