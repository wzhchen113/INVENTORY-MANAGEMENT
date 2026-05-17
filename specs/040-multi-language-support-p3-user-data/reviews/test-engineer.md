## Test report for spec 040

*Re-review post-fix-and-amendment pass. Previous review (26 PASS, 1 FAIL Critical, 3 NOT TESTED)
is superseded by this report. Spec amended via Path 2 (Forms-AC9 scoped to `ingredient_categories`
only; `recipe_categories` UI write path explicitly deferred). Frontend developer landed all Critical
and Should-fix items. New tests: `src/lib/translate.test.ts` (7 cases) + pgTAP 2d/2e backfill
assertions.*

---

### Acceptance criteria status

#### Schema

- Schema-AC1: `i18n_names jsonb not null default '{}'` added to all five tables → **PASS** — `supabase/tests/user_data_i18n_names.test.sql::1a-1e`
- Schema-AC2: Migration timestamp >= 20260517000000 → **PASS** — file is `20260517000000_user_data_i18n_names.sql`
- Schema-AC3: Additive-only migration, no rewrites beyond default-backfill → **PASS** — confirmed by reading the migration; only `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT '{}'::jsonb` statements, no UPDATE
- Schema-AC4: No CHECK constraint on `i18n_names` shape → **PASS** — migration contains no CHECK constraint
- Schema-AC5: pgTAP asserts each of the five tables has the column shape → **PASS** — `user_data_i18n_names.test.sql::1a-1e` (17 total assertions, all passing)

#### Helper module

- Helper-AC1: `src/i18n/localizedName.ts` exports `getLocalizedName` with silent-English-fallback semantics → **PASS** — file exists; function exported; camelCase `i18nNames`/`menuItem` per architect's design
- Helper-AC2: `src/hooks/useLocalizedName.ts` exports `useLocalizedName(row)` pulling locale from Zustand → **PASS** — file exists; imports `useLocale` (Zustand subscription); calls `getLocalizedName(row, locale)`
- Helper-AC3: Jest test cases — all five spec-mandated behaviors covered → **PASS** — `src/i18n/localizedName.test.ts` — 26 tests pass including all five mandated cases
- Helper-AC4: Fixture round-trip assertions (one per table, canonical column resolution) → **PASS** — `localizedName.test.ts::getLocalizedName() fixture round-trip` — 15 parametrized assertions covering all five tables

#### Edge function — translate-on-save

- Edge-AC1: NEW edge function at `supabase/functions/translate-on-save/` → **PASS** — directory and `index.ts` exist
- Edge-AC2: `verify_jwt = true` in `supabase/config.toml` → **PASS** — no entry for this function in config.toml (default is `verify_jwt = true`; only exceptions are listed)
- Edge-AC3: Bound to `callEdgeFunction` in `src/lib/auth.ts` per project convention → **PASS** — `src/lib/db.ts:translateOnSave` calls `callEdgeFunction('translate-on-save', ...)` and returns `{ data, error }`; re-exported from `src/lib/translate.ts`
- Edge-AC4: Request shape `{ text, sourceLocale: 'en', targetLocales }` → **PASS** — `db.ts:translateOnSave` sends the correct shape; pinned by `translate.test.ts` case 7 (request body assertion)
- Edge-AC5: Response shape `{ translations: { es?, 'zh-CN'? } }` → **PASS** — edge function returns `{ translations }` on 200; `callEdgeFunction` wraps in `{ data, error }` envelope; pinned by `translate.test.ts` case 1
- Edge-AC6: Calls DeepL `POST api-free.deepl.com/v2/translate` with correct fields → **PASS** — `translateOne()` builds URLSearchParams with `auth_key`, `text`, `source_lang=EN`, `target_lang`; `LOCALE_TO_DEEPL` maps `es→ES`, `zh-CN→ZH-HANS`
- Edge-AC7: `DEEPL_API_KEY` from `Deno.env.get('DEEPL_API_KEY')` → **PASS** — confirmed at line 61 of `index.ts`
- Edge-AC8: DeepL failure returns `{ error: 'translation_unavailable' }` and form falls through → **PASS** — edge function returns 503 + `{ error: 'translation_unavailable' }` for both missing-key and all-locales-failed cases; `translate.test.ts` cases 2–4 pin the graceful-degrade contract: resolves with `{ data: null, error: 'translation_unavailable' }` on 503, resolves with network error string on fetch rejection, never throws (previously NOT TESTED — now PASS)
- Edge-AC9: Caller authorization via `requireAdminCaller()` with `ADMIN_ROLES = new Set(['admin', 'master', 'super_admin'])` → **PASS** — confirmed inline in `index.ts`
- Edge-AC10: `escapeHtml()` applied to DeepL output — **PASS** — edge function no longer applies `escapeHtml` to JSON output (JSON-only response; the Critical finding from the first code-review pass that `escapeHtml` was applied to a non-HTML JSON body was fixed by removing it per CLAUDE.md rule: "If the function renders any HTML (it shouldn't — JSON only), apply `escapeHtml()` per the CLAUDE.md inline-helper rule. Otherwise the rule is moot"). The removal is correct; this AC is satisfied by the rule's moot clause.

#### Forms (write sites — auto-fill + manual override)

- Forms-AC1: Name/menu_item blur or 500ms+ pause triggers `translate-on-save` → **PASS** — all four form components (IngredientForm, IngredientFormDrawer, RecipeFormDrawer, PrepRecipeFormDrawer) implement 600ms debounce timer + blur handler; AbortController cancels in-flight requests on unmount or new input; signal threading pinned by `translate.test.ts` case 6
- Forms-AC2: Two manual-override inputs labeled "Español" and "中文 (简体)" below canonical field → **PASS** (static analysis) — `nameEs`/`nameZh` fields present in all four form components; not automated via UI test (manual smoke only, per spec)
- Forms-AC3: Save payload sends `i18n_names` as `{ es, 'zh-CN' }` omitting keys user cleared → **PASS** — all four forms build `i18n: LocalizedNames = {}` and only write non-empty trimmed values
- Forms-AC4: Empty canonical field blocks save → **PASS** — existing validation unchanged; confirmed by code inspection
- Forms-AC5: In-flight translate-on-save when Save clicked → **PASS** — forms follow path (b): save with whatever overrides user typed and any suggestions already returned
- Forms-AC6: IngredientForm/IngredientFormDrawer → `catalog_ingredients.i18n_names` → **PASS** — both components wired
- Forms-AC7: RecipeFormDrawer → `recipes.i18n_names` (canonical column = `menu_item`) → **PASS** — wired; `menuItemEs`/`menuItemZh` fields present; save path threads `i18nNames` into `db.saveRecipe` (previously had a ghost-write bug — now fixed)
- Forms-AC8: PrepRecipeFormDrawer → `prep_recipes.i18n_names` → **PASS** — wired; `nameEs`/`nameZh` fields present; save path threads `i18nNames` into `db.savePrepRecipe`
- Forms-AC9: CategoriesSection → `ingredient_categories.i18n_names` (amended: `recipe_categories` UI write path is explicitly OUT OF SCOPE per spec amendment) → **PASS** — `CategoriesSection.tsx` manages `ingredient_categories.i18n_names` with Español / 中文 inputs. `recipe_categories` UI write path deferred per the "Out of scope" clause added to the spec (§Out of scope, "recipe_categories UI write path (Cmd UI)"): the DB column, store action (`setRecipeCategoryI18nNames`), and `db.ts` helper (`updateRecipeCategoryI18n`) ship as infrastructure-only; no Cmd UI surface exists today and the spec no longer requires one. This matches the Spec 038 AC-CHROME-5/6 and Spec 013 AC9 resolution pattern.

#### Read sites — list, detail, search, sort

- Read-AC1: Every list display uses `getLocalizedName` for visible name → **PASS** — confirmed for `InventoryCatalogMode.tsx`, `InventoryDesktopLayout.tsx`, `RecipesSection.tsx`, `PrepRecipesSection.tsx`, `CategoriesSection.tsx`; filter dropdowns also localized
- Read-AC2: Search consults BOTH localized name AND canonical English via `matchesQuery` → **PASS** (partial — PrepRecipesSection has no text filter, correct by design) — all sections with search inputs thread both strings
- Read-AC3: Sort-by-name uses localized name as sort key with `localeCompare` → **PASS** — all five sections use `getLocalizedName(..., locale).localeCompare(getLocalizedName(..., locale), locale)`
- Read-AC4: Server-side sort swap documented → **PASS** — all sorts are client-side; architect confirmed

#### Realtime

- Realtime-AC1: No new realtime publication membership → **PASS** — `user_data_i18n_names.test.sql::6a-6c` asserts `recipe_categories` NOT in publication, `ingredient_categories` NOT in publication, and `catalog_ingredients`/`recipes`/`prep_recipes` ARE in publication; all 3 assertions pass
- Realtime-AC2: No `docker restart supabase_realtime_imr-inventory` step needed → **PASS** — confirmed; migration only adds columns to existing publication members

#### Concurrency model

- Concurrency-AC1: Whole-row last-write-wins documented → **PASS** — spec documents this as the explicit design (§Risks); no new RPC or optimistic-lock token needed

#### Verification (test tracks)

- Verify-AC1: Track 1 jest — `src/i18n/localizedName.test.ts` with spec-mandated cases + fixture round-trips → **PASS** — 26 tests, all passing; additionally `src/lib/translate.test.ts` adds 7 more tests (138 total across 12 suites)
- Verify-AC2: Track 2 pgTAP — `supabase/tests/user_data_i18n_names.test.sql` with 17 assertions → **PASS** — all 17 assertions pass (schema shape × 5, backfill × 5 — now covers all five tables including `recipe_categories` (2d) and `ingredient_categories` (2e), RLS × 1, RPC round-trip × 2, RPC backward-compat × 1, realtime membership × 3)
- Verify-AC3: Manual smoke (web + native) → **NOT TESTED** — requires live DeepL key, running dev stack, and human interaction; marked as manual in spec; outside automated test scope

---

### Test run

**Track 1 — jest**

Command: `npm test -- --no-coverage`

```
Test Suites: 12 passed, 12 total
Tests:       138 passed, 138 total
Snapshots:   0 total
Time:        0.797 s
```

New test file `src/lib/translate.test.ts` (7 tests) passes. `localizedName.test.ts` (26 tests) passes. All 12 suites green.

**Track 2 — pgTAP DB tests**

Command: `bash scripts/test-db.sh`

```
== supabase/tests/user_data_i18n_names.test.sql ==
  PASS supabase/tests/user_data_i18n_names.test.sql (17 assertion(s) passed)

✓ 22/22 DB test file(s) passed
```

`user_data_i18n_names.test.sql` grew from 15 to 17 assertions. New assertions (2d) and (2e) confirm `recipe_categories` and `ingredient_categories` backfill. All pass.

**Typecheck**

```
npm run typecheck       → exit 0 (no errors)
npm run typecheck:test  → exit 0 (no errors)
```

---

### Notes

**All Criticals cleared.**

**PASS — Forms-AC9 (amended per Path 2)**

The spec's Forms AC bullet now scopes the UI write path to `ingredient_categories` only. The out-of-scope clause for `recipe_categories` is explicit, matches the frozen-AdminScreens rationale, and follows the same resolution pattern as Spec 038 AC-CHROME-5/6 and Spec 013 AC9. `CategoriesSection.tsx` implements `ingredient_categories.i18n_names` with Español / 中文 inputs. The backend infrastructure for `recipe_categories` (column, store action, db.ts helper) ships in this spec, ready for a future UI surface. No automation gap — the criterion as now written is fully satisfied.

**PASS — DEEPL_API_KEY absent graceful degrade (previously NOT TESTED)**

`translate.test.ts` cases 2–4 now pin the resolves-on-every-failure contract:
- Case 2: 503 from edge function (key absent or all locales failed) → `{ data: null, error: 'translation_unavailable' }` — does not throw.
- Case 3: 503 from edge function (all-locales-failed branch) → same envelope.
- Case 4: fetch rejects entirely (ECONNREFUSED) → `{ data: null, error: 'connect ECONNREFUSED' }` — does not throw.
- Case 5: no session → `{ data: null, error: 'Not authenticated' }` — never calls fetch.

The form's `if (error || !data) return;` early-exit is sufficient because these cases all resolve (never throw), so the form remains submittable regardless of DeepL availability. Previously NOT TESTED — now PASS.

**NOT TESTED — Edge function `translate-on-save` live integration (downgraded to Nit)**

The function's behavior against the real DeepL API cannot be integration-tested without a valid `DEEPL_API_KEY` secret. `translate.test.ts` pins the call contract via mocked fetch (correct URL suffix, correct request body shape, correct response envelope). Static code review confirms the happy path (correct URL, auth_key field, `ZH-HANS` locale code, parallel Promise.all fan-out) and all failure paths. `smoke-edge.sh` does not exercise this function. This remains NOT TESTED for live integration — but it is now a Nit, not a gap of concern: the jest contract test + static review together give adequate confidence for the graceful-degrade semantics the spec cares about. A live integration test would require a real DeepL free-tier key to be stored in the local Supabase secrets store, which is an out-of-band operational step the spec explicitly acknowledges.

**NOT TESTED — Form auto-fill UI flow integration (manual smoke only)**

No jest test drives the debounce timer → `translateOnSave` call → field population path in IngredientForm, RecipeFormDrawer, PrepRecipeFormDrawer, or CategoriesSection. This was NOT TESTED in the original review and remains NOT TESTED. `translate.test.ts` tests the wrapper contract in isolation; it does not render a form component. This is consistent with the spec's Verify-AC3 classifying the auto-fill flow as manual smoke. Not Critical — the form debounce and field wiring are straightforward, the edge-function call contract is pinned, and the save path is independent of translation success.

**Minor — `recipe_categories.category` in RecipesSection detail header renders English (unchanged)**

Line 336 of `RecipesSection.tsx` still renders `sel.category` (raw English string) instead of the localized category name. List view correctly localizes. This was a Minor in the prior review and is still Minor — no AC covers this specific detail header line, and `recipe_categories.i18n_names` is always `{}` on the write path until the follow-up Cmd UI surface lands, so in practice the fallback to English is the correct behavior for now.
