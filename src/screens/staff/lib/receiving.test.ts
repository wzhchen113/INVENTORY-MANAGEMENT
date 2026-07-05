// src/screens/staff/lib/receiving.test.ts — Spec 113 §4 (frontend slice).
//
// The staff receiving data + RPC carve-out. Mocks the supabase client boundary →
// asserts:
//   - fetchStaffOpenPos reads purchase_orders (status IN sent|partial, newest
//     first) and maps the vendor join → vendorName.
//   - fetchStaffPoLines reads po_items joined through inventory_items →
//     catalog_ingredients, mapping name/unit/i18n_names, and NEVER selects or maps
//     a price/cost column (R-1).
//   - submitStaffReceive calls receive_purchase_order with EXACTLY
//     { po_item_id, received_qty } per line — NO new_case_price key ever present
//     (the R-1 belt-and-braces contract), reads back status + conflict, and
//     propagates (throws) an RPC error incl. the AC-2 42501.
//   - the pure buildReceiveDeltas / outstandingRemainder helpers.

const mockRpc = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  buildReceiveDeltas,
  fetchStaffOpenPos,
  fetchStaffPoLines,
  outstandingRemainder,
  submitStaffReceive,
} from './receiving';

beforeEach(() => {
  jest.clearAllMocks();
});

// ── fetchStaffOpenPos ────────────────────────────────────────────────
describe('fetchStaffOpenPos', () => {
  // The read is `.from('purchase_orders').select(...).eq(...).in(...).order(...)`
  // awaited directly, so build a thenable chain that captures each call.
  function mockPoChain(rows: unknown[], error: unknown = null) {
    const order = jest.fn().mockResolvedValue({ data: rows, error });
    const inFn = jest.fn().mockReturnValue({ order });
    const eq = jest.fn().mockReturnValue({ in: inFn });
    const select = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });
    return { select, eq, in: inFn, order };
  }

  it('reads purchase_orders filtered to sent|partial, newest-first, mapping the vendor join', async () => {
    const { select, eq, in: inFn, order } = mockPoChain([
      {
        id: 'po-1',
        status: 'sent',
        reference_date: '2026-07-03',
        created_at: '2026-07-03T10:00:00Z',
        vendors: { name: 'Acme' },
      },
      {
        id: 'po-2',
        status: 'partial',
        reference_date: null,
        created_at: '2026-07-02T10:00:00Z',
        vendors: { name: 'Beta' },
      },
    ]);

    const result = await fetchStaffOpenPos('store-1');

    expect(mockFrom).toHaveBeenCalledWith('purchase_orders');
    expect(select).toHaveBeenCalledWith('id, status, reference_date, created_at, vendors(name)');
    expect(eq).toHaveBeenCalledWith('store_id', 'store-1');
    expect(inFn).toHaveBeenCalledWith('status', ['sent', 'partial']);
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });

    expect(result).toEqual([
      { id: 'po-1', status: 'sent', vendorName: 'Acme', referenceDate: '2026-07-03', createdAt: '2026-07-03T10:00:00Z' },
      { id: 'po-2', status: 'partial', vendorName: 'Beta', referenceDate: null, createdAt: '2026-07-02T10:00:00Z' },
    ]);
  });

  it('handles an array-shaped vendor join and a missing vendor (empty vendorName)', async () => {
    mockPoChain([
      { id: 'po-1', status: 'sent', reference_date: null, created_at: '2026-07-03T10:00:00Z', vendors: [{ name: 'Gamma' }] },
      { id: 'po-2', status: 'sent', reference_date: null, created_at: '2026-07-02T10:00:00Z', vendors: null },
    ]);
    const result = await fetchStaffOpenPos('store-1');
    expect(result[0].vendorName).toBe('Gamma');
    expect(result[1].vendorName).toBe('');
  });

  it('returns [] when the store has no open POs (RLS 0 rows is not an error)', async () => {
    mockPoChain([]);
    expect(await fetchStaffOpenPos('store-1')).toEqual([]);
  });

  it('throws (propagates) a PostgREST RLS error (42501) rather than swallowing', async () => {
    mockPoChain([], { code: '42501', message: 'permission denied' });
    await expect(fetchStaffOpenPos('store-x')).rejects.toMatchObject({ code: '42501' });
  });
});

// ── fetchStaffPoLines ────────────────────────────────────────────────
describe('fetchStaffPoLines', () => {
  // `.from('po_items').select(...).eq(...)` awaited directly.
  function mockLineChain(rows: unknown[], error: unknown = null) {
    const eq = jest.fn().mockResolvedValue({ data: rows, error });
    const select = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });
    return { select, eq };
  }

  it('reads po_items joined through inventory_items → catalog_ingredients and maps name/unit/i18n', async () => {
    const { select, eq } = mockLineChain([
      {
        id: 'poi-1',
        item_id: 'item-1',
        ordered_qty: 10,
        received_qty: 3,
        inventory_items: {
          catalog_id: 'cat-1',
          catalog_ingredients: { name: 'Buns', unit: 'each', i18n_names: { es: 'Panecillos' } },
        },
      },
    ]);

    const result = await fetchStaffPoLines('po-1');

    expect(mockFrom).toHaveBeenCalledWith('po_items');
    expect(eq).toHaveBeenCalledWith('po_id', 'po-1');
    // R-1: the projection selects NO price/cost column — assert the exact string.
    const projection = select.mock.calls[0][0] as string;
    expect(projection).toBe(
      'id, item_id, ordered_qty, received_qty, inventory_items(catalog_id, catalog_ingredients(name, unit, i18n_names))',
    );
    expect(projection).not.toMatch(/cost_per_unit/);
    expect(projection).not.toMatch(/case_price/);
    expect(projection).not.toMatch(/sub_unit_size/);

    expect(result).toEqual([
      {
        poItemId: 'poi-1',
        itemId: 'item-1',
        itemName: 'Buns',
        unit: 'each',
        orderedQty: 10,
        receivedQty: 3,
        i18nNames: { es: 'Panecillos' },
      },
    ]);
  });

  it('coalesces null ordered/received to 0, missing catalog to empty strings, missing i18n to {}', async () => {
    mockLineChain([
      {
        id: 'poi-1',
        item_id: 'item-1',
        ordered_qty: null,
        received_qty: null,
        // array-shaped inventory_items + array-shaped catalog with no i18n key.
        inventory_items: [{ catalog_id: 'cat-1', catalog_ingredients: [{ name: 'Salt', unit: 'oz' }] }],
      },
      {
        id: 'poi-2',
        item_id: 'item-2',
        ordered_qty: 5,
        received_qty: 0,
        inventory_items: null,
      },
    ]);
    const result = await fetchStaffPoLines('po-1');
    expect(result[0]).toMatchObject({ orderedQty: 0, receivedQty: 0, itemName: 'Salt', unit: 'oz', i18nNames: {} });
    // No inventory_items join → empty name/unit + {} i18n.
    expect(result[1]).toMatchObject({ orderedQty: 5, receivedQty: 0, itemName: '', unit: '', i18nNames: {} });
  });

  it('throws on a PostgREST error', async () => {
    mockLineChain([], { code: '42501', message: 'permission denied' });
    await expect(fetchStaffPoLines('po-x')).rejects.toMatchObject({ code: '42501' });
  });
});

// ── submitStaffReceive ───────────────────────────────────────────────
describe('submitStaffReceive', () => {
  it('calls receive_purchase_order with EXACTLY { po_item_id, received_qty } per line — NEVER a price key', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'received', conflict: false, price_changes: [] }, error: null });

    await submitStaffReceive(
      'po-1',
      [
        { poItemId: 'poi-1', receivedQty: 4 },
        { poItemId: 'poi-2', receivedQty: 2 },
      ],
      'uuid-123',
    );

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('receive_purchase_order');
    expect(args.p_po_id).toBe('po-1');
    expect(args.p_client_uuid).toBe('uuid-123');
    // The R-1 belt: EVERY line object has EXACTLY two keys, and no price key
    // (new_case_price / newCasePrice) appears anywhere in the payload.
    expect(args.p_lines).toEqual([
      { po_item_id: 'poi-1', received_qty: 4 },
      { po_item_id: 'poi-2', received_qty: 2 },
    ]);
    for (const line of args.p_lines) {
      expect(Object.keys(line).sort()).toEqual(['po_item_id', 'received_qty']);
      expect(line).not.toHaveProperty('new_case_price');
      expect(line).not.toHaveProperty('newCasePrice');
    }
    // Belt-and-braces: no price token anywhere in the serialized payload.
    expect(JSON.stringify(args)).not.toMatch(/price/i);
  });

  it('reads back status + conflict from the envelope (ignoring price_changes)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'partial', conflict: false, price_changes: [] },
      error: null,
    });
    const res = await submitStaffReceive('po-1', [{ poItemId: 'poi-1', receivedQty: 1 }], 'u1');
    expect(res).toEqual({ status: 'partial', conflict: false });
  });

  it('surfaces a conflict:true replay as { conflict: true } (success-no-reapply, not an error)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'received', conflict: true, price_changes: [] },
      error: null,
    });
    const res = await submitStaffReceive('po-1', [{ poItemId: 'poi-1', receivedQty: 8 }], 'u1');
    expect(res).toEqual({ status: 'received', conflict: true });
  });

  it('propagates (throws) an RPC error — including the AC-2 42501 price-gate refusal', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'forbidden: price change requires admin' },
    });
    await expect(
      submitStaffReceive('po-1', [{ poItemId: 'poi-1', receivedQty: 8 }], 'u1'),
    ).rejects.toMatchObject({ code: '42501', message: 'forbidden: price change requires admin' });
  });
});

// ── pure helpers ─────────────────────────────────────────────────────
describe('buildReceiveDeltas', () => {
  it('drops blank / zero / negative rows and keeps only positive receives', () => {
    const lines = [{ poItemId: 'a' }, { poItemId: 'b' }, { poItemId: 'c' }, { poItemId: 'd' }, { poItemId: 'e' }];
    const inputs = { a: '5', b: '', c: '0', d: '-2', e: '  3.5 ' };
    expect(buildReceiveDeltas(lines, inputs)).toEqual([
      { poItemId: 'a', receivedQty: 5 },
      { poItemId: 'e', receivedQty: 3.5 },
    ]);
  });

  it('never emits a price key on any delta (the carve-out-never-sends-price contract)', () => {
    const lines = [{ poItemId: 'a' }, { poItemId: 'b' }];
    const deltas = buildReceiveDeltas(lines, { a: '4', b: '2' });
    for (const d of deltas) {
      expect(Object.keys(d).sort()).toEqual(['poItemId', 'receivedQty']);
      expect(d).not.toHaveProperty('newCasePrice');
      expect(d).not.toHaveProperty('new_case_price');
    }
  });

  it('returns [] when every input is blank/zero (the nothing-to-receive case)', () => {
    const lines = [{ poItemId: 'a' }, { poItemId: 'b' }];
    expect(buildReceiveDeltas(lines, { a: '', b: '0' })).toEqual([]);
    expect(buildReceiveDeltas(lines, {})).toEqual([]);
  });
});

describe('outstandingRemainder', () => {
  it('is max(0, ordered − received)', () => {
    expect(outstandingRemainder({ orderedQty: 10, receivedQty: 3 })).toBe(7);
    expect(outstandingRemainder({ orderedQty: 5, receivedQty: 5 })).toBe(0);
    // Over-received clamps to 0 (never negative).
    expect(outstandingRemainder({ orderedQty: 4, receivedQty: 9 })).toBe(0);
  });
});
