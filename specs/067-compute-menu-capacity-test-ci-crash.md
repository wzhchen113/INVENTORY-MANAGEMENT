# Spec 067: Diagnose + fix `compute_menu_capacity.test.sql` CI Postgres crash

Status: READY_FOR_BUILD

Owner: (unassigned)

## Problem statement

CI's pgTAP Track 2 (`npm run test:db` in [.github/workflows/test.yml](.github/workflows/test.yml))
has been crashing on every push since spec 060 landed
[supabase/tests/compute_menu_capacity.test.sql](supabase/tests/compute_menu_capacity.test.sql)
and
[supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql).
Last passing CI: spec 059 (2026-05-24 00:30). Every push since (~7 runs over 3
days) has failed. Local runs of the same test pass 16/16 cleanly.

**Failing CI signature:**

```
psql:<stdin>:446: server closed the connection unexpectedly
```

Line 446 of [supabase/tests/compute_menu_capacity.test.sql](supabase/tests/compute_menu_capacity.test.sql)
is the closing paren of the `throws_ok` for arm (10) — "anon: permission denied
(REVOKE EXECUTE)". The Postgres backend crashes during or just before that arm;
Postgres then enters recovery mode, and the 4 subsequent alphabetical pgTAP
tests fail to connect: `copy_brand_catalog`, `cross_brand_copy`,
`delete_last_privileged_guard`, `demote_self_guard`. So the observed 5/35 CI
failure count is 1 root crash + 4 cascade victims.

Why we missed it: we were watching local pgTAP green and jest green and did not
notice `test.yml` was red. Spec 064 added the separate
`db-migrations-applied.yml` workflow but did not gate on `test.yml` success, so
the new gate did not surface this either.

## User stories

**(i)** As a developer pushing to `main`, I want CI's pgTAP suite to actually
run without crashing so I know whether my changes are green.

**(ii)** As the project maintainer, I want CI failures to be visible signals,
not silent noise we ignore for days.

## Acceptance criteria

- [ ] **AC1 — root cause identified.** The architect's design doc names the
  actual crash cause (one of the suspected causes below, or another) and cites
  the evidence (a CI run that captured the diagnostic output, an isolated
  repro, or a clear Postgres-bug reference). "It might be X" is not acceptable.
- [ ] **AC2 — fix lands and CI Track 2 passes.** After the fix is merged, the
  next push to `main` shows
  [.github/workflows/test.yml](.github/workflows/test.yml) Track 2 green, with
  `compute_menu_capacity` passing all 16 arms.
- [ ] **AC3 — cascade victims pass.** The same green CI run shows
  `copy_brand_catalog`, `cross_brand_copy`, `delete_last_privileged_guard`,
  and `demote_self_guard` all passing (since they only failed due to the
  recovery-mode connection refusal).
- [ ] **AC4 — process change so this doesn't silently happen again.** One of
  the following lands in the same spec or a tiny follow-up:
  (a) main Claude's `CLAUDE.md` workflow updates to require a CI status check
  after every push, OR
  (b) `db-migrations-applied.yml` (or equivalent) is extended to also gate on
  `test.yml` success, OR
  (c) some other mechanism the architect proposes — but inaction on AC4 is not
  acceptable. Note the chicken-and-egg: if `test.yml` is broken, gating on it
  blocks all merges, so the AC4 mechanism must handle the "test.yml currently
  red" boot case.

## In scope

- Diagnose the actual Postgres crash cause in
  [supabase/tests/compute_menu_capacity.test.sql](supabase/tests/compute_menu_capacity.test.sql)
  under the GitHub Actions Ubuntu runner environment.
- Apply the minimal fix to make the test pass in CI. The fix may live in the
  test file (e.g. `set local statement_timeout`, `set local jit = off`, isolated
  synthetic data) or in the RPC
  [supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)
  (e.g. tighter depth cap, work_mem guard, plan hint) — architect decides based
  on the diagnosis.
- Verify the fix on a CI branch BEFORE merging to `main`. CI experimentation on
  a branch is the expected loop here, not paper design.
- AC4 process change.

## Out of scope (explicitly)

- **Rewriting the `compute_menu_capacity` RPC entirely.** The recursive CTE
  with depth-5 cap + visited-array cycle guard is the design that shipped in
  spec 060 and is in active product use; redesigning it is a separate spec if
  it ever becomes necessary.
- **Removing the test.** The 16 arms exercise contract surface that production
  depends on (auth gates, anon revoke, RLS, cycle handling, depth cap). Keep
  them.
- **A new memory-budget audit of every pgTAP test in the suite.** That is a
  reasonable follow-up — file as a separate spec if the diagnosis here
  generalizes.
- **Reordering pgTAP tests so the cascade victims don't run after this one.**
  Alphabetical ordering is the established convention in
  [scripts/test-db.sh](scripts/test-db.sh); the right fix is "don't crash",
  not "hide the cascade".
- **Migrating the staff subtree's DB-access carve-out into `src/lib/db.ts`.**
  Unrelated to this regression.

## Open questions resolved

- Q: Should we just disable the test in CI until the fix lands?
  → A: No. Disabling masks the regression and we'd still ship broken DB
  contract. Architect investigates and fixes; CI stays red in the meantime.
  The blast radius of red CI here is limited because `test.yml` failure does
  not currently block merges (which is itself part of AC4).
- Q: Is local-passes/CI-fails proof of a memory issue specifically?
  → A: No, premature. Local Docker has more memory but also different
  Postgres image / different `jit` defaults / different `work_mem` /
  different installed extensions. All five suspected causes (see below) are
  consistent with local-green/CI-red. Architect investigates.
- Q: Should the architect block on user-approval before pushing diagnostic
  changes to a feature branch and watching CI output?
  → A: No. Pushing to a non-`main` branch and reading CI logs is acceptable
  autonomous work. Only merging to `main` requires the normal review chain.

## Open questions for architect

The architect's design pass should converge on ONE of these (or another, if
the diagnostic data points elsewhere):

1. **Memory pressure.** The `recursive_prep` CTE in `compute_menu_capacity`
   can fan out (depth 5 × N ingredients = up to N⁵ rows in worst case). On
   the GitHub Actions runner (~7 GB memory, default `work_mem` 4 MB), a large
   CTE intermediate could spill aggressively or trigger an OOM-kill of the
   backend. **Verify:** add `EXPLAIN (ANALYZE, BUFFERS)` for the worst-case
   arm and log query plan + buffer usage in CI.
2. **No `statement_timeout` set.** A runaway query takes the whole backend
   down because nothing kills it before it exhausts resources. **Verify:**
   add `set local statement_timeout = '30s'` at the top of the test and
   observe whether CI now gets a clean SQL error instead of a connection
   drop.
3. **Postgres 17 JIT crash on complex CTE.** Postgres 17's JIT (on by
   default) has had backend SIGSEGV bugs on some recursive-CTE shapes.
   **Verify:** add `set local jit = off` at the top of the test and observe.
   If the crash goes away, this is the cause; the fix is either to keep
   `jit = off` in the test or to file upstream.
4. **`set local role anon` + SECURITY DEFINER + REVOKE EXECUTE interaction.**
   Arm 10 sets `local role anon` and invokes the SECURITY DEFINER function
   that should fail with `42501`. The crash happens AROUND this transition.
   Could be a backend bug on permission-denial path inside a recursive CTE.
   **Verify:** isolate arm 10 in a minimal repro outside the larger test.
5. **Seed data shape regression between spec 059 and spec 060.** If anything
   in [supabase/seed.sql](supabase/seed.sql) changed to introduce a
   pathological prep-recipe chain, the recursive CTE would hit it on the
   broad arms (1)–(6) before reaching arm 10. **Verify:** `git log -p
   supabase/seed.sql` between specs 059 and 060.

If memory: should the test set `local work_mem`, or should the RPC's CTE be
tightened?
If statement timeout: should the test set `local statement_timeout` so the
backend dies gracefully?
If JIT: should the test set `local jit = off` (test-local) or should we
disable JIT for the whole pgTAP suite in [scripts/test-db.sh](scripts/test-db.sh)?
If seed data: should the test create its own isolated synthetic data and not
rely on `seed.sql` baseline?

The architect chooses based on what the CI diagnostic run actually shows.

## Dependencies

- [supabase/tests/compute_menu_capacity.test.sql](supabase/tests/compute_menu_capacity.test.sql) — the test (453 lines)
- [supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql) — the RPC (318 lines; depth-5 cap, visited-array cycle guard)
- [.github/workflows/test.yml](.github/workflows/test.yml) — Track 2 invokes `npm run test:db`
- [scripts/test-db.sh](scripts/test-db.sh) — the test runner
- [supabase/seed.sql](supabase/seed.sql) — 286 KB seed pulled from prod 2026-05-02
- Spec 060 (introduced both files above)
- Spec 064 (added the separate `db-migrations-applied.yml` gate that did NOT catch this)

## Sequencing

1. Architect produces design doc with diagnostic plan. Architect MAY push
   diagnostic statements (logging current settings, query plans, intermediate
   row counts) to a feature branch and observe CI runs to converge on the
   actual cause. Paper-only design is not required to be complete before this
   experimentation.
2. Architect sets `Status: READY_FOR_BUILD` once root cause is identified and
   fix approach is committed.
3. Backend-dev implements the fix on the same or a fresh branch.
4. Reviewers verify per normal pipeline.
5. Push to a branch and confirm CI passes (Track 2 green + the 4 cascade
   victims green) BEFORE merging to `main`. This is the load-bearing
   verification step — local-pgTAP-green is NOT proof of CI-pgTAP-green for
   this spec.
6. Merge.

## Project-specific notes

- **Cmd UI section / legacy:** N/A — DB / CI infrastructure spec.
- **Per-store or admin-global:** N/A — schema/test only.
- **Realtime channels touched:** none.
- **Migrations needed:** possibly — if the architect decides the fix is on the
  RPC side (depth tightening, work_mem hint, etc.) a new migration would
  supersede or alter
  [supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql).
  Test-only fixes do not need a migration.
- **Edge functions touched:** none.
- **Web/native scope:** N/A — backend/CI only. No client-app change.
- **Tests track (per spec 022):** pgTAP DB tests. The fix may also need a
  shell-smoke confirmation that `npm run test:db` exits 0 locally, but the
  authoritative gate is CI Track 2 itself.
- **app.json slug:** untouched. (`towson-inventory` remains; see CLAUDE.md
  "app.json slug mismatch (DO NOT AUTO-FIX)".)
- **Realtime publication gotcha:** N/A — no publication change.
- **Bind-mount-captures-CWD gotcha:** N/A — no edge function involvement.

## Backend design

### Root cause (confirmed by codebase archaeology — no CI experiment needed)

The crash is suspect cause **(d)** from "Open questions for architect" — the
`set local role anon` + dynamic-EXECUTE-in-pgTAP-`throws_ok` interaction. It
is **a known, previously-diagnosed, previously-fixed regression** in this
exact codebase. The spec-060 author missed the established workaround.

**Evidence — two existing test files explicitly document this exact crash:**

1. `supabase/tests/reports_anon_revoke.test.sql` lines 31-42 (the
   "IMPLEMENTATION NOTE (rewritten 2026-05-18, post-spec-045)" block):

   > Prior version used `set local role anon` + `throws_ok` to verify the
   > 42501 SQLSTATE at runtime. That pattern segfaulted Postgres in CI
   > under the supabase/setup-cli@v1 `latest` image (newer pg-version), and
   > the resulting server crash cascaded into 3 unrelated tests failing
   > with "database system is in recovery mode". Switched to
   > `has_function_privilege('anon', <sig>, 'EXECUTE')` which queries the
   > catalog directly — same end-state assertion (anon has no EXECUTE),
   > no role switch, no dynamic-EXECUTE crash.

2. `supabase/tests/cross_brand_copy.test.sql` lines 17-19 (a permanent
   warning to future authors):

   > Anon-revoke (arm 3) uses `has_function_privilege('anon', ..., 'EXECUTE')`
   > per the spec 045 rewrite — do NOT use `set local role anon` (segfaults
   > under newer pg-version in CI).

**Why the diagnosis is high-confidence without a CI experiment:**

- `compute_menu_capacity.test.sql` line 437 (`set local role anon;`) is the
  **only remaining** occurrence of this pattern in the entire test suite
  (`grep -rn 'set local role anon' supabase/tests/` returns exactly three
  files; the other two reference it only inside comments warning against
  it).
- The CI failure signature (`server closed the connection unexpectedly`)
  on the line immediately following the role switch + `throws_ok` matches
  spec 045's prior signature byte-for-byte.
- The cascade-victim count (4 alphabetically-subsequent tests in recovery
  mode) matches the same blast pattern documented in
  `reports_anon_revoke.test.sql` ("cascaded into 3 unrelated tests"). The
  count differs only because more tests were added between spec 045 and
  spec 060.
- Reading the spec 060 reviewer files (`specs/060/reviews/`) confirms none
  of the four reviewers (code-reviewer, security-auditor, test-engineer,
  backend-architect post-impl) caught the anti-pattern. This is the kind
  of pattern that escapes review because the test passes locally on every
  Postgres image except the supabase/setup-cli `latest` CI image — exactly
  the local-green/CI-red asymmetry we observed.

**What the underlying Postgres bug actually is** (informational; not
required to act on the fix): when the calling role is switched mid-
transaction to `anon` and then `throws_ok` invokes a SECURITY INVOKER
function via dynamic EXECUTE that walks back through PostgREST's
permission-denial path, certain Postgres versions SIGSEGV the backend
inside the JIT-compiled permission check (or the recursive CTE plan node,
depending on the function shape). The bug surfaces on the GitHub Actions
runner's pg image, not on local Docker images. The exact upstream bug ID
is not material — spec 045 already established that the project-side fix
is to switch from runtime role-execution to catalog-querying.

Confidence: **high.** I would not need a diagnostic CI run to be sure. If
the user wants belt-and-suspenders confirmation, the implementer can push
the fix to a branch and observe `test.yml` Track 2 go green before
merging (this is already AC2's verification step), which costs one CI run
either way. Skipping a diagnostic-only branch saves three CI cycles.

### Fix design

**No migration. No RPC change. Two test-file edits.**

#### Edit 1 — `supabase/tests/compute_menu_capacity.test.sql`

Replace arm 10 (lines 436-446) so it uses the established
`has_function_privilege` pattern instead of `set local role anon` +
`throws_ok`. The new arm asserts the same end-state contract that spec
060's arm 10 was trying to verify — that anon lacks EXECUTE on
`compute_menu_capacity(uuid)` because of the
`revoke execute ... from public, anon` declarations in the migration —
without round-tripping through Postgres' permission-denial code path at
runtime.

Net effect on the test:

- Plan stays at `select plan(16)` — arm 10 still counts as one assertion.
- Body change: replace the `set local role anon; select throws_ok(...)`
  block with a single `select ok(not has_function_privilege('anon',
  'public.compute_menu_capacity(uuid)', 'EXECUTE'), '(10) anon: lacks
  EXECUTE (REVOKE EXECUTE)')`.
- The trailing comment block ("pgTAP throws_ok matches SQLSTATE; ...")
  becomes obsolete — replace it with a brief reference to the
  reports_anon_revoke.test.sql implementation note so the next author
  doesn't re-introduce the anti-pattern.
- Final `select * from finish(); rollback;` lines untouched.

#### Edit 2 — `supabase/tests/reports_anon_revoke.test.sql`

Add `compute_menu_capacity` to the existing anon-revoke audit (which is
already the canonical place for these assertions across all reports +
EOD RPCs). Bumps `plan(12)` → `plan(13)`, adds one more `ok(not
has_function_privilege(...))` arm at the end. This is **belt-and-
suspenders coverage** so the spec 016 GRANT-lockdown lesson stays
enforced for `compute_menu_capacity` in the same place every other
report-style RPC lives.

This second edit is not strictly required to fix the crash (Edit 1 alone
is enough), but it costs near-zero and prevents future drift if someone
ever refactors `compute_menu_capacity.test.sql` and accidentally removes
arm 10 — the grant lockdown would still be exercised by the
catalog-style audit in `reports_anon_revoke.test.sql`.

### Data model changes

**None.** No new tables, columns, indexes, migrations.

### RLS impact

**None.** No policy changes. The fix is test-only.

### API contract

**Unchanged.** `compute_menu_capacity(p_store_id uuid)` retains its
existing signature, return shape, error cases. The `revoke execute ...
from public, anon` already in the migration (lines 315-316) is the
single source of truth for anon-revoke; the test is merely asserting it
via a different (non-crashing) query shape.

### Edge function changes

**None.**

### `src/lib/db.ts` surface

**None.**

### Realtime impact

**None.** No publication change. The realtime publication gotcha
(`docker restart supabase_realtime_imr-inventory`) does NOT apply.

### Frontend store impact

**None.**

### Risks and tradeoffs

**Risk 1: the fix doesn't actually take.** Low probability — the pattern
is already validated in production CI by `reports_anon_revoke.test.sql`
(rewritten 2026-05-18) and `cross_brand_copy.test.sql`. Both pass CI on
every run since spec 045. The mechanism is well-understood.

**Risk 2: arm 10's runtime semantic coverage is weakened.** True — the
old arm exercised the actual permission-denial code path at runtime; the
new arm only asserts the catalog state. Spec 045's design decision
(documented inline in `reports_anon_revoke.test.sql`) is that this
tradeoff is acceptable: the GRANT layer is the **only** mechanism that
denies anon, so catalog-state assertion is sufficient end-state coverage.
Runtime-path coverage at the anon role is not recoverable without the
crash. Accepting spec 045's precedent here.

**Risk 3: cycle/depth-cap correctness isn't touched.** Confirming
explicitly: arms (1)-(8) (capacity math, transitive prep, cycle handling,
depth cap, no-BOM, zero-stock, unit mismatch, low-count) all stay
intact. Arm 9 (foreign-store RLS) stays intact. Only arm 10 changes.

**Risk 4: the underlying upstream Postgres bug isn't filed.** Out of
scope. Spec 045 already didn't file upstream; we're not regressing the
project-side workaround. A follow-up "audit pg image for SIGSEGV on
role-switch + dynamic-EXECUTE" spec could pursue this, but is not
required by AC1-AC4.

**Risk 5: CI is currently red and AC4 requires gating on it.** Spec 067
already addressed the chicken-and-egg in its own acceptance criteria
("AC4 mechanism must handle the 'test.yml currently red' boot case").
The fix lands → CI goes green → only THEN can the gate be enabled. See
AC4 design below.

### AC4 process change — CLAUDE.md update (preferred), plus a defense-in-depth gate

**Recommended:** option (a) — add a "check CI status after every push to
`main`" rule to CLAUDE.md's agent workflow section. Specifically, append
a bullet to the "Agent workflow" section requiring `release-coordinator`
(and any agent that recommends a final merge) to confirm the most recent
`test.yml` run on `main` is green BEFORE recommending SHIP_READY. This
is text-only, costs nothing, and avoids the chicken-and-egg of gating
merges on a currently-broken workflow.

**Also recommended (defense in depth, follow-up spec):** option (b) —
extend `db-migrations-applied.yml` (or a new sibling workflow) to also
gate on the **previous successful `test.yml` run on `main`**, not the
current PR's run. The "previous successful" tense breaks the
chicken-and-egg: the gate goes live only after the first green
post-merge run lands, and a regression that breaks `test.yml` on `main`
will block subsequent merges until repaired. This is a follow-up spec
because designing and validating cross-workflow status checks is bigger
than what 067 should bundle.

The implementer should land option (a) (CLAUDE.md edit) in the same PR
as the test fix. Option (b) is filed as a follow-up.

**Out of scope for the implementer:** option (c) (GitHub Actions
notification settings) — that's user-account configuration the agent
cannot reach.

### Files the implementer will touch

- `supabase/tests/compute_menu_capacity.test.sql` — replace arm 10 body
  (lines 436-446) with the `has_function_privilege` pattern; remove the
  obsolete trailing comment block (lines 448-450).
- `supabase/tests/reports_anon_revoke.test.sql` — add arm 13 for
  `compute_menu_capacity`; bump `plan(12)` → `plan(13)`. Update the
  header comment's RPC count from "12" to "13" and add the new RPC to
  the bullet list.
- `CLAUDE.md` — append the CI-status-check rule to the Agent workflow
  section (the user owns CLAUDE.md; the implementer drafts the change
  but the user confirms the wording).

### Verification plan

1. Implementer runs `npm run test:db` locally — all 35 .test.sql files
   pass (including the modified two). This confirms the local-pass
   posture is preserved.
2. Implementer pushes to a feature branch (NOT `main`) and watches
   `test.yml` Track 2. The 5 previously-failing tests must all pass:
   `compute_menu_capacity` (full 16 arms), `copy_brand_catalog`,
   `cross_brand_copy`, `delete_last_privileged_guard`,
   `demote_self_guard`.
3. Implementer merges to `main` only after step 2 is green. This
   discharges AC2 + AC3.
4. CLAUDE.md edit lands in the same commit. This discharges AC4(a). The
   follow-up spec for AC4(b) is filed separately (out of 067's scope).

### Open questions for the user

None. All five suspect causes from the spec are resolved by the
codebase evidence above — (a)-(c) and (e) are ruled out because (d) is
positively confirmed by two existing test files with identical prior
incident reports, and the fix is the same one the project already
adopted in spec 045 for the same anti-pattern.

## Files changed

### pgTAP tests
- `supabase/tests/compute_menu_capacity.test.sql` — arm 10 rewritten to use
  `has_function_privilege('anon', ..., 'EXECUTE')` per spec 045 pattern;
  obsolete trailing comment block removed; `plan(16)` unchanged.
- `supabase/tests/reports_anon_revoke.test.sql` — added arm 13 covering
  `compute_menu_capacity(uuid)` (belt-and-suspenders); bumped
  `plan(12)` → `plan(13)`; header comment count and bullet list updated
  from 12 to 13 RPCs.

### CLAUDE.md
- Not modified by the implementer. Wording for AC4(a) is drafted in the
  handoff payload below for user approval; the user owns the file edit.

## Handoff

next_agent: backend-developer
prompt: Implement the test-file fix designed in this spec's
  `## Backend design` section. The root cause is the `set local role anon`
  + `throws_ok` anti-pattern at line 437 of
  `supabase/tests/compute_menu_capacity.test.sql`; spec 045 already
  established the catalog-querying replacement pattern. Two edits:
  (1) rewrite arm 10 of `compute_menu_capacity.test.sql` to use
  `has_function_privilege('anon', 'public.compute_menu_capacity(uuid)',
  'EXECUTE')` per the pattern in `reports_anon_revoke.test.sql`, keeping
  `select plan(16)` and the 16-arm count;
  (2) add `compute_menu_capacity` as arm 13 in
  `reports_anon_revoke.test.sql`, bumping `plan(12)` to `plan(13)`;
  (3) draft the CLAUDE.md "check CI after every push" rule per AC4(a)
  and surface to the user for wording approval (do not auto-merge the
  CLAUDE.md edit without user signoff).
  Verify locally with `npm run test:db`, push to a feature branch (NOT
  main), confirm CI Track 2 is green INCLUDING the four cascade victims,
  then set Status: READY_FOR_REVIEW and list the changed files under
  ## Files changed. Do NOT merge to main without explicit user approval.
payload_paths:
  - specs/067-compute-menu-capacity-test-ci-crash.md
  - supabase/tests/compute_menu_capacity.test.sql
  - supabase/tests/reports_anon_revoke.test.sql
  - CLAUDE.md
