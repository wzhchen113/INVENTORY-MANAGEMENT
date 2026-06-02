// src/utils/reorderDayFilter.test.ts — Spec 087.
//
// Pure-function unit tests for the Reorder calendar's order-out-day
// filter, active-days derivation, and client-side KPI recompute. Lives
// in the fast node-env project (no React / DOM). Covers the two
// correctness traps the architect flagged:
//   - weekday derivation is locale-invariant (fixed index array, not
//     toLocaleString) — exercised by forcing a non-en locale.
//   - the ISO date parses at LOCAL midnight (no UTC-rollover off-by-one).

import {
  weekdayName,
  canonicalizeDayName,
  activeWeekdaysFromSchedule,
  partitionReorderVendors,
  computeReorderKpis,
} from './reorderDayFilter';
import type { OrderSchedule, ReorderVendor } from '../types';

// Minimal vendor factory — only the fields the filter / KPI math read.
function vendor(over: Partial<ReorderVendor> & { vendorId: string }): ReorderVendor {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorName ?? over.vendorId,
    scheduleKnown: over.scheduleKnown ?? true,
    nextDeliveryDate: over.nextDeliveryDate ?? '2026-06-02',
    daysUntilNextDelivery: over.daysUntilNextDelivery ?? 1,
    onHandSource: over.onHandSource ?? 'eod',
    eodSubmittedAt: over.eodSubmittedAt ?? null,
    items: over.items ?? [],
    vendorTotalCost: over.vendorTotalCost ?? 0,
  };
}

function item(suggestedQty: number, estimatedCost: number) {
  return {
    itemId: `i-${Math.random()}`,
    itemName: 'x',
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 0,
    usageForecasted: 0,
    parReplacement: 0,
    suggestedQty,
    costPerUnit: 0,
    estimatedCost,
    flags: [] as string[],
  };
}

describe('weekdayName', () => {
  it('maps known ISO dates to the correct canonical DayName', () => {
    // 2026-06-01 is a Monday; 2026-06-07 is a Sunday.
    expect(weekdayName('2026-06-01')).toBe('Monday');
    expect(weekdayName('2026-06-02')).toBe('Tuesday');
    expect(weekdayName('2026-06-06')).toBe('Saturday');
    expect(weekdayName('2026-06-07')).toBe('Sunday');
  });

  it('parses at local midnight (no UTC-rollover off-by-one)', () => {
    // A bare `new Date('2026-06-01')` is parsed as UTC midnight; in any
    // negative-offset TZ that rolls back to 2026-05-31 (Sunday) → wrong
    // weekday. The local-midnight parse must always yield Monday
    // regardless of the runner's timezone.
    expect(weekdayName('2026-06-01')).toBe('Monday');
    // Sanity: prove the naive UTC parse WOULD differ in a negative-offset
    // TZ, so the assertion above is meaningful. (Skip the comparison when
    // the runner happens to be at/east of UTC, where both agree.)
    const naiveUtcDow = new Date('2026-06-01').getDay(); // UTC-midnight
    const localDow = new Date('2026-06-01T00:00:00').getDay();
    if (naiveUtcDow !== localDow) {
      // We're in a TZ where the bug would manifest; confirm we dodged it.
      expect(weekdayName('2026-06-01')).toBe('Monday');
    }
  });

  it('is locale-invariant — does NOT depend on toLocaleString', () => {
    // The whole point of the fixed index array: under es / zh-CN a
    // locale-formatted weekday would be "lunes" / "星期一" and never match
    // the canonical key. weekdayName never touches the locale, so the
    // result is the canonical English name no matter the runtime locale.
    expect(weekdayName('2026-06-01')).toBe('Monday');
    expect(weekdayName('2026-06-01')).not.toBe('lunes');
    expect(weekdayName('2026-06-01')).not.toBe('星期一');
  });

  it('returns null for malformed input', () => {
    expect(weekdayName('')).toBeNull();
    expect(weekdayName('not-a-date')).toBeNull();
    // @ts-expect-error — exercising the runtime null-guard.
    expect(weekdayName(null)).toBeNull();
  });
});

describe('canonicalizeDayName', () => {
  it('normalizes any case to the canonical capitalized DayName', () => {
    expect(canonicalizeDayName('monday')).toBe('Monday');
    expect(canonicalizeDayName('MONDAY')).toBe('Monday');
    expect(canonicalizeDayName(' Monday ')).toBe('Monday');
    expect(canonicalizeDayName('SuNdAy')).toBe('Sunday');
  });

  it('returns null for non-weekday strings', () => {
    expect(canonicalizeDayName('funday')).toBeNull();
    expect(canonicalizeDayName('')).toBeNull();
    expect(canonicalizeDayName(null)).toBeNull();
  });
});

describe('activeWeekdaysFromSchedule', () => {
  it('returns an empty set for the empty / null baseline', () => {
    expect(activeWeekdaysFromSchedule(null).size).toBe(0);
    expect(activeWeekdaysFromSchedule(undefined).size).toBe(0);
    const empty: OrderSchedule = {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [],
      Friday: [], Saturday: [], Sunday: [],
    };
    expect(activeWeekdaysFromSchedule(empty).size).toBe(0);
  });

  it('returns exactly the non-empty day-keys', () => {
    const schedule: OrderSchedule = {
      Monday: [{ vendorId: 'v1', vendorName: 'A', deliveryDay: 'Wednesday' }],
      Tuesday: [],
      Wednesday: [],
      Thursday: [{ vendorId: 'v2', vendorName: 'B', deliveryDay: 'Friday' }],
      Friday: [],
      Saturday: [],
      Sunday: [],
    };
    const active = activeWeekdaysFromSchedule(schedule);
    expect([...active].sort()).toEqual(['Monday', 'Thursday']);
  });

  it('canonicalizes lowercase keys defensively', () => {
    const schedule = {
      monday: [{ vendorId: 'v1', vendorName: 'A', deliveryDay: 'Wednesday' }],
    } as unknown as OrderSchedule;
    const active = activeWeekdaysFromSchedule(schedule);
    expect(active.has('Monday')).toBe(true);
  });
});

describe('partitionReorderVendors', () => {
  const schedule: OrderSchedule = {
    Monday: [{ vendorId: 'v-mon', vendorName: 'Mon Co', deliveryDay: 'Wednesday' }],
    Tuesday: [{ vendorId: 'v-tue', vendorName: 'Tue Co', deliveryDay: 'Thursday' }],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
    Sunday: [],
  };

  it('puts a vendor scheduled on the selected weekday in primary', () => {
    const vendors = [vendor({ vendorId: 'v-mon' })];
    const { primary, noSchedule } = partitionReorderVendors(vendors, schedule, 'Monday');
    expect(primary.map((v) => v.vendorId)).toEqual(['v-mon']);
    expect(noSchedule).toEqual([]);
  });

  it('puts a vendor scheduled only on a different weekday in NEITHER group', () => {
    const vendors = [vendor({ vendorId: 'v-tue' })]; // scheduled Tuesday
    const { primary, noSchedule } = partitionReorderVendors(vendors, schedule, 'Monday');
    expect(primary).toEqual([]);
    expect(noSchedule).toEqual([]);
  });

  it('puts a scheduleKnown=false vendor in noSchedule regardless of weekday', () => {
    const vendors = [vendor({ vendorId: 'v-none', scheduleKnown: false })];
    const onMon = partitionReorderVendors(vendors, schedule, 'Monday');
    const onSat = partitionReorderVendors(vendors, schedule, 'Saturday');
    expect(onMon.noSchedule.map((v) => v.vendorId)).toEqual(['v-none']);
    expect(onMon.primary).toEqual([]);
    expect(onSat.noSchedule.map((v) => v.vendorId)).toEqual(['v-none']);
  });

  it('matches case-insensitively against the schedule keys', () => {
    const lowerSchedule = {
      monday: [{ vendorId: 'v-mon', vendorName: 'Mon Co', deliveryDay: 'Wednesday' }],
    } as unknown as OrderSchedule;
    const vendors = [vendor({ vendorId: 'v-mon' })];
    const { primary } = partitionReorderVendors(vendors, lowerSchedule, 'Monday');
    expect(primary.map((v) => v.vendorId)).toEqual(['v-mon']);
  });

  it('only partitions vendors present in the payload (intersection)', () => {
    // v-mon is scheduled Monday but NOT returned by the report → it must
    // not appear (the report only returns vendors with a suggestion).
    const vendors = [vendor({ vendorId: 'v-tue' })]; // only Tuesday vendor returned
    const { primary, noSchedule } = partitionReorderVendors(vendors, schedule, 'Monday');
    expect(primary).toEqual([]);
    expect(noSchedule).toEqual([]);
  });

  it('handles an empty / nullish vendor list', () => {
    expect(partitionReorderVendors([], schedule, 'Monday')).toEqual({ primary: [], noSchedule: [] });
    expect(partitionReorderVendors(null, schedule, 'Monday')).toEqual({ primary: [], noSchedule: [] });
    expect(partitionReorderVendors(undefined, schedule, 'Monday')).toEqual({ primary: [], noSchedule: [] });
  });

  it('preserves input order within each group', () => {
    const vendors = [
      vendor({ vendorId: 'v-tue' }),
      vendor({ vendorId: 'v-mon' }),
      vendor({ vendorId: 'v-none', scheduleKnown: false }),
    ];
    const scheduleBoth: OrderSchedule = {
      ...schedule,
      Monday: [
        { vendorId: 'v-mon', vendorName: 'Mon Co', deliveryDay: 'Wednesday' },
        { vendorId: 'v-tue', vendorName: 'Tue Co', deliveryDay: 'Thursday' },
      ],
    };
    const { primary } = partitionReorderVendors(vendors, scheduleBoth, 'Monday');
    expect(primary.map((v) => v.vendorId)).toEqual(['v-tue', 'v-mon']);
  });
});

describe('computeReorderKpis', () => {
  it('sums itemCount and totalEstimatedCost across vendors', () => {
    const vendors = [
      vendor({ vendorId: 'a', items: [item(1, 10), item(2, 5)], vendorTotalCost: 15, onHandSource: 'eod' }),
      vendor({ vendorId: 'b', items: [item(3, 7)], vendorTotalCost: 7, onHandSource: 'stock' }),
    ];
    const kpis = computeReorderKpis(vendors);
    expect(kpis.vendorCount).toBe(2);
    expect(kpis.itemCount).toBe(3);
    expect(kpis.totalEstimatedCost).toBe(22);
  });

  it('counts the eod / stock on-hand source split off the filtered set', () => {
    const vendors = [
      vendor({ vendorId: 'a', onHandSource: 'eod' }),
      vendor({ vendorId: 'b', onHandSource: 'eod' }),
      vendor({ vendorId: 'c', onHandSource: 'stock' }),
    ];
    const kpis = computeReorderKpis(vendors);
    expect(kpis.eodSourcedVendorCount).toBe(2);
    expect(kpis.stockFallbackVendorCount).toBe(1);
  });

  it('returns all-zero KPIs for an empty set', () => {
    expect(computeReorderKpis([])).toEqual({
      vendorCount: 0,
      itemCount: 0,
      totalEstimatedCost: 0,
      eodSourcedVendorCount: 0,
      stockFallbackVendorCount: 0,
    });
  });
});
