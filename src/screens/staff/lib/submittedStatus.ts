// src/screens/staff/lib/submittedStatus.ts — per-vendor "submitted today" status.
//
// Spec 129: the EOD screen colors each vendor chip RED (outstanding) or GREEN
// (submitted) for the current store + count date. This helper returns the set
// of vendor_ids that already have a submitted `eod_submissions` row for
// (store, date), so the chip row can color each chip independently — the
// generalization of `fetchYesterdayIncomplete` (which folds the same read to a
// yesterday boolean) against the currently-selected `countIso`.
//
// Extracted as its own module (like yesterdayStatus.ts) for a clean mock seam:
// the screen test stubs this function instead of threading another
// supabase.from() through the shared query-mock stack.
//
// Best-effort by contract: a thrown query error degrades to an empty Set (no
// false green) and is surfaced via notifyBackendError; it never blocks the
// screen. Staff carve-out — direct supabase read, same posture as
// fetchExistingSubmission / fetchYesterdayIncomplete.

import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from './notifyBackendError';

/**
 * Returns the set of vendor_ids with a `status = 'submitted'` eod_submissions
 * row for the given store + count date. One scoped select, no join — we only
 * need the ids to color the chips. Degrades to an empty Set on any error.
 */
export async function fetchSubmittedVendorIds(
  storeId: string,
  countIso: string,
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('eod_submissions')
      .select('vendor_id')
      .eq('store_id', storeId)
      .eq('date', countIso)
      .eq('status', 'submitted');
    if (error) throw error;
    const out = new Set<string>();
    for (const r of (data ?? []) as { vendor_id: string | null }[]) {
      if (r.vendor_id) out.add(r.vendor_id);
    }
    return out;
  } catch (err) {
    notifyBackendError('fetchSubmittedVendorIds', err);
    return new Set<string>();
  }
}
