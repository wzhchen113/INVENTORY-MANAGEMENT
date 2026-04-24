// src/utils/businessDay.ts
//
// Restaurants run past midnight — closing the Thursday dinner shift at 1:30 AM
// is still operationally "Thursday" for the staff. We treat the business day
// as rolling over at 3 AM local, so the app's "today" sticks with yesterday's
// calendar date during the late-night shift and flips at 3:00 local time.
//
// Used by the EOD screen (day-pill labels, today's-submission lookup), the
// Suggested Orders report (stale-EOD banner), and the Orders modal (today's
// EOD-counted items) so they all share the same "today".

export const BUSINESS_DAY_ROLLOVER_HOURS = 3;

export interface BusinessTodayParts {
  weekday: string;   // 'Monday' | 'Tuesday' | ...
  dateISO: string;   // 'YYYY-MM-DD' in the provided timezone, shifted
  year: number;
  month: number;     // 1-12
  day: number;       // 1-31
}

/**
 * Returns the business-day "today" parts for a given IANA timezone. Shifts
 * current time back by BUSINESS_DAY_ROLLOVER_HOURS so 02:45 AM local still
 * reports as yesterday's date/weekday.
 */
export function getBusinessTodayParts(tz: string): BusinessTodayParts {
  const shifted = new Date(Date.now() - BUSINESS_DAY_ROLLOVER_HOURS * 3_600_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    weekday: parts.weekday,
    dateISO: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Convert a weekday name (e.g. "Thursday") to an ISO date (YYYY-MM-DD)
 * representing that weekday within the CURRENT week in the given timezone.
 * "Current week" is anchored on today's business-day date — so at 01:30 Fri
 * this still treats Thursday as "yesterday" (businessToday = Thu).
 *
 * Used to stamp a day-card's reference date onto a new purchase-order
 * submission, so the Orders screen's "Submitted" pill can persist against
 * the right card after refresh (rather than silently rolling over to today).
 */
export function computeWeekdayDateISO(weekday: string, tz: string): string {
  const targetIdx = WEEKDAY_INDEX[weekday];
  if (targetIdx === undefined) return '';
  const today = getBusinessTodayParts(tz);
  const todayIdx = WEEKDAY_INDEX[today.weekday];
  if (todayIdx === undefined) return today.dateISO;

  // Diff in [-6, +6]. `today` → 0, yesterday → -1, tomorrow → +1, etc.
  const diff = targetIdx - todayIdx;

  // UTC arithmetic from today's Y/M/D avoids DST drift: adding 1 day to
  // a UTC midnight always gives the next UTC midnight.
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
  base.setUTCDate(base.getUTCDate() + diff);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
