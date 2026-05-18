# Code review for spec 048 (re-review after SF1 / SF2 / SF3 fixes)

## SF fix verification

**SF1 — `RECIPE_TABS` constant hoisted.**
Confirmed. `RECIPE_TABS: Tab[]` is declared at module scope (lines 32–38 of
`RecipesSection.tsx`) and passed via `tabs={RECIPE_TABS}` at all three
`TabStrip` call sites: the `categories.tsx` branch (line 295), the `!sel`
empty-selection branch (line 309), and the `sel`-present branch (line 322).
The `Tab[]` type annotation (not `as const`) correctly matches `TabStrip`'s
mutable `tabs: Tab[]` prop signature — the `TS4104` issue mentioned in the
spec's re-review notes is resolved.

**SF2 — `TabStrip` rendered in the `!sel` empty-selection branch.**
Confirmed structurally correct. The ternary order is:

```
tabId === 'categories.tsx'     → TabStrip + RecipeCategoriesSection
!sel (other tabs)              → TabStrip (no rightSlot) + "select a recipe" text
sel present (other tabs)       → TabStrip (with rightSlot) + detail content
```

When a user in the `!sel` state clicks the `categories.tsx` tab,
`setTabId('categories.tsx')` fires, the first branch wins on the next render,
and `RecipeCategoriesSection` is shown — the path is navigable. No structural
gap remains.

One subtle note: when `tabId === 'categories.tsx'` and `sel` is set, the
first branch still fires and `RecipeCategoriesSection` renders without
recipe context. This is correct per the spec (categories are not
recipe-scoped) and matches the comment on lines 288–291. No issue.

**SF3 — `handleDelete` reads `row?.totalUsageCount ?? 0` directly.**
Confirmed. Line 239: `const total = row?.totalUsageCount ?? 0;`. The guard
at line 240 uses `total`, and `recipeUsageCount` / `prepRecipeUsageCount`
(lines 237–238) are read separately only for the toast and inline warning
interpolation — they are not summed again for the guard. Single source of
truth is honoured.

---

## Critical

_None._

## Should-fix

_None._ All three SF items from the prior review are correctly applied.

## Nits

The following nits carry over from the prior review unchanged — none were
in scope for the SF fixes and none are regressions:

- `src/screens/cmd/sections/RecipeCategoriesSection.tsx:333,427` — `color:
  '#000'` on accent-button text is a hardcoded hex literal. The theme exposes
  `C.accentFg` (dark palette: `'#0E1014'`; light palette: `'#FFFFFF'`) for
  exactly this use case. Both instances were inherited verbatim from
  `CategoriesSection.tsx:297,390` where the same gap exists. Not a new
  deviation, but `accentFg` is the correct token.

- `src/screens/cmd/sections/RecipeCategoriesSection.tsx:345,360,475,490` —
  `'translating…'` and `'—'` placeholder strings are hardcoded English, not
  routed through `T()`. Inherited from `CategoriesSection.tsx` unchanged.
  Low impact for an admin-only surface, but worth noting for a future i18n
  audit.

- `src/screens/cmd/sections/RecipeCategoriesSection.tsx:219–222` — The
  i18n-only save path (same canonical name, translations changed) reuses the
  `renamed` toast key. `CategoriesSection.tsx:211` has the same pattern. A
  dedicated `translated` key would be more accurate semantically, but this is
  a PM-level UX cleanup, not a code defect.

- `src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx:262–273`
  — The negative-delete assertion has a loose regex (line 264) followed
  immediately by two `toContain` assertions (lines 271–273) that supersede it.
  The regex adds noise without additional coverage. Deferred to test-engineer
  per prior review; flagging so the release-coordinator sees it is still open.
