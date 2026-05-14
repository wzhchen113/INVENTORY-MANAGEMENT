## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; the change is a verified strict-superset role-band fix that closes the spec-026 edge-side parity gap, with all 17/17 ACs either PASS or explicitly designated manual-gate, and no findings rise to blocking severity.

## Findings summary
- **code-reviewer:** 0 Critical, 4 Should-fix, 4 Nits. Top issues: misleading "non-zero-exit-on-first-failure" header comment in `scripts/smoke-edge-roles.sh` (script actually accumulates failures and exits at end — same as sibling `smoke-edge.sh`); summary line missing `✓`/`✗` Unicode prefix used by siblings; `tests/README.md` Track 3 section not updated to list the new script; token extraction uses `python3` instead of `jq` (siblings use `jq`).
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 3 Low. Strict-superset verified by 9-row truth table (admin/master/super_admin via JWT or profiles fallback all reach handler; user/manager/anon all still rejected). The one Medium: `scripts/smoke-edge-roles.sh` lacks a refuse-to-run-against-non-local guard despite being the repo's only state-mutating smoke (promotes a profile to `super_admin`). Three Lows are defense-in-depth/no-op explainers (SIGKILL un-trappable, committed local-stable `ADMIN_PASSWORD=password`, committed publishable anon key). `npm audit` baseline unchanged (no new deps).
- **test-engineer:** 16/17 ACs PASS, 1 NOT TESTED. The NOT TESTED entry is **CT6** — the manual super-admin Cmd-UI invite click-through gate; explicitly designated manual-only in the spec, so this is by-design and not a coverage gap. Cross-track gates all green: `tsc --noEmit` 0, `typecheck:test` 0, `npm test -- --ci` 17/17, `npm run test:db` 14/14, `bash scripts/smoke-edge-roles.sh` 4/4, chained `npm run test:smoke` PASS. One should-fix overlaps with code-reviewer S1 (header-comment wording); one nit on Arm 1 accepting HTTP 204 in addition to the spec-specified 200.
- **backend-architect:** 0 Critical, 0 Should-fix, 2 Nits. Implementation matches the design verbatim across all four tracks. DB-side `auth_is_privileged()` (spec 026) and edge-side `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` (spec 027) are now consistent for every caller-role × auth-shape combination. Both nits are observational (header trap-recovery SQL duplicated for human-readability, inline comments cite different historical specs — both correct in context).

## Recommended next steps (ordered)

This is SHIP_READY. Recommended sequence:

1. **Pre-commit manual gate (CT6)** — On the local stack, log in as a real super-admin session in Cmd UI's Users section, click "Invite User" for a test address, and confirm:
   - a row appears in `public.invitations` (visible in Supabase Studio at http://127.0.0.1:54323),
   - the docker logs of `supabase_edge_runtime_imr-inventory` show a 200 from `send-invite-email`,
   - no console error in the browser.
   This is the end-to-end confirmation that the DB-side broadening (spec 026) and the edge-side broadening (spec 027) are aligned in practice, not just in the truth table. Per spec design, no automation covers this gate.

2. **Commit and merge.** The five-file diff is mechanical and faithful to the design. Verification gates are already green.

3. **Post-merge deploy (REQUIRED to land the fix in prod)** — User runs:
   ```
   supabase functions deploy send-invite-email
   ```
   Until this command is executed against the production project, the bug remains live for super-admins clicking "Invite User" in prod. The source change in this PR is necessary but not sufficient; edge function deployment is not gated by CI or any automated test in this repo.

### Optional fast-follows (do NOT block ship)

Deduped across reviewers; each is non-blocking and can be a one-line follow-up commit or rolled into the next spec touching smoke scripts:

1. **Fix the misleading header comment** in `scripts/smoke-edge-roles.sh:9-10` — replace "non-zero-exit-on-first-failure" with "non-zero-exit-on-any-failure (runs all arms, accumulator pattern)". Flagged by both code-reviewer (S1) and test-engineer. The same wording rot also exists in `smoke-edge.sh`'s header; correct both for consistency.

2. **Add the local-only guard** to `scripts/smoke-edge-roles.sh` near line 56 (security-auditor M1). Defense-in-depth so this state-mutating smoke can never be pointed at a remote stack by an environment-variable misconfiguration:
   ```
   case "$SUPABASE_URL" in
     http://127.0.0.1:*|http://localhost:*) ;;
     *) printf 'refusing to run against non-local SUPABASE_URL=%s\n' "$SUPABASE_URL" >&2; exit 2 ;;
   esac
   ```
   Recommend folding into this PR if a follow-up commit is acceptable; otherwise file as a next spec covering "harden state-mutating smokes". The current docker-exec failure path already SKIPs cleanly against remote stacks, so the practical risk today is low — this is hygiene for future state-mutating smokes that may not have that natural failure mode.

3. **Switch `python3` token extraction to `jq`** (code-reviewer S4) at `scripts/smoke-edge-roles.sh:141` and `:205`. Siblings already require `jq`; introducing `python3` as a primary path on this one script is undeclared-runtime-dep drift.

4. **Add a bullet for `smoke-edge-roles.sh`** to `tests/README.md` Track 3 section (code-reviewer S3). Strictly additive; the new script is currently invisible to a developer reading the canonical test reference.

5. **Add `✓`/`✗` Unicode prefix** to summary lines in `scripts/smoke-edge-roles.sh:239-241` (code-reviewer S2) for visual consistency with `smoke-edge.sh` and `smoke-rpc.sh`.

The four code-reviewer nits and two backend-architect nits are below the threshold for a follow-up commit; record-only.

## Context: this spec completes spec-026's parity work

Spec 026 broadened `invitations` RLS via the DB-side helper `public.auth_is_privileged()` (admin OR super_admin); spec 027 mirrors that broadening on the edge-function side by adding `super_admin` to `ADMIN_ROLES` in `send-invite-email`. The two layers are now consistent — for every caller shape the architect's table enumerates, the DB and the edge function agree on accept/reject. The "tenth instance" risk (a new edge function shipping without `super_admin` in its `ADMIN_ROLES` set) is now mitigated by the Track D documentation in CLAUDE.md and `.claude/agents/security-auditor.md`, which give future contributors and future audits an explicit checklist anchor.

## Out of scope for this review
- **`eod-reminder-cron/index.ts:192`** — `.in('role', ['admin', 'master'])` is recipient selection (who gets pinged about pending EOD submissions), not a caller privilege gate. Whether super-admins should also be on the broadcast list is a product decision and is correctly deferred per spec §"Out of scope" §6 and confirmed by architect §3.
- **CI-enforcement of `npm run test:smoke`** — Currently a manual-run gate per spec 022. Wiring the new script (or any smoke arm) into a CI workflow is a future-spec concern. Test-engineer notes Arms 1-2 of the new script could run against a staging URL without a local stack if a future CI spec wants to claim partial automated coverage.
- **Backfilling regression tests for `delete-user`** and other already-correct functions — spec 023 territory, not this spec.
- **Real-Resend-API smoke coverage** — spec deliberately does not send a real email; smoke-tests the gate only.
- **Inline `ADMIN_ROLES` duplication across `delete-user` and `send-invite-email`** — architect explicitly accepted as cheaper than a shared `_shared/roles.ts` module given current redeploy semantics. Revisit if a third instance lands.
- **`npm audit` baseline (1 High xmldom + 5 Moderate + 5 Low transitive)** — predates this spec; surfaced by security-auditor for completeness only.

## Handoff
next_agent: NONE
prompt: SHIP_READY. Zero Critical across all four reviewers. One pre-commit manual gate (CT6 super-admin Cmd-UI invite click-through) and one mandatory post-merge step (`supabase functions deploy send-invite-email`) flagged.
payload_paths:
  - specs/027-edge-fn-super-admin-parity/reviews/release-proposal.md
