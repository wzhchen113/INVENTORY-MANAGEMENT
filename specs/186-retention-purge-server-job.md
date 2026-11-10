# Spec 186: Keep business records and move retention pruning to a nightly server job

Status: READY_FOR_REVIEW

Origin: the owner's retention decision of 2026-11-08, relayed to the product manager by the main session. Prod figures are from the main session's read-only checks that day and were not re-run for this spec; full notes are in `90-day-purge-findings.md` in session notes `local_3493f934-334e-4763-96e4-4579e46d9e83`. Code references were read from the working tree on 2026-11-08, and line numbers are pointers.

## User story

As the **owner of 2AM PROJECT**, I want EOD counts, purchase orders, waste logs and POS imports kept, with only old audit rows and expired unused invitations pruned by a nightly server job, so that business records never disappear because an admin opened the app.

## Owner's decision

| Table | Rule | Age column |
|---|---|---|
| `eod_submissions`, `eod_entries` | **Keep.** No age-based deletion | `submitted_at` |
| `purchase_orders`, `po_items` | **Keep.** No age-based deletion | `created_at` |
| `waste_log` | **Keep.** No age-based deletion | `logged_at` |
| `pos_imports`, `pos_import_items` | **Keep.** No age-based deletion | `imported_at` |
| `audit_log` | **Prune** past 90 days, by the job | `created_at` |
| `invitations` | **Prune** when expired and unused, by the job | `expires_at`, `used` |

- **Do not reopen this decision.**
- "Keep" means indefinitely. A future retention limit on business records needs its own owner decision.
- "Keep" covers age-based deletion only. Deliberate deletes keep working as they do today, including store deletion, brand deletion and PO rollback.
- `vendor_order_attempts` cascades from `purchase_orders`, so it stays whenever its PO stays.

## Current behaviour

`cleanupOldRecords` ([src/lib/db.ts:6225](../src/lib/db.ts)) runs from [src/store/useStore.ts:2382](../src/store/useStore.ts) on every admin store load, using the caller's token. RLS therefore limits it to stores that caller can see. Store loads include realtime-triggered reloads ([src/navigation/CmdNavigator.tsx:69](../src/navigation/CmdNavigator.tsx)), so an open tab can run it many times a day.

| Table | DELETE policy on prod | What the purge does | Prod, 2026-11-08 |
|---|---|---|---|
| `eod_submissions` | None | 0 rows, no error | 225 rows, 66 past 90 days (Charles 60, Towson 6), oldest 2026-04-16 |
| `eod_entries` | None | Not targeted | 3,378 rows, 1,001 under those 66 |
| `audit_log` | `admin_delete_audit_log` (spec 170) | Works, except that an admin skips store-less rows (spec 170 N2) | 2,960 rows, oldest 2026-08-11, 0 store-less |
| `purchase_orders` | `store_member_delete_purchase_orders` | **Will delete. No status filter.** Cascades to `po_items` and `vendor_order_attempts` | 4 rows, all `draft`, oldest 2026-08-22, which reaches 90 days on **2026-11-20** |
| `waste_log` | `store_member_delete_waste_log` | Would delete | 0 rows |
| `pos_imports` | `store_member_delete_pos_imports` | Would delete. Cascades to `pos_import_items` | 0 rows |
| `invitations` | `Admins can delete invitations` | Works | 4 rows, 0 expired and unused |

A local rolled-back probe, as an admin who could see the store, showed 24 backdated EOD rows visible and 0 deleted, and 1 backdated PO deleted.

So the purge does nothing to the records that are oldest today, and it is about to start deleting the ones the owner wants kept.

## Requirements

### R1. Nightly server-side prune
A pg_cron job prunes exactly the two `audit_log` and `invitations` sets in the table above, across all brands and stores, once a night. Prod already runs `prune-*` jobs, and [20260607130000_username_resolve_rate_limit.sql](../supabase/migrations/20260607130000_username_resolve_rate_limit.sql) L148-190 is a reference shape.

### R2. Remove the client purge
`cleanupOldRecords` and its store-load call are removed.

### R3. Stale clients must not be able to delete kept records
Removing the code does not stop clients already running it:
- A tab or installed PWA window that has not reloaded keeps running the old JavaScript. [public/sw.js](../public/sw.js) deliberately caches nothing, so a reload does get the new bundle, but nothing forces a reload.
- An installed native build runs the old code until it is replaced, and cannot be forced to update.

After 2026-11-20, those clients would still delete `purchase_orders`, `waste_log` and `pos_imports` rows past 90 days, because those DELETE policies stay. The server must refuse this.

The design chooses the mechanism. This spec only sets what it must do (AC-14 to AC-22), and the protection has no end date because there is no point at which every old native build is known to be gone.

What the design must allow for:
- **Cutoffs come from the client clock.** A device whose clock runs N days fast reaches rows 90 − N days old by the server clock. Spec 170 N3 called skew harmless for audit rows, which does not carry over to records being kept. The design states its margin.
- **Permissive policies OR together.** Adding a permissive policy beside `store_member_delete_*` tightens nothing (CLAUDE.md, spec 051).
- **FK cascades bypass RLS but do fire triggers.** Store and brand deletes depend on these cascades ([20260510010000_brand_delete_cascade.sql](../supabase/migrations/20260510010000_brand_delete_cascade.sql) makes all three tables `ON DELETE CASCADE` from `stores`). A mechanism that raises on delete could abort a store delete.

Legitimate deletes that must keep working. A search of `src/`, `supabase/functions/` and `supabase/migrations/` on 2026-11-08 found no other caller that deletes these three tables, no individual-delete UI for them, and no service-role delete of them.

| Path | What it deletes |
|---|---|
| `db.deleteStore` ([db.ts:188](../src/lib/db.ts)) | All of a store's `waste_log` rows **of any age**, then the store, whose cascade takes the rest |
| PO rollback ([db.ts:1860](../src/lib/db.ts), [db.ts:2022](../src/lib/db.ts)) | A `purchase_orders` row inserted moments earlier, by id |
| Store delete and `hard_delete_brand` | Everything under the store or brand, by FK cascade |
| `po_items` line edits ([db.ts:1978](../src/lib/db.ts), [db.ts:2073](../src/lib/db.ts)) | Lines of a draft PO. Now reachable on a draft older than 90 days, because drafts are no longer purged |

### R4. Audit behaviour may not silently regress
[20261022000000_audit_log_rls_hardening.sql](../supabase/migrations/20261022000000_audit_log_rls_hardening.sql) ties `admin_delete_audit_log` to this function: its policy comment says the 90 days must match `cleanupOldRecords`. Whether the policy stays is a design decision, and either answer must be made on purpose and recorded (AC-23 to AC-25).

The job prunes store-less rows too. This supersedes spec 170 N2, where those rows aged out only when a super_admin session ran the purge.

### R5. Deliver before the deadline
The client purge removal reaches production before **2026-11-20**. The server-side refusal and the job go first, because migrations must be on prod before the push. If the release slips, the refusal alone still protects the 2026-08-22 PO.

## Acceptance criteria

Track names follow [tests/README.md](../tests/README.md). All pgTAP arms go in a new file under `supabase/tests/`.

**Every pgTAP arm that claims a row survived or was removed reads the row back by fixture id as `postgres`, in a final block.** A read as a caller who cannot see the row passes vacuously, and the first local probe in this investigation was vacuous in a similar way (it picked a store with no rows).

### The job (pgTAP)

- [x] **AC-1:** `cron.job` has one active job named `prune-*`, whose schedule fires once per day and whose command runs the prune. No existing test reads `cron.job`, so the design confirms that CI can read it.
- [x] **AC-2:** Tests run the prune with the same statement the cron job runs, not a copy of its logic.
- [x] **AC-3 (precondition):** Before the prune runs, an arm asserts that every fixture below exists, so nothing can pass because a fixture was missing.
- [x] **AC-4 (deletion control, so a no-op cannot pass):** After one run, each of these is gone:
  - 91-day `audit_log` row in a brand-A store
  - 91-day `audit_log` row in a brand-B store
  - 91-day store-less `audit_log` row
  - Invitation with `used = false` and `expires_at` in the past
- [x] **AC-5 (boundaries):** After the same run, each of these is still there:
  - 89-day `audit_log` row
  - `audit_log` row with NULL `created_at` (its age is unknown)
  - Invitation with `used = false` and `expires_at` in the future
  - Invitation with `used = true` and `expires_at` in the past. `fetchAllUsers` infers emails from used invitations (specs 082, 083)
  - Invitation with `expires_at` NULL. `register_invited_profile` treats it as never expiring
  - Invitation with `used` NULL, matching the old purge's `.eq('used', false)`
- [x] **AC-6 (kept records):** After the same run, each of these rows, all dated 200 days back, is still there, each asserted separately:
  - `eod_submissions` row and its `eod_entries` row
  - `purchase_orders` row with status `draft`, and another with status `received`
  - `po_items` row and `vendor_order_attempts` row under the draft
  - `waste_log` row
  - `pos_imports` row and its `pos_import_items` row
- [x] **AC-7:** An `order_approvals` row linked to the 200-day submission keeps its `source_submission_id` after the run.
- [x] **AC-8:** `pg_policies` shows no `DELETE` or `ALL` policy on `eod_submissions` or `eod_entries`. Adding one would let an API caller clear `order_approvals.source_submission_id` (spec 178, security audit L1).
- [x] **AC-9:** The prune reports how many rows it removed from each table. Each reported count equals the drop in that table's row count across the run, and a second run in the same transaction reports 0 for both. The arm compares against the row-count drop, not the fixture count, because `seed.sql` was pulled from prod and can hold old rows of its own.
- [x] **AC-10:** If the prune is a function, `anon` and `authenticated` cannot execute it (`has_function_privilege`).

### Removing the client purge (jest)

- [x] **AC-11:** A search for `cleanupOldRecords` under `src/` returns nothing. That means removing the export in `db.ts`, the call and its comment in `useStore.ts`, every test mock, and the comment at `useStore.switching.test.ts:17`. Mentions in existing migration comments stay as history.
- [x] **AC-12:** The mock entry is gone from all 16 files that have it:
  - In `src/store/`: `useStore.test.ts`, `useStore.switching.test.ts`, `useStore.updateStore.test.ts`, `useStore.activeBrand.test.ts`, and the `useStore.*` files `lateResultGuards.spec176`, `lastOrderContext.spec151`, `sessionLoss.spec152`, `reorderReload.spec175`, `createPoDraft.spec125`, `recordExportedOrder.spec156`, `updateItem.catalogRevert.spec173`, `lastCounted.spec160`, `approveOrder.spec149`, `fillCartForVendor.spec138`, `storeGate.spec161`
  - `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`
- [x] **AC-13:** In `useStore.lateResultGuards.spec176.test.ts`, the `db.cleanupOldRecords` line (L506) is removed from `expectNoTails` and the other four assertions stay. Full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass.

### Stale clients (pgTAP)

Each arm issues the old purge's own statements with its cutoff (`now() - interval '90 days'`):

```sql
delete from public.purchase_orders where created_at < :cutoff;
delete from public.waste_log       where logged_at  < :cutoff;
delete from public.pos_imports     where imported_at < :cutoff;
```

- [x] **AC-14 (precondition):** Before deleting, each caller in AC-15 can SELECT the 200-day row in its store. Otherwise a refusal proves nothing.
- [x] **AC-15:** Run as an admin JWT, a super_admin and a store-member staff user, those statements leave the 200-day `purchase_orders`, `po_items`, `vendor_order_attempts`, `waste_log`, `pos_imports` and `pos_import_items` rows in place.
- [x] **AC-16:** A refusal cannot surface to the user or stop the old purge's other deletes. The design states whether a refusal is 0 rows or an error, and an arm pins it. The old `safe()` wrapper ([db.ts:6232](../src/lib/db.ts)) already catches errors per statement and only logs a console warning.
- [x] **AC-17:** The design's clock-skew margin (R3) has an arm: a row just inside the margin is refused, and a row just outside it behaves as the design states.

### Legitimate deletes still work (pgTAP)

- [x] **AC-18:** An admin JWT deleting a just-inserted `purchase_orders` row by id removes it (PO rollback).
- [x] **AC-19:** An admin JWT running the `db.deleteStore` statements in order ([db.ts:185-191](../src/lib/db.ts)) on a store holding both fresh and 200-day PO, waste and POS rows ends with the store and all those rows gone. The arm runs them the way the client does, where an error on one statement does not stop the next, because `deleteStore` does not check per-statement errors.
- [x] **AC-20:** `hard_delete_brand` on a brand holding 200-day PO, waste and POS rows removes them and completes.
- [x] **AC-21:** An admin JWT can still delete a `po_items` line on a 200-day `draft` PO.
- [x] **AC-22:** Rows younger than the design's margin stay deletable by the same callers as today. This spec does not otherwise narrow the `store_member_delete_*` policies.

### Audit behaviour (pgTAP)

- [x] **AC-23:** After this spec, these all still hold, and the existing arms that prove them still pass:

  | Property | Arms |
  |---|---|
  | Nobody can delete a row under 90 days old through the API | `audit_log_rls_hardening` D-1, D-2 |
  | Staff cannot delete an aged row | D-7, `super_admin_policy_parity` AL-8 |
  | A brand-A admin cannot delete a brand-B row | D-4, D-10 |
  | A brand admin cannot delete a store-less row | D-5 |
  | Store deletion still removes audit rows through the FK cascade | D-8, D-9 |
  | Audit rows stay immutable through the API | S-2, U-1, U-2, AL-5, AL-7, AL-9 |
  | The restrictive SELECT and INSERT policies are unchanged | The R, I, C and W arms, S-3, S-4 |

- [x] **AC-24:** The design states which way `admin_delete_audit_log` goes:
  - **If it stays:** a new migration rewrites its comment, which still names `cleanupOldRecords` and spec 170 N2. Arm S-6 counts comments beginning `spec 170: `, so the new comment keeps that prefix or S-6 is updated on purpose.
  - **If it goes:** S-1, S-5, S-6, D-3 and D-6 in `audit_log_rls_hardening.test.sql` and AL-6, AL-10 in `super_admin_policy_parity.test.sql` are each rewritten with the reason stated, not deleted. AL-6 and AL-10 exist so that super_admin and master are not silently denied on the retention purge, so the rewrite says how that intent is now met.
- [x] **AC-25:** The design has one table of who can delete `audit_log` rows after this spec, in the shape of spec 170's. Under either answer, stale clients' `audit_log` delete raises no visible error.

### Proof the tests can fail

- [x] **AC-26:** These were each tried by hand and the results recorded in the spec's implementation notes, as specs 170 and 178 did:

  | Temporary change | Arms that must fail |
  |---|---|
  | Prune body made a no-op | AC-4 |
  | Prune also deletes old `purchase_orders` | AC-6 |
  | Audit cutoff set to 60 days | AC-5 (89-day row) |
  | Audit cutoff set to 120 days | AC-4 (91-day rows) |
  | Stale-client protection removed | AC-15 |

### Existing gates

- [x] **AC-27:** All existing pgTAP tests pass, including `permissive_policy_lint.test.sql`. `generate_po_number_malformed_guard.test.sql:38` runs an unfiltered PO delete, which any new mechanism must not break.

### Production

- [x] **AC-28:** The first-run checks below are done and their results reported to the owner. (2026-11-10, see "Prod apply, 2026-11-10")
- [x] **AC-29:** The migration is applied to prod and verified as below, before the push. (2026-11-10, see "Prod apply, 2026-11-10")
- [ ] **AC-30:** The client removal is live in production before 2026-11-20.
- [ ] **AC-31:** On or after 2026-11-21, a read-only check shows the PO created on 2026-08-22 still exists, unless someone deliberately deleted it.

## First prod run

### Expected removal

| Table | Expected |
|---|---|
| `audit_log` | **Few: roughly the rows that crossed 90 days since the last purge.** 0 were past 90 days on 2026-11-08. The oldest (2026-08-11) crosses on 2026-11-09, and 2,960 rows over 89 days averages about 33 a day. The live client purge keeps clearing these until it is removed, so each day between the removal and the first job run adds about 33. |
| `audit_log`, store-less | **0.** None existed on 2026-11-08. |
| `invitations` | **0**, unless one of the 4 rows expires unused before the run. |
| Every business table | **0.** |

### Read-only confirmation

Run this on prod through the Supabase MCP twice: before applying the migration, and again after applying and before the first scheduled run. If the design changes the prune's predicate, update these counts to match.

```sql
select
  (select count(*) from public.audit_log
    where created_at < now() - interval '90 days')                   as audit_would_prune,
  (select count(*) from public.audit_log
    where created_at < now() - interval '90 days'
      and store_id is null)                                          as audit_storeless_would_prune,
  (select count(*) from public.audit_log where created_at is null)   as audit_null_created_at_kept,
  (select min(created_at) from public.audit_log)                     as audit_oldest,
  (select count(*) from public.invitations
    where used = false and expires_at < now())                       as invites_would_prune,
  (select count(*) from public.eod_submissions)                      as eod_submissions,
  (select count(*) from public.eod_entries)                          as eod_entries,
  (select count(*) from public.purchase_orders)                      as purchase_orders,
  (select count(*) from public.po_items)                             as po_items,
  (select count(*) from public.vendor_order_attempts)                as vendor_order_attempts,
  (select count(*) from public.waste_log)                            as waste_log,
  (select count(*) from public.pos_imports)                          as pos_imports,
  (select count(*) from public.pos_import_items)                     as pos_import_items;
```

**Stop and ask the owner** if `audit_would_prune` is over 500 (about two weeks at the average rate), or if `invites_would_prune` is over 4 (the size of the whole table on 2026-11-08), or if the numbers cannot be explained.

### After the first scheduled run

1. `cron.job_run_details` shows the job succeeded.
2. Re-running the query shows `audit_would_prune` and `invites_would_prune` at 0, or only rows that crossed since the run.
3. Every business-table count is at or above the snapshot, unless a store or brand was deliberately deleted in between.
4. Report the numbers to the owner.

## Prod apply

Apply before pushing, or `db-migrations-applied.yml` goes red (spec 178 "Prod apply"). Changing prod needs the owner's go-ahead.

1. Run the first-run query and record the result. Then run every read-only check in "Prod apply additions", step 1 (FK and ownership checks, the security auditor's four M5 queries, and the architect's version, trigger and `server_version` checks), and compare each result with the local baseline recorded there. **Stop on any failed check, and stop and ask the owner about anything prod has beyond that baseline.** (Added 2026-11-09, M5.)
2. Run the migration body through the Supabase MCP `execute_sql`.
3. Insert the exact version into `supabase_migrations.schema_migrations`.
4. Verify what the drift gate cannot see:
   - The `cron.job` row exists and is active.
   - Any new function's normalized md5 matches local, and its `prosecdef`, `proconfig`, owner and ACL match local.
   - The policy or other objects that implement R3 match local.
5. Run the first-run query again.
6. Push the client removal. Confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

The design includes a rollback. Rolling back the job or the protection must not bring back age-based deletion of business records.

## In scope

- The nightly pg_cron job for `audit_log` and `invitations`.
- Removing `cleanupOldRecords`, its call and its test mocks.
- Server-side refusal of stale-client deletes on `purchase_orders`, `waste_log` and `pos_imports`.
- The `admin_delete_audit_log` decision, plus its comment and tests.
- New pgTAP coverage and the updated jest tests.
- The first-run checks and the prod apply.

## Not in this spec

- **`db.deleteStore`'s no-op `eod_submissions` delete** at [src/lib/db.ts:187](../src/lib/db.ts). It is harmless, and the store cascade removes those rows.
- **The unscoped `invitations` delete policy and the broad `store_member_*` delete policies**, beyond what R3 requires.
- **The empty prod `pos_imports` table.** Session `local_cc55f869-8db2-4b1a-86a8-8571514a9995` is investigating it.
- **Approver attribution.** Session `local_f23a8d88-28f9-4417-8331-0ee4c3584469` is handling it.
- **`inviteUser`'s own expired-invitation delete** at [src/lib/auth.ts:400](../src/lib/auth.ts). It runs when an admin invites someone, not on store load, and it stays. Without it, re-inviting an email whose invite expired since the last job run would fail with "An invitation for this email already exists".
- **Showing older records.** The EOD History tab keeps hiding anything past 90 days ([EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx) L2148-2166). The owner asked to keep records, not to display them.
- **A retention limit for business records, or a configurable window.** A limit needs its own owner decision, and the audit window stays at 90 days.
- **Alerts for a failed job.** `cron.job_run_details` is the record, as for the existing `prune-*` jobs.
- **Audit rows recording what the job pruned.** Nobody asked for this.

### Consequences of keeping, not changed here

The purge was written to remove PO and waste rows at 90 days, so these readers were not built with older rows in mind. None of them changes in this spec. They are recorded so nobody mistakes them for bugs, and each could become a follow-up if it becomes a problem.

| Reader | What happens now |
|---|---|
| `get_pending_extension_orders` ([20260723000000_extension_ordering.sql](../supabase/migrations/20260723000000_extension_ordering.sql) L177) | Any `draft` on an opted-in vendor stays pending, however old |
| `fetchStaffOpenPos` ([receiving.ts:114](../src/screens/staff/lib/receiving.ts)) | `sent` and `partial` POs stay listed, however old |
| `fetchWasteLog` ([db.ts:866](../src/lib/db.ts)) | Loads every waste row on each store load, with no date filter |
| `WasteReportTab` matrix ([WasteLogSection.tsx](../src/screens/cmd/sections/WasteLogSection.tsx) L569) | Sums everything loaded, so it becomes lifetime rather than about 90 days. Prod has 0 waste rows today |
| Brands members pending list ([db.ts:5781](../src/lib/db.ts)) | Has no expiry filter, so an expired unused invite can show as pending until the next job run instead of the next admin store load. `register_invited_profile` already refuses expired invites |
| `deleteInventoryItem` ([db.ts:3081](../src/lib/db.ts)) | Silently fails for as long as a kept `waste_log` or `po_items` row names the item. The reference is NO ACTION and the helper ignores the error. The purge used to clear these references after 90 days |
| `deleteVendor` ([db.ts:4028](../src/lib/db.ts)) | Silently fails for as long as a kept `purchase_orders` row names the vendor, for the same reason |
| `deleteRecipe` ([db.ts:3131](../src/lib/db.ts)) | Silently fails for as long as a kept `pos_import_items` row names the recipe, for the same reason. This will matter most once Breadbot is fixed and writes mapped lines nightly |

## Open questions resolved

- Q: What is kept and what is pruned? → A: The owner's decision above. Not reopened.
- Q: How often does the job run? → A: Nightly. The owner chose from options describing a nightly server job.
- Q: How long are business records kept? → A: The owner said "keep" and gave no duration, so this spec treats it as indefinite. A future limit needs its own decision.
- Q: Are store-less `audit_log` rows pruned? → A: Yes. This is the product manager's reading: the owner's rule names `audit_log` past 90 days with no exception, and those rows already age out today when a super_admin session runs the purge. None exist on prod today.
- Q: Does "the client purge is removed" include `inviteUser`'s delete at `auth.ts:400`? → A: No. This is the product manager's reading: the owner was deciding about `cleanupOldRecords`, and removing the other delete would break re-inviting (see "Not in this spec").
- Q: Is a stale client a real risk or an edge case? → A: A real requirement (R3), as the dispatch brief required.

**No question remains for the owner.** These remain for the design:
1. The stale-client mechanism and its clock-skew margin (R3).
2. Whether `admin_delete_audit_log` stays (R4).
3. The shape of the prune, the job's name and its time of night. The time should not share a minute with an existing job.

## Dependencies

- pg_cron, already on prod and used locally by earlier migrations.
- Spec 170 (`admin_delete_audit_log`, tests `audit_log_rls_hardening` and `super_admin_policy_parity`).
- Spec 178 (the reason no DELETE policy may be added to `eod_submissions`; the prod-apply shape).
- Spec 156 (exports record draft POs, which is why all 4 prod POs are drafts).
- Prod apply through the Supabase MCP, because `db push` lacks the prod password.

## Project-specific notes

- **Cmd UI section / legacy:** None. No screen changes; only a store-load tail is removed.
- **Which app:** Admin. Staff-store-member callers appear only as test arms in AC-15, because the same DELETE policies admit them.
- **Per-store or admin-global:** The job is global across all brands and stores, unlike the old purge, which RLS limited to the caller's stores. The stale-client refusal applies to store-scoped tables.
- **Edge function or PostgREST:** Neither for the prune, which is a pg_cron SQL job. No client calls it.
- **Realtime channels touched:** None. `audit_log` and `invitations` are not in `supabase_realtime`, per a search of the migrations. The publication gotcha applies only if the design changes publication membership, which nothing here needs.
- **Migrations needed:** Yes. Pick a version later than the newest in `supabase/migrations/` at build time, because other sessions are adding migrations.
- **Edge functions touched:** None. `delete-user`'s invitation delete by `profile_id` is unrelated.
- **Web/native scope:** The code removal is shared, so it ships to both. The server-side parts protect both, and native builds already installed are covered only by R3.
- **`app.json` slug:** Not touched.
- **Tests:** pgTAP for the job, stale clients, legitimate deletes and audit behaviour. Jest for the removal. No shell smoke is needed.
- **Things checked for the job's side effects:** A search of the migrations found no FK referencing `audit_log` or `invitations`, and no delete trigger on them. The design confirms this against prod.

## Backend design

> **Revised 2026-11-09 (post-impl review, SF-1).** The `stores_clear_waste_log_before_delete` trigger and its function `public.tg_stores_clear_waste_log()` are **removed** from this design, following the architect's ruling in [reviews/backend-architect.md](186-retention-purge-server-job/reviews/backend-architect.md). Store deletion removes aged `waste_log` rows through the `stores` FK cascade. The build-step-1 probe found no 23503 on `waste_log_item_id_fkey` in either RI firing order, and prod's order (read 2026-11-08) is the same as local's. Text below that describes the trigger is kept as history and marked **Superseded 2026-11-09**. Rows and steps that changed are marked **Revised 2026-11-09**.

Nothing in this design was run. The architect has no database, so each trace below comes from reading code, migrations and existing tests. Build step 1 tests the one assumption that matters most.

### Decisions

| Question | Decision |
|---|---|
| Stale-client mechanism | Three RESTRICTIVE DELETE policies on `purchase_orders`, `waste_log` and `pos_imports`. **Revised 2026-11-09:** the policies only. The `BEFORE DELETE` trigger on `stores` originally listed here is removed (SF-1) |
| Refusal shape | 0 rows and no error |
| Age limit and margin | Direct deletes are refused once a row is **1 day** old by the server clock. The margin is **89 days**: a clock up to 89 days fast cannot reach a refused row |
| `admin_delete_audit_log` | **Stays.** Only its comment changes |
| Prune | `public.prune_audit_log_and_invitations()`, one function that returns both counts |
| Job | `prune-audit-log-and-invitations`, schedule `47 8 * * *` UTC (03:47 EST, 04:47 EDT) |
| `db.deleteStore` | Statements unchanged. One comment is added at L188. **Revised 2026-11-09:** the comment says aged rows are removed by the `stores` FK cascade |
| Owner choice forced | None. The owner's decision is not reopened |

### Stale-client mechanism

**The database cannot tell `db.deleteStore` L188 from the old purge.** Both are a direct DELETE on `waste_log` by a privileged JWT that hits rows of any age. A policy or a row trigger sees the row and the caller, but not the statement's filter. The only way to separate them from inside the database is to parse `current_query()`, which is too fragile to use. So L188 will be refused on aged rows, and the design makes that harmless.

| Path | Restrictive policy | Raising `BEFORE DELETE` trigger |
|---|---|---|
| Old purge | 0 rows, no error, nothing logged | Errors on every store load. `safe()` catches it, but it logs a console warning each time |
| `deleteStore` L188 | Fresh rows deleted, aged rows skipped, no error | One aged row aborts the whole statement, so fresh rows stay too. The error is swallowed |
| FK cascades from `stores` | RLS does not apply (`audit_log_rls_hardening` D-8, D-9 prove this for `audit_log`) | The trigger fires inside the cascade, so it needs a `pg_trigger_depth() > 0` exemption |
| `hard_delete_brand` | Owner plus RI, no RLS | Same depth exemption needed |
| PO rollback ([db.ts:1860](../src/lib/db.ts), [db.ts:2022](../src/lib/db.ts)) | Admitted, the row is seconds old | Admitted |
| `po_items` line edits | Unaffected. `store_member_delete_po_items` reads the parent through its SELECT policies, not its DELETE policies, and `po_items` gets no new policy | Unaffected |
| Unfiltered delete as `postgres` (`generate_po_number_malformed_guard.test.sql:38`) | Owner bypass | Fires, so it needs a role exemption too (AC-27) |
| `service_role` | BYPASSRLS | Fires, so same exemption |

The policy needs no exemptions and gives the quiet result AC-16 asks for. A trigger that returns NULL would also give 0 rows, but it would need the same exemptions.

> **Superseded 2026-11-09 (SF-1), through the end of the "Alternatives rejected" table below.** The hazard did not reproduce (build step 1, both RI firing orders), and the trigger was removed. This text misread spec 179: L1030 there says a NO ACTION check fires at the end of each RI cascade sub-statement, but its fuller account at L459-462 says a cascade's `DELETE` queues its RI events into the top-level statement's queue. On that model the `waste_log.item_id` check is queued behind the `stores → waste_log` cascade in either order. The model is empirical and the ruling rests on the observed results. See [reviews/backend-architect.md](186-retention-purge-server-job/reviews/backend-architect.md), "Ruling".

**The hazard both approaches share is a stranded store delete.** Today, L188 removes every waste row before L191 deletes the store. Spec 179 found that a NO ACTION check fires at the end of each RI cascade sub-statement, in RI-trigger name order ([spec 179](179-inventory-item-identity-lock.md) L1030, test comment at `inventory_items_identity_lock.test.sql:183-189`). `waste_log.item_id` is NO ACTION ([init_schema.sql:141](../supabase/migrations/20260405000759_init_schema.sql), and no later migration changes it), and 012c re-created the `store_id` FKs with `inventory_items` before `waste_log`. So once L188 leaves an aged row behind:

1. L191 passes RLS and starts the cascade.
2. `stores → inventory_items` deletes the store's items.
3. The check on `waste_log.item_id` finds the aged row and raises 23503.
4. The store delete rolls back, and `deleteStore` swallows the error because it checks no per-statement result, so the UI behaves as if it succeeded.

Changing `deleteStore` cannot fix this, because stale clients keep running the old statements.

**The fix is `stores_clear_waste_log_before_delete`.** This `BEFORE DELETE FOR EACH ROW` trigger on `stores` runs `delete from public.waste_log where store_id = old.id` as the owner, before any RI action fires. That makes RI firing order irrelevant, which matters because prod's order is unverified (spec 179 L1042).

- **It is not a hole in R3.** A row trigger fires only for rows that pass `privileged_delete_stores`, so it needs the same authority the FK cascade already needs. The old purge never deletes from `stores`.
- **It is atomic.** If the store delete fails for another reason, the waste delete rolls back with it, so aged rows survive.
- **It covers every route.** Current and stale `deleteStore`, a direct store delete, and the brand cascade all reach it.

Alternatives rejected:

| Alternative | Why not |
|---|---|
| `waste_log.item_id` ON DELETE SET NULL | `deleteInventoryItem` would start succeeding and erase the item identity on a kept record |
| `waste_log.item_id` ON DELETE CASCADE | Deleting an item would delete kept waste rows |
| `waste_log.item_id` DEFERRABLE INITIALLY DEFERRED | Moves the check to commit for every item delete and waste insert. pgTAP files never commit, so L185 would wrongly pass in AC-19 without `set constraints` |
| Re-creating `stores → inventory_items` so it fires last | Depends on oid order, and any later FK breaks it without warning |
| Changing `deleteStore` or adding an RPC | Stale clients are unaffected |

*(End of superseded text.)*

### Clock-skew margin

Every current writer leaves `created_at`, `logged_at` and `imported_at` to their `now()` defaults, so policy and row share the server clock. Spec 170 N3 does not carry over.

- **Why 1 day.** The longest legitimate direct delete is PO rollback, which happens seconds after the insert. `deleteStore` no longer depends on the limit, because the `stores` FK cascade removes aged waste rows (revised 2026-11-09: originally the trigger). A smaller limit only shrinks what a wrong clock can reach.
- **What it guarantees.** A clock N days fast targets rows older than 90 − N days. For N up to 89, every targeted row is refused. For any larger N, including a wrong year, a stale client can delete **only rows under 1 day old**. No limit closes this completely, because the server cannot see the client's clock.
- **NULL dates.** The columns are nullable. A NULL fails the predicate, so a NULL-dated row is refused, matching AC-5's "age unknown means keep". The old purge's `.lt` never matched NULL, and no legitimate path deletes such a row directly.
- **Not a security boundary.** A store member can still `UPDATE` a date and then delete, because `store_member_update_*` stays. R3 is about stale code, not hostile callers, and those broad policies are out of scope.

### Data model

Migration: `supabase/migrations/20261108120000_retention_prune_job.sql`. Specs 187 and 188 are also pending, so re-check that this version is still the newest at build time. It sits after `20261108000000_order_approvals_fk_set_null.sql`. Everything is additive: no table, column or index changes. One transaction.

1. Function `public.prune_audit_log_and_invitations()`:
   - **Signature:** `returns table (audit_log_deleted integer, invitations_deleted integer)`, `language plpgsql`, `security definer`, `set search_path = public, pg_temp`. Same shape as `prune_username_resolve_rate_limit`.
   - **Audit delete:** `created_at < now() - interval '90 days'`, for all stores and store-less rows.
   - **Invitation delete:** `used = false and expires_at < now()`.
   - **Scope:** it names no other table. Rows with NULL `created_at`, `used` or `expires_at` do not match, as AC-5 requires.
   - **Grants:** revoke execute from `public, anon, authenticated, service_role`, and grant to `postgres`. Revoking `service_role` differs from the reference shape on purpose, because nothing but cron calls this. The explicit revokes are needed because [20260618000000_public_grants_explicit.sql](../supabase/migrations/20260618000000_public_grants_explicit.sql) sets default privileges for future objects.
2. Job, using the `if exists … unschedule` block from [20260607130000](../supabase/migrations/20260607130000_username_resolve_rate_limit.sql) L179-190. Its command is exactly `select * from public.prune_audit_log_and_invitations();`.
3. ~~Trigger function `public.tg_stores_clear_waste_log()`, `security definer`, same `search_path`, returns `old`, with the same revokes and grant. Trigger `stores_clear_waste_log_before_delete` as described above.~~ **Removed 2026-11-09 (SF-1).** The migration does not create, and does not drop, either object: neither existed outside the shared local database, where both were dropped by hand.
4. Three policies (next section), each with a `spec 186: ` comment.
5. `comment on policy "admin_delete_audit_log"` only (see Audit). No drop or recreate.

**Revised 2026-11-09:** with step 3 removed, the migration's own section markers are (1) the prune and job, (2) the policies, (3) the audit comment.

**Time slot.** 08:47 shares no minute with any listed job. 47 is not a multiple of 5, so it misses `eod-reminder-cron`.

**Run counts.** `cron.job_run_details` records only the command status, not the returned row, so the nightly counts are not stored. AC-9 is met by the return value, and the spec excludes recording what was pruned. The first-run check should read `job_run_details` soon after the run, because `prune-cron-history` (08:23) trims that table and is not defined in this repo, so its window is unknown here.

### RLS impact

No `to` clause, matching the `audit_log_restrict_*` policies, so PUBLIC is covered. Each is `AS RESTRICTIVE FOR DELETE`.

| Policy | Table | USING |
|---|---|---|
| `purchase_orders_restrict_delete_aged` | `purchase_orders` | `created_at >= now() - interval '1 day'` |
| `waste_log_restrict_delete_aged` | `waste_log` | `logged_at >= now() - interval '1 day'` |
| `pos_imports_restrict_delete_aged` | `pos_imports` | `imported_at >= now() - interval '1 day'` |

- These AND with the unchanged `store_member_delete_*` policies, which still use `auth_can_see_store(store_id)`. AC-22's scope check is therefore unchanged.
- `permissive_policy_lint` filters on `permissive = 'PERMISSIVE'`, so it needs no allowlist row.
- No policy is added to `po_items`, `pos_import_items`, `eod_submissions` or `eod_entries`. AC-8 holds.
- The prune needs FORCE RLS to stay off on `audit_log` and `invitations`, which it is ("force row level security" appears only in comments). The prod checks below confirm it. (Revised 2026-11-09: originally "the trigger and the prune".)

### Audit

**`admin_delete_audit_log` stays.** Dropping it would add no protection: rows past 90 days are already rows the owner decided to discard, and the job removes them within a day. It would also require rewriting seven test arms, and nothing would be gained for them. Keeping it costs one comment. The policy has no caller in new builds, but stale clients use it and have no end date.

The new comment keeps the `spec 170: ` prefix so S-6 still counts 5. It says that the policy was revised by spec 186, that the nightly job is now the retention path and covers store-less rows (superseding N2), that stale clients still reach this policy, that the job's and policy's 90 days are independent, and that it must not be loosened. It no longer names `cleanupOldRecords`. Because the policy itself is untouched, all AC-23 arms keep passing without edits.

Who can delete `audit_log` rows after this spec (AC-25):

| Actor | Under 90 days | Past 90 days, in a store | Past 90 days, store-less |
|---|---|---|---|
| Nightly job (owner, no RLS) | No | **Yes**, all brands | **Yes** |
| admin / master (`auth_is_privileged`) | No | Only where `auth_can_see_store` | No |
| super_admin | No | Where `auth_can_see_store` | Yes |
| Staff, anon | No | No | No |
| Stale client's old purge | As the caller's row above, and never a visible error | | |
| Store or brand delete (FK cascade) | **Yes**, every row under that store, any age | | Not touched |
| `service_role`, psql | Bypass RLS. No application code path does this today; only local smoke-script cleanup | | |

### API contract

No PostgREST or RPC surface is added. The prune cannot be called by any client role. Refused deletes return 204 with 0 rows, so supabase-js reports no error and `safe()` logs nothing.

### Edge functions

None changed. `breadbot-nightly-sync`, once fixed, only inserts `pos_imports` as `service_role` and has no delete path, so these policies do not affect it. Its rows are protected like any other after 1 day. `imported_by = null` plays no part in any predicate here.

### `src/lib/db.ts` surface

- Remove `cleanupOldRecords` and its section comment. No helper is added.
- Keep `deleteStore`'s statements. Add one comment at L188, in the style of L189, saying rows older than a day are refused here and removed by the `stores` FK cascade. (Revised 2026-11-09: originally "the `stores` delete trigger".)

### Realtime

No publication change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply. `audit_log` and `invitations` are not published. A refused delete emits no event, and removing the call removes nothing else from the reload path.

### Frontend store

In `useStore.ts`, remove only the store-load call and its comment, plus the mocks in AC-11 to AC-13. There is no optimistic path, because that call was fire-and-forget.

### Build order and test notes

**Step 1: probe before writing anything else.** In a rolled-back local transaction, with the policies but without the trigger, as an admin JWT:
1. Create a store holding one item and a 200-day waste row that names it.
2. Run `delete from stores`.

Expect 23503 on `waste_log_item_id_fkey`. Spec 179 marked this case "probably, unverified". If it does not reproduce, **keep the trigger anyway**, since prod's order is unknown. Record the result, and pin the trigger with a `pg_trigger` catalog arm, because the AC-26 trigger row below would then have nothing to fail.

**AC fixture constraints.** These correct the spec's assumption that store and brand cascades take everything. They pin existing behaviour and do not change the ACs' intent.

| AC | Constraint | Why |
|---|---|---|
| AC-1 | Match the exact job name, not `prune-*` | `prune-username-resolve-rate-limit` also exists locally, and prod has `prune-cron-history` too |
| AC-19 | The fresh and 200-day waste rows **must** name an item in that store | A NULL `item_id` never exercises the hazard, so the arm would pass with the trigger removed |
| AC-19 | PO lines use `item_id` NULL, POS lines use `recipe_id` NULL, and there are no `eod_entries` naming the item | A store whose item has a `po_items` line cannot be deleted today (T32 note), and `eod_entries` probably has the same problem |
| AC-20 | The brand's stores own **no** inventory items, so waste and PO lines use `item_id` NULL | A brand whose stores own items fails today with 23503 on `inventory_items_catalog_id_fkey` (T35-T37) |

**AC-19 statements.** Run each in its own `begin … exception` block, using `execute`, and record the SQLSTATE. Expected:
- L185: 23503, because waste rows name the item.
- L186: 42703, because `recipes.store_id` was dropped in [20260504072830](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) L53. This statement already fails on every call.
- L187: 0 rows.
- L188: fresh row gone, aged row still there. Assert this with `reset role`, then switch back, as D-10 does.
- L190, L191: succeed.

**Extra arms this design requires** (revised 2026-11-09, SF-1):
- A staff JWT running `delete from stores` removes 0 rows and the aged waste row stays, so staff cannot remove kept rows by deleting a store.
- A store delete that fails on a `po_items` line raises 23503 and the aged waste row stays, so a failed store delete leaves kept rows in place.
- A `pg_policies` shape arm: three policies, RESTRICTIVE, DELETE.
- A precondition arm in the style of S-7: FORCE RLS off on `audit_log` and `invitations`, and the prune shares their owner. (Originally it also covered the trigger function and the three kept tables.)
- **Added 2026-11-09:** a catalog arm pinning what store deletion relies on: `waste_log_store_id_fkey` is `c`, `waste_log_item_id_fkey` is `a` and not deferrable, and the `stores → inventory_items` RI trigger name sorts before `stores → waste_log`.

**AC-17 arms:**
- 1 day plus 1 minute old: refused. 1 day minus 1 minute old: deleted.
- Fast clock: cutoff `now() - interval '2 days'` (88 days fast) against a 3-day row: refused.
- Beyond the margin: cutoff `now() + interval '30 days'` (120 days fast) against a 23-hour row: deleted. This pins the stated residual.

**AC-1 and AC-2: can CI read `cron.job`?** Very likely yes, though this is reasoned and not proven.
- Tests run through `scripts/test-db.sh` as `psql -U postgres` in both CI and local. `test.yml` L185 uses the same script.
- `supabase start` applies migrations that read `cron.job` at 20260530:244, 20260607:181 and 20260719:198, so the read works for the migration role. `20260530` L219 names `postgres` as that role.
- As recalled from upstream pg_cron and not checked here, `cron.job` has an RLS policy of `username = current_user`, so a row is visible only to the role that scheduled it. Migrations and tests both run as `postgres`, so the job should be visible.
- A failure is loud (a count of 0 or 42501), so the arm cannot pass vacuously.
- Read `cron.job` as `postgres`, before any `set local role`.
- CI pins CLI 2.106.0, so compare the local version. If they differ, the first CI run is the real proof, and it arrives after the prod apply. A failure there would be a test-only fix-forward.

For AC-2, read `command` from `cron.job` by job name and `execute` it `into` two variables, then stash them with `set_config`. Nothing in the test names the function for the run itself, so it cannot drift from the job.

**Other test rules:**
- Do not use `set role anon`, which segfaults the CI image (spec 067). Use catalog assertions for anon.
- AC-26 gains: ~~trigger removed → AC-19 fails, subject to step 1~~; age limit widened to 89 days → AC-17 fails. **Revised 2026-11-09:** the trigger row is replaced by `waste_log_store_id_fkey` re-created without CASCADE → A19-6 and A19-7 fail.
- The job can fire during a long-lived local stack or a CI run that crosses 08:47 UTC, deleting old seed audit rows and expired seed invitations. The audit and invitation tests read for this design use their own fixtures, but not every test file was checked, so treat an unexplained count failure near that time as a possible cause.

### Prod apply additions

Run these read-only checks in step 1 of "Prod apply", and **stop if any fails**. The first-run query itself is unchanged, because the prune's predicates match the spec's.

```sql
-- Each of the three must be 'c'. Store deletion relies on all three cascades
-- (revised 2026-11-09: there is no stores trigger), so this remains a stop condition.
select conrelid::regclass as child, conname, confdeltype
  from pg_constraint
 where contype = 'f' and confrelid = 'public.stores'::regclass
   and conrelid in ('public.purchase_orders'::regclass, 'public.waste_log'::regclass, 'public.pos_imports'::regclass);

-- Both must return 0 rows: nothing references the pruned tables, and no delete trigger on them.
select conrelid::regclass, conname from pg_constraint
 where contype = 'f' and confrelid in ('public.audit_log'::regclass, 'public.invitations'::regclass);
select tgrelid::regclass, tgname from pg_trigger
 where not tgisinternal and (tgtype & 8) <> 0
   and tgrelid in ('public.audit_log'::regclass, 'public.invitations'::regclass);

-- relforcerowsecurity must be false on both, and relowner must be the role running the migration.
-- (Revised 2026-11-09: narrowed from five tables. Only the prune relies on owner bypass now.)
select relname, relowner::regrole, relforcerowsecurity from pg_class
 where oid in ('public.audit_log'::regclass, 'public.invitations'::regclass);
```

**Added 2026-11-09 (M5, security audit; architect minor 5; SF-1).** Also in step 1, before applying. All read-only.

```sql
-- Architect: stop if either of the first two fails.
-- A1: must be 0. The version is not on prod yet.
select count(*) from supabase_migrations.schema_migrations where version = '20261108120000';
-- A2: must be 0. The removed trigger never existed outside the shared local database.
select count(*) from pg_trigger where tgname = 'stores_clear_waste_log_before_delete';
-- A3: record only, not a stop condition. Compare with local below.
show server_version;

-- Security auditor M5, Q1 to Q4.
select jobname, username, active, command from cron.job order by 1;
select tablename, policyname, permissive, cmd, qual from pg_policies
 where schemaname = 'public' and cmd in ('DELETE','ALL')
   and tablename in ('eod_submissions','eod_entries','purchase_orders','po_items',
                     'vendor_order_attempts','waste_log','pos_imports','pos_import_items');
-- Q3 searches every schema (security re-read L9, 2026-11-09).
select p.oid::regprocedure, p.prosecdef from pg_proc p
 where p.prosrc ~* '(delete\s+from|truncate)'
   and p.prosrc ~* '(eod_submissions|eod_entries|purchase_orders|po_items|vendor_order_attempts|waste_log|pos_imports|pos_import_items)';
select tgrelid::regclass, tgname, tgenabled from pg_trigger
 where not tgisinternal and tgrelid = 'public.stores'::regclass;

-- Q5 (security re-read L9, 2026-11-09): every ON DELETE CASCADE FK into a kept table.
-- A CASCADE from any other parent (e.g. waste_log_item_id_fkey) would let an ordinary delete erase kept rows.
select conrelid::regclass, conname, confrelid::regclass from pg_constraint
 where contype = 'f' and confdeltype = 'c'
   and conrelid in ('public.eod_submissions'::regclass,'public.eod_entries'::regclass,'public.purchase_orders'::regclass,'public.po_items'::regclass,
                    'public.vendor_order_attempts'::regclass,'public.waste_log'::regclass,'public.pos_imports'::regclass,'public.pos_import_items'::regclass)
 order by 1, 2;
```

**Local baseline**, run 2026-11-09 on `supabase_db_imr-inventory` in a `default_transaction_read_only` session. The local database already has this migration (and spec 189's uncommitted `20261109120000_admin_eod_replace`, applied by that session), so the "Expected on prod before apply" column is what prod should show instead. **Stop and ask the owner about anything prod shows beyond that column.**

| Check | Local, 2026-11-09 | Expected on prod before apply |
|---|---|---|
| A1 version row | 1 (applied locally by hand) | **0** |
| A2 removed trigger | 0 | **0** |
| A3 `server_version` | `17.6` (image `postgres:17.6.1.084`) | Record it |
| Q1 `cron.job` | 4 rows, all `username = postgres`, all active: `auto-receive-purchase-orders-daily` (`select public.auto_receive_due_purchase_orders();`), `prune-audit-log-and-invitations` (this spec), `prune-username-resolve-rate-limit` (`select public.prune_username_resolve_rate_limit();`), `record-missed-orders-daily` (`select public.record_missed_orders_for_day(...)`) | The same, **without** `prune-audit-log-and-invitations`. Prod also runs jobs this repo does not define: `prune-cron-history` and `eod-reminder-cron` are already known (design, "Time slot" and "Run counts"). Stop on any other job, and on any job whose command deletes from or truncates a kept table |
| Q2 DELETE/ALL policies | 8 rows: PERMISSIVE `store_member_delete_po_items`, `store_member_delete_pos_import_items`, `store_member_delete_pos_imports`, `store_member_delete_purchase_orders`, `store_member_delete_waste_log` (each `auth_can_see_store`, via the parent for the two child tables); RESTRICTIVE `pos_imports_restrict_delete_aged`, `purchase_orders_restrict_delete_aged`, `waste_log_restrict_delete_aged` (this spec). None on `eod_submissions`, `eod_entries` or `vendor_order_attempts` | The 5 PERMISSIVE rows only. The 3 RESTRICTIVE rows arrive with this migration |
| Q3 functions | 7 rows: `eod_write_submission(uuid,date,uuid,text,jsonb,uuid,uuid[],text,uuid)` (f), `admin_dedupe_recipes(uuid,uuid[])` (t), `report_run_variance(uuid,jsonb)`, `report_run_cogs(uuid,jsonb)`, `report_reorder_list(uuid,jsonb)`, `report_reorder_for_counted_onhand(uuid,jsonb,jsonb)`, `report_last_order_context(uuid,uuid[],date)` (all f) | The same, **except** `staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)` (t) in place of `eod_write_submission`. Spec 189 is not on prod, and its local migration moved the `delete from public.eod_entries` out of `staff_submit_eod` into the shared writer. The last committed definition (`20261024000000_eod_entries_no_need.sql` L201) deletes, which is M3 |
| Q4 user triggers on `stores` | 0 rows | **0 rows** |
| Q5 CASCADE FKs into kept tables (added 2026-11-09, L9; main session, read-only) | 9 rows: `eod_submissions_store_id_fkey`, `waste_log_store_id_fkey`, `purchase_orders_store_id_fkey`, `pos_imports_store_id_fkey`, `vendor_order_attempts_store_id_fkey` (all → `stores`); `eod_entries_submission_id_fkey` → `eod_submissions`; `po_items_po_id_fkey` and `vendor_order_attempts_po_id_fkey` → `purchase_orders`; `pos_import_items_import_id_fkey` → `pos_imports`. Q3 without the schema filter: still 7 rows, 0 outside `public` | **The same 9 rows.** Stop on any CASCADE from another parent. Q3 must show no match outside `public` |

What the Q3 matches are, so a reviewer does not chase them:
- `staff_submit_eod` on prod, `eod_write_submission` on local: the EOD writer deletes a submission's `eod_entries` before re-inserting. This is the real path (security audit M3), and it is not age-based.
- `admin_dedupe_recipes`: deletes `recipes`, `recipe_ingredients`, `recipe_prep_items` and `pos_recipe_aliases`, and re-points `pos_import_items.recipe_id` by UPDATE. It deletes no kept record.
- The five `report_*` functions: false positives. They match `truncate` only through the words "truncated" and "truncation", alongside a kept-table name in a SELECT.

**Prod RI order on `stores`, read-only, read by the main session on 2026-11-08.** ON DELETE RI trigger names in name order: `inventory_items_store_id_fkey` `RI_ConstraintTrigger_a_28254`, `eod_submissions` `…_28259`, `waste_log` `…_28264`, `purchase_orders` `…_28269`, `pos_imports` `…_28274`. So `stores → inventory_items` fires before `stores → waste_log` on prod, the order the design feared and the one arm P-2 pins. Local, 2026-11-09: `inventory_items` `…_18882`, `eod_submissions` `…_18887`, `waste_log` `…_18892`, `purchase_orders` `…_18897`, `pos_imports` `…_18902`. Same relative order.

In step 4, also verify (revised 2026-11-09):
- `cron.job.username` for the new job is **`postgres`**. **Stop if it differs.** The function grants execute only to `postgres`, so under any other role the job would fail with only `cron.job_run_details` to show it.
- The three policies' `permissive`, `cmd` and `qual` against local.
- The three new policy comments (`purchase_orders_restrict_delete_aged`, `waste_log_restrict_delete_aged`, `pos_imports_restrict_delete_aged`) against local, text for text.
- ~~The `stores` trigger is enabled.~~ Removed (SF-1). Instead, re-run A2 and Q4: still 0 rows.
- The new function `public.prune_audit_log_and_invitations()` by normalized md5, `prosecdef`, `proconfig`, owner and ACL. Local `md5(prosrc)` is `643a2e78ee6edc575f98b6af78eec570`.
- The new `admin_delete_audit_log` comment.

### Rollback

No rollback step below deletes a business record or restores age-based deletion, except the ones marked as needing the owner (dropping a restrictive policy, and an age limit above 30 days).

| What | How | Effect on kept records |
|---|---|---|
| Job | `select cron.unschedule('prune-audit-log-and-invitations');`. Dropping the function as well is a forward migration once this migration has committed, per "Mechanics" (revised 2026-11-09, security re-read L11) | None. The function only names `audit_log` and `invitations`. Audit rows and expired invites build up until it is restored |
| Age limit too tight | `alter policy … using (<col> >= now() - interval '<N> days')`, with N up to **30**. A larger N needs the owner's decision, like dropping a policy: with N days, a stale client whose clock runs more than 90 − N days fast deletes kept rows aged between its cutoff and N days, so at N = 89 any clock more than a day fast is age-based deletion (revised 2026-11-09, security re-read L10). N = 30 keeps a 60-day margin. **Revised 2026-11-09:** the three policy comments ("1 day old") and test arms P-1 and A17-* change in the same change. After the migration has committed on prod, this is a forward migration, like everything else (see "Mechanics") | Still refuses every correct-clock purge. It only shrinks the skew margin |
| **Dropping a restrictive policy** | **Do not do this as a rollback.** It lets stale clients resume deleting that table past 90 days. It needs the owner's decision, or a replacement in the same transaction | **Restores age-based deletion** |
| ~~Store trigger~~ | ~~Drop the trigger, then the function~~ **Superseded 2026-11-09 (SF-1):** there is no trigger. | — |
| Store delete raises 23503 on `waste_log_item_id_fkey` (added 2026-11-09) | Nothing has been lost: the store delete rolls back. Ship a forward migration that adds a `BEFORE DELETE` trigger on `stores` as described in the superseded design above | None. Aged waste rows stay until the forward migration lands. The UI is not told, because `deleteStore` ignores errors |
| Audit comment | Restore the text from [20261022000000](../supabase/migrations/20261022000000_audit_log_rls_hardening.sql) L165 | None |
| Client removal | `git revert` is safe only while the three policies are in place, because the restored purge is then refused on those tables | None while the policies stay. Note the restored purge also keeps deleting from `audit_log` and `invitations` within its existing rules |

Mechanics (revised 2026-11-09, SF-2):
- **A prod apply that failed before commit:** the migration runs in one transaction, so nothing of it is on prod. If the version row was inserted separately, delete it. The file can then be fixed or removed. This is the **only** case where the file and version row are removed.
- **Once the migration has committed on prod, before or after the push:** the file and the version row stay. Any rollback, including one of the job alone, is a forward migration with a new version, or an MCP change to the job alone (`cron.unschedule`). **The three policies stay** unless the owner decides otherwise. Before the push the live client purge is still running, so the policies are what protect the 2026-08-22 PO. Removing the file while the policies stay would leave prod with policies no migration declares, invisible to `db-migrations-applied.yml`.
- Do not delete a `schema_migrations` row whose file is still in the repo, because `db-migrations-applied.yml` hard-fails on it.
- ~~**Before the push:** run the rollback through MCP, delete the version row from `schema_migrations`, and remove the file.~~ Superseded 2026-11-09 by the first two bullets: as written it could drop the policies, or strand them undeclared.
- **Pruned rows do not come back** except from a Supabase backup. They are rows the owner chose to discard.

### Risks and tradeoffs

- **Store deletion is already limited, and this spec does not fix it.** A store whose items have PO lines cannot be deleted today, and EOD entries probably block it the same way. `hard_delete_brand` fails for any brand whose stores own items. Prod's 4 draft POs may already block their stores if they have lines. Spec 179 sent this to the owner as a follow-up. The spec's line about cascades removing everything should be read with the fixture constraints above.
- **Keeping records makes some blocks permanent.** These references are NO ACTION, and all three helpers ignore the error. So these deletes silently fail for as long as the kept rows exist, where the purge would previously have cleared PO, waste and POS references after 90 days. Add these to the "Consequences of keeping" list. None changes in this spec:

  | Helper | Blocked by |
  |---|---|
  | `deleteInventoryItem` ([db.ts:3078](../src/lib/db.ts)) | `waste_log.item_id`, `po_items.item_id` |
  | `deleteVendor` ([db.ts:4025](../src/lib/db.ts)) | `purchase_orders.vendor_id` |
  | `deleteRecipe` ([db.ts:3128](../src/lib/db.ts)) | `pos_import_items.recipe_id`. This will matter most once Breadbot is fixed and writes mapped lines nightly |

- **Future delete features.** Any later feature that deletes one of these rows directly once it is over a day old (a "delete draft PO" button, say) must change these policies. That is the cost of the small limit, and it is the intended friction.
- **`deleteStore` still partly applies on failure.** If L191 fails, L188 has already removed fresh waste rows and L190 the store's grants, and the UI is not told. This already happens today. ~~The trigger narrows it for aged rows only.~~ (Removed 2026-11-09, SF-1. Aged rows survive the failure because the direct delete refuses them; security audit M4.) It is a possible follow-up.
- **Performance.** The prune scans about 3,000 audit rows and 4 invitations once a night, so no index is needed. The policies evaluate one comparison per row, on tables with few rows. ~~The trigger's delete runs only when a store is deleted.~~ (Removed 2026-11-09.) No edge function is involved, so there is no cold start.
- **Ordering.** Apply the migration before the push. Once it is applied, the 2026-08-22 PO is protected even if the client release slips, which satisfies R5.

## Implementation notes

### Build step 1: rolled-back probe (run 2026-11-08, before anything else was written)

Run on the local stack (schema at `20261108000000`) in a rolled-back transaction, with the three restrictive policies and no trigger, as the admin JWT (`11111111-…`, brand A, which can see the store).

**Result: the expected 23503 did NOT reproduce.** The design's "If it does not reproduce" note applies, so the trigger stays, and it is pinned by a `pg_trigger` catalog arm. **Outcome, 2026-11-09:** the post-impl review removed the trigger (SF-1). See "Review fixes, 2026-11-09" below.

| Case | Result |
|---|---|
| Design's probe: `delete from stores` on a store with one item and a 200-day waste row naming it | **`DELETE 1`, no error.** Store, item and waste row all gone (read back as `postgres`) |
| Same, after `set constraints all immediate` | Same. No deferred check is hiding it. `waste_log_item_id_fkey` is `condeferrable = f` in any case |
| Same, with the design's L188 step first (0 rows removed from the aged row) | Same, `DELETE 1` |
| Control: a store whose item has a `po_items` line | `23503 po_items_item_id_fkey`. This is the spec 179 T32 behaviour, so the probe can see this class of failure |
| Control: `delete from inventory_items` directly, with the waste row naming the item | `23503 waste_log_item_id_fkey` |
| Reversed firing order: `inventory_items_store_id_fkey` re-created in the transaction so `stores → inventory_items` fires **after** `stores → waste_log` | `DELETE 1`, no error |

The local firing order is the one the design feared: `stores → inventory_items` is `RI_ConstraintTrigger_a_18882`, ahead of `stores → waste_log` at `..._18892`. It still does not fail.

**Why (inferred from the results above, not read from the Postgres source).** The cascade's own NO ACTION checks do not fire at the end of its sub-statement. They appear to queue behind the parent statement's remaining RI events. `waste_log` is a direct child of `stores`, so its cascade runs before the `waste_log.item_id` check, whichever order the two `stores` triggers fire in. `po_items` is two levels down (`stores → purchase_orders → po_items`), so its check still runs too early, which matches spec 179's finding. The design's reading of spec 179 ("a NO ACTION check fires at the end of each RI cascade sub-statement") is therefore not accurate for a direct child.

**What this changes:**
- The "stranded store delete" hazard in the design did not reproduce in either firing order, so the `stores_clear_waste_log_before_delete` trigger is defence in depth here, not a fix for an observed failure. It is kept, as the design instructs. Whether it should stay is a question for the architect's post-impl review. Prod's order is still unread, but both orders were tried here. **Outcome, 2026-11-09:** removed by the review. Prod's order has since been read (2026-11-08, by the main session, read-only): `stores → inventory_items` (`RI_ConstraintTrigger_a_28254`) fires before `stores → waste_log` (`…_28264`), the same as local. See "Prod apply additions".
- AC-26's "trigger removed → AC-19 fails" row has nothing to fail. The catalog arm replaces it, and an extra arm with the store FK dropped in-transaction proves the trigger body clears rows, because a catalog arm alone would pass with a no-op body. **Outcome, 2026-11-09:** both arms (P-2 trigger shape, T-3) were removed with the trigger. P-2 now pins the FK shape and RI order, and a new AC-26 row re-creates `waste_log_store_id_fkey` without CASCADE.

### Build deviations (fixtures and method only; the design's objects are as written)

| What | Design said | What was done, and why |
|---|---|---|
| PO lines in the AC-19 and AC-20 fixtures | `item_id` NULL | **POs are unlined.** `po_items_check_store` refuses a NULL `item_id` with 42501, so that row cannot be inserted. An item-linked line blocks the store delete, which arm T-2 pins. Neither AC names `po_items` |
| AC-20 fixture PO | Not specified | Carries an explicit `po_number`. `generate_po_number` is SECURITY INVOKER, so its `max()` sees only POs the caller can read. A numbered PO in a foreign brand made the brand-A admin's AC-18 insert compute the same number and fail on `purchase_orders_po_number_key` |
| AC-26 trigger row | Trigger removed → AC-19 fails | Replaced as the design's note instructs. P-2 is the `pg_trigger` catalog arm. T-3 is added: it drops `waste_log_store_id_fkey` in the transaction so only the trigger body can remove the row, because P-2 alone passes with a no-op body. **Outcome, 2026-11-09:** removed with the trigger (SF-1) |
| Applying the migration locally | `npm run dev:db` stack | Body run with `psql`, then the version row inserted, which is the prod-apply shape. `npx supabase` is CLI 3.0.0 here and refuses `supabase/config.toml` (`[inbucket] … is no longer supported`). **No `supabase db reset` or fresh boot was run**, because the local database is shared with other sessions, so the first CI run is the first fresh-build proof |

### AC-26: temporary changes, tried by hand on 2026-11-08

> **History, 2026-11-08, against the 72-arm file with the trigger.** The 2026-11-09 re-run against the 70-arm file is under "Review fixes, 2026-11-09" and is the current record.

Each change was added inside the test's own transaction, in a scratch copy of the test file run through `scripts/test-db.sh`. It rolled back with the file, so no mutant was ever committed to the shared local database or written to the working tree.

| Temporary change | Arms that must fail | Result |
|---|---|---|
| Prune body made a no-op | AC-4 | **Failed as required:** A4-1, A4-2, A4-3, A4-4, plus A25 (5 of 72) |
| Prune also deletes old `purchase_orders` | AC-6 | **Failed as required:** A6-3, A6-4, A6-5, A6-6, plus A14-1/2/3, A15-1/2/3, A19-0, A21 (12 of 72) |
| Audit cutoff set to 60 days | AC-5 (89-day row) | **Failed as required:** A5-1 only (1 of 72) |
| Audit cutoff set to 120 days | AC-4 (91-day rows) | **Failed as required:** A4-1, A4-2, A4-3, plus A25 (4 of 72) |
| Stale-client protection removed | AC-15 | **Failed as required:** A15-1, A15-2, A15-3, plus P-1, A14-2/3, A16-1/2, A17-1/3/5/7/10, A19-0, A19-4, A21, T-1, T-2 (18 of 72) |
| Trigger removed (design addition, per step 1) | P-2 and T-3, not AC-19 | **Failed as required:** P-2, T-3 only (2 of 72). A19-* pass without the trigger, which confirms step 1 |
| Trigger body made a no-op (added here) | T-3 | **Failed as required:** T-3 only (1 of 72) |
| Age limit widened to 89 days (design addition) | AC-17 | **Failed as required:** A17-1, A17-3, A17-5, A17-7, A17-10, plus P-1 (6 of 72) |

Afterwards: `git status` shows no mutated file. The local `prosrc` md5 of both functions equals the md5 of the bodies in the migration file (`643a2e78…` prune, `94bdff63…` trigger function; the trigger function was removed 2026-11-09). The three policies, the enabled trigger, `waste_log_store_id_fkey` (`c`) and the cron row all read back as the migration defines them, and no fixture store remains.

### Local verification results (2026-11-08)

| Check | Result |
|---|---|
| New pgTAP file | 72 of 72 pass (2026-11-08; 70 of 70 after the 2026-11-09 review fixes) |
| Whole pgTAP suite, `scripts/test-db.sh` | 96 of 96 files pass, including `permissive_policy_lint` and `generate_po_number_malformed_guard`. Run twice, the second time with spec 187's in-progress migration and test edits in place. The committed `HEAD` copies of `audit_log_rls_hardening` (54) and `super_admin_policy_parity` (20) were also run separately and pass, so AC-23 does not rest on another session's edits |
| Full `npx jest` | 296 of 296 suites, 3,770 of 3,770 tests |
| `npm run typecheck:test` | Passes |
| `npm run typecheck` | **Exits 2 in this checkout, unrelated to this spec.** All 24 errors are TS2688 from empty `node_modules/@types/* 2` folders dated Oct 26 (`node_modules` is gitignored). They also stop `tsc` before semantic checks, so that run proves nothing. The same config with `--types` naming the real packages exits 0 with 0 errors. A clean `npm ci` should not have those folders, but that was not run here |
| AC-1: `cron.job` readable from the test path | Yes. J-1 to J-3 pass through `scripts/test-db.sh` (`psql -U postgres`). This confirms the design's recollection: `cron.job` has RLS on, FORCE off, and policy `cron_job_policy` of `username = CURRENT_USER`. The new job's `username` is `postgres` |
| CLI version against CI's pinned 2.106.0 | **They differ.** Homebrew `supabase` is 2.95.4, `npx supabase` is 3.0.0, and the running images are `postgres:17.6.1.084` and pg_cron 1.6.4. As the design says, the first CI run is the real proof of AC-1 on 2.106.0, and it arrives after the prod apply |
| Tests pinning the old behaviour | None remain. `cleanupOldRecords` under `src/` returns nothing. Other 90-day mentions are the EOD History copy and report ranges, unrelated. `src/lib/auth.ts:400` stays, as the spec says |
| Browser | Not exercised. The change removes a background call and has no visual surface |
| Track 3 and Track 4 | Not run. The spec needs no smoke, and no e2e test touches this path |

### Direct-delete search on `purchase_orders`, `waste_log`, `pos_imports`

Searched `src/` (including `src/screens/staff/`), `supabase/functions/`, `supabase/migrations/`, `scripts/` and `e2e/`, across line breaks, plus tables passed by variable and REST `DELETE` calls. The design's "no other caller" claim holds for application code.

| Where | What | Effect of the new policies |
|---|---|---|
| `src/lib/db.ts:189` | `deleteStore`'s `waste_log` delete | Known. Aged rows refused, the FK cascade removes them (A19-4, A19-7). (Revised 2026-11-09: originally "trigger removes them") |
| `src/lib/db.ts:1861`, `:2023` | PO rollback, by id, seconds old | Admitted (A18) |
| `src/screens/staff/` | None. Its deletes are `user_count_orders` and `user_count_drafts` only | None |
| `supabase/functions/` | None | None |
| `supabase/migrations/` | No SQL `delete from` on these tables | None |
| `e2e/global-teardown.ts:98-102` | **Not in the spec's list.** Deletes `purchase_orders` by store id | None. It uses the service-role client, which has BYPASSRLS, and only runs against the local stack |
| `supabase/tests/generate_po_number_malformed_guard.test.sql` | Unfiltered delete as `postgres` | None. Owner bypass, and the file passes (AC-27) |

### Review fixes, 2026-11-09

Applied on the owner's "Apply the fixes" (2026-11-09), covering steps 1 to 5 of [reviews/release-proposal.md](186-retention-purge-server-job/reviews/release-proposal.md). The migration is not on prod, so `20261108120000` was edited in place under the same version.

| Fix | What changed |
|---|---|
| **SF-1** | Migration: the trigger section, `tg_stores_clear_waste_log()`, its comment, revoke and grant, and the `drop trigger` / `create trigger` removed. The header's item 3 folded into item 2, the audit comment renumbered to (3), "both functions" → "the function", and the `waste_log` policy comment now says FK cascades from stores bypass RLS. No `drop trigger` / `drop function` added. `db.ts` L188 comment now names the FK cascade. Test file 72 → 70 arms: P-2 replaced (FK shape plus RI order), P-3 narrowed to `audit_log`, `invitations` and the prune, P-6 and T-3 removed, the `TrigBody` store and T-3 fixture removed, the arm map and T-1 / T-2 comments reworded. Design text marked superseded, with dates |
| **SF-2** | "Rollback → Mechanics": removing the file and version row now applies only to a prod apply that failed before commit. After commit, rollback is a forward migration or a job-only MCP change, and the policies stay unless the owner decides otherwise |
| **M5** | "Prod apply" step 1 now points to the extended checks. "Prod apply additions" gains the auditor's four queries, the architect's A1 to A3, a local baseline with the expected prod result, the prod RI order, `cron.job.username = postgres` as a stop condition, and the three policy comments in step 4 |
| **Wording** | Migration L12-13 margin sentence ("every row the old purge targets is refused"); the `admin_delete_audit_log` comment's N3 sentence narrowed to `audit_log`; `useStore.ts` spec 176 comment drops the stale "cleanup" tail; the age-limit rollback row says the policy comments and P-1 / A17 change with it |

**Shared local database, by hand, once** (no `db reset`). Before running, `pg_stat_activity` showed only the two realtime replication connections, and `pgtap` was not installed, so no pgTAP run was in progress. In one transaction with `lock_timeout = '5s'`: `drop trigger if exists stores_clear_waste_log_before_delete on public.stores`, `drop function if exists public.tg_stores_clear_waste_log()`, and the two changed `comment on policy` statements copied verbatim from the migration (`waste_log_restrict_delete_aged`, `admin_delete_audit_log`). The comments were re-applied because step 4 of the prod apply compares prod's comments with local. Output: `DROP TRIGGER`, `DROP FUNCTION`, `COMMENT`, `COMMENT`, `COMMIT`.

**Re-verification, run one at a time:**

| Check | Result |
|---|---|
| New pgTAP file | First run: 69 of 70, with P-2 failing on my own expected string (`format()` renders booleans as `f`/`t`, not `false`/`true`). Fixed the expected value, then **70 of 70**. Re-run after spec 189's migration landed: **70 of 70** |
| Whole pgTAP suite, `scripts/test-db.sh` (finished 22:15 EST) | **97 of 97 files pass**, exit 0 |
| Whole suite again (22:19 EST), after spec 189's uncommitted `20261109120000_admin_eod_replace` was in the shared database | **95 of 97.** `eod_update_notifications.test.sql` fails with `staff_submit_eod: p_entries must be a non-empty array` (that migration, L373). `report_last_order_context.test.sql` fails with a duplicate on `eod_entries_submission_item_uidx` (that migration, L102). Neither file is spec 186's or modified in the tree. Left for the spec 189 session. I could not tell exactly when that migration was applied: its version row has no `statements`, and the file was last modified at 22:17:37 |
| AC-26, re-run against the 70-arm file (table below) | Every row fails the arms it must |
| Full `npx jest` | **296 of 296 suites, 3,771 of 3,771 tests**, exit 0 |
| `npm run typecheck:test` | Exit 0 |
| `npm run typecheck` | Exit 2: the 24 TS2688 errors from the empty `node_modules/@types/* 2` folders, as before |
| `tsc --noEmit --types <the 24 real @types packages>` | **Exit 2, 1 error, not spec 186's:** `src/store/useStore.ts(3164,3): TS2322` — `submitEOD`'s implementation returns `void` where spec 189's in-progress interface change (`useStore.ts` ~L770) now declares `() => void`. That session was editing the file during this run. Not touched |
| Search for `tg_stores_clear_waste_log` and `stores_clear_waste_log_before_delete` (repo, excluding `node_modules`, `.git`, `.claude`) | Only spec 186 history: this spec (9 lines after these edits, all superseded or dated text, the removed-object checks, and this note) and its four review files. 0 files in `src/`, `supabase/`, `scripts/` or `e2e/` |
| Local function body vs migration | `md5(prosrc)` of `prune_audit_log_and_invitations` = `643a2e78ee6edc575f98b6af78eec570`, equal to the md5 of the migration body |
| Local comments vs migration | The prune's comment, the three policy comments and `admin_delete_audit_log` all match the migration text |
| Removed objects | `pg_trigger` 0 rows for `stores_clear_waste_log_before_delete`; `pg_proc` 0 rows for `tg_stores_clear_waste_log`; `stores` has no user triggers |
| Local state after all runs | `waste_log_store_id_fkey` and `inventory_items_store_id_fkey` are `c`; the three policies as defined; cron row `postgres`, active; `pgtap` not installed; 0 `b1860001-%` fixture stores; working tree has no mutant file |

**AC-26, 2026-11-09, 70-arm file.** Each change was injected right after `plan(70)`, inside the test's own transaction, in a scratch copy outside the repo, and run through `scripts/test-db.sh`. Each rolled back with the file.

| Temporary change | Arms that must fail | Result |
|---|---|---|
| Prune body made a no-op | AC-4 | **Failed as required:** A4-1, A4-2, A4-3, A4-4, plus A25 (5 of 70) |
| Prune also deletes old `purchase_orders` | AC-6 | **Failed as required:** A6-3, A6-4, A6-5, A6-6, plus A14-1/2/3, A15-1/2/3, A19-0, A21 (12 of 70) |
| Audit cutoff set to 60 days | AC-5 (89-day row) | **Failed as required:** A5-1 only (1 of 70) |
| Audit cutoff set to 120 days | AC-4 (91-day rows) | **Failed as required:** A4-1, A4-2, A4-3, plus A25 (4 of 70) |
| Stale-client protection removed (three policies dropped) | AC-15 | **Failed as required:** A15-1, A15-2, A15-3, plus P-1, A14-2/3, A16-1/2, A17-1/3/5/7/10, A19-0, A19-4, A21, T-1, T-2 (18 of 70) |
| Age limit widened to 89 days | AC-17 | **Failed as required:** A17-1, A17-3, A17-5, A17-7, A17-10, plus P-1 (6 of 70) |
| **New:** `waste_log_store_id_fkey` re-created without CASCADE | A19-6, A19-7 | **Failed as required:** A19-6, A19-7, plus P-2 and A20 (4 of 70). A20 fails too because `hard_delete_brand`'s cascade through the store is then blocked by the waste row |

**Not done here:** no prod query of any kind; no fresh `supabase db reset` build (CI remains the first fresh proof); the security auditor's re-read of the migration and test file (proposal step 5, last bullet) is for that agent.

### Pending

AC-28 to AC-31 are prod steps and are **not done**: no prod query of any kind was run for this build. They need the owner's go-ahead. Run the "Prod apply" steps and "Prod apply additions" as written.

### Noticed, not changed (possible follow-ups)

- `generate_po_number` computes `max()` under the caller's RLS, so a caller who cannot see the highest-numbered PO computes a number that already exists and the insert fails with 23505. It reproduced here across brands in a test fixture. Existing behaviour, not caused by this spec.
- `npx supabase` resolves to CLI 3.0.0, which refuses this repo's `config.toml`.

## Files changed

**Migrations**
- `supabase/migrations/20261108120000_retention_prune_job.sql`

**pgTAP**
- `supabase/tests/retention_prune_job.test.sql`

**`src/lib/db.ts`**
- `src/lib/db.ts`: removed `cleanupOldRecords` and its section comment; added one comment in `deleteStore` (reworded 2026-11-09 to name the `stores` FK cascade)
  - **Shared file.** The working copy also holds a spec 187 comment hunk near L2702 (`create_order_approval`), from another session. It is not part of this spec, so stage this spec's two hunks separately.

**`src/store`**
- `src/store/useStore.ts`: removed the store-load call and its comment; 2026-11-09, removed the stale "cleanup" from the spec 176 R-3 comment's tail list (~L2255)
  - **Shared file.** As of 2026-11-09 the working copy also holds spec 189 hunks (`submitEOD` interface ~L770 and implementation ~L3165 onward), from another session. Stage only this spec's two hunks.

**Jest: mock entry removed (16 files)**
- `src/store/useStore.test.ts`
- `src/store/useStore.switching.test.ts` (also the comment at L17)
- `src/store/useStore.updateStore.test.ts`
- `src/store/useStore.activeBrand.test.ts`
- `src/store/useStore.lateResultGuards.spec176.test.ts` (also the `expectNoTails` line)
- `src/store/useStore.lastOrderContext.spec151.test.ts`
- `src/store/useStore.sessionLoss.spec152.test.ts`
- `src/store/useStore.reorderReload.spec175.test.ts`
- `src/store/useStore.createPoDraft.spec125.test.ts`
- `src/store/useStore.recordExportedOrder.spec156.test.ts`
- `src/store/useStore.updateItem.catalogRevert.spec173.test.ts`
- `src/store/useStore.lastCounted.spec160.test.ts`
- `src/store/useStore.approveOrder.spec149.test.ts`
- `src/store/useStore.fillCartForVendor.spec138.test.ts`
- `src/store/useStore.storeGate.spec161.test.ts`
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`

**Spec**
- `specs/186-retention-purge-server-job.md`

## Prod apply, 2026-11-10

Owner's go-ahead: "Yes, apply to prod" (2026-11-09, local time). Applied by the main session through the Supabase MCP, before the commit and the push. The applied body is the staged file, md5 `3a9076d7aaeab0c34fb8c0dedbef0094`.

**Step 1, read-only, 03:29 UTC.** Every check matched "Expected on prod before apply" except Q1:
- Stores FKs all `c`. No FK into or delete trigger on `audit_log` or `invitations`. Both owned by `postgres`, FORCE RLS off. A1 = 0, A2 = 0, `server_version` 17.6, `current_user` postgres.
- Q2: the 5 PERMISSIVE rows only. Q3: the 7 expected rows with `staff_submit_eod` (t), all in `public`. Q4: 0 rows. Q5: the 9 expected rows.
- **Q1 showed 7 jobs, 2 beyond the expected column:** `breadbot-nightly-sync` and `weekly-reminder-cron`. Both were in the prod job list given to the architect on 2026-11-08; the baseline column omitted them. Checked before applying: both are `net.http_post` calls to edge functions whose only deletes are on `push_subscriptions` (`breadbot-nightly-sync` only inserts `pos_imports` and `pos_import_items`), so neither deletes a kept table. Not a stop.
- First-run query: `audit_would_prune` 0 (oldest 2026-08-12 07:00 UTC; the live client purge is still running), store-less 0, NULL `created_at` 0, `invites_would_prune` 0. Business tables: `eod_submissions` 229, `eod_entries` 3,470, `purchase_orders` 4, `po_items` 53, `vendor_order_attempts` 0, `waste_log` 0, `pos_imports` 0, `pos_import_items` 0.

**Steps 2-3.** The migration body and `insert into supabase_migrations.schema_migrations (version, name) values ('20261108120000', 'retention_prune_job')` ran in one transaction (`statements` NULL, matching the spec 178 row).

**Step 4, verified against local, 03:30 UTC.** All identical:
- `prune_audit_log_and_invitations()`: whitespace-normalized md5 `576a9ff62d01e01b1827e340fe94a2ac`, `prosecdef` t, `search_path=public, pg_temp`, owner `postgres`, ACL `{postgres=X/postgres}`, comment md5 `c090f81f…`.
- `cron.job`: `prune-audit-log-and-invitations`, `47 8 * * *`, active, username `postgres`, command `select * from public.prune_audit_log_and_invitations();`.
- The three policies: RESTRICTIVE, DELETE, roles `public`, with the expected `qual`. Comment md5s: `purchase_orders` `19b31c66…`, `waste_log` `3e6fcbcc…`, `pos_imports` `27bd32e4…`, `admin_delete_audit_log` `4d8ddbc8…`.
- No user trigger on `stores`.

**Step 5, 03:30 UTC.** Unchanged from step 1. The 2026-08-22 PO is present (1 row).

**Still open:** AC-30 (push and both gates green), AC-31 (on or after 2026-11-21), the first scheduled run's `cron.job_run_details` check, and the first fresh-build proof on CI.

