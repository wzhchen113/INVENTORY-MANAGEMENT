// src/lib/sessionRestore.ts — cold-start session restore for staff users.
//
// Spec 063 §11.2 — extracted from the staff app's RootStack so the
// admin-side App.tsx can invoke the same logic during its
// `getSession()` cold-start branch (R4), and the existing test
// coverage can target one canonical implementation.
//
// Contract: read the persisted Supabase session; if present, run the
// staff-role + user_stores gate (the same `checkAuthGate` the shared
// LoginScreen invokes post-sign-in). Returns a discriminated union so
// the caller can map each outcome to the right UX (toast + state
// transition).
//
// Side effects: on `'not-staff'` or `'no-stores'` outcomes, the
// underlying `checkAuthGate` invokes `supabase.auth.signOut()` before
// returning — the local session is cleared by the time this function
// resolves. The `'error'` branch does NOT sign out (transient
// infrastructure failure; the caller may retry).
//
// This helper does NOT seed `useStaffStore` itself. Callers (App.tsx
// + a future helper) consume the result and dispatch into the store.
// Keeping side-effects out of the function makes it trivially
// unit-testable with a single supabase.from / auth mock.

import { supabase } from './supabase';
import { checkAuthGate } from './authGate';
import { t } from '../screens/staff/i18n';
import type { UserStore } from '../screens/staff/lib/types';

export type RestoreSessionResult =
  | { ok: true; userId: string; stores: UserStore[] }
  | { ok: false; reason: 'no-session' | 'not-staff' | 'no-stores' | 'error'; message?: string };

/**
 * Cold-start session restore.
 *
 * Reads the cached session (if any), then routes through `checkAuthGate`
 * for the shared role + user_stores check. Returns a tagged union so the
 * caller can map each outcome to the right UX.
 */
export async function restoreSession(): Promise<RestoreSessionResult> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { ok: false, reason: 'error', message: error.message };
  const session = data.session;
  if (!session || !session.user) return { ok: false, reason: 'no-session' };
  const userId = session.user.id;

  const gate = await checkAuthGate(userId, {
    notStaff: t('auth.error.notStaff'),
    noStores: t('auth.error.noStores'),
    generic: t('auth.error.generic'),
  });
  if (!gate.ok) {
    if (gate.reason === 'not-staff') return { ok: false, reason: 'not-staff', message: gate.message };
    if (gate.reason === 'no-stores') return { ok: false, reason: 'no-stores', message: gate.message };
    return { ok: false, reason: 'error', message: gate.message };
  }
  return { ok: true, userId, stores: gate.stores };
}
