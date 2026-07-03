// src/screens/staff/lib/date.ts — shared staff-local date helpers.

/**
 * yyyy-mm-dd in LOCAL time — deliberately NOT `toISOString().slice(0,10)`,
 * which is UTC and reads as the wrong calendar day between local midnight and
 * UTC midnight. The staff screens key submissions, week-window math, and the
 * reorder as-of date off the store-local day. Single-sourced here (hygiene
 * sweep dedup — was defined byte-identically in EODCount / WeeklyCount /
 * Reorder). NOTE: e2e/eod.spec.ts mirrors this function byte-for-byte so its
 * date key matches what the app writes — keep the two in sync.
 */
export function todayIso(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
