// src/lib/db.upsertVendorDraftOrder.test.ts — Spec 138 (cart-filler handoff, B1).
//
// Pins db.ts::upsertVendorDraftOrder — the write path the "Fill cart" button
// materializes so the unchanged extension RPCs pick up the hidden draft:
//   • INSERT path — no draft for (store, vendor, referenceDate): insert a fresh
//     `draft` header (status:'draft', total_cost = Σ qty×cost, NO
//     expected_delivery) then the po_items lines with the cost snapshot verbatim.
//   • UPDATE path — a non-cancelled draft exists: replace its lines by
//     INSERT-new-THEN-DELETE-old (the release-proposal fix #3 ordering, so a
//     mid-operation failure never empties a previously-filled draft) and update
//     total_cost. The delete targets exactly the CAPTURED old line ids.
//   • Idempotency key — matches ONLY status='draft'; a 'sent' order for the same
//     key is never mutated (the find returns null → a fresh draft is inserted).
//   • Failure ordering — when the new-line insert fails, the OLD lines are left
//     intact (the delete is never issued) and null is returned.
//
// Mocking mirrors db.poLoop.test.ts: a chainable supabase builder whose terminal
// resolves a scripted {data,error}; inflight.track runs the thunk immediately.

const fromLog: string[] = [];

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
  is: jest.fn(() => mockBuilder),
  in: jest.fn(() => mockBuilder),
  order: jest.fn(() => mockBuilder),
  limit: jest.fn(() => mockBuilder),
  abortSignal: jest.fn(() => {
    // A thenable that ALSO exposes .single()/.maybeSingle() so both the
    // await-directly and the await-after-single/maybeSingle chains resolve the
    // SAME popped terminal (one pop per round-trip).
    const result = nextTerminal();
    const p: any = Promise.resolve(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  }),
  single: jest.fn(() => Promise.resolve(nextTerminal())),
  maybeSingle: jest.fn(() => Promise.resolve(nextTerminal())),
};

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      fromLog.push(table);
      return mockBuilder;
    }),
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

import { upsertVendorDraftOrder } from './db';

function resetBuilder() {
  jest.clearAllMocks();
  fromLog.length = 0;
  terminalQueue = [];
  mockBuilder.insert.mockImplementation(() => mockBuilder);
  mockBuilder.update.mockImplementation(() => mockBuilder);
  mockBuilder.delete.mockImplementation(() => mockBuilder);
  mockBuilder.select.mockImplementation(() => mockBuilder);
  mockBuilder.eq.mockImplementation(() => mockBuilder);
  mockBuilder.is.mockImplementation(() => mockBuilder);
  mockBuilder.in.mockImplementation(() => mockBuilder);
  mockBuilder.order.mockImplementation(() => mockBuilder);
  mockBuilder.limit.mockImplementation(() => mockBuilder);
  mockBuilder.abortSignal.mockImplementation(() => {
    const result = nextTerminal();
    const p: any = Promise.resolve(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  });
  mockBuilder.single.mockImplementation(() => Promise.resolve(nextTerminal()));
  mockBuilder.maybeSingle.mockImplementation(() => Promise.resolve(nextTerminal()));
}

beforeEach(resetBuilder);

const LINES = [
  { itemId: 'item-A', orderedQty: 3, costPerUnitCounted: 12.5 }, // 37.50
  { itemId: 'item-B', orderedQty: 2, costPerUnitCounted: 4 },    //  8.00
];

describe('upsertVendorDraftOrder — INSERT path (no existing draft)', () => {
  it('inserts a fresh draft header (total, NO expected_delivery) then the lines', async () => {
    terminalQueue = [
      { data: null, error: null },           // find → no draft
      { data: { id: 'po-new' }, error: null }, // header insert
      { data: null, error: null },            // lines insert
    ];

    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      createdByUserId: 'user-1',
      referenceDate: '2026-07-22',
      lines: LINES,
    });

    expect(poId).toBe('po-new');
    // find on purchase_orders, header insert on purchase_orders, lines on po_items.
    expect(fromLog).toEqual(['purchase_orders', 'purchase_orders', 'po_items']);

    // Idempotency key matches ONLY status='draft'.
    expect(mockBuilder.eq).toHaveBeenCalledWith('status', 'draft');
    expect(mockBuilder.eq).toHaveBeenCalledWith('reference_date', '2026-07-22');

    // Header: draft + summed total_cost (37.5 + 8 = 45.5), NO expected_delivery.
    const headerArg = mockBuilder.insert.mock.calls[0][0];
    expect(headerArg).toEqual(
      expect.objectContaining({
        store_id: 'store-1',
        vendor_id: 'vendor-1',
        created_by: 'user-1',
        status: 'draft',
        total_cost: 45.5,
        reference_date: '2026-07-22',
      }),
    );
    expect(headerArg).not.toHaveProperty('expected_delivery');

    // Lines: cost snapshot verbatim into cost_per_unit, received_qty null.
    expect(mockBuilder.insert).toHaveBeenNthCalledWith(2, [
      { po_id: 'po-new', item_id: 'item-A', ordered_qty: 3, received_qty: null, cost_per_unit: 12.5 },
      { po_id: 'po-new', item_id: 'item-B', ordered_qty: 2, received_qty: null, cost_per_unit: 4 },
    ]);
  });

  it('creates a NEW draft when only a non-draft (e.g. sent) order exists for the key', async () => {
    // The status='draft' filter means a 'sent' order never matches → find null →
    // insert path. (The find query itself is asserted to scope to draft.)
    terminalQueue = [
      { data: null, error: null },            // find (status=draft) → none
      { data: { id: 'po-2nd' }, error: null }, // header insert
      { data: null, error: null },            // lines insert
    ];
    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      referenceDate: '2026-07-22',
      lines: LINES,
    });
    expect(poId).toBe('po-2nd');
    expect(mockBuilder.eq).toHaveBeenCalledWith('status', 'draft');
    // No po_items delete/read on the insert path.
    expect(mockBuilder.delete).not.toHaveBeenCalled();
  });

  it('matches on a NULL reference_date when none is supplied', async () => {
    terminalQueue = [
      { data: null, error: null },
      { data: { id: 'po-x' }, error: null },
      { data: null, error: null },
    ];
    await upsertVendorDraftOrder({ storeId: 'store-1', vendorId: 'vendor-1', lines: LINES });
    expect(mockBuilder.is).toHaveBeenCalledWith('reference_date', null);
  });

  it('returns null without any query when lines are empty', async () => {
    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      lines: [],
    });
    expect(poId).toBeNull();
    expect(fromLog).toEqual([]);
  });
});

describe('upsertVendorDraftOrder — UPDATE path (existing draft)', () => {
  it('reads old line ids, inserts new lines, deletes ONLY the old ids, updates total', async () => {
    terminalQueue = [
      { data: { id: 'po-existing' }, error: null },       // find → draft exists
      { data: [{ id: 'old-1' }, { id: 'old-2' }], error: null }, // read old line ids
      { data: null, error: null },                         // insert new lines
      { data: null, error: null },                         // delete old lines
      { data: null, error: null },                         // update total
    ];

    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      referenceDate: '2026-07-22',
      lines: LINES,
    });

    expect(poId).toBe('po-existing');
    // Ordering: find(POs) → read old(po_items) → insert new(po_items) →
    // delete old(po_items) → update total(POs). Insert BEFORE delete.
    expect(fromLog).toEqual([
      'purchase_orders', 'po_items', 'po_items', 'po_items', 'purchase_orders',
    ]);

    // The new lines are inserted BEFORE any delete (never delete-then-reinsert).
    expect(mockBuilder.insert).toHaveBeenCalledTimes(1);
    const insertOrder = mockBuilder.insert.mock.invocationCallOrder[0];
    const deleteOrder = mockBuilder.delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(deleteOrder);

    // Delete targets exactly the captured old ids (NOT a blanket po_id delete).
    expect(mockBuilder.in).toHaveBeenCalledWith('id', ['old-1', 'old-2']);
    // total_cost recomputed on the existing header.
    expect(mockBuilder.update).toHaveBeenCalledWith({ total_cost: 45.5 });
  });

  it('leaves the OLD lines intact (no delete issued) when the new-line insert fails', async () => {
    terminalQueue = [
      { data: { id: 'po-existing' }, error: null },   // find → draft exists
      { data: [{ id: 'old-1' }], error: null },        // read old line ids
      { data: null, error: { message: 'insert boom' } }, // insert new lines FAILS
    ];

    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      referenceDate: '2026-07-22',
      lines: LINES,
    });

    expect(poId).toBeNull();
    // Critical: the delete never fired, so the prior lines are NOT lost.
    expect(mockBuilder.delete).not.toHaveBeenCalled();
    // And no total update happened either.
    expect(mockBuilder.update).not.toHaveBeenCalled();
  });

  it('skips the delete when the existing draft had no lines', async () => {
    terminalQueue = [
      { data: { id: 'po-existing' }, error: null }, // find
      { data: [], error: null },                     // read old → none
      { data: null, error: null },                   // insert new
      { data: null, error: null },                   // update total (no delete)
    ];
    const poId = await upsertVendorDraftOrder({
      storeId: 'store-1',
      vendorId: 'vendor-1',
      referenceDate: '2026-07-22',
      lines: LINES,
    });
    expect(poId).toBe('po-existing');
    expect(mockBuilder.delete).not.toHaveBeenCalled();
    expect(mockBuilder.update).toHaveBeenCalledWith({ total_cost: 45.5 });
  });
});
