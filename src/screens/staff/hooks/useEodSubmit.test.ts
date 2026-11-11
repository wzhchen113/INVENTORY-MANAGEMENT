// src/screens/staff/hooks/useEodSubmit.test.ts — orchestrator outcome coverage.
//
// Tests all 4 outcomes (success / success-replay / forbidden / queued)
// + offline-at-submit-time path, plus the spec 193 date-window refusal
// (the "other error" branch: failed online, kept and retried in the drain).
// Mocks supabase.rpc at the boundary per spec 062 §0 Q5 (hook test → mock
// lower layers).

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

import Toast from 'react-native-toast-message';
import { useEodSubmit } from './useEodSubmit';
import { useStaffStore } from '../store/useStaffStore';
import { t } from '../i18n';
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
  // Spec 086 — 3-field entry: 1 case × (caseQty implicit on screen) + 1
  // loose unit producing a total of 3. The hook is agnostic to caseQty;
  // it forwards the client-computed total + raw splits verbatim.
  entries: [
    {
      item_id: 'item-1',
      actual_remaining: 3,
      actual_remaining_cases: 1,
      actual_remaining_each: 1,
    },
  ],
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
        p_entries: [
          {
            ingredient_id: 'item-1',
            actual_remaining: 3,
            actual_remaining_cases: 1,
            actual_remaining_each: 1,
          },
        ],
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
    // Spec 199 (AC-21) — under the narrowed isForbidden only the real
    // store-gate message counts, so the fixture carries it verbatim.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message: 'staff_submit_eod: caller cannot see store 00000000-0000-0000-0000-000000000001',
      },
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
      entries: [
        {
          item_id: 'item-1',
          actual_remaining: 3,
          actual_remaining_cases: 1,
          actual_remaining_each: 1,
        },
      ],
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
          entries: [
            {
              item_id: 'item-1',
              actual_remaining: 3,
              actual_remaining_cases: null,
              actual_remaining_each: 3,
            },
          ],
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
          entries: [
            {
              item_id: 'item-1',
              actual_remaining: 3,
              actual_remaining_cases: null,
              actual_remaining_each: 3,
            },
          ],
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
          entries: [
            {
              item_id: 'item-2',
              actual_remaining: 5,
              actual_remaining_cases: null,
              actual_remaining_each: 5,
            },
          ],
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

// ─── Spec 172 — NO NEED entries ride p_entries (AC-34) ─────────────
describe('useEodSubmit — NO NEED (spec 172)', () => {
  const NO_NEED_ENTRY = {
    item_id: 'item-nn',
    actual_remaining: null,
    actual_remaining_cases: null,
    actual_remaining_each: null,
    no_need: true,
  };

  it('online submit forwards no_need: true; the numeric element stays byte-identical', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-1', conflict: false },
      error: null,
    });
    const { result } = renderHook(() => useEodSubmit());
    await act(async () => {
      await result.current.submit({
        ...samplePayload,
        entries: [...samplePayload.entries, NO_NEED_ENTRY],
      });
    });
    const args = mockRpc.mock.calls[0][1] as { p_entries: Array<Record<string, unknown>> };
    expect(args.p_entries).toEqual([
      {
        ingredient_id: 'item-1',
        actual_remaining: 3,
        actual_remaining_cases: 1,
        actual_remaining_each: 1,
      },
      {
        ingredient_id: 'item-nn',
        actual_remaining: null,
        actual_remaining_cases: null,
        actual_remaining_each: null,
        no_need: true,
      },
    ]);
    // The numeric element carries NO no_need key at all.
    expect('no_need' in args.p_entries[0]).toBe(false);
  });

  it('a queued NO NEED submission drains with no_need: true', async () => {
    useStaffStore.setState({
      authState: { kind: 'signed-in', userId: 'user-1', stores: [] },
      eodQueue: [
        {
          client_uuid: 'q-nn',
          store_id: 'store-1',
          date: '2026-05-24',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [NO_NEED_ENTRY],
          queued_at: '2026-05-24T00:00:00.000Z',
          intent_user_id: 'user-1',
          attempts: 0,
        },
      ],
    });
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-nn', conflict: false },
      error: null,
    });

    renderHook(() => useEodSubmit());
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));

    expect(mockRpc).toHaveBeenCalledWith(
      'staff_submit_eod',
      expect.objectContaining({
        p_client_uuid: 'q-nn',
        p_entries: [
          {
            ingredient_id: 'item-nn',
            actual_remaining: null,
            actual_remaining_cases: null,
            actual_remaining_each: null,
            no_need: true,
          },
        ],
      }),
    );
    await waitFor(() => expect(useStaffStore.getState().eodQueue).toHaveLength(0));
  });
});

// ─── Spec 193 — the staff date-window refusal is a plain "failed" ───
// The server refuses a store member's staff_submit_eod call whose p_date is
// outside [A - 35, A + 1] (A = the America/New_York date) with SQLSTATE 22023
// and a constant message (supabase/migrations/20261109190000_staff_eod_date_bound.sql).
// These arms pin that the SHIPPED classifiers send that error down the
// "other error" branch: not forbidden (dequeue, count lost) and not network
// (breaks the drain loop). Test-only; the hook is unchanged. Nothing ties MSG
// to the migration except review: keep them identical.
describe('useEodSubmit — spec 193 date-window refusal', () => {
  const MSG =
    'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)';
  // The shape supabase.rpc resolves `error` with (no throwOnError): in
  // @supabase/postgrest-js 2.101.1 it is the PLAIN parsed JSON body
  // (PostgrestBuilder `error = JSON.parse(body)`), not an Error / PostgrestError
  // instance, and it has no `status` or `name`.
  const windowRefusal = () => ({
    code: '22023',
    message: MSG,
    details: null,
    hint: null,
  });

  it('AC-9: the drain bumps attempts on the refused item, keeps it, and continues to the next', async () => {
    jest.mocked(Toast.show).mockClear();
    useStaffStore.setState({
      authState: { kind: 'signed-in', userId: 'user-1', stores: [] },
      eodQueue: [
        {
          client_uuid: 'q-old',
          store_id: 'store-1',
          date: '2026-01-01',
          vendor_id: 'vendor-1',
          status: 'submitted',
          entries: [
            {
              item_id: 'item-1',
              actual_remaining: 3,
              actual_remaining_cases: null,
              actual_remaining_each: 3,
            },
          ],
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
          entries: [
            {
              item_id: 'item-2',
              actual_remaining: 5,
              actual_remaining_cases: null,
              actual_remaining_each: 5,
            },
          ],
          queued_at: '2026-05-24T00:00:01.000Z',
          intent_user_id: 'user-1',
          attempts: 0,
        },
      ],
    });

    mockRpc
      .mockResolvedValueOnce({ data: null, error: windowRefusal() })
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-good', conflict: false },
        error: null,
      });

    renderHook(() => useEodSubmit());

    // Two calls = the loop did not `break` after the refusal.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_client_uuid: 'q-old' });
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_client_uuid: 'q-good' });

    await waitFor(() =>
      expect(
        useStaffStore.getState().eodQueue.find((q) => q.client_uuid === 'q-good'),
      ).toBeUndefined(),
    );
    const queueAfter = useStaffStore.getState().eodQueue;
    // The refused item stays queued (not dequeued) with attempts bumped. The
    // hook records `err instanceof Error ? err.message : 'unknown'`, so for
    // the plain-object error real traffic produces, lastError is 'unknown'
    // (not the server message, and not the network branch's 'network').
    expect(queueAfter).toHaveLength(1);
    expect(queueAfter[0].client_uuid).toBe('q-old');
    expect(queueAfter[0].attempts).toBe(1);
    expect(queueAfter[0].lastError).toBe('unknown');
    // The dequeue branch's persistent error toast never fired.
    expect(Toast.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('AC-10: an online submit that gets the refusal returns failed (not forbidden, not queued)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: windowRefusal() });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'failed', message: t('eod.toast.failed') });
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);
  });
});

// ─── Spec 199 — narrowed isForbidden + skipped-items notice ─────────
// Only the RPC's step-1.5 store gate ('staff_submit_eod: caller cannot see
// store <uuid>', 42501) or an HTTP 403 without a non-gate 42501 dequeues a
// queued count / returns `forbidden`. Any other 42501 (the eod_entries
// store-mismatch trigger, an anon-session "permission denied for function")
// is kept and retried. A success envelope's `skipped_item_ids` surfaces as
// `skipped_count` online and as ONE debounced notice in the drain.
describe('useEodSubmit — spec 199 skip unknown items', () => {
  const STORE_GATE_MSG =
    'staff_submit_eod: caller cannot see store 00000000-0000-0000-0000-000000000001';
  const TRIGGER_MSG = 'eod_entries: item store mismatch with parent submission';

  function queued(clientUuid: string, queuedAt: string, vendorId = 'vendor-1') {
    return {
      client_uuid: clientUuid,
      store_id: 'store-1',
      date: '2026-05-24',
      vendor_id: vendorId,
      status: 'submitted' as const,
      entries: [
        {
          item_id: 'item-1',
          actual_remaining: 3,
          actual_remaining_cases: null,
          actual_remaining_each: 3,
        },
      ],
      queued_at: queuedAt,
      intent_user_id: 'user-1',
      attempts: 0,
    };
  }

  const toastCalls = () =>
    (Toast.show as jest.Mock).mock.calls.map((c) => c[0] as Record<string, unknown>);

  // Earlier describes can leave a 400 ms debounced drain toast pending
  // (no unmount cleanup in the hook); let it fire before these arms start
  // clearing + asserting on Toast.show.
  beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  beforeEach(() => {
    jest.mocked(Toast.show).mockClear();
  });

  it('AC-13: drain + store-gate 42501 dequeues the item and shows the sync-error toast', async () => {
    useStaffStore.setState({ eodQueue: [queued('q-gate', '2026-05-24T00:00:00.000Z')] });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: STORE_GATE_MSG, details: null, hint: null },
    });

    renderHook(() => useEodSubmit());

    await waitFor(() => expect(useStaffStore.getState().eodQueue).toHaveLength(0));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: t('chrome.queue.syncErrorBanner', { date: '2026-05-24', vendor: 'vendor-1' }),
      }),
    );
  });

  it.each([
    ['the eod_entries store-mismatch trigger', { code: '42501', message: TRIGGER_MSG }],
    [
      'an anon-session permission denied',
      { code: '42501', message: 'permission denied for function staff_submit_eod' },
    ],
    [
      'the trigger message with status 403 attached (R12 b)',
      { code: '42501', message: TRIGGER_MSG, status: 403 },
    ],
  ])(
    'AC-14: drain + %s keeps the item (attempts bumped) and still submits the next FIFO item',
    async (_label, error) => {
      useStaffStore.setState({
        eodQueue: [
          queued('q-stale', '2026-05-24T00:00:00.000Z'),
          queued('q-next', '2026-05-24T00:00:01.000Z', 'vendor-2'),
        ],
      });
      mockRpc
        .mockResolvedValueOnce({ data: null, error })
        .mockResolvedValueOnce({
          data: { submission_id: 'sub-next', conflict: false, skipped_item_ids: [] },
          error: null,
        });

      renderHook(() => useEodSubmit());

      // Two calls = not dequeued-and-stopped, not a network `break`.
      await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
      expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_client_uuid: 'q-stale' });
      expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_client_uuid: 'q-next' });
      await waitFor(() =>
        expect(
          useStaffStore.getState().eodQueue.find((q) => q.client_uuid === 'q-next'),
        ).toBeUndefined(),
      );
      const queueAfter = useStaffStore.getState().eodQueue;
      expect(queueAfter).toHaveLength(1);
      expect(queueAfter[0].client_uuid).toBe('q-stale');
      expect(queueAfter[0].attempts).toBe(1);
      // The other-error branch, not the network branch.
      expect(queueAfter[0].lastError).not.toBe('network');
      // The dequeue branch's sync-error toast never fired.
      expect(Toast.show).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    },
  );

  it('AC-15: drain + a bare HTTP 403 (no code) dequeues the item', async () => {
    useStaffStore.setState({ eodQueue: [queued('q-403', '2026-05-24T00:00:00.000Z')] });
    mockRpc.mockResolvedValueOnce({ data: null, error: { status: 403, message: 'Forbidden' } });

    renderHook(() => useEodSubmit());

    await waitFor(() => expect(useStaffStore.getState().eodQueue).toHaveLength(0));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: t('chrome.queue.syncErrorBanner', { date: '2026-05-24', vendor: 'vendor-1' }),
      }),
    );
  });

  it('AC-16: online store-gate 42501 → forbidden', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: STORE_GATE_MSG, details: null, hint: null },
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'forbidden', message: t('eod.error.forbidden') });
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);
  });

  it('AC-16: online trigger-style 42501 → failed (not forbidden, not queued), nothing enqueued', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: TRIGGER_MSG, details: null, hint: null },
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'failed', message: t('eod.toast.failed') });
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);
  });

  it('AC-17 (hook half): 2 skipped ids → success with skipped_count 2; the hook shows no toast', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        submission_id: 'sub-1',
        conflict: false,
        entry_ids: ['e-1'],
        stock_updates: [],
        skipped_item_ids: ['gone-1', 'gone-2'],
      },
      error: null,
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'success', submission_id: 'sub-1', skipped_count: 2 });
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('AC-17: an empty skipped_item_ids list omits skipped_count', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-1', conflict: false, skipped_item_ids: [] },
      error: null,
    });
    const { result } = renderHook(() => useEodSubmit());
    let outcome: Outcome | undefined;
    await act(async () => {
      outcome = await result.current.submit(samplePayload);
    });
    expect(outcome).toEqual({ kind: 'success', submission_id: 'sub-1' });
    expect('skipped_count' in (outcome as object)).toBe(false);
  });

  it('AC-18: two drained items reporting 1 + 2 skips → ONE notice with N = 3 that allSynced does not overwrite', async () => {
    useStaffStore.setState({
      eodQueue: [
        queued('q-a', '2026-05-24T00:00:00.000Z'),
        queued('q-b', '2026-05-24T00:00:01.000Z', 'vendor-2'),
      ],
    });
    mockRpc
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-a', conflict: false, skipped_item_ids: ['gone-1'] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-b', conflict: false, skipped_item_ids: ['gone-2', 'gone-3'] },
        error: null,
      });

    renderHook(() => useEodSubmit());

    await waitFor(() => expect(useStaffStore.getState().eodQueue).toHaveLength(0));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled(), { timeout: 1500 });
    // Outlast another debounce window: nothing later may replace the notice.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const calls = toastCalls();
    expect(calls).toHaveLength(1);
    expect(calls[calls.length - 1]).toEqual({
      type: 'info',
      text1: t('eod.toast.skippedItems', { count: 3 }),
      text2: t('eod.toast.allSynced'),
      position: 'bottom',
      visibilityTime: 6000,
    });
    // allSynced never shown as its own (later) toast.
    expect(calls.some((c) => c.text1 === t('eod.toast.allSynced'))).toBe(false);
  });

  it('AC-18: a drain with no skips still shows the allSynced toast exactly as before', async () => {
    useStaffStore.setState({ eodQueue: [queued('q-ok', '2026-05-24T00:00:00.000Z')] });
    mockRpc.mockResolvedValueOnce({
      data: { submission_id: 'sub-ok', conflict: false, skipped_item_ids: [] },
      error: null,
    });

    renderHook(() => useEodSubmit());

    await waitFor(() => expect(Toast.show).toHaveBeenCalled(), { timeout: 1500 });
    const calls = toastCalls();
    expect(calls[calls.length - 1]).toEqual({
      type: 'success',
      text1: t('eod.toast.allSynced'),
      position: 'bottom',
      visibilityTime: 2500,
    });
  });

  it('AC-19: online success without the key → unchanged outcome, no skipped_count property', async () => {
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
    expect('skipped_count' in (outcome as object)).toBe(false);
  });

  it('AC-19: a drained success (and a replay) without the key shows no skipped notice', async () => {
    useStaffStore.setState({
      eodQueue: [
        queued('q-old-server', '2026-05-24T00:00:00.000Z'),
        queued('q-replay', '2026-05-24T00:00:01.000Z', 'vendor-2'),
      ],
    });
    mockRpc
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-old', conflict: false },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { submission_id: 'sub-replay', conflict: true, reason: 'client_uuid already processed' },
        error: null,
      });

    renderHook(() => useEodSubmit());

    await waitFor(() => expect(useStaffStore.getState().eodQueue).toHaveLength(0));
    await waitFor(
      () =>
        expect(toastCalls().some((c) => c.text1 === t('eod.toast.allSynced'))).toBe(true),
      { timeout: 1500 },
    );
    const calls = toastCalls();
    expect(calls.some((c) => c.type === 'info')).toBe(false);
    expect(calls[calls.length - 1]).toEqual({
      type: 'success',
      text1: t('eod.toast.allSynced'),
      position: 'bottom',
      visibilityTime: 2500,
    });
  });
});
