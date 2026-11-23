// src/lib/realtimeReloadScheduler.test.ts — Spec 206, AC-1 to AC-9.
//
// Drives the pure scheduler with jest modern fake timers (using the
// scheduler's DEFAULT timers, so `jest.getTimerCount()` sees them), a fake
// writes-in-flight source and a `reload` mock that returns a deferred
// promise per call.

import {
  createRealtimeReloadScheduler,
  REALTIME_RELOAD_DEBOUNCE_MS,
  type RealtimeReloadScheduler,
  type WriteInflightSource,
} from './realtimeReloadScheduler';

// ─── harness ─────────────────────────────────────────────────────────────

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWrites() {
  let writing = false;
  const cbs = new Set<() => void>();
  const source: WriteInflightSource = {
    isWriting: () => writing,
    subscribe: (cb) => {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
  };
  return {
    source,
    set(v: boolean) {
      writing = v;
      cbs.forEach((cb) => cb());
    },
    /** Fire subscribers without changing the value (a spurious, non-edge call). */
    poke() {
      cbs.forEach((cb) => cb());
    },
    subscriberCount: () => cbs.size,
  };
}

/** Let settle handlers (.then chains) run. Fake timers don't drive microtasks. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const D = REALTIME_RELOAD_DEBOUNCE_MS;

interface Harness {
  scheduler: RealtimeReloadScheduler;
  writes: ReturnType<typeof makeWrites>;
  reload: jest.Mock<Promise<void>, []>;
  calls: Array<ReturnType<typeof defer<void>>>;
  onReloadError: jest.Mock;
  maxConcurrent: () => number;
}

function setup(): Harness {
  const writes = makeWrites();
  const calls: Array<ReturnType<typeof defer<void>>> = [];
  let inFlight = 0;
  let max = 0;
  const reload = jest.fn((): Promise<void> => {
    const d = defer<void>();
    calls.push(d);
    inFlight += 1;
    max = Math.max(max, inFlight);
    const settle = () => {
      inFlight -= 1;
    };
    d.promise.then(settle, settle);
    return d.promise;
  });
  const onReloadError = jest.fn();
  const scheduler = createRealtimeReloadScheduler({
    reload,
    writes: writes.source,
    delayMs: D,
    onReloadError,
  });
  return { scheduler, writes, reload, calls, onReloadError, maxConcurrent: () => max };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('production debounce is 400 ms', () => {
  expect(REALTIME_RELOAD_DEBOUNCE_MS).toBe(400);
});

// ─── AC-1: R5, no local writes ───────────────────────────────────────────

describe('AC-1 (R5) — no local writes: trailing debounce', () => {
  test('one event: 0 reloads at 399 ms, exactly 1 at 400 ms', () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(399);
    expect(h.reload).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  test('a burst 100 ms apart gives exactly 1 reload, 400 ms after the last event', () => {
    const h = setup();
    h.scheduler.notify(); // t=0
    jest.advanceTimersByTime(100);
    h.scheduler.notify(); // t=100
    jest.advanceTimersByTime(100);
    h.scheduler.notify(); // t=200
    jest.advanceTimersByTime(100);
    h.scheduler.notify(); // t=300
    jest.advanceTimersByTime(399); // t=699
    expect(h.reload).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1); // t=700
    expect(h.reload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000 - 700);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-2: R3, held while writing ────────────────────────────────────────

describe('AC-2 (R3) — events held while writes are in flight', () => {
  test('no reload or timer while writing; one reload 400 ms after drain', () => {
    const h = setup();
    h.writes.set(true);
    h.scheduler.notify(); // t=0
    jest.advanceTimersByTime(300);
    h.scheduler.notify(); // t=300
    jest.advanceTimersByTime(600);
    h.scheduler.notify(); // t=900
    jest.advanceTimersByTime(600);
    h.scheduler.notify(); // t=1500
    jest.advanceTimersByTime(5000 - 1500);
    expect(h.reload).toHaveBeenCalledTimes(0);
    expect(jest.getTimerCount()).toBe(0);

    h.writes.set(false);
    jest.advanceTimersByTime(399);
    expect(h.reload).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-3: R3, re-hold ───────────────────────────────────────────────────

describe('AC-3 (R3) — a write during the post-drain debounce re-holds', () => {
  test('total is exactly 1 reload, 400 ms after the final drain', () => {
    const h = setup();
    h.writes.set(true);
    h.scheduler.notify();
    h.writes.set(false);
    jest.advanceTimersByTime(200);
    h.writes.set(true); // new write 200 ms into the post-drain debounce
    jest.advanceTimersByTime(1000);
    expect(h.reload).toHaveBeenCalledTimes(0);
    expect(jest.getTimerCount()).toBe(0);

    h.writes.set(false);
    jest.advanceTimersByTime(399);
    expect(h.reload).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-4: drain with nothing held ───────────────────────────────────────

describe('AC-4 (R3) — drain with nothing held', () => {
  test('writes 1 → 0 with no event held gives 0 reloads and no timer', () => {
    const h = setup();
    h.writes.set(true);
    h.writes.set(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(0);
  });
});

// ─── AC-5: R4, single-flight ─────────────────────────────────────────────

describe('AC-5 (R4) — single-flight with one dirty follow-up', () => {
  test('events during a running reload collapse into exactly one follow-up', async () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D);
    expect(h.reload).toHaveBeenCalledTimes(1); // #1 pending

    h.scheduler.notify();
    h.scheduler.notify();
    h.scheduler.notify();
    jest.advanceTimersByTime(1000);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.maxConcurrent()).toBeLessThanOrEqual(1);

    h.calls[0].resolve();
    await flush();
    // Immediate follow-up: no timer advance needed.
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.maxConcurrent()).toBeLessThanOrEqual(1);

    h.calls[1].resolve();
    await flush();
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.maxConcurrent()).toBe(1);
  });

  test('an event less than 400 ms before settle still gives one follow-up (via its timer)', async () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // #1 running
    h.scheduler.notify(); // debounce armed, not dirty yet
    jest.advanceTimersByTime(100);
    h.calls[0].resolve();
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1); // not dirty → no immediate follow-up
    jest.advanceTimersByTime(D - 100);
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.calls[1].resolve();
    await flush();
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(2);
  });
});

// ─── AC-6: R4, failure ───────────────────────────────────────────────────

// Unhandled-rejection detection: jest installs its own process-level
// handler, which FAILS the running test with the leaked error. The sandbox
// `process.on('unhandledRejection')` spy below is belt-and-braces; the
// `setImmediate` turn is what gives Node the chance to emit the event while
// the test is still running. Verified 2026-11-23 by temporarily re-throwing
// from the scheduler's reject branch: every rejection case below failed.
describe('AC-6 (R4) — a rejected reload never sticks the scheduler', () => {
  test('dirty follow-up still runs once; later events still work; no unhandled rejection', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const spy = jest.fn();
    process.on('unhandledRejection', spy);
    try {
      const h = setup();
      h.scheduler.notify();
      jest.advanceTimersByTime(D); // #1 running
      h.scheduler.notify();
      h.scheduler.notify();
      h.scheduler.notify();
      jest.advanceTimersByTime(1000); // dirty
      expect(h.reload).toHaveBeenCalledTimes(1);

      const boom = new Error('boom');
      h.calls[0].reject(boom);
      await flush();
      expect(h.reload).toHaveBeenCalledTimes(2);
      expect(h.onReloadError).toHaveBeenCalledTimes(1);
      expect(h.onReloadError).toHaveBeenCalledWith(boom);

      h.calls[1].resolve();
      await flush();
      expect(h.reload).toHaveBeenCalledTimes(2);

      h.scheduler.notify();
      jest.advanceTimersByTime(D);
      expect(h.reload).toHaveBeenCalledTimes(3);
      h.calls[2].resolve();
      await flush();

      // Give Node a macrotask turn to emit any unhandledRejection.
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', spy);
    }
  });

  test('a reload that throws synchronously is reported and the scheduler keeps serving', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const spy = jest.fn();
    process.on('unhandledRejection', spy);
    try {
      const writes = makeWrites();
      const onReloadError = jest.fn();
      const err = new Error('sync-throw');
      let n = 0;
      const reload = jest.fn((): Promise<void> => {
        n += 1;
        if (n === 1) throw err;
        return Promise.resolve();
      });
      const scheduler = createRealtimeReloadScheduler({
        reload,
        writes: writes.source,
        delayMs: D,
        onReloadError,
      });
      scheduler.notify();
      expect(() => jest.advanceTimersByTime(D)).not.toThrow();
      expect(reload).toHaveBeenCalledTimes(1);
      await flush();
      expect(onReloadError).toHaveBeenCalledWith(err);

      scheduler.notify();
      jest.advanceTimersByTime(D);
      expect(reload).toHaveBeenCalledTimes(2);
      await flush();
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', spy);
    }
  });

  test('a throwing onReloadError reporter does not surface as an unhandled rejection', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const spy = jest.fn();
    process.on('unhandledRejection', spy);
    try {
      const writes = makeWrites();
      const reload = jest.fn((): Promise<void> => Promise.reject(new Error('x')));
      const scheduler = createRealtimeReloadScheduler({
        reload,
        writes: writes.source,
        delayMs: D,
        onReloadError: () => {
          throw new Error('reporter broke');
        },
      });
      scheduler.notify();
      jest.advanceTimersByTime(D);
      await flush();
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
      // Still serves the next event.
      scheduler.notify();
      jest.advanceTimersByTime(D);
      expect(reload).toHaveBeenCalledTimes(2);
      await flush();
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', spy);
    }
  });
});

// ─── AC-7: R4 + R3 ───────────────────────────────────────────────────────

describe('AC-7 (R4 + R3) — dirty follow-up held by a write at settle time', () => {
  test('follow-up waits for the drain, then runs once 400 ms later', async () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // #1 running
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // dirty
    h.writes.set(true);
    h.calls[0].resolve();
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(1);

    h.writes.set(false);
    jest.advanceTimersByTime(399);
    expect(h.reload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(h.reload).toHaveBeenCalledTimes(2);
  });
});

// ─── AC-8: R4, no dirty ──────────────────────────────────────────────────

describe('AC-8 (R4) — no events during a reload, no follow-up', () => {
  test('a reload that settles clean starts nothing', async () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D);
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.calls[0].resolve();
    await flush();
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-9: R7, teardown ──────────────────────────────────────────────────

describe('AC-9 (R7) — dispose', () => {
  test('(a) clears a pending debounce; no reload afterwards', () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(200);
    h.scheduler.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(0);
  });

  test('(b) a held event never fires after writes drain', () => {
    const h = setup();
    h.writes.set(true);
    h.scheduler.notify();
    h.scheduler.dispose();
    h.writes.set(false);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('(c) a running, dirty reload that settles after dispose starts no follow-up', async () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // #1 running
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // dirty
    h.scheduler.dispose();
    h.calls[0].resolve();
    await flush();
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.onReloadError).not.toHaveBeenCalled();
  });

  test('(c, reject) a running, dirty reload that rejects after dispose starts no follow-up', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const spy = jest.fn();
    process.on('unhandledRejection', spy);
    try {
      const h = setup();
      h.scheduler.notify();
      jest.advanceTimersByTime(D);
      h.scheduler.notify();
      jest.advanceTimersByTime(D); // dirty
      h.scheduler.dispose();
      h.calls[0].reject(new Error('late'));
      await flush();
      jest.advanceTimersByTime(5000);
      expect(h.reload).toHaveBeenCalledTimes(1);
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', spy);
    }
  });

  test('(d) releases the write subscription; notify after dispose is a no-op; dispose is idempotent', () => {
    const h = setup();
    expect(h.writes.subscriberCount()).toBe(1);
    h.scheduler.dispose();
    expect(h.writes.subscriberCount()).toBe(0);
    h.scheduler.notify();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(0);
    expect(() => h.scheduler.dispose()).not.toThrow();
  });
});

// ─── invariant guards ────────────────────────────────────────────────────

describe('invariant guards', () => {
  test('(e) notify while dirty creates no timer', () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // running
    h.scheduler.notify();
    jest.advanceTimersByTime(D); // dirty
    expect(jest.getTimerCount()).toBe(0);
    h.scheduler.notify();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('(f) a spurious non-edge write callback does not restart an armed debounce', () => {
    const h = setup();
    h.scheduler.notify(); // t=0
    jest.advanceTimersByTime(300);
    h.writes.poke(); // still not writing
    jest.advanceTimersByTime(99); // t=399
    expect(h.reload).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(1); // t=400, not 700
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  test('a write starting while a debounce is armed clears it (no timer while writing)', () => {
    const h = setup();
    h.scheduler.notify();
    jest.advanceTimersByTime(200);
    h.writes.set(true);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(h.reload).toHaveBeenCalledTimes(0);
    h.writes.set(false);
    jest.advanceTimersByTime(D);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});
