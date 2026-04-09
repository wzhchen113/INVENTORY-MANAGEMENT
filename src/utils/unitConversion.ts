// src/utils/unitConversion.ts

/** Conversion factors — all relative to a base unit per group */
const WEIGHT_TO_LBS: Record<string, number> = {
  lbs: 1,
  oz: 1 / 16,
};

const VOLUME_TO_GAL: Record<string, number> = {
  gal: 1,
  qt: 1 / 4,
};

/** Get conversion factor from one unit to another. Returns null if incompatible. */
export function getConversionFactor(fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return 1;

  const from = fromUnit.toLowerCase();
  const to = toUnit.toLowerCase();

  // Weight group
  if (WEIGHT_TO_LBS[from] !== undefined && WEIGHT_TO_LBS[to] !== undefined) {
    return WEIGHT_TO_LBS[from] / WEIGHT_TO_LBS[to];
  }

  // Volume group
  if (VOLUME_TO_GAL[from] !== undefined && VOLUME_TO_GAL[to] !== undefined) {
    return VOLUME_TO_GAL[from] / VOLUME_TO_GAL[to];
  }

  // Incompatible units (each, cases, loaves, bags — no conversion)
  return null;
}

/** Convert a quantity from one unit to another. Returns null if incompatible. */
export function convertQuantity(qty: number, fromUnit: string, toUnit: string): number | null {
  const factor = getConversionFactor(fromUnit, toUnit);
  if (factor === null) return null;
  return qty * factor;
}

/** Get all compatible units for a given unit (same conversion group) */
export function getCompatibleUnits(unit: string): string[] {
  const u = unit.toLowerCase();
  if (WEIGHT_TO_LBS[u] !== undefined) return Object.keys(WEIGHT_TO_LBS);
  if (VOLUME_TO_GAL[u] !== undefined) return Object.keys(VOLUME_TO_GAL);
  // Non-convertible unit — only itself
  return [unit];
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
