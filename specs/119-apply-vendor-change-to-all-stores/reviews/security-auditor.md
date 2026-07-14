# Security audit for spec 119 — Apply vendor change to all stores

Primary target: the new SECURITY DEFINER RPC
`public.apply_item_vendors_to_brand(uuid, jsonb, uuid)` in
`supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql`, its db.ts
wrapper `applyItemVendorsToBrand` (`src/lib/db.ts:533-559`), and pgTAP coverage
in `supabase/tests/apply_item_vendors_to_brand.test.sql`.

Verdict: **No Critical, no High.** The SECURITY DEFINER boundary is correctly
sealed — search_path pinned, full auth gate before any write, per-store
visibility enforced inside the fan-out, typed/parameterized JSONB extraction (no
dynamic SQL), correct GRANT posture. Details of each check below.

## Verification of the six required checks

1. **search_path pinned — PASS.** `set search_path = public`
   (`20260714000000_apply_item_vendors_to_brand.sql:74`) is baked into the
   function definition, not caller-mutable. Every table/function reference in the
   body is schema-qualified (`public.catalog_ingredients`, `public.item_vendors`,
   `public.inventory_items`, `public.stores`, `public.auth_*`). No unqualified
   reference is hijackable. Byte-aligned with `copy_brand_catalog`.

2. **Auth gate BEFORE any write — PASS.** Three guards fire before the loop and
   before any INSERT/UPDATE/DELETE:
   - `auth_is_privileged()` (admin OR super_admin) at line 84 → `raise 'privileged only'`.
   - catalog resolution + not-found at 88-93 → `raise 'catalog ingredient not found'`.
   - `auth_can_see_brand(v_brand_id)` at 96-98 → `raise 'brand not accessible'`.
   Cross-brand is impossible: the brand is derived from the *catalog row itself*
   (`select brand_id ... where id = p_catalog_id`), not from any caller-supplied
   brand, so a brand-A admin passing a brand-B `p_catalog_id` resolves
   `v_brand_id = B` and `auth_can_see_brand(B)` returns false for them
   (`auth_can_see_brand` = super_admin OR `profiles.brand_id = p_brand_id`,
   `20260509000000_multi_brand_schema_rls.sql:200-210`). pgTAP exercises both
   negative paths, not just the happy path: test (0) role=user rejected with
   `privileged only` (a caller who CAN see the brand but is not privileged), test
   (1) admin rejected cross-brand with `brand not accessible`, test (2) unknown
   catalog rejected. The SQL enforces what the tests assert.

3. **Per-store visibility — PASS.** The target loop filters
   `public.auth_can_see_store(ii.store_id)` (line 114) and the skipped-set query
   filters `public.auth_can_see_store(s.id)` (line 171). A store the caller
   cannot see is neither read, written, nor counted. Per the visibility model
   (`20260517040000_auth_can_see_store_brand_scope.sql:88-108`) an admin/master
   sees exactly the stores in their own brand, so brand-privileged does imply
   all-own-brand-stores today — the per-store filter is correct belt-and-suspenders
   that also produces authoritative skipped semantics. super_admin sees all
   stores/brands by design (top privilege). No store outside the caller's
   visibility can be mutated.

4. **Input validation — PASS.** `p_vendors` JSONB is decomposed via
   `jsonb_array_elements` with explicit typed casts — `(elem->>'vendor_id')::uuid`,
   `(elem->>'cost_per_unit')::numeric`, `nullif(elem->>'order_code','')` (lines
   102-104, 139-143). No `format()`/`EXECUTE`/string-built SQL anywhere; all
   writes are ordinary parameterized INSERT/UPDATE/DELETE. **No SQLi surface.**
   `is_primary` is NOT taken from the payload — it is computed server-side as
   `coalesce((vendor_id = p_primary_vendor_id), false)` (line 142) and reasserted
   on the DO UPDATE branch, so a caller cannot flag an arbitrary vendor primary
   independently of `p_primary_vendor_id`. The pre-unset of the stale primary
   (lines 120-124) plus this computed value keep the
   `item_vendors_one_primary_per_item` partial-unique index satisfied.

5. **No IDOR / no client-side privilege leak — PASS.** The db.ts wrapper
   (`src/lib/db.ts:539`) calls `supabase.rpc('apply_item_vendors_to_brand', ...)`
   on the ordinary authed client — the caller's JWT flows through, and the RPC
   re-asserts privilege/brand/store internally. No service-role key, no service
   token, no raw `fetch` on the client path. The RPC's SECURITY DEFINER bypass is
   fully re-gated in-body.

6. **GRANT posture — PASS.** `revoke execute ... from public, anon; grant
   execute ... to authenticated;` (lines 186-187). anon cannot invoke it at all;
   authenticated can invoke but is rejected by the internal `auth_is_privileged()`
   gate unless admin/super_admin. Correct least-privilege shape, matching the
   sibling privileged RPCs.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `20260714000000_apply_item_vendors_to_brand.sql:135-144` — the RPC inserts each
  submitted `vendor_id` into `item_vendors` **without** asserting that the vendor
  belongs to the catalog's brand (`vendors.brand_id = v_brand_id`). A brand-A
  admin could craft a payload referencing a brand-B `vendor_id` and create a
  cross-brand dangling reference on their own brand-A items. Impact is bounded and
  **not** a data-exfiltration path: the FK only requires the vendor row to exist;
  reading that foreign vendor's details still goes through the brand-scoped
  `vendors` RLS, so no brand-B data is disclosed to the caller. It is a
  data-integrity nuisance, not a privilege escalation. Crucially this is **parity
  with the existing Save path** — `updateInventoryItem` (`src/lib/db.ts:494-508`)
  upserts `item_vendors` with an equally-unvalidated `vendorId`, so the RPC grants
  no new capability a brand admin lacked per-store. Recommend (defense-in-depth,
  non-blocking) a `where exists (select 1 from public.vendors v where v.id =
  (elem->>'vendor_id')::uuid and v.brand_id = v_brand_id)` guard on the upsert
  select, applied to both this path and the Save path in a follow-up if the team
  wants to close the class.

- `20260714000000_apply_item_vendors_to_brand.sql:140-141` — `cost_per_unit` /
  `case_price` are `coalesce(...::numeric, 0)` with no non-negative bound, so a
  malformed/negative price seeds through on new links. Data-quality only (the
  caller writes their own brand's data), parity with the create/update paths, not
  a security boundary. Noting for completeness; no action required for this spec.

## Dependencies

No `package.json` change in this spec — `npm audit` skipped.

## Notes for release-coordinator

The SECURITY DEFINER surface — the highest-risk element of this spec — is
correctly hardened. Both auth boundaries (privileged, cross-brand) and per-store
scoping are enforced in the SQL and exercised by pgTAP negative-path tests, not
just happy-path. The two Low items are pre-existing parity observations, not
regressions introduced by 119, and do not block. Nothing here blocks advancement.
