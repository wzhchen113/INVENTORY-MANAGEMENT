// src/store/useStore.storeGate.spec161.test.ts — Spec 161 (sign-in store gate).
//
// Before 161, `login()` silently landed every user on a store —
// `visible.find(granted) || visible[0]` — so an admin who can see four stores
// got one of them with no say in it. The gate asks instead.
//
// What is pinned here:
//   (a) MORE than one visible store → `storeGate: 'choosing'`, and
//       `currentStore` stays on its `{ id: '' }` placeholder (AdminStack holds
//       the shell back on any non-'ready' gate, and every Cmd section
//       dereferences `currentStore.` unconditionally),
//   (a2) `login()` arms `'resolving'` SYNCHRONOUSLY — the regression that
//       shipped mid-build: `currentUser` is set a tick before the store set is
//       known, so a still-'ready' gate let the shell mount on the placeholder,
//   (b) exactly one visible store → auto-land, no gate — for BOTH a
//       privileged single-store user and a non-privileged grant holder. This
//       is the branch that keeps today's staff/single-store logins unchanged,
//       and it mirrors the staff gate's `stores.length === 1` case,
//   (c) the session pick short-circuits the gate on a refresh,
//   (d) …but only for the SAME user, and only while the store is still
//       visible — the two ways a stale pick could otherwise leak,
//   (e) `setCurrentStore` is the only exit, and it clears the flag,
//   (f) `logout()` drops the pick so the next sign-in on the tab re-asks.
//
// Mocking mirrors useStore.activeBrand.test.ts.

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
import { useStore, _resetSessionStoreLocal } from './useStore';
import type { Store, User } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchStoresMock = db.fetchStores as jest.Mock;

const flush = () => new Promise<void>((r) => setImmediate(r));

const towson: Store = { id: 'store-a', brandId: 'brand-1', name: 'Towson', address: '', status: 'active' };
const charles: Store = { id: 'store-b', brandId: 'brand-1', name: 'Charles', address: '', status: 'active' };
const harbor: Store = { id: 'store-c', brandId: 'brand-2', name: 'Harbor', address: '', status: 'active' };

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
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({
    currentUser: null,
    currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
    storeGate: 'ready',
    currentBrandId: null,
    stores: [],
    switching: null,
  });
  await AsyncStorage.clear();
  _resetSessionStoreLocal();
  fetchStoresMock.mockResolvedValue([towson, charles, harbor]);
});

// ── (a) the gate ─────────────────────────────────────────────────────
describe('multi-store sign-in', () => {
  it('(a) opens the gate and leaves currentStore on the placeholder', async () => {
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('choosing');
    // The placeholder is the whole point: AdminStack must not mount the shell
    // while this is the current store.
    expect(useStore.getState().currentStore.id).toBe('');
  });

  it('(a2) arms the gate SYNCHRONOUSLY, before fetchStores resolves', () => {
    // No `await flush()` — this is the tick AdminStack renders on. A 'ready'
    // gate here would mount the entire Cmd shell on the `{ id: '' }`
    // placeholder for the width of the fetch.
    useStore.getState().login(makeUser());

    expect(useStore.getState().currentUser).not.toBeNull();
    expect(useStore.getState().storeGate).toBe('resolving');
  });

  it('(a2) releases a store-less user instead of spinning forever', async () => {
    // Nothing visible, nothing to ask about, nothing to land on. The gate has
    // to hand off to the shell so it can render its own "no stores" state.
    fetchStoresMock.mockResolvedValue([]);
    useStore.getState().login(makeUser({ role: 'user', stores: [] }));
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
  });

  it('(a2) releases the gate when the store fetch fails outright', async () => {
    fetchStoresMock.mockRejectedValue(new Error('network down'));
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
  });

  it('(a) does not load store data before a store is chosen', async () => {
    useStore.getState().login(makeUser());
    await flush();

    expect(db.fetchAllForStore).not.toHaveBeenCalled();
  });

  it('(a) gates a privileged user with ONE grant but many visible stores', async () => {
    // The real shape of this repo's admin: a single user_stores row, but
    // `isPrivilegedRole` makes every store in the brand visible. Pre-161 the
    // granted store won silently; now it is one option among four.
    useStore.getState().login(makeUser({ role: 'admin', stores: ['store-a'] }));
    await flush();

    expect(useStore.getState().storeGate).toBe('choosing');
    expect(useStore.getState().currentStore.id).toBe('');
  });
});

// ── (b) the auto-land branch ─────────────────────────────────────────
describe('single-store sign-in', () => {
  it('(b) auto-lands a non-privileged user on their only grant', async () => {
    useStore.getState().login(makeUser({ role: 'user', stores: ['store-b'] }));
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
    expect(useStore.getState().currentStore.id).toBe('store-b');
  });

  it('(b) auto-lands a privileged user when only one store exists at all', async () => {
    fetchStoresMock.mockResolvedValue([towson]);
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
    expect(useStore.getState().currentStore.id).toBe('store-a');
  });

  it('(b) auto-lands when the active brand narrows the set to one', async () => {
    useStore.getState().login(makeUser());
    useStore.getState().setCurrentBrandId('brand-2');
    await flush();

    // brand-2 holds only Harbor, so there is nothing to ask about.
    expect(useStore.getState().storeGate).toBe('ready');
    expect(useStore.getState().currentStore.id).toBe('store-c');
  });
});

// ── (c) + (d) the session pick ───────────────────────────────────────
describe('session store memory', () => {
  const signInAndPick = async (storeId: string, user = makeUser()) => {
    useStore.getState().login(user);
    await flush();
    const store = useStore.getState().stores.find((s) => s.id === storeId)!;
    useStore.getState().setCurrentStore(store);
    await flush();
  };

  it('(c) a refresh reuses the pick instead of re-asking', async () => {
    await signInAndPick('store-b');

    // A refresh is a fresh login() against the same tab: same user, no logout.
    useStore.setState({
      currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
      storeGate: 'ready',
    });
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
    expect(useStore.getState().currentStore.id).toBe('store-b');
  });

  it('(d) a DIFFERENT user on the same tab is asked, not handed the pick', async () => {
    await signInAndPick('store-b');

    useStore.setState({
      currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
      storeGate: 'ready',
    });
    useStore.getState().login(makeUser({ id: 'u2', email: 'other@example.test' }));
    await flush();

    expect(useStore.getState().storeGate).toBe('choosing');
    expect(useStore.getState().currentStore.id).toBe('');
  });

  it('(d) a pick that is no longer visible falls through to the gate', async () => {
    await signInAndPick('store-b');

    // store-b disappears (closed, or the grant was revoked) — two stores left,
    // so the gate must open rather than resurrect a store the user can't open.
    fetchStoresMock.mockResolvedValue([towson, harbor]);
    useStore.setState({
      currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
      storeGate: 'ready',
    });
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('choosing');
    expect(useStore.getState().currentStore.id).toBe('');
  });

  it('(f) logout drops the pick so the next sign-in re-asks', async () => {
    await signInAndPick('store-b');

    useStore.getState().logout();
    useStore.getState().login(makeUser());
    await flush();

    expect(useStore.getState().storeGate).toBe('choosing');
    expect(useStore.getState().currentStore.id).toBe('');
  });
});

// ── (e) the exit ─────────────────────────────────────────────────────
describe('leaving the gate', () => {
  it('(e) setCurrentStore clears the flag and loads the store', async () => {
    useStore.getState().login(makeUser());
    await flush();
    expect(useStore.getState().storeGate).toBe('choosing');

    useStore.getState().setCurrentStore(charles);
    await flush();

    expect(useStore.getState().storeGate).toBe('ready');
    expect(useStore.getState().currentStore.id).toBe('store-b');
    expect(db.fetchAllForStore).toHaveBeenCalled();
  });

  it('(e) picking from the gate paints no switching overlay', async () => {
    // Spec 111 escalates to the "Switching stores…" takeover only when the
    // PREVIOUS store id is non-empty. Leaving the gate always comes from the
    // placeholder, so the overlay must stay off — the spec-055 skeletons own
    // first load into an empty cache.
    useStore.getState().login(makeUser());
    await flush();

    useStore.getState().setCurrentStore(charles);

    expect(useStore.getState().switching).toBeNull();
  });
});
