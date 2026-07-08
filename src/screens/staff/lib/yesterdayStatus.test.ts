// src/screens/staff/lib/yesterdayStatus.test.ts
//
// fetchYesterdayIncomplete: true iff a vendor scheduled YESTERDAY has no
// submission for yesterday's date. Mocks supabase.from() per table so the two
// queries (order_schedule weekday vendors + eod_submissions for the date)
// return controlled rows. Mock-state vars are `mock`-prefixed so the hoisted
// jest.mock factory may reference them.

type QueryResult = { data: unknown; error: unknown };
let mockScheduleResult: QueryResult = { data: [], error: null };
let mockSubmissionsResult: QueryResult = { data: [], error: null };
const mockEqCalls: Record<string, Record<string, unknown>> = {};

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const captured: Record<string, unknown> = {};
      mockEqCalls[table] = captured;
      const result =
        table === 'order_schedule' ? mockScheduleResult : mockSubmissionsResult;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          captured[col] = val;
          return builder;
        },
        then: (resolve: (v: QueryResult) => unknown) => resolve(result),
      };
      return builder;
    },
  },
}));

import { fetchYesterdayIncomplete } from './yesterdayStatus';

// Pinned "now" = Wed 2026-07-08 → yesterday = Tue 2026-07-07.
const NOW = new Date(2026, 6, 8, 12, 0, 0);

beforeEach(() => {
  mockScheduleResult = { data: [], error: null };
  mockSubmissionsResult = { data: [], error: null };
  for (const k of Object.keys(mockEqCalls)) delete mockEqCalls[k];
});

it('queries yesterday’s weekday + ISO date', async () => {
  await fetchYesterdayIncomplete('store-1', NOW);
  expect(mockEqCalls['order_schedule']).toMatchObject({ store_id: 'store-1', day_of_week: 'Tuesday' });
  expect(mockEqCalls['eod_submissions']).toMatchObject({ store_id: 'store-1', date: '2026-07-07' });
});

it('true when a scheduled vendor has no submission', async () => {
  mockScheduleResult = { data: [{ vendor_id: 'v-1' }, { vendor_id: 'v-2' }], error: null };
  mockSubmissionsResult = { data: [{ vendor_id: 'v-1' }], error: null };
  expect(await fetchYesterdayIncomplete('store-1', NOW)).toBe(true);
});

it('false when every scheduled vendor submitted', async () => {
  mockScheduleResult = { data: [{ vendor_id: 'v-1' }, { vendor_id: 'v-2' }], error: null };
  mockSubmissionsResult = { data: [{ vendor_id: 'v-1' }, { vendor_id: 'v-2' }], error: null };
  expect(await fetchYesterdayIncomplete('store-1', NOW)).toBe(false);
});

it('false when nothing was scheduled yesterday', async () => {
  mockScheduleResult = { data: [], error: null };
  mockSubmissionsResult = { data: [], error: null };
  expect(await fetchYesterdayIncomplete('store-1', NOW)).toBe(false);
});

it('throws when a query errors (caller degrades to not-incomplete)', async () => {
  mockScheduleResult = { data: null, error: { message: 'boom' } };
  await expect(fetchYesterdayIncomplete('store-1', NOW)).rejects.toBeTruthy();
});
