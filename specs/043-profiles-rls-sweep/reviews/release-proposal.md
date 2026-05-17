## Verdict
verdict: SHIP_READY
rationale: All four reviewers report 0 Critical / 0 High / 0 Should-fix; the two carry-forward Mediums from Spec 042 (cross-brand SELECT + DELETE on `profiles`) are now empirically closed, completing the brand-isolation work begun in Specs 041-042.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, 4 Nits. Re-review confirms the three prior Should-fix items (S1 null-vs-null `brand_id` mispass, S2 TOCTOU on profile reads, S3 misleading arm-11 comment) all landed cleanly. Remaining nits are non-blocking: the opportunistic `!`-elimination is clean, the `(2026-05-17)` date was removed from the arm-9 patch comment, and two pre-existing nits carry forward (no explicit `begin/commit` wrapper in the migration — uniform with all sibling migrations; and an arm-4 fixture cross-reference comment whose target arm number is correct on HEAD).

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 2 Low. Both Lows are pre-existing edge-function patterns (raw DB error message propagation; `403` status used for DB-lookup-failure paths) not introduced by this spec. Eight attack surfaces live-verified closed against the running stack — including JOIN-through-invitations leakage, `brand_id` enumeration, `id IN (...)` enumeration, JWT spoofing with forged `super_admin` claim, request-body field spoofing (`brandId`/`callerBrandId`/`role`/`appRole` extras), and TRUNCATE rejection. `pg_policies` final state matches the spec verbatim; no `USING (true)` or brand-blind arms remain on `profiles`. 28/28 pgTAP files green; `npx tsc --noEmit` exit 0. The two Spec 042 carry-forwards (`public.invitations` brand-blind admin SELECT, and the brand-blind INSERT on `profiles` that is operationally inert via FK + CHECK) are explicitly out of scope per the spec.

- **test-engineer**: 18 PASS, 0 FAIL, 0 NOT TESTED, 1 Nit. Every acceptance criterion verified: SELECT/DELETE policy reshape (arms 1-9), Spec 041 self-DELETE trigger (arm 10), `assert_not_last_of_role` SECURITY DEFINER bypass with exact P0001 message (arm 11), and the optional TRUNCATE 42501 arm (arm 12). No-regression checks all PASS: `rls_hardening_followups.test.sql` 15/15 after the architect-designed three-line arm-9 fixture patch; `auth_can_see_store_brand_scope.test.sql` 14/14; full suite 28/28. The single Nit is a missing shell-smoke arm for the edge-function 403 cross-brand path — non-blocking because the SQL-side policy is the authoritative gate, the edge function is defense-in-depth over service_role's RLS bypass, and Deno isn't testable via jest. The backend-developer documented the edge-function smoke results inline in the spec.

- **backend-architect**: 0 Critical, 0 Should-fix, 2 Minor. NO DRIFT. Implementation matches the design contract on every load-bearing dimension: migration timestamp ordering preserved (`20260517060000` > `20260517050000` > `20260517040000`), pre-flight `do $$` block message exact-match, both policy USING clauses exact-match, edge-function wire-in order (brand gate BEFORE `assert_not_last_of_role`) exact-match, all 12 pgTAP arms map 1:1 to the §8 plan table, and the arm-9 fixture patch is surgical (2 statements added, no other arm bodies touched). The two Minor items are cosmetic: a wording inconsistency in the design itself (said "three-line insertion" but quoted a two-statement body — implementation followed the quote), and a fail-closed `'forbidden: caller profile not found'` branch in the new helper that wasn't explicitly enumerated in the design but is correct defense-in-depth. Cross-spec composability with Specs 027, 028, 030, 031, 032, 041, 042 confirmed intact.

## Recommended next steps (ordered)

1. **Commit the ship-ready bundle.** Single migration + single edge function re-deploy; no operator step required, no realtime publication change, no `docker restart` step. Suggested commit message: `Spec 043: Profiles RLS sweep — cross-brand SELECT + DELETE lockdown (SHIP_READY)`. Stage:
   - `specs/043-profiles-rls-sweep.md`
   - `specs/043-profiles-rls-sweep/reviews/code-reviewer.md`
   - `specs/043-profiles-rls-sweep/reviews/security-auditor.md`
   - `specs/043-profiles-rls-sweep/reviews/test-engineer.md`
   - `specs/043-profiles-rls-sweep/reviews/backend-architect.md`
   - `specs/043-profiles-rls-sweep/reviews/release-proposal.md`
   - `supabase/migrations/20260517060000_profiles_rls_sweep.sql` (new)
   - `supabase/tests/profiles_rls_sweep.test.sql` (new)
   - `supabase/functions/delete-user/index.ts` (modified)
   - `supabase/tests/rls_hardening_followups.test.sql` (arm-9 fixture patch)

2. **Re-deploy `delete-user` edge function** after the migration applies. The edge function's `requireSameBrandOrSuperAdmin` gate is defense-in-depth over service_role's RLS bypass — it must ship together with the policy tightening or the service-role path remains an unmitigated bypass for cross-brand admin deletes. No `verify_jwt` config change; function defaults remain in effect.

3. **(Optional, non-blocking) Track follow-up tickets:**
   - Add a `scripts/smoke-edge-roles.sh` arm: brand-A admin JWT → brand-B target UUID → assert HTTP 403 `{"error":"forbidden: target is in a different brand"}` (test-engineer Nit).
   - Apply the same `auth_can_see_brand(brand_id)` sweep to `public.invitations` (security-auditor Spec 042 carry-forward). This is the next equivalent-severity cross-brand information-disclosure surface; recommend a Spec 044 modeled on this spec's drop-and-recreate pattern.
   - Future cleanup: drop the redundant `super_admin_read_all_profiles` SELECT policy (pre-exists from Spec 012a; functionally subsumed by the new "Admins can read all profiles" super_admin short-circuit arm) — flagged by test-engineer.
   - Edge-function error-surfacing hardening sweep: replace raw `targetErr.message` / `callerErr.message` / `lookupError.message` with constant strings + `console.warn` of internals; switch DB-lookup-failure responses from 403 to 500 for clearer operator signal (security-auditor Lows).

## Out of scope for this review

- **`send-invite-email` cross-brand review.** Architect performed an end-to-end read and confirmed no brand-blind decision in the function (the only `profiles` read is the caller's own row for `requireAdminCaller`'s fallback). No code change landed. Explicitly out of scope per spec §"Edge-function defense-in-depth (`send-invite-email`) — scoped".
- **Migration `begin/commit` wrapper style.** Consistent across all sibling migrations (Supabase CLI wraps each migration in a transaction by default); not elevated by any reviewer.
- **`public.invitations` brand-blind admin policies.** Pre-existing Spec 042 carry-forward; equivalent severity to the Mediums this spec just closed on `profiles`. Recommend a follow-up sweep.
- **Brand-blind INSERT policy on `profiles`** (`"Anyone can insert own profile or admin can insert any"`). Operationally inert via FK to `auth.users` + `profiles_role_brand_consistent` CHECK; tracking only.
- **`npm audit` carry-forwards** (`@xmldom/xmldom` high, dompurify/postcss/jest-environment-jsdom moderates). Tracked in spec 037+ register; no `package.json` change in this spec.

---

This spec closes the last two cross-brand admin leaks on `public.profiles` — completing the brand-isolation work across Specs 041 (self-DELETE trigger + self-edit triggers), 042 (UPDATE tightening + trigger broadening), and 043 (SELECT + DELETE tightening). The `profiles` table is now fully brand-isolated for non-super_admin callers across all four DML verbs, with the Spec 041 self-DELETE trigger and Spec 031 `assert_not_last_of_role` SECURITY DEFINER helper preserved intact.

## Handoff
next_agent: NONE
prompt: SHIP_READY — Spec 043 closes the last 2 cross-brand admin leaks on profiles (SELECT + DELETE); completes Specs 041-043 brand-isolation arc. 0 Critical across all 4 reviewers, 28/28 pgTAP green, 8/8 attack surfaces live-verified closed. Single migration + edge function re-deploy, no operator step.
payload_paths:
  - specs/043-profiles-rls-sweep/reviews/release-proposal.md
