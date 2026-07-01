// src/utils/perEachCost.ts — Spec 096 (Issue 2: dual case/each cost display).
//
// Two pure helpers, additive to the existing cost math. They do NOT change
// the spec-093 `costPerUnit` fallback at `db.ts:3769-3779` (AC7) — they
// CONSUME its already-computed output. Placed under src/utils/ (not db.ts)
// because they touch no Supabase and consume already-mapped camelCase shapes.
//
// The whole point of this module is the single `piecesPerCase` formula: the
// editor case-size preview (IngredientForm) and the catalog-row per-each price
// (InventoryCatalogMode) BOTH import it, so the two surfaces can never drift
// (spec 096 §Q-A "must use the same piecesPerCase helper").

/**
 * The true per-case smallest-unit count for an ingredient.
 *
 * `piecesPerCase = caseQty × subUnitSize`, with each factor defaulting to `1`
 * when absent / zero / non-finite (mirrors `mapItem`'s `parseFloat(...) || 1`
 * at `db.ts:3761-3762`).
 *
 * Spec 096 §Q-A: this is a TOTAL function over the two axes spec 093 defined —
 *   - `caseQty`     = units-per-case (the Reorder/EOD axis), and
 *   - `subUnitSize` = sub-units per ONE tracking unit (the recipe-costing axis).
 * Because a legacy packaging item (Cup: caseQty=1, subUnitSize=2000) and a bulk
 * item (flour: caseQty=20, subUnitSize=1) put their real count on DIFFERENT
 * axes, multiplying the two can never double-count, and an item that uses both
 * axes (case of 4 bags × 10 each → 40) is also correct. No "which field holds
 * the truth" heuristic is needed — that is the property AC9 demands.
 */
export function piecesPerCase(caseQty: number, subUnitSize: number): number {
  const qty = Number.isFinite(caseQty) && caseQty > 0 ? caseQty : 1;
  const size = Number.isFinite(subUnitSize) && subUnitSize > 0 ? subUnitSize : 1;
  return qty * size;
}

/**
 * The per-smallest-unit (per-each) cost for an ingredient, or `null` when
 * there is no meaningful per-each breakdown (`piecesPerCase <= 1`).
 *
 * A `null` return is the signal to "render the single price, AC8" — the
 * caller MUST NOT print a per-each segment when this returns `null`.
 *
 * Resolution (spec 096 §Q-A "Per-each cost derivation"):
 *   1. If `piecesPerCase <= 1` → `null` (tracking unit == smallest unit).
 *   2. Primary path — `casePrice / piecesPerCase` when `casePrice > 0`.
 *      `casePrice` is the whole-case purchase price, so dividing by the real
 *      per-case piece count yields the per-piece cost directly. This is the
 *      AC7-correct axis: it divides by `caseQty × subUnitSize`, never just
 *      `caseQty` (so it can't re-introduce the spec-093 12×-error) and never
 *      touches the `db.ts` fallback.
 *   3. Fallback when `casePrice` is 0 / unset — the per-each cost IS
 *      `costPerUnit` itself. Spec 104 made `cost_per_unit` (and the `db.ts`
 *      no-stored-cost fallback) per-EACH end-to-end, so `costPerUnit` is already
 *      the per-each value — dividing it by `subUnitSize` again (the pre-104
 *      behavior) would shrink it `sub_unit_size×` (double-divide). The fallback
 *      is therefore IDENTITY now. Returns `null` if neither price basis is
 *      positive.
 */
export function perEachCost(args: {
  casePrice: number;    // g.primary.casePrice — the whole-case purchase price
  costPerUnit: number;  // the already-computed per-tracking-unit cost (avgCost in the row)
  caseQty: number;
  subUnitSize: number;
}): number | null {
  const { casePrice, costPerUnit, caseQty, subUnitSize } = args;
  const pieces = piecesPerCase(caseQty, subUnitSize);
  // AC8 — no breakdown: tracking unit IS the smallest unit. Single price.
  if (pieces <= 1) return null;

  // Primary path: whole-case price ÷ real per-case piece count.
  if (Number.isFinite(casePrice) && casePrice > 0) {
    return casePrice / pieces;
  }

  // Fallback (spec 104): `costPerUnit` is ALREADY per-each end-to-end, so the
  // per-each cost is `costPerUnit` itself — identity, NOT `costPerUnit /
  // subUnitSize` (that was the pre-104 double-divide). `subUnitSize` is no
  // longer read here; `pieces > 1` above still gates that we only render a
  // per-each segment when the tracking unit differs from the smallest unit.
  if (Number.isFinite(costPerUnit) && costPerUnit > 0) {
    return costPerUnit;
  }

  return null;
}
