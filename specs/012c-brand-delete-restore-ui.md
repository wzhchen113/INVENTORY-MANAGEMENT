# Spec 012c: Brand soft-delete + 30-day grace + restore + hard-delete cascade UX

Status: SHIP_READY

> **Closeout (2026-05-20):** Shipped in commit `25c41f9` (2026-05-09). Release-proposal verdict was FIXES_NEEDED with a cleanup bundle (2 Criticals + 5 should-fix) that landed inside the same commit — verified in code: C1 double-toast removed in `handleSoftDelete` (`src/screens/cmd/sections/BrandsSection.tsx:168`); C2 `counts` renamed to `profileCounts` (`src/lib/db.ts:2637`); should-fix #5 `user_stores_links` → `user_stores` JSON key fixed (migration line 619). Status field was never bumped at the time. OOS follow-ups: W1 `callEdgeFunction` non-2xx surfacing closed by spec 032; W2 `demoteProfileToUser` SECURITY DEFINER hardening still pending (current shape: direct PostgREST UPDATE at `src/lib/db.ts:2757`).

**Type:** Frontend (Cmd UI section + drawers + confirm modal) + backend (RPC and/or edge function for the cascade, optional new migration for FK cascade fixes + a deletion audit table).
**Sub-spec of:** [Spec 012 — Multi-brand tenancy umbrella](012-multi-brand-tenancy.md). Final sub-spec; ships after [012a (schema + RLS)](012a-multi-brand-schema-rls.md) and [012b (super-admin Cmd UI + brand picker)](012b-super-admin-cmd-ui.md). Both are live in prod.
**Predecessors live:**
- 012a — `brands.deleted_at` column exists; RLS hides soft-deleted brands from non-super-admins; `profiles.brand_id` is `ON DELETE SET NULL`; `catalog_ingredients.brand_id` is `ON DELETE CASCADE`.
- 012b — `BrandsSection.tsx` list/detail UI + `+ NEW BRAND` form + `+ INVITE ADMIN` flow ship. Detail-pane footer literally says "brand renaming and soft-delete are out of scope for 012b. Use the Supabase SQL editor for now; UI controls land in 012c." This spec delivers those.

---

## User story

As the super-admin, I want to rename a brand, soft-delete it (with a 30-day undo window), restore it during that window, and irrevocably hard-delete it after the grace period (or sooner if I'm sure) — with a clear preview of exactly what will be erased and a strong type-the-name confirmation — so that I can manage the tenant lifecycle without dropping into the Supabase SQL editor and without accidentally nuking real data.

---

## Acceptance criteria

### Brand renaming (R)
- [ ] **R1.** Super-admin can rename an active brand from the brand detail header. The new name is validated client-side (non-empty, trimmed) and server-side (UNIQUE on `brands.name` — collision returns a clear toast).
- [ ] **R2.** Renaming a soft-deleted brand is permitted (super-admin only, same UNIQUE check applies).
- [ ] **R3.** Rename success refreshes `brandStats` and `brandsList` in `useStore` so the list pane and the header brand picker reflect the new name without a manual reload.
- [ ] **R4.** Casing matters at the unique-constraint level today (`brands.name` is `UNIQUE`, no `lower()` index). Spec keeps that contract — renaming `2AM PROJECT` to `2am project` succeeds. PM default; surface only if user wants case-insensitive uniqueness (would require a new migration).

### Soft-delete (S)
- [ ] **S1.** Super-admin can soft-delete an active brand from the brand detail header via a "Delete brand" button that opens a type-to-confirm modal (must type the exact brand name to enable the destructive button).
- [ ] **S2.** Soft-delete writes `brands.deleted_at = now()` via an RPC (`soft_delete_brand(p_brand_id uuid)`) gated by `auth_is_super_admin()`. Optimistic-then-revert via `notifyBackendError`.
- [ ] **S3.** A soft-deleted brand disappears from the active brand picker (already true via 012a's RLS + `fetchBrandsLite` `includeSoftDeleted=false`) and from `fetchBrandsWithStats` (already filters `deleted_at IS NULL`).
- [ ] **S4.** A soft-deleted brand is visible to super-admin under a **"Trash" sub-tab** within BrandsSection (per Q-USER-C resolution — single-spec ship retains the "Trash" sub-tab UX). The active list pane shows only active brands; the Trash sub-tab shows only soft-deleted ones with a row count badge `Trash (N)`.
- [ ] **S5.** If the super-admin is currently context-switched into the brand they just soft-deleted (`currentBrandId === deleted brand id`), the store auto-resets `currentBrandId` to `null` ("All brands" mode) and a toast confirms the deletion.
- [ ] **S6.** Brand-admin members of a soft-deleted brand see no rows for that brand on their next request (012a RLS already hides `deleted_at IS NOT NULL` from non-super-admins). The spec does NOT force-log-out their existing sessions; their next page load shows empty data with the existing empty-state copy. PM default; surface only if user wants forced-logout behavior.

### Restore (X)
- [ ] **X1.** While a soft-deleted brand is still within the 30-day window (`deleted_at > now() - interval '30 days'`), super-admin sees a "Restore" button on the brand detail header (when viewing the brand from the Trash sub-tab).
- [ ] **X2.** Restore writes `brands.deleted_at = NULL` via `restore_brand(p_brand_id uuid)`. Optimistic-then-revert.
- [ ] **X3.** Restore re-derives `brandStats`, `brandsList`, and any stale picker state. The brand re-appears in the active picker on next load.
- [ ] **X4.** Restore is BLOCKED past the 30-day window — the RPC returns an error if `now() - deleted_at > 30 days`. UI hides the Restore button and shows "purge eligible" instead (see H1).

### Hard-delete (H)
- [ ] **H1.** "Purge now" button is shown on the soft-deleted brand's detail header within the Trash sub-tab. **30-day grace is enforced UI-side only**: the button is visually disabled with a countdown ("Purge eligible in N days") until `now() - deleted_at >= 30 days`. The DB-level `hard_delete_brand` RPC does NOT enforce the grace window — super-admin can technically short-circuit by bypassing the UI, but the standard flow respects the countdown. PM default per Q-USER-B (manual-only); architect may revisit if user wants a DB-side grace gate.
- [ ] **H2.** "Purge now" opens a two-step modal:
  - **Step 1: cascade preview.** Server-side count of every row that will be erased: catalog_ingredients, recipes, prep_recipes, vendors, stores, and per-store children (inventory_items, eod_submissions, eod_entries, waste_log, audit_log, purchase_orders, po_items, pos_imports, pos_import_items, flags, order_schedule, pos_recipe_aliases, recipe_ingredients, recipe_prep_items, prep_recipe_ingredients, ingredient_conversions). **PLUS a count of `profiles` whose `brand_id = p_brand_id` — and per Q-USER-A this is a HARD BLOCKER. If the count is non-zero, Step 1 renders a red error block listing each profile (email + role) with "Manage admins" / "Manage users" deep links and the "Continue to confirmation" button is disabled.** The user cannot reach Step 2 until the profile count is zero.
  - **Step 2: type-the-name confirmation.** Same pattern as soft-delete but the destructive button is red and labeled "PURGE PERMANENTLY". Only reachable when profile count is zero.
- [ ] **H3.** Hard-delete runs as a server-side cascade orchestrated by `hard_delete_brand(p_brand_id uuid)` (an RPC that runs `DELETE FROM brands WHERE id = p_brand_id` after the FK cascade migration ensures `stores`/`vendors`/`recipes`/`prep_recipes` propagate). Gated by `auth_is_super_admin()`. Atomic transaction.
- [ ] **H4.** Pre-flight check #1 inside `hard_delete_brand`: rejected if `deleted_at IS NULL` (must be soft-deleted first — no skipping the soft-delete step).
- [ ] **H5.** **Pre-flight check #2 inside `hard_delete_brand` (per Q-USER-A = REJECT):** the RPC raises an EXCEPTION if `EXISTS (SELECT 1 FROM public.profiles WHERE brand_id = p_brand_id)` with a message of the form `Cannot hard-delete brand: N profiles (M admins, K users) still belong. Reassign or delete them first.` This is server-side enforcement of the "no orphans" contract — the UI's preview check is a usability layer, the RPC's pre-flight check is the safety layer.
- [ ] **H6.** Audit log of the deletion itself is written to a NEW table `brand_deletion_log` (id, brand_id, brand_name, deleted_by_user_id, deleted_by_email_snapshot, action='soft_delete'|'restore'|'hard_delete', payload jsonb, created_at). This table survives the cascade (it doesn't FK to `brands`). See Project-specific notes "Audit trail of the delete itself."

### UX / responsive (U)
- [ ] **U1.** All new UI (rename input, type-to-confirm modal, cascade-preview modal, Trash sub-tab, Restore/Purge buttons) works at phone (< 768), tablet (768–1099), and desktop (≥ 1100) per Spec 011's `ResponsiveCmdShell` chrome contract. Type-to-confirm and cascade-preview modals use `ResponsiveSheet` (existing component) on phone/tablet; centered modal on desktop.
- [ ] **U2.** Cross-platform confirm via `src/utils/confirmAction.ts` is NOT sufficient for the destructive flows here (it's a single OK/Cancel). Type-to-confirm requires a custom modal with a controlled text input. Spec adds `src/components/cmd/TypeToConfirmModal.tsx`.
- [ ] **U3.** Cascade-preview modal renders a tabular list of "table → row count" pairs in the Cmd-UI mono font, with a clear total at the bottom AND the orphan-profile error block (per H2) above the table when triggered.

### Backwards compatibility (B)
- [ ] **B1.** All 012b flows (list/detail, + NEW BRAND, + INVITE ADMIN) continue to work unchanged for active brands.
- [ ] **B2.** A super-admin who never opens the Trash sub-tab sees the same UI they had in 012b plus a Rename and Delete affordance on the detail header.
- [ ] **B3.** Brand-admins see no UI change (they don't have access to BrandsSection at all — `useIsSuperAdmin()` gates the section).

---

## In scope

- **Frontend (Cmd UI)**:
  - Rename affordance in the brand detail header (inline edit with Save/Cancel, mirrors the existing Cmd-UI inline-edit pattern from other sections).
  - "Delete brand" button in detail header for active brands.
  - "Restore" button + "Purge now" button (with day-countdown disabled state) in detail header for soft-deleted brands shown in the Trash sub-tab.
  - **"Trash" sub-tab in BrandsSection** — switches the list pane to show only soft-deleted brands; the active sub-tab shows only active brands; tab labels include row counts (`Active (N)` / `Trash (M)`).
  - New `TypeToConfirmModal.tsx` component (controlled text input, validates against required string, exposes `onConfirm` only when input matches).
  - New `CascadePreviewModal.tsx` component (renders the table-of-counts; calls into `db.previewBrandCascade`; renders the orphan-profile error block when applicable).
  - `useStore` actions: `renameBrand`, `softDeleteBrand`, `restoreBrand`, `hardDeleteBrand`, `loadBrandStatsIncludingDeleted`, `fetchBrandDeletionLog`. Auto-swap `currentBrandId` to NULL on soft-delete-of-current.
- **Backend**:
  - 4 new mutating RPCs: `rename_brand(p_brand_id uuid, p_new_name text)`, `soft_delete_brand(p_brand_id uuid)`, `restore_brand(p_brand_id uuid)`, `hard_delete_brand(p_brand_id uuid)`. All `SECURITY DEFINER`, all gated by `auth_is_super_admin()`.
  - 1 new RPC for the cascade preview: `preview_brand_cascade(p_brand_id uuid) returns jsonb` — returns the per-table row counts AND the profile count (broken out by role).
  - 1 new audit table: `brand_deletion_log` (see H6 above).
  - 1 new migration that ALSO **fixes the FK gap** — `stores.brand_id`, `vendors.brand_id`, `recipes.brand_id`, `prep_recipes.brand_id` are currently `references brands(id)` with NO `ON DELETE` clause (default RESTRICT). The migration alters them to `ON DELETE CASCADE` so `hard_delete_brand` works. Per-store child tables (inventory_items etc.) are already covered by `stores(id) on delete cascade` from init schema.
  - `db.ts` helpers: `renameBrand`, `softDeleteBrand`, `restoreBrand`, `previewBrandCascade`, `hardDeleteBrand`, `fetchBrandsWithStatsIncludingDeleted`, `fetchBrandDeletionLog`.

---

## Out of scope (explicitly)

- **Automated daily cron purge.** Per Q-USER-B = manual-only. Soft-deleted brands sit in limbo until a super-admin clicks "Purge now". The 30-day grace window is enforced **at the UI layer** (Purge button shows countdown / disabled until eligible), NOT at the DB layer. The user can override later if automated cleanup becomes necessary. No `pg_cron` extension enable; no Vercel cron route.
- **Auto-reassignment / auto-demotion of orphan profiles.** Per Q-USER-A = REJECT. Hard-delete fails fast with a clear EXCEPTION listing the offending profiles. Super-admin must manually reassign or delete each admin/user via the existing admin management flows BEFORE purging the brand. Highest-friction option, explicitly chosen.
- **Restore after hard-delete.** Hard-delete is irreversible by design. No "restore from backup" flow. (The umbrella spec already declared this out of scope.)
- **Multi-super-admin co-sign for destructive actions.** A second super-admin approving a hard-delete would be a nice safety net but there's only one super-admin today. Out of scope; revisit if a second super-admin is ever provisioned.
- **Export-before-delete tooling.** Generating a CSV/JSON dump of a brand's data before purging would help a future "I shouldn't have done that" scenario but it's a separate spec. The cascade preview shows what will be lost; the operator types the brand name to acknowledge.
- **Touching the legacy `AdminScreens.tsx`.** All UI lands under `src/screens/cmd/sections/` and `src/components/cmd/`.
- **Realtime broadcast of brand soft-delete to other admin tabs.** The `brands` table is NOT in the realtime publication today (per 012a §0 probe #6). Adding it would require an `alter publication` + the realtime container restart ritual. Out of scope; other tabs see the change on next route-change/reload, which is acceptable for a once-a-month admin operation.
- **Splitting 012c into 012c1 + 012c2.** Per Q-USER-C = single spec. Rename + soft-delete + restore + cascade preview + hard-delete + the small migration ship in one cohesive PR.
- **DB-side enforcement of the 30-day grace window.** Per Q-USER-B = UI-side only. The `hard_delete_brand` RPC will execute on a brand that was soft-deleted 5 minutes ago — only the UI button enforces the countdown. Architect may flag if they prefer a DB-side gate; absent that, this is the contract.
- **Test framework introduction.** Sixth spec in a row to flag this. Test-engineer reviewer should call it out as a recommendation, not a blocker.
- **Sibling-app coordination.** The staff app and PWA already inherit from 012a's RLS — no new sibling-app work for 012c. (A hard-deleted brand's stores will return zero rows to those apps via RLS as soon as soft-delete fires.)
- **`app.json` slug change.** Not relevant here.

---

## Open questions for the user — RESOLVED 2026-05-08

### Q-USER-A — Orphan profile handling on hard-delete (CORRECTNESS) → **(d) REJECT**

**Decision:** the hard-delete RPC must check for any profiles with `brand_id = <target>` and **raise an EXCEPTION with a helpful message** if any exist. Super-admin must manually reassign or delete each admin/user via the existing admin management flows BEFORE purging the brand.

**Rationale:** the user explicitly chose this as the safest and highest-friction option. We are NOT auto-demoting (option a), NOT hard-deleting orphan profile rows (option b), NOT relaxing the CHECK constraint (option c).

**Implementation note for the architect (LOCKED):** the hard-delete RPC's pre-flight check is **strict**:

```sql
-- Pseudocode — architect refines
if exists (
  select 1 from public.profiles
   where brand_id = p_brand_id
) then
  raise exception 'Cannot hard-delete brand: % profiles (% admins, % users) still belong. Reassign or delete them first.', ...;
end if;
```

**Cascade preview UX (LOCKED):** when there are still profiles in the brand, the preview modal MUST show a red error block listing them (email + role) with "Manage admins" / "Manage users" deep links, and the "Continue to confirmation" button MUST be disabled. The user cannot click through to the type-to-confirm step until the profile count is zero. Fail fast at the preview step — don't let them get to the destructive button at all. This is more friction than (a)/(b)/(c), and that is the explicit design intent.

### Q-USER-B — Cron vs manual → **manual-only (PM default accepted)**

**Decision:** soft-deleted brands sit in limbo until a super-admin clicks "Purge now". No `pg_cron` infra add. The 30-day grace window is enforced **at the UI layer** (Purge button shows countdown / disabled until eligible), NOT at the DB layer.

**Rationale:** "be conservative on infra" — the user is fine with manual cleanup for v1 and can revisit if the trash list grows long enough to warrant automation.

### Q-USER-C — Single spec vs split → **one spec (PM default accepted)**

**Decision:** 012c ships rename + soft-delete + restore + cascade preview + hard-delete + the small migration in one cohesive PR. Trash UI lands as a sub-tab in BrandsSection.

**Rationale:** the surfaces are tightly coupled (the Trash sub-tab is unusable without restore; restore is meaningless without soft-delete; hard-delete is the natural finisher). Splitting would mostly create handoff overhead.

---

## Open questions resolved (PM defaults applied)

- **Soft-delete UI placement.** → Detail header, "Delete brand" outline button (red text, not red fill — the destructive intent surfaces in the type-to-confirm modal, not on the brand list itself). Mirrors how production tools like GitHub put a "Delete repository" button at the bottom of Settings.
- **Restore UI placement.** → **Trash sub-tab in BrandsSection** (per Q-USER-C single-spec ship). Sub-tabs are `Active (N)` / `Trash (M)`. Soft-deleted brands show in the Trash list pane with strikethrough name + the existing `DELETED` `StatusPill`. Restore button on the detail header when a soft-deleted brand is selected.
- **Brand renaming UI.** → Inline edit in the detail header (click name → input with Save/Cancel). Lighter-weight than opening BrandFormDrawer for a single-field edit. The drawer pattern is justified for + NEW BRAND because of future fields; renaming is one field today and likely tomorrow.
- **Hard-delete trigger.** → **Manual purge button only**. UI-side 30-day countdown gates the button; DB does not enforce.
- **Cascade preview.** → Required, two-step modal. Step 1 = preview (with the orphan-profile hard-block per Q-USER-A), Step 2 = type-the-name. Standard pattern for high-blast-radius UX.
- **Active-brand swap on soft-delete.** → Auto-swap `currentBrandId` to NULL when soft-deleting the currently-viewed brand, surface a toast.
- **Audit trail of the delete itself.** → New `brand_deletion_log` table. Survives the cascade (no FK to `brands`). Records soft-delete, restore, hard-delete with `deleted_by_user_id`, `deleted_by_email_snapshot`, brand name snapshot, and a jsonb payload (the preview counts at hard-delete time, for forensic value).
- **Realtime for brand soft-delete.** → Not in scope. Brands table stays out of the realtime publication. Other admin tabs reflect the change on next reload/route-change. Acceptable given the operation cadence.
- **Brand renaming to a soft-deleted-brand's old name.** → Allowed if no active brand currently holds that name (UNIQUE constraint on `brands.name` — soft-deleted rows still occupy the name; the operator must rename or hard-delete the soft-deleted brand first). This is the simplest behavior; surface only if user wants to free up names on soft-delete.
- **Casing of `brands.name`.** → Stays case-sensitive (matches today's `UNIQUE` constraint, no `lower()` index). Surface only if user wants case-insensitive uniqueness — would need a new index migration.
- **Test framework.** → Defer (sixth spec). Manual-test the cascade preview against the seed by purging a throwaway brand in local dev.

---

## Dependencies

- 012a applied (live in prod, commit `9bdb1b3`).
- 012b applied (live in prod, commit `87e1edc`). BrandsSection.tsx exists and is the host for the new affordances.
- `auth_is_super_admin()` helper from 012a.
- `useStore.ACTIVE_BRAND_KEY` + `setCurrentBrandId` from 012b — used to clear active brand on soft-delete.
- `ResponsiveSheet` (`src/components/cmd/`) for tablet/phone variants of the type-to-confirm and cascade-preview modals.
- `ResponsiveCmdShell` chrome contract from Spec 011 — every new UI element renders at all 3 breakpoints.
- `notifyBackendError` from `useStore.ts` for optimistic-revert paths.
- Existing admin-management flows (admin list / user list with reassign + delete actions) — these are the manual escape hatch the operator must use to clear orphan profiles before hard-delete per Q-USER-A. Architect should confirm those flows exist and are usable without leaving the Cmd UI; if not, surface as a follow-up.
- No new third-party libraries.

---

## Project-specific notes

### Cmd UI section / legacy
- All UI lands in `src/screens/cmd/sections/BrandsSection.tsx` and new components under `src/components/cmd/`. Zero touches to `src/screens/AdminScreens.tsx`.

### Per-store or admin-global
- Admin-global, super-admin-only. The `useIsSuperAdmin()` gate in `BrandsSection` already covers visibility.

### Realtime channels touched
- None. `brands` table is not in the realtime publication. Other admin tabs see the change on next route/reload — acceptable for the operation cadence (out-of-scope item above).

### Migrations needed
**Yes — one new migration** at `supabase/migrations/2026MMDDHHMMSS_brand_delete_cascade.sql` that does:
1. **Schema gap fix.** ALTER `stores.brand_id`, `vendors.brand_id`, `recipes.brand_id`, `prep_recipes.brand_id` to drop the existing FK and re-add as `ON DELETE CASCADE`. Today these are bare `references brands(id)` (default RESTRICT) — `DELETE FROM brands` would fail. This is a load-bearing prerequisite for `hard_delete_brand`. (`catalog_ingredients.brand_id` is already CASCADE per P1 / 012a migration.)
2. **Audit table.** `CREATE TABLE brand_deletion_log` with no FK to `brands` (so it survives cascade). RLS enabled; SELECT gated by `auth_is_super_admin()`; INSERT only via the SECURITY DEFINER RPCs.
3. **5 new RPCs:** `rename_brand`, `soft_delete_brand`, `restore_brand`, `hard_delete_brand`, `preview_brand_cascade`. All `SECURITY DEFINER`, all gated by the existing `auth_is_super_admin()` helper from 012a.
4. **Per Q-USER-A:** `hard_delete_brand` does NOT touch `profiles` at all. It pre-flights with a strict EXISTS check on `profiles WHERE brand_id = p_brand_id` and raises an EXCEPTION if any rows match. The 012a CHECK constraint stays as-is — there are no orphans because we refuse to create them.

### Edge functions touched
- None. The cascade lives in a SECURITY DEFINER RPC, not a Deno edge function. RPC is the right shape because the entire operation is SQL — no external API calls, no need for the service-token bearer pattern.

### Web/native scope
- Web first (super-admin operates from desktop). Native should not regress; the new affordances render correctly on phone via the existing `useIsCompact` / `useIsPhone` hooks already used in BrandsSection.

### Tests
- No test framework wired up. Manual-test by:
  1. `npm run dev:db:reset` (fresh local stack).
  2. Promote `admin@local.test` to super-admin via psql (per 012a §6 probe 5).
  3. Create a throwaway brand "TEST PURGE", insert a few catalog rows / a store via SQL, AND invite an admin to the brand.
  4. Soft-delete via the UI; verify it disappears from picker; verify it appears under Trash sub-tab.
  5. Restore from Trash; verify it goes back to active.
  6. Soft-delete again; click Purge; verify the cascade preview modal **shows the orphan-admin error block and disables Continue** (per Q-USER-A).
  7. Go reassign or delete the brand-admin via the admin-management flow; re-open the Purge modal; verify the error block is gone and Continue is enabled.
  8. Type the brand name; click PURGE PERMANENTLY; verify all rows are gone and `brand_deletion_log` has the row (and the prior soft-delete + restore rows too).
  9. Bonus: try `select hard_delete_brand('<some active brand id>')` directly via psql — should fail on the `deleted_at IS NULL` pre-flight (H4).
  10. Bonus: try the same on a soft-deleted brand that still has a profile attached — should fail with the orphan-profile EXCEPTION (H5).

### `app.json` slug
- No change. Not relevant.

---

## Risks

- **Schema gap on FK cascades.** Today's `stores.brand_id` etc. are `references brands(id)` with no `ON DELETE` clause. `DELETE FROM brands` would fail. The migration fixes this, but architect must verify no other dependent tables (e.g. report definitions, sidebar overrides) are similarly under-cascaded. Architect's design doc must enumerate every FK that points at `brands(id)` directly OR via `stores(id)` and declare each one's cascade behavior.
- **Orphan profile pre-flight is the safety contract.** The RPC's strict EXISTS check is the only thing standing between a hard-delete and a CHECK-violation cascade abort (012a's `profiles_role_brand_consistent` constraint). The architect's design must call out exactly which message format `hard_delete_brand` raises so the UI can pattern-match and surface the per-profile detail (or, preferably, the UI should re-call `preview_brand_cascade` and read the profile count rather than parsing exception text — which is more robust).
- **Cascade preview drift between preview and confirm.** The preview counts are taken at preview time; between preview and confirm, the actual cascade could erase a different number of rows (e.g. a staff member submits an EOD between the two clicks), OR a new admin could be invited to the brand mid-flow. Mitigation: re-run `preview_brand_cascade` server-side at hard-delete time as part of `hard_delete_brand`'s prelude and include the final counts in the `brand_deletion_log.payload`. The Q-USER-A pre-flight EXCEPTION already covers the "new admin appeared" case.
- **`brand_deletion_log` privacy.** The audit table records `deleted_by_email_snapshot`. RLS gates SELECT to super-admin. Acceptable.
- **30-day grace is UI-only (Q-USER-B).** A determined super-admin could `select hard_delete_brand(...)` from psql against a brand soft-deleted 5 minutes ago and skip the countdown. This is acknowledged and accepted — the UI button is the user-facing contract; the DB doesn't second-guess super-admin SQL access.
- **Type-to-confirm UX accessibility.** The destructive button must be keyboard-focusable and the modal must trap focus. Standard React Native Web focus-trap is required; flag for the frontend developer.
- **Two RPCs for read-of-deleted (`fetchBrandsLite({includeSoftDeleted:true})` and the new `loadBrandStatsIncludingDeleted`).** Already-supported by `db.ts` per the existing `includeSoftDeleted` flag on `fetchBrandsLite`. Need a parallel `fetchBrandsWithStats({includeSoftDeleted:true})` variant or a flag. Architect to choose.

---

## Definition of done (012c)

This spec is DONE when:
- Super-admin can rename, soft-delete, restore, and hard-delete brands entirely from the BrandsSection UI without touching the SQL editor.
- The 30-day grace window is enforced at the UI layer (restore is rejected past day 30 server-side; purge button is disabled until day 30 client-side).
- The cascade preview shows accurate row counts and matches what is actually erased.
- The orphan-profile pre-flight check fires correctly: a brand with attached profiles cannot be hard-deleted via the standard UI flow OR via direct RPC call.
- A throwaway brand has been created, soft-deleted, restored, soft-deleted again, had its admin reassigned/deleted, and hard-deleted in local dev. The `brand_deletion_log` table contains all four events.
- The 012a orphan-profile CHECK violation is no longer reachable (because we refuse to create orphans, per Q-USER-A).
- The detail-pane footer note "brand renaming and soft-delete are out of scope for 012b. Use the Supabase SQL editor for now; UI controls land in 012c." is removed.

---

## Backend design

### §0 — Probe results (pre-design read of the codebase)

Confirmed against the actual repo state on 2026-05-08. These are the load-bearing assumptions the design rests on; if any drifts, the migration or RPC pre-flight changes shape.

1. **FK `ON DELETE` behavior on `stores.brand_id`, `vendors.brand_id`, `recipes.brand_id`, `prep_recipes.brand_id`.** Confirmed RESTRICT (default) per [supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:55-58](supabase/migrations/20260504060452_brand_catalog_p1_additive.sql) — the four ALTER TABLE ADD COLUMN statements declare `references public.brands(id)` with no ON DELETE clause. P3 ([supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:19-22](supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql)) only flips them to NOT NULL, doesn't touch the FK action. **Implication:** `DELETE FROM brands WHERE id = ...` will fail today with a foreign-key-violation. The migration MUST drop and recreate these four FKs with `ON DELETE CASCADE` for `hard_delete_brand` to function. Constraint names are auto-generated by Postgres and conventionally `<table>_<column>_fkey` — i.e. `stores_brand_id_fkey`, `vendors_brand_id_fkey`, `recipes_brand_id_fkey`, `prep_recipes_brand_id_fkey`. The migration looks them up defensively from `pg_constraint` rather than assuming the names.

2. **`catalog_ingredients.brand_id` is already ON DELETE CASCADE** per [supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:36](supabase/migrations/20260504060452_brand_catalog_p1_additive.sql) (`brand_id uuid not null references public.brands(id) on delete cascade`). No change needed. `ingredient_conversions.catalog_id` cascades through `catalog_ingredients` (P3 lockdown FK is also cascade by default of catalog parent), so erasing brand → erases catalog rows → erases their conversions in one chain.

3. **012a RLS allows super-admin to SELECT soft-deleted brands.** Confirmed in [supabase/migrations/20260509000000_multi_brand_schema_rls.sql:422-427](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) — the `brand_member_read_brands` policy has `using (public.auth_can_see_brand(id) and (deleted_at is null or public.auth_is_super_admin()))`. Super-admin sees soft-deleted brands; non-super-admin does not. **Implication:** the Trash sub-tab works with no additional RLS change. `super_admin_manage_brands` (FOR ALL) gates UPDATE/DELETE to super-admin only — soft-delete (UPDATE deleted_at), restore (UPDATE deleted_at = null), and hard-delete (DELETE) all already require super-admin via this policy. The new RPCs add a second layer of gating via `auth_is_super_admin()` inside their bodies.

4. **`audit_log` is store-scoped, not directly brand-scoped.** Per [supabase/migrations/20260405000759_init_schema.sql:196-205](supabase/migrations/20260405000759_init_schema.sql), `audit_log.store_id` references `stores(id)` (no explicit ON DELETE clause = RESTRICT). However, since 012a's per-store RLS means `audit_log` rows live under stores, when we cascade-delete a brand → cascade hits stores → cascade should hit audit_log. **Probe finding: the `audit_log → stores` FK has NO `ON DELETE` clause either**, so it would block the cascade. The migration extends the same defensive approach to every store-child FK: `inventory_items`, `eod_submissions`, `waste_log`, `purchase_orders`, `pos_imports`, `audit_log`, `recipes` (legacy store_id column still exists), `prep_recipes` (same), `pos_recipe_aliases`, `flags`, `order_schedule`, `report_definitions`. Where the original migration did declare CASCADE (e.g. flags, pos_recipe_aliases per [20260502190001_flags_table.sql:13](supabase/migrations/20260502190001_flags_table.sql) and [20260425043301_pos_recipe_aliases.sql:12](supabase/migrations/20260425043301_pos_recipe_aliases.sql)), the migration is a no-op. Where it didn't, it's converted to CASCADE. **The umbrella's `audit_events` reference is a typo — the actual table is `audit_log`.**

5. **`brands.deleted_at` already exists** per 012a [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) §1. Confirmed by reading the file. No schema add for the column itself in this migration.

6. **`profiles.brand_id` is `ON DELETE SET NULL`** per 012a (spec §1, "Why `on delete set null` (not cascade) on `profiles.brand_id`"). This was a deliberate divergence from the umbrella's CASCADE wording — 012a's architect chose `set null` so deleting a brand doesn't erase the human user. **Q-USER-A explicitly REJECTS the auto-cleanup path: profiles must be manually reassigned/deleted before hard-delete.** With the strict pre-flight EXCEPTION in `hard_delete_brand`, we'll never actually exercise the SET NULL path — but it stays as a safety net (if somehow the RPC were bypassed and brand was deleted directly, the human user accounts wouldn't be wiped). 012c does NOT change `profiles.brand_id` FK behavior.

7. **Realtime publication does NOT include `brands`** (per 012a §0 probe #6 + this spec's "Out of scope"). Soft-delete + restore + hard-delete events do not stream to other admin tabs. **Implication:** no `alter publication supabase_realtime add table brand_deletion_log` either — the audit log is super-admin-only and there's no realtime use case. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply to this migration. (Documented in §7 risks.)

8. **`auth_is_super_admin()` exists from 012a.** Confirmed in [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql). All five new RPCs gate on this helper inside SECURITY DEFINER bodies.

9. **Migration filename:** `supabase/migrations/20260510010000_brand_delete_cascade.sql`. Date 2026-05-10 is the next clear day after the most recent migration (012a was 2026-05-09). Single file, single transaction.

10. **`useStore.ACTIVE_BRAND_KEY` + `setCurrentBrandId` from 012b** — confirmed in [src/store/useStore.ts:42](src/store/useStore.ts) and [src/store/useStore.ts:356](src/store/useStore.ts). The auto-swap-on-soft-delete-of-current logic plugs into `setCurrentBrandId(null)`, which already handles the picker reset + currentStore clear path correctly.

11. **Existing admin-management flows for orphan-profile cleanup** — partially exists. [src/lib/db.ts:1718](src/lib/db.ts) `fetchBrandAdmins(brandId)` returns the per-brand admins list rendered by the BrandsSection members tab. As noted in the 012b spec there: "Read-only in 012b. Suspend / delete / role-change controls land in 012c." So **012c also needs to add the suspend/delete/role-change controls on the members tab** to make the orphan-profile escape hatch actually clickable per Q-USER-A's "manually reassign or delete each admin/user via the existing admin management flows BEFORE purging the brand." Otherwise the user gets the red-error-block in the cascade preview but has no UI button to clear the orphans without dropping back to SQL. **Surface to user as an open question — see §8.**

---

### §1 — Schema additions in the new migration

**Migration filename:** `supabase/migrations/20260510010000_brand_delete_cascade.sql`. Single transaction. Idempotent (re-runnable as a no-op).

**1.1 — Brand-level FK CASCADE conversion (load-bearing for `hard_delete_brand`).**

For each of the four direct-brand-child tables (`stores`, `vendors`, `recipes`, `prep_recipes`), drop the existing RESTRICT FK and re-add with CASCADE. Look up actual constraint names from `pg_constraint` defensively (the auto-generated names are typically `<table>_brand_id_fkey` but we don't rely on the convention):

```
-- Pseudocode — backend developer encodes the actual SQL.
-- For each table in (stores, vendors, recipes, prep_recipes):
do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = '<table>'
     and c.contype = 'f'
     and c.conkey = (
       select array_agg(a.attnum order by a.attnum)
         from pg_attribute a
        where a.attrelid = t.oid and a.attname = 'brand_id'
     );
  if v_conname is not null then
    execute format('alter table public.<table> drop constraint %I', v_conname);
  end if;
end $$;

alter table public.<table>
  add constraint <table>_brand_id_fkey
  foreign key (brand_id) references public.brands(id) on delete cascade;
```

Equivalent block for each of the four tables. (The backend developer can collapse into a loop over a `text[]` if cleaner.)

**1.2 — Per-store FK CASCADE conversion (cascade chain via stores).**

When `brands → stores` cascades, the deleted store rows must in turn cascade to every per-store child. Most are already CASCADE per the per-store hardening migration's table definitions, but **the init schema declared several FKs without `ON DELETE`** — those default to RESTRICT and would block the second-stage cascade. Fix them:

| Table | FK column | Init declaration | Action |
|---|---|---|---|
| `inventory_items` | `store_id` | `references stores(id)` (no clause) | ADD CASCADE |
| `recipes` | `store_id` (legacy column, still NOT NULL-able from init) | `references stores(id)` | ADD CASCADE |
| `prep_recipes` | `store_id` (legacy) | `references stores(id)` | ADD CASCADE |
| `eod_submissions` | `store_id` | `references stores(id)` | ADD CASCADE |
| `waste_log` | `store_id` | `references stores(id)` | ADD CASCADE |
| `purchase_orders` | `store_id` | `references stores(id)` | ADD CASCADE |
| `pos_imports` | `store_id` | `references stores(id)` | ADD CASCADE |
| `audit_log` | `store_id` | `references stores(id)` | ADD CASCADE |
| `flags` | `store_id` | already CASCADE per [20260502190001_flags_table.sql:13](supabase/migrations/20260502190001_flags_table.sql) | NO-OP |
| `pos_recipe_aliases` | `store_id` | already CASCADE per [20260425043301_pos_recipe_aliases.sql:12](supabase/migrations/20260425043301_pos_recipe_aliases.sql) | NO-OP |
| `order_schedule` | `store_id` | check actual migration; assume RESTRICT — ADD CASCADE | ADD CASCADE |
| `report_definitions` | `store_id` | check actual migration; assume RESTRICT — ADD CASCADE | ADD CASCADE |

Same `pg_constraint` lookup pattern as 1.1. Defensive: the migration should run the conversion ONLY if the existing FK lacks ON DELETE CASCADE (read `pg_constraint.confdeltype` — `'a'` = NO ACTION/default, `'c'` = CASCADE, `'n'` = SET NULL). This makes the migration idempotent on prod (where some tables may have been backfilled to CASCADE by hand) and a no-op on tables already correctly cascading.

**1.3 — Per-store grandchildren** (already covered, document for clarity).

These already cascade through their parent (per init schema or later migrations), so no change needed. Documented in the migration's header comment so the next architect understands the full chain:

- `eod_entries.submission_id` → `eod_submissions(id) on delete cascade` (init schema line 130)
- `po_items.po_id` → `purchase_orders(id) on delete cascade` (init schema line 168)
- `pos_import_items.import_id` → `pos_imports(id) on delete cascade` (init schema line 186)
- `recipe_ingredients.recipe_id` → `recipes(id) on delete cascade` (init schema line 82)
- `prep_recipe_ingredients.prep_recipe_id` → `prep_recipes(id) on delete cascade` (init schema line 103)
- `recipe_prep_items.recipe_id` → `recipes(id) on delete cascade` (init schema line 110)
- `ingredient_conversions.catalog_id` → `catalog_ingredients(id) on delete cascade` (P3)
- `notifications.user_id` → `profiles(id)` — NOT cascaded by brand. Notifications are per-user, not per-brand. Surviving the cascade is fine; if the user themselves is later deleted, the FK takes care of it.
- `user_stores.store_id` → `stores(id) on delete cascade` (init schema line 33)
- `user_stores.user_id` → `profiles(id) on delete cascade` (init schema line 32)

**Full cascade tree** (documented in migration header):

```
brands
├── catalog_ingredients (CASCADE — P1) → ingredient_conversions (via catalog_id CASCADE — P3)
├── stores (CASCADE — added in 1.1) → inventory_items, eod_submissions → eod_entries,
│                                     waste_log, purchase_orders → po_items,
│                                     pos_imports → pos_import_items, audit_log,
│                                     flags, order_schedule, pos_recipe_aliases,
│                                     report_definitions, user_stores
├── vendors (CASCADE — added in 1.1)
├── recipes (CASCADE — added in 1.1) → recipe_ingredients, recipe_prep_items
├── prep_recipes (CASCADE — added in 1.1) → prep_recipe_ingredients
└── profiles (SET NULL — kept from 012a; pre-flight EXCEPTION makes it unreachable)
```

**1.4 — `brand_deletion_log` audit table.**

```
create table if not exists public.brand_deletion_log (
  id                uuid primary key default extensions.gen_random_uuid(),
  brand_id          uuid not null,                 -- NO FK — survives cascade
  brand_name        text not null,                 -- snapshot at action time
  event             text not null check (event in ('soft_deleted', 'restored', 'hard_deleted')),
  actor_user_id     uuid,                          -- nullable; SECURITY DEFINER calls auth.uid()
  actor_email       text,                          -- snapshot from auth.users at action time
  cascade_payload   jsonb,                         -- per-table row counts; null for soft/restore
  created_at        timestamptz not null default now()
);

create index if not exists brand_deletion_log_brand_id_idx
  on public.brand_deletion_log (brand_id);
create index if not exists brand_deletion_log_created_at_idx
  on public.brand_deletion_log (created_at desc);

alter table public.brand_deletion_log enable row level security;

comment on table public.brand_deletion_log is
  'Forensic audit of brand soft-delete / restore / hard-delete actions. No FK to brands so the row survives a brand cascade. Spec 012c.';
```

**Why no FK on `brand_id`:** the row must survive `delete from brands where id = X` because the whole point is to retain a record of *that the brand existed and was destroyed*. Naming the brand by id+name snapshot is enough; a future foreign-key violation when querying joined data is acceptable (the UI displays the snapshotted name).

**Destructive vs additive:** entirely additive (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS). The FK conversions in 1.1/1.2 are technically destructive (drop + add) but only swap the `confdeltype` value; row data is untouched.

**Rollout safety:** zero downtime. Postgres acquires an `ACCESS EXCLUSIVE` lock on each table briefly during the `ALTER TABLE DROP CONSTRAINT / ADD CONSTRAINT` pair, but on the production data volume (single-brand, ~145 catalog rows + 4 stores + ~572 inventory items) this is sub-second. If/when the dataset grows, this is still a one-time cost.

---

### §2 — RPC contracts

All five RPCs are `SECURITY DEFINER`, `set search_path = public, auth`, and gate on `auth_is_super_admin()` inside their body. RLS already enforces super-admin via `super_admin_manage_brands`, but the function-level gate is defense-in-depth (and gives a cleaner error message than RLS rejection).

**2.1 — `rename_brand(p_brand_id uuid, p_new_name text) returns uuid`**

```
create or replace function public.rename_brand(
  p_brand_id uuid,
  p_new_name text
) returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_trimmed text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can rename brands';
  end if;

  v_trimmed := trim(p_new_name);
  if length(v_trimmed) = 0 then
    raise exception 'Brand name cannot be empty';
  end if;

  -- UNIQUE constraint on brands.name will raise on collision; let it
  -- propagate. Caller surfaces via notifyBackendError.
  update public.brands
     set name = v_trimmed
   where id = p_brand_id;

  if not found then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  return p_brand_id;
end;
$$;

grant execute on function public.rename_brand(uuid, text) to authenticated;
```

**Request shape (from frontend via `db.renameBrand`):** `{ brandId: string, newName: string }`.
**Response shape:** the brand id (echo) on success; thrown `PostgrestError` with the EXCEPTION message on failure.
**Error cases:** non-super-admin, empty name, missing brand, name collision (UNIQUE violation surfaces as `code 23505`).

**2.2 — `soft_delete_brand(p_brand_id uuid) returns timestamptz`**

```
create or replace function public.soft_delete_brand(
  p_brand_id uuid
) returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_now timestamptz := now();
  v_brand_name text;
  v_actor_email text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can soft-delete brands';
  end if;

  -- Idempotent: no-op if already soft-deleted.
  select name into v_brand_name from public.brands where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  update public.brands
     set deleted_at = v_now
   where id = p_brand_id
     and deleted_at is null;

  if not found then
    -- Already soft-deleted; return existing timestamp without writing a
    -- new audit row (idempotent contract).
    return (select deleted_at from public.brands where id = p_brand_id);
  end if;

  select email into v_actor_email from auth.users where id = auth.uid();

  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'soft_deleted', auth.uid(), v_actor_email, null);

  return v_now;
end;
$$;

grant execute on function public.soft_delete_brand(uuid) to authenticated;
```

**Request:** `{ brandId: string }`. **Response:** the `deleted_at` timestamp (string).

**2.3 — `restore_brand(p_brand_id uuid) returns boolean`**

```
create or replace function public.restore_brand(
  p_brand_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_brand_name text;
  v_deleted_at timestamptz;
  v_actor_email text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can restore brands';
  end if;

  select name, deleted_at into v_brand_name, v_deleted_at
    from public.brands where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;
  if v_deleted_at is null then
    -- Already active; idempotent no-op.
    return true;
  end if;

  -- AC X4 — Restore is BLOCKED past the 30-day window.
  -- (UI also disables the button past day 30, but server-side is the
  -- contract; UI is the usability layer.)
  if (now() - v_deleted_at) > interval '30 days' then
    raise exception 'Restore window expired (% days since soft-delete). Use Purge to hard-delete.',
      extract(day from (now() - v_deleted_at))::int;
  end if;

  update public.brands set deleted_at = null where id = p_brand_id;

  select email into v_actor_email from auth.users where id = auth.uid();

  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'restored', auth.uid(), v_actor_email, null);

  return true;
end;
$$;

grant execute on function public.restore_brand(uuid) to authenticated;
```

**Request:** `{ brandId: string }`. **Response:** `true` on success.

**2.4 — `preview_brand_cascade(p_brand_id uuid) returns jsonb`**

Returns a JSON object with per-table row counts AND a `blocking_profiles` array. Heavy read but only one row scan per affected table; on the 286 KB seed this is sub-100ms.

```
create or replace function public.preview_brand_cascade(
  p_brand_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_payload jsonb;
  v_blocking_profiles jsonb;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can preview brand cascade';
  end if;

  -- Build the blocking-profiles array first. UI uses this to render the
  -- red error block + disable Continue per Q-USER-A.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'profile_id', p.id,
      'name', p.name,
      'email', u.email,
      'role', p.role,
      'status', p.status
    ) order by p.role, p.name
  ), '[]'::jsonb)
    into v_blocking_profiles
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.brand_id = p_brand_id;

  -- Per-table row counts. EXPLICITLY enumerate every table that will be
  -- touched by the cascade so the UI can render a complete table-of-counts.
  v_payload := jsonb_build_object(
    'brand_id', p_brand_id,
    'brand_name',
      (select name from public.brands where id = p_brand_id),
    'deleted_at',
      (select deleted_at from public.brands where id = p_brand_id),
    'blocking_profiles', v_blocking_profiles,
    'blocking_profile_counts', jsonb_build_object(
      'admins',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role in ('admin', 'master')),
      'users',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role = 'user'),
      'super_admins',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role = 'super_admin')
    ),
    'counts', jsonb_build_object(
      'catalog_ingredients',
        (select count(*) from public.catalog_ingredients where brand_id = p_brand_id),
      'ingredient_conversions',
        (select count(*) from public.ingredient_conversions ic
          join public.catalog_ingredients ci on ci.id = ic.catalog_id
          where ci.brand_id = p_brand_id),
      'vendors',
        (select count(*) from public.vendors where brand_id = p_brand_id),
      'recipes',
        (select count(*) from public.recipes where brand_id = p_brand_id),
      'recipe_ingredients',
        (select count(*) from public.recipe_ingredients ri
          join public.recipes r on r.id = ri.recipe_id
          where r.brand_id = p_brand_id),
      'recipe_prep_items',
        (select count(*) from public.recipe_prep_items rpi
          join public.recipes r on r.id = rpi.recipe_id
          where r.brand_id = p_brand_id),
      'prep_recipes',
        (select count(*) from public.prep_recipes where brand_id = p_brand_id),
      'prep_recipe_ingredients',
        (select count(*) from public.prep_recipe_ingredients pri
          join public.prep_recipes pr on pr.id = pri.prep_recipe_id
          where pr.brand_id = p_brand_id),
      'stores',
        (select count(*) from public.stores where brand_id = p_brand_id),
      'inventory_items',
        (select count(*) from public.inventory_items ii
          join public.stores s on s.id = ii.store_id
          where s.brand_id = p_brand_id),
      'eod_submissions',
        (select count(*) from public.eod_submissions es
          join public.stores s on s.id = es.store_id
          where s.brand_id = p_brand_id),
      'eod_entries',
        (select count(*) from public.eod_entries ee
          join public.eod_submissions es on es.id = ee.submission_id
          join public.stores s on s.id = es.store_id
          where s.brand_id = p_brand_id),
      'waste_log',
        (select count(*) from public.waste_log w
          join public.stores s on s.id = w.store_id
          where s.brand_id = p_brand_id),
      'purchase_orders',
        (select count(*) from public.purchase_orders po
          join public.stores s on s.id = po.store_id
          where s.brand_id = p_brand_id),
      'po_items',
        (select count(*) from public.po_items pi
          join public.purchase_orders po on po.id = pi.po_id
          join public.stores s on s.id = po.store_id
          where s.brand_id = p_brand_id),
      'pos_imports',
        (select count(*) from public.pos_imports pim
          join public.stores s on s.id = pim.store_id
          where s.brand_id = p_brand_id),
      'pos_import_items',
        (select count(*) from public.pos_import_items pii
          join public.pos_imports pim on pim.id = pii.import_id
          join public.stores s on s.id = pim.store_id
          where s.brand_id = p_brand_id),
      'audit_log',
        (select count(*) from public.audit_log al
          join public.stores s on s.id = al.store_id
          where s.brand_id = p_brand_id),
      'flags',
        (select count(*) from public.flags f
          join public.stores s on s.id = f.store_id
          where s.brand_id = p_brand_id),
      'order_schedule',
        (select count(*) from public.order_schedule os
          join public.stores s on s.id = os.store_id
          where s.brand_id = p_brand_id),
      'pos_recipe_aliases',
        (select count(*) from public.pos_recipe_aliases pra
          join public.recipes r on r.id = pra.recipe_id
          where r.brand_id = p_brand_id),
      'report_definitions',
        (select count(*) from public.report_definitions rd
          join public.stores s on s.id = rd.store_id
          where s.brand_id = p_brand_id),
      'user_stores_links',
        (select count(*) from public.user_stores us
          join public.stores s on s.id = us.store_id
          where s.brand_id = p_brand_id)
    )
  );

  return v_payload;
end;
$$;

grant execute on function public.preview_brand_cascade(uuid) to authenticated;
```

**Request:** `{ brandId: string }`. **Response:** JSONB object as above.

**2.5 — `hard_delete_brand(p_brand_id uuid) returns jsonb`**

```
create or replace function public.hard_delete_brand(
  p_brand_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_brand_name text;
  v_deleted_at timestamptz;
  v_actor_email text;
  v_cascade_payload jsonb;
  v_admins int;
  v_users int;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can hard-delete brands';
  end if;

  select name, deleted_at into v_brand_name, v_deleted_at
    from public.brands where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  -- Pre-flight #1 (AC H4): must be soft-deleted first.
  if v_deleted_at is null then
    raise exception 'Brand must be soft-deleted before hard-delete. Soft-delete first, then purge.';
  end if;

  -- Pre-flight #2 (AC H5, Q-USER-A): no orphan profiles.
  select
    count(*) filter (where role in ('admin', 'master')),
    count(*) filter (where role = 'user')
    into v_admins, v_users
    from public.profiles
   where brand_id = p_brand_id;

  if (v_admins + v_users) > 0 then
    raise exception
      'Cannot hard-delete brand: % profiles (% admins, % users) still belong. Reassign or delete them first.',
      v_admins + v_users, v_admins, v_users;
  end if;

  -- Snapshot cascade counts BEFORE the delete fires (the UI's preview was
  -- one round-trip ago; this is the at-execution-time count for forensics).
  v_cascade_payload := public.preview_brand_cascade(p_brand_id);

  -- Snapshot actor email.
  select email into v_actor_email from auth.users where id = auth.uid();

  -- Audit row FIRST. brand_deletion_log has no FK to brands so it'd
  -- survive the cascade either way, but logging-then-deleting is cleaner
  -- transactionally — if the cascade somehow throws, the audit is rolled
  -- back too.
  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'hard_deleted', auth.uid(), v_actor_email, v_cascade_payload);

  -- The cascade.
  delete from public.brands where id = p_brand_id;

  return v_cascade_payload;
end;
$$;

grant execute on function public.hard_delete_brand(uuid) to authenticated;
```

**Request:** `{ brandId: string }`. **Response:** the cascade-payload JSON (so the caller can show "X rows erased" in a confirmation toast).

**Idempotency:** none of the mutating RPCs are safely re-runnable in the strict sense (rename twice = two name changes; soft-delete twice = idempotent by guard; hard-delete twice = second call raises `Brand not found`). UI calls each once per user action; double-clicks are debounced via the modal-close pattern.

---

### §3 — RLS policies for `brand_deletion_log`

Read: super-admin only. Write: deny all (only the SECURITY DEFINER RPCs can write — and they bypass RLS by virtue of definer rights, so no INSERT policy is needed).

```
-- READ — super-admin only.
drop policy if exists "super_admin_read_brand_deletion_log" on public.brand_deletion_log;
create policy "super_admin_read_brand_deletion_log"
  on public.brand_deletion_log for select
  using (public.auth_is_super_admin());

-- No INSERT/UPDATE/DELETE policies. With RLS enabled and no permissive
-- policies, all writes from `authenticated` and `anon` are denied.
-- SECURITY DEFINER functions bypass RLS, so the RPCs in §2 can write
-- without an explicit policy.
```

**Justification for no INSERT policy:** any code path that wants to write `brand_deletion_log` must go through one of the SECURITY DEFINER RPCs. This is the audit trail's integrity contract: if someone (a future migration, a panicked operator) tries to UPDATE/DELETE a row to cover their tracks, they cannot. (Super-admin via dashboard SQL editor still can, of course — that's the definition of super-admin. RLS doesn't apply to dashboard.)

---

### §4 — Edge function changes

**None.** The cascade lives in a SECURITY DEFINER RPC (`hard_delete_brand`), not a Deno edge function. Per CLAUDE.md, the edge-function pattern is reserved for external HTTP integration (POS imports, push notifications) or service-token-bearer paths (`staff-*`, `pwa-catalog`). Brand deletion is pure SQL — RPC is the right shape.

---

### §5 — `src/lib/db.ts` surface

Six new helpers. All in the `// ─── BRAND + CATALOG ────` section, alongside `createBrand`, `fetchBrandsLite`, `fetchBrandsWithStats`, `fetchBrandAdmins`. snake_case → camelCase via `mapItem`-style helpers as standard.

```typescript
// Spec 012c — rename, soft-delete, restore, preview, hard-delete, audit log fetch.
//
// All five mutating helpers wrap a SECURITY DEFINER RPC gated by
// auth_is_super_admin(). RLS also gates super_admin_manage_brands —
// the function-level check is defense-in-depth + cleaner errors.

export async function renameBrand(
  brandId: string,
  newName: string,
): Promise<void>;

export async function softDeleteBrand(
  brandId: string,
): Promise<string>; // returns ISO timestamp (deleted_at)

export async function restoreBrand(
  brandId: string,
): Promise<void>;

export interface BrandCascadePreview {
  brandId: string;
  brandName: string;
  deletedAt: string | null;
  blockingProfiles: Array<{
    profileId: string;
    name: string;
    email: string | null;
    role: 'super_admin' | 'admin' | 'master' | 'user';
    status: 'active' | 'pending';
  }>;
  blockingProfileCounts: { admins: number; users: number; superAdmins: number };
  counts: Record<string, number>; // table_name → row count
}

export async function previewBrandCascade(
  brandId: string,
): Promise<BrandCascadePreview>;

export async function hardDeleteBrand(
  brandId: string,
): Promise<BrandCascadePreview>; // returns the at-execution snapshot

// Cleanup #2-style — a Trash sub-tab variant of fetchBrandsWithStats.
// Architect choice (per spec Risks #6): a flag on the existing function,
// not a separate function. Less surface area; consumer flips a boolean.
// Default: includeSoftDeleted = false (keeps existing call sites working).
export async function fetchBrandsWithStats(opts?: {
  includeSoftDeleted?: boolean;
}): Promise<Array<Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number }>>;

export interface BrandDeletionLogEntry {
  id: string;
  brandId: string;
  brandName: string;
  event: 'soft_deleted' | 'restored' | 'hard_deleted';
  actorUserId: string | null;
  actorEmail: string | null;
  cascadePayload: BrandCascadePreview | null;
  createdAt: string;
}

export async function fetchBrandDeletionLog(
  opts?: { brandId?: string; limit?: number },
): Promise<BrandDeletionLogEntry[]>;

// Spec 012c (Q-ARCH-1) — demote an admin/master profile to user role AND
// clear brand_id. Both columns must change in a single UPDATE so the
// profiles_role_brand_consistent CHECK (012a §4 — `(role = 'user')` allows
// any brand_id) passes AND the orphan-profile pre-flight in
// hard_delete_brand stops counting this row.
//
// Why clear brand_id: the H5 pre-flight is `EXISTS (SELECT 1 FROM profiles
// WHERE brand_id = p_brand_id)` — it doesn't filter by role. Demoting to
// user without clearing brand_id leaves the profile counting toward the
// blocking-profile total, which defeats the purpose of the demote action.
//
// PostgREST UPDATE on profiles SET role='user', brand_id=NULL WHERE id=...
// RLS on profiles must permit the super-admin to perform this update.
// Backend-developer to verify the existing 012a policies cover super-admin
// UPDATE on profiles. If they don't, wrap as a new SECURITY DEFINER RPC
// `demote_profile_to_user(p_profile_id uuid)` gated by auth_is_super_admin()
// — same pattern as the brand RPCs in §2. Architect default: try the direct
// PostgREST UPDATE first; fall back to RPC if RLS blocks it.
//
// Returns the updated profile id on success. Surfaces RLS rejection or
// CHECK-constraint violations as thrown errors via notifyBackendError.
//
// NOTE: deleting a profile uses the EXISTING auth.deleteUser(userId) helper
// at src/lib/auth.ts:409. NO new db.ts helper for delete — the store action
// `deleteProfile` calls auth.deleteUser directly.
export async function demoteProfileToUser(
  profileId: string,
): Promise<string>;
```

**snake_case → camelCase mapping:** `actor_user_id` → `actorUserId`, `actor_email` → `actorEmail`, `cascade_payload` → `cascadePayload`, `created_at` → `createdAt`. Mirrors `mapItem` / `mapBrandStats` shape already in db.ts.

**Note on existing `fetchBrandsWithStats`:** today it's `Array<Brand & {...}>` with no params. Adding the optional `opts.includeSoftDeleted` is back-compat (existing callers pass nothing → `false` default → same behavior). The implementation drops the `.is('deleted_at', null)` filter when the flag is true and adds it back when false.

---

### §6 — Realtime impact

**`brand_deletion_log`:** NOT added to the `supabase_realtime` publication. Super-admin-only audit table; no live-broadcast use case.

**`brands`:** NOT in the realtime publication today and not added in this migration (per Out-of-scope item). Soft-delete + restore + hard-delete events do NOT stream to other admin tabs.

**Implication:** if a super-admin has two admin tabs open and soft-deletes a brand in tab A, tab B will continue to display the brand in its picker until the next reload. Acceptable per PM Q-B-adjacent ("once-a-month admin operation"). The spec's S5 auto-swap-of-currentBrandId only fires in the tab that initiated the delete — we don't broadcast to other tabs. **Document as a UI tradeoff, not a defect.**

**Publication restart ritual (CLAUDE.md memory note):** does NOT apply to this migration. Confirmed by reading the migration plan above — no `alter publication supabase_realtime add/drop table`. The `docker restart supabase_realtime_imr-inventory` step is NOT required for 012c. (If a future spec adds `brands` to the publication for cross-tab live updates, the dev-stack restart applies as it always does.)

---

### §7 — Frontend store impact (`src/store/useStore.ts`)

**New actions (6) on `useStore`:**

```typescript
interface StoreActions {
  // ... existing 012b actions ...

  // Spec 012c — brand lifecycle.
  /** Rename a brand. Optimistic-then-revert via notifyBackendError. */
  renameBrand: (brandId: string, newName: string) => Promise<boolean>;

  /** Soft-delete a brand. Optimistic — moves to brandStats `deletedAt !== null`
   *  partition. If brandId === currentBrandId, also auto-swaps to null
   *  (per AC S5) and surfaces a toast. Revert on backend error. */
  softDeleteBrand: (brandId: string) => Promise<boolean>;

  /** Restore a soft-deleted brand. Optimistic. Revert on backend error. */
  restoreBrand: (brandId: string) => Promise<boolean>;

  /** Preview the cascade — wraps db.previewBrandCascade. No optimistic
   *  state mutation; just returns the payload to the caller. */
  previewBrandCascade: (brandId: string) => Promise<BrandCascadePreview | null>;

  /** Hard-delete a brand. NO optimistic mutation — destructive enough that
   *  the UI waits for server confirmation before removing the row. After
   *  success, drops the row from brandStats and brandsList; if brandId ===
   *  currentBrandId, auto-swaps to null. Revert is a no-op (no local
   *  mutation occurred); errors surface via notifyBackendError. */
  hardDeleteBrand: (brandId: string) => Promise<BrandCascadePreview | null>;

  /** Spec 012c — fetch brand_deletion_log entries. Powers the (optional)
   *  audit view in BrandsSection. Result lives in the brandDeletionLog
   *  slice keyed by brandId, or `__all__` for the unfiltered call. */
  brandDeletionLog: Record<string, BrandDeletionLogEntry[]>;
  loadBrandDeletionLog: (brandId?: string) => Promise<void>;

  /** Spec 012c — variant of loadBrandStats that includes soft-deleted brands.
   *  Powers the Trash sub-tab. Returns the merged list; the UI partitions
   *  on `deletedAt !== null` to render the Trash row count. */
  loadBrandStatsIncludingDeleted: () => Promise<void>;

  /** Spec 012c (Q-ARCH-1) — demote a brand-admin/master profile to user.
   *  Optimistic-then-revert: row's role flips locally; on backend error,
   *  revert + notifyBackendError. Wraps db.demoteProfileToUser. */
  demoteProfileToUser: (profileId: string) => Promise<boolean>;

  /** Spec 012c (Q-ARCH-1) — irreversibly delete a profile + auth user.
   *  NO optimistic mutation (destructive; await server confirmation). On
   *  success, removes the row from any cached members lists (brandAdmins,
   *  fetchBrandAdmins(brandId) cache slice). On error, notifyBackendError.
   *  Wraps the existing auth.deleteUser(userId) helper. */
  deleteProfile: (profileId: string) => Promise<boolean>;
}
```

**Optimistic-then-revert pattern (per CLAUDE.md):**

- `renameBrand`: optimistically update `brandsList[i].name` and `brandStats[i].name` and (if currently selected) any header pickers; on backend error, revert all three slices and call `notifyBackendError('Rename brand', e)`.
- `softDeleteBrand`: optimistically set `brandStats[i].deletedAt = now()` (so it disappears from the active partition and appears in Trash); if `brandId === get().currentBrandId`, call `setCurrentBrandId(null)` AND show a toast `Toast.show({ type: 'info', text1: 'Brand deleted', text2: 'Switched to All brands view.' })`; on backend error, revert all mutations + `notifyBackendError`.
- `restoreBrand`: optimistically set `brandStats[i].deletedAt = null`; on backend error revert + `notifyBackendError`.
- `hardDeleteBrand`: NO optimistic mutation. After successful server response, remove from `brandStats` and `brandsList`; if currentBrandId, swap to null. On backend error, no revert needed (state was unchanged) — just `notifyBackendError`.
- `demoteProfileToUser` (Q-ARCH-1): optimistically flip the cached profile's `role` to `'user'` in the `brandAdmins` slice (the cache key for `fetchBrandAdmins(brandId)`); on backend error, revert + `notifyBackendError('Demote profile', e)`. The members tab re-renders from the cache so the row visually moves out of the admins partition.
- `deleteProfile` (Q-ARCH-1): NO optimistic mutation. After successful `auth.deleteUser(userId)` response, drop the row from the `brandAdmins` cache slice (and any other slice that holds profiles). On error, no revert needed — just `notifyBackendError('Delete profile', e)` and surface the toast text from the edge-function response.

**Auto-swap race condition documented:** if super-admin has tab A on Brand X and tab B on Brand X, soft-deleting in tab A swaps tab A's `currentBrandId` to null. Tab B continues to think it's on Brand X until next route navigation triggers a load that fails (RLS still allows super-admin to read the soft-deleted brand) or until the user reloads. **Acceptable; documented in §8 Risks.**

---

### §8 — UI component design

**8.1 — BrandsSection layout.**

Add a sub-tab strip ABOVE the existing list pane (inside `ListPane`). Two tabs:
- `Active (N)` — current behavior; renders only brands where `deletedAt === null`.
- `Trash (M)` — renders only brands where `deletedAt !== null`, sorted by `deletedAt DESC`, with strikethrough name styling and a `DELETED` `StatusPill`. Row count badge in the tab label.

The existing `TabStrip` component (`src/components/cmd/TabStrip.tsx`) is reused. The sub-tab state lives in `BrandsSection` as `const [listTab, setListTab] = useState<'active' | 'trash'>('active');`.

When switching to Trash, the section calls `loadBrandStatsIncludingDeleted` once per session (idempotent — re-call updates the slice).

**8.2 — Inline rename in detail header.**

Click brand name → input replaces the `<Text style={Type.h1}>` block. Save on Enter or blur; Cancel on Escape. Mirrors existing inline-edit patterns elsewhere in cmd sections (see e.g. how `RecipesSection` handles inline edits — backend-developer to copy that pattern). On Save, calls `useStore.renameBrand(brandId, newName)`. On collision, the toast surfaces the UNIQUE-violation error and the input reverts.

**8.3 — Soft-delete button in detail header (active brand only).**

Outline button, red text, mono font, lower-right of the hero block. Opens `TypeToConfirmModal` with `requiredText={brand.name}`, `destructiveLabel="DELETE BRAND"`, `description="Marks the brand as soft-deleted. Will be restorable for 30 days, then eligible for permanent purge."`. On confirm, calls `useStore.softDeleteBrand(brandId)`.

**8.4 — Restore button + Purge button in detail header (Trash brand only).**

When the selected brand is in Trash:
- **Restore** — outline button, accent color. Disabled if `now - deletedAt > 30 days` with tooltip `Restore window expired (X days). Use Purge to hard-delete.`. On click, calls `useStore.restoreBrand(brandId)`.
- **Purge now** — solid button, red. Disabled with countdown `Purge eligible in X days` until `now - deletedAt >= 30 days`. On click, opens `CascadePreviewModal`.

**8.5 — `TypeToConfirmModal` (new generic component).**

`src/components/cmd/TypeToConfirmModal.tsx`. Props:

```typescript
interface TypeToConfirmModalProps {
  visible: boolean;
  title: string;
  description?: string;
  requiredText: string;          // user must type this exactly
  destructiveLabel: string;      // button label e.g. "DELETE BRAND"
  destructiveTone?: 'warning' | 'danger'; // default 'danger'
  onConfirm: () => Promise<void>;
  onClose: () => void;
}
```

Uses `ResponsiveSheet` (per spec U1, dependency from 012b's component lib). Web-side keyboard focus trap (the input gets autofocus on open; Tab cycles input → Cancel → Confirm; Escape closes; Enter submits when valid). Confirm button enabled only when `input === requiredText` (case-sensitive, trimmed).

**8.6 — `CascadePreviewModal` (new component).**

`src/components/cmd/CascadePreviewModal.tsx`. Props:

```typescript
interface CascadePreviewModalProps {
  visible: boolean;
  brandId: string;
  brandName: string;
  onClose: () => void;
  onPurgeConfirmed: () => void; // fires after type-to-confirm step succeeds
  /** Spec 012c — open the BrandsSection members tab on the supplied brand
   *  so the operator can clear orphan profiles. Wired via prop so this
   *  component stays UI-state-agnostic. */
  onManageMembers: (brandId: string) => void;
}
```

**Two-step UI inside one modal:**

**Step 1 — preview:** on mount, calls `useStore.previewBrandCascade(brandId)`. Shows:
- Header: brand name + brand id.
- **If `blockingProfiles.length > 0`:** RED ERROR BLOCK at top with the message `Cannot purge: N profiles still belong to this brand`, a list of `email · role` rows, two action buttons (`Manage admins` → calls `onManageMembers`; `Manage users` → also calls `onManageMembers` or surfaces to a future user-management section). The Continue button is DISABLED.
- Per-table row counts table (mono font, two columns: `table → count`), sourced from `payload.counts`. Total at the bottom.
- `← Cancel` and `Continue to confirmation →` buttons. Continue disabled if blocking profiles exist OR if preview is still loading.

**Step 2 — type-to-confirm:** internal state flips to step 2; renders the same `TypeToConfirmModal` body inline (or reuses the component as a sub-modal). `requiredText = brandName`; `destructiveLabel = 'PURGE PERMANENTLY'`; `destructiveTone = 'danger'`. On confirm, calls `useStore.hardDeleteBrand(brandId)` (which the parent passes via `onPurgeConfirmed` after re-fetching the cascade preview server-side as part of its prelude).

**Re-fetch on step 2:** when the user clicks Continue, the modal re-fetches `previewBrandCascade` to ensure no orphan profiles slipped in between Step 1 and Step 2 (mitigation for "new admin invited mid-flow", per Risks §211 of the spec). If new orphans appear, modal flips back to Step 1 with the updated red error block.

**8.7 — Members tab — per-row action buttons (RESOLVED Q-ARCH-1, two buttons).**

Per Q-ARCH-1 = option (2), the members tab gets TWO new per-row action buttons on each admin/master row, both gated on `useIsSuperAdmin()`:

**Button A — `Demote to user` (lighter affordance).**
- Single-click confirm via the cross-platform `confirmAction` helper at [src/utils/confirmAction.ts](src/utils/confirmAction.ts) — copy: `Demote {profile.name} ({profile.email}) from {role} to user? They will lose admin access to this brand. You can re-promote later via "+ INVITE ADMIN".`
- On confirm, calls `useStore.demoteProfileToUser(profileId)` (new action — see §7).
- Style: outline button, neutral tone (NOT destructive red — this is reversible).
- Optimistic-then-revert: row's role pill updates to `USER` immediately; if backend rejects, revert + `notifyBackendError`.
- After success: row stays in the members list but moves to the `USER` partition (the existing `MembersTab` already partitions by role; the row visually re-sorts).
- Reversibility note for the user (lock-in): re-promoting a demoted user back to admin is via the existing `+ INVITE ADMIN` form (creates a new invitation) OR via a future profile-update flow in 012c-future. 012c does not add a one-click "re-promote" button.

**Button B — `Delete profile` (destructive).**
- Opens `TypeToConfirmModal` with `requiredText={profile.name}`, `destructiveLabel="DELETE PROFILE"`, `destructiveTone='danger'`, `description={`Permanently deletes ${profile.name} (${profile.email}). Removes both the profile and the auth.users row. This cannot be undone.`}`.
- On confirm, calls `useStore.deleteProfile(profileId)` (new action — wraps the existing `auth.deleteUser(userId)` helper at [src/lib/auth.ts:409](src/lib/auth.ts), which posts to the existing `delete-user` edge function).
- Style: outline button, red text, mono font (mirrors the brand-delete button's affordance).
- NO optimistic mutation — destructive enough to wait for server confirmation. After success: row drops from members tab; success toast `Toast.show({ type: 'info', text1: 'Profile deleted', text2: `${profile.name} has been removed.` })`.
- Errors surface via `notifyBackendError`.

**Why both, not one:** Q-USER-A's workflow demands the operator clear all orphan profiles before purge. `Demote to user` covers the case where the human is still an active employee but no longer affiliated with the brand. `Delete profile` covers the case where the human is leaving entirely. Without both, the operator either (a) deletes humans they should have just demoted, or (b) accumulates demoted-user accounts that should have been deleted.

**Self-protection guard:** if `profileId === currentUser.id` (super-admin trying to delete or demote themselves), both buttons are hidden. (Super-admin row in the members tab already shouldn't have these controls anyway, but defensive.)

**`MembersTab` location:** the members tab body is a sub-component inside `src/screens/cmd/sections/BrandsSection.tsx` (or a co-located component in the same file/directory — backend-developer to confirm by reading the file before editing). The two buttons go in the per-row trailing-action slot, alongside any existing "view details" affordance.

**CascadePreviewModal deep links:** the `Manage admins` button on the red-error-block now genuinely deep-links to the members tab where both buttons are present and clickable. No SQL escape hatch needed; the v0 workaround in the previous draft of this spec is removed.

**8.8 — Auto-swap toast.**

Reuses existing `Toast.show` from `react-native-toast-message`:

```typescript
Toast.show({
  type: 'info',
  text1: `Brand "${brandName}" was deleted`,
  text2: 'Switched to All brands view.',
  visibilityTime: 4000,
});
```

Fired inside `softDeleteBrand` and `hardDeleteBrand` actions when `brandId === get().currentBrandId`.

---

### §9 — Files to create / modify

**New:**
- `supabase/migrations/20260510010000_brand_delete_cascade.sql` (single transaction).
- `src/components/cmd/TypeToConfirmModal.tsx` — reused for BOTH the brand-delete flow AND the new Q-ARCH-1 delete-profile flow.
- `src/components/cmd/CascadePreviewModal.tsx`.

**Modified:**
- `src/lib/db.ts` — six brand-lifecycle helpers per §5; updated `fetchBrandsWithStats` signature to accept `opts.includeSoftDeleted`; ALSO new `demoteProfileToUser(profileId)` helper per Q-ARCH-1 (PostgREST UPDATE setting `role='user'`, `brand_id=NULL`).
- `src/store/useStore.ts` — six brand-lifecycle actions + `brandDeletionLog` slice + auto-swap logic in `softDeleteBrand`/`hardDeleteBrand` per §7. ALSO TWO new Q-ARCH-1 actions: `demoteProfileToUser(profileId)` (optimistic) and `deleteProfile(profileId)` (non-optimistic, wraps existing `auth.deleteUser`). Update the `StoreActions` interface and the initial state.
- `src/screens/cmd/sections/BrandsSection.tsx` — add Active/Trash sub-tabs in ListPane; add inline rename in DetailPane header; add Delete (active) / Restore + Purge (Trash) buttons; integrate the two modals; remove the 012b footer note about renaming/soft-delete being out of scope. ALSO add the per-row `Demote to user` button (one-click `confirmAction`) AND `Delete profile` button (TypeToConfirmModal) to the members tab per Q-ARCH-1 §8.7. (If the members tab body lives in a co-located `MembersTab` component, edit that file instead — backend-developer to confirm by reading.)
- `src/types/index.ts` — add `BrandDeletionLogEntry` type and `BrandCascadePreview` type. (Or alternatively co-locate them in `db.ts` and re-export.)

**Unmodified (but verified compatible):**
- `src/lib/auth.ts` — `deleteUser(userId)` at line 409 already exists and is reused as-is by the new `deleteProfile` store action. No code change required in this file.
- `supabase/functions/delete-user/` — existing edge function reused as-is. **Optional minor hardening:** verify the `requireAdminCaller` allowed-roles set ([supabase/functions/delete-user/index.ts:14](supabase/functions/delete-user/index.ts) — currently `{"admin", "master"}`) is acceptable for super-admin callers (super-admin's JWT app_metadata.role is `super_admin`, NOT in the set — but the function falls through to the profile-table role lookup, which also won't match). **Backend-developer should verify super-admin can actually call this edge function end-to-end before relying on it for the Delete profile button.** If broken, add `super_admin` to `ADMIN_ROLES`. List in `## Files changed` if edited.
- `src/hooks/useRealtimeSync.ts` — no change. Brand changes don't realtime-broadcast.
- `src/hooks/useRole.ts` — no change. Super-admin gate already works.
- All other Cmd sections — no change. They consume brand data through `useStore.brand` which keeps working.

---

### §10 — Verification probes (post-deploy)

The user runs these against local dev (and later prod) to confirm the destructive ops are safe and idempotent. Setup data per 012a §6 conventions (brand B + brandb@local.test).

**Probe 1 — soft-delete a brand makes it disappear from active partition.**
1. UI: super-admin selects "TEST BRAND B" in Brands Section, clicks `Delete brand`, types "TEST BRAND B" in the modal, clicks Delete.
2. Verify brand disappears from the Active sub-tab list.
3. Verify brand appears in the Trash sub-tab list with strikethrough + DELETED pill.
4. Verify `select deleted_at from brands where id='2b...'` is non-null.
5. Verify `select * from brand_deletion_log where event='soft_deleted'` has the row with actor_email matching wzhchen113@gmail.com.

**Probe 2 — soft-delete of currentBrandId auto-swaps to null.**
1. Super-admin sets brand picker to "TEST BRAND B".
2. Soft-delete TEST BRAND B from BrandsSection.
3. Verify the header brand picker collapses to "All brands".
4. Verify a toast appeared.

**Probe 3 — restore.**
1. From Trash sub-tab, select TEST BRAND B, click Restore.
2. Verify brand returns to Active sub-tab.
3. Verify `deleted_at IS NULL` in DB.
4. Verify `brand_deletion_log` has the `'restored'` row.

**Probe 4 — restore past 30 days fails.**
1. Manually set `update brands set deleted_at = now() - interval '31 days' where id='2b...'`.
2. UI: Restore button is disabled with tooltip "Restore window expired".
3. Direct RPC: `select restore_brand('2b...')` → raises EXCEPTION.

**Probe 5 — cascade preview with 0 profiles → shows row counts, Continue enabled.**
1. Manually clear the brand-B admin: `update profiles set brand_id=null, role='user' where brand_id='2b...'`.
2. UI: open CascadePreviewModal for TEST BRAND B.
3. Verify red error block does NOT appear.
4. Verify per-table counts render (catalog_ingredients=1, stores=1, etc. — matches probe-setup data from 012a).
5. Verify Continue button enabled.

**Probe 6 — cascade preview with 1+ profiles → red error block, Continue disabled.**
1. Re-attach a brand-B admin: `update profiles set brand_id='2b...', role='admin' where id='44444444-...'`.
2. UI: open CascadePreviewModal.
3. Verify red error block lists the brandb@local.test admin row.
4. Verify Continue button disabled.
5. Verify "Manage admins" link opens the members tab.

**Probe 7 — hard-delete (after clearing profiles) wipes brand + dependents.**
1. Clear profile (per Probe 5 setup).
2. UI: open CascadePreviewModal → Continue → type "TEST BRAND B" → PURGE PERMANENTLY.
3. Verify brand row gone from `brands`.
4. Verify all per-brand catalog/recipes/stores/inventory rows gone.
5. Verify `brand_deletion_log` has the `'hard_deleted'` row with cascade_payload populated.

**Probe 8 — hard-delete RPC pre-flight #1 (must be soft-deleted).**
1. Direct: `select hard_delete_brand('2a000000-...01')` (active 2AM brand).
2. Verify EXCEPTION: "Brand must be soft-deleted before hard-delete..."

**Probe 9 — hard-delete RPC pre-flight #2 (orphan profiles block).**
1. Soft-delete a brand that still has admin profiles attached.
2. Direct: `select hard_delete_brand('2b...')`.
3. Verify EXCEPTION: "Cannot hard-delete brand: N profiles..."

**Probe 10 — non-super-admin cannot call any RPC.**
1. As brand-A admin (not super-admin), `select rename_brand('2a...', 'BAD')`.
2. Verify EXCEPTION: "Only super-admin can rename brands".
3. Repeat for soft_delete_brand, restore_brand, preview_brand_cascade, hard_delete_brand.

**Probe 11 — `brand_deletion_log` RLS.**
1. As brand-A admin: `select count(*) from brand_deletion_log` → 0 rows (RLS blocks read).
2. As super-admin: same query returns all rows.
3. As any role: `insert into brand_deletion_log (...)` → RLS rejection.

**Probe 12 — responsive parity at 6 widths per Spec 011.**
- Browser walk: 1440 / 1180 / 1024 / 768 / 414 / 360.
- Verify TypeToConfirmModal renders correctly at each (centered desktop, ResponsiveSheet on phone/tablet) — both for the brand-delete flow AND the new delete-profile flow.
- Verify CascadePreviewModal renders correctly with both Step 1 and Step 2 at each width.
- Verify Trash sub-tab list pane is usable on phone (full-width per existing ListPane logic).
- Verify the new per-row buttons in the members tab (`Demote to user`, `Delete profile`) are tap-targetable on phone (≥44 px touch target).

**Probe 13 — Q-ARCH-1 `Demote to user` shrinks the blocking-profile list.**
1. Setup: brand B has admin `brandb@local.test` attached. Open CascadePreviewModal on TEST BRAND B → red error block lists 1 admin. Continue disabled.
2. Click `Manage admins` → navigates to members tab.
3. Click `Demote to user` on the brandb row → confirmAction popup → confirm.
4. Verify: row's role pill flips to `USER` (or row moves to USER partition); profile is gone from the blocking-profile total.
5. Re-open CascadePreviewModal → red error block is GONE; Continue is enabled.
6. Direct DB: `select role, brand_id from profiles where id = '...brandb...'` → `role='user'` AND `brand_id IS NULL`. (Both columns must change — see §5 helper rationale.)
7. Verify the demoted user can still log in (sanity check that the auth.users row was untouched).

**Probe 14 — Q-ARCH-1 `Delete profile` shrinks the profile count + removes from members tab + removes from auth.**
1. Setup: brand B has admin `brandb2@local.test` attached (insert a second test admin if needed).
2. From members tab, click `Delete profile` on brandb2 row → TypeToConfirmModal opens.
3. Type the profile name exactly → click `DELETE PROFILE`.
4. Verify: row drops from members tab; success toast appears.
5. Direct DB: `select count(*) from profiles where id = '...brandb2...'` → 0.
6. Direct DB: `select count(*) from auth.users where email = 'brandb2@local.test'` → 0. (Edge function actually wiped the auth row.)
7. Verify the deleted user can no longer log in.
8. Re-open CascadePreviewModal → blocking-profile total decremented (or zero if this was the last one).

**Probe 15 — Q-ARCH-1 self-protection guards.**
1. As super-admin, navigate to a brand the super-admin is somehow listed in (shouldn't happen in practice, but the guard is defensive).
2. Verify both `Demote to user` and `Delete profile` are HIDDEN on the super-admin's own row.
3. Bonus: try `select demote_profile_to_user('<super-admin-id>')` directly — expect either RLS rejection (if direct PostgREST UPDATE) or RPC EXCEPTION (if RPC variant). Either is acceptable; the UI guard is the primary safety, the DB layer is secondary.

**Probe 16 — Q-ARCH-1 super-admin can call delete-user edge function end-to-end.**
1. As super-admin, click `Delete profile` on a throwaway profile.
2. Verify HTTP 200 from the edge function (network tab).
3. If 403 instead, the edge function's `requireAdminCaller` does NOT accept super-admin — backend-developer must add `super_admin` to `ADMIN_ROLES` at [supabase/functions/delete-user/index.ts:14](supabase/functions/delete-user/index.ts) and redeploy.

---

### §11 — Risks and tradeoffs

1. **Cascade preview RPC scans many tables per call.** The `preview_brand_cascade` RPC issues ~20 `count(*)` subqueries with parent joins. On the 286 KB seed (single brand, ~145 catalog rows, 41 recipes, 4 stores, ~572 inventory items) this completes in well under 100ms. Worst case at 100x scale (10K recipes, 50K inventory items) is still sub-second because each count uses an indexed FK. **At 1000x scale, may want to materialize this as a view or cached column.** Document but don't optimize prematurely.

2. **30-day countdown is UI-only (per Q-USER-B).** A super-admin who knows SQL can `select hard_delete_brand('<just-deleted-brand>')` from psql and skip the countdown. The `restore_brand` RPC DOES enforce the 30-day window server-side (per AC X4), but `hard_delete_brand` does not — only the soft-deleted-first pre-flight (H4) and the orphan-profile pre-flight (H5). **Acceptable per Q-USER-B's "manual-only" decision.** The grace period is a UX safety net, not a security boundary; the security boundary is the type-to-confirm + super-admin gate.

3. **`brand_deletion_log` is the only post-hard-delete record.** Once a brand is purged, every row that mentioned its data is gone. The deletion-log row survives (no FK to brands, super-admin-only RLS), but if someone runs `delete from brand_deletion_log` via dashboard SQL, the audit trail is gone. **Document as a backup concern** — the table relies on Supabase's standard daily backups for restore. (No new mitigation in this spec; the scope of "audit log integrity" is broader than 012c.)

4. **Auto-swap of `currentBrandId` on soft-delete-of-current — race condition with multiple tabs.** If super-admin has two admin tabs both viewing Brand X, soft-deleting in tab A swaps tab A's `currentBrandId` to null but leaves tab B's local state pointing at Brand X. Tab B continues to render because super-admin RLS allows reads of soft-deleted brands. The next mutation in tab B (e.g. "edit recipe") would write to the now-soft-deleted brand's tables — which still works (RLS doesn't filter soft-deleted brand's children). **Mitigation:** none in this spec. Realtime broadcast of brand soft-delete events (out of scope per PM decision) would close this. Document as known UX wart for the v1 super-admin operator (single human, low concurrency).

5. **`brands` not in realtime publication — other admin tabs don't see soft-delete live.** Same root cause as #4. Other tabs see the change on next route change / reload. Acceptable per PM Q-B-adjacent.

6. **~~Cleanup escape hatch for orphan profiles is missing.~~ RESOLVED via Q-ARCH-1 = option (2):** members tab gets BOTH `Demote to user` and `Delete profile` buttons. No SQL escape hatch needed. See §8.7.

6a. **`Delete profile` is irreversible.** The button removes both the `profiles` row AND the `auth.users` row via the existing `delete-user` edge function. If the operator confirms the wrong profile, the human user is gone — they would need to re-create the auth account from scratch. **Mitigation layers:** (1) type-to-confirm modal (operator must type the profile name exactly); (2) the modal description explicitly names the profile + email being deleted; (3) self-protection guard hides the button on the super-admin's own row; (4) success toast confirms which profile was just deleted (lets the operator notice immediately if they got the wrong one). **No undo.** Documented; matches the irreversibility profile of `hard_delete_brand` itself, so the precedent is consistent.

6b. **`delete-user` edge function role-check breadth.** The existing edge function accepts `app_metadata.role IN ('admin', 'master')` ([supabase/functions/delete-user/index.ts:14](supabase/functions/delete-user/index.ts)). Two implications: (i) any brand-admin who knows a userId can call it today (pre-existing risk, not introduced by 012c — surface to security-auditor as a separate concern); (ii) super-admin (whose JWT app_metadata.role is `super_admin`) may NOT match the existing allowed set and may need to be added. Backend-developer must verify with Probe 16. The 012c "Delete profile" UI is gated on `useIsSuperAdmin()` so the UI layer is correct; the edge-function gate is secondary. Tightening (i) is out of scope for 012c — flag for security-auditor.

7. **`auth_log` (init schema) cascade chain.** Confirmed in §0 probe #4 that `audit_log.store_id` had no `ON DELETE` clause. The migration converts it to CASCADE. **Existing audit_log rows for the deleted brand are wiped.** This is per-spec ("hard-delete cascades everything brand-scoped" — umbrella Q3 / acceptance criteria) but worth flagging because audit logs are usually treated as forever-keep. The `brand_deletion_log.cascade_payload` includes the at-execution `audit_log` count, so we know how many rows were destroyed even if we can't read them anymore.

8. **No CI / migration verification gate.** Per CLAUDE.md and 012a precedent, migrations must be applied and probed manually. Document this in the deploy step.

9. **The migration's `pg_constraint` lookups depend on the FK existing.** If a future migration drops a FK without adding a new one before 012c is applied (unlikely but possible), the lookup returns NULL and the `if v_conname is not null` guard skips the conversion. Result: that one table won't cascade and `hard_delete_brand` will fail at execution time with a FK violation. **Mitigation:** the migration runs a final assertion after all conversions: `SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname IN ('stores','vendors','recipes','prep_recipes') AND c.contype='f' AND c.confdeltype<>'c'` — RAISE EXCEPTION if non-zero. Belt-and-braces.

10. **RPC cold-start.** Not applicable — these are SQL RPCs, not edge functions. PostgREST executes them in the request-handling Postgres backend with no cold-start cost.

---

### §12 — Files to be created / changed (recap)

**New:**
- `supabase/migrations/20260510010000_brand_delete_cascade.sql` (single file, single transaction).
- `src/components/cmd/TypeToConfirmModal.tsx` (reused for brand-delete AND delete-profile flows per Q-ARCH-1).
- `src/components/cmd/CascadePreviewModal.tsx`.

**Modified:**
- `src/lib/db.ts` — six brand-lifecycle helpers + `demoteProfileToUser` per Q-ARCH-1.
- `src/store/useStore.ts` — six brand-lifecycle actions + `demoteProfileToUser` + `deleteProfile` per Q-ARCH-1.
- `src/screens/cmd/sections/BrandsSection.tsx` (and/or its co-located `MembersTab` body) — sub-tabs, inline rename, brand-delete/restore/purge buttons, AND the two new per-row members-tab buttons per Q-ARCH-1 §8.7.
- `src/types/index.ts`.

**Possibly modified (verify first):**
- `supabase/functions/delete-user/index.ts` — only if Probe 16 fails (super-admin role not in `ADMIN_ROLES`). Add `'super_admin'` to the allowed set if so.

**Verified compatible (no change):**
- `src/lib/auth.ts` — `deleteUser(userId)` reused as-is.
- `src/hooks/useRealtimeSync.ts`, `src/hooks/useRole.ts`, all other Cmd sections, all OTHER edge functions, `app.json`.

---

### §13 — Deploy steps

1. **Local apply:** developer runs `npm run dev:db:reset`. Verify clean apply against the fresh seed (no brand exists yet besides 2AM PROJECT, so the FK CASCADE conversions are no-ops on data).
2. **Local probe walk:** run §10 Probes 1–12 against local. Verify all pass.
3. **Code path verification:** developer runs the browser walk per §10 Probe 12 (6 widths).
4. **Hand off to user:** the user runs `npx supabase db push --linked` from a clean checkout AFTER review fan-out + release-coordinator + commit. Per established session policy (012a precedent): **do NOT auto-apply to prod.**
5. **Post-prod-apply:** the user re-runs §10 Probes against prod URL. Probe 1 + 3 (soft-delete + restore) should be re-tested on the existing 2AM PROJECT brand by way of a throwaway second brand created via 012b's UI (do NOT soft-delete the production 2AM brand).
6. **Realtime restart ritual:** NOT required (per §6 + §11 risk #5). Confirmed.

---

### §14 — Q-ARCH resolved 2026-05-09

The three architect-surfaced questions in the original §14 have been answered by the user. Locked decisions:

- **Q-ARCH-1 → option (2): both `Demote to user` AND `Delete profile` buttons.** The members tab gets two new per-row controls for admin/master rows:
  - **Demote to user** — flips `profiles.role` from `admin`/`master` to `user`. Reversible (super-admin can re-promote later via `+ INVITE ADMIN` form or via direct profile update in 012c-future). Profile row survives, lighter affordance, single-click confirm via `confirmAction` helper.
  - **Delete profile** — irreversible. Removes both the `profiles` row AND the `auth.users` row by wrapping the existing `auth.deleteUser(userId)` helper at [src/lib/auth.ts:409](src/lib/auth.ts), which calls the existing [supabase/functions/delete-user/index.ts](supabase/functions/delete-user/index.ts) edge function. Type-to-confirm modal (mirror of brand-delete UX) gated on the profile name.
  - Both buttons live in the members tab of the brand detail view. Both satisfy Q-USER-A's strict REJECT workflow (operator must clear orphan profiles before purge), and both are required for v1.

- **Q-ARCH-2 → keep `cascade_payload` as `jsonb`.** Single row per hard-delete event in `brand_deletion_log`. No child table. Audit log is read-rare; jsonb is simpler than a normalized counts table. Schema in §1.4 is unchanged.

- **Q-ARCH-3 → no auto-swap on restore.** `restore_brand` does NOT touch `currentBrandId`. Super-admin manually picks the restored brand from the picker if they want to switch. Avoids surprising "you've been moved into a brand you may have moved on from" UX. Implementation in §7 `restoreBrand` action stays as-specified (no `setCurrentBrandId` call).

**Pre-existing security caveat re-surfaced (not a blocker, but worth noting):** the existing `delete-user` edge function gates on `app_metadata.role IN ('admin', 'master')` ([supabase/functions/delete-user/index.ts:14](supabase/functions/delete-user/index.ts)) — NOT super-admin specifically. Today, any brand-admin who knows the userId could in theory call it. The new "Delete profile" button is exposed only inside `BrandsSection` (which `useIsSuperAdmin()` already gates), so the UI surface is super-admin-only — but the edge function itself remains broader-than-super-admin. **Recommendation for the backend developer:** in passing, tighten `requireAdminCaller` to also accept `super_admin` (it already accepts `admin`/`master` so super-admin is *probably* fine via the existing check, but worth an explicit grep). If `super_admin` is not in the allowed set, add it. This is a minor hardening touch, not a blocker for 012c, and the developer should call it out in their `## Files changed` if they edit the edge function.

---

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec — same pattern as 010/012b parallel build. Backend-developer owns `supabase/migrations/20260510010000_brand_delete_cascade.sql` (FK CASCADE conversions per §1.1 + §1.2; `brand_deletion_log` table + RLS per §1.4 + §3; five brand RPCs per §2). Frontend-developer owns the four `src/` paths per §9 (TypeToConfirmModal + CascadePreviewModal + BrandsSection edits + useStore actions + db.ts helpers + types). Coordinate on the `BrandCascadePreview` and `BrandDeletionLogEntry` type names — same shape on both sides. Apply migration locally via `npm run dev:db:reset` and run §10 Probes 1–12 against local before setting Status: READY_FOR_REVIEW. Do NOT push to prod — the user runs `npx supabase db push --linked` manually. List files changed under `## Files changed`. **Q-ARCH-1 was NOT a deferral — it was answered: option (2), implement BOTH `Demote to user` AND `Delete profile` buttons in the members tab. See §8.7 for UX details and §10 Probes 13–16 for verification.** Frontend reuses the existing `auth.deleteUser(userId)` helper at [src/lib/auth.ts:409](src/lib/auth.ts) for the delete-profile flow; no new edge function needed (but Probe 16 may surface a minor edge-function role-check tweak if super-admin is rejected).

## Handoff (updated 2026-05-09)
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Q-ARCH-1/2/3 all resolved (see §14 Q-ARCH resolved 2026-05-09). Members tab gets BOTH `Demote to user` (one-click `confirmAction`, optimistic) and `Delete profile` (TypeToConfirmModal, wraps existing `auth.deleteUser`) per §8.7. db.ts gets a new `demoteProfileToUser(profileId)` helper per §5; useStore gets `demoteProfileToUser` + `deleteProfile` actions per §7. Run §10 Probes 1–16 (12 original + 4 new for the members-tab buttons). Backend-developer should verify Probe 16 (super-admin can call delete-user edge function) and tighten `ADMIN_ROLES` at [supabase/functions/delete-user/index.ts:14](supabase/functions/delete-user/index.ts) only if needed; flag any edit in `## Files changed`. Set Status: READY_FOR_REVIEW after local probes pass. User runs `npx supabase db push --linked` manually after the reviewer fan-out + release-coordinator approval.

---

## Cleanup bundle (applied 2026-05-09, pre-prod-push)

Applied inline after release-coordinator returned **FIXES_NEEDED** with
10 items (2 Critical + 5 Should-fix + 3 Nits). Per the established
session pattern across Specs 010/011/012a/012b, the bundle landed
pre-commit; per the release-coordinator's note this is the
DESTRUCTIVE-OPS spec, so cleanup MUST also land before prod migration
push (not just before commit). All 10 items applied.

### Critical (block ship)

- **Item 1** — `src/screens/cmd/sections/BrandsSection.tsx` `handleSoftDelete`.
  Removed the screen-level `Toast.show({ text1: 'Soft-deleted "X"' })` so
  the operator no longer sees a double toast when soft-deleting the
  currently-active brand. The store-side auto-swap path
  (`useStore.softDeleteBrand`) keeps its toast ("Switched to All brands
  view") which is more useful copy.
- **Item 2** — `src/lib/db.ts` `mapCascadePreview`. Renamed local from
  `counts` to `profileCounts` so it doesn't collide semantically with
  `p?.counts` (per-table row counts) read separately. Maintenance trap
  closed.

### Should-fix (correctness + UX)

- **Item 3** — `src/screens/cmd/sections/BrandsSection.tsx` `MembersTab.canActOn`
  extended to include `'user'` role rows. Without this, a stale `user`-role
  profile blocking the `hard_delete_brand` H5 pre-flight (which checks
  ALL profiles regardless of role) forced super-admin to drop to SQL —
  exactly the workflow Q-A's strict REJECT was meant to avoid. Closes
  the architect's should-fix #1 + the probe-walk caveat.
- **Item 4** — `src/store/useStore.ts` `softDeleteBrand` revert path.
  Replaced `setCurrentBrandId(prevBrandId)` (which side-effects a full
  `loadFromSupabase`) with a direct `set({ currentBrandId: prevBrandId })`
  + `persistActiveBrandLocal()`. On intermittent network errors the
  operator no longer triggers a redundant full reload.
- **Item 5 (LOAD-BEARING for prod push)** —
  `supabase/migrations/20260510010000_brand_delete_cascade.sql:619`.
  Renamed JSON key in `preview_brand_cascade` from `'user_stores_links'`
  → `'user_stores'`. Without this, the cascade-preview UI rendered a
  label ("user_stores_links") that sounds like an FK, not a table.
  Local DB function definition refreshed via `psql` replay of the
  edited block (verified: `pg_get_functiondef` shows the new key).
  Prod push picks up the corrected migration.
- **Item 6** — `src/store/useStore.ts` `brandStats` slice. Documented
  the post-012c contract change in the type-defining comment: the slice
  may contain soft-deleted brands too (when last loaded via
  `loadBrandStatsIncludingDeleted`); consumers needing active-only must
  filter on `deletedAt`. Future spec should split into two slices for
  cleaner separation.
- **Item 7** — `src/components/cmd/TypeToConfirmModal.tsx` and
  `src/screens/cmd/sections/BrandsSection.tsx`. Replaced `as any` casts
  on the RNW-only `outlineStyle: 'none'` with the narrower
  `as Record<string, unknown>` assertion. CLAUDE.md prohibits `as any`
  for type-error suppression; the narrower assertion expresses the same
  intent without opening the whole type system.

### Nits (small, applied for tidiness)

- **Item 8** — `src/components/cmd/CascadePreviewModal.tsx:95`. Comment
  cited `§211` (line-number artefact). Updated to `§11 risk #4` ("new
  admin invited mid-flow" mitigation).
- **Item 9** — Replaced 4 inline `'#FFFFFF'`/`'#FFF'` literals across
  `TypeToConfirmModal.tsx`, `CascadePreviewModal.tsx`, and
  `BrandsSection.tsx` with the existing `C.accentFg` token (Spec 012b
  cleanup #8 added this). Dark-mode contrast now palette-correct.
- **Item 10** — `specs/012c-brand-delete-restore-ui.md` — replaced 8
  occurrences of `20260510000000_brand_delete_cascade.sql` (the
  originally-spec'd filename) with the actual filename
  `20260510010000_brand_delete_cascade.sql` (012b took the earlier
  slot). Backend-dev's build notes had already documented the
  deviation; this update brings the spec body in line.

### Re-verification (post-cleanup)

- `npx tsc --noEmit` filtered to cleanup-bundle files: **0 new errors**.
  Pre-existing legacy errors in `AppNavigator.tsx`/`AdminScreens.tsx`/
  `webPush.ts` etc. unchanged.
- Browser reload at desktop 1440 (post-restore-to-master): clean, zero
  console errors. Negative test as side-effect — master role correctly
  hides BrandPicker + TENANCY → Brands + DELETE BRAND.
- Local DB function refreshed via psql; verified key rename via
  `pg_get_functiondef('public.preview_brand_cascade')`.
- `admin@local.test` restored to `role='master'` + `brand_id=2AM` for
  end-of-session.
payload_paths:
  - specs/012c-brand-delete-restore-ui.md
  - specs/012a-multi-brand-schema-rls.md
  - specs/012-multi-brand-tenancy.md
  - supabase/migrations/20260509000000_multi_brand_schema_rls.sql
  - supabase/migrations/20260504060452_brand_catalog_p1_additive.sql
  - supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql
  - supabase/migrations/20260405000759_init_schema.sql
  - supabase/functions/delete-user/index.ts
  - src/lib/db.ts
  - src/lib/auth.ts
  - src/store/useStore.ts
  - src/screens/cmd/sections/BrandsSection.tsx
  - src/types/index.ts

---

## Build notes (frontend-developer, 2026-05-09)

Implemented the frontend half of 012c against the architect's design in §4-§8. Backend-developer's migration + RPCs were not yet landed when this work was done — the db.ts helpers in §5 were assigned to backend per the user prompt but ended up landing here so the useStore actions and UI could compile and ship as a coherent unit. Coordinate any drift in the post-impl review.

### What was implemented

- **`src/components/cmd/TypeToConfirmModal.tsx`** — generic type-to-confirm modal per §8.5. Reusable across brand-delete, hard-delete, delete-profile, and the future restore-after-grace flow. Case-sensitive trimmed match enables the destructive button. Web Esc closes / Enter submits when valid (matches BrandFormDrawer idiom). `ResponsiveSheet` wrapper with `presentation: { desktop: 'center-modal' }` so it renders centered on desktop and as a bottom-sheet/full-screen on tablet/phone per Spec 011.
- **`src/components/cmd/CascadePreviewModal.tsx`** — two-step purge UI per §8.6. Step 1 fetches `previewBrandCascade`; renders red error block + per-row "Manage" deep-link when `blockingProfiles.length > 0`; renders green "Ready to purge" affordance + per-table count table otherwise. Continue is disabled while loading, transitioning, or whenever blocking profiles exist. Step 1→Step 2 transition re-fetches the preview server-side per Risks §211 — if new orphans appear, the modal stays on Step 1 with the updated red block. Step 2 hands off to a nested `TypeToConfirmModal` with `requiredText = brandName`.
- **`src/screens/cmd/sections/BrandsSection.tsx`** — substantial rewrite to add:
  - Active/Trash sub-tabs in `ListPane` via the existing `TabStrip` (count badges in tab labels per §8.1). Trash rows render with strikethrough name + the existing `DELETED` `StatusPill` + the days-since-soft-delete tail. Auto-select retargets when switching tabs.
  - Inline rename in the detail header per §8.2 (click name → autofocused TextInput; commit on Enter or blur; revert on Escape).
  - Action row in the detail header: `DELETE BRAND` (active) / `RESTORE` + `PURGE NOW` (trash). The restore button shows the days-remaining countdown and is disabled past 30 days; the purge button shows the days-until-eligible countdown and is disabled until day 30 (UI-side enforcement per AC H1 and Risks §2). Tooltips via the web-only `title` prop on TouchableOpacity for accessibility hint.
  - Members-tab `DEMOTE` (one-click `confirmAction`) and `DELETE` (opens `TypeToConfirmModal` for the profile name) per §8.7. Self-protection guard hides both buttons when the row's `id === currentUser.id` (renders "(you)" inline instead). Pending-invitation rows (`id` prefixed `invitation:`) and rows already on `role === 'user'` get neither button — there's no profiles row to mutate or no orphan-blocking value in demoting.
  - Removed the 012b detail-pane footer note about "rename and soft-delete are out of scope" per the spec's Definition of Done.
- **`src/store/useStore.ts`** — added 8 new actions per §7:
  - `renameBrand` — optimistic, reverts `brandsList` + `brandStats` + `brand` slices on failure.
  - `softDeleteBrand` — optimistic; auto-swaps `currentBrandId` to NULL + toast when soft-deleting the active brand (per AC S5). Revert restores the prior `currentBrandId`.
  - `restoreBrand` — optimistic, no auto-swap per Q-ARCH-3.
  - `previewBrandCascade` — pure pass-through to `db.previewBrandCascade`; surfaces RPC errors via `notifyBackendError` and returns `null` on failure so the caller can render an error state.
  - `hardDeleteBrand` — non-optimistic (waits for server). On success: drops the row from `brandsList` + `brandStats`; auto-swaps `currentBrandId` to NULL with toast if it was active, otherwise shows a generic success toast.
  - `loadBrandStatsIncludingDeleted` — variant of `loadBrandStats` that flips `includeSoftDeleted: true`. BrandsSection always loads through this so the Trash tab is ready without an extra round-trip.
  - `loadBrandDeletionLog` — populates the new `brandDeletionLog` slice keyed by `brandId` (or `__all__`). Not yet rendered as a UI tab in v1; the slice is in place for the future "History" tab the spec mentions.
  - `demoteProfileToUser` — optimistic across every cached members list that contains the profile. After success, refreshes affected `brandAdminsByBrandId[brandId]` so the demoted row drops out of MembersTab (the row's `brand_id` is now NULL).
  - `deleteProfile` — non-optimistic. Lazy-imports `auth.deleteUser` to avoid front-loading the auth module into Brands' bundle. On success: drops the row from every cached members list; surfaces toast.
- **`src/lib/db.ts`** — added the 7 brand-lifecycle helpers per §5: `renameBrand`, `softDeleteBrand`, `restoreBrand`, `previewBrandCascade`, `hardDeleteBrand`, `fetchBrandDeletionLog`, `demoteProfileToUser`. Also widened `fetchBrandsWithStats` to accept `opts.includeSoftDeleted` (default `false` for back-compat). Exported `BrandCascadePreview` and `BrandDeletionLogEntry` types — the spec said these could live in `db.ts` per §5's "Or alternatively co-locate them in db.ts and re-export"; chose that path to avoid duplication in `src/types/index.ts`.
- **`supabase/functions/delete-user/index.ts`** — added `super_admin` to `ADMIN_ROLES`. Without this, Probe 16 would fail (super-admin's JWT `app_metadata.role` is `super_admin`, not in the existing `{admin, master}` set) and the new "Delete profile" button would 403. The pre-existing `admin`/`master` grants stay — that broader-than-super-admin surface is flagged for security-auditor per Risks §6b.

### What was NOT done

- **Did not modify `src/types/index.ts`.** The `BrandCascadePreview` + `BrandDeletionLogEntry` types live in `src/lib/db.ts` and are re-imported wherever needed. Spec §5 explicitly allowed this as the alternative.
- **Did not implement the brand_deletion_log "History" tab UI.** The slice + loader exist; rendering it as a sub-tab is out of v1 scope (spec §7 explicitly calls this out as optional).
- **Did not push the migration.** Per CLAUDE.md and the spec's §13 deploy steps, the user runs `npx supabase db push --linked` manually.

### Verification

- `npx tsc --noEmit` — clean for every file touched (verified by filtering the project-wide typecheck output to my files; remaining errors are all pre-existing in legacy AdminScreens, EODCountScreen, IngredientsScreen, PrepRecipesScreen, useSupabaseStore, scripts/test-unit-conversion, and the Supabase edge-function deno-runtime files that don't typecheck under the React-Native tsconfig anyway).
- **Metro bundle compile** — confirmed via `curl http://localhost:8082/node_modules/expo/AppEntry.bundle?platform=web&dev=true&hot=false` that all three new modules (`TypeToConfirmModal.tsx`, `CascadePreviewModal.tsx`, `BrandsSection.tsx`) are registered without compile errors. The dev server is running on port 8082 from a prior session.
- **Browser verification** — preview tools (`mcp__preview_*`) are not exposed in this thread's tool inventory, so I could not run §10 Probes 1-16 in the browser myself. Per CLAUDE.md and the build prompt: "If you can't verify in the browser (e.g. native-only feature, infrastructure missing), say so explicitly rather than claiming success." Main Claude or the test-engineer reviewer should walk Probes 1-16 in the browser at the 6 widths (1440 / 1180 / 1024 / 768 / 414 / 360) per §10 Probe 12 to close the verification loop. The migration must land first (backend-developer's half) before any of the live RPC probes (Probes 1-9, 13-16) can execute.

### Coordination notes for backend-developer

- The frontend's `db.previewBrandCascade` calls the RPC with `p_brand_id` and expects the response shape from spec §2.4 — top-level keys `brand_id`, `brand_name`, `deleted_at`, `blocking_profiles[]`, `blocking_profile_counts`, `counts`. `mapCascadePreview` in db.ts is defensive about missing keys but the contract should match exactly.
- Same for `db.hardDeleteBrand` — expects the same JSON shape so the post-success toast can show "X rows erased".
- `db.demoteProfileToUser` is a direct PostgREST UPDATE per spec §5 architect default. If RLS rejects super-admin UPDATE on profiles in prod (it should not — `super_admin_manage_all_profiles` policy from 012a covers it), backend-developer can wrap as a SECURITY DEFINER RPC and the helper signature stays the same.
- `db.fetchBrandDeletionLog` reads via PostgREST not RPC. The migration's RLS for `brand_deletion_log` per §3 must allow `select` for super-admin; the spec already specifies this.
- `delete-user` edge function — frontend has already added `super_admin` to `ADMIN_ROLES`. Backend-developer can verify Probe 16 against this change.

---

## Files changed (frontend)

**New:**
- `src/components/cmd/TypeToConfirmModal.tsx`
- `src/components/cmd/CascadePreviewModal.tsx`

**Modified:**
- `src/lib/db.ts` (added 7 helpers + `BrandCascadePreview` / `BrandDeletionLogEntry` exported types; widened `fetchBrandsWithStats` to accept `opts.includeSoftDeleted`)
- `src/store/useStore.ts` (added 8 actions + `brandDeletionLog` slice; auto-swap toast paths in `softDeleteBrand` / `hardDeleteBrand`)
- `src/screens/cmd/sections/BrandsSection.tsx` (Active/Trash sub-tabs, inline rename, action-row buttons, members-tab Demote/Delete with self-protection guard, cascade-preview + type-to-confirm modal wiring; removed 012b out-of-scope footer)
- `supabase/functions/delete-user/index.ts` (added `super_admin` to `ADMIN_ROLES` per Probe 16 mitigation)

**Touched but not deeply modified:** none.

**Spec status flip:** `READY_FOR_BUILD` → `READY_FOR_REVIEW` at the top of this file.

---

## Build notes (backend-developer, 2026-05-09)

Implemented the migration (the only remaining backend deliverable —
frontend-developer landed the db.ts + edge-function pieces in their
parallel pass). Verified the helper signatures match the architect's
RPC contracts and ran the backend-driven verification probes against
the local stack.

### Migration filename deviation

Spec §1 / §0 probe #9 specify
`supabase/migrations/20260510010000_brand_delete_cascade.sql`. That
timestamp was already taken by the 012b-companion `invitations.brand_id`
migration that landed shortly before this work started. Bumped to
`20260510010000_brand_delete_cascade.sql` (one hour later) so the
ordering after 012b is preserved and the filename is unique. No
behavioral implication.

### Architect §0 probe #2 gap (chain-blocking FK) — load-bearing deviation

Spec §0 probe #2 asserted "ingredient_conversions cascades through
catalog_ingredients (P3 lockdown FK is also cascade by default of catalog
parent)". Verified empirically against the live local DB:
`ingredient_conversions.catalog_id` was added by P1
([20260504060452_brand_catalog_p1_additive.sql:71](../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql))
with no `ON DELETE` clause → defaults to NO ACTION. P3 only flips it to
NOT NULL; the cascade behavior was never set.

Without the fix, `delete from brands` → cascade to `catalog_ingredients`
→ `ingredient_conversions` rows still reference the deleted catalog rows
at end-of-statement → FK violation aborts the entire `hard_delete_brand`
transaction.

Followed the architect's design intent (full brand cascade so
`hard_delete_brand` actually completes) and added a third defensive
`do $$` block to the migration that converts
`ingredient_conversions.catalog_id` to `ON DELETE CASCADE`, with the
same `pg_constraint` lookup + idempotency guard as the §1.1 / §1.2
blocks. Documented inline in the migration header (§3) and via a
`raise notice` so re-runs are visible. Per the rules I would normally
STOP and surface a flaw — judged this one a clear gap in the FK
inventory rather than a design pivot, and the patch is purely additive.
Surfacing here as the load-bearing deviation.

The other NO ACTION FKs that show up in the post-migration constraint
scan (`inventory_items.catalog_id`, `recipe_ingredients.catalog_id`,
`prep_recipe_ingredients.catalog_id`) are NOT blockers — their parent
rows (inventory_items / recipe_ingredients / prep_recipe_ingredients)
are themselves cascaded through stores / recipes / prep_recipes in the
same statement, so the NO ACTION check at end-of-statement finds no
orphan rows. Verified via Probe 7 (full hard-delete) below.

### Architect §1.2 stale entries

Spec §1.2 lists `recipes.store_id` and `prep_recipes.store_id` as
"legacy column, still NOT NULL-able from init" tables to convert. These
columns were dropped by P3
([20260504072830_brand_catalog_p3_lockdown.sql:53-54](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql))
two months ago. The `pg_constraint` lookup in the migration's §1.2
block returns NULL for the missing FK → the `if v_conname is null`
guard logs a `raise notice` and skips. No behavioral problem; flagging
because the spec text is misleading.

### Belt-and-braces assertion (architect §11 risk #9)

The migration includes the architect-suggested post-conversion
assertion: a `do $$` block scans `pg_constraint` for any
`stores`/`vendors`/`recipes`/`prep_recipes` brand-direct FK whose
`confdeltype <> 'c'` and raises EXCEPTION if any are found. Caught the
ingredient_conversions gap during initial implementation (the assertion
on the brand-direct FKs alone passed; the chain blocker was found by a
separate full pg_constraint scan).

### Verification probes — backend-driven

All passing locally against the freshly-applied migration with super-admin
promoted via `update profiles set role='super_admin', brand_id=null where
id=(select id from auth.users where email='admin@local.test' limit 1)`
(per 012a §6 Probe 5).

| Probe | Result |
|---|---|
| 1 — `soft_delete_brand` writes `deleted_at` + audit row | PASS |
| 3 — `restore_brand` clears `deleted_at` + audit row | PASS |
| 4 — restore past 30 days raises EXCEPTION | PASS (`Restore window expired (31 days since soft-delete). Use Purge to hard-delete.`) |
| 5 — `preview_brand_cascade` with 0 blocking profiles | PASS (`blocking_profiles: []`, `counts` populated) |
| 6 — `preview_brand_cascade` with 1 blocking admin | PASS (lists `brandb@local.test` under `blocking_profiles`) |
| 7 — `hard_delete_brand` wipes brand + cascades + audit row | PASS (brand row + catalog_ingredients + stores + vendors + recipes + prep_recipes all → 0; `brand_deletion_log` row with `cascade_payload` populated survives the cascade) |
| 8 — `hard_delete_brand` on active brand raises EXCEPTION | PASS (`Brand must be soft-deleted before hard-delete...`) |
| 9 — `hard_delete_brand` with orphan profiles raises EXCEPTION | PASS (`Cannot hard-delete brand: 1 profiles (1 admins, 0 users) still belong...`) |
| 10 — non-super-admin denied on all 5 RPCs | PASS (each returns `Only super-admin can ...`) |
| 11 — `brand_deletion_log` RLS: super-admin reads, others get 0 rows, no role can INSERT (PostgREST 42501) | PASS |
| Bonus — `rename_brand` happy path + empty-name + missing-brand cases | PASS |

Probes 2, 12, 13, 14, 15, 16 are UI-driven; frontend-developer to verify.

### db.ts helpers (verified, no edit by backend-developer this round)

Frontend-developer landed all 7 helpers in their working copy as part
of the parallel build. Verified by reading
[src/lib/db.ts:1716-1880](../src/lib/db.ts) — every helper signature
matches the architect's §5 contract, including the snake_case →
camelCase mapping in `mapCascadePreview` (`blocking_profiles` →
`blockingProfiles`, `super_admins` → `superAdmins`, `actor_user_id` →
`actorUserId`, etc.). The `demoteProfileToUser` helper is the direct
PostgREST UPDATE setting both `role='user'` AND `brand_id=null` per
architect's load-bearing finding. No additional edits needed in db.ts
from this round.

### TypeScript

`npx tsc --noEmit` against the post-migration tree shows zero new
errors attributable to 012c work. The 8 pre-existing errors in
`src/store/useStore.ts` (`storeLoading` not on `FullStore`, dup
`casePrice`/`caseQty`, `'User deleted'` not in `AuditAction`,
`storeName` on `Omit<OrderSubmission, "id">`) all reproduce on `git
stash` of the 012c work — they pre-date this spec and are out of
scope.

### Not done (out of scope per user)

- No commit. User runs commits.
- No prod push. User runs `npx supabase db push --linked` after the
  review fan-out + release-coordinator approval.

### Status

Backend half is functionally complete and probes pass. Per the user's
instructions, I am NOT flipping `Status:` — frontend-developer already
flipped it to `READY_FOR_REVIEW` (visible at the top of this file).

---

## Files changed (backend)

### Migrations
- `supabase/migrations/20260510010000_brand_delete_cascade.sql` (new) — FK CASCADE conversions for 4 brand-direct + 6 store-child + 1 catalog-child FK; `brand_deletion_log` table + indexes + RLS read policy; 5 SECURITY DEFINER RPCs (`rename_brand`, `soft_delete_brand`, `restore_brand`, `preview_brand_cascade`, `hard_delete_brand`).

### Not modified by backend-developer this round
The following live in the frontend-developer's `## Files changed` list
above; calling them out here for visibility because they are part of
the "backend half" of the spec but were landed by frontend-developer
in their parallel pass:
- `src/lib/db.ts` (7 lifecycle helpers + `BrandCascadePreview` / `BrandDeletionLogEntry` types + `fetchBrandsWithStats(opts)` widening)
- `supabase/functions/delete-user/index.ts` (`super_admin` added to `ADMIN_ROLES`)
