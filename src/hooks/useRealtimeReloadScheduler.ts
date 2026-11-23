// src/hooks/useRealtimeReloadScheduler.ts — Spec 206.
//
// Production wiring for the pure realtime reload scheduler
// (src/lib/realtimeReloadScheduler.ts). `AuthedRoot` in CmdNavigator.tsx
// calls `useRealtimeReloadScheduler()` and passes the returned callback to
// `useRealtimeSync` as `onSync`. Replaces the pre-spec-206 inline 400 ms
// debounce: self-echo reloads are held while this client's tracked writes
// are in flight, and scheduler reloads never overlap.

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useInflight } from '../lib/inflight';
import {
  createRealtimeReloadScheduler,
  REALTIME_RELOAD_DEBOUNCE_MS,
  type RealtimeReloadScheduler,
  type WriteInflightSource,
} from '../lib/realtimeReloadScheduler';

/** R6 thunk: reads the current store at FIRE time; no store → resolve without loading. */
export function reloadCurrentStore(): Promise<void> {
  const sid = useStore.getState().currentStore?.id;
  if (sid) return useStore.getState().loadFromSupabase(sid);
  return Promise.resolve();
}

/** Adapts the R1 counter to the scheduler's WriteInflightSource. */
export const inflightWriteSource: WriteInflightSource = {
  isWriting: () => useInflight.getState().hasWriteInflight,
  // Edge filter: read-track churn and 2→1 write-count changes never call back.
  subscribe: (cb) =>
    useInflight.subscribe((s, prev) => {
      if (s.hasWriteInflight !== prev.hasWriteInflight) cb();
    }),
};

/** One scheduler per mount. Returns a callback whose identity is stable for the mount's lifetime. */
export function useRealtimeReloadScheduler(): () => void {
  const schedulerRef = useRef<RealtimeReloadScheduler | null>(null);

  // Created inside the effect (not at render time) so a mount → unmount →
  // mount cycle always yields a fresh, live instance.
  useEffect(() => {
    const s = createRealtimeReloadScheduler({
      reload: reloadCurrentStore,
      writes: inflightWriteSource,
      delayMs: REALTIME_RELOAD_DEBOUNCE_MS,
    });
    schedulerRef.current = s;
    return () => {
      s.dispose();
      if (schedulerRef.current === s) schedulerRef.current = null;
    };
  }, []);

  return useCallback(() => {
    schedulerRef.current?.notify();
  }, []);
}
