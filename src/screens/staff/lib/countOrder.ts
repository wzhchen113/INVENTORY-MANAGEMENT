// src/screens/staff/lib/countOrder.ts — staff per-user count-order I/O (carve-out).
//
// Spec 103 §5.3. The staff subtree uses the documented direct-`supabase`
// carve-out (CLAUDE.md "DB access centralized" — the whole staff subtree may
// call `supabase.from/rpc` directly, like the EOD fetch helpers in
// EODCount.tsx + fetchReorder.ts). So the read/save/reset of the SAME
// `public.user_count_orders` table the admin path touches via
// `src/lib/db.ts:fetchCountOrder/saveCountOrder/resetCountOrder` is authored
// here a SECOND time — intentionally. The carve-out is about the I/O call
// sites, NOT the ordering algorithm: the pure `applyCountOrder`/`firstUncounted`
// are imported from `src/lib/countOrder.ts` so the only logic worth testing
// stays single-sourced (design §5 / §14).
//
// This file mirrors the admin helpers' contract byte-for-byte:
//   - fetchCountOrder → the saved id array, or null when no row exists.
//   - saveCountOrder  → delete-then-insert the full ordered array for the one
//                       (user, screen, vendor?) key. PostgREST's `.upsert({
//                       onConflict })` CANNOT target the two PARTIAL unique
//                       indexes (it can't supply their WHERE predicate → 42P10),
//                       so the persist is delete + insert; the partial indexes
//                       stay purely as the duplicate guard (design §1.2).
//   - resetCountOrder → delete the one (user, screen, vendor?) row.
// Errors throw (PostgREST error) so the screen reverts + notifies via the
// staff notifyBackendError — same posture as fetchReorder. No
// `useInflight.track()` (that's the admin path); plain `await`.

import { supabase } from '../../../lib/supabase';
import type { CountOrderScreen } from '../../../lib/countOrder';

// Re-export the pure helpers + the screen-key type so the staff screens import
// the ENTIRE count-order surface from one staff-local module (the pure logic
// transparently re-exported from src/lib/countOrder, the I/O authored here).
export { applyCountOrder, firstUncounted } from '../../../lib/countOrder';
export type { CountOrderScreen } from '../../../lib/countOrder';

/**
 * READ (on screen open / vendor change). Returns the saved ordered id array,
 * or `null` when no row exists (→ the screen renders its default order).
 *
 * `vendorId` is the vendor id for the per-vendor staff-eod surface, or `null`
 * for the per-surface staff-weekly surface. PostgREST distinguishes
 * `.eq('vendor_id', v)` from `.is('vendor_id', null)` (`.eq` against null does
 * not match), so the read branches on vendor presence.
 *
 * A zero-row result is NOT an error — it is the no-custom-order state. A
 * genuine error throws; the caller falls back to the default order and
 * surfaces via the staff notifyBackendError (AC-7: the screen still renders).
 */
export async function fetchCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
): Promise<string[] | null> {
  let query = supabase
    .from('user_count_orders')
    .select('item_ids')
    .eq('user_id', userId)
    .eq('screen', screen);
  query = vendorId === null
    ? query.is('vendor_id', null)
    : query.eq('vendor_id', vendorId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  // item_ids is a JSONB array of strings; default to null (no saved order).
  return (data?.item_ids ?? null) as string[] | null;
}

/**
 * WRITE (persist-on-drop). Persists the FULL ordered array for one
 * (user, screen, vendor?) key as a delete-then-insert. Throws on error so the
 * screen can revert the optimistic on-screen order + notifyBackendError (AC-6).
 *
 * NOT an upsert: PostgREST's `.upsert({ onConflict })` cannot target the two
 * PARTIAL unique indexes (design §1.2) — it can't supply their WHERE predicate,
 * so it 42P10s on both the staff-eod (vendor) and staff-weekly (no-vendor)
 * branches. So delete the one (user, screen, vendor?) row then insert the new
 * array; the two partial indexes remain as the duplicate guard. The two calls
 * are NOT atomic and (unlike the admin path) carry no abort signal — if the
 * insert throws after the delete succeeds, the row is left ABSENT (not
 * reverted): the screen falls back to default order and the next drop re-saves
 * the full array. Acceptable for a private per-user view preference.
 */
export async function saveCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
  itemIds: string[],
): Promise<void> {
  // PostgREST `.upsert({ onConflict })` CANNOT target a PARTIAL unique index (it
  // can't supply the index's WHERE predicate → 42P10 on both branches). Persist
  // as delete-then-insert for the one (user, screen, vendor?) key; the two
  // partial unique indexes stay as the duplicate guard. Not atomic across the
  // two calls, but this is a private per-user VIEW pref — a torn write just
  // re-saves on the next drop (the screen reverts + notifies on error, AC-6).
  let del = supabase
    .from('user_count_orders')
    .delete()
    .eq('user_id', userId)
    .eq('screen', screen);
  del = vendorId === null ? del.is('vendor_id', null) : del.eq('vendor_id', vendorId);
  const { error: delErr } = await del;
  if (delErr) throw delErr;
  const { error: insErr } = await supabase
    .from('user_count_orders')
    .insert({
      user_id: userId,
      screen,
      vendor_id: vendorId,
      item_ids: itemIds,
      updated_at: new Date().toISOString(),
    });
  if (insErr) throw insErr;
}

/**
 * RESET (per-screen "reset to default order"). Deletes the one
 * (user, screen, vendor?) row so the screen falls back to its default view
 * (AC-4 / AC-8). Throws on error. Touches ONLY this key.
 */
export async function resetCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
): Promise<void> {
  let query = supabase
    .from('user_count_orders')
    .delete()
    .eq('user_id', userId)
    .eq('screen', screen);
  query = vendorId === null
    ? query.is('vendor_id', null)
    : query.eq('vendor_id', vendorId);
  const { error } = await query;
  if (error) throw error;
}
