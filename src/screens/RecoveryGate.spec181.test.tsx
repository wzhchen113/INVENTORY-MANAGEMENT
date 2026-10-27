// src/screens/RecoveryGate.spec181.test.tsx — Spec 181 (security M1).
//
// Pins that the boot-time recovery gate (src/navigation/RecoveryGate.tsx) has
// NO native deep-link handler. Spec 181 added `scheme: "imr"`; a live native
// handler would let a crafted `imr://x?token_hash=…&type=recovery` link
// auto-redeem in RecoveryScreen and swap the signed-in session. On native the
// gate must never read Linking and must always render `children`. The web
// branch (synchronous window.location read + URL scrub) is unchanged and still
// renders RecoveryScreen for a recovery URL.
//
// Lives under src/screens/ (not src/navigation/) because the jsdom component
// project's testMatch only covers src/screens/** and src/components/**.

import React from 'react';
import { Platform, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

// expo-linking: a recovery-shaped URL is available from BOTH entry points, so
// if a native handler were ever re-added it would reach RecoveryScreen.
const RECOVERY_DEEP_LINK = 'imr://x?token_hash=attacker-hash&type=recovery';
let mockUrlListener: ((e: { url: string }) => void) | null = null;
const mockGetInitialURL = jest.fn(() => Promise.resolve(RECOVERY_DEEP_LINK));
const mockAddEventListener = jest.fn((_type: string, cb: (e: { url: string }) => void) => {
  mockUrlListener = cb;
  return { remove: jest.fn() };
});
jest.mock('expo-linking', () => ({
  __esModule: true,
  getInitialURL: () => mockGetInitialURL(),
  addEventListener: (type: string, cb: (e: { url: string }) => void) =>
    mockAddEventListener(type, cb),
}));

// RecoveryScreen is replaced by a marker so the test exercises only the gate's
// branch decision (RecoveryScreen's own behaviour is RecoveryScreen.test.tsx).
jest.mock('./RecoveryScreen', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ parse }: { parse: { kind: string } }) => (
      <MockText testID="recovery-screen">{parse.kind}</MockText>
    ),
  };
});

import RecoveryGate from '../navigation/RecoveryGate';

const ORIGINAL_OS = Platform.OS;
function setPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function renderGate() {
  return render(
    <RecoveryGate>
      <Text testID="app-shell">shell</Text>
    </RecoveryGate>,
  );
}

// Let any pending getInitialURL promise + state update flush.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUrlListener = null;
});

afterEach(() => {
  setPlatform(ORIGINAL_OS);
  window.history.replaceState({}, '', '/');
});

describe.each(['ios', 'android'] as const)('RecoveryGate on %s (spec 181 M1)', (os) => {
  beforeEach(() => setPlatform(os));

  it('never reads the initial URL or subscribes to url events', async () => {
    renderGate();
    await flush();
    expect(mockGetInitialURL).not.toHaveBeenCalled();
    expect(mockAddEventListener).not.toHaveBeenCalled();
  });

  it('a recovery link from getInitialURL (cold start) still renders children, not RecoveryScreen', async () => {
    const { getByTestId, queryByTestId } = renderGate();
    await flush();
    expect(getByTestId('app-shell')).toBeTruthy();
    expect(queryByTestId('recovery-screen')).toBeNull();
  });

  it('a recovery link from a url event (warm link) still renders children, not RecoveryScreen', async () => {
    const { getByTestId, queryByTestId } = renderGate();
    await flush();
    // No listener was registered; if one ever is, deliver the link through it
    // so this assertion still guards the render branch.
    if (mockUrlListener) {
      const listener = mockUrlListener;
      act(() => listener({ url: RECOVERY_DEEP_LINK }));
    }
    expect(mockUrlListener).toBeNull();
    expect(getByTestId('app-shell')).toBeTruthy();
    expect(queryByTestId('recovery-screen')).toBeNull();
  });
});

describe('RecoveryGate on web (unchanged behaviour)', () => {
  beforeEach(() => setPlatform('web'));

  it('a token_hash recovery URL renders RecoveryScreen and scrubs the URL', async () => {
    window.history.replaceState({}, '', '/reset-password?token_hash=hash-xyz&type=recovery');
    const { getByTestId, queryByTestId } = renderGate();
    expect(getByTestId('recovery-screen').props.children).toBe('recovery-token-hash');
    expect(queryByTestId('app-shell')).toBeNull();
    await flush();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/reset-password');
    // The web path is a synchronous window.location read, never expo-linking.
    expect(mockGetInitialURL).not.toHaveBeenCalled();
    expect(mockAddEventListener).not.toHaveBeenCalled();
  });

  it('an otp_expired error fragment renders RecoveryScreen in the error state', () => {
    window.history.replaceState(
      {},
      '',
      '/reset-password#error=access_denied&error_code=otp_expired&error_description=expired',
    );
    const { getByTestId } = renderGate();
    expect(getByTestId('recovery-screen').props.children).toBe('error');
  });

  it('a non-recovery URL renders children', () => {
    window.history.replaceState({}, '', '/');
    const { getByTestId, queryByTestId } = renderGate();
    expect(getByTestId('app-shell')).toBeTruthy();
    expect(queryByTestId('recovery-screen')).toBeNull();
  });
});
