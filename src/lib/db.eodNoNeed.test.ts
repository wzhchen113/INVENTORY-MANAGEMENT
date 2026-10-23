// src/lib/db.eodNoNeed.test.ts — Spec 172 (AC-22, AC-26; design §3.1, §3.4).
//
// Pins the db.ts read/write mapping for eod_entries.no_need:
//   1. The three EOD read mappers (fetchTodaysEODForStores,
//      fetchRecentEODSubmissions, fetchEodSubmissionsForStores) select
//      `no_need` and map a NO NEED row to `{ actualRemaining: null,
//      noNeed: true }`. A numeric row has NO `noNeed` key and its
//      `actualRemaining` is unchanged (incl. the legacy `Number(x) || 0`).
//   2. submitEODCount sends `no_need` on EVERY row of a mixed batch (so the
//      supabase-js bulk insert never defaults it to NULL), forces the three
//      numerics to null on NO NEED rows, and performs NO inventory_items
//      update for them.
//
// Mocking strategy mirrors db.eodCountMode.test.ts: chainable per-table
// builders that record ops; track(fn) runs the thunk directly.

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
  for (const op of ['select', 'update', 'upsert', 'insert', 'delete', 'eq', 'neq', 'not', 'in', 'gte', 'order', 'abortSignal']) {
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

import {
  fetchEodSubmissionsForStores,
  fetchRecentEODSubmissions,
  fetchTodaysEODForStores,
  submitEODCount,
} from './db';
import type { EODEntry, EODSubmission } from '../types';

const STORE_ID = 'store-0000000001';
const VENDOR_ID = 'vendor-000000001';
const SUB_ID = 'sub-000000000001';

function entryRow(over: Record<string, unknown>) {
  return {
    id: 'e-1',
    item_id: 'item-1',
    actual_remaining: 12,
    actual_remaining_cases: 1,
    actual_remaining_each: 2,
    notes: '',
    created_at: '2026-10-23T22:00:00Z',
    item: { catalog: { name: 'Lettuce', unit: 'each' } },
    ...over,
  };
}

function subRow(entries: unknown[]) {
  return {
    id: SUB_ID,
    store_id: STORE_ID,
    date: '2026-10-23',
    vendor_id: VENDOR_ID,
    status: 'submitted',
    submitted_at: '2026-10-23T22:00:00Z',
    submitted_by: 'user-1',
    submitter: { name: 'Pat' },
    eod_entries: entries,
  };
}

const NO_NEED_ROW = entryRow({
  id: 'e-nn',
  item_id: 'item-nn',
  actual_remaining: null,
  actual_remaining_cases: null,
  actual_remaining_each: null,
  no_need: true,
});
const NUMERIC_ROW = entryRow({ no_need: false });
// Legacy null-total numeric row (no_need false) keeps today's `|| 0` coercion.
const LEGACY_NULL_ROW = entryRow({
  id: 'e-legacy',
  item_id: 'item-legacy',
  actual_remaining: null,
  actual_remaining_cases: null,
  actual_remaining_each: null,
  no_need: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  opLog = [];
  tableResults = {};
  singleResults = {};
});

const READERS: Array<[string, () => Promise<any[]>]> = [
  ['fetchTodaysEODForStores', () => fetchTodaysEODForStores([STORE_ID], '2026-10-23')],
  ['fetchRecentEODSubmissions', () => fetchRecentEODSubmissions(STORE_ID, 14)],
  ['fetchEodSubmissionsForStores', () => fetchEodSubmissionsForStores([STORE_ID], '2026-10-01')],
];

describe.each(READERS)('%s — no_need read mapping (AC-26)', (_name, read) => {
  it('selects no_need inside the eod_entries embed', async () => {
    tableResults.eod_submissions = { data: [], error: null };
    await read();
    const sel = opLog.find((o) => o.table === 'eod_submissions' && o.op === 'select');
    expect(sel).toBeDefined();
    const projection = String(sel!.args[0]).replace(/\s+/g, ' ');
    expect(projection).toMatch(/eod_entries\([^)]*\bno_need\b/);
  });

  it('maps a NO NEED row to actualRemaining null + noNeed true (never 0)', async () => {
    tableResults.eod_submissions = { data: [subRow([NO_NEED_ROW])], error: null };
    const [sub] = await read();
    const [e] = sub.entries as EODEntry[];
    expect(e.actualRemaining).toBeNull();
    expect(e.noNeed).toBe(true);
    expect(e.actualRemainingCases).toBeUndefined();
    expect(e.actualRemainingEach).toBeUndefined();
  });

  it('a numeric row has NO noNeed key and an unchanged actualRemaining', async () => {
    tableResults.eod_submissions = { data: [subRow([NUMERIC_ROW, LEGACY_NULL_ROW])], error: null };
    const [sub] = await read();
    const [num, legacy] = sub.entries as EODEntry[];
    expect('noNeed' in num).toBe(false);
    expect(num.actualRemaining).toBe(12);
    expect(num.actualRemainingCases).toBe(1);
    expect(num.actualRemainingEach).toBe(2);
    // Legacy null-total numeric row: byte-identical to pre-172 (`|| 0`).
    expect('noNeed' in legacy).toBe(false);
    expect(legacy.actualRemaining).toBe(0);
  });

  it('itemCount still counts NO NEED entries (AC-21 parity)', async () => {
    tableResults.eod_submissions = { data: [subRow([NO_NEED_ROW, NUMERIC_ROW])], error: null };
    const [sub] = await read();
    expect(sub.itemCount).toBe(2);
  });
});

function makeEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'x',
    itemId: 'item-1',
    itemName: 'Lettuce',
    actualRemaining: 12,
    unit: 'each',
    submittedBy: 'Pat',
    submittedByUserId: 'user-1',
    timestamp: '2026-10-23T22:00:00Z',
    date: '2026-10-23',
    storeId: STORE_ID,
    notes: '',
    ...over,
  };
}

function makeSubmission(entries: EODEntry[]): Omit<EODSubmission, 'id'> {
  return {
    date: '2026-10-23',
    storeId: STORE_ID,
    storeName: 'Frederick',
    vendorId: VENDOR_ID,
    submittedBy: 'Pat',
    submittedByUserId: 'user-1',
    timestamp: '2026-10-23T22:00:00Z',
    itemCount: entries.length,
    status: 'submitted',
    entries,
  };
}

describe('submitEODCount — no_need write (AC-22)', () => {
  beforeEach(() => {
    singleResults.eod_submissions = { data: { id: SUB_ID }, error: null };
    tableResults.eod_entries = { data: null, error: null };
    // Both items are linked to the submitting vendor at this store.
    tableResults.item_vendors = {
      data: [{ item_id: 'item-1' }, { item_id: 'item-nn' }],
      error: null,
    };
    tableResults.inventory_items = { data: null, error: null };
  });

  const mixed = () =>
    makeSubmission([
      makeEntry({ itemId: 'item-1', actualRemaining: 12, actualRemainingCases: 1, actualRemainingEach: 2 }),
      makeEntry({ itemId: 'item-nn', actualRemaining: null, noNeed: true, notes: 'plenty' }),
    ]);

  it('sends no_need on EVERY row of a mixed batch', async () => {
    await submitEODCount(mixed());
    const ins = opLog.find((o) => o.table === 'eod_entries' && o.op === 'insert');
    expect(ins).toBeDefined();
    const rows = ins!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(typeof r.no_need).toBe('boolean');
    expect(rows[0]).toEqual({
      submission_id: SUB_ID,
      item_id: 'item-1',
      actual_remaining: 12,
      actual_remaining_cases: 1,
      actual_remaining_each: 2,
      no_need: false,
      notes: '',
    });
    expect(rows[1]).toEqual({
      submission_id: SUB_ID,
      item_id: 'item-nn',
      actual_remaining: null,
      actual_remaining_cases: null,
      actual_remaining_each: null,
      no_need: true,
      notes: 'plenty',
    });
  });

  it('forces the numerics to null on a NO NEED row even if stale values ride along', async () => {
    await submitEODCount(
      makeSubmission([
        makeEntry({ itemId: 'item-nn', actualRemaining: 5, actualRemainingCases: 1, actualRemainingEach: 1, noNeed: true }),
      ]),
    );
    const ins = opLog.find((o) => o.table === 'eod_entries' && o.op === 'insert');
    const [row] = ins!.args[0] as Array<Record<string, unknown>>;
    expect(row.actual_remaining).toBeNull();
    expect(row.actual_remaining_cases).toBeNull();
    expect(row.actual_remaining_each).toBeNull();
    expect(row.no_need).toBe(true);
  });

  it('performs NO inventory_items update for the NO NEED entry', async () => {
    await submitEODCount(mixed());
    const updates = opLog.filter((o) => o.table === 'inventory_items' && o.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toMatchObject({ current_stock: 12, eod_remaining: 12 });
    const eqIds = opLog
      .filter((o) => o.table === 'inventory_items' && o.op === 'eq' && o.args[0] === 'id')
      .map((o) => o.args[1]);
    expect(eqIds).toEqual(['item-1']);
  });

  it('a NO-NEED-only submission still inserts its entries and writes no on-hand', async () => {
    await submitEODCount(
      makeSubmission([makeEntry({ itemId: 'item-nn', actualRemaining: null, noNeed: true })]),
    );
    expect(opLog.some((o) => o.table === 'eod_entries' && o.op === 'insert')).toBe(true);
    expect(opLog.some((o) => o.table === 'inventory_items' && o.op === 'update')).toBe(false);
  });

  // Review-fix SF-3: the on-hand loop gates on isNumericEodEntry (the same
  // predicate as useStore.submitEOD), not on `noNeed` alone, so a
  // non-NO-NEED entry carrying a null total can never write
  // current_stock = NULL. No client builds this shape today; this pins it.
  it('a non-NO-NEED entry with a null total writes no on-hand (never current_stock = NULL)', async () => {
    await submitEODCount(
      makeSubmission([
        makeEntry({ itemId: 'item-1', actualRemaining: 12 }),
        makeEntry({ itemId: 'item-nn', actualRemaining: null }),
      ]),
    );
    const updates = opLog.filter((o) => o.table === 'inventory_items' && o.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toMatchObject({ current_stock: 12, eod_remaining: 12 });
    for (const u of updates) {
      expect(u.args[0].current_stock).not.toBeNull();
      expect(u.args[0].eod_remaining).not.toBeNull();
    }
    const eqIds = opLog
      .filter((o) => o.table === 'inventory_items' && o.op === 'eq' && o.args[0] === 'id')
      .map((o) => o.args[1]);
    expect(eqIds).toEqual(['item-1']);
    // The entry row itself still persists (unchanged insert payload).
    const ins = opLog.find((o) => o.table === 'eod_entries' && o.op === 'insert');
    const rows = ins!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ item_id: 'item-nn', actual_remaining: null, no_need: false });
  });
});
