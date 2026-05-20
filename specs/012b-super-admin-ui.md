# Spec 012b: Super-admin Cmd UI section + brand picker + admin invitation flow

Status: SHIP_READY

> **Closeout (2026-05-20):** Shipped in commit `87e1edc` (2026-05-09). Release-proposal verdict was FIXES_NEEDED with a 16-item cleanup bundle (2 Criticals + 1 AC FAIL + 6 should-fix + 7 nits) that landed inside the same commit — verified in code: C1 `fetchAllUsers` sub-queries moved into `src/lib/db.ts` (helpers at lines 67, 78); C2 `BrandsSection` direct db.ts calls routed via `useStore.loadBrandStats`/`loadBrandAdmins` (`src/store/useStore.ts:683, 696`); S1 `catalogIngredientCount` populated in `mapBrandStats` (`src/lib/db.ts:2510`) and rendered at `BrandsSection.tsx:508/595/623`. Status field was never bumped at the time. OOS follow-ups: W-1/W-2 invitations RLS closed by `20260514150000_invitations_super_admin_rls.sql`; `inviteUserLegacy` shim deleted (spec 025); test framework gap closed by specs 022/023/033.

**Type:** Frontend (Cmd UI). One small backend extension for the invitation
table (add `brand_id`). No new RPCs unless the architect's design calls for
them; the architect decides whether to wrap brand-create + admin-invite in
RPCs or do them as direct PostgREST writes guarded by 012a's RLS.

**Sub-spec of:** [Spec 012 — Multi-brand tenancy umbrella](012-multi-brand-tenancy.md).
**Predecessor:** [Spec 012a — Schema + RLS + migration](012a-multi-brand-schema-rls.md) — SHIPPED to prod (commit `9bdb1b3`, 2026-05-09). Establishes the security boundary this UI builds against.
**Successor:** 012c — Brand soft-delete / hard-delete / restore UX.

---

## User story

As the platform owner (super-admin `wzhchen113@gmail.com`), I want a
visible Cmd UI surface to:

1. **List the brands** I own across the multi-brand database (today: just
   2AM PROJECT; tomorrow: Baltimore Seafood and beyond).
2. **Create a new brand** in-app, without dropping into the Supabase SQL
   editor, so I can onboard a second tenant on a Saturday afternoon.
3. **Switch which brand's data the rest of the admin UI shows** via a
   header brand-picker, so I can debug or operate inside any brand without
   re-logging in.
4. **Invite a new brand-admin** with brand + initial-store-set assignment
   in one form, instead of running SQL to set `profiles.brand_id` and
   `user_stores` rows after the invitee registers.
5. **List the existing admins per brand** (read-only — destructive admin
   management is out of scope for 012b) so I can see who has access to
   which brand and which stores.

As a brand-admin (e.g. Bobby on 2AM PROJECT), I want **no chrome change**
— I should never see the Brands sidebar item, never see the brand picker,
and continue working exactly as I do today. My brand is implicit.

---

## Acceptance criteria

### Visibility gating
- [ ] A new sidebar item "Brands" (or whatever name the user picks — see
  Q-USER-12b-3 below; default "Brands") appears in the Cmd UI sidebar
  **only** when the current user's `profiles.role = 'super_admin'`.
- [ ] A non-super-admin user (admin or user) sees no "Brands" item in
  the sidebar at any breakpoint (desktop Sidebar, tablet Sidebar /
  RailSidebar, phone MobileNavDrawer). Verified by setting Bobby's
  account in local dev to `role = 'admin'` and confirming the item is
  absent at all 3 widths.
- [ ] The "Brands" item cannot be dragged or hidden by the Spec 008
  override merge for non-super-admins (it isn't even in their default
  groups, so the override has nothing to operate on). For super-admins,
  the item IS subject to Spec 008 customization (they can re-order or
  hide it like any other section).

### Brand picker (header)
- [ ] A brand picker control renders in the header chrome **only** for
  super-admin. Placement: in the `TitleBar` (desktop + tablet) replacing
  or sitting next to the existing `storeName` slot; in the
  `MobileTopAppBar` trailing slot (phone). Brand-admins see no picker.
- [ ] The picker lists every brand where `deleted_at IS NULL`, plus an
  "All brands" sentinel that returns the super-admin to the Brands
  section view (no per-brand store data is loaded for "All brands" —
  see Q-USER-12b-4 below; default behavior: "All brands" forces section
  to "Brands" and clears the active store).
- [ ] Picking a brand switches the active brand context: the store
  picker's options are filtered to that brand's stores; the first
  matching store is auto-selected; `loadFromSupabase(storeId)` runs;
  the realtime `brand-{brandId}` channel resubscribes.
- [ ] The picked brand persists across the session (browser tab) but
  resets to "All brands" on next login. Persistence mechanism: same as
  `darkMode` — `localStorage` for web, `AsyncStorage` for native, key
  `imr.cmd.superAdmin.activeBrand`. Surface as Q-USER-12b-5 if the user
  prefers DB-backed persistence on `profiles`.

### Brands section (super-admin only)
- [ ] Selecting "Brands" from the sidebar renders a new section in the
  body area (`src/screens/cmd/sections/BrandsSection.tsx`) listing all
  brands with: `name`, `id` (short form), `created_at`, store count,
  catalog ingredient count, admin count.
- [ ] Section has a **"+ NEW BRAND"** button that opens a form to create
  a new brand: `name` (required, unique), nothing else for v1. On
  submit, calls `db.createBrand(name)` (new) which INSERTs into
  `brands`. Optimistic-then-revert on failure via `notifyBackendError`.
  The new brand appears in the list immediately and in the brand
  picker.
- [ ] Selecting a brand row drills into a detail view showing: brand
  metadata (name, id, created_at), the brand's store list (read-only —
  store CRUD already exists in the rest of the admin UI scoped per
  brand once the picker is set), and the brand's admin list
  (read-only).
- [ ] Brand-name editing is **out of scope for 012b** (super-admin can
  rename via the Supabase SQL editor for now; UI rename is a follow-up).
  Surfaced as a known gap so the user can override.

### Admin listing
- [ ] In the brand detail view, a list of admins for that brand renders
  with: `name`, `email` (resolved from auth.users via the existing
  `fetchAllUsers()` invitations-fallback path, or via a new RPC that
  reads auth.users — architect decides), `role`, `status`, store count
  (count of `user_stores` rows for that admin scoped to brand stores).
- [ ] Read-only — no delete / suspend / role-change buttons in 012b.
  These ship in 012c (or a follow-up) so 012b stays a pure additive
  surface.

### Admin invitation flow extended
- [ ] **Backend: `invitations` table gets a `brand_id uuid references brands(id)` column** (nullable for back-compat with existing rows; new migration). Comment: required when role = 'admin' going forward.
- [ ] `inviteUser()` in `src/lib/auth.ts` extended to accept a `brandId` parameter. When the inviter is super-admin, the form gates a brand picker. When the inviter is a brand-admin (currently no UI path, but future-proofing), `brandId` is forced to the inviter's `profiles.brand_id`. The new column is INSERTed as part of the invitations row.
- [ ] `registerInvitedUser()` in `src/lib/auth.ts` extended to set `profiles.brand_id = invitation.brand_id` on the new profile row. This is the **fix for the latent bug** introduced by 012a's `profiles_role_brand_consistent` CHECK — today's `inviteUser` would create an admin profile with NULL `brand_id`, which now fails the CHECK and breaks registration. **This is load-bearing — the next admin invite from prod already breaks without it.**
- [ ] A new admin-management UI form ("+ INVITE ADMIN") lives in the brand detail view. Fields: email (required), name (required), role (select between `'admin'` and `'user'` — `'super_admin'` is not invitable per umbrella spec Q2), brand (super-admin: picker, defaults to the brand whose detail view this is; brand-admin: forced + read-only), initial store set (multi-select checkboxes against the chosen brand's stores).
- [ ] Submitting the form calls the extended `inviteUser(email, name, role, brandId, storeIds)`. On success, the invitee gets the email via the existing `send-invite-email` edge function (no edge-function change needed — the existing payload doesn't include brand). On failure, `notifyBackendError` surfaces.

### Realtime
- [ ] The existing `useRealtimeSync(storeId, onSync, brandId)` hook subscribes to `brand-{brandId}`. When super-admin switches the active brand, the call site (`AuthedRoot` in `CmdNavigator.tsx`) must re-subscribe to the new brand's channel. The existing hook already does this (its `useEffect` deps include `brandId`), so no hook code change is needed — only verify by switching brands in local dev and confirming the old channel is dropped + new one subscribed.
- [ ] No new realtime publication membership changes — `brands` table is not currently in the realtime publication, and this spec does not add it. Brands list updates via the next sidebar reload after a create. (Surface as Q-USER-12b-6 if super-admin needs live cross-tab updates on the Brands list.)

### Responsive parity (Spec 011 invariant)
- [ ] All new UI works at desktop (≥ 1100), tablet (768-1099), and phone (< 768). Specifically:
  - Brand picker renders in `TitleBar` on desktop + tablet; in `MobileTopAppBar.trailing` slot on phone (collapses to a compact dropdown / mode-switch button).
  - "Brands" sidebar item is consumed by `Sidebar`, `RailSidebar`, and `MobileNavDrawer` — the lifted `useDefaultSidebarGroups()` is the one place that adds it (gated by `useSuperAdmin()` hook — see Dependencies).
  - `BrandsSection.tsx` renders correctly at all 3 widths (the existing `ComingSoonPanel` fallback in `InventoryDesktopLayout.tsx` is the dispatch model — copy it for the section list / detail two-pane).
- [ ] No `AdminScreens.tsx` edits (legacy file, off-limits per CLAUDE.md "Legacy admin screens").

### Profile + types
- [ ] `User.role` type in `src/types/index.ts` extends to include `'super_admin'`. Currently `'master' | 'admin' | 'user'`. Without this, TS strict mode rejects every `if (user.role === 'super_admin')` gate.
- [ ] `User.brandId?: string | null` field added — populated from `profiles.brand_id` in `auth.ts`'s `fetchProfile`. Used by the visibility gate hook.
- [ ] A new `useSuperAdmin()` hook (or reuse / replace the existing `useRole()` placeholder at `src/hooks/useRole.ts`) returns true iff `currentUser.role === 'super_admin'`. The existing `useRole.ts` hardcodes `'admin'` — that placeholder should be replaced or wrapped, not left in place. Architect decides scope.

---

## In scope

- New Cmd UI section: `src/screens/cmd/sections/BrandsSection.tsx` (list + detail two-pane).
- Brand picker control: `src/components/cmd/BrandPicker.tsx` (rendered in `TitleBar` and `MobileTopAppBar.trailing`).
- Sidebar visibility gate: extend `useDefaultSidebarGroups()` to conditionally include the "Brands" item when super-admin.
- Header chrome edits: `TitleBar.tsx` and `MobileTopAppBar.tsx` get optional `brandPicker` slot (rendered for super-admin).
- Active-brand state: add `activeBrandId` to `useStore` (Zustand) plus a setter that triggers store-list filter + `loadFromSupabase` + persistence.
- DB layer: new `db.fetchBrands()`, `db.createBrand(name)`, `db.fetchBrandAdmins(brandId)` in `src/lib/db.ts`.
- Auth layer: extend `inviteUser()` and `registerInvitedUser()` in `src/lib/auth.ts` to take + persist `brand_id`.
- Migration: new `supabase/migrations/2026MMDD000000_invitations_brand_id.sql` adding `invitations.brand_id` column (nullable for back-compat; new INSERTs from the extended `inviteUser` write it).
- Type updates: `User.role` adds `'super_admin'`; `User.brandId` added.
- Replace the `useRole()` placeholder OR introduce `useSuperAdmin()` alongside it (architect decides).

## Out of scope (explicitly)

- **Brand soft-delete / hard-delete / restore UX.** That's the entire purpose of 012c. 012b's brand list shows ALL brands including any soft-deleted ones (super-admin's RLS sees them), but no destructive actions. *Rationale: blast radius of a delete UX is too high to fold in with onboarding UX.* **Locked in 2026-05-08 per Q-USER-12b-2 — keep split.**
- **Brand renaming.** Super-admin uses SQL editor for now. *Rationale: Renaming a brand cascades into UI label changes, exported PDFs, push notification topics, etc. — needs a separate scope pass.*
- **Per-section permission grants** (e.g. "admin X can edit menu but not delete vendors"). Already locked out by umbrella Q1.
- **Admin suspend / delete / role-change UI.** 012b's admin list is READ-ONLY. Suspend/delete via SQL or the existing `delete-user` edge function for now. *Rationale: same blast-radius reasoning — suspending the wrong admin during a Saturday rush is a real-world bad-day scenario.*
- **"All brands" aggregated dashboard.** No cross-brand revenue / inventory rollup view. The Brands section is itself the only "all brands" surface; everywhere else loads one brand's data at a time. *Rationale: Q-USER-12b-4 default — keep it simple; cross-brand analytics is a future spec.*
- **Multi-brand membership.** A profile has exactly one `brand_id` per umbrella spec. No "this admin manages two brands" UI. *Rationale: locked by umbrella out-of-scope list.*
- **Edits to `AdminScreens.tsx`.** Legacy file, off-limits.
- **`app.json` slug change.** Per CLAUDE.md, do not touch.
- **Test framework introduction.** Same situation as 012a — manual + smoke verification per project norm. Test-engineer reviewer should propose `scripts/smoke-super-admin-ui.sh` (or extending `scripts/smoke-multi-brand.sh`) but it's a recommendation, not a blocker.
- **Customer PWA / staff app changes.** Punch list inherited from umbrella; this spec doesn't touch sibling repos.
- **Edge function for brand creation / admin invite.** Architect can choose to wrap `createBrand` and the extended `inviteUser` in edge functions for centralized auth, OR rely on 012a's RLS (super-admin INSERT on `brands` is gated by `super_admin_manage_brands` policy; admin INSERT on `invitations` is gated by existing policies). PM default: PostgREST + RLS, no new edge functions. Architect can override.
- **Standalone hotfix migration for the latent 012a invite bug.** *Rationale: user accepted the deferred-fix path 2026-05-08 — the fix lands as part of 012b's broader admin-onboarding rebuild (extended `registerInvitedUser` + new invitation form). User has agreed to NOT invite new admins via the existing prod flow until 012b ships. See Risks #1.*

---

## Open questions for the user — RESOLVED 2026-05-08

- **Q-USER-12b-1 — Create-brand UI in 012b vs deferred to 012c?** → **SHIP IN 012b** (PM default accepted). Without it, super-admin would still need SQL editor to onboard Baltimore Seafood, defeating the spec's purpose. The "+ NEW BRAND" button + `db.createBrand` stay in scope.
- **Q-USER-12b-2 — Should 012b absorb 012c, or stay split?** → **KEEP SPLIT** (PM default accepted). 012b ships listing + invite + create only. 012c adds destructive delete/restore in a separate spec/PR/review cycle/prod release.

## Open questions resolved (PM defaults applied — user can override)

- **Q-PM-1 — Brand picker placement.** → **Header (TitleBar on desktop/tablet; MobileTopAppBar.trailing on phone).** Standard SaaS pattern; keeps brand context near the user identity. Sidebar-top placement was rejected because the sidebar is hidden behind a hamburger on phone.
- **Q-PM-2 — `currentBrand` storage.** → **In Zustand `useStore` as `activeBrandId`.** Mirrors `currentStore` shape. Persisted to `localStorage` / `AsyncStorage` (same as `darkMode`).
- **Q-PM-3 — "All brands" view.** → **One brand at a time + the Brands section IS the all-brands surface.** Picking "All brands" jumps to the Brands section; no cross-brand dashboard rollup in 012b.
- **Q-PM-4 — Realtime channel switch.** → **Existing `useRealtimeSync` hook already has `brandId` in its `useEffect` deps; no hook code change needed.** Only verify behavior in dev.
- **Q-PM-5 — Existing invitation flow.** → **PROBED. Confirmed:** there IS an existing `invitations` table + `inviteUser()` + `consume_invitation` RPC + `send-invite-email` edge fn. The bug: `inviteUser()` does not set `brand_id`, and `registerInvitedUser()` does not write `profiles.brand_id`. **This will break the next admin invite in prod against 012a's CHECK.** 012b extends both. There is NO existing in-app UI to call `inviteUser()` from the Cmd UI today — `auth.ts:inviteUser` is exported but only consumed by `AdminScreens.tsx` (legacy). 012b adds the form fresh in the Cmd UI.
- **Q-PM-6 — Super-admin badge.** → **Replace the static `RoleBadge` "ADMIN" label with the user's actual role: "SUPER ADMIN" / "ADMIN" / "USER".** Today `RoleBadge` is hardcoded to "admin". Add a `role` prop sourced from `currentUser.role`. Keeps visual rhythm; surfaces the difference clearly.
- **Q-PM-7 — Sidebar visibility.** → **Filter "Brands" out of `useDefaultSidebarGroups()` when not super-admin.** Simplest plumbing — the override merge has nothing to operate on for non-super-admins because the item isn't in the default groups.
- **Q-PM-8 — Store assignment UX in invite form.** → **Multi-select checkboxes against the brand's stores list.** Simplest defensible default. Filter the picker to the chosen brand's stores so the §1 trigger from 012a doesn't fire on submit.
- **Q-PM-9 — Existing 2AM admin (Bobby) store assignment.** → **PROBED — see Risks #2.** Today `user_stores` is empty for Bobby (the rows-existence check would need a SQL query). Implicit current behavior: brand-admin sees all brand stores via JWT-claim admin-bypass. After 012b ships, this implicit "admin sees all" remains — the new invite UI defaults the store multi-select to "all stores in the brand" so legacy admins are not silently scoped down.
- **Q-PM-10 — Responsive parity.** → **Required at all 3 tiers per Spec 011 invariant.** Acceptance criteria above enumerate per-tier behavior.
- **Q-PM-11 — Soft-deleted brand visibility in 012b.** → **Show in the Brands list with a "soft-deleted" pill, but exclude from the brand picker (the picker only shows `deleted_at IS NULL` brands).** No restore button — that's 012c. Super-admin sees the row exists but cannot interact with it from the picker.

## Open questions for the user — non-blocking (PM defaults applied, override anytime)

These are NOT blocking. The build proceeds against the PM defaults. The user can override any of them mid-build at no cost — they're listed here for scannable visibility.

- **Q-USER-12b-3 — Sidebar item label: "Brands" or "Tenants"?** → PM default: **"Brands"** (matches DB table name + umbrella body text).
- **Q-USER-12b-4 — Behavior when super-admin selects "All brands"?** → PM default: **forces section to "Brands" and clears `currentStore`** (cheaper than rendering every other section in a "no data" empty state).
- **Q-USER-12b-5 — Persist active brand to DB or localStorage only?** → PM default: **localStorage / AsyncStorage only**. Tradeoff: switch resets per device.
- **Q-USER-12b-6 — Live cross-tab brand-list updates?** → PM default: **no realtime on `brands`** (rare operation; manual refresh / poll-on-section-switch suffices). Alternative would trigger the realtime publication restart ritual.
- **Q-USER-12b-7 — Should admin invitation also set per-section permissions?** → PM default: **no, brand + store scope only** (locked by umbrella Q1).

---

## Dependencies

- **012a is shipped and live in prod** — confirmed via 012a Apply log. Specifically depends on:
  - `auth_is_super_admin()` SQL helper (used by RLS that the new UI exercises).
  - `auth_can_see_brand(brand_id)` SQL helper.
  - `super_admin_manage_brands` policy on `brands` (lets super-admin INSERT new brand rows).
  - `super_admin_read_all_profiles` policy on `profiles` (lets super-admin read other admins' profile rows for the admin list).
  - `user_stores_brand_match` trigger (defends against the brand-mismatch case if the invite form's store filter has a bug).
- **Existing `useRealtimeSync` hook** — accepts `brandId` already; only the call-site re-evaluates on brand switch (no hook change).
- **Existing `invitations` table + `consume_invitation` + `get_pending_invitation` RPCs** — both extended in 012b.
- **Existing `send-invite-email` edge function** — no change; the existing payload (email, name, role, storeNames) is sufficient. (If the user wants the email to mention the brand, that's a copy-only edit on the edge fn template — surface as a follow-up.)
- **`fetchAllUsers()` in `src/lib/auth.ts`** — already exists; will need a brand-filter overload for the brand detail view's admin list (`fetchAllUsers({ brandId })`).
- **Spec 008 sidebar customization** — the override merge must NOT crash when the "Brands" item is absent for non-super-admins. The existing `applySidebarOverride` should already handle missing items defensively (overrides reference items by id; missing ids are ignored). Architect to verify.
- **Spec 011 responsive shell** — the brand picker + Brands section must render at all 3 tiers. The shell already wires the lifted selector and the mobile drawer; just need the new item + new section.
- No new third-party libraries.

---

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. New section in `src/screens/cmd/sections/BrandsSection.tsx`. **Will not touch `src/screens/AdminScreens.tsx`** (legacy file, off-limits per CLAUDE.md).
- **Per-store or admin-global:** Both. The Brands section is admin-global (super-admin only). The brand picker is admin-global (super-admin only). The rest of the UI stays per-store (brand-admin's existing flow is unchanged).
- **Realtime channels touched:** `brand-{brandId}` already exists; the call site re-evaluates on brand switch. No new realtime tables (unless the user answers Q-USER-12b-6 with "yes, add `brands` to the publication" — then the `docker restart supabase_realtime_imr-inventory` ritual applies).
- **Migrations needed:** Yes — one small migration adding `invitations.brand_id`. Architect names the file. Single-table additive, no RLS rewrite.
- **Edge functions touched:** None required; `send-invite-email` and `delete-user` keep their current contracts. Architect may propose wrapping `createBrand` and the extended `inviteUser` in edge functions for centralized auth — PM default is direct PostgREST + RLS, no edge fns.
- **Web/native scope:** Web + native, both must work at all 3 breakpoints (Spec 011 invariant). Native users might not actually use the super-admin path day-to-day, but it must not crash on phone.
- **`app.json` slug:** No change.
- **Tests:** No test framework. Test-engineer should propose either (a) extending `scripts/smoke-multi-brand.sh` to exercise the create-brand + invite-with-brand paths via curl, or (b) a new `scripts/smoke-super-admin-ui.sh`. Strongly recommended but not a blocker.

---

## Risks

1. **Latent invite bug from 012a — deferred fix accepted by user 2026-05-08.** The CHECK `profiles_role_brand_consistent` from 012a rejects new admin profiles with NULL `brand_id`. Today's `inviteUser()` writes `brand_id = NULL` implicitly, and `registerInvitedUser()` inserts the new profile without `brand_id`. The next admin invite from prod will fail at the profile INSERT. **Mitigation: no standalone hotfix migration will ship.** The fix lands as part of 012b's broader admin-onboarding rebuild — `registerInvitedUser` will be rewritten to write `brand_id`, and the new invitation form will set `brand_id` upfront in the invitation payload. **In the meantime, the user has explicitly agreed to NOT invite new admins via the existing prod flow until 012b ships.** This decision is auditable here — reviewers and future-PM should NOT re-raise the hotfix question.

2. **Existing `user_stores` rows for Bobby.** Today's RLS via JWT-`role=admin` lets Bobby see all 4 stores even if no `user_stores` rows exist for him. After 012b's invite UI suggests an explicit store assignment, future invitees get explicit `user_stores` rows; existing admins (Bobby) keep the implicit "admin sees all" via JWT. A future cleanup spec should backfill `user_stores` for all existing admins so the path is consistent — out of scope for 012b.

3. **Brand picker UX on phone.** The `MobileTopAppBar` has only ~32px-wide trailing slot today. Fitting a brand picker (even a compact dropdown) requires either truncating the section title or replacing the whole bar with a brand+section stack on phone. Architect to design — possible mitigation: brand picker on phone is a separate row below the app-bar when super-admin is logged in.

4. **`useRole()` placeholder removal.** The existing `src/hooks/useRole.ts` hardcodes `'admin'` — it's a placeholder. Replacing or wrapping it is in scope but might be referenced from places we haven't audited. Architect should grep usage sites before deciding "replace" vs "introduce useSuperAdmin alongside".

5. **`loadFromSupabase('__all__')` collision.** `useStore.setCurrentStore('__all__')` is the legacy "All Stores" mode (now redirected to first accessible store per the comment block at line 263-279 of `useStore.ts`). The new "All brands" mode for super-admin must NOT collide with this — use a separate `activeBrandId = null` (or sentinel `'__all_brands__'`) and a separate setter. Architect decides naming.

6. **Brand picker affects every section's data.** Switching brand triggers `loadFromSupabase` which replaces the entire data slice. If the user is mid-edit (e.g. in Recipes) when they hit the brand picker, their unsaved changes are lost. Architect should consider either (a) a `confirmAction` prompt before switching, or (b) accepting the loss as cheap-and-correct (super-admin shouldn't be mid-edit when context-switching between tenants — and there's no unsaved-changes infrastructure today). PM default: accept the loss; surface as a known UX gap.

7. **TypeScript strict mode.** Adding `'super_admin'` to `User.role` is a strict-mode-significant change — every existing `if (role === 'admin')` is now non-exhaustive. Audit needed for `getCurrentUser` consumers (probably 5-10 sites). Architect to enumerate.

8. **No CI gate.** Per CLAUDE.md, the `.github/workflows/db-migrations-applied.yml` workflow doesn't exist on disk. The new tiny migration applies via `supabase db push --linked` manually post-merge. Document in dev handoff.

---

## Files to be created / changed (preliminary — architect refines)

**New files:**
- `src/screens/cmd/sections/BrandsSection.tsx` — list + detail two-pane.
- `src/components/cmd/BrandPicker.tsx` — header dropdown.
- `src/components/cmd/InviteAdminForm.tsx` — invite form (lives inside BrandsSection's detail view).
- `supabase/migrations/2026MMDD000000_invitations_brand_id.sql` — adds `invitations.brand_id`. (Architect picks the date.)

**Changed files:**
- `src/lib/cmdSelectors.ts` — `useDefaultSidebarGroups()` gates "Brands" item on super-admin.
- `src/components/cmd/TitleBar.tsx` — accepts optional `brandPicker` slot.
- `src/components/cmd/MobileTopAppBar.tsx` — already has `trailing` slot; just consume it from the shell.
- `src/screens/cmd/ResponsiveCmdShell.tsx` — wires `BrandPicker` into TitleBar / MobileTopAppBar when super-admin.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — adds `BrandsSection` to the section dispatch.
- `src/store/useStore.ts` — adds `activeBrandId` + setter; persists to localStorage.
- `src/lib/db.ts` — `fetchBrands()`, `createBrand(name)`, `fetchBrandAdmins(brandId)`.
- `src/lib/auth.ts` — `inviteUser(... , brandId)` + `registerInvitedUser` writes `profiles.brand_id`. **Includes the latent 012a invite bug fix per Risks #1 — load-bearing code work, not just a TS extension.**
- `src/types/index.ts` — `User.role` adds `'super_admin'`; `User.brandId?`.
- `src/components/cmd/RoleBadge.tsx` — accepts the user's actual role.
- `src/hooks/useRole.ts` — replace or augment (architect decides).

**Unchanged (no edits expected):**
- `src/hooks/useRealtimeSync.ts` — call-site already deps on `brandId`.
- `supabase/functions/send-invite-email/` — payload sufficient as-is.
- `supabase/functions/delete-user/` — out of 012b scope.

---

## Definition of done (012b)

This sub-spec is DONE when:
- The user (`wzhchen113@gmail.com`) logs in to prod, sees a "Brands" item in the sidebar, sees a brand picker in the header, can create a new brand from the UI, can invite a brand-admin to the new brand with a chosen store set, and the invitee can register and see the new brand's data.
- Bobby (existing 2AM admin) logs in to prod, sees no Brands item, sees no brand picker, and operates exactly as today with no functional change.
- The UI works at desktop, tablet, and phone widths.
- The latent invite bug from 012a is resolved (extended `inviteUser` + `registerInvitedUser` write `brand_id`).
- 012c is unblocked to design destructive admin/brand management on top of this surface.

---

## Frontend design

This is a frontend-heavy spec with one tiny additive migration. The architect treats it as a unified design (frontend + the single column-add migration) because the migration is small enough that splitting it across two specialist hand-offs would cost more than it saves; the developer drops the migration alongside the frontend code.

### §0 — Probe results (pre-design read of the codebase)

What the architect confirmed before designing. **Read these line numbers as anchors for the developer's implementation pass.**

#### Spec 011 chrome (the surface 012b builds on)

- [src/screens/cmd/ResponsiveCmdShell.tsx](../src/screens/cmd/ResponsiveCmdShell.tsx) (~458 LOC) is the sole tier-aware chrome. It owns: section state, sidebar edit-mode, mobile drawer open, tablet rail-collapsed, palette-action plumbing, and renders one of three branches (`isPhone` → `MobileTopAppBar` + `MobileNavDrawer` + body; `isTablet` → `TitleBar` + collapsible `Sidebar`/`RailSidebar` + body; desktop → `TitleBar` + permanent `Sidebar` + body). Both desktop AND tablet render `TitleBar`; phone renders `MobileTopAppBar`.
- The shell consumes `useDefaultSidebarGroups()` (`cmdSelectors.ts:1024`) and merges the Spec 008 user override via `applySidebarOverride` — both desktop, tablet, and phone consume the same `groupsForSidebar` array. **This is the single insertion point** for the new "Brands" item across all three breakpoints.

#### Spec 008 sidebar customization

- `useDefaultSidebarGroups()` returns three groups (Operations, Planning, Insights) of fixed items keyed by stable `id`.
- `applySidebarOverride(defaultGroups, override, { editMode })` ([src/lib/sidebarLayout.ts](../src/lib/sidebarLayout.ts)) silently drops override entries whose `id` is no longer in defaults. **Implication:** if "Brands" is filtered OUT of defaults for non-super-admins (the gating strategy below), any override entry referencing it for a non-super-admin user is harmlessly ignored. No defensive change needed.

#### Existing invitation infrastructure (per Q-PM-5)

- **Table:** `public.invitations` with columns `(id, email, profile_id, name, role, store_ids text[], expires_at, used)` — lives in prod (referenced by [supabase/migrations/20260424211733_security_fixes.sql:38-57](../supabase/migrations/20260424211733_security_fixes.sql)) but the original `CREATE TABLE` is not on disk locally (predates this repo's migration history). **Implication for §1 migration:** must use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` defensively — assume the table exists in prod, do NOT include CREATE TABLE.
- **Inviter call site:** [src/lib/auth.ts:125-166](../src/lib/auth.ts) `inviteUser(email, name, role, storeIds, storeNames?)`. Inserts an `invitations` row, then fires the `send-invite-email` edge function (non-blocking, fail-silent). **Does NOT write `brand_id`** — this is the load-bearing latent bug from 012a.
- **Acceptor call site:** [src/lib/auth.ts:169-229](../src/lib/auth.ts) `registerInvitedUser(email, password, name)`. Calls `get_pending_invitation` RPC, then `auth.signUp`, then INSERTs the `profiles` row with `(id, name, role, initials, color, status)` — **NOT `brand_id`**. This is the line that violates the new `profiles_role_brand_consistent` CHECK on the very next prod admin invite.
- **Current Cmd UI consumer of `inviteUser`:** None. `inviteUser` is exported but only consumed by `src/screens/AdminScreens.tsx` (legacy, off-limits). The Cmd UI has no admin-management form today. 012b adds it fresh.
- **Edge function `send-invite-email`:** payload is `{ email, name, role, storeNames }`. Brand name is not included; per spec out-of-scope, no edge function changes.
- **RPCs:** `get_pending_invitation(p_email text) RETURNS TABLE(id, email, name, role, store_ids, expires_at)` is `SECURITY DEFINER`. **Adding `brand_id` to the RPC's return set is required** so `registerInvitedUser` can read it. This is a schema-side change to the function definition — see §1.

#### `currentStore` shape (the model `currentBrand` will mirror)

- Lives on `useStore` ([src/store/useStore.ts:204](../src/store/useStore.ts)) as a full `Store` object (`{ id, brandId, name, address, status }`), initial value an empty-string sentinel.
- Setter `setCurrentStore(store)` ([src/store/useStore.ts:262-280](../src/store/useStore.ts)) handles the legacy `__all__` redirect and triggers `loadFromSupabase(store.id)`. `__all__` is the legacy "All Stores" sentinel — **per Risks #5, the new "All brands" sentinel must NOT collide.**
- `currentStore.brandId` was confirmed to be populated post-012a (every store has `brand_id NOT NULL` in prod).
- The `brand` slice ([src/store/useStore.ts:206](../src/store/useStore.ts), `Brand | null`) is currently the *implicit* "what brand am I looking at" — derived from `currentStore.brandId` via `fetchBrandForStore` inside `loadFromSupabase`. **For brand-admin (non-super-admin), this is the source of truth and stays unchanged.** For super-admin, 012b adds an *explicit* override on top.

#### `useRole()` placeholder

- [src/hooks/useRole.ts](../src/hooks/useRole.ts) — 9 lines, returns the literal string `'admin'` for everyone. Header comment notes "this app is admin-only ... when the staff cleanup is done in every consumer, this file goes away."
- **Grep audit of consumers:** I did not find any active call sites in the Cmd UI sections (the new sections read `currentUser.role` directly when they need it, e.g. [src/components/cmd/TitleBar.tsx:36](../src/components/cmd/TitleBar.tsx)). The hook may be vestigial. **Decision:** keep `useRole.ts` but augment by exporting a new `useIsSuperAdmin()` from the same file (see §1). The existing `useRole()` keeps returning `'admin'` for back-compat with any consumer we missed; new code uses `useIsSuperAdmin()`.

#### Existing role-check audit sites (TS strict mode impact)

Grep `currentUser.role`, `user.role ===`, `=== 'admin'`, `=== 'master'` across the active codebase (excluding `AdminScreens.tsx` legacy and `useSupabaseStore.ts` legacy). Found:

| File:line | Pattern | Action needed when `'super_admin'` is added to `User.role` |
|---|---|---|
| [src/components/cmd/TitleBar.tsx:36](../src/components/cmd/TitleBar.tsx) | `currentUser?.role === 'admin' \|\| currentUser?.role === 'master'` | Extend to `\|\| === 'super_admin'` so super-admin sees all stores in the store picker. |
| [src/store/useStore.ts:269](../src/store/useStore.ts) | `user?.role === 'admin' \|\| user?.role === 'master'` (in `setCurrentStore` `__all__` fallback) | Extend to include `'super_admin'`. |
| [src/lib/auth.ts:81,87](../src/lib/auth.ts) | `profile.role === 'master'` (display name override) | No change required — `'super_admin'` is a separate role, not aliased to master. Display-name override stays for `'master'`. |
| [src/lib/auth.ts:285,291](../src/lib/auth.ts) | Same as above in `fetchAllUsers`. | No change. |
| [src/store/useStore.ts:396, 423, 449, etc.](../src/store/useStore.ts) | `userRole: get().currentUser?.role \|\| 'user'` (audit-log writers) | No change — the value just flows through to the audit-log row. `'super_admin'` is a valid value to land in the AuditEvent type. |

**Total active sites that need an extension:** 2 (TitleBar.tsx:36, useStore.ts:269). TS strict mode will flag any literal-comparison call site once `User.role` widens to `'master' \| 'admin' \| 'user' \| 'super_admin'` — anything else surfaces as a non-exhaustive check. The audit-log assignment sites won't flag because the field receives a value, it doesn't compare against literals.

**Legacy (off-limits per CLAUDE.md):** [src/screens/AdminScreens.tsx](../src/screens/AdminScreens.tsx) has many `role === 'master'` / `role === 'admin'` checks. These are outside scope. The TS extension to `User.role` will compile-OK against them because they're equality checks, not exhaustive switches.

#### Realtime channel architecture

- [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) takes `(storeId, onSync, brandId)`. The brand channel subscription lives inside `useEffect` with `[storeId, brandId, onSync]` deps — **the cleanup function already removes the old channel and the new one re-subscribes when `brandId` changes**. This is exactly what 012b needs; no hook code change required.
- The call site at [src/navigation/CmdNavigator.tsx:73](../src/navigation/CmdNavigator.tsx) reads `useStore((s) => s.brand?.id)`. After 012b's `currentBrand` slice is wired, this needs to read from the new explicit slice (see §2).

#### Existing form drawers (the pattern §3/§4 will reuse)

- [src/components/cmd/IngredientFormDrawer.tsx](../src/components/cmd/IngredientFormDrawer.tsx) wraps body content in [`ResponsiveSheet`](../src/components/cmd/ResponsiveSheet.tsx). `ResponsiveSheet` resolves to right-anchored drawer (desktop), bottom-sheet (tablet), full-screen modal (phone). Default desktop width 760, tablet sheet height 0.85 of viewport. **Reuse verbatim** for `BrandFormDrawer` and `InviteAdminDrawer`.
- [src/screens/cmd/sections/VendorsSection.tsx](../src/screens/cmd/sections/VendorsSection.tsx) is the canonical "two-pane list+detail" section pattern (list pane left, detail right with TabStrip). `BrandsSection.tsx` adopts this pattern.

#### The `__all__` sentinel and the new "All brands" sentinel (Risks #5)

- `setCurrentStore('__all__')` triggers a redirect (already vestigial, no longer surfaced in UI per the comment block at [src/store/useStore.ts:263-279](../src/store/useStore.ts)).
- For the new "All brands" mode, do NOT reuse `'__all__'` and do NOT introduce another magic string. **Use `currentBrandId: string | null`**, where `null` is the explicit "all brands" / "viewing the Brands section" mode. Setter is `setCurrentBrandId(brandId: string | null)`. This sidesteps the collision entirely without inventing new sentinels.

---

### §1 — Schema + type extensions

#### Migration filename

`supabase/migrations/20260510000000_invitations_brand_id.sql`. Date 2026-05-10 (one clear day after the 012a migration `20260509000000_…`). Single transaction, additive only.

#### Migration contents (signature only — developer authors)

```sql
-- 1. Add brand_id column to invitations table.
alter table public.invitations
  add column if not exists brand_id uuid references public.brands(id) on delete cascade;

comment on column public.invitations.brand_id is
  'Brand the invitee will be scoped to on registration. NULL allowed for legacy
   invitations from before 012b ships and for role=user invitations (staff app).
   Required by registerInvitedUser when role=admin per profiles_role_brand_consistent.';

-- 2. Optional index for super-admin admin-list queries (per-brand fetch).
create index if not exists invitations_brand_id_idx on public.invitations (brand_id)
  where brand_id is not null;

-- 3. Update get_pending_invitation RPC to include brand_id in the return set.
--    This is REPLACE not DROP (the function name is callable from registerInvitedUser
--    immediately after deploy; we want zero-downtime).
create or replace function public.get_pending_invitation(p_email text)
returns table (
  id uuid,
  email text,
  name text,
  role text,
  store_ids text[],
  brand_id uuid,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, email, name, role, store_ids, brand_id, expires_at
    from public.invitations
   where email = lower(p_email)
     and used = false
     and (expires_at is null or expires_at > now())
   limit 1;
$$;

grant execute on function public.get_pending_invitation(text) to anon, authenticated;
```

**Why on delete cascade:** if a super-admin deletes a brand, any pending invitations for that brand should be removed too — there's no point letting an invitee register against a brand that no longer exists. Cheap and correct.

**Why `if not exists` on the column:** defensive against a hypothetical re-apply or if the column was added manually via dashboard SQL editor pre-spec.

**Idempotency check:** safe to re-apply. ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION. No data writes.

**Rollout safety:** purely additive. No breaking change. After this migration applies, the existing `inviteUser` (which doesn't write `brand_id`) continues to insert rows with `brand_id = NULL`; the existing `registerInvitedUser` (which doesn't read `brand_id`) continues to fail post-012a's CHECK because it never sets `profiles.brand_id`. **The fix lands in §4 — frontend code changes that USE the new column.** The migration is a no-op until §4 ships in the same PR.

#### `User.role` type extension

[src/types/index.ts:3](../src/types/index.ts) currently:

```ts
export type UserRole = 'master' | 'admin' | 'user';
```

Extend to:

```ts
export type UserRole = 'super_admin' | 'master' | 'admin' | 'user';
```

Note: `super_admin` is added in front intentionally so any existing `as` casts that match left-to-right preserve their behavior. No semantic significance to ordering.

#### `User.brandId` field addition

[src/types/index.ts:5-23](../src/types/index.ts) `User` interface — add:

```ts
export interface User {
  // ...existing fields...
  /**
   * Brand the user is scoped to (mirrors profiles.brand_id post-012a).
   * NULL for super-admin (sees all brands). NULL for legacy 'user' role
   * staff. Set for 'admin' role per profiles_role_brand_consistent CHECK.
   */
  brandId?: string | null;
}
```

#### `fetchProfile` populates `User.brandId`

[src/lib/auth.ts:79-91](../src/lib/auth.ts) — extend the `User` literal:

```ts
const user: User = {
  // ...existing fields...
  brandId: profile.brand_id ?? null,
};
```

snake_case → camelCase mapping: `profile.brand_id` (DB) → `user.brandId` (TS).

#### `useRole()` augmentation

[src/hooks/useRole.ts](../src/hooks/useRole.ts) — keep the existing `useRole()` (returns `'admin'`) for back-compat; add a new export:

```ts
import { useStore } from '../store/useStore';

/** True iff the logged-in user has profiles.role = 'super_admin'.
 *  Single source of truth for super-admin gating in the Cmd UI:
 *  - Sidebar "Brands" item visibility (cmdSelectors)
 *  - Brand picker visibility (TitleBar / MobileTopAppBar)
 *  - BrandsSection access (defensive — sidebar gate is the primary)
 */
export function useIsSuperAdmin(): boolean {
  const role = useStore((s) => s.currentUser?.role);
  return role === 'super_admin';
}
```

**Why augment, not replace:** replacing `useRole()` to return real role would break any consumer that relies on the placeholder returning `'admin'` (e.g. some legacy gate that says "admin can do X" — replacing with real role might return `'user'` for a staff account that somehow loaded the Cmd UI). The placeholder file's author intent (per its header comment) was "make staff cleanup easy" — we don't need to do that cleanup as part of 012b. New gating uses `useIsSuperAdmin()` which has clean semantics.

#### Audit sites that need TS extension

Per §0, two active sites:

1. [src/components/cmd/TitleBar.tsx:36](../src/components/cmd/TitleBar.tsx)
   ```ts
   // BEFORE
   const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
   // AFTER
   const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master'
                || currentUser?.role === 'super_admin';
   ```

2. [src/store/useStore.ts:269](../src/store/useStore.ts)
   ```ts
   // BEFORE
   const accessible = user?.role === 'admin' || user?.role === 'master'
   // AFTER
   const accessible = user?.role === 'admin' || user?.role === 'master'
                   || user?.role === 'super_admin'
   ```

The developer should `npx tsc --noEmit` after the type widen to catch any other site I missed (TS strict will flag literal-comparison non-exhaustiveness only in switches, but explicit `===` chains will compile fine even when missing the new variant — so the developer should also grep for `=== 'admin'` and `=== 'master'` to manually re-audit). **Both sites in `AdminScreens.tsx` (legacy) need NO change** — it's frozen.

---

### §2 — `currentBrand` + brand picker plumbing

#### Where `currentBrand` lives

In `useStore` ([src/store/useStore.ts](../src/store/useStore.ts)) — a new slice alongside `brand` and `currentStore`. **Naming decision:** call the new slice `currentBrandId: string | null` (NOT `currentBrand: Brand | null`). Reasoning:

- The existing `brand: Brand | null` slice is the *implicitly-resolved* brand object for the current store (super-admin or otherwise). It stays in place — keep its existing semantics.
- `currentBrandId` is the *explicit* super-admin override. `null` means "no override; use whatever brand the current store implies" (which for non-super-admin is always their `profiles.brand_id`, and for super-admin is the default "all brands → Brands section" mode).
- The `brand` object is then derivable: when `currentBrandId === null` AND `currentUser.role === 'super_admin'`, callers know they're in "all brands" mode and should jump to the Brands section. When `currentBrandId !== null`, callers should fetch via `fetchBrandsLite()` (see §5) and find the matching object.

Add to `AppState` interface ([src/types/index.ts:356](../src/types/index.ts)):

```ts
/**
 * Spec 012b — super-admin's explicit brand-context override. NULL means:
 *   - super-admin: "All brands" mode → app navigates to Brands section
 *   - non-super-admin: NOT USED (the picker is hidden; brand is implicit
 *     via profiles.brand_id, surfaced through the existing `brand` slice)
 */
currentBrandId: string | null;
```

Add to store ([src/store/useStore.ts](../src/store/useStore.ts)):

```ts
// Initial state
currentBrandId: null,

// Action
setCurrentBrandId: (brandId: string | null) => void;
```

#### `setCurrentBrandId` setter behavior

```ts
setCurrentBrandId: (brandId) => {
  const prev = get().currentBrandId;
  if (prev === brandId) return; // no-op

  // Persist locally (web localStorage / native AsyncStorage).
  // Key: 'imr.cmd.superAdmin.activeBrand'. Empty string = null.
  persistActiveBrandLocal(brandId);

  set({ currentBrandId: brandId });

  if (brandId === null) {
    // "All brands" mode — clear currentStore so per-store sections
    // don't render stale data. The sidebar selection should also be
    // forced to "Brands" by the consumer (ResponsiveCmdShell).
    set({ currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' } });
    return;
  }

  // Brand-switch — re-derive currentStore for the new brand.
  // Find first store the user can see in the new brand. Super-admin
  // sees all stores in the brand; pick the first.
  const newStore = get().stores.find((s) => s.brandId === brandId);
  if (newStore) {
    // Triggers loadFromSupabase as a side effect (existing setCurrentStore behavior).
    get().setCurrentStore(newStore);
  } else {
    // No stores in this brand yet — clear currentStore. Sections will show
    // empty states. Brand creation on a fresh tenant lands here.
    set({ currentStore: { id: '', brandId, name: '', address: '', status: 'active' } });
  }
},
```

**Re-fetching brand-scoped data on switch:** delegated to the existing `setCurrentStore → loadFromSupabase` chain. This:
- Calls `fetchAllForStore(newStore.id)`, which calls `fetchBrandForStore(newStore.id)` to resolve the brand, then fetches catalog/recipes/preps/vendors brand-scoped + inventory/EOD/waste store-scoped.
- Populates the `brand` slice with the new brand object (so downstream consumers like `addRecipe` resolve `get().brand?.id` correctly).
- Realtime channels swap automatically because `useRealtimeSync` deps on `brandId` derived from `useStore((s) => s.brand?.id)` (which changes after `loadFromSupabase` writes the new brand).

**Loading state:** `loadFromSupabase` already sets `storeLoading: true` ([src/store/useStore.ts:285](../src/store/useStore.ts)) and clears at the end. Brand-scoped data slices (`recipes`, `prepRecipes`, `vendors`, `catalogIngredients`) are *replaced* on switch (not zeroed first then refilled). **Per Risks #2 — UX consequence:** the screen briefly shows the old brand's data until the fetch completes, then snaps to the new brand's. This is the existing pattern for store switching too. **Acceptable for 012b**; flag as known UX gap.

#### Persistence of active brand

Same pattern as `darkMode`:

```ts
const ACTIVE_BRAND_KEY = 'imr.cmd.superAdmin.activeBrand';

function persistActiveBrandLocal(brandId: string | null) {
  try {
    const v = brandId ?? '';
    if (Platform.OS === 'web') {
      window.localStorage.setItem(ACTIVE_BRAND_KEY, v);
    } else {
      AsyncStorage.setItem(ACTIVE_BRAND_KEY, v).catch(() => {});
    }
  } catch { /* best-effort */ }
}
```

Hydrate at boot in `App.tsx` (or wherever `darkMode` is hydrated — same boot-time hydrator pattern). Read the key, if non-empty AND the user is super-admin (post-login), call `setCurrentBrandId(stored)`.

**Spec acceptance criterion** said "resets to All brands on next login". With localStorage keyed per-browser-tab, the value persists across reloads but not across login sessions on a different machine. The proposed key is per-browser; close-and-reopen-tab keeps it. To enforce reset-on-login, the login flow should clear the key — add a single line to `useStore.login`:

```ts
login: (user) => {
  // ... existing fetchStores logic ...
  // Spec 012b — clear any stale super-admin active-brand override on login.
  // localStorage value persists across tab reloads but not across logins.
  if (Platform.OS === 'web') window.localStorage.removeItem(ACTIVE_BRAND_KEY);
  else AsyncStorage.removeItem(ACTIVE_BRAND_KEY).catch(() => {});
  // ...
},
```

#### Brand picker UI placement

| Breakpoint | Placement | Component change |
|---|---|---|
| Desktop (≥ 1100) | `TitleBar` — new slot to the right of the breadcrumb store-switcher, before the connection indicator. | `TitleBar.tsx` accepts an optional `brandPicker?: React.ReactNode` prop. The shell passes `<BrandPicker />` only when `useIsSuperAdmin() === true`. |
| Tablet (768–1099) | Same `TitleBar` slot — same component, same prop. | Same as desktop (the shell passes the same prop in both `isTablet` and desktop branches). |
| Phone (< 768) | `MobileTopAppBar.trailing` slot (already exists). | Already has the `trailing` prop ([src/components/cmd/MobileTopAppBar.tsx:13,82](../src/components/cmd/MobileTopAppBar.tsx)) — unused today. The shell passes `<BrandPicker compact />` only for super-admin. |

**Per Risks #3 (cramped phone trailing slot):** confirmed only ~32px-wide trailing slot today. The `BrandPicker` on phone renders as a single-letter brand-prefix button (e.g. "2A" for "2AM PROJECT" / "BS" for "Baltimore Seafood") + chevron, total ~40px wide. Tapping opens a full-screen brand-list modal (reuses `ResponsiveSheet` with `phone: 'fullscreen'`). **The section title in `MobileTopAppBar` truncates with `numberOfLines={1}`** ([src/components/cmd/MobileTopAppBar.tsx:72](../src/components/cmd/MobileTopAppBar.tsx)) — which is correct existing behavior. No phone-row-stack-below-app-bar contortion needed.

#### `BrandPicker` component shape

New file: `src/components/cmd/BrandPicker.tsx`. Signature:

```ts
interface Props {
  /** Phone-friendly compact mode: 2-letter brand prefix + chevron, opens a full-screen modal.
   *  Desktop/tablet: full brand name + chevron, opens a portaled dropdown
   *  (mirrors TitleBar's existing store-switcher dropdown pattern). */
  compact?: boolean;
}
export const BrandPicker: React.FC<Props>;
```

Internal behavior:
- Reads `brands` from a new local state (fetched once at mount via `db.fetchBrandsLite()` — see §5 — and cached in a Zustand slice; see §3).
- Renders the current brand name (resolved by looking up `currentBrandId` in the brands list, or "All brands" when `currentBrandId === null`).
- Dropdown items: each non-soft-deleted brand + an "All brands" sentinel at the top.
- Clicking an item calls `setCurrentBrandId(b.id)` (or `setCurrentBrandId(null)` for "All brands").
- "All brands" pick additionally forces section to "Brands" — the picker dispatches a `paletteAction` to `usePaletteAction.getState().request({ section: 'Brands', selectedName: null })`. This reuses the existing palette-action bridge that the shell consumes for section swaps ([src/screens/cmd/ResponsiveCmdShell.tsx:206](../src/screens/cmd/ResponsiveCmdShell.tsx)).

**Why dispatch through paletteAction instead of a direct setSection prop:** the shell owns `section` state (`useState`); BrandPicker is rendered inside `TitleBar`/`MobileTopAppBar` which are siblings to the shell, not children. The paletteAction store is the existing decoupling channel — already consumed for ⌘K palette section swaps. Using it here is consistent.

#### Non-super-admin: brand picker hidden

The shell renders `<BrandPicker />` only when `useIsSuperAdmin() === true`:

```tsx
// In ResponsiveCmdShell.tsx, build once at render top:
const isSuperAdmin = useIsSuperAdmin();
const brandPickerSlot = isSuperAdmin ? <BrandPicker /> : null;
const brandPickerCompact = isSuperAdmin ? <BrandPicker compact /> : null;

// Then in each tier:
//   isPhone:   <MobileTopAppBar ... trailing={brandPickerCompact} />
//   isTablet:  <TitleBar ... brandPicker={brandPickerSlot} />
//   desktop:   <TitleBar ... brandPicker={brandPickerSlot} />
```

For a brand-admin (Bobby), `isSuperAdmin === false`, so `brandPickerSlot/Compact === null` and the chrome is unchanged.

---

### §3 — "Brands" sidebar section

#### Default-groups gating in `cmdSelectors.ts`

[src/lib/cmdSelectors.ts:1024](../src/lib/cmdSelectors.ts) `useDefaultSidebarGroups()` currently returns three groups with hardcoded items. **Decision per Q-PM-7:** filter the "Brands" item out of the default groups when not super-admin (so the Spec 008 override merge has nothing to operate on for non-super-admins).

Change:

```ts
import { useIsSuperAdmin } from '../hooks/useRole';

export function useDefaultSidebarGroups(): SidebarGroup[] {
  const isSuperAdmin = useIsSuperAdmin();
  return useMemo<SidebarGroup[]>(() => {
    // Existing groups...
    const groups: SidebarGroup[] = [
      { label: 'Operations', items: [/* unchanged */] },
      { label: 'Planning',   items: [/* unchanged */] },
      { label: 'Insights',   items: [/* unchanged */] },
    ];
    // Spec 012b — super-admin only: Brands tenancy management section.
    // Lands at the very bottom under a new "Tenancy" group label so it
    // visually separates from operational sections. Filtered out entirely
    // for non-super-admin users so applySidebarOverride has nothing to
    // operate on (sidebarLayout.ts silently drops unknown ids).
    if (isSuperAdmin) {
      groups.push({
        label: 'Tenancy',
        items: [
          { id: 'Brands', label: 'Brands' },
        ],
      });
    }
    return groups;
  }, [isSuperAdmin]);
}
```

**Sidebar item id `'Brands'`** — matches `section === 'Brands'` dispatch in `InventoryDesktopLayout.tsx`. **Sidebar group label `'Tenancy'`** — distinct from the umbrella's working title "Tenants" but it's a group label, not the item label. The item label is "Brands" per Q-USER-12b-3.

#### Section dispatch wire-up

[src/screens/cmd/InventoryDesktopLayout.tsx:146-181](../src/screens/cmd/InventoryDesktopLayout.tsx) — add a new branch in the section ladder:

```tsx
) : section === 'Brands' ? (
  <BrandsSection />
) : section !== 'Inventory' ? (
  // Existing ComingSoonPanel fallback
```

Place `Brands` before the `section !== 'Inventory'` fallback so the explicit dispatch wins.

**Defensive gate inside `BrandsSection`:** even though the sidebar item is filtered out for non-super-admins, defensively render an empty state (or redirect to Inventory via paletteAction) if a non-super-admin somehow lands on the section (e.g. URL trickery, palette-action injection). **Decision:** render a simple "Not available" panel + log a console.warn. Acceptable.

#### `BrandsSection.tsx` layout

New file `src/screens/cmd/sections/BrandsSection.tsx`. Two-pane list+detail (mirrors VendorsSection.tsx).

**List pane (340 px wide on desktop, full-width on phone):**

- Header: `Type.h2` "Brands" + count "{N} brands".
- "+ NEW BRAND" button at top-right of header.
- Filter input (reuse `FilterInput`).
- `FlatList` of brand rows. Each row:
  - Left: brand name (`sans(600)`, `fontSize: 13`, `C.fg`).
  - Right: `mono(400)` muted text "{storeCount} stores · {memberCount} admins".
  - Subtle status pill if `deleted_at !== null` (e.g. soft-deleted indicator). Per Q-PM-11, soft-deleted brands appear in the list with the pill but cannot be picked from the brand picker. **However**, per the spec's "in scope (012b)" decision, all brands shown have `deleted_at IS NULL` — keep this acceptance-criterion-aligned and don't render soft-deleted in 012b. (The pill is described in Q-PM-11 but never gets exercised in 012b because no soft-deleted brands exist yet — 012c creates them.)

**Detail pane (right-side, fills remaining width):**

- Tab strip: `profile.tsx` | `members.tsx` | `stores.tsx` (mirrors VendorsSection's tab pattern).
- `profile.tsx` tab: brand metadata (name, id short form, created_at) in `PropertiesJson` widget.
- `members.tsx` tab: read-only list of admins for the brand (name, email, role pill, status pill, store count). "+ INVITE ADMIN" button at top.
- `stores.tsx` tab: read-only list of stores in the brand (name, address, status). No store-CRUD here — stores are managed through the existing per-brand admin flow once super-admin context-switches into the brand.

#### "+ NEW BRAND" button → `BrandFormDrawer`

Opens `BrandFormDrawer` (new file `src/components/cmd/BrandFormDrawer.tsx`). Fields:

- `name` (required, unique within brands table — DB UNIQUE constraint enforces).

That's it for v1. Renaming is out of scope per the spec.

On submit:
1. Optimistic insert into local `brands` slice (see Zustand wiring in §5).
2. Call `db.createBrand(name)`.
3. On success, replace temp id with server-assigned UUID. Toast "Created {name}".
4. On failure, revert the optimistic insert via `notifyBackendError`. Toast surfaces the RLS error if super-admin promotion didn't apply.

Drawer presentation — uses `ResponsiveSheet`:
- desktop: right-anchored 480 wide (smaller than the 760 default — single-field form doesn't need the wider canvas).
- tablet: bottom-sheet @ 0.5 of viewport.
- phone: full-screen.

**Brands list cache:** super-admin needs the full brands list to render the Brands section AND to populate the brand picker. Add a new Zustand slice `brands: Brand[]` (already declared in `AppState` for the *active* brand only — repurpose to hold the full list when super-admin is logged in). Wait — there's already a `brand: Brand | null` slice. Don't conflate. **Add a new slice `brandsList: Brand[]`** (note plural). Populate at login for super-admin only; non-super-admin gets an empty list (they don't need it). Refetch after `createBrand`.

Add to AppState:
```ts
/** Spec 012b — full brands list (super-admin only). Empty array for non-super-admin
 *  since the brand picker / Brands section are hidden for them. */
brandsList: Brand[];
```

#### Detail view: members list

Renders the result of a new `db.fetchBrandAdmins(brandId)` call (see §5). Each row:

```
{name}  {role-pill}  {email}  {storeCount}-stores  {status-pill}
```

No edit/delete affordances in 012b. The "+ INVITE ADMIN" button at the top of this tab opens `InviteAdminDrawer` (see §4).

#### Detail view: stores list

Renders `stores.filter(s => s.brandId === selectedBrandId)`. The `stores` slice is already loaded into Zustand (the list is stored brand-agnostic, but each row carries `brandId`). Read-only — name, address, status, createdAt.

---

### §4 — Admin invitation flow rebuild

#### `InviteAdminDrawer` form

New file `src/components/cmd/InviteAdminDrawer.tsx`. Lives inside `BrandsSection`'s detail view (members tab). Wraps `ResponsiveSheet` with desktop 600 wide / tablet bottom-sheet / phone fullscreen.

Fields:

| Field | Required | Notes |
|---|---|---|
| Email | yes | Lowercased on submit. Unique against existing pending invites. |
| Name | yes | Display name. |
| Brand | yes (picker for super-admin; read-only for brand-admin) | Defaults to the brand whose detail view is open. Super-admin can override (rare); brand-admin sees only their own brand and the field is disabled. |
| Role | yes | Radio: `'admin'` (default) / `'user'`. NOT `'super_admin'` per umbrella Q2. |
| Stores | yes | Multi-select checkboxes. Filter to selected brand's stores. Default: all stores in the brand (per Q-PM-9 — keeps Bobby-style legacy parity). |

Submit handler calls the *extended* `inviteUser`:

```ts
inviteUser({
  email: values.email.trim(),
  name: values.name.trim(),
  role: values.role,
  brandId: values.brandId,
  storeIds: values.storeIds,
  storeNames: storeIds.map(id => stores.find(s => s.id === id)?.name).filter(Boolean).join(', '),
});
```

On success: close drawer, toast "Invitation sent to {email}", refetch the brand's admins list (new admin shows as a pending row).

On failure: toast the error via `notifyBackendError`. Drawer stays open so user can fix and retry.

#### Extended `inviteUser` signature

[src/lib/auth.ts:125](../src/lib/auth.ts) — change to an options-object signature for forward compat:

```ts
export interface InviteUserOptions {
  email: string;
  name: string;
  role: 'admin' | 'user';
  brandId: string | null;       // required for role='admin'; null allowed for role='user'
  storeIds: string[];
  storeNames?: string;          // optional pre-formatted list for the email template
}

export async function inviteUser(opts: InviteUserOptions): Promise<{ error: string | null }>;
```

**Body change:** the `invitations` INSERT now writes `brand_id: opts.brandId`. Everything else unchanged.

```ts
const { error: inviteError } = await supabase.from('invitations').insert({
  email: opts.email.toLowerCase(),
  profile_id: '00000000-0000-0000-0000-000000000000',
  name: opts.name,
  role: opts.role,
  store_ids: opts.storeIds,
  brand_id: opts.brandId,  // NEW — load-bearing for §1's CHECK
});
```

**Pre-flight validation:** if `opts.role === 'admin' && !opts.brandId`, return `{ error: 'Admin invitations require a brand assignment' }` before hitting the network. This matches the DB CHECK from 012a.

**Back-compat shim:** the legacy positional signature `inviteUser(email, name, role, storeIds, storeNames?)` is *not* preserved. The only consumer outside `AdminScreens.tsx` is `useStore.inviteUser` action ([src/store/useStore.ts:125](../src/store/useStore.ts) — that's a different `inviteUser` on the store, used by AdminScreens to wrap the auth call). The Cmd UI has zero existing callers, so no shim is needed.

**`AdminScreens.tsx` (legacy) impact:** TS will flag the legacy call site as broken. **Per CLAUDE.md, AdminScreens.tsx is off-limits** — but a typecheck failure breaks the build for everyone. **Resolution:** leave a thin back-compat positional wrapper in `auth.ts` that delegates to the new options form, marked `@deprecated`:

```ts
/** @deprecated — use the options-object form. Kept for AdminScreens.tsx (legacy). */
export async function inviteUserLegacy(
  email: string, name: string, role: 'admin' | 'user',
  storeIds: string[], storeNames?: string,
): Promise<{ error: string | null }> {
  return inviteUser({ email, name, role, storeIds, storeNames, brandId: null });
}
```

Then update `AdminScreens.tsx`'s import to call `inviteUserLegacy` (smallest possible change — one identifier rename, not a logic change). **Under CLAUDE.md's "minimal changes to legacy" reading, this is acceptable** — we're not adding functionality, just keeping it compiling. Surface this as an open question to the PM if the developer thinks even the import rename is too invasive; alternative is to keep the original `inviteUser` signature and add a sibling `inviteAdmin(...)` function — bookkeeping overhead, but safer. **PM default applied: rename the legacy call site** (one line in AdminScreens.tsx).

Actually — re-reading CLAUDE.md: "Agents must NOT add new functionality to this file. If a task seems to require modifying AdminScreens.tsx, surface as a question first." A pure call-site rename to keep the build green is not "new functionality"; it's a refactor to keep an existing call site working after a signature change. **Architect's call: this is fine to do, but flag for PM acknowledgment in handoff so they can override.**

#### Extended `registerInvitedUser` (the load-bearing fix)

[src/lib/auth.ts:169-229](../src/lib/auth.ts) — extend the profile INSERT to include `brand_id`:

```ts
// After get_pending_invitation returns `invitation` with the new `brand_id` field…

const { error: profileError } = await supabase.from('profiles').insert({
  id: authData.user.id,
  name: invitation.name,
  role: invitation.role,
  initials: invitation.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
  color: '#378ADD',
  status: 'active',
  brand_id: invitation.brand_id,  // NEW — load-bearing per Risks #1
});
```

**Defensive validation BEFORE the INSERT:**
```ts
if (invitation.role === 'admin' && !invitation.brand_id) {
  return {
    user: null,
    error: 'Invitation is missing a brand assignment. Please ask your admin to re-issue the invite.',
  };
}
```

This catches the migration-window case where a legacy invitation row with `brand_id IS NULL` somehow gets registered post-012b — the user gets a comprehensible error instead of a Postgres CHECK violation.

#### `RegisterScreen` post-flow audit

[src/screens/RegisterScreen.tsx](../src/screens/RegisterScreen.tsx) — the screen consumes `registerInvitedUser`. It only reads `result.error` and `success`; it does NOT introspect the returned user object or reach into the invitation. **Confirmed unchanged** post-rebuild. After registration the user clicks "Go to Sign in", logs in normally; the new `profiles` row's `brand_id` is read by `fetchProfile` and surfaced as `User.brandId`. Brand-admin then sees the right brand's data. Per Risks #3 in this design — verified.

---

### §5 — Files to create / modify

#### New files

1. **`supabase/migrations/20260510000000_invitations_brand_id.sql`** — additive migration (§1). ~30 lines.
2. **`src/screens/cmd/sections/BrandsSection.tsx`** — list + detail two-pane (§3). ~300 LOC.
3. **`src/components/cmd/BrandFormDrawer.tsx`** — "+ NEW BRAND" form (§3). ~150 LOC. Uses `ResponsiveSheet`.
4. **`src/components/cmd/InviteAdminDrawer.tsx`** — invite admin form (§4). ~250 LOC. Uses `ResponsiveSheet`.
5. **`src/components/cmd/BrandPicker.tsx`** — header dropdown + compact phone variant (§2). ~180 LOC.

#### Modified files

| File | Change |
|---|---|
| [src/types/index.ts](../src/types/index.ts) | Extend `UserRole` with `'super_admin'`. Add `User.brandId?`. Add `AppState.currentBrandId` and `AppState.brandsList`. |
| [src/lib/auth.ts](../src/lib/auth.ts) | New `InviteUserOptions`. Refactor `inviteUser` to options-object signature, write `brand_id`. Extend `registerInvitedUser` to write `profiles.brand_id` from invitation, with pre-flight validation. Populate `User.brandId` from `profile.brand_id` in `fetchProfile`. Add deprecated `inviteUserLegacy` shim for AdminScreens.tsx. Add `fetchAllUsers` overload that takes `{ brandId? }` and filters server-side via `.eq('brand_id', brandId)` (used by `BrandsSection` members tab). |
| [src/lib/db.ts](../src/lib/db.ts) | New: `fetchBrandsLite()` returns `{ id, name, deletedAt }[]` for picker; `fetchBrandsWithStats()` returns `{ id, name, createdAt, storeCount, memberCount, deletedAt }[]` for the Brands list (left-pane render). New: `createBrand(name: string)` — INSERT into `brands` returning the new row; on duplicate, throws (caller surfaces via `notifyBackendError`). New: `fetchBrandAdmins(brandId: string)` — SELECT profiles WHERE brand_id = $1 AND role = 'admin', join `user_stores` for store count, also pull pending invitations for the same brand. Returns `User[]` shape. |
| [src/lib/cmdSelectors.ts](../src/lib/cmdSelectors.ts) | `useDefaultSidebarGroups()` conditionally appends a "Tenancy" group with the "Brands" item, gated on `useIsSuperAdmin()`. |
| [src/store/useStore.ts](../src/store/useStore.ts) | Add `currentBrandId: string \| null` slice (initial null) + `setCurrentBrandId(brandId)` action with brand-switch logic (§2). Add `brandsList: Brand[]` slice + `loadBrandsList()` action (called at login for super-admin). Add `createBrand(name)` action (optimistic insert, calls `db.createBrand`, reverts on failure). Audit-site fix at `setCurrentStore.__all__` fallback (`useStore.ts:269`) to include `'super_admin'`. Clear `imr.cmd.superAdmin.activeBrand` localStorage on login. |
| [src/hooks/useRole.ts](../src/hooks/useRole.ts) | Add new export `useIsSuperAdmin()`. Existing `useRole()` stays unchanged. |
| [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) | **No code change.** The `[storeId, brandId, onSync]` deps already cause channel re-subscription when the brand switches. Verify in §6. |
| [src/navigation/CmdNavigator.tsx](../src/navigation/CmdNavigator.tsx) | **No code change.** `useStore((s) => s.brand?.id)` continues to read the right value because `loadFromSupabase` writes `brand` after fetching. |
| [src/components/cmd/TitleBar.tsx](../src/components/cmd/TitleBar.tsx) | Add optional prop `brandPicker?: React.ReactNode`. Render in the header row between the breadcrumb store-switcher and the connection indicator. Audit-site fix at line 36 (`isAdmin` check) to include `'super_admin'`. |
| [src/components/cmd/MobileTopAppBar.tsx](../src/components/cmd/MobileTopAppBar.tsx) | **No code change.** `trailing` prop already exists ([line 13, 82](../src/components/cmd/MobileTopAppBar.tsx)). Shell consumes it. |
| [src/screens/cmd/ResponsiveCmdShell.tsx](../src/screens/cmd/ResponsiveCmdShell.tsx) | Build `brandPickerSlot` and `brandPickerCompact` based on `useIsSuperAdmin()`. Pass `brandPicker={brandPickerSlot}` to `TitleBar` (both desktop and tablet branches); pass `trailing={brandPickerCompact}` to `MobileTopAppBar` (phone branch). |
| [src/screens/cmd/InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx) | Add `section === 'Brands' ? <BrandsSection /> : …` branch in the section ladder before the ComingSoonPanel fallback. |
| [src/components/cmd/RoleBadge.tsx](../src/components/cmd/RoleBadge.tsx) | Accept `role?: 'super_admin' \| 'admin' \| 'user' \| 'master'` prop. Render label uppercase + 2-letter glyph variant. Color the SUPER ADMIN variant distinctively (use `C.warn` border + bg or a separate accent — developer's call within the existing palette tokens). Update consumer in `MobileNavDrawer.tsx` line 74 to pass `<RoleBadge role={currentUser?.role} />`. Confirm no other consumers (grep `<RoleBadge`). |
| [src/screens/AdminScreens.tsx](../src/screens/AdminScreens.tsx) | **One-line change only:** rename `inviteUser` import to `inviteUserLegacy`. Per CLAUDE.md surface this for PM acknowledgment in handoff. |
| [src/screens/RegisterScreen.tsx](../src/screens/RegisterScreen.tsx) | **No code change.** Already opaque to the registration flow internals. Verified §4. |

#### `db.ts` surface signatures

```ts
// Lightweight brands list for the picker. Excludes soft-deleted by default.
export async function fetchBrandsLite(opts?: {
  includeSoftDeleted?: boolean;
}): Promise<Array<{ id: string; name: string; deletedAt: string | null }>>;

// Brands list with stats for the left-pane render. One round-trip with
// LEFT JOIN against stores + profiles for counts.
export async function fetchBrandsWithStats(): Promise<Array<{
  id: string;
  name: string;
  createdAt: string;
  storeCount: number;
  memberCount: number;
  deletedAt: string | null;
}>>;

// INSERT a new brand. RLS gates this to super-admin via super_admin_manage_brands
// policy from 012a. Throws on duplicate-name (unique constraint).
export async function createBrand(name: string): Promise<Brand>;

// Members for a specific brand (admins + their store counts + pending invitations).
// Returns User[] shape (with status='active' for joined profiles, status='pending' for invitations).
export async function fetchBrandAdmins(brandId: string): Promise<User[]>;
```

snake_case → camelCase mapping done locally in each fetcher — same pattern as the rest of `db.ts`.

#### Audit-site enumeration (re-stated for completeness)

Sites that need `'super_admin'` added once `User.role` widens:

1. [src/components/cmd/TitleBar.tsx:36](../src/components/cmd/TitleBar.tsx) — `isAdmin` short-circuit (so super-admin sees all stores in the picker).
2. [src/store/useStore.ts:269](../src/store/useStore.ts) — `setCurrentStore.__all__` fallback.

Sites that **don't** need a change (verified):
- All `userRole: get().currentUser?.role || 'user'` audit-log writers — value flows through, no comparison.
- All `profile.role === 'master'` display-name overrides in `auth.ts` — `'master'` keeps its display behavior; `'super_admin'` doesn't need a special display name in 012b (the RoleBadge surfaces it).
- All references in `AdminScreens.tsx` — frozen file, `User.role` widens compatibly.

Developer should run `npx tsc --noEmit` after the type widen and `grep -nE "(role === '(admin|master|user)')" src/` (excluding legacy paths) to verify.

---

### §6 — Verification probes

The user runs these in local dev. Per CLAUDE.md "Verify UI with preview tools" rule, the developer runs the browser walk via `mcp__claude-in-chrome__*` tools at each width before flipping `Status: READY_FOR_REVIEW`.

#### Width walk (Spec 011 §6 pattern)

Six widths: `1440 / 1180 / 1024 / 768 / 414 / 360`. At each, two passes:

**Pass A — local super-admin** (run §6 Probe 5 SQL from 012a's spec to promote `admin@local.test` to super_admin temporarily; revert after).

| Width | Tier | Brand picker visible? | Brands sidebar item visible? | "+ NEW BRAND" usable? | "+ INVITE ADMIN" usable? |
|---|---|---|---|---|---|
| 1440 | desktop | yes (TitleBar) | yes (Tenancy group) | yes (right-anchored drawer) | yes (right-anchored drawer) |
| 1180 | desktop | yes (TitleBar) | yes | yes (right-anchored drawer) | yes (right-anchored drawer) |
| 1024 | tablet | yes (TitleBar) | yes (sidebar / rail) | yes (bottom-sheet) | yes (bottom-sheet) |
| 768 | tablet (boundary) | yes | yes | yes (bottom-sheet) | yes (bottom-sheet) |
| 414 | phone | yes (MobileTopAppBar.trailing, compact 2-letter) | yes (MobileNavDrawer) | yes (full-screen modal) | yes (full-screen modal) |
| 360 | phone (smallest) | yes (truncated section title is OK per existing behavior) | yes | yes | yes |

**Pass B — brand-admin** (revert local user to `role='admin'`; re-login):

| Width | Brand picker visible? | Brands sidebar item visible? |
|---|---|---|
| All 6 widths | NO | NO |

#### Functional probes

1. **Brand-switch re-fetches data.** Super-admin switches from "All brands" → 2AM PROJECT in the picker. Verify: catalog/recipes/preps/vendors slices update; `currentStore` resolves to first 2AM store; realtime channel `brand-2a000000-…` is subscribed (check `supabase.realtime.channels` in browser console).
2. **Switch back to All brands.** Super-admin picks "All brands" → page navigates to Brands section; `currentStore` clears; brand-scoped data slices stay populated (no thrashing — switching to All brands does NOT trigger a refetch).
3. **"+ NEW BRAND" creates a brand.** Open drawer, enter "TEST BRAND C", submit. Brand appears in the Brands list AND in the picker dropdown. RLS allows because super-admin.
4. **"+ INVITE ADMIN" assigns brand + stores correctly.** Open invite form on TEST BRAND C's detail view. Pre-filled brand = TEST BRAND C. Pick a store (must exist in TEST BRAND C — for a fresh brand the list is empty, so this needs a seeded store first; document that in the test plan). Submit. Verify: invitations row exists with correct `brand_id` and `store_ids`.
5. **Registered admin gets correct `profiles.brand_id`.** Open `/register`, sign up with the invited email. Log in. Verify in DB: `profiles.brand_id = TEST BRAND C uuid`. Cmd UI brand-implicitly loads TEST BRAND C data only.
6. **No console errors.** At every width, every action, the browser dev console stays clean. (Yellow Realtime warnings about Native driver are pre-existing per `ResponsiveSheet`.)
7. **Spec 008 override unaffected for brand-admin.** Brand-admin user logs in, customizes sidebar (drag/hide). The "Brands" item is never present in their default groups, so no override entry references it. Verified by inspecting `profiles.sidebar_layout` — no entry with `id: 'Brands'`.
8. **Spec 008 override CAN customize "Brands" for super-admin.** Super-admin enters edit mode, drags Brands into a different group, saves. Reload. Brands renders in the new position.
9. **Realtime channel verification.** With browser dev tools open, confirm: switching brand drops the old `brand-{old}` channel and subscribes to `brand-{new}`. The `useRealtimeSync` `useEffect` cleanup runs.
10. **Latent invite bug fixed (§4 load-bearing).** Without 012b's fix, this test would fail; with it, registering an admin invite ends with a `profiles` row whose `brand_id` matches the invitation's `brand_id`. Compare row pre/post.

---

### §7 — Risks and tradeoffs

Re-stated and extended from the PM's risks. Architectural risks added.

1. **Latent invite bug from 012a — fix lands in §4 of this spec.** Per Risks #1 in the PM's spec. Load-bearing — without the §4 changes (`registerInvitedUser` writes `brand_id`, `inviteUser` writes `brand_id`, `get_pending_invitation` returns `brand_id`), the next admin invite from prod will fail at the `profiles` INSERT (CHECK violation). The user has agreed to NOT invite new admins via the existing prod flow until 012b ships. **This decision is auditable.** Reviewers must NOT push back on the deferred-fix path or recommend a hotfix.

2. **Existing `user_stores` for Bobby.** Per PM Risks #2. The new invite UI defaults the store multi-select to "all stores in the brand" so legacy admins are not silently scoped down. A future cleanup spec backfills explicit `user_stores` rows for existing admins — out of scope for 012b.

3. **Brand-switch refetch UX flicker.** When super-admin switches brands, `setCurrentBrandId → setCurrentStore → loadFromSupabase` runs. The brand-scoped slices are *replaced* (not zeroed first then refilled) — so screens briefly show old brand's data until fetch completes. **Decision:** accept the flicker; it matches the existing store-switch behavior. Alternative would be to clear the slices to `[]` first, but that causes a more jarring "everything blank → everything appears" sequence. Document as known UX gap. Per Risks #6 below — same accept-the-loss reasoning.

4. **Realtime channel swap mid-render race.** When brand switches, the new `loadFromSupabase` fetch is in flight while `useRealtimeSync` cleanup-and-re-subscribes for the new channel. If a realtime event fires during the gap (highly unlikely but theoretically possible), the 400ms debounce in `CmdNavigator.tsx` collapses it into the next reload tick anyway. **Acceptable risk.**

5. **`'__all__'` collision avoided by design.** Per Risks #5 in PM spec. Solution: don't introduce a new sentinel string at all. `currentBrandId: string | null`, where `null` IS the "all brands" state. No collision possible.

6. **Brand picker affects every section's data.** Per Risks #6 in PM spec. PM default accepted: switching brand mid-edit silently discards in-progress changes (no unsaved-changes infrastructure exists). Document as known UX gap; out of scope to add a `confirmAction` prompt now.

7. **TypeScript strict mode audit.** Per Risks #7 in PM spec. Two active call sites (TitleBar.tsx:36, useStore.ts:269) need explicit `'super_admin'` extensions. Developer runs `npx tsc --noEmit` post-widen and greps for `=== 'admin'` / `=== 'master'` to catch any I missed. Legacy AdminScreens.tsx is compatible without changes.

8. **`AdminScreens.tsx` (legacy) compile-break from `inviteUser` signature change.** Per §4 — solved by adding `inviteUserLegacy` deprecated shim and renaming the import in AdminScreens.tsx. Single-line change to the legacy file. **Surface in handoff for PM acknowledgment** in case PM prefers the alternative (sibling function `inviteAdmin`, leave `inviteUser` untouched).

9. **`profile.brand_id` populated by `fetchProfile`** — relies on RLS letting the user read their own row. The init-schema "Own profile" policy (`auth.uid() = id`) covers this. The 012a `super_admin_read_all_profiles` is additive. No regression.

10. **`get_pending_invitation` return-set widening** — adds one column. Existing callers (`registerInvitedUser`) will receive an additional field; non-breaking because we extend the consumer in the same PR. Anonymous calls still allowed via the `grant execute` re-issue.

11. **Registration acceptance flow (`registerInvitedUser`) consumed by RegisterScreen.** Per §4 verification — RegisterScreen reads only `result.error` and `result.user.error`; opaque to the new `brand_id` write. **Confirmed unaffected.**

12. **No CI gate.** Per CLAUDE.md, the `.github/workflows/db-migrations-applied.yml` workflow doesn't exist on disk. Manual: developer applies the migration locally via `supabase db reset` (or just `supabase migration up` against the running stack), runs §6 probes. User runs `supabase db push --linked` manually post-merge. Document in handoff.

13. **No realtime publication change.** The migration adds a column to an existing table and re-creates an RPC. No `alter publication supabase_realtime add/drop table`. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply to this migration. (Documented for completeness.)

14. **Brand picker on phone (Risks #3 from PM).** Mitigated by compact 2-letter prefix + chevron in the ~32px trailing slot. Tap opens full-screen modal. Section title truncates with existing `numberOfLines={1}`. No layout-stack reflow needed.

15. **`fetchBrandAdmins` cross-table join at the PostgREST layer.** Joining `profiles` with `user_stores` for store counts can be done either with a `select('*, user_stores(count)')` PostgREST embed OR a separate count query per row. **Architect's recommendation:** start with the embed pattern; if performance is a concern (unlikely with single-digit admin counts per brand), switch to a server-side view in 012c. Single-tenant prod has 3 admins; 10x scale is still fine.

---

## Files to be created / changed (final list)

**New:**
- `supabase/migrations/20260510000000_invitations_brand_id.sql`
- `src/screens/cmd/sections/BrandsSection.tsx`
- `src/components/cmd/BrandFormDrawer.tsx`
- `src/components/cmd/InviteAdminDrawer.tsx`
- `src/components/cmd/BrandPicker.tsx`

**Modified:**
- `src/types/index.ts`
- `src/lib/auth.ts`
- `src/lib/db.ts`
- `src/lib/cmdSelectors.ts`
- `src/store/useStore.ts`
- `src/hooks/useRole.ts`
- `src/components/cmd/TitleBar.tsx`
- `src/screens/cmd/ResponsiveCmdShell.tsx`
- `src/screens/cmd/InventoryDesktopLayout.tsx`
- `src/components/cmd/RoleBadge.tsx`
- `src/components/cmd/MobileNavDrawer.tsx` — one-line update where it renders `<RoleBadge />` (pass real role)
- `src/screens/AdminScreens.tsx` — one-line import rename to `inviteUserLegacy` (legacy file; surface for PM acknowledgment)

**Unchanged (verified, no edits expected):**
- `src/hooks/useRealtimeSync.ts` — call-site already deps on `brandId`.
- `src/navigation/CmdNavigator.tsx` — reads `brand?.id` correctly post-switch.
- `src/components/cmd/MobileTopAppBar.tsx` — `trailing` slot already exists.
- `src/screens/RegisterScreen.tsx` — opaque to invitation internals.
- `supabase/functions/send-invite-email/` — payload sufficient as-is.
- `supabase/functions/delete-user/` — out of 012b scope.

## Deploy steps (developer hand-off to user)

1. Apply migration locally: `supabase migration up` (or `supabase db reset` for a clean slate).
2. Run §6 width walk + functional probes against local. Fix any console errors.
3. Set Status to READY_FOR_REVIEW; list files changed under `## Files changed`.
4. After review fan-out + release-coordinator approval + commit, **the user runs prod migration push manually**: `supabase db push --linked` from a clean checkout.
5. After prod apply, the user logs in as `wzhchen113@gmail.com`, sees the Brands sidebar item, sees the brand picker, and can perform the §6 functional probes against prod.

The user runs the prod migration push. Do NOT auto-apply.

---

## Build notes (frontend-developer, 2026-05-08)

### Migration applied locally

- `supabase/migrations/20260510000000_invitations_brand_id.sql` applied
  cleanly via `npx supabase migration up`. Verified the column,
  partial index, FK constraint, and the widened
  `get_pending_invitation` RPC return signature via psql.
- **Deviation from architect §1:** the architect's design used
  `create or replace function` to widen `get_pending_invitation`'s
  return shape. Postgres rejects this with SQLSTATE 42P13 because the
  return-column set changed. Fixed by `drop function if exists` then
  `create function` in the same transaction. The `grant execute … to
  anon, authenticated` is re-issued post-create, matching the original
  012a security_fixes migration. No effect on rollout safety — the
  drop+create is atomic.

### Backend RLS gap surfaced

- **Super-admin can read invitations and write to `brands` (gated by
  012a's `super_admin_manage_brands` policy), but the existing
  `invitations` policies from 20260424211733_security_fixes.sql still
  gate INSERT/UPDATE/DELETE on JWT `app_metadata.role IN
  ('admin','master')`.** A pure super-admin profile (no admin/master
  app_metadata) would therefore be unable to issue invitations from
  the new `InviteAdminDrawer`, even though the UI is wired. In prod,
  `wzhchen113@gmail.com` likely has `app_metadata.role = 'admin'` from
  pre-012a (012a doesn't touch JWT claims), so this works in prod
  today. **Surface to security-auditor:** consider adding a
  super-admin clause to the four invitations policies so the spec is
  defended even if a clean super-admin without admin app_metadata is
  ever provisioned. Not blocking for this PR — prod state covers it.

### Active-brand persistence

- `imr.cmd.superAdmin.activeBrand` localStorage key is cleared inside
  `useStore.login` so a fresh sign-in always starts in "All brands"
  mode (matches the spec's "resets to All brands on next login"
  acceptance criterion).
- `App.tsx`'s session-restore path reads the cached value BEFORE
  calling `login()` (so the clear inside `login` doesn't wipe it),
  then re-applies via `setCurrentBrandId(stored)`. This keeps
  tab-reload behavior intact while honoring the
  reset-on-actual-login contract.

### useRole() augmentation

- Per architect §1, kept the existing `useRole()` returning `'admin'`
  for back-compat. Added a sibling `useIsSuperAdmin()` that reads the
  live `currentUser.role` from useStore. New code uses
  `useIsSuperAdmin()` exclusively.

### Audit-site extensions for `'super_admin'`

- `src/components/cmd/TitleBar.tsx:36` extended.
- `src/store/useStore.ts:setCurrentStore __all__` fallback extended.
- Both per architect §1 — manually verified with `tsc --noEmit` no new
  exhaustiveness errors.

### Legacy AdminScreens.tsx touch

- Per architect §4, renamed the one `inviteUser` call site in
  `src/screens/AdminScreens.tsx` to `inviteUserLegacy` (the new
  back-compat shim added to `auth.ts`). This is a pure
  build-keep-green refactor — no logic change. CLAUDE.md "Legacy
  admin screens" rule is honored: no new functionality added; the
  rename is necessary to keep TS strict from blocking the build after
  `inviteUser` switched to options-object form.

### Cross-platform: web AND native

- `BrandPicker` compact mode (phone) uses RN `Modal` + `FlatList` —
  works on both web and native.
- The web-only portaled dropdown (desktop/tablet) is gated with
  `Platform.OS === 'web'` and `require('react-dom')` is wrapped in a
  try/catch via `React.useMemo` so native builds never resolve
  react-dom.
- `localStorage`/`AsyncStorage` switch in `persistActiveBrandLocal` /
  `clearActiveBrandLocal` mirrors the existing `darkMode` persistence
  pattern.

### TypeScript

- `npx tsc --noEmit` against the touched files reports zero NEW
  errors. The one new diagnostic (`BrandPicker.tsx(236,65): error
  TS7016 'react-dom' module declaration not found`) is the same
  pre-existing diagnostic that already affects `TitleBar.tsx(3,30)`
  — it's a project-level missing `@types/react-dom` issue, not
  introduced here.
- Bundle compiles successfully (verified via `curl
  http://localhost:8082/App.bundle?platform=web&dev=true&hot=false`
  — HTTP 200, 14 MB, contains references to all four new
  components: `BrandPicker`, `BrandsSection`, `BrandFormDrawer`,
  `InviteAdminDrawer`).

### §6 verification probes — NOT EXERCISED LIVE

- **Cannot drive the browser.** This dispatch only had access to
  filesystem + bash tools; the `mcp__claude-in-chrome__*` /
  `mcp__Claude_Preview__*` MCP toolset that the spec assumes is not
  available in this run. Per the spec instructions: flagged
  transparently — main Claude has those tools and should drive the
  width-walk + functional-probes table for me, same pattern as Spec
  011's similar gap.
- TypeScript + bundle-compile + RLS migration smoke-checks all
  passed. Manual probes pending.
- **Local super-admin testing:** I did NOT promote
  `admin@local.test` to `super_admin` myself because that requires
  also setting `auth.users.raw_app_meta_data.role` to keep the
  invitations RLS happy (see "Backend RLS gap" above). When main
  Claude drives the probes, the snippet to run is documented in the
  spec's "Reminder" section + the additional `update auth.users set
  raw_app_meta_data = jsonb_set(raw_app_meta_data, '{role}',
  '"admin"') where email='admin@local.test';` to keep the JWT side
  in sync.

### Known UX gaps (per architect §7)

- Brand-switch flicker (old data flashes before new fetch
  completes) — accepted, matches existing store-switch behavior.
- Mid-edit brand switch silently discards in-progress changes — no
  unsaved-changes infrastructure exists; out of scope for 012b.
- Brand renaming, soft-delete, restore — out of scope, deferred to
  012c.

---

## Files changed

**New:**
- `supabase/migrations/20260510000000_invitations_brand_id.sql`
- `src/screens/cmd/sections/BrandsSection.tsx`
- `src/components/cmd/BrandFormDrawer.tsx`
- `src/components/cmd/InviteAdminDrawer.tsx`
- `src/components/cmd/BrandPicker.tsx`

**Modified:**
- `App.tsx` — restore the cached active brand for session-restore
  (read BEFORE login() runs the per-spec clear).
- `src/types/index.ts` — `UserRole` widened with `'super_admin'`;
  `User.brandId?` added; `Brand.deletedAt?`/`Brand.createdAt?` added;
  `AppState.currentBrandId` and `AppState.brandsList` added.
- `src/lib/auth.ts` — `inviteUser` switched to options-object
  signature with `brandId` field + pre-flight gate;
  `inviteUserLegacy` deprecated positional shim added;
  `registerInvitedUser` writes `profiles.brand_id` from the widened
  `get_pending_invitation` payload (load-bearing fix); `fetchProfile`
  populates `User.brandId`; `fetchAllUsers` accepts `{ brandId }`
  filter.
- `src/lib/db.ts` — `Brand` and `User` types imported; new
  `fetchBrandsLite`, `fetchBrandsWithStats`, `createBrand`,
  `fetchBrandAdmins`.
- `src/lib/cmdSelectors.ts` — `useDefaultSidebarGroups()` appends a
  "Tenancy" group with the "Brands" item only when
  `useIsSuperAdmin() === true`.
- `src/store/useStore.ts` — `currentBrandId` + `brandsList` slices
  added; `setCurrentBrandId`, `loadBrandsList`, `createBrand`
  actions; `login()` clears active-brand and loads brands list when
  super-admin; `logout()` clears active-brand; `setCurrentStore`
  `__all__` fallback extended for `'super_admin'`.
- `src/hooks/useRole.ts` — added `useIsSuperAdmin()` export
  alongside the existing back-compat `useRole()`.
- `src/components/cmd/TitleBar.tsx` — accepts optional
  `brandPicker` slot; `isAdmin` check extended to include
  `'super_admin'`.
- `src/screens/cmd/ResponsiveCmdShell.tsx` — wires `<BrandPicker />`
  into TitleBar (desktop + tablet) and `<BrandPicker compact />`
  into MobileTopAppBar.trailing (phone), gated by
  `useIsSuperAdmin()`.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — section dispatch
  branch `section === 'Brands' ? <BrandsSection /> : …` added
  before the ComingSoonPanel fallback.
- `src/components/cmd/RoleBadge.tsx` — accepts optional `role`
  prop; super-admin renders with the warn-toned variant for
  visual differentiation.
- `src/components/cmd/MobileNavDrawer.tsx` — passes the live
  `currentUser?.role` to RoleBadge so super-admin sees the
  distinctive badge.
- `src/screens/AdminScreens.tsx` — **single-line import rename**:
  `inviteUser` → `inviteUserLegacy`. Per CLAUDE.md "Legacy admin
  screens" rule, this is the only legacy-file touch and is a
  build-keep-green refactor (not new functionality). Architect
  §4 specifically authorized this.

**Unchanged (verified — no edits needed):**
- `src/hooks/useRealtimeSync.ts` — call-site already deps on
  `brandId` derived from `useStore((s) => s.brand?.id)`. When
  super-admin switches brands, `setCurrentBrandId →
  setCurrentStore → loadFromSupabase` writes the new brand and the
  hook's existing `useEffect` re-subscribes the channel.
- `src/navigation/CmdNavigator.tsx` — reads `s.brand?.id` which
  continues to flow through correctly.
- `src/components/cmd/MobileTopAppBar.tsx` — already had the
  `trailing` slot.
- `src/screens/RegisterScreen.tsx` — opaque to invitation
  internals; only reads `result.error`.
- `supabase/functions/send-invite-email/` — payload sufficient as-is.

---

## Cleanup bundle (applied 2026-05-09, pre-prod-push)

Applied inline after release-coordinator returned **FIXES_NEEDED** with
16 items (2 Critical convention violations + 1 AC FAIL + 6 Should-fix
+ 7 Nits). Per the established session pattern across Specs 010/011/012a,
the bundle landed pre-commit; per the release-coordinator's note this is
the SECURITY-BOUNDARY follow-up spec, so cleanup MUST also land before
prod migration push (not just before commit).

### Critical (architectural contract drift — CLAUDE.md convention)

- **Item 1** — `src/lib/auth.ts` — moved the `supabase.from('stores')`
  brand-store filter and `supabase.from('invitations')` email-inference
  sub-queries OUT of `fetchAllUsers` and INTO new `db.ts` helpers
  (`fetchStoreIdsForBrand`, `fetchInvitationsForUserLookup`).
  `fetchAllUsers` now delegates. PostgREST traffic flows through `db.ts`
  per CLAUDE.md.
- **Item 2** — `src/screens/cmd/sections/BrandsSection.tsx` — removed
  the direct `db.ts` imports. Added `brandStats` + `brandAdminsByBrandId`
  slices and `loadBrandStats` + `loadBrandAdmins` actions to `useStore`.
  `BrandsSection` now consumes the slices like every other section
  under `src/screens/cmd/sections/`.

### Should-fix (correctness + UX)

- **Item 3 (closes test-engineer FAIL)** — `src/lib/db.ts` and
  `src/screens/cmd/sections/BrandsSection.tsx` — added
  `catalogIngredientCount` to `fetchBrandsWithStats` SELECT (via
  `catalog_ingredients(count)` PostgREST embed) and rendered it in 4
  places: list-row sub-text, header summary, new "Ingredients" StatCard,
  PROPERTIES.JSON pane. Browser-verified: 2AM PROJECT shows 143
  ingredients, TEST BRAND B shows 1.
- **Item 4** — `src/lib/auth.ts` and `src/lib/db.ts` (`fetchBrandAdmins`)
  — replaced name-based invitation→profile email join with
  `profile_id`-first lookup, falling back to name. Two admins sharing a
  display name no longer get swapped emails.
- **Item 5** — `src/lib/db.ts` `fetchBrandsWithStats` — filtered the
  `profiles` PostgREST embed to `role IN ('admin','master','super_admin')`
  via `!inner` join + `.in()` filter, with a non-inner fallback so
  freshly-created brands without admins still surface (count = 0).
  Browser-verified: 2AM brand correctly shows "1 admin" instead of "3"
  (Bobby is the only admin; Charles is `user`, super-admin has NULL
  brand_id).
- **Item 6** — `src/store/useStore.ts` `createBrand` success path now
  calls `loadBrandStats()` so the BrandsSection list-pane reflects the
  new brand without requiring navigate-away-and-back. Resolved as a
  by-product of Item 2's store extraction.
- **Item 7** — `src/components/cmd/BrandFormDrawer.tsx` and
  `src/components/cmd/InviteAdminDrawer.tsx` keydown handlers —
  switched to the `useRef`-backed pattern so the handler always reads
  the latest `handleSave` closure. Removed the `eslint-disable` that
  papered over the stale-closure bug.
- **Item 8** — `src/theme/colors.ts` (LightCmd + DarkCmd) — added
  `accentFg` token (`#FFFFFF` on light, `#0E1014` on dark for contrast
  with `accent`). Replaced 7 inline `'#000'` literals across
  `BrandFormDrawer`, `InviteAdminDrawer`, and `BrandsSection` with
  `C.accentFg`. Dark-mode contrast now palette-correct.
- **Item 9** — `src/store/useStore.ts` and `App.tsx` — extracted
  `ACTIVE_BRAND_KEY` to a single export from `useStore.ts`; `App.tsx`
  imports it.

### Nits

- **Item 10** — `src/components/cmd/BrandPicker.tsx` — local FlatList
  sentinel renamed `'__all__'` → `'__all_brands__'` for future-reader
  clarity; added comment explaining why.
- **Item 11** — `src/screens/cmd/sections/BrandsSection.tsx` — added
  comment explaining the `tabId='profile.tsx'` filename-style mirrors
  `VendorsSection`.
- **Item 12** — moot after Item 2: the brittle `brandsList.length` dep
  was removed when the section migrated to store-backed slices.
- **Item 13** — `src/hooks/useRole.ts` — updated the stale "this file
  goes away" header comment to clarify that `useIsSuperAdmin()` is
  permanent; only the legacy `useRole()` placeholder is slated for
  removal.
- **Item 14** — `src/components/cmd/BrandFormDrawer.tsx` and
  `src/components/cmd/InviteAdminDrawer.tsx` — replaced inline
  `fontWeight: '600'` with `fontFamily: sans(600)` for typography
  consistency.
- **Item 15** — `src/lib/db.ts` `fetchBrandAdmins` — reworded the
  misleading "profiles table has email" comment in the email-fallback
  block.
- **Item 16** — `src/lib/db.ts` `fetchInvitationsForUserLookup` —
  scopes the invitations query with `.eq('brand_id', brandId)` when
  `brandId` is supplied so the table read doesn't span every tenant.

### Re-verification (post-cleanup)

- `npx tsc --noEmit` filtered to cleanup-bundle files (excluding
  pre-existing legacy errors): **0 new errors**. The one new error I
  introduced (missing `profile_id` in the `fetchBrandAdmins` invitations
  SELECT) was caught by tsc and fixed inline.
- Browser smoke at desktop 1440 (post-promote local user back to
  super_admin):
  - Catalog ingredient count visible in all 4 render sites ✅
  - Admins count correctly **1** (not 3) — role-filter working ✅
  - All other UI intact, zero console errors ✅
- Local DB user restored to `role='master'`, `brand_id=2AM` for end-of-
  session.

---

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of Spec 012b. Each reviewer writes
  its findings to `specs/012b-super-admin-ui/reviews/<your-name>.md`.
  Pay particular attention to:
  - The latent 012a invite bug fix in `src/lib/auth.ts`
    (`registerInvitedUser` writing `profiles.brand_id`,
    `inviteUser` accepting + persisting `brandId`) — load-bearing.
  - The migration `supabase/migrations/20260510000000_invitations_brand_id.sql`
    — applied locally only, not yet pushed to prod.
  - The "Backend RLS gap" called out in build notes — super-admin
    insert on `invitations` relies on JWT app_metadata having
    admin/master role. Prod state covers it; pure super-admin would
    not.
  - Responsive parity — the spec's §6 width walk (1440/1180/1024/
    768/414/360) was NOT exercised live by the developer (no
    browser-driving tools available). Manual verification required.
  - The `src/screens/AdminScreens.tsx` one-line import rename to
    `inviteUserLegacy` — per CLAUDE.md "Legacy admin screens", PM
    acknowledgment requested.
payload_paths:
  - specs/012b-super-admin-ui.md
  - supabase/migrations/20260510000000_invitations_brand_id.sql
  - src/screens/cmd/sections/BrandsSection.tsx
  - src/components/cmd/BrandFormDrawer.tsx
  - src/components/cmd/InviteAdminDrawer.tsx
  - src/components/cmd/BrandPicker.tsx
  - App.tsx
  - src/types/index.ts
  - src/lib/auth.ts
  - src/lib/db.ts
  - src/lib/cmdSelectors.ts
  - src/store/useStore.ts
  - src/hooks/useRole.ts
  - src/components/cmd/TitleBar.tsx
  - src/screens/cmd/ResponsiveCmdShell.tsx
  - src/screens/cmd/InventoryDesktopLayout.tsx
  - src/components/cmd/RoleBadge.tsx
  - src/components/cmd/MobileNavDrawer.tsx
  - src/screens/AdminScreens.tsx

---

## Original handoff (architect → developer)
next_agent: frontend-developer
prompt: Implement Spec 012b per the design at `specs/012b-super-admin-ui.md` § "Frontend design". This is a frontend-heavy spec with one tiny additive backend migration (`supabase/migrations/20260510000000_invitations_brand_id.sql`) — drop the migration alongside the frontend changes; no separate backend-developer pass. **Order of operations matters:** apply the migration FIRST (locally via `supabase migration up`), then code the frontend against the new schema. The §4 changes to `inviteUser` + `registerInvitedUser` are LOAD-BEARING — without them the next admin invite in prod fails the 012a CHECK. Run the §6 width walk (1440/1180/1024/768/414/360) AND functional probes 1–10 before flipping Status to READY_FOR_REVIEW. **Surface to PM in your build notes:** the AdminScreens.tsx one-line import rename to `inviteUserLegacy` (per §4) is the only legacy-file touch — confirm acceptable. Do NOT push the migration to prod; the user runs `supabase db push --linked` manually. Do NOT commit.
payload_paths:
  - specs/012b-super-admin-ui.md
  - specs/012a-multi-brand-schema-rls.md
  - specs/012-multi-brand-tenancy.md

