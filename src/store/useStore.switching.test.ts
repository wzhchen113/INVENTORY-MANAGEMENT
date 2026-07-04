// src/store/useStore.switching.test.ts — Spec 111 (store-switch-loading).
//
// Pins the `switching: 'store' | 'brand' | null` store-lifecycle field that
// drives the full-screen "Switching stores…/brands…" takeover. These are the
// SETTER + RESET transitions (T1–T9 store cases from the spec's Design note);
// the copy-per-mode render assertion (T10) lives in the component suite
// StoreSwitchOverlay.test.tsx.
//
// Mocking follows useStore.updateStore.test.ts (spec 083): stub
// ../lib/supabase (module-eval crash guard), ../lib/auth (dynamic-import
// boundary), and ../lib/db (namespace import). State isolation via
// snapshot-and-replace in beforeEach.
//
// The load tests (T4/T5) drive loadFromSupabase to completion. It calls
// db.fetchStores → db.fetchAllForStore → (fire-and-forget) loadMenuCapacity
// → db.fetchMenuCapacity, plus db.cleanupOldRecords. db.fetchNotifications
// fires ONLY when currentUser.id is set, so these tests keep currentUser
// null to bound the mock surface. `flush()` settles the promise chain.

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
  // Spec 060 — fire-and-forget capacity tail inside loadFromSupabase.
  fetchMenuCapacity: jest.fn().mockResolvedValue([]),
  fetchNotifications: jest.fn().mockResolvedValue([]),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  updateCatalogIngredientI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updatePrepRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeCategoryI18n: jest.fn().mockResolvedValue(undefined),
  updateIngredientCategoryI18n: jest.fn().mockResolvedValue(undefined),
}));

import * as db from '../lib/db';
import { useStore } from './useStore';
import type { Store, Brand } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchAllForStoreMock = db.fetchAllForStore as jest.Mock;

/** Flush microtasks so the loadFromSupabase promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

function makeStore(id: string, over: Partial<Store> = {}): Store {
  return {
    id,
    brandId: over.brandId ?? 'brand-1',
    name: over.name ?? `Store ${id}`,
    address: over.address ?? '',
    status: over.status ?? 'active',
    ...over,
  };
}

const EMPTY_STORE: Store = { id: '', brandId: '', name: '', address: '', status: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  // Replace, not merge — second positional `true` is Zustand's replace flag.
  useStore.setState(INITIAL_STATE, true);
  // Neutral starting point: no user (so fetchNotifications never fires),
  // switching cleared, an empty current store (the boot shape).
  useStore.setState({ currentUser: null, currentStore: EMPTY_STORE, switching: null });
});

// ── T1 — renders on store switch (setter sets 'store') ────────────────
describe('setCurrentStore — switching flag (Spec 111 AC-1)', () => {
  it('T1: sets switching to "store" when the target id changes from a non-empty prev', async () => {
    const storeA = makeStore('store-a');
    const storeB = makeStore('store-b');
    useStore.setState({ currentStore: storeA, switching: null });

    useStore.getState().setCurrentStore(storeB);

    // Set synchronously, BEFORE the async load resolves.
    expect(useStore.getState().switching).toBe('store');
    await flush();
  });

  // ── T2 — absent on boot (empty prev id → no overlay) ────────────────
  it('T2: does NOT set switching when the previous store id is empty (boot/login)', async () => {
    const storeA = makeStore('store-a');
    // currentStore is EMPTY_STORE from beforeEach — the boot shape.

    useStore.getState().setCurrentStore(storeA);

    expect(useStore.getState().switching).toBeNull();
    await flush();
    // And it stays null after the load completes.
    expect(useStore.getState().switching).toBeNull();
  });

  // ── T3 — no overlay on no-op re-select (same id) ────────────────────
  it('T3: does NOT set switching when re-selecting the already-active store', async () => {
    const storeA = makeStore('store-a');
    useStore.setState({ currentStore: storeA, switching: null });

    useStore.getState().setCurrentStore(storeA);

    expect(useStore.getState().switching).toBeNull();
    await flush();
  });

  it('T3b: __all__ redirect resolves a fallback and sets "store" on a real change', async () => {
    const storeA = makeStore('store-a');
    const storeB = makeStore('store-b');
    // Prev = storeA (non-empty). stores list has A + B; the redirect picks
    // the first accessible store (A) — same id as prev → NOT a switch.
    useStore.setState({
      currentStore: storeA,
      switching: null,
      stores: [storeA, storeB],
      currentUser: { id: 'u1', role: 'admin', stores: ['store-a', 'store-b'] } as any,
    });

    // Redirect resolves fallback = storeA (== prev) → no switch.
    useStore.getState().setCurrentStore({ id: '__all__' } as any);
    expect(useStore.getState().switching).toBeNull();
    await flush();

    // Now prev = store-c, fallback resolves to storeA (first in the list) →
    // a REAL change through the __all__ redirect, so switching escalates.
    useStore.setState({ currentStore: makeStore('store-c'), switching: null, stores: [storeA, storeB] });
    useStore.getState().setCurrentStore({ id: '__all__' } as any);
    expect(useStore.getState().switching).toBe('store');
    await flush();
  });
});

// ── T4 / T5 — clears at the single loadFromSupabase completion point ──
describe('loadFromSupabase — clears switching (Spec 111 AC-3/AC-4)', () => {
  it('T4: resets switching to null on the SUCCESS path (same finally as storeLoading)', async () => {
    const storeA = makeStore('store-a');
    const storeB = makeStore('store-b');
    useStore.setState({ currentStore: storeA, switching: null });

    useStore.getState().setCurrentStore(storeB);
    // Set on entry…
    expect(useStore.getState().switching).toBe('store');

    await flush();

    // …cleared on completion, in lockstep with storeLoading.
    expect(useStore.getState().switching).toBeNull();
    expect(useStore.getState().storeLoading).toBe(false);
  });

  it('T5: resets switching to null on the ERROR path (a failed switch must not strand the overlay)', async () => {
    // The finally clears switching regardless of outcome — the key hang guard.
    fetchAllForStoreMock.mockRejectedValueOnce(new Error('rls denied'));
    const storeA = makeStore('store-a');
    const storeB = makeStore('store-b');
    useStore.setState({ currentStore: storeA, switching: null });

    useStore.getState().setCurrentStore(storeB);
    expect(useStore.getState().switching).toBe('store');

    await flush();

    expect(useStore.getState().switching).toBeNull();
    expect(useStore.getState().storeLoading).toBe(false);
  });
});

// ── T6 / T7 — brand copy survives the internal setCurrentStore delegation ─
describe('setCurrentBrandId — brand switch (Spec 111 AC-2/OQ-6)', () => {
  it('T6: sets switching to "brand" and it STAYS "brand" through the setCurrentStore delegation', async () => {
    const brandBStore = makeStore('store-b2', { brandId: 'brand-2' });
    useStore.setState({
      currentStore: makeStore('store-a', { brandId: 'brand-1' }),
      currentBrandId: 'brand-1',
      switching: null,
      stores: [brandBStore],
      brandsList: [{ id: 'brand-2', name: 'Brand Two' } as Brand],
    });

    useStore.getState().setCurrentBrandId('brand-2');

    // Brand value set BEFORE the delegated setCurrentStore, and the
    // escalate-only-from-null guard preserves it (not overwritten to 'store').
    expect(useStore.getState().switching).toBe('brand');
    await flush();
    // Cleared once the delegated load completes.
    expect(useStore.getState().switching).toBeNull();
  });

  // ── T7 — escalation-not-downgrade unit (guard held at the setter) ───
  it('T7: setCurrentStore does NOT downgrade a pre-set "brand" to "store"', async () => {
    const storeA = makeStore('store-a');
    const storeB = makeStore('store-b');
    // Pre-set 'brand' (as setCurrentBrandId would), then run a real store switch.
    useStore.setState({ currentStore: storeA, switching: 'brand' });

    useStore.getState().setCurrentStore(storeB);

    // The `=== null` guard means setCurrentStore leaves 'brand' intact.
    expect(useStore.getState().switching).toBe('brand');
    await flush();
    expect(useStore.getState().switching).toBeNull();
  });
});

// ── T8 — the two no-load brand branches do not strand the overlay ─────
describe('setCurrentBrandId — no-load branches never set switching (Spec 111 AC-5)', () => {
  it('T8a: the "All brands" (null) branch leaves switching null', () => {
    useStore.setState({ currentBrandId: 'brand-1', switching: null });

    useStore.getState().setCurrentBrandId(null);

    // Synchronous branch, no loadFromSupabase → nothing would ever clear a
    // flag, so it must never be set. currentStore was cleared to the empty
    // placeholder (the branch's actual work) but switching stays null.
    expect(useStore.getState().switching).toBeNull();
    expect(useStore.getState().currentStore.id).toBe('');
  });

  it('T8b: a fresh brand with no stores leaves switching null', () => {
    useStore.setState({
      currentBrandId: 'brand-1',
      switching: null,
      stores: [makeStore('store-a', { brandId: 'brand-1' })], // none in brand-3
      brandsList: [{ id: 'brand-3', name: 'Fresh Brand' } as Brand],
    });

    useStore.getState().setCurrentBrandId('brand-3');

    // No store resolved for brand-3 → the no-load placeholder branch runs;
    // it must not set switching (there's no load to clear it).
    expect(useStore.getState().switching).toBeNull();
    expect(useStore.getState().currentStore.id).toBe('');
  });
});
