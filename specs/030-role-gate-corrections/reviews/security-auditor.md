# Security audit for spec 030 — Role-gate UX corrections trio

Scope: 4 frontend files. No backend, no migrations, no edge function, no
RLS, no new auth surfaces, no dependency changes. All checks below
focused on the spec-specific concerns (focus areas 1–5 in the brief).

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `src/screens/cmd/sections/UsersSection.tsx:227-234` and
  `src/screens/cmd/sections/UsersSection.tsx:102-124` (`handleConfirmDelete`)
  — pre-existing defensive dead code (self-targeted modal copy and
  `silent: true` self-delete branch) is now unreachable from the UI per
  AC2.2/AC2.4. The spec explicitly keeps this as belt-and-suspenders
  (Out of scope §3). Not a finding — flagging so the release-coordinator
  doesn't read the diff as orphaned-code that should be flagged
  elsewhere. The architect already audited this and accepted the
  posture; the server-side `delete-user` HTTP 400 self-delete gate at
  `supabase/functions/delete-user/index.ts:59-64` is the actual gate.

## Authorization spot-checks (focus area 1)

### TimezoneBar widening — additive only
- `src/components/TimezoneBar.tsx:24-27` widens predicate from
  `admin || master` to `admin || master || super_admin`.
- admin BEFORE: pass. AFTER: pass. (unchanged)
- master BEFORE: pass. AFTER: pass. (unchanged)
- super_admin BEFORE: blocked. AFTER: pass. (newly admitted)
- Every other role: still blocked.
- super_admin is the highest-privilege role in the system
  (`auth_is_privileged()` and the ADMIN_ROLES Set canonically include
  it). Admitting it to a master-OR-admin gate is semantically
  consistent. No security regression.
- Implementation note: this deviates from the architect's design
  (which called for swapping to `useIsMaster()`, which would have
  *removed* plain `admin` access). The user explicitly corrected this
  mid-build per `spec.md:527-546`. The shipped shape (additive
  widening) is the safer change.

### DashboardSection manager-lookup widening — additive only
- `src/screens/cmd/sections/DashboardSection.tsx:730-735` adds the
  third clause `u.role === 'super_admin'`. This is row-data ("which
  user shows up as the store's manager label"), not a viewer-role
  gate. Worst case for getting this wrong is a cosmetic dash; the
  fix simply lets a super_admin appear in the manager slot. Not a
  security boundary.

### UsersSection canDelete — restriction, not relaxation
- `src/screens/cmd/sections/UsersSection.tsx:267-269` changes the
  non-master-admin branch from `isSelf || (...)` to `!isSelf && (...)`.
- Master branch (`!isSelf`) unchanged.
- Non-master-admin BEFORE: could delete self + non-privileged rows.
  AFTER: can delete non-privileged rows only (not self).
- Privileged-row deletes (admin/master/super_admin targets) blocked in
  both branches — unchanged.
- This is a UX restriction. No role gains delete capability.

### cmdSelectors Admin group gating — restriction, not relaxation
- `src/lib/cmdSelectors.ts:1085-1092` wraps the Admin group push in
  `if (isMaster)`. `useIsMaster()` returns true iff
  `role === 'master' || role === 'super_admin'`
  (`src/hooks/useRole.ts:45-48`).
- master BEFORE: visible. AFTER: visible. (unchanged)
- super_admin BEFORE: visible. AFTER: visible. (unchanged)
- non-master admin BEFORE: visible. AFTER: hidden.
- user / null BEFORE: visible (no real concern — this app is
  admin-only and a `user` couldn't sign in to it). AFTER: hidden.
- Memo deps array correctly extended to `[isSuperAdmin, isMaster]`
  (`cmdSelectors.ts:1102`) so the gate reactively updates if role
  changes mid-session.
- AC3.4 — spec 008's `applySidebarOverride()` silently drops a
  `Users` id from a user's persisted custom group when the default
  tree no longer includes it. Behavior matches the existing
  `Brands` precedent for non-super-admin.

## Defense-in-depth (focus area 2)

- The DELETE button hide on the self-row is purely UX. The actual
  security gate is `supabase/functions/delete-user/index.ts:59-64`,
  which returns HTTP 400 on `userId === gate.userId`. Verified
  intact — this spec did not touch the edge function.
- The `delete-user` edge function's `ADMIN_ROLES` Set at
  `supabase/functions/delete-user/index.ts:19` includes
  `super_admin`. Verified intact.
- `useStore.deleteProfile` (`src/store/useStore.ts:790-825`)
  forwards to `deleteUser()` (`src/lib/auth.ts:387-394`) which calls
  the `delete-user` edge function. There is no client-side bypass.

## Server-side authorization when sidebar entry is hidden (focus area 3)

- `UsersSection` is dispatched at
  `src/screens/cmd/InventoryDesktopLayout.tsx:184-185` keyed by the
  string `'Users'`. A non-master admin who somehow gets that string
  into the active-section state (stale URL parameter, persisted
  preference, devtools) will still render the component. Same as
  the pre-existing pattern for the super-admin-gated `'Brands'`
  string at `:186-187`.
- The component itself fetches via
  `fetchAllUsers({ brandId })`
  (`src/screens/cmd/sections/UsersSection.tsx:50-58`,
  implementation at `src/lib/auth.ts:309-384`). This hits the
  `profiles` and `user_stores` tables through the standard
  Supabase client, which enforces RLS. RLS on `profiles` /
  `user_stores` is admin-scoped via `auth_is_admin()` / per-brand;
  it is NOT broken by sidebar hiding.
- The DELETE button is per-row gated by `canDelete` (admin can
  only delete non-privileged rows + not self). RESET PW is per-row
  gated by `canResetPassword` (admin can only reset `user` rows,
  not self). Both verified intact above.
- Worst case if a non-master admin reaches the section URL
  directly: they see the same stripped-down view the spec 025 M1
  finding originally described — but the M1 finding accepted that
  posture and recommended the sidebar gate as the remediation.
  Pre-existing safety is preserved; this spec doesn't weaken it.

## Semantic intentionality of widenings (focus area 5)

- TimezoneBar: only `super_admin` newly admitted. super_admin is
  the highest-privilege role; admitting it to a gate that already
  allows `admin` and `master` is correctness, not relaxation.
  Inline widening (not `useIsMaster()` swap) preserves plain admin
  access — confirmed safer than the architect's original design.
- DashboardSection: row-data predicate, not a security boundary.
  Adding super_admin to "who counts as a store manager for display"
  is cosmetic.

## Dependencies (focus area 4)

`git diff main -- package.json package-lock.json` produces no output.
No new packages, no version bumps, no `npm audit` required per the
auditor brief ("If `package.json` changed, run `npm audit`"). Baseline
unchanged.

## Other automated checks (project-specific)

- **No new tables, no RLS impact.** No migrations under
  `supabase/migrations/` in this spec.
- **No new edge functions.** No entries added to
  `supabase/config.toml` `[functions.*]` blocks. The existing
  `delete-user` function's `verify_jwt = true` default + JWT-bound
  `requireAdminCaller` are unchanged.
- **No HTML email body interpolations introduced.** No edge
  function templates touched. Spec 028's `escapeHtml` posture
  unaffected.
- **No `EXPO_PUBLIC_*` env vars added.** No secrets in code.
- **No `console.log` / `notifyBackendError` payloads touching new
  fields.** Pre-existing logging surface unchanged.
- **No client-side reliance on the `useRole()` placeholder as a
  security boundary.** The new gates use `useIsMaster()` /
  `useIsSuperAdmin()`, both of which read live `currentUser.role`.
  The placeholder `useRole()` (CLAUDE.md "Role hook is a
  placeholder") is not introduced as a new dependency.
- **No realtime subscription changes.** Per-store `auth_can_see_store()`
  posture untouched.

## Conclusion

Spec 030 is three pure-UX corrections. All four file changes are
either additive (TimezoneBar, DashboardSection — admit super_admin
to gates that already admit admin+master) or restrictive
(UsersSection canDelete, cmdSelectors Admin group — remove access
the operator already shouldn't have had per the server-side gate
or the M1 finding). No critical, high, medium, or low security
findings. No `npm audit` re-run needed (no package.json changes).

Spec is clear to advance to SHIP_READY from a security standpoint.
