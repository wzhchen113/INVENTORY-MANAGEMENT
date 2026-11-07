// src/store/useStore.addStore.spec184.test.ts — Spec 184 (AC-40, D-10).
//
// addStore keeps optimistic-then-revert, and now resolves the real id or null and
// never rejects. T-J4 pins the race a bare `map` would lose: a reload that replaces
// `stores` while the insert is in flight drops the temporary row.

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
  createStore: jest.fn(),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';

const INITIAL_STATE = useStore.getState();
const createStoreMock = db.createStore as jest.Mock;
const toastShowMock = (Toast as unknown as { show: jest.Mock }).show;

const EXISTING = { id: 's1', brandId: 'b1', name: 'Store One', address: '1 Main', status: 'active' as const };
const NEW_STORE = { brandId: 'b1', name: 'New Store', address: '2 Main', status: 'active' as const };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ stores: [EXISTING], currentStore: EXISTING });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useStore.addStore — spec 184', () => {
  it('adds a temporary row before the insert resolves', async () => {
    let resolve!: (id: string) => void;
    createStoreMock.mockReturnValue(new Promise((r) => { resolve = r; }));

    const pending = useStore.getState().addStore(NEW_STORE);
    const stores = useStore.getState().stores;
    expect(stores).toHaveLength(2);
    expect(stores[1].name).toBe('New Store');
    expect(stores[1].id).toMatch(/^s\d+$/);

    resolve('real-id');
    await pending;
  });

  it('resolves the real id and swaps it in', async () => {
    createStoreMock.mockResolvedValue('real-id');
    await expect(useStore.getState().addStore(NEW_STORE)).resolves.toBe('real-id');
    const stores = useStore.getState().stores;
    expect(stores.map((s) => s.id)).toEqual(['s1', 'real-id']);
    expect(stores[1].name).toBe('New Store');
  });

  it('never sends the temporary id to the backend', async () => {
    createStoreMock.mockResolvedValue('real-id');
    await useStore.getState().addStore(NEW_STORE);
    expect(createStoreMock).toHaveBeenCalledWith(NEW_STORE);
    expect(createStoreMock.mock.calls[0][0]).not.toHaveProperty('id');
  });

  it('on failure removes the temporary row, notifies, and resolves null', async () => {
    createStoreMock.mockRejectedValue(new Error('insert refused'));
    await expect(useStore.getState().addStore(NEW_STORE)).resolves.toBeNull();
    expect(useStore.getState().stores).toEqual([EXISTING]);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Create store failed',
        text2: 'insert refused',
      }),
    );
  });

  it('T-J4: a reload that drops the temporary row mid-flight still ends with one real row', async () => {
    let resolve!: (id: string) => void;
    createStoreMock.mockReturnValue(new Promise((r) => { resolve = r; }));

    const pending = useStore.getState().addStore(NEW_STORE);
    // loadFromSupabase's `set({ stores: cloudStores })`: replaces the array, so
    // the temporary row is gone, and the real row isn't in it yet.
    useStore.setState({ stores: [EXISTING] });

    resolve('real-id');
    await pending;

    const stores = useStore.getState().stores;
    expect(stores.map((s) => s.id)).toEqual(['s1', 'real-id']);
  });

  it('T-J4: a reload that already holds the real row does not duplicate it', async () => {
    let resolve!: (id: string) => void;
    createStoreMock.mockReturnValue(new Promise((r) => { resolve = r; }));

    const pending = useStore.getState().addStore(NEW_STORE);
    useStore.setState({ stores: [EXISTING, { ...NEW_STORE, id: 'real-id' }] });

    resolve('real-id');
    await pending;

    expect(useStore.getState().stores.map((s) => s.id)).toEqual(['s1', 'real-id']);
  });

  it('a failed insert after a mid-flight reload does not restore an old snapshot', async () => {
    let reject!: (e: Error) => void;
    createStoreMock.mockReturnValue(new Promise((_, r) => { reject = r; }));

    const pending = useStore.getState().addStore(NEW_STORE);
    const fromReload = { ...EXISTING, id: 's2', name: 'From the reload' };
    useStore.setState({ stores: [EXISTING, fromReload] });

    reject(new Error('insert refused'));
    await expect(pending).resolves.toBeNull();

    expect(useStore.getState().stores.map((s) => s.id)).toEqual(['s1', 's2']);
  });
});
