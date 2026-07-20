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

import { formatQty } from './formatQty';

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

// ─── Spec 131 (D-1 / D-7) — the shared structured-line core ──────────────────
//
// ONE canonical case-math implementation, no forked builder (131 AC-5). The
// per-line order-unit conversion (spec 115), code resolution, and unmapped
// detection are computed HERE, once, by `computePoQuickOrderLines`. Both the
// text-blob builder (`buildPoQuickOrderText`, below) AND the spec-132 browser
// extension (which imports this exact file and calls `computePoQuickOrderLines`
// on the raw lines returned by the `get_extension_order_payload` RPC) derive
// from this core. The extension therefore authors NO case math of its own — it
// delegates to spec-115's shared conversion at its entry point (131 D-1).

// One structured order line — the AC-4 shape the extension consumes. `qty` is
// the order-unit-CONVERTED quantity (already ceil-to-cases for a 'case' vendor);
// `orderCode` is the trimmed code, or `null` when the item has no code for this
// vendor (surfaced, NEVER dropped — AC-4). `itemName` is the resolved
// (locale-aware) name. `unmapped` / `rounded` are the per-line fail-loud flags
// aggregated into the result's `unmappedCount` / `roundedCount`.
export interface StructuredOrderLine {
  itemId: string;
  orderCode: string | null;
  itemName: string;
  qty: number;
  unit: 'case' | 'unit';
  unmapped: boolean;
  rounded: boolean;
}

export interface PoQuickOrderLinesResult {
  lines: StructuredOrderLine[];
  unmappedCount: number;
  roundedCount: number;
}

/**
 * Spec 131 (D-7) — the extracted structured-line core. PURE + total; returns
 * `{ lines: [], unmappedCount: 0, roundedCount: 0 }` for empty input. This is
 * the single implementation of the spec-115 order-unit conversion + the spec-114
 * code/name resolution; `buildPoQuickOrderText` (the byte-identical text blob)
 * and the spec-132 extension both derive from it.
 */
export function computePoQuickOrderLines(
  lines: PoQuickOrderLine[],
  resolveCode: CodeResolver,
  resolveName: NameResolver,
  orderUnit: 'case' | 'unit',
): PoQuickOrderLinesResult {
  const out: StructuredOrderLine[] = [];
  let unmappedCount = 0;
  let roundedCount = 0;
  for (const line of lines) {
    // ── Spec 115 (W-2) — order-unit conversion (the load-bearing correctness
    // surface). Computed BEFORE any formatting so the emitted number matches
    // the vendor's box unit. ──
    let emitQty: number;
    let rounded = false;
    if (orderUnit === 'case') {
      // coalesce(caseQty, 1) — never divide by 0/null; a null/0/1 case size
      // means the item has no case, so cases == units.
      const cq = line.caseQty && line.caseQty > 0 ? line.caseQty : 1;
      const exact = line.orderedQty / cq;
      emitQty = Math.ceil(exact);
      if (emitQty !== exact) {
        rounded = true;
        roundedCount += 1;
      }
    } else {
      emitQty = line.orderedQty; // 'unit' → counted units verbatim (spec 114).
    }
    const rawCode = resolveCode(line.itemId);
    const code = (rawCode ?? '').trim();
    const unmapped = code.length === 0;
    if (unmapped) unmappedCount += 1;
    out.push({
      itemId: line.itemId,
      orderCode: unmapped ? null : code,
      // Resolve the name for EVERY line so the structured payload always carries
      // it; the text blob only emits it on the unmapped path (byte-identical).
      itemName: resolveName(line.itemId, line.itemName),
      qty: emitQty,
      unit: orderUnit,
      unmapped,
      rounded,
    });
  }
  return { lines: out, unmappedCount, roundedCount };
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
  // Spec 131 (D-7) — derive the text blob from the SHARED structured core. The
  // per-line output is byte-identical to the pre-extraction implementation:
  //   MAPPED    → `<order code>\t<formatQty(qty)>`
  //   UNMAPPED  → `??? <resolved item name>\t<formatQty(qty)>`
  // `qty` is the same order-unit-converted number; `formatQty` is applied here,
  // NOT in the core (the extension formats differently / not at all).
  const { lines: structured, unmappedCount, roundedCount } = computePoQuickOrderLines(
    lines,
    resolveCode,
    resolveName,
    orderUnit,
  );
  const out = structured.map((s) => {
    const qty = formatQty(s.qty); // SAME formatQty; still no $; still TAB delim.
    return s.unmapped
      ? `${UNMAPPED_PREFIX}${s.itemName}${DELIM}${qty}`
      : `${s.orderCode}${DELIM}${qty}`;
  });
  return { text: out.join('\n'), unmappedCount, roundedCount };
}
