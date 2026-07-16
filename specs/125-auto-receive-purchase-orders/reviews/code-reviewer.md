# Code review — spec 125 (auto-receive purchase orders)

> NOTE: This review was performed by main Claude as a fallback. The `code-reviewer`
> subagent could not run — the Anthropic API returned repeated `529 Overloaded`
> (server-side, transient) across multiple retries. The independent
> `security-auditor` and `backend-architect` passes DID complete (both clean /
> non-blocking), and the full test suite was verified directly. Recorded here for
> a complete review trail; re-run the `code-reviewer` agent later if desired.

## Verdict: 0 Critical, 0 Should-fix, 2 Nits (non-blocking)

### Confirmed
1. **Inlined restock faithful to `receive_purchase_order`** (`20260704000000_po_loop.sql:160`): per-line `v_delta = greatest(0, ordered_qty - received_qty)`, additive `current_stock += v_delta`, store-pinned (`ii.store_id = v_po.store_id`). Header flip: `status='received'`, `received_at=now()`, `received_by=NULL` (system), deterministic `receive_client_uuid = md5(id||':auto-receive')::uuid`. Matches the canonical receive semantics.
2. **M1 applied** — the `po_items.received_qty = ordered_qty` write is now inside `if v_delta <> 0`, so an over-received line (received_qty > ordered on a still-partial PO) is left untouched rather than regressed. Monotonic. pgTAP re-verified 24/24 after the change.
3. **Idempotency** — the `received_at IS NULL` selection filter + always-full-receive means a received PO can never be re-selected; the deterministic client_uuid is defensive. pgTAP covers the double-run no-double-increment case.
4. **Audit row shape matches the canonical receive** — same columns `(store_id, user_id, action, detail, item_ref, value)`; auto-receive uses `user_id = NULL` + `action = 'PO auto-received'`. No user impersonation.
5. **Decision A gate** — `createPoDraft` persists `expectedDelivery` only when `scheduleKnown && nextDeliveryDate`; the synthetic `as_of+7` fallback is not persisted.
6. **`expectedDelivery` omit-when-absent** in `createPurchaseOrderDraft` — existing callers unchanged.
7. **Cron** — `0 8 * * *` via the direct-RPC pattern with the `if exists … unschedule` re-apply guard. Grants revoked from public/anon/authenticated; granted postgres/service_role.

### Nits (non-blocking)
- **Maintainability (inline duplication):** the restock logic is duplicated from `receive_purchase_order` rather than calling it (justified: the canonical RPC is SECURITY INVOKER + gates on `auth_can_see_store()` + stamps `received_by = auth.uid()`, all wrong for a cron/DEFINER context). A future change to the canonical receive's stock math would need mirroring here — a comment already points at the mirror source; consider a shared note or a periodic parity check.
- Cost-on-receipt (spec 109) intentionally not ported — correct, since auto-receive has no operator/invoice; confirmed by the architect.
