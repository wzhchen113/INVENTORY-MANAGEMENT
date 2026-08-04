// src/lib/storeVisibility.ts — Spec 150.
//
// THE store-visibility predicate: "which stores may this user actually open,
// under the active brand context?"
//
// It used to be copy-pasted, byte for byte, into TitleBar's desktop store
// switcher and PhoneStoreSwitch's phone sheet, and then a THIRD variant grew
// inside useStore when the active-brand validation landed. Three copies of one
// rule is exactly the drift surface that made the spec-150 bug hard to reason
// about ("is the phone narrower than desktop?" — it wasn't, but nothing in the
// code said so). All three now call this function.
//
// Deliberately a standalone pure module rather than an export off
// `useStore.ts`: component tests routinely `jest.mock('../../store/useStore')`
// wholesale, which would stub the shared predicate out of the very surfaces
// that are supposed to be sharing it. It also can't live in
// `lib/cmdSelectors.ts` — that module imports `hooks/useRole`, which imports
// `useStore`, so `useStore` importing it back would close a require cycle.
//
// No React, no store, no I/O — just types.

import type { Store, User } from '../types';

/** Roles that see every store the RLS layer returned, independent of their
 *  `user_stores` grants. Mirrors `public.auth_is_privileged()` on the DB side
 *  (admin / master / super-admin); the DB remains the real gate — this is the
 *  client-side rendering rule, not an authorization decision. */
export function isPrivilegedRole(user: User | null): boolean {
  return user?.role === 'admin' || user?.role === 'master' || user?.role === 'super_admin';
}

/**
 * Stores the given user may open, narrowed to `brandId`.
 *
 * - Privileged roles (see `isPrivilegedRole`) get every store in `stores`;
 *   everyone else gets only their `user_stores` grants.
 * - `brandId === null` means "All brands" — no brand narrowing.
 * - A `null` user resolves to `[]` (fail closed). Callers that need a
 *   "user not known yet" branch must handle it explicitly rather than
 *   relying on this function to guess.
 *
 * Order is preserved from `stores`, so `[0]` is a stable "first visible
 * store" for the callers that need a landing pick.
 */
export function visibleStoresFor(
  stores: Store[],
  user: User | null,
  brandId: string | null,
): Store[] {
  return (isPrivilegedRole(user) ? stores : stores.filter((s) => user?.stores?.includes(s.id)))
    .filter((s) => brandId === null || s.brandId === brandId);
}
