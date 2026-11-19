// src/lib/db.reorderYieldedFrom.spec201.test.ts — Spec 201 (§7, §12 jest).
//
// The admin reorder mapper (`mapReorderVendor`, reached through
// `fetchReorderSuggestions`) maps the additive per-item envelope key
// `yielded_from_vendors: [{vendor_id, vendor_name}]` to
// `yieldedFromVendors: [{vendorId, vendorName}]`, and an ABSENT key (an old
// server, before migration 20261118120000) to `[]` so the new UI degrades to
// "no line". The diagnostic keys `item_on_hand_source` /
// `on_hand_borrowed_from` are deliberately NOT mapped (§7).
//
// Mocking mirrors db.eodNoNeed.test.ts: rpc().abortSignal() resolves a fixed
// envelope; track(fn) runs the thunk directly.

let rpcResult: { data: any; error: any };
const mockRpc = jest.fn((_fn: string, _args: Record<string, unknown>) => ({
  abortSignal: (_signal: AbortSignal) => Promise.resolve(rpcResult),
}));

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: (fn: string, args: Record<string, unknown>) => mockRpc(fn, args),
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

import { fetchReorderSuggestions } from './db';

function wireItem(over: Record<string, unknown> = {}) {
  return {
    item_id: 'item-f',
    item_name: 'Fryer Oil',
    unit: 'jug',
    on_hand: 4,
    pending_po_qty: 0,
    par_level: 10,
    usage_forecasted: 0,
    par_replacement: 10,
    suggested_qty: 6,
    cost_per_unit: 3,
    estimated_cost: 18,
    case_qty: 1,
    suggested_cases: null,
    suggested_units: 6,
    flags: [],
    other_vendor_count: 1,
    also_from_vendors: [{ vendor_id: 'vendor-b', vendor_name: 'Bravo Supply' }],
    ...over,
  };
}

function envelope(items: Array<Record<string, unknown>>) {
  return {
    as_of_date: '2026-11-16',
    vendors: [
      {
        vendor_id: 'vendor-a',
        vendor_name: 'Alpha Foods',
        schedule_known: true,
        next_delivery_date: '2026-11-17',
        days_until_next_delivery: 1,
        on_hand_source: 'eod',
        eod_submitted_at: '2026-11-16T18:00:00Z',
        items,
        vendor_total_cost: 18,
        has_po: false,
      },
    ],
    kpis: {},
    _warnings: [],
  };
}

describe('db.fetchReorderSuggestions — spec 201 yielded_from_vendors mapping', () => {
  it('maps yielded_from_vendors → yieldedFromVendors (camelCase, order kept)', async () => {
    rpcResult = {
      data: envelope([
        wireItem({
          yielded_from_vendors: [
            { vendor_id: 'vendor-b', vendor_name: 'Bravo Supply' },
            { vendor_id: 'vendor-c', vendor_name: 'Charlie Co' },
          ],
          item_on_hand_source: 'eod',
          on_hand_borrowed_from: { vendor_id: 'vendor-b', vendor_name: 'Bravo Supply' },
        }),
      ]),
      error: null,
    };
    const payload = await fetchReorderSuggestions('store-s', '2026-11-16');
    const it = payload.vendors[0].items[0];
    expect(it.yieldedFromVendors).toEqual([
      { vendorId: 'vendor-b', vendorName: 'Bravo Supply' },
      { vendorId: 'vendor-c', vendorName: 'Charlie Co' },
    ]);
    // Diagnostic keys are not mapped (§7).
    expect(it).not.toHaveProperty('itemOnHandSource');
    expect(it).not.toHaveProperty('onHandBorrowedFrom');
    // The spec-102 keys keep their values (R5).
    expect(it.otherVendorCount).toBe(1);
    expect(it.alsoFromVendors).toEqual([{ vendorId: 'vendor-b', vendorName: 'Bravo Supply' }]);
  });

  it('an empty list maps to []', async () => {
    rpcResult = { data: envelope([wireItem({ yielded_from_vendors: [] })]), error: null };
    const payload = await fetchReorderSuggestions('store-s', '2026-11-16');
    expect(payload.vendors[0].items[0].yieldedFromVendors).toEqual([]);
  });

  it('an ABSENT key (old server) maps to [] — the new UI renders no line', async () => {
    rpcResult = { data: envelope([wireItem()]), error: null };
    const payload = await fetchReorderSuggestions('store-s', '2026-11-16');
    expect(payload.vendors[0].items[0].yieldedFromVendors).toEqual([]);
  });
});
