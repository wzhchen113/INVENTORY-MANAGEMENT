# Security audit for spec 104 — Per-each (smallest-unit) cost basis rework

Reviewer: security-auditor
Verdict: **PASS — 0 Critical, 0 Should-fix, 2 Nits.** Nothing blocks.

Scope audited: the prod-touching migration
`supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql`
(column widening + option-(b) re-derivation + `report_reorder_list` re-CREATE +
`staff_log_waste` re-CREATE + audit table), the `db.ts` write-side bridges
(`logWasteEntry`, `mapItem` fallback), the pgTAP grant allowlist update, and the
new reorder pgTAP fixture. Focus areas from the dispatch (audit-table grants,
SECURITY DEFINER RPC posture, migration reversibility/idempotency, injection /
data-exposure in the re-derivation and bridges) all clear.

---

## Critical (BLOCKS merge)

None.

## Should-fix (before deploy)

None.

## Nits

- `supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql:145-160` —
  The audit table `spec104_per_each_cost_audit` is created with no explicit
  `owner`/schema-qualified grant beyond the `revoke all from anon,
  authenticated`. This is correct and matches the spec-093 pattern, but the
  deny-all posture rests entirely on the pgTAP arm (7) in
  `public_grants_explicit.test.sql` catching a future `GRANT ALL` regression from
  the spec-097 default-privileges migration. That guard IS in place (verified
  below) — noting only that the table's confidentiality is CI-enforced, not
  schema-enforced, so the arm-(7) assertion must never be deleted. No action
  required this spec.
- `specs/104-…md` "Open issues surfaced" #3 (POs/Receiving per-unit display shows
  raw per-each next to a bridged line total) — a cosmetic display inconsistency,
  explicitly flagged by the FE slice as out-of-scope follow-up. Not a security
  concern (no dollar-total drift, no data exposure); recording it here only so
  the release-coordinator sees it was security-reviewed and dismissed.

---

## Detailed findings by focus area

### 1. Audit table — grant-locked, not anon/authenticated readable — PASS

`spec104_per_each_cost_audit` (migration:145-160) is `enable row level security`
with **no policy** AND an explicit `revoke all on … from anon, authenticated`
(:159-160) = deny-all to every app caller. Same posture as the spec-093 audit
table. It is never added to any realtime publication (verified: no `alter
publication` / `supabase_realtime` line anywhere in the migration except the
header comment stating so — migration:113-115). It stores cost scalars
(`old_cost`, `new_cost`, `case_price`) keyed by row UUIDs — **no PII**, and in any
case unreachable over PostgREST.

The `public_grants_explicit.test.sql` allowlist is updated **correctly**:
- Both positive arms (1)/(2) add `('public','spec104_per_each_cost_audit','anon')`
  and `(…,'authenticated')` to the allowlist VALUES (test:198-199, 245-246) — so
  the positive SELECT sentinel skips those two roles (Category A: deliberate
  table-level REVOKE), and only those two.
- `service_role` is **NOT** allowlisted, so the positive sentinel still asserts
  service_role retains SELECT (test:444-447) — correct: the migration's `revoke`
  scopes only anon/authenticated.
- A new dedicated negative arm (7) (test:432-447, plan bumped 10→13) asserts
  `has_table_privilege` is FALSE for anon+authenticated and TRUE for service_role
  on the audit table — this is the half that actually pins the REVOKE (the
  allowlist alone would let a dropped-REVOKE regression slip past). The
  Category-A / Category-B distinction is applied correctly (the audit table runs
  a table-level REVOKE ⇒ Category A ⇒ on the list).

### 2. ALTER TABLE / re-derivation preserves existing RLS — PASS

`alter table … alter column cost_per_unit type numeric(12,6)` (migration:128-129)
is a column-type change only. It does **not** touch RLS state, policies, grants,
or publication membership on `inventory_items` / `item_vendors`. Postgres
preserves all policies across an `ALTER COLUMN … TYPE`. The three UPDATEs
(migration:220, 276, 328) run as the migration role and mutate only
`cost_per_unit`/`default_cost` + `updated_at` — no policy or grant statement on
the three target tables appears anywhere in the file. The `auth_can_see_store()` /
brand-scoped policies on all three tables are untouched. No RLS regression.

### 3. SECURITY DEFINER / invoker RPCs — search_path pinned, model unchanged — PASS

**`report_reorder_list`** (migration:398-1018):
- `security invoker` + `set search_path = public` (migration:403-404) — pinned,
  matching the spec-102 original.
- Auth gate is the FIRST statement: `if not public.auth_can_see_store(p_store_id)
  then raise … using errcode = '42501'` (migration:416-419) — byte-identical to
  the latest body.
- Body diff (spec-102 latest → spec-104): I extracted both function bodies and
  ran a unified diff. The **only** deltas are the two documented additive hunks —
  the `coalesce(ci.sub_unit_size,1)::numeric as sub_unit_size` select item, and
  the `× pis.sub_unit_size` on both `estimated_cost` CASE branches. Everything
  else — auth gate, CTE chain, per-vendor coalesce, envelope — is byte-identical.
  **No stale-copy regression** (the header-rule hazard both prior reorder
  migrations warn about): specs 088/100/102 are NOT reverted.
- Signature byte-identical to the latest (`p_store_id uuid, p_params jsonb default
  '{}'::jsonb`), so `create or replace` preserves the existing `revoke … from
  public, anon` + `grant … to authenticated` ACL. No new overload minted. No
  grant/revoke restated (migration:1020-1023). Correct.

**`staff_log_waste`** (migration:1067-1162):
- `security definer` + `set search_path = public` (migration:1078-1079) — pinned,
  matching the phase-13d original. A SECURITY DEFINER function with an unpinned
  search_path would be a schema-hijack risk; it is pinned. Clear.
- Signature byte-identical to the phase-13d original (8 params, verified by
  normalized-signature extraction), so `create or replace` preserves the existing
  `revoke … from public, anon, authenticated` + `grant execute … to
  service_role` ACL — the function stays **service_role-only**. No new overload
  with default PUBLIC execute is created. This is the load-bearing check for a
  SECURITY DEFINER function: confirmed no silent exposure.
- The body change (reading `ci.name`/`ci.unit`/`ci.sub_unit_size` from a
  `left join catalog_ingredients` instead of the P3-dropped
  `inventory_items.name`/`unit` — migration:1108-1113) introduces **no privilege
  or data-exposure change**: the function already ran as definer over the same
  store-scoped item lookup (`ii.id = p_ingredient_id and ii.store_id =
  p_store_id`, migration:1113), which is unchanged. The catalog join only surfaces
  brand-shared name/unit/sub_unit_size for the item already being written — no new
  table read that widens the caller's reach. The `P0002` not-found errcode
  (migration:1116-1117) is preserved.
- **Dormant confirmed:** the `staff-waste-log` edge function
  (`supabase/functions/staff-waste-log/index.ts`) returns HTTP 410 for all routes
  including OPTIONS (retired spec 061); `staff_log_waste` has no live caller and is
  service_role-only. The re-CREATE keeps it that way. Its `verify_jwt = false` in
  config.toml is fine — the function does no work and touches no data (pure
  gone-stub), so the "verify_jwt=false must validate a bearer" rule is satisfied
  vacuously.

### 4. Migration safety — reversibility / idempotency / no destructive drop — PASS

- **No destructive drop without backup.** The only drops are in the commented,
  not-auto-applied BACKOUT block (migration:1227). The forward migration drops
  nothing. `inventory_items_cpu_backup_20260626` is referenced in the header and
  the BACKOUT as explicitly NOT dropped (migration:98-102, 1195-1197). Preserved.
- **BACKOUT restores VALUES before re-narrowing.** The BACKOUT (migration:1199-
  1228) restores `cost_per_unit`/`default_cost` from the audit snapshot's
  `old_cost` FIRST (while columns are still `numeric(12,6)`), THEN re-narrows to
  `numeric(10,2)`. Order is correct and called out as non-negotiable — narrowing
  first would re-truncate the restored 2-dp values. The restored values are exact
  2-dp originals, so the re-narrow rewrite is lossless. Sound.
- **Idempotency cannot corrupt data on re-apply.** The per-each predicate
  (`cost_old > 0`) does NOT self-extinguish — a flipped row still has `cost_old >
  0`, so a naive re-run would double-divide (shrink `sub_unit_size×`). The
  migration guards **every** snapshot INSERT and, transitively, every UPDATE on
  the audit table: each UPDATE joins `spec104_per_each_cost_audit a … where
  a.population = 'D' and a.new_cost is not null` (migration:220-227, 276-282,
  328-335), and the snapshot INSERTs carry `not exists (select 1 from …_audit …)`
  guards (migration:188-192, 210-214, 251-255, 269-273, 304-308, 321-324) plus
  `on conflict (source_table, row_id) do nothing`. A second apply finds the audit
  row already present → snapshots 0 new rows → the UPDATE (driven off the audit
  table's `new_cost`, which was computed from the ORIGINAL `old_cost`) is
  idempotent even if it re-fires, because it writes `a.new_cost` (a fixed stored
  value), not `ii.cost_per_unit / sub_unit_size` recomputed off the live column.
  **This is the key safety property:** the UPDATE writes the FROZEN `new_cost`
  from the snapshot, not a live recomputation, so re-application is a no-op even
  in the degenerate case. Confirmed present on all three UPDATEs.
- The local-vs-prod caveat (migration:86-96) — do NOT hand-re-apply on a seeded
  local DB (the audit would be empty after `db reset`, so seed rows would divide
  twice) — is documented. This is an operational note, not a code defect; the
  supported path (`db reset` alone) is safe. No action.
- All statements are inside one `begin;`/`commit;` (migration:117, 1169) — a
  failure rolls back the widening WITH the data flip; no half-widened / half-
  flipped state.

### 5. Injection / data-exposure surface — PASS

- **No dynamic SQL.** No `EXECUTE`/`format(... %s ...)`-into-SQL anywhere in the
  migration (the only `format(...)` usages are in the *test* file, building a
  `has_table_privilege` argument from `%I` identifier quoting — safe). The
  re-derivation is static SQL with bound column references; `sub_unit_size`,
  `case_qty`, costs are all read as typed numeric columns. No SQLi.
- **`logWasteEntry` write-side bridge** (`src/lib/db.ts:676-711`): the pre-write
  `sub_unit_size` lookup (`.from('inventory_items').select('catalog:catalog_
  ingredients(sub_unit_size)').eq('id', entry.itemId)`) goes through the normal
  authenticated `supabase` client, so `inventory_items` RLS (`auth_can_see_store`)
  + the catalog join both apply — a caller can only resolve `sub_unit_size` for an
  item in a store they can already see, and only that single column is selected.
  No cross-store probe, no over-select. The subsequent `waste_log` insert binds
  all values (`reason`, `notes`, `unit` are parameters, not interpolated). No
  injection, no exposure.
- **`mapItem` fallback** (`src/lib/db.ts:4208-4221`): pure client-side arithmetic
  (`cp / piecesPerCase(caseQty, subUnitSize)`) over values already fetched under
  RLS. No new query, no new data reachable. Single-sourced through
  `piecesPerCase` so it agrees with the migration basis.
- **Error messages:** the RPC exceptions (`Not authorized for store %`,
  `ingredient % not found at store %`) echo only the UUID the caller already
  supplied — no SQL fragment, no other-store row data, no stack trace leaked to
  the client. Unchanged from the originals.
- **Seed regen:** `git diff` on `supabase/seed.sql` is a clean 1:1 value
  substitution (460 insertions / 460 deletions). No `GRANT`, `POLICY`,
  `service_role`, secret, password, JWT, bearer, or API-key line added. No PII
  shape change.

### 6. Realtime / publication — PASS

No `alter publication … add table` in the migration. All three target tables are
already in `supabase_realtime`; the audit table is deliberately NOT published
(cost data stays off the wire). The realtime-publication gotcha does not apply —
correctly documented (migration:113-115) and verified.

---

## Dependencies

`package.json` / `package-lock.json` were **not** changed by spec 104
(`git diff --name-only` confirms). `npm audit` skipped per process — no dependency
delta to assess.

---

## Summary

The migration is a clean, reversible, idempotent basis flip. The two RPC
re-CREATEs preserve their exact signatures (so `create or replace` preserves ACLs
— no SECURITY DEFINER function is silently re-exposed), pin `search_path`, and
keep the auth model identical (auth_can_see_store gate on reorder; service_role-
only + dormant on staff_log_waste). The audit table is grant-locked and correctly
allowlisted in the spec-097 lint with a matching negative assertion. No dynamic
SQL, no cross-store exposure in the FE bridges, no PII in the audit rows, no
secret/grant leak in the seed regen. Nothing blocks; nothing to fix before deploy.
