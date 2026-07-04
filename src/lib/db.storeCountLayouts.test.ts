// src/lib/db.storeCountLayouts.test.ts — Spec 110 (regression guard for the
// four store-shared-layout db.ts helpers).
//
// Pins the contract of fetchStoreCountLayouts / saveStoreCountLayout /
// renameStoreCountLayout / deleteStoreCountLayout:
//   - LIST goes through PostgREST on `store_count_layouts`, selects the five
//     columns, filters `.eq('store_id', …)`, orders by `position`, and maps each
//     row snake→camel (item_ids → itemIds, updated_at → updatedAt) — a
//     zero-row/empty result yields [].
//   - the three WRITES go through `supabase.rpc(<fn>, { p_* })` with the EXACT
//     snake_case arg names the RPCs declare, return the RPC's uuid, and THROW the
//     PostgREST error on refusal (so the section reverts + notifyBackendError).
//
// Mocking strategy mirrors db.saveCountOrder.test.ts:
//   - jest.mock('./supabase') — a chainable builder whose terminal
//     `.abortSignal()` resolves `{ data, error }`. The builder records the last
//     `from`/`rpc` name + args so they are assertable.
//   - jest.mock('./inflight') — `track(fn)` runs the thunk immediately with a
//     throwaway AbortSignal (no real timers in node env).
//   - jest.mock('./auth') — db.ts imports callEdgeFunction; stub to keep the
//     import graph node-safe. Not exercised here.

let terminalResult: { data: unknown; error: unknown } = { data: null, error: null };
const calls: { rpc: Array<{ fn: string; args: unknown }>; from: string[] } = {
  rpc: [],
  from: [],
};

const mockBuilder: any = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  // Terminal used by every helper (both the SELECT chain and the .rpc chain).
  abortSignal: jest.fn(() => Promise.resolve(terminalResult)),
};

jest.mock('./supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      calls.from.push(table);
      return mockBuilder;
    }),
    rpc: jest.fn((fn: string, args: unknown) => {
      calls.rpc.push({ fn, args });
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

jest.mock('./auth', () => ({
  callEdgeFunction: jest.fn(),
}));

import {
  fetchStoreCountLayouts,
  saveStoreCountLayout,
  renameStoreCountLayout,
  deleteStoreCountLayout,
} from './db';
import { supabase } from './supabase';

const STORE = 'store-frederick';
const LAYOUT = 'layout-1';

beforeEach(() => {
  jest.clearAllMocks();
  calls.rpc.length = 0;
  calls.from.length = 0;
  terminalResult = { data: null, error: null };
  // clearAllMocks wipes mockReturnThis()/impls — re-arm them.
  mockBuilder.select.mockReturnThis();
  mockBuilder.eq.mockReturnThis();
  mockBuilder.order.mockReturnThis();
  mockBuilder.abortSignal.mockImplementation(() => Promise.resolve(terminalResult));
});

describe('db.fetchStoreCountLayouts — PostgREST list, snake→camel, order by position', () => {
  it('selects the five columns, filters store_id, orders by position, maps rows', async () => {
    terminalResult = {
      data: [
        {
          id: 'l1',
          name: 'Walk A',
          item_ids: ['i1', 'i2'],
          position: 1,
          updated_at: '2026-07-04T00:00:00Z',
        },
        {
          id: 'l2',
          name: 'Walk B',
          item_ids: ['i3'],
          position: 2,
          updated_at: '2026-07-04T01:00:00Z',
        },
      ],
      error: null,
    };

    const out = await fetchStoreCountLayouts(STORE);

    expect(supabase.from).toHaveBeenCalledWith('store_count_layouts');
    expect(mockBuilder.select).toHaveBeenCalledWith('id,name,item_ids,position,updated_at');
    expect(mockBuilder.eq).toHaveBeenCalledWith('store_id', STORE);
    expect(mockBuilder.order).toHaveBeenCalledWith('position');

    // snake→camel mapping (item_ids → itemIds, updated_at → updatedAt).
    expect(out).toEqual([
      { id: 'l1', name: 'Walk A', itemIds: ['i1', 'i2'], position: 1, updatedAt: '2026-07-04T00:00:00Z' },
      { id: 'l2', name: 'Walk B', itemIds: ['i3'], position: 2, updatedAt: '2026-07-04T01:00:00Z' },
    ]);
  });

  it('returns [] on a null/empty result (no rows → Default only, not an error)', async () => {
    terminalResult = { data: null, error: null };
    expect(await fetchStoreCountLayouts(STORE)).toEqual([]);
  });

  it('defaults a missing item_ids to [] defensively', async () => {
    terminalResult = {
      data: [{ id: 'l1', name: 'X', item_ids: null, position: 1, updated_at: 't' }],
      error: null,
    };
    const out = await fetchStoreCountLayouts(STORE);
    expect(out[0].itemIds).toEqual([]);
  });

  it('throws the PostgREST error (so the caller degrades + notifies)', async () => {
    terminalResult = { data: null, error: { message: 'boom' } };
    await expect(fetchStoreCountLayouts(STORE)).rejects.toEqual({ message: 'boom' });
  });
});

describe('db.saveStoreCountLayout — RPC save_store_count_layout with p_* args', () => {
  it('CREATE (layoutId omitted): passes p_layout_id null, returns the new id', async () => {
    terminalResult = { data: 'new-id', error: null };

    const id = await saveStoreCountLayout(STORE, 'Walk A', ['i1', 'i2']);

    expect(id).toBe('new-id');
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].fn).toBe('save_store_count_layout');
    expect(calls.rpc[0].args).toEqual({
      p_store_id: STORE,
      p_name: 'Walk A',
      p_item_ids: ['i1', 'i2'],
      p_layout_id: null,
    });
    // never touches the table directly for a write.
    expect(calls.from).toHaveLength(0);
  });

  it('OVERWRITE (layoutId given): passes p_layout_id through', async () => {
    terminalResult = { data: LAYOUT, error: null };

    const id = await saveStoreCountLayout(STORE, 'Walk A2', ['i9'], LAYOUT);

    expect(id).toBe(LAYOUT);
    expect(calls.rpc[0].args).toEqual({
      p_store_id: STORE,
      p_name: 'Walk A2',
      p_item_ids: ['i9'],
      p_layout_id: LAYOUT,
    });
  });

  it('coerces an explicit null layoutId to p_layout_id null', async () => {
    terminalResult = { data: 'x', error: null };
    await saveStoreCountLayout(STORE, 'n', [], null);
    expect((calls.rpc[0].args as any).p_layout_id).toBeNull();
  });

  it('throws the PostgREST error on refusal (403/400/404)', async () => {
    terminalResult = { data: null, error: { message: 'layout limit reached' } };
    await expect(saveStoreCountLayout(STORE, 'n', [])).rejects.toEqual({
      message: 'layout limit reached',
    });
  });
});

describe('db.renameStoreCountLayout — RPC rename_store_count_layout', () => {
  it('passes p_layout_id + p_name, returns the id', async () => {
    terminalResult = { data: LAYOUT, error: null };
    const id = await renameStoreCountLayout(LAYOUT, 'Renamed');
    expect(id).toBe(LAYOUT);
    expect(calls.rpc[0].fn).toBe('rename_store_count_layout');
    expect(calls.rpc[0].args).toEqual({ p_layout_id: LAYOUT, p_name: 'Renamed' });
  });

  it('throws the PostgREST error on refusal', async () => {
    terminalResult = { data: null, error: { message: 'forbidden' } };
    await expect(renameStoreCountLayout(LAYOUT, 'x')).rejects.toEqual({ message: 'forbidden' });
  });
});

describe('db.deleteStoreCountLayout — RPC delete_store_count_layout', () => {
  it('passes p_layout_id, returns the deleted id', async () => {
    terminalResult = { data: LAYOUT, error: null };
    const id = await deleteStoreCountLayout(LAYOUT);
    expect(id).toBe(LAYOUT);
    expect(calls.rpc[0].fn).toBe('delete_store_count_layout');
    expect(calls.rpc[0].args).toEqual({ p_layout_id: LAYOUT });
  });

  it('throws the PostgREST error on refusal (403/404)', async () => {
    terminalResult = { data: null, error: { message: 'layout not found' } };
    await expect(deleteStoreCountLayout(LAYOUT)).rejects.toEqual({ message: 'layout not found' });
  });
});
