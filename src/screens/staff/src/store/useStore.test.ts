// src/store/useStore.test.ts — selector + queue-mirror tests.

import { useStore, currentUserId, selectStores } from './useStore';
import type { QueuedSubmission } from '../lib/types';
import AsyncStorage from '@react-native-async-storage/async-storage';

function makeItem(overrides: Partial<QueuedSubmission> = {}): QueuedSubmission {
  return {
    client_uuid: 'q1',
    store_id: 'store-1',
    date: '2026-05-24',
    vendor_id: 'vendor-1',
    status: 'submitted',
    entries: [],
    queued_at: new Date().toISOString(),
    intent_user_id: 'user-1',
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    authState: { kind: 'idle' },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

describe('useStore — auth state transitions', () => {
  it('starts in idle and accepts signing-in / signed-in / signed-out', () => {
    expect(useStore.getState().authState).toEqual({ kind: 'idle' });
    useStore.getState().setAuthState({ kind: 'signing-in' });
    expect(useStore.getState().authState.kind).toBe('signing-in');
    useStore.getState().setAuthState({
      kind: 'signed-in',
      userId: 'u-1',
      stores: [{ storeId: 's-1', storeName: 'A' }],
    });
    expect(useStore.getState().authState.kind).toBe('signed-in');
    useStore.getState().setAuthState({ kind: 'signed-out' });
    expect(useStore.getState().authState.kind).toBe('signed-out');
  });
});

describe('useStore — active store mirrors AsyncStorage', () => {
  it('writes through on setActiveStore', () => {
    useStore.getState().setActiveStore({ id: 's-1', name: 'A' });
    expect(useStore.getState().activeStore).toEqual({ id: 's-1', name: 'A' });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'imr-staff:active-store:v1',
      's-1',
    );
  });

  it('removes the key when set to null', () => {
    useStore.getState().setActiveStore(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(
      'imr-staff:active-store:v1',
    );
  });
});

describe('useStore — queue mutations write through AsyncStorage', () => {
  it('enqueueEod appends and persists', async () => {
    const item = makeItem();
    await useStore.getState().enqueueEod(item);
    expect(useStore.getState().eodQueue).toHaveLength(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'imr-staff:eod-queue:v1',
      JSON.stringify([item]),
    );
  });

  it('dequeueEod removes by client_uuid', async () => {
    const a = makeItem({ client_uuid: 'a' });
    const b = makeItem({ client_uuid: 'b' });
    useStore.setState({ eodQueue: [a, b] });
    await useStore.getState().dequeueEod('a');
    expect(useStore.getState().eodQueue).toEqual([b]);
  });

  it('bumpEodAttempts increments and stores lastError', async () => {
    const a = makeItem({ client_uuid: 'a', attempts: 1 });
    useStore.setState({ eodQueue: [a] });
    await useStore.getState().bumpEodAttempts('a', 'network');
    const after = useStore.getState().eodQueue[0];
    expect(after.attempts).toBe(2);
    expect(after.lastError).toBe('network');
  });
});

describe('selectors', () => {
  it('pendingCountForUser filters by intent_user_id', () => {
    useStore.setState({
      eodQueue: [
        makeItem({ client_uuid: 'a', intent_user_id: 'user-1' }),
        makeItem({ client_uuid: 'b', intent_user_id: 'user-2' }),
        makeItem({ client_uuid: 'c', intent_user_id: 'user-1' }),
      ],
    });
    expect(useStore.getState().pendingCountForUser('user-1')).toBe(2);
    expect(useStore.getState().pendingCountForUser('user-2')).toBe(1);
    expect(useStore.getState().pendingCountForUser(undefined)).toBe(0);
  });

  it('currentUserId returns userId only when signed in', () => {
    expect(currentUserId({ kind: 'idle' })).toBeUndefined();
    expect(currentUserId({ kind: 'signed-out' })).toBeUndefined();
    expect(
      currentUserId({ kind: 'signed-in', userId: 'u-1', stores: [] }),
    ).toBe('u-1');
  });

  it('selectStores returns [] unless signed in', () => {
    expect(selectStores(useStore.getState())).toEqual([]);
    useStore.getState().setAuthState({
      kind: 'signed-in',
      userId: 'u-1',
      stores: [{ storeId: 's', storeName: 'X' }],
    });
    expect(selectStores(useStore.getState())).toEqual([
      { storeId: 's', storeName: 'X' },
    ]);
  });
});
