// src/store/useStore.reorderReload.spec175.test.ts — spec 175 §9.1.
//
// Pins the reorder slice across `loadFromSupabase`:
//   • `reorderStoreId` — the payload's owner tag (AC-1, AC-2): null at boot /
//     logout, written in the SAME `set` as a successful foreground payload,
//     recording the store the fetch was ISSUED for (R2).
//   • SAME-STORE RELOAD (AC-3..AC-7): the payload and `lastOrderContext` stay
//     on screen for every state the reload produces, `reorderLoading` never
//     flips, and exactly one silent `fetchReorderSuggestions(sid, asOfDate)`
//     fires — not awaited, warn-only on failure.
//   • the silent result's DROP rules (AC-8..AC-11, plus R4's newer-silent-wins).
//   • STORE SWITCH / nothing loaded / `__all__` (AC-12..AC-15): today's clear,
//     and zero reorder fetches from `loadFromSupabase` itself.
//   • untouched neighbours (AC-16): `reorderEdits`, the capacity and
//     last-counted tails.
//
// Harness follows useStore.lastCounted.spec160.test.ts. Anti-vacuity: every
// same-store case asserts `fetchAllForStore('S')` ran (so the reload really
// got past the spec-152 session probe — `hasActiveSession` is mocked TRUE for
// that reason), and every keep case asserts the silent fetch went out with
// `('S', 'D')`.

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
  // Load-bearing: without a live session the spec-152 probe bails before
  // `fetchAllForStore`, and the keep / silent paths never run.
  hasActiveSession: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/webPush', () => ({
  unsubscribeFromPush: jest.fn().mockResolvedValue(undefined),
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
  fetchItemsLastCounted: jest.fn().mockResolvedValue([]),
  fetchNotifications: jest.fn().mockResolvedValue([]),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 175 — the assertion surface. Set per test.
  fetchReorderSuggestions: jest.fn(),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';
import type { LastOrderContext, ReorderPayload } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchReorder = db.fetchReorderSuggestions as jest.Mock;
const fetchAll = db.fetchAllForStore as jest.Mock;

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

/** Distinct object literals so `toBe` identity checks are meaningful. */
function payload(asOfDate: string, tag: string): ReorderPayload {
  return {
    asOfDate,
    vendors: [{ vendorId: `v-${tag}`, items: [] }],
    kpis: { vendorCount: 1, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
    warnings: [],
  } as unknown as ReorderPayload;
}

const P = payload('D', 'p');
const F = payload('D', 'f');
const F2 = payload('D', 'f2');

const L: LastOrderContext = {
  'v-p': {
    vendorId: 'v-p',
    lastOrderDate: '2026-07-29',
    confidence: 'placed',
    source: 'purchase_order',
    sourceId: 'po-1',
    countedDate: '2026-07-29',
    itemsTruncated: false,
    items: {},
  },
};

const store = (id: string) => ({ id, brandId: 'b', name: id, address: '', status: 'active' }) as any;

function seedSameStore(over: Record<string, unknown> = {}) {
  useStore.setState({
    currentStore: store('S'),
    reorderStoreId: 'S',
    reorderPayload: P,
    lastOrderContext: L,
    reorderLoading: false,
    reorderError: null,
    ...over,
  } as any);
}

type ReorderSnap = {
  reorderPayload: ReorderPayload | null;
  reorderLoading: boolean;
  reorderError: string | null;
  reorderStoreId: string | null;
  lastOrderContext: LastOrderContext | null;
};

/** Records the reorder fields of every state the store passes through. */
function record(): { states: ReorderSnap[]; stop: () => void } {
  const states: ReorderSnap[] = [];
  const stop = useStore.subscribe((s) => {
    states.push({
      reorderPayload: s.reorderPayload,
      reorderLoading: s.reorderLoading,
      reorderError: s.reorderError,
      reorderStoreId: s.reorderStoreId,
      lastOrderContext: s.lastOrderContext,
    });
  });
  return { states, stop };
}

function reorderFields() {
  const s = useStore.getState();
  return {
    reorderPayload: s.reorderPayload,
    reorderLoading: s.reorderLoading,
    reorderError: s.reorderError,
    reorderStoreId: s.reorderStoreId,
    lastOrderContext: s.lastOrderContext,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fetchReorder.mockReset();
  // Replace, not merge — Zustand's second-positional replace flag.
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ currentUser: null, switching: null });
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('AC-1 — reorderStoreId field', () => {
  it('is null in the initial state and after logout()', () => {
    expect(INITIAL_STATE.reorderStoreId).toBeNull();

    seedSameStore();
    useStore.getState().logout();
    expect(useStore.getState().reorderStoreId).toBeNull();
    expect(useStore.getState().reorderPayload).toBeNull();
  });
});

describe('AC-2 — foreground load records the issuing store', () => {
  it('writes the store captured at call start, in the same set as the payload', async () => {
    useStore.setState({ currentStore: store('A') });
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);
    const rec = record();

    // Same-store: the cross-store variant (switch A → B mid-fetch) is now a
    // drop (spec 176 R-1), covered by spec 176 AC-1.
    const p = useStore.getState().loadReorderSuggestions('D');
    d.resolve(F);
    await p;
    rec.stop();

    expect(fetchReorder).toHaveBeenCalledWith('A', 'D');
    expect(useStore.getState().reorderPayload).toBe(F);
    expect(useStore.getState().reorderStoreId).toBe('A');
    // One write: no state ever pairs the new payload with a different owner.
    for (const st of rec.states) {
      if (st.reorderPayload === F) expect(st.reorderStoreId).toBe('A');
    }
  });

  it('on failure leaves reorderStoreId and reorderPayload unchanged and sets reorderError', async () => {
    seedSameStore();
    fetchReorder.mockRejectedValueOnce(new Error('boom'));

    await useStore.getState().loadReorderSuggestions('D');

    expect(useStore.getState().reorderStoreId).toBe('S');
    expect(useStore.getState().reorderPayload).toBe(P);
    expect(useStore.getState().reorderError).toBe('boom');
  });
});

describe('same-store reload — keep + silent refresh', () => {
  it('AC-3 / AC-5 — payload never null, loading never true, context kept by reference', async () => {
    seedSameStore();
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);
    const rec = record();

    await useStore.getState().loadFromSupabase('S');
    d.resolve(F);
    await flush();
    rec.stop();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');
    expect(rec.states.length).toBeGreaterThan(0);
    for (const st of rec.states) {
      expect(st.reorderPayload).not.toBeNull();
      expect(st.reorderLoading).toBe(false);
      expect(st.lastOrderContext).toBe(L);
    }
    expect(useStore.getState().reorderPayload).toBe(F);
  });

  it('AC-4 — exactly one silent fetch, and loadFromSupabase does not await it', async () => {
    seedSameStore();
    fetchReorder.mockReturnValue(new Promise<ReorderPayload>(() => {}));

    await expect(useStore.getState().loadFromSupabase('S')).resolves.toBeUndefined();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledTimes(1);
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');
    expect(useStore.getState().reorderPayload).toBe(P);
  });

  it('AC-6 — success replaces the payload and clears a pre-existing error only when it lands', async () => {
    seedSameStore({ reorderError: 'old' });
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');
    expect(useStore.getState().reorderError).toBe('old');
    expect(useStore.getState().reorderPayload).toBe(P);

    d.resolve(F);
    await flush();

    expect(useStore.getState().reorderPayload).toBe(F);
    expect(useStore.getState().reorderError).toBeNull();
    expect(useStore.getState().reorderStoreId).toBe('S');
    expect(useStore.getState().reorderLoading).toBe(false);
  });

  it('AC-7 — failure keeps the payload, warns only, no toast, no unhandled rejection', async () => {
    seedSameStore({ reorderError: 'prior' });
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');

    // "No unhandled rejection" is enforced by jest itself: in this project's
    // node-env unit project an unhandled rejection fails the RUNNING test
    // (a `process.on('unhandledRejection')` spy is never invoked here — jest
    // intercepts first — so it would be a vacuous assertion). The two flushes
    // give Node's rejection tracking a full turn to report; the `console.warn`
    // assertion proves the refresh's own `.catch` is what handled it.
    d.reject(new Error('x'));
    await flush();
    await flush();

    expect(useStore.getState().reorderPayload).toBe(P);
    expect(useStore.getState().reorderError).toBe('prior');
    expect(useStore.getState().reorderStoreId).toBe('S');
    expect(useStore.getState().reorderLoading).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[Supabase] silent reorder refresh:', 'x');
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

describe('silent refresh drop cases', () => {
  it('AC-8 — store changed before it settles: dropped', async () => {
    seedSameStore();
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');

    useStore.setState({ currentStore: store('B') });
    d.resolve(F);
    await flush();

    expect(reorderFields()).toEqual({
      reorderPayload: P, reorderLoading: false, reorderError: null, reorderStoreId: 'S', lastOrderContext: L,
    });
    expect(useStore.getState().reorderPayload).toBe(P);
  });

  it('AC-9 — foreground load in flight (started BEFORE the silent one): dropped, foreground lands', async () => {
    seedSameStore();
    const d2 = deferred<ReorderPayload>(); // foreground
    const d1 = deferred<ReorderPayload>(); // silent
    fetchReorder.mockReturnValueOnce(d2.promise).mockReturnValueOnce(d1.promise);

    const fg = useStore.getState().loadReorderSuggestions('D');
    expect(useStore.getState().reorderLoading).toBe(true);
    // Issued AFTER the foreground, so only the loading rule can drop it.
    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenNthCalledWith(2, 'S', 'D');
    // The keep branch leaves the live foreground load's flag alone.
    expect(useStore.getState().reorderLoading).toBe(true);

    d1.resolve(F);
    await flush();
    expect(useStore.getState().reorderPayload).toBe(P);
    expect(useStore.getState().reorderLoading).toBe(true);

    d2.resolve(F2);
    await fg;
    expect(useStore.getState().reorderPayload).toBe(F2);
    expect(useStore.getState().reorderLoading).toBe(false);
  });

  it('AC-10 — foreground load started AFTER and already finished: dropped', async () => {
    seedSameStore();
    const d1 = deferred<ReorderPayload>(); // silent
    fetchReorder.mockReturnValueOnce(d1.promise).mockResolvedValueOnce(F2);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenNthCalledWith(1, 'S', 'D');

    await useStore.getState().loadReorderSuggestions('D');
    expect(useStore.getState().reorderPayload).toBe(F2);
    expect(useStore.getState().reorderLoading).toBe(false);

    d1.resolve(F);
    await flush();
    expect(useStore.getState().reorderPayload).toBe(F2);
  });

  it('AC-11a — payload gone before it settles: dropped', async () => {
    seedSameStore();
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');

    useStore.setState({ reorderPayload: null });
    d.resolve(F);
    await flush();

    expect(reorderFields()).toEqual({
      reorderPayload: null, reorderLoading: false, reorderError: null, reorderStoreId: 'S', lastOrderContext: L,
    });
  });

  it('AC-11b — payload now describes another date: dropped', async () => {
    seedSameStore();
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);

    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');

    const D2 = { ...P, asOfDate: 'D2' } as ReorderPayload;
    useStore.setState({ reorderPayload: D2 });
    d.resolve(F);
    await flush();

    expect(useStore.getState().reorderPayload).toBe(D2);
    expect(useStore.getState().reorderStoreId).toBe('S');
  });

  it('R4 — of two overlapping silent refreshes, the older result is dropped', async () => {
    seedSameStore();
    const d1 = deferred<ReorderPayload>();
    const d2 = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

    await useStore.getState().loadFromSupabase('S');
    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledTimes(2);
    expect(fetchReorder).toHaveBeenCalledTimes(2);

    d2.resolve(F2);
    await flush();
    expect(useStore.getState().reorderPayload).toBe(F2);

    d1.resolve(F);
    await flush();
    expect(useStore.getState().reorderPayload).toBe(F2);
  });
});

describe('store switch / nothing loaded / __all__', () => {
  it('AC-12 / AC-13 — payload owned by another store: cleared, zero reorder fetches', async () => {
    useStore.setState({
      currentStore: store('B'),
      reorderStoreId: 'A',
      reorderPayload: P,
      lastOrderContext: L,
      reorderLoading: false,
      reorderError: 'stale',
    } as any);

    await useStore.getState().loadFromSupabase('B');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('B');
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(reorderFields()).toEqual({
      reorderPayload: null, reorderLoading: false, reorderError: null, reorderStoreId: null, lastOrderContext: null,
    });
  });

  it('AC-12 / AC-13 — no owner (the spec-151 setup) with a context: cleared, zero reorder fetches', async () => {
    useStore.setState({
      currentStore: store('S'),
      reorderStoreId: null,
      reorderPayload: P,
      lastOrderContext: L,
    } as any);

    await useStore.getState().loadFromSupabase('S');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(reorderFields()).toEqual({
      reorderPayload: null, reorderLoading: false, reorderError: null, reorderStoreId: null, lastOrderContext: null,
    });
  });

  it('AC-14 — nothing loaded: zero reorder fetches, payload stays null', async () => {
    useStore.setState({ currentStore: store('S'), reorderStoreId: null, reorderPayload: null } as any);

    await useStore.getState().loadFromSupabase('S');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(useStore.getState().reorderPayload).toBeNull();
  });

  it('AC-15 — __all__ leaves all five reorder fields untouched and fetches nothing', async () => {
    // Spec 176 AC-20 — `__all__` must be current or the branch is dropped.
    seedSameStore({ reorderError: 'kept', currentStore: store('__all__') });
    const before = reorderFields();

    await useStore.getState().loadFromSupabase('__all__');
    await flush();

    const after = reorderFields();
    expect(after.reorderPayload).toBe(before.reorderPayload);
    expect(after.lastOrderContext).toBe(before.lastOrderContext);
    expect(after).toEqual(before);
    expect(fetchReorder).not.toHaveBeenCalled();
  });
});

describe('fix round 1 — the keep rule keys on the CURRENT store (A′)', () => {
  it('race — a stale store-A reload landing after B\'s foreground load keeps B\'s payload', async () => {
    useStore.setState({ currentStore: store('A') } as any);
    // Hold A's reload inside fetchAllForStore; resolve it later with the
    // default shape.
    const shape = await (fetchAll.getMockImplementation() as () => Promise<unknown>)();
    const dAll = deferred<unknown>();
    fetchAll.mockReturnValueOnce(dAll.promise);
    const loadA = useStore.getState().loadFromSupabase('A');
    await flush();
    expect(fetchAll).toHaveBeenCalledWith('A');

    // The user switches to B and B's foreground load lands first.
    const PB = payload('D', 'b');
    useStore.setState({ currentStore: store('B'), lastOrderContext: L } as any);
    fetchReorder.mockResolvedValueOnce(PB);
    await useStore.getState().loadReorderSuggestions('D');
    expect(useStore.getState().reorderStoreId).toBe('B');

    // A's stale reload now completes: it must not blank B's list.
    dAll.resolve(shape);
    await loadA;
    await flush();

    expect(useStore.getState().reorderPayload).toBe(PB);
    expect(useStore.getState().reorderStoreId).toBe('B');
    expect(useStore.getState().lastOrderContext).toBe(L);
    expect(fetchReorder).toHaveBeenCalledTimes(1); // the foreground load only
  });

  it('stale reload with the payload owned by the current store: kept by reference, NO silent fetch', async () => {
    const PB = payload('D', 'b');
    useStore.setState({
      currentStore: store('B'),
      reorderStoreId: 'B',
      reorderPayload: PB,
      lastOrderContext: L,
      reorderLoading: false,
      reorderError: null,
    } as any);
    const before = reorderFields();

    await useStore.getState().loadFromSupabase('A');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('A');
    expect(useStore.getState().reorderPayload).toBe(PB);
    expect(reorderFields()).toEqual(before);
    // The tail needs `sid === currentStore.id`; a stale reload issues none.
    expect(fetchReorder).not.toHaveBeenCalled();
  });

  it('a reload for a store that is no longer current writes nothing, even when it owns the payload (spec 176)', async () => {
    // Current store B is showing store S's payload (a foreign owner). A reload
    // for S — no longer current — is dropped before any write (spec 176 R-3).
    // Clearing a foreign-owned payload now happens on the current store's own
    // reload, already pinned by the AC-12 / AC-13 case above.
    seedSameStore({ currentStore: store('B') });
    const before = reorderFields();

    await useStore.getState().loadFromSupabase('S');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(useStore.getState().reorderPayload).toBe(P);
    expect(reorderFields()).toEqual(before);
  });
});

describe('AC-16 — untouched neighbours', () => {
  it('keeps reorderEdits by reference and runs the capacity + last-counted tails once', async () => {
    const edits = { v: { i: 3 } };
    seedSameStore({ reorderEdits: edits });
    fetchReorder.mockReturnValueOnce(new Promise<ReorderPayload>(() => {}));

    await useStore.getState().loadFromSupabase('S');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('S');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');
    expect(useStore.getState().reorderEdits).toBe(edits);
    expect(db.fetchMenuCapacity).toHaveBeenCalledTimes(1);
    expect(db.fetchMenuCapacity).toHaveBeenCalledWith('S');
    expect(db.fetchItemsLastCounted).toHaveBeenCalledTimes(1);
    expect(db.fetchItemsLastCounted).toHaveBeenCalledWith('S');
  });
});
