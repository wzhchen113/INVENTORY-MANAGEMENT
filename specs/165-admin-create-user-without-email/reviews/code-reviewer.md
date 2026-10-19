## Code review for spec 165

Scope note: the review tooling here had no shell, so `git diff --cached` was not run. I read the spec's `## Files changed` list in full. For modified files I read the changed regions, located by grep on the spec 165 symbols. The unchanged parts of those files were not re-reviewed.

### Critical
- None.

### Should-fix
- `package.json:18` (and `tests/README.md:36,403-412`) — the new `scripts/smoke-store-user.sh` is not registered in the `test:smoke` track. `test:smoke` still lists only `smoke-edge.sh && smoke-rpc.sh && smoke-edge-roles.sh`, and the README says "runs all three". The script follows the right pattern (pass/fail/skip, EXIT trap, local-only refusal), but `npm run test:smoke` will never run it, and the README does not mention it. Add it to the `test:smoke` chain and to the README script list. This is a test-track convention item, so coordinate with test-engineer.

- `src/screens/cmd/sections/BrandsSection.tsx:1062-1073` (your flag 1) — the delete-confirm `requiredText` for **email** accounts changed as well, not only for username accounts.
  - Design §7 does say to use `userConfirmText` at this site, so this is design-compliant.
  - Spec AC D only requires a change for placeholder accounts. The Brands email path went from "type the name" to "type the email".
  - `src/screens/cmd/sections/__tests__/BrandsSection.members.spec165.test.tsx:130-134` now pins the new behavior, so the change is easy to miss in release notes.
  - Either keep name-first for email accounts here (use `userConfirmText` only when `isUsernameLogin(target)`), or record the change explicitly in the release proposal so the owner knows the confirm text changed. I would not leave it implicit.

- `src/components/cmd/AddStoreUserDrawer.tsx:319-356` and `src/components/cmd/SetStoreUserPasswordModal.tsx:191-237` — the password entry block is duplicated line for line across the two **new** files. Both have a secure `TextInput` with the same props (`autoComplete="new-password"`, `textContentType`, web outline style), a SHOW/HIDE toggle, and an "at least N characters" error line. The sheet header and footer chrome is also near-identical.
  - These two files will drift (for example, a future "strength hint" or a paste-guard).
  - Extract a small `PasswordField` (value, onChange, testIDs, error visibility) into `src/components/cmd/`, and optionally a shared header/footer. Both files already import the same helpers.

- Hard-coded `'username sign-in'` marker in five places, plus three hand-rolled copies of the "`@username · marker`" line:
  - `src/screens/cmd/sections/UsersSection.tsx:442` and `:447-453`
  - `src/screens/cmd/sections/BrandsSection.tsx:979` and `:1066`
  - `src/components/cmd/CascadePreviewModal.tsx:340`
  - `src/screens/cmd/sections/phone/PhoneUsers.tsx:108-115` (this one is correct: it uses `T('section.users.phone.usernameSignIn')`)
  
  The i18n key already exists in en/es/zh-CN and `T` is already in scope in `UsersSection` and `MembersTab`. Today an es/zh-CN admin sees the localized marker on phone and the English marker on desktop for the same account. Use `T('section.users.phone.usernameSignIn')` on the desktop surfaces. While there, add one `userIdentityLine(u, markerText)` helper to `src/utils/userIdentity.ts`, so the line is built once instead of in three places.

### Nits
- `src/components/cmd/SetStoreUserPasswordModal.tsx:69` — the document-level handler saves on plain `Enter`. With keyboard focus on CANCEL or the SHOW toggle, Enter submits the new password instead of activating the focused button. Restrict plain Enter to when the event target is the password input, or drop it and keep Cmd+S / Cmd+Enter as in `AddStoreUserDrawer`.

- `src/lib/placeholderEmail.parity.test.ts` — the file name says "placeholderEmail" but it also holds the reserved-usernames parity and the `no-email.invalid` lint. This is fine functionally; the name is just narrower than the content. Consider `inlineCopies.parity.test.ts` (or similar). The comment in `src/lib/usernameValidation.ts:37-38` points at it by name, so update that too if you rename.

- `src/lib/auth.ts:651-663`, `src/lib/db.ts:5522-5533`, `src/lib/db.ts:5272-5282` — the same "placeholder → clear email, skip invitation fallback, set `loginKind`" rule appears three times. The design prescribes this, and it is small. A tiny `resolveLoginIdentity(rpcEmail)` helper returning `{ email, loginKind, usernameLogin }` would stop a fourth mapper from forgetting the invitation-fallback skip. Both `fetchAllUsers` and `fetchBrandAdmins` end in `as User`, which hides that `loginKind: usernameLogin ? 'username' : 'email'` is not literal-typed. An explicit `: User` on the map callback would keep the type check.

- `src/utils/userIdentity.ts:28-40` — `storeUserErrorText` maps server errors to toast copy, but the file is documented as "display helpers for username-only accounts". It is shared by the drawer and the modal, so it is reasonable, but the file header should mention it (or move it next to `createStoreUser`).

- `src/components/cmd/CascadePreviewModal.tsx:340` — compares `p.loginKind === 'username'` directly. `isUsernameLogin(p)` already accepts `Pick<User,'loginKind'>`, and the blocking-profile type satisfies it. Use the helper for consistency, since the spec intent is that screens do not hand-roll the rule.

- `src/screens/cmd/sections/phone/PhoneUsers.tsx:108-115` and `:147` — the username appears twice in the phone detail: in the identity line (`@marcus.l · username sign-in`) and again in the PROPERTIES USERNAME row. Harmless, but redundant.

- `supabase/functions/manage-store-user/index.ts:198,205` — the `catch (_e)` blocks in `compensate` swallow the error entirely. Design §4.5 permits logging `error.code`/`status`. One `console.error("...", e?.code)` per branch would make a partial-cleanup incident diagnosable from the function logs, without leaking the body.

- `supabase/functions/manage-store-user/index.ts:98` — `(userRes.user.app_metadata as any)?.role`. This is verbatim from `delete-user` and is acceptable under the "copied verbatim" design. A one-line `as { role?: string }` would be cleaner if you are ever editing both copies.

- (out-of-scope) `src/components/cmd/AddStoreUserDrawer.tsx:440-485` — `inputStyle` / `Field` and the store multi-select block (`:358-434`) are copies of `InviteUserDrawer` code. `Field` is not exported there, and the spec says to leave the invite drawer untouched, so I am not asking for this change here. It is the natural follow-up if a third sheet needs them.

- `scripts/smoke-store-user.sh:369` — "Arm 8b" is placed after Arm 15, and the header index doesn't list it. Cosmetic.

- `e2e/add-user.spec.ts:32-82` — if the test fails midway, the `zz_e2e_*` account is left in the local stack, because cleanup is part of the happy path. The username is per-run unique, so a rerun is unaffected. A `test.afterEach` delete would make the spec self-healing; not required.

### Responses to the three flags
1. BrandsSection `requiredText` change — see the Should-fix above. It follows design §7 but changes email-account behavior beyond AC D; confirm or narrow.
2. `MembersTab` / `DeleteProfileModal` exported for tests — fine. It matches the existing `StoresTab` export precedent (`BrandsSection.tsx:1097`), the comments say why, and nothing else imports them.
3. `manage-store-user` not type-checked with Deno — I read the whole file against the supabase-js and Deno signatures and found no type errors. The checks included the `AdminGate` discriminated-union narrowing, the `Promise.all` tuple with a PostgREST builder, the `AuthError` to `AuthErrorLike` assignability, and the `SupabaseClient` value import used as a type. The function has run against the local edge runtime in smoke, which proves it loads, but the runtime does not type-check. Run `deno check supabase/functions/manage-store-user/index.ts` once on a machine that has Deno before deploy, or note in the release proposal that it was not done.

### Convention checklist (no findings)
- `callEdgeFunction`: both wrappers (`src/lib/auth.ts:705,724`) use it. There is no raw `fetch`, and neither wrapper logs. The tests pin the password's absence from console and toast.
- Inline-not-shared parity: the placeholder block is byte-identical across the TS canonical and four Deno copies, with `export` kept outside the block. The reserved-usernames block is byte-identical between `usernameValidation.ts` and `manage-store-user`. The parity test fails on 0 or more than 1 block, and also lints shipped `src/**` for `no-email.invalid`.
- Phone guard-after-hooks: `addOpen` and `setPasswordTarget` are declared at `UsersSection.tsx:55-56`, before the `if (isPhone)` return at `:152`. They are lifted into the `PhoneUsersModel`, and `PhoneUsers` declares all hooks before any conditional render.
- i18n parity: `section.users.addUser` and `section.users.phone.{add,setPw,usernameSignIn}`, plus the changed `phone.empty`, are present and well-formed in en, es and zh-CN.
- No direct Supabase calls from UI, no inline color literals (tokens only), no `window.confirm` / `Alert.alert` (`TypeToConfirmModal` is used), and web-only `document` access is `Platform.OS === 'web'`-guarded. No legacy files are touched, the `app.json` slug is untouched, and there are no new realtime channels or custom `current_setting('jwt...')` SQL.
- New jest tests are co-located `*.test.ts(x)` or `__tests__/` following the existing jest track; the shell smoke follows the `smoke-edge-roles.sh` style, except for the registration gap above.
