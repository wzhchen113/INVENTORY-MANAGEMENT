# Spec 179: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-10-26. Mode: post-impl. Spec `Status:` left at READY_FOR_REVIEW.

**Scope of this review:**
- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`
- `supabase/tests/inventory_items_identity_lock.test.sql`
- the spec's `## Backend design`, `## Files changed` and §10 runbook

**What I couldn't run.** This pass had no shell and no DB tool, so I re-ran nothing. Two consequences:
- The md5s and the 73/73 pass count are the developer's numbers. §10 M-1 (a fresh local recompute right before the apply) is still the binding check.
- I checked each deviation against the migration history instead.

## Verdict

**No Critical findings.** The migration matches the contract in §2.1-§2.4 exactly. That covers:
- names and event lists;
- invoker / definer settings and the pinned `search_path`;
- the three EXECUTE revokes and the D-1 A TRUNCATE revoke;
- no FK and no FORCE on the tombstone table;
- comments, the `begin; set local lock_timeout = '5s'; … commit;` wrapper, and a PROD-APPLY header naming `'20261026100000'`.

The only change is the `raise exception … using errcode = '42501'` spelling, which is the same statement in spec 177's form.

The pgTAP file implements T01-T73 with `plan(73)`. I accept all three reported deviations. Deviation 2 makes my design §2.5 wrong, and I have corrected it in the spec. I also edited the §10 runbook in three places, described below.

**Counts:**
- Critical: 0
- Should-fix: 3. Two are runbook defects, fixed in the spec in this pass. One is an out-of-scope owner follow-up.
- Minor: 5

## Deviation rulings

### D1. Anon arms T56/T58/T60 in catalog form: ACCEPTED
- `set role anon` segfaults the CI Postgres image (spec 067), and no committed pgTAP file uses it.
- The catalog arms assert the facts that cause the default-deny:
  - anon has no BYPASSRLS and isn't superuser;
  - RLS is on;
  - no policy for the command applies to anon or PUBLIC.
- T64 independently proves the table has 0 policies. T55/T57/T59 exercise the same RLS path at runtime as `authenticated`.
- I updated the §9 rows for these arms to describe what shipped. One gap is noted under Minor M-2.

### D2. T32-T37 re-pinned to the actual cascade behaviour: ACCEPTED; design §2.5 corrected
- **The developer is right.** My §2.5 brand-cascade paragraph repeated the 012c header (`20260510010000_brand_delete_cascade.sql` L21-27): "NO ACTION FKs … defer to end-of-statement". That does not hold for cascades:
  - An RI cascade action is itself an AFTER trigger. The `DELETE` it runs queues further RI events into the same statement's after-trigger queue.
  - Those events fire in queue order, and for one event in `RI_ConstraintTrigger_a_<oid>` name order, which is effectively creation order.
  - So a NO ACTION check can run before a sibling cascade path has removed the referencing row.
- The migration history matches the developer's ordering claims:
  - **Brands:** `catalog_ingredients.brand_id` CASCADE was created in p1 (`20260504060452` L36). `stores.brand_id` was dropped and re-added as CASCADE by 012c §1 (`20260510010000` L169-174). So the catalog action sorts first, and the `inventory_items.catalog_id` NO ACTION check (p1 L62, NOT NULL since p3 `20260504072830` L23) runs while the brand's items still exist. Result: 23503.
  - **Stores:** 012c §2 re-adds the `store_id` FKs in array order: `inventory_items` (index 1), then `purchase_orders` (index 4). So the items cascade, and its `po_items_item_id_fkey` NO ACTION check, run before `purchase_orders → po_items` removes the line. Result: 23503.
- The developer reproduced both with the spec 179 triggers disabled. **Both failures predate this spec**, and the writer adds no failure mode of its own: no FK, its only conflict is a no-op, and it is owner-bypassed.
- **Is the AC-10 re-pin acceptable? Yes.** AC-10 says: "if a brand delete doesn't reach `inventory_items` in the current schema, the architect records the actual cascade path and the AC pins whatever is true." T35 (exact 23503), T36 (nothing removed) and T37 (0 tombstones: the aborted cascade rolled back, the D-3 / AC-15 property) pin today's behaviour.
- **No test proves that a brand delete writes tombstones. I accept that gap.**
  - A brand delete can reach `inventory_items` only through `stores → inventory_items`. `catalog_id` and `vendor_id` are NO ACTION, not CASCADE.
  - That is the same RI action T32/T34 already prove fires the row-level AFTER DELETE writer. The depth of the cascade doesn't change whether a row trigger fires.
  - No realistic fixture reaches a successful brand cascade with items: `catalog_id` is NOT NULL, and the catalog is brand-scoped.
  - If a future spec fixes the cascade order, T35-T37 will fail. That is the right signal: re-pin them to a positive `(iZ1,S_Z)` / `(iZ2,S_Z)` tombstone assertion in that spec. I recorded this in §2.5.
- **Spec edits made:**
  - §2.5: new "Correction (post-impl review)" block, and the brand paragraph rewritten;
  - §9: rows T32-T37, and the negative-control rule (T37 no longer has to fail; this matches the developer's 21/73);
  - §11 risk 3.

### D3. Store fixtures carry an `address`: ACCEPTED
`stores_address_present` is `check (address is not null and btrim(address) <> '') not valid` (`20260829000100_store_addresses_for_auto_place.sql` L49-52). NOT VALID still applies to every new INSERT. The change is fixture-only and has no contract impact.

## Findings

### Should-fix

**S-1. Runbook Step 6: explicit staging didn't stop a bare `git commit` from bundling 176 and 177 (FIXED in spec §10 Step 6).**
- Spec 176 (`src/**`) and spec 177 (migration, tests, spec) are already staged (git status at dispatch).
- "Stage spec 179's paths explicitly" does not keep them out of the commit. A plain `git commit` takes the whole index.
- Step 6 now says: either commit 176 and 177 first in their own commits, or commit 179 with a pathspec (`git commit -- <179 paths>`). The user still runs the commit (project memory).
- M-3 is unchanged: the push carrying `20261026100000` must carry `20261025000000` or come after it.

**S-2. Runbook Step 6: spec 178's untracked test file would turn `test.yml` red (FIXED in spec §10 Step 6).**
- Step 6 only warned about spec 178's *migration* and the `db-migrations-applied` gate.
- The developer's gate run shows `supabase/tests/order_approvals_fk_set_null.test.sql` fails 8/12 today, independent of spec 179.
- If it is staged with any push, `test.yml` goes red. Step 6 now says it must not be staged until spec 178 lands its migration.

**S-3. Owner follow-ups found by deviation 2 (out of this spec's fence, NOT fixed; recommend a new spec).**
- **`hard_delete_brand()` can't purge any brand whose stores own items.** The super-admin "PURGE PERMANENTLY" path raises 23503 on `inventory_items_catalog_id_fkey`. 012c's verification Probe 7 (`20260510010000` L93-102) was evidently never run against a brand with items.
- **A direct store delete fails while any of its items has a `po_items` line.** The same mechanism probably affects `eod_entries` (via `eod_submissions`) and `inventory_count_entries` (RESTRICT). That is unverified.
- This affects `deleteStore` in `src/lib/db.ts` (L185-191). §4 already notes that it swallows the delete error.
- **Prod's firing order is expected to match**, because the same migrations ran in the same order. To confirm it without touching data, I added a record-only query to §10 Step 1 that lists the RI ON DELETE action triggers on `brands` and `stores` in firing order. It is **not** a STOP condition.
- Likely fix shapes for a future spec:
  - make the inner NO ACTION FKs `DEFERRABLE INITIALLY IMMEDIATE` and have `hard_delete_brand` run `set constraints … deferred`;
  - or delete in explicit child-first order inside the RPC.
  
  That is the future spec's design call, not this one's.

### Minor

**M-1. Runbook Steps 4/5: "expect 0 tombstones" raced with live traffic (FIXED in spec §10 Steps 4 and 5).**
- Step 4 and the post-probe check both expected `count(*) = 0`.
- A real item delete on prod between Step 2 and Step 5 now legitimately writes a tombstone. A correct apply would then look like a failed rollback.
- Step 4 now records the count as N4. Step 5 expects N4, and asks for an owner-confirmed explanation of any row above it.

**M-2. Anon catalog arms are not uniform.**
- T56 includes `not pg_has_role('anon', <owner>, 'MEMBER')`. T58 (L764-773) and T60 (L775-784) leave it out.
- Owner membership matters for RLS bypass, because owner checks use `has_privs_of_role`. Logically it's the same fact for all three arms, but read alone T58 and T60 are incomplete.
- Optional: add the conjunct to T58/T60. It doesn't affect the md5s or the plan count.

**M-3. The T54 snapshot is taken after the arms it brackets.**
- §9 intended T54 to snapshot the count *before* the admin UPDATE/DELETE (T59). The admin section comes before `reset role`, so the shipped T54 (L739-745) runs after T59. T61's "count unchanged" therefore compares two post-T59 values.
- Detection still works:
  - a T59 DELETE that worked would empty the table, and T54's `> 0` would fail;
  - a T59 UPDATE that worked would rewrite `(iB1, B)`, and T61's row check would fail.
- So this is not vacuous, but the "count unchanged" wording overstates it.
- Optional: have T61 assert the exact expected count. By the fixture history it is 5: iB1, iB3 (one row after delete → reinsert → delete), iC1, iC2, iB2. iN and iA1 write none.

**M-4. Mechanism wording in the test comments.**
- The PO_C comment (L164-170) and the T35 block comment (L637-648) say the NO ACTION check fires "at the end of the … cascade sub-statement".
- The more precise description is queue order, as in the corrected §2.5.
- Comments only, and the observed results are right. No change required.

**M-5. T35 depends on RI-trigger name order.**
- The exact 23503 message depends on the relative creation order of two FKs (p1 before 012c). On a fresh CI build this is the same as on a local `db reset`.
- The developer ran `migration up` on an existing local DB, not `db reset`. The relative order is the same either way, unless trigger oids cross a digit-length boundary between May 4 and May 10, which is very unlikely.
- CI's first run of the file is the confirmation. If CI disagrees, T35 is reporting a pre-existing ordering fact, not a spec 179 regression.

## §10 runbook re-check

| Item | Result |
|---|---|
| Recorded md5s | §10 Step 4 matches `## Files changed`: `0af4acdb…`, `b8abd897…`, `a00f5436…`. I didn't recompute them (no DB in this pass). M-1 requires a fresh local recompute right before the apply. The normalization query is the spec 177 form that matched on prod. |
| S-1 verbatim apply | Correct. The file is one self-contained `begin … commit;` and can be re-run (the developer confirmed a verbatim re-run is a no-op apart from a NOTICE). |
| S-2 raise-always probes | Still correct, and the cascade finding doesn't affect them: no probe deletes a store or brand, and probe 3 deletes an unreferenced synthetic item directly. The synthetic catalog INSERT has no side effects: `catalog_ingredients`' only trigger is BEFORE UPDATE (`trg_catalog_image_changed_at`, `20260722000000` L59-61). The 3-column `inventory_items` INSERT is shown valid by T46. Every path ends in an exception. |
| Pre-check FK actions | Unaffected. It checks action types, not firing order. Added: a record-only firing-order query (S-3). The "report any other referencing FK" clause also covers the init-schema `recipe_ingredients` / `prep_recipe_ingredients.item_id` and `ingredient_conversions.inventory_item_id` FKs, if they still exist on prod. They write only their own child tables. |
| Ordering after spec 177 | Correct (M-3). Strengthened by S-1. |
| Spec 178's future migration | Correct. No `20261026000000` file is on disk today (checked). The Step 1 pre-check tolerates it on prod. M-1 notes `db reset` / `--include-all` for local out-of-order. The gate compares sets, not order. Strengthened by S-2 for 178's test file. |
| Tombstone-count expectations | Fixed (M-1). |
| Rollback | Unchanged and correct. |

## Contract conformance (no drift)

- **Scope fence (AC-21).** Spec 179 added only the migration, the pgTAP file and the spec (git status). Spec 178's untracked test predates this work. No `src/**`, `supabase/functions/**`, `config.toml`, `app.json` or existing pgTAP file was touched, and nothing bypasses `src/lib/db.ts`.
- **RLS.** No existing policy changed. The new table has RLS on, no policies and no FORCE. Lint posture is Category B, and both lints pass unmodified per the developer.
- **Realtime.** No publication change, so no `docker restart supabase_realtime_imr-inventory` step.
- **Ordering assumptions held.** T06 got the lock message, not the RLS message. T09 got R-1, not R-2. So the §2.4 ordering claims are confirmed.
