# Spec 109 (cost-on-receipt) — backend-architect drift review

Mode: post-implementation architectural-drift review (author of `## Backend
design`). Verdict summary: **the implementation matches the design.** The
migration body is the spec-107 `receive_purchase_order` verbatim + exactly the
four declared hunks. Both flagged non-hunk deltas are **within design**. No
Critical, no Should-fix. Four Minor / informational notes below — none blocking.

Independent verification performed (not taken from the dev's semantic-diff
claim): line-by-line diff of `20260705000000_cost_on_receipt.sql:108-372`
against the live spec-107 body `20260704000000_po_loop.sql:160-301`; read of
the pgTAP suite, `db.ts` surface, `db.poLoop.test.ts`, `useStore.ts` action +
interface, `ReceivingSection.tsx` commit path, `priceGuard.ts` + its test, and
the i18n ×3 keys.

---

## RULING on the two flagged non-hunk deltas

### Delta (1) — lazy `if v_vendor_name is null` guard on the 'PO received' fetch — WITHIN DESIGN

Spec-107 fetched the vendor name **unconditionally** at the per-call audit
(`20260704000000_po_loop.sql:275-278`). The implementation wraps that same
fetch in `if v_vendor_name is null then … end if`
(`20260705000000_cost_on_receipt.sql:342-347`), because HUNK 3's audit block now
resolves `v_vendor_name` lazily on the first changed line
(`:278-283`) and reuses it.

**Ruling: within design, explicitly.** Design §5 states verbatim:
"`v_vendor_name` is already resolved for the `'PO received'` row
(20260704000000:275-278) — reuse it." The guard is the mechanical realization of
that "reuse it" instruction. Semantic equivalence holds on every path:

- **No changed line:** `v_vendor_name` is still NULL at `:342`, the guard is
  true, the fetch runs — byte-identical result to spec-107 (same query, same
  join, same `where po.id = p_po_id`).
- **≥1 changed line:** `v_vendor_name` was set at `:278-283` by the identical
  query (same three tables, same predicate), so the value at `:342` is what the
  unconditional fetch would have produced. Skipping the re-fetch is a pure
  optimization with no observable difference.

The two fetch sites (`:278-283` and `:343-346`) are byte-identical queries, so
the "reuse" cannot diverge. This is the correct realization, not drift.

### Delta (2) — two dropped spec-107 comment blocks — ACCEPTABLE hygiene; do NOT restore

**(2a) The coalesce reviewer-aside** (`20260704000000_po_loop.sql:260-264` — the
parenthetical "(Note: the design's §3 CODE snippet showed
`coalesce(receive_client_uuid, p_client_uuid)`, which … Resolved toward the
explicitly-stated prose intent; see backend-developer handoff.)").
**Correctly dropped.** That aside was a spec-107-internal note documenting a
one-time reconciliation between spec 107's design prose and its code snippet, at
the moment that decision was made. The **operative** coalesce prose — why the
column holds the LATEST uuid, and that `coalesce(p_client_uuid,
receive_client_uuid)` overwrites-when-supplied — is **retained verbatim** at
`20260705000000_cost_on_receipt.sql:323-329`, and the executable line
(`:334`) is byte-identical. Carrying the stale spec-107→spec-107 reconciliation
aside into a spec-109 file would be misleading (it references a handoff that is
not this spec's). Dropping it is correct comment hygiene.

**(2b) The "Stock-only: NO case_price / cost_per_unit mutation (OQ-2)" note**
(`20260704000000_po_loop.sql:220-221`, inside the apply-loop comment).
**Correctly dropped — it is now false.** Spec 109's entire purpose is to add
the cost mutation this note asserted was absent. Leaving it would directly
contradict HUNK 2/3 sitting a few lines below. Its intent is not lost: the OQ-2
guarantee (`catalog_ingredients.default_cost` is NEVER written) is re-documented
accurately in the file header (`:78`) and the function comment (`:390`), and the
new loop comment (`:200-201`) correctly reframes the stock block as "unchanged
spec-107 block. Independent of the cost path."

**No comment block should be restored.** Both removals delete statements that
became stale or false under spec 109; both underlying guarantees are re-stated
correctly elsewhere.

---

## Contract conformance against the design

Verified point-by-point; all match:

- **★ divisor identical for both targets, no `is_primary` gate on the item
  scalar.** `v_new_cost_per_unit := v_line.new_case_price / (v_case_qty *
  v_sub_unit_size)` is computed once (`:246`) and written to BOTH the
  `item_vendors` upsert (`:254`) and the `inventory_items` UPDATE (`:265`). The
  item-scalar UPDATE (`:263-268`) has NO `is_primary` predicate — its only
  guards are `ii.id = v_item_id` and the store pin `ii.store_id = v_store_id`.
  The owner-pinned whipsaw is held. pgTAP case (2) (`:322-365`) drives a
  genuine non-primary delivery (PO against V2, scalar primary = V1) and asserts
  the scalar still rewrote (`55.00`) while the V1 primary link stayed `20.00`.

- **Idempotency ordering — dedup returns BEFORE any cost write.** The step-(2)
  short-circuit (`:159-175`) `RETURN`s inside the `if found` block, which is
  strictly above the step-(3) `for … loop` (`:189`) where the entire cost block
  lives (`:210-308`). No cost write is reachable on the replay path. The replay
  return carries `'price_changes', '[]'::jsonb` (`:173`). pgTAP case (3)
  (`:628-660`) pins conflict:true, `price_changes: []`, link+scalar unchanged
  (stays 44), stock not double-incremented (stays 12), and the audit row count
  stays 1.

- **Validation semantics (§1).** Absent key OR JSON null → SQL NULL via
  `jsonb_to_recordset` → `v_line.new_case_price is not null` is false → no cost
  read/write (`:214`). `= 0` → fails the `> 0` clause (`:243`) → no-op. Equal to
  current → fails `is distinct from v_old_case_price` (`:244`) → no-op. `< 0` →
  `raise … using errcode = 'P0001'` (`:215-217`), which aborts the whole
  single-transaction call. Non-numeric scalar → `22P02` at the recordset cast,
  before the loop body — relied upon, not re-checked (matches design). pgTAP
  case (5) pins P0001 + no half-applied stock; cases (6)/(7) pin the zero/equal/
  absent no-ops with stock still received.

- **Audit shape (§4).** One row per changed line, `action = 'PO price change'`,
  `detail` = old→new CASE (`coalesce(v_old_case_price::text,'—') || ' → ' ||
  new`), `value` = old→new PER-EACH (`:285-296`). `user_id = auth.uid()`
  (INVOKER, spoof-proof). Old values captured from the link at `:234-238` BEFORE
  the upsert; a link-missing INSERT leaves them NULL → rendered `'—'`. pgTAP
  cases (8) and (4) pin both bases recoverable and the `'—'` link-missing render.

- **Link-missing INSERT-or-update.** `insert … on conflict (item_id, vendor_id)
  do update` (`:253-258`), `is_primary = false` on INSERT, `is_primary` left
  untouched on UPDATE. pgTAP case (4) pins the INSERT (`is_primary=false`, new
  price, scalar still rewritten); case (2) pins the UPDATE-path link stays
  `is_primary=false`.

- **Return envelope (§7).** Additive `price_changes` array, accumulated via
  `v_price_changes := v_price_changes || jsonb_build_object(...)` (`:300-307`),
  `[]` default (`:137`), present on both the replay return (`:173`) and the
  final return (`:370`). Element shape matches the design's six keys exactly.
  pgTAP case (9) pins the element shape.

- **HUNK 1 applied to BOTH recordset projections.** The apply-loop projection
  (`:191`) AND the `v_line_count` projection (`:351`) both carry the third
  column `new_case_price numeric`, keeping the column list byte-consistent as
  the header claims. (Functionally the count only reads `po_item_id`, but the
  consistency is correct and harmless.)

- **ACL / security unchanged.** No grant/revoke re-emit (signature-identical
  `create or replace` preserves the spec-107 ACL). `security invoker` +
  `set search_path = public` unchanged. Auth gate `auth_can_see_store(v_store_id)`
  fires as the first block (`:149-151`), before any write. `vendor_id` is added
  to the existing top-of-function select (`:141-142`) — the one signature-safe
  read the cost path needs. No RLS/policy change; no publication change (header
  documents "no realtime container restart").

## FE contract consumption against the design

- **Pinned bridge.** `expectedCasePrice(costPerUnit, caseQty) = costPerUnit ×
  caseQty` (`priceGuard.ts:36-41`), reconstructing `po_items.cost_per_unit ×
  case_qty`. Used for BOTH the ghost seed (`ReceivingSection.tsx:155-156`) and
  the guard baseline (`priceGuard.ts:64`) — identical quantity, no
  ghost/guard divergence, as §6 requires.

- **Client-side 30% confirm.** `isPriceGuardTripped` compares case-to-case with
  the `expected > 0` skip and strict `> 0.30` (`priceGuard.ts:58-69`). It fires
  as a SECOND nested `confirmAction` INSIDE the existing stock-commit confirm's
  success callback (`ReceivingSection.tsx:238-262`), BEFORE `runReceive()` (the
  RPC). Declining aborts the whole commit (nothing received). `caseQty` is
  plumbed onto `PoLine` (`db.ts:1413`, `mapPoItemRow:1428`,
  `fetchPurchaseOrderLines` select `:1516`). The `caseQty > 1` bridge-pin test
  (`priceGuard.test.ts:65-74`) proves a naive per-counted-vs-case comparison
  would trip on the wrong number.

- **priceChanges toast + `db.ts` mapping.** The action returns
  `{ status, priceChanges }` (`useStore.ts:2491`); the section toasts the count
  when non-empty (`ReceivingSection.tsx:220-225`). `db.ts` maps snake→camel with
  `null` preserved on the `old_*` fields, `Number(...)` elsewhere, `[]` default
  (`:1615-1623`); the arg builder emits `new_case_price` only for a finite
  number (`:1600-1602`). `db.poLoop.test.ts` pins the finite-only emission, the
  snake→camel mapping incl. `old_* → null`, and the older-server `[]` default.

- **i18n ×3 parity.** All seven `section.receiving.*` keys
  (`caseThisDeliveryCol`, `caseThisDeliveryPlaceholder`, `pricesUpdatedToast`,
  `priceGuardTitle/Body/Line/Cta`) present in en / es / zh-CN (`:545-551` in
  each). OQ-5 held — the input is only in the admin `ReceivingSection` PO-mode;
  no staff surface touched.

- **No `db.ts` bypass.** All DB access for this feature routes through
  `db.receivePurchaseOrder` / `db.fetchPurchaseOrderLines`; no direct
  `supabase.from/rpc` in the section or store.

---

## Findings (ranked)

### Critical
None.

### Should-fix
None.

### Minor / informational (non-blocking — no action required to ship)

1. **Divide-by-zero non-guard on the ★ divisor — carried forward as designed.**
   `v_case_qty * v_sub_unit_size` (`:246`) is `coalesce(…,1)`-guarded against
   NULL but not against an explicit `0`. Design §2 / risk §16 flagged this as a
   *known non-guard* (the reorder RPCs don't guard it either; 0 is not a legal
   `case_qty`). Implementation matches the design's stated position. A
   `greatest(v_case_qty * v_sub_unit_size, 1)` wrap remains the belt-and-
   suspenders option if a reviewer wants it; I do not require it. `Cite:
   20260705000000_cost_on_receipt.sql:246`.

2. **`item_vendors.case_price numeric(10,2)` vs `inventory_items.case_price`
   unconstrained — as designed.** The same `new_case_price` writes both; a >2dp
   entered price rounds on the link and not on the item (sub-cent divergence,
   within the spec-104 $0.001 per-each tolerance). Design risk §16 documented
   this; the FE input is a normal 2dp currency field. Informational only.

3. **pgTAP does not assert `catalog_ingredients.default_cost` is unwritten
   (OQ-2 case f) as a standalone probe.** The design §7/§15 listed case (f)
   ("capture default_cost before/after; assert unchanged"). The delivered suite
   (40 assertions) covers cases 1–10 but folds OQ-2 into "the body contains no
   `catalog_ingredients` UPDATE" rather than a before/after value assertion. The
   guarantee is structurally true (grep-verifiable: the new body has zero
   `update … catalog_ingredients`), and every fixture seeds `default_cost 5.00`
   so a regression would be catchable, but an explicit before/after `is(...)`
   pin would harden the OQ-2 AC against a future edit. Non-blocking — suggest
   adding one assertion in a follow-up if the suite is touched again. `Cite:
   supabase/tests/cost_on_receipt.test.sql` (no `default_cost` assertion
   present).

4. **`v_existing` is assigned but only used via `found` — cosmetic, inherited
   from spec 107.** The dedup reads `select receive_client_uuid into v_existing`
   then branches on `if found` (`:160-163`), never reading `v_existing`. This is
   verbatim spec-107 behavior (not introduced here) and functionally correct
   (`found` is the real signal). Noted only for completeness; do not change (it
   would break the verbatim-copy discipline for zero benefit). `Cite:
   20260705000000_cost_on_receipt.sql:122, 160-163`.

---

## Bottom line

The migration is the spec-107 body verbatim + exactly the four hunks declared in
the header; the semantic-diff-is-zero-outside-the-hunks claim holds under
independent line-by-line verification. Both flagged non-hunk deltas are within
the design (the vendor-name reuse is the literal realization of §5's "reuse it";
both dropped comments were stale/false under spec 109 and their guarantees are
re-stated correctly). The ★ divisor is identical across both targets with no
`is_primary` gate on the scalar; idempotency short-circuits before any cost
write; validation, audit shape, and envelope match §1/§4/§7; the FE consumes the
pinned bridge, the client-side 30% confirm, the priceChanges toast, and the
`caseQty` plumbing exactly as designed. Four Minor notes, none blocking.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor
  (all pre-flagged in the design or inherited from spec 107; none blocking).
  Both flagged non-hunk deltas ruled WITHIN DESIGN — the lazy vendor-name guard
  is the literal realization of design §5 "reuse it", and both dropped comment
  blocks were stale/false under spec 109 with their guarantees re-stated
  correctly elsewhere; no comment should be restored. Migration verified as
  spec-107 body verbatim + exactly the four hunks by independent line-by-line
  diff.
payload_paths:
  - specs/109-cost-on-receipt/reviews/backend-architect.md

## Resolution note (main Claude — 2026-07-03)

No Should-fixes to action. Of the 4 Minors: the two inert-delta items are now
ENUMERATED in the migration header (code-reviewer Should-fix 3 — documentation
only, the deltas themselves stand as ruled WITHIN DESIGN); the suggested
standalone OQ-2 default_cost pin landed as pgTAP case (14); divide-by-zero and
rounding-divergence remain accepted-as-designed. Post-fix gates green
(pgTAP 62/62 files, jest 927/927, both typechecks).
