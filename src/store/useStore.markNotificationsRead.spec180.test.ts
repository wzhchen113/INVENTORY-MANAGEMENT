// src/store/useStore.markNotificationsRead.spec180.test.ts — Spec 180 §7.4.
//
// Pins the bulk optimistic-then-revert action behind an EOD pop-up tap:
//   • flips only the unread rows present in the feed + decrements the badge by
//     exactly that many, then persists ALL ids via db.markNotificationsRead;
//   • an id absent from the feed (realtime raced the refetch) still persists,
//     and triggers a reconcile reload on success;
//   • a failure restores exactly the flipped rows + count and toasts through
//     notifyBackendError.
// Also re-pins the single-id action's early return that motivated the new one.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

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
  hasActiveSession: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/webPush', () => ({
  unsubscribeFromPush: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  markNotificationsRead: jest.fn().mockResolvedValue(undefined),
  markNotificationRead: jest.fn().mockResolvedValue(undefined),
  fetchAdminNotifications: jest.fn().mockResolvedValue([]),
  fetchUnreadNotificationCount: jest.fn().mockResolvedValue(0),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';
import type { AdminNotification } from '../types';

const markMany = db.markNotificationsRead as jest.Mock;
const markOne = db.markNotificationRead as jest.Mock;
const fetchFeed = db.fetchAdminNotifications as jest.Mock;
const fetchCount = db.fetchUnreadNotificationCount as jest.Mock;
const toastShow = Toast.show as jest.Mock;

const flush = () => new Promise<void>((r) => setImmediate(r));

function notif(id: string, read = false): AdminNotification {
  return {
    id, brandId: 'b', storeId: 's', actorUserId: 'u', actorName: 'Cook',
    storeName: 'Towson', type: 'eod', sourceId: `src-${id}`,
    createdAt: '2026-10-26T22:00:00.000Z', read,
  };
}

const INITIAL = useStore.getState();
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL, true);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  markMany.mockResolvedValue(undefined);
});

afterEach(() => warnSpy.mockRestore());

describe('markSubmissionNotificationsRead (spec 180)', () => {
  it('optimistically flips the unread rows in the group + decrements the badge by that many', () => {
    useStore.setState({
      submissionNotifications: [notif('a'), notif('b', true), notif('c'), notif('z')],
      submissionUnreadCount: 5,
    });
    useStore.getState().markSubmissionNotificationsRead(['a', 'b', 'c']);
    const s = useStore.getState();
    expect(s.submissionNotifications.map((n) => [n.id, n.read])).toEqual([
      ['a', true], ['b', true], ['c', true], ['z', false],
    ]);
    expect(s.submissionUnreadCount).toBe(3); // a + c flipped; b was already read
    expect(markMany).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('all ids present → no reconcile reload on success', async () => {
    useStore.setState({ submissionNotifications: [notif('a')], submissionUnreadCount: 1 });
    useStore.getState().markSubmissionNotificationsRead(['a']);
    await flush();
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('an id absent from the feed still persists and triggers a reload on success', async () => {
    fetchFeed.mockResolvedValueOnce([notif('a', true), notif('new', true)]);
    fetchCount.mockResolvedValueOnce(0);
    useStore.setState({ submissionNotifications: [notif('a')], submissionUnreadCount: 2 });
    useStore.getState().markSubmissionNotificationsRead(['a', 'new']);
    expect(markMany).toHaveBeenCalledWith(['a', 'new']);
    expect(useStore.getState().submissionUnreadCount).toBe(1); // only 'a' was in the feed
    await flush();
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    expect(useStore.getState().submissionUnreadCount).toBe(0);
  });

  it('failure reverts exactly the flipped rows + count and toasts', async () => {
    markMany.mockRejectedValueOnce(new Error('boom'));
    useStore.setState({
      submissionNotifications: [notif('a'), notif('b', true), notif('z')],
      submissionUnreadCount: 2,
    });
    useStore.getState().markSubmissionNotificationsRead(['a', 'b', 'missing']);
    expect(useStore.getState().submissionUnreadCount).toBe(1);
    await flush();
    const s = useStore.getState();
    expect(s.submissionNotifications.map((n) => [n.id, n.read])).toEqual([
      ['a', false], ['b', true], ['z', false],
    ]);
    expect(s.submissionUnreadCount).toBe(2);
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      text1: 'Mark notifications read failed',
      text2: 'boom',
    }));
  });

  it('an empty id list is a no-op (no network call)', () => {
    useStore.getState().markSubmissionNotificationsRead([]);
    expect(markMany).not.toHaveBeenCalled();
  });

  it('contrast: the single-id action silently skips an id not yet in the feed', () => {
    useStore.setState({ submissionNotifications: [], submissionUnreadCount: 1 });
    useStore.getState().markSubmissionNotificationRead('not-yet-loaded');
    expect(markOne).not.toHaveBeenCalled();
  });
});
