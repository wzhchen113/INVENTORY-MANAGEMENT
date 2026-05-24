# Spec 063: Fold imr-staff into imr-inventory

Status: READY_FOR_REVIEW
Owner: PM

## Problem statement

The staff app currently lives in a sibling repo (`imr-staff`). Cross-repo
friction has been felt acutely during specs 061 (staff EOD count) and 062
(staff auth gate fix): two `node_modules` trees, two CI workflows, two version
cycles, and two places to track for a single product surface. The auth model is
already unified (per-user JWT, single Supabase project), and there is no native
push channel planned within six months — distribution is web-only via Vercel +
Service Worker for both surfaces. The two repos no longer have any architectural
reason to be separate.

## Background

- Original split was historical — `imr-staff` was scaffolded as a separate Expo
  app to keep concerns clean while the admin app stabilised.
- Spec 061 aligned auth across both surfaces (per-user JWT, no service token on
  the staff path).
- Spec 062 added a post-sign-in auth gate (`role + user_stores` check) in
  `imr-staff/src/lib/authGate.ts`. The gate logic is now stable and ports
  cleanly to imr-inventory.
- Cross-repo coordination overhead is non-trivial: the spec 062 critical fix
  required a coordinated push to imr-staff while the spec for it lived in
  imr-inventory. That seam should not exist.
- Customer PWA will also fold in later (separate future spec). Spec 063 is
  staff-only.

## User stories

- As a **staff member**, I want to sign in via the same URL my admin uses, and
  land on the staff EOD screen automatically based on my role — no separate
  domain, no separate app to install.
- As an **admin**, I want my Cmd UI to continue working unchanged after the
  merge — no regression in any existing admin flow.
- As an **engineer**, I want a single CI run, a single `node_modules`, a single
  version cycle, and a single repo to track for the 2AM PROJECT admin+staff
  surface.

## Acceptance criteria

### Track A — Code migration

- [ ] `git subtree add --prefix=src/screens/staff https://github.com/wzhchen113/imr-staff.git main --squash`
      runs cleanly from the imr-inventory repo root. (Squash recommended; full
      history preserved in archived repo. Architect confirms in design.)
- [ ] Migrated code lives at `src/screens/staff/` (peer to existing
      `src/screens/cmd/`), NOT at `staff-app/` at repo root.
- [ ] The following staff-only dependencies (those not already in
      imr-inventory's `package.json`) are added to imr-inventory's
      `package.json` at the same minor version imr-staff uses today:
  - `@react-native-async-storage/async-storage`
  - `@react-native-community/netinfo`
  - `react-native-toast-message`
      Architect surveys both `package.json`s and lists final delta before merge.
- [ ] i18n keys from staff are resolved into imr-inventory's i18n at
      `src/i18n/` — either merged with a `staff.*` namespace prefix on every
      key or kept in a sibling file, architect picks. No runtime key collisions
      (verified by jest + manual smoke).
- [ ] Theme tokens from staff either merge into imr-inventory's theme tokens or
      stay at `src/screens/staff/theme.ts` if visual languages differ.
      Architect picks.
- [ ] The staff-app's `App.tsx`, `package.json`, `tsconfig.json`,
      `babel.config.js`, `metro.config.js`, `app.json`, `eas.json`,
      `vercel.json` are REMOVED during/after subtree — only the `src/`
      content survives in `src/screens/staff/`. The surrounding scaffold is
      discarded.
- [ ] `jest.setup.js` patches from imr-staff (RN 0.81 `mockComponent` shim)
      merge into imr-inventory's jest config without breaking imr-inventory's
      existing 259 tests.
- [ ] Staff's Zustand store is renamed to avoid colliding with imr-inventory's
      `useStore` — recommended `useStaffStore` at
      `src/screens/staff/store/useStaffStore.ts`. Architect picks final name.
- [ ] Final tree has no leftover `staff-app/` directory anywhere in the repo.

### Track B — Routing

- [ ] New top-level role router lives at `src/navigation/RoleRouter.tsx` (or
      `CmdNavigator.tsx` is extended — architect picks). `App.tsx` mounts the
      role-router root.
- [ ] After sign-in (single shared `/login` portal), `profiles.role` is read
      and the user is dispatched:
  - `'admin' | 'super_admin' | 'master'` → existing Cmd UI (CmdNavigator,
    unchanged paths).
  - `'user'` → staff stack starting at `StorePicker` (or `EODCount` if
    `user_stores` is exactly one row; same shortcut imr-staff already does).
- [ ] URL structure: `imr-inventory.vercel.app/` for admin (current behaviour
      preserved); `imr-inventory.vercel.app/staff/*` for staff routes. React
      Navigation 6 `linking` config covers both subtrees; architect designs
      the full path tree.
- [ ] No route-name collisions across the merged navigators. Staff routes are
      namespaced under `Staff/...` in React Navigation's screen registry.
- [ ] A "switch surface" affordance exists in the header for users whose JWT
      grants both admin and staff context (unlikely today; surfaced as a future
      hook, not blocking).

### Track C — Login portal

- [ ] The existing admin sign-in screen at
      `src/screens/cmd/sections/SignInSection.tsx` (or the equivalent path
      architect identifies) becomes the SHARED portal for both surfaces.
- [ ] The staff app's `SignIn.tsx` is REPLACED by the shared portal —
      `src/screens/staff/screens/SignIn.tsx` is deleted in the merge commit
      (or repurposed as a re-export, architect picks).
- [ ] The staff auth-gate logic from `imr-staff/src/lib/authGate.ts` ports to
      imr-inventory at `src/lib/authGate.ts` (or merges with existing
      imr-inventory auth helpers — architect picks). The gate fires AFTER
      sign-in regardless of which surface the user is heading to; staff users
      with missing role/store assignment see the same error toast that spec 062
      shipped.
- [ ] The error-toast strings for gate failure are identical to what spec 062
      shipped (byte-for-byte). Existing jest coverage for the gate continues
      to pass.

### Track D — Cutover + archive

- [ ] [CLAUDE.md](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md)
      is updated to reflect the new structure — the "sibling apps live
      elsewhere" line is removed; the role-routed shell is documented; the
      `src/screens/staff/` tree is added to the project-structure block.
- [ ] [vercel.json](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/vercel.json)
      is reviewed and updated if needed (likely no change required — Expo's
      `npx expo export --platform web` already produces an SPA bundle that
      handles client-side routing).
- [ ] After the merge lands and passes CI, the `imr-staff` GitHub repo is
      archived (`gh repo archive wzhchen113/imr-staff --confirm`). NOT deleted.
- [ ] A one-line note is added to `imr-staff/README.md` BEFORE archiving:
      "Merged into imr-inventory via spec 063. See
      `imr-inventory/specs/063-fold-imr-staff-into-imr-inventory.md`."
- [ ] Manual browser smoke passes:
  - Sign in as admin (`admin@local.test` / `password`) → land in Cmd UI.
  - Sign in as `manager@local.test` (or equivalent staff user) → land in
    staff stack at `StorePicker` or `EODCount`.
  - The shell smoke `scripts/smoke-staff-eod.sh` continues to pass unchanged
    (backend contract unchanged).

## In scope

- Subtree merge of `imr-staff` into `src/screens/staff/`.
- Top-level role-routed navigator.
- Shared sign-in portal.
- Port of spec 062's auth-gate logic.
- Reconciliation of dependencies, i18n keys, theme tokens, jest config, and
  Zustand store names.
- CLAUDE.md update reflecting the new structure.
- Archive of the `imr-staff` repo.

## Out of scope (explicitly)

- **Bundle splitting.** v1 ships admin code to staff phones and vice versa.
  This is acceptable for now; defer to a follow-up spec once route-based
  code-splitting is wired through Metro/Expo Router.
- **Customer PWA fold-in.** Same playbook will repeat for the customer PWA in
  a future spec; not this one.
- **Native iOS/Android distribution.** Explicitly deferred per user decision —
  no native push needed within six months; PWA via Vercel + Service Worker is
  the staff distribution channel.
- **New i18n locales.** English only stays; no locale expansion in this spec.
- **Web-push notification setup.** A future spec adds Service Worker push if
  needed; not this one.
- **Visual redesign of staff screens.** Staff screens ship as-is from imr-staff;
  the visual language stays.
- **Spec 062 deferred-cleanup items** (1 Should-fix + 2 Nits + 3 architect
  cycle-2 items) — they stay deferred unless they directly conflict with the
  merge mechanics.

## Open questions for architect

1. **Subtree merge: squash vs. preserve history.** Recommend `--squash` (the
   imr-staff history is short, ~3 commits, and the archived repo preserves full
   history for reference). Architect confirms.
2. **Routing root.** Does `App.tsx` mount a top-level `RoleRouter` that holds
   both `CmdNavigator` and the staff stack as siblings, or does `CmdNavigator`
   itself gain a `/staff` branch? Architect picks; PM-recommended is the
   former for cleaner separation.
3. **React Navigation `linking` config.** Architect designs the full path tree
   covering both surfaces, including the deep-link shape for staff EOD.
4. **Auth-gate location.** Spec 062 placed gate logic at
   `imr-staff/src/lib/authGate.ts`. After merge, does it land at
   `src/lib/authGate.ts` or merge with existing imr-inventory auth helpers
   (e.g. `src/lib/auth.ts`)? Architect picks.
5. **Zustand store name collision.** Staff's `useStore` collides with
   imr-inventory's `useStore`. Options:
   (a) Rename staff's to `useStaffStore` (PM-recommended; minimal disruption).
   (b) Merge slices into one root store with `useStore().staff.*` / `.admin.*`.
   (c) Namespaced sibling stores.
   Architect picks.
6. **i18n key namespace.** Survey both `src/i18n/` trees (imr-inventory) and
   the imr-staff i18n keys (`eod.*`, `chrome.*`, `auth.*`). List collisions and
   propose final namespacing (staff.eod.*, staff.chrome.*, staff.auth.* is the
   PM default; architect confirms).
7. **TestID and accessibility-label namespaces.** Same survey as above, lower
   stakes. Architect lists collisions if any.

## Dependencies

- No backend changes. Spec 061's RPC contract is unchanged; spec 062's gate
  logic ports verbatim.
- No new migrations.
- No edge function changes.
- Tests: full jest suite from both repos. imr-inventory has 259 tests;
  imr-staff has 61 tests; expected post-merge ~320. Some conflicts (jest
  config, mock paths) are likely — architect resolves before merge.
- Vercel deployment must succeed post-merge — one-shot deploy serves both
  surfaces.

## Risk + mitigation

| Risk | Mitigation |
|------|------------|
| Dependency version conflicts (e.g. different `@react-native-async-storage/async-storage` versions). | Architect surveys both `package.json`s before merge and reconciles to imr-inventory's locked versions where conflict exists. |
| Jest config conflicts (RN 0.81 `mockComponent` patches from imr-staff might interact with imr-inventory's existing setup). | Run full jest suite after merge; fix any failures before review. |
| Route-name collisions in React Navigation cause runtime crashes. | Namespace all staff routes under `Staff/...` in the screen registry. |
| i18n key collisions cause runtime crashes (missing-key warnings or wrong-language strings). | Architect surveys both files before merge; namespace renames are mechanical. |
| Zustand `useStore` collision causes import shadowing. | Rename staff store to `useStaffStore` (or architect's chosen approach) BEFORE the first commit that touches both. |
| Subtree merge introduces unexpected files (e.g. `staff-app/.github/`, `staff-app/eas.json`). | The `--prefix=src/screens/staff/` lands everything under one prefix; clean up scaffold files in a follow-up commit before merge is finalised. |
| Vercel build breaks post-merge (Expo export emits unexpected route structure). | Manual build verification (`npx expo export --platform web`) before pushing; CI catches the rest. |
| Archiving imr-staff before merge is verified leaves staff stranded. | Archive happens LAST, only after the merged build is live on Vercel and the manual smoke passes. |

## Sequencing

1. **Architect** designs (resolves the 7 open questions; produces design doc;
   sets `Status: READY_FOR_BUILD`).
2. **Developer** (frontend-developer — work is FE-only) executes the subtree
   merge + reconciliations on a feature branch; sets `Status: READY_FOR_REVIEW`.
3. **Reviewer fan-out** (parallel): `code-reviewer` + `test-engineer` +
   `backend-architect` (post-impl). `security-auditor` is NOT in this fan-out —
   no auth boundary changes, just code reorganization; spec 062's gate logic
   ports verbatim with no semantic change.
4. **Manual browser smoke** (main Claude runs): sign in as admin → Cmd UI;
   sign in as staff → staff stack; spec 061's EOD flow works end-to-end.
5. **release-coordinator** synthesises reviewer findings into a proposal.
6. **User confirms.** Commit + push to imr-inventory.
7. **Archive** `imr-staff` GitHub repo (one-line README note added first).
8. **CLAUDE.md** updated to reflect the new structure (can land in the same
   commit as the merge if convenient).

## Project-specific notes

- **Cmd UI section / legacy.** The merge places staff code as a peer to
  `src/screens/cmd/` at `src/screens/staff/`. No legacy admin surface is
  touched. Spec 025 already removed the legacy `AppNavigator`.
- **Per-store or admin-global.** The staff stack is per-store (spec 061's
  store-picker). Admin Cmd UI behaviour is unchanged. No RLS changes.
- **Realtime channels touched.** None. Staff EOD doesn't use realtime; admin
  Cmd UI's existing realtime wiring (`store-{id}` + `brand-{id}`) is
  untouched.
- **Migrations needed.** No.
- **Edge functions touched.** None.
- **Web/native scope.** Web only. Native distribution is explicitly deferred.
  Per the user decision: no native push needed within six months; PWA via
  Vercel + Service Worker is the staff distribution channel.
- **`app.json` slug.** NOT touched. The `app.json` slug stays `towson-inventory`
  per the CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)" rule. If
  architect or developer thinks it needs to change, surface as an open question
  for the user.
- **Tests.** Track: **jest** (FE work; both existing suites merge). The
  pgTAP track is untouched (no DB changes). The shell-smoke track is untouched
  (`scripts/smoke-staff-eod.sh` continues to pass).

## Open questions resolved

- Q: Native push within 6 months? → A: No. PWA via Vercel + Service Worker is
  the staff distribution channel.
- Q: Customer PWA in this spec? → A: No. Future spec repeats the playbook.
- Q: `git subtree add` to preserve history, or `cp -r` to start clean? → A:
  `git subtree add` to preserve history. Squash recommended (architect
  confirms).
- Q: Delete imr-staff after merge, or archive? → A: Archive
  (`gh repo archive`), not delete.
- Q: Bundle splitting in this spec? → A: Deferred to a follow-up spec.

## Frontend architecture design

**Scope reminder.** Despite the dispatching agent's name (`backend-architect`),
this spec is FRONTEND-ONLY. There are no migrations, no edge function
changes, no RPC contract changes (spec 061's `staff_submit_eod` is
immutable), no RLS changes, no realtime publication changes. The "Realtime
publication gotcha" callout in the agent contract does not apply. All
sections below describe FE file organisation, navigation topology,
dependency reconciliation, and naming-collision resolution.

### 1. Open questions — resolutions

**Q1: Subtree merge — squash vs. preserve history.**
RESOLVE: `--squash`. The imr-staff repo has 3 commits (`481b561`,
`7e97e2f`, `5072c56`) representing spec 061 ship + spec 062 critical-fix
+ spec 062 fix-pass. Importing 3 commits with their authorship into
imr-inventory's main-branch log buys no spelunking value; the
imr-inventory specs/061 + specs/062 files already document the intent.
The archived imr-staff repo preserves the granular per-spec history for
anyone who needs to dig. Rationale: short history + spec docs already
in imr-inventory = no value in the unsquashed log.

**Q2: Routing root shape.**
RESOLVE: option (a) — new `src/navigation/RoleRouter.tsx`. CmdNavigator
already owns a lot — desktop shell, command palette, realtime debounce,
auth-gated stack toggle. Folding a staff branch into CmdNavigator
multiplies the responsibilities of a file that is already at the limit
of comfortable comprehension (152 lines, dense). RoleRouter is a
single-responsibility component: read auth + role, dispatch to one of
two sibling navigators. CmdNavigator stays exactly as it is; staff
navigation gets its own peer component. Easier to reason about, easier
to test, easier to delete if the merge is ever reversed.

**Q3: React Navigation 6 `linking` path tree.**
RESOLVE: Configure `linking` on the OUTER `NavigationContainer` (the
one mounted by RoleRouter — see Q2). The inner navigators
(`CmdNavigator`'s admin stack and the staff stack) keep their existing
screen-name registries; the `linking.config.screens` tree maps URL
paths to screen names with `Staff/` prefix for staff routes to avoid
collisions.

```
URL                          Screen path                          Notes
─────────────────────────    ────────────────────────────────     ──────────────────────────
/                            Admin → Shell                        Default landing; CmdNavigator's existing AuthedRoot
/login                       Login                                Shared SignIn portal (Q8)
/register                    Register                             Existing admin register screen
/staff                       Staff → StaffRoot                    Auto-routes to picker or EOD based on user_stores count
/staff/store-picker          Staff → StorePicker                  Explicit picker
/staff/eod                   Staff → EODCount                     Explicit EOD (current store from store slice)
/db-inspector                Admin → DBInspector                  Existing admin route
/cmd-atoms-preview           Admin → CmdAtomsPreview              Dev-only; __DEV__ gate stays
```

CRITICAL CONSTRAINT — admin app currently has NO `linking` config; all
URLs collapse to `/` via Vercel's SPA fallback rewrite
([vercel.json:4-5](vercel.json)). Adding `linking` for the first time
introduces a new contract: the URL bar becomes meaningful. This is a
SHIP-ABLE V1 behaviour but flag for the developer — if `linking` causes
any flicker / unexpected redirect on /, ship the routing topology
WITHOUT `linking` enabled (RoleRouter still works; just no deep links)
and address `linking` polish in a follow-up. The Vercel rewrite stays
intact either way (React Navigation's web linking runs on the SPA after
the rewrite has served `index.html`).

Deep-link for staff EOD: `imr-inventory.vercel.app/staff/eod` — staff
user signs in, gets dispatched to `/staff`, and an internal redirect
sends them to `/staff/store-picker` or `/staff/eod` based on
`user_stores.length`. Direct paste of `/staff/eod` URL by a staff user
already signed-in with one store works; staff with no active store hits
the picker first.

**Q4: Auth-gate location.**
RESOLVE: option (a) — `src/lib/authGate.ts` at the top level, shared.
Direct verbatim port from `imr-staff/src/lib/authGate.ts`. Rationale:
the gate (role + user_stores check) is a SHARED concern post-merge
even though the admin path doesn't currently invoke it. Putting it
under `src/screens/staff/lib/` would imply the gate is staff-internal,
which becomes false the moment any cross-surface auth helper needs to
read role.

The admin path's existing sign-in (`LoginScreen.tsx`) does NOT call
`checkAuthGate` in v1. Adding "defensive parity" (admin sign-in also
runs the gate) is OUT OF SCOPE for this spec — the admin app's role
gating is currently handled by `useStore.currentUser` + `useIsSuperAdmin`
+ `useIsMaster` AFTER sign-in succeeds, and the staff-vs-admin
dispatch happens in RoleRouter based on `profiles.role`. The gate is
imported but unused on the admin side until a future spec wires it in.
Surface the parity gap as a follow-up.

**Q5: Zustand store collision.**
RESOLVE: option (a) — rename staff's to `useStaffStore` at
`src/screens/staff/store/useStaffStore.ts`. Admin's existing
`src/store/useStore.ts` is unchanged (51 KB, ~64 KB db.ts, hundreds of
call sites). Touching it is a multiplicative blast radius for zero
gain. Staff store ships as a peer under `src/screens/staff/store/`.
Imports inside the staff subtree change from `from '../store/useStore'`
to `from './store/useStaffStore'` or co-located equivalents. Export
naming inside the file:

```ts
// before (imr-staff/src/store/useStore.ts)
export const useStore = create<StaffState>(...);
export function currentUserId(...) {...}
export function selectStores(...) {...}

// after (src/screens/staff/store/useStaffStore.ts)
export const useStaffStore = create<StaffState>(...);
export function currentStaffUserId(...) {...}     // rename to avoid ambiguity
export function selectStaffStores(...) {...}      // rename to avoid ambiguity
```

`currentUserId` and `selectStores` collide with semantically-different
admin concepts (admin `currentUser` is a `User` from `src/types`, with
role etc; staff's userId comes from `authState.kind === 'signed-in'`).
Renaming them to `currentStaffUserId` / `selectStaffStores` removes the
trap. Defer slice consolidation into a single root store to a future
spec if the two-store split becomes painful — for v1 the boundary is
clean (admin code never reads `useStaffStore`; staff code never reads
`useStore`).

**Q6: i18n namespace collisions — survey + resolution.**

Surveyed `imr-inventory/src/i18n/en.json` vs
`imr-staff/src/i18n/en.json`. Top-level keys in each:

```
imr-inventory:   sidebar, chrome, common, toast, dialog, section,
                 component, tabStrip, modals, drawers, filterChip, enum
imr-staff:       auth, store, eod, chrome
```

Direct collisions:

- `chrome.*` — TRUE COLLISION. imr-inventory uses `chrome.signOut`,
  `chrome.signOutConfirm`, `chrome.signOutBody`, `chrome.connected`,
  `chrome.localeSwitcher.*`, etc. imr-staff uses `chrome.signOut.label`,
  `chrome.signOut.confirmTitle`, `chrome.signOut.confirmMessage`,
  `chrome.signedOut`, `chrome.switchStore`, `chrome.queue.*`,
  `chrome.errorBoundary.*`. Different shapes (admin has flat
  `chrome.signOut: "sign out"`; staff has nested `chrome.signOut.label`).
  Merging into one `chrome.*` namespace would shadow the admin's flat
  `chrome.signOut` string with a `{label, confirmTitle, confirmMessage}`
  object — runtime mis-render.

- `section.eod.*` — POTENTIAL COLLISION but harmless. imr-inventory has
  a deep `section.eod.*` tree (EOD count UI within admin Cmd UI).
  imr-staff has `eod.*` (top-level). DIFFERENT paths so technically
  no shadow, but conceptually overlapping.

- `auth.*` — NEW. imr-inventory does not have a top-level `auth.*`
  key. imr-staff has `auth.signIn.*` and `auth.error.*`. No shadow.

- `store.*` — NEW. imr-inventory does not have a top-level `store.*`
  key. imr-staff has `store.picker.*`. No shadow.

RESOLUTION: keep staff i18n in a SEPARATE locale file at
`src/screens/staff/i18n/en.json` with its own `t()` helper at
`src/screens/staff/i18n/index.ts` (verbatim port from imr-staff).
Rationale:

- Zero merge effort — the staff catalog ports as-is.
- Zero risk of admin-side `chrome.*` regression. Admin call sites read
  from `src/i18n/index.ts` (their own catalog); staff call sites read
  from `src/screens/staff/i18n/index.ts` (their own).
- Single-file size stays manageable.
- Future locale expansion (es / zh-CN for staff) lands in the staff
  catalog without bloating the admin catalog.

DO NOT prefix every staff key with `staff.*` and merge — that buys
"single source of truth" at the cost of mechanical renames across
every staff call site (~60 lines touching `t()`). The two-catalog
approach is the lower-effort, lower-risk landing.

Catalog parity test (`src/screens/staff/i18n/i18n.test.ts`) ports
verbatim from imr-staff and validates only the staff catalog. The
existing admin i18n test
([src/i18n/i18n.test.ts](src/i18n/i18n.test.ts)) is unchanged.

**Q7: TestID and accessibility-label namespacing.**

Surveyed both repos for `testID=` strings. imr-staff uses:
`sign-in-email`, `sign-in-password`, `sign-in-submit`, `eod-store-name`,
`eod-sign-out`, `eod-prefill-banner`, `vendor-chip-${id}`,
`eod-item-row-${id}`, `eod-item-input-${id}`, `eod-queue-indicator`,
`eod-submit`, `store-row-${id}`.

imr-inventory's `LoginScreen` uses `signin-submit` (NO hyphen between
`sign` and `in`, vs imr-staff's `sign-in-submit`). NOT a collision —
different strings — but flag this as inconsistent: post-merge there
will be both `signin-submit` (admin login) and `sign-in-submit` (staff
sign-in if the staff portal is kept). With the shared sign-in portal
(see Q8), only one of these survives. Recommendation: keep
`signin-submit` (admin) as the canonical testID on the shared portal,
and the staff `sign-in-*` testIDs disappear with the deleted
`src/screens/staff/screens/SignIn.tsx` (Q8). The shell-smoke
`scripts/smoke-staff-eod.sh` does NOT reference any sign-in testID
(it uses RPC + ?session= injection paths, not the UI), so this rename
is safe.

Other staff testIDs (`eod-*`, `vendor-chip-*`, `store-row-*`) do NOT
collide with any imr-inventory testID. They land as-is.

Accessibility labels: imr-staff uses `t('chrome.switchStore')`,
`t('chrome.signOut.label')` etc. — these strings are loaded from the
staff i18n catalog, so they're isolated. No global collisions.

### 2. Exact subtree command

Run from the imr-inventory repo root:

```bash
git subtree add --prefix=src/screens/staff \
  https://github.com/wzhchen113/imr-staff.git main --squash
```

Verify in a follow-up commit that the prefix directory ONLY contains
`src/` content (see §3 DELETE list). The default subtree-add brings
EVERYTHING including the root scaffold; the cleanup commit removes
`App.tsx`, `package.json`, `tsconfig.json`, `babel.config.js`,
`metro.config.js`, `app.json`, `eas.json`, `vercel.json`, `README.md`,
`CLAUDE.md`, and `.gitignore` from `src/screens/staff/`.

The squash creates one merge commit with a message like
`"Squashed 'src/screens/staff/' content from commit 5072c56"` — this
is acceptable and human-readable.

### 3. File move + rename + DELETE list

**Move VERBATIM (no rename, no content change):**

```
imr-staff/src/components/Banner.tsx              → src/screens/staff/components/Banner.tsx
imr-staff/src/components/Button.tsx              → src/screens/staff/components/Button.tsx
imr-staff/src/components/ErrorBoundary.tsx       → src/screens/staff/components/ErrorBoundary.tsx
imr-staff/src/components/Input.tsx               → src/screens/staff/components/Input.tsx
imr-staff/src/components/ListRow.tsx             → src/screens/staff/components/ListRow.tsx
imr-staff/src/components/QueueIndicator.tsx      → src/screens/staff/components/QueueIndicator.tsx
imr-staff/src/hooks/useConnectionStatus.ts       → src/screens/staff/hooks/useConnectionStatus.ts  [SEE NOTE]
imr-staff/src/hooks/useConnectionStatus.test.ts  → src/screens/staff/hooks/useConnectionStatus.test.ts
imr-staff/src/hooks/useEodSubmit.ts              → src/screens/staff/hooks/useEodSubmit.ts
imr-staff/src/hooks/useEodSubmit.test.ts         → src/screens/staff/hooks/useEodSubmit.test.ts
imr-staff/src/i18n/en.json                       → src/screens/staff/i18n/en.json
imr-staff/src/i18n/index.ts                      → src/screens/staff/i18n/index.ts
imr-staff/src/i18n/i18n.test.ts                  → src/screens/staff/i18n/i18n.test.ts
imr-staff/src/lib/authGate.ts                    → src/lib/authGate.ts                              [TOP-LEVEL — Q4]
imr-staff/src/lib/confirmAction.ts               → (DELETE — admin has equivalent at src/utils/confirmAction.ts; see §3b)
imr-staff/src/lib/eodQueue.ts                    → src/screens/staff/lib/eodQueue.ts
imr-staff/src/lib/eodQueue.test.ts               → src/screens/staff/lib/eodQueue.test.ts
imr-staff/src/lib/notifyBackendError.ts          → src/screens/staff/lib/notifyBackendError.ts
imr-staff/src/lib/supabase.ts                    → (DELETE — admin has equivalent at src/lib/supabase.ts; see §3b)
imr-staff/src/lib/types.ts                       → src/screens/staff/lib/types.ts
imr-staff/src/lib/uuid.ts                        → src/screens/staff/lib/uuid.ts
imr-staff/src/screens/EODCount.tsx               → src/screens/staff/screens/EODCount.tsx
imr-staff/src/screens/EODCount.test.tsx          → src/screens/staff/screens/EODCount.test.tsx
imr-staff/src/screens/SignIn.tsx                 → (DELETE — replaced by shared portal; see Q8 + §3b)
imr-staff/src/screens/SignIn.test.tsx            → (DELETE — paired with the screen; see Q8 + §3b)
imr-staff/src/screens/StorePicker.tsx            → src/screens/staff/screens/StorePicker.tsx
imr-staff/src/screens/StorePicker.test.tsx      → src/screens/staff/screens/StorePicker.test.tsx
imr-staff/src/__mocks__/useEodSubmit.ts          → src/screens/staff/__mocks__/useEodSubmit.ts
imr-staff/src/theme.ts                           → src/screens/staff/theme.ts                       [STAYS SEPARATE]
imr-staff/src/navigation/RootStack.tsx           → src/screens/staff/navigation/StaffStack.tsx     [RENAMED + ADAPTED — see §6]
imr-staff/src/navigation/RootStack.test.tsx      → src/screens/staff/navigation/StaffStack.test.tsx
imr-staff/src/store/useStore.ts                  → src/screens/staff/store/useStaffStore.ts        [RENAMED — Q5]
imr-staff/src/store/useStore.test.ts             → src/screens/staff/store/useStaffStore.test.ts
imr-staff/src/README.md                          → src/screens/staff/README.md                     [reference only]
```

NOTE on `useConnectionStatus`: imr-inventory already has
[src/hooks/useConnectionStatus.ts](src/hooks/useConnectionStatus.ts)
(spec 059) — a DIFFERENT implementation that subscribes to the supabase
realtime socket. The staff version subscribes to navigator.onLine /
NetInfo. They CANNOT be unified for v1 — admin's hook only fires on
realtime socket events; staff doesn't have realtime. Keep them as two
separate files with two separate names if landing them as siblings;
recommended:

- `src/hooks/useConnectionStatus.ts` — admin (existing, untouched)
- `src/screens/staff/hooks/useConnectionStatus.ts` — staff (imported
  from imr-staff). Import path stays staff-internal — admin code does
  not see it.

Both are named `useConnectionStatus` in their own scope; there is NO
runtime conflict because they're imported from different paths. Future
unification (a single hook with a strategy pattern) is OUT OF SCOPE.

**§3b — DELETED on import (not moved):**

| File | Reason |
|------|--------|
| `imr-staff/App.tsx` | Replaced by changes in imr-inventory's existing [App.tsx](App.tsx). The mount logic (queue hydration + migration) folds into the existing App.tsx's useEffect — see §6. |
| `imr-staff/package.json` | Dependencies merge into imr-inventory's [package.json](package.json). See §4. |
| `imr-staff/tsconfig.json` | imr-inventory's existing [tsconfig.json](tsconfig.json) covers `src/**/*`. |
| `imr-staff/babel.config.js` | Identical to imr-inventory's babel.config.js. |
| `imr-staff/metro.config.js` | imr-inventory has its own. |
| `imr-staff/app.json` | imr-staff's app.json carries `name: imr-staff`. NOT used post-merge — imr-inventory's `app.json` is the single source (slug stays `towson-inventory` per the DO-NOT-AUTO-FIX rule). |
| `imr-staff/eas.json` | Same as above. |
| `imr-staff/vercel.json` | imr-inventory has its own at root — staff routes ship through the same SPA bundle. |
| `imr-staff/jest.setup.js` | MERGE into imr-inventory's [tests/jest.setup.ts](tests/jest.setup.ts) — see §5. |
| `imr-staff/README.md` + `CLAUDE.md` | Project docs from the standalone repo, no longer authoritative. |
| `imr-staff/.gitignore` | imr-inventory has its own. |
| `imr-staff/src/screens/SignIn.tsx` + `.test.tsx` | Replaced by shared sign-in portal — see Q8. The staff sign-in is REPLACED, not repurposed. The auth-gate logic itself (`checkAuthGate` from `src/lib/authGate.ts`) is what gets called from the shared portal post-sign-in for users whose role is `'user'`. |
| `imr-staff/src/lib/supabase.ts` | imr-inventory's `src/lib/supabase.ts` is the single client. Staff code's imports of `'../lib/supabase'` rewrite to `'../../../lib/supabase'` (i.e. import from the admin app's supabase singleton). The two clients are otherwise identical. |
| `imr-staff/src/lib/confirmAction.ts` | imr-inventory's `src/utils/confirmAction.ts` is functionally identical (web → `window.confirm`, native → `Alert.alert`). One ADDITION: the imr-inventory version takes 3 args `(title, message, onConfirm)` and hardcodes button label `"Delete"`. The staff version takes a 4th `confirmLabel = 'OK'` arg. The staff call site
([imr-staff/src/screens/EODCount.tsx:283](../../imr-staff/src/screens/EODCount.tsx))
passes `t('chrome.signOut.label')` as the label — i.e. it relies on the 4th arg. RESOLUTION: extend imr-inventory's `src/utils/confirmAction.ts` to take an optional `confirmLabel = 'OK'` 4th arg (backwards-compatible — existing callers don't pass it, get `'OK'` instead of the hardcoded `'Delete'` on native, which is actually a strict improvement for non-destructive confirms). Adjust the docstring to reflect the new shape. Then staff code imports from `../../../utils/confirmAction` instead of `'../lib/confirmAction'`. |
| `imr-staff/src/lib/notifyBackendError.ts` | KEEP as a staff-internal helper. imr-inventory has a same-named local helper inside `src/store/useStore.ts` ([line 27](src/store/useStore.ts)) but it's NOT exported. Staff continues to use its own copy at `src/screens/staff/lib/notifyBackendError.ts`. The two implementations differ in tone (staff's truncates message at 120 chars; admin's uses full message with 5000ms visibility). DO NOT unify — the staff variant suits its UI; the admin variant suits its UI. |

### 4. Dependency reconciliation

Survey both `package.json`s:

| Dep | imr-inventory version | imr-staff version | Action |
|-----|----------------------|-------------------|--------|
| `@react-native-async-storage/async-storage` | `2.2.0` | `2.2.0` | EXACT MATCH — no change |
| `@react-native-community/netinfo` | NOT INSTALLED | `^11.0.0` | ADD `"^11.0.0"` |
| `react-native-toast-message` | `^2.2.1` | `^2.2.0` | imr-inventory is newer; keep `^2.2.1` |
| `@react-navigation/native` | `^6.1.17` | `^6.1.17` | EXACT MATCH |
| `@react-navigation/stack` | `^6.3.29` | `^6.3.29` | EXACT MATCH |
| `@supabase/supabase-js` | `^2.101.1` | `^2.101.1` | EXACT MATCH |
| `expo` | `^54.0.0` | `^54.0.0` | EXACT MATCH |
| `expo-status-bar` | `~3.0.9` | `~3.0.9` | EXACT MATCH |
| `react` / `react-dom` / `react-native` / `react-native-web` | all match | all match | no change |
| `react-native-gesture-handler` | `~2.28.0` | `~2.28.0` | EXACT MATCH |
| `react-native-safe-area-context` | `~5.6.0` | `~5.6.0` | EXACT MATCH |
| `react-native-screens` | `~4.16.0` | `~4.16.0` | EXACT MATCH |
| `zustand` | `^4.5.4` | `^4.5.4` | EXACT MATCH |

**Final delta:**
- ADD ONE: `@react-native-community/netinfo` at `^11.0.0` to
  `dependencies` in [package.json](package.json).
- Add `'@react-native-community/netinfo'` to the
  `RN_TRANSPILE_DEPS` array in
  [jest.config.js:13-39](jest.config.js) so jest can resolve it in
  the `useConnectionStatus.test.ts` file under
  `src/screens/staff/hooks/`.

No version downgrades. No version conflicts.

### 5. jest.setup.js merge plan

imr-staff's `jest.setup.js` has 8 mock blocks. Cross-check against
imr-inventory's [tests/jest.setup.ts](tests/jest.setup.ts) (currently
2 blocks):

| Mock | imr-staff | imr-inventory | Action |
|------|-----------|---------------|--------|
| `react-native-toast-message` | hand-rolled | hand-rolled | KEEP imr-inventory's — same shape, both export `{ show, hide }` + default. No change. |
| `@react-native-async-storage/async-storage` | hand-rolled stubs | uses official `@react-native-async-storage/async-storage/jest/async-storage-mock` | KEEP imr-inventory's — the official mock has real in-memory KV semantics; staff's hand-rolled returns null/undefined. The official mock is a STRICTLY STRONGER substitute. Verify staff's queue tests still pass with the official mock (they should — the queue tests `setItem` then `getItem` and assert the value round-trips, which the official mock supports). |
| `@react-native-community/netinfo` | hand-rolled stubs | NOT IN imr-inventory | ADD verbatim to `tests/jest.setup.ts`. Required for `useConnectionStatus.test.ts` native-branch tests. |
| `react-native-safe-area-context` | hand-rolled | NOT IN imr-inventory's global setup | ADD verbatim. Required by `EODCount` test mount (uses `SafeAreaView`). |
| `global.crypto.randomUUID` | deterministic counter | NOT IN imr-inventory's global setup | ADD verbatim — staff queue tests rely on stable UUIDs. RISK: if any imr-inventory test relies on real UUIDs (unlikely — they use mocked supabase responses, not real randomUUID calls), this would break it. Mitigation: scope the override into the staff test files only via per-file `jest.mock` if a regression surfaces. |
| `react-native/Libraries/Text/Text` mock | RN 0.81 compat patch | NOT IN imr-inventory's global setup | NEEDS VERIFICATION. imr-inventory is also on RN 0.81 and has 25+ component tests under `src/components/cmd/__tests__/`. Either (a) imr-inventory's component tests already work without this patch (jest-expo preset includes it) → DON'T add it (risk of double-patching), or (b) imr-inventory uses a different patch path. Developer: run the merged suite — if RN 0.81 mockComponent crashes surface on staff screen tests, ADD this block; otherwise skip. The fact that imr-inventory's existing tests pass under RN 0.81 strongly suggests jest-expo's mock paths are sufficient and the staff-specific patches are unnecessary post-merge. |
| `react-native/Libraries/Components/View/View` mock | same | same as above | same |
| `react-native/Libraries/Components/TextInput/TextInput` mock | same | same | same |
| `react-native/Libraries/Components/ActivityIndicator/ActivityIndicator` mock | same | same | same |
| `react-native/Libraries/Lists/FlatList` mock | same | same | same |
| `react-native/Libraries/Components/Pressable/Pressable` mock | same | same | same |

Final action on jest.setup.js:

- ADD to [tests/jest.setup.ts](tests/jest.setup.ts): netinfo mock,
  safe-area-context mock, deterministic randomUUID counter.
- TEST: run `npm test` after the additions but BEFORE adding the
  RN 0.81 component mocks. If staff screen tests fail with the known
  RN 0.81 mockComponent error, add the 6 component mocks at the
  bottom of `tests/jest.setup.ts` (verbatim from imr-staff's
  jest.setup.js). If they pass, don't add them.

### 6. Top-level [App.tsx](App.tsx) changes

Current App.tsx mounts `<CmdNavigator />` directly inside
SafeAreaProvider. Post-merge it mounts `<RoleRouter />`.

NEW LOGIC INTRODUCED:

1. ADD: queue hydration call from
   `src/screens/staff/lib/eodQueue.ts` (`hydrateQueue` +
   `migrateQueueIfNeeded`). Calls happen unconditionally on mount —
   the queue helpers tolerate "no signed-in user" gracefully (they
   return `[]` if storage is empty). The `useStaffStore.hydrateQueueFromStorage`
   gets the result and seeds the in-memory mirror.

2. ADD: an `<ErrorBoundary>` wrapper from
   `src/screens/staff/components/ErrorBoundary.tsx`. Or — verify
   whether the existing admin app has its own error boundary. From the
   read, the admin App.tsx has NO error boundary; mounting the staff
   one at the top wraps both admin and staff trees. Risk: admin errors
   that previously crashed visibly (red screen during dev) now hit the
   staff error boundary's "Your counts are saved. Please restart the
   app." message — which is staff-specific copy that confuses admins.
   RESOLUTION: Mount the ErrorBoundary INSIDE the staff branch only
   (StaffStack wraps its content in ErrorBoundary), not at the root.

3. CHANGE: replace `<CmdNavigator />` with `<RoleRouter />`.

4. KEEP: all existing logic — font loading, dev-session restore, locale
   hydration, dark-mode hydration, register-service-worker — unchanged.

Pseudocode for App.tsx (developer writes the actual code):

```
App() {
  // ... existing useFonts, useLayoutEffect, all current useEffects ...

  // NEW: hydrate the staff queue on mount (best-effort; no-op for
  // admins whose AsyncStorage is empty).
  useEffect(() => {
    (async () => {
      try {
        await migrateQueueIfNeeded();
        const items = await hydrateQueue();
        useStaffStore.getState().hydrateQueueFromStorage(items);
      } catch (err) {
        notifyBackendError('staff queue hydrate', err);
      }
    })();
  }, []);

  return (
    <GestureHandlerRootView ...>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <RoleRouter />                                  {/* was <CmdNavigator /> */}
        <Toast />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

### 7. `src/navigation/RoleRouter.tsx` skeleton

NEW FILE. Responsibilities:

1. Mount a SINGLE `<NavigationContainer>` with `linking` config (per Q3).
2. Read auth state (`useStore.currentUser`) + staff auth state
   (`useStaffStore.authState`).
3. Determine the active branch:
   - No admin session AND no staff session → render shared SignIn
     (a top-level stack with `Login` + `Register` + nothing else).
   - Admin session (currentUser !== null) → render admin's
     `CmdNavigator` content (which currently owns its own
     NavigationContainer — needs to be REFACTORED to render an inner
     stack only; see below).
   - Staff session (`authState.kind === 'signed-in'`) → render
     `StaffStack` (inner stack only).
4. Cold-start: on first mount, run `restoreSession()` (existing logic
   in StaffStack — see §6 below) AND read the admin session from
   supabase. Both run in parallel; whichever resolves first determines
   the initial branch.

Pseudocode shape:

```
RoleRouter() {
  const currentUser = useStore((s) => s.currentUser);
  const staffAuthState = useStaffStore((s) => s.authState);

  // Decide which inner stack to mount.
  // Priority: admin session > staff session > sign-in.
  let inner: ReactElement;
  if (currentUser) {
    inner = <AdminStack />;                    // refactored from CmdNavigator's AuthedRoot
  } else if (staffAuthState.kind === 'signed-in') {
    inner = <StaffStack />;
  } else if (staffAuthState.kind === 'restoring' || staffAuthState.kind === 'gating' || ...) {
    inner = <Splash />;                         // ported from imr-staff/RootStack
  } else {
    inner = <SignInStack />;                    // Login + Register
  }

  return (
    <NavigationContainer linking={linkingConfig}>
      {inner}
    </NavigationContainer>
  );
}
```

REFACTORING REQUIRED in [src/navigation/CmdNavigator.tsx](src/navigation/CmdNavigator.tsx):
the current default export mounts its OWN `<NavigationContainer>`. With
RoleRouter owning the container, CmdNavigator needs to expose its
inner stack as a separate component (call it `AdminStack`) that
RoleRouter can render INSIDE the shared container. The
`NavigationContainer` + `navRef` + `<RootStack.Navigator>` mount stays
inside CmdNavigator's existing export only when CmdNavigator is run
standalone (e.g. if the merge is rolled back); under RoleRouter, the
internal stack is what gets mounted.

Concretely:
- Export `AdminStack` from `src/navigation/CmdNavigator.tsx` (the
  `<RootStack.Navigator>` body, with the `currentUser` ternary for
  Login/Register vs App).
- Export `AdminAuthedRoot` (the existing `AuthedRoot` function) and
  the `ShellStack` as the inner shell.
- Adjust the default export to be a thin standalone wrapper that
  mounts a `<NavigationContainer>` around `<AdminStack>` — keeps
  backwards compatibility if any test or dev tool imports the default
  export expecting a self-contained navigator.

This is a refactor, NOT a rewrite. The render tree is identical;
only the container ownership moves up one level.

### 8. The shared SignIn portal

Read of [src/screens/LoginScreen.tsx](src/screens/LoginScreen.tsx)
shows the existing admin sign-in is appropriate to become the shared
portal:

- It calls `signIn(email, password)` from
  [src/lib/auth.ts](src/lib/auth.ts), which returns a `User` (the
  admin shape). On success it calls `useStore.login(user)`.
- It does NOT currently call `checkAuthGate`.

For shared use, the LoginScreen needs ONE addition: after the
`signIn` resolves successfully, BEFORE calling `useStore.login(user)`,
check the user's role. If role is `'user'`, route the signed-in
session through `checkAuthGate` (staff path), seed
`useStaffStore.authState` with the result, and DO NOT call
`useStore.login`. If role is anything else (admin/master/super_admin),
call `useStore.login(user)` as today.

Pseudocode addition to the `handleLogin` function:

```
const result = await signIn(email.trim(), password);
if (result.error) {
  setError(result.error);
  return;
}
if (!result.user) return;

// Branch on role.
if (result.user.role === 'user') {
  // Staff path — run the auth gate (role + user_stores) and seed
  // the staff store. The shared `checkAuthGate` lives at
  // src/lib/authGate.ts.
  const gate = await checkAuthGate(result.user.id, {
    notStaff: tStaff('auth.error.notStaff'),         // imports from staff i18n
    noStores: tStaff('auth.error.noStores'),
    generic: tStaff('auth.error.generic'),
  });
  if (!gate.ok) {
    Toast.show({ type: 'error', text1: gate.message, position: 'bottom' });
    return;  // gate already signed user out for hard failures
  }
  // Restore active store from prior session.
  const persisted = await readActiveStoreId();
  const matched = persisted ? gate.stores.find((s) => s.storeId === persisted) : null;
  if (matched) {
    useStaffStore.getState().setActiveStore({ id: matched.storeId, name: matched.storeName });
  } else if (gate.stores.length === 1) {
    const only = gate.stores[0];
    useStaffStore.getState().setActiveStore({ id: only.storeId, name: only.storeName });
  } else {
    await writeActiveStoreId(null);
    useStaffStore.getState().setActiveStore(null);
  }
  useStaffStore.getState().setAuthState({
    kind: 'signed-in',
    userId: result.user.id,
    stores: gate.stores,
  });
  return;
}
// Admin path — existing behaviour.
login(result.user);
```

CRITICAL — the i18n import for the gate failure messages uses the
STAFF catalog (via `t` from `src/screens/staff/i18n/index.ts`) because
the gate-failure messages ("This app is for staff only", "No store
assignments…") are staff-specific copy that should not leak into
admin's i18n catalog. Alias the staff `t` to `tStaff` in the import to
make this explicit at the call site.

The shared portal's URL is `/login`. Both admin and staff users
arrive there. The portal does NOT change its UI based on the email
typed — the same form, same demo accounts (only in `__DEV__`), same
"Register here" link. The branching happens AFTER the supabase auth
call resolves and the user's role is known.

The staff `src/screens/staff/screens/SignIn.tsx` ports nothing — it's
DELETED. The auth-gate logic ports to `src/lib/authGate.ts` (top-level,
shared); the shared portal in `src/screens/LoginScreen.tsx` invokes it.

Cold-start session restore (a session in localStorage from a prior
sign-in) currently runs in App.tsx for admin via `getSession()`. The
staff cold-start logic from `imr-staff/src/navigation/RootStack.tsx`
needs to fold in: if `getSession()` returns a user with role `'user'`,
run the gate + seed the staff store; else run the existing admin path.
The clean place for this is App.tsx's existing
`useEffect(() => { (async () => { ... await getSession(); ... }) })`.
Branch on `result.user.role` the same way the LoginScreen does.

### 9. CLAUDE.md updates

LINES TO CHANGE in [CLAUDE.md](CLAUDE.md):

- **Remove (project description section):** the line "Sibling apps
  (staff app, customer PWA) live elsewhere; this repo only contains
  the admin surface." Replace with: "Admin + staff app for the 2AM
  PROJECT restaurant brand — inventory, recipes, sales, brand-catalog
  management for managers AND end-of-day count entry for staff.
  Customer PWA remains a sibling app and will fold in via a future
  spec."

- **Add (project structure block):** add `src/screens/staff/` as a
  peer to `src/screens/cmd/sections/`:

```
  src/
    navigation/                 # CmdNavigator (desktop shell), RoleRouter (role gate)
    screens/
      cmd/sections/             # Desktop Cmd UI sections (admin Cmd UI)
      staff/                    # Staff EOD count app — peer to cmd/
        components/             #   staff-local Button, Input, Banner, etc.
        hooks/                  #   useConnectionStatus, useEodSubmit
        i18n/                   #   staff-only catalog (auth, eod, chrome, store)
        lib/                    #   eodQueue, types, notifyBackendError, uuid
        navigation/             #   StaffStack (inner)
        screens/                #   EODCount, StorePicker
        store/                  #   useStaffStore (Zustand, slice-isolated)
        theme.ts                #   staff-local light-only theme
    store/                      # Admin Zustand store (useStore.ts)
    lib/                        # db.ts, authGate.ts, supabase.ts, ...
```

- **Add (conventions block):** new bullet under "Conventions already
  in use":

```
- **Role-routed shell.** App.tsx mounts RoleRouter ([src/navigation/RoleRouter.tsx](src/navigation/RoleRouter.tsx)),
  which reads `profiles.role` and dispatches to one of two inner
  navigators: admin's Cmd UI (CmdNavigator's AdminStack) for
  admin/master/super_admin, staff's StaffStack
  ([src/screens/staff/navigation/StaffStack.tsx](src/screens/staff/navigation/StaffStack.tsx))
  for `'user'`. The shared sign-in portal at
  [src/screens/LoginScreen.tsx](src/screens/LoginScreen.tsx)
  invokes `checkAuthGate` from [src/lib/authGate.ts](src/lib/authGate.ts)
  when the signed-in user's role is `'user'`, seeding `useStaffStore`
  before dispatch. Staff code never imports `useStore`; admin code
  never imports `useStaffStore`.
```

- **Update (placeholder behavior):**

```
- [src/hooks/useRole.ts](src/hooks/useRole.ts) hardcodes 'admin' — by
  design. Role gating in the merged app happens at the RoleRouter
  level (reads `profiles.role` via `currentUser`), not via this hook.
  The hook is preserved for backward-compatibility with admin Cmd UI
  call sites that gate on `useRole()`-returns-`'admin'`. Slated for
  removal once every consumer migrates off it. The newer
  `useIsSuperAdmin()` and `useIsMaster()` hooks ARE the source of
  truth for super-admin / master gating in admin paths.
```

- **Update (Identity drift section):** no changes — the `app.json`
  slug stays `towson-inventory`.

### 10. Vercel deployment confirmation

[vercel.json](vercel.json) has a single SPA rewrite that maps every
non-asset request to `index.html`. This is the right behaviour both
PRE and POST merge. React Navigation 6 web `linking` reads
`window.location.pathname` after the rewrite has served `index.html`
and the SPA has booted. Vercel does NOT need a per-route rewrite for
`/staff/*` — the rewrite is wildcard, and any path that ends without a
file extension hits `index.html` regardless.

NO CHANGES TO vercel.json. Confirmed.

Service worker scope (`Service-Worker-Allowed: /`) is unchanged; same
SW serves both `/` and `/staff/*`.

### 11. Test plan post-merge

imr-inventory has ~259 tests (per spec). imr-staff has 9 test FILES
covering ~50 tests by my count (eodQueue, useStore, StorePicker,
SignIn, useConnectionStatus, RootStack, useEodSubmit, EODCount, i18n).
Post-merge expected total: ~310-330 tests.

**Most likely failure points (developer should expect):**

1. **`SignIn.test.tsx` from imr-staff is DELETED** along with the
   screen file. -1 test file. NEW coverage: extend
   `src/screens/LoginScreen.test.tsx` (if it exists; otherwise create
   it) to cover the role-branch path — admin login passes through to
   `useStore.login`; user-role login passes through to `checkAuthGate`
   + `useStaffStore.setAuthState`. The byte-for-byte error toast
   strings from spec 062 (`auth.error.notStaff`, `auth.error.noStores`,
   `auth.error.generic`) MUST remain unchanged — pin them via test.

2. **`RootStack.test.tsx` (now `StaffStack.test.tsx`) restoreSession
   tests.** This test exercises the cold-start gate flow. In the
   merged app, cold-start runs in App.tsx (not StaffStack). Two
   options: (a) keep the test where the logic lives (move the
   restoreSession test to a new App.test.tsx if cold-start logic
   lives there), or (b) leave restoreSession in StaffStack as a
   re-entry point and keep the test. RESOLUTION: (b) — re-export
   `restoreSession` from `src/lib/authGate.ts` (or a thin wrapper at
   `src/lib/sessionRestore.ts`) so the call site in App.tsx imports
   the same function the test imports. The test stays at the helper's
   colocated `.test.ts` file.

3. **i18n catalog parity test
   ([src/screens/staff/i18n/i18n.test.ts](src/screens/staff/i18n/i18n.test.ts))**
   runs against the STAFF catalog only — passes unchanged. Admin's
   catalog parity test
   ([src/i18n/i18n.test.ts](src/i18n/i18n.test.ts))
   runs against the ADMIN catalog only — passes unchanged. There's no
   cross-catalog assertion.

4. **`useStore` tests** (admin's existing) — pass unchanged; no admin
   store code is touched.

5. **`useStaffStore.test.ts`** (renamed from `useStore.test.ts` in
   imr-staff) — the test file imports the store as `useStore`. Update
   the import to `useStaffStore`. Each test that does
   `useStore.setState(...)` or `useStore.getState()` becomes
   `useStaffStore.setState(...)` / `useStaffStore.getState()`.
   Mechanical rename, ~20-30 sites in the test file.

6. **Component imports** inside staff tests — any test that imports
   from `'../store/useStore'` rewrites to `'./store/useStaffStore'`
   relative to its new path under `src/screens/staff/`. Same with
   `'../lib/supabase'` (now imports from admin's
   `'../../../lib/supabase'`).

7. **The `useEodSubmit` manual mock at
   `src/screens/staff/__mocks__/useEodSubmit.ts`** — jest's
   auto-mocking convention REQUIRES the mock to sit at
   `<dirname>/__mocks__/<basename>.ts` adjacent to the source module.
   The source module is at `src/screens/staff/hooks/useEodSubmit.ts`,
   so the mock must move to `src/screens/staff/hooks/__mocks__/useEodSubmit.ts`
   (not `src/screens/staff/__mocks__/`). VERIFY: read the consumer
   tests' `jest.mock('../hooks/useEodSubmit')` lines — if they're
   relative to a screen file under `src/screens/staff/screens/`, the
   relative path is `../hooks/useEodSubmit`, and the mock should sit
   at `src/screens/staff/hooks/__mocks__/useEodSubmit.ts`. The merge
   should move it accordingly.

**Test-run sanity check before declaring victory:**

```
npm test -- --listTests | wc -l   # should show ~30+ files
npm test                          # all green, ~310-330 individual tests
npm run typecheck                 # zero errors — adjust tsconfig if RoleRouter imports cross
npm run typecheck:test            # zero errors in test typecheck
```

### 12. Browser smoke recipe (main Claude post-build)

Run from imr-inventory repo root with the local stack up
(`npm run dev:db`).

```
1. Start the local web dev server:
   npx expo start --web
   (or: open https://imr-inventory.vercel.app/ for the deployed build)

2. Confirm Vercel build is current (CI ran clean post-merge).

3. Admin path:
   a. Open browser → `/` (root URL)
   b. Sign in as admin@local.test / password
   c. Expect: Cmd UI Inventory section, sidebar with all admin groups
   d. Click DBInspector in the sidebar → URL becomes `/db-inspector`
      (if linking is enabled per Q3; else still works via internal nav)
   e. Sign out → returns to `/login`

4. Staff path:
   a. From `/login`, sign in as manager@local.test (or whichever local
      seed has role='user' and >=1 user_stores row — check
      supabase/seed.sql for the canonical staff demo user). If the
      seed lacks a role='user' demo, the developer creates one inline
      for the smoke and surfaces as a follow-up to add to seed.sql.
   b. Expect: staff URL becomes `/staff` (or `/staff/store-picker` /
      `/staff/eod`)
   c. With ONE user_stores row → land directly on EODCount
   d. With >1 user_stores rows → land on StorePicker; tap a store →
      EODCount
   e. Header shows store name + today's date
   f. Enter a count in any vendor's items → tap Submit → success toast
   g. URL stays under `/staff/*` throughout
   h. Tap "sign out" in the header → returns to `/login`

5. Cross-surface regression:
   a. Sign in as admin → land in Cmd UI ✓
   b. Manually navigate to `/staff` in the URL bar
   c. Expect: RoleRouter sees admin role + not 'user' role; redirect
      back to `/` (the admin home). NOT a 404, NOT a blank page.
   d. (Optional polish for follow-up: a header "switch surface"
      affordance for users with both grants — per Track B AC.)

6. Shell-smoke continuity:
   bash scripts/smoke-staff-eod.sh
   Should pass unchanged (RPC contract is unchanged).
```

If step 4f returns a 403 "forbidden", the gate is denying the staff
user — check that `manager@local.test` actually has `profiles.role =
'user'` and >=1 row in `user_stores`. If still failing, the gate
plumbing in RoleRouter / LoginScreen is wrong; back to dev.

### 13. New risks discovered

(See risks already enumerated in the spec under "Risk + mitigation" —
those still apply. Below are NEW risks surfaced during design.)

**R1: `useRole.ts` hardcodes `'admin'`.** Currently a no-op for the
admin app (every user IS admin within imr-inventory). Post-merge,
staff users (role='user') still hit `useRole()` if they navigate
into admin Cmd UI somehow (they shouldn't, but the hook would lie).
MITIGATION: keep `useRole` exactly as is — the merge does not route
staff users into Cmd UI under any normal flow. Defer the hook's
removal to a future cleanup spec. SURFACE: future spec must update
this hook to read live role.

**R2: bundle size.** Staff phones currently download a ~150 KB
imr-staff bundle. Post-merge they download the full imr-inventory
bundle (Cmd UI + admin code) on top — likely 1-2 MB. ACCEPTED per
the spec's "Out of scope" section ("Bundle splitting deferred to a
follow-up spec"). FOLLOW-UP: when wired through Metro/Expo Router,
split routes so staff phones lazy-load only the staff chunk.

**R3: existing admin sign-in screen logic.** The
[LoginScreen.tsx](src/screens/LoginScreen.tsx) already has a
`__DEV__`-gated demo-accounts panel that quick-logs any seed user.
The seed includes `admin` role only (from a quick read of
`USERS` import at LoginScreen.tsx:12). Post-merge, this demo panel
needs to handle role='user' demos too — but the panel uses the
LOCAL `seed.ts` `USERS` array, not the Supabase backend. The Supabase
seed has the real role='user' users (per spec 061's seed.sql); the
demo panel's quickLogin path bypasses Supabase entirely. RESOLUTION:
do NOT touch the demo panel in this spec. Real local sign-in
(`admin@local.test` + supabase) flows through the new branching
logic; demo quick-login stays unchanged and skips the gate (it's a
dev convenience only). Surface as a follow-up for the local seed.

**R4: cold-start race between admin getSession and staff
restoreSession.** App.tsx now needs to fire BOTH session restores in
parallel: admin's `getSession()` (which calls
`useStore.login(result.user)`) AND the staff branch (which calls
`checkAuthGate` + `useStaffStore.setAuthState`). These cannot both
run unconditionally — if a user is `role='admin'`, only the admin
restore should fire; if `role='user'`, only the staff restore.
RESOLUTION: a single `getSession()` call returns the user's role
(from the joined profiles row in `src/lib/auth.ts:getSession`).
Branch on role AFTER getSession resolves:

```
const result = await getSession();
if (result.user) {
  if (result.user.role === 'user') {
    // Staff cold-start path — fold imr-staff/RootStack.restoreSession here.
    const gate = await checkAuthGate(result.user.id, {...});
    if (gate.ok) {
      // ... seed activeStore, setAuthState({ kind: 'signed-in', ... })
    } else {
      useStaffStore.getState().setAuthState({ kind: 'signed-out' });
      Toast.show({ ... });
    }
  } else {
    // Admin cold-start path — existing logic.
    hydrateBrand(result.brand ?? null);
    login(result.user);
    // ... existing dark mode / locale / sidebar hydration
  }
}
```

This is the SAFEST topology: single getSession call, single branch.
The hydrations that are admin-only (dark mode, locale, brand,
sidebar layout) stay in the admin branch. Hydrations that are
staff-only (queue mirror) run unconditionally (the queue is
local-storage-scoped and tolerates no-staff-user).

**R5: `signIn` from `src/lib/auth.ts` returns a `User` type that
already INCLUDES role.** Verified at
[src/lib/auth.ts](src/lib/auth.ts) — the AuthResult has `user.role`.
So the LoginScreen's role-branch can fire WITHOUT a separate role
lookup — `result.user.role === 'user'` is enough to fork. No extra
DB roundtrip needed on the role decision; only the gate (user_stores
fetch) needs a fetch.

**R6: `confirmAction` 4th argument extension.** Detailed in §3b
above. The change is backwards-compatible (default 'OK') but DOES
change the on-screen confirm button label from "Delete" to "OK" for
any existing admin caller. Quick grep: admin uses
`confirmAction(...)` in ~5-10 places. RECOMMENDATION: explicitly pass
`'Delete'` as the 4th arg from each existing admin call site (a
mechanical update) so no behavioural drift. Then the new default
`'OK'` only applies to staff calls. SURFACE: the developer should
grep `src/screens/cmd/` and `src/components/cmd/` for
`confirmAction(` and add the explicit `'Delete'` arg to each
destructive call. Non-destructive admin confirms can stay with the
new default `'OK'`.

**R7: `getSession` already attempts to derive `brand` for
super-admin profile** — that branch only runs when role is
`'super_admin'`. Adding role='user' branch is additive; no existing
logic regresses.

**R8: `useStaffStore.test.ts` rewrites Zustand state via
`useStore.setState`.** imr-staff's test does
`useStore.setState({ authState: {...} })` directly. Post-rename,
this becomes `useStaffStore.setState({ authState: {...} })`. If any
test forgets to update, jest will throw `ReferenceError: useStore is
not defined` — easy to catch in test-run.

**R9: There is currently no admin DB-Inspector test that exercises
the `staff_submit_eod` RPC** — the shell-smoke covers it. Post-merge
this stays true; no new test needed.

### Summary

This is a FRONTEND-ONLY merge. The design above resolves all 7 open
questions, lists every file move + rename + delete, reconciles
dependencies (one net addition: `@react-native-community/netinfo`),
reconciles jest.setup.js (3 mocks added, 6 component mocks
conditionally added), specifies the role-routed shell topology
(RoleRouter at the top, CmdNavigator's stack refactored to fit
inside, StaffStack as the inner staff branch), and identifies the
shared sign-in portal logic. The auth-gate logic from spec 062 ports
verbatim to `src/lib/authGate.ts`. No backend changes.

The risk surface is concentrated in five places: jest config merge,
RoleRouter container ownership refactor of CmdNavigator, shared
LoginScreen role-branch addition, cold-start `getSession()` branch
in App.tsx, and the `confirmAction` 4th-arg extension. Each is
small, mechanical, and individually verifiable.

## Files changed

### Git history
- `bbc741d` — `Squashed 'src/screens/staff/' content from commit 5072c56` (the imr-staff main HEAD)
- `6ca5148` — `Merge commit 'bbc741dca80d906fd3da1d8c734f77075f494d7b' as 'src/screens/staff'` (subtree merge commit)
- This commit (next) — admin-side wiring + scaffold cleanup + renames + jest merge + CLAUDE.md updates + fix-pass nits

### New files (top-level, beyond the subtree)
- `src/lib/authGate.ts` (hoisted from `src/screens/staff/src/lib/authGate.ts` — see Renames)
- `src/lib/sessionRestore.ts` + `src/lib/sessionRestore.test.ts` (cold-start session probe; covers AC1.5 from spec 062's gate-failure test)
- `src/navigation/RoleRouter.tsx` (the top-level role-routed shell)

### Modified (admin-side)
- `App.tsx` — replaces `<CmdNavigator />` with `<RoleRouter />`, adds queue hydration, adds role-branch in the existing `getSession()` useEffect
- `src/navigation/CmdNavigator.tsx` — `AdminStack` exported separately; `<NavigationContainer>` moves up to RoleRouter
- `src/screens/LoginScreen.tsx` — role-branch after `signInWithPassword` resolves; calls `checkAuthGate` + seeds `useStaffStore` for staff users
- `src/utils/confirmAction.ts` — adds optional `confirmLabel = 'OK'` 4th arg
- 8 admin Section files pass explicit `'Delete'` to destructive `confirmAction(...)` calls — `BrandsSection.tsx`, `CategoriesSection.tsx`, `InventoryCatalogMode.tsx`, `POSImportsSection.tsx`, `PrepRecipesSection.tsx`, `RecipeCategoriesSection.tsx`, `RecipesSection.tsx`, `VendorsSection.tsx`, plus `InventoryDesktopLayout.tsx`
- `jest.config.js` — adds `@react-native-community/netinfo` to `RN_TRANSPILE_DEPS`
- `tests/jest.setup.ts` — adds netinfo + safe-area-context + deterministic randomUUID mocks (6 RN 0.81 component mocks from imr-staff intentionally NOT merged — 316 tests pass without them per architect §5 guidance)
- `package.json` — `@react-native-community/netinfo: ^11.0.0` added
- `CLAUDE.md` — role-routed-shell bullet replaces the "CmdNavigator unconditionally" line; `useRole.ts` semantics updated; `db.ts centralization` bullet adds `authGate.ts` / `sessionRestore.ts` / `src/screens/staff/*` as documented carve-outs (spec 063 fix-pass)

### Subtree (imported under `src/screens/staff/`)
~30 files: `components/{Banner,Button,ErrorBoundary,Input,ListRow,QueueIndicator}.tsx`, `hooks/{useConnectionStatus,useEodSubmit}.{ts,test.ts}`, `lib/{eodQueue,notifyBackendError,types,uuid}.ts` + `eodQueue.test.ts`, `navigation/StaffStack.tsx` (renamed from `RootStack.tsx`) + `StaffStack.test.tsx`, `screens/{EODCount,StorePicker}.{tsx,test.tsx}`, `store/useStaffStore.{ts,test.ts}` (renamed from `useStore.ts`), `theme.ts`, `i18n/{en.json,index.ts,i18n.test.ts}`. Subtree-internal `src/` layer flattened (e.g. `src/screens/staff/src/lib/` → `src/screens/staff/lib/`).

### Deleted (imr-staff scaffold, redundant with imr-inventory)
`App.tsx`, `package.json`, `package-lock.json`, `tsconfig.json`, `babel.config.js`, `metro.config.js`, `app.json`, `jest.setup.js`, `.gitignore`, `.env.local.example`, `.claude/launch.json`, `CLAUDE.md`, `src/lib/supabase.ts`, `src/lib/confirmAction.ts`, `src/screens/SignIn.{tsx,test.tsx}` (replaced by shared `LoginScreen`), `src/navigation/RootStack.test.tsx` (covered by `sessionRestore.test.ts` + `StaffStack.test.tsx`), plus the local `specs/062*` files (history preserved via subtree commit).

### Fix-pass items (this commit, post-review)
- `src/lib/authGate.ts` & `src/screens/staff/screens/EODCount.tsx` & `src/screens/staff/hooks/useEodSubmit.ts` retain their direct `supabase.from / supabase.rpc` calls per architect §3 "Move VERBATIM"; CLAUDE.md now documents these and the staff subtree as allowed carve-outs to the db.ts centralization rule (resolves code-reviewer's 3 Criticals as architectural carve-outs, not code defects)
- `BrandsSection.tsx:854` — `'Delete'` → `'Demote'` (was a misleading button label on the native demote action)
- `POSImportsSection.tsx:988` — `'Delete'` → `'Remove'` (semantic match to "Remove alias" dialog title)
- `src/screens/staff/screens/EODCount.{tsx,test.tsx}` + `StorePicker.test.tsx` — file-header path comments updated to match new merged location
- `src/screens/staff/README.md` — stale "scaffold directory" placeholder replaced with a merged-state description and contract references
- `src/screens/staff/hooks/useEodSubmit.test.ts` — added `Outcome | undefined` type annotation in 4 places (closes typecheck:test errors the FE-dev agent didn't reach after being killed mid-execution)
- CLAUDE.md stale lines (App.tsx mounts CmdNavigator + useRole "intentional because staff use a separate app") refreshed for the merged state
