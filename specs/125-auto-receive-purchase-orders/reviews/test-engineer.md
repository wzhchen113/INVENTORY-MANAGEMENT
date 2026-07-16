# Test review — spec 125 (auto-receive purchase orders)

> NOTE: Fallback review by main Claude — the `test-engineer` subagent hit repeated
> `529 Overloaded` (server-side). Test commands were run directly and results recorded.

## Verdict: core + high-risk ACs covered. Not blocking.

### Ran
- `bash scripts/test-db.sh` → `auto_receive_due_purchase_orders.test.sql` **24/24 assertions PASS** (re-verified after the M1 fix). Covers: due sent PO → received + received_at + `current_stock` incremented + `received_qty=ordered`; future `expected_delivery` → untouched; NULL `expected_delivery` → untouched; `draft` + `cancelled` → untouched; partially-received PO → topped up, stock += remainder only; **idempotency (second run → 0, no double-increment)**; system audit row (`user_id NULL`); ACL/grants.
- `npx jest spec125` → **3/3** (Decision A): `scheduleKnown:true` → `expectedDelivery=nextDeliveryDate`; `false` → undefined (NOT the guessed date); empty `nextDeliveryDate` → undefined.
- `npx jest` (full) → **1221/1221**, 109 suites.
- `npx tsc --noEmit` → clean. `npm run typecheck:test` → clean.

### Highest-risk ACs
- **No double-restock (idempotency):** covered by pgTAP (second run returns 0, stock unchanged).
- **Partial top-up remainder-only:** covered by pgTAP.
- **Decision A (guessed date not persisted):** covered by jest.

### Note
- Pre-existing unrelated failure `item_vendors_rls.test.sql` assertion 12 (spec-114 order_code RLS pin) — predates this spec, untouched by it.
- M1 over-received edge (received_qty > ordered on a partial PO): the fix makes the write monotonic; the existing partial-top-up test exercises the delta path. A dedicated over-received fixture would be a nice-to-have but is a rare non-blocking edge.
