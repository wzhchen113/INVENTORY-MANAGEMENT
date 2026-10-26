// src/store/useStore.lastOrderContextGuard.spec175.test.ts — spec 175 fix round 1
// (security-auditor L1 / code-reviewer SF-2).
//
// `lastOrderContext` is keyed by vendorId with no store tag, and since spec 175
// a same-store reload no longer clears it. So a `loadLastOrderContext` read
// issued for store A that settles after the user switched to B must be DROPPED
// on both settle paths:
//   • a late A success must not overwrite B's context (it would render A's
//     quantities against B's lines for any shared vendor);
//   • a late A failure must not null B's context.
// The same-store control proves the guard is not over-broad.
//
// Separate file so the spec-151 suites stay byte-unmodified (AC-20). Harness
// follows useStore.lastOrderContext.spec151.test.ts.

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

jest.mock('../lib/db', () => ({
  fetchLastOrderContext: jest.fn(),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';
import type { LastOrderContext } from '../types';

const INITIAL_STATE = useStore.getState();
const fetchMock = db.fetchLastOrderContext as jest.Mock;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function context(sourceId: string, orderedQtyBase: number): LastOrderContext {
  return {
    'v-a': {
      vendorId: 'v-a',
      lastOrderDate: '2026-07-29',
      confidence: 'placed',
      source: 'purchase_order',
      sourceId,
      countedDate: '2026-07-29',
      itemsTruncated: false,
      items: { a1: { itemId: 'a1', orderedQtyBase, countedQtyBase: 30 } },
    },
  };
}

/** Store A's context (the late, stale read) and store B's (already on screen). */
const LA = context('po-a', 78);
const LB = context('po-b', 12);

const store = (id: string) => ({ id, brandId: 'b', name: id, address: '', status: 'active' }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ currentStore: store('A'), lastOrderContext: null });
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('loadLastOrderContext — drops a result whose store is no longer current', () => {
  it('a late store-A success does not overwrite store B\'s context', async () => {
    const d = deferred<LastOrderContext>();
    fetchMock.mockReturnValueOnce(d.promise);

    const p = useStore.getState().loadLastOrderContext(['v-a'], 'D');
    expect(fetchMock).toHaveBeenCalledWith('A', ['v-a'], 'D');
    useStore.setState({ currentStore: store('B'), lastOrderContext: LB });
    d.resolve(LA);
    await p;

    expect(useStore.getState().lastOrderContext).toBe(LB);
  });

  it('a late store-A failure does not null store B\'s context', async () => {
    const d = deferred<LastOrderContext>();
    fetchMock.mockReturnValueOnce(d.promise);

    const p = useStore.getState().loadLastOrderContext(['v-a'], 'D');
    expect(fetchMock).toHaveBeenCalledWith('A', ['v-a'], 'D');
    useStore.setState({ currentStore: store('B'), lastOrderContext: LB });
    d.reject(new Error('late'));
    await expect(p).resolves.toBeUndefined();

    expect(useStore.getState().lastOrderContext).toBe(LB);
    // Still the AC-17 posture: warn only, never a toast.
    expect(console.warn).toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('control — with no store change the result still lands (success and failure)', async () => {
    fetchMock.mockResolvedValueOnce(LA);
    await useStore.getState().loadLastOrderContext(['v-a'], 'D');
    expect(useStore.getState().lastOrderContext).toBe(LA);

    fetchMock.mockRejectedValueOnce(new Error('same-store failure'));
    await useStore.getState().loadLastOrderContext(['v-a'], 'D');
    expect(useStore.getState().lastOrderContext).toBeNull();
  });
});
