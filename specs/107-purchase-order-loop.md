# Spec 107: Close the purchase-order loop

Status: READY_FOR_REVIEW

> Owner signed off on all six open questions (OQ-1 … OQ-6). Their answers are
> folded into scope below and recorded in "Open questions resolved". Two
> schema-truth items surfaced this session are carried forward as explicit
> architect obligations (see "For the architect: drift findings to
> reconcile" immediately below the user story) — the lifecycle design cannot
> be finalized without resolving both.

## For the architect: drift findings to reconcile (must resolve before design freeze)

These are the hard blockers the design must resolve. They are restated here
so they are not lost inside the Background section.

1. **Status-vocabulary drift — `'submitted'` vs the four-state comment
   vocabulary.** The live writer `db.createPurchaseOrder` persists
   `status: 'submitted'` (`src/lib/db.ts:1370-1385`), but the init-schema
   comment documents the domain as `'draft' | 'sent' | 'received' |
   'partial'` (`…init_schema.sql:160`) — `'submitted'` is not in that set.
   The architect MUST reconcile this: the likely resolution is to adopt the
   four-state vocabulary (`draft → sent → received | partial`) and make an
   explicit **data-migration decision** for what existing prod `'submitted'`
   rows map to (probable target: `'sent'`). Read the *actual* live status
   values from prod first (dashboard-drift note in project memory — prod is
   the source of truth, not the init comment), then decide normalize-via-
   migration vs carry-both. The OQ-3 "open PO" predicate for the
   `pending_po_qty` swap depends on the token set landed here.

2. **`reference_date` is undeclared prod schema.** `mapPurchaseOrderRow`
   reads a `reference_date` column (`src/lib/db.ts:1398-1401`) that appears
   in **no** migration file (grep of `supabase/migrations/` returns zero
   hits). Per the project's no-dashboard-drift policy, this spec **formalizes
   `reference_date` in a migration**: the architect confirms its live
   type/nullability/default against prod and lands a migration that declares
   it, so the repo and prod's `schema_migrations` reconcile and the
   `db-migrations-applied` gate has a source of truth.

Two more standing obligations (already inside the doc, restated so the
architect does not miss them):

- **Both reorder RPCs move together.** The `pending_po_qty` swap must land
  identically in the engine RPC (`…report_reorder_list_multi_vendor.sql`)
  AND its spec-105 verbatim-copy sibling
  (`…report_reorder_for_counted_onhand.sql`). The verbatim-copy discipline
  is documented in the sibling itself; a pgTAP probe pins byte-parity of the
  CTE. Never patch one without the other.
- **RLS on `purchase_orders` + `po_items` predates the hardening waves.**
  Receiving mutates both tables; audit their live `pg_policies` and bring
  them under the `auth_can_see_store(store_id)` house pattern as part of
  this spec.

## User story

As a **store manager (admin Cmd UI)**, I want the reorder → create-PO →
send → receive → stock-update cycle to be one connected loop, so that
inbound quantities I have already ordered stop showing up as "reorder this
again," delivered stock lands in inventory against the PO it belongs to,
and I can see each PO move through draft → sent → received/partial without
double-ordering or hand-editing stock.

## Background: the three gaps (grounded this session)

The tables and half the plumbing already exist; three gaps keep it from
being a loop. Verified in code (line refs are current-state anchors, not
prescriptions):

1. **Inbound feedback is a stub.** Both reorder engine RPCs compute a
   `pending_po_qty` CTE that is hardcoded to `0::numeric`, keyed per-item
   with `select distinct`, left-joined ON `item_id`, and the value feeds
   BOTH `par_replacement` and `usage_forecasted`
   (`supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql:299-303,444,453,460,465`
   and `supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql:240-244,343,353,360,365`).
   Because it is always 0, reorder cannot subtract what is already inbound.

2. **Receiving is entirely synthetic.** `ReceivingSection.tsx` fabricates a
   line-items table from vendor catalog with alternating ok/short/pending
   states and commits via `adjustStock` + `addAuditEvent` — there is NO
   `po_items` row backing any line
   (`src/screens/cmd/sections/ReceivingSection.tsx:27-34,81-110,112-135`).
   It cannot "receive against a PO" because no PO carries line items.

3. **PO creation is header-only, and the status vocabulary has drifted.**
   `db.createPurchaseOrder` writes `purchase_orders` with **`status:
   'submitted'`** and a **`reference_date`** column
   (`src/lib/db.ts:1370-1385`), invoked by `useStore.submitOrder`
   (`src/store/useStore.ts:2221-2247`). No `po_items` lines are ever
   written. Two schema-truth problems the architect MUST reconcile before
   designing the lifecycle (restated at the top of this doc under "For the
   architect: drift findings to reconcile"):
   - The init schema comments the status domain as
     `'draft' | 'sent' | 'received' | 'partial'`
     (`supabase/migrations/20260405000759_init_schema.sql:160`), but the
     live writer uses `'submitted'`, which is not in that set. The
     dashboard-drift note in project memory applies — prod is the source of
     truth, so the real current status vocabulary must be read from prod,
     not from the init comment.
   - `reference_date` is used by `mapPurchaseOrderRow` (`src/lib/db.ts:1398-1401`)
     but appears in NO migration file (grep of `supabase/migrations/`
     returns zero hits). It is undeclared prod schema. The architect must
     confirm its live type and formalize it in a migration.

## Acceptance criteria

Backend / data:

- [ ] A new idempotent RPC `receive_purchase_order(p_po_id uuid, p_lines
      jsonb, p_client_uuid uuid)` exists. Given lines mapping `po_item_id →
      received_qty`, it: (a) writes each `po_items.received_qty`,
      (b) increments the matching `inventory_items.current_stock` by the
      received quantity in counted units, (c) sets `purchase_orders.status`
      to `received` when every line is fully received or `partial` when at
      least one line is short, (d) stamps `received_at` / `received_by`,
      and (e) writes one audit row. Returns the updated PO id + resulting
      status + per-line received totals.
- [ ] Receiving is **stock-only** (OQ-2): the RPC increments
      `current_stock` and records `po_items.received_qty` and does NOT
      mutate any cost column (`item_vendors.case_price`,
      `inventory_items.cost_per_unit`, or the spec-104 per-each recompute
      chain). Cost-on-receipt is deferred to Future work.
- [ ] On a **short** receive the remainder **stays inbound** (OQ-3): the
      PO transitions to `partial` with `received_at` left NULL, so its
      unreceived quantity keeps counting in `pending_po_qty`. A separate
      **"close short"** action (its own RPC/transition) releases the
      remainder — it stamps the PO closed and drops the shortfall out of
      `pending_po_qty`. The architect pins the exact transition token/flag.
- [ ] `receive_purchase_order` is idempotent on `p_client_uuid`: a second
      call with the same `client_uuid` returns the first call's result
      and does NOT double-increment `current_stock` (house idempotency
      pattern, per `staff_submit_eod` / spec 106 drafts).
- [ ] `receive_purchase_order` is `SECURITY INVOKER`, sets
      `search_path = public`, and refuses when
      `auth_can_see_store(<po's store_id>)` is false — same guard shape as
      the reorder engine RPCs (`…report_reorder_for_counted_onhand.sql:91`).
- [ ] Both reorder engine RPCs' `pending_po_qty` CTE is swapped from the
      hardcoded `0::numeric` to a real per-item aggregate =
      `sum(po_items.ordered_qty − coalesce(po_items.received_qty, 0))` over
      that store's OPEN purchase orders, grouped per `item_id`, joined ON
      `item_id`. "Open" per OQ-3 (stays-inbound) is canonically
      `status IN ('sent','partial') AND received_at IS NULL` — the architect
      pins the exact set against the reconciled status vocabulary. The CTE
      stays per-item + `select distinct`-safe so a shared multi-vendor item
      does not fan out (the `…_multi_vendor.sql:290-298` rationale still
      holds).
- [ ] The two engine RPCs remain byte-identical in their `pending_po_qty`
      CTE and its downstream use (the documented verbatim-copy discipline:
      `…report_reorder_for_counted_onhand.sql:236-244` says "verbatim from
      …_multi_vendor.sql"). A pgTAP probe asserts an item with an open PO
      returns a non-zero `pending_po_qty` and a correspondingly reduced
      `suggested_qty` from BOTH RPCs.
- [ ] One-click PO from a reorder vendor card creates an **editable DRAFT**
      (OQ-4): it writes a `purchase_orders` header with `status = 'draft'`
      AND one `po_items` row per suggested line (`ordered_qty` prefilled
      from the suggested cases, `item_id`, `cost_per_unit` per the OQ-6
      basis). Lines are editable before send. This is the first code path in
      the repo that writes `po_items`.
- [ ] `po_items.cost_per_unit` snapshots the **per-counted-unit** cost
      (OQ-6): the stored per-each `inventory_items.cost_per_unit` bridged
      `× sub_unit_size` at write time, fitting the existing `numeric(10,2)`
      with no widening (waste_log R1 precedent). The migration adds a
      **column comment** documenting the basis ("per-counted-unit snapshot
      at PO-create time; not per-each — see spec 107 OQ-6").
- [ ] A PO's status transitions are enforceable and observable: create →
      draft → sent → received | partial, plus a cancel path that releases
      the PO's pending quantity out of `pending_po_qty`, and the OQ-3 "close
      short" path off `partial`. The status token set is reconciled against
      the live `'submitted'` value (see drift finding 1) — the architect
      decides normalize-via-migration vs carry-both and makes the explicit
      data-migration decision for existing `'submitted'` rows.

Frontend (admin Cmd UI):

- [ ] `POsSection` shows each PO's lifecycle state and offers the state
      transitions the resolved OQs allow: **send to vendor** (behind the
      OQ-1 confirm dialog), **mark as sent manually** (fallback), **cancel/
      release**, and **close short** off a `partial` PO.
- [ ] "Send to vendor" (OQ-1) is ALWAYS behind an explicit confirm dialog
      and, on confirm, emails the PO as an HTML table (via Resend, inline
      `escapeHtml` per the CLAUDE.md HTML-escape convention) to
      `vendors.email` and flips status to `sent`. It is NEVER auto-sent.
      When `vendors.email` is empty (phone/text vendors), the send action
      is unavailable and only **"mark as sent manually"** (flips status to
      `sent` with no email) is offered.
- [ ] `ReceivingSection` gains a **PO-driven mode** (OQ-5: admin-only in
      v1): selecting a real PO lists its actual `po_items` (ordered qty
      prefilled), the operator enters received qty per line, and committing
      calls `receive_purchase_order`. The existing freeform receiving path
      is retained as a fallback (not deleted) so receiving stock not tied to
      a PO still works.
- [ ] Received quantities and PO status changes reflect in reorder within
      one realtime debounce: a received, closed-short, or cancelled PO
      changes what reorder suggests for the affected store without a manual
      refresh.

## In scope

- New RPC `receive_purchase_order` (idempotent, store-scoped, audited,
  **stock-only** — no cost mutation).
- The OQ-3 **"close short"** transition (releases a `partial` PO's remainder
  out of `pending_po_qty`).
- Swap `pending_po_qty` from 0 to a real open-PO aggregate in BOTH engine
  RPCs, keeping them verbatim-identical.
- First `po_items` write path: one-click PO from a reorder vendor card seeds
  header (`status = 'draft'`) + **editable** line items (OQ-4).
- PO lifecycle surfacing + transitions in `POsSection` (send, mark-sent-
  manually, cancel/release, close-short, and the received/partial states
  driven by receiving).
- **Email-send channel (OQ-1, IN v1):** a new Resend-backed edge function
  that renders the PO as an escaped HTML table and emails it to
  `vendors.email`, flipping status to `sent` — always behind an explicit
  confirm dialog, never auto-sent — plus the **mark-as-sent-manually**
  fallback for phone/text vendors and empty-email vendors. Edge function
  follows house conventions (`verify_jwt` default; `requireAdminCaller` /
  `ADMIN_ROLES` if the architect gates it on role; inline `escapeHtml`;
  client calls via `callEdgeFunction`).
- PO-driven receiving mode in `ReceivingSection` (**admin-only** v1, OQ-5;
  freeform retained as fallback).
- Reconciling the live `'submitted'` status against a formalized four-state
  lifecycle (architect decision + explicit data-migration for existing
  `'submitted'` rows).
- **Formalizing the undeclared `reference_date` column** in a migration
  (confirm live type against prod; land the declaration so repo/prod
  reconcile).
- Auditing + (as needed) repairing RLS on `purchase_orders` + `po_items`
  under the `auth_can_see_store(store_id)` house pattern.
- pgTAP coverage for the pending_po_qty swap and for
  `receive_purchase_order` (idempotency + status flip + stock increment +
  store guard). jest coverage for the admin-side PO create / receive
  mapping in `db.ts`. (Test tracks named per spec 022 — see Project notes.)

## Out of scope (explicitly)

- **Auto-sending orders.** The app NEVER auto-sends a PO to a vendor. Every
  outbound action ("send to vendor") is behind an explicit human confirm.
  The ordering CHANNEL stays human-in-the-loop by design (owner direction).
- **Cost-on-receipt updates (OQ-2 deferred).** v1 receiving is stock-only.
  Refreshing `item_vendors.case_price` on delivery and re-running the spec
  104 per-each recompute is an explicitly flagged fast-follow (see Future
  work) so 107 does not re-open the costing surface.
- **Staff-app receiving (OQ-5 deferred).** Receiving is admin Cmd only in
  v1. A staff receiving screen (new staff screens + RLS) is later work.
- **Auto-closing short receives (OQ-3 rejected).** The remainder stays
  inbound and only leaves `pending_po_qty` via the explicit "close short"
  (or cancel) action — it is never released automatically on a short
  receive.
- **Order-exactly-suggested PO creation (OQ-4 rejected).** The one-click PO
  is an editable draft; there is no no-edit "order exactly what was
  suggested" path in v1.
- **Widening `po_items.cost_per_unit` (OQ-6 rejected).** The snapshot is
  per-counted-unit and fits the existing `numeric(10,2)`; no widen to
  `numeric(12,6)`, so 107 avoids the spec-104 truncation surface.
- **Vendor-portal / CSV-upload ordering channel.** `vendor_sku` is a UI
  stub ("schema pending") and only matters for a portal-CSV channel; that
  channel is not in 107. Noted for a future spec.
- **Reworking the reorder suggestion math** beyond subtracting the real
  `pending_po_qty`. The hybrid `greatest(par_replacement,
  usage_forecasted)` formula is unchanged; only the inbound term becomes
  real.
- **Migrating the freeform-receiving code path into `db.ts`** or deleting
  it. It stays as the non-PO fallback.

## Open questions resolved

- **OQ-1 — Email-the-PO channel in v1? → EMAIL-SEND IN v1 (with manual
  fallback).** "Send to vendor" emails the PO as an HTML table (via Resend,
  inline `escapeHtml` per CLAUDE.md, to `vendors.email`) and flips status to
  `sent` — ALWAYS behind an explicit confirm dialog, NEVER auto-sent. A
  **mark-as-sent-manually** fallback covers phone/text vendors and the
  empty-`vendors.email` case. A new edge function follows house conventions
  (`verify_jwt` default; `requireAdminCaller` / `ADMIN_ROLES` if role-gated
  — the architect decides the gate; inline `escapeHtml`).

- **OQ-2 — Does receiving update cost? → STOCK-ONLY in v1.** Receiving
  increments `current_stock` + records `received_qty`; NO cost mutation.
  Cost-on-receipt (`item_vendors.case_price` refresh → spec-104 per-each
  recompute) is an explicitly flagged fast-follow (Future work).

- **OQ-3 — Partial semantics. → REMAINDER STAYS INBOUND + "close short".**
  A short receive leaves the remainder counting in `pending_po_qty`
  (PO → `partial`, `received_at` NULL). An explicit "close short" action
  releases the remainder. Fixes the "open PO" predicate for the
  pending_po_qty swap to `status IN ('sent','partial') AND received_at IS
  NULL` (architect pins the final token set against the reconciled
  vocabulary).

- **OQ-4 — PO creation UX + who receives. → EDITABLE DRAFT.** One-click PO
  from a reorder vendor card creates an editable DRAFT (lines prefilled from
  suggested cases, editable before send).

- **OQ-5 — Who can receive. → ADMIN-ONLY v1.** The existing
  `ReceivingSection` gains the PO-driven mode; staff receiving is future
  work.

- **OQ-6 — `po_items.cost_per_unit` basis. → PER-COUNTED-UNIT snapshot.**
  Fits the existing `numeric(10,2)` (waste_log R1 precedent); no widening,
  no spec-104 truncation risk. The basis is documented in a column comment.

## Future work (flagged fast-follows, not in 107)

- **Cost-on-receipt (from OQ-2):** on delivery at a new case price, refresh
  `item_vendors.case_price` and re-run the spec 104 per-each recompute so
  landed cost tracks reality. Deferred to keep 107 off the costing surface.
- **Staff-app receiving (from OQ-5):** a staff receiving screen with its own
  RLS, so end-of-shift staff can receive deliveries without admin access.
- **Vendor-portal / CSV-upload ordering channel:** a non-email ordering path
  keyed on `vendor_sku` (currently a "schema pending" UI stub).

## Dependencies

- **Existing tables `purchase_orders` + `po_items`**
  (`…init_schema.sql:151-173`) — predate the per-store RLS hardening waves.
  The architect MUST verify what RLS these two tables actually carry today
  (check `pg_policies`), because per-store scoping via
  `auth_can_see_store(store_id)` is the house pattern and receiving mutates
  these tables. This is a live gap flagged for design, not a claim they are
  unprotected.
- **Both reorder engine RPCs** — `report_reorder_list` /
  `report_reorder_list_multi_vendor`
  (`…20260630000100_report_reorder_list_multi_vendor.sql`) and
  `report_reorder_for_counted_onhand`
  (`…20260702000000_report_reorder_for_counted_onhand.sql`). The
  pending_po_qty swap touches BOTH, verbatim-identically.
- **Existing PO plumbing to extend, not replace:** `db.createPurchaseOrder`,
  `mapPurchaseOrderRow`, `fetchRecentPurchaseOrders` (`src/lib/db.ts:1340-1437`),
  `useStore.submitOrder` (`src/store/useStore.ts:2221`).
- **Undeclared `reference_date` column** on `purchase_orders` (used at
  `src/lib/db.ts:1401`, absent from all migrations) — architect confirms
  live type and formalizes it in a migration (now IN scope per owner
  direction on the no-dashboard-drift policy).
- **A new migration** (expected) for `receive_purchase_order`, the "close
  short" transition, the pending_po_qty swap, the status-vocabulary
  normalization + data-migration of existing `'submitted'` rows, the
  `reference_date` formalization, and any RLS repair.
- **Email-send (OQ-1 = IN):** a new Resend-backed edge function following
  the `send-invite-email` shape (inline `escapeHtml`, `callEdgeFunction` on
  the client side, structured error envelope, `verify_jwt` default) and
  `vendors.email` (`…init_schema.sql:43`).
- **Idempotency:** the `client_uuid` house pattern
  (`staff_submit_eod`, spec 106 count drafts).

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI only. Sections touched:
  `POsSection`, `ReceivingSection`, `ReorderSection` under
  `src/screens/cmd/sections/`. No legacy admin surface (spec 025 deleted
  it). Staff receiving is out of v1 (OQ-5).
- **Which app:** this repo (admin). Customer PWA unaffected. Staff app not
  in play in v1 (OQ-5 = admin-only receiving).
- **Per-store or admin-global:** per-store. `receive_purchase_order`, the
  "close short" transition, and the pending_po_qty aggregate are
  store-scoped via `auth_can_see_store(store_id)`. Architect must
  confirm/repair `purchase_orders` + `po_items` RLS coverage (they predate
  the hardening waves).
- **Realtime channels touched:** `store-{id}`. Received / closed-short /
  cancelled POs must reach reorder within the 400 ms debounce
  (`src/hooks/useRealtimeSync.ts`). **Realtime publication gotcha:** if the
  PO/po_items tables are not already in the realtime publication, adding
  them mid-session needs `docker restart supabase_realtime_imr-inventory`
  to re-snapshot the slot (project memory) — call out as a risk in design.
- **Migrations needed:** yes — `receive_purchase_order`, the "close short"
  transition, pending_po_qty swap (both engine RPCs, verbatim-identical),
  status-vocabulary reconciliation + data-migration of existing
  `'submitted'` rows, `reference_date` formalization, and any RLS repair.
  Apply to prod via Supabase MCP (db push lacks the prod password — project
  memory), then insert the exact version into `schema_migrations` so the
  `db-migrations-applied` gate stays green.
- **Edge functions touched:** a new Resend-backed email-send function
  (OQ-1 = IN): follows `send-invite-email` (inline `escapeHtml`,
  `verify_jwt` default, structured error envelope; `requireAdminCaller` /
  `ADMIN_ROLES` if the architect role-gates it). NOT `staff-*` /
  `pwa-catalog` (those keep `verify_jwt = false`).
- **Web/native scope:** web + native for the admin Cmd surface (no web-only
  APIs involved). The send action is a normal edge-function call (not
  web-push), so it is cross-platform.
- **Tests (spec 022 tracks):** pgTAP for the pending_po_qty swap (non-zero
  inbound reduces suggested_qty from BOTH RPCs) and for
  `receive_purchase_order` (idempotency on client_uuid, status flip,
  stock increment, `auth_can_see_store` refusal). Add pgTAP for the "close
  short" transition (remainder leaves `pending_po_qty`). jest for the
  `db.ts` PO create/receive mappers and the new edge-function client call.
  Shell smoke optional for the receive RPC round-trip.
- **app.json slug:** untouched. This feature does not touch build
  identifiers, store listings, or push certs. `slug` stays `towson-inventory`
  (load-bearing, do-not-auto-fix per CLAUDE.md).
- **Spec 104 cost basis is live:** stored `cost_per_unit` is per-each;
  consumers bridge `× sub_unit_size` (already present at
  `…ReceivingSection.tsx:100-102`). Per OQ-6 the PO-line snapshot is
  per-counted-unit (the bridged value), so it does NOT inherit the spec-104
  truncation hazard.

---

## Backend design

Authored by backend-architect. Two of the spec's stated drift findings turned
out to be **stale against the actual repo state** — I verified both and the
corrections change the migration scope materially. Read §0 first.

### §0 — Drift-finding reconciliation (both findings partially WRONG; read before building)

**Drift finding 2 (`reference_date` "undeclared") — INCORRECT. The column is
already declared in a migration.** `reference_date` is added by
`supabase/migrations/20260502071736_remote_schema.sql:149`:

```sql
alter table "public"."purchase_orders" add column "reference_date" date;
```

as a **nullable `date`, no default**, and that same migration adds a covering
index `idx_purchase_orders_store_reference_date ON (store_id, reference_date)`
(line 177). The spec's grep for `reference_date` returned zero because it likely
searched only the human-named migrations and missed the machine-generated
`remote_schema.sql` (the `supabase db pull` snapshot). **There is nothing to
formalize** — the repo and prod already reconcile on this column (it came FROM
prod via the pull). The migration in this spec does **not** add the column.
Optional-nice-to-have: a `comment on column` documenting it, but that is not
required and I am not mandating it. `mapPurchaseOrderRow` (`src/lib/db.ts:1398`)
reading `reference_date` is correct and unchanged.

*One residual obligation:* the `db-migrations-applied` gate compares repo
migrations to prod `schema_migrations`. Since `remote_schema.sql` is already in
both, no gate action is needed for `reference_date`. Confirm at prod-apply time
that `information_schema.columns` shows `reference_date` as `date` on prod (it
will — it was pulled from prod).

**The "RLS predates the hardening waves" premise — STALE. Both tables are
already under `auth_can_see_store()`.** `supabase/migrations/20260504173035_per_store_rls_hardening.sql:183-251`
already:
- dropped the legacy wide `auth_manage_purchase_orders` / `auth_manage_po_items`
  policies (and `remote_schema.sql:31` had already dropped the older
  `"Store access"` policy),
- created scoped `store_member_{read,insert,update,delete}_purchase_orders` via
  `auth_can_see_store(store_id)`, and
- created scoped `store_member_*_po_items` that scope THROUGH the parent
  (`exists (select 1 from purchase_orders po where po.id = po_items.po_id and
  auth_can_see_store(po.store_id))`).

This is exactly the house pattern the spec asks for, and it exactly matches the
`item_vendors`/`eod_entries` child-scoping precedent. **No RLS repair migration
is needed.** The pgTAP RLS suite this spec adds is a *pin* on the existing
policies (regression guard), not new policy authorship. Neither policy is
trivially-wide, so the permissive-policy lint (`supabase/tests/permissive_policy_lint.test.sql`)
is unaffected and needs no allowlist entry.

**Net effect on migration scope:** the spec's list of "RLS repair" and
"`reference_date` formalization" both drop out. What remains real: the status
CHECK + data-migration, the `client_uuid` idempotency column, the
`receive_purchase_order` + close-short + cancel RPCs, and the `pending_po_qty`
swap in both engines. This is a leaner migration than the spec implied — good.

### §1 — Status vocabulary reconciliation (drift finding 1)

**Current truth:**
- `purchase_orders.status` is `text default 'draft'` (`init_schema.sql:160`),
  with an init COMMENT documenting `'draft' | 'sent' | 'received' | 'partial'`.
- **No CHECK constraint exists** anywhere (grepped all 101 migrations +
  `remote_schema.sql`).
- The live writer `db.createPurchaseOrder` (`src/lib/db.ts:1377`) inserts
  `status: 'submitted'` — a token NOT in the documented set.
- The reorder RPCs' `latest_eod_per_vendor` CTE filters `status = 'submitted'`
  — but that is **`eod_submissions.status`, a DIFFERENT table**. Do NOT conflate.
  `purchase_orders` status is only read by the synthetic FE (age-derived) today;
  no server predicate reads it yet.

**PROD IS THE SOURCE OF TRUTH — flag for the prod-apply step.** I cannot query
prod locally. The developer/owner MUST run this against prod BEFORE finalizing
the data-migration and paste the result into the migration header:

```sql
-- PROD PRE-APPLY PROBE (run via MCP execute_sql, ebwnovzzkwhsdxkpyjka):
select status, count(*) from public.purchase_orders group by status order by 2 desc;
```

Local seed carries **zero** `purchase_orders` rows (grep of `seed.sql` for
`purchase_orders` returns nothing), so local tells us nothing about live status
values. The design below assumes the probe returns some mix of `'submitted'`
and possibly `'received'`/`'partial'`/`NULL`. **If the probe surfaces a token
not handled by the normalization map below, STOP and escalate to the PM** — do
not silently widen the CHECK.

**Decision — NORMALIZE via migration, then add a CHECK. Target vocabulary:**

```
draft | sent | partial | received | cancelled
```

Rationale for this 5-token set (not the init comment's 4):
- `cancelled` is required by AC (the cancel/release path) and by the
  `pending_po_qty` "open" predicate — a cancelled PO must drop out of pending.
- `submitted` is retired: it maps to `sent` (a submitted-to-vendor order that
  predates this spec is semantically "sent"). This is the spec's "probable
  target" and I confirm it.
- The OQ-3 "close short" transition does NOT get its own token (see §3
  rationale) — it lands a `partial` PO into `received` with a
  `received_at` stamp; the "was it short?" fact is recoverable from
  `sum(received_qty) < sum(ordered_qty)` on the lines, so no `closed_short`
  status token is needed. This keeps the CHECK set minimal and keeps the
  `POsSection` filter buckets simple.

**Data-migration (explicit, idempotent):**

```sql
-- Step A: normalize legacy tokens BEFORE the CHECK is added (or ADD VALID fails).
update public.purchase_orders set status = 'sent'  where status = 'submitted';
update public.purchase_orders set status = 'draft' where status is null or status = '';
-- Step B: any other unexpected token → ESCALATE (do not blanket-map). The
--   prod probe in §1 decides this; if the probe is clean (only submitted/
--   draft/sent/partial/received) Step A suffices.
-- Step C: add the constraint NOT VALID first, then VALIDATE, so the ACCESS
--   EXCLUSIVE lock window is minimized on the (small) table:
alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check (status in ('draft','sent','partial','received','cancelled')) not valid;
alter table public.purchase_orders validate constraint purchase_orders_status_check;
```

**`db.createPurchaseOrder` MUST change in the SAME spec** (`src/lib/db.ts:1377`):
the `status: 'submitted'` literal becomes `status: 'sent'` (the current
"Mark as Submitted" semantics = the order went to the vendor). This keeps the
"already ordered today" path working: `submitOrder`
(`useStore.ts:2221`) → `createPurchaseOrder` still writes one header row; the
`unconfirmed_po` dashboard predicate (`cmdSelectors.ts`) and
`fetchRecentPurchaseOrders` read `reference_date`/`created_at`, not the status
token, so the token change is transparent to them. **Verification note:** the
"Mark as Submitted" path is the load-bearing consumer — `submitOrder` itself is
currently only *defined* in the store (grep shows no live call site outside
`useStore.ts`), so the header-write via `createPurchaseOrder` is what matters.

No CHECK is added to `po_items` (it has no status column).

### §2 — Data model changes

**Migration file:** `supabase/migrations/20260704000000_po_loop.sql`
(next free — on-disk latest is `20260702000000_report_reorder_for_counted_onhand.sql`).
Confirmed only ONE migration; splitting is unnecessary and would risk a
half-applied state between the status CHECK and the RPCs that assume it (same
atomicity rationale spec 104 used to co-locate its basis flip + RPC re-CREATEs).
Wrap in `begin; … commit;`.

Statement order inside the one migration (order is load-bearing):
1. Status normalization UPDATEs (§1 Step A).
2. Status CHECK add-NOT-VALID + VALIDATE (§1 Step C).
3. `client_uuid` idempotency column + partial unique index (below).
4. `po_number` sequence/default — see below (additive, defensive).
5. `receive_purchase_order` RPC (`create or replace`) + GRANT/REVOKE.
6. `close_short_purchase_order` RPC + GRANT/REVOKE.
7. `cancel_purchase_order` RPC + GRANT/REVOKE.
8. `report_reorder_list` re-CREATE (pending_po_qty swap — copies the CURRENT
   spec-104 body verbatim with the ONE CTE hunk).
9. `report_reorder_for_counted_onhand` re-CREATE (same swap, byte-identical CTE).
10. `comment on` the two RPCs + the `po_items.cost_per_unit` column (OQ-6 basis).

**New column — idempotency, on `purchase_orders`** (receipts are recorded on the
PO, see §3 idempotency-shape decision):

```sql
alter table public.purchase_orders
  add column if not exists receive_client_uuid uuid;
create unique index if not exists purchase_orders_receive_client_uuid_idx
  on public.purchase_orders (receive_client_uuid)
  where receive_client_uuid is not null;
```

This mirrors the `staff_api_idempotency` precedent
(`20260504000000_staff_api_idempotency.sql`): a nullable column + a **partial**
unique index (`where … is not null`) so legacy/non-receive rows (NULL) coexist.
Named `receive_client_uuid` (not bare `client_uuid`) to leave room for a future
`create_client_uuid` if the create-draft path ever needs its own idempotency
(it does not in v1 — see §5).

**`po_number` — defensive additive fix.** `purchase_orders.po_number` is
`text unique` (`init_schema.sql:155`) with NO default. The existing
`createPurchaseOrder` never sets it, so every current row has `po_number = NULL`
(a UNIQUE column permits many NULLs in Postgres, so this has been silently
fine). The create-draft path (§5) and receiving do NOT need `po_number` either.
**Decision: leave `po_number` untouched in v1.** Surfacing a human-readable PO
number is a UI-nicety follow-up, not in 107's ACs. Flagged so the developer does
NOT invent a sequence and accidentally collide with prod rows.

**Indexes for the pending_po_qty aggregate.** The new per-item aggregate joins
`po_items → purchase_orders` filtered on `store_id` + `status`. Add:

```sql
create index if not exists idx_po_items_po_id on public.po_items (po_id);
create index if not exists idx_purchase_orders_store_status_open
  on public.purchase_orders (store_id, status) where received_at is null;
```

`idx_po_items_po_id` also backs the FK-scoped RLS `exists` subquery and
`receive_purchase_order`'s per-line updates. On the 286 KB seed these are tiny,
but the aggregate runs inside BOTH reorder RPCs on every Reorder-section open, so
the index is cheap insurance against a seq-scan-per-item.

Destructive vs additive: everything is **additive** except the status
normalization UPDATEs (which rewrite legacy `submitted` → `sent`; reversible from
the values, but there is no down-migration convention — document a BACKOUT block
in the migration footer per the spec-104 precedent). Rollout safety: the CHECK
add is `NOT VALID` then `VALIDATE` to bound the lock; run the prod apply off-peak
per the usual convention.

### §3 — `receive_purchase_order` RPC

```sql
create or replace function public.receive_purchase_order(
  p_po_id       uuid,
  p_lines       jsonb,   -- [{ "po_item_id": uuid, "received_qty": numeric }, ...]
  p_client_uuid uuid
) returns jsonb
language plpgsql
security invoker            -- house pattern for the reorder engine RPCs
set search_path = public
as $$ … $$;
```

**Posture: `SECURITY INVOKER` + `set search_path = public`** (matches the
reorder engine RPCs, NOT the staff RPCs which are `SECURITY DEFINER`). Because
it is INVOKER, the caller's RLS applies to the UPDATEs automatically — but per
AC we ALSO gate explicitly as the first statement (defense-in-depth + a clean
error string instead of a silent zero-row update):

```sql
-- (1) AUTH GATE — first statement. Resolve the PO's store, refuse if unseen.
select store_id, status, received_at into v_store_id, v_status, v_received_at
  from public.purchase_orders where id = p_po_id;
if v_store_id is null then
  raise exception 'purchase order % not found', p_po_id using errcode = 'P0002';
end if;
if not public.auth_can_see_store(v_store_id) then
  raise exception 'Not authorized for store %', v_store_id using errcode = '42501';
end if;
```

Same guard shape as `report_reorder_for_counted_onhand.sql:91`.

**GRANT/REVOKE** (mirror the report RPCs, which are `authenticated`-only):
```sql
revoke all on function public.receive_purchase_order(uuid, jsonb, uuid) from public, anon;
grant execute on function public.receive_purchase_order(uuid, jsonb, uuid) to authenticated;
```
Receiving is admin Cmd (OQ-5) but the DB gate is `auth_can_see_store` (which
returns true for admins AND store members) — matching every other store-scoped
RPC. Admin-only-ness is enforced at the FE (the section only mounts in the admin
shell), consistent with how the whole Cmd UI is gated. We do NOT add an
`auth_is_admin()` gate here — that would diverge from the reorder RPCs and would
wrongly reject a store member if OQ-5 is ever relaxed.

**Idempotency (decided shape — column on `purchase_orders`, NOT a receipts
table):**

```sql
-- (2) IDEMPOTENCY — return the prior result if this client_uuid already landed.
if p_client_uuid is not null then
  select receive_client_uuid into v_existing from public.purchase_orders
    where id = p_po_id and receive_client_uuid = p_client_uuid;
  if found then
    -- rebuild + return the SAME envelope (status + per-line totals) without
    -- re-incrementing stock. Read current received_qty off po_items.
    return jsonb_build_object('po_id', p_po_id, 'status', v_status,
             'conflict', true, 'lines', <current po_items received totals>);
  end if;
end if;
```

**Why column-on-PO, not a `po_receipts` audit table — weighed honestly:**

| Option | Pros | Cons |
|---|---|---|
| **A: `receive_client_uuid` column on `purchase_orders`** (chosen) | Matches the `staff_api_idempotency` house pattern exactly (nullable col + partial unique idx). Zero new tables, zero new RLS. Simplest idempotency check. | One receive per PO is the idempotent unit. A *second, legitimately different* partial receive against the same PO uses a NEW client_uuid and overwrites the column — which is correct (each receive event supersedes; the durable per-line truth lives in `po_items.received_qty`, and each receive is audited). |
| B: `po_receipts` audit table (one row per receive event) | Full receive history; supports multiple distinct partial receives as first-class rows. | New table + new RLS policies (child-scoped through PO) + new realtime consideration + more surface. The spec's ACs never ask to *list* receive events; they ask for idempotency + correct stock + correct status. |

Option A satisfies every AC. The audit trail requirement is met by the
`audit_log` row (below) — one per receive call — which IS the project's durable
receive history (same as how EOD/waste get their history from `audit_log`, not a
bespoke table). If a future spec needs a per-receive ledger, B is the additive
follow-up. **Chosen: A.** (This is the spec's own "weigh a `po_receipts` audit
row" fork, resolved toward the lighter option.)

**Body (stock-only, per OQ-2 — NO cost mutation):**

```sql
-- (3) Apply each line: write received_qty (ADDITIVE across partials — see note),
--     increment inventory_items.current_stock by the delta in COUNTED units.
for v_line in select * from jsonb_to_recordset(p_lines)
                 as x(po_item_id uuid, received_qty numeric)
loop
  -- guard: the po_item must belong to THIS po (defense against cross-PO ids)
  update public.po_items pit
     set received_qty = coalesce(pit.received_qty, 0) + v_line.received_qty
   where pit.id = v_line.po_item_id
     and pit.po_id = p_po_id
   returning pit.item_id into v_item_id;
  if v_item_id is not null and v_line.received_qty <> 0 then
    update public.inventory_items ii
       set current_stock = coalesce(ii.current_stock, 0) + v_line.received_qty,
           updated_at = now()
     where ii.id = v_item_id
       and ii.store_id = v_store_id;   -- store pin (defense-in-depth)
  end if;
end loop;
```

**DELTA semantics (important design call):** `received_qty` accumulates
(`+= received_qty`), and `current_stock += received_qty`. This is the only shape
that is correct for the OQ-3 "remainder stays inbound → later a second receive
lands the rest" flow: the second receive adds the newly-arrived quantity, not a
re-statement of the total. The FE PO-driven receive form therefore submits
"how much arrived in THIS receive," pre-filling the input with the OUTSTANDING
remainder (`ordered_qty − received_qty`), not the ordered total. Document this in
the RPC comment and the FE.

**Status flip:**
```sql
-- (4) Recompute status from the lines. Fully received ⇔ every line's
--     received_qty >= ordered_qty. Else 'partial'. received_at is stamped ONLY
--     when fully received (OQ-3: a partial receive leaves received_at NULL so the
--     remainder keeps counting in pending_po_qty).
select bool_and(coalesce(received_qty,0) >= coalesce(ordered_qty,0))
  into v_fully_received
  from public.po_items where po_id = p_po_id;

update public.purchase_orders
   set status = case when v_fully_received then 'received' else 'partial' end,
       received_at = case when v_fully_received then now() else null end,
       received_by = auth.uid(),
       receive_client_uuid = coalesce(receive_client_uuid, p_client_uuid)
 where id = p_po_id
 returning status into v_new_status;
```

Note: on a partial receive `received_by` is still stamped (who did the last
receive) but `received_at` stays NULL — the NULL `received_at` is the canonical
"still open" signal that `pending_po_qty` keys on (per OQ-3). On the final
receive that completes it, `received_at` gets set and the PO leaves pending.

**Audit row** (one per call, house shape `(store_id, user_id, action, detail,
item_ref, value)`):
```sql
insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
values (v_store_id, auth.uid(), 'PO received',
        'PO ' || left(p_po_id::text, 8) || ' · ' || v_new_status,
        <vendor name>, <count> || ' line(s)');
```
`user_id` = `auth.uid()` (INVOKER, so this is the real caller — spoof-proof).

**Return envelope:**
```json
{ "po_id": "<uuid>", "status": "received|partial", "conflict": false,
  "lines": [ { "po_item_id": "<uuid>", "received_qty": <cumulative> }, ... ] }
```

**"Close short" — separate RPC, NOT a status token (OQ-3):**

```sql
create or replace function public.close_short_purchase_order(p_po_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$ … $$;
```
Same auth-gate shape. It transitions a `partial` PO → `received` and **stamps
`received_at = now()`** so the outstanding remainder (`ordered − received`)
drops out of `pending_po_qty` (which requires `received_at IS NULL`). The
shortfall stays visible as `received_qty < ordered_qty` on the lines (recoverable
fact — no `closed_short` token needed). Refuses (P0001) if the PO is not
currently `partial`. Writes an audit row `action = 'PO closed short'`. GRANT to
`authenticated`, REVOKE from `public, anon`.

**"Cancel/release" — separate RPC:**
```sql
create or replace function public.cancel_purchase_order(p_po_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$ … $$;
```
Transitions `draft`/`sent`/`partial` → `cancelled` (refuse from `received`/
`cancelled`, P0001). Because `cancelled ∉ ('sent','partial')`, the PO's
quantity leaves `pending_po_qty` immediately. Does NOT touch `current_stock`
(a cancel is not a reversal of already-received stock; a partial-then-cancel
keeps the stock that genuinely arrived and just stops chasing the rest). Audit
`action = 'PO cancelled'`. GRANT/REVOKE as above.

Three small RPCs rather than one mega-RPC with a `p_action` discriminator:
matches the project's one-verb-per-RPC grain (`demote_profile_to_user`,
`record_missed_orders`, etc.) and keeps each pgTAP arm focused.

### §4 — `pending_po_qty` swap in BOTH reorder engines (verbatim-identical)

The CTE currently is (both files):
```sql
pending_po_qty as (
  select distinct ioh.item_id,
         0::numeric as pending_po_qty
    from item_on_hand ioh
),
```

Replace, **byte-identical in both** `report_reorder_list` (re-CREATE from its
CURRENT spec-104 body, `20260701000000:616-634`) and
`report_reorder_for_counted_onhand` (`20260702000000:236-244`):

```sql
pending_po_qty as (
  -- Spec 107 (4g): real inbound aggregate. Sum the outstanding quantity
  -- (ordered − received) over this store's OPEN purchase orders, grouped
  -- per ITEM. "Open" per OQ-3 = status IN ('sent','partial') AND
  -- received_at IS NULL (a partial receive leaves received_at NULL so its
  -- remainder keeps counting; close-short / cancel / full-receive all set
  -- received_at or move status out of the set, dropping the row). LEFT-join
  -- back onto per_item ON item_id; `select distinct`/group-by keeps it ONE
  -- row per item so the per-(item,vendor) explosion in item_on_hand does not
  -- fan the per_item row out (the spec-102 "Flour twice in the BJs card"
  -- hazard — pending is per-ITEM, one shared inbound quantity).
  select pit.item_id,
         sum(greatest(0, coalesce(pit.ordered_qty,0) - coalesce(pit.received_qty,0)))::numeric
           as pending_po_qty
    from public.po_items pit
    join public.purchase_orders po on po.id = pit.po_id
   where po.store_id = p_store_id
     and po.status in ('sent','partial')
     and po.received_at is null
   group by pit.item_id
),
```

Key correctness points:
- **Keyed per-item, grouped, LEFT-joined ON `item_id`** — preserves the
  anti-fan-out invariant the existing `select distinct` comment protects. The
  `group by pit.item_id` yields at most one row per item, so the existing
  `left join pending_po_qty ppq on ppq.item_id = ioh.item_id` cannot multiply
  `item_on_hand`'s per-(item,vendor) rows. (I drop the literal `distinct`
  keyword because `group by` already collapses; the *invariant* — one row per
  item — is preserved, which is what the byte-parity pgTAP asserts on the
  RESULT, see below.)
- **`greatest(0, …)`** guards a data anomaly where `received_qty > ordered_qty`
  (an over-receive) from producing a negative pending that would inflate the
  suggestion.
- Feeds BOTH `par_replacement` and `usage_forecasted` unchanged (they already
  subtract `coalesce(ppq.pending_po_qty, 0)` at `…:793,800` and `…:353,360`).
- The base source is `po_items`/`purchase_orders` directly (NOT `item_on_hand`),
  because an item with an open PO but no `item_vendors` link / no on-hand row
  must still contribute — the LEFT join tolerates the mismatch (an item in the
  pending CTE but absent from `item_on_hand` simply never gets read; an item in
  `item_on_hand` with no pending row coalesces to 0). This is a deliberate
  departure from `select … from item_on_hand ioh` and it is SAFE because the
  join direction is `item_on_hand LEFT JOIN pending_po_qty`.

**Verbatim-copy discipline:** the CTE text above must be pasted identically into
both re-CREATEs. `report_reorder_list` is re-CREATEd from its spec-104 body
(which carries specs 087/088/100/102/104 — copy the LATEST on-disk body, do NOT
resurrect a stale one, or you silently revert those specs and turn their pgTAP
red — same warning both prior reorder migrations carry). `report_reorder_for_counted_onhand`
is re-CREATEd from `20260702000000`. Both signatures are byte-identical →
`create or replace` preserves the existing GRANT/REVOKE; do NOT re-emit them.

### §5 — First `po_items` write path (create-editable-draft) — CLIENT-SIDE via db.ts

**Decision: PostgREST insert from `db.ts`, NOT an RPC.** Weighed:

| | client-side (PostgREST insert) | RPC |
|---|---|---|
| RLS | Insert policies already exist and are correct (`store_member_insert_purchase_orders` + child-scoped `store_member_insert_po_items`). | Would need `security invoker` + explicit gate — redundant with RLS. |
| Atomicity | Header insert then lines insert = 2 round-trips; a mid-failure leaves a header with no lines (recoverable: it's an empty draft the user can delete/retry). | Single transaction. |
| Pattern fit | Matches `createInventoryItemWithCatalog`'s sibling `createPurchaseOrder` which is already a plain PostgREST insert; matches the item_vendors upsert pattern (`db.ts:354-370`). | Heavier. |
| Cost snapshot | Computed FE-side from the reorder payload (which already carries per-each `costPerUnit` + `caseQty` + `suggestedCases`) and passed as a column value. | Same math, server-side. |

The draft is **editable before send** (OQ-4) — the lines are just `po_items`
rows the user edits via subsequent PostgREST updates. An RPC buys atomicity we
don't need for a draft (an orphaned empty header is a benign, deletable state)
and costs a migration surface. **Chosen: client-side.** This is the spec's
"client-write vs RPC for create" fork, resolved toward client-write, consistent
with the existing `createPurchaseOrder`.

**New `db.ts` helper:**
```ts
export async function createPurchaseOrderDraft(params: {
  storeId: string;
  vendorId: string;
  createdByUserId?: string;
  referenceDate?: string;                 // YYYY-MM-DD; → reference_date
  lines: Array<{
    itemId: string;
    orderedQty: number;                   // COUNTED units (= suggestedUnits from reorder payload)
    costPerUnitCounted: number;           // OQ-6: per-COUNTED-unit snapshot (see below)
  }>;
}): Promise<string | null>;               // returns new po id, or null on failure
```
Behavior: insert `purchase_orders` with `status: 'draft'`, `store_id`,
`vendor_id`, `created_by`, `reference_date`, `total_cost` (sum of line costs);
`.select('id').single()`; then bulk-insert `po_items`
(`{ po_id, item_id: itemId, ordered_qty: orderedQty, received_qty: null,
cost_per_unit: costPerUnitCounted }`). On the lines-insert error, best-effort
delete the header (so no orphan) and return null. snake_case→camelCase: not
needed on the write path; the read path (§7 receive mode) adds a `mapPoItemRow`.

**OQ-6 cost snapshot — per-COUNTED-unit, the spec-104 ★ bridge, done FE-side.**
The reorder payload's `costPerUnit` is **per-each** (spec 104 live basis). The
PO line stores the **per-counted-unit** value = `costPerUnit × subUnitSize`. But
the reorder payload does NOT carry `subUnitSize` per item today (the admin
reorder mapper `mapReorderVendor`, `db.ts:3274`, omits it — only the spec-104
report internals use it). Two ways to get the bridged value FE-side, both clean:
- **(preferred)** the create-draft caller reads `subUnitSize` from the Zustand
  `inventory` array by `itemId` (it's an `InventoryItem` field) and computes
  `costPerUnitCounted = item.costPerUnit × (item.subUnitSize || 1)`. This is
  EXACTLY the bridge `ReceivingSection.tsx:100-102` and `POsSection.tsx:77`
  already do (`i.costPerUnit * (i.subUnitSize || 1)`). Reuse that expression.
- (alt) surface `estimated_cost / suggested_units` from the payload — rejected:
  case-rounding makes it lossy per unit.

The result fits `po_items.cost_per_unit numeric(10,2)` with no widening (OQ-6;
waste_log R1 precedent). **Column comment (added in the migration):**
```sql
comment on column public.po_items.cost_per_unit is
  'Per-COUNTED-unit cost snapshot at PO-create time (= inventory_items.cost_per_unit
   per-each × sub_unit_size, the spec-104 ★ bridge). NOT per-each. Fits numeric(10,2)
   losslessly (waste_log R1 precedent). See spec 107 OQ-6.';
```

**`useStore` slice:** add `createPoDraft(vendorReorder)` action (see §8 FE). It
is a WRITE with the optimistic-then-revert + `notifyBackendError` pattern —
optimistically it does nothing visible to inventory (a draft PO doesn't change
stock), so the "optimistic" half is minimal; on success it triggers a
`loadReorderSuggestions` refresh (realtime also fires — see §6) so the newly
inbound quantity immediately reduces the suggestion. On failure:
`notifyBackendError('Create PO draft', e)`.

### §6 — Realtime impact

- **`purchase_orders` is ALREADY in the `supabase_realtime` publication**
  (`20260514140000_realtime_publication_tighten.sql:47`) and ALREADY subscribed
  on the `store-{id}` channel (`useRealtimeSync.ts:54`). Every mutation this spec
  makes to `purchase_orders` — create-draft (INSERT), receive (UPDATE status/
  received_at), close-short (UPDATE), cancel (UPDATE) — fires `onSync` → the 400ms
  debounced full reload → both reorder RPCs re-run → `pending_po_qty` reflects the
  change. **This satisfies the "reflect in reorder within one realtime debounce"
  AC with ZERO publication change and ZERO new subscription.**
- **`po_items` is NOT in the publication and does NOT need to be.** `po_items`
  never changes without its parent `purchase_orders` row ALSO changing in the
  same RPC call (receive updates both; create-draft inserts the header first).
  The header's realtime event already drives the reload. Adding `po_items` to the
  publication would be redundant noise. **Explicitly out of scope — do NOT add it.**
- **Therefore the realtime-publication gotcha does NOT apply to this spec.** No
  `alter publication supabase_realtime add table …`, so **no `docker restart
  supabase_realtime_imr-inventory` step is needed** after `npm run dev:db`. This
  is a relief vs the spec's flagged risk — call it out in the migration header
  (`-- NO publication change; the realtime gotcha does not apply`, mirroring the
  spec-104 header note).

### §7 — Edge function: `send-po-email`

**New function** `supabase/functions/send-po-email/index.ts`, modeled
byte-for-structure on `send-invite-email/index.ts`.

- **`verify_jwt` = default (true).** Add to `supabase/config.toml` explicitly as
  `[functions.send-po-email]` with NO `verify_jwt = false` line (default true),
  because this is an admin-triggered action carrying the caller's JWT — the
  OPPOSITE of the `staff-*`/`pwa-catalog` service-token functions. (Setting
  `verify_jwt = true` explicitly is fine too; the point is it is NOT the
  service-token posture.)
- **Role gate: YES — `requireAdminCaller` / `ADMIN_ROLES` mirror.** Sending a PO
  to a vendor is a privileged, outbound, side-effecting action. Copy the exact
  `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);` +
  `requireAdminCaller(authHeader)` shape from `send-invite-email/index.ts:20-35`
  (which mirrors `auth_is_privileged()`). This is the CLAUDE.md "edge function
  role gates mirror `auth_is_privileged()`" rule — a 10th omission would be a
  regression.
- **`escapeHtml` inline (five-char), every interpolated value.** The PO table
  renders vendor name, each line's item name, unit, ordered qty, unit cost, line
  total, and the grand total. EVERY interpolated value goes through the inline
  `escapeHtml` (`& < > " '`) — item names are user/catalog-controlled and are the
  highest-risk injection surface. Copy the helper verbatim from
  `send-invite-email:42-45` (byte-identical to `src/utils/escapeHtml.ts`; identity
  enforced at review). Subject line and the `to:` address are not HTML → no escape
  (per the convention).
- **Resend** via `RESEND_API_KEY`, `from: "I.M.R Inventory <onboarding@resend.dev>"`
  (match the sibling), `to: [vendorEmail]`.
- **Request shape:** `{ poId: string }`. The function is authoritative — it
  re-reads the PO + lines + vendor server-side (do NOT trust a client-supplied
  HTML body or line set), using a service-role client to assemble the email, but
  AFTER the `requireAdminCaller` gate. It also re-checks the caller can see the
  PO's store (call `auth_can_see_store` via the caller-scoped client, OR rely on
  the fact that the admin gate already implies cross-store visibility — since
  ADMIN_ROLES ⊆ privileged and privileged sees all stores, the store check is
  belt-and-suspenders; include it anyway for the "store member who is somehow
  admin-roled but scoped" edge, matching the RPC gates).
- **Status flip — SERVER-SIDE, on Resend 2xx.** Decision fork resolved: the edge
  function flips `purchase_orders.status` `draft → sent` **itself** via the
  service-role client, but ONLY after Resend returns ok. Rationale: the email
  send and the status flip must not diverge — if the client flipped after a 2xx
  from the function, a lost response would leave a sent-but-still-draft PO. Doing
  it server-side inside the same handler binds them. The function returns
  `{ success, method: 'resend', status: 'sent' }`. The client (via
  `callEdgeFunction`) then refreshes on success; realtime also fires from the
  status UPDATE.
- **Mark-as-sent-manually fallback: CLIENT-SIDE, no email.** For phone/text
  vendors and empty-`vendors.email`, the "send to vendor" action is unavailable
  and only "mark as sent manually" is offered — this is a plain PostgREST UPDATE
  `purchase_orders.status = 'sent'` via a new `db.ts` helper `markPurchaseOrderSent(poId)`
  (RLS `store_member_update_purchase_orders` already permits it). No edge
  function call. This keeps the empty-email path off the email channel entirely.
- **Client call via `callEdgeFunction`** (`src/lib/auth.ts:109`) — returns
  `{ data, error }`; surface `error` via `notifyBackendError`. NOT raw `fetch`
  (would re-introduce the spec-031 silent-fake-success class).
- **Confirm-gated, never auto-sent** (OQ-1): the FE wraps the send in
  `confirmAction` (`src/utils/confirmAction.ts`). The edge function itself has no
  auto-trigger; it only ever runs from the confirmed button.

### §8 — Frontend store + section impact (admin Cmd only, OQ-5)

**`src/store/useStore.ts` slice changes** (all WRITEs use optimistic-then-revert
+ `notifyBackendError`):
- `createPoDraft(vendor: ReorderVendor)` — builds `lines` from
  `vendor.items` (using `suggestedUnits` as `orderedQty` and the
  `costPerUnit × subUnitSize` bridge for `costPerUnitCounted`, reading
  `subUnitSize` from the `inventory` array by `itemId`), calls
  `db.createPurchaseOrderDraft`, then `loadReorderSuggestions(selectedDate)` on
  success.
- `receivePurchaseOrder(poId, lines, clientUuid)` — calls
  `db.receivePurchaseOrder`; on success the realtime reload refreshes inventory +
  reorder. Generates `clientUuid` via the existing uuid util.
- `closeShortPurchaseOrder(poId)`, `cancelPurchaseOrder(poId)` — thin wrappers
  over the two new `db.ts` helpers.
- `sendPurchaseOrderEmail(poId)` — calls `callEdgeFunction('send-po-email', { poId })`;
  `markPurchaseOrderSentManually(poId)` — calls `db.markPurchaseOrderSent`.
- New reads: `fetchPurchaseOrderWithLines(poId)` (header + `po_items` joined to
  `catalog_ingredients` for item names + `inventory_items` for the current
  `subUnitSize`/`unit`) → drives the receive form and the POsSection detail.
  Add `mapPoItemRow` (snake→camel: `po_item_id`←`id`, `orderedQty`←`ordered_qty`,
  `receivedQty`←`received_qty`, `costPerUnit`←`cost_per_unit`, `itemName` from
  the catalog join). Load into a new `reorderInboundByItem` / PO-detail slice as
  appropriate.

**`src/lib/db.ts` new helpers (signatures):**
```ts
createPurchaseOrderDraft(params): Promise<string | null>            // §5
fetchPurchaseOrderLines(poId: string): Promise<PoLine[]>            // read, mapPoItemRow
receivePurchaseOrder(poId: string, lines: {poItemId:string; receivedQty:number}[], clientUuid: string): Promise<{ status: string; conflict: boolean } | null>  // supabase.rpc('receive_purchase_order', { p_po_id, p_lines, p_client_uuid })
closePurchaseOrderShort(poId: string): Promise<string | null>      // rpc('close_short_purchase_order')
cancelPurchaseOrder(poId: string): Promise<string | null>          // rpc('cancel_purchase_order')
markPurchaseOrderSent(poId: string): Promise<boolean>              // PostgREST update status='sent'
```
All go through the `useInflight.getState().track(...)` wrapper like every other
`db.ts` call; kind `'write'` for mutations, `'read'` for the fetch. RPC calls use
`.rpc(...).abortSignal(signal)` mirroring `fetchReorderSuggestions:3238`.

**Sections:**
- **`ReorderSection.tsx`** — replace `DisabledCreatePoButton` (line 180, rendered
  at line 422 inside `VendorCard`) with an ENABLED "+ Create PO" that calls
  `createPoDraft(vendor)` behind a `confirmAction` (creating a draft is benign,
  but a confirm avoids accidental double-drafts). The lines 51-56 v1-contract
  comment ("pending_po_qty always 0", "Create PO disabled") gets updated to
  reflect v2. This is THE integration point the section already scaffolded for
  this spec.
- **`POsSection.tsx`** — currently 100% synthetic (age-derived status at line 42,
  catalog-derived lines at line 61). Rework to read real POs (via a new
  store-backed list, not `orderSubmissions`) and their real `po_items`, and add
  the lifecycle transition buttons: **send to vendor** (confirm-gated, only when
  `vendor.email` present) / **mark as sent manually** (fallback) / **cancel/
  release** / **close short** (only on `partial`). Status filter buckets become
  the real token set (`draft|sent|partial|received|cancelled`). The `resend`/
  `edit`/`duplicate` chrome buttons (lines 210-217) become real or stay
  visual-only per the developer's discretion within AC.
- **`ReceivingSection.tsx`** — add a **PO-driven mode**: a selected real PO lists
  its actual `po_items` (ordered qty shown, input pre-filled with the OUTSTANDING
  remainder `ordered − received` per §3 delta semantics), operator enters
  received-this-time per line, commit calls `receivePurchaseOrder`. The existing
  freeform synthetic path (lines 81-172) is RETAINED as a fallback (not deleted)
  per AC — gate the two modes behind a toggle/tab.

**i18n (×3, per the spec):** new keys for the create-PO confirm, the PO lifecycle
transitions (send / mark-sent / cancel / close-short), and the PO-driven receive
mode go in the **admin** catalog (`src/i18n/en.json` + `es.json` + the third
locale present, e.g. `zh-CN`). **Staff catalog is NOT touched** — receiving and PO
create are admin-only in v1 (OQ-5); the staff Reorder screen does NOT get the
Create-PO button. Confirm the exact locale file set the admin catalog uses when
implementing (the codebase has both `src/i18n/*.json` and a staff-local catalog;
only the admin one changes).

### §9 — Risks, tradeoffs, ordering

1. **Status data-migration depends on the PROD PROBE (§1).** The single biggest
   risk. If prod carries a `status` token outside `{submitted, draft, sent,
   partial, received}`, the `VALIDATE CONSTRAINT` will fail and the migration
   aborts. **Mitigation:** run the §1 probe FIRST, paste results into the
   migration header, and if any surprise token appears, escalate to the PM before
   applying (do not blanket-map). This is a hard gate on the prod apply.
2. **Prod-apply path (no `db push` password).** Per project memory, apply via MCP
   `execute_sql` against `ebwnovzzkwhsdxkpyjka`, then insert the exact version
   `20260704000000` into `supabase_migrations.schema_migrations`, else the
   `db-migrations-applied` gate goes red. The CHECK-constraint add and the
   `alter table … add column` are DDL — verify post-apply that the constraint
   exists (`information_schema.table_constraints`) and the column type is correct
   (a column/constraint change is invisible to the migration-list drift gate —
   manual check, same caveat spec 104 documented).
3. **Verbatim-copy drift in the two reorder RPCs.** The `pending_po_qty` CTE must
   be byte-identical in both re-CREATEs, and each re-CREATE must copy its OWN
   LATEST on-disk body (spec-104 body for `report_reorder_list`; `20260702000000`
   body for the counted sibling). Copying a stale body silently reverts specs
   087/088/100/102/104. **Mitigation:** pgTAP byte-parity probe (below) + the
   in-file header warnings both prior migrations already carry.
4. **DELTA vs absolute `received_qty` (§3).** If the FE ever submits the
   cumulative total instead of the this-receive delta, the accumulate logic
   double-counts stock. **Mitigation:** the RPC comment + FE both document
   "submit what arrived THIS receive; input pre-fills the outstanding remainder,"
   and the idempotency (client_uuid) protects the exact-retry case. A pgTAP arm
   asserts two partial receives sum correctly and a re-send of the same
   client_uuid does not double-increment.
5. **Performance on the 286 KB seed.** The pending_po_qty aggregate adds a
   `po_items ⋈ purchase_orders` group-by per reorder call. Seed has zero PO rows,
   so it is free today; the two new indexes (§2) keep it O(open-POs) as data
   grows. The reorder RPCs are already heavy (recursive recipe walk); this CTE is
   negligible beside that.
6. **Edge-function cold start.** `send-po-email` is a new Deno function; first
   invocation cold-starts. Acceptable — sending a PO is a deliberate, low-
   frequency, confirm-gated action, not a hot path. No mitigation needed.
7. **Orphan draft header on lines-insert failure (§5).** The 2-round-trip client
   create can leave a header with no lines if the second insert fails.
   **Mitigation:** best-effort delete-header-on-failure in `db.ts`, and the
   header is a `draft` the user can also delete/re-run manually. Not worth an RPC.
8. **`received_by` on partial receive.** It is stamped to the last receiver even
   while `received_at` stays NULL. This is intentional (who touched it last) but
   could read oddly in a UI that shows "received by X" on a still-open PO — the FE
   should only surface `received_by` when `received_at` is non-null.

### §10 — pgTAP plan (spec 022 track)

New `supabase/tests/po_loop.test.sql` (or split per-concern):
- **RLS pin** — `purchase_orders` + `po_items` each: a store-member sees own,
  a non-member is denied (SELECT/INSERT/UPDATE), an admin sees cross-store. This
  PINS the existing 2026-05-04 policies (regression guard; not new policy).
- **`receive_purchase_order`** — (a) full receive flips `sent → received`, stamps
  `received_at`, increments `current_stock` by the received qty; (b) short receive
  flips `sent → partial`, leaves `received_at` NULL; (c) idempotency: re-call with
  same `p_client_uuid` returns `conflict:true` and does NOT double-increment
  stock; (d) two sequential partial receives accumulate `received_qty` and stock
  correctly and complete → `received`; (e) non-member refusal — raises `P0002`
  (under `SECURITY INVOKER` the caller's RLS filters the PO row before the gate
  reads it, so the not-found path fires first and hides the PO's existence; the
  `42501` `auth_can_see_store` branch remains as defense-in-depth — architect
  drift-review ruling, reconciled from the original "42501" wording here);
  (f) stock-only — asserts `item_vendors.case_price` and
  `inventory_items.cost_per_unit` are UNCHANGED after receive (OQ-2).
- **`close_short_purchase_order`** — a `partial` PO → `received` with
  `received_at` set; the remainder leaves `pending_po_qty` (assert the reorder
  suggestion rises back). Refuses from non-`partial`.
- **`cancel_purchase_order`** — `sent`/`partial` → `cancelled`; quantity leaves
  `pending_po_qty`; refuses from `received`.
- **`pending_po_qty` in BOTH engines** — seed an item with an open `sent` PO
  carrying `ordered_qty` > 0, assert BOTH `report_reorder_list` AND
  `report_reorder_for_counted_onhand` return a non-zero `pending_po_qty` for that
  item AND a correspondingly REDUCED `suggested_qty` vs the no-PO baseline. This
  is the byte-parity guard on the CTE result (both engines agree).
- **status CHECK** — assert an insert with `status = 'submitted'` (or any
  off-vocabulary token) is rejected post-migration; the five valid tokens pass.

jest: `db.ts` mappers — `createPurchaseOrderDraft` payload shape (per-counted-unit
cost = per-each × subUnitSize), `mapPoItemRow` snake→camel, and the
`callEdgeFunction('send-po-email', …)` call site (mock the envelope). Shell smoke
optional for the receive round-trip.

### §11 — Backend / frontend slice ownership

**Backend-developer owns:** the `20260704000000_po_loop.sql` migration (status
normalization + CHECK, `receive_client_uuid` column + index, the two new indexes,
`receive_purchase_order` / `close_short_purchase_order` / `cancel_purchase_order`
RPCs + GRANT/REVOKE, the two reorder re-CREATEs with the pending_po_qty swap, the
`po_items.cost_per_unit` comment); the `send-po-email` edge function +
`config.toml` entry; the pgTAP suite (§10); the prod-apply notes in the header.
The §1 prod probe is a prerequisite the backend-developer must obtain (from the
owner via MCP) before finalizing the data-migration.

**Frontend-developer owns:** the `db.ts` helpers (§8 — client-side create-draft,
the RPC wrappers, the read + mappers, `markPurchaseOrderSent`); the
`db.createPurchaseOrder` `'submitted' → 'sent'` literal change (§1); the
`useStore` slice actions (§8); the three sections (`ReorderSection` create-PO
button, `POsSection` lifecycle rework, `ReceivingSection` PO-driven mode); the
admin i18n keys (×3, admin catalog only); the jest `db.ts`/edge-call tests.

The two streams share the contract in §3/§4/§5/§7 — coordinate on the
`receive_purchase_order` return envelope and the `send-po-email` request shape.

---

## Files changed

`Status:` is `READY_FOR_REVIEW`. Both slices are now recorded: the BACKEND
slice (§11, backend-developer) and the FRONTEND slice (§8/§11,
frontend-developer — see "### Frontend (this slice — frontend-developer)"
below).

### Backend (this slice — backend-developer)

Migrations:
- `supabase/migrations/20260704000000_po_loop.sql` — NEW. Status normalization
  (`'submitted' → 'sent'`, null/'' → 'draft') + 5-token CHECK
  (`draft|sent|partial|received|cancelled`, add-NOT-VALID then VALIDATE);
  `receive_client_uuid` idempotency column + partial unique index; two supporting
  indexes (`idx_po_items_po_id`, `idx_purchase_orders_store_status_open`); the
  three RPCs `receive_purchase_order(uuid,jsonb,uuid)` /
  `close_short_purchase_order(uuid)` / `cancel_purchase_order(uuid)`
  (security invoker + `set search_path = public` + `auth_can_see_store` gate +
  GRANT to authenticated / REVOKE from public,anon); the two reorder RPC
  re-CREATEs (`report_reorder_list`, `report_reorder_for_counted_onhand`) with the
  byte-identical `pending_po_qty` open-PO aggregate swap; comments on the two
  lifecycle RPCs + the `po_items.cost_per_unit` per-counted-unit basis. One
  atomic `begin/commit`. No RLS repair, no `reference_date` add (both drift
  findings were stale per §0), no publication change.

Edge functions:
- `supabase/functions/send-po-email/index.ts` — NEW. `verify_jwt`-default
  (admin-triggered, carries caller JWT); `requireAdminCaller` / `ADMIN_ROLES`
  mirror of `auth_is_privileged()`; inline five-char `escapeHtml` (byte-identical
  to `src/utils/escapeHtml.ts`) on EVERY interpolated value in the PO table;
  authoritative server-side re-read of PO + vendor + lines; belt-and-suspenders
  `auth_can_see_store` re-check via the caller-scoped client; Resend send modeled
  on `send-invite-email`; `draft → 'sent'` flip SERVER-SIDE only on a Resend 2xx;
  request shape `{ poId }`; NO auto-send pathway (confirm-gated on the client).
- `supabase/config.toml` — added `[functions.send-po-email]` with an explicit
  `verify_jwt = true` (pins the JWT posture against a CLI-redeploy footgun;
  documented why it is NOT in the `verify_jwt = false` set).

Tests (pgTAP — spec 022 track 2):
- `supabase/tests/po_loop.test.sql` — NEW, 30 assertions. RLS pins on
  `purchase_orders` + `po_items` (member/non-member/master); receive math (full /
  short / accumulate-to-complete), idempotency on `receive_client_uuid`
  (conflict:true + no double-increment), stock-only (cost columns unchanged), and
  the non-member refusal; close-short (partial → received, remainder leaves
  pending, refuse non-partial); cancel (refuse from received, quantity leaves
  pending); `pending_po_qty` reduction pinned in BOTH engines (byte-parity of the
  CTE result) + the cancelled-PO-drops-out case; status CHECK (`'submitted'`
  rejected, valid token accepted).

### Deploy / prod-apply steps (USER-GATED — not run by this slice)

- **DB migration → prod:** apply `20260704000000_po_loop.sql` via Supabase MCP
  `execute_sql` against `ebwnovzzkwhsdxkpyjka` (db push lacks the prod password),
  then insert version `20260704000000` into
  `supabase_migrations.schema_migrations` so the `db-migrations-applied` gate
  stays green. The §1 prod probe was already run (6 rows, all `'submitted'`) so
  the normalization is the clean uniform `'submitted' → 'sent'` map; POST-APPLY
  verify the CHECK + column exist and the 6 rows now read `'sent'` (DDL is
  invisible to the migration-list drift gate — manual check).
- **Edge function → prod:** `supabase functions deploy send-po-email` (user-gated
  CLI step). Requires `RESEND_API_KEY` set in the project's function secrets. The
  function's `verify_jwt = true` posture is pinned in `config.toml`.
- **Realtime:** NO publication change and NO `docker restart
  supabase_realtime_imr-inventory` needed (`purchase_orders` is already in the
  publication; `po_items` intentionally is not — §6).

### Two design contradictions resolved during build (flagged for reviewers)

1. **Idempotency `coalesce` direction (§3).** The design's §3 CODE snippet wrote
   `receive_client_uuid = coalesce(receive_client_uuid, p_client_uuid)` (keeps the
   FIRST receive's key), but the SAME section's PROSE (Option-A con column) says
   "each receive event supersedes … overwrites the column." With `coalesce`
   keeping the first key, a SECOND sequential partial receive's retry is NOT
   deduped — violating the idempotency AC for the exact OQ-3 multi-receive flow.
   Resolved toward the explicitly-stated prose intent:
   `coalesce(p_client_uuid, receive_client_uuid)` (overwrite with the new key,
   preserve only when the call is non-idempotent/NULL). pgTAP arm (C)/(D) pins it.
2. **Non-member errcode: P0002 vs 42501 (§3 vs §10).** Under `SECURITY INVOKER`,
   a non-member's RLS filters the PO row the auth gate reads, so `v_store_id` is
   NULL → the RPC raises `P0002` ('not found') before it can reach the `42501`
   `auth_can_see_store` branch (it never learns the store_id). This is the
   behavior of the design's §3 gate code as written; §10 (e) says "42501". Kept
   the design's code (P0002 for a non-member — a hard refusal that also does not
   leak the PO's existence, arguably a stronger posture); the 42501 branch remains
   as defense-in-depth. pgTAP arm (F) asserts the P0002 refusal. Reviewers: decide
   if the AC wording should be reconciled to P0002 or if 42501 must be forced
   (would require reading store_id via a definer path — a design change).

### Frontend (this slice — frontend-developer)

Owns the §8/§11 frontend contract: db.ts helpers + the `'submitted' → 'sent'`
literal change, the `useStore` slice actions, the three sections, admin i18n
(×3), and the jest coverage. All against the ALREADY-APPLIED backend
(`20260704000000_po_loop.sql` + `send-po-email` — verified live on the local
stack). NO new libraries; NO schema changes; admin Cmd only (OQ-5).

Data layer:
- `src/lib/db.ts` — CHANGED `createPurchaseOrder`'s `status: 'submitted'` →
  `'sent'` (§1). ADDED the PO-loop helpers + the `PoLine` type + `mapPoItemRow`:
  `createPurchaseOrderDraft` (client-side header `draft` + `po_items` bulk insert,
  per-COUNTED-unit cost snapshot passed by the caller, orphan-header cleanup on a
  lines-insert failure — §5); `fetchPurchaseOrderLines` (read + `mapPoItemRow`,
  join through `inventory_items → catalog_ingredients` for name/unit/sub_unit_size);
  `receivePurchaseOrder` / `closePurchaseOrderShort` / `cancelPurchaseOrder` (RPC
  wrappers, tracked + `.abortSignal`); `markPurchaseOrderSent` (PostgREST update
  status='sent' — manual fallback, §7); `updatePoItemQty` / `deletePoItem` (draft
  line edits — §5/§8). RPC/edge contracts read verbatim from the migration + the
  edge fn.

Store:
- `src/store/useStore.ts` — ADDED to `AppState` + implemented: state `poLinesById`
  + `refreshPurchaseOrders` (targeted re-pull of `orderSubmissions` post-mutation,
  no full reload); `loadPurchaseOrderLines`; `updatePoLineQty` / `removePoLine`
  (optimistic-then-revert on the cached lines); `createPoDraft` (builds lines from
  `vendor.items` — `suggestedUnits` → orderedQty, `costPerUnit × subUnitSize`
  bridge read from `inventory` by itemId — then refreshes list + reorder);
  `receivePurchaseOrder` (mints the `client_uuid` internally, ADDITIVE deltas, then
  refreshes lines + list + `loadFromSupabase` for inventory + reorder);
  `closeShortPurchaseOrder` / `cancelPurchaseOrder`; `sendPurchaseOrderEmail` (via
  `callEdgeFunction('send-po-email', { poId })` — never raw fetch);
  `markPurchaseOrderSentManually`. All writes use `notifyBackendError`; reads plain.
  ADDED imports: `ReorderVendor` (types), `PoLine` (db), `callEdgeFunction` (auth).

Sections (admin Cmd — `src/screens/cmd/sections/`):
- `ReorderSection.tsx` — REPLACED the `DisabledCreatePoButton` scaffold with an
  enabled `CreatePoButton` (confirm-gated `createPoDraft(vendor)` → toast → points
  the user to Purchase orders). Updated the v1-contract comment block to v2.
- `POsSection.tsx` — REWORKED to the real lifecycle: reads real POs off
  `orderSubmissions` (which carry `status`), status chips for the reconciled
  5-token set (draft/sent/partial/received/cancelled) with status-gated filter
  buckets, loads real `po_items` lines for the detail (editable qty + delete while
  `draft`), and the confirm-gated transition buttons — Send to vendor (only when
  `vendor.email` present) / Mark as sent manually (fallback, always on draft) /
  Cancel (draft·sent·partial) / Close short (partial only) — plus the no-email
  hint. History tab now reads the real status token set. Kept the docs placeholder.
- `ReceivingSection.tsx` — ADDED the PO-driven mode (default) with a mode toggle to
  the RETAINED freeform fallback: PO-driven lists only OPEN POs (sent/partial),
  loads real `po_items`, prefills each "receive now" input with the OUTSTANDING
  remainder (ordered − received; ADDITIVE deltas §3), and Commit submits only the
  non-zero this-receive deltas to `receivePurchaseOrder` (minted client_uuid). The
  original synthetic path is preserved verbatim as `FreeformReceivingMode`.

i18n (admin catalog ×3 — staff catalog UNTOUCHED, OQ-5):
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — ADDED
  `section.reorder.createPo*` (create-draft confirm/toast/labels),
  `section.purchaseOrders.*` (status/statusSub nested objects + the lifecycle
  action labels, confirm dialogs, toasts, no-email hint, new column/card keys),
  and `section.receiving.*` (mode toggle, open-PO list, outstanding/receive-now
  columns + cards, commit copy). Key parity across all three locales (i18n.test.ts
  green).

Tests (jest — spec 022 track 1):
- `src/lib/db.poLoop.test.ts` — NEW, 11 assertions. `createPurchaseOrderDraft`
  header(draft)-then-lines payload shape incl. the per-COUNTED-unit cost snapshot +
  summed total_cost + orphan-header cleanup; `mapPoItemRow` snake→camel + the
  catalog join; `receivePurchaseOrder` RPC payload (snake-cased lines +
  p_client_uuid) + `{status, conflict}` envelope + idempotent-replay + error-throw;
  close-short / cancel RPC name+arg; `markPurchaseOrderSent` UPDATE.
- `src/screens/cmd/sections/__tests__/POsSection.test.tsx` — NEW, 12 assertions.
  Status-chip gating of the lifecycle action buttons per status
  (draft/sent/partial/received/cancelled), send-only-with-email + no-email hint,
  every action confirm-gated (and NOT called on cancel), lines loaded on select.
- `src/screens/cmd/sections/__tests__/ReceivingSection.test.tsx` — NEW, 5
  assertions. Open-PO list filter (sent/partial only), outstanding-remainder
  prefill math, commit submits only non-zero deltas, no-op at all-zero, mode toggle.

Verification:
- Full `npx jest` — 80 suites / 864 tests green (28 new). BOTH typechecks green
  (`npx tsc --noEmit` + `npx tsc -p tsconfig.test.json --noEmit`). `npx expo export
  --platform web` bundles cleanly (all sections compile for web); the Expo web
  dev-server bundles 1862 modules with no error.
- Live browser click-through was NOT possible in this session (no `preview_*`
  tools; the Chrome MCP was not connected and browsers are click-blocked under
  computer-use). Per the prompt's fallback, the FULL golden chain was instead
  validated against the LOCAL DB through the actual RPCs with a simulated
  admin@local.test JWT (rolled back, no seed mutation): create draft (status
  `draft`) → mark sent (`sent`) → receive 4/10 (status `partial`, stock 0→+4,
  received_qty 4, received_at NULL) → idempotent replay same client_uuid
  (`conflict:true`, stock STILL 4 — no double-increment) → receive remaining 6
  (status `received`, stock 10, received_at set) → `pending_po_qty` aggregate = 7
  outstanding when partial, → 0 after full-receive AND after `cancel_purchase_order`.
