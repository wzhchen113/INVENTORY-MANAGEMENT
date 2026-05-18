# Security audit for spec 047

## Scope

Spec 047 adds a single workflow-level `env:` block to
[.github/workflows/test.yml](.github/workflows/test.yml) (lines 46-47) setting
`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`. This opts JS-based GitHub Actions
(`actions/checkout@v4`, `actions/setup-node@v4`, `supabase/setup-cli@v1`) into
the Node 24 action runtime ahead of GitHub's ~June 2, 2026 force-default.

Files reviewed:
- [.github/workflows/test.yml](.github/workflows/test.yml) (the only changed
  file; the only workflow file in the repo)
- [specs/047-ci-node24-action-runtime.md](specs/047-ci-node24-action-runtime.md)

Out of scope per the change itself: no `package.json` change → no `npm audit`
run is warranted by the project-specific rubric. No edge functions, RPCs,
migrations, RLS, secrets handling, PII surfaces, or input-validation paths are
touched by this spec. Confirmed by `git diff HEAD -- .github/workflows/test.yml`
showing only the 10-line env-block addition.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- None.

### Informational (non-findings — recorded for completeness)

These are not findings against this spec. They are positive observations from
the angles the dispatch prompt asked me to consider.

- **Least-privilege preserved.** The existing
  [.github/workflows/test.yml:36-37](.github/workflows/test.yml) `permissions:
  contents: read` block is untouched and the new `env:` block sits adjacent to
  it (lines 46-47) without altering the permission grant. No privilege drift.
  Specifically: there is no `permissions: write-all`, no `id-token: write`, no
  `pull-requests: write` added — `contents: read` remains the only grant and
  applies to all four jobs.
- **Env var name matches GitHub's official runner flag.**
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` is the documented opt-in variable named
  in the deprecation annotation itself (quoted verbatim in the spec at line
  13). No typo, no fabricated similar-looking variable name, no risk of an
  unrecognized flag silently sitting in workflow scope.
- **No secret or auth surface exposed.** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`
  is a boolean opt-in flag the runner reads before deciding which Node binary
  to invoke for a `runs.using: node20` action declaration. It is not a token,
  not a credential, not a URL, and not an input to any action. The runtime
  switch happens entirely inside the runner; the workflow neither reads back
  the variable nor passes it to any external system. There is no log-exposure
  path or third-party-API path to worry about.
- **Supply-chain posture unchanged.** The pre-existing pin posture is `@v4`
  for `actions/checkout` and `actions/setup-node` and `@v1` for
  `supabase/setup-cli`. Spec 047 does not change those pins. Moving from
  major-version pins (`@v4`) to commit-SHA pins is a stricter posture some
  repos adopt but is orthogonal to this spec and out of scope per spec lines
  45-47 (the spec explicitly defers minor/specific-version pinning to a future
  spec).
- **Flag misbehavior cannot enable secret exfiltration.** Worst-case behavior
  of an action under Node 24 vs. Node 20 is a runtime crash, a transient
  cache-resolution miss in `actions/setup-node`'s `cache: npm` path, or a
  changed-text deprecation annotation. None of those expose secrets or change
  what the workflow has access to. The workflow's secret surface is whatever
  `secrets.*` it references — `git grep -n secrets\\. .github/workflows/`
  returns no matches, confirming the workflow uses zero secrets today. The
  spec's verification plan (lines 209-219) gates on the CI run staying green;
  that's the right loud-failure mode.
- **Single-workflow reach confirmed.** `ls .github/workflows/` returns only
  `test.yml` (AC bullet 2). The workflow-level env block applies to all four
  jobs (`jest`, `typecheck`, `typecheck-base`, `db`) — the change cannot
  silently miss a fifth job because no fifth job exists.

### Dependencies
No `package.json` changes — `npm audit` skipped per the project rubric.

## Verdict

Spec 047 is a clean, narrowly-scoped CI-infra change with no security
implications. The env var is a runner-level opt-in flag with no token, secret,
or auth dimension; the least-privilege `contents: read` grant is preserved;
the variable name matches GitHub's documented spelling; and the supply-chain
pin posture is unchanged. No findings at any severity. Safe to ship.
