# Security audit for spec 125 — Auto-receive purchase orders

Scope reviewed:
- `supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql` (new SECURITY DEFINER RPC + grants + pg_cron)
- `src/lib/db.ts` (`createPurchaseOrderDraft` `expectedDelivery` threading)
- `src/store/useStore.ts` (`createPoDraft` Decision-A derivation)

Verdict: **PASS — no Critical, no High, no Medium.** The one place this spec bypasses per-store RLS (the DEFINER cross-store write) is correctly compensated by grant revocation, a tight selection predicate, and a store-pinned stock UPDATE. All five focus areas verified clean.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `supabase/migrations/20260719000000_...sql:63-64` — `p_as_of` is a caller-supplied `date` with an arbitrary value. A caller could pass a far-future date to force-receive every open PO in one shot. This is **not a finding**: EXECUTE is granted only to `postgres` (cron, which passes the default `current_date`) and `service_role` (already full-trust, RLS-bypassing by design). No new privilege is exposed vs. what `service_role` already holds. Noted for completeness only — no action required.

---

### Focus-area findings

**1. SECURITY DEFINER hardening — PASS**
- `search_path` is pinned: `set search_path = public, pg_temp` (line 68). No mutable-search-path hijack surface.
- EXECUTE is revoked from `public, anon, authenticated` (lines 175-176) and granted only to `postgres, service_role` (lines 177-178). Byte-for-byte mirror of the `record_missed_orders_for_day` reference (`20260530000000_record_missed_orders_rpc.sql:224-227`). Since `public` is revoked and `authenticated` is explicitly revoked (belt-and-suspenders), **an authenticated end-user cannot invoke this RPC** — verified there is no edge-function or PostgREST wrapper exposing it, and no blanket `grant execute on all functions … to authenticated/public` exists in any migration that would re-enable it (grep clean). Cron executes as `postgres`, which retains EXECUTE, so the schedule still fires. The absence of an `auth_can_see_store()` gate inside the body (unlike `receive_purchase_order:163`) is correct and intentional — access control here is the grant boundary, not a row gate, because it is a cross-store system job.
- The all-stores loop (lines 83-90) is intentional and reachable only via cron/service_role per the grant above. Not a privilege-escalation surface.

**2. Write scope — PASS**
- Stock increment is store-pinned: `update public.inventory_items ... where ii.id = v_line.item_id and ii.store_id = v_po.store_id` (lines 111-115). A `po_items.item_id` that resolved to another store's inventory row matches zero rows — no cross-store contamination, and no erroneous increment. Mirrors `receive_purchase_order`'s defense-in-depth pin (`20260705000000_cost_on_receipt.sql:221`).
- Bounded: `v_delta := greatest(0, ordered_qty - received_qty)` (line 104) prevents a negative decrement from an already-over-received line. `current_stock` is `numeric(10,3)`; over-receipt inflation is by-design (owner-accepted, EOD self-corrects) and matches existing manual-receive behavior — not a new risk.
- Selection predicate is strict (lines 86-89): `status in ('sent','partial') AND received_at IS NULL AND expected_delivery IS NOT NULL AND expected_delivery <= p_as_of`. `draft` / `cancelled` / `received` and null/future `expected_delivery` POs are provably never touched.

**3. Idempotency as a safety control — PASS**
- The header flip stamps `received_at = now()` and `status = 'received'` (lines 124-129); the selection filter requires `received_at IS NULL` (line 87), so a received PO can never be re-selected on any subsequent run → stock is incremented exactly once per PO. Double-restock is structurally impossible.
- The deterministic `receive_client_uuid = md5(id::text || ':auto-receive')::uuid` (line 128) is defensive belt-and-suspenders, unique per PO (no cross-PO collision on the partial-unique index). Not load-bearing for idempotency but harmless.

**4. Injection / secrets / RLS-publication — PASS**
- No dynamic SQL / `EXECUTE format(...)`. `p_as_of` is `date`-typed, `id` is `uuid`-typed and only ever concatenated via `md5(id::text || ...)` and `left(v_po.id::text, 8)` — both operate on a typed uuid, not caller free-text. No injection surface.
- No new secret, env var, or third-party key introduced. No `EXPO_PUBLIC_*` change.
- No RLS policy change, no `alter publication`, no new table. `expected_delivery` threading (`db.ts:1574`, `useStore.ts:2706-2713`) writes a server/engine-authored date, not free user input.

**5. Audit attribution — PASS**
- The audit row is system-attributed: `insert into audit_log (..., user_id, ...) values (v_po.store_id, null, 'PO auto-received', ...)` (lines 142-145). `user_id = NULL` — it does not impersonate any real user. Header `received_by = null` (line 127) likewise. Consistent with AC lines 57-58 and the cron/DEFINER context where `auth.uid()` is NULL.

### Dependencies
No `package.json` changes in this spec — `npm audit` skipped.
