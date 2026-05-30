// src/utils/weekWindow.ts
//
// Pure, dependency-free helpers for "current work-week" math anchored on
// Monday 00:00 local time in an IANA timezone. Used by the Dashboard
// attention queue (spec 074) so the per-store "missed vendor order" list
// resets every Monday rather than scrolling a fixed 7-day trailing
// window.
//
// IMPORTANT: this is NOT a wrapper around `getBusinessTodayParts` in
// `businessDay.ts`. That helper shifts current time back 3 hours so the
// late-night closing shift still reads as "yesterday" for EOD counting.
// That behavior is wrong here: an operator looking at the dashboard at
// 02:30 AM Monday expects the queue to have already reset for the new
// week. We use raw `Intl.DateTimeFormat(...).formatToParts(now)` with
// no shift. A future dev should NOT refactor the two helpers into one.
//
// We hardcode `'en-US'` for `Intl.DateTimeFormat` to get a stable
// English weekday name to index into the Mon..Sun lookup — same pattern
// as `businessDay.ts` (load-bearing on web + Hermes both, per spec 074
// Decision 3 / Hermes Intl is on by default in RN 0.81).
//
// Boundary representation: `mondayStart` / `nextMondayStart` are Date
// instants whose UTC year/month/day fields match the local Monday's
// calendar date in `tz`. This is a "logical date" anchor, NOT a
// tz-local-midnight wall-clock instant — sidestepping the half-day
// rollover surprise on east-of-UTC tzs (Tokyo Monday 00:00 = Sunday UTC,
// which would mis-enumerate the calendar dates). `isoDateRange` walks
// the UTC Y/M/D fields directly, so the two helpers compose without a
// tz parameter on `isoDateRange`.

const WEEKDAY_INDEX_MON_FIRST: Record<string, number> = {
  Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3,
  Friday: 4, Saturday: 5, Sunday: 6,
};

interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  weekday: string;
}

function readTzParts(now: Date, tz: string): TzParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
  };
}

export interface WeekWindow {
  /**
   * Date instant whose UTC year/month/day match the Monday this week in
   * `tz`. Lower bound (inclusive) for the work-week window.
   */
  mondayStart: Date;
  /**
   * Date instant whose UTC year/month/day match the FOLLOWING Monday's
   * calendar date in `tz`. Upper bound (EXCLUSIVE) for the work-week
   * window — Sunday is the last day in the current week.
   */
  nextMondayStart: Date;
}

/**
 * Returns the half-open `[mondayStart, nextMondayStart)` window for the
 * work-week containing `now` in the supplied IANA timezone. Week starts
 * on Monday 00:00 local — Sunday belongs to the PREVIOUS week, not the
 * next one.
 *
 * Pure, no side effects, no module-level state. `now` defaults to the
 * wall clock for interactive callers; tests inject a pinned Date.
 *
 * Note on the return shape: architect's spec §"Helper signature" originally
 * sketched ISO-string returns (`weekStartISO`/`todayISO`). The
 * implementation returns UTC-anchored `Date` objects instead because the
 * one production consumer (`cmdSelectors.unconfirmed_po`) needs to drive
 * `isoDateRange` over the half-open interval, and Date arithmetic is
 * easier to reason about than repeated ISO parse/format cycles. The ISO
 * conversion happens at the consumer boundary, not in the helper.
 */
export function getWeekWindow(tz: string, now: Date = new Date()): WeekWindow {
  const today = readTzParts(now, tz);
  const todayIdx = WEEKDAY_INDEX_MON_FIRST[today.weekday];
  // Defensive: should never fire — formatToParts always emits one of
  // the seven English weekday names — but guard with a sane fallback
  // (treat unknown as Monday) so a future Intl bug doesn't crash the
  // dashboard.
  const offsetFromMonday = todayIdx === undefined ? 0 : todayIdx;

  // UTC-arithmetic backwards from today's local Y/M/D — same pattern
  // as `businessDay.ts:computeWeekdayDateISO`. Adding/subtracting whole
  // days from a UTC instant is DST-safe.
  const todayAnchor = new Date(Date.UTC(today.year, today.month - 1, today.day));
  todayAnchor.setUTCDate(todayAnchor.getUTCDate() - offsetFromMonday);
  const mondayStart = new Date(todayAnchor.getTime());

  const nextMondayStart = new Date(todayAnchor.getTime());
  nextMondayStart.setUTCDate(nextMondayStart.getUTCDate() + 7);

  return { mondayStart, nextMondayStart };
}

/**
 * Returns the local-calendar ISO date (`YYYY-MM-DD`) for `now` in the
 * supplied IANA timezone. Companion to `getWeekWindow` for callers that
 * need the "today" anchor (e.g. to exclude today's date from the
 * unconfirmed_po missed-order window — a vendor order scheduled for
 * today may still be placed before EOD).
 */
export function getLocalDateISO(tz: string, now: Date): string {
  const parts = readTzParts(now, tz);
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${parts.year}-${m}-${d}`;
}

/**
 * Returns the ISO date strings (`YYYY-MM-DD`) for each calendar day in
 * the half-open `[start, end)` range, reading the UTC year/month/day
 * fields of each Date. Designed to be fed boundaries produced by
 * `getWeekWindow` (which are UTC-anchored logical dates by construction).
 *
 * Returns `[]` when `start >= end`.
 */
export function isoDateRange(start: Date, end: Date): string[] {
  if (start.getTime() >= end.getTime()) return [];
  const out: string[] = [];
  const cursor = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(),
  ));
  const endAnchor = new Date(Date.UTC(
    end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(),
  ));
  while (cursor.getTime() < endAnchor.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
