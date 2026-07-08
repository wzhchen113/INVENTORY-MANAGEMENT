// src/screens/staff/lib/yesterdayStatus.ts — "was yesterday's count missed?"
//
// Owner request (2026-07): the EOD screen flags when a vendor scheduled
// YESTERDAY still has no submission, so staff get nudged to file the late
// count (red "Yesterday" toggle label + a Today reminder banner).
//
// Extracted as its own module (rather than inline in EODCount) so it's a
// clean mock seam: the screen test stubs this function instead of threading
// two more supabase.from() calls through the shared query-mock stack, and the
// query logic gets its own focused unit test.
//
// Best-effort by contract: the caller treats a thrown error as "not
// incomplete" (no false alarms). Staff carve-out — direct supabase reads,
// same posture as the other EOD fetch helpers.

import { supabase } from '../../../lib/supabase';
import { todayIso } from './date';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * True when ≥1 vendor scheduled for YESTERDAY (relative to `now`) has no
 * eod_submissions row for yesterday's date. False when nothing was scheduled
 * yesterday or every scheduled vendor already submitted.
 *
 * `now` is injectable for deterministic tests.
 */
export async function fetchYesterdayIncomplete(
  storeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);
  const yIso = todayIso(yd);
  const yWeekday = WEEKDAYS[yd.getDay()];

  const [schedRes, subRes] = await Promise.all([
    supabase
      .from('order_schedule')
      .select('vendor_id')
      .eq('store_id', storeId)
      .eq('day_of_week', yWeekday),
    supabase
      .from('eod_submissions')
      .select('vendor_id')
      .eq('store_id', storeId)
      .eq('date', yIso),
  ]);
  if (schedRes.error) throw schedRes.error;
  if (subRes.error) throw subRes.error;

  const scheduled = new Set<string>();
  for (const r of (schedRes.data ?? []) as { vendor_id: string | null }[]) {
    if (r.vendor_id) scheduled.add(r.vendor_id);
  }
  if (scheduled.size === 0) return false;

  const submitted = new Set<string>();
  for (const r of (subRes.data ?? []) as { vendor_id: string | null }[]) {
    if (r.vendor_id) submitted.add(r.vendor_id);
  }

  for (const id of scheduled) {
    if (!submitted.has(id)) return true;
  }
  return false;
}
