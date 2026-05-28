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
 * Spec 068 §3 — derive the stores a user can access, for the store-chip
 * display in `UsersSection.tsx` `UserRow`. Extracted as a pure helper
 * (spec-033 precedent) so the access predicate is testable in isolation
 * and reusable.
 *
 * Before this spec, `UserRow` rendered the ENTIRE global `stores` array
 * for any admin-tier row, which is why an admin scoped to one brand
 * (e.g. Bobby, admin + 2AM) showed store chips for stores in OTHER
 * brands (Baltimore Seafood). The bug was a pure display artifact — the
 * underlying `user_stores` data is clean (spec 068 §0) — but it
 * misrepresented every admin's real access.
 *
 * The predicate mirrors the `auth_can_see_store()` brand-scoped
 * visibility model (migration 20260517040000_…):
 *
 *   - `super_admin` — sees EVERY brand. Their `brandId` is NULL, so a
 *     `brandId`-match filter would yield an empty list ("no stores
 *     assigned"), which under-reports. Render ALL stores: it is truthful
 *     (they see everything) and the caller already has the array.
 *   - `admin` / `master` — effective store visibility is brand-WIDE, not
 *     their literal `user_stores` rows. An admin scoped to brand X can
 *     operationally see every store in brand X. Render that brand's
 *     stores (`s.brandId === user.brandId`). Rendering literal
 *     `user_stores` here would UNDER-report (Bobby has one grant but sees
 *     all four 2AM stores). Showing OTHER brands' stores was the bug.
 *   - `user` (staff) — access IS the literal `user_stores` grants; render
 *     `stores ∩ user.stores`. Unchanged from the prior behavior.
 *
 * Pure: no React, no Zustand, no network. Same inputs → same output.
 *
 * @param user      the row's `{ role, brandId, stores }` (brandId may be
 *                  null for super_admin / legacy staff; stores is the
 *                  literal user_stores id list).
 * @param allStores the candidate store set (the caller passes the global
 *                  `useStore.stores`; it is already session-brand-scoped
 *                  for a non-super viewer, so the filter is the active
 *                  guard only when a super-admin is viewing a multi-brand
 *                  store cache).
 * @returns the subset of `allStores` the user can access.
 */
export function deriveAccessibleStores<S extends { id: string; brandId: string }>(
  user: Pick<User, 'role' | 'brandId' | 'stores'>,
  allStores: ReadonlyArray<S>,
): S[] {
  if (user.role === 'super_admin') {
    // Sees every brand — render the whole array (truthful, not under-reported).
    return [...allStores];
  }
  if (user.role === 'admin' || user.role === 'master') {
    // Brand-wide access via auth_can_see_store(); render the brand's stores.
    // A super_admin would have brandId === null and is handled above; an
    // admin/master with a null brandId (shouldn't happen per
    // profiles_role_brand_consistent) yields an empty list, which is the
    // correct "no brand → no brand-scoped stores" signal.
    return allStores.filter((s) => s.brandId === user.brandId);
  }
  // `user` (staff) — literal user_stores grants.
  return allStores.filter((s) => user.stores.includes(s.id));
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
