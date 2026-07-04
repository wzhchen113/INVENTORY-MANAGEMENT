// src/lib/db.ts
// All database operations — drop-in replacements for the Zustand seed data
//
// ─── Spec 055 discipline note ─────────────────────────────────────────
// Every supabase-touching export in this file routes through
// `useInflight.getState().track(async (signal) => { ... }, { kind, label })`
// so the global loading indicator and 30s hard-abort apply uniformly. Two
// rules when adding a new function:
//
//   1. Always chain `.abortSignal(signal)` on the PostgrestBuilder BEFORE
//      `await`. The abort happens at the builder layer — if the chain is
//      missed, the call still works but is un-cancellable (the 30s timer
//      will leave the fetch running silently). `.abortSignal()` must come
//      BEFORE `.single()` / `.maybeSingle()` — `.single()` returns the
//      terminal PostgrestBuilder which no longer exposes `.abortSignal()`.
//
//   2. Declare `kind: 'read' | 'write'` per call site. The classification
//      drives the abort-timeout toast copy. Rule of thumb:
//        - Only `.select(...)` / read-only RPC  → 'read'
//        - Any `.insert / .update / .delete / .upsert` or mutating RPC
//          (e.g. demote_profile_to_user)        → 'write'
//        - Mixed read-then-write in one body    → 'write' (safer copy)
//
// See [src/lib/inflight.ts] and specs/055-global-loading-indicator.md.
// ──────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';
import { useInflight } from './inflight';
// Spec 040 P3 — `callEdgeFunction` is the project-standard wrapper that
// surfaces edge-function failures as `{ data, error }` (CLAUDE.md "Edge
// function calls go through callEdgeFunction"). Used by translateOnSave
// below. Was file-private to auth.ts before spec 040; the export
// boundary was added in the same change.
import { callEdgeFunction } from './auth';
// Spec 103 — the four stable count-screen keys. Pure module (no supabase / no
// React), shared with the staff-subtree carve-out helper; see ./countOrder.
import type { CountOrderScreen } from './countOrder';
// Spec 104 — `piecesPerCase` (caseQty × subUnitSize, each factor || 1) is the
// single-source divisor for the per-EACH cost basis. The mapItem no-stored-cost
// fallback below divides case_price by it so the fallback matches calcUnitCost
// and the spec-104 migration. Pure util (no supabase), allowed in db.ts.
import { piecesPerCase } from '../utils/perEachCost';
import {
  InventoryItem, Recipe, WasteEntry, EODSubmission,
  Vendor, AuditEvent, Store, IngredientConversion,
  SidebarLayoutOverride, POSImport, Brand, User,
  InventoryCount, InventoryCountKind, InventoryCountSummary,
  ReorderPayload, ReorderVendor, ReorderItem, OnHandSource,
  CountedReorderItem,
  MenuCapacityRow, OrderSchedule, OrderSubmission,
  WeeklyCountStatus, WeeklyCountStatusValue,
} from '../types';

// ─── STORES ──────────────────────────────────────────────────────────────
export async function fetchStores(): Promise<Store[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .eq('status', 'active')
      .abortSignal(signal);
    if (error) throw error;
    return (data || []).map((s: any) => ({
      id: s.id,
      brandId: s.brand_id || '',
      name: s.name, address: s.address, status: s.status,
      eodDeadlineTime: s.eod_deadline_time || undefined,
      weeklyCountDueDow: s.weekly_count_due_dow ?? null,
    }));
  }, { kind: 'read', label: 'fetchStores' });
}

// Spec 083 — include-inactive read for the admin Stores tab ONLY.
// Identical projection/mapping to fetchStores, MINUS the .eq('status','active').
// Does NOT write the global `stores` cache — the caller (StoresTab) holds the
// result in component-local state. RLS (`store_member_read_stores`) still scopes
// rows to the caller's brand. Do NOT route this through the slice that writes
// `s.stores`; current-store resolution and the staff picker depend on that cache
// staying active-only.
export async function fetchStoresIncludingInactive(): Promise<Store[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .abortSignal(signal);
    if (error) throw error;
    return (data || []).map((s: any) => ({
      id: s.id,
      brandId: s.brand_id || '',
      name: s.name, address: s.address, status: s.status,
      eodDeadlineTime: s.eod_deadline_time || undefined,
      weeklyCountDueDow: s.weekly_count_due_dow ?? null,
    }));
  }, { kind: 'read', label: 'fetchStoresIncludingInactive' });
}

// Spec 083 — partial store-field write (status toggle + name/address/deadline).
// PostgREST UPDATE; the `privileged_update_stores` RLS policy
// (auth_is_privileged() AND auth_can_see_brand(brand_id)) enforces the
// admin/master/super_admin gate, so no RPC is needed. brandId is intentionally
// NOT writable here — a brand transfer would trip auth_can_see_brand WITH CHECK
// and needs its own privileged path. Only maps keys present on `updates` so we
// never clobber existing values with undefined.
export async function updateStore(
  id: string,
  updates: Partial<Pick<Store, 'name' | 'address' | 'eodDeadlineTime' | 'status' | 'weeklyCountDueDow'>>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const dbUpdates: Record<string, any> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.address !== undefined) dbUpdates.address = updates.address;
    if (updates.eodDeadlineTime !== undefined) dbUpdates.eod_deadline_time = updates.eodDeadlineTime;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    // Spec 098 — per-store weekly cadence. Pass null through to clear a
    // cadence (sets the store to "weekly count not scheduled"). The
    // privileged_update_stores RLS policy gates this write; no new policy.
    if (updates.weeklyCountDueDow !== undefined) dbUpdates.weekly_count_due_dow = updates.weeklyCountDueDow;
    // No mappable fields → skip the round-trip. An empty-body PATCH is a no-op
    // that still costs a request and can behave inconsistently across PostgREST
    // versions; matches the guard in updateRecipe/updatePrepRecipe.
    if (Object.keys(dbUpdates).length === 0) return;
    const { error } = await supabase
      .from('stores')
      .update(dbUpdates)
      .eq('id', id)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateStore' });
}

export async function createStore(store: Omit<Store, 'id'>): Promise<string> {
  // brand_id is load-bearing post-Spec-012a — the stores INSERT policy
  // requires auth_can_see_brand(brand_id), and NULL fails that check for
  // any non-super-admin. Caller (addStore in useStore) must resolve
  // brandId via the same chain other actions use:
  //   recipe.brandId || get().brand?.id || get().currentStore.brandId
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('stores')
      .insert({
        name: store.name,
        address: store.address,
        status: store.status || 'active',
        brand_id: store.brandId || null,
      })
      .select()
      .abortSignal(signal)
      .single();
    if (error) throw error;
    return data.id;
  }, { kind: 'write', label: 'createStore' });
}

export async function deleteStore(id: string): Promise<void> {
  // Delete all related data first
  return useInflight.getState().track(async (signal) => {
    await supabase.from('inventory_items').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('recipes').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('eod_submissions').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('waste_log').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('audit_log').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('user_stores').delete().eq('store_id', id).abortSignal(signal);
    await supabase.from('stores').delete().eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'deleteStore' });
}

/**
 * Spec 012b cleanup #1 — extracted from auth.ts so PostgREST traffic stays
 * in db.ts per CLAUDE.md. Returns the set of store ids belonging to a brand,
 * used by fetchAllUsers to clip cross-brand grants out of the per-user store
 * list.
 */
export async function fetchStoreIdsForBrand(brandId: string): Promise<Set<string>> {
  return useInflight.getState().track(async (signal) => {
    const { data } = await supabase
      .from('stores')
      .select('id')
      .eq('brand_id', brandId)
      .abortSignal(signal);
    return new Set((data || []).map((s: any) => s.id));
  }, { kind: 'read', label: 'fetchStoreIdsForBrand' });
}

/**
 * Spec 012b cleanup #1 — extracted from auth.ts. Pulls (email, profile_id,
 * name, brand_id) for invitation rows used to infer email for active
 * profiles.
 *
 * Spec 083 — the brand filter is DELIBERATELY NOT applied. This query exists
 * only for *email inference*: fetchAllUsers (src/lib/auth.ts) indexes the
 * returned rows by profile_id (winning) then name, and that per-user match —
 * not a brand filter — is what scopes each invitation to the correct person.
 * The old `.eq('brand_id', brandId)` was a table-read narrowing (cleanup #16)
 * that HID NULL-brand invitations from inference: Bobby's and Charles's
 * invitations carry brand_id = NULL while their profiles carry a real brand,
 * so any brand-scoped Users view dropped their invitation and rendered
 * "(email not loaded)" (the spec-083 bug). Reading the whole invitations table
 * is acceptable — it is a tiny, low-cardinality table, not a hot path — and
 * makes inference resilient to any future NULL-brand invitation. The brand
 * scope of WHICH users appear is unchanged: fetchAllUsers still filters the
 * profiles query by brand_id.
 *
 * The `brandId?` param is RETAINED for call-site compatibility (one caller —
 * fetchAllUsers at src/lib/auth.ts) but is currently UNUSED.
 */
export async function fetchInvitationsForUserLookup(
  brandId?: string,
): Promise<Array<{ email: string; profile_id: string | null; name: string; brand_id: string | null }>> {
  return useInflight.getState().track(async (signal) => {
    const { data } = await supabase
      .from('invitations')
      .select('email, profile_id, name, brand_id')
      .abortSignal(signal);
    return (data || []) as any[];
  }, { kind: 'read', label: 'fetchInvitationsForUserLookup' });
}

// ─── INVENTORY ────────────────────────────────────────────────────────────
// Spec 040 P3: return type widened to expose i18nNames on each row. See the
// mapItem comment below for the rationale on the structural intersection.
export async function fetchInventory(
  storeId?: string,
): Promise<Array<InventoryItem & { i18nNames: Record<string, string> }>> {
  // name/unit/category/case_qty/sub_unit_* are hydrated from
  // catalog_ingredients via the JOIN aliased as `catalog`. The category
  // column is gone from inventory_items so we can no longer order by
  // it server-side; UI consumers sort client-side anyway. Spec 040 also
  // selects catalog.i18n_names so mapItem can hydrate per-locale name
  // overrides without a second fetch.
  return useInflight.getState().track(async (signal) => {
    // Spec 102 (§6a) — embed the item_vendors link set (per-vendor cost +
    // case price + the derived is_primary mirror) alongside the existing
    // scalar `vendor` (the primary pointer, SD-1) and `catalog` embeds.
    // mapItem hydrates `vendors[]` + the derived `vendorIds` from this.
    let query = supabase
      .from('inventory_items')
      .select(`*,
        vendor:vendors(name),
        item_vendors:item_vendors(vendor_id, cost_per_unit, case_price, is_primary,
                                  vendor:vendors(id, name)),
        updater:profiles!last_updated_by(name),
        catalog:catalog_ingredients(id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit, i18n_names)`)
      .order('id', { ascending: true });
    if (storeId) query = query.eq('store_id', storeId);
    const { data, error } = await query.abortSignal(signal);
    if (error) throw error;
    return (data || []).map(mapItem);
  }, { kind: 'read', label: 'fetchInventory' });
}

/**
 * Resolve the brand for a given store id — used by createInventoryItem
 * when the caller didn't pass a brandId explicitly. Internal helper; the
 * caller (createInventoryItem) is already wrapped in `track()` and threads
 * its `signal` down for cancellation continuity.
 */
async function brandIdForStore(storeId: string, signal?: AbortSignal): Promise<string> {
  // `.abortSignal()` lives on the transform builder and must precede
  // `.single()`, because `.single()` returns a terminal PostgrestBuilder
  // that no longer exposes `.abortSignal()`. Same rule for `.maybeSingle()`.
  let q = supabase.from('stores').select('brand_id').eq('id', storeId);
  if (signal) q = q.abortSignal(signal);
  const { data } = await q.single();
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
// Spec 040 P3: signature widened to accept an optional `i18nNames` on the
// Omit<InventoryItem,'id'> input. The intersection on the Omit lets a
// caller pass i18nNames without modifying src/types/index.ts (the frontend
// dev's lane in spec 040). The new field is threaded into the RPC's
// p_i18n_names parameter so the catalog row carries the translations on the
// first save — eliminating the silent-drop failure mode the architect
// flagged at §11.
export async function createInventoryItem(
  // Spec 102 frontend — `Omit<…, 'vendors'>` overrides InventoryItem's
  // `vendors?: ItemVendorLink[]` with the editor's link-PAYLOAD shape
  // (`{vendorId, costPerUnit?, casePrice?}` — no vendorName/isPrimary, which
  // this function derives). Without the Omit the intersection is
  // `ItemVendorLink[] & payload[]` (uninhabitable), so every caller passing a
  // bare payload fails to typecheck — the backend signature compiled only
  // because nothing called it with `vendors` until the frontend wired it.
  item: Omit<InventoryItem, 'id' | 'vendors'> & {
    i18nNames?: Record<string, string>;
    // Spec 102 (§8) — optional multi-vendor link set. When present, these
    // become item_vendors rows after the item lands; the link whose
    // vendorId matches the scalar `vendorId` is marked is_primary (SD-1).
    // When omitted, a single primary link is synthesized from the scalar
    // vendorId (back-compat with the single-vendor form).
    vendors?: Array<{ vendorId: string; costPerUnit?: number; casePrice?: number }>;
  },
): Promise<InventoryItem & { i18nNames: Record<string, string> }> {
  const vendorId = item.vendorId && item.vendorId.length > 10 ? item.vendorId : null;
  const storeId = item.storeId && item.storeId.length > 10 ? item.storeId : null;
  if (!storeId) throw new Error('Invalid store ID');

  return useInflight.getState().track(async (signal) => {
    const brandId = await brandIdForStore(storeId, signal);
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
      // Spec 040 P3: thread per-locale name overrides into the RPC. The
      // RPC writes catalog_ingredients.i18n_names atomically inside the
      // find-or-create transaction. Omitting this falls through to the
      // function's default `{}`::jsonb (back-compat — the RPC accepts the
      // shorter argument list).
      p_i18n_names: item.i18nNames ?? {},
    }).abortSignal(signal);
    if (error) throw error;
    // The RPC returns a jsonb shaped exactly like a PostgREST embed
    // response, so mapItem can consume it directly.
    const mapped = mapItem(data);

    // Spec 102 (§8) — write the item_vendors link rows for the new item.
    // The RPC's p_per_store.vendor_id already set the scalar (the primary
    // pointer); here we persist the full link set. When `vendors[]` was
    // omitted, synthesize a single primary link from the scalar vendorId so
    // a single-vendor save (the legacy form) still produces exactly one
    // link carrying the item's cost (AC-A/AC-C back-compat). The link whose
    // vendorId matches the scalar is is_primary=true (SD-1). The composite
    // unique (item_id, vendor_id) + onConflict make the upsert the
    // dup-guard backstop. Mirrors the snake_case wire shape.
    const links = (item.vendors && item.vendors.length > 0)
      ? item.vendors
      : (vendorId
          ? [{ vendorId, costPerUnit: item.costPerUnit ?? 0, casePrice: item.casePrice ?? 0 }]
          : []);
    if (links.length > 0 && data?.id) {
      const linkUpsert = await supabase.from('item_vendors').upsert(
        links.map((l) => ({
          item_id: data.id,
          vendor_id: l.vendorId,
          cost_per_unit: l.costPerUnit ?? 0,
          case_price: l.casePrice ?? 0,
          is_primary: l.vendorId === vendorId,
        })),
        { onConflict: 'item_id,vendor_id' },
      ).abortSignal(signal);
      if (linkUpsert.error) throw linkUpsert.error;
    }
    return mapped;
  }, { kind: 'write', label: 'createInventoryItem' });
}

// Spec 040 P3: signature widened to accept `i18nNames` in the partial
// update. When present, it lands on catalog_ingredients.i18n_names alongside
// the other catalog-level fields. Brand-wide change — every store sees the
// new translations on the next render. Optimistic-then-revert in the store
// reverts the slice on error per useStore.ts:23 / notifyBackendError.
export async function updateInventoryItem(
  id: string,
  // Spec 102 frontend — `Omit<…, 'vendors'>` overrides the InventoryItem
  // `vendors?: ItemVendorLink[]` field with the editor's link-PAYLOAD shape;
  // see the createInventoryItem note above for why the plain intersection is
  // uninhabitable.
  updates: Omit<Partial<InventoryItem>, 'vendors'> & {
    i18nNames?: Record<string, string>;
    // Spec 102 (§8) — when present, RECONCILE the item's item_vendors link
    // set: upsert each submitted link, then delete links whose vendorId is
    // not in the submitted set ("removing a vendor removes its link;
    // editing a cost updates only that link" — AC-C). Omitting the key
    // leaves the link set untouched (a form that only touched the primary
    // picker / a non-vendor field). An empty array removes ALL links.
    vendors?: Array<{ vendorId: string; costPerUnit?: number; casePrice?: number }>;
  },
): Promise<void> {
  if (!id || id.length < 10) return;

  return useInflight.getState().track(async (signal) => {
    // Catalog-level fields (name/unit/category/case_qty/sub_unit_*/i18n_names)
    // propagate to ALL stores via catalog_ingredients. Per-store fields (cost,
    // vendor, par, stock) stay on inventory_items.
    const catalogUpdates: any = {};
    if (updates.name !== undefined) catalogUpdates.name = updates.name;
    if (updates.unit !== undefined) catalogUpdates.unit = updates.unit;
    if (updates.category !== undefined) catalogUpdates.category = updates.category;
    if (updates.caseQty !== undefined) catalogUpdates.case_qty = updates.caseQty;
    if (updates.subUnitSize !== undefined) catalogUpdates.sub_unit_size = updates.subUnitSize;
    if (updates.subUnitUnit !== undefined) catalogUpdates.sub_unit_unit = updates.subUnitUnit;
    // Spec 040 P3: per-locale name overrides for the catalog ingredient.
    // Passing `{}` clears all translations; omitting the field leaves the
    // existing JSONB untouched (matching the rest of this function's
    // omit-key-to-skip semantics).
    if (updates.i18nNames !== undefined) catalogUpdates.i18n_names = updates.i18nNames;
    if (Object.keys(catalogUpdates).length > 0) {
      catalogUpdates.updated_at = new Date().toISOString();
      // Resolve the catalog_id for this row before updating
      const { data: row } = await supabase
        .from('inventory_items')
        .select('catalog_id')
        .eq('id', id)
        .abortSignal(signal)
        .single();
      const catalogId = row?.catalog_id;
      if (catalogId) {
        await supabase
          .from('catalog_ingredients')
          .update(catalogUpdates)
          .eq('id', catalogId)
          .abortSignal(signal);
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
    // Persist the per-store scalar fields when any changed. (Skipping the
    // UPDATE when nothing changed avoids a no-op write — but we must NOT
    // early-return here, because a `vendors[]`-only edit reconciles links
    // below without touching any scalar field.)
    if (Object.keys(perStore).length > 0) {
      const { error } = await supabase
        .from('inventory_items')
        .update(perStore)
        .eq('id', id)
        .abortSignal(signal);
      if (error) throw error;
    }

    // Spec 102 (§8) — reconcile the item_vendors link set when the editor
    // submitted `vendors[]`. Upsert each present link (cost/case_price
    // edits land on exactly that link; is_primary tracks the scalar
    // vendorId — SD-1, one writer owns both), then delete links whose
    // vendorId is not in the submitted set ("removing a vendor removes its
    // link" — AC-C). An empty `vendors: []` removes ALL links for the item.
    // Omitting the key leaves links untouched (a primary-picker-only or
    // non-vendor edit). The composite unique + onConflict make a re-submit
    // idempotent (the dup-guard backstop).
    if (updates.vendors !== undefined) {
      const ids = updates.vendors.map((v) => v.vendorId);
      // SD-1 primary basis. `is_primary` mirrors the item's scalar vendor_id.
      // When this edit re-points the scalar (updates.vendorId present),
      // `vendorId` above is that new value. When the edit does NOT touch the
      // scalar (a cost-only or vendors-only edit), `vendorId` is null — and
      // marking is_primary = (v.vendorId === null) would set EVERY link
      // is_primary=false, wiping the SD-1 mirror. Fall back to the item's
      // EXISTING inventory_items.vendor_id so a vendors-only edit preserves
      // which link is primary (mirrors the optimistic store's same fallback).
      let primaryVendorId: string | null = vendorId;
      if (updates.vendorId === undefined && updates.vendors.length > 0) {
        const { data: cur } = await supabase
          .from('inventory_items')
          .select('vendor_id')
          .eq('id', id)
          .abortSignal(signal)
          .single();
        primaryVendorId = (cur?.vendor_id as string | null) ?? null;
      }
      if (updates.vendors.length > 0) {
        const linkUpsert = await supabase.from('item_vendors').upsert(
          updates.vendors.map((v) => ({
            item_id: id,
            vendor_id: v.vendorId,
            cost_per_unit: v.costPerUnit ?? 0,
            case_price: v.casePrice ?? 0,
            is_primary: v.vendorId === primaryVendorId,
          })),
          { onConflict: 'item_id,vendor_id' },
        ).abortSignal(signal);
        if (linkUpsert.error) throw linkUpsert.error;
      }
      // Remove de-selected links. With an empty submitted set, the `.in`
      // filter is omitted so ALL links for the item are deleted.
      let del = supabase.from('item_vendors').delete().eq('item_id', id);
      if (ids.length > 0) {
        del = del.not('vendor_id', 'in', `(${ids.join(',')})`);
      }
      const delRes = await del.abortSignal(signal);
      if (delRes.error) throw delRes.error;
    }
  }, { kind: 'write', label: 'updateInventoryItem' });
}

export async function adjustItemStock(id: string, newStock: number, updatedById: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('inventory_items')
      .update({ current_stock: newStock, last_updated_by: updatedById, updated_at: new Date().toISOString() })
      .eq('id', id)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'adjustItemStock' });
}

// ─── RECIPES ─────────────────────────────────────────────────────────────
/**
 * Recipes are brand-level after the catalog refactor. Fetched once per
 * brand and shown at every store. Ingredient names come from
 * catalog_ingredients (brand-shared).
 */
// Spec 040 P3: return type widened to surface i18nNames on each recipe row.
// The select still uses `*` so the new column comes through automatically.
export async function fetchRecipes(
  brandId: string,
): Promise<Array<Recipe & { i18nNames: Record<string, string> }>> {
  return useInflight.getState().track(async (signal) => {
  const { data, error } = await supabase
    .from('recipes')
    .select(`*,
      recipe_ingredients(*, catalog:catalog_ingredients(id, name, unit)),
      recipe_prep_items(*, prep:prep_recipes(name, yield_unit))`)
    .eq('brand_id', brandId)
    .abortSignal(signal);
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
    // Spec 040 P3: recipes canonical English is in `menu_item`; per-locale
    // overrides live in recipes.i18n_names. The `getLocalizedName` helper
    // resolves `menuItem` first, then `name`, then falls through to ''.
    i18nNames: (r.i18n_names ?? {}) as Record<string, string>,
  }));
  }, { kind: 'read', label: 'fetchRecipes' });
}

// Spec 040 P3: accepts optional `i18nNames` in the create payload. When the
// form's auto-translate fan-out completes before save, the suggestions are
// carried into the recipes.i18n_names JSONB on the first INSERT — no
// separate UPDATE round-trip. Same shape rationale as createInventoryItem.
export async function createRecipe(
  recipe: Omit<Recipe, 'id'> & { i18nNames?: Record<string, string> },
): Promise<Recipe & { i18nNames: Record<string, string> }> {
  const brandId = recipe.brandId || recipe.storeId;
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');
  return useInflight.getState().track(async (signal) => {
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
          // Spec 040 P3: persist per-locale overrides on the recipe row.
          // The upsert merges this when (brand_id, menu_item) collides;
          // PostgREST default merge replaces the JSONB field with the new
          // value. Callers that don't pass i18nNames send `{}` so the
          // column lands at its default and isn't accidentally cleared.
          i18n_names: recipe.i18nNames ?? {},
        },
        { onConflict: 'brand_id,menu_item' }
      )
      .select()
      .abortSignal(signal)
      .single();
    if (error) throw error;

    // Replace ingredients — recipe_ingredients carries catalog_id only
    // (the legacy item_id column was dropped in Phase 3).
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', data.id).abortSignal(signal);
    if (recipe.ingredients.length > 0) {
      await supabase.from('recipe_ingredients').insert(
        recipe.ingredients.map((ing) => ({
          recipe_id: data.id,
          catalog_id: ing.itemId,
          quantity: ing.quantity,
          unit: ing.unit,
        }))
      ).abortSignal(signal);
    }
    // Replace prep items
    await supabase.from('recipe_prep_items').delete().eq('recipe_id', data.id).abortSignal(signal);
    if (recipe.prepItems && recipe.prepItems.length > 0) {
      await supabase.from('recipe_prep_items').insert(
        recipe.prepItems.map((p) => ({
          recipe_id: data.id, prep_recipe_id: p.prepRecipeId, quantity: p.quantity, unit: p.unit,
        }))
      ).abortSignal(signal);
    }
    // Spec 040 P3: surface i18nNames on the returned row so the optimistic-
    // then-revert callsite can swap the temp row for the saved one without
    // losing the translations the user just typed. Falls back to `{}` when
    // the caller passed none and the upsert wrote the column default.
    return {
      ...recipe,
      id: data.id,
      brandId,
      storeId: brandId,
      i18nNames: (data.i18n_names ?? recipe.i18nNames ?? {}) as Record<string, string>,
    };
  }, { kind: 'write', label: 'createRecipe' });
}

// ─── WASTE LOG ───────────────────────────────────────────────────────────
export async function fetchWasteLog(storeId: string): Promise<WasteEntry[]> {
  // Item name/unit come from catalog_ingredients now (inventory_items
  // only has the catalog_id link). Two-hop JOIN: waste_log.item_id →
  // inventory_items → catalog_ingredients.
  return useInflight.getState().track(async (signal) => {
  const { data, error } = await supabase
    .from('waste_log')
    .select(`*,
      logger:profiles!logged_by(name),
      item:inventory_items(catalog:catalog_ingredients(name, unit))`)
    .eq('store_id', storeId)
    .order('logged_at', { ascending: false })
    .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchWasteLog' });
}

export async function logWasteEntry(entry: Omit<WasteEntry, 'id'>): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    // Spec 104 (R1 option a) — WRITE-SIDE waste snapshot bridge. After the
    // per-each basis flip, `entry.costPerUnit` (mapped from the live
    // inventory_items.cost_per_unit) is per-EACH. `waste_log.cost_per_unit`
    // must stay per-COUNTED-unit so the read side (DashboardSection.wasteWeek /
    // WasteLogSection totals) stays UNBRIDGED and historical + new waste
    // dollars both reconcile. Re-bridge per (★): cost_old = perEach ×
    // sub_unit_size. We read sub_unit_size from the item's catalog row here (a
    // single indexed read on a rare write) rather than trusting the caller, so
    // the snapshot is correct regardless of the caller's shape. The mirror
    // server-side fix lives in the staff staff_log_waste RPC (spec-104
    // migration). cost_old is an exact 2-dp value → fits numeric(10,2)
    // losslessly (no waste-column widening).
    const { data: itemRow, error: lookupError } = await supabase
      .from('inventory_items')
      .select('catalog:catalog_ingredients(sub_unit_size)')
      .eq('id', entry.itemId)
      .abortSignal(signal)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const cat = (itemRow as any)?.catalog;
    const subUnitSize = parseFloat(cat?.sub_unit_size) || 1;
    const { error } = await supabase.from('waste_log').insert({
      store_id: entry.storeId,
      item_id: entry.itemId,
      quantity: entry.quantity,
      unit: entry.unit,
      cost_per_unit: entry.costPerUnit * subUnitSize,
      reason: entry.reason,
      logged_by: entry.loggedByUserId,
      notes: entry.notes,
    }).abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'logWasteEntry' });
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
  return useInflight.getState().track(async (signal) => {
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
      .abortSignal(signal)
      .single();
    if (error) {
      console.warn('[Supabase] submitEODCount upsert parent:', error.message, error);
      throw error;
    }

    // Replace entries wholesale: drop the old set, then insert the new set.
    const del = await supabase
      .from('eod_entries')
      .delete()
      .eq('submission_id', data.id)
      .abortSignal(signal);
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
      ).abortSignal(signal);
      if (ins.error) {
        console.warn('[Supabase] submitEODCount insert entries:', ins.error.message, ins.error);
        throw ins.error;
      }

      // Spec 102 (§5a) — shared on-hand reconciliation. The on-hand is keyed
      // by ITEM, not (item, vendor): an item is countable under this vendor
      // iff it has an `item_vendors` link for the vendor, regardless of which
      // link is "primary". We prefetch the set of item_ids legitimately
      // covered by this vendor AT THIS STORE once, then gate the per-entry
      // write on membership in that set. This replaces the old
      // `.eq('vendor_id', submission.vendorId)` predicate so a SHARED item's
      // on-hand is not silently dropped when counted under a non-primary
      // vendor tab (AC-D / AC-F). An entry whose itemId is NOT in the set is
      // the escape-hatch case (an off-vendor entry) → no on-hand write,
      // matching the prior behavior and the staff RPC (§5b).
      //
      // Store-scoped: the embed inner-joins inventory_items and filters
      // `item.store_id = submission.storeId` (mirroring the staff fetch's
      // `fetchItemsForVendor`), so the set never spans wider than this
      // submission's store — important for a multi-store admin where the same
      // vendor links items in several accessible stores.
      //
      // The write now sets BOTH current_stock and eod_remaining (the staff
      // RPC and the admin store optimistic mirror already set both) — a
      // deliberate consistency fix (spec 102 §12) so the persisted admin
      // state matches what the optimistic UI already mirrored at
      // useStore.ts (currentStock).
      const linkRows = await supabase
        .from('item_vendors')
        .select('item_id, item:inventory_items!inner(store_id)')
        .eq('vendor_id', submission.vendorId)
        .eq('item.store_id', submission.storeId)
        .abortSignal(signal);
      if (linkRows.error) {
        // A failed prefetch would empty the membership set and silently skip
        // EVERY on-hand update for the whole submission — entries persist but
        // current_stock/eod_remaining go stale (reorder reads stale on-hand
        // until the next fetch). Unlike the per-item write below (a
        // nice-to-have for one item), a prefetch failure is batch-wide, so we
        // throw — consistent with the parent/entry writes above and the
        // store's optimistic-revert + toast path.
        console.warn('[Supabase] submitEODCount fetch item_vendors:', linkRows.error.message);
        throw linkRows.error;
      }
      const linkedItemIdsForVendor = new Set<string>(
        (linkRows.data ?? []).map((r: { item_id: string }) => r.item_id),
      );

      for (const entry of submission.entries) {
        // Escape-hatch: no link to the submitting vendor → skip the on-hand
        // write (the eod_entries row above still persisted). Mirrors the
        // staff RPC's EXISTS(item_vendors …) gate and the prior
        // vendor-equality skip.
        if (!linkedItemIdsForVendor.has(entry.itemId)) continue;
        const upd = await supabase
          .from('inventory_items')
          .update({
            eod_remaining: entry.actualRemaining,
            current_stock: entry.actualRemaining,
            last_updated_by: submission.submittedByUserId,
          })
          .eq('id', entry.itemId)
          .abortSignal(signal);
        if (upd.error) {
          console.warn('[Supabase] submitEODCount update item:', entry.itemId, upd.error.message);
          // Don't throw — parent + entries already landed, item-level on-hand
          // is a nice-to-have. Surface in console for debugging.
        }
      }
    }

    return data.id;
  }, { kind: 'write', label: 'submitEODCount' });
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
  return useInflight.getState().track(async (signal) => {
  const { data, error } = await supabase
    .from('eod_submissions')
    .select(`
      id, store_id, date, vendor_id, status, submitted_at, submitted_by,
      submitter:profiles!submitted_by(name),
      eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                  item:inventory_items(catalog:catalog_ingredients(name, unit)))
    `)
    .in('store_id', storeIds)
    .eq('date', dateISO)
    .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchTodaysEODForStores' });
}

export async function fetchRecentEODSubmissions(storeId: string, days = 14): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffISO = cutoff.toISOString().split('T')[0];

  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('eod_submissions')
      .select(`id, store_id, date, vendor_id, submitted_by, submitted_at, status,
               submitter:profiles!submitted_by(name),
               eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                           item:inventory_items(catalog:catalog_ingredients(name, unit)))`)
      .eq('store_id', storeId)
      .gte('date', cutoffISO)
      .order('submitted_at', { ascending: false })
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchRecentEODSubmissions' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('eod_submissions')
      .select(`id, store_id, date, vendor_id, submitted_by, submitted_at, status,
               submitter:profiles!submitted_by(name),
               eod_entries(id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, created_at,
                           item:inventory_items(catalog:catalog_ingredients(name, unit)))`)
      .in('store_id', storeIds)
      .gte('date', sinceDate)
      .order('submitted_at', { ascending: false })
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchEodSubmissionsForStores' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('eod_submissions')
      .select('date')
      .eq('store_id', storeId)
      .eq('status', 'submitted')
      .order('date', { ascending: false })
      .limit(fetchLimit)
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchRecentEodDates:', error.message);
      return [];
    }
    return [...new Set((data || []).map((r: any) => r.date as string))].slice(0, limit);
  }, { kind: 'read', label: 'fetchRecentEodDates' });
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
  return useInflight.getState().track(async (signal) => {
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
    }).abortSignal(signal);
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
  }, { kind: 'write', label: 'submitInventoryCount' });
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
  kind?: InventoryCountKind,           // spec 098 — optional kind filter (e.g. 'weekly')
): Promise<InventoryCountSummary[]> {
  return useInflight.getState().track(async (signal) => {
  let query = supabase
    .from('inventory_counts')
    .select(`
      id, store_id, kind, counted_at, submitted_by, submitted_at, status, notes,
      submitter:profiles!submitted_by(name),
      inventory_count_entries(count)
    `)
    .eq('store_id', storeId);
  // Cheaper than over-fetching and filtering client-side: scope the read to
  // a single kind when the caller asks (the weekly admin tab passes 'weekly').
  if (kind) query = query.eq('kind', kind);
  const { data, error } = await query
    .order('counted_at', { ascending: false })
    .limit(limit)
    .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchRecentInventoryCounts' });
}

// ─── WEEKLY COUNT STATUS (Spec 098) ─────────────────────────────────────
/**
 * Per-store weekly-count completed/overdue status for the admin tab.
 * Calls the `weekly_count_status` RPC with `p_store_id = null` so it
 * returns one row per visible active store (RLS clips the set —
 * `auth_can_see_store` short-circuits to admin visibility for admins).
 *
 * `asOfDate` MUST be the caller's local YYYY-MM-DD (todayIso convention) —
 * the RPC's week-window math anchors on it to avoid the UTC off-by-one.
 *
 * The staff banner uses a separate direct `supabase.rpc('weekly_count_status',
 * { p_store_id: activeStore.id, ... })` call from the staff carve-out (spec
 * 063) — it does NOT go through this admin helper.
 */
export async function fetchWeeklyCountStatus(asOfDate: string): Promise<WeeklyCountStatus[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('weekly_count_status', {
      p_store_id: null,
      p_as_of_date: asOfDate,
    }).abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchWeeklyCountStatus:', error.message);
      return [];
    }
    return (data || []).map((row: any) => ({
      storeId: row.store_id,
      dueDow: row.due_dow ?? null,
      windowStart: row.window_start ?? null,
      windowEnd: row.window_end ?? null,
      status: row.status as WeeklyCountStatusValue,
      lastCountId: row.last_count_id ?? null,
      lastCountedAt: row.last_counted_at ?? null,
    }));
  }, { kind: 'read', label: 'fetchWeeklyCountStatus' });
}

/**
 * Full detail for one inventory count (parent + entries with item names
 * hydrated via the catalog join). Returns null if the count doesn't
 * exist or RLS hides it from this caller.
 */
export async function fetchInventoryCount(
  countId: string,
): Promise<InventoryCount | null> {
  return useInflight.getState().track(async (signal) => {
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
      .abortSignal(signal)
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
  }, { kind: 'read', label: 'fetchInventoryCount' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('pos_imports')
      .select(`id, store_id, filename, imported_by, import_date, imported_at,
               importer:profiles!imported_by(name),
               pos_import_items(id, menu_item, qty_sold, revenue, recipe_id, recipe_mapped)`)
      .in('store_id', storeIds)
      .gte('import_date', sinceDate)
      .order('import_date', { ascending: false })
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchPosImportsForStores' });
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
  return useInflight.getState().track(async (signal) => {
    // Prefer vendor_id; fall back to name lookup if only a name is provided.
    let vendorId = params.vendorId;
    if (!vendorId && params.vendorName) {
      const { data: v } = await supabase
        .from('vendors')
        .select('id')
        .ilike('name', params.vendorName)
        .abortSignal(signal)
        .maybeSingle();
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
        // Spec 107 §1 — status vocabulary reconciled to
        // draft|sent|partial|received|cancelled (CHECK landed in
        // 20260704000000_po_loop.sql). The "Mark as Submitted" path means the
        // order has gone to the vendor, which maps to 'sent' (the legacy
        // 'submitted' token was normalized to 'sent' by the same migration).
        status: 'sent',
        ...(referenceDate ? { reference_date: referenceDate } : {}),
      })
      .select('id')
      .abortSignal(signal)
      .single();
    if (error) { console.warn('[Supabase] createPurchaseOrder:', error.message); return null; }
    return data?.id || null;
  }, { kind: 'write', label: 'createPurchaseOrder' });
}

// ─── Spec 107 — PURCHASE-ORDER LOOP (create-draft, receive, lifecycle) ────
// Frontend slice of spec 107. The BACKEND slice (RPCs, status CHECK,
// pending_po_qty swap, send-po-email edge fn) landed in
// 20260704000000_po_loop.sql + supabase/functions/send-po-email/.

/**
 * One PO line, mapped snake→camel from a `po_items` row joined through
 * `inventory_items → catalog_ingredients` for the item name / unit and
 * `sub_unit_size` (spec 107 §8). Drives the POsSection detail table and the
 * ReceivingSection PO-driven mode's outstanding-remainder prefill.
 */
export interface PoLine {
  poItemId: string;              // po_items.id
  itemId: string;                // inventory_items.id
  itemName: string;
  unit: string;
  orderedQty: number;
  receivedQty: number;           // cumulative across partial receives (0 when null)
  costPerUnit: number;           // per-COUNTED-unit snapshot at PO-create time (OQ-6)
  subUnitSize: number;           // for any downstream per-each bridge; 1 when null
  caseQty: number;               // catalog case_qty; 1 when null — for the case-price ghost + 30% bridge (spec 109 §10b)
}

function mapPoItemRow(r: any): PoLine {
  const ii = r.inventory_items || {};
  const ci = ii.catalog_ingredients || {};
  return {
    poItemId: r.id,
    itemId: r.item_id,
    itemName: ci.name || '',
    unit: ci.unit || '',
    orderedQty: Number(r.ordered_qty) || 0,
    receivedQty: Number(r.received_qty) || 0,
    costPerUnit: Number(r.cost_per_unit) || 0,
    subUnitSize: Number(ci.sub_unit_size) || 1,
    caseQty: Number(ci.case_qty) || 1,
  };
}

/**
 * Spec 107 §5 — first `po_items` write path: create an EDITABLE DRAFT PO from
 * a reorder vendor card. Client-side PostgREST insert (NOT an RPC — the insert
 * RLS policies already exist and are correct; a draft is a benign, deletable
 * state so the 2-round-trip atomicity gap is acceptable, per §5). Inserts the
 * header (`status: 'draft'`) then bulk-inserts the lines. On a lines-insert
 * failure, best-effort deletes the header so no orphan is left, and returns
 * null.
 *
 * `costPerUnitCounted` is the OQ-6 per-COUNTED-unit snapshot the caller
 * computes via the spec-104 ★ bridge (`inventory_items.costPerUnit` per-each
 * × `subUnitSize`); it is stored verbatim into `po_items.cost_per_unit`
 * (documented basis in the migration's column comment).
 */
export async function createPurchaseOrderDraft(params: {
  storeId: string;
  vendorId: string;
  createdByUserId?: string;
  referenceDate?: string;                 // YYYY-MM-DD → reference_date
  lines: Array<{
    itemId: string;
    orderedQty: number;                   // COUNTED units (= suggestedUnits from reorder)
    costPerUnitCounted: number;           // OQ-6 per-COUNTED-unit snapshot
  }>;
}): Promise<string | null> {
  return useInflight.getState().track(async (signal) => {
    if (!params.storeId || !params.vendorId || params.lines.length === 0) return null;

    const totalCost = params.lines.reduce(
      (sum, ln) => sum + (Number(ln.orderedQty) || 0) * (Number(ln.costPerUnitCounted) || 0),
      0,
    );

    const { data: header, error: headerErr } = await supabase
      .from('purchase_orders')
      .insert({
        store_id: params.storeId,
        vendor_id: params.vendorId,
        created_by: params.createdByUserId || null,
        status: 'draft',
        total_cost: totalCost,
        ...(params.referenceDate ? { reference_date: params.referenceDate } : {}),
      })
      .select('id')
      .abortSignal(signal)
      .single();
    if (headerErr || !header?.id) {
      console.warn('[Supabase] createPurchaseOrderDraft (header):', headerErr?.message);
      return null;
    }

    const poId = header.id as string;
    const { error: linesErr } = await supabase
      .from('po_items')
      .insert(
        params.lines.map((ln) => ({
          po_id: poId,
          item_id: ln.itemId,
          ordered_qty: ln.orderedQty,
          received_qty: null,
          cost_per_unit: ln.costPerUnitCounted,
        })),
      )
      .abortSignal(signal);
    if (linesErr) {
      console.warn('[Supabase] createPurchaseOrderDraft (lines):', linesErr.message);
      // Best-effort clean up the orphan header so no empty draft is left.
      await supabase.from('purchase_orders').delete().eq('id', poId);
      return null;
    }
    return poId;
  }, { kind: 'write', label: 'createPurchaseOrderDraft' });
}

/**
 * Spec 107 §8 — read a PO's `po_items` lines (header stays in the
 * orderSubmissions list). Joined through inventory_items → catalog_ingredients
 * for the item name / unit / sub_unit_size. Drives the POsSection detail and
 * the ReceivingSection PO-driven mode.
 */
export async function fetchPurchaseOrderLines(poId: string): Promise<PoLine[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('po_items')
      .select('id, item_id, ordered_qty, received_qty, cost_per_unit, inventory_items(catalog_id, catalog_ingredients(name, unit, sub_unit_size, case_qty))')
      .eq('po_id', poId)
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] fetchPurchaseOrderLines:', error.message); return []; }
    return (data || []).map(mapPoItemRow);
  }, { kind: 'read', label: 'fetchPurchaseOrderLines' });
}

/**
 * Spec 107 §5/§8 — edit a DRAFT PO line's ordered_qty (lines are editable
 * before send). Plain PostgREST UPDATE (RLS `store_member_update_po_items`
 * scopes it through the parent PO). Recomputes nothing server-side; the header
 * total_cost is display-derived from the lines. Returns true on success.
 */
export async function updatePoItemQty(poItemId: string, orderedQty: number): Promise<boolean> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('po_items')
      .update({ ordered_qty: orderedQty })
      .eq('id', poItemId)
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] updatePoItemQty:', error.message); throw error; }
    return true;
  }, { kind: 'write', label: 'updatePoItemQty' });
}

/**
 * Spec 107 §5/§8 — remove a line from a DRAFT PO (editable before send). Plain
 * PostgREST DELETE (RLS `store_member_delete_po_items` scopes through the
 * parent PO). Returns true on success.
 */
export async function deletePoItem(poItemId: string): Promise<boolean> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('po_items')
      .delete()
      .eq('id', poItemId)
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] deletePoItem:', error.message); throw error; }
    return true;
  }, { kind: 'write', label: 'deletePoItem' });
}

/**
 * Spec 107 §3 / spec 109 §10 — receive against a PO. Wraps
 * `receive_purchase_order`. `lines` are the this-receive deltas (received_qty
 * ADDITIVE — the caller submits how much arrived THIS receive, prefilled with
 * the OUTSTANDING remainder, NOT the ordered total). `clientUuid` is minted once
 * per receive event for idempotency (mirrors submitInventoryCount).
 *
 * Spec 109 (cost-on-receipt): each line may carry an OPTIONAL `newCasePrice` —
 * the CASE price as invoiced. It maps to `new_case_price` ONLY when it is a
 * finite number, so an unchanged line stays a spec-107-shaped object (no key →
 * server NULL → no-op; older callers are unaffected). A price that DIFFERS from
 * the (item, PO-vendor) link's current case price updates BOTH the item_vendors
 * link AND the item scalar via the spec-104 ★ formula and returns a
 * `priceChanges` entry. The array is `[]` when no line changed price (including
 * on the idempotent-replay path). Returns the resulting status + conflict flag +
 * the applied price changes, or null on error (caller wraps notifyBackendError).
 */
export async function receivePurchaseOrder(
  poId: string,
  lines: Array<{ poItemId: string; receivedQty: number; newCasePrice?: number }>,
  clientUuid: string,
): Promise<{
  status: string;
  conflict: boolean;
  priceChanges: Array<{
    poItemId: string;
    itemId: string;
    oldCasePrice: number | null;
    newCasePrice: number;
    oldCostPerUnit: number | null;
    newCostPerUnit: number;
  }>;
} | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('receive_purchase_order', {
      p_po_id: poId,
      p_lines: lines.map((ln) => ({
        po_item_id: ln.poItemId,
        received_qty: ln.receivedQty,
        // Only send the price when it is a real number — an unchanged line omits
        // the key so the server treats it as a pure stock receive (spec-107 path).
        ...(typeof ln.newCasePrice === 'number' && Number.isFinite(ln.newCasePrice)
          ? { new_case_price: ln.newCasePrice }
          : {}),
      })),
      p_client_uuid: clientUuid,
    }).abortSignal(signal);
    if (error) {
      console.warn('[Supabase] receivePurchaseOrder:', error.message, error);
      throw error;
    }
    const result = (data || {}) as {
      status?: string;
      conflict?: boolean;
      price_changes?: Array<Record<string, unknown>>;
    };
    const priceChanges = (result.price_changes || []).map((pc) => ({
      poItemId: String(pc.po_item_id),
      itemId: String(pc.item_id),
      oldCasePrice: pc.old_case_price == null ? null : Number(pc.old_case_price),
      newCasePrice: Number(pc.new_case_price),
      oldCostPerUnit: pc.old_cost_per_unit == null ? null : Number(pc.old_cost_per_unit),
      newCostPerUnit: Number(pc.new_cost_per_unit),
    }));
    return { status: result.status || '', conflict: !!result.conflict, priceChanges };
  }, { kind: 'write', label: 'receivePurchaseOrder' });
}

/**
 * Spec 107 §3 — close a `partial` PO short: releases the outstanding remainder
 * out of pending_po_qty (stamps received_at, status → received). Wraps
 * `close_short_purchase_order`. Returns the resulting status, or null on error.
 */
export async function closePurchaseOrderShort(poId: string): Promise<string | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('close_short_purchase_order', {
      p_po_id: poId,
    }).abortSignal(signal);
    if (error) { console.warn('[Supabase] closePurchaseOrderShort:', error.message, error); throw error; }
    return ((data || {}) as { status?: string }).status || null;
  }, { kind: 'write', label: 'closePurchaseOrderShort' });
}

/**
 * Spec 107 §3 — cancel a draft/sent/partial PO (releases its pending quantity;
 * does NOT touch already-received stock). Wraps `cancel_purchase_order`.
 * Returns the resulting status, or null on error.
 */
export async function cancelPurchaseOrder(poId: string): Promise<string | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('cancel_purchase_order', {
      p_po_id: poId,
    }).abortSignal(signal);
    if (error) { console.warn('[Supabase] cancelPurchaseOrder:', error.message, error); throw error; }
    return ((data || {}) as { status?: string }).status || null;
  }, { kind: 'write', label: 'cancelPurchaseOrder' });
}

/**
 * Spec 107 §7 — mark a PO as sent WITHOUT emailing (the manual fallback for
 * phone/text vendors and empty-vendors.email). Plain PostgREST UPDATE
 * (`store_member_update_purchase_orders` already permits it). Returns true on
 * success.
 */
export async function markPurchaseOrderSent(poId: string): Promise<boolean> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('purchase_orders')
      .update({ status: 'sent' })
      .eq('id', poId)
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] markPurchaseOrderSent:', error.message); throw error; }
    return true;
  }, { kind: 'write', label: 'markPurchaseOrderSent' });
}

// Shared row→object mapper for a `purchase_orders` select that uses the
// column projection below (the same one fetchRecentPurchaseOrders and
// fetchOrderSubmissionsForStores both request). Extracted per spec 081 D5 so
// the two callers stay byte-identical — one source of truth for the snake→
// camel mapping. The returned object is a SUPERSET of `OrderSubmission`
// (it also carries vendorId/totalCost/status/etc. that the interface doesn't
// declare), which is why both callers type their return as `any[]` /
// `OrderSubmission[]` over this shape. The three fields the unconfirmed_po
// predicate (cmdSelectors.ts:890-895) reads — storeId, date, vendorName —
// are all populated here.
function mapPurchaseOrderRow(r: any) {
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
}

export async function fetchRecentPurchaseOrders(storeId: string, days = 14): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, store_id, vendor_id, vendor:vendors(name), created_by, creator:profiles!created_by(name), created_at, reference_date, status, total_cost')
      .eq('store_id', storeId)
      .gte('created_at', cutoff.toISOString())
      .order('created_at', { ascending: false })
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] fetchRecentPurchaseOrders:', error.message); return []; }
    return (data || []).map(mapPurchaseOrderRow);
  }, { kind: 'read', label: 'fetchRecentPurchaseOrders' });
}

// Spec 081 — cross-store sibling of fetchRecentPurchaseOrders (above). Source
// table is `purchase_orders` (NOT "order_submissions" — that table does not
// exist; the spec AC text mislabels it, see spec 081 Risk 1 + the source-table
// correction section). The Dashboard attention-queue's `unconfirmed_po` rule
// needs every store's submissions — not just the focal store's — so each store
// card can match its own schedule against its own POs. `sinceDate` is an ISO
// date string compared against created_at (the Dashboard reuses the same
// 14-day lookback it passes to the EOD/POS fetchers; the selector's work-week
// window trims anything outside this week anyway — spec 081 D3).
//
// Single-trip IN(...) select; RLS (auth_can_see_store on purchase_orders)
// silently drops rows the caller can't see, so we don't pre-filter storeIds —
// same posture as fetchEodSubmissionsForStores / fetchPosImportsForStores.
// Returns [] on empty input or PostgREST error (degrade, don't throw — the
// Dashboard must keep rendering its other rules). Each row carries
// storeId/date/vendorName via the shared mapPurchaseOrderRow, which is exactly
// what the unconfirmed_po predicate (cmdSelectors.ts:890-895) reads.
export async function fetchOrderSubmissionsForStores(
  storeIds: string[],
  sinceDate: string,
): Promise<OrderSubmission[]> {
  if (storeIds.length === 0) return [];
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, store_id, vendor_id, vendor:vendors(name), created_by, creator:profiles!created_by(name), created_at, reference_date, status, total_cost')
      .in('store_id', storeIds)
      .gte('created_at', sinceDate)
      .order('created_at', { ascending: false })
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchOrderSubmissionsForStores:', error.message);
      return [];
    }
    return (data || []).map(mapPurchaseOrderRow) as OrderSubmission[];
  }, { kind: 'read', label: 'fetchOrderSubmissionsForStores' });
}

// ─── VENDORS ─────────────────────────────────────────────────────────────
export async function fetchVendors(brandId?: string): Promise<Vendor[]> {
  return useInflight.getState().track(async (signal) => {
    let query = supabase.from('vendors').select('*').order('name');
    if (brandId) query = query.eq('brand_id', brandId);
    const { data, error } = await query.abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchVendors' });
}

export async function createVendor(vendor: Omit<Vendor, 'id'>): Promise<Vendor> {
  if (!vendor.brandId || vendor.brandId.length < 10) throw new Error('Invalid brand ID');
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.from('vendors').insert({
      brand_id: vendor.brandId,
      name: vendor.name, contact_name: vendor.contactName, phone: vendor.phone,
      email: vendor.email, account_number: vendor.accountNumber,
      lead_time_days: vendor.leadTimeDays, delivery_days: vendor.deliveryDays, categories: vendor.categories,
      ...(vendor.orderCutoffTime ? { order_cutoff_time: vendor.orderCutoffTime } : {}),
      ...(vendor.eodDeadlineTime ? { eod_deadline_time: vendor.eodDeadlineTime } : {}),
    }).select().abortSignal(signal).single();
    if (error) throw error;
    return { ...vendor, id: data.id };
  }, { kind: 'write', label: 'createVendor' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('in_app_notifications')
      .select('id, message, created_at, read_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] fetchNotifications:', error.message); return []; }
    return (data || []).map((r: any) => ({
      id: r.id, message: r.message, createdAt: r.created_at, readAt: r.read_at,
    }));
  }, { kind: 'read', label: 'fetchNotifications' });
}

export async function createNotification(userId: string, message: string): Promise<string | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('in_app_notifications')
      .insert({ user_id: userId, message })
      .select('id')
      .abortSignal(signal)
      .single();
    if (error) { console.warn('[Supabase] createNotification:', error.message); return null; }
    return data?.id ?? null;
  }, { kind: 'write', label: 'createNotification' });
}

export async function markNotificationReadDb(id: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('in_app_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .abortSignal(signal);
    if (error) console.warn('[Supabase] markNotificationReadDb:', error.message);
  }, { kind: 'write', label: 'markNotificationReadDb' });
}

export async function clearNotificationsDb(userId: string): Promise<void> {
  // "Clear" = mark all as read, not delete, so we still have history if needed.
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('in_app_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null)
      .abortSignal(signal);
    if (error) console.warn('[Supabase] clearNotificationsDb:', error.message);
  }, { kind: 'write', label: 'clearNotificationsDb' });
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────
export async function fetchAuditLog(storeId: string, limit = 100): Promise<AuditEvent[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('audit_log')
      .select(`*, actor:profiles!user_id(name, role), store:stores(name)`)
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchAuditLog' });
}

export async function addAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase.from('audit_log').insert({
      store_id: event.storeId,
      user_id: event.userId,
      action: event.action,
      detail: event.detail,
      item_ref: event.itemRef,
      value: event.value,
    }).abortSignal(signal);
  }, { kind: 'write', label: 'addAuditEvent' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('pos_imports')
      .insert({
        store_id: storeId, filename,
        imported_by: importedById,
        import_date: date,
      })
      .select()
      .abortSignal(signal)
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
    ).abortSignal(signal);
  }, { kind: 'write', label: 'savePOSImport' });
}

// Dedup check for breadbot backfill: returns true if pos_imports already has
// a row for this (store, date). Uses count+head so supabase returns no row
// payload — just the aggregate count.
export async function hasPOSImportForDate(
  storeId: string,
  date: string,
): Promise<boolean> {
  return useInflight.getState().track(async (signal) => {
    const { count, error } = await supabase
      .from('pos_imports')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('import_date', date)
      .abortSignal(signal);
    if (error) throw error;
    return (count ?? 0) > 0;
  }, { kind: 'read', label: 'hasPOSImportForDate' });
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
  return useInflight.getState().track(async (signal) => {
    // `supabase.functions.invoke` accepts a `signal: AbortSignal` in its
    // FunctionInvokeOptions (functions-js types.d.ts:110).
    const { data, error } = await supabase.functions.invoke('fetch-breadbot-sales', {
      body: { storeName, date },
      signal,
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
  }, { kind: 'read', label: 'fetchBreadbotSales' });
}

// ─── DELETE INVENTORY ────────────────────────────────────────────────────
export async function deleteInventoryItem(id: string): Promise<void> {
  if (!id || id.length < 10) return; // Skip local temp IDs
  return useInflight.getState().track(async (signal) => {
    await supabase.from('inventory_items').delete().eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'deleteInventoryItem' });
}

// ─── UPDATE/DELETE RECIPE ────────────────────────────────────────────────
// Spec 040 P3: signature widened to accept `i18nNames` in the partial. Same
// omit-key-to-skip semantics as the other catalog-level fields.
export async function updateRecipe(
  id: string,
  updates: Partial<Recipe> & { i18nNames?: Record<string, string> },
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const dbUpdates: any = {};
    if (updates.menuItem !== undefined) dbUpdates.menu_item = updates.menuItem;
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.sellPrice !== undefined) dbUpdates.sell_price = updates.sellPrice;
    // Spec 040 P3: per-locale name overrides for the recipe row. Passing `{}`
    // clears all translations; omitting the field leaves the column untouched.
    if (updates.i18nNames !== undefined) dbUpdates.i18n_names = updates.i18nNames;
    if (Object.keys(dbUpdates).length > 0) {
      await supabase.from('recipes').update(dbUpdates).eq('id', id).abortSignal(signal);
    }
    // Update ingredients if provided
    if (updates.ingredients) {
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', id).abortSignal(signal);
      if (updates.ingredients.length > 0) {
        await supabase.from('recipe_ingredients').insert(
          updates.ingredients.map((ing) => ({
            recipe_id: id, item_id: ing.itemId, quantity: ing.quantity, unit: ing.unit,
          }))
        ).abortSignal(signal);
      }
    }
    // Update prep items if provided
    if (updates.prepItems) {
      await supabase.from('recipe_prep_items').delete().eq('recipe_id', id).abortSignal(signal);
      if (updates.prepItems.length > 0) {
        await supabase.from('recipe_prep_items').insert(
          updates.prepItems.map((p) => ({
            recipe_id: id, prep_recipe_id: p.prepRecipeId, quantity: p.quantity, unit: p.unit,
          }))
        ).abortSignal(signal);
      }
    }
  }, { kind: 'write', label: 'updateRecipe' });
}

export async function deleteRecipe(id: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', id).abortSignal(signal);
    await supabase.from('recipe_prep_items').delete().eq('recipe_id', id).abortSignal(signal);
    await supabase.from('recipes').delete().eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'deleteRecipe' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('recipes')
      .select('id, store_id')
      .ilike('menu_item', menuItem)
      .in('store_id', storeIds)
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] findRecipesByMenuItem', error.message);
      return [];
    }
    return (data || []).map((r: any) => ({ id: r.id, storeId: r.store_id }));
  }, { kind: 'read', label: 'findRecipesByMenuItem' });
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
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('profiles')
      .update({ notifications_enabled: enabled })
      .eq('id', userId)
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] updateProfileNotifications:', error.message);
      return false;
    }
    return true;
  }, { kind: 'write', label: 'updateProfileNotifications' });
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
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('profiles')
      .update({ sidebar_layout: layout })
      .eq('id', userId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'saveSidebarLayout' });
}

// ─── LOCALE (Spec 038) ─────────────────────────────────────────────────
/**
 * Spec 038: persist the user's preferred chrome language to
 * `profiles.locale`. Throws on error so the store can revert the
 * optimistic mutation per the notifyBackendError pattern.
 *
 * Gated by the existing "Users can update own profile" RLS policy on
 * profiles (id = auth.uid()), so a cross-user write is silently 0 rows.
 * Enum validity is enforced server-side by the `profiles_locale_check`
 * CHECK constraint (en/es/zh-CN); the TS union here is the soft client
 * guard. See specs/038-multi-language-support-p1-chrome.md §4.
 */
export async function saveLocale(
  userId: string,
  locale: 'en' | 'es' | 'zh-CN',
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('profiles')
      .update({ locale })
      .eq('id', userId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'saveLocale' });
}

// ─── COUNT-SCREEN CUSTOM ORDER (Spec 103) ──────────────────────────────
/**
 * Spec 103 — per-user PRIVATE custom row order for the count screens, backed
 * by the `public.user_count_orders` side table (one row per
 * (user_id, screen, vendor_id), `item_ids` a JSONB ordered array of
 * inventory_items.id). These three helpers are the ADMIN path
 * (EODCountSection, InventoryCountSection); the staff screens use the
 * documented src/screens/staff/ direct-`supabase` carve-out with a parallel
 * helper that imports the same pure `applyCountOrder`/`firstUncounted` from
 * `./countOrder` (design §5).
 *
 * The row maps to a single field the screen needs — the ordered id array — so
 * there is no mapItem-style camelCase object: the read returns a plain
 * `string[]` (or `null` when no row exists → default view). The order is a VIEW
 * concern only; it is NEVER the submission source (AC-9) — `applyCountOrder`
 * (pure, in ./countOrder) re-points only the render list and the gate's "first"
 * resolution.
 *
 * Gated by the owner-scoped RLS on user_count_orders
 * (auth.uid() = user_id; migration 20260630000500). Every query also pins
 * `.eq('user_id', userId)` so a cross-user write is silently 0 rows
 * (defense-in-depth; the policy already blocks it).
 *
 * vendorId distinguishes the two surface families (design §1 / OQ-1):
 *   • 'admin-eod' / 'staff-eod'        → per-vendor (pass the vendor id);
 *   • 'admin-inventory' / 'staff-weekly' → per-surface (pass null).
 * PostgREST distinguishes `.eq('vendor_id', v)` from `.is('vendor_id', null)`
 * (`.eq` against null does not match), so the read/delete branch on vendorId,
 * and the upsert uses the matching partial-unique conflict target (§1.2).
 */

/**
 * READ (on screen open / vendor change). Returns the saved ordered id array,
 * or `null` when no row exists (→ the screen renders its default order).
 *
 * `kind: 'read'`. A zero-row result is NOT an error — it is the
 * no-custom-order state. The caller falls back to the default order on a
 * genuine error too (AC-7: the screen still renders; the order just isn't
 * applied), surfacing via its existing notifyBackendError path.
 */
export async function fetchCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
): Promise<string[] | null> {
  return useInflight.getState().track(async (signal) => {
    let query = supabase
      .from('user_count_orders')
      .select('item_ids')
      .eq('user_id', userId)
      .eq('screen', screen);
    // PostgREST: `.eq('vendor_id', null)` would NOT match a NULL row — the
    // no-vendor surfaces (Inventory/Weekly) must use `.is(..., null)`.
    query = vendorId === null
      ? query.is('vendor_id', null)
      : query.eq('vendor_id', vendorId);
    const { data, error } = await query.abortSignal(signal).maybeSingle();
    if (error) throw error;
    // item_ids is a JSONB array of strings; default to null (no saved order).
    const ids = (data?.item_ids ?? null) as string[] | null;
    return ids;
  }, { kind: 'read', label: 'fetchCountOrder' });
}

/**
 * WRITE (persist-on-drop). Persists the FULL ordered array for one
 * (user, screen, vendor?) key as a delete-then-insert. Throws on error so the
 * section can revert the optimistic on-screen order and call notifyBackendError
 * (AC-6).
 *
 * NOT an upsert: PostgREST's `.upsert({ onConflict })` cannot target the two
 * PARTIAL unique indexes (design §1.2) — it can't supply their WHERE predicate,
 * so it 42P10s on both the vendor and no-vendor branches. So delete the one
 * (user, screen, vendor?) row then insert the new array; the two partial indexes
 * remain as the duplicate guard. There is no UPDATE leg, so `updated_at` is set
 * on the insert only. The two calls are NOT atomic: if the section unmounts
 * mid-drop the threaded abort signal can reject the insert after the delete has
 * committed, leaving the row ABSENT (not reverted) — the next open re-reads truth
 * and the next drop re-saves the full array. Acceptable for a private per-user
 * view preference.
 */
export async function saveCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
  itemIds: string[],
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    // PostgREST `.upsert({ onConflict })` CANNOT target a PARTIAL unique index —
    // it can't supply the index's WHERE predicate, so it 42P10s on both the
    // (user_id, screen) and (user_id, screen, vendor_id) branches. Persist as a
    // delete-then-insert for the one (user, screen, vendor?) key; the two
    // partial unique indexes stay as the duplicate guard. Not atomic across the
    // two PostgREST calls, but this is a private per-user VIEW preference — a
    // torn write just means the next drop re-saves (and the section reverts +
    // notifies on a thrown error, AC-6).
    let del = supabase
      .from('user_count_orders')
      .delete()
      .eq('user_id', userId)
      .eq('screen', screen);
    del = vendorId === null ? del.is('vendor_id', null) : del.eq('vendor_id', vendorId);
    const { error: delErr } = await del.abortSignal(signal);
    if (delErr) throw delErr;
    const { error: insErr } = await supabase
      .from('user_count_orders')
      .insert({
        user_id: userId,
        screen,
        vendor_id: vendorId,
        item_ids: itemIds,
        updated_at: new Date().toISOString(),
      })
      .abortSignal(signal);
    if (insErr) throw insErr;
  }, { kind: 'write', label: 'saveCountOrder' });
}

/**
 * RESET (per-screen "reset to default order"). Deletes the one
 * (user, screen, vendor?) row so the screen falls back to its default view
 * (AC-4 / AC-8). Throws on error so the section can surface notifyBackendError.
 * Touches ONLY this key — the other three screen keys are untouched.
 */
export async function resetCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    let query = supabase
      .from('user_count_orders')
      .delete()
      .eq('user_id', userId)
      .eq('screen', screen);
    query = vendorId === null
      ? query.is('vendor_id', null)
      : query.eq('vendor_id', vendorId);
    const { error } = await query.abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'resetCountOrder' });
}

// ─── COUNT-SCREEN SAVE-DRAFT + RESUME (Spec 106) ───────────────────────
/**
 * Spec 106 — per-user PRIVATE resumable DRAFT for the two count screens,
 * backed by the `public.user_count_drafts` side table (one row per
 * (user_id, screen, store_id); `payload` an opaque JSONB blob whose shape is
 * owned by the pure serializers in `./countDrafts`, `saved_at` the
 * client-stamped whole-draft last-write-wins key). These three helpers are the
 * ADMIN path (InventoryCountSection); the staff Weekly screen uses the
 * documented src/screens/staff/ direct-`supabase` carve-out with a parallel
 * helper that re-exports the same pure `./countDrafts` module (design §5 / §6).
 *
 * A draft is resumable scratch ONLY — saving one NEVER writes current_stock /
 * inventory_items and NEVER produces a history row (AC-9). The row envelope is
 * camelCased inline (payload stays raw; the serializer owns its shape) — no
 * mapItem-scale entity.
 *
 * Gated by the owner-scoped RLS on user_count_drafts
 * (auth.uid() = user_id; migration 20260703000000), NO admin/super_admin
 * bypass. Every query also pins `.eq('user_id', userId)` so a cross-user
 * read/delete is silently 0 rows and a cross-user upsert is 42501
 * (defense-in-depth; the policy already blocks it).
 *
 * PERSIST IS A PLAIN UPSERT (design §4, the deliberate divergence from spec
 * 103): the FULL `unique (user_id, screen, store_id)` constraint (all three
 * columns NOT NULL — no NULL-vendor branch) IS a valid ON CONFLICT target, so
 * `saveCountDraft` uses `.upsert({ onConflict: 'user_id,screen,store_id' })`
 * — NOT the spec-103 delete-then-insert (that was forced by spec 103's two
 * PARTIAL indexes, which a `.upsert` can't target → 42P10).
 */

/** The camelCase row envelope the admin screen consumes. `payload` stays as the
 *  raw JSONB object (the pure serializer in ./countDrafts owns its shape); only
 *  the envelope is camelCased (saved_at → savedAt). */
export type CountDraftRow = {
  payload: Record<string, unknown>;
  savedAt: string; // ISO-8601, client-stamped (saved_at)
};

/**
 * READ (on screen open). Returns the draft row or `null` when no draft exists
 * for the (user, screen, store) slot (the no-draft state — NOT an error).
 * `kind: 'read'`. On a genuine error the caller degrades to "no draft" and the
 * form renders fresh (AC-5 restore is best-effort; a failed fetch must not
 * block the count) — surfacing via its existing notifyBackendError path.
 */
export async function fetchCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<CountDraftRow | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('user_count_drafts')
      .select('payload, saved_at')
      .eq('user_id', userId)
      .eq('screen', screen)
      .eq('store_id', storeId)
      .abortSignal(signal)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    // Camel-case the envelope inline (no mapItem). payload is opaque JSONB.
    return {
      payload: (data.payload ?? {}) as Record<string, unknown>,
      savedAt: data.saved_at as string,
    };
  }, { kind: 'read', label: 'fetchCountDraft' });
}

/**
 * SAVE (upsert whole-draft, design §4). Replaces the one (user, screen, store)
 * slot with the given payload as a plain `.upsert` on the FULL unique
 * constraint (whole-draft overwrite, AC-4). `kind: 'write'`. Throws on error so
 * the section can revert + notifyBackendError.
 *
 * `savedAt` is minted by the CALLER at Save time (design §9) and passed
 * through UNCHANGED so the SAME stamp lands on both the server row and the
 * device-local copy — that is what makes the reconcile equal-tie a true
 * "already synced" no-op rather than a spurious push. The helper does NOT mint
 * `saved_at` itself. `updated_at` is set to a fresh server-audit timestamp on
 * the upsert, but the AUTHORITATIVE ordering value is the caller's `savedAt`
 * (the reconcile never reads updated_at).
 *
 * MUST use `onConflict: 'user_id,screen,store_id'` (matching the constraint
 * columns) — a mismatched or omitted onConflict would 42P10 or duplicate.
 */
export async function saveCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
  payload: Record<string, unknown>,
  savedAt: string,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('user_count_drafts')
      .upsert(
        {
          user_id: userId,
          screen,
          store_id: storeId,
          payload,
          saved_at: savedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,screen,store_id' },
      )
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'saveCountDraft' });
}

/**
 * DELETE the one (user, screen, store) slot. Used by both Discard (AC-7) and
 * the successful-Submit cleanup (AC-8). `kind: 'write'`. Throws on error so the
 * section can surface notifyBackendError. Touches ONLY this slot.
 */
export async function deleteCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('user_count_drafts')
      .delete()
      .eq('user_id', userId)
      .eq('screen', screen)
      .eq('store_id', storeId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'deleteCountDraft' });
}

// ─── TRANSLATE-ON-SAVE (Spec 040) ─────────────────────────────────────
/**
 * Spec 040 P3b — invoke the `translate-on-save` edge function to auto-fill
 * per-locale name suggestions for an entity (ingredient / recipe / prep /
 * category). The edge function gates on `requireAdminCaller` server-side
 * and returns DeepL-backed translations for the requested target locales.
 *
 * Envelope shape matches `callEdgeFunction` from src/lib/auth.ts —
 * `{ data, error }`. The caller (form layer) decides whether to surface
 * the error as a toast or quietly fall through to manual-override entry.
 *
 * Partial-success is allowed: if DeepL returns a translation for `es` but
 * not `zh-CN`, the returned `translations` object carries only `es`. The
 * form fills the succeeded fields and leaves the others as manual-override-
 * only. Whole-call failure (e.g. DEEPL_API_KEY unset, all locales failed,
 * network error) surfaces as a non-null `error` per the standard envelope.
 *
 * Edge function signature (architect §4):
 *   POST /functions/v1/translate-on-save
 *   { text: string, sourceLocale: 'en', targetLocales: ('es' | 'zh-CN')[] }
 *   → 200 { translations: { es?, 'zh-CN'? } }
 *   → 400 / 401 / 403 / 503 { error: '...' }
 *
 * One-time operator step required before this works:
 *   supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-signup>
 */
export async function translateOnSave(
  text: string,
  targetLocales: Array<'es' | 'zh-CN'>,
  signal?: AbortSignal,
): Promise<{
  data: { translations: { es?: string; 'zh-CN'?: string } } | null;
  error: string | null;
}> {
  // Spec 055 §3 / spec line 64 — edge-function calls made directly via
  // `callEdgeFunction` are excluded from the global counter in v1. This
  // helper additionally threads the caller's own `signal` verbatim into
  // fetch (Spec 040 — debounce-cancel contract); wrapping it in `track()`
  // would either fork the signal (breaking the verbatim contract) or
  // need a Promise.race shim that complicates the abort semantics. Keep
  // the existing untracked behavior; the form's 600ms debounce already
  // protects against runaway in-flight calls.
  return callEdgeFunction(
    'translate-on-save',
    { text, sourceLocale: 'en', targetLocales },
    { signal },
  );
}

// ─── i18n_names PARTIAL-UPDATE HELPERS (Spec 040 P3b) ─────────────────────
// Per architect design §5, the form's translation suggestion can arrive
// AFTER the save returns (600ms debounce + ~200ms DeepL + an in-flight
// race with the Save click). Rather than re-issuing a whole-row UPDATE
// when the suggestion lands, each entity has a dedicated partial-update
// helper that touches ONLY i18n_names. Pairs with `setCatalogI18nNames`
// etc. on the useStore slice (frontend-developer's lane).
//
// Categories are keyed by `name` (not `id`) per the existing two-arg
// rename helpers; the *I18n helpers stick to that convention.

/** Patch `catalog_ingredients.i18n_names` by catalog id (brand-wide write —
 *  every store sees the new translations on the next render). RLS:
 *  privileged-write per spec 026/027. */
export async function updateCatalogIngredientI18n(
  catalogId: string,
  i18nNames: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('catalog_ingredients')
      .update({ i18n_names: i18nNames })
      .eq('id', catalogId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateCatalogIngredientI18n' });
}

/** Patch `recipes.i18n_names` by recipe id. Brand-scoped row; the existing
 *  privileged-write policy covers the new column. */
export async function updateRecipeI18n(
  recipeId: string,
  i18nNames: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('recipes')
      .update({ i18n_names: i18nNames })
      .eq('id', recipeId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateRecipeI18n' });
}

/** Patch `prep_recipes.i18n_names` by prep recipe id. The versioning model
 *  for prep_recipes (see updatePrepRecipeVersioned) treats versions as
 *  immutable historical snapshots — this helper writes to the SPECIFIC row
 *  identified by `id`. Callers driving translations on the current version
 *  pass the `is_current=true` row's id. */
export async function updatePrepRecipeI18n(
  prepId: string,
  i18nNames: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('prep_recipes')
      .update({ i18n_names: i18nNames })
      .eq('id', prepId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updatePrepRecipeI18n' });
}

/** Patch `recipe_categories.i18n_names` by category name. Global-scope row
 *  (no brand_id / store_id); RLS is "Admins can write categories." */
export async function updateRecipeCategoryI18n(
  name: string,
  i18nNames: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('recipe_categories')
      .update({ i18n_names: i18nNames })
      .eq('name', name)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateRecipeCategoryI18n' });
}

/** Patch `ingredient_categories.i18n_names` by category name. Global-scope
 *  row; RLS is the spec-004 four-policy split (admin-gated writes). */
export async function updateIngredientCategoryI18n(
  name: string,
  i18nNames: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('ingredient_categories')
      .update({ i18n_names: i18nNames })
      .eq('name', name)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateIngredientCategoryI18n' });
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
  return useInflight.getState().track(async (signal) => {
  let query = supabase
    .from('prep_recipes')
    .select(`*,
      prep_recipe_ingredients!prep_recipe_ingredients_prep_recipe_id_fkey(*,
        catalog:catalog_ingredients(id, name, unit)
      )`);
  if (brandId) query = query.eq('brand_id', brandId);
  const { data, error } = await query.abortSignal(signal);
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
    // Spec 040 P3: per-locale name overrides on the prep recipe row.
    // Canonical English is in `name` above; JSONB shape {"es"?, "zh-CN"?}.
    i18nNames: (pr.i18n_names ?? {}) as Record<string, string>,
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
  }, { kind: 'read', label: 'fetchPrepRecipes' });
}

export async function fetchPrepRecipesByName(
  name: string,
  brandId?: string,
): Promise<{ id: string; brandId: string }[]> {
  return useInflight.getState().track(async (signal) => {
    let query = supabase
      .from('prep_recipes')
      .select('id, brand_id')
      .ilike('name', name.replace(/[%_]/g, '\\$&'))
      .eq('is_current', true);
    if (brandId) query = query.eq('brand_id', brandId);
    const { data, error } = await query.abortSignal(signal);
    if (error) throw error;
    return (data || []).map((r: any) => ({ id: r.id, brandId: r.brand_id }));
  }, { kind: 'read', label: 'fetchPrepRecipesByName' });
}

export async function createPrepRecipe(recipe: any): Promise<string> {
  const brandId = recipe.brandId || recipe.storeId;
  if (!brandId || brandId.length < 10) throw new Error('Invalid brand ID');

  return useInflight.getState().track(async (signal) => {
    // SELECT-then-INSERT-OR-UPDATE pattern. PostgREST .upsert() with
    // onConflict can't target a partial functional index
    // (prep_recipes_brand_name_current_unique uses lower(name) WHERE
    // is_current=true), so we look up an existing current row by name
    // first and route to updatePrepRecipeVersioned when found. This
    // makes "save same name twice" idempotent at the app layer too,
    // not just at the DB.
    //
    // Inner fetchPrepRecipesByName / updatePrepRecipeVersioned calls
    // open their own `track()` increments — the outer wrapper still
    // owns timer/abort lifecycle for the createPrepRecipe scope.
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
        // Spec 040 P3: per-locale name overrides on the prep recipe row.
        // Falls back to `{}` so the column lands at its default when the
        // caller doesn't pass translations.
        i18n_names: recipe.i18nNames ?? {},
      })
      .select().abortSignal(signal).single();
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
      ).abortSignal(signal);
    }
    return data.id;
  }, { kind: 'write', label: 'createPrepRecipe' });
}

export async function deletePrepRecipe(id: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase.from('prep_recipe_ingredients').delete().eq('prep_recipe_id', id).abortSignal(signal);
    await supabase.from('prep_recipes').delete().eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'deletePrepRecipe' });
}

// ─── UPDATE/DELETE VENDOR ───────────────────────────────────────────────
export async function updateVendor(id: string, updates: Partial<Vendor>): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.contactName !== undefined) dbUpdates.contact_name = updates.contactName;
    if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.leadTimeDays !== undefined) dbUpdates.lead_time_days = updates.leadTimeDays;
    // Pass the empty string through too so an admin can clear a previously-set cutoff.
    if (updates.orderCutoffTime !== undefined) dbUpdates.order_cutoff_time = updates.orderCutoffTime || null;
    if (updates.eodDeadlineTime !== undefined) dbUpdates.eod_deadline_time = updates.eodDeadlineTime || null;
    await supabase.from('vendors').update(dbUpdates).eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'updateVendor' });
}

export async function deleteVendor(id: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase.from('vendors').delete().eq('id', id).abortSignal(signal);
  }, { kind: 'write', label: 'deleteVendor' });
}

// ─── RECIPE CATEGORIES ──────────────────────────────────────────────────
// Spec 040 P3: the categories slice shape widens from `string[]` to
// `Array<{ name; i18nNames }>`. The architect's design §7 ("Categories
// shape upgrade") flagged this as the load-bearing fan-out to the frontend
// dev — every existing `.map((c) => c)` site that consumed a string now
// gets an object. Co-located write helpers accept an optional `i18nNames`
// param so the form can persist translations alongside the canonical name.
//
// Categories are keyed by `name` (not `id`) in this codebase. The legacy
// updateRecipeCategory(oldName, newName) two-arg signature is preserved
// (it's only used for renames). A new optional 3rd arg threads i18nNames
// — additive so existing call sites keep working unchanged.
export async function fetchRecipeCategories(): Promise<
  Array<{ name: string; i18nNames: Record<string, string> }>
> {
  return useInflight.getState().track(async (signal) => {
    const { data } = await supabase
      .from('recipe_categories')
      .select('name, i18n_names')
      .order('created_at')
      .abortSignal(signal);
    return (data || []).map((c: any) => ({
      name: c.name,
      i18nNames: (c.i18n_names ?? {}) as Record<string, string>,
    }));
  }, { kind: 'read', label: 'fetchRecipeCategories' });
}

// Spec 040 P3: optional `i18nNames` param. Omitting it INSERTs with the
// column default `{}` so existing callers (un-updated frontend) keep
// working. Passing a populated object lands translations atomically with
// the canonical English name on the first save.
export async function addRecipeCategory(
  name: string,
  i18nNames?: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase
      .from('recipe_categories')
      .insert({ name, i18n_names: i18nNames ?? {} })
      .abortSignal(signal);
  }, { kind: 'write', label: 'addRecipeCategory' });
}

// Spec 040 P3: optional `i18nNames` param. When passed, the JSONB column is
// rewritten alongside the rename in one statement (still not atomic across
// the rename + translation update because PostgREST is single-row-per-call,
// but the same posture as the pre-spec rename was non-atomic).
export async function updateRecipeCategory(
  oldName: string,
  newName: string,
  i18nNames?: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const dbUpdates: any = { name: newName };
    if (i18nNames !== undefined) dbUpdates.i18n_names = i18nNames;
    await supabase
      .from('recipe_categories')
      .update(dbUpdates)
      .eq('name', oldName)
      .abortSignal(signal);
  }, { kind: 'write', label: 'updateRecipeCategory' });
}

export async function deleteRecipeCategory(name: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase
      .from('recipe_categories')
      .delete()
      .eq('name', name)
      .abortSignal(signal);
  }, { kind: 'write', label: 'deleteRecipeCategory' });
}

// ─── INGREDIENT CONVERSIONS ─────────────────────────────────────────────
// Conversions are brand-level — one row per catalog ingredient + purchase
// unit. The TS field name stays `inventoryItemId` for back-compat;
// semantically it's a catalog id.
export async function fetchIngredientConversions(catalogId?: string): Promise<IngredientConversion[]> {
  return useInflight.getState().track(async (signal) => {
    let query = supabase.from('ingredient_conversions').select('*');
    if (catalogId) query = query.eq('catalog_id', catalogId);
    const { data, error } = await query.abortSignal(signal);
    if (error) throw error;
    return (data || []).map((c: any) => ({
      id: c.id,
      inventoryItemId: c.catalog_id,
      purchaseUnit: c.purchase_unit,
      baseUnit: c.base_unit,
      conversionFactor: c.conversion_factor,
      netYieldPct: c.net_yield_pct,
    }));
  }, { kind: 'read', label: 'fetchIngredientConversions' });
}

export async function upsertIngredientConversion(conv: Omit<IngredientConversion, 'id'>): Promise<void> {
  // Conversions are brand-level after Phase 3: keyed by (catalog_id,
  // purchase_unit). The TS field name `inventoryItemId` is kept for
  // back-compat but the value passed is a catalog_ingredients.id.
  return useInflight.getState().track(async (signal) => {
    await supabase.from('ingredient_conversions').upsert({
      catalog_id: conv.inventoryItemId,
      purchase_unit: conv.purchaseUnit,
      base_unit: conv.baseUnit,
      conversion_factor: conv.conversionFactor,
      net_yield_pct: conv.netYieldPct,
    }, { onConflict: 'catalog_id,purchase_unit' }).abortSignal(signal);
  }, { kind: 'write', label: 'upsertIngredientConversion' });
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
  return useInflight.getState().track(async (signal) => {
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
      .abortSignal(signal)
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
  }, { kind: 'write', label: 'createIngredientConversion' });
}

/** Update an existing conversion by id. Used by the inline edit UI on
 *  CatalogConversionsTab — purchase_unit / base_unit / factor / yield. */
export async function updateIngredientConversion(
  id: string,
  patch: Partial<Pick<IngredientConversion, 'purchaseUnit' | 'baseUnit' | 'conversionFactor' | 'netYieldPct'>>,
): Promise<IngredientConversion> {
  return useInflight.getState().track(async (signal) => {
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
      .abortSignal(signal)
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
  }, { kind: 'write', label: 'updateIngredientConversion' });
}

/** Delete a conversion row by id. Used by the row-level "delete" action
 *  on the conversions tab. */
export async function deleteIngredientConversion(id: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('ingredient_conversions')
      .delete()
      .eq('id', id)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'deleteIngredientConversion' });
}

// ─── VERSIONED PREP RECIPE UPDATE ───────────────────────────────────────
export async function updatePrepRecipeVersioned(id: string, updates: any): Promise<string> {
  return useInflight.getState().track(async (signal) => {
    // 1. Mark current version as not current
    await supabase.from('prep_recipes').update({ is_current: false }).eq('id', id).abortSignal(signal);

    // 2. Get the parent_id (or use current id as parent if it's the original)
    const { data: current } = await supabase
      .from('prep_recipes')
      .select('parent_id')
      .eq('id', id)
      .abortSignal(signal)
      .single();
    const parentId = current?.parent_id || id;

    // 3. Get current version number
    const { data: versions } = await supabase
      .from('prep_recipes')
      .select('version')
      .or(`id.eq.${parentId},parent_id.eq.${parentId}`)
      .order('version', { ascending: false })
      .limit(1)
      .abortSignal(signal);
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
        // Spec 040 P3: carry per-locale name overrides into the new version.
        // Versions are immutable historical snapshots in this codebase, so
        // each version preserves its own translation set. Falls back to `{}`
        // when the caller didn't pass i18nNames.
        i18n_names: updates.i18nNames ?? {},
      })
      .select()
      .abortSignal(signal)
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
        ).abortSignal(signal);
      }
    }

    return newRecipe.id;
  }, { kind: 'write', label: 'updatePrepRecipeVersioned' });
}

// ─── INGREDIENT CATEGORIES ──────────────────────────────────────────────
// Spec 040 P3: same shape upgrade as recipe categories (see comment above
// fetchRecipeCategories). Co-located write helpers accept an optional
// `i18nNames` so the form can land translations alongside the canonical
// English name in one save.
export async function fetchIngredientCategories(): Promise<
  Array<{ name: string; i18nNames: Record<string, string> }>
> {
  return useInflight.getState().track(async (signal) => {
    const { data } = await supabase
      .from('ingredient_categories')
      .select('name, i18n_names')
      .order('created_at')
      .abortSignal(signal);
    return (data || []).map((c: any) => ({
      name: c.name,
      i18nNames: (c.i18n_names ?? {}) as Record<string, string>,
    }));
  }, { kind: 'read', label: 'fetchIngredientCategories' });
}

export async function addIngredientCategory(
  name: string,
  i18nNames?: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase
      .from('ingredient_categories')
      .insert({ name, i18n_names: i18nNames ?? {} })
      .abortSignal(signal);
  }, { kind: 'write', label: 'addIngredientCategory' });
}

export async function updateIngredientCategory(
  oldName: string,
  newName: string,
  i18nNames?: Record<string, string>,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const dbUpdates: any = { name: newName };
    if (i18nNames !== undefined) dbUpdates.i18n_names = i18nNames;
    await supabase
      .from('ingredient_categories')
      .update(dbUpdates)
      .eq('name', oldName)
      .abortSignal(signal);
  }, { kind: 'write', label: 'updateIngredientCategory' });
}

export async function deleteIngredientCategory(name: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase
      .from('ingredient_categories')
      .delete()
      .eq('name', name)
      .abortSignal(signal);
  }, { kind: 'write', label: 'deleteIngredientCategory' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('pos_recipe_aliases')
      .select('pos_name, recipe_id, store_id')
      .or(`store_id.eq.${storeId},store_id.is.null`)
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchPosRecipeAliases:', error.message);
      return [];
    }
    return (data || []) as PosRecipeAlias[];
  }, { kind: 'read', label: 'fetchPosRecipeAliases' });
}

export async function upsertPosRecipeAliases(
  rows: { posName: string; recipeId: string; storeId: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  return useInflight.getState().track(async (signal) => {
    const payload = rows.map((r) => ({
      pos_name: r.posName.trim(),
      recipe_id: r.recipeId,
      store_id: r.storeId,
      last_used_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('pos_recipe_aliases')
      .upsert(payload, { onConflict: 'pos_name,store_id' })
      .abortSignal(signal);
    if (error) console.warn('[Supabase] upsertPosRecipeAliases:', error.message);
  }, { kind: 'write', label: 'upsertPosRecipeAliases' });
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
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('pos_recipe_aliases')
      .delete()
      .eq('store_id', storeId)
      .eq('pos_name', posName.trim())
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] deletePosRecipeAlias:', error.message);
      throw error;
    }
  }, { kind: 'write', label: 'deletePosRecipeAlias' });
}

// Past unmapped pos_import_items grouped by menu_item, for the review section
// in POSImportScreen. Last 30 days, current store only.
export async function fetchUnmappedPosImports(storeId: string): Promise<{ menu_item: string; count: number }[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('pos_import_items')
      .select('menu_item, pos_imports!inner(store_id, import_date)')
      .eq('recipe_mapped', false)
      .eq('pos_imports.store_id', storeId)
      .gte('pos_imports.import_date', since)
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchUnmappedPosImports' });
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
  return useInflight.getState().track(async (signal) => {
    const { data: imports, error: impErr } = await supabase
      .from('pos_imports').select('id')
      .eq('store_id', storeId)
      .gte('import_date', since)
      .abortSignal(signal);
    if (impErr || !imports || imports.length === 0) return 0;
    const importIds = imports.map((i: any) => i.id);
    const { error: updErr, count } = await supabase
      .from('pos_import_items')
      .update({ recipe_id: recipeId, recipe_mapped: true }, { count: 'exact' })
      .ilike('menu_item', posName)
      .eq('recipe_mapped', false)
      .in('import_id', importIds)
      .abortSignal(signal);
    if (updErr) {
      console.warn('[Supabase] applyAliasToPastImports:', updErr.message);
      return 0;
    }
    return count || 0;
  }, { kind: 'write', label: 'applyAliasToPastImports' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('report_definitions')
      .select('id, store_id, template_id, name, scope, params, created_by, created_at')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .abortSignal(signal);
    if (error) { console.warn('[Supabase] fetchSavedReports:', error.message); return []; }
    return (data || []).map(mapReportRow);
  }, { kind: 'read', label: 'fetchSavedReports' });
}

export async function createReportDefinition(
  rep: Omit<ReportDefinition, 'id' | 'createdAt'>,
): Promise<ReportDefinition | null> {
  return useInflight.getState().track(async (signal) => {
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
      .abortSignal(signal)
      .single();
    if (error) { console.warn('[Supabase] createReportDefinition:', error.message); return null; }
    return mapReportRow(data);
  }, { kind: 'write', label: 'createReportDefinition' });
}

export async function deleteReportDefinition(id: string): Promise<void> {
  if (!id || id.length < 10) return;
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('report_definitions')
      .delete()
      .eq('id', id)
      .abortSignal(signal);
    if (error) console.warn('[Supabase] deleteReportDefinition:', error.message);
  }, { kind: 'write', label: 'deleteReportDefinition' });
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
  return useInflight.getState().track(async (signal) => {
    const { data: envelope, error: rpcError } = await supabase.rpc('report_run', {
      p_template_id: args.templateId,
      p_store_id: args.storeId,
      p_params: params,
    }).abortSignal(signal);

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
      } else if (rawMessage.startsWith('Custom SQL')) {
        // Spec 037 — the report_run_custom runner's sanitization wall
        // already produces caller-safe strings (the seven §5 mapped
        // messages plus the 'Custom SQL requires admin privilege' gate
        // raise). Pass through verbatim so the user gets actionable
        // feedback instead of the generic "Run failed" toast.
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
      .abortSignal(signal)
      .single();
    if (insertError) {
      // Don't swallow — the caller's notifyBackendError needs to surface this
      // to the user; otherwise we'd silently lose the run row.
      throw insertError;
    }
    return mapReportRunRow(inserted);
  }, { kind: 'write', label: 'runReport' });
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
  return useInflight.getState().track(async (signal) => {
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

    const { data, error } = await query.abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchLatestRun:', error.message);
      return null;
    }
    if (!data || data.length === 0) return null;
    return mapReportRunRow(data[0]);
  }, { kind: 'read', label: 'fetchLatestRun' });
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

  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('report_reorder_list', {
      p_store_id: storeId,
      p_params: params,
    }).abortSignal(signal);

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
  }, { kind: 'read', label: 'fetchReorderSuggestions' });
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
        // Spec 088 — case-based ordering fields (additive on the report's
        // per-item JSON). `case_qty` is always present (1 = no case size);
        // `suggested_cases` is null when caseQty <= 1; `suggested_units` is
        // the server's ordered base-unit total (falls back to suggested_qty).
        caseQty: Number(it?.case_qty ?? 1),
        suggestedCases: it?.suggested_cases == null ? null : Number(it.suggested_cases),
        suggestedUnits: Number(it?.suggested_units ?? it?.suggested_qty ?? 0),
        flags: Array.isArray(it?.flags) ? it.flags.map((f: any) => String(f)) : [],
        // Spec 102 (OQ-1) — coincident-schedule "also from N" hint. Additive
        // keys on the per-item report object (envelope shape unchanged); 0/[]
        // for a single-vendor item so existing cards render exactly as before.
        // `also_from_vendors` already excludes THIS card's vendor server-side.
        otherVendorCount: Number(it?.other_vendor_count ?? 0),
        alsoFromVendors: Array.isArray(it?.also_from_vendors)
          ? it.also_from_vendors.map((av: any) => ({
              vendorId: String(av?.vendor_id ?? ''),
              vendorName: String(av?.vendor_name ?? ''),
            }))
          : [],
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

// ─── COUNTED-ON-HAND REORDER (Spec 105) ─────────────────────────────────
/**
 * Spec 105 — reorder math for a CALLER-SUPPLIED counted on-hand map, used by
 * the inventory-count history detail's below-par inline suggestion. Calls the
 * server-side `report_reorder_for_counted_onhand(p_store_id, p_on_hand, p_params)`
 * RPC (migration 20260702000000), which copies `report_reorder_list`'s
 * forecast/case/delivery CTEs verbatim but reads on-hand from the supplied
 * `{ itemId → countedTotal }` map and returns a FLAT item-keyed array (no
 * vendor grouping, no `$`/cost fields).
 *
 * The suggestion mixes this record's HISTORICAL counted on-hand with LIVE
 * usage-forecast + LIVE delivery timing ("what you'd order right now given
 * this count") — the FE caption surfaces both bases. `daysUntil` is the item's
 * SOONEST vendor.
 *
 * Returns a `Record<itemId, CountedReorderItem>` (NOT an array) so the detail
 * render loop can do `byItem[e.itemId]` per row without an O(entries × items)
 * scan. An item present in the request but ABSENT from the response means
 * "nothing to reorder" (`suggested_qty < 0.001` collapse) — the caller renders
 * the red par dot without a suggestion.
 *
 * `asOfDate` — optional YYYY-MM-DD override; the FE passes the store-local
 * "today" so the live forecast/timing is correct across time zones (same
 * contract as `fetchReorderSuggestions`). When omitted the RPC defaults to the
 * server's `current_date` (UTC).
 *
 * This is a READ. On error the caller degrades gracefully (the par ✓/red dot
 * needs no backend) rather than toast-spamming — so errors bubble up for the
 * caller's `.catch`, they are not swallowed here.
 */
export async function fetchReorderForCountedOnHand(
  storeId: string,
  onHandByItemId: Record<string, number>,   // { itemId: countedTotal }
  asOfDate?: string,
): Promise<Record<string, CountedReorderItem>> {
  const params: Record<string, unknown> = {};
  if (asOfDate) params.as_of_date = asOfDate;

  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('report_reorder_for_counted_onhand', {
      p_store_id: storeId,
      p_on_hand: onHandByItemId,
      p_params: params,
    }).abortSignal(signal);

    if (error) {
      // Don't swallow — the caller decides whether to surface (spec 105:
      // degrade to the par badges + omit the suggestion, no toast).
      throw error;
    }

    const envelope = (data || {}) as any;
    const byItem: Record<string, CountedReorderItem> = {};
    if (Array.isArray(envelope.items)) {
      for (const it of envelope.items) {
        const mapped = mapCountedReorderItem(it);
        if (mapped.itemId) byItem[mapped.itemId] = mapped;
      }
    }
    return byItem;
  }, { kind: 'read', label: 'fetchReorderForCountedOnHand' });
}

function mapCountedReorderItem(it: any): CountedReorderItem {
  return {
    itemId: String(it?.item_id ?? ''),
    onHand: Number(it?.on_hand ?? 0),
    parLevel: Number(it?.par_level ?? 0),
    parReplacement: Number(it?.par_replacement ?? 0),
    usageForecasted: Number(it?.usage_forecasted ?? 0),
    suggestedQty: Number(it?.suggested_qty ?? 0),
    // Case fields mirror mapReorderVendor's per-item block, MINUS cost:
    // caseQty always present (1 = no case size); suggestedCases is null when
    // caseQty <= 1; suggestedUnits is the server's ordered base-unit total.
    caseQty: Number(it?.case_qty ?? 1),
    suggestedCases: it?.suggested_cases == null ? null : Number(it.suggested_cases),
    suggestedUnits: Number(it?.suggested_units ?? it?.suggested_qty ?? 0),
    daysUntil: Number(it?.days_until ?? 0),
    nextDeliveryDate: String(it?.next_delivery_date ?? ''),
    scheduleKnown: Boolean(it?.schedule_known ?? false),
    flags: Array.isArray(it?.flags) ? it.flags.map((f: any) => String(f)) : [],
  };
}

// ─── WEEKLY LOW-STOCK (advisory) ─────────────────────────────────────────
//
// Spec 102 (§9) — the weekly full-store low-stock warning reads the
// `report_weekly_lowstock` RPC. The ONLY consumer is the staff WeeklyCount
// screen, which maps the envelope inline via its own `fetchLowStock`
// (src/screens/staff/screens/WeeklyCount.tsx) under the documented
// staff-subtree direct-`supabase.rpc` carve-out (CLAUDE.md). A db.ts mapper
// was authored during the design (§9/§10) but had ZERO callers — the staff
// screen never routed through it — so it was removed (spec 102 backend
// fix-pass, SF-1) rather than leave dead exported code + a second
// hand-maintained snake→camel mapper for the same envelope. If a future
// ADMIN surface needs the weekly low-stock data through the tracked db.ts
// chain, re-add the fetcher here (mirroring `fetchReorderSuggestions`) and
// point WeeklyCount at it for DRY. The `WeeklyLowStock` / `WeeklyLowStockItem`
// types stay in src/types/index.ts (consumed by the staff mapper).

// ─── MENU CAPACITY ──────────────────────────────────────────────────────
//
// Spec 060 — server-computed per-recipe capacity for the active store.
//
// The RPC walks the recipe BOM transitively through prep recipes and
// returns one row per recipe with `makeableQty` + the binding catalog
// ingredient (or NULL when the recipe has no BOM defined).
//
// Units are NOT normalized server-side — same posture as
// `report_run_variance` / `report_reorder_list`. The `hasUnitMismatch`
// flag surfaces recipes whose ingredient lines declare a unit string
// different from the catalog's; the UI qualifies the badge with `~`
// when set so the user knows the number is approximate.
//
// The `truncated` flag surfaces when the recursive prep DAG hit the
// depth-5 cap with unexplored graph remaining — the UI renders a `?`
// suffix. The depth cap is the project-standard cycle-protection
// mechanism (mirror of `report_run_variance_multivendor`).
//
// Shape (`MenuCapacityRow`) lives in `src/types/index.ts` next to
// `ReorderPayload` so the Zustand AppState slot can reference it
// without a circular import back to `db.ts`. We re-export it here
// for callers that grouped the type with the fetcher (architect's
// original design located the interface in `db.ts`).

export type { MenuCapacityRow };

export async function fetchMenuCapacity(
  storeId: string,
): Promise<MenuCapacityRow[]> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .rpc('compute_menu_capacity', { p_store_id: storeId })
      .abortSignal(signal);

    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    return rows.map((r: any): MenuCapacityRow => ({
      recipeId:           String(r?.recipe_id ?? ''),
      storeId:            String(r?.store_id ?? storeId),
      hasRecipe:          Boolean(r?.has_recipe ?? false),
      makeableQty:        r?.makeable_qty == null ? null : Number(r.makeable_qty),
      bindingCatalogId:   r?.binding_catalog_id ? String(r.binding_catalog_id) : null,
      bindingCatalogName: r?.binding_catalog_name == null ? null : String(r.binding_catalog_name),
      bindingShortfall:   r?.binding_shortfall == null ? null : Number(r.binding_shortfall),
      lowIngredientCount: Number(r?.low_ingredient_count ?? 0),
      hasUnitMismatch:    Boolean(r?.has_unit_mismatch ?? false),
      truncated:          Boolean(r?.truncated ?? false),
    }));
  }, { kind: 'read', label: 'fetchMenuCapacity' });
}

// ─── BRAND + CATALOG ────────────────────────────────────────────────────
/**
 * Resolve the brand a store belongs to. Single-tenant for now (one
 * brand). When this returns null, the caller should fall back to the
 * first row of `brands` (defensive — a store should always have a
 * brand_id post-migration).
 */
export async function fetchBrandForStore(storeId: string): Promise<{ id: string; name: string } | null> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('stores')
      .select('brand:brands(id, name)')
      .eq('id', storeId)
      .abortSignal(signal)
      .single();
    if (error || !data?.brand) return null;
    // PostgREST 1:1 join shape (single object) — but supabase-js typings
    // sometimes infer it as an array; coerce defensively.
    const b: any = Array.isArray(data.brand) ? data.brand[0] : data.brand;
    return b ? { id: b.id, name: b.name } : null;
  }, { kind: 'read', label: 'fetchBrandForStore' });
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
  return useInflight.getState().track(async (signal) => {
    let query = supabase.from('brands').select('id, name, deleted_at, created_at').order('name', { ascending: true });
    if (!opts?.includeSoftDeleted) {
      query = query.is('deleted_at', null);
    }
    const { data, error } = await query.abortSignal(signal);
    if (error) throw error;
    return (data || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      deletedAt: b.deleted_at ?? null,
      createdAt: b.created_at ?? null,
    }));
  }, { kind: 'read', label: 'fetchBrandsLite' });
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
  return useInflight.getState().track(async (signal) => {
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
    const { data, error } = await primary.abortSignal(signal);
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
      const fallback = await fb.abortSignal(signal);
      if (fallback.error) throw fallback.error;
      return mapBrandStats(fallback.data || []);
    }
    return mapBrandStats(data || []);
  }, { kind: 'read', label: 'fetchBrandsWithStats' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('brands')
      .insert({ name: trimmed })
      .select('id, name, deleted_at, created_at')
      .abortSignal(signal)
      .single();
    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      deletedAt: data.deleted_at ?? null,
      createdAt: data.created_at ?? null,
    };
  }, { kind: 'write', label: 'createBrand' });
}

// Clone every row in `catalog_ingredients` from `sourceBrandId` into
// `targetBrandId`. ON CONFLICT (brand_id, lower(name)) DO NOTHING, so
// re-running on a partially-populated target only inserts the missing
// rows. Server-side RPC enforces privileged-role gate and visibility on
// both brands. Returns the count of rows inserted.
export async function copyBrandCatalog(sourceBrandId: string, targetBrandId: string): Promise<number> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('copy_brand_catalog', {
      p_source_brand_id: sourceBrandId,
      p_target_brand_id: targetBrandId,
    }).abortSignal(signal);
    if (error) throw error;
    return typeof data === 'number' ? data : 0;
  }, { kind: 'write', label: 'copyBrandCatalog' });
}

// ─── CROSS-BRAND ROW COPY (Spec 049) ────────────────────────────────
//
// Per-row variant of the whole-catalog `copyBrandCatalog` above. The
// caller selects N source rows (by id) from one brand and copies them
// into another brand. Super-admin only; skip-on-conflict semantics
// match the whole-catalog precedent. Server-side RPC writes one
// audit_log row in the target brand per successful call.

export type CatalogCopyTable = 'catalog_ingredients' | 'vendors';

export interface CopyCatalogResult {
  /** Count of rows that landed in the target brand. */
  copied: number;
  /** Count of source rows skipped due to (brand_id, lower(name)) conflict. */
  skipped: number;
  /** First N (≤ 20) of the skipped source row names, for a precise toast. */
  skippedNames: string[];
}

export async function copyCatalogRows(
  sourceBrandId: string,
  targetBrandId: string,
  table: CatalogCopyTable,
  sourceIds: string[],
): Promise<CopyCatalogResult> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('copy_catalog_rows', {
      p_source_brand_id: sourceBrandId,
      p_target_brand_id: targetBrandId,
      p_table:           table,
      p_source_ids:      sourceIds,
    }).abortSignal(signal);
    if (error) throw error;
    // PostgREST unwraps the composite type into a single object. Tolerate
    // null/missing fields defensively in case of an empty-selection edge
    // case where the RPC returns the (0, 0, '{}') short-circuit row.
    const row = (data ?? {}) as {
      copied?: number;
      skipped?: number;
      skipped_names?: string[] | null;
    };
    return {
      copied: row.copied ?? 0,
      skipped: row.skipped ?? 0,
      skippedNames: row.skipped_names ?? [],
    };
  }, { kind: 'write', label: 'copyCatalogRows' });
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
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase.rpc('rename_brand', {
      p_brand_id: brandId,
      p_new_name: trimmed,
    }).abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'renameBrand' });
}

/** Spec 012c §2.2 — soft-delete a brand. Returns the assigned
 *  `deleted_at` ISO string. Idempotent: re-calling on an already
 *  soft-deleted brand returns the prior timestamp without writing
 *  a new audit row. */
export async function softDeleteBrand(brandId: string): Promise<string> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('soft_delete_brand', {
      p_brand_id: brandId,
    }).abortSignal(signal);
    if (error) throw error;
    return data as string;
  }, { kind: 'write', label: 'softDeleteBrand' });
}

/** Spec 012c §2.3 — restore a soft-deleted brand. Server-side blocks
 *  the call past the 30-day grace window with a clear EXCEPTION
 *  message that the UI surfaces via notifyBackendError. */
export async function restoreBrand(brandId: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase.rpc('restore_brand', { p_brand_id: brandId }).abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'restoreBrand' });
}

/** Spec 012c §2.4 — preview the cascade. Returns per-table row counts
 *  AND the blocking-profiles array (Q-USER-A hard-blocker). The
 *  CascadePreviewModal renders the red error block when
 *  `blockingProfiles.length > 0`. */
export async function previewBrandCascade(brandId: string): Promise<BrandCascadePreview> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('preview_brand_cascade', {
      p_brand_id: brandId,
    }).abortSignal(signal);
    if (error) throw error;
    return mapCascadePreview(data);
  }, { kind: 'read', label: 'previewBrandCascade' });
}

/** Spec 012c §2.5 — irreversible cascade. Server-side enforces both
 *  pre-flights (must be soft-deleted; must have zero attached
 *  profiles). Returns the at-execution cascade snapshot for the
 *  caller's success toast. */
export async function hardDeleteBrand(brandId: string): Promise<BrandCascadePreview> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase.rpc('hard_delete_brand', {
      p_brand_id: brandId,
    }).abortSignal(signal);
    if (error) throw error;
    return mapCascadePreview(data);
  }, { kind: 'write', label: 'hardDeleteBrand' });
}

/** Spec 012c §5 — read the brand_deletion_log audit table. Super-admin
 *  only via RLS. Optional brandId filter for the per-brand history;
 *  default returns the global tail (most recent first). */
export async function fetchBrandDeletionLog(
  opts?: { brandId?: string; limit?: number },
): Promise<BrandDeletionLogEntry[]> {
  return useInflight.getState().track(async (signal) => {
    let q = supabase
      .from('brand_deletion_log')
      .select('id, brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload, created_at')
      .order('created_at', { ascending: false })
      .limit(opts?.limit ?? 100);
    if (opts?.brandId) q = q.eq('brand_id', opts.brandId);
    const { data, error } = await q.abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchBrandDeletionLog' });
}

/** Spec 050 — demote an admin/master profile to user AND clear
 *  `brand_id`. Wraps `public.demote_profile_to_user(target_user_id uuid)`
 *  (supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql) so
 *  the server is the authoritative gate for `caller.id != target.id`.
 *  The RPC reads `auth.uid()` internally (no caller_id passed from the
 *  client — defense against forgery) and refuses with SQLSTATE P0001
 *  message `'cannot demote self'` if the caller targets their own row.
 *  The role gate is enforced inline via `auth_is_privileged()` because
 *  SECURITY DEFINER bypasses RLS — see the migration header for the
 *  full ordering.
 *
 *  Errors surface via notifyBackendError as a PostgrestError with the
 *  stable refusal string. Sibling guard: `'cannot delete self'` at
 *  supabase/functions/delete-user/index.ts:168-173. */
export async function demoteProfileToUser(profileId: string): Promise<string> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .rpc('demote_profile_to_user', { target_user_id: profileId })
      .abortSignal(signal);
    if (error) throw error;
    return data as string;
  }, { kind: 'write', label: 'demoteProfileToUser' });
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

  return useInflight.getState().track(async (signal) => {
  const [profilesRes, invitesRes, storesRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: true })
      .abortSignal(signal),
    supabase
      .from('invitations')
      // Spec 082: NO `used` filter here — email inference must source from
      // ALL invitations (a registered user's invite is used=true); the `!used`
      // subset is applied below, only for the pending rows.
      // Spec 084: NO `.eq('brand_id', brandId)` either — a NULL-brand invitation
      // would otherwise be hidden from inference (the symmetric blind spot to
      // spec 083's fetchInvitationsForUserLookup). The per-row profile_id/name
      // match below scopes inference to the correct person; the brand scope of
      // the PENDING rows is re-applied in-memory at `pendingInvites` (strict
      // inv.brand_id === brandId) so a NULL-brand UNCONSUMED invite never leaks
      // in as a phantom pending row for a brand it doesn't belong to.
      // Spec 095 — `username` carries the admin-assigned username for pending
      // invite rows so the Brands members tab can display it pre-registration.
      .select('id, email, name, role, store_ids, brand_id, used, expires_at, profile_id, username')
      .abortSignal(signal),
    supabase
      .from('stores')
      .select('id')
      .eq('brand_id', brandId)
      .abortSignal(signal),
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
      .in('user_id', userIds)
      .abortSignal(signal);
    storeLinks = links || [];
  }

  // Spec 082 — profiles has no email column; we infer each user's email
  // from the invitation row that registered them. Maps are built from ALL
  // invitations (the query no longer filters used=false — spec 082 — and as
  // of spec 084 no longer filters by brand_id either; see comment above), so
  // a used or NULL-brand invite still feeds inference.
  // Precedence below (inviteByProfileId ?? inviteByName): id-match wins.
  // profile_id is set by consume_invitation on accept as of spec 082, and
  // legacy (pre-082) rows are linked by the spec-082 backfill, so the
  // id-match path now does real work and prevents two admins sharing a
  // display name from getting swapped emails. name-match remains the
  // fallback for any invite whose profile_id is still the
  // '00000000-…' sentinel (unbackfillable — e.g. its auth user was
  // deleted, or never-registered pending invites).
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
      // Spec 095 — surface the assigned username in the Brands members tab.
      username: p.username ?? null,
    } as User;
  });

  // Outstanding invitations: synthetic User rows with status='pending'.
  // Spec 082: source ONLY the unconsumed (!used) invites here so a
  // consumed invite never becomes a phantom pending row. (Email inference
  // above still uses ALL invites.) Then skip ones already represented in
  // profiles (matched by email) — consumed-for-active rows are excluded on
  // two grounds now: they're !used-filtered out AND active rows finally
  // have emails to dedup against.
  // Spec 084: gate the pending ROW on the brand too. Inference (above) reads ALL
  // invites; the synthetic pending list must stay brand-scoped or a NULL-brand
  // (or foreign-brand) UNCONSUMED invite would surface as a phantom pending row.
  // Strict equality: `null === brandId` is false, so NULL-brand invites are
  // excluded from EVERY brand (there is no "no-brand" bucket in the Brands tab).
  const pendingInvites = invites.filter(
    (inv: any) => !inv.used && inv.brand_id === brandId,
  );
  const activeEmails = new Set(activeRows.map((u) => u.email.toLowerCase()).filter(Boolean));
  const pendingRows: User[] = pendingInvites
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
      // Spec 095 — pending invites may carry an admin-assigned username.
      username: inv.username ?? null,
    }));

  return [...activeRows, ...pendingRows];
  }, { kind: 'read', label: 'fetchBrandAdmins' });
}

export async function fetchCatalogIngredients(brandId: string) {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('catalog_ingredients')
      .select('*')
      .eq('brand_id', brandId)
      .order('name', { ascending: true })
      .abortSignal(signal);
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
      // Spec 040 P3: per-locale name overrides on the catalog row. Shape
      // {"es"?, "zh-CN"?}. Falls back to `{}` when the column is missing or
      // unpopulated.
      i18nNames: (c.i18n_names ?? {}) as Record<string, string>,
    }));
  }, { kind: 'read', label: 'fetchCatalogIngredients' });
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
  return useInflight.getState().track(async (signal) => {
    const row: Record<string, unknown> = {};
    if (patch.defaultShelfLifeDays !== undefined) {
      row.default_shelf_life_days = patch.defaultShelfLifeDays;
    }
    if (Object.keys(row).length === 0) return;
    row.updated_at = new Date().toISOString();
    const { error } = await supabase
      .from('catalog_ingredients')
      .update(row)
      .eq('id', catalogId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'updateCatalogIngredient' });
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
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('order_schedule')
      .select('*')
      .eq('store_id', storeId)
      .abortSignal(signal);
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
  }, { kind: 'read', label: 'fetchOrderSchedule' });
}

// Spec 081 — cross-store sibling of fetchOrderSchedule (above). The single-store
// version returns a weekday-keyed Record with NO store dimension, so the
// Dashboard attention-queue can't tell one store's schedule from another's
// (the bug spec 081 fixes). This returns a STORE-keyed map of those same
// weekday-keyed schedules so each store card can be passed its own slice
// (byStore[s.id]) into computeAttentionQueue.
//
// Single-trip IN(...) select; RLS (auth_can_see_store on order_schedule —
// per order_schedule_super_admin_rls.sql:24-26) silently drops rows the caller
// can't see, so we don't pre-filter storeIds — same posture as
// fetchEodSubmissionsForStores / fetchPosImportsForStores. Returns {} on empty
// input or PostgREST error (degrade, don't throw — unlike the single-store
// fetchOrderSchedule, the cross-store caller must keep the Dashboard rendering
// its other rules rather than crash). The per-vendor object shape
// (vendorId/vendorName/deliveryDay) mirrors fetchOrderSchedule exactly.
export async function fetchOrderScheduleForStores(
  storeIds: string[],
): Promise<Record<string, OrderSchedule>> {
  if (storeIds.length === 0) return {};
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .from('order_schedule')
      .select('*')
      .in('store_id', storeIds)
      .abortSignal(signal);
    if (error) {
      console.warn('[Supabase] fetchOrderScheduleForStores:', error.message);
      return {};
    }
    const byStore: Record<string, OrderSchedule> = {};
    (data || []).forEach((row: any) => {
      const sid = row.store_id;
      if (!byStore[sid]) byStore[sid] = {};
      const schedule = byStore[sid];
      if (!schedule[row.day_of_week]) schedule[row.day_of_week] = [];
      schedule[row.day_of_week].push({
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        deliveryDay: row.delivery_day,
      });
    });
    return byStore;
  }, { kind: 'read', label: 'fetchOrderScheduleForStores' });
}

export async function saveOrderSchedule(storeId: string, day: string, vendors: any[]): Promise<void> {
  // Delete existing entries for this store+day, then insert new ones
  return useInflight.getState().track(async (signal) => {
    await supabase
      .from('order_schedule')
      .delete()
      .eq('store_id', storeId)
      .eq('day_of_week', day)
      .abortSignal(signal);
    if (vendors.length > 0) {
      await supabase.from('order_schedule').insert(
        vendors.map((v: any) => ({
          store_id: storeId,
          day_of_week: day,
          vendor_id: v.vendorId || null,
          vendor_name: v.vendorName,
          delivery_day: v.deliveryDay,
        }))
      ).abortSignal(signal);
    }
  }, { kind: 'write', label: 'saveOrderSchedule' });
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
  return useInflight.getState().track(async (signal) => {
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
      })
      .abortSignal(signal);
    // 23505 = unique_violation = the (store, day, vendor) cell is already
    // scheduled. Treat as idempotent no-op so double-clicks and stale
    // optimistic state don't surface as backend errors.
    if (error && (error as any).code !== '23505') throw error;
  }, { kind: 'write', label: 'addOrderScheduleEntry' });
}

// Spec 007 §3b — per-cell remove. Idempotent: deleting a non-existent
// (store, day, vendor) row returns no error and zero affected rows.
export async function removeOrderScheduleEntry(
  storeId: string,
  day: string,
  vendorId: string,
): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    const { error } = await supabase
      .from('order_schedule')
      .delete()
      .eq('store_id', storeId)
      .eq('day_of_week', day)
      .eq('vendor_id', vendorId)
      .abortSignal(signal);
    if (error) throw error;
  }, { kind: 'write', label: 'removeOrderScheduleEntry' });
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

  return useInflight.getState().track(async (signal) => {
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
      safe('eod_submissions', supabase.from('eod_submissions').delete().lt('submitted_at', cutoffISO).abortSignal(signal)),
      // Waste log
      safe('waste_log', supabase.from('waste_log').delete().lt('logged_at', cutoffISO).abortSignal(signal)),
      // Audit log
      safe('audit_log', supabase.from('audit_log').delete().lt('created_at', cutoffISO).abortSignal(signal)),
      // POS imports (child rows cascade) — column is imported_at, not created_at
      safe('pos_imports', supabase.from('pos_imports').delete().lt('imported_at', cutoffISO).abortSignal(signal)),
      // Order submissions
      safe('purchase_orders', supabase.from('purchase_orders').delete().lt('created_at', cutoffISO).abortSignal(signal)),
      // Expired invitations
      safe('invitations', supabase.from('invitations').delete().lt('expires_at', nowISO).eq('used', false).abortSignal(signal)),
    ]);
  }, { kind: 'write', label: 'cleanupOldRecords' });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────
// Spec 040 P3: mapItem now hydrates `i18nNames` from the joined
// catalog_ingredients.i18n_names JSONB column. The return type is widened
// from `InventoryItem` to `InventoryItem & { i18nNames: Record<string,
// string> }` via the intersection so the new field is visible to callers
// without modifying src/types/index.ts (the frontend dev's lane in spec
// 040). When the canonical type adds i18nNames, the intersection becomes
// a structural no-op and this can revert to the plain type.
function mapItem(row: any): InventoryItem & { i18nNames: Record<string, string> } {
  // Catalog fields (name/unit/category/case_qty/sub_unit_*) live on
  // catalog_ingredients; hydrated via the JOIN aliased as `catalog`.
  // Per-store fields (cost_per_unit, case_price, current_stock, par_level,
  // vendor_id, eod_remaining, etc.) stay on inventory_items.
  const cat = row.catalog || {};
  const caseQty = parseFloat(cat.case_qty) || 1;
  const subUnitSize = parseFloat(cat.sub_unit_size) || 1;
  // Spec 102 (§6a) — the item_vendors link set (per-(item,vendor) cost +
  // case price + the derived is_primary mirror). The scalar vendorId /
  // vendorName below stay the PRIMARY pointer (SD-1) for back-compat with
  // every current consumer; `vendors[]` is the full link set and
  // `vendorIds` the derived membership array the EOD tab filter + the
  // submit-EOD optimistic guard (frontend phase) read. An item with no
  // links → vendors: [], vendorIds: [] → renders exactly as today (absent
  // from every vendor tab). The embed is aliased `item_vendors` and each
  // row nests `vendor:vendors(id, name)`.
  const vendorLinks: Array<{
    vendorId: string;
    vendorName: string;
    costPerUnit: number;
    casePrice: number;
    isPrimary: boolean;
  }> = Array.isArray(row.item_vendors)
    ? row.item_vendors.map((lv: any) => ({
        vendorId: lv.vendor_id || lv.vendor?.id || '',
        vendorName: lv.vendor?.name || '',
        costPerUnit: parseFloat(lv.cost_per_unit) || 0,
        casePrice: parseFloat(lv.case_price) || 0,
        isPrimary: Boolean(lv.is_primary),
      }))
    : [];
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
      // Spec 104: when cost_per_unit is 0 (the migration's population 'X' —
      // a row NOT flipped), the live per-each cost comes from THIS fallback.
      // It is the per-EACH cost = case_price / (caseQty × subUnitSize), via
      // the same `piecesPerCase` single-source the migration and calcUnitCost
      // use, so the fallback and the stored basis agree. This reverses the
      // spec-093 fallback (case_price / case_qty); the consumer `× subUnitSize`
      // bridge then reconstructs case_price / case_qty (= cost_old) for the row.
      const pieces = piecesPerCase(caseQty, subUnitSize);
      return cp > 0 && pieces > 0 ? cp / pieces : 0;
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
    // Spec 040 P3: per-locale name overrides hydrated from
    // catalog_ingredients.i18n_names. Falls back to {} when the embed is
    // absent (e.g. older test fixtures that don't include i18n_names in
    // the select projection). Keys: 'es', 'zh-CN'. English canonical lives
    // in `name` above and is never written here.
    i18nNames: (cat.i18n_names ?? {}) as Record<string, string>,
    // Spec 102 (§6a) — full per-vendor link set + derived membership array.
    vendors: vendorLinks,
    vendorIds: vendorLinks.map((v) => v.vendorId).filter((id) => id.length > 0),
  };
}
