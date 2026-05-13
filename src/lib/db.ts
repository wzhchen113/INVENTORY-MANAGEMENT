// src/lib/db.ts
// All database operations — drop-in replacements for the Zustand seed data
import { supabase } from './supabase';
import {
  InventoryItem, Recipe, WasteEntry, EODSubmission,
  Vendor, AuditEvent, Store, IngredientConversion,
  SidebarLayoutOverride, POSImport, Brand, User,
  InventoryCount, InventoryCountKind, InventoryCountSummary,
  ReorderPayload, ReorderVendor, ReorderItem, OnHandSource,
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
  // brand_id is load-bearing post-Spec-012a — the stores INSERT policy
  // requires auth_can_see_brand(brand_id), and NULL fails that check for
  // any non-super-admin. Caller (addStore in useStore) must resolve
  // brandId via the same chain other actions use:
  //   recipe.brandId || get().brand?.id || get().currentStore.brandId
  const { data, error } = await supabase
    .from('stores')
    .insert({
      name: store.name,
      address: store.address,
      status: store.status || 'active',
      brand_id: store.brandId || null,
    })
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

/**
 * Spec 012b cleanup #1 — extracted from auth.ts so PostgREST traffic stays
 * in db.ts per CLAUDE.md. Returns the set of store ids belonging to a brand,
 * used by fetchAllUsers to clip cross-brand grants out of the per-user store
 * list.
 */
export async function fetchStoreIdsForBrand(brandId: string): Promise<Set<string>> {
  const { data } = await supabase.from('stores').select('id').eq('brand_id', brandId);
  return new Set((data || []).map((s: any) => s.id));
}

/**
 * Spec 012b cleanup #1 — extracted from auth.ts. Pulls (email, profile_id,
 * name, brand_id) for invitation rows used to infer email for active
 * profiles. When `brandId` is supplied (cleanup #16) the query is scoped at
 * the SQL layer instead of pulling the whole table.
 */
export async function fetchInvitationsForUserLookup(
  brandId?: string,
): Promise<Array<{ email: string; profile_id: string | null; name: string; brand_id: string | null }>> {
  let q = supabase.from('invitations').select('email, profile_id, name, brand_id');
  if (brandId) q = q.eq('brand_id', brandId);
  const { data } = await q;
  return (data || []) as any[];
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
 * Resolve the brand for a given store id — used by createInventoryItem
 * when the caller didn't pass a brandId explicitly.
 */
async function brandIdForStore(storeId: string): Promise<string> {
  const { data } = await supabase.from('stores').select('brand_id').eq('id', storeId).single();
  return data?.brand_id || '';
}

/**
 * Create a per-store inventory item, find-or-creating the brand-level
 * catalog_ingredients row in one atomic transaction via the
 * `create_inventory_item_with_catalog` Postgres function.
 *
 * Idempotent on the (store_id, catalog_id) unique — calling twice with
 * the same name+store returns the same row instead of throwing 23505.
 * If the inventory insert fails partway through, the catalog row is
 * not leaked because both writes share the function's transaction.
 *
 * The legacy code path (separate ensureCatalogIngredient + INSERT) was
 * non-atomic and threw on duplicates; this RPC closes both gaps —
 * issue #5 from the PR #3 review.
 */
export async function createInventoryItem(item: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
  const vendorId = item.vendorId && item.vendorId.length > 10 ? item.vendorId : null;
  const storeId = item.storeId && item.storeId.length > 10 ? item.storeId : null;
  if (!storeId) throw new Error('Invalid store ID');

  const brandId = await brandIdForStore(storeId);
  if (!brandId) throw new Error(`Store ${storeId} has no brand_id — run brand catalog migrations`);

  const { data, error } = await supabase.rpc('create_inventory_item_with_catalog', {
    p_brand_id:           brandId,
    p_store_id:           storeId,
    p_name:               item.name,
    p_unit:               item.unit || '',
    p_category:           item.category || null,
    p_case_qty:           item.caseQty ?? 1,
    p_sub_unit_size:      item.subUnitSize ?? 1,
    p_sub_unit_unit:      item.subUnitUnit || '',
    p_default_cost:       item.costPerUnit ?? 0,
    p_default_case_price: item.casePrice ?? 0,
    p_per_store: {
      vendor_id:           vendorId,
      cost_per_unit:       item.costPerUnit ?? 0,
      case_price:          item.casePrice ?? 0,
      par_level:           item.parLevel ?? 0,
      current_stock:       item.currentStock ?? 0,
      average_daily_usage: item.averageDailyUsage ?? 0,
      safety_stock:        item.safetyStock ?? 0,
      usage_per_portion:   item.usagePerPortion ?? 0,
      expiry_date:         item.expiryDate || null,
    },
  });
  if (error) throw error;
  // The RPC returns a jsonb shaped exactly like a PostgREST embed
  // response, so mapItem can consume it directly.
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
  // Upsert by (brand_id, menu_item). P3 dropped the legacy
  // (menu_item, store_id) index AND the store_id column on recipes,
  // so the conflict target is the new recipes_brand_menu_item_unique.
  const { data, error } = await supabase
    .from('recipes')
    .upsert(
      {
        brand_id: brandId,
        menu_item: recipe.menuItem,
        category: recipe.category,
        sell_price: recipe.sellPrice,
      },
      { onConflict: 'brand_id,menu_item' }
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
  // Spec 020 — vendor_id is required and partitions the (store_id, date)
  // unique key. The Cmd UI's admin-JWT path stays on direct PostgREST
  // (RPC is gated to service_role and used by the staff-app Edge Function);
  // the upsert ON CONFLICT uses the new (store_id, date, vendor_id) unique
  // so two vendors on one date coexist and the EDIT path on the same
  // vendor preserves the eod_submissions.id.
  const { data, error } = await supabase
    .from('eod_submissions')
    .upsert(
      {
        store_id: submission.storeId,
        date: new Date(submission.date).toISOString().split('T')[0],
        vendor_id: submission.vendorId,
        submitted_by: submission.submittedByUserId,
        status: submission.status || 'submitted',
        submitted_at: new Date().toISOString(),
      },
      { onConflict: 'store_id,date,vendor_id' }
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

    // Update eod_remaining on each item — vendor-scoped per Q6. Items
    // belonging to a different vendor (e.g. via the unscheduled-item
    // escape hatch) still get an eod_entries row above but the inventory
    // mutation is skipped to mirror the RPC's behavior.
    for (const entry of submission.entries) {
      const upd = await supabase
        .from('inventory_items')
        .update({ eod_remaining: entry.actualRemaining, last_updated_by: submission.submittedByUserId })
        .eq('id', entry.itemId)
        .eq('vendor_id', submission.vendorId);
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
      id, store_id, date, vendor_id, status, submitted_at, submitted_by,
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
    // Spec 020 — vendor_id is server-side; vendorName hydrates client-side.
    vendorId: row.vendor_id,
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
    .select(`id, store_id, date, vendor_id, submitted_by, submitted_at, status,
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
    // Spec 020 — vendor_id is server-side; vendorName hydrates client-side.
    vendorId: row.vendor_id,
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

// Spec 009 §5/D2 — cross-store EOD fan-out for the All-Stores dashboard.
// Per the architect, useStore.loadFromSupabase('__all__') only flatMaps
// inventory/wasteLog/auditLog across stores; eodSubmissions are NOT
// flatMapped (they stay scoped to whichever single store last loaded).
// Without this helper the dashboard heatmap and per-store CoGS columns
// can't compute for non-focal stores. Decision D2(b): hold the result
// in component-local state inside DashboardSection rather than mutating
// the Zustand slice — keeps the blast radius zero for every other Cmd
// section that consumed eodSubmissions in __all__ mode previously.
//
// Single-trip IN(...) select; RLS (auth_can_see_store) silently drops
// any rows the caller can't see, so we don't need to pre-filter the
// storeIds list. Returns the same camelCase shape as
// fetchRecentEODSubmissions so downstream selectors are interchangeable.
export async function fetchEodSubmissionsForStores(
  storeIds: string[],
  sinceDate: string,
): Promise<EODSubmission[]> {
  if (storeIds.length === 0) return [];
  const { data, error } = await supabase
    .from('eod_submissions')
    .select(`id, store_id, date, vendor_id, submitted_by, submitted_at, status,
             submitter:profiles!submitted_by(name),
             eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                         item:inventory_items(catalog:catalog_ingredients(name, unit)))`)
    .in('store_id', storeIds)
    .gte('date', sinceDate)
    .order('submitted_at', { ascending: false });
  if (error) {
    console.warn('[Supabase] fetchEodSubmissionsForStores:', error.message);
    return [];
  }
  return (data || []).map((row: any) => ({
    id: row.id,
    storeId: row.store_id,
    storeName: '', // backfilled by caller against useStore.stores if needed
    // Spec 020 — vendor_id is server-side; vendorName hydrates client-side.
    vendorId: row.vendor_id,
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

/**
 * Spec 018 (REPORTS-3) — most-recent `limit` submitted EOD DISTINCT dates
 * for `storeId`, descending. Used by NewReportModal to seed the Prior EOD /
 * Current EOD inputs when picking the variance template. Returns
 * `string[]` of ISO dates (YYYY-MM-DD); `[]` on error or empty (RLS
 * denial, network issue, or store has no submissions). No camelCase
 * mapping needed — the column is `date` on both sides.
 *
 * Spec 020: `eod_submissions` is partitioned per-vendor now, so a single
 * day produces N rows. We DEDUPE in JS via `Set` and only then slice to
 * `limit`. Without this, two same-day vendor submissions feed the variance
 * modal `{ from: '2026-05-12', to: '2026-05-12' }`, which then RAISEs
 * `22023` ("from must be < to") in `report_run_variance`. Over-fetch one
 * extra distinct day's worth of rows so the post-dedupe slice still has
 * enough material to fill the modal's prior/current pair.
 *
 * RLS: `eod_submissions` is per-store via `auth_can_see_store(store_id)`
 * from `20260504173035_per_store_rls_hardening.sql:46-61`, so a caller
 * with no visibility to `storeId` gets `[]` here.
 */
export async function fetchRecentEodDates(
  storeId: string,
  limit: number = 2,
): Promise<string[]> {
  // Fetch extra rows so the dedupe still has enough distinct dates after
  // collapsing same-day vendor partitions. 16 covers up to 8 vendors-per-day
  // for a 2-day window in the worst realistic case.
  const fetchLimit = Math.max(limit * 8, 16);
  const { data, error } = await supabase
    .from('eod_submissions')
    .select('date')
    .eq('store_id', storeId)
    .eq('status', 'submitted')
    .order('date', { ascending: false })
    .limit(fetchLimit);
  if (error) {
    console.warn('[Supabase] fetchRecentEodDates:', error.message);
    return [];
  }
  return [...new Set((data || []).map((r: any) => r.date as string))].slice(0, limit);
}

// ─── INVENTORY COUNTS (Spec 019) ────────────────────────────────────────
// Any-time inventory count — parallel to eod_submissions. The migration
// (`supabase/migrations/20260513000000_inventory_counts.sql`) defines the
// `inventory_counts` + `inventory_count_entries` tables and the
// `submit_inventory_count(...)` SECURITY INVOKER RPC.
//
// Signatures here match the architect's design in spec 019 §5 verbatim so
// the section component compiles against the same contract whether the
// migration has landed yet or not. Bodies route through supabase.rpc /
// supabase.from with the snake_case → camelCase mapping the rest of this
// file uses.
//
// `current_stock` is intentionally NOT updated by this path — spot counts
// are advisory historical snapshots only (spec 019 Q2 default).

/**
 * Submit a non-EOD inventory count for the active store. Mints nothing
 * server-side beyond the parent row + the kept-non-blank entries.
 * `client_uuid` is the caller-minted idempotency key (mirrors
 * `staff_submit_eod`). On a duplicate `client_uuid` the RPC returns
 * `conflict: true` with the existing `count_id` rather than inserting a
 * second row.
 *
 * The RPC enforces:
 *  - caller can see `storeId` via `auth_can_see_store`
 *  - `kind` ∈ { spot, open, mid_shift, close } (rejects 'eod')
 *  - `entries` array has ≥ 1 element AND ≥ 1 non-blank kept row
 *  - each entry's `itemId` belongs to `storeId`
 *  - per-entry counted quantities are non-negative
 *
 * Throws on any of those — the store action wraps in `notifyBackendError`.
 */
export async function submitInventoryCount(input: {
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;             // ISO; server-side defaults to now() if null
  status?: 'draft' | 'submitted';
  entries: Array<{
    itemId: string;
    actualRemaining?: number | null;
    actualRemainingCases?: number | null;
    actualRemainingEach?: number | null;
    unit?: string | null;
    notes?: string | null;
  }>;
  notes?: string | null;
  clientUuid: string;            // caller mints via crypto.randomUUID()
}): Promise<{ countId: string; conflict: boolean; entryIds: string[] }> {
  const { data, error } = await supabase.rpc('submit_inventory_count', {
    p_client_uuid: input.clientUuid,
    p_store_id:    input.storeId,
    p_kind:        input.kind,
    p_counted_at:  input.countedAt || null,
    p_status:      input.status || 'submitted',
    p_entries:     input.entries.map((e) => ({
      item_id: e.itemId,
      actual_remaining: e.actualRemaining ?? null,
      actual_remaining_cases: e.actualRemainingCases ?? null,
      actual_remaining_each: e.actualRemainingEach ?? null,
      unit: e.unit ?? null,
      notes: e.notes ?? null,
    })),
    p_notes: input.notes ?? null,
  });
  if (error) {
    console.warn('[Supabase] submitInventoryCount:', error.message, error);
    throw error;
  }
  const result = (data || {}) as { count_id?: string; conflict?: boolean; entry_ids?: string[] };
  return {
    countId: result.count_id || '',
    conflict: !!result.conflict,
    entryIds: result.entry_ids || [],
  };
}

/**
 * Last N inventory counts for a store, descending by counted_at. Used by
 * the InventoryCountSection's "Recent counts" panel. Mirrors the shape of
 * `fetchRecentEODSubmissions` but with the `kind` discriminator and a
 * derived `itemCount` from a count-aggregate embed.
 */
export async function fetchRecentInventoryCounts(
  storeId: string,
  limit: number = 10,
): Promise<InventoryCountSummary[]> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select(`
      id, store_id, kind, counted_at, submitted_by, submitted_at, status, notes,
      submitter:profiles!submitted_by(name),
      inventory_count_entries(count)
    `)
    .eq('store_id', storeId)
    .order('counted_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[Supabase] fetchRecentInventoryCounts:', error.message);
    return [];
  }
  return (data || []).map((row: any) => ({
    id: row.id,
    storeId: row.store_id,
    kind: row.kind as InventoryCountKind,
    countedAt: row.counted_at,
    submittedBy: row.submitted_by,
    submitterName: row.submitter?.name || undefined,
    submittedAt: row.submitted_at,
    status: row.status,
    // PostgREST's `inventory_count_entries(count)` aggregate returns either
    // `[{ count: N }]` or a numeric — handle both defensively.
    itemCount: Array.isArray(row.inventory_count_entries)
      ? Number(row.inventory_count_entries[0]?.count ?? 0)
      : Number(row.inventory_count_entries?.count ?? 0),
    notes: row.notes || null,
  }));
}

/**
 * Full detail for one inventory count (parent + entries with item names
 * hydrated via the catalog join). Returns null if the count doesn't
 * exist or RLS hides it from this caller.
 */
export async function fetchInventoryCount(
  countId: string,
): Promise<InventoryCount | null> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select(`
      id, store_id, kind, counted_at, submitted_by, submitted_at, status, notes, client_uuid, created_at,
      submitter:profiles!submitted_by(name),
      inventory_count_entries(
        id, count_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, unit, notes, created_at,
        item:inventory_items(catalog:catalog_ingredients(name, unit))
      )
    `)
    .eq('id', countId)
    .maybeSingle();
  if (error) {
    console.warn('[Supabase] fetchInventoryCount:', error.message);
    return null;
  }
  if (!data) return null;
  const row: any = data;
  return {
    id: row.id,
    storeId: row.store_id,
    kind: row.kind as InventoryCountKind,
    countedAt: row.counted_at,
    submittedBy: row.submitted_by,
    submitterName: row.submitter?.name || undefined,
    submittedAt: row.submitted_at,
    status: row.status,
    clientUuid: row.client_uuid || null,
    notes: row.notes || null,
    createdAt: row.created_at,
    entries: (row.inventory_count_entries || []).map((e: any) => ({
      id: e.id,
      countId: e.count_id,
      itemId: e.item_id,
      itemName: e.item?.catalog?.name || '',
      actualRemaining: e.actual_remaining != null ? Number(e.actual_remaining) : null,
      actualRemainingCases: e.actual_remaining_cases != null ? Number(e.actual_remaining_cases) : undefined,
      actualRemainingEach: e.actual_remaining_each != null ? Number(e.actual_remaining_each) : undefined,
      unit: e.unit || e.item?.catalog?.unit || null,
      notes: e.notes || null,
      createdAt: e.created_at,
    })),
  };
}

// Spec 009 §5/D2 — cross-store POS imports fan-out for the All-Stores
// dashboard's CoGS theoretical computation. Same rationale as
// fetchEodSubmissionsForStores above: __all__ mode doesn't flatMap
// posImports, and the dashboard needs them per-store to compute
// theoretical depletion (POS qty × recipe BoM × per-store cost). Holds
// in component-local state per Decision D2(b).
//
// Joins pos_import_items in a single round trip; RLS on pos_imports
// scopes by store_id, RLS on pos_import_items scopes via the parent
// pos_import. Returns the camelCase POSImport shape (matching
// useStore.posImports semantics).
export async function fetchPosImportsForStores(
  storeIds: string[],
  sinceDate: string,
): Promise<POSImport[]> {
  if (storeIds.length === 0) return [];
  const { data, error } = await supabase
    .from('pos_imports')
    .select(`id, store_id, filename, imported_by, import_date, imported_at,
             importer:profiles!imported_by(name),
             pos_import_items(id, menu_item, qty_sold, revenue, recipe_id, recipe_mapped)`)
    .in('store_id', storeIds)
    .gte('import_date', sinceDate)
    .order('import_date', { ascending: false });
  if (error) {
    console.warn('[Supabase] fetchPosImportsForStores:', error.message);
    return [];
  }
  return (data || []).map((row: any) => ({
    id: row.id,
    filename: row.filename || '',
    importedAt: row.imported_at,
    importedBy: row.importer?.name || '',
    date: row.import_date,
    storeId: row.store_id,
    items: (row.pos_import_items || []).map((it: any) => ({
      menuItem: it.menu_item || '',
      qtySold: Number(it.qty_sold) || 0,
      revenue: Number(it.revenue) || 0,
      recipeId: it.recipe_id || undefined,
      recipeMapped: !!it.recipe_mapped,
    })),
  }));
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

// ─── SIDEBAR LAYOUT (Spec 008) ─────────────────────────────────────────
/**
 * Persist the user's Cmd UI sidebar override list to
 * `profiles.sidebar_layout`. Save-on-done semantics — the caller passes
 * the full override list (or `null` for "reset to default"); we don't do
 * partial writes. Throws on error so the store layer can revert and call
 * `notifyBackendError` per the optimistic-then-revert pattern.
 *
 * Gated by the existing "Users can update own profile" RLS policy on
 * profiles (id = auth.uid()), so a cross-user write is silently 0 rows.
 * See specs/008-sidebar-layout-customization.md §4.
 */
export async function saveSidebarLayout(
  userId: string,
  layout: SidebarLayoutOverride | null,
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ sidebar_layout: layout })
    .eq('id', userId);
  if (error) throw error;
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
  // Load ALL versions, not just is_current=true. Existing recipes may
  // reference an older prep_recipes.id (created before a version bump);
  // without those rows the cost calc returns $0. The resolver in
  // useStore.getPrepRecipe walks parent_id lineage to find the current
  // version when a recipe still points at a stale id. Section list views
  // filter to is_current=true in-memory so the UI doesn't change.
  let query = supabase
    .from('prep_recipes')
    .select(`*,
      prep_recipe_ingredients!prep_recipe_ingredients_prep_recipe_id_fkey(*,
        catalog:catalog_ingredients(id, name, unit)
      )`);
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

export async function fetchPrepRecipesByName(
  name: string,
  brandId?: string,
): Promise<{ id: string; brandId: string }[]> {
  let query = supabase
    .from('prep_recipes')
    .select('id, brand_id')
    .ilike('name', name.replace(/[%_]/g, '\\$&'))
    .eq('is_current', true);
  if (brandId) query = query.eq('brand_id', brandId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((r: any) => ({ id: r.id, brandId: r.brand_id }));
}

export async function createPrepRecipe(recipe: any): Promise<string> {
  const brandId = recipe.brandId || recipe.storeId;
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');

  // SELECT-then-INSERT-OR-UPDATE pattern. PostgREST .upsert() with
  // onConflict can't target a partial functional index
  // (prep_recipes_brand_name_current_unique uses lower(name) WHERE
  // is_current=true), so we look up an existing current row by name
  // first and route to updatePrepRecipeVersioned when found. This
  // makes "save same name twice" idempotent at the app layer too,
  // not just at the DB.
  const existing = await fetchPrepRecipesByName(recipe.name, brandId).catch(() => []);
  if (existing.length > 0) {
    return updatePrepRecipeVersioned(existing[0].id, recipe);
  }

  const { data, error } = await supabase
    .from('prep_recipes')
    .insert({
      name: recipe.name,
      category: recipe.category,
      yield_quantity: recipe.yieldQuantity,
      yield_unit: recipe.yieldUnit,
      notes: recipe.notes,
      brand_id: brandId,
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

// ─── Spec 004: explicit insert / update / delete for the conversions tab ──
// The existing `upsertIngredientConversion` above stays as-is for callers
// that don't need the saved row back. The functions below give the new
// CatalogConversionsTab write UI the row id (for optimistic-then-revert
// reconciliation) and a per-id update/delete path.
//
// Writes use `catalog_id` exclusively. The legacy `inventory_item_id`
// column was dropped post-P3 (probe-confirmed 2026-05-07); the TS field
// name `inventoryItemId` is preserved for back-compat with the rest of
// the codebase but the value passed IS a catalog_ingredients.id.

/** Insert a brand-new conversion. Returns the saved row mapped to the
 *  same camelCase shape as `fetchIngredientConversions` so optimistic
 *  callers can swap the temp id for the real one. */
export async function createIngredientConversion(
  conv: Omit<IngredientConversion, 'id'>,
): Promise<IngredientConversion> {
  const { data, error } = await supabase
    .from('ingredient_conversions')
    .insert({
      catalog_id: conv.inventoryItemId,
      purchase_unit: conv.purchaseUnit,
      base_unit: conv.baseUnit,
      conversion_factor: conv.conversionFactor,
      net_yield_pct: conv.netYieldPct,
    })
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    inventoryItemId: data.catalog_id,
    purchaseUnit: data.purchase_unit,
    baseUnit: data.base_unit,
    conversionFactor: data.conversion_factor,
    netYieldPct: data.net_yield_pct,
  };
}

/** Update an existing conversion by id. Used by the inline edit UI on
 *  CatalogConversionsTab — purchase_unit / base_unit / factor / yield. */
export async function updateIngredientConversion(
  id: string,
  patch: Partial<Pick<IngredientConversion, 'purchaseUnit' | 'baseUnit' | 'conversionFactor' | 'netYieldPct'>>,
): Promise<IngredientConversion> {
  const row: Record<string, unknown> = {};
  if (patch.purchaseUnit !== undefined) row.purchase_unit = patch.purchaseUnit;
  if (patch.baseUnit !== undefined) row.base_unit = patch.baseUnit;
  if (patch.conversionFactor !== undefined) row.conversion_factor = patch.conversionFactor;
  if (patch.netYieldPct !== undefined) row.net_yield_pct = patch.netYieldPct;
  const { data, error } = await supabase
    .from('ingredient_conversions')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    inventoryItemId: data.catalog_id,
    purchaseUnit: data.purchase_unit,
    baseUnit: data.base_unit,
    conversionFactor: data.conversion_factor,
    netYieldPct: data.net_yield_pct,
  };
}

/** Delete a conversion row by id. Used by the row-level "delete" action
 *  on the conversions tab. */
export async function deleteIngredientConversion(id: string): Promise<void> {
  const { error } = await supabase.from('ingredient_conversions').delete().eq('id', id);
  if (error) throw error;
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

// Spec 015 — delete a single store-scoped alias by (pos_name, store_id).
// Unlike upsertPosRecipeAliases above, this throws on error so the store
// action's optimistic-revert branch can fire. Filtering on store_id is
// load-bearing: it prevents accidentally deleting a global alias
// (store_id IS NULL) of the same pos_name when removing a store-scoped one.
export async function deletePosRecipeAlias(
  storeId: string,
  posName: string,
): Promise<void> {
  const { error } = await supabase
    .from('pos_recipe_aliases')
    .delete()
    .eq('store_id', storeId)
    .eq('pos_name', posName.trim());
  if (error) {
    console.warn('[Supabase] deletePosRecipeAlias:', error.message);
    throw error;
  }
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

// ─── REPORT RUNS (Spec 016 — REPORTS-1) ─────────────────────────────────
// Append-only history of report executions. `runReport` calls the dispatcher
// RPC then persists the resulting envelope; `fetchLatestRun` reads the most
// recent row matching the saved-definition or ad-hoc key.
import type { ReportRun, ReportRunOutput } from '../types';

const mapReportRunRow = (r: any): ReportRun => ({
  id: r.id,
  definitionId: r.definition_id || null,
  templateId: r.template_id,
  storeId: r.store_id,
  params: (r.params as Record<string, unknown>) || {},
  output: (r.output as ReportRunOutput | null) || null,
  status: r.status,
  errorMessage: r.error_message || null,
  ranAt: r.ran_at,
  ranBy: r.ran_by || null,
});

/**
 * Spec 016 — execute the dispatcher RPC for `templateId` against `storeId`,
 * then persist the resulting envelope to `report_runs`. Returns the
 * persisted row mapped to camelCase. Throws on either RPC OR insert
 * failure so the caller (store action) can route through
 * `notifyBackendError`.
 *
 * The envelope's `_status === 'not_implemented'` is NOT a runner error —
 * the dispatcher uses it to flag templates whose runner hasn't been wired
 * yet. Status is recorded as `'ok'`; the detail frame branches on
 * `_status` to render the "Runner coming soon" placeholder.
 *
 * Spec 016 follow-up (`20260510130000_report_runs_consistency.sql`):
 * - `ran_by` is intentionally NOT included in the INSERT. The column has a
 *   `default auth.uid()`, so the server populates it from the caller's
 *   JWT. This closes the audit-trail-forgery High flagged by the
 *   security-auditor — the client can no longer lie about who ran the
 *   report.
 * - When the dispatcher RPC errors, we sanitize `rpcError.message` before
 *   persisting. The deliberate `Not authorized for store …` raise stays
 *   verbatim (it's intentional auth feedback the user can act on);
 *   anything else becomes a generic copy and the raw error is logged via
 *   `console.warn`. This prevents PostgrestError text (constraint names,
 *   table names, hint fragments) from leaking into a row that any
 *   store-member can read once REPORTS-2/3 lands real RPCs.
 *
 * Spec 017 (REPORTS-2) — `overrideParams` lets callers shadow the saved
 * `params` for this run only (e.g. the chip-dropdown in
 * `ReportDetailFrame` letting the user change the date range without
 * saving it back to the definition). When set, the override is merged
 * FLAT over `params` (`{ ...params, ...overrideParams }`) and the merged
 * object is BOTH sent to the dispatcher AND persisted to the
 * `report_runs.params` column. The persisted value reflects what was
 * actually computed, so the audit trail is honest. The saved
 * `ReportDefinition.params` is unchanged — that's the store action's
 * concern, not this helper's.
 */
export async function runReport(args: {
  definitionId?: string | null;
  templateId: string;
  storeId: string;
  params?: Record<string, unknown>;
  /** Spec 017 — per-run shadow of `params`. See JSDoc above. */
  overrideParams?: Record<string, unknown>;
}): Promise<ReportRun> {
  const baseParams = args.params || {};
  // Flat merge: override keys win. Persisting the merged object means the
  // audit trail shows what was actually computed for this run; the saved
  // definition's params (passed in as `args.params`) is untouched.
  const params = args.overrideParams
    ? { ...baseParams, ...args.overrideParams }
    : baseParams;
  const { data: envelope, error: rpcError } = await supabase.rpc('report_run', {
    p_template_id: args.templateId,
    p_store_id: args.storeId,
    p_params: params,
  });

  let output: ReportRunOutput | null;
  let status: 'ok' | 'error';
  let errorMessage: string | null;
  if (rpcError) {
    output = { kpis: [], columns: [], rows: [], series: null };
    status = 'error';
    // Sanitize before persisting. The deliberate 'Not authorized for
    // store …' raise from the dispatcher is intentional and useful; any
    // other Postgres error text could leak schema details to every
    // store-member who reads the row.
    const rawMessage = rpcError.message || '';
    if (rawMessage.startsWith('Not authorized')) {
      errorMessage = rawMessage;
    } else {
      console.warn('[Supabase] runReport RPC failed:', rpcError);
      errorMessage = 'Run failed — check server logs';
    }
  } else {
    output = (envelope as ReportRunOutput) || { kpis: [], columns: [], rows: [], series: null };
    status = 'ok';
    errorMessage = null;
  }

  const { data: inserted, error: insertError } = await supabase
    .from('report_runs')
    .insert({
      definition_id: args.definitionId || null,
      template_id: args.templateId,
      store_id: args.storeId,
      params,
      output,
      status,
      error_message: errorMessage,
      // ran_by is server-populated from `default auth.uid()`. Do not pass
      // it from the client — that would let a misbehaving caller forge
      // the audit trail.
    })
    .select('id, definition_id, template_id, store_id, params, output, status, error_message, ran_at, ran_by')
    .single();
  if (insertError) {
    // Don't swallow — the caller's notifyBackendError needs to surface this
    // to the user; otherwise we'd silently lose the run row.
    throw insertError;
  }
  return mapReportRunRow(inserted);
}

/**
 * Spec 016 — most recent run for either a saved definition (preferred) or
 * an ad-hoc `(storeId, templateId)` key. Returns `null` when no rows
 * exist; the detail frame interprets that as the "No runs yet" empty
 * state. Errors are swallowed to a `console.warn` because a missing run
 * is not user-facing.
 */
export async function fetchLatestRun(args: {
  definitionId?: string | null;
  templateId?: string;
  /** Required for the ad-hoc branch (`definitionId` null + `templateId`
   *  set). Not needed when `definitionId` is set since the saved
   *  definition's id is globally unique. */
  storeId?: string;
}): Promise<ReportRun | null> {
  let query = supabase
    .from('report_runs')
    .select('id, definition_id, template_id, store_id, params, output, status, error_message, ran_at, ran_by')
    .order('ran_at', { ascending: false })
    .limit(1);

  if (args.definitionId) {
    query = query.eq('definition_id', args.definitionId);
  } else if (args.templateId && args.storeId) {
    // Ad-hoc branch: scope by (store, template) and explicitly exclude
    // saved-definition rows so we don't pick up a different user's saved
    // run that happens to share `(store_id, template_id)`.
    query = query
      .eq('store_id', args.storeId)
      .eq('template_id', args.templateId)
      .is('definition_id', null);
  } else {
    console.warn('[Supabase] fetchLatestRun: must pass definitionId, or templateId+storeId');
    return null;
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[Supabase] fetchLatestRun:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return mapReportRunRow(data[0]);
}

// ─── REORDER LIST (Spec 021) ────────────────────────────────────────────
/**
 * Spec 021 — vendor-grouped reorder suggestions for `storeId`. Calls the
 * server-side `report_reorder_list(p_store_id, p_params)` RPC, which
 * joins eod_submissions + eod_entries + inventory_items +
 * catalog_ingredients + vendors + order_schedule + POS/recipe usage and
 * returns one envelope per call. See spec 021 §5 for the SQL shape.
 *
 * `asOfDate` — optional YYYY-MM-DD override (the A7 date picker). When
 * omitted, the RPC defaults to the server's `current_date` (UTC). The
 * frontend should pass the store-local "today" string to avoid the
 * UTC-vs-store-tz edge case (same caveat as the variance/cogs runners).
 *
 * Errors bubble up; callers wrap with `notifyBackendError` (or in this
 * spec's case the store slice swallows to `reorderError` for the UI to
 * render a non-toast error pane).
 */
export async function fetchReorderSuggestions(
  storeId: string,
  asOfDate?: string,
): Promise<ReorderPayload> {
  const params: Record<string, unknown> = {};
  if (asOfDate) params.as_of_date = asOfDate;

  const { data, error } = await supabase.rpc('report_reorder_list', {
    p_store_id: storeId,
    p_params: params,
  });

  if (error) {
    // Don't swallow — caller decides whether to surface as a toast or an
    // in-section error pane. Matches the reports trilogy pattern.
    throw error;
  }

  const envelope = (data || {}) as any;
  const vendors: ReorderVendor[] = Array.isArray(envelope.vendors)
    ? envelope.vendors.map((v: any) => mapReorderVendor(v))
    : [];
  const kpis = envelope.kpis || {};
  return {
    asOfDate: envelope.as_of_date || asOfDate || '',
    vendors,
    kpis: {
      vendorCount: Number(kpis.vendor_count ?? 0),
      itemCount: Number(kpis.item_count ?? 0),
      totalEstimatedCost: Number(kpis.total_estimated_cost ?? 0),
      eodSourcedVendorCount: Number(kpis.eod_sourced_vendor_count ?? 0),
      stockFallbackVendorCount: Number(kpis.stock_fallback_vendor_count ?? 0),
    },
    warnings: Array.isArray(envelope._warnings)
      ? envelope._warnings.map((w: any) => ({
          code: String(w?.code ?? ''),
          message: String(w?.message ?? ''),
        }))
      : [],
  };
}

function mapReorderVendor(v: any): ReorderVendor {
  const items: ReorderItem[] = Array.isArray(v?.items)
    ? v.items.map((it: any) => ({
        itemId: String(it?.item_id ?? ''),
        itemName: String(it?.item_name ?? ''),
        unit: String(it?.unit ?? ''),
        onHand: Number(it?.on_hand ?? 0),
        pendingPoQty: Number(it?.pending_po_qty ?? 0),
        parLevel: Number(it?.par_level ?? 0),
        usageForecasted: Number(it?.usage_forecasted ?? 0),
        parReplacement: Number(it?.par_replacement ?? 0),
        suggestedQty: Number(it?.suggested_qty ?? 0),
        costPerUnit: Number(it?.cost_per_unit ?? 0),
        estimatedCost: Number(it?.estimated_cost ?? 0),
        flags: Array.isArray(it?.flags) ? it.flags.map((f: any) => String(f)) : [],
      }))
    : [];
  const source: OnHandSource = v?.on_hand_source === 'stock' ? 'stock' : 'eod';
  return {
    vendorId: String(v?.vendor_id ?? ''),
    vendorName: String(v?.vendor_name ?? ''),
    scheduleKnown: Boolean(v?.schedule_known ?? false),
    nextDeliveryDate: String(v?.next_delivery_date ?? ''),
    daysUntilNextDelivery: Number(v?.days_until_next_delivery ?? 0),
    onHandSource: source,
    eodSubmittedAt: v?.eod_submitted_at ? String(v.eod_submitted_at) : null,
    items,
    vendorTotalCost: Number(v?.vendor_total_cost ?? 0),
  };
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

/**
 * Spec 012b §5 — lightweight brands list for the BrandPicker dropdown.
 * Excludes soft-deleted by default. Read-gated by 012a's
 * `brand_member_read_brands` policy: super-admin sees all rows;
 * non-super-admin sees only their `profiles.brand_id` row (which is
 * fine for non-super-admin since the picker is hidden for them anyway).
 */
export async function fetchBrandsLite(opts?: {
  includeSoftDeleted?: boolean;
}): Promise<Brand[]> {
  let query = supabase.from('brands').select('id, name, deleted_at, created_at').order('name', { ascending: true });
  if (!opts?.includeSoftDeleted) {
    query = query.is('deleted_at', null);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((b: any) => ({
    id: b.id,
    name: b.name,
    deletedAt: b.deleted_at ?? null,
    createdAt: b.created_at ?? null,
  }));
}

/**
 * Spec 012b §5 — brands list with stats for the Brands section list pane.
 * Returns one row per brand (active only by default, deleted_at IS NULL)
 * plus counts for stores + admin members. The counts use PostgREST embeds
 * with `count` aggregates for a single round-trip.
 *
 * Spec 012c §5 — `opts.includeSoftDeleted` flips the `deleted_at IS NULL`
 * filter off so the BrandsSection Trash sub-tab can render soft-deleted
 * brands. Default is back-compat (active-only).
 */
export async function fetchBrandsWithStats(opts?: {
  includeSoftDeleted?: boolean;
}): Promise<Array<Brand & {
  storeCount: number;
  memberCount: number;
  catalogIngredientCount: number;
}>> {
  // Cleanup #3 — adds catalog_ingredients(count) per spec AC S1.
  // Cleanup #5 — profiles count is filtered to role IN (admin, master,
  // super_admin) so the UI's "X admins" label is accurate (regular `user`
  // role rows don't contribute).
  let primary = supabase
    .from('brands')
    .select(`
      id, name, created_at, deleted_at,
      stores(count),
      profiles!inner(count),
      catalog_ingredients(count)
    `)
    .in('profiles.role', ['admin', 'master', 'super_admin'])
    .order('name', { ascending: true });
  if (!opts?.includeSoftDeleted) {
    primary = primary.is('deleted_at', null);
  }
  const { data, error } = await primary;
  if (error) {
    // The !inner join drops brands with zero admin profiles. Fall back to
    // a non-inner query so a freshly-created brand without any admin yet
    // still surfaces (admin count is then 0).
    let fb = supabase
      .from('brands')
      .select('id, name, created_at, deleted_at, stores(count), profiles(count), catalog_ingredients(count)')
      .order('name', { ascending: true });
    if (!opts?.includeSoftDeleted) {
      fb = fb.is('deleted_at', null);
    }
    const fallback = await fb;
    if (fallback.error) throw fallback.error;
    return mapBrandStats(fallback.data || []);
  }
  return mapBrandStats(data || []);
}

function mapBrandStats(rows: any[]): Array<Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number }> {
  return rows.map((b: any) => {
    // PostgREST embed `relation(count)` returns either an array with one
    // `{ count: N }` object or the same shape — coerce defensively.
    const storesEmbed = Array.isArray(b.stores) ? b.stores : [b.stores];
    const profilesEmbed = Array.isArray(b.profiles) ? b.profiles : [b.profiles];
    const catalogEmbed = Array.isArray(b.catalog_ingredients) ? b.catalog_ingredients : [b.catalog_ingredients];
    return {
      id: b.id,
      name: b.name,
      createdAt: b.created_at ?? null,
      deletedAt: b.deleted_at ?? null,
      storeCount: storesEmbed?.[0]?.count ?? 0,
      memberCount: profilesEmbed?.[0]?.count ?? 0,
      catalogIngredientCount: catalogEmbed?.[0]?.count ?? 0,
    };
  });
}

/**
 * Spec 012b §5 — INSERT a new brand. RLS gates this to super-admin via
 * the `super_admin_manage_brands` policy from 012a; non-super-admin
 * INSERT will return a Postgres error which the optimistic-revert path
 * surfaces via notifyBackendError. Throws on duplicate name (UNIQUE
 * constraint on brands.name from init_schema).
 */
export async function createBrand(name: string): Promise<Brand> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Brand name is required');
  const { data, error } = await supabase
    .from('brands')
    .insert({ name: trimmed })
    .select('id, name, deleted_at, created_at')
    .single();
  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    deletedAt: data.deleted_at ?? null,
    createdAt: data.created_at ?? null,
  };
}

// ─── BRAND LIFECYCLE (Spec 012c) ────────────────────────────────────
//
// Five SECURITY DEFINER RPCs gated by auth_is_super_admin() server-side.
// All raise PostgREST errors on rejection; callers (useStore actions)
// surface via notifyBackendError. Local helpers wrap the RPC contracts
// from spec 012c §2.

export interface BrandCascadePreview {
  brandId: string;
  brandName: string;
  deletedAt: string | null;
  blockingProfiles: Array<{
    profileId: string;
    name: string;
    email: string | null;
    role: 'super_admin' | 'admin' | 'master' | 'user';
    status: 'active' | 'pending';
  }>;
  blockingProfileCounts: { admins: number; users: number; superAdmins: number };
  /** Per-table row counts (table_name → count). Keys come from the
   *  RPC payload's `counts` object. */
  counts: Record<string, number>;
}

export interface BrandDeletionLogEntry {
  id: string;
  brandId: string;
  brandName: string;
  event: 'soft_deleted' | 'restored' | 'hard_deleted';
  actorUserId: string | null;
  actorEmail: string | null;
  cascadePayload: BrandCascadePreview | null;
  createdAt: string;
}

function mapCascadePreview(p: any): BrandCascadePreview {
  // RPC returns jsonb; supabase deserializes to a plain object.
  // Cleanup C2 — local renamed from `counts` to `profileCounts` so it
  // doesn't collide semantically with `p?.counts` (the per-table row
  // counts read separately at the bottom). Future maintenance had a
  // trap where a developer might copy this line for the per-table
  // counts and get the wrong source.
  const profiles = Array.isArray(p?.blocking_profiles) ? p.blocking_profiles : [];
  const profileCounts = (p?.blocking_profile_counts ?? {}) as Record<string, number>;
  return {
    brandId: p?.brand_id ?? '',
    brandName: p?.brand_name ?? '',
    deletedAt: p?.deleted_at ?? null,
    blockingProfiles: profiles.map((bp: any) => ({
      profileId: bp.profile_id,
      name: bp.name ?? '',
      email: bp.email ?? null,
      role: bp.role,
      status: bp.status,
    })),
    blockingProfileCounts: {
      admins: Number(profileCounts.admins ?? 0),
      users: Number(profileCounts.users ?? 0),
      superAdmins: Number(profileCounts.super_admins ?? 0),
    },
    counts: (p?.counts ?? {}) as Record<string, number>,
  };
}

/** Spec 012c §2.1 — rename a brand. Wraps `rename_brand(uuid, text)`.
 *  Trims client-side; server also trims and rejects empty. UNIQUE
 *  collision surfaces as Postgres 23505 → notifyBackendError. */
export async function renameBrand(brandId: string, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Brand name cannot be empty');
  const { error } = await supabase.rpc('rename_brand', {
    p_brand_id: brandId,
    p_new_name: trimmed,
  });
  if (error) throw error;
}

/** Spec 012c §2.2 — soft-delete a brand. Returns the assigned
 *  `deleted_at` ISO string. Idempotent: re-calling on an already
 *  soft-deleted brand returns the prior timestamp without writing
 *  a new audit row. */
export async function softDeleteBrand(brandId: string): Promise<string> {
  const { data, error } = await supabase.rpc('soft_delete_brand', {
    p_brand_id: brandId,
  });
  if (error) throw error;
  return data as string;
}

/** Spec 012c §2.3 — restore a soft-deleted brand. Server-side blocks
 *  the call past the 30-day grace window with a clear EXCEPTION
 *  message that the UI surfaces via notifyBackendError. */
export async function restoreBrand(brandId: string): Promise<void> {
  const { error } = await supabase.rpc('restore_brand', { p_brand_id: brandId });
  if (error) throw error;
}

/** Spec 012c §2.4 — preview the cascade. Returns per-table row counts
 *  AND the blocking-profiles array (Q-USER-A hard-blocker). The
 *  CascadePreviewModal renders the red error block when
 *  `blockingProfiles.length > 0`. */
export async function previewBrandCascade(brandId: string): Promise<BrandCascadePreview> {
  const { data, error } = await supabase.rpc('preview_brand_cascade', {
    p_brand_id: brandId,
  });
  if (error) throw error;
  return mapCascadePreview(data);
}

/** Spec 012c §2.5 — irreversible cascade. Server-side enforces both
 *  pre-flights (must be soft-deleted; must have zero attached
 *  profiles). Returns the at-execution cascade snapshot for the
 *  caller's success toast. */
export async function hardDeleteBrand(brandId: string): Promise<BrandCascadePreview> {
  const { data, error } = await supabase.rpc('hard_delete_brand', {
    p_brand_id: brandId,
  });
  if (error) throw error;
  return mapCascadePreview(data);
}

/** Spec 012c §5 — read the brand_deletion_log audit table. Super-admin
 *  only via RLS. Optional brandId filter for the per-brand history;
 *  default returns the global tail (most recent first). */
export async function fetchBrandDeletionLog(
  opts?: { brandId?: string; limit?: number },
): Promise<BrandDeletionLogEntry[]> {
  let q = supabase
    .from('brand_deletion_log')
    .select('id, brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload, created_at')
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 100);
  if (opts?.brandId) q = q.eq('brand_id', opts.brandId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((r: any) => ({
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    event: r.event,
    actorUserId: r.actor_user_id ?? null,
    actorEmail: r.actor_email ?? null,
    cascadePayload: r.cascade_payload ? mapCascadePreview(r.cascade_payload) : null,
    createdAt: r.created_at,
  }));
}

/** Spec 012c §5 (Q-ARCH-1) — demote an admin/master profile to user
 *  AND clear `brand_id`. Both columns must change in a single UPDATE
 *  so (a) `profiles_role_brand_consistent` CHECK passes (role='user'
 *  allows any brand_id) and (b) the H5 pre-flight in `hard_delete_brand`
 *  stops counting this row toward the blocking total.
 *
 *  Direct PostgREST UPDATE per spec §5 architect default. RLS on
 *  profiles must permit super-admin to UPDATE. If RLS rejects, this
 *  raises an error which surfaces via notifyBackendError; backend-
 *  developer is on the hook to wrap as a SECURITY DEFINER RPC if so. */
export async function demoteProfileToUser(profileId: string): Promise<string> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ role: 'user', brand_id: null })
    .eq('id', profileId)
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Spec 012b §5 — admins for a specific brand for the BrandsSection
 * members tab. Returns User[] shape with status='active' for joined
 * profiles + status='pending' synthetic rows for outstanding invitations
 * (so the UI can show "Bobby invited yesterday, not yet registered").
 *
 * RLS — super-admin sees all profiles via `super_admin_read_all_profiles`
 * from 012a. The invitations read uses 012a's existing admin policy
 * (super-admin satisfies the admin-or-master JWT claim on local; in
 * prod, the `role` JWT claim is set when super-admin promoted).
 */
export async function fetchBrandAdmins(brandId: string): Promise<User[]> {
  if (!brandId) return [];

  const [profilesRes, invitesRes, storesRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: true }),
    supabase
      .from('invitations')
      .select('id, email, name, role, store_ids, brand_id, used, expires_at, profile_id')
      .eq('brand_id', brandId)
      .eq('used', false),
    supabase
      .from('stores')
      .select('id')
      .eq('brand_id', brandId),
  ]);

  if (profilesRes.error) throw profilesRes.error;
  const profiles = profilesRes.data || [];
  const invites = invitesRes.data || [];
  const brandStoreIds = new Set((storesRes.data || []).map((s: any) => s.id));

  // user_stores join for store counts on the active profiles.
  const userIds = profiles.map((p: any) => p.id);
  let storeLinks: any[] = [];
  if (userIds.length > 0) {
    const { data: links } = await supabase
      .from('user_stores')
      .select('user_id, store_id')
      .in('user_id', userIds);
    storeLinks = links || [];
  }

  // Cleanup #4 + #15 — profiles has no email column; we pull email from
  // the invitation row that registered this profile. Prefer profile_id
  // (set by consume_invitation when the user accepted the invite) and
  // fall back to name match for legacy invitations whose profile_id is
  // still the placeholder. profile_id wins because two admins sharing a
  // display name would otherwise get swapped emails.
  const inviteByProfileId = new Map<string, any>();
  const inviteByName = new Map<string, any>();
  for (const inv of invites) {
    if (inv.profile_id && inv.profile_id !== '00000000-0000-0000-0000-000000000000') {
      inviteByProfileId.set(inv.profile_id, inv);
    }
    if (inv.name) inviteByName.set(inv.name, inv);
  }

  const activeRows: User[] = profiles.map((p: any) => {
    const stores = storeLinks
      .filter((sl: any) => sl.user_id === p.id)
      .map((sl: any) => sl.store_id)
      .filter((sid: string) => brandStoreIds.has(sid));
    const fallback = inviteByProfileId.get(p.id) ?? inviteByName.get(p.name);
    return {
      id: p.id,
      name: p.role === 'master' ? 'MASTER' : p.name,
      nickname: p.nickname || '',
      email: fallback?.email || '',
      role: p.role,
      stores,
      status: p.status,
      initials: p.role === 'master' ? 'M' : (p.initials || p.name.slice(0, 2).toUpperCase()),
      color: p.color || '#378ADD',
      notificationsEnabled: p.notifications_enabled !== false,
      brandId: p.brand_id ?? null,
    } as User;
  });

  // Outstanding invitations: synthetic User rows with status='pending'.
  // Skip ones already represented in profiles (matched by email).
  const activeEmails = new Set(activeRows.map((u) => u.email.toLowerCase()).filter(Boolean));
  const pendingRows: User[] = invites
    .filter((inv: any) => !activeEmails.has(inv.email.toLowerCase()))
    .map((inv: any) => ({
      id: `invitation:${inv.id}`,
      name: inv.name,
      nickname: '',
      email: inv.email,
      role: inv.role,
      stores: (inv.store_ids || []).filter((sid: string) => brandStoreIds.has(sid)),
      status: 'pending' as const,
      initials: inv.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      color: '#378ADD',
      notificationsEnabled: true,
      brandId: inv.brand_id ?? null,
    }));

  return [...activeRows, ...pendingRows];
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
    // Spec 010 §2: nullable int. Older DBs without the column return
    // undefined → coerce to null so the typed shape matches.
    defaultShelfLifeDays:
      c.default_shelf_life_days == null ? null : Number(c.default_shelf_life_days),
  }));
}

/**
 * Spec 010 §2: brand-level catalog ingredient writer. Today only carries
 * `defaultShelfLifeDays`; widen the patch type as more catalog-only
 * fields move under this helper. Catalog-only fields that already
 * round-trip through `updateInventoryItem` (name/unit/category/case_qty/
 * sub_unit_*) stay there for back-compat — see db.ts:122. RLS is
 * brand-scoped via existing catalog_ingredients policies (spec 005 P5).
 */
export async function updateCatalogIngredient(
  catalogId: string,
  patch: { defaultShelfLifeDays?: number | null },
): Promise<void> {
  if (!catalogId || catalogId.length < 10) return;
  const row: Record<string, unknown> = {};
  if (patch.defaultShelfLifeDays !== undefined) {
    row.default_shelf_life_days = patch.defaultShelfLifeDays;
  }
  if (Object.keys(row).length === 0) return;
  row.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('catalog_ingredients')
    .update(row)
    .eq('id', catalogId);
  if (error) throw error;
}

/**
 * Spec 010 §2 / §5: pure helper used by the Receiving auto-stamp branch.
 * Returns 'YYYY-MM-DD' for receivedAt + shelfLife days, or null when
 * shelfLife is not set. Works whether the input is a 'YYYY-MM-DD' or a
 * full ISO timestamp — slices to the date component before parsing so
 * the result lines up with `inventory_items.expiry_date` (which is a
 * `date`, not `timestamptz`).
 */
export function computeExpiryFromShelfLife(
  receivedAtISO: string,
  defaultShelfLifeDays: number | null | undefined,
): string | null {
  if (defaultShelfLifeDays == null) return null;
  const days = Number(defaultShelfLifeDays);
  if (!Number.isFinite(days) || days < 0) return null;
  const dateOnly = (receivedAtISO || '').slice(0, 10);
  const base = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + Math.floor(days));
  return base.toISOString().slice(0, 10);
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

// Spec 007 §3a — per-cell add. Idempotent against the
// order_schedule_store_day_vendor_unique constraint added in
// 20260507214842_spec007_order_schedule_unique.sql: a duplicate insert
// returns PG error code 23505 (unique_violation) which we swallow as a
// no-op. The OrderScheduleSection grid and the EOD inline `+ vendor`
// button both call this helper.
//
// `day` MUST be a TitleCase weekday string ("Monday".."Sunday") —
// matches the existing fetchOrderSchedule key contract and the
// useStore.orderSchedule slice baseline at useStore.ts:182.
export async function addOrderScheduleEntry(
  storeId: string,
  day: string,
  vendor: { vendorId: string; vendorName: string; deliveryDay?: string },
): Promise<void> {
  const { error } = await supabase
    .from('order_schedule')
    .insert({
      store_id: storeId,
      day_of_week: day,
      vendor_id: vendor.vendorId,
      vendor_name: vendor.vendorName,
      // delivery_day is NOT NULL on the table (per the prod-pulled schema
      // in 20260502071736_remote_schema.sql); fall back to the day itself
      // if the caller didn't provide one. saveOrderSchedule's existing
      // contract assumes the caller always supplies a value, but the
      // architect's helper signature lists deliveryDay as optional, so
      // the fallback keeps both contracts honest.
      delivery_day: vendor.deliveryDay ?? day,
    });
  // 23505 = unique_violation = the (store, day, vendor) cell is already
  // scheduled. Treat as idempotent no-op so double-clicks and stale
  // optimistic state don't surface as backend errors.
  if (error && (error as any).code !== '23505') throw error;
}

// Spec 007 §3b — per-cell remove. Idempotent: deleting a non-existent
// (store, day, vendor) row returns no error and zero affected rows.
export async function removeOrderScheduleEntry(
  storeId: string,
  day: string,
  vendorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('order_schedule')
    .delete()
    .eq('store_id', storeId)
    .eq('day_of_week', day)
    .eq('vendor_id', vendorId);
  if (error) throw error;
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
