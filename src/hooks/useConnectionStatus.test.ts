// src/hooks/useConnectionStatus.test.ts — Spec 059.
//
// Unit tests for the EVENT-DRIVEN connection-status hook. The spec 057
// poll-based shape (setInterval(2000) + mutating
// `supabase.realtime.channels`) has been replaced with subscriptions to
// the underlying Phoenix Socket's onOpen / onClose / onError callbacks.
// The hook IS the codified `lib/supabase` boundary — per spec 057 §5a
// and the hybrid-mocking rule, this test MAY mock `lib/supabase`
// directly even though component tests below this boundary must not.
//
// Strategy: mock `lib/supabase` with an event-emitter shape — each
// `onOpen` / `onClose` / `onError` mock stores the callback and returns
// a unique ref string; `off(refs)` filters the captured handlers. Tests
// dispatch events by manually invoking the captured callbacks inside
// `act()`; the hook's setState flips synchronously because no real
// timer is in the loop. Mirrors the `inflight.test.ts` act() pattern.

// ─── Mocks (must precede any hook import) ──────────────────────────────

// Force Platform.OS = 'web' for the bulk of the suite. The hook's
// `useEffect` body bails on native; the native-bail describe block
// flips this back to `ios` in an isolated scope (spec 058 alignment).
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

// Event-emitter mock shape (spec 059 §8a). Replaces the spec 057
// `__setChannels` helper. The mock factory is hoisted by jest, so all
// captured state lives inside the factory closure — exposed through
// `__getCapturedHandlers` / `__setInitialConnected` / `__getOffSpy`
// for the test body.
jest.mock('../lib/supabase', () => {
  let nextRefId = 1;
  const handlers: { open: Function[]; close: Function[]; error: Function[] } = {
    open: [],
    close: [],
    error: [],
  };
  // refMap is used by `off(refs)` to remove a specific registration
  // by its ref string. Storing { kind, cb } makes the filter cheap.
  const refMap = new Map<string, { kind: 'open' | 'close' | 'error'; cb: Function }>();

  // Default initial-seed state — `connectionState: 'connecting'`
  // biases the hook's seed rule toward optimistic-true. Tests that
  // need a different seed call `__setInitialConnected(opts)` BEFORE
  // calling `renderHook`.
  const seedState: { isConnected: boolean; connectionState: string } = {
    isConnected: false,
    connectionState: 'connecting',
  };

  const offSpy = jest.fn((refs: string[]) => {
    for (const ref of refs) {
      const entry = refMap.get(ref);
      if (!entry) continue;
      const arr = handlers[entry.kind];
      const idx = arr.indexOf(entry.cb);
      if (idx >= 0) arr.splice(idx, 1);
      refMap.delete(ref);
    }
  });

  const onOpenSpy = jest.fn((cb: Function) => {
    const ref = String(nextRefId++);
    handlers.open.push(cb);
    refMap.set(ref, { kind: 'open', cb });
    return ref;
  });
  const onCloseSpy = jest.fn((cb: Function) => {
    const ref = String(nextRefId++);
    handlers.close.push(cb);
    refMap.set(ref, { kind: 'close', cb });
    return ref;
  });
  const onErrorSpy = jest.fn((cb: Function) => {
    const ref = String(nextRefId++);
    handlers.error.push(cb);
    refMap.set(ref, { kind: 'error', cb });
    return ref;
  });

  const socket = {
    onOpen: onOpenSpy,
    onClose: onCloseSpy,
    onError: onErrorSpy,
    off: offSpy,
  };

  const realtime = {
    isConnected: jest.fn(() => seedState.isConnected),
    connectionState: jest.fn(() => seedState.connectionState),
    socketAdapter: {
      getSocket: jest.fn(() => socket),
    },
  };

  return {
    __esModule: true,
    supabase: { realtime },
    // Test-only escape hatches — NOT part of the production export.
    __getCapturedHandlers() {
      return handlers;
    },
    __setInitialConnected(opts: { isConnected?: boolean; connectionState?: string }) {
      if (typeof opts.isConnected === 'boolean') seedState.isConnected = opts.isConnected;
      if (typeof opts.connectionState === 'string') seedState.connectionState = opts.connectionState;
    },
    __getOffSpy() {
      return offSpy;
    },
    __getOnOpenSpy() {
      return onOpenSpy;
    },
    __getOnCloseSpy() {
      return onCloseSpy;
    },
    __getOnErrorSpy() {
      return onErrorSpy;
    },
    __resetMock() {
      handlers.open.length = 0;
      handlers.close.length = 0;
      handlers.error.length = 0;
      refMap.clear();
      nextRefId = 1;
      seedState.isConnected = false;
      seedState.connectionState = 'connecting';
      offSpy.mockClear();
      onOpenSpy.mockClear();
      onCloseSpy.mockClear();
      onErrorSpy.mockClear();
    },
  };
});

import { act, renderHook } from '@testing-library/react-native';
import { useConnectionStatus } from './useConnectionStatus';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  __getCapturedHandlers,
  __setInitialConnected,
  __getOffSpy,
  __getOnOpenSpy,
  __getOnCloseSpy,
  __getOnErrorSpy,
  __resetMock,
} = require('../lib/supabase') as {
  __getCapturedHandlers(): { open: Function[]; close: Function[]; error: Function[] };
  __setInitialConnected(opts: { isConnected?: boolean; connectionState?: string }): void;
  __getOffSpy(): jest.Mock;
  __getOnOpenSpy(): jest.Mock;
  __getOnCloseSpy(): jest.Mock;
  __getOnErrorSpy(): jest.Mock;
  __resetMock(): void;
};

beforeEach(() => {
  __resetMock();
});

// ─── empty-channels rewrite — initial seed via connectionState ─────────
//
// Case 1: optimistic-true seed when socket reports
// `isConnected: false` + `connectionState: 'connecting'` (the normal
// startup state — socket is in-flight, indicator should be green).
//
// Case 2: open-state seed stays true with no events fired.

describe('useConnectionStatus — initial seed branch', () => {
  test("seed returns true on initial mount with isConnected=false + state='connecting'", () => {
    __setInitialConnected({ isConnected: false, connectionState: 'connecting' });
    const { result } = renderHook(() => useConnectionStatus());
    // The hook's useState lazy initializer reads connectionState ===
    // 'connecting' → biases optimistic-true. AC4 preserved.
    expect(result.current).toBe(true);
  });

  test("stays true across `act()` flushes when no event has fired", () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
    // Flush any pending React work — no events have been dispatched so
    // the value cannot have changed.
    act(() => {});
    expect(result.current).toBe(true);
    act(() => {});
    expect(result.current).toBe(true);
  });
});

// ─── healthy-state event dispatch ──────────────────────────────────────
//
// Case 3: onOpen → true (from seed)
// Case 4: onOpen after onClose → true (proves latch correctness)

describe('useConnectionStatus — onOpen flips connected to true', () => {
  test('dispatching captured onOpen callback flips connected to true', () => {
    __setInitialConnected({ isConnected: false, connectionState: 'closed' });
    const { result } = renderHook(() => useConnectionStatus());
    // Seed: connectionState='closed' → false.
    expect(result.current).toBe(false);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.open[0]();
    });
    expect(result.current).toBe(true);
  });

  test('onOpen fires after a prior onClose → flips back to true', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.close[0]();
    });
    expect(result.current).toBe(false);

    act(() => {
      handlers.open[0]();
    });
    expect(result.current).toBe(true);
  });
});

// ─── unhealthy-state event dispatch ────────────────────────────────────
//
// Case 5: onClose → false
// Case 6: onError → false

describe('useConnectionStatus — onClose / onError flip connected to false', () => {
  test('dispatching captured onClose callback flips connected to false', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.close[0]();
    });
    expect(result.current).toBe(false);
  });

  test('dispatching captured onError callback flips connected to false', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.error[0]();
    });
    expect(result.current).toBe(false);
  });
});

// ─── sequence/latch aggregation ────────────────────────────────────────
//
// Case 7: open → close → open (latches per-event correctly)
// Case 8: close → error (both map to false; no spurious flip)

describe('useConnectionStatus — sequence and latch', () => {
  test('open → close → open sequence latches correctly through each event', () => {
    __setInitialConnected({ isConnected: false, connectionState: 'closed' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(false);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.open[0]();
    });
    expect(result.current).toBe(true);

    act(() => {
      handlers.close[0]();
    });
    expect(result.current).toBe(false);

    act(() => {
      handlers.open[0]();
    });
    expect(result.current).toBe(true);
  });

  test('close → error sequence — both map to false (no spurious flip)', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.close[0]();
    });
    expect(result.current).toBe(false);

    act(() => {
      handlers.error[0]();
    });
    expect(result.current).toBe(false);
  });
});

// ─── synchronous flip — AC3 ────────────────────────────────────────────
//
// Case 9: onClose flips false synchronously inside act() (no
//         advanceTimers needed — proves the event-driven path doesn't
//         hide behind a polling boundary).
// Case 10: onOpen flips true synchronously inside act() from a
//          false seed.

describe('useConnectionStatus — synchronous flip inside act()', () => {
  test('onClose flips false in the same act() flush, no timer advancement', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    const handlers = __getCapturedHandlers();
    // Single act() — no jest.advanceTimersByTime call between the
    // dispatch and the assertion. AC3 invariant.
    act(() => {
      handlers.close[0]();
    });
    expect(result.current).toBe(false);
  });

  test('onOpen flips true in the same act() flush, no timer advancement', () => {
    __setInitialConnected({ isConnected: false, connectionState: 'closed' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(false);

    const handlers = __getCapturedHandlers();
    act(() => {
      handlers.open[0]();
    });
    expect(result.current).toBe(true);
  });
});

// ─── AC2: no setInterval anywhere in the hook ──────────────────────────
//
// Case 11 (rewritten): the new implementation must NEVER call
// `setInterval`. Spy on the global and assert zero calls — directly
// enforces AC2 at runtime, not just by grep.

describe('useConnectionStatus — AC2 no setInterval', () => {
  test('setInterval is never called by the hook (event-driven, not polled)', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      __setInitialConnected({ isConnected: true, connectionState: 'open' });
      const { unmount } = renderHook(() => useConnectionStatus());

      // The hook is purely event-driven — no timer-based scheduling.
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      unmount();

      // Even on unmount, no timer-based scheduling should appear.
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});

// ─── AC6: cleanup calls socket.off([refs]) once with all three refs ────
//
// Case 12 (rewritten): mount the hook → onOpen/onClose/onError each
// return a ref string → on unmount, `socket.off` is called exactly
// once with all three refs in the array.

describe('useConnectionStatus — AC6 cleanup', () => {
  test('socket.off is called once on unmount with all three captured refs', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });

    const { unmount } = renderHook(() => useConnectionStatus());

    // Three subscriptions installed on mount.
    expect(__getOnOpenSpy()).toHaveBeenCalledTimes(1);
    expect(__getOnCloseSpy()).toHaveBeenCalledTimes(1);
    expect(__getOnErrorSpy()).toHaveBeenCalledTimes(1);

    // Capture the refs returned by each of the three subscriptions —
    // these are the refs the hook collected internally.
    const openRef = __getOnOpenSpy().mock.results[0]?.value;
    const closeRef = __getOnCloseSpy().mock.results[0]?.value;
    const errorRef = __getOnErrorSpy().mock.results[0]?.value;
    expect(openRef).toBeDefined();
    expect(closeRef).toBeDefined();
    expect(errorRef).toBeDefined();

    // off() not yet called.
    expect(__getOffSpy()).not.toHaveBeenCalled();

    unmount();

    // Exactly once on unmount, called with the array of three refs in
    // the same order they were subscribed.
    expect(__getOffSpy()).toHaveBeenCalledTimes(1);
    expect(__getOffSpy()).toHaveBeenCalledWith([openRef, closeRef, errorRef]);
  });
});

// ─── post-unmount no-op ────────────────────────────────────────────────
//
// Case 13 (rewritten): after unmount, manually invoking a captured
// callback that the test still holds a reference to does not flip
// `result.current`. Two invariants exercised:
//   1. `socket.off` was called on unmount, so in real-world dispatch
//      the handler would no longer be in `stateChangeCallbacks`.
//   2. Even if a stale callback reference were somehow invoked, React
//      has unmounted the component — result.current is whatever it
//      was at the moment of unmount.

describe('useConnectionStatus — post-unmount no-op', () => {
  test('invoking a captured callback after unmount does not flip result.current', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const handlers = __getCapturedHandlers();

    const { result, unmount } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);

    // Capture the close handler reference BEFORE unmount.
    const capturedClose = handlers.close[0];
    expect(capturedClose).toBeDefined();

    unmount();

    // off() was called — the handler is no longer in the registry.
    expect(__getOffSpy()).toHaveBeenCalledTimes(1);

    // The test still holds a stale reference. Invoking it does not
    // flip the unmounted hook's last-committed value (which is `true`
    // from the seed). We wrap in act() to silence any spurious
    // warning even though no React tree exists to update.
    act(() => {
      capturedClose();
    });
    expect(result.current).toBe(true);
  });
});

// ─── native bail — spec 058 alignment continued ────────────────────────
//
// Case 14 (structurally unchanged): native bail guard stays as the
// first statement of the `useEffect` body. The test mutates
// `Platform.OS` to `'ios'`, then asserts:
//   - `socket.onOpen` / `onClose` / `onError` are NOT called (effect
//     bailed before reaching them).
//   - `result.current === true` (optimistic seed observed; the seed
//     is true whether or not the socket reports closed because the
//     `useEffect` bails on native — but we keep the seed explicit by
//     setting `connectionState: 'open'` for clarity).
//   - `setInterval` not called either (regression invariant from
//     spec 058's original "no polling on native" assertion).

describe('useConnectionStatus — native platform bail (spec 058 alignment)', () => {
  test('does NOT subscribe to socket events on native, returns optimistic default', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Platform = require('react-native/Libraries/Utilities/Platform').default as { OS: string };
    const originalOS = Platform.OS;
    Platform.OS = 'ios';

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    try {
      // Even with a seed that would render `false` on web, the native
      // bail keeps the value at the lazy-initializer result. The seed
      // rule: connectionState='connecting' → true; on native the
      // useEffect bails BEFORE reaching the subscriptions, so the
      // seed is the only value consumers see.
      __setInitialConnected({ isConnected: false, connectionState: 'connecting' });

      const { result, unmount } = renderHook(() => useConnectionStatus());

      // Subscription calls must NOT have been invoked from the hook
      // on native — the effect bails as the first statement.
      expect(__getOnOpenSpy()).not.toHaveBeenCalled();
      expect(__getOnCloseSpy()).not.toHaveBeenCalled();
      expect(__getOnErrorSpy()).not.toHaveBeenCalled();
      // setInterval must NOT have been called either — the hook no
      // longer uses it, and the native bail prevents ALL side-effects.
      expect(setIntervalSpy).not.toHaveBeenCalled();
      // Optimistic default observed.
      expect(result.current).toBe(true);

      unmount();
    } finally {
      Platform.OS = originalOS;
      setIntervalSpy.mockRestore();
    }
  });
});

// ─── initial-seed three-branch decision rule ───────────────────────────
//
// Case 15 (new — spec 059 §4 / Q4): exercises the seed rule's three
// branches explicitly. AC4 says "optimistic true on initial mount"
// under normal startup; the seed rule biases to true unless the
// socket is EXPLICITLY closed/closing.

describe('useConnectionStatus — initial-seed three-branch rule (Q4)', () => {
  test('isConnected=true → seed true regardless of connectionState', () => {
    __setInitialConnected({ isConnected: true, connectionState: 'open' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
  });

  test("isConnected=false + connectionState='connecting' → seed true (optimistic)", () => {
    __setInitialConnected({ isConnected: false, connectionState: 'connecting' });
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current).toBe(true);
  });

  test("isConnected=false + connectionState='closed' → seed false (explicitly down)", () => {
    __setInitialConnected({ isConnected: false, connectionState: 'closed' });
    const { result } = renderHook(() => useConnectionStatus());
    // The seed rule maps 'closed' to false — the indicator honestly
    // shows amber when the indicator mounts after an established
    // disconnect.
    expect(result.current).toBe(false);
  });
});
