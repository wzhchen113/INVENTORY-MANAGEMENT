// src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts — Spec 173
// (AC-1..AC-8; design D1-D3, D6).
//
// Pins that updateInventoryItem's catalog block REJECTS on every catalog
// failure mode instead of silently skipping / ignoring the result:
//   AC-1 lookup error (incl. PGRST116 from `.single()`) — thrown raw
//   AC-2 missing catalog_id — synthesized Error (D3 string)
//   AC-3 catalog UPDATE error (e.g. CHECK 23514) — thrown raw
//   AC-4 0-row catalog UPDATE (RLS-denial shape) — synthesized Error (D3)
//   AC-5 no per-store / item_vendors write follows any of the above
//   AC-6 the rejection carries a non-empty message
//   AC-7 the 1-row happy path resolves with today's write order
//   AC-8 a payload with no catalog fields never enters the catalog block
//
// Harness copied from db.eodCountMode.test.ts: chainable per-table builders
// that record ops; track(fn) runs the thunk directly with a dummy signal.
// Builders are thenable so both `await q.abortSignal(s)` and
// `q.abortSignal(s).single()` shapes work.

type Op = { table: string; op: string; args: any[] };
let opLog: Op[];
let tableResults: Record<string, { data: any; error: any }>;
let singleResults: Record<string, { data: any; error: any }>;

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

jest.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: jest.fn(),
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

import { updateInventoryItem } from './db';

const ITEM_ID = 'item-000000001';
const CATALOG_ID = 'catalog-000001';
const VENDOR_B = 'vendor-0000000000b';

const NO_LINK_MSG = 'Catalog change not saved: this ingredient has no catalog link.';
const ZERO_ROW_MSG =
  'Catalog change not saved: no permission to edit this catalog ingredient, or it no longer exists.';

const PGRST116 = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
};
const CHECK_23514 = { code: '23514', message: 'violates check constraint' };

beforeEach(() => {
  jest.clearAllMocks();
  opLog = [];
  tableResults = {};
  singleResults = {};
});

const opsOn = (table: string, op?: string) =>
  opLog.filter((o) => o.table === table && (op === undefined || o.op === op));

// The four failure modes, each expressed as the mock state that produces it.
type FailureCase = {
  name: string;
  arrange: () => void;
};
const FAILURE_CASES: FailureCase[] = [
  {
    name: 'AC-1 lookup error (PGRST116)',
    arrange: () => {
      singleResults.inventory_items = { data: null, error: PGRST116 };
    },
  },
  {
    name: 'AC-2 lookup data null',
    arrange: () => {
      singleResults.inventory_items = { data: null, error: null };
    },
  },
  {
    name: 'AC-2 catalog_id null',
    arrange: () => {
      singleResults.inventory_items = { data: { catalog_id: null }, error: null };
    },
  },
  {
    name: 'AC-3 update error (23514)',
    arrange: () => {
      singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
      tableResults.catalog_ingredients = { data: null, error: CHECK_23514 };
    },
  },
  {
    name: 'AC-4 0-row update',
    arrange: () => {
      singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
      tableResults.catalog_ingredients = { data: [], error: null };
    },
  },
];

describe('updateInventoryItem — catalog failure modes reject (spec 173)', () => {
  it('AC-1: a lookup error is thrown raw and no catalog_ingredients op runs', async () => {
    singleResults.inventory_items = { data: null, error: PGRST116 };
    await expect(updateInventoryItem(ITEM_ID, { name: 'X' })).rejects.toMatchObject({
      code: 'PGRST116',
      message: PGRST116.message,
    });
    expect(opsOn('catalog_ingredients')).toHaveLength(0);
  });

  it.each([
    ['data null', { data: null, error: null }],
    ['catalog_id null', { data: { catalog_id: null }, error: null }],
    ['catalog_id undefined', { data: {}, error: null }],
  ])('AC-2: a missing catalog_id (%s) throws and issues no catalog UPDATE', async (_label, lookup) => {
    singleResults.inventory_items = lookup;
    await expect(updateInventoryItem(ITEM_ID, { name: 'X' })).rejects.toThrow(NO_LINK_MSG);
    expect(opsOn('catalog_ingredients', 'update')).toHaveLength(0);
  });

  it('AC-3: a catalog UPDATE error (CHECK 23514) is thrown raw with its message intact', async () => {
    singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
    tableResults.catalog_ingredients = { data: null, error: CHECK_23514 };
    await expect(updateInventoryItem(ITEM_ID, { eodCountMode: 'units_only' })).rejects.toMatchObject({
      code: '23514',
      message: 'violates check constraint',
    });
  });

  it('AC-4: a 0-row catalog UPDATE (RLS-denial shape) throws; select(\'id\') is chained', async () => {
    singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
    tableResults.catalog_ingredients = { data: [], error: null };
    await expect(updateInventoryItem(ITEM_ID, { name: 'X' })).rejects.toThrow(ZERO_ROW_MSG);
    expect(opsOn('catalog_ingredients', 'select')).toEqual([
      { table: 'catalog_ingredients', op: 'select', args: ['id'] },
    ]);
  });

  it('AC-4: a null data array on the catalog UPDATE also throws', async () => {
    singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
    tableResults.catalog_ingredients = { data: null, error: null };
    await expect(updateInventoryItem(ITEM_ID, { name: 'X' })).rejects.toThrow(ZERO_ROW_MSG);
  });

  it.each(FAILURE_CASES.map((c) => [c.name, c] as const))(
    'AC-5/AC-6 (%s): no per-store or item_vendors write follows, and the rejection has a message',
    async (_name, c) => {
      c.arrange();
      let caught: any;
      try {
        await updateInventoryItem(ITEM_ID, {
          name: 'X',
          parLevel: 5,
          vendorId: VENDOR_B,
          vendors: [{ vendorId: VENDOR_B }],
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // AC-6 — notifyBackendError renders e.message.
      expect(typeof caught.message).toBe('string');
      expect(caught.message.length).toBeGreaterThan(0);
      // AC-5 — no half-write.
      expect(opsOn('inventory_items', 'update')).toHaveLength(0);
      expect(opsOn('item_vendors')).toHaveLength(0);
    },
  );
});

describe('updateInventoryItem — happy path and non-catalog edits unchanged (spec 173)', () => {
  it('AC-7: a 1-row catalog UPDATE resolves; catalog → per-store → item_vendors order holds', async () => {
    singleResults.inventory_items = { data: { catalog_id: CATALOG_ID }, error: null };
    tableResults.catalog_ingredients = { data: [{ id: CATALOG_ID }], error: null };
    await expect(
      updateInventoryItem(ITEM_ID, {
        name: 'X',
        parLevel: 5,
        vendorId: VENDOR_B,
        vendors: [{ vendorId: VENDOR_B }],
      }),
    ).resolves.toBeUndefined();

    const catalogUpdateIdx = opLog.findIndex((o) => o.table === 'catalog_ingredients' && o.op === 'update');
    const perStoreUpdateIdx = opLog.findIndex((o) => o.table === 'inventory_items' && o.op === 'update');
    const firstLinkIdx = opLog.findIndex((o) => o.table === 'item_vendors');
    expect(catalogUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(perStoreUpdateIdx).toBeGreaterThan(catalogUpdateIdx);
    expect(firstLinkIdx).toBeGreaterThan(perStoreUpdateIdx);
    expect(opLog[catalogUpdateIdx].args[0]).toMatchObject({ name: 'X' });
    expect(opLog).toContainEqual({ table: 'catalog_ingredients', op: 'eq', args: ['id', CATALOG_ID] });
    expect(opLog[perStoreUpdateIdx].args[0]).toMatchObject({ par_level: 5, vendor_id: VENDOR_B });
    // Demote → upsert → delete, as today.
    expect(opsOn('item_vendors', 'update')).toHaveLength(1);
    expect(opsOn('item_vendors', 'upsert')).toHaveLength(1);
    expect(opsOn('item_vendors', 'delete')).toHaveLength(1);
  });

  it.each([
    ['{ parLevel: 5 }', { parLevel: 5 }],
    ['vendors[] only (explicit vendorId)', { vendorId: VENDOR_B, vendors: [{ vendorId: VENDOR_B }] }],
  ])(
    'AC-8: %s issues no catalog_id lookup and no catalog op, even with a poisoned lookup',
    async (_label, payload) => {
      singleResults.inventory_items = { data: null, error: PGRST116 };
      tableResults.catalog_ingredients = { data: [], error: null };
      await expect(updateInventoryItem(ITEM_ID, payload)).resolves.toBeUndefined();
      expect(
        opLog.some((o) => o.table === 'inventory_items' && o.op === 'select' && o.args[0] === 'catalog_id'),
      ).toBe(false);
      expect(opsOn('catalog_ingredients')).toHaveLength(0);
    },
  );
});
