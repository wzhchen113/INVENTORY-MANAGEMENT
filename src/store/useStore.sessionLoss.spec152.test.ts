// src/store/useStore.sessionLoss.spec152.test.ts — Spec 152.
//
// Pins the half of the fix that stops the app from BLANKING itself: an
// RLS-denied read returns `200 []`, not an error, and `loadFromSupabase` is
// documented as "cloud is the source of truth — always replace, even if
// empty". Together those two facts wiped every slice during the 2026-08-03
// incident. The action now probes the session first and bails with a banner.
//
// Mocking follows useStore.switching.test.ts (spec 111): stub ../lib/supabase
// (module-eval crash guard), ../lib/auth (the dynamic-import boundary the
// probe crosses), and ../lib/db (namespace import).

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
  signOut: jest.fn().mockResolvedValue(undefined),
  hasActiveSession: jest.fn().mockResolvedValue(true),
}));

// The intentional-sign-out marker crosses a dynamic import inside `logout()` /
// `login()`; the babel transform rewrites `import('literal')` to a `require`,
// so this factory intercepts it.
jest.mock('../lib/sessionWatch', () => ({
  markIntentionalSignOut: jest.fn(),
  clearIntentionalSignOut: jest.fn(),
}));

jest.mock('../lib/webPush', () => ({
  unsubscribeFromPush: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: { id: 'b1', name: '2AM PROJECT' },
    catalogIngredients: [],
    inventory: [{ id: 'i-new', name: 'Fresh row', storeId: 's1' }],
    recipes: [],
    prepRecipes: [{ id: 'p-new', name: 'Fresh prep' }],
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
}));

import { useStore } from './useStore';
import * as db from '../lib/db';
import * as auth from '../lib/auth';
import * as sessionWatch from '../lib/sessionWatch';
import type { User } from '../types';

const hasActiveSessionMock = auth.hasActiveSession as jest.Mock;
const signOutMock = auth.signOut as jest.Mock;
const fetchAllForStoreMock = db.fetchAllForStore as jest.Mock;
const fetchStoresMock = db.fetchStores as jest.Mock;
const markIntentionalSignOutMock = sessionWatch.markIntentionalSignOut as jest.Mock;
const clearIntentionalSignOutMock = sessionWatch.clearIntentionalSignOut as jest.Mock;

const USER_A = {
  id: 'user-a', name: 'A', nickname: '', email: 'a@local.test', role: 'admin',
  stores: [], status: 'active', initials: 'A', color: '#378ADD',
  notificationsEnabled: true, brandId: 'b1', username: null,
} as User;

// Settle the promise chain loadFromSupabase kicks off (probe → fetch →
// fire-and-forget tails).
// 20 ticks, not 6: `logout()`'s failure path nests four levels of dynamic
// import + promise chaining (sessionWatch → auth → signOut rejection →
// sessionWatch again) before `clearIntentionalSignOut` is reached.
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const STALE_INVENTORY = [{ id: 'i-old', name: 'Already loaded', storeId: 's1' }] as any;
const STALE_PREPS = [{ id: 'p-old', name: 'Already loaded prep' }] as any;

let snapshot: ReturnType<typeof useStore.getState>;

beforeAll(() => {
  snapshot = useStore.getState();
});

beforeEach(() => {
  jest.clearAllMocks();
  hasActiveSessionMock.mockResolvedValue(true);
  useStore.setState({
    ...snapshot,
    currentStore: { id: 's1', brandId: 'b1', name: 'Charles', address: '', status: 'active' },
    inventory: STALE_INVENTORY,
    prepRecipes: STALE_PREPS,
    sessionLost: false,
    storeLoading: false,
    switching: null,
  });
});

describe('loadFromSupabase — no session (AC-5, AC-6)', () => {
  test('keeps every prior slice and fetches NOTHING', async () => {
    hasActiveSessionMock.mockResolvedValue(false);

    await useStore.getState().loadFromSupabase('s1');
    await flush();

    // The whole point: an anon-shaped load must never reach the fetchers,
    // because their empty results are indistinguishable from "no data".
    expect(fetchStoresMock).not.toHaveBeenCalled();
    expect(fetchAllForStoreMock).not.toHaveBeenCalled();
    expect(useStore.getState().inventory).toBe(STALE_INVENTORY);
    expect(useStore.getState().prepRecipes).toBe(STALE_PREPS);
  });

  test('raises the banner flag', async () => {
    hasActiveSessionMock.mockResolvedValue(false);
    await useStore.getState().loadFromSupabase('s1');
    expect(useStore.getState().sessionLost).toBe(true);
  });

  test('clears storeLoading + switching so the spec-111 overlay cannot strand', async () => {
    hasActiveSessionMock.mockResolvedValue(false);
    useStore.setState({ storeLoading: true, switching: 'store' });

    await useStore.getState().loadFromSupabase('s1');

    expect(useStore.getState().storeLoading).toBe(false);
    expect(useStore.getState().switching).toBeNull();
  });
});

describe('loadFromSupabase — live session (AC-7, AC-REG1)', () => {
  test('loads and replaces slices exactly as before this spec', async () => {
    await useStore.getState().loadFromSupabase('s1');
    await flush();

    expect(fetchAllForStoreMock).toHaveBeenCalledWith('s1');
    expect(useStore.getState().inventory).toEqual([
      { id: 'i-new', name: 'Fresh row', storeId: 's1' },
    ]);
    expect(useStore.getState().prepRecipes).toEqual([{ id: 'p-new', name: 'Fresh prep' }]);
  });

  test('a successful load retires a banner raised by an earlier bail', async () => {
    useStore.setState({ sessionLost: true });

    await useStore.getState().loadFromSupabase('s1');
    await flush();

    expect(useStore.getState().sessionLost).toBe(false);
  });
});

describe('loadFromSupabase — the probe fails OPEN (AC-10)', () => {
  test('a rejecting probe still loads', async () => {
    hasActiveSessionMock.mockRejectedValue(new Error('probe exploded'));

    await useStore.getState().loadFromSupabase('s1');
    await flush();

    expect(fetchAllForStoreMock).toHaveBeenCalledWith('s1');
    expect(useStore.getState().sessionLost).toBe(false);
  });

  test('a probe that is not even a function still loads', async () => {
    // Exactly the shape of an older suite whose ../lib/auth factory predates
    // this spec — the fail-open contract is what keeps them green.
    (auth as unknown as Record<string, unknown>).hasActiveSession = undefined;

    await useStore.getState().loadFromSupabase('s1');
    await flush();

    expect(fetchAllForStoreMock).toHaveBeenCalledWith('s1');

    (auth as unknown as Record<string, unknown>).hasActiveSession = hasActiveSessionMock;
  });
});

describe('session teardown actions (Spec 152)', () => {
  test('handleSessionLost clears the user and the banner', () => {
    useStore.setState({
      currentUser: { id: 'u1', role: 'super_admin', stores: [] } as any,
      sessionLost: true,
      currentBrandId: 'b1',
    });

    useStore.getState().handleSessionLost();

    expect(useStore.getState().currentUser).toBeNull();
    expect(useStore.getState().sessionLost).toBe(false);
    expect(useStore.getState().currentBrandId).toBeNull();
  });

  test('dismissSessionLost hides the banner without touching anything else', () => {
    useStore.setState({
      currentUser: { id: 'u1', role: 'super_admin', stores: [] } as any,
      sessionLost: true,
    });

    useStore.getState().dismissSessionLost();

    expect(useStore.getState().sessionLost).toBe(false);
    // Dismiss is presentational — it must NOT sign the user out.
    expect(useStore.getState().currentUser).not.toBeNull();
  });
});

// ── security-auditor M2 ──────────────────────────────────────────────────
// The probe crosses two awaits, so a bail can land AFTER the session it was
// probing for has already been torn down and replaced. Arming the banner then
// would put the red "signed out" dot — and a button that force-ejects — over
// the NEXT user's legitimate session.
describe('loadFromSupabase — the bail is identity-guarded (AC-12)', () => {
  test('a bail whose identity moved mid-probe does NOT arm the banner', async () => {
    useStore.setState({ currentUser: USER_A });
    let release: (v: boolean) => void = () => {};
    hasActiveSessionMock.mockReturnValue(new Promise<boolean>((r) => { release = r; }));

    const pending = useStore.getState().loadFromSupabase('s1');
    // The session ends and the NEXT user signs in while the probe is in flight.
    useStore.setState({ currentUser: { ...USER_A, id: 'user-b' }, storeLoading: true, switching: 'store' });
    release(false);
    await pending;

    expect(useStore.getState().sessionLost).toBe(false);
    // …and the stale bail must not clear the new load's progress gates either.
    expect(useStore.getState().storeLoading).toBe(true);
    expect(useStore.getState().switching).toBe('store');
  });

  test('a bail for the SAME identity still arms the banner', async () => {
    useStore.setState({ currentUser: USER_A });
    hasActiveSessionMock.mockResolvedValue(false);

    await useStore.getState().loadFromSupabase('s1');

    expect(useStore.getState().sessionLost).toBe(true);
  });

  test('a bail while signed out (no identity either side) still arms the banner', async () => {
    useStore.setState({ currentUser: null });
    hasActiveSessionMock.mockResolvedValue(false);

    await useStore.getState().loadFromSupabase('s1');

    expect(useStore.getState().sessionLost).toBe(true);
  });

  test('login() clears a banner armed by the previous session', async () => {
    // login()'s fetchStores REJECTS here, so the self-heal inside
    // loadFromSupabase never runs — this is the stuck-banner case the reviewer
    // called out, and only login()'s own reset can clear it.
    fetchStoresMock.mockRejectedValueOnce(new Error('offline'));
    useStore.setState({ sessionLost: true });

    useStore.getState().login(USER_A);
    await flush();

    expect(useStore.getState().sessionLost).toBe(false);
  });
});

// ── security-auditor Medium (data slices) ────────────────────────────────
describe('signed-out teardown clears the loaded data (AC-13)', () => {
  test('handleSessionLost drops the previous identity\'s rows', () => {
    useStore.setState({
      currentUser: USER_A,
      inventory: STALE_INVENTORY,
      prepRecipes: STALE_PREPS,
      users: [USER_A],
      submissionUnreadCount: 7,
    });

    useStore.getState().handleSessionLost();

    expect(useStore.getState().inventory).toEqual([]);
    expect(useStore.getState().prepRecipes).toEqual([]);
    expect(useStore.getState().users).toEqual([]);
    expect(useStore.getState().submissionUnreadCount).toBe(0);
    expect(useStore.getState().currentStore.id).toBe('');
  });

  test('logout drops them too', () => {
    useStore.setState({
      currentUser: USER_A,
      inventory: STALE_INVENTORY,
      prepRecipes: STALE_PREPS,
      notifications: [{ id: 'n1', message: 'x', timestamp: '', read: false }] as any,
    });

    useStore.getState().logout();

    expect(useStore.getState().inventory).toEqual([]);
    expect(useStore.getState().prepRecipes).toEqual([]);
    expect(useStore.getState().notifications).toEqual([]);
  });
});

// ── test-engineer coverage gap + security-auditor Low ────────────────────
// The mechanism (flag suppresses the toast) was pinned in sessionWatch.test.ts;
// what was NOT pinned is that this call site actually raises the flag BEFORE
// signOut() — the ordering the suppression depends on, since the auth event can
// fire as soon as signOut() resolves.
describe('logout() and the intentional-sign-out marker (AC-4)', () => {
  test('marks the sign-out as intentional BEFORE calling signOut()', async () => {
    useStore.setState({ currentUser: USER_A });

    useStore.getState().logout();
    await flush();

    expect(markIntentionalSignOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(markIntentionalSignOutMock.mock.invocationCallOrder[0])
      .toBeLessThan(signOutMock.mock.invocationCallOrder[0]);
  });

  test('un-arms the marker when signOut() rejects', async () => {
    // auth-js skips the SIGNED_OUT emission on a network failure, so a marker
    // left armed would eat the NEXT genuine loss for this tab's lifetime.
    useStore.setState({ currentUser: USER_A });
    signOutMock.mockRejectedValueOnce(new Error('network down'));

    useStore.getState().logout();
    await flush();

    expect(markIntentionalSignOutMock).toHaveBeenCalledTimes(1);
    expect(clearIntentionalSignOutMock).toHaveBeenCalledTimes(1);
  });

  test('a successful signOut() leaves the marker armed for the event to consume', async () => {
    useStore.setState({ currentUser: USER_A });

    useStore.getState().logout();
    await flush();

    expect(clearIntentionalSignOutMock).not.toHaveBeenCalled();
  });

  test('login() disarms a marker left over from a failed sign-out', async () => {
    useStore.getState().login(USER_A);
    await flush();

    expect(clearIntentionalSignOutMock).toHaveBeenCalledTimes(1);
  });
});
