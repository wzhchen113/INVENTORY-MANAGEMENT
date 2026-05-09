# Test engineer findings — Spec 012b

## Acceptance criteria coverage

| # | AC text | Status | Citation |
|---|---------|--------|----------|
| **Visibility gating** | | | |
| V1 | "Brands" sidebar item appears **only** when `profiles.role = 'super_admin'` | PASS (static) | `cmdSelectors.ts:1070-1077` — `useDefaultSidebarGroups()` appends the "Tenancy"/"Brands" item only when `useIsSuperAdmin() === true`, which reads `currentUser?.role === 'super_admin'` from the store. |
| V2 | Non-super-admin user sees no "Brands" item at any breakpoint (desktop Sidebar, tablet RailSidebar, phone MobileNavDrawer) | PASS (static) | Same gate — all three breakpoints consume the single `groupsForSidebar` array from `useDefaultSidebarGroups()` via `ResponsiveCmdShell.tsx:115`. Non-super-admin `isSuperAdmin=false` → item is not in the array → `applySidebarOverride` has nothing to drop. **Live probe: NOT RUN** (browser tools unavailable to developer; main Claude probe walk pending). |
| V3 | "Brands" item is NOT draggable/hideable for non-super-admins (override merge has nothing to operate on); IS subject to Spec 008 customization for super-admins | PASS (static) | `sidebarLayout.ts` `applySidebarOverride` silently drops override entries whose id is not in defaults — confirmed in `ResponsiveCmdShell.tsx:137-143`. Super-admin path: item is in defaults; override merge works normally. |
| **Brand picker (header)** | | | |
| P1 | Brand picker renders in header **only** for super-admin; brand-admins see no picker | PASS (static) | `ResponsiveCmdShell.tsx:82-83` — `brandPickerSlot = isSuperAdmin ? <BrandPicker /> : null`, passed to `TitleBar` (desktop+tablet) and `MobileTopAppBar.trailing` (phone). `BrandPicker.tsx:55` has an additional `if (!isSuperAdmin) return null` guard. **Live probe: NOT RUN.** |
| P2 | Picker lists every brand with `deleted_at IS NULL`, plus "All brands" sentinel | PASS (static) | `fetchBrandsLite` in `db.ts:1583-1585` filters `is('deleted_at', null)` by default. `BrandPicker.tsx:121` prepends `{ id: '__all__', name: 'All brands' }` as the first item. Desktop dropdown (`BrandPickerDropdownWeb`) likewise starts with the "All brands" `DropdownRow`. **Minor naming note:** the phone list uses the string `'__all__'` as an internal key (not an id written to the store; `handlePick` converts it to `null`). No collision risk. |
| P3 | Picking a brand switches active brand context: store picker filtered to that brand's stores; first matching store auto-selected; `loadFromSupabase(storeId)` runs; realtime `brand-{brandId}` channel resubscribes | PASS (static) | `useStore.setCurrentBrandId` (`useStore.ts:343-379`) — sets `currentBrandId`, finds first store via `stores.find(s => s.brandId === brandId)`, calls `setCurrentStore(newStore)` which calls `loadFromSupabase`. Realtime re-subscription is handled by `useRealtimeSync`'s existing `useEffect` deps on `brand?.id`, which updates after `loadFromSupabase` writes the `brand` slice. **Live probe: NOT RUN.** |
| P4 | Picked brand persists across session (browser tab); resets to "All brands" on next login. Key: `imr.cmd.superAdmin.activeBrand` | PASS (static) | `persistActiveBrandLocal` / `clearActiveBrandLocal` in `useStore.ts:55-75`. `login()` action calls `clearActiveBrandLocal()` at line 290. `App.tsx:175-196` reads the cached value BEFORE `login()` fires, then re-applies via `setCurrentBrandId(cachedActiveBrand)` for session-restore. Reset-on-login contract is satisfied. |
| **Brands section (super-admin only)** | | | |
| S1 | Selecting "Brands" renders `BrandsSection.tsx` listing all brands with: name, id (short), created_at, store count, catalog ingredient count, admin count | PARTIAL PASS (static) | `InventoryDesktopLayout.tsx:177-178` dispatches `<BrandsSection />` for `section === 'Brands'`. `BrandsSection.tsx` list pane renders name, short id, created_at, store count, admin count. **Gap: catalog ingredient count** is NOT shown in the list pane rows (lines 291-296 show `storeCount` and `memberCount` only; `catalogIngredients` count is absent). The spec says "catalog ingredient count" — `fetchBrandsWithStats` does not return this field either (`db.ts:1603-1628` only has `storeCount` and `memberCount`). This is a spec deviation. |
| S2 | "+ NEW BRAND" button opens form; `db.createBrand(name)` INSERTs; optimistic-then-revert on failure; new brand appears in list + picker immediately | PASS (static) | `BrandFormDrawer.tsx` — opens on `newDrawerOpen=true`, calls `useStore.createBrand(name)`. Store action (`useStore.ts:391-414`) does optimistic insert, calls `db.createBrand`, swaps temp id for server UUID on success, reverts on failure via `notifyBackendError`. `brandsList` update causes picker to re-render immediately. |
| S3 | Selecting a brand row drills into detail view: brand metadata, store list (read-only), admin list (read-only) | PASS (static) | `BrandsSection.tsx:307-399` — `DetailPane` with `TabStrip` containing `profile.tsx` (brand metadata via `PropertiesJson`), `members.tsx` (admin list), `stores.tsx` (stores list). All read-only. |
| S4 | Brand-name editing is out of scope for 012b (known gap, acknowledged in UI) | PASS (static) | `BrandsSection.tsx:387-390` renders explicit "Note: brand renaming and soft-delete are out of scope for 012b." No edit affordance present. |
| **Admin listing** | | | |
| A1 | In brand detail view, admins list renders: name, email, role, status, store count | PASS (static) | `fetchBrandAdmins` in `db.ts:1666-1748` returns `User[]` with `name`, `email` (inferred from invitations by name-match), `role`, `status`, `stores[]`. `BrandsSection.tsx` `MembersTab` renders these fields (line 445-460+). |
| A2 | Read-only — no delete/suspend/role-change buttons | PASS (static) | `MembersTab` renders a read-only row per admin; only "+ INVITE ADMIN" button present; no destructive affordances. |
| **Admin invitation flow extended** | | | |
| I1 | `invitations` table gets `brand_id uuid references brands(id)` column (nullable, additive) | PASS (static) | `20260510000000_invitations_brand_id.sql:20-21` — `ALTER TABLE … ADD COLUMN IF NOT EXISTS brand_id uuid references public.brands(id) on delete cascade`. Applied locally per build notes. |
| I2 | `inviteUser()` extended to accept `brandId`; writes `brand_id` to the invitations row; pre-flight gate for `role='admin' && !brandId` | PASS (static) | `auth.ts:135-201` — `InviteUserOptions.brandId` added; pre-flight check at lines 156-158; INSERT includes `brand_id: opts.brandId` at line 184. |
| I3 | `registerInvitedUser()` writes `profiles.brand_id = invitation.brand_id` from `get_pending_invitation` return set (load-bearing 012a fix) | PASS (static) | `auth.ts:249-278` — defensive validation at lines 249-253 (catches legacy NULL invitations for admin role before auth.signUp creates orphaned user); profile INSERT at lines 270-278 includes `brand_id: invitation.brand_id ?? null`. `get_pending_invitation` now returns `brand_id` per migration §3. |
| I4 | "+ INVITE ADMIN" form: email, name, role (admin/user, not super_admin), brand (read-only, fixed to context brand), stores multi-select | PASS (static) | `InviteAdminDrawer.tsx` — Email field, Display name field, Role radio (admin/user only per line 251), Brand read-only display (lines 293-319), Stores multi-select checkboxes (lines 322-409). `'super_admin'` is not an option in the role selector. |
| I5 | Submit calls extended `inviteUser(email, name, role, brandId, storeIds)`; on failure `notifyBackendError` surfaces | PASS (static) | `InviteAdminDrawer.tsx:92-99` calls `inviteUser({...brandId...})`. On error, `Toast.show({ type: 'error' })` at lines 101-108. Note: the toast is surfaced directly via Toast, not via the `notifyBackendError` helper (which combines `console.warn` + Toast). This deviates from the spec's "notifyBackendError" wording but achieves the same user-visible effect. **Minor deviation.** |
| **Realtime** | | | |
| R1 | When super-admin switches brand, old `brand-{old}` channel dropped, new `brand-{new}` subscribed | PASS (static) | `useRealtimeSync.ts` hook is unchanged; its `useEffect` deps include `brandId` derived from `useStore((s) => s.brand?.id)`. After `setCurrentBrandId → setCurrentStore → loadFromSupabase` updates the `brand` slice, the hook's cleanup fires (drops old channel) and re-subscribes. **Live probe: NOT RUN.** |
| R2 | No new realtime publication membership changes; `brands` table not added to publication | PASS (static) | Migration has no `ALTER PUBLICATION` statement. `docker restart supabase_realtime_imr-inventory` ritual not needed. |
| **Responsive parity** | | | |
| RP1 | Brand picker renders in TitleBar (desktop+tablet) and MobileTopAppBar.trailing (phone); "Brands" item in Sidebar/RailSidebar/MobileNavDrawer | PASS (static) | All three paths wired in `ResponsiveCmdShell.tsx:82-83`. **Live probe at 6 widths: NOT RUN** (browser tools unavailable to developer; main Claude probe walk pending per dispatch note). |
| RP2 | `BrandsSection.tsx` renders correctly at all 3 widths (phone single-pane, tablet/desktop two-pane) | PASS (static) | `BrandsSection.tsx:122-159` — phone path (`isCompact && showDetail`) renders single `DetailPane` with back button; `isCompact` without `showDetail` renders `ListPane` only; desktop/tablet renders both side-by-side (lines 162-203). |
| RP3 | No `AdminScreens.tsx` edits beyond the single import rename | PASS (static) | `AdminScreens.tsx` only has the `inviteUserLegacy` dynamic import rename (line 1400). No logic change. Architect §4 specifically authorized this. |
| **Profile + types** | | | |
| T1 | `User.role` type includes `'super_admin'` | PASS (static) | `types/index.ts:3` — `UserRole = 'super_admin' | 'master' | 'admin' | 'user'`. |
| T2 | `User.brandId?: string | null` added; populated from `profile.brand_id` in `fetchProfile` | PASS (static) | `types/index.ts:29`; `auth.ts:93-94` — `brandId: profile.brand_id ?? null`. |
| T3 | `useIsSuperAdmin()` hook returns true iff `currentUser.role === 'super_admin'`; `useRole()` placeholder preserved | PASS (static) | `useRole.ts:22-25` — reads `useStore((s) => s.currentUser?.role)` and returns `role === 'super_admin'`. Existing `useRole()` returns `'admin'` unchanged. |
| T4 | Audit-site extensions: TitleBar.tsx:36 and useStore.ts:269 extended to include `'super_admin'` | PASS (static) | `TitleBar.tsx:41` — `isAdmin = ... || currentUser?.role === 'super_admin'`. `useStore.ts:329` — `user?.role === 'super_admin'` added to `__all__` fallback condition. |
| **RoleBadge** | | | |
| RB1 | `RoleBadge` accepts real `role` prop; super-admin renders distinctively (warn tone) | PASS (static) | `RoleBadge.tsx:12-65` — optional `role` prop, `labelFor` switch with all four roles, `isSuper` gates `C.warn` vs `C.accent` colors. `MobileNavDrawer.tsx:47,78` passes `currentUser?.role` to `<RoleBadge role={currentUserRole} />`. |

---

## Load-bearing 012a invite-bug fix verification

**Verdict: Fixed correctly.** The chain of evidence:

1. **Migration (`20260510000000_invitations_brand_id.sql`)** adds `brand_id uuid` to `public.invitations` and recreates `get_pending_invitation` to return `brand_id` in its result set. The `DROP FUNCTION IF EXISTS` + `CREATE FUNCTION` pattern correctly handles the Postgres restriction on changing return-column sets via `CREATE OR REPLACE`. The grant is re-issued post-create.

2. **`inviteUser(opts)` (`auth.ts:150-201`)** now accepts `InviteUserOptions.brandId` and writes `brand_id: opts.brandId` to the invitations INSERT. The pre-flight gate (`opts.role === 'admin' && !opts.brandId → return { error: '...' }`) prevents admin invitations from being created without a brand, which would otherwise create a row that `registerInvitedUser` cannot use.

3. **`registerInvitedUser` (`auth.ts:226-303`)** reads the new `brand_id` from the `get_pending_invitation` RPC response. A second pre-flight gate (`invitation.role === 'admin' && !invitation.brand_id`) fires BEFORE `auth.signUp`, preventing the creation of an orphaned `auth.users` row when a legacy NULL-brand invitation is attempted post-012b. The `profiles.insert` at line 270-278 then passes `brand_id: invitation.brand_id ?? null`.

4. **The `profiles_role_brand_consistent` CHECK constraint (012a migration, line 342-348)** requires `admin` profiles to have `brand_id IS NOT NULL`. With the new `registerInvitedUser`, the INSERT now satisfies this check for admin invitations. The `super_admin` branch of the CHECK (`role = 'super_admin' AND brand_id IS NULL`) is unaffected.

5. **`fetchProfile` (`auth.ts:79-104`)** populates `User.brandId` from `profile.brand_id ?? null`, so the newly registered admin's `brandId` is available to the session after first login.

**The latent 012a bug is genuinely fixed.** The invitations table gets `brand_id` populated at invite time, the RPC returns it at register time, and the profiles INSERT uses it.

**One residual concern (not a regression):** The `fetchAllUsers` function in `auth.ts:378` resolves email by matching `invitation.name === p.name` — a name-based lookup that is fragile if two admins share the same display name. This is a pre-existing issue not introduced by 012b. The `fetchBrandAdmins` in `db.ts:1712` uses the same approach. Not blocking, but worth noting.

---

## Pre-prod-push behavioral concerns

### 1. Migration idempotency

The migration `20260510000000_invitations_brand_id.sql` is safe to apply multiple times:
- `ADD COLUMN IF NOT EXISTS` — no-op if column already exists.
- `CREATE INDEX IF NOT EXISTS` — no-op if index already exists.
- `DROP FUNCTION IF EXISTS` + `CREATE FUNCTION` — idempotent sequence (drops the old shape, creates the new one). Re-applying creates a fresh copy of the same function.

**No data writes, no destructive operations.** Suitable for prod push.

One prod-push caveat: the `DROP FUNCTION` between the `DROP` and the `CREATE` creates a brief window where `get_pending_invitation` does not exist. Because the whole migration runs in a single transaction (no explicit `BEGIN/COMMIT` but Postgres wraps DDL in implicit transactions), the window is transaction-local and concurrent callers queue behind the lock. **This is correct behavior; no race condition on prod.**

### 2. Brand-switch refetch flicker

`setCurrentBrandId(brandId)` → `setCurrentStore(newStore)` → `loadFromSupabase(storeId)` is async. Per `useStore.ts:416-418`, `storeLoading: true` is set, then cleared after the fetch. The existing data slices (`recipes`, `inventory`, etc.) are **replaced in-place** with the new brand's data rather than zeroed first. This means:

- The screen briefly shows **the previous brand's data** until the fetch completes (typically 200-500ms on a healthy connection).
- There is no "loading" spinner per-section (the `storeLoading` flag is used by `CmdNavigator.tsx` for the initial load gate, not by each section individually).

**This is the documented behavior (§7 Risk 3) and was accepted by the spec.** It matches the existing store-switch behavior. No regression introduced — this is a known UX gap.

### 3. `currentBrandId = null` and sections requiring single-brand context

When super-admin picks "All brands", `setCurrentBrandId(null)`:
1. Clears `currentStore` to `{ id: '', brandId: '', name: '' }`.
2. Clears `brand` to `null`.
3. The `BrandPicker.handlePick(null)` dispatches `usePaletteAction.getState().request({ section: 'Brands', selectedName: null })`.
4. `ResponsiveCmdShell`'s `useEffect` on `pendingPaletteAction` (`line 211-215`) sets `section = 'Brands'`.

**Result:** the shell navigates to the Brands section. If the user is on Inventory at the moment they pick "All brands", the section switch fires asynchronously in the next render cycle. There is a **one-render window** where `section = 'Inventory'` but `currentStore.id = ''` — the Inventory list filter (`inventory.filter(i => i.storeId === '')`) returns an empty array, and the detail pane shows "select an item". This is a cosmetic flash (one frame at most), not a crash.

**More concerning:** the paletteAction-based section switch (`usePaletteAction.getState().request(...)`) is called from inside the BrandPicker's `handlePick`, which is itself called from a TouchableOpacity `onPress`. React batches the `setCurrentBrandId` store update and the paletteAction write into the same render cycle on web (React 19 automatic batching). The shell's `useEffect` then fires in the next microtask. **This should be safe, but is NOT verified by a live probe.**

There is **no "select a brand" prompt** shown if a super-admin somehow remains on a brand-requiring section with `currentBrandId = null`. The spec's Q-PM-3 default accepted this — "All brands" forces section to Brands — so the UI relies on the paletteAction redirect being reliable. If the redirect fails (e.g. paletteAction store is stale), the Inventory section would silently show an empty list. This is a low-probability edge case but worth documenting.

**Verdict:** Behavioral intent is correctly implemented; the paletteAction redirect is the single point of reliance and was not live-tested.

---

## Test framework gap

This is the fifth spec in a row (after 010, 011, 009, 012a) where no automated tests exist. The codebase still has no jest, vitest, or playwright configuration; the only automation is `scripts/test-unit-conversion.ts` (ts-node math check) and `scripts/smoke-edge.sh` (curl smoke). The spec's "Tests" section (line 221) explicitly states this is "strongly recommended but not a blocker" and proposes a `scripts/smoke-super-admin-ui.sh` or extension of `scripts/smoke-multi-brand.sh`.

Given the load-bearing nature of the 012a invite-bug fix in this spec — the next admin invite from prod would previously break a Postgres CHECK constraint — a regression smoke script covering `inviteUser({brandId})` and `registerInvitedUser` via a real local Supabase stack would provide meaningful protection. Recommend creating `scripts/smoke-012b-invite-flow.sh` as the next cleanup item. Not blocking this release.

---

## Recommended cleanup bundle

Items NOT already raised by code-reviewer or security-auditor:

1. **Catalog ingredient count missing from Brands list.** The spec's S1 AC explicitly lists "catalog ingredient count" as a Brands list column. The implementation only shows `storeCount` and `memberCount`. `fetchBrandsWithStats` and the list-pane row render do not include `catalogIngredients` count. This is a spec deviation — not a security issue, but an acceptance-criterion gap. Surface to PM: either add the column to `fetchBrandsWithStats` (a `LEFT JOIN catalog_ingredients ON brand_id` count) or acknowledge it as a deferred follow-up and drop it from S1.

2. **`inviteUser` failure path in `InviteAdminDrawer` uses `Toast.show` directly instead of `notifyBackendError`.** The spec says "On failure, `notifyBackendError` surfaces" (I5 AC). The implementation uses `Toast.show({ type: 'error', ... })` without the `console.warn`. The difference is a missing `console.warn` in the error path — the user sees the same error toast, but the warning is absent from the browser console. Minor deviation from the project convention.

3. **Email resolution via name-match in `fetchAllUsers` and `fetchBrandAdmins`.** Both functions resolve a profile's email by matching `invitation.name === p.name`. If two admins have the same display name, one will get the wrong email shown in the members list. Pre-existing issue, but 012b surfaces it more prominently in the Brands section's admin list. Recommend a follow-up: store email in `profiles.email` column (already in the struct) during `registerInvitedUser`.

4. **`fetchBrandAdmins` uses `inviteByName` map but overwrites on duplicate names.** `db.ts:1704-1705` — `for (const inv of invites) inviteByName.set(inv.name, inv)` — later invitations with the same name overwrite earlier ones. If two different pending invitations have the same name but different emails, one is silently dropped from the map. Same root cause as item 3.

5. **Session-restore reads `cachedActiveBrand` before `login()` clears it.** This is intentional and documented in the build notes — the read happens at `App.tsx:175` before `login()` at line ~190. The logic is correct, but the constant `ACTIVE_BRAND_KEY` is declared separately in both `App.tsx:34` and `useStore.ts:41`. If the key string ever diverges (e.g. a typo during a rename), session-restore silently fails to restore the brand. Recommend exporting the constant from `useStore.ts` and importing it in `App.tsx`.

6. **Live §6 probe walk was not performed by the developer or main Claude (probe-walk.md absent).** The developer explicitly flagged "cannot drive the browser" in build notes. Main Claude was dispatched to run the probe walk in parallel — the file `specs/012b-super-admin-ui/reviews/probe-walk.md` does not exist at review time. All responsive-parity ACs (RP1, RP2) are therefore static-analysis only, not live-verified. Flag this to the release-coordinator.

---

## Verdict

**AC gap (FAIL):** 1 criterion.
- **S1** — "catalog ingredient count" listed in the Brands section for each brand is absent from both `fetchBrandsWithStats` and the list-pane render. The spec text is explicit. This is a FAIL, not a NOT TESTED: the code can be read to confirm the omission.

**NOT TESTED (live):** 5 criteria.
- **V2** — brand-admin sees no "Brands" item at all 3 breakpoints (browser probe not run).
- **P1** — brand picker visible only for super-admin at all breakpoints (browser probe not run).
- **P3** — brand-switch refetches data + realtime channel re-subscribes (browser probe not run).
- **R1** — realtime channel drop + re-subscribe on brand switch (browser probe not run).
- **RP1** — brand picker in TitleBar (desktop+tablet) and MobileTopAppBar.trailing (phone) (browser probe not run).

**PASS (static analysis):** All remaining ACs.

**Critical for release-coordinator:** 1 FAIL (catalog ingredient count in Brands list), 5 NOT TESTED (browser probe walk pending). The probe-walk.md file was not present at review time. The FAIL is a spec-text deviation; the NOT TESTED items are live-verification gaps. The release-coordinator should require either (a) confirmation that the catalog count gap is an accepted deviation or (b) a fix before SHIP_READY, and should require the probe walk results before clearing the NOT TESTED items.

The load-bearing 012a invite-bug fix (`registerInvitedUser` + `inviteUser`) is correctly implemented and the migration is idempotent. The invitations RLS gap for pure `super_admin` JWT (no `admin` app_metadata claim) was surfaced by the developer and is a known pre-prod risk — the security-auditor should be the primary reviewer for that finding.
