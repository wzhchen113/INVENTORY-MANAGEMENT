// src/lib/db.deletePoItem.test.ts — Spec 194 (kept-records delete hardening).
//
// Pins db.ts::deletePoItem's row-count check. The RESTRICTIVE policy
// `po_items_restrict_delete_non_draft` refuses a line delete under a PO that is
// no longer a draft SILENTLY (0 rows, no error), so the client asks for an
// exact count and turns an explicit 0 into a thrown Error. That throw is what
// lets useStore.removePoLine restore the line and toast "Remove PO line".
//   • delete is requested with { count: 'exact' } and scoped by .eq('id', …)
//   • count 1         → resolves true
//   • count 0         → rejects with the D-3 message
//   • PostgREST error → rejects with that error
//   • count undefined → resolves true (pre-spec-194 behaviour kept)
//
// Mocking mirrors db.upsertVendorDraftOrder.test.ts: a chainable builder whose
// abortSignal terminal resolves a scripted result; inflight.track runs the thunk.

let terminal: { data: any; error: any; count?: number | null } = { data: null, error: null };

const mockBuilder: any = {
  delete: jest.fn(() => mockBuilder),
  eq: jest.fn(() => mockBuilder),
  abortSignal: jest.fn(() => Promise.resolve(terminal)),
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

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { deletePoItem } from './db';
import { supabase } from './supabase';

const REFUSED_MESSAGE = 'PO line was not removed. The order may no longer be a draft.';

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockBuilder.delete.mockImplementation(() => mockBuilder);
  mockBuilder.eq.mockImplementation(() => mockBuilder);
  mockBuilder.abortSignal.mockImplementation(() => Promise.resolve(terminal));
  terminal = { data: null, error: null };
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('deletePoItem — spec 194 row-count check', () => {
  it('requests an exact count and scopes the delete to the line id', async () => {
    terminal = { data: null, error: null, count: 1 };
    await deletePoItem('line-1');
    expect(supabase.from).toHaveBeenCalledWith('po_items');
    expect(mockBuilder.delete).toHaveBeenCalledWith({ count: 'exact' });
    expect(mockBuilder.eq).toHaveBeenCalledWith('id', 'line-1');
  });

  it('resolves true when one row was deleted', async () => {
    terminal = { data: null, error: null, count: 1 };
    await expect(deletePoItem('line-1')).resolves.toBe(true);
  });

  it('rejects with the refusal message when the delete hit 0 rows', async () => {
    terminal = { data: null, error: null, count: 0 };
    await expect(deletePoItem('line-1')).rejects.toThrow(REFUSED_MESSAGE);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Supabase] deletePoItem: 0 rows (PO not a draft, or line already gone)',
    );
  });

  it('rejects with the PostgREST error when the request fails', async () => {
    const err = { message: 'permission denied for table po_items', code: '42501' };
    terminal = { data: null, error: err, count: null };
    await expect(deletePoItem('line-1')).rejects.toBe(err);
  });

  it('resolves true when no count comes back (pre-spec-194 behaviour)', async () => {
    terminal = { data: null, error: null };
    await expect(deletePoItem('line-1')).resolves.toBe(true);
  });
});
