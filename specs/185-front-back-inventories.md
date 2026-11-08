# Spec 185: Front and Kitchen counts at EOD

Status: DRAFT

Origin: the owner's request, verbatim: "i also want to seperate for front and back inventories". After two rounds of clarification (relayed by main Claude, 2026-11-07), the owner narrowed it to: "all items in one list for ordering just on eod counts has a filter stating for front count and kitchen count". Each item belongs to one area, and each area submits its own count. Code facts were read from the working tree on 2026-11-07, and line numbers are pointers. Prod facts are from main Claude's read-only checks on 2026-11-05/07.

**Why still DRAFT:** the owner has settled the shape. The product manager proposed the remaining details as **defaults** (marked **[DEFAULT]**). Some of those defaults change notifications, reminders and the spec 149 approve-order trigger, which the owner hasn't seen. The owner should confirm the list under "Confirm in one pass" before this goes to the architect. If the owner accepts every default, the only change needed is `Status: READY_FOR_ARCH`.

## User story

As a **store manager at a 2AM store where the front counter and the kitchen are counted by different people**, I want each item tagged Front or Kitchen, and the EOD count to filter to Front or Kitchen so each crew counts and submits its own items, so that the front and the kitchen can finish the end-of-day count separately without overwriting each other. Ordering, par, costing and reports keep working off the one combined store list.

## Decisions (owner-settled)

| # | Question | Owner's answer |
|---|---|---|
| D-1 | Two stores, or areas inside one store? | **Areas in one store.** No second store row. |
| D-2 | What does the split apply to? | **EOD counts only.** "all items in one list for ordering just on eod counts has a filter stating for front count and kitchen count". |
| D-3 | Can one item be in both counts? | **No. Each item is in exactly one area**, Front or Kitchen, and shows only under that filter. |
| D-4 | One submission with a filtered screen, or one per area? | **Each area submits its own.** Front and Kitchen can be counted by different people at different times, and both submissions are kept. |
| D-5 | Area names | **Front** and **Kitchen** (not "Back"). |

What follows from these:
- `inventory_items` stays **unique on `(store_id, catalog_id)`**. An item has one row, one par, one cost and one on-hand, as today.
- **Ordering, reorder suggestions, par, costing (spec 104), sales depletion, the weekly count and reports stay store-level and combined.** They don't change.
- The only new things are an **area tag per item**, an **area filter on the EOD count screens**, and **one submission per area per (store, date, vendor)**.

## Current state (verified)

### No area concept exists
No item, count or submission records a storage area anywhere in the code or the prod schema.

### EOD submission key, and why per-area submissions break today
- `eod_submissions` is **unique on `(store_id, date, vendor_id)`** ([20260514120000_eod_submissions_vendor_id.sql](../supabase/migrations/20260514120000_eod_submissions_vendor_id.sql) L116-121). Entries hang off it in `eod_entries` (`submission_id`, `item_id`, quantities, `no_need`).
- **The admin path** ([src/lib/db.ts](../src/lib/db.ts) `submitEODCount`, L1024-1084) upserts the parent on `store_id,date,vendor_id`, then **deletes every entry of that submission** and inserts the new set (L1053-1062).
- **The staff path** (`staff_submit_eod`, [20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) L192-201) does the same: `on conflict (store_id, date, vendor_id) do update`, then `delete from eod_entries where submission_id = …`.
- **So today, a Kitchen submission for vendor V would wipe the Front entries for V on the same day,** and the other way round, on both paths. This is the central technical problem.
- Both paths update `current_stock` / `eod_remaining` only for the items in the entries submitted (spec 102 junction-membership write). Items not in the submission keep their previous on-hand.

### Who reads "is this (store, date, vendor) submitted?"
Each of these assumes one submission per (store, date, vendor). Each would read a half-done day as done unless it learns about areas:
- **Admin vendor tab ✓ SUBMITTED and lock/EDIT:** `submittedVendorIds` ([EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx) L573-590).
- **Admin week sidebar:** `deriveDayStatus` ([src/lib/eodDayStatus.ts](../src/lib/eodDayStatus.ts)), fed by `counted` = entry count and `total` = store item count (EODCountSection L392-409). A past day with some entries reads `'late'`, and with all entries `'submitted'`.
- **Staff vendor chips (red/green):** `fetchSubmittedVendorIds` ([src/screens/staff/lib/submittedStatus.ts](../src/screens/staff/lib/submittedStatus.ts)), plus `yesterdayStatus.ts`.
- **EOD reminder cron**, [supabase/functions/eod-reminder-cron/index.ts](../supabase/functions/eod-reminder-cron/index.ts):
  - Track 1 skips a store if **any** submission row exists for the date (L279-283);
  - Track 3 (spec 121 missed counts) treats `store|vendor` as done when any submitted row exists (L394-400).
- **Notifications:** `notify_eod_submission` (spec 149) fires on INSERT and chooses between a plain `eod` notification and `order_ready` (the approve-order pipeline). `notify_eod_resubmission` (spec 180) fires on UPDATE and emits `eod_update` for edits ([20261027000000_eod_update_notifications.sql](../supabase/migrations/20261027000000_eod_update_notifications.sql) L1-46). Spec 180 notes that the below-par check sees the on-hand as it stands when the trigger fires.
- **Reports and ordering that read submissions or entries** (found by grep in `supabase/migrations/`): reorder list (`report_reorder_list*`, `reorder_*`), variance (`report_run_variance*`), weekly low-stock, `items_last_counted`, the PO loop and order approvals, and `report_last_order_context`.

### EOD screens
- **Admin desktop** has vendor tabs, then **category pills** (`selectedCategory`, EODCountSection L223, L683, L1909). The new area pills are modelled on these.
- **Admin phone** is `PhoneEodCount.tsx`. It has no category pills today.
- **Staff app** ([src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx)) has vendor chips with red/green status (spec 129), an offline queue (`src/screens/staff/lib/eodQueue`), and its own i18n catalog (`src/screens/staff/i18n/`).

### Item editing
- Desktop: `IngredientFormDrawer.tsx` / `IngredientForm.tsx` under `src/components/cmd/`. Phone: `phone/PhoneInventoryDetail.tsx`. The architect should confirm which of these edit the **per-store** `inventory_items` row.

### Spec 184 is implemented but uncommitted
The working tree holds spec 184 (stock a store from another store; corrected EOD empty states S1 to S4), at `Status: READY_FOR_REVIEW`. It touches `EODCountSection.tsx`, `PhoneEodCount.tsx`, `StoreFormDrawer.tsx`, `BrandsSection.tsx`, `useStore.ts` and `db.ts`, and it adds migration **`20261105000000_stock_store_from_store.sql`** with RPCs `stock_store_from_store` / `stock_store_preview`. This spec:
- must use a migration version **after `20261105000000`**. The untracked `supabase/tests/order_approvals_fk_set_null.test.sql` (spec 178) may claim another slot, so re-check before building;
- extends spec 184's copy so that it carries the area tag (AC-6);
- should be built **after spec 184 is committed**, because both edit the same EOD files.

## Defaults proposed by the product manager

Each one is the PM's proposal. The owner confirms or overrides it in "Confirm in one pass".

- **[DEFAULT] P-1. Where the tag lives: per store, on `inventory_items`.** Rationale: the same ingredient can sit on the line at one store and in the kitchen at another. A per-store tag also makes "a store with no Front items behaves as today" automatic. The brand-wide fan-outs (`apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`) don't push the tag.
- **[DEFAULT] P-2. Existing items: Kitchen.** Every current row becomes Kitchen at rollout. New items from any existing path also start as Kitchen.
- **[DEFAULT] P-3. No store setting; the split switches on by itself.** A store shows the area filter only when it has **at least one item in each area**. A store whose items are all in one area (every store at rollout) looks and behaves exactly as today.
- **[DEFAULT] P-4. Surfaces:** admin EOD desktop, admin EOD phone and staff app EOD. **The weekly count stays store-level and is unchanged.**
- **[DEFAULT] P-5. Filter behaviour:** two pills, **Front** and **Kitchen**, with no "All" pill, because each area submits separately. The pills sit with the existing category pills on desktop, and the category filter applies within the chosen area. The screen opens on **Kitchen**. Anyone who can count at the store can count either area, and one person may submit both. There's no per-user area assignment.
- **[DEFAULT] P-6. Who sets the tag, and where:** whoever can edit an item's par at that store today. It's a Front / Kitchen control in the existing per-store item editor on desktop and on phone (`PhoneInventoryDetail`). There's no bulk tagging tool in v1.
- **[DEFAULT] P-7. Completion rule:** a **(store, date, vendor) is complete** when every area that has at least one item linked to that vendor at that store has a **submitted** count. An area with no items for that vendor isn't required, e.g. a vendor that only supplies the kitchen.
- **[DEFAULT] P-8. How partial shows:**
  - the vendor tab (desktop) or chip (phone, staff) shows done only when the vendor is complete, and otherwise shows which area is in and which is due;
  - the day cell in the week sidebar reads `submitted` only when every scheduled vendor is complete, and otherwise names the area still due under the existing status pill. No new `DayStatus` value is needed.
- **[DEFAULT] P-9. Reminders and missed counts:** the reminder cron (Track 1) and missed-count tracking (Track 3) treat a vendor as not yet submitted until it's complete under P-7. A missed-count notification names the missing area.
- **[DEFAULT] P-10. Notifications:**
  - each area's first submission sends responsible admins one EOD notification **naming the area**;
  - re-submitting an area counts as an edit (spec 180 `eod_update`);
  - the spec 149 **`order_ready` / approve-order check runs once, when the vendor's day becomes complete** (the last required area submits), so it judges below-par on the full count and not on half of it.
- **[DEFAULT] P-11. Moving an item between areas:** it changes where the item appears **from now on**. Past submissions are not rewritten and keep the area they were submitted under. If the item was already counted today in its old area, the new area shows it as already counted (read-only) for that day, so it's never counted twice.
- **[DEFAULT] P-12. Spec 184 stocking:** copies the source item's area tag. Uncarried catalog rows ticked in the stock dialog start as Kitchen. No problem is seen with this.
- **[DEFAULT] P-13. Verification:** browser preview at desktop and phone widths only. No native Simulator pass.
- **[DEFAULT] P-14. Labels:**

  | Key meaning | en | es | zh-CN |
  |---|---|---|---|
  | Front area | Front | Frente | 前厅 |
  | Kitchen area | Kitchen | Cocina | 厨房 |

  These go in both the admin catalog (`src/i18n/`) and the staff catalog (`src/screens/staff/i18n/`).

## Acceptance criteria

Test tracks: **pgTAP** (the area tag, both submit paths, combined-output equality, notifications), **jest** (screens, pure completion and day-status helpers, store slices, i18n parity), and **browser preview**. The reminder cron change gets whatever test the architect names: a pinned pure helper under jest is preferred, with a shell smoke as fallback. pgTAP fixtures are hermetic (`begin; … rollback;`), and every "the other area is unchanged" claim is checked row by row.

### Area tag
- [ ] **AC-1:** Every `inventory_items` row has exactly one area, Front or Kitchen, and never null. After the migration, every pre-existing row is Kitchen (P-2). A row created through `create_inventory_item_with_catalog`, the admin add-item flow or CSV import, without naming an area, is Kitchen. (pgTAP)
- [ ] **AC-2:** The tag is per store. Changing it on store X's row leaves store Y's row for the same `catalog_id` unchanged. `apply_item_scalars_to_brand` and `apply_item_vendors_to_brand` never change it. (pgTAP)
- [ ] **AC-3:** `(store_id, catalog_id)` uniqueness is unchanged. `inventory_items_identity_lock.test.sql`, `cross_store_item_rejection.test.sql`, `public_grants_explicit.test.sql` and `permissive_policy_lint.test.sql` pass **unmodified**. Any new function has EXECUTE revoked from `public, anon` (spec 097). Any new table has RLS keyed on `auth_can_see_store()` and adds no trivially-wide permissive policy.
- [ ] **AC-4:** The per-store item editor (desktop and phone) has a Front / Kitchen control showing the current value. Saving goes through a `db.ts` wrapper and a `useStore.ts` slice action, with an optimistic update. On failure it reverts and calls `notifyBackendError`. The roles allowed are exactly those allowed to edit `par_level` on that row today. (jest)
- [ ] **AC-5:** Setting the tag changes nothing else on the row (par, cost, on-hand, vendor links), checked field by field. (pgTAP or jest at the wrapper)
- [ ] **AC-6:** Spec 184's `stock_store_from_store` copies each source item's area to the new row, and ticked uncarried catalog rows are Kitchen (P-12). Spec 184's pgTAP file gains these assertions, and its other assertions pass unchanged.

### When the filter appears
- [ ] **AC-7:** At a store whose items are all in one area, the admin desktop EOD, admin phone EOD and staff EOD show **no area pills**. The vendor tabs, items, lock/EDIT, day statuses and submissions behave and render as before. The existing EOD jest suites pass, with changes only where this spec says so (P-3).
- [ ] **AC-8:** At a store with at least one item in each area, admin desktop EOD shows **Front** and **Kitchen** pills, with no "All", opening on Kitchen (P-5). Choosing one shows only that area's items for the selected vendor. The category pills apply within the chosen area, and the item count shown matches the filtered list. (jest)
- [ ] **AC-9:** Admin phone EOD (`PhoneEodCount`) has the same pills and filtering as AC-8. Search, if present, applies within the chosen area. (jest)
- [ ] **AC-10:** Staff EOD has the same pills and filtering. A submission queued offline records its area and, when replayed, lands as that area's submission. (jest)
- [ ] **AC-11:** When the chosen area has no items for the selected vendor, the screen says nothing needs counting in that area for that vendor, and offers no submit for it. That area isn't required for completion (P-7). Spec 184's store-level empty states S1 to S4 still take precedence when they apply. (jest)

### Per-area submissions (the core requirement)
- [ ] **AC-12:** **Both kept, neither overwrites.** For one store, date and vendor, a Front submission followed by a Kitchen submission through the **admin path** leaves both stored. Reading back returns exactly the Front entries for Front and the Kitchen entries for Kitchen. The same holds in reverse order. (pgTAP for the data shape, jest for the `db.ts` wrapper)
- [ ] **AC-13:** AC-12 holds through **`staff_submit_eod`**, and with mixed paths (Front from admin and Kitchen from staff, and the reverse). (pgTAP)
- [ ] **AC-14:** **Re-submitting (EDIT) one area** replaces only that area's entries. The other area's entries, submitter and submitted time are unchanged, checked row by row. Both paths. (pgTAP)
- [ ] **AC-15:** Different people can submit each area. The submitter of each area is recorded and shown, and an edit by a third person changes only the submitter recorded for that area. (pgTAP + jest)
- [ ] **AC-16:** An area's submission updates `current_stock` / `eod_remaining` only for that area's items. The other area's items keep their values, under the existing spec 102 junction rule. (pgTAP)
- [ ] **AC-17:** A saved draft for one area neither overwrites, blocks nor changes the other area's draft or submission. (jest, and pgTAP if drafts are stored server-side)
- [ ] **AC-18:** Replaying the same `client_uuid` for one area returns the existing `conflict: true` envelope and leaves the other area untouched. (pgTAP)
- [ ] **AC-19:** **No double count.** For any (store, date, vendor), the combined entries never hold two entries for the same item. A submission that would add an item already counted in the other area's submission for that day is refused, or leaves the existing entry in place (the architect picks which and the test pins it). Covers the P-11 move-after-count case. (pgTAP)
- [ ] **AC-20:** NO NEED (spec 172) and cases/each entry (spec 086) behave exactly as today inside each area. (existing suites, plus one per-area assertion each)

### Completion and status
- [ ] **AC-21:** The P-7 completion rule is a single pure helper with jest coverage:
  - Front only submitted, both required: incomplete;
  - both submitted: complete;
  - vendor with Kitchen items only, Kitchen submitted: complete;
  - Front only drafted: incomplete;
  - store with all items in one area: same answer as today.

  If any SQL path (cron, notifications) needs the same rule, a pgTAP test proves SQL and TS agree on the same fixtures.
- [ ] **AC-22:** The desktop vendor tab shows ✓ SUBMITTED, and the phone and staff chips show green, **only when the vendor is complete**. A partial vendor shows which area is in and which is due. Lock/EDIT is **per area**: a submitted area is read-only with EDIT, and the other area stays editable. (jest)
- [ ] **AC-23:** A week-sidebar day reads `submitted` only when every scheduled vendor is complete. A partly submitted day keeps today's status pill for its counts (`late` / `today` / `draft`) and names the area still due. `rest` and `uncounted` are unchanged (P-8). (jest on `deriveDayStatus` or its caller)
- [ ] **AC-24:** Reminders and missed counts (P-9): at a split store with only Front submitted for a scheduled vendor, the Track 1 reminder still fires and a Track 3 miss is still recorded after the deadline, naming Kitchen. With both in, neither fires. Stores without a split behave as today. (test track per the architect)
- [ ] **AC-25:** Notifications (P-10):
  - each area's first submission creates exactly one EOD notification for responsible admins naming the area;
  - an area's re-submission creates one `eod_update`;
  - `order_ready` is evaluated only when the vendor becomes complete, and fires at most once per (store, date, vendor), as today;
  - at a store without a split, notifications are identical to today.

  (pgTAP, extending the spec 149 and spec 180 suites)

### Combined outputs stay combined
- [ ] **AC-26:** For a fixture day counted as Front plus Kitchen submissions, these return **exactly the same output** as the same counts submitted as one submission at a store without a split: reorder list, variance report, weekly low-stock, `items_last_counted`, PO creation from reorder, order approvals, and `report_last_order_context`. (pgTAP, comparing the two)
- [ ] **AC-27:** Weekly count, ordering screens, vendor exports, auto-place, costing and the Dashboard have no code change attributable to this spec. If the architect finds one is needed to keep AC-26, it's listed in the design.

### Moving an item
- [ ] **AC-28:** After an item moves from Kitchen to Front, it appears only under Front from then on. Past submissions are unchanged and still show it under the area it was submitted in. If it was already counted today under Kitchen, Front shows it read-only as counted (AC-19). (pgTAP + jest)

### Strings
- [ ] **AC-29:** New keys exist in `en.json`, `es.json` and `zh-CN.json`, and in the staff catalog's three locales, using the P-14 labels. `src/i18n/i18n.test.ts` and the staff i18n parity test pass.

### Gates and rollout
- [ ] **AC-30:** `scripts/test-db.sh`, full `npx jest` (not a subset), `npm run typecheck` and `npm run typecheck:test` pass. Grep for tests pinning the single-submission-per-vendor behaviour and update only those this spec changes.
- [ ] **AC-31:** Browser preview on the local stack (`npm run dev:db`), at desktop and phone widths, recorded in the review notes:
  1. a store with all items Kitchen shows no pills, and EOD works as before;
  2. tag three items Front in the item editor, and the pills appear;
  3. submit Kitchen for a vendor; the tab or chip shows Kitchen in and Front due; the day isn't `submitted`;
  4. submit Front as a different user; the vendor shows complete, and both sets of counts are visible;
  5. EDIT Kitchen and confirm Front's counts are unchanged;
  6. the staff app shows the same states;
  7. the reorder list for that store matches the combined counts.
- [ ] **AC-32:** The design includes a prod apply runbook for project `ebwnovzzkwhsdxkpyjka` in the spec 177 §10 / spec 179 S-1/S-2 shape. The migration version is after `20261105000000`. It's applied on the owner's go-ahead **before** the push that carries it. After the push, `test.yml` and `db-migrations-applied.yml` are confirmed green on `main`, and `e2e.yml` is checked by hand. If `eod-reminder-cron` changes, its deploy is part of the runbook.
- [ ] **AC-33:** `app.json` `slug` is unchanged (`towson-inventory`).

## In scope
- A per-store Front / Kitchen tag on items, defaulting to Kitchen, set in the item editor on desktop and phone.
- Front / Kitchen pills on admin EOD desktop, admin EOD phone and staff EOD, shown only at stores with items in both areas.
- One submission per area per (store, date, vendor), on both submit paths, with per-area lock/EDIT, drafts and offline queue.
- The completion rule, and how it shows in vendor tabs and chips, the day sidebar, reminders, missed counts and notifications.
- Spec 184 stocking carries the tag.
- Three-locale strings in both catalogs, tests on the tracks above, and the prod runbook.

## Out of scope (explicitly)
- **Weekly count by area.** The owner limited the split to EOD.
- **Any change to ordering, reorder, POs, exports, auto-place, par, costing, sales depletion or reports.** The owner said one combined list for ordering. AC-26 guards it.
- **An item in both areas, or separate pars per area.** The owner chose "each item in one".
- **Two stores per location (the old Option A).** The owner chose areas in one store.
- **More than two areas, or area names set per store.** The owner named exactly Front and Kitchen.
- **A brand-wide (catalog) tag, or fanning the tag out across stores.** P-1 is per store. It could be a follow-up.
- **Bulk tagging, and an area column or filter in the Inventory list.** Useful for setup, but not requested. Follow-up.
- **Assigning staff to an area,** or limiting who may count which area. P-5 lets anyone count either.
- **Stock transfers between Front and Kitchen.** Each item has one on-hand.
- **The area in CSV import/export.** New rows default to Kitchen (AC-1).
- **Customer PWA, `pwa-catalog`, `app.json` slug, EAS or push config.** Not touched.

## Open questions resolved
- Q: What does "separate front and back inventories" mean? → A: First answer: two separate lists with their own items, pars and submissions. Narrowed later (below). Rejected: (a) "same item counted twice and added together"; (b) at first, "each item in one area", which the owner then chose once the split was limited to EOD.
- Q1: Two stores, or areas inside one store? → A: **Areas in one store.**
- Q (follow-up): What does the split cover? → A: "all items in one list for ordering just on eod counts has a filter stating for front count and kitchen count".
- Q2: Can the same item be in both counts? → A: **No, each item in one.**
- Q (follow-up): One submission with a filtered screen, or each area its own? → A: **Each submits its own.** Different people, separate submissions, both kept.
- Q3 and Q8 (how lists combine; ordering) → settled by the above. Combined and store-level, unchanged.
- Q5 (surfaces) → narrowed to the EOD count. Which EOD surfaces is P-4.
- Q10 (naming) → **Front / Kitchen.** Translations are P-14.

## Confirm in one pass (owner)

Reply "all defaults OK", or name the ones to change:
1. **P-1** The tag is per store (not brand-wide).
2. **P-2** Existing and new items default to Kitchen.
3. **P-3** No store setting. Pills appear only when a store has items in both areas.
4. **P-4** Admin EOD desktop, admin EOD phone and staff EOD. The weekly count is unchanged.
5. **P-5** Two pills, no "All", opening on Kitchen. Anyone can count either area.
6. **P-6** Set in the item editor by whoever can edit par. No bulk tool.
7. **P-7** A vendor's day is complete when every area with items for that vendor is submitted.
8. **P-8** Partial shows which area is due. The day isn't "submitted" until every vendor is complete.
9. **P-9** Reminders and missed-count alerts keep firing until both areas are in.
10. **P-10** Each area's submit notifies admins, naming the area. **The approve-order (`order_ready`) check waits for the last area.** This is the default most likely to matter in day-to-day use.
11. **P-11** Moving an item affects it going forward only, and never double-counts a day.
12. **P-12** Stocking a new store copies each item's area.
13. **P-13** Browser checks at desktop and phone widths. No native Simulator pass.
14. **P-14** es "Frente" / "Cocina", zh-CN "前厅" / "厨房".

## Notes for architect
- **N1. Mechanism is yours.** For example: area in the submission key; one parent row with area-scoped entry replacement; or a child per-area submission row. Whatever you choose must satisfy AC-12 to AC-19 on **both** paths. Today both paths delete every entry of the submission before inserting the new ones (`db.ts` L1053-1062; `staff_submit_eod` step 6).
- **N2. List every reader of `eod_submissions` / `eod_entries`** (the grep in "Current state" found about 40 migrations, the reminder cron, admin `db.ts`, and the staff `submittedStatus.ts` / `yesterdayStatus.ts` / `EODCount.tsx`). For each, record whether it's unchanged, area-aware or completion-aware. AC-26 is the equality proof for the combined readers.
- **N3. Triggers.** Spec 149's INSERT trigger and spec 180's UPDATE trigger decide between fresh, edit and `order_ready`. The mechanism changes which of them fires for the second area's submission. P-10 says what the owner should see. Design the trigger behaviour to match, and keep the spec 180 throttle intact.
- **N4. Completion in two languages.** P-7 is needed in TS (screens) and possibly SQL (cron, triggers). Keep one definition per side, pinned to shared fixtures (AC-21).
- **N5. Staff offline queue.** Queued items replay later. Make sure a replay can't land under the wrong area or turn into a cross-area overwrite.
- **N6. Realtime.** Adding a column to `inventory_items` / `eod_submissions` needs no publication change. If you add a **new table**, check whether `20260514140000_realtime_publication_tighten.sql` leaves the publication `FOR ALL TABLES`. Any publication change needs the `docker restart supabase_realtime_imr-inventory` re-snapshot locally.
- **N7. Migration slot.** After `20261105000000` (spec 184, uncommitted). Re-check for spec 178's slot.

## Risks
- **Silent overwrite.** Any path that keeps the delete-all-entries step without area scoping will wipe the other area with no error. AC-12 to AC-14 on both paths are the guard.
- **A half-done day read as done.** Any submission reader missed in N2 (chip, reminder, missed count, `order_ready`) will treat the first area's submission as the whole day. AC-22 to AC-25 cover the known ones.
- **Approve-order timing.** Under P-10, `order_ready` waits for the second area. If one crew never submits, the approve-order prompt never comes for that vendor that day. Missed-count tracking (P-9) still flags it. If the owner would rather have early prompts on partial data, P-10 changes.
- **Setup effort.** With no bulk tool (P-6), each Front item is tagged one at a time. Acceptable for a few dozen items, and noted as a follow-up.
- **Collision with spec 184.** Same files (`EODCountSection.tsx`, `PhoneEodCount.tsx`, `useStore.ts`, `db.ts`), and spec 184's RPC changes. Build after 184 is committed.
- **Edge function deploy.** If `eod-reminder-cron` changes, it's deployed separately from the migration (supabase CLI deploys one function at a time). The runbook orders both.
- **Prod/repo drift.** The migration must be on prod before the push, or `db-migrations-applied.yml` goes red.

## Dependencies
- **Spec 184** (uncommitted): stocking RPCs, EOD empty states S1 to S4, migration `20261105000000`.
- Spec 020 (vendor-keyed submissions), spec 086 (cases/each), spec 102 (junction on-hand write), spec 172 (NO NEED).
- Spec 121 (missed counts), spec 129 (staff chip status), spec 133 (day status), spec 149 (`order_ready`), spec 180 (`eod_update`, throttle).
- Spec 179 (identity lock), spec 177 (cross-store lines), specs 119/122 (fan-outs that must leave the tag alone).
- Spec 097 (grants), spec 053 (permissive-policy lint), spec 064 (migration gate).

## Project-specific notes
- **Cmd UI section / legacy:** `src/screens/cmd/sections/EODCountSection.tsx`, `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, the per-store item editor (`src/components/cmd/IngredientForm*.tsx`, `src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx`), and `src/lib/eodDayStatus.ts`. No legacy surface.
- **Which app:** this repo. That's the admin Cmd UI plus the staff EOD app at `src/screens/staff/` (spec 063). The customer PWA isn't involved.
- **Per-store or admin-global:** per store. The tag is on the per-store item row, and submissions stay store-scoped under `auth_can_see_store()`.
- **Edge function or PostgREST:** admin EOD through `db.ts` (PostgREST); staff through `staff_submit_eod` (RPC, staff carve-out). **`eod-reminder-cron` changes under P-9** (JWT/cron auth unchanged).
- **Realtime channels touched:** `store-{id}`, for `inventory_items` (tag changes) and `eod_submissions` / `eod_entries`. A publication change only if a new table is added (N6).
- **Migrations needed:** yes. Version after `20261105000000`. Prod apply via MCP before the push.
- **Edge functions touched:** `eod-reminder-cron` (Track 1 and Track 3 completion).
- **Web/native scope:** both (shared React Native code). Browser verification at desktop and phone widths only (P-13).
- **`app.json` slug:** not touched.
- **Test tracks:** pgTAP (tag, both submit paths, triggers, combined-output equality), jest (screens, completion and day-status helpers, slices, i18n parity in both catalogs), both typechecks. A cron test per the architect.

## Handoff
next_agent: NONE
prompt: Open questions for the user — see DRAFT spec. Owner to confirm defaults P-1 to P-14 in "Confirm in one pass" (P-10, approve-order timing, matters most). If all are accepted, set Status: READY_FOR_ARCH and dispatch backend-architect with no other edits.
payload_paths:
  - specs/185-front-back-inventories.md
