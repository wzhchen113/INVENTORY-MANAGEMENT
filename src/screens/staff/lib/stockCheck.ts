// src/screens/staff/lib/stockCheck.ts — Spec 200 (AC-20, security-auditor
// Medium fix).
//
// The all-borrowed exception (R8) sends VERBATIM copies of another vendor's
// numeric counts, and the server writer sets `current_stock` from every
// numeric entry it writes. Without a check, that would reset on-hand to the
// borrowed count even if stock changed after that count (PO receiving, the
// auto-receive cron, a manual adjustment, an admin edit). The screen reads
// the copied items' live `current_stock` right before building the copies
// and only sends a copy whose count still equals it (see
// `stockMismatchIds` in ./borrowedEntries.ts).
//
// Its own module (like borrowSources.ts) for a clean jest mock seam. Staff
// carve-out: a direct supabase read, scoped to the active store, under the
// caller's JWT (inventory_items SELECT is store-scoped). It THROWS on error;
// the screen fails closed (no copies) and calls notifyBackendError.

import { supabase } from '../../../lib/supabase';

/** item id → `current_stock` exactly as PostgREST returned it (a numeric may
 *  arrive as a number or a string; null stays null). An id missing from the
 *  map was not readable at this store. */
export async function fetchCurrentStock(
  storeId: string,
  itemIds: readonly string[],
): Promise<Map<string, number | string | null>> {
  const out = new Map<string, number | string | null>();
  if (itemIds.length === 0) return out;
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, current_stock')
    .eq('store_id', storeId)
    .in('id', [...itemIds]);
  if (error) throw error;
  for (const r of (data ?? []) as { id: string; current_stock: number | string | null }[]) {
    out.set(r.id, r.current_stock);
  }
  return out;
}
