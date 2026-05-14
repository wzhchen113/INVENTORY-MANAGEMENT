# Security audit for spec 029

Audited the four-file diff (`src/hooks/useRole.ts`, `src/screens/cmd/sections/UsersSection.tsx`, `src/components/cmd/InviteUserDrawer.tsx`, `src/store/useStore.ts`) against current `main` (HEAD `5eddbf4`). No migrations, no edge functions, no RPCs, no new auth surfaces, no `package.json` change. Threat model exposure is admin-only Cmd UI — no customer-PWA or staff-app touchpoints. Findings below are organized Critical → High → Medium → Low.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/hooks/useRole.ts:30` (and `src/components/cmd/InviteUserDrawer.tsx:51-54`) — JSDoc / comment refers to gating "the live `profiles.role`". On the wire the predicate reads `useStore((s) => s.currentUser?.role)`, which is *not* the same value the server enforces — it's the client-side mirror populated from `fetchProfile`. The DB-side authority is `auth_is_privileged()` (admin OR master OR super-admin), and the edge-function mirror is `delete-user`'s `ADMIN_ROLES` set. This spec correctly treats `isMaster` as a UI affordance gate only (UsersSection peer-row visibility, invite-drawer role-picker render, delete/reset-PW button generosity). No DB call in any of the four files newly trusts this client value as a security boundary, so this is a documentation polish, not a finding to block on. Mention only so a future contributor doesn't read the JSDoc and conclude `useIsMaster()` is authoritative for authz — it isn't, and never was.

### Verified against the brief's focus areas

1. **Authorization unchanged — confirmed.** The new `useIsMaster` predicate in `src/hooks/useRole.ts:45-48` is byte-equivalent to the two sites it replaces:
   - Pre-029 `src/screens/cmd/sections/UsersSection.tsx:22-28` local hook: `role === 'master' || role === 'super_admin'`.
   - Pre-029 `src/components/cmd/InviteUserDrawer.tsx:53` inline: `currentUser?.role === 'master' || currentUser?.role === 'super_admin'`.
   - Post-029 `src/hooks/useRole.ts:46-47`: `const role = useStore((s) => s.currentUser?.role); return role === 'master' || role === 'super_admin';`.
   The Zustand selector binding (`useStore((s) => s.currentUser?.role)`) is identical to the pre-029 local hook in UsersSection and re-derives the same value the inline `InviteUserDrawer` predicate used. No drift; no role broadening; no role narrowing.

2. **`silent: true` only suppresses the success info-toast — confirmed.** `src/store/useStore.ts:812-819` wraps only the `Toast.show({ type: 'info', text1: 'Profile deleted', ... })` call in `if (!opts?.silent)`. The early-exit `notifyBackendError('Delete profile', new Error(error)); return false;` at line 798 (server-rejected delete) and the catch-block `notifyBackendError('Delete profile', e)` at line 822 (network/transport failure) are unconditional. Cached-list cleanup at lines 802-807 is also unconditional. The error path always reaches the user via `notifyBackendError`'s own `Toast.show({ type: 'error', ... })` at `src/store/useStore.ts:28-33`, which the spec design §3 also confirms ("Failure feedback must always reach the user. The `silent` flag intentionally suppresses only the success info-toast"). No safety-critical suppression introduced.

3. **Self-delete redirect ordering and session invalidation — confirmed.**
   - At `src/screens/cmd/sections/UsersSection.tsx:109-119`, the sequence on `isSelf` is: `Toast.show(...)` (synchronous) → `logout()` → `setTimeout(window.location.href = '/', 1500)`. The toast fires BEFORE `logout()` clears local state and BEFORE the redirect is even scheduled; no race against the redirect.
   - `logout()` at `src/store/useStore.ts:466-475` does three things, in this order: (a) `set({ currentUser: null })` — synchronous clear of the in-memory session view, (b) `clearActiveBrandLocal()` — drops the super-admin's brand override, (c) fire-and-forget `import('../lib/auth').then(({ signOut }) => signOut())` which calls `supabase.auth.signOut()` at `src/lib/auth.ts:50-52`. This invalidates the GoTrue access/refresh token pair both client-side (cleared from localStorage) and server-side (Supabase revokes the refresh token).
   - Server-side, `supabase/functions/delete-user/index.ts:72` calls `supabase.auth.admin.deleteUser(userId)`, which removes the `auth.users` row entirely. After deletion the access-token JWT can still be presented but RLS denies (no row to resolve) and refresh fails because the user is gone. Combined with `signOut()` at the client, the deleted row + invalid session cannot be replayed.
   - The fire-and-forget shape of `signOut()` inside `logout()` is **pre-existing** (not introduced by this spec). There's a theoretical window of ~milliseconds where local `currentUser` is null but the server-side session is still valid before `signOut()` resolves; this window has existed since the helper was added and is not a spec-029 regression. Mentioning for completeness, not as a finding.

4. **Effect-deps regression — not a security issue.** `src/components/cmd/InviteUserDrawer.tsx:60-72` drops `isMaster` from the deps array. The only in-effect reference to `isMaster` pre-029 was the dead identity ternary `role: isMaster ? 'user' : 'user'`, which now reads `role: 'user'`. With zero remaining `isMaster` reference inside the effect body, the dep drop is React-hook-correct. The picker visibility at line 256 still re-renders on `isMaster` flip because `useIsMaster()` subscribes to `currentUser.role` via Zustand at every render. There is no reactive flow where mid-mount role changes need to re-reset the form (the form's only role-derived field is now a constant `'user'`). Not a stale-data hazard.

5. **`npm audit` baseline unchanged — confirmed.** `git diff HEAD -- package.json package-lock.json` returned no output. No new dependencies, no version bumps. The `npm audit` baseline is identical to spec 028 — audit skipped per the brief.

### Additional checks performed

- **No new edge-function role gates touched.** Spec 029 does not introduce a new edge function or alter any existing `ADMIN_ROLES` set; the spec-027 super-admin parity gate is not at risk here. The architect design §7 explicitly carved this out.
- **No new HTML interpolation surfaces.** No file in scope renders HTML to an email or external channel. The spec-028 `escapeHtml` invariant is not at risk.
- **No new RLS or migrations.** Zero `supabase/migrations/` or `supabase/functions/` changes. Per-store RLS via `auth_can_see_store()` and admin RLS via `auth_is_admin()` are untouched.
- **No PII / secret leakage.** The `Toast.show({ text1: 'Profile deleted', text2: 'Both profile row and auth user have been removed.', ... })` text is generic and does not embed the deleted profile's email, name, or UUID. `notifyBackendError` formats the error as `${action} failed: ${e?.message || String(e)}` — `e.message` from `lib/auth.deleteUser` is bounded ("Failed to delete user" fallback or the edge function's JSON error body, e.g. `"cannot delete self"` / `"forbidden"`), so no stack traces, no SQL fragments, no other-store rows leak.
- **No `EXPO_PUBLIC_*` secret risk.** None of the four files read `process.env.EXPO_PUBLIC_*` directly. The store imports `supabase` indirectly via `src/lib/auth` (unchanged), which itself uses `EXPO_PUBLIC_SUPABASE_URL` and the publishable anon key — pre-existing and correct.
- **`useRole()` placeholder is not used as a security boundary anywhere in this spec.** The intentional placeholder at `src/hooks/useRole.ts:11-13` is untouched. The new `useIsMaster()` reads the live `currentUser.role` from Zustand, not the placeholder. Per the brief, the placeholder is explicitly NOT a finding; this spec correctly avoids regressing it.

### Pre-existing observation (out of scope for this spec, but surfaced for hygiene)

`supabase/functions/delete-user/index.ts:59` rejects self-delete with `HTTP 400 "cannot delete self"`. This was committed in `9e14528 Harden edge functions` well before spec 029 and is therefore not a regression introduced here. However, it does mean the manual-smoke step in spec 029's AC §3 ("self-delete shows exactly ONE success toast and the window navigates to `/` after ~1.5s") would not reach the success codepath in production — the call resolves with `{ error: 'cannot delete self' }`, `notifyBackendError` fires, `if (!ok) return` short-circuits at `UsersSection.tsx:107`, the modal stays open, and `logout()` is never called. From a **security** standpoint this is benign — the server correctly refuses to delete the caller's own row, the session stays valid for an account that genuinely still exists, and there is no auth-state inconsistency. From a UX / acceptance-criteria standpoint, code-reviewer / test-engineer may want to flag the inconsistency between the spec's self-delete flow and the edge function's hard-block. Not a security finding; routed here only because the brief asked me to verify "the deleted row + invalid session can't be replayed" — they can't, because in practice the row doesn't get deleted via this path.

### Dependencies

No `package.json` changes — skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low. Spec 029 is a pure-frontend polish trio with zero new auth surface, zero RLS impact, and zero edge-function changes; the `useIsMaster` extraction is byte-equivalent to the pre-029 inline predicates, the `silent: true` flag is correctly scoped to the success info-toast only (errors and cached-list cleanup remain unconditional), and the dropped effect dep in `InviteUserDrawer` is React-hook-correct (no remaining in-effect reference and no security-relevant reactive flow). No findings block release.
payload_paths:
  - specs/029-frontend-polish-trio/reviews/security-auditor.md
