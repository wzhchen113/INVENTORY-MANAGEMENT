// src/screens/staff/lib/countLayouts.ts — staff READ-ONLY store-layout I/O (carve-out).
//
// Spec 110 §6. The staff subtree uses the documented direct-`supabase` carve-out
// (CLAUDE.md "DB access centralized" — the whole staff subtree may call
// `supabase.from/rpc` directly, like the EOD fetch helpers in EODCount.tsx +
// fetchReorder.ts + the spec-103 countOrder carve-out + the spec-106 countDrafts
// carve-out). So the READ of the SAME `public.store_count_layouts` table the
// admin path lists via `src/lib/db.ts:fetchStoreCountLayouts` is authored here a
// SECOND time — intentionally. The carve-out is about the I/O call site, NOT the
// pure logic: the ordering algorithm (applyCountOrder / firstUncounted) is
// RE-EXPORTED from `src/lib/countOrder.ts` so the only logic worth testing stays
// single-sourced (design §6), and the staff Weekly screen imports the ENTIRE
// pick surface from this one staff-local module.
//
// READ-ONLY BY DESIGN (OQ-1 / AC-3b). The staff Weekly screen is PICK-ONLY —
// staff NEVER create/rename/delete a layout. There is deliberately NO write
// helper here (no save/rename/delete): a staff attempt to write would have to
// hand-roll an RPC call, which the RLS/RPC role gate (auth_is_privileged) refuses
// server-side anyway. The store's SELECT RLS gate (auth_can_see_store) lets a
// staff-role member READ the store's layouts (AC-3), which is all this file does.
//
// This file mirrors the admin fetchStoreCountLayouts contract byte-for-byte:
//   - fetchStoreCountLayouts → the store's 0..3 layouts ordered by position, or
//                              [] when none exist / the store is not visible
//                              (RLS returns 0 rows — the no-layout state, NOT an
//                              error → the pill row shows Default only).
// A genuine error throws (PostgREST error) so the screen degrades to Default +
// notifies via the staff notifyBackendError — same posture as the countOrder /
// countDrafts carve-outs. No `useInflight.track()` (that's the admin path); plain
// `await`.

import { supabase } from '../../../lib/supabase';

// Re-export the pure helpers so the staff Weekly screen imports the ENTIRE
// pick surface (apply logic + read I/O) from one staff-local module — the pure
// logic transparently re-exported from src/lib/countOrder, the read I/O authored
// here (same shape as staff/lib/countOrder.ts).
export { applyCountOrder, firstUncounted } from '../../../lib/countOrder';

/** Same camelCase shape as the admin `StoreCountLayout` (src/lib/db.ts). Authored
 *  here (not imported) to keep the staff subtree's type surface self-contained,
 *  matching how countDrafts.ts re-declares its local shapes. */
export type StoreCountLayout = {
  id: string;
  name: string;
  itemIds: string[]; // from item_ids jsonb array
  position: number; // from position smallint (1..3)
  updatedAt: string; // from updated_at (ISO)
};

/**
 * READ (on screen open / active-store change). Returns the store's 0..3 layouts
 * ordered by `position` (the stable left-to-right pill order), or `[]` when none
 * exist or the store is not visible to the caller (RLS returns 0 rows — the
 * no-layout state, NOT an error). A genuine error throws; the caller degrades to
 * Default and surfaces via the staff notifyBackendError. item_ids is a JSONB
 * array of strings; updated_at is camelCased inline to updatedAt.
 */
export async function fetchStoreCountLayouts(
  storeId: string,
): Promise<StoreCountLayout[]> {
  const { data, error } = await supabase
    .from('store_count_layouts')
    .select('id,name,item_ids,position,updated_at')
    .eq('store_id', storeId)
    .order('position');
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    itemIds: (row.item_ids ?? []) as string[],
    position: row.position as number,
    updatedAt: row.updated_at as string,
  }));
}
