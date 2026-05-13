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
