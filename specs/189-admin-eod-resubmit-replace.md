# Spec 189: Admin EOD re-submit replaces the old entries

Status: READY_FOR_REVIEW

Origin: a bug reproduced on 2026-11-08 through the real Cmd UI on the local stack, with read-only checks on prod. The full reproduction is in `admin-eod-resubmit-repro.md`, session notes `local_0a6faf4e-0fd8-4bf7-892f-47aeb351d71f`. Its figures are cited here, not re-derived, because the product manager has no prod access. Code facts were read from the working tree on 2026-11-08, and line numbers are pointers.

**Owner acceptance:** the owner accepted all five defaults (D-1 to D-5) on 2026-11-08, replying "All defaults OK", as relayed by the main session.

**O-1 approved by owner 2026-11-09** (design §10: `staff_submit_eod` refuses an empty payload, plus AC-34), as relayed by the main session. O-2 (a `p_date` bound) is not in scope.

**Urgency:** latent, fix before the path is used. It is not an incident. Prod has 0 duplicates, but only because nobody has used this admin path for at least 89 days. That isn't evidence the path works.

## User story

As a **store admin or owner correcting an EOD count**, I want a re-submitted count to replace the earlier one, so that the locked screen, variance, reorder and low-stock all report the count I last entered, once.

## The bug

`submitEODCount` ([db.ts L1054-1062](../src/lib/db.ts)) deletes a submission's entries, then inserts the new set. `eod_entries` has no DELETE policy, so under RLS the delete removes 0 rows. PostgREST returns 204, so `del.error` is empty, the insert stacks on the old rows, and the user sees a success toast.

### Measured (local stack, real UI)

| Route | Result |
|---|---|
| EDIT: Restaurant Depot, 2 items, counted 6 and 8, then changed to 18 and 20 | Network shows `DELETE` 204, `POST` 201, toast "Count submitted, 2 items", no console warning. DB holds **4 entries** (6, 8, 18, 20). `current_stock` is correctly 18 and 20. Parent id unchanged |
| After reload | Locked screen shows **the old values**. EDIT on the same screen loads the new values. Day tile reads **4/143**, not 2/143 |
| Draft then submit, no EDIT: Costco, draft of 1 item, then all 6 | **7 entries for 6 items**. Status moved draft to submitted |

### Measured (server readers, rolled-back transaction under the admin JWT)

Scenario: first count 20, corrected to 1, par 5 and 4. Control is the same data with the stale rows cleared.

| Reader | With duplicates | Control |
|---|---|---|
| `report_run_variance` | counted 21, net +$58.60 | counted 1, net -$47.95. **The sign flips** |
| `report_reorder_list` | 4 rows per item, suggested qty 14 for the two items | 1 row per item, suggested 7. RPC output only, **not checked on screen** |
| `report_weekly_lowstock` | on_hand 20 | on_hand 1. `low_stock` was false both ways in this fixture |
| `items_last_counted` | Unaffected | |

### Measured (prod, read-only, 2026-11-08)

- No DELETE policy on `eod_entries` or `eod_submissions`, same as local.
- 225 submissions, all `submitted`. 3,378 entries. **0 duplicate groups.**
- 0 `Count updated` and 0 `Remaining count submitted` audit rows. The oldest audit row is 2026-08-11, which is where the "at least 89 days" comes from.

### Read from code, not run

- **Client readers.** Some double-count, some take the first row and some the last, and the embed has no ORDER BY. The evidence file lists each with line numbers.
- **Phone.** `PhoneEodCount` calls the same `model.onSubmit`.

### Inferred, not run

- **Admin EDIT over a staff submission.** Same upsert and same denied DELETE.

### Why nothing caught it

- [db.eodNoNeed.test.ts](../src/lib/db.eodNoNeed.test.ts) mocks the delete as a success.
- [eod_submissions_edit_flow.test.sql](../supabase/tests/eod_submissions_edit_flow.test.sql) L161-169 already says the DELETE is denied, then tests UPDATE instead.

## Requirements

- **R1. Exact replace.** After any admin re-submit (EDIT, draft then submit, admin over a staff submission), the submission holds exactly the new entries, with no duplicates, and items left out of the new set are gone. D-4 defines what "the new set" must contain.
- **R2. All-or-nothing.** The parent update, the entries and the server's on-hand writes land together or not at all. A failure part-way can't lose the old count or leave a partial set. D-5 records one existing write that sits outside this.
- **R3. Honest failure.** A denied or failed write takes the existing error path, never the success toast.
- **R4. No DELETE or ALL policy** on `eod_entries` or `eod_submissions`. Spec 186 AC-8 forbids it. [Spec 178](178-order-approvals-fk-set-null.md) gives the reason: a DELETE policy would let an API caller clear `order_approvals.source_submission_id`.
- **R5. Everything else stays.** Same screens and toasts, the spec 149/180 notifications, the spec 102 on-hand rule, spec 172 NO NEED handling. Staff behaviour doesn't change.
- **R6. Comment corrections** (table below).

No data repair is needed on prod as of 2026-11-08, because there are 0 duplicate groups. The check must be re-run before applying (AC-32).

## Decisions (owner-settled, 2026-11-08)

### D-1. Unique index on `eod_entries (submission_id, item_id)` (settled: default accepted)
**Recommended: add it.**
- **For:** any future stacking fails loudly instead of silently, which is the failure this spec is fixing. Prod has 0 duplicates, so no dedupe pass is needed. The "prod dedupe pass" in the [`report_last_order_context` comment](../supabase/migrations/20260803000000_report_last_order_context.sql) (L265-269) is no longer required. `seed.sql` has no `eod_entries` rows, so it can't break a reset.
- **Why now:** old tabs and installed native builds keep running the delete-then-insert sequence until they update. Without the index they keep stacking after this fix ships. With it, their re-submit fails with the error toast.
- **Spec 185:** compatible with each mechanism its N1 lists, since one item is in exactly one area per submission. It would also back up 185's AC-19.
- **Costs:**
  - The D1/D2 fixtures in `report_last_order_context.test.sql` (L331-340, L624-643) insert duplicates on purpose and must change.
  - The other 8 pgTAP files that insert entries must be checked for a repeated pair.
  - A repeated item in a `staff_submit_eod` payload would now fail the whole call. The staff client should build one entry per item, but this wasn't traced through its offline queue, so the architect confirms it.

### D-2. Harden readers against duplicates? (settled: default accepted)
**Recommended: no, given D-1.** Prod has none, and the writer fix plus the index means none can appear. The affected readers are spread across three report functions and about 15 client locations (listed in the evidence file), and hardening them means choosing which row is right for each. If the owner declines D-1, this should be reopened, because old clients could then still stack.

### D-3. Ordering with spec 185 (settled: default accepted)
**Recommended: this spec lands before 185.** [185](185-front-back-inventories.md) relies on this path: L35 describes the admin delete as working, L37 and N1 repeat it, and AC-12 to AC-14 require "both paths". AC-14 can't pass on the admin path until this is fixed. A one-line correction to 185 is the owner's call and isn't part of this spec.

### D-4. What must a re-submit contain? (raised by the product manager; settled: default accepted)
**Today's duplicates hide a second bug, and a working replace would expose it.** `buildSubmission` ships only `filteredItems.filter(localHasEntry)` ([EODCountSection.tsx L885](../src/screens/cmd/sections/EODCountSection.tsx)), which often isn't the whole count. Read from code, not run:

| Situation | What the payload holds | Today | After a plain replace |
|---|---|---|---|
| EDIT with a category pill selected (L683) | Only that category | Other categories' rows stay | **Those counts are deleted, with a success toast** |
| Count one category, then EDIT and count the next | Only the second | Both present, correct by accident | **The first category is lost** |
| Draft, reload, count the rest, submit. Drafted rows don't refill after a reload, but still pass the completeness gate (L130-137, L1000) | Only what was typed after the reload | Both present | **Drafted counts are lost** |
| EDIT, after a reload, a submission holding an off-vendor item. `additionalItems` is session-only (L333) | Omits that item, though EDIT seeded its value | Row stays | **That count is lost** |

**Recommended: a re-submit never removes a count the manager didn't clear.**
- The payload covers the whole vendor's count for that date, whatever the pill.
- A row the manager blanked on screen is cleared. A row they never touched is not.
- No new UI, and the completeness gate stays as it is.
- One small visible change: a first SUBMIT under a pill also ships values typed under other pills, which today are discarded on success (L1038).

The alternative is to accept pill-scoped replacement as written, which the product manager advises against.

### D-5. Writes that fire before the server write (raised by the product manager; settled: default accepted)
`useStore.submitEOD` runs before `submitEODCount` (EODCountSection L960, L1028). It fires `adjustItemStock` ([useStore.ts L3243](../src/store/useStore.ts)), the audit rows (L3264) and `broadcast_notification` (L3298), whatever the server write then does. So after a failed write, `current_stock` and the audit log can show the new count while the entries still hold the old one. It's existing behaviour, read from code, not run.

**Recommended: leave it in this spec and name it as a follow-up.** R5 says on-hand behaviour stays, and the failure toast already says the cloud save failed. This does limit R2: "all-or-nothing" covers the server write, not these client writes. The design says plainly what happens to them (AC-30). If the chosen option makes `adjustItemStock` redundant, the architect may propose removing it.

## Acceptance criteria

Each AC is tagged with its track, per [tests/README.md](../tests/README.md). pgTAP fixtures are hermetic. Every arm claiming a row survived or was removed reads it back as `postgres`, so an RLS-hidden row can't pass by accident.

### Re-submit routes
- [ ] **AC-1:** EDIT: submit 2 items as 6 and 8, re-submit as 18 and 20. Exactly 2 entries remain, holding 18 and 20. (pgTAP)
- [ ] **AC-2:** Draft then submit: draft 1 item, submit 6. Exactly 6 entries for 6 distinct items, status `submitted`. (pgTAP)
- [ ] **AC-3:** Admin over staff: a store-member JWT submits through `staff_submit_eod`, then an admin re-submits. Exactly the admin's entries remain, and `client_uuid` is unchanged. Replaying the staff's original `client_uuid` returns `conflict: true` and leaves the admin's entries alone. (pgTAP)
- [ ] **AC-4:** Left-out item: re-submit 3 items as 2. The third entry is gone, and its `current_stock` and `eod_remaining` keep their previous values. (pgTAP)
- [ ] **AC-5:** `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each`, `notes` and `no_need` match the payload on every row. (pgTAP)
- [ ] **AC-6:** `eod_submissions.id` is preserved on all three routes, with one row per (store, date, vendor). A linked `order_approvals` row keeps its `source_submission_id`. (pgTAP)
- [ ] **AC-7:** `submitted_by` equals the caller's `auth.uid()`, forced by `eod_submissions_set_submitted_by_trg`, even when the client sends another id. (pgTAP)

### On-hand (unchanged)
- [ ] **AC-8:** A numeric entry linked to the vendor through `item_vendors`, primary or not, sets `current_stock` and `eod_remaining` to the total, and `last_updated_by` to the caller. (pgTAP)
- [ ] **AC-9:** Off-vendor escape hatch: the entry is stored and the on-hand is untouched. (pgTAP)
- [ ] **AC-10:** A NO NEED entry stores null numerics and writes no on-hand. A non-NO-NEED entry with a null total also writes no on-hand. **`staff_submit_eod` doesn't have this second guard today:** its update checks only `no_need` (L262-270), while `db.ts` L1137 uses `isNumericEodEntry`, so reusing its body needs care. (pgTAP)

### All-or-nothing and refusals
- [ ] **AC-11:** A re-submit whose last entry fails (a NO NEED row with a quantity, raising 23514) leaves everything as it was: entries, parent `status` and `submitted_at`, and on-hand, checked row by row. No new notification row. (pgTAP)
- [ ] **AC-12:** A cross-store item raises 42501 and leaves the same state as AC-11. (pgTAP)
- [ ] **AC-13:** A non-privileged store member (role `user`) calling the admin write is refused, with nothing changed. (pgTAP)
- [ ] **AC-14:** A privileged caller who can't see the store is refused, with nothing changed. (pgTAP)
- [ ] **AC-15:** The design states the gate. Any new function revokes EXECUTE from `public, anon`, grants it to `authenticated` (spec 097), and is SECURITY DEFINER with a pinned `search_path`. (pgTAP catalog arm)
- [ ] **AC-16:** `pg_policies` shows no `DELETE` or `ALL` policy on `eod_entries` or `eod_submissions`. A direct `delete from eod_entries` under an admin JWT removes 0 rows, read back as `postgres`. (pgTAP)

### Readers report the new count once
Each arm re-submits through the real writer (first count 20, corrected to 1) and compares against a control submitted once.
- [ ] **AC-17:** `report_run_variance` shows counted 1, and the same net as the control. (pgTAP)
- [ ] **AC-18:** `report_reorder_list` shows one row per item, with `suggested_qty`, `item_count` and the estimate matching the control. (pgTAP)
- [ ] **AC-19:** `report_weekly_lowstock` shows on_hand 1. (pgTAP)
- [ ] **AC-20:** After a re-submit and a reload, the locked screen shows the new values, and EDIT seeds the same values. The day tile counts each item once. (jest, manual in AC-28)

### Client
- [ ] **AC-21:** The mock in `db.eodNoNeed.test.ts` no longer treats a direct `eod_entries` delete as success. A test fails if `submitEODCount` issues one. The existing arms keep their meaning, moved to wherever the write now happens: `no_need` on every row, null numerics on NO NEED, no on-hand for NO NEED. (jest)
- [ ] **AC-22:** A rejected write shows the existing `savedLocally` / `cloudFailed` toast, no success toast and no jump to Ordering. Typed values and EDIT mode stay. Covers both SUBMIT and SAVE DRAFT. (jest)
- [ ] **AC-23:** After a re-submit that drops an item, `eodSubmissions` holds exactly the new entries without a reload, matching what a reload returns. Today `submitEOD` merges old and new ([useStore.ts L3172-3177](../src/store/useStore.ts)), so a dropped item would linger on screen. (jest)
- [ ] **AC-24:** The admin audit feed stays as it is: one `EOD entry` row per submitted entry on a re-submit, with `Count updated` wording, and `Remaining count submitted` on a first submit. No second row per entry. Staff audit rows are unchanged. (jest, plus pgTAP if the server writes them)
- [ ] **AC-25 (D-4):** EDIT then UPDATE COUNT with no changes, with any category pill selected, and after a reload for a submission holding an off-vendor item, leaves the same items and values. Blanking a row and updating removes only that row. Draft, reload, count the rest and submit keeps the drafted rows. (jest)

### Notifications
- [ ] **AC-26:** Through the real writer: a first submit gives one `eod` or `order_ready` row, an edit gives one `eod_update`, draft to submitted gives one fresh row, and a draft save gives none. (pgTAP, alongside `eod_update_notifications.test.sql`)

### If D-1 is accepted
- [ ] **AC-27:** A second row for the same `(submission_id, item_id)` raises 23505, through both the table and the writer. A re-submit still succeeds. The D1/D2 arms are rewritten with the reason stated, not deleted. (pgTAP)

### Manual
- [ ] **AC-28:** Browser pass on the local stack, recorded in the review notes:
  1. Repeat the EDIT reproduction: 2 entries in the DB, new values on the locked screen after a reload, day tile counts 2.
  2. Repeat the draft reproduction: 6 entries for 6 items.
  3. EDIT over a staff submission. This route has never been run.
  4. Repeat step 1 at phone width. This has never been run either.
  5. EDIT with a category pill selected: other categories survive.
  6. Force a failed write: error toast, old count intact after a reload.
  7. Open the reorder list and confirm the on-screen quantity, which the reproduction didn't check. (manual)
- [ ] **AC-29:** Every row of the comment table below is done, or the design says why not. (manual, at code review)
- [ ] **AC-30:** The design states what happens to `adjustItemStock`, the audit rows and `broadcast_notification` when the server write fails, following D-5. (manual, at design review)

### Gates and rollout
- [ ] **AC-31:** `scripts/test-db.sh`, full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass. `permissive_policy_lint`, `public_grants_explicit` and the staff suites (`staff_submit_eod_cases_each`, `eod_no_need`, `staff_role_eod_rls`, `eod_submissions_multi_vendor`, `eod_update_notifications`) pass, unmodified unless the design says why. (jest, pgTAP)
- [ ] **AC-32:** The design includes a prod runbook for project `ebwnovzzkwhsdxkpyjka`, run only on the owner's go-ahead. It re-runs this check first, expecting 0 rows, and **stops and asks the owner** if any return: (manual)
  ```sql
  select submission_id, item_id, count(*)
    from public.eod_entries
   where submission_id is not null
     and item_id is not null
   group by submission_id, item_id
  having count(*) > 1;
  ```
  The `where` filter was added on 2026-11-09 (architect N2). It matches the migration's pre-flight and the unique index, which keeps NULLs distinct, so a NULL group can't block the migration and isn't a stop condition.
  The migration goes on prod before the push, with its version inserted into `schema_migrations`. New functions are verified by normalized md5, `prosecdef`, `proconfig` and ACL. After the push, `test.yml` and `db-migrations-applied.yml` are confirmed green on `main`, and `e2e.yml` is checked by hand. The runbook states a rollback.

## Comment corrections

| Where | What's wrong | Should say |
|---|---|---|
| [20260514120030](../supabase/migrations/20260514120030_eod_submissions_consistency.sql) L55-61, L183-191 | "the frontend never DELETEs" | `submitEODCount` did delete entries, and that delete was silently denied |
| `report_last_order_context` body, L254-269 | "Last-written wins, matching what the EOD screen itself shows". The locked screen shows the first row. Also "needs a prod dedupe pass" | Corrected for what the screen shows and the current duplicate count |
| `report_last_order_context.test.sql` L331 | Duplicates are "legal" | Depends on D-1 |
| `db.ts` L1018-1019 (added by the product manager) | "items removed from the edit screen disappear cleanly" | Replaced along with the code |
| `db.ts` L1026-1027 (added by the product manager) | The RPC is "gated to service_role". Stale since spec 061 | Replaced along with the code |
| `eod_submissions_edit_flow.test.sql` L10-11, L17-19 (added by the product manager) | Says the same as `db.ts` L1026-1027, and describes a delete and reinsert the test doesn't do | Corrected |

**How, for applied migrations:** the `report_last_order_context` comment is inside a function body. Editing that file in place would make a rebuilt local function differ from prod's, which the normalized-md5 check could flag, so that correction should go forward, through `comment on function` in the new migration. Re-creating the function just for a comment isn't required. The 20260514120030 comments are outside any function body. Spec 186 treats comments in applied migrations as history, so the architect chooses between a forward note and an in-place edit, and states which.

## In scope
- One atomic admin write for parent, entries and on-hand, used by SUBMIT, UPDATE COUNT and SAVE DRAFT on desktop and phone.
- The payload and local-store changes D-4 needs.
- pgTAP, jest and manual coverage above, and the comment corrections.
- The unique index, if D-1 is accepted.

## Out of scope (explicitly)
- **A DELETE or ALL policy on either table.** R4.
- **Data repair.** Prod has none to repair. AC-32 re-checks.
- **Reader hardening,** unless D-2 changes.
- **Spec 185's area work, or editing spec 185.** D-3.
- **Refilling inputs from a saved draft after a reload.** It's new UI. Related and also left alone: drafting every item, reloading and pressing SUBMIT gets "enter at least one" (read from code).
- **Moving the staff subtree into `db.ts`.** The staff path changes only if the chosen design shares a body with it.
- **Forcing old tabs or native builds to update.** See D-1.
- **Customer PWA, `app.json` slug, EAS or push config.** Not touched.

## Open questions resolved
- Q: Which app? → A: The admin Cmd UI in this repo. Staff is touched only as a route (AC-3) and possibly as a shared writer.
- Q: Should this be treated as an incident? → A: No. Latent: 0 duplicates on prod, and the path is unused for at least 89 days.
- Q: Can a privileged-only gate lock out someone who uses the Cmd UI today? → A: No, read from code. Any role other than `user` reaches the Cmd UI ([LoginScreen.tsx L78](../src/screens/LoginScreen.tsx)), and the only other roles are `super_admin`, `admin` and `master` (`profiles_role_check`, [20260509000000 L164](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)). `auth_is_privileged()` should admit those three, though it reads the JWT rather than `profiles`, so the architect confirms this.

## Confirm in one pass (owner)

Settled on 2026-11-08: the owner replied "All defaults OK", as relayed by the main session. That covers this list:
1. **D-1** Add the unique index, so duplicates fail loudly from now on. The test fixtures that insert duplicates on purpose change, and old tabs get an error on re-submit until they reload.
2. **D-2** Don't harden the readers. The writer fix plus the index is enough.
3. **D-3** Land this before spec 185. Whether to correct 185's wording now is your call.
4. **D-4** A re-submit never removes a count the manager didn't clear, even with a category pill selected. **This is the one that matters most.**
5. **D-5** Leave the on-hand, audit and bell writes that fire before the server write as they are, and name them as a follow-up.

## Notes for architect (options, not a design)

The mechanism is yours. These are starting points.

| Option | For | Against |
|---|---|---|
| **A.** Reuse `staff_submit_eod` from the admin path | Already definer, atomic and granted to `authenticated`, and `staff_submit_eod` under the admin JWT cleared a stacked submission to 2 entries in a rolled-back test. One writer, so spec 185 changes one path, and the third copy of the on-hand predicate goes away | **Can't meet AC-13 as written,** because staff must keep calling it. Its gate is `auth_can_see_store` alone, wider than today's admin UPDATE posture. Doubles audit rows unless `useStore.submitEOD` or the RPC changes. Doesn't set `last_updated_by`. Lacks the AC-10 null-total guard. The name misleads |
| **B.** New admin SECURITY DEFINER RPC mirroring it | Clean audit and gate | A second copy of the logic that spec 185 must also change |
| **C.** Delete-only definer RPC, keeping the client sequence | Smallest | **Fails R2.** Parent, delete and insert stay separate requests, so a failure can lose the old count |
| UPDATE-only diffing | | **Out.** It can't remove items |

**Recommendation: B's gate over A's single body.** A new admin entry point checks `auth_is_privileged() and auth_can_see_store()`, which matches today's admin re-submit posture, then calls one internal writer that `staff_submit_eod` also calls.
- That meets AC-13, leaves one body for spec 185, and gives somewhere to switch off the server audit row so AC-24 holds.
- **Cost:** it refactors `staff_submit_eod`, so the staff suites in AC-31 are the guard.
- If that refactor looks too risky, plain B is second, and spec 185 inherits two copies.
- Plain A needs the owner to drop AC-13. It adds no new power, since a staff user can already re-submit through it.

Other notes:
- **N1. A per-item on-hand failure now rolls back.** `db.ts` L1152-1156 logs and carries on; inside one transaction it would roll everything back. That's what R2 asks for, but the design should say so.
- **N2. Readers to re-check for D-4:** `deriveCountedItemIds` treats drafts as counted (L130-137), which is why the gate passes on blank rows after a reload.
- **N3. The "third copy" comment** at useStore.ts L3196 goes stale if the copies change.
- **N4. Migration slot.** After the newest in `supabase/migrations/` at build time. Spec 186's design reserves `20261108120000`, and specs 187 and 188 are also pending.

## Risks
- **A working replace can delete counts.** D-4 and AC-25 are the guard. Without them, this fix trades visible duplicates for silent loss.
- **Old clients.** Tabs and native builds keep the old sequence until they update. Low exposure, since the path is unused on prod. D-1 turns stacking into an error.
- **Staff path regression,** if the body is shared. AC-31 is the guard.
- **Prod and repo drift.** The migration must be on prod before the push, or `db-migrations-applied.yml` goes red.

## Dependencies
- Must land before spec 185 (D-3).
- Spec 186 AC-8 and spec 178 (R4). A replace is a deliberate delete, so it doesn't conflict with spec 186's "keep" rule, which covers age-based deletion.
- Spec 020 (EDIT flow, consistency triggers), spec 061 (RPC under per-user JWT), spec 102 (on-hand rule), spec 172 (NO NEED), specs 149 and 180 (notifications).
- Spec 097 (grants), spec 053 (permissive-policy lint), spec 064 (migration gate).

## Project-specific notes
- **Cmd UI section / legacy:** `src/screens/cmd/sections/EODCountSection.tsx`, with `eod/PhoneEodCount.tsx` through the shared model. No legacy surface.
- **Which app:** admin, in this repo. The staff EOD subtree is touched only if the design shares the writer. The customer PWA isn't involved.
- **Per-store or admin-global:** per store, under `auth_can_see_store()`.
- **Edge function or PostgREST:** a Postgres RPC called through `src/lib/db.ts`, if the design follows the options above. No edge function.
- **Realtime channels touched:** `store-{id}`, for the existing `eod_submissions`, `eod_entries` and `inventory_items` changes. No publication change is expected, so the `docker restart supabase_realtime_imr-inventory` step doesn't apply. It would if the design changes publication membership.
- **Migrations needed:** yes, for the writer, plus the index under D-1.
- **Edge functions touched:** none.
- **Web/native scope:** both (shared code). Browser verification at desktop and phone widths only. No native Simulator pass. Installed native builds keep the old behaviour until replaced.
- **`app.json` slug:** not touched.
- **Test tracks:** pgTAP (writer, gate, policies, readers, notifications, index), jest (client write route, failure path, store state, payload), manual (browser pass, reviews, runbook). No shell smoke is needed.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD. The owner accepted D-1 to D-5 on 2026-11-08, so don't reopen them. The choice among the writer options is yours.
payload_paths:
  - specs/189-admin-eod-resubmit-replace.md

## Backend design

Read from code on 2026-11-08 unless marked otherwise. Nothing here was run: this design pass had no database or shell access. D-1 to D-5 are treated as settled. Signatures and pseudocode are the contract, and the developer authors the SQL and TypeScript.

### 0. Decisions in one place

| Question | Decision |
|---|---|
| Writer | New gate `admin_submit_eod`, plus one internal writer `eod_write_submission` that `staff_submit_eod` also calls. The spec's recommendation holds (§2) |
| Server contract | **A set of changed rows plus an explicit removal list**, not a full replacement set. A row the call doesn't name is left exactly as it is (§4) |
| Client payload | Only rows that differ from what the manager was shown, across the whole vendor, whatever the pill (§5) |
| Empty payload | `admin_submit_eod` refuses it, and refuses any call that would leave the submission with no entries (§3.4) |
| Admin date bound | Not needed (§3.4) |
| `staff_submit_eod` empty refusal | **Optional part O-1, recommend include.** Owner hasn't decided. The build can include or skip it (§10) |
| `staff_submit_eod` date bound | **Recommend defer** (§10) |
| `adjustItemStock` in `submitEOD` | Removed. The audit rows and `broadcast_notification` stay as D-5 says (§8) |
| Migration | `supabase/migrations/20261109120000_admin_eod_replace.sql` (§1) |

### 1. Data model and migration

**Slot.** The newest file on disk is `20261108130000` (spec 187, uncommitted), `20261108120000` is spec 186 (uncommitted), and spec 188's design reserves `20261109000000`. This takes `20261109120000`. Re-check at build time: it must sort after the newest file then, and the prod `schema_migrations` insert must use the final version. No part of it depends on 186, 187 or 188 landing first, or in any order.

**Contents, in one transaction**, with `set local lock_timeout = '5s'`, in this order:

1. **Pre-flight.** A `do` block raises with a readable message if any `(submission_id, item_id)` pair repeats. `create unique index` would fail anyway. This just names the problem and the runbook step.
2. **Index.** `create unique index if not exists eod_entries_submission_item_uidx on public.eod_entries (submission_id, item_id)`. Additive. It takes a brief SHARE lock on about 3,400 rows, and can't be `concurrently` inside a transaction or through MCP. `item_id` is nullable and NULLs stay distinct, which changes nothing in practice: no writer sends a null item, and the FK has no `set null` action. `idx_eod_entries_submission_id` becomes redundant, but dropping it is out of scope.
3. **`public.eod_write_submission`** (§2).
4. **`create or replace public.staff_submit_eod`,** same signature, so its ACL carries over (§2).
5. **`public.admin_submit_eod`** (§3).
6. **Grants and comments** (§9).

No table or column changes, and no policy changes. Rollback is in §13.

### 2. The writer

**Is the refactor worth it? Yes.** The spec's recommendation was checked, not assumed.

- `20261024000000` L103-316 is the latest `staff_submit_eod`. Nothing newer replaces it.
- A second copy has a real cost that's already visible. The on-hand logic has drifted between `db.ts` L1138 and the RPC (AC-10), and each change to the RPC has meant copying the whole body "verbatim with hunks". Spec 185 AC-12 to AC-20 would have to change two bodies.
- The refactor's risk is bounded. The public signature doesn't change, steps 5 to 7 move across unedited apart from the hunks below, and five staff suites, `audit_log_rls_hardening` W-1, `inventory_items_identity_lock` T22, the smoke script and e2e all exercise it. A rollback restores one known body.

**Internal writer (contract):**

```
public.eod_write_submission(
  p_store_id uuid, p_date date, p_vendor_id uuid, p_status text,
  p_entries jsonb,
  p_client_uuid uuid,         -- staff: the attempt uuid. admin: NULL
  p_removed_item_ids uuid[],  -- NULL: replace the whole set (staff). Array: targeted (admin)
  p_audit_actor text,         -- NULL: no per-entry audit row (admin, the client writes it)
  p_on_hand_actor uuid        -- NULL: leave last_updated_by alone (staff). admin: auth.uid()
) returns jsonb               -- { submission_id, conflict: false, entry_ids, stock_updates }
language plpgsql  SECURITY INVOKER  set search_path = public
```

Order inside it, which is load-bearing (§6):

1. Upsert the parent on `(store_id, date, vendor_id)`, setting `status`, `submitted_at`, and `client_uuid = coalesce(existing, excluded)`. The notification triggers fire here.
2. Remove rows. If `p_removed_item_ids` is NULL, delete all of the submission's entries. Otherwise delete the rows named there, writing one server audit row per deleted row (§8), then delete the rows named in `p_entries`.
3. Loop over `p_entries`: insert, on-hand, optional audit, `stock_updates`, the same as today's step 7.

Delete-then-insert stays, rather than `on conflict do update`, so a payload repeating an item raises 23505 instead of silently taking the last one (AC-27).

**`staff_submit_eod` keeps** steps 1, 1.5, 3 and 4 (vendor check, store gate, actor, idempotency), then returns the writer's result, passing `p_removed_item_ids => NULL`, `p_audit_actor => v_actor`, `p_on_hand_actor => NULL`. The envelope is byte-identical.

**Why the writer is SECURITY INVOKER, not DEFINER.** It runs as the owner when called from either definer wrapper, so it behaves identically. The difference shows only if its grant ever regresses. Spec 097's default privileges (`20260618000000` L205-206) give every new function `ALL` for `anon`, `authenticated` and `service_role` until someone revokes it, so a missed revoke is a realistic failure. A gateless definer writer would then be a store-wide write and delete hole. An invoker writer would run under the caller's RLS: its delete removes 0 rows and its insert hits the unique index. `eod_update_push_suppressed` (`20261027000000` L192) is the precedent. **AC-15 needs a wording change** (§12).

**Lockout.** `revoke all ... from public, anon, authenticated, service_role`. Only `postgres` keeps EXECUTE, and that's the role both wrappers run as. `public_grants_explicit.test.sql` covers tables only (its header says so), so the new pgTAP file must assert this with `has_function_privilege` for all three roles, plus `prosecdef = false` and `proconfig`.

### 3. `admin_submit_eod`

```
public.admin_submit_eod(
  p_store_id uuid, p_date date, p_vendor_id uuid, p_status text,
  p_entries jsonb,            -- same element keys as staff, minus unit
  p_removed_item_ids uuid[]
) returns jsonb               -- writer envelope + { entry_count }
language plpgsql  SECURITY DEFINER  set search_path = public
EXECUTE: authenticated only (revoked from public, anon, service_role)
```

Called by PostgREST RPC through `db.ts`. An RPC, not a table write, because R2 needs one transaction. No edge function, and `verify_jwt` doesn't apply.

**3.1 Refusals, in this order, all before any write:**

| Check | SQLSTATE |
|---|---|
| `not (auth_is_privileged() and auth_can_see_store(p_store_id))` | 42501 |
| `p_vendor_id` null, or `p_status` not `draft` / `submitted` | 22023 |
| Vendor isn't in the store's brand | 42501 |
| Empty call (§3.4 Rule A), or a removal that removes nothing (§3.4 Rule C) | 22023 |
| An item in both `p_entries` and `p_removed_item_ids` | 22023 |

The vendor check is new. The direct path had the FK only, and `emit_eod_update` already had to guard against a foreign vendor (spec 180 review, Low 3). It's one `exists` query on the admin path only.

**3.2 The gate, confirming the spec's open question.** `auth_is_privileged()` is `auth_is_admin() or auth_is_super_admin()` (`20260509000000` L235-239, body unchanged since). `auth_is_admin` reads JWT `app_metadata.role` for `admin` / `master`, and `auth_is_super_admin` reads `profiles.role`. So all three roles pass, **but `admin` and `master` depend on the token**. `profiles_sync_role_to_jwt` keeps metadata in step, and an existing session keeps its old claims until refresh. Today a first submit needs only the store-member INSERT policy, so **this gate is narrower than today for the first submit**. It matches today's re-submit posture (`admin_update_eod_submissions`). An admin whose metadata has drifted would lose first-submit access, so the runbook checks for that (§14).

**3.3 Failure behaviour.** The whole call is one transaction, so any raise undoes the parent, entries, on-hand, audit, notification rows and queued push (`enqueue_submission_push` goes through a table insert, and rolls back with it).

**3.4 Empty payloads (spec 186 security audit, M3).**

M3 checks out against the function body: with `'[]'`, the parent upsert resets `submitted_at` (L193), the delete clears every entry (L201), and the audit insert (L286) sits inside a loop that never runs. `jsonb_to_recordset(NULL)` also yields no rows, so a SQL NULL behaves the same. The probe itself wasn't re-run.

Under §4's contract, an empty `p_entries` can't erase anything by itself, but the admin function still has to refuse the erase in any form:

- **Rule A, no empty call.** `p_entries` NULL, not a JSON array, or empty, **and** `p_removed_item_ids` NULL or empty, raises 22023. Nothing changes, including `submitted_at`. A blank-only correction (empty `p_entries`, one removal) is legal, because AC-25 needs it.
- **Rule B, never leave zero entries.** After the writer returns, if the submission holds no entries, raise 22023 and roll everything back. This closes the other route to the same erase, which is naming every row in the removal list.

Rule B is why a first submit with only a removal list fails too: it would create an empty parent.

- **Rule C, no removal that removes nothing (added 2026-11-09, post-review: security L1, architect N3; being built in parallel).** `admin_submit_eod` raises 22023 **before any write** when:
  - `p_removed_item_ids` contains a NULL element, whatever else the call holds; or
  - `p_entries` is empty **and** none of the removal list's ids has a row in the submission, so the removals would touch 0 rows. This includes a call against a submission that doesn't exist yet.

  Without it, `'{NULL}'` or a list of absent ids passes Rules A and B. It then bumps `submitted_at`, can flip `status`, and fires an `eod_update` and a push while changing no entry. Rule C makes Rule A's "nothing changes, including `submitted_at`" hold strictly. It joins the §3.1 refusals, so the "all before any write" rule still holds.

  **The blank-only correction stays legal:** an empty `p_entries` with at least one removal that names a row present in the submission passes Rule C. Rule B still applies after it.

  A call with entries and only absent removal ids isn't refused, because the entries change rows. AC-33 gains arms for `'{NULL}'` and for a removal of an absent id.

  **Client consequence.** A stale baseline that names a row a colleague already deleted, with nothing else changed, now gets 22023. That goes through the existing failure path (§8): the failure toast, the local revert, and inputs, EDIT mode and baseline kept. A reload clears it. The design doesn't require a client re-check.

**Date bound on the admin function: not needed.** The admin UI is meant to correct past days. A bound wouldn't reduce a privileged caller's power either, because `admin_update_eod_entries` and `admin_update_eod_submissions` already let that caller rewrite values and `submitted_at` at any age. What is new is removing a row by name, and §8's server audit row covers that, even for a direct API call. Rules A and B stop the wholesale erase.

### 4. Set plus removal list, and why

A full replacement set makes the client responsible for knowing every row on the server, and it can't reliably know. `eod_entries` isn't in the realtime publication, a reload can lag, drafted rows don't refill after a reload, `additionalItems` is session-only, and a second person may have saved since. Any row the client failed to include gets deleted, with a success toast. That's the failure D-4 exists to prevent.

With a removal list, **deleting a row takes a positive statement that names it**, so a client with stale state can only fail to touch rows. D-4's rule becomes structural: "a re-submit never removes a count the manager didn't clear" holds even when the client is wrong.

Sending only changed rows matters for the same reason. If EDIT re-shipped every seeded row, a stale seed would silently overwrite a colleague's newer value on a row this manager never touched. It would also:

- re-write on-hand for untouched rows, undoing a later waste log or a later count of a shared item under another vendor;
- turn a legacy null-total row into a false 0, because `db.ts` L1212 reads null as 0, `unitsDisplayFor` seeds "0", and re-shipping writes on-hand 0;
- recompute totals if `caseQty` or the count mode changed since the count.

Each of those breaks AC-25's "same items and values" on the row itself.

**Contradiction flagged, not worked around.** D-4 says "the payload covers the whole vendor's count". This design meets that in the **result**, not on the wire. It doesn't reopen D-4: the owner's rule and AC-25 are met, and more strongly than a full set would meet them. R1, AC-3 and AC-4 are worded for a full replacement and need the changes in §12.

**Staff stays full-replace,** because its screen seeds every row and the gate requires every row (`EODCount.tsx` L811, L837). So a staff re-submit from a stale screen can still overwrite an admin's edit, and deletes an admin's off-vendor row. That's today's behaviour, kept under R5.

### 5. D-4 on the client

**New pure helper,** `src/lib/eodChangeSet.ts`, exported for jest:

```ts
export function buildEodChangeSet(args: {
  storeItems: ReadonlyArray<{ id: string; caseQty?: number | null }>;  // store-scoped; unknown ids are skipped
  baseline: Record<string, EodRowSnapshot> | undefined;
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  notes: Record<string, string>;
  noNeed: Record<string, boolean>;
  modeOf: (itemId: string) => EodCountMode;
}): { changedItemIds: string[]; removedItemIds: string[] };

type EodRowSnapshot = { caseRaw: string; unitRaw: string; note: string; noNeed: boolean };
```

**The baseline is how "blanked" differs from "never touched".** It records what the manager was shown and what is known to be saved.

- A `useRef` keyed `${storeId}|${dateIso}|${vendorId}`, because the input maps are keyed by vendor only.
- **Set by `onEditCurrentVendor`** from `sub.entries`, using the same string derivations as the seed. It must snapshot the entry-derived values, not the merged map.
- **Advanced by a successful SAVE DRAFT:** shipped rows go in, removed rows come out.
- **Cleared by a successful SUBMIT,** along with the maps. **Left alone on failure,** so a retry computes the same diff.
- **Cleared for every date whenever a vendor's maps are cleared (amended 2026-11-09, code-reviewer S1).** `finishSubmitted`, and any other path that clears a vendor's maps, deletes every baseline key ending `|${vendorId}`, not only the current date's key. Without this, a baseline left over from another date reads that date's rows as "blanked", and they get removed with a success toast. Clearing fails safe: with no baseline, rows can only stay.

**Rule per item,** over the union of the vendor's map keys and baseline keys. This never reads `filteredItems`, so pills don't matter:

```
item not in storeItems                        -> skip (store-scoped; also drops another store's ids)
baseline has the row, and current == baseline -> skip (server row stays exactly as it is)
row has a value (eodRowEntryValues non-null)  -> changed
baseline has the row, row is blank, no NO NEED,
  and the baseline row showed a count under
  the current mode                            -> removed
otherwise                                     -> skip
```

"Blank" means every enabled box trims to empty. An enabled box holding unparseable text isn't blank.

**Removal guard (amended 2026-11-09; the developer proposed it and the post-impl review accepted it).** A removal fires only if the baseline row showed a count under the item's **current** mode: a value in a box the live mode enables, or NO NEED. Without the guard, a row whose saved value sits only in a box the mode has since disabled reads as "blank, baseline present", and the server would delete a count the manager never saw on screen. That breaks D-4. With the guard, that row is skipped and the server row stays.

**Named follow-up (code-reviewer S2): a note-only edit on such a row is lost.** The row is neither "has a value" (its enabled boxes are blank) nor a removal, so the note doesn't ship. If it's the only change, `planEodSubmit` returns no-op and the success toast shows. Reaching it takes a count-mode change after the count, then a note-only edit. The proposed fix is a skipped-rows signal, a `skippedItemIds` return plus a warning toast, or a server carry that keeps the stored numerics. It needs its own spec or the owner's call, and doesn't block this one.

**One small seed fix.** `onEditCurrentVendor` currently lets any local key beat the seed (L628), including a leftover `''`. That would show a saved value as blank and read as "blanked". Only non-blank local values may win over the seed, for cases, units and notes.

**Each case:**

| Case | Baseline | Sent | Result |
|---|---|---|---|
| EDIT under a pill, nothing changed | All saved rows | No RPC (below) | Same items and values |
| EDIT under a pill, change one row | All saved rows | That row | Other categories stay |
| Count one category, EDIT, count the next | First category's rows | The new rows | Both present |
| First SUBMIT under a pill, values typed under other pills | None | Everything typed for this vendor | The D-4 visible change |
| Draft, reload, count the rest, submit | None. Drafts have no EDIT and no refill | What was typed after the reload | Drafted rows stay. Typing over one replaces it |
| Draft, then blank a row in the same session, then save or submit | Set by the draft save | Removal of that row | Row gone |
| EDIT after reload, off-vendor item in the submission | Includes it, from `sub.entries` | Nothing for it | Row stays. The row isn't on screen, so it can't be blanked. + COUNT brings it back, with its seeded value |
| Shared item counted only under another vendor's tab | No key and no baseline here | Nothing | Not part of this submission (spec 102). The gate still passes through `countedItemIds` |
| EDIT, blank a row | Includes it | Removal | Only that row goes. The gate passes (N2), because `hasEntry` still sees the saved row |
| Blank a row with no saved entry | No | Nothing | Nothing to do |
| Legacy null-total row, untouched | "0" | Nothing | Stays null, and on-hand isn't written. Today it becomes 0 |
| Row whose saved value sits in a box the mode has since disabled | The stored strings | Nothing, because the removal guard skips it | Stays. If the enabled box is typed into, the row ships under the live mode. A note-only edit is dropped (named follow-up above) |
| NO NEED untouched / toggled off with blank boxes | noNeed true | Nothing / removal | Stays / cleared |
| Failed write, then retry | Unchanged | The same diff | Correct, which relies on §8's local revert |

**Two people on the same vendor:**

| Situation | Result |
|---|---|
| A changes X, B changes Y | Both survive, in either order |
| B adds or re-counts a row after A opened EDIT, and A doesn't touch it | A's save doesn't mention it, so it stays |
| Both change X | Last write wins, as today. No compare-and-swap |
| A blanks X, B changed X after A loaded | A's removal wins, because A saw a value and cleared it. The server audit row records A's clear, with the value removed |

Two calls can't interleave. Every writer's first statement upserts the parent, which holds that row's lock until commit, so calls on one submission run one after the other, and a later call sees the earlier one's rows.

**When the set is empty.** Rule A forbids an empty call, so `buildSubmission` decides first:

| Change set | Situation | Client does |
|---|---|---|
| Empty | No baseline | Existing "enter at least one" toast. Keeps the behaviour the spec leaves alone: draft everything, reload, press SUBMIT |
| Empty | Baseline, status unchanged | **No RPC, no optimistic writes, no audit, no bell.** Then the normal success path: same toast using the saved row count, relock, jump to Ordering |
| Empty | Baseline, status changes (same-session draft to SUBMIT, or EDIT to SAVE DRAFT) | Ships the baseline rows, to carry the status change |
| Would remove every baseline row and ship nothing | | Existing "enter at least one" toast, as today |

The status-change row is the one place unchanged rows ship. It reproduces today's behaviour, in a window of one person's session. Its edge is EDIT, SAVE DRAFT, then SUBMIT with no changes on a legacy or mode-changed row: that row re-ships with recomputed values, as it does today.

**Phone needs no change.** It writes through the same maps (`model.setCaseCounts`, `setUnitCounts`, `setNotes`, `toggleNoNeed`), and `onSubmit` and `onEditCurrentVendor` come from the shared model. A diff taken at submit time sees all of it, which is why a per-keystroke "touched" set was rejected: it would need hooks on all those setters.

**Pre-existing bug found, not fixed: counts can leak across dates.** The input maps and `editingVendorIds` are keyed by vendor only, and `setSelectedIso` resets neither. So values seeded or typed for Monday show on Tuesday's worksheet, inputs unlocked, and SUBMIT writes them to Tuesday. Read from code, not run. This design doesn't make the removal path worse, because the baseline is keyed by date, so no removal can fire across dates. It can still overwrite, and dropping the pill filter means a leftover under another pill now ships too. Listed for the owner (§15).

**Correction, 2026-11-09 (code-reviewer S1).** The claim above was wrong as first built. A date-keyed baseline outlived the vendor-keyed maps: SAVE DRAFT on Monday, SUBMIT on Tuesday, then back to Monday found Monday's baseline over empty maps, so the drafted rows were removed. The every-date baseline clear (baseline bullets above) closes that path. **One residual stays:** blank a leaked Monday value on Tuesday's worksheet without submitting, then go back to Monday and submit, and that blank turns into a Monday removal. It takes a deliberate blank on the wrong date. It belongs to spec 192 (date-keyed maps), which removes the root cause.

### 6. Behaviour differences, resolved

| Item | Staff path | Admin path | Note |
|---|---|---|---|
| Per-entry audit rows | Server, `user_id` NULL | Client, `submitEOD` unchanged. `p_audit_actor` NULL | No second row (AC-24) |
| `last_updated_by` | Left alone, as today | `auth.uid()`, not a client-sent id | AC-8 applies to the admin path. The caller has a `profiles` row, or the FK raises 23503 and the call rolls back |
| Null-total on-hand guard | **Gains it** | Has it | One predicate in one writer: `not no_need and actual_remaining is not null`, also gating `stock_updates`. No staff client can build that payload (`eodRowEntryValues`; `isValidEodEntry` rejects it on hydrate), so it changes only a direct API call that today would set `current_stock` to NULL. **This is the one staff behaviour change outside O-1.** No suite pins the old behaviour |
| `client_uuid` | Attempt uuid, idempotency check | **Passes NULL, no idempotency check** | `coalesce(existing, excluded)` leaves a staff uuid untouched, and a staff replay still returns `conflict: true` before any write (AC-3). A staff submit after an admin first submit still records its uuid, as today |
| Retry on the admin path | | Safe to repeat | Re-applying the same changes gives the same result, and removals become no-ops. It costs one more `eod_update` |
| `submitted_by` | Trigger | Trigger | `eod_submissions_set_submitted_by_trg` fires on both the INSERT and the conflict UPDATE, and `auth.uid()` reads the session's JWT claims inside definer code. The admin function has no such parameter, so a client can't send one |
| `submitted_at` | Server `now()` | **Server `now()`,** was the client clock | Better for late detection. In pgTAP `now()` is constant per transaction, so AC-11's fixture must seed an old literal `submitted_at`, or "unchanged" can't fail |
| Per-item on-hand failure (N1) | Rolls back | **Now rolls back,** was logged and skipped | What R2 asks for. Under definer there's no RLS denial left to skip. What remains is a real data error, and it surfaces as the error toast |
| Item order | Ascending `item_id` (`EODCount.tsx` L168) | `db.ts` sorts by item id | So admin and staff take `inventory_items` row locks in the same order on shared items. A deadlock (40P01) would just fail one call with the error toast, but there's no reason to invite it |

### 7. Triggers

**Notifications (AC-26).** Neither trigger changes. The writer's upsert must keep naming both `status` and `submitted_at`, because `notify_eod_resubmission` is `after update of status, submitted_at` (`20261027000000` L378-381). Results:

| Route | Row |
|---|---|
| First submit | One `eod` or `order_ready` |
| Edit | One `eod_update` |
| Draft to submitted | One fresh row |
| Draft save | None |
| EDIT with no changes | **None, because there's no RPC.** Today gives one `eod_update`. Wording change in §12 |

**Order relative to on-hand.** `eod_vendor_has_below_par` reads `current_stock` at trigger time, and depends on that being the pre-count value (`20260801000200` L61-72). The writer upserts the parent before any on-hand write, so the staff order is unchanged. **The admin path becomes consistent with it.** Today `submitEOD` fires `adjustItemStock` before the upsert, so whether `order_ready` sees pre-count or post-count stock on an admin submit is a race. Removing that call (§8) settles it to pre-count, which can change the `eod` versus `order_ready` choice on some admin first submits. AC-26 allows either type. Don't move the on-hand write ahead of the upsert to "improve" this.

**`eod_entries_check_store_trg`.** It's SECURITY INVOKER, so under the definer call it runs as `postgres`, and owner bypass means RLS hides nothing from its two lookups. It still refuses, because it compares the item's `store_id` with the parent's: a mismatch or a missing item raises 42501, and the whole call rolls back (AC-12). `removed_item_ids` can't reach another store, because the delete is scoped to this submission.

### 8. Client failure path (AC-22, AC-23, AC-30)

**`adjustItemStock` is removed from `submitEOD`,** as D-5 permits. Once the server write is atomic it's redundant on success (the RPC writes the same values, plus `last_updated_by`). On failure it's harmful, since it leaves on-hand changed while entries stay old, which is exactly the divergence the readers can't survive. It also races the upsert (§7). `db.adjustItemStock` itself stays, because `adjustStock` uses it (L2651).

**`submitEOD` returns an undo:**

```ts
submitEOD: (
  submission: Omit<EODSubmission, 'id'>,
  opts?: { removedItemIds?: readonly string[] },
) => () => void;
```

Undo restores the `eodSubmissions` row, found by `(storeId, date, vendorId)` (or removes it if it was new), plus `currentStock`, `eodRemaining`, `lastUpdatedBy` and `lastUpdatedAt` on the items it mirrored. The merge also drops `removedItemIds`, so the slice matches the server without a reload (AC-23).

**The revert is required, not tidying.** Today a failed first SUBMIT leaves a local `submitted` row. Press EDIT and the baseline would be built from values the server never saw, so the diff would report nothing changed, and the "no RPC" path would show success with nothing saved. It also fixes today's failed first submit locking the vendor.

| When the RPC rejects | What happens |
|---|---|
| Entries, parent, on-hand, notifications | Unchanged on the server (R2) |
| Local `eodSubmissions` and on-hand mirror | Reverted |
| Typed values, EDIT mode, baseline | Kept (AC-22) |
| Toast | Existing `savedLocally` / `cloudFailed`, no success toast, no jump to Ordering. Not `notifyBackendError`, as AC-22 names this toast. Both SUBMIT and SAVE DRAFT |
| Client audit rows (`Count updated` / `Remaining count submitted`) | **Still written, D-5.** They can describe a count that didn't land |
| `broadcast_notification` | **Still sent, D-5.** Same issue |

**Named follow-up (D-5):** move those two after the server's answer, or into the server write.

**Rows cleared get a server audit row.** A real delete is new on this path, and the audit log would be its only trace. So the writer's targeted branch writes one `EOD entry` row per deleted row: `user_id = auth.uid()`, `detail = 'Count cleared · vendor: <name>'`, `item_ref` the item name, `value` the removed value or `NO NEED`. It's inside the transaction and doesn't depend on the client, and it isn't a second row for any shipped entry. **This is an addition to AC-24's feed, made by the architect.** It can be struck without affecting anything else. The ` · vendor: ` suffix keeps existing parsers working.

**Abort after commit.** If `useInflight` aborts a request the server then commits, the user sees the failure toast and the local revert, and the realtime reload then shows the saved count. Retrying is safe.

### 9. RLS, grants and comments

**RLS:** no policy changes. No DELETE or ALL policy on `eod_entries` or `eod_submissions` (R4, spec 186 AC-8), and the `permissive_policy_lint` is unaffected. `store_member_insert_*` and `admin_update_*` stay, because old clients and spec 172's arm (20) use them. Removing those direct write paths is a possible follow-up. The delete happens only inside the definer path, against entries, so `order_approvals.source_submission_id` can't be cleared (AC-6).

**Grants:** as in §2 and §3. Note that spec 097's default privileges mean these revokes are required, not belts.

**Comment corrections (AC-29).**

| Where | Action |
|---|---|
| `20260514120030` L55-61, L183-191 | **Forward note, file left alone.** `comment on table public.eod_entries` in the new migration states that `submitEODCount` did issue a delete, RLS silently denied it (0 rows, 204), and writes now go through the definer writers. Matches spec 186's treatment of applied migrations |
| `report_last_order_context` body L254-269 | **Forward, no re-create.** `comment on function` re-states the existing comment (L349) and adds: the body's "legal duplicates", "matches the EOD screen" and "dedupe pass" notes are superseded by the unique index, and the locked screen showed the first row. Spec's reason holds: editing the body would change the normalized md5 |
| `report_last_order_context.test.sql` L331 | Rewritten (§11) |
| `db.ts` L1015-1031 | Replaced with the code |
| `eod_submissions_edit_flow.test.sql` L10-11, L17-19 | Corrected. **Also L162-165,** which says the RPC runs as service_role |
| `useStore.ts` L3194-3196, L3203, L3214-3215 ("third copy") | Rewritten (N3) |
| **Added:** `e2e/staff-reorder.spec.ts` L292 | "no natural unique key" is now false. The fixture itself still works (it pre-deletes as service role) |
| **Added:** `EODCountSection.tsx` L678-681, L738-743, L881-884, L990 | These describe `filteredItems` as what ships |
| **Added:** `README.md` L224 | Add `admin_submit_eod` to the RPC table |

### 10. `staff_submit_eod`: optional part O-1 (owner decides)

This isn't in the accepted defaults. **READY_FOR_BUILD doesn't depend on it.** The build includes it if the owner says yes, and otherwise skips it with no other change.

**O-1. Refuse an empty payload. Recommendation: include.**

- **What it closes:** the erase with no audit row at all, whether from a direct API call or a client bug. There's also a real client route. `migrateQueueIfNeeded` (`eodQueue.ts` L229-231) filters malformed v1 elements, so it can produce `entries: []`, and `isValidQueuedSubmission` accepts that because `every` on an empty array is true. A drain would then call the RPC with `[]`.
- **What it doesn't close:** a direct API caller can send one entry and erase the rest. Only O-2 addresses that. This is a partial fix, and the owner should know that.
- **What it takes:** one check in the staff wrapper, **after** step 4 so a replay of a processed uuid still returns `conflict: true`, and before the writer. NULL, non-array and empty all raise 22023. It lives in the wrapper because the admin rule differs.
- **The real cost isn't nearly free.** `eod_update_notifications.test.sql` calls `staff_submit_eod` with `'[]'` at 5 sites (L221, L234, L285, L305, L685), so that suite must change, with AC-31 saying why. Use any Frederick item with no link to the test vendor: no on-hand write, so the suite's deterministic `eod` branch holds, but it adds an audit row per call. The other seven callers' files have no `'[]'`. Plus 2 new arms.
- **Staff clients:** no change needed. `EODCount.tsx` L858 blocks empty before `submit`, so normal queued items are never empty. A refused drain gets 22023, which `useEodSubmit` L197-204 treats as "other error": attempts bump, the item stays, and the queue moves on, until the 30-day GC. The stuck item is visible, and nothing is erased.

**O-2. Bound `p_date`. Recommendation: defer, as a separate decision.** Traced through the queue:

- Queued items replay late. GC is 30 days (`eodQueue.ts` L43), the count date can already be yesterday when queued, an item with an unparseable `queued_at` is kept forever (L129), and GC runs only on hydrate. So a bound under about 32 days refuses legitimate unsynced work.
- The error code matters. `42501` makes `useEodSubmit` L176-179 **dequeue the item,** which loses the staff member's count. Any bound must use another code, and then the item retries until GC.
- It must sit after the idempotency check, and exempt privileged callers, as the auditor suggests.
- **Fixture cost is wide.** The staff suites use dates like `1999-11-02`, `1999-12-20`, `1999-12-27` and `1999-12-29` as store members, so most would need rework.
- At 32 days or more it still leaves any count in that window open. It deserves its own small spec, with the owner choosing the window.

### 11. Unique index and old clients

**Ordering.** The migration reaches prod before the push (AC-32). From then until each tab reloads, old clients run delete (0 rows), then insert:

- **First submit:** works.
- **Re-submit of any existing pair:** 23505, the error toast, no stacking. That's D-1 doing its job. The old client's parent upsert has already committed by then, so `status` and `submitted_at` move and a notification fires, while entries stay old. `adjustItemStock` also fired. Exposure is low because the path is unused on prod, and it's the same class of residual D-5 accepts. Spec 181's native build is unpushed, and any installed native build behaves like an old tab.
- **23505 on the new RPC:** only a payload repeating an item, which `buildEodChangeSet` can't produce. It surfaces as the error toast and rolls back. No special mapping.

**Staff payloads can't repeat an item. Confirmed by tracing, so D-1's open cost closes:**

1. `fetchItemsForVendor` reads `item_vendors` for one vendor, and `item_vendors_item_vendor_unique (item_id, vendor_id)` gives one row per item (`EODCount.tsx` L161-168).
2. `setItems` stores that list mapped 1:1 (L688-692), with no other source (L670, L702 clear it).
3. `entries` is `items.map(...)` filtered (L837-857), so 1:1.
4. `useEodSubmit` `entriesForRpc` maps 1:1, and queued items carry `entries` verbatim.
5. The v1 migration maps 1:1 (`eodQueue.ts` L229-231), from a builder over a list with the same property.

Only a hand-built API call can repeat an item, and it now raises 23505.

**pgTAP files inserting into `eod_entries`:**

| File | Repeats a pair? |
|---|---|
| `report_last_order_context` L335-340 (D1/D2) | **Yes. Must change** |
| The same file, L313-329 | No, every pair is distinct |
| `eod_no_need` | No. Arms (6) to (8) throw, (9) is the only `scratch_sub` / `item_t` row, and L463, L605, L648, L702, L714 are distinct |
| `eod_submissions_edit_flow` | No. One row, then an UPDATE |
| `eod_submissions_consistency` | No. L138 throws, L154 is one row |
| `report_run_variance_formula`, `report_run_variance_multivendor_sum` | No. Same item across different submissions |
| `report_reorder_list_on_hand_source`, `items_last_counted`, `ingredient_changed_badge` | No |
| `retention_prune_job` L170 (spec 186, uncommitted) | No. **A ninth file the spec's "8 others" didn't count** |

**D1/D2 rewrite.** The fixture inserts only the 9 row. D1 stays "one items[] element" and D2 stays "counted_qty_base 9", with a comment stating why duplicates can't exist now. Add (D3): `throws_ok` 23505 on inserting the 3 row, and raise `plan()` by one. Dropping the index in the test to keep a real duplicate was rejected: `DISTINCT ON` remains as harmless defence, and pinning a state that can't occur has no value.

**Fixtures and local reset.** `seed.sql` has no `eod_entries` or `eod_submissions` text at all. Every `insert into ... eod_entries` in `supabase/migrations/` is inside a function body, so a reset applies the index to an empty table, then seeds. `scripts/` has only a read (`smoke-staff-eod.sh` L423) and single-item payloads. e2e's one direct insert is a single row after a pre-delete.

So **a reset can't break.** Frederick's 24 local rows don't come from seed or migrations, and I couldn't query them. They'd be from use of a non-reset stack.

**The real local risk is a non-reset database.** `npm run dev:db` is `supabase start`, and `scripts/test-db.sh` runs `psql` against whatever's running. Applying the migration over a stack with stacked rows (any EDIT on the current client creates them, and the repro did, though its notes say those were removed) hits the pre-flight error. The fix is `npx supabase db reset`, or clearing the duplicates. The review notes should record this for anyone switching branches.

### 12. AC and requirement wording changes

The spec's own text above is left as written, apart from `Status:` and the AC-32 query's NULL filter (architect N2, 2026-11-09). Apply these wordings when testing.

| Item | Change |
|---|---|
| R1 | "items named as cleared are gone, and anything the call doesn't name stays" |
| D-4, first bullet | "the **result** covers the whole vendor's count, whatever the pill" |
| AC-3 | "The staff rows remain, with the admin's changes applied and cleared rows gone". The `client_uuid` and replay parts stand |
| AC-4 | "Re-submit naming the third item in the removal list: it's gone, and its on-hand keeps its value." **Add:** a third item **not** named stays, untouched |
| AC-7 | The admin function has no id parameter. Assert `submitted_by = auth.uid()`, and keep the "client sends another id" arm for `p_submitted_by` on staff |
| AC-8 | `last_updated_by` applies to the admin path. On staff, assert it's unchanged |
| AC-15 | Entry point: SECURITY DEFINER, EXECUTE for `authenticated` only. Internal writer: SECURITY INVOKER, EXECUTE for none of `anon`, `authenticated`, `service_role`. Both pin `search_path` |
| AC-21 | Client arms move to the RPC args (`no_need` on every row, null numerics on NO NEED). On-hand arms move to pgTAP |
| AC-24 | "one row per **shipped** entry", plus one server `Count cleared` row per cleared row |
| AC-25 | Add: no RPC is issued on the no-change route |
| AC-26 | Add: EDIT with no changes produces no row |
| AC-31 | `eod_update_notifications` changes only if O-1 is included. `report_last_order_context`, `eod_submissions_edit_flow` (comments only), `useStore.submitEOD.noNeed.spec172` (adjustItemStock arms, L95-115, L144, L164-165) and `db.eodNoNeed` all change, for reasons given here |
| **New AC-33** | `admin_submit_eod` with an empty payload and no removals raises 22023 on a 200-day-old submission: entries and `submitted_at` unchanged, read back as `postgres`. NULL too. Naming every row in the removal list raises 22023 with the same result. A blank-only correction succeeds and removes only that row. **Added 2026-11-09 (§3.4 Rule C):** `'{NULL}'`, and an empty `p_entries` whose removals name only ids absent from the submission, each raise 22023 with entries, `status` and `submitted_at` unchanged and no notification row. (pgTAP) |
| **New AC-34, only with O-1** | `staff_submit_eod` with `'[]'` and with NULL raises 22023, state unchanged. A replay of a processed uuid with `'[]'` still returns `conflict: true`. (pgTAP) |

### 13. `src/lib/db.ts`, store and tests

```ts
export async function submitEODCount(
  submission: Omit<EODSubmission, 'id'>,
  removedItemIds: readonly string[] = [],
): Promise<{ submissionId: string; entryCount: number }>;
```

Same name and `track(..., { kind: 'write' })`. It calls `supabase.rpc('admin_submit_eod', ...)`, sorted by item id, and sends the mapping `db.ts` L1072-1080 uses today, with `item_id` renamed to `ingredient_id`. It logs with `console.warn` and rethrows. No direct `eod_entries` or `inventory_items` access remains, and callers already ignore the return. The camelCase mapping is `submission_id` to `submissionId`, `entry_count` to `entryCount`. The section keeps importing it directly, as today.

**Realtime.** `store-{id}`, through the existing `eod_submissions` and `inventory_items` subscriptions. **No publication change, so `docker restart supabase_realtime_imr-inventory` doesn't apply.** Atomicity also helps here: today a parent event can trigger a reload before entries exist.

**Performance.** About 143 rows at most, two statements each on the admin path, with both indexes in place. A vendor-sized payload should sit well inside PostgREST's statement timeout. Not measured. No edge function, so no cold start.

**Tests.**

- New `supabase/tests/admin_submit_eod.test.sql`: AC-1 to AC-19, AC-26, AC-27, AC-33, and AC-34 if O-1 is in. Read every "survived or removed" claim back as `postgres`.
- New `src/lib/eodChangeSet.test.ts`: every row of the §5 tables.
- `useStore`: undo, removal merge, no `adjustItemStock`.
- Section tests for specs 171 and 172: `submitEODSpy` returns undefined, so the mock needs to return an undo, and any exact-args assertion picks up the second parameter.

**Rollback.** Keep the order: web first, then database. (Section amended 2026-11-09, architect S2 items (a) to (d).)

1. Revert the client on Vercel. A new client without the RPC gets an error on every submit.
2. **Forward migration, in this order.** plpgsql records no dependency on the writer, so the staff body must be replaced before the writer is dropped.
   - `create or replace public.staff_submit_eod` with the body from `20261024000000_eod_entries_no_need.sql` L103-316.
   - **(a) Restore its comment too.** It sits outside the body range, at `20261024000000` **L1001-1002** (`comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is 'spec 172: …'`). Copy it verbatim. 189's migration replaced it at L394.
   - `drop function public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])`.
   - `drop function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)`.
   - Rewrite `comment on table public.eod_entries`. 189's comment says writes go through the two definer writers, which stops being true. The `report_last_order_context` comment can stay while the index stays.
3. **Keep the index** unless it's the problem. Without it, the old client's stacking bug returns silently.

**(b) If spec 193 has landed** (`20261109190000_staff_eod_date_bound.sql`, provisional; not on disk as of 2026-11-09). 193 re-replaces `staff_submit_eod` on top of 189's wrapper. Restoring the `20261024000000` body as-is **silently drops 193's date bound**, and its comment. Pick one before writing the rollback:
   - **Default: fold 193's check into the restored body.** Put it after step 4 (idempotency) and before step 5, the position that matches 193's "after step 4, before the writer" in the pre-189 shape. Keep 193's SQLSTATE and message. The restored body is then not verbatim `20261024000000`, so the prod verify compares md5 against the **rollback migration's own body**, not `20261024000000`. The restored comment should name both spec 172 and spec 193.
   - **Or roll 193 back first,** with its own §10 forward migration, then roll 189 back as written. This loses the date bound. The owner decides that, not the developer.
   - **193 also adds an audit row (R9, added 2026-11-09 at spec 193's request).** In `eod_write_submission`'s staff branch (`p_removed_item_ids is null`), 193 turns the full-replace delete into a `delete … returning` → `audit_log` CTE. It writes one `Count cleared` row per erased item that isn't re-sent. Dropping `eod_write_submission` and restoring the pre-189 staff body **silently drops that audit too**, not just the date bound. On the default branch, fold the same CTE into the restored staff body's delete as well; on the other branch, it goes with 193's own rollback. Spec 193 §11 sets out the options. The choice is the owner's.

**(c) A rollback isn't "back to working".** With the client reverted and the index kept, after the rollback:
   - **Every admin re-submit of an existing pair fails with 23505.** The old client deletes 0 rows and then inserts. The parent upsert has already committed by then, so `status` and `submitted_at` move and a notification fires, while the entries stay old (§11). A first submit still works. In effect, **admin count correction is unavailable until a forward fix.**
   - **O-1 reverts.** `staff_submit_eod` accepts `'[]'` and NULL again, which brings back the erase with no audit row (spec 186 M3).
   - **The staff null-total guard reverts** (§6). A direct API call can set `current_stock` to NULL again.
   - Rows already cleared can't be restored from the database, but `Count cleared` audit rows record their values.

**(d) Same-PR obligations.**
   - Delete `supabase/tests/admin_submit_eod.test.sql` in the same PR, or `test.yml` goes red. Also revert the O-1 fixture swap in `eod_update_notifications.test.sql`, or keep it: one-entry payloads still pass without O-1. Check the other 189-touched pgTAP files (`report_last_order_context` D3, `eod_submissions_edit_flow` comments) against the kept index. D3 still holds while the index stays.
   - The rollback migration gets **its own new version**, sorting after the newest file on disk when it's written. Never reuse or edit `20261109120000`. On prod, apply it through MCP plus its exact `schema_migrations` insert, before the push, as in §14.

Don't drop the RPC while any installed client still calls it.

### 14. Prod runbook (AC-32), project `ebwnovzzkwhsdxkpyjka`, only on the owner's go-ahead

Off-peak, not 21:00-23:00 local. `db push` lacks the prod password, so apply through MCP.

**Order relative to other pending migrations (added 2026-11-09).**

| Migration | Spec | Order |
|---|---|---|
| `20261108130000` | 187 | Independent of 189: no shared objects. Not on prod as of 2026-11-09 (main Claude, read-only check), so 189 may go first, out of version order |
| `20261109120000` | **189** | |
| `20261109190000` (provisional) | 193 | **After 189.** 193 re-replaces `staff_submit_eod` on top of 189's wrapper, so its md5 pre-check must target the **post-189** body. Applying 193 first would fail that check, or worse, get overwritten by 189's `create or replace` |
| `20261109140000` | 190 | Independent. No shared EOD objects |
| `20261109170000` | 194 | Independent. No shared EOD objects |

If 190 or 194 reaches prod first, 189 goes in **out of version order**. That's fine through MCP `execute_sql` plus the exact `schema_migrations` insert of `20261109120000`, because `db-migrations-applied.yml` compares sets, not order. Local stacks that already hold a later version (for example `20261109140000`) need `--include-all` on `supabase migration up` / `db push`, or a `psql` apply plus the `schema_migrations` insert, as the developer did. A fresh `npx supabase db reset` runs in file order and is unaffected.

1. **Read-only pre-checks. Stop and ask the owner on any unexpected result.**
   - Confirm 193's version is **not** in `supabase_migrations.schema_migrations`. 187's `20261108130000` doesn't need to be there, because 189 shares no objects with it (corrected 2026-11-09 by main Claude).
   - AC-32's duplicate query, with the NULL filter (architect N2). It's the same grouping as the migration's pre-flight. Expect 0 rows:
     ```sql
     select submission_id, item_id, count(*)
       from public.eod_entries
      where submission_id is not null
        and item_id is not null
      group by submission_id, item_id
     having count(*) > 1;
     ```
   - Role drift, which would lose first-submit access (§3.2). Expect 0 rows:
     ```sql
     select p.id, p.role, u.raw_app_meta_data->>'role' as jwt_role
       from public.profiles p join auth.users u on u.id = p.id
      where p.role in ('admin','master')
        and (u.raw_app_meta_data->>'role') is distinct from p.role;
     ```
   - `pg_policies`: no `DELETE` or `ALL` on either table.
   - Normalized md5 of prod's `staff_submit_eod` matches `20261024000000`, so the refactor replaces the body we think it does.
2. Run the migration body through `execute_sql`. Insert the final version into `supabase_migrations.schema_migrations`.
3. **Verify:**
   - `pg_indexes` shows the unique index.
   - `admin_submit_eod`: `prosecdef` true, `proconfig` pins `search_path`, ACL is `authenticated` plus owner.
   - `eod_write_submission`: `prosecdef` false, `proconfig` pins `search_path`, ACL is owner only.
   - `staff_submit_eod`: `prosecdef` true, ACL unchanged.
   - Normalized md5 of all three matches local. "Local" means the final `20261109120000` file, including the §3.4 Rule C edit, re-applied locally with `psql` or `npx supabase db reset`. The local stack already holds the pre-edit version.
4. Push. Confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.
5. Owner does one EDIT on prod through the UI, and re-runs the duplicate query, with the filter.

**Rollback:** §13, including (a) to (d). Before writing it, check whether 193 is on prod. Its version in `schema_migrations` decides which (b) branch applies. The rollback gets its own new version and its own `schema_migrations` insert, applied through MCP before the push.

### 15. Overlaps, risks, and questions for the owner

**Shared files.**

- **Spec 185:** same writer, `submitEODCount`, `buildSubmission`, `EODCountSection` and `useEodSubmit`. It lands after this (D-3). The contract helps it: an admin EDIT of one area never names the other area's rows, so AC-14 holds on that path without extra work. The staff full-replace branch still needs area scoping, in one place. **D-1's "would back up 185's AC-19" is true only if 185 keeps one parent row.** With area in the submission key, the same item could sit under two parents and this index wouldn't catch it. Spec 185's L35, L37 and N1 also become stale, which D-3 leaves to the owner.
- **Spec 186:** no shared migration objects. `retention_prune_job.test.sql` has one entry row, unaffected. Its AC-8 is honoured. Its audit's M3 is addressed by §3.4 and §10.
- **Specs 187 and 188:** no shared objects. 188 only holds the earlier slot.
- **Working tree:** `src/lib/db.ts`, `src/store/useStore.ts` and several test files carry other sessions' uncommitted edits. Don't overwrite them, and stage by hunk.

**Risks.**

- **Refactoring a live staff path.** §2's guards, plus the pre-check md5.
- **Admin gate narrower on first submit.** §3.2, checked by the runbook.
- **Audit and bell can still describe a failed write.** D-5, named as follow-up.
- **On-hand no longer re-asserted for untouched rows.** Pressing UPDATE COUNT no longer resets their stock to the counted value. That's the intended safety, but it is a behaviour change under R5's wording.
- **First-submit notification type on admin may shift** (§7).
- **No reader hardening** (D-2), so the index is the only guard against duplicates.

**Questions for the owner. None of them block the build.**

1. **O-1:** should `staff_submit_eod` refuse an empty payload? Recommend yes. Cost: 3 lines, 5 fixture edits, 2 arms. It's only a partial fix.
2. **O-2:** should `staff_submit_eod` bound `p_date`? Recommend deferring to its own spec, because it collides with late queue replays and most staff fixtures.
3. **Date leak (§5):** counts typed or seeded for one date carry to another date's worksheet and can be submitted there. Recommend a small separate spec.
4. **`Count cleared` audit row (§8):** an architect addition. It stays unless struck.
5. **Removing `adjustItemStock` (§8):** D-5 allowed proposing it, and this design relies on it.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "## Backend design" section of this spec. Re-check the migration slot first. O-1 is optional: build it only if the owner has said yes, and otherwise skip it. Apply the §12 wording changes when testing. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/189-admin-eod-resubmit-replace.md

## Files changed

Both halves are in. The frontend list is below, then the backend list. Main Claude's manual browser pass (AC-28) is recorded at `specs/189-admin-eod-resubmit-replace/reviews/manual-verification.md`.

### Frontend (frontend-developer)

- `src/lib/eodChangeSet.ts` (new): `buildEodChangeSet`, `planEodSubmit`, `eodRowSnapshot`, `sameEodRow` (§5).
- `src/lib/eodChangeSet.test.ts` (new): every row of the §5 per-case, two-editor and "When the set is empty" tables.
- `src/store/useStore.ts`: `submitEOD` only. It takes `opts.removedItemIds`, merges removals, no longer calls `db.adjustItemStock`, and returns an undo (§8). The interface type and the "third copy" comments are rewritten (N3).
- `src/store/useStore.submitEOD.noNeed.spec172.test.ts`: the adjustItemStock arms now assert it's never called (§12 AC-31).
- `src/store/useStore.submitEOD.undo.spec189.test.ts` (new): removal merge (AC-23), undo, no `adjustItemStock`, audit and bell not undone (D-5).
- `src/screens/cmd/sections/EODCountSection.tsx`: baseline ref, the `onEditCurrentVendor` seed fix, `buildSubmission` (change set plus plan), `onSaveDraft`/`onSubmit` (no-RPC path, undo on failure), and the §9 comments.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`: the spy returns an undo. The OQ-A re-submit arm now edits the row, because a no-change UPDATE issues no write.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`: the spy returns an undo. The AC-25 re-ship arm now edits the note, for the same reason.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx` (new): AC-20, AC-22, AC-23 and AC-25 through the full section.
- `e2e/staff-reorder.spec.ts`: L292 comment only (§9).
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`: **no change**. Confirmed by reading it. It writes through the shared model's map setters, calls `model.onSubmit` / `model.onEditCurrentVendor`, and has no SAVE DRAFT.

### Backend (backend-developer)

O-1 approved by owner 2026-11-09 and included. O-2 not built.

**Migrations**
- `supabase/migrations/20261109120000_admin_eod_replace.sql` (new). Slot re-checked at build time: it sorts after `20261108130000`, the newest file on disk, and after spec 188's reserved `20261109000000`. It contains the pre-flight duplicate check, `eod_entries_submission_item_uidx`, `eod_write_submission` (INVOKER, EXECUTE revoked from public, anon, authenticated and service_role), `staff_submit_eod` as a wrapper with the O-1 refusal, `admin_submit_eod` (DEFINER, `authenticated` only), and forward comments on `eod_entries` and `report_last_order_context`. Applied locally with `psql`, and `20261109120000` inserted into `supabase_migrations.schema_migrations`. **Not applied to prod:** that's the §14 runbook, on the owner's go-ahead.

**pgTAP**
- `supabase/tests/admin_submit_eod.test.sql` (new, 96 arms): AC-1 to AC-19, AC-24 (server side), AC-26, AC-27, AC-33 and AC-34, all with the §12 wordings. The AC-15 catalog arms cover `prosecdef`, `proconfig` and `has_function_privilege` for anon, authenticated and service_role on both functions.
- `supabase/tests/report_last_order_context.test.sql`: the D1/D2 fixture now inserts only the 9 row, with the reason stated in the file. Added (D3), which expects 23505 on the duplicate; it runs as postgres so RLS can't raise first. Plan goes from 41 to 42.
- `supabase/tests/eod_update_notifications.test.sql`: the 5 `'[]'` `staff_submit_eod` payloads become one entry for a Frederick item (`test.payload`), because O-1 refuses `'[]'`. Plan and arm meanings are unchanged, and the header says why (AC-31).
- `supabase/tests/eod_submissions_edit_flow.test.sql`: comments only (L10-19 and the old L162-165 block).

**src/lib/db.ts**
- `submitEODCount(submission, removedItemIds = [])` now returns `{ submissionId, entryCount }` via `supabase.rpc('admin_submit_eod', …)`, with entries sorted by item id. It no longer accesses `eod_entries`, `eod_submissions`, `inventory_items` or `item_vendors` directly. The comment block is rewritten. The `isNumericEodEntry` import is removed because nothing else in `db.ts` used it.

**jest**
- `src/lib/db.eodNoNeed.test.ts`: the submitEODCount block is rewritten for AC-21. Any direct `eod_entries` op resolves with an error and fails the test through an `afterEach`. The client arms now check the RPC args, and the on-hand arms moved to pgTAP.

**Docs**
- `README.md`: `admin_submit_eod` row added to the Key RPCs table.
