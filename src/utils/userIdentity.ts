// src/utils/userIdentity.ts — Spec 165 §7.
//
// Display helpers for username-only (placeholder-email) accounts, so screens
// never hand-roll the rule. Screens read `User.loginKind` (set by the data
// layer — fetchAllUsers / fetchBrandAdmins) and NEVER test the email shape
// themselves; the one shape predicate lives in src/lib/placeholderEmail.ts.
//
// Pure TS (no React / RN imports) so it runs in the node-env jest project.

import type { User } from '../types';

/** True when the account signs in by username only (placeholder email).
 *  `undefined` loginKind (older fixtures / sessions) is treated as 'email'. */
export function isUsernameLogin(u: Pick<User, 'loginKind'>): boolean {
  return u.loginKind === 'username';
}

/** Spec 165 — the email-or-username identity line shown under a user's name.
 *  Username-only accounts render `@username<sep>marker` (just the marker when
 *  there is no username); their placeholder email is never read. Email
 *  accounts render the email, or `emailFallback` when it is missing.
 *  `marker` is the caller's translated "username sign-in" text, so this stays
 *  a pure-TS helper (no i18n import). */
export function userIdentityLine(
  u: { loginKind?: User['loginKind']; email?: string | null; username?: string | null },
  marker: string,
  opts: { emailFallback?: string; separator?: string } = {},
): string {
  const { emailFallback = '', separator = ' · ' } = opts;
  if (isUsernameLogin(u)) {
    return [u.username ? `@${u.username}` : null, marker].filter(Boolean).join(separator);
  }
  return u.email || emailFallback;
}

/** The string an admin must type in a delete type-to-confirm modal.
 *  Username accounts: `username || name`; email accounts: `email || name`.
 *  Never returns an email for a username account. */
export function userConfirmText(
  u: Pick<User, 'loginKind' | 'email' | 'username' | 'name'>,
): string {
  if (isUsernameLogin(u)) return u.username || u.name || '';
  return u.email || u.name || '';
}

/** Spec 165 §7 — map a `manage-store-user` error string (the stable §4.6
 *  table) to toast copy. Shared by AddStoreUserDrawer and
 *  SetStoreUserPasswordModal so the mapping can't drift between them.
 *  `username` is only used for the taken-username message. */
export function storeUserErrorText(error: string, username?: string): string {
  if (error === 'username taken') {
    return username ? `Username "${username}" is already taken` : 'That username is already taken';
  }
  if (error.startsWith('forbidden')) {
    return "You don't have permission to manage users in this brand.";
  }
  return error;
}
