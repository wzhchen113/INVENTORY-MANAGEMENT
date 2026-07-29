// src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx
//
// Spec 148 — the phone notifications sheet (README §20). Pins the pure
// `sectionForNotification` deep-link map, the badge-color rule (danger red ONLY
// while an unread missed_eod exists, else accent — spec 121), the feed rows +
// unread dots, the tap → mark-read + section deep-link, and MARK ALL READ.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

// Controllable push-toggle model (footer). No live push probe in the test.
jest.mock('../../../../../lib/useNotificationToggle', () => ({
  useNotificationToggle: () => ({
    isOn: false, interactive: true, aria: 'Notifications', onPress: jest.fn(),
    onRetry: jest.fn(), body: null, iosSteps: null, showRetry: false,
    label: 'Notifications', stateText: 'Off', view: 'off', busy: false, retryLabel: 'Retry',
  }),
}));

import { PhoneNotifications, sectionForNotification } from '../PhoneNotifications';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import { LightCmd } from '../../../../../theme/colors';
import type { AdminNotification } from '../../../../../types';

const markRead = jest.fn();
const markAllRead = jest.fn();

function notif(over: Partial<AdminNotification>): AdminNotification {
  return {
    id: 'n', brandId: 'b', storeId: 's', actorUserId: null, actorName: 'Cook',
    storeName: 'Frederick', type: 'eod', sourceId: 'x',
    createdAt: new Date().toISOString(), read: false, ...over,
  };
}

function seed(rows: AdminNotification[], unread: number) {
  useStore.setState({
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    submissionNotifications: rows,
    submissionUnreadCount: unread,
    markSubmissionNotificationRead: markRead,
    markAllSubmissionNotificationsRead: markAllRead,
    darkMode: false,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
});

describe('sectionForNotification (deep-link map)', () => {
  it('routes each type to its owning section, issue → null', () => {
    expect(sectionForNotification('missed_eod')).toBe('EODCount');
    expect(sectionForNotification('eod')).toBe('EODCount');
    expect(sectionForNotification('weekly')).toBe('InventoryCount');
    expect(sectionForNotification('waste')).toBe('WasteLog');
    expect(sectionForNotification('po')).toBe('Ordering');
    expect(sectionForNotification('receiving')).toBe('Ordering');
    expect(sectionForNotification('issue')).toBeNull();
  });
});

describe('badge-color rule (spec 121)', () => {
  it('is danger red when an unread missed_eod exists', () => {
    seed([notif({ id: 'm1', type: 'missed_eod', actorName: 'Produce', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    expect(getByTestId('phone-notif-badge').props.style.backgroundColor).toBe(LightCmd.danger);
  });

  it('is the accent when the unread set is submission-only (no missed)', () => {
    seed([notif({ id: 'e1', type: 'eod', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    expect(getByTestId('phone-notif-badge').props.style.backgroundColor).toBe(LightCmd.accent);
  });

  it('stays accent once the missed row is read', () => {
    seed([notif({ id: 'm1', type: 'missed_eod', read: true }), notif({ id: 'e1', type: 'eod', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    expect(getByTestId('phone-notif-badge').props.style.backgroundColor).toBe(LightCmd.accent);
  });
});

describe('feed sheet', () => {
  it('opens on the bell and lists rows; tapping deep-links + marks read', () => {
    seed([notif({ id: 'm1', type: 'missed_eod', actorName: 'Produce', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    fireEvent.press(getByTestId('phone-notif-bell'));
    fireEvent.press(getByTestId('phone-notif-row-m1'));
    expect(markRead).toHaveBeenCalledWith('m1');
    expect(usePaletteAction.getState().pending?.section).toBe('EODCount');
  });

  it('MARK ALL READ calls the store action', () => {
    seed([notif({ id: 'e1', type: 'eod', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    fireEvent.press(getByTestId('phone-notif-bell'));
    fireEvent.press(getByTestId('phone-notif-mark-all'));
    expect(markAllRead).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state when the feed is empty', () => {
    seed([], 0);
    const { getByTestId, queryByTestId, getByText } = render(<PhoneNotifications />);
    // No badge when unread is 0.
    expect(queryByTestId('phone-notif-badge')).toBeNull();
    fireEvent.press(getByTestId('phone-notif-bell'));
    expect(getByText('No submissions yet.')).toBeTruthy();
  });

  it('an issue row does not deep-link (mark-read only)', () => {
    seed([notif({ id: 'i1', type: 'issue', body: 'Freezer down', read: false })], 1);
    const { getByTestId } = render(<PhoneNotifications />);
    fireEvent.press(getByTestId('phone-notif-bell'));
    fireEvent.press(getByTestId('phone-notif-row-i1'));
    expect(markRead).toHaveBeenCalledWith('i1');
    expect(usePaletteAction.getState().pending).toBeNull();
  });
});
