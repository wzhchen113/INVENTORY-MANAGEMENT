## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical (or High/Medium); all automatable acceptance criteria pass, the architect confirms zero drift, and the latest test.yml on main is green — the lone cross-cutting finding is a stale comment both reviewers route to the spec-084 follow-up.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 4 Nits. Top: stale inline comment at `src/lib/auth.ts:468-470` ("Cleanup #16 scopes the query to the current brand …") is now false after the `.eq('brand_id', brandId)` removal; code-reviewer itself recommends landing the one-word amendment in the spec-084 follow-up "if not now." Nits: missing inline-copy drift annotations on pgTAP arms 3/5/6, implicit `eqSpy` module-`let` coupling, `inviteRow` default polarity, and a pre-existing `as any[]` return cast (explicitly out-of-scope).
- security-auditor: 0 Critical, 0 High, 0 Medium, 2 Low (informational, no action). Top: independently verified that dropping `.eq('brand_id', brandId)` does NOT widen non-super-admin reads — the live `invitations` SELECT policy is `using (auth_is_privileged())`, a brand-agnostic admin/master/super_admin gate, so the client filter was never the security boundary; brand-isolation of which users appear lives on the untouched `profiles` query. Backfill writes only `brand_id`, derives it solely from `public.profiles` (never `auth.users`), no dynamic SQL, no PII in notices, idempotent. No `package.json` change → `npm audit` skipped.
- test-engineer: AC1–AC7 PASS (automated). AC8/AC9 (Bobby/Charles render email; Reset-Password + Delete unblocked) are NOT TESTED automated — spec-designated manual-verify-only, transitively covered by AC7 asserting non-empty email at the loader. jest 44 suites / 406 tests green; targeted 4/4 green; pgTAP 40/40 files (new file 6/6); base + test-graph typechecks exit 0. Inline-UPDATE byte-identity, arm-4 seed-name match, and both-cases AC7 coverage all confirmed real, not vacuous.
- backend-architect: MATCHES DESIGN (no drift). 0 Critical, 0 Should-fix, 2 Minor. Both Minors are the same `auth.ts:468-470` pre-existing-comment staleness in the deliberately-frozen `fetchAllUsers` — the design (§4) instructed no edit there, so leaving it is the correct call; the authoritative correction already lives in the `db.ts:fetchInvitationsForUserLookup` doc block. `fetchBrandAdmins` correctly left untouched (deferred to §7 follow-up); migration filename sorts strictly after spec-082's `20260531000000`, preserving the load-bearing ordering UPDATE #1 depends on.

## Recommended next steps (ordered)
SHIP_READY:
1. Commit the spec-083 change set (the user commits manually at the gate):
   - `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql` (new, data-only)
   - `src/lib/db.ts` (`fetchInvitationsForUserLookup` brand-filter relaxation + corrected doc comment)
   - `supabase/tests/invitations_brand_id_backfill.test.sql` (new, pgTAP, 6 arms)
   - `src/lib/db.fetchInvitationsForUserLookup.test.ts` (new, jest, 2 arms)
   - `src/lib/auth.fetchAllUsers.test.ts` (new, jest, 2 arms)
2. After the push to `main`, confirm the latest `test.yml` run on `main` is green (per the CLAUDE.md post-push CI rule) before any further pipeline work.
3. Apply the migration to prod: run `npx supabase db push --linked`. Until this runs, the `db-migrations-applied` drift gate will flag one new local migration not yet in prod — expected and documented in the spec's Dependencies. (Note: this gate runs in the separate `db-migrations-applied.yml` workflow; the `test.yml` gate in step 2 is independent of it.)
4. Manual verify after prod apply (the two UI-consequence ACs the test-engineer marked manual-only): in Users & access, confirm Bobby and Charles render their email (not "(email not loaded)") in BOTH the super_admin all-brands view and a brand-scoped view, and that Reset-Password + Delete are no longer blocked by the empty-email guard for those rows.

(optional) Follow-ups not blocking ship — see "Out of scope" below.

## Out of scope for this review
- **Spec 084 (recommended follow-up).** Apply the symmetric `.eq('brand_id', brandId)` relaxation to `fetchBrandAdmins` (`src/lib/db.ts:3242-3266`) — the architect's §7 defers this because it also needs the pending-row-construction analysis (the `!used` synthetic-row shaping uses `brand_id`, so a bare drop is more than a one-liner). Fold in the stale-comment fix at `src/lib/auth.ts:468-470` (amend "Cleanup #16 scopes the query …" → "previously scoped … (spec 083 dropped that filter — see `db.ts:fetchInvitationsForUserLookup`)"). Both code-reviewer (Should-fix) and architect (Minor) route this comment to that follow-up; it is not a ship-blocker for 083 because the authoritative corrected comment already lives in the new `db.ts` doc block, leaving the loader behaviorally correct while only the sibling-file comment trails for one spec.
- **Nit cleanups (code-reviewer), all optional and non-blocking:** add the inline-copy drift annotation to pgTAP arms 3/5/6; make the `eqSpy` capture explicit rather than relying on the module-`let` side-effect; invert the `inviteRow` default to `brand_id: null`; tighten the pre-existing `as any[]` return cast on `fetchInvitationsForUserLookup` (the cast is pre-existing, not introduced by 083).
- **Accepted gaps already documented in the spec (not findings):** the bootstrap super_admin with zero invitation rows still shows "(email not loaded)" (nothing to infer from); name-match-ambiguous sentinel rows are left NULL by the exactly-one guard; no email column added to `profiles`.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 083 is a clean data-only bug fix with 0 Critical across all four reviewers, all automatable ACs green, zero architectural drift, and main's test.yml green. The user commits the 5-file change set, then post-merge runs `npx supabase db push --linked` and manually verifies Bobby/Charles render their email in Users & access. The only outstanding item — the stale `auth.ts:468-470` comment — is a documented spec-084 follow-up, not a ship-blocker.
payload_paths:
  - specs/083/reviews/release-proposal.md
