// src/screens/staff/lib/itemsUpdated.ts — spec 128.
//
// "Updated" badge data source. Calls the `staff_items_updated` RPC (spec 128
// §3) for the active store and returns the SET of inventory-item ids whose
// product effectively changed (photo or primary vendor) since that store last
// counted them. The count screens merge this onto each row as `updated`.
//
// Best-effort by contract (design §6): the badge is a nice-to-have overlay, so
// ANY failure — RLS error, offline, missing RPC — degrades to an EMPTY set and
// never blocks the count list. Errors are surfaced through the staff error sink
// (console.warn + toast) but swallowed here so the caller always resolves.
//
// Staff carve-out (spec 063): direct `supabase.rpc`, same posture as
// `fetchLowStock` / `fetchReorder`.

import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from './notifyBackendError';

type UpdatedRow = {
  item_id?: string | null;
  updated?: boolean | null;
};

/**
 * Set of inventory-item ids that are "updated" for the given store. Empty on
 * any error (best-effort — never throws, never blocks the count screen).
 */
export async function fetchUpdatedItemIds(storeId: string): Promise<Set<string>> {
  try {
    const { data, error } = await supabase.rpc('staff_items_updated', {
      p_store_id: storeId,
    });
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as UpdatedRow[];
    const out = new Set<string>();
    for (const r of rows) {
      const id = r?.item_id;
      if (id && r?.updated === true) out.add(String(id));
    }
    return out;
  } catch (err) {
    notifyBackendError('fetchUpdatedItemIds', err);
    return new Set<string>();
  }
}
