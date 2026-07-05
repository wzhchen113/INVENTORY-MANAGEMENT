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
 * Build the quick-order paste block for a single PO's lines. PURE + total —
 * returns `{ text: '', unmappedCount: 0 }` for empty input.
 *
 * Output format (byte-for-byte — see the jest pin), one line per input line in
 * input order, lines joined with `\n`:
 *
 *   MAPPED    →  `<order code>\t<formatQty(orderedQty)>`
 *   UNMAPPED  →  `??? <resolved item name>\t<formatQty(orderedQty)>`
 *
 * No header, no labels, no trailing count line (machine-facing — the count is
 * surfaced separately by the caller as a toast). NO `$` anywhere.
 */
export function buildPoQuickOrderText(
  lines: PoQuickOrderLine[],
  resolveCode: CodeResolver,
  resolveName: NameResolver,
): PoQuickOrderResult {
  const out: string[] = [];
  let unmappedCount = 0;
  for (const line of lines) {
    const qty = formatQty(line.orderedQty);
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
  return { text: out.join('\n'), unmappedCount };
}
