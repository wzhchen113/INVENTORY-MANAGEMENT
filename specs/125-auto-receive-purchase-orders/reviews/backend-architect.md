# Backend-architect drift review — spec 125 (auto-receive purchase orders)

Reviewed the STAGED implementation against the `## Backend design` I authored in
`specs/125-auto-receive-purchase-orders.md`. Verdict: **contract honored, ship-worthy.**
One Minor drift and one confirmation note below. No Critical, no Should-fix.

Files reviewed:
- `supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql`
- `src/lib/db.ts` (`createPurchaseOrderDraft`, lines 1545–1605)
- `src/store/useStore.ts` (`createPoDraft`, lines 2662–2715)
- Cross-referenced `supabase/migrations/20260705000000_cost_on_receipt.sql`
  (`receive_purchase_order`) for restock fidelity.

## Contract confirmation (the five asks)

**(1) Migration matches the RPC contract — CONFIRMED.**
- SECURITY DEFINER + `set search_path = public, pg_temp` (line 67–68). The `pg_temp`
  addition beyond `receive_purchase_order`'s `set search_path = public` is correct
  hardening for a DEFINER function — approved.
- Strict open-PO filter (lines 86–89): `status in ('sent','partial')`,
  `received_at is null`, `expected_delivery is not null`, `expected_delivery <= p_as_of`.
  Exact match to design + AC lines 35–38.
- Inlined full-receive restock: `delta := greatest(0, ordered_qty - received_qty)`
  (line 104), store-pinned `current_stock += delta` with `AND ii.store_id = v_po.store_id`
  (lines 111–115), `received_qty = ordered_qty` (line 107). `greatest(0, …)` guard against
  an over-received line decrementing stock is present.
- Header flip (lines 124–129): `status='received'`, `received_at=now()`, `received_by=null`
  (system attribution), `receive_client_uuid = md5(id::text || ':auto-receive')::uuid`
  (deterministic, unique per PO). Match.
- One system audit row per PO (lines 142–145): `user_id=null`, `action='PO auto-received'`,
  same column shape as `receive_purchase_order`'s write. Match to AC lines 57–58.
- Grants (lines 175–178): `revoke execute … from public, anon, authenticated`;
  `grant execute … to postgres, service_role`. Exact match, mirrors
  `record_missed_orders_for_day`.
- Cron (lines 190–201): `'auto-receive-purchase-orders-daily'` at `'0 8 * * *'`,
  body `select public.auto_receive_due_purchase_orders();`, wrapped in the
  `if exists … unschedule` re-apply guard. Match.
- Version no collision: confirmed `20260719000000` is the latest on disk
  (prior is `20260718000000_reorder_list_has_po.sql`; nothing between).

**(2) Decision A honored — CONFIRMED.** `useStore.ts:2706–2707`:
`const expectedDelivery = vendor.scheduleKnown && vendor.nextDeliveryDate ? vendor.nextDeliveryDate : undefined;`
Guessed `as_of+7` schedule-unknown fallback is NOT persisted (`undefined` → key omitted
→ column stays NULL → never auto-receives). Matches design line 287 verbatim and AC
lines 30–32.

**(3) `db.ts` omit-when-absent — CONFIRMED.** `db.ts:1550` adds
`expectedDelivery?: string | null` to the param type; `db.ts:1574` inserts
`...(params.expectedDelivery ? { expected_delivery: params.expectedDelivery } : {})`.
Key is omitted (not written as NULL) when absent — column defaults to NULL. camelCase→snake
`expectedDelivery` → `expected_delivery`. Match. (The `| null` on the param type is a benign
superset of the design's `string`; a null value falsy-omits identically.)

**(4) No publication / realtime change — CONFIRMED.** No `alter publication` in the migration.
`purchase_orders` + `inventory_items` are already in `supabase_realtime`; `po_items` rides its
parent header UPDATE. No `docker restart supabase_realtime_imr-inventory` needed. Header comment
(lines 41–47) states this correctly.

**(5) Inlined restock faithful to `receive_purchase_order`; cost path omission acceptable —
CONFIRMED.** The stock/status/attribution semantics are a faithful inline of
`receive_purchase_order`'s stock path, adapted for full-remainder receive (delta from
ordered−received rather than a caller-submitted `received_qty`). The spec-109 cost path
(`new_case_price`, `item_vendors` upsert, scalar re-price, 'PO price change' audit) is
correctly **NOT** ported. This is right, not a gap: auto-receive is triggered by a calendar
date, not a physical delivery with an invoice — there is no operator and no new case price to
enter, so cost-on-receipt is structurally inapplicable. The item keeps its existing
`cost_per_unit`. Omission is correct and in line with Out-of-scope ("over-receipt self-corrects
via EOD"). No action needed.

## Findings

### Minor — 1 finding

**M1. `po_items.received_qty` write is unconditional, but the design gated it on `delta > 0`.**
`migration:106–108` sets `received_qty = v_line.ordered_qty` for **every** line, outside the
`if v_delta <> 0` guard (only the `inventory_items` stock write is gated, lines 110–116). The
design body (spec line 224) reads: *"When `delta > 0`: `UPDATE po_items SET received_qty =
ordered_qty` and `UPDATE inventory_items …`"* — i.e. both writes gated together.

Behavioral impact is confined to a single rare edge: a line that was manually **over-received**
(`received_qty > ordered_qty`) on a PO still sitting `partial` (because a *different* line is
short). On auto-receive, `delta = greatest(0, negative) = 0`, so stock is correctly left
untouched — but the unconditional line now writes `received_qty` **down** to `ordered_qty`,
shrinking the recorded receipt below what was physically logged. Stock is unaffected (the money
number is right); only the `po_items.received_qty` audit figure regresses on that one line.

This is behaviorally inert on inventory and self-corrects at the next EOD count, so it does not
block ship. But it is a genuine deviation from the written contract and slightly weakens the
receipt record. Options: (a) accept and note (the over-received-line-on-a-partial-PO scenario is
vanishingly rare and the AC language "topped up to ordered quantity" arguably tolerates it); or
(b) move the `po_items` UPDATE inside the `if v_delta <> 0` guard to match the design exactly —
a one-line change that makes the received_qty write monotonic (never decreases). I lean (b) for
record fidelity, but defer to the developer/PM; either is defensible. Flagging so the drift is
recorded, not silently absorbed.

## Prod-apply reminder (pending main Claude, per project MEMORY)

This is a function + cron change — invisible to the `db-migrations-applied` migration-list drift
gate on a body-only basis. After MCP `execute_sql` against `ebwnovzzkwhsdxkpyjka` and the exact
`20260719000000` insert into `supabase_migrations.schema_migrations`, POST-APPLY verify BOTH:
- `select 1 from pg_proc where proname = 'auto_receive_due_purchase_orders';`
- `select 1 from cron.job where jobname = 'auto-receive-purchase-orders-daily';`
The migration header (lines 49–55) already documents this. Not yet applied — verification is
main Claude's to run.

## Summary

- Critical: 0
- Should-fix: 0
- Minor: 1 (M1 — unconditional `po_items.received_qty` write vs design's delta-gated write;
  inert on stock, regresses a record figure only on the over-received-line-on-a-partial-PO edge)

All five contract asks confirmed. Decision A intact. Cost-path omission is correct by design.
No RLS, publication, or edge-function drift.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 1 finding (Minor). Contract honored;
  Decision A intact; cost-path omission correct. Prod-apply + pg_proc/cron.job
  verification for migration 20260719000000 still pending main Claude.
payload_paths:
  - specs/125-auto-receive-purchase-orders/reviews/backend-architect.md
