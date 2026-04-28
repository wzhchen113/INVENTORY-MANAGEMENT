// src/utils/unitConversion.ts
import { IngredientConversion, InventoryItem } from '../types';

// ─── Standard unit conversion to absolute base units ────────────────────
// Weight → grams (base unit: 'g')
const WEIGHT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lbs: 453.592,
};

// Volume → fluid ounces (base unit: 'fl_oz')
const VOLUME_TO_FLOZ: Record<string, number> = {
  fl_oz: 1,
  cups: 8,
  qt: 32,
  gal: 128,
};

// Legacy compatibility maps
const WEIGHT_TO_LBS: Record<string, number> = { lbs: 1, oz: 1 / 16 };
const VOLUME_TO_GAL: Record<string, number> = { gal: 1, qt: 1 / 4 };

// ─── Unit group detection ───────────────────────────────────────────────
export type BaseUnit = 'g' | 'fl_oz';

export function getUnitGroup(unit: string): 'weight' | 'volume' | 'abstract' {
  const u = unit.toLowerCase();
  if (WEIGHT_TO_GRAMS[u] !== undefined) return 'weight';
  if (VOLUME_TO_FLOZ[u] !== undefined) return 'volume';
  return 'abstract';
}

export function getBaseUnitForGroup(group: 'weight' | 'volume' | 'abstract'): BaseUnit {
  return group === 'volume' ? 'fl_oz' : 'g';
}

// ─── Standard unit conversions ──────────────────────────────────────────

/** Convert a quantity to the absolute base unit (g or fl_oz) */
export function toBaseUnit(qty: number, unit: string): { quantity: number; unit: BaseUnit } | null {
  const u = unit.toLowerCase();
  if (WEIGHT_TO_GRAMS[u] !== undefined) {
    return { quantity: qty * WEIGHT_TO_GRAMS[u], unit: 'g' };
  }
  if (VOLUME_TO_FLOZ[u] !== undefined) {
    return { quantity: qty * VOLUME_TO_FLOZ[u], unit: 'fl_oz' };
  }
  return null; // Abstract unit — needs item-specific conversion
}

/** Convert from base unit (g or fl_oz) to a display unit */
export function fromBaseUnit(baseQty: number, baseUnit: BaseUnit, targetUnit: string): number | null {
  const t = targetUnit.toLowerCase();
  if (baseUnit === 'g' && WEIGHT_TO_GRAMS[t] !== undefined) {
    return baseQty / WEIGHT_TO_GRAMS[t];
  }
  if (baseUnit === 'fl_oz' && VOLUME_TO_FLOZ[t] !== undefined) {
    return baseQty / VOLUME_TO_FLOZ[t];
  }
  return null;
}

/** Convert abstract unit (case/bag/box) to base unit using item-specific conversion */
export function abstractToBase(
  qty: number,
  purchaseUnit: string,
  conversion: IngredientConversion | undefined
): { quantity: number; unit: BaseUnit } | null {
  if (!conversion) return null;
  const baseQty = qty * conversion.conversionFactor * (conversion.netYieldPct / 100);
  return { quantity: baseQty, unit: conversion.baseUnit as BaseUnit };
}

/** Convert from base unit back to abstract unit */
export function baseToAbstract(
  baseQty: number,
  purchaseUnit: string,
  conversion: IngredientConversion | undefined
): number | null {
  if (!conversion || conversion.conversionFactor === 0) return null;
  return baseQty / (conversion.conversionFactor * (conversion.netYieldPct / 100));
}

/** Smart conversion: handles both standard and abstract units */
export function smartToBase(
  qty: number,
  unit: string,
  itemConversions?: IngredientConversion[]
): { quantity: number; unit: BaseUnit } {
  // Try standard conversion first
  const standard = toBaseUnit(qty, unit);
  if (standard) return standard;

  // Try item-specific abstract conversion
  if (itemConversions) {
    const conv = itemConversions.find((c) => c.purchaseUnit.toLowerCase() === unit.toLowerCase());
    if (conv) {
      const result = abstractToBase(qty, unit, conv);
      if (result) return result;
    }
  }

  // Fallback: treat as grams (1:1) — better than losing data
  return { quantity: qty, unit: 'g' };
}

/** Smart conversion: base unit to any display unit */
export function smartFromBase(
  baseQty: number,
  baseUnit: BaseUnit,
  targetUnit: string,
  itemConversions?: IngredientConversion[]
): number {
  // Try standard conversion
  const standard = fromBaseUnit(baseQty, baseUnit, targetUnit);
  if (standard !== null) return standard;

  // Try item-specific abstract conversion
  if (itemConversions) {
    const conv = itemConversions.find((c) => c.purchaseUnit.toLowerCase() === targetUnit.toLowerCase());
    if (conv) {
      const result = baseToAbstract(baseQty, targetUnit, conv);
      if (result !== null) return result;
    }
  }

  // Fallback: 1:1
  return baseQty;
}

// ─── Legacy compatibility functions ─────────────────────────────────────

/** Get conversion factor from one unit to another (legacy) */
export function getConversionFactor(fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return 1;
  const from = fromUnit.toLowerCase();
  const to = toUnit.toLowerCase();
  // Use full conversion tables (g, kg, oz, lbs for weight; fl_oz, cups, qt, gal for volume)
  if (WEIGHT_TO_GRAMS[from] !== undefined && WEIGHT_TO_GRAMS[to] !== undefined) {
    return WEIGHT_TO_GRAMS[from] / WEIGHT_TO_GRAMS[to];
  }
  if (VOLUME_TO_FLOZ[from] !== undefined && VOLUME_TO_FLOZ[to] !== undefined) {
    return VOLUME_TO_FLOZ[from] / VOLUME_TO_FLOZ[to];
  }
  return null;
}

/** Convert a quantity from one unit to another (legacy) */
export function convertQuantity(qty: number, fromUnit: string, toUnit: string): number | null {
  const factor = getConversionFactor(fromUnit, toUnit);
  if (factor === null) return null;
  return qty * factor;
}

/** Get all compatible standard units for a given unit */
export function getCompatibleUnits(unit: string): string[] {
  const u = unit.toLowerCase();
  if (WEIGHT_TO_GRAMS[u] !== undefined) return ['lbs', 'oz', 'g', 'kg'];
  if (VOLUME_TO_FLOZ[u] !== undefined) return ['gal', 'qt', 'cups', 'fl_oz'];
  return [unit];
}

/** Get all display units including abstract (for unit picker) */
export function getAllDisplayUnits(unit: string, itemConversions?: IngredientConversion[]): string[] {
  const standard = getCompatibleUnits(unit);
  if (itemConversions) {
    const abstract = itemConversions.map((c) => c.purchaseUnit).filter((u) => !standard.includes(u));
    return [...standard, ...abstract];
  }
  return standard;
}

// ─── Recipe → Inventory unit reconciliation ─────────────────────────────

/**
 * Convert a recipe-side quantity into the inventory item's tracking unit.
 *
 * Used by reconciliation / usage trend / order calc — wherever we need to
 * say "X sales × Y per-recipe = Z of the inventory unit". The recipe unit
 * (`fromUnit`) and the item's tracking unit (`item.unit`) are independent
 * fields, so e.g. a recipe can say "0.5 oz" of an item tracked in "cases".
 *
 * Resolution order (first match wins):
 *   1. Same unit (case-insensitive) → no conversion needed.
 *   2. Both standard weight or both standard volume → convert via the
 *      base-unit table (oz↔lbs, g↔kg, fl_oz↔cups…).
 *   3. Recipe in a standard sub-unit, item tracked in cases (or other
 *      abstract pack) → use item.caseQty × item.subUnitSize to get total
 *      sub-units per case, then divide. This is the common case for things
 *      like "0.5 oz cheese, tracked in cases of 20×80oz".
 *   4. Item has an `IngredientConversion` row whose `purchaseUnit` matches
 *      the item's tracking unit → use smartToBase / smartFromBase to
 *      bridge any unit pair (handles per-store custom packs).
 *
 * Returns `null` if none of the above resolve — the caller should mark the
 * line `unitMismatch: true` and exclude it from variance classification
 * rather than display a misleading number.
 */
export function convertToItemUnit(
  qty: number,
  fromUnit: string,
  item: InventoryItem | undefined,
  conversions?: IngredientConversion[],
): number | null {
  if (!item) return null;
  const from = (fromUnit || '').toLowerCase().trim();
  const to = (item.unit || '').toLowerCase().trim();
  if (!from || !to) return null;

  // Case 1: identical units.
  if (from === to) return qty;

  // Case 2: both within the same standard group (weight↔weight, vol↔vol).
  const direct = convertQuantity(qty, from, to);
  if (direct !== null) return direct;

  // Case 3: item tracked in an abstract pack with a sub-unit (e.g. Pita
  // Bread tracked in `bags` of 10 `each`). subUnitSize is "sub-units per
  // tracking unit" by definition of the IngredientEditor's "Size per unit"
  // field — so 1 each = 1/subUnitSize bags. Earlier versions multiplied by
  // caseQty here, which gave sub-units-per-CASE rather than per tracking
  // unit and produced a 12× error for items where the tracking unit is the
  // bag (not the case). subUnitSize alone is the correct factor.
  const subSize = item.subUnitSize || 0;
  if (subSize > 0 && item.subUnitUnit) {
    const subUnit = item.subUnitUnit.toLowerCase().trim();
    if (from === subUnit) {
      return qty / subSize;
    }
    // Recipe in a standard cousin of the sub-unit (e.g. oz when sub is lbs).
    const toSubUnit = convertQuantity(qty, from, subUnit);
    if (toSubUnit !== null) {
      return toSubUnit / subSize;
    }
  }

  // Case 4: item-specific conversion rows. Bridge through the base unit.
  if (conversions && conversions.length > 0) {
    const itemConvs = conversions.filter((c) => c.inventoryItemId === item.id);
    if (itemConvs.length > 0) {
      const base = smartToBase(qty, from, itemConvs);
      const back = smartFromBase(base.quantity, base.unit, item.unit, itemConvs);
      // smartFromBase returns 1:1 fallback when it can't resolve — guard
      // against that by requiring at least one of the legs to have actually
      // matched (i.e. base.unit must differ from a literal-fallback path
      // OR a matching conversion row exists for item.unit).
      const itemUnitHasConv = itemConvs.some(
        (c) => c.purchaseUnit.toLowerCase() === item.unit.toLowerCase(),
      );
      if (itemUnitHasConv) return back;
    }
  }

  return null;
}

/** Calculate unit cost from case pricing */
export function calcUnitCost(casePrice: number, caseQty: number, subUnitSize: number): number {
  const totalPerCase = caseQty * subUnitSize;
  if (totalPerCase <= 0) return 0;
  return casePrice / totalPerCase;
}

/** Calculate case price from unit cost */
export function calcCasePrice(unitCost: number, caseQty: number, subUnitSize: number): number {
  return unitCost * caseQty * subUnitSize;
}
