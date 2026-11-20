# Spec 204: Only admins can change an ingredient's primary vendor, enforced in the database

Status: READY_FOR_ARCH

Numbering: 204 was reserved by the main session on 2026-11-19. Two parallel sessions are writing 202 and 203, so this spec doesn't use those numbers. No `204-*` file was on disk when this was written.

Origin: the first Low finding in spec 201's security audit ([specs/201-reorder-shared-item-primary-vendor-wins/reviews/security-auditor.md](201-reorder-shared-item-primary-vendor-wins/reviews/security-auditor.md), L28-33). Line numbers in this spec are pointers, not contracts.

**Owner availability:** the owner could not answer clarifying questions when this was written. Every open point is under **Open questions for the owner**, each with a recommended default. The architect designs against those defaults. If the owner overrides one, only the affected requirement and AC change.

## User story

As a brand owner, I want only admins, masters and super admins to be able to change which vendor is an ingredient's primary vendor. Since spec 201, the primary vendor decides which card a shared ingredient goes on when two of its vendors order on the same day. A staff account shouldn't be able to move it, by accident or on purpose, through the API.

Staff must keep every write they make today: EOD counts, receiving, waste and stock.

## The problem (verified in the tree, 2026-11-19)

- **Only the RPC is gated.** `public.set_item_primary_vendor` ([20261118120100_set_item_primary_vendor.sql](../supabase/migrations/20261118120100_set_item_primary_vendor.sql) L86-89) refuses non-privileged callers with `42501 'set_item_primary_vendor: privileged only'`. It is `SECURITY INVOKER`, so its writes go through the table policies below. Those policies don't gate on role.
- **The tables are open to any store member.**
  - `inventory_items`: `store_member_update_inventory_items` and `store_member_insert_inventory_items` check only `auth_can_see_store(store_id)` ([20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) L50-57).
  - `item_vendors`: all four `store_member_*_item_vendors` policies check only `auth_can_see_store(<parent item's store>)` ([20260630000000_item_vendors.sql](../supabase/migrations/20260630000000_item_vendors.sql) L121-142).
  - No later migration changes these policies, and neither table has any other policy.
- **What a `role = user` store member can do today with direct PostgREST calls:**
  - PATCH `inventory_items.vendor_id` to another vendor or to null.
  - Demote the primary link (`is_primary = false`), then promote another link. A single direct flip to `true` while another primary exists hits the `item_vendors_one_primary_per_item` partial unique index (23505). The demote-then-promote pair does not.
  - INSERT or upsert an `item_vendors` row with `is_primary = true` when the item has no primary.
  - DELETE the primary `item_vendors` row.
  - UPDATE a primary link's `vendor_id` or `item_id`, which moves the primary flag to another vendor or item.
  - INSERT a new `inventory_items` row with a `vendor_id`, either directly or through `create_inventory_item_with_catalog`. That RPC is invoker and has no role gate ([20261023000000_catalog_eod_count_mode.sql](../supabase/migrations/20261023000000_catalog_eod_count_mode.sql) L89-235), so it works whenever the catalog row already exists.
- **Why it matters more now.** `report_reorder_list` reads `inventory_items.vendor_id` as the primary (spec 201 D1). On a coincident day it drops the item from every other vendor's card. Changing the scalar moves the item between cards and changes what FILL CART, CREATE PO, exports and BJ's auto-place order. Changing only `is_primary` causes `vendor_id` / `is_primary` drift (spec 102's "dangling scalar").
- **Doc overstatement.** Spec 201 design §5.1 reason 4 ("'Admin only' is enforced server-side") is true of the switch RPC only, as the audit noted. Once this spec ships, it is true of the columns.

### Findings that settle parts of the brief

- **The spec 201 authz arms are already covered.** The brief asked to add the two arms the spec 201 audit found missing for `set_item_primary_vendor`: cross-brand admin → `P0001 'item not found'` with nothing written, and super_admin → succeeds. Spec 201's backend review follow-up already added them as arms (31)-(34) of [supabase/tests/set_item_primary_vendor.test.sql](../supabase/tests/set_item_primary_vendor.test.sql) (spec 201, "Review follow-up", 2026-11-19). This spec adds no duplicate. It requires those arms to stay green (AC-15).
- **No UI path lets a non-admin edit the vendor.**
  - `RoleRouter` mounts the admin Cmd UI, with its desktop and phone ingredient editors, only for non-`user` roles. Every non-`user` role (`admin`, `master`, `super_admin`) is privileged.
  - The staff subtree (`src/screens/staff/`) makes no direct `insert` / `update` / `upsert` / `delete` call on `inventory_items` or `item_vendors`. Its only direct writes are `profiles.locale` (`useStaffStore.ts` L161), count drafts (`countDrafts.ts`) and count orders (`countOrder.ts`). It writes stock only through RPCs (`staff_submit_eod`, `receive_purchase_order`, `submit_weekly_count`, `submit_staff_report`). So no UI change is needed. The architect re-verifies this (R8).
- **There's a house precedent for the mechanism.** Spec 194's `public.kept_record_lock_date()` ([20261109170000_kept_records_delete_hardening.sql](../supabase/migrations/20261109170000_kept_records_delete_hardening.sql) L58-133) is a `BEFORE UPDATE OF <col>` trigger that does exactly what this spec needs:
  - It allows a pass-through SET of the same value.
  - It allows server contexts: `current_user` not in (`anon`, `authenticated`) **and** the JWT claims role empty or `service_role`.
  - It allows `auth_is_privileged()` callers.
  - It raises 42501 for everyone else, **including a staff caller inside a postgres-owned SECURITY DEFINER function**, whose claims role stays `authenticated`.

  Spec 179's `inventory_items_lock_identity` is the same shape on this very table, without the role exemption.

## Requirements

- **R1. The boundary.** A non-privileged end-user caller cannot change an item's primary vendor by any direct table write. "Privileged" means `public.auth_is_privileged()`: admin or master via the JWT, or super_admin via `profiles.role`. "Change the primary" means any of these:
  1. UPDATE of `inventory_items.vendor_id` to a different value, including to or from null.
  2. UPDATE of `item_vendors.is_primary` to a different value, in either direction.
  3. INSERT of an `item_vendors` row with `is_primary = true`, including the insert branch of an upsert. The `ON CONFLICT DO UPDATE` branch is covered by (2).
  4. A direct DELETE of an `item_vendors` row whose `is_primary = true` (OQ-2).
  5. UPDATE of `item_vendors.vendor_id` or `item_id` on a row whose old or new `is_primary` is true (OQ-6).
  6. INSERT of an `inventory_items` row with a non-null `vendor_id` (OQ-5).

  Everything else these callers can write today stays writable (R5).
- **R2. Mechanism.** The architect picks it and records why (see **Mechanism options** below). The recommended default is a column-scoped guard trigger modelled on spec 194's `kept_record_lock_date`. Whatever is chosen must:
  - compare old and new values, so a pass-through write of the same value is allowed (OQ-3, R4);
  - raise the R6 error, never a silent 0-row result;
  - not add a permissive policy (CLAUDE.md permissive-OR rule).
- **R3. Who is exempt.**
  - **Privileged callers:** all three roles, including super_admin, whose role isn't in the JWT (the spec 026/027 parity trap).
  - **Server contexts with no end-user JWT:** `postgres`, migrations, `pg_cron` jobs, psql, and the service-role key (edge functions). Use the spec 194 test: `current_user` not in (`anon`, `authenticated`) **and** claims role in (`''`, `service_role`).
  - **SECURITY DEFINER RPCs called by staff are not exempt by default** (OQ-4). The guard keys on the request's JWT claims, not on `current_user`.
  - **FK cascades from deleting a parent** (an `inventory_items` row, a `vendors` row or a store) are not a primary change and must not be refused (OQ-2). The architect confirms how the mechanism tells a cascade from a direct delete, and confirms the FK action on `inventory_items.vendor_id`. The init schema declares it with no `ON DELETE` clause ([init schema](../supabase/migrations/20260405000759_init_schema.sql) L61), so it is NO ACTION and no RI update fires.
- **R4. Same-value writes are allowed.** A non-privileged write whose new `vendor_id` / `is_primary` equals the old value passes (OQ-3). This matters because a PostgREST upsert's `DO UPDATE` sets every payload column, `vendor_id`, `item_id` and `is_primary` included, even when the values haven't changed. So a check that only asks whether a column is in the SET list would refuse legitimate writes.
- **R5. Staff writes that stay allowed.** For a `role = user` member of the item's store, each of these keeps working exactly as today:
  - **`inventory_items`:** UPDATE of any column other than `vendor_id`: `par_level`, `current_stock`, `eod_remaining`, `cost_per_unit`, `case_price`, `safety_stock`, `usage_per_portion`, `average_daily_usage`, `expiry_date`, `last_updated_by`. Restricting these is explicitly out of scope.
  - **`inventory_items`:** INSERT with a null `vendor_id`, and DELETE (subject to existing FKs).
  - **`item_vendors`:** UPDATE of columns other than `is_primary`, `vendor_id` and `item_id`: `cost_per_unit`, `case_price`, `order_code`, `product_page_url`, `updated_at`. This applies on primary and non-primary rows alike.
  - **`item_vendors`:** INSERT of a non-primary link, and DELETE of a non-primary link.
  - **Every staff-reachable RPC** that writes these tables. The inventory (R7) lists at least `staff_submit_eod` / `eod_write_submission`, the stock path of `receive_purchase_order`, and `create_inventory_item_with_catalog` without a vendor.
- **R6. Error contract.**
  - **SQLSTATE `42501`**, so PostgREST returns HTTP 403.
  - **Message:** one fixed, documented string. The proposed string is `'forbidden: primary vendor change requires admin'` (OQ-9). It mirrors spec 113's pinned `'forbidden: price change requires admin'` on `receive_purchase_order`. The string is a contract: pgTAP pins it byte for byte, and changing it is a contract change.
  - **When it fires:** before the row is written, and the whole statement rolls back. No silent 0-row outcome for a row the caller can see.
  - **Unchanged:** RLS-invisible rows (another store or brand) still give 0 rows with no error, as today. The guard adds no existence oracle.
  - **`set_item_primary_vendor`** keeps its own `42501 'set_item_primary_vendor: privileged only'`. Its gate fires before any table write, so a staff caller never reaches the new guard.
- **R7. Inventory of server-side writers (architect task, recorded in the design).**
  - **How:** grep every migration and edge function for writers of `inventory_items.vendor_id` and of `item_vendors.is_primary` / `vendor_id` / `item_id`, plus inserts into or deletes from `item_vendors`.
  - **What to record for each:** its security mode, its role gate, whether staff can reach it, and whether it still works under R3.
  - **Pre-read by the PM (the architect re-verifies; take the latest body of each):**

    | Writer | Latest body | Mode / gate | Staff-reachable? | Touches |
    |---|---|---|---|---|
    | `set_item_primary_vendor` | 20261118120100 | invoker; `auth_is_privileged()` | no (gated) | demote, promote, scalar |
    | `apply_item_vendors_to_brand` | 20260724000000 L52-170 | **definer**; `auth_is_privileged()` + brand | no (gated) | demote, upsert `is_primary`, delete links, scalar |
    | `create_inventory_item_with_catalog` | 20261023000000 L89-235 | invoker; **no role gate** | **yes** | INSERT `inventory_items.vendor_id` |
    | `stock_store_from_store` | 20261105000000 L50-340 | invoker; `auth_is_privileged()` (G-1) | no (gated) | INSERT items with `vendor_id`; INSERT links with `is_primary` |
    | `receive_purchase_order` | 20260707000000 | invoker; price path gated by `auth_is_privileged()` | stock path yes | price path: INSERT a **non-primary** link (`is_primary = false`); never sets primary |
    | `staff_submit_eod` → `eod_write_submission` | 20261109190000 (+ 20261110130000) | definer wrapper / invoker writer | yes | `current_stock`, `eod_remaining`, `last_updated_by` only |
    | `admin_submit_eod` | 20261109120000 | privileged | no | stock columns only |
    | `apply_item_scalars_to_brand` / store subset | 20261115120000 | definer; `auth_is_privileged()` | no | par, cost, case price; no `vendor_id` |
    | waste RPC, auto-receive cron, cost-on-receipt, `po_loop` receive | various | various | some | stock or cost only |
    | `breadbot-nightly-sync` edge function | `supabase/functions/breadbot-nightly-sync/index.ts` L391-394 | service role | n/a | `current_stock`, `last_updated_by` only |
    | historical backfills in migrations (spec 102 link backfill, brand-catalog P2) | migrations | postgres | n/a | already applied; must still replay cleanly on a fresh `supabase db reset` |

  - **Conclusion of the pre-read:** no staff-reachable SECURITY DEFINER RPC changes the primary today, so the OQ-4 default breaks nothing. The one staff-reachable writer that sets a vendor is `create_inventory_item_with_catalog` with `p_per_store.vendor_id` (OQ-5).
- **R8. Staff app check (architect re-verifies).** Confirm the staff subtree still makes no direct write of these columns (see the findings above), and that no staff flow sends `vendor_id` to `create_inventory_item_with_catalog`. If one does, stop and raise it as an owner question before building.
  - The staff client's `isForbidden` (spec 199) keys on 42501 and on the store-gate message. It is unaffected, because staff never trigger the new error in normal use.
- **R9. Admin saves keep working.** These paths are unchanged in code and must still succeed for admin, master **and** super_admin:
  - `db.createInventoryItem` ([db.ts](../src/lib/db.ts) L380-480): RPC `create_inventory_item_with_catalog` with `p_per_store.vendor_id`, then a direct `item_vendors` upsert with `is_primary`.
  - `db.updateInventoryItem` (L487-651), in this order:
    1. a direct `inventory_items` update that includes `vendor_id`;
    2. the demote of other primaries;
    3. a link upsert carrying `is_primary`;
    4. a delete of de-selected links, which can include the old primary link.
  - `db.applyItemVendorsToBrand` (L664-696): the definer RPC `apply_item_vendors_to_brand`.
  - `db.setItemPrimaryVendor` (L4838): the spec 201 switch.
  - The CSV import (`csvImport.ts`) and the store-subset save from commit 30b6d21, which reach the tables through the store's `addItem` / `updateItem` and the paths above.
- **R10. Docs.**
  - The migration header and the guard function's `comment on function` state the boundary, the exemptions and the error string.
  - Spec 201 §5.1 reason 4 gets a one-line note: "Column-level enforcement landed in spec 204; before that, only the RPC was gated."
  - CLAUDE.md gets a convention bullet only with the owner's approval (OQ-7).

## Mechanism options (architect decides; PM recommends Option A)

**Option A: column-level guard triggers (recommended).**
- **Shape.** `BEFORE UPDATE OF vendor_id` and `BEFORE INSERT` on `inventory_items`. `BEFORE INSERT`, `BEFORE UPDATE OF is_primary, vendor_id, item_id` and `BEFORE DELETE` on `item_vendors`. Each compares OLD with NEW, applies the R3 exemptions, then raises R6.
- **Reference shape:** spec 194's `kept_record_lock_date` (claims-role server-context test, privileged bypass, pass-through allowed, `security invoker`, `set search_path = public`, `revoke execute … from public, anon, authenticated`).
- **Pros:**
  - Column-precise: staff par, stock and cost writes are untouched.
  - Custom stable error (R6).
  - Catches staff callers inside definer RPCs (OQ-4 default).
  - Covers the upsert `DO UPDATE` branch.
  - Doesn't touch `pg_policies`, so the spec 053 `permissive_policy_lint` is unaffected.
- **Cons:**
  - Triggers bind service_role and postgres too, so the exemption must be explicit and tested.
  - FK cascade deletes fire the `item_vendors` DELETE trigger under the deleting user's claims, so the DELETE arm needs cascade awareness (R3). Candidates: `pg_trigger_depth()`, or checking whether the parent `inventory_items` row is still visible. The architect picks and tests.
  - **Trigger order.** `inventory_items` BEFORE UPDATE triggers fire in name order: `inventory_items_identity_lock_trg`, `inventory_items_updated_at`, `trg_item_vendor_changed_at`. The architect names the new trigger and states where it sorts. A raise aborts the row either way, but `trg_item_vendor_changed_at` should never stamp on a refused change.

**Option B: RESTRICTIVE policies.**
- **Shape.** `AS RESTRICTIVE FOR UPDATE / INSERT / DELETE` policies that require `auth_is_privileged()` or "primary unchanged".
- **Pros:**
  - Postgres-native.
  - service_role and the table owner bypass RLS, so server contexts and postgres-owned definer RPCs are exempt for free.
  - RI cascades bypass RLS, so the delete-cascade question disappears.
  - Precedent in specs 186, 194 and 022's audit-log hardening.
  - The spec 053 lint scans permissive policies only, so a restrictive policy doesn't trip it.
- **Cons:**
  - **No OLD row.** USING and WITH CHECK see only one row version. "Unchanged" needs a correlated subquery against the pre-statement row, which is non-obvious and fragile. Without it, a RESTRICTIVE UPDATE policy blocks staff from **all** updates (par, stock, cost), which breaks R5.
  - **Wrong error shape.** A USING failure on UPDATE or DELETE is a **silent 0-row** result, which violates R6. A WITH CHECK failure gives Postgres's generic `new row violates row-level security policy` message, not a custom string.
  - **No catch inside definer RPCs.** The owner bypass means staff inside a postgres-owned definer RPC are not caught, which is the opposite of the OQ-4 default.

**A hybrid is acceptable:** for example, triggers for INSERT and UPDATE plus a RESTRICTIVE DELETE policy on primary links. If the architect picks one, they must note that the DELETE arm then gives 0 rows rather than the R6 error, and get the owner to accept that deviation from R6 (record it as a new OQ).

**Whichever option is chosen:** run `pg_policies` for both tables first, per the CLAUDE.md permissive-OR rule. The PM pre-read found exactly the four `store_member_*` policies on each table.

## Acceptance criteria

**Fixture terms (pgTAP, `begin; … rollback;`):**
- **Store S** in brand B1.
- **Item F** at S, linked to vendors A and V. `inventory_items.vendor_id = A`, and A's link has `is_primary = true`.
- **Item N** at S, with links but no primary. It is set up as postgres.
- **Principals:**
  - **U:** a `role = user` member of S (`user_stores`).
  - **ADM:** a JWT `admin` in B1.
  - **MST:** a JWT `master`.
  - **SA:** a super_admin. Its role is set in `profiles.role` only; the JWT role is neither admin nor master.
  - **X:** a JWT `admin` in brand B2, with no `user_stores` rows for S.
  - **service_role:** the service role.
  - **postgres:** a no-claims session, as cron or a migration would run.

### Server: staff refused (pgTAP)

- [ ] **AC-1:** U's `UPDATE inventory_items SET vendor_id = V WHERE id = F` raises `42501` with the exact R6 string. Afterwards `vendor_id` is still A, and `vendor_changed_at` is unchanged.
- [ ] **AC-2:** U setting `vendor_id` to null on F is refused the same way.
- [ ] **AC-3:** U demoting A's link (`is_primary = false`) is refused, and A is still primary.
  - On N, U promoting a link (`is_primary = true`) is refused, and N still has no primary.
- [ ] **AC-4:** U runs the demote-then-promote pair (A → false, then V → true) in one transaction. The first statement raises R6. After the test savepoint, exactly one primary exists (A), and `vendor_id = A`.
- [ ] **AC-5:** On N, U inserting a new link with `is_primary = true` is refused.
  - U upserting V's existing link with `is_primary = true` via `INSERT … ON CONFLICT (item_id, vendor_id) DO UPDATE` is refused.
  - In both cases the links are unchanged.
- [ ] **AC-6 (OQ-2 default):** U's direct DELETE of A's primary link is refused, and the row still exists.
- [ ] **AC-7 (OQ-6 default):** U updating the `vendor_id` of A's primary link to another vendor in brand B1 is refused. So is U re-pointing that link's `item_id` to another item at S.
- [ ] **AC-8 (OQ-5 default):**
  - U's direct INSERT of an `inventory_items` row at S with a non-null `vendor_id` is refused.
  - U calling `create_inventory_item_with_catalog` for an existing catalog row with `p_per_store.vendor_id` set is refused with R6, and no `inventory_items` row is created.
- [ ] **AC-9 (OQ-4 default):** U, calling a test-local postgres-owned SECURITY DEFINER function that sets F's `vendor_id`, is refused with R6. This follows the spec 194 test pattern.

### Server: staff writes that still work (pgTAP)

- [ ] **AC-10 (no-op, OQ-3 default):**
  - U's `UPDATE inventory_items SET vendor_id = A, par_level = <new> WHERE id = F` succeeds, and `par_level` changes.
  - U's upsert of A's link with `is_primary = true` (its current value) and a new `order_code` succeeds.
- [ ] **AC-11 (non-vendor fields):** each of these by U succeeds and persists:
  - UPDATE of F's `par_level`, `current_stock`, `cost_per_unit`, `case_price`, `safety_stock` and `usage_per_portion`;
  - UPDATE of `cost_per_unit`, `case_price`, `order_code` and `product_page_url` on both A's (primary) and V's (non-primary) link;
  - INSERT of a new non-primary link on F;
  - DELETE of V's non-primary link;
  - INSERT of an `inventory_items` row with a null `vendor_id`;
  - `create_inventory_item_with_catalog` without a vendor.
- [ ] **AC-12 (staff RPCs):**
  - `staff_submit_eod` as U writes `current_stock` on F.
  - `receive_purchase_order` as U, on a stock-only line, increments `current_stock`.
  - Every existing suite for these RPCs (including `staff_receiving_gate.test.sql`) passes unchanged.
- [ ] **AC-13 (cascades, R3):**
  - ADM deleting F (with links) succeeds, and its links cascade away.
  - U deleting an `inventory_items` row whose links include a primary behaves exactly as it does today. The guard must not be what refuses it.

### Server: privileged and server contexts (pgTAP)

- [ ] **AC-14 (direct writes):** for each of ADM, MST and SA, each of these succeeds and leaves exactly one primary link whose vendor equals `vendor_id`:
  - a direct PATCH of `vendor_id`;
  - the demote-then-promote pair;
  - an upsert with `is_primary = true`;
  - a direct DELETE of the primary link (followed by the scalar update the admin path makes);
  - an INSERT of an item with `vendor_id`.
- [ ] **AC-15 (the admin paths replayed as SQL, R9):** for each of ADM, MST and SA, these sequences succeed with the expected end state:
  - the `createInventoryItem` sequence (RPC with `p_per_store.vendor_id`, then a link upsert with `is_primary`);
  - the `updateInventoryItem` primary-switch sequence (scalar update → demote → upsert → delete the de-selected old primary link);
  - `apply_item_vendors_to_brand`;
  - `set_item_primary_vendor`.

  Also, `set_item_primary_vendor` as U still raises `42501 'set_item_primary_vendor: privileged only'` (its own gate, not R6). Arms (31)-(34) of `set_item_primary_vendor.test.sql` stay green.
- [ ] **AC-16 (cross-brand):** X's direct PATCH of F's `vendor_id` affects 0 rows with no error (RLS, as today), and F is unchanged. X through `set_item_primary_vendor` still gets `P0001 'set_item_primary_vendor: item not found'`.
- [ ] **AC-17 (server contexts, R3):** as service_role, and as postgres with no claims:
  - a `vendor_id` change succeeds;
  - an `is_primary` demote and promote succeeds;
  - a primary-link delete succeeds.

### Posture and gates

- [ ] **AC-18 (error contract):**
  - Every refusal arm asserts SQLSTATE `42501` **and** the byte-exact R6 message (`throws_ok`).
  - No refusal arm passes by observing 0 rows, unless a hybrid DELETE was accepted under the Option B note.
- [ ] **AC-19 (object posture):**
  - Each guard function is `SECURITY INVOKER` (or whatever the design states), with `proconfig = {search_path=public}`, and EXECUTE revoked from `public`, `anon` and `authenticated`.
  - Each trigger is present with `tgenabled = 'O'`.
  - If Option A is chosen, `pg_policies` for both tables is unchanged.
  - `permissive_policy_lint.test.sql` passes.
- [ ] **AC-20 (regression):** the full pgTAP run (`scripts/test-db.sh`) passes.
  - An existing arm that writes `vendor_id` / `is_primary` as a `role = user` principal and expects success is **rewritten**, not deleted: switch it to a privileged principal or to an expected refusal. List each one under `## Files changed`.
  - The architect greps for these before the build.
- [ ] **AC-21 (no client change):** no file under `src/` changes. The full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass. `e2e.yml` is checked by hand after the push.

### Prod data check (read-only, before the prod apply)

- [ ] **AC-22:** a read-only query runs on prod (project `ebwnovzzkwhsdxkpyjka`, via the Supabase MCP), and its counts, with up to 10 example item ids each, are recorded in this spec's implementation notes:
  - (a) items whose non-null `vendor_id` has no `item_vendors` link (the dangling scalar);
  - (b) items whose `vendor_id` link exists but isn't `is_primary`, or where another link is primary (mismatch);
  - (c) items with a null `vendor_id` but a primary link;
  - (d) items with links but no primary link;
  - (e) items with more than one primary link (expected 0, because of the partial unique index);
  - (f) **privileged-role parity:** `profiles` rows with role `admin` or `master` whose `auth.users.raw_app_meta_data->>'role'` isn't `admin` / `master`. Such a user would pass the admin UI but fail R1, because `auth_is_admin()` reads the JWT.

  The check is report-only. Nothing is fixed (OQ-10, OQ-11).

## In scope

- One migration adding the guard (triggers, policies or a hybrid, per R2). It sorts after `20261118120100` and after any migration specs 202/203 add; re-glob at build time.
  - The header covers posture, exemptions, the error string, the realtime note, prod apply and rollback.
- One new pgTAP suite under `supabase/tests/` (the architect names it, for example `primary_vendor_admin_only.test.sql`) for AC-1 to AC-19, plus any AC-20 rewrites.
- The R7 writer inventory and the R8 staff check, recorded in the design.
- The AC-22 read-only prod report.
- The R10 doc notes (the spec 201 §5.1 annotation, and the migration and function comments).

## Out of scope (explicitly)

- **Restricting staff edits to par, stock, cost, order code or links in general.** The audit notes these are staff-writable too. This spec only takes the primary pointer away.
- **Restricting staff item creation or deletion in general.** Only the vendor part of creation is covered (OQ-5).
- **Repairing `vendor_id` / `is_primary` drift** found by AC-22, unless the owner says otherwise (OQ-10).
- **Fixing privileged-role JWT drift** found by AC-22 (f). It is reported, and the owner decides (OQ-11).
- **The spec 201 3c TOCTOU wording** in `set_item_primary_vendor`. It's a separate Low, already reworded in spec 201's follow-up.
- **Adding a role gate to `create_inventory_item_with_catalog`** beyond what R1 (6) implies.
- **Any UI change.** No non-admin UI path edits the vendor (see the findings).
- **New tests for spec 201's authz arms.** They already exist.
- **Changing the `app.json` slug.** It isn't touched.

## Open questions for the owner

Each has a recommended default; the architect designs against the defaults.

- **OQ-1. Trigger, RESTRICTIVE policy, or a hybrid?**
  - **Default:** a trigger (Option A), modelled on spec 194's `kept_record_lock_date`. The architect makes the final call and records why.
- **OQ-2. Does deleting the primary link count as changing the primary?**
  - **Default:** yes for a **direct** DELETE by a non-privileged caller (AC-6). It leaves `vendor_id` dangling, and reorder then treats the item as having no primary (spec 201 OQ-4).
  - Cascades from deleting the parent item, vendor or store are **not** a primary change (AC-13).
- **OQ-3. Are staff no-op writes of the same `vendor_id` / `is_primary` allowed?**
  - **Default:** allowed (compare OLD with NEW). PostgREST upserts resend every column, and spec 179 and 194 both allow pass-through.
- **OQ-4. May SECURITY DEFINER RPCs that staff can reach change the primary?**
  - **Default:** no. The guard keys on the request's JWT claims, so staff inside a definer RPC are refused (spec 194 posture).
  - The pre-read found no staff-reachable definer RPC that changes the primary, so nothing breaks. A future definer RPC that needs to must gate on `auth_is_privileged()` itself.
- **OQ-5. Does creating an item with a vendor count?**
  - **Default:** yes. A non-privileged INSERT with a non-null `vendor_id` is refused, directly or through `create_inventory_item_with_catalog`.
  - Staff creating an item with no vendor stays allowed (today's behaviour). The staff app doesn't create items.
- **OQ-6. Does re-pointing a primary link's `vendor_id` or `item_id` count?**
  - **Default:** yes. It moves the primary flag without touching `is_primary`.
  - Re-pointing a **non-primary** link stays allowed for staff (out of scope).
- **OQ-7. Add a CLAUDE.md convention bullet?**
  - **Default:** yes, but only after the owner approves the text. Agents don't edit CLAUDE.md without approval. Proposed text: "**Primary-vendor columns are admin-only.** `inventory_items.vendor_id` and `item_vendors.is_primary` (plus inserting or deleting a primary link) can be changed only by `auth_is_privileged()` callers or server contexts, enforced by <mechanism> (spec 204). Same-value writes pass. Refusal: 42501 `'forbidden: primary vendor change requires admin'`. A new staff-reachable writer of these columns must not route around it."
- **OQ-8. Fold in spec 201's untested authz arms?**
  - **Resolved by a finding:** they already landed as arms (31)-(34) in spec 201's follow-up. This spec only requires them to stay green (AC-15).
- **OQ-9. One shared error string, or one per table?**
  - **Default:** one string, `'forbidden: primary vendor change requires admin'` (42501), in the spec 113 family.
  - **The alternative:** spec 194's `'<table>: <col> is immutable'` shape, for example `'inventory_items: vendor_id requires admin'`. It's more precise, but it gives several strings to pin.
- **OQ-10. What if AC-22 finds drift?**
  - **Default:** report only. A repair goes in a follow-up spec. Drift never puts an item on two cards (spec 201 R3), and this spec doesn't make drift worse.
- **OQ-11. What if AC-22 (f) finds admins or masters whose JWT role doesn't match `profiles.role`?**
  - **Default:** don't apply to prod until the owner decides. Each such account would start getting 403 on vendor edits in the ingredient editor.
- **OQ-12. Release order relative to spec 201.**
  - **Default:** apply this migration to prod after spec 201's two migrations, or in the same window. AC-15 exercises `set_item_primary_vendor`.
  - This spec doesn't depend on 201's client.

## Dependencies

- **Spec 201:** `set_item_primary_vendor` and its test suite. It's at `READY_FOR_REVIEW`, so this lands after it or with it (OQ-12).
- **Spec 194:** the reference trigger shape and the server-context exemption test.
- **Spec 179:** the precedent for a column-lock trigger on `inventory_items`, and the trigger ordering.
- **Spec 102 / 124:** the SD-1 mirror and the demote-first admin write.
- **Spec 113:** the error-string family.
- **Spec 053:** `permissive_policy_lint` must stay green.
- **Specs 202/203** (parallel): only migration ordering. Re-glob before dating the file.
- No edge function, library or client dependency.

## Project-specific notes

- **Cmd UI section / legacy:** none. This is a server-only change. The admin ingredient editors (desktop and phone) and the reorder switch keep working unchanged (R9).
- **Which app:** this repo. It protects data that both the admin Cmd UI and the staff app read. Staff never write the columns.
- **Per-store or admin-global:** per-store data (`inventory_items` is per store, and `item_vendors` is scoped through it). The boundary is role-based on top of the existing `auth_can_see_store` RLS, which is unchanged.
- **Edge function or PostgREST:** database only (a trigger or policy). No new RPC and no edge function. Service-role edge functions must keep working (AC-17).
- **Realtime channels touched:** none. No publication change, so the `docker restart supabase_realtime_imr-inventory` ritual does **not** apply. Allowed writes still publish on `store-{id}` as today.
- **Migrations needed:** yes, one (In scope).
- **Edge functions touched:** none.
- **Web/native scope:** both, server-side only. Every installed client gets the boundary when the migration is on prod. No Vercel or EAS build is needed.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-20); jest and typecheck as regression gates only (AC-21). No shell smoke is required, because the 42501 → 403 mapping is standard PostgREST. The architect may add one to `scripts/smoke-rpc.sh` if they want an HTTP-level pin.

## Residual risk

- **The JWT-role parity trap.** `auth_is_admin()` reads `app_metadata.role`. An admin whose token lacks it, but who has `user_stores` rows, can edit vendors today and won't after this spec. AC-22 (f) measures this before deploy.
- **Partial admin-path writes aren't made worse.** `updateInventoryItem` is still 3-4 separate PostgREST writes for privileged callers (the spec 201 §5.1 reason 1 drift risk). This spec doesn't change that, and the guard never refuses a privileged caller mid-sequence.
- **A future writer.** A new staff-reachable RPC or edge function that needs to set the primary will be refused by default (OQ-4). The OQ-7 bullet is how the next spec finds out.

## Prod apply and commit (owner, later; not part of this spec's done state)

- **Commit:** stage only. Don't commit without the owner's explicit go-ahead.
- **Prod apply** (Supabase MCP, project `ebwnovzzkwhsdxkpyjka`), only with the owner's go-ahead:
  1. Run the AC-22 read-only report and record it. If (f) is non-zero, stop (OQ-11).
  2. `execute_sql` the migration body.
  3. Insert the exact version into `supabase_migrations.schema_migrations`.
  4. Verify the guard functions by normalized md5, and verify `prosecdef`, `proconfig` and `proacl` against local. Verify the triggers by presence (`tgenabled = 'O'`). If policies were used, diff `pg_policies` against local.
- **Rollback:** drop the new triggers and functions (or policies). It's hand-written SQL in the implementation notes, it reopens the audit Low, and it needs an owner decision.
- **Gates:** after the push to `main`, confirm `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 204 (primary vendor admin-only boundary).
  - Pick the mechanism (OQ-1; the PM recommends a spec 194-style guard trigger) and record why.
  - Produce the R7 writer inventory, verifying the PM's pre-read table against the latest function bodies, and the R8 staff check.
  - Define the guard's exact predicate per write path (R1 items 1-6), the server-context and cascade exemptions (R3), the error string (R6 / OQ-9), the trigger names and ordering, the migration name and position (re-glob for 202/203), and the pgTAP suite layout for AC-1 to AC-20.
  - Grep the existing pgTAP suites for `role = user` arms that write `vendor_id` / `is_primary` and expect success (AC-20).
  - Design against the OQ defaults. The owner hasn't answered yet.
  - Then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/204-primary-vendor-admin-only-boundary.md
  - specs/201-reorder-shared-item-primary-vendor-wins.md
  - specs/201-reorder-shared-item-primary-vendor-wins/reviews/security-auditor.md
  - supabase/migrations/20261109170000_kept_records_delete_hardening.sql
