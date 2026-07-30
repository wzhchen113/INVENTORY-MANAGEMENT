## Code review for spec 146 (Phone tier — Users & access)

Reviewed: `src/screens/cmd/sections/phone/PhoneUsers.tsx`, the
`UsersSection.tsx` guard + model lift, `phone/__tests__/PhoneUsers.test.tsx` /
`.acReg.test.tsx`, and the three i18n catalogs.

### Critical
None found.

### Should-fix
None found. `rolePillTone` is a pure, unit-testable mapping that never returns
the accent; `canDeleteUser` / `deriveAccessibleStores` / `deriveLastOfRole` are
reused verbatim from `utils/userPermissions`, not re-implemented; the
`requiredText` fed to `TypeToConfirmModal` (`model.deleteTarget.email ||
model.deleteTarget.name`) matches the desktop's own
`deleteTarget.email || deleteTarget.name || ''` byte-for-byte
(`UsersSection.tsx:271`). The guard (`UsersSection.tsx:136`) sits after all
hooks, and because the phone branch early-returns before the desktop's own
`InviteUserDrawer` / `TypeToConfirmModal` JSX, the two overlay instances never
double-mount, as the spec claims.

### Nits
- `src/screens/cmd/sections/phone/PhoneUsers.tsx:107-109` — `canResetPassword`
  is recomputed inline in `UserDetail` with a ternary duplicating the same
  branching (`isMaster ? … : …`) `UsersSection.tsx:320` already encodes for the
  desktop `UserRow`. Not wrong (values match), but it's inline business logic
  living in a presentational component rather than a pure exported helper next
  to `canDeleteUser` — a good candidate to promote to `userPermissions.ts` for
  a single source of truth, the same treatment `canDeleteUser` already got.
- `src/screens/cmd/sections/phone/PhoneUsers.tsx:220` — the row's `name`
  fallback chain is `u.name || u.email || '—'`, while the detail's title
  (`:133`) is `user.name || '—'` (no email fallback). Minor inconsistency
  between the two surfaces for the same underlying data; harmless in practice
  since a user without a name almost always still has an email shown on line 2,
  but worth a beat of intentionality.

Overall: no direct Supabase calls (all reads are `useStore` slices / props),
no hardcoded hex, no `Alert.alert`/`window.confirm` (delete uses the reused
`TypeToConfirmModal`, not a bespoke confirm), role pills use `info`/`ok`/neutral
tokens and never the accent.

## Handoff
next_agent: NONE
prompt: Code review complete for spec 146. 0 Critical, 0 Should-fix, 2 Nits.
payload_paths:
  - specs/146-phone-users-tier/reviews/code-reviewer.md
