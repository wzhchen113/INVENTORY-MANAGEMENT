// src/lib/usernameValidation.ts
//
// Spec 095 — client-side username format + reserved-name validator. This is
// the TS mirror of the server-side authority:
//   - the DB `profiles_username_format` CHECK (length 3–20, allowed chars
//     [A-Za-z0-9_.]); and
//   - the reserved-name list, which the backend-architect placed in the
//     SHARED validator (not a DB CHECK — see spec 095 §(d): a DB CHECK with a
//     hardcoded IN-list is awkward to evolve, and the backfill is exempt from
//     the reserved list).
//
// The server STILL validates: the `profiles_username_lower_key` UNIQUE index
// is the collision authority (surfaced as a 23505 → "username taken"), and
// the format CHECK rejects bad shapes regardless of what the client sends.
// This module exists purely for UX — to give the admin a clear inline error
// before the round trip. TS↔SQL parity is a code-review checkpoint (like
// `escapeHtml.ts`).
//
// Pure TS, no React / RN imports, so it lives in the fast node-env jest
// project.

/** Allowed-character + length rule, mirroring the DB CHECK
 *  `username ~ '^[A-Za-z0-9_.]+$'` AND `char_length BETWEEN 3 AND 20`. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_FORMAT_RE = /^[A-Za-z0-9_.]+$/;

/**
 * Reserved usernames blocked on forward admin assignment (spec 095 §(d)).
 * Compared case-insensitively. The backfill is intentionally EXEMPT — a
 * reserved-derived backfilled name (e.g. `admin` from `admin@2am.com`) is
 * acceptable and admins can reassign later — so this list is enforced ONLY in
 * the admin assignment UI, never in the resolver or backfill.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'root',
  'master',
  'superadmin',
  'super_admin',
  'support',
  'system',
  'null',
  'undefined',
  'me',
  'owner',
]);

export type UsernameValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a username for ADMIN ASSIGNMENT (invite / user creation).
 *
 * Returns `{ ok: true }` when the trimmed value satisfies length + charset
 * AND is not reserved. Otherwise returns `{ ok: false, error }` with a
 * human-readable message suitable for inline display in the invite drawer.
 *
 * NOTE: this is NOT the login path. The login portal collapses every failure
 * into ONE generic error (no enumeration oracle); admin assignment is an
 * authenticated, brand-scoped action and intentionally surfaces specific,
 * actionable errors. Uniqueness is NOT checked here — the server's UNIQUE
 * index is the authority (23505 → "username taken").
 */
export function validateUsername(input: string): UsernameValidationResult {
  const value = input.trim();

  if (value.length === 0) {
    return { ok: false, error: 'Username is required' };
  }
  if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Username must be ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters`,
    };
  }
  if (!USERNAME_FORMAT_RE.test(value)) {
    return {
      ok: false,
      error: 'Username may only contain letters, numbers, underscore (_), and dot (.)',
    };
  }
  if (RESERVED_USERNAMES.has(value.toLowerCase())) {
    return { ok: false, error: 'That username is reserved. Please choose another.' };
  }
  return { ok: true };
}

/** Convenience boolean form for call sites that only need a yes/no. */
export function isValidUsername(input: string): boolean {
  return validateUsername(input).ok;
}
