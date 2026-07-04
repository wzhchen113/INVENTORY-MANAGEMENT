// src/screens/cmd/lib/itemMoney.ts — Spec 112 (★ single cost-definition module).
//
// The ONE definition of each per-store money string for the admin Inventory
// `items.tsv` surface. Both the full-width operational table
// (`InventoryTable.tsx`) AND the `DetailPane` header
// (`InventoryDesktopLayout.tsx`) consume these — so the two surfaces can never
// drift. A reviewer diff that shows a second, cell-local cost expression is a
// Critical (spec 112 ★ COSTING RULE).
//
// These carry the spec-104 per-EACH basis verbatim from the old inline
// expressions at `InventoryDesktopLayout.tsx:449` and `:456-459`:
//   - stock value   = currentStock × (costPerUnit || 0) × (subUnitSize || 1)
//   - cost / each   = costPerUnit ? `$${costPerUnit.toFixed(2)}` : '—'
//   - each label    = subUnitUnit || 'each'
//
// DO NOT reuse or extend `src/utils/perEachCost.ts` — that spec-096 helper is a
// DIFFERENT computation (`casePrice / piecesPerCase`, null-when-no-breakdown)
// and reusing it here would silently change the numbers. This module is the
// `:449` / `:456-459` semantics ONLY.
//
// Consumes already-camelCased inventory-slice fields; touches no Supabase.

/** Fields the money helpers read off an already-mapped inventory-slice item. */
export interface ItemMoneyFields {
  currentStock: number;
  costPerUnit?: number | null;
  subUnitSize?: number | null;
  subUnitUnit?: string | null;
}

/**
 * Stock value — the `InventoryDesktopLayout.tsx:449` expression verbatim.
 *
 * Spec 104 (OQ-5): `costPerUnit` is the per-EACH (smallest-unit) cost, so
 * multiplying by the counted `currentStock` needs the `× subUnitSize` bridge
 * to reach a per-counted-unit dollar total. Returns a Number so callers can
 * `.toFixed()`.
 */
export function stockValue(item: Pick<ItemMoneyFields, 'currentStock' | 'costPerUnit' | 'subUnitSize'>): number {
  return item.currentStock * (item.costPerUnit || 0) * (item.subUnitSize || 1);
}

/**
 * Stock-value display string — `$${stockValue.toFixed(0)}`. Matches the
 * `:460` detail-header rounding (`inventoryValue.toFixed(0)`, `$` prefix).
 */
export function formatStockValue(item: Pick<ItemMoneyFields, 'currentStock' | 'costPerUnit' | 'subUnitSize'>): string {
  return `$${stockValue(item).toFixed(0)}`;
}

/**
 * The per-each unit label — `subUnitUnit || 'each'` (the `:456` expression).
 * Spec 104 (OQ-3): `costPerUnit` is the per-EACH (smallest-unit) cost; label
 * it with the item's smallest unit (`subUnitUnit`, else "each").
 */
export function costPerEachLabel(item: Pick<ItemMoneyFields, 'subUnitUnit'>): string {
  return item.subUnitUnit || 'each';
}

/**
 * Cost-per-each display string — `costPerUnit ? '$'+costPerUnit.toFixed(2) : '—'`
 * (the `:459` expression). DO NOT multiply: `costPerUnit` is already per-each.
 */
export function formatCostPerEach(item: Pick<ItemMoneyFields, 'costPerUnit'>): string {
  return item.costPerUnit ? `$${item.costPerUnit.toFixed(2)}` : '—';
}
