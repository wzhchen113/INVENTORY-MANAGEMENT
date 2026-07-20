// src/lib/eodDayStatus.ts — Spec 133.
//
// Pure, dependency-free day-status derivation for the admin EOD week sidebar.
// No `supabase`, no React, no store — so it is unit-testable without mounting
// the component. Mirrors this repo's extract-and-pin pattern
// (`src/lib/countOrder.ts`, `src/utils/minutesAfterDeadline.ts`).
//
// The whole feature (spec 133) is here: the week-sidebar loop used to fall
// through to an unconditional `'rest'` for any non-today day with zero
// submissions, conflating "no count entered yet" with "this weekday is an
// actual rest day." `deriveDayStatus` splits that terminal branch on
// `isRestWeekday`, so a past uncounted non-rest day resolves to `'uncounted'`
// (editable) and only a true schedule rest day stays `'rest'` (locked).

import type { DayName } from '../utils/enumLabels';

export type DayStatus =
  | 'today'
  | 'submitted'
  | 'draft'
  | 'late'
  | 'uncounted'
  | 'rest';

/** A single scheduled-vendor row in an `order_schedule[day]` slice. Only the
 *  `vendorId` is load-bearing for the rest-weekday predicate. */
export interface OrderScheduleRow {
  vendorId?: string | null;
}

export type OrderSchedule =
  | Record<string, ReadonlyArray<OrderScheduleRow>>
  | null
  | undefined;

/**
 * True iff the store's `order_schedule` is CONFIGURED (some weekday has ≥1
 * row for the store). Mirrors the cron's `storesWithSchedule` membership and
 * the section's inline `scheduleConfigured` (EODCountSection line ~292). When
 * false, the store falls back to "all vendors on all days" and NO day is a
 * rest day.
 */
export function scheduleConfigured(orderSchedule: OrderSchedule): boolean {
  if (!orderSchedule) return false;
  return Object.values(orderSchedule).some(
    (arr) => Array.isArray(arr) && arr.length > 0,
  );
}

/**
 * Count of DISTINCT non-null scheduled vendor ids for weekday `day`. Same
 * filter as the section's `dayScheduledVendorIds` (line ~298): null/undefined
 * ids (legacy pre-vendor_id rows) are dropped.
 */
function countScheduledVendorIds(orderSchedule: OrderSchedule, day: DayName): number {
  const arr = orderSchedule?.[day] || [];
  const ids = new Set<string>();
  for (const row of arr) {
    if (row.vendorId) ids.add(row.vendorId);
  }
  return ids.size;
}

/**
 * True iff the store's schedule is configured AND weekday `day` has zero
 * scheduled vendors. Byte-for-byte mirror of the `eod-reminder-cron` Track-1
 * gate semantics (`storesWithSchedule.has(store.id) &&
 * !storesScheduledToday.has(store.id)`): schedule configured for the store AND
 * zero vendors on that business weekday.
 *
 * When the schedule is UNCONFIGURED this is FALSE for every day → all days
 * editable (matches the section's "all vendors on all days" fallback and the
 * cron's legacy remind-every-day behavior).
 */
export function isRestWeekday(orderSchedule: OrderSchedule, day: DayName): boolean {
  return scheduleConfigured(orderSchedule) && countScheduledVendorIds(orderSchedule, day) === 0;
}

/**
 * Pure day-status reducer for one week-sidebar day cell. Priority ordering
 * mirrors the section's inline aggregation (EODCountSection lines ~251–268):
 *
 *   1. today            → `anyDraft ? 'draft' : 'today'` (today is NEVER
 *                         derived to 'rest'/'uncounted' — 133 is past-day only).
 *   2. anyDraft         → 'draft'
 *   3. anySubmitted     → `counted >= total ? 'submitted' : 'late'`
 *   4. no submissions   → `isRestWeekday ? 'rest' : 'uncounted'`  ← the fix.
 *
 * The single split at (4) IS spec 133: the old terminal unconditional 'rest'
 * becomes conditional on the schedule-derived rest-weekday flag.
 */
export function deriveDayStatus(input: {
  isToday: boolean;
  isRestWeekday: boolean;
  anyDraft: boolean;
  anySubmitted: boolean;
  counted: number;
  total: number;
}): DayStatus {
  if (input.isToday) return input.anyDraft ? 'draft' : 'today';
  if (input.anyDraft) return 'draft';
  if (input.anySubmitted) return input.counted >= input.total ? 'submitted' : 'late';
  return input.isRestWeekday ? 'rest' : 'uncounted';
}
