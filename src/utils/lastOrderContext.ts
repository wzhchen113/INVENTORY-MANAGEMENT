// src/utils/lastOrderContext.ts
//
// Spec 151 (§5.3) — PURE, framework-free formatter for the "last time" context
// sub-line rendered under each order line on the three ordering surfaces (phone
// `VendorOrderCard`, which serves BOTH PhoneOrdering and PhoneApproveOrder, and
// the desktop `ReorderSection` item row).
//
// Peer to `poCaseDisplay.ts` / `reorderExport.ts` and held to the same purity
// discipline: NO React, NO supabase, NO theme, NO i18n import. Its only imports
// are `isCaseRow` / `poOrderedToCases` from `./poCaseDisplay` (AC-4: base units
// in, display units out, and NO second conversion helper) plus types.
//
// Design guidance 2: this returns a DISCRIMINATED RESULT, never a pre-formatted
// string, so each tier renders its own tokens and the two tiers cannot drift.
//
// HONESTY RULE (AC-10, binding). This module may not read — and by the `Pick<>`
// on its argument type literally CANNOT read — `suggestedQty`, `suggestedUnits`,
// `suggestedCases`, `parLevel`, `parReplacement`, `usageForecasted`,
// `pendingPoQty`, `estimatedCost`, `costPerUnit`, or any reorder edit buffer.
// The ordered figure comes from the persisted anchor order or it is `null`.
// Do NOT widen the `Pick<>` to `ReorderItem`.

import { isCaseRow, poOrderedToCases } from './poCaseDisplay';
import type {
  LastOrderContext,
  LastOrderContextVendor,
  OnHandSource,
  ReorderItem,
} from '../types';

/** A quantity in DISPLAY units — cases (`CS`) for a case row, base units
 *  (the item's own unit token) otherwise. `value` is EXACT, not rounded:
 *  the tier formats it with `formatQty` (85/6 → "14.17"), matching
 *  `poOrderedDisplay`'s honesty rule. */
export type LastOrderQty = { value: number; unitLabel: string };

export type LastOrderDelta = {
  direction: 'up' | 'down' | 'same';
  value: number;
  unitLabel: string;
};

/**
 * The per-line result.
 *  - `{ kind: 'none' }`  — nothing renders (no anchor for this vendor, or the
 *    context has not loaded / failed; R-G's `null` is resolved by the caller
 *    through `lastOrderCardState`).
 *  - `{ kind: 'line' }`  — the context sub-line. `counted: null` ⇒ omit the
 *    COUNTED clause entirely (AC-7, no `0` and no `—`); `ordered: null` ⇒ the
 *    NOT ORDERED copy (AC-8), which is only ever emitted alongside an identified
 *    anchor date (design guidance 7).
 */
export type LastOrderLine =
  | { kind: 'none' }
  | {
      kind: 'line';
      /** The anchor's business date, `YYYY-MM-DD`. */
      dateIso: string;
      counted: LastOrderQty | null;
      ordered: LastOrderQty | null;
      /** AC-3 — the anchor is `recorded` (a draft PO / an approved-but-not-
       *  ordered approval), not a confirmed placed order. */
      notConfirmed: boolean;
      /** AC-11; `null` ⇒ suppressed (AC-12 / R-F) or not computable. */
      delta: LastOrderDelta | null;
    };

export type LastOrderCardState = 'hidden' | 'empty' | 'present';

/** The row-grain flag meaning "the vendor rolled up to EOD but THIS row fell
 *  back to `current_stock`" — R-F: comparing that estimate to a real physical
 *  count is the fabricate trap AC-12 forbids, so the delta is suppressed. */
const EOD_MISSING_FOR_ITEM = 'eod_missing_for_item';

/** Below `formatQty`'s 2-dp resolution — a delta this small would render as
 *  "0", so it is reported as "same as last count" instead. */
const SAME_EPSILON = 0.005;

function toDisplay(base: number, caseQty: number, unit: string): LastOrderQty {
  return isCaseRow(caseQty)
    ? { value: poOrderedToCases(base, caseQty), unitLabel: 'CS' }
    : { value: base, unitLabel: unit };
}

/**
 * R-G tri-state. The store slice is `LastOrderContext | null`:
 *   - `null`               → `'hidden'`  — NOT LOADED (or the read failed).
 *                            Render nothing at all (AC-17: no context line, no
 *                            card-level line, no spinner, no toast).
 *   - loaded, vendor absent → `'empty'`  — AC-9's ONE card-level
 *                            "NO PRIOR ORDER ON RECORD" line.
 *   - loaded, vendor present→ `'present'`— per-line context.
 *
 * Without the tri-state every card would read NO PRIOR ORDER ON RECORD for the
 * whole load window — a lie the honesty rule forbids.
 */
export function lastOrderCardState(
  context: LastOrderContext | null,
  vendorId: string,
): LastOrderCardState {
  if (!context) return 'hidden';
  return context[vendorId] ? 'present' : 'empty';
}

/**
 * Build the per-line context for one order row.
 *
 * `vendorContext` is `context[vendor.vendorId]` (or `null` when the context is
 * unloaded / the vendor has no anchor). `onHandSource` is the VENDOR's
 * `onHandSource` from the reorder payload — the delta gate (AC-12).
 */
export function buildLastOrderContext(args: {
  item: Pick<ReorderItem, 'itemId' | 'caseQty' | 'unit' | 'onHand' | 'flags'>;
  vendorContext: LastOrderContextVendor | null;
  onHandSource: OnHandSource;
}): LastOrderLine {
  const { item, vendorContext, onHandSource } = args;
  if (!vendorContext) return { kind: 'none' };

  const entry = vendorContext.items[item.itemId];
  const caseQty = item.caseQty;
  const unit = item.unit;

  // `== null` (not `??`) on BOTH quantities — `null` and `0` are semantically
  // different here (R-10). `null` = "not on that order" / "no count entry";
  // `0` = "ordered zero" / "counted zero". Collapsing them would silently turn
  // AC-8's NOT ORDERED into "ORDERED 0".
  const orderedBase = entry?.orderedQtyBase ?? null;
  const countedBase = entry?.countedQtyBase ?? null;

  const ordered = orderedBase == null ? null : toDisplay(orderedBase, caseQty, unit);
  const counted = countedBase == null ? null : toDisplay(countedBase, caseQty, unit);

  // AC-11 / AC-12 / R-F — the delta needs a REAL count on both sides.
  let delta: LastOrderDelta | null = null;
  const rowFellBackToStock = (item.flags || []).includes(EOD_MISSING_FOR_ITEM);
  if (countedBase != null && onHandSource === 'eod' && !rowFellBackToStock) {
    const d = toDisplay(item.onHand - countedBase, caseQty, unit);
    const direction: LastOrderDelta['direction'] =
      Math.abs(d.value) < SAME_EPSILON ? 'same' : d.value > 0 ? 'up' : 'down';
    delta = { direction, value: Math.abs(d.value), unitLabel: d.unitLabel };
  }

  return {
    kind: 'line',
    dateIso: vendorContext.lastOrderDate,
    counted,
    ordered,
    // AC-3 — a `recorded` anchor (draft PO / approved-not-ordered approval)
    // carries the muted NOT CONFIRMED qualifier.
    notConfirmed: vendorContext.confidence === 'recorded',
    delta,
  };
}

// ── i18n key selection (shared so the two tiers cannot drift) ───────────────
//
// AC-26 — each variant is ONE template with all of its placeholders; the tiers
// never `+`-join localized fragments. This helper picks the key and builds the
// interpolation vars; the TIER owns `T()`, `formatQty`, and every style token.
// `NOT CONFIRMED` and the delta marker are SEPARATE keys rendered as sibling
// <Text> nodes (AC-3 tone, AC-13 neutrality), never concatenated into the
// sentence.

export type LastOrderSentence = {
  key:
    | 'section.reorder.lastOrderFull'
    | 'section.reorder.lastOrderNoCounted'
    | 'section.reorder.lastOrderNotOrdered'
    | 'section.reorder.lastOrderNotOrderedNoCounted';
  vars: Record<string, string>;
};

/**
 * Pick the sentence template + vars for a `kind: 'line'` result.
 * `fmt` is the tier's number formatter (`formatQty`) — injected so this module
 * stays free of the reorderExport/papaparse import chain.
 */
export function lastOrderSentence(
  line: Extract<LastOrderLine, { kind: 'line' }>,
  fmtDate: (iso: string) => string,
  fmtQty: (n: number) => string,
): LastOrderSentence {
  const date = fmtDate(line.dateIso);
  const qty = (q: LastOrderQty) => `${fmtQty(q.value)} ${q.unitLabel}`.trim();
  if (line.ordered && line.counted) {
    return {
      key: 'section.reorder.lastOrderFull',
      vars: { date, counted: qty(line.counted), ordered: qty(line.ordered) },
    };
  }
  if (line.ordered) {
    return {
      key: 'section.reorder.lastOrderNoCounted',
      vars: { date, ordered: qty(line.ordered) },
    };
  }
  if (line.counted) {
    return {
      key: 'section.reorder.lastOrderNotOrdered',
      vars: { date, counted: qty(line.counted) },
    };
  }
  // R-I — an anchor exists but this item is on neither the anchor order nor the
  // anchoring count. Still anchored (the date is rendered), so the NOT ORDERED
  // claim stays a statement about an identified order.
  return { key: 'section.reorder.lastOrderNotOrderedNoCounted', vars: { date } };
}

export type LastOrderDeltaText = {
  key:
    | 'section.reorder.lastOrderDeltaUp'
    | 'section.reorder.lastOrderDeltaDown'
    | 'section.reorder.lastOrderDeltaSame';
  vars: Record<string, string>;
};

/** The trailing trend marker's key + vars, or `null` when suppressed. */
export function lastOrderDeltaText(
  delta: LastOrderDelta | null,
  fmtQty: (n: number) => string,
): LastOrderDeltaText | null {
  if (!delta) return null;
  if (delta.direction === 'same') {
    return { key: 'section.reorder.lastOrderDeltaSame', vars: {} };
  }
  return {
    key:
      delta.direction === 'up'
        ? 'section.reorder.lastOrderDeltaUp'
        : 'section.reorder.lastOrderDeltaDown',
    vars: { qty: `${fmtQty(delta.value)} ${delta.unitLabel}`.trim() },
  };
}

// ── Date rendering ──────────────────────────────────────────────────────────
// AC-1's `{date}` — the anchor's business date in the existing short form
// ("JUL 29"). Parsed from the ISO parts by hand (NOT `new Date(iso)`, whose
// UTC-midnight parse shifts the day in western time zones) and rendered from a
// fixed month table so the output is deterministic across locale + TZ. Shared
// by both tiers so the phone and desktop lines read identically.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatLastOrderDate(iso: string): string {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-');
  const mi = parseInt(m, 10) - 1;
  const day = parseInt(d, 10);
  if (!y || !Number.isFinite(mi) || mi < 0 || mi > 11 || !Number.isFinite(day)) {
    return String(iso || '');
  }
  return `${MONTHS[mi]} ${day}`;
}
