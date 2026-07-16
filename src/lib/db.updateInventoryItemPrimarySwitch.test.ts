// src/lib/db.updateInventoryItemPrimarySwitch.test.ts — Spec 124.
//
// Pins the primary-vendor SWITCH fix in `updateInventoryItem`: on a multi-vendor
// item, changing which vendor is primary and saving used to fail with
// `duplicate key value violates unique constraint "item_vendors_one_primary_per_item"`
// because the batch upsert transiently held two is_primary=true rows. The fix
// issues an `UPDATE item_vendors SET is_primary=false` demote BEFORE the upsert,
// mirroring apply_item_vendors_to_brand's ordering.
//
// These tests mock `supabase.from(...)` and record call order to assert:
//   1. the demote (.update({is_primary:false})) is issued BEFORE the .upsert(...)
//   2. the demote filters item_id, is_primary=true, and vendor_id <> newPrimary
//   3. the primaryVendorId=null variant demotes ALL primaries (no .neq)
//
// Mocking strategy mirrors db.updateVendor.test.ts: chainable per-table builders;
// track(fn) runs the thunk directly with a dummy signal.

type Op = { table: string; op: string; args: any[] };
let opLog: Op[];

function makeBuilder(table: string): any {
  const builder: any = {};
  const chain = (op: string) => (...args: any[]) => {
    opLog.push({ table, op, args });
    return builder;
  };
  builder.select = chain('select');
  builder.update = chain('update');
  builder.upsert = chain('upsert');
  builder.delete = chain('delete');
  builder.eq = chain('eq');
  builder.neq = chain('neq');
  builder.not = chain('not');
  builder.abortSignal = jest.fn().mockResolvedValue({ data: [], error: null });
  builder.single = jest
    .fn()
    .mockResolvedValue({ data: { vendor_id: null, catalog_id: 'catalog-000001' }, error: null });
  return builder;
}

const mockFrom = jest.fn((table: string) => makeBuilder(table));

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

import { updateInventoryItem } from './db';

const ID = 'item-000000001';
const A = 'vendor-aaaaaaaaaa'; // old primary
const B = 'vendor-bbbbbbbbbb'; // new primary

beforeEach(() => {
  jest.clearAllMocks();
  opLog = [];
});

function indexOfItemVendors(pred: (o: Op) => boolean): number {
  return opLog.findIndex((o) => o.table === 'item_vendors' && pred(o));
}

describe('updateInventoryItem — primary-vendor switch demote-before-upsert (Spec 124)', () => {
  it('issues the is_primary=false demote BEFORE the upsert on a primary switch', async () => {
    await updateInventoryItem(ID, {
      vendorId: B,
      vendors: [{ vendorId: A }, { vendorId: B }],
    });

    const demoteIdx = indexOfItemVendors(
      (o) => o.op === 'update' && o.args[0]?.is_primary === false,
    );
    const upsertIdx = indexOfItemVendors((o) => o.op === 'upsert');

    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeLessThan(upsertIdx);
  });

  it('the demote filters item_id, is_primary=true, and vendor_id <> new primary', async () => {
    await updateInventoryItem(ID, {
      vendorId: B,
      vendors: [{ vendorId: A }, { vendorId: B }],
    });

    const itemVendorOps = opLog.filter((o) => o.table === 'item_vendors');
    expect(itemVendorOps).toContainEqual({ table: 'item_vendors', op: 'eq', args: ['item_id', ID] });
    expect(itemVendorOps).toContainEqual({
      table: 'item_vendors',
      op: 'eq',
      args: ['is_primary', true],
    });
    expect(itemVendorOps).toContainEqual({
      table: 'item_vendors',
      op: 'neq',
      args: ['vendor_id', B],
    });
  });

  it('does NOT set updated_at in the demote payload', async () => {
    await updateInventoryItem(ID, {
      vendorId: B,
      vendors: [{ vendorId: A }, { vendorId: B }],
    });

    const demote = opLog.find(
      (o) => o.table === 'item_vendors' && o.op === 'update' && o.args[0]?.is_primary === false,
    );
    expect(demote?.args[0]).toEqual({ is_primary: false });
  });

  it('primaryVendorId=null: demotes ALL primaries (no .neq filter)', async () => {
    // updates.vendorId = '' → vendorId resolves to null → primaryVendorId null,
    // and because updates.vendorId !== undefined no fallback select fires.
    await updateInventoryItem(ID, {
      vendorId: '',
      vendors: [{ vendorId: A }, { vendorId: B }],
    });

    const demoteIdx = indexOfItemVendors(
      (o) => o.op === 'update' && o.args[0]?.is_primary === false,
    );
    expect(demoteIdx).toBeGreaterThanOrEqual(0);

    const neq = opLog.find(
      (o) => o.table === 'item_vendors' && o.op === 'neq' && o.args[0] === 'vendor_id',
    );
    expect(neq).toBeUndefined();
  });

  it('throws when the demote returns an error (optimistic-revert contract)', async () => {
    // Fail the FIRST item_vendors abortSignal (the demote) — mockFrom builds a
    // fresh builder per table, so target item_vendors specifically.
    const itemVendorsBuilders: any[] = [];
    mockFrom.mockImplementation((table: string) => {
      const b = makeBuilder(table);
      if (table === 'item_vendors') {
        itemVendorsBuilders.push(b);
        b.abortSignal = jest
          .fn()
          .mockResolvedValueOnce({ data: null, error: { message: 'demote failed' } });
      }
      return b;
    });

    await expect(
      updateInventoryItem(ID, { vendorId: B, vendors: [{ vendorId: A }, { vendorId: B }] }),
    ).rejects.toEqual({ message: 'demote failed' });
  });
});
