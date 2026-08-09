// src/lib/db.updateStore.test.ts — Spec 083 (store-deactivation-toggle) Track 1 (jest).
//
// Unit-tests the two new db.ts STORES helpers added by spec 083:
//   - fetchStoresIncludingInactive(): a SELECT with NO `.eq('status','active')`
//     filter (so the admin Stores tab can render inactive rows), with the same
//     snake_case→camelCase mapping as fetchStores.
//   - updateStore(id, updates): a partial PostgREST UPDATE that maps only the
//     keys present on `updates` (name/address/eodDeadlineTime/status). brandId
//     is intentionally NOT writable. The privileged_update_stores RLS policy
//     enforces the role gate server-side, so this is a plain UPDATE, not an RPC.
//
// Mocking strategy mirrors db.fetchInvitationsForUserLookup.test.ts:
//   - jest.mock('./supabase') — supabase.from('stores') returns a FRESH
//     chainable builder. `select`/`update`/`eq` are tracked jest.fns so the
//     mechanism arms can assert what was (and was NOT) called. The terminal
//     `.abortSignal()` resolves to the per-test result.
//   - jest.mock('./inflight') — track(fn) invokes fn directly with a dummy
//     AbortSignal so the real 30s timers never arm in node.
//   - jest.mock('./auth') — db.ts imports callEdgeFunction from it; stub so the
//     import graph stays light. Not exercised here.

// A single persistent builder shared across all from('stores') calls within a
// test. The spies are stable references (reset in beforeEach) so a test can set
// abortSpy.mockResolvedValue(...) BEFORE invoking the function under test. The
// terminal `.abortSignal()` resolves to whatever the test configured.
let selectSpy: jest.Mock;
let updateSpy: jest.Mock;
let eqSpy: jest.Mock;
let abortSpy: jest.Mock;
let builder: any;

const mockFrom = jest.fn((table: string) => {
  if (table === 'stores') return builder;
  throw new Error(`unexpected table in db.updateStore test: ${table}`);
});

jest.mock('./supabase', () => ({
  supabase: { from: (table: string) => mockFrom(table) },
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

import { fetchStoresIncludingInactive, updateStore } from './db';

beforeEach(() => {
  jest.clearAllMocks();
  selectSpy = jest.fn().mockReturnThis();
  updateSpy = jest.fn().mockReturnThis();
  eqSpy = jest.fn().mockReturnThis();
  abortSpy = jest.fn().mockResolvedValue({ data: [], error: null });
  builder = {
    select: selectSpy,
    update: updateSpy,
    eq: eqSpy,
    abortSignal: abortSpy,
  };
});

describe('fetchStoresIncludingInactive — spec 083', () => {
  it('returns both active and inactive stores, mapped snake→camel', async () => {
    abortSpy.mockResolvedValue({
      data: [
        { id: 's1', brand_id: 'b1', name: 'Active Store', address: '1 Main', status: 'active', eod_deadline_time: '23:00', weekly_count_due_dow: 5 },
        { id: 's2', brand_id: 'b1', name: 'Closed Store', address: '2 Oak', status: 'inactive', eod_deadline_time: null, weekly_count_due_dow: null },
      ],
      error: null,
    });

    const result = await fetchStoresIncludingInactive();

    // Spec 098 — the store projection now carries weeklyCountDueDow
    // (snake weekly_count_due_dow → camel; null when no cadence set).
    // Spec 149 — and `postalCode` (snake postal_code → camel), null when the
    // column is absent/unset, which is what puts the store on the fallback
    // order channel rather than the Instacart one.
    expect(result).toEqual([
      { id: 's1', brandId: 'b1', name: 'Active Store', address: '1 Main', status: 'active', eodDeadlineTime: '23:00', weeklyCountDueDow: 5, postalCode: null },
      { id: 's2', brandId: 'b1', name: 'Closed Store', address: '2 Oak', status: 'inactive', eodDeadlineTime: undefined, weeklyCountDueDow: null, postalCode: null },
    ]);
  });

  it('does NOT apply a status filter (the whole point vs fetchStores)', async () => {
    abortSpy.mockResolvedValue({ data: [], error: null });

    await fetchStoresIncludingInactive();

    expect(mockFrom).toHaveBeenCalledWith('stores');
    expect(selectSpy).toHaveBeenCalledWith('*');
    // No .eq('status', …) — the include-inactive path must NOT filter by status.
    const statusEqCalls = eqSpy.mock.calls.filter((args) => args[0] === 'status');
    expect(statusEqCalls).toHaveLength(0);
  });

  it('throws on a PostgREST error', async () => {
    abortSpy.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(fetchStoresIncludingInactive()).rejects.toEqual({ message: 'boom' });
  });
});

describe('updateStore — spec 083', () => {
  it('maps status into the UPDATE body and filters by id', async () => {

    await updateStore('s2', { status: 'inactive' });

    expect(mockFrom).toHaveBeenCalledWith('stores');
    expect(updateSpy).toHaveBeenCalledWith({ status: 'inactive' });
    expect(eqSpy).toHaveBeenCalledWith('id', 's2');
  });

  it('maps name/address/eodDeadlineTime to their snake_case columns', async () => {

    await updateStore('s1', { name: 'New Name', address: '9 Elm', eodDeadlineTime: '22:30' });

    expect(updateSpy).toHaveBeenCalledWith({
      name: 'New Name',
      address: '9 Elm',
      eod_deadline_time: '22:30',
    });
  });

  it('only maps keys present on updates (no undefined clobber)', async () => {

    await updateStore('s1', { status: 'active' });

    const body = updateSpy.mock.calls[0][0];
    expect(body).toEqual({ status: 'active' });
    expect('name' in body).toBe(false);
    expect('address' in body).toBe(false);
    expect('eod_deadline_time' in body).toBe(false);
  });

  it('does NOT write brand_id even if a brandId-shaped key is passed', async () => {

    // brandId is not in the typed surface, but cast to prove the mapper drops it.
    await updateStore('s1', { status: 'inactive', brandId: 'b2' } as any);

    const body = updateSpy.mock.calls[0][0];
    expect('brand_id' in body).toBe(false);
    expect('brandId' in body).toBe(false);
  });

  it('throws on a PostgREST error so the caller can revert', async () => {
    abortSpy.mockResolvedValue({ error: { message: 'rls denied' } });
    await expect(updateStore('s1', { status: 'inactive' })).rejects.toEqual({ message: 'rls denied' });
  });
});

// ── Spec 155 DG-2 — the store-ZIP edit path ─────────────────────────────────
//
// `postalCode` has been in the typed Pick<> since spec 149, but nothing wrote
// it: the create drawer was the only producer and useStore.updateStore dropped
// it. The edit drawer now sends it on every save, so the snake_case mapping and
// the '' ⇒ null coercion are load-bearing — a blank reaching the column as ''
// would make `stores.postal_code` non-null-but-useless to the retailers probe.

describe('updateStore — postalCode mapping (spec 155)', () => {
  it('maps postalCode → postal_code', async () => {
    await updateStore('s1', { postalCode: '21204' });

    expect(updateSpy).toHaveBeenCalledWith({ postal_code: '21204' });
  });

  it('passes ZIP+4 through verbatim (OQ-7 — no truncation client-side)', async () => {
    await updateStore('s1', { postalCode: '21204-1234' });

    expect(updateSpy).toHaveBeenCalledWith({ postal_code: '21204-1234' });
  });

  it('an explicit null clears the column', async () => {
    await updateStore('s1', { postalCode: null });

    expect(updateSpy).toHaveBeenCalledWith({ postal_code: null });
  });

  it('an empty string is coerced to null, never stored as ""', async () => {
    await updateStore('s1', { postalCode: '' });

    expect(updateSpy).toHaveBeenCalledWith({ postal_code: null });
  });

  it('rides along with name/address in ONE PATCH (the drawer submits all three)', async () => {
    await updateStore('s1', { name: 'Towson', address: '1234 York Rd', postalCode: '21204' });

    expect(updateSpy).toHaveBeenCalledWith({
      name: 'Towson',
      address: '1234 York Rd',
      postal_code: '21204',
    });
    expect(eqSpy).toHaveBeenCalledWith('id', 's1');
  });

  it('an omitted postalCode never clobbers the stored value', async () => {
    await updateStore('s1', { name: 'Towson' });

    const body = updateSpy.mock.calls[0][0];
    expect('postal_code' in body).toBe(false);
  });
});
