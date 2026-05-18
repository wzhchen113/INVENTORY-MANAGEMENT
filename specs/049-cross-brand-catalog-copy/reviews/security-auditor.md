# Security audit for spec 049 (re-review after FIXES_NEEDED)

## Re-review scope

Second pass after the FIXES_NEEDED proposal was addressed. Re-audited the
five changes called out in the spec under "Post-review fixes (backend slice)"
and "Post-review fixes (frontend slice)":

1. `supabase/tests/cross_brand_copy.test.sql` — plan bumped from `plan(13)`
   to `plan(14)`, fixture-block UPDATE that promotes the seed manager
   `22222222-…` to `profiles.role='admin'`, split rejection arms into (1a)
   profiles.role='master' + (1b) profiles.role='admin' + (2)
   profiles.role='master' with matching JWT, tightened audit-row
   assertion from `cmp_ok(..., '>=', 3, ...)` to `cmp_ok(..., '=', 4, ...)`.
2. `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` (new)
   — 4-arm negative-gate coverage of `useIsSuperAdmin()` via
   `jest.mock('@/hooks/useRole', ...)` with heavy-child stubs.
3. `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` —
   removed dead `v_source_count INT := 0;` declaration and both unused
   `SELECT count(*) ... INTO v_source_count` scans from the
   `catalog_ingredients` and `vendors` branches.
4. (rolled into #1) audit-row count assertion tightened from `>= 3`
   to `= 4`.
5. `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` (new) —
   mirror of #2 for `VendorsSection`. Also `src/i18n/{en,es,zh-CN}.json`:
   removed dead key `dialog.copyToBrand.selectAllAria`.

Files reviewed in full this pass:

- `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` (post
  dead-var removal — confirmed no other body changes).
- `supabase/tests/cross_brand_copy.test.sql` (post arm-split + audit-row
  tightening).
- `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` (new).
- `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` (new).
- Verified `selectAllAria` is absent from all three i18n catalogs and
  unreferenced anywhere under `src/`.

Unchanged since the prior pass and not re-read in detail this round:

- `src/lib/db.ts` `copyCatalogRows` wrapper.
- `src/components/cmd/CopyToBrandDialog.tsx` + its 6-arm jest file.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` (gate render path —
  no production code change for the fixes; only added a `__tests__/`
  sibling).
- `src/screens/cmd/sections/VendorsSection.tsx` (same — gate path
  untouched).
- `supabase/tests/reports_anon_revoke.test.sql` arm 12.
- Upstream helpers (`auth_is_super_admin()`, `auth_can_see_brand()`).

## Delta-only security review

### Dead-variable removal (#3)

`supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` — the
`v_source_count` declaration + two `SELECT count(*) … INTO v_source_count`
scans were removed. Confirmed via `grep` that `v_source_count` no longer
appears in the migration file. The variable was never read; removing it
eliminates two table scans per RPC call for zero behavior change. No
authorization logic touched, no INSERT statements touched, no audit shape
changed, no gate-set ordering changed. The gate-set at lines 132-147
(super_admin → see-source → see-target → source<>target → table
whitelist) is byte-for-byte identical to the prior pass.

**Security impact: none.** Removing unused server-side variables cannot
loosen the authorization boundary or change what the function returns to
the caller.

### pgTAP test additions (#1, #4)

The test file additions (arm-split into 1a/1b/2; audit-row count locked
to `=4`) STRENGTHEN coverage of the role gate:

- (1a) `profiles.role='master'` rejected — same shape as prior arm (1),
  unchanged.
- (1b) `profiles.role='admin'` rejected — **NEW**. Exercises a real
  `profiles.role='admin'` caller against the gate (the prior pass only
  tested 'master' from `profiles` + JWT-level 'admin'). The fixture
  block at `cross_brand_copy.test.sql:46-54` does
  `UPDATE profiles SET role='admin' WHERE id='22222222-…'` inside the
  transaction — this mutation rolls back at the trailing `rollback;`
  (line 459) and `profiles_role_brand_consistent` is satisfied because
  the seed already supplies `brand_id` for that profile. No fixture
  leakage. Security: this arm gives concrete evidence the gate rejects
  `profiles.role='admin'` (the prior pass relied on the architect's
  prose claim that 'admin' resolves to FALSE in `auth_is_super_admin`).
- (2) `profiles.role='master'` + matching JWT — was prior arm (2),
  unchanged shape.
- (9a) audit-row count tightened from `>= 3` to `= 4`. A vendors-audit
  regression OR a stray INSERT in any rejected arm (1a, 1b, 2, 7, 8)
  would now flip the count and fail this assertion. Strictly more
  precise — no security impact, but a stronger regression guard.

The transaction-scoped `UPDATE profiles … role='admin'` raises no
security flag. pgTAP runs as the database superuser; the rollback at end
of file unwinds it. The fixture mirrors the same-file
`UPDATE profiles … role='super_admin' … id='11111111-…'` at line 41-43
which the prior pass already accepted.

### New frontend negative-gate tests (#2, #5)

`src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` and
`src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` mock
`useIsSuperAdmin()` directly via `jest.mock('@/hooks/useRole', …)`. The
mock is a per-test-overrideable `jest.fn()` that defaults to `false`.
Each file has 4 arms (2 negative-gate + 2 positive-control). The tests
mount the production components with stubbed heavy children and assert
absence/presence of the checkbox + COPY pill + bulk pill DOM by their
accessibility-label / text-content.

**Security review of the test code itself:**

- The tests mock the client-side `useIsSuperAdmin` hook. Per CLAUDE.md
  and the prior audit's §6, the client-side role hook is intentionally
  untrusted at the API layer — the server-side `auth_is_super_admin()`
  RPC gate is the real boundary. These jest tests exercise the UX-layer
  hiding only; they do NOT and cannot substitute for the pgTAP arms (1a,
  1b, 2, 3) that exercise the RPC layer. The arms-split in the pgTAP
  file (item #1 above) is what the RPC-layer negative-gate coverage
  actually relies on. Both gates exist, both are tested — the design
  matches the architect's §J "defense-in-depth" posture.
- The tests pass a non-undefined fake event `{ stopPropagation: () => {} }`
  to `fireEvent.press` because the row handler calls `e.stopPropagation?.()`.
  Synthetic fixture only — no production code path is altered, no auth
  bypass is being exercised. (`fireEvent` runs in-process under the jest
  jsdom-equivalent environment.)
- No new secrets, no token handling, no env var reads, no network
  fetches in either test file. All store reads come from a module-scope
  `jest.mock('@/store/useStore', …)` stub with `brand: { id: 'brand-source' }`
  hardcoded — there is no real brand id, real user, or real role data
  being seeded.
- The test files write 0 production-state mutations. They cannot leak
  into production.

### i18n dead-key removal (#5)

`dialog.copyToBrand.selectAllAria` removed from en/es/zh-CN. The key was
never referenced in any component (verified by `grep -rn selectAllAria
src/`). Removing an unused string cannot affect the security boundary —
all interpolation paths in `CopyToBrandDialog.tsx` and the two section
files were already audited under §7 (i18n + XSS) of the prior pass and
render through `<Text>` only. No `dangerouslySetInnerHTML`, no `eval`, no
HTML interpolation paths anywhere in these components.

## Re-check of prior findings

### Critical, High, Medium
None then. None now. The five fixes are bounded to test additions, a
dead-var removal, a tightened assertion, and a dead-i18n-key cleanup —
none of which alter the authorization boundary, the INSERT path, the
audit shape, the GRANT set, the search_path, or any caller-visible
behavior. The privilege gate at the migration's lines 133-147 is
byte-for-byte unchanged.

### Low (both pre-existing, architect-acknowledged)

Both Low findings from the prior pass are unchanged and remain
out-of-scope-but-tracked:

- **L1** `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql:134-146`
  — exception SQLSTATE is `P0001` (`raise_exception`), not `42501`
  (`insufficient_privilege`). Architect's §K8 / §L; deferred per user
  instruction. The pgTAP arms now exercise three independent role-gate
  rejection paths (1a, 1b, 2) and the audit-count arm asserts each
  rejected call wrote zero side-effect rows — so the end-state
  authorization behavior is doubly evidenced. Convention finding only;
  no deploy blocker.
- **L2** `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql:280-296`
  — audit_log INSERT runs under `SECURITY DEFINER`, bypassing the
  existing `store_member_insert_audit_log` policy (NULL store_id +
  `auth_is_admin()` arm). Architect's §D + §K9. Audit rows are written
  but not readable to super-admin via PostgREST (pre-existing
  audit-visibility gap, not introduced by spec 049). Surfaced for a
  future audit_log policy rewrite spec; not in this spec's blast
  radius. The tightened `cmp_ok(..., '=', 4, ...)` arm (9a) confirms the
  four expected audit rows DO land in the target brand — addressing the
  architect's §K9 mitigation that "pgTAP arm asserts the audit row is
  written when super-admin runs the RPC, which would catch a regression."

## Dependencies

No `package.json` changes — skipped `npm audit`.

## Posture confirmation

Prior audit said: 0 Critical, 0 High, 0 Medium, 2 Low (pre-existing /
architect-acknowledged).

This re-audit says: **0 Critical, 0 High, 0 Medium, 2 Low. Posture
unchanged.**

None of the five fixes touched the authorization boundary, the SQL
INSERT paths, the audit row shape, the GRANT lockdown, the search_path,
or the gate-set ordering. The dead-variable removal is a pure cleanup
(two unused table scans gone). The pgTAP arm-split strengthens the
role-gate evidence (now exercises both `profiles.role='admin'` AND
`profiles.role='master'` as independent calls). The frontend jest tests
exercise the UX-layer hiding, which is correctly identified as
defense-in-depth on top of the server-side `auth_is_super_admin()`
RPC gate that is the real authorization boundary. The dead i18n key
removal is irrelevant to security. The audit-count tightening to `= 4`
is strictly stronger regression coverage.

The spec remains safe to advance to SHIP_READY from a security
perspective.

## Handoff
next_agent: NONE
prompt: Re-review complete. Posture unchanged: 0 Critical, 0 High, 0 Medium, 2 Low (both pre-existing / architect-acknowledged in spec §K8 and §K9; neither blocks deploy). The five FIXES_NEEDED items were bounded to test additions, a dead-var removal, a tightened assertion, and a dead-i18n-key cleanup — none altered the authorization boundary, the SQL INSERT paths, the audit shape, the GRANT lockdown, the search_path, or the gate-set ordering. The pgTAP arm-split (1a profiles.role='admin' + 1b profiles.role='master' + 2 master-with-matching-JWT) strengthens role-gate evidence; the tightened `=4` audit-row assertion is a stronger regression guard. Spec remains safe to advance to SHIP_READY from a security perspective.
payload_paths:
  - specs/049-cross-brand-catalog-copy/reviews/security-auditor.md
