# Code review for Spec 027

## Summary

- 0 Critical
- 4 Should-fix
- 4 Nits

## Critical

None.

## Should-fix

### S1 — Misleading header comment in smoke script

`scripts/smoke-edge-roles.sh:9-10` — Header comment claims "same set -u + non-zero-exit-on-first-failure contract" as siblings, but the script does NOT exit on first failure. `fail()` at line 62 sets `FAILED=1` and continues; the script runs all arms and exits non-zero only at `exit $FAILED` (line 245). `smoke-edge.sh` does the same, so runtime behavior is correct, but the comment creates a false expectation.

**Fix.** Replace "non-zero-exit-on-first-failure" with "non-zero-exit-on-any-failure (runs all arms, accumulator pattern)" or drop the qualifier.

### S2 — Summary line missing ✓/✗ Unicode prefix

`scripts/smoke-edge-roles.sh:239-241` — Summary lines omit the `✓`/`✗` Unicode prefix used in both sibling scripts. `smoke-edge.sh:144` prints `✓ all checks passed`; `smoke-rpc.sh:131` does the same. `smoke-edge-roles.sh` prints `all checks passed` without the prefix. Inconsistent visual signal across multi-script output.

**Fix.** Match siblings.

### S3 — `tests/README.md` not updated to list the new script

`tests/README.md:34` and `tests/README.md:354-366` — The Track 3 section still describes `npm run test:smoke` as running `smoke-edge.sh` and `smoke-rpc.sh` only. The new `smoke-edge-roles.sh` is invisible in the canonical developer reference. A new contributor would not know the script exists.

**Fix.** Add a bullet for `smoke-edge-roles.sh` alongside the two existing entries; update the "runs both" comment to reflect three scripts. Strictly additive and squarely in scope per Track D3.

### S4 — Token extraction uses `python3` instead of `jq`

`scripts/smoke-edge-roles.sh:141` and `:205` — JSON parsing uses `python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))"`. Both sibling scripts use `jq -r '.access_token // empty'` (`smoke-rpc.sh:73`, `smoke-multi-brand.sh:57`). The spec design §4 explicitly cites "identical to `smoke-rpc.sh:67-78`" for the login pattern. `python3` is documented as "a fallback" in `smoke-edge.sh:37` for cached-file reading only, not as a primary login extraction path. Introduces an undeclared runtime dep when `jq` is already mandatory for siblings.

**Fix.** Switch both token-extraction calls to `jq -r '.access_token // empty'`.

## Nits

### N1 — Trap-exit comment phrasing

`scripts/smoke-edge-roles.sh:243-244` — Comment "Exit code is set by trap (it returns the exit code that triggered it)" is slightly misleading. The trap explicitly reads `$?` into `local exit_code` then calls `exit "$exit_code"`. Clearer wording: "The trap reads $? (= $FAILED here) and re-exits with it so state mutation is cleaned up on any exit path."

### N2 — `ORIGIN` env-var documentation note

`scripts/smoke-edge-roles.sh:55` — `ORIGIN` defaults to the same Vercel URL as `smoke-edge.sh:33`. Consistent behavior; just noting the override carries across the chained `npm run test:smoke` run. Not a finding, informational.

### N3 — Comment provenance attribution diverges from reference

`supabase/functions/send-invite-email/index.ts:16-19` — The 4-line comment cites "spec 026 Track A" correctly. The reference `delete-user/index.ts:14-18` cites a probe number ("Spec 012c §14 / Probe 16"). Consistent enough; minor stylistic drift.

### N4 — `fail()` accumulator pattern vs. spec language

`scripts/smoke-edge-roles.sh:62` — `fail()` sets `FAILED=1` but does not call `exit 1`. Spec design (§4) language says "non-zero exit on first failure," but the accumulator pattern is the correct match for `smoke-edge.sh` convention. Combined with S1 the header comment should be the place to fix this.

## Coverage notes (no findings)

- Track A constant edit shape matches the reference at `delete-user/index.ts:19`. Lines 17-96 of `send-invite-email/index.ts` are byte-for-byte preserved per spot-checks.
- All four smoke-script arms are present in the order designed: CORS preflight, no-auth 401, admin pass, super_admin-promoted pass.
- `trap restore_admin EXIT` registered BEFORE the role promotion at line 178.
- `package.json` `test:smoke` chain uses `&&` correctly.
- Track D1 (CLAUDE.md bullet) and Track D2 (`.claude/agents/security-auditor.md` bullet) are both strictly additive and well-placed.
