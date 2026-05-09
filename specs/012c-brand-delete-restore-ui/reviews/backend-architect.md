# Backend architect post-impl review — Spec 012c

Scope: drift-check of backend + frontend halves landed in parallel
against the design in `specs/012c-brand-delete-restore-ui.md` §0–§14.
Read every changed file end-to-end. No code edits; this is a review.

## Critical drift

(none)

The implementation matches the design's load-bearing intent in every
respect that affects correctness, safety, or the contract surface:

- All 5 RPCs land with the exact signatures, SECURITY DEFINER,
  `set search_path = public, auth`, super-admin gate, error-message
  formats, idempotent guards, and audit-row writes called for in §2.
- The H4 (must-be-soft-deleted-first) and H5 (no-orphan-profiles)
  pre-flights inside `hard_delete_brand` are present and strict, with
  the message format the spec mandates so the UI can pattern-match if
  it ever wants to (the UI prefers re-calling `preview_brand_cascade`,
  which is the more robust path the architect already preferred).
- The cascade payload is snapshotted via `preview_brand_cascade` BEFORE
  the delete fires and inserted into `brand_deletion_log` inside the
  same tx — exactly the audit-then-delete ordering §2.5 specified.
- `restore_brand` enforces the 30-day grace window server-side (AC X4)
  even though the UI also disables the button — defense in depth as
  designed.
- `brand_deletion_log` has no FK to `brands` (survives cascade) and
  RLS read-only-to-super-admin with no INSERT/UPDATE/DELETE policies
  per §3 — SECURITY DEFINER RPCs bypass RLS for writes as intended.
- All 7 db.ts helpers match §5 signatures including the load-bearing
  `demoteProfileToUser` writing both `role='user'` AND `brand_id=null`
  in one UPDATE (so `profiles_role_brand_consistent` CHECK passes AND
  the H5 pre-flight stops counting the row).
- All 8 useStore actions match §7. Auto-swap-to-null on
  soft-delete-of-currentBrand fires with toast (S5). Restore does NOT
  auto-swap (Q-ARCH-3). Hard-delete is non-optimistic and waits for
  server confirmation. Demote is optimistic across cached members
  lists; Delete-profile is non-optimistic.
- Members tab has BOTH Demote AND Delete buttons (Q-ARCH-1 option 2),
  with self-protection guards (`isSelf` hides both).
- Cascade preview modal is two-step; Step 1→2 transition re-fetches
  `previewBrandCascade` server-side per Risks §211.
- `delete-user` edge function got `super_admin` added to `ADMIN_ROLES`
  (Probe 16 mitigation). The pre-existing `admin`/`master` grants stay
  — flagged as security-auditor concern, not introduced by 012c.

## Acceptable deviations

These are the three deviations backend-developer flagged in their build
notes, plus a fourth I noticed during review. All are improvements or
benign corrections that preserve the design intent.

1. **Migration filename `20260510010000_*` instead of
   `20260510000000_*`.** Spec §0 probe #9 picked the earlier slot. That
   slot was taken by Spec 012b's `invitations.brand_id` migration that
   landed shortly before. Bumping by one hour preserves chronological
   ordering after 012b. Cosmetic; no behavior change. ACCEPT.

2. **Third FK CASCADE conversion block for
   `ingredient_conversions.catalog_id`** — load-bearing fix to a wrong
   assertion in §0 probe #2. The probe asserted the FK already
   cascaded; backend-dev verified empirically against the live DB that
   it was NO ACTION (added by P1 with no ON DELETE clause; never
   touched by P3). Without the conversion, `delete from brands` →
   cascade to `catalog_ingredients` → end-of-statement FK check trips
   on `ingredient_conversions` rows referencing the about-to-be-deleted
   catalog rows → entire `hard_delete_brand` aborts.

   The defensive add is the right call. The patch is purely additive
   (idempotent `pg_constraint` lookup with the same `confdeltype <> 'c'`
   guard as the §1.1 / §1.2 blocks; logs a `raise notice` on no-op).

   **Lesson absorbed for the design narrative:** §0 probe #2's
   assertion was wrong on the merits. The corrected statement is:
   "`catalog_ingredients.brand_id` cascades from brand (P1), but
   `ingredient_conversions.catalog_id` was added by P1 with no ON
   DELETE and was never converted in P3 — it was NO ACTION until 012c.
   The end-of-statement FK check would have aborted the whole brand
   cascade. The 012c migration converts it explicitly." Future
   architects on brand-cascade work should run a full pg_constraint
   `confdeltype <> 'c'` scan against every transitive FK, not just
   the direct-parent FKs. ACCEPT and absorbed.

3. **§1.2 stale entries (`recipes.store_id` /
   `prep_recipes.store_id`)** — these columns were dropped by P3 in
   May 2026 and the spec text didn't reflect that. Backend-dev's
   defensive `if v_conname is null` guard handles the no-op gracefully
   (logs a `raise notice` and skips). No behavioral problem; spec text
   was misleading. ACCEPT — also a lesson on the value of the defensive
   pg_constraint lookup pattern over hardcoded constraint names.

4. **(Newly noticed during review)** Frontend's
   `softDeleteBrand` revert path triggers two toasts when the RPC
   fails: the optimistic "Brand X was deleted — switched to All
   brands" toast fires before the await, then the revert restores
   `currentBrandId` and `notifyBackendError` shows "Soft-delete brand
   failed: ...". The user sees both. This matches the spec's §7
   description verbatim ("optimistic, revert all mutations on backend
   error") — the spec didn't anticipate the toast-pair UX wart. Not
   worth fixing in 012c (RPC failure on soft-delete is rare; the
   second toast clearly explains the failure). ACCEPT — document as a
   minor known UX wart.

## Should-fix

1. **MembersTab `canActOn` excludes `user`-role profiles.**
   `BrandsSection.tsx:865` — `const canActOn = !isSelf && !isPending
   && (u.role === 'admin' || u.role === 'master');`. This means a
   `user`-role profile attached to a brand renders in the members tab
   with NO action buttons. But:

   - `fetchBrandAdmins` returns ALL profiles with `brand_id = brandId`
     (line 1899 `.select('*')` no role filter), so a `user`-role row
     attached to a brand WILL appear.
   - `preview_brand_cascade` counts `user`-role profiles toward
     `blocking_profile_counts.users` (line 530-532) and includes them
     in `blocking_profiles` (line 519 — no role filter).
   - `hard_delete_brand` H5 pre-flight blocks on user-role profiles
     too (line 681 — `(v_admins + v_users) > 0`).
   - The CascadePreviewModal's `Manage` button deep-links to the
     members tab — but if the blocking profile is `user`-role, the
     operator arrives there and finds no button to remove it.

   This is a UI dead-end for the (rare) edge case where a stale
   `user`-role profile blocks purge. The spec's §8.7 said the buttons
   go on "admin/master rows" — which was fine in isolation but
   inconsistent with H5's role-agnostic pre-flight.

   Fix: extend `canActOn` to include `'user'` so user-role rows also
   get the Delete button. Demote-on-already-user is a no-op
   (`role='user', brand_id=null` would just clear `brand_id`) so it
   could optionally be hidden for that case, but the simpler patch is
   to make both buttons available for `user`-role rows too.

   Severity: should-fix because the edge case is rare in practice
   (most user-role rows have `brand_id = null` already since 012a
   defaulted them that way), but the dead-end means the operator is
   forced back to SQL to clear the stale row — the exact workflow the
   spec set out to avoid.

2. **`MembersTab.handleDemote` uses `confirmAction` whose native
   destructive button label is hardcoded to "Delete".** This is fine
   on web (it's a `window.confirm` with no button labels) but on
   native the `Alert.alert` config in
   `src/utils/confirmAction.ts:14-17` always labels the destructive
   button "Delete" — even when the actual action is "Demote".

   The user sees the title "Demote to user?" with a "Delete" button,
   which is misleading for a non-destructive (reversible) action.
   Spec §8.7 said the demote uses `confirmAction` (single-click
   confirm) without prescribing the button label.

   Fix is small but lives outside 012c: either add a label override
   to `confirmAction`, or use a custom inline confirm for demote.
   Surfacing as should-fix because the misleading label undermines the
   "demote is reversible, lighter affordance" intent of Q-ARCH-1.
   Severity: minor/should-fix.

3. **Self-protection rendering is `(you)` text rather than truly
   hidden controls.** Spec §8.7 said "both buttons are hidden". Impl
   shows `(you)` inline (BrandsSection.tsx:953-957). Functionally
   equivalent — the user cannot click anything destructive on
   themselves, and the inline label is arguably better UX than a
   silent gap. ACCEPT — but worth explicitly noting since the spec
   text said "hidden" and a future test-engineer might flag it as a
   verbatim mismatch.

## Notes

- **Probes 1-11 PASSed** per backend-dev's build notes (verified
  manually against the local stack with super-admin promoted). Probes
  2, 12-16 are UI-driven and depend on the migration being applied —
  user / test-engineer to walk those at the 6 widths after migration
  push.

- **`brand_deletion_log` indexes** match design: `brand_id_idx` and
  `created_at_idx (desc)`. Both present at lines 324-327 of the
  migration.

- **Belt-and-braces final assertion** (architect §11 risk #9) is
  present at migration lines 289-306 and only scans the four
  brand-direct FKs. This was sufficient for the §1.1 set but did NOT
  catch the `ingredient_conversions.catalog_id` chain blocker —
  backend-dev caught that with a separate full pg_constraint scan
  during testing. Suggestion for the next architect: tighten the
  assertion's scope to ALL FKs reachable via the brand cascade chain,
  not just the direct ones.

- **`invitations.brand_id` is `ON DELETE CASCADE`** per Spec 012b's
  `20260510000000_invitations_brand_id.sql:20-21` — pending
  invitations for a soft-deleted-then-purged brand correctly disappear
  with the brand. Architect's design didn't enumerate this in the
  cascade tree but the behavior is correct. No drift, just worth
  noting for completeness.

- **`fetchBrandsWithStats` opts widening** is back-compat per design
  §5: existing callers pass nothing → `false` default → `.is('deleted_at',
  null)` filter applied. Verified at db.ts lines 1633-1674. The fallback
  query path (when the `!inner` join drops zero-admin brands) also
  respects the same flag — good.

- **Type co-location.** Frontend chose to keep
  `BrandCascadePreview` / `BrandDeletionLogEntry` in `db.ts` rather
  than `src/types/index.ts`. Spec §5 explicitly allowed this as the
  alternative. ACCEPT.

- **`DeleteProfileModal` wrapper** (BrandsSection.tsx:967-990) is a
  thin component around `TypeToConfirmModal`. Not in the spec but a
  sensible local refactor. ACCEPT.

- **`brandDeletionLog` slice in store** is wired up but unused by any
  UI in v1 (no History tab rendered yet). Frontend-dev called this
  out as "in place for the future History tab". Slice is in the
  StoreActions interface, not the AppState type — consistent with how
  012b's `brandStats` and `brandAdminsByBrandId` slices are also
  declared on StoreActions, not AppState. ACCEPT (existing pattern).

## Verdict

**Acceptable drift only.** Implementation matches the design's
load-bearing intent. The three backend-dev-flagged deviations
(filename bump, ingredient_conversions chain blocker, P3 stale-column
no-ops) are all improvements or benign — the second one is a
load-bearing correction to a wrong probe assertion in the design and
should be absorbed into the design narrative for future reference.

The two should-fix items (user-role row dead-end in MembersTab,
mislabeled native-confirm button in demote) are both minor edge-case
UX issues that do not block ship. Recommend the user / test-engineer
walk Probes 2, 12-16 in the browser after migration push to close the
verification loop, then ship.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 critical, 4 acceptable
  deviations (3 backend-dev-flagged + 1 noticed during review), 3
  should-fix items. Verdict: acceptable drift only. Implementation
  matches the load-bearing design intent.
payload_paths:
  - specs/012c-brand-delete-restore-ui/reviews/backend-architect.md
