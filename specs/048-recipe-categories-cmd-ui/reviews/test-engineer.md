## Test report for spec 048 (re-review after SF1/SF2/SF3)

### Acceptance criteria status

#### Surface placement & shape
- AC1: A new "categories" tab is added to RecipesSection's existing TabStrip (no new sidebar item) → PASS — `RecipesSection.tsx:292-300` branches on `tabId === 'categories.tsx'` and renders `<RecipeCategoriesSection />` with the TabStrip. The `categories.tsx` entry is in `RECIPE_TABS` (line 37). No top-level sidebar entry added.
- AC2: Categories tab renders a single scrollable list with inline "+ ADD" form and per-row edit/delete affordances, mirroring CategoriesSection → PASS — Verified in `RecipeCategoriesSection.tsx`. The jest render test (`RecipeCategoriesSection — render`) confirms rows are visible.

#### List rendering
- AC3: Each row shows canonical name, per-locale i18n overrides where present, and a combined usage count (recipes + prep_recipes), case-sensitive, single integer → PASS — `useMemo` at lines 51-75 computes `recipeUsageCount + prepRecipeUsageCount = totalUsageCount`; that integer is rendered at line 421. Test: `RecipeCategoriesSection — render` asserts `'3 uses'` (2 recipes + 1 prep) and `'0 uses'` (Entrées with no usage).
- AC4: Rows ordered by current-locale name via localeCompare → PASS — `.sort((a, b) => a.label.localeCompare(b.label, locale))` at line 74. The `useLocale` mock pins to `'en'` in tests for determinism.

#### Create (+ ADD)
- AC5: Inline "+ ADD" form with translateOnSave auto-fill (hybrid blur-or-debounce, AbortController) → PASS — `scheduleNewTranslate`, `handleNewBlur`, and `fetchTranslations` implement this; `translateOnSave` is mocked in tests to prevent DeepL calls.
- AC6: Submitting calls `useStore.addRecipeCategory(name, i18nNames?)` with no competing try/catch around the store action → PASS — `handleAdd` at line 148 calls `addRecipeCategory(name, i18n)` bare. The only `try/catch` in the file is inside `fetchTranslations` (the DeepL helper), not around any store action. Test: `RecipeCategoriesSection — add` asserts `addRecipeCategory` called with `'Desserts', {}`.

#### Rename / translate
- AC7: Per-row edit calls `useStore.updateRecipeCategory(oldName, newName, i18nNames?)` → PASS — `saveEdit` at line 209 calls `updateRecipeCategory(oldName, next, i18n)` when name changed. Test: `RecipeCategoriesSection — rename` asserts `updateRecipeCategory('Sauces', 'Condiments', { es: 'Salsas' })`.
- AC8: Rename does NOT rewrite recipes.category / prep_recipes.category rows → PASS by design — the section calls `updateRecipeCategory` which (per the architect's note at spec §6) does not cascade server-side. No cascading write is issued from the component.

#### Delete — block on use
- AC9: Positive case (0 usage) — delete invokes confirmAction then calls `deleteRecipeCategory(name)` → PASS — `handleDelete` checks `total > 0`; on false path calls `confirmAction(...)` which in tests is mocked to auto-confirm. Test: `RecipeCategoriesSection — positive delete` asserts `deleteRecipeCategory` called once with `'Unused'`, and no error toast fired.
- AC10: Negative case (>0 usage) — delete affordance blocks before any DB call, surfaces toast `"Used by N recipes / M prep recipes — cannot delete."` with both N and M numbers → PASS — `handleDelete` at line 240 returns early after calling `Toast.show` with both counts. Test: `RecipeCategoriesSection — negative delete` asserts `deleteRecipeCategory` NOT called, `Toast.show` called with `type: 'error'` and `text2` containing both `'2'` and `'3'` (not just the sum 5). The test additionally asserts via `stringMatching(/2.*3|recipes.*2.*preps.*3/)`.
- AC11: Block-on-use check uses the same source as the displayed column (no second source of truth) → PASS — `handleDelete` reads from `sorted.find(...)` at line 236, the same memo that produces the per-row `totalUsageCount` for display. SF3: `total` is read as `row?.totalUsageCount ?? 0` directly (line 239), not re-summed from the split counts.

#### Errors & realtime
- AC12: Backend errors on add/update/delete surfaced via notifyBackendError toast (handled by the store, section adds no competing error handling) → PASS — the section's delete/add/rename call paths are bare store-action invocations with no wrapping try/catch.
- AC13: No realtime channel subscription added → PASS — no `supabase.channel`, `subscribe`, or `useRealtimeSync` import anywhere in `RecipeCategoriesSection.tsx`.

#### Platform parity
- AC14: Web + native parity in line with CategoriesSection → PASS — uses `Platform.OS === 'web'` conditional for `outlineStyle` on TextInput (same pattern as CategoriesSection); otherwise uses RN primitives.

### Test run

Command: `npm test -- --ci`

```
PASS component src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx
PASS unit src/i18n/i18n.test.ts
PASS unit src/utils/relativeTime.test.ts
PASS component src/components/cmd/IngredientForm.test.ts
PASS unit src/store/useStore.test.ts
PASS component src/components/cmd/StatusPill.test.tsx
PASS unit src/utils/enumLabels.test.ts
PASS unit src/lib/translate.test.ts
PASS unit src/i18n/localizedName.test.ts
PASS unit src/lib/auth.test.ts
PASS unit src/utils/userPermissions.test.ts
PASS unit src/utils/reportParams.test.ts
PASS unit src/utils/escapeHtml.test.ts
PASS unit src/utils/seedVarianceDates.test.ts

Test Suites: 14 passed, 14 total
Tests:       168 passed, 168 total
Snapshots:   0 total
Time:        1.004 s
Ran all test suites in 2 projects.
```

RecipeCategoriesSection: 5/5. i18n catalog parity: all 38 assertions pass. Full suite: 168/168.

### SF1/SF2/SF3 verification

**SF1 (DRY tabs array)** — VERIFIED. `RECIPE_TABS: Tab[]` declared once at module level (`RecipesSection.tsx:32-38`). All three `TabStrip` instances use `tabs={RECIPE_TABS}` at lines 295, 309, and 322. No inline literal array at any call site.

**SF2 (TabStrip reachable from empty-selection state)** — VERIFIED. The `!sel` branch at `RecipesSection.tsx:301-318` renders `<TabStrip tabs={RECIPE_TABS} activeId={tabId} onChange={setTabId} />` before the "select a recipe" message. The `setTabId` setter is the same `React.useState` setter shared by the other two branches. Branch evaluation order (`tabId === 'categories.tsx'` checked before `!sel`) ensures that once the user clicks the categories tab the next render routes to the categories branch regardless of selection state.

**SF3 (single source for `total` in `handleDelete`)** — VERIFIED. `handleDelete` reads `row?.totalUsageCount ?? 0` at line 239. The guard uses `total` (line 240). The split counts (`recipeUsageCount`, `prepRecipeUsageCount`) are read from the same `row` object for the toast body but are not re-summed into `total`. All three display surfaces (column, guard, toast) share one computed value from the `sorted` memo.

### SF2 test coverage decision

No new jest test for the empty-selection → categories tab navigation flow in `RecipesSection.tsx`. Reasoning:

1. The SF2 fix is 7 lines of pure JSX using the existing `setTabId` setter. There is no custom logic: clicking the tab fires `onChange={setTabId}`, `tabId` updates, the next render hits `tabId === 'categories.tsx'` first (branch evaluated before `!sel`). This is standard React state semantics requiring no proof.
2. `RecipesSection` has no existing test file. Building one from scratch to cover this single branch would require mocking 13+ store selectors (`recipes`, `prepRecipes`, `recipeCategories`, `inventory`, `currentStore`, `getRecipeCost`, `getRecipeFoodCostPct`, `getIngredientLineCost`, `getPrepRecipe`, `getPrepRecipeCostPerUnit`, `deleteRecipe`, `posImports`, `recipeCategories`) plus `useRole`, `useLocale`, `useT`, `confirmAction`, `RecipeFormDrawer`, `FilterInput`, and the `useCmdColors` / typography tokens. Mock surface cost is disproportionate to the coverage value.
3. The categories behavior once the tab is active is fully covered by the existing 5 `RecipeCategoriesSection` tests.
4. The spec's own re-review section acknowledges static JSX verification is the appropriate tier here: "the in-process preview tool surface was not exposed in this session … the SF2 fix was verified statically — the JSX path now renders `<TabStrip tabs={RECIPE_TABS} activeId={tabId} onChange={setTabId} />` … and `setTabId` is the same setter used by the other two branches."

The release-coordinator may want to record a follow-up: if a `RecipesSection` test file is ever created (e.g., to cover the recipe list filtering logic), it should add the SF2 scenario at that time. It is not a blocker.

### Notes

1. **No competing try/catch confirmed.** The only `try/catch` in `RecipeCategoriesSection.tsx` guards the `translateOnSave` DeepL helper, not any store action. AC6 satisfied.

2. **i18n key parity verified.** All three locales (en/es/zh-CN) carry identical 22 `section.recipes.categories.*` keys. The `i18n.test.ts` `flattenKeys` parity assertion auto-covers these and passes.

3. **pgTAP track: no gap.** Spec 048 adds no migration, no RPC, no SQL function. Spec 013's existing pgTAP file covers the `recipe_categories` RLS write gate. No new pgTAP tests needed or missing.

4. **Shell smokes track: no gap.** No edge function touched.

5. **Architect's D1 decision respected.** `RecipeCategoriesSection.tsx` imports nothing from `src/lib/db.ts`. Usage counts are computed in-memory from `recipes` and `prepRecipes` Zustand slices via `useMemo`.

6. **Known spec risk not tested (by design).** The race window on block-on-use (Risks §4 — count read at load time, concurrent insert before delete-click) is not covered. Consistent with spec's explicit acceptance of this race as a known minor risk; server-side hardening is out of scope per D3.
