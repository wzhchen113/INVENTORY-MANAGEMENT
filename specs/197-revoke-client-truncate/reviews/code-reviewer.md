## Code review for spec 197

Scope: `supabase/migrations/20261109230000_revoke_client_truncate.sql`, `supabase/tests/public_no_client_truncate.test.sql`, and the comment-only edits to `supabase/tests/public_grants_explicit.test.sql`. I had no shell, so I could not run `git diff`. I checked the 097 file by grepping its TRUNCATE/197/construction wording and reading the changed regions. I found no changed assertion, plan count or message string. The spec's D-5 note says the diff is 14 insertions and 4 deletions of `--` lines only.

Checked and found correct:
- The plan count is 17: arms 1, 2, 3, 4, 5, 6a, 6b, 7, 8a-c, 9a-b, 10a-b, 11a-b.
- The relkind set `('r','p','f')` is the same literal in migration DO block (a) and probe arms 1-3. Arms 6a/6b use `('r','p')` on purpose.
- The default-ACL detector in migration DO block (b) matches probe arm 4 (`public` or global, grantee 0/anon/authenticated).
- Drop-then-assert and `set_config(..., true)` are used consistently. There is no `savepoint` and no `set role`.
- Arm 8 runs before arms 11a/11b, and 11a reverts before 11b runs.
- Multi-privilege checks AND single-privilege calls (arm 7), as the header GOTCHA says.
- The migration is idempotent, wrapped in `begin; ... commit;`, and does not touch `service_role` or `postgres`.
- No legacy-file edit, no `app.json` change, no client/`db.ts`/store change, and no new realtime channel.
- The test file follows the Track 2 pattern (`*.test.sql` under `supabase/tests/`, found automatically by `test-db.sh`).

### Critical
- None.

### Should-fix
- `supabase/tests/public_no_client_truncate.test.sql:252-263` (arm 7) — This arm asserts that `anon` holds INSERT/UPDATE/DELETE on `public.inventory_items`. That is a business-policy fact unrelated to this spec's invariant. The repo is tightening client writes (for example `20261109195000_user_stores_drop_own_row_writes`), so a legitimate future revoke on that table would turn this probe red. The failure message ("a revoke removed more than TRUNCATE") would then point the next developer at the wrong cause. Narrow it to what the arm is for. Either assert only `authenticated` SELECT/INSERT/UPDATE/DELETE and drop the `anon` write checks, or check the default ACL directly. Arm 5 already pins the six privileges there. If you keep it, make the message say "if a later spec intentionally tightened this table, update the sample table".

### Nits
- `supabase/tests/public_no_client_truncate.test.sql:11-13` — The header hard-codes "47 of 51 local tables (52 of 56 on prod)". Those are point-in-time numbers that go stale on the next migration, and a test file cannot vouch for prod. Say "most tables" and leave the counts to the spec.
- `supabase/migrations/20261109230000_revoke_client_truncate.sql:55-61` — "spec 064 gate, project MEMORY" refers to private agent memory, which a repo reader cannot resolve. Say "spec 064 drift gate" and drop "project MEMORY". The 70-line header, including the prod runbook and rollback recipe, also duplicates D-7 and D-8 of the spec. Those two blocks will drift if the spec changes. One line pointing at the spec section would do.
- `supabase/tests/public_grants_explicit.test.sql:148` — The edited SUBTLETY comment runs the new sentence into the old one on a single over-long line ("...never removed it). So arm 3 must explicitly REVOKE SELECT ..."). Re-wrap it so the new text and the original sentence are separate lines.
- `supabase/tests/public_no_client_truncate.test.sql:172-187, 411-425, 444-458` — The arm 4 detector query is written out three times (arm 4, 11a, 11b), and the migration DO block (b) is a fourth copy. The direct ACL detector is likewise repeated across arms 2, 9 and 10. This is acceptable house style for pgTAP self-tests, and a shared helper would be over-engineering. Keep the copies byte-identical: if arm 4's predicate changes, 11a/11b must change with it, or the self-tests stop testing the real detector. A one-line "keep identical to arm (4)" comment above 11a/11b would cover it.
- `supabase/migrations/20261109230000_revoke_client_truncate.sql:90` — `%s` with `c.oid::regclass` is fine here (regclass output is already quoted). The `pg_get_userbyid(a.grantee)::text` cast is redundant inside `format('%s')`. Harmless.
