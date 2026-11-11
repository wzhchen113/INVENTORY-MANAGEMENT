## Backend architect drift review for spec 195

Scope: the "## Backend design" section (D-0 to D-10) compared with:
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`
- `supabase/tests/user_stores_own_row_writes.test.sql`
- the arm (8), (9), (10) and (11) and header edits in `supabase/tests/legacy_permissive_policy_dropout.test.sql`
- the correction at `specs/164-profiles-insert-hardening.md:160`

Limits: I had no shell or DB access. I did not run `git diff`, pgTAP, or the mutation and fail-closed checks. I read the files in place and compared them against the design and the migration history on disk.

**Verdict: no contract drift.** The policy diff, the fail-closed block, the arm set and the AC-5(a) split all match the design. There are two departures. The version change is correct, but the spec's runbook text has to catch up before the prod apply. The comment-before-DO ordering is a benign flaw that came from my own D-1.

### Critical
None.

### Should-fix

**S-1. The spec still names `20261109160000` in its prod runbook. This blocks AC-R2.** `specs/195-user-stores-own-row-writes.md`
- **Judgement on the departure:** keep `20261109195000`. Don't renumber back.
  - D-1's [confirm] said to move if anything "sorts later" than `…160000`, and `20261109170000` (spec 194) does.
  - Specs 196 (L199) and 197 (L87, L337, L382) already name `20261109195000` as the newest file on disk and plan their slots after it.
  - A later slot also keeps `supabase migration up` from refusing an out-of-order local file.
  - The migration header (L44-45) carries the right version.
- **Why it matters:** the D-8 runbook is what gets pasted into `execute_sql`. The note at L505 ("every D-8 reference means 195000") only helps someone who reads it first. Inserting `'20261109160000'` would cause two problems:
  - `db-migrations-applied.yml` hard-fails on the push, because `20261109195000` is missing from prod.
  - A prod `schema_migrations` row would claim the now-unreserved `…160000` slot. A future migration given that version would be skipped silently as "already applied". The second problem is worse than the first.
- **Exact corrections (text only; nothing else changes):**
  - **L285 heading:** `20261109160000_user_stores_drop_own_row_writes.sql` → `20261109195000_user_stores_drop_own_row_writes.sql`.
  - **L287 version bullet:** replace the rationale with the as-built reason: "Built as `20261109195000`. At build time `20261109170000` (spec 194) sorted after `…160000`, spec 193 reserved `…190000` and spec 191 `…191000`. See Implementation notes."
  - **L443 (D-7):** "the commit carrying `20261109160000`" → `20261109195000`.
  - **L463 (D-8 apply step 2):** `values ('20261109195000', 'user_stores_drop_own_row_writes');`
  - **L467 (D-8 verify):** `where version = '20261109195000';`
  - **L488 (D-10):** filename → `20261109195000_…`.
  - After these, the override sentence at L505 can stay as history.
- **Related, no edit needed:** `specs/194-kept-records-delete-hardening.md:579` still records `20261109160000` as "reserved by 190-user-stores-own-row-writes". That slot is now free. Spec 194 is built at `…170000`, so leave 194 alone. Just don't treat `…160000` as reserved when you pick future slots.

**S-2. Coordinate with code-reviewer's Should-fix on the policy comment text.** It is at code-reviewer.md L17.
- The built `comment on policy` (migration L72-73) matches D-1 step 3 word for word, so there is no drift.
- If the comment is shortened as code-reviewer suggests, D-8 apply step 3 needs updating too. It checks `obj_description(...)` against "the spec 195 text".
- Make the edit before the prod apply. Re-run `psql -v ON_ERROR_STOP=1 -f` locally afterwards. The file is re-runnable: the drop is `if exists` and the comment overwrites. This keeps local `pg_description` in step with the file.
- Don't edit the body after prod has it.

### Nits

**N-1. A missing read policy aborts at the COMMENT, not with a `195:` message. Accept it; fix it cheaply if the body is touched anyway.**
- **Cause:** D-1 put the `comment on policy` step before the DO block, so this is my sequencing.
- **Effect:** the apply is still fail-closed with nothing changed. The error comes from Postgres and names the missing policy (FC3). So AC-2's substance, "the whole apply aborts with nothing changed", holds. Only the "`195:`-prefixed" wording doesn't, and only for this one case.
- **Fix, if S-2 or anything else edits the migration body before the prod apply:** move the `comment on policy` statement to after the `end $$;` of the DO block. The DO block doesn't depend on the comment.
  - With that order, branch R raises `195: expected exactly one permissive SELECT policy … found 0 () qual <null>`. That is because `v_n <> 1` and `v_read_qual` is NULL.
  - No test changes. T1-T4 pin the post-state, and the comment isn't asserted.
- **If the body isn't otherwise touched:** don't edit it just for this. Add one line under AC-2 instead: "A missing read policy aborts at the COMMENT step with Postgres' own error; still fail-closed."

**N-2. The rollback text leaves a stale comment and an orphaned test file.** Migration header L49-57, spec D-8 rollback steps 1 and 3.
- The read policy keeps its spec 195 comment ("The own-row write arm was dropped …") after the 051 policy is re-created. Add `comment on policy "Users can read own store links" on public.user_stores is null;` to rollback step 1.
- "Revert arm (9)" isn't enough for the forward re-create migration. Once the own-row policy exists again, `user_stores_own_row_writes.test.sql` goes red: M1 turns 15 of its 23 arms red (Implementation notes, mutation table). The forward migration's PR must also retire or invert that file. Add this to D-8 rollback step 3 and the header. My D-8 had the same gap.
- Emergency-only text, so this is a nit.

**N-3. If MCP `execute_sql` wraps the call in its own transaction, the file's own `begin;` only warns.**
- The `set local lock_timeout` and the DO-block rollback still behave as designed, because everything is in one transaction either way.
- Specs 164 and 187 used the same pattern on prod. No change, just expect the "already a transaction in progress" warning (FC1 shows it locally).

**N-4. Two harmless departures from D-5 in the test file.** Both are documented and both are improvements:
- Fixture ids use `195` instead of `190`.
- An idempotent postgres re-seed of the demoted user's Towson link before T11. Without it, T11 passes vacuously under M1.

### Checked and matching the design

- **Migration body vs D-1:**
  - Order: `begin`, `set local lock_timeout = '5s'`, `drop policy if exists`, comment, DO block, `commit`. Matches.
  - DO checks W, R and A use the predicates and `195:` messages from D-1. The R check includes the `qual = '(user_id = auth.uid())'` pin. The A check uses `position('auth_can_see_brand' …)` on both `qual` and `with_check`.
  - RESTRICTIVE policies are not checked, per design.
  - No change to any function, trigger, grant or publication, so AC-3 holds. The header records everything D-1 required:
    - the policy diff
    - trigger-before-RLS
    - no realtime restart
    - no grant change
    - no PostgREST reload
    - prod-apply
    - rollback
- **Rollback SQL vs the original:** the `create policy` and `comment on policy` text in the header matches `20260520010000_legacy_permissive_policy_dropout.sql:104-113` exactly.
- **Prod-apply steps vs the built file:**
  - The header names P-1 to P-7 and the version `20261109195000`.
  - It points at T3 as the comparison literal. T3 (test L206) matches the Implementation-notes capture: 139 bytes, md5 `b05a4d4429e322a9cf194d6072b5f6d3`, and qual is the same as with_check.
  - P-7 matched locally (`postgres | t | f | postgres | t | t`), so `register_invited_profile()` doesn't depend on the dropped arm. AC-12 is green.
- **Test file vs D-5:**
  - T1-T23 map one-to-one to the D-5 table, with `plan(23)`.
  - Every 42501 arm pins the RLS message text, not the grant message.
  - T8 pins the trigger P0001 format string (`20260528010000…`). T12 is the a2 arm, after the postgres unlink.
  - The synthetic super_admin is inserted, not promoted. `auth.users` token columns are `''`.
- **Legacy test vs D-6:**
  - Arm (9) is a single `throws_ok(…, '42501', <RLS msg>, …)` with no `reset role` after it. Arm (10) sets its own role and claims, so the flow is correct. `plan(13)` is unchanged.
  - The header (8)/(9), the `v_target_a` comment, and the arm (8) and (11)(i) comments are reworded.
  - The file mentions no other spec, so I found no other session's hunks.
- **Spec 164 correction (AC-16):** it is appended at L160, directly under the untouched L159, and dated 2026-11-09. It covers the NULL-brand wording and names the policy that was removed.
- **AC-15:** nothing under `src/`, `supabase/functions/`, `e2e/` or `app.json` is touched.

### Fresh-build ordering (CI `test.yml` applies migrations in filename order)

- **On disk:** `20261108000000` (178, committed), `…08120000` (186, committed), `…08130000` (187), `…09120000` (189), `…09140000` (190 po-number), `…09170000` (194), `…09195000` (195). Planned: 191 `…09191000`, 193 `…09190000`, 197 `…09210000`.
- **None of the others touches `user_stores` policies.** I searched every 2026-11 migration for `user_stores` and `auth_can_see_brand`: the only hit is a comment and a function-body call in the already-committed `20261105000000_stock_store_from_store.sql`. No migration after `20260520010000` creates, alters or drops a policy on `user_stores`. So 195 sees the same three-policy pre-state, and the T3 deparse, on any subset of the pending migrations.
- **195's test fixtures use only long-standing columns**:
  - `profiles`: id, name, role, initials, color, status, brand_id
  - `stores`: …, eod_deadline_time
  - the multi-brand `profiles_role_brand_consistent` constraint

  So the file passes on `main` plus 195 alone. That is the CI state if 195 lands before 187, 189, 190 and 194.
- **Pending pgTAP files that write `user_stores` do it only as postgres fixtures:**
  - `generate_po_number_sequence.test.sql:258`
  - `admin_submit_eod.test.sql:150`
  - `order_approvals_approver_snapshot.test.sql`

  So they don't depend on the dropped arm.
- **Note for the 191 and 193 sessions:** their versions sort before `…195000`. Locally that is fine with `psql -f`, and on prod with MCP. Plain `supabase migration up` or `db push` would need `--include-all` once 195000 is recorded. The drift gate checks presence only.

### Independence from 187 and 191: confirmed

- **187** changes `order_approvals`, `profiles` and `audit_log`. 195 references none of them beyond base `profiles` columns.
- **191** changes `profiles` and `invitations` policies, the demote RPC, a new `auth_profile_is_privileged()`, and the BEFORE UPDATE trigger function `assert_brand_id_immutable_for_self()`. It doesn't touch `user_stores`, `auth_is_privileged()` or `auth_can_see_brand()`. Evidence:
  - Spec 191 L218 and L703 say this.
  - Its design table, L342-344 and L491-501, lists nothing on `user_stores`.
- **191's trigger is UPDATE-only,** so 195's postgres INSERT of a super_admin fixture doesn't touch it.
- **Spec 191 L282 lists `legacy_permissive_policy_dropout` as "must pass unmodified".** Read that as "191 doesn't edit it". With 195 applied, it passes in its 195-edited form. If 191's developer runs the suite on a stack *without* 195 applied, while 195's edited test file is in the shared working tree, arm (9) fails. That is an environment artefact, not a conflict.

### Landing guidance

**The index already holds other sessions' staged files.** These include spec 190 po-number-sequence (`20261109140000_po_number_sequence.sql`, `generate_po_number_sequence.test.sql`, `generate_po_number_malformed_guard.test.sql`, the 190 spec and reviews, `scripts/smoke-po-number-concurrency.sh`), the 188 and 189 specs, `report_run_variance_formula.test.sql`, and `tests/README.md`. A bare `git commit` would carry `20261109140000` with 195. If that migration isn't on prod, `db-migrations-applied.yml` goes red.

1. **Apply S-1 first, plus S-2 and N-1 if you take them,** before anything touches prod.
2. **Prod (owner go-ahead):**
   - Run P-1 to P-7 per AC-R1.
   - `execute_sql` the exact, final file body.
   - Insert `('20261109195000', 'user_stores_drop_own_row_writes')`.
   - Verify per D-8, comparing the md5 against `b05a4d4429e322a9cf194d6072b5f6d3`.
3. **Before staging:**
   - Run `git diff -- supabase/tests/legacy_permissive_policy_dropout.test.sql specs/164-profiles-insert-hardening.md`. Both show ` M` in a tree that other sessions share. Confirm the only hunks are 195's: the arm (8)-(11) and header comments plus arm (9), and the L160 correction.
   - Many other `supabase/tests/*.sql` files are ` M` too. Don't touch them.
4. **Commit only 195's paths, and leave the rest of the index untouched.** Use `git add` and then a pathspec commit (`git commit` with `--only` semantics), for example:
   - `git add supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql supabase/tests/user_stores_own_row_writes.test.sql supabase/tests/legacy_permissive_policy_dropout.test.sql specs/164-profiles-insert-hardening.md specs/195-user-stores-own-row-writes.md specs/195-user-stores-own-row-writes/`
   - then `git commit -m "..." -- <the same paths>`

   Check with `git show --stat HEAD` that no other file, and above all no `20261109140000`, is in the commit, and that 190's staged entries are still staged afterwards. Per project memory, the user runs the commit.
5. **After the push:** check that the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand (AC-R3).

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix (S-1, which blocks the prod apply: correct the spec's 160000 references at L285, L287, L443, L463, L467 and L488 to 20261109195000; S-2: coordinate the comment-text edit with D-8's verification), 4 Nits.
payload_paths:
  - specs/195-user-stores-own-row-writes/reviews/backend-architect.md
