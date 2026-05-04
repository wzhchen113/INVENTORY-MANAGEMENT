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
 *     recipes, prep_recipes, vendors. After the brand catalog refactor
 *     these are no longer scoped to a store, so we listen brand-wide.
 *
 * When any tracked table changes, calls onSync so the app can reload.
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
      .subscribe();

    const brandChannel = brandId
      ? supabase
          .channel(`brand-${brandId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'prep_recipes', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'catalog_ingredients', filter: `brand_id=eq.${brandId}` }, onSync)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'vendors', filter: `brand_id=eq.${brandId}` }, onSync)
          .subscribe()
      : null;

    return () => {
      supabase.removeChannel(storeChannel);
      if (brandChannel) supabase.removeChannel(brandChannel);
    };
  }, [storeId, brandId, onSync]);
}
