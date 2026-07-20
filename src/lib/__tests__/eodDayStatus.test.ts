// Spec 133 — pins for the extracted pure day-status module.
//
// Guards the whole feature: a past, non-rest, uncounted day resolves to
// `'uncounted'` (editable) instead of the old unconditional `'rest'`, while a
// TRUE schedule rest day stays `'rest'` (locked). Also regression-guards the
// unchanged draft/late/submitted branches and the "today is never locked" rule.

import {
  deriveDayStatus,
  isRestWeekday,
  scheduleConfigured,
  type OrderSchedule,
} from '../eodDayStatus';

// A schedule with vendors on Monday only. Monday is a working weekday;
// Tuesday (and every other weekday) has zero vendors → a true rest day.
const MON_ONLY: OrderSchedule = {
  Monday: [{ vendorId: 'v1' }, { vendorId: 'v2' }],
  Tuesday: [],
  Wednesday: [],
  Thursday: [],
  Friday: [],
  Saturday: [],
  Sunday: [],
};

describe('scheduleConfigured', () => {
  it('is false for null/undefined/empty schedules', () => {
    expect(scheduleConfigured(null)).toBe(false);
    expect(scheduleConfigured(undefined)).toBe(false);
    expect(scheduleConfigured({})).toBe(false);
    expect(scheduleConfigured({ Monday: [], Tuesday: [] })).toBe(false);
  });

  it('is true once any weekday has ≥1 row', () => {
    expect(scheduleConfigured(MON_ONLY)).toBe(true);
  });
});

describe('isRestWeekday', () => {
  it('is true for a configured weekday with zero scheduled vendors', () => {
    expect(isRestWeekday(MON_ONLY, 'Tuesday')).toBe(true);
  });

  it('is false for a configured weekday that HAS scheduled vendors', () => {
    expect(isRestWeekday(MON_ONLY, 'Monday')).toBe(false);
  });

  it('ignores null/undefined vendorIds when counting (legacy rows)', () => {
    const sched: OrderSchedule = {
      Monday: [{ vendorId: 'v1' }],
      Tuesday: [{ vendorId: null }, { vendorId: undefined }],
    };
    expect(isRestWeekday(sched, 'Tuesday')).toBe(true);
  });

  it('is false for EVERY weekday when the schedule is unconfigured (fallback)', () => {
    for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const) {
      expect(isRestWeekday(null, d)).toBe(false);
      expect(isRestWeekday({}, d)).toBe(false);
    }
  });
});

describe('deriveDayStatus', () => {
  const base = {
    isToday: false,
    isRestWeekday: false,
    anyDraft: false,
    anySubmitted: false,
    counted: 0,
    total: 5,
  };

  it('past day, configured, vendors that weekday, zero submissions → uncounted (the fix)', () => {
    expect(deriveDayStatus({ ...base, isRestWeekday: false })).toBe('uncounted');
  });

  it('past day, configured, zero vendors that weekday, zero submissions → rest (stays locked)', () => {
    expect(deriveDayStatus({ ...base, isRestWeekday: true })).toBe('rest');
  });

  it('schedule-unconfigured fallback → past uncounted day is uncounted (all days editable)', () => {
    // isRestWeekday(null, ...) is false → the reducer yields 'uncounted'.
    expect(deriveDayStatus({ ...base, isRestWeekday: isRestWeekday(null, 'Tuesday') })).toBe('uncounted');
  });

  it('regression: past day with a draft → draft', () => {
    expect(deriveDayStatus({ ...base, anyDraft: true })).toBe('draft');
    // draft wins even on a rest weekday (an off-schedule backfilled draft).
    expect(deriveDayStatus({ ...base, anyDraft: true, isRestWeekday: true })).toBe('draft');
  });

  it('regression: past day submitted with counted < total → late', () => {
    expect(deriveDayStatus({ ...base, anySubmitted: true, counted: 3, total: 5 })).toBe('late');
  });

  it('regression: past day submitted with counted >= total → submitted', () => {
    expect(deriveDayStatus({ ...base, anySubmitted: true, counted: 5, total: 5 })).toBe('submitted');
    expect(deriveDayStatus({ ...base, anySubmitted: true, counted: 6, total: 5 })).toBe('submitted');
  });

  it('today is NEVER locked → today regardless of isRestWeekday', () => {
    expect(deriveDayStatus({ ...base, isToday: true, isRestWeekday: true })).toBe('today');
    expect(deriveDayStatus({ ...base, isToday: true, isRestWeekday: false })).toBe('today');
  });

  it('today with a draft → draft (not today, not rest)', () => {
    expect(deriveDayStatus({ ...base, isToday: true, anyDraft: true, isRestWeekday: true })).toBe('draft');
  });
});
