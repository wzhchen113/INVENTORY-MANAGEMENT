// src/lib/recoveryRedirect.ts — Spec 085.
//
// Two impure helpers kept OUT of the pure parser (`recoveryUrl.ts`) so that
// file's jest test needs no `react-native` / `supabase` / `expo-linking` mock:
//
//   - resolveRecoveryRedirectUrl() — the per-platform `redirectTo` that
//     `sendPasswordReset` (auth.ts) hands to resetPasswordForEmail.
//   - establishRecoverySession() — the chosen-flow client exchange that turns
//     a parsed recovery URL into an authenticated recovery-grant session.
//
// This is a documented carve-out (CLAUDE.md): an auth-path helper that calls
// `supabase.*` directly, running BEFORE the admin store/slice chain is
// initialized — same posture as src/lib/authGate.ts / sessionRestore.ts.

import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { supabase } from './supabase';
import type { RecoveryParse } from './recoveryUrl';

// Stable path used for the recovery landing across platforms. On web the
// Vercel SPA rewrite serves any non-asset route `index.html`, so this path is
// purely (a) a marker for the Supabase redirect-URL allowlist and (b) a
// human-readable URL — the boot gate inspects `?code=` regardless of path.
// Using a stable non-`/` path keeps allowlist entries precise and avoids
// colliding with the dev `?session=` / `?register=` flows that key off `/`.
const RECOVERY_PATH = '/reset-password';

/**
 * Resolve the per-platform `redirectTo` for the recovery email link.
 *
 *   - Web prod: `EXPO_PUBLIC_WEB_RECOVERY_URL` (Q2 — user supplies the value in
 *     Vercel env). Must be a full absolute URL pointing at the recovery path.
 *   - Web dev: `window.location.origin + '/reset-password'` (e.g.
 *     `http://localhost:8081/reset-password`). Works locally with no env var.
 *   - Native: `Linking.createURL('/reset-password')` → `<scheme>://reset-password`.
 *     The scheme is read from app.json — which currently has NO `scheme`
 *     (Q1, user-approval-gated). Until the scheme lands this branch produces a
 *     non-functional URL; it is DEAD CODE on web builds (guarded by Platform.OS)
 *     and is the native half this increment intentionally does not finalize.
 */
export function resolveRecoveryRedirectUrl(): string {
  if (Platform.OS === 'web') {
    const prod = process.env.EXPO_PUBLIC_WEB_RECOVERY_URL;
    if (prod && prod.length > 0) return prod;
    // Local dev fallback — the running Expo web origin.
    return `${window.location.origin}${RECOVERY_PATH}`;
  }
  // TODO(spec-085 Q1): native deep-link requires app.json scheme — pending user
  // approval. Until the `scheme` field is added to app.json, Linking.createURL
  // cannot produce a working `<scheme>://reset-password` URL, so the native
  // recovery half is non-functional. This branch is reachable only on native
  // builds; the web build (Vercel) never executes it.
  return Linking.createURL(RECOVERY_PATH);
}

/**
 * Establish a recovery-grant session in the supabase client from a parsed
 * recovery URL. After this returns `{ ok: true }`, the subsequent
 * `supabase.auth.updateUser({ password })` rides the recovery session.
 *
 * CHOSEN FLOW — token_hash (spec 085 "Flow decision + manual steps"). The
 * recovery session is established by verifyOtp({ token_hash, type: 'recovery' }),
 * which is STATELESS: it carries no client-side code-verifier dependency, so it
 * works cross-device (the realistic admin-initiated case — the admin triggers
 * the reset in THEIR browser, the target clicks the link in a DIFFERENT
 * browser). Verified empirically on the local stack: verifyOtp in a fresh
 * client with empty storage established the recovery session and updateUser
 * succeeded.
 *
 * Why NOT PKCE exchangeCodeForSession: the same empirical test proved PKCE
 * FAILS cross-device — "PKCE code verifier not found in storage" — because the
 * verifier lives in the admin's localStorage, not the target's. The PKCE branch
 * below is retained as a DEFENSIVE same-device fallback only (e.g. if a prod
 * email template still emits the default {{ .ConfirmationURL }} `?code=` link).
 *
 * No `onAuthStateChange` PASSWORD_RECOVERY listener is needed — the session is
 * established by the awaited verifyOtp/exchange call, not an async event.
 */
export async function establishRecoverySession(
  parse: RecoveryParse,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (parse.kind === 'recovery-token-hash') {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: parse.tokenHash,
      type: 'recovery',
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  if (parse.kind === 'recovery') {
    // Defensive same-device PKCE fallback. Fails cross-device by design (see
    // doc above) — the friendly error state catches the failure.
    const { error } = await supabase.auth.exchangeCodeForSession(parse.code);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  if (parse.kind === 'recovery-implicit') {
    // Defensive fallback if a hash-flow link ever arrives: on web,
    // detectSessionInUrl already parsed `#access_token` and set the session —
    // verify it landed via getSession.
    const { data } = await supabase.auth.getSession();
    return data.session
      ? { ok: true }
      : { ok: false, error: 'recovery session missing' };
  }
  // 'error' / 'none' — nothing to exchange.
  return { ok: false, error: 'invalid or expired link' };
}
