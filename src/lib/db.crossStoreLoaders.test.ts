// src/lib/db.crossStoreLoaders.test.ts — Spec 081 Track 1 (jest).
//
// Unit-tests the two cross-store read helpers added to db.ts for the
// Dashboard attention-queue `unconfirmed_po` per-store fix:
//   - fetchOrderScheduleForStores  — store-keyed weekday schedule map
//   - fetchOrderSubmissionsForStores — flat purchase_orders list
//
// The load-bearing invariant (spec 081 D6): store A's schedule rows map
// under A's key and NEVER bleed into store B's. The single-store
// fetchOrderSchedule had no store dimension at all — this is the dimension
// that fixes the bug, so it's the thing most worth pinning.
//
// Mocking strategy (mirrors cmdSelectors.unconfirmedPoWindow.test.ts:19 for
// the supabase stub, extended for the track() boundary):
//   - jest.mock('./supabase') — a chainable PostgrestBuilder stub whose
//     terminal `.abortSignal()` resolves to a per-test `{ data, error }`.
//     Both helpers route through `.from(...).select(...)` then either
//     `.in(...).abortSignal(...)` (schedule) or
//     `.in(...).gte(...).order(...).abortSignal(...)` (submissions), so every
//     intermediate mockBuilder method returns `this`.
//   - jest.mock('./inflight') — `track(fn, opts)` invokes `fn` directly with
//     a dummy AbortSignal so the real 5s/30s timers never arm in the node
//     env. The helper bodies are what we're asserting, not the inflight
//     wrapper (that's covered by inflight.test.ts).
//   - jest.mock('./auth') — db.ts imports callEdgeFunction from it; stub so
//     the import graph stays light and node-env-safe. Not exercised here.

const mockBuilder: any = {
  select: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  // Terminal: every helper chains `.abortSignal(signal)` last and awaits it.
  abortSignal: jest.fn(),
};

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn(() => mockBuilder),
  },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      // Run the thunk immediately with a throwaway signal — no timers.
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({
  callEdgeFunction: jest.fn(),
}));

import { fetchOrderScheduleForStores, fetchOrderSubmissionsForStores } from './db';
// Resolves to the jest.mock'd supabase above — used to pin the SOURCE TABLE
// each helper queries (spec 081 Risk 1: a regression to a wrong/non-existent
// table name like 'order_submissions' would 42P01 into the warn-and-return-
// empty path and pass every other assertion, shipping a silent fake fix).
import { supabase } from './supabase';

/** Point the terminal `.abortSignal()` at a PostgREST-style result. */
function mockResult(data: unknown[] | null, error: { message: string } | null = null) {
  mockBuilder.abortSignal.mockResolvedValueOnce({ data, error });
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes the `mockReturnThis()` implementations, so re-arm the
  // chain links each test. (abortSignal is set per-test via mockResult.)
  mockBuilder.select.mockReturnThis();
  mockBuilder.in.mockReturnThis();
  mockBuilder.eq.mockReturnThis();
  mockBuilder.gte.mockReturnThis();
  mockBuilder.order.mockReturnThis();
});

// ── fetchOrderScheduleForStores ─────────────────────────────────
describe('fetchOrderScheduleForStores', () => {
  it('returns {} for empty storeIds without touching supabase', async () => {
    const result = await fetchOrderScheduleForStores([]);
    expect(result).toEqual({});
    expect(mockBuilder.abortSignal).not.toHaveBeenCalled();
  });

  it('keys each store\'s schedule under its own id — A never bleeds into B', async () => {
    // Store A: Monday → Vendor V. Store B: Tuesday → Vendor W. Interleaved
    // rows prove the grouping is by store_id, not row order.
    mockResult([
      { store_id: 'A', day_of_week: 'Monday',  vendor_id: 'v-v', vendor_name: 'Vendor V', delivery_day: 'next-day' },
      { store_id: 'B', day_of_week: 'Tuesday', vendor_id: 'v-w', vendor_name: 'Vendor W', delivery_day: 'same-day' },
    ]);

    const result = await fetchOrderScheduleForStores(['A', 'B']);

    expect(result).toEqual({
      A: { Monday:  [{ vendorId: 'v-v', vendorName: 'Vendor V', deliveryDay: 'next-day' }] },
      B: { Tuesday: [{ vendorId: 'v-w', vendorName: 'Vendor W', deliveryDay: 'same-day' }] },
    });
    // The load-bearing assertion: A's schedule has no Tuesday/Vendor W, and
    // B's has no Monday/Vendor V. No cross-store contamination.
    expect(result.A.Tuesday).toBeUndefined();
    expect(result.B.Monday).toBeUndefined();
  });

  it('two stores sharing the same weekday each get only their own vendor — same-day multi-store', async () => {
    // Real production case: both stores order on Monday but from different
    // vendors. A buggy day_of_week-first grouping would blend them under one
    // Monday key; the correct store_id-first grouping keeps them separate.
    mockResult([
      { store_id: 'A', day_of_week: 'Monday', vendor_id: 'v-v', vendor_name: 'Vendor V', delivery_day: 'next-day' },
      { store_id: 'B', day_of_week: 'Monday', vendor_id: 'v-w', vendor_name: 'Vendor W', delivery_day: 'same-day' },
    ]);

    const result = await fetchOrderScheduleForStores(['A', 'B']);

    expect(result.A.Monday).toHaveLength(1);
    expect(result.A.Monday[0].vendorName).toBe('Vendor V');
    expect(result.B.Monday).toHaveLength(1);
    expect(result.B.Monday[0].vendorName).toBe('Vendor W');
  });

  it('groups multiple vendors on the same store+weekday into one array', async () => {
    mockResult([
      { store_id: 'A', day_of_week: 'Monday', vendor_id: 'v-v', vendor_name: 'Vendor V', delivery_day: 'next-day' },
      { store_id: 'A', day_of_week: 'Monday', vendor_id: 'v-x', vendor_name: 'Vendor X', delivery_day: 'same-day' },
    ]);

    const result = await fetchOrderScheduleForStores(['A']);

    expect(result.A.Monday).toHaveLength(2);
    expect(result.A.Monday.map((v) => v.vendorName)).toEqual(['Vendor V', 'Vendor X']);
  });

  it('filters by store_id via .in() and returns {} on PostgREST error (no throw)', async () => {
    mockResult(null, { message: 'relation "order_schedule" does not exist' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchOrderScheduleForStores(['A', 'B']);

    expect(result).toEqual({});
    // Pin the source table symmetrically with the submissions helper.
    expect(supabase.from).toHaveBeenCalledWith('order_schedule');
    expect(mockBuilder.in).toHaveBeenCalledWith('store_id', ['A', 'B']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns {} when the query yields no rows', async () => {
    mockResult([]);
    expect(await fetchOrderScheduleForStores(['A'])).toEqual({});
  });
});

// ── fetchOrderSubmissionsForStores ──────────────────────────────
describe('fetchOrderSubmissionsForStores', () => {
  it('returns [] for empty storeIds without touching supabase', async () => {
    const result = await fetchOrderSubmissionsForStores([], '2026-05-01');
    expect(result).toEqual([]);
    expect(mockBuilder.abortSignal).not.toHaveBeenCalled();
  });

  it('maps reference_date → date and vendor.name → vendorName per store', async () => {
    mockResult([
      {
        id: 'po-a', store_id: 'A', vendor_id: 'v-v', vendor: { name: 'Vendor V' },
        created_by: 'u-1', creator: { name: 'Alice' },
        created_at: '2026-05-26T15:00:00Z', reference_date: '2026-05-26',
        status: 'submitted', total_cost: 12.5,
      },
      {
        id: 'po-b', store_id: 'B', vendor_id: 'v-w', vendor: { name: 'Vendor W' },
        created_by: 'u-2', creator: { name: 'Bob' },
        created_at: '2026-05-25T16:00:00Z', reference_date: '2026-05-25',
        status: 'submitted', total_cost: 30,
      },
    ]);

    const result = await fetchOrderSubmissionsForStores(['A', 'B'], '2026-05-13');

    expect(result).toHaveLength(2);
    // The three predicate-critical fields (cmdSelectors.ts:890-895): storeId,
    // date, vendorName — populated and per-store-correct.
    const a = result.find((r) => r.storeId === 'A')!;
    const b = result.find((r) => r.storeId === 'B')!;
    expect(a).toMatchObject({ storeId: 'A', date: '2026-05-26', vendorName: 'Vendor V' });
    expect(b).toMatchObject({ storeId: 'B', date: '2026-05-25', vendorName: 'Vendor W' });
  });

  it('falls back to created_at UTC day when reference_date is null', async () => {
    mockResult([
      {
        id: 'po-x', store_id: 'A', vendor_id: 'v-v', vendor: { name: 'Vendor V' },
        created_by: 'u-1', creator: { name: 'Alice' },
        created_at: '2026-05-26T15:00:00Z', reference_date: null,
        status: 'submitted', total_cost: 5,
      },
    ]);

    const result = await fetchOrderSubmissionsForStores(['A'], '2026-05-13');
    expect(result[0].date).toBe('2026-05-26');
  });

  it('filters by store_id via .in(), applies the since cutoff via .gte(), and returns [] on error', async () => {
    mockResult(null, { message: 'boom' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchOrderSubmissionsForStores(['A', 'B'], '2026-05-13');

    expect(result).toEqual([]);
    // Risk 1 guard: pin the SOURCE TABLE. A revert to 'order_submissions'
    // (the non-existent name the AC mislabeled) would 42P01 → warn → [] and
    // pass every other assertion here. This is the line that fails loud.
    expect(supabase.from).toHaveBeenCalledWith('purchase_orders');
    expect(mockBuilder.in).toHaveBeenCalledWith('store_id', ['A', 'B']);
    expect(mockBuilder.gte).toHaveBeenCalledWith('created_at', '2026-05-13');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defaults vendorName to "" when the vendor join is null', async () => {
    mockResult([
      {
        id: 'po-y', store_id: 'A', vendor_id: null, vendor: null,
        created_by: 'u-1', creator: null,
        created_at: '2026-05-26T15:00:00Z', reference_date: '2026-05-26',
        status: 'submitted', total_cost: 0,
      },
    ]);

    const result = await fetchOrderSubmissionsForStores(['A'], '2026-05-13');
    expect(result[0].vendorName).toBe('');
  });
});
