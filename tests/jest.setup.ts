// tests/jest.setup.ts — global jest setup for Spec 022.
//
// Per the architect's design (spec 022 §2): mock the fired-and-forgotten
// Toast surface and AsyncStorage at the global level so component tests
// don't crash trying to mount the native Toast container or hit a missing
// storage backend.
//
// Deliberately NOT mocked here:
//   - `src/lib/supabase.ts` — the wrong boundary (re-implementing every
//     Supabase client method as a stub is the architect's anti-pattern).
//   - `src/lib/db.ts` — per-test files decide whether to stub at this
//     boundary (component tests) or hit the real local stack (Track 2,
//     which uses SQL files under supabase/tests/, not jest at all).
//
// If a new test needs a different global stub (e.g. Sentry, expo-notifications)
// the rule is: add it here ONLY when at least two test files need the same
// stub. One-off stubs belong in the test file's own `jest.mock(...)` call.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: {
    show: jest.fn(),
    hide: jest.fn(),
  },
  show: jest.fn(),
  hide: jest.fn(),
}));

jest.mock(
  '@react-native-async-storage/async-storage',
  () =>
    // The package ships an official jest mock; prefer it over a hand-rolled
    // stub so we get a working in-memory KV pair semantic, not just no-ops.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Spec 063 — mocks merged in from imr-staff/jest.setup.js so the staff
// EOD count tests (now under src/screens/staff/) keep their behavior
// post-merge.

// NetInfo — used by the staff app's useConnectionStatus hook on native.
// Hand-rolled stubs match what imr-staff shipped.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => () => {}),
    fetch: jest.fn(() =>
      Promise.resolve({ isConnected: true, isInternetReachable: true }),
    ),
  },
}));

// react-native-safe-area-context — needed by EODCount which mounts
// SafeAreaView. Returns a plain provider in tests.
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
      React.createElement('SafeAreaView', props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// Deterministic randomUUID for the staff EOD queue tests (spec 062 — the
// queue's client_uuid is the dedupe key, so the test snapshots compare
// stable UUIDs). Admin tests rely on supabase mocks rather than the
// global crypto, so this override is safe globally.
const _g = globalThis as { crypto?: { randomUUID?: () => string } };
if (!_g.crypto) _g.crypto = {};
let _uuidCounter = 0;
_g.crypto.randomUUID = jest.fn(() => {
  _uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(_uuidCounter).padStart(12, '0')}`;
});
