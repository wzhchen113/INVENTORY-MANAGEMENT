# Spec 047: CI Node 20 → 24 action-runtime migration

Status: READY_FOR_REVIEW

## User story
As a repo maintainer, I want CI to stop emitting the Node 20 action-runtime
deprecation annotation so that we keep working before GitHub force-flips
the default on June 2nd, 2026 and we don't get caught by a silent breakage.

## Context
Every CI run currently emits:

> Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, actions/setup-node@v4. Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026. Node.js 20 will be removed from the runner on September 16th, 2026. […] To opt into Node.js 24 now, set the FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true environment variable on the runner or in your workflow file.

The deprecation targets the **action's own Node runtime** (the Node that
runs `actions/checkout`'s and `actions/setup-node`'s JS), NOT the Node
version we install via `setup-node` to run our `npm test` / `tsc` builds
(currently `'20'` at [.github/workflows/test.yml:53, :74, :96](.github/workflows/test.yml)).
Bumping the project Node is a separate concern and out of scope here.

## Acceptance criteria
- [ ] [.github/workflows/test.yml](.github/workflows/test.yml) sets
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` such that it applies to all
  four jobs (`jest`, `typecheck`, `typecheck-base`, `db`).
- [ ] No other workflow files require the same treatment. Verified via
  `ls .github/workflows/` returning only `test.yml`.
- [ ] On the next CI run after the change lands, the deprecation
  annotation referencing `actions/checkout@v4` and `actions/setup-node@v4`
  is absent from the run summary.
- [ ] All four jobs (`jest`, `typecheck`, `typecheck-base`, `db`)
  continue to pass on `main` after the change.
- [ ] The `node-version: '20'` value passed to `actions/setup-node@v4`
  stays `'20'` (this spec does not bump the project Node version).

## In scope
- One-line YAML change to [.github/workflows/test.yml](.github/workflows/test.yml)
  to opt into Node 24 for action runtime.

## Out of scope (explicitly)
- Bumping `node-version: '20'` to `'22'` or `'24'` for the project's
  `npm test` / `tsc` Node. Rationale: Node 20 is still LTS and the
  deprecation in question is about the action's own Node, not ours.
  Address when Node 20 EOLs (April 2026) or sooner if needed — separate
  spec.
- Pinning `actions/setup-node@v4`'s `node-version` to a specific minor
  (e.g. `'20.18'`) for reproducibility. Flag for a future spec; not in
  this one.
- Auditing or bumping `supabase/setup-cli@v1`. Architect will check
  during design review and call it out if it shares the same Node 20
  deprecation surface; if so, decide whether to fold it in here or
  punt to a follow-up.
- Any application code, DB migrations, edge functions, or test changes.

## Open questions for architect
1. **Workflow-level `env:` vs. per-job `env:`.** Top-level is DRY but
   easy to forget on a future job; per-job is verbose but explicit.
   Architect picks; document the rationale in the design doc.
2. **`supabase/setup-cli@v1` parity check.** Does this action share the
   same Node 20 deprecation? If yes, the env-var fix covers it
   automatically at workflow-level — confirm during design.
3. **Regression risk of opt-in now vs. wait-for-deadline.** Opting in
   now means any `actions/checkout@v4` or `actions/setup-node@v4` bug
   under Node 24 surfaces loudly on the next push (good — we'd want to
   know). Waiting until June 2nd, 2026 means it could surface silently
   if we forget to test. Spec recommends opt-in now; architect confirms.

## Dependencies
- None. Single-file YAML edit.

## Project-specific notes
- Cmd UI section / legacy: N/A — CI infra, not application code.
- Per-store or admin-global: N/A.
- Realtime channels touched: none.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: N/A — CI runs the same for both.
- Tests: existing CI jobs continue to gate. No new test track needed;
  the workflow change is verified by the next CI run on `main`.
- `app.json` slug: not touched.

## Backend design

This is a CI-infra spec, not an application spec. The standard design
sections (data model, RLS, API contract, edge functions, `src/lib/db.ts`,
realtime, useStore) are all N/A — explicitly listed below for the record.

### Scope confirmation

- Data model changes: none.
- RLS impact: none.
- API contract: none.
- Edge function changes: none.
- `src/lib/db.ts` surface: unchanged.
- Realtime impact: none. (No publication membership change → no
  `docker restart supabase_realtime_imr-inventory` step.)
- Frontend store impact: none.
- Migration filename: none — no SQL migration.

### Workflow change

Add a workflow-scoped `env:` block to
[.github/workflows/test.yml](.github/workflows/test.yml) declaring:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
```

Placement: between the existing top-level `permissions:` block (line 36-37)
and the `jobs:` key (line 39). The env block lives at workflow scope and
GitHub Actions exports it into the environment of every step in every
job, which is exactly the contract the runner checks before deciding
which Node binary to invoke for a JS-based action.

The `node-version: '20'` arguments passed to `actions/setup-node@v4`
(lines 53, 74, 96) stay `'20'` — those control the project Node we install
to run `npm test` and `tsc`, which is orthogonal to the action runtime.
This matches AC bullet 5.

### Resolution of open questions

**Q1: Workflow-level vs. per-job `env:` scope.**

Decision: workflow-level (top-level `env:` block, one declaration).

Rationale:
- The env var is a runner-level opt-in flag, not behavior that varies by
  job. All four jobs (`jest`, `typecheck`, `typecheck-base`, `db`) use
  `actions/checkout@v4` + `actions/setup-node@v4`, and the `db` job also
  uses `supabase/setup-cli@v1`. Every job needs the same opt-in.
- Per-job duplication is a foot-gun: someone adds a fifth job later,
  forgets the `env:` block, and the deprecation annotation reappears on
  that job only — easy to miss in a green CI summary.
- Workflow-level is the documented GitHub Actions pattern for runner
  opt-in flags, mirroring how `ACTIONS_STEP_DEBUG` and friends are
  conventionally hoisted.
- Reversal cost is trivial — one line removed.

**Q2: `supabase/setup-cli@v1` parity.**

Decision: the workflow-level env var covers it; no version bump
needed in this spec.

Rationale: `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` is a runner-level flag
that GitHub's actions runner reads when deciding which Node to invoke
for ANY JS-based action's `runs.using: node20` declaration in its
`action.yml`. It's not action-specific. If `supabase/setup-cli@v1` is
declared as a `node20` action (most likely, since the deprecation
warning historically only flagged `actions/checkout` and
`actions/setup-node` on this repo's runs — see spec context line 13),
the env var flips it to Node 24 the same way. If it's a composite or
Docker action, the flag is a no-op for it, which is also fine. Either
way, the workflow-scoped env var is the right tool; no `@v2`
investigation needed for this spec.

If the next CI run after this lands surfaces a new deprecation
annotation specifically naming `supabase/setup-cli@v1`, that's a
follow-up spec — out of scope here per spec line 48-51.

**Q3: Opt-in-now (May 2026) vs. wait-for-deadline (~June 2026).**

Decision: opt in now.

Rationale:
- CI is currently green and stable. Surprises from the Node 24 switch
  (action incompatibility, subtle behavioral diff in
  `actions/setup-node` cache resolution, etc.) surface against a known-
  good baseline and are isolable to this change.
- Waiting until GitHub force-flips on ~June 2nd, 2026 means any
  regression lands inside a window where other work may also be in
  flight, making attribution harder. We also lose the agency to revert
  cleanly — once GitHub flips the default we can't go back to Node 20
  for these actions.
- The deprecation annotation is currently noise on every CI run; opting
  in now removes it from the next push onward, which is the AC bullet 3
  signal we'll watch.
- Reversal: if something breaks under Node 24, set the env var to
  `false` (explicit opt-out, valid until GitHub's removal date in
  September 2026 per spec context line 13) and file a follow-up.

### Risks and tradeoffs

- **Risk: `actions/checkout@v4` or `actions/setup-node@v4` regression
  under Node 24.** Mitigation: AC bullet 4 (all four jobs continue to
  pass on `main`). If a job fails on first run after this lands, the
  fix is either (a) flip the env var to `false` and file a follow-up,
  or (b) bump the action to a version that ships its own Node 24
  support (e.g. `actions/checkout@v5` if released by then).
- **Risk: `supabase/setup-cli@v1` regression in the `db` job under
  Node 24.** Mitigation: same as above, isolated to the `db` job.
  The DB tests boot ~60-90s of stack per run (workflow comment line
  24), so a flake here is loud and not silent.
- **Risk: `cache: npm` behavior in `actions/setup-node@v4` differs
  subtly under Node 24** (e.g. cache-key resolution, lockfile parsing).
  Low probability — `setup-node@v4` has been Node-24-tested in the
  wild since GitHub announced the deprecation — but worth knowing as a
  failure mode if `npm ci` suddenly slows down or misses cache hits.
- **Risk: no CI gate currently enforces migration consistency**
  (CLAUDE.md "CI workflow" — `db-migrations-applied.yml` does not
  exist on disk). N/A for this spec — we're editing `test.yml`, the
  workflow that DOES exist. Just flagging the broader CI posture
  remains "the workflow that exists must stay green."
- **Tradeoff: project Node version stays `'20'`.** Out of scope per
  spec line 39-44. If Node 20 EOLs (April 2026 per spec line 43) and
  the action runtime is already on Node 24, the gap is narrow and
  intentional — bumping the project Node is a separate spec because
  it can shake out actual app/test behavior, not just action behavior.

### Verification plan (post-merge)

1. Push the change to `main`. Watch the CI run summary at the next
   commit.
2. Confirm the deprecation annotation referencing
   `actions/checkout@v4` and `actions/setup-node@v4` is absent
   (AC bullet 3).
3. Confirm all four jobs pass green (AC bullet 4).
4. If a new annotation appears naming `supabase/setup-cli@v1`, file
   a follow-up spec to bump that action — does not block this spec's
   SHIP.

## Files changed

### CI / workflows
- `.github/workflows/test.yml` — added workflow-scoped `env:` block
  between the existing `permissions:` block and the `jobs:` key,
  setting `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` so all four jobs
  (`jest`, `typecheck`, `typecheck-base`, `db`) opt their JS-based
  actions (`actions/checkout@v4`, `actions/setup-node@v4`,
  `supabase/setup-cli@v1`) into the Node 24 action runtime ahead of
  GitHub's ~June 2, 2026 force-default. The `node-version: '20'`
  args passed to `actions/setup-node@v4` on lines 53, 74, and 96 are
  unchanged — that's the project Node version for our app, orthogonal
  to action runtime.

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer, backend-architect
prompt: Review the implementation of this spec. Each reviewer writes its
  findings to specs/047-ci-node24-action-runtime/reviews/<your-name>.md.
  The backend-architect runs in post-impl drift-review mode. The change
  is a single workflow-level `env:` block in .github/workflows/test.yml
  setting `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`; AC bullets 1, 2,
  and 5 are verifiable from the diff alone (workflow-scoped env applies
  to all four jobs, only test.yml exists under .github/workflows/, and
  `node-version: '20'` is unchanged on lines 53/74/96). AC bullets 3
  and 4 (deprecation annotation absent, jobs continue to pass) verify
  only on the next CI push to main — call out the post-merge-only
  verification posture if you flag this.
payload_paths:
  - specs/047-ci-node24-action-runtime.md
  - .github/workflows/test.yml
