// src/lib/db.saveCountOrder.test.ts — Spec 103 review-fix pass (regression guard).
//
// Pins the persist-on-drop write path of the ADMIN `saveCountOrder` helper to
// the DELETE-then-INSERT shape. This is the exact regression the spec 103
// review flagged as Critical (test-engineer Critical #1 / architect SF-1): the
// design originally specced `.upsert({ onConflict })`, which 42P10s at runtime
// because PostgREST cannot name a PARTIAL unique index's WHERE predicate as the
// ON CONFLICT arbiter. The fix is delete-then-insert. The 42P10 only surfaced
// in a live supabase-js probe — NO automated test would catch a revert to
// `.upsert()`. This file is that guard: it asserts `saveCountOrder` issues a
// `.delete()` THEN an `.insert()` and NEVER calls `.upsert()`, for BOTH the
// vendor (`.eq('vendor_id', …)`) and no-vendor (`.is('vendor_id', null)`)
// branches.
//
// Mocking strategy mirrors db.crossStoreLoaders.test.ts:
//   - jest.mock('./supabase') — a chainable builder whose terminal
//     `.abortSignal()` resolves `{ error: null }`. A shared `callLog` records
//     the order of `delete` / `insert` / `upsert` so ordering is assertable.
//   - jest.mock('./inflight') — `track(fn)` runs the thunk immediately with a
//     throwaway AbortSignal (no real timers in node env).
//   - jest.mock('./auth') — db.ts imports callEdgeFunction; stub to keep the
//     import graph node-safe. Not exercised here.

const callLog: string[] = [];

const mockBuilder: any = {
  delete: jest.fn(() => {
    callLog.push('delete');
    return mockBuilder;
  }),
  insert: jest.fn(() => {
    callLog.push('insert');
    return mockBuilder;
  }),
  // If a regression reintroduces `.upsert({ onConflict })`, this records it and
  // the "never calls upsert" assertions fail.
  upsert: jest.fn(() => {
    callLog.push('upsert');
    return mockBuilder;
  }),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  // Terminal: both the delete and insert legs chain `.abortSignal(signal)` last.
  abortSignal: jest.fn(() => Promise.resolve({ data: null, error: null })),
};

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn(() => mockBuilder),
  },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({
  callEdgeFunction: jest.fn(),
}));

import { saveCountOrder } from './db';
import { supabase } from './supabase';

const USER = 'user-A';
const VENDOR = 'vendor-X';

beforeEach(() => {
  jest.clearAllMocks();
  callLog.length = 0;
  // clearAllMocks wipes mockReturnThis()/return impls — re-arm them.
  mockBuilder.delete.mockImplementation(() => {
    callLog.push('delete');
    return mockBuilder;
  });
  mockBuilder.insert.mockImplementation(() => {
    callLog.push('insert');
    return mockBuilder;
  });
  mockBuilder.upsert.mockImplementation(() => {
    callLog.push('upsert');
    return mockBuilder;
  });
  mockBuilder.select.mockReturnThis();
  mockBuilder.eq.mockReturnThis();
  mockBuilder.is.mockReturnThis();
  mockBuilder.abortSignal.mockImplementation(() =>
    Promise.resolve({ data: null, error: null }),
  );
});

describe('db.saveCountOrder — persist is delete-then-insert (NOT upsert)', () => {
  it('VENDOR branch (admin-eod): deletes then inserts, scopes vendor with .eq, never upserts', async () => {
    await saveCountOrder(USER, 'admin-eod', VENDOR, ['item-2', 'item-1']);

    // The whole feature's regression bar: a revert to `.upsert({ onConflict })`
    // makes this fail.
    expect(mockBuilder.upsert).not.toHaveBeenCalled();
    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).toHaveBeenCalledTimes(1);
    // DELETE strictly precedes INSERT.
    expect(callLog).toEqual(['delete', 'insert']);

    // Both legs hit the count-orders table.
    expect(supabase.from).toHaveBeenCalledWith('user_count_orders');

    // Vendor branch pins the row with `.eq('vendor_id', VENDOR)` (NOT `.is`).
    expect(mockBuilder.eq).toHaveBeenCalledWith('vendor_id', VENDOR);
    expect(mockBuilder.eq).toHaveBeenCalledWith('user_id', USER);
    expect(mockBuilder.eq).toHaveBeenCalledWith('screen', 'admin-eod');
    expect(mockBuilder.is).not.toHaveBeenCalledWith('vendor_id', null);

    // The insert carries the FULL ordered array under the (user, screen, vendor)
    // key.
    expect(mockBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER,
        screen: 'admin-eod',
        vendor_id: VENDOR,
        item_ids: ['item-2', 'item-1'],
      }),
    );
  });

  it('NO-VENDOR branch (admin-inventory): deletes then inserts, scopes vendor with .is(null), never upserts', async () => {
    await saveCountOrder(USER, 'admin-inventory', null, ['item-3', 'item-1']);

    expect(mockBuilder.upsert).not.toHaveBeenCalled();
    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual(['delete', 'insert']);

    // No-vendor branch must use `.is('vendor_id', null)` — `.eq('vendor_id',
    // null)` would not match a NULL row in PostgREST.
    expect(mockBuilder.is).toHaveBeenCalledWith('vendor_id', null);
    expect(mockBuilder.eq).not.toHaveBeenCalledWith('vendor_id', null);

    expect(mockBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER,
        screen: 'admin-inventory',
        vendor_id: null,
        item_ids: ['item-3', 'item-1'],
      }),
    );
  });

  it('throws if the DELETE leg errors, without ever calling INSERT', async () => {
    // First terminal await (the delete) errors; the helper must throw before
    // the insert leg runs.
    mockBuilder.abortSignal
      .mockImplementationOnce(() =>
        Promise.resolve({ data: null, error: { message: 'delete boom' } }),
      )
      .mockImplementation(() => Promise.resolve({ data: null, error: null }));

    await expect(
      saveCountOrder(USER, 'admin-inventory', null, ['item-1']),
    ).rejects.toEqual({ message: 'delete boom' });

    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).not.toHaveBeenCalled();
    expect(mockBuilder.upsert).not.toHaveBeenCalled();
  });
});
