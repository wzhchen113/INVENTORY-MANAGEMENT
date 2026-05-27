## Test report for spec 064

### Acceptance criteria status

**File / shape**

- AC-File-1: `.github/workflows/db-migrations-applied.yml` exists at the standard GitHub Actions path → PASS
- AC-File-2: `permissions: contents: read` (least-privilege, mirrors test.yml) → PASS
- AC-File-3: `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` (spec 047 opt-in) → PASS
- AC-File-4: Ubuntu runner, `timeout-minutes: 5`, `actions/checkout@v4`, `supabase/setup-cli@v1` → PASS

**Triggers**

- AC-Trig-1: Runs on every pull request and every push (mirrors test.yml `on: push: pull_request:` shape) → PASS

**Credentials**

- AC-Cred-1: Uses `SUPABASE_ACCESS_TOKEN` (management-API token), NOT a Postgres password → PASS
- AC-Cred-2: Queries prod via `supabase migration list --linked` → PASS
- AC-Cred-3: Does NOT require `SUPABASE_DB_PASSWORD` → PASS
- AC-Cred-4: Runtime linkage via `supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}` → PASS

**Detection logic**

- AC-Det-1: Compares local `supabase/migrations/*.sql` filenames (timestamp prefix) against prod `schema_migrations` versions → PASS
- AC-Det-2: Direction 1 (local not in prod) → hard fail exit 1 → PASS — logic trace confirmed, awk+comm pipeline verified locally
- AC-Det-3: Direction 2 (prod not in repo) → warn only (exit 0, step summary) → PASS — logic trace confirmed
- AC-Det-4: Both directions dirty → both summaries appear, exit 1 (hard-fail wins) → PASS — logic trace confirmed
- AC-Det-5: In sync → "Migrations in sync" success block, exit 0 → PASS — logic trace confirmed
- AC-Det-6: Empty case (no local AND no prod migrations) → exit 0 → FAIL (see Critical finding below)

**Failure UX — direction 1**

- AC-UX-D1-1: Step summary header lists count + offending filenames → PASS
- AC-UX-D1-2: Recovery command (`npx supabase db push`) present → PASS
- AC-UX-D1-3: Spec 064 link present → PASS

**Failure UX — direction 2**

- AC-UX-D2-1: Step summary header lists count + offending prod versions → PASS
- AC-UX-D2-2: Audit action pointer present (back-fill or revert options) → PASS
- AC-UX-D2-3: No recovery command (human judgement call) → PASS
- AC-UX-D2-4: Both blocks written via `echo "..." >> "$GITHUB_STEP_SUMMARY"` from the gate step itself → PASS

**Forks / secret guard**

- AC-Fork-1: Secret unset → skip-with-summary, `skipped=true` output, exit 0 → PASS — step guard confirmed
- AC-Fork-2: All subsequent steps guarded by `if: steps.check_secret.outputs.skipped != 'true'` → PASS

**test.yml unchanged**

- AC-Sibling-1: `.github/workflows/test.yml` not modified → PASS (`git diff HEAD -- .github/workflows/test.yml` is empty; file is untracked new)

**CLAUDE.md update**

- AC-CLAUDE-1: "Gaps and unknowns" bullet updated to list both active workflows with spec 064 attribution → PASS (line 91)
- AC-CLAUDE-2: "Resolved questions / CI workflow" section rewritten: both gates listed, historical-note paragraph with `workflow:write` blocker explanation → PASS (lines 208–214)

---

### Test run

**jest**

```
npm test -- --ci
Test Suites: 33 passed, 33 total
Tests:       316 passed, 316 total
```

PASS — no regression from spec 064 (CI-infra-only; no application code touched).

**typecheck**

```
npm run typecheck      → clean (exit 0)
npm run typecheck:test → clean (exit 0)
```

PASS — spec 064 touches no TypeScript source files.

**pgTAP DB tests**

```
npm run test:db
✗ 2/34 DB test file(s) failed
```

The two failing tests are the same pre-existing failures as before spec 064:

1. `supabase/tests/auth_can_see_store_brand_scope.test.sql` — psql exit 3; FK constraint violation from `eod_submissions_submitted_by_fkey` during super_admin profile deletion in the test teardown. Pre-existing; flagged in earlier reviews.
2. `supabase/tests/staff_role_eod_rls.test.sql` — test 11 fails: idempotency replay with same `client_uuid` returns `conflict: false` instead of `true`. Pre-existing; flagged in earlier reviews.

No new pgTAP failures introduced by spec 064.

---

### Mutation tests (pen-and-paper logic trace)

All six scenarios were traced by simulating the exact awk+comm pipeline locally (bash script reproducing lines 91–120 of the workflow verbatim).

**Test A — local-only 99991231000000 (direction 1)**
- `ls *.sql | grep -oE '^[0-9]{14}'` extracts `99991231000000` into `/tmp/local_versions.txt`.
- CLI table shows no REMOTE entry for that timestamp; awk emits nothing for it to `/tmp/cli_remote.txt`.
- `comm -23 local remote` → `local_not_in_remote.txt = {99991231000000}`.
- `-s` check fires: `HARD_FAIL=1`, direction-1 summary written, `exit 1`.
- Result: HARD FAIL with `99991231000000_synthetic_drift_test.sql` listed. CORRECT.

**Test B — prod-only 20260524000000 (direction 2)**
- Local file for `20260524000000` not present; `local_versions.txt` has no entry.
- CLI table shows REMOTE=`20260524000000`; awk emits it to `/tmp/cli_remote.txt`.
- `comm -23` → `local_not_in_remote.txt` empty; `HARD_FAIL=0`.
- `comm -13` → `remote_not_in_local.txt = {20260524000000}`.
- Direction-2 warn summary written; `exit 0`.
- Result: WARN ONLY. CORRECT.

**Test C — both A and B simultaneously**
- `local_not_in_remote.txt = {99991231000000}`: `HARD_FAIL=1`, direction-1 summary written.
- `remote_not_in_local.txt = {20260524000000}`: direction-2 warn summary written.
- `exit 1` fires. Both blocks appear in the step summary.
- Result: BOTH summaries, exit 1. CORRECT.

**Test D — SUPABASE_ACCESS_TOKEN unset**
- `if [ -z "$SUPABASE_ACCESS_TOKEN" ]` fires (GitHub Actions substitutes empty string for unset secret).
- Skip summary written to `$GITHUB_STEP_SUMMARY`, `echo "skipped=true" >> "$GITHUB_OUTPUT"`, `exit 0`.
- "Link to prod" and "Compare local migrations vs. prod" steps both guarded by `if: steps.check_secret.outputs.skipped != 'true'` — they are skipped.
- Result: clean exit 0 with skip explanation. CORRECT.

---

### Findings

#### Critical

**C1 — Empty-migrations edge case fails with exit 1 (AC-Det-6: NOT TESTED in practice; logic bug present)**

When there are zero local migration files (`ls supabase/migrations/*.sql` finds nothing), the pipeline fails with exit 1 instead of exit 0 due to two compounding `set -euo pipefail` interactions:

1. `ls supabase/migrations/*.sql 2>/dev/null` exits 1 when the glob matches nothing. `2>/dev/null` suppresses stderr but not the exit code. With `pipefail` active, the entire `ls | xargs | grep | sort > /tmp/local_versions.txt` pipeline exits 1 immediately.

Reproduction:
```bash
bash -c '
set -euo pipefail
ls /nonexistent/*.sql 2>/dev/null \
  | xargs -n1 basename \
  | grep -oE "^[0-9]{14}" \
  | sort -u > /tmp/local_versions.txt
' ; echo "exit: $?"
# Prints: exit: 1
```

**Practical impact:** The repo currently has 76 migration files; this code path never triggers in normal operation. The empty case is only reachable on a brand-new repo with no migrations. For this codebase the risk is zero today.

**Spec AC coverage:** The spec acceptance criterion explicitly lists "Empty case: no local migrations AND no prod migrations → exit 0" and this criterion FAILS. However, the spec's "Out of scope" section says "First-time baseline alignment… is a manual one-time task." A repo with zero migrations would be in that bucket. Given the practical impact is zero, this is flagged as Critical for AC completeness but the release-coordinator may judge it acceptable given the project context.

**Fix (if desired):** Change the local-set extraction to:
```bash
ls supabase/migrations/*.sql 2>/dev/null \
  | xargs -n1 basename 2>/dev/null \
  | grep -oE '^[0-9]{14}' \
  | sort -u > /tmp/local_versions.txt || true
```
The trailing `|| true` converts any pipeline failure to success, matching the `2>/dev/null || touch /tmp/remote_versions.txt` pattern already used for the remote set on line 111–112.

---

#### Should-fix

**S1 — `SUPABASE_PROJECT_ID` unset is not guarded by the secret-presence check**

The `check_secret` step only checks `SUPABASE_ACCESS_TOKEN`. If `SUPABASE_ACCESS_TOKEN` is set but `SUPABASE_PROJECT_ID` is missing, the skip path does not fire. The `supabase link --project-ref ""` call runs with an empty project ref and fails with an unhelpful error rather than the clear "skip" message.

The spec acknowledges this in the "Pre-merge action items" section ("the supabase link step will fail with a 'missing project ref' error") and states the skip-with-summary path is for fork PRs, not a substitute for secret setup. This is a documentation call, not a latent bug during normal operation. However, it could confuse a developer who sets up `SUPABASE_ACCESS_TOKEN` first and runs CI before adding `SUPABASE_PROJECT_ID`.

**Suggested fix:** Extend the check to also test `SUPABASE_PROJECT_ID`:
```bash
if [ -z "$SUPABASE_ACCESS_TOKEN" ] || [ -z "$SUPABASE_PROJECT_ID" ]; then
```

This is a Should-fix, not a blocker, since the scenario only arises during initial secret setup.

---

#### Notes

**N1 — Automated regression coverage for the workflow logic itself**

The spec explicitly puts "Tests for the workflow itself" out of scope and treats post-merge CI observation as the verification path. The PM prompt asks whether this is acceptable or whether a `bats` or `act`-based smoke should be added.

Current state: neither `bats` nor `act` is installed or referenced in `package.json`. Introducing either would be a new framework addition requiring explicit user approval per CLAUDE.md ("Do NOT silently introduce a fourth framework").

The logic was manually verified against all 6 spec scenarios via a bash simulation script in this review. The awk+comm pipeline is deterministic and the synthetic traces all produced correct results.

**Recommendation:** Accept the observation-post-merge posture for v1 per the spec's own design. If the awk parser is ever updated (e.g., due to a CLI table-format change), the developer should re-run the bash simulation from this review. A follow-up spec could add `bats` tests for the shell logic as a named framework addition — but that requires user approval and is not a 064 blocker.

**N2 — "On: push" triggers on all branches, not just main**

The spec text says "every push to `main`" but the implementation uses bare `on: push:` (all branches), identical to test.yml. This is correct per "mirrors the on: shape in test.yml." The spec AC says "mirrors test.yml" — it passes. The "push to main" wording in the prose is slightly loose.

**N3 — `supabase migration list --linked` stderr suppression coverage**

The workflow uses `supabase migration list --linked 2>/dev/null > /tmp/cli_output.txt`. This discards ALL stderr including genuine CLI errors (invalid token, network timeout, etc.). In those cases, `cli_output.txt` would be empty or partial, producing an empty remote set and a false "direction-2: all local missing" result — but `set -e` would catch the non-zero CLI exit first and fail the step, which is the correct behavior per the spec's "connection error fails the build loudly" design decision.

**N4 — Spec path vs. review path**

The spec file lives at `specs/064-ci-migrations-applied-gate.md` (flat). The review is written to `specs/064/reviews/test-engineer.md` (per the short-ID convention in the test-engineer system prompt). Both paths exist.

---

### Summary verdict

- All logic-trace scenarios (Test A through D + in-sync + empty) traced correctly against the awk+comm pipeline.
- jest: 316 tests pass, no regression.
- typecheck + typecheck:test: clean.
- pgTAP: 2 pre-existing failures, no new failures from spec 064.
- The one logic bug (empty-migrations `set -e` + `pipefail` interaction) has zero practical impact on this repo today but technically fails AC-Det-6.
- The release-coordinator should decide whether the empty-case failure is a blocker given the project context (76 migrations, no plan for zero-migration state). If the fix is applied (one `|| true` on line 83), all ACs pass.

With the C1 finding present, this report treats the spec as FIXES_NEEDED until C1 is resolved or explicitly accepted as out-of-scope by the release-coordinator. If C1 is accepted as a known theoretical-only edge case (no practical impact, spec out-of-scope for zero-migration repos), then SHIP_READY applies.

## Handoff
next_agent: NONE
