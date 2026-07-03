// src/lib/db.poLoop.test.ts — Spec 107 (frontend slice).
//
// Pins the db.ts purchase-order-loop helpers:
//   • createPurchaseOrderDraft — header insert (status 'draft') THEN po_items
//     bulk insert; the cost snapshot is stored verbatim (caller passes the
//     per-COUNTED-unit value); total_cost = Σ(orderedQty × costPerUnitCounted);
//     and the orphan-header cleanup fires (delete) when the lines insert errors.
//   • mapPoItemRow (via fetchPurchaseOrderLines) — snake→camel + the
//     inventory_items → catalog_ingredients name/unit/sub_unit_size join.
//   • receivePurchaseOrder — the RPC payload shape (snake-cased lines +
//     p_client_uuid) and the {status, conflict} envelope mapping.
//   • closePurchaseOrderShort / cancelPurchaseOrder — RPC name + arg.
//   • markPurchaseOrderSent — plain UPDATE status='sent'.
//
// Mocking mirrors db.saveCountOrder.test.ts: a chainable supabase builder whose
// terminal resolves a configurable {data,error}; inflight.track runs the thunk
// immediately; auth.callEdgeFunction is stubbed (import-graph node-safety).

const fromLog: string[] = [];

// Queues of results the terminal awaits pop from, so a multi-round-trip helper
// (header insert → lines insert) can be scripted call-by-call.
let terminalQueue: Array<{ data: any; error: any }> = [];
function nextTerminal() {
  return terminalQueue.length > 0 ? terminalQueue.shift()! : { data: null, error: null };
}

const mockBuilder: any = {
  insert: jest.fn(() => mockBuilder),
  update: jest.fn(() => mockBuilder),
  delete: jest.fn(() => mockBuilder),
  select: jest.fn(() => mockBuilder),
  eq: jest.fn(() => mockBuilder),
  // Terminal shapes:
  //   • header insert:   .select('id').abortSignal(signal).single()
  //   • lines insert:    .insert(...).abortSignal(signal)
  //   • update:          .update(...).eq(...).abortSignal(signal)
  //   • fetch lines:     .select(...).eq(...).abortSignal(signal)
  abortSignal: jest.fn(() => {
    // When a .single() follows, abortSignal must return the builder so .single()
    // can be the terminal. When it IS terminal, it must be awaitable. Return a
    // thenable that ALSO exposes .single() — covers both chains.
    const result = nextTerminal();
    const p: any = Promise.resolve(result);
    p.single = () => Promise.resolve(result);
    return p;
  }),
  single: jest.fn(() => Promise.resolve(nextTerminal())),
};

const mockRpc = jest.fn((_name?: string, _params?: unknown) => ({
  abortSignal: jest.fn(() => Promise.resolve(nextTerminal())),
}));

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      fromLog.push(table);
      return mockBuilder;
    }),
    rpc: (name: string, params: unknown) => mockRpc(name, params),
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

import {
  createPurchaseOrderDraft,
  fetchPurchaseOrderLines,
  receivePurchaseOrder,
  closePurchaseOrderShort,
  cancelPurchaseOrder,
  markPurchaseOrderSent,
} from './db';
import { supabase } from './supabase';

beforeEach(() => {
  jest.clearAllMocks();
  fromLog.length = 0;
  terminalQueue = [];
  mockBuilder.insert.mockImplementation(() => mockBuilder);
  mockBuilder.update.mockImplementation(() => mockBuilder);
  mockBuilder.delete.mockImplementation(() => mockBuilder);
  mockBuilder.select.mockImplementation(() => mockBuilder);
  mockBuilder.eq.mockImplementation(() => mockBuilder);
  mockBuilder.abortSignal.mockImplementation(() => {
    const result = nextTerminal();
    const p: any = Promise.resolve(result);
    p.single = () => Promise.resolve(result);
    return p;
  });
  mockBuilder.single.mockImplementation(() => Promise.resolve(nextTerminal()));
  mockRpc.mockImplementation((_name?: string, _params?: unknown) => ({
    abortSignal: jest.fn(() => Promise.resolve(nextTerminal())),
  }));
});

describe('createPurchaseOrderDraft — header(draft) then po_items lines', () => {
  it('inserts a draft header with the correct total_cost then the lines with the cost snapshot', async () => {
    // Round 1: header insert returns the new id. Round 2: lines insert ok.
    terminalQueue = [
      { data: { id: 'po-1' }, error: null },
      { data: null, error: null },
    ];

    const poId = await createPurchaseOrderDraft({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      createdByUserId: 'user-1',
      referenceDate: '2026-07-03',
      lines: [
        { itemId: 'item-A', orderedQty: 3, costPerUnitCounted: 12.5 }, // 37.50
        { itemId: 'item-B', orderedQty: 2, costPerUnitCounted: 4 },    //  8.00
      ],
    });

    expect(poId).toBe('po-1');

    // First from() is the header on purchase_orders; second is po_items.
    expect(fromLog).toEqual(['purchase_orders', 'po_items']);

    // Header carries status:'draft' + summed total_cost (37.5 + 8 = 45.5).
    expect(mockBuilder.insert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        store_id: 'store-1',
        vendor_id: 'vendor-1',
        created_by: 'user-1',
        status: 'draft',
        total_cost: 45.5,
        reference_date: '2026-07-03',
      }),
    );

    // Lines carry the per-COUNTED-unit cost snapshot verbatim into cost_per_unit,
    // ordered_qty from the caller, received_qty null (nothing received yet).
    expect(mockBuilder.insert).toHaveBeenNthCalledWith(2, [
      { po_id: 'po-1', item_id: 'item-A', ordered_qty: 3, received_qty: null, cost_per_unit: 12.5 },
      { po_id: 'po-1', item_id: 'item-B', ordered_qty: 2, received_qty: null, cost_per_unit: 4 },
    ]);
  });

  it('best-effort deletes the orphan header when the lines insert errors, and returns null', async () => {
    terminalQueue = [
      { data: { id: 'po-2' }, error: null },              // header ok
      { data: null, error: { message: 'lines boom' } },   // lines fail
      { data: null, error: null },                        // cleanup delete
    ];

    const poId = await createPurchaseOrderDraft({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      lines: [{ itemId: 'item-A', orderedQty: 1, costPerUnitCounted: 1 }],
    });

    expect(poId).toBeNull();
    // Cleanup: a delete on purchase_orders scoped to the orphan id.
    expect(mockBuilder.delete).toHaveBeenCalledTimes(1);
    expect(mockBuilder.eq).toHaveBeenCalledWith('id', 'po-2');
    expect(fromLog).toEqual(['purchase_orders', 'po_items', 'purchase_orders']);
  });

  it('returns null without any insert when there are no lines', async () => {
    const poId = await createPurchaseOrderDraft({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      lines: [],
    });
    expect(poId).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('mapPoItemRow (via fetchPurchaseOrderLines) — snake→camel + catalog join', () => {
  it('maps ordered/received/cost + item name/unit/subUnitSize from the join', async () => {
    terminalQueue = [
      {
        data: [
          {
            id: 'poi-1',
            item_id: 'item-A',
            ordered_qty: 6,
            received_qty: 2,
            cost_per_unit: 3.25,
            inventory_items: { catalog_id: 'cat-A', catalog_ingredients: { name: 'Flour', unit: 'lbs', sub_unit_size: 4 } },
          },
          {
            id: 'poi-2',
            item_id: 'item-B',
            ordered_qty: 1,
            received_qty: null, // → 0
            cost_per_unit: null, // → 0
            inventory_items: null, // → name/unit '', subUnitSize 1
          },
        ],
        error: null,
      },
    ];

    const lines = await fetchPurchaseOrderLines('po-1');
    expect(lines).toEqual([
      { poItemId: 'poi-1', itemId: 'item-A', itemName: 'Flour', unit: 'lbs', orderedQty: 6, receivedQty: 2, costPerUnit: 3.25, subUnitSize: 4 },
      { poItemId: 'poi-2', itemId: 'item-B', itemName: '', unit: '', orderedQty: 1, receivedQty: 0, costPerUnit: 0, subUnitSize: 1 },
    ]);
    expect(fromLog).toEqual(['po_items']);
  });

  it('returns [] on error', async () => {
    terminalQueue = [{ data: null, error: { message: 'boom' } }];
    const lines = await fetchPurchaseOrderLines('po-1');
    expect(lines).toEqual([]);
  });
});

describe('receivePurchaseOrder — RPC payload + envelope', () => {
  it('snake-cases the lines, passes p_client_uuid, and maps {status, conflict}', async () => {
    terminalQueue = [{ data: { po_id: 'po-1', status: 'partial', conflict: false, lines: [] }, error: null }];

    const res = await receivePurchaseOrder(
      'po-1',
      [
        { poItemId: 'poi-1', receivedQty: 4 },
        { poItemId: 'poi-2', receivedQty: 0 },
      ],
      'uuid-123',
    );

    expect(res).toEqual({ status: 'partial', conflict: false });
    expect(mockRpc).toHaveBeenCalledWith('receive_purchase_order', {
      p_po_id: 'po-1',
      p_lines: [
        { po_item_id: 'poi-1', received_qty: 4 },
        { po_item_id: 'poi-2', received_qty: 0 },
      ],
      p_client_uuid: 'uuid-123',
    });
  });

  it('surfaces conflict:true from an idempotent replay', async () => {
    terminalQueue = [{ data: { po_id: 'po-1', status: 'received', conflict: true, lines: [] }, error: null }];
    const res = await receivePurchaseOrder('po-1', [{ poItemId: 'poi-1', receivedQty: 1 }], 'uuid-dupe');
    expect(res).toEqual({ status: 'received', conflict: true });
  });

  it('throws when the RPC errors', async () => {
    terminalQueue = [{ data: null, error: { message: 'not authorized' } }];
    await expect(
      receivePurchaseOrder('po-1', [{ poItemId: 'poi-1', receivedQty: 1 }], 'uuid-1'),
    ).rejects.toEqual({ message: 'not authorized' });
  });
});

describe('close-short / cancel — RPC name + arg', () => {
  it('closePurchaseOrderShort calls close_short_purchase_order and returns status', async () => {
    terminalQueue = [{ data: { po_id: 'po-1', status: 'received' }, error: null }];
    const status = await closePurchaseOrderShort('po-1');
    expect(status).toBe('received');
    expect(mockRpc).toHaveBeenCalledWith('close_short_purchase_order', { p_po_id: 'po-1' });
  });

  it('cancelPurchaseOrder calls cancel_purchase_order and returns status', async () => {
    terminalQueue = [{ data: { po_id: 'po-1', status: 'cancelled' }, error: null }];
    const status = await cancelPurchaseOrder('po-1');
    expect(status).toBe('cancelled');
    expect(mockRpc).toHaveBeenCalledWith('cancel_purchase_order', { p_po_id: 'po-1' });
  });
});

describe('markPurchaseOrderSent — plain UPDATE status=sent', () => {
  it('updates status to sent scoped to the po id', async () => {
    terminalQueue = [{ data: null, error: null }];
    const ok = await markPurchaseOrderSent('po-1');
    expect(ok).toBe(true);
    expect(fromLog).toEqual(['purchase_orders']);
    expect(mockBuilder.update).toHaveBeenCalledWith({ status: 'sent' });
    expect(mockBuilder.eq).toHaveBeenCalledWith('id', 'po-1');
  });
});
