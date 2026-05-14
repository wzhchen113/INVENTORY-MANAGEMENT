## Code review for spec 029

### Critical

None.

### Should-fix

- `src/screens/cmd/sections/UsersSection.tsx:266-268` — `canDelete` for master admins returns `!isSelf` (master cannot delete themselves). This means `handleConfirmDelete` can only reach `isSelf === true` for a non-master admin deleting their own account. Yet the `silent: true` guard is written as `isSelf ? { silent: true } : undefined`, which works correctly today. The latent concern: if `canDelete` logic is ever relaxed so that master admins can delete themselves, `isSelf` will be `true` and the `silent` path will activate — which is the correct behavior. No code change needed, but the comment at line 121 (`// deleteProfile already toasts success; refresh the local list.`) would become incorrect for that future case. A one-line clarification such as `// Non-self delete: deleteProfile already toasts success` would make the code self-documenting and defensive against future canDelete changes. Low blast radius but easy to do now while the context is fresh.

### Nits

- `src/hooks/useRole.ts:29-48` — the blank line before the `useIsMaster` JSDoc block (between `}` closing `useIsSuperAdmin` at line 27 and `/**` at line 29) is absent. `useIsSuperAdmin` has a blank line after the file-level comment and before `export function`. The two hooks are visually adjacent now (no blank line separator), which is a minor readability issue. `useIsSuperAdmin` is separated from the preceding `useRole` by a blank line at line 14; adding one before `useIsMaster`'s JSDoc would be consistent.

- `src/screens/cmd/sections/UsersSection.tsx:48` — `tabId` initial value is `'users.tsx'` — this looks like a tab ID that was set to a filename string, which is an odd convention. This is pre-existing code (spec 025), not introduced by spec 029, so flagging as out-of-scope. (out-of-scope) `tabId` initial value `'users.tsx'` is odd; might warrant renaming to something like `'users'` in a future cleanup pass.

- `src/store/useStore.ts:808-811` — the `// Spec 029 — …` comment inside the `deleteProfile` implementation is accurate and useful, but it says `"used by the self-delete branch in UsersSection, which fires its own success toast"` — a future reader would have to cross-reference to verify. This is a "what" comment rather than a "why" comment. "Why silent exists: callers that emit their own success toast pass `{ silent: true }` so the user doesn't see two overlapping notifications" is more durable. Not a bug.

- `src/components/cmd/InviteUserDrawer.tsx:51-54` — the new comment block explaining the Spec 029 migration (`// Spec 029 — shared hook (replaces the inline...`) is accurate and useful. One minor: the phrase "Same gate semantics" is a bit loose — it's identical semantics, not merely "same". Consider "Identical gate semantics" for precision. Trivial.
