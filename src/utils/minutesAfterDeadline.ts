// Spec 121 — jest-only mirror of the Track 3 "minutes since deadline" arithmetic.
//
// The authoritative copy lives in the Deno edge function
// supabase/functions/eod-reminder-cron/index.ts (minutesSinceDeadline). That
// helper reads the REAL wall clock via wallPartsInTZ(tz), so its arithmetic is
// not reachable from jest without dragging Intl/Date into the test. Following
// the escapeHtml.ts precedent (a pure src/utils mirror that jest can exercise,
// with byte-for-byte logic identity enforced at code-review time — the edge
// bundle does NOT import this file), this isolates the pure integer arithmetic
// of lines 68–73 so the post-midnight +1440 rollover has a regression net.
//
// The failure mode it guards is silent: minutesUntilCutoff (and a naive
// since-deadline calc) return a POSITIVE "minutes until" after midnight, so a
// 22:00 deadline read at 00:30 looks like it is still ~21h in the FUTURE, and
// the miss would never fire in the post-midnight window. The +1440 shift on any
// clock reading before the 3 AM business-day rollover normalizes both the
// current time and the deadline onto one monotonic axis.
//
// minutesAfter >= 0  => the deadline has passed (fire a miss if unsubmitted).
// minutesAfter <  0  => the deadline is still in the future (do not fire).

export const BUSINESS_DAY_ROLLOVER_HOURS = 3;

export function minutesAfterDeadline(
  wallHour: number,
  wallMinute: number,
  deadlineHHMM: string,
  rolloverHours: number = BUSINESS_DAY_ROLLOVER_HOURS,
): number {
  let nowMin = wallHour * 60 + wallMinute;
  if (wallHour < rolloverHours) nowMin += 1440;
  const [ch, cm] = deadlineHHMM.split(':').map(Number);
  let cutMin = ch * 60 + cm;
  if (ch < rolloverHours) cutMin += 1440;
  return nowMin - cutMin;
}
