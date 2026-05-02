import { useStore } from '../store/useStore';

export type CmdRole = 'admin' | 'staff';

// Maps the existing 3-tier `master | admin | user` to the design's 2-tier
// `admin | staff`. Master and admin both surface the full UI; user is staff.
// Reads currentUser.role from the Zustand store so subscribers re-render on
// role change (e.g. after admin demotes themselves via Studio).
export function useRole(): CmdRole {
  const role = useStore((s) => s.currentUser?.role);
  if (role === 'admin' || role === 'master') return 'admin';
  return 'staff';
}
