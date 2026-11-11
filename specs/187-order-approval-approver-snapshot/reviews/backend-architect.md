# Backend architect post-implementation review: spec 187

Reviewed on 2026-11-08 against the spec's "Backend design" section. I read the files and ran nothing. I had no shell, database or `git diff`, so statements about uncommitted changes come from reading the working copies. Test results quoted here come from `specs/187-order-approval-approver-snapshot/reviews/test-engineer.md` and spec 186's notes.

**Result: 0 Critical, 6 Should-fix, 6 Nits.** The migration, guard, RPC, policies and `delete-user` match the design. The Should-fix items are about prod apply, rollback, landing and stale spec text, not behaviour.

## Answers to the review questions

| Question | Answer |
|---|---|
| Does the build match the design? | Yes. The one recorded departure, the migration version, is allowed by open call 8. One small unrecorded addition is acceptable (Nit 1). One "To do at build" item has no recorded outcome (SF-6) |
| Does "Prod apply" still match? | The steps do, but step 3 names no version, and the design still names spec 186's version (SF-1) |
| Does "Rollback" still match? | The database steps do, and their source references are correct. It leaves out the repo changes, so following it turns `test.yml` red (SF-2) |
| Can 186 and 187 land in either order? | Yes, if each spec's files are committed together (SF-4) |
| Does the migration replay cleanly on a fresh database? | I found no problem by reading, but no fresh build has run (SF-3) |
| Does it depend on spec 186's migration? | No |

## Critical

None.

## Should-fix

### SF-1. Prod apply step 3 names no version, and the design names spec 186's

Files: spec L251, L345, L667.

Step 3 says "Insert the exact version". The only literal version in the prod-apply and design sections is `20261108120000`, at L345 and L667, and that is now spec 186's. The correct value appears only in the implementation notes (L684) and the migration header (L32).

Inserting the wrong one does more harm than a failed step. The drift gate compares sets of versions (`db-migrations-applied.yml` L173-179), so the row would make spec 186 look applied when it may not be. The gate would still fail on `20261108130000`, but the fix for that could leave spec 186's absence hidden.

**Fix:** write `'20261108130000'` into step 3, and mark L345 and L667 as superseded by L684.

### SF-2. Rollback leaves out the repo changes, so it turns `test.yml` red

File: spec L259-268.

The section keeps the drift gate green but lists only database steps and a redeploy. The commit carrying the forward migration also has to change these:

| File | Why it fails or goes stale after the rollback |
|---|---|
| `supabase/tests/order_approvals_approver_snapshot.test.sql` | Remove it. The columns, trigger, re-stamp and AC-16 are gone |
| `supabase/tests/profiles_rls_sweep.test.sql` arms 7, 9, 10 | Restore the old expectations. The re-created policy admits these deletes, and arm 10 raises from the self-delete lock |
| `supabase/tests/auth_can_see_store_brand_scope.test.sql` arms 11, 13 | Restore `throws_ok`, for the same reason |
| `supabase/functions/delete-user/index.ts` | Revert the file as well as redeploying it, or the next deploy brings the new code back |
| `src/lib/placeholderEmail.parity.test.ts` and the header in `placeholderEmail.ts` | Remove the `COPIES` entry. Without the marked block, the parity test throws |
| `scripts/smoke-delete-user.sh`, `package.json` | Remove the script and its `test:smoke` entry, because its arms would fail |

`audit_log_rls_hardening.test.sql` stays as it is, because the rollback keeps both policies, so the UD arms still pass.

The rest of the section is correct. The guard's source is `20261108000000`, `20260801000100` is the only earlier `create_order_approval`, and `20260517060000:127-134` is the policy and its comment. Grep finds no later redefinition of any of them.

**Fix:** add this list to the Rollback section.

### SF-3. The first fresh build comes after the prod apply

Files: spec L682, L247-255; spec 186 L612; `.github/workflows/test.yml` L30-32, L173, L178.

Both migrations were applied locally with `psql`, and nobody ran `supabase db reset`. Local CLIs also differ from CI's pinned 2.106.0 (spec 186 L641). The 97/97 pgTAP pass was therefore on the shared, incrementally built database. Prod apply comes before the push, so CI's first from-scratch build arrives after prod has changed.

My read-through found no replay problem:

| Statement | Prerequisite at this version | Result |
|---|---|---|
| `add column approved_by_name`, `approved_by_email` | Table from `20260801000100`. No other migration uses these names | Clean |
| New function, comment, `revoke`, `create trigger` | Roles exist, and the name is new. The trigger is BEFORE INSERT, so T54's BEFORE UPDATE list doesn't change | Clean |
| `create or replace` guard | Same signature and return type as `20261108000000`. Its REVOKE carries over | Clean |
| `create or replace create_order_approval` | Same signature, default and return type as `20260801000100`, the only definition. Its grants carry over | Clean |
| `drop policy "Admins can delete profiles"` | Created in `20260517060000`, and no migration drops it. There is no `if exists`, which is safe here | Clean |
| Two `alter policy` statements and their comments | Created in `20261022000000` and not redefined since. The new lists keep every existing action | Clean |
| `begin`, `set local lock_timeout`, `commit` | Five earlier migrations use the same `set local` line | Clean |
| Seed, which runs after migrations | `seed.sql` has no `order_approvals` rows | Clean |

Apostrophes in `--` comments outside dollar quotes also have precedent (`20261108000000` L5). The new pgTAP file builds its own fixtures and uses no `set role anon`.

**Fix:** before the prod apply, open a draft PR containing the commit you intend to land. `test.yml` runs on `pull_request`, so Track 2 does a real `supabase start` on 2.106.0. `db-migrations-applied` will fail on that PR, as expected, because the version isn't on prod yet. Spec 186 has the same gap (its architect review, Minor 7), so one PR with both migrations would cover both. If spec 187 is to land first, also test it alone (SF-4). If the owner would rather not, record that the risk is accepted and check the first `test.yml` run on `main`.

### SF-4. The order is free only if each spec's files are committed together

Files: spec L757, L738-764.

All on-disk tests run against a database holding both migrations, so a green local run says nothing about a partial commit. These files have to travel with spec 187's migration:

| File | Without the migration |
|---|---|
| `audit_log_rls_hardening.test.sql` | UD-1 to UD-3 fail because nothing refuses the insert. UD-4 fails because staff can see the row |
| `profiles_rls_sweep.test.sql` | Arms 7 and 9 fail, and arm 10 raises |
| `auth_can_see_store_brand_scope.test.sql` | Arm 11 raises, and the later arms are affected |
| `order_approvals_approver_snapshot.test.sql` | The file fails at the fixture stage, because the columns don't exist |

The reverse also fails: the migration without those test edits turns the same arms red. `placeholderEmail.parity.test.ts` and `delete-user/index.ts` must also go together.

The notes need one correction for staging. The test-engineer report (L103) says the audit test files contain spec 186 hunks. I found none: `audit_log_rls_hardening.test.sql` never mentions spec 186 or its objects, spec 186's "Files changed" omits it, and spec 186's own test report describes only spec 187 edits there. Stage that file whole with spec 187. `src/lib/db.ts` is the file that needs staging by hunk: spec 187 owns only the comment near L2703.

**Fix:** add this coupling to the implementation notes. Spec 186 alone has local evidence (its first suite run, plus the `HEAD` test copies, L636). Spec 187 alone has never been run, because the local database already holds spec 186's migration. Reading finds no dependency, and a draft PR from SF-3 would prove it.

### SF-5. Spec text about spec 186 is out of date

Files: spec L210, L231-232, L347, L359.

| Line | Says | Now |
|---|---|---|
| L231 | Spec 186 is `READY_FOR_ARCH`, not built | It is `READY_FOR_REVIEW`, with its migration and test on disk |
| L231 | Both specs edit `audit_log_rls_hardening.test.sql`, and the second rebases | Only spec 187 edits it. No rebase is needed |
| L232 | Migration version left to the build | Settled: `20261108130000` |
| L347 | Specs 186 and 188 have no design and no migration, and spec 186 "only decides `admin_delete_audit_log`" | Spec 186 also adds three restrictive DELETE policies, a `stores` trigger and a cron job. The conclusion still holds |
| L359 | The second spec adds its arm count, or edits S-1 and S-6 if the policy is dropped | The policy stayed and spec 186 used its own test file, so nothing is owed |
| L210 | "Today `cleanupOldRecords` and `admin_delete_audit_log` do the pruning" | True only until spec 186 ships. The point about the 90-day limit stands |

A reader following L231 or L359 would look for rebase work that doesn't exist.

**Fix:** add a dated correction under the implementation notes rather than rewriting the design.

### SF-6. The CLAUDE.md proposal has no recorded outcome

Files: spec L273, L733-736.

"To do at build" says to propose a bullet to the owner: profiles are deleted only through `delete-user`, and `public.profiles` has no DELETE policy. Leaving CLAUDE.md unedited is correct, since that needs the owner's approval. But neither the implementation notes nor "Follow-ups" records the proposal, so it could be lost. This rule matters to future work, because a direct delete now removes 0 rows with no error.

**Fix:** add it to "Follow-ups", and raise it with the owner at the ship decision.

## Nits

1. **Unrecorded addition, accepted.** `delete-user/index.ts:222,261,279,300` puts `.abortSignal(AbortSignal.timeout(...))` on the PostgREST reads. The design named a timeout only for the email read and the write. The addition is what makes the design's "about 3 seconds for the reads" true. Add one line to the notes.
2. **AC-29's scan misses some fixtures.** `scripts/smoke-delete-user.sh:464-465` omits the t2, t5, t6 and no-profile super_admin names and emails. t2 is the zero-store path, which has its own log line. Add them to the list.
3. **Prod apply step 6 doesn't say which CLI deploys.** Spec 186 L667 records that `npx supabase` resolves to 3.0.0, which refuses this repo's `config.toml`. The design's `verify_jwt` check after deploying still applies.
4. **Prod apply step 7 omits two points.** It should say to check `e2e.yml` by hand, as spec 186 L248 does. It should also say that if one push carries both migrations, both must be on prod first.
5. **`removeUser` follow-up (L735).** Add that its `User deleted` insert would now be refused with 42501 if anyone gave it a caller. That is a stronger reason to remove it than "dead audit call".
6. **Spec 186 AC-23 wording (spec 186 L161).** "The restrictive SELECT and INSERT policies are unchanged" means unchanged by spec 186. Spec 187 alters both. The arms it cites still pass, so there is no conflict, but a reader of spec 186 could think there is.

I agree with the test-engineer's Should-fix on `deno check`. `delete-user` has never been type-checked, and step 6 deploys it, so the check belongs in "Prod-apply additions" beside the smoke run (L630).

## Landing order against spec 186

**Either order works.** The recommendation at L347 still stands: if they compete for time, spec 186 goes first because of its 2026-11-20 deadline.

| Layer | Finding |
|---|---|
| Objects | Disjoint. Spec 186: prune function, cron job, three restrictive DELETE policies on `purchase_orders`, `waste_log` and `pos_imports`, the `stores` trigger, and a comment on `admin_delete_audit_log`. Spec 187: `order_approvals` columns, trigger, guard and RPC, the `profiles` policy, and two restrictive `audit_log` policies with their comments |
| `audit_log` policies | Different policies on one table. Spec 186 changes only a comment. It keeps the `spec 170: ` prefix, so S-6 still counts 5, and its P-7 pins that. Spec 187 keeps the policy names, so S-1 holds, and it doesn't touch `admin_delete_audit_log`, so S-5 holds |
| `audit_log_rls_hardening.test.sql` | Only spec 187 edits it. No arm depends on spec 186. It also passed with both migrations in place (61/61) |
| Cross-references | None of spec 187's migration, `delete-user` or its three edited test files mentions spec 186 or its objects. Spec 186's migration and test don't mention spec 187's objects |
| Spec 186's A7 fixture | Inserts into `order_approvals` as postgres with named columns and no approver. The new trigger stamps NULL, so it passes with or without spec 187 |
| Fresh database | Version order is always 186 then 187 when both exist, and each replays alone |
| Prod | Either apply order is fine for the gate, because it compares sets. A version on prod ahead of its commit only warns (`db-migrations-applied.yml` L215-246). Each version must be on prod before the push that commits it |
| Not exercised | Applying 187 before 186. By reading, the two migrations are independent |
| Spec 186's pending rework | Its architect review (SF-1) removes the `stores` trigger by editing `20261108120000` in place. Nothing in spec 187 uses that trigger or `waste_log`. Spec 187 adds no FK, so it can't shift the RI firing order that review proposes to pin. Spec 187 doesn't need to wait for it |
| Behaviour | The prune will delete `User deleted` rows at 90 days, which Known limits already says. The snapshot stays the durable record |

## Checked against the design, no finding

- **Guard:** `v_restamp` is the exact NULL-safe expression. `approved_at` left block (a). Blocks (a1) and (a2), the no-approver refusal and the comments match. Blocks (c), (c2), (d) and (e) match `20261108000000` when read side by side.
- **RPC:** the only body changes are `approved_by = auth.uid()` as the first SET entry in both pending branches. Signature and INVOKER posture are unchanged.
- **Trigger:** the function is SECURITY DEFINER with `search_path = public`, its reads are schema-qualified, and the REVOKE matches. On INSERT it fires after the lines check, by name order, as the design says.
- **Policies:** both use `alter policy`, the action lists match the design, and the comments keep the prefix. `profiles` has no other DELETE or ALL policy in the migrations.
- **Direct deletes:** the only `profiles` deletes in `src/`, `supabase/functions/`, `e2e/` and `scripts/` are the two service-role ones. No migration function deletes from `profiles`. `removeUser` has no callers.
- **Audit reads:** apart from the prune's delete, the migrations read `audit_log` in two places, an existence check and a count. Neither returns rows to a caller, so I found no definer path that exposes the email to staff.
- **`delete-user`:** reads, row shape, write conditions, response paths and log contents match open calls 4, 5 and 6. The placeholder block is in the marked region, and `config.toml` has no per-function change.
- **Client:** nothing in `src/` writes `approved_by` or `approved_at`, and `mapOrderApproval` picks named fields. The only `src/` changes are comments and the parity list, so nothing bypasses `db.ts`.
- **Tests:** plan counts match (49 and 61), the design's added arms exist, and the flipped arms match the table. T54 filters on BEFORE UPDATE, so it is untouched.
- **Realtime:** neither table is added to `supabase_realtime` by any migration, so there is no restart step.
- **To-do items:** the spec 178 pointer, the spec 043 note and the stale comments are done, including `auth_can_see_store_brand_scope.test.sql`, whose comment moved to L427.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 6 Should-fix, 6 Nits. The build matches the design. Specs 186 and 187 can land in either order if each spec's files are committed together. No fresh build has run yet.
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/backend-architect.md

---

# Re-review 2026-11-09: amendment A1 to A9

Reviewed on 2026-11-09 against "Backend design amendment (2026-11-09)" (spec L730-1040) and "Amendment build (2026-11-09)" (spec L1114-1200). I read the four built files in full: `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql`, `supabase/functions/delete-user/index.ts`, `supabase/tests/order_approvals_approver_snapshot.test.sql`, and the amended parts of `scripts/smoke-delete-user.sh`. I also read the other sessions' migrations on disk (`20261109120000`, `20261109140000`, `20261109170000`), specs 191 and 195, and `.github/workflows/db-migrations-applied.yml`. I ran nothing and had no `git diff`. Run results quoted here come from the build notes.

**Result: 0 Critical, 3 Should-fix, 8 Nits.** The build matches A1 to A9. The three known departures are recorded and acceptable. All six of my original Should-fix items and both code-reviewer Should-fix items are resolved. The new Should-fix items are about the AC-37 premise, landing hygiene, and one prod-apply precondition. None is about behaviour.

## Build against A1 to A9

| Part | Finding |
|---|---|
| A1 guard | Matches. `v_uid` is read once. `v_restamp` is the same NULL-safe expression. `v_pending_edit` lists exactly the eight columns, all compared with `is distinct from`. Block (a) still runs first, so G6's message is unchanged. (a0) fires only on `old.status = 'pending' and v_uid is not null and (v_restamp or v_pending_edit)`, with checks in A1's order: NULL approver, then `profiles.role in ('admin','master','super_admin')` through an inline `exists`, then approver = caller (migration L170-183). It does not use `auth_is_privileged()`. Blocks (a1), (a2), the `source_submission_id` block, and blocks (b) to (e) are as specified. The "don't change to invoker" comment covers the role read |
| A2 column and snapshot block | Matches. `approved_by_id uuid` is in the same `alter table`, nullable, with no default, FK or index (L63-66). The five-line snapshot block is byte-identical in the stamp trigger (L94-98) and the re-stamp branch (L193-197). (a1)'s refusal covers `approved_by_id` (L202) |
| A3 fixes 4, 5 and 7 | Done. `authDeleteThrew` and `authDeleteThrown` (index.ts L517-526). `DeleteAuditIds`, `DeleteAuditSnapshot` and `readDeleteAuditSnapshot`, with locals `ids` and `snapshot` and handler locals `auditIds` and `auditSnapshot`. The `Promise.race` comment (L242). The `approvalCount` null note (L187). `drop policy if exists` (migration L559). The trimmed RPC header (L365). The `db.ts` reflow (now at L2637-2643, see Nit 7). The smoke's `new_target` and `SMOKE_T0` comments (L177, L257-258). No response, log line or I/O changed |
| A4 pgTAP | All 19 new arms are present. `plan(68)` matches the header map. `_t187_view` carries the id tag (L304-320), `_t187_edit_snapshot` tries a forged and a NULL `approved_by_id`, and `_t187_edit_pending` tries each listed column alone. The fixtures `b0`, `b1` and `a4` match A4. The "run as caller, record into a setting, assert as postgres" pattern holds throughout |
| A5 mutations | Every required arm went red, and no run aborted (spec L1148-1173). That table covers all 17 rows of A5, plus each column of `v_pending_edit` separately |
| A6 shared-stack delta | Recorded as A6 required. Live `prosrc` matched the file, and the references were recaptured afterwards |
| A7 fresh build | Done without touching the shared stack. Spec 187 alone gave 96/96 files, and specs 186 and 187 together gave 97/97 |
| A8 prod-apply additions | `deno check` passed on Deno 2.1.4 (the edge runtime's own version). The smoke passed, including AC-24's id checks. Step 4 references were recaptured. The step 5 column and FK checks are written into the spec. The email-confirmation read is deferred to the prod apply, which is correct |
| A9 file list | Matches the "Files changed" list |

### The three known departures

1. **Column comments on `approved_by_name` and `approved_by_email` (migration L68-72).** Accepted. A2 specified only `approved_by_id`'s comment, but the old wording would have been false after the trim and fallback change. A9 lists "comments" as migration work. The statements are idempotent and outside every function body, so they don't affect the md5 references. One follow-on is Nit 4.
2. **AC-5 capturing the delete outcome through `_t187_try` (test L427-461).** Accepted, and an improvement. Before, a guard that refused the FK's SET NULL aborted the file instead of turning AC-5 red. Now the A5 rows "fire (a0) on any `approved_by` change" and "FK on `approved_by_id`" fail as arms. The roles and claims under which each delete runs are unchanged (postgres, postgres again, and postgres with B's claims), so AC-5c still proves what the design asked.
3. **`b0`'s padded name (test L135-140, L922-924).** Accepted. It closes the INSERT half of AC-2d's second sentence ("A non-blank name is stored trimmed"). The re-stamp half is not pinned (Nit 3).

## Earlier findings

| Item | Status | Evidence |
|---|---|---|
| Architect SF-1 (prod-apply version) | Resolved | Step 3 names `'20261108130000'` and warns against `20261108120000` (spec L285). Open call 8 and the design's file list are marked superseded (L391, L717) |
| Architect SF-2 (rollback repo changes) | Resolved | Table at spec L304-314. It includes the third column (L299). One omission: Nit 5 |
| Architect SF-3 (fresh build) | Resolved | A7 gave 96/96 alone and 97/97 with spec 186 (L1190-1196). Caveat in Nit 6 |
| Architect SF-4 (commit coupling) | Resolved as written, but the staging picture has changed since (SF-R2) | Spec L1097-1102 |
| Architect SF-5 (stale spec 186 text) | Resolved as of when it was written, then stale again after `15aefc4` | Nit 8 |
| Architect SF-6 (CLAUDE.md bullet) | Resolved | Follow-ups L1206. Main Claude adds the bullet at landing |
| Code-reviewer Should-fix 1 (type names) | Resolved | The two types are now structurally distinct, so swapping the `ids` and `snapshot` arguments to `writeDeleteAudit` fails the type check. `deno check` passed |
| Code-reviewer Should-fix 2 (`thrown` sentinel) | Resolved | A thrown `undefined` no longer falls through to the 200. The remaining edge case is in Nit 1 |

## Critical

None.

## Should-fix

### SF-R1. AC-37's "until spec 191" premise is false: spec 191 doesn't close either gap

Files: spec L170 (AC-37), L232 (owner Q&A), L266 (Dependencies), L872-877 (A1, "What 187-H2 still leaves open"), L1208 (Follow-ups); test L65-66, L930-936. Against: `specs/191-demote-profile-brand-scope.md` L89, L214, L236, L291, L693, L793.

Both AC-37 gaps (a stale `admin` claim can INSERT a pending row, and can move an approved row to `ordered`) pass through `privileged_store_*_order_approvals`, which reads `auth_is_privileged()`. That function reads the JWT for admin and master. Spec 191 changes only the demote RPC, the invitations INSERT and UPDATE policies, and the profiles INSERT policy. It names converging `auth_is_admin()` and `auth_is_privileged()` with `profiles` as a separate, later spec (191 L214, L236, L291). Spec 195 removes the cross-brand self-link, but AC-37's fixtures insert `user_stores` as postgres, and an in-brand demoted admin keeps their old links. So:

- AC-37a and AC-37b stay green after both 191 and 195 ship. No arm flips, and the "If spec 191 closes either one, that spec flips these arms" instruction will never fire.
- The test descriptions say "KNOWN GAP until spec 191". That will become false the day 191 lands.
- The owner accepted "the remaining exposure until those ship" (L232). In fact these two gaps last until the unnumbered `auth_is_admin()` follow-up. Within one brand, each occurrence is bounded by `jwt_expiry` after a demotion. The cross-brand reach does end with spec 195.

**Fix:** in AC-37, Dependencies, A1's open list, Follow-ups and the two test descriptions, replace "spec 191" with "the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed)". Add that follow-up to Follow-ups. Tell the owner at the ship decision that the acceptance is open-ended until that spec exists. Only text changes, and `plan()` doesn't change.

### SF-R2. The index already holds spec 190's migration, so a bare commit could turn the drift gate red

Files: `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md` L161-167; spec L1102, L1124, L1237; the git status at the start of this session.

Since the release proposal's staging table was written, spec 186 has been committed (`15aefc4`). Other sessions now have staged (`A`/`M` in the index): `supabase/migrations/20261109140000_po_number_sequence.sql`, `supabase/tests/generate_po_number_sequence.test.sql`, `generate_po_number_malformed_guard.test.sql`, `report_run_variance_formula.test.sql`, `scripts/smoke-po-number-concurrency.sh`, and specs 188, 189 and 190 with their reviews. The proposal's "Leave out" row still names spec 186's files, which are already committed, and doesn't name spec 190's. If spec 187 is committed with a bare `git commit` before spec 190 is on prod, `20261109140000` reaches `main` and `db-migrations-applied.yml` hard-fails on it. The unstaged working copies of `src/lib/db.ts`, `package.json`, `specs/043-*` and `specs/178-*` may also carry other sessions' hunks, which I couldn't check without `git diff`.

**Fix:** before the commit, refresh the staging guidance. Delete the spec 186 rows. Commit with an explicit path list (`git commit -- <spec 187 paths>`), or unstage the other sessions' files first. Confirm with `git diff --cached --stat` that the only migration is `20261108130000`. Stage `db.ts` by hunk at its new location (Nit 7), and look at the `package.json` diff to confirm the only change is the `smoke-delete-user.sh` append.

### SF-R3. Prod apply has no check that a newer migration hasn't redefined spec 187's objects

Files: spec L279-289 (Prod apply), L670-680, L1021-1029.

Spec 187's version `20261108130000` now sorts before `20261109120000` (189), `20261109140000` (190), `20261109170000` (194), and the planned `20261109160000` (195), `20261109190000` (193) and `20261109191000` (191). Any of these may reach prod first. The drift gate doesn't care (see "Landing picture"). The hazard is different. If a migration with a later version runs `create or replace` on `tg_order_approvals_guard` or `create_order_approval`, or alters either `audit_log` restrictive policy or a `profiles` DELETE policy, and lands on prod first, then:

- On prod, spec 187 is applied last, so 187's version wins.
- On a fresh build (CI, `db reset`), migrations run in filename order, so the later migration wins.

Prod and CI would then run different function bodies, and neither gate would notice. Step 4's md5 check compares against references captured on 2026-11-09, which would also be stale.

Today nothing conflicts. I grepped `20261109120000`, `20261109140000` and `20261109170000` for every spec 187 object and found only a comment mention of `order_approvals.source_submission_id` in 189. Specs 191 and 195 each state no overlap with spec 187's objects (191 L474, 195 L431-432). But four sessions are writing migrations in parallel.

**Fix:** add a step 0 to "Prod apply". List the repo migrations with a version above `20261108130000` and grep them for `tg_order_approvals_guard`, `tg_order_approvals_stamp_approver`, `create_order_approval`, `order_approvals_stamp_approver_trg`, `audit_log_restrict_select_store_user_actions`, `audit_log_restrict_insert_server_only_actions` and `on public.profiles` with `for delete` or `for all`. If any match, stop: that spec must be rebased on spec 187's body, and spec 187 must apply first. Also recapture the step 4 md5 references on the day of the apply, rather than reusing the 2026-11-09 values.

## Nits

1. **A thrown `undefined` still loses the JSON 500 shape** (`delete-user/index.ts` L536, L548-549). `throw authDeleteThrown` with `undefined` reaches the outer catch, and `(e as Error).message` then throws a TypeError inside it. Deno.serve's default handler returns a plain 500 with no CORS headers. The fix's goal (never a 200) holds, and supabase-js doesn't throw `undefined`. Optional: `(e as Error)?.message ?? "internal error"`.
2. **The guard's `comment on function` has a lowercase sentence start** (migration L338-339): "...while ''pending''. the line snapshot freezes...". Cosmetic, and outside the md5.
3. **Trimming on re-stamp isn't pinned for a non-blank name.** AC-2d's second sentence is unqualified, but only `b0`'s INSERT pins it. AC-8b pins only the blank fallback on re-stamp. A re-stamp that kept a padded raw name would pass every arm. The "textually identical" rule and review are the current guard. Cheap fix: have `b0` re-stamp an A pending row in AC-35f instead of creating a fresh one, or add one arm.
4. **The A8 step 5 prod check doesn't compare the column comments.** It checks that `approved_by_id` has "its comment", but the other two comments were edited too (departure 1). Comparing `col_description()` on all three columns between local and prod would be one query.
5. **Rollback should list CLAUDE.md.** If main Claude adds the "no DELETE policy on profiles" bullet at landing (Follow-ups L1206), a rollback that re-creates `Admins can delete profiles` makes that bullet false. Add it to the repo-change table at L304-314.
6. **A7 ran on `c630c7f` plus a copy of spec 186's migration taken while it "was still changing"** (spec 194 L242, spec L1124). The 97/97 combined run is the right evidence for "`15aefc4` plus spec 187" only if that copy matches what was committed. The objects are disjoint, so the risk is low. The first `test.yml` run on the spec 187 push confirms it either way.
7. **The `db.ts` line references are stale.** The spec 187 hunk is now at `src/lib/db.ts` L2637-2643, not L2703 (spec L1102, L1237, release proposal L164), because other sessions' hunks moved it.
8. **Spec 186 text is stale again after `15aefc4`:** Known limits L240 ("spec 186 is now READY_FOR_REVIEW"), Dependencies L264, Prod apply step 7's spec 186 clause (L289, now moot because its version is on prod with the gate green), and the correction table at L1104-1112. Add one dated line, not a rewrite.

## Landing picture

| Question | Answer |
|---|---|
| Does the out-of-order version matter to `db-migrations-applied.yml`? | **No.** The gate builds two sorted sets and runs `comm` in both directions (workflow L104-107, L143, L173-179). Order is never compared. It hard-fails only if `20261108130000` is in the repo and not in prod's `schema_migrations`. So the rule is unchanged: insert the version on prod (step 3) before the push that commits the file, whatever has landed in between |
| Does it matter to a fresh build (`test.yml`, `db reset`)? | **Not today.** A fresh build applies files in name order, so spec 187 runs before 189, 190 and 194, while prod will have applied it after them. The end state is the same because the objects are disjoint: 189 writes `audit_log` rows with action `EOD entry`, which is in neither restrictive list, and only cites `order_approvals.source_submission_id` in a comment; 190 touches none of 187's tables; 194 touches none. 189's replace path keeps the `eod_submissions` id (DO UPDATE), and an `eod_submissions` delete changes only `source_submission_id`, which isn't in `v_pending_edit`, so (a0) doesn't fire. The future risk is SF-R3 |
| Do the other sessions' tests interact? | No conflict found. `admin_submit_eod.test.sql` (189) and `retention_prune_job.test.sql` (186) insert `order_approvals` as postgres with no approver, so the trigger stamps NULL. Only spec 187's files delete `profiles` as `authenticated`. Spec 195 lists 187's test as passing unedited (195 L436) |
| Anything else ordering-sensitive? | Only local CLI use. `supabase migration up` or `db push` on a stack whose newest applied version is above `20261108130000` refuses an older pending version without `--include-all`. That affects only a local stack built from `main` after 189, 190 or 194 land and before spec 187's file arrives. The shared stack already has 187 applied, and prod uses MCP. `supabase start` on an existing volume doesn't re-apply migrations, so such a stack needs `db reset` |
| Order relative to spec 186 | Settled. Spec 186 is on `main` (`15aefc4`) and on prod, with the gate green |

## Checked, no finding

- **Prod-apply references match the built file.** Step 3's version, step 4's three functions, and step 5's three columns, trigger, no profiles DELETE policy and both `User deleted` lists match the migration. The recorded `prosecdef`, `proconfig` and owner values are consistent with the source: both trigger functions are DEFINER with `search_path=public`, and the RPC is INVOKER with `search_path=public`. The `proacl` values are consistent with the REVOKE on the stamp function, the guard's carried-over REVOKE, and the RPC's carried-over grants. The amendment notes say the RPC's raw `prosrc` md5 is unchanged by the delta, which matches the migration: only the header comment outside the body changed.
- **Rollback matches the built migration.** It covers the guard's source (`20261108000000`), the RPC's source (`20260801000100`), the trigger and its function, the policy re-create, all three columns, and keeping the `audit_log` policies. The repo-change table matches the files.
- **RLS:** no policy changes beyond the original design. The `audit_log` policies and the profiles drop are unchanged from the first review.
- **Client:** no `src/` code reads the new columns. `mapOrderApproval` still picks named fields. The only `src/` change is the `db.ts` comment. Nothing bypasses `db.ts`.
- **Realtime:** no publication change, so no `docker restart supabase_realtime_imr-inventory`.
- **Smoke:** AC-24 checks `approved_by_id = target` on all three approvals, and the 3 × 2 `detail.target_id` pairs by text match (smoke L287-301; `||` binds tighter than LIKE, so the pattern is built as intended). AC-29 now scans the t2, t5 and t6 names and emails and the no-profile super_admin's email (L480-482).

## Handoff
next_agent: NONE
prompt: Architectural drift re-review of the 2026-11-09 amendment complete. 0 Critical, 3 Should-fix, 8 Nits. The build matches A1 to A9, and the three recorded departures are accepted. Original SF-1 to SF-6 and the code-reviewer's two Should-fix items are resolved. New Should-fix: AC-37's "until spec 191" premise (spec 191 doesn't close those gaps); landing hygiene (spec 190's migration is staged in the index); and a prod-apply step 0 against a later migration redefining 187's objects. The out-of-order version doesn't matter to the drift gate or to a fresh build today.
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/backend-architect.md

---

# Re-review 2 (2026-11-09): the stamp trigger's INSERT checks (re-proposal item 1)

No A10 amendment was written, so I checked the build against item 1 of "Re-proposal 2026-11-09" in `release-proposal.md` (L261-279) and the owner's answers under "Open questions resolved" (spec L249-260). The build is described in "Re-proposal build (2026-11-09)" (spec L1233-1305). I read `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql` and `supabase/tests/order_approvals_approver_snapshot.test.sql` in full, the spec's prod-apply, API contract, A1 and A8 sections, and grepped every migration on disk after `20261108130000`, `supabase/functions/`, `scripts/` and `src/` for `order_approvals` insert paths. I ran nothing and had no `git diff`. Run and md5 results quoted below come from the build notes.

**Result: 0 Critical, 1 Should-fix, 5 Nits.** The build matches item 1 and the owner's wording. Check order, messages and the NULL-uid gate are correct. The md5 references and prod-apply checks were updated. The SF-R1 and SF-R3 text is correct. AC-35j's P0002 is acceptable. The Should-fix is text only: the API contract table doesn't list the two INSERT refusals.

## The checks you asked for

| Check | Finding |
|---|---|
| Check order, and the email read after the refusals | Correct. In `tg_order_approvals_stamp_approver()`, `v_uid uuid := auth.uid()` is declared (migration L107). Inside `if v_uid is not null` (L111-120) the status check comes first (L112-114), then the role check (L115-119). The `profiles.name` and `auth.users.email` reads are at L122-123, after both. A refused insert never reads `auth.users`, as the owner asked ("Both checks go before the email read"). AC-38a and AC-38b pin status-first: at `approved` and `ordered` a stale-claim caller gets the status message, not the role message, so swapping the two checks would turn both arms red |
| Message strings | `order approval must be inserted as pending` and `order approval caller is not an admin`, both `using errcode = 'P0001'`. The second is byte-identical to the guard's (a0) message (L206), which the owner's decision asked for. The proposal left the first open, and it follows the lowercase `order approval …` prefix, no trailing period, like the other five guard messages. Both match AC-38, the function comment (L131), and prod-apply step 5 |
| The role read | Inline `exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('admin', 'master', 'super_admin'))`, the same as (a0). Not `auth_is_privileged()` or `auth_is_admin()`, which matches the owner's wording, proposal item 1, and spec 191 L374. It runs as the definer past the caller's RLS. The A5 mutation "role check through `auth_is_privileged()`" turns AC-37a, AC-38a and AC-38b red |
| NULL-uid gate | Correct. Both refusals sit inside `if v_uid is not null`, so postgres and `service_role` with no claims skip them. AC-38d proves that for both roles at `approved` and `ordered`, and the stamp still fills A's snapshot. The A5 mutation that drops the gate aborts the file at its own fixtures, which is still a red run. I found no insert path that this gate breaks. The only API-caller INSERT in the code is `create_order_approval`'s, at `'pending'` (migration L520). No edge function inserts `order_approvals`: `delete-user` and `instacart-cart-link` only read or UPDATE. Nothing in `src/` inserts directly. `scripts/smoke-delete-user.sh` L189 inserts as postgres. No migration after `20260801000100` other than spec 187's inserts into the table. The developer's 103-file run with the change injected first covers the postgres fixtures in `retention_prune_job`, `order_approvals_fk_set_null`, `report_last_order_context` and `admin_submit_eod` |
| Things item 1 said to leave alone | `channel`, the timestamps, `line_count` and `est_total_cost` are not touched. The guard body and `create_order_approval` are unchanged: the build notes record their raw `prosrc` md5 as unchanged (`c89df6a4…`, `a544d68d…`) and the guard's normalized md5 as unchanged (`733e4f3e…`). That fits, because only the guard's `comment on function` changed, and `pg_get_functiondef` doesn't include comments. Trigger order on INSERT is unchanged (lines check, then stamp, by name), and RLS `WITH CHECK` still runs after both, so AC-2c's 42501 for a real admin naming someone else holds |
| Prod-apply md5 references and checks | Updated. The amendment-build table is marked superseded for the stamp trigger only (spec L1167). The new table (L1263-1267) gives the stamp trigger normalized `cdc18777…` and raw `45f14d61…`, with the guard and RPC unchanged. `prosecdef`, `proconfig`, owner and `proacl` are unchanged, which fits `create or replace` keeping the ACL. Step 4 (L314) says to recapture on the day of the apply. Step 5 (L315) now checks that the stamp trigger's `prosrc` contains both new messages. A8's step 5 check on the guard's `prosrc` (L1059) still holds. The function body has no `--` comments or `--` inside strings, so the normalization's comment strip can't change it. I couldn't recompute any md5 myself |
| SF-R1 text | Correct. AC-37 (L173-175) makes AC-37a a refusal and keeps AC-37b as the only known gap, ending with the convergence follow-up rather than spec 191. The same correction is in the owner Q&A (L247, L255), Dependencies (L292-293), A1's role-check posture (L802) and its open list (L908), Follow-ups (L1313-1314), and the test file's header and AC-37b description (test L69-71, L1028). L908 is accurate about what's left after the fix: the INSERT bullet is closed, and email reads, approved → ordered and re-mints stay open until the convergence spec, each bounded by `jwt_expiry` |
| SF-R3 text | Correct. Step 0 (L310) lists exactly the object names from my SF-R3 and says to stop on a match. I re-ran that grep on today's disk. The only hits are in `20261109191000`, which touches only the profiles INSERT policy and the profiles UPDATE guard's comment, as step 0 says. `20261109170000`'s two `for delete` policies are on `po_items` and `pos_import_items`. `20261109195000`'s `for all` is in a comment about `user_stores`. See Nit 1 for one new file |
| AC-35j's P0002, before the guard | Acceptable. The NULL-brand `a4` passes the RPC's two top gates (store link, stale claim) and line validation, then `vendor_order_channel()` (INVOKER) can't see the brand's vendor, so the RPC raises P0002 before its UPDATE (migration L488-491). The refusal happens before any write, the row is unchanged (the arm pins that), and the message only echoes the vendor id the caller supplied. The guard path it doesn't reach is the same BEFORE UPDATE code that AC-35c reaches for `a4` by PATCH, and that AC-35a reaches through the RPC for `a1`, so every refusal in the guard is still covered for both profile shapes. Pinning the exact P0002 string is a useful tripwire: if vendor visibility for NULL-brand profiles ever changes, the arm goes red and someone looks at it. The spec explains it in AC-35's sub-bullet (L170) and the test explains it in a comment (L1006-1008) |

## Critical

None.

## Should-fix

### SF-R2-1. The API contract table doesn't list the INSERT refusals, and one existing error changes

Files: spec L555-565 (API contract). Against: migration L111-120, AC-38 (spec L179-183).

The two new P0001 refusals are in D1, Change, AC-38 and the build notes, but not in the API contract table, which is where the design keeps error cases. There is also a side effect that nothing records. BEFORE triggers run before RLS `WITH CHECK`, so a direct INSERT by any API caller whose `profiles.role` isn't privileged now fails with P0001 `order approval caller is not an admin` (HTTP 400) instead of 42501 from `privileged_store_insert_order_approvals` (HTTP 403). That includes ordinary staff and a caller with an `admin` claim but no profile row. A direct INSERT at any status other than `pending` by any API caller now gets P0001 `order approval must be inserted as pending`, whatever their role or store visibility. No client makes a direct INSERT and no test pinned the old 42501, so nothing breaks, and no data leaks: both checks read only the caller's own profile and the row's own status. The "Caller with no profile row" row (L565) also describes only the RPC and PATCH paths.

**Fix (text only):** add two rows to the table. First, an API caller's INSERT not at `pending`: P0001 `order approval must be inserted as pending`, HTTP 400, checked first. Second, an API caller's INSERT when their `profiles.role` isn't privileged: P0001 `order approval caller is not an admin`, HTTP 400, which replaces RLS's 42501 for that caller. Add one clause to L565 saying a direct INSERT by that caller now gets P0001 from the stamp trigger before RLS runs.

## Nits

1. **Step 0's dated list of later migrations is out of date.** `20261109230000_revoke_client_truncate.sql` (spec 197) is now on disk and isn't in L310's list. I grepped it: it revokes TRUNCATE and touches none of spec 187's objects, so the conclusion still holds. Step 0 is run on the day anyway. Optional: add it, or note that the list is a snapshot.
2. **A1's open list still begins "until specs 195 and 191 ship"** (L901), and the owner Q&A keeps the original answer at L246. Both have their dated corrections right below (L908, L247), which is how this spec handles corrections. Optional: a short "(see correction below)" after L901's first sentence, so someone reading only the bullet list doesn't stop there.
3. **The fixture comments for `a1` and `a4` list old arms** (test L130, L133). `a1` is now also used for AC-35a, b, h and i, AC-37a and AC-38a. `a4` is now also used for AC-35j and AC-38b. Cosmetic.
4. **The mutation that drops the gate aborts the file instead of failing an arm** (spec L1276). That is a red `test-db.sh` run, so it does its job, and AC-38d is the arm that would show it if the fixtures didn't fire first. No change needed. I'm only noting that this one mutation's evidence is an abort, not a named arm.
5. **The comment above the stamp function (migration L80-84)** still says an INSERT naming someone else "reads their email into NEW, then fails … with 42501". Since this change that only happens for a privileged-profile caller at `pending`. The next paragraph (L88-99) says this, so the two read correctly together. Optional: say "a privileged caller's INSERT naming someone else". This is outside the function body, so it doesn't affect the md5.

## Checked, no finding

- **Owner decision wording:** non-NULL `auth.uid()` scope, `pending` only, `profiles.role` in the three privileged roles, both checks before the email read, `channel` and the timestamps left alone, AC-37a now a refusal, AC-35b on a postgres fixture (day 99, test L195), every pgTAP file run with the change injected first. All match.
- **Test arms against item 1's list:** stale-claim direct INSERT at `pending`, `approved` and `ordered` for both shapes (AC-38a, AC-38b); real admin at `approved` and `ordered` (AC-38c); postgres and `service_role` with no claims (AC-38d); each counts rows as postgres to prove nothing was created. `plan(76)` matches the header map. S1 (AC-35h to j) and N1 (AC-8c, `b0` re-stamping day 112 and stored trimmed) are present. The A5 additions cover each new check.
- **Comments:** header item (1), the block above the function, its `comment on function`, and the guard's `comment on function` (Nit 2 from the first re-review, "The line snapshot" now capitalised) all describe the built behaviour.
- **Posture:** still SECURITY DEFINER with `search_path = public`, schema-qualified reads, and the REVOKE from `public, anon, authenticated` unchanged.
- **Rollback:** dropping the stamp trigger and its function removes the new checks, as the Rollback section now says (L325). No new repo files are coupled.
- **Realtime and client:** no publication change, no `src/` change, and nothing bypasses `db.ts`.

## Handoff
next_agent: NONE
prompt: Architectural drift re-review 2 (stamp trigger INSERT checks) complete. 0 Critical, 1 Should-fix, 5 Nits. The build matches re-proposal item 1 and the owner's decisions: status check first, then the inline profiles.role check, both before the email read and gated on a non-NULL auth.uid(). The messages are correct, the md5 references and step 5 checks were updated, the SF-R1 and SF-R3 text is correct, and AC-35j's P0002 is acceptable. Should-fix (text only): add the two INSERT refusals to the API contract table, and record that a non-privileged caller's direct INSERT now gets P0001 instead of RLS's 42501.
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/backend-architect.md
