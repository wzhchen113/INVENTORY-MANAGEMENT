# Spec 197: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-11-09. Read-only, except
for this file.

Reviewed against the `## Backend design` section, D-0 to D-11, of
`specs/197-revoke-client-truncate.md`:
- `supabase/migrations/20261109230000_revoke_client_truncate.sql` (new)
- `supabase/tests/public_no_client_truncate.test.sql` (new)
- `supabase/tests/public_grants_explicit.test.sql` (comment-only edits, D-5)

## Verdict

**No Critical and no Should-fix findings.** The build matches the design.
There are 5 Minor findings: 3 are about the spec/runbook text and 2 are
cosmetic.

## Targeted checks requested by the dispatcher

### 1. The DO block's relkind set matches probe arms 1-3: PASS

The match is exact, down to the spacing:

| Site | Line | Predicate |
|---|---|---|
| Migration DO block (a) | 97 | `c.relkind in ('r', 'p', 'f')` |
| Probe arm 1 | 94 | `c.relkind in ('r', 'p', 'f')` |
| Probe arm 2 | 113 | `c.relkind in ('r', 'p', 'f')` |
| Probe arm 3, `effective` CTE | 136 | `c.relkind in ('r', 'p', 'f')` |
| Probe arm 3, `direct` CTE | 146 | `c.relkind in ('r', 'p', 'f')` |

Beyond the D-11 requirement:
- The grantee predicate is also identical across DO block (a) (line 99) and
  probe arms 2/3 (lines 115, 148):
  `a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)`.
- DO block (b) (lines 110-114) uses the same default-ACL predicate as probe
  arms 4, 11a and 11b (lines 177-181, 418-422, 451-455), global
  `0::oid` branch included.
- So the migration's fail-closed check and the CI probe can't give different
  answers about the same catalog state.
- Arms 6a/6b keep `('r', 'p')` (lines 224, 240), as D-3 and D-11 require.
- The migration's `revoke ... on all tables` (line 75) still covers every kind
  `ON ALL TABLES` reaches. Only the check is narrowed, as D-11 requires.

### 2. The D-7 runbook's apply text matches the file on disk: PASS

- **Version and name.** The filename is `20261109230000_revoke_client_truncate.sql`.
  - D-7 P1 inserts `('20261109230000', 'revoke_client_truncate')`.
  - The migration header (lines 59-60) gives the same insert, wrapped over two
    lines.
  - The 14-digit prefix and the name byte-match the filename, which is what
    the drift gate compares.
- **"Verbatim, with one line before the final `commit;`".**
  - The file has exactly one `begin;` (line 73) and one `commit;` (line 121),
    and `commit;` is the last statement.
  - So the insertion point is unambiguous, and the version row is atomic with
    the body and the fail-closed DO block, as D-1 and D-7 intend.
  - The insert in the header is inside `--` comments, so pasting the file
    verbatim doesn't run it twice.
- **Column set.** It is `(version, name)` with `statements` NULL. That's the
  majority house shape D-7 chose, and the same shape used for the local
  record (spec, "Local apply and AC-5").
- **"Don't use MCP `apply_migration`"** appears in both D-7 and the header
  (line 61).
- **Pre-checks.** The header (lines 55-57) points to the D-7 P0 checks and
  the P0.5 rollback capture before the apply.
- **Raise messages.** The `197:`-prefixed raise strings (lines 102, 117) match
  the D-1 shape, which the D-7 "If the DO block raises (`197: …`) … STOP"
  line depends on.

## Design conformance, item by item

| Design item | Result | Notes |
|---|---|---|
| D-1 version and slot | Match | `20261109230000`. The build-time `ls` re-check was done (spec "Pre-apply checks"). |
| D-1 body | Match | Revoke on all tables from `anon, authenticated, public` (line 75). `alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated, public` (lines 77-78). `begin`/`commit` wrapped. No `service_role` or `postgres` touched. No `supabase_admin` default-ACL attempt. |
| D-1 DO block | Match | (a) checks direct entries only, not effective privilege, as D-1 says. It lists the offenders in the exception. (b) checks public plus the global row. |
| D-1 "Header must say" | Match | Why 097 left `D` (lines 5-12). The 097 lines 62/75/185 correction (line 11). The `supabase_admin` leftover (29-31). `service_role`/`postgres` keep TRUNCATE (27-28). MAINTAIN out of scope (32). The "No publication change, so NO `docker restart supabase_realtime_imr-inventory` step. No PostgREST reload needed." line (52-53). The D-11 relkind note (44-50). |
| D-2 default-ACL semantics | Match | Schema-scoped revoke plus a global tripwire in both the DO block and probe arm 4. Local post-apply Q-d shows `anon=arwdxtm/postgres, authenticated=arwdxtm/postgres`, with `service_role` and `postgres` still `arwdDxtm`. |
| D-3 location | Match | New file. Picked up automatically by `scripts/test-db.sh`. |
| D-3 plan(17) and arm table | Match | All 17 assertions are present in the specified order: arms 1-7 against the untouched catalog, arm 8 before 11a/11b, and 11a reverts before 11b. Expected values: 8a=0, 8b=1, 8c=3, 9a=1, 9b=1, 10a=2, 10b=1, 11a=1, 11b=1. All match D-3. |
| D-3 detection split | Match | The effective arm uses the `has_table_privilege(role, oid, ...)` overload. The direct arm uses `aclexplode` with grantee 0 labelled `PUBLIC`. Arm 3 is a `UNION` (dedupe) of the two, sorted. |
| D-3 multi-privilege gotcha | Match | Arm 7 ANDs eight single-privilege calls (lines 253-260). |
| D-3 house shape | Match | Mutate, stash with `set_config(..., true)`, drop/revert, then assert. No `savepoint`, no `throws_ok`, no `set role`. Fixtures use the `__truncate_probe_*` prefix. Session variables use `test.t197_*`. |
| D-3 no allowlist | Match | Arms 1-4 assert a flat 0. |
| D-4 arm 5 subset, `m` not pinned | Match | Lines 194-214. Six privileges × two roles, with the `defaclnamespace = 'public'` row only. |
| D-4 AC-5 manual idempotency | Match | Recorded: second apply `BEGIN / REVOKE / ALTER DEFAULT PRIVILEGES / DO / COMMIT`, exit 0, no warning. That also confirms there are no non-`postgres`-owned relations locally. |
| D-5 comment edits | Match | Header cross-reference (lines 42-43), SUBTLETY rewording (145-148), arm 3 comment rewording (275-279) and arm 5 cross-reference (383-384). The new file has the reciprocal cross-reference (lines 17-20). The arm 5a message string "must use the explicit no-TRUNCATE privilege list" is unchanged. `plan(13)` is unchanged (line 158). |
| D-6 no RLS/API/edge/db.ts/realtime/store change | Match | Nothing outside the three files and the spec. Nothing bypasses `src/lib/db.ts`, because there's no client code at all. |
| D-9 files touched | Match | The `## Files changed` list matches D-9 exactly. |
| D-11 amendment | Match | Relkind narrowed in arms 1-3 and DO block (a). Header notes added to both files. `'f'` kept. No version change. AC-10 red run reproduced the recomputed D-3 table exactly (10/17 fail, arms 1/2 = 94, 11b = 2, no pgTAP views in the output). Green run 17/17. |

## Findings

### Critical

None.

### Should-fix

None.

### Minor

**M-1. The D-7 P0.5 rollback generator's inline SQL doesn't include the D-11 amendment.**
- Where: `specs/197-revoke-client-truncate.md`, line 813 (query text) and
  lines 815-819 (the amendment).
- The `and c.relowner = 'postgres'::regrole` predicate sits in a trailing
  parenthetical. It isn't in the copy-pasteable query.
- An operator who copies line 813 as written gets a wider restore list. On
  prod, if pgTAP is present per P0.6, that list would include
  `supabase_admin`-owned view entries.
- Impact is low: re-granting those as `postgres` only warns, and view `D` is
  inert. But the restore record would no longer be "exactly what the
  migration can change".
- Suggested fix: fold the predicate into the line-813 query text before the
  prod apply. This is a spec-text edit only.

**M-2. The refined Q-a/Q-b/Q-c queries are described, not written out.**
- Where: spec lines 796-810 (D-7 item 5).
- The PM's queries at lines 208-240 still use `pg_tables` and have no relkind
  filter. D-7 only describes the changes (`pg_class`, `relkind in
  ('r','p','f')`, the oid overload, `('r','p')` for Q-c).
- At apply time the operator has to assemble the final SQL by hand.
- Suggested fix: the operator pastes the exact query text used into the
  AC-13/AC-14 notes along with the outputs, so the evidence can be
  reproduced. The design could also have inlined them; that's my omission,
  not the developer's.

**M-3. D-11's line-number pointers are stale against the final migration.**
- Where: spec lines 974-986.
- D-11 cites "Line 90" (DO-block relkind), "line 68" (revoke),
  "lines 70-71" (default ACL) and "Header lines 39-43".
- In the file on disk these are line 97, line 75, lines 77-78 and
  lines 39-50.
- The edits themselves landed correctly. Only the pointers are stale. The
  spec already says line numbers are pointers, so no action is needed beyond
  awareness.

**M-4. The spec now holds two `## Handoff` blocks.**
- Where: spec line 1001 (the architect's D-11 design handoff to
  `backend-developer`) and line 1258 (the developer's handoff to the review
  fan-out).
- The first is stale. A routing pass that reads the first match could
  mis-route.
- Suggested fix: optional housekeeping, such as relabelling the first one
  "(superseded)". Not blocking.

**M-5. The SUBTLETY block wasn't reflowed after the D-5 edit.**
- Where: `supabase/tests/public_grants_explicit.test.sql`, line 148.
- The edit left one roughly 120-character comment line:
  "...so spec 097 never removed it). So arm 3 must explicitly REVOKE SELECT ...".
- It's cosmetic and the line is a comment, so it has no test impact.

## Notes (not findings)

- **Comment-only claim for the D-5 file.**
  - I had no shell in this review, so I didn't re-run `git diff` myself.
  - I read every changed region (lines 42-43, 145-148, 275-279, 383-384).
    All are `--` comment lines.
  - The assertion bodies, message strings and `plan(13)` are unchanged.
  - That agrees with the developer's `git diff -U0` (14 insertions,
    4 deletions, comments only) and the 13/13 pass in the full suite.
- **CI proves no-regression only, not the fix.** As D-4 predicted, CI being
  green isn't evidence that the migration works. The proof is the recorded
  AC-10 red-then-green run and the AC-13/AC-14 prod before-and-after
  outputs, which are still owed under D-7.
- **Still open, by design:** AC-12 to AC-15 (prod apply, then the push and
  checks on both gates). These need the owner's explicit go-ahead.
- **Release order:** prod apply first, then push, or
  `db-migrations-applied.yml` goes red.
