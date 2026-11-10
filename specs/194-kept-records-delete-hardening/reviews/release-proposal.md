# Release proposal: spec 194 (kept-records delete hardening)

Release-coordinator, 2026-11-09. Read from: the spec (including Backend design, Implementation notes and Files changed), all four reviewer files in this directory, and `supabase/tests/kept_records_delete_hardening.test.sql` L339-346 plus `src/lib/db.ts` L1896-1909 to check two reviewer claims. Advisory only. The spec's `Status:` was not changed.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical or High, all 33 local ACs pass, and all three CI gates are green at HEAD 15aefc4. The open items are two wording edits in the db.ts hunk, two pre-apply checks the architect asked for (a fresh-database replay and a stricter D-11 prod check), and the owner-gated prod steps AC-34 to AC-36. None of them changes runtime behaviour.

Gate facts (checked by main Claude on 2026-11-09, at HEAD `15aefc4`, the spec 186 commit):
- `test.yml`: success, https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/42750558373
- `db-migrations-applied.yml`: success, https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/42750558466
- `e2e.yml`: success, https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/42750558580
- Dependency met: spec 186's migration is committed, and the local file md5 `3a9076d7aaeab0c34fb8c0dedbef0094` matches the prod body md5 recorded in spec 186. That covers architect M-4.
- `npm run typecheck`'s 24 TS2688 errors come from duplicate `node_modules/@types/* 2` folders that were there before this spec. CI installs from scratch and does not see them. They do not count against 194.

## Findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix, 7 Nits.
  - S-1: the C-3 arm (test L340-346) compares two string literals, so that half can never fail. I checked the code, and the claim is accurate. I rate it lower than Should-fix, though. The same arm also requires both triggers to exist under those exact names, so renaming either one still fails the arm, and the firing order follows from the names. The literal comparison adds nothing, but the arm does not falsely pass. `cross_store_item_rejection` T09 pins the order by behaviour.
  - S-2: when `delCount < oldIds.length`, the warning in `upsertVendorDraftOrder` (db.ts L1906) says "refused or raced". That does not mention the case where another tab or session already removed the lines.
  - The Nits are style or preference: the `AC25-*` labels clash with AC-25, long policy comment literals, no "why" next to the P0001 errcode, a hardcoded English error string, the test's module-level `terminal`, the `warnSpy` coupling, and an orphan-header delete whose result is ignored (out of scope).
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 4 Low.
  - Rolled-back local probes show that no staff route reaches the D-2 server-context exemption: not through PostgREST role switching, SECURITY DEFINER RPCs, edge functions, server writers, legacy GUCs or the upsert path.
  - Low-1: `purchase_orders.status` can be set to NULL. This does not reopen M2, because NULL to draft is refused and NULL counts as not a draft. It is an edit-class issue.
  - Low-2: one list of the residuals the owner accepted or left out of scope, including unlocked `waste_log.store_id` and `pos_imports.store_id`.
  - Low-3: no pgTAP arm covers the upsert shape. The probe shows the triggers do fire on it.
  - Low-4: a just-demoted admin keeps date-change rights until the JWT expires. That is the project-wide posture.
  - Client hunks are clean: no PII in logs, and the client is not used as a security gate.
- **test-engineer:** AC-1 to AC-33 PASS, 0 FAIL, 0 NOT TESTED. AC-34 to AC-36 are PENDING because they are prod steps that need the owner. Results:
  - pgTAP file: 103 assertions. Full pgTAP: 100/100 files.
  - Full jest: 301 suites, 3835 tests. `typecheck:test` passes.
  - The AC-33 mutation results come from the developer's record and were not re-run.
  - Gaps, none blocking: the spec 138 replace-lines RPC is deferred, and the Fill-cart race is tested only at the jest level with a mocked count.
- **backend-architect (post-impl):** 0 Critical, no contract drift, 2 Should-fix, 5 Minor.
  - S-1: no fresh-database replay yet. The migration was applied with `psql -f` to a running stack, and the version row was inserted by hand.
  - S-2: D-11's prod verification is weaker than the test's own catalog arms. It skips `tgargs` on the three date triggers, which share one function, and does not compare policy and comment md5s.
  - M-1: two `upsertVendorDraftOrder` comments are stale. M-2: the draft-on-draft race now returns `null`, which should be written down. M-3: reserved slots for 188 and 195 sort before 194 but do not overlap with it. M-4: confirm spec 186's md5 (already done, see above). M-5: insert the `schema_migrations` row inside the apply transaction.

## Recommended next steps (ordered)

Severity first, then dependency. No item is Critical. Each item is tagged with when it must happen.

### Before commit (edits in files 194 already changes)

1. **[Should-fix, code-reviewer S-2 + architect M-1] Fix the wording in the `upsertVendorDraftOrder` hunk** (`src/lib/db.ts` ~L1805-1806, ~L1889-1890, L1906). This goes first because the hunk is about to be committed out of a `db.ts` that other sessions are also editing. A later wording-only commit would mean picking hunks out of that file a second time.
   - Change the warning to say "refused, raced, or lines already removed", or note the ambiguity in the comment.
   - Update the doc comment's "Returns null on …" list to include the short-delete case.
   - Limit "the next Fill cart collapses" to "while the PO is still a draft".
   - Then run the full `npx jest`, per project memory, in case any test pins the old warning text. Also run `npm run typecheck:test`.
2. **[Minor, architect M-2] Add one sentence to the spec's Implementation notes.** Two Fill carts on the same still-draft PO now give `null` and the "Draft not created" toast, where before the second returned silently. This is louder but recoverable, and intended. Spec text only.
3. **[Downgraded to Nit, code-reviewer S-1] C-3 arm: optional, cheap, best done now** since it touches only 194's new test file.
   - Either derive the order from `pg_trigger`, for example `select min(tgname collate "C")` over the two rows equals `po_items_check_store_trg`, or rename the label to "both triggers exist (order fixed by name; behavioural pin is cross_store_item_rejection T09)".
   - The arm does not falsely pass today, because the names are pinned. Skipping this does not block ship.
   - The `AC25-*` → `PGBYPASS-*` label nit can go in the same edit.
   - If either change is made, re-run `bash scripts/test-db.sh supabase/tests/kept_records_delete_hardening.test.sql`.
4. **Staging hygiene (procedural, required).** Stage only 194's files:
   - the migration
   - the new pgTAP file
   - the two new jest files
   - the spec 194 hunks of `src/lib/db.upsertVendorDraftOrder.test.ts` (check that its diff holds no other session's work)
   - the spec file and this reviews directory
   - **only** the `deletePoItem` and `upsertVendorDraftOrder` hunks of `src/lib/db.ts`, via `git add -p`.

   Leave every other dirty or staged path out, including other sessions' already-staged files such as `20261109140000_po_number_sequence.sql`. Per project memory, stage and report. Do not run `git commit` until the owner says to.

### Before prod apply (verification and runbook; no code change)

5. **[Should-fix, architect S-1] Prove the migrations replay on a fresh database, or have the owner record that CI is the first proof.**
   - Run `npx supabase@<version test.yml pins> db reset`, then the full `bash scripts/test-db.sh`, and record the result in the spec.
   - Two cautions:
     - (a) The local stack is shared with other sessions. A reset wipes their local data and also replays their uncommitted migrations on disk. That is the joint 187/189/190/194 proof the architect wants, but it is not the same tree as the 194-only commit. Coordinate before resetting.
     - (b) AC-35 has prod applied **before** the push, so if the owner picks "CI is the first proof", CI's fresh build runs after prod already has the migration. The rollback SQL in the Implementation notes covers that case.
   - Either way, write the choice down in the spec.
6. **[Should-fix, architect S-2 + M-5] Amend D-11 before the owner's go-ahead.**
   - Step 0: just before applying, re-check that prod's three spec 186 policy comment md5s equal `19b31c66…`, `3e6fcbcc…` and `27bd32e4…`, so the rollback restores matching text.
   - Step 4: run the test file's C-2 query verbatim on prod, including `tgargs` and the bound function, and expect the same 6-row string as local. Also run C-1a, C-1b, C-4 and C-5. Compare md5s of all five policy comments against local. Keep the normalized-md5, owner and `proacl` checks for the four functions.
   - Put the `schema_migrations` insert for `20261109170000` before the migration's final `commit;` in the text sent to MCP.
   - Only the spec text changes, and the owner should see it before giving the go-ahead.

### Owner-gated (each step needs an explicit go-ahead)

7. **AC-34:** read-only prod pre-check through the Supabase MCP. It covers: POs by status, which also shows any NULL status for Low-1; `po_items` under non-draft POs; NULL dates; triggers and UPDATE/DELETE policies on the five tables compared with local; and that none of the four function names exists yet. Anything unexpected goes to the owner before applying.
8. **AC-35:** apply the migration body verbatim through MCP with the version row in the same transaction (item 6), then run the strengthened D-11 step 4 verification.
9. **Commit**, using item 4's staging, **then push**, only after the owner says to.
10. **AC-36:** after the push, confirm that the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand. If any is red or still running, show the run URL and wait for the owner.

### Deferred follow-ups (not blocking 194; candidates for separate specs)

- **Security Low-1: `purchase_orders.status NOT NULL`.** First check prod for NULLs (AC-34 shows this), then add the constraint. This fits best in the "freeze lines on non-draft POs" follow-up.
- **Spec 138 single-statement replace-lines RPC** (`select … for update`, check for draft, then replace). This is the real fix for the Fill-cart race in D-5. The test-engineer's live-concurrency gap closes with it.
- **Freeze kept rows against edits:** line edits on non-draft POs (`ordered_qty`, `received_qty`, `item_id`), `po_items` INSERT onto non-draft POs, `qty_sold`, and locking `waste_log.store_id` and `pos_imports.store_id` (security Low-2).
- **Security Low-3:** a pgTAP upsert-shape arm (`on conflict (id) do update set <col> = excluded.<col>`) for each guard. The probe already shows the triggers fire on it. This is regression insurance against a later trigger refactor. It could also be added to 194's test file before commit if the developer wants, and nothing depends on it.
- **TRUNCATE revoke** on the five tables (spec 186 audit L4).
- **Pin inserted dates to `now()`** (future-dated inserts). The security auditor notes this is now weaker: it only lets a member delete rows they invented.
- **Low-4 JWT staleness after demotion.** A project-wide posture, not specific to 194.
- **Owner housekeeping:** remove the `node_modules/@types/* 2` duplicate folders so that local `npm run typecheck` is meaningful again.
- **Code-reviewer nits not taken in item 3:** split the long policy comment literals, add a "why" next to P0001, the i18n of the thrown string (when the admin UI is localised), the shape of the test's `terminal`, the `warnSpy` coupling, and the ignored orphan-header delete result.
- **Architect M-3:** no action. Slots 188 (`20261109000000`) and 195 (`20261109160000`) will sort before 194 in prod's history. The drift gate and MCP apply both tolerate that, and neither overlaps with 194.

## Out of scope for this review
- **Audit M3:** `staff_submit_eod` with an empty payload erases a kept EOD count. Belongs with draft spec 189.
- **Audit M4:** `deleteStore` partial failure removes today's waste rows and staff grants.
- **Privileged two-step delete** (re-date, then delete inside 1 day). Accepted by the owner and pinned by AC-5. The privileged store and brand cascade deletes are unchanged since spec 186.
- **Spec 186's 1-day window length** (audit L3 suggests 1 hour). That is spec 186's call.
- **Direct `brands` delete by super_admin** (audit L5).
- **A UI for deleting kept records or correcting dates.**
