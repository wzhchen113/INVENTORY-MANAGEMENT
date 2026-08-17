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

import {
  fetchOrderScheduleForStores,
  fetchOrderSubmissionsForStores,
  fetchWasteLogForStores,
} from './db';
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

// ── fetchWasteLogForStores (spec 159) ───────────────────────────
//
// Third sibling in this family. Load-bearing invariants beyond the shared
// empty/.in()/error shape:
//   - `timestamp` is the RAW ISO logged_at, NOT the single-store
//     fetchWasteLog's `toLocaleString()` (spec 159 Risk R-A). A locale
//     string reparses to Invalid Date under a non-en-US runtime locale, so
//     the Dashboard's `Date.parse(...) >= cutoff` filter would silently drop
//     every cross-store row and WASTE/WK would read $0.
//   - `costPerUnit` passes through UNBRIDGED (spec 104 R1) — waste_log's
//     cost_per_unit is the frozen per-COUNTED-unit snapshot and must not be
//     multiplied by subUnitSize here or downstream.
//   - `notes` and `logged_by` are NOT selected (spec 159 fix-pass item 5 /
//     security-auditor Low #2 — data minimization: the only consumer sums
//     quantity × costPerUnit). `notes` and `loggedByUserId` are always ''
//     regardless of what the mocked row carries.
describe('fetchWasteLogForStores', () => {
  it('returns [] for empty storeIds without touching supabase', async () => {
    const result = await fetchWasteLogForStores([], '2026-08-02T00:00:00.000Z');
    expect(result).toEqual([]);
    expect(mockBuilder.abortSignal).not.toHaveBeenCalled();
  });

  it('maps snake_case → camelCase per store and keeps logged_at as raw ISO', async () => {
    mockResult([
      {
        id: 'w-a', store_id: 'A', item_id: 'i-1', quantity: 2, unit: 'lb',
        cost_per_unit: 3.5, reason: 'Expired',
        logged_at: '2026-08-10T14:03:11.000Z',
      },
      {
        id: 'w-b', store_id: 'B', item_id: 'i-2', quantity: 1, unit: 'ea',
        cost_per_unit: 10, reason: 'Dropped/spilled',
        logged_at: '2026-08-09T09:00:00.000Z',
      },
    ]);

    const result = await fetchWasteLogForStores(['A', 'B'], '2026-08-02T00:00:00.000Z');

    expect(result).toHaveLength(2);
    const a = result.find((r) => r.storeId === 'A')!;
    expect(a).toMatchObject({
      id: 'w-a', itemId: 'i-1', quantity: 2, unit: 'lb',
      costPerUnit: 3.5, reason: 'Expired', storeId: 'A',
    });
    // R-A: raw ISO, always re-parseable regardless of runtime locale.
    expect(a.timestamp).toBe('2026-08-10T14:03:11.000Z');
    expect(Number.isFinite(Date.parse(a.timestamp))).toBe(true);
    // Not a locale string — this is the regression that would read as $0 waste.
    expect(a.timestamp).not.toBe(new Date('2026-08-10T14:03:11.000Z').toLocaleString());
    // notes is never selected → always '' (Low #2 minimization).
    expect(result.find((r) => r.storeId === 'B')!.notes).toBe('');
  });

  it('passes cost_per_unit through UNBRIDGED (spec 104 R1)', async () => {
    // A per-counted-unit snapshot of 12.00 must stay 12.00 — a subUnitSize
    // bridge anywhere in this mapper would silently inflate WASTE/WK.
    mockResult([
      {
        id: 'w-c', store_id: 'A', item_id: 'i-3', quantity: 1, unit: 'case',
        cost_per_unit: 12, reason: 'Quality issue',
        logged_at: '2026-08-10T14:00:00.000Z',
      },
    ]);

    const result = await fetchWasteLogForStores(['A'], '2026-08-02T00:00:00.000Z');
    expect(result[0].costPerUnit).toBe(12);
  });

  it('leaves the un-joined / unselected fields sparse rather than inventing values', async () => {
    // No profiles / catalog_ingredients embeds by design (aggregate-only
    // shape) — itemName and loggedBy are '' and callers must hydrate before
    // rendering these rows in a list. logged_by and notes are not even
    // requested in the select list (Low #2), so loggedByUserId/notes are
    // ALWAYS '' regardless of what the mocked row returns.
    mockResult([
      {
        id: 'w-d', store_id: 'A', item_id: 'i-4', quantity: 1, unit: null,
        cost_per_unit: 1, reason: 'Theft',
        logged_at: '2026-08-10T14:00:00.000Z',
      },
    ]);

    const result = await fetchWasteLogForStores(['A'], '2026-08-02T00:00:00.000Z');
    expect(result[0].itemName).toBe('');
    expect(result[0].loggedBy).toBe('');
    expect(result[0].loggedByUserId).toBe('');
    expect(result[0].notes).toBe('');
    expect(result[0].unit).toBe('');
  });

  it('does not request notes or logged_by in the select column list (Low #2)', async () => {
    mockResult([]);
    await fetchWasteLogForStores(['A'], '2026-08-02T00:00:00.000Z');
    const selectArg = mockBuilder.select.mock.calls[0][0] as string;
    expect(selectArg).not.toMatch(/\bnotes\b/);
    expect(selectArg).not.toMatch(/\blogged_by\b/);
  });

  it('filters by store_id via .in(), cuts off via .gte(logged_at), returns [] on error', async () => {
    mockResult(null, { message: 'permission denied for table waste_log' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchWasteLogForStores(['A', 'B'], '2026-08-02T00:00:00.000Z');

    expect(result).toEqual([]);
    expect(supabase.from).toHaveBeenCalledWith('waste_log');
    expect(mockBuilder.in).toHaveBeenCalledWith('store_id', ['A', 'B']);
    // Full ISO instant, not a date-only string — logged_at is timestamptz.
    expect(mockBuilder.gte).toHaveBeenCalledWith('logged_at', '2026-08-02T00:00:00.000Z');
    // R6: a warn, so an RLS denial can't masquerade as "$0 waste this week".
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns [] when the query yields no rows', async () => {
    mockResult([]);
    expect(await fetchWasteLogForStores(['A'], '2026-08-02T00:00:00.000Z')).toEqual([]);
  });
});
