// src/utils/reorderDayFilter.ts
//
// Spec 087 — pure (framework-free) helpers for the Reorder calendar's
// order-out-day filter + active-days highlight + client-side KPI
// recompute. No React, no store, no supabase imports — same pure-util
// pattern as `enumLabels.ts` / `reportDates.ts`, which keeps the jest
// contract cheap.
//
// Two correctness traps the architect flagged and these helpers pin:
//
//   1. Weekday derivation MUST come from a FIXED index array indexed by
//      `Date.getDay()`, NOT `toLocaleString(..., { weekday })`. The
//      latter is locale-dependent — under es / zh-CN the returned name
//      is "lunes" / "星期一", which would never match the canonical
//      capitalized English keys (`'Monday'`…`'Sunday'`) the
//      `order_schedule.day_of_week` column stores. The fixed array is
//      locale-invariant.
//
//   2. The ISO `as_of_date` (`YYYY-MM-DD`) MUST be parsed at LOCAL
//      midnight. `new Date('2026-06-01')` parses as UTC midnight, which
//      in any negative-offset timezone (e.g. US Eastern) rolls back to
//      the previous local day → off-by-one weekday. Appending
//      `'T00:00:00'` forces local-time parsing (the same trick
//      `DatePicker.tsx` uses).

import type { DayName } from './enumLabels';
import type { OrderSchedule, ReorderVendor, ReorderPayload } from '../types';

// Locale-invariant weekday lookup. Index === `Date.getDay()`
// (0 = Sunday … 6 = Saturday). DO NOT replace with toLocaleString.
const WEEKDAY_BY_INDEX: readonly DayName[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Canonical capitalized day keys, used to iterate the OrderSchedule slice.
export const ALL_WEEKDAYS: readonly DayName[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Lower-cased → canonical lookup, so a matching pass is robust against a
// future lowercase-keyed source even though today the slice keys are
// already canonical capitalized.
const CANONICAL_BY_LOWER: Record<string, DayName> = ALL_WEEKDAYS.reduce(
  (acc, d) => {
    acc[d.toLowerCase()] = d;
    return acc;
  },
  {} as Record<string, DayName>,
);

/**
 * Normalize an arbitrary day string (any case) to a canonical `DayName`,
 * or `null` if it isn't a recognized weekday. Used so a comparison never
 * silently mismatches on casing.
 */
export function canonicalizeDayName(raw: string | null | undefined): DayName | null {
  if (!raw) return null;
  return CANONICAL_BY_LOWER[raw.trim().toLowerCase()] ?? null;
}

/**
 * Derive the canonical English `DayName` for an ISO `YYYY-MM-DD` date.
 * Parses at LOCAL midnight (trap #2) and maps via the fixed index array
 * (trap #1). Returns `null` for a malformed input rather than throwing.
 */
export function weekdayName(isoDate: string): DayName | null {
  if (!isoDate || typeof isoDate !== 'string') return null;
  // Local-midnight parse: appending the time component forces the JS
  // Date constructor to interpret the date in the local timezone.
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00`);
  const idx = d.getDay();
  if (Number.isNaN(idx)) return null;
  return WEEKDAY_BY_INDEX[idx] ?? null;
}

/**
 * The set of weekdays the focal store orders OUT on — derived from the
 * `orderSchedule` slice's day-keys whose vendor array is non-empty.
 * Used to highlight the calendar (B1). Decoupled from the as-of payload:
 * this is the recurring order-out pattern, not "days with a suggestion
 * right now."
 */
export function activeWeekdaysFromSchedule(schedule: OrderSchedule | null | undefined): Set<DayName> {
  const out = new Set<DayName>();
  if (!schedule) return out;
  for (const [rawDay, vendors] of Object.entries(schedule)) {
    const day = canonicalizeDayName(rawDay);
    if (!day) continue;
    if (Array.isArray(vendors) && vendors.length > 0) out.add(day);
  }
  return out;
}

/**
 * The set of vendorIds scheduled to order out on `weekday`, per the
 * `orderSchedule` slice. Case-insensitive on the slice keys (defensive).
 */
function vendorIdsForWeekday(schedule: OrderSchedule | null | undefined, weekday: DayName): Set<string> {
  const out = new Set<string>();
  if (!schedule) return out;
  for (const [rawDay, vendors] of Object.entries(schedule)) {
    if (canonicalizeDayName(rawDay) !== weekday) continue;
    if (!Array.isArray(vendors)) continue;
    for (const v of vendors) {
      if (v?.vendorId) out.add(v.vendorId);
    }
  }
  return out;
}

/**
 * Partition the report's returned vendors (A1 FE-only intersection):
 *   - `primary`    — vendors scheduled to order out on `selectedWeekday`
 *                    (intersection of has-a-suggestion ∩ scheduled-today).
 *   - `noSchedule` — vendors with `scheduleKnown === false` (no
 *                    `order_schedule` row; the report's 7-day fallback).
 *                    These have no order-out weekday, so they can never
 *                    satisfy "I order today" — surfaced in a secondary
 *                    group rather than silently dropped (AC9).
 *
 * A vendor that HAS a schedule but not on `selectedWeekday` lands in
 * NEITHER group — it's simply hidden for that day. `noSchedule` is keyed
 * off the authoritative server-computed `scheduleKnown` flag (not
 * re-derived from the slice) so the two views can't subtly disagree.
 *
 * Order within each group is preserved from the input array.
 */
export function partitionReorderVendors(
  vendors: ReorderVendor[] | null | undefined,
  schedule: OrderSchedule | null | undefined,
  selectedWeekday: DayName,
): { primary: ReorderVendor[]; noSchedule: ReorderVendor[] } {
  const primary: ReorderVendor[] = [];
  const noSchedule: ReorderVendor[] = [];
  if (!vendors || vendors.length === 0) return { primary, noSchedule };

  const scheduledIds = vendorIdsForWeekday(schedule, selectedWeekday);

  for (const v of vendors) {
    if (v.scheduleKnown === false) {
      noSchedule.push(v);
      continue;
    }
    if (scheduledIds.has(v.vendorId)) {
      primary.push(v);
    }
    // else: scheduled, but not on the selected weekday → hidden for the day.
  }

  return { primary, noSchedule };
}

/**
 * Recompute the KPI strip client-side from a vendor array (the filtered
 * PRIMARY "order today" set). The server's `reorderPayload.kpis` are
 * post-suggestion-filter but pre-order-out-filter, so they over-count
 * once the client applies the day filter. Recomputing here keeps the
 * strip, on-screen list, and CSV/PDF export all in agreement (D). The
 * shape matches `ReorderPayload['kpis']` so it can feed the existing
 * StatCards and the export footer directly.
 */
export function computeReorderKpis(vendors: ReorderVendor[]): ReorderPayload['kpis'] {
  let itemCount = 0;
  let totalEstimatedCost = 0;
  let eodSourcedVendorCount = 0;
  let stockFallbackVendorCount = 0;

  for (const v of vendors) {
    itemCount += v.items?.length ?? 0;
    totalEstimatedCost += v.vendorTotalCost ?? 0;
    if (v.onHandSource === 'eod') eodSourcedVendorCount += 1;
    else if (v.onHandSource === 'stock') stockFallbackVendorCount += 1;
  }

  return {
    vendorCount: vendors.length,
    itemCount,
    totalEstimatedCost,
    eodSourcedVendorCount,
    stockFallbackVendorCount,
  };
}
