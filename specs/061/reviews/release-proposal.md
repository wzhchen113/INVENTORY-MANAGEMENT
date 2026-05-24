# Release proposal — spec 061 (staff app EOD per-user JWT + imr-staff scaffold)

## Verdict
verdict: SHIP_READY
rationale: All 4 reviewers cleared; the single Critical (test-engineer C3 smoke non-idempotency) was fixed in-band — smoke now derives a unique historical date from CLIENT_UUID, passes 3 consecutive runs, leaving 0 remaining Critical across the panel.

## Findings summary

- **code-reviewer**: 0 Critical, 4 Should-fix, 5 Nit. Top issues: dead `client_c` fixture UUID in pgTAP (decl with no assertion); label-vs-execution-order mismatch on assertion (10); no positive read-assertion for brand-shared tables (assertion (9) is the negative complement); deprecation smoke loop sends no `apikey`/`Authorization` header (cosmetic for `verify_jwt = false`).
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 3 Low (all informational). Explicit SHIP_READY recommendation. All 10 attack vectors verified closed: cross-brand write hole, identity spoofing, GRANT swap correctness, security-definer-without-membership, deprecated-edge-function info disclosure, cross-store SELECT exposure, realtime scope, OWASP top-10 sweep, shell-smoke token hygiene, imr-staff scaffold secret hygiene.
- **test-engineer**: 1 Critical (C3 smoke non-idempotent — **FIXED IN-BAND**, 3 consecutive runs now pass), 1 Should-fix (assertion (4) doesn't pass adversarial `p_submitted_by`), 2 Nits (both already fixed in-band: A2 + A4 prose now reflect architect §0 ruling, `brand_inventory_items` reference replaced with `recipes`). Acceptance criteria: 12 PASS, 0 FAIL after the in-band fix, 8 deferred-to-spec-062 (B3–B10 frontend implementation ACs).
- **backend-architect**: 0 Critical, 2 Should-fix, 4 Minor. Explicit SHIP_READY recommendation. All design points verified — §2 RPC body, §4 410 deprecations, §8 pgTAP (with justified 11th assertion), §9 smoke, §B1/§B2/§B10 imr-staff scaffold, Q3 NetInfo choice, §11 risk #1 cross-brand write hole (gate + test both land). Withdrew finding #3 on second pass.

## Recommended next steps (ordered)

1. **Commit and push** the spec 061 deliverables. Implementation matches design with zero drift; reviewers unanimous on ship-readiness after the in-band C3 fix.
2. **Open spec 062** — staff EOD count screen in the new `imr-staff` repo. B3–B10 ACs deferred from this spec are the natural next build target. Frontend implementer will hit the contract pinned at §7 (a) of spec 061's design doc (PostgREST returns HTTP 200 with `conflict` body, not HTTP 409).
3. **(optional, non-blocking)** Follow-up cleanup spec for the pre-existing `auth_can_see_store_brand_scope.test.sql` FK-cascade failure (independent of 061; baseline-level brittleness in the test's `delete from profiles` step that hits `eod_submissions_submitted_by_fkey`).
4. **(optional, non-blocking) Should-fix consolidation** — none blocking; defer to a low-priority hygiene spec:
   - **code-reviewer** SF1: remove dead `v_client_c`/`test.client_c` fixture from pgTAP OR add the conflict-different-client_uuid assertion it implies.
   - **code-reviewer** SF2: rename pre-role-switch assertion to `(0)` or move to end as `(11)` to align label with execution order.
   - **code-reviewer** SF3: add positive `select count(*) > 0 from public.recipes` assertion under staff role to complement the negative INSERT assertion.
   - **code-reviewer** SF4: add `-H "apikey: ${SUPABASE_ANON_KEY}"` to deprecation smoke loop for robustness if a future `verify_jwt = true` flip ever happens.
   - **test-engineer** SF: stronger assertion (4) — pass adversarial `p_submitted_by = 'attacker-uuid'`, assert audit log does NOT contain it.
   - **architect** SF1: add a cleanup step at smoke-staff-eod.sh tail that DELETEs the rows it just created, preventing FK-cascade contamination of pgTAP runs against a dirty DB.
   - **architect** SF2: add `select isnt((select id from profiles where id = '22222222-…'::uuid), null, 'manager seed user exists')` as a pre-assertion to fail loud if the manager seed user uuid ever changes.

## Out of scope for this review

- **B3–B10 (staff EOD screen, auth flow, offline queue, etc.)** — spec 061 explicitly scoped these as "the contract the staff-frontend must hit"; implementation deferred to spec 062 in the new `imr-staff` repo. The scaffold reviewed by this panel contains zero screens/flows beyond a placeholder `App.tsx`.
- **Pre-existing `auth_can_see_store_brand_scope.test.sql` failure** — confirmed by test-engineer to exist on baseline before any spec 061 changes (FK violation: `eod_submissions_submitted_by_fkey`). Belongs in a separate cleanup spec.
- **Removal of `STAFF_SERVICE_TOKEN` env var from deploy environment** — architect §4 / security-auditor §5 both flag this as "operationally harmless once the functions stop reading it; remove in a follow-up cleanup spec." Order matters: readers were removed first (this spec); env-var cleanup is later.
- **CLAUDE.md absolute-vs-relative path convention in imr-staff** — architect Minor #6 flags the inconsistency between CLAUDE.md (absolute) and README.md (relative). Cosmetic; pick one in a future imr-staff hygiene pass.
- **The imr-staff repo's own single initial commit (`481b561`)** is structurally outside this reviewer pipeline's audit scope — the 4 reviewers above audited the scaffold contents only. The actual EOD screen is a spec 062 deliverable.

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 remaining Critical across 4 reviewers (1 was fixed in-band before this synthesis), unanimous ship recommendation from security-auditor and backend-architect, all acceptance criteria PASS after in-band fix. Recommend commit + push, then open spec 062 for the staff EOD screen.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061/reviews/release-proposal.md
