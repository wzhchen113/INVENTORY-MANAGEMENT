# Code review for spec 109 (cost-on-receipt)

Reviewed both slices against `specs/109-cost-on-receipt.md` (design §0-§17, resolved
OQs, the OQ-1 AGGRESSIVE owner override, and the WHIPSAW CAVEAT — treated as
intended, not flagged). The always-update-the-scalar semantics, the no-`is_primary`
gate, and the always-permissive-RPC-plus-client-confirm split are all held as
designed; none of that is re-litigated below.

Files reviewed: `supabase/migrations/20260705000000_cost_on_receipt.sql` (diffed
hunk-by-hunk against `20260704000000_po_loop.sql:160-301`), `src/lib/db.ts`
(`receivePurchaseOrder`, `PoLine`/`mapPoItemRow`/`fetchPurchaseOrderLines`),
`supabase/tests/cost_on_receipt.test.sql`, `src/lib/db.poLoop.test.ts`,
`src/store/useStore.ts` (`receivePurchaseOrder` action + interface),
`src/screens/cmd/sections/ReceivingSection.tsx`, `src/screens/cmd/lib/priceGuard.ts`
+ `.test.ts`, `src/screens/cmd/sections/__tests__/ReceivingSection.test.tsx`,
`src/i18n/{en,es,zh-CN}.json`.

### Critical

None. No direct Supabase calls outside `db.ts`, no legacy-file edits, no `slug`
touch, no `window.confirm`/`Alert.alert` bypass of `confirmAction`, no web-only API
reachable on native, no custom `current_setting('jwt...')` SQL (uses
`auth_can_see_store()`), no new realtime channel (rides the existing `store-{id}`
`purchase_orders` UPDATE, as designed), no `db.json`/json-server reintroduction.
The RPC's grant/revoke-preservation claim and "no schema change" claim both check
out against the actual file contents.

### Should-fix

- `supabase/tests/cost_on_receipt.test.sql` — **OQ-6 "last-entry-wins" is not
  pinned.** The AC has a dedicated bullet ("two sequential receives with different
  prices leave the LAST price on both `item_vendors` and `inventory_items` and a
  recoverable trail of BOTH changes") and the architect's design §15 lists it as a
  distinct case (g), separate from idempotent-replay (case d / test case 3, which
  only exercises the SAME price on the SAME `client_uuid`). Grepping the file for
  `last.wins|LAST` returns nothing. The "Files changed" summary at the bottom of
  the spec claims "all ten design cases" are covered — this one specifically isn't.
  I traced the RPC logic by hand (the per-line old-value SELECT re-reads current
  state on every loop iteration, so two DIFFERENT-price calls against the same
  line should behave correctly), but the pinned acceptance criterion has no
  regression test guarding it. Add a case: two sequential `receive_purchase_order`
  calls (distinct `client_uuid`s) against the same PO line with two different
  non-zero prices; assert the SECOND price is what lands on both `item_vendors`
  and `inventory_items`, and that TWO `'PO price change'` audit rows exist (both
  transitions recoverable).
- `src/screens/cmd/sections/ReceivingSection.tsx:427-430` (`onCommit` at
  `:167-265`) — **`busy` doesn't guard the two nested confirms, only the RPC
  call.** `disabled={busy || enteredTotal <= 0}` only goes `true` once
  `runReceive()` sets it (line ~210), which fires AFTER both `confirmAction`
  calls have resolved to "confirm". On web this is moot (`window.confirm` blocks
  the JS thread, so a second `onPress` physically can't land). On native,
  `Alert.alert` is async and non-blocking, so the commit button stays enabled
  (and un-dimmed) for the entire window both dialogs are open, including the
  gap between the first confirm resolving and the second (price-guard) dialog
  appearing. This was already a narrow pre-existing gap in spec 107's single
  confirm, but spec 109 doubles the number of async dialogs the button survives
  through, which meaningfully widens the exposure. Given the task explicitly
  asked to review "busy handling across both confirms," flagging here rather
  than as a nit. Suggested fix: set `busy(true)` at the top of `onCommit` (before
  the first `confirmAction` call) and only clear it in `runReceive`'s `.finally`
  or in an explicit decline branch, so the button is disabled from the first tap
  through to RPC resolution on both platforms.
- `supabase/migrations/20260705000000_cost_on_receipt.sql:275-283` vs
  `:340-347` — **two undocumented-in-the-header deltas from the "verbatim +
  exactly 4 hunks" claim** (matches the task's flagged pair). The migration
  header (lines 22-61) states the body is copied verbatim from
  `20260704000000_po_loop.sql:160-301` with EXACTLY four hunks, and the "Files
  changed" section repeats "EXACTLY the four hunks." In fact there are two more
  deltas beyond the four: (1) the step-5 `'PO received'` vendor-name fetch, which
  was an unconditional `select v.name into v_vendor_name ...` in the spec-107
  source, is now wrapped in `if v_vendor_name is null then ... end if` so it
  reuses whatever the cost-path (§3b) already resolved; (2) the spec-107 source
  carried a standalone prose comment at `20260704000000:260-264` explaining a
  design-vs-prose contradiction in the `coalesce(p_client_uuid,
  receive_client_uuid)` ordering — that comment block is silently dropped in the
  new file (the equivalent code is preserved at `:323-329`, just the historical
  "Note:" aside is gone). Both are behaviorally inert (same net result; the
  lazy fetch just avoids a redundant query) and BOTH are in fact called out
  inline at the delta sites themselves (lines 276-277 and 340-341) — so this
  isn't hidden, it's just inconsistent with the header's "EXACTLY four hunks"
  framing. For a migration whose entire stated discipline is "diff this
  hunk-by-hunk to verify the four hunks are the ONLY delta" (line 61), a reviewer
  following that instruction literally would flag a false mismatch. Add these two
  deltas to the header's hunk list (or a short "additionally" note) so the
  stated diff surface matches the actual diff surface.

### Nits

- `src/screens/cmd/sections/ReceivingSection.tsx:200-206` — the `flagged` array
  is built with two inline narrowing casts (`d as { newCasePrice?: number }` and
  `d as { newCasePrice: number }`) to probe an optional field on a union produced
  by the ternary at `:187-189`. Typing `deltas` explicitly as
  `Array<{ poItemId: string; receivedQty: number; newCasePrice?: number }>`
  (matching the `receivePurchaseOrder` line-arg type it's about to be passed to)
  would let `.newCasePrice` be read directly without the casts. Not a
  suppression — the casts are safe and match the real runtime shape — just a
  slightly indirect way to get there.
- `supabase/migrations/20260705000000_cost_on_receipt.sql:1016-1020` (spec §16,
  not the migration itself) — the divide-by-zero non-guard on
  `case_qty × sub_unit_size` and the `numeric(10,2)` vs unconstrained-`numeric`
  rounding divergence between `item_vendors.case_price` and
  `inventory_items.case_price` are both pre-flagged by the architect as
  known/accepted, non-blocking. Confirmed neither was silently "fixed" (no
  `greatest()`/`nullif()` wrapper was added) — consistent with the design.
  Not a finding, just confirming fidelity to the documented decision.
- `src/lib/db.ts:1576-1625` — `receivePurchaseOrder`'s per-line arg-builder
  spread (`...(typeof ln.newCasePrice === 'number' && Number.isFinite(...) ? {...} : {})`)
  duplicates the identical finite-check idiom the frontend already runs in
  `ReceivingSection.tsx:183-186` (rounds to 2dp, checks `Number.isFinite`,
  compares to ghost). Two independent implementations of "is this a real,
  different price" is defensible here (one decides *whether to send*, the other
  decides *whether the key is well-formed enough to serialize*) but worth a
  one-line comment cross-referencing the other check so a future reader doesn't
  wonder why the same shape is validated twice. (out-of-scope) — not asking for
  a shared helper across the FE/BE boundary, just a pointer comment if either
  file is touched again.

## Resolution (main Claude, post-review fix pass — 2026-07-03)

- **Should-fix 1 (OQ-6 last-entry-wins not pinned) — FIXED.**
  `supabase/tests/cost_on_receipt.test.sql` case (11): two sequential receives
  with DISTINCT client_uuids at case 24 then case 36 against the same line.
  Asserts the intermediate price applied first (sequence is real), the LAST
  price lands on BOTH item_vendors and inventory_items (+ ★ per-each 9), and
  BOTH transitions are recoverable (two audit rows, asserted by detail
  EXISTENCE — same-transaction rows share created_at, so ordering by it would
  be nondeterministic). 7 assertions; plan 40 → 55.
- **Should-fix 2 (busy doesn't guard the confirms) — FIXED.**
  `src/utils/confirmAction.ts` gained an optional, backward-compatible
  `onCancel` (web decline branch; native Cancel onPress + Android
  onDismiss-on-outside/back when provided). `ReceivingSection.onCommit` now
  sets `busy(true)` BEFORE the first confirm and releases it via `onCancel` on
  either dialog's decline (RPC `.finally` unchanged), so the commit button is
  disabled from first tap through both native async dialogs. Two new jest
  regression pins ("releases the busy gate when the 30% / the FIRST confirm is
  declined — a retry commit succeeds"); the mock confirmAction now exercises
  onCancel on decline.
- **Should-fix 3 (header's "exactly four hunks" vs two inert deltas) — FIXED.**
  The migration header now carries an "ADDITIONALLY" block enumerating both
  inert deltas (lazy vendor-name fetch; two dropped historical comment blocks)
  and the closing diff instruction reads "the four hunks + the two inert
  deltas above are the ONLY delta." Comment-only change — no functional SQL
  delta, and the prod-apply md5 verification normalizes comments away.
- **Nits 1/3 (inline narrowing casts; cross-reference comment) — LEFT.** Both
  safe and explicitly framed by the reviewer as non-blocking/out-of-scope;
  deferred to the cleanup backlog rather than churning reviewed code.
- **Nit 2 — no action needed** (fidelity confirmation, not a finding).

### Browser verification (cost-on-receipt flow, local stack)

Create PO from Reorder (BJs, 9 lines) → mark sent → Receiving: ghost showed
15.00 (= line snapshot 2.50 × case_qty 6) — the pinned bridge. Entered case
price 30 (100% over): commit fired the stock confirm then the 30% guard
listing `Caramel Mouse: $15.00 → $30.00`. DECLINED → whole commit aborted (PO
still sent, 0 received, costs untouched, no audit row) and the busy gate
RELEASED — the retry commit fired both dialogs again (Should-fix 2 proven
live). ACCEPTED → item_vendors 14.99→30.00 / 2.50→5.00, inventory_items
identical (★-consistent), stock 0→6, PO → partial, one 'PO price change'
audit row with old→new in both bases. Realtime refresh re-prefilled the line
(ALREADY 6 / OUTSTANDING 30, ghost back to snapshot 15.00). Console clean.
Test artifacts fully reverted (PO + audit deleted, item/link/stock restored).

Post-fix gates: pgTAP 55/55 in-file, 62/62 files; jest 927/927 (83 suites,
+2); `tsc --noEmit` + `tsc -p tsconfig.test.json --noEmit` both clean.
