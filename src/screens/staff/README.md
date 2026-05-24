# `src/screens/staff/` — staff EOD surface

The staff EOD count app, folded into imr-inventory via spec 063 (previously
a sibling repo at `imr-staff`). Lives as a peer to
[`src/screens/cmd/`](../cmd/) and is mounted by
[`src/navigation/RoleRouter.tsx`](../../navigation/RoleRouter.tsx) when the
authenticated user's `profiles.role === 'user'`.

Per spec 063's "Move VERBATIM" §3 instruction, the subtree retains its own
conventions inherited from imr-staff (Zustand store at
`store/useStaffStore.ts`, its own `notifyBackendError`, direct
`supabase.from / supabase.rpc` calls outside `src/lib/db.ts`). The
CLAUDE.md "DB access centralized" bullet documents `src/screens/staff/*`
as an allowed carve-out — a future spec may migrate these calls into
`db.ts`.

## Subdirectories

- `screens/` — `EODCount.tsx`, `StorePicker.tsx` (sign-in is the shared
  portal at `src/screens/LoginScreen.tsx`)
- `hooks/` — `useConnectionStatus.ts` (NetInfo on native,
  `navigator.onLine` on web), `useEodSubmit.ts` (4-outcome state machine
  + offline queue orchestration)
- `store/useStaffStore.ts` — Zustand store with auth/active store/queue
  slices, AsyncStorage write-through
- `lib/` — `eodQueue.ts` (offline queue helpers with corrupt-payload
  migration), `types.ts`, `uuid.ts`, `notifyBackendError.ts`
- `i18n/` — staff-only catalog (English in v1; `chrome.*`, `eod.*`,
  `auth.error.*` namespaces)
- `navigation/StaffStack.tsx` — inner stack (StorePicker → EODCount)
- `components/` — Button, Input, ListRow, Banner, QueueIndicator,
  ErrorBoundary
- `theme.ts` — staff-local light-only theme

## Backend contract

The staff stack talks to the shared Supabase backend (same project as the
admin Cmd UI) via the `public.staff_submit_eod` RPC. Per-user JWT auth —
staff users have `profiles.role = 'user'` + `user_stores` rows. The RPC
was hardened in spec 061 to enforce `auth_can_see_store()` membership
before any write.

Contract reference: [specs/061-staff-app-eod-count.md](../../../specs/061-staff-app-eod-count.md)
Merge details: [specs/063-fold-imr-staff-into-imr-inventory.md](../../../specs/063-fold-imr-staff-into-imr-inventory.md)
