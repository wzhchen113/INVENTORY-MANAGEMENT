# Code review for Spec 038 Round 2 (R3 — fix-pass verification)

## Critical
None.

## Should-fix

### SF-R3-1 — BrandsSection desktop two-pane no-selection state

`src/screens/cmd/sections/BrandsSection.tsx:298-300` — Three raw English
strings in the desktop empty-state path:
```tsx
? listTab === 'trash' ? 'no brands in trash' : 'no brands yet'
: 'select a brand'
```

SF-5 fixed the ListPane cluster but not this parallel desktop empty-state.
Add: `section.brands.noTrashDetail`, `section.brands.noBrandsYetDetail`,
`section.brands.selectBrand` (or reuse `noTrash`/`noBrandsHint` if the
context carries over). Mirror in all 3 catalogs.

### SF-R3-2 — RecipesSection / PrepRecipesSection `+ NEW` button visible text

- `RecipesSection.tsx:191` — `+ NEW` button visible label is untranslated
  while its `accessibilityLabel` (`section.recipes.newAria`) is translated.
- `PrepRecipesSection.tsx:148` — same pattern.

Spec 038's BrandsSection `+ NEW BRAND` button was wired via
`section.brands.newBrandButton` in SF-5; sibling buttons missed the sweep.
Suggested keys: `section.recipes.newButton`, `section.prepRecipes.newButton`.

## Nits

R2's 5 carry-forwards (N-1 through N-5) unchanged. Plus one new:

- **N-R3-1** `BrandsSection.tsx:405,481` — inline pluralized count strings:
  - line 405: `{visible.length} {visible.length === 1 ? 'brand' : 'brands'}`
  - line 481: `{b.storeCount} stores · {b.memberCount} admins · {b.catalogIngredientCount} ingredients`
  
  Lower priority — multi-noun plural patterns aren't established yet.

## Summary

| R2 finding | Status |
|---|---|
| SF-1 cross-namespace borrowing | Cleared |
| SF-2 sales sub-tab literals | Cleared |
| SF-3 PrepRecipes qtyPerSale | Cleared |
| SF-4 BrandsSection access-gate | Cleared |
| SF-5 BrandsSection ListPane cluster | Cleared |
| N-6 common.adminOnly | Cleared |

2 new Should-fix surfaced. 1 new Nit. R2 nits 1-5 carry forward unchanged.

## Handoff
next_agent: NONE
prompt: 0 Critical, 2 Should-fix (sibling untranslated strings), 1 new Nit. R2 fixes verified clean.
