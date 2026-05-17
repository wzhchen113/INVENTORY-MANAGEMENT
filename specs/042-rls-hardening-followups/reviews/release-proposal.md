## Verdict
verdict: SHIP_READY
rationale: All four reviewers concur — 0 Critical, 0 High/Should-fix open; the round-4 SECURITY INVOKER trigger discriminator is empirically verified (dev probe + manual Row J reproduction), all 27 pgTAP files pass, and the two earlier blocking issues (code-reviewer Should-fix comments, test-engineer staging mismatch) have been resolved by the dev's follow-up edits and re-staging.

## Findings summary
- **code-reviewer**: 0 Critical, 0 Should-fix (2 originally flagged were resolved post-review by the dev's follow-up edit to arm-(5) and arm-(7) test comments), 4 Nits. Top items: stale round-3 `auth.uid() is not null` guard comments rewritten to cite the round-4 `current_user in ('authenticated','anon')` mechanism; minor period-punctuation inconsistency on policy comments; a 27-line design-history block comment that could be trimmed in future cleanup.
- **security-auditor**: 0 Critical, 0 High, 2 Medium (both explicit carry-forward, out-of-scope per Spec 042 Risk #3/#4), 2 Low (1 documented-inert FK-blocked INSERT vector; 1 doc-string ambiguity in `comment on function`). Live-verified all three Spec 041 carry-forward findings closed plus the Row J trigger broadening. 17-attack aggressive sweep confirms no new escalation vectors. SECURITY DEFINER RPC walk (24 functions reviewed) found none that mutate `profiles.role` or `profiles.brand_id`.
- **test-engineer**: 9 PASS (8 ACs + pgTAP arm-to-AC mapping all green), 0 FAIL, 0 NOT TESTED. All 15 new arms pass; full suite 27/27 (15/15 new spec-042 + 14/14 spec-041 regression + 12 pre-existing). Original Critical "staging mismatch" finding (working-tree had round-4 INVOKER but staged file had round-3 DEFINER) is **resolved** by post-review re-staging — confirmed by all-pass run. Minor AC(a) sub-gap (super-admin UPDATE/DELETE not separately exercised, only INSERT) is by-architect design per spec §Q5 short-circuit rationale; non-blocking.
- **backend-architect**: 0 Critical, 0 Should-fix, 3 Minor. Verdict: **NO DRIFT** — implementation matches the round-4 §13 design verbatim (8-item checklist all YES). Minor follow-ups: explicit `grant execute … to authenticated, anon` would belt-and-suspender Risk #9; function name `assert_brand_id_immutable_for_self` doesn't advertise broadened cross-user role scope (kept for migration-history continuity per §13 Risk #8); a future arm-16 covering `brand_id IS NULL` targets would close the trigger-fires-before-CHECK loop.

The 4-round architectural saga is a positive workflow signal, not a red flag: round-2 caught that `auth.uid() is not null` failed to exempt stale-claims fixtures; round-3 caught that `current_user in ('authenticated','anon')` collapses to `postgres` under SECURITY DEFINER. Both were empirical correctness issues that a single-pass implementation would have shipped broken (Row J would remain open under round-3, and the trigger would no-op on the test harness under round-2). The dev's row-2 probe table and manual Row J SQLSTATE/message reproduction are the decisive artifacts.

## Recommended next steps (ordered)
1. Commit and deploy.
2. (optional follow-up, non-blocking) Open a successor spec to address:
   - Risk #3 / security-auditor Medium: "Admins can read all profiles" cross-brand SELECT enumeration.
   - Risk #4 / security-auditor Medium: "Admins can delete profiles" cross-brand DELETE.
   - backend-architect Minor 1: explicit `grant execute on function public.assert_brand_id_immutable_for_self() to authenticated, anon` to harden Risk #9 against future PUBLIC-REVOKE migrations.
   - backend-architect Minor 2: rename `assert_brand_id_immutable_for_self` → `assert_profile_columns_locked` (or similar) to reflect broadened role-immutability scope.
   - backend-architect Minor 3: defense-in-depth pgTAP arm 16 covering `brand_id IS NULL` target under Row J trigger (proves trigger fires before row-level CHECK regardless of target state).
   - code-reviewer Nits: punctuation consistency on policy comments; trim the 27-line design-history block; orient-future-maintainer note for the seed-master promotion-persistence pattern in arm (7).

## Out of scope for this review
- "Admins can read all profiles" cross-brand SELECT enumeration (security-auditor Medium, spec §Risk #3) — belongs in a future RLS-sweep spec.
- "Admins can delete profiles" cross-brand DELETE (security-auditor Medium, spec §Risk #4) — belongs in a future RLS-sweep spec.
- "Anyone can insert own profile or admin can insert any" admin arm brand-blindness (security-auditor Low, spec §Risk #5) — operationally inert today (FK to `auth.users` blocks the chain absent service_role); documented future-spec item.
- `npm audit` carry-forward backlog (`@xmldom/xmldom` High, postcss/dompurify/jest-expo) — declared out of scope by spec §"Out of scope" line 200-201; not a Spec 042 blocker.

## Commit artifacts
- `specs/042-rls-hardening-followups.md`
- `specs/042-rls-hardening-followups/reviews/code-reviewer.md`
- `specs/042-rls-hardening-followups/reviews/security-auditor.md`
- `specs/042-rls-hardening-followups/reviews/test-engineer.md`
- `specs/042-rls-hardening-followups/reviews/backend-architect.md`
- `specs/042-rls-hardening-followups/reviews/release-proposal.md`
- `supabase/migrations/20260517050000_rls_hardening_followups.sql`
- `supabase/tests/rls_hardening_followups.test.sql`

Operator step: none. Single migration applied via `supabase db push`. No edge function changes, no secret changes, no realtime publication touched (no `docker restart` required per spec §6 + security-auditor verification).

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/042-rls-hardening-followups/reviews/release-proposal.md
