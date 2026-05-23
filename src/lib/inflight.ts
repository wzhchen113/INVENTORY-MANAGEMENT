// src/lib/inflight.ts — Spec 055 global loading indicator backbone.
//
// Standalone Zustand store that counts in-flight `db.ts` calls and exposes
// two booleans the chrome subscribes to (`hasInflight`, `hasSlow`). The
// `track()` action wraps a promise-producing thunk with an AbortController,
// a 5s "soft warning" timer, and a 30s hard-abort timer. Aborts raise a
// typed `InflightTimeoutError` whose `message` is the spec's mandated
// read-vs-write copy — that message threads through the existing
// `notifyBackendError` toast surface with zero changes at call sites.
//
// Rationale for keeping this OUT of `useStore.ts`: the main store imports
// `db.ts`; if `db.ts` reached back into `useStore.ts` we'd create a circular
// import. A tiny isolated store keeps the loading concern self-contained
// (mirrors `src/lib/paletteAction.ts`).
//
// Public surface:
//   useInflight              — the Zustand store hook + `.getState()` for db.ts
//   selectHasInflight        — pre-bound selector for the TopProgressBar
//   selectHasSlow            — pre-bound selector for the "taking longer"
//   InflightTimeoutError     — typed synthetic error so aborts compose with
//                              the existing toast plumbing
//
// See specs/055-global-loading-indicator.md §1-§6 for the load-bearing
// contracts.

import { create } from 'zustand';

export type InflightKind = 'read' | 'write';

interface InflightState {
  /** True iff `_activeCount > 0` — what the TopProgressBar subscribes to. */
  hasInflight: boolean;
  /** True iff any in-flight call has been alive ≥ 5s. */
  hasSlow: boolean;
  /** Internal — number of in-flight `track()` calls. Consumers read
   *  `hasInflight` instead. */
  _activeCount: number;
  /** Internal — number of in-flight calls that have crossed the 5s mark. */
  _slowCount: number;
}

interface InflightActions {
  /**
   * Track a promise-producing thunk. Returns the underlying promise so the
   * caller's `await` is unchanged.
   *
   * - Increments `_activeCount` on entry and decrements in `.finally()`.
   * - Schedules a 5s timer; on fire, the call is classed "slow" and
   *   `hasSlow` becomes true. Cleared on resolve/reject.
   * - Schedules a 30s hard-abort timer; on fire, the AbortController is
   *   triggered and the wrapped promise rejects with `InflightTimeoutError`.
   * - `kind` drives the abort toast copy (read vs. write). Per spec A5 this
   *   MUST be declared per call-site, not inferred from HTTP method.
   * - `label` is for dev diagnostics only (logged when an abort fires).
   */
  track<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { kind: InflightKind; label: string },
  ): Promise<T>;
}

/** Synthetic typed error thrown by `track()` when the 30s hard-abort fires.
 *  The `message` field carries the spec-mandated copy (read vs. write) so
 *  the existing `notifyBackendError` path (`e.message || String(e)`) shows
 *  the correct text with zero changes at call sites. */
export class InflightTimeoutError extends Error {
  readonly kind: InflightKind;
  readonly label: string;
  constructor(kind: InflightKind, label: string) {
    super(
      kind === 'write'
        ? 'Request timed out — the change may or may not have been saved. Refresh to verify.'
        : 'Request timed out — please try again.',
    );
    this.name = 'InflightTimeoutError';
    this.kind = kind;
    this.label = label;
  }
}

/** Slow-warning threshold (ms). After this, the bar shifts to the warn color. */
export const SLOW_WARNING_MS = 5_000;
/** Hard-abort threshold (ms). After this, the AbortController fires. */
export const HARD_ABORT_MS = 30_000;

export const useInflight = create<InflightState & InflightActions>((set, get) => ({
  hasInflight: false,
  hasSlow: false,
  _activeCount: 0,
  _slowCount: 0,

  track: async <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { kind: InflightKind; label: string },
  ): Promise<T> => {
    // `ctrl` is fully internal — `track()`'s API does not accept an external
    // signal — so its `signal.aborted` is always false at construction time.
    // The only abort path is the 30s hard-abort timer below.
    const ctrl = new AbortController();

    // Single atomic increment so the boolean and counter flip in one frame.
    set((s) => ({
      _activeCount: s._activeCount + 1,
      hasInflight: true,
    }));

    let warnFired = false;
    const warnTimer = setTimeout(() => {
      warnFired = true;
      set((s) => ({
        _slowCount: s._slowCount + 1,
        hasSlow: true,
      }));
    }, SLOW_WARNING_MS);

    const abortTimer = setTimeout(() => {
      try {
        // Some runtimes (older Hermes) reject a non-DOMException reason.
        // Fall back to a string if DOMException isn't constructable.
        if (typeof DOMException !== 'undefined') {
          ctrl.abort(new DOMException('timeout', 'TimeoutError'));
        } else {
          ctrl.abort();
        }
      } catch {
        ctrl.abort();
      }
    }, HARD_ABORT_MS);

    try {
      return await fn(ctrl.signal);
    } catch (e: any) {
      // Distinguish "we aborted you" from "the server / fetch rejected you".
      // supabase-js wraps the underlying AbortError into a PostgrestError
      // whose `message` starts with "AbortError" (see
      // node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:270),
      // so we check both the controller's signal AND the error shape.
      if (ctrl.signal.aborted) {
        if (process.env.NODE_ENV !== 'production') {
          // Dev-only diagnostic so a missing `.abortSignal(signal)` chain
          // surfaces as an obvious clue when investigating timeouts.
          // eslint-disable-next-line no-console
          console.warn(
            `[Inflight] ${opts.label} aborted after ${HARD_ABORT_MS}ms (kind=${opts.kind})`,
          );
        }
        throw new InflightTimeoutError(opts.kind, opts.label);
      }
      throw e;
    } finally {
      clearTimeout(warnTimer);
      clearTimeout(abortTimer);
      set((s) => {
        const nextActive = s._activeCount - 1;
        const nextSlow = warnFired ? s._slowCount - 1 : s._slowCount;
        return {
          _activeCount: nextActive,
          hasInflight: nextActive > 0,
          _slowCount: nextSlow,
          hasSlow: nextSlow > 0,
        };
      });
    }
  },
}));

// Pre-bound selectors. Zustand's reference-equality check means the
// TopProgressBar only re-renders when these booleans actually flip — not
// on every counter tick. Pulling `hasInflight && hasSlow` as a composite
// would defeat that (a derived expression has a fresh reference each call).
export const selectHasInflight = (s: InflightState) => s.hasInflight;
export const selectHasSlow = (s: InflightState) => s.hasSlow;
