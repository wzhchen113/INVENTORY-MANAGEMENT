# Code review — Spec 004 (Ingredient form lookups) — re-review after fix-pass

Reviewer: code-reviewer
Date: 2026-05-06 (re-review)

## Prior-finding status key

Each finding from the original review is marked:
- **RESOLVED** — code change fully addresses the finding.
- **STILL-OPEN** — the finding was not addressed or only partially addressed.
- **NEW** — introduced by the fix-pass; not present in the original code.

---

## Prior Criticals

**C1 — `ingredientConversions` initialized as `[] as any[]`; `AppState.ingredientConversions` typed optional.**
RESOLVED. `src/types/index.ts:381` now declares `ingredientConversions: IngredientConversion[]` (non-optional). `src/store/useStore.ts:190` initializes as `[] as IngredientConversion[]`. The cascading fix propagated cleanly.

**C2 — `(s: any)` selectors on `addIngredientConversion` / `updateIngredientConversion` / `deleteIngredientConversion` in `InventoryCatalogMode.tsx`.**
RESOLVED. `src/screens/cmd/sections/InventoryCatalogMode.tsx:579-582` — all three action selectors now use untyped-but-inferred `(s) => s.*` without `(s: any)`.

**C3 — `(c: any)` cast hiding dead `c.catalogId` branch in `allConversions.filter(...)` and `(sel.primary as any).catalogId` in `writeCatalogId`.**
RESOLVED. `InventoryCatalogMode.tsx:594` — filter is now `allConversions.filter((c) => ids.has(c.inventoryItemId))` with typed `c`. `writeCatalogId` at line 600 uses `sel.primary.catalogId` directly without `as any`. Dead `c.catalogId` branch is gone.

---

## Prior Should-fixes

**S1 — Dead toast/warning path in `CategoriesSection` DELETE when `disabled={count > 0}` prevented `handleDelete` from firing.**
RESOLVED. `src/screens/cmd/sections/CategoriesSection.tsx:229-238` — DELETE button has no `disabled` prop. `handleDelete` fires unconditionally and surfaces the in-use count as both a Toast and an inline `setWarning` (lines 86-93). Both mechanisms are live and one code path controls the outcome — no dead branch.

**S2 — Snake_case fallbacks (`conv.purchase_unit`, `conv.base_unit`, `conv.conversion_factor`, `conv.net_yield_pct`) and `(conv: any)` casts in display rows and `startEdit`.**
RESOLVED. Display rows at `InventoryCatalogMode.tsx:855-862` use `conv.purchaseUnit`, `conv.baseUnit`, `conv.conversionFactor`, `conv.netYieldPct` directly. `startEdit` at lines 672-677 uses typed access. `(conv: any)` is gone throughout.

**S3 — `(s: any)` cast in `IngredientForm.tsx:290` on the `ingredientConversions` selector.**
RESOLVED. `src/components/cmd/IngredientForm.tsx:289` — `useStore((s) => s.ingredientConversions)` with no cast.

**S4 — `NUMERIC_RE` / `isNumericInput` duplicated in two files.**
RESOLVED (as a de-duplication). `src/utils/validators.ts` is a new file (lines 1-27) that owns both `NUMERIC_RE` and `isNumericInput`. `IngredientForm.tsx:8` imports `isNumericInput`; `InventoryCatalogMode.tsx:21` imports `NUMERIC_RE`. There are no inline definitions remaining in either consumer. See New finding N1 below regarding inconsistent use of the two exports.

**S5 — `updateIngredientConversion` return value discarded in the store action.**
RESOLVED. `src/store/useStore.ts:530-535` — the action now chains `.then((saved) => set((s) => ({ ingredientConversions: s.ingredientConversions.map((c) => (c.id === id ? saved : c)) })))`, mirroring the `addIngredientConversion` pattern.

**S6 — `each` carve-out from `abstractUnitWarning` undocumented.**
RESOLVED. `src/components/cmd/IngredientForm.tsx:368-373` — a three-line comment explains that `each` is a count-based tracking unit resolved via `subUnitSize × subUnitUnit`, not via a base-unit conversion row, and cites spec 004 §7 and architect N1. The comment explains *why*, not just *that*.

---

## Prior Nits

**N1 — Temp-id generation departs from `makeId` convention.**
STILL-OPEN. `src/store/useStore.ts:504` — `_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` remains unchanged. This was a Nit in the first review; it is still a Nit now. It does not block ship.

**N2 — `typeof action === 'function'` guards on action calls.**
RESOLVED. All three action calls (`addIngredientConversion` at line 662, `updateIngredientConversion` at line 703, `deleteIngredientConversion` at line 717) are called directly without runtime type guards.

**N3 — `SelectField` import coupling (`from '../../../components/cmd/IngredientForm'`).**
STILL-OPEN. `InventoryCatalogMode.tsx:16` still imports `SelectField` from `IngredientForm`. Release proposal marked this deferred; still a Nit.

**N4 — Conversions-list header label `base unit "{sel.unit}"` misleading.**
STILL-OPEN. `InventoryCatalogMode.tsx:804` — `{conversions.length} rows · base unit "{sel.unit}"` — `sel.unit` is the item's tracking unit, not the `base_unit` column on `ingredient_conversions`. Release proposal marked this deferred; still a Nit.

**N5 — `c.purchaseUnit || c.purchase_unit` snake_case fallback in `defaultUnitOptions`.**
RESOLVED. `IngredientForm.tsx:300` now uses only `c.purchaseUnit`.

**N6 — Backfill SQL duplication (`v_has_inv_category` true vs false branches differ only in one `union all` leg).**
STILL-OPEN. `supabase/migrations/20260507010946_spec004_ingredient_categories_backfill.sql:38-82` — unchanged, two nearly identical CTE blocks. Release proposal marked this deferred; still a Nit.

---

## New findings introduced by the fix-pass

### Critical

None.

### Should-fix

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:562` and `src/components/cmd/IngredientForm.tsx:92` — **Inconsistent use of `NUMERIC_RE` vs `isNumericInput` across the two consumers of `validators.ts`.** `InventoryCatalogMode.tsx` imports and calls `NUMERIC_RE.test(v)` directly; `IngredientForm.tsx` imports and calls the wrapper `isNumericInput(v)`. Both work correctly today, but the split means any future change to the validation shape (e.g., adding a max-length guard) must be applied in both call sites instead of once inside `isNumericInput`. Use `isNumericInput` everywhere — it is the exported abstraction, `NUMERIC_RE` is the implementation detail. Change `InventoryCatalogMode.tsx:21` import to `{ isNumericInput }` and `line 562` from `NUMERIC_RE.test(v)` to `isNumericInput(v)`.

### Nits

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:562` — `if (v === '' || NUMERIC_RE.test(v)) onChange(v)` has a redundant `v === ''` guard: `NUMERIC_RE` (and `isNumericInput`) already accepts the empty string per the regex's third alternation `|)`. The guard is harmless but misleading — it implies the empty-string case isn't handled by the regex when it is. Remove `v === ''` and replace with `if (isNumericInput(v)) onChange(v)` (folded into the Should-fix above).

- `src/components/cmd/IngredientForm.tsx:92` — Same redundant `next !== ''` guard: `if (numericOnly && next !== '' && !isNumericInput(next)) return;`. Since `isNumericInput('')` returns `true`, the `next !== ''` short-circuit is dead logic. Remove it: `if (numericOnly && !isNumericInput(next)) return;`.

- `src/store/useStore.ts:504` — (STILL-OPEN from prior review) Temp-id pattern departs from the file's `makeId` convention. Nit; does not block ship.

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:16` — (STILL-OPEN from prior review) `SelectField` imported from `IngredientForm`. Nit; does not block ship.

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:804` — (STILL-OPEN from prior review) Misleading "base unit" label. Nit; does not block ship.

- `supabase/migrations/20260507010946_spec004_ingredient_categories_backfill.sql:38-82` — (STILL-OPEN from prior review) Duplicate CTE logic across two branches. Nit; does not block ship.

---

## Summary

**0 Critical, 1 Should-fix, 5 Nits.**

All 3 prior Criticals are RESOLVED. All 6 prior Should-fixes are RESOLVED. 4 of 6 prior Nits are RESOLVED (N2 and N5); the other 4 (N1, N3, N4, N6) are still open but were explicitly deferred by the release proposal and do not block ship.

The fix-pass introduced one new Should-fix: `InventoryCatalogMode.tsx` uses `NUMERIC_RE` directly while `IngredientForm.tsx` uses the `isNumericInput` wrapper — both from the same `validators.ts` — and the consumer-side inconsistency undermines the abstraction. Fix is a two-line change: swap the import and the call site in `InventoryCatalogMode.tsx`.

The new RLS migration (`20260507015244_spec004_ingredient_categories_rls_p6.sql`) is correct: uses `public.auth_is_admin()` on all write paths, uses `auth.uid() IS NOT NULL` for SELECT, drops the permissive `auth_manage_ingredient_categories` policy idempotently. No inline JWT checks.

The `validators.ts` regex `/^(\d+\.?\d*|\d*\.\d+|)$/` correctly rejects the lone `.` as the security-auditor required: the first alternation requires a leading digit; the second requires at least one trailing digit; the third matches empty only. Confirmed against all test cases the auditor specified.
