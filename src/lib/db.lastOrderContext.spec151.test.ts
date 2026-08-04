// src/lib/db.lastOrderContext.spec151.test.ts — spec 151 (§10 jest bullet 2).
//
// `mapLastOrderVendor` is module-private, so it is exercised through its public
// caller with a stubbed supabase client — the same boundary
// db.orderApprovalMappers.spec149.test.ts uses.
//
// The load-bearing assertion here is R-10: `ordered_qty_base` /
// `counted_qty_base` must preserve `null` and must NOT be `?? 0`-coerced. A
// reflexive `?? 0` is the single most likely implementation bug in this spec —
// it silently converts AC-8's "NOT ORDERED" into "ORDERED 0" and AC-7's
// omission into "COUNTED 0", type-checks fine, and breaks nothing else.

const mockRpc = jest.fn();

jest.mock('./supabase', () => ({
  supabase: {
    from: () => { throw new Error('db.lastOrderContext test: no table reads expected'); },
    rpc: (...a: unknown[]) => mockRpc(...a),
  },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { fetchLastOrderContext } from './db';

/** The RPC returns `data` plus a chainable `.abortSignal()`. */
function rpcResolves(data: unknown, error: unknown = null) {
  mockRpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data, error }) });
}

const envelope = (vendors: unknown[]) => ({ as_of_date: '2026-08-03', vendors });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('fetchLastOrderContext — RPC call shape (AC-19 / AC-23 / AC-24)', () => {
  it('calls report_last_order_context ONCE with all vendor ids and the as-of date', async () => {
    rpcResolves(envelope([]));
    await fetchLastOrderContext('store-1', ['v-1', 'v-2'], '2026-08-03');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('report_last_order_context', {
      p_store_id: 'store-1',
      p_vendor_ids: ['v-1', 'v-2'],
      p_as_of_date: '2026-08-03',
    });
  });

  it('passes p_as_of_date null when the caller omits it (the RPC defaults)', async () => {
    rpcResolves(envelope([]));
    await fetchLastOrderContext('store-1', ['v-1']);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_as_of_date: null });
  });

  it('AC-22 — over 100 vendors: ONE call with the first 100, plus a warn', async () => {
    rpcResolves(envelope([]));
    const ids = Array.from({ length: 137 }, (_, i) => `v-${i}`);
    await fetchLastOrderContext('store-1', ids);
    // Never a chunked fan-out (AC-23) — one call, truncated to the bound.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][1].p_vendor_ids).toHaveLength(100);
    expect(mockRpc.mock.calls[0][1].p_vendor_ids[0]).toBe('v-0');
    expect(mockRpc.mock.calls[0][1].p_vendor_ids[99]).toBe('v-99');
    expect(console.warn).toHaveBeenCalled();
  });

  it('does NOT swallow an RPC error — the caller decides (AC-17 lives in the slice)', async () => {
    rpcResolves(null, { message: 'boom' });
    await expect(fetchLastOrderContext('store-1', ['v-1'])).rejects.toMatchObject({ message: 'boom' });
  });

  it('tolerates an empty / malformed envelope without throwing', async () => {
    rpcResolves(null);
    await expect(fetchLastOrderContext('store-1', ['v-1'])).resolves.toEqual({});
    rpcResolves({});
    await expect(fetchLastOrderContext('store-1', ['v-1'])).resolves.toEqual({});
  });
});

describe('mapLastOrderVendor — snake → camel (§5.2)', () => {
  it('maps every field and keys BOTH maps for O(1) row lookup', async () => {
    rpcResolves(envelope([
      {
        vendor_id: 'v-1',
        last_order_date: '2026-07-29',
        confidence: 'recorded',
        source: 'order_approval',
        source_id: 'ap-9',
        counted_date: '2026-07-29',
        items_truncated: true,
        items: [
          { item_id: 'i-1', ordered_qty_base: 78, counted_qty_base: 30 },
          { item_id: 'i-2', ordered_qty_base: '12.5', counted_qty_base: '4' },
        ],
      },
    ]));
    const out = await fetchLastOrderContext('store-1', ['v-1']);
    expect(Object.keys(out)).toEqual(['v-1']);
    expect(out['v-1']).toMatchObject({
      vendorId: 'v-1',
      lastOrderDate: '2026-07-29',
      confidence: 'recorded',
      source: 'order_approval',
      sourceId: 'ap-9',
      countedDate: '2026-07-29',
      itemsTruncated: true,
    });
    // Keyed by itemId, not an array.
    expect(out['v-1'].items['i-1']).toEqual({ itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: 30 });
    // PostgREST returns numeric as a STRING — coerced to a number.
    expect(out['v-1'].items['i-2']).toEqual({ itemId: 'i-2', orderedQtyBase: 12.5, countedQtyBase: 4 });
  });

  it('R-10 — preserves null on BOTH quantities and never coerces to 0', async () => {
    rpcResolves(envelope([
      {
        vendor_id: 'v-1',
        last_order_date: '2026-07-29',
        confidence: 'placed',
        source: 'purchase_order',
        source_id: 'po-1',
        counted_date: null,
        items_truncated: false,
        items: [
          { item_id: 'ac7', ordered_qty_base: 12, counted_qty_base: null },   // AC-7
          { item_id: 'ac8', ordered_qty_base: null, counted_qty_base: 4 },    // AC-8
          { item_id: 'zero', ordered_qty_base: 0, counted_qty_base: 0 },      // real zeros
        ],
      },
    ]));
    const items = (await fetchLastOrderContext('store-1', ['v-1']))['v-1'].items;
    expect(items['ac7'].countedQtyBase).toBeNull();
    expect(items['ac8'].orderedQtyBase).toBeNull();
    // A real zero survives as a number — distinguishable from null.
    expect(items['zero']).toEqual({ itemId: 'zero', orderedQtyBase: 0, countedQtyBase: 0 });
  });

  it('narrows unknown confidence/source values to the safe end of the union', async () => {
    rpcResolves(envelope([
      {
        vendor_id: 'v-1',
        last_order_date: '2026-07-29',
        confidence: 'something-new',
        source: 'something-new',
        source_id: 'x',
        counted_date: '',
        items: null,
      },
    ]));
    const v = (await fetchLastOrderContext('store-1', ['v-1']))['v-1'];
    expect(v.confidence).toBe('placed');
    expect(v.source).toBe('purchase_order');
    expect(v.countedDate).toBeNull();
    expect(v.itemsTruncated).toBe(false);
    expect(v.items).toEqual({});
  });

  it('drops a vendor / item row with no id rather than keying on ""', async () => {
    rpcResolves(envelope([
      { vendor_id: '', last_order_date: '2026-07-29', items: [] },
      {
        vendor_id: 'v-1',
        last_order_date: '2026-07-29',
        items: [{ ordered_qty_base: 3 }, { item_id: 'i-1', ordered_qty_base: 3 }],
      },
    ]));
    const out = await fetchLastOrderContext('store-1', ['v-1']);
    expect(Object.keys(out)).toEqual(['v-1']);
    expect(Object.keys(out['v-1'].items)).toEqual(['i-1']);
  });
});
