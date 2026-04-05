// src/hooks/useRealtimeSync.ts
import { useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Subscribes to Supabase Realtime changes for the given store.
 * When any tracked table changes, calls onSync so the app can reload data.
 * This enables real-time sync across web, iOS, and Android.
 */
export function useRealtimeSync(storeId: string | undefined, onSync: () => void) {
  useEffect(() => {
    if (!storeId) return;

    const channel = supabase
      .channel(`store-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prep_recipes', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waste_log', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_orders', filter: `store_id=eq.${storeId}` }, onSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'eod_submissions', filter: `store_id=eq.${storeId}` }, onSync)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [storeId, onSync]);
}
