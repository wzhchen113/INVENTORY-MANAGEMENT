# Security audit for spec 123

Reorder per-vendor exports + persistent "PO CREATED". Scope: `report_reorder_list`
RPC `has_po` addition, `createPoDraft` referenceDate threading, per-vendor client-side
CSV/PDF export. Read-only review; no mutations performed beyond read-only git/grep/diff.

## Critical (BLOCKS merge)
None.

## High (must fix before deploy)
None.

## Medium
None.

## Low
None.

## Notes / confirmations (no action required)

### 1. `report_reorder_list` change — scoping confirmed, no cross-store leak
- The migration `supabase/migrations/20260718000000_reorder_list_has_po.sql` is a
  faithful `CREATE OR REPLACE` of the prior live definition
  (`20260711000000_reorder_list_include_stocked.sql`). Verified via body diff: the
  ONLY functional change is the additive `has_po` key in `vendor_rows`
  (`:582-589`). Every other CTE, the auth gate, KPI block, warnings block and final
  envelope are byte-for-byte identical.
- The `has_po` EXISTS (`:582-589`) is keyed exclusively on server-resolved values:
  `po.store_id = p_store_id` (the RPC's own param), `po.vendor_id = vwi.vendor_id`
  (a vendor already surfaced within the store-scoped `vendors_with_items` CTE), and
  `po.reference_date = v_as_of_date` (server-resolved date). No client-injectable
  value reaches the subquery — a caller cannot probe another store's or vendor's PO
  state.
- SECURITY posture UNCHANGED. The function remains `SECURITY INVOKER`
  (`20260718000000_reorder_list_has_po.sql:14-18`). The new header omits the explicit
  `security invoker` line only because it was dumped via `pg_get_functiondef`, which
  prints `SECURITY DEFINER` only when non-default and omits the invoker default —
  effective posture identical to the prior migration's explicit `security invoker`.
  `SET search_path TO 'public'` preserved. No `GRANT`/`REVOKE`/`ALTER FUNCTION`,
  no privilege added, no RLS drop.
- The auth gate `public.auth_can_see_store(p_store_id)` remains the first statement
  (`:29-32`), raising `42501` for an unauthorized store. Because the function is
  `security invoker`, the inner EXISTS on `public.purchase_orders` additionally runs
  under the caller's RLS (`store_member_read_purchase_orders` USING
  `auth_can_see_store(store_id)`,
  `20260504173035_per_store_rls_hardening.sql:186-188`) — defense in depth.

### 2. PO enumeration — reveals nothing new
- A privileged caller for a store already has full SELECT on that store's
  `purchase_orders` rows via RLS. Surfacing a boolean `has_po` for their own vendor
  on their own store's reorder list exposes strictly less than they could already
  read directly. No enumeration of other stores/brands is possible (scoping in #1).

### 3. referenceDate threading — no injection/trust issue
- `src/store/useStore.ts` `createPoDraft` sets
  `referenceDate = get().reorderPayload?.asOfDate` — a server-authored date string
  (`envelope.as_of_date` = `to_char(v_as_of_date,'YYYY-MM-DD')`). It flows to
  `db.createPurchaseOrderDraft` (`src/lib/db.ts:1559`) as a PostgREST-bound insert
  column (`reference_date`), never string-concatenated into SQL — no SQLi surface.
  The write itself is gated by `store_member_insert_purchase_orders` WITH CHECK
  `auth_can_see_store(store_id)`, so a caller can only persist PO rows for a store
  they can see.

### 4. No new grant/table/RLS/publication change
- Confirmed. No new table or policy; `purchase_orders` was already RLS-store-scoped.
  Per-vendor CSV/PDF export is entirely client-side over the already-authorized
  reorder payload (narrowing `vendors:[v]`), adding no data-access surface.
- No secrets, PII-in-logs, or CORS/token changes touched. The one `console.warn` in
  `createPurchaseOrderDraft` (`:1567`) logs only `headerErr?.message`, no token/PII.

### Dependencies
No `package.json` changes — `npm audit` skipped. (Verified via `git status`: only
`.tsx`/`.ts`/`.json` i18n/source, spec, migration, and pgTAP test files changed.)

## Verdict
No authorization, injection, secret-exposure, or data-leak regressions. This is a
correctly-scoped additive read-flag + client-side UI change. Nothing blocks merge.
