# Backend architect post-implementation review: spec 186

Reviewed on 2026-11-08 against the "Backend design" section of the spec. I read the files and ran nothing: no local database, no prod. Results quoted from "Implementation notes" and the owner's prod query are other people's runs. Specs 187 to 189 are out of scope.

**Result: 0 Critical, 2 Should-fix, 7 Minor.** The build matches the design. The main change is to the design: `stores_clear_waste_log_before_delete` should come out, and that has to happen before the prod apply.

## Ruling: remove `stores_clear_waste_log_before_delete`

**Remove the trigger and its function. Leave aged waste rows to the FK cascade.** This changes no record outcome and does not reopen the owner's decision: store deletion removes the same rows, with the same authority, a moment later.

### The design's reason no longer holds

My instruction was to keep the trigger if the 23503 did not reproduce, "since prod's order is unknown". That was the only remaining reason, and it is now gone:

- **Prod's order is known.** `inventory_items` fires before `waste_log` on prod, as it does locally. This is the order the design feared.
- **That order was tested directly.** The store delete succeeded with an item-linked 200-day waste row, as an admin JWT, with the restrictive policies in place.
- **The other order was tested too.** It also succeeded, so the ruling would stand even if prod's order later changed.

### The hazard came from my misreading

Design L358 relied on spec 179 L1030 ("fires at the end of each RI cascade sub-statement"). The fuller correction in the same spec, L459-462, says a cascade's `DELETE` queues its RI events into the top-level statement's queue, and they fire in queue order. That model predicts all of the probe's results:

| Case | Queue order under that model | Result |
|---|---|---|
| Aged waste row names an item in the store | `stores → waste_log` is queued by the store row itself. The `waste_log.item_id` check is only queued once `stores → inventory_items` runs, so it sits behind every action on the store row, in either order | No failure (probe) |
| Item has a `po_items` line | The check and `purchase_orders → po_items` are both one level deeper, and the check is queued first | 23503 (probe control, spec 179 T32) |
| Direct `inventory_items` delete | The check fires at the end of that statement, while the waste row still exists | 23503 (probe control, A19-1) |

**How firm this is:**

- The queue model is empirical, from specs 179 and 186. It is not read from Postgres source.
- As I recall, RI actions run through `SPI_execute_snapshot` with `fire_triggers = false`, which queues their AFTER events on the outer query. I did not check that here, and nothing below depends on it.
- The ruling rests on the observed results in both orders, not on the explanation.

**Optional probe to test the explanation, about one rolled-back transaction.** Re-create `inventory_items_store_id_fkey` so it fires after `stores → purchase_orders`, then delete a store whose item has a `po_items` line. The model predicts success. If it still raises 23503, the explanation is wrong and the design should be looked at again. The ruling does not wait on this.

### Weighing both sides

| | Keep the trigger | Remove the trigger |
|---|---|---|
| Rows deleted | `waste_log where store_id = old.id` | The same rows, by the same FK cascade |
| Who can trigger it | Callers passing `privileged_delete_stores` | The same callers |
| Failure it guards against | None reproduced, in either order | Not applicable |
| If the ruling is wrong | Not applicable | The store delete rolls back and nothing is lost. The UI is not told, because `deleteStore` ignores errors. The fix is a forward migration |
| Ongoing cost | A permanent SECURITY DEFINER delete on a table the owner is keeping, one more function to md5-verify on prod, and three test arms. One of those arms (T-3) has to drop an FK just to see the trigger do anything | None |
| Misleading to readers | Yes: the comments imply the cascade cannot handle aged rows | No |

**The case for keeping it is real but small.** The trigger is not dangerous. It has the same authority and the same rows as the cascade, and T-2 shows it rolls back. No other `BEFORE DELETE` trigger on `stores` exists in the migrations, so nothing can veto the store delete after the trigger has run. I found no future change that would make it necessary, because the only way to bring the hazard back is something that deletes items before the store's own RI actions run, and nothing does that. Cross-store waste rows would fail either way, since the trigger only clears the deleted store's rows.

**Its practical reach is also small.** With `inventory_items` before `eod_submissions` and `purchase_orders` on prod, a store whose items have `po_items` lines cannot be deleted. By the same queue order, neither can a store whose items have `eod_entries`, though that part is an unverified inference. So Charles and Towson probably cannot reach this path today. The spec 179 follow-up already sent to the owner covers this.

**Timing.** Migration `20261108120000` is not on prod (AC-29 is open), so the file can still be edited under the same version. After the prod apply, removal would need a forward migration.

## Critical

None.

## Should-fix

### SF-1. Remove the trigger before the prod apply

Files: `supabase/migrations/20261108120000_retention_prune_job.sql:15-21,87-112,135`. The full change list follows.

#### Migration

| Lines | Change |
|---|---|
| L15-21 (header item 3) | Replace with: store deletion removes aged waste rows through the FK cascade, and spec 186's probe found no 23503 in either firing order |
| L22, L114, L148 | Renumber: stale-client policies become (2), the audit comment becomes (3). This also settles the code reviewer's marker nit |
| L30 | "both functions" becomes "the function" |
| L86-112 | Delete the section: function, comment, revoke, grant, `drop trigger`, `create trigger` |
| L135 (waste policy comment) | Replace the `stores_clear_waste_log_before_delete` sentence with: "FK cascades from stores bypass RLS, so store deletion still removes aged rows." |

Do **not** add `drop trigger` or `drop function` to the migration. Neither object has existed outside the shared local database.

#### Shared local database, one manual step

The body was applied locally with `psql` and the version row exists, so editing the file does not remove the objects. Local would then differ from the migration without any warning.

Run this once with `psql`, without `supabase db reset`:

```sql
drop trigger if exists stores_clear_waste_log_before_delete on public.stores;
drop function if exists public.tg_stores_clear_waste_log();
```

Then confirm that `pg_trigger` and `pg_proc` no longer list them and that the prune's md5 is unchanged.

#### `src/lib/db.ts`

- **L188:** change the comment to "waste_log rows over a day old are refused here and removed by the stores FK cascade (spec 186)".
- **L183 (optional):** widen it to agree with L188, as the code reviewer suggested.

#### `supabase/tests/retention_prune_job.test.sql`, plan 72 becomes 70

| Lines | Change |
|---|---|
| L69 | `plan(70)` |
| L9, L11, L25-26 | Update the arm map: P-2 is now the FK shape, P-6 is gone, and T-1 and T-2 lose the trigger wording |
| L32-36 | Replace with: A19 is the regression arm for the store delete, because its waste rows name the store's item and both firing orders were probed |
| L136, L270-272 | Remove the `TrigBody` store and the T-3 fixture |
| L315-324 (P-2) | **Replace.** Pin what store deletion now relies on: `waste_log_store_id_fkey` is `c`; `waste_log_item_id_fkey` is `a` and not deferrable; the `stores → inventory_items` RI trigger name sorts before `stores → waste_log`. The last part keeps A19 on the feared order, and a failure means someone should re-read this ruling |
| L326-342 (P-3) | Narrow to `audit_log` and `invitations`. Expect 1 function, named `prune_audit_log_and_invitations`, with its owner compared to `audit_log`. Only the prune relies on owner bypass now |
| L363-370 (P-6) | Remove. P-5 covers AC-10 |
| L639-640, L850 | Reword the comments. T-1 and T-2 stay: T-1 pins that staff cannot remove kept rows by deleting a store, and T-2 pins that a failed store delete leaves them in place. Both already passed with the trigger removed (AC-26 "Trigger removed" row) |
| L859-869 (T-3) | Remove. This also stops the file taking a lock on `waste_log` for an `alter table` on a shared stack |

P-7 can keep its number.

#### Spec: mark as superseded, do not rewrite history

Add a dated note at the top of the design section that points to this ruling.

| Lines | Change |
|---|---|
| L332 | Decisions row: three policies only |
| L338 | `deleteStore` row: reference the FK cascade |
| L358-381 | Mark the hazard, the fix and the rejected alternatives as superseded, and name the misreading of spec 179 |
| L403-405 | Remove step 3 and renumber |
| L424 | "The trigger and the prune" becomes "The prune" |
| L455 | New `deleteStore` comment wording |
| L490-493 | Reword the extra arms and narrow the precondition arm |
| L512 | Replace the trigger row in AC-26's additions |
| L520 | New comment: store deletion relies on all three cascades, so this remains a stop condition |
| L533-536 | Narrow the query and its comment to `audit_log` and `invitations` |
| L542-543 | Remove "The `stores` trigger is enabled". "Both new functions" becomes "The new function" |
| L555 | Replace the rollback row (below) |
| L576 | Remove "The trigger narrows it for aged rows only." |
| L577 | Remove the trigger's performance sentence |
| L586, L602-603, L611 | Add the outcome: removed by this review. L602's "Prod's order is still unread" is out of date, so record the order the owner read on 2026-11-08 |
| L625-626 | Replace both trigger rows (below) |
| L629, L635, L652 | Update the trigger md5, the 72 count, and "trigger removes them", which becomes "the FK cascade removes them" |

**New rollback row for L555.** If a store delete ever raises 23503 on `waste_log_item_id_fkey`, nothing has been lost. Ship a forward migration that adds a `BEFORE DELETE` trigger as described in the superseded design.

**New prod-apply checks in step 1. Stop if either of the first two fails:**
- Version `20261108120000` is absent from `schema_migrations`.
- No `stores_clear_waste_log_before_delete` exists in `pg_trigger`.
- Record `server_version`, to compare with the local image the probe used (`postgres:17.6.1.084`). This is for the record and is not a stop condition.

**AC-26 must be re-run.**
- The recorded failure lists and "of 72" totals no longer describe the file, so re-run each mutation against the 70-arm file.
- Add one row: re-create `waste_log_store_id_fkey` without CASCADE, inside the test transaction. A19-6 and A19-7 must fail. A19 now carries the store-delete guarantee and has never been shown to fail. This mutation could not bite while the trigger existed.

**Other re-runs:** the new pgTAP file, the whole pgTAP suite, and a `src/` search showing the only `tg_stores_clear_waste_log` mentions left are in spec history. Jest and typecheck are affected only by a comment.

**After the edit:** re-read the migration and test file only. `security-auditor` should see this ruling, since it removes a SECURITY DEFINER function from its scope.

### SF-2. The pre-push rollback contradicts "do not drop a restrictive policy"

Files: spec L554, L560; migration L33-34.

L560 says that before the push you "run the rollback through MCP, delete the version row from `schema_migrations`, and remove the file". L554 and the migration header forbid dropping the policies. Before the push the live client purge is still running, so the policies are what protect the 2026-08-22 PO. Following L560 leaves one of two bad states:

- **The policies are dropped:** age-based PO deletion is back from 2026-11-20. This is the exact outcome R5 exists to prevent.
- **The policies stay and the file is removed:** prod holds policies that no migration declares, fresh builds and CI do not have them, and `db-migrations-applied.yml` cannot see the difference, because the version row is gone too.

**Fix:** limit L560 to a prod apply that failed before commit. Once the migration has committed, the file and version row stay. Any rollback, including one of just the job, is a forward migration or an MCP change to the job alone, and the policies stay unless the owner decides otherwise.

## Minor

1. **Migration L12-13: the margin sentence reads backwards.** "A device clock up to 89 days fast still cannot reach a refused row", yet every row such a clock targets *is* a refused row. Use design L388's meaning: "every row such a clock targets is refused".
2. **`src/store/useStore.ts:2244`: stale tail list.** The spec 176 comment still lists "cleanup" among the store-load tails. AC-11's search looks for `cleanupOldRecords`, so it misses this. Remove the word.
3. **Migration L151: N3 needs narrowing.** I agree with the code reviewer: write "at the boundary is harmless for audit_log (N3)", because R3 says this does not carry over to kept records.
4. **Spec L553: the age-limit rollback is incomplete.** `alter policy` also makes the policy comments ("1 day old") and arms P-1 and A17 wrong. Say that these change together. After the push it is a forward migration, like everything else.
5. **Spec L540-541: prod checks lack an expected value.**
   - `cron.job.username` has no stated value. Local is `postgres`, and the function grants execute only to `postgres`. Stop if prod differs, because the job would otherwise fail with only `cron.job_run_details` to show it.
   - L541 also omits the three new policy comments, so add them.
6. **Line references have shifted.** The new comment moved `deleteStore`'s statements to L185, 186, 187, 189, 191 and 192. Spec AC-19 and test labels such as `a19_l188`, `a19_l190` and A19-4 to A19-6 use the old numbers. Name the statements rather than lines the next time this file changes.
7. **Fresh-build proof comes after the prod apply.** Notes L612 and L641 record this: the body was applied with `psql`, no fresh boot was run, and local CLIs differ from CI's 2.106.0. The design accepted this and the risk is low, since the migration is additive and uses known shapes. Tell the owner it remains open at AC-29, and confirm the first `test.yml` run on `main` is green.

## Checked against the design, no finding

- **Prune:** signature, `security definer`, `search_path`, both predicates and the grants match. The first-run query uses the same predicates.
- **Job:** name, schedule and command match, and the re-apply block has the reference shape. 08:47 shares no minute with a job defined in the migrations.
- **Policies:** the three names and USING clauses match, they are RESTRICTIVE with no `to` clause, and their comments carry the `spec 186: ` prefix. `store_member_update_*`, which the comments cite, exists on all three tables.
- **`admin_delete_audit_log`:** comment only, and it matches the policy at `20261022000000` L152-162. The rollback's L165 reference is correct. `src/` has no remaining `audit_log` delete, so "new builds have no caller" holds.
- **Writers:** none of the `src/` inserts I checked set `logged_at`, `imported_at` or `created_at` on these tables, and `supabase/functions/` has no `logged_at` or `imported_at`. This supports "every current writer uses the default", though I did not read every RPC.
- **`db.ts` and `useStore.ts`:** the removal is clean, and nothing bypasses `db.ts`.
- **Build deviations, all accepted:** unlined POs (the design's NULL `item_id` was wrong, as `po_items_check_store` refuses it), the explicit `po_number`, and the design's AC fixture constraints.
- **Realtime:** no publication change, so no restart step is needed.

## Noticed, out of scope

- **Spec 179 wording.** L1030, L1040 and the comment at `inventory_items_identity_lock.test.sql:185-187` describe the check as firing at the end of a sub-statement, which led to my error. L459-462 is the better account. L1040's "probably applies to `waste_log`" is now disproved for same-store item rows. A small correction would stop this being repeated.
- **Brand order on prod.** The query covered `stores` only. Spec 179 L1042's concern about brand order is not settled, and this ruling does not need it.
- **Existing store-delete limit.** Prod's order confirms the store-delete limit in spec 186's Risks section applies to PO lines there, on the queue model. It is still not tested on prod.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix, 7 Minor findings. The ruling is to remove stores_clear_waste_log_before_delete before the prod apply.
payload_paths:
  - specs/186-retention-purge-server-job/reviews/backend-architect.md
