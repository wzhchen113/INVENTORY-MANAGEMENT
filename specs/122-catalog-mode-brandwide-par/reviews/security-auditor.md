# Security audit for spec 122

Scope: catalog-mode brand-wide par/cost/case_price fan-out RPC + client wiring.
Reviewed `supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql`,
`src/lib/db.ts` (`applyItemScalarsToBrand`), `src/store/useStore.ts`
(`applyScalarsToAllStores`), `src/screens/cmd/sections/InventoryCatalogMode.tsx`,
`src/components/cmd/IngredientFormDrawer.tsx`. Modeled 1:1 on the already-audited
spec 119 `apply_item_vendors_to_brand`.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql:118-120` —
  No lower-bound validation on `p_par_level` / `p_cost_per_unit` / `p_case_price`
  (a negative value would overwrite brand-wide). This is a data-integrity nit, NOT
  a security/authz issue under this threat model: the caller is already
  `auth_is_privileged()` and `auth_can_see_brand()`, writing to their own brand's
  rows, and OVERWRITE semantics are the intended design (OQ-2). The frontend parses
  form strings to numbers before the call. Non-blocking; noting only for parity
  with any future CHECK-constraint hardening pass. Not owned by security.

## What was verified (positive confirmations)

1. **`search_path` pinned** — `set search_path = public` on the function
   (line 86). Helpers it calls (`auth_is_privileged`, `auth_can_see_brand`,
   `auth_can_see_store`) each pin `search_path = public, auth`
   (`20260509000000_multi_brand_schema_rls.sql`). No search-path hijack surface.

2. **EXECUTE grants correct** — `revoke execute ... from public, anon; grant
   execute ... to authenticated;` (lines 148-149), byte-aligned with spec 119.
   anon cannot invoke.

3. **Three-layer auth gate enforced, in order, before any write:**
   - `auth_is_privileged()` else `raise 'privileged only'` (lines 94-96) — a
     non-privileged caller cannot mutate anything.
   - Brand derived **server-side** from the catalog row
     (`select brand_id from catalog_ingredients where id = p_catalog_id`,
     lines 98-100) — NOT from client input. Missing catalog ⇒ `raise 'catalog
     ingredient not found'`.
   - `auth_can_see_brand(v_brand_id)` else `raise 'brand not accessible'`
     (lines 106-108) — cross-brand write is refused.
   - `auth_can_see_store(ii.store_id)` in the UPDATE `WHERE` (line 123) — a store
     the caller cannot see is neither read nor written. Same helper the per-store
     `inventory_items` RLS policy uses, so the DEFINER path cannot exceed what the
     caller could reach via normal PostgREST.
   All helpers key off `auth.uid()` (request JWT via GUC), so caller identity is
   correctly resolved despite SECURITY DEFINER — the definer identity does not
   leak into the checks. A non-privileged or cross-brand caller CANNOT mutate rows.

4. **Write scope structurally bounded (AC-5/AC-6)** — the UPDATE `SET` list names
   exactly `par_level`, `cost_per_unit`, `case_price`, `updated_at` (lines 118-121).
   `current_stock`, `expiry_date`, `usage_per_portion`, and any daily-usage/
   safety-stock field are NOT parameters and NOT in the SET list — it is
   structurally impossible for a compromised or confused client to zero physical
   stock brand-wide. The client action (`useStore.ts:1475-1486`) likewise only
   ever patches the three scalars and only passes the three scalars to the RPC;
   `current_stock` never reaches the fan-out payload.

5. **No injection** — params are `uuid` + three `numeric`; the UPDATE is a static
   parameterized set-based statement with no dynamic `EXECUTE`, no string
   interpolation. The skipped-store query is likewise static and parameterized.

6. **No new exposure** — function-only additive migration: no new table, no RLS
   policy change, no publication membership change, no new grant beyond the single
   `authenticated` EXECUTE (which is required for any admin to call it). `coalesce(p_field, ii.field)`
   NULL-means-skip is a no-op, not a widening. Realtime replays on the existing
   per-store `store-{id}` channel (already filtered by `store_id`) — no
   cross-store leakage.

7. **Client boundary** — `db.ts` wrapper threads the inflight abort signal, throws
   on error (surfaces as string via the store action's `notifyBackendError`), and
   maps snake→camel. No secrets, no PII in logs, no `useRole()` used as a security
   boundary. Server-side RLS + the three RPC gates are the real enforcement.

### Dependencies

No `package.json` changes in this spec — `npm audit` skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low (non-security data-validation nit on par/cost bounds; non-blocking). The SECURITY DEFINER RPC pins search_path, revokes anon/public and grants only authenticated, derives the brand server-side from the catalog row, and enforces auth_is_privileged + auth_can_see_brand + per-store auth_can_see_store before any write. Write scope is structurally limited to par_level/cost_per_unit/case_price — current_stock and count-like fields are not parameters and cannot be touched. No injection, no new grant/table/policy/publication exposure. Clear to advance from a security standpoint.
payload_paths:
  - specs/122-catalog-mode-brandwide-par/reviews/security-auditor.md
