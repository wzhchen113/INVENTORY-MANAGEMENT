// src/lib/recoveryUrl.ts — Spec 085.
//
// Pure, dependency-free recovery-URL parser. Imports NOTHING (no `supabase`,
// no React, no `expo-linking`) so it is trivially jest-testable with no native
// mock (spec 085 §3, criteria test #1). It is the single source of truth for
// "is this a recovery URL, and what kind."
//
// Why hand-rolled instead of `expo-linking`'s `Linking.parse`: keeping this
// file import-free means the unit test (`recoveryUrl.test.ts`) runs in the fast
// `node` jest project with zero native shims. The native gate passes the full
// deep-link URL string to `parseRecoveryFromUrl`, which splits the query +
// fragment itself.
//
// Flow choice context (architect §1/§5 + spec 085 "Flow decision"): the CHOSEN
// flow is token_hash — the recovery email's {{ .TokenHash }} emits
// `?token_hash=<hash>&type=recovery`, redeemed by verifyOtp. This was chosen
// over PKCE because the empirical cross-device test proved PKCE's
// exchangeCodeForSession FAILS when the landing browser holds no code-verifier
// (the realistic admin-initiated case: verifier is in the admin's browser).
// token_hash is stateless and works cross-device.
//
// We ALSO defensively parse:
//   - PKCE `?code=` (in case a prod email template still emits the default
//     {{ .ConfirmationURL }}) — handled by establishRecoverySession's
//     exchangeCodeForSession branch (works same-device only).
//   - implicit `#access_token&type=recovery` (hash fallback).
// Supabase puts ERRORS (e.g. otp_expired) in the fragment under implicit and in
// the query under token_hash/PKCE — so we parse BOTH the query and the fragment
// into one merged bag and let `error` win, so an expired link always lands on
// the friendly error state.

export type RecoveryParse =
  // CHOSEN FLOW. token_hash: `?token_hash=<hash>&type=recovery` — redeemed via
  // supabase.auth.verifyOtp({ token_hash, type: 'recovery' }). Stateless /
  // cross-device.
  | { kind: 'recovery-token-hash'; tokenHash: string }
  // Defensive PKCE fallback: `?code=<uuid>` — exchanged via
  // exchangeCodeForSession (same-device only; see Flow decision note).
  | { kind: 'recovery'; code: string }
  // Defensive implicit fallback: `#access_token=...&type=recovery`. On web,
  // detectSessionInUrl already set the session; we just verify it exists.
  | { kind: 'recovery-implicit'; accessToken: string }
  // otp_expired / access_denied / any error fragment → friendly error screen.
  | { kind: 'error'; code: string | null; description: string | null }
  // Not a recovery URL at all → render the normal shell.
  | { kind: 'none' };

/**
 * Merge a query string and a fragment string into a single key→value bag.
 * Both `search` and `hash` may arrive with or without their leading `?`/`#`.
 * Later sources do not override earlier ones for the SAME key, but since the
 * caller passes query first then fragment, and Supabase never duplicates a key
 * across both for the same flow, ordering is not load-bearing — we read
 * specific keys out of the merged bag below.
 */
function mergeParams(search: string, fragment: string): URLSearchParams {
  const merged = new URLSearchParams();
  const ingest = (raw: string) => {
    if (!raw) return;
    const trimmed = raw.replace(/^[?#]/, '');
    if (!trimmed) return;
    const sp = new URLSearchParams(trimmed);
    sp.forEach((value, key) => {
      // Do not clobber an already-seen key (query wins over fragment for the
      // rare duplicate). New keys are added.
      if (!merged.has(key)) merged.set(key, value);
    });
  };
  ingest(search);
  ingest(fragment);
  return merged;
}

/** Internal single parser — every public entry funnels through this. */
function parseMerged(params: URLSearchParams): RecoveryParse {
  // Error wins over everything: an otp_expired link must always reach the
  // friendly error state, never get treated as a (broken) recovery attempt.
  const error = params.get('error');
  const errorCode = params.get('error_code');
  const errorDescription = params.get('error_description');
  if (error || errorCode || errorDescription) {
    return {
      kind: 'error',
      code: errorCode,
      // error_description arrives URL-encoded with `+` for spaces; decode for
      // display. Guard against malformed input.
      description: errorDescription ? safeDecode(errorDescription) : null,
    };
  }

  // CHOSEN FLOW — token_hash happy path. The {{ .TokenHash }} email template
  // emits `?token_hash=<hash>&type=recovery`. Require type=recovery so we don't
  // hijack other token_hash flows (signup, email-change, etc.).
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (tokenHash && type === 'recovery') {
    return { kind: 'recovery-token-hash', tokenHash };
  }

  // Defensive PKCE fallback: a `?code=` link (e.g. a prod email template still
  // emitting the default {{ .ConfirmationURL }}). Same-device only.
  const code = params.get('code');
  if (code) {
    return { kind: 'recovery', code };
  }

  // Defensive implicit fallback: a hash-flow recovery link
  // (#access_token=...&type=recovery). Only treat as recovery when the type
  // is explicitly `recovery` so we don't hijack other hash-token flows.
  // `type` is already read above (shared between the token_hash and implicit
  // branches — both gate on type=recovery).
  const accessToken = params.get('access_token');
  if (accessToken && type === 'recovery') {
    return { kind: 'recovery-implicit', accessToken };
  }

  return { kind: 'none' };
}

/** URLSearchParams already decodes `%xx`, but error_description often uses `+`
 *  for spaces; decodeURIComponent does not. URLSearchParams.get already turns
 *  `+` into a space, so this is mostly belt-and-suspenders for callers that
 *  pass a raw value. Never throws. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Web entry. Pass `window.location.search` and `window.location.hash`
 * verbatim (each may include the leading `?`/`#` or be empty).
 */
export function parseRecoveryFromWebLocation(search: string, hash: string): RecoveryParse {
  return parseMerged(mergeParams(search || '', hash || ''));
}

/**
 * Native entry. Pass the full deep-link URL string (e.g.
 * `imrinventory://reset-password?code=abc` or
 * `imrinventory://reset-password#error=access_denied&error_code=otp_expired`).
 * Splits the query and fragment off the URL by hand so this file stays free of
 * `expo-linking` (keeps the jest test native-mock-free).
 */
export function parseRecoveryFromUrl(url: string): RecoveryParse {
  if (!url) return { kind: 'none' };
  // Split fragment first (everything after the FIRST `#`), then the query
  // (everything after the FIRST `?` in the pre-fragment portion).
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = beforeHash.indexOf('?');
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';
  return parseMerged(mergeParams(search, fragment));
}
