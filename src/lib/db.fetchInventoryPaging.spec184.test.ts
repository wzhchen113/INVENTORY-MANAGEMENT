// src/lib/db.fetchInventoryPaging.spec184.test.ts — Spec 184 (D-13, D-14).
//
// D-14: `fetchInventory()` with no store pages by keyset until an EMPTY page, so
// the all-stores read can't be silently truncated at PostgREST's max_rows, even
// when the server caps pages below the requested size. `fetchInventory(storeId)`
// stays one request.
// D-13: `fetchAllForStore` still yields `[]` when the inventory read fails, and
// now says so through `inventoryFailed`.

type Page = { data: unknown[] | null; error: { message: string } | null };

let pages: Page[] = [];
const calls: Array<{ gt: [string, string] | null; limit: number | null; eq: [string, string] | null }> = [];

function builder() {
  const call = { gt: null as [string, string] | null, limit: null as number | null, eq: null as [string, string] | null };
  calls.push(call);
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.order = () => b;
  b.gt = (col: string, v: string) => { call.gt = [col, v]; return b; };
  b.eq = (col: string, v: string) => { call.eq = [col, v]; return b; };
  b.limit = (n: number) => { call.limit = n; return b; };
  b.abortSignal = () => Promise.resolve(pages.shift() ?? { data: [], error: null });
  return b;
}

const mockFrom = jest.fn();

jest.mock('./supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t) },
}));

const mockTrack = jest.fn();
jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>, opts: unknown) => {
        mockTrack(opts);
        return fn(new AbortController().signal);
      },
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { fetchInventory, fetchAllForStore } from './db';

const row = (id: string) => ({
  id,
  store_id: 's1',
  catalog_id: `cat-${id}`,
  item_vendors: [],
  catalog: { id: `cat-${id}`, name: `Item ${id}`, unit: 'ea', i18n_names: {} },
});
const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => row(`${prefix}-${String(i).padStart(4, '0')}`));

beforeEach(() => {
  jest.clearAllMocks();
  pages = [];
  calls.length = 0;
  mockFrom.mockImplementation(() => builder());
});

describe('fetchInventory() — all stores, keyset paging (D-14)', () => {
  it('stops on an empty page, so a short first page costs one extra request', async () => {
    const p1 = rows('a', 3);
    pages = [{ data: p1, error: null }];
    const out = await fetchInventory();
    expect(out).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].gt).toBeNull();
    expect(calls[0].limit).toBe(1000);
    expect(calls[1].gt).toEqual(['id', p1[2].id]);
    expect(mockTrack).toHaveBeenCalledTimes(2);
  });

  it('keeps paging when the server caps pages below 1000 (max_rows < page size)', async () => {
    const p1 = rows('a', 500);
    const p2 = rows('b', 500);
    const p3 = rows('c', 31);
    pages = [
      { data: p1, error: null },
      { data: p2, error: null },
      { data: p3, error: null },
      { data: [], error: null },
    ];
    const out = await fetchInventory();
    expect(out).toHaveLength(1031);
    expect(calls).toHaveLength(4);
    expect(calls[1].gt).toEqual(['id', p1[499].id]);
    expect(calls[2].gt).toEqual(['id', p2[499].id]);
    expect(calls[3].gt).toEqual(['id', p3[30].id]);
    expect(new Set(out.map((i) => i.id)).size).toBe(1031);
  });

  it('starts with an empty page and returns nothing, in one request', async () => {
    pages = [{ data: [], error: null }];
    expect(await fetchInventory()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('pages past 1000 rows, each page after the last id, and concatenates in order', async () => {
    const p1 = rows('a', 1000);
    const p2 = rows('b', 1000);
    const p3 = rows('c', 31);
    pages = [
      { data: p1, error: null },
      { data: p2, error: null },
      { data: p3, error: null },
    ];
    const out = await fetchInventory();

    expect(out).toHaveLength(2031);
    expect(calls).toHaveLength(4);
    expect(calls[3].gt).toEqual(['id', p3[30].id]);
    expect(calls[0].gt).toBeNull();
    expect(calls[1].gt).toEqual(['id', p1[999].id]);
    expect(calls[2].gt).toEqual(['id', p2[999].id]);
    expect(out[0].id).toBe(p1[0].id);
    expect(out[1000].id).toBe(p2[0].id);
    expect(out[2030].id).toBe(p3[30].id);
  });

  it('never loses or duplicates a row across a page boundary', async () => {
    pages = [
      { data: rows('a', 1000), error: null },
      { data: rows('b', 5), error: null },
    ];
    const out = await fetchInventory();
    expect(new Set(out.map((i) => i.id)).size).toBe(1005);
  });

  it('an exactly-full last page also ends on one extra, empty request', async () => {
    pages = [
      { data: rows('a', 1000), error: null },
      { data: [], error: null },
    ];
    const out = await fetchInventory();
    expect(out).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it('sends each page through track, as a read', async () => {
    pages = [
      { data: rows('a', 1000), error: null },
      { data: rows('b', 1), error: null },
    ];
    await fetchInventory();
    expect(mockTrack).toHaveBeenCalledTimes(3);
    expect(mockTrack).toHaveBeenCalledWith({ kind: 'read', label: 'fetchInventory' });
  });

  it('rejects when a later page fails, rather than returning a truncated list', async () => {
    pages = [
      { data: rows('a', 1000), error: null },
      { data: null, error: { message: 'boom' } },
    ];
    await expect(fetchInventory()).rejects.toEqual({ message: 'boom' });
  });

  it('maps rows like the single-store path does', async () => {
    pages = [{ data: [row('x')], error: null }];
    const [item] = await fetchInventory();
    expect(item.name).toBe('Item x');
  });
});

describe('fetchInventory(storeId) — one store, one request', () => {
  it('issues one request, filtered by store, with no limit or cursor', async () => {
    pages = [{ data: rows('a', 1000), error: null }];
    const out = await fetchInventory('s1');
    expect(out).toHaveLength(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0].eq).toEqual(['store_id', 's1']);
    expect(calls[0].limit).toBeNull();
    expect(calls[0].gt).toBeNull();
  });
});

describe('fetchAllForStore — inventoryFailed (D-13)', () => {
  // Every other table in the bulk load resolves empty; only inventory_items is
  // told what to do, so these cases are about the flag alone.
  const wire = (inventory: Page) => {
    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      // D-14 pages until an empty page, so a cursor (`.gt`) read of inventory
      // must come back empty or the loop never ends.
      let paged = false;
      const result = () => Promise.resolve(
        table !== 'inventory_items' ? { data: [], error: null }
          : paged ? { data: [], error: null } : inventory,
      );
      for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'in', 'not', 'is', 'limit', 'or']) {
        chain[m] = () => chain;
      }
      chain.gt = () => { paged = true; return chain; };
      chain.abortSignal = () => {
        const p = result() as Promise<unknown> & { single?: unknown; maybeSingle?: unknown };
        p.single = result;
        p.maybeSingle = result;
        return p;
      };
      chain.single = result;
      chain.maybeSingle = result;
      return chain;
    });
  };

  it('is true, with an empty inventory, when the read fails', async () => {
    wire({ data: null, error: { message: 'boom' } });
    const out = await fetchAllForStore('s1');
    expect(out.inventoryFailed).toBe(true);
    expect(out.inventory).toEqual([]);
  });

  it('is false when the store really has no items', async () => {
    wire({ data: [], error: null });
    const out = await fetchAllForStore('s1');
    expect(out.inventoryFailed).toBe(false);
    expect(out.inventory).toEqual([]);
  });

  it('is false, with rows, on a good read', async () => {
    wire({ data: [row('x')], error: null });
    const out = await fetchAllForStore('s1');
    expect(out.inventoryFailed).toBe(false);
    expect(out.inventory).toHaveLength(1);
  });
});
