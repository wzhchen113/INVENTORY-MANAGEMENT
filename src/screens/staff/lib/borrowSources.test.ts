// src/screens/staff/lib/borrowSources.test.ts — Spec 200 (design §2).
//
// Pins the staff borrow-source read: the (store, date, 'submitted') filters,
// NO server-side vendor filter, the contract order, the faithful mapping (a
// null actual_remaining is never coerced to 0; NO NEED → the §6.3 shape; raw
// submitted_at string), the vendor-embed normalization, and throw-on-error.

type Call = { method: string; args: unknown[] };
const mockCalls: Call[] = [];
let mockResult: { data: unknown; error: unknown } = { data: [], error: null };

jest.mock('../../../lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'order', 'is']) {
    builder[m] = (...args: unknown[]) => {
      mockCalls.push({ method: m, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(mockResult);
  return {
    supabase: {
      from: (table: string) => {
        mockCalls.push({ method: 'from', args: [table] });
        return builder;
      },
    },
  };
});

import { fetchBorrowSources } from './borrowSources';

beforeEach(() => {
  mockCalls.length = 0;
  mockResult = { data: [], error: null };
});

describe('fetchBorrowSources', () => {
  it('reads submitted eod_submissions at (store, date) for ANY vendor, in contract order', async () => {
    await fetchBorrowSources('store-1', '2026-11-18');
    expect(mockCalls[0]).toEqual({ method: 'from', args: ['eod_submissions'] });
    const select = mockCalls.find((c) => c.method === 'select');
    expect(String(select?.args[0])).toContain('vendor:vendors(name)');
    expect(String(select?.args[0])).toContain(
      'eod_entries(item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, no_need)',
    );
    const eqs = mockCalls.filter((c) => c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual([
      ['store_id', 'store-1'],
      ['date', '2026-11-18'],
      ['status', 'submitted'],
    ]);
    // No vendor filter server-side (it would drop null-vendor rows).
    expect(mockCalls.some((c) => c.method === 'neq')).toBe(false);
    expect(eqs.some((a) => a[0] === 'vendor_id')).toBe(false);
    expect(mockCalls.filter((c) => c.method === 'order').map((c) => c.args)).toEqual([
      ['submitted_at', { ascending: false, nullsFirst: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('maps faithfully: raw submitted_at, embed object-or-array, null never → 0, NO NEED shape', async () => {
    mockResult = {
      data: [
        {
          id: 'sub-a',
          store_id: 'store-1',
          date: '2026-11-18',
          vendor_id: 'v-a',
          status: 'submitted',
          submitted_at: '2026-11-18T20:00:00.123456+00:00',
          vendor: [{ name: 'Sysco' }],
          eod_entries: [
            { item_id: 'x', actual_remaining: '5', actual_remaining_cases: null, actual_remaining_each: '5', no_need: false },
            { item_id: 'blank', actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null, no_need: false },
            { item_id: 'nn', actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null, no_need: true },
          ],
        },
        {
          id: 'sub-null',
          store_id: 'store-1',
          date: '2026-11-18',
          vendor_id: null,
          status: 'submitted',
          submitted_at: null,
          vendor: null,
          eod_entries: null,
        },
      ],
      error: null,
    };
    const out = await fetchBorrowSources('store-1', '2026-11-18');
    expect(out).toEqual([
      {
        submissionId: 'sub-a',
        storeId: 'store-1',
        date: '2026-11-18',
        vendorId: 'v-a',
        vendorName: 'Sysco',
        status: 'submitted',
        submittedAt: '2026-11-18T20:00:00.123456+00:00',
        entries: [
          { item_id: 'x', actual_remaining: 5, actual_remaining_cases: null, actual_remaining_each: 5 },
          { item_id: 'blank', actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null },
          { item_id: 'nn', actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null, no_need: true },
        ],
      },
      {
        submissionId: 'sub-null',
        storeId: 'store-1',
        date: '2026-11-18',
        vendorId: null,
        vendorName: null,
        status: 'submitted',
        submittedAt: null,
        entries: [],
      },
    ]);
    expect('no_need' in out[0].entries[0]).toBe(false);
  });

  it('throws on a query error (the screen catches + notifies)', async () => {
    mockResult = { data: null, error: { message: 'permission denied' } };
    await expect(fetchBorrowSources('store-1', '2026-11-18')).rejects.toEqual({ message: 'permission denied' });
  });
});
