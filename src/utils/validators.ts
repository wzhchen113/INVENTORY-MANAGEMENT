// Shared keystroke-level numeric validator used by ingredient form inputs
// and the catalog conversions tab. Single source of truth — do not redefine
// inline. Spec 004 fix-pass de-duplicated this from
// `src/components/cmd/IngredientForm.tsx` and
// `src/screens/cmd/sections/InventoryCatalogMode.tsx`.

/**
 * Numeric input regex.
 *
 * Accepts:
 *   - empty string (= partial entry, allows clearing the field)
 *   - "1", "12", "123" (whole numbers)
 *   - "1.", "1.5" (decimal with leading digit)
 *   - ".5", ".25" (decimal with no leading digit)
 *
 * Rejects:
 *   - lone "." (parseFloat returns NaN, then `|| 0` would silently write 0)
 *   - any letters, spaces, or symbols
 *
 * Tightened from `/^\d*\.?\d*$/` per spec 004 fix-pass (security-auditor M2).
 */
export const NUMERIC_RE = /^(\d+\.?\d*|\d*\.\d+|)$/;

/** Returns true when `v` is a syntactically valid partial numeric input. */
export function isNumericInput(v: string): boolean {
  return NUMERIC_RE.test(v);
}
