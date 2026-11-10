# Spec 194: Stop store members deleting kept PO, waste and POS records

Status: READY_FOR_REVIEW

Numbering: drafted as 190 on 2026-11-09 and renumbered to 194 the same day, because three other sessions also took 190 (`190-po-number-sequence`, `190-user-stores-own-row-writes`, and the spec now numbered 193). Content unchanged.

Origin: findings M1 and M2 in `specs/186-retention-purge-server-job/reviews/security-auditor.md` (L47-49), dispatched by the main session on 2026-11-09. The owner answered the open questions the same day (see "Owner's decisions"). Code references were read from the working tree on 2026-11-09, and line numbers are pointers. Spec 186's migration was being edited by another session while this spec was written (its `stores` trigger was removed), so the design re-reads it at build time.

## User story

As the **owner of 2AM PROJECT**, I want purchase orders, waste logs and POS imports, and the lines under them, to be impossible for a store member to delete through the app's API once they are kept records, so that "keep" means a staff account cannot erase them on purpose.

## Problem

On 2026-11-08 the owner decided to keep EOD, PO, waste and POS records (spec 186, "Owner's decision"). Spec 186 added three RESTRICTIVE DELETE policies that refuse direct deletes of `purchase_orders`, `waste_log` and `pos_imports` rows older than 1 day. Those policies stop stale clients, not deliberate callers. Their own comments say: "Not a security boundary: store_member_update_* still lets a member change the date."

The spec 186 security audit proved two ways round them with rolled-back local probes:

- **M1. Re-date, then delete.** A staff member ran `update ... set logged_at = now()` on a 200-day `waste_log` row, then deleted it. The same worked for `purchase_orders.created_at` (a `received` PO) and `pos_imports.imported_at`. One PostgREST request can cover a whole store. The UPDATE policies are `store_member_update_waste_log`, `store_member_update_purchase_orders` and `store_member_update_pos_imports` in [20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) (L145, L194, L264).
- **M2. Hollow out the parent.** A staff member deleted a `po_items` line under a 200-day `received` PO and a `pos_import_items` line under a 200-day import. Both parents stayed and looked intact. The DELETE policies are `store_member_delete_po_items` (L243) and `store_member_delete_pos_import_items` (L313), which check only that the caller can see the parent's store.

This spec found two more routes that would defeat a status-based line rule (see "What the code does today"):

- A store member can set a `received` PO's `status` back to `draft`, then delete its lines.
- A store member can move a line onto another PO or import in the same store (`po_items.po_id`, `pos_import_items.import_id`), then delete the line, or delete the fresh parent within its 1-day window and let the cascade take the line.

## Owner's decisions (2026-11-09)

| Question | Decision |
|---|---|
| Who may change the three date columns through the API | **Privileged callers only**: admin, master and super_admin (`auth_is_privileged()`). Staff may not |
| Lines on non-draft POs (`sent`, `partial`, `received`, `cancelled`) | **No one deletes them through the API, admins included.** Draft lines stay deletable by any store member, at any age |
| `pos_import_items` lines | **Never deletable through the API on their own.** A wrong import is removed whole, by deleting the import within 1 day, which cascades its lines |
| The two workarounds | **Both closed.** A PO cannot move into `draft` from another status, and `po_items.po_id` and `pos_import_items.import_id` cannot change (same value allowed) |
| What callers see | Date change (for non-privileged callers), status into draft and line move raise SQLSTATE `42501` with a stable message in spec 177's shape. A refused PO line delete shows the existing "Remove PO line" error toast, and the line comes back |

**Accepted consequence.** The owner accepts that a privileged caller can still remove a kept record in two steps: change its date to now, then delete it inside spec 186's 1-day window. This spec closes that route for staff only. A compromised admin account could still use it.

## What the code does today

### Writers of the three date columns

Nothing sets `purchase_orders.created_at`, `waste_log.logged_at` or `pos_imports.imported_at` on UPDATE. The auditor's claim holds. Searched `src/` (including `src/screens/staff/`), `supabase/functions/`, `supabase/migrations/`, `supabase/tests/`, `supabase/seed.sql`, `scripts/`, `e2e/` and `extension/src/`.

| Writer | Table | Sets the date? |
|---|---|---|
| `createPurchaseOrderDraft` ([db.ts:1826](../src/lib/db.ts)), `upsertVendorDraftOrder` insert ([db.ts:1996](../src/lib/db.ts)) | `purchase_orders` INSERT | No, column default `now()` |
| `logWasteEntry` ([db.ts:1000](../src/lib/db.ts)) | `waste_log` INSERT | No |
| Staff waste RPC ([20260701000000_spec104_per_each_cost_basis.sql:1125](../supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql)) | `waste_log` INSERT | No |
| `savePOSImport` ([db.ts:2984](../src/lib/db.ts)) | `pos_imports` INSERT | No |
| `breadbot-nightly-sync` ([index.ts:340](../supabase/functions/breadbot-nightly-sync/index.ts)), service role | `pos_imports` INSERT | No |
| `markPurchaseOrderSent` ([db.ts:2187](../src/lib/db.ts)), extension `markOrdered` ([imrClient.ts:102](../extension/src/lib/imrClient.ts)), `send-po-email`, BJ's auto-place ([20260829000000](../supabase/migrations/20260829000000_auto_place_order_attempts.sql) L336) | `purchase_orders` UPDATE `status` draft→sent | No |
| `upsertVendorDraftOrder` ([db.ts:1986](../src/lib/db.ts)) | `purchase_orders` UPDATE `total_cost` | No |
| Receive RPCs ([20260707000000](../supabase/migrations/20260707000000_staff_receiving_price_gate.sql) L351), auto-receive cron ([20260719000000](../supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql) L130), cancel RPC ([20260704000000_po_loop.sql](../supabase/migrations/20260704000000_po_loop.sql) L397) | `purchase_orders` UPDATE `status`, `received_*` | No |

Inserts that set a date explicitly exist only in pgTAP fixtures: `retention_prune_job`, `report_last_order_context`, `report_run_velocity`, `report_run_vendor`, `report_run_waste`, `report_run_variance_formula`. Inserts stay allowed, so these are unaffected.

Readers that rely on the dates include `eod-reminder-cron`'s "already ordered today" check, `fetchRecentPurchaseOrders`, the waste and variance report RPCs and spec 186's three DELETE policies. Making the dates unchangeable for staff also protects those.

**Precedent.** Spec 177's `purchase_orders_lock_store_id` trigger ([20261025000000_cross_store_item_rejection.sql](../supabase/migrations/20261025000000_cross_store_item_rejection.sql) L193-220) already makes one `purchase_orders` column immutable on UPDATE. It raises `42501 'purchase_orders: store_id is immutable'` and allows a pass-through SET of the same value.

### Deletes of child lines

| Path | Table | Parent status when it runs |
|---|---|---|
| `upsertVendorDraftOrder` "clear old lines" ([db.ts:1977-1982](../src/lib/db.ts)), used by Fill cart (spec 138) and export recording (spec 156) | `po_items`, by id | `draft`. It finds the PO with `.eq('status', 'draft')` a few requests earlier |
| `deletePoItem` ([db.ts:2071](../src/lib/db.ts)) via `removePoLine` ([useStore.ts:3888](../src/store/useStore.ts)) | `po_items`, by id | `draft`. The × button renders only when `isDraft` ([POsSection.tsx:680](../src/screens/cmd/sections/POsSection.tsx)). `removePoLine` is optimistic and reverts only if the call throws |
| Anything else | `po_items` | None found. Receiving, approvals (specs 149, 178, 187), BJ's auto-place (spec 162), the extension, the staff app and every SQL function only insert or update lines |
| Anything | `pos_import_items` | **None.** The app only inserts lines and, in `applyAliasToPastImports` ([db.ts:4464](../src/lib/db.ts)), updates `recipe_id` and `recipe_mapped` |

- **PO statuses:** `draft`, `sent`, `partial`, `received`, `cancelled` ([po_loop.sql:109](../supabase/migrations/20260704000000_po_loop.sql)). No app or SQL path moves a PO back into `draft`. The only such write is a one-time normalization in that same migration (L89).
- **Line moves:** no app or SQL path changes `po_items.po_id` or `pos_import_items.import_id`. Spec 177's `po_items_check_store` refuses a cross-store `po_id` move but allows a same-store move.
- **Cascades:** `po_items.po_id` and `pos_import_items.import_id` are `ON DELETE CASCADE` ([init_schema.sql](../supabase/migrations/20260405000759_init_schema.sql) L168, L187), as is `vendor_order_attempts.po_id`. No later migration changes them. Cascades bypass RLS, so deleting a parent inside spec 186's 1-day window still removes its lines, and so does a store or brand delete.

### Prod, as relayed by spec 186 (2026-11-08)

4 `purchase_orders`, all `draft`. 0 `waste_log`, 0 `pos_imports`. Not re-checked for this spec.

## Requirements

### R1. Staff cannot change the three date columns
An UPDATE that changes `purchase_orders.created_at`, `waste_log.logged_at` or `pos_imports.imported_at` is refused unless `auth_is_privileged()` is true for the caller. The refusal holds at every row age and for a change to or from NULL. Privileged callers (admin, master, super_admin) may change them. For every caller, a pass-through SET of the same value and updates to any other column keep working. INSERT is unchanged.

**Design point: service role and `postgres`.** The architect decides how the service role and `postgres` (psql, migrations, cron) are treated, and states it. Nothing in the app updates these columns as the service role. `auth_is_privileged()` reads the JWT, so the design must say explicitly what it returns, and what the guard does, when there is no user JWT. It must also make sure no client-callable SECURITY DEFINER function lets a staff caller reach an exemption.

### R2. `po_items` lines can be deleted only while their PO is a draft
A direct delete of a `po_items` line succeeds only when the parent PO's status is `draft`. Any store member who can see the store may do this, at any PO age. This keeps both app paths and spec 186 AC-21 working. Lines under `sent`, `partial`, `received` or `cancelled` POs are refused for **every** caller, admins included.

### R3. `pos_import_items` lines cannot be deleted directly
A direct delete of a `pos_import_items` line is refused for every caller, whatever the parent's age. The only API route that removes lines is deleting the parent import inside spec 186's 1-day window, or a store or brand delete, through the FK cascade.

### R4. The line rules cannot be bypassed by moving a PO or a line
- An UPDATE that moves a PO into `draft` from any other status is refused for every caller. An update that leaves a draft as `draft` is allowed.
- `po_items.po_id` and `pos_import_items.import_id` cannot change on UPDATE, for every caller. A pass-through SET of the same value is allowed.

### R5. Cascades and fresh-row deletes keep working
- Deleting a `purchase_orders` row inside spec 186's 1-day window (PO rollback, [db.ts:1861](../src/lib/db.ts), [db.ts:2023](../src/lib/db.ts)) still removes its `po_items` and `vendor_order_attempts` rows.
- Deleting a `pos_imports` row inside the window still removes its `pos_import_items` rows.
- Store and brand deletes behave as they do after spec 186.

### R6. Spec 186's DELETE policies are not loosened for any role
The old client purge ran with admin and super_admin JWTs, so spec 186's three restrictive policies must keep refusing aged direct deletes for every role. This spec only removes the re-dating route round them for staff.

### R7. Refusals
- **Date change by a non-privileged caller, status into draft, line move:** an error with SQLSTATE `42501` and a stable message in spec 177's `'<table>: <column> ...'` shape, for example `'waste_log: logged_at is immutable'`. The design fixes the exact strings, and pgTAP pins them byte for byte.
- **Refused `po_items` delete:** the admin sees the existing "Remove PO line" error toast through `notifyBackendError`, and `removePoLine` puts the line back. The design chooses between a server-side error and a row-count check in `deletePoItem` (for example `.select('id')` and throw on 0 rows). Installed native builds keep the old silent behaviour until replaced.
- **Refused `pos_import_items` delete:** the design states the shape. There is no UI for it.

## Acceptance criteria

Track names follow [tests/README.md](../tests/README.md). New pgTAP arms go in a new file under `supabase/tests/`.

**Callers.** "Staff" is a store member of the fixture store whose role is not privileged. "Privileged" means an admin who can see the store, a master and a super_admin, each as its own arm. "Every role" means all four.

**Read-back rule (from spec 186).** Every arm that claims a row or value survived, changed or was removed reads it back by fixture id as `postgres` in a later block. A read as a caller who cannot see the row passes vacuously.

**Fixtures.** One store holding: a 200-day PO in each of `draft`, `sent`, `partial`, `received` and `cancelled`, each with an item-linked line; a 1-hour `draft` PO with a line; a 200-day and a 1-hour `waste_log` row; a 200-day and a 1-hour `pos_imports` row, each with a line. A second store, in another brand, with a 200-day `draft` PO and a line. A precondition arm asserts every fixture exists and that each caller can SELECT the rows it acts on.

### Dates (pgTAP)

- [ ] **AC-1:** For each of the three columns, as staff, `update ... set <col> = now()` on the 200-day row raises `42501` with the design's message, and the read-back shows the original value.
- [ ] **AC-2:** As staff, the same holds on the 1-hour row, and for `set <col> = null`.
- [ ] **AC-3 (M1 replay):** As staff, the auditor's two-step (re-date, then delete) on the 200-day `waste_log`, `received` PO and `pos_imports` rows leaves all three rows in place with their original dates.
- [ ] **AC-4:** As each privileged role, `update ... set <col> = <new value>` on each table succeeds, and the read-back shows the new value.
- [ ] **AC-5 (accepted residual, pinned):** As admin, re-dating the 200-day `waste_log` row to `now()` and then deleting it removes the row. This records the owner's accepted consequence, so any later tightening is deliberate.
- [ ] **AC-6:** As staff and as admin, a pass-through SET (`set <col> = <col>`) succeeds on each table.
- [ ] **AC-7:** As staff, these updates still succeed on the 200-day rows, each read back: PO `status` draft→sent (the `markPurchaseOrderSent` shape, and the extension's `and status = 'draft'` shape); PO `total_cost`; `receive_purchase_order` on the `sent` PO; the cancel RPC on a `sent` PO; a `waste_log` `quantity` edit; a `pos_imports` `filename` edit.
- [ ] **AC-8:** The design's treatment of the service role and `postgres` (R1 design point) has one arm each, pinning whether a date change succeeds or raises.
- [ ] **AC-9:** An INSERT that sets the date explicitly still succeeds, as in the existing report fixtures.

### PO lines (pgTAP)

- [ ] **AC-10 (M2 replay):** As every role, deleting the line under each 200-day non-draft PO (`sent`, `partial`, `received`, `cancelled`) is refused in the shape the design states, and each line reads back present.
- [ ] **AC-11:** As staff and as admin, `delete from po_items where id = <line>` on the 200-day `draft` and on the 1-hour `draft` succeeds (the `removePoLine` path, and spec 186 AC-21).
- [ ] **AC-12:** As staff, the `upsertVendorDraftOrder` update sequence on the 200-day draft (read old line ids, insert new lines, delete the old ids, update `total_cost`) ends with exactly the new lines.
- [ ] **AC-13:** A brand-B admin and a staff member without the store cannot delete the draft line in the other store. Scope is unchanged.
- [ ] **AC-14:** As admin, deleting the 1-hour draft PO removes it and its `po_items` and `vendor_order_attempts` rows (PO rollback, via cascade).

### POS lines (pgTAP)

- [ ] **AC-15 (M2 replay):** As every role, deleting the line under the 200-day import is refused, and it reads back present.
- [ ] **AC-16:** As every role, deleting the line under the 1-hour import is also refused, and it reads back present.
- [ ] **AC-17:** As admin, deleting the 1-hour import removes it and its line (cascade).
- [ ] **AC-18:** As admin, the `applyAliasToPastImports` update (`recipe_id`, `recipe_mapped`) on the 200-day line succeeds.
- [ ] **AC-19:** As the service role, the Breadbot insert shape (a `pos_imports` row with `imported_by` NULL, then its lines) succeeds.

### Workarounds closed (pgTAP)

- [ ] **AC-20:** As every role, `update purchase_orders set status = 'draft'` on the 200-day `sent`, `partial`, `received` and `cancelled` POs raises `42501` with the design's message, and each status reads back unchanged.
- [ ] **AC-21:** As staff, `update purchase_orders set status = 'draft'` on a PO that is already `draft` succeeds. This is a pass-through, not a move into draft.
- [ ] **AC-22:** As every role, moving the `received` PO's line onto the same store's `draft` PO (`update po_items set po_id = ...`) raises `42501`, and the line reads back on its original PO.
- [ ] **AC-23:** As every role, moving the 200-day import's line onto the 1-hour import (`update pos_import_items set import_id = ...`) raises `42501`, and the line reads back on its original import.
- [ ] **AC-24:** A pass-through SET of `po_id` and of `import_id` succeeds.

### Refusal shape (pgTAP and jest)

- [ ] **AC-25 (pgTAP):** Each refusal matches the SQLSTATE and message the design states, byte for byte. That covers staff date changes, status into draft, line moves, and both kinds of refused line delete.
- [ ] **AC-26 (jest):** When a `po_items` delete is refused, `deletePoItem` throws. If the design uses a client row-count check, a test shows it throws on a 0-row result. `removePoLine` then restores the line in `poLinesById` and calls `notifyBackendError('Remove PO line', ...)`.
- [ ] **AC-27 (jest, if `deletePoItem` changes):** Every existing test that pins `deletePoItem` or `removePoLine` is found and passes, and full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass.

### Catalog and existing gates (pgTAP)

- [ ] **AC-28:** `pg_policies` shows no new PERMISSIVE policy on the five tables, and spec 186's three RESTRICTIVE DELETE policies are unchanged (`retention_prune_job` P-1 passes).
- [ ] **AC-29:** A new migration rewrites spec 186's three policy comments. They no longer say "Not a security boundary". Instead they say that staff cannot change the date, and that privileged callers still can (the owner's accepted residual).
- [ ] **AC-30:** No SELECT policy is added or renamed on `purchase_orders` or `po_items`. `report_last_order_context.test.sql` P1a and P1b pin these names.
- [ ] **AC-31:** No DELETE or ALL policy appears on `eod_submissions` or `eod_entries` (spec 186 AC-8).
- [ ] **AC-32:** Every existing pgTAP file passes, including these, each with any change made on purpose and explained:

  | File | Why it is at risk |
  |---|---|
  | `retention_prune_job.test.sql` | A21 deletes a line on a 200-day draft as admin, which must still pass. Another session is editing this file |
  | `cross_store_item_rejection.test.sql` | T09 expects `'po_items: item store mismatch with parent purchase order'` on a cross-store `po_id` move. A new `po_id` guard that fires first changes the message. T16 and T48 pin pass-through SETs. T43 and T47 pin the store_id guard on the same table |
  | `generate_po_number_malformed_guard.test.sql` L37-38 | Unfiltered `delete from po_items` and `purchase_orders` as `postgres`. A trigger-based mechanism must not break it |
  | `extension_ordering.test.sql`, `submission_notifications.test.sql` | Status updates on POs |
  | `permissive_policy_lint.test.sql` | Any new policy |

### Proof the tests can fail

- [ ] **AC-33:** These were each tried by hand and the results recorded in the implementation notes, as spec 186 did:

  | Temporary change | Arms that must fail |
  |---|---|
  | Date guard removed | AC-1, AC-3 |
  | Date guard applied to privileged callers too | AC-4, AC-5 |
  | `po_items` delete rule removed | AC-10 |
  | `po_items` rule made "never deletable" | AC-11, AC-12 |
  | `pos_import_items` delete rule removed | AC-15, AC-16 |
  | Status-into-draft guard removed | AC-20 |
  | `po_id` or `import_id` guard removed | AC-22, AC-23 |

### Production

- [ ] **AC-34:** Before applying, a read-only prod check reports: the count of POs by status, and of `po_items` under non-draft POs; any `purchase_orders`, `waste_log` or `pos_imports` row with a NULL date; the existing triggers and the UPDATE and DELETE policies on the five tables, compared with local.
- [ ] **AC-35:** The migration is applied to prod through the Supabase MCP before the push, its version is inserted into `schema_migrations`, and any new function is verified by normalized md5, `prosecdef`, `proconfig`, owner and ACL against local. Changing prod needs the owner's go-ahead.
- [ ] **AC-36:** After the push, `test.yml` and `db-migrations-applied.yml` are green on `main`, and `e2e.yml` is checked by hand.

## In scope

- Making the three date columns unchangeable for non-privileged callers.
- Narrowing direct DELETE on `po_items` to draft parents, and refusing direct DELETE on `pos_import_items`.
- The status-into-draft and line-move guards.
- Rewriting spec 186's three policy comments.
- The refusal shapes, including any change to `deletePoItem` needed for the "Remove PO line" toast.
- New pgTAP coverage, jest coverage for the line-delete error, test updates listed in AC-32, and the prod apply.

## Not in this spec

- **M3: `staff_submit_eod` with an empty payload** erases a kept EOD count at any age (audit M3). Draft spec 189 touches the same RPC.
- **M4: `deleteStore` partial failure** removes today's waste rows and staff grants when the store delete fails (audit M4).
- **The privileged two-step delete.** Accepted by the owner (see "Owner's decisions"), and pinned by AC-5.
- **Editing kept rows other than these columns.** A member can still change a received line's `ordered_qty` or `received_qty`, a waste row's `quantity` or a POS line's `qty_sold`. This spec stops deletion, not edits. A follow-up could freeze lines on non-draft POs.
- **Deleting a fresh parent.** Spec 186's 1-day window stays as it is (audit L3 suggests one hour; that is spec 186's call).
- **Future-dated inserts.** A member can insert a PO, waste or POS row with a date in the future, which spec 186's policies then let them delete at any time. No app path does this. A follow-up could pin inserted dates to `now()`, as `audit_log_restrict_insert_created_at_now` does.
- **TRUNCATE grants** (audit L4) and **direct `brands` delete by super_admin** (audit L5).
- **A UI for deleting kept records or correcting dates.** Privileged callers can change dates through the API, but no screen is added.
- **`app.json` slug.** Not touched.

## Open questions resolved

Answered by the owner on 2026-11-09, in chat, relayed by the main session.

- Q (OQ-1): Who may change `purchase_orders.created_at`, `waste_log.logged_at` and `pos_imports.imported_at` through the API? → A: **(b) Privileged callers only** (admin, master, super_admin, via `auth_is_privileged()`). Staff may not. The owner accepts that a privileged caller can still remove a kept record by re-dating and then deleting inside the 1-day window. How the service role and `postgres` are treated is left to the architect (R1 design point).
- Q (OQ-2): May anyone delete lines from a PO that is no longer a draft? → A: **(a) No one through the API, admins included.** Draft lines stay deletable by any store member, at any age.
- Q (OQ-3): When may `pos_import_items` lines be deleted through the API? → A: **(a) Never on their own.** A wrong import is removed whole within 1 day, and the cascade takes its lines.
- Q (OQ-4): Should this spec also close the two ways round the line rules? → A: **(a) Yes.** Refuse any status change into `draft` from a non-draft status, and make `po_items.po_id` and `pos_import_items.import_id` unchangeable (same value allowed).
- Q (OQ-5): What does the caller see when one of these is refused? → A: **The recommended shapes.** Date change (non-privileged callers only), status into draft and line move raise `42501` with a stable message in spec 177's shape. A refused PO line delete shows the existing "Remove PO line" error toast, and the line comes back (line-delete option (a)).

**Left to the design:**
1. How the service role and `postgres` are treated by the date guard (R1).
2. The mechanism for each rule (triggers, RESTRICTIVE policies or both), and the exact refusal strings.
3. Whether the line-delete error comes from the server or from a row-count check in `deletePoItem`, and the shape of a refused `pos_import_items` delete.
4. Guard ordering against spec 177's `po_items_check_store`, so `cross_store_item_rejection` T09 keeps or deliberately changes its message.

## Risks for the design

- **Fill cart race.** `upsertVendorDraftOrder` finds a draft, then deletes its old lines a few requests later. If the extension or BJ's auto-place marks the PO `sent` in between, the delete is now refused. Today it would succeed. The PO is then left with both old and new lines. The function already handles a failed delete by returning `null`, and the next Fill cart only matches drafts. The design states the outcome and whether anything more is needed.
- **`auth_is_privileged()` without a user JWT.** See R1. Getting this wrong either blocks a legitimate server path or opens one to staff.
- **Message clashes with spec 177.** A `po_id` guard and `po_items_check_store` both fire on `UPDATE OF po_id`. BEFORE triggers fire in name order, which decides which message a cross-store move returns.

## Dependencies

- **Spec 186's migration `supabase/migrations/20261108120000_retention_prune_job.sql` must be committed, and applied to prod, before this spec builds.** It is uncommitted and was still changing on 2026-11-09. This spec rewrites its three policy comments and relies on its policies, and its test file `supabase/tests/retention_prune_job.test.sql` must keep passing.
- Spec 177 ([20261025000000_cross_store_item_rejection.sql](../supabase/migrations/20261025000000_cross_store_item_rejection.sql)): the immutability precedent, and the `po_items_check_store` trigger that a `po_id` guard sits beside.
- `auth_is_privileged()` (spec 026): the role check for R1.
- Spec 188 (Breadbot repair): inserts `pos_imports` and lines as the service role (AC-19). If it lands first, its `pos_import_items.recipe_id ON DELETE SET NULL` updates only `recipe_id`, and it must keep working with the `import_id` guard.
- Spec 189 (DRAFT): touches EOD only. No overlap beyond M3, which is excluded here.
- Prod apply through the Supabase MCP, because `db push` lacks the prod password.

## Project-specific notes

- **Cmd UI section / legacy:** Purchase Orders (`src/screens/cmd/sections/POsSection.tsx`) is affected only through the "Remove PO line" error path. Any code change is in `deletePoItem` (`src/lib/db.ts`) and possibly `removePoLine` (`src/store/useStore.ts`). The revert and toast already exist.
- **Which app:** Admin repo. The rules also bind the staff subtree, the extension and edge functions, because they are enforced in the database. Staff accounts are the main actors being restricted.
- **Per-store or admin-global:** Per-store. Existing `auth_can_see_store()` scope is unchanged; this spec only narrows it, and adds an `auth_is_privileged()` check for date changes.
- **Edge function or PostgREST:** Database rules (policies, triggers or both, as the design chooses), plus at most a small client change. No new RPC or edge function. Any trigger must not break the `postgres` and service-role paths in AC-19 and AC-32.
- **Realtime channels touched:** None. No publication change, so the `docker restart supabase_realtime_imr-inventory` step does not apply.
- **Migrations needed:** Yes. Pick a version later than the newest in `supabase/migrations/` at build time, and later than spec 186's `20261108120000`. Other sessions are adding migrations.
- **Edge functions touched:** None. `send-po-email` and `breadbot-nightly-sync` write these tables but do not touch the guarded columns.
- **Web/native scope:** Server-side, so both. A `deletePoItem` change is shared code and ships to both. Installed native builds keep the old silent line-delete behaviour until replaced.
- **`app.json` slug:** Not touched.
- **Tests:** pgTAP for the database rules. Jest for the line-delete error path (AC-26, AC-27). No shell smoke.

## Backend design

Architect pass, 2026-11-09. Every file below was re-read from the working tree on that date, including spec 186's uncommitted migration (its `stores` trigger is gone; it now holds the prune function, the cron job, the three RESTRICTIVE DELETE policies and the `admin_delete_audit_log` comment).

### D-0. Summary of decisions

| Rule | Mechanism | Binds | Refusal |
|---|---|---|---|
| R1 date columns | BEFORE UPDATE OF `<col>` trigger, one shared SECURITY INVOKER function | User-JWT callers who are not `auth_is_privileged()`. Exempt: privileged callers and server contexts (D-2) | `42501` `'<table>: <col> is immutable'` |
| R2 `po_items` delete | New RESTRICTIVE DELETE policy: parent PO must be `draft` | Every JWT role (staff, admin, master, super_admin). Not `postgres` or `service_role` (RLS bypass), not FK cascades | 0 rows, no error. The client turns 0 rows into an error (D-5) |
| R3 `pos_import_items` delete | New RESTRICTIVE DELETE policy `using (false)` | Same as R2 | 0 rows, no error |
| R4 status into draft | BEFORE UPDATE OF `status` trigger | Every caller, `postgres` included | `42501` `'purchase_orders: status cannot return to draft'` |
| R4 line moves | BEFORE UPDATE OF `po_id` / `import_id` triggers | Every caller, `postgres` included | `42501` `'po_items: po_id is immutable'`, `'pos_import_items: import_id is immutable'` |
| AC-29 | `comment on policy` for spec 186's three policies | n/a | n/a |

Nothing is a table, column, index, publication or data change.

### D-1. Data model changes

**Migration:** `supabase/migrations/20261109170000_kept_records_delete_hardening.sql`.

Slot: the newest file on disk on 2026-11-09 is `20261109140000_po_number_sequence.sql` (it appeared during this design, and is insert-only: `generate_po_number()` and a sequence, no overlap). Spec 188 has reserved `20261109000000`, and the two other "190" specs (`190-staff-eod-date-bound`, `190-user-stores-own-row-writes`) will also need slots after `20261109120000`. **The developer re-runs `ls supabase/migrations | tail` at build time and moves the version later if anything sorts at or after it.** The prod `schema_migrations` insert must use the final version.

Hard dependency: the migration issues `comment on policy` against spec 186's three policies, so it fails with `42704` if `20261108120000_retention_prune_job.sql` has not been applied first. That is the intended guard, locally and on prod. Do not add `if exists` around it.

Wrap in `begin; ... commit;` with `set local lock_timeout = '5s'` (spec 177 shape). Header comment carries the PROD-APPLY note (D-11) and "no publication change, therefore no `docker restart supabase_realtime_imr-inventory` step".

**Additive in schema terms.** It adds 4 functions, 6 triggers, 2 policies and rewrites 3 comments. It is **behaviour-restrictive**: writes that succeed today will be refused. No backfill: prod had 4 POs, all `draft`, and empty `waste_log`, `pos_imports` and `pos_import_items` (spec 186, re-checked by AC-34 before apply).

#### Objects

1. **`public.kept_record_lock_date()`**: `returns trigger`, `language plpgsql`, **SECURITY INVOKER**, `set search_path = public`. One function serves all three date triggers through `TG_ARGV[0]` (the column name). Rationale for one generic function instead of spec 177's one-per-column shape: the exemption rule (D-2) is the part that must not drift, and a generic function keeps it in one body with one md5 to verify. Pseudocode:

   ```
   if tg_nargs <> 1 or not (to_jsonb(new) ? tg_argv[0]) then
     raise exception 'kept_record_lock_date: bad trigger argument' using errcode = 'P0001';  -- misconfiguration, fail closed
   end if;
   if (to_jsonb(new) -> tg_argv[0]) is not distinct from (to_jsonb(old) -> tg_argv[0]) then
     return new;                                   -- pass-through SET (AC-6)
   end if;
   v_claims_role := coalesce(
       nullif(current_setting('request.jwt.claim.role', true), ''),
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       '');
   if current_user not in ('anon', 'authenticated')
      and v_claims_role in ('', 'service_role') then
     return new;                                   -- server context (D-2)
   end if;
   if public.auth_is_privileged() then
     return new;                                   -- admin, master, super_admin
   end if;
   raise exception '%: % is immutable', tg_table_name, tg_argv[0] using errcode = '42501';
   ```

   The jsonb comparison is exact for `timestamptz`: both sides are rendered in the same call and session time zone at microsecond precision, so equal strings mean equal instants, and NULL becomes JSON `null`, so a change to or from NULL is caught (AC-2). Read the claims GUCs directly rather than through `auth.jwt()` or `auth.role()`, so the function does not depend on `auth.*` EXECUTE grants for `service_role`. Malformed claims JSON raises `22P02`, which fails closed.

   Triggers, all `for each row`:
   - `purchase_orders_lock_created_at_trg`: `before update of created_at on public.purchase_orders`, `execute function public.kept_record_lock_date('created_at')`
   - `waste_log_lock_logged_at_trg`: `before update of logged_at on public.waste_log`, argument `'logged_at'`
   - `pos_imports_lock_imported_at_trg`: `before update of imported_at on public.pos_imports`, argument `'imported_at'`

   Column-scoped, so receive, cancel, auto-receive, mark-sent, `total_cost`, `quantity` and `filename` updates never call the function (AC-7). An FK `ON DELETE SET NULL` on `created_by`, `logged_by` or `imported_by` sets only that column and does not fire these triggers.

2. **`public.purchase_orders_block_return_to_draft()`**: SECURITY INVOKER, `set search_path = public`.

   ```
   if new.status = 'draft' and old.status is distinct from 'draft' then
     raise exception 'purchase_orders: status cannot return to draft' using errcode = '42501';
   end if;
   return new;
   ```

   This covers `sent`, `partial`, `received`, `cancelled` and NULL moving to `draft`. `draft` → `draft` passes (AC-21). There is no caller exemption: no app, cron or SQL path moves a PO into `draft` (the only one, `po_loop.sql` L89, runs earlier in migration order, before this trigger exists).
   Trigger `purchase_orders_no_return_to_draft_trg`: `before update of status on public.purchase_orders for each row`.

3. **`public.po_items_lock_po_id()`**: SECURITY INVOKER, `set search_path = public`. It mirrors `purchase_orders_lock_store_id()` exactly: `if new.po_id is distinct from old.po_id then raise exception 'po_items: po_id is immutable' using errcode = '42501'; end if; return new;`. No exemption.
   Trigger `po_items_lock_po_id_trg`: `before update of po_id on public.po_items for each row`.

4. **`public.pos_import_items_lock_import_id()`**: the same shape. Message `'pos_import_items: import_id is immutable'`.
   Trigger `pos_import_items_lock_import_id_trg`: `before update of import_id on public.pos_import_items for each row`. Spec 188's `recipe_id ON DELETE SET NULL` updates only `recipe_id`, so it never fires this trigger.

5. **Policy `po_items_restrict_delete_non_draft`** on `public.po_items`: `as restrictive for delete using (exists (select 1 from public.purchase_orders po where po.id = po_items.po_id and po.status = 'draft'))`. No `TO` clause, so it applies to `public`, which means every role.

6. **Policy `pos_import_items_restrict_delete`** on `public.pos_import_items`: `as restrictive for delete using (false)`.

7. **Comments.** `comment on function` for all four functions (spec 177 style: the rule, the exact message, SECURITY INVOKER, and for #1 the exemption rule), `comment on policy` for the two new policies, and the rewrite of spec 186's three (D-9). `revoke execute on function ... from public, anon, authenticated` for all four. Postgres does not check EXECUTE when a trigger fires (spec 177 precedent, and stated again in `20261109140000`).

### D-2. Design point 1: service role and `postgres` (R1)

**What `auth_is_privileged()` returns without a user JWT.** It is `auth_is_admin() or auth_is_super_admin()`. `auth_is_admin()` reads `auth.jwt() -> 'app_metadata' ->> 'role'`, and `auth_is_super_admin()` looks up `profiles` by `auth.uid()`. As `postgres` (psql, migrations, pg_cron, pgTAP after `reset role` with claims cleared), both are false. As `service_role`, the JWT has `role: service_role` and no `app_metadata.role` or `sub`, so both are again false. **On its own, `auth_is_privileged()` would refuse cron, migrations and the service role.**

**Rule chosen: the date guard exempts server contexts.** A server context is one where both of these hold:
- `current_user` is not `anon` or `authenticated`, so the statement is not running directly under a PostgREST client role, **and**
- the request's JWT claims role is empty or `service_role`, so there is no user JWT on the request.

Everything else must pass `auth_is_privileged()`.

| Context | `current_user` | claims role | Result |
|---|---|---|---|
| Staff via PostgREST | `authenticated` | `authenticated` | Refused (privileged check is false) |
| Admin, master or super_admin via PostgREST | `authenticated` | `authenticated` | Allowed (privileged) |
| Staff calling any SECURITY DEFINER RPC owned by `postgres` | `postgres` | `authenticated` (claims persist into the definer body) | **Refused.** Closes the "SD function reaches the exemption" route the spec asks about |
| Edge function with the service-role key | `service_role` | `service_role` | Allowed |
| Edge function forwarding the user's JWT | `authenticated` | `authenticated` | Treated as that user |
| pg_cron, migrations, psql, `supabase db reset`, seed | `postgres` | empty | Allowed |
| pgTAP `reset role` with stale user claims | `postgres` | the stale user's | Treated as that user. No existing test updates these columns, so nothing breaks; AC-8 arms must clear claims explicitly |

Why exempt them at all: `postgres` and `service_role` already bypass RLS and can delete these rows outright, so refusing them a date change protects nothing. It would only break ops fixes and fixtures. The auditor's suggested fix (M1) was "immutable for non-owner roles", which this matches. Why not use `current_user` alone: inside a `postgres`-owned SECURITY DEFINER function `current_user` is `postgres`, so a staff-callable SD function would reach the exemption. Why not use `session_user`: under pgTAP `set local role authenticated`, `session_user` stays `postgres`, so every staff arm would be exempt. The two-part test above is the only one that is right in all three settings.

The status-into-draft and line-move guards have **no** exemption (R4 says every caller). The line-delete policies bind every JWT role and never bind `postgres` or `service_role`, because RLS does not apply to them. That matches spec 186's three policies and the owner's wording "through the API". It is stated in the policy comments, and AC-25 pins it.

### D-3. Design point 2: mechanisms and exact messages

Column rules use BEFORE UPDATE triggers (D-1 #1 to #4). RLS `WITH CHECK` cannot see `OLD`, so a policy cannot express "unchanged". Line deletes use **RESTRICTIVE DELETE policies, not BEFORE DELETE triggers.** Reasons, in order:

1. **Cascades.** RI cascade deletes run as the child table's owner with RLS bypassed, but they **do** fire user triggers on the child. A raising BEFORE DELETE trigger on `po_items` would have to tell "PO rollback, store delete, brand delete, `hard_delete_brand`" apart from a direct delete. `pg_trigger_depth() > 1` is too broad: any delete issued from inside another trigger would pass. "Parent row no longer visible" needs a SECURITY DEFINER lookup and relies on snapshot visibility of the parent delete inside the RI action. Spec 186 A19 and A20 (store and brand delete), and AC-14 and AC-17 here, all exercise cascades. A policy gets all of them right with no special case.
2. **Server paths.** A trigger binds `postgres`. `generate_po_number_malformed_guard.test.sql` L37 runs an unfiltered `delete from public.po_items` as `postgres` over the seeded database. Any non-draft line in `seed.sql` would turn that into a raise, and so would any future ops cleanup. A policy does not apply to `postgres`.
3. **Fail-closed visibility.** The policy's EXISTS runs under the caller's own RLS on `purchase_orders`. A parent the caller cannot see counts as not a draft, so the delete is refused. A SECURITY INVOKER trigger would get this backwards: "parent not found" would read as "cascade, allow".
4. **Consistency.** It is the same mechanism and the same silent shape as spec 186's three policies. It adds no new PERMISSIVE policy (AC-28), and the spec 053 lint only scans PERMISSIVE policies.

The cost is that a refused delete is silent (0 rows). D-5 handles that in the client for the one UI path.

**Exact refusal strings (pgTAP pins these byte for byte, AC-25):**

| Refusal | SQLSTATE | Message |
|---|---|---|
| Staff changes `purchase_orders.created_at` | `42501` | `purchase_orders: created_at is immutable` |
| Staff changes `waste_log.logged_at` | `42501` | `waste_log: logged_at is immutable` |
| Staff changes `pos_imports.imported_at` | `42501` | `pos_imports: imported_at is immutable` |
| Any caller moves a PO into `draft` | `42501` | `purchase_orders: status cannot return to draft` |
| Any caller changes `po_items.po_id` (same store) | `42501` | `po_items: po_id is immutable` |
| Any caller changes `pos_import_items.import_id` | `42501` | `pos_import_items: import_id is immutable` |
| Delete of a `po_items` line under a non-draft PO | none | 0 rows affected, no error; line reads back present |
| Delete of any `pos_import_items` line | none | 0 rows affected, no error; line reads back present |
| Client: `deletePoItem` gets 0 rows | n/a (thrown `Error`) | `PO line was not removed. The order may no longer be a draft.` |

"Is immutable" is accurate for staff, and spec 177 already uses it for `store_id`. Privileged callers never see the date message.

**Trigger firing order** (BEFORE triggers fire in name order, C collation):
- `purchase_orders`: `purchase_orders_lock_created_at_trg` < `purchase_orders_lock_store_id_trg` < `purchase_orders_no_return_to_draft_trg`. One UPDATE that breaks two rules reports the first. No AC depends on a multi-rule update.
- `po_items`: see D-6.

### D-4. API contract

No new RPC, view or edge function. All callers keep using PostgREST `UPDATE`/`DELETE` on the five tables. Contract changes visible to clients:
- `PATCH` of any of the three date columns by a non-privileged user returns HTTP 403 with PostgREST code `42501` and the message above. supabase-js surfaces it as `error.code === '42501'`.
- `PATCH purchase_orders` with `status: 'draft'` on a non-draft row, and `PATCH` of `po_id`/`import_id`, return HTTP 403 / `42501`.
- `DELETE po_items` under a non-draft PO and every `DELETE pos_import_items` return success with 0 rows (`count: 0` when `Prefer: count=exact` is sent).

### D-5. Design point 3: client handling, `src/lib/db.ts` surface

The design uses a **client row-count check**. The server refusal is silent (D-3), so this is the only way to get the "Remove PO line" toast. It uses the existing mutate-with-count precedent at `db.ts:4480` (`applyAliasToPastImports`, `.update(..., { count: 'exact' })`).

**`deletePoItem(poItemId: string): Promise<boolean>`** (db.ts ~2071). The signature is unchanged.
- `.from('po_items').delete({ count: 'exact' }).eq('id', poItemId).abortSignal(signal)`.
- `error` → `console.warn` + throw (unchanged).
- `count === 0` → `console.warn('[Supabase] deletePoItem: 0 rows (PO not a draft, or line already gone)')` and `throw new Error('PO line was not removed. The order may no longer be a draft.')`.
- `count` null or undefined (no Content-Range, which PostgREST always sends with `count=exact`) → treated as success, keeping today's behaviour. Only an explicit `0` throws.
- Update the doc comment: the delete is now also limited by `po_items_restrict_delete_non_draft`.
- No mapping change (it returns a boolean, and there are no snake_case fields).

**`removePoLine` (`src/store/useStore.ts:3933`): no code change.** It already sets `poLinesById` optimistically, restores `prev` in `catch`, and calls `notifyBackendError('Remove PO line', e)`. The throw above is enough. A line already deleted from another tab also gives 0 rows, so the line reappears with a toast until the next reload. That is accepted; it is harmless and self-corrects.

**`upsertVendorDraftOrder` (db.ts ~1977), the Fill cart race.** Its signature is unchanged.
- Change the old-line delete to `.delete({ count: 'exact' }).in('id', oldIds)`. If `typeof count === 'number' && count < oldIds.length`, warn `'[Supabase] upsertVendorDraftOrder (clear old lines): refused or raced, N of M'` and `return null`. Do not update `total_cost`. A null count keeps today's path, so the existing jest arms whose terminal has no `count` still pass.
- **Outcome in the race**, where the PO turns `sent` between the `status='draft'` find and the delete (extension `markOrdered`, BJ's auto-place, or `send-po-email` in another session):
  1. The new-line INSERT succeeds, because `po_items` INSERT is not limited by status. Freezing lines on non-draft POs is out of scope ("Not in this spec").
  2. The old-line delete is refused and returns 0 rows.
  3. The function returns `null`. `fillCartForVendor` (useStore.ts ~4077) toasts `notifyBackendError('Fill cart', 'Draft not created')`, and `recordExportedOrder` (~4192) takes its existing null branch.
  4. The `sent` PO keeps the old and the new lines, and the old `total_cost`. No API caller can delete those lines now. An admin can set the extra lines' `ordered_qty` to 0 (line edits stay allowed), or the owner fixes it as `postgres`.
- Today the same race silently rewrites a placed order's lines. After this change it fails loudly and leaves extra lines that can be zeroed. The window is about three round trips, and it needs two ordering flows on the same (store, vendor, reference_date) at once. **Nothing more is built here.** The real fix is the single-statement replace-lines RPC that spec 138 already lists as a FOLLOW-UP (`select ... for update` on the PO, check `status = 'draft'`, then replace). Record it as a follow-up and do not build it in this spec ("No new RPC").
- Separately, the policy reads `po.status` from the statement snapshot. A mark-sent that commits after the DELETE's snapshot is not seen, so the delete can still win that race. This is the same as today, it is the mirror of the race above, and it is accepted.

**Installed native builds** keep the old silent behaviour for both functions until they are replaced, as the spec already accepts. The × button renders only on drafts, so an old build hits this only in the race.

### D-6. Design point 4: ordering against spec 177's `po_items_check_store`

`po_items_check_store_trg` (BEFORE INSERT OR UPDATE OF `item_id`, `po_id`) and the new `po_items_lock_po_id_trg` (BEFORE UPDATE OF `po_id`) both fire on a `po_id` change. In C collation `po_items_check_store_trg` < `po_items_lock_po_id_trg` (`c` < `l`), so **the store check fires first.**
- Cross-store move (`cross_store_item_rejection.test.sql` T09, as master): `po_items_check_store` raises `'po_items: item store mismatch with parent purchase order'` before the lock runs. **T09, T10, T16 (pass-through `po_id = po_id`) and T43/T47/T48 are unchanged.** This is deliberate: it is the least churn, both messages are `42501`, and the cross-store message is the more specific one.
- Same-store move (AC-22): the store check passes, then the lock raises `'po_items: po_id is immutable'`.
- Move to a PO the caller cannot see: the store check raises `'po_items: parent purchase order not found, not visible, or has no store'`, which is unchanged.
- Do not rename either trigger. The new pgTAP file pins the order with a catalog arm (D-8 C-3), as spec 186 P-2 does, so a rename has to be deliberate.

`pos_import_items` has no other trigger, so there is no ordering concern.

### D-7. RLS impact

New policies (both RESTRICTIVE, so no spec 053 allowlist row and no PERMISSIVE change on the five tables):

| Table | Policy | Cmd | Expression | Helper |
|---|---|---|---|---|
| `po_items` | `po_items_restrict_delete_non_draft` | DELETE | parent `purchase_orders.status = 'draft'` (EXISTS, under the caller's RLS) | none. Scope still comes from the unchanged permissive `store_member_delete_po_items` → `auth_can_see_store(po.store_id)` |
| `pos_import_items` | `pos_import_items_restrict_delete` | DELETE | `false` | none |

Unchanged: all 20 PERMISSIVE policies on the five tables (`store_member_{read,insert,update,delete}_*`, `auth_can_see_store()`), spec 186's three RESTRICTIVE policies (expressions unchanged, comments rewritten), and every SELECT policy (AC-30: `report_last_order_context` P1a/P1b). No DELETE or ALL policy is added on `eod_submissions` or `eod_entries` (AC-31). The date guard adds `auth_is_privileged()`, the CLAUDE.md-mandated helper for new guards, not `auth_is_admin()`. It is called from a trigger, not a policy, so `super_admin_policy_parity` LINT-1 is unaffected.

Brand scope: an admin of brand B already cannot UPDATE store A rows (`auth_can_see_store` is brand-scoped since `20260517040000`). The trigger's `auth_is_privileged()` is brand-blind, but it only ever sees rows the UPDATE policy admitted.

### D-8. Tests

**New pgTAP file: `supabase/tests/kept_records_delete_hardening.test.sql`.** It is hermetic (`begin; ... rollback;`). Fixture uuid prefix `b194a…`. Copy the impersonation helpers from `retention_prune_job.test.sql`: `pg_temp.try_sql` returns `'ok:<n>'` or the SQLSTATE, and `pg_temp.jwt(sub, app_role)`. Use `throws_ok(sql, '42501', '<exact message>', …)` for every raising arm, so a different trigger with the same errcode cannot pass. Do not use `set role anon` (spec 067 segfault).

Principals: staff = a `profiles.role='user'` member with a `user_stores` row for store A; admin = JWT `admin`, `profiles.brand_id` = store A's brand; master = JWT `master`; super_admin = `profiles.role='super_admin'`, JWT `user` (the spec 186 shape); brand-B admin for AC-13. Fixtures follow the spec's "Fixtures" paragraph. Insert them as `postgres` with explicit `created_at`/`logged_at`/`imported_at`, which AC-9 itself proves is allowed.

Arm groups, mapped to the ACs:
- **PRE:** every fixture exists, and each caller can SELECT the rows it acts on.
- **AC-1, AC-2, AC-3:** staff `throws_ok` on each of the three columns with `now()` and with `null`, on the 200-day and 1-hour rows. Then the M1 two-step (the update raises, the delete gives `ok:0`). Read back as `postgres`.
- **AC-4, AC-5, AC-6:** for each of admin, master and super_admin, `lives_ok` and read back the new value on each table. AC-5 is the accepted residual: the admin re-dates and deletes, the result is `ok:1`, and the row is gone. Pass-through `set <col> = <col>` as staff and as admin.
- **AC-7:** the listed staff updates and RPCs (`receive_purchase_order`, `cancel_purchase_order`), each read back.
- **AC-8:** four arms.
  - (a) `postgres` after `select set_config('request.jwt.claims', '', true); reset role;`. The date change succeeds.
  - (b) `set local role service_role` with claims `{"role":"service_role"}`. It succeeds.
  - (c) `postgres` session with **staff** claims. It raises `42501`.
  - (d) A `pg_temp` **SECURITY DEFINER** wrapper that re-dates a `waste_log` row, called as staff. It raises `42501`. This proves no SD function hands staff the exemption.
- **AC-9:** an explicit-date INSERT as staff and as `postgres`.
- **AC-10 to AC-14:** four roles × four non-draft statuses, each `ok:0` with the line read back. Draft lines give `ok:1` (200-day and 1-hour, staff and admin). Replay the `upsertVendorDraftOrder` sequence on the 200-day draft (AC-12). Cross-store and cross-brand delete gives `ok:0` (AC-13). The 1-hour draft PO delete cascades `po_items` and `vendor_order_attempts` (AC-14).
- **AC-15 to AC-19:** `pos_import_items` deletes give `ok:0` for four roles on both imports. The 1-hour import delete cascades (AC-17). The `recipe_id`/`recipe_mapped` update succeeds (AC-18). The Breadbot insert as `service_role` succeeds (AC-19).
- **AC-20 to AC-24:** status into draft from the four statuses, for four roles **plus `postgres`**, each `throws_ok`. Draft → draft is `lives_ok`. Same-store `po_id` move and `import_id` move for four roles plus `postgres`, each `throws_ok`. Pass-through `po_id`/`import_id` SETs.
- **AC-25:** covered by the `throws_ok` messages above, and by `'ok:0'` plus read-back for the silent shapes. Add an `'ok:N'` arm as `postgres` for each line table, showing that the delete rules do not bind `postgres`, as stated in D-2.
- **Catalog arms:**
  - **C-1 (AC-28).** Pin the sorted list of PERMISSIVE policy names on the five tables: exactly the 20 `store_member_*` names. Pin the two new RESTRICTIVE policies by `tablename/policyname/permissive/cmd/qual`.
  - **C-2.** Pin the 6 triggers by name, table, `tgenabled = 'O'`, BEFORE ROW UPDATE, and column list. **Pin that `po_items` and `pos_import_items` have no user DELETE trigger.** This keeps the policy mechanism from being replaced by a cascade-breaking trigger without someone noticing.
  - **C-3 (D-6).** Reads both trigger names from `pg_trigger`, sorted under `collate "C"`, and requires `{po_items_check_store_trg, po_items_lock_po_id_trg}` in that order (both present, store check first). `cross_store_item_rejection` T09 pins the behaviour.
  - **C-4.** All four functions: `prosecdef = false`, `proconfig = {search_path=public}`, and no EXECUTE for `anon` or `authenticated` (`has_function_privilege`).
  - **C-5 (AC-29).** The three spec 186 policy comments no longer contain `Not a security boundary` and do contain `spec 194`.
  - **C-6 (AC-31).** No DELETE or ALL policy on `eod_submissions`/`eod_entries`.

**Existing pgTAP files (AC-32): expected to pass unchanged.**
- `retention_prune_job.test.sql`: P-1 filters by policy name and pins `qual`, and both are unchanged. A21 deletes a line on a 200-day **draft**, which passes the new policy. A18, A19 and A20 use cascades, which bypass RLS. The comment rewrite does not touch `admin_delete_audit_log` (S-6/P-6 at L379). **Another session owns this file. Do not edit it.**
- `cross_store_item_rejection.test.sql`: unchanged by D-6.
- `generate_po_number_malformed_guard.test.sql` L37-38: runs as `postgres`, no DELETE trigger, RLS bypassed.
- `extension_ordering.test.sql`, `submission_notifications.test.sql`: status moves are draft→sent→partial→received, never into draft.
- `permissive_policy_lint.test.sql`: only scans PERMISSIVE policies, and none are added.
- `report_last_order_context.test.sql` P1a/P1b: SELECT names unchanged.

If any of these does change, the developer explains it in the implementation notes. Do not silently re-pin.

**Jest (AC-26, AC-27):**
- New `src/lib/db.deletePoItem.test.ts`. Mock as in `db.upsertVendorDraftOrder.test.ts`. Arms:
  - `delete` is called with `{ count: 'exact' }` and `.eq('id', …)`.
  - `count: 1` → resolves `true`.
  - `count: 0` → rejects with the exact message from D-3.
  - `error` → rejects with that error.
  - `count` undefined → resolves `true`.
- Extend `src/lib/db.upsertVendorDraftOrder.test.ts`:
  - The UPDATE-path arm asserts `delete` was called with `{ count: 'exact' }`.
  - New arm: the delete terminal returns `{ data: null, error: null, count: 0 }` with two old ids. It returns `null`, and `update` (total) is not called.
  - The existing arms stay as they are, because they have no count.
- New `src/store/useStore.removePoLine.test.ts`. Mock `db.deletePoItem` to reject. After `removePoLine`, `poLinesById[poId]` equals the pre-call lines, and `notifyBackendError` was called with `'Remove PO line'`. Add a happy-path arm where the line stays removed.
- Existing pins: no current jest test pins `deletePoItem` or `removePoLine` (`POsSection.test.tsx:102` only stubs `removePoLine: jest.fn()`). The useStore tests that cover Fill cart, export recording and approvals mock `db.upsertVendorDraftOrder` whole, so they are unaffected. Run the full `npx jest`, `npm run typecheck` and `npm run typecheck:test` (project memory: a subset run missed a stale test before).

**AC-33 (proof the tests can fail).** Hand-run each mutation from the spec's table inside a scratch transaction (`drop trigger …`, `alter policy … using (true)` / `using (false)`, a variant `kept_record_lock_date` with the `auth_is_privileged()` branch removed). Record which arms went red in the implementation notes.

### D-9. Spec 186 comment rewrite (AC-29)

Rewrite each of the three comments. Keep every existing sentence except "Not a security boundary: store_member_update_* still lets a member change the date." In its place, put (with the table's own column and trigger names):

> Since spec 194 (kept-records delete hardening), staff cannot change `<col>` (trigger `<table>_lock_<col>_trg`, 42501), so they cannot re-date a row into this window. Privileged callers (admin, master, super_admin) still can, then delete it inside the window; the owner accepted that residual on 2026-11-09.

Prefix stays `spec 186: RESTRICTIVE.`. The last sentence ("Dropping this policy … needs an owner decision.") stays.

### D-10. Realtime, edge functions, frontend store

- **Realtime:** no publication change, so the `docker restart supabase_realtime_imr-inventory` step does not apply. Refused writes produce no change events. Successful ones replay on `store-{id}` as today.
- **Edge functions:** none new or changed, and `verify_jwt` is untouched. `send-po-email` (draft→sent), `breadbot-nightly-sync` (inserts as service role) and `eod-reminder-cron` (reads `created_at`) are unaffected. The service role is exempt from the date guard anyway (D-2).
- **`src/store/useStore.ts`:** no change (D-5). The optimistic-then-revert-with-`notifyBackendError` pattern already applies to `removePoLine`. No new slice.
- **UI:** none. `POsSection.tsx` is unchanged.
- **`app.json` slug:** untouched.

### D-11. Prod apply (AC-34, AC-35, AC-36): owner go-ahead required

**Nothing in this section runs without the owner's explicit go-ahead.**

All read-only queries for steps 0 and 4 are in [`prod-verify.sql`](194-kept-records-delete-hardening/prod-verify.sql). Its catalog strings are the same expressions as arms C-1a, C-1b, C-2, C-4 and C-5 of the pgTAP file, so prod is checked as strictly as the tests. The expected values below were computed on local on 2026-11-09 after the build.

0. **Prerequisite.** `20261108120000_retention_prune_job` is in prod `supabase_migrations.schema_migrations` and its three policies exist on prod. Otherwise stop, because the `comment on policy` statements will fail. Also check:
   - The repo file is unchanged: `md5 -q supabase/migrations/20261108120000_retention_prune_job.sql` = `3a9076d7aaeab0c34fb8c0dedbef0094` (the body spec 186 applied).
   - **V0a.** Spec 186's three comments on prod are byte-identical to that file, because the rollback restores this text. Expected (these match spec 186's recorded prod md5s):
     - `pos_imports_restrict_delete_aged` `27bd32e45e4aa5dee8e098b4026dfa65`
     - `purchase_orders_restrict_delete_aged` `19b31c660b25c60878c39720b6b7f1d6`
     - `waste_log_restrict_delete_aged` `3e6fcbcc2f3f96da5df7d247f9ef77c1`
   - **V0b.** None of this spec's objects exists yet: `0 | 0 | 0`.

   Any mismatch goes to the owner before applying.
1. **Read-only pre-check (AC-34)** via Supabase MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`:
   - POs by status, and the count of `po_items` whose parent is not `draft`.
   - Rows with a NULL date in each of the three tables, and POs with a NULL `status` (security Low-1).
   - `pg_trigger` (non-internal) on the five tables.
   - `pg_policies` UPDATE and DELETE rows on the five tables.
   Diff against local. Any extra prod trigger or policy, or any non-draft PO line, goes to the owner before applying.
2. **Apply and record in one transaction.** Send the committed migration file verbatim through `execute_sql`, including its `begin;`/`commit;` wrapper and every `create trigger`, `revoke` and `comment`. Do not send a `pg_get_functiondef` dump. Do this **before** pushing the commit. Put this line just before the file's final `commit;`, so the version is recorded in the same transaction as the body (architect M-5, as spec 186 did):

   `insert into supabase_migrations.schema_migrations (version, name) values ('20261109170000', 'kept_records_delete_hardening');`

   If D-1's version changes before the apply, use the final one.
3. **Confirm the record.** **V1g** returns one row: `20261109170000 | kept_records_delete_hardening`.
4. **Verify against local.** Run V1a to V1f from `prod-verify.sql`. Each must equal the local value exactly:
   - **V1a (C-1a):** the 20 `store_member_{delete,insert,read,update}_*` PERMISSIVE policies, exactly the string the test pins.
   - **V1b (C-1b):** five RESTRICTIVE DELETE rows. `po_items_restrict_delete_non_draft` is `(EXISTS ( SELECT 1 FROM purchase_orders po WHERE ((po.id = po_items.po_id) AND (po.status = 'draft'::text))))` (pg prints it on three lines). `pos_import_items_restrict_delete` is `false`. Spec 186's three keep their `>= (now() - '1 day'::interval)` quals.
   - **V1c (C-2, with `tgargs`):**
     `po_items/po_items_lock_po_id_trg/O/19/po_items_lock_po_id/po_id/, pos_import_items/pos_import_items_lock_import_id_trg/O/19/pos_import_items_lock_import_id/import_id/, pos_imports/pos_imports_lock_imported_at_trg/O/19/kept_record_lock_date/imported_at/imported_at\000, purchase_orders/purchase_orders_lock_created_at_trg/O/19/kept_record_lock_date/created_at/created_at\000, purchase_orders/purchase_orders_no_return_to_draft_trg/O/19/purchase_orders_block_return_to_draft/status/, waste_log/waste_log_lock_logged_at_trg/O/19/kept_record_lock_date/logged_at/logged_at\000`
   - **V1d (C-2b, C-3):** `0 | {po_items_check_store_trg,po_items_lock_po_id_trg}`.
   - **V1e (C-4, normalized md5, owner, ACL).** Every function is `f/{search_path=public}/f/f`, owner `postgres`, ACL `{postgres=X/postgres,service_role=X/postgres}`. Normalized md5s:

     | Function | Normalized md5 |
     |---|---|
     | `kept_record_lock_date` | `d5a7c47ca8d467c765bef0727ad5c9bd` |
     | `po_items_lock_po_id` | `fe21c57e062f269d99a751d57ff6d9df` |
     | `pos_import_items_lock_import_id` | `9cfbc1dac9b56fa25e619cbd33b4fe5a` |
     | `purchase_orders_block_return_to_draft` | `c727c69d44ecf6b3bc915f77f0be0e09` |
   - **V1f (C-5, plus comment md5s).** The three rewritten comments are `t:t:t`, and the two new ones are `f:t:f`. Comment md5s:

     | Policy | Comment md5 |
     |---|---|
     | `po_items_restrict_delete_non_draft` | `b4abf20e1001937e28d9c91cf42aa2ec` |
     | `pos_import_items_restrict_delete` | `b2d8e9d27cdf032185e5803d559e6aa4` |
     | `pos_imports_restrict_delete_aged` | `26d3ce72e496526f4c8982daf455ba40` |
     | `purchase_orders_restrict_delete_aged` | `9f82da78da7dedbbd6570e17fc860410` |
     | `waste_log_restrict_delete_aged` | `a30cd26dab69baa1cff77de556caf50a` |

   If the migration text changes before the apply, recompute these on local first.
5. **Smoke (read-only):** `select count(*) from po_items` before and after is unchanged. No write probes on prod.
6. **After the push (AC-36):** check `gh run list --branch main --workflow test.yml --limit 1` and the same for `db-migrations-applied.yml`, both green. Check `e2e.yml` by hand.

**Rollback** is a separate hand-written SQL, kept in the implementation notes and not committed as a migration. It drops the six triggers, the four functions and the two policies, and restores spec 186's original three comments. It reopens M1 and M2, so it needs an owner decision. Do **not** drop spec 186's policies as part of it.

### D-12. Risks and tradeoffs

- **Silent refusal for line deletes** (the chosen mechanism). Old native builds and any non-app caller see success-with-0-rows. This is accepted by the spec, and it is the price of keeping cascades and server paths correct without trigger-depth heuristics (D-3).
- **Fill cart race** leaves a `sent` PO with doubled lines, which can be zeroed but not deleted (D-5). Low likelihood. The follow-up is the spec 138 replace-lines RPC.
- **`po_items` INSERT is still allowed on non-draft POs.** A member can add lines to a received PO and then cannot delete them. That is out of scope ("Editing kept rows"). It belongs with the "freeze lines on non-draft POs" follow-up.
- **Privileged two-step** remains, accepted and pinned by AC-5.
- **Future-dated inserts** and **TRUNCATE** remain open, out of scope as listed.
- **Stale claims in pgTAP.** Tests that `reset role` without clearing `request.jwt.claims` are treated as the last impersonated user by the date guard. No existing test updates these columns, but future test authors need to know. It is stated in the function comment.
- **Migration slot churn.** Three other sessions are adding `20261109…` migrations. Re-check at build time (D-1).
- **Spec number collision (resolved).** Renumbered from 190 to 194 on 2026-11-09; see the Numbering line at the top.
- **Dirty working tree.** `src/lib/db.ts` and `src/store/useStore.ts` already have uncommitted edits from other sessions. The developer edits only the two `db.ts` functions named in D-5 and stages only their own hunks.
- **Performance.** The date and line-lock triggers fire only on UPDATE OF their columns, which no app path does. The status trigger is one comparison per status update. The `po_items` restrictive policy adds one PK lookup per deleted row. Negligible on the seed dataset and on prod.
- **Cold start:** not applicable, because no edge function changes.

## Handoff
next_agent: backend-developer
prompt: Implement spec 194 (kept-records delete hardening) against "## Backend design". Write the migration (D-1; re-check the slot with `ls supabase/migrations | tail` first), the new pgTAP file `supabase/tests/kept_records_delete_hardening.test.sql` (D-8), the two `src/lib/db.ts` changes (`deletePoItem` and `upsertVendorDraftOrder` row-count checks, D-5), and the jest files in D-8. Do not edit `retention_prune_job.test.sql` (another session owns it) and do not run any prod step in D-11 without the owner's go-ahead. Run the full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and the pgTAP suite. Record the AC-33 mutation results. Then set Status: READY_FOR_REVIEW and list the files changed under ## Files changed.
payload_paths:
  - specs/194-kept-records-delete-hardening.md

## Implementation notes

Backend developer, 2026-11-09. Local only. Nothing was run against prod, and nothing is committed or staged.

**Migration slot.** `ls supabase/migrations | tail` at build time showed `20261109140000_po_number_sequence.sql` as the newest file. `20261109160000` is reserved by `190-user-stores-own-row-writes` and `20261109190000` by spec 193, so the planned `20261109170000` was free and is used unchanged. The prod `schema_migrations` insert (D-11 step 3) uses `20261109170000`. Spec 186's `20261108120000_retention_prune_job.sql` was re-read at build time: it holds the three RESTRICTIVE policies with the comments D-9 rewrites, and is applied locally.

**Local apply.** `npx supabase status` fails on this CLI with `[inbucket] in supabase/config.toml is no longer supported` (pre-existing, not touched). The stack was already running. The migration was applied with `psql -v ON_ERROR_STOP=1 -f`, and `('20261109170000', 'kept_records_delete_hardening')` was inserted into local `supabase_migrations.schema_migrations`, the same way the other 2026-11-08/09 migrations were recorded locally. No reset, no restart. No publication change, so no realtime restart.

**Design followed as written.** Objects, names, messages, mechanisms and the D-2 exemption rule match D-1 to D-9. No design flaw found.

**D-11 strengthened, 2026-11-09 (architect S-2, M-4, M-5).** Steps 0 to 4 now run the read-only queries in `prod-verify.sql`. These are the pgTAP C-1a, C-1b, C-2 (with `tgargs`), C-4 and C-5 expressions, plus md5s for the five policy comments and the four functions. The expected values were computed on local. The three spec 186 comment md5s were taken from the repo file's text inside a rolled-back transaction, and they match spec 186's recorded prod values. The version insert now goes inside the migration's transaction.

**Fresh-database proof (architect S-1): owner accepts CI, 2026-11-09.** No local `db reset` is run, because the local stack is shared with other sessions. The first fresh replay is `test.yml`'s pgTAP job after the push, which comes after the prod apply (D-11 order). If that run fails on this migration, use the rollback SQL below and give the owner the run URL.

**Two Fill carts on one draft (architect M-2, intended).** The row-count check in `upsertVendorDraftOrder` also catches two Fill carts racing on a PO that is still a draft. If the second call finds fewer old lines left to delete than it read, it now returns `null` and shows "Draft not created". Before spec 194 it succeeded silently. The draft keeps both sets of lines until the next Fill cart collapses them. This is intended, not a regression.

**pgTAP file** (`supabase/tests/kept_records_delete_hardening.test.sql`, 103 assertions). Fixture choices the design left open:
- The 1-hour draft PO in AC-14 and the 1-hour import in AC-17 are separate fixtures from the 1-hour rows that AC-2, AC-11 and AC-16 use, so every role runs against the same rows before the cascades happen.
- AC-7's `receive_purchase_order` and `cancel_purchase_order` run on two extra 200-day `sent` POs, so the main `sent` PO stays `sent` for AC-10, AC-20 and AC-22.
- AC-4 uses one fresh 200-day row per privileged role per table, so each role's new value reads back on its own.
- AC-13 covers three callers: staff without a grant on store B (on store B's line), the brand-A admin (on store B's line), and a new brand-B admin (on store A's draft line). A PRE arm shows the brand-B admin sees its own store's line, so its 0-row result is a scope refusal and not a broken principal.
- super_admin is the seed 3333 profile promoted in-transaction after the master block, the spec 186 shape.
- C-2 pins `tgargs` as well (for example `created_at\000`), so a trigger wired to the wrong column fails.

**AC-32: existing pgTAP files.** `bash scripts/test-db.sh` (full suite): **100/100 files pass**, including `retention_prune_job`, `cross_store_item_rejection` (T09 keeps spec 177's message, as D-6 predicted), `generate_po_number_malformed_guard`, `extension_ordering`, `submission_notifications`, `permissive_policy_lint` and `report_last_order_context`. No existing pgTAP file was edited.

**AC-33: proof the tests can fail.** Each mutation was applied with the test file in one psql session (`begin; <mutation>; <test file>`), and the file's own `rollback` undid both. Afterwards the catalog showed all 6 triggers, both policies and the `auth_is_privileged()` branch still in place. One run hit a deadlock with a concurrent session's `create extension pgtap` and was re-run.

| Temporary change | Arms that must fail | Result |
|---|---|---|
| Date guard removed (drop the 3 date triggers) | AC-1, AC-3 | AC1-1..3, AC2-1..9, AC3-1, AC3-2, AC8-c, AC8-d and C-2 failed (48 in all). Knock-on: the staff two-step then really deletes the received PO, and the cascade takes its line, so later arms on that PO and line also fail |
| Date guard applied to privileged callers too (no `auth_is_privileged()` branch) | AC-4, AC-5 | AC4-1, AC4-2, AC5-1, AC5-2 failed (exactly 4) |
| `po_items` delete rule removed (drop policy) | AC-10 | AC10-1, AC10-2 and C-1b failed (12 in all). Knock-on: the deleted line is the one AC-22 and AC-24 target, and the PRE counts drop |
| `po_items` rule made "never deletable" (`using (false)`) | AC-11, AC-12 | AC11-1, AC11-2, AC12-1, AC12-2 and C-1b failed (exactly 5) |
| `pos_import_items` delete rule removed (drop policy) | AC-15, AC-16 | AC15-AC16-1, AC15-AC16-2 and C-1b failed (13 in all). Knock-on: the deleted POS line is the one AC-18, AC-23 and AC-24 target |
| Status-into-draft guard removed (drop trigger) | AC-20 | All 20 AC20-* throws_ok arms, AC20-readback and C-2 failed (30 in all). Knock-on: a received PO set back to draft makes its line deletable |
| `po_id` and `import_id` guards removed (drop both triggers) | AC-22, AC-23 | All 10 AC22-*/AC23-* arms, C-2 and C-3 failed (17 in all). Knock-on: the moved lines no longer read back on their original parents |

**Jest (AC-26, AC-27).** New `src/lib/db.deletePoItem.test.ts` (5 arms, as in D-8) and `src/store/useStore.removePoLine.test.ts` (2 arms). `notifyBackendError` is module-local in `useStore.ts`, so the store test checks what it does: `console.warn('[Supabase] Remove PO line failed:', …)` and `Toast.show({ type: 'error', text1: 'Remove PO line failed', … })`. `src/lib/db.upsertVendorDraftOrder.test.ts`: the UPDATE-path arm now also checks `delete({ count: 'exact' })`. A new arm checks that a `count: 0` delete with two old ids returns `null` and that `update` is not called. The queue element type gained an optional `count` field so the new arm needs no cast. Existing arms are unchanged. Grep for existing pins: no other jest or e2e test pins `deletePoItem`, `removePoLine` or a `po_items` delete (`POsSection.test.tsx` only stubs `removePoLine`, `db.poLoop.test.ts` deletes from `purchase_orders`), and no pgTAP file moves a PO back into `draft`.

**Verification run.**
- `npx jest` (full): 301 suites, 3835 tests, all pass.
- `npm run typecheck:test`: pass (exit 0).
- `npm run typecheck`: **fails, and the cause predates this change.** All 24 errors are `TS2688 Cannot find type definition file for '<name> 2'`. They come from Finder-style duplicate folders `node_modules/@types/* 2` (24 of them, dated 2026-10-26). With those folders kept out (`npx tsc --noEmit -p tsconfig.json --types node,jest`), there are 0 errors. Those folders were not touched; deleting them is up to the owner.
- `bash scripts/test-db.sh`: 100/100 files pass.

**Rollback SQL (D-11; not a migration; reopens M1 and M2, so it needs an owner decision; does NOT drop spec 186's policies):**

```sql
begin;
drop trigger if exists purchase_orders_lock_created_at_trg   on public.purchase_orders;
drop trigger if exists waste_log_lock_logged_at_trg          on public.waste_log;
drop trigger if exists pos_imports_lock_imported_at_trg      on public.pos_imports;
drop trigger if exists purchase_orders_no_return_to_draft_trg on public.purchase_orders;
drop trigger if exists po_items_lock_po_id_trg               on public.po_items;
drop trigger if exists pos_import_items_lock_import_id_trg   on public.pos_import_items;
drop function if exists public.kept_record_lock_date();
drop function if exists public.purchase_orders_block_return_to_draft();
drop function if exists public.po_items_lock_po_id();
drop function if exists public.pos_import_items_lock_import_id();
drop policy if exists "po_items_restrict_delete_non_draft" on public.po_items;
drop policy if exists "pos_import_items_restrict_delete"   on public.pos_import_items;
comment on policy "purchase_orders_restrict_delete_aged" on public.purchase_orders is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. PO rollback deletes a row seconds old and is admitted. A NULL created_at is refused. FK cascades from stores bypass RLS. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';
comment on policy "waste_log_restrict_delete_aged" on public.waste_log is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. FK cascades from stores bypass RLS, so store deletion still removes aged rows. A NULL logged_at is refused. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';
comment on policy "pos_imports_restrict_delete_aged" on public.pos_imports is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. A NULL imported_at is refused. FK cascades from stores bypass RLS. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';
commit;
```

**Not done (owner-gated or out of scope).** D-11 prod steps (AC-34, AC-35, AC-36) are not run and need the owner's go-ahead. Follow-up from D-5, still open: the spec 138 single-statement replace-lines RPC that closes the Fill cart race for good.

## Files changed

**Migrations**
- `supabase/migrations/20261109170000_kept_records_delete_hardening.sql` (new)

**pgTAP tests**
- `supabase/tests/kept_records_delete_hardening.test.sql` (new)

**src/lib/db.ts** (only these two functions; other uncommitted hunks in the file belong to other sessions)
- `src/lib/db.ts`: `deletePoItem` (exact count, throws on 0 rows) and `upsertVendorDraftOrder` (exact count on the old-line delete, returns `null` when fewer rows than captured are removed)

**Jest tests**
- `src/lib/db.deletePoItem.test.ts` (new)
- `src/store/useStore.removePoLine.test.ts` (new)
- `src/lib/db.upsertVendorDraftOrder.test.ts` (new `count: 0` arm, `{ count: 'exact' }` assertion on the UPDATE path, optional `count` on the queue type)

**Spec**
- `specs/194-kept-records-delete-hardening.md` (Status, implementation notes, this list)

Not changed: `src/store/useStore.ts`, `POsSection.tsx`, edge functions, `supabase/config.toml`, `supabase/tests/retention_prune_job.test.sql`, spec 186 files, `app.json`.

## Prod apply, 2026-11-10

Owner's go-ahead: "Yes, apply to prod" (2026-11-09, local time). Applied by this session through the Supabase MCP (project `ebwnovzzkwhsdxkpyjka`), before the commit and the push. The applied body is the staged file, md5 `e2d6ecd0cef1809a05c515a1410b2de9`. Queries are in `prod-verify.sql`.

**Step 0, read-only.** Spec 186's file md5 is `3a9076d7aaeab0c34fb8c0dedbef0094`, and `20261108120000` is in `schema_migrations`. V0a: the three spec 186 comment md5s on prod equal the expected values (`27bd32e4…`, `19b31c66…`, `3e6fcbcc…`). V0b: `0 | 0 | 0`. The newest prod version was `20261108120000`. 187, 189 and 190 are not on prod, which is fine because none overlaps with 194.

**Step 1, read-only (AC-34).** POs: `draft=4`, nothing else. `po_items` under non-draft POs: 0. NULL `created_at`, `logged_at` or `imported_at`: 0, 0, 0. NULL PO `status`: 0. `po_items`: 53 rows. Non-internal triggers on the five tables: `po_items_check_store_trg`, `notify_purchase_order`, `purchase_orders_lock_store_id_trg`, `set_po_number` and `notify_waste_log`, all enabled. That equals local minus 194's six and another session's unapplied `purchase_orders_po_number_guard_trg`. UPDATE and DELETE policies: the 10 `store_member_*` policies plus spec 186's three restrictive ones, which equals local minus 194's two. Nothing extra, so not a stop.

**Steps 2-3.** The full migration file, with `insert into supabase_migrations.schema_migrations (version, name) values ('20261109170000', 'kept_records_delete_hardening')` just before its final `commit;`, ran in one `execute_sql` transaction. V1g: one row, `20261109170000 | kept_records_delete_hardening`.

**Step 4, verified against local, 04:37 UTC.** All identical to the expected values in D-11:
- V1a: the 20 PERMISSIVE `store_member_*` policies.
- V1b: five RESTRICTIVE DELETE rows with the expected quals.
- V1c: the six triggers, string identical, `tgargs` included.
- V1d: `0` and `{po_items_check_store_trg,po_items_lock_po_id_trg}`.
- V1e: all four functions are `f/{search_path=public}/f/f`, owner `postgres`, ACL `{postgres=X/postgres,service_role=X/postgres}`. Their normalized md5s `d5a7c47c…`, `fe21c57e…`, `9cfbc1da…` and `c727c69d…` all match.
- V1f: `f:t:f` twice and `t:t:t` three times. The comment md5s `b4abf20e…`, `b2d8e9d2…`, `26d3ce72…`, `9f82da78…` and `a30cd26d…` all match.

**Step 5.** `po_items` count is 53 before and after. No write probe on prod.

**Still open:** AC-36, the commit and push. Then `test.yml` (the first fresh-database proof, per the owner's 2026-11-09 decision), `db-migrations-applied.yml` and `e2e.yml` must be green on `main`.
