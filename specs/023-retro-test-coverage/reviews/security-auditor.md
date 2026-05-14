# Security audit for spec 023

Scope: test-only retroactive coverage spec. 11 new pgTAP DB tests + four
forward-compat cleanups (B1 jest-native dep removal, B2 README cleanup, B4
`seedVarianceDates` extract + colocated jest test, B5 docs). No new
migrations, no new RPCs, no edge function changes, no `app.json` touch.
Threat-model surface is **CI side-channel + test-environment leakage** —
nothing in this spec touches the production runtime.

Files audited:
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/package.json` (B1 dep drop verified)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/package-lock.json` (lockfile sweep for jest-native residue)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/jest.config.js` (B1 setupFilesAfterEnv removal verified)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/README.md` (B2 cleanup verified)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/utils/seedVarianceDates.ts` (B4 extracted helper)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/utils/seedVarianceDates.test.ts` (B4 mock-pattern test)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/NewReportModal.tsx` (B4 callsite import swap)
- 11 new pgTAP `.test.sql` files under `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml` (unchanged, but now ingests 11 more tests)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/test-db.sh` (unchanged, sanity-checked output handling)

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/tests/reports_anon_revoke.test.sql:50` — the test does `set
  local role anon` inside its `begin; ... rollback;` block. This is the
  *correct* shape to exercise the spec-016 anon GRANT-revoke contract,
  and pgTAP runs as the superuser `postgres` user (which can `SET ROLE
  anon`), so the operation works in CI. The role switch is transaction-
  local and discarded on rollback. No security risk in the local pgTAP
  runner — but worth a note: this is the first test in the suite that
  drops privilege to `anon`, and any future test that imitates the
  pattern needs to keep the `set local` form (not bare `SET ROLE`) so
  privilege doesn't leak past the `rollback`. The architect's design
  notes this in the test file header. Not a finding against this spec —
  noted for the next agent who copies the pattern.

- `supabase/tests/*.test.sql` (all 11 new files) — every test
  impersonates the seeded user UUIDs (`11111111-...` admin,
  `22222222-...` manager, `33333333-...` master) via
  `set_config('request.jwt.claims', ...)`. These UUIDs are local-only
  test fixtures from `supabase/seed.sql:23,79,131`, NOT real production
  user IDs (verified). Emails on those seeded users are `@local.test`
  (clearly synthetic). The pattern is appropriate for pgTAP and matches
  the proven shape from `report_run_cogs.test.sql`. Worth surfacing in
  case prod gets re-seeded with these UUIDs at some point in the future
  — if prod ever maps `11111111-...` to a real human, every test in
  this suite would impersonate that human against the local stack. Risk
  is theoretical (the UUIDs are clearly placeholder shapes, not the kind
  of UUIDs Supabase auto-generates) and the tests only run against
  hermetic local Postgres, never against prod.

- `supabase/tests/report_reorder_list_min_dow.test.sql:25-30` — the test
  acknowledges a 1-second wall-clock flake window at the end of the UTC
  day (cutoff = `23:59:59` and the runner reads `(now() at time zone
  'utc')::time`). This is a CI **reliability** concern, not a security
  one — but if a flaky CI run is treated as "merge-able anyway" without
  investigation, real regressions could slip through. Architect already
  documented the trade-off. Not a security blocker. Surfacing in case
  a future agent decides to silence the test on flake instead of fixing
  the time injection.

## Dependencies

`npm audit --audit-level=high` summary (run against the post-B1
lockfile):

```
11 vulnerabilities (5 low, 5 moderate, 1 high)
```

**Identical totals to spec 022's baseline** (same 5 low / 5 moderate /
1 high — verified by comparing to
`specs/022-test-framework-intro/reviews/security-auditor.md:142`). The
B1 removal of `@testing-library/jest-native` did NOT introduce any new
vulnerabilities or change the existing counts. Removed cleanly:
- `package.json:62-74` devDependencies no longer carries the entry.
- `package-lock.json` has zero `@testing-library/jest-native` matches
  (only `@testing-library/react-native` remains).
- `jest.config.js:78-83` has no `extend-expect` line — replaced with an
  explanatory comment.

The 11 carry-over vulnerabilities are the same dep-hygiene backlog that
spec 022's security review flagged (jsdom/dompurify/postcss chains
behind jest-expo + expo). All are deferred to a dedicated dependency-
hygiene spec per spec 023 "Out of scope" line 250. **No new findings
against spec 023 specifically.**

### Specific verification against the prompt's checklist

**1. `npm audit` regression after B1 — clean.** Vulnerability count
unchanged vs. spec 022 baseline (11 → 11). No new orphan transitive
vulns introduced by removing `@testing-library/jest-native`. The
dependency removal is `node_modules`-clean.

**2. JWT impersonation patterns in 11 pgTAP files — clean.** All
`set_config('request.jwt.claims', ...)` calls use the seeded synthetic
UUIDs (`11111111-...`, `22222222-...`, `33333333-...`) pinned in
`supabase/seed.sql` to `@local.test` emails. Zero hardcoded API keys,
zero service-role bearer tokens, zero real credentials in any test
file. Every test is framed `begin; ... rollback;` so all
`set_config('request.jwt.claims', ...)` and `set local role
{authenticated,anon}` are transaction-local and rolled back; nothing
leaks past the test boundary. The tests run only against local
Postgres (CI `supabase start` cold-boot, or `npm run dev:db` locally)
— never against prod. No environment leakage path identified.

**3. B4 mock pattern in `seedVarianceDates.test.ts` — clean.** The test
mocks `../lib/db` via `jest.mock(...)`, so `fetchRecentEodDates` is
replaced with a `jest.fn()` before any module-graph traversal hits
`src/lib/supabase.ts`. The actual Supabase client is NEVER constructed
during this test — confirmed by:
- `seedVarianceDates.ts` only imports `fetchRecentEodDates` from
  `../lib/db`, which is the boundary the test mocks.
- The test file has zero references to `supabase.ts`, `createClient`,
  `supabaseUrl`, anon-key, service-role-key, or any env-var lookup
  (verified by `grep`).
- Mock return values are inline literals (`['2026-05-02',
  '2026-05-01']`, `'network down'` error message) — no env-var
  interpolation.
- The test will run cleanly in CI without any `.env` present (the
  comment at line 9 explicitly documents this).

**4. CI workflow secrets exposure — clean.** `.github/workflows/test.yml`
has no `env:` block, no `secrets.*` references, and explicit
`permissions: contents: read` (least-privilege). The job runs only
`actions/checkout@v4`, `actions/setup-node@v4`, `supabase/setup-cli@v1`,
`npm ci`, `npm test`, `supabase start`, `npm run test:db`, `supabase
stop`. None of these touch a secret. The `test-db.sh` runner prints
pgTAP `ok N - <description>` lines plus full psql output on failure;
the descriptions contain test-fixture UUIDs (synthetic) but no JWT
claim *bodies* are printed to logs — the `set_config('request.jwt.claims',
...)` call returns the claim string but the test wraps it in `select
set_config(...)`, which discards the return into the void. Even if a
debug `\set ECHO_ALL on` were enabled, the printed claims are the
synthetic-UUID jsonb blobs that already live in `supabase/seed.sql`.
No real-credential exposure path.

**5. README cleanup (B2) — clean.** `grep -n 'db-migrations-applied'
README.md` returns zero matches (verified). The structure-summary
section at `README.md:131-138` cleanly shows `test.yml` as the only
workflow. The CI section at `README.md:222-226` is rewritten to point
at `test.yml` + `tests/README.md`, and no orphan heading anchors are
created or destroyed — the `## CI` heading itself is preserved (so any
external doc that linked to `#ci` continues to work). No broken
references.

### Additional cross-checks

- **Test-engineer reviewer's scope (Track A → spec-022 baseline):** The
  11 new tests do exactly what the spec promises — exercise existing
  RLS / trigger / RPC / GRANT contracts. None of them grants new
  permissions, no new privileges are introduced, no SECURITY DEFINER
  functions are added. The tests are read-only against the security
  model except for direct INSERTs into tables under a manager/admin
  JWT (which the existing RLS allows anyway) and the `update
  public.vendors set order_cutoff_time = ...` (which master JWT can
  legitimately do per spec 021). Nothing in these tests would persist
  beyond the per-test `rollback;` even if a test crashed mid-flight.

- **Hermetic isolation verified:** every `.test.sql` file uses the
  `begin; create extension if not exists pgtap; select plan(N); ...;
  select * from finish(); rollback;` frame. The `create extension if
  not exists pgtap` runs idempotently and is left at session level
  (not rolled back) — but pgtap is a function-only extension that adds
  no rows to user tables, so this is fine. No test leaks state between
  runs.

- **No emails, no PII, no real-shaped data in test fixtures:** the
  only emails are `@local.test` (already in seed). The only personal-
  shape strings are test-item names like `SPEC023-A10-PAR-<uuid>` (in
  `report_reorder_list_hybrid_formula.test.sql`) and `'spec-023 A8
  seed row'` notes — clearly synthetic.

- **No new SECURITY DEFINER or privileged-role usage:** zero
  `security definer`, zero `grant ... to service_role`, zero new
  policy declarations in any of the 11 new files. All are read-side
  tests against existing security boundaries.

- **B4 extracted helper — no privilege change:** `seedVarianceDates.ts`
  is a thin async wrapper around `fetchRecentEodDates` (which already
  ran identically when inlined inside `NewReportModal.tsx`). The
  extract-to-utility transformation is byte-equivalent at runtime; the
  function runs under whatever JWT the caller's PostgREST session has,
  same as before.

- **Realtime / publication membership:** none of the 11 tests touch
  `supabase_realtime`. No publication-membership drift, no realtime
  channel exposure changes.

- **Edge-function changes:** zero functions touched. `verify_jwt`
  settings in `supabase/config.toml` unchanged.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low.
  Vulnerability counts unchanged from spec 022 baseline (11 → 11) —
  B1's `@testing-library/jest-native` removal introduced no new
  transitive vulns. JWT impersonation patterns across all 11 pgTAP
  files use synthetic seed UUIDs only. B4's `seedVarianceDates.test.ts`
  mocks `../lib/db` at the module boundary and never touches the real
  Supabase client. CI workflow remains least-privilege with no secret
  exposure. README cleanup is clean — zero stale references remain.
  Test-only spec; no production runtime surface.
payload_paths:
  - specs/023-retro-test-coverage/reviews/security-auditor.md
