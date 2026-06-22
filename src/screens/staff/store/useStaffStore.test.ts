// src/screens/staff/store/useStaffStore.test.ts — selector + queue-mirror tests.

// Spec 098 — the store now imports the supabase client (for the weekly
// slice's direct-rpc carve-out), so stub it at the module boundary like
// the screen tests do; without a real URL `createClient` throws at load.
jest.mock('../../../lib/supabase', () => ({
  supabase: { rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

import { useStaffStore, currentStaffUserId, selectStaffStores } from './useStaffStore';
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
  useStaffStore.setState({
    authState: { kind: 'idle' },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

describe('useStaffStore — auth state transitions', () => {
  it('starts in idle and accepts signing-in / signed-in / signed-out', () => {
    expect(useStaffStore.getState().authState).toEqual({ kind: 'idle' });
    useStaffStore.getState().setAuthState({ kind: 'signing-in' });
    expect(useStaffStore.getState().authState.kind).toBe('signing-in');
    useStaffStore.getState().setAuthState({
      kind: 'signed-in',
      userId: 'u-1',
      stores: [{ storeId: 's-1', storeName: 'A' }],
    });
    expect(useStaffStore.getState().authState.kind).toBe('signed-in');
    useStaffStore.getState().setAuthState({ kind: 'signed-out' });
    expect(useStaffStore.getState().authState.kind).toBe('signed-out');
  });
});

describe('useStaffStore — active store mirrors AsyncStorage', () => {
  it('writes through on setActiveStore', () => {
    useStaffStore.getState().setActiveStore({ id: 's-1', name: 'A' });
    expect(useStaffStore.getState().activeStore).toEqual({ id: 's-1', name: 'A' });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'imr-staff:active-store:v1',
      's-1',
    );
  });

  it('removes the key when set to null', () => {
    useStaffStore.getState().setActiveStore(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(
      'imr-staff:active-store:v1',
    );
  });
});

describe('useStaffStore — queue mutations write through AsyncStorage', () => {
  it('enqueueEod appends and persists', async () => {
    const item = makeItem();
    await useStaffStore.getState().enqueueEod(item);
    expect(useStaffStore.getState().eodQueue).toHaveLength(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'imr-staff:eod-queue:v2',
      JSON.stringify([item]),
    );
  });

  it('dequeueEod removes by client_uuid', async () => {
    const a = makeItem({ client_uuid: 'a' });
    const b = makeItem({ client_uuid: 'b' });
    useStaffStore.setState({ eodQueue: [a, b] });
    await useStaffStore.getState().dequeueEod('a');
    expect(useStaffStore.getState().eodQueue).toEqual([b]);
  });

  it('bumpEodAttempts increments and stores lastError', async () => {
    const a = makeItem({ client_uuid: 'a', attempts: 1 });
    useStaffStore.setState({ eodQueue: [a] });
    await useStaffStore.getState().bumpEodAttempts('a', 'network');
    const after = useStaffStore.getState().eodQueue[0];
    expect(after.attempts).toBe(2);
    expect(after.lastError).toBe('network');
  });
});

describe('selectors', () => {
  it('pendingCountForUser filters by intent_user_id', () => {
    useStaffStore.setState({
      eodQueue: [
        makeItem({ client_uuid: 'a', intent_user_id: 'user-1' }),
        makeItem({ client_uuid: 'b', intent_user_id: 'user-2' }),
        makeItem({ client_uuid: 'c', intent_user_id: 'user-1' }),
      ],
    });
    expect(useStaffStore.getState().pendingCountForUser('user-1')).toBe(2);
    expect(useStaffStore.getState().pendingCountForUser('user-2')).toBe(1);
    expect(useStaffStore.getState().pendingCountForUser(undefined)).toBe(0);
  });

  it('currentStaffUserId returns userId only when signed in', () => {
    expect(currentStaffUserId({ kind: 'idle' })).toBeUndefined();
    expect(currentStaffUserId({ kind: 'signed-out' })).toBeUndefined();
    expect(
      currentStaffUserId({ kind: 'signed-in', userId: 'u-1', stores: [] }),
    ).toBe('u-1');
  });

  it('selectStaffStores returns [] unless signed in', () => {
    expect(selectStaffStores(useStaffStore.getState())).toEqual([]);
    useStaffStore.getState().setAuthState({
      kind: 'signed-in',
      userId: 'u-1',
      stores: [{ storeId: 's', storeName: 'X' }],
    });
    expect(selectStaffStores(useStaffStore.getState())).toEqual([
      { storeId: 's', storeName: 'X' },
    ]);
  });
});
