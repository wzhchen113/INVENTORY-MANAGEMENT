# Spec 048: Recipe Categories — Cmd UI management surface

Status: READY_FOR_REVIEW

## User story
As a privileged admin (admin / master / super_admin), I want a Cmd UI surface to
create, rename, translate, and delete entries in the global `recipe_categories`
table so that I can curate the picker source used by recipes / prep_recipes
without going through SQL or the deleted legacy `AdminScreens.tsx`.

## Background
- The legacy CRUD lived in `src/screens/AdminScreens.tsx` and was deleted in
  Spec 025. The Cmd UI never got a replacement — this spec closes AC9 of
  Spec 013 which was deferred at the time.
- Spec 013 hardened RLS so super_admin / admin / master can write the table
  (`20260510030000_recipe_categories_super_admin_rls.sql`, "Admins can write
  categories" → `auth_is_privileged()`).
- Spec 040 P3 added `recipe_categories.i18n_names jsonb default '{}'::jsonb`
  (per-locale name overrides) and updated the helpers in `src/lib/db.ts`:
  - `fetchRecipeCategories()` → `Array<{ name, i18nNames }>`
  - `addRecipeCategory(name, i18nNames?)`
  - `updateRecipeCategory(oldName, newName, i18nNames?)`
  - `deleteRecipeCategory(name)`
  - `updateRecipeCategoryI18n(name, i18nNames)`
- The Zustand store (`src/store/useStore.ts:1163-1213`) already wires these
  with optimistic-then-revert + `notifyBackendError`.
- A near-twin surface exists at
  `src/screens/cmd/sections/CategoriesSection.tsx` — that one is for
  `ingredient_categories`, embedded as a tab inside the Inventory section.
  Mirror its rhythm.
- `RecipesSection.tsx` already uses a `TabStrip` (`components/cmd/TabStrip`)
  for in-section navigation (current tab ids: `recipe.tsx`, `sales.tsx`,
  `method.tsx`, `allergens.tsx`). Adding a sibling "categories" entry follows
  established precedent.
- **`recipe_categories` is NOT a referential FK target.** `recipes.category`
  and `prep_recipes.category` are free-form `text` columns. A category rename
  does NOT automatically cascade to recipes; a category delete does NOT block
  on usage at the DB level. The block-on-use semantics in AC below are
  enforced in application code.
- `recipe_categories` is **not in the realtime publication** (per the
  comment in `20260517000000_user_data_i18n_names.sql`). Edits will not
  push to other clients in real time; refresh / re-login picks them up.

## Acceptance criteria

### Surface placement & shape
- [ ] A new tab is added to `src/screens/cmd/sections/RecipesSection.tsx`'s
      existing `TabStrip` (alongside the current recipe / sales / method /
      allergens tabs) labelled "categories" (or equivalent). No top-level
      sidebar item is added.
- [ ] The categories tab renders a single scrollable list with an inline
      "+ ADD" form at the top and per-row edit/delete affordances. Visual
      and interaction rhythm mirrors `CategoriesSection.tsx` (ingredient
      categories).

### List rendering
- [ ] Each row shows: canonical English `name`, per-locale overrides
      (es, zh-CN) where present, and a **combined usage count** = number of
      `recipes` rows whose `category` text matches the canonical name PLUS
      number of `prep_recipes` rows whose `category` text matches the same
      name. The count is a single integer column per row (not split). Match
      is case-sensitive, consistent with the rest of the app's category
      handling (relaxation is a follow-up if needed).
- [ ] Rows are ordered by current-locale name via `localeCompare` (same
      sort as `CategoriesSection`).

### Create (+ ADD)
- [ ] Inline "+ ADD" form: canonical name input + optional es / zh-CN
      override inputs, with auto-fill via the existing `translateOnSave()`
      helper (hybrid blur-or-debounce trigger, AbortController cancellation
      — mirroring `CategoriesSection`).
- [ ] Submitting calls `useStore.addRecipeCategory(name, i18nNames?)`.
      Optimistic-then-revert + `notifyBackendError` toast on failure is
      handled by the existing store action — the new section MUST NOT add
      a competing try/catch.

### Rename / translate
- [ ] Per-row edit: edits canonical name and i18n overrides; calls
      `useStore.updateRecipeCategory(oldName, newName, i18nNames?)`.
- [ ] Rename does NOT rewrite the matching `recipes.category` /
      `prep_recipes.category` rows. (Same posture the table has today;
      cascading is explicitly out of scope.)

### Delete — block on use
- [ ] **Positive case (0 usage):** for a row whose combined usage count is
      zero, pressing delete invokes `confirmAction` (per project
      cross-platform pattern) and on confirm calls
      `useStore.deleteRecipeCategory(name)`. The row disappears from the
      list (optimistic). On RLS / network failure, the store reverts and
      surfaces a `notifyBackendError` toast.
- [ ] **Negative case (>0 usage):** for a row whose combined usage count
      is non-zero, the delete affordance MUST refuse the delete BEFORE any
      DB call — surfacing a toast of the shape:
      `"Used by N recipes / M prep recipes — cannot delete."`
      where N and M are the per-table counts (sums to the displayed
      combined total). No DELETE statement is issued to PostgREST.
- [ ] The block-on-use check uses the same usage-count source as the
      column (no second source of truth). When the count comes from a new
      `src/lib/db.ts` helper (see In scope), the section reads it through
      the store / helper rather than recomputing locally.

### Errors & realtime
- [ ] Backend errors on add / update / delete are surfaced via
      `notifyBackendError` toast (already done by the store).
- [ ] No realtime channel subscription is added. Cross-client live updates
      are not in scope — the parent i18n spec already documented this.

### Platform parity
- [ ] Web + native parity, in line with the rest of the Cmd UI. The pattern
      mirrors `CategoriesSection`, which is web+native today.

## In scope
- A new tab inside `src/screens/cmd/sections/RecipesSection.tsx`'s existing
  `TabStrip` (placement Q1 = A — Recipes section tab, NOT a top-level
  sidebar item, NOT an Inventory tab).
- A new component file under `src/screens/cmd/sections/` (or a co-located
  child of `RecipesSection`) implementing the categories list/form,
  modeled on `CategoriesSection.tsx`.
- New `src/lib/db.ts` helper(s) — name to be decided by architect, e.g.
  `listRecipeCategoriesWithUsage()` returning rows of the shape
  `{ name, i18nNames, recipeUsageCount, prepRecipeUsageCount }` — that
  surface per-category usage counts to the UI. Two `count(*)` queries
  grouped by `category` (one against `recipes`, one against `prep_recipes`)
  summed/joined into the existing `fetchRecipeCategories` result. May
  alternatively be folded into `fetchRecipeCategories` directly if the
  architect prefers a single round-trip; both shapes acceptable.
- Reuse of existing store actions `addRecipeCategory` /
  `updateRecipeCategory` / `deleteRecipeCategory` /
  `updateRecipeCategoryI18n` — no new store actions, no new RPC, no new
  migration.
- Reuse of the existing `translateOnSave()` helper for auto-fill on + ADD
  and edit.
- Application-side block-on-use check in the section's delete handler,
  reading from the usage-count source above.

## Out of scope (explicitly)
- **`audit_log` writes for CRUD ops on `recipe_categories`** — Q4 = A
  (match `CategoriesSection` parity, which writes none). Retrofitting
  audit logs is a separate spec that would cover both `CategoriesSection`
  and this new surface together; out of scope here.
- **UI role gate** — Q5 = A. The section is visible to all users; RLS
  enforces privileged-only writes and the existing
  `notifyBackendError` toast surfaces rejections. No `useIsPrivileged()`-
  shape hook is added. (Also: `useRole` returns `'admin'` for everyone
  per CLAUDE.md, so a UI gate would be cosmetic.)
- **Cascade-rewrite UX on delete** — Q3 = A. No "rewrite N recipes from
  Sauces to Condiments before deleting" dialog. The user must retag or
  delete the dependent recipes / prep_recipes themselves before the
  delete will be allowed.
- **Cascade-nullify on delete** — also rejected. The block-on-use guard
  prevents dangling category labels by construction.
- **Promoting `recipes.category` / `prep_recipes.category` to a real FK
  on `recipe_categories.id`.** Current schema keeps them free-form text;
  a true FK is a separate refactor.
- **Bulk re-categorization** (rename + rewrite all matching recipes in
  one action). Out of scope; users perform retags one recipe at a time.
- **Putting `recipe_categories` into the realtime publication.** Documented
  omission in the parent i18n spec; cross-client live updates are a
  follow-up.
- **Touching `ingredient_categories` or `CategoriesSection.tsx`** — that
  surface is already shipped and unrelated.
- **Top-level sidebar entry** — Q1 = A picked the embedded-tab route.
- **Staff app or PWA** — `recipe_categories` is admin-only.

## Open questions resolved

- **Q1. Placement** → **A. New tab on the existing Recipes section.**
  Mirrors how `CategoriesSection` is embedded as a tab inside the Inventory
  section. Not a top-level sidebar item. `RecipesSection.tsx` already uses
  `TabStrip`, so the new "categories" entry slots in alongside the existing
  `recipe.tsx` / `sales.tsx` / `method.tsx` / `allergens.tsx` tabs.

- **Q2. UI shape** → **Single scrollable list with inline "+ ADD" + per-row
  edit/delete affordances.** Matches `VendorsSection` / `CategoriesSection`.
  No master/detail layout.

- **Q3. Delete policy** → **A. Block on use.** `recipes.category` and
  `prep_recipes.category` are free-form `text` (no FK). Count usage (recipes
  + prep_recipes summed). If non-zero, refuse the delete with a toast like
  `"Used by N recipes / M prep recipes — cannot delete."` User must retag
  or delete those rows first. No cascade-rewrite dialog.

- **Q4. Audit log** → **A. Match `CategoriesSection` parity — no
  audit_log writes.** Scope is not extended to retrofit `CategoriesSection`
  either; that is a separate spec if ever wanted, covering both sections
  together.

- **Q5. Role gate in the UI** → **A. No UI gate — trust RLS + toast.**
  Matches `CategoriesSection`. `useRole` is still a placeholder returning
  `'admin'` per CLAUDE.md, so a UI gate would be cosmetic anyway. RLS
  rejection already surfaces via `notifyBackendError`.

- **Q6. Usage count** → **Single combined count per row** (recipes +
  prep_recipes pointing at that category name). Cheap to compute via two
  `count(*)` queries summed in `src/lib/db.ts`. Supports Q3's block-on-use:
  the negative-case toast splits the total back into the two underlying
  numbers so the user knows where to look.

## Dependencies
- `recipe_categories` table + `i18n_names` column (exist; Spec 040 P3).
- RLS policy "Admins can write categories" (exists; Spec 013).
- Store actions `addRecipeCategory` / `updateRecipeCategory` /
  `deleteRecipeCategory` / `updateRecipeCategoryI18n` (exist).
- `translateOnSave()` helper at `src/lib/translate.ts` (exists, used by
  `CategoriesSection`).
- `confirmAction()` cross-platform helper at `src/utils/confirmAction.ts`.
- `TabStrip` at `src/components/cmd/TabStrip.tsx`.
- New helper in `src/lib/db.ts` (e.g. `listRecipeCategoriesWithUsage`) —
  shape resolved by architect. May either be a new helper or an extension
  of `fetchRecipeCategories`.

## Project-specific notes
- **Cmd UI section / legacy:** Cmd only — new tab inside the existing
  `RecipesSection` under `src/screens/cmd/sections/`. Spec 025 deleted
  the legacy admin surface, so there is no legacy route to update.
- **Per-store or admin-global:** Admin-global. `recipe_categories` has no
  `store_id` / `brand_id`; single shared list across all stores and
  brands. RLS is the Spec 013 "Admins can write categories" gate via
  `auth_is_privileged()`.
- **Realtime channels touched:** None. `recipe_categories` is intentionally
  not in the realtime publication. Cross-client live updates are not in
  scope for this spec. (The realtime publication gotcha — mid-session pub
  changes need `docker restart supabase_realtime_imr-inventory` — does not
  apply here because no publication change is being made.)
- **Migrations needed:** No. Table + i18n column + RLS already in place.
  No `audit_log` writes (Q4 = A), so no migration there either.
- **Edge functions touched:** None. All reads/writes flow through PostgREST
  via existing RLS using the helpers in `src/lib/db.ts`.
- **Web/native scope:** Both — the Cmd UI is universal. Pattern mirrors
  `CategoriesSection`, which is web+native today.
- **Tests track (per Spec 022):**
  - **jest** for the new section's render/interaction (mock the store
    actions and the new `listRecipeCategoriesWithUsage`-shape helper;
    cover the positive-delete and negative-delete-blocked paths
    explicitly).
  - **pgTAP** coverage of "Admins can write categories" already exists
    from Spec 013 — verify before adding more. No new DB tests required
    unless the architect introduces a new SQL helper.
  - **shell smokes** — none required; no new edge function.
- **`app.json` slug:** Not touched.

## Risks
1. **Free-form `recipes.category` divergence.** Rename does not cascade.
   Existing recipes/prep_recipes keep their old category text after a
   rename, which means they fall through `getLocalizedName()` to the old
   English label and disappear from the picker grouping for the new label.
   This is the same posture the table has today via SQL edits; documented
   as a known limitation rather than a regression. The block-on-use delete
   guard prevents the dangling-label case for deletes specifically.
2. **No realtime broadcast.** A user on another tab/device won't see the
   edit until a reload or auth re-bootstrap. Same posture as
   `ingredient_categories`.
3. **Cross-locale sort collation.** Like `CategoriesSection`, zh-CN
   `localeCompare` without ICU falls back to codepoint order. Documented
   as a known limitation, not a bug.
4. **Race window on block-on-use.** The usage count is read once at list
   load; a concurrent recipe insert pointing at the category between read
   and delete-click could let a delete through even though usage just
   became non-zero. Consistent with the rest of the app's optimistic
   posture — surfaced as a known minor race, not a blocker. Hardening
   would require a server-side check (RPC or trigger) and is out of scope
   here.

## Backend design

### 0. Three decisions PM flagged

**D1. Helper shape in `src/lib/db.ts`** — Recommend **no new helper**. Compute
usage counts entirely client-side from the already-loaded `recipes` and
`prepRecipes` Zustand slices.

Rationale: both arrays are already in memory at the time the new tab renders
(see [src/store/useStore.ts:977-978](src/store/useStore.ts) loading `recipes`
and `prepRecipes` into the store on boot; the brand-catalog refactor made
recipes brand-shared so there is no per-store filtering required). Adding a
`listRecipeCategoriesWithUsage()` server helper would issue two `group by`
count queries to PostgREST that re-derive data the client already has. It
would also create a second source of truth for "what counts as usage", which
spec AC #3 (line 98-100) explicitly forbids: *"The block-on-use check uses
the same usage-count source as the column (no second source of truth)."* If
the source is server-computed it diverges from the in-memory `recipes` /
`prepRecipes` that the user will retag against.

The existing `CategoriesSection.tsx` precedent (lines 50-69) computes
ingredient-category counts in-memory the same way — establishing the
pattern this spec should mirror.

**D2. Combined-count split for the negative-delete toast** — Recommend
**compute both counts separately in the section's `useMemo`, display the
combined sum in the row, and surface both numbers in the toast.** Zero
round trips. The same `useMemo` that produces `{ name, label,
recipeUsageCount, prepRecipeUsageCount, totalUsageCount }` per row feeds
both the row's right-aligned count column and the negative-delete toast
body.

Rationale: the data is in-memory; computing two counts vs one is the same
loop body. AC #3 already requires the section to consume usage from a
single source, so splitting at display time costs nothing.

**D3. Block-on-use guard location** — Recommend **client-side guard only**,
matching the documented spec posture (Risks #4) and the precedent in
`CategoriesSection.tsx:218-241`.

Rationale: an RPC `delete_recipe_category_if_unused(name)` would close the
documented race window at the cost of a new SQL migration, a pgTAP test,
and an additional code path the rest of the codebase doesn't use anywhere
else. For a global admin-only table where the concurrent-insert race is
both rare in practice (admins curating categories ≠ admins inserting
recipes simultaneously) and self-healing (re-running the delete after a
refresh shows the new count), the cost/benefit doesn't justify the extra
SQL surface. If/when an audit-log retrofit (Q4, out-of-scope) lands, that
spec can also introduce the atomic-RPC version.

**Net effect of D1+D2+D3:** zero migrations, zero new helpers in
`src/lib/db.ts`, zero new store actions, zero edge function changes. Pure
frontend work in `RecipesSection.tsx` + one new section component file.

### 1. Data model changes

None. The table `recipe_categories(name, i18n_names, created_at)` already
exists from Spec 040 P3. RLS policy "Admins can write categories" already
exists from Spec 013.

### 2. RLS impact

None. Spec 013 already routes writes through `auth_is_privileged()`. Reads
are open to all authenticated users (the same posture
`ingredient_categories` has). No policy edits.

### 3. API contract

No new RPC. No new edge function. No new PostgREST surface.

The frontend uses the four existing helpers in `src/lib/db.ts`:
- `fetchRecipeCategories()` — already called at boot via `useStore` reload.
- `addRecipeCategory(name, i18nNames?)` — existing.
- `updateRecipeCategory(oldName, newName, i18nNames?)` — existing.
- `deleteRecipeCategory(name)` — existing.
- `updateRecipeCategoryI18n(name, i18nNames)` — existing (used by the
  `setRecipeCategoryI18nNames` store action for same-name translation
  edits).

### 4. Edge function changes

None.

### 5. `src/lib/db.ts` surface

No additions. No edits.

(Counter-recommendation: do NOT add `listRecipeCategoriesWithUsage()` or
extend `fetchRecipeCategories()` with an `includeUsage` flag. See D1
rationale above. The fan-out cost of changing `fetchRecipeCategories`
across every call site is also non-trivial — the comment at db.ts:1699
already flags it as a "load-bearing fan-out".)

### 6. Store impact (`src/store/useStore.ts`)

No new slice, no new action. The new section consumes the existing
read-only slices:
- `recipeCategories: RecipeCategory[]` (already exists)
- `recipes: Recipe[]` (already exists, brand-shared)
- `prepRecipes: PrepRecipe[]` (already exists)

And the existing write actions:
- `addRecipeCategory(name, i18nNames?)`
- `updateRecipeCategory(oldName, newName, i18nNames?)`
- `deleteRecipeCategory(name)`
- `setRecipeCategoryI18nNames(name, i18nNames)`

All four already implement optimistic-then-revert with
`notifyBackendError`. The new section MUST NOT add a competing try/catch
around them (AC line 73-76 calls this out explicitly).

Open note: `updateRecipeCategory` at `useStore.ts:1183-1185` optimistically
rewrites `recipes.category` locally on rename, but `db.updateRecipeCategory`
at `db.ts:1740-1748` does NOT cascade the rename to `recipes` server-side.
On the next reload the local rewrite reverts. This is a pre-existing
inconsistency in the rename codepath, not a new issue introduced by this
spec — but the new section will surface it more visibly because users will
see local recipes "follow" a rename and then snap back after refresh. Flag
to PM as a follow-up; do not fix in this spec.

### 7. Realtime impact

None. `recipe_categories` is intentionally NOT in the `supabase_realtime`
publication (per the comment in
`20260517000000_user_data_i18n_names.sql`). Cross-client live updates are
out of scope for this spec; refresh / re-login picks up edits.

**No publication change is made.** The realtime container restart gotcha
does NOT apply to this spec. No `docker restart
supabase_realtime_imr-inventory` step is needed.

### 8. Frontend implementation shape (pseudocode, not committable)

One new component file at
`src/screens/cmd/sections/RecipeCategoriesSection.tsx` (mirroring
`CategoriesSection.tsx` for ingredient categories). One edit to
`RecipesSection.tsx` to add the tab.

```tsx
// In RecipesSection.tsx — extend the existing TabStrip (around line 281)
<TabStrip
  tabs={[
    { id: 'recipe.tsx',     label: 'recipe.tsx' },
    { id: 'method.tsx',     label: 'method.tsx' },
    { id: 'allergens.tsx',  label: 'allergens.tsx' },
    { id: 'sales.tsx',      label: 'sales.tsx' },
    { id: 'categories.tsx', label: 'categories.tsx' },  // new
  ]}
  // ...
/>

// Routing: when tabId === 'categories.tsx', render
// <RecipeCategoriesSection /> in place of the per-recipe detail panel.
// The categories tab is NOT recipe-scoped — when selected, the list
// pane on the left can keep its current state (recipes list still
// rendered, just visually de-emphasised) OR the detail pane swaps to
// the categories surface and the list pane stays interactive. Mirror
// whatever the `sales.tsx` / `method.tsx` placeholder tabs do today.
```

```tsx
// RecipeCategoriesSection.tsx — usage memo (replaces CategoriesSection's
// inventory-deduped count with a sum across both recipes + prep_recipes)
const sorted = useMemo(() => {
  const recipeCounts = new Map<string, number>();
  const prepCounts   = new Map<string, number>();
  for (const r of recipes) {
    if (r.category) recipeCounts.set(r.category, (recipeCounts.get(r.category) || 0) + 1);
  }
  for (const p of prepRecipes) {
    if (p.category) prepCounts.set(p.category, (prepCounts.get(p.category) || 0) + 1);
  }
  return recipeCategories
    .map((c) => {
      const recipeUsageCount     = recipeCounts.get(c.name) || 0;
      const prepRecipeUsageCount = prepCounts.get(c.name) || 0;
      return {
        ...c,
        recipeUsageCount,
        prepRecipeUsageCount,
        totalUsageCount: recipeUsageCount + prepRecipeUsageCount,
        label: getLocalizedName({ name: c.name, i18nNames: c.i18nNames }, locale),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}, [recipeCategories, recipes, prepRecipes, locale]);

// handleDelete — block-on-use guard with split toast body
const handleDelete = (row) => {
  if (row.totalUsageCount > 0) {
    Toast.show({
      type: 'error',
      text1: T('section.recipeCategories.inUseToast'),
      text2: T('section.recipeCategories.inUseToastBody', {
        name: row.name,
        recipes: row.recipeUsageCount,
        preps: row.prepRecipeUsageCount,
      }),
    });
    return; // no DELETE issued
  }
  confirmAction(/* ... */, () => deleteRecipeCategory(row.name));
};
```

### 9. Tests

- **jest** — new file
  `src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx`.
  Mock `useStore` to provide `recipeCategories`, `recipes`, `prepRecipes`,
  and the four write actions as jest mocks. Cover:
  - render: row with N>0 usage shows combined count.
  - positive delete (count=0): `confirmAction` → `deleteRecipeCategory` is
    called with the row name.
  - negative delete (count>0): `deleteRecipeCategory` is NOT called, and
    a Toast with `type: 'error'` is shown whose `text2` contains both the
    N (recipes) and M (prep recipes) underlying numbers.
  - add: trimmed name + i18n object passed through to `addRecipeCategory`.
  - rename: `updateRecipeCategory(oldName, newName, i18nNames)` called.
- **pgTAP** — none. RLS for `recipe_categories` writes is already covered
  by Spec 013's pgTAP. No new SQL surface in this spec.
- **shell smokes** — none. No edge function.

### 10. Risks and trade-offs (architect-level, on top of spec §Risks)

- **No server-side delete guard.** Documented. Adding one later requires
  one SQL migration + pgTAP + a thin RPC wrapper around `delete`; out of
  scope here per D3. If a future spec needs strict transactional safety
  (e.g. compliance), introduce
  `delete_recipe_category_if_unused(category_name text) returns void` as
  a `security definer` function that does `count(*)` on both `recipes`
  and `prep_recipes` matching by name and raises P0001 on usage. Mirrors
  the `assert_not_last_of_role` pattern (spec 031) — a SQL helper as
  single source of truth.
- **Performance.** Two linear scans of `recipes` + `prepRecipes` per
  memo evaluation. With the current dataset shape (~tens to low
  hundreds of recipes), this is well under a frame budget and not worth
  optimising. The memo's deps array (`recipes`, `prepRecipes`,
  `recipeCategories`, `locale`) re-runs only on those slices changing.
- **Bind-mount / CWD gotchas.** Not applicable — no edge function touched.
- **Realtime container restart.** Not applicable — no publication change.
- **Migration ordering.** Not applicable — no migration.

## Files changed

- `src/screens/cmd/sections/RecipeCategoriesSection.tsx` — new section
  component (mirror of `CategoriesSection.tsx` for ingredient
  categories). Computes per-row usage counts from in-memory `recipes`
  and `prepRecipes` slices and blocks delete when total > 0 with a
  toast that splits the count into N (recipes) and M (prep recipes).
  Reuses existing store actions; no new helper added to `src/lib/db.ts`.
  Code-reviewer SF3: `handleDelete` now reads `row?.totalUsageCount`
  directly for the guard `total` rather than re-summing the split
  counts, so the displayed column, the guard, and the toast share one
  source.
- `src/screens/cmd/sections/RecipesSection.tsx` — added `categories.tsx`
  to the `TabStrip` and routed it to `<RecipeCategoriesSection />`. The
  categories tab is non-recipe-scoped, so the detail pane renders the
  section even when no recipe is selected; the rightSlot (recipe
  duplicate/delete/edit buttons) is suppressed on this tab via the
  existing `!sel` gating. Code-reviewer SF1: hoisted the `TabStrip`
  tabs array into a module-level `RECIPE_TABS: Tab[]` constant so all
  three call sites (categories branch / `!sel` empty branch /
  `sel`-present branch) share one declaration. Code-reviewer SF2: the
  `!sel` empty-selection branch now also renders the `TabStrip` (with
  no `rightSlot`) above the "select a recipe" message, so a user who
  lands on Recipes with no recipe selected — filter to zero, brand
  with no recipes yet — can still navigate to the `categories.tsx`
  tab.
- `src/i18n/en.json` — added `section.recipes.categories.*` namespace
  (title, description, form/list copy, action labels, toast / confirm
  copy including the in-use-block split body).
- `src/i18n/es.json` — same key set, Spanish translations.
- `src/i18n/zh-CN.json` — same key set, Simplified Chinese translations.
- `src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx`
  — new jest component test covering render with combined count, the
  positive delete (0 usage → succeeds), the negative delete (>0 usage →
  blocked, toast includes both N and M), add, and rename paths. Mocks
  `useStore`, `useT`, `useLocale`, `confirmAction`, `theme/colors`, and
  `lib/translate` at the boundary per existing test conventions.

## Verification

Verified in headless Chrome against the local Supabase stack:

- Logged in as `admin@local.test` / `password`, navigated to
  Menu items / BOM → categories.tsx tab.
- Render: 9 active categories shown with per-row usage counts
  (Appetizer 6 uses, Desserts 9 uses, Drinks 0 uses, etc.) and
  EDIT / DELETE affordances.
- Negative delete: clicked DELETE on "Appetizer" (6 uses); the inline
  warning showed `Cannot delete "Appetizer" — used by 6 recipes / 0 prep
  recipes.` and the row stayed in the list. No DELETE call issued.
- Positive delete: clicked DELETE on "Drinks" (0 uses) with
  `window.confirm` auto-confirmed; the row disappeared and the active
  count dropped from 9 → 8.
- Add: entered "Brunch" in the + NEW CATEGORY input and clicked
  + NEW CATEGORY; the row appeared with 0 uses, the active count
  returned to 9.
- Rename: clicked EDIT on "Brunch", changed the value to
  "Weekend Brunch", clicked SAVE; the new label appeared at the
  bottom of the alphabetically-sorted list. Switching back to the
  `recipe.tsx` tab fully restored the per-recipe detail view.
- No visible console errors in the page DOM during interaction.

jest: `npm test -- RecipeCategoriesSection` — 5 / 5 passing.
i18n catalog parity: `npm test -- i18n` — 38 / 38 passing.
Full suite: `npm test` — 168 / 168 passing across 14 test suites.
Typecheck: `npx tsc --noEmit` — clean.

### Re-review (SF1 / SF2 / SF3) follow-up

After code-reviewer flagged three Should-fix items and release-coordinator
flipped the status back to FIXES_NEEDED, the three fixes landed:

- SF1 (DRY tabs array) — `RECIPE_TABS: Tab[]` constant hoisted in
  `RecipesSection.tsx`; passed via `tabs={RECIPE_TABS}` at all three
  `TabStrip` call sites.
- SF2 (TabStrip unreachable from empty-selection state) — the `!sel`
  branch now renders the `TabStrip` (rightSlot omitted) above the
  "select a recipe" message, so the categories tab is reachable when
  no recipe is selected. Other tabs (recipe / method / allergens /
  sales) still require a selection to show their content.
- SF3 (single source for `total` in `handleDelete`) —
  `RecipeCategoriesSection.tsx` `handleDelete` now reads
  `row?.totalUsageCount ?? 0` rather than re-summing the split
  counts.

Verification on the re-review fix-up:
- `npm run typecheck` — clean (initial `as const` attempt produced
  three `TS4104` "readonly cannot assign to mutable" errors against
  `TabStrip`'s `tabs: Tab[]` prop; switched the constant to a typed
  `Tab[]` and it cleared).
- `npm test -- RecipeCategoriesSection` — 5 / 5 passing.
- `npm test` (full suite) — 168 / 168 passing across 14 test suites.
- Browser exercise of the SF2 empty-selection → categories tab flow:
  the in-process preview tool surface was not exposed in this session
  (only Read / Write / Edit / Bash available), so the SF2 fix was
  verified statically — the JSX path now renders `<TabStrip
  tabs={RECIPE_TABS} activeId={tabId} onChange={setTabId} />` in the
  `!sel` branch before the empty-state message, and `setTabId` is the
  same setter used by the other two branches. The user / reviewers
  may want to spot-check this in headless Chrome before SHIP_READY.
