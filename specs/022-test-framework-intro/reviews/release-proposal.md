## Verdict

verdict: SHIP_READY
rationale: Zero Critical findings across all four reviewers; all three test tracks run green locally; the four overlapping should-fix/medium items are hygiene-shape (CI timeouts, least-privilege permissions block, TAP plan-mismatch grep gap, `tsconfig.test.json` empty `exclude`) and not security or correctness blockers — well-suited to a round-2 polish patch or to fold into spec 023 alongside retroactive coverage.

## Findings summary

- **code-reviewer**: 0 Critical, 3 Should-fix, 6 Nits. Top should-fix items: (S1) `scripts/test-db.sh:111` TAP plan-mismatch grep doesn't actually catch `# Looks like you planned N tests but only ran M` — the comment is misleading and the parser will false-PASS a silent assertion-count drift; (S2) `.github/workflows/test.yml` has no `timeout-minutes` on either job — defaults to 6h, a hung `supabase start` could hold a CI slot indefinitely; (S3) `tsconfig.test.json:12` empty `"exclude": []` overrides TypeScript's built-in default exclusions (removes `node_modules` from excluded set), making `typecheck:test` noisier and slower once it becomes a CI gate. Nits are stylistic/documentary (`setupFilesAfterEach` typo carried in spec, Toast mock shape, psql `-q` flag comment, temp-table `on commit drop` redundancy, etc.).

- **security-auditor**: 0 Critical, 0 High, 1 Medium, 5 Low. Top item: (M1) `.github/workflows/test.yml` missing explicit `permissions:` block — workflow inherits repo-default `GITHUB_TOKEN` scope which may grant `contents: write`/`pull-requests: write`; fix is a one-line `permissions: { contents: read }` at workflow level. Low items: action SHA-pinning vs tag-pinning (`actions/checkout@v4`, `supabase/setup-cli@v1`); committed local-dev defaults in `smoke-rpc.sh` (verified local-only — `supabase start`'s stable publishable key); no hardening against running smoke-against-remote with default creds; superuser `psql` exec in `test-db.sh` (intentional, same trust boundary as committed migrations); hardcoded local-seed UUIDs in DB tests (verified seed-stable constants, not prod identifiers). Dependency impact: 5 new LOW-severity dev-only npm vulns in the `jest-expo` → `jsdom` → `http-proxy-agent` transitive chain — no production runtime path. Pre-existing `@xmldom/xmldom` HIGH (via `expo` build-time tooling) is not from this spec and not addressable without an `expo` major downgrade — defer to separate dependency-hygiene pass.

- **test-engineer**: 25 ACs PASS, 1 cosmetic FAIL (AC3-2: `scripts.smoke` was renamed to `scripts.test:smoke` — functionally identical, exits propagate, README documents the renamed script; arguably better UX grouping with `test`/`test:db`/`test:all`), 1 NOT TESTED (AC4-4: README still references `db-migrations-applied.yml` — user-directed deferral per spec). Coverage gaps: none new (the spec is the framework itself, not retro coverage). Track 1 green: 14/14 jest assertions across `relativeTime.test.ts` (9) and `StatusPill.test.tsx` (5). Track 2 green: 8 pgTAP assertions across 2 files. Track 3 green: smoke-rpc.sh login + 200 + envelope shape all pass. Developer-experience probe (blank file → green test in <3 minutes) validates the iteration loop. Verdict: **APPROVE with follow-ups**.

- **backend-architect** (post-impl drift review): 0 Critical drift, 0 block. Two named drifts both approved as *correctness improvements* over the design (`pg_prove` → raw psql+TAP parsing because `pg_prove` isn't in the Supabase image; `service_role` JWT → `admin@local.test` login round-trip because `auth_is_admin()` reads `app_metadata.role`, which service-role JWTs don't set). One additive drift surfaced and documented: the transitive store-import gotcha (any component that calls `useColors`/`useCmdColors` transitively imports `useStore` → `db.ts` → `supabase.ts` which crashes at import time without env vars) — captured in `tests/README.md:81-111` and flagged for spec 023's architect to pre-warn at design time. The hybrid-mocking demo landing as docs (not a wired `db.ts`-boundary mock test) is the §11.5 fallback the architect explicitly prescribed for the case where the demo would force testing `useStore.ts`. 9 forward-compat items documented for spec 023.

### Independent verification (local)

- `npm test -- --ci`: PASS (2 suites, 14 tests, ~0.5s)
- `npm run test:db`: PASS (2 files, 8 assertions)
- `npm run test:smoke`: PASS (all checks green; 2 pre-existing SKIPs in `smoke-edge.sh` are not new)
- `.github/workflows/test.yml`: valid YAML — two jobs (`jest`, `db`), both triggers (`push`, `pull_request`), no `permissions:` block, no `timeout-minutes:` (confirms M1 + S2).

## Recommended next steps (ordered)

**Recommendation: SHIP NOW** and queue the four bundled items into spec 023 alongside the retroactive Critical-coverage work. Reasoning:

1. No Critical findings from any reviewer.
2. All three test tracks run green locally.
3. The four items are pre-existing-hygiene-shape, not security or correctness blockers (the security M1 is least-privilege defense-in-depth; the workflow does no token-using operations and runs only with read-needed actions).
4. Spec 023's natural scope already touches test files (retroactive coverage of specs 016/018/019/020/021's Criticals), so bundling these four with it keeps PR scope coherent.
5. The CI workflow is on disk; the user's manual push remains needed regardless of these four items per the workflow-scoped-token caveat.

If the user instead prefers a round-2 polish patch before shipping spec 022, the four items are small (~30 min, low risk) and clearly scoped:

1. **CI `permissions:` block** (security M1, ~1 min): add `permissions: { contents: read }` at workflow level in `.github/workflows/test.yml`. Least-privilege defense-in-depth.
2. **CI `timeout-minutes`** (code-reviewer S2 + test-engineer, ~1 min): add `timeout-minutes: 15` to the `jest` job and `timeout-minutes: 30` to the `db` job in `.github/workflows/test.yml`. Caps blast radius on a hung `supabase start` or runner stall.
3. **`scripts/test-db.sh` plan-mismatch grep** (code-reviewer S1 + test-engineer, ~5 min): add a third grep matching `'# Looks like you planned\|# Looks like you ran'` after the existing two grep guards (around line 116), so the wrapper catches the silent-assertion-count-drift case the current parser misses. Rename the comment on the existing `# Looks like you failed` grep from "plan/finish mismatch" to "assertion failures" to remove the misleading label.
4. **`tsconfig.test.json` `exclude`** (code-reviewer S3 + test-engineer, ~1 min): either drop the `"exclude": []` key entirely (inherits parent's exclusions) or set it to `["node_modules"]`. Restores TypeScript's default `node_modules` exclusion for `typecheck:test`.

The fix order above reflects severity-first (security M1 first), then dependency (the `test-db.sh` fix needs the runner to be exercised once after the edit — bundling with the CI fixes keeps the verify loop tight).

## Out of scope for this review

- **Retroactive Critical coverage for specs 016, 018, 019, 020, 021** — spec 023's primary scope. `tests/README.md:378-399` already holds the prioritized target list; backend-architect's forward-compat items 1-3 reiterate priority order (spec 019 trigger arms first, then spec 016 dispatcher arms, then spec 020 EOD consistency, spec 021 MIN-DOW RLS, spec 018 variance template).

- **Transitive store-import gotcha at architect-design-time** — backend-architect forward-compat item 7. The current `tests/README.md` covers it reactively; the next architect's design should pre-warn for any component test that touches `useColors`/`useCmdColors`.

- **`@testing-library/jest-native` migration** — deprecated; swap to built-in matchers from `@testing-library/react-native@^13`. Trivially reversible, defer until baseline coverage exists so the migration is a controlled swap.

- **`useStore.ts` / `webPush.ts` type cleanup** — `typecheck:test` reports pre-existing errors in these two files; cleaning them unlocks `typecheck:test` as a CI-enforceable gate. Sequencing: do BEFORE wiring `typecheck:test` into CI.

- **Cross-store INSERT scenario for `inventory_counts`** — backend-architect §5 noted this was prescribed but landed as a different shape (the `42501` auth-gate covers cross-store reads via the `report_run_cogs.test.sql` file). Add a sibling test file in spec 023.

- **`react-native-reanimated` jest mock** — not needed for v1 (StatusPill doesn't use reanimated). First future test that touches a reanimated-driven component will need the package's official mock in `tests/jest.setup.ts`.

- **Component-test boundary mock of `db.ts`** — no v1 example exercises the canonical `jest.mock('@/lib/db', ...)` pattern in a wired test (StatusPill doesn't call `db.ts`). First spec-023-era test that DOES call a `db.fetch*` helper is the canonical proof point.

- **`@xmldom/xmldom` HIGH-severity transitive vuln** — pre-existing via `expo` → `@expo/cli` → `@expo/plist` iOS-build tooling. Not introduced by this spec. `npm audit fix --force` proposes major downgrades (`expo@49`, `jest-expo@47`) — do not auto-apply. Address in a standalone dependency-hygiene pass.

- **`db-migrations-applied.yml` README cleanup** — workflow-scoped-token push issue unresolved per CLAUDE.md. README still references the never-pushed workflow at line 137 and 224. User-directed scope deferral on this spec; resolve when token issue is resolved or as a standalone doc PR.

- **CI required-status-check toggle for the `db` job** — backend-architect §6 + risk §2: do not promote the `db` job to required status until cold-boot stability is observed in a real CI run. Repo-settings concern, not file-shape.

## Handoff
next_agent: NONE
prompt: SHIP_READY (recommendation: ship now, fold 4 small hygiene items into spec 023; alt: ~30-min round-2 polish patch first). Top item: CI `permissions:` block + `timeout-minutes` + `test-db.sh` plan-mismatch grep + `tsconfig.test.json` empty `exclude`.
payload_paths:
  - specs/022-test-framework-intro/reviews/release-proposal.md
