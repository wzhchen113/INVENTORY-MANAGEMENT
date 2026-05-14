// Per the architectural decision: this app is admin-only. Store users (staff)
// have a separate app that talks to Supabase via API. The legacy `useRole()`
// placeholder hardcodes 'admin' for back-compat; it's slated for removal
// when every consumer migrates off it. The new `useIsSuperAdmin()` hook
// below (Spec 012b) is permanent — it gates the BrandPicker, the TENANCY
// sidebar group, and the SUPER ADMIN RoleBadge variant.
import { useStore } from '../store/useStore';

export type CmdRole = 'admin';

export function useRole(): CmdRole {
  return 'admin';
}

/**
 * Spec 012b — single source of truth for super-admin gating in the Cmd UI:
 *   - Sidebar "Brands" item visibility (cmdSelectors)
 *   - Brand picker visibility (TitleBar / MobileTopAppBar)
 *   - BrandsSection access (defensive — sidebar gate is the primary)
 *
 * Reads the live profiles.role via useStore.currentUser. Non-super-admin
 * (admin/master/user/null) returns false.
 */
export function useIsSuperAdmin(): boolean {
  const role = useStore((s) => s.currentUser?.role);
  return role === 'super_admin';
}

/**
 * Spec 029 — single source of truth for the "treated as master" gate
 * in the Cmd UI. Returns true iff the live profiles.role is `'master'`
 * or `'super_admin'`. Gates:
 *   - Invite-user drawer: role-picker visibility (admin vs. user).
 *     Non-master admins are hard-locked to inviting `role='user'`.
 *   - UsersSection: peer-row visibility filter (non-master admins do
 *     not see master/super_admin rows).
 *   - UsersSection's UserRow: delete + reset-password gate generosity.
 *
 * Reads the live profiles.role via useStore.currentUser. Non-master
 * (admin/user/null) returns false. Mirrors `useIsSuperAdmin`'s shape;
 * the two are intentionally separate hooks because the gates differ
 * (super-admin alone gates BrandPicker / TENANCY sidebar group; master
 * + super-admin together gate the user-management affordances above).
 */
export function useIsMaster(): boolean {
  const role = useStore((s) => s.currentUser?.role);
  return role === 'master' || role === 'super_admin';
}
