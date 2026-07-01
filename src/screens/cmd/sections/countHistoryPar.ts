// src/screens/cmd/sections/countHistoryPar.ts
//
// Spec 105 — par-status + inline reorder math for the read-only inventory
// count history detail (`InventoryCountSection.tsx` → DetailFrame). PURE
// (framework-free: no React, no theme, no supabase) so the jest contract is
// cheap and importing this from a `.test.ts` does NOT pull the section's
// supabase import (which crashes at module load when EXPO_PUBLIC_SUPABASE_*
// is unset) — the same pure-logic pattern InventoryCountSection.customOrder
// and reorderExport.ts already use.
//
// Three concerns live here, all off the ENTRY + the store's CURRENT inventory
// row (OQ-1: current par, client-side join — no fetch for the par value):
//   1. `parStateFor` — the three visual states (above / below / none).
//   2. `buildCountedOnHandMap` — the { itemId → countedTotal } map the FE
//      hands to `fetchReorderForCountedOnHand`, built from ONLY the below-par,
//      resolvable, non-null-total rows (so the RPC never wastes work on rows
//      that won't render a suggestion — design §"Request shape").
//   3. `formatCountedReorderSuggestion` — the inline quantity/timing string
//      for a below-par row (NO cost — spec 105 out-of-scope). Mirrors the
//      reorder screen's `formatSuggested` cases·units convention + the
//      days-until label, minus any `$`.

import type { CountedReorderItem } from '../../../types';

// ── The minimal per-item shape the par join needs off the store `inventory`
// array (`InventoryItem` is a superset). Keeping the input structural (not the
// full `InventoryItem`) lets the jest test build tiny fixtures.
export interface ParInventoryRow {
  id: string;
  parLevel: number;
  caseQty: number;
  unit: string;
}

// ── The minimal per-entry shape (`InventoryCountEntry` is a superset).
export interface ParCountEntry {
  itemId: string;
  actualRemaining: number | null;
}

export type ParState = 'above' | 'below' | 'none';

/**
 * The three par states, from the entry's counted total vs the item's CURRENT
 * par level (OQ-1). `none` (NO marker — OQ-4) when there is nothing to compare:
 *   - the item is not resolvable in the current inventory (`item == null`,
 *     e.g. deleted since the count),
 *   - the item has no par set (`parLevel <= 0`), or
 *   - the entry recorded no total (`actualRemaining == null`).
 * Otherwise `above` when `actualRemaining >= parLevel` (green ✓), else `below`
 * (red dot + reorder suggestion).
 */
export function parStateFor(
  actualRemaining: number | null | undefined,
  parLevel: number | null | undefined,
): ParState {
  if (actualRemaining == null) return 'none';
  if (parLevel == null || parLevel <= 0) return 'none';
  return actualRemaining >= parLevel ? 'above' : 'below';
}

/**
 * Build the `{ itemId → countedTotal }` on-hand map the FE sends to
 * `fetchReorderForCountedOnHand`. Includes ONLY the entries that are below par
 * AND resolvable AND have a non-null total — i.e. exactly the rows that will
 * render a suggestion. At/above-par, no-par, unresolvable, and null-total rows
 * are omitted (the RPC would return nothing useful for them).
 *
 * `inventoryById` is the store's CURRENT inventory keyed by item id.
 */
export function buildCountedOnHandMap(
  entries: readonly ParCountEntry[],
  inventoryById: ReadonlyMap<string, ParInventoryRow>,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of entries) {
    const item = inventoryById.get(e.itemId);
    if (!item) continue;
    if (parStateFor(e.actualRemaining, item.parLevel) !== 'below') continue;
    // parStateFor('below') already guarantees actualRemaining != null.
    map[e.itemId] = e.actualRemaining as number;
  }
  return map;
}

// Quantity formatter — same rule as the reorder screen's `formatQty`
// (reorderExport.ts): round to 2dp, drop trailing zeros. Kept local to avoid
// pulling `papaparse` (a non-zero runtime dep imported by reorderExport.ts)
// into this pure module's graph + into jest runs that don't need it. (The
// ReorderItem type it also exports is erased at compile time — not the reason.)
function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}

// "today" / "tomorrow" / "in N days" — mirrors ReorderSection's daysLabel so
// the timing reads identically to the Reorder screen.
export function daysUntilLabel(daysUntil: number): string {
  if (daysUntil <= 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  return `in ${daysUntil} days`;
}

/**
 * The inline below-par suggestion string (quantity + timing, NO cost).
 * Composition mirrors the Reorder screen's Suggested cell + next-delivery
 * label:
 *   - order:  `N cases · M unit` for case items (caseQty > 1 → suggestedCases
 *     non-null), else `Q unit`.
 *   - forecast: `forecast F unit` when the usage-forecast component is > 0
 *     (the driver behind an order beyond the raw par gap).
 *   - timing: `deliver <date> (in N days)` when a delivery date is known, else
 *     the bare days-until label.
 *
 * `unit` comes from the count entry / inventory row (CountedReorderItem carries
 * no unit — it is cost-free and unit-free by design). Returns '' only if there
 * is genuinely nothing to say (defensive; callers gate on presence first).
 */
export function formatCountedReorderSuggestion(
  item: CountedReorderItem,
  unit: string | null | undefined,
): string {
  const u = (unit || '').trim();
  const withUnit = (n: number) => (u ? `${formatQty(n)} ${u}` : formatQty(n));

  // Order quantity — cases·units for case items, else base-unit qty.
  const orderPart =
    item.suggestedCases != null
      ? `order ${formatQty(item.suggestedCases)} ${item.suggestedCases === 1 ? 'case' : 'cases'} · ${withUnit(item.suggestedUnits)}`
      : `order ${withUnit(item.suggestedQty)}`;

  const parts: string[] = [orderPart];

  // Usage-forecast component — only surface when it actually contributed
  // (> 0), otherwise the "order" figure already tells the whole story.
  if (item.usageForecasted > 0) {
    parts.push(`forecast ${withUnit(item.usageForecasted)}`);
  }

  // Delivery timing — the item's soonest vendor (server-collapsed min).
  const timing = item.nextDeliveryDate
    ? `deliver ${item.nextDeliveryDate} (${daysUntilLabel(item.daysUntil)})`
    : daysUntilLabel(item.daysUntil);
  parts.push(timing);

  return parts.join(' · ');
}
