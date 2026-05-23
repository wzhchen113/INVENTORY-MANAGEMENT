// src/hooks/useConnectionStatus.test.ts — Spec 057.
//
// Unit test for the connection-status polling hook extracted from
// `TitleBar.tsx`. The hook IS the codified `lib/supabase` boundary —
// per spec 057 §5a and the hybrid-mocking rule, this test MAY mock
// `lib/supabase` directly even though component tests below this
// boundary must not.
//
// Strategy: jest.useFakeTimers() to drive the 2000ms poll
// deterministically; the mocked `supabase.realtime.channels` array is
// mutable, so tests mutate it between ticks and advance the timer to
// flush the hook's `setConnected`. Mirrors the `inflight.test.ts`
// pattern.

// ─── Mocks (must precede any hook import) ──────────────────────────────

// Force Platform.OS = 'web' for the bulk of the suite. Spec 057 pass-2
// gated the hook's `useEffect` side-effect on `Platform.OS === 'web'`
// (see the native-bail describe block below for that branch). The
// jest-expo unit-project default haste platform is `ios`, so without
// this override the hook's effect would bail and every "polling fires"
// assertion below would fail. The native-bail test flips this back to
// `ios` in an isolated module scope.
jest.mock('react-native', () => ({
  __esModule: true,
  Platform: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
}));

// The mocked `supabase.realtime.channels` array is mutable; each test
// assigns it via the `setChannels` helper below. The mock factory is
// hoisted by jest, so the array reference must live inside the factory
// — we expose it through a getter so the test body can swap the array
// at will.
jest.mock('../lib/supabase', () => {
  const state: { channels: { state: string }[] } = { channels: [] };
  return {
    __esModule: true,
    supabase: {
      realtime: state,
    },
    // Test-only escape hatch — NOT part of the production export.
    __setChannels(next: { state: string }[]) {
      state.channels = next;
    },
  };
});

import { act, renderHook } from '@testing-library/react-native';
import { useConnectionStatus } from './useConnectionStatus';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __setChannels } = require('../lib/supabase') as {
  __setChannels: (next: { state: string }[]) => void;
};

beforeEach(() => {
  jest.useFakeTimers();
  __setChannels([]);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── empty channels → optimistic true ──────────────────────────────────

describe('useConnectionStatus — empty-channels branch', () => {
  test('returns true on initial mount with no channels', () => {
    const { result } = renderHook(() => useConnectionStatus());
    // The hook's initial useState is true; the synchronous initial
    // tick after setInterval also yields true (empty array branch).
    expect(result.current).toBe(true);
  });

  test('stays true across ticks while channels stay empty', () => {
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current).toBe(true);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current).toBe(true);
  });
});

// ─── healthy states (single channel) ───────────────────────────────────

describe('useConnectionStatus — healthy single-channel states', () => {
  test("returns true when the only channel is in state 'joined'", () => {
    __setChannels([{ state: 'joined' }]);
    const { result } = renderHook(() => useConnectionStatus());
    // Initial tick fires synchronously after setInterval; flush any
    // pending state updates by advancing 0ms.
    expect(result.current).toBe(true);
  });

  test("returns true when the only channel is in state 'subscribed'", () => {
    __setChannels([{ state: 'subscribed' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
  });
});

// ─── unhealthy states (single channel) ─────────────────────────────────

describe('useConnectionStatus — unhealthy single-channel states', () => {
  test("returns false when the only channel is in state 'closed'", () => {
    __setChannels([{ state: 'closed' }]);
    const { result } = renderHook(() => useConnectionStatus());
    // The initial useState(true) default is overwritten by the
    // synchronous initial tick — which reads channels.length === 1
    // and falls into the .some() branch, yielding false.
    expect(result.current).toBe(false);
  });

  test("returns false when the only channel is in state 'errored'", () => {
    __setChannels([{ state: 'errored' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(false);
  });
});

// ─── mixed-state aggregation ───────────────────────────────────────────

describe('useConnectionStatus — mixed-state aggregation', () => {
  test("returns true when ANY channel is 'joined' (mixed with closed)", () => {
    __setChannels([{ state: 'joined' }, { state: 'closed' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
  });

  test("returns false when NO channel is in a healthy state", () => {
    __setChannels([{ state: 'closed' }, { state: 'errored' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(false);
  });
});

// ─── polling — picks up channel mutations between ticks ────────────────

describe('useConnectionStatus — polling picks up mutations', () => {
  test('flips false when the only channel transitions to closed', () => {
    __setChannels([{ state: 'joined' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    // Mutate the channel state — production code path mirrors the
    // realtime client mutating the same array reference. Our mock
    // swaps the array contents, which is equivalent for the hook's
    // poll because the hook re-reads `supabase.realtime.channels` on
    // every tick.
    __setChannels([{ state: 'closed' }]);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current).toBe(false);
  });

  test('flips true when a previously-closed channel re-joins', () => {
    __setChannels([{ state: 'closed' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(false);

    __setChannels([{ state: 'joined' }]);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current).toBe(true);
  });

  test('cadence is exactly 2000ms (1999ms does not tick, 2000ms does)', () => {
    __setChannels([{ state: 'joined' }]);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    __setChannels([{ state: 'closed' }]);
    // One ms shy of the 2s threshold — the interval has not fired.
    act(() => { jest.advanceTimersByTime(1999); });
    expect(result.current).toBe(true);
    // Cross the threshold — the interval fires and flips the state.
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe(false);
  });
});

// ─── cleanup — clearInterval fires on unmount ──────────────────────────

describe('useConnectionStatus — cleanup', () => {
  test('clearInterval is called on unmount with the setInterval id', () => {
    // Spy BEFORE renderHook so the spy captures the setInterval id
    // the hook installs.
    const setSpy = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');

    const { unmount } = renderHook(() => useConnectionStatus());

    // The hook should have installed exactly one interval.
    expect(setSpy).toHaveBeenCalledTimes(1);
    // setInterval returns either a number (browser) or a Timeout
    // (node); we just need to verify clearInterval receives whatever
    // setInterval returned.
    const intervalId = setSpy.mock.results[0]?.value;
    expect(intervalId).toBeDefined();

    unmount();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith(intervalId);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  test('after unmount, advancing timers does not trigger further state reads', () => {
    __setChannels([{ state: 'joined' }]);
    const { result, unmount } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    unmount();

    // Flip channels to a failing state; if the interval were still
    // running it would re-trigger setConnected, but cleared intervals
    // are no-ops — and result.current reflects the last committed
    // render, which is still true.
    __setChannels([{ state: 'closed' }]);
    act(() => { jest.advanceTimersByTime(10000); });
    expect(result.current).toBe(true);
  });
});

// ─── native bail — setInterval skipped, optimistic default observed ────
//
// Spec 057 pass-2 (code-reviewer Critical): the hook MUST be callable
// unconditionally on every render so its position above the
// `Platform.OS !== 'web'` early return in TitleBar.tsx satisfies React's
// Rules of Hooks. The gate moved INSIDE the `useEffect` body — the
// `setInterval` is skipped entirely on iOS / Android so no resource
// leak, and the `useState(true)` default is the only value downstream
// consumers ever see on native.
//
// Implementation note: the file-level `jest.mock('react-native', ...)`
// pins `Platform.OS = 'web'` for the rest of the suite. Mutating the
// already-imported `Platform.OS` property in-place here flips the gate
// to native; we restore the original value in a `finally` to keep the
// other describe blocks unaffected even if `renderHook` throws.

describe('useConnectionStatus — native platform bail', () => {
  test('does NOT call setInterval on native and returns the optimistic default', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as { Platform: { OS: string } };
    const originalOS = Platform.OS;
    Platform.OS = 'ios';

    const setSpy = jest.spyOn(global, 'setInterval');

    try {
      // Channels intentionally populated with an unhealthy state — if
      // the native bail were broken and the poller ran, `result.current`
      // would flip to `false`. The optimistic `true` default proves the
      // effect bailed before scheduling the interval.
      __setChannels([{ state: 'closed' }]);

      const { result, unmount } = renderHook(() => useConnectionStatus());

      // setInterval must NOT have been called from the hook on native.
      expect(setSpy).not.toHaveBeenCalled();
      // The optimistic default (`useState(true)`) is what callers see.
      expect(result.current).toBe(true);

      // Advancing the fake timer beyond the 2s cadence must not flip
      // the state — there's no interval to fire.
      act(() => { jest.advanceTimersByTime(10000); });
      expect(result.current).toBe(true);

      unmount();
    } finally {
      Platform.OS = originalOS;
      setSpy.mockRestore();
    }
  });
});
