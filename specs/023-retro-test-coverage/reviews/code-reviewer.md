# Code review — Spec 023 (Retro test coverage)

## Summary

- 0 Critical
- 3 Should-fix
- 5 Nits

## Critical

None.

## Should-fix

### S1 — Missing error-message check in cross-store trigger test

`supabase/tests/inventory_count_entries_check_store.test.sql:101-110`. `throws_ok` is called with `null` as the third argument, which means the test only checks SQLSTATE (`42501`), NOT the error message text. The spec (§A3) explicitly requires asserting the message matches `'item store mismatch'`. A different trigger that also raises `42501` (e.g., the `submitted_by` override on a different table) would silently pass this test.

**Fix.** Change the third arg from `null` to `'item store mismatch'`. pgTAP does a substring match, so the exact trigger message `'inventory_count_entries: item store mismatch with parent count'` will pass.

### S2 — Seed contamination risk in variance formula test

`supabase/tests/report_run_variance_formula.test.sql:194-198`. The `rows array length = 1` assertion is brittle against the local seed data, which was pulled on 2026-05-02. The seed may contain real `eod_submissions` for Frederick on 2026-05-01 and 2026-05-02 — those items would appear in the variance runner's output, inflate the `rows` array, and either fail the length check or cause subsequent `->0`-indexed assertions (2)–(5) to assert against the wrong item.

**Fix.** Instead of asserting on `->0`, filter the rows array by the fixture's `item_id`:

```sql
(select r from _env, jsonb_array_elements(env->'rows') r where r->>'item_id' = current_setting('test.item_id', true))
```

Remove the `rows length = 1` guard or replace it with a looser "fixture item appears at least once" check.

### S3 — Same seed-contamination shape in multivendor-sum test

`supabase/tests/report_run_variance_multivendor_sum.test.sql:121-143`. Identical issue to S2: anchor dates 2026-05-01/2026-05-02 match the seed-pull date, making contamination likely. Assertions (1)–(3) use `->0` blindly.

**Fix.** Same pattern as S2 — filter rows by `item_id` using `jsonb_array_elements`.

## Nits

### N1 — Decision-tree priority order in B5 docs differs from spec

`tests/README.md:90-108`. The decision tree puts "extract logic out of the component" first and "mock the theme hook" second, reversing the priority the spec §B5 prescribed (mock-first, extract-second). The delivered order is arguably better practice (extraction avoids the problem rather than working around it) but contradicts the spec's stated framing.

**Fix.** Either revert to spec order, OR add a one-line comment explaining the deliberate change so future readers understand why the docs diverge from the spec text.

### N2 — A5 wall-clock window is a deterministic failure point, not flakiness

`supabase/tests/report_reorder_list_min_dow.test.sql:25-30`. Scenario C's note says "CI only flakes within the last 1s of the UTC day." If `now()` UTC reads 23:59:59 exactly when the test runs, the assertion fails deterministically.

**Fix.** Could be inverted — assert `days_until` is `>= 0` (distance is 0 or 7) instead of exactly 0 — to fully eliminate the window. Leave as-is if the 1-second window is acceptable.

### N3 — Format-string sync risk in A2

`supabase/tests/report_run_variance_formula.test.sql:76-79`. The dollar-impact pre-computation uses `to_char(abs(...), 'FM999,990.00')`. The runner code uses `'FM999,990.000'` (3 decimal places) in one place and `'FM999,990.00'` (2 decimal places) in another. If the runner's formatting ever diverges between the two migration files, this pre-computation will silently produce the wrong expected string.

**Fix.** Consider extracting the format string as a named pattern comment so it stays in sync.

### N4 — Comment clarity in EDIT-flow test

`supabase/tests/eod_submissions_edit_flow.test.sql:105-111`. The comment about `now()` vs `clock_timestamp()` is good but slightly misleading: it implies the `pg_sleep(0.01)` is separate from the `clock_timestamp()` advance. The sleep is what ensures `clock_timestamp()` returns a strictly greater value than the first `now()`.

**Fix.** Clearer wording: "We sleep 10ms before the second write so `clock_timestamp()` at that point is strictly > the first transaction-`now()`."

### N5 — Justification phrasing in anon-revoke test

`supabase/tests/reports_anon_revoke.test.sql:26-29`. Comment says "`set local role anon` requires the test runner to be a superuser, which pgTAP under `psql` is." Phrasing implies pgTAP confers superuser privilege; actually the psql session runs as the `postgres` superuser.

**Fix.** "...which the `psql` session runs as the `postgres` superuser."
