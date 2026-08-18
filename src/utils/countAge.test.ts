// src/utils/countAge.test.ts — Spec 160.
//
// Pins the ONE definition of last-counted staleness:
//   - AC-8's four boundaries EXACTLY (6d23h / 7d00m / 29d23h / 30d00m).
//   - the degenerate inputs the design ruled on: null → never, malformed →
//     never (over-report staleness, never launder bad data as `fresh`),
//     negative age → fresh.
//   - `formatLastCounted` short vs long, the prior-year `, 25` variant, and the
//     timezone property that motivated passing an explicit `timeZone`: a
//     02:00Z timestamp is the PREVIOUS day in America/New_York.
//
// The relative fragment comes from the real `relativeTime()` (which anchors on
// the system clock), so fixed-date cases assert the DATE fragment and the `·`
// separator rather than a hard-coded age that would rot.

import {
  countAgeTone,
  formatLastCounted,
  COUNT_STALE_DAYS,
  COUNT_COLD_DAYS,
} from './countAge';

const NOW = new Date('2026-08-17T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const BASE = {
  now: NOW,
  locale: 'en',
  timeZone: 'America/New_York',
  neverLabel: 'never counted',
} as const;

describe('countAgeTone — AC-8 thresholds', () => {
  it('exposes the thresholds as named constants', () => {
    expect(COUNT_STALE_DAYS).toBe(7);
    expect(COUNT_COLD_DAYS).toBe(30);
  });

  it('6d23h ago → fresh', () => {
    expect(countAgeTone(ago(6 * DAY + 23 * HOUR), NOW)).toBe('fresh');
  });

  it('exactly 7d ago → stale (the low side is `<`)', () => {
    expect(countAgeTone(ago(7 * DAY), NOW)).toBe('stale');
  });

  it('29d23h ago → stale', () => {
    expect(countAgeTone(ago(29 * DAY + 23 * HOUR), NOW)).toBe('stale');
  });

  it('exactly 30d ago → cold (the high side is `>=`)', () => {
    expect(countAgeTone(ago(30 * DAY), NOW)).toBe('cold');
  });

  it('a few minutes ago → fresh', () => {
    expect(countAgeTone(ago(5 * 60_000), NOW)).toBe('fresh');
  });

  it('a year ago → cold', () => {
    expect(countAgeTone(ago(365 * DAY), NOW)).toBe('cold');
  });
});

describe('countAgeTone — degenerate inputs', () => {
  it('null / undefined / empty → never', () => {
    expect(countAgeTone(null, NOW)).toBe('never');
    expect(countAgeTone(undefined, NOW)).toBe('never');
    expect(countAgeTone('', NOW)).toBe('never');
  });

  it('an unparseable timestamp → never (safe direction, not fresh)', () => {
    expect(countAgeTone('not-a-date', NOW)).toBe('never');
  });

  it('a FUTURE timestamp (clock skew) → fresh, not an error', () => {
    expect(countAgeTone(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe('fresh');
  });
});

describe('formatLastCounted', () => {
  it('never-counted returns the localized label verbatim, both styles', () => {
    expect(formatLastCounted(null, { ...BASE, style: 'short' })).toBe('never counted');
    expect(formatLastCounted(null, { ...BASE, style: 'long' })).toBe('never counted');
    expect(formatLastCounted('garbage', { ...BASE, style: 'long' })).toBe('never counted');
  });

  it('short style = terse same-year date + · + relative age', () => {
    const out = formatLastCounted('2026-08-14T15:00:00Z', { ...BASE, style: 'short' });
    expect(out).toMatch(/^Aug 14 · .+$/);
  });

  it('long style = full absolute date + · + relative age', () => {
    const out = formatLastCounted('2026-08-14T15:00:00Z', { ...BASE, style: 'long' });
    expect(out).toMatch(/^August 14, 2026 · .+$/);
  });

  it('a PRIOR-year count adds the 2-digit year in the short form', () => {
    const out = formatLastCounted('2025-09-30T15:00:00Z', { ...BASE, style: 'short' });
    expect(out).toMatch(/^Sep 30, 25 · .+$/);
  });

  it('formats the date IN the supplied timezone — 02:00Z is the previous day in New York', () => {
    const iso = '2026-08-15T02:00:00Z';
    expect(formatLastCounted(iso, { ...BASE, timeZone: 'America/New_York', style: 'short' }))
      .toMatch(/^Aug 14 · /);
    // Same instant, UTC → the 15th. Proves the timeZone is actually applied.
    expect(formatLastCounted(iso, { ...BASE, timeZone: 'UTC', style: 'short' }))
      .toMatch(/^Aug 15 · /);
  });

  it('the same-year test is evaluated IN the timezone, not the runner zone', () => {
    // 2027-01-01T02:00Z is still Dec 31 2026 in New York, so against a
    // 2026 `now` this must take the SAME-year (no `, 27`) short form.
    const out = formatLastCounted('2027-01-01T02:00:00Z', {
      ...BASE,
      now: new Date('2026-12-30T12:00:00Z'),
      style: 'short',
    });
    expect(out).toMatch(/^Dec 31 · /);
  });
});
