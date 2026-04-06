// src/lib/db.ts
// All database operations — drop-in replacements for the Zustand seed data
import { supabase } from './supabase';
import {
  InventoryItem, Recipe, WasteEntry, EODSubmission,
  Vendor, AuditEvent, Store,
} from '../types';

// ─── STORES ──────────────────────────────────────────────────────────────
export async function fetchStores(): Promise<Store[]> {
  const { data, error } = await supabase.from('stores').select('*').eq('status', 'active');
  if (error) throw error;
  return (data || []).map((s: any) => ({
    id: s.id, name: s.name, address: s.address, status: s.status,
  }));
}

// ─── INVENTORY ────────────────────────────────────────────────────────────
export async function fetchInventory(storeId: string): Promise<InventoryItem[]> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`*, vendor:vendors(name), updater:profiles!last_updated_by(name)`)
    .eq('store_id', storeId)
    .order('category', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapItem);
}

export async function createInventoryItem(item: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      store_id: item.storeId,
      name: item.name,
      category: item.category,
      unit: item.unit,
      cost_per_unit: item.costPerUnit,
      current_stock: item.currentStock,
      par_level: item.parLevel,
      average_daily_usage: item.averageDailyUsage,
      safety_stock: item.safetyStock,
      vendor_id: item.vendorId || null,
      usage_per_portion: item.usagePerPortion,
      expiry_date: item.expiryDate || null,
      last_updated_by: null,
      eod_remaining: item.currentStock,
    })
    .select()
    .single();
  if (error) throw error;
  return mapItem(data);
}

export async function updateInventoryItem(id: string, updates: Partial<InventoryItem>): Promise<void> {
  const { error } = await supabase
    .from('inventory_items')
    .update({
      name: updates.name,
      category: updates.category,
      unit: updates.unit,
      cost_per_unit: updates.costPerUnit,
      current_stock: updates.currentStock,
      par_level: updates.parLevel,
      vendor_id: updates.vendorId,
      usage_per_portion: updates.usagePerPortion,
      expiry_date: updates.expiryDate || null,
    })
    .eq('id', id);
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
export async function fetchRecipes(storeId: string): Promise<Recipe[]> {
  const { data, error } = await supabase
    .from('recipes')
    .select(`*, recipe_ingredients(*, item:inventory_items(name, unit))`)
    .eq('store_id', storeId);
  if (error) throw error;
  return (data || []).map((r: any) => ({
    id: r.id,
    menuItem: r.menu_item,
    category: r.category,
    sellPrice: r.sell_price,
    storeId: r.store_id,
    ingredients: (r.recipe_ingredients || []).map((ing: any) => ({
      itemId: ing.item_id,
      itemName: ing.item?.name || '',
      quantity: ing.quantity,
      unit: ing.unit || ing.item?.unit || '',
    })),
    prepItems: [],
  }));
}

export async function createRecipe(recipe: Omit<Recipe, 'id'>): Promise<Recipe> {
  const { data, error } = await supabase
    .from('recipes')
    .insert({ store_id: recipe.storeId, menu_item: recipe.menuItem, category: recipe.category, sell_price: recipe.sellPrice })
    .select()
    .single();
  if (error) throw error;

  if (recipe.ingredients.length > 0) {
    await supabase.from('recipe_ingredients').insert(
      recipe.ingredients.map((ing) => ({
        recipe_id: data.id, item_id: ing.itemId, quantity: ing.quantity, unit: ing.unit,
      }))
    );
  }
  return { ...recipe, id: data.id };
}

// ─── WASTE LOG ───────────────────────────────────────────────────────────
export async function fetchWasteLog(storeId: string): Promise<WasteEntry[]> {
  const { data, error } = await supabase
    .from('waste_log')
    .select(`*, logger:profiles!logged_by(name), item:inventory_items(name, unit)`)
    .eq('store_id', storeId)
    .order('logged_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((w: any) => ({
    id: w.id,
    itemId: w.item_id,
    itemName: w.item?.name || '',
    quantity: w.quantity,
    unit: w.item?.unit || w.unit || '',
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
export async function submitEODCount(submission: Omit<EODSubmission, 'id'>): Promise<string> {
  const { data, error } = await supabase
    .from('eod_submissions')
    .insert({
      store_id: submission.storeId,
      date: new Date(submission.date).toISOString().split('T')[0],
      submitted_by: submission.submittedByUserId,
      status: 'submitted',
    })
    .select()
    .single();
  if (error) throw error;

  if (submission.entries.length > 0) {
    await supabase.from('eod_entries').insert(
      submission.entries.map((e) => ({
        submission_id: data.id,
        item_id: e.itemId,
        actual_remaining: e.actualRemaining,
        notes: e.notes || '',
      }))
    );

    // Update eod_remaining on each item
    for (const entry of submission.entries) {
      await supabase
        .from('inventory_items')
        .update({ eod_remaining: entry.actualRemaining, last_updated_by: submission.submittedByUserId })
        .eq('id', entry.itemId);
    }
  }

  return data.id;
}

export async function fetchEODSubmissions(storeId: string, date?: string): Promise<any[]> {
  let query = supabase
    .from('eod_submissions')
    .select(`*, submitter:profiles!submitted_by(name), eod_entries(*, item:inventory_items(name, unit))`)
    .eq('store_id', storeId)
    .order('submitted_at', { ascending: false });

  if (date) {
    query = query.eq('date', date);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── VENDORS ─────────────────────────────────────────────────────────────
export async function fetchVendors(): Promise<Vendor[]> {
  const { data, error } = await supabase.from('vendors').select('*').order('name');
  if (error) throw error;
  return (data || []).map((v: any) => ({
    id: v.id, name: v.name, contactName: v.contact_name, phone: v.phone,
    email: v.email, accountNumber: v.account_number, leadTimeDays: v.lead_time_days,
    deliveryDays: v.delivery_days || [], categories: v.categories || [], lastOrderDate: v.last_order_date,
  }));
}

export async function createVendor(vendor: Omit<Vendor, 'id'>): Promise<void> {
  const { error } = await supabase.from('vendors').insert({
    name: vendor.name, contact_name: vendor.contactName, phone: vendor.phone,
    email: vendor.email, account_number: vendor.accountNumber,
    lead_time_days: vendor.leadTimeDays, delivery_days: vendor.deliveryDays, categories: vendor.categories,
  });
  if (error) throw error;
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
  items: { menuItem: string; qtySold: number; revenue: number; recipeId?: string; recipeMapped: boolean }[]
): Promise<void> {
  const { data, error } = await supabase
    .from('pos_imports')
    .insert({
      store_id: storeId, filename,
      imported_by: importedById,
      import_date: new Date().toISOString().split('T')[0],
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

// ─── HELPERS ─────────────────────────────────────────────────────────────
function mapItem(row: any): InventoryItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category || '',
    unit: row.unit || '',
    costPerUnit: row.cost_per_unit || 0,
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
  };
}
