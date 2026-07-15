## Code review for spec 122

Scope: catalog-mode brand-wide par/cost fan-out (`apply_item_scalars_to_brand`)
+ the catalog.tsv wrong-store binding fix. Files reviewed: the new migration
(`supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql`),
`src/lib/db.ts` (`applyItemScalarsToBrand`), `src/store/useStore.ts`
(`applyScalarsToAllStores`), `src/screens/cmd/sections/InventoryCatalogMode.tsx`,
`src/components/cmd/IngredientFormDrawer.tsx`, the pgTAP test, the two new jest
spec files, `src/store/useStore.test.ts` additions, and i18n en/es/zh-CN.
Cross-checked against spec 119's precedent files for byte-alignment as
instructed.

Overall: clean, well-documented implementation. Save routing is correct —
items.tsv (`brandWide` absent) is byte-identical to pre-spec behavior
(`InventoryDesktopLayout.tsx:562-567` passes no `brandWide` prop), and
catalog.tsv Save always calls `updateItem` for the current store AND
(when `brandWide`) fans exactly `par_level`/`cost_per_unit`/`case_price` via
`applyScalarsToAllStores`. `current_stock` is excluded by construction at
every layer (RPC params, `db.ts` wrapper signature, store action's optimistic
patch, drawer payload) — traced end to end, no leak. The overwrite-vs-119-preserve
divergence is intentional, documented in the migration header exactly as the
spec requires, and confirmed as NOT an inconsistency to flag.

### Critical

None.

### Should-fix

None.

### Nits

- `src/store/useStore.ts:1449-1455` (doc comment) and the "Backend design §6"
  prose in the spec disagree on whether the fan-out targets are "local" to the
  `inventory` slice — the backend design assumed they weren't (borrowing spec
  119's rationale) and prescribed a reload-only implementation, while the
  shipped `applyScalarsToAllStores` correctly recognizes that `inventory` is
  always populated brand/all-stores-wide (`db.fetchAllForStore` →
  `fetchInventory()` with the comment "all stores; needed for cross-store name
  lookups", `src/lib/db.ts:4817`) and does a real optimistic patch + revert
  instead. This is a better-than-spec implementation, not a bug — flagging
  only so the spec's Backend design §6 text gets corrected in a follow-up if
  anyone re-reads it as the source of truth; no code change needed.
- `src/components/cmd/IngredientFormDrawer.tsx:298-317` — the `brandWide`
  Save branch fires `applyScalarsToAllStores(...).then(...)` fire-and-forget
  and calls `onClose()` synchronously right after, before the promise
  settles. This matches the spec's explicit "fire-and-forget" instruction and
  is consistent with how the pre-existing vendor button's confirm-then-async
  path already works elsewhere in the file, so not flagging as a defect — just
  noting for the record since a future reader might wonder why the success
  toast can appear after the drawer is already closed (it's intentional: the
  drawer closing doesn't unmount the app-level `Toast` host).
- `src/components/cmd/IngredientFormDrawer.tsx:450,489` — pre-existing
  `color: '#000'` literals on the accent-colored NEW/EDIT badge and SAVE
  button text, not touched by this diff. (out-of-scope) Already tracked in the
  project's deferred cleanup backlog ("`#000`-on-accent sweep (~35 left)");
  not introduced by spec 122.

### What I checked and did not find issues with

- **Save routing correctness (focus 1):** `toUpdates` (unchanged) still writes
  `current_stock`/`expiry_date`/`usage_per_portion` etc. to the current store
  only; the new `applyScalarsToAllStores(item.catalogId, {...})` call is
  additive and only reachable when `brandWide` is passed, which only the
  catalog.tsv drawer instance does (`InventoryCatalogMode.tsx:752-764`). The
  items.tsv instance (`InventoryDesktopLayout.tsx:562-567`) passes no prop, so
  `brandWide` is `undefined` → falsy → `handleSave`'s `if (brandWide && catalogId)`
  never fires — AC-13 holds by construction, confirmed by the
  `IngredientFormDrawer.spec122.test.tsx` "items.tsv EDIT Save... NO fan-out" case.
- **Blank→null trace (focus 1):** `scalarOrNull` (`IngredientFormDrawer.tsx:99-104`)
  correctly maps `''` → `null` (not `0`), which becomes the RPC's
  NULL-means-skip `coalesce(p_field, ii.field)` no-op
  (`20260717000000_apply_item_scalars_to_brand.sql:117-121`). Verified this is
  distinct from `toUpdates`'s `parseFloat(v.parLevel) || 0` current-store
  write, which is pre-existing, unrelated-scope behavior (a blank field still
  zeros the CURRENT store via `updateItem`, same as always) — the fan-out just
  correctly skips propagating that zero to the rest of the brand. Covered by
  the "blank par field maps to null" jest test and the pgTAP
  NULL-means-skip assertions (14)/(15).
- **Display binding fallback (focus 2):** `sel.rows.find((r) => r.storeId ===
  currentStore.id) ?? sel.primary` (`InventoryCatalogMode.tsx:759`) is correct;
  `currentStore` is pulled into the main component's scope at line 81 (it
  wasn't previously read there — confirmed the dependency the spec called out
  is satisfied). Covered by both jest cases in
  `InventoryCatalogMode.spec122.test.tsx` (current-store match + fallback).
- **RPC SQL quality (focus 3):** Single atomic set-based UPDATE,
  `auth_is_privileged()` → `auth_can_see_brand()` → per-row
  `auth_can_see_store()` gate ordering mirrors 119 exactly. Skipped-store query
  is byte-identical to 119's. Grants (`revoke ... from public, anon; grant ...
  to authenticated`) match. `set search_path = public` present. The migration
  header explicitly calls out the overwrite-vs-119-preserve divergence in the
  exact reviewer-facing language the spec required — correctly NOT flagged as
  an inconsistency.
- **Optimistic patch correctness (focus 4):** `applyScalarsToAllStores`
  (`useStore.ts:1456-1497`) snapshots pre-patch rows keyed by id, patches only
  `parLevel`/`costPerUnit`/`casePrice` (each individually gated on `!= null` so
  an omitted scalar is a true no-op on the local slice too, matching the RPC's
  NULL-means-skip), and reverts every patched row to its exact snapshot on
  `catch`, then calls `notifyBackendError('Apply to all stores', e)` before
  returning `null` — matches the project's optimistic-then-revert convention.
  `current_stock` is never read from or written to in this action. Confirmed
  by both `useStore.test.ts` cases (success patch + revert-on-failure).
- **Naming / dup / i18n parity (focus 5):** `applyItemScalarsToBrand` /
  `applyScalarsToAllStores` naming is consistent with the `applyItemVendorsToBrand`
  / `applyVendorsToAllStores` precedent. `applyScalarsSuccessTitle` /
  `applyScalarsSuccessDetail` keys are present and parallel in en/es/zh-CN with
  matching `{updated}`/`{skipped}` interpolation tokens. No direct
  `supabase.from/rpc` calls outside `db.ts` in any touched frontend file. No
  `window.*`/`Alert.alert` introduced by this diff. No new realtime channels
  (relies on the existing `store-{id}` channel per store, unchanged).
