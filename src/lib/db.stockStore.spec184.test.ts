// src/lib/db.stockStore.spec184.test.ts — Spec 184 (AC-36).
//
// Pins the two stock wrappers: RPC names, argument names, `[]` sent as null,
// camelCase mapping with Number() on counts, and throwing on error so the store
// slice can surface it.

const mockRpc = jest.fn();
let abortSpy: jest.Mock;

jest.mock('./supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>, opts: { kind: string; label: string }) => {
        mockTrackOpts(opts);
        return fn(new AbortController().signal);
      },
    }),
  },
}));

const mockTrackOpts = jest.fn();

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import {
  fetchStoreStockPreview,
  stockStoreFromStore,
  mapStockStoreResult,
  mapStoreStockPreview,
} from './db';

beforeEach(() => {
  jest.clearAllMocks();
  abortSpy = jest.fn().mockResolvedValue({ data: {}, error: null });
  mockRpc.mockReturnValue({ abortSignal: abortSpy });
});

const WIRE_RESULT = {
  items_copied: 8,
  items_skipped: 1,
  links_added: 7,
  links_skipped_cross_brand: 2,
  extras_added: 3,
  extras_skipped: 4,
  items_no_vendor_link: 5,
  target_has_order_schedule: true,
  uncarried_remaining: 6,
};

describe('stockStoreFromStore', () => {
  it('calls the RPC with the design\'s argument names', async () => {
    await stockStoreFromStore('t', 's', ['c1', 'c2']);
    expect(mockRpc).toHaveBeenCalledWith('stock_store_from_store', {
      p_target_store_id: 't',
      p_source_store_id: 's',
      p_extra_catalog_ids: ['c1', 'c2'],
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('sends an empty tick list as null', async () => {
    await stockStoreFromStore('t', 's', []);
    expect(mockRpc.mock.calls[0][1].p_extra_catalog_ids).toBeNull();
  });

  it('sends omitted ticks as null', async () => {
    await stockStoreFromStore('t', 's');
    expect(mockRpc.mock.calls[0][1].p_extra_catalog_ids).toBeNull();
  });

  it('goes through track as a write', async () => {
    await stockStoreFromStore('t', 's');
    expect(mockTrackOpts).toHaveBeenCalledWith({ kind: 'write', label: 'stockStoreFromStore' });
  });

  it('maps the result to camelCase', async () => {
    abortSpy.mockResolvedValue({ data: WIRE_RESULT, error: null });
    await expect(stockStoreFromStore('t', 's')).resolves.toEqual({
      itemsCopied: 8,
      itemsSkipped: 1,
      linksAdded: 7,
      linksSkippedCrossBrand: 2,
      extrasAdded: 3,
      extrasSkipped: 4,
      itemsNoVendorLink: 5,
      targetHasOrderSchedule: true,
      uncarriedRemaining: 6,
    });
  });

  it('throws the PostgREST error, code and message intact', async () => {
    const err = { code: '42501', message: 'stock_store: privileged only' };
    abortSpy.mockResolvedValue({ data: null, error: err });
    await expect(stockStoreFromStore('t', 's')).rejects.toBe(err);
  });
});

describe('mapStockStoreResult', () => {
  it('applies Number() to counts that arrive as strings', () => {
    const r = mapStockStoreResult({ ...WIRE_RESULT, items_copied: '8', links_added: '7' });
    expect(r.itemsCopied).toBe(8);
    expect(r.linksAdded).toBe(7);
  });

  it('reads a missing schedule flag as false', () => {
    expect(mapStockStoreResult({ items_copied: 0 }).targetHasOrderSchedule).toBe(false);
  });
});

describe('fetchStoreStockPreview', () => {
  const WIRE_PREVIEW = {
    brand_id: 'b',
    target_item_count: 4,
    target_has_order_schedule: false,
    sources: [{
      store_id: 's1', name: 'Towson', status: 'inactive',
      item_count: 10, items_to_add: 6, items_already_at_target: 4,
      items_no_vendor_link: 2, carried_elsewhere_count: 1,
    }],
    uncarried: [{
      catalog_id: 'c1', name: 'Salt', unit: 'lb', category: null, i18n_names: { es: 'Sal' },
    }],
  };

  it('calls the RPC with the design\'s argument names', async () => {
    await fetchStoreStockPreview('b', 't');
    expect(mockRpc).toHaveBeenCalledWith('stock_store_preview', {
      p_brand_id: 'b',
      p_target_store_id: 't',
    });
  });

  it('sends a missing target as null', async () => {
    await fetchStoreStockPreview('b');
    expect(mockRpc.mock.calls[0][1].p_target_store_id).toBeNull();
    await fetchStoreStockPreview('b', null);
    expect(mockRpc.mock.calls[1][1].p_target_store_id).toBeNull();
  });

  it('goes through track as a read', async () => {
    await fetchStoreStockPreview('b');
    expect(mockTrackOpts).toHaveBeenCalledWith({ kind: 'read', label: 'fetchStoreStockPreview' });
  });

  it('maps the preview to camelCase', async () => {
    abortSpy.mockResolvedValue({ data: WIRE_PREVIEW, error: null });
    await expect(fetchStoreStockPreview('b', 't')).resolves.toEqual({
      brandId: 'b',
      targetItemCount: 4,
      targetHasOrderSchedule: false,
      sources: [{
        storeId: 's1', name: 'Towson', status: 'inactive',
        itemCount: 10, itemsToAdd: 6, itemsAlreadyAtTarget: 4,
        itemsNoVendorLink: 2, carriedElsewhereCount: 1,
      }],
      uncarried: [{
        catalogId: 'c1', name: 'Salt', unit: 'lb', category: null, i18nNames: { es: 'Sal' },
      }],
    });
  });

  it('throws on error', async () => {
    const err = { code: '22023', message: 'stock_store: brand is required' };
    abortSpy.mockResolvedValue({ data: null, error: err });
    await expect(fetchStoreStockPreview('b')).rejects.toBe(err);
  });
});

describe('mapStoreStockPreview', () => {
  it('keeps null target fields null, not zero, when no target was named', () => {
    const p = mapStoreStockPreview({
      brand_id: 'b', target_item_count: null, target_has_order_schedule: null, sources: [], uncarried: [],
    });
    expect(p.targetItemCount).toBeNull();
    expect(p.targetHasOrderSchedule).toBeNull();
  });

  it('keeps a zero target count as zero', () => {
    const p = mapStoreStockPreview({ brand_id: 'b', target_item_count: 0, sources: [], uncarried: [] });
    expect(p.targetItemCount).toBe(0);
  });

  it('defaults a missing i18n map and missing lists', () => {
    expect(mapStoreStockPreview({ brand_id: 'b' }).sources).toEqual([]);
    const p = mapStoreStockPreview({
      brand_id: 'b',
      uncarried: [{ catalog_id: 'c', name: 'n', unit: 'u', category: 'x' }],
    });
    expect(p.uncarried[0].i18nNames).toEqual({});
  });
});
