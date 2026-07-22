// src/screens/staff/components/AppReloadButton.test.tsx — owner request
// 2026-07-22.
//
// The ⟳ Refresh button in every in-store header hard-reloads the PWA so staff
// pick up new deploys / fresh data without closing and reopening the app.

// AppReloadButton is web-only (location.reload has no native equivalent).
// Force Platform.OS = 'web' so both jest projects exercise the web branch.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

import { fireEvent, render } from '@testing-library/react-native';
import { AppReloadButton } from './AppReloadButton';

describe('AppReloadButton', () => {
  it('renders the Refresh label and hard-reloads on press', () => {
    const reload = jest.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      const { getByTestId, getByText } = render(<AppReloadButton />);
      // The default en catalog value for chrome.refreshApp.label.
      expect(getByText('Refresh')).toBeTruthy();

      fireEvent.press(getByTestId('staff-app-reload'));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });
});
