// src/store/useStore.lateResultGuards.spec176.test.ts — spec 176 §7.
//
// Pins the late-result store guards:
//   • R-1 — `loadReorderSuggestions` drops a result for a store the user has
//     left, on BOTH settle paths (AC-1..AC-4), resets `reorderLoading` only
//     while it is the newest FOREGROUND request (D-2), and never drops on
//     generation alone (AC-5, AC-6).
//   • R-2 — `recordExportedOrder` refuses when the list's owner differs from
//     the export's snapshot store (AC-7..AC-9).
//   • R-3 — `loadFromSupabase` drops a stale single-store or `__all__` load
//     before any slice write or tail (AC-10..AC-13).
//   • R-4 — only the newest load resets the spec-111 overlay (AC-14, AC-15).
//   • architect cases D-T1 (bump-after-probe) and D-T2 (no silent-only strand).
//
// Harness follows useStore.reorderReload.spec175.test.ts. Anti-vacuity: every
// drop case asserts the relevant `db` fetch ran with the call-start store.
// Two harness rules (design §7.1): a "newer load in flight" is only proven by
// asserting ITS `fetchAllForStore` call before settling the older one (the
// load counter is bumped after the session probe), and every deferred is
// settled before a test ends — the module-level counters survive the
// `setState(INITIAL_STATE, true)` reset, so a dangling load would leak.

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
  // `fetchAllForStore`. D-T1 swaps in deferred probes per call.
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
  fetchMenuCapacity: jest.fn().mockResolvedValue([]),
  fetchItemsLastCounted: jest.fn().mockResolvedValue([]),
  fetchNotifications: jest.fn().mockResolvedValue([]),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn(),
  // R-2 — the draft-PO writer and its POs-list refresh (spec 156 mirror).
  upsertVendorDraftOrder: jest.fn().mockResolvedValue('po-1'),
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import * as auth from '../lib/auth';
import { useStore } from './useStore';
import type { LastOrderContext, ReorderPayload, ReorderVendor } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchReorder = db.fetchReorderSuggestions as jest.Mock;
const fetchAll = db.fetchAllForStore as jest.Mock;
const fetchStores = db.fetchStores as jest.Mock;
const upsertMock = db.upsertVendorDraftOrder as jest.Mock;
const hasActiveSessionMock = auth.hasActiveSession as jest.Mock;
const toastShow = Toast.show as jest.Mock;
const DEFAULT_FETCH_ALL = fetchAll.getMockImplementation();

/** Flush microtasks so any fire-and-forget promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void };

/** A promise whose resolution the test controls explicitly. */
function deferred<T>(): Deferred<T> {
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

const PB = payload('D', 'pb');
const FA = payload('D', 'fa');
const FB = payload('D', 'fb');
const F = payload('D', 'f');
const FS = payload('D', 'fs');

const L: LastOrderContext = {
  'v-pb': {
    vendorId: 'v-pb',
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

/** A `fetchAllForStore` result whose per-store slices are tagged by store. */
function shape(tag: string) {
  return {
    brand: { id: `brand-${tag}`, name: `Brand ${tag}` },
    catalogIngredients: [],
    inventory: [{ id: `i-${tag}`, name: `Item ${tag}`, storeId: tag }],
    recipes: [],
    prepRecipes: [],
    vendors: [{ id: `v-${tag}`, name: `Vendor ${tag}` }],
    wasteLog: [],
    auditLog: [],
    eodSubmissions: [],
    orderSubmissions: [],
    posRecipeAliases: [],
    recipeCategories: [],
    ingredientCategories: [],
    ingredientConversions: [],
    orderSchedule: { Monday: [`v-${tag}`] },
    savedReports: [],
  };
}

/** Seeds B-shaped values for every key the single-store `set` writes. */
function seedStoreB() {
  useStore.setState({
    currentStore: store('B'),
    brand: { id: 'brand-B', name: 'Brand B' },
    catalogIngredients: [{ id: 'cat-B' }],
    inventory: [{ id: 'i-B', name: 'Item B', storeId: 'B' }],
    recipes: [{ id: 'r-B' }],
    prepRecipes: [{ id: 'p-B' }],
    vendors: [{ id: 'v-B', name: 'Vendor B' }],
    wasteLog: [{ id: 'w-B' }],
    auditLog: [{ id: 'a-B' }],
    eodSubmissions: [{ id: 'e-B' }],
    orderSubmissions: [{ id: 'o-B' }],
    posRecipeAliases: [{ id: 'pa-B' }],
    savedReports: [{ id: 'sr-B' }],
    orderSchedule: { Monday: ['v-B'], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] },
    menuCapacity: { 'r-B': { recipeId: 'r-B' } },
    lastCountedByItem: { 'i-B': '2026-10-20T00:00:00Z' },
    lastCountedStoreId: 'B',
    lastCountedLoaded: true,
    reorderPayload: PB,
    reorderStoreId: 'B',
    reorderLoading: false,
    reorderError: null,
    lastOrderContext: L,
  } as any);
}

/** Every key the single-store branch writes, plus the five reorder fields. */
const LOAD_KEYS = [
  'brand', 'catalogIngredients', 'inventory', 'recipes', 'prepRecipes', 'vendors',
  'wasteLog', 'auditLog', 'eodSubmissions', 'orderSubmissions', 'posRecipeAliases',
  'savedReports', 'orderSchedule', 'menuCapacity',
  'lastCountedByItem', 'lastCountedStoreId', 'lastCountedLoaded',
  'reorderPayload', 'reorderStoreId', 'reorderLoading', 'reorderError', 'lastOrderContext',
] as const;

function snapshot(keys: readonly string[] = LOAD_KEYS): Record<string, unknown> {
  const s = useStore.getState() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = s[k];
  return out;
}

/** Same reference for every key — "unchanged" means not rewritten at all. */
function expectUnchanged(before: Record<string, unknown>) {
  const after = snapshot(Object.keys(before));
  for (const k of Object.keys(before)) {
    expect({ key: k, same: after[k] === before[k] }).toEqual({ key: k, same: true });
  }
}

function reorderFields() {
  const s = useStore.getState();
  return {
    reorderPayload: s.reorderPayload,
    reorderLoading: s.reorderLoading,
    reorderError: s.reorderError,
    reorderStoreId: s.reorderStoreId,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fetchReorder.mockReset();
  fetchAll.mockImplementation(DEFAULT_FETCH_ALL);
  fetchStores.mockResolvedValue([]);
  hasActiveSessionMock.mockResolvedValue(true);
  upsertMock.mockResolvedValue('po-1');
  // Replace, not merge — Zustand's second-positional replace flag.
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ currentUser: null, switching: null });
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

// ── R-1 — loadReorderSuggestions drops a late result ────────────────────────

describe('R-1 — a late foreground reorder result for a left store is dropped', () => {
  /** Starts A's foreground load against a deferred fetch (AC-1..AC-4 setup). */
  function startA() {
    useStore.setState({ currentStore: store('A') });
    const dA = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(dA.promise);
    const pA = useStore.getState().loadReorderSuggestions('D');
    expect(fetchReorder).toHaveBeenCalledWith('A', 'D');
    expect(useStore.getState().reorderLoading).toBe(true);
    return { dA, pA };
  }

  function switchToB() {
    useStore.setState({ currentStore: store('B'), reorderPayload: PB, reorderStoreId: 'B', reorderError: null });
  }

  it('AC-1 — late success: B\'s payload, owner and error stay', async () => {
    const { dA, pA } = startA();
    switchToB();

    dA.resolve(FA);
    await pA;

    expect(useStore.getState().reorderPayload).toBe(PB);
    expect(useStore.getState().reorderStoreId).toBe('B');
    expect(useStore.getState().reorderError).toBeNull();
  });

  it('AC-2 — late failure: no error written, payload/owner unchanged, no toast', async () => {
    const { dA, pA } = startA();
    switchToB();

    dA.reject(new Error('boom'));
    await pA;

    expect(useStore.getState().reorderError).toBeNull();
    expect(useStore.getState().reorderPayload).toBe(PB);
    expect(useStore.getState().reorderStoreId).toBe('B');
    expect(Toast.show).not.toHaveBeenCalled();
    // Diagnostic warn only — not a result key.
    expect(console.warn).toHaveBeenCalledWith('[Supabase] loadReorderSuggestions:', 'boom');
  });

  it.each([
    ['resolves', (d: Deferred<ReorderPayload>) => d.resolve(FA)],
    ['rejects', (d: Deferred<ReorderPayload>) => d.reject(new Error('x'))],
  ])('AC-3 — no newer request (switched to "All brands"), the fetch %s: loading resets, nothing else moves', async (_label, settle) => {
    const { dA, pA } = startA();
    useStore.setState({ currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' } });
    const before = reorderFields();

    settle(dA);
    await pA;

    const after = reorderFields();
    expect(after.reorderLoading).toBe(false);
    expect(after.reorderPayload).toBe(before.reorderPayload);
    expect(after.reorderStoreId).toBe(before.reorderStoreId);
    expect(after.reorderError).toBe(before.reorderError);
  });

  it('AC-4 — a newer foreground request is in flight: its spinner is left alone, then it lands', async () => {
    const { dA, pA } = startA();
    switchToB();
    const dB = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(dB.promise);
    const pB = useStore.getState().loadReorderSuggestions('D');
    expect(fetchReorder).toHaveBeenNthCalledWith(2, 'B', 'D');
    expect(useStore.getState().reorderLoading).toBe(true);
    const before = reorderFields();

    dA.resolve(FA);
    await pA;
    expect(reorderFields()).toEqual(before);
    expect(useStore.getState().reorderLoading).toBe(true);
    expect(useStore.getState().reorderPayload).toBe(PB);

    dB.resolve(FB);
    await pB;
    expect(useStore.getState().reorderPayload).toBe(FB);
    expect(useStore.getState().reorderStoreId).toBe('B');
    expect(useStore.getState().reorderLoading).toBe(false);
  });

  it('AC-5 — not dropped on generation alone: a silent refresh issued meanwhile does not block the foreground result', async () => {
    const P = payload('D', 'p');
    useStore.setState({
      currentStore: store('S'), reorderPayload: P, reorderStoreId: 'S', reorderLoading: false, reorderError: null,
    } as any);
    const dF = deferred<ReorderPayload>(); // foreground
    const dS = deferred<ReorderPayload>(); // silent
    fetchReorder.mockReturnValueOnce(dF.promise).mockReturnValueOnce(dS.promise);

    const fg = useStore.getState().loadReorderSuggestions('D');
    await useStore.getState().loadFromSupabase('S');
    expect(fetchAll).toHaveBeenCalledWith('S');
    // The silent refresh really went out, so `reorderRequestGen` moved.
    expect(fetchReorder).toHaveBeenNthCalledWith(2, 'S', 'D');

    dF.resolve(F);
    await fg;
    expect(useStore.getState().reorderPayload).toBe(F);
    expect(useStore.getState().reorderStoreId).toBe('S');
    expect(useStore.getState().reorderLoading).toBe(false);
    expect(useStore.getState().reorderError).toBeNull();

    // Settle the silent one too (it is the newest request, so it lands).
    dS.resolve(FS);
    await flush();
  });

  it('AC-6 — current-store control: success and failure land exactly as before', async () => {
    useStore.setState({ currentStore: store('S'), reorderError: 'old' });
    fetchReorder.mockResolvedValueOnce(F);
    await useStore.getState().loadReorderSuggestions('D');
    expect(fetchReorder).toHaveBeenCalledWith('S', 'D');
    expect(reorderFields()).toEqual({
      reorderPayload: F, reorderLoading: false, reorderError: null, reorderStoreId: 'S',
    });
    expect(useStore.getState().reorderPayload).toBe(F);

    fetchReorder.mockRejectedValueOnce(new Error('rpc down'));
    await useStore.getState().loadReorderSuggestions('D');
    expect(reorderFields()).toEqual({
      reorderPayload: F, reorderLoading: false, reorderError: 'rpc down', reorderStoreId: 'S',
    });
  });
});

// ── R-2 — recordExportedOrder backstop ──────────────────────────────────────

describe('R-2 — recordExportedOrder refuses a list owned by another store', () => {
  function makeVendor(): ReorderVendor {
    return {
      vendorId: 'v1',
      vendorName: 'US FOODS',
      daysUntil: 0,
      scheduleKnown: true,
      nextDeliveryDate: '2026-08-09',
      items: [
        { itemId: 'item-1', itemName: 'Wings', suggestedUnits: 3, suggestedQty: 3, costPerUnit: 2 } as any,
      ],
    } as unknown as ReorderVendor;
  }

  function seedExport(owner: string | null) {
    useStore.setState({
      currentStore: store('B'),
      currentUser: { id: 'user-1' } as any,
      stores: [store('B')],
      inventory: [{ id: 'item-1', catalogId: 'cat-1', subUnitSize: 4, storeId: 'B' }] as any,
      reorderPayload: payload('2026-08-08', 'x'),
      reorderStoreId: owner,
      reorderEdits: { v1: { 'item-1': 5 } },
    } as any);
  }

  const CTX_B = { storeId: 'B', referenceDate: '2026-08-08' };

  it('AC-7 — owner A, snapshot B: null, no write, one distinct toast', async () => {
    seedExport('A');

    const res = await useStore.getState().recordExportedOrder(makeVendor(), CTX_B);
    await flush();

    expect(res).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    const arg = toastShow.mock.calls[0][0];
    expect(arg.type).toBe('error');
    expect(arg.text1).toBe('Record exported order failed');
    expect(arg.text2.startsWith('Reorder list belongs to a different store')).toBe(true);
    expect(arg.text2).not.toBe('Active store changed during the export — not recorded');
  });

  it('AC-7 / P2 — a null owner with a valid date refuses too', async () => {
    seedExport(null);

    expect(await useStore.getState().recordExportedOrder(makeVendor(), CTX_B)).toBeNull();
    await flush();

    expect(upsertMock).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow.mock.calls[0][0].text2.startsWith('Reorder list belongs to a different store')).toBe(true);
  });

  it('AC-8 — owner equals the snapshot store: recorded exactly as before', async () => {
    seedExport('B');

    const res = await useStore.getState().recordExportedOrder(makeVendor(), CTX_B);
    await flush();

    expect(res).toBe('po-1');
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'B', vendorId: 'v1', referenceDate: '2026-08-08' }));
    expect(toastShow).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['__all__', '__all__'],
  ])('AC-9 — a %s snapshot store still returns null SILENTLY, before the backstop', async (_label, sid) => {
    seedExport('A'); // the backstop WOULD fire if it ran first

    expect(await useStore.getState().recordExportedOrder(makeVendor(), { storeId: sid, referenceDate: '2026-08-08' })).toBeNull();
    await flush();

    expect(upsertMock).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('AC-9 — a mid-export store switch still gets the existing refusal (it runs first)', async () => {
    seedExport('C'); // owner differs too — only ONE guard may report

    const res = await useStore.getState().recordExportedOrder(makeVendor(), { storeId: 'A', referenceDate: '2026-08-08' });
    await flush();

    expect(res).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow.mock.calls[0][0].text2).toBe('Active store changed during the export — not recorded');
  });

  it('§4 — an undated snapshot stays silent even with a mismatched owner', async () => {
    seedExport(null);

    expect(await useStore.getState().recordExportedOrder(makeVendor(), { storeId: 'B', referenceDate: undefined })).toBeNull();
    await flush();

    expect(upsertMock).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });
});

// ── R-3 — loadFromSupabase drops a stale load ───────────────────────────────

describe('R-3 — a stale loadFromSupabase writes nothing and runs no tails', () => {
  /** AC-10 / AC-11 setup: A's load held inside `fetchAllForStore`, then a switch to B. */
  async function startStaleA() {
    useStore.setState({ currentStore: store('A'), currentUser: { id: 'user-1' } as any });
    const dAll = deferred<unknown>();
    fetchAll.mockReturnValueOnce(dAll.promise);
    const pA = useStore.getState().loadFromSupabase('A');
    await flush();
    expect(fetchAll).toHaveBeenCalledWith('A');
    seedStoreB();
    return { dAll, pA, before: snapshot() };
  }

  function expectNoTails() {
    expect(db.fetchMenuCapacity).not.toHaveBeenCalled();
    expect(db.fetchItemsLastCounted).not.toHaveBeenCalled();
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(db.fetchNotifications).not.toHaveBeenCalled();
  }

  it('AC-10 — a stale single-store load leaves every B slice by reference and starts no tail', async () => {
    const { dAll, pA, before } = await startStaleA();

    dAll.resolve(shape('A'));
    await pA;
    await flush();

    expectUnchanged(before);
    expect(useStore.getState().reorderPayload).toBe(PB);
    expectNoTails();
  });

  it('AC-11 — a stale load whose fetch fails only warns: no writes, no tails, no toast', async () => {
    const { dAll, pA, before } = await startStaleA();

    dAll.reject(new Error('network'));
    await pA;
    await flush();

    expectUnchanged(before);
    expectNoTails();
    expect(console.warn).toHaveBeenCalledWith('[Supabase] loadFromSupabase failed:', 'network');
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('AC-12 — a stale __all__ load fetches every store but writes nothing', async () => {
    seedStoreB();
    useStore.setState({ stores: [store('S1'), store('S2')] });
    const before = snapshot([
      'brand', 'inventory', 'vendors', 'menuCapacity',
      'lastCountedByItem', 'lastCountedStoreId', 'lastCountedLoaded',
    ]);

    await useStore.getState().loadFromSupabase('__all__');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('S1');
    expect(fetchAll).toHaveBeenCalledWith('S2');
    expectUnchanged(before);
  });

  it('AC-13 — a stale load still writes `stores` from a non-empty fetchStores result', async () => {
    seedStoreB();
    const before = snapshot();
    const cloud = [store('A'), store('B')];
    fetchStores.mockResolvedValueOnce(cloud);

    await useStore.getState().loadFromSupabase('A');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('A');
    expect(useStore.getState().stores).toBe(cloud);
    expectUnchanged(before);
  });

  it('AC-13 — a current-store load still writes its slices and runs every tail once', async () => {
    useStore.setState({ currentStore: store('B'), currentUser: { id: 'user-1' } as any });
    fetchAll.mockResolvedValueOnce(shape('B'));

    await useStore.getState().loadFromSupabase('B');
    await flush();

    expect(fetchAll).toHaveBeenCalledWith('B');
    const s = useStore.getState();
    expect(s.inventory).toEqual(shape('B').inventory);
    expect(s.vendors).toEqual(shape('B').vendors);
    expect(s.brand).toEqual(shape('B').brand);
    expect(s.orderSchedule.Monday).toEqual(['v-B']);
    expect(db.fetchMenuCapacity).toHaveBeenCalledTimes(1);
    expect(db.fetchMenuCapacity).toHaveBeenCalledWith('B');
    expect(db.fetchItemsLastCounted).toHaveBeenCalledTimes(1);
    expect(db.fetchItemsLastCounted).toHaveBeenCalledWith('B');
    expect(db.fetchNotifications).toHaveBeenCalledWith('user-1', 50);
  });

  it('AC-13 — a current-store __all__ load still writes its slices', async () => {
    useStore.setState({
      currentStore: store('__all__'),
      stores: [store('S1'), store('S2')],
      menuCapacity: { r: { recipeId: 'r' } },
      lastCountedByItem: { 'i-x': '2026-10-01T00:00:00Z' },
      lastCountedStoreId: 'S1',
      lastCountedLoaded: true,
    } as any);
    fetchAll.mockImplementation((id: string) => Promise.resolve(shape(id)));

    await useStore.getState().loadFromSupabase('__all__');
    await flush();

    const s = useStore.getState();
    expect(s.brand).toEqual(shape('S1').brand);
    expect(s.inventory).toEqual([...shape('S1').inventory, ...shape('S2').inventory]);
    expect(s.menuCapacity).toEqual({});
    expect(s.lastCountedByItem).toEqual({});
    expect(s.lastCountedStoreId).toBeNull();
    expect(s.lastCountedLoaded).toBe(false);
  });
});

// ── R-4 — only the newest load resets the spec-111 overlay ──────────────────

describe('R-4 — the spec-111 overlay resets on the newest load only', () => {
  it.each([
    ['success', (d: Deferred<unknown>) => d.resolve(shape('A'))],
    ['failure', (d: Deferred<unknown>) => d.reject(new Error('x'))],
  ])('AC-14 — a stale load that is still the newest resets the gates (%s)', async (_label, settle) => {
    useStore.setState({ currentStore: store('A'), storeLoading: true, switching: 'store' });
    const dAll = deferred<unknown>();
    fetchAll.mockReturnValueOnce(dAll.promise);
    const pA = useStore.getState().loadFromSupabase('A');
    await flush();
    expect(fetchAll).toHaveBeenCalledWith('A');

    useStore.setState({ currentStore: store('B') });
    settle(dAll);
    await pA;

    expect(useStore.getState().storeLoading).toBe(false);
    expect(useStore.getState().switching).toBeNull();
  });

  it('AC-15 — a stale load skips the reset while a newer load is in flight', async () => {
    useStore.setState({ currentStore: store('A'), switching: 'store' });
    const dA = deferred<unknown>();
    const dB = deferred<unknown>();
    fetchAll.mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise);

    const pA = useStore.getState().loadFromSupabase('A');
    await flush();
    expect(fetchAll).toHaveBeenNthCalledWith(1, 'A');

    useStore.setState({ currentStore: store('B') });
    const pB = useStore.getState().loadFromSupabase('B');
    await flush();
    // B is past its probe and holds the counter — the ordering proof.
    expect(fetchAll).toHaveBeenNthCalledWith(2, 'B');

    dA.resolve(shape('A'));
    await pA;
    expect(useStore.getState().storeLoading).toBe(true);
    expect(useStore.getState().switching).toBe('store');

    dB.resolve(shape('B'));
    await pB;
    expect(useStore.getState().storeLoading).toBe(false);
    expect(useStore.getState().switching).toBeNull();
    expect(useStore.getState().inventory).toEqual(shape('B').inventory);
    expect(useStore.getState().vendors).toEqual(shape('B').vendors);
  });
});

// ── Architect-added cases (§7.2) ────────────────────────────────────────────

describe('D-T1 — out-of-order session probes never strand the overlay (bump after the probe)', () => {
  it('an older load whose probe resolves last is dropped and still clears the gates', async () => {
    const probe1 = deferred<boolean>();
    const probe2 = deferred<boolean>();
    hasActiveSessionMock.mockReturnValueOnce(probe1.promise).mockReturnValueOnce(probe2.promise);
    const dA = deferred<unknown>();
    const dB = deferred<unknown>();
    fetchAll.mockImplementation((id: string) => (id === 'A' ? dA.promise : dB.promise));

    useStore.setState({ currentStore: store('A'), switching: 'store' });
    const l1 = useStore.getState().loadFromSupabase('A');
    await flush();
    useStore.setState({ currentStore: store('B') });
    const l2 = useStore.getState().loadFromSupabase('B');
    await flush();
    expect(fetchAll).not.toHaveBeenCalled(); // both still inside their probes

    // L2's probe and fetch finish first.
    probe2.resolve(true);
    await flush();
    expect(fetchAll).toHaveBeenCalledWith('B');
    dB.resolve(shape('B'));
    await l2;
    expect(useStore.getState().storeLoading).toBe(false);
    expect(useStore.getState().switching).toBeNull();

    // L1's probe resolves last: it writes `storeLoading: true`, then is dropped.
    probe1.resolve(true);
    await flush();
    expect(fetchAll).toHaveBeenCalledWith('A');
    dA.resolve(shape('A'));
    await l1;

    expect(useStore.getState().storeLoading).toBe(false);
    expect(useStore.getState().switching).toBeNull();
    // B's slices from L2 are intact.
    expect(useStore.getState().inventory).toEqual(shape('B').inventory);
    expect(useStore.getState().vendors).toEqual(shape('B').vendors);
    expect(useStore.getState().brand).toEqual(shape('B').brand);
  });
});

describe('D-T2 — newer SILENT-only requests never strand reorderLoading (D-2 foreground marker)', () => {
  it('a dropped foreground result resets loading even though a silent refresh bumped the generation', async () => {
    useStore.setState({
      currentStore: store('A'), reorderPayload: PB, reorderStoreId: 'B', reorderLoading: false, reorderError: null,
    } as any);
    const dF = deferred<ReorderPayload>(); // foreground, for A
    const dS = deferred<ReorderPayload>(); // silent, for B
    fetchReorder.mockReturnValueOnce(dF.promise).mockReturnValueOnce(dS.promise);

    const fg = useStore.getState().loadReorderSuggestions('D');
    expect(fetchReorder).toHaveBeenNthCalledWith(1, 'A', 'D');
    expect(useStore.getState().reorderLoading).toBe(true);

    useStore.setState({ currentStore: store('B') });
    await useStore.getState().loadFromSupabase('B');
    expect(fetchAll).toHaveBeenCalledWith('B');
    // A′ kept PB (owned by the current store) and issued the silent refresh,
    // so `reorderRequestGen` really moved past the foreground's value.
    expect(fetchReorder).toHaveBeenNthCalledWith(2, 'B', 'D');

    dF.resolve(FA);
    await fg;
    expect(useStore.getState().reorderLoading).toBe(false);
    expect(useStore.getState().reorderPayload).toBe(PB);
    expect(useStore.getState().reorderStoreId).toBe('B');
    expect(useStore.getState().reorderError).toBeNull();

    // The silent refresh is no longer suppressed by a stranded flag.
    dS.resolve(FS);
    await flush();
    expect(useStore.getState().reorderPayload).toBe(FS);
    expect(useStore.getState().reorderStoreId).toBe('B');
  });
});
