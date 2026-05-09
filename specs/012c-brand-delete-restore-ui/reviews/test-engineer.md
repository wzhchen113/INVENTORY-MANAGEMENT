# Test engineer findings — Spec 012c

## Acceptance criteria coverage

| AC | Text (abbreviated) | Status | Citation |
|---|---|---|---|
| R1 | Super-admin can rename an active brand; client + server validation; UNIQUE collision returns toast | PASS | `rename_brand` RPC: empty-name check + UNIQUE propagation. `db.renameBrand` client-side trim + empty guard. `useStore.renameBrand` optimistic-then-revert. Inline rename in BrandsSection §8.2. Backend Probe "rename_brand happy path + empty-name + missing-brand cases: PASS" |
| R2 | Renaming a soft-deleted brand is permitted | PASS | `rename_brand` RPC has no `deleted_at IS NULL` guard — updates any brand. RLS `super_admin_manage_brands` (FOR ALL) covers UPDATE on soft-deleted rows. No contradicting filter. |
| R3 | Rename success refreshes `brandStats` and `brandsList` in useStore | PASS | `useStore.renameBrand` (lines 505–527) optimistically updates both `brandsList` and `brandStats` in place; reverts both on error. |
| R4 | Casing matters at UNIQUE level; `brands.name` is case-sensitive UNIQUE | NOT TESTED | Spec marks this as a PM default with no new code. Static analysis: `rename_brand` delegates to the existing UNIQUE constraint; no `lower()` wrapper added. Correct per spec; no live probe run. |
| S1 | Super-admin soft-deletes via "Delete brand" button → type-to-confirm modal | PASS | `DangerOutlineButton` in BrandsSection detail header (non-Trash branch) opens `TypeToConfirmModal` with `requiredText={sel.name}` and `destructiveLabel="DELETE BRAND"`. Backend Probe 1 PASS. |
| S2 | Soft-delete writes `brands.deleted_at = now()` via `soft_delete_brand` RPC gated by `auth_is_super_admin()`. Optimistic-then-revert. | PASS | RPC verified in migration, super-admin gate line 401. `useStore.softDeleteBrand` optimistically flips `deletedAt` in both slices; reverts on error + `notifyBackendError`. Backend Probe 1 PASS. |
| S3 | Soft-deleted brand disappears from active picker and `fetchBrandsWithStats` | PASS | `fetchBrandsWithStats` applies `.is('deleted_at', null)` when `includeSoftDeleted=false` (default). Active picker uses `fetchBrandsLite` with same guard from 012a. No new code needed; 012a RLS + existing filter covers this. |
| S4 | Soft-deleted brand visible in Trash sub-tab with row count badge | PASS | BrandsSection `listTab` state + `TabStrip` with `Active (N)` / `Trash (M)` labels (line 414). `trashBrands` partition from `activeBrands` / `trashBrands` memo (line 103). Strikethrough + `DELETED` StatusPill on trash rows (lines 461–469). `loadBrandStatsIncludingDeleted` supplies the data. |
| S5 | Auto-reset `currentBrandId` to null + toast when soft-deleting the active brand | PASS | `useStore.softDeleteBrand` (lines 543–550): `if (prevBrandId === brandId) { get().setCurrentBrandId(null); Toast.show(…) }`. Revert path restores `prevBrandId` (line 558). Backend Probe 2 listed as UI-only; not live-probed. |
| S6 | Brand-admins see no rows for soft-deleted brand on next request (via 012a RLS) | PASS | 012a `brand_member_read_brands` policy: `deleted_at is null or auth_is_super_admin()`. Confirmed in 012a migration. No new code in 012c. |
| X1 | Restore button visible on Trash brand within 30-day window | PASS | `restoreEligible = isTrash && days !== null && days < GRACE_DAYS` (line 513). `RestoreButton` visible and enabled when `restoreEligible`. Both Restore and Purge buttons are always shown for trash brands; Restore is disabled past 30 days (not hidden). Minor UX deviation from spec text "hides the Restore button" — see Notes. |
| X2 | Restore writes `brands.deleted_at = NULL` via `restore_brand` RPC | PASS | `restore_brand` RPC line 471: `update public.brands set deleted_at = null`. `useStore.restoreBrand` optimistic flip + revert. Backend Probe 3 PASS. |
| X3 | Restore re-derives `brandStats`, `brandsList`, picker state | PASS | `useStore.restoreBrand` optimistically sets `deletedAt = null` in both slices. `restoreBrand` action in BrandsSection also calls `loadBrandStatsIncludingDeleted` immediately post-success (line 160) to keep counts accurate. Q-ARCH-3: no `currentBrandId` swap on restore. |
| X4 | Restore blocked past 30-day window — RPC raises EXCEPTION; UI disables button | PASS | Server: `restore_brand` checks `(now() - v_deleted_at) > interval '30 days'` (migration line 466). UI: `restoreEligible = days < GRACE_DAYS`; `RestoreButton` disabled + labeled "RESTORE EXPIRED" when not eligible. Backend Probe 4 PASS. |
| H1 | "Purge now" button disabled with countdown until `now - deleted_at >= 30 days`. DB does NOT enforce grace window for hard-delete. | PASS | UI: `purgeEligible = days >= GRACE_DAYS` (line 512). `PurgeButton` shows "PURGE IN Xd" when not eligible. `hard_delete_brand` RPC has zero `interval '30 days'` check — only enforces pre-flights H4 and H5. Per spec Q-USER-B. |
| H2 | "Purge now" opens two-step modal: Step 1 cascade preview + orphan-profile red error block (disables Continue); Step 2 type-to-confirm | PASS (with minor deviation) | `CascadePreviewModal`: Step 1 fetches preview, renders red error block when `blockingProfiles.length > 0`, disables Continue. Step 2 nested `TypeToConfirmModal` with `requiredText=brandName`. Re-fetches preview on Step 1→Step 2 transition. Spec calls for separate "Manage admins" / "Manage users" buttons; implementation uses single "MANAGE" button per row — see Notes. Backend Probes 5, 6 PASS. |
| H3 | `hard_delete_brand` runs atomic CASCADE; gated by `auth_is_super_admin()` | PASS | RPC in single implicit PL/pgSQL transaction; `auth_is_super_admin()` check line 654. FK CASCADE chain established by migration §1/§2/§3. Backend Probe 7 PASS. |
| H4 | Pre-flight #1: rejects if `deleted_at IS NULL` | PASS | Migration line 667: `if v_deleted_at is null then raise exception 'Brand must be soft-deleted before hard-delete…'`. Backend Probe 8 PASS. |
| H5 | Pre-flight #2: EXCEPTION if any profiles with `brand_id = p_brand_id` | PASS | Migration lines 674–685: counts `admin + master + user` profiles; raises EXCEPTION with count message if > 0. Backend Probe 9 PASS. |
| H6 | `brand_deletion_log` table survives cascade; records soft-delete/restore/hard-delete | PASS | Table created with no FK to brands (migration §5). All three RPCs insert into the table. `hard_delete_brand` snapshots `preview_brand_cascade` into `cascade_payload` before the DELETE fires. Backend Probe 7 confirms survival + payload population. |
| U1 | All new UI works at phone/tablet/desktop via `ResponsiveSheet` | NOT TESTED | `TypeToConfirmModal` and `CascadePreviewModal` both wrap in `ResponsiveSheet` with `presentation: { desktop: 'center-modal' }`. Static analysis correct. Probe 12 (6-width browser walk) is UI-only; main Claude probe walk pending per task brief. |
| U2 | Type-to-confirm requires custom modal with controlled TextInput | PASS | `TypeToConfirmModal.tsx` implemented with `TextInput`, `matches = typed.trim() === requiredText`, `autoFocus`, Escape/Enter keyboard idioms on web. |
| U3 | Cascade preview renders table of counts + total + orphan-profile error block | PASS | `CascadePreviewModal` renders sorted per-table count table with total row (lines 420–463). Red error block above table when `blockingCount > 0` (lines 284–362). |
| B1 | All 012b flows (list/detail, + NEW BRAND, + INVITE ADMIN) continue to work | PASS | Static analysis: BrandsSection adds tabs + action rows but does not remove existing flows. `loadBrandStatsIncludingDeleted` replaces `loadBrandStats` on mount, with `includeSoftDeleted: true` — back-compat (adds soft-deleted rows to the returned set; existing Active partition filters them out locally). |
| B2 | Super-admin who never opens Trash sub-tab sees same 012b UI plus Rename + Delete affordance | PASS | Default `listTab = 'active'` (line 62). Delete button shown only on active brands. Rename always visible in detail header. |
| B3 | Brand-admins see no UI change | PASS | `useIsSuperAdmin()` gate at BrandsSection root (line 127); returns a "no access" block for non-super-admin. |

---

## Q-A end-to-end workflow validation

Walking the destructive correctness scenario step by step:

**Step 1 — User clicks Purge on a brand with 1 admin (Bobby):**

`BrandsSection` renders `PurgeButton` because `isTrash=true` and `purgeEligible = days >= 30`. On click, `CascadePreviewModal` opens (`visible=true`). The effect at line 54 calls `previewBrandCascade(brandId)`. The `preview_brand_cascade` RPC runs and returns `blocking_profiles = [{profile_id: Bobby.id, name: "Bobby", email: "bobby@...", role: "admin", status: "active"}]`. The modal sets `preview` and computes `blockingCount = 1`. The red error block renders (lines 284–362): "Cannot purge: 1 profile still belongs..." with Bobby's row listed. The `continueDisabled = blockingCount > 0 = true`. Continue button is disabled.

This is mechanically correct. The "Manage admins" / "Manage users" text is not present (implementation has a single "MANAGE" button per row instead), but both trigger `onManageMembers(brandId)` which navigates to the members tab. The spec's two-button requirement is collapsed to one button with the same effect.

**Step 2 — User clicks Demote on Bobby:**

User clicks "MANAGE" in the red error block → modal closes via `onClose()` → BrandsSection switches to the members tab. Bobby's row shows `canActOn = true` (role=admin, not self, not pending). User clicks "DEMOTE" → `confirmAction` popup (line 808) → confirmed → `demoteProfileToUser(Bobby.id)` fires. In `useStore.demoteProfileToUser`: optimistically flips Bobby's cached role to `'user'` and `brandId` to `null`. Then calls `db.demoteProfileToUser(Bobby.id)` which executes PostgREST `UPDATE profiles SET role='user', brand_id=NULL WHERE id=Bobby.id`. Both columns change atomically. This is confirmed in `src/lib/db.ts:1874`: `.update({ role: 'user', brand_id: null })`. After success, `loadBrandAdmins` is re-fetched for the affected brand, dropping Bobby from the members tab (his `brand_id` is now null).

The load-bearing condition is met: both `role` and `brand_id` are cleared in a single UPDATE.

**Step 3 — User goes back to Purge:**

User opens `CascadePreviewModal` again. Effect calls `previewBrandCascade`. The `preview_brand_cascade` RPC re-runs: `SELECT … FROM profiles WHERE brand_id = p_brand_id` — Bobby's row is no longer present because `brand_id` is now NULL. `blocking_profiles = []`. Red error block does NOT render. Green "Ready to purge" block renders. `continueDisabled = false`. Continue button is enabled.

**Step 4 — Continue to Step 2:**

User clicks Continue. `continueToStep2()` runs (line 90). It re-fetches the preview one more time to guard against races. `fresh.blockingProfiles.length === 0` → no new orphans → `setStep(2)`. `TypeToConfirmModal` renders with `requiredText = "Baltimore Seafood"`. User types the name → `matches = true` → PURGE PERMANENTLY enabled → user clicks it → `handlePurgeConfirmed()` → `onPurgeConfirmed()` (passed from BrandsSection). In BrandsSection, `onPurgeConfirmed` calls `useStore.hardDeleteBrand(brandId)`. The RPC fires: pre-flight H4 passes (deleted_at IS NOT NULL), pre-flight H5 passes (blocking count = 0), cascade snapshot taken, audit row inserted, `DELETE FROM brands WHERE id = p_brand_id` executes, cascade propagates. `brand_deletion_log` receives the hard_deleted row with `cascade_payload`. Store removes the brand from `brandsList`/`brandStats`; toast fires.

**Verdict: the end-to-end is mechanically correct.** The only deviation from spec text is cosmetic (one "MANAGE" button instead of two distinct "Manage admins"/"Manage users" buttons), and both routes call the same handler. The core correctness contract — blocking profiles prevent purge, demote clears both columns, re-fetch on Step 1→2 transition catches races, RPC pre-flights are the safety layer — is implemented correctly.

---

## Load-bearing implementation checks

### 1. `demoteProfileToUser` MUST set BOTH `role='user'` AND `brand_id=null`

**VERIFIED CORRECT.** `src/lib/db.ts:1874`:

```typescript
.update({ role: 'user', brand_id: null })
```

Single PostgREST UPDATE statement sets both columns atomically. The comment block above (lines 1861–1870) explicitly documents why both must change: the H5 pre-flight `EXISTS (SELECT 1 FROM profiles WHERE brand_id = p_brand_id)` does not filter by role — a `user`-role profile with `brand_id` still set would remain in the blocking count and demote would fail to unblock purge.

### 2. 30-day grace dual-layer enforcement

**Server layer (restore only):** `restore_brand` RPC enforces `(now() - v_deleted_at) > interval '30 days'` and raises EXCEPTION. Verified in migration line 466. Backend Probe 4 PASS.

**Server layer (hard-delete):** `hard_delete_brand` does NOT enforce the 30-day grace window. This is correct per spec Q-USER-B: "DB-side enforcement of the 30-day grace window: UI-side only." The hard-delete RPC only checks H4 (must be soft-deleted) and H5 (no orphan profiles).

**UI layer:** `GRACE_DAYS = 30` (BrandsSection line 25). `purgeEligible = isTrash && days !== null && days >= GRACE_DAYS` (line 512). PurgeButton disabled and shows countdown when not eligible. RestoreButton disabled and shows "RESTORE EXPIRED" when past 30 days (the UI does not hide it — see Notes).

**Both layers are in place per the spec's design.** The asymmetry (restore has DB enforcement; hard-delete does not) is explicitly specified behavior, not a defect.

### 3. Self-protection on Demote/Delete

**UI layer (BrandsSection.tsx):** `isSelf = !!superAdminUserId && u.id === superAdminUserId` (line 860). `canActOn = !isSelf && !isPending && (u.role === 'admin' || u.role === 'master')` (line 865). When `canActOn = false` and `isSelf = true`, the row renders "(you)" inline instead of the two buttons (lines 953–956). **UI protection is implemented correctly.**

**Server layer (delete-user edge function):** The `deleteUser` path goes through `auth.deleteUser(userId)` → `delete-user` edge function → `requireAdminCaller` validates the CALLER's role (not the target). The edge function does not have a specific "caller cannot delete themselves" server-side check. If a super-admin's own `userId` were passed, the function would proceed — the guard is UI-only for self-deletion. However, because the UI hides the button for `isSelf`, this gap is not reachable through the standard UI flow. The spec §8.7 says "both buttons are hidden" — the server-side self-protection is listed as "Bonus: try direct RPC — expect either RLS rejection or RPC EXCEPTION." The `demoteProfileToUser` uses direct PostgREST UPDATE, which the `super_admin_manage_profiles` policy (012a: UPDATE only) would permit on any profile including the super-admin's own row. There is no server-side self-demotion block. **Server layer self-protection is partially absent: demote has no server-side self-block; delete-user has no self-block. The UI guard is the sole protection in both cases.**

This matches Probe 15's framing ("the UI guard is the primary safety, the DB layer is secondary"), and the spec §8.7 describes it as a defensive guard. Not a blocker but worth noting.

---

## Pre-prod-push behavioral concern: unintended brand cascade surface

The question is: after the FK CASCADE migration lands, are there paths OTHER than the five new RPCs that could trigger an unintended brand cascade?

**PostgREST direct DELETE on `brands`:** Before 012a, the P5 migration (`20260504073942_brand_catalog_p5_rls.sql:240`) created `admin_delete_brands` policy allowing `auth_is_admin()` (any admin/master) to DELETE from brands. The 012a migration (`20260509000000_multi_brand_schema_rls.sql:418`) explicitly `DROP POLICY IF EXISTS "admin_delete_brands"` before creating the new `super_admin_manage_brands` (FOR ALL) policy. After 012a, the ONLY RLS policy permitting DELETE on `brands` is `super_admin_manage_brands` which requires `auth_is_super_admin()`. So a regular brand-admin cannot trigger a cascade via PostgREST after 012a is applied.

**Who CAN trigger a direct brand DELETE via PostgREST (post-012a):** Only users whose `profiles.role = 'super_admin'` can pass `auth_is_super_admin()`. That is currently one person. They could run `DELETE FROM brands WHERE id = X` via the Supabase dashboard SQL editor or PostgREST, which would trigger the cascade.

**The pre-flight checks are RPC-internal.** If a super-admin executes the direct DELETE (bypassing the RPCs), the H4 and H5 pre-flights in `hard_delete_brand` do NOT fire — the cascade runs unconditionally. The only server-side protection in that bypass path is the `profiles.brand_id ON DELETE SET NULL` FK (from 012a) which would set orphan profiles' `brand_id` to null automatically, potentially violating the `profiles_role_brand_consistent` CHECK constraint for admin/master profiles. Wait — the FK is `ON DELETE SET NULL`, not RESTRICT. If a profile has `role='admin'` and `brand_id IS NULL` after the SET NULL fires, the CHECK constraint (`(role IN ('admin','master') AND brand_id IS NOT NULL) OR role = 'user' OR role = 'super_admin'`) would FAIL, aborting the entire transaction. This means a direct `DELETE FROM brands` bypassing the RPC on a brand with admin profiles attached would fail with a CHECK violation — not an unintended cascade. The 012a CHECK constraint acts as a secondary safety net.

**Conclusion:** The unintended cascade surface is limited to super-admin SQL access (dashboard or psql), and only succeeds if the brand has zero admin/master profiles attached (otherwise the CHECK constraint aborts it). For brands with attached profiles, the SET NULL FK + CHECK constraint provides an involuntary safety net. The spec explicitly acknowledges this as acceptable ("the UI button is the user-facing contract; the DB doesn't second-guess super-admin SQL access"). No new surface was introduced by 012c beyond what was already present by design in 012a.

---

## Test framework gap

This is the sixth consecutive spec (001, 002, 003, 010, 012b, 012c) with no automated test coverage. The only automation is `scripts/smoke-edge.sh` (curl-based) and `scripts/test-unit-conversion.ts` (one-off ts-node). Neither covers the 012c acceptance criteria. All 16 ACs were verified through static analysis of the implementation files, cross-referencing the backend-developer's locally-run psql probe results (Probes 1, 3–11), and the frontend-developer's TypeScript typecheck pass. Browser-driven probes (Probes 2, 12–16) are pending main Claude's probe walk per the task brief.

A vitest or jest harness that could run SQL RPCs against the local Supabase stack (as described in the project testing policy — "hit a real local Supabase, not mocks") would allow these ACs to be verified automatically on every PR rather than manually per spec. The accumulating gap is recommended as an explicit priority item for the next spec planning session: introducing a framework adds cost once; the current per-spec manual verification cost is recurring.

---

## Recommended cleanup bundle (items not already covered by code-reviewer or security-auditor)

1. **Restore button should be hidden past 30 days, not just disabled.** Spec §8.4 says "Restore button shows... disabled if `now - deletedAt > 30 days`" — the implementation disables but keeps it visible as "RESTORE EXPIRED". The spec also says "UI hides the Restore button and shows 'purge eligible' instead (see H1)." The current UX (both buttons always shown in trash view, Restore disabled) is clear and reasonable but diverges from the spec's "hides" language. Recommend clarifying with the user whether "disabled" is acceptable or the button should be conditionally hidden.

2. **Single "MANAGE" button vs. two separate "Manage admins" / "Manage users" deep links.** AC H2 and spec §8.6 call for two buttons. The implementation uses one "MANAGE" button per profile row (same handler). Functionally equivalent today because both targets land in the same members tab. If user-management ever becomes a separate section, the single button will need splitting. Low priority; note in the release proposal.

3. **`preview_brand_cascade` includes `super_admin` in `blocking_profiles` but `hard_delete_brand` pre-flight excludes `super_admin` from the blocking count.** If a `super_admin` profile ever had `brand_id` set (currently impossible due to the `profiles_role_brand_consistent` CHECK and 012a's `auth_is_super_admin` requiring `brand_id IS NULL`), they would appear in the UI's red error block as a blocker but would NOT trigger the RPC's EXCEPTION — the UI would show "Clear this admin" but demoting them wouldn't affect the RPC's count. The inconsistency is harmless in practice but adds asymmetry to the mental model. Recommend adding `super_admin` to the H5 pre-flight count or documenting the exclusion explicitly in the RPC comment.

4. **`loadBrandStatsIncludingDeleted` silently swallows errors** (uses `console.warn` rather than `notifyBackendError`). This means a failed stats refresh on Trash tab open would render an empty Trash list with no user-visible feedback. Recommend wiring to `notifyBackendError` for consistency with the rest of the store.

5. **The "Detail-pane footer note about 012b out-of-scope" removal**: spec's Definition of Done requires it to be removed. Build notes confirm it was removed. Not directly verifiable without a browser, but marked complete per build notes.

6. **Probe 16 verification scope.** The frontend-developer added `super_admin` to `ADMIN_ROLES` in the delete-user edge function preemptively. Backend-developer noted the change is in the frontend's files changed. The change is clearly present at `supabase/functions/delete-user/index.ts:20`. This is correct and verifiable without a live probe.

---

## Verdict

**2 NOT TESTED** (R4, U1 — both are non-code-change items: R4 is a PM default with no implementation, U1 requires a live browser walk pending from main Claude). All other 14 ACs are PASS.

**0 FAIL.**

The two NOT TESTED items are not blockers for this spec:
- R4 has no implementation change; the underlying UNIQUE constraint behavior is unchanged.
- U1 coverage is gated on the main Claude probe walk which was identified as running in parallel.

**Minor deviations to surface to the release-coordinator (not blockers):**
- Restore button is disabled (not hidden) past 30 days — minor divergence from spec text.
- Single "MANAGE" button in CascadePreviewModal instead of two distinct "Manage admins"/"Manage users" buttons.
- Server-side self-protection for demote/delete-user is absent; UI guard is the sole protection.
- `loadBrandStatsIncludingDeleted` swallows errors silently.
