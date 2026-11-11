// src/lib/db.eodNoNeed.test.ts — Spec 172 (AC-22, AC-26; design §3.1, §3.4).
//
// Pins the db.ts read/write mapping for eod_entries.no_need:
//   1. The three EOD read mappers (fetchTodaysEODForStores,
//      fetchRecentEODSubmissions, fetchEodSubmissionsForStores) select
//      `no_need` and map a NO NEED row to `{ actualRemaining: null,
//      noNeed: true }`. A numeric row has NO `noNeed` key and its
//      `actualRemaining` is unchanged (incl. the legacy `Number(x) || 0`).
//   2. submitEODCount (spec 189, AC-21) is ONE `admin_submit_eod` RPC call:
//      `no_need` on EVERY element, the three numerics forced to null on NO
//      NEED elements, removals passed through. It never touches eod_entries,
//      eod_submissions or inventory_items directly. The old mock let a direct
//      eod_entries delete "succeed", which hid the RLS-denied delete that
//      stacked duplicates; here any direct eod_entries op resolves with an
//      error AND fails the test. The on-hand arms (no on-hand for NO NEED or a
//      null total) moved to pgTAP with the write itself
//      (supabase/tests/admin_submit_eod.test.sql arms 20, 49-51).
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

let rpcResult: { data: any; error: any };
const mockRpc = jest.fn((_fn: string, _args: Record<string, unknown>) => ({
  abortSignal: (_signal: AbortSignal) => Promise.resolve(rpcResult),
}));

jest.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
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
  rpcResult = { data: null, error: null };
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

// Spec 189 AC-21: no direct-table path may stand in for the RPC.
const DIRECT_TABLES = ['eod_entries', 'eod_submissions', 'inventory_items', 'item_vendors'];

function rpcArgs(): Record<string, any> {
  expect(mockRpc).toHaveBeenCalledTimes(1);
  expect(mockRpc.mock.calls[0][0]).toBe('admin_submit_eod');
  return mockRpc.mock.calls[0][1] as Record<string, any>;
}

describe('submitEODCount — admin_submit_eod RPC (spec 189 AC-21; spec 172 AC-22)', () => {
  beforeEach(() => {
    rpcResult = {
      data: { submission_id: SUB_ID, conflict: false, entry_ids: [], stock_updates: [], entry_count: 2 },
      error: null,
    };
    // A direct eod_entries delete is DENIED in reality (no DELETE policy).
    // Never mock it as success again.
    tableResults.eod_entries = {
      data: null,
      error: { message: 'mock: direct eod_entries access is not the write path (spec 189)' },
    };
  });

  afterEach(() => {
    const direct = opLog.filter((o) => DIRECT_TABLES.includes(o.table));
    expect(direct).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  const mixed = () =>
    makeSubmission([
      makeEntry({ itemId: 'item-nn', actualRemaining: null, noNeed: true, notes: 'plenty' }),
      makeEntry({ itemId: 'item-1', actualRemaining: 12, actualRemainingCases: 1, actualRemainingEach: 2 }),
    ]);

  it('issues exactly one admin_submit_eod call with the parent fields', async () => {
    await submitEODCount(mixed());
    const args = rpcArgs();
    expect(args.p_store_id).toBe(STORE_ID);
    expect(args.p_date).toBe('2026-10-23');
    expect(args.p_vendor_id).toBe(VENDOR_ID);
    expect(args.p_status).toBe('submitted');
    // submitted_by is forced server-side; the client id is never sent.
    expect(JSON.stringify(args)).not.toContain('user-1');
  });

  it('sends no_need on EVERY element, sorted by item id, numerics as sent', async () => {
    await submitEODCount(mixed());
    const rows = rpcArgs().p_entries as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(typeof r.no_need).toBe('boolean');
    expect(rows[0]).toEqual({
      ingredient_id: 'item-1',
      actual_remaining: 12,
      actual_remaining_cases: 1,
      actual_remaining_each: 2,
      no_need: false,
      notes: '',
    });
    expect(rows[1]).toEqual({
      ingredient_id: 'item-nn',
      actual_remaining: null,
      actual_remaining_cases: null,
      actual_remaining_each: null,
      no_need: true,
      notes: 'plenty',
    });
  });

  it('forces the numerics to null on a NO NEED element even if stale values ride along', async () => {
    await submitEODCount(
      makeSubmission([
        makeEntry({ itemId: 'item-nn', actualRemaining: 5, actualRemainingCases: 1, actualRemainingEach: 1, noNeed: true }),
      ]),
    );
    const [row] = rpcArgs().p_entries as Array<Record<string, unknown>>;
    expect(row.actual_remaining).toBeNull();
    expect(row.actual_remaining_cases).toBeNull();
    expect(row.actual_remaining_each).toBeNull();
    expect(row.no_need).toBe(true);
  });

  it('passes a non-NO-NEED null total through as null (the server skips its on-hand)', async () => {
    await submitEODCount(makeSubmission([makeEntry({ itemId: 'item-legacy', actualRemaining: null })]));
    const [row] = rpcArgs().p_entries as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ingredient_id: 'item-legacy', actual_remaining: null, no_need: false });
  });

  it('defaults p_removed_item_ids to [] and passes removals through', async () => {
    await submitEODCount(mixed());
    expect(rpcArgs().p_removed_item_ids).toEqual([]);
    mockRpc.mockClear();
    await submitEODCount(makeSubmission([]), ['item-gone']);
    const args = rpcArgs();
    expect(args.p_removed_item_ids).toEqual(['item-gone']);
    expect(args.p_entries).toEqual([]);
  });

  it('sends the draft status for SAVE DRAFT', async () => {
    await submitEODCount({ ...mixed(), status: 'draft' });
    expect(rpcArgs().p_status).toBe('draft');
  });

  it('maps the envelope to { submissionId, entryCount }', async () => {
    await expect(submitEODCount(mixed())).resolves.toEqual({ submissionId: SUB_ID, entryCount: 2 });
  });

  it('rethrows a rejected write (no silent success) and logs it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = { code: '42501', message: 'admin_submit_eod: caller cannot write EOD counts for store x' };
    rpcResult = { data: null, error: err };
    await expect(submitEODCount(mixed())).rejects.toBe(err);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
