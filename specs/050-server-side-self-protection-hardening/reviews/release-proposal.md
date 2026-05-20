# Release proposal — Spec 050 (Server-side self-protection hardening)

## Verdict
verdict: SHIP_READY
rationale: All four reviewers green at the blocking tier (0 Critical / 0 High across code, security, architect post-impl, test); the lone Should-fix is a four-character stale plan-count comment with zero behavior impact, and the lone Low/Minor finding (the `'target profile not found'` string) is a non-finding once you read the architect's authoritative code sketch in the spec — implementation matches design.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 4 Nits. Should-fix is a stale `plan(4)` header comment at [supabase/tests/demote_self_guard.test.sql:19](supabase/tests/demote_self_guard.test.sql) where the file actually calls `plan(6)` (Arm (ii) contributes 3 assertions: `lives_ok` + 2 × `is()`). Nits: a `:2757`-vs-`:2761` line-number reference in the same test header, an over-commented JSDoc on the new TS wrapper, a tolerable JSON-spacing fragility in the smoke arm's grep, and a `DECLARE`-block `auth.uid()` call that is correct and intentional. Code-reviewer's "Drift correction" section explicitly retracts the `'target profile not found'` flag: the architect's code sketch in the spec (line 608) already uses that string, so implementation matches authoritative design.
- security-auditor: 0 Critical / 0 High / 0 Medium / 1 Low. The Low is the same `'target profile not found'` string — auditor confirms no information leak (target existence is observable to privileged callers via `profiles` SELECT under RLS regardless) and no test asserts on this string anywhere. All six probe results PASS: null-target refuses cleanly at the not-found arm with no side effect, SECURITY DEFINER gate fires before any UPDATE, refusal strings byte-stable on the asserted paths, search_path explicitly qualified and defense-in-depth ordered, GRANT lockdown tighter than `assert_not_last_of_role`, and CLAUDE.md / security-auditor.md bullets strictly additive.
- backend-architect (post-impl drift review): 0 Critical, 0 Should-fix, 1 Minor (same `'target profile not found'` string). Architect's verdict: "Not a stability violation in the sense the [drift] table meant; the contract is that **asserted strings** don't shift" — and the not-found arm has no pgTAP/smoke/client assertion against it. Architect also confirms `plan(6)` arithmetic is correct (Arm (ii)'s state-after-UPDATE assertions are the right shape for the AC), smoke Arm 7's post-promotion ordering strengthens rather than weakens the proof, and the `docker exec` hot-apply replays cleanly on `supabase start` for the next contributor.
- test-engineer: 7/7 ACs PASS (A through G). Full suite green: `npm run typecheck:test` exit 0, `npm test -- --ci` 17 suites / 182 tests PASS, `npm run test:db` 30/30 PASS including the new `demote_self_guard.test.sql` with 6 assertions. Smoke not re-run (local stack dependency) but Arm 7 logic inspected and sound. Test-engineer flagged the `'target profile not found'` string for the architect's review but explicitly classified it non-blocking; that recommendation has now been answered (architect: acceptable, no fix needed).

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Apply the one-line plan-count comment fix inline pre-commit** (optional cleanup; keeps the commit hygiene-clean). Exact edit:
   - [supabase/tests/demote_self_guard.test.sql:19](supabase/tests/demote_self_guard.test.sql) — change the header-comment phrase `plan(4)` to `plan(6)`. No assertion shift, no test behavior change; just realigns the top-of-file summary with the actual `select plan(6);` at line 57 that the assertion-arithmetic block immediately above already correctly documents.

2. **Commit and deploy.** The migration `20260520000000_demote_profile_to_user_rpc.sql` is dev-applied via `docker exec` and is replay-clean (`create or replace function` body, idempotent on `supabase start`). Production deploy proceeds under the standard migration path. Additive surface: one new SECURITY DEFINER RPC plus tightened GRANT/REVOKE; the client wrapper at [src/lib/db.ts:2761-2766](src/lib/db.ts) swaps a direct PostgREST UPDATE to `supabase.rpc('demote_profile_to_user', ...)` while preserving the outer `Promise<string>` signature, so [src/store/useStore.ts:863-895](src/store/useStore.ts) and [src/screens/cmd/sections/BrandsSection.tsx:845-855](src/screens/cmd/sections/BrandsSection.tsx) are unchanged.

3. **(Optional, not blocking ship)** Run the local smoke once with `npm run test:smoke` against a booted stack to re-verify Arm 7 end-to-end. Test-engineer inspected the logic but did not re-execute. The pgTAP suite already exercises the same RPC entry-point via `throws_ok`/`lives_ok`, so this is belt-and-braces.

4. **(Optional follow-ups, separate specs)** Items flagged for tracking but not blocking this ship:
   - **Editorial sync of the spec's prose summary**: the spec's design-prose section says `'profile not found'` while the spec's authoritative code sketch (line 608) and the deployed code both use `'target profile not found'`. Tighten the prose so a future reader doesn't re-trip the drift flag. Specs are intentionally append-only post-SHIP, so this can wait for the next spec touching this surface or a dedicated doc spec.
   - **If a future spec adds a not-found arm to pgTAP**, prefer asserting on `'target profile not found'` to lock the string going forward (architect's recommendation).
   - **Code-reviewer's 4 Nits**: `:2757`→`:2761` line-number reference in the pgTAP header comment; trimming the over-commented TS-wrapper JSDoc to just the WHY paragraph; tightening the smoke Arm 7 grep to tolerate alternative JSON spacing if PostgREST version ever changes; no change needed for the `DECLARE`-block `auth.uid()` (the reviewer explicitly classed it correct and idiomatic). All cosmetic.

## Out of scope for this review
- **Broader role-hierarchy refactor** — Spec 050 only hardens the demote and delete paths against self-target. Promote-self, super-admin self-demote-to-master, and any future privilege-elevation paths each need their own `caller.id != target.id` decision (or explicit waiver). The new CLAUDE.md bullet at line 64 documents the convention so future specs make this decision deliberately.
- **`P0002` not-found arm coverage in pgTAP** — Architect noted that no test currently exercises the not-found branch. Adding the arm would lock the `'target profile not found'` string and close the residual drift surface. Separate spec.
- **`P0001` vs `42501` SQLSTATE convention sweep** — Carried over from Spec 049's release proposal; still a project-wide pending decision about which errcode class destructive RPCs should use. Out of scope for Spec 050.
- **`audit_log` instrumentation of the demote path** — The demote RPC does not currently emit an audit row. If audit coverage for privileged role-change operations becomes a requirement, that is a separate cross-cutting spec (Spec 049 raised the same question for `copy_brand_catalog`).
- **`app.json` slug change** — Stays `towson-inventory` per CLAUDE.md "DO NOT AUTO-FIX".

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 Critical / 0 High across all four reviewers; 1 cosmetic Should-fix (stale `plan(4)` header comment → `plan(6)`) recommended inline pre-commit; full suite green (typecheck clean, 182/182 jest, 30/30 pgTAP)
payload_paths:
  - specs/050-server-side-self-protection-hardening/reviews/release-proposal.md
