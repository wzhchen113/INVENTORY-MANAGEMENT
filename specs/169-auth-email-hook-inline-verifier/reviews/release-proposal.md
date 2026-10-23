# Release proposal: spec 169 (auth-email-hook inline Standard Webhooks verifier)

Release-coordinator, 2026-10-22. Inputs: the spec (design, implementation notes, files changed) and the four reviewer files in this directory, read in full. Facts supplied by main Claude are marked **[main Claude]**.

## Verdict
verdict: FIXES_NEEDED
rationale: Nobody flagged a Critical, High or Medium, and the security differential fuzz found 0 mismatches against the library. Two things still block shipping. First, the code-reviewer's 5 comment/naming Should-fixes edit the parity-locked core block, so they are cheapest to land before the commit. Second, SHIP_READY also depends on the first Node 20 `test.yml` run (architect SF1) and on both CLAUDE.md CI gates being green on `main`. That proof can only come after the push.

## Findings summary

- **code-reviewer:** 0 Critical, 5 Should-fix, 11 nits (1 marked out of scope). No correctness or policy defects. The block matches the §3 pseudocode, keeps the `null` sentinel, puts every `await` inside a `try`, takes the clock as a parameter, contains no banned tokens, and confines the handler change to step 4. All 5 Should-fixes are about explaining things at the line where they happen:
  - a why-comment on `parseInt`
  - a why-comment on the lax comma and empty-candidate handling
  - a why-comment on the `JSON.parse` 401 rule (it currently looks like dead code)
  - restructure the run-on `verifyWebhook` doc comment
  - name the magic `8.64e12` (for example `MAX_DATE_SECONDS`)
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 1 Low. Every checklist item passed, including:
  - the `""` fail-open trap is closed
  - the compare is constant-time with any-match
  - the inclusive ±300 s bounds hold, and so do the `parseInt` canonical-text rule and the clock guard
  - rotation works, and signed non-JSON gets 401
  - every throw becomes `false`
  - key-decode equivalence holds (20,000 cases, 0 byte differences)
  - no secrets are logged, the gate order is unchanged, and the dependency is removed

  Differential fuzz against a transcription of `standardwebhooks@1.0.0` found **0 mismatches** in either direction: 40k adversarial cases, 200k mixed, and 200k accept-dense with 25,539 accepts. The Low: the S1 static guard misses an `export … from "https://…"` re-export and a dynamic `import (` with whitespace before the parenthesis. This is a hardening gap only; no such line exists today.
- **test-engineer:** 29 PASS, 0 FAIL, 0 NOT TESTED across AC §1-§6 and the Done criteria.
  - Full `npx jest`: 234 suites, 2846 tests, all green.
  - `src/lib/authEmailHook*`: 4 suites, 187 tests, all green.
  - Both typechecks are clean.
  - `smoke-send-email-hook.sh` printed ALL ARMS PASSED (72 PASS, 0 FAIL, only S8 skipped). `test:smoke` is green.
  - The probe's env path gave 200 plus one mail; the wrong-secret path gave 401 plus the hint.

  Gaps:
  - AC §4.3 is proven on Node 24 only (Node 20 comes from CI).
  - AC3.3 relied on the smoke and the golden rather than a hunk-by-hunk diff. That gap is now closed by main Claude's 5-hunk diff (see the architect's M4 below).
- **backend-architect (post-impl):** No drift. 0 Critical, 1 Should-fix, 4 Minor. All 41 rows of the design matrix are present with no weakened expectations, and the oracle stays independent.
  - **SF1:** Node 20 proof of V0/V1 (the cross-realm `ArrayBuffer` hazard) is outstanding. **[main Claude]** Only Node 24 is installed locally, so this can only come from the first post-push `test.yml` run. It is carried below as a post-push gate, not a code fix.
  - **M1:** extra in-block comments. Accepted.
  - **M2:** no jest row for an explicit `undefined` header value. Optional.
  - **M3:** the inner D1 clock boundary is not pinned. Optional.
  - **M4: closed.** **[main Claude]** `git diff --cached HEAD -- supabase/functions/auth-email-hook/index.ts` shows exactly 5 hunks, matching the developer's claim (header, import note, block insert, `verifySignature` removal, step 4).

## Recommended next steps (ordered)

### A. Cheap pre-commit fixes (developer, then re-verify)

All of these are comment, naming or test-only changes. None changes behaviour.

**A1. Code-reviewer Should-fixes 1-5 (Should-fix, do first).** These edit the core block in `src/lib/authEmailHook.ts`:
1. Why-comment at `parseInt(msgTs, 10)`: library parity; the signed text uses the parsed integer, never the raw header.
2. Why-comment on the candidate loop: lax like the library, only `parts[0]` and `parts[1]` count, and a comma-less `v1` becomes a never-matching `""` candidate.
3. Inline why-comment at the post-match `JSON.parse`: the library JSON-parses the payload, so a signed non-JSON body gets 401, not 400. The result is discarded on purpose. Returning `false` at the first match is equivalent because parseability does not depend on the secret.
4. Restructure the `verifyWebhook` doc comment into a summary plus a bullet list of the replicated quirks (parseInt, lax commas, non-JSON → 401). State that any divergence from the library must be fail-closed.
5. Name `8.64e12` as an unexported constant next to `WEBHOOK_TOLERANCE_SECONDS` (for example `MAX_DATE_SECONDS`). Comment that it is the JS Date range in seconds, which keeps every accepted `ts` inside that range. The guard value must stay exactly `8.64e12 - WEBHOOK_TOLERANCE_SECONDS`.

Word traps for every new comment:
- **Parity (b):** no `export` in any form (for example "exported"), no `fetch(`, no `console.`, no `Deno.` (including at the end of a sentence), no placeholder domain.
- **S2 static scan, which also reads comments:** no `Date.now` and no `new Date(`. The natural way to explain item 5 ("new Date(ts*1000)") would turn S2 red. Write "the JS Date range" instead.
- **S2 bans:** no `subtle.verify` and no `require(`.

**A2. Nits worth batching in the same pass.**
- In the core block (A1 already forces a re-splice, so these cost nothing extra):
  - Make the "Standard Webhooks verification (spec 169)" comment read as a section header for the whole verifier group, not as the doc comment for `WEBHOOK_TOLERANCE_SECONDS`.
  - Rename the locals `h` to `lowered` and `c` to `candidate`.
- In `index.ts`, outside the block: step 4's comment says "±5 min" while the header and block say "±300 s". Make it "±300 s".
- In `src/lib/authEmailHook.verify.test.ts` (test-only; no re-splice):
  - Line 130 `bodyChars`: replace the literal invisible characters (NBSP, U+2028/2029, U+3000, U+2003) with `\u` escapes, so a whitespace-trim pass cannot silently change the test. This is the most valuable of the test nits.
  - Hoist `ALPHABET.split('')` and `idChars.split('')` out of the per-character loops.
  - Add a one-line comment above the first `expect({…, got}).toEqual({…, got: want})` (V1.5) explaining why the inputs appear on both sides.
  - Cite §2.6 in the V3.7 "D1" title, or describe the guard in words.
- Optional test-only rows, cheap to add now:
  - architect M2: an explicit `undefined` header value gives false
  - architect M3: clock `8.64e12 - 300` with a matching ts and a valid signature gives true
  - code-reviewer: `Webhook-Id` and `webhook-id` both present pins last-wins

**Not worth batching:**
- The early `return false` when `candidates` is empty. It reorders the "mandatory order" pseudocode that the security fuzz was run against, and it is not a correctness issue.
- Renaming `signWebhook` to `computeWebhookSignature`. It is a preference only, and it churns the export list, the test imports, the spec and all four reviews.

**A3. Security Low: harden the S1 import guard (test-only, in `src/lib/authEmailHook.verify.test.ts:411-425`).**
- Add an assertion that no non-comment line of `index.ts` matches `/\bfrom\s*['"]/`. This catches `export … from` and `import … from` with any scheme.
- Add an assertion that the source does not match `/\bimport\s*\(/`.
- **Do not** add the auditor's alternative bare `/['"]https?:\/\//` check as written. `index.ts:115` holds the runtime constant `"https://api.resend.com/emails"`, so it would turn S1 red. If an https check is wanted, anchor it to a module-specifier position.
- Confirm red-before-green in the scratchpad: plant `export * from "https://x"` in a copy and check that the new assertion fails. Do not plant it in the repo.

**A4. Re-verify after A1-A3, in this order:**
1. Re-splice the canonical block into `index.ts` mechanically with the scratchpad script, as in spec 168 §1.5 (no retyping). Then `diff` the two marker ranges; the result must be empty.
2. Run `npx jest src/lib/authEmailHook`. All 4 suites (parity, golden, test, verify) must be green, with the parity and golden tests unmodified. The golden sha256 must still be `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`.
3. Run the **full** `npx jest`, not a subset.
4. Run `npm run typecheck` and `npm run typecheck:test`. A1 item 5 adds a constant, so this is a real check.
5. Do the CLAUDE.md bind-mount check, then hot reload or `docker restart supabase_edge_runtime_imr-inventory`.
6. Run `bash scripts/smoke-send-email-hook.sh`. It must print ALL ARMS PASSED with only S8 skipped.
7. Run it strictly alone. Check with `ps` that no spec 167 smoke is running, because both use Mailpit.
8. Re-stage the same four spec 169 paths. Optionally, append a short "Review fixes" note to the spec's implementation notes.

**When A1-A3 need another security review.** They need none if the block diff against the reviewed version is limited to comments, the named constant and the two local renames. If anything else in `verifyWebhook` changes, send the block back to security-auditor before committing.

### B. Commit (owner)

The spec 169 commit is exactly these paths and nothing else:

```
src/lib/authEmailHook.ts
supabase/functions/auth-email-hook/index.ts
src/lib/authEmailHook.verify.test.ts
specs/169-auth-email-hook-inline-verifier.md
specs/169-auth-email-hook-inline-verifier/reviews/backend-architect.md
specs/169-auth-email-hook-inline-verifier/reviews/code-reviewer.md
specs/169-auth-email-hook-inline-verifier/reviews/security-auditor.md
specs/169-auth-email-hook-inline-verifier/reviews/test-engineer.md
specs/169-auth-email-hook-inline-verifier/reviews/release-proposal.md
```

1. The reviews directory is **untracked**, so it needs `git add specs/169-auth-email-hook-inline-verifier/reviews/` first. `git commit -- <path>` refuses untracked paths.
2. **[main Claude]** Spec 167 paths are staged in the same index by another session. Commit with an explicit pathspec, `git commit -m "…" -- <the 9 paths above>`, which commits only those paths and leaves spec 167 staged. Do not run a bare `git commit`, which would sweep spec 167 in.
3. Do not run `git add -A` or `git add specs/`. Either would pick up the untracked `specs/170-*`, which belongs to another session.
4. The pathspec form commits the **working-tree** content of those paths, so make sure the worktree matches what was verified in A4.

### C. Push and post-push gates (owner, then main Claude)

1. **[main Claude]** HEAD is `3508960` (spec 168). It and `227436c` (spec 166) and `afe181e` (spec 165) are unpushed, so the spec 169 commit sits on top of three other unpushed specs. One push carries all four, and the first CI run proves them together. If it goes red, triage by failing suite before attributing it to spec 169.
2. **Architect SF1 gate.** The first `test.yml` run on `main` that includes this commit runs on Node 20 and must show `authEmailHook.verify.test.ts` V0 and V1 green.
   - If V0 or V1 is red on Node 20, the developer returns to the architect. Do **not** mock `crypto.subtle` (AC §4).
3. **CLAUDE.md gate rule.** The latest runs of **both** `test.yml` and `db-migrations-applied.yml` on `main` must be green before this spec counts as shipped:
   - `gh run list --branch main --workflow test.yml --limit 1`
   - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`
   - Per the owner's standing note, also check `e2e.yml` manually until it is promoted.
   - I have no shell and did not check any of these runs. Main Claude must check them.
4. Only after step 3 is green does this proposal become SHIP_READY in effect. There is no other outstanding blocker.

### D. Follow-ups (non-blocking, after ship)

- **Prod acceptance.** This is the owner's spec 166 runbook: step 4 (deploy), then step 5b (the GoTrue-independent probe, which is also the first Deno-side decode proof for the **prod** secret), then step 5 (real GoTrue traffic). Per the security note, a decode mismatch would fail closed: every call gets 401 and no auth mail goes out. So run 5b promptly after the deploy.
- If the optional rows in A2 were not batched, add them later as jest-only additions: architect M2 (explicit `undefined` header), M3 (inner D1 boundary) and the code-reviewer's last-wins row for header keys that differ only in case.
- The code-reviewer nit on the early return for empty candidates, if ever wanted, should go through security review because it touches the gate's control flow.

## Out of scope for this review
- Removing the esm.sh imports from the other edge functions (`@supabase/supabase-js@2` in `send-invite-email`, `delete-user`, `manage-store-user` and others). Spec 169 excludes this explicitly; it needs its own spec.
- A CLAUDE.md convention line about inline verifiers on `verify_jwt = false` functions. That is an owner decision (spec §Out of scope), and CLAUDE.md is not edited here.
- Drift between the three verifier descriptions (the `index.ts` header, the canonical header and the block comment). The code-reviewer marked it out of scope and the spec asked for all three. Revisit it only if they diverge.
- Replay protection within the ±300 s window. The library behaves the same, and spec 166 D13 idempotency is the accepted posture.
- Spec 167 paths and `specs/170-*`, which belong to other sessions.
