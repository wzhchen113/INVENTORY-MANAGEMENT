# Spec 168: release proposal

Release coordinator, 2026-10-21. Baseline `227436c`. Inputs: [specs/168-auth-email-hook-followups.md](../../168-auth-email-hook-followups.md) and the four reviewer files in this directory (code-reviewer, security-auditor, test-engineer, backend-architect). All four were read in full. Main Claude supplied one fact that no reviewer file contains: an independent recompute of the 227436c core-block sha256, which is recorded under architect m4 below.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer raised a Critical, High or Medium, and every acceptance criterion passes. However, there is one Should-fix (an S10 precondition that can pass for the wrong reason) and one cheap security Low. Each is a few lines of shell, so they should land before the owner commits. A full review round is not needed.

If the owner prefers to commit as-is, the hard rules do not block it: there is no Critical, and nothing in this spec deploys. In that case, carry Fixes 1 and 2 as the first follow-up.

## Findings summary

- **code-reviewer:** 0 Critical, 1 Should-fix, 15 nits.
  - **S1 (Should-fix), `scripts/smoke-send-email-hook.sh:561-570`.** `EDGE_FROM` is read via `docker exec … printenv SEND_EMAIL_FROM 2>/dev/null` and never checked. If it is empty, Mailpit returns 400 because of the empty From, not the To. The precondition then prints `PASS … rejects 'not-an-address'` for the wrong reason.
  - Nits worth noting: a duplicate `mp_clear` (`:564`/`:571`), a duplicate `PASS Mailpit cleared` label (`:572`), the "history not why" wording of the `deliver()` comment (`index.ts:603-604`), the undocumented `""` sentinel in `e instanceof DOMException ? e.name : ""` (`index.ts:617`), the undated item 5 comment (`index.ts:51-53`), and a misplaced comment in the probe (`:60-62`).
  - The core-block and test nits are preferences (see "Not recommended").
  - The reviewer had no shell. They relied on the parity and golden tests for byte equality.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low.
  - **L1 (Low), `scripts/probe-auth-email-hook.sh:64,78-80,99`.** Suppose `SECRET` or `KEY_HEX` is already exported in the owner's shell. Bash keeps the export attribute when the variable is reassigned. So the raw secret would reach the `openssl`/`od`/`tr` decode children, and the decoded key would reach `node`'s environment. That contradicts the new "Key handling" header.
    - This is not a regression; the baseline had the same exposure. Spec 168 does not newly add key material to any child environment.
    - Fix: one line, `unset SECRET KEY_HEX` before line 64.
  - **L2 (Low), residual and unchanged from spec 166.** The verifier still loads from esm.sh with no integrity lock on esm.sh's build output (`index.ts:54`). The real fix is the inline WebCrypto verifier, which needs its own spec.
  - **Verified clean by the auditor:**
    - Gate order and fail-closed delivery
    - No new log fields
    - The two core blocks are byte-identical (awk plus `diff`)
    - No key material on any argv
    - Non-decodable secrets are still refused
    - The golden fixture holds no real secrets
    - The item 5 fallback is sound
- **test-engineer:** every acceptance criterion and Done criterion passes, with 0 FAIL and 0 NOT TESTED.
  - The reviewer ran the following one at a time:
    - full `npx jest`: 233 suites, 2802 tests
    - `npm run typecheck` and `npm run typecheck:test`
    - `smoke-send-email-hook.sh`: ALL ARMS PASSED; the only SKIP is S8
    - `npm run test:smoke`: all 5 scripts green
    - the `S9_AUTOCONFIRM_OVERRIDE=false` run
    - the probe REFUSE, 401 and 200 paths
  - The reviewer independently re-verified the golden: the 227436c baseline matches the committed fixture on all 52 cases with `deepStrictEqual`.
  - Two sub-points rest on the developer's evidence alone: 6a (the node argv/env shim) and 6d (the HMAC test vector). The reviewer's own end-to-end 200 on a node-signed probe backs 6d indirectly.
  - Residual gaps, accepted in the design (§8 risk 3): `deliver()`'s timeout and throw branches have no live proof, and the Deno handler is not type-checked anywhere.
- **backend-architect (post-impl):** 0 Critical, 0 Should-fix, 4 Minor. The implementation matches the design contract, and developer deviations 3(a), 3(b), 3(c) and both item 6 deviations are accepted.
  - **m1:** the same finding as code-reviewer S1. The architect confirms there is no overall false pass, because the 500 and log-status assertions would still FAIL. Only the precondition's diagnostic misleads.
  - **m2:** the `TO_NORM` `tr`/`sed` children (`probe:56`) inherit an exported `HOOK_SECRET` before the early unset at `:65`. This is pre-existing, and the architect asks that it be surfaced as a question only, not added to scope.
  - **m3:** the golden's app-shaped `site_url` (the live prod branch) is exercised only for `magiclink`/`signup`. This exceeds the spec minimum, and no action is needed for spec 168.
  - **m4: CLOSED.** Main Claude recomputed the 227436c core-block sha256 from `git show 227436c:src/lib/authEmailHook.ts`. It equals the test constant `8a27aa0f7612d4191a4aa1da457d998fbf6e0e5e59860c87ce7cf4e6c8e414ec`. Test-engineer also reports a matching recompute (`8a27aa0f…`).
- **CI:** no gate run exists for these commits. HEAD `227436c` (spec 166) and `afe181e` (spec 165) are unpushed, and spec 168 is staged, not committed. The CLAUDE.md CI-green rule applies after the push (see step 6).

## Recommended next steps (ordered)

### A. Cheap pre-commit fixes (shell and comments only; no core-block edit, no re-review)

1. **Fix 1: S10 precondition guard (Should-fix; code-reviewer S1 = architect m1).** This is first because it is the only finding above Low, and it is the arm whose whole job is to prove a specific To is rejected.
   - In `scripts/smoke-send-email-hook.sh`, after line 561, make an empty `EDGE_FROM` the **first** branch of the existing `if/elif/else` chain. That way the rest of S10 is skipped, the same way the other precondition FAILs skip it. For example: `if [[ -z "$EDGE_FROM" ]]; then fail "precondition: could not read SEND_EMAIL_FROM from ${EDGE_CONTAINER}"; elif …`. Skip the probe `curl` in that case, or let it run and ignore the result.
   - Optional, stronger: capture the probe response body instead of `-o /dev/null`, and in the PASS branch require `.Error` to contain `not-an-address`. This ties the 400 to the To and not to some other field. The code-reviewer offered it as an alternative or an addition; the empty guard alone satisfies both reviewers.
   - Fold in the two related nits while editing these lines:
     - drop one of the back-to-back `mp_clear` calls (`:564` / `:571`)
     - relabel `:572` to `PASS Mailpit cleared before S10`
2. **Fix 2: unset pre-exported variables in the probe (security Low L1).** In `scripts/probe-auth-email-hook.sh`, add `unset SECRET KEY_HEX` immediately before line 64 (`SECRET="${HOOK_SECRET:-}"`). The later assignments then create non-exported shell variables, which makes the header's "Key handling" claim true when the owner's shell already exported either name. This needs no behaviour change and does not affect the `--help` range (`sed -n '2,34p'`, which ends above the edit).
   - **Owner question (architect m2; not recommended as default scope):** `HOOK_SECRET` could also be kept out of the `TO_NORM` `tr`/`sed` children (`:56`). To do that, move the env copy `SECRET="${HOOK_SECRET:-}"; unset HOOK_SECRET`, together with the `unset SECRET KEY_HEX` from Fix 2, up to before argument parsing.
     - The TTY prompt branch must stay where it is, after the `command -v node` check, so the owner is never prompted for a secret that can't be used.
     - The exposure is pre-existing and environment-only, not argv. Take it only if the owner says yes.
3. **Optional comment-only nits (batch only if convenient; all outside the parity block):**
   - `index.ts:603-604`: restate the `deliver()` comment as an invariant: "a throw here is an internal error (500 `internal error`), not a transport failure, so it must not be classified."
   - `index.ts:617`: add a one-line why-comment for the `""` sentinel: "a plain Error that happens to be named TimeoutError must stay `transport`."
   - `index.ts:51-53`: date the item 5 rationale ("as of 2026-10-21; see spec 168 §5").
   - `probe-auth-email-hook.sh:60-62`: add a blank line so the "Checked before the secret is read…" comment visibly belongs to the `command -v node` line.
4. **Re-verify after A1-A3. Run these one at a time, and not while the spec 167 session runs any Mailpit smoke:**
   - `bash scripts/smoke-send-email-hook.sh` must print ALL ARMS PASSED. This covers Fix 1 and proves that the `index.ts` comment edits still boot (S2/S6/S10).
   - Probe, against `http://127.0.0.1:54321/functions/v1/auth-email-hook`:
     - the env path gives 200 `{}` and 1 "Account notification" in Mailpit
     - `v1,whsec_` + 32×`=` gives `REFUSE … did not base64-decode`, exit 2
     - optionally, run with `export SECRET=pre KEY_HEX=pre` and the node shim, and confirm node's environment holds no `KEY_HEX`
   - `--help` still prints exactly the header.
   - jest and the typechecks are not affected by A1-A3, since no `src/` file is touched. Re-run the full `npx jest` only if a core-block nit was taken despite "Not recommended" below.
   - Record the fixes and the re-runs in the spec's implementation notes. `git add` only the edited spec 168 paths.

### B. Commit (the owner commits; main Claude does not)

5. **Commit exactly these paths for spec 168:**
   - **Already staged:**
     - `scripts/probe-auth-email-hook.sh`
     - `scripts/smoke-send-email-hook.sh`
     - `specs/168-auth-email-hook-followups.md`
     - `src/lib/authEmailHook.golden.json`
     - `src/lib/authEmailHook.golden.test.ts`
     - `src/lib/authEmailHook.test.ts`
     - `src/lib/authEmailHook.ts`
     - `supabase/functions/auth-email-hook/index.ts`
     - `tests/README.md`
   - **Currently untracked; `git add` them first, matching the convention spec 167's staged `reviews/` follows:**
     - `specs/168-auth-email-hook-followups/reviews/backend-architect.md`
     - `specs/168-auth-email-hook-followups/reviews/code-reviewer.md`
     - `specs/168-auth-email-hook-followups/reviews/security-auditor.md`
     - `specs/168-auth-email-hook-followups/reviews/test-engineer.md`
     - `specs/168-auth-email-hook-followups/reviews/release-proposal.md`
   - **NOT in this commit. These are spec 167's, staged by the other session:**
     - `specs/167-store-user-audit-trail.md` and its `reviews/` (5 files)
     - `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
     - `src/screens/cmd/sections/AuditLogSection.tsx` and `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx`
     - `src/screens/cmd/sections/phone/PhoneAuditLog.tsx` and `src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx`
     - `src/types/index.ts`, `src/utils/enumLabels.test.ts`, `src/utils/formatAuditAction.ts`
     - `supabase/functions/delete-user/index.ts`, `supabase/functions/manage-store-user/index.ts`
     - `scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`
   - **How to commit:** because the index is shared, a pathspec commit is the safest way to keep spec 167 out: `git commit -- <the 14 paths above>`. It commits only those paths and leaves spec 167's entries staged.
     - Note that a pathspec commit takes the **working-tree** content of each path. The security auditor found no working-tree drift on these paths. Recheck with `git diff --stat -- <paths>` just before committing.
     - Before committing, also confirm with `git diff --cached tests/README.md` that `tests/README.md` contains only the spec 168 Track 3 lines. Spec 167 does not list it, but the index is shared.
6. **After the push** (which will carry `afe181e`, `227436c` and the spec 168 commit, plus spec 167 if it lands first):
   - Confirm the latest `main` run of **both** gates is green: `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. Check `e2e.yml` manually too, per the pending gate promotion.
   - Spec 168 has no migration. However, if `afe181e` or `227436c` carries a migration that has not been applied to prod, `db-migrations-applied` will go red on this push. That would not be a spec 168 problem, but it must be surfaced.
   - If either gate is red or still in progress, surface the run URL and wait for the owner.
7. **No prod deploy in this spec.** The refactored function and the node-based probe reach prod only through the owner's spec 166 runbook steps 4, 5 and 5b. Step 5b's probe run is the prod acceptance for item 6.

### Not recommended for the pre-commit batch (leave as is, or a later spec)
- **Do not touch the golden matrix or fixture.** For example, do not drop the duplicate `A.recovery` / `C.recovery_redirect_no_query` case (code-reviewer nit). The fixture is baseline-locked: the name-order check would fail, and the capture guard makes recapturing against post-refactor code mechanically impossible.
- **Core-block nits:** a `null = unlinkable` comment on `renderMail` (`authEmailHook.ts:357`), a `renderBody` `LinkAndCode` parameter, and folding the `linkOnly` ternaries. Each one means editing both copies identically and re-running parity, golden and full jest. The `renderBody` signature is architect-fixed, and the reviewer itself would not fold `linkOnly`. If the owner wants the one-line `renderMail` comment, edit the canonical copy, splice it into the Deno copy, and run full `npx jest` plus `npm run typecheck:test`.
- **Test-only nits** in `authEmailHook.test.ts`: the `data()` helper's `email_action_type`, and splitting the three-behaviour `renderBody` `it`. They are harmless and can wait.
- **`probe:80` `unset SECRET HOOK_SECRET`:** now a partial no-op, kept by spec requirement. No action.

## Out of scope for this review
- **Inline Standard Webhooks verifier** (security L2; architect design §5 "facts for a future spec"): WebCrypto HMAC, a constant-time compare and ±5 min tolerance, parity-tested like the core. It removes the esm.sh dependency from the auth path. It needs its own spec and a security review.
- **Revisiting `npm:` + `deno.lock`** once Supabase docs confirm that serve and deploy honour a per-function lock. The facts are recorded in design §5: no `.gitignore` rule excludes `deno.lock`, and `deno_version = 2`.
- **`deliver()` timeout and throw branches have no live proof, and the Deno handler is not type-checked** (design §8 risks 2-3). A live proof needs a hanging transport, which is a config change. A future spec could add a Deno typecheck step.
- **Architect m3:** add app-shaped `site_url` golden coverage for `email` / `invite` / `email_change` / unknown types. This needs a fresh baseline capture, so it belongs with the next spec that edits the "rest" branch.
- **Architect m2,** if the owner declines it in step 2.
- **The pre-existing edge log line** `error in user worker connection: error writing a body to connection` after S5's 413 arm. The developer and test-engineer both observed it, and it is not caused by spec 168. Investigate separately if it matters.
- The spec's explicit out-of-scope list: a send cap in the hook, an env allowlist of link origins, `SEND_EMAIL_VERIFY_BASE`, a live non-secure `email_change` proof, local auth config changes, migrating other functions to `npm:`, any prod action, and the `app.json` slug.
