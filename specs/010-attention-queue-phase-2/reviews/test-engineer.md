# Test report for spec 010 — Expiry tracking & spoilage alerts

## Acceptance criteria status

- **AC1**: Inventory items can carry an expiry date (per-item `expires_at` on `inventory_items`, row-level) → **PASS (CODE-VERIFIED)**
  `inventory_items.expiry_date date` exists in `supabase/migrations/20260405000759_init_schema.sql:63`. The `InventoryItem.expiryDate?: string` type exists at `src/types/index.ts:76`. The `mapItem` function in `src/lib/db.ts:1778` and both `updateInventoryItem` (db.ts:152) and `createInventoryItem` (db.ts:113) already round-trip `expiry_date`. No schema delta was needed for option (a) row-level — confirmed in build notes. Architect correctly chose A1=(a).

- **AC2**: Expiry data has at least one user-facing entry path → **PASS (CODE-VERIFIED + LIVE-VERIFIED for ingredient form path)**
  Two entry paths landed:
  - **Ingredient form (EXPIRY · spec 010 section)**: `src/components/cmd/IngredientForm.tsx:464-495` adds `defaultShelfLifeDays` (brand-level, writes to `catalog_ingredients`) and `expiryDate` (per-row, writes to `inventory_items`). `IngredientFormDrawer.tsx:125-148` wires the save handler. Live Probe 1 (main Claude) confirms "Dish Detergent `default_shelf_life_days=5`, `expires=2026-05-09` → Saved toast → drawer closed" round-trip.
  - **Receiving screen auto-stamp**: `src/screens/cmd/sections/ReceivingSection.tsx:122-138` extends `commitReceive` to call `computeExpiryFromShelfLife` and `updateItem({ expiryDate })` when the row has no current expiry and the catalog row has a non-null `defaultShelfLifeDays`. Live Probe 2 code path is present; browser walk not completed (receiving screen is a Tier-1 mock, architect §0 documented limitation). See Notes.

- **AC3**: `computeAttentionQueue` gains a new `expiry` alert type with High (<24h) / Med (24-72h) / Low (72h-7d) severity buckets; items beyond 7d not surfaced; aggregate text `"X items expiring <Yh, $Z at risk"` per bucket → **PASS (CODE-VERIFIED + LIVE-VERIFIED)**
  - `src/lib/cmdSelectors.ts:860-918` implements the rule. Severity buckets: `EXPIRY_HIGH_HOURS=24`, `EXPIRY_MED_HOURS=72`, `EXPIRY_LOW_HOURS=168` (lines 684-686). Bucket assignment at lines 892-895.
  - Date parsing uses local-time construction (`new Date(+m[1], +m[2]-1, +m[3], 23, 59, 59, 999)`) correctly avoiding UTC-midnight double-shift. Node REPL verification: same-day expiry at 9am → `+15h` (HIGH bucket, correct); next-day expiry at 9am → `+39h` (MED bucket, correct); expired 1 day ago → `-9h` (HIGH bucket, correct per spec §3 "already expired rolls into high"); 8 days out → `207h > 168h` (skipped, correct).
  - Queue text format: `src/lib/cmdSelectors.ts:910,914` — singular/plural noun, `Math.round` on dollar, `<24h`/`<72h`/`<7d` labels. Live Probe 3 confirmed "1 item expiring <72h, $0 at risk" at ~36h with MED severity.
  - Per-store scoping: `storeInventory = inventory.filter(i => i.storeId === storeId)` at line 768, used at line 877. Live Probe 3 confirmed other stores show no alert.

- **AC4**: Drill-down view shows per-item list (item name, store, days/hours to expiry, dollar at risk = `currentStock × costPerUnit`) → **PASS (CODE-VERIFIED + LIVE-VERIFIED)**
  - `src/components/cmd/ExpiringItemsModal.tsx` (new file) renders: header with `storeName` + sev `StatusPill` + close X; subhead (item count + total at risk); per-item table columns (ITEM / EXPIRES IN / UNIT / $ AT RISK); footer with "read-only · close to navigate manually · esc to close". Dollar at risk computed as `currentStock × costPerUnit` at `cmdSelectors.ts:900`. `formatHours()` at ExpiringItemsModal.tsx:313-327 renders human labels including "expired N days ago" for negative hours.
  - `DashboardSection.tsx:869-873` wraps only `rule === 'expiry'` rows in `TouchableOpacity`; other alert types stay click-inert per architect §9 flag #2.
  - Live Probe 4 confirmed modal opens with correct content: "Expiring soon · Charles · MED · ×", "1 item · $0.00 at risk", per-item table with Dish Detergent row.

- **AC5**: Migration adds the schema element (additive, idempotent, RLS via `auth_can_see_store()`) → **PASS (CODE-VERIFIED)**
  - `supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql` adds `default_shelf_life_days int` to `catalog_ingredients` with `add column if not exists` (idempotent). The column has no DEFAULT (nullable), meaning zero row rewrites on PG 17.
  - RLS: no new policy required. `catalog_ingredients` already has brand-scoped read/write/update/delete policies from `20260504073942_brand_catalog_p5_rls.sql:200-224`. `inventory_items` already has per-store policies via `auth_can_see_store()` from `20260504173035_per_store_rls_hardening.sql:46-61`. Adding a column does not require a policy change — existing row-scoped policies gate writes to every column on the row.
  - Migration applied locally (build notes confirm post-apply verification: `column_name=default_shelf_life_days, data_type=integer, is_nullable=YES`).

- **AC6**: `computeAttentionQueue` extended without forking; Spec 009 Q4b (no server-computed endpoint) holds → **PASS (CODE-VERIFIED)**
  There is exactly one `computeAttentionQueue` function at `cmdSelectors.ts:719`. The expiry rule is inserted as a new block between `unconfirmed_po` and the final sort (lines 860-918). No new edge function. Alert derives entirely from `useStore.inventory[]` (already loaded per-store).

- **AC7**: Standard project conventions — `src/lib/db.ts` for reads/writes, optimistic-then-revert with `notifyBackendError`, no touch on `AdminScreens.tsx`/legacy stores/`app.json` slug → **PASS (CODE-VERIFIED)**
  - No direct `supabase.*` calls in any new frontend files (IngredientFormDrawer, ExpiringItemsModal, DashboardSection, ReceivingSection — verified via grep).
  - `updateCatalogIngredient` in `useStore.ts:480-490`: snapshots prev, mutates local, calls `db.updateCatalogIngredient`, reverts + `notifyBackendError('Update catalog ingredient', e)` on failure.
  - `updateItem` in `useStore.ts:406-418`: confirmed optimistic-then-revert pattern with `notifyBackendError('Update item', e)` — used by ReceivingSection auto-stamp path.
  - `git status` shows no changes to `src/screens/AdminScreens.tsx`, `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`, `db.json`, or `app.json`.

## Test run

No test runner exists in this repo. Verification was performed via:

1. **Code inspection** — all spec010 files read in full.
2. **Node REPL math proofs** — bucket boundary arithmetic and `computeExpiryFromShelfLife` edge cases verified (null/undefined/negative/NaN/garbage-date/0/3/5 days/full ISO input — all 8 cases produce correct output).
3. **TypeScript typecheck** (`npx tsc --noEmit`) — zero errors in any spec010 file. Pre-existing errors in `src/store/useStore.ts` (lines 285, 373, 380, 1082, 1183), `src/screens/AdminScreens.tsx`, `src/components/IngredientEditor.tsx`, `src/navigation/AppNavigator.tsx`, and `scripts/test-unit-conversion.ts` are all pre-spec-010 (verified against commit `5fa63d3` baseline; spec010 changes to useStore.ts are confined to the `updateCatalogIngredient` action at lines 476-491 and the `CatalogIngredient` import, neither of which introduce new errors).
4. **Live browser evidence** (conducted by main Claude against `admin@local.test / password` on local stack):
   - Probe 1: shelf-life round-trip — VERIFIED (Dish Detergent, `default_shelf_life_days=5`, save toast fired)
   - Probe 3: dashboard alert at <72h — VERIFIED (Charles store, MED severity, "1 item expiring <72h, $0 at risk")
   - Probe 4: modal open from alert click — VERIFIED (correct header, subhead, per-item table, footer)
   - Probe 5 (reset clears alert): code path trivially follows from setting `expiryDate=null` → `storeInventory` filter skips nulls at `cmdSelectors.ts:878`. Not live-tested.
   - Probe 2 (receive-time auto-stamp): code verified (ReceivingSection.tsx:129-138); live walk not completed because Receiving is a Tier-1 mock and the synthesized line-items table cannot represent a "fresh" delivery to observe the auto-stamp side effect. The `computeExpiryFromShelfLife` helper + `updateItem` call are correctly wired.

## Notes

### Coverage gaps (manual, not blocking)

The following §8 verification probes were not live-exercised. None represent missing code — they are untested runtime paths for variant bucket scenarios:

- **High severity (<24h) bucket**: Only the MED bucket (~36h) was live-verified (Probe 3). High bucket fires at `hoursToExpiry <= 24` — code is correct per math proof but not browser-walked.
- **Low severity (72h-7d) bucket**: Not live-exercised.
- **Multiple items in same bucket**: Only 1 item was present in the live test. Aggregate text format `"3 items expiring <72h, …"` was not browser-confirmed (though the `noun = items.length === 1 ? 'item' : 'items'` logic at line 910 is straightforward).
- **Beyond-7d exclusion**: Not live-tested with a 8d+ test row. The `hoursToExpiry > EXPIRY_LOW_HOURS` guard at line 891 is code-verified.
- **Probe 5 (reset/null clears alert)**: follows trivially from the null-guard at line 878 but not browser-walked.
- **Cross-store RLS (Probe 10)**: The `storeInventory` filter at line 768 is per-store by `storeId`; probe 3 live evidence already confirmed other stores showed no alert. Full non-admin RLS denial for the PostgREST layer was not separately tested for the `default_shelf_life_days` column specifically, but RLS policies are brand-scoped at the row level and no new policy surface was added.

### Receiving screen limitation (architect §9 flag #1)

The Receiving screen auto-stamp (AC2, second path) fires only when `!item.expiryDate` and the catalog row has a non-null `defaultShelfLifeDays`. Because Receiving is a Tier-1 mock with no `po_items` table, there is no way to present a "fresh" receive for an item that already has an `expiryDate` set — it would skip the stamp. This is the documented architect limitation, not a bug. The spec's PM lean was "both paths"; the narrowed A2=(c) shape is acceptable for v1 per architect §9.

### Boundary: "exactly 7d" exclusion

Items expiring at end-of-day exactly 7 calendar days from now compute to ~183h (7d + remaining hours of today), which exceeds `EXPIRY_LOW_HOURS=168`. These items are not surfaced. The spec says "within 72h-7d" for LOW, so items "in exactly 7 days" being excluded is arguably a tight boundary. This is not flagged as a defect — it matches the "items beyond 7d not surfaced" AC text and the architect's stated intent — but it means an item expiring at EOD on the 7th day will not appear until it crosses the 168h mark.

### Pre-existing TypeScript errors

`npx tsc --noEmit` shows errors in `src/store/useStore.ts:285,373,380,1082,1183`, `AdminScreens.tsx`, `IngredientEditor.tsx`, `AppNavigator.tsx`, and `scripts/test-unit-conversion.ts`. All are pre-existing (present in baseline commit `5fa63d3`). The spec010 changes to useStore.ts introduce zero new type errors. The pre-existing errors are not part of this spec's scope.

### Test framework (reiteration)

`computeAttentionQueue` accepts an injectable `now: Date` parameter (line 728) specifically to enable deterministic unit tests. The expiry rule body, all three bucket boundaries, the singular/plural grammar, and `computeExpiryFromShelfLife` are all pure functions with no external dependencies — highly testable without any DB or UI. This recommendation has been surfaced in prior specs. No test framework exists in this repo; introducing one requires explicit user approval per project policy.
