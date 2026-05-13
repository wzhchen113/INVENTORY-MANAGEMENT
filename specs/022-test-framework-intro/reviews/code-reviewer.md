## Code review for spec 022

### Critical

_None._

---

### Should-fix

- `tsconfig.test.json:12` — `"exclude": []` overrides TypeScript's built-in default exclusions, which means `node_modules` is no longer excluded from the type-check pass run by `npm run typecheck:test`. TypeScript's default exclusions (`node_modules`, `bower_components`, `jspm_packages`, `outDir`) only apply when `exclude` is **absent**; an explicit empty array removes them. The fix is to either drop the `"exclude"` key entirely (so the parent's exclusions are inherited) or add `"node_modules"` back explicitly: `"exclude": ["node_modules"]`. This won't cause a test-run regression (jest uses babel, not tsc directly) but will make `typecheck:test` noisier and slower when it becomes a CI gate.

- `scripts/test-db.sh:111` — the comment on line 111 labels the `# Looks like you failed` grep as catching a "plan/finish mismatch", but that is not what pgTAP emits for a count mismatch. pgTAP prints `# Looks like you failed N tests of M` when assertions fail (same message the `^not ok ` grep already covers). A **plan/count mismatch** (running more or fewer assertions than declared in `plan(N)`) emits a different message: `# Looks like you planned N tests but only ran M` or `# Looks like you ran N tests but only planned M`. The current script will not catch a silent plan/count drift — the file exits with `exit 0` from psql, no `not ok` lines appear, and the `# Looks like you failed` grep also misses it. Fix: add a third grep for `'# Looks like you planned\|# Looks like you ran'` (the two pgTAP plan-mismatch messages) as a separate guard, distinct from the assertion-failure check. Or rename the comment to "assertion failures" to stop the plan-count claim from misleading future maintainers.

- `.github/workflows/test.yml` — no `timeout-minutes` is set on either job. Without it, GitHub Actions allows a maximum of 6 hours before auto-cancelling. If `supabase start` hangs (network, image pull, port conflict in CI), the `db` job silently blocks a CI slot for up to 6 hours. Suggested defaults: `jest` job → `timeout-minutes: 15`; `db` job → `timeout-minutes: 30` (accounts for the ~60-90s cold boot the architect noted plus migration apply time). No behavioral change on green runs; limits the blast radius on hangs.

---

### Nits

- `jest.config.js:53` — `setupFilesAfterEnv` is spelled correctly in the implementation, but the architect's prescribed shape in `spec.md:425` uses `setupFilesAfterEach` (a non-existent jest key). The developer silently fixed the typo. Worth noting in case a future engineer cross-references the spec and wonders why the key differs. No action needed in code.

- `tests/jest.setup.ts:19-27` — the Toast mock exports both a `default` export and named `show`/`hide` exports. That is accurate for `react-native-toast-message@2.x` (which exposes both a default-export component and named toast helpers). No issue — but it's slightly over-specified compared to the architect's one-liner stub. No change needed; just noting it mirrors the real module shape rather than the minimal stub.

- `scripts/test-db.sh:92` — the `psql` flags include `-q` (quiet) alongside `-A -t`. In practice `-q` suppresses the pgTAP `1..N` plan header line since psql treats it as a notice. The script still catches failures via `not ok` and `# Looks like you failed`, but the success-case `ok N` count on line 119 is the only signal that assertions ran at all. If psql `-q` also suppresses `ok N` lines (it doesn't — those come from pgTAP's `SELECT` output, not from psql's own messages), the pass count reported would be 0. Tested locally and passing, so this is not a blocking issue, but worth a comment explaining why `-q` is safe here alongside `-A -t`.

- `supabase/tests/inventory_counts_set_submitted_by.test.sql:66-85` — the INSERT uses a CTE + `create temp table ... as` pattern to capture the `RETURNING id`. The inline comment explains this is a Postgres limitation (can't do `create temp ... as insert ... returning` directly). The explanation is correct and the workaround is clean; the comment earns its place. Minor: the comment could mention that `on commit drop` is redundant here because the whole transaction rolls back anyway — keeping it is fine as a belt-and-suspenders signal, but someone might wonder why it's there.

- `smoke-rpc.sh:45` — the default `SUPABASE_ANON_KEY` is committed as a literal value. The file header already explains this is the public key and safe to commit, which is correct. No change needed; worth ensuring this comment stays when the file is updated, since developers unfamiliar with Supabase's publishable/anon key model may flag it as a secret.

- `tests/README.md` — the "Risks" subsection under Track 2 mentions overriding `CONTAINER=` for non-default project names, but `test:db` in `package.json` calls `bash scripts/test-db.sh` without passing any env. The override works via `CONTAINER=x npm run test:db` (env prefix), which is correct bash behavior. A one-line note saying `CONTAINER=... npm run test:db` also works (not just `bash scripts/test-db.sh` directly) would save a contributor a moment of confusion.

- `relativeTime.test.ts:37-43` — two related assertions (90s and 60s rounding) are grouped in the same `it('formats minutes ago...')` block. If the 90s assertion fails, jest skips the 60s one. Splitting into two `it()` calls would give clearer per-assertion failure messages. Minor preference; both styles are common.

- `StatusPill.test.tsx:26-38` — the `jest.mock(...)` call is placed before the imports, which is the correct hoisting pattern for jest mocks. The inline comment explains the entire `useStore → db.ts → supabase.ts` import chain that forced this approach. The explanation is thorough and exactly the right content; it matches what `tests/README.md` documents in the "Transitive store-import gotcha" subsection, making both consistent.
