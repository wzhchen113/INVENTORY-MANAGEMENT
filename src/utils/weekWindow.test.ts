// src/utils/weekWindow.test.ts — Spec 074 Track 1 unit coverage.
//
// Pure-function tests on `getWeekWindow`, `isoDateRange`, and
// `getLocalDateISO`. Every test pins `now` explicitly — never call
// these without an injected clock or assertions go flaky on a
// real-wall-clock day boundary.

import { getWeekWindow, isoDateRange, getLocalDateISO } from './weekWindow';

describe('getWeekWindow', () => {
  // ── Round-trip across three tzs ──────────────────────────────
  it('America/New_York mid-week — Wednesday 10:00 local', () => {
    // 2026-05-27T14:00:00Z = 2026-05-27 10:00 EDT (Wednesday)
    const w = getWeekWindow('America/New_York', new Date('2026-05-27T14:00:00Z'));
    expect(isoDateRange(w.mondayStart, w.nextMondayStart)).toEqual([
      '2026-05-25', '2026-05-26', '2026-05-27',
      '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
    ]);
  });

  it('America/New_York on a Monday — week is fresh', () => {
    // 2026-05-25T14:00:00Z = 2026-05-25 10:00 EDT (Monday).
    // Assert the FULL week shape (mirrors the Wednesday case above) so an
    // off-by-one in nextMondayStart on the boundary day would fail here,
    // not silently slip past a length-of-one assertion.
    const w = getWeekWindow('America/New_York', new Date('2026-05-25T14:00:00Z'));
    expect(isoDateRange(w.mondayStart, w.nextMondayStart)).toEqual([
      '2026-05-25', '2026-05-26', '2026-05-27',
      '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
    ]);
    expect(getLocalDateISO('America/New_York', new Date('2026-05-25T14:00:00Z'))).toBe('2026-05-25');
  });

  it('America/New_York at UTC-late-night boundary (still Monday local)', () => {
    // 2026-05-26T03:00:00Z = 2026-05-25 23:00 EDT (still Monday local)
    // Must NOT roll the week forward — weekStart stays at this Monday.
    const w = getWeekWindow('America/New_York', new Date('2026-05-26T03:00:00Z'));
    const isos = isoDateRange(w.mondayStart, w.nextMondayStart);
    expect(isos[0]).toBe('2026-05-25');
    expect(isos[isos.length - 1]).toBe('2026-05-31');
    expect(getLocalDateISO('America/New_York', new Date('2026-05-26T03:00:00Z'))).toBe('2026-05-25');
  });

  it('Asia/Tokyo at JST-midnight Monday — window opens forward', () => {
    // 2026-05-31T15:00:00Z = 2026-06-01 00:00 JST (Monday)
    // UTC is still Sunday, but Tokyo has rolled into Monday — window
    // must reflect the JST calendar, not the UTC one.
    const w = getWeekWindow('Asia/Tokyo', new Date('2026-05-31T15:00:00Z'));
    expect(isoDateRange(w.mondayStart, w.nextMondayStart)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03',
      '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07',
    ]);
    expect(getLocalDateISO('Asia/Tokyo', new Date('2026-05-31T15:00:00Z'))).toBe('2026-06-01');
  });

  it('UTC mid-week — Wednesday at noon', () => {
    // 2026-05-27T12:00:00Z = Wednesday in UTC
    const w = getWeekWindow('UTC', new Date('2026-05-27T12:00:00Z'));
    expect(isoDateRange(w.mondayStart, w.nextMondayStart)).toEqual([
      '2026-05-25', '2026-05-26', '2026-05-27',
      '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
    ]);
  });

  it('America/New_York on a Sunday — Sunday is in THIS week, not next', () => {
    // 2026-05-31T18:00:00Z = 2026-05-31 14:00 EDT (Sunday)
    // Sunday belongs to the work-week starting last Monday (2026-05-25).
    const w = getWeekWindow('America/New_York', new Date('2026-05-31T18:00:00Z'));
    const isos = isoDateRange(w.mondayStart, w.nextMondayStart);
    expect(isos[0]).toBe('2026-05-25');
    expect(isos[6]).toBe('2026-05-31');
    expect(isos.length).toBe(7);
  });

  // ── DST boundary case ─────────────────────────────────────────
  it('America/New_York spring-forward week — window snaps to local midnight despite offset change', () => {
    // US DST starts 2026-03-08 (second Sunday of March). The week
    // containing that Sunday starts Monday 2026-03-02 EST (UTC-5),
    // and the offset flips to EDT (UTC-4) on Sunday morning. The
    // window must still enumerate Mon..Sun of that local week
    // regardless of which side of the DST boundary `now` lands on.
    // Pin `now` mid-week (Wed 2026-03-04) BEFORE the transition.
    const wBefore = getWeekWindow('America/New_York', new Date('2026-03-04T14:00:00Z'));
    const isosBefore = isoDateRange(wBefore.mondayStart, wBefore.nextMondayStart);
    expect(isosBefore).toEqual([
      '2026-03-02', '2026-03-03', '2026-03-04',
      '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08',
    ]);

    // Pin `now` AFTER the transition: Sunday 2026-03-08 at 14:00 EDT
    // (= 18:00 UTC). Still the same work-week.
    const wAfter = getWeekWindow('America/New_York', new Date('2026-03-08T18:00:00Z'));
    const isosAfter = isoDateRange(wAfter.mondayStart, wAfter.nextMondayStart);
    expect(isosAfter).toEqual(isosBefore);
  });

  it('America/New_York fall-back week — window snaps to local midnight despite offset change (spec 074 symmetry pin)', () => {
    // US DST ends 2026-11-01 (first Sunday of November). The week containing
    // that Sunday starts Monday 2026-10-26 EDT (UTC-4), and the offset shifts
    // back to EST (UTC-5) on Sunday morning. The window must enumerate
    // Mon 2026-10-26 through Sun 2026-11-01 regardless of which side of
    // the fall-back boundary `now` lands on.
    // Pin `now` mid-week (Wed 2026-10-28) BEFORE the transition.
    const wBefore = getWeekWindow('America/New_York', new Date('2026-10-28T15:00:00Z'));
    const isosBefore = isoDateRange(wBefore.mondayStart, wBefore.nextMondayStart);
    expect(isosBefore).toEqual([
      '2026-10-26', '2026-10-27', '2026-10-28',
      '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
    ]);

    // Pin `now` AFTER the transition: Sunday 2026-11-01 at 14:00 EST
    // (= 19:00 UTC). Still the same work-week.
    const wAfter = getWeekWindow('America/New_York', new Date('2026-11-01T19:00:00Z'));
    const isosAfter = isoDateRange(wAfter.mondayStart, wAfter.nextMondayStart);
    expect(isosAfter).toEqual(isosBefore);
  });
});

describe('isoDateRange', () => {
  it('returns 7 entries for a Mon→Sun week in correct order', () => {
    const w = getWeekWindow('America/New_York', new Date('2026-05-27T14:00:00Z'));
    const isos = isoDateRange(w.mondayStart, w.nextMondayStart);
    expect(isos).toEqual([
      '2026-05-25', '2026-05-26', '2026-05-27',
      '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
    ]);
    expect(isos.length).toBe(7);
  });

  it('returns [] when start >= end', () => {
    const d = new Date(Date.UTC(2026, 4, 25));
    expect(isoDateRange(d, d)).toEqual([]);
    expect(isoDateRange(new Date(Date.UTC(2026, 4, 26)), d)).toEqual([]);
  });

  it('handles a single-day range', () => {
    const start = new Date(Date.UTC(2026, 4, 25));
    const end = new Date(Date.UTC(2026, 4, 26));
    expect(isoDateRange(start, end)).toEqual(['2026-05-25']);
  });

  it('crosses a month boundary cleanly', () => {
    // 2026-05-30 through 2026-06-02 exclusive
    const start = new Date(Date.UTC(2026, 4, 30));
    const end = new Date(Date.UTC(2026, 5, 2));
    expect(isoDateRange(start, end)).toEqual(['2026-05-30', '2026-05-31', '2026-06-01']);
  });
});
