# Spec 189: release proposal

Re-synthesized 2026-11-09 by release-coordinator, after the pre-commit fixes. This replaces the earlier FIXES_NEEDED proposal.

**What I read directly:**
- all five files in `specs/189-admin-eod-resubmit-replace/reviews/`, including the new "## Re-check (S1 fix)" section in `code-reviewer.md` and "## Re-check (L1 fix)" in `security-auditor.md`;
- the spec's amended design text: §3.1, §3.4 Rule C, §5, §12 AC-33, §13 rollback (a) to (d), and §14 (the prod order table and the N2 filter);
- arms (95) to (101) and the `…a3` / `…a4` fixture calls in `supabase/tests/admin_submit_eod.test.sql`.

I ran nothing. The gate results, the browser smoke and the CI run ids come from main Claude's report.

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical. The three fixes the owner approved (code-reviewer S1, security L1 / architect N3, architect S1) were each re-checked and closed. All local gates pass on the combined fixes, and the three CI gates on `main` are green. Shipping still depends on the owner's go-ahead and the order below: prod apply, then push.

**Gate evidence (main Claude, on the combined fixes):**
- `npx jest`: 301/301 suites, 3836/3836 tests.
- `npm run typecheck:test`: exit 0.
- Base `tsc --noEmit` with the filtered `--types` list: exit 0. Plain `npm run typecheck` is still unrun, because of the untracked `* 2` folders. CI doesn't see those folders.
- `bash scripts/test-db.sh`: 101/101 files. The spec 194 deadlock didn't recur.
- Browser smoke: submit, then EDIT changing one row and clearing another. Result: 1 entry, correct values, and a `Count cleared` audit row. The test rows were removed afterwards.
- CI on `main` HEAD `15aefc4` is green: test.yml 42750558373, db-migrations-applied 42750558466, e2e 42750558580. That commit contains no spec 189 files, so these runs show `main` is healthy but are not evidence for 189. The first post-push runs are.

## Findings summary

- **code-reviewer:** 0 Critical. 3 Should-fix: 1 resolved, 2 open as follow-ups. 7 Nits: 1 closed.
  - **S1 resolved** (re-check).
    - `finishSubmitted` (`EODCountSection.tsx:1122`) now calls `dropVendorBaselines(baselineRef.current, vid)` at `:1135`, before the map clears. This drops every baseline key ending `|${vid}`, across all dates and stores.
    - No other path empties a vendor's maps.
    - The failure `catch` keeps baselines for a retry.
    - The new jest `describe` (`:441-496`) walks the Monday-draft / Tuesday-submit / Monday-submit path. It asserts `removed` is `[]`, so the old single-key delete would fail it.
    - The reviewer endorsed clear-on-map-clear over clear-on-date-change.
  - **Inline-key nit closed.** `eodBaselineKey` (`:183`) is module-level and is the only place a key is built.
  - **Still open:**
    - S2: a note-only edit on a mode-disabled row is lost, and the screen reports success.
    - S3: undo restores a stale snapshot.
    - Remaining nits, confirmed still in the tree: the stale "GRANT block at the bottom" comment at migration `:335`, positional writer calls, the 23505 pre-flight comment, the `db.ts:1074` null guard, and the unreachable defensive check. None block.
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 2 Low plus 1 informational, all unchanged by the fix. L1 resolved.
  - **L1 resolved** (re-check).
    - Live `prosrc` matches the file. The pgTAP file passes 101/101.
    - Every probe was refused with 22023, with the snapshot unchanged and zero `pg_stat_xact` write counters, so nothing was written and rolled back. The probes covered:
      - `'{NULL}'`, with `draft` and with `submitted`;
      - `{NULL, id}`, and `{NULL}` with non-empty entries;
      - an absent id;
      - an id whose row is in another submission;
      - an S2 item;
      - no parent;
      - NULL entries.
    - Multi-dimensional arrays get 0A000, still before any write.
    - The control removal succeeded.
    - The ACL, `prosecdef`, `proconfig`, owner and overloads are unchanged.
  - **Lock analysis:** the new `for update` on the removal-only path is the call's first row lock, the same order as the writer's upsert and `staff_submit_eod`. So there's no deadlock cycle. A store member can't use it to block admins beyond the existing 8 s `lock_timeout`. There are two timing-dependent residuals, both reachable only by privileged callers, and neither is a finding.
  - **No new findings.**
  - **Still open:**
    - M1: `staff_submit_eod` erase-all-but-one with no audit row. Going into spec 193.
    - L2: the staff wrapper has no `p_status` validation and no vendor-brand check.
    - L3: a demoted admin keeps the JWT gate until the token expires.
- **test-engineer:** 34/34 ACs PASS under the §12 wordings, with 0 FAIL and 0 NOT TESTED. The report predates the fixes and counts 96 arms.
  - The fixes add coverage: arms (97) to (101) for AC-33's new Rule C clauses, and the S1 jest arm.
  - AC-28 step 7 (the reorder quantity on screen) is still unchecked. It's low risk, because ASE#89-#93 cover the RPC. It can be closed at §14 step 5.
- **backend-architect (post-impl):** no contract drift. 0 Critical. 2 Should-fix, both now addressed. 6 Nits. The architect wrote no re-check section, so I verified S1 by reading.
  - **S1 fixed.**
    - Arm (96) (`admin_submit_eod.test.sql:1155-1160`) now counts every `action = 'EOD entry'` row in stores `…a3` / `…a4`, with no `user_id` filter, and expects 0.
    - I confirmed that those stores receive only `admin_submit_eod` calls with `'{}'` removals (L1051-1065), and no staff call. So a non-NULL `p_audit_actor` regression would now produce rows the arm counts.
    - Main Claude reports the developer showed the arm failing against a deliberately doubled audit.
  - **S2 addressed in the spec.** §13 now carries (a) the comment at `20261024000000` L1001-1002, (b) both spec 193 branches, (c) the post-rollback state (23505 on admin re-submit, O-1 and the null-total guard revert), and (d) the same-PR test deletion and a new migration version. §14 step 1 has the N2 `item_id is not null` filter.
  - **N3** is closed by Rule C, together with security L1.
  - **Still open:**
    - N1: two stale fixture comments, still at `report_last_order_context.test.sql:263, 277`.
    - N6: the toast uses the local count, not the server's `entry_count`.

## Recommended next steps (ordered)

### 1. Commit (owner's explicit go-ahead; the owner runs `git commit`)

**First, deal with the index. It already holds other sessions' staged work.** This is from the session-start snapshot, which was truncated, so re-run `git status` and `git diff --cached --stat`.
- **Staged and not spec 189:**
  - `scripts/smoke-po-number-concurrency.sh`
  - `specs/188-breadbot-nightly-sync-repair.md`
  - `specs/190-po-number-sequence.md` and its `reviews/`
  - `specs/194-kept-records-delete-hardening.md`, its `prod-verify.sql` and its `reviews/`
  - `src/lib/db.deletePoItem.test.ts`
  - `src/lib/db.upsertVendorDraftOrder.test.ts`
  - `src/store/useStore.removePoLine.test.ts`
  - `supabase/migrations/20261109140000_po_number_sequence.sql`
  - `supabase/migrations/20261109170000_kept_records_delete_hardening.sql`
  - per the earlier pass, `supabase/tests/generate_po_number_*.test.sql` and `supabase/tests/report_run_variance_formula.test.sql`
- **`src/lib/db.ts` shows `MM`.** Some of its hunks are already staged, most likely spec 194's `deletePoItem` / `upsertVendorDraftOrder`. Run `git diff --cached src/lib/db.ts` to see which.
- **A plain `git commit` would sweep all of that into the 189 commit.** Either commit the other specs first (190 and 194 both have staged release proposals), or `git restore --staged` their paths. If you unstage, the owning session has to re-stage, by hunk for `db.ts`. `git commit -- <paths>` doesn't help here, because it commits whole working-tree files and would pull other sessions' hunks out of `db.ts` and `useStore.ts`.

**The spec 189 spec file is partly staged.** `specs/189-admin-eod-resubmit-replace.md` shows `AM`: an earlier version is in the index, and the working tree holds the post-review amendments (§3.4 Rule C, §5, §12 AC-33, §13 (a) to (d), the §14 order table and N2 filter). It's a 189-only file, so re-stage it whole with `git add`, then check `git diff --cached` for it against the working tree.

**Whole files, new:**
- `supabase/migrations/20261109120000_admin_eod_replace.sql` (now with Rule C)
- `supabase/tests/admin_submit_eod.test.sql` (101 arms)
- `src/lib/eodChangeSet.ts`, `src/lib/eodChangeSet.test.ts`
- `src/store/useStore.submitEOD.undo.spec189.test.ts`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx` (now with the S1 arm)
- `specs/189-admin-eod-resubmit-replace/` (every review file including the two re-check sections, `manual-verification.md`, and this proposal)

**Whole files, modified.** They look 189-only, but run `git diff <file>` first:
- `src/screens/cmd/sections/EODCountSection.tsx` (now with `eodBaselineKey` and `dropVendorBaselines`). Check that no spec 192 work has started in this file.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`
- `src/store/useStore.submitEOD.noNeed.spec172.test.ts`
- `src/lib/db.eodNoNeed.test.ts`
- `supabase/tests/report_last_order_context.test.sql`
- `supabase/tests/eod_submissions_edit_flow.test.sql` (comments only)
- `supabase/tests/eod_update_notifications.test.sql`: only the O-1 `'[]'` → `test.payload` swap and its header. Spec 193 plans edits in this file.
- `e2e/staff-reorder.spec.ts`: the L292 comment only.
- `README.md`: the `admin_submit_eod` row (about L225) only. Stage by hunk if `git diff` shows anything else.

**By hunk, `src/lib/db.ts`.** Stage only:
- the removed `isNumericEodEntry` import;
- the `submitEODCount` block and its comment (about L1013-1077).

Leave out spec 187's `create_order_approval` comment hunk (about L2638) and spec 194's `deletePoItem` (about L1892) and `upsertVendorDraftOrder` (about L1996) hunks. Some of those may already be in the index; see above.

**By hunk, `src/store/useStore.ts`.** Stage only:
- the `submitEOD` interface signature and doc (about L763-772);
- the `submitEOD` body (about L3177-3347).

Leave out every other hunk.

**Don't stage:**
- `package.json`, `scripts/smoke-delete-user.sh`, `supabase/functions/delete-user/index.ts`, `src/lib/placeholderEmail*`
- `supabase/tests/{audit_log_rls_hardening,auth_can_see_store_brand_scope,profiles_rls_sweep}.test.sql`
- `specs/043`, `specs/164`, `specs/178`, and specs 187 and 191 to 195
- migrations `20261108130000`, `20261109170000` and `20261109195000`
- the stray `* 2` folders

### 2. Prod apply (owner's explicit go-ahead), before any push

Apply `20261109120000` with the §14 runbook, through MCP `execute_sql` plus the exact `schema_migrations` insert.

**Order:**
- **After spec 187** (`20261108130000`). Pre-check that it is in `schema_migrations`.
- **Before spec 193** (`20261109190000`, provisional). Pre-check that it is *not* on prod. 193's md5 pre-check must target the post-189 `staff_submit_eod` body. Rule C changed only `admin_submit_eod`, so the staff body 193 builds on is unaffected.
- **Specs 190 (`20261109140000`), 194 (`20261109170000`) and 195 (`20261109195000`)** share no EOD objects. If any of them reaches prod first, 189 goes in out of version order. That's fine through MCP plus the exact insert, because the gate compares sets.

**Pre-checks (stop and ask the owner on any surprise):**
- the duplicate query, with the `submission_id is not null and item_id is not null` filter, expecting 0 rows;
- the §3.2 role-drift query, expecting 0 rows;
- `pg_policies` shows no DELETE or ALL policy on either table;
- prod's normalized `staff_submit_eod` md5 matches `20261024000000`.

**Verify afterwards:**
- the unique index exists;
- `prosecdef`, `proconfig` and the ACL are correct for all three functions;
- the normalized md5 of all three matches local. The security re-check confirmed that the local `prosrc` already matches the final file, Rule C included, so local is a valid reference.

Between the apply and the push, `db-migrations-applied` only warns. The reverse order (push first) turns it red.

### 3. Push, then check the gates

After the push, confirm that the latest `main` runs of `test.yml` **and** `db-migrations-applied.yml` are green, and check `e2e.yml` by hand. If either gate is red or still running, surface the run URL and wait.

### 4. Prod confirmation (§14 step 5)

The owner does one EDIT on prod through the UI, then re-runs the filtered duplicate query. On a day with a scheduled vendor, that pass can also close AC-28 step 7 (the reorder quantity on screen).

### 5. Optional doc touch-ups (developer or architect; non-blocking, can go in before step 1)

- §3.4 Rule C still says "being built in parallel". It's built now.
- `## Files changed` still says `admin_submit_eod.test.sql` has "96 arms", and doesn't mention the Rule C edit, arms (97) to (101), the arm (96) rewrite, or the S1 fix (`eodBaselineKey`, `dropVendorBaselines`, the new jest arm).
- If someone has the files open: architect N1 (the two fixture comments) and the code-reviewer migration nits (the `:335` comment, step labels, named notation on the writer calls).

### Follow-ups (not blocking; each needs its own spec or the owner's call)

- **code-reviewer S2:** a note-only edit on a mode-disabled row is lost while the screen shows success. Fix with a skipped-rows signal (a `skippedItemIds` return plus a warning toast) or a server carry. It's named in §5.
- **code-reviewer S3:** undo restores a stale snapshot. Either compare by reference before restoring each piece, or trigger the store reload after undo.
- **D-5:** client audit rows and `broadcast_notification` still fire on a failed write. Move them after the server's answer, or into the server write.
- **Security M1:** `staff_submit_eod` can erase all but one entry, at any age, with no audit row. Going into **spec 193**. Its cheapest fix is a `Count cleared` CTE on the staff full-replace branch.
- **Security L2:** add `p_status` validation and the vendor-brand check to the staff wrapper. Consider `check (status in ('draft','submitted'))` after a prod read-only check.
- **Security L3:** a demoted admin keeps access until the JWT expires. Session revocation on demote or delete belongs in its own spec.
- **Architect N6:** use the server's `entry_count` for the toast.
- **Rule C, two admins (raised by main Claude):** if two admins clear the same row and the clear is the second admin's only change, the second save names a row that no longer exists. It gets 22023 and the failure toast. The failure path keeps the baseline, so every retry fails the same way until a reload. Stale baselines in general behave the same way (§3.4 "Client consequence"). Nothing is lost: the row is already gone, and the first admin's `Count cleared` audit row records it. Possible fix: have the client treat that specific refusal as "already cleared" and reload, or re-fetch before retrying.
- **Minor test gap (optional):** security probed `{NULL, id}` with non-empty `p_entries`, but no pgTAP arm pins it. Arms (97) to (99) all use `'[]'`.

## Out of scope for this review

- **Root cause of the S1 class:** vendor-keyed input maps leak across dates and stores, and the worksheet header shows the wrong date. That's spec 192. Its handoff should name two things:
  - the residual from §5's correction note: a leaked Monday value blanked on Tuesday's worksheet becomes a Monday removal;
  - the S2 note-loss signal.
- **O-2:** a `p_date` bound on `staff_submit_eod`. Spec 193.
- **"total 0" on the locked screen:** predates this spec. Seen in the manual pass.
- **Spec 185's stale wording** (L35, L37, N1) about the admin delete. D-3 leaves it to the owner. 189 must land before 185.
- **Dropping `idx_eod_entries_submission_id`,** now redundant with the unique index (design §1), and **removing the direct `store_member_insert_*` / `admin_update_*` EOD write paths** (design §9).
- **The `kept_records_delete_hardening.test.sql` deadlock** under a shared database. That's spec 194. It didn't recur in main Claude's 101/101 run.
