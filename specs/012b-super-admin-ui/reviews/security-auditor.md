# Security auditor findings — Spec 012b

Scope: Super-admin Cmd UI section (BrandPicker, BrandsSection, BrandFormDrawer,
InviteAdminDrawer), the `invitations.brand_id` migration + `get_pending_invitation`
RPC widen, the load-bearing `inviteUser` / `registerInvitedUser` rebuild in
`src/lib/auth.ts`, and surrounding plumbing.

## Critical (BLOCKING)

(none)

## Warnings

### W-1 — Invitations RLS still gates writes on JWT `app_metadata.role`, not on `auth_is_super_admin()`

- File: `supabase/migrations/20260424211733_security_fixes.sql:42-57`
  (existing policies; not edited by 012b)
- Affected paths in 012b: `src/lib/auth.ts:161` (DELETE expired),
  `src/lib/auth.ts:164-169` (SELECT existing), `src/lib/auth.ts:176-185` (INSERT new)
- The invitations `SELECT/INSERT/UPDATE/DELETE` policies all use:
  `((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))`.
  012a's `auth_is_super_admin()` (which reads `profiles.role`) is NOT referenced.
  012a deliberately decoupled the super-admin role from JWT app_metadata
  (see migration 20260509000000_multi_brand_schema_rls.sql:184-194) so super-admin
  cannot be forged by setting JWT claims. Net result: a *pure* super-admin
  (one whose `app_metadata.role` is NOT `admin`/`master`) cannot use the new
  `InviteAdminDrawer` at all — the INSERT will be RLS-rejected.
- The build notes call this out and state prod's `wzhchen113@gmail.com` likely
  still has admin app_metadata from pre-012a, so the path works in prod today.
  Verified: 012a's promotion `do$$ block (lines 290-319) sets
  `profiles.role = 'super_admin'` but does NOT change `auth.users.raw_app_meta_data`.
  Spec 012a's `sync_role_to_app_metadata` trigger may also not propagate
  `super_admin` to JWT (didn't audit further — orthogonal to 012b).
- This is a known gap, not a regression. **Not blocking**, but recommend either:
  1. Widen the four invitations policies to `... OR public.auth_is_super_admin()`
     in a follow-up tiny migration (preferred — defends the contract), OR
  2. Document that any future super-admin promotion must ALSO set
     `auth.users.raw_app_meta_data.role = 'admin'` to keep invitations RLS happy,
     OR
  3. Promote-to-super-admin SOP includes both updates as a single SQL block.
- Additional note: the `delete().lt('expires_at', now)` cleanup at
  `src/lib/auth.ts:161` runs scoped only by JWT-admin RLS — an admin from
  brand A can purge expired invitations from brand B. Cosmetic given
  expired-only filter, but worth noting if a future non-super-admin invite
  surface lands.

### W-2 — Invitations table read by `fetchBrandAdmins` not brand-scoped at RLS layer

- File: `src/lib/db.ts:1675-1683`
- The query filters `.eq('brand_id', brandId).eq('used', false)` client-side, but
  the existing invitations SELECT policy is JWT-admin only; it does NOT enforce
  `auth_can_see_brand(brand_id)`. A regular admin (via direct PostgREST) could
  read invitations for any brand. The new UI surface is super-admin-only and
  the row-set includes only `name/email/store_ids/brand_id` (no PII beyond the
  invitee's email/name), so the data-exposure blast radius is small. Suggest
  adding an `OR (auth_is_admin() AND brand_id = (select brand_id from profiles
  where id=auth.uid()))` clause to the invitations SELECT policy in the same
  follow-up that fixes W-1. Pre-existing condition; out of strict 012b scope.

### W-3 — `'master'` role + 012a CHECK ambiguity (latent, not introduced by 012b)

- File: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:341-348`
- The CHECK requires `master.brand_id IS NOT NULL`. `auth_is_admin()` (in the
  per-store-rls migration) treats master as admin; `inviteUser` accepts only
  `'admin' | 'user'` (`src/lib/auth.ts:138`). So a `'master'` profile cannot be
  CREATED via the new flow — it can only exist via the legacy seed/Supabase SQL
  editor. The current 012b code does not regress this. No action.

## Notes (what was checked)

### Frontend gating

- **`useIsSuperAdmin()` (`src/hooks/useRole.ts:22-25`)** reads
  `useStore((s) => s.currentUser?.role) === 'super_admin'`. `currentUser` is
  populated only by `fetchProfile` (`src/lib/auth.ts:61-105`) which reads the
  authoritative `profiles.role` server-side. There is no client-writable
  override path. A regular admin who forces the UI to expose the
  BrandPicker / BrandsSection still hits 012a's RLS at the wire:
  - `db.createBrand` (PostgREST INSERT into `brands`) is gated by
    `super_admin_manage_brands` (`auth_is_super_admin()`); RLS rejection.
  - `db.fetchBrandsLite` / `db.fetchBrandsWithStats` (SELECT brands) is gated
    by `brand_member_read_brands` — non-super-admin sees only their own brand.
  - `db.fetchBrandAdmins` SELECT on profiles requires
    `super_admin_read_all_profiles` for cross-user reads; non-super-admin
    sees only their own row via the existing "Own profile" policy.
  Hiding UI is not the security boundary; RLS is. Verified.

### Brand-creation write path

- `src/lib/db.ts:1638-1653` `createBrand(name)` issues a single PostgREST
  INSERT with only `{ name }`. `created_at` / `id` / `deleted_at` are
  server-defaulted. RLS gate `super_admin_manage_brands` enforces the
  super-admin check server-side. Non-super-admin attempt → 401/403, optimistic
  insert reverts via `notifyBackendError` (`src/store/useStore.ts:391-414`).
  Verified safe.

### Invite-admin write path

- `src/lib/auth.ts:150-202` `inviteUser({email,name,role,brandId,storeIds,…})`:
  - Pre-flight: rejects `role='admin' && !brandId` client-side (line 156-158)
    so the operator sees the error before hitting the wire.
  - Lowercases email (line 167, 177) — defensive against case-mismatch with
    `get_pending_invitation`'s `lower(p_email)` filter.
  - Inserts only declared fields; `profile_id` is the existing zero-UUID
    placeholder (matches schema convention from prior security_fixes
    migration). No SQL injection vector — all fields are bound parameters via
    PostgREST.
  - The non-blocking `send-invite-email` payload (line 191-196) includes
    `email`/`name`/`role`/`storeNames` only; no token / secret leaked.
- W-1 gates this write at the RLS layer in prod-with-app_metadata-admin
  (works today). See W-1.

### Register-invited-user data flow

- `src/lib/auth.ts:227-304` `registerInvitedUser(email,password,name)`:
  - Only `email` is used as the trust-bearing param. `password` and `name`
    are user-supplied for self-registration, but `name` is overwritten by
    `invitation.name` and `role`/`brand_id`/`store_ids` are read **only** from
    the server-side invitation row via `get_pending_invitation` RPC.
  - **A malicious user CANNOT register against a different brand_id than the
    super-admin assigned.** The brand_id is fetched server-side by email
    match; the client cannot inject brand_id, role, or store_ids via URL
    params or form fields.
  - Defensive validation (line 249-254) catches the migration-window case
    where a legacy invitation has `brand_id IS NULL` but `role='admin'` —
    user gets a clear error rather than a Postgres CHECK violation.
  - `consume_invitation` RPC (existing, security_fixes migration line 87-108)
    requires `auth.uid()` present + matching email + not-used + not-expired.
    Cannot be triggered anonymously; cannot mark someone else's invitation
    used.
  - `auth.signUp.options.data` (line 260) seeds JWT user_metadata with name+role.
    Note: `user_metadata` is user-writable in Supabase auth (vs `app_metadata`
    which is service-role-only). Existing pattern from 012a; not introduced
    here. The authoritative `role` is the `profiles.role` column read by
    `auth_is_super_admin()` and `auth_is_admin()`, NOT the JWT user_metadata.
    Safe.
  - One latent bug surfaced (out of strict 012b scope, but call-out): the
    `for (storeId of storeIds)` loop on line 286-288 iterates `invitation.store_ids`
    raw. If a super-admin issued an invitation with cross-brand store_ids
    (e.g. via legacy SQL or a buggy UI), the loop would attempt the inserts
    individually. The 012a `user_stores_brand_match` trigger
    (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357-386`)
    rejects cross-brand inserts at the table layer, so the worst case is
    a partial assignment + silent failure (no error surfaced to user). The new
    `InviteAdminDrawer` already filters store options by selected brand
    (`src/components/cmd/InviteAdminDrawer.tsx:48-51`), so the new flow
    cannot create such bad invitations. Pre-existing risk; out of strict
    012b scope.

### Migration audit (`20260510000000_invitations_brand_id.sql`)

- `ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.brands(id)
  ON DELETE CASCADE` — additive, idempotent. **CASCADE on brand delete is
  correct** (defense-in-depth — pending invitations for a deleted brand are
  pointless and should not survive).
- Column is nullable for back-compat with pre-012b invitations and `role='user'`
  (staff app users with no brand scope). Nullability is enforced indirectly
  via the load-bearing `profiles_role_brand_consistent` CHECK at registration
  time — a NULL brand_id with `role='admin'` will fail the CHECK and is
  caught defensively pre-INSERT (`src/lib/auth.ts:249-254`).
- `CREATE INDEX IF NOT EXISTS invitations_brand_id_idx … WHERE brand_id IS NOT NULL`
  — partial index. No security implication.
- `DROP FUNCTION IF EXISTS … CREATE FUNCTION public.get_pending_invitation`
  — Postgres rejects CREATE OR REPLACE when return-set columns change
  (SQLSTATE 42P13). The drop+create is in a single transaction (default),
  so anon callers cannot observe a missing function. The function retains
  `SECURITY DEFINER`, `SET search_path = public`, and `GRANT EXECUTE TO anon,
  authenticated`. The widened return set includes `brand_id` — this leaks
  brand_id to anon ONLY for the row matching the supplied email, which is
  the invitation's own assignment. Safe — anon needs to know its own
  brand_id at register-time.
- No injection vector in the RPC body — `p_email` is bound, used inside
  `where email = lower(p_email)`. No EXECUTE/dynamic SQL.
- Consistent with the architect invariant for SECURITY DEFINER functions:
  `set search_path = public`. Verified.

### Realtime + brand-context switch

- `src/store/useStore.ts:343-380` `setCurrentBrandId`:
  - `currentBrandId === null` is a UI-state sentinel only; not propagated to
    any DB filter (verified by grep — no `.eq('brand_id', null)` or
    `.is('brand_id', null)` in fetcher code). No silent NULL-row leak.
  - Switching brand triggers `setCurrentStore → loadFromSupabase` which
    re-fetches via `auth_can_see_brand` RLS. A regular admin who forced
    `currentBrandId` to a brand they don't own would receive empty result
    sets, not other-brand data.
- Realtime channels:
  - `useRealtimeSync` (`src/hooks/useRealtimeSync.ts:33-41`) subscribes to
    `store-{storeId}` and `brand-{brandId}`. Channel-name forging is
    irrelevant — realtime delivery is gated by per-table RLS on the
    publication. `brands` and `invitations` are not in the realtime
    publication (verified — only `ingredient_conversions` was ever added in
    `spec004_realtime_publication_add_conversions.sql`); no leak via
    realtime snooping for these new surfaces.

### Sentinels and storage

- `imr.cmd.superAdmin.activeBrand` localStorage / AsyncStorage key. Stores
  only the brand UUID (or empty string for null). Not sensitive (brand IDs
  are not secrets — they appear in the picker for super-admin and in URLs).
  Cleared on `login()` (`src/store/useStore.ts:290`) and `logout()`
  (line 315). Re-applied on session-restore in `App.tsx:175-197` BEFORE
  login() runs the clear, so tab-reload preserves the brand context. No
  sensitive PII written to local storage. Verified.

### TS type widening

- `User.role` widened from `'master' | 'admin' | 'user'` to add `'super_admin'`.
  Two `=== 'admin' || === 'master'` chains extended to include `'super_admin'`
  (`src/components/cmd/TitleBar.tsx:36`, `src/store/useStore.ts:329`). These
  are UI-side store-picker visibility checks; security boundary is RLS, not
  these. Verified.

### Legacy AdminScreens.tsx touch

- `src/screens/AdminScreens.tsx:1400` — single-line dynamic-import rename
  `inviteUser` → `inviteUserLegacy`. The `inviteUserLegacy` shim
  (`src/lib/auth.ts:204-224`) forwards with `brandId: null`, which means an
  admin-role invitation through the legacy form would now fail the new
  pre-flight gate at `src/lib/auth.ts:156-158` ("Admin invitations require a
  brand assignment"). This is a soft regression in the legacy form's behavior
  — but the legacy form is being retired, the user has agreed to not invite
  via the legacy flow until 012b ships (per spec Risks #1), and the new Cmd
  UI flow is the supported path. Acceptable. No new functionality added to
  the legacy file.

### Dependencies (`npm audit`)

- `package.json` and `package-lock.json` are unchanged in 012b
  (`git status` clean against main). The 012b spec confirmed no new
  third-party libs added.
- Re-ran `npm audit --audit-level=high` for completeness:
  6 vulnerabilities (5 moderate, 1 high) — all pre-existing transitive deps
  (`@xmldom/xmldom` jsPDF chain, `dompurify` jsPDF chain, `postcss` Expo
  toolchain). None introduced by 012b. Out of scope for this spec; should
  be tracked as a separate cleanup if not already.

### Not flagged

- `useRole()` placeholder (`src/hooks/useRole.ts:9-11`) returning hardcoded
  `'admin'` — per CLAUDE.md, this is intentional client-side only and
  server-side is `auth_is_admin()`. Not a finding.
- `RoleBadge` accepts `role` prop and renders a distinct super_admin variant —
  cosmetic only, no security boundary involved.
- No edge function added or modified by 012b. `send-invite-email` and
  `delete-user` are unchanged. `supabase/config.toml` not touched. No
  `verify_jwt` setting changes. No service-token validation changes.
- No SECURITY DEFINER functions added beyond the `get_pending_invitation`
  re-creation, which preserves the original `set search_path = public`.

### Net assessment

No critical findings. The single material concern (W-1) is an existing
RLS gap that the developer surfaced honestly in build notes; it is masked
in prod today by `wzhchen113@gmail.com`'s pre-012a JWT app_metadata. A
follow-up migration to add `OR auth_is_super_admin()` to the four
invitations policies would close it cleanly. **Spec is safe to ship as-is**;
W-1 should be tracked as a security-hygiene follow-up before any second
super-admin is provisioned.
