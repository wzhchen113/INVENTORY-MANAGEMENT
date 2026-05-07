# Test report for spec 004 (fix-pass re-review)

Re-review date: 2026-05-06. Fix-pass items verified against code at HEAD.
Prior report superseded by this file.

---

## Acceptance criteria status

### Form behavior

**AC-F1: Category field renders as a dropdown selector populated from `ingredient_categories`. It is no longer a free-text input.**
→ CODE-VERIFIED (unchanged from prior). `IngredientForm.tsx:288` reads `useStore((s) => s.ingredientCategories)` (typed selector, no cast). `SelectField` at lines 396-405 renders the options. No regression.

**AC-F2: Default unit renders as a dropdown selector. Source = canonical hardcoded units ∪ distinct `purchase_unit` values across `ingredient_conversions`.**
→ CODE-VERIFIED (improved from prior). `IngredientForm.tsx:297-312` builds `defaultUnitOptions` via `c.purchaseUnit` (camelCase only — the prior `c.purchaseUnit || c.purchase_unit` snake_case fallback is gone, closing Should-fix item 5). `allConversions` is now typed `IngredientConversion[]` from a properly-typed store slice. No regression.

**AC-F3: Pack unit renders as a dropdown. Selecting a non-canonical unit prompts user to define its physical meaning.**
→ CODE-VERIFIED (unchanged from prior). `IngredientForm.tsx:314-326` restricts pack-unit to canonical units with a non-canonical disabled sentinel. Warning link at lines 367-375. Carve-out for `each` at line 369 is now documented inline (per code-reviewer nit). No regression.

**AC-F4: Primary vendor renders as a dropdown of `vendors` rows for the current brand. Saving persists `vendor_id`.**
→ CODE-VERIFIED (unchanged from prior). `IngredientFormDrawer.tsx:47-48` writes both `vendorId` and `vendorName`. `toUpdates()` mapper is unchanged. No regression.

**AC-F5: Pack size numeric input accepts digits and one decimal point only — no letters, no other characters.**
→ CODE-VERIFIED + REGEX-VERIFIED (improved from prior — was UNVERIFIED).

  The fix-pass introduced `src/utils/validators.ts` with a tightened regex: `/^(\d+\.?\d*|\d*\.\d+|)$/`. This closes the security-auditor M2 gap where the old `/^\d*\.?\d*$/` accepted the lone `"."` character (which `parseFloat` maps to NaN, then `|| 0` silently writes zero to the DB).

  Verification of the new regex per the release-proposal's test cases:
  - `NUMERIC_RE.test('a')` → false (letters rejected) — VERIFIED by main Claude
  - `NUMERIC_RE.test('-1')` → false (negatives rejected) — VERIFIED by main Claude
  - `NUMERIC_RE.test('1.2.3')` → false (double-dot rejected) — VERIFIED by main Claude
  - `NUMERIC_RE.test('.')` → false (lone dot rejected) — VERIFIED by main Claude. This is the new fix.
  - `NUMERIC_RE.test('1.5')` → true, `NUMERIC_RE.test('.5')` → true, `NUMERIC_RE.test('')` → true (empties allowed) — logically correct from regex structure.

  `IngredientForm.tsx` imports `isNumericInput` from `validators.ts` (line 8). `InventoryCatalogMode.tsx` imports `NUMERIC_RE` from `validators.ts` (line 21). De-duplication complete; single source of truth.

  Live keystroke rejection in browser was not driven through synthetic events in this review cycle (same caveat as prior). The regex is the only gatekeeper on the change handler; its correctness is established above.

**AC-F6: When the user saves the form, all four dropdown selections persist and survive a reload.**
→ VERIFIED (was UNVERIFIED in prior report). Main Claude ran the full save-then-reload cycle: opened Dish Detergent in EDIT mode, changed Category from "Cleaning Supplies" to "Dry goods" and Default Unit from "each" to "lbs", clicked SAVE → toast "Saved: Dish Detergent" → drawer closed → hard browser reload → reopened EDIT → both values persisted as Dry goods/lbs. The `subUnitUnit` slot and vendor also persisted unchanged.

  Code path is unchanged: `toUpdates()` → `updateItem` → `db.updateInventoryItem` → writes `catalog_ingredients.category`, `catalog_ingredients.unit`, `catalog_ingredients.sub_unit_unit`, `inventory_items.vendor_id`. `fromItem()` reads all four back on re-open.

**AC-F7: Save with any required dropdown left empty is blocked with a Toast error.**
→ VERIFIED (was NOT TESTED / FAIL in prior report). The fix-pass removed `disabled={!requiredValid}` from the SAVE button (`IngredientFormDrawer.tsx:221` is now a plain `TouchableOpacity` with no `disabled` prop). The comment at lines 217-220 explains the intent explicitly. Main Claude verified: clicking CREATE on an empty + NEW INGREDIENT form fires "Required field missing" toast, drawer stays open.

  The Toast handler at `handleSave` lines 101-105 is now reachable — the button is always clickable. The spec criterion "blocked with a Toast error" is now precisely met.

**AC-F8: `packUnit` save-bug closed. Form mapper no longer drops the pack-unit choice.**
→ CODE-VERIFIED (unchanged from prior). `subUnitUnit` field name is consistent throughout. No regression.

---

### Categories admin section

**AC-C1: `CategoriesSection.tsx` exists at `src/screens/cmd/sections/CategoriesSection.tsx` and is wired into `InventoryDesktopLayout.tsx`.**
→ CODE-VERIFIED (unchanged from prior). No regression.

**AC-C2: The section lists every `ingredient_categories` row with create / rename / delete actions, modeled on the legacy modal pattern.**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior). No regression.

**AC-C3: Delete is blocked if any `inventory_items.category` (or `catalog_ingredients.category`) row references the name. Toast on conflict.**
→ PARTIAL CODE-VERIFIED (same status as prior — not addressed in fix-pass).

  `CategoriesSection.tsx:85` still checks `inventory.filter((i) => i.category === name)` against `useStore(s => s.inventory)`. It does NOT directly check `useStore(s => s.catalogIngredients)`. The fix-pass explicitly did not address this gap (per the release proposal, it was not listed as a required fix item).

  The comment at `CategoriesSection.tsx:30-32` now documents the limitation: "Counts are read-only and don't include catalog-only matches; the delete blocker uses `inventory` because that's the primary FK source." This is honest self-documentation but does not resolve the underlying gap.

  The disabled-vs-toast divergence from the prior report IS fixed: the DELETE button is no longer `disabled` — `handleDelete` fires on click and surfaces the Toast (lines 88-92) when count > 0. The comment at lines 224-228 explains this explicitly.

  The GAP-3 standing concern (catalog-only ingredients bypassing the block for multi-store scenarios) is unchanged. For single-brand 2AM PROJECT deployment, `s.inventory` items carry `.category` from the `catalog_ingredients` join, so the check is effective in practice.

**AC-C4: Realtime — when one admin client changes a category, other admin clients see the change after the 400ms debounced reload.**
→ NOT TESTED (same status as prior — not addressed in fix-pass and not regressed).

  `ingredient_categories` is not in `useRealtimeSync.ts`. Design §4 explicitly deferred this. A second browser session would not see category changes until manual reload. The design decision is documented in the spec. No change in this pass.

---

### Conversions write UI

**AC-V1: `CatalogConversionsTab` gains add/edit/delete actions for `ingredient_conversions` rows.**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior). No regression.

**AC-V2: Add row UI: pick purchase_unit, base_unit, enter conversion_factor, optional net_yield_pct. Save creates a row.**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior).

  Additional fix in this pass: `net_yield_pct` input now validates range (0, 100] with a Toast on out-of-range instead of silently coercing (lines 641-653). Empty input still defaults to 100. No regression on add path.

**AC-V3: Edit row UI updates the same shape; delete removes the row.**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior).

  Same range-check fix applied to edit path at lines 692-701. `updateIngredientConversion` store action now applies the server's returned row to state (`.then((saved) => set(...))`) instead of discarding the return value. No regression.

**AC-V4: All writes route through `db.ts` and `useStore.ts`. No direct Supabase calls from components.**
→ CODE-VERIFIED (unchanged from prior). No regression.

**AC-V5: Numeric-only validation on `conversion_factor` and `net_yield_pct` (regex `^\d*\.?\d*$`).**
→ CODE-VERIFIED (improved — regex tightened and de-duplicated to `validators.ts`). `InventoryCatalogMode.tsx:562` uses `NUMERIC_RE` from `validators.ts`. The pattern now rejects the lone `"."`. No regression.

---

### Units admin (Q1 = no)

**AC-U1 (Q1=no branch): No new `units` table. Default-unit and pack-unit dropdowns source from `unitConversion.ts` constants ∪ distinct `purchase_unit` values from `ingredientConversions`.**
→ CODE-VERIFIED (unchanged from prior). No regression.

---

### Vendor dropdown

**AC-VD1: Vendor field in the ingredient form is a dropdown of `vendors` rows for the current brand (filtered by `brand_id`).**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior). No regression.

**AC-VD2: Selecting a vendor persists `inventory_items.vendor_id`. The form's free-text `vendorName` input is removed.**
→ CODE-VERIFIED (unchanged from prior). No regression.

**AC-VD3: No new vendor admin section added. Dropdown opens `VendorFormDrawer` and refreshes on save.**
→ CODE-VERIFIED + VERIFIED (browser by main Claude, unchanged from prior). No regression.

---

### Migration of existing free-text data

**AC-M1: Migration creates missing `ingredient_categories` rows from distinct existing values, collapsed via `lower(trim())`.**
→ CODE-VERIFIED (unchanged from prior). No regression.

**AC-M2 (Q1=no, skip): No units table backfill needed.**
→ N/A (unchanged).

**AC-M3: No existing ingredient row is left with a category/unit value that doesn't resolve after migration.**
→ CODE-VERIFIED via probe (unchanged from prior). No regression.

---

### Costing / cost-calc invariant

**AC-CC1: §10 "Probe results" section populated by backend-dev with real numbers.**
→ VERIFIED (unchanged from prior). No regression.

**AC-CC2: Cost-calc invariant probe ran and produced identical pre/post numbers.**
→ VERIFIED (unchanged from prior). The fix-pass touched `validators.ts`, `InventoryCatalogMode.tsx` (yield range clamping), and `useStore.ts` (typing and `updateIngredientConversion` return handling) but did not alter the cost-calc logic. Delta = 0 result stands.

**AC-CC3: If probe shows a delta, migration is invalid.**
→ VERIFIED — delta = 0, gate passes. No regression.

**AC-CC4: No changes to `recipe_ingredients.unit`, `prep_recipe_ingredients.unit`, `recipe_prep_items.unit`.**
→ CODE-VERIFIED via grep (unchanged from prior). No regression.

---

### Realtime

**AC-RT1 (Q1=yes branch): Units added to realtime publication.**
→ N/A (Q1=no, unchanged).

**AC-RT2: `ingredient_conversions` realtime status confirmed; if not in publication, add it.**
→ CODE-VERIFIED (unchanged from prior). No regression.

---

### Permissions

**AC-P1: Lookup CRUD endpoints/policies enforce `auth_is_admin()`. Read access matches existing patterns.**
→ CODE-VERIFIED (improved — was CODE-VERIFIED/PARTIAL in prior cycle).

  Migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` closes the inherited security-auditor High finding. The old permissive `auth_manage_ingredient_categories` policy (`for all ... using (auth.uid() is not null)`) is dropped and replaced with:
  - SELECT: `using (auth.uid() is not null)` — any authenticated user can read (preserves legacy `IngredientsScreen.tsx` read path)
  - INSERT: `with check (public.auth_is_admin())`
  - UPDATE: `using (public.auth_is_admin()) with check (public.auth_is_admin())`
  - DELETE: `using (public.auth_is_admin())`

  The migration is idempotent (all drops are `if exists`). `ingredient_conversions` and `vendors` policies were already tightened in Phase 5 and are unchanged. All three lookup tables now have consistent split-policy shape: authenticated read, admin write.

  NOTE: The new migration has not been applied locally and verified via `pg_policies` query in this review — that would require hitting the live local Supabase stack (no test runner exists). The migration SQL is mechanically correct (idiomatic copy of the P5 pattern from `20260504073942_brand_catalog_p5_rls.sql:176-198`). Verifying application and policy rows via a local `psql` query is the recommended final step before commit.

---

## Coverage gaps status after fix-pass

The prior report identified 5 gaps. Status of each after the fix-pass:

**GAP-1 (was UNVERIFIED — AC-F6 save-then-reload round-trip)** → VERIFIED.
Main Claude completed the full cycle: EDIT Dish Detergent, changed Category + Default Unit, SAVE, reload, reopen — both fields persisted. The headline AC for this spec is now verified.

**GAP-2 (was UNVERIFIED — AC-F5 numeric letter rejection)** → REGEX-VERIFIED (elevated from UNVERIFIED).
Main Claude verified the new shared regex via JS console for all four rejection cases plus the new lone-dot case. The regex is the only keystroke gatekeeper. Live browser keystroke testing via synthetic events remains impractical without a UI test runner, but the regex correctness is established.

**GAP-3 (was PARTIAL — AC-C3 delete-block checks `s.inventory` not `s.catalogIngredients`)** → PARTIAL (unchanged).
Not addressed in fix-pass. The comment in `CategoriesSection.tsx:30-32` now documents the limitation. The disabled-vs-toast divergence in the delete button IS fixed. For single-brand 2AM PROJECT deployment the check is effective in practice (inventory items carry `.category` from the catalog join). Remains a gap for multi-store scenarios. Standing item, not a blocker for single-tenant ship.

**GAP-4 (was UNVERIFIED — AC-C4 cross-client realtime for `ingredient_categories`)** → NOT TESTED (unchanged).
Not addressed in fix-pass. Design §4 deliberately deferred adding `ingredient_categories` to the realtime channel. The AC as written in the spec is not met for a second browser session. The design decision is documented. Not a regression; same status as prior.

**GAP-5 (was FAIL / dead Toast code — AC-F7 SAVE disabled instead of toast)** → VERIFIED (resolved).
Fix-pass removed `disabled={!requiredValid}` from the SAVE button. The Toast handler at `handleSave:102-104` is now reachable. Main Claude verified the toast fires on an empty-form CREATE attempt. Both the categories DELETE button and the SAVE button are now toast-gated rather than disabled-gated, consistently matching the spec.

---

## New gaps introduced by fix-pass

**NEW-GAP-1 (Nit — residual `(c: any)` at `useStore.ts:1288`):**
The three Criticals from the code-reviewer were all fixed: `IngredientConversion[]` is now non-optional in `AppState`, the `(s: any)` selectors in `InventoryCatalogMode.tsx` are gone, and the `(c: any)` and dead `c.catalogId` branch at `InventoryCatalogMode.tsx:590` are gone. However, a separate stale `(c: any)` cast at `useStore.ts:1288` (cost-calc fallback path) was not cleared. Since `allConversions` is now typed `IngredientConversion[]`, this cast is unnecessary but harmless — TypeScript can verify `c.inventoryItemId` without it. This is a nit, not a regression or Critical.

**NEW-GAP-2 (Observation — no double-submit guard on SAVE button):**
Removing `disabled={!requiredValid}` from the SAVE button means a user can click SAVE multiple times before the Modal close animation completes. In EDIT mode, `handleSave` calls `onClose()` immediately (line 109), and the drawer closes after `updateItem` is dispatched — the optimistic update fires once, then the drawer closes and `useEffect` at line 76-78 resets state. A second click before the animation clears could issue a second `updateItem` call. In NEW mode, same sequence with `addItem`. In practice the animated Modal fade (default ~300ms) is fast and a human double-click would have to be very rapid. No debounce guard exists. This is a low-severity UX observation, not a Critical. The prior code's `disabled={!requiredValid}` incidentally prevented double-submission when fields were invalid; it provided no protection when fields were valid. So the net change in safety is neutral for the valid-fields path and a minor regression only for the now-impossible disabled-state path.

**NEW-GAP-3 (Observation — RLS migration not verified locally via `pg_policies` query):**
Migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` is present and syntactically correct. Local application and confirmation via `SELECT policyname FROM pg_policies WHERE tablename = 'ingredient_categories'` was not performed in this review (no test runner; would require hitting `npm run dev:db`). The migration SQL is a mechanical copy of the established P5 pattern and is idempotent. Recommend confirming application before commit.

---

## Summary of gap status across all ACs

| Gap | Prior status | Fix-pass status |
|-----|-------------|-----------------|
| GAP-1 (AC-F6 save-then-reload) | UNVERIFIED | VERIFIED |
| GAP-2 (AC-F5 keystroke rejection) | UNVERIFIED | REGEX-VERIFIED |
| GAP-3 (AC-C3 catalog-check) | PARTIAL | PARTIAL (unchanged) |
| GAP-4 (AC-C4 cross-client realtime) | NOT TESTED | NOT TESTED (unchanged) |
| GAP-5 (AC-F7 disabled vs toast) | FAIL | VERIFIED |

Gaps 3 and 4 remain open but are design decisions, not regressions. Both are documented.

---

## Code-reviewer Criticals: resolution status

All three Criticals from the prior code-reviewer report are resolved in the fix-pass:

1. **`ingredientConversions` typed as `[] as any[]`** → fixed. `AppState.ingredientConversions` is `IngredientConversion[]` (non-optional) in `types/index.ts:381`. Initial value at `useStore.ts:190` is `[] as IngredientConversion[]`.

2. **`(s: any)` selectors at `InventoryCatalogMode.tsx:578-580`** → fixed. All three selectors are now typed (no cast). `allConversions`, `addIngredientConversion`, `updateIngredientConversion`, `deleteIngredientConversion` all typed from the store.

3. **`(c: any)` cast and dead `c.catalogId` branch at `InventoryCatalogMode.tsx:590`** → fixed. Line 594 is now `allConversions.filter((c) => ids.has(c.inventoryItemId))`. The dead `c.catalogId` branch is gone; `r.catalogId` (correct field on `InventoryItem`) is used instead at line 591.

A residual `(c: any)` at `useStore.ts:1288` is a pre-existing stale cast unrelated to the three Criticals — it is a nit.

---

## Security-auditor High: resolution status

The `ingredient_categories` RLS gap (High finding) is closed by migration `20260507015244_spec004_ingredient_categories_rls_p6.sql`. The permissive any-authed-user write policy is replaced with admin-gated INSERT/UPDATE/DELETE. Read access for authenticated users is preserved. Legacy `IngredientsScreen.tsx` read path is unaffected. Staff app and customer PWA sessions can no longer write/rename/delete global ingredient categories.

---

## Test run

No automated test suite exists on this project. Verification is manual (browser by main Claude) and static code review (by this agent). There is no `npm test` command to run.

---

## Notes

- The spec's "Probe results" section (§10) is fully populated — gate satisfied.
- The cost-calc invariant probe (§9) recorded delta = 0 across all three representative ingredients. Gate passes; fix-pass did not alter cost-calc logic.
- Q1=no (no units table). AC-RT1 and AC-U1 conditional branches remain N/A.
- Migration timestamps `20260507010946`, `20260507010947`, and `20260507015244` — sequential, no conflicts.
- No edge function changes, no changes to `AdminScreens.tsx`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, or `db.json`. All hard rules honored.
- The `(s: any)` cast at `useStore.ts:289` is in the EOD submission mapper (`(s: any) => ({ ... })`) — pre-existing, unrelated to spec 004, and not part of the Criticals. Not addressed in fix-pass; not a regression.

---

## Recommendation on test framework standardization

Standing recommendation (fourth spec, unchanged): Playwright (web) + Jest for unit/integration. Rationale: the Cmd UI runs on web via `expo export --platform web`; Playwright can drive it against the local Supabase stack (`npm run dev:db`) with no mocking. Save-then-reload cycles (AC-F6, now verified manually), keystroke rejection (AC-F5, regex-verified), and toast-vs-disabled behavior (AC-F7, now verified manually) are all Playwright-coverable. Cost-calc invariant and RLS allow/deny tests should be Jest tests hitting the real local DB. This is a standing ask, not a blocker for this spec.
