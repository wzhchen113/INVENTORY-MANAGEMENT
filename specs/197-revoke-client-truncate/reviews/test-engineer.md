## Test report for spec 197

### Acceptance criteria status
Probe: `supabase/tests/public_no_client_truncate.test.sql` (plan 17). Arm numbers below refer to it.

- AC-1 (no client TRUNCATE on existing tables, local) -> PASS. Probe arms 1, 2, 3. Independent catalog check: effective anon/authenticated TRUNCATE over relkind r/p/f = 0.
- AC-2 (default ACL has no D, other privileges kept) -> PASS. Arms 4 and 5. Live `pg_default_acl`: postgres/public = `anon=arwdxtm, authenticated=arwdxtm`, `service_role=arwdDxtm`. There is no global postgres row. The probe checks arwdxt as a subset and does not pin `m` (D-4 deviation from AC-2's literal wording; the live ACL shows `arwdxtm`).
- AC-3 (privileged roles keep TRUNCATE) -> PASS. Arms 6a and 6b. Live: service_role 51/51 and postgres 51/51. The 097 probe arm 5c passes inside the full run.
- AC-4 (other privileges untouched) -> PASS. Arm 7 (inventory_items keeps SELECT/INSERT/UPDATE/DELETE for both roles). `public_grants_explicit.test.sql` passes (13/13) in the full run. `git diff` of that file shows only comment lines changed (D-5).
- AC-5 (idempotent) -> PASS, on developer evidence only. Spec notes record a second apply returning BEGIN/REVOKE/ALTER DEFAULT PRIVILEGES/DO/COMMIT with exit 0. I did not re-run the apply (instructed not to re-apply). The post-state I checked is consistent with it.
- AC-6 (new tables born clean) -> PASS. Arms 8a, 8b, 8c.
- AC-7 (catches a table that regains TRUNCATE) -> PASS. Arms 9a and 9b (count exactly 1).
- AC-8 (catches a PUBLIC grant) -> PASS. Arms 10a (effective 2) and 10b (direct 1). The expected count is stated in D-3.
- AC-9 (catches a default ACL that regained D) -> PASS. Arm 11a (per-schema, 1) and 11b (global tripwire, 1).
- AC-10 (red before, green after) -> PASS, red run on developer evidence. The pre-migration red run (10 of 17 failed; arms 1 and 2 = 94; arm 3 lists the 47 tables per role; 11b = 2) is recorded in the spec's "Build after D-11". It cannot be reproduced now that the migration is applied. I confirmed the green side: 17/17 passed in my own run.
- AC-11 (whole suite) -> PASS for pgTAP (my run). Jest and typecheck are developer-reported, not re-run by me.
  - `scripts/test-db.sh`: 104/104 files passed (my run).
  - `npx jest`: 301/301 suites, 3836/3836 tests (developer-reported).
  - `npm run typecheck:test`: exit 0 (developer-reported).
- AC-12 (CI gates green after push) -> PENDING, owner go-ahead. This needs the prod apply first, then the push. Not missing.
- AC-13 (prod: zero client TRUNCATE) -> PENDING, owner go-ahead.
- AC-14 (prod: default ACL, supabase_admin unchanged) -> PENDING, owner go-ahead.
- AC-15 (prod: version recorded, outputs pasted) -> PENDING, owner go-ahead.

### Test run
- `bash scripts/test-db.sh supabase/tests/public_no_client_truncate.test.sql`: PASS, 17 assertions.
- `bash scripts/test-db.sh` (full): `104/104 DB test file(s) passed`.
- Read-only catalog checks on the local DB:
  - Effective client TRUNCATE pairs (r/p/f): 0.
  - service_role / postgres TRUNCATE on r/p: 51/51 and 51/51.
  - `schema_migrations` has `20261109230000 | revoke_client_truncate`. It is the latest file on disk.
  - supabase_admin/public default ACL is unchanged (`arwdDxtm` for clients), the accepted leftover.
- Not run by me: jest, typecheck:test. AC-5's re-apply.

### Notes
- Coverage is all Track 2 (pgTAP). No new jest or smoke tests are needed, per the spec.
- Because CI's image may already lack client `D`, a green CI run does not prove the migration works (D-4). The local red-to-green run and the prod Q-a/Q-d before and after carry the proof. The prod checks are still outstanding (AC-13/14).
- The probe deliberately excludes views and matviews (D-11), so a future `grant all` on a view would not be flagged. This is accepted in D-10 #5.
- No gaps: no AC is NOT TESTED or FAIL. AC-12 to AC-15 are pending the owner's go-ahead by design.
