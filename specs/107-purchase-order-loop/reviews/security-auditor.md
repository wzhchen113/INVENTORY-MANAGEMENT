# Security audit for spec 107 — Close the purchase-order loop

Reviewer: security-auditor
Verdict: **PASS — no Critical findings. Spec may advance to READY_FOR_DEPLOY.**

Scope audited:
- `supabase/migrations/20260704000000_po_loop.sql` (status CHECK + data-migration, `receive_client_uuid` idempotency column + partial unique index, 3 RPCs, both reorder RPC re-CREATEs)
- `supabase/functions/send-po-email/index.ts` + `supabase/config.toml:453` (`verify_jwt` posture)
- `src/lib/db.ts:1444-1613` (createPurchaseOrderDraft / receivePurchaseOrder / close-short / cancel / fetch / update / delete line helpers)
- `src/store/useStore.ts:2400-2519` (store actions incl. `sendPurchaseOrderEmail`)
- `src/screens/cmd/sections/{POsSection,ReceivingSection,ReorderSection}.tsx` (confirm-gating, no raw fetch)
- `supabase/tests/po_loop.test.sql` (RLS pins + guard coverage)
- RLS baseline: `supabase/migrations/20260504173035_per_store_rls_hardening.sql:183-251` (purchase_orders + po_items policies)

---

## Critical (BLOCKS merge)

None.

---

## Should-fix (before deploy)

None that rise to must-fix. See Nits for two robustness items and one documentation-parity item; none are exploitable under this app's threat model.

---

## Nits (non-blocking)

- `supabase/migrations/20260704000000_po_loop.sql:222-239` — `receive_purchase_order` accepts `received_qty numeric` from `p_lines` with **no non-negativity or upper bound**. A store member could submit a negative `received_qty` (decrements `current_stock` + drives `po_items.received_qty` negative) or an oversized value (overflows `numeric(10,3)` → SQLSTATE `22003`, aborts the txn — no corruption). **Not a vulnerability**: (a) the op is RLS/store-pinned (`ii.store_id = v_store_id` at line 238, `pit.po_id = p_po_id` at line 230) so it can never reach another store's rows; (b) a store member *already* has unrestricted direct write to their own `inventory_items.current_stock` via `store_member_update_inventory_items` — the app's own `adjustStock` (`src/lib/db.ts:517`) does exactly a raw `.update({ current_stock })`. So the RPC grants **zero additional capability** beyond what the caller already holds on their own store. The customer PWA (the exposed surface) is `authenticated`-gated out by GRANT (line 303-304) and store-gated out by `auth_can_see_store`. Optional hardening only: add `if v_line.received_qty < 0 then raise exception … using errcode='P0001'` to reject negatives with a clean error rather than silently decrementing. Robustness, not security.

- `supabase/migrations/20260704000000_po_loop.sql:132-134` (`purchase_orders_receive_client_uuid_idx` — GLOBAL partial unique index) vs the idempotency read at lines 198-213 (scoped `where id = p_po_id and receive_client_uuid = p_client_uuid`). The read is per-PO, but the write is guarded by a *global* unique index. If the same `p_client_uuid` were reused across two different POs, the second PO's `update … set receive_client_uuid = …` (line 269) raises `23505` (unique violation) and aborts — it does **not** silently apply the receive to the wrong PO, and it cannot leak or cross-write another PO's data. The client mints a fresh `crypto.randomUUID()` per receive event (`src/store/useStore.ts:2452-2455`), so collision requires a deliberately-crafted duplicate uuid; the worst case is a self-inflicted `23505` on the attacker's own store. **Cross-PO idempotency abuse is not achievable** — confirmed safe. Noted only because the global-index / per-PO-read asymmetry is non-obvious; a one-line comment on the index would help the next reader.

- `supabase/functions/send-po-email/index.ts:193-197, 137, 223` — error responses surface third-party / DB error strings to the client (`detail: await res.text()` from Resend; `linesErr.message`; `(e as Error).message`). These carry Resend's own error text (e.g. "invalid to address") or PostgREST error text (e.g. "column … does not exist"), **not** SQL fragments with row data, stack traces with internal paths, or another store's rows (the service-role reads here are simple column projections of a single already-authorized PO). Acceptable. If you want to be conservative, drop the raw `detail` passthrough on line 194 and log it server-side instead — the operator only needs "resend send failed (HTTP 502)".

---

## Positive confirmations (checks that passed)

These are the audit obligations from the dispatch, each verified:

**Migration — RPCs**
- `receive_purchase_order`, `close_short_purchase_order`, `cancel_purchase_order` are all `security invoker` + `set search_path = public` (lines 166-167, 318-319, 375-376) — matches the reorder-engine posture, correctly NOT `security definer`.
- Every RPC gates on `auth_can_see_store(v_store_id)` as (effectively) the first side-effect-free statement, after resolving `v_store_id` from the PO (lines 182-193, 326-334, 383-391). The documented **P0002-before-42501** nuance is real and *stronger*, not weaker: under INVOKER + RLS, a non-member's `select … where id = p_po_id` returns 0 rows → `v_store_id` NULL → `P0002 'not found'` fires *before* the 42501 branch. This means a non-member **cannot receive, cancel, close-short, or even probe existence** of another store's PO — the refusal hides existence rather than leaking it. Pinned by `po_loop.test.sql` arm (F) (lines 255-263).
- GRANT/REVOKE posture correct on all three: `revoke all … from public, anon` + `grant execute … to authenticated` (lines 303-304, 360-361, 415-416). **No anon reach.** `auth_can_see_store` itself is granted to `authenticated, anon` (`20260517040000:116`) but returns false for anon (no `auth.uid()` membership, not admin), so the anon path is doubly closed.
- Status CHECK (lines 100-112) cannot be bypassed: 5-token allowlist `('draft','sent','partial','received','cancelled')`, added `NOT VALID` then `VALIDATE`d. Off-vocabulary `'submitted'` insert is rejected (`23514`) — pinned by arm (S) (lines 544-553).
- `receive_client_uuid` idempotency (lines 198-213) is scoped by `po_id` on read; a repeat returns `conflict:true` with the current per-line totals and **does not re-increment stock** — pinned by arms (C) (lines 350-368). Cross-PO abuse not achievable (see Nit above).
- Stock increments cannot reach another store's items: the `and ii.store_id = v_store_id` pin (line 238) plus `and pit.po_id = p_po_id` (line 230) confine the write to the PO's own store. Line item_ids that don't belong to the PO no-op (0 rows). Negative/overflow addressed in Nits — no corruption, no cross-tenant reach.
- Audit rows written on every mutating call (lines 284-287, 351-354, 406-409) with `user_id = auth.uid()` (INVOKER → real caller, spoof-proof).

**Migration — reorder RPC re-CREATEs**
- Both `report_reorder_list` (line 441) and `report_reorder_for_counted_onhand` (line 1087) retain `security invoker` + `set search_path = public` + the `auth_can_see_store(p_store_id)` gate (lines 459-462, 1106-1109). Signatures byte-identical → `create or replace` preserves the existing ACL; **no GRANT/REVOKE re-emitted** (correct — re-emitting risked ACL drift).
- The new `pending_po_qty` CTE (lines 674-684 and 1266-1276) reads only store-scoped rows: `where po.store_id = p_store_id and po.status in ('sent','partial') and po.received_at is null`. `greatest(0, ordered − received)` guards a negative-pending over-receive. Byte-identical between the two engines (verified by inspection; pinned on the observable result by arm (P), lines 408-463).

**Edge function `send-po-email`**
- `verify_jwt = true` declared in `config.toml:453-454` with a rationale comment (lines 444-452). Correct — this is the JWT-carrying admin action posture, the opposite of the `staff-*`/`pwa-catalog` service-token pattern.
- `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` (line 29) — **includes `super_admin`**. This is the CLAUDE.md tenth-omission parity rule (spec 026/027); it is satisfied. `requireAdminCaller` (lines 31-44) checks `app_metadata.role` then falls back to `profiles.role`, 403 on neither — matches `delete-user`/`send-invite-email` reference shape.
- `escapeHtml` (lines 52-55) is **byte-identical** to the TS mirror `src/utils/escapeHtml.ts:6-9` (five-char `& < > " '`). **Every** interpolated value in the HTML body is wrapped: `vendorName` (144), `refDate` (145), per-row `itemName`/`unit` (150-151) and the qty/cost cells (158-160), and the grand total (165). User-controlled catalog fields (item name, unit) and vendor name all pass through `escapeHtml`. The `subject:` (187) and `to:` (186) fields are NOT HTML and correctly do NOT need the wrap.
- **Authoritative server-side re-read** (lines 90-134): the function ignores any client-supplied body and re-reads the PO header, vendor, and lines via the service-role client keyed only on `poId`. A client **cannot inject arbitrary PO content** into the email — the only client input is `poId`, and cross-store `poId`s are refused by the `auth_can_see_store` re-check via the *caller-scoped* client (lines 110-118), so a scoped-but-admin edge can't send another store's PO.
- Status flip is server-side and gated on **Resend 2xx** only (lines 192-217): `if (!res.ok) return 502` before the flip; the flip is `.eq('status','draft')` so it's idempotent and never regresses a partial/received PO. A lost client response cannot leave a sent-but-still-draft PO.
- No secret leakage: `RESEND_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` both from `Deno.env.get(...)` (lines 13-15) — never hardcoded, never logged (zero `console.*` calls in the file). Resend key used only as the outbound `Authorization` header (line 181).
- `vendors.email` recipient handling: `to: [vendorEmail]` (line 186) is passed as a JSON array element to Resend's REST API. Resend constructs the SMTP envelope; there is **no raw header string** the email could inject a newline into. Empty-email vendors are refused with a 400 pointing at mark-as-sent-manually (lines 121-129). No header-injection surface.

**Frontend**
- Email send goes through `callEdgeFunction('send-po-email', { poId })` (`useStore.ts:2501`) — **not** raw `fetch` (CLAUDE.md convention; avoids the spec-031 silent-fake-success regression). No raw `fetch(` in any touched section.
- No service keys / no sensitive `EXPO_PUBLIC_*` in the touched FE (grep clean).
- All four outward/destructive PO actions are confirm-gated via `confirmAction`: send-to-vendor (`POsSection.tsx:120`), mark-sent-manually (137), cancel (154), close-short (171), and create-draft (`ReorderSection.tsx:191`).
- `client_uuid` for receive is minted with `crypto.randomUUID()` (`useStore.ts:2453`), with a non-crypto `Math.random` string used **only** as a last-resort fallback when `crypto` is unavailable — acceptable for an idempotency dedupe key (not a security token; collisions self-inflict a `23505` on the caller's own store, not a cross-tenant reach).

**RLS pins**
- `purchase_orders` and `po_items` policies (`20260504173035:186-251`) are the exact `auth_can_see_store(store_id)` house pattern — parent store-scoped, child scoped through the parent via `exists(...)`. The architect's "already hardened, no repair needed" conclusion is correct. `po_loop.test.sql` arms R1-R4 (lines 178-238) genuinely pin these: member reads own-store PO, non-member gets 0 rows, master reads cross-store, child po_items scoped through parent. The pins are real.

---

## Dependencies

No `package.json` / `package-lock.json` changes in spec 107 (last touched at spec 089). `npm audit` skipped — no dependency delta to assess.

---

## Summary

0 Critical, 0 Should-fix, 3 Nits. The backend enforces store isolation at three layers (RLS on the tables, INVOKER RLS on the RPC UPDATEs, explicit `auth_can_see_store` gate + store-id pin), the edge function re-reads authoritatively and escapes all HTML, secrets are env-sourced and unlogged, and every outward action is confirm-gated and routed through `callEdgeFunction`. Nothing blocks. No security reason this spec cannot advance to READY_FOR_DEPLOY.
