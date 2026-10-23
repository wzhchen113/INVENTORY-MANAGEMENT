// src/lib/db.eodCountMode.test.ts — Spec 171 (AC-18, AC-19; design §6).
//
// Pins the db.ts read/write mapping for catalog_ingredients.eod_count_mode:
//   1. fetchInventory's `catalog:` embed selects eod_count_mode, and mapItem
//      hydrates camelCase `eodCountMode` (passthrough; missing/unknown →
//      'cases_and_units').
//   2. updateInventoryItem sends eod_count_mode on the catalog-level update
//      ONLY when the key is present (omit-key-to-skip).
//   3. createInventoryItem passes p_eod_count_mode to the RPC (normalized),
//      and the RPC's returned catalog.eod_count_mode hydrates the mapped row.
//
// Mocking strategy mirrors db.updateInventoryItemPrimarySwitch.test.ts:
// chainable per-table builders that record ops; track(fn) runs the thunk
// directly with a dummy signal. Builders are thenable so both the
// `await q.abortSignal(s)` and `q.abortSignal(s).single()` shapes work.

type Op = { table: string; op: string; args: any[] };
let opLog: Op[];
let tableResults: Record<string, { data: any; error: any }>;
let singleResults: Record<string, { data: any; error: any }>;
let rpcCalls: Array<{ fn: string; args: any }>;
let rpcResult: { data: any; error: any };

function makeBuilder(table: string): any {
  const builder: any = {};
  const chain = (op: string) => (...args: any[]) => {
    opLog.push({ table, op, args });
    return builder;
  };
  for (const op of ['select', 'update', 'upsert', 'insert', 'delete', 'eq', 'neq', 'not', 'in', 'order', 'abortSignal']) {
    builder[op] = chain(op);
  }
  builder.single = jest.fn(() =>
    Promise.resolve(singleResults[table] ?? { data: null, error: null }),
  );
  builder.maybeSingle = builder.single;
  builder.then = (resolve: (v: any) => any, reject?: (e: any) => any) =>
    Promise.resolve(tableResults[table] ?? { data: [], error: null }).then(resolve, reject);
  return builder;
}

const mockFrom = jest.fn((table: string) => makeBuilder(table));
const mockRpc = jest.fn((fn: string, args: any) => {
  rpcCalls.push({ fn, args });
  return { abortSignal: () => Promise.resolve(rpcResult) };
});

jest.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (fn: string, args: any) => mockRpc(fn, args),
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

import { createInventoryItem, fetchInventory, updateInventoryItem } from './db';
import type { InventoryItem } from '../types';

const ITEM_ID = 'item-000000001';
const STORE_ID = 'store-0000000001';
const BRAND_ID = 'brand-0000000001';
const CATALOG_ID = 'catalog-000001';

function invRow(catalog: Record<string, unknown>) {
  return {
    id: ITEM_ID,
    store_id: STORE_ID,
    catalog_id: CATALOG_ID,
    cost_per_unit: 1,
    case_price: 24,
    item_vendors: [],
    catalog: { id: CATALOG_ID, name: 'Lettuce Iceberg', unit: 'each', case_qty: 24, sub_unit_size: 1, ...catalog },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  opLog = [];
  tableResults = {};
  singleResults = {};
  rpcCalls = [];
  rpcResult = { data: null, error: null };
});

describe('fetchInventory / mapItem — eod_count_mode (AC-19)', () => {
  it('selects eod_count_mode inside the catalog: embed', async () => {
    tableResults.inventory_items = { data: [], error: null };
    await fetchInventory(STORE_ID);
    const sel = opLog.find((o) => o.table === 'inventory_items' && o.op === 'select');
    expect(sel).toBeDefined();
    const projection = String(sel!.args[0]).replace(/\s+/g, ' ');
    expect(projection).toMatch(/catalog:catalog_ingredients\([^)]*\beod_count_mode\b[^)]*\)/);
  });

  it('passes each stored mode through as camelCase eodCountMode', async () => {
    tableResults.inventory_items = {
      data: [
        invRow({ eod_count_mode: 'cases_and_units' }),
        { ...invRow({ eod_count_mode: 'cases_only' }), id: 'item-000000002' },
        { ...invRow({ eod_count_mode: 'units_only' }), id: 'item-000000003' },
      ],
      error: null,
    };
    const items = await fetchInventory(STORE_ID);
    expect(items.map((i) => i.eodCountMode)).toEqual(['cases_and_units', 'cases_only', 'units_only']);
  });

  it('maps a missing / null / unknown value to cases_and_units', async () => {
    tableResults.inventory_items = {
      data: [
        invRow({}),
        { ...invRow({ eod_count_mode: null }), id: 'item-000000002' },
        { ...invRow({ eod_count_mode: 'bogus' }), id: 'item-000000003' },
        { ...invRow({}), id: 'item-000000004', catalog: undefined },
      ],
      error: null,
    };
    const items = await fetchInventory(STORE_ID);
    expect(items.map((i) => i.eodCountMode)).toEqual([
      'cases_and_units',
      'cases_and_units',
      'cases_and_units',
      'cases_and_units',
    ]);
  });

  it('does NOT normalize the stored mode by caseQty (N2 — stored ≠ effective)', async () => {
    tableResults.inventory_items = {
      data: [invRow({ case_qty: 1, eod_count_mode: 'cases_only' })],
      error: null,
    };
    const [item] = await fetchInventory(STORE_ID);
    expect(item.caseQty).toBe(1);
    expect(item.eodCountMode).toBe('cases_only');
  });
});

describe('updateInventoryItem — eod_count_mode omit-key-to-skip (AC-18)', () => {
  beforeEach(() => {
    singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
  });

  const catalogUpdate = () =>
    opLog.find((o) => o.table === 'catalog_ingredients' && o.op === 'update');

  it('sends eod_count_mode on the catalog update when the key is present', async () => {
    await updateInventoryItem(ITEM_ID, { eodCountMode: 'units_only' });
    const upd = catalogUpdate();
    expect(upd).toBeDefined();
    expect(upd!.args[0]).toMatchObject({ eod_count_mode: 'units_only' });
    expect(opLog).toContainEqual({ table: 'catalog_ingredients', op: 'eq', args: ['id', CATALOG_ID] });
  });

  it('rides the same catalog update as the other catalog fields (no extra round-trip)', async () => {
    await updateInventoryItem(ITEM_ID, { name: 'Lettuce', caseQty: 24, eodCountMode: 'cases_only' });
    const updates = opLog.filter((o) => o.table === 'catalog_ingredients' && o.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toMatchObject({ name: 'Lettuce', case_qty: 24, eod_count_mode: 'cases_only' });
  });

  it('omits eod_count_mode when the key is absent', async () => {
    await updateInventoryItem(ITEM_ID, { name: 'Lettuce', caseQty: 24 });
    const upd = catalogUpdate();
    expect(upd).toBeDefined();
    expect(upd!.args[0]).not.toHaveProperty('eod_count_mode');
  });

  it('issues no catalog update at all for a per-store-only edit', async () => {
    await updateInventoryItem(ITEM_ID, { parLevel: 5 });
    expect(catalogUpdate()).toBeUndefined();
  });
});

describe('createInventoryItem — p_eod_count_mode (AC-18)', () => {
  const base: Omit<InventoryItem, 'id' | 'vendors'> = {
    catalogId: '',
    name: 'Lettuce Iceberg',
    category: 'Produce',
    unit: 'each',
    costPerUnit: 0,
    currentStock: 0,
    parLevel: 0,
    averageDailyUsage: 0,
    safetyStock: 0,
    vendorId: '',
    vendorName: '',
    usagePerPortion: 0,
    lastUpdatedBy: '',
    lastUpdatedAt: '',
    eodRemaining: 0,
    storeId: STORE_ID,
    casePrice: 0,
    caseQty: 24,
    subUnitSize: 1,
    subUnitUnit: '',
  };

  beforeEach(() => {
    singleResults.stores = { data: { brand_id: BRAND_ID }, error: null };
  });

  it('passes a non-default mode and hydrates it from the RPC return', async () => {
    rpcResult = { data: invRow({ eod_count_mode: 'cases_only' }), error: null };
    const created = await createInventoryItem({ ...base, eodCountMode: 'cases_only' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('create_inventory_item_with_catalog');
    expect(rpcCalls[0].args).toMatchObject({ p_brand_id: BRAND_ID, p_eod_count_mode: 'cases_only' });
    expect(created.eodCountMode).toBe('cases_only');
  });

  it('sends cases_and_units when the field is omitted', async () => {
    rpcResult = { data: invRow({ eod_count_mode: 'cases_and_units' }), error: null };
    await createInventoryItem(base);
    expect(rpcCalls[0].args.p_eod_count_mode).toBe('cases_and_units');
  });

  it('propagates an RPC error (e.g. CHECK 23514) to the caller', async () => {
    rpcResult = { data: null, error: { code: '23514', message: 'violates check constraint' } };
    await expect(createInventoryItem({ ...base, eodCountMode: 'units_only' })).rejects.toMatchObject({
      code: '23514',
    });
  });
});
