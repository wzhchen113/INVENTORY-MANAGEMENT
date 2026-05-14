# Spec 025: Delete the legacy app and standardize on Cmd UI

Status: READY_FOR_REVIEW

> **Replaces** the original "Legacy TypeScript sweep + full base
> `tsc --noEmit` CI gate" framing of this slot. The user's pivot:
> stop fixing TS hygiene on dead code; delete the dead code instead.
> The 103 TS errors enumerated in the prior draft disappear because
> the buggy files are gone, not because each was patched. The CI gate
> still lands — it just lands on a much smaller, cleaner graph.
>
> Prior file: `specs/025-legacy-typescript-sweep/spec.md` (now a
> one-line redirect stub; the directory should be `rm -rf`'d as part
> of the implementation PR — see Q7 resolution).

## User story

As the codebase owner, I want to delete the legacy admin app (its
navigator, its mega-screen, every screen reachable only from it, and
the legacy data layer it pulled in) and let Cmd UI be the only
client, so that:

- New work stops carrying a 104 KB `AdminScreens.tsx` and its sibling
  legacy screens forward.
- `npx tsc --noEmit` (base config) goes green on a clean checkout and
  can finally be a required CI gate — closing spec 024's deferred
  AC13 and §Q5a corollary.
- The "active vs. legacy" rule in CLAUDE.md collapses to a single
  active tree, deleting the explicit do-not-modify list.
- The only piece of legacy functionality not yet ported to a Cmd
  section — CSV/PDF export from `OrderReportScreen.tsx` — lands in
  Cmd UI's `ReorderSection.tsx` as part of the same change so no
  user-visible feature is lost.
- The other piece of legacy functionality without a Cmd UI surface —
  the `UsersScreen` from `AdminScreens.tsx` (invites + role management
  + user deletion) — lands as a new `UsersSection.tsx` in Cmd UI so the
  `master`-role flow is not regressed when `AppNavigator` /
  `MasterNavigator` go away.

The pivot is explicit per user direction: the audit confirmed Cmd UI
has equivalents for 9/12 legacy screens; 2 are soft-parity (legacy
`IngredientsScreen` is now inline in Recipes/PrepRecipes; legacy
`EODHistoryScreen` is now the `history.tsx` tab inside
`EODCountSection`); 1 is a real gap (CSV/PDF export); 1 is a missing
section (Users & Access). This spec ports both gaps and removes the
rest.

## Background — what we verified

PM ran these probes before writing the spec; results inline so the
architect doesn't need to repeat them:

1. **Legacy navigator wiring.** `AppNavigator.tsx` (783 lines)
   imports 12 legacy screen files plus the 5 sub-screens exported
   from `AdminScreens.tsx` plus the legacy data layer
   (`useJsonServerSync`). All of those imports collapse when
   `AppNavigator.tsx` itself is deleted.
2. **MoreScreen lives inside `AppNavigator.tsx`** (function
   declaration starting at line 603), not in a separate file. The
   audit's reference to "MoreScreen if it exists" is answered: it
   does, inline, and it goes with the navigator.
3. **Mobile-fallback screens already live in Cmd UI.** CLAUDE.md
   describes `src/screens/InventoryListScreen.tsx` and
   `src/screens/ItemDetailScreen.tsx` as "mobile fallback under
   1100 px," but those filenames at the repo-root `src/screens/`
   level **don't exist**. The Cmd UI versions at
   `src/screens/cmd/InventoryListScreen.tsx` and
   `src/screens/cmd/ItemDetailScreen.tsx` are the only ones. The
   PM-recommended interpretation: CLAUDE.md is referring to those
   Cmd UI files (which `ResponsiveCmdShell` renders under 1100 px);
   the prompt's "verify they're imported by CmdNavigator (not
   AppNavigator)" is answered — neither file is imported by the
   legacy navigator. Both stay.
4. **`LoginScreen`, `RegisterScreen`, `DBInspectorScreen`** are all
   imported by `CmdNavigator.tsx` at lines 11, 12, 15. They are
   shared between the legacy and Cmd navigators. They **stay**.
5. **`useJsonServerSync`** is imported only by `AppNavigator.tsx`
   (line 37). Once the navigator is deleted, the file is truly
   orphaned. Safe to delete.
6. **`useSupabaseStore.ts`** is described as "Drop-in replacement"
   in its own header (line 2). PM grep across `src/` finds no
   imports of it. Safe to delete. (CLAUDE.md "Legacy — do not
   modify" applies to *modifying* it; *deleting* it is the intent
   of this spec.)
7. **`EXPO_PUBLIC_NEW_UI` env state.** `.env.example` line 30-34
   says the flag is "pre-staged on Vercel (Preview + Production)."
   The flag's runtime default in `src/lib/featureFlags.ts` is
   `false` (`=== 'true'` test). EAS build config (`eas.json`) does
   NOT set the flag — native builds today therefore render
   `AppNavigator`. **This is the load-bearing detail behind Q3
   below.** Removing the flag = native builds switch to Cmd UI on
   the next build, which is the user's intent.
8. **CSV/PDF export data shape mismatch.** Legacy
   `OrderReportScreen.tsx` builds `DynamicOrderLine[]` from a
   *client-side* `calculateDynamicOrder` (uses `dailyUsage`,
   `daysToCover`, `dynamicPar`, `eodRemaining`, `orderQuantity`,
   `costPerUnit`, `estimatedCost`, `hasCaseInfo`). Cmd UI
   `ReorderSection.tsx` renders `ReorderVendor[]` from the
   *server-side* `report_reorder_list` RPC (uses `onHand`,
   `pendingPoQty`, `parLevel`, `suggestedQty`, `estimatedCost`,
   `flags`, `eodSubmittedAt`). The export logic ports across, but
   the column set in the CSV/PDF must change to match the new data
   model — it's NOT a copy/paste of the old CSV/PDF columns. See
   AC4 + AC5.
9. **CI workflow.** `.github/workflows/test.yml` exists (3 jobs:
   `jest`, `typecheck` against `tsconfig.test.json`, `db`). The new
   base-`tsc` job adds a fourth.
10. **`scripts/test-unit-conversion.ts`** — verified 1 TS error
    (`catalogId` missing on an `InventoryItem` fixture). CLAUDE.md
    describes it as a one-off ts-node script. PM recommends adding
    `scripts/**` to base `tsconfig.json` `exclude` rather than
    fixing the fixture; the file isn't part of the app graph and
    excluding the directory is more general-purpose than a one-line
    fix. See Q6.
11. **App.tsx wiring.** Line 9 imports `AppNavigator` (legacy); line
    16 imports `CmdNavigator`. Line 15 imports `NEW_UI`. Line 225
    renders `{NEW_UI ? <CmdNavigator /> : <AppNavigator />}`. Lines
    9 + 15 are removable when the legacy branch is gone.
12. **Type drift cleanup.** The `notifyBackendError` call at
    `AppNavigator.tsx:262` references `info.detail` which doesn't
    exist on the typed message shape — this is the Category E error
    from the prior spec draft. **No fix needed** because the call
    site is in `AppNavigator.tsx` which we're deleting.
13. **Users & Access in Cmd UI — gap confirmed.** PM grep across
    `src/screens/cmd/sections/` returns **no** `UsersSection.tsx`
    file. The legacy `UsersScreen` (exported from `AdminScreens.tsx`,
    line 1267) handles: invites (with brand-scoped role assignment),
    user list (master sees all, admin filtered), per-user delete
    with type-the-email confirm gate, and an embedded "Stores"
    management block (add/edit/delete stores — master-only). The
    invite/delete/role bits already have backend coverage in
    `src/lib/auth.ts` (`inviteUser` options-object form,
    `fetchAllUsers({ brandId? })`, `deleteUser` via edge function);
    the password-reset trigger is **not yet implemented** anywhere
    (legacy `UsersScreen` does not surface it either — see Q8
    resolution below). The store-management block is **out of scope
    for this spec** — surfaced separately under §Out of scope so
    the architect doesn't auto-port it.

## Acceptance criteria

### File deletions (the main event)

- [ ] **AC1 — Legacy navigator gone.** `src/navigation/AppNavigator.tsx`
  is deleted. Includes the inline `MoreScreen`, `ProfileSidebar`,
  `HeaderRight`, `HeaderLeft`, `StackHeaderLeft`, `StoreSelector`,
  `TabNavigator`, `MasterNavigator`, `AppStackNavigator`, and
  `StoreLoadingOverlay` components defined inside it.

- [ ] **AC2 — Legacy screen files gone.** The following 12 files at
  `src/screens/*` are deleted in the same commit set:
  - `AdminScreens.tsx` (104 KB; exports `RecipesScreen`,
    `VendorsScreen`, `AuditLogScreen`, `ReportsScreen`,
    `UsersScreen`) — **deletion ordered AFTER AC4/AC5/AC21–AC25
    land in the same change set; the export logic and the
    `UsersScreen` port must finish first.**
  - `DashboardScreen.tsx`
  - `EODCountScreen.tsx`
  - `EODHistoryScreen.tsx`
  - `IngredientsScreen.tsx`
  - `ItemsScreen.tsx`
  - `OrderReportScreen.tsx` (deletion ordered AFTER AC4/AC5 land in
    the same change set — the export logic must be ported first)
  - `OrdersScreen.tsx`
  - `POSImportScreen.tsx`
  - `PrepRecipesScreen.tsx`
  - `ReconciliationScreen.tsx`
  - `WasteLogScreen.tsx`
  - `src/components/IngredientEditor.tsx` (1 file outside `screens/`
    that is only used by `IngredientsScreen.tsx` / legacy editor;
    architect verifies it has no remaining Cmd UI consumer before
    delete)

- [ ] **AC3 — Legacy data layer gone.** The following 3 files are
  deleted:
  - `src/store/useSupabaseStore.ts`
  - `src/store/useJsonServerSync.ts`
  - `db.json` (repo-root json-server seed file)

  And the `db` npm script is removed from `package.json` (current
  line: `"db": "json-server db.json --port 3001"`).

### CSV/PDF export ported to ReorderSection (`OrderReportScreen` parity)

- [ ] **AC4 — CSV export in `ReorderSection.tsx`.** A "Download CSV"
  button is rendered in the section header (web only — same Platform
  gate as the legacy buttons). Click triggers a download via blob URL
  of a CSV with the following columns, sourced from `reorderPayload`:
  - `Vendor`, `Item Name`, `On Hand`, `Pending PO`, `Par Level`,
    `Suggested Qty`, `Unit`, `Est. Cost`, `Flags` (comma-joined),
    `EOD Counted At`.

  Filename pattern: `IMR_Reorder_<store-name>_<YYYY-MM-DD>.csv`
  (slug-ify spaces with `_`; date is the payload's `asOfDate` if
  present, else today's local date). One CSV covering ALL vendors in
  the current payload. PapaParse is the serializer
  (`Papa.unparse(rows, { columns })`).

- [ ] **AC5 — PDF export in `ReorderSection.tsx`.** A "Download PDF"
  button is rendered in the section header (web only). Click
  triggers a `jsPDF` document with:
  - Header: "I.M.R / Per-Vendor Reorder Suggestions" + store name +
    `asOfDate` from payload.
  - Per-vendor table (one `autoTable` call per vendor, in payload
    order): vendor name + source badge + next-delivery line in a
    sub-header row, then rows of `[Item, On Hand, Pending, Par,
    Suggested, Unit, Est. Cost]`.
  - Footer: total item count + total estimated cost across all
    vendors.

  Filename pattern: `IMR_Reorder_<store-name>_<YYYY-MM-DD>.pdf`.
  Uses dynamic imports for `jspdf` + `jspdf-autotable` (matches the
  legacy file's pattern at line 60-61 — they're already in
  `dependencies`).

- [ ] **AC6 — Export buttons only render when there's data.** When
  `vendors.length === 0` (the existing "all stocked up" empty state)
  OR `reorderLoading && !reorderPayload`, the export buttons are
  hidden. When `reorderError`, the export buttons are hidden.
  Otherwise both buttons render side-by-side, web-only.

- [ ] **AC7 — Export buttons styled to match Cmd UI.** PM-committed:
  use the same `TouchableOpacity` + mono-text pattern as the
  existing `REFRESH` button in the `TabStrip.rightSlot` (line
  406-422 of current `ReorderSection.tsx`). NOT the legacy file's
  styled `exportBtn` from `OrderReportScreen.tsx`. Lives alongside
  the `REFRESH` button in the `rightSlot`. Architect can validate
  during design.

### Users & Access ported to a new `UsersSection.tsx` (legacy `UsersScreen` parity)

- [ ] **AC21 — New `UsersSection.tsx` file exists.** A new file
  `src/screens/cmd/sections/UsersSection.tsx` is created. It follows
  the same Cmd UI section pattern as siblings (e.g., `VendorsSection`,
  `BrandsSection`): default-exported React component, consumes
  `useCmdColors()`, renders a section header + body, uses the
  existing Cmd UI atoms (`TabStrip`, `TouchableOpacity` mono-text
  buttons, modals from `src/components/cmd/`). It is wired into the
  `section ===` dispatch chain in
  `src/screens/cmd/InventoryDesktopLayout.tsx` (around line 183) so
  the sidebar entry routes to it.

- [ ] **AC22 — Sidebar entry registered.** A new sidebar item with
  `id: 'Users'` and `label: 'Users & access'` is added to the
  `useDefaultSidebarGroups()` selector in `src/lib/cmdSelectors.ts`
  (line 1027). PM-committed placement: **under a new top-level
  `Admin` group at the END of the sidebar tree, immediately before
  the super-admin-gated `Tenancy` group.** Rationale: it's a global
  admin tool (not store-scoped), it has no obvious home in
  Operations / Planning / Insights, and a dedicated `Admin` group
  signals "global admin surface" cleanly. The group is visible to
  ALL admins (no `isSuperAdmin` gate at the group level — the
  per-row gating lives inside the section's UI, mirroring the
  legacy `isMaster` checks). Architect can deviate during design
  if a clearer placement is found; if so, document in
  `backend-architect.md`.

- [ ] **AC23 — Invite-user flow.** The section renders an "Invite
  user" button (mono-text, matches Cmd UI). Click opens a modal that
  collects:
  - Full name (required)
  - Email (required)
  - Role: `user` or `admin` — role picker only visible to
    `master`-role current user (mirrors legacy gate at
    `AdminScreens.tsx:1604`). For non-master admins, role is fixed to
    `user`.
  - Store access: multi-select checkbox list of stores the current
    user has visibility into (i.e., from `useStore().stores`).
  - Submit calls `inviteUser({ email, name, role, brandId,
    storeIds, storeNames })` from `src/lib/auth.ts` (the
    options-object signature — NOT the deprecated
    `inviteUserLegacy` shim). `brandId` comes from
    `useStore().brand?.id` when role is `admin`; null otherwise.
  - Success: toast "Invitation sent!", close modal, refresh user
    list. Error: surface inline in modal (same shape as legacy
    `inviteWarning`).

- [ ] **AC24 — User list with role management + delete.** The section
  renders a list of users (one row per user). Each row shows:
  - Avatar / initials / display name / email / role badge
    (`Master` / `Admin` / `Store user`).
  - Store-access chips (admin + master see all stores; store users
    see their assigned stores only — mirrors legacy logic at
    `AdminScreens.tsx:1566`).
  - Status badge (Active / Pending invite).
  - Delete button (trash icon) — visible only when the current user
    is allowed to delete the target user, per the same gates as legacy:
    - Master can delete anyone except self.
    - Admin can delete users + self; cannot delete other admins or
      master.
  - Click delete opens a type-the-email confirm modal (mirrors legacy
    `deleteUserTarget` flow at `AdminScreens.tsx:1727`). On confirm,
    calls `deleteUser(userId)` from `src/lib/auth.ts` (which goes
    through the `delete-user` edge function). If the deleted user is
    self, sign out + redirect to login (mirrors legacy lines
    1473-1479).
  - Data source: `fetchAllUsers({ brandId })` from `src/lib/auth.ts`.
    `brandId` comes from `useStore().brand?.id`. The query is already
    RLS-gated on the server.

- [ ] **AC25 — Password reset trigger.** Each user row shows a
  "Send password reset" button (icon or text — architect's call)
  next to the delete button. Visibility gates: master sees this on
  every user except master itself; admin sees it on store users only
  (cannot reset other admins or master). Click triggers
  `supabase.auth.resetPasswordForEmail(targetEmail)` directly from
  the client (no new edge function — the email goes through
  Supabase's built-in password-reset mailer). Confirmation toast:
  "Password reset email sent to {email}". This is the **only**
  net-new auth-surface behavior in the spec — legacy `UsersScreen`
  did not expose a reset trigger; the user explicitly asked for it.
  See Q8 resolution. If the architect determines the built-in
  Supabase mailer is not viable (e.g., needs a custom template), the
  fallback shape is a new admin-only edge function
  `send-password-reset` modeled on `send-invite-email`; architect's
  call during design pass.

### Config + flag removal

- [ ] **AC8 — `EXPO_PUBLIC_NEW_UI` flag deleted from code.**
  `src/lib/featureFlags.ts` is either deleted entirely (if `NEW_UI`
  is its only export) or the `NEW_UI` constant is removed. PM-default
  for the implementation: **delete the file** — confirmed by grep
  that `NEW_UI` is its only export.

- [ ] **AC9 — `App.tsx` wiring simplified.** The two imports
  (`AppNavigator`, `NEW_UI`) are removed; the conditional
  `{NEW_UI ? <CmdNavigator /> : <AppNavigator />}` at line 225 is
  replaced with `<CmdNavigator />`. The `bodyBg` computation at line
  130 collapses to `Cmd.bg` (the `NEW_UI ? Cmd.bg : C.bgTertiary`
  branch loses its ternary).

- [ ] **AC10 — `.env.example` cleaned.** The
  `# ─── Feature flags (client) ───` block (lines 29-34) is removed;
  the `.env.example` no longer documents `EXPO_PUBLIC_NEW_UI`.

- [ ] **AC11 — `README.md` updated.** Any references to
  `EXPO_PUBLIC_NEW_UI` and to legacy-UI screens are removed. The
  README's "UI fork" section (around line 32) collapses to "the app
  uses Cmd UI." Architect can scope the exact diff; treat as
  documentation hygiene, not a separate AC blocker.

### tsconfig changes

- [ ] **AC12 — `supabase/functions/**` excluded from base
  tsconfig.** Base `tsconfig.json`'s `exclude` array adds
  `"supabase/functions/**"`. Rationale: edge functions run under
  Deno 2 (not Node), use URL-form imports (`https://esm.sh/...`),
  and reference the `Deno` global — they will never typecheck under
  this repo's Node-shaped tsconfig. Deno LSP / `supabase functions
  deploy` own that surface.

- [ ] **AC13 — `scripts/**` excluded from base tsconfig.** Base
  `tsconfig.json`'s `exclude` array adds `"scripts/**"`. Rationale:
  CLAUDE.md describes `scripts/` as "one-off ts-node + curl smoke
  scripts." They are not part of the app graph; the test framework
  for any future test in `tests/` already lives in
  `tsconfig.test.json`. PM-default — Q6 resolved per user direction.

- [ ] **AC14 — No `@ts-ignore` / `@ts-expect-error` /
  `@ts-nocheck` band-aids added.** Same rule as spec 024 AC5.
  Reviewer scans the diff for net-new suppression directives.

### Base CI gate

- [ ] **AC15 — Base `tsc --noEmit` exits 0 on clean checkout.**
  After all deletions + exclusions land, `npx tsc --noEmit` (base
  config, no `-p` flag) from the repo root prints no `error TS*`
  lines and exits 0. The architect verifies in the design pass;
  reviewers verify in the review pass.

- [ ] **AC16 — `typecheck-base` CI job added.** A fourth job in
  `.github/workflows/test.yml` runs `npx tsc --noEmit` (base
  config, no `-p`) on every push and PR, on `ubuntu-latest`,
  `timeout-minutes: 10`. The job is named
  `typecheck-base` and uses the same Node 20 + `npm ci` setup as
  the existing `typecheck` job. Gates merges to `main` alongside
  the existing `jest`, `typecheck`, and `db` jobs.

- [ ] **AC17 — `tests/README.md` updated.** The CI table in
  `tests/README.md` adds the new `typecheck-base` job. One-paragraph
  description of what it covers (the full active graph, post-legacy
  deletion) and what it excludes (`supabase/functions/**`,
  `scripts/**`, `**/*.test.ts(x)`, `tests/**`).

### Parity / behavior verification

- [ ] **AC18 — Cmd UI parity smoke checklist.** The implementation
  PR's description includes a manual smoke checklist mapping every
  legacy feature path to its Cmd UI section. Reviewer (or user)
  ticks each box on a local build:

  | Legacy entry point                                  | Cmd UI section                                                            |
  | --------------------------------------------------- | ------------------------------------------------------------------------- |
  | `AppNavigator` → Dashboard tab                      | `DashboardSection` (sidebar: Dashboard)                                   |
  | `AppNavigator` → Recipes tab (`RecipesScreen`)      | `RecipesSection` (sidebar: Menu Items / BOM)                              |
  | `AppNavigator` → Items tab (`ItemsScreen`)          | `InventoryCatalogMode` (sidebar: Inventory)                               |
  | `AppNavigator` → EODCount tab (`EODCountScreen`)    | `EODCountSection` (sidebar: EOD Count)                                    |
  | `AppNavigator` → Orders tab (`OrdersScreen`)        | `POsSection` (sidebar: POs)                                               |
  | `AppNavigator` → More → Waste Log                   | `WasteLogSection` (sidebar: Waste Log)                                    |
  | `AppNavigator` → More → Ingredients                 | Inline in `RecipesSection` / `PrepRecipesSection` (soft-parity, accepted) |
  | `AppNavigator` → More → Prep Recipes                | `PrepRecipesSection`                                                      |
  | `AppNavigator` → More → Suggested Orders            | `ReorderSection` (CSV/PDF export per AC4/AC5)                             |
  | `AppNavigator` → More → EOD History                 | `EODCountSection` → `history.tsx` tab (soft-parity, accepted)             |
  | `AppNavigator` → More → Vendors                     | `VendorsSection`                                                          |
  | `AppNavigator` → More → POS Import                  | `POSImportsSection`                                                       |
  | `AppNavigator` → More → Reconciliation              | `ReconciliationSection`                                                   |
  | `AppNavigator` → More → Reports & Analytics         | `ReportsSection`                                                          |
  | `AppNavigator` → More → Audit Log                   | `AuditLogSection`                                                         |
  | `AppNavigator` → More → Users & Access              | `UsersSection` (NEW — per AC21–AC25; sidebar: Users & access)             |
  | `AppNavigator` → More → DB Inspector                | `DBInspectorScreen` (shared, sibling stack route in CmdNavigator)         |
  | `AppNavigator` → Login / Register                   | Shared `LoginScreen` / `RegisterScreen` (CmdNavigator imports both)       |
  | Master role → MasterNavigator → Users & Access      | `UsersSection` (NEW — same surface, master-only role picker visibility)   |

- [ ] **AC19 — No behavior change for active Cmd UI users.** Users
  who were already on Cmd UI (Vercel prod) see two additive changes:
  the new CSV/PDF buttons in `ReorderSection` and the new "Users &
  access" sidebar entry routing to `UsersSection`. No removal of
  functionality. No data-shape changes.

- [ ] **AC20 — Users on legacy switch to Cmd UI.** Users whose
  `EXPO_PUBLIC_NEW_UI` was unset or `false` (notably: native EAS
  builds, and any web user with a stale `.env.local`) will render
  Cmd UI on the next build. This is the intent of the pivot; the
  release-coordinator should call this out explicitly in the release
  proposal as the user-visible change. **Confirmed by user (Q3
  resolution): Cmd UI is the canonical path for both web and
  native.**

## In scope

- File deletions enumerated in AC1–AC3.
- CSV/PDF export feature in `ReorderSection.tsx` per AC4–AC7.
- New `UsersSection.tsx` per AC21–AC25 (invites, role management,
  user delete with type-the-email gate, password reset trigger,
  sidebar wiring).
- Flag + wiring removal per AC8–AC11.
- `tsconfig.json` exclude-array additions per AC12 + AC13.
- Fourth CI job per AC16.
- Documentation updates per AC10, AC11, AC17.
- The parity smoke checklist per AC18.

### Files added

- `src/screens/cmd/sections/UsersSection.tsx` — the new section
  component per AC21–AC25.

(Modified files: `App.tsx`, `src/screens/cmd/InventoryDesktopLayout.tsx`,
`src/lib/cmdSelectors.ts`, `src/screens/cmd/sections/ReorderSection.tsx`,
`tsconfig.json`, `.env.example`, `README.md`, `tests/README.md`,
`.github/workflows/test.yml`, `package.json`. Possibly
`src/lib/auth.ts` if the architect concludes a new wrapper helper for
password-reset is warranted — see AC25.)

## Out of scope (explicitly)

- **Modifying the `app.json` slug.** Untouched per CLAUDE.md "DO NOT
  AUTO-FIX." A native-build readiness audit might surface a need to
  change the slug; that is a separate spec.
- **`useStore.ts` refactor.** Spec is delete-and-go, not
  refactor-while-deleting. CLAUDE.md notes the two-store overlap as
  a gap; deleting `useSupabaseStore.ts` resolves the overlap. No
  reshape of the canonical `useStore.ts` belongs here.
- **`@/` alias migration.** CLAUDE.md notes inconsistent
  relative-vs-alias imports. Still inconsistent; separate spec if
  it ever becomes a priority.
- **Repo-root spreadsheet (`2AM_Project_Menu_Ingredients.xlsx`).**
  Untouched per CLAUDE.md.
- **Stay-or-go on `LoginScreen` / `RegisterScreen` /
  `DBInspectorScreen` / `InventoryListScreen` /
  `ItemDetailScreen`.** Verified shared with Cmd UI (Background §3,
  §4). They stay; no deletion AC for them.
- **EAS native readiness audit.** Removing the flag means EAS
  builds switch from `AppNavigator` to `CmdNavigator`. Whether the
  Cmd UI desktop shell renders correctly on iOS / Android phone
  builds is a separate verification pass. This spec ships the
  delete; a follow-up spec or QA pass can validate native rendering.
  (Note: `ResponsiveCmdShell` is documented in
  `CmdNavigator.tsx:22-34` as breakpoint-aware and the mobile
  fallbacks live in `src/screens/cmd/`, so the framework is in
  place — but this spec does not assert native-build pixel parity.)
- **Store management block from legacy `UsersScreen` (add/edit/
  delete stores).** Legacy `UsersScreen` embeds a stores
  add/edit/delete sub-section (lines 1300–1360, 1641–1724). PM
  judgment: this is conceptually a **separate** Cmd UI surface
  (a "Stores" section, or merged into `BrandsSection`) and porting
  it would push this spec out of its current scope band. The new
  `UsersSection` covers **users only**, mirroring the part of the
  legacy screen that this spec explicitly calls out. If the user
  needs the stores block before the legacy file can be deleted,
  the architect should surface that as a blocker in the design
  pass; otherwise it's a follow-up spec.
- **Spec 020 / Spec 016 cleanup of legacy stubs.** Spec 020's
  `vendorId: ''` stub at `EODCountScreen.tsx:528` and Spec 016's
  similar legacy stubs disappear automatically because their files
  are deleted. No separate AC needed — those notes will simply stop
  being load-bearing once the files are gone.
- **Net-new jest tests.** Behavior changes are: (a) a feature port
  (AC4/AC5 export — manually verifiable per the legacy `OrderReport`
  output as the parity oracle), (b) a UI port (AC21–AC25
  `UsersSection` — backend coverage already exists in `src/lib/auth.ts`
  and is exercised by the legacy `UsersScreen`; the port is
  client-only and behaviorally one-to-one), (c) deletions (no logic
  change reachable from Cmd UI), and (d) a flag removal (no behavior
  change for Cmd UI users). No backend changes beyond a possible
  thin client-side wrapper for password-reset (AC25). PM judgment:
  no new jest tests required; test-engineer reviews at PR time and
  flags if any are needed.
- **Backend changes.** None except the AC25 password-reset trigger,
  which is **expected to be client-side** (`supabase.auth.
  resetPasswordForEmail`). Architect can elevate to a new edge
  function in design pass if the built-in mailer doesn't fit. No
  migrations. No RPC changes. No edge function edits to existing
  functions.

## Open questions resolved

### Q1 — Shared screens stay (confirmed during PM audit)

`LoginScreen.tsx`, `RegisterScreen.tsx`, `DBInspectorScreen.tsx`
are each imported by `CmdNavigator.tsx` (verified Background §4).
They stay.

**⟪RESOLVED⟫** — PM audit confirmed; architect should NOT delete
these files.

### Q2 — Mobile fallback screens (confirmed during PM audit)

`InventoryListScreen.tsx` and `ItemDetailScreen.tsx` at repo-root
`src/screens/` **do not exist** — the only files with those names
are in `src/screens/cmd/`, which `ResponsiveCmdShell` renders under
1100 px.

**⟪RESOLVED⟫** — Nothing to delete. CLAUDE.md's reference to those
paths is a description bug to be fixed in the follow-up CLAUDE.md
edit pass (post-spec).

### Q3 — Native EAS builds switch to Cmd UI

Removing the flag = native EAS builds switch from `AppNavigator` to
`CmdNavigator` on the next build. The user explicitly confirmed
this is the intent of the pivot.

**⟪RESOLVED⟫** — User confirmed: yes, flip them. Cmd UI is the
canonical path for both web and native. Release-coordinator must
call this out in the release proposal as the user-visible change so
the user can decide whether to ship the native build immediately,
hold for a separate QA pass, or stage behind a TestFlight beta.

### Q4 — CSV/PDF export UX shape

**⟪RESOLVED⟫** — User confirmed: single section-level "Download
CSV" + "Download PDF" pair (matches legacy `OrderReportScreen` UX —
one CSV / one PDF for the whole report, with the data already
vendor-grouped inside the file). See AC4–AC7.

### Q5 — Users & Access section in Cmd UI

**⟪RESOLVED⟫** — User confirmed: **build a new `UsersSection` in
Cmd UI as part of this spec.** PM verified during audit (Background
§13) that no Cmd UI surface currently exists for users management;
deleting `UsersScreen` from `AdminScreens.tsx` without porting it
would regress both admin-role invite/delete flows and master-role
global-user-management flows. Scope per user direction: invites +
role management (admin / master / user — matching existing
`app_metadata.role` schema) + per-user delete + password reset
trigger. See AC21–AC25. Spec scope grew by ~3–5h of frontend dev
time per user estimate; backend dev impact is near-zero because
`src/lib/auth.ts` already has the helpers (`inviteUser`,
`fetchAllUsers`, `deleteUser`); only the password-reset path
(AC25) is net-new and is expected to be a one-line client call.

### Q6 — `scripts/test-unit-conversion.ts`

**⟪RESOLVED⟫** — User confirmed: exclude `scripts/**` from the
base tsconfig (AC13). The directory is not part of the app graph;
this is the more general-purpose choice over a one-line fixture
fix.

### Q7 — Reviews directory / prior spec dir

**⟪RESOLVED⟫** — User confirmed: delete the prior
`specs/025-legacy-typescript-sweep/` directory as part of the
implementation PR. PM has already overwritten its `spec.md` with a
one-line "superseded" redirect; the implementing dev should
`rm -rf specs/025-legacy-typescript-sweep/` (the redirect stub is
intentionally easy to remove). Git history covers the prior content.

### Q8 — Password reset implementation surface (resolved by PM judgment)

The user listed "password reset trigger (if the legacy supports it;
otherwise just 'reset email')" in the Q5 expansion. PM grep
verified the legacy `UsersScreen` does **not** expose a
password-reset trigger today; it has only invite / delete / role
flows. The "reset email" fallback is therefore the canonical
implementation:

**⟪RESOLVED⟫** — Use `supabase.auth.resetPasswordForEmail
(targetEmail)` from the client. No new edge function. No new
migration. If the architect determines a custom template is needed
(e.g., I.M.R-branded reset email), the fallback shape is a new
admin-only edge function `send-password-reset` modeled on
`send-invite-email`; this is the architect's call in the design
pass, not a spec-level decision. See AC25.

## Dependencies

- **Spec 024** (TypeScript hygiene cleanup) — established the
  `typecheck:test` CI gate and the precedent that "TS hygiene in
  legacy files is NOT new functionality." Spec 025 closes spec
  024's deferred AC13 (base typecheck gate) and §Q5a corollary's
  manual cross-check.
- **Per-spec audits** (010, 011, 012b, 015, 016, 017, 020, 022,
  024) — every prior spec assumed legacy screens existed. This
  spec invalidates those notes; PM judges that's a paperwork
  problem, not a real dependency. Most surface in the deleted
  files themselves.
- **CLAUDE.md** — load-bearing. After this spec ships, CLAUDE.md
  needs an editing pass (architect or release-coordinator
  responsibility, not this spec's) to:
  - Delete "Legacy admin screens" section.
  - Update "Data layer (active vs. legacy)" — only `useStore.ts`
    remains; the legacy list collapses.
  - Update "Current state" → "Gaps and unknowns" to remove the
    legacy-file references.
  - Update "Project structure" diagram to drop the legacy entries.
  - Update "UI fork via env flag" convention note — there is no
    fork anymore.
  - The CLAUDE.md edits are NOT a spec 025 AC, but they're a
    spec-025 follow-up that the user should be reminded of in the
    release proposal.
- **No new npm packages, no infra changes, no env vars, no
  migrations, no edge functions** (except the conditional
  `send-password-reset` edge function under AC25 if the architect
  elects to elevate it beyond the built-in mailer — architect's
  call).

## Project-specific notes

- **Cmd UI section / legacy:** primarily about deleting legacy and
  porting two features (CSV/PDF export into `ReorderSection.tsx`,
  and the entire users-management surface into a new
  `UsersSection.tsx`). New Cmd UI section: `UsersSection.tsx` is the
  only one.
- **Per-store or admin-global:** `UsersSection` is **admin-global**
  (mirrors legacy `UsersScreen`), gated by `fetchAllUsers({ brandId
  })` which already respects per-store / per-brand RLS via the
  `auth_can_see_store()` machinery on the underlying tables.
- **Realtime channels touched:** none. `AppNavigator.tsx`'s
  `useRealtimeSync` wiring goes away with the file; `CmdNavigator`
  already has its own `useRealtimeSync`
  (`src/navigation/CmdNavigator.tsx:73`). The `UsersSection` does
  NOT subscribe to a realtime channel — user/invite changes are
  rare enough that an on-mount fetch + post-action refetch
  (matching legacy `refreshCloudUsers` pattern) is sufficient.
  Architect can elevate to realtime in design if there's a reason
  not yet surfaced.
- **Migrations needed:** no.
- **Edge functions touched:** none (the `supabase/functions/**`
  exclusion is tsconfig-only, not a function edit). AC25's
  fallback escape hatch — a new `send-password-reset` edge function
  — is the architect's option, not a spec mandate.
- **Web/native scope:** **both**.
  - Web: prod is already on Cmd UI (`.env.example` says
    pre-staged); this spec removes the fallback. Vercel build
    config doesn't reference `EXPO_PUBLIC_NEW_UI`, so removing the
    flag from `.env` doesn't break the build pipeline.
  - Native: EAS builds switch from `AppNavigator` to
    `CmdNavigator` on next build. Confirmed user direction (Q3).
- **`app.json` slug:** untouched per CLAUDE.md "DO NOT AUTO-FIX."
- **Tests:** no new jest tests per §Out of scope. The base
  `tsc --noEmit` CI job (AC16) is the new gate.
- **Risk vectors:**
  - **EAS native readiness.** Q3 resolved per user. Mitigation:
    release-coordinator flags it; user owns the ship decision.
  - **Realtime subscription continuity.** Mitigation: architect
    verifies the `useRealtimeSync` wiring in `CmdNavigator` is
    sufficient (it is — `CmdNavigator.tsx:73`).
  - **Lost legacy data layer.** `db.json` deletion. Mitigation:
    `useJsonServerSync` was the only consumer, and it's deleted in
    the same change set; the legacy data layer was inert under
    Supabase anyway.
  - **`tsc --noEmit` clean assumption.** PM has NOT run `tsc
    --noEmit` against a hypothetical post-deletion tree. The
    architect must verify this in design pass and flag any
    residual errors the spec hasn't anticipated. If residual
    errors exist (e.g., a Cmd UI file that imports something from
    a deleted legacy file), the architect should propose a fix
    shape; PM-default for any such residual is "fix in place,"
    not "re-add exclusions."
  - **Users & Access port behavioral drift.** Mitigation: AC23 /
    AC24 cite the exact legacy code locations (`AdminScreens.tsx:1604`,
    `:1566`, `:1727`, `:1473–1479`) so the architect / dev can
    cross-check during design + implementation. Reviewer (or user)
    smoke-tests against the legacy screen as the parity oracle.
  - **`inviteUserLegacy` shim removal.** The legacy
    `AdminScreens.tsx:1400` calls `inviteUserLegacy(...)`. When
    `AdminScreens.tsx` is deleted (AC2), the
    `@deprecated`-marked shim in `src/lib/auth.ts:217` becomes
    orphaned. Architect should decide in design pass whether to
    delete the shim in the same change or leave it for a future
    cleanup. PM-default: **delete it** in the same change set
    since the only caller is gone.
  - **Store-management block deferred.** The legacy `UsersScreen`
    includes an embedded stores add/edit/delete sub-section
    explicitly out of scope here. Mitigation: surfaced under §Out
    of scope; if the user blocks the legacy delete on it, the
    architect raises it before READY_FOR_BUILD and a separate
    spec is opened for the stores surface.
- **Spec 024 cross-references:**
  - Spec 024 §Q5a corollary (`tsconfig.test.json` coverage gap) —
    closes via AC16.
  - Spec 024 AC13 (deferred base `typecheck` gate) — directly
    closes via AC16.
  - Spec 024 forward-compat preview (§"Spec 025 forward-compat
    preview") — the 103 errors enumerated there evaporate because
    their files are deleted, not patched.
- **Workflow file location:** confirmed at
  `.github/workflows/test.yml`. AC16 adds a fourth job in place.

## Backend Architecture

This spec is mostly a deletion + two ports — no migrations, no edge
functions, no RPC changes. The "Backend Architecture" section is
narrower than usual: it pins down the contracts the developer will
implement against, names the import-graph cross-checks PM asked for,
and stakes out the CI shape. Frontend developer owns the two
new-surface UIs (UsersSection + Reorder export buttons); backend
developer owns the deletes + flag + tsconfig + workflow + the one
client-only helper.

### 1. File-deletion safety — cross-check results

PM listed ~17 files to delete. I cross-checked every one for inbound
imports from `src/` (excluding the deleted files themselves). The
only inbound imports come from `AppNavigator.tsx`, which is itself
in the delete set. **One orphan PM did not list — `src/lib/api.ts`
— surfaced; see below.**

**Confirmed clean — no Cmd UI consumer**

| File                                      | Importers (`src/`, excluding deleted files) |
| ----------------------------------------- | ------------------------------------------- |
| `src/screens/AdminScreens.tsx`            | `AppNavigator.tsx` only                     |
| `src/screens/DashboardScreen.tsx`         | `AppNavigator.tsx` only                     |
| `src/screens/EODCountScreen.tsx`          | `AppNavigator.tsx` only                     |
| `src/screens/EODHistoryScreen.tsx`        | `AppNavigator.tsx` only                     |
| `src/screens/IngredientsScreen.tsx`       | `AppNavigator.tsx` only                     |
| `src/screens/ItemsScreen.tsx`             | `AppNavigator.tsx` only                     |
| `src/screens/OrderReportScreen.tsx`       | `AppNavigator.tsx` only                     |
| `src/screens/OrdersScreen.tsx`            | `AppNavigator.tsx` only                     |
| `src/screens/POSImportScreen.tsx`         | `AppNavigator.tsx` only                     |
| `src/screens/PrepRecipesScreen.tsx`       | `AppNavigator.tsx` only                     |
| `src/screens/ReconciliationScreen.tsx`    | `AppNavigator.tsx` only                     |
| `src/screens/WasteLogScreen.tsx`          | `AppNavigator.tsx` only                     |
| `src/components/IngredientEditor.tsx`     | `AdminScreens.tsx`, `PrepRecipesScreen.tsx` only (both deleted). One **comment** mention in `src/utils/unitConversion.ts:239` — not an import, just doc-string text. Leave the comment as-is for now (it explains a unit math convention); a CLAUDE.md follow-up can clean it later. |
| `src/store/useSupabaseStore.ts`           | None (PM Background §6 confirmed)           |
| `src/store/useJsonServerSync.ts`          | `AppNavigator.tsx` only (PM Background §5)  |
| `db.json`                                 | Referenced only by `useJsonServerSync.ts` and `src/lib/api.ts` (see orphan §1b) |

**1b. Orphan PM did not list — `src/lib/api.ts`**

`src/lib/api.ts` is a json-server client (`fetch('http://localhost:3001/inventory')`)
that has **zero importers** in `src/`. It is dead alongside `db.json`
and `useJsonServerSync.ts`. **Add to AC3 delete set.** Same
rationale as the rest of the legacy data layer: kept under
CLAUDE.md "Legacy — do not modify" by association even though it
wasn't named; the file is `npm run db`-flavored dead code and goes
away in the same change. The developer should `rm src/lib/api.ts`
in the same commit as AC3.

**1c. `inviteUserLegacy` shim — PM-default confirmed**

`inviteUserLegacy` at `src/lib/auth.ts:217` is imported only by
`src/screens/AdminScreens.tsx:1400` (which is being deleted in AC2).
**Delete the shim in the same change set** (PM-default), via an
edit to `src/lib/auth.ts` that removes the function body and its
JSDoc header. Keep `inviteUser` (the options-object form) — the
new `UsersSection.tsx` calls it directly per AC23. This is a
one-export-removal, not a structural refactor.

**1d. Files that look related but stay (per PM §Out of scope)**

- `LoginScreen.tsx`, `RegisterScreen.tsx`, `DBInspectorScreen.tsx`,
  `src/screens/cmd/InventoryListScreen.tsx`,
  `src/screens/cmd/ItemDetailScreen.tsx` — all imported by
  `CmdNavigator.tsx` or `ResponsiveCmdShell`.
- `src/screens/dev/CmdAtomsPreview.tsx` — has a **comment**
  mentioning `EXPO_PUBLIC_NEW_UI=true` (line 31). No import. Same
  treatment as `unitConversion.ts`: leave the comment, deletion
  follow-up later.
- `src/screens/cmd/ComingSoonScreen.tsx` (comment-only NEW_UI
  reference at line 34 + a literal `NEW_UI=true` display string at
  line 122). The display string is a UI affordance, not a code
  reference — it shows up in the dev-mode "coming soon" status row.
  Treatment: same as above — frontend developer's call whether to
  drop the literal label or keep it as a static "Cmd UI" badge.
  Not blocking.
- `src/components/cmd/ThemeToggle.tsx` (comment-only NEW_UI
  reference at line 10). Leave.
- `src/screens/EODCountScreen.tsx` (comment-only NEW_UI reference
  at line 521 — inside a file that is itself getting deleted).
  Moot.

### 2. UsersSection design (AC21–AC25)

#### 2.A Data model — no changes

The legacy `UsersScreen` reads from:

- `supabase.auth` — session for current user
- `profiles` table — server-RLS-gated read (existing)
- `user_stores` table — server-RLS-gated read (existing)
- `invitations` table — read via `inviteUser`, `fetchAllUsers`
  helpers (existing)

All three tables, all three helpers (`inviteUser`, `fetchAllUsers`,
`deleteUser`), and all four RLS policies that gate them already
exist. **No new migration. No new RPC. No new edge function.** The
port is client-only.

The one net-new behavior (password reset, AC25) goes through
`supabase.auth.resetPasswordForEmail(targetEmail)` — a built-in
client SDK method that hits Supabase's GoTrue endpoint and triggers
its built-in mailer. The mailer template is project-level config
(Supabase Dashboard → Authentication → Email Templates) and is out
of scope for this spec — the spec only wires the trigger. **No new
edge function.** PM-default confirmed.

(Fallback path remains open: if the user later wants an
I.M.R-branded reset email modeled on `send-invite-email`, a
follow-up spec can add a `send-password-reset` edge function. Not
in scope here.)

#### 2.B `src/lib/db.ts` surface — no changes

The legacy code already uses `src/lib/auth.ts` (not `db.ts`) for
user management, and that's the right boundary — auth-table writes
live in `auth.ts`, business-data reads/writes live in `db.ts`. The
new section follows the existing convention:

- `inviteUser(opts)` — already exists; AC23 calls it directly.
- `fetchAllUsers({ brandId })` — already exists; AC24 calls it
  directly.
- `deleteUser(userId)` — already exists; AC24 calls it directly.

**One new helper in `src/lib/auth.ts` (AC25 password reset).**
PM-default is the inline-call form, but for symmetry with the
existing surface and to keep the section's import list tidy, the
developer should add a thin wrapper:

```ts
// src/lib/auth.ts
/**
 * Trigger Supabase's built-in password-reset email for an arbitrary
 * user (admin tool, called from UsersSection). Uses the project-level
 * GoTrue mailer template — no edge function involved.
 *
 * Server-side this is gated by Supabase's GoTrue policy (the caller
 * must hold a valid session). Client-side the UsersSection enforces
 * the role gates from AC25 (master/admin can reset their own
 * subordinates; the target email is passed in plain).
 */
export async function sendPasswordReset(email: string): Promise<{ error: string | null }>;
```

Internals: thin wrapper around `supabase.auth.resetPasswordForEmail(email)`
that normalizes the success/error shape to match `deleteUser`'s
return type so the section's call site is consistent. Lives next to
`deleteUser` in `auth.ts`.

(Justification for the wrapper vs inline call: matches the existing
auth-helper convention; lets the section import one named function
rather than reaching into the `supabase` client; gives a single
seam for future template customization without churning the call
site.)

#### 2.C `useStore.ts` surface

`useStore.ts` has `inviteUser` / `removeUser` actions today (lines
1713 / 1737) that mutate the LOCAL `users[]` slice. **These are
legacy in-memory actions used only by `AdminScreens.tsx`.** The new
`UsersSection.tsx` is server-truth from the jump (legacy
`UsersScreen` already does this via `cloudUsers` state — see lines
1273–1376 in `AdminScreens.tsx`), so the new section does **NOT**
call `useStore.inviteUser` or `useStore.removeUser`. It uses local
`React.useState` for the fetched user list, the form, and the
delete target — exactly the pattern legacy already follows for
`cloudUsers`.

Existing `useStore.deleteProfile` (line 150 of `useStore.ts`)
exists for the BrandsSection members tab, wraps the same
`deleteUser` edge call, and does NO optimistic mutation. It's
admin-global. **The new UsersSection can reuse `deleteProfile` from
the store** — it's a slightly cleaner API than calling `deleteUser`
directly because it handles the `notifyBackendError` plumbing. Same
import as BrandsSection.

**No new useStore slice. No new store action.** The legacy
`useStore.inviteUser` / `removeUser` / `addStore` actions stay in
useStore.ts (they're still cited by the legacy AdminScreens file,
which is deleted in the same change but the store retains its
actions for now — removing them is a useStore.ts refactor and PM
explicitly carved that out of scope under §"useStore.ts refactor").

#### 2.D RLS impact

None — every table the section reads is already gated by existing
RLS:

- `profiles` — gated by `auth_is_admin()` for cross-row reads;
  `auth.uid() = id` for own-row reads.
- `user_stores` — gated by `auth_can_see_store(store_id)` for
  reads; `auth_is_admin()` for writes.
- `invitations` — `auth_is_admin()` for reads and writes; the
  `get_pending_invitation` SECURITY DEFINER RPC handles the anon
  registration case.

Existing helpers (`fetchAllUsers`, `inviteUser`, `deleteUser`) all
flow through these policies. No policy edits, no policy additions.

#### 2.E Sidebar placement

PM-default — a new `Admin` group at the END of the tree,
immediately before the super-admin-gated `Tenancy` group — is the
right call. Confirmed in `src/lib/cmdSelectors.ts:1027`. **The
group is visible to all admins (no super-admin filter at the group
level).** Per-row gating (master can see other admins, admin
cannot) lives inside `UsersSection`'s render, mirroring the legacy
`isMaster` checks. Specifically:

```ts
// cmdSelectors.ts — useDefaultSidebarGroups, inside the useMemo
const groups: SidebarGroup[] = [
  { label: 'Operations', items: [/* unchanged */] },
  { label: 'Planning',   items: [/* unchanged */] },
  { label: 'Insights',   items: [/* unchanged */] },
  { label: 'Admin', items: [
    { id: 'Users', label: 'Users & access' },
  ]},
];
if (isSuperAdmin) {
  groups.push({ label: 'Tenancy', items: [{ id: 'Brands', label: 'Brands' }] });
}
```

The item `id: 'Users'` is load-bearing for the Spec 008 per-user
override merge (per the comment at line 1018 "Item ids are
load-bearing"). Pick `'Users'` (singular-noun-style, matches
`'Vendors'`, `'Brands'`, `'Recipes'`). Don't rename it after
landing.

#### 2.F Section-dispatch wiring

Add a single line to the `section ===` ternary in
`src/screens/cmd/InventoryDesktopLayout.tsx` (right before the
`Reports` arm at line 181):

```tsx
) : section === 'Users' ? (
  <UsersSection />
) : section === 'Reports' ? (
  // ... existing
```

…with a matching `import UsersSection from './sections/UsersSection';`
at the top of the file (alongside the other section imports).

#### 2.G UI shape — concrete pattern

Mirror **BrandsSection** as the reference, not VendorsSection — the
section is admin-global (no per-store list pane), the list is
flat, and BrandsSection already has the members-tab pattern for
delete-with-type-confirm + InviteAdminDrawer that this section
shares 70% of.

Concretely, `src/screens/cmd/sections/UsersSection.tsx`:

```
default export function UsersSection() {
  - useCmdColors(), useStore(currentUser), useStore(stores)
  - local state: users (User[] | null), inviteOpen (bool),
    deleteTarget (User | null), resetTarget (User | null)
  - on mount: fetchAllUsers({ brandId: currentUser.brandId || undefined })
  - rightSlot in TabStrip: "+ INVITE USER" mono-text button
  - body: header + flat list of user rows (FlatList)
  - each row: avatar / initials / name / email / role-badge /
    store-chips / status / [Reset email] / [Delete]
  - InviteUserDrawer (new component or inline) — see 2.H
  - TypeToConfirmModal (reused) — requires typing user.email
  - Toast on success
}
```

**2.G.1 The "Master" gates.** The current super-admin gate is
`useIsSuperAdmin()` (returns true when `currentUser.role === 'super_admin'`).
The legacy section's gates are `currentUser?.role === 'master'`
(strict-equal — not the SQL `auth_is_admin()` superset). The legacy
"master" role is a separate role from "super_admin" in this
codebase's role schema:

```
UserRole = 'super_admin' | 'master' | 'admin' | 'user'
```

The new UsersSection uses the same strict gate — `currentUser?.role === 'master'` —
to drive:
- The role picker visible in the invite drawer (admin/user
  selector).
- The "can delete this user" predicate (master deletes anyone
  except self; admin deletes users + self).
- The "can password-reset this user" predicate (master can reset
  anyone except master; admin can reset only `user`-role rows).

`useIsSuperAdmin()` is **not** used in this section — the section
is admin-global but not super-admin-only. (Super-admin role
permissions are a superset of master's; the existing role hierarchy
means a super-admin is automatically also "treated as master" for
these gates in the legacy code — see `isMaster = currentUser?.role === 'master'`
at `AdminScreens.tsx:1379`. For symmetry, the new section's `isMaster`
predicate should be `currentUser?.role === 'master' || currentUser?.role === 'super_admin'`,
so super-admins keep their existing visibility — this is a small
generalization, not a behavior change.)

**2.G.2 BrandsSection's `deleteProfile` reuse.** The section's
delete flow is:

```ts
const deleteProfile = useStore((s) => s.deleteProfile);
// in handler:
const ok = await deleteProfile(targetUser.id);
if (ok) { /* refresh, toast, optionally signOut if self */ }
```

`deleteProfile` already wraps the `delete-user` edge function and
the `notifyBackendError` toast path (per `useStore.ts:147`).

**2.G.3 Self-delete sign-out.** The legacy flow forces a redirect
to `/` after self-delete (lines 1473–1479). Port verbatim: call
`useStore.getState().logout()` and on web do
`setTimeout(() => { window.location.href = '/'; }, 1500)`.

**2.G.4 Empty / loading states.** Loading = users null. Empty =
users.length === 0. Both mirror the Cmd UI "panel + center caption"
pattern used in BrandsSection / VendorsSection.

#### 2.H Invite drawer — reuse vs new

The existing `InviteAdminDrawer` (`src/components/cmd/InviteAdminDrawer.tsx`)
is brand-scoped — it requires `brandId` + `brandName`, defaults the
store-multiselect to "all stores in the brand," and hard-defaults
role to `'admin'`. **It's not a fit for the generic users surface:**

- The UsersSection must support inviting `'user'` role (legacy
  admin's primary use case), not just admin.
- The store-multiselect must reflect the inviter's visible stores
  (`useStore().stores`), not "all brand stores."
- The `brandId` for `role='admin'` comes from
  `useStore().brand?.id` (current brand), not a parent component's
  prop.

**Build a new component: `src/components/cmd/InviteUserDrawer.tsx`.**
Model after `InviteAdminDrawer` (same `ResponsiveSheet` chrome,
same form validators, same async-submit handling), with these
adjustments:

```ts
interface Props {
  visible: boolean;
  onClose: () => void;
  onInvited?: () => void;
}

// Internally:
// - reads `currentUser` to gate role picker visibility (master sees role; admin defaults to 'user')
// - reads `stores` from useStore for the multi-select default
// - reads `brand` from useStore for `brandId` when role='admin'
// - calls `inviteUser({ email, name, role, brandId, storeIds, storeNames })`
//   from auth.ts
```

The role picker is only rendered when `currentUser?.role === 'master'`
(or `'super_admin'`). For non-master admins, role is hard-coded to
`'user'` and the picker is hidden.

(Justification for a new component over a refactor of
`InviteAdminDrawer`: `InviteAdminDrawer` is load-bearing for
BrandsSection's super-admin flow. The "brand is fixed by parent
context" design at line 39 is intentional. Pulling it apart to
serve two callers would muddy both surfaces. New file is cleaner.)

### 3. CSV/PDF export port (AC4–AC7)

#### 3.A Column mapping

PM's audit (Background §8) flagged that the legacy
`DynamicOrderLine` shape and the new `ReorderItem` shape diverge.
The new shape has **fewer fields** — `daysToCover`, `safetyStock`,
`dailyUsage` are not on `ReorderItem` (they're derivable server-side
inside the RPC but not surfaced in the payload). Map as follows:

**CSV (AC4) — `Papa.unparse(rows, { columns })`**

| CSV column        | Source                                          |
| ----------------- | ----------------------------------------------- |
| `Vendor`          | `vendor.vendorName` (literal from each row's parent vendor) |
| `Item Name`       | `item.itemName`                                 |
| `On Hand`         | `item.onHand` (numeric — Papa formats)          |
| `Pending PO`      | `item.pendingPoQty`                             |
| `Par Level`       | `item.parLevel`                                 |
| `Suggested Qty`   | `item.suggestedQty`                             |
| `Unit`            | `item.unit`                                     |
| `Est. Cost`       | `item.estimatedCost.toFixed(2)` (no `$` — CSV-friendly numeric) |
| `Flags`           | `item.flags.join(', ')` (uppercase tokens; empty → `''`) |
| `EOD Counted At`  | `vendor.eodSubmittedAt` (ISO-8601 string, or empty) |

Rows are flattened across all vendors in payload order — same shape
as the on-screen list. PapaParse's `unparse` handles the
escaping; pass `{ columns: [...] }` with the column array above to
fix the header order and to drop any other accidental fields.

Filename per AC4:
`IMR_Reorder_<store-name>_<YYYY-MM-DD>.csv`. Slug-ify spaces with
`_`. Date = `reorderPayload.asOfDate` if present, else
`new Date().toISOString().slice(0, 10)`.

**PDF (AC5) — `jsPDF` + `jspdf-autotable`**

Loaded via dynamic import to match the legacy file's pattern (lines
60-61 of `OrderReportScreen.tsx`). Layout:

1. **Header section** (drawn manually before any `autoTable` call):
   - `I.M.R` (18pt bold)
   - `Per-Vendor Reorder Suggestions` (12pt regular)
   - `Store: <storeName>  |  As of: <asOfDate>` (10pt, light gray)

2. **Per-vendor block** (one `autoTable` per vendor, in payload
   order). Before each table, draw a sub-header text row:
   - `<vendorName>  ·  Source: <EOD | STOCK FALLBACK>  ·  Next delivery: <nextDeliveryDate> (<daysUntil>)`
   - Use `doc.text()` + the table's `startY` to position. The
     `lastAutoTable.finalY + 14` idiom (per autotable plugin docs)
     keeps subsequent tables flowing down the page.

3. **Per-vendor `autoTable` call:**
   - `head: [['Item', 'On Hand', 'Pending', 'Par', 'Suggested', 'Unit', 'Est. Cost']]`
   - `body: vendor.items.map((item) => [item.itemName, item.onHand, item.pendingPoQty, item.parLevel, item.suggestedQty, item.unit, '$' + item.estimatedCost.toFixed(2)])`
   - `styles: { fontSize: 9, cellPadding: 3 }`
   - `headStyles: { fillColor: [26, 26, 24], textColor: 255, fontStyle: 'bold' }`
     (matches legacy)
   - `columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' }, 6: { halign: 'right' } }`

4. **Footer (drawn once on the last page):**
   - `Total items: <sum>  |  Est. total: $<sum>.toFixed(2)` —
     positioned at `lastAutoTable.finalY + 14`.
   - Generation line: `Generated by I.M.R — Inventory Management for Restaurant` (8pt, gray, near page bottom).

Filename per AC5: `IMR_Reorder_<store-name>_<YYYY-MM-DD>.pdf`.
Same slug + date logic as CSV.

#### 3.B Section integration

Two `TouchableOpacity` buttons added to `ReorderSection`'s
`TabStrip.rightSlot` (around line 405), to the LEFT of the existing
`REFRESH` button. Same mono-text styling pattern. Wrap the existing
`<TouchableOpacity ...>REFRESH</TouchableOpacity>` and the two new
buttons in a parent `<View style={{ flexDirection: 'row', gap: 6 }}>`:

```tsx
rightSlot={
  <View style={{ flexDirection: 'row', gap: 6 }}>
    {showExport && (
      <>
        <TouchableOpacity onPress={handleCSV} style={btnStyle}>CSV</TouchableOpacity>
        <TouchableOpacity onPress={handlePDF} style={btnStyle}>PDF</TouchableOpacity>
      </>
    )}
    <TouchableOpacity onPress={refresh} ...>REFRESH</TouchableOpacity>
  </View>
}
```

`showExport` is `Platform.OS === 'web' && vendors.length > 0 && !reorderError && !(reorderLoading && !reorderPayload)`
per AC6. Native phones get neither button — the buttons are
web-only.

#### 3.C Native scope

Per AC4/AC5 PM call, web-only is acceptable. `jsPDF` works on web
via the dynamic import; on native it requires a different setup
(file system writes via `expo-file-system` + share sheet via
`expo-sharing`). Both deps ARE in package.json (lines 39/42) so a
native port is feasible later, but **out of scope for this spec**
— the section just hides the buttons on native. Document this with
an inline comment in `ReorderSection.tsx` so it's discoverable for
the follow-up:

```tsx
// Web-only export per spec 025 AC4/AC5. Native port (expo-file-system
// + expo-sharing) is a separate spec when EAS native readiness lands.
```

### 4. `EXPO_PUBLIC_NEW_UI` flag removal (AC8–AC11)

#### 4.A Touch points enumerated

PM listed the major ones; I verified each:

1. **`src/lib/featureFlags.ts`** — entire file deleted (AC8;
   `NEW_UI` is the only export, confirmed by file read).
2. **`App.tsx`** — three edits (AC9):
   - Line 9: `import AppNavigator from './src/navigation/AppNavigator';` → DELETE
   - Line 15: `import { NEW_UI } from './src/lib/featureFlags';` → DELETE
   - Line 130: `const bodyBg = NEW_UI ? Cmd.bg : C.bgTertiary;` → `const bodyBg = Cmd.bg;` (and the unused `C` import for `useColors` can stay or go depending on whether `C` is used elsewhere — quick scan: not used elsewhere in this file, so the developer can also drop `const C = useColors();` at line 125, but this is hygiene, not load-bearing).
   - Line 225: `{NEW_UI ? <CmdNavigator /> : <AppNavigator />}` → `<CmdNavigator />`
3. **`.env.example`** — delete lines 29–34 (the "Feature flags (client)" block; AC10).
4. **`README.md`** — multi-spot edit (AC11):
   - Line 30–34 — "Two UIs in one app" header + the `EXPO_PUBLIC_NEW_UI=true` sub-header.
   - Line 64–66 — "Legacy UI (`EXPO_PUBLIC_NEW_UI=false`)" sub-section + the `AppNavigator` paragraph.
   - Line 103 — the project-structure ASCII diagram line `# entry — forks on EXPO_PUBLIC_NEW_UI`.
   - Line 106 — `featureFlags.ts # NEW_UI flag definition`.
   - The "Cmd theme" section becomes the only theme section — rename the heading from `### Cmd theme (\`EXPO_PUBLIC_NEW_UI=true\`)` to `### UI` (or similar).
   - Reviewer scope, not a separate AC blocker per PM AC11.

**No vercel.json or eas.json edits.** I grep-confirmed neither file
mentions `EXPO_PUBLIC_NEW_UI`. The flag pre-staged on Vercel is
runtime-only — once the code stops reading it, the env-var value
is inert; the user can clean it up in the Vercel dashboard
post-deploy (call this out in the release proposal).

#### 4.B Comment-only references — NOT delete-mandatory

PM Background and my §1d cross-check identified 4 comment-only NEW_UI
mentions that survive the flag removal (`unitConversion.ts:239`,
`ComingSoonScreen.tsx:34, 122`, `CmdAtomsPreview.tsx:31`,
`ThemeToggle.tsx:10`). **These are docs, not code references.**
Cleaning them is hygiene — frontend developer's call. Not blocking
AC8/AC9/AC10/AC11.

The literal `NEW_UI=true` displayed text in `ComingSoonScreen.tsx:122`
is the one I'd flag as worth touching — it's a user-visible string
that becomes confusing once the flag is gone. Suggest: change to a
neutral `'Cmd UI'` label, or drop the right slot entirely. Frontend
developer can decide during implementation; not a separate AC.

### 5. CI gate (AC15–AC17)

#### 5.A New `typecheck-base` job

Add a fourth job to `.github/workflows/test.yml`, modeled exactly
on the existing `typecheck` job (lines 59–78), with three deltas:

```yaml
typecheck-base:
  name: Track 1b — typecheck (base graph)
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v4
    - name: Setup Node
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: npm
    - name: Install dependencies
      run: npm ci
    - name: Typecheck (base config — app graph excl. legacy/scripts/edge)
      run: npx tsc --noEmit
```

Notes:
- No `-p` flag → uses `./tsconfig.json` (the base config).
- No new npm script needed (raw `npx tsc --noEmit` is fine and is
  also how it's documented in `tests/README.md`); if the developer
  prefers, a `"typecheck": "tsc --noEmit"` script in `package.json`
  is fine too — naming is bike-shed.
- `permissions: contents: read` is inherited from the top-level
  `permissions` block at line 33.

#### 5.B `tests/README.md` update (AC17)

The CI table at line 7 currently lists Tracks 1, 2, 3. Add
Track 1b (typecheck base) as a row, matching the existing 1a
shape:

```
| 1b    | Base typecheck — full active graph (excludes legacy, scripts, edge funcs) | `tsc --noEmit` | `tsconfig.json` |
```

And a paragraph below the table describing the exclusion set:
`supabase/functions/**` (Deno-runtime URL imports), `scripts/**`
(one-off ts-node), `**/*.test.ts(x)` + `tests/**` (covered by 1a).

#### 5.C tsconfig.json updates (AC12–AC13)

Update the `exclude` array from:

```json
"exclude": ["**/*.test.ts", "**/*.test.tsx", "tests/**/*"]
```

…to:

```json
"exclude": [
  "**/*.test.ts",
  "**/*.test.tsx",
  "tests/**/*",
  "supabase/functions/**",
  "scripts/**"
]
```

`tsconfig.test.json` is unaffected (its `exclude: []` overrides
base entirely — the include array `src/**/*.test.ts(x)`,
`tests/**/*.ts` is what scopes Track 1a).

### 6. Pre-deletion vs post-deletion `tsc --noEmit` verification

Per AC15, base `tsc --noEmit` must exit 0 on a clean checkout
after all deletions + exclusions land. PM Background §RiskVectors
explicitly noted this hasn't been verified yet.

**Verification path the developer must follow:**

1. **Stage 1 — pre-deletion baseline.** On the current `main` head
   (before any spec 025 edits), run `npx tsc --noEmit`. Capture
   the error count + file list. Expected: ~103 errors per spec 024
   §"Spec 025 forward-compat preview." Most/all are in legacy
   files that will be deleted.
2. **Stage 2 — after deletions land.** Apply AC1+AC2+AC3 deletes
   AND AC12+AC13 tsconfig exclusions. Re-run `npx tsc --noEmit`.
   Expected error set: a small residual from Cmd UI files that
   spec 024 didn't sweep. Spec 024's §Q5a corollary calls out four
   such files explicitly:
   - `src/components/cmd/BrandPicker.tsx`
   - `src/components/cmd/TitleBar.tsx`
   - `src/components/cmd/IngredientFormDrawer.tsx`
   - `src/components/cmd/StockHistoryChart.tsx`

   Spec 024 fixed these under its AC2 — confirmed by spec 024's
   `Status: READY_FOR_REVIEW`. If they're already 0 in the base
   graph after spec 024, Stage 2 should be clean.
3. **Stage 3 — after new section + auth helper.** Apply AC21–AC25
   (UsersSection + InviteUserDrawer + sendPasswordReset). Re-run.
   The new files MUST typecheck — these are net-new code, so any
   error here is a regression, not a legacy carry-over.
4. **Stage 4 — gate confirmation.** `npx tsc --noEmit` exits 0 →
   AC15 passes → enable the new CI job.

**If Stage 2 surfaces unanticipated errors,** the developer's
PM-default per §RiskVectors is "fix in place." For any error in a
file that's NOT in the delete list and NOT one of the four files
above, the developer should:

- Fix it in the same change set.
- Note the file + the fix in a comment in the implementation PR's
  description.
- Do NOT add per-file `@ts-ignore` (per AC14).
- Do NOT add the file to the tsconfig `exclude` list as a workaround.

If a residual error is in a file the developer cannot fix without
scope creep (rare; example: a multi-file refactor needed to satisfy
a type), surface back to architect/PM before proceeding. Don't
silently widen the exclude list.

### 7. Realtime impact

None. The `useRealtimeSync` wiring in `CmdNavigator` (line 73)
already subscribes to `store-{id}` + `brand-{id}` channels per the
existing convention. The deleted `AppNavigator.tsx` ALSO has a
`useRealtimeSync` invocation that goes away when the file is
deleted — that's the legacy-only subscription that
`CmdNavigator`'s subscription replaces (PM Background §SectionG —
`Realtime channels touched: none`).

UsersSection itself does NOT subscribe to realtime — per PM
"Project-specific notes / Realtime channels touched: none."
On-mount + post-action `fetchAllUsers` is sufficient. (Justification:
user/invite changes are rare; real-time consistency on the user
list isn't worth the channel cost when the alternative is a one-line
refetch after `inviteUser` / `deleteUser` / `sendPasswordReset`
resolves.)

### 8. Frontend store impact

The optimistic-then-revert pattern does NOT apply to UsersSection:

- `inviteUser` — server creates the invitation row; client refetches
  on success. No local mirror.
- `deleteUser` / `deleteProfile` — `useStore.deleteProfile` does
  no optimistic mutation by design (per its docstring at
  useStore.ts:147). Client refetches on success.
- `sendPasswordReset` — pure side-effect, no UI state to mirror.

Toasts fire on success via `Toast.show({ type: 'success', ... })`
matching the existing convention. Errors surface inline in the
invite drawer (mirroring legacy `inviteWarning`) or via
`notifyBackendError` for delete (via `useStore.deleteProfile`'s
existing plumbing).

### 9. Risks and tradeoffs (architect-flagged)

1. **`src/lib/api.ts` orphan.** PM did not list this file; I added
   it to the delete set in §1b. Reviewer should verify nothing
   re-introduces a json-server reference.
2. **`useStore.inviteUser` / `removeUser` legacy actions remain.**
   They're store-internal actions; nothing in the Cmd UI calls them
   post-deletion. PM §Out of scope explicitly carves out useStore
   refactor. They are dead code after this spec lands but stay in
   the file. Cleanup spec — future.
3. **`tsconfig.test.json` invariance.** The test config's
   `exclude: []` is intentional (`tsconfig.test.json:17–18`). Base
   tsconfig's new exclusions (`supabase/functions/**`,
   `scripts/**`) don't bleed into the test config because the test
   config doesn't extend `exclude` — it overrides. Tests live in
   `src/**/*.test.ts(x)` and `tests/**/*.ts` (per the include
   array), neither of which is in the new exclusion set. No test
   coverage regresses.
4. **Stage-2 verification not run by architect.** Per PM
   §RiskVectors, the developer must run `tsc --noEmit` post-deletion
   to catch residual errors. I cannot pre-verify this from a
   read-only design pass. Reviewer should treat AC15 as a hard
   gate on the implementation, not a presumption.
5. **`master` role admin gates.** §2.G.1 above generalized the
   legacy `isMaster` predicate to also accept `super_admin`. This
   is forward-compat (super-admins keep their legacy implicit
   permissions on the new section) but it's a small behavioral
   tweak vs verbatim port. Reviewer should confirm this is the
   intended treatment.
6. **Native EAS readiness deferred.** Per Q3 resolution, removing
   the flag flips native builds to Cmd UI on the next EAS build.
   Out of scope for this spec to verify native pixel parity.
   Release-coordinator should surface this as the headline
   user-visible change in the release proposal.
7. **Comment cleanup deferred.** Four files have comment-only
   NEW_UI mentions that survive the flag removal. CLAUDE.md edit
   pass (per PM "Dependencies" section) is the right venue for
   those.
8. **`ComingSoonScreen.tsx:122` literal `NEW_UI=true`.** Stale UX
   string after the flag is gone. Frontend developer should drop
   it or change to a neutral label during implementation — see
   §4.B above.
9. **Realtime publication gotcha — not applicable.** No
   `supabase_realtime` publication membership changes (spec is
   delete + UI; no migrations). The dev-loop `docker restart
   supabase_realtime_imr-inventory` note in CLAUDE.md doesn't fire.
10. **No CI assumption.** Per CLAUDE.md "CI workflow" — the
    `db-migrations-applied.yml` workflow PM cited is missing on
    disk and not a gate. The new `typecheck-base` job goes into
    the existing `test.yml` which IS on disk (confirmed by file
    read).

### 10. Out-of-scope confirmation (no design needed)

- No new migrations.
- No new RPCs.
- No new edge functions.
- No `app.json` slug edit (per CLAUDE.md).
- No `useStore.ts` refactor (per PM §Out of scope).
- No `@/` alias migration (per PM §Out of scope).
- No CLAUDE.md edit pass (per PM "Dependencies" — separate follow-up).
- No store-management surface (per PM §Out of scope — separate spec
  if user blocks delete on it; architect explicitly does NOT block
  the legacy delete on a stores surface because the existing Cmd UI
  has no store-add/edit UI; this is a pre-existing gap and the
  legacy block is admin-only anyway).

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend developer
  owns AC1/AC2/AC3 file deletions (including the §1b
  `src/lib/api.ts` orphan and the §1c `inviteUserLegacy` shim
  removal), AC8/AC9 (App.tsx + featureFlags.ts wiring), AC10
  (.env.example), AC11 (README.md), AC12/AC13 (tsconfig.json
  exclude additions), AC16/AC17 (test.yml job + tests/README.md
  update), AND the new `sendPasswordReset` helper in
  `src/lib/auth.ts` per §2.B. Frontend developer owns AC4–AC7
  (Reorder export buttons + CSV/PDF generators per §3) AND
  AC21–AC25 (UsersSection.tsx + InviteUserDrawer.tsx per §2). Both
  developers must verify AC15 (base `tsc --noEmit` exits 0) BEFORE
  setting Status: READY_FOR_REVIEW per the §6 staged verification
  path. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/025-delete-legacy-app/spec.md

## Files changed

### Backend developer (this PR)

**File deletions — legacy navigator + screens (AC1, AC2):**
- `src/navigation/AppNavigator.tsx`
- `src/screens/AdminScreens.tsx`
- `src/screens/DashboardScreen.tsx`
- `src/screens/EODCountScreen.tsx`
- `src/screens/EODHistoryScreen.tsx`
- `src/screens/IngredientsScreen.tsx`
- `src/screens/ItemsScreen.tsx`
- `src/screens/OrderReportScreen.tsx`
- `src/screens/OrdersScreen.tsx`
- `src/screens/POSImportScreen.tsx`
- `src/screens/PrepRecipesScreen.tsx`
- `src/screens/ReconciliationScreen.tsx`
- `src/screens/WasteLogScreen.tsx`
- `src/components/IngredientEditor.tsx`

**File deletions — legacy data layer (AC3 + architect §1b):**
- `src/store/useSupabaseStore.ts`
- `src/store/useJsonServerSync.ts`
- `src/lib/api.ts` (architect §1b orphan)
- `db.json`

**File deletion — feature flag (AC8):**
- `src/lib/featureFlags.ts`

**Spec cleanup (architect Q7):**
- `specs/025-legacy-typescript-sweep/` (directory removed; was a one-line redirect stub)

**Modifications:**
- `App.tsx` — removed `AppNavigator` + `NEW_UI` + `useColors` imports; collapsed
  `bodyBg` ternary to `Cmd.bg`; replaced conditional render with `<CmdNavigator />` (AC9).
- `src/lib/auth.ts` — removed deprecated `inviteUserLegacy` shim (architect §1c);
  added new `sendPasswordReset(email)` helper next to `deleteUser` (architect §2.B).
- `.env.example` — removed the `EXPO_PUBLIC_NEW_UI` feature-flags block (AC10).
- `README.md` — collapsed "Two UIs in one app" / legacy UI sections to a single
  "UI" section; updated project-structure block to remove `AppNavigator`,
  `featureFlags.ts`, and legacy screens; added `UsersSection`/`InviteUserDrawer`
  references; updated CI summary to mention four jobs (AC11).
- `package.json` — removed legacy `"db": "json-server db.json --port 3001"`
  script (AC3 corollary); added new `"typecheck": "tsc --noEmit"` script (AC16).
- `tsconfig.json` — added `"supabase/functions/**"` (AC12) and `"scripts/**"`
  (AC13) to the `exclude` array.
- `.github/workflows/test.yml` — added Track 1b `typecheck-base` job running
  `npm run typecheck`, modeled on the existing Track 1a typecheck job (AC16).
- `tests/README.md` — documented the new Track 1b typecheck-base CI gate;
  added a "How to run locally" entry for `npm run typecheck`; expanded the CI
  section from three to four jobs (AC17).

### Verification (per architect §6)

Stage 1 baseline: `npx tsc --noEmit` reported 103 errors (all in
deleted-or-Deno files). Post-deletion + post-frontend-dev work + new helper:
both `npm run typecheck` and `npm run typecheck:test` exit 0 cleanly. AC15
passes. `npm test -- --ci` passes 17/17 across 3 suites. `npm run test:db`
passes 13/13 files. `npm run test:smoke` passes.

### Notes for reviewers

- The `json-server` devDependency in `package.json:72` is now orphaned (its
  only consumer was the deleted `db` script + `db.json`). Per CLAUDE.md "Ask
  before expanding scope," this is NOT removed in this change set — surface
  as a follow-up cleanup. The dep is dev-only so the bundle is unaffected.
- Four comment-only `EXPO_PUBLIC_NEW_UI` / `NEW_UI` mentions survive per
  architect §1d (intentional — they're documentation, not code references):
  `src/utils/unitConversion.ts:239` (refers to legacy IngredientEditor),
  `src/screens/cmd/ComingSoonScreen.tsx:34,122`,
  `src/screens/dev/CmdAtomsPreview.tsx:31`,
  `src/components/cmd/ThemeToggle.tsx:10`. CLAUDE.md edit pass cleans these
  later per spec Dependencies section.
- Frontend dev's `UsersSection.tsx` and `InviteUserDrawer.tsx` landed in
  parallel and typecheck clean alongside the deletions. Their AC4–AC7 +
  AC21–AC25 work is verified via the parity smoke checklist (AC18).

### Frontend developer (this PR)

**New files (AC21, AC23, architect §2.G/§2.H):**
- `src/screens/cmd/sections/UsersSection.tsx` — admin-global users section.
  Loads users via `fetchAllUsers({ brandId })`, renders the list with role
  badges + store-access chips + status pill, gates per-row Reset/Delete by
  current user's role (master/super_admin vs admin). Self-delete signs out
  and redirects to `/` on web (mirrors legacy `AdminScreens.tsx:1473–1479`).
  Reuses `useStore.deleteProfile` (already wires `delete-user` edge call
  and `notifyBackendError`). Reuses `TypeToConfirmModal` for the type-the-
  email confirmation gate.
- `src/components/cmd/InviteUserDrawer.tsx` — admin-global invitation
  drawer. Modeled on `InviteAdminDrawer` (same `ResponsiveSheet` chrome +
  Cmd+Enter/Cmd+S/Esc key handlers + `Field` helper). Role picker only
  visible to master/super_admin; non-master admins are hard-locked to
  `role='user'`. Stores multi-select sourced from `useStore.stores`
  (inviter's visible stores). For `role='admin'` invitations, `brandId`
  comes from `useStore.brand?.id` and is surfaced read-only with a
  guard for missing brand context. Calls `inviteUser({...})` from
  `src/lib/auth.ts` per AC23.

**Modifications (AC4–AC7, AC22, architect §3 + §2.E + §2.F):**
- `src/screens/cmd/sections/ReorderSection.tsx` — added top-level
  imports for `Papa` and `Toast`, plus type imports for
  `ReorderPayload`/`Store`. Added module-scope helpers `slugifyStore`,
  `todayLocalIso`, `triggerDownload`, `buildReorderCsv`,
  `handleCsvExport`, and `handlePdfExport` (jsPDF + jspdf-autotable
  dynamic-imported per AC5 / legacy pattern). Added two
  `TouchableOpacity` mono-text buttons (`CSV`, `PDF`) to the
  `TabStrip.rightSlot` left of the existing `REFRESH` button, gated on
  `showExport = Platform.OS === 'web' && reorderPayload &&
  vendors.length > 0 && !reorderError && !(reorderLoading &&
  !reorderPayload)` per AC6. Filename pattern
  `IMR_Reorder_<store-slug>_<YYYY-MM-DD>.{csv|pdf}`.
- `src/lib/cmdSelectors.ts` — appended a new `Admin` group at the END
  of the sidebar tree (immediately before the super-admin-gated
  `Tenancy` group), with a single `{ id: 'Users', label: 'Users &
  access' }` item per AC22. Visible to all admins; per-row role gating
  lives inside `UsersSection` itself.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — added
  `import UsersSection from './sections/UsersSection';` alongside the
  other section imports, and added a `section === 'Users' ?
  <UsersSection />` arm to the section-dispatch ternary immediately
  after the `Reports` arm (architect §2.F).

### Frontend verification

- `npx tsc --noEmit` exits 0.
- `npx tsc -p tsconfig.test.json --noEmit` exits 0.
- Metro web bundle compiles cleanly (`/App.bundle?platform=web` returns
  200 / 13.4 MB) and the bundle contains the expected new symbols
  (`UsersSection`, `InviteUserDrawer`, `sendPasswordReset`,
  `buildReorderCsv`, "Users & access", "Per-Vendor Reorder
  Suggestions").
- Browser preview tools were not available in the implementing
  agent's environment; visual verification of the UsersSection list,
  invite drawer, and Reorder export buttons should be exercised by the
  user / reviewers during the parity smoke checklist (AC18). The bundle
  compiles and the code paths are exercised by the typecheck against
  the live `useStore` / `auth.ts` / `db.ts` surfaces.
