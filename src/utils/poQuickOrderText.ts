// src/utils/poQuickOrderText.ts
//
// Spec 114 (D-9) — PURE, framework-free builder for the "Quick-order list"
// paste block. A single purchase order → a bare `<order code>\t<qty>` block a
// manager pastes straight into a vendor's web quick-order box (US Foods, Sysco,
// BJ's, Sam's Club, Webstaurant). Sibling to `src/utils/poShareText.ts` — same
// purity discipline: no React, no theme, no supabase, no i18n import;
// jest-covered byte-for-byte.
//
// Unlike `poShareText.ts` (a human-readable message body), THIS block is
// machine-facing: it is NOT localized (OQ-8) — the delimiter is a literal TAB
// and there is no header/label line. The ONE localized touch is the item name
// inside a `??? ` placeholder, which resolves in the current locale via the
// INJECTED `resolveName` (identical contract to `poShareText.ts`'s
// `NameResolver`) so an unmapped line reads the item in the operator's language.
//
// The order code is INJECTED as `resolveCode` (the caller closes over the
// hydrated `inventory` slice + the PO's `sel.vendorId`, mirroring the existing
// `resolveName` closure in `POsSection.onShare`) so this builder stays pure of
// the store — the same split-of-concerns as `poShareText.ts`.
//
// Spec 115 (W-2) — the builder is now ORDER-UNIT AWARE. The caller passes the
// PO/card vendor's `orderUnit` ('case' | 'unit', injected from the `vendors`
// slice) as a 4th positional param; for a 'case' vendor each line's counted-unit
// `orderedQty` is divided by `coalesce(caseQty, 1)` and rounded UP to whole
// cases (`Math.ceil`), and the builder returns a fail-loud `roundedCount`
// alongside `unmappedCount`. A 'unit' vendor keeps spec-114 verbatim behavior.
// The SAME builder is shared byte-for-byte by BOTH the PO share path
// (`POsSection.onShareQuickOrder`) and the Reorder-card export (W-3) — do NOT
// fork a second builder (spec flag).
//
// NO MONEY enters this builder. `PoQuickOrderLine` deliberately omits any cost
// field and this module never imports `formatMoney` — the pasted block carries
// NO `$` anywhere (spec 108 ruling, carried forward by spec 114 AC-7). A jest
// test asserts the output contains no `$`.

import { formatQty } from './reorderExport';

// One PO line, reduced to exactly what the paste block needs. NOTE: no cost /
// received field — no money enters the builder (AC-7: no `$` in the output).
// `itemName` is the plain-English `PoLine.itemName`, carried ONLY as the name
// resolver's per-line fallback (OQ-8) — it is emitted (via `resolveName`) only
// on the `??? ` placeholder path, never on a mapped line.
export interface PoQuickOrderLine {
  itemId: string; // = inventory_items.id — the resolver key for BOTH code + name
  itemName: string; // plain-English fallback name (routed through resolveName)
  orderedQty: number;
  // Spec 115 (W-2) — units-per-case for THIS line's item (`1` when the item has
  // no case size). Sourced from `PoLine.caseQty` (db.ts:1422) on the PO path and
  // `ReorderItem.caseQty` (types:816) on the reorder path — both already in
  // memory, so this is a pure add to the mapped line. Only consulted when the
  // vendor's `orderUnit === 'case'` (the counted-unit → whole-case conversion);
  // ignored for a `'unit'` vendor.
  caseQty: number;
}

// Injected code resolver — keeps the builder pure of the store. The CALLER
// passes `(itemId) => inventory.find(i => i.id === itemId)?.vendors.find(v =>
// v.vendorId === sel.vendorId)?.orderCode`, i.e. the order code for THIS line's
// item at the PO's vendor. Returns null/undefined/'' when the item has no link
// to that vendor, or the link carries no code — all three are treated as
// "unmapped" (the `??? ` placeholder path).
export type CodeResolver = (itemId: string) => string | null | undefined;

// Injected name resolver — identical contract to `poShareText.ts`'s
// `NameResolver`. Used ONLY on the unmapped `??? ` placeholder so the operator
// reads the missing item in the current locale (OQ-8); mapped lines never emit
// a name.
export type NameResolver = (itemId: string, fallbackName: string) => string;

export interface PoQuickOrderResult {
  // The paste-ready block (lines joined with `\n`; no trailing newline).
  text: string;
  // How many lines had NO code (null/blank/no matching link) — surfaced by the
  // caller as a warning toast + the inline preview, never silently dropped
  // (AC-9). Equals the number of `??? ` placeholder lines.
  unmappedCount: number;
  // Spec 115 (W-2 / OQ-6, AC-12) — how many `'case'` lines were rounded UP from
  // a fractional case count (`orderedQty` not an exact multiple of `caseQty`).
  // Sibling to `unmappedCount`: the FAIL-LOUD signal. The caller fires a summary
  // count warning on `roundedCount > 0` ("N items rounded up to whole cases").
  // There is NO inline `(rounded from X.Y)` sentinel in the block (it stays
  // machine-pasteable) — the count is the entire signal. Always `0` for a
  // `'unit'` vendor (no conversion) and for exact-multiple `'case'` lines.
  roundedCount: number;
}

// The `??? ` sentinel prefix on an unmapped line. Deliberately NOT a valid
// vendor code, so an operator who pastes without filling the gap produces a
// visibly-broken line the vendor box rejects rather than a silently-short
// order (the fail-loud posture — D-12).
const UNMAPPED_PREFIX = '??? ';
// Literal TAB delimiter between the code (or `??? name`) and the qty (OQ-6 —
// TAB pastes cleanly into the multi-column quick-order grids these vendors
// expose; a vendor code can contain a comma or hyphen but never a raw TAB).
const DELIM = '\t';

/**
 * Build the quick-order paste block for a single PO's (or reorder card's) lines.
 * PURE + total — returns `{ text: '', unmappedCount: 0, roundedCount: 0 }` for
 * empty input.
 *
 * Output format (byte-for-byte — see the jest pin), one line per input line in
 * input order, lines joined with `\n`:
 *
 *   MAPPED    →  `<order code>\t<formatQty(emitQty)>`
 *   UNMAPPED  →  `??? <resolved item name>\t<formatQty(emitQty)>`
 *
 * No header, no labels, no trailing count line (machine-facing — the counts are
 * surfaced separately by the caller as toasts). NO `$` anywhere.
 *
 * Spec 115 (W-2, AC-11/AC-12) — `emitQty` is the vendor-order-unit-converted
 * quantity, the SAME conversion for the mapped and unmapped paths (the `???`
 * placeholder still carries the converted qty):
 *
 *   orderUnit === 'case'  →  emitQty = Math.ceil( orderedQty / coalesce(caseQty, 1) )
 *                            (divide by `1` when caseQty is null/0/1 → cases ==
 *                             units; ROUND UP whole cases; count a rounded line
 *                             into `roundedCount` when it was a fraction).
 *   orderUnit === 'unit'  →  emitQty = orderedQty  (verbatim — spec 114 behavior).
 *
 * The fail-loud `roundedCount` is the ONLY rounding signal — there is NO inline
 * `(rounded from X.Y)` sentinel in the block (it stays machine-pasteable).
 */
export function buildPoQuickOrderText(
  lines: PoQuickOrderLine[],
  resolveCode: CodeResolver,
  resolveName: NameResolver,
  orderUnit: 'case' | 'unit',
): PoQuickOrderResult {
  const out: string[] = [];
  let unmappedCount = 0;
  let roundedCount = 0;
  for (const line of lines) {
    // ── Spec 115 (W-2) — order-unit conversion (the load-bearing correctness
    // surface). Computed BEFORE formatQty so the emitted number matches the
    // vendor's box unit. ──
    let emitQty: number;
    if (orderUnit === 'case') {
      // coalesce(caseQty, 1) — never divide by 0/null; a null/0/1 case size
      // means the item has no case, so cases == units.
      const cq = line.caseQty && line.caseQty > 0 ? line.caseQty : 1;
      const exact = line.orderedQty / cq;
      emitQty = Math.ceil(exact);
      // A fraction rounded up (orderedQty not an exact multiple of the case
      // size) is the fail-loud case — count it. Exact multiples (incl. cq===1)
      // leave roundedCount untouched.
      if (emitQty !== exact) roundedCount += 1;
    } else {
      emitQty = line.orderedQty; // 'unit' → counted units verbatim (spec 114).
    }
    const qty = formatQty(emitQty); // SAME formatQty; still no $; still TAB delim.
    const rawCode = resolveCode(line.itemId);
    const code = (rawCode ?? '').trim();
    if (code) {
      out.push(`${code}${DELIM}${qty}`);
    } else {
      unmappedCount += 1;
      const name = resolveName(line.itemId, line.itemName);
      out.push(`${UNMAPPED_PREFIX}${name}${DELIM}${qty}`);
    }
  }
  return { text: out.join('\n'), unmappedCount, roundedCount };
}
