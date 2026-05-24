# Architectural drift review — spec 063

Reviewer: backend-architect (post-implementation, design-vs-implementation drift)
Spec: 063-fold-imr-staff-into-imr-inventory.md
Date: 2026-05-24

Scope reminder: this spec is FE-only — no migrations, no edge functions, no RPC
contract changes, no RLS changes, no realtime publication changes. This review
checks drift against the 12-section design I produced. Code-quality findings
belong to the code-reviewer; missing test coverage belongs to the test-engineer.

Verdict at a glance: **SHIP_READY**. Zero contract breaks. All 8 risks
mitigated. Three minor doc drifts in `CLAUDE.md` (Should-fix, non-blocking).
The one FE-dev deviation main Claude flagged (`Outcome | undefined` typecheck
fix) is a sensible inline cleanup, anticipated implicitly by the design.

---

## Walk through the 12 design sections

### §1 — Open questions (Q1–Q7 resolutions)

✅ All seven resolutions landed as designed. Spot-checks:

- Q1 (squash subtree): the recent commits include `bbc741d` ("Squashed
  'src/screens/staff/' content from commit 5072c56") and `6ca5148` ("Merge
  commit 'bbc741dca80d906fd3da1d8c734f77075f494d7b' as 'src/screens/staff'") —
  exact shape the design predicted. Verified in `.git/logs/HEAD` line 398.
- Q2 (RoleRouter as new sibling, not extending CmdNavigator):
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/navigation/RoleRouter.tsx`
  exists; `CmdNavigator.tsx` exports `AdminStack` separately and keeps the
  standalone default export as rollback-safety.
- Q3 (linking): the FE-dev took the design's safe-out — RoleRouter renders
  the `NavigationContainer` WITHOUT a `linking` prop
  ([RoleRouter.tsx:60-64](src/navigation/RoleRouter.tsx)). Inline comment at
  lines 20-26 explains the choice and ties back to spec §3 / Q3. This was
  explicitly designed as the "ship without linking if it flickers" fallback —
  V1 routing topology works, deep links are deferred.
- Q4 (auth gate at top level): `src/lib/authGate.ts` exists with the verbatim
  port from spec 062. ✓
- Q5 (Zustand store rename): `useStaffStore`, `currentStaffUserId`,
  `selectStaffStores` all renamed
  ([useStaffStore.ts:74, 151, 160](src/screens/staff/store/useStaffStore.ts)). ✓
- Q6 (i18n two-catalog): `src/screens/staff/i18n/index.ts` ports verbatim;
  admin's `src/i18n/` is untouched. ✓
- Q7 (testID strategy): `signin-submit` testID survives at
  [LoginScreen.tsx:166](src/screens/LoginScreen.tsx); staff `sign-in-*`
  testIDs disappeared with the deleted SignIn.tsx. ✓

### §2 — Subtree command

✅ Verified the git log shape matches the design. Two commits (`bbc741d` +
`6ca5148`) as predicted. The subtree picked up everything at the
`src/screens/staff/` prefix; the scaffold deletions happened in a separate
commit per the design's two-step plan.

### §3 — File move + rename + DELETE list

✅ Spot-checked all 30 lines of the move table. Sample verified items:

- Components/hooks/i18n/lib paths flattened correctly — no `src/screens/staff/src/`
  layer survives. Verified via `Glob src/screens/staff/src/**` returning empty.
- `useStore.ts` → `useStaffStore.ts` ✓
- `RootStack.tsx` → `StaffStack.tsx` ✓
  ([StaffStack.tsx:57](src/screens/staff/navigation/StaffStack.tsx))
- `lib/authGate.ts` → top-level `src/lib/authGate.ts` ✓
- `useEodSubmit` manual mock moved to
  `src/screens/staff/hooks/__mocks__/useEodSubmit.ts` (adjacent to its source
  module) ✓ — design §11.7 caught this jest-auto-mock placement
- `restoreSession` re-exported from `StaffStack.tsx` via
  [StaffStack.tsx:44](src/screens/staff/navigation/StaffStack.tsx), with the
  canonical implementation at `src/lib/sessionRestore.ts` ✓ — design §11.2

### §3b — Scaffold deletions

✅ All 13 deletions verified absent via Glob:

- `App.tsx`, `package.json`, `tsconfig.json`, `babel.config.js`,
  `metro.config.js`, `app.json`, `jest.setup.js`, `.gitignore`, `CLAUDE.md`,
  `.env.local.example`, `.claude/launch.json` — all gone from
  `src/screens/staff/`.
- `src/lib/supabase.ts` (staff copy), `src/lib/confirmAction.ts` (staff copy),
  `SignIn.tsx`, `SignIn.test.tsx` — all gone.

⚠️ One minor: `src/screens/staff/README.md` survives with stale "scaffold
directory for the imr-staff app" placeholder content. The design said
"[reference only]" — code-reviewer flagged it. Should-fix (doc-only).

### §4 — confirmAction extension

✅ `src/utils/confirmAction.ts` now takes the optional `confirmLabel = 'OK'`
4th arg ([confirmAction.ts:13-29](src/utils/confirmAction.ts)). Spot-checked
all 9 admin destructive call sites — all pass an explicit `'Delete'`:

- InventoryDesktopLayout.tsx:352 ✓
- InventoryCatalogMode.tsx:539, 972 ✓
- POSImportsSection.tsx:988 ✓ (NOTE: code-reviewer flagged this should be
  `'Remove'` semantically, but that's a copy nit not a contract break)
- PrepRecipesSection.tsx:260 ✓
- CategoriesSection.tsx:240 ✓
- BrandsSection.tsx:854 ✓ (NOTE: code-reviewer flagged this should be
  `'Demote'`; that's their finding, valid Should-fix, doesn't affect the
  design's contract)
- RecipesSection.tsx:363 ✓
- RecipeCategoriesSection.tsx:270 ✓
- VendorsSection.tsx:313 ✓

The two non-destructive admin call sites (sidebar reset + sign-out in
`ResponsiveCmdShell.tsx:200, 244, 276`) intentionally use the new `'OK'`
default — matches design §3b ("Non-destructive admin confirms can stay with
the new default 'OK'").

Staff sign-out at [EODCount.tsx:281](src/screens/staff/screens/EODCount.tsx)
passes `t('chrome.signOut.label')` as designed.

### §5 — Dependency reconciliation

✅ Single dep added: `@react-native-community/netinfo: ^11.0.0` at
[package.json:31](package.json). No version conflicts elsewhere.
`@react-native-community` is already in `RN_TRANSPILE_DEPS` at
[jest.config.js:17](jest.config.js) — wildcard catches netinfo. ✓

### §5 — jest.setup.js merge

✅ The FE-dev followed the design's recommendation to skip the 6 RN 0.81
component mocks. `tests/jest.setup.ts` adds only the 3 new mocks:

- `@react-native-community/netinfo` ([jest.setup.ts:44-52](tests/jest.setup.ts))
- `react-native-safe-area-context` ([jest.setup.ts:56-66](tests/jest.setup.ts))
- Deterministic `crypto.randomUUID` ([jest.setup.ts:72-78](tests/jest.setup.ts))

316 tests pass without the RN 0.81 component mocks (per dispatching prompt).
jest-expo's mock paths are sufficient as the design predicted. ✓

Also verified the official `@react-native-async-storage/async-storage` jest
mock is kept (imr-staff's hand-rolled stubs discarded) — staff queue tests
still pass per the dispatching prompt's "316 tests pass" confirmation.

### §6 — App.tsx changes

✅ All four design items landed:

1. Queue hydration call ([App.tsx:199-205](App.tsx)) — runs unconditionally;
   admin paths get an empty mirror, staff paths get pending counts back.
2. ErrorBoundary mounted INSIDE StaffStack, NOT at root
   ([StaffStack.tsx:97](src/screens/staff/navigation/StaffStack.tsx)) — matches
   design's resolution that the staff fallback copy ("Your counts are saved")
   should not leak into admin surfaces.
3. `<CmdNavigator />` replaced with `<RoleRouter />`
   ([App.tsx:338](App.tsx)). ✓
4. Existing logic (fonts, dev-session restore, locale, dark-mode,
   service-worker) all preserved. ✓

R4 cold-start branch (single `getSession()` call branching on
`result.user.role === 'user'`) landed at
[App.tsx:217-261](App.tsx) — exactly the topology the design specified, with
Toast.show fired on `not-staff` / `no-stores` to preserve spec 062's critical
fix byte-for-byte.

### §7 — RoleRouter.tsx skeleton

✅ Created at `src/navigation/RoleRouter.tsx`. Single
`<NavigationContainer>` ([RoleRouter.tsx:61-64](src/navigation/RoleRouter.tsx)).
Three-way branch (currentUser → AdminStack; staffSignedIn → StaffStack; else
→ AdminStack which renders LoginScreen) matches the design pseudocode at
§7 line 730-754.

Linking config explicitly skipped (lines 20-26 explain why). This is the
"drop linking on first ship" path the design left open — V1 routing works
fine; deep links become a follow-up. ✓

### §7 — CmdNavigator refactor

✅ Named `AdminStack` export at
[CmdNavigator.tsx:151-165](src/navigation/CmdNavigator.tsx). Standalone
default export retained at lines 174-180 as rollback safety, exactly as the
design specified. The render tree is identical to pre-merge — only container
ownership moved up one level. ✓

(Code-reviewer noted the standalone export's `navRef` is now effectively
dead. That's true but the design explicitly preserved it for rollback;
out-of-scope for this review.)

### §8 — Shared LoginScreen role-branch

✅ [LoginScreen.tsx:69-104](src/screens/LoginScreen.tsx) — exact shape of the
design's pseudocode:

- Admin path unchanged (calls `useStore.login(user)` at line 107). ✓
- Staff path (`result.user.role === 'user'`): calls `checkAuthGate`, seeds
  `useStaffStore` (activeStore + authState). ✓
- Toast.show on gate failure ([LoginScreen.tsx:83](src/screens/LoginScreen.tsx))
  with the spec 062 byte-for-byte error strings (`tStaff('auth.error.notStaff')`
  etc.) — spec 062 critical-fix survived the merge. ✓
- `tStaff` alias on the import disambiguates the staff i18n catalog at the
  call site, as the design recommended. ✓

### §9 — CmdNavigator AdminStack export

✅ Done. `AdminStack` is a named export from
[CmdNavigator.tsx:151](src/navigation/CmdNavigator.tsx). RoleRouter imports it
at [RoleRouter.tsx:32](src/navigation/RoleRouter.tsx). The standalone default
export at lines 174-180 wraps `AdminStack` in its own `NavigationContainer`
for back-compat — matches the design's "thin standalone wrapper" guidance.

### §10 — Vercel deployment

✅ `vercel.json` unchanged from pre-merge. Single SPA rewrite at line 5 still
covers both `/` and `/staff/*`. ✓

### §11 — Test plan

✅ The expected test-file landscape post-merge matches:

- `SignIn.test.tsx` deleted with the screen ✓
- `RootStack.test.tsx` replaced by `src/lib/sessionRestore.test.ts` (the
  canonical helper lives at `src/lib/sessionRestore.ts` per design §11.2) ✓
- Staff i18n parity test at
  `src/screens/staff/i18n/i18n.test.ts` runs against the staff catalog only ✓
- `useStaffStore.test.ts` (renamed from `useStore.test.ts`) — imports updated
  to `useStaffStore` consistently ✓ (no `useStore` references inside any
  staff test file — verified via grep)
- `useEodSubmit` mock relocated to
  `src/screens/staff/hooks/__mocks__/useEodSubmit.ts` (adjacent to source) ✓

316 tests pass per the dispatching prompt — the design predicted ~310-330.
Within range. ✓

### §12 — Browser smoke

✅ Per dispatching prompt: live browser smoke confirmed admin + staff
role-routing works end-to-end at 1440x900. Routing topology matches the design.

### §13 — New risks (R1-R9)

All risks landed as the design anticipated:

- R1 (`useRole.ts` hardcodes `'admin'`) — preserved as is per design.
  CLAUDE.md update on this bullet drifted slightly (see CLAUDE.md drift below).
- R2 (bundle size) — accepted per spec out-of-scope.
- R3 (demo panel) — untouched per design.
- R4 (cold-start race) — single getSession branch landed at
  [App.tsx:217-261](App.tsx). ✓
- R5 (User type already includes role) — leveraged correctly. ✓
- R6 (confirmAction 4th arg) — 9 destructive admin call sites updated. ✓
- R7 (getSession super_admin brand branch) — additive, no regression. ✓
- R8 (useStaffStore test rewrites) — `useStore.setState` → `useStaffStore.setState`
  consistently across all staff tests. ✓
- R9 (no DB-Inspector test for staff_submit_eod) — still true post-merge, no
  new test needed. ✓

---

## Risk mitigation tracking (R1-R8 from §1 risks table)

| Risk | Mitigation status |
|------|-------------------|
| R1 dep version conflicts | ✅ netinfo at `^11.0.0` matches imr-staff's version; no other deltas |
| R2 jest config conflict | ✅ 316 tests pass without the RN 0.81 patches |
| R3 route name collision | ✅ RoleRouter namespaces; AdminStack vs StaffStack render in separate trees |
| R4 i18n key collision | ✅ Two-catalog approach — admin reads from `src/i18n/`, staff reads from `src/screens/staff/i18n/`; no shared key namespace |
| R5 Zustand collision | ✅ `useStaffStore` rename + `currentStaffUserId` + `selectStaffStores` renames |
| R6 subtree leftover scaffold | ✅ All 13 scaffold files deleted (one stale README remains as Should-fix, not contract drift) |
| R7 Vercel deploy | ✅ `vercel.json` untouched |
| R8 archive-before-verify | ✅ imr-staff GitHub repo NOT yet archived (correct sequencing — happens after release-coordinator approves) |

All 8 risks mitigated. ✓

---

## FE-dev deviations from design

### ✅ Sensible cleanup: `Outcome | undefined` annotations in
`src/screens/staff/hooks/useEodSubmit.test.ts`

Main Claude added the type annotations in 4 (actually 6) places to fix
TS-strict "used before assigned" errors. This is sensible:

- `let outcome: Outcome` declared without initial value violates TS strict
  mode (would flag "Variable used before being assigned").
- `Outcome | undefined` makes the uninitialized state explicit and forces
  callers to use optional chaining (`outcome?.kind`).
- The test file is the staff app's verbatim port — the original imr-staff
  TS config may have been less strict, allowing the previous shape to slip
  through.

The design explicitly said "the developer authors the actual code; no
committed `.ts` content as part of architect output" — this is exactly the
class of small, mechanical type fix the design left to the dev's discretion.
**Acceptable deviation; no architectural impact.**

### ⚠️ Doc drift: CLAUDE.md not fully updated per design §9

The design specified three bullets to update in CLAUDE.md. Two landed; one
drifted:

1. ✅ "What this is" (line 5) — updated to "Admin + staff app... Customer
   PWA remains a sibling app and will fold in via a future spec." Matches
   design exactly.
2. ✅ Project structure block (lines 33-58) — `src/screens/staff/` peer
   added with all sub-folders. Matches design.
3. ⚠️ **NOT DONE**: The design said to add a new bullet under "Conventions
   already in use" describing the **role-routed shell** (RoleRouter dispatches
   to AdminStack vs StaffStack based on `profiles.role`). This bullet is
   absent. Result: CLAUDE.md still implies CmdNavigator is mounted directly
   at [App.tsx](App.tsx) (line 62: "Cmd UI is the only client. App.tsx mounts
   CmdNavigator unconditionally") — stale post-merge.
4. ⚠️ **NOT DONE**: The design said to update the `useRole.ts` placeholder
   bullet (line 66) to say role gating now happens at RoleRouter via
   `profiles.role`. Current text still says "intentional because staff use a
   separate app" — stale post-merge.

These are CLAUDE.md doc drift, **Should-fix not Critical**. The agent-routing
layer reads CLAUDE.md for project context; stale text could mislead future
agents about where role gating happens.

### ⚠️ Doc drift: "Files changed" section of the spec never populated

The spec's bottom section ([line 1211-1213](specs/063-fold-imr-staff-into-imr-inventory.md))
still says "(To be filled in by the developer after implementation.)". The
FE-dev was killed mid-execution before completing this step. Should-fix; not
contract drift — the actual files-changed are visible via git status.

---

## Summary: 0 contract breaks, 3 Should-fix doc drifts

- Code matches design: §1-§8, §10, §11, §12, §13 (R1-R9) — all clean.
- §9 (CLAUDE.md updates) — partial; conventions bullet + useRole placeholder
  text were missed.
- Files changed section in spec body was never populated (FE-dev killed
  mid-step).

None of the 3 deviations break the architectural contract. The implementation
is structurally sound and matches the design's intent: a role-routed shell at
the top, a shared sign-in portal that branches on `profiles.role`, a staff
inner stack ported verbatim with ErrorBoundary scoped to staff only, no
admin-side disruption, no backend changes, no realtime impact.

The code-reviewer raised a Critical about staff code bypassing `src/lib/db.ts`.
That is a real CLAUDE.md convention violation, but it follows directly from
the design's "Move VERBATIM" instruction in §3 — the architect's call,
not a developer deviation. For the release-coordinator: either accept this
as a documented carve-out (add a CLAUDE.md bullet listing `authGate.ts`,
`sessionRestore.ts`, and the staff screens as allowed exceptions) or open a
follow-up to migrate those reads through `src/lib/db.ts`. Either is fine
post-ship.

**SHIP_READY** from an architectural drift standpoint.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 contract breaks, 3 Should-fix
  doc drifts (2 in CLAUDE.md, 1 in the spec's "Files changed" tail).
  Implementation matches the design's intent and all 8 risks are mitigated.
  SHIP_READY pending release-coordinator's synthesis with other reviewers.
payload_paths:
  - specs/063/reviews/backend-architect.md
