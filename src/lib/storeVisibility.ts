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

/** Minimal structural shape of a brand for name lookup. Both the `brand`
 *  slice (`{ id, name } | null`) and `brandsList` (`Brand[]`) satisfy it. */
type BrandLike = { id: string; name: string };

/**
 * Spec 159 — display name for `brandId`, or `null` when it can't be resolved.
 *
 * The lookup has to merge two slices because neither covers every role:
 * `brandsList` is populated for super-admins (every brand), while regular
 * admins/masters only ever load their own single `brand`. `brand` wins on
 * conflict — it is the brand the session is actually operating in, and it is
 * the one the optimistic rename path updates.
 *
 * Returns `null` (never a placeholder string) for: no `brandId` ("All
 * brands"), an id neither slice knows, and first paint before the brand
 * slice hydrates. Callers pick their own fallback copy — the Dashboard's
 * scope label degrades to the generic "All stores (N)" string, TitleBar
 * degrades to its legacy `inv` prefix.
 *
 * This is a near-duplicate of the inline `brandNameByBrandId` memo in
 * `TitleBar.tsx` — TitleBar was deliberately NOT refactored onto this in
 * spec 159 (it needs *initials*, and touching the title bar is out of that
 * spec's blast radius). Folding it in is a cheap follow-up.
 */
export function brandNameFor(
  brandId: string | null | undefined,
  brand: BrandLike | null | undefined,
  brandsList: BrandLike[],
): string | null {
  if (!brandId) return null;
  if (brand?.id === brandId && brand.name) return brand.name;
  return brandsList.find((b) => b.id === brandId)?.name || null;
}
