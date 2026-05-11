// Spec 016/017/018 — date helpers shared by the Reports modal + detail
// frame. Extracted in REPORTS-3 round-2 fixes (release proposal Item 6).
// Originally duplicated between `NewReportModal.tsx` and
// `ReportDetailFrame.tsx`; the shape is now proven (REPORTS-2 + REPORTS-3
// both use it identically) so the duplication is replaced with this module.
//
// All helpers operate on local Date objects formatted to ISO YYYY-MM-DD
// strings. We do NOT pull in a date-picker library — the modal's
// manual-edit affordance is a plain TextInput validated by `isISODate`.
// Preset chips compute against today's local date so a user in Eastern
// time sees "Last 30d" ending at their local today, not UTC's.

export type PresetId = 'last_30d' | 'this_month' | 'last_full_month' | 'last_90d';

/** Format a Date as `YYYY-MM-DD` in the local timezone. */
export function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns true when `s` is a valid `YYYY-MM-DD` date in the local
 * timezone. Rejects e.g. "2026-02-31" — JS Date would roll over silently.
 */
export function isISODate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * Compute the `from`/`to` date pair for a preset id, against the
 * caller-supplied `now` (defaults to `new Date()`). Preset semantics:
 *   - `last_30d`        → today minus 30 days … today
 *   - `this_month`      → first of this month … today
 *   - `last_full_month` → first of last month … last day of last month
 *   - `last_90d`        → today minus 90 days … today
 */
export function computePreset(id: PresetId, now: Date = new Date()): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (id === 'last_30d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 30);
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (id === 'this_month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (id === 'last_full_month') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: toISODate(from), to: toISODate(to) };
  }
  // last_90d
  const from = new Date(today);
  from.setDate(from.getDate() - 90);
  return { from: toISODate(from), to: toISODate(today) };
}
