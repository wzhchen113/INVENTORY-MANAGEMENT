## Test report for spec 025

### Acceptance criteria status

**File deletion group**

- AC1 — Legacy navigator gone (`AppNavigator.tsx` + inline components) → PASS — `src/navigation/AppNavigator.tsx` is deleted (git status `D`). No import of it survives in `src/` or `App.tsx`.
- AC2 — Legacy screen files gone (12 screens + `IngredientEditor.tsx`) → PASS — All 12 files at `src/screens/*` are deleted (`D` in git status). `src/components/IngredientEditor.tsx` is deleted. Only references remaining are code comments in `UsersSection.tsx` and `InviteUserDrawer.tsx` citing `AdminScreens.tsx` line numbers as historical annotation, not imports.
- AC3 — Legacy data layer gone (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `"db"` npm script) → PASS — All three files deleted, `"db"` script absent from `package.json` scripts. (Nit: the `json-server` package is still in `devDependencies` at line 72; AC3 only required removing the script, so this is not a failure.)

**CSV/PDF export group**

- AC4 — CSV export in `ReorderSection.tsx` with correct columns and filename pattern → PASS — `buildReorderCsv` produces exactly the 10-column set the spec mandates (`Vendor`, `Item Name`, `On Hand`, `Pending PO`, `Par Level`, `Suggested Qty`, `Unit`, `Est. Cost`, `Flags`, `EOD Counted At`) via `Papa.unparse(rows, { columns })`. Filename pattern `IMR_Reorder_<slugified-store>_<YYYY-MM-DD>.csv` matches spec. `asOfDate` used when present, `todayLocalIso()` fallback otherwise.
- AC5 — PDF export in `ReorderSection.tsx` with header, per-vendor tables, footer → PASS — `handlePdfExport` renders the `I.M.R / Per-Vendor Reorder Suggestions` header, store name, `asOfDate`, one `autoTable` per vendor (vendor sub-header + delivery line, columns `[Item, On Hand, Pending, Par, Suggested, Unit, Est. Cost]`), and a footer with total item count + total estimated cost. Dynamic import of `jspdf` + `jspdf-autotable` matches legacy pattern. Filename pattern correct.
- AC6 — Export buttons hidden when no data / loading / error → PASS — `showExport` guard: `Platform.OS === 'web' && !!reorderPayload && reorderPayload.vendors.length > 0 && !reorderError && !(reorderLoading && !reorderPayload)`. All three hide-cases are covered.
- AC7 — Export buttons styled to match Cmd UI, in `rightSlot` alongside `REFRESH` → PASS — Both buttons use `TouchableOpacity` + mono-text (`fontFamily: mono(500)`) with `borderColor: C.borderStrong` — exactly matching the `REFRESH` button. Both live inside the same `rightSlot` `View` as `REFRESH`.

**Users & Access group**

- AC21 — `UsersSection.tsx` exists, follows Cmd UI section pattern, wired into `InventoryDesktopLayout` → PASS — File at `src/screens/cmd/sections/UsersSection.tsx` is untracked new file. Imports `useCmdColors`, `TabStrip`, `StatusPill`, uses mono-text buttons. `InventoryDesktopLayout.tsx` line 46 imports it; line 184-185 dispatches `section === 'Users'`.
- AC22 — Sidebar entry `id: 'Users'`, `label: 'Users & access'` under new `Admin` group at end of tree before `Tenancy` → PASS — `cmdSelectors.ts` line 1080-1085 adds the `Admin` group with `{ id: 'Users', label: 'Users & access' }` after all existing groups and before the super-admin-gated `Tenancy` push.
- AC23 — Invite-user flow: name, email, role picker (master-only), store multi-select, `inviteUser()` options-object call, success toast, close + refresh → PASS (with one nit). `InviteUserDrawer.tsx` collects all required fields. Role picker is gated behind `{isMaster ? (...)  }` at line 253. Store multi-select via `toggleStore` / `storeIds` array. `inviteUser({ email, name, role, brandId, storeIds, storeNames })` called with options-object form. Error surfaced inline via toast. Success fires `onInvited?.()` then `onClose()` which triggers `refresh()` in `UsersSection`. Nit: success `text1` is `'Invitation sent'` — spec AC23 says `"Invitation sent!"` (with exclamation mark). Minor UX divergence only.
- AC24 — User list with role badge, store chips, status badge, delete button with correct gates and type-to-email confirm, self-delete logout → PASS — `UserRow` renders avatar, name, email, role badge via `roleLabel()`, store chips (admin/master see all stores; user sees assigned). `StatusPill` shows `ACTIVE` / `PENDING`. `canDelete` gate matches spec: master deletes anyone except self; non-master admin deletes `user` rows and self only. `TypeToConfirmModal` requires typing email/name. Self-delete path triggers `logout()` and `window.location.href = '/'` for web (lines 117-127).
- AC25 — Password reset trigger with correct visibility gates and toast → PASS (with one nit). `canResetPassword` gate: master resets anyone except self and other master/super_admin; non-master admin resets only `user`-role rows excluding self. `sendPasswordReset(email)` in `src/lib/auth.ts` calls `supabase.auth.resetPasswordForEmail(email)` client-side — no new edge function. Nit: success toast renders as `text1: 'Password reset email sent'` + `text2: u.email` (two-line toast). Spec AC25 says `"Password reset email sent to {email}"` — a single concatenated string in `text1`. Functionally identical to the user; the exact prose differs.

**Config and flag removal group**

- AC8 — `EXPO_PUBLIC_NEW_UI` / `featureFlags.ts` deleted → PASS — `src/lib/featureFlags.ts` is deleted (`DELETED` confirmed). No surviving import of `featureFlags` in `src/` or `App.tsx`.
- AC9 — `App.tsx` wiring simplified to bare `<CmdNavigator />` → PASS — `App.tsx` imports only `CmdNavigator` (line 14). No `AppNavigator` or `NEW_UI` imports. `bodyBg` ternary is gone (not visible in the first 50 lines read; confirmed by absence of `featureFlags` / `AppNavigator` grep hits in `App.tsx`).
- AC10 — `.env.example` cleaned of `EXPO_PUBLIC_NEW_UI` block → PASS — Confirmed by grep returning nothing and manual review of the full file. The feature-flags block (lines 29-34 of the old file) is absent.
- AC11 — `README.md` updated, legacy UI references removed → PASS — `grep` for `EXPO_PUBLIC_NEW_UI`, `AppNavigator`, `legacy UI`, `UI fork` all returned nothing. README line 32 now reads "Single-screen Cmd UI layout" without any legacy-navigator reference.

**tsconfig group**

- AC12 — `supabase/functions/**` in base tsconfig `exclude` → PASS — `tsconfig.json` `exclude` array contains `"supabase/functions/**"`.
- AC13 — `scripts/**` in base tsconfig `exclude` → PASS — `tsconfig.json` `exclude` array contains `"scripts/**"`.
- AC14 — No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` in new code → PASS — Grep across all new/modified spec 025 files (UsersSection, InviteUserDrawer, ReorderSection additions, auth.ts, cmdSelectors.ts, App.tsx, tsconfig.json) returned zero hits. Pre-existing uses in `BrandsSection.tsx` (2) and `InventoryCountSection.tsx` (1) are unchanged from before this spec.

**CI gate group**

- AC15 — Base `tsc --noEmit` exits 0 on clean checkout → PASS — Confirmed: `npx tsc --noEmit; echo "Exit: $?"` printed `Exit: 0`.
- AC16 — `typecheck-base` CI job added with correct config → PASS — Job exists in `.github/workflows/test.yml`. Config: `runs-on: ubuntu-latest`, `timeout-minutes: 10`, `node-version: '20'`, `cache: npm`, `npm ci`, `npm run typecheck`. Matches `typecheck` job configuration exactly. Spec requires all of these — all present.
- AC17 — `tests/README.md` updated with `typecheck-base` job description → PASS — `tests/README.md` documents Track 1b at lines 13-20 and 412-418, covering what it gates, what it excludes, and the npm script to run.

**Parity / behavior verification group**

- AC18 — Cmd UI parity smoke checklist (manual) → NOT TESTED (manual-only by spec design) — The checklist is reproduced below under "AC18 smoke checklist."
- AC19 — No behavior change for existing Cmd UI users → PASS (code review) — The only changes visible to existing Cmd UI users are the two new buttons in `ReorderSection` rightSlot and the new `Admin > Users & access` sidebar entry. No section was removed or renamed. No data-shape changes.
- AC20 — Users on legacy path switch to Cmd UI → PASS (code review) — `App.tsx` now unconditionally renders `<CmdNavigator />`. `EXPO_PUBLIC_NEW_UI` is gone. Any deployment of this code causes all users (web and native EAS) to render Cmd UI. Release-coordinator must call this out explicitly as the user-visible change for native EAS builds.

---

### Test run

```
npm test -- --ci

PASS component src/components/cmd/StatusPill.test.tsx
PASS unit src/utils/relativeTime.test.ts
PASS unit src/utils/seedVarianceDates.test.ts

Test Suites: 3 passed, 3 total
Tests:       17 passed, 17 total
Snapshots:   0 total
Time:        0.511 s, estimated 1 s
```

`npx tsc --noEmit` → exit 0 (confirmed).
`npm run typecheck:test` → exit 0 (confirmed per prompt).
`npm run test:db` → 13/13 (confirmed per prompt).
`npm run test:smoke` → passes (confirmed per prompt).

---

### Notes

#### Coverage gaps introduced by this spec — not AC failures, but should-fix

**Should-fix 1 — `UsersSection` has no jest test despite security-relevant gating logic.**

`canDelete` and `canResetPassword` are computed per-row logic with 6+ distinct gate cases (master vs non-master, self vs other, role classifications). These are security-surface rules; a mistaken `||` vs `&&` is exactly the kind of bug a unit test on the pure helper would catch instantly. The spec explicitly waived net-new jest tests ("PM judgment: no new jest tests required; test-engineer reviews at PR time and flags if any are needed"). I'm flagging as Should-fix because:

- Both `canDelete` and `canResetPassword` can be extracted into pure functions taking `(isMaster, isSelf, targetRole)` — zero store dependency, trivially unit-testable in the `node` jest environment.
- No component render needed; the `tests/README.md` "prefer extracting testable logic" guidance (option 1) applies perfectly here.
- The delete-self-then-sign-out path is also a candidate, though that's more of a component integration test.

Concrete shape: add `src/screens/cmd/sections/UsersSection.test.ts` (unit project, not component), export `canDeleteUser(isMaster, isSelf, targetRole)` and `canResetPassword(isMaster, isSelf, targetRole)` as named helpers, test each gate.

**Should-fix 2 — `sendPasswordReset` in `auth.ts` has no test.**

It's a 7-line wrapper around `supabase.auth.resetPasswordForEmail`. The function is new behavior (legacy `UsersScreen` never surfaced password reset). A unit test mocking `src/lib/supabase.ts` at the module level — which `tests/README.md` explicitly disallows — would be wrong, but a test mocking the `supabase` client at the `auth.ts` boundary is exactly what the Track 1 unit project is for. Alternatively, the `smoke-rpc.sh` pattern (a shell probe that calls the local Supabase auth API) would satisfy Track 3. Either approach is cheap given the function is 7 lines.

**Nit 1 — `json-server` package still in `devDependencies`.**

AC3 removes the `"db"` script and `db.json`; the `json-server` npm package (line 72 of `package.json`) is now unreferenced by anything. Not an AC failure, but it should be removed in a follow-up or this PR to avoid confusing future contributors.

**Nit 2 — Toast text diverges from spec.**

- AC23 specifies `"Invitation sent!"` (with `!`). Implementation: `text1: 'Invitation sent'` (no `!`).
- AC25 specifies `"Password reset email sent to {email}"` (single string). Implementation: `text1: 'Password reset email sent'` + `text2: u.email` (two-line toast). The information is present; the presentation differs from the spec's prescribed prose.

Both are cosmetic. The release-coordinator can waive or require a fix at their discretion.

**Nit 3 — Button label `"CSV"` / `"PDF"` vs spec `"Download CSV"` / `"Download PDF"`.**

AC4/AC5 reference a `"Download CSV"` button and `"Download PDF"` button. The visible button text is just `CSV` and `PDF`; the `accessibilityLabel` says `"Export CSV"` / `"Export PDF"`. The compact label is consistent with Cmd UI's mono-text aesthetic and the REFRESH button style. Functionally equivalent. Waivable.

#### AC18 — Manual smoke checklist

The following table maps each legacy entry point to its Cmd UI equivalent. User or release-coordinator should tick each on a local `npm run web` build:

| Legacy entry point | Cmd UI section | Check |
|---|---|---|
| Dashboard tab | `DashboardSection` (sidebar: Dashboard) | |
| Recipes tab (`RecipesScreen`) | `RecipesSection` (sidebar: Menu Items / BOM) | |
| Items tab (`ItemsScreen`) | Inventory catalog mode (sidebar: Inventory) | |
| EODCount tab | `EODCountSection` (sidebar: EOD Count) | |
| Orders tab (`OrdersScreen`) | `POsSection` (sidebar: POs) | |
| More → Waste Log | `WasteLogSection` (sidebar: Waste Log) | |
| More → Ingredients | Inline in `RecipesSection` / `PrepRecipesSection` (soft-parity, accepted) | |
| More → Prep Recipes | `PrepRecipesSection` | |
| More → Suggested Orders | `ReorderSection` — CSV button downloads, PDF button downloads | |
| More → EOD History | `EODCountSection` → history tab (soft-parity, accepted) | |
| More → Vendors | `VendorsSection` | |
| More → POS Import | `POSImportsSection` | |
| More → Reconciliation | `ReconciliationSection` | |
| More → Reports & Analytics | `ReportsSection` | |
| More → Audit Log | `AuditLogSection` | |
| More → Users & Access | `UsersSection` (Admin > Users & access) — invite, list, delete, reset-pw | |
| More → DB Inspector | `DBInspectorScreen` (sidebar: DB inspector) | |
| Login / Register | Shared `LoginScreen` / `RegisterScreen` | |
| Master → Users & Access | `UsersSection` — master role picker visible in invite drawer | |

Additional checks specific to new behavior:
- Invite user as non-master admin: role picker should be hidden; role defaults to `user`
- Invite user as master: role picker shows `admin` / `user` options
- Delete a `user`-role row as non-master admin: DELETE button visible, type-to-email gate required
- Attempt to delete an `admin`-role row as non-master admin: DELETE button should be absent
- Send password reset as master: RESET PW button visible on non-master rows; absent on own row and other master/super_admin rows
- Self-delete: deleting own account should sign out and redirect to `/`
- CSV download: click CSV button, verify downloaded file has correct headers and at least one row
- PDF download: click PDF button, verify downloaded file opens and shows store name + vendor tables
- Verify export buttons are absent when reorder list is empty or errored

#### Native EAS build note

AC20 makes this a breaking change for any native EAS builds — next build will switch from `AppNavigator` to `CmdNavigator`. The spec explicitly scopes out native rendering validation. The release-coordinator should flag whether a TestFlight beta pass is required before shipping the native build.
