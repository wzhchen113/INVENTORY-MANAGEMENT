// src/screens/staff/components/SettingsGear.test.tsx — spec 126.
//
// The gear in every in-store header navigates to the Settings screen, renders
// a "Settings" label, and shows a red dot when notifications are OFF but
// actionable (spec 126 follow-up).

import { fireEvent, render } from '@testing-library/react-native';
import type { NotificationView } from '../../../lib/notificationState';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// Drive the notification view through the shared hook mock.
let mockView: NotificationView = 'on';
jest.mock('../../../lib/useNotificationToggle', () => ({
  useNotificationToggle: () => ({ view: mockView }),
}));

// The store selector just needs to return a stable user id.
jest.mock('../store/useStaffStore', () => ({
  currentStaffUserId: () => 'user-1',
  useStaffStore: (selector: (s: unknown) => unknown) =>
    selector({ authState: {} }),
}));

import { SettingsGear } from './SettingsGear';

beforeEach(() => {
  mockNavigate.mockReset();
  mockView = 'on';
});

describe('SettingsGear', () => {
  it('navigates to the Settings screen on press', () => {
    const { getByTestId } = render(<SettingsGear />);
    fireEvent.press(getByTestId('staff-settings-gear'));
    expect(mockNavigate).toHaveBeenCalledWith('Settings');
  });

  it('renders the Settings label', () => {
    const { getByText } = render(<SettingsGear />);
    // The default en catalog value for chrome.settings.gearLabel.
    expect(getByText('Settings')).toBeTruthy();
  });

  it('exposes an accessibility label when notifications are on', () => {
    mockView = 'on';
    const { getByTestId } = render(<SettingsGear />);
    // The default en catalog value for chrome.settings.gearAria.
    expect(getByTestId('staff-settings-gear').props.accessibilityLabel).toBe('Open settings');
  });

  it('shows the red dot when notifications are off', () => {
    mockView = 'off';
    const { getByTestId } = render(<SettingsGear />);
    expect(getByTestId('staff-settings-notif-dot')).toBeTruthy();
    // The aria switches to the "notifications off" variant.
    expect(getByTestId('staff-settings-gear').props.accessibilityLabel).toBe(
      'Settings — notifications off',
    );
  });

  it('shows the red dot when notifications need iOS install', () => {
    mockView = 'needs-install';
    const { getByTestId } = render(<SettingsGear />);
    expect(getByTestId('staff-settings-notif-dot')).toBeTruthy();
  });

  it('hides the red dot when notifications are on', () => {
    mockView = 'on';
    const { queryByTestId } = render(<SettingsGear />);
    expect(queryByTestId('staff-settings-notif-dot')).toBeNull();
  });

  it('hides the red dot when notifications are unsupported', () => {
    mockView = 'unsupported';
    const { queryByTestId } = render(<SettingsGear />);
    expect(queryByTestId('staff-settings-notif-dot')).toBeNull();
  });
});
