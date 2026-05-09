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
