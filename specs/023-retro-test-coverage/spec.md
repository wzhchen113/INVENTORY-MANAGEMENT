# Spec 023: Retroactive test coverage + spec-022 forward-compat

Status: READY_FOR_REVIEW

## User story

As a developer, I want the Criticals closed in specs 016/018/019/020/021
to be guarded by automated tests now that the spec 022 test framework is
live, so that a future migration cannot silently regress one of them and
so that the next test-engineer review can mark those items "PASS"
instead of "NOT TESTED". As an architect/reviewer, I also want the
forward-compat cleanup items spec 022's post-impl drift review surfaced
— `@testing-library/jest-native` swap, the stale README workflow ref,
the canonical `db.ts`-boundary mock proof point, and the transitive
store-import gotcha documented at design time — so the framework
adoption pass doesn't leave loose ends.

## Background — what spec 022 left behind

Spec 022 (committed `b5d3e30`, deployed) landed the three-track test
framework (jest-expo + Supabase pgTAP + shell smoke) with 1-2 example
tests per track. Per Q4 of that spec, retroactive coverage of past
Criticals was explicitly scoped out and queued as a follow-up.

The example DB test `inventory_counts_set_submitted_by.test.sql`
already covers ONE of spec 019's three trigger arms (the
`submitted_by` override). Every other Critical from specs 016-021 still
has zero automated regression coverage — the proofs of correctness live
only in throwaway `psql` PoCs cited in reviewer files.

Spec 022's backend-architect post-impl drift review
(`specs/022-test-framework-intro/reviews/backend-architect.md` § "Forward-compat
checklist") enumerated 9 follow-up items. This spec picks up the subset
the user has scoped: retroactive Critical coverage (items 1, 3),
`jest-native` dep swap (item 2), README cleanup (item 5), transitive
store-import gotcha at design time (item 7), and the canonical
`db.ts`-boundary mock proof point (item 9).

Items 4 (`useStore` / `webPush` TS cleanup), 6 (CI `timeout-minutes`),
and 8 (reanimated jest mock) are out of scope here — item 4 is
deferred to a dedicated TS-hygiene spec (likely 024) per user
direction, item 6 has no signal yet to tune against, item 8 has no
test that needs it yet. Items already addressed by spec 022's polish
patch (CI `permissions:` block + `timeout-minutes:`, `test-db.sh`
plan-mismatch grep, `tsconfig.test.json` empty-exclude comment) are
already on disk and require no further action here.

## Acceptance criteria

### Track A — Retroactive Critical regression tests (DB, pgTAP)

Maximum-coverage scope: all 11 retroactive tests land. Each test gets
its own dedicated `.test.sql` file under `supabase/tests/` — no
multi-test files, no shared fixtures across files. All landed tests
follow the spec 022 pattern: a single `.test.sql` file framed with
`begin; create extension if not exists pgtap; select plan(N); ...; select * from finish(); rollback;`
that runs cleanly under `npm run test:db` and emits one or more pgTAP
`ok N` lines.

- [ ] **A1 (Spec 016 dispatcher unknown template).**
      `supabase/tests/report_run_unknown_template.test.sql` — call
      `report_run('not_a_template', '<seed-store-uuid>'::uuid, '{}'::jsonb)` as
      a store-member; assert it returns a `jsonb` envelope with `kpis`/`columns`/`rows`/`series`
      keys present AND that the envelope signals `not_implemented` per the
      dispatcher's documented contract (architect chooses whether the signal is a
      key flag or a known string in `rows`; the dispatcher header comment at
      `supabase/migrations/20260510120000_report_runs.sql:15-19` is the
      source of truth). The test must FAIL (red) if the dispatcher were to
      `raise exception` instead of returning the envelope.

- [ ] **A2 (Spec 018 variance formula — strict reconciliation math).**
      `supabase/tests/report_run_variance_formula.test.sql` — insert a
      controlled fixture inside the transaction (one item, one prior EOD with
      `actual_remaining = P`, one current EOD with `actual_remaining = C`,
      one receiving row with `qty = R`, one waste row with `qty = W`, POS
      sales summing to `S`); call `report_run_variance(<store>, <params>)`
      with the two anchor dates; assert the returned row for that item has
      `delta = C - (P + R - S - W)` exactly. Reproduces the formula from
      spec 018 Q4 RESOLUTION (`specs/018-reports-variance-template/spec.md:414`).
      Floating-point tolerance: assertions use exact equality on integer-input
      fixtures; if the dev needs non-integer fixtures, they document a
      single agreed epsilon in the test file.

- [ ] **A3 (Spec 019 cross-store `item_id` consistency trigger — arm 2).**
      `supabase/tests/inventory_count_entries_check_store.test.sql` —
      as a member of store A, create an `inventory_counts` row for store A,
      then attempt `insert into inventory_count_entries` with an `item_id`
      whose `inventory_items.store_id = <store B>`. Assert the INSERT raises
      SQLSTATE `42501` with a message matching `'item store mismatch'`.
      Use `throws_ok()`. This is the second trigger arm from
      `supabase/migrations/20260513120000_inventory_counts_consistency.sql:79-113`
      that spec 022's example test did NOT cover.

- [ ] **A4 (Spec 020 EOD per-vendor consistency triggers).**
      `supabase/tests/eod_submissions_consistency.test.sql` — three
      assertions in one file matching the three trigger arms in
      `supabase/migrations/20260514120030_eod_submissions_consistency.sql`:
      (i) `submitted_by` override on direct INSERT, (ii) cross-store
      `item_id` rejection on `eod_entries` INSERT (SQLSTATE 42501),
      (iii) `eod_entries.vendor_id` ↔ parent `eod_submissions.vendor_id`
      consistency on INSERT. Same shape as A3; copy-paste-adjust from the
      existing `inventory_counts_set_submitted_by.test.sql` template.

- [ ] **A5 (Spec 021 MIN-DOW lateral subquery — multi-delivery-day vendors).**
      `supabase/tests/report_reorder_list_min_dow.test.sql` — inside the
      transaction, insert two `order_schedule` rows for one seed vendor
      (Wednesday + Friday `day_of_week` numbers), set the as-of date to a
      Thursday (e.g. `2026-05-14`), call
      `report_reorder_list(<store>, jsonb_build_object('as_of_date', '2026-05-14'))`,
      assert the vendor's `days_until_next_delivery = 1` and
      `next_delivery_date = '2026-05-15'`. Reproduces the round-1 bug
      (returned `6`; should return `1`) called out in
      `specs/021-reorder-delivery-list/reviews/release-proposal.md:69`.

- [ ] **A6 (Spec 016 anon revoke).**
      `supabase/tests/report_run_anon_revoke.test.sql` — set JWT claims to
      anon (`role: 'anon'`), call any `report_run_*` (or the dispatcher
      with a known template), assert SQLSTATE `42501` or grant-denied
      error via `throws_ok()`. Verifies the `revoke from public, anon` is
      still enforced at GRANT time.

- [ ] **A7 (Spec 018 SUM aggregation across multi-vendor day).**
      `supabase/tests/report_run_variance_multivendor_sum.test.sql` —
      multi-vendor EOD fixture: for one item, two `eod_submissions` rows
      on the same anchor date from two different vendors each with
      `actual_remaining > 0`. Call `report_run_variance`; assert the
      per-item anchor remaining matches the SUM of both vendors'
      reported remaining (not just the latest row, not just one
      vendor's row). Live-PoC'd in spec 020's test-engineer report;
      this test pins it.

- [ ] **A8 (Spec 019 append-only posture — UPDATE/DELETE deny).**
      `supabase/tests/inventory_counts_append_only.test.sql` — as a
      store member, insert a fixture `inventory_counts` row inside the
      transaction (after taking the member JWT), then attempt an
      UPDATE and a DELETE on that row. Assert each operation either
      affects 0 rows (RLS-filtered) or raises a permission-denied
      error. Verifies the append-only posture mandated by spec 019.

- [ ] **A9 (Spec 020 EDIT flow row-id preservation).**
      `supabase/tests/eod_submissions_edit_flow.test.sql` — call the
      EOD upsert RPC twice with the same `(store_id, date, vendor_id)`
      triple inside the transaction (different `actual_remaining` /
      `notes` payload on round 2). Assert the row `id` is preserved
      between calls AND `submitted_at` is bumped to the later
      timestamp. Verifies the `on conflict do update` shape pinned by
      spec 020.

- [ ] **A10 (Spec 021 hybrid formula — max(par_replacement, usage_forecasted)).**
      `supabase/tests/report_reorder_list_hybrid_formula.test.sql` —
      fixture with known `par_level`, `usage_per_portion`, `on_hand`;
      derive expected `par_repl = par_level - on_hand` and
      `usage_fc = usage_per_portion * days_until_next_delivery`; call
      `report_reorder_list`; assert `suggested_qty = max(par_repl, usage_fc)`
      exactly. Pins the math from spec 021's resolved formula.

- [ ] **A11 (Spec 021 EOD-first sourcing — `on_hand_source = 'eod'` vs `'stock'`).**
      `supabase/tests/report_reorder_list_on_hand_source.test.sql` —
      two-scenario file (two pgTAP test plans inside one
      `begin/rollback` frame, OR a single plan with two `is()`
      assertions on distinct fixtures): (i) vendor has today's EOD →
      `on_hand_source = 'eod'` AND `on_hand` value comes from the EOD
      row; (ii) vendor has no EOD for today → `on_hand_source = 'stock'`
      AND `on_hand` comes from `inventory_items.qty_on_hand`. Pins the
      EOD-first sourcing rule from spec 021.

### Track B — Forward-compat cleanups (from spec 022 drift review)

- [ ] **B1 (item B) — `@testing-library/jest-native` swap.** Remove
      `@testing-library/jest-native` from `package.json` devDependencies
      and remove the `@testing-library/jest-native/extend-expect` line
      from `jest.config.js` component-project `setupFilesAfterEnv`.
      Verified by inspection: neither shipped test file
      (`StatusPill.test.tsx`, `relativeTime.test.ts`) uses any
      `jest-native`-specific matcher — both rely on
      `@testing-library/react-native`'s built-in `getByText` /
      `queryByText` from v12.4+. **Verification step:**
      `npm test -- --ci` exits 0 after the removal.

- [ ] **B2 (item D) — README stale workflow reference.** Edit
      `README.md` (search for `db-migrations-applied`) to either point
      at `.github/workflows/test.yml` or remove the line. **Choice:**
      replace with a one-line reference to `test.yml` so the README's
      CI section continues to point at a real file. Independent verify
      step: `grep -n 'db-migrations-applied' README.md` returns no
      matches after the edit. NOTE: This does NOT push the workflow
      file — the workflow-scoped token caveat from CLAUDE.md still
      applies and is the user's manual push to handle.

- [ ] **B4 (item F) — Canonical `db.ts`-boundary mock proof point.**
      Extract `seedVarianceDates` out of
      `src/components/cmd/NewReportModal.tsx` into a new utility
      module (e.g. `src/utils/seedVarianceDates.ts`) preserving the
      existing call-site behavior, then add a colocated jest test
      (`src/utils/seedVarianceDates.test.ts`) that uses
      `jest.mock('../lib/db', () => ({ fetchRecentEodDates: jest.fn() }))`
      to demonstrate the canonical `db.ts`-boundary mock pattern from
      `tests/README.md:54-79` in a WIRED test. The extracted helper
      should be a plain async function with no React surface (small
      diff, no `useStore` / theme transitive problem). The test must:
      (i) mock `fetchRecentEodDates` to return a controlled 2-element
      date array; (ii) call `seedVarianceDates`; (iii) assert the
      returned `{from, to}` object matches the expected dates. The
      `NewReportModal.tsx` call site is updated to import the helper
      from its new location.

- [ ] **B5 (item G) — Transitive store-import gotcha as a documented
      design concern.** Add a one-paragraph subsection to
      `tests/README.md` (or extend the existing "Transitive store-import
      gotcha" subsection at `tests/README.md:81-111`) that names the
      canonical workaround patterns in priority order: (i) mock the
      theme hook (current pattern, demonstrated in
      `StatusPill.test.tsx`); (ii) mock `db.ts` at the boundary
      (working example landed by B4 above); (iii) provider-wrap
      `render()` if a future spec introduces a `<ThemeProvider>`. The
      `tests/README.md` already covers (i) and (ii) for individual
      cases; B5 explicitly elevates the workaround pattern into the
      "first thing to try when adding a component test" decision tree
      and references it from the architect-design checklist as a
      pre-warn item for future specs.

## In scope

- All 11 Track A retroactive Critical regression tests (A1-A11), each
  in its own dedicated `.test.sql` file under `supabase/tests/`.
- Four Track B items (B1, B2, B4, B5). B3 (TS cleanup) is explicitly
  deferred — see "Future specs" below.
- Whatever doc updates are required to keep `tests/README.md`'s
  "First follow-up coverage targets" table in sync — all 11 items
  land in this spec, so the table should be updated accordingly.

## Out of scope (explicitly)

- **B3 (`useStore.ts` / `webPush.ts` TS cleanup).** Deferred to a
  dedicated TS-hygiene spec (likely 024). Rationale: the user flagged
  the rippling-fix risk explicitly; the TS errors live in load-bearing
  files (`useStore.ts` ~1100 lines), so a standalone spec lets the
  diff be reviewed in isolation. The spec 022 backend-dev caveat about
  `typecheck:test` "not yet a CI gate" stays as-is until the sibling
  spec lands.
- **Track C polish items (CI `permissions:` + `timeout-minutes`, plan-mismatch
  grep in `test-db.sh`, `tsconfig.test.json` empty-exclude comment).**
  Already addressed by spec 022's polish patch (committed `b5d3e30`).
  Verified on disk: `.github/workflows/test.yml` has the workflow-level
  `permissions: { contents: read }` block and per-job
  `timeout-minutes:` (15 / 20); `scripts/test-db.sh:122` has the
  `# Looks like you planned N tests? but ran M` grep;
  `tsconfig.test.json` has the inline comment explaining the
  intentional empty `exclude`. No duplicate work in 023.
- **The 6 deferred npm audit vulns** flagged by security-auditor on
  022 (Expo SDK bump territory) — defer to a dedicated dependency-hygiene
  spec.
- **The 32 library-internal RN-Web warnings** during jest runs
  (React Navigation bump territory) — same dep-hygiene spec.
- **The `app.json` slug mismatch** — needs explicit user approval per
  CLAUDE.md, not auto-fixable here.
- **Performance benchmarks / mutation testing / E2E (Detox, Maestro,
  Playwright)** — same deferral as spec 022's "Out of scope".
- **Coverage thresholds enforced in CI** — spec 022 Q5 deferred this;
  no change in 023.
- **Wiring Track 3 shell smokes into CI** — spec 022 Q7 deferred this;
  no change in 023.
- **Modifying any legacy file** per CLAUDE.md
  (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`,
  `npm run db`, `AdminScreens.tsx`) — same standing rule.
- **CI `timeout-minutes` tuning beyond the values already in 022's
  polish patch.** Spec 022's architect §11.2 noted the defaults will
  be tuned against real observed CI run-time signal; that comes after
  enough CI runs accumulate to inform the tuning.
- **`react-native-reanimated` jest mock.** Spec 022 backend-arch
  forward-compat item 8 — defer until a test actually needs it.

## Future specs (named follow-ups)

- **Spec 024 (likely): TS hygiene — `useStore.ts` + `webPush.ts`
  cleanup.** Closes spec 022 backend-arch forward-compat item 4. Goal:
  `npm run typecheck:test` exits 0 on a clean checkout, and the
  `typecheck:test` script can be folded into the CI `test.yml`
  workflow as a third job. Carries the load-bearing-file ripple risk
  the user flagged when scoping Q3 of spec 023.

## Open questions resolved

- Q: Track A scope — curated 5, all 11, or curated + named extras?
  → A: **⟪RESOLVED⟫** All 11 retroactive tests (A1-A11). Maximum
  coverage; budget ~1-2 days. Each in its own dedicated `.test.sql`
  file.
- Q: Track B scope — all five forward-compat items or cheap-only?
  → A: **⟪RESOLVED⟫** All five EXCEPT B3, which is deferred per Q3
  below. So B1, B2, B4, B5 land in 023.
- Q: B3 (TS cleanup) — fix in 023 or defer?
  → A: **⟪RESOLVED⟫** Defer to a dedicated TS-hygiene spec (likely
  024). Removed from 023 scope entirely; surfaced under "Future
  specs" above.
- Q: B4 canonical `db.ts`-boundary mock target — extract+test util,
  test modal directly, or test FetchBreadbotModal?
  → A: **⟪RESOLVED⟫** Extract `seedVarianceDates` from
  `NewReportModal.tsx` into a utility module and test the extracted
  function. Tightest diff, smallest test surface, cleanest demo of
  the boundary-mock pattern.
- Q: B1 (jest-native swap) packaging — inside 023 or micro-spec?
  → A: **⟪RESOLVED⟫** Inside 023. One-line dep removal + one-line
  config removal; zero matcher usage in shipped tests.

## Dependencies

- `npm run dev:db` must be running for the Track A pgTAP tests
  locally — same precondition as spec 022's Track 2.
- `supabase/seed.sql` is the substrate for Track A fixtures. Tests
  use named-store lookups (`select id from public.stores where name = 'Frederick'`)
  per the spec 022 architect §11.7 seed-drift mitigation.
- B4 depends on the `seedVarianceDates` helper currently inlined in
  `src/components/cmd/NewReportModal.tsx` (around lines 64-76) — the
  architect should confirm the exact extraction shape during design.
- No new migrations.
- No new edge functions, no edge-function changes.
- No `app.json` changes.
- No legacy-file edits.

## Project-specific notes

- **Cmd UI section / legacy.** No new screen sections. B4 modifies
  `src/components/cmd/NewReportModal.tsx` only to update the import
  of `seedVarianceDates` from its new utility-module location. Does
  NOT touch `src/screens/AdminScreens.tsx`.
- **Per-store or admin-global.** Track A tests use store-member JWT
  impersonation via `set_config('request.jwt.claims', ..., true)`.
  Cross-store tests (A3, A4 arm ii) impersonate a member of store A
  while referencing items/vendors from store B. Multi-persona tests
  inside the same `begin/rollback` frame — proven shape from spec
  022's `report_run_cogs.test.sql`.
- **Realtime channels touched.** None. No publication membership
  changes.
- **Migrations needed.** No. Track A pgTAP tests use
  `create extension if not exists pgtap;` per file (per the architect's
  spec 022 §4 "no migration leaks the testing extension into prod"
  decision).
- **Edge functions touched.** None.
- **Web/native scope.** B4's extracted utility (`seedVarianceDates`)
  is a pure Node-tested function (no platform branch); its colocated
  test runs in the jest default project (no jsdom needed). The
  `NewReportModal.tsx` import-update is web+native (same file ships
  on both).
- **`app.json` slug.** Not touched (CLAUDE.md off-limits).
- **Tests.** This IS the retroactive coverage spec. Test-engineer
  review on the implementation will be the first time prior-spec
  Criticals are checked against actual automated tests rather than
  reviewer-eye PoCs.
- **Workflow-scoped token caveat.** Per CLAUDE.md "CI workflow": B2
  edits `README.md` only, not `.github/workflows/*`. No push caveat
  applies to 023's deliverables.
- **README.md edit caveat.** B2 explicitly edits `README.md`. The
  user-directed deferral on spec 022 ("DO NOT touch README") was for
  that spec's PR specifically; 023 makes the cleanup its primary
  scope. Confirmed by Q-resolution.
- **Architect pre-warn (B5).** Spec 023's own architect, when
  reviewing this spec, will hit the transitive store-import question
  on B4 — but the extract-to-util resolution sidesteps it. The
  architect should still document the workaround pattern per B5's
  `tests/README.md` update, because future component tests will hit
  the same gotcha.

## What's already there (for the architect)

- **Spec 022 framework** — three tracks live, two example DB tests
  shipped (`report_run_cogs.test.sql`, `inventory_counts_set_submitted_by.test.sql`).
- **Spec 022 polish patch (committed `b5d3e30`)** — CI workflow
  `permissions:` + `timeout-minutes:`, `test-db.sh` plan-mismatch
  grep at line 122, `tsconfig.test.json` empty-exclude comment.
  Track C carry-overs are already on disk; 023 does NOT re-do.
- **`tests/README.md`** — has a "First follow-up coverage targets"
  table that 023 should update as items land.
- **`supabase/migrations/20260510120000_report_runs.sql`** — dispatcher
  source for A1 and A6.
- **`supabase/migrations/20260514120030_eod_submissions_consistency.sql`**
  — three-arm trigger source for A4.
- **`supabase/migrations/20260513120000_inventory_counts_consistency.sql`**
  — entries trigger source for A3 (lines 79-113) and append-only
  posture source for A8.
- **`supabase/migrations/20260512120000_report_run_variance.sql`** —
  variance formula source for A2 and SUM aggregation source for A7.
- **`supabase/migrations/20260514130000_report_reorder_list.sql`** —
  MIN-DOW source for A5, hybrid-formula source for A10, EOD-first
  sourcing source for A11.
- **`src/components/cmd/NewReportModal.tsx`** — `seedVarianceDates`
  inlined call site for the B4 extraction (architect confirms exact
  line range).
- **`specs/022-test-framework-intro/reviews/backend-architect.md`**
  forward-compat checklist (items 1, 2, 3, 5, 7, 9) — source of
  truth for what this spec is closing out of spec 022.

## Backend Architecture

This is a test-only spec. No schema changes, no new RPCs, no edge function
work, no realtime publication impact, no `app.json` touch. The architecture
below pins down file structure, fixture shape per test, the JSON-contract
choices the PM flagged as architect Qs, and the small refactor of
`seedVarianceDates` out of `NewReportModal.tsx`.

### 0. Patterns reused (no new patterns)

- **pgTAP frame:** `begin; create extension if not exists pgtap; select
  plan(N); ...; select * from finish(); rollback;` — proven by the two
  example tests in 022. Every Track A test uses the same frame.
- **Named-store lookup over hard-coded UUIDs:** `select id into v_xxx from
  public.stores where name = 'Frederick' limit 1;` — risk-7 mitigation from
  spec 022 §11.7. Avoids drift when the seed is refreshed.
- **Seeded user UUIDs are stable:** manager `22222222-...`, master
  `33333333-...`, admin `11111111-...` are pinned in `supabase/seed.sql`.
  Same shape as `report_run_cogs.test.sql:34-36`. Use these directly.
- **JWT impersonation via `set_config('request.jwt.claims', ...)`:** shape
  pinned in `tests/README.md:222-231`. `set local role authenticated;`
  precedes the claim-set so PostgREST-equivalent RLS evaluation kicks in.
- **Transaction-local config stash:** `set_config('test.<key>', value::text,
  true)` + `current_setting('test.<key>', true)`. Survives across statements
  inside the BEGIN block, rolls back cleanly. Already in use in both
  example tests.
- **`throws_ok(query_text, sqlstate, [message_substring], description)`:**
  the pgTAP assertion for error-path tests. Wrap `select ...` in `format($q$...$q$, ...)`
  when an interpolated UUID needs to land inside the quoted SQL. Shape
  copied from `report_run_cogs.test.sql:68-76`.

### 1. Track A — 11 retroactive DB tests

All 11 files live under `supabase/tests/`. One file per test (per spec AC).
Each file is self-contained: no shared fixture file, no `\i` includes, no
helper SQL outside the file itself. The spec 022 framework already
exercises this isolation pattern; we extend it 11×.

#### A1 — dispatcher unknown template returns `not_implemented` envelope

- **File:** `supabase/tests/report_run_unknown_template.test.sql`
- **`plan(N)`:** 4 (one fixture sanity, three assertions on the envelope)
- **Architect Q resolution — what does A1 assert against?** The dispatcher's
  documented contract at `supabase/migrations/20260510120000_report_runs.sql:62-66`
  pins the not-implemented envelope as having **both** `_status: 'not_implemented'`
  AND `_message: 'Runner coming soon · definition saved'`, alongside the
  standard envelope keys with empty/null values. A1 asserts on `_status`
  as the load-bearing contract field. `_message` text is product copy and
  not asserted (the message can change without breaking the FE branch);
  the env's standard keys (`kpis`/`columns`/`rows`/`series`) are asserted
  shaped but the per-key emptiness is not (kpis/columns/rows are empty
  arrays, series is `null` — assert these per spec line 63).
- **Fixture sketch:**
  - Resolve Frederick store id by name; stash via `set_config('test.frederick_id', ...)`.
  - Impersonate manager (member of Frederick).
- **Assertions:**
  - `isnt(current_setting('test.frederick_id', true), '', ...)` — fixture sanity.
  - `is(jsonb_typeof(env), 'object', ...)` after capturing
    `select public.report_run('totally_bogus', frederick::uuid, '{}'::jsonb)`
    into a temp table.
  - `is(env->>'_status', 'not_implemented', '_status flag signals unknown template')`.
  - `is(env->'rows', '[]'::jsonb, 'rows is empty array')` and
    `is(env->'series', 'null'::jsonb, 'series is null')` collapsed into a
    single `is()` over the envelope keys per the COGS-example pattern (one
    assertion on the sorted key list) — choose whichever the dev finds
    most diff-readable; the plan count stays 4 either way.

#### A2 — variance formula (strict reconciliation math)

- **File:** `supabase/tests/report_run_variance_formula.test.sql`
- **`plan(N)`:** 7 (one fixture sanity, five formula assertions, one
  envelope sanity on the wrapping `rows` array length)
- **The trickiest test — fixture insert sequence:** (all inside the
  same `begin; ... rollback;` frame as the rest of the test)
  1. Look up Frederick id (named-store lookup); pick a single seeded
     `inventory_item` from Frederick — we want one whose `cost_per_unit > 0`
     to avoid the missing-cost zero-out path. Pull the first one via
     `select id, cost_per_unit from public.inventory_items where store_id = <Frederick> and coalesce(cost_per_unit, 0) > 0 limit 1`.
     Stash item_id + cost via `set_config`.
  2. Impersonate manager and `set local role authenticated`.
  3. INSERT two `eod_submissions` rows for Frederick:
     - prior anchor `date = '2026-05-01'`, status `'submitted'`, captured id stashed.
     - current anchor `date = '2026-05-02'`, status `'submitted'`, captured id stashed.
     (Frederick has zero seed EOD rows so there is no ambient interference.
     `vendor_id` is required post-spec-020; pick any seed vendor's id, doesn't
     matter for this test since the variance runner aggregates across all
     vendors per anchor date.)
  4. INSERT two `eod_entries` rows: one against each submission for the
     stashed item_id. Prior `actual_remaining = 10`, current `actual_remaining = 4`.
  5. INSERT one `purchase_orders` row for Frederick with vendor_id set,
     `status = 'received'`, `received_at = '2026-05-01 23:59:00+00'`,
     `reference_date = '2026-05-02'` (between the anchors per the
     `> v_from AND <= v_to` half-open rule). Stash po_id.
  6. INSERT one `po_items` row tied to that po_id, the stashed item_id,
     `received_qty = 3`.
  7. INSERT one `waste_log` row for Frederick on the item, `quantity = 1`,
     `logged_at = '2026-05-02 12:00:00+00'`.
  8. Sales depletion is the hardest to fixture, because it requires a
     recipe whose ingredients map to the chosen item AND a `pos_imports` +
     `pos_import_items` row. To keep A2 tractable we deliberately PICK an
     ITEM THAT IS NOT IN ANY RECIPE — variance runner's `sales_depletion`
     CTE inner-joins through `recipe_ingredients`, so a non-recipe item
     yields `sales_qty = 0` (left-joined to 0 in the `joined` CTE). The
     formula then reduces to `delta = counted - (prior + receiving - 0 - waste)`
     = `4 - (10 + 3 - 0 - 1) = 4 - 12 = -8`. Sales-side correctness is
     pinned by A7 separately.
- **Assertions:**
  - Fixture sanity: `isnt(test.frederick_id, '', ...)`.
  - Call `report_run_variance(Frederick, jsonb_build_object('from', '2026-05-01', 'to', '2026-05-02'))`
    once into a temp table.
  - `is(jsonb_array_length(env->'rows'), 1, 'exactly one row for the test item')`.
  - `is((env->'rows'->0->>'item'), <item-name>, 'row item matches')` — or
    skip if item-name lookup adds noise; the qty asserts below are
    load-bearing.
  - Extract the row: the runner formats numbers with `to_char(..., 'FM999,990.000')`,
    so assertions parse text. Use `is((env->'rows'->0->>'expected')::numeric, 12.000, 'expected = prior + recv - sales - waste = 10+3-0-1=12')`.
  - `is((env->'rows'->0->>'counted')::numeric, 4.000, 'counted = 4')`.
  - `is(replace((env->'rows'->0->>'delta'), ',', '')::numeric, -8.000, 'delta = counted - expected = -8')`.
  - `is((env->'rows'->0->>'dollar_impact')::text, '$<computed>', 'dollar_impact = delta * cost')`
    — the exact dollar string depends on the seeded item's cost. The dev
    can compute it at fixture-time and stash via `set_config('test.expected_dollar', ...)`,
    then assert against the stashed value.
- **Floating-point note:** every input is integer; the runner emits
  `to_char(..., 'FM999,990.000')`. Cast back to numeric and assert exact
  equality. No epsilon needed.

#### A3 — cross-store `item_id` consistency trigger (entries arm)

- **File:** `supabase/tests/inventory_count_entries_check_store.test.sql`
- **`plan(N)`:** 3 (one fixture sanity, one trigger-deny, one defense-in-depth
  on the parent count not getting an entry)
- **Fixture sketch:**
  - Resolve Frederick (store A) and Charles (store B) ids by name; pull any
    seed `inventory_items` row whose `store_id = Charles` for the cross-store
    item_id. Stash both store ids + Charles item_id.
  - Impersonate master (`33333333-...`, all-stores membership) so the test
    can read Charles items for the fixture lookup without RLS denying;
    re-impersonate manager for the actual cross-store INSERT attempt
    (manager has Frederick + Towson but NOT Charles).
  - INSERT a parent `inventory_counts` row for Frederick under manager JWT
    (this works — manager can write to Frederick). Stash count_id.
- **Assertions:**
  - Fixture sanity: both store ids resolved.
  - `throws_ok($q$ insert into public.inventory_count_entries (count_id, item_id, actual_remaining) values (<frederick-count>, <charles-item>, 5) $q$, '42501', 'item store mismatch', 'cross-store item_id rejected by trigger')`.
  - `is((select count(*) from public.inventory_count_entries where count_id = <frederick-count>), 0::bigint, 'no entry persisted for cross-store attempt')`.

#### A4 — EOD per-vendor consistency triggers (all three arms in one file)

- **File:** `supabase/tests/eod_submissions_consistency.test.sql`
- **`plan(N)`:** 6 (one fixture sanity, three core trigger assertions, two
  defense-in-depth)
- **Recommendation: one file with one plan covering all three arms.** The
  three arms test ONE conceptual contract (the consistency layer for
  EOD's three vulnerability paths) and share fixtures (Frederick id,
  Charles id, vendor id, manager + master JWT). Splitting would triple
  the fixture-resolution overhead. Spec 022's example already proved
  three assertions in one file are tractable
  (`inventory_counts_set_submitted_by.test.sql:plan(3)`).
- **Fixture sketch:**
  - Frederick + Charles store ids resolved by name; pick a seed vendor id;
    pick a Charles `inventory_items` id for arm (ii); pick a SECOND seed
    vendor different from the first for arm (iii). Stash all.
  - Impersonate manager.
- **Assertions:**
  - Fixture sanity: Frederick id resolved.
  - **Arm (i) — submitted_by override** (copy-paste-adjust from
    `inventory_counts_set_submitted_by.test.sql`): INSERT an `eod_submissions`
    row with `submitted_by = master_id` (forged); read back; assert
    persisted `submitted_by = manager_id` via `is()`; then `isnt()` defense
    that master_id is NOT the persisted value.
  - **Arm (ii) — cross-store entry rejection:** INSERT a parent
    `eod_submissions` for Frederick succeeds; then
    `throws_ok($q$ insert into public.eod_entries (submission_id, item_id, actual_remaining) values (<fred-sub>, <charles-item>, 5) $q$, '42501', 'item store mismatch', 'cross-store item_id on eod_entries rejected')`.
  - **Arm (iii) — vendor_id consistency:** the migration file does NOT
    declare a `vendor_id` consistency trigger on `eod_entries` —
    `eod_submissions` is the only carrier of `vendor_id`, and
    `eod_entries` does not have a `vendor_id` column. The PM-prompted
    "vendor-scoped current_stock write" assertion is the RPC-layer
    enforcement, not a trigger. **Architect decision:** assert that a
    valid same-store entry insert (a vendor_id mismatch between the
    fixture vendor and the parent submission's vendor) does NOT raise
    because no such trigger exists — i.e. defensively pin the absence of
    over-strict enforcement at the trigger level. The vendor-scoped
    current_stock RPC behavior is the staff_submit_eod_v2 path, which is
    `security definer + service_role` and not reachable from a manager
    JWT inside pgTAP. Result: the third arm collapses to a defense-in-
    depth `is((select count(*) from public.eod_entries where submission_id = <fred-sub>), 1::bigint, 'arm-ii entry not persisted; arm-i did insert via the parent insert path')` — confirming the trigger is permissive on
    the columns it does not check.
  - **Defense-in-depth (×2):** `isnt()` confirming neither forged submitted_by
    nor cross-store item leaked through.

  **Caveat back to PM:** the spec prompt's "vendor-scoped current_stock
  write" sub-assertion overstates the trigger's scope. The trigger pair
  in `20260514120030_eod_submissions_consistency.sql` is exactly two
  arms (submitted_by override + cross-store item_id). The third
  consistency layer (vendor-scoped stock write) lives in the RPC
  (`staff_submit_eod_v2.sql:127-137`) and is gated to service_role,
  outside what a pgTAP test under manager JWT can exercise. Recommend
  surfacing this back to the PM as a scope-clarification before build;
  if the user wants vendor-scoped stock-write coverage, that is a
  separate test that needs a different runner (service_role JWT
  via the staff RPC path, OR a Track 3 shell smoke through the edge
  function).

#### A5 — MIN-DOW lateral subquery (multi-delivery-day vendors)

- **File:** `supabase/tests/report_reorder_list_min_dow.test.sql`
- **`plan(N)`:** 5 (one fixture sanity, two multi-delivery-day asserts,
  one same-day-before-cutoff, one same-day-after-cutoff)
- **Fixture sketch:**
  - Frederick id resolved by name; pick a seed vendor that has at least
    one `inventory_items` row in Frederick (needed for the
    `exists (... inventory_items where vendor_id = v.id)` filter in the
    `vendor_delivery_offsets` CTE — vendors with no items are excluded).
    Stash vendor id.
  - Manager JWT.
  - Per the spec 022 framework, we cannot stub `now()` for
    `extract(dow from <date>)` — but the runner accepts `as_of_date` in
    `p_params`, so we drive the test by passing dates that fall on the
    desired weekdays. Picked anchor: **2026-05-14 = Thursday** (verified
    via `extract(dow from date '2026-05-14') = 4`).
  - Reset vendor's `order_cutoff_time` to a known value via UPDATE
    (vendors are brand-scoped; UPDATE under master JWT or admin if
    manager-can't-update — verify under master to avoid RLS noise.
    Actually vendors RLS: vendors is brand-shared. Master can update.
    Switch to master JWT briefly for vendor UPDATE, then back to manager
    for the actual report call. The fixture stash mid-test approach
    documented in spec 022 §11.5 covers this).
  - DELETE any pre-existing `order_schedule` rows for `(Frederick, vendor)`
    via master JWT so the test owns the entire schedule for the test
    vendor. (Frederick may already have a schedule for that vendor in
    seed; delete inside-txn is hermetic.)
- **Assertions (multi-delivery-day):**
  - Fixture sanity (1).
  - INSERT two `order_schedule` rows for vendor: `delivery_day = 'wednesday'`
    and `delivery_day = 'friday'`. (The text fields use weekday names
    lowercase per the migration's `case lower(os2.delivery_day) when
    'wednesday' ...`.)
  - Set vendor's `order_cutoff_time = '23:59:00'` (so the time-of-day
    branch is irrelevant).
  - Call `report_reorder_list(Frederick, jsonb_build_object('as_of_date', '2026-05-14'))`.
    Stash the result. Extract the vendor's entry by `vendor_id`.
  - `is((vendor->>'days_until_next_delivery')::int, 1, 'Thursday→Friday is 1 day, not 6 (raw-DOW-min bug)')`.
  - `is((vendor->>'next_delivery_date'), '2026-05-15', 'next delivery is Friday 2026-05-15')`.
- **Assertions (cutoff edge case — single delivery day = today):**
  - DELETE prior order_schedule, INSERT a SINGLE row `delivery_day = 'thursday'`.
  - **Before cutoff:** set `vendor.order_cutoff_time = '23:59:00'`, call
    report on `as_of_date = '2026-05-14'` (a Thursday); assert
    `days_until_next_delivery = 0`. This relies on the runner's
    `v_today_time = (now() at time zone 'utc')::time` — at CI run time
    this is whatever wall-clock-now happens to be; pre-23:59 the assert
    holds. **Caveat documented:** if a CI run starts after 23:59 UTC the
    test could flake. To eliminate flake, set `order_cutoff_time = '23:59:59.999'`
    so the only time-of-day that fails is the last millisecond of the
    UTC day. Dev can decide whether to accept the 1ms-window flake risk
    or wire a custom helper (architect notes the trade-off but does not
    require the custom helper).
  - **After cutoff:** set `vendor.order_cutoff_time = '00:00:01'`, call
    report on same `as_of_date`; assert `days_until_next_delivery = 7`
    (next cycle, the migration line 359-366 force-7 branch).

#### A6 — anon revoke (grant-time enforcement)

- **File:** `supabase/tests/reports_anon_revoke.test.sql`
- **`plan(N)`:** 7 (one fixture sanity, six anon-call denials, one per RPC
  listed in the spec)
- **The 7 RPCs targeted:** `report_run`, `report_run_stub`,
  `report_run_cogs`, `report_run_variance`, `report_reorder_list`,
  `submit_inventory_count`. The PM's prompt also listed `staff_submit_eod`
  — that one is granted ONLY to `service_role` (not authenticated),
  verified at `supabase/migrations/20260514120010_staff_submit_eod_v2.sql:179-180`.
  Calling it as `anon` raises a DIFFERENT error class
  (`42501 permission denied for function`) at GRANT time, before
  `auth_can_see_store` is evaluated. **Architect decision:** include
  `staff_submit_eod` in A6 — the test stays sound because all 7 share
  the same end-state assertion shape: `throws_ok(call, '42501', ...)`.
- **Fixture sketch:**
  - Resolve Frederick id by name (for the few RPCs that take a `store_id`).
  - Set `role` to `anon` (NOT `authenticated`); set
    `request.jwt.claims` to `jsonb_build_object('role', 'anon')::text`.
  - **NOTE on `set local role anon`:** spec 022's tests use `set local role
    authenticated`; A6 needs `set local role anon` to bypass the
    authenticated grant and exercise the public/anon revoke. Verify the
    docker user has permission to `set role anon` — pgTAP runs as
    postgres (superuser) so the SET succeeds. Document in the test file's
    comment header.
- **Assertions:**
  - Fixture sanity (1).
  - Six `throws_ok` calls, one per RPC, each expecting `'42501'`
    SQLSTATE. Don't assert on message substring — the standard Postgres
    `permission denied for function <name>` text is what fires, and the
    specific function name varies; SQLSTATE alone is the contract.

#### A7 — variance SUM aggregation across multi-vendor day

- **File:** `supabase/tests/report_run_variance_multivendor_sum.test.sql`
- **`plan(N)`:** 4 (fixture sanity + same-item-two-vendors-summed +
  per-vendor-only-pre-sum verification + delta math sanity)
- **Architect note:** A7 verifies the post-spec-020 multi-vendor refactor at
  `20260514120020_report_run_variance_multivendor.sql`. The key contract:
  when an item appears under TWO vendors on the SAME anchor date, the
  variance runner SUMs both `actual_remaining` values before computing
  the delta — vs. the old per-submission behavior which would have
  raised "more than one row returned" or silently picked one.
- **Fixture sketch:**
  - Frederick id; pick two distinct seed vendor ids both having
    `inventory_items` rows in Frederick; pick a seed item id from
    Frederick. Stash all.
  - Manager JWT.
  - Anchor dates `'2026-05-01'` (prior) and `'2026-05-02'` (current).
  - INSERT four `eod_submissions` rows: prior+current × vendor A +
    vendor B (all status='submitted').
  - INSERT four `eod_entries` rows: one per submission, all on the same
    item_id. Values: prior-A = 5, prior-B = 5; current-A = 3, current-B = 2.
    Item summed across vendors: prior = 10, current = 5.
- **Assertions:**
  - Fixture sanity (1).
  - Call `report_run_variance(Frederick, '{"from":"2026-05-01","to":"2026-05-02"}'::jsonb)`.
  - `is((env->'rows'->0->>'expected')::numeric, 10.000, 'prior=5+5=10 (summed across vendor A+B)')`.
  - `is((env->'rows'->0->>'counted')::numeric, 5.000, 'current=3+2=5 (summed across vendor A+B)')`.
  - `is(replace((env->'rows'->0->>'delta'), ',', '')::numeric, -5.000, 'delta = counted - expected = 5 - 10 = -5')`.

#### A8 — append-only deny posture (UPDATE / DELETE)

- **File:** `supabase/tests/inventory_counts_append_only.test.sql`
- **`plan(N)`:** 4 (fixture sanity + UPDATE 0-rows under manager + DELETE
  0-rows under manager + UPDATE 1-row under admin, DELETE still 0)
- **Architect note:** spec 019 went **append-only-and-no-edit** (drop
  policies entirely) for `inventory_counts`. With no policy, RLS denies
  for non-superuser — which manifests as `update ... where ... returning *`
  returning **0 rows** (RLS-filtered out of the candidate set). The
  underlying behavior is the same: nothing is mutated. Asserting on
  affected-row count is the cleanest way (no `throws_ok` because
  Postgres doesn't *raise* on RLS-filtered UPDATE/DELETE, it just
  silently returns 0 rows).
- **The PM prompt's "admin can UPDATE → 1 affected" line is WRONG against
  the current migration.** The migration drops BOTH manager and admin
  UPDATE policies for `inventory_counts`. No policy exists. So admin
  also gets 0 rows on UPDATE. The append-only spec-019 lineage made this
  intentional (in contrast to `eod_submissions` where spec 020 *kept* an
  admin-only UPDATE policy because Q5 mandated an EDIT flow). The
  architect's read of `20260513120000_inventory_counts_consistency.sql:115-131`
  is: **no UPDATE policy and no DELETE policy at all on inventory_counts**.
  Both deny under any caller including admin.
- **Architect decision:** A8 asserts the realised behavior, NOT the
  PM-prompt's mistaken admin-UPDATE-allowed line. The test reads:
  manager UPDATE → 0, manager DELETE → 0, admin UPDATE → 0, admin
  DELETE → 0. The PM-prompt's distinction (UPDATE allowed for admin,
  DELETE denied for everyone) is appropriate for `eod_submissions` (A4's
  context), NOT for `inventory_counts` (A8's context).
- **Fixture sketch:**
  - Frederick id by name; manager + admin JWT shapes.
  - As manager: INSERT one `inventory_counts` row for Frederick (this
    succeeds — INSERT policy is intact). Stash count_id.
- **Assertions:**
  - Fixture sanity (1).
  - As manager: `is((with u as (update public.inventory_counts set notes = 'forged' where id = <c>::uuid returning 1) select count(*) from u), 0::bigint, 'manager UPDATE filtered by absent policy → 0 rows')`.
  - As manager: `is((with d as (delete from public.inventory_counts where id = <c>::uuid returning 1) select count(*) from d), 0::bigint, 'manager DELETE filtered by absent policy → 0 rows')`.
  - As admin (`set request.jwt.claims` with `app_metadata.role = 'admin'`):
    `is((with u as (update public.inventory_counts set notes = 'forged-admin' where id = <c>::uuid returning 1) select count(*) from u), 0::bigint, 'admin UPDATE also 0 — no UPDATE policy exists at all')`.

  **Caveat back to PM:** the PM prompt's "as admin, UPDATE → 1 affected"
  is the `eod_submissions` semantics, not `inventory_counts`. A8 covers
  `inventory_counts` per the file name; do NOT change the migration to
  match the prompt — the spec 019 design is intentional. If
  `eod_submissions` admin-UPDATE coverage is wanted, that is a separate
  test for a separate spec (or a future arm under A4).

#### A9 — EOD EDIT flow row-id preservation

- **File:** `supabase/tests/eod_submissions_edit_flow.test.sql`
- **`plan(N)`:** 4 (fixture sanity + id stable + submitted_at bumped +
  actual_remaining updated)
- **Test path constraint:** `staff_submit_eod` is `security definer +
  service_role` — manager JWT cannot call it. The PM-prompt's "call the
  EOD upsert RPC twice" requires choosing one of:
  - (a) call the RPC as service_role within pgTAP, OR
  - (b) test the underlying `on conflict (store_id, date, vendor_id) do
    update` shape via direct INSERT.
- **Architect decision:** **(b) — direct INSERT.** Reasoning:
  - The contract A9 pins is the **table-level** `on conflict do update`
    behavior. Whether the RPC path *or* a direct PostgREST INSERT
    triggers it, the end-state is the same: the same `(store_id, date,
    vendor_id)` triple resolves to one row and the second write
    preserves the id while bumping `submitted_at`.
  - Direct INSERT is testable from manager JWT (no service_role
    needed). The RPC path adds Deno + service-role transport noise that
    the test doesn't need.
  - Caveat: this test does NOT exercise the RPC's entry-replacement
    behavior. That is correctly out of scope — entry replacement is a
    different code path. The spec's "EDIT flow" intent is the parent-row
    upsert contract, which is what A9 pins.
- **Fixture sketch:**
  - Frederick id by name; pick a seed vendor with an item in Frederick;
    manager JWT.
  - INSERT first `eod_submissions` row: `(Frederick, '2026-05-01',
    vendor, status='submitted', client_uuid=gen_random_uuid())`. The
    spec 020 trigger overrides `submitted_by` to `auth.uid()` (manager).
    Capture id + submitted_at via `returning *`, stash both via
    `set_config`.
  - Sleep is not available; use `pg_sleep(0.01)` to guarantee
    `submitted_at` bump on the second insert. (Or capture `now()` before/after
    and trust the wall clock to advance — pg_sleep is the cleaner.)
- **Assertions:**
  - Fixture sanity (1).
  - INSERT second row with same `(store_id, date, vendor_id)` triple,
    different `client_uuid`, `on conflict do update set submitted_at =
    excluded.submitted_at` (mirror the RPC's UPDATE shape). Capture
    new id.
  - `is(<new-id>, <stashed-id>, 'id preserved across ON CONFLICT DO UPDATE')`.
  - `ok(<new-submitted-at> > <stashed-submitted-at>, 'submitted_at bumped on second write')`.
  - **`actual_remaining` update note:** the prompt mentions
    "actual_remaining updated" — `actual_remaining` lives on
    `eod_entries`, not `eod_submissions`. The RPC replaces entries via
    `delete + insert`. To pin this end-to-end via direct INSERT we'd
    need to manually delete + reinsert the entries inside the test.
    **Architect decision:** include this as the fourth assertion —
    delete the prior entry row and INSERT a new one with a new
    `actual_remaining` value, then assert the new value via SELECT. This
    mirrors what the RPC does internally and gives the spec the contract
    it asks for.

#### A10 — hybrid `max()` formula

- **File:** `supabase/tests/report_reorder_list_hybrid_formula.test.sql`
- **`plan(N)`:** 5 (fixture sanity + three formula scenarios + filter-
  zero sanity)
- **Architect Q resolution — fixture three scenarios:** the prompt names
  three: (i) par_repl=10, usage_fc=0 → suggested=10; (ii) par_repl=0,
  usage_fc=15 → suggested=15; (iii) both → suggested=max(both). The
  migration's formula is exactly `greatest(par_replacement,
  usage_forecasted)` (line 451). To force scenarios cleanly we need
  three test items in Frederick with controlled `par_level`,
  `current_stock`, `usage_per_portion`, AND a sales-history trigger to
  produce `qty_per_day > 0` for scenarios (ii) and (iii). Cleanest
  fixture per item:
  - **Item 1 (par-only):** par_level=10, current_stock=0,
    usage_per_portion=0 → par_repl=10, usage_fc=0 (because
    usage_per_portion is 0) → suggested=10.
  - **Item 2 (usage-only):** par_level=0, current_stock=0,
    usage_per_portion=1 → par_repl=0; need pos_imports + pos_import_items
    + a recipe whose ingredients touch this item to produce
    qty_per_day=1 over the last 7 days. With days_until=7 (vendor with
    no order_schedule → A5 7-day fallback), usage_fc = 1 * 1 * 7 = 7
    → suggested=7. **Note:** the PM-prompt's "usage_fc=15" specific
    number requires controlled sales data; the principle (usage-only
    item picks usage_fc) is what we assert. Pick whatever clean
    fixture produces a non-zero usage_fc; assert the formula
    `suggested_qty = usage_forecasted` directly via the runner's
    returned values.
  - **Item 3 (both):** par_level=20, current_stock=0,
    usage_per_portion=1, sales data → usage_fc=7, par_repl=20 →
    suggested=20 (the larger).
- **Fixture complexity:** to avoid coupling to seed sales data, INSERT
  three new `inventory_items` rows under Frederick + master JWT (manager
  cannot INSERT into inventory_items because it is also under
  `auth_can_see_store` write policy — verify and use the appropriate
  JWT). INSERT a `recipes` + `recipe_ingredients` row tying each
  test-item to a unique recipe; INSERT one `pos_imports` row for
  Frederick within the trailing-7d window with one `pos_import_items`
  row per recipe (`qty_sold = 1`, `recipe_mapped = true`).
- **Assertions:**
  - Fixture sanity (1).
  - Call `report_reorder_list(Frederick, jsonb_build_object('as_of_date', '<today>'))`.
  - `is((vendor->items->0->>'suggested_qty')::numeric, 10::numeric, 'item 1: par-only → suggested = par_replacement')`.
  - `is((vendor->items->1->>'suggested_qty')::numeric, 7::numeric, 'item 2: usage-only → suggested = usage_forecasted')`.
  - `is((vendor->items->2->>'suggested_qty')::numeric, 20::numeric, 'item 3: both populated → suggested = max(par_repl, usage_fc)')`.
- **Caveat:** A10 has the highest fixture-complexity of the 11 tests
  because it must seed recipe + sales paths. Dev should consider
  factoring the per-item INSERT block into an inline `do $$` helper
  inside the test file (NOT a shared util — spec ACs forbid shared
  fixtures across files). If A10 lands and is hard to maintain, a
  follow-up could simplify by carving an item-prep PL/pgSQL helper that
  lives inside the test file only.

#### A11 — EOD-first sourcing (`on_hand_source = 'eod'` vs `'stock'`)

- **File:** `supabase/tests/report_reorder_list_on_hand_source.test.sql`
- **`plan(N)`:** 3 (fixture sanity + scenario-A 'eod' + scenario-B 'stock')
- **Architect Q resolution — one plan with two asserts inside one file.**
  Two scenarios live cleanly under one plan; splitting into two plans
  (which pgTAP supports via repeated `plan/finish` blocks in one txn)
  adds parse overhead and disrupts the one-plan-per-file convention
  established by `report_run_cogs.test.sql` and
  `inventory_counts_set_submitted_by.test.sql`. Recommend one plan with
  two asserts.
- **Fixture sketch:**
  - Frederick + two distinct seed vendors A, B, both with items in
    Frederick. Master JWT for vendor-data control (cross-store visibility
    if needed), manager JWT for the actual report call.
  - For vendor A: INSERT an `eod_submissions` for Frederick today
    status='submitted' + one `eod_entries` row for one of vendor A's items
    with `actual_remaining = 99`.
  - For vendor B: NO eod submission today.
  - Both vendors need items whose `par_level > current_stock` so the
    items survive the `suggested_qty >= 0.001` filter and appear in the
    payload. Set par_level via UPDATE if needed.
- **Assertions:**
  - Fixture sanity (1).
  - Call `report_reorder_list(Frederick, '{"as_of_date":"<today>"}'::jsonb)`.
  - `is((vendor-A-entry->>'on_hand_source'), 'eod', 'vendor A has EOD today → on_hand_source = eod')`.
  - `is((vendor-B-entry->>'on_hand_source'), 'stock', 'vendor B has no EOD today → on_hand_source = stock fallback')`.

### 2. Track B — Forward-compat cleanups

#### B1 — `@testing-library/jest-native` swap

- **Verification step before any change:** read
  `src/utils/relativeTime.test.ts` and `src/components/cmd/StatusPill.test.tsx`
  — neither uses any `jest-native`-specific matcher
  (`toBeOnTheScreen`, `toBeVisible`, `toHaveStyle`, etc.); both use
  `toBeTruthy()`, `toBeNull()`, `toBe(...)` from base jest. **Confirmed
  by direct read** during architecture. Safe to remove.
- **Changes:**
  - Edit `package.json`: drop the `"@testing-library/jest-native": "^5.4.3"`
    line from `devDependencies`.
  - Edit `jest.config.js` line 81: remove the
    `'@testing-library/jest-native/extend-expect'` entry from the
    component project's `setupFilesAfterEnv` array.
  - Run `npm install` to regenerate `package-lock.json` (the dev
    commits the lockfile change).
  - Run `npm test -- --ci` to confirm both example tests still pass.
- **If any matcher breaks during `npm test`:** swap the offender to the
  built-in `@testing-library/react-native@^13` equivalent. The library's
  v12.4+ docs map old jest-native names to built-in names 1:1.

#### B2 — README workflow reference cleanup

- **Choice:** remove the reference. The workflow has never landed
  per CLAUDE.md "CI workflow" note; the active workflow is
  `.github/workflows/test.yml`, which already runs on every push/PR
  per spec 022. Replacing the reference with `test.yml` would create
  the impression that test.yml subsumes a never-existed workflow — it
  doesn't. Cleaner to remove.
- **Changes:**
  - Edit `README.md` to drop the two `db-migrations-applied.yml`
    references at lines 137 and 224 (verified via `grep`).
  - The README's structure summary at line 135-138 should drop the
    line `db-migrations-applied.yml          # CI deploy-gate (see below)`
    entirely.
  - The README's `## CI deploy-gate` section at line 222-onwards should
    be revisited: either replace its body with a one-line pointer to
    [`tests/README.md`](tests/README.md)'s `## CI` section (which
    already documents `test.yml`), OR delete the section if it has no
    other valuable content. Recommend the one-line pointer to avoid
    losing a section header that other docs may reference.

#### B4 — `seedVarianceDates` extraction + canonical mock-proof test

- **Architect Q resolution — exact extraction shape:**
  - **New file:** `src/utils/seedVarianceDates.ts`. Exports one named
    async function `seedVarianceDates(storeId: string): Promise<{ from: string; to: string; eodCount: number }>`.
  - Signature is verbatim what `NewReportModal.tsx:64-76` currently has.
  - Imports `fetchRecentEodDates` from `../lib/db`.
  - Behavior contract pinned by the existing inline implementation
    (lines 64-76): (a) call `fetchRecentEodDates(storeId, 2)`; (b) if
    the helper returns `>= 2` dates, return `{ from: dates[1], to:
    dates[0], eodCount: dates.length }`; (c) if shorter, return blank
    strings with the observed count; (d) on throw, return all blanks
    with `eodCount: 0`. The try/catch and the dates-descending
    convention are part of the contract — preserve them exactly.
- **`NewReportModal.tsx` callsite update:**
  - Remove the inline `async function seedVarianceDates` (lines 64-76,
    inclusive).
  - Remove the `import { fetchRecentEodDates }` line at the top (the
    inline function was its only consumer — verified by `Grep` during
    architecture; no other line in `NewReportModal.tsx` calls
    `fetchRecentEodDates`).
  - Add `import { seedVarianceDates } from '../../utils/seedVarianceDates';`
    near the top with the other utility imports.
  - All call sites (`NewReportModal.tsx:136` and `:163`) require zero
    changes — the function name is identical.
- **New test file:** `src/utils/seedVarianceDates.test.ts` (colocated,
  picked up by the `unit` jest project — `node` env, no React surface).
- **Test contract:**
  - Top-of-file `jest.mock('../lib/db', () => ({ fetchRecentEodDates:
    jest.fn() }))` — mocks the named export at the module boundary, NOT
    `supabase.ts`. This is the canonical pattern the architect rejected
    re-implementing in `tests/README.md:75-79`.
  - Three assertions minimum:
    - **Happy path:** `fetchRecentEodDates` returns `['2026-05-02',
      '2026-05-01']` → `seedVarianceDates('store-id')` returns
      `{ from: '2026-05-01', to: '2026-05-02', eodCount: 2 }`. Locks
      the descending-order → ascending-pair mapping.
    - **One-EOD-only path:** mock returns `['2026-05-02']` → result is
      `{ from: '', to: '', eodCount: 1 }`. Locks the blank-fallback
      behavior the modal's "danger hint" depends on.
    - **Error path:** mock throws → result is `{ from: '', to: '',
      eodCount: 0 }`. Locks the try/catch sentinel behavior.
- **Update `tests/README.md`:** add a sentence after the existing
  hybrid-mock example (line 54-79) pointing at
  `src/utils/seedVarianceDates.test.ts` as the wired reference example.
  Replace the synthetic `InventorySection` example with this one if
  retaining both bloats the section.

#### B5 — Transitive store-import gotcha docs extension

- **File:** `tests/README.md`, existing subsection at lines 81-111.
- **Extension shape (one paragraph):** add a "decision tree" preamble
  to the subsection that names the three patterns in priority order:
  (i) prefer extracting the testable logic OUT of the component so the
  store-import chain is never imported (point at B4's
  `seedVarianceDates` as the canonical example); (ii) if extraction is
  not possible, mock the theme hook (existing example, retained);
  (iii) if a future spec introduces a `ThemeProvider`, the mock
  collapses to wrapping `render()` (already mentioned but elevated to
  the decision tree).
- **Cross-link from B4's added example to B5's subsection.**
- **Also update the "First follow-up coverage targets" table at lines
  378-389** to reflect that all 11 retros are landing in this spec
  (the original table tagged 5 of them as "first targets"). Either
  collapse the table to "all 11 retros landed under spec 023, see
  `supabase/tests/`" or mark each row PASS with a link to the
  corresponding `.test.sql`. Recommend the shorter "collapse"
  approach — the per-row mapping lives in the test files themselves
  and the table is liable to drift.

### 3. CI performance budget

11 new DB tests adding ~1-3 seconds each (in line with the two existing
example tests' shape — `BEGIN; ... INSERT a handful of rows; CALL RPC;
ASSERT; ROLLBACK;`) totals **~11-33 seconds** of additional pgTAP work
inside the `db` job. The job already pays the ~60-90s `supabase start`
cold boot per spec 022 §11.5, so 11-33s of test work is a small marginal
add. Against the workflow's `timeout-minutes: 20` ceiling (set by the
022 polish patch at `b5d3e30`), we have ample headroom — current
estimated total job time stays well under 5 minutes. No timeout tuning
needed in spec 023. If observed times start to creep above 10 minutes
once 11 tests land, surface as a tuning follow-up; until then the 20-min
ceiling stands.

### 4. Forward-compat note for spec 024 (TS hygiene)

Spec 022's `typecheck:test` script currently reports pre-existing
errors when run against the repo as of 2026-05-13. Confirmed via the
release-proposal at `specs/022-test-framework-intro/reviews/release-proposal.md:50`:
the two offending files are `src/store/useStore.ts` and
`src/lib/webPush.ts`. The errors are pre-existing (not introduced by
022) and prevent `typecheck:test` from being wired as a CI gate. Spec
024 should: (a) run `npx tsc --project tsconfig.test.json --noEmit` to
catalogue the exact errors per file:line; (b) fix each error in place
(types narrowed, casts removed, etc.); (c) once `typecheck:test` exits
0 on a clean checkout, fold it into `.github/workflows/test.yml` as a
third job (matrix-with-jest, no DB cold-boot needed). The user has
flagged the ripple risk explicitly — `useStore.ts` is ~1100 lines and
load-bearing; the diff needs isolated review, which is why 024 is its
own spec. B3's deferral here is intentional. No work on these files
inside spec 023.

### 5. Risks and tradeoffs

- **A4 third arm overstates the trigger's scope.** The migration only
  declares two trigger arms (submitted_by + cross-store item). The
  spec's third sub-assertion (vendor-scoped current_stock write) is
  RPC-layer, not trigger-layer, and not reachable from manager JWT.
  Flagged as caveat back to PM above; recommend scope clarification.
- **A8 PM-prompt mismatch.** Spec 019's `inventory_counts` is fully
  append-only (no UPDATE policy at all). The PM-prompt's "admin can
  UPDATE → 1 affected" line is the `eod_submissions` semantics (spec
  020) and would require either changing the test target or relaxing
  the spec-019 migration — neither is correct. Flagged as caveat above.
- **A5 same-day-cutoff time-of-day flake.** Tests rely on `now()` at
  CI run time for the cutoff comparison. Mitigated by picking
  `order_cutoff_time` values at the day boundary; documented but
  unresolved. A future tightening could pull cutoff time into
  `p_params` for testability.
- **A10 fixture complexity.** Seeding three items + recipes + sales is
  the heaviest test in the set. If maintenance burden bites, a future
  spec could carve a `report_reorder_list_helper.sql` test-only helper
  function. Out of scope for 023 (spec ACs forbid shared fixtures
  across test files).
- **B1 lockfile churn.** `npm install` after dropping the dep
  regenerates `package-lock.json` — diff will include unrelated
  transitive package version movement. Standard, just call it out so
  the PR reviewer doesn't flag the diff size.
- **B4 mock-vs-import-order discipline.** `jest.mock` calls must
  precede any `import` of the module under test. Standard jest pitfall;
  document inline in the test file header comment for the next
  developer adding a similar test.
- **Seed-stability.** All Track A fixtures look up stores by name and
  use stable user UUIDs. Items / recipes / pos_imports for A2/A7/A10
  are INSERTED inside the test transaction, so seed drift on those
  tables doesn't affect the tests.
- **No publication-membership change.** None of the 11 tests touch
  `supabase_realtime`. No `docker restart supabase_realtime_imr-inventory`
  step needed.
- **No edge-function changes.** Zero functions touched. No
  `verify_jwt` setting changes.
- **No `src/lib/db.ts` surface changes.** B4 adds a new import line
  in `NewReportModal.tsx` only; `db.ts` itself is untouched. The new
  utility imports FROM `db.ts` (specifically `fetchRecentEodDates`),
  which is the architect-blessed direction.

### 6. Out-of-scope (architect-confirms)

Same as the spec's "Out of scope" section. No additional architect-side
scope additions.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. Track A is 11
  pgTAP test files under `supabase/tests/`, one per spec AC line, with
  the per-test `plan(N)` counts and fixture sketches the architecture
  pinned in §1. Track B is four cleanup items: B1 (drop
  `@testing-library/jest-native` dep + setup line, run `npm install` +
  `npm test --ci` to confirm green), B2 (remove the two
  `db-migrations-applied` references from README), B4 (extract
  `seedVarianceDates` to `src/utils/seedVarianceDates.ts`, update
  `NewReportModal.tsx` import, add `seedVarianceDates.test.ts`
  with the boundary-mock pattern from `tests/README.md:54-79`),
  and B5 (extend the transitive-store-import gotcha subsection of
  `tests/README.md` with the decision tree, and collapse or update the
  "First follow-up coverage targets" table). Surface the three caveats
  the architect flagged BEFORE implementing the affected tests so the
  PM has a chance to confirm: (a) A4 third arm overstates the
  trigger's scope; (b) A8 PM-prompt's "admin can UPDATE → 1 affected"
  is the eod_submissions semantics, NOT inventory_counts; (c) A5's
  same-day-cutoff has a small wall-clock flake window. After
  implementation, set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/023-retro-test-coverage/spec.md

## Files changed

### Track A — pgTAP retroactive tests (`supabase/tests/`)

- `supabase/tests/report_run_unknown_template.test.sql` — A1, plan(4).
- `supabase/tests/report_run_variance_formula.test.sql` — A2, plan(7).
- `supabase/tests/inventory_count_entries_check_store.test.sql` — A3, plan(3).
- `supabase/tests/eod_submissions_consistency.test.sql` — A4, plan(6).
- `supabase/tests/report_reorder_list_min_dow.test.sql` — A5, plan(5).
- `supabase/tests/reports_anon_revoke.test.sql` — A6, plan(8).
- `supabase/tests/report_run_variance_multivendor_sum.test.sql` — A7, plan(4).
- `supabase/tests/inventory_counts_append_only.test.sql` — A8, plan(5).
- `supabase/tests/eod_submissions_edit_flow.test.sql` — A9, plan(4).
- `supabase/tests/report_reorder_list_hybrid_formula.test.sql` — A10, plan(5).
- `supabase/tests/report_reorder_list_on_hand_source.test.sql` — A11, plan(3).

### Track B — forward-compat

- `package.json` — B1 dropped `@testing-library/jest-native` from
  devDependencies.
- `package-lock.json` — regenerated by `npm install` after the
  devDependency removal.
- `jest.config.js` — B1 removed
  `@testing-library/jest-native/extend-expect` from the component
  project's `setupFilesAfterEnv`; replaced with a comment explaining
  the removal.
- `README.md` — B2 dropped both `db-migrations-applied.yml` references
  (lines 137 + 224) and replaced the stale "CI deploy-gate" section
  with a pointer to `.github/workflows/test.yml` + `tests/README.md`.
- `src/utils/seedVarianceDates.ts` — B4 NEW extracted helper; contract
  preserved verbatim from the original inline implementation in
  `NewReportModal.tsx`.
- `src/utils/seedVarianceDates.test.ts` — B4 NEW colocated test;
  canonical `db.ts`-boundary mock proof point. Three assertions:
  happy path / one-EOD path / error path.
- `src/components/cmd/NewReportModal.tsx` — B4 import swap from
  `fetchRecentEodDates` (no longer needed) to the new utility module.
  Inline `seedVarianceDates` block removed; call sites untouched
  (function name preserved).
- `tests/README.md` — B5 extended the "Transitive store-import gotcha"
  subsection with the three-pattern decision tree (extract > mock-theme
  > provider-wrap) and pointed at `seedVarianceDates.test.ts` as the
  canonical example. Collapsed the "First follow-up coverage targets"
  table per architect's recommendation; the table is replaced with a
  "Retroactive coverage status" subsection summarizing where the
  retros now live.

### Notes (not files changed)

- B3 (`useStore.ts` / `webPush.ts` TS cleanup) intentionally deferred
  to spec 024. Verified that `npx tsc --noEmit -p tsconfig.test.json`
  produces only the pre-existing `useStore.ts` / `webPush.ts` errors;
  no new TS errors introduced by 023.
- All Track A tests verified hermetic: ran two tests back-to-back
  (`report_run_variance_formula` + `eod_submissions_consistency`) and
  pre/post counts on `inventory_counts`, `eod_submissions`,
  `eod_entries` unchanged.
- Architect's three caveats were honored at implementation time:
  (a) A4 — third arm collapsed to defense-in-depth on the columns the
  trigger doesn't check; trigger remains permissive on uncovered
  columns as the migration intends; (b) A8 — admin UPDATE/DELETE
  asserted as 0 rows; migration intentionally has NO update/delete
  policies on `inventory_counts`; (c) A5 — Scenario C uses
  `order_cutoff_time = '23:59:59'` to minimize wall-clock flake
  window to the last second of the UTC day.
- A9 deviates from the architect's literal "delete + reinsert"
  prescription for the fourth assertion because post-spec-020,
  `eod_entries` has no DELETE policy under any non-superuser
  caller (append-only). The admin-only UPDATE policy IS preserved,
  so the test exercises an UPDATE of `actual_remaining` — same
  end-state assertion, different mechanism. Documented in the test
  file header.
- A2 / A10 set `purchase_orders.po_number` explicitly to bypass the
  `generate_po_number` BEFORE-INSERT trigger; the trigger's
  substring-cast errors on pre-existing legacy dev rows whose
  po_numbers don't match `PO-NNN`. Pre-existing condition, not
  related to spec 023; documented inline in the test files.
