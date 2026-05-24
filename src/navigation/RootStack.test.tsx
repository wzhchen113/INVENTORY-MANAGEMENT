// src/navigation/RootStack.test.tsx — cold-start gate behavior.
//
// Spec 062 §B3 / §2 (AC1.5): on app launch with a persisted session,
// re-run the role + user_stores gate. If the gate fails (user demoted
// from 'user' role, or all stores unassigned), the app MUST surface an
// error toast — not silently redirect to SignIn.
//
// This test covers the Critical fix from cycle-1 code review: prior to
// the fix, RootStack only wrote `authState.toast` (a raw i18n key
// string), but no consumer read that field — so a non-staff user
// returning to the app got a silent SignIn screen with zero context.

import { render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

// ─── Mock react-native-toast-message before importing the screen ───
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// ─── Mock @react-navigation/native so the navigator doesn't try to
//     mount a real stack (we only care that the gate logic transitions
//     state + fires Toast.show). The NavigationContainer becomes a
//     transparent wrapper. ────────────────────────────────────────────
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

jest.mock('@react-navigation/stack', () => {
  const React = require('react');
  function createStackNavigator() {
    function Screen() {
      return null;
    }
    function Navigator({ children }: { children: React.ReactNode }) {
      return React.createElement(React.Fragment, null, children);
    }
    return { Screen, Navigator };
  }
  return { createStackNavigator };
});

// ─── Mock the screen children so we don't pull in their own
//     supabase.from calls; the gate runs at the RootStack layer. ──────
jest.mock('../screens/SignIn', () => ({ SignIn: () => null }));
jest.mock('../screens/StorePicker', () => ({ StorePicker: () => null }));
jest.mock('../screens/EODCount', () => ({ EODCount: () => null }));

// ─── Mock supabase. We control getSession + from() outcomes per test ──
const mockGetSession = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn();

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      signOut: () => mockSignOut(),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// Mock the eodQueue helpers used by the cold-start path.
jest.mock('../lib/eodQueue', () => ({
  readActiveStoreId: jest.fn().mockResolvedValue(null),
  writeActiveStoreId: jest.fn().mockResolvedValue(undefined),
}));

import { RootStack } from './RootStack';
import { useStore } from '../store/useStore';

function makeFromResponse(data: unknown, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: () => Promise.resolve({ data, error }),
    // thenable for queries that don't call .maybeSingle()
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data, error }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    authState: { kind: 'idle' },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

describe('RootStack — cold-start gate (AC1.5)', () => {
  it('signs out and toasts when a stored session belongs to a non-staff user', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'admin-user' } } },
      error: null,
    });
    mockFrom.mockImplementationOnce(() =>
      // profiles.role !== 'user' → 'not-staff' gate failure
      makeFromResponse({ role: 'admin' }),
    );

    render(<RootStack />);

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    // Toast surfaced with the translated 'staff only' message.
    const showCalls = (Toast.show as jest.Mock).mock.calls;
    expect(showCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = showCalls[showCalls.length - 1][0];
    expect(lastCall.text1).toMatch(/staff only/i);
    expect(lastCall.type).toBe('error');
    // Transitioned to signed-out.
    expect(useStore.getState().authState.kind).toBe('signed-out');
  });

  it('signs out and toasts when a stored session has zero user_stores rows', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'orphan-user' } } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() => makeFromResponse({ role: 'user' }))
      .mockImplementationOnce(() => makeFromResponse([]));

    render(<RootStack />);

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    const showCalls = (Toast.show as jest.Mock).mock.calls;
    expect(showCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = showCalls[showCalls.length - 1][0];
    expect(lastCall.text1).toMatch(/No store assignments/i);
    expect(useStore.getState().authState.kind).toBe('signed-out');
  });

  it('stays silent (no toast) when there is no stored session — clean cold start', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    render(<RootStack />);

    await waitFor(() =>
      expect(useStore.getState().authState.kind).toBe('signed-out'),
    );
    // No-session is the expected initial state for a fresh device — we
    // should NOT spam a toast.
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('transitions to signed-in when the cold-start gate passes', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'staff-1' } } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() => makeFromResponse({ role: 'user' }))
      .mockImplementationOnce(() =>
        makeFromResponse([
          { store_id: 's-1', store: { id: 's-1', name: 'Frederick' } },
        ]),
      );

    render(<RootStack />);

    await waitFor(() =>
      expect(useStore.getState().authState.kind).toBe('signed-in'),
    );
    expect(mockSignOut).not.toHaveBeenCalled();
    // Single-store auto-select.
    expect(useStore.getState().activeStore).toEqual({
      id: 's-1',
      name: 'Frederick',
    });
  });
});
