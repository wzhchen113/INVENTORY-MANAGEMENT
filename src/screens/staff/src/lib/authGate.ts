// src/lib/authGate.ts — shared auth gate logic.
//
// Spec 062 §B3 / §2 — the role + user_stores check is run in two
// places (post-sign-in inside SignIn, and cold-start inside RootStack).
// This helper is the single source of truth so any future gate change
// (extra role check, new error message, etc.) lands in one place.
//
// The helper signs the caller OUT on hard failures ('not-staff' /
// 'no-stores') before returning, so callers only need to handle the
// presentation layer (toast + state transition). The 'error' branch
// indicates an infrastructure failure and does NOT sign out — callers
// can surface a retry to the user.
//
// Reference shape: imr-inventory's auth helpers in src/lib/auth.ts.
// The staff app's gate is intentionally simpler (no JWT inspection).
//
// Tests for the gate logic live in the screen tests that exercise it
// end-to-end (`SignIn.test.tsx`) and the navigator test
// (`RootStack.test.tsx`) — extracting a helper test would duplicate
// the supabase-from mock plumbing.
//
// NOTE: we do not sign out on the 'error' branch — that path indicates
// an infrastructure failure (Supabase down) rather than a deterministic
// gate denial. Callers decide whether to surface a retry.

import { supabase } from './supabase';
import type { UserStore } from './types';

export type AuthGateResult =
  | { ok: true; stores: UserStore[] }
  | { ok: false; reason: 'not-staff'; message: string }
  | { ok: false; reason: 'no-stores'; message: string }
  | { ok: false; reason: 'error'; message: string };

/**
 * Run the role + user_stores gate for the given signed-in user.
 *
 * Side effects: on 'not-staff' or 'no-stores' the helper invokes
 * `supabase.auth.signOut()` BEFORE returning. The 'error' branch does
 * NOT sign out — callers may retry.
 *
 * @param userId  - auth.uid() of the signed-in user
 * @param messages - i18n-resolved error messages to attach to failure
 *   results. Passed in so the helper doesn't import the i18n module
 *   (keeps it side-effect-free for testing).
 */
export async function checkAuthGate(
  userId: string,
  messages: { notStaff: string; noStores: string; generic: string },
): Promise<AuthGateResult> {
  // Role check
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (profileErr) {
    return { ok: false, reason: 'error', message: profileErr.message || messages.generic };
  }
  if (!profile || profile.role !== 'user') {
    await supabase.auth.signOut().catch(() => {});
    return { ok: false, reason: 'not-staff', message: messages.notStaff };
  }

  // user_stores check (join store name)
  const { data: rows, error: storesErr } = await supabase
    .from('user_stores')
    .select('store_id, store:stores(id, name)')
    .eq('user_id', userId);
  if (storesErr) {
    return { ok: false, reason: 'error', message: storesErr.message || messages.generic };
  }
  const stores: UserStore[] = (rows ?? [])
    .map((r: { store_id: string; store: { id: string; name: string } | { id: string; name: string }[] | null }) => {
      const s = Array.isArray(r.store) ? r.store[0] : r.store;
      if (!s) return null;
      return { storeId: s.id, storeName: s.name };
    })
    .filter((x): x is UserStore => x !== null);
  if (stores.length === 0) {
    await supabase.auth.signOut().catch(() => {});
    return { ok: false, reason: 'no-stores', message: messages.noStores };
  }
  return { ok: true, stores };
}
