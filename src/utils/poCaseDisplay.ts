// src/utils/poCaseDisplay.ts
//
// Spec 134 — PURE, framework-free units⇄cases conversion for the PO order-lines
// table (POsSection). Extract-and-pin sibling of `poQuickOrderText.ts` /
// `formatQty.ts` — same domain, same `src/utils` home, same purity discipline:
// no React, no supabase, no theme, no i18n import; jest-covered byte-for-byte.
// Its ONLY import is `formatQty` (reused for "up to 2 dp, trailing zeros
// dropped, whole = clean": 85/6 → "14.17", 84/6 → "14").
//
// The owner mentally orders in CASES (French Fries 84 units at 6/case = 14
// cases). Storage is untouched: `po_items.ordered_qty` stays BASE units,
// `po_items.cost_per_unit` stays per-COUNTED-unit (spec-107 OQ-6). This module
// converts base ⇄ cases for DISPLAY + the edit write-back only. The AC-4
// identity `cases × casePrice = orderedQty × costPerUnit` keeps LINE $ and the
// subtotal byte-identical, so no schema / RLS / API change is needed.
//
// `caseQty` is normalized via a `> 1` predicate everywhere (mirrors the
// `coalesce(caseQty, 1)` divide-safety in `computePoQuickOrderLines` and the
// `(it.caseQty || 0) > 1` inventory-count precedent): null / 0 / 1 / <1 / NaN
// all mean "no case" → the row stays in units.

import { formatQty } from './formatQty';

/**
 * True when the line's item ships more than one to a case (so the row reads +
 * edits in cases). `NaN` / `null`-coerced / `0` / `1` / `<1` → `false` (a unit
 * row). PURE + total.
 */
export function isCaseRow(caseQty: number): boolean {
  return Number.isFinite(caseQty) && caseQty > 1;
}

/**
 * Base units → the value shown in the ORDERED column. Case rows: EXACT
 * `orderedQty / caseQty` (NOT rounded — AC-5 shows the truth, e.g. 85/6 =
 * 14.1666…). Unit rows: `orderedQty` verbatim.
 */
export function poOrderedToCases(orderedQty: number, caseQty: number): number {
  return isCaseRow(caseQty) ? orderedQty / caseQty : orderedQty;
}

/**
 * The edited display value → the BASE-unit quantity written to
 * `po_items.ordered_qty`. Case rows: `round(cases) × caseQty` (AC-2 — the write
 * is always a whole-case product). Unit rows: `cases` verbatim (today's raw
 * write, fractional units included).
 */
export function poCasesToBase(cases: number, caseQty: number): number {
  return isCaseRow(caseQty) ? Math.round(cases) * caseQty : cases;
}

/**
 * The UNIT $ column value. Case rows: the CASE price `costPerUnit × caseQty`
 * (AC-3). Unit rows: `costPerUnit` verbatim. `costPerUnit` is per-COUNTED-unit
 * (spec-107 OQ-6) — NO ×subUnitSize bridge (spec-104 dep).
 */
export function poCasePrice(costPerUnit: number, caseQty: number): number {
  return isCaseRow(caseQty) ? costPerUnit * caseQty : costPerUnit;
}

/**
 * The display string for the ORDERED cell — the seed for BOTH the read-only
 * number AND the editable `TextInput` `defaultValue`. `formatQty` of the
 * cases (or units) value: "14", "14.17", etc.
 */
export function poOrderedDisplay(orderedQty: number, caseQty: number): string {
  return formatQty(poOrderedToCases(orderedQty, caseQty));
}

/**
 * Resolve an ORDERED-cell edit (AC-2 / AC-5, OQ-1). Returns whether to write
 * and the BASE-unit quantity to write.
 *
 * The display-string no-op is the PRIMARY guard — the true generalization of
 * today's `n === li.orderedQty`, now in the row's DISPLAY unit. This is what
 * prevents the 85→84 focus-blur corruption: the seed `formatQty(85/6)="14.17"`
 * is precision-lossy, so `round(14.17)×6 = 84 ≠ 85`; a base-vs-stored check
 * alone would WRITE 84 on an untouched fractional line. String-equality to the
 * seed catches the untouched-line case (any row kind) before that can happen.
 * The base-diff is the secondary check (e.g. "14.0" retyped vs seed "14").
 */
export function poResolveEdit(
  rawText: string,
  orderedQty: number,
  caseQty: number,
): { write: boolean; base: number } {
  const trimmed = rawText.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { write: false, base: orderedQty };
  // PRIMARY guard — untouched line (incl. a fractional focus+blur) reproduces
  // the seed string exactly → no write, no silent rounding.
  if (trimmed === poOrderedDisplay(orderedQty, caseQty)) {
    return { write: false, base: orderedQty };
  }
  const base = poCasesToBase(n, caseQty);
  // Secondary guard — different string, same base (e.g. "14.0" vs seed "14").
  if (base === orderedQty) return { write: false, base };
  return { write: true, base };
}
