// src/hooks/useConnectionStatus.ts — Spec 059.
//
// Event-driven replacement for the spec 057 polling implementation.
// Subscribes to the underlying Phoenix Socket's state-change callbacks
// (`onOpen` / `onClose` / `onError`) so the connection indicator flips
// within ~50-200ms of a real disconnect (DevTools "Offline" toggle,
// transport drop) instead of waiting up to 2000ms for the next poll
// boundary.
//
// Hook is still the codified `lib/supabase` chokepoint for the
// connection-indicator read alongside `src/lib/db.ts` and
// `src/hooks/useRealtimeSync.ts` (spec 057 §11 convention preserved).
//
// API surface used — defensive private-API navigation
// ────────────────────────────────────────────────────
// The public `RealtimeClient.d.ts` does NOT expose the Phoenix Socket's
// `onOpen`/`onClose`/`onError` methods on the public class — they live
// on an internal `socketAdapter` field whose `getSocket()` returns the
// underlying Phoenix Socket. Path traversed (each hop verified at
// install time against `@supabase/realtime-js@2.101.1`):
//
//   supabase
//     .realtime                         // RealtimeClient
//     .socketAdapter                    // internal SocketAdapter wrapper
//     .getSocket()                      // unwrapped Phoenix Socket
//     .onOpen(cb)  → ref string         // returns a string ref to use with .off()
//     .onClose(cb) → ref string
//     .onError(cb) → ref string
//     .off([ref1, ref2, ref3])          // cleanup; idempotent
//
// Tested against `@supabase/realtime-js` shipped with `supabase-js`
// ^2.101.1. If supabase-js v3+ restructures any link in the chain, the
// `as any` casts will return `undefined` at the first missing hop; the
// hook short-circuits without subscribing and the `useState`
// lazy-initializer seed becomes the only value consumers ever see —
// equivalent to the optimistic-true fallback the original poll
// produced when no channels existed. The indicator stops detecting
// disconnects in that scenario, but the app does NOT crash.
//
// Initial-state seed (spec 059 §4)
// ────────────────────────────────
// Events only fire on transitions, so the seed value matters. We use
// the `useState(readInitialConnected)` lazy form to read
// `isConnected()` + `connectionState()` synchronously on first render:
//
//   isConnected() === true                  → seed true   (already open)
//   connectionState() === 'connecting'      → seed true   (optimistic)
//   connectionState() === 'open'            → seed true   (open)
//   otherwise (closed/closing/null/unknown) → seed false  (explicitly down)
//   any error / unknown shape               → seed true   (never throw at mount)
//
// This subsumes AC4's "optimistic `true` on initial mount" — under
// normal startup the socket is mid-connect and the rule returns true.
//
// Wall-clock latency budget (spec 059 §6 / Q6)
// ────────────────────────────────────────────
// - Hard disconnect (DevTools Offline toggle, manual disconnect()):
//   ~50-200ms from socket-close to indicator flip. WebSocket's native
//   `onclose` calls `triggerStateCallbacks('close')` synchronously
//   inside the Phoenix Socket.
// - Soft disconnect (heartbeat timeout): up to ~30s. Phoenix's
//   heartbeat interval is 25s; the transport stays open until the
//   heartbeat timeout fallback closes it, which then fires onClose.
//   NOT a regression — the prior 2000ms poll also waited on the same
//   underlying socket-close transition because channel state didn't
//   flip until the socket did.
// - Reconnect after restoration: ~1-3s for a fresh disconnect (Phoenix
//   reconnect backoff is [1000, 2000, 5000, 10000]ms).
//
// Platform gate stays as the FIRST statement inside `useEffect`
// ─────────────────────────────────────────────────────────────
// Rules-of-Hooks invariant: the hook MUST be called unconditionally on
// every render so the TitleBar call site above its
// `Platform.OS !== 'web'` early return doesn't invert hook order. The
// `useEffect` body bails on native before any subscription side-effect
// runs; `useState(true)` is the only value downstream consumers ever
// see on iOS / Android. Spec 058 regression test pins this position.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

// Synchronous read of the current realtime connection state, used as
// the `useState` lazy-initializer seed. See spec 059 §4 for the
// decision rule. Wrapped in try/catch so an unfamiliar supabase-js
// shape at mount time can never crash the consumer — we fall back to
// the optimistic-true default. The function is module-local (NOT
// exported) and runs exactly once per mount via the lazy form
// `useState(readInitialConnected)`.
function readInitialConnected(): boolean {
  try {
    const realtime: any = (supabase as any).realtime;
    if (!realtime) return true; // pre-init → optimistic
    if (typeof realtime.isConnected === 'function' && realtime.isConnected()) return true;
    if (typeof realtime.connectionState === 'function') {
      const s = realtime.connectionState();
      // 'connecting' counts as optimistic-true; only 'closed' / 'closing' are amber.
      return s === 'open' || s === 'connecting';
    }
    return true; // unknown shape → optimistic
  } catch {
    return true; // never throw at mount
  }
}

export function useConnectionStatus(): boolean {
  // Lazy initializer — runs once on first render, before useEffect.
  // The literal `useState(true)` form would NOT call the seed reader;
  // the lazy form is required for the seed rule to fire on mount.
  const [connected, setConnected] = useState<boolean>(readInitialConnected);

  useEffect(() => {
    // Native bail — the realtime connection indicator is web-only
    // chrome. MUST stay as the first statement of the effect body so
    // the spec 058 native-bail regression test (Platform.OS = 'ios' →
    // no subscription side-effect, optimistic true preserved)
    // continues to pass unchanged.
    if (Platform.OS !== 'web') return;

    // Defensive null-check at every hop. The chain
    // `realtime.socketAdapter.getSocket().onOpen` is NOT in the public
    // `RealtimeClient.d.ts` — a future supabase-js major bump could
    // rename `socketAdapter`, move `onOpen` onto the public class, or
    // remove the Phoenix wrapper. If any link is missing we bail
    // without subscribing — the `useState` seed is the only value
    // consumers see, which is the correct optimistic fallback.
    const realtime: any = (supabase as any).realtime;
    const socket: any = realtime?.socketAdapter?.getSocket?.();
    if (!socket || typeof socket.onOpen !== 'function') return;

    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    const onError = () => setConnected(false);

    // Each onOpen/onClose/onError returns a string ref. Phoenix's
    // `off([refs])` removes registrations by ref in one pass. We
    // collect all three refs and call `off()` once on unmount.
    const refs: string[] = [];
    refs.push(socket.onOpen(onOpen));
    refs.push(socket.onClose(onClose));
    refs.push(socket.onError(onError));

    // Save the socket reference so cleanup operates on the same
    // instance even in the (extremely unlikely) case that
    // `supabase.realtime.socketAdapter.getSocket()` returns a
    // different socket on a subsequent read.
    const subscribedSocket = socket;

    return () => {
      // Defensive belt-and-suspenders — under React's normal
      // lifecycle Phoenix's `off()` is null-safe and can't throw, but
      // we wrap to bound future supabase-js shape drift to a no-op at
      // unmount time rather than a thrown error.
      try {
        subscribedSocket.off(refs);
      } catch {
        /* socket may already be torn down on app unmount */
      }
    };
  }, []);

  return connected;
}
