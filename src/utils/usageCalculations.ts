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
  const itemMap = new Map(
    inventory.filter((i) => i.storeId === storeId).map((i) => [i.id, i]),
  );
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
        const item = itemMap.get(ing.itemId);
        const rawQty = ing.quantity * sale.qtySold;
        const converted = convertToItemUnit(rawQty, ing.unit, item, conversions);
        const isMismatch = converted === null;
        const qty = converted ?? 0;

        const existing = usage.get(ing.itemId);
        if (existing) {
          existing.totalUsed += qty;
          if (isMismatch) existing.unitMismatch = true;
        } else {
          usage.set(ing.itemId, {
            itemId: ing.itemId,
            itemName: ing.itemName,
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
  numWeeks = 4,
  conversions?: IngredientConversion[],
): UsageTrendItem[] {
  const today = new Date();
  const allItems = new Map<string, { itemName: string; unit: string; weeks: number[] }>();

  for (let w = 0; w < numWeeks; w++) {
    const end = new Date(today);
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
  date: string,
  storeId: string,
  posImports: POSImport[],
  recipes: Recipe[],
  eodSubmissions: EODSubmission[],
  inventory: InventoryItem[],
  conversions?: IngredientConversion[],
): ReconciliationLine[] {
  const eodSub = eodSubmissions.find(
    (s) => s.storeId === storeId && s.date === date
  );
  if (!eodSub) return [];

  const usage = calculateIngredientUsage(posImports, recipes, inventory, storeId, date, date, conversions);

  // Build a map of POS qty sold per ingredient for display
  const recipeMap = new Map(recipes.map((r) => [r.id, r]));
  const posQtyPerItem = new Map<string, number>();
  const dayImports = posImports.filter((p) => p.storeId === storeId && p.date === date);
  for (const imp of dayImports) {
    for (const sale of imp.items) {
      if (!sale.recipeMapped || !sale.recipeId) continue;
      const recipe = recipeMap.get(sale.recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        posQtyPerItem.set(ing.itemId, (posQtyPerItem.get(ing.itemId) || 0) + sale.qtySold);
      }
    }
  }

  // Build recipe usage description per item
  const recipeUsagePerItem = new Map<string, string>();
  for (const imp of dayImports) {
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
    const openingStock = getOpeningStock(entry.itemId, date, storeId, eodSubmissions, inventory);
    const usageData = usage.get(entry.itemId);
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
      posQtySold: posQtyPerItem.get(entry.itemId) || 0,
      recipeUsed: recipeUsagePerItem.get(entry.itemId) || 'No POS data',
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
