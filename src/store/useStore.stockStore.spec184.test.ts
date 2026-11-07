// src/store/useStore.stockStore.spec184.test.ts — Spec 184 (D-11, N5, AC-33, AC-35).
//
// stockStoreFromStore reloads only when rows were added, whichever store is
// current, and resolves null after notifying on failure. loadStoreStockPreview
// catches and notifies. inventoryLoadStatus distinguishes "loaded and empty" from
// "failed", which `inventory: []` can't.

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { user: { id: 'u1' } } },
        error: null,
      }),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
  hasActiveSession: jest.fn().mockResolvedValue(true),
}));

const mockLoadPayload = (over: Record<string, unknown> = {}) => ({
  brand: null,
  catalogIngredients: [],
  inventory: [],
  inventoryFailed: false,
  recipes: [],
  prepRecipes: [],
  vendors: [],
  wasteLog: [],
  auditLog: [],
  eodSubmissions: [],
  orderSubmissions: [],
  posRecipeAliases: [],
  recipeCategories: [],
  ingredientCategories: [],
  ingredientConversions: [],
  ...over,
});

jest.mock('../lib/db', () => {
  // Anything not named resolves empty, so loadFromSupabase's tail stays quiet.
  const named: Record<string, unknown> = {
    fetchStores: jest.fn().mockResolvedValue([]),
    fetchAllForStore: jest.fn(),
    stockStoreFromStore: jest.fn(),
    fetchStoreStockPreview: jest.fn(),
  };
  return new Proxy(named, {
    get(target, key: string) {
      if (key === '__esModule') return true;
      if (!(key in target)) target[key] = jest.fn().mockResolvedValue([]);
      return target[key];
    },
  });
});

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';

const INITIAL_STATE = useStore.getState();
const stockMock = db.stockStoreFromStore as jest.Mock;
const previewMock = db.fetchStoreStockPreview as jest.Mock;
const fetchAllMock = db.fetchAllForStore as jest.Mock;
const toastShowMock = (Toast as unknown as { show: jest.Mock }).show;

const CURRENT = { id: 'cur', brandId: 'b1', name: 'Current', address: '1 Main', status: 'active' as const };

const RESULT: db.StockStoreResult = {
  itemsCopied: 3,
  itemsSkipped: 0,
  linksAdded: 3,
  linksSkippedCrossBrand: 0,
  extrasAdded: 0,
  extrasSkipped: 0,
  itemsNoVendorLink: 0,
  targetHasOrderSchedule: false,
  uncarriedRemaining: 0,
};

const flush = () => new Promise<void>((r) => setImmediate(r));

let loadSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ stores: [CURRENT], currentStore: CURRENT });
  fetchAllMock.mockResolvedValue(mockLoadPayload());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useStore.stockStoreFromStore', () => {
  const spyOnLoad = () => {
    loadSpy = jest.fn().mockResolvedValue(undefined) as unknown as jest.SpyInstance;
    useStore.setState({ loadFromSupabase: loadSpy as unknown as (id?: string) => Promise<void> });
  };

  it('passes its arguments through and resolves the result', async () => {
    spyOnLoad();
    stockMock.mockResolvedValue(RESULT);
    await expect(useStore.getState().stockStoreFromStore('t', 's', ['c1'])).resolves.toEqual(RESULT);
    expect(stockMock).toHaveBeenCalledWith('t', 's', ['c1']);
  });

  it('reloads once when items were copied', async () => {
    spyOnLoad();
    stockMock.mockResolvedValue(RESULT);
    await useStore.getState().stockStoreFromStore('cur', 's');
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith('cur');
  });

  it('reloads the CURRENT store even when the target is another store (F-7)', async () => {
    spyOnLoad();
    stockMock.mockResolvedValue(RESULT);
    await useStore.getState().stockStoreFromStore('some-other-store', 's');
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith('cur');
  });

  it('reloads when only ticked rows were added', async () => {
    spyOnLoad();
    stockMock.mockResolvedValue({ ...RESULT, itemsCopied: 0, extrasAdded: 1 });
    await useStore.getState().stockStoreFromStore('cur', 's', ['c1']);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload when nothing was added', async () => {
    spyOnLoad();
    const nothing = { ...RESULT, itemsCopied: 0, extrasAdded: 0, itemsSkipped: 9 };
    stockMock.mockResolvedValue(nothing);
    await expect(useStore.getState().stockStoreFromStore('cur', 's')).resolves.toEqual(nothing);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('on failure notifies, resolves null, and does not reload', async () => {
    spyOnLoad();
    stockMock.mockRejectedValue({ code: '42501', message: 'stock_store: privileged only' });
    await expect(useStore.getState().stockStoreFromStore('cur', 's')).resolves.toBeNull();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Stock store failed',
        text2: 'stock_store: privileged only',
      }),
    );
  });
});

describe('useStore.loadStoreStockPreview', () => {
  it('passes its arguments through and resolves the preview', async () => {
    const preview = {
      brandId: 'b1', targetItemCount: 0, targetHasOrderSchedule: false, sources: [], uncarried: [],
    };
    previewMock.mockResolvedValue(preview);
    await expect(useStore.getState().loadStoreStockPreview('b1', 't')).resolves.toEqual(preview);
    expect(previewMock).toHaveBeenCalledWith('b1', 't');
  });

  it('on failure notifies and resolves null', async () => {
    previewMock.mockRejectedValue(new Error('nope'));
    await expect(useStore.getState().loadStoreStockPreview('b1')).resolves.toBeNull();
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Load stock options failed', text2: 'nope' }),
    );
  });
});

describe('inventoryLoadStatus (N5)', () => {
  it('starts unknown', () => {
    expect(useStore.getState().inventoryLoadStatus).toBe('unknown');
  });

  it('is loaded after a good load, even of an empty store', async () => {
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(fetchAllMock).toHaveBeenCalledWith('cur');
    expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
    expect(useStore.getState().inventory).toEqual([]);
  });

  it('is failed when the inventory read failed', async () => {
    fetchAllMock.mockResolvedValue(mockLoadPayload({ inventoryFailed: true }));
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(useStore.getState().inventoryLoadStatus).toBe('failed');
  });

  it('reads as loaded when a mock omits the flag', async () => {
    const { inventoryFailed: _omitted, ...withoutFlag } = mockLoadPayload();
    fetchAllMock.mockResolvedValue(withoutFlag);
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
  });

  it('recovers: a later good load replaces failed', async () => {
    fetchAllMock.mockResolvedValueOnce(mockLoadPayload({ inventoryFailed: true }));
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(useStore.getState().inventoryLoadStatus).toBe('failed');

    fetchAllMock.mockResolvedValue(mockLoadPayload());
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
  });

  it('is not written by a load dropped because the user left the store (spec 176 R-3)', async () => {
    useStore.setState({ inventoryLoadStatus: 'loaded' });
    let resolveLoad!: (v: unknown) => void;
    fetchAllMock.mockReturnValue(new Promise((r) => { resolveLoad = r; }));

    const pending = useStore.getState().loadFromSupabase('cur');
    await flush();
    useStore.setState({ currentStore: { ...CURRENT, id: 'elsewhere' } });
    resolveLoad(mockLoadPayload({ inventoryFailed: true }));
    await pending;

    expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
  });

  it('is not written when the load throws outright: prior state is kept', async () => {
    useStore.setState({ inventoryLoadStatus: 'loaded' });
    fetchAllMock.mockRejectedValue(new Error('network'));
    await useStore.getState().loadFromSupabase('cur');
    await flush();
    expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
  });

  describe('the __all__ view', () => {
    const ALL = { ...CURRENT, id: '__all__' };
    const S1 = { ...CURRENT, id: 's1' };
    const S2 = { ...CURRENT, id: 's2' };

    beforeEach(() => {
      (db.fetchStores as jest.Mock).mockResolvedValue([S1, S2]);
      useStore.setState({ stores: [S1, S2], currentStore: ALL });
    });

    it('is loaded when every store loaded', async () => {
      fetchAllMock.mockResolvedValue(mockLoadPayload());
      await useStore.getState().loadFromSupabase('__all__');
      await flush();
      expect(useStore.getState().inventoryLoadStatus).toBe('loaded');
    });

    it('is failed when any store flags a failed inventory read', async () => {
      fetchAllMock
        .mockResolvedValueOnce(mockLoadPayload())
        .mockResolvedValueOnce(mockLoadPayload({ inventoryFailed: true }));
      await useStore.getState().loadFromSupabase('__all__');
      await flush();
      expect(useStore.getState().inventoryLoadStatus).toBe('failed');
    });

    it('is failed when any store failed outright', async () => {
      fetchAllMock
        .mockResolvedValueOnce(mockLoadPayload())
        .mockRejectedValueOnce(new Error('network'));
      await useStore.getState().loadFromSupabase('__all__');
      await flush();
      expect(useStore.getState().inventoryLoadStatus).toBe('failed');
    });
  });
});
