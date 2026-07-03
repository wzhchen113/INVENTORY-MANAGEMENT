# Backend-architect — post-implementation drift review (spec 107)

Reviewer: backend-architect (post-impl mode). I authored the `## Backend design`
(§0–§11). Scope: verify BOTH slices match design intent, and rule explicitly on
the three flagged build-time deviations.

Verdict: **implementation matches the design.** No Critical, no Should-fix drift.
All three flagged deviations are correct calls; I rule on each below. Four Minor
notes for the record.

Files read: migration `20260704000000_po_loop.sql` (all 1535 lines), edge fn
`send-po-email/index.ts`, `config.toml` (send-po-email block), `po_loop.test.sql`,
`db.ts` (PO helpers 1344–1631 + `mapPurchaseOrderRow`), `useStore.ts` (PO slice
2320–2519 + AppState decls), `POsSection.tsx`, `ReceivingSection.tsx`,
`ReorderSection.tsx` (integration points).

---

## Rulings on the three flagged deviations

### 1. Idempotency `coalesce` direction — RULE: the flip to `coalesce(p_client_uuid, receive_client_uuid)` is CORRECT. Keep it.

The developer flipped §3's code snippet
(`coalesce(receive_client_uuid, p_client_uuid)`, first-key-wins) to
`coalesce(p_client_uuid, receive_client_uuid)` (last-key-wins) at migration
line 269. This is the correct semantic and resolves a genuine self-contradiction
in my design: §3's Option-A prose column explicitly said *"each receive event
supersedes … overwrites the column,"* while the adjacent code snippet did the
opposite. The prose is the load-bearing intent, and the AC
(`spec:108-131` idempotency + `spec:243-246` OQ-3 multi-receive) requires it.

Why last-key-wins is the only correct choice for sequential partial receives +
retry dedup:

- Receive #1 (uuid A, partial): sets `receive_client_uuid = A`. Retry of #1
  (same A) → the idempotency SELECT at lines 199–201 finds A → `conflict:true`,
  no double-increment. Correct.
- Receive #2 (uuid B, completes): the SELECT for B finds nothing (column holds
  A), so #2 applies its delta, then the final UPDATE overwrites the column to B
  (last-key-wins). Retry of #2 (same B) → SELECT finds B → `conflict:true`, no
  double-increment. Correct.
- Under the REJECTED first-key-wins direction, after #2 the column would still
  hold A, so a retry of #2 (uuid B) would find nothing → re-apply #2's delta →
  double-increment stock. That is exactly the idempotency-AC violation the
  design's own prose warned about.

The durable per-line truth lives in `po_items.received_qty` (accumulated), and
each receive is independently audited (one `audit_log` row per call, lines
284–287), so retaining only the latest uuid loses no correctness. The alternative
(a `po_receipts` ledger, design §3 Option B) would make every receive
first-class but was explicitly rejected in the design as heavier than the ACs
require — that trade stands.

pgTAP arms (C) at line 359 and (D) at lines 335/340 pin this: sequential partial
(#1 short=2) then complete (#2 uuid `cuuid`, +3 → received, stock 15), then a
re-call with the SAME `cuuid` asserts `conflict:true` AND stock STILL 15. That
directly exercises last-key-wins on the completing receive. The developer's
in-migration comment (lines 253–264) documents the contradiction and the
resolution honestly. **No change required.**

### 2. P0002 vs 42501 for non-member / unknown-PO — RULE: P0002 is CORRECT under `SECURITY INVOKER`; reconcile the design/AC text TO P0002. Do NOT force 42501.

The design specified `SECURITY INVOKER` for the three lifecycle RPCs (matching the
reorder engines, §3), and specified an explicit `auth_can_see_store` gate raising
42501 (§3 code, §10(e)). The developer correctly identified that these two
decisions interact: under INVOKER, the caller's RLS (`store_member_read_purchase_orders`,
which uses `auth_can_see_store(store_id)`) filters the PO row BEFORE the gate's
`select store_id … where id = p_po_id` can read it. A non-member gets 0 rows →
`v_store_id is null` → the RPC raises P0002 at lines 188–190, never reaching the
42501 branch at 191–193. The code as written (verbatim from my §3 snippet)
produces P0002 for a non-member; my §10(e) text saying "42501" was the drift.

The developer kept the code behavior and pinned P0002 in pgTAP arm (F) (line 255,
`throws_ok(… 'P0002' …)`). This is the right call for three reasons:

1. **It is what the design's own §3 gate code actually does.** The 42501 line was
   never reachable for a non-member under INVOKER+RLS. The code is internally
   consistent; only my §10 prose was wrong.
2. **P0002 is a strictly stronger security posture** — it does not leak the PO's
   existence to a non-member (a 42501 "not authorized for store X" would confirm
   the PO exists and reveal its store). This is the same existence-hiding posture
   RLS itself provides.
3. **Forcing 42501 would require a design change** — reading `store_id` via a
   SECURITY DEFINER path (or a definer helper) so the gate sees the row before
   RLS filters it. That trades the existence-hiding posture for a marginally more
   specific error, on an admin-only surface where non-member calls are not an
   expected flow. Not worth it.

The 42501 branch is retained as defense-in-depth (the theoretical "row visible but
`auth_can_see_store` disagrees" case) — correct to keep. **Reconciliation: the AC
wording (§10(e)) should read P0002 for the non-member/unknown-PO case; I am
updating my mental model to match. No code change.** Note the three RPCs are
mutually consistent here (receive/close-short/cancel all raise P0002-then-42501 in
the same order), and `close_short`/`cancel` add a P0001 status-guard on top — all
correct.

### 3. Legacy `createPurchaseOrder` literal `'submitted' → 'sent'` (NOT `'draft'`) — RULE: CORRECT. The legacy path must land at `'sent'`, not `'draft'`.

`createPurchaseOrder` (db.ts:1382) — the legacy "Mark as Submitted / already
ordered today" header-only path invoked by `submitOrder` — now writes
`status: 'sent'`, while the NEW `createPurchaseOrderDraft` (db.ts:1469) starts at
`'draft'`. This is exactly the design intent (§1, lines 518–528), not drift.

The two paths have different semantics and correctly land at different states:

- **Legacy path** = "this order already went to the vendor." Its pre-107 token
  was `'submitted'`, which the migration normalizes to `'sent'` for the 6 prod
  rows (lines 88, and the prod probe at 41–55 confirms all 6 were `'submitted'`).
  For the token change to be transparent to the legacy flow, the live writer must
  emit the same reconciled token the data-migration produced: `'sent'`. Writing
  `'draft'` here would be a **behavior regression** — an order the manager marked
  as submitted-to-vendor would silently land as an un-sent draft, and (critically)
  a `'draft'` PO does NOT count in `pending_po_qty` (the open predicate is
  `status in ('sent','partial') and received_at is null`, migration lines
  681–682), so the just-ordered quantity would keep showing up as "reorder this
  again" — the precise bug spec 107 exists to fix.
- **New draft path** = "seed an EDITABLE draft from a reorder card" (OQ-4,
  spec:152-157). It must start at `'draft'` so lines are editable before an
  explicit send. It reaches `'sent'` only via the confirm-gated send-email flip
  (server-side, edge fn line 203–208) or `markPurchaseOrderSent` (manual
  fallback).

So the design does NOT require the legacy path to become a draft — the opposite:
the legacy path is the semantic equivalent of "already sent," and `'sent'` is the
correct terminal-for-that-flow token. The two entry points intentionally diverge.
**No change required.** (One forward-looking note: the legacy `createPurchaseOrder`
still writes a header with NO `po_items` lines — a `'sent'` PO with zero lines
contributes 0 to `pending_po_qty` because the aggregate sums over `po_items`. That
is pre-existing behavior, unchanged by 107, and harmless; flagged as Minor #4.)

---

## Contract conformance against the design (spot-verified)

- **Status data-migration** — matches the prod probe (6 × `'submitted'`, migration
  header lines 44–47) and the design's normalize-then-CHECK plan: `'submitted' →
  'sent'` + null/'' → `'draft'` (lines 88–89), CHECK added `not valid` then
  `validate` inside a `do` guard (lines 100–112), 5-token set
  `draft|sent|partial|received|cancelled`. pgTAP (S) pins `'submitted'` rejected
  (23514) + a valid token accepted (lines 544–562). Idempotent re-run safe.
  Correct.
- **receive / close-short / cancel contracts** — ADDITIVE `received_qty` deltas
  (`+= received_qty`, line 228) + `current_stock += same delta` (line 235),
  stock-only (NO cost mutation — pgTAP (E) asserts `case_price` + `cost_per_unit`
  unchanged, lines 308–319), one audit row per call (lines 284–287, 351–354,
  406–409), gate-first (auth gate is statement #1 in all three). Status recompute
  via `bool_and(received_qty >= ordered_qty)` (line 248); `received_at` stamped
  only on full receive, NULL on partial (OQ-3). close-short: partial→received +
  `received_at` stamp + P0001 non-partial guard. cancel: draft/sent/partial→
  cancelled + P0001 received/cancelled guard + does NOT touch stock. All match §3.
- **Both reorder re-CREATEs copied their OWN latest bodies with ONLY the CTE
  swapped** — `report_reorder_list` copied from the spec-104 body (carries the
  spec-102 item×vendor explosion, spec-088 case keys, spec-100 i18n, spec-104
  per-each ★ bridge — all present at lines 605–1024); `report_reorder_for_counted_onhand`
  copied from the spec-105 body (Delta-1 caller-supplied on-hand at 1236–1250,
  Delta-2 per-item collapse at 1440–1463). I diffed both `pending_po_qty` CTEs
  (lines 674–684 vs 1266–1276): **byte-identical**, as required. The value feeds
  `par_replacement` + `usage_forecasted` unchanged in both (they already subtract
  `coalesce(ppq.pending_po_qty,0)`). Byte-parity asserted on the RESULT by pgTAP
  (P): both engines return suggested_qty 92 for the seeded 48-inbound item, and
  the explicit parity check (line 459) asserts vendor-engine pending (48) ==
  counted-engine reduction (140−92). Correct.
- **Open-PO predicate** = `status in ('sent','partial') and received_at is null`
  (lines 681–682, 1272–1274) — exactly the OQ-3 canonical set. Matches.
- **`po_items.cost_per_unit` per-counted-unit** — column comment added (lines
  1529–1532) documenting the per-counted-unit basis + spec-104 ★ bridge + "NOT
  per-each" + waste_log R1 numeric(10,2) precedent. FE bridge at create is correct:
  `createPoDraft` (useStore 2415) computes `it.costPerUnit * subUnitSize` reading
  `subUnitSize` from the `inventory` array by itemId — exactly the
  ReceivingSection:100 / POsSection:77 expression the design prescribed (§5,
  lines 891–901). Passed as `costPerUnitCounted`, stored verbatim (db.ts 1490).
  Matches.
- **Edge function follows every §7 decision** — `verify_jwt = true` pinned
  explicitly in config.toml (lines 453–454, with the CLI-redeploy-footgun
  rationale); `ADMIN_ROLES = {"admin","master","super_admin"}` +
  `requireAdminCaller` (lines 29–44, mirrors auth_is_privileged, the 10th-omission
  rule is honored); inline five-char `escapeHtml` (lines 52–55) applied to EVERY
  interpolated value in the table incl. item name, unit, qty, unit cost, line
  total, grand total, vendor name, reference date (lines 144–165); authoritative
  server-side re-read of PO+vendor+lines via service-role (lines 90–134);
  belt-and-suspenders `auth_can_see_store` re-check via caller-scoped client
  (lines 110–113); status flip `draft → 'sent'` SERVER-SIDE only on a Resend 2xx
  (lines 200–208), guarded `.eq('status','draft')` so it never regresses a
  partial/received PO; NO auto-send (confirm-gated on client). FE calls it via
  `callEdgeFunction('send-po-email', { poId })` (useStore 2501), not raw fetch.
  Matches §7 in full.
- **FE store/actions/sections consume the contracts as designed** — `createPoDraft`
  / `receivePurchaseOrder` (mints client_uuid internally, ADDITIVE deltas) /
  `closeShortPurchaseOrder` / `cancelPurchaseOrder` / `sendPurchaseOrderEmail` /
  `markPurchaseOrderSentManually` all present with optimistic-then-revert +
  `notifyBackendError` on writes (useStore 2394–2519). POsSection lifecycle gating
  is correct: `canSend = draft`, `canCancel = [draft,sent,partial]`,
  `canCloseShort = partial` (lines 187–189) — matches the RPC guards exactly; send
  split on `vendorEmail` presence (line 308 email / 369 no-email hint); every
  action confirm-gated (lines 120/137/154/171). ReceivingSection open-PO filter
  (sent|partial, line 118), outstanding-remainder prefill `max(0, ordered −
  received)` (line 142), commit submits only non-zero deltas (line 159). Matches
  §8.
- **No publication change** — migration adds no `alter publication`; header
  (lines 72–79) documents `purchase_orders` already in `supabase_realtime` and
  `po_items` intentionally out. So no `docker restart supabase_realtime_imr-inventory`
  dev step. Verified: no publication statement anywhere in the migration. Correct
  per §6.

---

## Minor notes (for the record — none block)

- **M1 — Idempotency unique index is GLOBAL, not per-PO.**
  `purchase_orders_receive_client_uuid_idx` (migration 132–134) is unique on
  `receive_client_uuid` across the whole table, while the dedup SELECT keys on
  `(id = p_po_id AND receive_client_uuid = p_client_uuid)`. If the same uuid were
  ever reused across two different POs (it is not — `crypto.randomUUID` per receive
  event, useStore 2453), a genuinely-new receive on the second PO would hit the
  unique violation and roll back rather than dedup. This is a stronger-not-weaker
  posture (never double-increments) and the collision probability is negligible.
  Noted only so a future "one client_uuid, batch-receive many POs" feature knows
  to revisit the index scope. No action.

- **M2 — ReceivingSection open-PO filter uses raw `o.status`, POsSection uses
  `normalizeStatus`.** Receiving filters `o.status === 'sent' || 'partial'`
  (line 118) directly; POsSection wraps every read in `normalizeStatus` (maps any
  off-vocab token to `'draft'`, POsSection 32–33). Post-migration the DB cannot
  hold `'submitted'` (normalized away + CHECK forbids re-introduction), so the raw
  filter is correct against the reconciled vocabulary. Minor consistency nit only;
  if `orderSubmissions` could ever transiently carry a legacy token from a stale
  cache, Receiving would simply omit it from the open list (safe-fail — you can't
  receive against it, which is the conservative outcome). No action required;
  optional: route Receiving's filter through `normalizeStatus` for symmetry.

- **M3 — `total_cost` on a draft is a create-time snapshot, not recomputed on line
  edits.** `createPurchaseOrderDraft` sums line costs into `total_cost` (db.ts
  1458), but `updatePoItemQty` / `deletePoItem` (draft line edits) do NOT update
  the header `total_cost`. The design explicitly made `total_cost` display-derived
  from the lines (db.ts 1526 comment; POsSection recomputes `subtotal` from lines
  at POsSection 103), so the header value is cosmetic once lines are edited. The
  send-email path also recomputes `grandTotal` from lines server-side (edge fn
  146–155), so the emailed total is always correct regardless of the stale header.
  Consistent with design intent; noted so no one "fixes" the header to be
  authoritative. No action.

- **M4 — Legacy `createPurchaseOrder` still writes a header with zero `po_items`.**
  Unchanged by 107 (pre-existing). A zero-line `'sent'` PO contributes 0 to
  `pending_po_qty` (the aggregate sums over `po_items`), so the legacy "already
  ordered today" header does NOT actually suppress reorder for its items — only a
  PO created via the new draft path (which writes lines) does. This is a
  pre-existing limitation the spec did not scope in (the legacy path is
  header-only by design, dependency note spec:324-326), and 107 explicitly kept
  the freeform/legacy paths as fallbacks (spec:260-261). Flagged for a future
  "backfill lines onto legacy POs" follow-up if the owner wants the legacy path to
  also suppress reorder. Not a 107 defect.

---

## Test coverage sanity (pgTAP)

`plan(30)` with 30 `select …` assertions counted (0, R1–R4, A-pre/A×3, B×3, E×2,
D×2, C×2, F, G-pre/G×2/G-refuse, H, P×4, S×2). RLS pins are regression guards on
the existing 2026-05-04 policies (correct framing — no new policy authored, matching
design §0). Hermetic `begin; … rollback;`, master-JWT + member/non-member switch,
no `set role anon` (spec-067 segfault avoidance). The idempotency and byte-parity
arms directly pin the two deviations I ruled on. Coverage is adequate for the
contract.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. Implementation matches the design;
  0 Critical, 0 Should-fix, 4 Minor (all non-blocking). All three flagged
  build-time deviations ruled CORRECT — keep as implemented: (1) idempotency
  last-key-wins `coalesce(p_client_uuid, receive_client_uuid)`, (2) P0002 for
  non-member under INVOKER+RLS is the code's real behavior and a stronger posture
  than 42501 — reconcile the §10(e) AC text to P0002 rather than forcing 42501,
  (3) legacy `createPurchaseOrder` → 'sent' (NOT 'draft') is required so the
  already-ordered quantity leaves pending_po_qty. Both reorder engines' CTEs are
  byte-identical and each copied its own latest body; no publication change; edge
  fn honors every §6/§7 decision.
payload_paths:
  - specs/107-purchase-order-loop/reviews/backend-architect.md
