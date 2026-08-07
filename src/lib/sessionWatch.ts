// src/lib/sessionWatch.ts — Spec 152.
//
// THE auth-state subscription. Before this spec the app had none at all
// (`grep onAuthStateChange` returned one comment in recoveryRedirect.ts), so a
// session that died mid-session — expired access token whose refresh failed,
// a revoked refresh token, storage cleared in another tab — left a fully
// mounted, signed-in-LOOKING shell behind: `RoleRouter` gates on the in-memory
// `currentUser`, every RLS-denied table read comes back `200 []` rather than an
// error, and the chrome's connection dot reads the realtime websocket (still
// open on the stale token) so it stayed green. The 2026-08-03 prod incident was
// exactly that state: `Inventory 0 items`, `no prep recipes for Charles`, and
// `permission denied for function report_reorder_list` (the one honest signal —
// RPCs 42501 for `anon` where table reads silently return nothing).
//
// Two things end a surface's session, and BOTH are handled here:
//   1. the session goes away — a null session on any event but INITIAL_SESSION.
//   2. the session becomes SOMEONE ELSE'S. auth-js replays other tabs' auth
//      events into this tab over a BroadcastChannel, so signing in as user B in
//      tab 2 hands tab 1 a `SIGNED_IN` carrying B's session. Keying only on
//      `session == null` would leave tab 1 rendering A's shell while every
//      request goes out with B's JWT (security-auditor M1). RLS bounds the data
//      exposure, but the shell would be asserting the wrong identity.
//
// No retry, no silent re-auth — the honest outcome is the sign-in screen.
//
// ── Store-agnostic by construction (spec 063 slice isolation) ───────────────
// This module knows NOTHING about `useStore` or `useStaffStore`. Surfaces
// REGISTER themselves (`registerSessionSurface`) from App.tsx — the root bridge
// that already owns both stores, the same role `RoleRouter` plays. That keeps
// the staff subtree's "staff code never imports useStore" contract intact:
// `screens/staff/screens/Settings.tsx` imports `markIntentionalSignOut` from
// here and, because this file has no store imports, pulls in nothing but
// `lib/supabase` — which staff already imports directly.
//
// Carve-out note: this module calls `supabase.auth.onAuthStateChange` directly.
// That is auth-client plumbing, not PostgREST/RPC traffic, so CLAUDE.md's
// "all DB access goes through db.ts" rule doesn't apply — same footing as
// `lib/auth.ts`, `lib/authGate.ts` and `lib/sessionRestore.ts`.
//
// Installed once from App.tsx (`watchSessionLoss()`), torn down on unmount.

import { supabase } from './supabase';

/** Why a surface's session ended. Drives which copy the surface announces. */
export type SessionLossReason =
  /** The session is gone (expired + unrefreshable, revoked, ended elsewhere). */
  | 'expired'
  /** The session now belongs to a DIFFERENT user (another tab signed in). */
  | 'switched';

/**
 * One signed-in surface (admin Cmd UI, staff EOD app) as far as the watcher is
 * concerned. Registered from the root; never constructed here.
 */
export interface SessionSurface {
  /** Diagnostics label — 'admin' / 'staff'. Not used for control flow. */
  id: string;
  /** The user id this surface currently believes it is signed in as, or `null`
   *  when it has no session. `null` ⇒ the surface is skipped entirely (nothing
   *  to tear down, nothing to apologise for). */
  getUserId: () => string | null;
  /** Clear this surface's in-memory session state. */
  tearDown: () => void;
  /** Tell the user once, in this surface's own catalog + toast convention.
   *  Only the FIRST affected surface (registration order) announces. */
  announce: (reason: SessionLossReason) => void;
}

const surfaces: SessionSurface[] = [];

/**
 * Register a surface with the watcher. Returns an unregister function.
 *
 * Registration ORDER is priority order for the single announcement: register
 * admin first, mirroring `RoleRouter`'s "admin session > staff session"
 * precedence.
 */
export function registerSessionSurface(surface: SessionSurface): () => void {
  surfaces.push(surface);
  return () => {
    const i = surfaces.indexOf(surface);
    if (i >= 0) surfaces.splice(i, 1);
  };
}

// A deliberate sign-out also emits a null-session event. The two intentional
// paths (`useStore.logout()` and the staff Settings sheet) raise this flag
// immediately before calling `signOut()`; the watcher consumes it and stays
// quiet, so "you signed out" never gets reported as "your session expired".
let intentionalSignOut = false;

/** Mark the next null-session auth event as user-initiated. Setting it twice
 *  before it is consumed is a plain no-op re-set. */
export function markIntentionalSignOut(): void {
  intentionalSignOut = true;
}

/**
 * Un-arm the flag.
 *
 * Load-bearing on the failure path (security-auditor Low): auth-js returns
 * early WITHOUT emitting `SIGNED_OUT` when `signOut()` fails on anything other
 * than 401/404/403 — a network error, say. The flag is module-global with no
 * TTL, so a swallowed sign-out would leave it armed for the tab's lifetime and
 * eat the NEXT genuine session loss (no teardown, no toast — i.e. exactly the
 * incident state). Both sign-out call sites clear it when `signOut()` rejects,
 * and a fresh sign-in clears it too.
 */
export function clearIntentionalSignOut(): void {
  intentionalSignOut = false;
}

/** Test-only: drop every registered surface and disarm the flag. */
export function _resetSessionWatch(): void {
  surfaces.length = 0;
  intentionalSignOut = false;
}

/**
 * Is this auth event a session LOSS (as opposed to an identity change)?
 *
 * Keyed on the session being `null` rather than on an event-name allow-list:
 * supabase-js emits `SIGNED_OUT` for both an explicit sign-out and a failed
 * refresh today, but an event rename in a future major must not silently
 * disable this guard — a null session is a null session.
 *
 * The one exception is `INITIAL_SESSION`, which fires with `null` on EVERY
 * signed-out cold start. Treating that as a loss would toast "session expired"
 * at the login screen of a user who never had one.
 */
export function isSessionLossEvent(event: string, session: unknown | null): boolean {
  if (event === 'INITIAL_SESSION') return false;
  return session == null;
}

/** Narrow the `unknown` session payload to the one field we consume. */
function sessionUserId(session: unknown | null): string | null {
  const id = (session as { user?: { id?: unknown } } | null | undefined)?.user?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Decide + apply the reaction to one auth event. Exported for the jest pins;
 * the subscription below is a thin wrapper around it.
 *
 * @returns the reason applied, or `null` when the event was a no-op.
 */
export function handleAuthEvent(
  event: string,
  session: unknown | null,
): SessionLossReason | null {
  if (event === 'INITIAL_SESSION') return null;

  const nextUserId = sessionUserId(session);
  const isLoss = isSessionLossEvent(event, session);

  // Which registered surfaces just lost their session? A surface with no
  // session is skipped — that covers `checkAuthGate`'s not-staff / no-stores
  // `signOut()` and `RecoveryScreen`'s post-recovery `signOut()`, where there
  // is nothing to tear down.
  const affected = surfaces.filter((s) => {
    const current = s.getUserId();
    if (current === null) return false;
    return isLoss || nextUserId !== current;
  });

  if (isLoss) {
    // Consume the intentional flag on ANY null-session event, even one with no
    // affected surface, so it can never leak into a LATER involuntary loss.
    const wasIntentional = intentionalSignOut;
    intentionalSignOut = false;
    // Deliberate sign-out: that path owns its own teardown and its own copy.
    if (wasIntentional) return null;
  }
  if (affected.length === 0) return null;

  const reason: SessionLossReason = isLoss ? 'expired' : 'switched';
  for (const s of affected) s.tearDown();
  // ONE announcement, from the highest-priority affected surface.
  affected[0].announce(reason);
  return reason;
}

/**
 * Install the single `onAuthStateChange` subscription.
 *
 * @returns an unsubscribe function for the caller's effect cleanup. Safe to
 *          call twice; safe to call when the supabase client's shape is
 *          unfamiliar (returns a no-op rather than throwing at boot).
 */
export function watchSessionLoss(): () => void {
  try {
    const { data } = supabase.auth.onAuthStateChange((event: string, session: unknown) => {
      handleAuthEvent(event, session);
    });
    return () => {
      try {
        data?.subscription?.unsubscribe();
      } catch {
        /* already torn down */
      }
    };
  } catch {
    // An auth client that can't be subscribed to must not take the app down at
    // boot; the loadFromSupabase probe (spec 152 part 2) still covers the
    // blanking path on its own.
    return () => {};
  }
}
