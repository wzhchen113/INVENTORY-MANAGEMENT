## Security audit for spec 186

**Result: 0 Critical, 0 High, 5 Medium, 8 Low.** Nothing here blocks the spec.

- **New privileged paths:** none of them lets a client delete anything it could not already delete.
- **Owner's rule:** on the local schema, nothing deletes a kept record because of its age, apart from the documented wrong-clock residual (L3).
- **Not established:** the same claim on prod. No prod query was run (M5).
- **Kept records can still be lost in other ways.** M1 to M4 are not age-based and all predate this spec. M1 and M2 stay open because the owner's "Keep" covers age-based deletion only (spec L24, L264), and M3 and M4 are outside its scope. The owner should see them, because "kept" is a weaker promise than it sounds.

### Verdict on each new privileged path

| Path | Can it delete what the caller could not already delete? | Evidence |
|---|---|---|
| `prune_audit_log_and_invitations()` | **No client can call it.** Execute is held only by `postgres` and superuser `supabase_admin`. `authenticated` and `service_role` get 42501. It names only `audit_log` and `invitations`. Its invitation predicate matches the old purge, and the old purge already reached all brands because that DELETE policy is unscoped. Its audit reach is wider than any client's by design (spec R1, R4) | Ran P1a, P1f. Catalog ACL. Body read |
| Prune inputs | **A client cannot steer it onto rows.** `audit_log` has no UPDATE policy, and `audit_log_restrict_insert_created_at_now` pins `created_at = now()` on insert. A privileged caller can backdate `invitations.expires_at` only on invitations it may update, and it can already delete any invitation (L6) | Catalog policies |
| `tg_stores_clear_waste_log()` / `stores_clear_waste_log_before_delete` | **No, on the current schema.** It fires only for store rows that pass `privileged_delete_stores`, and the FK cascade would remove those waste rows anyway. A failed store delete rolls it back. Brand-A admin against a brand-B store: 0 rows, waste kept. Staff: 0 rows. Direct call: 42501. See L1 for why it should probably not exist | Ran P1b, P1g, P2b, P2d to P2f, plus T-1 and T-2 |
| Three RESTRICTIVE DELETE policies | **They only narrow access.** They AND with the permissive policies, for all roles. Aged rows return 0 rows and no error for admin, super_admin and staff | Ran P3a to P3c, plus A15, A16 |
| `admin_delete_audit_log` comment | **No behaviour change.** The policy body is untouched | Catalog `qual`, migration L150-151 |
| `search_path` | **Sound.** Both functions pin `public, pg_temp`, with `pg_temp` last, and every relation is schema-qualified. `authenticated` cannot create objects in `public` (42501) | Ran P1e. Catalog `proconfig` |
| pg_cron | **Sound.** The job runs as `postgres`. `authenticated` has no usage on schema `cron`, so it cannot read or schedule jobs (42501) | Ran P1c, P1d. Catalog `cron.job` |

**Owner's rule, table by table (local schema):**

| Table | Age-based deletion left? | Other ways it can still go |
|---|---|---|
| `eod_submissions` | None. No DELETE or ALL policy, and vendor FK is RESTRICT | Store or brand cascade, deliberate |
| `eod_entries` | None. No DELETE or ALL policy | **M3**, plus the cascades |
| `purchase_orders` | None, apart from L3 | **M1**, plus the cascades |
| `po_items` | None. The old purge never targeted it directly | **M2**, plus PO cascade |
| `vendor_order_attempts` | None. No DELETE policy (P3f) | PO and store cascades |
| `waste_log` | None, apart from L3 | **M1**, **M4**, plus the cascades |
| `pos_imports` | None, apart from L3 | **M1**, plus the cascades |
| `pos_import_items` | None | **M2**, plus the import cascade |

Every purge version in git (99d9e56, b98d564, fde965a, HEAD) targets the same six tables, so no older build hits a table the policies miss. `cleanupOldRecords` is gone from `src/`, and the `useStore.ts` diff removes only that call and its comment.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- **M1. `supabase/migrations/20260504173035_per_store_rls_hardening.sql:145,194,264`: any store member can change a kept row's date, then delete it.** Staff ran `update ... set logged_at = now()` and then `delete` on 200-day `waste_log`, `purchase_orders` (status `received`) and `pos_imports` rows, and all three were gone on read-back as `postgres` (P4a to P4g). PostgREST filters would let one request cover a whole store. The design says this openly (spec L390, migration L124, L135, L146), and it does not affect stale clients, which is what R3 targets. *Impact:* the policies stop stale code, not a hostile or compromised staff account, and the threat model does not assume friendly callers. It adds one step to what staff could do before this spec, so it is not a regression. *Fix:* a follow-up `BEFORE UPDATE` guard making the three date columns immutable for non-owner roles. My search found no writer that sets them (`db.ts`, staff subtree, edge functions), so it should be cheap. Needs an owner decision because spec L264 scopes this out.

- **M2. `supabase/migrations/20260504173035_per_store_rls_hardening.sql:243,313`: child rows of kept records have no protection.** Staff deleted a `po_items` line under a 200-day `received` PO and a `pos_import_items` line under a 200-day import, while both parents stayed (P3g, P3h). The owner's table lists both child tables as Keep. No stale statement targets them directly, so this is not age-based. *Impact:* a member can hollow out a received PO or a POS import, leaving the parent looking intact. *Fix:* in a follow-up, limit `store_member_delete_po_items` to parents in `draft` (AC-21 needs that case, and both app callers at `db.ts:1980` and `db.ts:2075` are documented as draft paths, though I did not trace every caller). Limit `store_member_delete_pos_import_items` by the parent's `imported_at`, as I found no app delete of that table.

- **M3. `supabase/migrations/20261024000000_eod_entries_no_need.sql:106,193,201`: `staff_submit_eod` can erase a kept EOD count, at any age, with no audit row.** It is a SECURITY DEFINER RPC callable by any store member. `p_date` has no bound, and `p_entries` may be empty. Staff called it for a 200-day submission with `'[]'`: all entries were gone, the submission stayed, and `submitted_at` was reset to `now()` (P5a, P5b). The audit insert sits inside the per-entry loop, so an empty payload writes none. The UI blocks this, by refusing empty payloads (`src/screens/staff/screens/EODCount.tsx:858`) and offering only today or yesterday (`EODCount.tsx:579`), so it takes a direct API call or a client bug. *Impact:* AC-8 proves there is no DELETE policy, but that is not the same as no delete path. EOD records are the oldest and largest kept set. Predates this spec. *Fix:* in a follow-up, refuse an empty `p_entries`, and bound `p_date` for non-privileged callers. **Interaction:** draft spec 189 plans a replace for the admin path. Its D-4 and AC-25 cover what a re-submit contains, and I found no empty-payload or age bound in my search of it, so it should take the same guards.

- **M4. `src/lib/db.ts:185-192`: a failed `deleteStore` still removes today's waste rows and every staff grant, and the UI reports nothing.** On a store whose item has an `eod_entries` row, L185 and L192 both raised 23503, while L189 removed the fresh waste row and L191 removed the store's `user_stores` rows. The store survived (P6). `eod_entries_item_id_fkey` is NO ACTION, so this should apply to any store with a counted item, which likely means every working store. *Impact:* an admin who "deletes" such a store loses that day's waste records and locks staff out of it, with no error shown. This spec narrows the damage, because aged waste now survives (P6 read-back, aged=1). Spec L576 records the partial failure, and spec L566 says EOD entries "probably" block store deletion: **this probe confirms they do.** So spec L24's "store deletion keeps working" holds only for stores with no counted items and no PO lines. *Fix:* a follow-up single-transaction RPC. Tell the owner now.

- **M5. Spec "Prod apply additions" (L519-544): the kept-record guarantee was only proved locally, and the prod checks do not cover the gaps.** Prod runs jobs this repo does not define (`prune-cron-history`, spec L409). The additions check FK actions, ownership and FORCE RLS, but not these:
  - All prod `cron.job` commands. A job or dashboard-made function deleting a kept table would defeat the spec with no gate noticing.
  - Prod DELETE or ALL policies on the eight kept tables. AC-8 runs only against local.
  - Other `BEFORE DELETE` triggers on `stores`. One that returned NULL could skip the store delete after waste rows were already cleared.
  - An expected value for `cron.job.username`. Spec L540 says to verify it but not what it should be. It should be `postgres`.

  *Fix:* add the queries below to step 1. **Do this before applying.** Read-only and not run here, since prod is out of bounds.
  ```sql
  select jobname, username, active, command from cron.job order by 1;
  select tablename, policyname, permissive, cmd, qual from pg_policies
   where schemaname = 'public' and cmd in ('DELETE','ALL')
     and tablename in ('eod_submissions','eod_entries','purchase_orders','po_items',
                       'vendor_order_attempts','waste_log','pos_imports','pos_import_items');
  select p.oid::regprocedure, p.prosecdef from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosrc ~* '(delete\s+from|truncate)'
     and p.prosrc ~* '(eod_submissions|eod_entries|purchase_orders|po_items|vendor_order_attempts|waste_log|pos_imports|pos_import_items)';
  select tgrelid::regclass, tgname, tgenabled from pg_trigger
   where not tgisinternal and tgrelid = 'public.stores'::regclass;
  ```

### Low

- **L1. `supabase/migrations/20261108120000_retention_prune_job.sql:87-112`: the store trigger is a privileged delete of a kept table with no demonstrated need.** I independently reproduced the build's finding. With the trigger dropped, an admin store delete with an aged, item-linked waste row succeeded in both RI firing orders (P8, P9). Its only observable effect appeared when I switched `waste_log_store_id_fkey` to NO ACTION: with the trigger on, the store delete succeeded and removed the waste row (P10), while with the trigger off the same delete raised the FK error and the row stayed (P10 control). So it adds no protection today, and under FK drift it turns a safe refusal into a deletion. The prod-apply FK check covers prod's current state. Prod's RI order is still unread, but both orders passed here. *Fix:* the architect should consider removing it, along with T-3 and P-2. If it stays, correct what no longer holds: spec L555 (dropping it makes the store fail with 23503, which did not reproduce), spec L358-367, the trigger's reason at migration L100, and the comment above `waste_log` in `deleteStore` (`db.ts:188`).

- **L2. `supabase/migrations/20261108120000_retention_prune_job.sql:45`: `SECURITY DEFINER` on the prune is not needed.** Cron runs as `postgres`, which owns the function and tables. Invoker rights would mean a future mistaken grant exposes nothing beyond RLS. Harmless with today's ACL. It matches the reference shape the design chose.

- **L3. `supabase/migrations/20261108120000_retention_prune_job.sql:121,132,143`: the fresh-row window is 24 hours when the need is seconds.** A stale client more than 89 days fast can still delete rows under a day old on all three tables, as can any store member directly (test A17-8, AC-22, spec L388). The only direct delete that relies on the window is PO rollback, which runs moments after the insert. `deleteStore`'s waste statement does not rely on it. An hour would shrink both exposures. Rows from Breadbot's nightly sync (spec 188) would also become protected sooner.

- **L4. `TRUNCATE` is still granted to `anon` and `authenticated` on the eight kept tables, `audit_log` and `invitations`.** RLS does not govern TRUNCATE, so it would bypass every policy here. `20260618000000_public_grants_explicit.sql:58-62` says it "hardens the whole TRUNCATE-escalation class for every table", but it only omits TRUNCATE from new grants and does not revoke existing ones. **No client path to it was found.** PostgREST has no TRUNCATE verb, and by pattern search `report_run_custom` is the only plpgsql function in `public` with an `EXECUTE` statement. A multi-statement breakout of that runner does parse, but every write attempt failed and the probe row was intact on read-back. R2 and R7 hit the read-only guard (25006). R1 was a syntax error. R3 to R6, which tried to turn read-only off or commit, returned the sanitized P0501, so I did not see their underlying error. That guard is the main layer between an admin's text and a TRUNCATE. *Fix:* in a follow-up, `revoke truncate` on these tables from both roles. Check prod's ACL too, which I did not read.

- **L5. `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:429`: a super_admin can skip `hard_delete_brand`'s pre-flights.** A direct `delete from brands` on a live brand cascaded away its aged waste, PO and POS rows, with no soft-delete step and no `brand_deletion_log` row (P7). `profiles_brand_id_fkey` is SET NULL, so the no-orphan check is skipped too (read from the catalog, and P7's brand had no profiles). Limited to the top role, and it predates this spec. *Fix:* in a follow-up, restrict the ALL policy so deletion goes through the RPC.

- **L6. `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:46` and `src/lib/auth.ts:400`: invitation deletes are unscoped.** The DELETE policy is `auth_is_privileged()` alone, while its UPDATE sibling is brand-scoped, so a brand-A admin can delete a brand-B invitation. The retained `auth.ts:400` delete uses the client's clock, so a fast device can remove live unused invitations across brands. Read, not probed. Spec L264 and L267 scope both out, and the job does not widen them.

- **L7. `supabase/tests/retention_prune_job.test.sql`: two authorization properties are not pinned.** T-1 (L842) tests staff only, so no arm covers a brand-A admin against a brand-B store. It holds today (P2b). P-2 and P-3 (L317, L327) pin `prosecdef` and owner but not `proconfig`, so a later `create or replace` could drop `search_path` with the test still green. `generate_po_number_malformed_guard.test.sql` is one of several tests that read `proconfig`, and could be the model.

- **L8. Spec 188 section 2.3 (`specs/188-breadbot-nightly-sync-repair.md:432-437`): the recipe link on kept POS lines will become erasable.** Once `pos_import_items.recipe_id` is `ON DELETE SET NULL`, deleting a recipe keeps the line but removes it from COGS and variance. The row is kept, so this does not break the owner's rule, but it does weaken what "kept" means for sales history. It also makes the `deleteRecipe` row at spec 186 L286 stale, as spec 188 itself notes.

### Interaction with specs 187 to 189

- **187:** no effect on these tables' protection. `delete-user` deletes only `user_stores`, `profiles` and `invitations`. FKs from kept tables to `profiles` are SET NULL, so rows stay and lose only the actor link. Its `User deleted` audit rows age out at 90 days through the job, as spec 187 L210 accepts. Its migration was already applied locally, so all results here include it.
- **188:** no conflict. It only inserts `pos_imports`, and its bad-data rollback runs as `postgres` with the owner's go-ahead, which is deliberate. See L8.
- **189 (DRAFT):** keeps the no-DELETE-policy rule. See M3.

### What I ran and what I only read

**Ran on local `supabase_db_imr-inventory`, 2026-11-09 about 03:30 UTC:**

- Catalog queries in `default_transaction_read_only=on` sessions: ACLs, roles, policies, grants, FKs, triggers, ownership, `cron.job`, function bodies.
- Four rolled-back probes, each in a `begin ... rollback` with `lock_timeout`. Results were read back as `postgres`. Roles were set with `set local role authenticated` or `service_role`, never `anon` (spec 067), so anon results are catalog only.
  - P1 to P7: client execution, cross-brand and staff store deletes, staff direct deletes, update-then-delete, `staff_submit_eod`, the `deleteStore` statements, direct brand delete.
  - P8 to P10 and the P10 control: trigger or FK changed inside the transaction.
  - R0 to R7: `report_run_custom` payloads.
- `scripts/test-db.sh` on three files: `retention_prune_job` 72/72, `permissive_policy_lint` 5/5, `super_admin_policy_parity` 20/20.
- Migration bodies hashed against local `prosrc`: both match (`643a2e78…`, `94bdff63…`).
- `npm audit --audit-level=high`, plus JSON summaries with and without `--omit=dev`.

**Nothing left behind.** A final read-only check after all probes found no `b186` or `c186` fixture rows in stores, brands, catalog, items, grants, waste, PO, POS or EOD, no `__test_spec186__` audit rows, the trigger and both FKs back as defined (`waste_log_store_id_fkey` and `inventory_items_store_id_fkey` are `c`), `pgtap` not installed, seed user `33333333` back to `master`, 4 cron jobs. Brief locks were held on `stores`, `waste_log` and `inventory_items` during P8 to P10 and T-3. No commit, and no code changed.

**Read only:**

- The spec, migration and test file, the old purge and its git history, `db.ts` delete sites, `useStore.ts` diff, `EODCount.tsx` guards, `delete-user` delete sites, and searches of specs 187 to 189.
- `supabase/functions/` and `src/` were searched for `.delete(`. `scripts/` was searched for SQL deletes on these tables. Deletes on a table passed by variable were not traced by me; the spec's implementation notes report that search.

**Not run or not established:**

- **Prod:** no query of any kind. Every statement here describes the local schema, and prod state comes only from what the spec relays.
- A fresh `supabase db reset` build. The local database has the migration applied by hand (spec L612), so CI is the first fresh proof.
- HTTP calls through PostgREST or Kong. "Refused" results come from SQL under the role and JWT claims, not from real requests. R0 to R7 ran inside a wrapping transaction, not a PostgREST one.
- The full 96-file pgTAP suite, jest and typecheck. These rely on the spec's recorded results.
- The other reviewers' files. I did not read them, to stay independent, so findings may overlap.
- `audit_log_rls_hardening.test.sql`, which another session is editing.

### Dependencies

`package.json` changed in this checkout, but only the `test:smoke` script, and it is not in spec 186's file list. `package-lock.json` is unchanged, so **this spec adds no dependency risk.**

`npm audit --audit-level=high` reports a repo-wide baseline of 46 (1 critical, 17 high, 19 moderate, 9 low), or 37 with `--omit=dev` (1 critical, 16 high, 18 moderate, 2 low). The critical is `shell-quote`. High advisories also reach the direct `@react-navigation/*` packages. Worth a separate dependency pass; I did not assess reachability.

---

## Re-read, 2026-11-09

This is a focused re-read after the review fixes, not a full re-audit. I read the architect's SF-1 ruling, the migration, the test file, and the spec's "Prod apply", "Prod apply additions" and "Rollback" sections.

**Result: 0 Critical, 0 High, 0 new Medium, 3 new Low.** L1 is resolved. M5 is resolved, with one gap (L9). SF-2 is resolved, with one wording gap (L10). M1 to M4 are unchanged and stay open.

### What I ran (local `supabase_db_imr-inventory`, read-only or rolled back)

- The M5 queries and A1/A2 in a `default_transaction_read_only` session. The results match the spec's local baseline row for row (details under question 2).
- Removed objects: 0 rows in `pg_trigger` for `stores_clear_waste_log_before_delete`, 0 rows in `pg_proc` for `tg_stores_clear_waste_log`, and no user triggers on `stores`.
- The prune: `prosecdef` is t, `proconfig` is `search_path=public, pg_temp`, the owner is `postgres`, the ACL is `{postgres=X/postgres}`, and `md5(prosrc)` is `643a2e78…`. All unchanged.
- FKs: `waste_log_store_id_fkey`, `inventory_items_store_id_fkey`, `purchase_orders_store_id_fkey` and `pos_imports_store_id_fkey` are `c`. `waste_log_item_id_fkey` is `a` and not deferrable.
- `scripts/test-db.sh supabase/tests/retention_prune_job.test.sql`: **70 of 70 pass**. The file has 70 assertions, which matches `plan(70)`. Before the run, `pg_stat_activity` showed no other active client and `pgtap` was not installed.
- **Nothing left behind.** Afterwards `pgtap` was not installed, there were 0 `b186%` stores or brands, 0 `__test_spec186__` audit or waste rows, seed user `33333333` was back to `master`, and `cron.job` still had 4 rows. No file changed apart from this review.

### 1. With the trigger gone, can a kept record be lost or a store delete fail in a new way?

**No.** I found nothing my audit had not already covered, and removing the trigger takes away one deletion path.

- **Store delete that succeeds.** `deleteStore`'s direct `waste_log` delete (`db.ts` L188/189) removes only rows under a day old. The `stores` FK cascade then removes the aged rows, with the same authority as before (`privileged_delete_stores`). A19-4, A19-6 and A19-7 pin this, and they pass on the current file. P-2 pins the FK shape and the firing order (C-collation name order, which is how Postgres orders triggers). My earlier P8 and P9 had already shown the store delete succeeds in both orders without the trigger.
- **Store delete that fails.** The cases are the ones M4 already covers: an `eod_entries` or `po_items` line on one of the store's items. The aged waste rows now stay, because nothing deletes them before the store delete. T-2 pins this. Fresh waste rows and grants are still lost, which is M4 as before.
- **FK drift is now safer.** If `waste_log_store_id_fkey` ever stopped cascading, the store delete would now be refused and the waste row would stay (my earlier P10 control). With the trigger, the row would have been deleted. The new AC-26 row proves A19-6 and A19-7 fail in that case, and prod-apply step 1 still treats any non-`c` result as a stop condition.
- **Staff and cross-brand callers.** These are unchanged. They never reached the waste rows except through a store delete that RLS already refuses (T-1, and my earlier P2b).
- **Cross-store waste rows.** `waste_log` has no same-store item guard: the only user trigger is `notify_waste_log`, and `20261025000000` does not cover `waste_log`. So a waste row in store X can name an item in store Y, and that row blocks deleting store Y with 23503. The trigger cleared only store Y's own rows, so this fails the same way with or without it. The architect notes the same point. Nothing is lost, because the delete rolls back. This is a pre-existing denial-of-delete and not new.

### 2. Do the M5 checks and expected prod results cover what I asked for, and is the baseline right?

**Yes. All four queries are in, the `username = postgres` expected value is a stop condition (step 4), and the baseline is correct.** I re-ran every query against local and checked each "Expected on prod" value against the committed migrations.

| Check | Local now | Prod expectation checked against the repo |
|---|---|---|
| A1, A2 | 1, 0 | 0 and 0 are correct. The migration is untracked, and the trigger was only ever applied by hand to local |
| A3 | `17.6` | Record only |
| Q1 | The same 4 jobs, all `postgres` and active | Correct. The other three come from committed migrations. `auto_receive_due_purchase_orders` does not appear in Q3, so it deletes no kept table |
| Q2 | The same 8 rows. The 5 PERMISSIVE policies use `auth_can_see_store`, through the parent for the child tables | Correct. Prod should show the 5 PERMISSIVE rows only |
| Q3 | The same 7 functions | Correct. The last committed `staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)` is in `20261024000000` (L103-110). It is SECURITY DEFINER (L113) and contains the M3 delete (L201). Spec 189's migration replaces it and adds `eod_write_submission` and `admin_submit_eod`; neither existed in a committed migration. Spec 187's uncommitted migration replaces `tg_order_approvals_guard` and `create_order_approval`, whose committed versions delete nothing, so prod has no extra match from them |
| Q4 | 0 rows | Correct: 0 |

The explanatory notes on Q3 (`admin_dedupe_recipes` and the five `report_*` false positives) agree with what I read.

The baseline does assume every committed migration through `20261108000000` is on prod. `db-migrations-applied.yml` covers that, and the Prod apply already requires it to be green.

The gap I found is L9 below. It is Low, and it is something my original M5 list did not ask for, not a defect in what was added.

### 3. Does the rollback text still allow anything that restores age-based deletion?

**Only at the edge of the age-limit row (L10), and only for fast clocks.** SF-2 is fixed:

- Removing the file and the version row now applies only to an apply that failed before commit (spec L615).
- After commit, the three policies stay unless the owner decides otherwise (L616).
- The old pre-push bullet is struck through (L618).
- Dropping a restrictive policy is still marked as needing the owner (L608), and so is the migration header (L29-30).
- The "Client removal" row is accurate. The restored purge targets `eod_submissions`, `waste_log`, `audit_log`, `pos_imports`, `purchase_orders` and `invitations` (HEAD `db.ts` L6243-6253). The three policies refuse it on the three tables that have them, and `eod_submissions` has no DELETE policy.
- The new 23503 row (L610) adds a `BEFORE DELETE` trigger only through a forward migration. That trigger would delete only the deleted store's own rows, which is not age-based. If it is ever re-added as SECURITY DEFINER, the L1 drift behaviour (a refused delete turning into a deletion) returns. That forward migration should get a security review, and P-2 should change with it. This is a note, not a finding.

### 4. Any new Critical or High?

**None.**

### New Low

- **L9. Spec L528-547 and L566-568: prod checks do not look for CASCADE FKs into kept tables from parents other than `stores`, and Q3 only searches `public`.** Local has 9 CASCADE FKs on the eight kept tables, and every one is from `stores` or a kept parent: `eod_entries → eod_submissions`, `po_items → purchase_orders`, `pos_import_items → pos_imports`, `vendor_order_attempts → purchase_orders`, and five from `stores`. *Impact:* if prod had drifted to, say, `waste_log_item_id_fkey` CASCADE, an ordinary `deleteInventoryItem` would silently erase kept waste rows, and no current check would notice. The likelihood is low, because the prod schema was pulled and has been migration-managed since. Q3's `public`-only filter would likewise miss a dashboard-made function in another schema; local has 0 matches outside `public`. *Fix:* in step 1, add the query below and expect exactly those 9 rows, and drop the `pronamespace` filter from Q3, expecting the same 7 rows (or 7 with `staff_submit_eod` on prod).
  ```sql
  select conrelid::regclass, conname, confrelid::regclass from pg_constraint
   where contype = 'f' and confdeltype = 'c'
     and conrelid in ('public.eod_submissions'::regclass,'public.eod_entries'::regclass,'public.purchase_orders'::regclass,'public.po_items'::regclass,
                      'public.vendor_order_attempts'::regclass,'public.waste_log'::regclass,'public.pos_imports'::regclass,'public.pos_import_items'::regclass)
   order by 1, 2;
  ```
- **L10. Spec L602 and L607: the age-limit rollback row understates what a large N re-admits.** "N up to 89 … only shrinks the skew margin" is true. But with N days, a stale client whose clock is more than 90 − N days fast deletes rows aged between 90 − (clock skew) and N days. At N = 89 that means any clock more than a day fast, which is age-based deletion of kept records. L602 says no step does this apart from the one marked as needing the owner. It is the L3 residual made larger, not a new mechanism. *Fix:* either cap N well below 89 (for example 30, which still leaves a 60-day margin), or mark any N above a stated bound as needing the owner, as L608 does.
- **L11. Spec L606 against L616: the Job row says "optionally drop the function", but Mechanics limits a post-commit MCP change to "the job alone".** Dropping the function by MCP after commit would leave prod without a function the migration declares, with no gate noticing. It does not touch kept records. *Fix:* say that dropping the function after commit needs a forward migration.

### Status of earlier findings

| Finding | Status |
|---|---|
| L1 (trigger) | **Resolved** by SF-1 |
| M5 (prod checks) | **Resolved**. L9 is a follow-on |
| L7 (authorization pins) | Partly addressed. P-3 still does not read `proconfig`, although step 4 compares it on prod. The cross-brand store-delete arm is still absent, and my earlier P2b holds |
| M1 to M4, L2 to L6, L8 | Unchanged by this round, and still open as recorded above |

None of these block the spec. The prod apply still needs the owner's go-ahead, and the M5 step 1 checks must run first.
