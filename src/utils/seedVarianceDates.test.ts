// src/utils/seedVarianceDates.test.ts
//
// Spec 023 / B4 — canonical `db.ts`-boundary mock proof point.
//
// Demonstrates the hybrid-mock pattern from `tests/README.md:54-79` in a
// WIRED jest test. Mocks the named export `fetchRecentEodDates` from
// `src/lib/db.ts` at module boundary so the helper under test is exercised
// against controlled fake data, without the Supabase client + env crashes
// `src/lib/supabase.ts` triggers under jest (no `.env`).
//
// jest.mock pitfall (architect's caveat in spec 023 §5):
//   `jest.mock(...)` is HOISTED above all `import` statements at compile
//   time. To use the mocked function in assertions we re-import it AFTER
//   the mock declaration is in scope; the `require` form below is the
//   simplest way to access the mock handle. (Alternative: `import type
//   only { fetchRecentEodDates }` at top, then `(fetchRecentEodDates as
//   jest.Mock).mockResolvedValue(...)` — both work.)
//
// Three assertions:
//   (1) Happy path — 2 EOD dates returned, descending. Helper unpacks
//       into { from: dates[1], to: dates[0], eodCount: 2 }.
//   (2) One-EOD-only path — helper returns 1 date. Result has blank
//       from/to but eodCount: 1, which drives the modal's "danger hint"
//       branch.
//   (3) Error path — mock rejects. Helper swallows + returns all blanks
//       with eodCount: 0.

jest.mock('../lib/db', () => ({
  fetchRecentEodDates: jest.fn(),
}));

// Re-import to get the mocked function handle. The path matches the
// `jest.mock` call above (relative path resolution).
import { fetchRecentEodDates } from '../lib/db';
import { seedVarianceDates } from './seedVarianceDates';

describe('seedVarianceDates', () => {
  beforeEach(() => {
    (fetchRecentEodDates as jest.Mock).mockReset();
  });

  it('returns from/to in ascending order when 2 EOD dates exist', async () => {
    // fetchRecentEodDates returns descending: [most-recent, second-most-recent].
    // seedVarianceDates unpacks to ascending: { from: prior, to: current }.
    (fetchRecentEodDates as jest.Mock).mockResolvedValue(['2026-05-02', '2026-05-01']);

    const result = await seedVarianceDates('store-id-abc');

    expect(result).toEqual({ from: '2026-05-01', to: '2026-05-02', eodCount: 2 });
    expect(fetchRecentEodDates).toHaveBeenCalledWith('store-id-abc', 2);
  });

  it('returns blank from/to when only 1 EOD date exists (one-EOD fallback)', async () => {
    // One-EOD-only path: the modal's "danger hint" reads eodCount=1 to
    // surface "Submit at least two EODs to enable variance".
    (fetchRecentEodDates as jest.Mock).mockResolvedValue(['2026-05-02']);

    const result = await seedVarianceDates('store-id-abc');

    expect(result).toEqual({ from: '', to: '', eodCount: 1 });
  });

  it('returns all blanks with eodCount=0 when the helper throws (error path)', async () => {
    // Error path: helper-level RLS denials, network failures, etc.
    // seedVarianceDates swallows and returns the sentinel envelope.
    (fetchRecentEodDates as jest.Mock).mockRejectedValue(new Error('network down'));

    const result = await seedVarianceDates('store-id-abc');

    expect(result).toEqual({ from: '', to: '', eodCount: 0 });
  });
});
