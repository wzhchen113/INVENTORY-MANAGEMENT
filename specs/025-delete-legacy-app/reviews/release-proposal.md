## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across all four reviewers; 25/25 acceptance criteria pass (24 verified in code, 1 manual smoke by spec design); every Should-fix is either a UX polish, a stale-doc cleanup, an orphan devDep, or a pre-existing weakness this spec merely surfaces, not introduces.

## Findings summary

- **code-reviewer**: 0 Critical, 5 Should-fix, 4 Nits. Top issues: (1) double-toast on self-delete from `deleteProfile` + `handleConfirmDelete` both firing; (2) dead `isMaster ? 'user' : 'user'` ternary in `InviteUserDrawer.tsx:65` (both branches identical — either the comment lies or the constant is wrong); (3) orphan `json-server` devDependency in `package.json:72` (callers all deleted); (4) `CLAUDE.md` still references `AppNavigator`, `featureFlags.ts`, `EXPO_PUBLIC_NEW_UI`, `useJsonServerSync.ts`, `db.json`, and the "Legacy admin screens" section after deletion — agents reading the contract will be misled; (5) `useIsMaster` predicate duplicated across `UsersSection.tsx` and `InviteUserDrawer.tsx`.

- **security-auditor**: 0 Critical, 0 High, 5 Medium, 5 Low. No exploit chain lands in this PR. All five Mediums are pre-existing weaknesses spec 025 surfaces by promoting the user-management surface to the canonical sidebar: (M1) invitations RLS missing `super_admin` in the IN-list (this one is a *product-correctness regression* the moment a super-admin clicks Invite — see Recommended next steps); (M2) `Users & access` sidebar visible to non-master admins gives misleading single-row view; (M3) invitations INSERT policy does not cross-check `brand_id` / `store_ids` against caller-visible scope; (M4) `send-invite-email` interpolates `name` / `email` / `storeNames` into HTML without escaping; (M5) `sendPasswordReset` naming implies admin-only authorization but is actually the unauthenticated GoTrue endpoint (rate-limited by Supabase config, not by the helper). `npm audit` is unchanged from `main`: 1 high build-only (`@xmldom/xmldom` in `@expo/plist`), not reachable from runtime.

- **test-engineer**: 25/25 ACs verified — 24 PASS via code/test inspection, 1 manual-only by spec design (AC18 parity smoke). Test runs green: `npm test -- --ci` 17/17 across 3 suites; `npx tsc --noEmit` exit 0; `npm run typecheck:test` exit 0; `npm run test:db` 13/13; `npm run test:smoke` PASS. Coverage gaps flagged as Should-fix: (1) no unit tests for `canDelete` / `canResetPassword` pure-helper logic despite security-relevant gate cases (6+ distinct branches); (2) no unit or smoke test for the new 7-line `sendPasswordReset`. Three cosmetic Nits on toast prose / button label divergence from spec text (functionally equivalent).

- **backend-architect (post-impl drift)**: 0 Critical, 3 Should-fix, 5 Nits. Implementation matches design across all 6 contract surfaces (invite shim removed, `sendPasswordReset` signature exact, admin sidebar group placement, CSV/PDF export web-only + dynamic imports + fixed column order, tsconfig excludes, `typecheck-base` CI job shape). Top drift-adjacent findings: (S1) **no guard against deleting the last super-admin / master** — a master CAN delete the only super-admin, orphaning the global admin surface (legacy `UsersScreen` had the same gap but a workaround via `AppNavigator` existed; with legacy deleted, this becomes a real foot-gun); (S2) no realtime subscription on UsersSection — *per design §7*, not a drift finding, flagged as a release-note item only; (S3) orphan `json-server` devDep (same as code-reviewer #3). Nits cover section-arm placement order, two-toast self-delete (same as code-reviewer #1), `canResetPassword` blocking master↔super-admin resets (stricter than AC25 but defensible), and four comment-only `NEW_UI` survivors (intentional per spec §1d).

## Recommended next steps (ordered)

### SHIP_READY — pre-commit gate (user must do these before commit)

1. **Run the AC18 parity smoke checklist on a local `npm run web` build.** The test-engineer reproduced the full checklist at lines 112–143 of `test-engineer.md`. Confirm each legacy entry point's Cmd UI equivalent renders, then specifically validate the new invite/delete/reset-password gates and the new CSV/PDF download paths. This is the one acceptance criterion that cannot be code-verified; the spec deliberately scoped it as manual.

2. **Decide on the native EAS build cutover (AC20 is breaking for native).** Removing `EXPO_PUBLIC_NEW_UI` means the next EAS build switches all native installs from `AppNavigator` to `CmdNavigator`. Spec deliberately scopes out native validation; if any TestFlight beta is in flight, plan accordingly.

### SHIP_READY — fast-follow tickets (file before/after merge, do not block ship)

In severity order. Items 1–2 are product-correctness regressions surfaced by this PR and should be the next spec out. Items 3–5 are pre-existing security weaknesses that became more reachable. Items 6+ are cleanup.

1. **[Product-correctness regression — fix soonest] `invitations` RLS does not include `super_admin`.** `security-auditor.md` M-finding #4. The four `invitations` policies in `20260424211733_security_fixes.sql:46-57` hard-code `['admin','master']`. Spec 025 explicitly broadens `isMaster` in the UI to include `super_admin` (per design §2.G.1), but the RLS row was never updated. Symptom the user will hit: a super-admin clicks Invite in the new drawer and the INSERT fails with RLS rejection. Pre-existing in the policy, but spec 025's design is the trigger. One-migration fix mirroring the pattern in `delete-user/index.ts:19`.

2. **[Admin foot-gun] No guard against deleting the last super-admin / master.** `backend-architect.md` S1. A master can delete the only super-admin, orphaning the Tenancy surface with no path back. Recommended fix: client-side second-stage confirm in `UsersSection.tsx` when `count(role === target.role) === 1 && target.role in ('master','super_admin')`; belt-and-suspenders server check in the `delete-user` edge function.

3. **[Pre-existing — promoted surface] `invitations` INSERT policy does not cross-check `brand_id` / `store_ids` against caller-visible scope.** `security-auditor.md` M-finding #2. A direct PostgREST POST could create an invitation for any brand the admin can't see; the cross-brand store trigger catches the registration step but the invitation row + email already shipped. Tighten policy to call `auth_can_see_brand(brand_id)` and assert every `store_id` belongs to that brand.

4. **[Pre-existing — promoted surface] HTML-escape interpolations in `send-invite-email` and `send-welcome-email`.** `security-auditor.md` M-finding #3. A malicious admin (or one with a stolen session) could craft `name = '<script>...</script>'` and the email body renders the markup in any mail client that doesn't strip script tags. Predates spec 025 but the invite flow is now sidebar-prominent.

5. **[Pre-existing — UX]** `Users & access` sidebar entry visible to non-master admins gives them a misleading one-row view of themselves. `security-auditor.md` M-finding #1. Either gate the sidebar group on `useIsMaster()` (same pattern as Tenancy), or add a defensive role gate in `UsersSection` that renders "you don't have access" instead of a single-row list. Server-side RLS is sound; this is purely an affordance fix.

6. **[Doc rot]** Update `CLAUDE.md` to reflect deletions. `code-reviewer.md` Should-fix #4. Lines 14, 42, 55, 80, 207, 220 reference `AppNavigator.tsx`, `featureFlags.ts`, `EXPO_PUBLIC_NEW_UI`, `useJsonServerSync.ts`, `db.json`, `npm run db`, the "Legacy — do not modify" list, and the "Legacy admin screens" section — all now stale. Agents read CLAUDE.md as the project contract; stale links will mislead future agents within days. Update the "UI fork via env flag" convention to "Cmd UI is the only client," collapse the do-not-modify list, and update the legacy-screens section to say the file was deleted.

7. **[Cleanup]** Remove `json-server` from `devDependencies`. Both `code-reviewer.md` Should-fix #3 and `backend-architect.md` S3. Callers (`db.json`, `useJsonServerSync.ts`, `src/lib/api.ts`, `npm run db`) are all deleted in this PR; the dep is fully orphaned. Spec dev correctly deferred per "ask before expanding scope." Inert, but carrying it inflates `npm install` time and audit surface.

8. **[Bug]** Fix the dead `isMaster ? 'user' : 'user'` ternary at `InviteUserDrawer.tsx:65`. `code-reviewer.md` Should-fix #2. Either the comment lies (delete the ternary, default to `'user'`) or the constant is wrong (master branch should default to `'admin'`). Clarify intent; remove the dead branch either way.

9. **[Polish]** Suppress double-toast on self-delete (`UsersSection.tsx:117-131` + `useStore.ts:805-810`). Both `code-reviewer.md` Should-fix #1 and `backend-architect.md` N2. Add `{ silent?: boolean }` option to `deleteProfile`, or have the self-delete branch skip its success toast and rely on the store's toast.

10. **[Polish]** Promote `useIsMaster` to `src/hooks/useRole.ts` so `UsersSection` and `InviteUserDrawer` share one source of truth. `code-reviewer.md` Should-fix #5. Future role broadening (new privileged role) becomes a one-line change instead of two.

11. **[Test coverage]** Extract `canDeleteUser(isMaster, isSelf, targetRole)` and `canResetPassword(isMaster, isSelf, targetRole)` as pure helpers; add unit tests on the gate cases. `test-engineer.md` Should-fix #1. Spec waived net-new jest tests; this came in as a reviewer ask because the gates are security-surface logic with 6+ branches.

12. **[Test coverage]** Add a unit (or `smoke-rpc.sh`) test for `sendPasswordReset`. `test-engineer.md` Should-fix #2. Seven-line wrapper, but it's the one net-new auth helper in this PR.

### Security Mediums — categorization for ticket-filing

Per the user's explicit ask:

**Pre-existing weaknesses surfaced (not introduced) by this PR — file as separate follow-up tickets, not as spec 025 blockers:**
- M1 `Users & access` sidebar UX gate (item 5 above)
- M2 invitations RLS missing `super_admin` (item 1 above — *product-correctness regression*, not just a security ticket)
- M3 invitations INSERT cross-brand check (item 3 above)
- M4 `send-invite-email` / `send-welcome-email` HTML escaping (item 4 above)
- M5 `sendPasswordReset` JSDoc clarifying it's the GoTrue public endpoint (low-effort doc fix, can ride with item 9)

**Net-new in this PR**: none of the security Mediums originate here. The four contract surfaces this PR adds (`UsersSection`, `InviteUserDrawer`, `sendPasswordReset`, CSV/PDF export) all sit on top of pre-existing RLS and edge-function policies.

## Out of scope for this review

- **Native EAS build validation.** Spec §3 / AC20 explicitly scopes out native rendering testing. The release-coordinator notes the next EAS build is the first native installation of Cmd UI for any user who hadn't manually flipped `EXPO_PUBLIC_NEW_UI`. If a TestFlight beta gate is desired before the next App Store / Play Store push, the user should plan it independently.
- **`@xmldom/xmldom <=0.8.12` high audit finding.** Transitive through `expo → @expo/cli → @expo/plist`, build-time only, not in shipped bundle. Predates this spec and the broader project; `npm audit fix` may resolve, recommend a separate dependency-hygiene pass.
- **The four comment-only `EXPO_PUBLIC_NEW_UI` survivors** at `CmdAtomsPreview.tsx:31`, `ComingSoonScreen.tsx:34,122`, and `ThemeToggle.tsx:10`. Spec §1d carved these out intentionally for the CLAUDE.md follow-up edit pass. Architect N4 confirms no action required.
- **`app.json` slug = `towson-inventory`** mismatch. Project policy (CLAUDE.md) says agents must not auto-fix; surface as a user question. Not touched in this PR.
- **Realtime subscription for `UsersSection`.** Per spec §7, the on-mount + post-action refetch posture is intentional for admin-only / low-frequency surfaces. Architect S2 flags only as a release-note item, not a fix.
- **`canResetPassword` blocking master↔super-admin resets.** Architect N3 — stricter than AC25 but defensible. If the user expects a super-admin to be able to reset a master's password from this UI, file as a behavior-clarification ticket; otherwise the current gate stands.

## Handoff

next_agent: NONE
prompt: SHIP_READY, 0 Critical across all reviewers. User must run the AC18 manual parity smoke before commit and decide on native EAS rollout timing; 12 fast-follow tickets ordered by severity, with item #1 (invitations RLS missing `super_admin`) being the only product-correctness regression that should land soonest after merge.
payload_paths:
  - specs/025-delete-legacy-app/reviews/release-proposal.md
