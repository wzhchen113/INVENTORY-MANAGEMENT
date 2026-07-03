## Code review for spec 107

Reviewer: code-reviewer. Scope: craft/convention review of both slices — the
migration `20260704000000_po_loop.sql`, `send-po-email/index.ts` + `config.toml`,
`po_loop.test.sql`; and `src/lib/db.ts`, `src/store/useStore.ts`,
`ReorderSection.tsx` / `POsSection.tsx` / `ReceivingSection.tsx`, i18n ×3, and
the three new jest files. Cross-read `reviews/backend-architect.md` and
`reviews/security-auditor.md` first to avoid duplicating their rulings on the
two flagged design contradictions (idempotency-coalesce direction, P0002 vs
42501) — both are architecture/contract calls, not craft, and both reviewers
already ruled CORRECT on the shipped code. I do not re-litigate them here.

Overall impression: this is careful, disciplined work. RPC arg names match the
migration verbatim end-to-end (`p_po_id`/`p_lines`/`p_client_uuid`,
`po_item_id`/`received_qty` inside the lines array), the additive-delta receive
semantics and the outstanding-remainder prefill are implemented and tested
correctly on both ends, the OQ-6 cost bridge (`costPerUnit × subUnitSize`) is
applied exactly once with no double-bridge anywhere I could find, the legacy
`createPurchaseOrder` → `'sent'` change is coherent with the new
`createPurchaseOrderDraft` → `'draft'` split (confirmed against every touch
point: `mapPurchaseOrderRow` reads `status` verbatim, `unconfirmed_po` doesn't
predicate on it, `record_missed_orders` doesn't either), and I spot-diffed both
re-CREATEd reorder RPC bodies against their on-disk source migrations —
byte-identical outside the one documented CTE hunk. i18n key parity is real
(programmatically verified: 8/8 `createPo*` keys present in all three locales
at identical positions; staff catalog untouched).

### Critical

None.

### Should-fix

- `src/screens/cmd/sections/ReceivingSection.tsx:153-176` (`PoReceivingMode.onCommit`) — "Commit Receive" mutates `current_stock` and `po_items.received_qty` directly on button press with **no `confirmAction` gate**, while every other lifecycle action in this same spec (send-to-vendor, mark-sent, cancel, close-short, even the benign create-draft) is confirm-gated — confirmed via `POsSection.tsx:120,137,154,171` and `ReorderSection.tsx:191`, and confirmed the omission is deliberate (not an oversight caught by tests) since `ReceivingSection.test.tsx:172-193` explicitly asserts `fireEvent.press(commit)` calls `receivePurchaseOrder` synchronously with no intercept. This is a real craft asymmetry: receiving is a durable, audited stock mutation with no "un-receive" path in the UI (the only way back is a manual inventory adjustment elsewhere), which is at least as consequential as "mark as sent manually" (which IS confirm-gated). Neither the spec's ACs nor the security-auditor's "four outward/destructive actions" list (their review, line 68) name receive/commit as required-confirm, so this isn't a contract violation — but it reads as an inconsistency the next engineer touching this file will trip on ("why does everything else confirm but not the one action that changes stock levels?"). Suggested fix: wrap `onCommit`'s body in `confirmAction`, or add a one-line comment explaining why it's deliberately exempt (e.g., "high-frequency data entry — a confirm here would be friction, not safety" — a legitimate UX argument, but it should be stated, not silent).

### Nits

- `src/screens/cmd/sections/POsSection.tsx:25-30` and `src/screens/cmd/sections/ReceivingSection.tsx:19-24` — the `PoRow` type alias (`OrderSubmission & { status?; vendorId?; totalCost?; timestamp? }`) plus its explanatory comment is duplicated byte-for-byte across both files. Low risk (type-only, 4 lines, no behavior), but if a fifth field is ever added to `mapPurchaseOrderRow`'s superset, both copies need editing in lockstep with no compiler check that they stay in sync. Consider hoisting to a small shared module (or next to `OrderSubmission` in `src/types/index.ts`) next time either file is touched.
- `src/store/useStore.ts:2446-2471` (`receivePurchaseOrder`) — after a successful RPC call, the action discards the RPC's own `result.lines` envelope and re-fetches via a separate `loadPurchaseOrderLines(poId)` round-trip, even though the RPC already returned the same per-line totals. Defensible (the separate fetch also carries the catalog join for item name/unit that the RPC's envelope doesn't), but it is an extra network round-trip on every receive that the RPC's return value could have satisfied directly. Not worth blocking on; flagging in case a future perf pass on this screen wants a quick win.
- `src/lib/db.crossStoreLoaders.test.ts:172,178,199,230` (out-of-scope — not in spec 107's Files-changed list, adjacent only) — four `status: 'submitted'` PostgREST-response fixtures for `fetchOrderSubmissionsForStores`. `mapPurchaseOrderRow` reads `status` verbatim with no branching, so these tests still pass and are not a behavior-pinning risk — but `'submitted'` is now a value the live `purchase_orders_status_check` constraint can never produce post-migration, so the fixtures no longer model a state the real server can return. Worth a follow-up sweep to `'sent'` for realism whenever that file is next touched; not spec 107's responsibility since the file isn't in its change list.
- `supabase/migrations/20260704000000_po_loop.sql:222-239` / `src/lib/db.ts:1528-1538` (`updatePoItemQty`) / RLS (`store_member_update_po_items`, `20260504173035_per_store_rls_hardening.sql:226-241`) — line edits (`updatePoItemQty`/`deletePoItem`) are gated to "draft only" purely at the FE (`POsSection.tsx:421,452` render the qty input / delete button only when `isDraft`); the RLS policy backing the UPDATE/DELETE is store-scoped only, not status-scoped, so a non-UI caller could in principle edit/delete a line on a `sent`/`partial`/`received` PO. This is pre-existing RLS shape the backend-architect's design (§0) explicitly signed off as sufficient/no-repair-needed, so it is not a spec-107 regression and is architecture/RLS territory rather than a craft finding — noting it here only so it's visible; deferred to backend-architect / security-auditor if either wants to open it as a follow-up (neither flagged it in their spec-107 reviews).

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 4 Nits. The Should-fix is a confirm-gating asymmetry (ReceivingSection's Commit Receive is the only stock-mutating lifecycle action in this spec without a confirmAction gate, unlike its four siblings in POsSection/ReorderSection) — not a contract violation (no AC or security-auditor rule required it), but a real craft inconsistency worth a decision (add the gate, or document why it's intentionally exempt) before merge. Nits are all low-risk: a duplicated 4-line type alias across two sections, an extra network round-trip in receivePurchaseOrder that the RPC's own return value could have avoided, a pre-existing jest fixture using the now-retired 'submitted' status token (out of this spec's changed-files scope), and a pre-existing status-unaware RLS gap on po_items UPDATE/DELETE (architecture territory, already signed off by backend-architect, surfaced only for visibility).
payload_paths:
  - specs/107-purchase-order-loop/reviews/code-reviewer.md

---

## Resolution (applied by main Claude post-review)

- **Should-fix — ReceivingSection "Commit Receive" confirm gate — FIXED.**
  `onCommit` now wraps the RPC in `confirmAction` (title/body/CTA i18n'd ×3:
  `section.receiving.commitConfirm*`), after the nothing-to-receive toast guard.
  Jest updated: the commit test asserts the confirm fired exactly once before the
  RPC; the zero-lines test asserts the confirm is never opened. (The missing gate
  was also demonstrated LIVE in the browser pass before the fix.)
- **Architect §10(e) doc reconciliation — APPLIED.** The spec's pgTAP AC (e) now
  documents the P0002-before-42501 semantics per the drift-review ruling.
- **Nits — left as noted** (advisory).

Post-fix: base + test typechecks exit 0, full jest 864/864.

## Browser verification (main Claude, preview tools — the full golden chain)

Create PO from the BJs reorder card (confirm-gated) → draft PO, 9 lines,
$450.82 (matches the card; per-counted-unit cost snapshots verified in DB) →
POsSection lifecycle UI (status chips, SEND TO VENDOR / MARK AS SENT / CANCEL)
→ Mark as sent (confirm-gated) → status 'sent' → ReceivingSection PO-mode
(outstanding-remainder prefill, 434) → partial receive 10× Caramel Mouse →
stock 0→10, received_qty 10, status 'partial', receive_client_uuid stamped →
Reorder refresh: **BJs vanished from the list** (inbound 424 covers every
below-par item — the double-order protection working) + the INBOUND column
renders (closing the test-engineer's flagged FE-visibility gap by live
verification) → Cancel (confirm-gated) → 'cancelled'. Local test data cleaned
(PO deleted, stock reverted). No console errors attributable to the feature.
