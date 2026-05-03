// Per the architectural decision: this app is admin-only. Store users (staff)
// have a separate app that talks to Supabase via API. Keeping the hook as a
// constant rather than removing it so existing imports keep working — when
// the staff cleanup is done in every consumer, this file goes away.
export type CmdRole = 'admin';

export function useRole(): CmdRole {
  return 'admin';
}
