## Security audit for spec 177

Auditor: security-auditor, 2026-10-26. Read-only review of the working tree. The only DB activity was probes against the LOCAL stack (`supabase_db_imr-inventory`). Every probe ran inside `begin … rollback`. Prod was not touched.

Files reviewed:
- `supabase/migrations/20261025000000_cross_store_item_rejection.sql` (new)
- `supabase/tests/cross_store_item_rejection.test.sql` (new)
- `supabase/tests/order_approvals.test.sql` (fixture diff)
- `supabase/tests/report_last_order_context.test.sql` (fixture diff)

Context read to check write-path coverage:
- `20260801000100_order_approvals.sql` (guard and `create_order_approval`)
- the per-store RLS policies (checked live in `pg_policy`)
- `src/lib/db.ts` L1786-2040
- `supabase/functions/{send-po-email,instacart-cart-link,pwa-catalog}`
- every migration that writes `po_items`, `purchase_orders` or `order_approvals`

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- **L1. The documented residual is wider than the spec says. Item id reuse or an id PATCH re-homes `order_approvals.lines`.**
  - **Where:** `specs/177-cross-store-item-rejection.md` "Out of scope" (L143) and design §11 risk 3. They list only `inventory_items.store_id` PATCH as the remaining vector. The R-2 check lives at `supabase/migrations/20261025000000_cross_store_item_rejection.sql:128-185`.
  - **Why it happens:** `order_approvals.lines[].item_id` is jsonb, so no FK protects it. Two more moves re-home an existing approval's lines after the fact, and neither fires R-2:
    - (a) DELETE the store-B item, then INSERT a new `inventory_items` row in store A with the **same id**;
    - (b) PATCH `inventory_items.id`. `store_member_update_inventory_items` permits any column.
  - **Verified locally (rolled back):** a privileged two-store caller (`admin` 1111) created a pending store-B approval naming B's item, deleted that item, and re-inserted the same id under Charles. The approval's line then resolves to a Charles item. The id PATCH was also accepted.
  - **`po_items` is not exposed to this variant:** `po_items_item_id_fkey` has `confdeltype`/`confupdtype` = `a` (NO ACTION), so a referenced item can't be deleted or re-keyed. Only the documented `store_id` PATCH still reaches `po_items`.
  - **Impact:** low.
    - It needs delete rights in B and insert rights in A on a known id, which in practice means a two-store caller.
    - It forges no new line. It only re-points a frozen snapshot.
    - Readers stay store-scoped: `report_last_order_context` is SECURITY INVOKER and joins inside the store's own item universe, so a re-homed id just drops out.
    - `instacart-cart-link` reads lines with the caller's token, not service_role.
  - **Fix:** no change in this spec. When the follow-up named in design §11.3 is written, its `inventory_items` immutability trigger should lock **both** `id` and `store_id` (`new.id is distinct from old.id or new.store_id is distinct from old.store_id`). It should also record that id reuse after a delete can't be closed without an FK or a tombstone. Add one sentence to §11.3 now so the follow-up's scope is accurate.

### Verification notes (checked, no finding)

**Write-path coverage.**
- **`po_items`:**
  - Every INSERT comes from the client (`db.ts` L1806, L1929, L1976), and R-1 covers all three.
  - The SQL writers (`po_loop` L227, `cost_on_receipt` L208, `staff_receiving_price_gate` L200, the `auto_receive_due_purchase_orders` L111 cron) only `set received_qty`. They never fire the column-scoped trigger.
  - No edge function writes `po_items`.
  - Probed locally and refused with 42501: `INSERT … ON CONFLICT (id) DO UPDATE SET item_id = <A item>`, `UPDATE … FROM inventory_items` re-pointing, and a multi-row batch with one bad line. The batch was atomic and left 0 extra rows.
- **`order_approvals`:**
  - Covered paths: the RPC insert and both retry UPDATEs (`order_approvals.sql` L400, L424, L437), a direct PostgREST INSERT, a direct pending PATCH, and `INSERT … ON CONFLICT DO UPDATE SET lines` (probed: 42501).
  - A duplicate-key object (`{"item_id":B,"item_id":A}`) resolves last-wins in jsonb and is refused (probed: 42501).
  - The RPC's `exception when unique_violation` handler doesn't catch 42501, so the trigger's refusal propagates.
  - `instacart-cart-link` writes only `external_ref`/`status` (L675-681), so it never fires R-2.
- **`purchase_orders.store_id`:** no client, SQL or edge writer changes it. `send-po-email` L205-206 updates `status` only. The brand/store cascade is a DELETE. R-3 is always-immutable, which removes the insert-vs-move race the design describes.
- **Trigger ordering.** No other BEFORE trigger on `po_items` or `order_approvals` rewrites `item_id`/`po_id`/`lines` after these checks, so no later trigger can undo a check (verified in `pg_trigger`). `order_approvals_guard` has no role bypass, so `store_id` really is immutable on UPDATE, and R-2's UPDATE short-circuit (L137) is sound.

**SECURITY INVOKER posture.**
- No false accept is possible. The checks compare the row's own `store_id` values, and RLS can only hide rows (which fails closed). It cannot change a visible row's `store_id`.
- service_role and postgres callers (SECURITY DEFINER bodies, cron, edge functions with service role) bypass RLS but still go through the equality check. A trigger is not RLS, so the check applies to every caller.
- `search_path = public` is pinned, and every relation is schema-qualified. Builtins resolve through implicit-first `pg_catalog`, and `pg_temp` is never searched for functions. `authenticated` and `anon` lack CREATE on `public` (verified). No shadowing is possible.
- `prosecdef = f` for all three.

**Privileges.**
- `proacl` = `{postgres=X, service_role=X}` for all three, so PUBLIC, anon and authenticated have no EXECUTE.
- The service_role grant comes from the spec 097 default privileges. It is harmless because a trigger function cannot be called outside a trigger context. AC-20 doesn't require revoking it.

**Error messages.**
- The five messages are static strings with no row data, ids or SQL fragments. PostgREST returns `message`/`code` only, and the plpgsql CONTEXT line is not exposed.
- They give no existence oracle:
  - the item branch uses one message for null, missing, invisible and cross-store;
  - the parent branch uses one message for missing, invisible and storeless;
  - both run BEFORE the FK constraint trigger, so FK 23503 can't distinguish them either.
- Client `console.warn` calls (`db.ts` L1818, L1931, L1979) log only `.message`. No tokens or PII.

**Malformed input (R-2).**
- `pg_input_is_valid(..., 'uuid')` plus the CASE guard on `jsonb_array_elements` (L143-152) means no 22P02 or other unhandled class can escape. The `::uuid` cast at L159 runs only after the shape pass proves every element valid.
- Observed but not a finding: non-canonical uuid spellings (braced or unhyphenated) pass both the RPC and the trigger, while the read-side regex in `report_last_order_context` (L243-244) skips them. This is a data-quality gap with no tenancy impact, and it predates this spec.

**Fixture trigger-disable wrapper** (`report_last_order_context.test.sql:354` / `:407`):
- It runs as postgres (the table owner) before `set local role authenticated` (L429). It sits inside the file's single `begin` (L116) … `rollback` (L876), with no intervening commit.
- `scripts/test-db.sh` runs each file in its own `psql` session with `ON_ERROR_STOP=1` and no `--single-transaction`. Any error ends the session and implicitly rolls back the DDL.
- The runner targets only the local docker container, never prod. Precedent: `profiles_insert_hardening.test.sql:365`.
- The `order_approvals.test.sql` diff is additions only (2 catalog rows and 2 items with the pre-existing literal ids), within AC-16.

**Prod runbook (§10).**
- The pre-check is read-only.
- Step 5's negative probe runs inside `begin … rollback`, with a documented fallback if MCP can't hold a transaction.
- It uses `execute_sql`, not `apply_migration`, plus the exact version insert. Nothing writes rows to prod.

### Dependencies
No `package.json` changes, so `npm audit` was skipped.
