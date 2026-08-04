// src/store/useStore.activeBrand.test.ts — Spec 150 (active-brand validation).
//
// Regression suite for the "phone store switcher shows no stores" bug. Root
// cause: `currentBrandId` is persisted PER DEVICE and re-applied on every cold
// start, so a brand with no role-visible active store left the session in a
// store-less context — every store-scoped surface (the store switcher
// included) rendered empty, and the state survived reloads. Desktop looked
// fine only because its cached value differed.
//
// What is pinned here:
//   (a) restoring a cached brand with NO visible store falls back to "All
//       brands" AND lands on a real store (the stuck-device rescue),
//   (b) restoring a VALID cached brand keeps it and lands INSIDE that brand,
//   (c) picking a store-less brand live falls back instead of stranding,
//   (d) role-based visibility is unchanged — privileged roles still see every
//       store (no narrowing), non-privileged still see only their grants (no
//       broadening),
//   (e) the load-order guard: an UNKNOWN store set (cold boot, pre-fetchStores)
//       never clears a valid cached brand.
//
// Mocking mirrors useStore.switching.test.ts: stub ../lib/supabase (module-eval
// crash guard), ../lib/auth (dynamic-import boundary), ../lib/db (namespace
// import). AsyncStorage is the official in-memory mock from tests/jest.setup.ts,
// so the persisted-key assertions are real reads.

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
  fetchMenuCapacity: jest.fn().mockResolvedValue([]),
  fetchNotifications: jest.fn().mockResolvedValue([]),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as db from '../lib/db';
import { useStore, ACTIVE_BRAND_KEY } from './useStore';
import type { Store, User } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchStoresMock = db.fetchStores as jest.Mock;

/** Flush microtasks so the login → fetchStores → loadFromSupabase chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const storeA: Store = { id: 'store-a', brandId: 'brand-1', name: 'Towson', address: '', status: 'active' };
const storeB: Store = { id: 'store-b', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' };
const storeC: Store = { id: 'store-c', brandId: 'brand-2', name: 'Harbor', address: '', status: 'active' };

/** `brand-empty` exists in brandsList but owns no active store — the shape
 *  that produced the reported "No stores available" screen. */
const EMPTY_BRAND = 'brand-empty';

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    name: 'Owner',
    email: 'owner@example.test',
    role: 'super_admin',
    stores: [],
    status: 'active',
    initials: 'OW',
    color: '#378ADD',
    ...over,
  } as User;
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Replace, not merge — second positional `true` is Zustand's replace flag.
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({
    currentUser: null,
    currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
    currentBrandId: null,
    stores: [],
    switching: null,
  });
  await AsyncStorage.clear();
  fetchStoresMock.mockResolvedValue([storeA, storeB, storeC]);
});

// ── (a) + (e) — the session-restore path ─────────────────────────────
describe('active-brand restore (Spec 150 D)', () => {
  /** Reproduces App.tsx's restore ordering: login() kicks off fetchStores,
   *  then the cached brand is re-applied SYNCHRONOUSLY, before the fetch
   *  resolves. */
  const restoreWith = (cachedBrand: string, user = makeUser()) => {
    useStore.getState().login(user);
    useStore.getState().setCurrentBrandId(cachedBrand);
  };

  it('(e) does NOT clear a cached brand while the store set is still unknown', () => {
    restoreWith(EMPTY_BRAND);
    // Pre-fetch window: `stores` is empty, so the brand cannot be validated
    // and must be left alone (clearing here would break every cold start).
    expect(useStore.getState().stores).toHaveLength(0);
    expect(useStore.getState().currentBrandId).toBe(EMPTY_BRAND);
  });

  it('(a) rescues a device stuck on a brand with no visible stores', async () => {
    restoreWith(EMPTY_BRAND);
    // The pre-fix stuck state: brand applied, currentStore is the placeholder.
    expect(useStore.getState().currentStore.id).toBe('');

    await flush();

    // Validated once the store set is known → back to "All brands"…
    expect(useStore.getState().currentBrandId).toBeNull();
    // …persisted as the empty sentinel, so the NEXT cold start doesn't
    // restore the dead brand (App.tsx's reader maps '' → null)…
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_BRAND_KEY, '');
    // …and landed on a real store instead of the `{id:''}` placeholder.
    expect(useStore.getState().currentStore.id).toBe('store-a');
  });

  it('(b) keeps a VALID cached brand and lands on a store inside it', async () => {
    restoreWith('brand-2');

    await flush();

    expect(useStore.getState().currentBrandId).toBe('brand-2');
    // Not `allStores[0]` (store-a, brand-1) — the landing store belongs to
    // the brand that is actually in effect.
    expect(useStore.getState().currentStore.id).toBe('store-c');
  });

  it('(b2) a plain login with no cached brand is unchanged', async () => {
    useStore.getState().login(makeUser());

    await flush();

    expect(useStore.getState().currentBrandId).toBeNull();
    expect(useStore.getState().currentStore.id).toBe('store-a');
  });
});

// ── (c) — the live pick ──────────────────────────────────────────────
describe('setCurrentBrandId — store-less brand (Spec 150 D)', () => {
  const seedSignedIn = (over: Partial<User> = {}) => {
    useStore.setState({
      currentUser: makeUser(over),
      stores: [storeA, storeB, storeC],
      currentStore: storeA,
      currentBrandId: null,
      switching: null,
    });
  };

  it('(c) falls back to "All brands" instead of stranding the session', () => {
    seedSignedIn();

    // Spec 150 follow-up — the setter REPORTS the brand actually in effect so
    // callers can tell a real switch from a diverted one (the phone sheet's
    // toast reads this instead of re-deriving the guard).
    expect(useStore.getState().setCurrentBrandId(EMPTY_BRAND)).toBeNull();

    expect(useStore.getState().currentBrandId).toBeNull();
    // The store the user was already in is still visible under "All brands",
    // so it is kept — no needless switch, no placeholder, no reload.
    expect(useStore.getState().currentStore.id).toBe('store-a');
    expect(useStore.getState().switching).toBeNull();
  });

  it('(c2) lands on the first visible store when the current one is gone', async () => {
    seedSignedIn();
    // Current store is not in the (now known) store set — e.g. it was the
    // placeholder left by an earlier stranded session.
    useStore.setState({ currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' } });

    useStore.getState().setCurrentBrandId(EMPTY_BRAND);

    expect(useStore.getState().currentBrandId).toBeNull();
    expect(useStore.getState().currentStore.id).toBe('store-a');
    await flush();
  });

  it('a brand that DOES have stores still switches normally', async () => {
    seedSignedIn();

    // Undiverted pick → the setter echoes the requested brand back.
    expect(useStore.getState().setCurrentBrandId('brand-2')).toBe('brand-2');

    expect(useStore.getState().currentBrandId).toBe('brand-2');
    expect(useStore.getState().currentStore.id).toBe('store-c');
    // Spec 111 — the brand-copy takeover still paints for a real brand switch.
    expect(useStore.getState().switching).toBe('brand');
    await flush();
  });

  it('an explicit "All brands" pick keeps its existing clear-the-store semantics', () => {
    seedSignedIn();
    useStore.setState({ currentBrandId: 'brand-1' });

    useStore.getState().setCurrentBrandId(null);

    expect(useStore.getState().currentBrandId).toBeNull();
    // Unchanged pre-spec-150 behavior: the consumer forces section "Brands".
    expect(useStore.getState().currentStore.id).toBe('');
  });
});

// ── (d) — role visibility is unchanged ───────────────────────────────
describe('role visibility (Spec 150 — no broadening, no narrowing)', () => {
  it('(d) a regular admin with NO user_stores rows still sees every store', () => {
    useStore.setState({
      currentUser: makeUser({ role: 'admin', stores: [] }),
      stores: [storeA, storeB, storeC],
      currentStore: storeA,
      currentBrandId: null,
    });

    // brand-2 is visible to an admin by role, so this is NOT a stranded pick.
    useStore.getState().setCurrentBrandId('brand-2');

    expect(useStore.getState().currentBrandId).toBe('brand-2');
    expect(useStore.getState().currentStore.id).toBe('store-c');
  });

  it('(d) a non-privileged user is still limited to their granted stores', async () => {
    useStore.setState({
      currentUser: makeUser({ role: 'user', stores: ['store-c'] }),
      stores: [storeA, storeB, storeC],
      currentStore: storeC,
      currentBrandId: null,
    });

    // brand-1 has stores, but NONE of them are granted to this user, so it is
    // store-less *for them* → fall back rather than land on someone else's store.
    useStore.getState().setCurrentBrandId('brand-1');

    expect(useStore.getState().currentBrandId).toBeNull();
    expect(useStore.getState().currentStore.id).toBe('store-c');
    await flush();
  });

  it('(d) login lands a non-privileged user on a granted store', async () => {
    useStore.getState().login(makeUser({ role: 'user', stores: ['store-b'] }));

    await flush();

    expect(useStore.getState().currentStore.id).toBe('store-b');
  });
});

// ── reconcileActiveBrand — direct unit coverage ──────────────────────
describe('reconcileActiveBrand', () => {
  it('is a no-op for a valid brand', () => {
    useStore.setState({
      currentUser: makeUser(),
      stores: [storeA, storeC],
      currentBrandId: 'brand-2',
    });

    expect(useStore.getState().reconcileActiveBrand()).toBe('brand-2');
    expect(useStore.getState().currentBrandId).toBe('brand-2');
  });

  it('clears + re-persists for a brand with no visible store', () => {
    useStore.setState({
      currentUser: makeUser(),
      stores: [storeA, storeC],
      currentBrandId: EMPTY_BRAND,
    });

    expect(useStore.getState().reconcileActiveBrand()).toBeNull();
    expect(useStore.getState().currentBrandId).toBeNull();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_BRAND_KEY, '');
  });

  it('is a no-op when the store set or the user is unknown', () => {
    useStore.setState({ currentUser: makeUser(), stores: [], currentBrandId: EMPTY_BRAND });
    expect(useStore.getState().reconcileActiveBrand()).toBe(EMPTY_BRAND);

    useStore.setState({ currentUser: null, stores: [storeA], currentBrandId: EMPTY_BRAND });
    expect(useStore.getState().reconcileActiveBrand()).toBe(EMPTY_BRAND);
    expect(useStore.getState().currentBrandId).toBe(EMPTY_BRAND);
  });

  it('validates against an explicitly passed store set', () => {
    useStore.setState({ currentUser: makeUser(), stores: [], currentBrandId: EMPTY_BRAND });

    // The login tail passes the freshly fetched list before the slice is read.
    expect(useStore.getState().reconcileActiveBrand([storeA, storeC])).toBeNull();
  });
});
