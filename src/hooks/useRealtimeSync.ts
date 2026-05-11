// src/hooks/useRealtimeSync.ts
import { useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Subscribes to Supabase Realtime changes for the given store AND brand.
 *
 * Two channels:
 *   - `store-{storeId}` — per-store state: inventory_items, eod_submissions,
 *     waste_log.
 *   - `brand-{brandId}` — brand-shared catalog: catalog_ingredients,
 *     recipes, prep_recipes, vendors, ingredient_conversions. After the
 *     brand catalog refactor these are no longer scoped to a store, so
 *     we listen brand-wide.
 *
 * When any tracked table changes, calls onSync so the app can reload.
 *
 * Note on ingredient_conversions: there is no brand_id column on this
 * table — scope is inherited via catalog_id → catalog_ingredients.brand_id.
 * PostgREST realtime filters can't follow FKs, so we subscribe with no
 * filter. The 400ms debounce in the caller cushions any cross-brand noise.
 * Revisit if multi-brand support lands.
 */
export function useRealtimeSync(
  storeId: string | undefined,
  onSync: () => void,
  brandId?: string,
) {
  useEffect(() => {
    if (!storeId) return;

    const storeChannel = supabase
      .channel(`store-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waste_log', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'eod_submissions', filter: `store_id=eq.${storeId}` }, onSync)
      // Spec 019 — inventory_counts intentionally NOT on this channel.
      // The section owns its own per-store subscription (architect §7
      // Option A), and the global `onSync` would otherwise trigger a
      // no-op `loadFromSupabase` on every count insert (no store slice
      // consumes counts).
      .subscribe();

    const brandChannel = brandId
      ? supabase
          .channel(`brand-${brandId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'prep_recipes', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'catalog_ingredients', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'vendors', filter: `brand_id=eq.${brandId}` }, onSync)
          // ingredient_conversions: no brand_id column; scope inherited
          // via catalog_id FK. PostgREST realtime can't follow FKs, so no
          // filter — debounce in the caller absorbs cross-brand noise.
          .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredient_conversions' }, onSync)
          .subscribe()
      : null;

    return () => {
      supabase.removeChannel(storeChannel);
      if (brandChannel) supabase.removeChannel(brandChannel);
    };
  }, [storeId, brandId, onSync]);
}
