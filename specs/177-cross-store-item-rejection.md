# Spec 177: Reject line items that belong to a different store

Status: READY_FOR_REVIEW

Origin: the server-side follow-up named in spec 176's "Out of scope (explicitly)" list. It closes the `po_items` cross-store gap first recorded in spec 176 §L2, plus the related gaps in `order_approvals.lines` and `purchase_orders.store_id`. It is the server check that spec 176's security audit ([specs/176-late-result-store-guards/reviews/security-auditor.md](176-late-result-store-guards/reviews/security-auditor.md)) says is the only thing that fully closes the remaining client windows. The owner approved the scope and every decision below before this spec was written, so they are written as requirements. No questions remain open. Two items are left to the architect on purpose: the `order_approvals` errcode (R-2) and "lock once lined" vs "always immutable" (R-3).

**Sequencing:** spec 176 is staged but not committed. It touches no `supabase/` files, and this spec touches nothing else, so the two are independent. Line numbers come from the working tree on 2026-10-26. Treat them as pointers. The newest migration on disk is `20261024000000_eod_entries_no_need.sql`. This spec's migration must sort after it.

## User stories

1. As a **store manager**, I want the database to refuse a purchase-order line whose item belongs to another store, so that no client bug or race (spec 176 L1/L2/L3 lineage) can ever file store A's items on store B's PO.
2. As a **store manager approving an order**, I want an approval to be refused if any of its lines names another store's item, whether it comes through the RPC, a direct insert, or a later edit of a pending approval. Then the approval audit trail can only ever hold the store's own items.
3. As a **multi-store manager**, I want a purchase order that already has lines to stay with its store, so that editing the PO header can never carry its lines to another store.

## Current state (verified 2026-10-26)

### `po_items`
- `po_items.item_id` is a plain FK to `inventory_items(id)`, which is a per-store row. It is nullable and has no store check ([supabase/migrations/20260405000759_init_schema.sql:166-173](../supabase/migrations/20260405000759_init_schema.sql)).
- All four RLS policies check only `auth_can_see_store` on the parent `purchase_orders.store_id` ([supabase/migrations/20260504173035_per_store_rls_hardening.sql:206-250](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)). A user who can see stores A and B can insert a line on B's PO that names A's item.
- **Client writers**, all in [src/lib/db.ts](../src/lib/db.ts):
  - `createPurchaseOrderDraft` line insert (≈L1805-1822). On failure it deletes the orphan header and returns `null`.
  - `upsertVendorDraftOrder` (≈L1853). Its UPDATE path inserts new lines (≈L1928-1932) and returns `null` on failure, leaving the prior lines in place. Its INSERT path inserts lines (≈L1975-1984), deletes the orphan header on failure, and returns `null`.
  - `updatePoItemQty` (≈L2013-2023) PATCHes `ordered_qty` only.
  - `deletePoItem` (≈L2030).
- **Staff receiving** ([src/screens/staff/lib/receiving.ts](../src/screens/staff/lib/receiving.ts)) only reads `po_items` (≈L157). Its writes go through RPCs. `ReceivingSection` writes through `db.ts` RPC wrappers.
- **DB-side writers** only `update public.po_items set received_qty = …`:
  - `20260704000000_po_loop.sql:227`;
  - `20260705000000_cost_on_receipt.sql:208`;
  - `20260707000000_staff_receiving_price_gate.sql:200`;
  - `20260719000000_auto_receive_due_purchase_orders.sql:111` (the SECURITY DEFINER cron).
  - No migration inserts `po_items`, and none updates `item_id` or `po_id`.
- **Edge functions:** `send-po-email` reads `po_items` and updates `purchase_orders` (≈L205). The architect confirms that update does not touch `store_id`. No edge function writes `po_items`.

### `order_approvals.lines`
- The table, guard trigger, RLS and RPC are in [supabase/migrations/20260801000100_order_approvals.sql](../supabase/migrations/20260801000100_order_approvals.sql).
- `create_order_approval` (L278-…) is SECURITY INVOKER. It validates each `lines[]` element's shape: `item_id` must be present and castable to uuid (L331-340), and every violation raises `22023` ("invalid approval lines: …"). **It never checks that `item_id` is an `inventory_items` row of `p_store_id`.** Its pending-retry branch rewrites `lines` with an UPDATE.
- The policy `privileged_store_insert_order_approvals` (L248-252) also allows a **direct PostgREST INSERT**, which skips the RPC's validation entirely.
- `tg_order_approvals_guard` (L97-215) is a BEFORE UPDATE trigger. It keeps `lines` writable while `status = 'pending'` (block (c), L127-176), so a pending row's `lines` can be PATCHed directly. The same guard already makes `store_id` immutable (block (a), L105-114). **So no `store_id` lock is needed on `order_approvals`.**
- Client: `db.createOrderApproval` (≈L2636) **throws** the PostgREST error. `db.advanceOrderApproval` (≈L2688) never sends `lines`.
- `instacart-cart-link` updates `order_approvals` (≈L383, L675) for status and external_ref only. The architect confirms it never writes `lines`.

### `purchase_orders.store_id`
- `store_member_update_purchase_orders` (per_store_rls_hardening L194-197) checks `auth_can_see_store(store_id)` on both USING and WITH CHECK. A user who can see both stores can PATCH `store_id` from A to B, and the PO's lines go with it.
- No client code updates `purchase_orders.store_id`. `db.ts` updates only `total_cost` (≈L1947) and `status` (≈L2150). A grep of `supabase/` finds no migration that does `update purchase_orders … set … store_id`.

### Data (read-only count, 2026-10-26)
- Prod (project `ebwnovzzkwhsdxkpyjka`): 40 `po_items`, with 0 cross-store, 0 orphaned `item_id`, and 0 null `item_id`. 0 `order_approvals` rows.
- Local seed: 0 `po_items`, 0 `order_approvals`.
- **No backfill or repair is needed.** The migration adds the checks directly. Nothing in this spec validates existing rows (triggers only see new writes).

## Requirements (owner-approved)

- **R-1. `po_items` store-consistency trigger.**
  - It fires BEFORE INSERT, and BEFORE UPDATE OF `item_id`, `po_id`, for each row.
  - It requires `inventory_items.store_id` (of `new.item_id`) to equal `purchase_orders.store_id` (of `new.po_id`).
  - It **fails closed**. The write is refused when the parent PO is missing or not visible, when the parent's `store_id` is null, when `new.item_id` is null, or when the item is missing or not visible.
  - Model it on `public.inventory_count_entries_check_store()` ([supabase/migrations/20260513120000_inventory_counts_consistency.sql:79-113](../supabase/migrations/20260513120000_inventory_counts_consistency.sql)) and its pgTAP ([supabase/tests/inventory_count_entries_check_store.test.sql](../supabase/tests/inventory_count_entries_check_store.test.sql)). That precedent is SECURITY INVOKER with `set search_path = public` and raises `42501`.
  - Receiving-style updates (`received_qty`, `cost_per_unit`, `ordered_qty`) **must not fire it**. It must not break the SECURITY DEFINER cron `auto_receive_due_purchase_orders`, the receiving RPCs (`receive_purchase_order` and the staff receiving / price-gate RPCs), `updatePoItemQty`, or `deletePoItem`.
- **R-2. `order_approvals.lines` store-consistency trigger.**
  - It fires BEFORE INSERT, and BEFORE UPDATE OF `lines`, for each row.
  - It requires **every** `lines[].item_id` to be an `inventory_items` row whose `store_id = new.store_id`.
  - It covers the three write paths: the `create_order_approval` RPC (insert and pending-retry update), a direct PostgREST INSERT, and a direct PATCH of `lines` on a pending row.
  - It fails closed: any line whose item is missing, not visible, or another store's makes the whole write fail.
  - **The architect picks the errcode.** The options are `42501` (the R-1 precedent, which PostgREST maps to 403) or `22023` (which matches the RPC's existing "invalid approval lines" contract and maps to HTTP 400). Record the choice. The architect also confirms the client surfaces it sanely: `createOrderApproval` throws, so check what the PhoneApproveOrder / store caller shows.
  - The architect also defines what the trigger does on a malformed `lines` value reaching it through direct INSERT, which skips the RPC's shape checks (not an array, an element without `item_id`, a non-uuid `item_id`). The requirement is only that it fails closed with a stable error and never raises an unhandled cast error that slips past the check.
- **R-3. `purchase_orders.store_id` lock.**
  - Refuse an UPDATE that changes `store_id` (`new.store_id is distinct from old.store_id`) once the PO has any `po_items` row.
  - The architect may make `store_id` **always immutable** on UPDATE instead, if no legitimate flow needs to change it. Verify this, including edge functions (`send-po-email`, `eod-reminder-cron`), SECURITY DEFINER RPCs, and the brand-delete cascade. Record the choice.
  - An UPDATE that does not change `store_id` must behave exactly as today (`total_cost`, `status`, receive-path header writes, `markPurchaseOrderSent`).
- **R-4. No client change.**
  - Existing writers already treat a failed write as "not recorded". For example, `upsertVendorDraftOrder` returns `null`, then `recordExportedOrder` calls `notifyBackendError('Record exported order', …)`, and `createPurchaseOrderDraft` cleans up its orphan header.
  - The architect **confirms** this for every writer listed under Current state and changes none of them. If a writer would leave a bad state on refusal (for example an orphan header), report it as a finding. Do not fix it in this spec.
- **R-5. Conventions.**
  - Spec 097 explicit-grant and function-privilege posture: [supabase/tests/public_grants_explicit.test.sql](../supabase/tests/public_grants_explicit.test.sql) stays green.
  - Spec 053 permissive-policy lint stays green. No new or changed RLS policy is expected.
  - Every new trigger function revokes execute from `public, anon, authenticated`, as `tg_order_approvals_guard` does (order_approvals L207-208).
  - The migration header carries a PROD-APPLY note in the order_approvals.sql style.
  - No publication change, so no realtime container restart is needed.

## Acceptance criteria

Test track: **pgTAP** (new file or files under `supabase/tests/`), plus the existing jest and typecheck gates as a regression check. No shell smoke. Each rejection case asserts the errcode the design chose, with `throws_ok` and a SQLSTATE. Each acceptance case asserts the row really landed or changed (anti-vacuity). Fixtures use two stores, A and B, each with its own `inventory_items`, and a privileged caller who can see both. Without that, RLS would hide the cross-store case and the test would pass for the wrong reason. Where the precedent's fail-closed "not visible" branch matters, also include a caller who can see only one store.

### `po_items` (R-1)
- [ ] **AC-1:** INSERT a `po_items` row on store B's PO with `item_id` = one of store A's items → rejected with the chosen errcode. No row is written.
- [ ] **AC-2:** UPDATE an existing same-store `po_items.item_id` to a store A item while the PO belongs to B → rejected. The row is unchanged.
- [ ] **AC-3:** UPDATE `po_items.po_id` to move a line from A's PO to B's PO (the item is A's) → rejected.
- [ ] **AC-4:** INSERT with `item_id` null, and INSERT with a `po_id` whose parent is missing or not visible → both rejected (fail closed).
- [ ] **AC-5:** same-store INSERT (B's PO, B's item) → accepted, and the row exists.
- [ ] **AC-6:** a receiving-style UPDATE of `received_qty`, `cost_per_unit` and `ordered_qty` on an existing line → accepted, and the values changed. Include at least one call through the real receiving RPC (`receive_purchase_order`) so the RPC path is proven.
- [ ] **AC-7:** the committed `supabase/tests/auto_receive_due_purchase_orders.test.sql` and `supabase/tests/po_loop.test.sql` pass **unmodified**. So do the other existing pgTAP files that write `po_items`. If one of them builds a cross-store fixture, that is a finding to report, not something to patch quietly.

### `order_approvals` (R-2)
- [ ] **AC-8:** `create_order_approval(p_store_id = B, …, p_lines = [{ item_id: <A's item>, … }])` → rejected with the chosen errcode. No row is written.
- [ ] **AC-9:** a mixed-lines RPC call (one B item, one A item) → rejected. No row is written.
- [ ] **AC-10:** a direct `insert into public.order_approvals` for store B (run as the privileged caller under RLS, `approved_by = auth.uid()`) with an A item in `lines` → rejected.
- [ ] **AC-11:** a direct UPDATE of `lines` on a **pending** store-B row to include an A item → rejected. The row's `lines` are unchanged.
- [ ] **AC-12:** the RPC pending-retry path (call `create_order_approval` again for the same key with new lines that include an A item) → rejected. The original lines are unchanged.
- [ ] **AC-13:** a same-store approval through the RPC → accepted, and the row exists with `status = 'pending'`. A same-store pending retry with changed B lines → accepted, and the lines were updated.
- [ ] **AC-14:** a status advance (`pending → approved`) and an `external_ref` write on a same-store row → accepted. The new trigger does not fire, or passes, on UPDATEs that do not touch `lines`.
- [ ] **AC-15:** a direct INSERT with malformed `lines` (shapes per R-2's last bullet) → rejected with the stable error the design names. No unhandled exception class slips through.
- [ ] **AC-16:** the committed `supabase/tests/order_approvals.test.sql` and `supabase/tests/report_last_order_context.test.sql` pass with **fixture-only edits** (D-1 = option A, design §0). The only permitted edits are:
  - in `order_approvals.test.sql`, adding two brand-A `catalog_ingredients` rows and two `inventory_items` rows with the existing literal ids `49920000-0000-0000-0000-000000000001` / `…0002` in `test.store_a`;
  - in `report_last_order_context.test.sql`, wrapping the existing `order_approvals` fixture INSERT in `alter table public.order_approvals disable trigger order_approvals_lines_check_store_trg;` / `enable trigger …;`, plus an explanatory comment.

  No assertion, expected value, or `plan()` count changes in either file. (The AC-7 rule still applies: any other fixture problem is a finding to report.)

### `purchase_orders.store_id` (R-3)
- [ ] **AC-17:** UPDATE `store_id` from A to B on a PO that has at least one `po_items` row → rejected. Both the PO and its lines are unchanged.
- [ ] **AC-18:** UPDATE `total_cost` and `status` on a lined PO without changing `store_id` → accepted.
- [ ] **AC-19:** UPDATE `store_id` on a PO with **no** lines → accepted under the "lock once lined" design, or rejected under the "always immutable" design. The test pins whichever the architect chose.

### Privileges and lints (R-5)
- [ ] **AC-20:** each new trigger function has no EXECUTE for `public`, `anon` or `authenticated` (`has_function_privilege` probes or the existing lint). `public_grants_explicit.test.sql` and `permissive_policy_lint.test.sql` pass unmodified.

### Gates
- [ ] **AC-21:** `scripts/test-db.sh` (all pgTAP, including the lints), full `npx jest` (not a subset), `npm run typecheck`, and `npm run typecheck:test` all pass.
- [ ] **AC-22:** scope fence. The only files added or changed are one new migration under `supabase/migrations/`, the new pgTAP file(s) under `supabase/tests/`, the two AC-16 fixture-only edits (`supabase/tests/order_approvals.test.sql`, `supabase/tests/report_last_order_context.test.sql`, limited to exactly what AC-16 permits), and this spec plus its `reviews/`. `src/**`, `supabase/functions/**` and `app.json` are not touched.

### Prod apply (documented in the design; executed only on the owner's go-ahead)
- [ ] **AC-23:** the design doc contains a prod apply runbook for project `ebwnovzzkwhsdxkpyjka`:
  1. a read-only pre-check that re-runs the cross-store / orphan / null counts for `po_items`, the cross-store count for `order_approvals.lines`, and a count of POs whose `store_id` disagrees with any line;
  2. `execute_sql` of the migration body through the Supabase MCP;
  3. an INSERT of the **exact** migration version into `supabase_migrations.schema_migrations`;
  4. verification of each new function by normalized-md5 against the local definition, and of each trigger by presence (`pg_trigger`);
  5. a post-apply negative probe, either inside a rolled-back transaction or as a documented read-only reasoning step. Do not leave test rows in prod.
- [ ] **AC-24:** **prod apply happens only after the owner's explicit go-ahead,** and **before** the push that carries the migration to `main`. Otherwise `db-migrations-applied.yml` goes red. After the push, confirm that `test.yml` and `db-migrations-applied.yml` are both green on `main`, and check `e2e.yml` by hand (project memory).

## In scope

- One new migration that adds:
  - the R-1 trigger function and trigger on `po_items`;
  - the R-2 trigger function and trigger on `order_approvals`;
  - the R-3 guard (trigger function and trigger) on `purchase_orders`;
  - the function-privilege revokes and comments.
- New pgTAP coverage for AC-1 to AC-20.
- The prod apply runbook in the design (AC-23), and the apply itself after the owner's go-ahead.

## Out of scope (explicitly)

- **Spec 176 security Lows L1** (read the export owner at record time; a UI snapshot change), **L2** (owner checks in `fillCartForVendor` / `createPoDraft` / `approveAndOrder`), and **L3** (identity check on the stale `stores` write). These are client hardening tracked separately. This spec is server-only.
- **Any client change**, including `src/lib/db.ts`, `src/store/useStore.ts`, and UI files. R-4 is "confirm, don't change".
- **Moving an `inventory_items` row to another store.** `store_member_update_inventory_items` (per_store_rls_hardening L55-57) lets a user who can see both stores PATCH `inventory_items.store_id`. That would make existing `po_items` and approval lines cross-store after the fact. No client code writes `inventory_items.store_id` (`updateInventoryItem`'s per-store patch, db.ts ≈L520-527, has no `store_id` key). The owner did not request this. It is recorded here as a residual for a possible follow-up, and the architect should mention it in the risks.
- **Validating existing rows** (a one-off audit or a `NOT VALID` / `VALIDATE` constraint). The 2026-10-26 counts show zero bad rows, and triggers cover all new writes.
- **Replacing the trigger with a composite FK** (for example denormalizing `store_id` onto `po_items`). That would be a schema change beyond what was approved.
- **Making `upsertVendorDraftOrder`'s line replacement atomic** (the existing FOLLOW-UP in its doc comment). Unrelated.
- **Any RLS policy change, publication change, or edge function change.**
- **The `app.json` slug.** Not touched.

## Open questions resolved

All owner-approved before this spec was written:
- Q: Where should cross-store line items be rejected? → A: In the database, with BEFORE triggers on `po_items` (R-1) and `order_approvals` (R-2), modeled on `inventory_count_entries_check_store`.
- Q: Which writes fire the `po_items` check? → A: INSERT, and UPDATE OF `item_id` / `po_id` only. Receiving updates do not fire it (R-1).
- Q: Which writes fire the `order_approvals` check? → A: INSERT, and UPDATE OF `lines`. This covers the RPC, direct INSERT and pending PATCH (R-2).
- Q: Can a PO be moved to another store? → A: Not once it has lines. The architect may make `store_id` always immutable if no flow needs it (R-3).
- Q: Does existing data need a backfill? → A: No. Prod and local both have 0 bad rows (2026-10-26).
- Q: Any client change? → A: No. Confirm the existing failure handling (R-4).
- Q: Which errcode for `order_approvals`? → A: The architect decides between `42501` and `22023` and confirms the client surfaces it (R-2).
- Q: When does it go to prod? → A: Only after the owner's explicit go-ahead, and before the push (AC-24).
- Q (D-1, raised by the architect 2026-10-26): R-2's fail-closed rule breaks `order_approvals.test.sql` (nonexistent item ids) and `report_last_order_context.test.sql` (a deliberate malformed fixture). How should they be handled? → A: **Option A.** Fixture-only edits to those two files, with no assertion or plan changes (AC-16 / AC-22 amended). Owner's words, relayed by main Claude on 2026-10-26: "Option A approved: fixture-only edits to order_approvals.test.sql and report_last_order_context.test.sql, no assertion or plan changes. Record D-1 and build spec 177."

## Notes for architect (non-blocking)

- **N1. `UPDATE OF` semantics.** A column-list UPDATE trigger fires whenever the column appears in the UPDATE's SET list, even if its value is unchanged. Confirm that no writer sets `item_id` / `po_id` (or `lines`) as a pass-through. If needed, short-circuit inside the function when `tg_op = 'UPDATE'` and the relevant columns are not distinct from `old`. PostgREST PATCH sends only the keys it is given. `updatePoItemQty` sends only `ordered_qty`.
- **N2. Invoker vs definer.**
  - The precedent is SECURITY INVOKER, so "not visible to the caller" fails closed. That matches R-1's wording. Check that every legitimate writer can see both the parent and the item under its own role.
    - **Client writers** are store members of that store.
    - **The cron** is SECURITY DEFINER and never fires the trigger (receiving-only updates).
    - **`create_order_approval`** is invoker, and its caller is privileged with access to the store.
  - If you choose DEFINER for any of the triggers, record why. Revoke execute either way (R-5).
- **N3. Trigger ordering on `order_approvals`.**
  - Two BEFORE UPDATE triggers fire in name order. Decide whether the new check runs before or after `order_approvals_guard`. For example, a non-pending `lines` PATCH should still report the guard's "snapshot is immutable" error, not a store error, if that matters for the error contract.
  - Also decide whether `create_order_approval` should check store membership itself, before the write, to keep its "refuse before any write" discipline (order_approvals.sql L263-266), with the trigger as the backstop. Either way satisfies R-2.
- **N4. Performance.** The `order_approvals` check is one set-based lookup over at most 200 lines (the RPC cap). Prefer a single `not exists` / count query over a per-line loop. Note that a direct INSERT is not bound by the 200-line cap.
- **N5. Errcode consistency.** If R-2 picks `22023`, say whether R-1 and R-3 stay on `42501` (the precedent) or move too. State what the client sees for each one (HTTP status and the `notifyBackendError` text).
- **N6. Message strings.** Use stable, greppable messages, for example `'po_items: item store mismatch with parent purchase order'`, so pgTAP can match on them and future readers can find them.

## Risks

- **False rejection of a legitimate write.** That would silently break draft POs, receiving or approvals. The guards against it are AC-5, AC-6, AC-7, AC-13, AC-14, AC-16 and AC-18, and especially the unmodified existing pgTAP suites.
- **The trigger fires on receiving through a SET-list pass-through** (N1). Pinned by AC-6 through the real RPC.
- **Prod / repo drift.** If the migration is pushed before it is applied to prod, `db-migrations-applied.yml` goes red. AC-24 sets the order. The apply also needs explicit owner consent.
- **Residual vector.** `inventory_items.store_id` can still be PATCHed (see Out of scope). The server check covers writes to line tables, not moves of the referenced item.
- **Error surface.** A refusal shows up as a generic backend-error toast. That is acceptable because no legitimate flow should hit it. N5 asks the architect to state the exact text.

## Dependencies

- Spec 176 (staged): the client guards this backs up, and the out-of-scope line that names this follow-up.
- Spec 149: `order_approvals`, `tg_order_approvals_guard`, and `create_order_approval`.
- Specs 107 / 109 / 125 / 138: the `po_items` writers (draft PO, receiving RPCs, auto-receive cron, cart-filler upsert).
- The `inventory_count_entries_check_store` precedent (migration 20260513120000) and its pgTAP.
- Spec 097 (explicit grants) and spec 053 (permissive-policy lint).
- Spec 064 (`db-migrations-applied` gate) and the prod-via-MCP apply procedure (project memory).

## Project-specific notes

- **Cmd UI section / legacy:** none. This is DB only. The Cmd UI sections that write through these tables (Reorder, POs, Receiving, phone Ordering / Approve) are unchanged.
- **Per-store or admin-global:** per-store. The change enforces the per-store invariant beneath the existing `auth_can_see_store()` RLS, and RLS policies are unchanged.
- **Realtime channels touched:** none. No publication change, so the realtime container-restart gotcha does not apply.
- **Migrations needed:** yes, one new migration, timestamped after `20261024000000`. It must be applied to prod (MCP `execute_sql`, then the exact `schema_migrations` version insert, then normalized-md5 verification) after the owner's go-ahead and before the push.
- **Edge functions touched:** none. The architect confirms that `send-po-email` and `instacart-cart-link` writes do not trip the new triggers.
- **Web/native scope:** both, implicitly. It is server-side and applies to every client.
- **Test tracks:** pgTAP (new file or files) plus the `scripts/test-db.sh` lints. Jest and both typechecks run as a regression gate only. No shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/177-cross-store-item-rejection.md

---

## Backend design

Author: backend-architect, 2026-10-26. Design only. No source, migration or test file was edited.

### 0. Spec conflict and owner decision D-1: RESOLVED, option A

**Decision record (2026-10-26):** the owner chose **option A**, relayed by main Claude: "Option A approved: fixture-only edits to order_approvals.test.sql and report_last_order_context.test.sql, no assertion or plan changes. Record D-1 and build spec 177." AC-16 and AC-22 are amended to match. The analysis below is kept for the record.

R-2 says the `order_approvals` trigger **fails closed** on a missing item and on malformed `lines`. Two committed pgTAP files rely on exactly those shapes, so AC-16 ("passes **unmodified**") and AC-22 (scope fence: new test files only) cannot both hold:

| File | What it does | Effect under R-2 |
|---|---|---|
| [supabase/tests/order_approvals.test.sql:106-111](../supabase/tests/order_approvals.test.sql) | Every `create_order_approval` call (C1, C2, C3, C4, G9 fixture, C7) uses item ids `49920000-0000-0000-0000-000000000001/…0002`. No `inventory_items` row has those ids anywhere in `supabase/` (grep-verified). | C1 raises 42501 (item missing). The file fails at arm C1, and every later arm that depends on `test.approval_id` falls over with it. |
| [supabase/tests/report_last_order_context.test.sql:386-396](../supabase/tests/report_last_order_context.test.sql) | A fixture `insert into public.order_approvals` (as postgres) on purpose carries `{"item_id":"wings"}` to pin the read-side 22P02 guard (arms G1/G2). | The fixture INSERT raises 22023. The file aborts before `plan(41)` completes. |

Relaxing R-2 is **not** an option. Letting "missing" items through is a hole: a privileged caller who sees only store B gets "not found" for any store-A item id, so that is exactly the cross-store write the trigger exists to stop.

**Recommended resolution (option A): fixture-only edits, no assertion changes, `plan()` counts unchanged.**
1. `order_approvals.test.sql`: in the postgres-role fixture block (before line 133 `set local role authenticated`), add two `catalog_ingredients` rows in `test.brand_a` and two `inventory_items` rows with the **exact existing ids** `49920000-…-0001` and `…-0002`, `store_id = test.store_a` (Frederick). Every existing assertion then holds unchanged. Arm R3 calls store B but is refused at the RPC gate before any write, so it is unaffected.
2. `report_last_order_context.test.sql`: put `alter table public.order_approvals disable trigger order_approvals_lines_check_store_trg;` immediately before the existing L346 INSERT and `… enable trigger …;` immediately after it. Add a comment that the G1/G2 row models a pre-spec-177 / trigger-bypassed legacy row, and that the read-side guard stays load-bearing as defence in depth. The test runs as postgres, the table owner, inside `begin … rollback`, so the DDL is transactional and confined to the test.
3. Amend AC-16 to "passes with fixture-only additions; no assertion, plan count, or expected value changes", and extend AC-22's fence to these two files for the edits above only.

Option B is to drop or rewrite arms instead. Not recommended: it loses coverage.

**Option A was chosen.** The developer applies steps 1-2 exactly as written. Step 3 is done (AC-16 / AC-22 amended). Any edit to those two files beyond these fixture lines is out of scope and must be reported as a finding.

### 1. Decisions (the calls the spec leaves to the architect)

| # | Question | Decision | Why |
|---|---|---|---|
| D-2 | R-2 errcode | **42501** for the store-mismatch refusal. **22023** only for the malformed-`lines` branch (AC-15). | A cross-store item is a tenant/authorization violation, the same class as R-1, the precedent, and `create_order_approval`'s own `'not authorized for this store'` 42501. A malformed shape *is* an invalid parameter, and the RPC already uses 22023 for shape. So the rule is "shape → 22023, tenancy → 42501" at both layers. No client branches on either code (grep: `src/**` has no `42501`/`22023` handling outside `src/screens/staff/`, which never writes these tables). |
| D-3 | R-3 shape | **Always immutable.** Any UPDATE where `new.store_id is distinct from old.store_id` is refused, lined or not. AC-19 pins the rejection. | (a) No legitimate writer exists. Verified: no `src/**` writer; `send-po-email` updates `status` only (L205-208); `eod-reminder-cron` only reads (L335); every SQL writer (`po_loop` L265/L340/L397, `cost_on_receipt` L344, `staff_receiving_price_gate` L351, `auto_receive_due_purchase_orders` L130, `auto_place_order_attempts` L336) sets status/receive columns only. The brand/store cascade is a **DELETE** (`purchase_orders_store_id_fkey ON DELETE CASCADE`, `20260510010000` §2), and DELETE fires no UPDATE trigger. (b) **Race closure.** Under "lock once lined", tx1 can insert a line (R-1 reads parent store A, FK takes only `FOR KEY SHARE`) while tx2 moves the still-unlined PO A→B. tx2's `exists(po_items)` cannot see tx1's uncommitted row, both commit, and the result is a cross-store line. Always-immutable makes the parent store R-1 reads a constant, which removes the race. (c) It matches `tg_order_approvals_guard` block (a), where `store_id` is always immutable. Cost: a mis-filed PO must be cancelled and re-created. |
| D-4 | N1: `UPDATE OF col` fires on pass-through | **Both**: column-scoped triggers (so receiving and status writes never call the function) **and** an in-function `new` vs `old` short-circuit. | No writer passes these columns through today (verified: receiving RPCs `set received_qty` only; `updatePoItemQty` PATCHes `ordered_qty` only; `advanceOrderApproval` never sends `lines`; no PostgREST `.upsert` on `po_items`). The short-circuit makes a future pass-through (e.g. a full-row PATCH) harmless, including on a row whose item was later moved by the out-of-scope `inventory_items.store_id` vector. Pinned by T16, T34 and T48. |
| D-5 | Invoker vs definer | **SECURITY INVOKER for all three**, `set search_path = public`. | Every legitimate writer can see both sides under its own role. R-1: the `po_items` INSERT policy already requires the parent store to be visible, and a same-store item is visible under `store_member_read_inventory_items`. R-2: the INSERT/UPDATE policies require `auth_is_privileged() and auth_can_see_store(store_id)`, so same-store items are visible, and `create_order_approval` is invoker. R-3 reads nothing. Only items that *should* be refused can be invisible, so invoker can only fail closed. DEFINER would widen the read surface for no gain. The cron and receiving RPCs never fire R-1 (D-4). |
| D-6 | N3: trigger order on `order_approvals` | New trigger is named `order_approvals_lines_check_store_trg`. BEFORE triggers fire in name order, and `order_approvals_guard` < `order_approvals_lines_check_store_trg` (`g` < `l`), so **the guard runs first**. | A `lines` PATCH on a non-pending row keeps reporting the guard's P0001 `'order approval snapshot is immutable once approved'` (T37 pins it). Store-id changes are refused by guard (a) before the store check runs, so the short-circuit's "store_id unchanged" assumption always holds on UPDATE. INSERT fires only the new trigger. |
| D-7 | N3: should `create_order_approval` check store membership itself? | **No. Leave the RPC byte-identical.** The trigger is the single enforcement point. | A BEFORE-INSERT/UPDATE raise inside the RPC aborts the statement, so no row is written and "refuse before any write" holds by atomicity. Re-creating the RPC would add a function to the md5 verification and risk C1-C7 for no observable gain. Error ordering is unchanged: the RPC's 22023 shape checks, 42501 gates and P0002 vendor check all run before the INSERT/UPDATE that fires the trigger. The 42501 is not `unique_violation`, so the RPC's S-3 handler (L408) does not swallow it. |
| D-8 | N5: errcode consistency | R-1 **42501**, R-2 **42501** (store) / **22023** (shape), R-3 **42501**. | One rule for the whole migration: store-consistency refusals are 42501. |

### 2. Data model changes

**Migration:** `supabase/migrations/20261025000000_cross_store_item_rejection.sql`. This is the next daily slot after the newest file on disk, `20261024000000_eod_entries_no_need.sql`. Spec 176 adds no migration.

**Strictly additive.** Three functions, three triggers, three comments, three revokes. No table, column, index, policy, publication or existing function changes. No backfill (prod 0 bad rows on 2026-10-26; re-checked in the runbook). Wrap the body in `begin; … commit;` with `set local lock_timeout = '5s';` at the top. `CREATE TRIGGER` takes a brief SHARE ROW EXCLUSIVE lock on each table, and the timeout keeps a busy table from queueing traffic behind the DDL.

**Header:** a PROD-APPLY note in the `20260801000100_order_approvals.sql` L20-23 style. It must name the exact version `20261025000000`, say "VERIFY the three functions by NORMALIZED-MD5 and the three triggers by PRESENCE (`pg_trigger`, `tgenabled = 'O'`)", and note no publication change, so no realtime restart.

**Function 1: `public.po_items_check_store() returns trigger`**, plpgsql, `security invoker`, `set search_path = public`. Pseudocode:
```
if tg_op = 'UPDATE'
   and new.item_id is not distinct from old.item_id
   and new.po_id   is not distinct from old.po_id then
  return new;                                   -- D-4 short-circuit
end if;
select store_id into v_po_store from purchase_orders where id = new.po_id;
if v_po_store is null then                      -- missing, invisible, or null store_id
  raise 'po_items: parent purchase order not found, not visible, or has no store' (42501);
end if;
if new.item_id is null then raise <mismatch> (42501); end if;
select store_id into v_item_store from inventory_items where id = new.item_id;
if v_item_store is null or v_item_store <> v_po_store then
  raise 'po_items: item store mismatch with parent purchase order' (42501);
end if;
return new;
```
Trigger: `po_items_check_store_trg BEFORE INSERT OR UPDATE OF item_id, po_id ON public.po_items FOR EACH ROW`. There are no other triggers on `po_items`. A BEFORE-row trigger runs before RLS WITH CHECK, so the "parent not visible" case reports this function's message, not the generic RLS message (T14 pins it).

**Function 2: `public.order_approvals_lines_check_store() returns trigger`**, plpgsql, `security invoker`, `set search_path = public`. Pseudocode (two set-based statements, no per-line loop, N4):
```
if tg_op = 'UPDATE' and new.lines is not distinct from old.lines then
  return new;                                   -- D-4; store_id immutability is guaranteed by the guard (D-6)
end if;
-- (1) SHAPE. Only what the store check needs. Never casts.
if jsonb_typeof(new.lines) is distinct from 'array'
   or exists (select 1 from jsonb_array_elements(new.lines) e
               where jsonb_typeof(e) <> 'object'
                  or not pg_input_is_valid(coalesce(e->>'item_id', ''), 'uuid')) then
  raise 'order_approvals: lines must be an array of objects with a uuid item_id' (22023);
end if;
-- (2) STORE. The ::uuid cast runs only after (1) has proven every element valid.
if exists (select 1 from jsonb_array_elements(new.lines) e
            where not exists (select 1 from inventory_items ii
                               where ii.id = (e->>'item_id')::uuid
                                 and ii.store_id = new.store_id)) then
  raise 'order_approvals: line item store mismatch with approval store' (42501);
end if;
return new;
```
Notes:
- `pg_input_is_valid` (PG16+) uses the same uuid input function as the RPC's cast-in-exception-block (L335-340). So the two layers agree byte-for-byte on what counts as a uuid, with no exception handler and no 22P02 escape (AC-15).
- Do **not** merge (1) and (2) into one predicate. SQL does not guarantee `AND`/`OR` short-circuit order, so the cast could run on an invalid element.
- An empty array `[]` passes vacuously. This is a store check, not a cardinality check, and the RPC enforces 1..200. Not pinned by a test, so a future cardinality CHECK is a free choice.
- Trigger: `order_approvals_lines_check_store_trg BEFORE INSERT OR UPDATE OF lines ON public.order_approvals FOR EACH ROW`.

**Function 3: `public.purchase_orders_lock_store_id() returns trigger`**, plpgsql, `security invoker`, `set search_path = public`:
```
if new.store_id is distinct from old.store_id then
  raise 'purchase_orders: store_id is immutable' (42501);
end if;
return new;
```
Trigger: `purchase_orders_lock_store_id_trg BEFORE UPDATE OF store_id ON public.purchase_orders FOR EACH ROW`. The other triggers on this table are `set_po_number` (BEFORE INSERT) and `notify_purchase_order` (AFTER), so there is no ordering interaction. FK `ON DELETE SET NULL` actions on `created_by` / `received_by` (`20260528000000`) update other columns, so this trigger does not fire for them.

**Privileges (R-5):** after each function, `revoke execute on function public.<fn>() from public, anon, authenticated;` (the precedent at `order_approvals.sql` L207-208). This is required, not cosmetic: spec 097's `ALTER DEFAULT PRIVILEGES … ON functions` grants new functions to anon/authenticated. Postgres does not check EXECUTE when a trigger fires, so the revoke cannot break writes. T05 and T28 (lives_ok as `authenticated`) prove that empirically. Add a `comment on function` for each, naming spec 177 and the message strings.

**Lints:** `public_grants_explicit.test.sql` asserts **table** SELECT grants only, and no table is added, so it is unaffected. `permissive_policy_lint.test.sql` is unaffected because no policy is added or changed.

### 3. RLS impact

None. No policy is created, dropped or altered. The triggers enforce the per-store invariant *beneath* the unchanged `auth_can_see_store()` policies on `po_items` (`per_store_rls_hardening` L206-250), `purchase_orders` (L186-201) and `order_approvals` (`order_approvals.sql` L244-257).

### 4. API contract

No new endpoint, RPC or view. The existing PostgREST and RPC surfaces gain these refusals:

| Write | Refusal | SQLSTATE | PostgREST HTTP | Message (stable, greppable) |
|---|---|---|---|---|
| `po_items` INSERT / UPDATE of `item_id`/`po_id`, parent missing, invisible or storeless | R-1 | 42501 | 403 | `po_items: parent purchase order not found, not visible, or has no store` |
| same, item null, missing, invisible or another store's | R-1 | 42501 | 403 | `po_items: item store mismatch with parent purchase order` |
| `order_approvals` INSERT / UPDATE of `lines` (RPC or direct), malformed `lines` | R-2 | 22023 | 400 | `order_approvals: lines must be an array of objects with a uuid item_id` |
| same, any line not an `inventory_items` row of `new.store_id` | R-2 | 42501 | 403 | `order_approvals: line item store mismatch with approval store` |
| `purchase_orders` UPDATE changing `store_id` | R-3 | 42501 | 403 | `purchase_orders: store_id is immutable` |

A multi-row PostgREST insert (`createPurchaseOrderDraft`, `upsertVendorDraftOrder`) is one statement, so one bad line refuses the **whole batch** atomically. No partial line set is ever written.

### 5. Edge functions

None changed. Confirmed against the new triggers:
- `send-po-email` writes `purchase_orders.status` only (L205-208). R-3 is not fired; it is column-scoped to `store_id`.
- `instacart-cart-link` writes `external_ref`, `external_ref_expires_at`, `status` (L675-681), never `lines`. R-2 is not fired. The guard behaves as before.
- `eod-reminder-cron` only reads `purchase_orders` (L335).
- No function writes `po_items`.

### 6. `src/lib/db.ts` surface and client writers (R-4: confirm, change nothing)

No new helper and no mapping change. How each writer surfaces a refusal:

| Writer | Trigger hit | Behaviour on refusal | User-visible |
|---|---|---|---|
| `createPurchaseOrderDraft` lines insert (db.ts L1805-1822), via `useStore.createPoDraft` (L3873-3884) | R-1 | `console.warn`, best-effort header DELETE, returns `null` | Toast **"Create PO draft failed"** / "Draft not created" |
| `upsertVendorDraftOrder` UPDATE path insert (L1928-1932), via `fillCartForVendor` (L3948-3957) | R-1 | returns `null` **before** the old-line delete, so prior lines are intact. Edit buffer kept for retry. | **"Fill cart failed"** / "Draft not created" |
| `upsertVendorDraftOrder` INSERT path (L1975-1984), via `fillCartForVendor` or `recordExportedOrder` (L4063-4074) | R-1 | best-effort header DELETE, returns `null` | **"Fill cart failed"** / "Draft not created", or **"Record exported order failed"** / "Draft not recorded" |
| `updatePoItemQty` (L2013-2023) | none (PATCHes `ordered_qty` only) | unchanged | none |
| `deletePoItem` (L2030-2040) | none (DELETE) | unchanged | none |
| `createOrderApproval` (L2636-2659) → `approveAndOrder` (useStore L4323-4334) → `PhoneApproveOrder` (L239) | R-2 | PostgREST error thrown, `notifyBackendError('Approve & order', e)`, returns `null`. `approval` state is not set. `PhoneApproveOrder` sets `lastAttemptFailed`. | **"Approve & order failed"** / `order_approvals: line item store mismatch with approval store` (or the 22023 shape text) |
| `advanceOrderApproval` (L2688-2716) | none (never sends `lines`) | unchanged | none |
| `receivePurchaseOrder` RPC (db.ts ≈L2043, useStore L4379) and staff `receiving.ts` RPCs | none (`set received_qty` only) | unchanged | none |
| any `purchase_orders.store_id` writer | R-3 | none exists | n/a |

`sessionWatch` does not react to 42501 from writes (it is a session-event watcher), so a 403 here cannot trigger a sign-out path.

**R-4 finding (Minor, pre-existing, NOT fixed here):** both orphan-header cleanups (`createPurchaseOrderDraft` L1820, `upsertVendorDraftOrder` L1982) ignore the DELETE's error and run outside `abortSignal`. If that DELETE fails (network drop between the two calls), an empty `draft` header is left behind. `report_reorder_list.has_po` then reports a PO for that vendor and date. The next Fill cart on the same key re-finds the header and refills it, so it self-heals on that path only. The new trigger makes this path reachable on a cross-store bug, where before it was reachable only on an RLS/network failure. Candidate for the deferred atomic-replace RPC follow-up.

### 7. Realtime impact

None. No `supabase_realtime` publication change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply. Refused writes emit no change events. Accepted writes replay exactly as today on `store-{id}`.

### 8. Frontend store impact

None. No slice changes. The existing failure handling in §6 already follows the optimistic-then-revert / `notifyBackendError` contract (Fill cart keeps its buffer, and Approve & order leaves `approval` untouched).

### 9. pgTAP: `supabase/tests/cross_store_item_rejection.test.sql` (new, one file)

Header and isolation style follow [inventory_count_entries_check_store.test.sql](../supabase/tests/inventory_count_entries_check_store.test.sql) and [order_approvals.test.sql](../supabase/tests/order_approvals.test.sql): `begin; create extension if not exists pgtap; select plan(54); … select * from finish(); rollback;`. Every `throws_ok` asserts **both** SQLSTATE and the **exact** message (precedent L101-104). JWT impersonation uses `set local role authenticated` + `request.jwt.claims`.

**Fixtures (as postgres, before any `set role`):**
- Stores: **A = Charles**, **B = Frederick** (seed lookups by name, as in the precedent).
- Principals: **master** `3333…` (`app_metadata.role = 'master'`, sees both; the `po_loop.test.sql` pattern) for R-1/R-3. **admin** `1111…` (`'admin'`, privileged, sees brand A; the `order_approvals.test.sql` pattern) for R-2. **manager** `2222…` (`'user'`, Frederick + Towson only) as the one-store caller.
- Rows: catalog rows in brand A. Items `item_A` (Charles), `item_B` and `item_B2` (Frederick), with fixed literal ids under a `c1770000-…` prefix. POs: `PO_A` (Charles, draft) with line `line_A` (item_A); `PO_B` (Frederick, draft) with line `line_B` (item_B); `PO_B2` (Frederick, **sent**) with one item_B line; `PO_E` (Frederick, draft, **no lines**); `PO_N` (`store_id` null). One brand-A vendor with null `order_channel` (resolves `manual`).
- Business dates are distinct per R-2 case so the idempotency key never couples arms.

| # | AC | Caller | Case | Expect |
|---|---|---|---|---|
| T01 | — | master | `auth_can_see_store(A) and auth_can_see_store(B)` | `ok` (anti-vacuity: the cross-store cases are not RLS-hidden) |
| T02 | — | admin | same | `ok` |
| T03 | AC-1 | master | INSERT (PO_B, item_A) | 42501 item-mismatch msg |
| T04 | AC-1 | master | count (PO_B, item_A) | 0 |
| T05 | AC-5 | master | INSERT (PO_B, item_B) with fixed id | `lives_ok` (also proves the revoke doesn't block firing) |
| T06 | AC-5 | master | that row exists with item_B | 1 |
| T07 | AC-2 | master | UPDATE line_B set item_id = item_A | 42501 item-mismatch |
| T08 | AC-2 | master | line_B.item_id | = item_B |
| T09 | AC-3 | master | UPDATE line_A set po_id = PO_B | 42501 item-mismatch |
| T10 | AC-3 | master | line_A.po_id | = PO_A |
| T11 | AC-4 | master | INSERT (PO_B, null) | 42501 item-mismatch |
| T12 | AC-4 | master | INSERT (random uuid po, item_B) | 42501 parent msg |
| T13 | AC-4 | postgres (`reset role`) | INSERT (PO_N, item_B) | 42501 parent msg (null-store branch, parent visible) |
| T14 | AC-4 | manager | INSERT (PO_A, item_A) | 42501 parent msg (parent invisible; trigger runs before WITH CHECK) |
| T15 | AC-4 | manager | INSERT (PO_B, item_A) | 42501 item-mismatch (item invisible: the precedent's case) |
| T16 | N1 | master | UPDATE line_B set item_id = item_id, po_id = po_id | `lives_ok` |
| T17 | AC-6 | master | UPDATE line_B set received_qty, cost_per_unit, ordered_qty | `lives_ok` |
| T18 | AC-6 | master | the three values | changed |
| T19 | AC-6 | master | `select public.receive_purchase_order(PO_B2, '[{"po_item_id":…,"received_qty":…}]', gen_random_uuid())` | `lives_ok` (call shape per `po_loop.test.sql` arm A) |
| T20 | AC-6 | master | PO_B2 line received_qty | = submitted qty |
| T21 | AC-8 | admin | `create_order_approval(B, vendor, d1, [item_A])` | 42501 store-mismatch |
| T22 | AC-8 | admin | count (B, vendor, d1) | 0 |
| T23 | AC-9 | admin | RPC d2, [item_B, item_A] | 42501 store-mismatch |
| T24 | AC-9 | admin | count d2 | 0 |
| T25 | AC-10 | admin | direct INSERT (B, d3, `approved_by = auth.uid()`, channel 'manual', [item_A]) | 42501 store-mismatch |
| T26 | AC-10 | admin | count d3 | 0 |
| T27 | R-2 fail-closed | admin | direct INSERT d4, [nonexistent uuid] | 42501 store-mismatch |
| T28 | AC-13 | admin | RPC d5, [item_B] | row `status = 'pending'`, `line_count = 1` |
| T29 | AC-13 | admin | RPC retry d5, [item_B, item_B2] | `line_count = 2` and `lines` contains item_B2 |
| T30 | AC-11 | admin | direct UPDATE d5 row set lines = [item_A] | 42501 store-mismatch |
| T31 | AC-11 | admin | d5 lines | = T29's lines |
| T32 | AC-12 | admin | RPC retry d5, [item_A] | 42501 store-mismatch |
| T33 | AC-12 | admin | d5 lines | = T29's lines |
| T34 | N1 | admin | UPDATE d5 set lines = lines | `lives_ok` |
| T35 | AC-14 | admin | UPDATE d5 set status = 'approved', external_ref = 'https://…' | `lives_ok` |
| T36 | AC-14 | admin | status/external_ref | approved / set |
| T37 | N3/D-6 | admin | UPDATE d5 (now approved) set lines = [item_A] | **P0001** `order approval snapshot is immutable once approved` (guard wins) |
| T38 | AC-15 | admin | direct INSERT d6, lines = `{"item_id":"<item_B>"}` (object) | 22023 shape msg |
| T39 | AC-15 | admin | d7, `[{"item_name":"x"}]` | 22023 shape msg |
| T40 | AC-15 | admin | d8, `[{"item_id":"wings"}]` | 22023 shape msg |
| T41 | AC-15 | admin | d9, `["x"]` | 22023 shape msg |
| T42 | AC-15 | admin | count d6-d9 | 0 |
| T43 | AC-17 | master | UPDATE PO_A set store_id = B | 42501 `purchase_orders: store_id is immutable` |
| T44 | AC-17 | master | PO_A.store_id and line_A.po_id | A / PO_A |
| T45 | AC-18 | master | UPDATE PO_B set total_cost = 123.45, status = 'sent' | `lives_ok` |
| T46 | AC-18 | master | values | changed |
| T47 | AC-19 | master | UPDATE PO_E (unlined) set store_id = A | 42501 immutable (always-immutable, D-3) |
| T48 | N1 | master | UPDATE PO_E set store_id = store_id | `lives_ok` |
| T49-T51 | AC-20 | postgres | per function: `not has_function_privilege('anon', …,'EXECUTE')`, the same for `'authenticated'`, and `proacl is not null and not exists (select 1 from aclexplode(proacl) where grantee = 0 and privilege_type = 'EXECUTE')` (a NULL `proacl` means PUBLIC still has the default grant) | `ok` × 3 |
| T52 | D-5 | postgres | all three `prosecdef = false` | `ok` (structural pin, like `report_last_order_context` P5) |
| T53 | — | postgres | the three triggers exist in `pg_trigger` with `tgenabled = 'O'` on the right tables | count = 3 |
| T54 | D-6 | postgres | `array_agg(tgname order by tgname)` of non-internal BEFORE-UPDATE triggers on `order_approvals` | `{order_approvals_guard, order_approvals_lines_check_store_trg}` |

If T14 reports the generic RLS message rather than the trigger's, **report it, do not loosen the assertion.** It would mean the trigger/WITH CHECK ordering assumption is wrong.

**AC-7 / AC-16 audit of existing suites (done at design time):** every committed file that writes `po_items` uses same-store fixtures, so they pass unmodified: `po_loop`, `auto_receive_due_purchase_orders`, `cost_on_receipt` (incl. the Charles item on the Charles PO, L817-833), `staff_receiving_gate` (incl. L562-573), `extension_ordering`, `audit_log_rls_hardening`, `report_run_vendor`, `report_run_variance_formula`, `report_reorder_list_no_inbound`, and the `po_items` half of `report_last_order_context`. No suite updates `purchase_orders.store_id`. `generate_po_number_malformed_guard` inserts null-store POs but never updates them. The two `order_approvals` conflicts are in §0.

### 10. Prod apply runbook (AC-23/AC-24). Execute only on the owner's explicit go-ahead, and BEFORE the push.

Project `ebwnovzzkwhsdxkpyjka`, Supabase MCP `execute_sql`. **Do not use `apply_migration`**: it mints its own version.

**Step 1: read-only pre-check.** STOP and report to the owner on any unexpected value.
```sql
select version();                                   -- expect PostgreSQL 17.x (pg_input_is_valid needs >= 16)
select version from supabase_migrations.schema_migrations
 where version >= '20261024000000' order by 1;      -- expect exactly '20261024000000'
select to_regprocedure('public.po_items_check_store()'),
       to_regprocedure('public.order_approvals_lines_check_store()'),
       to_regprocedure('public.purchase_orders_lock_store_id()');   -- expect 3 × NULL
-- po_items integrity (expect 0 / 0 / 0 / 0; total ≈ 40)
select count(*) filter (where pi.item_id is null)                                   as null_item,
       count(*) filter (where pi.item_id is not null and ii.id is null)             as orphan_item,
       count(*) filter (where po.id is null)                                        as orphan_po,
       count(*) filter (where ii.id is not null and po.id is not null
                          and ii.store_id is distinct from po.store_id)             as cross_store_lines,
       count(distinct po.id) filter (where ii.id is not null
                          and ii.store_id is distinct from po.store_id)             as pos_disagreeing_with_a_line,
       count(*)                                                                     as total
  from public.po_items pi
  left join public.inventory_items ii on ii.id = pi.item_id
  left join public.purchase_orders po on po.id = pi.po_id;
-- order_approvals.lines (expect 0 rows total today; else malformed = 0 and cross_or_missing = 0)
select count(*) filter (where not ok_shape) as malformed,
       count(*) filter (where ok_shape and not exists (
         select 1 from public.inventory_items ii
          where ii.id = case when ok_shape then (e->>'item_id')::uuid end
            and ii.store_id = x.store_id))  as cross_or_missing
  from (select oa.store_id, e,
               (jsonb_typeof(e) = 'object'
                and pg_input_is_valid(coalesce(e->>'item_id',''), 'uuid')) as ok_shape
          from public.order_approvals oa,
               jsonb_array_elements(case when jsonb_typeof(oa.lines) = 'array'
                                         then oa.lines else '[]'::jsonb end) e) x;
select count(*) from public.order_approvals where jsonb_typeof(lines) <> 'array';   -- expect 0
select count(*) from public.purchase_orders where store_id is null;                 -- informational: these can never be re-homed via PostgREST after apply (D-3)
-- FK actions: po_items.item_id must be confdeltype 'a' (NO ACTION). If it is 'n' (SET NULL), STOP:
-- an inventory_items delete would fire R-1 via SET NULL and fail closed.
-- purchase_orders.store_id must be confdeltype 'c' / confupdtype 'a'.
select conrelid::regclass, conname, confdeltype, confupdtype, pg_get_constraintdef(oid)
  from pg_constraint
 where contype = 'f' and conrelid in ('public.po_items'::regclass, 'public.purchase_orders'::regclass);
-- Existing triggers. Expect: order_approvals → order_approvals_guard;
-- po_items → none; purchase_orders → notify_purchase_order, set_po_number.
select tgrelid::regclass, tgname, tgenabled from pg_trigger
 where not tgisinternal
   and tgrelid in ('public.po_items'::regclass, 'public.order_approvals'::regclass, 'public.purchase_orders'::regclass)
 order by 1, 2;
```

**Step 2: apply.** `execute_sql` the committed migration body verbatim (its own `begin; … commit;`). Per project memory, prefer the exact pgTAP-tested function bodies (`pg_get_functiondef` dumped from local after `npx supabase db reset`).

**Step 3: record.**
```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20261025000000', 'cross_store_item_rejection')
on conflict (version) do nothing;
```
The version must byte-match the filename.

**Step 4: verify.** Run each query on prod and locally (`docker exec supabase_db_imr-inventory psql -At -c …`); the values must be equal.
```sql
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.po_items_check_store()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.order_approvals_lines_check_store()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.purchase_orders_lock_store_id()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select p.proname, p.prosecdef, p.proacl,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('po_items_check_store','order_approvals_lines_check_store','purchase_orders_lock_store_id');
                                   -- expect prosecdef false, anon_x/auth_x false, no '=X/' PUBLIC entry in proacl
select tgrelid::regclass, tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
 where tgname in ('po_items_check_store_trg','order_approvals_lines_check_store_trg','purchase_orders_lock_store_id_trg');
                                   -- expect 3 rows, tgenabled 'O', the event lists from §2
```

**Step 5: post-apply negative probe** (read-only reasoning plus a **rolled-back** probe; leaves no rows):
```sql
begin;
  -- pick any existing line and any item of a DIFFERENT store, then:
  update public.po_items set item_id = (select ii.id from public.inventory_items ii
                                          join public.purchase_orders po on po.id = <line.po_id>
                                         where ii.store_id <> po.store_id limit 1)
   where id = <existing po_items.id>;          -- expect ERROR 42501 'po_items: item store mismatch …'
rollback;
```
The probe runs as postgres (RLS bypassed), so it proves the trigger fires regardless of caller. If the MCP session cannot hold an explicit transaction across statements, skip the probe and rely on Step 4 plus the local pgTAP run (a documented reasoning step).

**Step 6: push, then gates.** Commit and push to `main` only **after** steps 2-4. Pushing first hard-fails `db-migrations-applied.yml`. Then confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green (`gh run list --branch main --workflow <file> --limit 1`), and check `e2e.yml` by hand (project memory).

**Rollback:** pure DDL, no data written. `drop trigger … ; drop function …;` for the three objects restores the prior state exactly. Roll back the DB on its own; no client is coupled to it.

### 11. Risks and tradeoffs

1. **Spec conflict (§0)** is resolved by D-1 = option A. Residual risk: a fixture edit that drifts beyond AC-16's allowance. Reviewers diff those two files against AC-16.
2. **False rejection of a legitimate write.** Mitigated by column-scoped triggers plus the short-circuit (D-4), invoker visibility analysis (D-5), and the unmodified-suite audit (§9). The highest-risk path, receiving, never fires R-1. T19 proves it through the real RPC.
3. **Residual vector (out of scope, owner-acknowledged).** `inventory_items.store_id` stays PATCHable by a two-store user (`store_member_update_inventory_items`). Moving an item makes existing lines and approvals cross-store after the fact, and an R-1 insert can race a concurrent item move. Follow-up candidate: the same `is distinct from` immutability lock on `inventory_items.store_id` (verify no writer first; `updateInventoryItem` sends no `store_id`).
4. **Always-immutable consequence (D-3).** A mis-filed or null-store PO cannot be re-homed via PostgREST. Cancel and re-create instead. An ops repair as postgres needs `alter table … disable trigger` inside a transaction.
5. **Performance.** R-1 does two PK lookups per inserted row (a draft of ~50 lines is negligible). R-2 does one set-based pass. The RPC caps it at 200 lines; a direct INSERT is bounded only by the PostgREST request size, which is still PK lookups. Irrelevant at seed scale (0 local `po_items` / `order_approvals`). No edge function is involved, so there is no cold-start impact.
6. **Migration ordering.** Independent of spec 176 (no `supabase/` overlap). Must sort after `20261024000000`. The runbook pre-check also catches any undeclared prod version ≥ that.
7. **Error surface.** Refusals reach users only as the generic toasts in §6. That is acceptable because no legitimate flow should hit them. The Approve & order toast shows the raw trigger message.
8. **Pre-existing observation (NOT in scope, surfaced for the owner).** `tg_order_approvals_guard` block (a) treats `approved_by` and `source_submission_id` as always-immutable. Both FKs are `ON DELETE SET NULL` (`order_approvals.sql` L37, L48), and an FK SET NULL action fires BEFORE UPDATE triggers. So deleting a profile that approved an order (delete-user), or an `eod_submissions` row an approval points at, should fail with `'order approval is immutable'`. It is latent today (prod has 0 approvals). Spec 177's new trigger is unaffected (`UPDATE OF lines`). Worth a follow-up question. Not fixed here.

### 12. Files the build will add or change

- **Add:** `supabase/migrations/20261025000000_cross_store_item_rejection.sql`
- **Add:** `supabase/tests/cross_store_item_rejection.test.sql`
- **Change (D-1 = option A, per AC-16):** `supabase/tests/order_approvals.test.sql` (fixture rows only), `supabase/tests/report_last_order_context.test.sql` (disable/enable-trigger wrapper around the existing fixture INSERT only)
- **Not touched:** `src/**`, `supabase/functions/**`, `app.json`

Gates (AC-21): `scripts/test-db.sh` (all pgTAP incl. both lints), full `npx jest`, `npm run typecheck`, `npm run typecheck:test`.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/177-cross-store-item-rejection.md

## Files changed

Implemented by backend-developer, 2026-10-26. Applied to the LOCAL stack only (`npx supabase migration up --local`). Prod is NOT applied; the §10 runbook runs only on the owner's go-ahead.

**Migrations**
- `supabase/migrations/20261025000000_cross_store_item_rejection.sql` (new): `po_items_check_store()` + `po_items_check_store_trg`, `order_approvals_lines_check_store()` + `order_approvals_lines_check_store_trg`, `purchase_orders_lock_store_id()` + `purchase_orders_lock_store_id_trg`, the three comments and the three revokes.

**pgTAP**
- `supabase/tests/cross_store_item_rejection.test.sql` (new): design §9 T01-T54, `plan(54)`.
- `supabase/tests/order_approvals.test.sql` (AC-16 fixture-only): two brand-A `catalog_ingredients` rows plus two `inventory_items` rows with the existing literal ids `49920000-…-0001` / `…-0002` in `test.store_a`. Additions only (17 lines), no assertion, expected value or `plan()` change.
- `supabase/tests/report_last_order_context.test.sql` (AC-16 fixture-only): `disable trigger` / `enable trigger order_approvals_lines_check_store_trg` around the existing `order_approvals` fixture INSERT, plus an explanatory comment. Additions only (10 lines), no assertion, expected value or `plan()` change.

**Not touched:** `src/**`, `src/lib/db.ts`, `supabase/functions/**`, `app.json`, `supabase/config.toml`.

**Implementation note for drift review (one deviation from the §2 pseudocode, behaviour-preserving):** in `order_approvals_lines_check_store()` step (1), the `jsonb_array_elements` argument is wrapped as `case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end`. Without it, the shape check relies on the `OR` evaluating left to right. If it did not, a non-array `lines` would make `jsonb_array_elements` raise its own 22023 ("cannot extract elements from an object") instead of the stable message. This applies the design's own "no AND/OR evaluation-order reliance" rule. Accepted and refused sets are unchanged (T38 and T41 pin it).

**Gate results (local, 2026-10-26)**
- `scripts/test-db.sh`: 91/91 files passed, 1301 assertions, including `cross_store_item_rejection` (54), `order_approvals` (24), `report_last_order_context` (41), `po_loop` (30), `auto_receive_due_purchase_orders` (24), `cost_on_receipt` (55), `staff_receiving_gate` (45), `public_grants_explicit` (13) and `permissive_policy_lint` (5).
- Negative control: a scratch copy of the new file with the three triggers disabled fails 32/54 arms (every rejection and anti-vacuity arm, plus T53).
- D-1 confirmation: the HEAD versions of the two AC-16 files fail under the new trigger as §0 predicted (`order_approvals` at C1 with 42501, `report_last_order_context` at the fixture INSERT with 22023). With the fixture edits both pass.
- `npx jest`: 266/266 suites, 3334/3334 tests.
- `npm run typecheck` and `npm run typecheck:test`: both exit 0.

**Local normalized-md5 (for runbook Step 4):** `po_items_check_store` `ec2c92efed047dcf53d10e5ac1017b24`; `order_approvals_lines_check_store` `71491c6fa58d6174bd4a633dd115bc03`; `purchase_orders_lock_store_id` `d357ad345b4b38f2ea34bfd25eef06d2`.
