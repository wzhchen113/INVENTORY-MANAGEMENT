// src/hooks/useEodSubmit.test.ts — orchestrator outcome coverage.
//
// Tests all 4 outcomes (success / success-replay / forbidden / queued)
// + offline-at-submit-time path. Mocks supabase.rpc at the boundary
// per spec 062 §0 Q5 (hook test → mock lower layers).

import { renderHook, act, waitFor } from '@testing-library/react-native';

// Mock the connectivity hook with a controllable boolean.
let mockOnline = true;
jest.mock('./useConnectionStatus', () => ({
  useConnectionStatus: () => mockOnline,
}));

// Mock the supabase client; expose .rpc as a jest.fn so each test
// programs its return.
const mockRpc = jest.fn();
jest.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

// Mock toast (already in setup but make sure we can spy easily).
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

import { useEodSubmit } from './useEodSubmit';
import { useStaffStore } from '../store/useStaffStore';
import type { Outcome } from '../lib/types';

beforeEach(() => {
  mockRpc.mockReset();
  mockOnline = true;
  // Reset store to signed-in state with a known user.
  useStaffStore.setState({
    authState: { kind: 'signed-in', userId: 'user-1', stores: [] },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

const samplePayload = {
  store_id: 'store-1',
  date: '2026-05-24',
  vendor_id: 'vendor-1',
  entries: [{ item_id: 'item-1', count: 3 }],
};

describe('useEodSubmit.submit', () => {
  it('returns success when RPC returns 200 + conflict=false', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-1', conflict: false },
      error: null,
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'success', submission_id: 'sub-1' });
    expect(mockRpc).toHaveBeenCalledWith(
      'staff_submit_eod',
      expect.objectContaining({
        p_store_id: 'store-1',
        p_date: '2026-05-24',
        p_vendor_id: 'vendor-1',
        p_status: 'submitted',
        p_submitted_by: null,
        p_entries: [{ ingredient_id: 'item-1', actual_remaining: 3 }],
      }),
    );
  });

  it('returns success-replay when RPC returns 200 + conflict=true', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-1', conflict: true },
      error: null,
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({
      kind: 'success-replay',
      submission_id: 'sub-1',
    });
  });

  it('returns forbidden when RPC error code === 42501', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'cannot see store' },
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome?.kind).toBe('forbidden');
    // NOT enqueued
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);
  });

  it('queues + returns queued when offline', async () => {
    mockOnline = false;
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome?.kind).toBe('queued');
    expect(useStaffStore.getState().eodQueue).toHaveLength(1);
    expect(useStaffStore.getState().eodQueue[0]).toMatchObject({
      store_id: 'store-1',
      date: '2026-05-24',
      vendor_id: 'vendor-1',
      intent_user_id: 'user-1',
      attempts: 0,
      entries: [{ item_id: 'item-1', count: 3 }],
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('queues + returns queued when RPC throws a network error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Network request failed', name: 'TypeError' },
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome?.kind).toBe('queued');
    expect(useStaffStore.getState().eodQueue).toHaveLength(1);
  });

  it('returns failed for a 5xx / generic error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'something exploded', code: '500' },
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome?.kind).toBe('failed');
    // NOT enqueued
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);
  });

  it('exposes a reactive pending count filtered by intent_user_id', async () => {
    // Seed a queue with one item for our user and one for another user.
    useStaffStore.setState({
      eodQueue: [
        {
          client_uuid: 'q1',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [],
          queued_at: new Date().toISOString(),
          intent_user_id: 'user-1',
          attempts: 0,
        },
        {
          client_uuid: 'q2',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [],
          queued_at: new Date().toISOString(),
          intent_user_id: 'other-user',
          attempts: 0,
        },
      ],
    });
    const { result } = renderHook(() => useEodSubmit());
    await waitFor(() => expect(result.current.pending).toBe(1));
  });
});

describe('useEodSubmit — drain loop (mount + connectivity flip)', () => {
  it('skips items whose intent_user_id does not match the current user (soft boundary)', async () => {
    // User A queued an item, then signed out; user B is now signed in.
    // The drain must NOT submit user A's item under user B's JWT.
    useStaffStore.setState({
      authState: { kind: 'signed-in', userId: 'user-B', stores: [] },
      eodQueue: [
        {
          client_uuid: 'q-from-A',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [{ item_id: 'item-1', count: 3 }],
          queued_at: new Date().toISOString(),
          intent_user_id: 'user-A',
          attempts: 0,
        },
      ],
    });

    renderHook(() => useEodSubmit());

    // Wait long enough for any drain attempt to fire (the one-shot
    // mount drain runs in a microtask after the effect commits).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The drain must NOT have called the RPC — user A's item is left
    // in storage as a passive record.
    expect(mockRpc).not.toHaveBeenCalled();
    expect(useStaffStore.getState().eodQueue).toHaveLength(1);
    expect(useStaffStore.getState().eodQueue[0].client_uuid).toBe('q-from-A');
  });

  it('bumps attempts and continues to the next item on a 5xx drain error', async () => {
    // The drain orchestrator: first item returns 5xx (not forbidden,
    // not network), second item returns success. The 5xx item must
    // stay in queue with attempts++, AND the drain must continue to
    // the next item rather than break.
    useStaffStore.setState({
      authState: { kind: 'signed-in', userId: 'user-1', stores: [] },
      eodQueue: [
        {
          client_uuid: 'q-bad',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [{ item_id: 'item-1', count: 3 }],
          queued_at: '2026-05-24T00:00:00.000Z',
          intent_user_id: 'user-1',
          attempts: 0,
        },
        {
          client_uuid: 'q-good',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-2',
          status: 'submitted',
          entries: [{ item_id: 'item-2', count: 5 }],
          queued_at: '2026-05-24T00:00:01.000Z',
          intent_user_id: 'user-1',
          attempts: 0,
        },
      ],
    });

    // First call → 5xx; second call → success.
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'internal server error', code: '500' },
      })
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-good', conflict: false },
        error: null,
      });

    renderHook(() => useEodSubmit());

    // Wait for the drain to settle.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));

    const queueAfter = useStaffStore.getState().eodQueue;
    // q-bad stayed in the queue with attempts bumped.
    expect(queueAfter).toHaveLength(1);
    expect(queueAfter[0].client_uuid).toBe('q-bad');
    expect(queueAfter[0].attempts).toBe(1);
    // q-good was removed (success).
    expect(
      queueAfter.find((q) => q.client_uuid === 'q-good'),
    ).toBeUndefined();
  });
});
