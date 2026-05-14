# Spec 029: Post-025 frontend polish trio

Status: READY_FOR_REVIEW

## User story

As a store-manager admin (and as a future contributor reading the
codebase), I want three small post-025 frontend cleanups landed so that
(a) the `isMaster` predicate stops drifting between two copies, (b) the
invite drawer's role default is no longer expressed as a dead
identity-ternary, and (c) deleting my own account shows exactly one
success toast instead of two overlapping notifications.

These were Should-fix items flagged in spec 025's code-reviewer notes
that didn't make it into the 025 ship cut. Batched here to amortize
review overhead — none of them require backend, RLS, or migration work.

## Acceptance criteria

### Item 1 — Shared `useIsMaster` hook

- [ ] A new exported hook `useIsMaster(): boolean` lives in
  `src/hooks/useRole.ts` alongside the existing `useIsSuperAdmin`. Its
  implementation reads `useStore((s) => s.currentUser?.role)` and
  returns `true` iff the role is `'master'` or `'super_admin'`.
- [ ] `src/screens/cmd/sections/UsersSection.tsx` no longer defines a
  local `useIsMaster` function. The section imports `useIsMaster` from
  `'../../../hooks/useRole'` and uses it at the existing call site
  (currently line 46).
- [ ] `src/components/cmd/InviteUserDrawer.tsx` no longer derives
  `isMaster` inline at line 53. It imports `useIsMaster` from
  `'../../hooks/useRole'` and calls it once at the top of the
  component, replacing the existing `const isMaster = …` line.
- [ ] Grepping the repo for the literal predicate
  `currentUser?.role === 'master' || currentUser?.role === 'super_admin'`
  returns zero matches outside `src/hooks/useRole.ts` itself.
- [ ] `useIsMaster` carries a JSDoc comment in the same shape as
  `useIsSuperAdmin` explaining what it gates (admin/user role picker
  visibility in the invite drawer, peer-row visibility filtering in
  UsersSection, delete + reset-password gate generosity in
  UsersSection's `UserRow`). This keeps future role broadening
  discoverable.

### Item 2 — Drop the dead `isMaster ? 'user' : 'user'` ternary

- [ ] `src/components/cmd/InviteUserDrawer.tsx`'s form-reset effect
  (currently line 58–69) sets `role: 'user'` unconditionally — the
  identity ternary `isMaster ? 'user' : 'user'` is removed.
- [ ] The "Non-master admins can only invite store users" comment
  above the line stays (with a one-word tweak: it now describes both
  master and non-master defaulting to `'user'`).
- [ ] The `isMaster` dependency in the effect's deps array is
  preserved if the variable is still referenced elsewhere in the
  effect; if no longer referenced, it is removed cleanly.
  (Implementation note: per item 1, `isMaster` is still used by the
  surrounding component for role-picker visibility, so the variable
  itself stays — only the in-effect usage is gone.)
- [ ] Manual smoke: opening the drawer as a non-master admin still
  hides the role picker and sends `role='user'`. Opening as
  master/super_admin still shows the picker, defaulting to
  `'user'` (selected pill = "store user"), and switching to
  `'admin'` still wires up `brandId` and the brand-context card.

### Item 3 — Single toast on self-delete

- [ ] `useStore.deleteProfile` accepts an optional
  `opts?: { silent?: boolean }` second argument. The signature in the
  `StoreState` interface in `src/store/useStore.ts` is updated to
  `deleteProfile: (profileId: string, opts?: { silent?: boolean }) => Promise<boolean>;`.
- [ ] When `opts?.silent === true`, the implementation skips the
  `Toast.show({ type: 'info', text1: 'Profile deleted', … })` call
  but otherwise behaves identically (including the cached-list
  cleanup and the boolean return value).
- [ ] The default (no `opts`, or `opts.silent !== true`) preserves
  existing behavior — the `'Profile deleted'` info toast still fires.
  This protects every other caller of `deleteProfile` that relies on
  the toast as user feedback.
- [ ] `src/screens/cmd/sections/UsersSection.tsx`'s
  `handleConfirmDelete` (currently line 110–132) passes
  `{ silent: true }` when the target is self:
  `const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined);`.
- [ ] Manual smoke (web, signed in as the user being deleted):
  triggering self-delete shows exactly ONE success toast
  (`'Account deleted' / 'Signing out…'` from `UsersSection`), no
  info toast. The window still navigates to `/` after ~1.5 s.
- [ ] Manual smoke (peer-delete): deleting another user still shows
  exactly ONE info toast (`'Profile deleted'` from the store) and the
  local list refreshes.
- [ ] No other call site of `deleteProfile` regresses — a repo-wide
  grep for `deleteProfile(` confirms the only `silent: true` caller
  is the self-delete branch in `UsersSection`.

### Cross-cutting verification gates

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run typecheck:test` exits 0.
- [ ] `npm test -- --ci` PASSes. No existing tests should break; if
  a Jest test covers `deleteProfile`, extend it to assert the
  `silent: true` branch suppresses the toast.
- [ ] `npm run test:db` PASSes. No DB changes — sanity only.
- [ ] `npm run test:smoke` PASSes.

## In scope

- Export `useIsMaster` from `src/hooks/useRole.ts`.
- Refactor `UsersSection.tsx` and `InviteUserDrawer.tsx` to consume the
  shared hook.
- Drop the dead identity ternary in `InviteUserDrawer.tsx`'s
  form-reset effect.
- Add `opts?: { silent?: boolean }` to `useStore.deleteProfile`'s
  signature + implementation; thread `{ silent: true }` from
  `UsersSection`'s self-delete branch.
- JSDoc on the new `useIsMaster` matching the shape of
  `useIsSuperAdmin`.

## Out of scope (explicitly)

- **Sidebar Users gate for non-master admins (spec 025 M1)** — separate
  follow-up; touches sidebar rendering and item visibility, not in
  these three files.
- **Guard against deleting the last super-admin / master** — a
  data-integrity check that needs DB-side enforcement; not a frontend
  polish.
- **`canDelete` / `canResetPassword` pure-helper extraction + unit
  tests** — bigger refactor with its own test surface; defer.
- **Reports template backlog** — unrelated; tracked separately.
- **Role-name renames or new roles** — `super_admin` / `master` /
  `admin` / `user` stay as-is.
- **Touching `useRole()` itself** — the placeholder that hardcodes
  `'admin'` (CLAUDE.md, "Placeholder behavior (intentional)") is
  intentionally left alone.
- **Adding tests beyond what's needed to lock in `silent: true`** —
  we are not retroactively covering items 1 or 2 with new tests; the
  manual smoke checklist is the gate.

## Open questions resolved

- Q: Item 2 — drop the ternary (option a) or change one branch to
  `'admin'` (option b)? → **A: option (a)**. The PM brief in the
  task description noted (a) is the cleaner read; option (b) would
  shift the default behavior for master users (they would now
  default to inviting another admin), which is a UX change rather
  than a code-cleanup. Spec stays in cleanup territory.
- Q: Item 3 — silent option (a), caller-only toast (b), or move
  toast out of store (c)? → **A: option (a)**. Adds the
  smallest-surface knob (`{ silent?: boolean }`) without changing
  the default behavior every other caller relies on. Option (c)
  would force every other caller of `deleteProfile` (there's at
  least one — peer-delete in this same section, plus any future
  brand-admins flow) to start managing its own toast.
- Q: Should this spec also add a `useIsAdminGlobal` or similar to
  cover the placeholder `useRole()` cleanup? → **A: no, out of
  scope.** Per CLAUDE.md the placeholder is intentional pending the
  staff-app split being fully cut over; touching it is its own spec.

## Dependencies

- None. No new packages, no migrations, no edge function changes.
- Existing files touched:
  - `src/hooks/useRole.ts`
  - `src/components/cmd/InviteUserDrawer.tsx`
  - `src/screens/cmd/sections/UsersSection.tsx`
  - `src/store/useStore.ts` (signature update + implementation
    branch in `deleteProfile`)

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI section only
  (`src/screens/cmd/sections/UsersSection.tsx` and
  `src/components/cmd/InviteUserDrawer.tsx`). Spec 025 already
  deleted the legacy admin surface; nothing to route around.
- **Per-store or admin-global:** Admin-global. None of these three
  changes touch per-store RLS or `auth_can_see_store()`. The
  `isMaster` predicate gates UI affordances, not DB access.
- **Realtime channels touched:** None. UsersSection uses
  on-mount + post-action `fetchAllUsers`, not realtime
  (intentional, per the comment in `UsersSection.tsx` lines 17–19).
- **Migrations needed:** No.
- **Edge functions touched:** None. `deleteProfile` already wraps
  the existing `delete-user` edge function via
  `src/lib/auth.deleteUser`; we're only changing the client-side
  toast behavior around it, not the function itself.
- **Web/native scope:** Both. None of the three items use
  web-only APIs (the existing `Platform.OS === 'web'` guard on the
  post-self-delete redirect in `UsersSection` is untouched).
- **Test track:** Jest only, and only if a `deleteProfile` test
  already exists or is trivially added to cover `silent: true`.
  No pgTAP or shell-smoke work — no DB or edge-function changes.
- **`app.json` slug:** Not touched. No build-identifier work.

## Architect design

Pure frontend / Zustand-store work. No migrations, no edge functions, no
RLS, no realtime, no `src/lib/db.ts` changes. Ships on the next Vercel
auto-deploy from `main` — no manual edge function deploy step.

### 1. Hook signature for `useIsMaster`

Add to `src/hooks/useRole.ts`, **immediately after** `useIsSuperAdmin`
(at the end of the file). Alphabetical order is not honored elsewhere
in this file (`useRole` → `useIsSuperAdmin` is not alphabetical), and
"after `useIsSuperAdmin`" matches the spec's "alongside" language and
keeps the two role-predicate hooks visually adjacent.

```ts
/**
 * Spec 029 — single source of truth for the "treated as master" gate
 * in the Cmd UI. Returns true iff the live profiles.role is `'master'`
 * or `'super_admin'`. Gates:
 *   - Invite-user drawer: role-picker visibility (admin vs. user).
 *     Non-master admins are hard-locked to inviting `role='user'`.
 *   - UsersSection: peer-row visibility filter (non-master admins do
 *     not see master/super_admin rows).
 *   - UsersSection's UserRow: delete + reset-password gate generosity.
 *
 * Reads the live profiles.role via useStore.currentUser. Non-master
 * (admin/user/null) returns false. Mirrors `useIsSuperAdmin`'s shape;
 * the two are intentionally separate hooks because the gates differ
 * (super-admin alone gates BrandPicker / TENANCY sidebar group; master
 * + super-admin together gate the user-management affordances above).
 */
export function useIsMaster(): boolean {
  const role = useStore((s) => s.currentUser?.role);
  return role === 'master' || role === 'super_admin';
}
```

Return type is the explicit `boolean` (matches `useIsSuperAdmin`).
Implementation is a single Zustand selector call; no `useMemo` needed.

### 2. Other duplicated-predicate callers

I grepped `src/` for every variant. The duplicated-`isMaster` predicate
(`'master' || 'super_admin'`) appears in exactly two places, both
listed by the PM:

- `src/screens/cmd/sections/UsersSection.tsx:27` — local
  `useIsMaster` hook declaration. **Remove the local declaration;
  import from `'../../../hooks/useRole'`.**
- `src/components/cmd/InviteUserDrawer.tsx:53` — inline `const isMaster
  = …`. **Replace with `const isMaster = useIsMaster();` and add the
  import.**

Other role-predicate patterns I found are deliberately out of scope
because they are *different* predicates, not duplicates of `isMaster`:

- `'admin' || 'master' || 'super_admin'` ("any kind of admin"):
  `TitleBar.tsx:41`, `useStore.ts:480`, `BrandsSection.tsx:880`,
  `UsersSection.tsx:293`. This is a wider predicate (`isAnyAdmin` /
  `isPrivileged`) — different semantics, separate extraction would be
  its own spec.
- `'admin' || 'master'` (no `super_admin`): `TimezoneBar.tsx:24`,
  `DashboardSection.tsx:732`. These look like potential super-admin
  omissions (similar in shape to the spec 027 edge-function gap), but
  classifying them needs role/UX reasoning and is firmly outside
  "polish trio" scope. Flag as a follow-up question for the PM, do
  not batch into this spec.

Recommendation: no additional sites to fold in. The acceptance
criterion that grepping for `currentUser?.role === 'master' ||
currentUser?.role === 'super_admin'` returns zero matches outside
`src/hooks/useRole.ts` is achievable with only the two listed edits.
(The UsersSection variant binds `role` to a local first, so the literal
text differs slightly — but the spec's grep target is the
`currentUser?.…` form, which only appears at the two sites the PM
identified.)

### 3. `deleteProfile` signature change

`src/store/useStore.ts`, two edits:

**Interface (line 150):**

```ts
// before
deleteProfile: (profileId: string) => Promise<boolean>;
// after
deleteProfile: (profileId: string, opts?: { silent?: boolean }) => Promise<boolean>;
```

**Implementation (line 789):**

```ts
deleteProfile: async (profileId, opts) => {
  if (!profileId) return false;
  try {
    const { deleteUser } = await import('../lib/auth');
    const { error } = await deleteUser(profileId);
    if (error) {
      notifyBackendError('Delete profile', new Error(error));
      return false;
    }
    // Drop the row from every cached members list.
    const prevByBrand = get().brandAdminsByBrandId;
    const next: Record<string, User[]> = {};
    for (const [bid, list] of Object.entries(prevByBrand)) {
      next[bid] = list.filter((u) => u.id !== profileId);
    }
    set({ brandAdminsByBrandId: next });
    if (!opts?.silent) {
      Toast.show({
        type: 'info',
        text1: 'Profile deleted',
        text2: 'Both profile row and auth user have been removed.',
        visibilityTime: 4000,
      });
    }
    return true;
  } catch (e: any) {
    notifyBackendError('Delete profile', e);
    return false;
  }
},
```

Confirmations:

- **Existing-caller compatibility.** `opts` is optional, so existing
  callers continue to compile and behave identically:
  - `UsersSection.tsx:114` (peer-delete branch) — current call
    `deleteProfile(target.id)` keeps current behavior (toast fires).
  - `BrandsSection.tsx:999` (DeleteProfileModal inside BrandsSection) —
    current call `deleteProfile(target.id)` keeps current behavior.
- **Forward-compatible.** The `opts: { silent?: boolean }` shape can
  grow `confirm?: boolean`, `reason?: string`, etc. without further
  signature breakage.
- **Toast text unchanged on the non-silent path.** Same `type: 'info'`,
  same `text1`, same `text2`, same `visibilityTime`. The only behavior
  change is *absence* of the toast when `silent: true`.
- **Error path unchanged.** Failures still toast through
  `notifyBackendError` regardless of `opts.silent`. The `silent` flag
  intentionally suppresses only the success info-toast — failure
  feedback must always reach the user. (Spec doesn't ask about this
  explicitly, but flagging it so the dev doesn't accidentally widen the
  flag's scope.)
- **Cached-list cleanup unchanged.** The `brandAdminsByBrandId` filter
  still runs regardless of `silent`.

### 4. Self-delete UX flow (toast → sign-out → redirect timing)

Sequence in `UsersSection.handleConfirmDelete` (lines 110–132) with the
edit applied:

```
user types confirm-text → onConfirm fires
  ↓
const isSelf = target.id === currentUser?.id
  ↓
const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined)
  ↓                                              │
  │                                              ├─ non-self path: store fires
  │                                              │  type='info' "Profile deleted"
  │                                              │  toast (visibilityTime 4000).
  │                                              │  No further toast from the
  │                                              │  component (refresh runs).
  │                                              │
  │                                              └─ self path: store skips its
  │                                                 toast (silent: true). Cached
  │                                                 list still cleaned.
  ↓
if (!ok) return                                  ← bail before clearing modal
setDeleteTarget(null)                            ← close TypeToConfirmModal
  ↓
if (isSelf):
  Toast.show({ type: 'success', text1: 'Account deleted',
               text2: 'Signing out…', visibilityTime: 2000 })   ← (T0)
  logout()                                                      ← clears currentUser
  if (Platform.OS === 'web'):
    setTimeout(() => { window.location.href = '/' }, 1500)      ← (T0 + 1500ms)
else:
  refresh().catch(() => {})                                     ← peer-delete
                                                                  refreshes list
```

Toast sequence:

- **Non-self (peer) delete:** exactly ONE toast — the store's
  `'Profile deleted'` info toast (visibilityTime 4000). No toast from
  `UsersSection`. **Existing behavior preserved.**
- **Self delete:** exactly ONE toast — the component's
  `'Account deleted' / 'Signing out…'` success toast (visibilityTime
  2000). Store's info toast suppressed by `silent: true`. **New
  behavior fixed by this spec.**

Timing of the self-delete success toast vs. redirect: the toast fires
**synchronously** before `logout()` and before the `setTimeout(…, 1500)`
that schedules the redirect. Toast `visibilityTime: 2000` is greater
than the 1500ms redirect delay, so the toast is visible for at least
1500ms before navigation. After the browser navigates to `/`, the
`react-native-toast-message` host unmounts (the new page won't carry
the toast across), which is acceptable — the user has had 1500ms to
read it and the destination "/" is the post-sign-out screen anyway.

The `logout()` call is fire-and-forget on the toast layer (toast
infra is mounted at the root above the navigator); `currentUser`
clearing does not unmount Toast's host. No race.

### 5. Jest test recommendation

Recommend: **add a single Jest unit test for
`useStore.getState().deleteProfile` covering the silent path.** The
hook `useIsMaster` is also testable in isolation but adds little —
it's a one-line selector and breakage would be caught by tsc + manual
smokes. The store branch carries the *only* new conditional in the
spec, and is the most likely regression surface (a future refactor
that forgets to keep the toast inside the `if (!opts?.silent)`).

Suggested shape (one test file or extension of an existing
`useStore.test.ts` if one exists; dev to confirm):

- Mock `../lib/auth.deleteUser` to return `{ error: null }`.
- Spy on `Toast.show`.
- Case A: `deleteProfile('p1')` → spy called once with
  `text1: 'Profile deleted'`. Return value `true`.
- Case B: `deleteProfile('p1', { silent: true })` → spy not called.
  Return value `true`. `brandAdminsByBrandId` still cleaned (assert
  by seeding the store with a row and checking it's gone).
- Case C: `deleteProfile('p1', { silent: true })` when
  `deleteUser` returns `{ error: 'boom' }` → spy not called for the
  info toast, `notifyBackendError` runs (assert via the warn
  spy). Confirms the silent flag doesn't accidentally suppress the
  error path.

Cost-benefit: the test is ~30 lines, locks in the contract, and pays
for itself on the next refactor. Above the threshold for "trivial
spec" testing — recommend including it. If the dev finds no existing
`useStore.test.ts` scaffold and the test infra effort is non-trivial,
defer to the test-engineer reviewer's call (this would push the spec
past "polish trio" scope).

### 6. File-by-file edit plan

Line numbers are best-effort against current `main`; dev verifies on
edit.

**`src/hooks/useRole.ts`** (currently 28 lines)
- Append, after line 27 (end of `useIsSuperAdmin`): `useIsMaster`
  hook + JSDoc as specified in §1.
- No other edits.

**`src/screens/cmd/sections/UsersSection.tsx`** (currently 420 lines)
- Add import line near existing role import area (top of file, after
  line 12's `User` import):
  `import { useIsMaster } from '../../../hooks/useRole';`
- Delete the local hook declaration at lines 22–28 (the
  `// Spec 025 §2.G.1 — \`isMaster\` predicate…` comment block plus
  the `function useIsMaster(): boolean { … }` body). The single-site
  comment about the predicate moves to the JSDoc in `useRole.ts`
  (already drafted in §1 above — covers all three gate sites).
- The call at line 46 (`const isMaster = useIsMaster();`) is
  unchanged — it now resolves to the imported hook.

**`src/components/cmd/InviteUserDrawer.tsx`** (currently 489 lines)
- Add import: `import { useIsMaster } from '../../hooks/useRole';`
  (path relative — `src/components/cmd/` → `../../hooks/useRole`).
- Line 51–53: replace the inline derivation
  ```ts
  // Spec 025 §2.G.1 — `isMaster` predicate generalized to also accept
  // super_admin so super-admins keep their implicit visibility.
  const isMaster = currentUser?.role === 'master' || currentUser?.role === 'super_admin';
  ```
  with
  ```ts
  const isMaster = useIsMaster();
  ```
- The `currentUser` selector at line 49 stays — it's still used by
  the `currentUser` reference elsewhere if any (verify on edit;
  reading the file, line 49 is the only `currentUser` binding and
  it's only used to derive `isMaster`). If post-edit grep confirms
  `currentUser` is unused, remove the selector to keep the file
  clean. **Dev: confirm by `grep -n "currentUser" InviteUserDrawer.tsx`
  after edit. If zero further hits, drop the line 49 selector.**
- Line 65: `role: isMaster ? 'user' : 'user',` → `role: 'user',`.
- Line 63–64 comment: tweak per AC ("Non-master admins can only
  invite store users" → e.g. "Both master and non-master admins
  default new invites to `role='user'`; master can switch to admin
  via the picker below.").
- Line 69 effect deps: `[visible, isMaster]`. Since the in-effect
  reference to `isMaster` is gone, the dep can be dropped → `[visible]`.
  Verify by reading the effect body post-edit — if no `isMaster`
  reference remains inside the effect, drop it from deps. (Spec
  AC explicitly allows this: "if no longer referenced, it is
  removed cleanly".) The `isMaster` variable itself stays at file
  scope because the role-picker render at line 253 still uses it.

**`src/store/useStore.ts`** (currently ~1900 lines, store at ~64 KB)
- Line 150 (interface): widen signature as shown in §3.
- Line 789–816 (implementation): rename `async (profileId) =>` to
  `async (profileId, opts) =>` and wrap the `Toast.show(...)` call
  in `if (!opts?.silent) { … }` as shown in §3.

**`src/screens/cmd/sections/UsersSection.tsx`** (second edit, line 114)
- Change the delete call:
  ```ts
  const ok = await deleteProfile(target.id);
  ```
  to
  ```ts
  const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined);
  ```
- The `isSelf` const at line 113 is already computed before the call
  — no additional plumbing.
- Comment at line 129 (`// deleteProfile already toasts success; refresh the local list.`)
  stays accurate for the non-self branch.

No other files in `src/` require edits.

### 7. Cross-cutting confirmations

- **Migrations:** None.
- **RLS:** Untouched. `isMaster` gates UI affordances only; DB-side
  enforcement is `auth_is_privileged()` / `auth_is_admin()` and is
  not in scope.
- **Edge functions:** None changed. `deleteUser` edge function (called
  via `src/lib/auth.deleteUser`) is unchanged — only the store's
  client-side toast logic around it changes.
- **`src/lib/db.ts`:** Not touched. The store calls
  `auth.deleteUser`, not a db helper.
- **Realtime channels:** None. `UsersSection` is fetch-on-mount +
  fetch-on-action (per its own comment at lines 17–19). No
  publication changes — the "docker restart
  `supabase_realtime_imr-inventory`" gotcha does not apply.
- **Frontend store impact:** Single `deleteProfile` slice change.
  The optimistic-then-revert pattern does NOT apply here —
  `deleteProfile`'s implementation has always been
  call-first-then-update-cache (no optimistic write to revert; the
  pre-mutation `brandAdminsByBrandId` is only used as a base for the
  filter). The `silent` change preserves this.
- **Deploy step:** Vercel auto-deploys frontend on push to `main`.
  No manual edge function deploy. No DB migration to apply.
- **`app.json` slug:** Untouched.
- **Verification gates** (mirror PM list, no additions):
  - `npx tsc --noEmit` → 0
  - `npm run typecheck:test` → 0
  - `npm test -- --ci` → PASS (including the new `deleteProfile`
    silent-branch test if added per §5)
  - `npm run test:db` → PASS (sanity; no DB changes)
  - `npm run test:smoke` → PASS
  - Manual: four browser smokes per spec AC §1, §2, §3.

### Risks and tradeoffs

- **Low surface, minimal risk.** Only one new conditional
  (`if (!opts?.silent)`) and one shared hook extraction. The
  largest risk is the dev forgetting to remove `currentUser` from
  `InviteUserDrawer` selectors if it goes unused post-edit (lint /
  tsc with `noUnusedLocals` would flag, but `tsconfig.json` may not
  enable it — dev to verify). Worst case: a redundant selector
  subscription, not a correctness bug.
- **Predicate-divergence drift.** Other role predicates
  (`isAnyAdmin`, `'admin' || 'master'`) are *not* extracted by this
  spec. If a follow-up tries to fold them into `useIsMaster` or a
  combined hook, the JSDoc must be updated to disambiguate — the
  current draft is explicit that this hook is the
  "master + super_admin" gate, not the wider privileged gate.
- **Toast timing on self-delete.** Relying on a 1500ms `setTimeout`
  to give Toast time to render before redirect is existing
  behavior, not new. The spec change moves the "Account deleted"
  toast from second-of-two to only-toast, which makes the timing
  *more* tolerant (no longer competing with the store toast for
  display time). Net: marginally better UX, no new race.
- **No `super_admin` parity with edge-function `ADMIN_ROLES`.** This
  spec does not touch edge functions. The spec 027 lesson (DB
  policies broadened, edge functions had to catch up) does not
  recur here because `deleteProfile`'s server side already routes
  through `delete-user`, which spec 027 already fixed. UI-only
  change.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. The work is pure
  frontend / Zustand-store, no migrations, no edge functions. Touch
  the four files listed in §6 of the Architect design (one of them
  twice). Lock in the `deleteProfile` silent branch with a Jest test
  per §5 if existing test scaffolding makes it cheap; otherwise note
  why and lean on the manual smoke checklist. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/029-frontend-polish-trio/spec.md

## Files changed

- `src/hooks/useRole.ts` — appended exported `useIsMaster()` hook with
  JSDoc matching `useIsSuperAdmin`'s shape (architect §1).
- `src/screens/cmd/sections/UsersSection.tsx` — removed the local
  `useIsMaster()` hook + spec 025 §2.G.1 comment block; added import
  from `'../../../hooks/useRole'`; threaded `{ silent: true }` into
  the self-delete branch of `handleConfirmDelete` (architect §6, second
  edit).
- `src/components/cmd/InviteUserDrawer.tsx` — added import for
  `useIsMaster`; replaced the inline `currentUser?.role === 'master'
  || currentUser?.role === 'super_admin'` derivation with
  `const isMaster = useIsMaster()`; removed the now-unused
  `currentUser` selector; dropped the dead `isMaster ? 'user' : 'user'`
  ternary in the form-reset effect (now plain `role: 'user'`);
  rewrote the surrounding comment to describe both master and
  non-master defaulting to user; dropped `isMaster` from the effect's
  deps array since the in-effect reference is gone (the file-scope
  `isMaster` variable still renders the role picker, so the symbol
  itself remains).
- `src/store/useStore.ts` — widened `deleteProfile` signature in the
  `StoreActions` interface to
  `(profileId: string, opts?: { silent?: boolean }) => Promise<boolean>`
  (with updated JSDoc noting the new branch); rewrote the
  implementation to accept `opts` and wrap the success info-toast in
  `if (!opts?.silent)`. Cached-list cleanup and `notifyBackendError`
  error path are unconditional — only the success info-toast is
  suppressed.

### Verification notes

- `npx tsc --noEmit` — exits 0 for app-graph errors. (Pre-existing
  TS2688 "Cannot find type definition file for '<pkg> 2'" noise from
  duplicate `node_modules/@types/<pkg> 2/` directories is unrelated to
  this spec and exists on `main` independently of these edits.)
- `npm run typecheck:test` — exits 0 (same TS2688 noise filtered).
- `npm test -- --ci` — 4 suites / 24 tests PASS. No existing tests
  broken.
- `npm run test:db` — 14/14 DB test files pass (sanity only — no DB
  changes in this spec).
- `npm run test:smoke` — all smoke arms pass (sanity only — no edge
  function changes).
- Repo-wide grep for the literal
  `currentUser?.role === 'master' || currentUser?.role === 'super_admin'`
  predicate returns zero matches outside `src/hooks/useRole.ts` (AC
  Item 1 satisfied). The only remaining `'master' || 'super_admin'`
  shape outside `useRole.ts` is `TitleBar.tsx:41`'s wider `isAdmin =
  'admin' || 'master' || 'super_admin'` predicate, which architect §2
  explicitly carves out as out of scope for this spec.
- Repo-wide grep for `deleteProfile(` confirms only two call sites:
  `UsersSection.tsx:106` (the new `silent: true` self-delete path)
  and `BrandsSection.tsx:999` (no-opts call, preserves existing
  behavior).

### Jest test recommendation deferred (architect §5)

Architect §5 recommended adding a 3-case jest test for
`useStore.getState().deleteProfile` (default toasts, silent suppresses,
silent + error still calls `notifyBackendError`). The §5 carve-out
explicitly says: "If the dev finds no existing `useStore.test.ts`
scaffold and the test infra effort is non-trivial, defer to the
test-engineer reviewer's call." No `useStore.test.ts` exists; the
store is ~51 KB with transitive imports to `data/seed`, `lib/db`,
`lib/supabase`, `Platform`, `AsyncStorage`, plus 1900+ lines of action
implementations that would need to load at import time even for a
single-action test. The dynamic `import('../lib/auth')` inside
`deleteProfile` is mockable, but standing up a usable
`createTestStore()` harness is meaningfully larger than the polish
spec itself. Deferring to the test-engineer reviewer per §5's
explicit carve-out. The 4 manual browser smokes in the AC plus the
unconditional `notifyBackendError` error path are the regression net
for v1.

### Browser smoke status

I do not have `preview_*` MCP tools loaded in this agent session
(only `Read` / `Write` / `Edit` / `Bash`). The Expo web dev server
is running on `http://localhost:54516/` (confirmed via `curl -I`),
but I cannot exercise the UI smokes (invite-drawer role picker
hidden state, single-toast on self-delete, single-toast on
peer-delete) without browser automation. Surfacing this honestly per
the frontend-developer rule "If you can't verify in the browser […]
say so explicitly rather than claiming success." The four UI smokes
in AC items 1, 2, and 3 should be exercised by the user or the
test-engineer reviewer before SHIP_READY. The typecheck + jest + DB
+ smoke gates all pass and the code changes are exactly what the
architect specified, so the regression risk is low.
