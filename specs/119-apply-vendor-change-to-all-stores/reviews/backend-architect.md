# Backend-architect drift review — Spec 119 "Apply vendor change to all stores"

Reviewed the STAGED implementation against the `## Backend design` I authored in
`specs/119-apply-vendor-change-to-all-stores.md`.

**Verdict: implementation matches the contract. No Critical or Should-fix drift.**
Four Minor / informational notes below. The RPC, db.ts wrapper, store action, and
pgTAP all land as designed; the one design/actual divergence (migration version)
is a *correct* deviation the developer made to avoid a real collision.

Files inspected:
- `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql`
- `src/lib/db.ts:522-559` (`applyItemVendorsToBrand`)
- `src/store/useStore.ts:224-228` (interface), `:1397-1416` (action)
- `supabase/tests/apply_item_vendors_to_brand.test.sql`
- Helpers: `auth_can_see_brand` / `auth_is_privileged` / `auth_can_see_store`
  (`20260509000000_multi_brand_schema_rls.sql:200-244`)

---

## 1. RPC contract — MATCHES

Signature is exact: `apply_item_vendors_to_brand(p_catalog_id uuid, p_vendors jsonb,
p_primary_vendor_id uuid) returns jsonb`, `SECURITY DEFINER`, `set search_path =
public`, `revoke ... from public, anon` + `grant ... to authenticated`
(migration:67-74, 186-187). Return shape `{updated_count, skipped_count,
skipped_store_ids}` (migration:178-182).

Each contract clause verified:
- **Auth gate** — `auth_is_privileged()` → resolve `brand_id` from
  `catalog_ingredients` → `auth_can_see_brand()` → per-store `auth_can_see_store()`
  in the loop filter (migration:84-114). Byte-aligned with `copy_brand_catalog`.
  Error strings `'privileged only'` / `'catalog ingredient not found'` /
  `'brand not accessible'` all present and raised BEFORE any side effect.
- **Preserve-existing-price / seed-new-link** — the single `on conflict do update`
  sets `order_code`, `is_primary`, `updated_at` only, and DELIBERATELY omits
  `cost_per_unit` / `case_price` (migration:145-148); the INSERT branch seeds
  cost/case from the submitted values (migration:140-141). Exactly the AC-6 split.
- **Propagate-order-code** — `order_code = excluded.order_code` on the update
  branch, `nullif(...,'')` on insert (migration:143,146). AC-7 satisfied on both
  branches.
- **De-select delete** — `delete ... where not (vendor_id = any(v_submitted))`
  with empty-set semantics deleting all links (migration:153-155, 100-104). AC-5.
- **is_primary + legacy scalar mirror on every store** — `is_primary =
  coalesce((vendor_id = p_primary_vendor_id), false)` per row, and
  `update inventory_items set vendor_id = p_primary_vendor_id` on every target
  (migration:142, 158-160). AC-8, on each store, not just current.
- **Only-existing + skip count** — target set filtered on
  `ii.catalog_id = p_catalog_id`; skipped set is visible brand stores with
  `not exists` a row (migration:110-114, 167-176). AC-9. No row creation.

No drift.

## 2. Primary partial-unique-index ordering — HANDLED, and pgTAP exercises the multi-row re-point

The RPC unsets any existing primary that is not the new one BEFORE the upsert
(migration:120-124), so within each item the partial-unique index
`item_vendors_one_primary_per_item` never transiently holds two `is_primary=true`
rows. Because at most one submitted vendor equals `p_primary_vendor_id`, the upsert
statement itself can only ever set one row true — the unset-first step covers the
old-primary carryover. This mirrors `updateInventoryItem`'s proven order.

The pgTAP DOES exercise a multi-row primary re-point: the fixture seeds Towson
(V1 primary + a de-selected V3) and Charles (V1 primary), and the single apply call
repoints BOTH items' primary from V1 → V2 (test fixtures:79-86, apply:130-142).
Assertions (6)(7)(8) confirm the new single primary is V2 on each item and old V1
is no longer primary; (16) confirms the de-selected V3 was removed. If the index
tripped transiently the txn would roll back and these would fail. `plan(19)` matches
the 19 assertions (0)-(18).

## 3. db.ts wrapper + store action — MATCH conventions

- Wrapper (`db.ts:533-558`) is a thin `useInflight...track({ kind: 'write',
  label: 'applyItemVendorsToBrand' })` over `supabase.rpc`, throws the PostgREST
  error, maps camelCase→snake_case in (`vendor_id/cost_per_unit/case_price/order_code`,
  `order_code` null-coalesce identical to update path) and snake_case→camelCase out
  (`updatedCount/skippedCount/skippedStoreIds`). Single definition (the momentary
  frontend duplicate was removed per the spec's Files-changed note — confirmed only
  one `export async function applyItemVendorsToBrand`).
- Store action (`useStore.ts:1397-1416`) does NOT do a client-side cross-store
  optimistic write. It calls the RPC, then `loadFromSupabase(currentStore.id)` to
  refresh the current store, returns the RPC summary on success, and
  `notifyBackendError('Apply vendors to all stores', e)` + `null` on failure. This is
  a *safe deviation* from the design's "optimistic-then-revert scoped to current
  store" — reload-on-success uses authoritative server state and avoids a
  mis-patched optimistic slice; AC-10 (summary) and AC-11 (no silent success) are
  both satisfied. No concern.

## 4. Migration / prod / realtime — CONFIRMED

- **Function-only, no schema/column/index/publication change.** The migration
  contains only the `create or replace function` + grants + comment; grepped clean
  for `alter publication`. `item_vendors` realtime publication membership is
  unaffected — the design's "publication gotcha does not apply / no docker restart"
  holds, and the migration header documents it (migration:32-38).
- **Version `20260714000000` does not collide.** NOTE: the design proposed
  `20260713000000`, but that slot is already taken by spec 116
  (`20260713000000_vendor_import_customer_numbers.sql`). The developer correctly
  bumped to `20260714000000` (today's date, unique). The design doc's proposed
  filename is now stale — no code action needed, but do not "fix" it back.
- **Prod apply still required.** Per the MEMORY.md MCP convention (migration header
  40-46), this must be applied to prod `ebwnovzzkwhsdxkpyjka` via MCP `execute_sql`
  + `schema_migrations` insert of `20260714000000` + normalized-md5 verify. Until
  then the `db-migrations-applied.yml` gate on `main` will be RED (repo-has /
  prod-missing). Apply in the same push window — this is a deploy gate, flagged.

## 5. Single-store Save path — UNTOUCHED

`updateInventoryItem` (`db.ts:388-519`) is unchanged — the spec-102/114 per-store
reconcile is intact and `applyItemVendorsToBrand` is strictly appended after it. The
store's Save action is not modified. AC-2 holds: brand-wide propagation is only the
explicit RPC path.

---

## Minor / informational notes (no action required to ship)

- **M1 — `auth_can_see_store()` in-loop filter is vacuous for the actual callers,
  and the cross-brand guarantee rests on the brand gate + catalog-id targeting, not
  that filter.** For an `admin` JWT `auth_can_see_store()` short-circuits `true` for
  every store, and for `super_admin` it's `true` everywhere; since the RPC gates on
  `auth_is_privileged()`, the per-store filter admits all rows for every legitimate
  caller. Cross-brand is actually prevented by (a) `auth_can_see_brand(catalog.brand)`
  and (b) targeting `inventory_items where catalog_id = p_catalog_id` — a brand-A
  catalog's items can only live in brand-A stores. This is correct and safe (it's the
  belt-and-suspenders the design called for), but future maintainers should NOT treat
  the `auth_can_see_store` line as the load-bearing cross-brand guard. Likewise
  pgTAP (17)(18) prove *catalog-id* scoping keeps brand B untouched — they do not
  prove the per-store filter does anything, because brand B's item points at catalog
  Y and is never in the target set regardless. No change needed; noting so the guard's
  true source is documented.

- **M2 — wrapper ignores the inflight `signal`.** `applyItemVendorsToBrand`'s
  `track(async () => …)` does not thread the abort `signal` into `.abortSignal()` the
  way `updateInventoryItem` does, so the single RPC write is not cancellable on
  inflight teardown. Trivial (one round-trip, write-kind), consistency-only.

- **M3 — pgTAP does not appear to have been executed locally.** The spec's frontend
  verification note states the RPC "is not applied to the local Supabase stack," so
  the new `apply_item_vendors_to_brand.test.sql` was likely not run locally. It WILL
  run in CI `test.yml` (which applies migrations to a fresh DB). Confirm that run is
  green before SHIP_READY — do not rely on the local jest-only pass as evidence the
  DB contract holds. (Same local-green / CI-red asymmetry class CLAUDE.md warns about.)

- **M4 — design-doc filename is stale (see §4).** Cosmetic; the implemented
  `20260714000000` is the correct choice.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor
  (M1 vacuous per-store filter / true cross-brand guard is brand-gate+catalog-id;
  M2 wrapper drops inflight signal; M3 confirm CI pgTAP green — likely not run
  locally; M4 stale design filename). Contract, RLS gate, primary-index ordering,
  realtime/publication, and untouched Save path all verified. Prod MCP apply +
  schema_migrations insert of 20260714000000 remains a required deploy step
  (db-migrations-applied gate red until then).
payload_paths:
  - specs/119-apply-vendor-change-to-all-stores/reviews/backend-architect.md
