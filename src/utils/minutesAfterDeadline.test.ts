import { minutesAfterDeadline } from './minutesAfterDeadline';

// Spec 121 — the architect flagged the post-midnight rollover as the Critical
// risk: a 22:00 deadline read after midnight must read as PASSED, not ~21h in
// the future. These pin the exact boundary points the reviewers hand-traced.
describe('minutesAfterDeadline (Track 3 missed-EOD rollover)', () => {
  const DEADLINE = '22:00';

  it('before the deadline, same evening → negative (not passed)', () => {
    expect(minutesAfterDeadline(21, 0, DEADLINE)).toBe(-60);
  });

  it('exactly at the deadline → 0 (passed)', () => {
    expect(minutesAfterDeadline(22, 0, DEADLINE)).toBe(0);
  });

  it('shortly after the deadline, same evening → positive', () => {
    expect(minutesAfterDeadline(22, 30, DEADLINE)).toBe(30);
    expect(minutesAfterDeadline(23, 0, DEADLINE)).toBe(60);
  });

  // The bug class: WITHOUT the +1440 shift, 00:30 would read as 30 - 1320 =
  // -1290 (looks ~21.5h in the future) and the miss would silently never fire.
  it('after midnight (00:30) → still counts as passed, ~150 min after', () => {
    expect(minutesAfterDeadline(0, 30, DEADLINE)).toBe(150);
  });

  it('just before the 3 AM business rollover (02:59) → still passed', () => {
    expect(minutesAfterDeadline(2, 59, DEADLINE)).toBe(299);
  });

  // Sanity: a deadline that itself sits inside the post-rollover pre-3AM window
  // is normalized on the same axis (both shifted), so ordering stays correct.
  it('normalizes a pre-rollover deadline consistently', () => {
    // deadline 01:00 (shifted to 1500), read at 02:00 (shifted to 1560) → 60.
    expect(minutesAfterDeadline(2, 0, '01:00')).toBe(60);
    // read at 00:30 (1470) vs same 01:00 deadline (1500) → -30 (not yet).
    expect(minutesAfterDeadline(0, 30, '01:00')).toBe(-30);
  });
});
