# Spec 179: Lock an inventory item's identity (id and store) so existing lines can't be re-homed

Status: READY_FOR_REVIEW

Origin: the residual that spec 177 left open. Spec 177 ([specs/177-cross-store-item-rejection.md](177-cross-store-item-rejection.md)) added BEFORE triggers that reject cross-store item ids on `po_items` and `order_approvals.lines`. Those triggers fire only **when the line is written**. Spec 177's "Out of scope" and design §11.3 recorded one way around them: PATCH `inventory_items.store_id`. Its security audit ([reviews/security-auditor.md](177-cross-store-item-rejection/reviews/security-auditor.md) **L1**) showed the residual is wider than that. Re-keying an item's `id`, or deleting an item and re-inserting the same id under another store, also re-homes `order_approvals.lines`. The auditor confirmed both locally. This spec closes all three vectors. The owner approved the scope and every decision below before this spec was written, so they are written as requirements. No questions remain open for the owner. The calls left to the architect are listed under "Notes for architect", and one of them (N2) has a fenced default.

**Sequencing:**
- Spec 177's migration `20261025000000_cross_store_item_rejection.sql` is **already applied to prod** ([reviews/prod-apply.md](177-cross-store-item-rejection/reviews/prod-apply.md), 2026-10-26) but not yet committed or pushed. Spec 176 is staged. This spec touches no spec 176 or spec 177 file.
- This spec's migration must sort **after** `20261025000000`, which is the newest migration on disk. The architect picks the exact slot after re-checking `supabase/migrations/` (see N8: another in-flight change may also be adding a migration).
- Line numbers below come from the working tree on 2026-10-26. Treat them as pointers.

## User stories

1. As a **store manager**, I want an inventory item to stay in the store it was created in, so that nobody (a two-store manager by mistake, a buggy client, or a crafted PATCH) can quietly move it and drag that store's purchase-order lines and approval snapshots along.
2. As a **store manager reviewing an approved order**, I want every line in the approval snapshot to keep pointing at my store's item for the life of the record, so that deleting an item and re-creating its id in another store can't rewrite what my approval says.
3. As the **owner**, I want a mis-filed item fixed by deleting and re-creating it, never by moving it, so that store ownership of an item id is a fact the database guarantees.

## Current state (verified)

### The three vectors (spec 177 L1 and design §11.3)
1. **PATCH `inventory_items.store_id`.** `store_member_update_inventory_items` has USING and WITH CHECK `auth_can_see_store(store_id)` and no column restriction ([supabase/migrations/20260504173035_per_store_rls_hardening.sql:54-57](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)). A caller who can see both stores can move an item from A to B. This re-homes the item's `po_items` lines **and** its `order_approvals.lines` entries.
2. **PATCH `inventory_items.id`.** `po_items`, `eod_entries`, `waste_log` and `inventory_count_entries` block it through FK NO ACTION / RESTRICT. `order_approvals.lines[].item_id` is plain jsonb with no FK, so an item referenced **only** by approval lines can be re-keyed. Confirmed locally by the spec 177 security auditor.
3. **DELETE, then INSERT the same id under another store.** The FKs block the delete while `po_items` and the other tables reference the item. Jsonb approval lines don't, so an item referenced only by an approval can be deleted and its id re-created in another store. The approval line then resolves to the other store's item. Confirmed locally by the spec 177 security auditor (admin `1111…`, store B approval, item re-inserted under Charles).

`store_member_delete_inventory_items` (per_store_rls_hardening L59-61) and `store_member_insert_inventory_items` (L50-52) make vector 3 available to any caller who can see both stores.

### Writer audit (main Claude, 2026-10-26)
**No writer legitimately changes `id` or `store_id`.**
- **Client** ([src/lib/db.ts](../src/lib/db.ts)):
  - `updateInventoryItem` writes only `perStore` keys: `cost_per_unit`, `current_stock`, `par_level`, `vendor_id`, `usage_per_portion`, `expiry_date`, `case_price`.
  - `adjustItemStock` and the `submitEODCount` item update set stock fields only.
  - Item create goes through the `create_inventory_item_with_catalog` RPC, which does `on conflict (store_id, catalog_id) do nothing`.
- **Live SQL functions that write `inventory_items`:** `apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `receive_purchase_order`, `auto_receive_due_purchase_orders`, `staff_log_waste`, `staff_submit_eod`, `create_inventory_item_with_catalog`, and `submit_weekly_count` (which mentions it in a comment only). They set only stock, cost, par, `case_price` or `vendor_id`.
- **Edge functions:** the only writer is `breadbot-nightly-sync`, which sets `current_stock` and `last_updated_by`.
- **Tests, seed, scripts:** no UPDATE touches `id` or `store_id`.

### FKs
- `inventory_items.store_id → stores` is **ON DELETE CASCADE, ON UPDATE NO ACTION**. A store or brand delete reaches items as a **DELETE**, never as an UPDATE. So an UPDATE-time lock can't break a cascade, but a DELETE-time tombstone writer **will** fire on every cascaded item.
- FKs that reference `inventory_items(id)`:
  - `po_items`, `eod_entries`, `waste_log`: NO ACTION.
  - `inventory_count_entries`: RESTRICT.
  - `flags`: SET NULL.
  - `item_vendors`: CASCADE.

### Existing triggers on `inventory_items`
- `inventory_items_updated_at`: BEFORE UPDATE, `update_updated_at()` ([init_schema.sql:216-218](../supabase/migrations/20260405000759_init_schema.sql)).
- `trg_item_vendor_changed_at`: BEFORE UPDATE, `stamp_item_vendor_changed_at()` ([20260722000000_ingredient_changed_badge.sql:81-84](../supabase/migrations/20260722000000_ingredient_changed_badge.sql)).
- Both write timestamps only. Neither rewrites `id` or `store_id`.

### Data (2026-10-26)
- Prod (`ebwnovzzkwhsdxkpyjka`): 0 `order_approvals` rows. 0 cross-store `po_items` lines (spec 177 pre-check: 40 lines, all same-store).
- **No backfill.** Items deleted before this migration leave no tombstone. That is safe only while no approval line names an item id that no longer exists. With 0 approvals in prod there are none, and spec 177's R-2 means any approval written from now on must name a live same-store item. The runbook pre-check re-verifies this (AC-21).

### Lint constraint that shapes the tombstone table (found while writing this spec)
[supabase/tests/public_grants_explicit.test.sql](../supabase/tests/public_grants_explicit.test.sql) arm (1) (L174-210) fails the build if **any** `public.*` table lacks SELECT for `anon`, `authenticated` or `service_role`, unless the table is on a role-keyed allowlist. The allowlist currently holds `spec093_case_qty_backfill_audit` and `spec104_per_each_cost_audit` ("Category A": a deliberate grant-layer REVOKE, each with a matching negative arm). Tables that keep the grant but have RLS on and no policy (`username_resolve_rate_limit`, `_edge_auth`) are "Category B" and stay off the list. Only `public` and `graphql_public` are exposed through PostgREST ([supabase/config.toml:13](../supabase/config.toml)). No migration creates a non-public schema today. See N2.

## Requirements (owner-approved)

- **R-1. `inventory_items.id` and `store_id` are always immutable on UPDATE.**
  - Add a BEFORE UPDATE OF `id`, `store_id` trigger, FOR EACH ROW, that raises **42501** when `new.id is distinct from old.id` **or** `new.store_id is distinct from old.store_id`.
  - Because it compares values, a pass-through SET (`set store_id = store_id`, or a full-row PATCH or upsert that resends the unchanged value) is allowed.
  - Use the shape of spec 177's `purchase_orders_lock_store_id` (migration `20261025000000`).
  - It applies to **every** caller, including `postgres` and `service_role`, because a trigger is not RLS.
  - It covers `INSERT … ON CONFLICT (id) DO UPDATE SET store_id = …`, because the conflict arm is an UPDATE.
  - Policy: a mis-filed item is deleted and re-created, never moved.
- **R-2. Tombstone guard against delete-then-reinsert.**
  - Every deleted `inventory_items` row records `(id, store_id)` in a **new, locked-down table**. This includes deletes that cascade from a store or brand delete.
  - An INSERT into `inventory_items` that reuses a tombstoned id under a **different** `store_id` is refused with **42501**.
  - Reusing a tombstoned id under the **same** store is allowed, because that can't move a line across stores.
  - It applies to every caller, as in R-1.
  - **No backfill.** Prod has 0 `order_approvals` rows and 0 cross-store rows (2026-10-26). The runbook pre-check re-verifies this.
  - The tombstone table can't be read or written by `anon` or `authenticated`. N2 covers how, within the fence.
- **R-3. Owner-gated prod apply runbook.**
  - Use spec 177's §10 as the template, with both of the backend-architect's corrections applied ([reviews/backend-architect.md](177-cross-store-item-rejection/reviews/backend-architect.md)):
    - **S-1:** Step 2 executes the committed migration file **verbatim**, from line 1 to the final `commit;`, as one MCP `execute_sql` call. No `pg_get_functiondef` dump.
    - **S-2:** the post-apply negative probe is a **raise-always DO block** with **no placeholders**, so no write can persist whether or not a trigger fired.
  - Apply **after** spec 177's `20261025000000`, which is already on prod.
  - Prod apply happens only on the owner's explicit go-ahead, and **before** the push that carries the migration to `main`.
- **R-4. Conventions.**
  - Every new function revokes EXECUTE from `public, anon, authenticated`, as in spec 177.
  - `search_path` is pinned and every relation is schema-qualified.
  - The migration header carries a PROD-APPLY note in the spec 177 style. It names the exact version and says to verify every new function by normalized-md5 and every new trigger by presence (`pg_trigger`, `tgenabled = 'O'`).
  - The body is wrapped in `begin; set local lock_timeout = '5s'; … commit;`, and the file is safe to re-run (`create or replace`, `drop trigger if exists`, `create table if not exists` or equivalent).
  - No RLS policy is created, dropped or changed on any existing table. No publication change.

## Acceptance criteria

Test track: **pgTAP**, in one new file under `supabase/tests/`, plus the existing jest and typecheck gates as a regression check. No shell smoke.
- Each refusal asserts the SQLSTATE **and** the exact message with `throws_ok`.
- Each acceptance asserts that the row really landed or changed (anti-vacuity).
- Fixtures use two stores, A and B, each with its own items, and a privileged caller who can see both (the spec 177 `master` / `admin` pattern), plus an anti-vacuity probe that the caller can see both stores. Without that, RLS would hide the cross-store case and the test would pass for the wrong reason.
- The file is hermetic: `begin; … rollback;`, with every fixture created inside the transaction.

### Identity lock (R-1)
- [ ] **AC-1:** a two-store caller PATCHes an item's `store_id` from A to B → refused, 42501. The item's `store_id` is unchanged, and a store-A `po_items` line that references it still resolves to a store-A item.
- [ ] **AC-2:** a two-store caller PATCHes `id` on an item that is referenced **only** by a pending store-A `order_approvals` line (no FK references) → refused, 42501. The item's row is unchanged under its original id. This is the L1(b) vector.
- [ ] **AC-3:** `INSERT … ON CONFLICT (id) DO UPDATE SET store_id = excluded.store_id`, where the proposed row names store B for an existing store-A item → refused, 42501. The row still has store A.
- [ ] **AC-4:** pass-through is allowed:
  - `UPDATE … SET id = id, store_id = store_id, par_level = <new>` → accepted, and `par_level` changed;
  - an `INSERT … ON CONFLICT (id) DO UPDATE SET store_id = excluded.store_id, par_level = excluded.par_level` that resends the **same** store → accepted, and `par_level` changed.
- [ ] **AC-5:** the same `store_id` PATCH as AC-1, run as `postgres` (`reset role`, RLS bypassed) → refused, 42501. This pins that the lock is not an RLS rule.
- [ ] **AC-6:** existing writers are unaffected, and each one's write is asserted as landed:
  - a PostgREST-shaped `perStore` PATCH as a store member, using the `updateInventoryItem` key set (`cost_per_unit`, `current_stock`, `par_level`, `vendor_id`, `case_price`);
  - receiving through the real `receive_purchase_order` RPC (it updates item stock or cost);
  - an EOD submit through the real `staff_submit_eod` RPC or the path `submitEODCount` uses. The architect names which;
  - `apply_item_scalars_to_brand` and `apply_item_vendors_to_brand`;
  - `create_inventory_item_with_catalog` (a fresh id, which also covers R-2's "untombstoned id is unaffected").
- [ ] **AC-7:** every committed pgTAP file that writes `inventory_items` passes **unmodified**. If one of them changes `id` or `store_id`, or reinserts a deleted id under another store, report that as a finding. Do not patch it quietly.

### Tombstone guard (R-2)
- [ ] **AC-8:** a direct DELETE of a store-A item, run as a store member under `authenticated` → accepted, and exactly one tombstone row `(id, store_A)` exists. This proves the tombstone write works for a caller who can't access the tombstone table.
- [ ] **AC-9:** **store cascade.** Deleting a fixture store that owns items succeeds exactly as it does today, and a tombstone row exists for every item that store owned, each with that store's id.
- [ ] **AC-10:** **brand cascade.** Deleting a fixture brand whose stores own items succeeds exactly as it does today, and a tombstone row exists for every cascaded item. If a brand delete doesn't reach `inventory_items` in the current schema, the architect records the actual cascade path and the AC pins whatever is true.
- [ ] **AC-11:** **cross-store reinsert refused.** This reproduces L1(a):
  1. create a pending store-B approval naming a store-B item;
  2. delete that item;
  3. INSERT a new `inventory_items` row with the **same id** under store A.

  Step 3 is refused with 42501. No row with that id exists afterwards, and the approval's line still resolves to no store-A item.
- [ ] **AC-12:** the AC-11 reinsert, run as `postgres` → also refused, 42501.
- [ ] **AC-13:** **same-store reinsert allowed.** Delete a store-B item and re-insert the same id under store B → accepted, and the row exists.
- [ ] **AC-14:** **repeat delete.** Deleting the AC-13 row again succeeds, and the tombstone table still maps that id to store B only. The second tombstone write must not error.
- [ ] **AC-15:** a `po_items`-referenced item can still not be deleted (FK unchanged), and the refused delete leaves **no** tombstone. Because the delete statement aborts, its tombstone write must roll back with it.

### Lockdown and privileges (R-2, R-4)
- [ ] **AC-16:** the tombstone table can't be used by `anon` or `authenticated`. For each role:
  - SELECT returns no rows or raises 42501;
  - INSERT is refused;
  - UPDATE and DELETE are refused or affect 0 rows, with the row count proven unchanged afterwards;
  - TRUNCATE is refused (`has_table_privilege(..., 'TRUNCATE')` is false).

  The table has no permissive policy and is not in the `supabase_realtime` publication.
- [ ] **AC-17:** for every new function:
  - `has_function_privilege` is false for `anon` and `authenticated`, and `proacl` is non-null with no PUBLIC EXECUTE entry (the spec 177 T49-T51 probe);
  - `prosecdef` is pinned to the value the design chose (see N3);
  - `proconfig` pins `search_path`.
- [ ] **AC-18:** the new triggers exist in `pg_trigger` with `tgenabled = 'O'` on `public.inventory_items`, and with the event lists the design names.
- [ ] **AC-19:** `public_grants_explicit.test.sql` and `permissive_policy_lint.test.sql` pass. Per N2, the default is **unmodified**. Any edit to either needs owner approval first.

### Gates
- [ ] **AC-20:** `scripts/test-db.sh` (all pgTAP, including the lints), full `npx jest` (not a subset), `npm run typecheck`, and `npm run typecheck:test` all pass.
- [ ] **AC-21:** scope fence. The only files added or changed are:
  - one new migration under `supabase/migrations/`;
  - one new pgTAP file under `supabase/tests/`;
  - this spec and its `reviews/`.

  `src/**`, `supabase/functions/**`, `app.json`, every spec 176 and 177 file (including `20261025000000_cross_store_item_rejection.sql` and `cross_store_item_rejection.test.sql`), and every existing pgTAP file are not touched.

### Prod apply (documented in the design; executed only on the owner's go-ahead)
- [ ] **AC-22:** the design doc contains a prod apply runbook for project `ebwnovzzkwhsdxkpyjka`:
  1. **Read-only pre-check**, which stops and reports on any unexpected value:
     - Postgres version;
     - the `schema_migrations` rows at or after `20261025000000` (expect exactly `20261025000000`);
     - the new functions, triggers and table do not exist yet;
     - `order_approvals` row count (expect 0). If it is not 0, there must be **zero** approval line `item_id`s that are missing from `inventory_items` or that name another store's item. A non-zero result means STOP;
     - a re-run of the cross-store `po_items` count (expect 0);
     - FK actions on `inventory_items.store_id` (CASCADE / NO ACTION) and on every FK that references `inventory_items(id)` (as listed above);
     - the existing `inventory_items` triggers (expect exactly `inventory_items_updated_at` and `trg_item_vendor_changed_at`, plus any the design shows to exist).
  2. **Apply (S-1):** `execute_sql` of the full committed migration file, verbatim, in one call.
  3. **Record:** INSERT the **exact** version into `supabase_migrations.schema_migrations` with `on conflict (version) do nothing`, then the spec 177 M-2 confirm select.
  4. **Verify:** normalized-md5 of every new function against a fresh local value (spec 177 M-1), trigger presence and event lists, function privileges, and the tombstone table's grant and RLS posture.
  5. **Negative probe (S-2):** one or more raise-always DO blocks with no placeholders. Every path ends in an exception, and each one reports `PROBE OK: <trigger message>`, `PROBE FAILED: …` or `PROBE SKIPPED: …`. The probes cover at least the R-1 `store_id` lock and the R-2 cross-store reinsert. Prefer synthetic rows created inside the DO block over touching real prod items. `PROBE FAILED` means STOP and do not push.
  6. **Push, then gates:** push only after steps 2-4 succeed. Then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand (project memory).
  7. **Rollback:** the exact DDL to drop the triggers, functions and table. Say whether the tombstone rows need to be kept or exported first.
- [ ] **AC-23:** prod apply happens only after the owner's explicit go-ahead, after `20261025000000` (already on prod), and **before** any push that carries this migration. If spec 177 has still not been pushed by then, the push that carries this migration must also carry spec 177's migration, or come after it (spec 177 M-3).

## In scope

- One new migration that adds:
  - the R-1 identity-lock trigger function and trigger on `inventory_items`;
  - the R-2 tombstone table, its grant and RLS posture, the DELETE-time tombstone writer trigger, and the INSERT-time reuse check trigger on `inventory_items`;
  - function-privilege revokes and comments.
- New pgTAP coverage for AC-1 to AC-19.
- The prod apply runbook in the design (AC-22), and the apply itself after the owner's go-ahead.

## Out of scope (explicitly)

- **Any RLS policy change**, including narrowing `store_member_update_inventory_items` to exclude columns. The owner chose the trigger. Column-level grants or policies would be a separate design.
- **An FK or other referential link on `order_approvals.lines[].item_id`.** Jsonb can't carry an FK, and normalising lines into a child table is a schema redesign.
- **Canonicalising non-canonical uuid spellings in `order_approvals.lines`** (braced or unhyphenated). This is a pre-existing data-quality note from the spec 177 security audit, with no tenancy impact.
- **Touching any spec 176 or 177 file**, including spec 177's migration, its pgTAP file and its fixture edits.
- **Any `src/**` change.** No client writer changes `id` or `store_id`, and the client already turns a refused write into a backend-error toast. Backend only.
- **Backfilling tombstones** for items deleted before this migration (0 approvals in prod, so nothing to protect; re-verified in the runbook).
- **Purging or expiring tombstones.** The table grows by one row per item delete, which is negligible at current volume. A retention policy is a later concern.
- **A supported "move item to another store" flow.** Delete and re-create is the policy (R-1).
- **The `order_approvals` ON DELETE SET NULL vs `tg_order_approvals_guard` interaction** (spec 177 design §11.8). Separate work. See N8.
- **Edge functions, realtime publication, `app.json` slug.** Not touched.

## Open questions resolved

All owner-approved before this spec was written (relayed by main Claude, 2026-10-26):
- Q: Which `inventory_items` columns should be locked? → A: **Both `id` and `store_id`**, always immutable on UPDATE, per spec 177 L1's recommendation (R-1).
- Q: "Lock once referenced" or "always immutable"? → A: **Always immutable.** No writer legitimately changes either column (writer audit above). A mis-filed item is deleted and re-created.
- Q: Should a pass-through SET of the same value be allowed? → A: **Yes.** Compare with `IS DISTINCT FROM`, so an unchanged resend passes (R-1).
- Q: How should delete-then-reinsert be handled? → A: With a **tombstone table** that records `(id, store_id)` on every delete, cascades included. Reusing the id in a different store is refused with 42501. Reusing it in the same store is allowed (R-2).
- Q: Backfill tombstones for past deletes? → A: **No.** Prod has 0 `order_approvals` and 0 cross-store rows (2026-10-26). The runbook re-verifies (R-2, AC-22).
- Q: Which errcode? → A: **42501** for both refusals, matching spec 177's tenancy rule ("store-consistency refusals are 42501").
- Q: Change RLS policies instead? → A: **No.** Out of scope.
- Q: Any client change? → A: **No.** Backend only: one migration plus one new pgTAP file.
- Q: How does it reach prod? → A: Through an owner-gated runbook built on spec 177 §10 with the S-1 and S-2 corrections, applied after `20261025000000` and before the push (R-3).

## Notes for architect

- **N1. Trigger names and ordering on `inventory_items`.**
  - BEFORE triggers fire in name order. The two existing BEFORE UPDATE triggers write timestamps only, so ordering doesn't affect correctness. Still, record where the new triggers sort and confirm that no existing trigger rewrites `id` or `store_id` after the lock runs.
  - Use stable, greppable messages in the spec 177 style, for example `'inventory_items: id and store_id are immutable'` and `'inventory_items: id was previously used by another store'`.
  - The reinsert message must not reveal which store the id belonged to. Use one static string, with no row data.
- **N2. Tombstone table placement and grant posture (fenced decision).**
  - The owner's fence is one migration plus one new pgTAP file (AC-21), and the lints must pass (AC-19).
  - A table in `public` with `revoke all … from anon, authenticated` ("Category A") **fails** `public_grants_explicit.test.sql` arm (1) unless that file gains an allowlist row and a matching negative arm. That is an edit outside the fence.
  - **Default:** a `public` table that keeps the inherited grant (no TRUNCATE, per spec 097), has RLS enabled and **no policies**, and is not in the publication ("Category B", the `username_resolve_rate_limit` / `_edge_auth` precedent). This satisfies AC-16 at the RLS layer and needs no lint edit.
  - If you conclude that Category A or a new non-`public` schema is required, stop and raise it to the owner as a D-1-style decision before READY_FOR_BUILD. Do not widen the fence yourself.
  - The tombstone table must **not** carry an FK to `stores` or `inventory_items`. The referenced rows are gone by design, and an FK to `stores` would fight the store-delete cascade it records.
- **N3. Invoker vs definer.**
  - The R-1 lock reads nothing, so SECURITY INVOKER is natural (the spec 177 D-5 precedent).
  - The tombstone writer and the reinsert check must read and write a table that `authenticated` can't reach, so they almost certainly need **SECURITY DEFINER** (precedent: `tg_order_approvals_guard`, [20260801000100_order_approvals.sql:89-100](../supabase/migrations/20260801000100_order_approvals.sql)), with `set search_path` pinned and everything schema-qualified.
  - Record the choice for each function, and pin it in AC-17. The function owner must be able to bypass RLS on the tombstone table.
- **N4. Tombstone key and conflict handling.**
  - Pick the key, for example PK on `id`. Make the DELETE-time write idempotent for AC-14's delete → same-store reinsert → delete cycle.
  - State what happens if a tombstone for that id already names a different store. R-2 should make that unreachable after apply, but say whether the writer keeps the first owner, overwrites, or appends.
  - Decide whether to record `deleted_at`. It isn't required, but it's cheap and useful for audit.
- **N5. BEFORE vs AFTER for the tombstone write.**
  - Either works for a row-level DELETE trigger inside the deleting statement's transaction. AC-15 requires that an aborted delete leaves no tombstone.
  - Confirm the choice is correct for FK cascades. A store or brand delete fires the child row-level DELETE triggers, and a RESTRICT/NO ACTION violation further down the cascade aborts the whole statement.
- **N6. TRUNCATE bypass.** Row-level DELETE triggers don't fire on TRUNCATE. Confirm that `anon` and `authenticated` lack TRUNCATE on `inventory_items` (spec 097 grants a no-TRUNCATE list; see `public_grants_explicit.test.sql` arm 5), and note that a privileged TRUNCATE would skip tombstones. Informational unless you find TRUNCATE granted.
- **N7. Existing-suite audit.** Confirm that no committed pgTAP file, `supabase/seed.sql` or script:
  - updates `inventory_items.id` / `store_id`;
  - reinserts a deleted item id under another store;
  - depends on deleting and recreating items across stores.

  This is the AC-7 precondition. `seed.sql` loads into a fresh DB with no tombstones, so its explicit-id inserts are unaffected.
- **N8. In-flight neighbour (renumbered 2026-10-26).** This spec was drafted as 178, but spec 178 is taken by separate work on `order_approvals`' ON DELETE SET NULL FKs (spec 177 §11.8; its untracked `supabase/tests/order_approvals_fk_set_null.test.sql` is headed "Spec 178"), so this is spec 179. That work is outside this spec's fence. It will most likely take the next migration slot, `20261026000000`, so this spec uses `20261026100000`. Re-check `supabase/migrations/` before building, so the two versions don't collide.
- **N9. Error surface.** No client path should hit either refusal (writer audit). If one ever does, it shows as the generic `notifyBackendError` toast with HTTP 403. State the exact PostgREST status for each refusal in the API-contract table.

## Risks

- **False refusal of a legitimate write.** If some writer does resend `id` or `store_id` with a changed value, or reinserts a deleted id under another store, that write breaks. Mitigations: the writer audit, value comparison (AC-4), the real-RPC arms in AC-6, and the unmodified-suite rule (AC-7).
- **Cascade deletes break.** A store or brand delete now fires one tombstone write per item. If the writer errors (privileges, conflict, FK on the tombstone table), store and brand deletion stops working entirely. Pinned by AC-9, AC-10 and AC-14, and by N2's "no FK" rule.
- **The SECURITY DEFINER surface.** Two new definer functions run on every item insert and delete. Mitigations: pinned `search_path`, schema-qualification, the EXECUTE revoke (AC-17), and static messages with no row data.
- **Oracle.** The reinsert refusal reveals that "this id was once used by another store" to a caller who supplies a chosen id. That is low value (uuids aren't guessable) and the message is static, but the security audit should look at it.
- **Ops repair.** A genuine mis-filed item can no longer be moved even by `postgres` without `alter table … disable trigger` inside a transaction. That is the owner's chosen policy (R-1). The runbook's rollback notes should mention it.
- **Prod / repo drift.** Pushing before the prod apply turns `db-migrations-applied.yml` red. AC-23 sets the order. Spec 177 is applied but not yet pushed, so its push ordering also matters (AC-23).

## Dependencies

- Spec 177: `20261025000000_cross_store_item_rejection.sql` (applied to prod 2026-10-26), its §10 runbook as the template, and the backend-architect review's S-1, S-2, M-1 and M-2 corrections. Security finding L1 is this spec's origin.
- Spec 149: `order_approvals`, its jsonb `lines`, and `tg_order_approvals_guard` (the SECURITY DEFINER trigger precedent).
- Spec 097 (explicit grants and the no-TRUNCATE list) and spec 053 (permissive-policy lint).
- The per-store RLS hardening migration `20260504173035` (the unchanged `inventory_items` policies).
- Spec 064 (`db-migrations-applied` gate) and the prod-via-MCP apply procedure (project memory).

## Project-specific notes

- **Cmd UI section / legacy:** none. This is DB only. Sections that write items (Inventory, Receiving, EOD, brand catalog apply) are unchanged.
- **Per-store or admin-global:** per-store. It enforces the per-store ownership of an item id beneath the unchanged `auth_can_see_store()` RLS.
- **Realtime channels touched:** none. The tombstone table is **not** added to `supabase_realtime`, and there's no publication change, so the realtime container-restart gotcha doesn't apply. `inventory_items` change events are unchanged, and refused writes emit none.
- **Migrations needed:** yes, one new migration, timestamped after `20261025000000` (N8). It goes to prod through MCP `execute_sql` (verbatim file), then the exact `schema_migrations` version insert, then normalized-md5 verification, after the owner's go-ahead and before the push.
- **Edge functions touched:** none. `breadbot-nightly-sync` writes `current_stock` / `last_updated_by` only, so it doesn't fire R-1.
- **Web/native scope:** both, implicitly. The change is server-side.
- **`app.json` slug:** not touched.
- **Test tracks:** pgTAP (one new file) plus the `scripts/test-db.sh` lints. Jest and both typechecks run as a regression gate only. No shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/179-inventory-item-identity-lock.md

---

## Backend design

Author: backend-architect, 2026-10-26. Design only. No source, migration or test file was edited. I had no shell for this pass, so every "live" fact below comes from the migration history, the committed tests, and the recorded spec 110 / 170 security audits. The runbook pre-check re-measures each one on prod.

**Fix round 1 amendment (backend-architect, 2026-10-26, owner-approved FIXES_NEEDED).** Sources: [reviews/release-proposal.md](179-inventory-item-identity-lock/reviews/release-proposal.md) step 1, and [reviews/security-auditor.md](179-inventory-item-identity-lock/reviews/security-auditor.md) M1 and L1.

What changed in this design:
- `inventory_items_check_tombstone` is now an **AFTER INSERT** row trigger, and it returns null. This closes M1, the single-statement writable-CTE delete + reinsert. It also closes L1, because the check now runs after RLS WITH CHECK.
- The `FOR KEY SHARE` probe is **kept in a narrower form** (only rows of another store) as the REPEATABLE READ / SERIALIZABLE guard. D-7 has the ruling.
- Amended sections:
  - D-3, D-5, D-7 and D-8;
  - §2.4;
  - the §4 R-2 row;
  - §9: new arms T74-T80, the T54/T61 snapshot fix, the T72 event list, and `plan(80)`;
  - §10 Steps 4-5: recompute the check function's md5, and a new probe 4;
  - §11 items 5, 6 and 12.

What did not change:
- the table;
- the writer;
- the lock;
- the messages;
- every other arm.

The edit lands in place in `20261026100000_inventory_items_identity_lock.sql`. That migration is not yet applied to prod or pushed, so no new migration is needed.

### 0. Owner decision D-1 (CLOSED, Option A, owner, 2026-10-26): TRUNCATE on the tombstone table

**Decision record (2026-10-26):** the owner chose **Option A**, relayed by main Claude: revoke TRUNCATE on the tombstone table from `anon` and `authenticated`. Main Claude confirmed locally that `has_table_privilege('authenticated','public.weekly_reminder_log','TRUNCATE')` returns **true**, so the revoke is needed. The developer applies the "(D-1 A)" items as written:
- the `revoke truncate on public.inventory_item_tombstones from anon, authenticated;` line in §2.2;
- pgTAP arms T62/T63, with `plan(73)`;
- the TRUNCATE expectations in §10 Step 4.

The analysis below is kept for the record.

**The conflict.** AC-16 requires `has_table_privilege(<anon|authenticated>, tombstones, 'TRUNCATE')` to be **false**. N2's default ("keeps the inherited grant (no TRUNCATE, per spec 097)") assumes a new `public` table is created without TRUNCATE. The project's own audits say that assumption is wrong:
- [specs/110-named-weekly-count-layouts/reviews/security-auditor.md](110-named-weekly-count-layouts/reviews/security-auditor.md) N-2: `anon` and `authenticated` hold TRUNCATE on `store_count_layouts`, a table created after spec 097. The source is the Supabase `pg_default_acl` entry for `postgres` in `public`, not the spec 097 grant.
- [specs/170-audit-log-rls-hardening/reviews/security-auditor.md](170-audit-log-rls-hardening/reviews/security-auditor.md) L4: `pg_default_acl` holds `arwdDxtm` for `anon` / `authenticated` (`D` = TRUNCATE). 47 public tables carry TRUNCATE for both roles. `20260618000000_public_grants_explicit.sql:147` adds to those grants but never revokes them.

So the Category-B default creates `public.inventory_item_tombstones` **with** TRUNCATE for `anon` and `authenticated`, locally and on prod. AC-16's TRUNCATE bullet then fails. TRUNCATE also ignores RLS and fires no row trigger. A role that can TRUNCATE the table can wipe every tombstone, which reopens vector 3.

**Reachability today: none.** PostgREST has no TRUNCATE verb, and no RPC runs dynamic SQL. This is the same posture as every other public table, and the reason spec 110 / 170 rated it Nit / Low.

**Options** (main Claude asked me to flag any revoke rather than design it in):

| Option | Change | Lints | AC-16 |
|---|---|---|---|
| **A (recommended)** | One statement after `enable row level security`: `revoke truncate on public.inventory_item_tombstones from anon, authenticated;` | **Neutral.** `public_grants_explicit.test.sql` arm (1) asserts only SELECT. SELECT/INSERT/UPDATE/DELETE stay granted, so the table stays Category B and needs no allowlist row or new negative arm. | Holds as written. pgTAP arms T62/T63 pin it. |
| B | No revoke. Amend AC-16 to drop the TRUNCATE bullet ("not reachable over PostgREST; project-wide default, out of scope") | Neutral | Amended. T62/T63 removed (plan 71). |
| C (not recommended) | BEFORE TRUNCATE statement trigger that raises | Neutral | Fails AC-16's literal `has_table_privilege` wording. It also adds a fourth function. |

Why A: it is the exact shape of the spec 041 precedent (`revoke truncate on public.profiles from authenticated, anon`, [20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql) L305). That revoke exists for the same reason: row triggers guard the table's integrity, and TRUNCATE skips them. It is idempotent, has zero runtime impact (the only writer is a SECURITY DEFINER owned by `postgres`), and touches only the new table.

**Self-check for the developer before building:** run `select has_table_privilege('authenticated','public.weekly_reminder_log','TRUNCATE');` locally (a Category-B table created after spec 097). If it returns **false**, D-1 is moot: the default already satisfies AC-16, and A becomes a harmless no-op. If it returns **true** (expected), D-1 decides.

**The rest of this design is the same under A and B.** Where they differ, it is marked "(D-1 A)".

### 1. Decisions (the calls the spec leaves to the architect)

| # | Question | Decision | Why |
|---|---|---|---|
| D-2 | N4: tombstone key, conflict handling | **Composite PK `(id, store_id)`, append semantics.** The writer does `on conflict (id, store_id) do nothing`. The reinsert check refuses when **any** tombstone for `new.id` names a store distinct from `new.store_id`. Record `deleted_at timestamptz not null default now()`, which is the first deletion of that id in that store. | AC-14 (delete → same-store reinsert → delete) hits the same `(id, store)` key and is a silent no-op, so the tombstone still maps the id to store B only. A different-store tombstone for the same id is unreachable once R-1 and R-2 are live. It can only arise if someone bypasses the triggers (owner `disable trigger`). In that case append **keeps both owners and locks the id everywhere**: a reinsert under either store is refused. That is fail-closed. "Keep first owner" would silently let the first store reclaim approval lines written while the id lived in the second store. "Overwrite" would erase the evidence. |
| D-3 | N5: BEFORE vs AFTER for the tombstone write | **AFTER DELETE, FOR EACH ROW.** | It fires only for rows actually deleted: RLS-filtered rows never fire, and a later BEFORE trigger cannot skip the row after the write. It runs inside the deleting statement, so any abort rolls it back. AC-15: the `po_items` NO ACTION check is itself an AFTER trigger (`RI_ConstraintTrigger_a_*`, which sorts before `inventory_items_…` because `R` < `i`). It raises 23503, the statement aborts, and any tombstone already queued rolls back with it. FK cascades: a store or brand delete reaches `inventory_items` as an RI `DELETE FROM ONLY public.inventory_items WHERE store_id = $1`, which fires the row-level AFTER trigger once per cascaded item, with that item's own `store_id`. A RESTRICT / NO ACTION failure anywhere in the cascade aborts the whole top-level statement, tombstones included. A statement-level trigger with a transition table was rejected: it adds no benefit at this volume and complicates the trigger definition. **Fix round 1: how the writer pairs with the check.** The reinsert check is also an AFTER row trigger (AFTER INSERT, §2.4). AFTER row events fire in the order they were queued, at the end of the query. Inside one statement, a re-insert of id X can only get past the PK unique check after the delete of X has run, so the DELETE event (the writer) is always queued **before** the INSERT event (the check). The tombstone therefore exists when the check reads it, including the single-statement writable CTE `with d as (delete … returning …) insert … select … from d` (security M1). If the insert runs first, it hits 23505 against the live row. |
| D-4 | `inventory_items.store_id` is **nullable** (init_schema L54; never set NOT NULL). What does a storeless item record? | **No tombstone.** The writer returns early when `old.store_id is null`. The tombstone column is `store_id uuid not null`. | A storeless item can never be named by a store's lines. Spec 177's `po_items_check_store` needs `item.store_id = po.store_id` (non-null), and `order_approvals_lines_check_store` needs `ii.store_id = new.store_id` (a NOT NULL column). R-1 also forbids moving a storeless item into a store. So nothing can be re-homed through its id. The reverse case is handled: an id tombstoned under store A and re-inserted with `store_id` NULL is refused (`A is distinct from NULL`). The runbook reports prod's storeless-item count for information only. Pinned by T52/T53. |
| D-5 | N1/N9: messages and the existence oracle | **Two static strings, no row data, 42501:** `'inventory_items: id and store_id are immutable'` (R-1) and `'inventory_items: id was previously used by another store'` (R-2). | **Corrected in fix round 1 (security L1).** The original argument ("strictly less than the 23505 oracle") was false while the check ran BEFORE INSERT. Postgres runs BEFORE row triggers, then RLS WITH CHECK, then the PK unique check, then AFTER row triggers. So a caller who could **not** insert into the store they named, including any zero-store customer-PWA user who knows ids from `pwa-catalog`, got the R-2 message where they should only have seen the RLS message. **With the check now AFTER INSERT (§2.4), the ordering is:** RLS WITH CHECK, then the PK unique check (23505 for a live id), then the FK checks, then the R-2 check. A caller who fails WITH CHECK always gets `new row violates row-level security policy for table "inventory_items"`, whatever the id's history (T80 pins it). Only a caller who may insert into the named store can reach the R-2 message. That caller already has the 23505 oracle for live ids, so R-2 adds only "deleted, in a store other than the one I named", for a caller-supplied uuid, with no store name and no row data. A distinct, greppable message matters more to operators than hiding it would. |
| D-6 | N3: invoker vs definer, `search_path` | **Lock: SECURITY INVOKER, `set search_path = public`.** It reads nothing, and its shape matches spec 177 `purchase_orders_lock_store_id` exactly. **Tombstone check and writer: SECURITY DEFINER, `set search_path = ''`**, with every relation written as `public.<name>`. | The definer functions run as `postgres`, the owner of `inventory_items` and of the new table. Table owners bypass RLS unless FORCE is set, and **FORCE must not be set** on the tombstone table. An empty `search_path` is the hardened form for definer code: `pg_catalog` is still searched implicitly, so `now()`, `=` and `gen_random_uuid()` resolve, and any unqualified relation fails loudly. The invoker lock keeps the spec 177 / D-5 precedent. Execute is revoked from `public, anon, authenticated` on all three functions. Postgres does not check EXECUTE when firing a trigger, and a trigger function cannot be called directly. |
| D-7 | Concurrency: a delete and a cross-store reinsert of the same id in two transactions. **Re-ruled in fix round 1** (release-proposal REPEATABLE READ question). | **Option (a), narrowed.** The AFTER INSERT check first runs `perform 1 from public.inventory_items ii where ii.id = new.id and ii.store_id is distinct from new.store_id for key share;`, then reads tombstones. Options (b) and (c) are rejected. | **Setup:** tx1 deletes X (store B). tx2 inserts X under A. The **PK unique check** in tx2 waits for tx1 whenever tx1's delete is still in flight. If tx1 rolls back, tx2 fails with 23505. So by the time tx2's AFTER trigger runs, tx1 has always finished. **READ COMMITTED** (PostgREST's default, and every app path), confirming main Claude's reasoning: each statement in the volatile plpgsql check takes a fresh snapshot. It sees tx1's committed tombstone and refuses with R-2. The probe finds nothing: the old tuple is dead to the new snapshot, and tx2's own new row is excluded by the store predicate. **REPEATABLE READ / SERIALIZABLE**, also confirming main Claude's reasoning: the check reads with the transaction snapshot. If tx1 committed after that snapshot was taken (whether tx2 waited on it or not), the tombstone is invisible and the tombstone read alone would pass. Main Claude's guess that the probe "may be moot in AFTER INSERT, since the old row is gone" **holds only under READ COMMITTED.** Under RR the old B-row is still **visible** in tx2's snapshot, because its deleter committed after the snapshot. The probe selects it (its store ≠ A) and tries `FOR KEY SHARE`. Postgres refuses to lock a tuple that a concurrent transaction deleted after the snapshot, under a transaction-snapshot isolation level, and raises **40001** (`could not serialize access due to concurrent …`; the SQLSTATE is the contract, the message text varies by Postgres version). So the gap fails closed **when X(B) existed in tx2's snapshot**. **Fix round 1b correction (security L4, accepted residual):** if X(B) was both created **and** deleted after tx2's snapshot was taken, it is invisible to the probe (nothing to lock, no 40001) and its tombstone is invisible to the tombstone read, so tx2's reinsert under A passes. SERIALIZABLE does not catch it either, because the app transactions that created and deleted X run at READ COMMITTED and take no SIREAD locks. Only a raw `postgres` / `service_role` session that holds a REPEATABLE READ / SERIALIZABLE transaction open across X(B)'s whole lifetime, and learns X's uuid by another channel, can reach it. PostgREST runs READ COMMITTED, and no `public` function sets a higher isolation level in `proconfig`. The owner accepted wording-only option (a); the id-to-store claim table (option b) is not built. If tx1 committed **before** the snapshot, the old row is invisible and the tombstone is visible, so the result is R-2. **Why not (b):** detecting a row the snapshot can't see needs a dirty read, and the row lock is exactly the SQL-level tool for that. **Why not (c):** closing the gap costs one predicate and one PK probe, while (c) would leave R-2's "every caller" promise conditional on isolation level. **Cost:** the store predicate means the probe never locks tx2's own new row. So a normal insert takes no extra lock, and a same-store reinsert racing a delete is not made to fail under RR. **L1 stays closed:** the probe runs inside the AFTER trigger, after WITH CHECK, and its only extra outcome is 40001, which carries no row data. Neither isolation branch can be tested in a single-transaction pgTAP file. The md5 pins the body. Optional: a two-session demo, recorded under `## Files changed`, not a committed test. |
| D-8 | N1: names and BEFORE-trigger order | Triggers: `inventory_items_identity_lock_trg` (BEFORE UPDATE OF id, store_id), `inventory_items_tombstone_check_trg` (**AFTER INSERT**, fix round 1; the name is unchanged), `inventory_items_tombstone_record_trg` (AFTER DELETE). Functions: `public.inventory_items_lock_identity()`, `public.inventory_items_check_tombstone()`, `public.inventory_items_record_tombstone()`. Table: `public.inventory_item_tombstones`. | BEFORE UPDATE name order becomes `inventory_items_identity_lock_trg` < `inventory_items_updated_at` < `trg_item_vendor_changed_at`, so **the lock fires first**. That is safe: `update_updated_at()` writes only `updated_at` (init_schema L208-214), and `stamp_item_vendor_changed_at()` writes only `vendor_changed_at` (20260722000000 L69-79). No trigger rewrites `id` or `store_id`, before or after the lock. A future BEFORE UPDATE trigger that rewrote either column would contradict R-1. T73 pins the order so such a change shows up in review. `inventory_items` has no other non-internal AFTER INSERT or AFTER DELETE trigger, and after fix round 1 it has no non-internal BEFORE INSERT trigger at all. The FK-check RI triggers on `inventory_items` INSERT (`RI_ConstraintTrigger_c_*`) sort before `inventory_items_…`, because `R` < `i`. So a bad `store_id`, `catalog_id` or `vendor_id` reports 23503 before the R-2 check runs. |
| D-9 | AC-6: which EOD path | **The real `public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)` RPC** (SECURITY DEFINER, latest body in 20261024000000), called as a Frederick store member. The admin `submitEODCount` on-hand write is a PostgREST PATCH of `current_stock` / `eod_remaining` (db.ts ≈L1104). It is covered by adding `eod_remaining` to the T18 key set. | It exercises both real paths without a client harness. |
| D-10 | Can an FK referential action trip the lock? | **No.** Detail in §2.4. | Summary: the lock fires only when `id` or `store_id` is in an UPDATE's target list. No referential action on this schema writes either column. |

### 2. Data model changes

**Migration:** `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`. The newest file on disk is `20261025000000_cross_store_item_rejection.sql`. Spec 178 (separate, in flight) is expected to take `20261026000000`. Re-check `supabase/migrations/` right before building. If 178 has claimed `20261026100000` or anything at or after it, stop and report. Do not renumber silently.

**Strictly additive.** One table, one index (its PK), three functions, three triggers, comments, three function revokes, and (D-1 A) one TRUNCATE revoke on the new table. No existing table, column, policy, publication or function is modified. No backfill.

**Wrapper and header.** Use spec 177's template exactly:
- `begin;` then `set local lock_timeout = '5s';`, the body, and `commit;`;
- `create table if not exists`, `create or replace function`, and `drop trigger if exists` + `create trigger`, so the file can be re-run;
- a header block in the 20261025000000 L1-48 style. It names the three guards, says "STRICTLY ADDITIVE", "no publication change, therefore NO `docker restart supabase_realtime_imr-inventory` step", and records D-6 (invoker / definer) and D-8 (trigger order);
- a **PROD-APPLY** paragraph naming the exact version `'20261026100000'`. It says: VERIFY the three functions by NORMALIZED-MD5, the three triggers by PRESENCE (`pg_trigger`, `tgenabled = 'O'`), and the table's RLS / grant / publication posture. It points to the full runbook in §10 of this spec.

`CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on `inventory_items` for a moment. The lock timeout keeps a busy table from queueing traffic behind the DDL. On `55P03`, nothing was created. Re-run.

**Body order:** (R-1) lock function + trigger → (R-2a) table + RLS (+ D-1 A revoke) + comments → (R-2b) writer function + trigger → (R-2c) check function + trigger.

#### 2.1 (R-1) `public.inventory_items_lock_identity() returns trigger`
plpgsql, `security invoker`, `set search_path = public`.
```
if new.id is distinct from old.id or new.store_id is distinct from old.store_id then
  raise 'inventory_items: id and store_id are immutable' (42501);
end if;
return new;
```
Trigger: `inventory_items_identity_lock_trg BEFORE UPDATE OF id, store_id ON public.inventory_items FOR EACH ROW`.
- It fires for every caller (a trigger is not RLS), including `postgres` and `service_role`.
- It fires on the conflict arm of `INSERT … ON CONFLICT … DO UPDATE SET store_id = …`, because that arm is an UPDATE whose target list holds the column.
- A pass-through (`set id = id`, `store_id = store_id`, or a PostgREST upsert that resends every payload column) passes on the value comparison.

Comment: `'spec 179 (R-1): BEFORE UPDATE OF id, store_id on public.inventory_items. id and store_id are always immutable on UPDATE (value comparison, so a pass-through resend is allowed); a change raises 42501 ''inventory_items: id and store_id are immutable''. SECURITY INVOKER. A mis-filed item is deleted and re-created, never moved.'` Then the revoke.

#### 2.2 (R-2a) `public.inventory_item_tombstones`
```
create table if not exists public.inventory_item_tombstones (
  id          uuid        not null,
  store_id    uuid        not null,
  deleted_at  timestamptz not null default now(),
  constraint inventory_item_tombstones_pkey primary key (id, store_id)
);
alter table public.inventory_item_tombstones enable row level security;
-- (D-1 A only) revoke truncate on public.inventory_item_tombstones from anon, authenticated;
```
- **No FK** to `inventory_items` or `stores` (N2). The rows describe things that are gone, and an FK to `stores` would fight the cascade the table records.
- **No policies.** Every `anon` / `authenticated` row operation is default-denied by RLS: SELECT and UPDATE / DELETE see 0 rows, INSERT raises 42501.
- **Do NOT `force row level security`.** The definer functions rely on owner bypass.
- **No explicit grant or revoke** other than the D-1 A line. The table inherits the default ACL (Category B, the `weekly_reminder_log` / `_edge_auth` precedent). `service_role` keeps ALL (it has BYPASSRLS anyway). That is acceptable, because service_role is a trusted server identity.
- **Not added to `supabase_realtime`.** The publication has been an explicit allowlist since `20260514140000_realtime_publication_tighten.sql`, so a new table does not join it automatically.
- The PK btree on `(id, store_id)` serves the check's `where id = $1` lookup through its leading column. No other index is needed.

Comments on the table and the three columns. Table: `'spec 179 (R-2): one row per (deleted inventory_items.id, its store_id). Written only by inventory_items_record_tombstone() (AFTER DELETE, SECURITY DEFINER), including store/brand cascade deletes. Read only by inventory_items_check_tombstone() to refuse re-inserting a deleted id under a different store. RLS on with NO policies (anon/authenticated reach no row); not published; no FK by design. No backfill: deletes before 20261026100000 left no tombstone.'`

#### 2.3 (R-2b) `public.inventory_items_record_tombstone() returns trigger`
plpgsql, `security definer`, `set search_path = ''`.
```
if old.store_id is null then return null; end if;          -- D-4
insert into public.inventory_item_tombstones (id, store_id)
values (old.id, old.store_id)
on conflict (id, store_id) do nothing;                     -- D-2: idempotent (AC-14)
return null;                                               -- ignored for AFTER
```
Trigger: `inventory_items_tombstone_record_trg AFTER DELETE ON public.inventory_items FOR EACH ROW`. Comment, then the revoke.

#### 2.4 (R-2c) `public.inventory_items_check_tombstone() returns trigger`
plpgsql, `security definer`, `set search_path = ''`. **Fix round 1: AFTER INSERT.**
```
-- D-7: REPEATABLE READ / SERIALIZABLE guard. Under READ COMMITTED it finds nothing.
-- The store predicate keeps it off this statement's own new row.
perform 1 from public.inventory_items ii
 where ii.id = new.id
   and ii.store_id is distinct from new.store_id
   for key share;
if exists (select 1 from public.inventory_item_tombstones t
            where t.id = new.id
              and t.store_id is distinct from new.store_id) then
  raise 'inventory_items: id was previously used by another store' (42501);
end if;
return null;                                               -- ignored for AFTER
```
Trigger: `drop trigger if exists inventory_items_tombstone_check_trg …;` then `create trigger inventory_items_tombstone_check_trg AFTER INSERT ON public.inventory_items FOR EACH ROW`. Comment, then the revoke. The comment text must say AFTER INSERT and must state that the guard covers every caller, including a single-statement delete + reinsert.

Notes (these replace the BEFORE-INSERT notes):
- **Order within one INSERT:**
  1. RLS WITH CHECK;
  2. heap and index insert, with the PK unique check (23505 for a live id; it waits on an in-flight deleter);
  3. at the end of the query, AFTER row events in queue order. For this event, triggers fire in name order: the `RI_ConstraintTrigger_c_*` FK checks first, then `inventory_items_tombstone_check_trg`.

  A raise in the check aborts the statement, and the row and any tombstone queued earlier in it roll back.
- **Single-statement delete + reinsert (M1) is refused.** The DELETE event is queued before the INSERT event (D-3), so the writer has already recorded `(X, B)` when the check runs. This holds for every caller, `postgres` and `service_role` included. T74-T77 pin it.
- **L1 is closed.** A caller who fails WITH CHECK never reaches the check (D-5, T80). Example: a one-store Frederick caller inserting an id tombstoned at Charles.
  - **Under Frederick:** WITH CHECK passes, the check finds `(X, Charles)`, and the result is R-2.
  - **Under Charles:** WITH CHECK refuses, and the caller gets the RLS message.
- **Upserts.** On `INSERT … ON CONFLICT`, the AFTER INSERT trigger fires only when a row is actually inserted.
  - If a live row with that id exists, the conflict arm runs instead, and the UPDATE is governed by R-1. So an upsert that moves a live id gets the **R-1** message. This includes a live id that was previously tombstoned and same-store re-inserted, which previously got R-2.
  - With no live row, the insert happens and R-2 applies.
  - `ON CONFLICT … DO NOTHING` that skips the row fires nothing.
  - AC-3's iA3 is live, so T09 still expects the **R-1** message.
- **Under the NULL-store branch**, `new.store_id` NULL against a tombstone `(X, B)` is refused (`B is distinct from NULL`). Only `postgres` / `service_role` can reach that branch: for `authenticated`, RLS WITH CHECK (`auth_can_see_store(NULL)`) refuses first. T78 pins it as postgres.
- `create_inventory_item_with_catalog` inserts a default-generated id, so its check is two empty PK probes.

#### 2.5 FK actions vs the new triggers (D-10)
These are the only paths by which a referential action could write `inventory_items`. All were verified in the migrations; the runbook re-checks prod.
| FK | Actions | Writes to `inventory_items` | Lock fires? |
|---|---|---|---|
| `inventory_items.store_id → stores` | ON DELETE **CASCADE**, ON UPDATE **NO ACTION** (20260510010000 §2) | Cascade = **DELETE** → fires the AFTER DELETE writer (intended, AC-9/10). ON UPDATE NO ACTION writes nothing; a `stores.id` change with referencing items fails 23503, as today. | No |
| `inventory_items.last_updated_by → profiles` | ON DELETE **SET NULL** (20260528000000 L76-80) | RI runs `UPDATE ONLY public.inventory_items SET last_updated_by = NULL …`. The target list is `last_updated_by` only. | **No.** The column list excludes it. Even if it fired, the value comparison passes, since `id` and `store_id` are unchanged. |
| `inventory_items.vendor_id → vendors` | NO ACTION (init_schema L61, never altered) | none | No |
| `inventory_items.catalog_id → catalog_ingredients` | NO ACTION (p1 L61-62) | none | No |
| `po_items` / `eod_entries` / `waste_log.item_id → inventory_items(id)` | NO ACTION / NO ACTION | They write the child, never `inventory_items`. They block a referenced delete (AC-15). | No |
| `inventory_count_entries.item_id` | ON DELETE RESTRICT | child only | No |
| `flags.item_id` | ON DELETE SET NULL | UPDATEs `flags`, not `inventory_items` | No |
| `item_vendors.item_id` | ON DELETE CASCADE | DELETEs `item_vendors` | No |

This is the opposite of the spec 178 situation. There, an FK SET NULL wrote a column the guard treated as immutable. Here, the locked columns are never targets of a referential action. The lock could only be tripped by an RI action if a future migration changed `inventory_items.store_id`'s FK to ON DELETE SET NULL / SET DEFAULT or ON UPDATE CASCADE / SET NULL. In that case a store delete or store-id change would be refused. The runbook makes that a STOP condition, and any such FK change must revisit R-1. No referencing FK can write `inventory_items.id` (they are all ON UPDATE NO ACTION, and the id lock refuses first anyway).

**Brand cascade path (AC-10, the actual schema):** `brands` →(CASCADE, 20260510010000 §1) `stores` →(CASCADE, §2) `inventory_items`. This is the only path from a brand delete to `inventory_items`, because `inventory_items.catalog_id` and `vendor_id` are NO ACTION, not CASCADE. Any cascaded item would reach the writer through the same `stores → inventory_items` RI action that a direct store delete uses (T32/T34), with that item's own `store_id`. In parallel, `brands` →(CASCADE) `catalog_ingredients` and `vendors`. `hard_delete_brand()` is the app path: a super-admin SECURITY DEFINER RPC that runs the same `delete from public.brands`.

**Correction (post-impl review, 2026-10-26).** The original text said the NO ACTION FKs from `inventory_items.catalog_id` / `vendor_id` "are checked at end of statement and find the items already deleted through the stores path". That repeated the 012c header (20260510010000 L21-27), and it is **wrong** for cascades. The backend-developer reproduced the actual behaviour with the spec 179 triggers disabled, so it predates this spec:
- An RI cascade action is itself an AFTER trigger. The `DELETE` it runs queues its own RI events (NO ACTION / RESTRICT checks, further cascades) into the same top-level statement's after-trigger queue. They fire in queue order, and for one event in trigger-name order. `RI_ConstraintTrigger_a_<oid>` is effectively creation order.
- So a NO ACTION check runs as soon as the queue reaches it, which can be **before** a sibling cascade path removes the referencing row. It does not wait for the end of the whole statement.
- **Brand delete:** `brands → catalog_ingredients` (FK created in p1, 2026-05-04) fires before `brands → stores` (FK re-created by 012c, 2026-05-10). The `inventory_items.catalog_id` NO ACTION check then runs while the brand's items still exist. So `delete from public.brands` of any brand whose stores own items **fails today**, with 23503 `… violates foreign key constraint "inventory_items_catalog_id_fkey" on table "inventory_items"`. As a result, `hard_delete_brand()` cannot purge such a brand.
- **Store delete:** `stores → inventory_items` fires before `stores → purchase_orders → po_items`. So a store whose item has a `po_items` line **fails today**, with 23503 on `po_items_item_id_fkey`. The same shape probably affects `eod_entries` (via `eod_submissions`) and `inventory_count_entries` (RESTRICT). That is unverified.
- **Effect on this spec: none.** The writer never raises: it has no FK, its only conflict is a no-op, and it is owner-bypassed. It therefore adds no failure mode to any delete and removes none. Every abort above rolls back every tombstone queued earlier in the statement (D-3), which T37 pins for the brand case.
- **AC-10 re-pin accepted** under AC-10's own "pins whatever is true" clause. T35 asserts the pre-existing 23503, T36 asserts nothing was removed, and T37 asserts 0 tombstones. No arm proves positively that a *successful* brand cascade writes tombstones, because no realistic fixture reaches one: `catalog_id` is NOT NULL (p3), and the catalog is brand-scoped. The mechanism is covered by T34, since the brand path reaches items only through the same `stores → inventory_items` action and depth doesn't change whether a row trigger fires.
- If a future spec fixes the brand or store cascade, T35-T37 will fail. That is the intended signal: re-pin them to a positive tombstone assertion (iZ1/iZ2 under S_Z) in that spec.
- Prod's RI-trigger order is expected to match local and CI, because the same migrations ran in the same order. §10 Step 1 records it, for the owner's follow-up only.

**N6 (TRUNCATE on `inventory_items`):** per the spec 170 L4 evidence, `anon` / `authenticated` almost certainly **do** hold TRUNCATE on `inventory_items` (the project-wide default). A TRUNCATE would skip both the tombstone writer and the per-row FKs, and it needs `CASCADE` because of the referencing FKs. It is unreachable over PostgREST and RPC. A privileged session (`postgres` / `service_role`) TRUNCATE also skips tombstones. **Informational only. Not fixed here.** A revoke on `inventory_items` is a schema-wide decision outside this fence; spec 170 L4 already tracks the 47-table sweep. The runbook records prod's value.

### 3. RLS impact

- **No existing policy** is created, dropped or altered (R-4).
- **New table:** RLS enabled, **zero policies**. This is deliberate: neither `auth_is_admin()` nor `auth_can_see_store()` is used, because no client role may read or write a single row. The two definer functions are the only access path.
- `permissive_policy_lint.test.sql` sees no new policy and stays green. `public_grants_explicit.test.sql` arm (1) sees SELECT granted to all three roles and stays green, under A or B.
- The triggers enforce identity **beneath** the unchanged `store_member_*_inventory_items` policies (per_store_rls_hardening L46-61).

### 4. API contract

No new endpoint, RPC or view. The existing PostgREST / RPC surfaces gain these refusals:

| Write | Guard | SQLSTATE | PostgREST HTTP | Message (stable) |
|---|---|---|---|---|
| UPDATE `inventory_items` that changes `id` or `store_id`: PATCH, upsert conflict arm, any RPC, any role | R-1 | 42501 | 403 (authenticated) | `inventory_items: id and store_id are immutable` |
| INSERT `inventory_items` whose `id` has a tombstone under a different (or NULL) `store_id`: direct, upsert insert-path, RPC, and single-statement CTE delete + reinsert; any role. Evaluated **after** RLS WITH CHECK, the PK check and the FK checks (fix round 1). | R-2 | 42501 | 403 | `inventory_items: id was previously used by another store` |
| Same, under REPEATABLE READ / SERIALIZABLE, when a concurrent delete of that id committed after the transaction snapshot (D-7). Not reachable from PostgREST, which uses READ COMMITTED. | R-2 (probe) | 40001 | n/a (not reachable over PostgREST) | `could not serialize access due to concurrent delete` |
| `anon` / `authenticated` INSERT into `inventory_item_tombstones` | RLS | 42501 | 403 (401 for anon) | `new row violates row-level security policy for table "inventory_item_tombstones"` |
| `anon` / `authenticated` SELECT / UPDATE / DELETE on the tombstone table | RLS | none | 200, empty / 0 rows | none |
| DELETE of an `inventory_items` row (direct or cascade) | writer | none, transparent | unchanged | none |

No client path reaches either refusal (writer audit, re-verified: db.ts `updateInventoryItem` L534, `adjustItemStock` L696, `submitEODCount` L1104 and `breadbot-nightly-sync` L392 send no `id` / `store_id`; `create_inventory_item_with_catalog` uses a generated id). If one ever did, it would surface as the caller's generic `notifyBackendError` toast with the message text. `deleteInventoryItem` (L3007) and `deleteStore` (L185-191) now also write tombstones, invisibly. Their behaviour, including their pre-existing "ignore the delete error" handling, is unchanged.

The tombstone table is visible by **name** in PostgREST's OpenAPI root, like `_edge_auth`. No rows are reachable.

### 5. Edge functions

None changed, none new, no `verify_jwt` change. `breadbot-nightly-sync` (L392-394) updates `current_stock` and `last_updated_by` only, so R-1 is not fired. It inserts no items. `pwa-catalog` only reads.

### 6. `src/lib/db.ts` surface

None. No helper, no mapping change, no `src/**` edit (AC-21).

### 7. Realtime impact

None. No `supabase_realtime` change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply. The tombstone table is not published (explicit allowlist). `inventory_items` DELETE events replay on `store-{id}` exactly as today. Refused writes, and rolled-back runbook probes, emit nothing, because logical decoding emits only committed transactions.

### 8. Frontend store impact

None. No slice of `useStore.ts` changes.

### 9. pgTAP: `supabase/tests/inventory_items_identity_lock.test.sql` (new, one file)

Style follows `cross_store_item_rejection.test.sql`:
- `begin; create extension if not exists pgtap; select plan(80); … select * from finish(); rollback;`. Fix round 1 adds T74-T80 to the 73 arms (D-1 = A, so T62/T63 stay);
- every `throws_ok` asserts SQLSTATE **and** the exact message;
- impersonation uses `set local role authenticated` (or `anon`) plus `request.jwt.claims` (`sub`, `role`, `app_metadata.role`), and `reset role` for postgres.

**Fixtures (as postgres, before any `set role`):**
- Brand `2a000000-0000-0000-0000-000000000001` (created by migration p1, present on CI-fresh).
- Stores A = **Charles**, B = **Frederick** (seed lookup by name, as in spec 177).
- Fixture store **S_C** in that brand. Fixture brand **Z** with store **S_Z**.
- Principals:
  - **master** `3333…` (sees both; R-1 arms);
  - **admin** `1111…` (privileged, brand A; approvals, store delete, apply RPCs);
  - **manager** `2222…` (`'user'`, Frederick + Towson only: the one-store caller and the AC-8 store member).
- Fixed literal ids under a `c1790000-…` prefix. **Every item gets its own fresh catalog row**, so no `(store_id, catalog_id)` unique collision can mask a refusal in the negative control. The one exception is `cS`, which is shared on purpose.

| Item | Store | Purpose / references |
|---|---|---|
| iA1 | A | line on `PO_A` (draft): AC-1, AC-5, AC-15 |
| iA2 | A | named **only** by a pending Charles approval (admin RPC, date d1). **No** `item_vendors` row: AC-2 |
| iA3 | A | never deleted: AC-3, AC-4 |
| iA4 | A | line on `PO_A2` (`sent`): AC-6 receive |
| iA5 / iB4 | A / B | share catalog `cS`: AC-6 apply RPCs |
| iB1 | B | no references: AC-8 |
| iB2 | B | named only by a pending Frederick approval (admin RPC, date d2), no `item_vendors`: AC-11/12 |
| iB3 | B | no references: AC-13/14 |
| iB5 | B | AC-6 perStore PATCH, and the T06 one-store refusal |
| iB6 | B | `item_vendors (iB6, V)`: AC-6 `staff_submit_eod` |
| iB7, iB8 | B | Fix round 1. No references and no `item_vendors`; each has its own catalog `cB7` / `cB8`, present in no Charles row. Single-statement CTE arms: T74/T75 (postgres) and T76/T77 (master) |
| iN | NULL store | D-4 |
| iC1, iC2 | S_C | plus `item_vendors (iC1, V)` and `PO_C` with a line on iC1: AC-9 |
| iZ1, iZ2 | S_Z | catalog in brand Z: AC-10 |

Vendor **V**: brand-A, `order_channel` null. RPC call shapes are copied from `cross_store_item_rejection.test.sql` (`create_order_approval` T28, `receive_purchase_order` T19), `staff_submit_eod_cases_each.test.sql`, `apply_item_scalars_to_brand.test.sql` and `apply_item_vendors_to_brand.test.sql`.

| # | AC | Caller | Case | Expect |
|---|---|---|---|---|
| T01 | — | master | `auth_can_see_store(A) and auth_can_see_store(B)` | `ok` (anti-vacuity) |
| T02 | — | admin | same | `ok` |
| T03 | — | manager | `auth_can_see_store(B) and not auth_can_see_store(A)` | `ok` |
| T04 | AC-1 | master | `update iA1 set store_id = B` | 42501 R-1 msg |
| T05 | AC-1 | master | iA1.store_id, and the store of the item `line_A` resolves to | A / A |
| T06 | AC-1 | manager | `update iB5 set store_id = A` | 42501 R-1 msg (trigger before WITH CHECK) |
| T07 | AC-2 | master | `update iA2 set id = '<new literal>'` | 42501 R-1 msg |
| T08 | AC-2 | master | count at iA2 (store A) = 1; count at new id = 0 | ok |
| T09 | AC-3 | master | `insert (iA3, B, cA3) on conflict (id) do update set store_id = excluded.store_id` | 42501 **R-1** msg |
| T10 | AC-3 | master | iA3.store_id | A |
| T11 | AC-4 | master | `update iA3 set id = id, store_id = store_id, par_level = 7` | `lives_ok` |
| T12 | AC-4 | master | iA3.par_level | 7 |
| T13 | AC-4 | master | `insert (iA3, A, cA3, par 9) on conflict (id) do update set store_id = excluded.store_id, par_level = excluded.par_level` | `lives_ok` |
| T14 | AC-4 | master | iA3.par_level | 9 |
| T15 | AC-5 | postgres | `update iA1 set store_id = B` | 42501 R-1 msg |
| T16 | AC-5 | postgres | `update iA2 set id = '<new literal>'` | 42501 R-1 msg |
| T17 | AC-5 | postgres | iA1 still A; iA2 still under its original id | ok |
| T18 | AC-6 | manager | PATCH iB5 with `cost_per_unit, current_stock, par_level, vendor_id, case_price, eod_remaining` | `lives_ok` |
| T19 | AC-6 | postgres | the six values | changed |
| T20 | AC-6 | master | `receive_purchase_order(PO_A2, [line on iA4], gen_random_uuid())` | `lives_ok` |
| T21 | AC-6 | postgres | iA4.current_stock increased by the received qty | ok |
| T22 | AC-6 | manager | `staff_submit_eod(…, Frederick, d3, …, [iB6 entry], V)` | `lives_ok` |
| T23 | AC-6 | postgres | iB6.current_stock = the submitted remaining | ok |
| T24 | AC-6 | admin | `apply_item_scalars_to_brand(cS, par, cost, case)` →> `updated_count` | 2 |
| T25 | AC-6 | postgres | iA5 and iB4 scalars | changed |
| T26 | AC-6 | admin | `apply_item_vendors_to_brand(cS, [V link], V)` | `lives_ok` |
| T27 | AC-6 | postgres | iA5.vendor_id and iB4.vendor_id | V |
| T28 | AC-6 | master | `create_inventory_item_with_catalog(brand, A, 'spec179 fresh …')` →> `id`; row exists with store A; 0 tombstones for it | ok |
| T29 | AC-8 | manager | `delete iB1` | `lives_ok` |
| T30 | AC-8 | postgres | iB1 gone; tombstones for iB1: exactly 1, store B | ok |
| T31 | AC-8 | manager | `count(*)` from tombstones | 0 |
| T32 | AC-9 | admin | `delete from public.stores where id = S_C` (PO_C **unlined**; see §2.5 correction) | `lives_ok` |
| T33 | AC-9 | postgres | S_C, iC1, iC2, PO_C and the `item_vendors (iC1, V)` link all gone | ok |
| T34 | AC-9 | postgres | tombstones `(iC1,S_C)`, `(iC2,S_C)` | count 2 |
| T35 | AC-10 | postgres | `delete from public.brands where id = Z` (re-pinned, §2.5 correction) | 23503 `… "inventory_items_catalog_id_fkey" …` (pre-existing) |
| T36 | AC-10 | postgres | Z, S_Z, iZ1, iZ2 all still present | ok |
| T37 | AC-10 | postgres | tombstones for S_Z / iZ1 / iZ2 | count 0 (the aborted cascade rolled back) |
| T38 | AC-11 | admin | the d2 approval: `status = 'pending'`, `lines->0->>'item_id'` = iB2 | ok (anti-vacuity) |
| T39 | AC-11 | admin | `delete iB2` | `lives_ok` |
| T40 | AC-11 | postgres | tombstone `(iB2, B)` exists | 1 |
| T41 | AC-11 | admin | `insert (iB2, A, cB2)` | 42501 **R-2** msg |
| T42 | AC-11 | postgres | count id = iB2 = 0; and 0 Charles items match the approval's line id | ok |
| T43 | AC-12 | postgres | same insert | 42501 R-2 msg |
| T44 | AC-12 | postgres | count id = iB2 | 0 |
| T45 | AC-13 | master | `delete iB3` | `lives_ok` |
| T46 | AC-13 | master | `insert (iB3, B, cB3)` | `lives_ok` |
| T47 | AC-13 | postgres | iB3 exists, store B | ok |
| T48 | AC-14 | master | `delete iB3` again | `lives_ok` |
| T49 | AC-14 | postgres | tombstones for iB3: count 1, store B | ok |
| T50 | AC-15 | master | `delete iA1` | 23503 with the exact FK message (`… violates foreign key constraint "po_items_item_id_fkey" on table "po_items"`; confirm the constraint name locally) |
| T51 | AC-15 | postgres | iA1 exists; 0 tombstones for iA1 | ok |
| T52 | D-4 | postgres | `delete iN` | `lives_ok` |
| T53 | D-4 | postgres | 0 tombstones for iN | ok |
| T54 | AC-16 | postgres | **Fix round 1 (code-reviewer SF-1 / architect M-3):** the snapshot must **execute before the first admin write attempt on the tombstone table** (T57's INSERT, T59's UPDATE/DELETE). Use a `reset role` / re-claim hop if needed. Snapshot `count(*)` into a setting and assert > 0 | ok (anti-vacuity for T55-T61) |
| T55 | AC-16 | admin | `count(*)` | 0 |
| T56 | AC-16 | postgres (catalog) | anon SELECT: anon has no BYPASSRLS, is not superuser, is not a member of the owner; RLS is on; no SELECT/ALL policy for anon or PUBLIC | ok |
| T57 | AC-16 | admin | `insert (gen_random_uuid(), A)` | 42501 RLS msg |
| T58 | AC-16 | postgres (catalog) | anon INSERT: same catalog facts; no INSERT/ALL policy | ok |
| T59 | AC-16 | admin | `update … set store_id = A`; `delete from …` | `lives_ok` |
| T60 | AC-16 | postgres (catalog) | anon UPDATE/DELETE: same catalog facts; no UPDATE/DELETE/ALL policy | ok |

T56/T58/T60 are catalog arms, not `set role anon` (accepted in post-impl review). `set role anon` segfaults the CI Postgres image (spec 067, `reports_anon_revoke.test.sql`), and no committed pgTAP file uses it.
| T61 | AC-16 | postgres | count = T54 snapshot **and** = the exact expected count; `(iB1, B)` row intact. The architect counted 5 with the original arm order: `(iB1,B)`, `(iC1,S_C)`, `(iC2,S_C)`, `(iB2,B)`, `(iB3,B)`. The developer re-derives it after placing T74-T80: those arms add **no** tombstone, because every one of them is refused and rolled back. | ok |
| T62 | AC-16 (D-1 A) | postgres | `not has_table_privilege('authenticated', tombstones, 'TRUNCATE')` | ok |
| T63 | AC-16 (D-1 A) | postgres | same for `anon` | ok |
| T64 | AC-16 | postgres | `relrowsecurity and not relforcerowsecurity`, and 0 rows in `pg_policies` for the table | ok |
| T65 | AC-16 | postgres | not in `pg_publication_tables` for `supabase_realtime` | ok |
| T66-T68 | AC-17 | postgres | per function: `not has_function_privilege('anon', …)`, `not … ('authenticated', …)`, `proacl is not null` and no PUBLIC EXECUTE in `aclexplode(proacl)` (spec 177 T49-T51) | `ok` × 3 |
| T69 | AC-17 / D-6 | postgres | `prosecdef`: lock false, check true, writer true | ok |
| T70 | AC-17 / D-6 | postgres | `proconfig`: lock `{search_path=public}`; check and writer contain `search_path=""` | ok |
| T71 | D-6 | postgres | `proowner` of both definer functions = `relowner` of the tombstone table = `relowner` of `inventory_items` | ok |
| T72 | AC-18 | postgres | the 3 triggers on `public.inventory_items`, `tgenabled = 'O'`, `pg_get_triggerdef` matching `BEFORE UPDATE OF id, store_id … FOR EACH ROW` / **`AFTER INSERT … FOR EACH ROW`** (`inventory_items_tombstone_check_trg`, fix round 1) / `AFTER DELETE … FOR EACH ROW`. Also assert 0 non-internal BEFORE INSERT triggers on `inventory_items`. | count 3, and 0 |
| T73 | D-8 | postgres | `array_agg(tgname order by tgname)` of non-internal BEFORE UPDATE triggers on `inventory_items` | `{inventory_items_identity_lock_trg, inventory_items_updated_at, trg_item_vendor_changed_at}` |
| T74 | M1 (AC-12) | postgres | `with d as (delete from public.inventory_items where id = iB7 returning id, catalog_id) insert into public.inventory_items (id, store_id, catalog_id) select id, A, catalog_id from d` | 42501 **R-2** msg |
| T75 | M1 | postgres | iB7 still exists with store B (count 1); 0 rows with id iB7 in store A; 0 tombstones for iB7 (the aborted statement rolled the writer back) | ok |
| T76 | M1 (AC-11) | master (authenticated, sees A and B) | the same CTE on iB8 | 42501 **R-2** msg |
| T77 | M1 | postgres | iB8 still in B; 0 in A; 0 tombstones for iB8 | ok |
| T78 | SF-2 / D-4 | postgres | `insert (iB1, NULL, cB1)`. iB1 was tombstoned at B by T29, so this must run **after** T29. No `(NULL, cB1)` collision is possible, because NULLs are distinct | 42501 **R-2** msg |
| T79 | SF-2 | postgres | count of id iB1 in `inventory_items` | 0 |
| T80 | L1 | authenticated, **zero-store** caller (fresh literal `sub`, `app_metadata.role = 'user'`, no profile row, no `user_stores`; first assert `not auth_can_see_store(A)` inside the same arm or a guard `do`) | `insert (iB2, A, cB2)`, after T39 has tombstoned iB2 at B | 42501 RLS msg `new row violates row-level security policy for table "inventory_items"`, **not** R-2 |

Rules for the developer:
- If T06 reports the generic RLS message, or T09 / T41 / T74 / T76 / T78 report anything other than the designed message, or T80 reports the R-2 message, **report it. Do not loosen the assertion.** It would mean an ordering assumption (§2.4) is wrong.
- **Fix round 1 negative control** (in addition to the one below): with the check temporarily re-created **BEFORE INSERT** in a scratch copy, T74-T77 and T80 must fail. That proves the new arms discriminate on the trigger's timing, not just on whether it exists.
- **Negative control** (scratch copy, not committed): disable the three new triggers and run the file. Every refusal arm (T04, T06, T07, T09, T15, T16, T41, T43, and since fix round 1 T74, T76, T78) and every tombstone-presence arm (T30, T34, T40, T49), plus T72 and the read-backs T75, T77 and T79, must fail. T80 does not discriminate on whether the triggers exist (the RLS message is the same either way); it discriminates on timing (see the bullet above). T37 was re-pinned to "0 tombstones" (§2.5 correction), so it passes with or without the triggers. Record the count, as spec 177 did ("32/54"). The fixture design above (no `item_vendors` on iA2 / iB2, per-item catalogs) is what makes those arms fail **only** because the trigger is missing.
- T57 / T58 assert the real RLS message. Postgres quotes the table name exactly as shown in §4.

**AC-7 / N7 audit (done at design time, by grep):**
- Tests that `UPDATE public.inventory_items`, and which columns they write:
  - `eod_no_need` (`par_level`);
  - `ingredient_changed_badge` (`vendor_id`, `cost_per_unit`, `vendor_changed_at`);
  - `report_reorder_list_on_hand_source` (`par_level`, `current_stock`).
  
  None touches `id` or `store_id`.
- No committed test deletes `inventory_items` directly. Store deletes (`legacy_permissive_policy_dropout`, `audit_log_rls_hardening`, and spec 178's untracked `order_approvals_fk_set_null`) cascade into tombstones inside their own rolled-back transaction, and none re-inserts a deleted id anywhere. No test uses `on conflict (id) do update` on `inventory_items`.
- `seed.sql`:
  - it inserts explicit item ids once, with `on conflict (id) do nothing` (no DO UPDATE);
  - its only delete (`stores …0002`, L186) runs **before** any item insert, and that store owns no items (init_schema seeds stores only);
  - `db reset` applies migrations before the seed, so the BEFORE INSERT check runs over seed rows against an empty tombstone table.
- `scripts/` only reads `inventory_items` (`smoke-staff-eod.sh`).
- **AC-7 holds by inspection.** The build confirms it with the full `scripts/test-db.sh` run.

### 10. Prod apply runbook (AC-22 / AC-23). Execute only on the owner's explicit go-ahead, BEFORE the push.

Project `ebwnovzzkwhsdxkpyjka`, Supabase MCP `execute_sql`. **Do not use `apply_migration`**: it mints its own version. Spec 177's S-1, S-2, M-1, M-2 and M-3 corrections are built in.

**M-1 (before Step 1):**
1. Re-apply the **committed** file to the local stack, using `npx supabase db reset`, or `npx supabase migration up --local` if nothing changed. If spec 178's lower version `20261026000000` arrived after this one was applied locally, use `db reset`, or `migration up --include-all`.
2. Recompute the three local normalized md5s.
3. Confirm they equal the values recorded under `## Files changed`. A mismatch means the file changed after testing: re-run pgTAP first.

**Step 1: read-only pre-check.** STOP and report to the owner on any unexpected value.
```sql
select version();                                                     -- expect PostgreSQL 17.x
select version, name from supabase_migrations.schema_migrations
 where version >= '20261025000000' order by 1;
-- expect '20261025000000' (cross_store_item_rejection). '20261026000000' (spec 178) MAY also be
-- present; either way is fine (independent tables). STOP on '20261026100000' or any other version.
select to_regprocedure('public.inventory_items_lock_identity()'),
       to_regprocedure('public.inventory_items_check_tombstone()'),
       to_regprocedure('public.inventory_items_record_tombstone()'),
       to_regclass('public.inventory_item_tombstones');                -- expect 4 x NULL
select count(*) from pg_trigger
 where tgname in ('po_items_check_store_trg','order_approvals_lines_check_store_trg',
                  'purchase_orders_lock_store_id_trg') and tgenabled = 'O';   -- expect 3 (spec 177 live)
select count(*) from public.order_approvals;                          -- expect 0
-- If not 0: every approval line must name a live item of the approval's own store (expect 0 / 0 / 0).
select count(*) filter (where not x.ok_shape)                                        as malformed,
       count(*) filter (where x.ok_shape and ii.id is null)                          as dangling,
       count(*) filter (where ii.id is not null and ii.store_id is distinct from x.store_id) as cross_store
  from (select oa.store_id, e,
               (jsonb_typeof(e) = 'object'
                and pg_input_is_valid(coalesce(e->>'item_id',''), 'uuid')) as ok_shape
          from public.order_approvals oa,
               jsonb_array_elements(case when jsonb_typeof(oa.lines) = 'array'
                                         then oa.lines else '[]'::jsonb end) e) x
  left join public.inventory_items ii
    on ii.id = case when x.ok_shape then (x.e->>'item_id')::uuid end;
-- po_items re-run (expect cross_store 0, orphan 0; total about 40 or more)
select count(*) filter (where ii.id is not null and po.id is not null
                          and ii.store_id is distinct from po.store_id) as cross_store_lines,
       count(*) filter (where pi.item_id is not null and ii.id is null)   as orphan_item,
       count(*)                                                           as total
  from public.po_items pi
  left join public.inventory_items ii on ii.id = pi.item_id
  left join public.purchase_orders po on po.id = pi.po_id;
select count(*) from public.inventory_items where store_id is null;   -- informational (D-4)
-- FK actions (D-10). STOP if inventory_items.store_id is not confdeltype 'c' / confupdtype 'a',
-- or if any FK makes inventory_items.store_id / id the target of SET NULL, SET DEFAULT or CASCADE-on-update.
-- Expect: store_id c/a; last_updated_by n/a; vendor_id a/a; catalog_id a/a;
-- referencing: po_items, eod_entries, waste_log a; inventory_count_entries r; flags n; item_vendors c (all confupdtype a).
-- Report any other referencing FK (it writes its own child table only, so it is not a blocker).
select conrelid::regclass, conname, confrelid::regclass, confupdtype, confdeltype, pg_get_constraintdef(oid)
  from pg_constraint
 where contype = 'f'
   and (conrelid = 'public.inventory_items'::regclass or confrelid = 'public.inventory_items'::regclass)
 order by 1, 2;
-- Existing triggers. Expect exactly inventory_items_updated_at and trg_item_vendor_changed_at, both 'O', BEFORE UPDATE.
select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.inventory_items'::regclass and not tgisinternal order by 1;
-- Ownership / RLS / publication. Expect postgres / t / f, and puballtables = false.
select relowner::regrole, relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.inventory_items'::regclass;
select puballtables from pg_publication where pubname = 'supabase_realtime';
-- D-1 / N6 evidence (record only)
select defaclrole::regrole, defaclacl from pg_default_acl
 where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r';
select has_table_privilege('authenticated','public.inventory_items','TRUNCATE') as auth_truncate_items,
       has_table_privilege('anon','public.inventory_items','TRUNCATE')          as anon_truncate_items;
-- Side effects of the Step 5 probes' synthetic catalog row (record; anything other than BEFORE UPDATE stamps → report)
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.catalog_ingredients'::regclass and not tgisinternal;
-- Cascade firing order (record only, NOT a STOP; §2.5 correction, owner follow-up).
-- Within one parent row, RI ON DELETE action triggers fire in tgname order.
-- Locally, brands: the catalog_ingredients child sorts before stores;
-- stores: inventory_items sorts before purchase_orders.
select t.tgrelid::regclass as parent, t.tgname, c.conrelid::regclass as child, c.conname, c.confdeltype
  from pg_trigger t
  join pg_constraint c on c.oid = t.tgconstraint
 where t.tgisinternal
   and t.tgrelid in ('public.brands'::regclass, 'public.stores'::regclass)
   and c.confrelid = t.tgrelid
   and (t.tgtype & 8) <> 0                     -- DELETE event
 order by 1, 2;
```

**Step 2 (S-1): apply.** Pass the full text of `supabase/migrations/20261026100000_inventory_items_identity_lock.sql` exactly as committed, from line 1 to the final `commit;`, as **one** `execute_sql` call. Do not strip the header, the wrapper or the comments, and do not substitute a `pg_get_functiondef` dump (that would drop the table, triggers, revokes and comments). The file is all-or-nothing. On `55P03` nothing was created: re-run the same call off-peak.

**Step 3 (M-2): record.** This is a separate call, because the file commits itself.
```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20261026100000', 'inventory_items_identity_lock')
on conflict (version) do nothing;
select version, name from supabase_migrations.schema_migrations where version = '20261026100000';
-- expect exactly one row: 20261026100000 / inventory_items_identity_lock
```

**Step 4: verify.** Run on prod. The md5s must equal the fresh M-1 local values.

Expected normalized md5s, computed locally by the backend-developer on 2026-10-26 from the fix-round-1 file (re-applied verbatim with `docker exec -i supabase_db_imr-inventory psql -U postgres -v ON_ERROR_STOP=1 < …`) using exactly the three queries below. If M-1's fresh recompute differs from these, the file changed after testing: STOP and re-run pgTAP.

| Function | Expected normalized md5 |
|---|---|
| `public.inventory_items_lock_identity()` | `0af4acdbda17cdab680f113f7378946a` (body unchanged by fix round 1; re-confirmed) |
| `public.inventory_items_check_tombstone()` | `9cfb8c5a2e02129e7ec9c1917c33d4d3` (fix round 1: narrowed probe, `return null`). Superseded pre-fix value: `b8abd897abdf5a8a235b01982ffd4e06`, which must NOT match. |
| `public.inventory_items_record_tombstone()` | `a00f5436b51e1550023d51cabb96c55e` (body unchanged by fix round 1; re-confirmed) |

The trigger's timing (BEFORE vs AFTER) is **not** part of any function md5. It is verified only by the `pg_trigger` query below. Expect `inventory_items_tombstone_check_trg` to show `AFTER INSERT ON public.inventory_items FOR EACH ROW`.
```sql
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.inventory_items_lock_identity()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.inventory_items_check_tombstone()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
  'public.inventory_items_record_tombstone()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
select p.proname, p.prosecdef, p.proconfig, p.proowner::regrole, p.proacl,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('inventory_items_lock_identity','inventory_items_check_tombstone','inventory_items_record_tombstone');
-- expect: lock prosecdef f / {search_path=public}; check and writer t / {search_path=""}; owner postgres;
-- anon_x and auth_x false; no PUBLIC (=X/) entry in proacl
select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.inventory_items'::regclass and not tgisinternal order by 1;
-- expect 5 rows: the two pre-existing ones plus the three new, all 'O', with the §2 event lists:
-- identity_lock BEFORE UPDATE OF id, store_id; tombstone_check AFTER INSERT; tombstone_record AFTER DELETE
select c.relowner::regrole, c.relrowsecurity, c.relforcerowsecurity,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'inventory_item_tombstones') as policies,
       (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'inventory_item_tombstones') as published,
       has_table_privilege('authenticated', c.oid, 'SELECT')   as auth_select,     -- expect t (Category B)
       has_table_privilege('anon',          c.oid, 'SELECT')   as anon_select,     -- expect t
       has_table_privilege('service_role',  c.oid, 'SELECT')   as svc_select,      -- expect t
       has_table_privilege('authenticated', c.oid, 'TRUNCATE') as auth_truncate,   -- expect f under D-1 A
       has_table_privilege('anon',          c.oid, 'TRUNCATE') as anon_truncate    -- expect f under D-1 A
  from pg_class c where c.oid = 'public.inventory_item_tombstones'::regclass;
-- expect postgres / t / f / 0 / 0
select count(*) from public.inventory_item_tombstones;   -- expect 0 (no backfill). Record N4 = this value.
-- A non-zero N4 is legitimate ONLY if a real item delete ran on prod between Step 2 and now:
-- inspect the rows (deleted_at > the Step 2 time, store_id of a real store) before continuing.
```

**Step 5 (S-2): negative probes.** Four separate `execute_sql` calls, one DO block each (probe 4 was added in fix round 1). There are no placeholders. Each block creates its own synthetic catalog row and item and **ends in an exception on every path**, so nothing persists whether or not a trigger fired. They run as `postgres` (RLS bypassed), which proves the guards are not RLS rules.

Probe 1, the R-1 `store_id` lock:
```sql
do $$
declare v_s1 uuid; v_s2 uuid; v_brand uuid; v_cat uuid; v_item uuid := gen_random_uuid();
begin
  select s1.id, s2.id, s1.brand_id into v_s1, v_s2, v_brand
    from public.stores s1
    join public.stores s2 on s2.brand_id = s1.brand_id and s2.id <> s1.id
   order by s1.id, s2.id limit 1;
  if v_s1 is null then raise exception 'PROBE SKIPPED: no two stores share a brand'; end if;
  insert into public.catalog_ingredients (brand_id, name, unit)
  values (v_brand, 'spec179 probe ' || v_item::text, '') returning id into v_cat;
  insert into public.inventory_items (id, store_id, catalog_id) values (v_item, v_s1, v_cat);
  begin
    update public.inventory_items set store_id = v_s2 where id = v_item;
  exception when sqlstate '42501' then
    if sqlerrm = 'inventory_items: id and store_id are immutable' then
      raise exception 'PROBE OK: %', sqlerrm;
    end if;
    raise exception 'PROBE FAILED: unexpected 42501: %', sqlerrm;
  end;
  raise exception 'PROBE FAILED: inventory_items_identity_lock_trg did not fire on store_id';
end $$;
```

Probe 2, the R-1 `id` lock: identical, except the inner statement is `update public.inventory_items set id = gen_random_uuid() where id = v_item;` and the last line reads `… did not fire on id`.

Probe 3, the R-2 cross-store reinsert, which also proves the writer fires:
```sql
do $$
declare v_s1 uuid; v_s2 uuid; v_brand uuid; v_cat uuid; v_item uuid := gen_random_uuid();
begin
  select s1.id, s2.id, s1.brand_id into v_s1, v_s2, v_brand
    from public.stores s1
    join public.stores s2 on s2.brand_id = s1.brand_id and s2.id <> s1.id
   order by s1.id, s2.id limit 1;
  if v_s1 is null then raise exception 'PROBE SKIPPED: no two stores share a brand'; end if;
  insert into public.catalog_ingredients (brand_id, name, unit)
  values (v_brand, 'spec179 probe ' || v_item::text, '') returning id into v_cat;
  insert into public.inventory_items (id, store_id, catalog_id) values (v_item, v_s1, v_cat);
  delete from public.inventory_items where id = v_item;
  if not exists (select 1 from public.inventory_item_tombstones
                  where id = v_item and store_id = v_s1) then
    raise exception 'PROBE FAILED: inventory_items_tombstone_record_trg wrote no tombstone';
  end if;
  begin
    insert into public.inventory_items (id, store_id, catalog_id) values (v_item, v_s2, v_cat);
  exception when sqlstate '42501' then
    if sqlerrm = 'inventory_items: id was previously used by another store' then
      raise exception 'PROBE OK: %', sqlerrm;
    end if;
    raise exception 'PROBE FAILED: unexpected 42501: %', sqlerrm;
  end;
  raise exception 'PROBE FAILED: inventory_items_tombstone_check_trg did not fire';
end $$;
```

Probe 4 (fix round 1, security M1): the single-statement writable-CTE delete + reinsert:
```sql
do $$
declare v_s1 uuid; v_s2 uuid; v_brand uuid; v_cat uuid; v_item uuid := gen_random_uuid();
begin
  select s1.id, s2.id, s1.brand_id into v_s1, v_s2, v_brand
    from public.stores s1
    join public.stores s2 on s2.brand_id = s1.brand_id and s2.id <> s1.id
   order by s1.id, s2.id limit 1;
  if v_s1 is null then raise exception 'PROBE SKIPPED: no two stores share a brand'; end if;
  insert into public.catalog_ingredients (brand_id, name, unit)
  values (v_brand, 'spec179 probe ' || v_item::text, '') returning id into v_cat;
  insert into public.inventory_items (id, store_id, catalog_id) values (v_item, v_s1, v_cat);
  begin
    with d as (delete from public.inventory_items where id = v_item returning id, catalog_id)
    insert into public.inventory_items (id, store_id, catalog_id)
    select d.id, v_s2, d.catalog_id from d;
  exception when sqlstate '42501' then
    if sqlerrm = 'inventory_items: id was previously used by another store' then
      raise exception 'PROBE OK: %', sqlerrm;
    end if;
    raise exception 'PROBE FAILED: unexpected 42501: %', sqlerrm;
  end;
  raise exception 'PROBE FAILED: single-statement delete+reinsert was not refused';
end $$;
```

Expected results: four ERRORs:
- `PROBE OK: inventory_items: id and store_id are immutable` (×2, probes 1 and 2);
- `PROBE OK: inventory_items: id was previously used by another store` (×2, probes 3 and 4).
- **`PROBE FAILED` means STOP:** report to the owner and do not push.
- **`PROBE SKIPPED`** means fall back to Step 4 plus the local pgTAP run.
- Afterwards, re-run `select count(*) from public.inventory_item_tombstones;` and expect **N4**, the value recorded in Step 4. That proves the tombstones from probes 3 and 4 rolled back. The original "expect 0" was only correct if no real item delete ran during the apply window.
- If the count is above N4, list the new rows (`… where deleted_at > <Step 4 time>`). Each one must be a real delete: confirm it with the owner. An unexplained row is a STOP.

**Step 6: push, then gates.**
- Commit and push only **after** Steps 2-4 succeed.
- **M-3 / AC-23 ordering:**
  - stage spec 179's paths explicitly (no `git add -A`), so spec 176 (staged, `src/**`), spec 177 (staged) and spec 178 (untracked `order_approvals_fk_set_null.test.sql`) stay in separable commits;
  - **explicit staging is not enough while 176 and 177 are already staged.** A bare `git commit` sweeps everything in the index into one commit. Either commit 176 and 177 first, in their own commits, or commit 179 with a pathspec: `git commit -- <179 paths>`. The user runs the commit (project memory).
  - spec 178's untracked `supabase/tests/order_approvals_fk_set_null.test.sql` **fails 8/12 locally today** (backend-developer's gate run, independent of spec 179). If it rides along with any push, `test.yml` goes red. It must not be staged until spec 178 lands its migration;
  - the push that carries `20261026100000` must also carry spec 177's `20261025000000`, or come after it (spec 177 is on prod but not yet on `main`);
  - it must **not** carry spec 178's migration file unless 178's version is already in prod `schema_migrations`. Otherwise `db-migrations-applied.yml` goes red.
- If 178 is applied later with its lower version `20261026000000`, that is fine for the gate (it compares sets, not order). The MCP apply path has no ordering check.
- After the push, confirm that the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green (`gh run list --branch main --workflow <file> --limit 1`), and check `e2e.yml` by hand (project memory).

**Step 7: rollback.**
- **First response to a false refusal (preferred): drop only the triggers.** Keep the table, its rows and the functions:
  ```sql
  begin;
  set local lock_timeout = '5s';
  drop trigger if exists inventory_items_identity_lock_trg    on public.inventory_items;
  drop trigger if exists inventory_items_tombstone_check_trg  on public.inventory_items;
  drop trigger if exists inventory_items_tombstone_record_trg on public.inventory_items;
  commit;
  ```
  While the triggers are gone, deletes record no tombstones. That is a protection gap: report how long it lasted. Re-creating the triggers means re-running Step 2, which is safe to re-run.
- **Full removal.** Only with a reverting commit that deletes the migration file. Otherwise the repo and prod diverge silently and the gate stays green while the schema differs.
  1. Export the tombstones first: `select coalesce(json_agg(t order by deleted_at), '[]') from public.inventory_item_tombstones t;`, saved to `specs/179-inventory-item-identity-lock/reviews/`. They are the only record of which store owned each deleted id, and re-applying the lock later without them reopens vector 3 for every id deleted in between.
  2. Run:
     ```sql
     begin;
     set local lock_timeout = '5s';
     drop trigger if exists inventory_items_identity_lock_trg    on public.inventory_items;
     drop trigger if exists inventory_items_tombstone_check_trg  on public.inventory_items;
     drop trigger if exists inventory_items_tombstone_record_trg on public.inventory_items;
     drop function if exists public.inventory_items_lock_identity();
     drop function if exists public.inventory_items_check_tombstone();
     drop function if exists public.inventory_items_record_tombstone();
     drop table if exists public.inventory_item_tombstones;
     delete from supabase_migrations.schema_migrations where version = '20261026100000';
     commit;
     ```
- **Ops repair (the owner's policy, R-1).** A mis-filed item is deleted and **re-created with a new id** in the right store (`create_inventory_item_with_catalog` always generates one). The same id can never come back in another store. An item that still has `po_items` / `eod_entries` / `waste_log` / count references can't be deleted (FK) or moved (R-1). Moving one anyway requires, as `postgres`, `begin; set local lock_timeout='5s'; alter table public.inventory_items disable trigger inventory_items_identity_lock_trg; …; alter table … enable trigger …; commit;`. That is a deliberate policy override: record it in the spec.

### 11. Risks and tradeoffs

1. **D-1 is closed: Option A** (owner, 2026-10-26; see §0). The TRUNCATE revoke shipped, and T62/T63 pin it.
2. **False refusal of a legitimate write.** Mitigated by:
   - the writer audit, re-verified (§4);
   - value comparison (AC-4: T11 and T13);
   - real-RPC arms (T20-T28);
   - the unmodified-suite audit (§9).
   
   The residual case is a future writer that upserts on `id` with a changed `store_id`. That is exactly what R-1 forbids.
3. **Cascade deletes break.** A store or brand delete now runs one definer INSERT per item. The writer has no FK, cannot conflict except into a no-op, and the table is owner-bypassed. T32-T34 pin a successful store cascade under an authenticated admin. T35-T37 pin the brand cascade as it is today: it fails with a pre-existing 23503 and leaves no tombstone (§2.5 correction). Store and brand delete failures that exist today are unchanged, neither introduced nor fixed here:
   - a store whose items have `po_items` lines;
   - a brand whose stores own items;
   - an `inventory_count_entries` RESTRICT;
   - the spec 178 `order_approvals` SET NULL guard.

   The brand and store cascade-order failures are owner follow-ups.
4. **SECURITY DEFINER surface.** Two definer functions now run on every item insert and delete. Mitigations:
   - `search_path = ''`, with every relation qualified;
   - execute revoked;
   - the functions cannot be called directly (trigger-only);
   - static messages;
   - no caller-controlled SQL;
   - the owner equality pinned by T71.
5. **Oracle (D-5, corrected in fix round 1).** With the check AFTER INSERT, only a caller who passes RLS WITH CHECK for the named store can see the R-2 message. That caller already has the 23505 oracle for live ids. A zero-store or wrong-store caller gets only the RLS message (security L1 closed; T80). Static text, no store id.
6. **Concurrency (D-7, re-ruled in fix round 1).**
   - **READ COMMITTED** (every app path): closed by the PK unique-index wait plus the fresh per-statement snapshot in the AFTER check.
   - **REPEATABLE READ / SERIALIZABLE:** fails closed (40001) through the narrowed `FOR KEY SHARE` probe **only when the other-store row existed in the inserting transaction's snapshot**. The probe sees that row, and locking a row whose delete committed after the snapshot raises 40001.
   - **Residual (security L4, accepted in fix round 1b, wording-only option a):** an other-store row created **and** deleted entirely after the inserting transaction's snapshot is seen by neither the probe nor the tombstone read, so a cross-store reinsert of its id passes. Only a raw `postgres` / `service_role` session holding a REPEATABLE READ / SERIALIZABLE transaction open can reach it. PostgREST runs READ COMMITTED and no RPC raises the isolation level, so no app or untrusted surface reaches it. Closing it would need an id-to-store claim table keyed on `id` (security L4 option b), which is not built.

   All branches are reasoned, not pgTAP-tested. The md5 pins the body. The security re-review confirmed the READ COMMITTED and in-snapshot RR branches and raised the residual.
7. **Privileged bypasses (informational).**
   - `service_role` and `postgres` can delete tombstone rows (BYPASSRLS / owner). They are trusted identities.
   - A TRUNCATE of `inventory_items` by any role holding TRUNCATE skips tombstones (N6, unreachable over PostgREST).
   - The PG17 `MAINTAIN` privilege in the default ACL lets a raw-session `anon` / `authenticated` take `LOCK TABLE` on the tombstone table. That too is unreachable over PostgREST and is project-wide.
8. **Ops repair cost (owner policy).** A genuinely mis-filed item can't be moved without a deliberate trigger override (§10 Step 7).
9. **Prod / repo drift and ordering.** Prod apply must precede the push (AC-23). Spec 177 is applied but unpushed, and spec 178 may land a lower version later. Both are covered in Step 6. The pre-check STOPs on any unexpected version at or after `20261025000000`.
10. **Performance at seed scale.** Item insert: +2 PK probes. Item delete: +1 small insert. A seeded store of a few hundred items cascades in milliseconds. The tombstone table grows by one row per deleted item, which is negligible. Retention is out of scope. No edge function is involved, so there is no cold-start impact.
11. **Local ordering with spec 178.** If 178's `20261026000000` is created after this migration was applied locally, `supabase migration up` refuses the out-of-order file. Use `npx supabase db reset` (or `--include-all`). CI applies migrations fresh, so it is unaffected.
12. **Single-statement vector (security M1): closed in fix round 1.**
    - The check moved to AFTER INSERT, so a writable-CTE delete + reinsert is refused for every caller. T74-T77 and §10 probe 4 pin it.
    - The migration is edited in place, which is safe because it is not on prod and not pushed. Locally, re-apply with `npx supabase db reset`. `migration up` does not re-run an already-applied version, and re-running the file directly also works because the file is re-runnable: `drop trigger if exists` replaces the BEFORE trigger with the AFTER one.
    - Out of scope and unchanged: security L2 (TRIGGER / REFERENCES / MAINTAIN in the default ACL, folded into the spec 170 L4 sweep) and backend-architect S-3 (the brand and store cascade-order bugs, a new spec).

### 12. Files the build will add

- **Add:** `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`
- **Add:** `supabase/tests/inventory_items_identity_lock.test.sql`
- **Not touched:** `src/**`, `supabase/functions/**`, `supabase/config.toml`, `app.json`, every spec 176 / 177 / 178 file, and every existing pgTAP file (including both lints).

Gates (AC-20):
- `scripts/test-db.sh` (all pgTAP, including both lints);
- full `npx jest`;
- `npm run typecheck`;
- `npm run typecheck:test`.

Record under `## Files changed`:
- the three local normalized md5s;
- the negative-control count;
- the D-1 self-check result.

## Handoff
next_agent: backend-developer
prompt: Fix round 1. Implement the amended design: §2.4 (AFTER INSERT check), D-7, §9 T54/T61 and T72-T80 with plan(80), §10 Steps 4-5. Apply release-proposal fix steps 2-6 in specs/179-inventory-item-identity-lock/reviews/release-proposal.md. Edit the migration and test file in place. After implementation, set Status: READY_FOR_REVIEW and add a "Fix round 1" entry under ## Files changed.
payload_paths:
  - specs/179-inventory-item-identity-lock.md
  - specs/179-inventory-item-identity-lock/reviews/release-proposal.md
  - specs/179-inventory-item-identity-lock/reviews/security-auditor.md

## Files changed

Backend-developer, 2026-10-26. Implemented against `## Backend design`, with owner decision D-1 = Option A.

**Migrations**
- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql` (new). This adds the table `public.inventory_item_tombstones` (RLS on, no policies, no FK, TRUNCATE revoked from `anon` / `authenticated`), three functions, three triggers, comments, and three EXECUTE revokes, wrapped in `begin; set local lock_timeout = '5s'; … commit;`. Before building, the version slot was re-checked: no `20261026*` file existed (spec 178 has no migration on disk yet). Applied locally with `npx supabase migration up --local`. Re-running the file verbatim is a clean no-op apart from a NOTICE that the table exists, and the md5s don't change.

**pgTAP**
- `supabase/tests/inventory_items_identity_lock.test.sql` (new), `plan(73)`, T01-T73. It passes locally, 73/73.

**Spec**
- `specs/179-inventory-item-identity-lock.md`: Status set to READY_FOR_REVIEW; expected md5s added to §10 Step 4; this section.

Nothing else was touched: no `src/**`, `supabase/functions/**`, `config.toml`, `app.json`, or spec 176 / 177 / 178 file, and no existing pgTAP file. Nothing was staged or committed.

### Recorded values

- **D-1 self-check:** `has_table_privilege('authenticated','public.weekly_reminder_log','TRUNCATE')` returned **true** locally, so Option A's revoke is needed. After the migration, T62/T63 confirm TRUNCATE is false for `authenticated` and `anon` on the tombstone table. The ACL is `{postgres=arwdDxtm, anon=arwdxtm, authenticated=arwdxtm, service_role=arwdDxtm}`.
- **Normalized md5s (local; also in §10 Step 4):**
  - `inventory_items_lock_identity()`: `0af4acdbda17cdab680f113f7378946a`
  - `inventory_items_check_tombstone()`: `b8abd897abdf5a8a235b01982ffd4e06`
  - `inventory_items_record_tombstone()`: `a00f5436b51e1550023d51cabb96c55e`
- **Negative control** (scratch copy, not committed; the three new triggers were disabled inside the rolled-back transaction): **21/73 fail.**
  - All refusal arms fail: T04, T06, T07, T09, T15, T16, T41, T43.
  - The tombstone-presence arms T30, T34, T40 and T49 fail, and so does T72.
  - These arms also fail: T05, T08, T10, T17, T42, T44, T54, T61.
  - **T37 does not fail.** Under the corrected AC-10 (deviation 2 below), the brand cascade never reaches the writer, so T37 now pins "no tombstone" rather than tombstone presence.
- **Gates (AC-20), local:**
  - `scripts/test-db.sh` ran 93 files: **92 pass, 1 fails.** The failing file is `order_approvals_fk_set_null.test.sql`, spec 178's in-flight file (8/12 fail with `P0001 order approval is immutable`). I ran it with and without the spec 179 triggers disabled, and the failure output is byte-identical both ways, so the failures are spec 178's and not caused by this spec.
  - `public_grants_explicit` (13/13), `permissive_policy_lint` (5/5) and `cross_store_item_rejection` (54/54) pass unmodified.
  - Full `npx jest`: 266 suites, 3334 tests, all pass. `npm run typecheck` and `npm run typecheck:test` both exit 0. The working tree also holds spec 176's staged `src/**` changes, so these gates ran over those changes too.
- **AC-7:** every committed pgTAP file that writes `inventory_items` passes unmodified, including the store-delete files `legacy_permissive_policy_dropout` and `audit_log_rls_hardening`.
- **D-7 two-session demonstration:** not done. It is optional, and committing a delete in a shared local DB would leave persistent tombstones while other sessions are using it.

### Deviations from the design (each with its reason)

1. **Anon arms T56 / T58 / T60 are catalog assertions, not `set role anon`.** Project rule: `set role anon` segfaults the CI Postgres image (spec 067; `reports_anon_revoke.test.sql`). Every committed pgTAP file avoids it, and spec 177's file says so in its header. Each arm instead asserts that `anon` is subject to RLS (not BYPASSRLS, not superuser, not a member of the owner role), that RLS is enabled, and that no policy for that command applies to `anon` or PUBLIC. That is the same default-deny mechanism T55/T57/T59 exercise at runtime as `authenticated`. Plan count is unchanged (73).

2. **AC-9 / AC-10 cascade fixtures and assertions (T32-T37) were adjusted to what is actually true today.** I checked both behaviours with the spec 179 triggers disabled (scratch probe, rolled back). Both already exist without this spec. The 012c header's claim that "NO ACTION FKs defer to end-of-statement", which design §2.5 relied on, does not hold for cascaded sub-statements. A NO ACTION check fires at the end of each RI cascade sub-statement, in RI-trigger name (oid) order.
   - **Store delete (AC-9):** a store whose item has a `po_items` line **cannot be deleted today**. The `stores→inventory_items` cascade runs before `stores→purchase_orders→po_items`, so `po_items_item_id_fkey` raises 23503. AC-9 says "succeeds exactly as it does today". So `PO_C` is now **unlined**, and `S_C` keeps two items, an `item_vendors` link and an unlined PO. T32 runs as admin and succeeds. T33 checks that the store, both items, the PO and the `item_vendors` link are gone. T34 checks the 2 tombstones. The `line_c` fixture was removed.
   - **Brand delete (AC-10):** a `delete from brands` of a brand whose stores own items **fails today** with 23503 `update or delete on table "catalog_ingredients" violates foreign key constraint "inventory_items_catalog_id_fkey" on table "inventory_items"`. The cause is that `brands→catalog_ingredients` fires before `brands→stores→inventory_items`. AC-10 allows "the AC pins whatever is true", so:
     - T35 now `throws_ok` that exact 23503;
     - T36 asserts that the brand, its store and both items remain;
     - T37 asserts that the aborted cascade left **0** tombstones.
     
     So the brands→stores→items path to the tombstone writer is not exercised positively. No realistic fixture reaches it in the current schema.
   - **Follow-up findings for the owner (out of scope here; not fixed):**
     - `hard_delete_brand()` appears unable to hard-delete any brand whose stores still own items;
     - a direct store delete fails while any of its items has a `po_items` line. The same mechanism probably applies to `eod_entries` / `waste_log` / `inventory_count_entries` history, which is unverified.
     
     Prod's RI-trigger oid order may differ from a fresh local or CI build, so prod behaviour is unverified. The architect's post-impl review should confirm the AC-10 re-pin.

3. **Store fixtures carry an `address`.** `stores_address_present` (a CHECK, NOT VALID) refuses a new store without one. This is fixture-only.

The migration itself follows the design exactly. The design's `raise '<msg>' (42501)` pseudocode is written in spec 177's `raise exception '<msg>' using errcode = '42501'` form.

### Fix round 1 (backend-developer, 2026-10-26)

This implements the amended design (§2.4, D-7, §9 T54/T61 and T72-T80, §10 Steps 4-5) and release-proposal fix steps 2-6. Both files were edited in place; no new migration, no other file touched, nothing staged or committed.

**Files**
- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`:
  - `inventory_items_check_tombstone()` is now an **AFTER INSERT** row trigger. It returns null, and its `FOR KEY SHARE` probe only looks at rows of another store (`and ii.store_id is distinct from new.store_id`).
  - The trigger keeps its name; `drop trigger if exists` plus `create trigger … after insert` replaces it.
  - The header, section comments and `comment on` text now describe AFTER INSERT. They say the check covers every caller, including a single-statement delete + reinsert, and that it runs after RLS WITH CHECK. They also describe the D-7 concurrency guard and the trigger-order facts.
  - The header and comments no longer claim the brand cascade is proven. The writer covers "every deleted row, including store-delete cascades", and the header notes that a brand delete would reach items only through that same cascade, which fails today with a pre-existing 23503 (§2.5 correction).
  - No change to the table, the writer body, the lock body or the messages.
- `supabase/tests/inventory_items_identity_lock.test.sql`, `plan(80)`:
  - **Fixtures:** iB7 and iB8 (store B, own catalogs `cB7` / `cB8`, no references), the `cB1` setting, and a zero-store `sub` `c1790009-…-0001`.
  - **T74 / T75:** the writable-CTE delete + reinsert of iB7 under A, run as postgres, refused with R-2. The read-back confirms iB7 is still in B, not in A, with 0 tombstones.
  - **T76 / T77:** the same CTE for iB8, run as an authenticated master, refused with R-2, with the read-back done as postgres.
  - **T78 / T79:** `insert (iB1, NULL, cB1)` as postgres, after T29, refused with R-2; afterwards 0 rows have id iB1.
  - **T80:** the zero-store `user` caller inserts (iB2, A), after T39, and gets the RLS message, not R-2. A guard DO block first aborts the file if that caller can see store A or B.
  - **T54 / T61:**
    - The T54 snapshot moved to a `reset role` hop that runs before T55/T57/T59, then the test returns to the admin claims.
    - T61 asserts count = snapshot **and** = 5, and that `(iB1, B)` is intact. The 5 rows are (iB3,B), (iB1,B), (iC1,S_C), (iC2,S_C) and (iB2,B). T74-T80 add none.
  - **T72:** checks that the check trigger matches `AFTER INSERT … FOR EACH ROW`, and that no non-internal BEFORE INSERT trigger remains (`is(…, '3|0')`).
  - **Nits:**
    - a FLIP marker on T35-T37;
    - the owner-membership conjunct added to T58/T60 (architect M-2);
    - a header note that T-labels follow the design table, not file order;
    - T05's `pi` alias renamed to `poi`.
- `specs/179-inventory-item-identity-lock.md`: §10 Step 4 md5 table, Status, this entry.

**Re-apply (no `db reset`):** I re-ran the file verbatim with `docker exec -i supabase_db_imr-inventory psql -U postgres -v ON_ERROR_STOP=1 < …`; it committed cleanly. `pg_trigger` now shows `inventory_items_tombstone_check_trg` as `AFTER INSERT ON public.inventory_items FOR EACH ROW`, and no BEFORE INSERT trigger is left. The local tombstone table holds 0 rows.

**Normalized md5s (local; also in §10 Step 4):**

| Function | md5 |
|---|---|
| `inventory_items_lock_identity()` | `0af4acdbda17cdab680f113f7378946a` (unchanged) |
| `inventory_items_check_tombstone()` | `9cfb8c5a2e02129e7ec9c1917c33d4d3` (new; supersedes `b8abd897abdf5a8a235b01982ffd4e06`) |
| `inventory_items_record_tombstone()` | `a00f5436b51e1550023d51cabb96c55e` (unchanged) |

**Negative controls** (scratch copies, each inside the file's own rolled-back transaction):
1. **Triggers disabled: 27/80 fail.** Every arm the design requires fails:
   - refusals: T04, T06, T07, T09, T15, T16, T41, T43, T74, T76, T78;
   - tombstone presence: T30, T34, T40, T49;
   - T72;
   - read-backs: T75, T77, T79.

   These also fail: T05, T08, T10, T17, T42, T44, T54, T61.

   T80 passes, as the design predicts. T37 passes as well, because it pins 0 tombstones.
2. **Check re-attached BEFORE INSERT: 7/80 fail.** T74, T75, T76, T77 and T80 all fail as required. T61 also fails (the CTE moves add tombstones, so the count is 7, not 5), and so does T72 (`2|1`).
   - **Deviation in how this control was built:** re-attaching the *real* function BEFORE INSERT is not a valid control. Its body now ends `return null`, and a BEFORE row trigger that returns null silently skips every insert, so the fixtures never land and the file aborts at its first `item_vendors` insert.
   - The control therefore used a scratch function (`public.s179_negctl_check_before`) with the identical probe and tombstone logic, ending `return new`, attached under the real trigger name.
   - Everything was created and rolled back inside the scratch transaction. Afterwards I confirmed the real trigger was still AFTER INSERT and the scratch function was gone.

**§10 probes:** probe 3 and the new probe 4 (writable CTE), run verbatim against local, each raise `PROBE OK: inventory_items: id was previously used by another store`. The tombstone count stayed at 0 and no synthetic catalog row persisted.

**Gates (local):**
- the new file passes 80/80;
- `scripts/test-db.sh`: **92/93 pass**. The only red file is spec 178's untracked `order_approvals_fk_set_null.test.sql`, with the same 8/12 `P0001 order approval is immutable` failures as before (independent of spec 179, shown in the first round). `public_grants_explicit` (13/13), `permissive_policy_lint` (5/5) and `cross_store_item_rejection` (54/54) pass unmodified;
- full `npx jest`: 267 suites, 3340 tests, all pass. The tree now also holds other sessions' unstaged `src/**` work (i18n and staff EOD files), which jest ran over;
- `npm run typecheck` and `npm run typecheck:test` both exit 0.

**D-7 REPEATABLE READ 40001 demonstration: not done; it stays reasoned.** The race needs tx1 to **commit** its delete, so it can't be shown without a commit in the shared local DB, and the dispatch allowed the demo only if no commit was needed. The md5 pins the probe body.

### Fix round 1b (backend-developer, 2026-10-26)

Two small items from the fix-round-1 re-reviews: code-reviewer's new Should-fix, and security L4 option (a), which changes wording only. Edits were in place; nothing was staged or committed, and there was no `db reset`.

**Files**
- `supabase/tests/inventory_items_identity_lock.test.sql`:
  - **T61 is scoped to fixture ids** (code-reviewer Should-fix). The "exactly 5" now counts only tombstones whose `id::text like 'c1790001-%'`.
  - T61 keeps the whole-table delta (count = the T54 whole-table snapshot) and the `(iB1, B)` existence check.
  - The T54 hop now takes two snapshots: the whole table (`test.tomb_count`) and the fixture rows (`test.tomb_fixture_count`). Its `> 0` anti-vacuity check uses the fixture count.
  - The over-long header line was wrapped.
  - No arm added or removed; still `plan(80)`.
- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`, wording only (security L4 (a)). Three places now say REPEATABLE READ / SERIALIZABLE fails closed (40001) **only when the other-store row existed in the inserting transaction's snapshot**:
  - the header "Concurrency" paragraph;
  - the R-2c section comment;
  - `comment on function public.inventory_items_check_tombstone()`.

  They also name the residual: a row created **and** deleted entirely after that snapshot is missed. Only a raw `postgres` / `service_role` session holding an RR/SERIALIZABLE transaction open can reach it, never PostgREST.

  I also wrapped the over-long line in the table comment by splitting the string literal at the same point, so the stored comment text is byte-identical. No function body changed.
- `specs/179-inventory-item-identity-lock.md`: the design's D-7 row and §11 risk 6 carry the same correction and name the residual. Option (b), the claim table, was not built. This entry was added. Status stays READY_FOR_REVIEW.

**Re-apply:** I re-ran the file verbatim with `docker exec -i supabase_db_imr-inventory psql -U postgres -v ON_ERROR_STOP=1 < …` and it committed cleanly. The check trigger is still `AFTER INSERT ON public.inventory_items FOR EACH ROW`. The new function comment is live, and the table comment text is unchanged.

**Normalized md5s: all three unchanged**, so §10 Step 4 needed no edit.

| Function | md5 |
|---|---|
| `inventory_items_lock_identity()` | `0af4acdbda17cdab680f113f7378946a` |
| `inventory_items_check_tombstone()` | `9cfb8c5a2e02129e7ec9c1917c33d4d3` |
| `inventory_items_record_tombstone()` | `a00f5436b51e1550023d51cabb96c55e` |

**Checks**
- The new file passes **80/80**.
- **Long-lived-stack check (scratch, rolled back):** with two non-fixture tombstones inserted before the arms run, all 80 still pass. Before this change T61 would have failed with 7 ≠ 5.
- **BEFORE INSERT timing control:** re-run on the edited file, still **7/80 fail** (T74-T77, T80, T61, T72). So the scoped T61 still fails when the CTE moves add fixture tombstones.
- Afterwards the scratch function was gone and the local tombstone table held 0 rows.
- **Full `scripts/test-db.sh`: 92/93 pass.** The only red file is spec 178's untracked `order_approvals_fk_set_null.test.sql`, with the same 8/12 `P0001` failures as before. `public_grants_explicit` (13/13) and `permissive_policy_lint` (5/5) pass.
- jest and the typechecks were not re-run, since no `src/**` or TS file changed.
