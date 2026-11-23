// src/lib/realtimeReloadScheduler.ts — Spec 206.
//
// Decides WHEN a realtime event turns into a full `loadFromSupabase` reload.
// Pure: no React, no Supabase, no `useStore`, no `inflight` import. The
// production wiring (the inflight-backed write source and the reload thunk)
// lives in src/hooks/useRealtimeReloadScheduler.ts.
//
// Rules (specs/206-realtime-reload-once-per-edit.md §3.3):
//   - R5: with no local writes in flight, an event arms a trailing debounce
//     (`delayMs`); when it expires, exactly one reload runs.
//   - R3: while this client has ≥1 tracked write in flight, events are held
//     (no timer). When writes drain to 0 and something is held, the debounce
//     starts. A write starting during that debounce clears it (re-hold).
//   - R4: single-flight. If the debounce expires while a reload is running,
//     the scheduler marks itself dirty and starts nothing; when the running
//     reload settles (resolve OR reject), one follow-up starts immediately.
//   - R7: `dispose()` clears the timer, drops held state and releases the
//     write subscription. A reload already running is not cancelled, but it
//     starts no follow-up when it settles.
//   - R8: a reload "ends" when the `reload()` promise settles.
//
// Invariants kept after every handler:
//   I1. timer !== null ⇒ pending && !isWriting() && !dirty && !disposed
//   I2. dirty ⇒ running && pending && timer === null
//   I3. at most one scheduler reload is unsettled
//   I4. disposed ⇒ timer === null && !pending && !dirty && unsubscribed

/** Production debounce. Same value as the pre-spec-206 inline debounce. */
export const REALTIME_RELOAD_DEBOUNCE_MS = 400;

/** "Writes in flight?" source. Backed by R1 in production, a fake in tests. */
export interface WriteInflightSource {
  /** Current value: true iff ≥1 tracked write is in flight. Read synchronously. */
  isWriting(): boolean;
  /**
   * Register a change callback. The callback takes no args; the scheduler
   * re-reads `isWriting()` when called. Duplicate or non-edge calls are allowed
   * and must be harmless. Returns the unsubscribe function.
   */
  subscribe(onChange: () => void): () => void;
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface RealtimeReloadSchedulerOptions {
  reload: () => Promise<void>;
  writes: WriteInflightSource;
  delayMs: number;
  /** Defaults to wrappers that look up the global setTimeout/clearTimeout AT CALL TIME. */
  timers?: SchedulerTimers;
  /** Called when `reload` rejects or throws synchronously. Default: console.warn. */
  onReloadError?: (e: unknown) => void;
}

export interface RealtimeReloadScheduler {
  /** A realtime event arrived. Takes no args (realtime payloads are ignored). */
  notify(): void;
  /** Teardown (R7). Idempotent. */
  dispose(): void;
}

// Look the globals up lazily: jest modern fake timers replace them after
// import, and a captured reference would be the real timer.
const defaultTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const defaultOnReloadError = (e: unknown) => {
  // eslint-disable-next-line no-console
  console.warn('[realtimeReload] reload failed:', e);
};

export function createRealtimeReloadScheduler(
  opts: RealtimeReloadSchedulerOptions,
): RealtimeReloadScheduler {
  const { reload, writes, delayMs } = opts;
  const timers = opts.timers ?? defaultTimers;
  const onReloadError = opts.onReloadError ?? defaultOnReloadError;

  /** ≥1 realtime event arrived that no reload has started for yet. */
  let pending = false;
  /** The armed debounce timer. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A scheduler-started `reload()` promise is unsettled. */
  let running = false;
  /** The debounce completed while `running`; a follow-up is due on settle. */
  let dirty = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    clearTimer();
    timer = timers.setTimeout(onTimer, delayMs);
  };

  const safeReport = (e: unknown) => {
    try {
      onReloadError(e);
    } catch {
      // A throwing reporter must never become an unhandled rejection.
    }
  };

  function startReload() {
    // State first, so a synchronous re-entry from `reload()` sees `running`.
    pending = false;
    dirty = false;
    running = true;
    let p: Promise<void>;
    try {
      p = reload();
    } catch (e) {
      p = Promise.reject(e);
    }
    // Both branches attached in the same expression: no unobserved rejection.
    Promise.resolve(p).then(onSettled, (e: unknown) => {
      safeReport(e);
      onSettled();
    });
  }

  function onSettled() {
    running = false;
    if (disposed) return; // R7: no follow-up after dispose
    if (dirty) {
      if (writes.isWriting()) {
        // Defensive: W↑ already demotes dirty → held. Drain re-arms.
        dirty = false;
        return;
      }
      startReload(); // R4: the quiet period already elapsed — run now.
    }
  }

  function onTimer() {
    timer = null;
    if (disposed) return;
    if (writes.isWriting()) return; // defensive (I1); the drain re-arms
    if (running) {
      dirty = true; // R4 single-flight
      return;
    }
    startReload();
  }

  function onWritesChanged() {
    if (disposed) return;
    if (writes.isWriting()) {
      // W↑: (re)hold. `pending` is kept.
      clearTimer();
      dirty = false;
      return;
    }
    // W↓ with something held → post-drain debounce. A non-edge call while a
    // debounce is already armed must not restart it.
    if (pending && timer === null && !dirty) arm();
  }

  const unsubscribe = writes.subscribe(onWritesChanged);

  return {
    notify() {
      if (disposed) return;
      pending = true;
      if (dirty) return; // R4: already queued; collapse
      if (writes.isWriting()) {
        clearTimer(); // R3: hold
        return;
      }
      arm(); // R5 trailing debounce; also runs while `running`
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      pending = false;
      dirty = false;
      unsubscribe();
      // A running reload is not cancelled; its onSettled sees `disposed`.
    },
  };
}
