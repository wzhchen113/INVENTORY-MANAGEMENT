# Test report for spec 047

## Acceptance criteria status

- AC1: `.github/workflows/test.yml` sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` such that it applies to all four jobs (`jest`, `typecheck`, `typecheck-base`, `db`) → **PASS** — statically verified.
- AC2: No other workflow files require the same treatment. Verified via `ls .github/workflows/` returning only `test.yml` → **PASS** — statically verified.
- AC3: On the next CI run after the change lands, the deprecation annotation referencing `actions/checkout@v4` and `actions/setup-node@v4` is absent from the run summary → **NOT TESTED** — post-merge-only verifiable; cannot be confirmed from local inspection.
- AC4: All four jobs (`jest`, `typecheck`, `typecheck-base`, `db`) continue to pass on `main` after the change → **NOT TESTED** — post-merge-only verifiable on CI; see notes on local proxy below.
- AC5: The `node-version: '20'` value passed to `actions/setup-node@v4` stays `'20'` (this spec does not bump the project Node version) → **PASS** — statically verified.

## Test run

### Static verification (AC1, AC2, AC5)

AC1 — env block at workflow scope, before `jobs:`:

```
$ grep -n "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24" .github/workflows/test.yml
47:  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

env: block at line 46, jobs: block at line 49 → workflow-scoped (confirmed)
```

YAML-parsed shape:
- `doc['env']` = `{'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24': True}` — single top-level env key, no job-level env block on any of the four jobs (`jest`, `typecheck`, `typecheck-base`, `db`).

AC2 — only `test.yml` under `.github/workflows/`:

```
$ ls .github/workflows/
test.yml
```

AC5 — `node-version: '20'` on all three `actions/setup-node@v4` steps:

```
$ grep -n "node-version" .github/workflows/test.yml
44: (comment line — does not affect runtime)
63:          node-version: '20'
84:          node-version: '20'
106:         node-version: '20'
```

Three setup-node steps (jest, typecheck, typecheck-base); the `db` job uses `supabase/setup-cli@v1` and has no `node-version` argument (correct — CLI action does not take one). All three are `'20'`. AC5 satisfied.

### In-tree suite spot-check (proxy for AC4 — local only)

The spec touches no application code, no migrations, no edge functions, and no test files. The in-tree suites were run as a regression spot-check to confirm the workflow change did not accompany any unintended file mutations.

**jest (`npm test -- --ci`):**
```
Test Suites: 13 passed, 13 total
Tests:       163 passed, 163 total
Time:        ~0.9 s
```
All 163 tests pass. No failures.

**typecheck (`npm run typecheck`):**
```
Exit 0 — no type errors.
```

**typecheck:test (`npm run typecheck:test`):**
```
Exit 0 — no type errors.
```

pgTAP (`npm run test:db`) was not run — it requires a live local Supabase stack (`npm run dev:db`), and this spec explicitly states "No migrations needed" and "Realtime impact: none." There is no DB surface to exercise here.

### AC3 and AC4 — post-merge posture

These two criteria are inherently observable only on a live GitHub Actions run after the commit lands on `main`. There is no local analog: the deprecation annotation is emitted by the GitHub-hosted runner's action runtime orchestration before any step executes, and the four-job pass/fail verdict requires the full runner environment (Docker, `supabase start`, `ubuntu-latest` OS image).

This is the expected posture for a CI-infra change. The spec's own verification plan (§"Verification plan (post-merge)") explicitly calls out steps 2 and 3 as post-push checks. Flagging as NOT TESTED reflects the local verification limit, not a gap in the spec's design.

The static checks for AC1, AC2, and AC5 are the full locally-verifiable surface for this change.

## Notes

**On regression-lock via static test.** The dispatch prompt raised the question of whether a static test (e.g. a script asserting env var presence + name) should be added to lock down regression risk.

Assessment: a static assertion script is not warranted here. The failure mode if the env var is removed or misspelled is immediate and loud: the deprecation annotation reappears on the next CI push, which is visible in the run summary (not a silent failure). That is a stronger signal than a local shell script could provide, because the annotation appears before any job logic runs — it cannot be masked by a test suite that only exercises application code. The spec's verification plan is the right regression-detection mechanism for this class of change.

If the codebase were to grow a `scripts/lint-workflow.sh` or similar YAML-linting harness in a future spec, this env var would be a natural candidate for an assertion in that harness. Surfacing as a future improvement, not a blocker.

**YAML boolean vs. string (code-reviewer S1).** The code-reviewer flagged `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` (unquoted YAML boolean) vs. `'true'` (string). This does not affect test results — GitHub's runner coerces the YAML boolean to the string `"true"` in practice — but it is a should-fix. No test can distinguish the two behaviors locally; the distinction is in CI runner internals. Deferring to the developer to address the code-reviewer finding.

**No new test track introduced.** This spec is CI-infra only. Tracks 1 (jest), 2 (pgTAP), and 3 (shell smokes) have no surface here. No fourth framework was considered or introduced.
