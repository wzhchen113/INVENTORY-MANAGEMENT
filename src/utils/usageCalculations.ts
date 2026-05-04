// src/utils/usageCalculations.ts
import {
  POSImport, Recipe, InventoryItem, EODSubmission, IngredientConversion,
  ReconciliationLine,
} from '../types';
import { convertToItemUnit } from './unitConversion';

// ── Ingredient Usage from POS × BOM ──────────────────────────

interface UsageAccum {
  itemId: string;
  itemName: string;
  unit: string;          // ITEM's tracking unit, not the recipe's
  totalUsed: number;     // expressed in that tracking unit
  unitMismatch: boolean; // true if any contributing recipe had a unit we
                         //   couldn't convert into the item's unit. The
                         //   numeric total still includes any rows we
                         //   COULD convert, but the consumer (recon) treats
                         //   the line as un-classifiable when this is true.
}

export function calculateIngredientUsage(
  posImports: POSImport[],
  recipes: Recipe[],
  inventory: InventoryItem[],
  storeId: string,
  startDate: string,
  endDate: string,
  conversions?: IngredientConversion[],
): Map<string, UsageAccum> {
  const recipeMap = new Map(recipes.map((r) => [r.id, r]));
  // After the catalog refactor, recipe ingredients reference catalog ids.
  // Look up the per-store inventory row by catalogId; legacy id-keyed
  // refs fall through to itemById.
  const storeItems = inventory.filter((i) => i.storeId === storeId);
  const itemByCatalog = new Map(storeItems.filter((i) => i.catalogId).map((i) => [i.catalogId, i]));
  const itemById = new Map(storeItems.map((i) => [i.id, i]));
  const usage = new Map<string, UsageAccum>();

  const imports = posImports.filter(
    (p) => p.storeId === storeId && p.date >= startDate && p.date <= endDate
  );

  for (const imp of imports) {
    for (const sale of imp.items) {
      if (!sale.recipeMapped || !sale.recipeId) continue;
      const recipe = recipeMap.get(sale.recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const item = itemByCatalog.get(ing.itemId) || itemById.get(ing.itemId);
        const rawQty = ing.quantity * sale.qtySold;
        const converted = convertToItemUnit(rawQty, ing.unit, item, conversions);
        const isMismatch = converted === null;
        const qty = converted ?? 0;

        // Aggregate by catalog id (brand-stable) so usage rolls up the
        // same key regardless of which store's row we landed on.
        const aggKey = item?.catalogId || ing.itemId;
        const existing = usage.get(aggKey);
        if (existing) {
          existing.totalUsed += qty;
          if (isMismatch) existing.unitMismatch = true;
        } else {
          usage.set(aggKey, {
            itemId: aggKey,
            itemName: ing.itemName || item?.name || '',
            unit: item?.unit ?? ing.unit,
            totalUsed: qty,
            unitMismatch: isMismatch,
          });
        }
      }
    }
  }

  return usage;
}

// ── Weekly Usage Trends ──────────────────────────────────────

export interface UsageTrendItem {
  itemId: string;
  itemName: string;
  unit: string;
  weeklyAmounts: number[];
  average: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function calculateWeeklyUsageTrend(
  posImports: POSImport[],
  recipes: Recipe[],
  inventory: InventoryItem[],
  storeId: string,
  endDateISO: string,
  numWeeks: number,
  conversions?: IngredientConversion[],
): UsageTrendItem[] {
  const endAnchor = new Date(endDateISO + 'T00:00:00');
  const allItems = new Map<string, { itemName: string; unit: string; weeks: number[] }>();

  for (let w = 0; w < numWeeks; w++) {
    const end = new Date(endAnchor);
    end.setDate(end.getDate() - w * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);

    const usage = calculateIngredientUsage(
      posImports, recipes, inventory, storeId, isoDate(start), isoDate(end), conversions,
    );

    for (const [itemId, u] of usage) {
      if (!allItems.has(itemId)) {
        allItems.set(itemId, { itemName: u.itemName, unit: u.unit, weeks: Array(numWeeks).fill(0) });
      }
      allItems.get(itemId)!.weeks[w] = Math.round(u.totalUsed * 10) / 10;
    }
  }

  return Array.from(allItems.entries())
    .map(([itemId, data]) => {
      const reversed = [...data.weeks].reverse(); // oldest first
      const sum = reversed.reduce((s, v) => s + v, 0);
      const nonZero = reversed.filter((v) => v > 0).length || 1;
      return {
        itemId,
        itemName: data.itemName,
        unit: data.unit,
        weeklyAmounts: reversed,
        average: Math.round((sum / nonZero) * 10) / 10,
      };
    })
    .sort((a, b) => {
      const totalA = a.weeklyAmounts.reduce((s, v) => s + v, 0);
      const totalB = b.weeklyAmounts.reduce((s, v) => s + v, 0);
      return totalB - totalA;
    })
    .slice(0, 15);
}

// ── Reconciliation Lines ─────────────────────────────────────

function getOpeningStock(
  itemId: string,
  date: string,
  storeId: string,
  eodSubmissions: EODSubmission[],
  inventory: InventoryItem[],
): number {
  // Previous day
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  const prevDate = isoDate(prev);

  const prevSub = eodSubmissions.find(
    (s) => s.storeId === storeId && s.date === prevDate
  );
  if (prevSub) {
    const entry = prevSub.entries.find((e) => e.itemId === itemId);
    if (entry) return entry.actualRemaining;
  }
  // Fallback to current inventory stock
  const item = inventory.find((i) => i.id === itemId && i.storeId === storeId);
  return item?.currentStock || 0;
}

export function buildReconciliationLines(
  startDate: string,
  endDate: string,
  storeId: string,
  posImports: POSImport[],
  recipes: Recipe[],
  eodSubmissions: EODSubmission[],
  inventory: InventoryItem[],
  conversions?: IngredientConversion[],
): ReconciliationLine[] {
  // EOD submission on the END of the range — closing count for the period.
  // For single-day reconciliation startDate === endDate.
  const eodSub = eodSubmissions.find(
    (s) => s.storeId === storeId && s.date === endDate
  );
  if (!eodSub) return [];

  const usage = calculateIngredientUsage(posImports, recipes, inventory, storeId, startDate, endDate, conversions);

  // Build a map of POS qty sold per ingredient for display, summed across the range.
  // ingredient.itemId is now a catalog id; we key the maps the same way and
  // resolve to per-store inventory row at lookup time.
  const recipeMap = new Map(recipes.map((r) => [r.id, r]));
  const posQtyPerItem = new Map<string, number>();
  const rangeImports = posImports.filter(
    (p) => p.storeId === storeId && p.date >= startDate && p.date <= endDate,
  );
  for (const imp of rangeImports) {
    for (const sale of imp.items) {
      if (!sale.recipeMapped || !sale.recipeId) continue;
      const recipe = recipeMap.get(sale.recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        posQtyPerItem.set(ing.itemId, (posQtyPerItem.get(ing.itemId) || 0) + sale.qtySold);
      }
    }
  }

  // Build recipe usage description per item — first occurrence per recipe.
  const recipeUsagePerItem = new Map<string, string>();
  for (const imp of rangeImports) {
    for (const sale of imp.items) {
      if (!sale.recipeMapped || !sale.recipeId) continue;
      const recipe = recipeMap.get(sale.recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const existing = recipeUsagePerItem.get(ing.itemId) || '';
        const desc = `${sale.qtySold}× ${recipe.menuItem}`;
        if (!existing.includes(recipe.menuItem)) {
          recipeUsagePerItem.set(ing.itemId, existing ? `${existing}, ${desc}` : desc);
        }
      }
    }
  }

  return eodSub.entries.map((entry) => {
    // Resolve catalog id from the per-store inventory row so we look up
    // usage / pos-qty / recipe descriptions by the same key the recipes use.
    const invRow = inventory.find((i) => i.id === entry.itemId);
    const catalogId = invRow?.catalogId;
    const lookupKey = catalogId || entry.itemId;
    // Opening stock is EOD-end-of-day before the range began.
    const openingStock = getOpeningStock(entry.itemId, startDate, storeId, eodSubmissions, inventory);
    const usageData = usage.get(lookupKey);
    const expectedDeduction = usageData ? Math.round(usageData.totalUsed * 100) / 100 : 0;
    const expectedRemaining = Math.round((openingStock - expectedDeduction) * 100) / 100;
    const variance = Math.round((entry.actualRemaining - expectedRemaining) * 100) / 100;
    const unitMismatch = Boolean(usageData?.unitMismatch);

    // Classification:
    //   - unitMismatch → 'review' regardless of variance — the number is
    //     suspect and we want it surfaced for the admin to fix the recipe.
    //   - otherwise relative variance: 10% mismatch / 2.5% review, scaled
    //     against whichever of expectedRemaining / openingStock / eodRemaining
    //     is largest (so a 0.5-case variance on a 5-case shelf still flags,
    //     while a 2g variance on a 1000g shelf doesn't).
    let result: 'match' | 'mismatch' | 'review' = 'match';
    if (unitMismatch) {
      result = 'review';
    } else {
      const denom = Math.max(
        Math.abs(expectedRemaining),
        Math.abs(openingStock),
        Math.abs(entry.actualRemaining),
        1,
      );
      const pct = Math.abs(variance) / denom;
      if (pct >= 0.10) result = 'mismatch';
      else if (pct >= 0.025) result = 'review';
    }

    return {
      itemId: entry.itemId,
      itemName: entry.itemName,
      posQtySold: posQtyPerItem.get(lookupKey) || 0,
      recipeUsed: recipeUsagePerItem.get(lookupKey) || 'No POS data',
      expectedDeduction,
      openingStock,
      eodRemaining: entry.actualRemaining,
      eodBy: entry.submittedBy,
      eodTime: new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      expectedRemaining,
      variance,
      unit: entry.unit,
      result,
      unitMismatch,
    };
  });
}
