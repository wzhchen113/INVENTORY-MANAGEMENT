## Code review for spec 025

### Deletion audit

All 17 files listed for deletion in AC1–AC3 are confirmed absent (`AppNavigator.tsx`, `AdminScreens.tsx`, 12 legacy screen files, `IngredientEditor.tsx`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, `lib/api.ts`, `lib/featureFlags.ts`, `db.json`). No orphan imports of any deleted file survive in the `src/` tree.

`App.tsx` collapses correctly: single `<CmdNavigator />`, `bodyBg = Cmd.bg` (no ternary), no `AppNavigator` or `NEW_UI` import. AC8 + AC9 satisfied.

`tsconfig.json` excludes both `supabase/functions/**` and `scripts/**`. AC12 + AC13 satisfied.

The fourth CI job `typecheck-base` in `.github/workflows/test.yml` runs `npm run typecheck` (maps to `tsc --noEmit` on the base config) on `ubuntu-latest` with `timeout-minutes: 10`. AC16 satisfied.

No direct `supabase.from(...)` / `supabase.rpc(...)` calls appear in the new screen or component files. The `sendPasswordReset` function in `src/lib/auth.ts` calls `supabase.auth.resetPasswordForEmail` — this is consistent with the existing pattern that routes auth operations through `auth.ts` and PostgREST/RPC through `db.ts`. AC25 explicitly authorised this call; no violation.

All `window`, `document`, and `URL` API usage in the export helpers is guarded: `triggerDownload` returns early when `Platform.OS !== 'web'`; the `showExport` flag gates `window.location.href` in the self-delete path is wrapped in `if (Platform.OS === 'web')` at `UsersSection.tsx:125`. No web-only API reachable on native.

`useCmdColors()` used throughout both new files; no inline hex literals in component styles.

---

### Critical

No Critical findings.

---

### Should-fix

- `src/screens/cmd/sections/UsersSection.tsx:117–131` + `src/store/useStore.ts:805–810` — **Double toast on self-delete.** `deleteProfile` in the store unconditionally shows an `'info'` toast ("Profile deleted") on success. When the deleted user is self, `handleConfirmDelete` then immediately shows a second `'success'` toast ("Account deleted / Signing out…"). The user sees two overlapping notifications. The non-self path is fine (the store toast is the only one). Fix: suppress the store's generic toast when the caller will show a more specific one — either add a `{ silent?: boolean }` option to `deleteProfile`, or have the self-delete branch skip the success toast in `handleConfirmDelete` and rely on the store's toast, or (simplest) move the store's toast only to the non-self branch by not toasting inside `deleteProfile` at all and letting the caller always toast.

- `src/components/cmd/InviteUserDrawer.tsx:65` — **Dead ternary always resolves to `'user'`.** The form-reset effect sets `role: isMaster ? 'user' : 'user'`. Both branches are identical, so the `isMaster` check has no effect on the initial form value. The comment immediately above it ("Non-master admins can only invite store users") implies the intent was `role: isMaster ? 'admin' : 'user'` as the default when the master might want to invite an admin, OR the ternary should be dropped entirely (`role: 'user'`) since `'user'` is the correct universal default regardless. Either the comment is wrong (and the ternary should be deleted) or the ternary is wrong (and the master branch should default to a different role). Clarify intent; at minimum remove the dead branch.

- `package.json:72` — **`json-server` devDependency is now orphaned.** Its only consumers (`db.json` and the `db` npm script) were deleted in AC3. The package serves no purpose. The spec's "Notes for reviewers" deferred this per "ask before expanding scope" — the note is acknowledged. This should be removed in the immediate follow-up before it causes confusion for new contributors who see a json-server dependency with no corresponding usage. The dep is dev-only so it does not affect the bundle, but a future `npm audit` may flag its version or an `npm outdated` output will include it spuriously.

- `CLAUDE.md:14, 42, 55, 80, 207, 220` — **Dead links and stale conventions text.** Post-deletion, CLAUDE.md still references `src/navigation/AppNavigator.tsx` (line 14), `src/lib/featureFlags.ts` (lines 42, 55), `EXPO_PUBLIC_NEW_UI` (line 55 convention description), `useJsonServerSync.ts` + `db.json` + "`npm run db` script" in the "Possibly-stale legacy data layer" gap description (line 80 — now fully resolved), the `useSupabaseStore.ts` / `useJsonServerSync.ts` / `db.json` "do not modify" list (lines 204–207), and the `AdminScreens.tsx` "Legacy admin screens" section (line 220). The spec listed `README.md` in AC11's modified files but not `CLAUDE.md`. All agents read CLAUDE.md as the project contract; stale links and outdated policy text will mislead future agents. Update the "UI fork via env flag" convention to say "Cmd UI is the only client," collapse the "Legacy — do not modify" list (those files are gone), and update the "Legacy admin screens" section to say the file was deleted.

- `src/screens/cmd/sections/UsersSection.tsx:25–28` vs `src/components/cmd/InviteUserDrawer.tsx:53` — **`useIsMaster` predicate duplicated.** `UsersSection.tsx` defines a local `useIsMaster()` hook (checking `role === 'master' || role === 'super_admin'`). `InviteUserDrawer.tsx` re-derives the same predicate inline (`const isMaster = currentUser?.role === 'master' || currentUser?.role === 'super_admin'`). If the `super_admin` broadening rule ever changes (e.g. a new privileged role is introduced), it needs to be updated in two places. Promote `useIsMaster` to `src/hooks/useRole.ts` alongside `useIsSuperAdmin`, and have `InviteUserDrawer` import and call it.

---

### Nits

- `src/types/index.ts:487` — Stale comment: "readers (legacy `AppNavigator`) assume the field exists." `AppNavigator` has been deleted. Update to name the actual active readers, or drop the clause.

- `src/screens/cmd/sections/ReorderSection.tsx:508` — `fillColor: [26, 26, 24]` is a hardcoded jsPDF RGB triple for the PDF table header row. This cannot use the React Native theme system (jsPDF takes raw RGB). Add a brief comment explaining that this is the PDF-layer equivalent of `C.bg` / the dark header tone, so a future maintainer doesn't try to replace it with a CSS color or a theme token.

- `src/screens/cmd/sections/ReorderSection.tsx:455–558` — `handlePdfExport` is an async module-level function that calls browser-only APIs (`doc.save(filename)`, via jsPDF which internally calls `window.URL.createObjectURL`). It is only ever called from `onPdfPress`, which is itself only reachable when `showExport === true` (which requires `Platform.OS === 'web'`). The guard therefore exists at the call site, not inside the function. A defensive `if (Platform.OS !== 'web') return;` at the top of `handlePdfExport` (mirroring `triggerDownload:380`) would make the function independently safe if the call site ever changes.

- `src/lib/auth.ts:413` — `catch (e: any)` in `sendPasswordReset` is consistent with the existing project-wide `catch (e: any)` pattern. No new violation, but noted because it is the one new function in a file that is otherwise in scope.
