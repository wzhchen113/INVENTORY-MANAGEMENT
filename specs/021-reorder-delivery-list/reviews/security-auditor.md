# Security audit for spec 021 (Reorder / delivery list v1)

## Summary

`report_reorder_list(uuid, jsonb)` is a security-clean read-only RPC that
mirrors the reports-trilogy hardening pattern. Live verification against
the local DB confirms:

- `security invoker`, `set search_path = public`, language plpgsql.
- `auth_can_see_store(p_store_id)` is the first executable statement and
  raises `42501` before any joined table is read.
- `EXECUTE` is granted only to `authenticated`. `anon` is correctly
  rejected at the grant layer (the `revoke from public, anon` clause
  worked — `anon` does not inherit the EXECUTE from PUBLIC).
- All store-scoped CTE joins (`eod_submissions`, `inventory_items`,
  `pos_imports`, `order_schedule`) filter by `p_store_id`. Brand-shared
  tables (`vendors`, `catalog_ingredients`, recipe graph) rely on RLS
  through the `security invoker` semantics — every joined SELECT runs as
  the calling user and the per-store / per-brand policies on each table
  apply.
- No dynamic SQL — no `format()`, no `EXECUTE`, no string-concatenated
  values. The only user-controlled input (`p_params->>'as_of_date'`) is
  cast directly to `::date`, which raises `22007` cleanly on malformed
  input.
- No INSERT/UPDATE/DELETE in the function body — read-only.
- The frontend RPC helper uses parameterised PostgREST `.rpc(...)` —
  no string concat.
- `purchase_orders` realtime subscription is store-scoped via
  `filter: 'store_id=eq.${storeId}'` and DB-side RLS gates the payload.
- No `package.json` / `package-lock.json` changes — no new
  dependencies; `npm audit` skipped per spec.
- No secrets, no PII surfaces, no service-role usage anywhere in scope.

Reproduce vectors verified against the local Supabase stack:

1. `anon` calling the function → `ERROR: permission denied for function
   report_reorder_list`. PASS.
2. `authenticated` JWT with no `user_stores` row for Charles store →
   `ERROR: Not authorized for store 1ea549bb-...` (line 13 — the auth
   gate, before any join). PASS.
3. Admin JWT + malformed `as_of_date` in `p_params` →
   `ERROR: invalid input syntax for type date: "not-a-date"` (line 21).
   No information disclosure. PASS.
4. Admin JWT + SQL-injection-flavored value
   (`'2026-05-13''; drop table public.vendors; --'`) → same `22007`
   error; the value is treated as opaque text by `::date`. PASS.
5. Admin JWT + valid call → returns an envelope. PASS.
6. `pg_proc` row confirms `prosecdef = f` (invoker), `proconfig =
   {search_path=public}`. PASS.
7. `routine_privileges` confirms grantee list is
   `{postgres, authenticated, service_role}` only — no `PUBLIC`, no
   `anon`. PASS.
8. All 15 joined tables (`inventory_items`, `eod_submissions`,
   `eod_entries`, `purchase_orders`, `po_items`, `vendors`,
   `order_schedule`, `pos_imports`, `pos_import_items`, `recipes`,
   `recipe_ingredients`, `prep_recipes`, `prep_recipe_ingredients`,
   `recipe_prep_items`, `catalog_ingredients`) have `rowsecurity = t`.
   PASS.

### Critical (BLOCKS merge)

(none)

### High (must fix before deploy)

(none)

### Medium

(none)

### Low

- `supabase/migrations/20260514130000_report_reorder_list.sql:133` —
  `v_today_time := (now() at time zone 'utc')::time;` is compared in
  the next-delivery CTE against `v.order_cutoff_time::time` to decide
  whether "today's delivery is still actionable". The vendor's
  `order_cutoff_time` is wall-clock-as-text-stored-as-time (per
  `20260424001643_vendor_order_cutoff.sql`). The variance and cogs
  runners explicitly punt the server-tz-vs-store-tz call to the
  caller via an explicit `as_of_date`, but `order_cutoff_time` has
  no caller-supplied analogue. Practical impact: stores in non-UTC
  zones may see an "already past cutoff → push to 7 days" decision
  that's actually off by their tz offset. Not a security issue — it's a
  correctness / UX edge case the architect already noted in §6 case
  5. Mentioning here in case the reviewer wants to call it out under
  data-correctness rather than security; the auditor's lane is just
  to flag that the function doesn't leak data when this happens, and
  it doesn't.
- `src/store/useStore.ts:2065` — `console.warn('[Supabase]
  loadReorderSuggestions:', message)` logs the raw Postgres error
  message. The only sensitive content that could appear there is the
  caller-supplied `store_id` (echoed by the `42501` raise) or a
  caller-supplied `as_of_date` value (echoed by the `22007` parse
  error). Neither is sensitive — both are values the caller already
  has. No fix needed; flagged for completeness.
- `supabase/migrations/20260514130000_report_reorder_list.sql:162-164`
  — `raise notice 'Reorder report: prep-recipe chain exceeds depth 5
  (% recipe(s) truncated)'`. A `notice` is informational only and
  surfaces only to a Postgres client (PostgREST swallows it for HTTP
  callers). Not a vector. Noted for completeness.

### Dependencies

No `package.json` / `package-lock.json` changes — `npm audit` skipped.
The migration is pure SQL; the frontend changes are TS-only and import
only existing modules.

### Project-specific posture notes

- The RPC is NOT registered with the `report_runs` framework (per the
  architect's §2). That's intentional — reorder is a live read, not a
  persisted-run, and the security shape is the same standalone
  pattern. Correct call; no concern.
- `pending_po_qty` is hardcoded to `0` in v1 (per §1 / §5 step 6).
  Because the column is in the payload regardless, a future v2 swap
  that filters by `purchase_orders.status` will inherit the same
  per-store RLS treatment automatically — no contract change needed.
  This is the cleanest possible deferral shape from a security
  standpoint: the v2 swap can't accidentally leak cross-store POs
  because the RLS is already on the joined table.
- The "Create PO" button in `ReorderSection.tsx:151-176` is
  intentionally disabled (renders as a `View`, not a `TouchableOpacity`)
  — no click handler exists, no privilege escalation vector. The
  tooltip uses Web's native `title` attribute / RN's
  `accessibilityLabel`, not innerHTML. Safe.
- `mapReorderVendor` in `src/lib/db.ts:2064-2093` casts everything to
  `String` / `Number` / `Boolean` defensively. A malformed server
  payload won't crash the client, won't leak via console, and won't
  pollute the store slice with prototype objects. Good hygiene.
- No edge function changes. `supabase/config.toml` not touched. The
  `verify_jwt` posture for sibling functions is unchanged.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low.
payload_paths:
  - specs/021-reorder-delivery-list/reviews/security-auditor.md
