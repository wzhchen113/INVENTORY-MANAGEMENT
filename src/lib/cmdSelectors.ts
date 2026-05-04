import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import {
  EODSubmission, Recipe, PrepRecipe, InventoryItem, Vendor, AuditEvent, POSImport,
} from '../types';

// ── getStockSeries ──────────────────────────────────────────────────
// Derives a daily stock-level series for a given inventory item from
// eodSubmissions[].entries[]. Per Phase 4 spec (G1): take the latest
// actualRemaining per date, carry-forward across gaps, return the last
// `days` days. Audit log is NOT used — its `value` field is a free-text
// string and was unreliable.
//
// Returns an array of length `days` ordered oldest → newest. Days with no
// data before the first observation are filled with `null`.
export function getStockSeries(
  itemId: string,
  days: number,
  eodSubmissions: EODSubmission[],
): Array<number | null> {
  // Step 1: collect entries for this item, latest per date
  const byDate = new Map<string, { ts: number; value: number }>();
  for (const sub of eodSubmissions) {
    for (const e of sub.entries || []) {
      if (e.itemId !== itemId) continue;
      const ts = new Date(e.timestamp || sub.timestamp || sub.date).getTime();
      const existing = byDate.get(e.date);
      if (!existing || ts > existing.ts) {
        byDate.set(e.date, { ts, value: e.actualRemaining });
      }
    }
  }
  // Step 2: build a `days`-length array ending today, carrying values forward
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: Array<number | null> = [];
  let carry: number | null = null;
  // Walk from oldest → today
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const point = byDate.get(key);
    if (point) carry = point.value;
    out.push(carry);
  }
  return out;
}

export function useStockSeries(itemId: string, days: number): Array<number | null> {
  const submissions = useStore((s) => s.eodSubmissions);
  return useMemo(() => getStockSeries(itemId, days, submissions), [itemId, days, submissions]);
}

// ── getRecipesUsingItem ─────────────────────────────────────────────
// Joins an inventory item against both menu recipes and prep recipes.
// Per G12: prep recipes match only when ingredient.type === 'raw' (raw
// inventory ingredient, not a nested sub-recipe). soldPerWeek is derived
// from posImports filtered to the last 7 days for menu recipes only;
// prep recipes don't have direct sales, so it's omitted there.
export type RecipeUsage = {
  kind: 'recipe' | 'prep';
  id: string;
  name: string;
  /** Quantity portion as a printable string, e.g. "4 oz / serving". */
  portion: string;
  /** Menu recipes only — qty sold in the last 7 days from posImports. */
  soldPerWeek?: number;
};

/**
 * After the catalog refactor, recipe ingredients reference catalog ids
 * (brand-level), not per-store inventory_items.id. Callers that pass an
 * inventory_items.id are auto-resolved to its catalog_id via the
 * inventory[] lookup, so old call sites keep working.
 */
export function getRecipesUsingItem(
  itemIdOrCatalogId: string,
  recipes: Recipe[],
  prepRecipes: PrepRecipe[],
  posImports: POSImport[],
  inventory?: InventoryItem[],
): RecipeUsage[] {
  const resolvedCatalogId =
    inventory?.find((i) => i.id === itemIdOrCatalogId)?.catalogId || itemIdOrCatalogId;
  const out: RecipeUsage[] = [];
  // last-7-days POS sales by recipeId
  const sevenDaysAgoISO = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const salesByRecipe = new Map<string, number>();
  for (const imp of posImports) {
    if (imp.date && imp.date < sevenDaysAgoISO) continue;
    for (const sale of imp.items || []) {
      if (!sale.recipeId) continue;
      salesByRecipe.set(sale.recipeId, (salesByRecipe.get(sale.recipeId) || 0) + sale.qtySold);
    }
  }
  for (const r of recipes) {
    const ing = (r.ingredients || []).find(
      (i) => i.itemId === resolvedCatalogId || i.itemId === itemIdOrCatalogId,
    );
    if (!ing) continue;
    out.push({
      kind: 'recipe',
      id: r.id,
      name: r.menuItem,
      portion: `${ing.quantity} ${ing.unit} / serving`,
      soldPerWeek: salesByRecipe.get(r.id) ?? 0,
    });
  }
  for (const p of prepRecipes) {
    const ing = (p.ingredients || []).find(
      (i) =>
        (i.itemId === resolvedCatalogId || i.itemId === itemIdOrCatalogId) &&
        (i.type ?? 'raw') === 'raw',
    );
    if (!ing) continue;
    out.push({
      kind: 'prep',
      id: p.id,
      name: p.name,
      portion: `${ing.quantity} ${ing.unit} / batch`,
    });
  }
  return out;
}

export function useRecipesUsingItem(itemId: string): RecipeUsage[] {
  const recipes = useStore((s) => s.recipes);
  const prepRecipes = useStore((s) => s.prepRecipes);
  const posImports = useStore((s) => s.posImports);
  const inventory = useStore((s) => s.inventory);
  return useMemo(
    () => getRecipesUsingItem(itemId, recipes, prepRecipes, posImports, inventory),
    [itemId, recipes, prepRecipes, posImports, inventory],
  );
}

// ── getCommandPaletteIndex ──────────────────────────────────────────
// Flat searchable index for ⌘K. Each entry has a stable type, a
// human-readable label, an id (for dedupe / nav), an opaque `route`
// payload that the consumer interprets, and a scope label that's used
// to filter by role.
//
// Scopes:
//   'inventory' | 'recipes' | 'preps' | 'vendors' | 'audit' | 'screens'
// Staff sees only 'inventory' + 'recipes' + 'screens'.
export type PaletteEntry = {
  type: 'inventory' | 'recipe' | 'prep' | 'vendor' | 'audit' | 'screen';
  label: string;
  id: string;
  route: { name: string; params?: Record<string, unknown> };
  scope: 'inventory' | 'recipes' | 'preps' | 'vendors' | 'audit' | 'screens';
};


const SCREEN_ENTRIES: Array<{ name: string; label: string }> = [
  { name: 'Dashboard',       label: 'Dashboard' },
  { name: 'Inventory',       label: 'Inventory' },
  { name: 'EODCount',        label: 'EOD count' },
  { name: 'WasteLog',        label: 'Waste log' },
  { name: 'Receiving',       label: 'Receiving' },
  { name: 'PurchaseOrders',  label: 'Purchase orders' },
  { name: 'Vendors',         label: 'Vendors' },
  { name: 'Recipes',         label: 'Recipes' },
  { name: 'Restock',         label: 'Restock' },
  { name: 'Reconciliation',  label: 'Reconciliation' },
  { name: 'POSImports',      label: 'POS imports' },
  { name: 'AuditLog',        label: 'Audit log' },
  { name: 'Reports',         label: 'Reports' },
];

export function getCommandPaletteIndex(args: {
  inventory: InventoryItem[];
  recipes: Recipe[];
  prepRecipes: PrepRecipe[];
  vendors: Vendor[];
  auditLog: AuditEvent[];
}): PaletteEntry[] {
  const { inventory, recipes, prepRecipes, vendors, auditLog } = args;
  const out: PaletteEntry[] = [];

  for (const item of inventory) {
    out.push({
      type: 'inventory',
      label: item.name,
      id: item.id,
      route: { name: 'ItemDetail', params: { itemId: item.id } },
      scope: 'inventory',
    });
  }
  for (const r of recipes) {
    out.push({
      type: 'recipe',
      label: r.menuItem,
      id: r.id,
      route: { name: 'Recipes', params: { recipeId: r.id } },
      scope: 'recipes',
    });
  }
  for (const p of prepRecipes) {
    out.push({
      type: 'prep',
      label: p.name,
      id: p.id,
      route: { name: 'PrepRecipes', params: { prepRecipeId: p.id } },
      // preps are admin-only — listed under 'preps' scope so staff filter strips them
      scope: 'preps',
    });
  }
  for (const v of vendors) {
    out.push({
      type: 'vendor',
      label: v.name,
      id: v.id,
      route: { name: 'Vendors', params: { vendorId: v.id } },
      scope: 'vendors',
    });
  }
  // Audit log: last 100 events. Admin-only.
  for (const e of auditLog.slice(-100)) {
    out.push({
      type: 'audit',
      label: `${e.userName} · ${e.action} · ${e.itemRef}`,
      id: e.id,
      route: { name: 'AuditLog' },
      scope: 'audit',
    });
  }
  for (const screen of SCREEN_ENTRIES) {
    out.push({
      type: 'screen',
      label: screen.label,
      id: `screen:${screen.name}`,
      route: { name: screen.name },
      scope: 'screens',
    });
  }

  return out;
}

export function useCommandPaletteIndex(): PaletteEntry[] {
  const inventory   = useStore((s) => s.inventory);
  const recipes     = useStore((s) => s.recipes);
  const prepRecipes = useStore((s) => s.prepRecipes);
  const vendors     = useStore((s) => s.vendors);
  const auditLog    = useStore((s) => s.auditLog);
  return useMemo(
    () => getCommandPaletteIndex({ inventory, recipes, prepRecipes, vendors, auditLog }),
    [inventory, recipes, prepRecipes, vendors, auditLog],
  );
}
