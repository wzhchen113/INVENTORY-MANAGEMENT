// src/components/cmd/RefreshButton.test.tsx — owner request 2026-07-22.
//
// Verifies the chrome refresh pill:
//   - renders on web with the i18n label + aria
//   - press calls window.location.reload() exactly once
//
// Mocking strategy follows LoadingBar.test.tsx (Hybrid mocking — mock the
// theme + i18n boundaries so the import chain never reaches the store/supabase
// layer at module-eval).

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    border: '#CCCCCC',
    panel2: '#EAEAEA',
    fg2: '#444444',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { RefreshButton } from './RefreshButton';

describe('RefreshButton (chrome refresh pill)', () => {
  it('renders on web and hard-reloads on press', () => {
    // jsdom's window.location.reload is non-configurable in place — swap the
    // whole location object for a spy-bearing stand-in.
    const reload = jest.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(<RefreshButton />);

      const btn = screen.getByTestId('chrome-refresh-app');
      expect(btn.props.accessibilityLabel).toBe('chrome.refreshApp.aria');
      expect(screen.getByText('chrome.refreshApp.label')).toBeTruthy();

      fireEvent.press(btn);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });
});
