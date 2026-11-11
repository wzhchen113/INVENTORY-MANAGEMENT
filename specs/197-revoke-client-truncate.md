# Spec 197: Revoke TRUNCATE from client roles on every public table

Status: READY_FOR_REVIEW

Origin: a Low finding in `specs/190-po-number-sequence/reviews/security-auditor.md`
(lines 107-124), relayed by the main session on 2026-11-09 with the scope
decisions below. Local and prod figures come from the main session's checks that
day (prod: read-only) and were not re-run for this spec. Line numbers are
pointers.

## Problem

Client roles (`anon`, `authenticated`) hold the `TRUNCATE` privilege (`D` in an
ACL) on almost every table in `public`, and every new table gets it
automatically. Nothing in the app needs it. Spec 097 meant to remove it and
didn't.

### Background (already verified; do not re-derive)

**No client path needs TRUNCATE.**
- There are no TRUNCATE statements in `src/`, `supabase/functions/`, `scripts/`,
  `e2e/`, `App.tsx`, `supabase/tests/` or `supabase/seed.sql`.
- The only TRUNCATE SQL in migrations is spec 041's
  `revoke truncate on public.profiles from authenticated, anon;`
  (`20260517040000_auth_can_see_store_brand_scope.sql:305`).
- PostgREST, Realtime and pg_graphql expose no TRUNCATE verb.
- So today the risk is a **future** SECURITY INVOKER function that runs dynamic
  SQL as the caller. The only existing dynamic-SQL path, `report_run_custom`
  (`20260515130000_report_run_custom.sql`), blocks writes with a runtime
  `set local transaction_read_only = on` (line 184), not with a privilege check.
  With TRUNCATE revoked, the privilege system blocks it even when a future
  function forgets that guard.

**Why spec 097 didn't fix it.**
- `20260618000000_public_grants_explicit.sql` grants a list without TRUNCATE
  (`select, insert, update, delete, references, trigger`), for existing tables
  (line 147) and through default privileges (line 189).
- GRANT only adds. The image's existing `arwdDxtm` grants and the existing
  default ACL already held `D`, so they stay.
- That migration's comments (lines 62, 75, 185) say the TRUNCATE class is
  "closed by construction". **That is wrong.** Migrations can't be edited, so
  this spec corrects the record here and does not touch that file.
- The same wrong assumption appears in:
  - the header and arm comments of `supabase/tests/public_grants_explicit.test.sql`
    (for example lines 140-141, 269-270: "born WITH the (no-TRUNCATE) grant");
  - `20260703000000_user_count_drafts.sql:104-113`;
  - spec 190 D-11 #4 and its sequence comment
    (`20261109140000_po_number_sequence.sql`, around line 186).

  Once this spec is applied, those statements become true.

**Local state (2026-11-09).**
- 51 `public` tables, all owned by `postgres`.
- `anon` and `authenticated` each have TRUNCATE on 47 of them.
- 4 are already locked: `profiles`, `spec093_case_qty_backfill_audit`,
  `spec104_per_each_cost_audit`, `inventory_item_tombstones`.
- `pg_default_acl` for role `postgres`, schema `public`, type `r`:
  `anon=arwdDxtm, authenticated=arwdDxtm`. There is a matching entry for role
  `supabase_admin`.
- No PUBLIC grants.

**Prod state (read-only check, 2026-11-09).**
- 56 `public` tables, all owned by `postgres`.
- `anon` and `authenticated` each have TRUNCATE on 52, with the same 4 locked.
- The default ACLs look the same as local.
- Prod's `postgres` is **not** a superuser and **not** a member of
  `supabase_admin`, so a migration cannot change `supabase_admin`'s default ACL.
  Migrations create tables as `postgres`, so `FOR ROLE postgres` is the entry
  that matters.
- The `supabase_admin` entry is a **known, accepted leftover** (see "Residual
  risk").

**Existing probe.** `supabase/tests/public_grants_explicit.test.sql` checks
TRUNCATE only on `profiles` (arm 5). It has no schema-wide TRUNCATE check and no
default-ACL check.

## User story

As the **owner of 2AM PROJECT**, I want no client role to be able to TRUNCATE
any table in `public`, now or on tables added later, and CI to fail if that ever
changes, so that a future SQL function bug can't wipe a whole business table in
one statement.

## Proposed change

1. **One migration**, ordered after the latest migration on disk at build time
   (currently `20261109195000_user_stores_drop_own_row_writes.sql`). It:
   - revokes TRUNCATE on every table in `public` from `anon`, `authenticated` and
     `PUBLIC`;
   - runs
     `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated, PUBLIC`.
   - Both statements are idempotent, so running it again changes nothing.
   - It does not touch `service_role` or `postgres`, so both keep TRUNCATE. This
     is the spec 041 / spec 097 position: `service_role` is a separate, trusted
     grant audience, and the owner always has it.
   - It does not try to change `supabase_admin`'s default ACL (prod can't).
2. **A pgTAP probe** (Track 2) that fails CI when:
   - any `public` table grants TRUNCATE to `anon`, `authenticated` or `PUBLIC`;
     or
   - `postgres`'s default ACL for tables in `public` still grants it to any of
     them.
3. **No client, `db.ts`, store, edge-function, RLS-policy or realtime change.**

## Acceptance criteria

All pgTAP criteria are Track 2 and run as `postgres` (the `scripts/test-db.sh`
connection role). "Client roles" means `anon`, `authenticated` and `PUBLIC`
(grantee OID 0 in `aclexplode`). "Public tables" means every relation in
`public` that TRUNCATE can actually act on: `relkind in ('r', 'p', 'f')`
(tables, including partitions; partitioned tables; foreign tables). Views and
materialized views are excluded because Postgres rejects TRUNCATE on them
whatever their ACL says. The migration's `ON ALL TABLES` revoke still covers
every kind; only the checks are narrowed. (Amended by the architect,
2026-11-09; see D-11.)

### Migration effect

- [ ] **AC-1 (no client TRUNCATE on existing tables, local).** After the migration,
  for every public table:
  - `has_table_privilege('anon', <t>, 'TRUNCATE')` is false;
  - `has_table_privilege('authenticated', <t>, 'TRUNCATE')` is false;
  - no `aclexplode(relacl)` row has grantee 0 (PUBLIC) with `privilege_type = 'TRUNCATE'`.

  The count of offending (table, role) pairs is 0.
- [ ] **AC-2 (default ACL no longer has `D`).** No `pg_default_acl` row has
  `defaclrole = 'postgres'::regrole`, `defaclobjtype = 'r'` and
  `defaclnamespace` equal to `public` **or 0** (global) with an `aclexplode`
  entry granting `TRUNCATE` to `anon`, `authenticated` or PUBLIC. The
  `postgres`/`public` entry still exists and still carries the other privileges
  for `anon` and `authenticated`: `arwdxtm`, i.e. only `D` removed.
- [ ] **AC-3 (privileged roles keep TRUNCATE).** For every public base table:
  - `has_table_privilege('service_role', <t>, 'TRUNCATE')` is true;
  - `has_table_privilege('postgres', <t>, 'TRUNCATE')` is true.

  Spec 097 probe arm 5c (`service_role` on `profiles`) still passes unchanged.
- [ ] **AC-4 (other privileges untouched).** Spec 097's
  `public_grants_explicit.test.sql` passes with no assertion changed: SELECT is
  still present for all three roles except its allowlist, and arms 5-7 still
  hold. The architect may also check that INSERT/UPDATE/DELETE are unchanged on
  a sample table.
- [ ] **AC-5 (idempotent).** Running the migration body a second time against an
  already-migrated local DB succeeds with no error, and AC-1 to AC-3 still hold.
- [ ] **AC-6 (new tables are born without client TRUNCATE).** In the pgTAP
  transaction, a throwaway table created as `postgres` in `public` has:
  - `has_table_privilege` TRUNCATE false for `anon` and `authenticated`;
  - no PUBLIC TRUNCATE entry;
  - TRUNCATE true for `service_role`;
  - SELECT true for all three roles, which shows the rest of spec 097's default
    grant still applies.

  Drop it before asserting (drop-then-assert pattern, see `public_grants_explicit.test.sql`
  header).

### The probe can actually fail

- [ ] **AC-7 (catches a table that regains TRUNCATE).** In the pgTAP transaction:
  create a throwaway public table, `grant truncate ... to authenticated`, and run
  the same detection query as AC-1, limited to that table. The hit count is
  exactly 1. Drop the table, then assert.
- [ ] **AC-8 (catches a PUBLIC grant).** Same as AC-7, with
  `grant truncate ... to public`. The PUBLIC arm flags it.
  - Note: `has_table_privilege('anon', …)` also turns true here, because every
    role is a member of PUBLIC. The architect states the expected count.
- [ ] **AC-9 (catches a default ACL that regains `D`).** In the pgTAP transaction:
  `alter default privileges for role postgres in schema public grant truncate on tables to authenticated`,
  then run the AC-2 detection query. It flags exactly that entry. Revert it with
  the matching `revoke` before asserting, or rely on the outer `rollback` if the
  architect confirms pgTAP's counters are unaffected. Default-privilege changes
  are transactional.
- [ ] **AC-10 (red before, green after).** The developer runs the new probe
  against the local DB **before** applying the migration:
  - it fails, and its readable-output arm lists the 47 tables per role
    (94 pairs; the pgTAP harness views are out of scope per D-11);
  - after applying the migration it passes.

  Record both runs in the spec's implementation notes.

### Suite and gates

- [ ] **AC-11 (whole suite).** Full `scripts/test-db.sh` passes every file. Full
  `npx jest` and `npm run typecheck:test` pass. No TypeScript change is expected,
  so this is a no-regression check. Per project practice, run the full jest
  suite, not a subset.
- [ ] **AC-12 (CI gates after push).** After the commit is pushed to `main`, the
  latest `main` runs of both `.github/workflows/test.yml` and
  `.github/workflows/db-migrations-applied.yml` are green. The prod apply must
  come before the push, or the drift gate goes red.

### Prod (only after the owner's explicit go-ahead)

- [ ] **AC-13 (prod: zero client TRUNCATE).** After the prod apply:
  - the AC-1 offending-pair count on prod is 0. Expected per-role table counts
    go from 52 to 0. The table total was 56 on 2026-11-09 and may have grown
    since.
  - every public base table still grants TRUNCATE to `service_role`. The
    expected count is the current table total.
- [ ] **AC-14 (prod: default ACL).**
  - The prod `postgres`/`public`/`r` default ACL entry carries no `D` for `anon`
    or `authenticated`.
  - The `supabase_admin` entry is **unchanged**. Record its value in the apply
    notes as the accepted leftover.
- [ ] **AC-15 (prod: recorded).** The exact migration version is in
  `supabase_migrations.schema_migrations` on prod, and the AC-13/AC-14 query
  outputs are pasted into the spec's implementation notes.

## Prod verification queries (read-only; the design may refine them)

```sql
-- Q-a: client TRUNCATE grants on public relations (expect 0 rows)
select c.relname, coalesce(r.rolname, 'PUBLIC') as grantee
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public'
  and a.privilege_type = 'TRUNCATE'
  and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
order by 1, 2;

-- Q-b: effective privilege, including grants through role membership (expect 0)
select count(*)
from pg_tables t, (values ('anon'), ('authenticated')) v(role)
where t.schemaname = 'public'
  and has_table_privilege(v.role, format('%I.%I', t.schemaname, t.tablename), 'TRUNCATE');

-- Q-c: service_role keeps TRUNCATE (expect = count of public base tables)
select count(*) filter (where has_table_privilege('service_role',
         format('%I.%I', schemaname, tablename), 'TRUNCATE')),
       count(*)
from pg_tables where schemaname = 'public';

-- Q-d: table default ACLs (postgres/public: no D for anon/authenticated;
--      supabase_admin: unchanged, record it)
select pg_get_userbyid(defaclrole) as role,
       coalesce(defaclnamespace::regnamespace::text, '<global>') as schema,
       defaclacl
from pg_default_acl
where defaclobjtype = 'r'
order by 1, 2;
```

Run Q-a to Q-d **before** the apply as well. Save the list of tables where
`anon` or `authenticated` held TRUNCATE; the rollback needs it.

## In scope

- One idempotent migration with the two revokes above, plus a header that:
  - explains why spec 097 left `D` in place;
  - notes that spec 097's "closed by construction" comments were inaccurate;
  - records the `supabase_admin` leftover;
  - says "No publication change, so NO `docker restart supabase_realtime_imr-inventory` step".
- The pgTAP probe, either as a new file or as new arms in
  `public_grants_explicit.test.sql` (see "Design constraints").
- Applying the migration locally and recording it in local
  `supabase_migrations.schema_migrations`, as specs 186/187/189/190 did.
- Optionally, comment-only fixes to the stale "no-TRUNCATE baseline" wording in
  `supabase/tests/public_grants_explicit.test.sql` (test files are editable). The
  architect decides; otherwise list them under "Noticed, not changed".

## Out of scope (explicitly)

- **The PG17 `MAINTAIN` privilege (`m`).** The image default also grants it to
  `anon` and `authenticated`, on existing tables and in the default ACL. It
  allows VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH MATERIALIZED VIEW/LOCK TABLE.
  It's a candidate follow-up spec with the same shape. It isn't added here
  because the owner limited the scope to TRUNCATE.
- **`REFERENCES` and `TRIGGER` for client roles.** Spec 097 grants them on
  purpose. Not reopened.
- **`supabase_admin`'s default ACL.** Prod's `postgres` can't change it. It's
  accepted as a leftover. The per-table arm (AC-1) still catches any table
  created by `supabase_admin` that ends up with client TRUNCATE.
- **Schemas other than `public`** (`storage`, `auth`, `graphql_public`, …).
  Supabase manages those.
- **Removing TRUNCATE from `service_role` or `postgres`.** Their keeping it is
  required (AC-3).
- **Editing spec 097's migration** `20260618000000_public_grants_explicit.sql`
  or any other applied migration, including spec 190's sequence comment.
  Migrations can't be changed. This spec makes their claims true instead.
- **Sequence and function privileges.** Unchanged; spec 097's default
  privileges for those classes stay as they are.
- **Changing the `app.json` slug.** Not touched.

## Decisions already made (relayed by the main session, 2026-11-09)

- Q: Only TRUNCATE, or also MAINTAIN? → A: TRUNCATE only. MAINTAIN is listed as
  a follow-up.
- Q: Should `service_role` and `postgres` keep TRUNCATE? → A: Yes, for the
  spec 041 / spec 097 reason.
- Q: How does it reach prod? → A: Through the Supabase MCP `execute_sql` path
  plus an exact version insert into `supabase_migrations.schema_migrations`.
  This happens **only** with the owner's explicit go-ahead. `db push` lacks the
  prod password. No commit without owner approval.
- Q: Should spec 097's migration comments be fixed? → A: No, migrations can't
  be changed. This spec records the correction.
- Q: What about `supabase_admin`'s default ACL? → A: It's an accepted
  leftover, because prod's `postgres` can't change it.
- Q: Re-runs? → A: The migration must be idempotent and sorted after the latest
  migration on disk.

## Open questions (owner; each has a default, none blocks design)

- **Q1: Prod timing.** Apply this together with spec 190's prod apply (one MCP
  session), or on its own? **Default: separately, with its own go-ahead.** The
  two don't depend on each other.
- **Q2: MAINTAIN follow-up.** Open a spec now for the matching `MAINTAIN`
  revoke, or just keep the note? **Default: keep the note. The PM opens a spec
  only if the owner asks.**
- **Q3: Residual review.** Re-check the `supabase_admin` default ACL now and then
  (for example after a Supabase platform upgrade), or accept it permanently?
  **Default: accept it. The per-table probe arm is the backstop.**

## Design constraints left to the architect

- **New file or extend `public_grants_explicit.test.sql`.**
  - **PM recommendation: a new file**, e.g.
    `supabase/tests/public_no_client_truncate.test.sql`, with a cross-reference
    comment in both files. Reasons:
    - it's a separate invariant: negative and schema-wide, plus a default-ACL
      check the 097 file doesn't have;
    - a failure shows up under its own name;
    - spec 097's 13-assertion plan and arm numbering stay stable.
  - **The other option:** extending the 097 file keeps every grant-posture check
    in one place, and its header already claims to cover TRUNCATE.
  - Either way, arm 5 (`profiles` TRUNCATE) stays. Overlapping with it is fine.
- **Which `relkind`s count as "public tables".** `ON ALL TABLES` covers tables,
  partitioned tables, views, materialized views and foreign tables. The probe
  should check at least the same set the migration revokes on, so a view or
  partitioned table with a `D` entry can't slip through. Using `pg_tables` alone
  (as the 097 probe does) would miss them.
  *(Superseded by D-11: the checks use `('r','p','f')`, the kinds TRUNCATE can
  act on. A view/matview `D` is inert, and pgTAP's own views make the wider set
  permanently red in the harness.)*
- **Global default ACL.** Postgres adds per-schema default privileges to the
  global ones. A schema-scoped `REVOKE` **cannot** remove a privilege granted
  by a global (`defaclnamespace = 0`) entry. Before writing the migration,
  confirm that local and prod have no global `postgres` table entry carrying
  `D` for client roles (Q-d covers prod). If one exists, the design must say how
  to handle it. AC-2 and AC-6 would fail if it isn't handled.
- **Detection method.** Use both `has_table_privilege` (effective, includes
  membership and PUBLIC) and `aclexplode` (direct entries, including grantee 0
  for PUBLIC). Say which arm owns which check.
- **Readable failure output.** Include a `string_agg` arm that lists the
  offending `public.<table> / <role>` pairs, as spec 097 arm 2 does.
- **Migration version and name.** Must sort after the latest migration on disk
  when it's built (currently `20261109195000`). Suggested:
  `20261109210000_revoke_client_truncate.sql`. Check that no in-flight spec
  (for example the other spec 196) has claimed that timestamp first. Wrap it in
  `begin; … commit;`.
- **Rollback design** (below). Confirm or refine it.

## Rollback

The repo only moves forward. If client TRUNCATE ever has to come back:

1. Re-grant **only** to the tables that held it before the apply, using the list
   saved from Q-a/Q-b before the apply. For example:
   `grant truncate on public.<t> to anon, authenticated;` for each saved table.
2. **Do NOT** use `grant truncate on all tables in schema public to anon, authenticated`.
   That would reopen spec 041's `profiles` TRUNCATE+INSERT escalation
   (`20260517040000:305`) and unlock the three other tables that were already
   locked (`spec093_case_qty_backfill_audit`, `spec104_per_each_cost_audit`,
   `inventory_item_tombstones`).
3. Restore the default:
   `alter default privileges for role postgres in schema public grant truncate on tables to anon, authenticated;`
4. A rollback also needs the new probe removed or reversed in the same change,
   or CI goes red.

## Residual risk

- **The `supabase_admin` default ACL still carries `D` for client roles.** A
  table created in `public` **by `supabase_admin`** would be born with client
  TRUNCATE. Migrations, the pgTAP suite and normal SQL run as `postgres`, so
  this needs a Supabase-internal action. If it happens to a table (relkind
  `r`/`p`/`f`), the per-table arm (AC-1) fails CI or shows up in the prod Q-a
  check.
  - **One such action happens on every pgTAP run.** Each test file's
    `create extension if not exists pgtap` is executed (via supautils) as
    `supabase_admin` in `public`, inside the test transaction, and creates two
    views, `public.tap_funky` and `public.pg_all_foreign_keys`, with
    `anon=arwdDxtm` / `authenticated=arwdDxtm` from this default ACL. They
    exist only inside test transactions (no migration installs pgTAP;
    `tests/README.md` "No migration adds the extension"). They are views, so
    the `D` is inert, and the D-11 relkind set excludes them.
  - **Local foot-gun.** The `tests/README.md` sanity command
    (`psql -c "create extension if not exists pgtap; …"`) runs in autocommit
    and installs pgTAP **persistently** in local `public`. The views then stay
    outside test transactions too. With the D-11 relkind set that's harmless
    to both the probe and the migration's DO block.
  - **Prod pgTAP state: unverified.** No in-repo evidence reads prod's
    `pg_extension`. The only indirect evidence is the 2026-05-02 `db pull`
    (`20260502071736_remote_schema.sql:3`), which lists only `pg_net` as an
    extension in `public`. D-7 P0.6 checks it read-only before the apply.
- **An explicit `grant all on <table> to authenticated`** in a future migration
  would bring TRUNCATE back for that table. The probe catches it.

## Dependencies

- Spec 041: `20260517040000_auth_can_see_store_brand_scope.sql:305` (profiles
  TRUNCATE revoke).
- Spec 097: `20260618000000_public_grants_explicit.sql` (the additive
  no-TRUNCATE grant and default privileges this spec completes);
  `supabase/tests/public_grants_explicit.test.sql` (existing probe and
  drop-then-assert pattern).
- Spec 053: `supabase/tests/permissive_policy_lint.test.sql` (pattern for
  scanning every table, with an allowlist).
- Spec 190: its D-11 #4 and sequence comment become accurate once this applies.
  There's no ordering dependency.
- In-flight migrations 186-196 (`20261108120000` to `20261109195000` on disk
  today). This spec's migration doesn't read or write their objects. It must
  sort after all of them, and any table they create must also lose client
  TRUNCATE. The `ON ALL TABLES` revoke covers tables created by earlier
  migrations, and the default-ACL change covers tables created later.

## Project-specific notes

- Cmd UI section: none. Database only, with nothing visible to users.
- Per-store or admin-global: schema-wide privilege change. RLS and
  `auth_can_see_store()` are untouched.
- Realtime channels touched: none. No publication change, so no
  `docker restart supabase_realtime_imr-inventory` step.
- Migrations needed: yes, one.
- Edge functions touched: none. Edge functions using `service_role` keep
  TRUNCATE, and none issue it.
- Web/native scope: not applicable (database only), so it covers both.
- Test tracks:
  - Track 2 (pgTAP): required. The new probe, or new arms in the 097 file.
  - Track 1 (jest): full run as a no-regression check only.
  - Track 3 (shell smoke): not needed.

## Prod apply

Requires the owner's explicit go-ahead. Apply before pushing, or
`db-migrations-applied.yml` goes red.

1. Run the read-only Q-a to Q-d on prod (project `ebwnovzzkwhsdxkpyjka`). Save
   the pre-apply table list for rollback, and check there is no global
   `postgres` default ACL entry with `D`.
2. Run the migration body through Supabase MCP `execute_sql`.
3. Insert the exact migration version into `supabase_migrations.schema_migrations`.
4. Run Q-a to Q-d again: AC-13 and AC-14.
5. After pushing, confirm the latest `main` runs of both `test.yml` and
   `db-migrations-applied.yml` are green (AC-12).

## Backend design

Architect, 2026-11-09. Database only. This section settles every item under
"Design constraints left to the architect" and refines the prod runbook. Where it
differs from the PM text above, this section wins.

### D-0 Corrections to the Background (they don't change scope)

- **There is a second TRUNCATE revoke in migrations.** Besides spec 041's
  `profiles` revoke, `20261026100000_inventory_items_identity_lock.sql:150` runs
  `revoke truncate on public.inventory_item_tombstones from anon, authenticated;`.
  That explains why `inventory_item_tombstones` is one of the 4 locked tables.
- **`supabase/tests/` does mention TRUNCATE**, but only to check that clients
  CAN'T do it: `auth_can_see_store_brand_scope.test.sql` arm 14 and
  `profiles_rls_sweep.test.sql` arm 12 (`throws_ok` on `truncate table
  public.profiles`, expecting 42501), and `inventory_items_identity_lock.test.sql`
  T62/T63 (`not has_table_privilege(... 'TRUNCATE')`). This spec makes all of
  them more true, so none can turn red.
- **No migration creates views, materialized views, foreign tables or
  partitioned tables in `public`.** No `create view`, `create materialized
  view`, `create foreign table` or `partition by` DDL appears in any migration
  (the only `partition by` hits are window functions), and locally, outside a
  test transaction, `public` holds 51 relations, all relkind `r`, all owned by
  `postgres`.
  - *Corrected 2026-11-09 (D-11):* that is **not** true inside the pgTAP
    harness. Every test file's `create extension if not exists pgtap` creates
    two `supabase_admin`-owned views in `public`, `tap_funky` and
    `pg_all_foreign_keys`, carrying client `D` from the `supabase_admin`
    default ACL. They exist only for the life of the test transaction (or
    persistently, if someone ran the `tests/README.md` autocommit sanity
    command locally). Prod: unverified, see Residual risk and D-7 P0.6.

### D-1 Data model change: one migration

**File:** `supabase/migrations/20261109230000_revoke_client_truncate.sql`.
It's additive in effect (it only removes a privilege nobody uses), it isn't
destructive to data, and it's idempotent.

**Why this version.** On disk today: `…120000`, `…140000`, `…170000`,
`…195000` (the latest). In-flight specs have also claimed `20261109190000`
(spec 193) and `20261109191000` (spec 191), which aren't on disk yet. Spec 196
hasn't picked a slot. `230000` sorts after all of them and leaves
`195001`–`225959` free for spec 196 or anything else today. **Build-time
re-check:** run `ls supabase/migrations | tail -5` before creating the file. If
anything at or after `20261109230000` has landed, move to the next free slot
after it, and change the version everywhere it appears (the filename, the
D-7 insert text, AC-15 notes). The drift gate compares exact version strings,
so the prod `schema_migrations` row must byte-match the final filename's
14-digit prefix.

**Ordering vs. other in-flight migrations.** None is needed. A table created
by a migration that sorts *before* this one is covered by `ON ALL TABLES`. A
table created by one that sorts *after* (or that reaches prod later in time) is
born under the fixed default ACL. Fresh-DB order and prod apply order reach the
same end state.

**Body (shape only; the developer writes it):**

```
-- header (see "Header must say" below)
begin;

revoke truncate on all tables in schema public from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated, public;

do $$  -- fail-closed post-check, same shape as spec 195's DO block
  -- (a) direct ACL: count (relation, grantee) pairs over the D-3 relkind set
  --     ('r','p','f') -- MUST be the same literal set as probe arms 1-3 (D-11)
  --     where aclexplode(relacl) has privilege_type = 'TRUNCATE' and
  --     grantee in (0, 'anon'::regrole, 'authenticated'::regrole).
  --     If > 0: raise exception '197: client TRUNCATE still granted on %', <list>;
  -- (b) default ACL: count pg_default_acl rows with defaclrole = 'postgres'::regrole,
  --     defaclobjtype = 'r', defaclnamespace in ('public'::regnamespace, 0)
  --     whose aclexplode(defaclacl) grants TRUNCATE to 0/anon/authenticated.
  --     If > 0: raise exception '197: postgres default ACL still grants TRUNCATE to a client role';
$$;

commit;
```

- The DO block checks only **direct** entries, the thing the two statements
  control. Effective privilege through membership belongs to the probe (D-3).
- The DO block exists for prod. A table owned by a role other than `postgres`
  would make `postgres`'s REVOKE quietly skip it: Postgres warns, it doesn't
  fail. The raise rolls back the whole transaction, including the
  `schema_migrations` row pasted into the apply text (D-7), so prod never ends
  up half-done or recorded as done when it isn't.
- **Header must say:** why spec 097 left `D` in place (GRANT only adds, and the
  image's `arwdDxtm` plus the existing default-ACL entry already held `D`); that
  spec 097's "closed by construction" comments (migration lines 62, 75, 185) were
  wrong until now; that the `supabase_admin` default-ACL entry is an accepted
  leftover (prod's `postgres` can't change it); that `service_role` and
  `postgres` keep TRUNCATE (spec 041 / 097 position); that MAINTAIN is
  deliberately out of scope; and "No publication change, so NO `docker restart
  supabase_realtime_imr-inventory` step. No PostgREST reload needed."

### D-2 Default-ACL semantics (item 3, confirmed)

- Postgres builds a new table's ACL from the **global** entry (the
  `defaclnamespace = 0` row, or the built-in default when there's no row) plus
  the **per-schema** entry. For relations the built-in default is owner-only
  and grants nothing to PUBLIC or other roles.
- A per-schema `REVOKE` can only undo what a per-schema entry grants. That's
  exactly our case: the `D` comes from the explicit
  `(postgres, public, 'r')` row (`anon=arwdDxtm/postgres,
  authenticated=arwdDxtm/postgres`). `ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM …` edits that row in place, to
  `anon=arwdxtm/postgres, authenticated=arwdxtm/postgres`. The row stays because
  its ACL is still non-empty. Revoking `FROM public`, where no PUBLIC entry
  exists, does nothing and raises no error.
- The caller already checked that no `defaclnamespace = 0` row exists for
  `postgres`, locally or on prod. So nothing can add `D` back from the global
  side, and the schema-scoped revoke is enough. The probe (arm 4) and the
  migration's DO block both check the global row as a tripwire, so a future
  global grant fails CI.
- Default ACLs cover the whole "tables" class: `defaclobjtype = 'r'` applies to
  tables, partitioned tables, views, materialized views and foreign tables. So
  the fix also covers future views.
- **Executing role.** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` needs the
  session to be `postgres`, a member of `postgres`, or a superuser. Migrations
  run as `postgres`. For prod, step P0.1 checks the MCP session's role first.

### D-3 Probe: location, relkinds, detection method (items 1, 2, 5)

**Location: a new file, `supabase/tests/public_no_client_truncate.test.sql`.**
- **Discovery.** `scripts/test-db.sh` (lines 66-68) runs
  `find supabase/tests -name '*.test.sql' | sort -z`, and CI's Track 2 job
  (`.github/workflows/test.yml:180-185`) just runs `npm run test:db`. A new file
  is picked up automatically, with no registration and no workflow edit. Each
  file runs in its own `begin; … rollback;`, so the new file can't disturb
  spec 097's file and vice versa.
- **Why a new file.** I agree with the PM. It's a separate negative,
  schema-wide invariant plus a default-ACL check. A failure shows up under its
  own name. Spec 097's 13-assertion plan and arm numbering stay as they are. And
  the 097 file's positive SELECT arms use `pg_tables`, while this probe needs a
  wider relkind set. Mixing the two scopes in one file would be confusing.
- Arm 5 of the 097 file (`profiles` TRUNCATE) stays unchanged. The overlap is
  fine.

**Relkind set = `('r', 'p', 'f')`** (amended 2026-11-09, D-11; was
`('r','p','v','m','f')`). Use `pg_class` joined to `pg_namespace` where
`nspname = 'public'`, not `pg_tables`. The same literal set is used by probe
arms 1-3 **and** the migration's DO block (a), so the two can't diverge.
- These are the kinds TRUNCATE can act on: tables (partitions are relkind `r`
  with `relispartition`, so they're included), partitioned tables, and foreign
  tables (PG14+ supports `TRUNCATE` on foreign tables when the FDW implements
  it; `postgres_fdw` does, gated by its `truncatable` option, default true).
  Sequences (`S`) belong to `ON ALL SEQUENCES` and can't hold TRUNCATE.
  Indexes, TOAST tables and composite types can't hold privileges.
- **Views and matviews are deliberately not checked.** Postgres lets them carry
  `D` (`GRANT ALL` on a view stores `arwdDxtm`), but TRUNCATE on one fails with
  "is not a table" whatever the ACL says, so the bit grants nothing. The
  migration's `ON ALL TABLES` revoke still clears `D` on any `postgres`-owned
  view, and the fixed default ACL won't put it on new ones; we just don't
  assert on them. The concrete reason: pgTAP's own `supabase_admin`-owned views
  (`tap_funky`, `pg_all_foreign_keys`) carry client `D` inside every test
  transaction, and nothing a `postgres` migration does can remove it.
- **Privileged-role arm (AC-3)** uses only `('r', 'p')`, because "keeps
  TRUNCATE" is pinned for our own base tables; a future foreign table owned by
  someone else shouldn't fail it.

**Detection method: two arms, each owning a different job.**

| Arm | Function | Owns | Why |
|---|---|---|---|
| Effective | `has_table_privilege(<role>, c.oid, 'TRUNCATE')` for `anon`, `authenticated` | "Can this client role actually truncate?" Includes direct grants, PUBLIC grants (every role belongs to PUBLIC) and grants inherited through role membership | This is the security question. Use the `oid` overload, which avoids `%I.%I` quoting |
| Direct | `aclexplode(c.relacl)` with `privilege_type = 'TRUNCATE'` and `grantee in (0, 'anon'::regrole, 'authenticated'::regrole)` | The stored ACL entries, **including PUBLIC (grantee 0)**, labelled `PUBLIC` | Shows *where* the grant lives, which tells you what to revoke. It's the only arm that names PUBLIC as PUBLIC. `relacl IS NULL` means the built-in owner-only default and correctly yields no rows |

- **Membership caveat.** `has_table_privilege` reports effective privilege, so
  a hit doesn't tell you where the grant lives. A PUBLIC grant shows up as both
  `anon` and `authenticated`, and a grant to a role that `anon` inherits from
  shows up as `anon` with no direct entry. That's the right *security* signal
  but a misleading *remediation* signal, which is why the direct arm exists and
  why arm 3 lists both labels. Going the other way, membership can't hide a
  direct entry: the direct arm reads `relacl` itself. (Postgres also accepts
  `has_table_privilege('public', …)`. We don't rely on it; PUBLIC is owned by
  the `aclexplode` arm.)
- **Gotcha for the developer.** `has_table_privilege(role, t, 'SELECT,INSERT')`
  returns true if **any** listed privilege is held. Every multi-privilege check
  (arms 5 and 7) must AND separate single-privilege calls.

**Plan: 17 assertions.** Throwaway tables use the double-underscore marker
(`public.__truncate_probe_born`, `__truncate_probe_direct`,
`__truncate_probe_public`). Session variables use `test.t197_*` with
`set_config(..., true)`. The probe runs as `postgres`, with no `set role`
(spec 067 segfault precedent).

| # | AC | Assertion |
|---|---|---|
| 1 | AC-1 | `is(count, 0)`: effective arm, relkind set × {anon, authenticated} |
| 2 | AC-1 | `is(count, 0)`: direct arm, relkind set, grantee in (0, anon, authenticated) |
| 3 | AC-1, AC-10 | `is(string_agg, '')`: the `DISTINCT` union of arms 1 and 2 as `public.<rel> / <anon\|authenticated\|PUBLIC>`, sorted. Before the migration this lists the 47 tables per role (94 pairs, deduped because the effective and direct labels are the same for anon/authenticated) |
| 4 | AC-2 | `is(count, 0)`: `pg_default_acl` rows with `defaclrole = 'postgres'::regrole`, `defaclobjtype = 'r'`, `defaclnamespace in ('public'::regnamespace, 0)`, with an `aclexplode(defaclacl)` entry of `TRUNCATE` for grantee 0/anon/authenticated. The `0` branch is the global tripwire. Do **not** include `supabase_admin` (accepted leftover) |
| 5 | AC-2 | `is(count, 0)`: missing (role, privilege) pairs in the `(postgres, public, 'r')` entry over {anon, authenticated} × {SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER}. A missing row gives 12, which also proves the entry still exists. See D-4 for why `m` isn't pinned |
| 6a | AC-3 | `is(count, 0)`: relkind `('r','p')` tables where `not has_table_privilege('service_role', oid, 'TRUNCATE')` |
| 6b | AC-3 | Same as 6a for `postgres` |
| 7 | AC-4 | `ok(...)`: on `public.inventory_items`, `anon` holds SELECT, and `authenticated` holds SELECT, INSERT, UPDATE and DELETE (5 ANDed single-privilege calls). *Narrowed 2026-11-10 (pre-ship fix, code-reviewer Should-fix):* `anon` INSERT/UPDATE/DELETE are business policy, not this spec's invariant, so they aren't asserted. The message says to check for an intentional tightening first. I picked this table because no migration revokes any table privilege on it (grep of `revoke … on public.` finds only profiles, tombstones and the two audit tables) |
| 8a | AC-6 | Create `__truncate_probe_born` (plain, no grants). Stash the sum of effective TRUNCATE for anon + authenticated plus direct PUBLIC TRUNCATE entries. Drop the table, then `is(stash, 0)` |
| 8b | AC-6 | From the same stash step: `service_role` TRUNCATE is true, so `is(stash, 1)` (or `ok`) |
| 8c | AC-6 | From the same stash step: count of {anon, authenticated, service_role} holding SELECT, so `is(stash, 3)` |
| 9a | AC-7 | Create `__truncate_probe_direct`, then `grant truncate on it to authenticated`. Stash the effective count limited to that oid. Drop, then `is(stash, 1)` (authenticated only) |
| 9b | AC-7 | From the same stash step: direct count limited to that oid, so `is(stash, 1)` |
| 10a | AC-8 | Create `__truncate_probe_public`, then `grant truncate on it to public`. Effective count limited to that oid: **expected 2**, because PUBLIC membership makes both anon and authenticated effective |
| 10b | AC-8 | From the same stash step: direct count: **expected 1**, the grantee-0 entry labelled PUBLIC |
| 11a | AC-9 | `alter default privileges for role postgres in schema public grant truncate on tables to authenticated`. Run the full, unfiltered arm-4 detector and stash. Revert with the matching `… revoke truncate on tables from authenticated`. Then `is(stash, 1)` |
| 11b | Tripwire self-test | `alter default privileges for role postgres grant truncate on tables to authenticated` (no `IN SCHEMA`, so it creates a `defaclnamespace = 0` row). Run the full arm-4 detector and stash. Revert with `alter default privileges for role postgres revoke truncate on tables from authenticated`, which puts the row back to the built-in default, so Postgres deletes it. Then `is(stash, 1)` |

- **House shape.** Self-tests follow spec 053 / 097: mutate, stash the count
  in a `do $$ … set_config … $$` block, drop or revert, then assert. Don't use
  `throws_ok`; nothing here raises. Don't use `savepoint` + `rollback to
  savepoint` either: that would remove assertions from pgTAP's temp-table
  counters and trip `test-db.sh`'s "planned N but ran M" detector. Default-ACL
  changes and GRANTs are transactional, so the outer `rollback;` would undo
  11a/11b anyway. Reverting explicitly before the assertion keeps each arm
  self-contained, and stops 11a's grant from adding to 11b's count.
- **Ordering inside the file matters.** Arms 1-7 run against the untouched
  catalog. Arm 8 must run **before** 11a/11b, so the born table sees the clean
  default ACL. 11a must revert before 11b runs.
- **Before the migration (AC-10), recomputed 2026-11-09 for D-11.** Expected
  red run: **10 of 17 fail**, 7 pass.

  | Arm | Expected before | Why |
  |---|---|---|
  | 1 | 94 (want 0) | 47 tables x {anon, authenticated}; pgTAP views now excluded (the developer's 98 = 94 + 2 views x 2) |
  | 2 | 94 (want 0) | same 94 direct entries; no PUBLIC entries exist |
  | 3 | 94 pairs listed | `public.<t> / anon` and `/ authenticated` for the 47 tables; no `tap_funky` / `pg_all_foreign_keys` |
  | 4 | 2 (want 0) | anon + authenticated `D` in the `(postgres, public, 'r')` row |
  | 8a | 2 (want 0) | born table inherits anon + authenticated `D` |
  | 9a | 2 (want 1) | the explicit grant to authenticated is redundant; anon already has `D` from the default |
  | 9b | 2 (want 1) | same, direct entries |
  | 10b | 3 (want 1) | PUBLIC + inherited anon + authenticated entries |
  | 11a | 2 (want 1) | detector sees the pre-existing anon + authenticated entries; the grant is a no-op |
  | 11b | **2** (want 1) | 11a's revert (`revoke truncate … from authenticated` in schema public) already stripped the pre-existing authenticated `D` inside the transaction, so the detector sees the new global row (authenticated) + the per-schema anon entry = 2, not 3. The earlier "=3" prediction was wrong; the developer's observed 2 is correct |
  | 5, 6a, 6b, 7, 8b, 8c, 10a | pass | 10a passes before too: effective anon + authenticated = 2 regardless |

  **After the migration:** all 17 pass. The developer's in-transaction
  simulation already showed arms 4-11b green and arms 1-3 failing only on the
  two pgTAP views (4 pairs), which D-11 excludes, so arms 1-3 go to 0 / 0 /
  `''`. Record the arm-3 string and the failing arm numbers for both runs in
  the implementation notes.
- **Failure messages** follow the 097 style: say what broke, name this spec and
  migration, and give the fix. For arms 1-3 the fix is to revoke explicitly or
  replace `grant all` with the spec 097 explicit list. For arm 4 it's to revoke
  the default-ACL grant, and for a global entry, to revoke it without
  `IN SCHEMA`.
- **No allowlist.** There's no legitimate client-TRUNCATE exception, so arms
  1-4 assert a flat 0. If one is ever needed, it gets a role-keyed VALUES
  allowlist like 097's, in the same PR.

### D-4 AC refinements (please note: a small deviation from AC-2's wording)

- **AC-2's "still carries `arwdxtm`".** The probe (arm 5) asserts the six
  privileges spec 097 grants (`arwdxt`) as a **subset**, and doesn't pin `m`.
  - `MAINTAIN` comes from the image, not the repo. CI pins CLI 2.106.0
    (`test.yml:173`), whose image is known to change Supabase's implicit
    grants. On that image the `(postgres, public, 'r')` entry may be exactly
    what spec 097 created (`arwdxt`, with no `m`), so pinning `arwdxtm` exactly
    could fail CI for a reason unrelated to this spec.
  - The "only `D` removed" claim is still checked: arm 4 shows `D` is gone,
    arm 5 shows the repo-owned privileges are intact, and the developer pastes
    the local and prod Q-d output (`anon=arwdxtm/postgres`) into the
    implementation notes as human-checked evidence.
  - A future MAINTAIN spec then needs no change to arm 5.
- **CI green doesn't prove the migration works.** On the CI image, client `D`
  may already be missing (see above), so CI could be green with or without the
  migration. The proof is AC-10 (local red, then green) plus the prod Q-a / Q-d
  before-and-after. That's why AC-10 and AC-13/14 are mandatory, not optional.
- **AC-5 (idempotent)** is a manual developer step, not a probe arm. A probe
  that ran the revoke itself would turn green before the migration and break
  AC-10. Steps:
  1. After the migration is applied locally, pipe the migration file a second
     time into `docker exec -i supabase_db_imr-inventory psql -U postgres -d
     postgres -v ON_ERROR_STOP=1 -f -`.
  2. Expect `BEGIN … DO … COMMIT` with no error. The DO block passes on a
     clean state.
  3. Rerun `bash scripts/test-db.sh supabase/tests/public_no_client_truncate.test.sql`.
  4. Record both outputs.

### D-5 Comment-only edits to `supabase/tests/public_grants_explicit.test.sql` (decided: do them)

The probe that guards the posture shouldn't carry a false security claim in its
header. Make **comment-only** changes, with no change to any assertion, plan
count, message string or allowlist:
- **Lines 138-147 (SUBTLETY) and 269-270 (arm 3 comment).** Replace "born WITH
  the (no-TRUNCATE) grant" with wording that says a postgres-owned table is born
  without client TRUNCATE **since spec 197's `20261109230000`**, and that before
  that the image's default ACL still carried `D`.
- **Header (around lines 32-41 / 113-ish) and arm 5 comment (364-374).** Add
  one cross-reference line: "Schema-wide client-TRUNCATE and default-ACL checks
  live in `public_no_client_truncate.test.sql` (spec 197)."
- Put a reciprocal cross-reference in the new file's header.
- The arm *message strings* (for example 5a's "must use the explicit
  no-TRUNCATE privilege list") stay exactly as they are. They're still correct.

**Noticed, not changed** (migrations can't be edited). These comments become
true once this spec applies:
- `20260618000000_public_grants_explicit.sql` lines 62, 75, 185;
- `20260703000000_user_count_drafts.sql:104-113`;
- `20261109140000_po_number_sequence.sql` around line 186, and spec 190 D-11 #4.

The similar "no-TRUNCATE list" comments in `20260630000000_item_vendors.sql`,
`20260630000500_user_count_orders.sql` and `20260706000000_store_count_layouts.sql`
describe the **granted list**, which was always accurate. Nothing to correct
there.

### D-6 RLS, API, edge functions, `db.ts`, realtime, store

- **RLS impact: none.** No policy is added, dropped or changed. Privileges are
  the outer gate and RLS the inner one. TRUNCATE doesn't go through RLS (or
  row triggers) at all, which is exactly why the privilege is the only control
  that matters. `auth_can_see_store()` and `auth_is_admin()` are untouched.
  `permissive_policy_lint` is unaffected.
- **API contract: none.** No table, view or RPC. PostgREST has no TRUNCATE verb.
  Its schema cache doesn't depend on TRUNCATE, so no `notify pgrst` is needed.
- **Edge functions: none.** No `verify_jwt` change. Service-role functions keep
  TRUNCATE and none of them use it.
- **`src/lib/db.ts`: no new helper.** No snake/camel mapping.
- **Realtime: none.** No `supabase_realtime` publication change, so **no
  `docker restart supabase_realtime_imr-inventory` step**, locally or on deploy.
  Neither the `store-{id}` nor the `brand-{id}` channel is affected.
- **Frontend store: none.** `src/store/useStore.ts` is unchanged, and the
  optimistic-then-revert pattern doesn't apply.
- **Track 1 (jest) / typecheck.** No-regression run only (AC-11), the full
  suite.

### D-7 Prod apply plan (item 6), only with the owner's explicit go-ahead

Project `ebwnovzzkwhsdxkpyjka`, through Supabase MCP `execute_sql`. **Don't use
MCP `apply_migration`**: it writes its own generated version, and the drift gate
goes red. Apply **before** pushing (AC-12). Per open question Q1 (default:
separate), this is its own session. If the owner bundles it with spec 190
anyway, each migration gets its own `execute_sql` call and its own insert, in
either order, because they don't depend on each other.

**P0, read-only pre-checks (save every output into the implementation notes):**
1. **P0.1 identity:** `select current_user, r.rolsuper, pg_has_role(current_user, 'postgres', 'USAGE') as acts_as_postgres from pg_roles r where r.rolname = current_user;`
   Expect `postgres` (or `acts_as_postgres = true`). Otherwise STOP: `ALTER
   DEFAULT PRIVILEGES FOR ROLE postgres` would fail.
2. **P0.2 version slot:** `select version, name from supabase_migrations.schema_migrations where version >= '20261109000000' order by 1;`
   `20261109230000` must be absent.
3. **P0.3 inventory and owners:** `select c.relkind, pg_get_userbyid(c.relowner) as owner, count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') group by 1, 2 order by 1, 2;`
   Expect owner `postgres` only (56+ `r`, other relkinds 0 or a few). Any other
   owner on relkind `r`/`p`/`f`: STOP. The fail-closed block would roll back if
   that relation holds client `D`. A non-`postgres` owner on `v`/`m` (for
   example pgTAP's views, see P0.6): record it and continue; D-11 excludes
   those kinds from the DO block, and the migration's revoke only warns on
   them.
4. **P0.4 global default ACL:** `select count(*) from pg_default_acl where defaclrole = 'postgres'::regrole and defaclnamespace = 0 and defaclobjtype = 'r';`
   Expect 0. If not 0 and it grants `D` to a client role, STOP: this design
   doesn't cover it.
5. **Q-a, Q-b, Q-c, Q-d, Q-e, final SQL** (pre-ship fix M-2, 2026-11-10;
   supersedes the PM's queries above). Run each as written; all are read-only.
   Q-a and Q-b use the D-11 relkind set `('r','p','f')`, the same literal set
   as probe arms 1-3 and the migration's DO block (a). Q-c uses `('r','p')`.
   Smoke-tested locally (post-apply) on 2026-11-10; see "Pre-ship fixes".

   ```sql
   -- Q-a: direct client TRUNCATE entries (pre: 2 per table that has them; post: 0 rows)
   select c.relkind, format('%I.%I', n.nspname, c.relname) as relation,
          case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'f')
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
   order by 2, 3;

   -- Q-b: effective client TRUNCATE, incl. PUBLIC and membership (post: 0)
   select count(*) as client_truncate_pairs
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('anon'), ('authenticated')) v(role)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'f')
     and has_table_privilege(v.role, c.oid, 'TRUNCATE');

   -- Q-c: service_role keeps TRUNCATE (expect service_role_truncate = total_tables)
   select count(*) filter (where has_table_privilege('service_role', c.oid, 'TRUNCATE')) as service_role_truncate,
          count(*) as total_tables
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p');

   -- Q-d: table default ACLs (unchanged from the PM's query)
   select pg_get_userbyid(defaclrole) as role,
          coalesce(defaclnamespace::regnamespace::text, '<global>') as schema,
          defaclacl
   from pg_default_acl
   where defaclobjtype = 'r'
   order by 1, 2;

   -- Q-e (informational, not an AC): client TRUNCATE on views/matviews
   select c.relkind, format('%I.%I', n.nspname, c.relname) as relation,
          pg_get_userbyid(c.relowner) as owner,
          case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('v', 'm')
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
   order by 2, 4;
   ```

   - Q-e: expect 0 rows. Record any rows. After the apply, `postgres`-owned
     ones should be gone, and any `supabase_admin`-owned ones belong to the
     accepted leftover.
   - Expected pre-state: Q-a 104 rows (52 × 2), Q-b 104, Q-c n/n, and Q-d
     `postgres/public` with `anon=arwdDxtm` and `authenticated=arwdDxtm`.
6. **P0.5 rollback generator** (pre-ship fix M-1 + L-3, 2026-11-10). It only
   reads and emits text. Paste its output into the notes verbatim; it is the
   only restore record.

   ```sql
   select string_agg(
            format('grant truncate on %I.%I to %s;',
                   n.nspname, c.relname,
                   case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end),
            E'\n' order by n.nspname, c.relname, a.grantee) as rollback_sql
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relowner = 'postgres'::regrole::oid
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);
   ```

   - Names are schema-qualified through `%I.%I`, so the output doesn't
     depend on `search_path` when it's pasted into a future
     `_restore_client_truncate.sql`.
   - The `relowner = postgres` filter limits the output to exactly what the
     migration's revoke can change.
   - The wide relkind set is deliberate: this is a restore record, not a
     check, and the migration also revokes `D` on a `postgres`-owned view.
   - The output can't contain `profiles`, `inventory_item_tombstones` or the
     two audit tables, because they hold no client `D`.
   - Post-apply it returns NULL (one empty row).
7. **P0.6 pgTAP presence (D-11):**
   `select extname, extnamespace::regnamespace, pg_get_userbyid(extowner) from pg_extension where extname = 'pgtap';`
   Expected 0 rows (no migration installs it; `tests/README.md` says it's
   kept out of prod). This is **unverified** as of 2026-11-09. Not a STOP
   either way: if a row exists with namespace `public`, its views show up in
   P0.3 / Q-e and are recorded as part of the `supabase_admin` leftover. Paste
   the output into the notes.

**P1, apply.** One `execute_sql` call. The text is the migration file
**verbatim**, with this one line added just before its final `commit;`, so the
body and its version row commit or roll back together (spec 190 M-3 runbook
shape):

```
insert into supabase_migrations.schema_migrations (version, name) values ('20261109230000', 'revoke_client_truncate');
```

- Column set `(version, name)`, with `statements` left NULL. That's the
  dominant house shape (specs 164, 170, 172, 180, 186, 191, 194, 195). Spec 186
  notes it matches the spec 178 row. Spec 190's `(version, name, statements …
  '{}')` is an outlier. The gate reads only `version`, so either works, but
  stay with the majority.
- If the DO block raises (`197: …`), nothing is applied or recorded. STOP and
  report.

**P2, post-checks (read-only; paste the outputs for AC-13, AC-14 and AC-15):**
- Q-a: 0 rows. Q-b: 0. Q-c: filter count = total for `('r','p')`.
- Q-d:
  - `postgres/public`: `anon=arwdxtm/postgres`, `authenticated=arwdxtm/postgres`;
  - `service_role` unchanged (keeps `D`);
  - the `supabase_admin` entry **byte-identical** to the pre-check. Record it
    as the accepted leftover.
- `select version, name from supabase_migrations.schema_migrations where version = '20261109230000';`
  returns one row.
- Spot check, all expected true:
  `select has_table_privilege('authenticated','public.profiles','SELECT'), has_table_privilege('authenticated','public.inventory_items','INSERT'), has_table_privilege('service_role','public.profiles','TRUNCATE');`

**P3.** Push (only after owner approval), then check both gates on `main`
(AC-12, CLAUDE.md "CI status check after every push to main").

### D-8 Rollback (refines the PM's section)

- **Repo-forward rollback** (preferred) is a new migration
  `<later-ts>_restore_client_truncate.sql` containing:
  1. the **P0.5 captured statements, verbatim**: per-(table, grantee), never
     `on all tables` (that would reopen spec 041's `profiles` escalation and
     unlock the tombstone and audit tables);
  2. `alter default privileges for role postgres in schema public grant truncate on tables to anon, authenticated;`
  3. in the same change, delete `public_no_client_truncate.test.sql` or flip it
     to match, plus revert the D-5 comment edits;
  4. its own prod apply with its own exact-version insert.
- **Before push only** (prod applied, repo not pushed): run the P0.5
  statements and the default-ACL re-grant through `execute_sql`, then
  `delete from supabase_migrations.schema_migrations where version = '20261109230000';`
  and revert the repo files. This matches spec 191's "not yet pushed" rollback
  shape.
- A hand-applied rollback with no migration file is drift that the gate
  **doesn't** detect, because there's no version row to compare. Don't leave
  it that way.

### D-9 Files the build is expected to touch

- `supabase/migrations/20261109230000_revoke_client_truncate.sql`: new.
- `supabase/tests/public_no_client_truncate.test.sql`: new, `plan(17)`.
- `supabase/tests/public_grants_explicit.test.sql`: comments only (D-5).
- This spec: implementation notes (AC-5 and AC-10 runs, local Q-d) and
  `## Files changed`.
- Locally, record the migration in local `schema_migrations`. Either run
  `npx supabase migration up`, which records it automatically, or apply it with
  psql and run the same `(version, name)` insert. Do the AC-10 red run
  **before** this.

### D-10 Risks and tradeoffs

1. **Migration ordering.** Covered by D-1: `ON ALL TABLES` handles earlier
   tables and the default ACL handles later ones. The only risk is a version
   collision with a parallel session. Mitigation: the build-time `ls`
   re-check, and 230000 leaves headroom.
2. **Prod non-postgres-owned relation.** The REVOKE would quietly skip it.
   Mitigation: the P0.3 pre-check plus the fail-closed DO block (atomic with
   the version insert).
3. **The `supabase_admin` default ACL still grants `D`.** Accepted (Q3
   default). The backstops are probe arms 1-3 on every CI run and the prod Q-a
   check, both for relkind `r`/`p`/`f` (D-11). The pgTAP harness itself
   exercises this leftover on every run (two views), which is how the original
   relkind set was found to be unworkable. A Supabase platform upgrade that runs `grant all on all tables in
   schema public to anon, authenticated` as `supabase_admin` would also bring
   `D` back on prod without CI noticing, because CI runs on a fresh image.
   Re-running Q-a after a platform upgrade is cheap. That's for the owner
   under Q3; it isn't required here.
4. **CI may be green whether or not the fix works** (D-4). AC-10 and the prod
   checks carry the proof.
5. **Inert view/matview `D` is not checked** (amended, D-11). A future
   `grant all on <view> to authenticated` would carry an inert `D` and CI
   won't notice. Accepted: it grants nothing, and the alternative (scanning
   views) is permanently red in the pgTAP harness.
6. **Not pinning `m` in arm 5.** This trades exactness for CI-image
   robustness (D-4). The human-checked Q-d output covers the gap.
7. **Performance:** negligible. A catalog scan of about 56 relations,
   independent of the 286 KB seed data. GRANT/REVOKE only update the catalog
   (`pg_class.relacl` and `pg_default_acl`). No table is rewritten or scanned,
   so the apply should finish in milliseconds even on live prod. If a long
   transaction holds a conflicting catalog lock, the apply waits; it doesn't
   fail.
8. **Edge-function cold start:** not applicable.
9. **Residual not addressed:** MAINTAIN (`m`). It's still granted to clients
   on prod. It allows `LOCK TABLE`, `VACUUM`, `REINDEX` and so on, which is a
   denial-of-service vector more than a data-loss one. That's open question Q2's
   follow-up.

### D-11 Amendment (2026-11-09): pgTAP harness views, relkind narrowed

Resolves the developer's "BLOCKED" notes below. **Decision: option B, refined
to `relkind in ('r','p','f')`**, with no extension-dependency exclusion and no
name allowlist. Edits made in place: the AC preamble and AC-10, the superseded
design-constraint bullet, Residual risk, D-0, D-1 (DO-block comment), D-3
(relkind paragraph and red-run table), D-7 (P0.3, Q-a/Q-b, Q-e, P0.5, P0.6)
and D-10 #3/#5.

**Why B.**
- TRUNCATE on a view or matview fails with "is not a table" regardless of
  ACL, so a `D` there grants nothing. Excluding them loses no security signal.
- `('r','p','f')` still flags a future extension- or `supabase_admin`-created
  **real** table with client TRUNCATE, which is a genuine exposure. Option A
  (exclude `pg_depend deptype = 'e'`) would hide exactly that.
- Option C (allowlist `tap_funky`, `pg_all_foreign_keys`) breaks on any pgTAP
  version that adds or renames a view.
- It also removes the "CI unknown" the developer raised: whatever the CI
  image's `supabase_admin` default ACL, pgTAP only creates views (its
  `__tcache__` / `__tresults__` bookkeeping tables are TEMP, in `pg_temp_N`,
  not `public`), so arms 1-3 can't be tripped by the harness. This is
  confirmed empirically: the developer's post-migration simulation ran after
  `plan()` with the wide relkind set and listed only the two views.

**Refinement over the dispatch's `('r','p')`: keep `'f'`.** The premise "TRUNCATE
on a foreign table is rejected regardless of ACL" is not true since PG14:
`TRUNCATE` dispatches to the FDW's `ExecForeignTruncate`, and `postgres_fdw`
implements it (option `truncatable`, default true). So `D` on a foreign table
is live. There are none in `public` today and pgTAP creates none, so including
`'f'` costs nothing.

**Probe changes (`public_no_client_truncate.test.sql`, still `plan(17)`).**
- Arms 1, 2 and 3: `c.relkind in ('r','p','f')`. Nothing else changes in
  them.
- Arms 6a/6b stay `('r','p')`. Arms 4, 5, 7-11b don't scan `pg_class` by
  relkind (they're default-ACL or single-oid checks), so they're unchanged.
- Header: one line stating the relkind set, why views/matviews are excluded
  (inert `D`; pgTAP's `supabase_admin`-owned views), and that the set must
  match the migration's DO block (a) literally.
- Failure messages for arms 1-3: no change needed beyond the scope note.

**Migration `20261109230000_revoke_client_truncate.sql`: needs a change**
(developer to make it; the file is unapplied and unrecorded, so editing it is
fine).
- Line 90: `c.relkind in ('r', 'p', 'v', 'm', 'f')` -> `c.relkind in ('r',
  'p', 'f')`. Without this the DO block and probe diverge, and the migration
  raises `197: client TRUNCATE still granted on public.pg_all_foreign_keys …`
  in any DB where pgTAP is installed persistently in `public` (locally after
  the `tests/README.md` autocommit sanity command; on prod if P0.6 finds it).
  That would be a false fail-closed abort: those views' `D` is inert, and a
  `postgres` migration can't revoke it anyway.
- Header lines 39-43 ("raises … if any direct client TRUNCATE entry remains"):
  add that the check covers the truncatable kinds `r`/`p`/`f` only, and that
  the revoke on line 68 still covers every kind. Lines 20-22 (what the revoke
  covers) stay accurate.
- Line 68 (`revoke … on all tables`) and lines 70-71 (default ACL) are
  unchanged. Section (b) of the DO block is unchanged.
- No version change: `20261109230000` is still free (the developer's
  pre-state shows `20261109200000` as the latest on disk). Re-run the D-1
  `ls` check before restoring the probe.

**Build sequence after this amendment.**
1. Restore the parked probe from
   `/private/tmp/claude-501/-Users-will-Documents-GitHub-INVENTORY-MANAGEMENT/6111afef-1134-4fc6-8a30-2b256a9ff06d/scratchpad/parked/public_no_client_truncate.test.sql`
   into `supabase/tests/` and apply the arm 1-3 relkind change.
2. Edit the migration's DO block and header as above.
3. AC-10 red run (expect the D-3 table: 10 fail, arm 1/2 = 94, arm 11b = 2).
4. Apply locally and record in `schema_migrations`, AC-10 green run (17/17),
   AC-5 second apply, D-5 comment edits, full `scripts/test-db.sh`, full
   `npx jest`, `npm run typecheck:test`.

## Handoff (superseded)

*Superseded: the build resumed and finished. The current handoff is at the end of
this spec.*

next_agent: backend-developer
prompt: Resume the build against the amended design, starting with D-11 (the
  relkind set becomes ('r','p','f') in probe arms 1-3 AND in the migration's
  DO block (a), line 90, plus the header note). Restore the parked probe into
  supabase/tests/, re-check `ls supabase/migrations`, run the AC-10 red run
  BEFORE applying (expect the D-3 table: 10 fail, arms 1/2 = 94, 11b = 2),
  then apply locally and record it, get 17/17 green, do AC-5's second apply and
  the D-5 comment edits, then run full `scripts/test-db.sh`, full `npx jest` and
  `npm run typecheck:test`. Do not touch prod and do not commit. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/197-revoke-client-truncate.md

## Implementation notes (backend-developer, 2026-11-09): BLOCKED on a design flaw (RESOLVED by D-11, see "Build after D-11" below)

Status stays `READY_FOR_BUILD`. The build stopped before the local apply
because D-3 arms 1-3 can never pass in the pgTAP harness, with or without
the migration. Nothing was applied to the local DB, and no
`schema_migrations` row was written.

### Pre-state (local, read-only)

- Latest migration on disk: `20261109200000_po_number_server_assigned.sql`
  (spec 196). `20261109230000` is still free, so the slot is unchanged.
- 51 `public` relations, all relkind `r`, all owned by `postgres`.
  anon 47 / authenticated 47 with effective TRUNCATE.
- Local `postgres` is `rolsuper = f`.
- Q-d (`postgres`/`public`/`r`):
  `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`.
  There is no global (`defaclnamespace = 0`) `postgres` row.
  `supabase_admin`/`public`:
  `{postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin}`.

### The flaw

Every test file runs `create extension if not exists pgtap;` inside its own
transaction. pgTAP is not installed in the DB itself. Supautils creates it
as **`supabase_admin`** in schema **`public`**, and that adds two views:

```
 tap_funky           | v | supabase_admin | {supabase_admin=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin,=r/supabase_admin}
 pg_all_foreign_keys | v | supabase_admin | (same ACL)
```

Both views fall in the D-3 relkind set `('r','p','v','m','f')`. They take
their ACL from the `supabase_admin` default ACL, the "accepted leftover",
so they carry client `D`. The design says this "needs a Supabase-internal
action" (Residual risk) and that `public` has no views (D-0). Both are wrong
inside the test harness: every probe run creates two `supabase_admin`-owned
views with client `D`. This migration can't remove that `D`, because the
views don't exist when it runs, and prod's `postgres` can't change the
`supabase_admin` default ACL.

### Evidence

**AC-10 red run (probe alone, before the migration):** 10 of 17 failed.
- Arms 1 and 2 = **98**, not the predicted 94: 47 tables x 2 plus 2 pgTAP
  views x 2.
- Arm 3 lists 98 pairs, including `public.pg_all_foreign_keys` and
  `public.tap_funky`.
- Arm 4 = 2. 8a = 2. 9a = 2. 9b = 2. 10b = 3. 11a = 2. **11b = 2**: the
  design predicted 3, but 11a's revoke had already removed the pre-existing
  authenticated `D` inside the transaction. This only affects the red-run
  prediction.
- Arms 5, 6a, 6b, 7, 8b, 8c and 10a passed.

**Post-migration simulation:** the migration body and the probe ran in one
transaction, then rolled back. Nothing persisted, and the Q-d `D` was still
present afterwards. 14 of 17 passed. Arms 1-3 still fail:
```
arm 1 have: 4   arm 2 have: 4
arm 3 have: public.pg_all_foreign_keys / anon, public.pg_all_foreign_keys / authenticated, public.tap_funky / anon, public.tap_funky / authenticated
```
Arms 4-11b are all green, so the migration does what it should for
`postgres`-owned objects. The migration's own DO block passes, because it
runs outside the harness where these views don't exist.

**CI is unknown.** It depends on whether the CI image's (CLI 2.106.0)
`supabase_admin`/`public` default ACL grants clients `D`. Spec 097 says that
image removed the implicit grants. Locally, arms 1-3 are red for good, so
AC-10's "green after" and AC-11 can't be met.

### Options for the architect (not chosen by the developer)

- **A. Exclude extension members from arms 1-3:**
  `and not exists (select 1 from pg_depend dep where dep.classid = 'pg_class'::regclass and dep.objid = c.oid and dep.deptype = 'e')`.
  This is version-independent. The cost: a future extension that puts a
  table with client `D` in `public` would go unflagged.
- **B. Narrow arms 1-3 to relkind `('r','p')`.** View and matview `D` is
  inert at execution anyway. This drops the D-3 / D-10 #5 strictness on
  views. The migration's `ON ALL TABLES` revoke stays as it is.
- **C. Role-keyed allowlist of the two pgTAP views** (the D-3 escape hatch).
  It depends on pgTAP's object names.
- A and B can be combined. Revoking from inside the probe won't work: as
  `postgres`, the views are owned by `supabase_admin` and `postgres` holds no
  grant option, so the revoke only warns.
- Whichever option is chosen, the Residual-risk / D-0 text should say that
  the pgTAP harness itself creates `supabase_admin`-owned relations in
  `public`.

### State of the build

- `supabase/migrations/20261109230000_revoke_client_truncate.sql`: written
  per D-1, **not applied** locally, not recorded in `schema_migrations`.
- `supabase/tests/public_no_client_truncate.test.sql`: written per D-3
  (plan 17), then **moved out of `supabase/tests/`** so that other sessions'
  full `scripts/test-db.sh` runs don't go red. Parked at
  `/private/tmp/claude-501/-Users-will-Documents-GitHub-INVENTORY-MANAGEMENT/6111afef-1134-4fc6-8a30-2b256a9ff06d/scratchpad/parked/public_no_client_truncate.test.sql`.
  Restore it once the design is amended.
- D-5 comment edits to `public_grants_explicit.test.sql`: not started. They
  are held until the design is settled.
- Not run yet: the AC-5 second apply, full `scripts/test-db.sh`, full
  `npx jest` and `npm run typecheck:test`.

### Architect resolution (2026-11-09)

Unblocked by **D-11** in "Backend design": option B, with the relkind set
`('r','p','f')` (foreign tables kept, since PG14+ can TRUNCATE them), used in
probe arms 1-3 and the migration's DO block (a). The red-run predictions in
D-3 are recomputed, and confirm the developer's observed 11b = 2. Status stays
`READY_FOR_BUILD`.

## Build after D-11 (backend-developer, 2026-11-09)

The block above is resolved. Probe arms 1-3 and the migration's DO block (a)
now use `relkind in ('r', 'p', 'f')`. Arms 6a/6b stay `('r', 'p')`. The plan is
still 17. The migration header has the D-11 note, and the D-5 comment edits are
done. Everything below ran against the shared local DB; nothing touched prod.

### Pre-apply checks

- `ls supabase/migrations | tail -3`: `…195000_user_stores_drop_own_row_writes`,
  `…200000_po_number_server_assigned`, `…230000_revoke_client_truncate`.
  The highest local `schema_migrations` row before the apply was
  `20261109200000`. The `230000` slot is unchanged.

### AC-10 red run (probe restored, migration not yet applied)

`bash scripts/test-db.sh supabase/tests/public_no_client_truncate.test.sql`
exited 1 with `# Looks like you failed 10 tests of 17`. This matches the D-3
table exactly.

| Arm | Result |
|---|---|
| 1 | fail, have 94 |
| 2 | fail, have 94 |
| 3 | fail, 94 pairs listed (47 `/ anon` + 47 `/ authenticated`) |
| 4 | fail, have 2 |
| 8a | fail, have 2 |
| 9a | fail, have 2 |
| 9b | fail, have 2 |
| 10b | fail, have 3 |
| 11a | fail, have 2 |
| 11b | fail, have 2 |
| 5, 6a, 6b, 7, 8b, 8c, 10a | pass |

- `tap_funky` and `pg_all_foreign_keys` don't appear anywhere in the output.
- Arm-3 tables, each listed once per role: _edge_auth audit_log
  brand_deletion_log brands catalog_ingredients eod_entries eod_reminder_log
  eod_submissions flags in_app_notifications ingredient_categories
  ingredient_conversions inventory_count_entries inventory_counts
  inventory_items invitations item_vendors notification_reads notifications
  order_approvals order_schedule po_items pos_import_items pos_imports
  pos_recipe_aliases prep_recipe_ingredients prep_recipes purchase_orders
  push_subscriptions recipe_categories recipe_ingredients recipe_prep_items
  recipes report_definitions report_runs staff_reports store_count_layouts
  stores user_count_drafts user_count_orders user_stores
  username_resolve_rate_limit vendor_order_attempts vendor_reminder_log
  vendors waste_log weekly_reminder_log (47).
- Absent, as expected: profiles, inventory_item_tombstones,
  spec093_case_qty_backfill_audit, spec104_per_each_cost_audit.

### Local apply and AC-5 (idempotent)

Apply 1:
`docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f - < supabase/migrations/20261109230000_revoke_client_truncate.sql`
returned `BEGIN / REVOKE / ALTER DEFAULT PRIVILEGES / DO / COMMIT`, exit 0.

Recorded locally in the dominant local shape, `(version, name)` with
`statements` NULL:
`insert into supabase_migrations.schema_migrations (version, name) values ('20261109230000', 'revoke_client_truncate');`
returned `INSERT 0 1`.

Apply 2 (AC-5): the same command returned
`BEGIN / REVOKE / ALTER DEFAULT PRIVILEGES / DO / COMMIT`, exit 0, with no
error or warning.

### AC-10 green run (after both applies)

`public_no_client_truncate.test.sql`: PASS, 17 assertion(s) passed.

### Local post-apply catalog evidence (AC-1, AC-2, AC-3)

- Q-a (relkind `r`/`p`/`f`): 0 rows.
- Q-b: 0.
- Q-c (`r`/`p`): service_role 51/51, postgres 51/51.
- Spot check: `authenticated` SELECT on profiles = t, `authenticated` INSERT
  on inventory_items = t, `service_role` TRUNCATE on profiles = t.
- `schema_migrations` has 1 row for `20261109230000 | revoke_client_truncate`.

Q-d (restricted to `public` and global), post-apply:
```
 postgres       | public | {postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}
 supabase_admin | public | {postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin}
```

- `postgres`/`public` lost `D` for anon and authenticated
  (`arwdDxtm` -> `arwdxtm`). service_role and postgres keep `D`.
- `supabase_admin`/`public` is byte-identical to the pre-state (the accepted
  leftover).
- There is still no global `postgres` row.

### AC-11 full suites

- `bash scripts/test-db.sh`: exit 0, `104/104 DB test file(s) passed`.
  - `public_grants_explicit.test.sql`: 13 passed.
  - `public_no_client_truncate.test.sql`: 17 passed.
- `npx jest`: exit 0. Test Suites: 301 passed / 301. Tests: 3836 passed /
  3836. Snapshots: 17 passed.
- `npm run typecheck:test`: exit 0, no output.
- No unrelated failures.

### D-5 check

`git diff -U0 supabase/tests/public_grants_explicit.test.sql` shows only `--`
comment lines changed (14 insertions, 4 deletions). No assertion, plan count,
message string or allowlist changed.

### Not done (by design)

- AC-12 to AC-15 (prod apply, CI gates after push): these need the owner's
  go-ahead, per D-7.
- No commit was made.
- The parked copy in the session scratchpad is now stale and unused. The
  copy in `supabase/tests/` is the one that counts.

## Pre-ship fixes (backend-developer, 2026-11-10)

These are the "Fix before ship" items from
`specs/197-revoke-client-truncate/reviews/release-proposal.md`, approved by
the owner. Nothing touched prod. The local apply was not redone; all the
edits below are comments, test files or spec text.

1. **M-1 + L-3 (D-7 P0.5).** The rollback generator is rewritten as a code
   block.
   - It emits `format('grant truncate on %I.%I to %s;', n.nspname, c.relname, …)`.
   - `and c.relowner = 'postgres'::regrole::oid` is now in the SQL itself.
   - Locally post-apply it returns NULL, as expected.
   - Self-test: a throwaway table `public."__P05 probe"` was granted to
     `anon, public` in a rolled-back transaction. The generator emitted
     `grant truncate on public."__P05 probe" to public;` and
     `grant truncate on public."__P05 probe" to anon;`. The schema is
     qualified and the quoting is correct.
2. **M-2 (D-7 step 5).** Q-a, Q-b, Q-c, Q-d and Q-e are written out in
   full. Q-a and Q-b use `('r','p','f')`, Q-c `('r','p')`, Q-e `('v','m')`.
   I extracted the fenced blocks straight from the spec and ran them on the
   local DB in a `begin transaction read only; … rollback;` transaction, and
   all six parsed:
   - Q-a: 0 rows.
   - Q-b: 0.
   - Q-c: 51 / 51.
   - Q-d: `postgres/public` = `anon=arwdxtm`, `authenticated=arwdxtm`.
   - Q-e: 0 rows.
   - P0.5: NULL.
3. **M-4.** The first `## Handoff` block is retitled
   `## Handoff (superseded)`, with a pointer to the current one.
4. **Migration header wording.** The coordinator made this edit ("spec 064
   drift gate"). I didn't touch it again.
5. **Test and comment edits.**
   - Probe arm 7 is narrowed to: `anon` keeps SELECT, and `authenticated`
     keeps SELECT/INSERT/UPDATE/DELETE on `public.inventory_items` (5 ANDed
     calls). The new message tells the reader to check for an intentional
     later tightening first. I updated the D-3 arm 7 row to match. Still
     `plan(17)`, with 17 assertion calls.
   - Reflowed the long SUBTLETY comment line in
     `public_grants_explicit.test.sql`.
   - Replaced the hard-coded "47 of 51 / 52 of 56" in the probe header with
     "most public tables".
   - Added "keep IDENTICAL to arm (4)" comments above the arm 11a and 11b
     detectors, and above the migration's DO block (b). The migration diff is
     comment-only, with no statement changed.
   - `git diff HEAD` of `public_grants_explicit.test.sql` still shows only
     `--` lines changed (+17/-6).

**Re-verification**
- `bash scripts/test-db.sh supabase/tests/public_no_client_truncate.test.sql`:
  PASS, 17 assertion(s).
- `bash scripts/test-db.sh`: exit 0, `104/104 DB test file(s) passed`.
  `public_grants_explicit` passes 13 and `public_no_client_truncate` passes 17.
- `npm run typecheck:test`: exit 0.
- I didn't re-run jest, because only SQL and markdown files changed.

**Still open (owner-gated):** the step-0 check of the `main` CI gates, then
the prod apply and push (AC-12 to AC-15).

## Files changed

**Migrations**
- `supabase/migrations/20261109230000_revoke_client_truncate.sql`: new
  (D-1 + D-11). Applied locally and recorded in local `schema_migrations`.
  Not applied to prod.

**pgTAP tests (Track 2)**
- `supabase/tests/public_no_client_truncate.test.sql`: new (D-3 + D-11),
  `plan(17)`. Pre-ship: arm 7 narrowed, header counts dropped, and
  keep-identical comments added.
- `supabase/tests/public_grants_explicit.test.sql`: comment-only edits (D-5):
  two cross-references to the new file, and the "born without client
  TRUNCATE since spec 197" wording in the SUBTLETY block and the arm 3
  comment.

**Spec**
- `specs/197-revoke-client-truncate.md`: Status, implementation notes, this
  list.

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer, backend-architect
prompt: Review the implementation of this spec. Each reviewer writes its
  findings to specs/197-revoke-client-truncate/reviews/<your-name>.md. The
  backend-architect runs in post-impl drift-review mode.
payload_paths:
  - specs/197-revoke-client-truncate.md
  - supabase/migrations/20261109230000_revoke_client_truncate.sql
  - supabase/tests/public_no_client_truncate.test.sql
  - supabase/tests/public_grants_explicit.test.sql

## Prod apply (main Claude, 2026-11-10; owner go-ahead "Yes, apply to prod")

Project `ebwnovzzkwhsdxkpyjka`, via Supabase MCP `execute_sql` (not `apply_migration`). Before applying, both gates on `main` were green at `97f0f17`: test.yml run 42942893124, db-migrations-applied.yml run 42942893074.

**P0 pre-checks (read-only):**
- P0.1: `current_user = postgres`, `rolsuper = false`, `acts_as_postgres = true`.
- P0.2: versions >= 20261109000000 were 20261109120000, 140000, 170000, 200000 (`po_number_server_assigned`). The 230000 slot was free.
- P0.3: 56 `r` relations, all owned by `postgres`. No `p`, `v`, `m` or `f` relations.
- P0.4: 0 global `postgres` table default-ACL rows.
- P0.6: pgTAP is not installed on prod (0 rows). That settles the "unverified" note in D-11.
- Q-a: 104 rows (anon 52, authenticated 52). Q-b: 104. Q-c: 56/56. Q-e: 0.
- Q-d `postgres/public`: `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`.
- Q-d `supabase_admin/public`: `{postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin}`.
- Q-d also shows that `postgres/storage` still carries client `D`. That is security-auditor L-1, a follow-up and not in scope here.
- P0.5 rollback record: 104 `grant truncate on public.<table> to anon|authenticated;` statements covering 52 tables. None of them touch `profiles`, `inventory_item_tombstones` or the two audit tables. Saved outside the repo in the session notes as `spec197-prod-p05-rollback-grants.sql`. Its md5 equals prod's `md5(string_agg(...))` of the generator output: `fd1fb2c28c514c0f061e7e8341f58135`, n = 104. The table list is the 56 prod tables minus `profiles`, `inventory_item_tombstones`, `spec093_case_qty_backfill_audit` and `spec104_per_each_cost_audit`. A D-8 restore migration can be rebuilt from that list.

**P1 apply:** one `execute_sql` call with the migration file verbatim. The only addition was `insert into supabase_migrations.schema_migrations (version, name) values ('20261109230000', 'revoke_client_truncate');` just before `commit;`. It returned without error, and the DO block did not raise.

**P2 post-checks (AC-13 / AC-14 / AC-15):**
- Q-a: 0 rows. Q-b: 0. Q-c: service_role 56/56, postgres 56/56. Q-e: 0.
- Q-d `postgres/public`: `{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}`.
- Q-d `supabase_admin/public`: byte-identical to the pre-check (the accepted leftover).
- Version row: `20261109230000 | revoke_client_truncate`.
- Spot check:
  - `authenticated` SELECT on `profiles`: true.
  - `authenticated` INSERT on `inventory_items`: true.
  - `service_role` TRUNCATE on `profiles`: true.
  - `anon` SELECT on `inventory_items`: true.
- `authenticated` still holds DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER and UPDATE on 54 tables each: the 56 tables minus the two audit tables, which stay locked.

**Remaining:** owner-confirmed commit, then push, then confirm both gates on `main` (AC-12).
