// src/hooks/useEodSubmitPopup.test.ts — Spec 180 §8.2.
//
// Drives the pop-up through the REAL wiring: `useSubmissionNotifications`
// (which composes `useEodSubmitPopup`) with a mocked `lib/supabase` channel
// whose INSERT handler the test fires by hand. Pins:
//   • AC-6 — mount + the initial `loadSubmissionNotifications` never toasts;
//   • one INSERT → exactly one Toast.show with the mapped copy;
//   • a second same-store INSERT re-shows in place (replace);
//   • a different store while one is visible queues, then shows on onHide;
//   • a brandKey change resets the groups;
//   • onPress → markSubmissionNotificationsRead(ids) + a palette request ONLY
//     on the phone tier.
// The hook IS the `lib/supabase` boundary (spec 057 hybrid-mocking rule), so
// mocking supabase here is allowed; the store is a minimal stand-in.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../lib/supabase', () => {
  const handlers: Record<string, (payload: { new: unknown }) => void> = {};
  return {
    __esModule: true,
    __handlers: handlers,
    supabase: {
      channel: jest.fn((name: string) => {
        type MockChannel = { on: jest.Mock; subscribe: jest.Mock };
        const ch: MockChannel = {
          on: jest.fn((_evt: string, _filter: unknown, cb: (p: { new: unknown }) => void): MockChannel => {
            handlers[name] = cb;
            return ch;
          }),
          subscribe: jest.fn(() => ch),
        };
        return ch;
      }),
      removeChannel: jest.fn(),
    },
  };
});

// db.ts is owned by the backend half of spec 180; the mock mirrors the §5
// `mapNotificationRow` contract (snake → camel, read=false without the embed).
jest.mock('../lib/db', () => ({
  __esModule: true,
  mapNotificationRow: (row: any) => ({
    id: row.id,
    brandId: row.brand_id,
    storeId: row.store_id,
    actorUserId: row.actor_user_id ?? null,
    actorName: row.actor_name ?? null,
    storeName: row.store_name ?? null,
    type: row.type,
    sourceId: row.source_id,
    createdAt: row.created_at,
    read: false,
    body: row.body ?? undefined,
    category: row.category ?? undefined,
    submissionId: row.submission_id ?? null,
  }),
}));

let mockIsPhone = false;
jest.mock('../theme/breakpoints', () => ({
  useIsPhone: () => mockIsPhone,
}));

jest.mock('../screens/cmd/sections/phone/PhoneNotifications', () => ({
  sectionForNotification: (type: string) =>
    type === 'order_ready' ? 'Ordering' : type === 'eod' || type === 'eod_update' ? 'EODCount' : null,
}));

const mockState: Record<string, any> = {};
jest.mock('../store/useStore', () => {
  const useStore = (sel: (s: any) => unknown) => sel(mockState);
  useStore.getState = () => mockState;
  return { __esModule: true, useStore };
});

import { act, renderHook } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { usePaletteAction } from '../lib/paletteAction';
import { useSubmissionNotifications } from './useSubmissionNotifications';
import { EOD_POPUP_TOAST_TYPE } from '../lib/eodPopup';

const supabaseMock = jest.requireMock('../lib/supabase') as {
  __handlers: Record<string, (payload: { new: unknown }) => void>;
};
const toastShow = Toast.show as jest.Mock;
const toastHide = Toast.hide as jest.Mock;

const BRAND = 'brand-a';
const TOWSON = 'store-towson';
const FRED = 'store-frederick';

let seq = 0;
function row(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `n-${seq}`,
    brand_id: BRAND,
    store_id: TOWSON,
    actor_user_id: 'staff-1',
    actor_name: 'Cook',
    store_name: 'Towson',
    type: 'eod',
    source_id: `sub-${seq}`,
    submission_id: null,
    body: null,
    category: null,
    created_at: '2026-10-26T22:00:00.000Z',
    ...over,
  };
}

function insert(r: Record<string, unknown>, brand = BRAND) {
  const h = supabaseMock.__handlers[`notifications-${brand}`];
  if (!h) throw new Error(`no channel for ${brand}`);
  act(() => h({ new: r }));
}

function lastShowOpts() {
  return toastShow.mock.calls[toastShow.mock.calls.length - 1][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(supabaseMock.__handlers)) delete supabaseMock.__handlers[k];
  mockIsPhone = false;
  usePaletteAction.setState({ pending: null });
  Object.assign(mockState, {
    currentUser: { id: 'admin-1', role: 'admin', stores: [TOWSON, FRED] },
    brandsList: [],
    locale: 'en',
    loadSubmissionNotifications: jest.fn(() => Promise.resolve()),
    markSubmissionNotificationsRead: jest.fn(),
  });
});

describe('useEodSubmitPopup via useSubmissionNotifications', () => {
  it('AC-6: mount + the initial feed load never toast', async () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    await act(async () => { await Promise.resolve(); });
    expect(mockState.loadSubmissionNotifications).toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('a realtime INSERT refetches the feed AND shows one toast with the mapped copy', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    mockState.loadSubmissionNotifications.mockClear();
    insert(row({ body: 'Sysco' }));
    expect(mockState.loadSubmissionNotifications).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(lastShowOpts()).toEqual(expect.objectContaining({
      type: 'eodPopup',
      text1: 'Towson: EOD count submitted',
      text2: 'Sysco · by Cook',
      visibilityTime: 8000,
    }));
  });

  // Release-proposal S-1 regression: the default `info` toast is one line at a
  // fixed 60px and truncated the grouped "(N updated)" marker. Every pop-up
  // show (first, replace-in-place, dequeued) must use the 2-line custom type.
  it('every pop-up show uses the 2-line eodPopup toast type, never info', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    insert(row());
    insert(row({ type: 'eod_update' }));
    insert(row({ store_id: FRED, store_name: 'Frederick' }));
    act(() => toastShow.mock.calls[toastShow.mock.calls.length - 1][0].onHide());
    expect(toastShow).toHaveBeenCalledTimes(3);
    for (const [opts] of toastShow.mock.calls) expect(opts.type).toBe(EOD_POPUP_TOAST_TYPE);
    expect(EOD_POPUP_TOAST_TYPE).toBe('eodPopup');
  });

  it('suppressed rows (own submit, unassigned store, non-EOD type) refetch but never toast', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    insert(row({ actor_user_id: 'admin-1' }));
    insert(row({ store_id: 'store-elsewhere' }));
    insert(row({ type: 'waste' }));
    expect(mockState.loadSubmissionNotifications).toHaveBeenCalledTimes(1 + 3);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('a second same-store INSERT re-shows in place with the grouped count', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    insert(row());
    insert(row({ type: 'eod_update', actor_name: 'Manager' }));
    expect(toastShow).toHaveBeenCalledTimes(2);
    expect(lastShowOpts().text1).toBe('Towson: 2 vendor counts submitted (1 updated)');
    expect(lastShowOpts().text2).toBe('by Cook and 1 more');
  });

  it('a duplicate delivery of the same row is ignored', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    const r = row();
    insert(r);
    insert(r);
    expect(toastShow).toHaveBeenCalledTimes(1);
  });

  it('a different store while one is visible queues, then shows on onHide', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    insert(row());
    const towsonOpts = lastShowOpts();
    insert(row({ store_id: FRED, store_name: 'Frederick' }));
    expect(toastShow).toHaveBeenCalledTimes(1);
    act(() => towsonOpts.onHide());
    expect(toastShow).toHaveBeenCalledTimes(2);
    expect(lastShowOpts().text1).toBe('Frederick: EOD count submitted');
  });

  it('frees the slot if a foreign toast replaced ours and onHide never fired', () => {
    jest.useFakeTimers();
    try {
      renderHook(() => useSubmissionNotifications(BRAND));
      insert(row());
      insert(row({ store_id: FRED, store_name: 'Frederick' }));
      expect(toastShow).toHaveBeenCalledTimes(1);
      act(() => { jest.advanceTimersByTime(9500); });
      expect(toastShow).toHaveBeenCalledTimes(2);
      expect(lastShowOpts().text1).toBe('Frederick: EOD count submitted');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a brandKey change resets the groups (no merge into a stale group)', () => {
    mockState.currentUser = { id: 'sa-1', role: 'super_admin', stores: [] };
    mockState.brandsList = [{ id: BRAND }];
    const { rerender } = renderHook(({ b }: { b?: string }) => useSubmissionNotifications(b), {
      initialProps: { b: undefined as string | undefined },
    });
    insert(row());
    expect(lastShowOpts().text1).toBe('Towson: EOD count submitted');
    act(() => lastShowOpts().onHide());
    // Brand scope changes (a second brand arrives) → new brandKey.
    mockState.brandsList = [{ id: BRAND }, { id: 'brand-b' }];
    rerender({ b: undefined });
    insert(row());
    expect(lastShowOpts().text1).toBe('Towson: EOD count submitted');
  });

  it('a brandKey change frees the slot: a stale toast never makes the next store queue', () => {
    mockState.currentUser = { id: 'sa-1', role: 'super_admin', stores: [] };
    mockState.brandsList = [{ id: BRAND }];
    const { rerender } = renderHook(({ b }: { b?: string }) => useSubmissionNotifications(b), {
      initialProps: { b: undefined as string | undefined },
    });
    insert(row());
    expect(toastShow).toHaveBeenCalledTimes(1);
    // Scope change while the Towson toast is still up (no onHide fired).
    mockState.brandsList = [{ id: BRAND }, { id: 'brand-b' }];
    rerender({ b: undefined });
    insert(row({ store_id: FRED, store_name: 'Frederick' }));
    expect(toastShow).toHaveBeenCalledTimes(2);
    expect(lastShowOpts().text1).toBe('Frederick: EOD count submitted');
  });

  it('onPress (desktop) marks every id in the group read, no palette request', () => {
    renderHook(() => useSubmissionNotifications(BRAND));
    const a = row({ type: 'order_ready' });
    const b = row();
    insert(a);
    insert(b);
    act(() => lastShowOpts().onPress());
    expect(mockState.markSubmissionNotificationsRead).toHaveBeenCalledWith([a.id, b.id]);
    expect(usePaletteAction.getState().pending).toBeNull();
    expect(toastHide).toHaveBeenCalled();
  });

  it('onPress (phone) also deep-links like the phone bell row', () => {
    mockIsPhone = true;
    renderHook(() => useSubmissionNotifications(BRAND));
    const a = row({ type: 'order_ready', source_id: 'sub-ready' });
    insert(a);
    act(() => lastShowOpts().onPress());
    expect(mockState.markSubmissionNotificationsRead).toHaveBeenCalledWith([a.id]);
    expect(usePaletteAction.getState().pending).toEqual({
      section: 'Ordering',
      selectedName: null,
      orderApproval: { submissionId: 'sub-ready', storeId: TOWSON },
    });
  });

  it('onPress (phone) on an update-only group opens EOD count with no orderApproval', () => {
    mockIsPhone = true;
    renderHook(() => useSubmissionNotifications(BRAND));
    insert(row({ type: 'eod_update' }));
    act(() => lastShowOpts().onPress());
    expect(usePaletteAction.getState().pending).toEqual({ section: 'EODCount', selectedName: null });
  });
});
