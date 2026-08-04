// src/store/useStore.lastOrderContext.spec151.test.ts — spec 151 §5.4 (R-G).
//
// Pins the store slice that carries the last-order context:
//   • the TRI-STATE (R-G): `null` = NOT LOADED, `{}` = loaded-with-no-anchors,
//     populated = anchors. The distinction is what keeps AC-9's
//     "NO PRIOR ORDER ON RECORD" from being asserted during the load window.
//   • AC-17: a failing read is SILENT — console.warn only, no Toast, no error
//     slice, no loading flag — and leaves `reorderPayload` untouched so the
//     order list keeps rendering.
//   • the store-switch reset, which is a correctness requirement (the context
//     is keyed by vendorId ONLY, so stale cross-store context would annotate
//     the new store's lines with the old store's quantities).

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
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

jest.mock('../lib/webPush', () => ({
  unsubscribeFromPush: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null, catalogIngredients: [], inventory: [], recipes: [], prepRecipes: [],
    vendors: [], wasteLog: [], auditLog: [], eodSubmissions: [], posRecipeAliases: [],
    recipeCategories: [], ingredientCategories: [], ingredientConversions: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 151 — the assertion surface.
  fetchLastOrderContext: jest.fn(),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';
import type { LastOrderContext } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchMock = db.fetchLastOrderContext as jest.Mock;

const context: LastOrderContext = {
  'v-1': {
    vendorId: 'v-1',
    lastOrderDate: '2026-07-29',
    confidence: 'placed',
    source: 'purchase_order',
    sourceId: 'po-1',
    countedDate: '2026-07-29',
    itemsTruncated: false,
    items: { 'i-1': { itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: 30 } },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ currentStore: { id: 'store-1', name: 'Frederick' } as any });
  fetchMock.mockResolvedValue(context);
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('lastOrderContext slice — R-G tri-state', () => {
  it('starts NULL (not {}), so nothing is claimed before the first load', () => {
    expect(INITIAL_STATE.lastOrderContext).toBeNull();
  });

  it('loads the keyed context for the visible vendors in ONE call (AC-23)', async () => {
    await useStore.getState().loadLastOrderContext(['v-1', 'v-2'], '2026-08-03');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('store-1', ['v-1', 'v-2'], '2026-08-03');
    expect(useStore.getState().lastOrderContext).toEqual(context);
  });

  it('an EMPTY vendor list is loaded-and-empty ({}), not unloaded, and skips the RPC', async () => {
    await useStore.getState().loadLastOrderContext([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useStore.getState().lastOrderContext).toEqual({});
  });

  it('never fires for the "all stores" placeholder', async () => {
    useStore.setState({ currentStore: { id: '__all__', name: 'All' } as any });
    await useStore.getState().loadLastOrderContext(['v-1']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useStore.getState().lastOrderContext).toEqual({});
  });
});

describe('AC-17 — a failed context read never breaks the order list', () => {
  it('degrades to NULL silently: console.warn only, no toast, no error slice', async () => {
    const payload = { asOfDate: '2026-08-03', vendors: [], kpis: {} as any, warnings: [] } as any;
    useStore.setState({ lastOrderContext: context, reorderPayload: payload, reorderError: null });
    fetchMock.mockRejectedValue(new Error('rpc exploded'));

    await useStore.getState().loadLastOrderContext(['v-1']);

    // NOT `{}` — an empty map would make every card claim NO PRIOR ORDER ON
    // RECORD, which is a lie when the read simply failed.
    expect(useStore.getState().lastOrderContext).toBeNull();
    expect(Toast.show).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    // The load-bearing payload is untouched — the order list still renders.
    expect(useStore.getState().reorderPayload).toBe(payload);
    expect(useStore.getState().reorderError).toBeNull();
  });

  it('does not resolve as a rejected promise (the caller may `void` it)', async () => {
    fetchMock.mockRejectedValue(new Error('nope'));
    await expect(useStore.getState().loadLastOrderContext(['v-1'])).resolves.toBeUndefined();
  });
});

describe('store switch', () => {
  it('clears the context to NULL so no cross-store quantities leak', async () => {
    useStore.setState({ lastOrderContext: context });
    // loadFromSupabase's set block is what runs on a store switch.
    await useStore.getState().loadFromSupabase('store-2');
    expect(useStore.getState().lastOrderContext).toBeNull();
  });
});

describe('logout (security-auditor Low)', () => {
  it('clears the context to NULL so the next user on a shared machine sees none of it', () => {
    useStore.setState({ lastOrderContext: context });
    useStore.getState().logout();
    // NOT `{}` — the next session has loaded nothing yet, so nothing may be
    // claimed either way until its own fetch resolves (R-G).
    expect(useStore.getState().lastOrderContext).toBeNull();
  });
});
