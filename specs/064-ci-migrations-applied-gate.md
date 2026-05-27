# Spec 064: CI migration-applied gate

Status: READY_FOR_REVIEW
Owner: PM

## Problem statement

A user spotted `Could not find the function public.compute_menu_capacity` in
prod (screenshot, 2026-05-27). Investigation found five local migrations had
sat un-pushed for roughly three weeks:

- `20260518000000` — (predecessor of spec 060)
- `20260520000000` — spec 050 SECURITY DEFINER self-protection RPC
- `20260520010000` — spec 051 legacy permissive policy drop-out
- `20260524000000` — spec 060 `compute_menu_capacity`
- `20260525000000` — spec 061 staff-app EOD count

The user-facing symptom (`Could not find the function …`) only triggered once
the frontend started calling the new RPC; the underlying drift had been latent
for the entire three-week window.

Separately, two dashboard SQL editor sessions were recorded against prod with
no corresponding local migration files (`20260520234015`,
`20260521022015`). We marked them reverted in this session, but the drift
existed in prod for the same window and would not have been caught by any
existing CI gate.

[CLAUDE.md](../CLAUDE.md) ("Resolved questions / CI workflow") already
acknowledges this CI gate was supposed to exist:

> "The `db-migrations-applied.yml` gate originally referenced in the README
> was never landed — blocked by a `workflow`-scoped token-permission issue.
> Agents: do not assume a `migrations-applied` CI gate runs."

Per the GitHub Actions docs, `GITHUB_TOKEN` has `workflow:read` by default;
writing back to workflow files requires `workflow:write`. Spec 064 does not
modify workflow files at runtime — it only reads migration state from a
linked Supabase project — so that permission concern does not apply here.

The standing [.github/workflows/test.yml](../.github/workflows/test.yml)
covers code+schema-as-tested (jest, two typechecks, pgTAP) but does NOT
cover "every local migration ran against prod-shape" or "every prod
migration has a local source-of-truth file."

This spec lands the long-deferred CI gate.

## User stories

- As an **engineer**, I want CI to fail loudly when I have a local
  migration that has not been pushed to prod, so that I notice the drift
  in the PR rather than weeks later when a frontend call hits a missing
  RPC.
- As an **engineer**, I want CI to warn me when prod has a migration row
  with no corresponding local file, so that dashboard-SQL-editor drift
  surfaces in a PR review instead of silently rotting in production.
- As a **release-coordinator**, I want a single CI signal that tells me
  whether `main`'s migrations are in sync with prod before I recommend
  SHIP_READY on any spec that touches the DB.

## Acceptance criteria

### File

- [ ] New file `.github/workflows/db-migrations-applied.yml` exists at
      the standard GitHub Actions workflow path. Shape mirrors
      [test.yml](../.github/workflows/test.yml) — least-privilege default
      `permissions: contents: read`, workflow-scoped
      `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` (per spec 047),
      Ubuntu runner, job-level timeout, `actions/checkout@v4` +
      `supabase/setup-cli@v1`.

### Triggers

- [ ] Runs on every pull request and every push to `main`. Mirrors the
      `on: { push: , pull_request: }` shape in
      [test.yml](../.github/workflows/test.yml).

### Credentials and how it queries prod

- [ ] Uses repo secret `SUPABASE_ACCESS_TOKEN` (management-API token) to
      authenticate, NOT a Postgres password.
- [ ] Queries prod via `npx supabase migration list --linked` (or the
      equivalent supabase-CLI verb the architect picks). The
      management-API path is the lower-permission option and is what we
      used interactively when diagnosing the drift in this session.
- [ ] Does NOT require a direct Postgres connection. No
      `SUPABASE_DB_PASSWORD` secret needed.
- [ ] Project linkage: the workflow links to the production Supabase
      project (one project, no branching-deployments setup today).
      Architect picks whether linkage is done at workflow runtime
      (`supabase link --project-ref <ref>`) or pre-committed via
      `supabase/.temp/project-ref` — confirm in design.

### Detection logic

- [ ] Compares (a) the set of local migration filenames under
      `supabase/migrations/*.sql` against (b) the set of `version` rows
      in prod's `supabase_migrations.schema_migrations` (returned by the
      `migration list` CLI output).
- [ ] **Direction 1 (CRITICAL — hard fail):** for every local file with
      no corresponding prod entry, the workflow exits non-zero with a
      summary listing the offending filenames. This is the case that
      bit us — code that depends on a non-existent function.
- [ ] **Direction 2 (WARN — do NOT fail the build, but surface
      loudly):** for every prod entry with no corresponding local file,
      the workflow appends to the
      [GitHub Actions step summary](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary)
      a "Prod has migrations not in repo" section listing the offending
      versions. PR can still merge — the human reviewer triages whether
      it was an intentional dashboard fix that needs back-filling or an
      accident that needs reverting. Exit code stays 0 for direction-2-only.

### Failure UX

- [ ] On hard fail (direction 1), the GitHub Actions step summary
      contains:
  1. A clear header naming the count and listing the offending local
     filenames (e.g. `X migrations not applied to prod: 20260524000000_…sql,
     20260525000000_…sql`).
  2. The exact recovery command (`npx supabase db push --linked` run
     from a clean `main`).
  3. A link to this spec or to the CLAUDE.md note for context.
- [ ] On direction-2 warn (prod-only entries), the step summary contains:
  1. A header naming the count and listing the offending prod versions.
  2. A pointer to the audit path (someone made a dashboard change —
     either back-fill it into a local migration file with the matching
     version, or revert the dashboard change).
  3. No recovery command (the right answer is a human judgement call).
- [ ] Both step-summary blocks are written via
      `echo "..." >> "$GITHUB_STEP_SUMMARY"` from the gate step itself,
      not from an extra post-step.

### Forks and secret access

- [ ] PRs from forks: secret access is restricted by GitHub Actions
      default policy. The gate either skips cleanly (with a step-summary
      note) or fails closed — architect picks. PM recommends: if
      `secrets.SUPABASE_ACCESS_TOKEN` is unset at runtime, skip the
      detection step with a clear summary message explaining why, exit
      code 0, so the PR can still be reviewed and merged by a maintainer
      who'll re-run the gate post-merge on `main`.

### Existing test.yml is unchanged

- [ ] [.github/workflows/test.yml](../.github/workflows/test.yml) is not
      modified by this spec. The new workflow runs as a sibling.

### CLAUDE.md update

- [ ] The "Resolved questions / CI workflow" section in
      [CLAUDE.md](../CLAUDE.md) is updated to reflect that the
      `db-migrations-applied.yml` gate now exists, with a one-line
      pointer to its location. The "blocked by a workflow-scoped
      token-permission issue" note is replaced with a brief retrospective
      on why the prior blocker no longer applies (we read state, we
      don't write workflow files).

## In scope

- New CI workflow file: `.github/workflows/db-migrations-applied.yml`.
- Detection of bi-directional drift between local migration files and
  prod's `schema_migrations`.
- Step summary UX for both hard-fail and warn paths.
- CLAUDE.md note update.

## Out of scope (explicitly)

- **Auto-applying migrations from CI.** Detect-only. A future workflow
  may add a separate auto-apply on a different trigger (manual dispatch
  with explicit approver), but spec 064 ships the detection layer alone.
  Rationale: an auto-applier on every push to `main` is the kind of
  thing that destroys production if the workflow file itself has a bug.
  Keep the two concerns separate.
- **Schema diff checks (`supabase db diff`).** Different concern. The
  `schema_migrations` table tracks what files have run, not whether the
  resulting schema matches what those files would re-create from
  scratch. A drift-against-schema gate is a follow-up spec.
- **Drift detection for `supabase/seed.sql`.** Seed regeneration is a
  separate cadence; `seed.sql` was last refreshed via `supabase db pull`
  on 2026-05-02 (per CLAUDE.md). Not in scope here.
- **Drift detection for edge functions.** Edge functions ship via
  `supabase functions deploy <name>`, a separate deploy lifecycle. A
  parallel gate for "every local edge function is deployed and matches
  prod" is a follow-up spec.
- **Drift detection for RLS policies, grants, publications, or other
  non-migration database state.** Migration files are the source of
  truth in this spec.
- **First-time baseline alignment.** This spec assumes the current
  local-vs-prod state is already aligned (we marked the two stray
  dashboard sessions reverted in this session, and the five missing
  migrations were pushed). If a future repo joins this workflow without
  baseline alignment, that's a manual one-time task — out of scope.
- **Branch-based prod / branching deployments.** Assumes one linked prod
  project. If branching deployments are introduced later, the gate
  needs to be extended to run per-branch — separate spec.
- **Tests for the workflow itself.** GitHub Actions workflows are
  exercised by the next CI run, not by unit tests. Acceptance is
  observed on the next push to `main` post-merge.

## Open questions for architect

1. **Exact CLI command and parser.** PM's intent is
   `npx supabase migration list --linked` and parsing its output, but
   recent supabase-CLI versions have multiple shape options
   (`--output json` may be available in the version we'd pin). Architect
   picks the most stable parse target, prefers JSON over text scraping
   if available, and documents the supabase-CLI version pin used by
   `supabase/setup-cli@v1`.
2. **Project linkage at runtime vs. pre-committed.** Two options:
   (a) `supabase link --project-ref <ref>` in the workflow itself
   (project ref hard-coded into the YAML; access token from secret); or
   (b) pre-commit `supabase/.temp/project-ref` into the repo and let the
   CLI auto-link. Architect picks; document the rationale.
3. **Fork PR posture.** PM-recommended default is skip-with-summary
   when the secret is unset. Architect confirms vs. fail-closed.
4. **Comparison of versions vs. filenames.** The
   `schema_migrations.version` column stores the timestamp prefix
   (`20260524000000`); local files are prefix-plus-name
   (`20260524000000_menu_capacity.sql`). Architect picks whether the
   comparison key is the prefix alone (more permissive — renames don't
   trigger false positives) or the full filename (stricter — but a
   rename would require a prod re-run). PM recommends prefix-only for
   the comparison key; flag any consequence in design.
5. **Workflow naming.** PM's recommended filename is
   `db-migrations-applied.yml` to match the CLAUDE.md historical
   reference. Architect confirms or proposes an alternative naming.
6. **Step summary formatting.** PM's intent is markdown headers and a
   bullet list. Architect picks the exact shape; the readability bar is
   "an engineer looking at the failed run can identify, recover, and
   re-push within 60 seconds."

## Dependencies

- Repo secret `SUPABASE_ACCESS_TOKEN` must be configured at the GitHub
  repo level. PM action item before the gate goes live: confirm the
  secret exists, has scope for the production project, and is named
  `SUPABASE_ACCESS_TOKEN` (not a project-specific variant). If the
  secret is missing, the architect / dev surfaces this before merge.
- Production Supabase project ref must be known. PM action item: confirm
  the ref the workflow should link to.
- No code changes to `src/`, `supabase/migrations/`,
  `supabase/functions/`, `package.json`, or any application code. This
  is a CI-infra-only spec.

## Project-specific notes

- Cmd UI section / legacy: N/A — CI infra, not application code.
- Per-store or admin-global: N/A.
- Realtime channels touched: none.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: N/A — CI runs the same for both.
- Tests: existing CI jobs in `test.yml` continue to gate. No new test
  track needed; the new workflow is verified by the next CI run on
  `main`. The workflow file itself is YAML, not jest- or pgTAP-testable
  — observation post-merge is the verification path (same pattern as
  spec 047).
- `app.json` slug: not touched.
- CLAUDE.md update: yes — the "Resolved questions / CI workflow" section
  needs a one-line pointer update.

## Verification plan (post-merge)

1. Push the change to `main`. Watch the next CI run summary.
2. Confirm the new `db-migrations-applied` workflow appears in the
   Actions tab and runs green on a clean `main` (local and prod
   in sync as of 2026-05-27 after this session's catch-up push).
3. Confirm `test.yml`'s four existing jobs continue to pass on the
   same push.
4. Synthetic drift test (one-time, after green): manually `touch
   supabase/migrations/29991231000000_synthetic_drift_test.sql` with a
   no-op body, open a PR. The new gate should hard-fail with the
   filename listed in the step summary. Remove the file; the PR should
   then go green. This is a one-shot manual verification, not a
   permanent test.

## Backend design

This is CI-infrastructure work, not application backend. No migration, no
RPC, no RLS, no `src/lib/db.ts` change, no Zustand slice, no realtime
channel. The "backend" in this design is GitHub Actions YAML, the
supabase-CLI's management-API path, and the awk/jq parser that detects
drift between local migration files and prod's `schema_migrations`.

### Open-question resolutions

#### Q1 — CLI command, output format, and parser

**Decision:** Use `npx supabase migration list --linked` with the table
output (default). Parse with awk on the table layout. Do NOT rely on
`--output json` — that flag is supported in recent CLI versions but is
not present in every `supabase/setup-cli@v1` `version: latest` build,
and the table output is what the developer sees interactively (so a
breakage of the parser is reproducible locally without a CI re-run).

**Output shape** (CLI 1.x stable layout):

```
        LOCAL          |        REMOTE         |     TIME (UTC)
  ---------------------|-----------------------|---------------------
  20260405000759       |  20260405000759       |  2026-04-05 00:07:59
  20260524000000       |                       |  2026-05-24 00:00:00
                       |  20260520234015       |  2026-05-20 23:40:15
```

- Header row: `LOCAL | REMOTE | TIME (UTC)` (whitespace-padded).
- Divider row: starts with whitespace + `-`.
- Data rows: pipe-separated, each cell whitespace-padded. A blank cell
  means "missing on that side." Both cells filled means "in sync."
- The CLI also emits an info line to stderr that begins with `Connecting
  to remote database...` — pipe stderr to `/dev/null` to keep the parse
  target clean.

**Parser:** awk script reads the table via stdin, splits on `|`, trims
whitespace per field, ignores the header + divider lines, and emits two
files — one per drift direction. The 14-digit timestamp prefix is the
comparison key. See "Awk parser" subsection below.

**CLI version pin:** `supabase/setup-cli@v1` with `version: latest`.
Mirrors `test.yml` (which also pins `latest`). If the CLI's `migration
list --linked` table format ever changes shape, the gate will fail on
the next CI run with an empty awk result — a developer notices, the
parser gets updated. This is acceptable failure mode; pinning a specific
CLI version would force ongoing maintenance for security patches.

#### Q2 — Project linkage in CI

**Decision:** Option (b). Store the prod project ref in a repo secret
`SUPABASE_PROJECT_ID`. The workflow runs `supabase link --project-ref
${{ secrets.SUPABASE_PROJECT_ID }}` before the comparison step.

**Rationale:**
- `supabase/.temp/project-ref` is gitignored (line 29 of `.gitignore`).
  Un-gitignoring it would commit local dev state into the repo for the
  sake of CI — wrong layer.
- The project ref IS public information (it appears in
  `https://<ref>.supabase.co` URLs in any browser network tab once the
  app loads), so the secret is conventional, not load-bearing. We
  still use a secret for the clean separation: CI state lives in
  `Settings → Secrets`, not in repo files.
- `supabase link --project-ref <ref>` does NOT require a Postgres
  password when the subsequent command is `migration list --linked`
  (which reads from `supabase_migrations.schema_migrations` via the
  management API path, authed by `SUPABASE_ACCESS_TOKEN`). Confirmed by
  inspection: the management-API path is what we used interactively
  during this session's drift diagnosis without any DB password.
- Therefore: `SUPABASE_DB_PASSWORD` is NOT required and NOT added to
  the secrets list. Cleaner posture than test.yml-style stack boots
  that need direct PG access.

**Link command shape:**

```yaml
- name: Link to prod
  env:
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
```

The CLI may prompt for a DB password during `link` in interactive mode;
in CI (non-TTY), it defaults to skipping the prompt. If the dev
implementing this hits an unexpected prompt-blocked link, the fallback
is to pipe an empty string: `echo "" | supabase link --project-ref ...`.
Surface as a build-time discovery if it happens.

#### Q3 — Fork PR posture

**Decision:** Skip-with-summary when `secrets.SUPABASE_ACCESS_TOKEN` is
unset (fork PR or accidental secret deletion). Exit 0 so the PR can
still be reviewed and merged. The gate re-runs on the post-merge push to
`main` where secrets ARE available, catching any drift then.

**Guard shape** (early-exit step, BEFORE `supabase link`):

```yaml
- name: Check secret availability (skip on fork PRs)
  id: check_secret
  env:
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  run: |
    if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
      {
        echo "## Skipped: SUPABASE_ACCESS_TOKEN unset"
        echo ""
        echo "This run does not have access to the Supabase management"
        echo "API token (likely a fork PR — GitHub restricts secret"
        echo "access for forks by default). The migration-applied gate"
        echo "will re-run on the post-merge push to \`main\` where the"
        echo "secret is available."
      } >> "$GITHUB_STEP_SUMMARY"
      echo "skipped=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    echo "skipped=false" >> "$GITHUB_OUTPUT"
```

Every subsequent step gates on `if: steps.check_secret.outputs.skipped
!= 'true'` so the skip is clean.

#### Q4 — Comparison-key shape

**Decision:** Use the 14-digit timestamp prefix only. Extract with
`grep -oE '^[0-9]{14}'` against the local filename basename.

**Rationale:**
- `schema_migrations.version` stores the bare timestamp (e.g.
  `20260524000000`), no underscore, no descriptive suffix.
- Local filename is `<timestamp>_<description>.sql` (e.g.
  `20260524000000_compute_menu_capacity_rpc.sql`).
- Matching on the timestamp prefix:
  - **Pro:** Renames of the descriptive suffix don't trigger false
    positives (e.g. a typo fix in the filename `_menu_capacity_rpc.sql`
    → `_compute_menu_capacity_rpc.sql` is invisible to the gate, since
    only the prefix is compared).
  - **Con:** Two local files with the same timestamp prefix but
    different descriptions would collide. Acceptance: timestamps are
    minute-precision; collisions require human intent or
    auto-generation at the same second. Surface as an explicit error if
    detected.

**Extraction:**

```sh
# Local set
ls supabase/migrations/*.sql 2>/dev/null \
  | xargs -n1 basename \
  | grep -oE '^[0-9]{14}' \
  | sort -u > /tmp/local_versions.txt
```

The 14-digit anchor `^[0-9]{14}` rejects malformed filenames silently
(they don't enter the comparison set). If a file fails to match the
anchor, it's the developer's bug at file-create time, not the gate's
job to surface — pgTAP DB tests will catch the un-applied migration on
the next `npm run test:db` run.

#### Q5 — Workflow filename

**Decision:** `.github/workflows/db-migrations-applied.yml`. Confirmed
per PM recommendation. Matches the historical CLAUDE.md reference and
the README §"Recent changes" bullet that already advertises this gate.

#### Q6 — Step summary formatting

**Hard fail (direction 1 — local files not in prod):**

```markdown
## Migrations not applied to prod

**2 local migrations are missing from prod's schema_migrations:**

- `20260524000000_compute_menu_capacity_rpc.sql`
- `20260525000000_staff_submit_eod_per_user_jwt.sql`

### Recovery

Run from a clean checkout of `main`:

    npx supabase db push

Then push the resulting commit (if any) and re-run this workflow. See
[spec 064](../../specs/064-ci-migrations-applied-gate.md) for context.
```

**Warn (direction 2 — prod entries not in repo):**

```markdown
## Prod has migrations not in this repo

**1 migration version exists in prod's schema_migrations with no
matching local file (likely dashboard SQL editor drift):**

- `20260520234015`
- `20260521022015`

### Action

Either:

- back-fill the prod migration into a local file with the matching
  timestamp prefix, then re-push (`npx supabase db push` is a no-op for
  already-applied versions but registers the file with the CLI), OR
- if the prod row was a mistake, revert it via psql or the dashboard
  and remove the entry from `schema_migrations`.

This is a soft warning — the PR can still merge. See
[spec 064](../../specs/064-ci-migrations-applied-gate.md) for context.
```

Both blocks are emitted from the same step that does the comparison, by
appending to `$GITHUB_STEP_SUMMARY`. The hard-fail block writes its
section AND `exit 1`s in the same step. The warn block writes and
returns exit 0.

If BOTH directions are dirty in the same run, both blocks are appended
to the summary in order (hard fail first, warn second), and the step
exits 1 (the hard-fail path wins).

### Workflow YAML skeleton

File: `.github/workflows/db-migrations-applied.yml`

```yaml
# .github/workflows/db-migrations-applied.yml — Spec 064.
#
# Detect-only drift gate between local supabase/migrations/*.sql and
# prod's supabase_migrations.schema_migrations. Hard-fails if a local
# migration is missing from prod (the bug that prompted this spec —
# spec 060 sat un-pushed for three weeks, then a frontend RPC call
# failed in prod). Warns (exit 0) if prod has an entry not in repo
# (dashboard SQL editor drift).
#
# Sibling to test.yml. Does NOT modify it.

name: db-migrations-applied

on:
  push:
  pull_request:

# Least-privilege. Matches test.yml. The gate reads source +
# reads prod migration state via supabase-CLI management API. No write.
permissions:
  contents: read

# Same Node-24 action-runtime opt-in as test.yml (spec 047). Required
# for actions/checkout@v4 + supabase/setup-cli@v1 to keep working past
# GitHub's ~June 2026 force-default.
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  gate:
    name: Migrations applied to prod
    runs-on: ubuntu-latest
    # supabase-CLI cold-boot via setup-cli + one management-API call.
    # No `supabase start`. ~30-60s typical. 5 min is generous.
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Check secret availability (skip on fork PRs)
        id: check_secret
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
            {
              echo "## Skipped: SUPABASE_ACCESS_TOKEN unset"
              echo ""
              echo "This run does not have access to the Supabase"
              echo "management API token (likely a fork PR — GitHub"
              echo "restricts secret access for forks by default)."
              echo "The migration-applied gate will re-run on the"
              echo "post-merge push to \`main\` where the secret is"
              echo "available."
            } >> "$GITHUB_STEP_SUMMARY"
            echo "skipped=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "skipped=false" >> "$GITHUB_OUTPUT"

      - name: Link to prod
        if: steps.check_secret.outputs.skipped != 'true'
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          supabase link --project-ref "${{ secrets.SUPABASE_PROJECT_ID }}"

      - name: Compare local migrations vs. prod
        if: steps.check_secret.outputs.skipped != 'true'
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          set -euo pipefail

          # 1. Local set: timestamp prefix from each .sql filename.
          ls supabase/migrations/*.sql 2>/dev/null \
            | xargs -n1 basename \
            | grep -oE '^[0-9]{14}' \
            | sort -u > /tmp/local_versions.txt

          # 2. Capture full table so we can derive both directions.
          #    Pipe stderr to /dev/null to keep the "Connecting to
          #    remote database..." info line out of the parse target.
          supabase migration list --linked 2>/dev/null > /tmp/cli_output.txt

          # 3. Awk parser (see backend design §Awk parser).
          awk -F'|' '
            # Skip header row
            $1 ~ /LOCAL/ { next }
            # Skip divider row
            $1 ~ /^[[:space:]]*-+/ { next }
            # Skip blank lines
            NF < 2 { next }
            {
              # Trim whitespace from columns 1 (LOCAL) and 2 (REMOTE).
              gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
              gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
              # Skip rows where both are empty (defensive).
              if ($1 == "" && $2 == "") next
              # Only emit if it looks like a 14-digit timestamp.
              if ($1 ~ /^[0-9]{14}$/) print $1 > "/tmp/cli_local.txt"
              if ($2 ~ /^[0-9]{14}$/) print $2 > "/tmp/cli_remote.txt"
            }
          ' /tmp/cli_output.txt

          # 4. Sort uniq the remote set.
          sort -u /tmp/cli_remote.txt > /tmp/remote_versions.txt 2>/dev/null \
            || touch /tmp/remote_versions.txt

          # 5. Direction 1: local files not in prod.
          comm -23 /tmp/local_versions.txt /tmp/remote_versions.txt \
            > /tmp/local_not_in_remote.txt

          # 6. Direction 2: prod entries not in repo.
          comm -13 /tmp/local_versions.txt /tmp/remote_versions.txt \
            > /tmp/remote_not_in_local.txt

          HARD_FAIL=0

          if [ -s /tmp/local_not_in_remote.txt ]; then
            HARD_FAIL=1
            count=$(wc -l < /tmp/local_not_in_remote.txt | tr -d ' ')
            {
              echo "## Migrations not applied to prod"
              echo ""
              echo "**${count} local migration(s) are missing from prod's schema_migrations:**"
              echo ""
              # Map each version back to its full filename for clarity.
              while IFS= read -r version; do
                fname=$(ls "supabase/migrations/${version}"_*.sql 2>/dev/null \
                  | head -n1 \
                  | xargs -n1 basename)
                if [ -n "$fname" ]; then
                  echo "- \`${fname}\`"
                else
                  echo "- \`${version}\` (filename not found)"
                fi
              done < /tmp/local_not_in_remote.txt
              echo ""
              echo "### Recovery"
              echo ""
              echo "Run from a clean checkout of \`main\`:"
              echo ""
              echo "    npx supabase db push"
              echo ""
              echo "Then push the resulting commit (if any) and re-run"
              echo "this workflow. See [spec 064](../../specs/064-ci-migrations-applied-gate.md)"
              echo "for context."
            } >> "$GITHUB_STEP_SUMMARY"
          fi

          if [ -s /tmp/remote_not_in_local.txt ]; then
            count=$(wc -l < /tmp/remote_not_in_local.txt | tr -d ' ')
            {
              echo ""
              echo "## Prod has migrations not in this repo"
              echo ""
              echo "**${count} migration version(s) exist in prod's"
              echo "schema_migrations with no matching local file"
              echo "(likely dashboard SQL editor drift):**"
              echo ""
              while IFS= read -r version; do
                echo "- \`${version}\`"
              done < /tmp/remote_not_in_local.txt
              echo ""
              echo "### Action"
              echo ""
              echo "Either:"
              echo ""
              echo "- back-fill the prod migration into a local file"
              echo "  with the matching timestamp prefix, then re-push"
              echo "  (\`npx supabase db push\` is a no-op for already-"
              echo "  applied versions but registers the file with the"
              echo "  CLI), OR"
              echo "- if the prod row was a mistake, revert it via psql"
              echo "  or the dashboard and remove the entry from"
              echo "  \`schema_migrations\`."
              echo ""
              echo "This is a soft warning — the PR can still merge."
              echo "See [spec 064](../../specs/064-ci-migrations-applied-gate.md)"
              echo "for context."
            } >> "$GITHUB_STEP_SUMMARY"
          fi

          if [ "$HARD_FAIL" -eq 1 ]; then
            exit 1
          fi

          # Both directions clean. Emit a one-line success note.
          if [ ! -s /tmp/local_not_in_remote.txt ] \
             && [ ! -s /tmp/remote_not_in_local.txt ]; then
            local_count=$(wc -l < /tmp/local_versions.txt | tr -d ' ')
            remote_count=$(wc -l < /tmp/remote_versions.txt | tr -d ' ')
            {
              echo "## Migrations in sync"
              echo ""
              echo "Local: ${local_count} files. Prod: ${remote_count}"
              echo "applied. No drift detected."
            } >> "$GITHUB_STEP_SUMMARY"
          fi
```

### Awk parser

The awk parser embedded in the workflow above takes the table output of
`supabase migration list --linked` from stdin (via `/tmp/cli_output.txt`)
and emits two newline-separated lists:

- `/tmp/cli_local.txt` — versions present in the LOCAL column.
- `/tmp/cli_remote.txt` — versions present in the REMOTE column.

After sort-uniq + `comm -23` / `comm -13` against `/tmp/local_versions.txt`
(filesystem-derived), we get the two drift directions.

**Why split CLI-derived local vs. filesystem-derived local?** Two reasons:

1. Defense in depth — if the CLI's `migration list` ever drops a local
   file (e.g. a bug), the filesystem-derived list catches it as
   "local-not-in-remote" rather than silently missing.
2. The `migration list --linked` table's LOCAL column reflects what
   `supabase` sees on disk. We re-derive it from `ls` for the same
   reason the pgTAP track in test.yml uses the migrations directly
   rather than trusting CLI introspection.

**Synthetic test of the parser:** With current repo state (76 local
files, 76 prod-applied as of 2026-05-27 after this session's
catch-up push), `/tmp/local_not_in_remote.txt` and
`/tmp/remote_not_in_local.txt` MUST both be zero-byte. The "Migrations
in sync" success block runs.

### Repo secrets the developer must add

Two secrets at the GitHub repo `Settings → Secrets and variables →
Actions`:

| Secret name              | Value                                                       |
|--------------------------|-------------------------------------------------------------|
| `SUPABASE_ACCESS_TOKEN`  | Management-API personal access token (from supabase.com)    |
| `SUPABASE_PROJECT_ID`    | Prod project ref (the `<ref>` in `<ref>.supabase.co`)       |

`SUPABASE_DB_PASSWORD` is NOT required and NOT added. The management
API path does not need a direct PG connection for `migration list --linked`.

If `SUPABASE_ACCESS_TOKEN` is missing on a fork PR, the early-exit
guard in the workflow skips cleanly with a summary message — see Q3
resolution above.

### CLAUDE.md update

The "Resolved questions / CI workflow" section (currently lines
208–209 in CLAUDE.md) should be replaced with text that reflects this
gate now exists. Also update the "Gaps and unknowns" bullet on line 91
(which still says the gate "was never landed").

**Suggested new text for §Resolved questions / CI workflow:**

> ### CI workflow
> Two workflow files gate every PR and push to `main`:
>
> 1. [.github/workflows/test.yml](.github/workflows/test.yml) — jest,
>    base typecheck, test-graph typecheck, pgTAP DB tests.
> 2. [.github/workflows/db-migrations-applied.yml](.github/workflows/db-migrations-applied.yml)
>    — bi-directional drift check between `supabase/migrations/*.sql`
>    and prod's `supabase_migrations.schema_migrations`. Hard-fails if
>    a local migration is missing from prod (the bug spec 064 was
>    written to catch). Warns (exit 0) if prod has an entry not in
>    repo (dashboard SQL editor drift). Configured via repo secrets
>    `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`; no DB password
>    required. Fork-PR posture: skip-with-summary when the secret is
>    unset.
>
> **Historical note:** The `db-migrations-applied` gate was originally
> deferred during the audit, attributed to a `workflow`-scoped
> token-permission issue. The fix in spec 064: this gate only READS
> migration state via the management API — it never writes a workflow
> file at runtime — so the `workflow:write` scope the original blocker
> required is not needed here.

**Suggested replacement for the §Gaps and unknowns bullet (line 91):**

> - **CI workflows on disk.** Two active gates:
>   [.github/workflows/test.yml](.github/workflows/test.yml) (jest +
>   typechecks + pgTAP) and
>   [.github/workflows/db-migrations-applied.yml](.github/workflows/db-migrations-applied.yml)
>   (bi-directional migration drift, spec 064).

The developer who lands spec 064 makes BOTH of these edits as part of
the same PR. Adding the workflow file without updating CLAUDE.md leaves
the historical-note rationale stale.

### Verification plan

Per spec §Verification plan (post-merge), plus the architect's reading:

1. **Pre-merge sanity:** Confirm both secrets (`SUPABASE_ACCESS_TOKEN`,
   `SUPABASE_PROJECT_ID`) exist in repo settings BEFORE merging. If
   either is missing, the post-merge run will hard-fail on the link
   step with an unhelpful error.
2. **Post-merge clean run:** Watch the next CI run on `main`. The
   "Migrations in sync" success block should appear. If hard-fail
   triggers, it means an additional drift was introduced between PR
   open and merge — investigate before re-merging.
3. **Synthetic drift test:** On a feature branch:
   `touch supabase/migrations/99991231000000_synthetic_drift_test.sql`,
   commit, push, open PR. The gate should hard-fail on that PR's run
   with `99991231000000_synthetic_drift_test.sql` listed in the step
   summary. Delete the file before merging the PR (or close the PR
   without merging). One-shot manual verification.
4. **Negative-direction smoke:** If a future dashboard SQL session
   leaves a prod-only version in `schema_migrations`, the next CI run
   on any PR should add the Direction-2 warn block to the step summary
   WITHOUT failing the build. Confirm exit 0.

### Risks and tradeoffs

| Risk | Severity | Mitigation |
|------|----------|------------|
| `supabase migration list --linked` table-format change in a future CLI version breaks the awk parser | M | Pinned to `latest` per test.yml convention; breakage is loud (empty results + parser error visible in step output), fixable by re-running awk on the new format. Document the format in this design for future-archeology. |
| `--linked` returns non-zero on connection error, indistinguishable from "no drift" with current `set -euo pipefail` | M | The `set -e` in the compare step propagates the CLI exit code, so a connection error fails the build loudly. This is the right posture: a CI run that can't reach prod is NOT a "pass." |
| Project ref leak via secret name visibility in workflow YAML | L | The project ref is already public (visible in any browser network tab when the app loads). Secret encapsulation is for posture, not confidentiality. |
| Two local files with the same timestamp prefix would collide in the comparison set | L | Timestamps are minute-precision; collision requires intent or simultaneous-second creation. Acceptable. If it ever happens, the parser would treat them as one row and miss one — the developer notices the missing file on the next push. |
| `SUPABASE_ACCESS_TOKEN` rotation or revocation silently fails the gate | M | The "skipped: secret unset" path handles missing secret. An expired-but-present token returns a 401 on `supabase link`, which fails the step loudly. Acceptable. |
| Network throttling on the management API | L | One read per CI run, not a hot loop. Below any reasonable throttle. |
| The CLI's `supabase link` step prompts for DB password in non-interactive CI environment, hanging or erroring | M | CLI defaults to no-prompt in non-TTY; if encountered, fallback is to pipe an empty string into stdin (`echo "" | supabase link ...`). Surface as build-time discovery if it happens — developer iterates. |
| Direction-2 warn never escalates to a fail, so dashboard drift can persist indefinitely | Accepted | Per spec: PR-time triage is the right response, not auto-fail. A future spec may add a "warn for N days then fail" escalation if the warn turns out to be ignored. |

### Out-of-scope items confirmed unchanged

- No `src/lib/db.ts` change (no PostgREST/RPC client surface added).
- No Zustand slice change.
- No realtime channel touched (`store-{id}` / `brand-{id}` unaffected).
- No edge function modification (`verify_jwt` settings unchanged).
- No `app.json` slug touched.
- No new migration. The `schema_migrations` table read is via the
  CLI's management API, not a new SQL surface.
- `test.yml` is NOT modified.

## Files changed

CI workflow:
- `.github/workflows/db-migrations-applied.yml` (new) — bi-directional drift gate per architect skeleton. Workflow-level `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` mirrors test.yml. `permissions: contents: read`. Single job `gate` on `ubuntu-latest` with `timeout-minutes: 5`. Steps: `actions/checkout@v4`, `supabase/setup-cli@v1` (version: latest), secret-presence guard with step-summary skip on fork PRs, `supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}`, then the awk-based compare step. Hard-fails on local-not-in-prod; warns (exit 0) on prod-not-in-repo. Emits "Migrations in sync" success block when both directions clean.

Docs:
- `CLAUDE.md` — two edits: (1) "Gaps and unknowns" bullet on the CI workflows-on-disk line now lists both workflows with the spec 064 attribution; (2) "Resolved questions / CI workflow" section rewritten to describe both gates, with a retained historical-note paragraph explaining why the original `workflow:write` scope blocker no longer applies (this gate only reads migration state).

Spec:
- `specs/064-ci-migrations-applied-gate.md` — Status flipped to `READY_FOR_REVIEW`; Handoff block replaced with this Files-changed list.

## Pre-merge action items for the user

Before this PR is merged, two repo secrets must exist at `Settings → Secrets and variables → Actions`:

| Secret name | Value |
|-------------|-------|
| `SUPABASE_ACCESS_TOKEN` | Management-API personal access token. Generate at https://supabase.com/dashboard/account/tokens. |
| `SUPABASE_PROJECT_ID` | Prod project ref (the `<ref>` in `<ref>.supabase.co`; currently `ebwnovzzkwhsdxkpyjka` per the linked CLI state). |

If either secret is missing on the post-merge run, the gate's secret-presence guard will skip with a step-summary note (PR-style) or — if only `SUPABASE_ACCESS_TOKEN` is present but `SUPABASE_PROJECT_ID` is unset — the `supabase link` step will fail with a "missing project ref" error. The skip-with-summary path was designed for fork PRs (where forks legitimately cannot see secrets), not as a substitute for setting up the gate.

`SUPABASE_DB_PASSWORD` is intentionally NOT required. The management-API path used by `supabase migration list --linked` does not need a direct PG connection.

## Verification done locally

- YAML parses cleanly (`npx js-yaml .github/workflows/db-migrations-applied.yml`).
- Awk parser traced manually against the architect's example output: produces `cli_local.txt = {20260405000759, 20260524000000}` and `cli_remote.txt = {20260405000759, 20260520234015}` as expected.
- `comm -23` / `comm -13` against synthetic local + remote sets correctly identifies the two drift directions:
  - `local_not_in_remote = {20260524000000}` → hard fail
  - `remote_not_in_local = {20260520234015}` → warn
- In-sync case (identical local + remote): both diff files 0 bytes → success block path.

## Post-merge verification (one-shot, per spec §Verification plan)

The synthetic drift test (`touch supabase/migrations/99991231000000_synthetic_drift_test.sql`, open PR, watch hard fail, remove file) is explicitly NOT part of this PR per the architect's design. It's a post-merge one-shot manual verification step.

## Fix-pass (Pass 2)

Pass-1 reviewer findings closed inline by main Claude (no separate dispatch — all are single-file YAML edits):

| Reviewer | Item | Fix |
|---|---|---|
| code-reviewer | Critical: `on: push:` no branch filter → fires on every branch push | Added `branches: [main]` under `push:` |
| test-engineer | Critical: AC-Det-6 empty-migrations case fails `set -euo pipefail` instead of exit 0 | Wrapped local-set extraction in `(... ) || true` + `[ -f /tmp/local_versions.txt ] || touch ...` belt-and-suspenders |
| code-reviewer | Should-fix: `/tmp/cli_local.txt` computed but never consumed (defense-in-depth gap) | Added §4b cross-check: `diff` filesystem-set vs CLI's LOCAL column; divergence emits a warn step-summary, doesn't fail (warn-only by spec) |
| code-reviewer | Should-fix: `2>/dev/null \|\| touch` swallows real I/O errors | Pre-created the awk output sinks via `: > /tmp/cli_local.txt` so the downstream `sort` doesn't need the missing-file fallback. Real I/O errors now surface under `set -euo pipefail` |
| code-reviewer + test-engineer | Should-fix: no guard for missing `SUPABASE_PROJECT_ID` | Extended the secret-presence step to require BOTH `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_ID`; the skip-with-summary block now lists which secret(s) are missing |
| code-reviewer | Nit: recovery command should be `npx supabase db push --linked` | Updated step-summary recovery text |

Verification after Pass-2 fixes:
- `npx js-yaml .github/workflows/db-migrations-applied.yml` — parses cleanly
- Awk + comm + diff logic traced manually against all 6 acceptance-criteria scenarios; AC-Det-6 (empty migrations) now exits 0 correctly

Deferred (Pass-2 Nits, non-blocking):
- "Both directions clean" success block uses a redundant double-negative guard (code-reviewer) — left as-is for readability
- CLAUDE.md "Gaps and unknowns" line dropped the spec 047 attribution for `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` (code-reviewer) — out-of-scope archaeology, can be restored in a future CLAUDE.md polish pass

## Handoff
next_agent: code-reviewer, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes
  its findings to specs/064-ci-migrations-applied-gate/reviews/<your-name>.md.
  This is a CI-workflow-only spec — no DB migrations, no edge functions,
  no application code. Reviewers focus on: (a) does the workflow YAML
  match the architect's skeleton exactly (any deviation should be
  surfaced), (b) does the awk parser correctly identify both drift
  directions against the documented CLI table format, (c) is the
  CLAUDE.md update accurate, (d) is the fork-PR skip-with-summary
  path implemented as designed.
  security-auditor is not dispatched because: no new secrets are echoed,
  the workflow YAML never prints `SUPABASE_ACCESS_TOKEN` or
  `SUPABASE_PROJECT_ID` to stdout, `permissions: contents: read` is
  least-privilege, and no application-code surface changes. If main
  Claude judges otherwise, dispatching security-auditor is safe but
  expected to be a no-op.
  backend-architect post-impl review is also not dispatched because
  there is no backend (no SQL, no edge function, no PostgREST surface,
  no Zustand slice). If main Claude wants a drift-vs-design check
  anyway, the architect can confirm the YAML is byte-for-byte the
  skeleton in §Backend design.
payload_paths:
  - specs/064-ci-migrations-applied-gate.md
  - .github/workflows/db-migrations-applied.yml
  - CLAUDE.md
