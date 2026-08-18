// src/store/useStore.lastCounted.spec160.test.ts — spec 160 §5 (AC-20/21/22).
//
// Release-coordinator BLOCK item: the `loadItemsLastCounted` store action had
// zero coverage (`grep -rln "lastCounted" src/store --include="*.test.ts*"`
// returned nothing pre-fix). Pins:
//   • AC-20 — exactly ONE `db.fetchItemsLastCounted` call per
//     `loadFromSupabase` per-store cycle, and a STATIC enumeration of every
//     invocation call site in the non-test source tree, so a future per-row
//     `useEffect` (or any third call site) fails this suite even though it
//     would never show up as a call-count regression in a single-cycle test.
//   • AC-21 — the tail is fire-and-forget: `loadFromSupabase` resolves (and
//     the rest of its `set(...)` — inventory, etc. — is already committed)
//     WHILE `lastCountedLoaded` is still `false`, i.e. first paint is not
//     gated on this RPC.
//   • AC-22 — cached by store id; cleared to NOT LOADED (not loaded-empty) on
//     both `loadFromSupabase` branches (`__all__` and per-store), and the
//     `__all__` branch never calls the loader at all.
//   • The error path leaves `lastCountedByItem: {}` / `lastCountedLoaded:
//     false` and fires exactly one `notifyBackendError` toast — it does NOT
//     degrade to a loaded-empty map (which would render "never counted"
//     across every row).
//
// Mocking follows useStore.switching.test.ts (spec 111) / the spec-151
// lastOrderContext suite: stub `../lib/supabase` (module-eval crash guard),
// `../lib/auth` (dynamic-import boundary inside loadFromSupabase's session
// probe), and `../lib/db` (namespace import). `currentUser` stays null so
// `fetchNotifications` never fires, bounding the mock surface.

import * as fs from 'fs';
import * as path from 'path';

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
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

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null,
    catalogIngredients: [],
    inventory: [],
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
    orderSchedule: {},
    savedReports: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchMenuCapacity: jest.fn().mockResolvedValue([]),
  fetchNotifications: jest.fn().mockResolvedValue([]),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 160 — the assertion surface.
  fetchItemsLastCounted: jest.fn().mockResolvedValue([]),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';

const INITIAL_STATE = useStore.getState();
const fetchMock = db.fetchItemsLastCounted as jest.Mock;

/** Flush microtasks so any fire-and-forget promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A promise whose resolution the test controls explicitly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock.mockResolvedValue([]);
  // Replace, not merge — Zustand's second-positional replace flag.
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ currentUser: null, switching: null });
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('initial state', () => {
  it('starts unloaded, empty, and store-less — nothing is claimed before the first load', () => {
    expect(INITIAL_STATE.lastCountedByItem).toEqual({});
    expect(INITIAL_STATE.lastCountedStoreId).toBeNull();
    expect(INITIAL_STATE.lastCountedLoaded).toBe(false);
  });
});

describe('AC-20 — exactly one RPC per store view, no N+1', () => {
  it('fires exactly once when loadFromSupabase runs a per-store cycle', async () => {
    fetchMock.mockResolvedValue([
      { itemId: 'i-1', lastCountedAt: '2026-08-10T00:00:00Z' },
    ]);

    await useStore.getState().loadFromSupabase('store-1');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('store-1');
  });

  it('does not re-fire on a second call to the action alone (no per-row / per-render invocation)', async () => {
    useStore.setState({ currentStore: { id: 'store-1', name: 'S1' } as any });
    await useStore.getState().loadItemsLastCounted();
    await useStore.getState().loadItemsLastCounted();
    expect(fetchMock).toHaveBeenCalledTimes(2); // two DELIBERATE calls, not a hidden multiplier
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'store-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'store-1');
  });

  // Static enumeration — the runtime tests above only prove ONE call site
  // (loadFromSupabase) behaves correctly in isolation. AC-20's actual claim is
  // that there is no OTHER call site anywhere (a per-row useEffect, a filter
  // keystroke handler, etc.). A per-cycle call-count assertion cannot catch a
  // brand-new call site added elsewhere in the tree; grepping the source can.
  it('has EXACTLY the two known invocation call sites in the non-test source tree (useStore.ts fire-and-forget tail + InventoryCountSection.tsx post-submit refresh)', () => {
    const SRC_ROOT = path.resolve(__dirname, '..');
    const hits: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          // Deliberately NOT `\.loadItemsLastCounted\(` — requiring the paren
          // matches only direct member calls, and misses the selector idiom
          // this codebase already uses for loader actions elsewhere:
          //   const load = useStore((s) => s.loadWeeklyCountStatus);  // no paren
          //   void load(todayIso());                                  // no dot
          // (InventoryCountSection.tsx:167/507, ReorderSection.tsx:1529/1552).
          // A future per-row useEffect written that way would have slipped
          // through the paren form silently — the exact regression this
          // enumeration exists to catch. Matching the member access alone
          // covers both shapes, and stays clear of the prose mentions in
          // types/index.ts, db.ts and useStore.ts's own docblocks, which
          // reference the action by bare name with no leading dot.
          const matches = text.match(/\.loadItemsLastCounted\b/g);
          if (matches) {
            for (let i = 0; i < matches.length; i++) hits.push(path.relative(SRC_ROOT, full));
          }
        }
      }
    }
    walk(SRC_ROOT);

    expect(hits.sort()).toEqual([
      path.join('screens', 'cmd', 'sections', 'InventoryCountSection.tsx'),
      path.join('store', 'useStore.ts'),
    ]);
  });
});

describe('AC-21 — first paint is not blocked by the fetch', () => {
  it('loadFromSupabase RESOLVES while lastCountedLoaded is still false — the tail is unawaited', async () => {
    const d = deferred<Array<{ itemId: string; lastCountedAt: string | null }>>();
    fetchMock.mockReturnValue(d.promise);

    // loadFromSupabase itself completes (inventory etc. is already committed)
    // even though the last-counted fetch has NOT resolved yet.
    await useStore.getState().loadFromSupabase('store-1');

    expect(useStore.getState().lastCountedLoaded).toBe(false);
    expect(useStore.getState().storeLoading).toBe(false); // rest of the load finished

    // Resolve the deferred fetch now — only then does the slice populate.
    d.resolve([{ itemId: 'i-1', lastCountedAt: '2026-08-10T00:00:00Z' }]);
    await flush();

    expect(useStore.getState().lastCountedLoaded).toBe(true);
    expect(useStore.getState().lastCountedByItem).toEqual({ 'i-1': '2026-08-10T00:00:00Z' });
    expect(useStore.getState().lastCountedStoreId).toBe('store-1');
  });
});

describe('AC-22 — cached by store id; cleared (not loaded-empty) on every reload path; __all__ never fetches', () => {
  it('the __all__ branch of loadFromSupabase clears the slice to NOT LOADED and never calls the RPC', async () => {
    useStore.setState({
      lastCountedByItem: { 'i-1': '2026-08-10T00:00:00Z' },
      lastCountedStoreId: 'store-1',
      lastCountedLoaded: true,
      stores: [],
    });

    await useStore.getState().loadFromSupabase('__all__');
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useStore.getState().lastCountedByItem).toEqual({});
    expect(useStore.getState().lastCountedStoreId).toBeNull();
    expect(useStore.getState().lastCountedLoaded).toBe(false);
  });

  it('the action itself bails on __all__ without calling the RPC', async () => {
    await useStore.getState().loadItemsLastCounted('__all__');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a per-store loadFromSupabase cycle clears the PREVIOUS store map to NOT LOADED before the new fetch resolves', async () => {
    useStore.setState({
      lastCountedByItem: { 'stale-item': '2026-01-01T00:00:00Z' },
      lastCountedStoreId: 'store-0',
      lastCountedLoaded: true,
    });
    const d = deferred<Array<{ itemId: string; lastCountedAt: string | null }>>();
    fetchMock.mockReturnValue(d.promise);

    await useStore.getState().loadFromSupabase('store-1');

    // Cleared synchronously in the same `set` as the rest of the store-switch
    // data — a stale store's dates must never render against the new store's
    // rows, even transiently.
    expect(useStore.getState().lastCountedByItem).toEqual({});
    expect(useStore.getState().lastCountedStoreId).toBeNull();
    expect(useStore.getState().lastCountedLoaded).toBe(false);

    d.resolve([{ itemId: 'i-9', lastCountedAt: null }]);
    await flush();
    expect(useStore.getState().lastCountedStoreId).toBe('store-1');
  });

  it('refetches on a genuine store switch — called once per store id, keyed correctly each time', async () => {
    fetchMock.mockResolvedValue([]);
    await useStore.getState().loadFromSupabase('store-1');
    await flush();
    await useStore.getState().loadFromSupabase('store-2');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'store-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'store-2');
    expect(useStore.getState().lastCountedStoreId).toBe('store-2');
  });
});

describe('error path — never degrades to a loaded-empty map', () => {
  it('leaves lastCountedByItem {} / lastCountedLoaded false and fires exactly one notifyBackendError toast', async () => {
    fetchMock.mockRejectedValue(new Error('rpc exploded'));
    useStore.setState({ currentStore: { id: 'store-1', name: 'S1' } as any });

    await useStore.getState().loadItemsLastCounted();

    // NOT `{ loaded: true, byItem: {} }` — that would render "never counted"
    // across every row, which is actively false (the read simply failed).
    expect(useStore.getState().lastCountedByItem).toEqual({});
    expect(useStore.getState().lastCountedStoreId).toBeNull();
    expect(useStore.getState().lastCountedLoaded).toBe(false);
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Load last counted failed' }),
    );
  });

  it('a failure after a prior successful load reverts to NOT LOADED, not to the stale-but-valid map', async () => {
    useStore.setState({
      currentStore: { id: 'store-1', name: 'S1' } as any,
      lastCountedByItem: { 'i-1': '2026-08-10T00:00:00Z' },
      lastCountedStoreId: 'store-1',
      lastCountedLoaded: true,
    });
    fetchMock.mockRejectedValue(new Error('network blip'));

    await useStore.getState().loadItemsLastCounted();

    expect(useStore.getState().lastCountedByItem).toEqual({});
    expect(useStore.getState().lastCountedLoaded).toBe(false);
  });

  it('does not reject — the fire-and-forget caller may `void` it safely', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    useStore.setState({ currentStore: { id: 'store-1', name: 'S1' } as any });
    await expect(useStore.getState().loadItemsLastCounted()).resolves.toBeUndefined();
  });
});
