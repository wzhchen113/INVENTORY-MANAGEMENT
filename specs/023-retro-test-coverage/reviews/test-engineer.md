## Test report for spec 023

### Verdict: APPROVE

All three test tracks pass cleanly. All 15 acceptance criteria verified.
No vacuous assertions found. No plan-count mismatches. CI budget is sound.

---

### Acceptance criteria status

#### Track A — Retroactive Critical regression tests

- **A1 (Spec 016 dispatcher unknown template)** → PASS
  `supabase/tests/report_run_unknown_template.test.sql` (4 assertions)
  Test calls `report_run('not_a_real_template', ...)` as a store-member and asserts:
  (1) fixture resolves, (2) returns a jsonb object (NOT raise exception),
  (3) `_status = 'not_implemented'`, (4) all four standard envelope keys present.
  The test would correctly FAIL (red) if the dispatcher were changed to
  `RAISE EXCEPTION` because the `throws_ok`-free shape relies on the RPC
  returning normally.

- **A2 (Spec 018 variance formula — strict reconciliation math)** → PASS
  `supabase/tests/report_run_variance_formula.test.sql` (7 assertions)
  All four formula terms are covered:
  - Prior: two `eod_submissions` rows with `eod_entries.actual_remaining = 10` (prior) and `4` (current)
  - Receiving: `po_items.received_qty = 3`
  - Sales: 0 (item intentionally not in any recipe — confirmed by `not exists` filter)
  - Waste: `waste_log.quantity = 1`
  Assertion chain: `expected = 12`, `counted = 4`, `delta = -8`, `dollar_impact = -8 × cost`.
  Integer fixtures make exact equality valid (no epsilon needed). Formula
  `delta = counted − (prior + receiving − sales − waste)` is precisely pinned.

- **A3 (Spec 019 cross-store `item_id` — trigger arm 2)** → PASS
  `supabase/tests/inventory_count_entries_check_store.test.sql` (3 assertions)
  Uses `throws_ok()` with SQLSTATE `42501`. Fixtures use superuser-level lookup
  to pick a Charles item, then switches to manager JWT for the attack-vector INSERT.
  Defense assertion confirms 0 entries persisted after the trigger rejection.

- **A4 (Spec 020 EOD consistency triggers)** → PASS
  `supabase/tests/eod_submissions_consistency.test.sql` (6 assertions)
  Three arms:
  (i) `submitted_by` override: forged master_id is rewritten to manager JWT's uid.
  (ii) Cross-store `item_id` on `eod_entries`: `throws_ok` asserts SQLSTATE `42501`.
  (iii) Defense-in-depth: same-store entry inserts cleanly (trigger is NOT over-strict).
  Honors the architect's caveat #1: no vendor_id trigger exists on `eod_entries`
  (the table has no `vendor_id` column). Arm iii correctly pins the permissive
  baseline rather than asserting a trigger that doesn't exist.

- **A5 (Spec 021 MIN-DOW lateral subquery)** → PASS
  `supabase/tests/report_reorder_list_min_dow.test.sql` (5 assertions)
  Three scenarios with `as_of_date = 2026-05-14` (Thursday):
  (A) Wed+Fri schedule → `days_until = 1` (not 6 — pre-fix bug explicitly named).
  (B) Same-day (Thu) with cutoff `00:00:01` → 7 (next cycle; passed cutoff).
  (C) Same-day (Thu) with cutoff `23:59:59` → 0 (today; cutoff not yet passed).
  The scenario A assertion directly names the pre-fix wrong value (6) in the
  test description, making regression value immediately obvious.

- **A6 (Spec 016 anon revoke)** → PASS
  `supabase/tests/reports_anon_revoke.test.sql` (8 assertions: 1 fixture + 7 throws_ok)
  All 7 RPCs verified as denied to `anon` role:
  1. `report_run(text, uuid, jsonb)`
  2. `report_run_stub(uuid, jsonb)`
  3. `report_run_cogs(uuid, jsonb)`
  4. `report_run_variance(uuid, jsonb)`
  5. `report_reorder_list(uuid, jsonb)`
  6. `submit_inventory_count(...)`
  7. `staff_submit_eod(...)`
  Test uses `set local role anon` + anon JWT claims matching PostgREST's shape.
  All seven assert SQLSTATE `42501`.

- **A7 (Spec 018 SUM aggregation — multi-vendor day)** → PASS
  `supabase/tests/report_run_variance_multivendor_sum.test.sql` (4 assertions)
  Fixture: one item, two vendors, same anchor dates. Prior sums 5+5=10; current
  sums 3+2=5. Assertions: `expected = 10`, `counted = 5`, `delta = -5`.
  Load-bearing assertion is `expected = 10` — pre-spec-020 this would have
  errored or returned single-vendor value.

- **A8 (Spec 019 append-only posture — UPDATE/DELETE deny)** → PASS
  `supabase/tests/inventory_counts_append_only.test.sql` (5 assertions)
  Tests 4 cells: manager UPDATE, manager DELETE, admin UPDATE, admin DELETE.
  All four assert 0 affected rows (RLS-filtered, not exception-raised — correct
  Postgres behavior per the spec comment). The test correctly honors the
  architect's caveat #2: admin UPDATE also returns 0 rows (differs from
  `eod_submissions` semantics where admin UPDATE IS permitted). Test description
  explicitly notes this distinction.

- **A9 (Spec 020 EDIT flow row-id preservation)** → PASS
  `supabase/tests/eod_submissions_edit_flow.test.sql` (4 assertions)
  Uses `ON CONFLICT DO UPDATE` via admin JWT (EDIT flow is admin-gated).
  Asserts: (1) id preserved across upsert, (2) `submitted_at` bumped using
  `clock_timestamp()` (not `now()` — correctly handles single-transaction
  limitation). Third assertion confirms `actual_remaining` UPDATE works under
  admin policy.

- **A10 (Spec 021 hybrid formula — max(par_replacement, usage_forecasted))** → PASS
  `supabase/tests/report_reorder_list_hybrid_formula.test.sql` (5 assertions)
  Three items exercising all paths: par-only (suggested=10), usage-only
  (suggested=7), both-paths (suggested=max(20,7)=20). Fixture seeds full chain:
  `catalog_ingredients` → `inventory_items` → `recipes` → `recipe_ingredients`
  → `pos_imports` → `pos_import_items`. Rollback discards all fixture data.
  Sanity assertion (4) confirms the par-only item has `usage_forecasted = 0`.

- **A11 (Spec 021 EOD-first sourcing)** → PASS
  `supabase/tests/report_reorder_list_on_hand_source.test.sql` (3 assertions)
  Two scenarios in one plan:
  (a) Vendor A has today's EOD → `on_hand_source = 'eod'`
  (b) Vendor B has no EOD today → `on_hand_source = 'stock'`
  Uses `current_date` to keep the test date-independent.

#### Track B — Forward-compat cleanups

- **B1 (`@testing-library/jest-native` removal)** → PASS
  `package.json` confirms no `@testing-library/jest-native` devDependency
  (only `@testing-library/react-native: ^13.0.0` remains). `jest.config.js`
  component project `setupFilesAfterEnv` contains no `extend-expect` line;
  inline comment explains the removal. `npm test -- --ci` exits 0 with 17 tests.

- **B2 (README stale workflow reference)** → PASS
  `grep -n 'db-migrations-applied' README.md` returns no matches.
  The README now points at `.github/workflows/test.yml` (the real workflow).
  `tests/README.md` also correctly references `test.yml`.

- **B4 (Canonical `db.ts`-boundary mock proof point)** → PASS
  `src/utils/seedVarianceDates.ts` extracted from `NewReportModal.tsx`.
  `src/utils/seedVarianceDates.test.ts` has `jest.mock('../lib/db', ...)` at
  module level (hoisted). Three assertions cover happy / one-EOD / error paths.
  Test runs in isolation in 0.14s with `--runInBand --testPathPattern=seedVarianceDates`.
  No transitive Supabase client pull-in confirmed — no `.env` errors.
  `NewReportModal.tsx` call site updated to import from `../../utils/seedVarianceDates`.

- **B5 (Transitive store-import gotcha decision tree)** → PASS
  `tests/README.md` section "Transitive store-import gotcha" has been extended
  with a three-step decision tree at line 90+:
  (1) Extract logic out of the component (canonical example: `seedVarianceDates.test.ts`)
  (2) Mock the theme hook if extraction not possible (example: `StatusPill.test.tsx`)
  (3) Provider-wrap `render()` for future `<ThemeProvider>` specs
  The decision tree is explicitly labeled "spec 023 / B5" and the canonical
  `seedVarianceDates.test.ts` example is cross-referenced.

---

### Test run

```
# Track 1 — jest
npm test -- --ci
PASS component src/components/cmd/StatusPill.test.tsx
PASS unit src/utils/relativeTime.test.ts
PASS unit src/utils/seedVarianceDates.test.ts
Tests: 17 passed, 17 total (3 test suites)
Time: 0.535s

# Track 2 — pgTAP DB tests (13 files)
npm run test:db
eod_submissions_consistency.test.sql       PASS (6 assertions)
eod_submissions_edit_flow.test.sql         PASS (4 assertions)
inventory_count_entries_check_store.test.sql PASS (3 assertions)
inventory_counts_append_only.test.sql      PASS (5 assertions)
inventory_counts_set_submitted_by.test.sql PASS (3 assertions)
report_reorder_list_hybrid_formula.test.sql PASS (5 assertions)
report_reorder_list_min_dow.test.sql       PASS (5 assertions)
report_reorder_list_on_hand_source.test.sql PASS (3 assertions)
report_run_cogs.test.sql                   PASS (5 assertions)
report_run_unknown_template.test.sql       PASS (4 assertions)
report_run_variance_formula.test.sql       PASS (7 assertions)
report_run_variance_multivendor_sum.test.sql PASS (4 assertions)
reports_anon_revoke.test.sql               PASS (8 assertions)
✓ 13/13 DB test file(s) passed

# Track 3 — shell smokes
npm run test:smoke
All CORS + auth checks passed (2 skipped: no BOBBY_TOKEN)
smoke-rpc.sh: report_run stub envelope shape PASS
✓ all checks passed
```

---

### Detailed verification findings

**Plan-count accuracy (all 13 files):** static grep of `select plan(N)` vs
`select is|isnt|ok|throws_ok` lines matches exactly for every file. The
runtime test run also confirms this (pgTAP's own finish() would fail-out if
they diverged). No mismatches.

**A2 all-four-term coverage:** prior EOD (actual_remaining=10), receiving
(received_qty=3), sales (forced to 0 via no-recipe item filter), waste
(waste_log.quantity=1). Integer inputs make exact equality valid — the test
uses `::numeric` casts after stripping thousands-separator commas. Off-by-one
in any single term would produce a wrong expected/delta/dollar_impact value
that the `is()` assertions would catch.

**A5 regression specificity:** the scenario A assertion description reads
`'scenario A: Thursday→Friday = 1 day (NOT 6 from raw-DOW-min bug)'` — the
old wrong value is named directly. Future regressions produce obvious diffs.

**A6 all-7-RPCs confirmed:**
1. `public.report_run(text, uuid, jsonb)` — dispatcher
2. `public.report_run_stub(uuid, jsonb)` — spec 016
3. `public.report_run_cogs(uuid, jsonb)` — spec 017
4. `public.report_run_variance(uuid, jsonb)` — spec 018
5. `public.report_reorder_list(uuid, jsonb)` — spec 021
6. `public.submit_inventory_count(...)` — spec 019
7. `public.staff_submit_eod(...)` — spec 020

**A4 architect caveat honored:** arm iii confirms the trigger is permissive
on columns it doesn't check (no vendor_id column on eod_entries), rather than
asserting a non-existent vendor_id consistency trigger.

**A8 architect caveat honored:** all 4 cells (manager UPDATE, manager DELETE,
admin UPDATE, admin DELETE) assert 0 affected rows — NOT 1. The file explicitly
documents "differs from eod_submissions semantics" to prevent future confusion
between the two specs' distinct postures.

**B4 isolation confirmed:** `jest --runInBand --testPathPattern=seedVarianceDates`
exits in 0.14s. No Supabase client errors (mock intercepts at `src/lib/db`
boundary before `src/lib/supabase.ts` is imported).

**CI budget — `timeout-minutes: 20` headroom:** `.github/workflows/test.yml`
has `timeout-minutes: 20` for the `db` job. Local run of all 13 DB test files
completes in under 10s on top of a running stack. The 11 new files add
negligible overhead (most are sub-100ms each; the A10 hybrid-formula test
is the heaviest at ~300ms due to the recipe+POS fixture chain). Total DB test
runtime including the pre-existing 2 files remains well under 1 minute.
The 20-minute budget is dominated by `supabase start` cold-boot (~60-90s
per the CI comment) — the new tests represent less than 2% of that.

**Developer-experience smoke:** created and ran a 2-assertion `isCanonicalUnit`
test against `src/utils/unitConversion.ts` in isolation. Jest picked it up in
0.23s with no configuration changes. File was removed after validation (not
committed). Confirms the iteration loop is fast and the `unit` project pattern
(no DB, no jsdom) is immediately usable for the next developer adding tests.

---

### Spec 024 forward-compat — TS errors to address

`npx tsc --noEmit -p tsconfig.test.json` exits non-zero with 9 errors across
2 files:

**`src/lib/webPush.ts`** (1 error):
- `(97,9)` — `Uint8Array<ArrayBufferLike>` not assignable to `BufferSource`
  (TypeScript 5.3 tightened `SharedArrayBuffer` exclusion from `ArrayBuffer`).

**`src/store/useStore.ts`** (8 errors):
- `(821,11)` and `(916,13)` — `storeLoading` does not exist in `FullStore`
  (property was removed or renamed in the store type).
- `(923,38)`, `(923,52)`, `(923,64)`, `(923,80)` — `casePrice`, `caseQty`,
  `subUnitSize`, `subUnitUnit` specified more than once in object literal
  (duplicate spread + explicit key conflict).
- `(1746,7)` — `"User deleted"` not assignable to `AuditAction` (missing
  enum variant).
- `(1847,34)` — `storeName` does not exist on `Omit<OrderSubmission, "id">`.

None of these errors affect runtime behavior of the currently-passing tests
(jest uses babel-jest which strips types at transpile time). They will need
to be resolved in spec 024 before `typecheck:test` can be added as a CI gate.

---

### Notes

- No vacuous assertions found (`ok(true)` pattern did not appear in any file).
  All `ok()` calls check meaningful boolean conditions (e.g., `submitted_at`
  bumped comparison in A9).
- `tests/README.md` "Retroactive coverage status (spec 023)" section is
  present and correctly states all 11 A-tests have landed.
- `tests/README.md` "First follow-up Track 1 targets" section still lists
  `convertToItemUnit` as a future target — appropriate, as it is out of scope
  for spec 023.
- No legacy files were modified (confirmed by git status at spec review time).
- The A1 test does not use `throws_ok` for the shape check — it asserts the
  function returns normally, which correctly encodes the dispatcher contract
  that unknown templates must NOT raise.
