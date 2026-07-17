// src/screens/staff/lib/submittedStatus.test.ts
//
// fetchSubmittedVendorIds: the set of vendor_ids with a `status = 'submitted'`
// eod_submissions row for (store, date). Best-effort — a query error degrades
// to an empty Set. Mocks supabase.from() so the scoped select returns
// controlled rows; mock-state vars are `mock`-prefixed so the hoisted jest.mock
// factory may reference them.

type QueryResult = { data: unknown; error: unknown };
let mockResult: QueryResult = { data: [], error: null };
const mockEq: Record<string, unknown> = {};

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          mockEq[col] = val;
          return builder;
        },
        then: (resolve: (v: QueryResult) => unknown) => resolve(mockResult),
      };
      return builder;
    },
  },
}));

import { fetchSubmittedVendorIds } from './submittedStatus';

beforeEach(() => {
  mockResult = { data: [], error: null };
  for (const k of Object.keys(mockEq)) delete mockEq[k];
  // Silence the notifyBackendError console.warn on the best-effort error path.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('scopes the query to store, date, and status=submitted', async () => {
  await fetchSubmittedVendorIds('store-1', '2026-07-17');
  expect(mockEq).toMatchObject({
    store_id: 'store-1',
    date: '2026-07-17',
    status: 'submitted',
  });
});

it('returns the set of vendor_ids that have a submitted row', async () => {
  mockResult = { data: [{ vendor_id: 'v-1' }, { vendor_id: 'v-2' }], error: null };
  expect(await fetchSubmittedVendorIds('store-1', '2026-07-17')).toEqual(
    new Set(['v-1', 'v-2']),
  );
});

it('returns an empty set when no rows match', async () => {
  mockResult = { data: [], error: null };
  expect(await fetchSubmittedVendorIds('store-1', '2026-07-17')).toEqual(new Set());
});

it('ignores null vendor_id rows', async () => {
  mockResult = { data: [{ vendor_id: 'v-1' }, { vendor_id: null }], error: null };
  expect(await fetchSubmittedVendorIds('store-1', '2026-07-17')).toEqual(
    new Set(['v-1']),
  );
});

it('degrades to an empty set on a query error (best-effort)', async () => {
  mockResult = { data: null, error: { message: 'boom' } };
  expect(await fetchSubmittedVendorIds('store-1', '2026-07-17')).toEqual(new Set());
});
