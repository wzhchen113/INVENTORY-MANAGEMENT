// src/screens/staff/components/NotificationReminderBanner.test.tsx — spec 126
// follow-up.
//
// The persistent in-store nudge renders IFF the shared notificationLevel is
// 'off', shows the reminder copy, and jumps to Settings on press. It renders
// nothing for the GREEN ('on') and neutral ('na') levels.

import { fireEvent, render } from '@testing-library/react-native';
import type { NotificationView } from '../../../lib/notificationState';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// Drive the notification view through the shared hook mock.
let mockView: NotificationView = 'off';
jest.mock('../../../lib/useNotificationToggle', () => ({
  useNotificationToggle: () => ({ view: mockView }),
}));

jest.mock('../store/useStaffStore', () => ({
  currentStaffUserId: () => 'user-1',
  useStaffStore: (selector: (s: unknown) => unknown) =>
    selector({ authState: {} }),
}));

import { NotificationReminderBanner } from './NotificationReminderBanner';

beforeEach(() => {
  mockNavigate.mockReset();
  mockView = 'off';
});

describe('NotificationReminderBanner', () => {
  it('renders the reminder copy when level is off', () => {
    mockView = 'off';
    const { getByText, getByTestId } = render(<NotificationReminderBanner />);
    // The default en catalog value for chrome.notifications.reminderBanner.
    expect(getByText('Turn on notifications to get reminders')).toBeTruthy();
    expect(getByTestId('staff-notif-reminder-banner')).toBeTruthy();
  });

  it('navigates to Settings on press', () => {
    mockView = 'off';
    const { getByTestId } = render(<NotificationReminderBanner />);
    fireEvent.press(getByTestId('staff-notif-reminder-banner'));
    expect(mockNavigate).toHaveBeenCalledWith('Settings');
  });

  it('renders the off-level banner for needs-install and denied too', () => {
    for (const v of ['needs-install', 'denied'] as NotificationView[]) {
      mockView = v;
      const { queryByTestId } = render(<NotificationReminderBanner />);
      expect(queryByTestId('staff-notif-reminder-banner')).toBeTruthy();
    }
  });

  it('renders nothing when notifications are on', () => {
    mockView = 'on';
    const { queryByTestId } = render(<NotificationReminderBanner />);
    expect(queryByTestId('staff-notif-reminder-banner')).toBeNull();
  });

  it('renders nothing when notifications are unsupported', () => {
    mockView = 'unsupported';
    const { queryByTestId } = render(<NotificationReminderBanner />);
    expect(queryByTestId('staff-notif-reminder-banner')).toBeNull();
  });

  it('renders nothing when notifications errored', () => {
    mockView = 'error';
    const { queryByTestId } = render(<NotificationReminderBanner />);
    expect(queryByTestId('staff-notif-reminder-banner')).toBeNull();
  });
});
