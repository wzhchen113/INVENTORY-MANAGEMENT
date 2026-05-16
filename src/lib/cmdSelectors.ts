import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import {
  EODSubmission, Recipe, PrepRecipe, InventoryItem, Vendor, AuditEvent, POSImport,
  Store, OrderSubmission, OrderSchedule, ItemStatus,
} from '../types';
import type { SidebarGroup } from './sidebarLayout';
import { useIsSuperAdmin, useIsMaster } from '../hooks/useRole';
import { useT } from '../hooks/useT';

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


// Spec 038 — translated at call time via the `tFn` (or `T`) argument
// passed in by useCommandPaletteIndex. Keeps the pure function pure and
// the static `name` keys stable across locales (they're load-bearing
// route identifiers, not user-facing).
const SCREEN_ENTRIES_DEFS: Array<{ name: string; labelKey: string }> = [
  { name: 'Dashboard',       labelKey: 'sidebar.items.dashboard' },
  { name: 'Inventory',       labelKey: 'sidebar.items.inventory' },
  { name: 'EODCount',        labelKey: 'sidebar.items.eodCount' },
  { name: 'InventoryCount',  labelKey: 'sidebar.items.inventoryCount' },
  { name: 'WasteLog',        labelKey: 'sidebar.items.wasteLog' },
  { name: 'Receiving',       labelKey: 'sidebar.items.receiving' },
  { name: 'PurchaseOrders',  labelKey: 'sidebar.items.purchaseOrders' },
  { name: 'Vendors',         labelKey: 'sidebar.items.vendors' },
  // Note: deliberately reuses the menuItemsBom key so the palette entry
  // labels match the sidebar item label across all locales.
  { name: 'Recipes',         labelKey: 'sidebar.items.menuItemsBom' },
  { name: 'Restock',         labelKey: 'sidebar.items.restock' },
  { name: 'Reorder',         labelKey: 'sidebar.items.reorder' },
  { name: 'Reconciliation',  labelKey: 'sidebar.items.reconciliation' },
  { name: 'POSImports',      labelKey: 'sidebar.items.posImports' },
  { name: 'AuditLog',        labelKey: 'sidebar.items.auditLog' },
  { name: 'Reports',         labelKey: 'sidebar.items.reports' },
];

export function getCommandPaletteIndex(args: {
  inventory: InventoryItem[];
  recipes: Recipe[];
  prepRecipes: PrepRecipe[];
  vendors: Vendor[];
  auditLog: AuditEvent[];
  /** Spec 038 — translator function. Optional so existing callers and
   *  tests can pass an identity-like wrapper if they don't care about
   *  locale (the only consumer in app is useCommandPaletteIndex below). */
  t?: (key: string) => string;
}): PaletteEntry[] {
  const { inventory, recipes, prepRecipes, vendors, auditLog, t: tFn } = args;
  const translate = tFn || ((key: string) => key);
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
  for (const screen of SCREEN_ENTRIES_DEFS) {
    out.push({
      type: 'screen',
      label: translate(screen.labelKey),
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
  const T = useT();
  return useMemo(
    () => getCommandPaletteIndex({ inventory, recipes, prepRecipes, vendors, auditLog, t: T }),
    [inventory, recipes, prepRecipes, vendors, auditLog, T],
  );
}

// ─── Spec 009: Dashboard v2 — variance + CoGS + heatmap + queue ─────
//
// All five pure functions accept primitives only (no Zustand reach-in)
// so they're unit-testable when a runner lands. Hook wrappers below
// bind useStore slices via React.useMemo, mirroring the useStockSeries
// pattern at the top of this file.
//
// Date arithmetic is done in JS Date with the local timezone — same
// rule as DashboardSection.tsx and ReconciliationSection.tsx (the
// project doesn't standardize on UTC for ISO date math). Callers pass
// ISO yyyy-mm-dd; the helpers compare lexicographically when possible
// and only construct Date objects to enumerate days in a range.

/**
 * One row in the per-item variance breakdown that powers both
 * Reconciliation's variance.tsx tab (mode='priorEod') and the
 * Dashboard CoGS card's "top variance items" list (via
 * computeTopVarianceItems below).
 *
 * Field naming: `delta` is base-unit qty (counted - expected),
 * `deltaCost` is the signed dollar delta. Reconciliation's existing
 * `dollar`/`pct` fields map to `deltaCost` and a derived
 * Math.round((delta / expected) * 100).
 */
export interface VarianceLine {
  itemId: string;          // inventory_items.id (per-store row)
  itemName: string;
  storeId: string;
  storeName: string;
  expected: number;        // base units
  counted: number;
  delta: number;           // counted - expected
  deltaCost: number;       // delta * costPerUnit (signed)
  reason: 'over-portion' | 'shrinkage' | 'spoilage' | 'under-portion';
  unit: string;
}

export type VarianceMode = 'priorEod' | 'parLevel';

/**
 * Heuristic reason classifier — Phase 1 placeholder pending real
 * attribution data (invoice matching, POS depletion vs. waste log
 * cross-reference). Encoded in one place per architect §2 so a future
 * rewrite has a single touch point.
 */
function classifyVarianceReason(
  delta: number,
  expected: number,
  category: string,
): VarianceLine['reason'] {
  if (delta > 0) return 'under-portion';
  // Negative delta: produce shrink is most often spoilage.
  if (category && category.toLowerCase() === 'produce') return 'spoilage';
  const pct = expected > 0 ? Math.abs((delta / expected) * 100) : 0;
  return pct >= 25 ? 'shrinkage' : 'over-portion';
}

/**
 * Per-item variance for one store, latest EOD vs an "expected" baseline.
 *
 * Modes:
 *   - 'priorEod' (default): expected = previous EOD's actualRemaining.
 *     Mirrors ReconciliationSection.tsx:rows (variance.tsx tab).
 *   - 'parLevel': expected = item.parLevel. Mirrors
 *     ReconByCategoryTab.rows and ReconTimelineTab.days.
 *
 * Returns rows where delta !== 0 and the item still exists in inventory.
 * NOT sorted; caller decides ordering.
 */
export function computeVarianceLines(
  storeId: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  stores: Store[],
  mode: VarianceMode = 'priorEod',
): VarianceLine[] {
  const submissionsForStore = eodSubmissions
    .filter((s) => s.storeId === storeId)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = submissionsForStore[0];
  if (!latest) return [];
  const previous = submissionsForStore.find((s) => s.date < latest.date);
  const itemsById = new Map(inventory.map((i) => [i.id, i]));
  const prevById = new Map((previous?.entries || []).map((e) => [e.itemId, e.actualRemaining]));
  const storeName = stores.find((s) => s.id === storeId)?.name || '';
  const out: VarianceLine[] = [];
  for (const e of latest.entries || []) {
    const item = itemsById.get(e.itemId);
    if (!item) continue;
    const expected = mode === 'parLevel'
      ? (item.parLevel || 0)
      : (prevById.get(e.itemId) ?? e.actualRemaining);
    const counted = e.actualRemaining;
    const delta = +(counted - expected).toFixed(2);
    if (delta === 0) continue;
    const deltaCost = +(delta * (item.costPerUnit || 0)).toFixed(2);
    out.push({
      itemId: e.itemId,
      itemName: e.itemName || item.name,
      storeId,
      storeName,
      expected,
      counted,
      delta,
      deltaCost,
      reason: classifyVarianceReason(delta, expected, item.category),
      unit: item.unit,
    });
  }
  return out;
}

/**
 * CoGS theoretical for one store, one ISO date range [startDate, endDate]
 * (both inclusive). Theoretical = sum over POS imports in range of
 *   sum(saleItem.qtySold * recipe.ingredients[i].quantity * costPerUnit_at_store)
 * resolving recipeId → recipe → ingredients[] → catalogId →
 * inventory[storeId].costPerUnit. Skips sale items where
 * recipeMapped === false (no recipe to depleting against). Returns 0
 * when no POS data exists in range.
 *
 * Note: this is the SAME unit-of-account assumption as the existing v1
 * dashboard's food-cost trend (recipe ingredient quantity is in
 * inventory base units per serving, so qtySold × quantity × cost is
 * dollars). If recipe ingredients ever start carrying a unit that
 * doesn't match the inventory unit, plug in convertToItemUnit here
 * — but for now the rest of the codebase assumes unit alignment too.
 */
export function computeCogsTheoretical(
  storeId: string,
  startDate: string,
  endDate: string,
  posImports: POSImport[],
  recipes: Recipe[],
  inventory: InventoryItem[],
): number {
  const recipesById = new Map(recipes.map((r) => [r.id, r]));
  // Per-store cost lookup keyed by catalog_id (recipes reference catalog ids
  // post-refactor — see RecipeIngredient.itemId comment in src/types/index.ts).
  const costByCatalogId = new Map<string, number>();
  for (const i of inventory) {
    if (i.storeId !== storeId) continue;
    if (i.catalogId) costByCatalogId.set(i.catalogId, i.costPerUnit || 0);
  }
  let total = 0;
  for (const imp of posImports) {
    if (imp.storeId !== storeId) continue;
    if (!imp.date || imp.date < startDate || imp.date > endDate) continue;
    for (const sale of imp.items || []) {
      if (!sale.recipeMapped || !sale.recipeId) continue;
      const recipe = recipesById.get(sale.recipeId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients || []) {
        const cost = costByCatalogId.get(ing.itemId) || 0;
        total += (sale.qtySold || 0) * (ing.quantity || 0) * cost;
      }
    }
  }
  return +total.toFixed(2);
}

/**
 * CoGS actual for one store, one ISO date range [startDate, endDate]
 * (both inclusive). For each EOD in range we compare against the prior
 * EOD (walking back outside the range if needed, mirroring
 * ReconciliationSection's `previous` lookup) and sum the dollar-valued
 * depletion (depletion = priorEod - currentEod, a positive number when
 * stock went down).
 *
 * Returns 0 when no EOD exists in range. Negative values are possible
 * if a count rose without a logged receiving — surface as-is, don't
 * clamp; that's a real signal.
 */
export function computeCogsActual(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
): number {
  const itemsById = new Map(inventory.map((i) => [i.id, i]));
  // Sort the store's submissions ascending by date so we can walk forward
  // and look up the prior submission per row in O(1).
  const ordered = eodSubmissions
    .filter((s) => s.storeId === storeId)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  for (let i = 0; i < ordered.length; i++) {
    const sub = ordered[i];
    if (sub.date < startDate || sub.date > endDate) continue;
    // Walk backward to find the most recent submission strictly before this one.
    let prior: EODSubmission | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (ordered[j].date < sub.date) { prior = ordered[j]; break; }
    }
    const priorById = new Map((prior?.entries || []).map((e) => [e.itemId, e.actualRemaining]));
    for (const e of sub.entries || []) {
      const item = itemsById.get(e.itemId);
      if (!item) continue;
      const priorRemaining = priorById.get(e.itemId);
      if (priorRemaining == null) continue; // can't compute depletion without prior
      const depletion = priorRemaining - e.actualRemaining;
      total += depletion * (item.costPerUnit || 0);
    }
  }
  return +total.toFixed(2);
}

/**
 * Top-N variance lines across a date range, one store. Aggregates per
 * itemId across all dates in range (sum of deltaCost per item), sorts
 * by |deltaCost| desc, returns top N. Used by the Dashboard CoGS
 * card's "top variance items" list (A3). Default limit = 5 per spec
 * lock.
 *
 * Per-day granularity uses the priorEod variance definition (matching
 * Reconciliation's variance.tsx) so the dollar figures roll up cleanly
 * with computeCogsActual above.
 */
export function computeTopVarianceItems(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  stores: Store[],
  limit = 5,
): VarianceLine[] {
  const itemsById = new Map(inventory.map((i) => [i.id, i]));
  const ordered = eodSubmissions
    .filter((s) => s.storeId === storeId)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const storeName = stores.find((s) => s.id === storeId)?.name || '';
  // Per-itemId aggregator: sum of (counted - prior) and (counted - prior) × cost.
  type Agg = {
    itemName: string;
    expectedSum: number;
    countedSum: number;
    deltaSum: number;
    deltaCostSum: number;
    unit: string;
    category: string;
  };
  const agg = new Map<string, Agg>();
  for (let i = 0; i < ordered.length; i++) {
    const sub = ordered[i];
    if (sub.date < startDate || sub.date > endDate) continue;
    let prior: EODSubmission | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (ordered[j].date < sub.date) { prior = ordered[j]; break; }
    }
    const priorById = new Map((prior?.entries || []).map((e) => [e.itemId, e.actualRemaining]));
    for (const e of sub.entries || []) {
      const item = itemsById.get(e.itemId);
      if (!item) continue;
      const priorRemaining = priorById.get(e.itemId);
      if (priorRemaining == null) continue;
      const delta = e.actualRemaining - priorRemaining;
      if (delta === 0) continue;
      const deltaCost = delta * (item.costPerUnit || 0);
      const cur = agg.get(e.itemId) || {
        itemName: e.itemName || item.name,
        expectedSum: 0,
        countedSum: 0,
        deltaSum: 0,
        deltaCostSum: 0,
        unit: item.unit,
        category: item.category,
      };
      cur.expectedSum += priorRemaining;
      cur.countedSum += e.actualRemaining;
      cur.deltaSum += delta;
      cur.deltaCostSum += deltaCost;
      agg.set(e.itemId, cur);
    }
  }
  const out: VarianceLine[] = [];
  for (const [itemId, v] of agg) {
    out.push({
      itemId,
      itemName: v.itemName,
      storeId,
      storeName,
      expected: +v.expectedSum.toFixed(2),
      counted: +v.countedSum.toFixed(2),
      delta: +v.deltaSum.toFixed(2),
      deltaCost: +v.deltaCostSum.toFixed(2),
      reason: classifyVarianceReason(v.deltaSum, v.expectedSum, v.category),
      unit: v.unit,
    });
  }
  out.sort((a, b) => Math.abs(b.deltaCost) - Math.abs(a.deltaCost));
  return out.slice(0, limit);
}

/** Default target food-cost % used by computeStoreFoodCostVariancePp
 *  when caller doesn't override. Per architect Decision D3, hard-coded
 *  for Phase 1 — per-store target config is a follow-up spec. */
export const TARGET_FOOD_COST_PCT_DEFAULT = 30;

/**
 * Per-day food-cost variance in PERCENTAGE POINTS from a target ratio,
 * one store. Returns one number per day in [startDate, endDate]
 * inclusive (length = day count, oldest → newest).
 *
 * Definition (Phase 1):
 *   day's variance pp = (day's actual food-cost % - target)
 *   where actual food-cost % = (day's CoGS actual / day's POS revenue) * 100
 *
 * Edge cases:
 *  - No EOD on the day → 0 (treated as "on target / no signal").
 *  - EOD exists but POS revenue is 0 → falls back to the depletion-only
 *    proxy used in v1 Dashboard (`sub.entries.length % 5 + 30`) so the
 *    heatmap still paints rather than going blank. Mirrors the
 *    DashboardSection.tsx:64-74 v1 behavior. Flag for removal in Phase 2
 *    once POS revenue data is reliable.
 */
export function computeStoreFoodCostVariancePp(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  target: number = TARGET_FOOD_COST_PCT_DEFAULT,
): number[] {
  const itemsById = new Map(inventory.map((i) => [i.id, i]));
  const ordered = eodSubmissions
    .filter((s) => s.storeId === storeId)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const subsByDate = new Map<string, EODSubmission>();
  for (const s of ordered) subsByDate.set(s.date, s);
  // Revenue per day from POS imports
  const revenueByDate = new Map<string, number>();
  for (const imp of posImports) {
    if (imp.storeId !== storeId) continue;
    if (!imp.date) continue;
    let r = revenueByDate.get(imp.date) || 0;
    for (const sale of imp.items || []) r += Number(sale.revenue) || 0;
    revenueByDate.set(imp.date, r);
  }
  // Walk dates start → end, oldest → newest
  const out: number[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const sub = subsByDate.get(iso);
    if (!sub) { out.push(0); continue; }
    // Find prior submission strictly before this day to compute depletion.
    const idx = ordered.findIndex((s) => s.id === sub.id);
    let prior: EODSubmission | undefined;
    for (let j = idx - 1; j >= 0; j--) {
      if (ordered[j].date < sub.date) { prior = ordered[j]; break; }
    }
    const priorById = new Map((prior?.entries || []).map((e) => [e.itemId, e.actualRemaining]));
    let cogs = 0;
    for (const e of sub.entries || []) {
      const item = itemsById.get(e.itemId);
      if (!item) continue;
      const priorRemaining = priorById.get(e.itemId);
      if (priorRemaining == null) continue;
      cogs += (priorRemaining - e.actualRemaining) * (item.costPerUnit || 0);
    }
    const revenue = revenueByDate.get(iso) || 0;
    if (revenue > 0) {
      const actualPct = (cogs / revenue) * 100;
      out.push(+(actualPct - target).toFixed(2));
    } else {
      // V1 proxy fallback — mirrors DashboardSection.tsx:64-74 behavior so
      // the heatmap stays populated when POS revenue is missing. The
      // `% 5 + 30` shape was the v1 author's stand-in; result lands near
      // the target so it visually reads as "no variance signal yet".
      const proxyPct = (sub.entries?.length || 0) % 5 + 30;
      out.push(+(proxyPct - target).toFixed(2));
    }
  }
  return out;
}

/**
 * One alert row in a store's attention queue. `id` is stable per render
 * so React keys + future drill-through both work. `rule` is internal
 * (don't render verbatim) — useful for filtering and telemetry.
 */
export interface AttentionItem {
  id: string;
  sev: 'high' | 'med' | 'low';
  text: string;
  rule: 'eod_missing' | 'low_out_stock' | 'food_cost_streak' | 'unconfirmed_po' | 'expiry';
  /**
   * Spec 010: structured payload for the expiry drill-down modal.
   * Populated only when `rule === 'expiry'`; undefined otherwise.
   * Pure-function output stays JSON-serializable (no Date objects, no
   * functions) so the snapshot can be passed through React state without
   * re-deriving in the modal. Items are sorted ascending by
   * `hoursToExpiry` so the modal opens with most-urgent at top.
   * See specs/010-attention-queue-phase-2.md §3 / §4.
   */
  expiryDetail?: {
    sev: 'high' | 'med' | 'low';
    items: Array<{
      itemId: string;          // inventory_items.id
      itemName: string;
      hoursToExpiry: number;   // negative if already expired
      dollarAtRisk: number;    // currentStock × costPerUnit
      unit: string;
    }>;
    totalDollarAtRisk: number;
  };
}

/**
 * Spec 010 §3 — system-wide thresholds for the expiry alert.
 * Severity buckets:
 *   - HIGH:   ≤ 24h to expiry (or already expired — rolls into HIGH per
 *             literal reading of the rule; modal shows actual hours so
 *             "expired 2 days ago" is visually distinct from "expiring
 *             in 6 hours").
 *   - MED:    24h < hours ≤ 72h
 *   - LOW:    72h < hours ≤ 7d
 *   - hidden: hours > 7d (queue stays clean for the long horizon).
 *
 * Per-category and per-item overrides are a follow-up spec (architect §9).
 */
export const EXPIRY_HIGH_HOURS = 24;
export const EXPIRY_MED_HOURS = 72;
export const EXPIRY_LOW_HOURS = 24 * 7;

const SEV_RANK: Record<AttentionItem['sev'], number> = { high: 0, med: 1, low: 2 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Compares two HH:MM strings — true when `a` is past `b`. Ignores
 * timezone (callers pass Date.now() in store-local clock terms via the
 * injectable `now`).
 */
function isPastDeadline(nowDate: Date, deadlineHHMM?: string): boolean {
  if (!deadlineHHMM) return false;
  const [hh, mm] = deadlineHHMM.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return false;
  const dl = new Date(nowDate);
  dl.setHours(hh, mm, 0, 0);
  return nowDate.getTime() > dl.getTime();
}

/**
 * Client-derived attention queue for one store. Reads from passed-in
 * slices; returns an ordered (high → med → low, then alphabetic by
 * `text`) list. See spec 009 §7 for the rule ladder.
 *
 * `unconfirmed_po` is implemented per Decision D6: "scheduled vendor
 * with no matching orderSubmissions row for the day, > 3 days old".
 * The literal "PO not confirmed by vendor" check is deferred to a
 * future purchase_orders schema spec — the field doesn't exist on
 * OrderSubmission today.
 *
 * `now` is injectable so unit tests (when a runner lands) can pin a
 * deterministic clock.
 */
export function computeAttentionQueue(
  storeId: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  orderSubmissions: OrderSubmission[],
  orderSchedule: OrderSchedule,
  stores: Store[],
  getItemStatus: (i: InventoryItem) => ItemStatus,
  now: Date = new Date(),
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const todayISO = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayISO = yesterday.toISOString().slice(0, 10);
  const store = stores.find((s) => s.id === storeId);

  // ─── eod_missing ──────────────────────────────────────────
  const todaySub = eodSubmissions.find((s) => s.storeId === storeId && s.date === todayISO);
  if (!todaySub) {
    const yesterdaySub = eodSubmissions.find((s) => s.storeId === storeId && s.date === yesterdayISO);
    if (!yesterdaySub) {
      // Two consecutive missing days — low severity per the ladder, but the
      // text references the trailing miss so the operator sees the streak.
      out.push({
        id: `${storeId}:eod:${todayISO}`,
        sev: 'low',
        text: 'EOD missing 2 days running',
        rule: 'eod_missing',
      });
    } else if (isPastDeadline(now, store?.eodDeadlineTime)) {
      out.push({
        id: `${storeId}:eod:${todayISO}`,
        sev: 'high',
        text: `EOD missing past ${store?.eodDeadlineTime} deadline`,
        rule: 'eod_missing',
      });
    } else {
      out.push({
        id: `${storeId}:eod:${todayISO}`,
        sev: 'med',
        text: 'EOD not yet submitted today',
        rule: 'eod_missing',
      });
    }
  }

  // ─── low_out_stock ─────────────────────────────────────────
  const storeInventory = inventory.filter((i) => i.storeId === storeId);
  const outItems = storeInventory.filter((i) => getItemStatus(i) === 'out');
  const lowItems = storeInventory.filter((i) => getItemStatus(i) === 'low');
  if (outItems.length > 0) {
    out.push({
      id: `${storeId}:stock:out`,
      sev: 'high',
      text: `${outItems.length} ${outItems.length === 1 ? 'item' : 'items'} out of stock`,
      rule: 'low_out_stock',
    });
  } else if (lowItems.length > 5) {
    out.push({
      id: `${storeId}:stock:low`,
      sev: 'med',
      text: `${lowItems.length} items low on stock`,
      rule: 'low_out_stock',
    });
  } else if (lowItems.length >= 1) {
    out.push({
      id: `${storeId}:stock:low`,
      sev: 'low',
      text: `${lowItems.length} ${lowItems.length === 1 ? 'item' : 'items'} low on stock`,
      rule: 'low_out_stock',
    });
  }

  // ─── food_cost_streak ─────────────────────────────────────
  // Trailing 7 days; count consecutive trailing days where pp >= 1
  // (i.e. running over target by ≥ 1 percentage point).
  const startSeven = new Date(now);
  startSeven.setDate(startSeven.getDate() - 6);
  const startSevenISO = startSeven.toISOString().slice(0, 10);
  const variancePp = computeStoreFoodCostVariancePp(
    storeId,
    startSevenISO,
    todayISO,
    inventory,
    eodSubmissions,
    posImports,
  );
  let streak = 0;
  for (let i = variancePp.length - 1; i >= 0; i--) {
    if (variancePp[i] >= 1) streak++;
    else break;
  }
  if (streak >= 5) {
    out.push({
      id: `${storeId}:fc_streak:${streak}`,
      sev: 'high',
      text: `Food cost over target ${streak} days running`,
      rule: 'food_cost_streak',
    });
  } else if (streak >= 3) {
    out.push({
      id: `${storeId}:fc_streak:${streak}`,
      sev: 'med',
      text: `Food cost over target ${streak} days running`,
      rule: 'food_cost_streak',
    });
  }

  // ─── unconfirmed_po ───────────────────────────────────────
  // Decision D6: "scheduled vendor with no matching orderSubmissions
  // row > 3 days old". OrderSubmission has no confirmed/status field
  // today, so the literal "PO not yet confirmed" check is impossible;
  // we surface "we missed placing the order" as the operator-relevant
  // signal. Deprecate this rule when a purchase_orders schema lands.
  // Look back 3-7 days for a missed schedule entry.
  for (let lookback = 4; lookback <= 7; lookback++) {
    const past = new Date(now);
    past.setDate(past.getDate() - lookback);
    const pastDayName = DAY_NAMES[past.getDay()];
    const pastISO = past.toISOString().slice(0, 10);
    const scheduled = orderSchedule[pastDayName] || [];
    for (const v of scheduled) {
      const matched = orderSubmissions.find(
        (o) =>
          o.storeId === storeId &&
          o.date === pastISO &&
          (o.vendorName || '').toLowerCase() === (v.vendorName || '').toLowerCase(),
      );
      if (matched) continue;
      const vendorKey = (v.vendorId || v.vendorName || 'vendor').toString();
      out.push({
        id: `${storeId}:po:${vendorKey}:${pastISO}`,
        sev: 'med',
        text: `${v.vendorName} order missed (${pastISO})`,
        rule: 'unconfirmed_po',
      });
    }
  }

  // ─── expiry (Spec 010 §3) ─────────────────────────────────
  // One row per severity bucket (high/med/low), aggregated across this
  // store's inventory. `expiryDetail` carries a snapshot for the
  // drill-down modal so the modal renders without calling the selector
  // again with another store filter (cheaper + matches Spec 009's
  // pure-function pattern).
  type ExpiryBucketItem = {
    itemId: string;
    itemName: string;
    hoursToExpiry: number;
    dollarAtRisk: number;
    unit: string;
  };
  const expiryBuckets: Record<'high' | 'med' | 'low', ExpiryBucketItem[]> = {
    high: [], med: [], low: [],
  };
  const nowMs = now.getTime();
  for (const item of storeInventory) {
    if (!item.expiryDate) continue;
    // Treat the date as end-of-day in the operator's local timezone so
    // a "today" expiry isn't already negative at 9am. Parse the
    // 'YYYY-MM-DD' literal directly into a local-time Date — the
    // Date(string) constructor would otherwise parse it as UTC midnight,
    // which shifts the day boundary by the local UTC offset and breaks
    // the "until close" semantic. Matches the operator's mental model:
    // "expires today" = "you have until close".
    const m = String(item.expiryDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
    if (Number.isNaN(d.getTime())) continue;
    const hoursToExpiry = (d.getTime() - nowMs) / 3_600_000;
    if (hoursToExpiry > EXPIRY_LOW_HOURS) continue;
    const bucket: 'high' | 'med' | 'low' =
      hoursToExpiry <= EXPIRY_HIGH_HOURS ? 'high'
      : hoursToExpiry <= EXPIRY_MED_HOURS ? 'med'
      : 'low';
    expiryBuckets[bucket].push({
      itemId: item.id,
      itemName: item.name,
      hoursToExpiry: +hoursToExpiry.toFixed(2),
      dollarAtRisk: +((item.currentStock || 0) * (item.costPerUnit || 0)).toFixed(2),
      unit: item.unit || '',
    });
  }
  for (const bucket of ['high', 'med', 'low'] as const) {
    const items = expiryBuckets[bucket];
    if (items.length === 0) continue;
    items.sort((a, b) => a.hoursToExpiry - b.hoursToExpiry);
    const totalDollarAtRisk = +items.reduce((sum, i) => sum + i.dollarAtRisk, 0).toFixed(2);
    const hoursLabel = bucket === 'high' ? '24h' : bucket === 'med' ? '72h' : '7d';
    const noun = items.length === 1 ? 'item' : 'items';
    out.push({
      id: `${storeId}:expiry:${bucket}`,
      sev: bucket,
      text: `${items.length} ${noun} expiring <${hoursLabel}, $${Math.round(totalDollarAtRisk)} at risk`,
      rule: 'expiry',
      expiryDetail: { sev: bucket, items, totalDollarAtRisk },
    });
  }

  // Stable ordering: severity → alphabetic text. Dedupe by id (a
  // duplicate vendorKey across lookback days could fire twice; the
  // dateISO suffix in the id keeps each day's miss distinct per spec).
  out.sort((a, b) => {
    const r = SEV_RANK[a.sev] - SEV_RANK[b.sev];
    return r !== 0 ? r : a.text.localeCompare(b.text);
  });
  return out;
}

// ─── Hooks (Zustand-shaped wrappers) ─────────────────────────
//
// These bind useStore slices to the pure functions above. They cover
// the CURRENT-STORE use case only — the slice loader (useStore.ts:248)
// only ever holds one store's eodSubmissions/posImports/orderSubmissions
// at a time. Callers needing per-store cross-store data (e.g. the
// All-Stores Dashboard heatmap or per-store attention queues) must
// fetch via db.fetchEodSubmissionsForStores / fetchPosImportsForStores
// (spec 009 §5/D2) and call the pure functions above directly with
// component-local state.

/**
 * Top-N variance lines for the current store across the trailing
 * `days` window. Defaults: 7-day window, top 5 (Phase 1 spec lock).
 */
export function useTopVarianceItems(days: number = 7, limit: number = 5): VarianceLine[] {
  const currentStore = useStore((s) => s.currentStore);
  const inventory = useStore((s) => s.inventory);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  return useMemo(() => {
    const today = new Date();
    const startD = new Date(today);
    startD.setDate(startD.getDate() - (days - 1));
    return computeTopVarianceItems(
      currentStore.id,
      startD.toISOString().slice(0, 10),
      today.toISOString().slice(0, 10),
      inventory,
      eodSubmissions,
      stores,
      limit,
    );
  }, [currentStore.id, inventory, eodSubmissions, stores, days, limit]);
}

/**
 * CoGS rollup for the current store across the trailing `days` window.
 * `pct` is the variance as a percentage of theoretical (signed). When
 * theoretical is 0 the pct collapses to 0 — surfaced as "—" by the
 * renderer.
 */
export function useCogsForCurrentStore(days: number = 7): {
  theoretical: number;
  actual: number;
  delta: number;
  pct: number;
} {
  const currentStore = useStore((s) => s.currentStore);
  const inventory = useStore((s) => s.inventory);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const posImports = useStore((s) => s.posImports);
  const recipes = useStore((s) => s.recipes);
  return useMemo(() => {
    const today = new Date();
    const startD = new Date(today);
    startD.setDate(startD.getDate() - (days - 1));
    const startISO = startD.toISOString().slice(0, 10);
    const endISO = today.toISOString().slice(0, 10);
    const theoretical = computeCogsTheoretical(
      currentStore.id, startISO, endISO, posImports, recipes, inventory,
    );
    const actual = computeCogsActual(
      currentStore.id, startISO, endISO, inventory, eodSubmissions,
    );
    const delta = +(actual - theoretical).toFixed(2);
    const pct = theoretical > 0 ? +((delta / theoretical) * 100).toFixed(1) : 0;
    return { theoretical, actual, delta, pct };
  }, [currentStore.id, inventory, eodSubmissions, posImports, recipes, days]);
}

// ─── Spec 011: Responsive sidebar — single source of truth ──────────
//
// Per architect §2 / §4.C, the canonical sidebar group structure lives
// here so the desktop `Sidebar`, the tablet `RailSidebar`, and the
// `MobileNavDrawer` consume the same tree. Lifting it also fixes the
// real bug that `NavDrawerScreen` ignored the Spec 008 user override
// (it built its own inline tree). `useDefaultSidebarGroups()` returns
// groups WITHOUT an `onPress` for the `DBInspector` row — the consuming
// shell attaches navigation, since the selector is decoupled from React
// Navigation. The shell also runs `applySidebarOverride()` to merge the
// Spec 008 per-user override; we don't co-locate that hook here because
// the shell needs to attach `onPress` BEFORE the override merge.
//
// Item ids are load-bearing for the Spec 008 override merge — don't
// rename them casually.

/**
 * Default group structure (admin-only app — store users have a separate
 * app + API). Memoized via stable identity: the array is constructed
 * once per `useMemo` boundary and returned. Consumers that need to wire
 * an `onPress` (e.g. `DBInspector`) attach it after consuming.
 */
export function useDefaultSidebarGroups(): SidebarGroup[] {
  // Spec 012b — gate the "Brands" item on super-admin. We filter at the
  // default-groups layer (rather than hiding in the Sidebar component)
  // so applySidebarOverride from spec 008 has nothing to operate on for
  // non-super-admin users (the merge silently drops unknown ids).
  const isSuperAdmin = useIsSuperAdmin();
  const isMaster = useIsMaster();
  // Spec 038 — sidebar labels flow through t() so a Spanish/Chinese
  // user sees translated group + item labels. T's identity changes on
  // locale switch, so the useMemo below re-evaluates and the rendered
  // Sidebar re-renders.
  const T = useT();
  return useMemo<SidebarGroup[]>(() => {
    const groups: SidebarGroup[] = [
      {
        label: T('sidebar.groups.operations'),
        items: [
          { id: 'Inventory',       label: T('sidebar.items.inventory'),        kbd: '⌘I' },
          { id: 'Dashboard',       label: T('sidebar.items.dashboard') },
          { id: 'EODCount',        label: T('sidebar.items.eodCount') },
          // Spec 019 — sibling of "EOD count" per Q5 default. EOD entry
          // is unchanged; this one routes to InventoryCountSection.
          { id: 'InventoryCount',  label: T('sidebar.items.inventoryCount') },
          { id: 'WasteLog',        label: T('sidebar.items.wasteLog') },
          { id: 'Receiving',       label: T('sidebar.items.receiving') },
        ],
      },
      {
        label: T('sidebar.groups.planning'),
        items: [
          { id: 'PurchaseOrders',  label: T('sidebar.items.purchaseOrders') },
          { id: 'Vendors',         label: T('sidebar.items.vendors') },
          { id: 'Recipes',         label: T('sidebar.items.menuItemsBom') },
          { id: 'PrepRecipes',     label: T('sidebar.items.prepRecipes') },
          { id: 'Restock',         label: T('sidebar.items.restock') },
          // Spec 021 — vendor-grouped reorder list sibling to Restock.
          // Restock is store-wide-by-category; Reorder is
          // vendor-grouped-for-delivery-day. Different mental models.
          { id: 'Reorder',         label: T('sidebar.items.reorder') },
        ],
      },
      {
        label: T('sidebar.groups.insights'),
        items: [
          { id: 'Reconciliation',  label: T('sidebar.items.reconciliation') },
          { id: 'POSImports',      label: T('sidebar.items.posImports') },
          { id: 'AuditLog',        label: T('sidebar.items.auditLog') },
          { id: 'Reports',         label: T('sidebar.items.reports') },
          // DBInspector is rendered by the legacy color palette and is
          // routed as a sibling stack screen rather than a section pane.
          // The shell attaches `onPress` since this selector is decoupled
          // from React Navigation.
          { id: 'DBInspector',     label: T('sidebar.items.dbInspector') },
        ],
      },
    ];
    // Spec 030 — gate the Admin group on master/super_admin. Non-master
    // admins landed on a stripped-down UsersSection (Users & access is
    // the only Admin-group item); hiding the entry entirely matches the
    // spec 025 security-auditor M1 recommendation and mirrors the
    // super-admin-gated Tenancy push below.
    if (isMaster) {
      groups.push({
        label: T('sidebar.groups.admin'),
        items: [
          { id: 'Users', label: T('sidebar.items.usersAccess') },
        ],
      });
    }
    if (isSuperAdmin) {
      groups.push({
        label: T('sidebar.groups.tenancy'),
        items: [
          { id: 'Brands', label: T('sidebar.items.brands') },
        ],
      });
    }
    return groups;
  }, [isSuperAdmin, isMaster, T]);
}

