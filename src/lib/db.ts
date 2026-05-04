// src/lib/db.ts
// All database operations — drop-in replacements for the Zustand seed data
import { supabase } from './supabase';
import {
  InventoryItem, Recipe, WasteEntry, EODSubmission,
  Vendor, AuditEvent, Store, IngredientConversion,
} from '../types';

// ─── STORES ──────────────────────────────────────────────────────────────
export async function fetchStores(): Promise<Store[]> {
  const { data, error } = await supabase.from('stores').select('*').eq('status', 'active');
  if (error) throw error;
  return (data || []).map((s: any) => ({
    id: s.id,
    brandId: s.brand_id || '',
    name: s.name, address: s.address, status: s.status,
    eodDeadlineTime: s.eod_deadline_time || undefined,
  }));
}

export async function createStore(store: Omit<Store, 'id'>): Promise<string> {
  const { data, error } = await supabase
    .from('stores')
    .insert({ name: store.name, address: store.address, status: store.status || 'active' })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

export async function deleteStore(id: string): Promise<void> {
  // Delete all related data first
  await supabase.from('inventory_items').delete().eq('store_id', id);
  await supabase.from('recipes').delete().eq('store_id', id);
  await supabase.from('eod_submissions').delete().eq('store_id', id);
  await supabase.from('waste_log').delete().eq('store_id', id);
  await supabase.from('audit_log').delete().eq('store_id', id);
  await supabase.from('user_stores').delete().eq('store_id', id);
  await supabase.from('stores').delete().eq('id', id);
}

// ─── INVENTORY ────────────────────────────────────────────────────────────
export async function fetchInventory(storeId?: string): Promise<InventoryItem[]> {
  // name/unit/category/case_qty/sub_unit_* are hydrated from
  // catalog_ingredients via the JOIN aliased as `catalog`. The category
  // column is gone from inventory_items so we can no longer order by
  // it server-side; UI consumers sort client-side anyway.
  let query = supabase
    .from('inventory_items')
    .select(`*,
      vendor:vendors(name),
      updater:profiles!last_updated_by(name),
      catalog:catalog_ingredients(id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit)`)
    .order('id', { ascending: true });
  if (storeId) query = query.eq('store_id', storeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(mapItem);
}

/**
 * Find or create a catalog_ingredients row for the given brand by
 * case-insensitive name match. Returns the catalog id. Used by the
 * createInventoryItem path so the legacy "create new ingredient" UX
 * (IngredientFormDrawer) keeps working without first having to
 * manually create the catalog row.
 */
async function ensureCatalogIngredient(brandId: string, fields: {
  name: string;
  unit?: string;
  category?: string;
  caseQty?: number;
  subUnitSize?: number;
  subUnitUnit?: string;
  defaultCost?: number;
  defaultCasePrice?: number;
}): Promise<string> {
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');
  // Case-insensitive lookup first
  const { data: existing } = await supabase
    .from('catalog_ingredients')
    .select('id')
    .eq('brand_id', brandId)
    .ilike('name', fields.name)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from('catalog_ingredients')
    .insert({
      brand_id: brandId,
      name: fields.name,
      unit: fields.unit || '',
      category: fields.category || null,
      case_qty: fields.caseQty ?? 1,
      sub_unit_size: fields.subUnitSize ?? 1,
      sub_unit_unit: fields.subUnitUnit || '',
      default_cost: fields.defaultCost ?? 0,
      default_case_price: fields.defaultCasePrice ?? 0,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Resolve the brand for a given store id — small lookup used by
 * createInventoryItem when the catalog needs to be ensured but the
 * caller didn't pass a brandId explicitly.
 */
async function brandIdForStore(storeId: string): Promise<string> {
  const { data } = await supabase.from('stores').select('brand_id').eq('id', storeId).single();
  return data?.brand_id || '';
}

export async function createInventoryItem(item: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
  const vendorId = item.vendorId && item.vendorId.length > 10 ? item.vendorId : null;
  const storeId = item.storeId && item.storeId.length > 10 ? item.storeId : null;
  if (!storeId) throw new Error('Invalid store ID');

  // Resolve catalog id. After Phase 3 the catalog fields (name/unit/category/
  // case_qty/sub_unit_*) live on catalog_ingredients only, so we must have a
  // catalog row before inserting the per-store inventory_items row.
  let catalogId = item.catalogId;
  if (!catalogId) {
    const brandId = await brandIdForStore(storeId);
    catalogId = await ensureCatalogIngredient(brandId, {
      name: item.name,
      unit: item.unit,
      category: item.category,
      caseQty: item.caseQty,
      subUnitSize: item.subUnitSize,
      subUnitUnit: item.subUnitUnit,
      defaultCost: item.costPerUnit,
      defaultCasePrice: item.casePrice,
    });
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      store_id: storeId,
      catalog_id: catalogId,
      cost_per_unit: item.costPerUnit,
      current_stock: item.currentStock,
      par_level: item.parLevel,
      average_daily_usage: item.averageDailyUsage || 0,
      safety_stock: item.safetyStock || 0,
      vendor_id: vendorId,
      usage_per_portion: item.usagePerPortion || 0,
      expiry_date: item.expiryDate || null,
      last_updated_by: null,
      eod_remaining: item.currentStock || 0,
      case_price: item.casePrice || 0,
    })
    .select(`*,
      vendor:vendors(name),
      updater:profiles!last_updated_by(name),
      catalog:catalog_ingredients(id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit)`)
    .single();
  if (error) throw error;
  return mapItem(data);
}

export async function updateInventoryItem(id: string, updates: Partial<InventoryItem>): Promise<void> {
  if (!id || id.length < 10) return;

  // Catalog-level fields (name/unit/category/case_qty/sub_unit_*) propagate
  // to ALL stores via catalog_ingredients. Per-store fields (cost, vendor,
  // par, stock) stay on inventory_items.
  const catalogUpdates: any = {};
  if (updates.name !== undefined) catalogUpdates.name = updates.name;
  if (updates.unit !== undefined) catalogUpdates.unit = updates.unit;
  if (updates.category !== undefined) catalogUpdates.category = updates.category;
  if (updates.caseQty !== undefined) catalogUpdates.case_qty = updates.caseQty;
  if (updates.subUnitSize !== undefined) catalogUpdates.sub_unit_size = updates.subUnitSize;
  if (updates.subUnitUnit !== undefined) catalogUpdates.sub_unit_unit = updates.subUnitUnit;
  if (Object.keys(catalogUpdates).length > 0) {
    catalogUpdates.updated_at = new Date().toISOString();
    // Resolve the catalog_id for this row before updating
    const { data: row } = await supabase.from('inventory_items').select('catalog_id').eq('id', id).single();
    const catalogId = row?.catalog_id;
    if (catalogId) {
      await supabase.from('catalog_ingredients').update(catalogUpdates).eq('id', catalogId);
    }
  }

  const vendorId = updates.vendorId && updates.vendorId.length > 10 ? updates.vendorId : null;
  const perStore: any = {};
  if (updates.costPerUnit !== undefined) perStore.cost_per_unit = updates.costPerUnit;
  if (updates.currentStock !== undefined) perStore.current_stock = updates.currentStock;
  if (updates.parLevel !== undefined) perStore.par_level = updates.parLevel;
  if (updates.vendorId !== undefined) perStore.vendor_id = vendorId;
  if (updates.usagePerPortion !== undefined) perStore.usage_per_portion = updates.usagePerPortion;
  if (updates.expiryDate !== undefined) perStore.expiry_date = updates.expiryDate || null;
  if (updates.casePrice !== undefined) perStore.case_price = updates.casePrice;
  if (Object.keys(perStore).length === 0) return;
  const { error } = await supabase.from('inventory_items').update(perStore).eq('id', id);
  if (error) throw error;
}

export async function adjustItemStock(id: string, newStock: number, updatedById: string): Promise<void> {
  const { error } = await supabase
    .from('inventory_items')
    .update({ current_stock: newStock, last_updated_by: updatedById, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ─── RECIPES ─────────────────────────────────────────────────────────────
/**
 * Recipes are brand-level after the catalog refactor. Fetched once per
 * brand and shown at every store. Ingredient names come from
 * catalog_ingredients (brand-shared).
 */
export async function fetchRecipes(brandId: string): Promise<Recipe[]> {
  const { data, error } = await supabase
    .from('recipes')
    .select(`*,
      recipe_ingredients(*, catalog:catalog_ingredients(id, name, unit)),
      recipe_prep_items(*, prep:prep_recipes(name, yield_unit))`)
    .eq('brand_id', brandId);
  if (error) throw error;
  return (data || []).map((r: any) => ({
    id: r.id,
    menuItem: r.menu_item,
    category: r.category,
    sellPrice: r.sell_price,
    brandId: r.brand_id,
    // Mirror brand_id into storeId so legacy callers that compare against
    // a UUID don't see undefined. Cmd code drops the comparison.
    storeId: r.brand_id,
    ingredients: (r.recipe_ingredients || []).map((ing: any) => ({
      // itemId now means "catalog ingredient id" — name kept for compat.
      itemId: ing.catalog_id || '',
      itemName: ing.catalog?.name || '',
      quantity: ing.quantity,
      unit: ing.unit || ing.catalog?.unit || '',
    })),
    prepItems: (r.recipe_prep_items || []).map((p: any) => ({
      prepRecipeId: p.prep_recipe_id,
      prepRecipeName: p.prep?.name || '',
      quantity: p.quantity,
      unit: p.unit || p.prep?.yield_unit || '',
    })),
  }));
}

export async function createRecipe(recipe: Omit<Recipe, 'id'>): Promise<Recipe> {
  const brandId = recipe.brandId || recipe.storeId;
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');
  // Upsert by (brand_id, menu_item) — brand-level uniqueness. Phase 3
  // adds the corresponding constraint; until then we still satisfy the
  // legacy (menu_item, store_id) one because store_id is kept populated
  // as well.
  const { data, error } = await supabase
    .from('recipes')
    .upsert(
      {
        brand_id: brandId,
        store_id: brandId, // back-compat for the legacy NOT NULL store_id column
        menu_item: recipe.menuItem,
        category: recipe.category,
        sell_price: recipe.sellPrice,
      },
      { onConflict: 'menu_item,store_id' }
    )
    .select()
    .single();
  if (error) throw error;

  // Replace ingredients — recipe_ingredients carries catalog_id only
  // (the legacy item_id column was dropped in Phase 3).
  await supabase.from('recipe_ingredients').delete().eq('recipe_id', data.id);
  if (recipe.ingredients.length > 0) {
    await supabase.from('recipe_ingredients').insert(
      recipe.ingredients.map((ing) => ({
        recipe_id: data.id,
        catalog_id: ing.itemId,
        quantity: ing.quantity,
        unit: ing.unit,
      }))
    );
  }
  // Replace prep items
  await supabase.from('recipe_prep_items').delete().eq('recipe_id', data.id);
  if (recipe.prepItems && recipe.prepItems.length > 0) {
    await supabase.from('recipe_prep_items').insert(
      recipe.prepItems.map((p) => ({
        recipe_id: data.id, prep_recipe_id: p.prepRecipeId, quantity: p.quantity, unit: p.unit,
      }))
    );
  }
  return { ...recipe, id: data.id, brandId, storeId: brandId };
}

// ─── WASTE LOG ───────────────────────────────────────────────────────────
export async function fetchWasteLog(storeId: string): Promise<WasteEntry[]> {
  // Item name/unit come from catalog_ingredients now (inventory_items
  // only has the catalog_id link). Two-hop JOIN: waste_log.item_id →
  // inventory_items → catalog_ingredients.
  const { data, error } = await supabase
    .from('waste_log')
    .select(`*,
      logger:profiles!logged_by(name),
      item:inventory_items(catalog:catalog_ingredients(name, unit))`)
    .eq('store_id', storeId)
    .order('logged_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((w: any) => ({
    id: w.id,
    itemId: w.item_id,
    itemName: w.item?.catalog?.name || '',
    quantity: w.quantity,
    unit: w.item?.catalog?.unit || w.unit || '',
    costPerUnit: w.cost_per_unit,
    reason: w.reason,
    loggedBy: w.logger?.name || '',
    loggedByUserId: w.logged_by,
    timestamp: new Date(w.logged_at).toLocaleString(),
    notes: w.notes || '',
    storeId: w.store_id,
  }));
}

export async function logWasteEntry(entry: Omit<WasteEntry, 'id'>): Promise<void> {
  const { error } = await supabase.from('waste_log').insert({
    store_id: entry.storeId,
    item_id: entry.itemId,
    quantity: entry.quantity,
    unit: entry.unit,
    cost_per_unit: entry.costPerUnit,
    reason: entry.reason,
    logged_by: entry.loggedByUserId,
    notes: entry.notes,
  });
  if (error) throw error;
}

// ─── EOD SUBMISSIONS ─────────────────────────────────────────────────────
// One row per (store_id, date) — anyone with store access can edit the same
// count instead of forking off a per-user duplicate. Upsert so the "Edit
// today's count" flow updates the existing row; submitted_by tracks whoever
// last touched it (which is also what the audit log per entry preserves).
// Entries are replaced wholesale (delete-then-insert) so items removed from
// the edit screen disappear cleanly and we don't maintain diffing logic here.
//
// Errors are console.warn'd before being rethrown so `.catch(() => null)` at
// the call site still hides them from the user but developers can see the
// real reason (RLS, unique-key mismatch, network) in the browser console.
export async function submitEODCount(submission: Omit<EODSubmission, 'id'>): Promise<string> {
  const { data, error } = await supabase
    .from('eod_submissions')
    .upsert(
      {
        store_id: submission.storeId,
        date: new Date(submission.date).toISOString().split('T')[0],
        submitted_by: submission.submittedByUserId,
        status: submission.status || 'submitted',
        submitted_at: new Date().toISOString(),
      },
      { onConflict: 'store_id,date' }
    )
    .select()
    .single();
  if (error) {
    console.warn('[Supabase] submitEODCount upsert parent:', error.message, error);
    throw error;
  }

  // Replace entries wholesale: drop the old set, then insert the new set.
  const del = await supabase.from('eod_entries').delete().eq('submission_id', data.id);
  if (del.error) {
    console.warn('[Supabase] submitEODCount delete entries:', del.error.message, del.error);
    throw del.error;
  }

  if (submission.entries.length > 0) {
    const ins = await supabase.from('eod_entries').insert(
      submission.entries.map((e) => ({
        submission_id: data.id,
        item_id: e.itemId,
        actual_remaining: e.actualRemaining,
        actual_remaining_cases: e.actualRemainingCases ?? null,
        actual_remaining_each: e.actualRemainingEach ?? null,
        notes: e.notes || '',
      }))
    );
    if (ins.error) {
      console.warn('[Supabase] submitEODCount insert entries:', ins.error.message, ins.error);
      throw ins.error;
    }

    // Update eod_remaining on each item
    for (const entry of submission.entries) {
      const upd = await supabase
        .from('inventory_items')
        .update({ eod_remaining: entry.actualRemaining, last_updated_by: submission.submittedByUserId })
        .eq('id', entry.itemId);
      if (upd.error) {
        console.warn('[Supabase] submitEODCount update item:', entry.itemId, upd.error.message);
        // Don't throw — parent + entries already landed, item-level eod_remaining
        // is a nice-to-have. Surface in console for debugging.
      }
    }
  }

  return data.id;
}

// Fetch the last N days of EOD submissions for a store and map them to the
// client EODSubmission shape so they can populate useStore.eodSubmissions on
// login / store switch / refresh. This is the rehydration path that makes the
// vendor/category checkmarks + myTodaySubmission survive reload.
/**
 * Pulls today's EOD submissions across multiple stores in a single query.
 * Used by the Dashboard's EOD overview table so an admin can see every
 * accessible store's tonight status without N round-trips.
 *
 * Returns rows in the same shape as fetchRecentEODSubmissions — same mapping,
 * just filtered to a known list of store IDs and a single date.
 */
export async function fetchTodaysEODForStores(storeIds: string[], dateISO: string): Promise<any[]> {
  if (storeIds.length === 0) return [];
  const { data, error } = await supabase
    .from('eod_submissions')
    .select(`
      id, store_id, date, status, submitted_at, submitted_by,
      submitter:profiles!submitted_by(name),
      eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                  item:inventory_items(catalog:catalog_ingredients(name, unit)))
    `)
    .in('store_id', storeIds)
    .eq('date', dateISO);
  if (error) { console.warn('[Supabase] fetchTodaysEODForStores:', error.message); return []; }
  return (data || []).map((row: any) => ({
    id: row.id,
    storeId: row.store_id,
    date: row.date,
    status: row.status,
    itemCount: (row.eod_entries || []).length,
    submittedBy: row.submitter?.name || '',
    submittedByUserId: row.submitted_by,
    timestamp: row.submitted_at
      ? new Date(row.submitted_at).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
        })
      : '',
    entries: (row.eod_entries || []).map((e: any) => ({
      id: e.id,
      itemId: e.item_id,
      itemName: e.item?.catalog?.name || '',
      actualRemaining: Number(e.actual_remaining) || 0,
      actualRemainingCases: e.actual_remaining_cases != null ? Number(e.actual_remaining_cases) : undefined,
      actualRemainingEach: e.actual_remaining_each != null ? Number(e.actual_remaining_each) : undefined,
      unit: e.item?.catalog?.unit || '',
      submittedBy: row.submitter?.name || '',
      submittedByUserId: row.submitted_by,
      timestamp: e.created_at || row.submitted_at,
      date: row.date,
      storeId: row.store_id,
      notes: e.notes || '',
    })),
  }));
}

export async function fetchRecentEODSubmissions(storeId: string, days = 14): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffISO = cutoff.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('eod_submissions')
    .select(`id, store_id, date, submitted_by, submitted_at, status,
             submitter:profiles!submitted_by(name),
             eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                         item:inventory_items(catalog:catalog_ingredients(name, unit)))`)
    .eq('store_id', storeId)
    .gte('date', cutoffISO)
    .order('submitted_at', { ascending: false });
  if (error) { console.warn('[Supabase] fetchRecentEODSubmissions:', error.message); return []; }

  return (data || []).map((row: any) => ({
    id: row.id,
    storeId: row.store_id,
    storeName: '', // filled downstream if needed
    date: row.date,
    submittedBy: row.submitter?.name || '',
    submittedByUserId: row.submitted_by,
    timestamp: row.submitted_at,
    status: row.status || 'submitted',
    itemCount: (row.eod_entries || []).length,
    entries: (row.eod_entries || []).map((e: any) => ({
      id: e.id,
      itemId: e.item_id,
      itemName: e.item?.catalog?.name || '',
      actualRemaining: Number(e.actual_remaining) || 0,
      actualRemainingCases: e.actual_remaining_cases != null ? Number(e.actual_remaining_cases) : undefined,
      actualRemainingEach: e.actual_remaining_each != null ? Number(e.actual_remaining_each) : undefined,
      unit: e.item?.catalog?.unit || '',
      submittedBy: row.submitter?.name || '',
      submittedByUserId: row.submitted_by,
      timestamp: e.created_at || row.submitted_at,
      date: row.date,
      storeId: row.store_id,
      notes: e.notes || '',
    })),
  }));
}

export async function fetchEODSubmissions(storeId: string, date?: string): Promise<any[]> {
  let query = supabase
    .from('eod_submissions')
    .select(`*, submitter:profiles!submitted_by(name), eod_entries(*, item:inventory_items(catalog:catalog_ingredients(name, unit)))`)
    .eq('store_id', storeId)
    .order('submitted_at', { ascending: false });

  if (date) {
    query = query.eq('date', date);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── PURCHASE ORDERS ─────────────────────────────────────────────────────
// Records a submitted order ("Mark as Submitted"). Keeps a minimal row so
// (a) refresh restores the submitted state, and (b) the reminder cron can
// detect "already ordered today" via purchase_orders.created_at.
export async function createPurchaseOrder(params: {
  storeId: string;
  vendorId?: string;
  vendorName?: string;
  submittedByUserId?: string;
  totalCost?: number;
  day?: string;
  date?: string;           // YYYY-MM-DD (the day-card the order belongs to, store-local)
  referenceDate?: string;  // explicit alias; takes precedence over date
}): Promise<string | null> {
  // Prefer vendor_id; fall back to name lookup if only a name is provided.
  let vendorId = params.vendorId;
  if (!vendorId && params.vendorName) {
    const { data: v } = await supabase.from('vendors').select('id').ilike('name', params.vendorName).maybeSingle();
    vendorId = v?.id;
  }
  if (!vendorId) return null;

  const referenceDate = params.referenceDate || params.date || null;

  const { data, error } = await supabase
    .from('purchase_orders')
    .insert({
      store_id: params.storeId,
      vendor_id: vendorId,
      created_by: params.submittedByUserId || null,
      total_cost: params.totalCost ?? null,
      status: 'submitted',
      ...(referenceDate ? { reference_date: referenceDate } : {}),
    })
    .select('id')
    .single();
  if (error) { console.warn('[Supabase] createPurchaseOrder:', error.message); return null; }
  return data?.id || null;
}

export async function fetchRecentPurchaseOrders(storeId: string, days = 14): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, store_id, vendor_id, vendor:vendors(name), created_by, creator:profiles!created_by(name), created_at, reference_date, status, total_cost')
    .eq('store_id', storeId)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false });
  if (error) { console.warn('[Supabase] fetchRecentPurchaseOrders:', error.message); return []; }
  return (data || []).map((r: any) => {
    // Prefer reference_date (day-card's calendar date); fall back to UTC day
    // of created_at for pre-migration rows that somehow slipped through.
    const refDate: string = r.reference_date || (r.created_at ? r.created_at.split('T')[0] : '');
    // Derive day-of-week from refDate so it always matches the card. UTC-safe
    // because refDate is a pure YYYY-MM-DD string with no tz component.
    let day = '';
    if (refDate) {
      const [y, m, d] = refDate.split('-').map(Number);
      if (!Number.isNaN(y + m + d)) {
        day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      }
    }
    // Pre-format submittedAt ("1:27 AM") using the app's default NY tz so the
    // Orders detail modal footer ("Submitted by <Name> at <time>") has values
    // after a refresh. Fresh-submits populate these client-side; rehydration
    // went through this path with blanks before.
    const submittedAt = r.created_at
      ? new Date(r.created_at).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
        })
      : '';
    return {
      id: r.id,
      storeId: r.store_id,
      vendorId: r.vendor_id,
      vendorName: r.vendor?.name || '',
      submittedBy: r.creator?.name || '',
      submittedByUserId: r.created_by,
      submittedAt,
      totalCost: Number(r.total_cost) || 0,
      date: refDate,
      referenceDate: refDate,
      timestamp: r.created_at,
      status: r.status,
      day,
    };
  });
}

// ─── VENDORS ─────────────────────────────────────────────────────────────
export async function fetchVendors(brandId?: string): Promise<Vendor[]> {
  let query = supabase.from('vendors').select('*').order('name');
  if (brandId) query = query.eq('brand_id', brandId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((v: any) => ({
    id: v.id,
    brandId: v.brand_id,
    name: v.name, contactName: v.contact_name, phone: v.phone,
    email: v.email, accountNumber: v.account_number, leadTimeDays: v.lead_time_days,
    deliveryDays: v.delivery_days || [], categories: v.categories || [], lastOrderDate: v.last_order_date,
    orderCutoffTime: v.order_cutoff_time || undefined,
    eodDeadlineTime: v.eod_deadline_time || undefined,
  }));
}

export async function createVendor(vendor: Omit<Vendor, 'id'>): Promise<Vendor> {
  if (!vendor.brandId || vendor.brandId.length < 10) throw new Error('Invalid brand ID');
  const { data, error } = await supabase.from('vendors').insert({
    brand_id: vendor.brandId,
    name: vendor.name, contact_name: vendor.contactName, phone: vendor.phone,
    email: vendor.email, account_number: vendor.accountNumber,
    lead_time_days: vendor.leadTimeDays, delivery_days: vendor.deliveryDays, categories: vendor.categories,
    ...(vendor.orderCutoffTime ? { order_cutoff_time: vendor.orderCutoffTime } : {}),
    ...(vendor.eodDeadlineTime ? { eod_deadline_time: vendor.eodDeadlineTime } : {}),
  }).select().single();
  if (error) throw error;
  return { ...vendor, id: data.id };
}

// ─── IN-APP NOTIFICATIONS ────────────────────────────────────────────────
// Bell-icon items. Cron writes rows for EOD reminders; client writes for
// user-initiated events. RLS restricts each user to their own rows.
export interface PersistedNotification {
  id: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export async function fetchNotifications(userId: string, limit = 50): Promise<PersistedNotification[]> {
  const { data, error } = await supabase
    .from('in_app_notifications')
    .select('id, message, created_at, read_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('[Supabase] fetchNotifications:', error.message); return []; }
  return (data || []).map((r: any) => ({
    id: r.id, message: r.message, createdAt: r.created_at, readAt: r.read_at,
  }));
}

export async function createNotification(userId: string, message: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('in_app_notifications')
    .insert({ user_id: userId, message })
    .select('id')
    .single();
  if (error) { console.warn('[Supabase] createNotification:', error.message); return null; }
  return data?.id ?? null;
}

export async function markNotificationReadDb(id: string): Promise<void> {
  const { error } = await supabase
    .from('in_app_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.warn('[Supabase] markNotificationReadDb:', error.message);
}

export async function clearNotificationsDb(userId: string): Promise<void> {
  // "Clear" = mark all as read, not delete, so we still have history if needed.
  const { error } = await supabase
    .from('in_app_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null);
  if (error) console.warn('[Supabase] clearNotificationsDb:', error.message);
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────
export async function fetchAuditLog(storeId: string, limit = 100): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('audit_log')
    .select(`*, actor:profiles!user_id(name, role), store:stores(name)`)
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((e: any) => ({
    id: e.id,
    timestamp: new Date(e.created_at).toLocaleString(),
    userId: e.user_id,
    userName: e.actor?.name || '',
    userRole: e.actor?.role || 'user',
    storeId: e.store_id,
    storeName: e.store?.name || '',
    action: e.action,
    detail: e.detail || '',
    itemRef: e.item_ref || '',
    value: e.value || '',
  }));
}

export async function addAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<void> {
  await supabase.from('audit_log').insert({
    store_id: event.storeId,
    user_id: event.userId,
    action: event.action,
    detail: event.detail,
    item_ref: event.itemRef,
    value: event.value,
  });
}

// ─── POS IMPORT ──────────────────────────────────────────────────────────
export async function savePOSImport(
  storeId: string,
  filename: string,
  importedById: string,
  items: { menuItem: string; qtySold: number; revenue: number; recipeId?: string; recipeMapped: boolean }[],
  importDate?: string,
): Promise<void> {
  // importDate is the business date the sales belong to (YYYY-MM-DD). The
  // CSV path leaves it undefined → falls back to today, which is fine since
  // the user uploads current-day reports. Backfill passes an explicit date
  // so `hasPOSImportForDate` can dedup correctly.
  const date = importDate ?? new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('pos_imports')
    .insert({
      store_id: storeId, filename,
      imported_by: importedById,
      import_date: date,
    })
    .select()
    .single();
  if (error) throw error;

  await supabase.from('pos_import_items').insert(
    items.map((item) => ({
      import_id: data.id,
      menu_item: item.menuItem,
      qty_sold: item.qtySold,
      revenue: item.revenue,
      recipe_id: item.recipeId || null,
      recipe_mapped: item.recipeMapped,
    }))
  );
}

// Dedup check for breadbot backfill: returns true if pos_imports already has
// a row for this (store, date). Uses count+head so supabase returns no row
// payload — just the aggregate count.
export async function hasPOSImportForDate(
  storeId: string,
  date: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('pos_imports')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .eq('import_date', date);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// ─── BREADBOT SALES PROXY ────────────────────────────────────────────────
// Thin client wrapper around the fetch-breadbot-sales edge function. The
// edge function holds the API key server-side and now consumes Breadbot's
// /sales endpoint, which exposes both the raw POS string and Breadbot's
// own canonicalized name (resolved via 159 aliases). The caller maps
// rawItemName → ParsedRow.menuItem so all downstream logic (matchRecipe,
// pos_import_items writes, alias upserts) keeps using the raw POS string
// as it does today; canonical is surfaced as an informational hint only.
export interface BreadbotSalesRow {
  /** Exactly what the POS recorded (e.g. "BIRD & BURIED"). Use this for
   *  matching against pos_recipe_aliases and writing pos_import_items. */
  rawItemName: string;
  /** Breadbot's canonicalized name (e.g. "Chicken Tender Basket"). Display
   *  only — does NOT participate in our recipe matching. */
  canonical: string;
  qtySold: number;
  revenue: number;
}

export interface BreadbotSalesResult {
  rows: BreadbotSalesRow[];
  freshness: any;
  meta: { store_code: string; date: string; endpoint?: string; upstream_row_count: number; collapsed_row_count: number };
}

export async function fetchBreadbotSales(
  storeName: string,
  date: string,
): Promise<BreadbotSalesResult> {
  const { data, error } = await supabase.functions.invoke('fetch-breadbot-sales', {
    body: { storeName, date },
  });
  if (error) {
    // supabase-js throws FunctionsHttpError with details on the response body.
    // Surface the upstream message when possible so the UI can show it.
    const ctx: any = (error as any).context;
    if (ctx?.error) throw new Error(ctx.error);
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return {
    rows: data?.rows || [],
    freshness: data?.freshness_by_channel ?? null,
    meta: data?.meta ?? {},
  };
}

// ─── DELETE INVENTORY ────────────────────────────────────────────────────
export async function deleteInventoryItem(id: string): Promise<void> {
  if (!id || id.length < 10) return; // Skip local temp IDs
  await supabase.from('inventory_items').delete().eq('id', id);
}

// ─── UPDATE/DELETE RECIPE ────────────────────────────────────────────────
export async function updateRecipe(id: string, updates: Partial<Recipe>): Promise<void> {
  const dbUpdates: any = {};
  if (updates.menuItem !== undefined) dbUpdates.menu_item = updates.menuItem;
  if (updates.category !== undefined) dbUpdates.category = updates.category;
  if (updates.sellPrice !== undefined) dbUpdates.sell_price = updates.sellPrice;
  if (Object.keys(dbUpdates).length > 0) {
    await supabase.from('recipes').update(dbUpdates).eq('id', id);
  }
  // Update ingredients if provided
  if (updates.ingredients) {
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', id);
    if (updates.ingredients.length > 0) {
      await supabase.from('recipe_ingredients').insert(
        updates.ingredients.map((ing) => ({
          recipe_id: id, item_id: ing.itemId, quantity: ing.quantity, unit: ing.unit,
        }))
      );
    }
  }
  // Update prep items if provided
  if (updates.prepItems) {
    await supabase.from('recipe_prep_items').delete().eq('recipe_id', id);
    if (updates.prepItems.length > 0) {
      await supabase.from('recipe_prep_items').insert(
        updates.prepItems.map((p) => ({
          recipe_id: id, prep_recipe_id: p.prepRecipeId, quantity: p.quantity, unit: p.unit,
        }))
      );
    }
  }
}

export async function deleteRecipe(id: string): Promise<void> {
  await supabase.from('recipe_ingredients').delete().eq('recipe_id', id);
  await supabase.from('recipe_prep_items').delete().eq('recipe_id', id);
  await supabase.from('recipes').delete().eq('id', id);
}

/**
 * Look up recipe rows by menu name across one or more stores.
 * Used by the recipe edit/delete UI to operate on rows that may not
 * be loaded in local Zustand state (single-store view only loads the
 * active store's recipes; this query reaches all stores).
 *
 * Returns `{ id, storeId }` pairs so callers can drive `updateRecipe` /
 * `deleteRecipe` against any store, while preserving each row's
 * `recipe_id` (POS aliases stay intact).
 */
export async function findRecipesByMenuItem(
  menuItem: string,
  storeIds: string[]
): Promise<{ id: string; storeId: string }[]> {
  if (storeIds.length === 0) return [];
  const { data, error } = await supabase
    .from('recipes')
    .select('id, store_id')
    .ilike('menu_item', menuItem)
    .in('store_id', storeIds);
  if (error) {
    console.warn('[Supabase] findRecipesByMenuItem', error.message);
    return [];
  }
  return (data || []).map((r: any) => ({ id: r.id, storeId: r.store_id }));
}

/**
 * Set the per-user notifications kill switch. The eod-reminder-cron edge
 * function reads `profiles.notifications_enabled` to decide whether to
 * send push or email fallback to a given user. Default is true; flipping
 * to false silences both channels for that user across all their devices.
 *
 * Returns false if the write failed so the caller can roll the UI back.
 */
export async function updateProfileNotifications(
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const { error } = await supabase
    .from('profiles')
    .update({ notifications_enabled: enabled })
    .eq('id', userId);
  if (error) {
    console.warn('[Supabase] updateProfileNotifications:', error.message);
    return false;
  }
  return true;
}

// ─── PREP RECIPES ───────────────────────────────────────────────────────
/**
 * Brand-level prep recipes after the catalog refactor. brandId param is
 * required for current versions (`is_current=true`); old non-current
 * versions still carry brandId set during Phase 2 backfill.
 *
 * For raw ingredients (type='raw'), itemId in the returned model is the
 * catalog_ingredients.id (brand-shared). For sub-recipe references
 * (type='prep'), itemId is the prep_recipes.id.
 */
export async function fetchPrepRecipes(brandId?: string): Promise<any[]> {
  let query = supabase
    .from('prep_recipes')
    .select(`*,
      prep_recipe_ingredients!prep_recipe_ingredients_prep_recipe_id_fkey(*,
        catalog:catalog_ingredients(id, name, unit)
      )`)
    .eq('is_current', true);
  if (brandId) query = query.eq('brand_id', brandId);
  const { data, error } = await query;
  if (error) throw error;
  const recipes = (data || []).map((pr: any) => ({
    id: pr.id,
    name: pr.name,
    category: pr.category || '',
    yieldQuantity: pr.yield_quantity || 0,
    yieldUnit: pr.yield_unit || '',
    notes: pr.notes || '',
    brandId: pr.brand_id,
    storeId: pr.brand_id, // back-compat
    createdBy: '',
    createdAt: pr.created_at ? new Date(pr.created_at).toLocaleDateString() : '',
    version: pr.version || 1,
    isCurrent: pr.is_current !== false,
    parentId: pr.parent_id || undefined,
    ingredients: (pr.prep_recipe_ingredients || []).map((i: any) => {
      const isPrep = (i.type || 'raw') === 'prep';
      return {
        // For 'prep': sub_recipe_id (a prep_recipes.id).
        // For 'raw': catalog_id (catalog_ingredients.id).
        itemId: isPrep ? i.sub_recipe_id : i.catalog_id,
        itemName: isPrep
          ? (i.sub_recipe_id || '')
          : (i.catalog?.name || ''),
        quantity: i.quantity,
        unit: i.unit || i.catalog?.unit || '',
        baseQuantity: i.base_quantity || 0,
        baseUnit: i.base_unit || 'g',
        type: i.type || 'raw',
      };
    }),
  }));
  // Resolve sub-recipe names from the loaded recipes
  const nameMap = new Map(recipes.map((r: any) => [r.id, r.name]));
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      if (ing.type === 'prep' && ing.itemId) {
        ing.itemName = nameMap.get(ing.itemId) || '[Sub-recipe]';
      }
    }
  }
  return recipes;
}

export async function fetchPrepRecipesByName(name: string): Promise<{ id: string; storeId: string }[]> {
  const { data, error } = await supabase
    .from('prep_recipes')
    .select('id, store_id')
    .ilike('name', name)
    .eq('is_current', true);
  if (error) throw error;
  return (data || []).map((r: any) => ({ id: r.id, storeId: r.store_id }));
}

export async function createPrepRecipe(recipe: any): Promise<string> {
  const brandId = recipe.brandId || recipe.storeId;
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');
  const { data, error } = await supabase
    .from('prep_recipes')
    .insert({
      name: recipe.name,
      category: recipe.category,
      yield_quantity: recipe.yieldQuantity,
      yield_unit: recipe.yieldUnit,
      notes: recipe.notes,
      brand_id: brandId,
      store_id: brandId, // legacy NOT NULL column, dropped in Phase 3
      version: 1,
      is_current: true,
    })
    .select().single();
  if (error) throw error;
  // raw ingredients carry catalog_id (brand-level); prep ingredients
  // carry sub_recipe_id. The legacy item_id column was dropped in Phase 3.
  const validIngs = (recipe.ingredients || []).filter((i: any) => i.itemId && i.itemId.length > 10);
  if (validIngs.length > 0) {
    await supabase.from('prep_recipe_ingredients').insert(
      validIngs.map((i: any) => {
        const isPrep = (i.type || 'raw') === 'prep';
        return {
          prep_recipe_id: data.id,
          catalog_id: isPrep ? null : i.itemId,
          sub_recipe_id: isPrep ? i.itemId : null,
          type: i.type || 'raw',
          quantity: i.quantity, unit: i.unit,
          base_quantity: i.baseQuantity || 0, base_unit: i.baseUnit || 'g',
        };
      })
    );
  }
  return data.id;
}

export async function updatePrepRecipe(id: string, updates: any): Promise<void> {
  const dbUpdates: any = {};
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.category !== undefined) dbUpdates.category = updates.category;
  if (updates.yieldQuantity !== undefined) dbUpdates.yield_quantity = updates.yieldQuantity;
  if (updates.yieldUnit !== undefined) dbUpdates.yield_unit = updates.yieldUnit;
  if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
  if (Object.keys(dbUpdates).length > 0) {
    await supabase.from('prep_recipes').update(dbUpdates).eq('id', id);
  }
  if (updates.ingredients) {
    await supabase.from('prep_recipe_ingredients').delete().eq('prep_recipe_id', id);
    if (updates.ingredients.length > 0) {
      await supabase.from('prep_recipe_ingredients').insert(
        updates.ingredients.map((i: any) => {
          const isPrep = (i.type || 'raw') === 'prep';
          return {
            prep_recipe_id: id,
            catalog_id: isPrep ? null : i.itemId,
            sub_recipe_id: isPrep ? i.itemId : null,
            type: i.type || 'raw',
            quantity: i.quantity, unit: i.unit,
            base_quantity: i.baseQuantity || 0, base_unit: i.baseUnit || 'g',
          };
        })
      );
    }
  }
}

export async function deletePrepRecipe(id: string): Promise<void> {
  await supabase.from('prep_recipe_ingredients').delete().eq('prep_recipe_id', id);
  await supabase.from('prep_recipes').delete().eq('id', id);
}

// ─── UPDATE/DELETE VENDOR ───────────────────────────────────────────────
export async function updateVendor(id: string, updates: Partial<Vendor>): Promise<void> {
  const dbUpdates: any = {};
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.contactName !== undefined) dbUpdates.contact_name = updates.contactName;
  if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
  if (updates.email !== undefined) dbUpdates.email = updates.email;
  if (updates.leadTimeDays !== undefined) dbUpdates.lead_time_days = updates.leadTimeDays;
  // Pass the empty string through too so an admin can clear a previously-set cutoff.
  if (updates.orderCutoffTime !== undefined) dbUpdates.order_cutoff_time = updates.orderCutoffTime || null;
  if (updates.eodDeadlineTime !== undefined) dbUpdates.eod_deadline_time = updates.eodDeadlineTime || null;
  await supabase.from('vendors').update(dbUpdates).eq('id', id);
}

export async function deleteVendor(id: string): Promise<void> {
  await supabase.from('vendors').delete().eq('id', id);
}

// ─── RECIPE CATEGORIES ──────────────────────────────────────────────────
export async function fetchRecipeCategories(): Promise<string[]> {
  const { data } = await supabase.from('recipe_categories').select('name').order('created_at');
  return (data || []).map((c: any) => c.name);
}

export async function addRecipeCategory(name: string): Promise<void> {
  await supabase.from('recipe_categories').insert({ name });
}

export async function updateRecipeCategory(oldName: string, newName: string): Promise<void> {
  await supabase.from('recipe_categories').update({ name: newName }).eq('name', oldName);
}

export async function deleteRecipeCategory(name: string): Promise<void> {
  await supabase.from('recipe_categories').delete().eq('name', name);
}

// ─── INGREDIENT CONVERSIONS ─────────────────────────────────────────────
// Conversions are brand-level — one row per catalog ingredient + purchase
// unit. The TS field name stays `inventoryItemId` for back-compat;
// semantically it's a catalog id.
export async function fetchIngredientConversions(catalogId?: string): Promise<IngredientConversion[]> {
  let query = supabase.from('ingredient_conversions').select('*');
  if (catalogId) query = query.eq('catalog_id', catalogId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((c: any) => ({
    id: c.id,
    inventoryItemId: c.catalog_id,
    purchaseUnit: c.purchase_unit,
    baseUnit: c.base_unit,
    conversionFactor: c.conversion_factor,
    netYieldPct: c.net_yield_pct,
  }));
}

export async function upsertIngredientConversion(conv: Omit<IngredientConversion, 'id'>): Promise<void> {
  // Conversions are brand-level after Phase 3: keyed by (catalog_id,
  // purchase_unit). The TS field name `inventoryItemId` is kept for
  // back-compat but the value passed is a catalog_ingredients.id.
  await supabase.from('ingredient_conversions').upsert({
    catalog_id: conv.inventoryItemId,
    purchase_unit: conv.purchaseUnit,
    base_unit: conv.baseUnit,
    conversion_factor: conv.conversionFactor,
    net_yield_pct: conv.netYieldPct,
  }, { onConflict: 'catalog_id,purchase_unit' });
}

// ─── VERSIONED PREP RECIPE UPDATE ───────────────────────────────────────
export async function updatePrepRecipeVersioned(id: string, updates: any): Promise<string> {
  // 1. Mark current version as not current
  await supabase.from('prep_recipes').update({ is_current: false }).eq('id', id);

  // 2. Get the parent_id (or use current id as parent if it's the original)
  const { data: current } = await supabase.from('prep_recipes').select('parent_id').eq('id', id).single();
  const parentId = current?.parent_id || id;

  // 3. Get current version number
  const { data: versions } = await supabase
    .from('prep_recipes')
    .select('version')
    .or(`id.eq.${parentId},parent_id.eq.${parentId}`)
    .order('version', { ascending: false })
    .limit(1);
  const nextVersion = (versions?.[0]?.version || 1) + 1;

  // 4. Create new version
  const brandId = updates.brandId || updates.storeId;
  const { data: newRecipe, error } = await supabase
    .from('prep_recipes')
    .insert({
      name: updates.name,
      category: updates.category,
      yield_quantity: updates.yieldQuantity,
      yield_unit: updates.yieldUnit,
      notes: updates.notes,
      brand_id: brandId,
      store_id: brandId, // legacy NOT NULL, dropped Phase 3
      version: nextVersion,
      is_current: true,
      parent_id: parentId,
    })
    .select()
    .single();
  if (error) throw error;

  // 5. Insert ingredients with base units (catalog_id only — Phase 3
  // dropped the legacy item_id column).
  if (updates.ingredients?.length > 0) {
    const validIngs = updates.ingredients.filter((i: any) => i.itemId && i.itemId.length > 10);
    if (validIngs.length > 0) {
      await supabase.from('prep_recipe_ingredients').insert(
        validIngs.map((i: any) => {
          const isPrep = (i.type || 'raw') === 'prep';
          return {
            prep_recipe_id: newRecipe.id,
            catalog_id: isPrep ? null : i.itemId,
            sub_recipe_id: isPrep ? i.itemId : null,
            type: i.type || 'raw',
            quantity: i.quantity,
            unit: i.unit,
            base_quantity: i.baseQuantity || 0,
            base_unit: i.baseUnit || 'g',
          };
        })
      );
    }
  }

  return newRecipe.id;
}

// ─── INGREDIENT CATEGORIES ──────────────────────────────────────────────
export async function fetchIngredientCategories(): Promise<string[]> {
  const { data } = await supabase.from('ingredient_categories').select('name').order('created_at');
  return (data || []).map((c: any) => c.name);
}

export async function addIngredientCategory(name: string): Promise<void> {
  await supabase.from('ingredient_categories').insert({ name });
}

export async function updateIngredientCategory(oldName: string, newName: string): Promise<void> {
  await supabase.from('ingredient_categories').update({ name: newName }).eq('name', oldName);
}

export async function deleteIngredientCategory(name: string): Promise<void> {
  await supabase.from('ingredient_categories').delete().eq('name', name);
}

// ─── POS RECIPE ALIASES ─────────────────────────────────────────────────
// Persistent (pos_name → recipe_id) mappings keyed per store. The matcher
// (src/utils/recipeMatch.ts) consults these before fuzzy logic so confirmed
// imports never re-fuzzy-match the same POS string.
export type PosRecipeAlias = {
  pos_name: string;
  recipe_id: string;
  store_id: string | null;
};

export async function fetchPosRecipeAliases(storeId: string): Promise<PosRecipeAlias[]> {
  const { data, error } = await supabase
    .from('pos_recipe_aliases')
    .select('pos_name, recipe_id, store_id')
    .or(`store_id.eq.${storeId},store_id.is.null`);
  if (error) {
    console.warn('[Supabase] fetchPosRecipeAliases:', error.message);
    return [];
  }
  return (data || []) as PosRecipeAlias[];
}

export async function upsertPosRecipeAliases(
  rows: { posName: string; recipeId: string; storeId: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    pos_name: r.posName.trim(),
    recipe_id: r.recipeId,
    store_id: r.storeId,
    last_used_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('pos_recipe_aliases')
    .upsert(payload, { onConflict: 'pos_name,store_id' });
  if (error) console.warn('[Supabase] upsertPosRecipeAliases:', error.message);
}

// Past unmapped pos_import_items grouped by menu_item, for the review section
// in POSImportScreen. Last 30 days, current store only.
export async function fetchUnmappedPosImports(storeId: string): Promise<{ menu_item: string; count: number }[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('pos_import_items')
    .select('menu_item, pos_imports!inner(store_id, import_date)')
    .eq('recipe_mapped', false)
    .eq('pos_imports.store_id', storeId)
    .gte('pos_imports.import_date', since);
  if (error) {
    console.warn('[Supabase] fetchUnmappedPosImports:', error.message);
    return [];
  }
  const counts = new Map<string, number>();
  for (const row of (data || []) as any[]) {
    const name = (row.menu_item || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([menu_item, count]) => ({ menu_item, count }))
    .sort((a, b) => b.count - a.count);
}

// Retroactively map past unmapped pos_import_items rows to a recipe. v1 fixes
// only the display flag — does NOT deduct inventory (user can re-import the
// affected day if stock adjustment is needed).
export async function applyAliasToPastImports(
  storeId: string,
  posName: string,
  recipeId: string,
): Promise<number> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: imports, error: impErr } = await supabase
    .from('pos_imports').select('id')
    .eq('store_id', storeId)
    .gte('import_date', since);
  if (impErr || !imports || imports.length === 0) return 0;
  const importIds = imports.map((i: any) => i.id);
  const { error: updErr, count } = await supabase
    .from('pos_import_items')
    .update({ recipe_id: recipeId, recipe_mapped: true }, { count: 'exact' })
    .ilike('menu_item', posName)
    .eq('recipe_mapped', false)
    .in('import_id', importIds);
  if (updErr) {
    console.warn('[Supabase] applyAliasToPastImports:', updErr.message);
    return 0;
  }
  return count || 0;
}

// ─── REPORT DEFINITIONS ──────────────────────────────────────────────────
// Saved reports created from the + NEW REPORT modal in the cmd theme.
// Templates are hardcoded in client code; this just persists the user's
// instances (name + template + scope + params).

import type { ReportDefinition } from '../types';

const mapReportRow = (r: any): ReportDefinition => ({
  id: r.id,
  storeId: r.store_id,
  templateId: r.template_id,
  name: r.name,
  scope: r.scope || undefined,
  params: r.params || {},
  createdBy: r.created_by || undefined,
  createdAt: r.created_at,
});

export async function fetchSavedReports(storeId: string): Promise<ReportDefinition[]> {
  const { data, error } = await supabase
    .from('report_definitions')
    .select('id, store_id, template_id, name, scope, params, created_by, created_at')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[Supabase] fetchSavedReports:', error.message); return []; }
  return (data || []).map(mapReportRow);
}

export async function createReportDefinition(
  rep: Omit<ReportDefinition, 'id' | 'createdAt'>,
): Promise<ReportDefinition | null> {
  const { data, error } = await supabase
    .from('report_definitions')
    .insert({
      store_id: rep.storeId,
      template_id: rep.templateId,
      name: rep.name,
      scope: rep.scope || null,
      params: rep.params || {},
      created_by: rep.createdBy || null,
    })
    .select()
    .single();
  if (error) { console.warn('[Supabase] createReportDefinition:', error.message); return null; }
  return mapReportRow(data);
}

export async function deleteReportDefinition(id: string): Promise<void> {
  if (!id || id.length < 10) return;
  const { error } = await supabase.from('report_definitions').delete().eq('id', id);
  if (error) console.warn('[Supabase] deleteReportDefinition:', error.message);
}

// ─── BRAND + CATALOG ────────────────────────────────────────────────────
/**
 * Resolve the brand a store belongs to. Single-tenant for now (one
 * brand). When this returns null, the caller should fall back to the
 * first row of `brands` (defensive — a store should always have a
 * brand_id post-migration).
 */
export async function fetchBrandForStore(storeId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from('stores')
    .select('brand:brands(id, name)')
    .eq('id', storeId)
    .single();
  if (error || !data?.brand) return null;
  // PostgREST 1:1 join shape (single object) — but supabase-js typings
  // sometimes infer it as an array; coerce defensively.
  const b: any = Array.isArray(data.brand) ? data.brand[0] : data.brand;
  return b ? { id: b.id, name: b.name } : null;
}

export async function fetchCatalogIngredients(brandId: string) {
  const { data, error } = await supabase
    .from('catalog_ingredients')
    .select('*')
    .eq('brand_id', brandId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []).map((c: any) => ({
    id: c.id,
    brandId: c.brand_id,
    name: c.name,
    unit: c.unit,
    category: c.category || '',
    caseQty: parseFloat(c.case_qty) || 1,
    subUnitSize: parseFloat(c.sub_unit_size) || 1,
    subUnitUnit: c.sub_unit_unit || '',
    defaultCost: parseFloat(c.default_cost) || 0,
    defaultCasePrice: parseFloat(c.default_case_price) || 0,
  }));
}

// ─── FETCH ALL FOR STORE (bulk load) ────────────────────────────────────
/**
 * Bulk load for a single store. Resolves the store's brand up front and
 * fetches brand-level data (catalog, recipes, preps, vendors, etc.)
 * brand-scoped, then per-store data (inventory, EOD, waste, audit, etc.)
 * scoped to the store. Both halves run in parallel.
 */
export async function fetchAllForStore(storeId: string) {
  const brand = await fetchBrandForStore(storeId);
  const brandId = brand?.id || '';

  const [
    inventory, catalog, recipes, prepRecipes, vendors, wasteLog, auditLog,
    categories, ingCategories, conversions, orderSched,
    eodSubmissions, orderSubmissions, posRecipeAliases, savedReports,
  ] = await Promise.all([
    fetchInventory().catch(() => []), // all stores; needed for cross-store name lookups in some legacy paths
    brandId ? fetchCatalogIngredients(brandId).catch(() => []) : Promise.resolve([]),
    brandId ? fetchRecipes(brandId).catch(() => []) : Promise.resolve([]),
    brandId ? fetchPrepRecipes(brandId).catch(() => []) : Promise.resolve([]),
    fetchVendors(brandId).catch(() => []),
    fetchWasteLog(storeId).catch(() => []),
    fetchAuditLog(storeId).catch(() => []),
    fetchRecipeCategories().catch(() => []),
    fetchIngredientCategories().catch(() => []),
    fetchIngredientConversions().catch(() => []),
    fetchOrderSchedule(storeId).catch(() => ({})),
    fetchRecentEODSubmissions(storeId).catch(() => []),
    fetchRecentPurchaseOrders(storeId).catch(() => []),
    fetchPosRecipeAliases(storeId).catch(() => [] as PosRecipeAlias[]),
    fetchSavedReports(storeId).catch(() => [] as ReportDefinition[]),
  ]);
  return {
    brand,
    catalogIngredients: catalog,
    inventory, recipes, prepRecipes, vendors, wasteLog, auditLog,
    recipeCategories: categories, ingredientCategories: ingCategories,
    ingredientConversions: conversions, orderSchedule: orderSched,
    eodSubmissions, orderSubmissions, posRecipeAliases, savedReports,
  };
}

// ─── ORDER SCHEDULE ─────────────────────────────────────────────────────
export async function fetchOrderSchedule(storeId: string): Promise<Record<string, any[]>> {
  const { data, error } = await supabase
    .from('order_schedule')
    .select('*')
    .eq('store_id', storeId);
  if (error) throw error;
  const schedule: Record<string, any[]> = {};
  (data || []).forEach((row: any) => {
    if (!schedule[row.day_of_week]) schedule[row.day_of_week] = [];
    schedule[row.day_of_week].push({
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      deliveryDay: row.delivery_day,
    });
  });
  return schedule;
}

export async function saveOrderSchedule(storeId: string, day: string, vendors: any[]): Promise<void> {
  // Delete existing entries for this store+day, then insert new ones
  await supabase.from('order_schedule').delete().eq('store_id', storeId).eq('day_of_week', day);
  if (vendors.length > 0) {
    await supabase.from('order_schedule').insert(
      vendors.map((v: any) => ({
        store_id: storeId,
        day_of_week: day,
        vendor_id: v.vendorId || null,
        vendor_name: v.vendorName,
        delivery_day: v.deliveryDay,
      }))
    );
  }
}

// ─── CLEANUP OLD RECORDS (90-day retention) ─────────────────────────────
// Note: supabase-js v2 filter builders are thenable but don't expose `.catch`,
// so chaining `.catch(() => {})` directly on `.delete().lt(...)` throws a
// TypeError synchronously. We wrap each in an async helper that awaits the
// thenable inside try/catch — one bad cleanup shouldn't break the others.
export async function cleanupOldRecords(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffISO = cutoff.toISOString();
  const nowISO = new Date().toISOString();

  const safe = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    try {
      const { error } = await p;
      if (error) console.warn('[Supabase] cleanupOldRecords', label, error);
    } catch (e: any) {
      console.warn('[Supabase] cleanupOldRecords', label, e?.message || e);
    }
  };

  await Promise.all([
    // EOD entries (child rows) — delete via submissions
    safe('eod_submissions', supabase.from('eod_submissions').delete().lt('submitted_at', cutoffISO)),
    // Waste log
    safe('waste_log', supabase.from('waste_log').delete().lt('logged_at', cutoffISO)),
    // Audit log
    safe('audit_log', supabase.from('audit_log').delete().lt('created_at', cutoffISO)),
    // POS imports (child rows cascade) — column is imported_at, not created_at
    safe('pos_imports', supabase.from('pos_imports').delete().lt('imported_at', cutoffISO)),
    // Order submissions
    safe('purchase_orders', supabase.from('purchase_orders').delete().lt('created_at', cutoffISO)),
    // Expired invitations
    safe('invitations', supabase.from('invitations').delete().lt('expires_at', nowISO).eq('used', false)),
  ]);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────
function mapItem(row: any): InventoryItem {
  // Catalog fields (name/unit/category/case_qty/sub_unit_*) live on
  // catalog_ingredients; hydrated via the JOIN aliased as `catalog`.
  // Per-store fields (cost_per_unit, case_price, current_stock, par_level,
  // vendor_id, eod_remaining, etc.) stay on inventory_items.
  const cat = row.catalog || {};
  const caseQty = parseFloat(cat.case_qty) || 1;
  const subUnitSize = parseFloat(cat.sub_unit_size) || 1;
  return {
    id: row.id,
    catalogId: row.catalog_id || cat.id || '',
    name: cat.name || '',
    category: cat.category || '',
    unit: cat.unit || '',
    costPerUnit: (() => {
      const stored = parseFloat(row.cost_per_unit) || 0;
      if (stored > 0) return stored;
      const cp = parseFloat(row.case_price) || 0;
      const total = caseQty * subUnitSize;
      return total > 0 && cp > 0 ? cp / total : 0;
    })(),
    currentStock: row.current_stock || 0,
    parLevel: row.par_level || 0,
    averageDailyUsage: row.average_daily_usage || 0,
    safetyStock: row.safety_stock || 0,
    vendorId: row.vendor_id || '',
    vendorName: row.vendor?.name || '',
    usagePerPortion: row.usage_per_portion || 0,
    expiryDate: row.expiry_date || '',
    lastUpdatedBy: row.updater?.name || '',
    lastUpdatedAt: row.updated_at ? new Date(row.updated_at).toLocaleString() : '',
    eodRemaining: row.eod_remaining || 0,
    storeId: row.store_id,
    casePrice: row.case_price || 0,
    caseQty,
    subUnitSize,
    subUnitUnit: cat.sub_unit_unit || '',
  };
}
