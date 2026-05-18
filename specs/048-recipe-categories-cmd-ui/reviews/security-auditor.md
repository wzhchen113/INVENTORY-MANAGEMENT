# Security audit for spec 048 (re-review after SF1 / SF2 / SF3)

## Scope of this re-review

Three Should-fix items from code-reviewer landed since the prior security
audit:

- **SF1** — extracted `RECIPE_TABS: Tab[]` module-level constant in
  `src/screens/cmd/sections/RecipesSection.tsx:32-38`. No logic change;
  the array literal previously inlined at three `TabStrip` call sites
  is now declared once.
- **SF2** — `!sel` branch in `src/screens/cmd/sections/RecipesSection.tsx:301-318`
  now renders `<TabStrip tabs={RECIPE_TABS} activeId={tabId} onChange={setTabId} />`
  (no `rightSlot`) above the "select a recipe" empty-state message so the
  `categories.tsx` tab is reachable when no recipe is selected. Pure
  UX/layout addition; no new state, no new effect, no new navigation
  side channel.
- **SF3** — `handleDelete` in `src/screens/cmd/sections/RecipeCategoriesSection.tsx:229-271`
  now reads `total = row?.totalUsageCount ?? 0` from the same `sorted`
  memo that drives the displayed count column, rather than re-summing
  `recipeUsageCount + prepRecipeUsageCount`. The split counts are still
  read for the toast body. Pure defensive read — single source of
  truth, no new fetch.

Both files were re-read end-to-end (not just the diff) to confirm no
adjacent code was changed.

## Critical (BLOCKS merge)
None.

## High (must fix before deploy)
None.

## Medium
None.

## Low
None.

## Dependencies
No `package.json` changes — `npm audit` skipped.

## Threat-model check — none of the three fixes touch a security surface

| Surface                           | Touched? | Notes                                                                                       |
|-----------------------------------|----------|---------------------------------------------------------------------------------------------|
| RLS policies / new tables         | No       | No migration in the changed-files set.                                                      |
| Edge functions / `verify_jwt`     | No       | No edge function added or modified.                                                         |
| Auth flow / role gates            | No       | RLS still gates writes via `auth_is_privileged()`. No UI role gate added (spec Q5 = A).     |
| Secrets / `EXPO_PUBLIC_*`         | No       | No new env reads, no new third-party calls.                                                 |
| User input validation             | No       | `handleDelete` arg is the same row-identity `name` string as before; XSS surface unchanged. |
| PII / data exposure               | No       | No new API surface; counts derived from already-loaded in-memory slices.                    |
| Realtime / channel subscriptions  | No       | `recipe_categories` is intentionally not in the publication — unchanged.                    |
| SQL injection / dynamic SQL       | No       | PostgREST + parameterised store actions throughout; no `EXECUTE` interpolation anywhere.    |
| Logs / `notifyBackendError`       | No       | No new logging; existing store actions own the error toasts.                                |

### SF1 — `RECIPE_TABS` constant

`src/screens/cmd/sections/RecipesSection.tsx:32-38`. A module-level
`Tab[]` literal with five static `{ id, label }` pairs. No
user-controllable input, no interpolation, no auth boundary. Refactor
only.

### SF2 — `TabStrip` rendered in `!sel` branch

`src/screens/cmd/sections/RecipesSection.tsx:301-318`. The `!sel`
branch now renders the same `<TabStrip>` element as the
`tabId === 'categories.tsx'` branch and the `sel`-present branch,
deliberately *without* `rightSlot`. The omitted `rightSlot` is the
recipe duplicate / delete / edit cluster, which is meaningless when
no recipe is selected and which itself already gates on
`role === 'admin'` — its omission removes nothing the user could
have invoked anyway. No new authorization path is exposed: switching
to `categories.tsx` from the empty-selection state renders
`<RecipeCategoriesSection />`, whose own writes are still gated by
`auth_is_privileged()` RLS server-side and surfaced via
`notifyBackendError` on rejection. Pure availability fix.

### SF3 — `handleDelete` reads `row?.totalUsageCount ?? 0`

`src/screens/cmd/sections/RecipeCategoriesSection.tsx:229-271`.
The previous code re-summed `recipeUsageCount + prepRecipeUsageCount`
to derive `total`; the new code reads `total` directly from the same
`sorted` memo entry (line 239: `const total = row?.totalUsageCount ?? 0;`).
Both values come from the *same* memo iteration so they are guaranteed
identical — SF3 is a maintainability win that closes a footgun where a
future change to the memo's count fields could let `handleDelete` drift.

The `?? 0` fallback path triggers only when `sorted.find((c) => c.name === name)`
returns `undefined` — e.g. the row was deleted by a concurrent edit
between render and click. In that defensive-zero branch the function
falls through to `confirmAction` → `deleteRecipeCategory(name)`, which
is the same path a legitimately-zero-usage row takes. Two reasons this
is not a finding:

1. **The destructive op is still gated by RLS** — the
   `"Admins can write categories"` policy in
   `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`
   on `recipe_categories` requires `auth_is_privileged()`. A
   non-privileged caller's DELETE is dropped before any row mutation
   and surfaces via `notifyBackendError`.
2. **The client-side `total > 0` gate is UX hygiene, not a security
   control.** `recipes.category` and `prep_recipes.category` are
   free-form text columns with no FK to `recipe_categories.name`
   (spec lines 36-39). Even if the gate is bypassed (race window
   documented as Risks #4, spec lines 256-262), the only consequence
   is orphaned labels — no privilege escalation, no data leakage, no
   cross-tenant exposure.

So SF3 does not move any threat-model needle. Maintainability win
only.

## Posture confirmation

Prior security audit had **0 Critical / 0 High / 0 Medium / 0 Low**.
After SF1 / SF2 / SF3, posture still holds: **0 Critical / 0 High /
0 Medium / 0 Low**. None of the three fixes introduces a new auth
path, input surface, secret handling, or data-exposure vector.

The full surface-area checklist from the prior audit (RLS authz via
existing store actions, no client-side XSS surface, no edge-function
touch, no new realtime subscription, no PII echo) remains accurate
— SF1 / SF2 / SF3 do not change any of those answers. The audit
artifacts that were verified before this re-review are not
re-enumerated here to avoid duplication; they are unchanged by the
fixes.

Spec 048 remains clear from a security perspective.
