## Code review for spec 196

Scope: `supabase/migrations/20261109200000_po_number_server_assigned.sql`, `supabase/tests/po_number_server_assigned.test.sql`, and the unstaged AC-16 hunk in `supabase/tests/report_run_variance_formula.test.sql`. Built on spec 190's `20261109140000_po_number_sequence.sql`.

Verified by reading:
- The migration matches the D-2/D-3 design statement for statement.
  - The function is explicitly `security invoker` with `set search_path = public`.
  - The EXECUTE revoke covers `public, anon, authenticated`.
  - The trigger is idempotent, with no column list and no WHEN.
  - The slot `20261109200000` is the newest file on disk and sorts after 190, 194 and `20261109195000`.
- The guard body calls no function and reads no claims. `current_user` is a SQL keyword.
- `plan(68)` matches my arm count: A 19, C 14, D 5, E 2, F 2, G 2, H 3, I 21.
- Every refusal arm pins SQLSTATE and message through `throws_ok`. Every allowed UPDATE arm pins `ok:1`. Every "written or unchanged" claim is read back as postgres.
- The AC-16 hunk only drops `po_number` from the column list and the value list, and rewrites the comment. `plan(7)` and the assertions are untouched.
- There are no direct Supabase calls, no legacy-file edits, no `app.json` change, no custom `jwt` SQL and no new realtime channels. The test file follows Track 2.

### Critical
- None.

### Should-fix
- None.

### Nits
- `supabase/tests/po_number_server_assigned.test.sql:336,342,348,356,363,373-375,475,493` — The `try_sql` arms hard-code the fixture uuid literals (`'b1960004-0000-0000-0000-0000000000NN'`). The rest of the file uses `pg_temp.pid(n)` and `pg_temp.fid(n)`. Dynamic SQL can call the pg_temp helpers, or `format('... %L', pg_temp.pid(6))` can build the string. Two spellings of the same id means a prefix change would silently turn an `ok:1` arm into `ok:0`. This is low risk, because each arm's read-back would catch it. Fix it only if you are touching the file anyway.
- `supabase/tests/po_number_server_assigned.test.sql:129,134` — The AC-12 "body never mentions jwt / auth." arms run against `prosrc`, which includes comments. A future explanatory comment such as "reads no JWT claims" inside the function body would fail the arm even though the code is unchanged. Strip `--` comments before the regex, or add a one-line note beside the arms. Today the body is clean.
- `supabase/tests/po_number_server_assigned.test.sql:380-400` — The AC-5 expected-value stash (`seq_next()` as postgres, then insert) assumes nothing else in the database calls `nextval` on `purchase_orders_po_number_seq` in between. That holds for a sequential `test-db.sh` run, and the file documents it. It would be flaky if the suite ran next to `scripts/smoke-po-number-concurrency.sh` or live local traffic. Add a short "single-session assumption" comment at the stash. (Whether this needs coverage is deferred to test-engineer.)
- `supabase/migrations/20261109200000_po_number_server_assigned.sql:95-98` — The "bad trigger wiring" branch has no test arm. It is a defensive fail-closed path and follows spec 194 precedent. A one-off arm that attaches the function as a statement-level or DELETE trigger would pin it, but that is optional. (Deferred to test-engineer.)
- `supabase/migrations/20261109200000_po_number_server_assigned.sql:139` — `drop trigger if exists` takes ACCESS EXCLUSIVE on `purchase_orders`, which blocks reads as well as writes until commit. The spec design (D-2 item 2, D-13 item 6) describes the lock as SHARE ROW EXCLUSIVE. `lock_timeout = '5s'` still bounds the wait, so the behaviour is fine. Only the stated lock level is wrong. Correct the wording in the prod-apply runbook if you reuse it, and do not copy it into the migration header.
- `supabase/tests/po_number_server_assigned.test.sql:7-19` — The header block-index skips block B (fixtures). This is trivial.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 6 Nit.
payload_paths:
  - specs/196-po-number-server-assigned/reviews/code-reviewer.md
