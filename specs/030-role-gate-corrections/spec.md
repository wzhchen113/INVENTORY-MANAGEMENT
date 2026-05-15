# Spec 030: Role-gate UX corrections trio

Status: READY_FOR_REVIEW

## User story

As a 2AM PROJECT admin operator (super_admin, master, or non-master admin),
I want the Cmd UI's role gates to behave consistently with the documented
backend semantics so that I do not see broken-looking surfaces (Item 1),
dead-end action buttons (Item 2), or misleading sidebar entries that land
on stripped-down pages (Item 3).

This spec batches three small, independent frontend role-gate corrections
surfaced as side-finds during the spec 025 / 028 / 029 review cycles. All
three are pure-frontend, one-file-each, one-to-three-line changes — batched
to amortize the review fan-out overhead.

## Acceptance criteria

### Item 1 — `super_admin` predicate parity (sidebar/dashboard)

- [ ] **AC1.1** In `src/components/TimezoneBar.tsx`, the existing inline
  predicate `currentUser?.role === 'admin' || currentUser?.role === 'master'`
  at the `isAdmin` derivation site (currently line 24) is replaced with a
  call to `useIsMaster()` from `src/hooks/useRole.ts`. Per `useIsMaster()`'s
  contract the result is `true` for `master` AND `super_admin`. The local
  variable MAY be renamed to `canEditTz` (or similar) since "admin" is now
  misleading; the rename is optional but the predicate replacement is not.
- [ ] **AC1.2** In `src/screens/cmd/sections/DashboardSection.tsx`, the
  manager-lookup predicate `(u.role === 'admin' || u.role === 'master')`
  used to find a store's first admin/master in the `users` array (currently
  around line 730–733) is widened to also accept `'super_admin'`. The fix
  may inline `(u.role === 'admin' || u.role === 'master' || u.role ===
  'super_admin')`, or extract a small `isPrivileged(role)` helper local to
  the file. Either shape is acceptable; the hook is NOT applicable here
  because the predicate operates on a row of the `users` array, not the
  current viewer.
- [ ] **AC1.3** No other instances of `role === 'admin' || role === 'master'`
  (or the snake_case equivalent in JS) introduced by specs 025+ remain in
  `src/components/` or `src/screens/cmd/`. (Architect: confirm this is true
  in design; if a third site is found, fold it in.) Existing pre-025
  predicates outside these directories are out of scope.
- [ ] **AC1.4** Manual browser smoke: with a super_admin currentUser, the
  TimezoneBar renders the chevron-forward icon and tapping opens the
  timezone modal. (Previously the row rendered without the chevron and
  did not open the modal.)
- [ ] **AC1.5** Manual browser smoke: with a super_admin user listed as a
  store's only privileged user, the DashboardSection store card's "Manager"
  field displays that user's name. (Previously it displayed `—`.)

### Item 2 — Hide DELETE button on self-row

- [ ] **AC2.1** In `src/screens/cmd/sections/UsersSection.tsx`'s `UserRow`,
  the `canDelete` derivation (currently lines 266–268) returns `false` when
  `isSelf` is `true`, regardless of the viewer's role. The non-master-admin
  branch's existing `isSelf ||` clause is removed.
- [ ] **AC2.2** The change is to the eligibility predicate only; the DELETE
  button's render-site code (`{canDelete ? <TouchableOpacity .../> : null}`,
  currently lines 393–408) is unchanged.
- [ ] **AC2.3** With self-delete now unreachable from the UI, the existing
  `silent: true` defensive code on the `deleteProfile` self-delete call site
  (introduced by spec 029) STAYS in place as belt-and-suspenders.
- [ ] **AC2.4** The DeleteConfirmModal's self-targeted code path (currently
  reached via `deleteTarget.id === currentUser?.id` at lines 227–232) is
  retained as dead defensive code for now; cleanup is out of scope (see
  Out of scope §3).
- [ ] **AC2.5** Manual browser smoke: log in as any role, open
  UsersSection, locate own row, confirm no DELETE button is rendered.
  RESET PW continues to be hidden per the existing `canResetPassword`
  predicate.

### Item 3 — Hide Users & access sidebar entry for non-master admins

- [ ] **AC3.1** In `src/lib/cmdSelectors.ts`'s `useDefaultSidebarGroups()`,
  the Admin group push (currently lines 1078–1086) is moved inside an
  `if (isMaster)` guard, mirroring the existing `if (isSuperAdmin)` pattern
  for the Tenancy group at lines 1088–1095.
- [ ] **AC3.2** The hook now calls both `useIsSuperAdmin()` AND
  `useIsMaster()` (the latter from `src/hooks/useRole.ts`). The `useMemo`
  dependency array is extended to include `isMaster`.
- [ ] **AC3.3** Default ordering is preserved when both gates are open:
  Operations → Planning → Insights → Admin (if master) → Tenancy
  (if super_admin). Note `useIsMaster()` returns `true` for super_admin,
  so a super_admin user sees both Admin and Tenancy in that order.
- [ ] **AC3.4** Spec 008's `applySidebarOverride()` continues to silently
  drop the `Users` id when the group is not in the default tree (for a
  non-master admin who had previously dragged that id into a different
  group in a prior session). No data migration is required.
- [ ] **AC3.5** Manual browser smoke: log in as a non-master admin (role
  = `'admin'`), confirm sidebar has no "Admin" group and no
  "Users & access" entry anywhere. Log in as master or super_admin,
  confirm the entry IS present.

### Cross-cutting

- [ ] **AC4.1** `npx tsc --noEmit` exits 0.
- [ ] **AC4.2** `npm run typecheck:test` exits 0.
- [ ] **AC4.3** `npm test -- --ci` PASS (no test changes expected; this is
  a regression guard).
- [ ] **AC4.4** `npm run test:db` PASS (sanity — no DB touched).
- [ ] **AC4.5** `npm run test:smoke` PASS (sanity — no edge fn touched).
- [ ] **AC4.6** No edits to `app.json`. The `slug` value remains
  `towson-inventory` (CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)").

## In scope

- Replace inline `admin || master` predicate in `TimezoneBar.tsx` with
  `useIsMaster()`.
- Widen the manager-lookup predicate in `DashboardSection.tsx` to include
  `super_admin`.
- Remove `isSelf` from the non-master-admin branch of `canDelete` in
  `UsersSection.tsx`'s `UserRow`.
- Gate the Admin sidebar group in `cmdSelectors.ts` on `useIsMaster()`.
- (Optional, architect's call) extract a tiny helper for the
  DashboardSection predicate if a third site shows up during design.

## Out of scope (explicitly)

1. **Guard against deleting the last super-admin or last master.**
   Spec 029 fast-follow #4 — medium-effort separate spec. Server-side
   guard plus optimistic-pull UX both need design.
2. **`useStore.test.ts` jest harness.** Spec 029 fast-follow #3 — medium
   effort, separate spec. Out of scope here.
3. **Cleanup of the self-delete dead defensive code paths in
   `UsersSection.tsx`** (modal's self-warning copy at lines 227–232 and
   the `silent: true` flag on `deleteProfile`). Both are now unreachable
   from the UI but stay as belt-and-suspenders. A future "remove dead
   code" spec can drop them; not today.
4. **Reports template backlog** (tracked at
   `specs/reports-templates-backlog.md`).
5. **The four comment-only `EXPO_PUBLIC_NEW_UI` survivors** carved out
   by spec 025 §1d.
6. **Database, edge function, migration, or realtime work.** Pure
   frontend only. The `delete-user` edge function's self-delete 400 gate
   stays as the authoritative backstop.
7. **Renaming `useIsMaster()` or its callers.** The hook's name already
   communicates "treated as master" and includes super_admin per its
   docstring; renaming would churn spec 029's surface.
8. **Audit of `role === 'admin' || role === 'master'` predicates outside
   `src/components/` and `src/screens/cmd/`.** Anything found in
   `src/lib/`, `src/store/`, or `src/hooks/` that isn't one of the three
   call sites named above is logged for a future spec but not fixed here.

## Open questions resolved

- **Q: Should Item 1's DashboardSection fix use the `useIsMaster()` hook?**
  → A: No. The predicate operates on a `users` array row, not the current
  viewer. The hook only knows about `useStore.currentUser`. Inline
  widening (or a tiny local helper) is the right shape. Documented in
  AC1.2.
- **Q: For Item 2, the current `canDelete` non-master-admin branch
  explicitly grants self-delete (`isSelf || (...)`). Is that
  intentional behavior we should preserve via a confirm gate, or pure
  legacy?** → A: Treated as dead UX per the prompt: the edge function
  rejects self-delete with HTTP 400. UI removes the affordance entirely;
  defensive code stays.
- **Q: Should AC3 keep the Admin group visible to non-master admins
  with just the "Profile" entry stripped?** → A: No. The group contains
  exactly one item ("Users & access"). Gating the group entry-wide is
  the spec 025 security-auditor M1 recommendation.
- **Q: Naming of `useIsMaster()` vs. `useIsPrivilegedAdmin()` — the
  former is from spec 029, but "master" is technically a strict
  subset.** → A: Out of scope per §7. The hook's docstring documents
  the wider semantics explicitly; renaming would churn spec 029.

## Dependencies

- `src/hooks/useRole.ts` — uses the existing `useIsMaster()` (spec 029)
  and `useIsSuperAdmin()` (spec 012b) exports. No new exports needed.
- No new migrations, no new edge functions, no new RPCs.
- No new packages, no new env vars.
- No realtime channel changes.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only (per CLAUDE.md "Cmd UI is the
  only client" + spec 025).
- **Per-store or admin-global:** Admin-global. All three items concern
  role gating, not per-store visibility. No `auth_can_see_store()`
  interaction.
- **Realtime channels touched:** None.
- **Migrations needed:** No.
- **Edge functions touched:** None. (The `delete-user` edge function's
  existing self-delete 400 gate is the backstop for Item 2 and is
  unchanged.)
- **Web/native scope:** Both. All three files render on web and native;
  the changes are JSX-level conditionals with no platform fork.
- **Tests track:** jest (regression guard via existing harness — no new
  tests required, but the test-engineer should confirm during review
  that no existing tests assumed the broken behavior).
- **`app.json` slug:** Unchanged. Not touched by this spec.
- **Files touched (expected):**
  - `src/components/TimezoneBar.tsx` (Item 1, ~1–3 line change at line 24)
  - `src/screens/cmd/sections/DashboardSection.tsx` (Item 1, ~1-line
    change at line ~732)
  - `src/screens/cmd/sections/UsersSection.tsx` (Item 2, ~1-line
    change at lines 266–268)
  - `src/lib/cmdSelectors.ts` (Item 3, ~3-line structural change at
    lines 1078–1097 + import update at the top of the file)
- **Risk notes:**
  - Item 1's DashboardSection inline-widening means a fourth role
    introduced in the future would re-introduce the same drift. A small
    `isPrivileged(role)` helper local to the file is recommended in
    design; alternatively a shared utility is acceptable but explicitly
    not required.
  - Item 3 changes `useDefaultSidebarGroups()`'s memo dependency surface
    (adding `isMaster`). Confirm the existing `useMemo` recomputes
    correctly when the live `currentUser.role` changes between renders;
    `useIsMaster()` already subscribes to that slice of the store, so
    the dependency is reactive.
  - The interaction with spec 008's per-user sidebar override is
    benign: `applySidebarOverride()` silently drops ids not present in
    the default tree, so a non-master admin who once dragged the Users
    item into a custom group simply won't see it.

## Architect design

Pure frontend. No migrations, no edge functions, no DB, no realtime, no
`db.ts` surface, no store-slice changes, no `app.json` touch. Three files
edited (one for each item) plus the architect's audit confirms there are
no fourth/fifth sites inside the in-scope directories.

### 1. AC1.3 audit — `=== 'admin'` and `=== 'master'` predicates in `src/`

Grep was run for both `role === 'admin'` and `role === 'master'` across
`src/`. Spec §8 limits the in-scope directories to `src/components/` and
`src/screens/cmd/`; everything else is logged but explicitly out of scope
per §7.

| File:line | Predicate shape | Kind | In scope? | Disposition |
|---|---|---|---|---|
| `src/components/TimezoneBar.tsx:24` | `currentUser?.role === 'admin' \|\| currentUser?.role === 'master'` | current-viewer | yes | **Item 1.1 — replace with `useIsMaster()`** |
| `src/components/cmd/TitleBar.tsx:41` | `currentUser?.role === 'admin' \|\| currentUser?.role === 'master' \|\| currentUser?.role === 'super_admin'` | current-viewer | yes | **No change.** This is a "see-all-stores" gate; it currently includes `super_admin` correctly via the third clause. Replacing with `useIsMaster()` would change semantics (TitleBar wants admin OR master OR super_admin; `useIsMaster()` is master OR super_admin only — excludes plain admin). Leave alone. |
| `src/components/cmd/InviteUserDrawer.tsx:108,310,331` | `values.role === 'admin'` | form-state (which role is being invited) | yes | **No change.** This is not a viewer-role gate; it's "is the role I'm inviting equal to admin so I should attach brandId". `super_admin` cannot be invited via this drawer (spec 025), so the predicate is correct. |
| `src/screens/cmd/sections/DashboardSection.tsx:732` | `(u.role === 'admin' \|\| u.role === 'master')` | row-data (find a store's manager) | yes | **Item 1.2 — widen inline to add `\|\| u.role === 'super_admin'`** |
| `src/screens/cmd/sections/UsersSection.tsx:285` | `user.role === 'master' \|\| user.role === 'admin' \|\| user.role === 'super_admin'` | row-data (store-chip "all stores" gate) | yes | **No change.** Already includes `super_admin`. |
| `src/screens/cmd/sections/UsersSection.tsx:266-268` | `user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin'` (inside `canDelete`) | row-data | yes | **Item 2 — strip `isSelf \|\|` branch.** Predicate-on-target-row stays correct (already lists all three privileged roles). |
| `src/screens/cmd/sections/UsersSection.tsx:279` | `user.role !== 'master' && user.role !== 'super_admin'` (inside `canResetPassword`) | row-data | yes | **No change.** Already lists both privileged roles. |
| `src/screens/cmd/sections/BrandsSection.tsx:880` | `(u.role === 'admin' \|\| u.role === 'master' \|\| u.role === 'user')` | row-data (per-brand admins list — demote/delete eligibility) | yes | **No change in this spec.** The Brands tab is super-admin-only (gated upstream by `useIsSuperAdmin()`), and the list is per-brand-scoped. Super_admins typically don't carry a `brand_id` so they wouldn't appear in this list; and even if one did, intentionally excluding them from a brand-scoped demote/delete is defensible (spec 012c §8.7 self-protection). Logged for a future spec if a need surfaces. |
| `src/screens/cmd/sections/RecipesSection.tsx` (lines 160/218/259/315/350/361/397/429) | `role === 'admin'` | current-viewer (via `useRole()` placeholder) | yes (technically) | **No change.** `useRole()` is the placeholder hook that hardcodes `'admin'` for everyone — this is intentional placeholder behavior per CLAUDE.md "Placeholder behavior (intentional)" and is unrelated to the `useIsMaster()` widening. Outside scope; covered by the future hook-cleanup work. |
| `src/screens/cmd/sections/PrepRecipesSection.tsx` (lines 125/175/214/272/295/306/350/383) | `role === 'admin'` | current-viewer (via `useRole()` placeholder) | yes (technically) | **No change.** Same reasoning as RecipesSection. |
| `src/screens/LoginScreen.tsx:128` | `u.role === 'admin'` | demo-account label (dev-only `__DEV__`-gated UI) | NOT in `src/components/` or `src/screens/cmd/` | Out of scope per §7. Dev-only demo-account label string; no production impact. |
| `src/store/useStore.ts:483` | `user?.role === 'admin' \|\| user?.role === 'master' \|\| user?.role === 'super_admin'` | row-data | OUT (under `src/store/`) | Out of scope per §7. Already includes super_admin. |
| `src/lib/auth.ts:82,88,157,228,369,375` | various | mixed | OUT (under `src/lib/`) | Out of scope per §7. |
| `src/lib/db.ts:2473,2479` | `p.role === 'master'` | data-mapping (MASTER display-name override) | OUT (under `src/lib/`) | Out of scope per §7. |
| `src/hooks/useRole.ts:47` | `role === 'master' \|\| role === 'super_admin'` | INSIDE `useIsMaster()` itself | OUT (under `src/hooks/`) | This IS the hook. No change. |

**Audit conclusion.** Inside the in-scope directories (`src/components/`
and `src/screens/cmd/`) there are exactly **two** drift sites missing
`super_admin` and corresponding to current-viewer / row-data shapes:
TimezoneBar.tsx:24 (Item 1.1) and DashboardSection.tsx:732 (Item 1.2).
The other matches are either already correct (TitleBar, UsersSection
gates, useStore.ts gate), placeholder-`useRole()` based (Recipes /
PrepRecipes — separate hook-cleanup track), or in directories explicitly
out of scope per §7 (lib, store, screens/LoginScreen).

**No third site needs folding into this spec.** This finalizes AC1.3.

### 2. AC1.1 — `TimezoneBar.tsx`

**File:** `src/components/TimezoneBar.tsx`

**Edits:**
- Add to the existing `useRole` import (or add a new import line if the
  file does not already import from `../hooks/useRole`):
  `import { useIsMaster } from '../hooks/useRole';`
  Currently the file does not import from `useRole.ts` — add a fresh
  import line below the `useStore` import at line 15.
- Replace line 24:
  - **Before:** `const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';`
  - **After:**  `const isAdmin = useIsMaster();`
- Remove the now-unused `currentUser` selector at line 23 (only callsite
  was the inline predicate). Optional but recommended — leaving a dead
  selector is a TS-quiet wart and the linter may flag it.
- Local-variable rename to `canEditTz` is **optional** per AC1.1; leaving
  the name `isAdmin` is acceptable since the JSX at lines 42/43/52 reads
  fine either way. Defer to the developer's preference.

**Semantic delta.** `useIsMaster()` returns true for `master` and
`super_admin` only — NOT for plain `admin`. The previous predicate
returned true for plain `admin` and `master`. So this is a SEMANTIC
CHANGE, not just a super_admin parity fix:

- Plain `admin` BEFORE: could edit TZ. AFTER: cannot.
- `master` BEFORE: could edit. AFTER: still can.
- `super_admin` BEFORE: could NOT edit. AFTER: can.

The spec language ("super_admin predicate parity") is slightly
ambiguous on this point but AC1.1 explicitly names `useIsMaster()` as
the replacement, and the PM-resolved Q&A at lines 144-152 implicitly
endorses the master-or-super-admin gate. **This is the correct shape per
the spec text** — plain admins lose TZ-edit access. If the PM intended
to widen the gate (admin+master+super_admin) rather than swap it
(master+super_admin), this needs to be flagged as a spec ambiguity
before build. **Architect's reading: take the spec at its word — use
`useIsMaster()` as written. Frontend dev should surface in the PR if
they read it differently.**

### 3. AC1.2 — `DashboardSection.tsx` — inline widening vs local helper

**File:** `src/screens/cmd/sections/DashboardSection.tsx`

**Decision: inline widening, not a helper.** Reasoning:
1. The audit (above) confirms this is the **only** row-data drift site
   in scope. A helper to abstract a single call site is YAGNI.
2. The other row-data sites in scope (UsersSection lines 268, 285, 279;
   BrandsSection line 880) all already enumerate the roles inline with
   the shape they need. A new helper here would be inconsistent with
   the established local-inline pattern in those files.
3. Adding a helper crosses a file boundary if it goes anywhere shared,
   or duplicates trivially if it stays file-local. Neither is worth
   the cost for one predicate.
4. Future-fourth-role drift (the §Risk note worry) is a real concern,
   but it applies equally to every row-data predicate in the codebase
   — solving it once at DashboardSection doesn't help. A future cleanup
   spec could promote a shared `isPrivilegedRole(role)` utility under
   `src/lib/` and migrate every site at once; that's the right scope
   for that fix, not this spec.

**Edits:**
- Replace lines 730-733:
  ```
  const manager =
    users.find(
      (u) => (u.role === 'admin' || u.role === 'master') && u.stores.includes(store.id),
    )?.name || '—';
  ```
  with:
  ```
  const manager =
    users.find(
      (u) =>
        (u.role === 'admin' || u.role === 'master' || u.role === 'super_admin') &&
        u.stores.includes(store.id),
    )?.name || '—';
  ```

Single-clause-added; signature and surrounding logic unchanged. No
imports added.

### 4. AC2 — `UsersSection.tsx:266-268` — strip self-delete

**File:** `src/screens/cmd/sections/UsersSection.tsx`

**Edits:**
- Replace lines 266-268:
  ```
  const canDelete = isMaster
    ? !isSelf
    : isSelf || (user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin');
  ```
  with:
  ```
  const canDelete = isMaster
    ? !isSelf
    : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin';
  ```

The change is `isSelf || (...)` → `!isSelf && (...)`. Both branches of
the ternary now agree: self-delete is unreachable regardless of viewer
role.

**Cross-check — other self-row gates in the same file:**

- **`canResetPassword`** (line 278-280) already excludes self (`!isSelf`
  in both branches). No change needed.
- **DeleteConfirmModal self-warning copy** (lines 227-232 / 232-234)
  remains as dead defensive code per AC2.4 — explicitly out of scope.
- **`deleteProfile` `silent: true` flag** on the self-call site (spec
  029) — stays per AC2.3.

**No other self-row gates exist outside this file.** UsersSection is
the only screen rendering a per-user delete affordance with a self-row
in the list.

### 5. AC3 — `cmdSelectors.ts:1078-1097` — Admin-group gating

**File:** `src/lib/cmdSelectors.ts`

**Edits:**
- Import update at line 8:
  - **Before:** `import { useIsSuperAdmin } from '../hooks/useRole';`
  - **After:**  `import { useIsSuperAdmin, useIsMaster } from '../hooks/useRole';`
- Hook body — add at line 1033 (immediately after the existing
  `const isSuperAdmin = useIsSuperAdmin();`):
  `const isMaster = useIsMaster();`
- Replace the unconditional Admin-group push at lines 1078-1086 with
  an `if (isMaster)` push, mirroring the existing `if (isSuperAdmin)`
  pattern at lines 1088-1095. Shape:
  ```
  if (isMaster) {
    groups.push({
      label: 'Admin',
      items: [
        { id: 'Users', label: 'Users & access' },
      ],
    });
  }
  if (isSuperAdmin) {
    groups.push({
      label: 'Tenancy',
      items: [
        { id: 'Brands', label: 'Brands' },
      ],
    });
  }
  ```
- Memo deps at line 1097:
  - **Before:** `[isSuperAdmin]`
  - **After:**  `[isSuperAdmin, isMaster]`

**Memo deps audit.** Inside the `useMemo` body the closure reads:

| Identifier | Source | Stable? | In deps? |
|---|---|---|---|
| `isSuperAdmin` | hook return at line 1032 | Reactive (subscribes to store) | YES — existing |
| `isMaster` | hook return (new at line 1033) | Reactive (subscribes to store) | YES — newly added |
| `SidebarGroup` (type) | import | compile-time | n/a |
| `useMemo` | React | n/a | n/a |
| `groups` | local | declared inside the memo body | n/a |

All other identifiers inside the body are literal item strings. No
other closure-captured reactive values exist. The deps array
`[isSuperAdmin, isMaster]` is correct and complete.

**Reactivity confirmation (AC3.2).** Both `useIsSuperAdmin()` and
`useIsMaster()` use `useStore((s) => s.currentUser?.role)` selectors,
which subscribe to that slice. When `currentUser.role` changes (e.g.,
the store reloads the profile after sign-in, or a role-update mutation
lands via realtime), each hook returns a fresh primitive, the
`useDefaultSidebarGroups()` host re-renders, and the memo recomputes
because its deps array changed. The default-tree change then propagates
through the consumers (`Sidebar`, `RailSidebar`, `MobileNavDrawer`).
The Spec 008 `applySidebarOverride()` is downstream and silently drops
any `Users` id stored in a custom group when the default no longer
contains it (AC3.4).

**Ordering (AC3.3).** Operations → Planning → Insights → Admin (if
master) → Tenancy (if super_admin). For a super_admin user, both gates
open; Admin pushes first because the if-block precedes the Tenancy
if-block in source order. Confirmed correct.

### 6. File-by-file edit list

| File | Lines | Change kind |
|---|---|---|
| `src/components/TimezoneBar.tsx` | +1 import (after line 15), modify line 23 (remove or keep `currentUser` selector — see §2), modify line 24 (predicate → `useIsMaster()`) | refactor |
| `src/screens/cmd/sections/DashboardSection.tsx` | modify lines 730-733 (inline widen predicate) | minimal widen |
| `src/screens/cmd/sections/UsersSection.tsx` | modify lines 266-268 (`isSelf ||` → `!isSelf &&`) | minimal logic flip |
| `src/lib/cmdSelectors.ts` | modify line 8 (import widen), add line ~1033 (`useIsMaster()` call), restructure lines 1078-1086 (wrap in `if (isMaster)`), modify line 1097 (deps array `+isMaster`) | structural — gate the group push |

Estimated diff: ~10-12 logical lines added/changed across four files.

### 7. Cross-cutting confirmations

- **No migrations.** Confirmed.
- **No edge function changes.** Confirmed. The `delete-user` self-delete
  400 gate remains the authoritative backstop (AC2.3, Out-of-scope §6).
- **No DB / RPC / view changes.** Confirmed.
- **No realtime channel changes.** Confirmed. (Realtime publication
  gotcha is not applicable.)
- **No `src/lib/db.ts` surface changes.** Confirmed. All three items
  are presentation-layer only.
- **No `src/store/useStore.ts` slice changes.** Confirmed. All gates
  read existing slices.
- **No `app.json` slug touch.** Confirmed (CLAUDE.md "app.json slug
  mismatch (DO NOT AUTO-FIX)").
- **No new packages, env vars, or config keys.** Confirmed.

### 8. Verification gates

Per PM checklist (cross-cutting AC4.1-AC4.6):

- `npx tsc --noEmit` — PASS expected.
- `npm run typecheck:test` — PASS expected.
- `npm test -- --ci` — PASS expected. No test changes anticipated; this
  is a regression guard. Test-engineer should confirm no existing test
  asserted the broken behaviors (especially: TimezoneBar admin gate,
  DashboardSection manager lookup, UsersSection self-delete button
  presence, sidebar groups for non-master admin).
- `npm run test:db` — PASS expected (sanity — no DB touched).
- `npm run test:smoke` — PASS expected (sanity — no edge fn touched).
- Manual browser smokes per AC1.4, AC1.5, AC2.5, AC3.5. Pre-existing
  local dev stack via `npm run dev:db` per project memory; login at
  `admin@local.test / password`.

### 9. Risks and tradeoffs

**Risk 1 — TimezoneBar semantic change.** Plain `admin` users lose TZ
edit ability. The spec text says swap-to-`useIsMaster()`; the architect
read this at face value. If PM wanted widen-not-swap (i.e., keep plain
`admin` able to edit TZ), the design needs to be re-spec'd. Flagging
explicitly; not blocking.

**Risk 2 — Memo identity stability.** `useIsSuperAdmin()` and
`useIsMaster()` return new primitives on every store update, but the
selector subscribes to `currentUser?.role` (a string), so the hook
return only changes when the role string changes. Memo will not
re-fire on unrelated store updates. Confirmed safe.

**Risk 3 — Spec 008 sidebar override drift.** A non-master admin who
in a prior session dragged "Users & access" into a custom group will
silently lose it on next render. AC3.4 explicitly accepts this; no
migration. Acceptable.

**Risk 4 — BrandsSection.tsx:880 deferral.** The `canActOn` predicate
in BrandsSection's MembersTab excludes `super_admin` from the demote /
delete affordance. The audit table marks this no-change. If a future
need surfaces to demote a super_admin from a per-brand admins list,
that's a separate spec; the current behavior (super_admins exempt from
brand-scoped demote/delete) is defensible.

**No performance, RLS, migration-ordering, or cold-start concerns.**
All four files are render-time only.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (§2-§5 are the per-item
  diff specs; §6 is the file-by-file edit list). After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed. Note in your handoff whether you renamed the
  TimezoneBar local `isAdmin` to `canEditTz` (optional per AC1.1) so
  reviewers don't flag the dangling name.
payload_paths:
  - specs/030-role-gate-corrections/spec.md

## Implementation note (frontend-developer)

User mid-stream correction to Item 1.1: the architect's design called for
swapping `TimezoneBar`'s predicate to `useIsMaster()`, but the user
flagged this as a SEMANTIC CHANGE rather than a super_admin parity fix
(it would drop plain `admin` users from TZ-edit access). The corrected
shape is **inline widening** — add `|| 'super_admin'` to the existing
two-clause `'admin' || 'master'` predicate, leaving plain admins'
TZ-edit access intact and granting it to super_admins.

This deviates from §2's "swap to useIsMaster()" but matches the inline
widening pattern §3 chose for DashboardSection. The §1 audit table's
"Item 1.1 — replace with `useIsMaster()`" disposition reads as
"widen the admin/master predicate to include super_admin" under this
correction — semantically equivalent at the call site for master and
super_admin, but preserves plain admin.

No shared helper extracted; only two in-scope sites needed the widening
per the §1 audit, and the architect's §3 rationale against a helper
applies symmetrically to TimezoneBar.

## Files changed

- `src/components/TimezoneBar.tsx` — Item 1.1: widened the inline
  `admin || master` predicate at the `isAdmin` site to also accept
  `super_admin`. Per the user's correction, kept the existing inline
  shape and added a third clause rather than swapping to
  `useIsMaster()` (which would have dropped plain `admin` users from
  TZ-edit access). Local var name `isAdmin` retained — JSX call sites
  still read naturally.
- `src/screens/cmd/sections/DashboardSection.tsx` — Item 1.2: widened
  the manager-lookup row-data predicate at line ~730 to also accept
  `super_admin`, per architect's design §3 (inline widening, no helper).
- `src/screens/cmd/sections/UsersSection.tsx` — Item 2: replaced
  `isSelf || (...)` with `!isSelf && (...)` in the non-master-admin
  branch of `canDelete`. Self-delete is now unreachable from the UI in
  both ternary branches. Comment block updated to document the
  authoritative `delete-user` 400 backstop.
- `src/lib/cmdSelectors.ts` — Item 3: added `useIsMaster` to the
  `../hooks/useRole` import, added `const isMaster = useIsMaster();`
  next to the existing `useIsSuperAdmin()` call, wrapped the Admin
  group push in `if (isMaster) { ... }` mirroring the Tenancy
  super-admin pattern, and added `isMaster` to the `useMemo` deps
  array. Ordering preserved: Operations → Planning → Insights →
  Admin (if master) → Tenancy (if super_admin).
