# Security audit for spec 146 — Phone tier for Users & access (+ INVITE)

Scope verified against `git show 1661d54 --stat`: frontend-only. New
`PhoneUsers.tsx` + tests; host `UsersSection.tsx` gains an `isPhone` guard and a
`model` bundle lifting the user list, `lastOfRole`, overlay state, and the
delete/reset/invite handlers; i18n additions. No migration, edge function, RLS,
or `src/lib/db.ts` contract change — matches the spec's frontend-only claim.

This is the auth-sensitive screen in the batch (delete/reset/invite), so I
audited the destructive-action discipline specifically.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- None.

### Notes (not findings)
- **Delete gating preserved.** `PhoneUsers` computes `canDelete` via the shared
  `canDeleteUser({ isMaster, isSelf, targetRole, lastOfRole })`
  (`PhoneUsers.tsx:101-106`) — the same predicate the desktop `UserRow` uses.
  `lastOfRole` is lifted verbatim from the host (`UsersSection.tsx` model bundle),
  not recomputed. The DELETE affordance arms the reused `TypeToConfirmModal`
  (type-the-email confirm) bound to the host's `handleConfirmDelete`
  (`PhoneUsers.tsx:284-303`) — no forked delete orchestration.
- **Self-guard preserved.** `isSelf` (`user.id === model.currentUserId`) drives
  both the delete-modal copy (`deleteSelfTitle`/`deleteSelfBody`) and the
  `canDeleteUser` / `canResetPassword` predicates. The client-side gate is
  cosmetic; the authoritative self-guard + last-of-role checks live in the
  `delete-user` edge function and the SECURITY DEFINER RPCs, which this spec does
  not touch. No client-side role value is used as the security boundary — the
  server path (edge function + RLS) is unchanged.
- **Reset gating preserved.** `canResetPassword` (`PhoneUsers.tsx:107-109`)
  mirrors the desktop predicate (master: not-self, not master/super_admin;
  non-master: only `user` role, not self). Routes to the host's `handleSendReset`.
- **Invite reuses the production drawer.** `InviteUserDrawer` is mounted verbatim
  (`PhoneUsers.tsx:278-282`) — the real validated `inviteUser` edge-function path,
  with role-chip visibility still gated by `useIsMaster` inside the drawer. No
  reduced/forked invite form.
- No `supabase.from/rpc` in `PhoneUsers.tsx`; store visibility via the shared
  `deriveAccessibleStores` helper. No secrets, no `console.*`, no PII in logs
  (emails render in UI only, never logged).

### Dependencies
No `package.json` changes — `npm audit` skipped.
