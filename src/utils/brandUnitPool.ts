// src/utils/brandUnitPool.ts — Spec 096 (Issue 1: brand-shared custom unit names).
//
// Pure helper that derives the brand-scoped pool of custom unit NAMES from data
// already loaded in the admin Zustand store. There is NO `brand_custom_units`
// table (spec 096 §Q-C = (ii) derived-at-read-time).
//
// Source = `catalogIngredients` (NOT `inventory`). This is both the secure and
// the semantically-correct axis:
//   - SECURITY (AC3): `catalogIngredients` is brand-level data — the store loads
//     exactly the active brand's catalog (useStore.ts: "Brand-level data … is
//     the SAME across all stores so we just take the first store's copy"). By
//     contrast `inventory` is flat-mapped across EVERY store the caller can see
//     (useStore.ts:985) and `inventory_items` RLS short-circuits on
//     `auth_is_admin()` with no brand pin, so an admin/master sees rows across
//     brands. Sourcing the pool from `inventory` therefore leaked brand B's unit
//     names into brand A's dropdowns the moment a 2nd brand existed — the spec
//     096 security finding. `catalogIngredients` is brand-scoped by construction.
//   - CORRECTNESS: custom units are authored on `catalog_ingredients` via the
//     IngredientForm; `inventory_items` only FK back to the catalog row (the
//     "source of truth for name/unit/sub_unit_unit"). So the catalog is a
//     superset of the brand's unit names — switching the source loses nothing.
//
// The pool is the union of BOTH unit axes across every catalog ingredient plus
// every conversion's purchase unit:
//   { distinct catalogIngredients.unit } ∪
//   { distinct catalogIngredients.subUnitUnit } ∪
//   { distinct conversions.purchaseUnit }
// De-duped on `lower(name)`, value preserves first-seen casing — mirroring the
// `catalog_ingredients_brand_name_lower_unique` precedent (AC5).
//
// Why union BOTH axes (the AC1 gap-closer): a custom name like "Pack" committed
// on one ingredient can land in EITHER that ingredient's `unit` OR its
// `subUnitUnit`. Today the default-unit dropdown unions only conversion
// purchase units and the pack-unit dropdown unions nothing derived, so a name
// saved as a sibling's `subUnitUnit` never propagates. Unioning both axes here
// and feeding the result into BOTH dropdowns is what makes a shared name appear
// everywhere on next form open.

/**
 * Derive the de-duped, case-folded list of brand unit NAMES.
 *
 * - De-dupe key is `lower(name.trim())`; the returned value preserves the
 *   FIRST-seen casing for that key (so "Pack" beats a later "pack").
 * - Empty / whitespace-only names are skipped.
 * - Iteration order: all `catalogIngredients.unit`, then all
 *   `catalogIngredients.subUnitUnit`, then all `conversions.purchaseUnit` —
 *   first-seen-wins follows that order.
 * - Returns an unsorted array (callers fold it into their own option sets and
 *   sort there, exactly as they already do for conversion-derived units).
 */
export function deriveBrandUnitPool(args: {
  catalogIngredients: { unit: string; subUnitUnit: string }[];
  conversions: { purchaseUnit: string }[];
}): string[] {
  const seen = new Map<string, string>(); // lower(name) -> first-seen original

  const add = (raw: string | null | undefined): void => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };

  for (const it of args.catalogIngredients) add(it.unit);
  for (const it of args.catalogIngredients) add(it.subUnitUnit);
  for (const c of args.conversions) add(c.purchaseUnit);

  return Array.from(seen.values());
}
