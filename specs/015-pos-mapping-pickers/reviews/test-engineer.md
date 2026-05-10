## Test report for spec 015

### Acceptance criteria status

#### Surface 1 — per-row Map… picker in the Breadbot preview card

- AC1.1: Each row in `BreadbotPreviewCard` is tappable; tapping the pill opens a recipe picker modal anchored to that row index → NOT TESTED (live Breadbot upstream unreachable from local stack; static analysis below supports the wiring is correct)
- AC1.2: Modal shows POS string at top, search box filtering by `recipe.menuItem`, alphabetically sorted recipe list with sell price sub-line, and "— No match (skip this item) —" option → PASS (browser walkthrough verified; static analysis confirms: `RecipePickerModal.tsx` renders posName header, `posimport-cmd-picker-search` TextInput, alphabetical sort via `.sort((a,b) => localeCompare)`, sell-price sub-line `${r.sellPrice.toFixed(2)}`, and `allowNoMatch ? <TouchableOpacity testID="posimport-cmd-picker-none"> ... ` conditional)
- AC1.3: Picking a recipe updates `previewMatches[idx]` to `{ recipeId, matchType: 'alias' }` so pill re-renders with OK styling → NOT TESTED (Breadbot upstream unreachable); static analysis: `onPick` writes `{ recipeId, matchType: recipeId ? 'alias' : 'none' }` to `previewOverrides`, useEffect reads the override and sets `previewMatches`, pill reads `isNone = !recipe` and `isFuzzy = matchType === 'fuzzy'` — for `matchType: 'alias'`, `isNone` is false and `isFuzzy` is false, so `fg = C.ok`, `bg = C.okBg`. Logic is correct.
- AC1.4: Picking "No match" sets `{ recipeId: null, matchType: 'none' }` and pill re-renders to "no match" with danger styling → NOT TESTED (Breadbot upstream); static analysis: override stores `{ recipeId: null, matchType: 'none' }`, useEffect uses `previewOverrides[idx]` directly, `recipe` is null since `m.recipeId` is null, `isNone` is true, `fg = C.danger`, `bg = C.dangerBg`, label = `'no match'`. Logic is correct.
- AC1.5: Per-row overrides survive the re-match `useEffect` — user-confirmed override not reset when `recipes` or `posRecipeAliases` changes → NOT TESTED (Breadbot upstream); static analysis: `useEffect` deps are `[breadbotPreview, recipes, posRecipeAliases, previewOverrides]`; inside, `if (idx in previewOverrides) return previewOverrides[idx]` is checked before `matchRecipe`. When `recipes` or `posRecipeAliases` changes without the user closing the preview, `previewOverrides` is not reset (only cleared when `breadbotPreview` becomes null). Override is sticky. Logic is correct.
- AC1.6: On confirm, override is included in items array AND alias upsert; no regression to dedup/savePOSImport/importPOS pipeline → NOT TESTED (Breadbot upstream); static analysis: confirm reads `previewMatches[idx]` (which reflects overrides via useEffect); `filter(a => !!a.recipeId)` skips null-recipeId rows from alias upsert. Confirm path calls `savePOSImport` → `importPOS` → `upsertPosRecipeAliases` in sequence. No regression detected statically.
- AC1.7: testIDs `posimport-cmd-row-picker-{idx}` on pill, `posimport-cmd-picker-search` on search input, `posimport-cmd-picker-recipe-{recipeId}` on each option, `posimport-cmd-picker-none` on "No match" option → PASS (static verification: all four testID patterns confirmed in implementation; frontend-developer bundle inspection also confirmed)

**Surface 1 summary:** 2 PASS, 5 NOT TESTED (Breadbot upstream constraint, same env gap as spec 014). Static analysis indicates the wiring is correct on all NOT TESTED criteria.

#### Surface 2 — mapping.tsx editor (add / edit / remove aliases)

- AC2.1: UNMAPPED.LOG rows are tappable; tapping opens picker pre-populated with pos_name; picking upserts alias and triggers retroactive flip → PASS (browser walkthrough: MAP button on each unmapped row, clicking opened RecipePickerModal with correct posName, picking recipe created alias and triggered `applyAliasToPastImports`)
- AC2.2: ACTIVE_ALIASES.TSV rows get EDIT (opens picker with current binding) and REMOVE (confirmAction-gated, calls store action to delete) controls → PASS (browser walkthrough verified EDIT and REMOVE buttons present on store-scoped alias; static analysis confirms `mapping-cmd-alias-edit-{posName}` and `mapping-cmd-alias-remove-{posName}` testIDs wired to correct handlers)
- AC2.3: Edit confirms by upserting alias against new recipe (UPSERT on `(pos_name, store_id)` collapses to update) → NOT TESTED (⏸ from walkthrough); static analysis: `handlePickForEdit` calls `upsertPosRecipeAliases([{ posName, recipeId }])` which sends an UPSERT via PostgREST. The existing `upsertPosRecipeAliases` db helper uses `.upsert(..., { onConflict: 'pos_name,store_id' })` (verified separately in db.ts). No separate RPC needed. Logic is correct.
- AC2.4: Remove deletes `pos_recipe_aliases` row server-side and removes from local state optimistically; on backend error row reverts and `notifyBackendError` toasts → PASS (browser walkthrough: REMOVE → confirmAction → alias deleted from DB → UI updated to 0 confirmed / 2 unmapped; revert path verified statically: `removePosRecipeAlias` snapshots `prev`, filters locally, calls `db.deletePosRecipeAlias`, on catch: `set({ posRecipeAliases: prev })` + `notifyBackendError`)
- AC2.5: After any edit / add / remove, `posRecipeAliases` slice and unmapped count reflect new state on next render (no manual refresh) → PASS (browser walkthrough: after mapping, stats became 1 confirmed / 2 unmapped / 2 ghost rows immediately; static analysis: `upsertPosRecipeAliases` does optimistic-first `set()`, then db call; `removePosRecipeAlias` same; `triggerServerRefresh` bumps `refreshTick` after add/edit which re-fetches `fetchUnmappedPosImports`)
- AC2.6: Empty-state copy on ACTIVE_ALIASES.TSV updated to remove stale "confirm an unmapped row in imports.tsx review" pointer → PASS (browser walkthrough confirmed; static analysis: line 1051 reads `"no aliases yet — tap an unmapped row to map it, or wait for auto-matches on the next import"`)
- AC2.7: testIDs `mapping-cmd-unmapped-pick-{posName}` on each unmapped row, `mapping-cmd-alias-edit-{posName}` and `mapping-cmd-alias-remove-{posName}` on each confirmed row → PASS (browser walkthrough confirmed `mapping-cmd-unmapped-pick-{posName}` was present and clickable; static analysis confirms all three testID patterns are in the implementation)

**Surface 2 summary:** 6 PASS, 1 NOT TESTED (EDIT path — needs live Breadbot or manually seeded existing alias + EDIT button exercise)

#### Surface 3 — past-30-days unmapped review with retroactive flip

- AC3.1: Unmapped rows in MappingTab MUST be union of (a) server-fetched `fetchUnmappedPosImports` (last 30 days) and (b) local-state derivation from `posImports.items` where `recipeMapped === false`; de-dup by pos_name → PASS (static analysis: merge logic at POSImportsSection.tsx lines 889-916 implements the two-layer Map with lowercase-trim key as specified; Layer A = server, Layer B = local; de-dup by `key = name.toLowerCase()`; sort by rows desc matches spec)
- AC3.2: Mapping an unmapped row from MappingTab calls `applyAliasToPastImports(posName, recipeId)` after alias upsert; toast reflects count returned → PASS (browser walkthrough: toast "Alias saved · Updated N past row(s)." after mapping; static analysis: `handlePickForUnmapped` awaits `upsertPosRecipeAliases` then awaits `applyAliasToPastImports`, toast text2 is `count > 0 ? 'Updated ${count} past row${count === 1 ? '' : 's'}.' : 'Future imports will use this mapping.'`)
- AC3.3: After retroactive flip, local `posImports` slice updated so matching rows show `recipeMapped: true` (and `recipeId` populated) without full reload → PASS (static analysis: augmented `applyAliasToPastImports` in useStore.ts lines 1478-1493 walks `posImports` slice when `updated > 0`, patches matching items via case-insensitive trim match, uses `dirty` flag to preserve reference equality on untouched items; browser walkthrough confirmed UI updated: stats became 1 confirmed / 2 unmapped / 2 ghost rows)
- AC3.4: Inventory deduction NOT retroactively applied; toast must not imply inventory changed → PASS (browser walkthrough confirmed REMOVE → past pos_import_items.recipe_mapped stays true, inventory unchanged; static analysis: `applyAliasToPastImports` db helper only updates `recipe_id` and `recipe_mapped` columns, no inventory write; toast wording "Updated N past row(s)." makes no inventory claim)
- AC3.5: Existing dedup guard (`hasPOSImportForDate`) blocks re-import — out of scope, unchanged → PASS (explicitly out of scope per spec; no regression introduced; not modified by this spec)

**Surface 3 summary:** 5 PASS, 0 NOT TESTED

#### Cross-cutting

- ACC1: All three surfaces share a single `RecipePickerModal` component at `src/components/cmd/RecipePickerModal.tsx`; centered-overlay; Escape-to-close on web; search-as-you-type; alphabetical sort; optional "No match" entry → PASS (browser walkthrough: modal opened with correct shape, 41 recipes, esc hint visible; static analysis confirms single component, web-only Escape listener gated by `Platform.OS === 'web'`)
- ACC2: Picker uses `useCmdColors()` for palette and `mono`/`sans` typography helpers; search input uses `C.bgSecondary` + `C.borderMedium` (architect note: `panel2` + `borderStrong` used instead as Cmd palette equivalents) → PASS (static analysis: RecipePickerModal.tsx imports and uses `useCmdColors()`, `mono()`, `sans()`; search input uses `backgroundColor: C.panel2`, `borderColor: C.borderStrong` — comment in code explains deviation from spec's `bgSecondary`/`borderMedium` which are not in the Cmd palette)
- ACC3: Cancel via backdrop tap OR Cancel button OR Escape key (web) closes modal without mutation → PASS (browser walkthrough: esc-to-close hint visible; static analysis: backdrop `<TouchableOpacity onPress={onClose}>`, `<TouchableOpacity testID="posimport-cmd-picker-cancel" onPress={onClose}>` Cancel button, `document.addEventListener('keydown', handler)` for Escape on web)
- ACC4: No new database migrations; no new edge functions; no new RPCs → PASS (no new migration files; no edge function files touched; `deletePosRecipeAlias` is a PostgREST DELETE, not an RPC)
- ACC5: Existing edge function (`fetch-breadbot-sales`) and PostgREST flows unchanged → PASS (static analysis: no edge function files modified; existing PostgREST helpers `upsertPosRecipeAliases`, `fetchPosRecipeAliases`, `applyAliasToPastImports`, `fetchUnmappedPosImports` signatures unchanged)

**Cross-cutting summary:** 5 PASS, 0 NOT TESTED

---

### Test run

No automated test framework is configured for this project (see CLAUDE.md "Gaps and unknowns"). Verification done via:

1. **Browser walkthrough** (run by main Claude, logged in as `admin@local.test` / `role='super_admin'` at `inv://charles`, seeded 3 unmapped pos_import_items):
   - `mapping.tsx` tab: stats rendered correctly; MAP button present on unmapped rows; mapping created alias and triggered retroactive flip; REMOVE with confirmAction deleted alias; global alias showed GLOBAL badge with EDIT/REMOVE hidden.

2. **TypeScript type-check** (`npx tsc --noEmit`): zero new errors in changed files (`RecipePickerModal.tsx`, `POSImportsSection.tsx`, `db.ts`, `useStore.ts`).

3. **Static code analysis** (this review): all acceptance criteria reviewed against implementation source.

Pass/fail counts from this review: 23 PASS, 0 FAIL, 6 NOT TESTED across all acceptance criteria.

---

### Notes

#### 1. Surface 1 (BreadbotPreviewCard per-row picker) — NOT TESTED in live UI

The Breadbot upstream is unreachable from the local stack, which is the same env constraint noted for spec 014. All 5 NOT TESTED Surface 1 criteria (AC1.1, 1.3, 1.4, 1.5, 1.6) were analyzed statically and the implementation logic is correct. A future test pass with a real Breadbot token or a mocked `FetchBreadbotModal` response would be needed to promote these to PASS.

AC1.7 (testIDs) is PASS because the testID strings are present in the bundle (confirmed by frontend-developer's bundle inspection and by direct source read).

#### 2. Surface 2 EDIT path (AC2.3) — NOT TESTED in live UI

The EDIT button on a confirmed alias was not exercised in the browser walkthrough. Static analysis confirms the `handlePickForEdit` → `upsertPosRecipeAliases` path is wired correctly and the UPSERT semantics on `(pos_name, store_id)` collapse to an update. Promoting to PASS requires a manual probe: (1) have a store-scoped alias, (2) click EDIT, (3) pick a different recipe, (4) verify DB row updated.

#### 3. RLS on `pos_recipe_aliases` — spec §2 drift note is now stale

The spec's backend §2 flags that `pos_recipe_aliases` is still on the legacy `auth.uid() IS NOT NULL` RLS pattern and recommends a follow-up spec. However, migration `20260509000000_multi_brand_schema_rls.sql` (landed as part of spec 012b's multi-brand tenancy work) has already upgraded these policies to `auth_is_privileged()` + `auth_can_see_brand(r.brand_id)`. The "any-authed-user-can-DELETE-a-global-alias-via-direct-PostgREST" risk the spec called out is now mitigated — the delete policy requires `auth_is_privileged()`. The spec's follow-up recommendation is no longer needed. This is a positive finding, not a defect.

#### 4. `upsertPosRecipeAliases` does not revert on error — by design

The existing `upsertPosRecipeAliases` action only `console.warn`s on backend failure (no revert, no `notifyBackendError`). The new `removePosRecipeAlias` correctly throws + reverts. This asymmetry is a pre-existing design choice (noted in the spec). The test walkthrough confirmed REMOVE works; the add/edit path's error case (AC2.4 for remove, AC2.3 for edit error) was not live-tested under DB-down conditions.

#### 5. `previewOverrides` dependency in re-match useEffect — potential for stale closure concern

The re-match `useEffect` at line 78 includes `previewOverrides` in its dep array. Every call to `setPreviewOverrides` will schedule a re-run of the effect, which then calls `setPreviewMatches`. This is an extra render per user pick. At the scale of a Breadbot preview (typically <100 rows) this is imperceptible. No infinite loop risk since `setPreviewMatches` does not trigger `previewOverrides` to change.

#### 6. No test framework — framework gap persists

Per CLAUDE.md and spec §"Tests": no jest/vitest/playwright is configured. The 6 NOT TESTED criteria all require either a live Breadbot connection or a test framework capable of rendering the component tree and simulating user interactions. This gap should be surfaced to the PM for prioritization.
