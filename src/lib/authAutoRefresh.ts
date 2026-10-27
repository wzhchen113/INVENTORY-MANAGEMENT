// src/lib/authAutoRefresh.ts — Spec 181 (B3).
//
// Native-only: pause supabase-js's token auto-refresh ticker while the app is
// backgrounded and resume it on foreground. React Native timers don't run in
// the background, so without this a long-backgrounded app wakes with an
// expired access token and waits up to one ticker interval (reads come back
// `200 []` under RLS meanwhile). `startAutoRefresh()` runs an immediate refresh
// tick on foreground:
//   - success → auth-js emits TOKEN_REFRESHED for the same user (a no-op for
//     sessionWatch; realtime picks up the new JWT);
//   - failure (revoked/expired refresh token) → SIGNED_OUT, and sessionWatch's
//     spec-152 teardown + "session expired" toast happen promptly.
//
// Web: auth-js already handles tab visibility itself, so NO listener is added.
// Nothing is called at install time — auth-js starts its own ticker on init;
// the listener only reacts to transitions.
//
// Carve-out note: auth-client plumbing, not PostgREST/RPC — same footing as
// sessionWatch.ts, so it lives outside db.ts. Installed once from App.tsx; one
// supabase client serves both the admin and staff stacks.

import { AppState, Platform, type AppStateStatus } from 'react-native';
import { supabase } from './supabase';

const NOOP = () => {};

export function installAuthAutoRefresh(): () => void {
  if (Platform.OS === 'web') return NOOP;
  const auth = supabase.auth as Partial<
    Pick<typeof supabase.auth, 'startAutoRefresh' | 'stopAutoRefresh'>
  >;
  // Defensive: test doubles of the supabase client may not carry these.
  if (typeof auth.startAutoRefresh !== 'function' || typeof auth.stopAutoRefresh !== 'function') {
    return NOOP;
  }
  const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh().catch(() => {});
    } else {
      void supabase.auth.stopAutoRefresh().catch(() => {});
    }
  });
  return () => sub.remove();
}
