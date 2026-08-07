// src/components/cmd/SessionLostBanner.test.tsx — Spec 152 (AC-8).
//
// The banner is the only honest signal on the phone tier (its top app bar has
// no connection indicator, spec 142), so its render gate and its two actions
// are pinned here.
//
// Mocking shape follows NotificationBlockedBanner's neighbours: stub the theme
// + useT boundary and drive a hand-rolled store mock, so nothing drags in the
// supabase client at module-eval.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    panel2: '#EAEAEA',
    border: '#CCCCCC',
    borderStrong: '#888888',
    danger: '#791F1F',
    accent: '#185FA5',
    fg: '#000000',
    fg2: '#444444',
    fg3: '#888888',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

jest.mock('../../store/useStore', () => {
  const state: any = {
    sessionLost: false,
    dismissSessionLost: jest.fn(),
    handleSessionLost: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SessionLostBanner } from './SessionLostBanner';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const state = (require('../../store/useStore') as { useStore: { __state: any } }).useStore.__state;

beforeEach(() => {
  jest.clearAllMocks();
  state.sessionLost = false;
});

describe('SessionLostBanner (Spec 152)', () => {
  test('renders nothing while the session is healthy', () => {
    render(<SessionLostBanner />);
    expect(screen.queryByTestId('session-lost-banner')).toBeNull();
  });

  test('renders the stale-data copy when a load bailed on a missing session', () => {
    state.sessionLost = true;
    render(<SessionLostBanner />);

    expect(screen.getByTestId('session-lost-banner')).toBeTruthy();
    // useT is identity-mocked, so the keys are the rendered strings.
    expect(screen.getByText('chrome.sessionBanner.title')).toBeTruthy();
    expect(screen.getByText('chrome.sessionBanner.body')).toBeTruthy();
  });

  test('Sign in tears the dead session down (bounces to the sign-in portal)', () => {
    state.sessionLost = true;
    render(<SessionLostBanner />);

    fireEvent.press(screen.getByTestId('session-lost-banner-signin'));

    expect(state.handleSessionLost).toHaveBeenCalledTimes(1);
    expect(state.dismissSessionLost).not.toHaveBeenCalled();
  });

  test('dismiss only hides the row — it does NOT sign the user out', () => {
    state.sessionLost = true;
    render(<SessionLostBanner />);

    fireEvent.press(screen.getByTestId('session-lost-banner-dismiss'));

    expect(state.dismissSessionLost).toHaveBeenCalledTimes(1);
    expect(state.handleSessionLost).not.toHaveBeenCalled();
  });
});
