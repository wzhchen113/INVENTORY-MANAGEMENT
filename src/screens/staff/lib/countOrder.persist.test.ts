// src/screens/staff/lib/countOrder.persist.test.ts — Spec 103 review-fix pass.
//
// Staff-carve-out twin of src/lib/db.saveCountOrder.test.ts. Pins the STAFF
// `saveCountOrder` persist-on-drop path to the DELETE-then-INSERT shape so a
// revert to the broken `.upsert({ onConflict })` (42P10 against the partial
// unique indexes — the spec 103 design's original bug) fails CI on the staff
// side too. The staff helper is authored separately from the admin db.ts helper
// (the documented spec-063 carve-out: the staff subtree calls
// `supabase.from/rpc` directly), so it needs its OWN guard — otherwise only one
// of the two write paths is regression-protected.
//
// Asserts, for BOTH the vendor (`.eq('vendor_id', …)`, staff-eod) and no-vendor
// (`.is('vendor_id', null)`, staff-weekly) branches: `.delete()` is called THEN
// `.insert()`, and `.upsert()` is NEVER called.
//
// Mock shape mirrors the `user_count_orders` channel in
// src/screens/staff/screens/EODCount.test.tsx: a thenable builder (supabase-js
// query builders resolve when awaited). The staff path passes no abort signal
// and no track() wrapper, so the chain is simpler than the admin one — the
// delete builder is awaited directly, and `.insert()` returns an awaitable.

const callLog: string[] = [];

function makeBuilder(): any {
  const builder: any = {
    delete: jest.fn(() => {
      callLog.push('delete');
      return builder;
    }),
    insert: jest.fn(() => {
      callLog.push('insert');
      // The insert leg is awaited directly: `await supabase.from(...).insert(...)`.
      return Promise.resolve({ data: null, error: null });
    }),
    upsert: jest.fn(() => {
      callLog.push('upsert');
      return Promise.resolve({ data: null, error: null });
    }),
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    is: jest.fn(() => builder),
    // The delete leg is awaited directly off the builder (after .eq/.is), so the
    // builder is thenable and resolves the delete result.
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data: null, error: null }),
  };
  return builder;
}

let mockBuilder = makeBuilder();

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => mockBuilder),
  },
}));

import { saveCountOrder } from './countOrder';
import { supabase } from '../../../lib/supabase';

const USER = 'user-A';
const VENDOR = 'vendor-X';

beforeEach(() => {
  jest.clearAllMocks();
  callLog.length = 0;
  mockBuilder = makeBuilder();
  (supabase.from as jest.Mock).mockImplementation(() => mockBuilder);
});

describe('staff saveCountOrder — persist is delete-then-insert (NOT upsert)', () => {
  it('VENDOR branch (staff-eod): deletes then inserts, scopes vendor with .eq, never upserts', async () => {
    await saveCountOrder(USER, 'staff-eod', VENDOR, ['item-2', 'item-1']);

    expect(mockBuilder.upsert).not.toHaveBeenCalled();
    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual(['delete', 'insert']);

    expect(supabase.from).toHaveBeenCalledWith('user_count_orders');
    expect(mockBuilder.eq).toHaveBeenCalledWith('vendor_id', VENDOR);
    expect(mockBuilder.eq).toHaveBeenCalledWith('user_id', USER);
    expect(mockBuilder.eq).toHaveBeenCalledWith('screen', 'staff-eod');
    expect(mockBuilder.is).not.toHaveBeenCalledWith('vendor_id', null);

    expect(mockBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER,
        screen: 'staff-eod',
        vendor_id: VENDOR,
        item_ids: ['item-2', 'item-1'],
      }),
    );
  });

  it('NO-VENDOR branch (staff-weekly): deletes then inserts, scopes vendor with .is(null), never upserts', async () => {
    await saveCountOrder(USER, 'staff-weekly', null, ['item-3', 'item-1']);

    expect(mockBuilder.upsert).not.toHaveBeenCalled();
    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual(['delete', 'insert']);

    expect(mockBuilder.is).toHaveBeenCalledWith('vendor_id', null);
    expect(mockBuilder.eq).not.toHaveBeenCalledWith('vendor_id', null);

    expect(mockBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER,
        screen: 'staff-weekly',
        vendor_id: null,
        item_ids: ['item-3', 'item-1'],
      }),
    );
  });

  it('throws if the DELETE leg errors, without ever calling INSERT', async () => {
    // Make the delete builder reject when awaited.
    mockBuilder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data: null, error: { message: 'delete boom' } });

    await expect(
      saveCountOrder(USER, 'staff-weekly', null, ['item-1']),
    ).rejects.toEqual({ message: 'delete boom' });

    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.insert).not.toHaveBeenCalled();
    expect(mockBuilder.upsert).not.toHaveBeenCalled();
  });
});
