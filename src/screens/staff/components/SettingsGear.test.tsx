// src/screens/staff/components/SettingsGear.test.tsx — spec 126.
//
// The gear in every in-store header navigates to the Settings screen.

import { fireEvent, render } from '@testing-library/react-native';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

import { SettingsGear } from './SettingsGear';

beforeEach(() => {
  mockNavigate.mockReset();
});

describe('SettingsGear', () => {
  it('navigates to the Settings screen on press', () => {
    const { getByTestId } = render(<SettingsGear />);
    fireEvent.press(getByTestId('staff-settings-gear'));
    expect(mockNavigate).toHaveBeenCalledWith('Settings');
  });

  it('exposes an accessibility label', () => {
    const { getByTestId } = render(<SettingsGear />);
    // The default en catalog value for chrome.settings.gearAria.
    expect(getByTestId('staff-settings-gear').props.accessibilityLabel).toBe('Open settings');
  });
});
