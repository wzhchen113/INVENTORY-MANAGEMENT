## Security audit for spec 197

Scope reviewed:
- `supabase/migrations/20261109230000_revoke_client_truncate.sql` (new)
- `supabase/tests/public_no_client_truncate.test.sql` (new, plan 17)
- `supabase/tests/public_grants_explicit.test.sql` (comment-only diff, checked with `git diff HEAD`: only `--` lines changed, and no assertion, plan, message or allowlist changed)
- Spec D-7 prod runbook and D-8 rollback

I checked the local DB read-only (`supabase_db_imr-inventory`, PG 17.6, migration `20261109230000` recorded). I did not touch prod.

**Verdict: no Critical, no High.** The revoke is complete for everything a `postgres` migration controls in `public`. The probe can't be fooled by PUBLIC, by inherited membership or by relkind `p`/`f`. Nothing else lost privileges. The runbook and rollback are safe and do not re-open `profiles`. Five Low items follow, all hardening or residual notes.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low

- **L-1: client TRUNCATE remains outside `public`, and the `postgres`/`storage` default ACL still carries client `D`. Out of scope by owner decision, but the posture is "no client TRUNCATE in `public`", not "anywhere".** Local check: `anon` and `authenticated` still have effective TRUNCATE on `storage.objects`, `storage.buckets`, `storage.buckets_analytics`, `net.http_request_queue`, `net._http_response`, `supabase_functions.hooks` and `supabase_functions.migrations`. All of these are owned by Supabase roles (`supabase_storage_admin`, `supabase_admin`, `supabase_functions_admin`), so a `postgres` REVOKE can't remove those grants. It would only warn, because the grantor isn't `postgres`. The threat vector is the same one this spec closes: a future SECURITY INVOKER function with dynamic SQL. `truncate net.http_request_queue` would silently drop queued pg_net calls. Separately, `pg_default_acl` (`postgres`, `storage`, `r`) is `anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres`. Any table a migration creates in `storage` would be born with client TRUNCATE. `postgres` **can** fix that one. No migration creates tables in `storage` today, so this is latent. Fix: none needed for 197. Record it under Residual risk, and fold `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage REVOKE TRUNCATE ON TABLES FROM anon, authenticated, public` into the Q2 MAINTAIN follow-up if the owner opens one. Spec ref: "Out of scope: Schemas other than public" (`specs/197-revoke-client-truncate.md:272-273`).

- **L-2: the probe hard-codes `{anon, authenticated}` and uses `has_table_privilege`, which only follows INHERIT membership.** `supabase/tests/public_no_client_truncate.test.sql:92-95, 134-137`. Today this is sound. `anon` and `authenticated` are members of no role. The only rows in `pg_auth_members` touching them are `authenticator -> anon/authenticated` (inherit=f, set=t) and `postgres -> anon/authenticated`, and neither gives the client roles anything. The probe can't be fooled by PUBLIC (arm 2 grantee 0 plus arm 1 effective), by inherited grants (arm 1), or by relkind `p`/`f` (both in the set). Two gaps remain:
  - A future `grant <privileged_role> to authenticated with inherit false` (SET-only, PG16+) would let injected dynamic SQL run `set role …; truncate …` without arm 1 seeing it.
  - A future client-facing role, such as a dedicated customer-PWA role, would not be scanned.

  Fix (optional, cheap): add an arm asserting `anon` and `authenticated` are members of no role (`select count(*) from pg_auth_members where member in ('anon'::regrole, 'authenticated'::regrole)` = 0). Any spec that adds a client-facing role should extend the VALUES list in arms 1 and 3.

- **L-3: the P0.5 rollback generator emits unqualified table names, and its `relowner` filter exists only as prose.** Spec `specs/197-revoke-client-truncate.md:813-819`. `c.oid::regclass` renders without the schema when the relation is on `search_path`. Locally, `'public.audit_log'::regclass::text` returns `audit_log`, and the session search_path is `"$user", public, extensions`. So the saved rollback text reads `grant truncate on audit_log to anon;`, which resolves correctly only under a search_path that includes `public`. If it's pasted into a future `<ts>_restore_client_truncate.sql` (D-8 step 1, "verbatim"), it silently depends on that path. Also, the D-11 amendment `and c.relowner = 'postgres'::regrole` is described after the query, not written into it, so an operator copying the code block gets the unfiltered version. That's harmless, because extra lines on `supabase_admin` views only warn, but it isn't what the design intends. Fix: write the query as `format('grant truncate on %I.%I to %s;', n.nspname, c.relname, …)` and put the `relowner` predicate inside the code block. Either way, the generator only emits tables that held client `D` at P0 time, so it **cannot** include `profiles`, `inventory_item_tombstones` or the two audit tables. The rollback can't re-open spec 041's escalation.

- **L-4: CI cannot prove prod's posture, and a Supabase platform upgrade could silently restore client `D` on prod.** Spec D-4 / D-10 #3 (`specs/197-revoke-client-truncate.md:709-712, 901-909`). The spec already acknowledges this. I'm adding it to the record because it's the only way the fix regresses without the repo changing. The `supabase_admin` default ACL for `public` still carries `anon=arwdDxtm` (verified locally). Any `supabase_admin`-created table in `public` on prod is born with client TRUNCATE, for example a dashboard-enabled extension that installs a real table into `public`, such as postgis's `spatial_ref_sys`. CI runs on a fresh image and won't see it. Fix: none in this spec. Recommend the owner adopt "re-run Q-a after any platform upgrade or dashboard extension install" under open question Q3, rather than the default "accept permanently".

- **L-5 (informational, for the Q2 follow-up spec): revoking MAINTAIN will not close client `LOCK TABLE`.** In PG17, `LOCK TABLE` in SHARE-or-stronger modes (including ACCESS EXCLUSIVE) is allowed to any role holding UPDATE, DELETE, TRUNCATE **or** MAINTAIN. Clients keep UPDATE and DELETE on 49 tables (verified locally), so they can still take ACCESS EXCLUSIVE through the same dynamic-SQL vector after this spec and after a MAINTAIN revoke. Spec D-10 #9 (`specs/197-revoke-client-truncate.md:925-928`) lists LOCK TABLE as a MAINTAIN risk. A follow-up spec should frame MAINTAIN as VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH only, so it doesn't claim to close the lock-DoS. No action for 197.

### Assessment notes (positive findings, for the release-coordinator)

**Completeness of the revoke.**
- `20261109230000_revoke_client_truncate.sql:75`, `revoke … on all tables in schema public from anon, authenticated, public`. This covers every relkind `ON ALL TABLES` reaches.
- Locally after apply: 0 client TRUNCATE entries in `public` across **all** relkinds, not just `r`/`p`/`f`. `public` holds 51 `r` tables plus 1 `S`, all owned by `postgres`, and no relation has a NULL `relacl`.
- No ACL entry in `public` has a grantor other than the owner. So the "REVOKE only removes the caller's own grants" trap doesn't apply locally.
- On prod, the DO block's check (a) (lines 87-103) catches that trap regardless of grantor, because it reads `aclexplode(relacl)` without a grantor predicate.
- `:77-78` default ACL: `postgres/public/r` is now `anon=arwdxtm, authenticated=arwdxtm`, and `service_role=arwdDxtm` and `postgres=arwdDxtm` keep `D`. There's no global (`defaclnamespace = 0`) `postgres` row, and DO check (b) (lines 106-118) plus probe arm 4 trip if one ever appears.
- **Fail-closed behaviour is correct.** A relation `postgres` can't revoke on either warns, in which case check (a) raises and rolls back the whole transaction, or errors outright when `postgres` holds no privilege on it at all. Both abort the apply, and the insert placed before `commit;` never commits. There's no half-applied or recorded-but-not-applied state.

**Nothing else lost privileges.**
- `authenticated` holds exactly `DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE` on all 49 tables it had grants on. The two audit tables stay locked as before, and `profiles` / `inventory_item_tombstones` keep everything except TRUNCATE, as before.
- The sequence and function default ACLs are unchanged.
- `service_role` keeps TRUNCATE everywhere (arm 6a; developer's Q-c 51/51).
- No publication change: `supabase_realtime` still has 12 tables, and no realtime restart is needed.
- No RLS policy is touched.
- No client, edge-function, script or e2e code issues TRUNCATE (re-grepped).

**Probe integrity.**
- Arms 9a/9b/10a/10b/11a/11b self-test the detectors against a direct grant, a PUBLIC grant, a per-schema default and a global default.
- The drop-then-assert shape keeps them hermetic.
- The relkind set `('r','p','f')` in arms 1-3 matches the DO block's (a) literally (`migration:97` vs `test:94, 113, 136, 146`).
- Keeping `'f'` is correct: postgres_fdw implements foreign-table TRUNCATE in PG14+.
- Excluding views and matviews loses no security signal, because TRUNCATE on them fails whatever the ACL says.

**D-7 runbook.**
- The safety properties hold: P0.1 identity STOP, P0.3 owner STOP for `r`/`p`/`f`, P0.4 global-ACL STOP, a single atomic `execute_sql` with the version insert inside the transaction, no `apply_migration`, and post-checks including a byte-identical `supabase_admin` entry.
- The runbook keeps secrets out of it: no tokens, keys or PII appear.
- Only L-3's cosmetic issue applies.

**D-8 rollback.**
- Per-(table, grantee) re-grant from the P0.5 capture, with an explicit ban on `on all tables`. Spec 041's `profiles` TRUNCATE+INSERT escalation and the three other pre-locked tables stay closed under every documented rollback path.
- The default-ACL re-grant affects only future tables. One consequence worth stating: after a rollback, any newly created sensitive table would be born with client `D` again and would need its own explicit revoke, as spec 041 did for `profiles`.
- The "before push only" path deletes the version row and reverts repo files, so it leaves no undetected drift. D-8 correctly calls out that a hand-applied rollback with no migration file is invisible to the drift gate.

### Dependencies
- `package.json` shows as modified in the working tree, but that change isn't part of spec 197. It's a scripts-only edit appending `bash scripts/smoke-delete-user.sh` to `test:smoke`, with no dependency change, and `package-lock.json` is unchanged.
- I ran `npm audit --audit-level=high` anyway: 46 vulnerabilities (9 low, 19 moderate, 17 high, 1 critical).
  - Critical: `shell-quote` (transitive).
  - High includes direct `@react-navigation/{native,stack,bottom-tabs,drawer}`, plus transitive `ws`, `node-forge`, `dompurify`, `form-data`, `js-yaml` and `postcss`.
- All of these predate this spec, since the lockfile is untouched. Not attributable to 197 and not blocking it. Recommend a separate dependency-hygiene pass.
