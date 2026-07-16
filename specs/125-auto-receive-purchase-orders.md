# Spec 125: Auto-receive purchase orders on expected delivery date

Status: READY_FOR_REVIEW

## User story
As the owner / store manager, I want an open purchase order to auto-receive once
its expected delivery date arrives, so that POs that were physically delivered
but never manually marked received stop lingering forever as "inbound" on the
reorder screen and skewing reorder math.

Concrete scenario: Charles's store has a US FOOD PO sent July 9 with Blue Cheese,
Chicken Tenderloin, Ground Beef, and Creme Brulee. It was delivered, but nobody
tapped "receive." Days later those items still show as inbound (`pending_po_qty`)
on the reorder screen, suppressing reorder suggestions. The owner wants the PO to
auto-receive on/after its scheduled delivery date so on-hand and inbound both
correct themselves.

## Background / observed problem
Open POs (`status in ('sent','partial')`, `received_at IS NULL`) count as
"inbound" via the reorder RPC's `pending_po_qty`. A delivered-but-unreceived PO
stays inbound indefinitely. There is no time-based expiry today.

## Acceptance criteria

Persist expected delivery on new POs:
- [ ] When a PO is created from the reorder card, its header row is written with
      `expected_delivery` = the creating vendor's scheduled next-delivery date
      (the value the reorder engine already computes as `nextDeliveryDate` /
      `next_delivery_date`).
- [ ] A PO created for a vendor whose `nextDeliveryDate` is null/absent is
      written with `expected_delivery` NULL (no synthetic date) and therefore
      never auto-receives (forward-only, per Out of scope).

Daily auto-receive job:
- [ ] A daily scheduled DB job auto-receives every PO where
      `status in ('sent','partial')` AND `received_at IS NULL` AND
      `expected_delivery IS NOT NULL` AND `expected_delivery <= current_date`,
      across all stores/vendors.
- [ ] Auto-receive is a FULL receive: every outstanding line's `received_qty` is
      topped up to its ordered quantity, and `inventory_items.current_stock` is
      incremented by exactly the outstanding remainder (ordered − already
      received) for each line.
- [ ] After a successful auto-receive of a PO, its header `status` = `received`
      and `received_at` is set (non-null).
- [ ] A partially-received PO (`status = 'partial'`, some lines already have
      `received_qty > 0`) is topped up: only the remaining delta per line is
      added to stock, and it flips to `received`.

Idempotency & safety:
- [ ] Re-running the job on the same day (or any subsequent day) does NOT
      re-increment `current_stock` for a PO it already received — stock is added
      exactly once per PO.
- [ ] POs with `expected_delivery IS NULL` (e.g. the 6 legacy April `sent` POs)
      are never auto-received.
- [ ] POs with `status in ('draft','cancelled','received')` are never touched by
      the job.
- [ ] Each auto-receive writes an `audit_log` row attributing the action to the
      system (not to a real user), given `auth.uid()` is NULL in cron context.

## In scope
- Threading the vendor's `nextDeliveryDate` into the PO-draft creation path so
  `expected_delivery` is persisted on the header at creation:
  `createPoDraft` (`src/store/useStore.ts:2662`) →
  `db.createPurchaseOrderDraft` (`src/lib/db.ts:1545`) → header insert.
- A new scheduled daily DB job (pg_cron) that performs the auto-receive across
  all stores, reusing the existing atomic restock semantics.
- Migration(s) for the scheduled job and any new/edited RPC.
- pgTAP DB test(s) for the auto-receive RPC behavior (idempotency, partial
  top-up, null-date skip, status guards).

## Out of scope (explicitly)
- **No backfill.** Legacy POs with null `expected_delivery` stay manual forever.
  Rationale: owner explicitly chose forward-only; backfilling would auto-receive
  stale April POs with guessed dates.
- **No per-PO manual "expected delivery" editor UI in v1** — unless the architect
  finds it trivial to surface the persisted value read-only. Rationale: owner
  asked only for the auto-behavior; edit UI is a separate ask.
- **No partial/quantity-aware auto-receive.** Auto-receive is always a full
  receive of the remainder; we do not attempt to guess short shipments.
  Rationale: owner accepts EOD counts override on-hand, so over-receipt
  self-corrects.
- **No change to how `pending_po_qty` / inbound is computed** — once a PO flips to
  `received` it naturally drops out of the inbound set; no reorder-RPC change.
- **No new notification/email** on auto-receive unless the architect deems it a
  cheap add (see open questions). Rationale: not requested; keep v1 minimal.
- **No customer PWA or staff-app surface.** Admin/reorder + DB job only.

## Open questions resolved (pre-answered by owner — do NOT re-open)
- Q: What does auto-receive do — flag only, or actually receive + restock? →
  A: FULL receive + restock, reusing the existing atomic manual-receive
  semantics (set `received_qty` to remainder, increment `current_stock`).
  Over-receipt is acceptable; EOD counts self-correct.
- Q: When does it fire? → A: ON the delivery date — any open PO with
  `expected_delivery <= current_date`.
- Q: What date drives it? → A: the vendor's scheduled next-delivery date (already
  computed by the reorder engine per vendor), persisted onto the PO
  `expected_delivery` column at creation.
- Q: Backfill legacy null-date POs? → A: No. Forward-only.
- Q: Which statuses? → A: Only `status in ('sent','partial')`. Never
  draft/cancelled/received.

## Open questions for the architect (genuinely undecided)
1. **Reuse `receive_purchase_order` per-PO vs. a new dedicated auto-receive RPC.**
   The existing atomic RPC `receive_purchase_order(p_po_id, p_lines, p_client_uuid)`
   (`supabase/migrations/20260704000000_po_loop.sql:160`, re-created in
   `20260705000000_cost_on_receipt.sql`) already does the restock + status flip +
   audit + idempotency-via-`receive_client_uuid`, BUT it sets
   `received_by = auth.uid()`, which is NULL in a cron/SECURITY-DEFINER context.
   Decide: loop-and-call the existing RPC per open PO, or write a dedicated
   auto-receive RPC that inlines the restock and records a system attribution for
   `received_by` (e.g. NULL-with-audit-note, or a sentinel). Whichever path, the
   job must iterate ALL stores.
2. **Deterministic `p_client_uuid` scheme for idempotency.** To make re-runs safe
   without relying on run timing, derive a stable client uuid per PO (e.g. from
   `po_id`) so a repeat returns `conflict:true` without re-incrementing stock —
   or gate purely on `received_at IS NULL` in the job's selection. Decide the
   mechanism and confirm it composes with the existing `receive_client_uuid`
   idempotency.
3. **Cron run hour + date/timezone handling.** `expected_delivery` is a `date`;
   `current_date` is UTC in Postgres. Pick the run hour (the existing
   `record-missed-orders-daily` template runs `0 7 * * *`) and confirm the
   date-comparison timezone matches how the reorder engine computed
   `next_delivery_date`, so a PO doesn't auto-receive a day early/late relative to
   the store's local delivery day.
4. **Which creation paths persist `expected_delivery`.** The draft path
   (`createPoDraft` → `createPurchaseOrderDraft`) is the primary hook. Decide
   whether the legacy `createPurchaseOrder` "Mark as Submitted" path
   (`src/lib/db.ts:1443`) should also set `expected_delivery`, or only the draft
   path.
5. **Set `expected_delivery` at send time as a fallback.** Consider also setting
   `expected_delivery` on the draft→sent flip in `send-po-email` (for POs that
   were drafted before this feature but sent after). Decide in/out for v1.
6. **Notification (cheap-add gate).** Decide whether an auto-receive should emit
   any signal (e.g. a bell entry) — only if trivial; otherwise defer.

## Key code facts (handed from PM code trace)
- `expected_delivery date` declared at
  `supabase/migrations/20260405000759_init_schema.sql:158`; DORMANT — never
  written or read anywhere today.
- Reorder RPC `report_reorder_list` computes per-vendor `next_delivery_date`
  (= as-of + order-schedule offset, fallback +7); surfaced to FE as
  `ReorderVendor.nextDeliveryDate` (`src/lib/db.ts:4027`). `createPoDraft`
  (`src/store/useStore.ts:2662`) never reads it, so it is not persisted onto the
  PO.
- Receive is atomic RPC `receive_purchase_order(p_po_id, p_lines, p_client_uuid)`
  (`supabase/migrations/20260704000000_po_loop.sql:160`, re-created in
  `20260705000000_cost_on_receipt.sql`): increments
  `inventory_items.current_stock += delta`, sets per-line `received_qty`
  (additive), sets header `status` (received if all lines full else partial) +
  `received_at` (only when fully received) + `received_by = auth.uid()`, writes
  `audit_log`, idempotent via `receive_client_uuid` (repeat client_uuid returns
  `conflict:true` WITHOUT re-incrementing).
- Cron context caveat: `received_by = auth.uid()` is NULL under cron/SECURITY
  DEFINER — architect must decide system attribution.
- Cron infra: pg_cron + pg_net enabled. Clean template for a pure-DB scheduled op
  is the direct-RPC pattern —
  `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:242`:
  `cron.schedule('record-missed-orders-daily', '0 7 * * *', $cron$ select
  public.<rpc>(...) $cron$)` with an `if exists … unschedule` re-apply guard.

## Dependencies
- Existing atomic receive semantics from
  `supabase/migrations/20260704000000_po_loop.sql` /
  `20260705000000_cost_on_receipt.sql`.
- pg_cron + pg_net (already enabled).
- Reorder RPC's `next_delivery_date` computation (`report_reorder_list`).
- New migration(s) for the scheduled job and any new/edited auto-receive RPC.

## Project-specific notes
- Cmd UI section / legacy: PO-draft creation originates in the reorder Cmd UI
  flow (`src/screens/cmd/sections/`), through `useStore` → `db.ts`. No legacy
  admin surface. The auto-receive job itself is pure DB (no UI).
- Per-store or admin-global: the daily job is admin-global (iterates ALL
  stores). PO creation remains per-store-scoped via existing paths.
- Realtime channels touched: auto-receive mutates `inventory_items.current_stock`
  and `purchase_orders`/`po_items` — clients on `store-{id}` should see the
  reflected change on next reload. RISK: realtime publication gotcha — if new
  rows/tables are added to a publication mid-session, the slot must be
  re-snapshotted (`docker restart supabase_realtime_imr-inventory`). No new
  table is expected here, so likely N/A, but the architect should confirm no
  publication change is needed.
- Migrations needed: yes (scheduled job + auto-receive RPC and/or the
  `expected_delivery` write path if any SQL default is involved).
- Edge functions touched: possibly `send-po-email` (only if open question 5 is
  answered in-scope). Otherwise none.
- Web/native scope: DB job is platform-agnostic. The `createPoDraft` thread-through
  is shared FE code (web + native).
- Tests: pgTAP DB track for the auto-receive RPC (idempotency / partial top-up /
  null-date skip / status guards); optionally a jest test for the FE
  thread-through that `expected_delivery` is passed. test-engineer routes tracks.
- Prod apply: new migrations must be pushed to prod (db-migrations-applied gate)
  — apply via Supabase MCP per project policy since `db push` lacks the prod
  password.

## Backend design

### Resolution of the six open questions (summary)
1. **New dedicated `SECURITY DEFINER` RPC**, `auto_receive_due_purchase_orders(p_as_of date default current_date)`, inlining a full-receive restock. NOT a loop over `receive_purchase_order`.
2. **Idempotency** = selection filter (`received_at IS NULL`) + always-full-receive (which stamps `received_at`, dropping the PO out permanently), with a defensive deterministic `receive_client_uuid = md5(po_id::text || ':auto-receive')::uuid`.
3. **Cron** at `0 8 * * *` UTC (distinct from `record-missed-orders-daily` at `0 7`), body calls the RPC with the default `current_date`. Coarse UTC-daily granularity, accepted.
4. **Only the draft path** (`createPoDraft` → `createPurchaseOrderDraft` → header insert) persists `expected_delivery`. Legacy `createPurchaseOrder` ("Mark as Submitted") stays NULL.
5. **No `send-po-email` fallback stamp** in v1.
6. **No notification** in v1 — the per-PO `audit_log` row is the reconciliation trail.

Plus one architect decision beyond the six (see **Decision A** below): persist `expected_delivery` **only when the vendor's schedule is known** (`scheduleKnown === true`). A schedule-unknown vendor's `nextDeliveryDate` is the reorder engine's synthetic `as_of + 7` fallback; persisting it would auto-receive on a guessed date, violating AC "no synthetic date" (spec lines 30–32).

---

### Data model changes
- **No column DDL.** `purchase_orders.expected_delivery date` already exists (dormant since `20260405000759_init_schema.sql:158` — never written or read). This spec is its first writer/reader.
- **No new index in v1.** The job's scan predicate is `status in ('sent','partial') AND received_at IS NULL AND expected_delivery IS NOT NULL AND expected_delivery <= p_as_of`, run once daily across ALL stores. The existing partial index `idx_purchase_orders_store_status_open (store_id, status) WHERE received_at is null` (`20260704000000_po_loop.sql:145`) partially covers it; on the 6-row prod PO table a seq-scan is trivial. If PO volume grows, a follow-up can add `create index … on purchase_orders (expected_delivery) where received_at is null` — flagged, not built.
- **Proposed migration:** `supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql` (latest on disk is `20260718000000_reorder_list_has_po.sql` — no collision). **Additive** (one new function + one cron job + grants); non-destructive; safe to re-apply (`create or replace` on the function; `if exists … unschedule` guard on the cron). No data backfill (forward-only, per Out-of-scope).

### New RPC contract
```
public.auto_receive_due_purchase_orders(p_as_of date default current_date)
  returns integer            -- count of POs auto-received this run
  language plpgsql
  security definer
  set search_path = public, pg_temp
```
Body (inlined full-receive; do NOT call `receive_purchase_order`):
- Loop every PO where `status in ('sent','partial') AND received_at IS NULL AND expected_delivery IS NOT NULL AND expected_delivery <= p_as_of`, across all stores (DEFINER bypasses RLS — no `auth_can_see_store` gate; this is a system job).
- Per open line of that PO: `delta := greatest(0, coalesce(ordered_qty,0) - coalesce(received_qty,0))`. When `delta > 0`: `UPDATE po_items SET received_qty = ordered_qty` and `UPDATE inventory_items SET current_stock = coalesce(current_stock,0) + delta, updated_at = now() WHERE id = <line.item_id> AND store_id = <po.store_id>`. The `greatest(0, …)` guards an already-over-received line from decrementing stock.
- Header flip: `UPDATE purchase_orders SET status='received', received_at=now(), received_by=NULL, receive_client_uuid = md5(id::text || ':auto-receive')::uuid`. **`received_by = NULL`** is the system attribution (no `auth.uid()` in cron/DEFINER context).
- **Stock-only.** No cost/price path (auto-receive never re-prices — over-receipt self-corrects via EOD, per Out-of-scope). Do NOT port spec 109's `new_case_price` hunks.
- **One `audit_log` row per PO**, mirroring `receive_purchase_order`'s write but system-attributed: `insert into audit_log (store_id, user_id, action, detail, item_ref, value) values (v_store_id, NULL, 'PO auto-received', 'PO '||left(id::text,8)||' · received (auto)', <vendor.name>, <line_count>::text||' line(s)')`. `user_id = NULL` (AC line 57–58). Reuse the `join vendors` name-fetch shape from `receive_purchase_order` (`20260704000000_po_loop.sql:275`).
- Return the integer count (for cron log + the pgTAP assertions).

**Idempotency proof (AC lines 49–53):** the selection filter requires `received_at IS NULL`; a full receive always sets `received_at = now()` and `status='received'`, so a re-run the same day (or any later day) never re-selects the PO → stock added exactly once. The deterministic `receive_client_uuid` is belt-and-suspenders (and a stable audit marker); it is unique per PO (`md5(po_id)` differs per PO) so it composes cleanly with the existing partial-unique index `purchase_orders_receive_client_uuid_idx` — no cross-PO collision. It intentionally overwrites any prior manual `receive_client_uuid` on that row (harmless; the row is now terminally `received`).

**Partial top-up (AC 46–47):** a `partial` PO already has some lines with `received_qty > 0`; `delta` adds only the per-line remainder, and the header flips to `received`. Covered by the same loop with no special-casing.

### RLS impact
- **No new table, no policy changes.** The RPC is `SECURITY DEFINER` and runs as the function owner (postgres), bypassing RLS for the cross-store `UPDATE`s and the `audit_log INSERT` — same pattern as `record_missed_orders_for_day` (`20260530000000`). Session-mediated reads of the mutated rows still flow through the existing `auth_can_see_store()` policies on `purchase_orders` / `inventory_items` / `audit_log` (`20260504173035_per_store_rls_hardening.sql`) — unchanged surface.
- CLAUDE.md "permissive-policy ORed" lint: N/A (no new policy). "last-of-role"/"self-guard": N/A (not a role-change/deletion op).

### Grants (Q5)
```
revoke execute on function public.auto_receive_due_purchase_orders(date)
  from public, anon, authenticated;
grant  execute on function public.auto_receive_due_purchase_orders(date)
  to postgres, service_role;
```
Mirrors `record_missed_orders_for_day` exactly — cron (runs as `postgres`) and `service_role` (a future admin "run now" endpoint) only; zero session callers. Per the spec-097 explicit-grant note (`20260618000000_public_grants_explicit.sql`), the default `public` EXECUTE grant that a fresh CLI image would re-add is explicitly revoked here; `postgres`/`service_role` retain EXECUTE so cron still fires.

### Cron (Q3)
```
do $$
begin
  if exists (select 1 from cron.job where jobname = 'auto-receive-purchase-orders-daily') then
    perform cron.unschedule('auto-receive-purchase-orders-daily');
  end if;
  perform cron.schedule(
    'auto-receive-purchase-orders-daily',
    '0 8 * * *',
    $cron$ select public.auto_receive_due_purchase_orders(); $cron$
  );
end $$;
```
- **Hour = `0 8 * * *` UTC** — distinct from the existing DB crons (`eod-reminder-cron` `*/5`, `record-missed-orders-daily` `0 7`, `prune-username-resolve-rate-limit` `17 4`). Runs one hour after record-missed so the two daily jobs don't overlap their windows.
- **Timezone posture (Q3):** `expected_delivery` is a plain `date`; the cron passes the default `current_date` (UTC). The reorder engine computed `next_delivery_date` as `v_as_of_date + offset`, where `v_as_of_date` is the store-local "today" the FE passes (or UTC `current_date` fallback). So a persisted `expected_delivery` may differ from the store-local delivery day by up to ~1 calendar day at the UTC boundary. **This coarse daily granularity is accepted** (owner: EOD counts override on-hand, over/early-receipt self-corrects) — same brand-wide TZ approximation `record_missed_orders` documents. State, don't fix.

### `src/lib/db.ts` surface (Q4)
`createPurchaseOrderDraft` (`src/lib/db.ts:1545`) gains one optional param and one conditional insert key:
```ts
export async function createPurchaseOrderDraft(params: {
  storeId: string;
  vendorId: string;
  createdByUserId?: string;
  referenceDate?: string;      // YYYY-MM-DD → reference_date  (existing)
  expectedDelivery?: string;   // NEW: YYYY-MM-DD → expected_delivery
  lines: Array<{ itemId: string; orderedQty: number; costPerUnitCounted: number }>;
}): Promise<string | null>
```
Header insert (line 1566) gains: `...(params.expectedDelivery ? { expected_delivery: params.expectedDelivery } : {})`. snake_case mapping: `expectedDelivery` (camel) → `expected_delivery` (snake). Omit the key entirely when absent so the column stays NULL (AC 30–32). No new read mapper — the persisted value is not surfaced read-only in v1 (Out-of-scope; PoLine/PO read shapes unchanged).
- **Legacy `createPurchaseOrder` (`db.ts:1443`) is NOT touched** — the "Mark as Submitted" flow has no per-vendor `nextDeliveryDate` in hand and its POs stay `expected_delivery = NULL` (forward-only; they never auto-receive, acceptable).

### Frontend store impact (Q4 + Decision A)
`createPoDraft` (`src/store/useStore.ts:2662`) is the only store slice that changes. It already receives the `ReorderVendor` (`vendor`), which carries `vendor.nextDeliveryDate` (`db.ts:4027`, `String(next_delivery_date ?? '')`) and `vendor.scheduleKnown` (`db.ts:4026`). Add:
```ts
// Decision A: only persist a REAL scheduled delivery date. schedule-unknown
// vendors carry the reorder engine's synthetic as_of+7 fallback in
// nextDeliveryDate — persisting it would auto-receive on a guessed date
// (violates AC "no synthetic date"). Write NULL for those (never auto-receive).
const expectedDelivery =
  vendor.scheduleKnown && vendor.nextDeliveryDate ? vendor.nextDeliveryDate : undefined;
```
and pass `expectedDelivery` into the existing `db.createPurchaseOrderDraft({ … })` call (`useStore.ts:2699`). No optimistic-then-revert change: `createPoDraft` already wraps the write in `try/catch` with `notifyBackendError` and refreshes via `refreshPurchaseOrders()` + `loadReorderSuggestions()`. No new UI, no new state slice.

### Edge function changes
None. The DB job is pure SQL/cron; no `verify_jwt` or service-token surface is added or changed. `send-po-email` untouched (Q5 out).

### Realtime impact
- `auto_receive_due_purchase_orders` mutates `purchase_orders` (header) and `inventory_items` (`current_stock`) — **both already in the `supabase_realtime` publication** (`20260514140000_realtime_publication_tighten.sql:44,47`). `po_items` is not in the publication and does not need to be (its parent header UPDATE fires the event the reorder/PO reloads key on — same rationale spec 107 documented). Replays on the **`store-{id}`** channel; clients on `useRealtimeSync` reload within the 400 ms debounce, correcting on-hand and inbound.
- **No publication membership change** → the realtime-publication gotcha does **NOT** apply and **NO `docker restart supabase_realtime_imr-inventory`** step is required after `npm run dev:db`. (Deploy/dev note stated explicitly per the architect checklist; it's a no-op here.)

### Test surface
**pgTAP** (`supabase/tests/` — new file, e.g. `auto_receive_due_purchase_orders.test.sql`), all inside rollback-framed txns creating PO rows (the local seed has zero PO rows):
- Full receive: `sent` PO, `expected_delivery = current_date` → status `received`, `received_at` not null, `received_by` NULL, `current_stock += ordered_qty`.
- Partial top-up: `partial` PO with a line at `received_qty = k < ordered` → stock gains only `ordered − k`, flips `received`.
- Idempotency: run RPC twice → stock incremented exactly once; second run returns 0 and leaves the row untouched.
- Null-date skip: `expected_delivery IS NULL` → untouched (the 6 legacy April POs analog).
- Future-date skip: `expected_delivery = current_date + 1` → untouched.
- Status guards: `draft` / `cancelled` / `received` POs → untouched.
- All-stores iteration: two due POs in two different stores both receive in one call.
- Audit: exactly one `audit_log` row per PO with `user_id IS NULL` and `action = 'PO auto-received'`.
- ACL regression pin: `authenticated` and `anon` lack EXECUTE; `postgres`/`service_role` have it.

**jest** (FE thread-through):
- `createPurchaseOrderDraft` includes `expected_delivery` in the insert payload when `expectedDelivery` is provided, and omits the key when absent.
- `createPoDraft` derives `expectedDelivery = nextDeliveryDate` when `scheduleKnown` is true, and `undefined` when `scheduleKnown` is false OR `nextDeliveryDate` is `''` (Decision A).

### Risks and tradeoffs
- **Decision A (schedule-unknown → NULL) is a genuine deviation from a literal reading** of "persist the vendor's nextDeliveryDate." It is the correct reconciliation of two ACs that would otherwise contradict (the engine never emits a null `next_delivery_date`; it always falls back to `as_of + 7`). If the owner actually WANTS schedule-unknown vendors to auto-receive on the +7 guess, drop the `scheduleKnown` gate — surface to PM if uncertain. Recommended posture: gate on `scheduleKnown` (honors "no synthetic date").
- **UTC vs store-local date** (Q3): a PO may auto-receive up to ~1 day early/late at the UTC boundary. Accepted (owner: EOD self-corrects).
- **Over-receipt is intended** (Out-of-scope): auto-receive always tops up to `ordered_qty`; a physically short shipment over-states stock until the next EOD count. `greatest(0, …)` only guards the stock math from going negative, not from over-stating.
- **Migration ordering / prod apply:** additive, but must be `db push`ed / MCP-applied to prod AND its version inserted into `supabase_migrations.schema_migrations`, else the `db-migrations-applied` gate goes red (project MEMORY). A DDL-invisible cron+function change: POST-APPLY verify `select 1 from cron.job where jobname='auto-receive-purchase-orders-daily'` and `select 1 from pg_proc where proname='auto_receive_due_purchase_orders'`.
- **`SECURITY DEFINER` cross-store write** is the one place this bypasses per-store RLS. Mitigated by: zero session callers (grants revoked from anon/authenticated), the tight selection predicate, and the store-pinned `inventory_items` UPDATE (`AND store_id = <po.store_id>`) mirroring `receive_purchase_order`'s defense-in-depth pin.
- **Performance:** one daily seq/partial-index scan over a ~6-row table; per-PO line loop is bounded by PO size. Negligible against the 286 KB seed. No cold-start concern (no edge function).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend-developer:
  author migration `supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql`
  (new SECURITY DEFINER RPC `auto_receive_due_purchase_orders(date)` inlining the
  full-receive restock + system-attributed audit row, grants, and the
  `auto-receive-purchase-orders-daily` cron at `0 8 * * *`), add the
  `expectedDelivery?` param + conditional `expected_delivery` insert key to
  `createPurchaseOrderDraft` in `src/lib/db.ts`, and add the pgTAP suite.
  Frontend-developer: thread `expectedDelivery` (Decision A: `scheduleKnown &&
  nextDeliveryDate ? nextDeliveryDate : undefined`) through `createPoDraft` in
  `src/store/useStore.ts` into the `db.createPurchaseOrderDraft` call, and add the
  jest thread-through tests. No publication change — no docker restart needed.
  After implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/125-auto-receive-purchase-orders.md

## Files changed

Frontend (this pass — spec 125 store thread-through + jest):
- `src/store/useStore.ts` — `createPoDraft`: derive `expectedDelivery`
  (Decision A: `vendor.scheduleKnown && vendor.nextDeliveryDate ?
  vendor.nextDeliveryDate : undefined`) and pass it into
  `db.createPurchaseOrderDraft({ … })`. No other change (`referenceDate`
  threading untouched).
- `src/store/useStore.createPoDraft.spec125.test.ts` — new jest suite pinning
  the thread-through: `expectedDelivery = nextDeliveryDate` when
  `scheduleKnown: true`; `undefined` (key omitted, NOT the guessed date) when
  `scheduleKnown: false` OR `nextDeliveryDate` is `''`.

Note: `src/lib/db.ts` (`createPurchaseOrderDraft` `expectedDelivery?` param +
conditional `expected_delivery` insert key) is owned by the parallel backend
pass and was already present at verification time — not modified by this
frontend pass.
