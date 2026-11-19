// src/screens/staff/lib/stockCheck.test.ts — Spec 200 AC-20.
//
// Pins the pre-submit stock read: store-scoped, only the requested ids, raw
// current_stock values returned, no query for an empty id list, and
// throw-on-error (the screen fails closed).

type Call = { method: string; args: unknown[] };
const mockCalls: Call[] = [];
let mockResult: { data: unknown; error: unknown } = { data: [], error: null };

jest.mock('../../../lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) {
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

import { fetchCurrentStock } from './stockCheck';

beforeEach(() => {
  mockCalls.length = 0;
  mockResult = { data: [], error: null };
});

describe('fetchCurrentStock', () => {
  it('reads current_stock for the ids at the store and returns the raw values', async () => {
    mockResult = {
      data: [
        { id: 'a', current_stock: '5.000' },
        { id: 'b', current_stock: null },
      ],
      error: null,
    };
    const out = await fetchCurrentStock('store-1', ['a', 'b', 'c']);
    expect(mockCalls).toEqual([
      { method: 'from', args: ['inventory_items'] },
      { method: 'select', args: ['id, current_stock'] },
      { method: 'eq', args: ['store_id', 'store-1'] },
      { method: 'in', args: ['id', ['a', 'b', 'c']] },
    ]);
    expect(out).toEqual(
      new Map<string, number | string | null>([
        ['a', '5.000'],
        ['b', null],
      ]),
    );
    expect(out.has('c')).toBe(false);
  });

  it('no ids → no query', async () => {
    expect((await fetchCurrentStock('store-1', [])).size).toBe(0);
    expect(mockCalls).toEqual([]);
  });

  it('throws on a query error', async () => {
    mockResult = { data: null, error: { message: 'permission denied' } };
    await expect(fetchCurrentStock('store-1', ['a'])).rejects.toEqual({ message: 'permission denied' });
  });
});
