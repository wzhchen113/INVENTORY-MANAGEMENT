// src/screens/cmd/sections/phone/menuCapacityFallback.ts — Spec 142 (chunk c).
//
// The client-side menu-capacity fallback (AC-MI2 / handoff §194) used by the
// phone Menu-impact + Menu-items surfaces when the server-computed
// `menuCapacity` slice has no row for a recipe yet:
//
//   makeable  = min over tracked BOM lines of floor(onHand / needPerPlate)
//   limitedBy = argmin ingredient name
//
// Pure (no React / store / theme) so it unit-tests without a mount and so both
// the list sort and the detail read the SAME math. Only RAW ingredient lines are
// tracked here — prep sub-recipes are untracked in the client fallback (handoff
// §182: they render a "PREP" tag rather than a makeable number).

import { getConversionFactor } from '../../../../utils/unitConversion';
import type { Recipe, InventoryItem, MenuCapacityRow } from '../../../../types';

export interface RawLine {
  /** On-hand stock, already converted into the ingredient's plate unit. */
  onHand: number;
  /** Quantity needed per plate (in the ingredient's unit). */
  needPerPlate: number;
  name: string;
}

export function clientMenuCapacity(lines: RawLine[]): { makeable: number | null; limitedBy: string | null } {
  let makeable: number | null = null;
  let limitedBy: string | null = null;
  for (const l of lines) {
    if (l.needPerPlate <= 0) continue;
    const m = Math.floor(l.onHand / l.needPerPlate);
    if (makeable === null || m < makeable) {
      makeable = m;
      limitedBy = l.name;
    }
  }
  return { makeable, limitedBy };
}

// Build the tracked RAW lines for a recipe against the current store's
// inventory, converting on-hand into each line's plate unit where a conversion
// factor exists (matches the desktop cost path's conversion approach).
export function recipeRawLines(recipe: Recipe, inventory: InventoryItem[], storeId: string): RawLine[] {
  return (recipe.ingredients || []).map((ing) => {
    const item =
      inventory.find((i) => i.catalogId === ing.itemId && i.storeId === storeId) ||
      inventory.find((i) => i.id === ing.itemId);
    const onHandRaw = item?.currentStock ?? 0;
    const factor = item ? getConversionFactor(item.unit, ing.unit) : null;
    const onHand = factor !== null && factor !== undefined ? onHandRaw * factor : onHandRaw;
    return { onHand, needPerPlate: ing.quantity, name: ing.itemName || item?.name || '—' };
  });
}

// Server value when available; client fallback otherwise (AC-MI2).
export function recipeCapacity(
  recipe: Recipe,
  inventory: InventoryItem[],
  storeId: string,
  cap: MenuCapacityRow | null | undefined,
): { makeable: number | null; limitedBy: string | null } {
  if (cap && cap.makeableQty !== null) {
    return { makeable: cap.makeableQty, limitedBy: cap.bindingCatalogName };
  }
  return clientMenuCapacity(recipeRawLines(recipe, inventory, storeId));
}
