# Release proposal: spec 197 (revoke client TRUNCATE)

Release-coordinator, 2026-11-09. Synthesized from the four reviewer files in
this directory (read in full), the spec, the migration
`supabase/migrations/20261109230000_revoke_client_truncate.sql` and arm 7 of
`supabase/tests/public_no_client_truncate.test.sql`.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical or High, and every local acceptance criterion passes. Before the prod apply, though, the runbook and rollback SQL in the spec need fixing (M-1/L-3, M-2), a few comment edits in the migration have to be made now or never, and I could not confirm the current `main` CI gates.

This is a small FIXES_NEEDED. Every item is a text fix, a comment fix or a
test-file fix. None of them changes the migration's SQL statements or the
privilege outcome. Once they're done, the work moves to the owner-gated prod
apply and push (AC-12 to AC-15). Those steps are the planned ship sequence, not
failures.

**CI gate status: not verified.** I have no shell in this run, so I could not
run `gh run list --branch main --workflow test.yml --limit 1` or the same
command for `db-migrations-applied.yml`. I am not reporting any result for
them. Under the CLAUDE.md hard rule, SHIP_READY needs both latest `main` runs
green, so step 0 below is to check them.

## Findings summary

- **code-reviewer:** 0 Critical, 1 Should-fix, 5 Nits.
  - Should-fix: probe arm 7 (`public_no_client_truncate.test.sql:252-263`)
    checks that `anon` holds INSERT/UPDATE/DELETE on `public.inventory_items`.
    That is business policy, not this spec's invariant. A legitimate future
    tightening of client writes would turn the probe red, and the failure
    message ("a revoke removed more than TRUNCATE") would point at the wrong
    cause. Arm 7 follows the design as written (D-3), so this is a refinement,
    not drift.
  - Nits:
    - the test header hard-codes "47 of 51 / 52 of 56" counts;
    - the migration header cites "project MEMORY" (lines 55-61), which a repo
      reader can't resolve, and repeats D-7/D-8 text;
    - `public_grants_explicit.test.sql:148` wasn't reflowed;
    - there are 4 copies of the arm-4 detector (add a "keep identical to arm
      (4)" comment);
    - a redundant `::text` cast in the migration (line 90).
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 5 Low.
  - The revoke is complete for everything a `postgres` migration controls in
    `public`. The probe can't be fooled by PUBLIC, by inherited membership or
    by relkind `p`/`f`. The fail-closed DO block is atomic with the version
    insert. The rollback can't reopen spec 041's `profiles` escalation.
  - L-1: client TRUNCATE remains outside `public`, and the
    `postgres`/`storage` default ACL still carries `D`.
  - L-2: the probe hard-codes `{anon, authenticated}`. A SET-only role grant
    or a new client role would get past it.
  - L-3: the P0.5 rollback generator emits names without a schema, and its
    `relowner` filter is written as prose rather than SQL.
  - L-4: CI can't prove prod's posture, and a platform upgrade could quietly
    bring client `D` back.
  - L-5: a MAINTAIN revoke won't close client `LOCK TABLE`.
  - `npm audit` found pre-existing issues (1 critical, 17 high). The lockfile
    is untouched, so these don't come from spec 197.
- **test-engineer:** no gaps. AC-1 to AC-11 PASS. AC-12 to AC-15 PENDING on
  the owner's go-ahead, by design.
  - Own runs: the new probe passes 17/17, and the full `scripts/test-db.sh`
    passes 104/104 files.
  - Developer evidence only, consistent with the post-state:
    - AC-5's second apply;
    - the AC-10 red run (10 of 17 fail; arms 1/2 = 94; 11b = 2);
    - jest 301/301 suites, 3836/3836 tests;
    - `typecheck:test` exit 0.
  - Note: a green CI run doesn't prove the fix (D-4).
- **backend-architect (post-impl):** no drift. 0 Critical, 0 Should-fix,
  5 Minor.
  - Verified:
    - the DO block's relkind set and grantee predicate match probe arms 1-3
      byte for byte;
    - the version and name match the filename;
    - the D-7 "verbatim plus one insert before `commit;`" text is
      unambiguous.
  - M-1: the rollback generator SQL at spec line 813 doesn't include the D-11
    `relowner` predicate.
  - M-2: the refined Q-a/Q-b/Q-c queries are described but not written out.
  - M-3: D-11's line pointers are stale.
  - M-4: the spec has two `## Handoff` blocks; the first is stale.
  - M-5: the SUBTLETY comment wasn't reflowed (same as the code-reviewer
    nit).

## Recommended next steps (ordered)

Severity first, then dependency. No item is Critical. The fix-before-ship
items come first because the prod apply depends on them.

### 0. Check the current `main` gates (blocks any SHIP_READY call)
Run `gh run list --branch main --workflow test.yml --limit 1` and the same
command for `db-migrations-applied.yml`. If either is red or still running,
surface the run URL to the owner before doing anything else. (Pipeline rule:
SHIP_READY needs both green.)

### Fix-before-ship: runbook and spec text (before P0 runs on prod)
These belong to the developer or architect. They are spec edits only.

1. **M-1 + L-3: rollback generator (P0.5, spec line 813). Low/Minor. Do
   first, because P0.5's output becomes the only restore record and has to be
   right when it's captured.** Rewrite the code block so that it:
   - emits `format('grant truncate on %I.%I to %s;', n.nspname, c.relname, …)`
     (schema-qualified, so it doesn't depend on `search_path` when pasted
     verbatim into a future `_restore_client_truncate.sql`);
   - includes `and c.relowner = 'postgres'::regrole` in the SQL itself, not
     in the trailing parenthetical.
2. **M-2: write out the final Q-a, Q-b, Q-c (and Q-e) SQL in D-7. Minor.**
   The versions to write out use `pg_class`, `relkind in ('r','p','f')`, the
   `has_table_privilege(role, oid, …)` overload, and `('r','p')` for Q-c. This
   stops the operator assembling the queries by hand during the MCP session,
   and makes the AC-13/AC-14 evidence reproducible. At minimum, paste the
   exact query text used next to the outputs.
3. **M-4: mark the first `## Handoff` block (spec line 1001) "(superseded)".
   Minor.** This stops a routing pass from reading the stale
   backend-developer handoff.

### Fix-before-ship: migration comments (now or never)
4. **Migration header comment edits (code-reviewer nit). Nit, but do it
   before the prod apply or not at all.** The file is applied verbatim and
   becomes immutable once it's on prod and pushed. Two edits:
   - change "spec 064 gate, project MEMORY" to "spec 064 drift gate";
   - optionally shorten the PROD-APPLY/ROLLBACK blocks to a pointer at spec
     D-7/D-8.

   Comments don't change the SQL's effect, and the drift gate compares only
   the version string. Leave the redundant `::text` cast alone; it's harmless
   and not worth touching the SQL body for.

### Fix-before-commit: test files (test-only; the migration isn't affected)
5. **Arm 7 narrowing (code-reviewer Should-fix).** Recommended: drop the
   `anon` INSERT/UPDATE/DELETE checks and keep the `authenticated` ones (arm 5
   already pins the six default-ACL privileges). The alternative is to keep
   the arm and change its message to "if a later spec intentionally tightened
   this table, pick a different sample table". This needs a matching one-line
   edit to the D-3 arm 7 row so the design and the test agree.
6. **Comment cleanups (nits / M-5).** Three edits:
   - reflow `public_grants_explicit.test.sql:148`;
   - replace the hard-coded counts in the probe header with "most tables";
   - add a "keep identical to arm (4)" comment above arms 11a/11b.

   Comments only. No plan count or assertion changes, except step 5 if that
   option is taken.
7. **Re-verify after steps 5-6.** Run
   `bash scripts/test-db.sh supabase/tests/public_no_client_truncate.test.sql`
   (expect 17/17) and the full `scripts/test-db.sh`. If only SQL test files
   changed, jest doesn't need a re-run.

### Ship sequence (owner-gated; AC-12 to AC-15)
8. **Owner decisions before the apply:** Q1 (default: separate session from
   spec 190) and Q3. The security-auditor recommends (L-4) that the owner
   choose "re-run Q-a after any Supabase platform upgrade or dashboard
   extension install" instead of "accept permanently".
9. **Prod apply, on the owner's explicit go-ahead, BEFORE any push** (D-7;
   the architect's release order). Project `ebwnovzzkwhsdxkpyjka`, MCP
   `execute_sql` only, never `apply_migration`.
   - P0.1 to P0.6 read-only pre-checks, including the P0.5 rollback capture
     with the corrected generator from step 1. Respect each STOP condition
     (identity, a non-`postgres` owner on `r`/`p`/`f`, a global default ACL).
   - P1: one `execute_sql` call. Body: the migration file verbatim, plus
     `insert into supabase_migrations.schema_migrations (version, name) values ('20261109230000', 'revoke_client_truncate');`
     just before `commit;`. If the call raises `197: …`, STOP and report.
   - P2 post-checks: Q-a 0 rows, Q-b 0, Q-c n/n, Q-d (`postgres/public` →
     `arwdxtm`; `supabase_admin` byte-identical to the pre-check), the version
     row present, and the spot check. Paste the outputs and query text into
     the spec for AC-13, AC-14 and AC-15.
10. **Commit (owner confirms) and push.** Stage only the spec 197 files: the
    migration, the two test files, the spec, and this reviews directory. The
    working tree holds staged and unstaged changes from other specs (188, 189,
    196 and others), which must not go into this commit.
11. **Post-push check (AC-12):** confirm the latest `main` runs of both
    `test.yml` and `db-migrations-applied.yml` are green. **A green CI run
    does not prove the fix (D-4):** the CI image may already lack client `D`.
    The proof is the recorded AC-10 local red-to-green run plus the prod
    Q-a/Q-d before-and-after outputs from step 9. Both have to be in the spec
    before 197 counts as done.

### Follow-up (not blocking ship)
- **MAINTAIN (`m`) revoke** (open question Q2). When it's opened, fold in:
  - **L-1:** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage REVOKE TRUNCATE ON TABLES FROM anon, authenticated, public`
    (latent; `postgres` can fix this one). Record the Supabase-owned
    `storage`/`net`/`supabase_functions` client TRUNCATE under Residual risk.
  - **L-5:** frame MAINTAIN as VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH only.
    Clients keep LOCK TABLE through UPDATE/DELETE, so the follow-up must not
    claim to close lock-DoS.
- **L-2:** an optional probe arm asserting that `anon`/`authenticated` are
  members of no role
  (`select count(*) from pg_auth_members where member in ('anon'::regrole, 'authenticated'::regrole)` = 0),
  plus the rule that any spec adding a client-facing role extends arms 1 and
  3.
- **L-4 / Q3:** periodic prod Q-a re-check, if the owner adopts it in step 8.
- **M-3:** the stale D-11 line pointers. The spec already says line numbers
  are only pointers, so no action is needed.

## Out of scope for this review
- **`npm audit` results** (1 critical `shell-quote`, 17 high including
  direct `@react-navigation/*`). These predate this change and the lockfile
  is untouched. Recommend a separate dependency-hygiene spec.
- **Client TRUNCATE on Supabase-owned schemas** (`storage.objects`,
  `storage.buckets`, `net.http_request_queue`, `supabase_functions.*`). Owned
  by Supabase roles, so a `postgres` migration can't revoke it. Excluded from
  scope by the owner.
- **The `supabase_admin` default ACL for `public`.** An accepted leftover,
  since prod's `postgres` can't change it.
- **The PG17 MAINTAIN privilege.** Owner limited this spec to TRUNCATE (Q2).
- **Inert `D` on views and matviews.** Accepted in D-10 #5 / D-11.
- **The unrelated staged and unstaged working-tree changes** (specs 188, 189
  and 196, `delete-user`, `placeholderEmail`, and others). Each belongs to its
  own spec and commit.
