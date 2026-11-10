# Spec 190: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode). Date: 2026-11-09.
Scope: `supabase/migrations/20261109140000_po_number_sequence.sql`,
`supabase/tests/generate_po_number_sequence.test.sql`,
`supabase/tests/generate_po_number_malformed_guard.test.sql`, with a quick look at
`supabase/tests/report_run_variance_formula.test.sql` (comment only) and
`scripts/smoke-po-number-concurrency.sh`. Checked against D-1..D-12 and DP-1..DP-6
in `specs/190-po-number-sequence.md`.

**Verdict: no contract drift.** The migration matches the design line for line.
The tests cover every design-pinned assertion. No Critical findings. The two
Should-fix items are about verification: the prod privilege check as written
can miss a PUBLIC grant, and AC-14 (the whole suite passing) has not yet been
shown on a clean database.

## Conformance matrix

| Design item | Implemented | Where |
|---|---|---|
| D-1 SECURITY DEFINER, owner unchanged | Yes. `create or replace` keeps the owner (`postgres`) | migration:151-155 |
| D-1 sequence name / shape (`bigint`, inc 1, min 1, no max, start 1, **cache 1**, no cycle) | Yes | migration:94-101 |
| D-1 `OWNED BY public.purchase_orders.po_number` | Yes | migration:102 |
| D-1 / D-2.3 revoke all on sequence from `public, anon, authenticated` | Yes | migration:105 |
| D-1 / D-2.6 revoke EXECUTE on the formatter | Yes | migration:145 |
| D-1 / D-2.8 revoke EXECUTE on the trigger function | Yes | migration:182 |
| D-1 formatter: pure, IMMUTABLE, STRICT, `search_path=public` | Yes | migration:133-142 |
| D-1 `search_path=public` on both functions (AC-12) | Yes | migration:139, 155 |
| D-2 order: lock, create seq, revoke, seed, formatter, revoke, function, revoke, comments | Yes, exact order | migration:80-194 |
| D-2 `begin; set local lock_timeout = '5s'; … commit;` | Yes | migration:80-82, 194 |
| D-2.1 `share row exclusive` lock before reading max | Yes | migration:88 |
| D-2.2 plain `create sequence` (no `if not exists`) | Yes | migration:94 |
| D-2.4 seed through `::numeric`, `setval(m,true)` / `setval(1,false)` | Yes | migration:113-128 |
| D-2.9 comments (spec 190, "must stay SECURITY DEFINER", TRUNCATE RESTART IDENTITY warning) | Yes, all three objects | migration:185-192 |
| D-2 header (defects, D-4 argument, no realtime restart, prod pointer, rollback) | Yes, and it adds the D-7 argument | migration:1-78 |
| D-3 body: `nextval` by qualified text literal, `exists` probe, bound 100, `54000`, message + hint | Same as the design text, character for character | migration:157-178 |
| D-5 no policy change | Yes | nothing under `create policy` / `alter policy` |
| D-8 no db.ts / store / edge / publication change | Yes | spec "Files changed", confirmed by grep |
| DP-1..DP-5 | Yes (DP-1 three asserts, DP-2 four, DP-3 six, DP-4 six, DP-5 three) | sequence test:104-216 |
| DP-6 last, exact message from `next+99` | Yes, plus two extra asserts for "clears itself" (allowed and useful) | sequence test:500-537 |
| AC-8 first, before fixtures | Yes | sequence test:96-102 |
| AC-7 upward-only lift to 999, real trigger path | Yes | sequence test:385-409 |
| AC-9 explicit `next+500`, state unchanged | Yes | sequence test:412-430 |
| AC-10 RLS-blind skip, `next+1`, sequence +2 | Yes, with an anti-vacuity probe | sequence test:435-467 |
| AC-13 malformed-guard rewrite, plan 8, header rationale, `next+500` fixture | Yes | malformed test:23-40, 53, 95-106 |
| D-6 comment-only cleanup of `report_run_variance_formula` | Yes; `retention_prune_job` correctly left alone (186 not committed) | report test:147-151 |

## Answers to the two specific questions

### Q-A. Is the prod-apply section executable as written?

Yes, with the tightening in S-1 and M-1 to M-3 below. I checked each step:

- **Pre-checks (D-9).** All three are valid read-only SQL that runs as written:
  count/max with the anchored regex cast to `numeric`, owner and `prosecdef`
  through `'public.generate_po_number()'::regprocedure`, and
  `relforcerowsecurity`.
- **Seeding to `last_value 19 / is_called true`.** This is correct. With prod's
  numeric max = 19, the DO block takes the `v_max >= 1` branch, so it runs
  `setval('public.purchase_orders_po_number_seq', 19, true)`, which sets
  `last_value = 19` and `is_called = true`. The next `nextval` is 20, which
  `format_po_number` turns into `PO-020`. The `share row exclusive` lock (taken
  before the `max()`) means a concurrent FILL CART insert cannot land between
  reading the max and the `setval`. The 5s `lock_timeout` means the apply fails
  fast instead of queueing behind a long transaction.
- **Post-check.** `select last_value, is_called from public.purchase_orders_po_number_seq`
  is valid as `postgres` (the owner) and inserts nothing, so it satisfies AC-16.
  `pg_get_serial_sequence` works because of `OWNED BY`. The normalized-md5,
  `proconfig`, `prosecdef` and owner checks are all expressible. The `proacl` and
  `relacl` check needs S-1.
- **Version record.** Use `insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261109140000', 'po_number_sequence', '{}')`.
  That matches how the developer recorded it locally and how 186, 187 and 189
  were recorded.

### Q-B. Is the explicit `begin; … commit;` fine under the CLI and the MCP path?

**Yes on both paths. Use `execute_sql`, not `apply_migration`.**

- **Precedent.** 38 migrations in `supabase/migrations/` use this shape, and so
  do all of 190's neighbours (186, 187, 189, 194). That includes
  `20261023000000_catalog_eod_count_mode.sql` and
  `20261024000000_eod_entries_no_need.sql`, which project memory records as
  applied to prod through MCP `execute_sql`. So both the CLI path (CI's local
  stack boot / `db reset`) and the MCP path have already run this exact pattern.
- **Supabase CLI** (`db reset`, `start`, `migration up`, `db push`). The CLI
  splits the file into statements (the splitter handles the `do $$ … $$` and
  `as $$ … $$` bodies). It sends them as one extended-protocol batch with a
  single trailing Sync, and appends its own `schema_migrations` insert. The
  batch is an implicit transaction. An explicit `BEGIN` turns it into an
  explicit one, and `COMMIT` ends it. The CLI's history insert then runs in its
  own implicit transaction before the Sync.
  - **Consequence:** the migration body and its history row are not atomic.
    - If the body fails, everything rolls back and no history row is written.
      That is correct.
    - If the body commits and the history insert then fails, the body stays
      applied. Only a duplicate version could cause that. A re-run then fails
      loudly on the plain `create sequence`, which D-2.2 intends.
  - `set local lock_timeout` is scoped to the explicit transaction, which is
    exactly what we want.
- **MCP `execute_sql`.** The text runs as one multi-statement simple query, and
  the explicit `begin` / `commit` are honoured. If the endpoint wraps the text in
  its own transaction:
  - the inner `begin` only raises a "transaction already in progress" WARNING;
  - the inner `commit` commits the whole block;
  - the outer commit raises a "no transaction in progress" WARNING.

  Either way the body is applied atomically and `set local` still takes effect.
- **Do not use MCP `apply_migration`** for this file. It writes its own history
  row with a version it generates, not `20261109140000`. That would trip
  `db-migrations-applied.yml`: the repo version would be missing from prod (a
  hard fail), and prod would have an extra version not in the repo (a warning).
  Keep the memory-documented `execute_sql` + manual version insert.

## Findings

### Critical

None.

### Should-fix

**S-1. The prod privilege post-check as worded can miss a PUBLIC grant.**
Spec `## Backend design` D-9 (lines 665-669) and the migration header (lines 65-66)
say to confirm that `proacl` / `relacl` "contains no `anon=` or `authenticated=`
entry". A grant to PUBLIC shows up in the ACL as a bare `=X/postgres` (or
`=rwU/postgres` on the sequence), with no role name. A string check for `anon=` /
`authenticated=` passes it, yet anon and authenticated still inherit the
privilege.

The migration does revoke from `public` (lines 105, 145, 182), and the local ACLs
the developer recorded are clean (`{postgres=…, service_role=…}`). So this is a
gap in the check, not in the code. Prod's default privileges are not guaranteed
to match local, though, and this check is the only prod-side proof of the D-4
posture.

Fix (spec text only, in D-9 and the header pointer): run the same calls DP-2 and
DP-3 make on prod. They account for PUBLIC and role membership:

```
select has_function_privilege('anon','public.generate_po_number()','EXECUTE'),
       has_function_privilege('authenticated','public.generate_po_number()','EXECUTE'),
       has_function_privilege('anon','public.format_po_number(bigint)','EXECUTE'),
       has_function_privilege('authenticated','public.format_po_number(bigint)','EXECUTE'),
       has_sequence_privilege('anon','public.purchase_orders_po_number_seq','USAGE,SELECT,UPDATE'),
       has_sequence_privilege('authenticated','public.purchase_orders_po_number_seq','USAGE,SELECT,UPDATE');
-- expect all false
```

(A comma list in `has_sequence_privilege` returns true if *any* privilege is
held, which is the right test here.)

**S-2. AC-14 ("the whole suite passes") is not demonstrated yet.** The
verification table (spec lines 787-788) shows 98/99 after the migration. The one
failure, `order_approvals_approver_snapshot.test.sql`, is attributed to spec
187's un-reapplied local edit. The developer's isolation argument (it fails the
same way with 190 reverted) is sound, so I do not attribute the failure to 190.
But two things are still unproven:

- the AC-14 gate itself;
- the CLI `ExecBatch` path for this file. The developer applied it with `psql`
  to an existing database, which is not the path CI uses.

Since that run, `20261109170000_kept_records_delete_hardening.sql` (spec 194) has
also landed. It adds BEFORE UPDATE triggers and RESTRICTIVE DELETE policies on
`purchase_orders` / `po_items`. They do not touch the INSERT trigger, but they
did not exist when the suite ran.

Before ship: `npx supabase db reset` (this exercises the CLI path from an empty
table, so the seed branch gives `setval(1,false)`). Then run the full
`scripts/test-db.sh` and record 100% green in the spec. No code change is
expected.

### Minor

**M-1. Add a `current_user` / pre-existence pre-check to D-9.** Add three
read-only queries before step 1:

```
select current_user;                                     -- expect postgres
select to_regclass('public.purchase_orders_po_number_seq'),
       to_regprocedure('public.format_po_number(bigint)'); -- expect null, null
select 1 from supabase_migrations.schema_migrations
 where version = '20261109140000';                      -- expect no row
```

- **Why `current_user`.** If the MCP session ran as a role other than the table
  owner, two things would go wrong:
  - `create sequence … owned by` fails ("sequence must have same owner as table
    it is linked to"). That is loud and rolls back, so it is safe.
  - The formatter would be owned by that other role, and with EXECUTE revoked
    from PUBLIC, the `postgres`-owned definer trigger could not call it.

  The OWNED BY failure would stop the apply before that, but one query up front
  costs nothing.
- **Why pre-existence.** It turns the D-2.2 "re-apply fails loudly" behaviour
  into a check you see before running anything.

**M-2. Make the AC-16 post-check tolerant of live traffic.** "Expect `19, true`"
assumes no PO is created between the pre-check and the post-check. Prod is live
(FILL CART, auto-place), and any such insert legitimately moves `last_value` to
20 or more. Suggested wording:

- Expect `last_value = <pre-check max>` and `is_called = true`.
- If `last_value` is higher, confirm each extra number belongs to a PO created
  after the apply:
  `select po_number, created_at from public.purchase_orders order by created_at desc limit 5`.
- In every case, `last_value + 1` must be greater than the current numeric max
  (that is the AC-8 invariant).

The same goes for the pre-check max. The design already says "if the max has
moved, the expected value moves with it". Note also that spec 186's purge, if it
reaches prod first, deletes by age, so it cannot lower the max in practice.

**M-3. (Optional) Make the prod apply and the version record atomic.** The repo
file ends in `commit;`, so a version insert sent in the same `execute_sql` call
after it runs in a separate transaction. That is the same non-atomicity the CLI
has (Q-B), and it is harmless:

- A missing version row makes the drift gate fail loudly.
- A re-apply fails on the plain `create sequence`.

If the operator wants atomicity, they can paste the `schema_migrations` insert
just before the final `commit;` in the text they send. This does not change any
function body, so the normalized-md5 check is unaffected. It is a suggestion,
not a requirement.

**M-4. Stale line reference in spec 186.** `specs/186-retention-purge-server-job.md`
(lines 182, 355 and 727, per the developer's notes) cites
`generate_po_number_malformed_guard.test.sql:38` for the unfiltered delete. The
delete is kept but now sits at line 70. The developer was right to leave spec
186's file alone. Whoever next touches 186 (or its release proposal) should
update the citation, or cite the file without a line number.

**M-5. Add spec 194 to D-9's ordering note.** D-9 lists 186, 187 and 189 as
independent of this migration. `20261109170000` (spec 194) now sorts after 190,
and it is also independent: it has no INSERT trigger on `purchase_orders` and
does not touch the sequence or either function. Spec 194 does depend on 186 being
applied first (it raises 42704 otherwise), but that constraint does not involve
190. Nothing to change in code. The spec text "currently latest" is just out of
date.

**M-6. Two relative assertions can be disturbed by a concurrent session on a
shared local database.** These are:

- `generate_po_number_sequence.test.sql:463-467` (AC-10: "sequence advanced by
  2");
- the "previous + 1" assertions in `generate_po_number_malformed_guard.test.sql`
  (lines 88, 122 and 138).

Both assume no other session calls `nextval` in between. AC-13's own wording
("when one session inserts with nothing else running") accepts this, and CI is
single-session, so I am not asking for a change. It is worth one line in each
file header, so that a local flake while the dev app is creating POs is not
mistaken for a regression.

### Noticed, not changed (out of scope)

- `src/utils/index.ts:114` `generatePONumber()` builds `PO-${padStart(3)}` from a
  module-local counter. It is dead code (no importers in `src/`). It still has
  the old 3-digit truncation-free-but-colliding shape. If anyone ever wires it
  into a PO insert, it would bypass the trigger with explicit numbers, and the
  skip loop would have to absorb them. I suggest deleting it in a future cleanup
  pass and adding it to the cleanup backlog. Do not fold it into 190.

## Security posture check (D-4) against the code

- The definer body reads no caller-supplied `NEW` field. The `exists` probe is
  keyed only on `nextval` output (migration:163-167). There is no oracle.
- Every non-catalog reference is schema-qualified (`public.purchase_orders`,
  `public.format_po_number`, `'public.purchase_orders_po_number_seq'`).
  `pg_catalog` builtins cannot be shadowed under `search_path=public`.
- Sequence and function revokes are present. DP-2 and DP-3 pin them in CI
  through `has_*_privilege`, which (unlike the prod string check, see S-1)
  accounts for PUBLIC.
- DP-1's `proowner = relowner or rolbypassrls` is the correct predicate. BYPASSRLS
  exempts the role even under FORCE RLS, and owner + no-FORCE covers the other
  case.
- No new permissive policy, so `permissive_policy_lint` is unaffected. No new
  `/rpc` surface: the trigger function cannot be called directly (0A000), and the
  formatter returns 42501 to client roles.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix, 6 Minor
  (plus 1 noticed-not-changed).
payload_paths:
  - specs/190-po-number-sequence/reviews/backend-architect.md
