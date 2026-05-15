// src/utils/userPermissions.ts
//
// Spec 033 §AC3.1 — pure-helper extraction from
// `src/screens/cmd/sections/UsersSection.tsx` so the DELETE-button gate
// and the "last-of-role" derivation become testable in isolation.
//
// No React, no Zustand, no `db.ts`, no `supabase` imports. The helpers
// are pure: same inputs → same output, no side effects.
//
// The server is the authoritative gate — `delete-user` enforces self-
// delete refusal + peer-role refusal, and `public.assert_not_last_of_role`
// enforces last-super_admin / last-master refusal (spec 031). The helpers
// here are the UX mirror: they hide the DELETE button when the server
// would refuse. NOT a security boundary.
import { User } from '../types';

/**
 * Spec 030/031 — UX-layer mirror of the server-side DELETE gates the
 * `delete-user` edge function enforces (self-delete refusal, peer-role
 * gate for non-master admins) and `public.assert_not_last_of_role`
 * enforces (no deletion of the last super_admin / master). Hides the
 * DELETE button when the server would refuse. The server is the
 * authoritative gate; this helper is a UX hint, NOT security.
 *
 * Lifted verbatim from UsersSection.tsx:284-288 (spec 033 §AC3.1) —
 * the boolean expression is preserved byte-for-byte so the refactor is
 * a no-op.
 *
 * @param args.isMaster   - true iff caller role is 'master' or 'super_admin'
 *                          (from useIsMaster()).
 * @param args.isSelf     - true iff the target row is the caller's own
 *                          profile row.
 * @param args.targetRole - role of the target profile row.
 * @param args.lastOfRole - `{ super_admin, master }` flags; each is true
 *                          when the global count of rows with that role
 *                          is <= 1. Derive via `deriveLastOfRole(rawUsers)`.
 * @returns true iff the caller may delete the target.
 */
export function canDeleteUser(args: {
  isMaster: boolean;
  isSelf: boolean;
  targetRole: User['role'];
  lastOfRole: { super_admin: boolean; master: boolean };
}): boolean {
  const { isMaster, isSelf, targetRole, lastOfRole } = args;
  return (isMaster
    ? !isSelf
    : !isSelf && targetRole !== 'admin' && targetRole !== 'master' && targetRole !== 'super_admin')
    && !(targetRole === 'super_admin' && lastOfRole.super_admin)
    && !(targetRole === 'master'      && lastOfRole.master);
}

/**
 * Spec 031 — derive last-of-role flags from a user list. Counts rows
 * per role; returns true when the count is <= 1 (zero or one — the
 * defensive empty-array case still hides the DELETE button rather than
 * showing it).
 *
 * Lifted verbatim from UsersSection.tsx:76-79.
 *
 * @param users the FULL fetched user array (rawUsers), NOT the visible
 *              subset — counts must match what the server sees for the
 *              caller's brand scope.
 * @returns `{ super_admin, master }` boolean flags.
 */
export function deriveLastOfRole(
  users: ReadonlyArray<{ role: User['role'] }>,
): { super_admin: boolean; master: boolean } {
  return {
    super_admin: users.filter((u) => u.role === 'super_admin').length <= 1,
    master:      users.filter((u) => u.role === 'master').length <= 1,
  };
}
