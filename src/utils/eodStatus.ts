// src/utils/eodStatus.ts
//
// Computes a store's EOD-count status for tonight: Submitted, Pending, Late,
// or Missing. Used by the Dashboard's per-store overview table.

import { EODSubmission, Store } from '../types';
import { getBusinessTodayParts } from './businessDay';

export type EODStatus = 'submitted' | 'pending' | 'late' | 'missing';

export interface EODStatusResult {
  status: EODStatus;
  submission?: EODSubmission;
  /** Items submitted (when status = submitted) — entries.length. */
  itemsCounted: number;
  /** "11:42 PM" or empty when no submission. */
  submittedAt: string;
  /** Submitter display name when status = submitted, else ''. */
  submitter: string;
  /** Minutes overdue past the deadline; 0 when not late. */
  overdueMinutes: number;
}

const LATE_GRACE_MINUTES = 60;

export function computeEODStatus(
  store: Store,
  submissions: EODSubmission[],
  tz: string,
  now: Date = new Date(),
): EODStatusResult {
  const today = getBusinessTodayParts(tz);
  const todayISO = today.dateISO;

  const submission = submissions.find(
    (s) => s.storeId === store.id && s.date === todayISO && s.status === 'submitted',
  );

  if (submission) {
    return {
      status: 'submitted',
      submission,
      itemsCounted: submission.entries?.length || submission.itemCount || 0,
      submittedAt: submission.timestamp || '',
      submitter: submission.submittedBy || '',
      overdueMinutes: 0,
    };
  }

  // No submission — compare current time to deadline. Without a deadline set
  // on the store we treat it as Pending all day (admin hasn't configured EOD
  // hours yet — don't manufacture lateness).
  const deadlineHHMM = store.eodDeadlineTime;
  if (!deadlineHHMM) {
    return { status: 'pending', itemsCounted: 0, submittedAt: '', submitter: '', overdueMinutes: 0 };
  }

  const [hh, mm] = deadlineHHMM.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    return { status: 'pending', itemsCounted: 0, submittedAt: '', submitter: '', overdueMinutes: 0 };
  }

  // Build the deadline as a Date in the store's tz on today's business date.
  // We can't directly construct in a tz, so build a UTC instant from the local
  // wall-clock parts and compare via formatted strings.
  const deadline = wallClockInTz(today.year, today.month, today.day, hh, mm, tz);
  const diffMin = Math.floor((now.getTime() - deadline.getTime()) / 60_000);

  if (diffMin < 0) {
    return { status: 'pending', itemsCounted: 0, submittedAt: '', submitter: '', overdueMinutes: 0 };
  }
  if (diffMin <= LATE_GRACE_MINUTES) {
    return { status: 'late', itemsCounted: 0, submittedAt: '', submitter: '', overdueMinutes: diffMin };
  }
  return { status: 'missing', itemsCounted: 0, submittedAt: '', submitter: '', overdueMinutes: diffMin };
}

/**
 * Returns a Date representing the given wall-clock time in the given IANA
 * timezone. Iteratively corrects for DST/offset by re-formatting back to the
 * tz and adjusting until the formatted parts match the requested wall-clock.
 * Two passes is enough across all real-world tz offsets.
 */
function wallClockInTz(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string,
): Date {
  // First guess: assume UTC. Then read back what that instant looks like in tz.
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const tzY = Number(parts.year), tzMo = Number(parts.month), tzD = Number(parts.day);
    const tzH = Number(parts.hour) % 24, tzMi = Number(parts.minute);
    const targetUTC = Date.UTC(year, month - 1, day, hour, minute);
    const tzUTC = Date.UTC(tzY, tzMo - 1, tzD, tzH, tzMi);
    const drift = targetUTC - tzUTC;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}
