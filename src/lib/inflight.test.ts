// src/lib/inflight.test.ts — Spec 055 Track 1 (jest) coverage.
//
// Exercises the standalone inflight Zustand store + `track()` wrapper:
//   - counter math: increment/decrement on resolve/reject/abort
//   - hasInflight / hasSlow boolean flips on the right edges
//   - 5s soft-warning timer fires hasSlow
//   - 30s hard-abort timer rejects with InflightTimeoutError
//   - read vs. write abort copy diverges
//   - aborted-signal short-circuit (defense in depth)
//
// Strategy: jest.useFakeTimers() to advance the 5s / 30s timers
// deterministically. Reset the store between tests via `setState`.

import {
  useInflight,
  selectHasInflight,
  selectHasSlow,
  InflightTimeoutError,
  SLOW_WARNING_MS,
  HARD_ABORT_MS,
} from './inflight';

// ─── helpers ─────────────────────────────────────────────────────────────

/** Reset the store between tests. */
function resetStore() {
  useInflight.setState({
    hasInflight: false,
    hasSlow: false,
    _activeCount: 0,
    _slowCount: 0,
  });
}

/** Create a deferred promise so we can resolve/reject from the test body. */
function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetStore();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── counter math ────────────────────────────────────────────────────────

describe('useInflight.track — counter lifecycle', () => {
  test('increments hasInflight on entry and decrements on resolve', async () => {
    const d = defer<string>();
    expect(useInflight.getState().hasInflight).toBe(false);

    const tracked = useInflight.getState().track(
      // signal intentionally ignored in this test — counter lifecycle only.
      () => d.promise,
      { kind: 'read', label: 'test' },
    );

    // Synchronously, the counter should have incremented.
    expect(useInflight.getState().hasInflight).toBe(true);
    expect(useInflight.getState()._activeCount).toBe(1);

    d.resolve('ok');
    await expect(tracked).resolves.toBe('ok');

    expect(useInflight.getState().hasInflight).toBe(false);
    expect(useInflight.getState()._activeCount).toBe(0);
  });

  test('decrements on rejection too', async () => {
    const d = defer<string>();
    const tracked = useInflight.getState().track(
      () => d.promise,
      { kind: 'read', label: 'test' },
    );

    expect(useInflight.getState()._activeCount).toBe(1);
    d.reject(new Error('boom'));
    await expect(tracked).rejects.toThrow('boom');
    expect(useInflight.getState()._activeCount).toBe(0);
    expect(useInflight.getState().hasInflight).toBe(false);
  });

  test('two concurrent calls — counter is 2 then 0', async () => {
    const a = defer<string>();
    const b = defer<string>();

    const trackedA = useInflight.getState().track(
      () => a.promise,
      { kind: 'read', label: 'a' },
    );
    const trackedB = useInflight.getState().track(
      () => b.promise,
      { kind: 'read', label: 'b' },
    );

    expect(useInflight.getState()._activeCount).toBe(2);
    expect(useInflight.getState().hasInflight).toBe(true);

    a.resolve('A');
    await trackedA;
    expect(useInflight.getState()._activeCount).toBe(1);
    expect(useInflight.getState().hasInflight).toBe(true); // B still running

    b.resolve('B');
    await trackedB;
    expect(useInflight.getState()._activeCount).toBe(0);
    expect(useInflight.getState().hasInflight).toBe(false);
  });

  test('selectors return the current booleans', () => {
    expect(selectHasInflight(useInflight.getState())).toBe(false);
    expect(selectHasSlow(useInflight.getState())).toBe(false);

    useInflight.setState({ _activeCount: 1, hasInflight: true });
    expect(selectHasInflight(useInflight.getState())).toBe(true);
  });
});

// ─── 5-second soft warning ───────────────────────────────────────────────

describe('useInflight.track — soft-warning timer', () => {
  test('hasSlow flips true after SLOW_WARNING_MS', async () => {
    const d = defer<string>();
    const tracked = useInflight.getState().track(
      () => d.promise,
      { kind: 'read', label: 'slow' },
    );

    expect(useInflight.getState().hasSlow).toBe(false);

    // Advance past the 5s threshold but stay well below the 30s abort.
    jest.advanceTimersByTime(SLOW_WARNING_MS + 100);

    expect(useInflight.getState().hasSlow).toBe(true);
    expect(useInflight.getState()._slowCount).toBe(1);

    // Resolving the call clears the slow flag.
    d.resolve('ok');
    await tracked;
    expect(useInflight.getState().hasSlow).toBe(false);
    expect(useInflight.getState()._slowCount).toBe(0);
  });

  test('fast call (resolves before 5s) never flips hasSlow', async () => {
    const d = defer<string>();
    const tracked = useInflight.getState().track(
      () => d.promise,
      { kind: 'read', label: 'fast' },
    );

    jest.advanceTimersByTime(2000);
    d.resolve('done');
    await tracked;

    expect(useInflight.getState().hasSlow).toBe(false);
    expect(useInflight.getState()._slowCount).toBe(0);
  });

  test('concurrent slow calls — both contribute to hasSlow', async () => {
    const a = defer<string>();
    const b = defer<string>();
    const trackedA = useInflight.getState().track(
      () => a.promise,
      { kind: 'read', label: 'a' },
    );
    const trackedB = useInflight.getState().track(
      () => b.promise,
      { kind: 'read', label: 'b' },
    );

    jest.advanceTimersByTime(SLOW_WARNING_MS + 100);
    expect(useInflight.getState().hasSlow).toBe(true);
    expect(useInflight.getState()._slowCount).toBe(2);

    a.resolve('a');
    await trackedA;
    expect(useInflight.getState()._slowCount).toBe(1);
    expect(useInflight.getState().hasSlow).toBe(true);

    b.resolve('b');
    await trackedB;
    expect(useInflight.getState()._slowCount).toBe(0);
    expect(useInflight.getState().hasSlow).toBe(false);
  });
});

// ─── 30-second hard abort ────────────────────────────────────────────────

describe('useInflight.track — hard-abort timer', () => {
  // The dev-only diagnostic console.warn in inflight.ts:142-149 fires on
  // every hard-abort. Silence it in this describe so jest output stays
  // clean — the assertion below still verifies the typed error reaches
  // the caller, which is the load-bearing behavior.
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('read abort throws InflightTimeoutError with read copy', async () => {
    // The lambda awaits a fetch-shaped promise that rejects when the
    // signal aborts — mirrors how supabase-js propagates the underlying
    // AbortError.
    const tracked = useInflight.getState().track<string>(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            const err: any = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      { kind: 'read', label: 'reading' },
    );

    // Advance well past the 30s hard threshold.
    jest.advanceTimersByTime(HARD_ABORT_MS + 100);

    let captured: any;
    try {
      await tracked;
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InflightTimeoutError);
    expect(captured.kind).toBe('read');
    expect(captured.label).toBe('reading');
    expect(captured.message).toBe('Request timed out — please try again.');

    // Counter cleaned up.
    expect(useInflight.getState()._activeCount).toBe(0);
    expect(useInflight.getState().hasInflight).toBe(false);
    expect(useInflight.getState()._slowCount).toBe(0);
    expect(useInflight.getState().hasSlow).toBe(false);
  });

  test('write abort throws InflightTimeoutError with write copy', async () => {
    const tracked = useInflight.getState().track<string>(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            const err: any = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      { kind: 'write', label: 'writing' },
    );

    jest.advanceTimersByTime(HARD_ABORT_MS + 100);

    let captured: any;
    try {
      await tracked;
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InflightTimeoutError);
    expect(captured.kind).toBe('write');
    expect(captured.message).toBe(
      'Request timed out — the change may or may not have been saved. Refresh to verify.',
    );
  });

  test('non-abort error from inner promise bubbles unchanged', async () => {
    const native = new Error('PostgrestError: 23505');
    const tracked = useInflight.getState().track(
      () => Promise.reject(native),
      { kind: 'write', label: 'fail' },
    );
    await expect(tracked).rejects.toBe(native);
    expect(useInflight.getState()._activeCount).toBe(0);
  });

  test('inner promise resolves before timer — timers cleared cleanly', async () => {
    const d = defer<string>();
    const tracked = useInflight.getState().track(
      () => d.promise,
      { kind: 'read', label: 'fast' },
    );
    d.resolve('ok');
    await tracked;
    // Advancing past the (now-cleared) timers must not flip hasSlow or
    // throw — they should already be cleared.
    jest.advanceTimersByTime(HARD_ABORT_MS + 1000);
    expect(useInflight.getState().hasSlow).toBe(false);
    expect(useInflight.getState()._slowCount).toBe(0);
    expect(useInflight.getState()._activeCount).toBe(0);
  });
});

// ─── InflightTimeoutError class shape ────────────────────────────────────

describe('InflightTimeoutError', () => {
  test('read variant carries the read copy', () => {
    const err = new InflightTimeoutError('read', 'fetchInventory');
    expect(err.name).toBe('InflightTimeoutError');
    expect(err.kind).toBe('read');
    expect(err.label).toBe('fetchInventory');
    expect(err.message).toBe('Request timed out — please try again.');
    expect(err).toBeInstanceOf(Error);
  });

  test('write variant carries the write copy', () => {
    const err = new InflightTimeoutError('write', 'saveVendor');
    expect(err.kind).toBe('write');
    expect(err.message).toBe(
      'Request timed out — the change may or may not have been saved. Refresh to verify.',
    );
  });
});
