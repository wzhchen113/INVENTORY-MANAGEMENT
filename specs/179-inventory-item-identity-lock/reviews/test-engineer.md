## Test report for spec 179

Reviewer: test-engineer, 2026-10-26. Track: pgTAP, against the real local Supabase. No file other than this one was modified. No `db reset`, no committed writes. The two destructive experiments (trigger-disabled negative control, the probe DO blocks) ran inside rolled-back transactions or raise-always blocks. Afterwards the local tombstone table has 0 rows and all three new triggers are `tgenabled = 'O'`.

### Acceptance criteria status

Test file: `supabase/tests/inventory_items_identity_lock.test.sql`. Arms are cited as T-numbers, which are the `select ok/is/throws_ok` labels in that file.

- AC-1 (store_id PATCH A to B refused 42501; item unchanged; PO line still resolves to store A) → PASS. `…identity_lock.test.sql::T04` (throws_ok, 42501 + exact message), `::T05` (store_id and the PO line's item store both still A), `::T06` (one-store caller, the lock's message wins before RLS WITH CHECK).
- AC-2 (id PATCH on an approval-only item refused; row unchanged) → PASS. `::T07`, `::T08`. The fixture item iA2 has no `item_vendors` row and no FK reference, so only the lock can be the refuser.
- AC-3 (upsert conflict arm moving store refused; row keeps store A) → PASS. `::T09` (R-1 message, not the R-2 message), `::T10`.
- AC-4 (pass-through allowed) → PASS. `::T11`/`::T12` (SET id=id, store_id=store_id, par_level=7, then re-read), `::T13`/`::T14` (same-store upsert conflict arm, par_level re-read as 9).
- AC-5 (same store_id PATCH as postgres refused) → PASS. `::T15` (store_id), `::T16` (id), `::T17` (read-back). Proves it is not an RLS rule.
- AC-6 (existing writers unaffected, each write asserted as landed) → PASS.
  - perStore PATCH plus `eod_remaining`: `::T18`, `::T19`.
  - real `receive_purchase_order`: `::T20`, `::T21` (stock 10 to 14).
  - real `staff_submit_eod`: `::T22`, `::T23`.
  - `apply_item_scalars_to_brand`: `::T24` (updated_count = 2), `::T25`.
  - `apply_item_vendors_to_brand`: `::T26`, `::T27`.
  - `create_inventory_item_with_catalog`, fresh and untombstoned id: `::T28`.
- AC-7 (every committed pgTAP file that writes inventory_items passes unmodified) → PASS. Full `scripts/test-db.sh`: 92 of 93 files pass. The one red file is spec 178's untracked file (see Notes). No existing pgTAP file is modified by this spec. `git status` shows no unstaged modification. The two staged `M` pgTAP files belong to spec 177.
- AC-8 (member DELETE accepted; exactly one tombstone (id, store A); member can't read it) → PASS. `::T29`, `::T30`, `::T31`. The AC text says "store-A item" but the fixture uses a store-B item and a Frederick member. This is the same property, and the design chose it because the member must be able to see the store.
- AC-9 (store cascade writes a tombstone per item) → PASS, but the fixture was re-pinned (deviation 2, assessed below). `::T32` (admin deletes S_C), `::T33`, `::T34` (2 tombstones, each carrying S_C's id).
- AC-10 (brand cascade) → PASS under the AC's own escape clause ("the AC pins whatever is true"). The AC is re-pinned to the actual behaviour: `::T35` (23503 on the exact `inventory_items_catalog_id_fkey` message), `::T36` (nothing removed), `::T37` (aborted cascade leaves 0 tombstones). There is no positive brand-cascade to tombstone arm, and none is constructible today (see Notes).
- AC-11 (cross-store reinsert refused) → PASS. `::T38` (anti-vacuity: the approval is pending and names iB2), `::T39`, `::T40`, `::T41` (42501 plus the R-2 message), `::T42`.
- AC-12 (the same reinsert as postgres refused) → PASS. `::T43`, `::T44`.
- AC-13 (same-store reinsert allowed) → PASS. `::T45`, `::T46`, `::T47`.
- AC-14 (repeat delete idempotent; tombstone maps id to store B only) → PASS. `::T48`, `::T49`.
- AC-15 (po_items-referenced item still can't be deleted; no tombstone left) → PASS. `::T50` (23503, exact FK message), `::T51`.
- AC-16 (tombstone table lockdown for anon and authenticated) → PASS. SELECT: `::T55` (authenticated), `::T56` (anon, catalog form). INSERT: `::T57` (authenticated, 42501 plus the exact RLS message), `::T58` (anon, catalog form). UPDATE/DELETE: `::T59` (authenticated), `::T60` (anon, catalog form), `::T61` (count unchanged against the `::T54` snapshot, and the (B1, store B) row intact). TRUNCATE: `::T62`, `::T63` (`has_table_privilege` false). No policy, RLS on and not forced: `::T64`. Not published: `::T65`. `::T54` proves the table is non-empty, so `::T55`, `::T59` and `::T61` aren't vacuous.
- AC-17 (function privileges, prosecdef and search_path) → PASS. `::T66`–`::T68` (anon, authenticated and PUBLIC EXECUTE all absent; `proacl` non-null), `::T69` (lock invoker; check and writer definer), `::T70` (search_path pinned), `::T71` (definer owner equals both table owners).
- AC-18 (triggers present, enabled, correct event lists) → PASS. `::T72` (pg_get_triggerdef match plus `tgfoid`), `::T73` (BEFORE UPDATE order puts the lock first).
- AC-19 (lints unmodified and passing) → PASS. `public_grants_explicit` 13/13 and `permissive_policy_lint` 5/5, with neither file modified.
- AC-20 (gates) → PASS for everything spec 179 owns. `scripts/test-db.sh` itself exits 1 only because of spec 178's out-of-scope file. See Test run. The release-coordinator should read this as "green except a known unrelated red".
- AC-21 (scope fence) → PASS. The spec 179 additions are exactly: `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`, `supabase/tests/inventory_items_identity_lock.test.sql`, and `specs/179-…` (this file and the spec). There is no unstaged diff under `src/**`, `supabase/functions/**`, `app.json`, or any existing pgTAP file. The staged `src/**` and spec 177 changes belong to specs 176/177 and are unchanged.
- AC-22 (prod-apply runbook in the design) → PASS (documentation reviewed, plus local dry-run of the probes). Spec §10 contains every required element:
  - the read-only pre-check, including the approval-line reconciliation, the `po_items` re-run, the FK actions and the existing triggers;
  - S-1 (verbatim file, one call);
  - the exact-version record step;
  - the md5, trigger and privilege verification;
  - S-2 (three raise-always DO blocks with no placeholders);
  - the push and gates, with an M-3 ordering note;
  - rollback, including exporting tombstones first.

  I extracted the three probe blocks from the spec text and ran them verbatim against local. Results: `PROBE OK: inventory_items: id and store_id are immutable` (probe 1), the same for the id variant (probe 2), and `PROBE OK: inventory_items: id was previously used by another store` (probe 3). The tombstone table was left at 0 rows. The three normalized md5s recomputed locally equal the values recorded in §10 Step 4 (`0af4acdb…`, `b8abd897…`, `a00f5436…`).
- AC-23 (prod apply only after owner go-ahead, after 177, before the push) → PASS as documentation only. It is a future owner-gated action, not a testable behaviour. §10 and the migration header state the ordering, and the migration is not yet pushed. I could not read prod state (no MCP in this session), so "not yet applied" is unverified. The release-coordinator should treat AC-23 as an owner-gate item, not a code defect.

Result: **23 PASS, 0 FAIL, 0 NOT TESTED** (AC-10, AC-20 and AC-23 carry the qualifiers above).

### Test run

- `bash scripts/test-db.sh supabase/tests/inventory_items_identity_lock.test.sql` → **73/73 pass**. The plan is 73, so there are no skipped or extra arms.
- `bash scripts/test-db.sh` (full) → **92 of 93 files pass, 1 fails**. The failing file is `order_approvals_fk_set_null.test.sql` (8 of 12 arms `not ok`).
  - Cause: `P0001 order approval is immutable` raised from `tg_order_approvals_guard()` on `UPDATE ONLY public.order_approvals SET approved_by = NULL`. That is the FK ON DELETE SET NULL interaction (spec 177 §11.8 and spec 178).
  - Unrelated to spec 179, for four reasons:
    1. The file never references `inventory_items` (0 matches).
    2. Every failure traces to `order_approvals` and its guard trigger. None carries 42501 or an `inventory_items` message.
    3. It is untracked and in-flight for spec 178.
    4. The developer reported identical failure output with the 179 triggers disabled.
  - `cross_store_item_rejection` (54/54), `public_grants_explicit` (13/13), `permissive_policy_lint` (5/5), `legacy_permissive_policy_dropout` and `audit_log_rls_hardening` all pass unmodified.
- **Negative control** (my own run, rolled back): I disabled the three new triggers inside a transaction and ran the file. **21 of 73 fail**, matching the developer's figure. The failing set covers every refusal arm, the tombstone-presence arms and the trigger-presence arm. The trigger states and the tombstone count were verified restored afterwards.
- `npx jest` (full) → 266 suites, 3334 tests, all pass.
- `npm run typecheck` → exit 0. `npm run typecheck:test` → exit 0.

### Notes

**Assessment of deviation 1: anon arms T56/T58/T60 in catalog form.** Accepted.
- The spec 067 ban on `set role anon` is real: `cross_store_item_rejection.test.sql` and `reports_anon_revoke.test.sql` carry the same rule, and no committed file uses `set role anon`.
- The catalog form is a faithful stand-in on this table. anon holds INSERT/UPDATE/DELETE and SELECT through the default ACL, so RLS is the only barrier. The arms assert that anon isn't BYPASSRLS, isn't superuser and isn't a member of the owner role, that RLS is on, and that no policy for the relevant command lists `anon` or `public`. Any future permissive policy aimed at anon fails the arm.
- Limit: it proves the mechanism, not a runtime row result. The runtime default-deny is exercised as `authenticated` in T55/T57/T59/T31.
- Plan count is unchanged.

**Assessment of deviation 2: AC-9/AC-10 cascade fixtures re-pinned (T32–T37).** Accepted, and I verified the premise independently.
- Brand delete: the only way a brand's items could reach the writer through `brands→stores→inventory_items` is an item in a brand that is being deleted. `inventory_items.catalog_id` is NOT NULL (my probe: an insert with a null catalog raised a not-null violation). The item's catalog row belongs to the same brand and is deleted by `brands→catalog_ingredients`, whose NO ACTION FK fails with 23503 first. So no brand with items can be deleted locally with or without spec 179, and the re-pinned arms (T35: exact 23503; T36: nothing removed; T37: no tombstone from the aborted statement) describe what is true today. They also double-assert AC-15-style atomicity for the cascade.
- Store delete: S_C with items, an `item_vendors` link and an unlined PO succeeds with the writer firing per item (T32–T34). The linked-PO variant fails today with 23503 (`po_items_item_id_fkey`, per the developer, pre-existing and reproduced with the triggers disabled), so the fixture change is legitimate.
- Residual risks to carry forward:
  1. T35 pins a pre-existing failure message. If someone later fixes `hard_delete_brand`, the FK ordering or the RI cascade order, T35 fails and has to be deliberately re-pinned. That is arguably desirable, but it will look like a spec 179 regression.
  2. The tombstone writer under a brand cascade is never positively exercised. It is covered only through the store cascade. If prod's RI trigger oid order differs from a fresh build, a brand delete that succeeds there would use the same writer. The writer has no FK and is idempotent, so I see no new failure mode. The architect's post-impl review should still confirm.
  3. The developer's two out-of-scope findings (`hard_delete_brand` can't purge a brand that still owns items; a store with PO-lined items can't be deleted) are pre-existing product bugs. They are worth a separate spec and are not caused by 179.

**Design arms covered by structure only.** The D-7 concurrency path (FOR KEY SHARE) is untestable in a single-transaction pgTAP file. The md5 pins the function body, which `scripts/` can recheck on prod. The optional two-session demonstration was skipped (shared DB), which is acceptable.

**Informational.**
- The `T-number` labels in the file are not execution order (the file groups by caller role), so the pgTAP `ok N` numbers differ from the T-numbers. This is cosmetic, but note it when reading failure output.
- Frontend and native: this is a backend-only spec with no UI surface. No gap to report.
- Framework: no new framework was introduced.
- CI consideration for the release-coordinator: `order_approvals_fk_set_null.test.sql` is untracked. If it is committed with, or ahead of, this spec before spec 178's migration exists, `test.yml` will go red on it. Stage spec 179's paths explicitly, as the runbook's M-3 note says.


---

## Fix round 1 re-review

Reviewer: test-engineer, 2026-10-26. I re-ran everything myself against the shared local DB (no `db reset`, no committed writes). Afterwards the local tombstone table is at 0 rows, all three triggers are enabled (`tgenabled = 'O'`), and the check trigger is `AFTER INSERT`.

### What changed (verified in the files)
- **Migration:** `inventory_items_check_tombstone()` is now an **AFTER INSERT** row trigger that returns null. Its `FOR KEY SHARE` probe only looks at other-store rows. The trigger name is unchanged and the file is re-runnable. Local normalized md5s: lock `0af4acdb…` (unchanged), check `9cfb8c5a2e02129e7ec9c1917c33d4d3` (new, matches the spec's §10 and the developer's entry), writer `a00f5436…` (unchanged).
- **plan(80):** confirmed. The file passes **80/80**, so no skipped or extra arms.
- **T72:** confirmed. It asserts the check trigger's `pg_get_triggerdef` matches `AFTER INSERT … FOR EACH ROW`, and that no non-internal BEFORE INSERT trigger remains (`'3|0'`).
- **T54/T61 snapshot fix:** confirmed. T54 now runs after a `reset role` hop and **before** T55/T57/T59, the first admin write attempts on the tombstone table. T61 asserts count = snapshot **and** = 5, and that the (iB1, store B) row is intact. T74–T80 add no tombstones, so "unchanged" is now a real claim. Before the fix, the snapshot was taken after the admin writes, so it could not detect them.
- **New arms:**
  - T74/T75: writable-CTE delete + reinsert of iB7 under A, as postgres. Refused with 42501 plus the exact R-2 message. The read-back shows iB7 still in B, not in A, and 0 tombstones.
  - T76/T77: the same CTE for iB8 as an authenticated master, with the read-back as postgres.
  - T78/T79: re-inserting tombstoned iB1 with a NULL `store_id` as postgres is refused with R-2, and no row has that id.
  - T80: a zero-store `user` caller re-inserting tombstoned iB2 under A gets the **RLS** message, not R-2. A guard DO block aborts the file if that caller can see store A or B, so the arm can't pass vacuously. This pins that the AFTER check runs after RLS WITH CHECK, so the R-2 message isn't a deleted-id oracle for a caller who can't insert.

### Negative controls (both reproduced by me)
1. **Three triggers disabled: 27/80 fail**, matching the developer. The failing set is T04 T05 T06 T07 T08 T09 T10 T15 T16 T17 T30 T34 T40 T41 T42 T43 T44 T49 T54 T61 T72 T74 T75 T76 T77 T78 T79. It includes every refusal arm, every tombstone-presence arm, T72, and the new T74–T79. T80 and T37 pass, as designed (T80 expects the RLS message regardless; T37 pins 0 tombstones).
2. **Check as BEFORE INSERT: 7/80 fail**, matching the developer: T74, T75, T76, T77, T80, T61, T72.
   - **Is the scratch-function deviation valid? Yes.** Re-attaching the real function BEFORE INSERT is not a usable control, because the real body now ends `return null`. A BEFORE row trigger that returns null silently skips every insert, so the fixtures never land and the file aborts for a reason unrelated to timing. A control has to change only the property under test. Here that property is timing, so the scratch function must keep the same probe and tombstone logic and differ only in `return new`.
   - I went one step closer to the real pre-fix state. I built my own scratch function using the **pre-fix body** (the version whose md5 was `b8abd897…`: unconditional `FOR KEY SHARE`, tombstone check, `return new`), attached it BEFORE INSERT under the real trigger name, and ran the file. I got the same **7/80** with the same failing set. That is stronger evidence than the developer's scratch function: the new arms catch the actual M1 bug (a BEFORE check can't see the tombstone that the same statement's AFTER DELETE writer hasn't queued yet).
   - T61 and T72 fail incidentally: the CTE moves add tombstones, and the trigger shape is wrong. T78 and T79 correctly pass under BEFORE, because they don't discriminate on timing.
   - Both scratch objects were created and rolled back inside the file's own transaction. I confirmed afterwards that the scratch function does not exist and the real trigger is still AFTER INSERT.

### Test run
- New file: **80/80 pass**.
- Full `bash scripts/test-db.sh`:
  - **Run 1:** 90/93 pass. Three reds: spec 178's `order_approvals_fk_set_null.test.sql` (known), plus `missed_order_audit_rpc.test.sql` (C.1 `have 2, want 1`) and `profiles_locale.test.sql` (`have 2, want 3` seeded profiles backfilled).
  - **Rerunning those two alone:** both pass (9/9 and 10/10).
  - **Run 2:** 92/93 pass. Only spec 178's file is red.
  - **Assessment:** the two extra reds in run 1 are transient and unrelated. Neither file references `inventory_items` (0 matches each). Both assert on row counts of tables other sessions can write to (profiles, audit rows), and other sessions were active (unstaged `src/**` i18n and staff EOD work appeared in the tree mid-review). I attribute them to shared-DB interference, not to spec 179. Spec 178's file stays red with the same `P0001 order approval is immutable` failures, unrelated to spec 179 (it never touches `inventory_items`).
  - `public_grants_explicit` (13/13), `permissive_policy_lint` (5/5) and `cross_store_item_rejection` (54/54) pass unmodified in both runs.
- `npx jest` (full): **267 suites, 3340 tests, all pass.** The tree includes other sessions' unstaged `src/**` work, which jest ran over.
- `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0.
- §10 probes: the developer ran probe 3 and the new probe 4 (writable CTE). I did not re-run probe 4. My earlier probes 1–3 (pre-fix) were run on the BEFORE-era function, and the CTE arms T74–T77 cover the same property under the real AFTER trigger.

### Updated acceptance criteria table

| AC | Status | Evidence |
|---|---|---|
| AC-1 | PASS | T04, T05, T06 |
| AC-2 | PASS | T07, T08 |
| AC-3 | PASS | T09, T10 |
| AC-4 | PASS | T11–T14 |
| AC-5 | PASS | T15–T17 |
| AC-6 | PASS | T18–T28 |
| AC-7 | PASS | 92/93 files pass unmodified; the only red is spec 178's |
| AC-8 | PASS | T29–T31 |
| AC-9 | PASS (re-pinned fixture) | T32–T34 |
| AC-10 | PASS (re-pinned to actual behaviour, per the AC's own clause) | T35–T37; the header's brand-cascade claim was softened this round |
| AC-11 | PASS, **strengthened** | T38–T42, plus **T76/T77** (single-statement CTE as an authenticated master) |
| AC-12 | PASS, **strengthened** | T43, T44, plus **T74/T75** (CTE as postgres) |
| AC-13 | PASS | T45–T47 |
| AC-14 | PASS | T48, T49 |
| AC-15 | PASS | T50, T51 |
| AC-16 | PASS, **snapshot fixed** | T54 now precedes the admin write attempts; T55–T65 (anon in catalog form: T56/T58/T60) |
| AC-17 | PASS | T66–T71 (check md5 updated) |
| AC-18 | PASS, **updated** | T72 (check is AFTER INSERT; no BEFORE INSERT remains), T73 |
| AC-19 | PASS | lints 13/13 and 5/5, unmodified |
| AC-20 | PASS for all spec 179 gates | `test-db.sh` exits 1 only because of spec 178's file (plus a transient shared-DB flake in run 1, gone in run 2); jest and both typechecks green |
| AC-21 | PASS | the spec 179 files are the migration, the test file and the spec/reviews; the unstaged `src/**` i18n and staff EOD changes in the tree are other sessions' work and are not part of spec 179 |
| AC-22 | PASS (documentation reviewed; probes 3 and 4 run by the developer) | §10 |
| AC-23 | PASS as documentation only (owner-gated, nothing applied) | §10 Step 6 |

New criteria and design arms covered this round: M1 (writable-CTE bypass) via T74–T77, SF-2 (NULL `store_id` reinsert) via T78/T79, L1 (no deleted-id oracle for callers who can't insert) via T80, and SF-1/M-3 (snapshot order) via T54/T61. All are PASS.

Totals: **23 PASS, 0 FAIL, 0 NOT TESTED.**

### Notes
- **Prod impact of the amendment:** the check function body changed (md5 `9cfb8c5a…`), so the owner's prod apply must use this version, and the verification step must compare against it.
- **Still reasoned, not tested:** the D-7 REPEATABLE READ 40001 path, because it needs a committed delete. The developer skipped the demonstration for the shared DB. The new md5 pins the probe body.
- **CI risk (unchanged):** spec 178's untracked test file will turn `test.yml` red if it is committed before its migration. Stage spec 179's paths explicitly.
