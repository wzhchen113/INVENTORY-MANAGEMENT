// src/utils/relativeTime.test.ts — Spec 022 Track 1 unit example.
//
// Locks the current behaviour of `relativeTime(...)`. The function is a
// thin wrapper around `date-fns`' `formatDistanceToNowStrict` that rewrites
// the trailing unit word ("hour", "minutes", ...) into a single-character
// suffix ("h", "m", ...). Because the underlying library is locale-aware
// and time-of-day sensitive, this test freezes the system clock via
// `jest.useFakeTimers().setSystemTime(...)` so the assertions stay
// deterministic across machines + days.
//
// Architect picked `relativeTime` over `convertToItemUnit` (spec 022 §9):
// pure function, no external deps beyond `date-fns`, easy to assert
// against a fixed clock. The existing `scripts/test-unit-conversion.ts`
// remains the home of `convertToItemUnit` coverage until the retroactive-
// coverage spec replaces it.

import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  const NOW_ISO = '2026-05-13T12:00:00.000Z';
  const NOW_MS = new Date(NOW_ISO).getTime();

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW_ISO));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('formats an hour ago as "1h"', () => {
    // 1 hour earlier than the frozen now.
    expect(relativeTime('2026-05-13T11:00:00.000Z')).toBe('1h');
  });

  it('formats minutes ago as "<n>m"', () => {
    // 90 seconds ago → date-fns strict mode rounds to the nearest minute,
    // i.e. "2 minutes". Lock the rounded-up output so a future date-fns
    // upgrade that changes rounding direction is caught here.
    expect(relativeTime(new Date(NOW_MS - 90_000))).toBe('2m');
    // Exactly 1 minute ago → "1m" (cleaner anchor for the 1-digit case).
    expect(relativeTime(new Date(NOW_MS - 60_000))).toBe('1m');
  });

  it('formats seconds ago as "<n>s"', () => {
    // 5 seconds ago.
    expect(relativeTime(new Date(NOW_MS - 5_000))).toBe('5s');
  });

  it('formats two days ago as "2d"', () => {
    expect(relativeTime('2026-05-11T12:00:00.000Z')).toBe('2d');
  });

  it('accepts a numeric epoch-ms input', () => {
    // 1 hour ago, passed as a number — the function casts via new Date(input).
    expect(relativeTime(NOW_MS - 3_600_000)).toBe('1h');
  });

  it('accepts a Date instance directly', () => {
    expect(relativeTime(new Date(NOW_MS - 3_600_000))).toBe('1h');
  });

  it('returns empty string for null', () => {
    expect(relativeTime(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(relativeTime(undefined)).toBe('');
  });

  it('returns empty string for an unparseable date string', () => {
    expect(relativeTime('not-a-date')).toBe('');
  });
});
