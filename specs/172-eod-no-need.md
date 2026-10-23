# Spec 172: EOD "NO NEED" button (we have more than enough)

Status: READY_FOR_REVIEW

Origin: owner request (2026-10-23), verbatim: 'create a botton for "NO NEED" means have more than enough'. The owner approved decisions 1-3 below in chat before this spec was written; they are recorded as resolved.

**Sequencing:** this spec is built **after spec 171** (per-ingredient EOD count mode) lands. It assumes 171's `catalog_ingredients.eod_count_mode`, the shared helper [src/lib/eodCountMode.ts](../src/lib/eodCountMode.ts) (`effectiveEodCountMode`, `eodBoxes`, `eodHasEntry`, `eodTotal`, `eodEntryValues`), the optional `effectiveModeOf` argument on `deriveCountedItemIds`, and 171's D7 locked-row rule all exist. Line numbers below are from `main` at `c2ac211`, which is **pre-171**. 171 shifts them, so treat them as pointers.

## User stories

1. As a **store manager or staff counter**, I want a NO NEED button on each EOD count row. When the shelf obviously has more than enough of an item, I can mark it done in one tap instead of counting it.
2. As a **manager placing orders**, I want an item marked NO NEED to drop out of that day's order suggestions, so I don't buy something we're overstocked on.
3. As an **admin reading reports**, I want a NO NEED mark never to be mistaken for a count of zero, so on-hand, usage, variance, and COGS figures stay honest.

## Current state (verified 2026-10-23)

**Storage**
- `public.eod_entries` ([init_schema.sql:128](../supabase/migrations/20260405000759_init_schema.sql)) has these columns: `actual_remaining numeric(10,3)` (nullable), `actual_remaining_cases`, `actual_remaining_each` (both nullable, spec 086), `notes`, `item_id`, and `submission_id`.
- There is no flag column. Every entry today is a numeric count.
- `eod_entries` is **not** in `supabase_realtime`. `eod_submissions` is, on `store-{id}` ([useRealtimeSync.ts:48](../src/hooks/useRealtimeSync.ts)).

**Admin submit:** [`submitEODCount`, src/lib/db.ts:959-1084](../src/lib/db.ts)
- Upserts the parent row, deletes every entry, then inserts the new set.
- For each entry whose item has an `item_vendors` link to the submitting vendor, it writes `inventory_items.current_stock = eod_remaining = entry.actualRemaining` (L1059-1079).
- Before that, the store's optimistic `submitEOD` ([useStore.ts:2943-3058](../src/store/useStore.ts)) has already done three things:
  - mirrored `currentStock` / `eodRemaining` locally;
  - fired `db.adjustItemStock(itemId, actualRemaining)` (L3026);
  - written an audit event whose `value` is `` `${actualRemaining} ${unit}` `` (L3057).

**Staff submit:** `staff_submit_eod` ([20260630000200_staff_submit_eod_multi_vendor.sql](../supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql)). This is the latest owner; nothing later redefines it.
- It destructures `p_entries` through `jsonb_to_recordset`.
- It writes `current_stock = eod_remaining = v_entry.actual_remaining` **unconditionally** for linked items (L203-210).
- Its audit `value` is `actual_remaining::text || ' ' || unit`.
- **A NULL `actual_remaining` today would set `current_stock` to NULL.**

**Staff offline queue:** `isValidEodEntry` ([src/screens/staff/lib/eodQueue.ts:49](../src/screens/staff/lib/eodQueue.ts)) requires `typeof actual_remaining === 'number'`. A queued entry with a null total would fail hydrate validation.

**Read mappers coerce null to 0**
- Admin: `fetchTodaysEODForStores`, `fetchRecentEODSubmissions`, and `fetchEodSubmissionsForStores` (db.ts ~L1132/1181/1246) use `Number(e.actual_remaining) || 0`.
- Staff: `fetchExistingSubmission` ([EODCount.tsx:239](../src/screens/staff/screens/EODCount.tsx)) uses `actual_remaining == null ? 0 : …`, and then `seedFromExisting` (L444) seeds Units from that total when both splits are null.
- So any entry with no number reads back as **0**: on the admin locked view, in admin EDIT prefill, and in the staff locked/EDIT view.

**Client numeric consumers of `EODEntry.actualRemaining`.** A NO NEED entry would corrupt each of these if it read as 0:
- [src/lib/cmdSelectors.ts](../src/lib/cmdSelectors.ts): `getStockSeries` (L22), `computeVarianceLines` (L353), `computeCogsActual` (L458), `computeTopVarianceItems` (L505), `computeStoreFoodCostVariancePp` (L604), and the scoped wrappers.
- [src/utils/usageCalculations.ts](../src/utils/usageCalculations.ts) (opening stock L163, variance L236).
- [ReconciliationSection.tsx](../src/screens/cmd/sections/ReconciliationSection.tsx) (L288, L376).
- `EODEntry.actualRemaining` is typed `number` ([src/types/index.ts:378](../src/types/index.ts)).

**Reorder engine:** `report_reorder_list(uuid, jsonb)`. The latest body is [20260726000000_reorder_drop_inbound_term.sql](../supabase/migrations/20260726000000_reorder_drop_inbound_term.sql); no later migration redefines it.
- `latest_eod_per_vendor` (4e) reads `status='submitted'` submissions for `(store, as_of_date)`.
- `item_on_hand` (4f) has one row per (item × linked vendor):
  - **Case A:** that vendor has an entry with non-null `actual_remaining`. Then `on_hand = actual_remaining` and source is `'eod'`.
  - **Case B:** that vendor submitted but this item has no entry or a null one. Then `on_hand = current_stock`, source is `'stock'`, and the `eod_missing_for_item` flag is set.
  - **Case C:** that vendor did not submit. Then `on_hand = current_stock` and source is `'stock'`.
- Suggestion: `suggested_qty = greatest(par_replacement, usage_forecasted)`, then `suggested_cases`, `suggested_units`, `estimated_cost`, and `needs_order = suggested_qty >= 0.001`.
- Both admin ([db.ts:4653](../src/lib/db.ts)) and staff ([fetchReorder.ts](../src/screens/staff/lib/fetchReorder.ts)) call it with `include_stocked = true`. At/above-par items therefore render in a **"Have enough stock"** section rather than disappearing.
- **Today, a null-total entry lands in case B** and gets full par math plus an `EOD MISS` chip. That is the opposite of what NO NEED means.
- The **staff** reorder engine `report_reorder_for_counted_onhand` is only used by the inventory-count history (spec 105) and does not read `eod_entries`, so it is untouched.

**Other SQL readers of `eod_entries.actual_remaining`.** Each already filters `actual_remaining is not null`, so a null-total row is treated as "no count":
- `report_run_variance`
- `report_weekly_lowstock`
- `report_last_order_context` (2f)

`items_last_counted` / `staff_items_updated` (spec 160/128) count **row existence** under a submitted submission.

**Last-order delta:** [src/utils/lastOrderContext.ts:136-137](../src/utils/lastOrderContext.ts) suppresses the counted-vs-on-hand delta only when the row carries `eod_missing_for_item`.

**Counted predicates**
- Admin desktop: `localHasEntry` / `hasEntry` (EODCountSection.tsx L588-590) and `deriveCountedItemIds` (L74: arm (a) is typed values in any vendor tab, arm (b) is entries of any submission for the (store, date), drafts included).
- Admin phone: reuses the same functions through `PhoneEodModel` ([PhoneEodCount.tsx:39](../src/screens/cmd/sections/eod/PhoneEodCount.tsx)).
- Staff: `isCounted` (L379), `countedNum` (L345), and the `isBlank` gate (L704).

**Admin draft:** Save Draft goes through the same `submitEODCount` with `status='draft'` (replace, not merge). Drafts are not rehydrated into the local maps (spec 171 N3). Staff has no drafts.

**Count export:** [src/utils/countExport.ts](../src/utils/countExport.ts) `CountExportItem { countedCases, countedUnits }`, where `countedTotalCell` is blank when both are null. It is fed by `buildExportGroups` (EODCountSection.tsx L621).

**Admin reorder flag chips:** `FlagChip` ([ReorderSection.tsx:229](../src/screens/cmd/sections/ReorderSection.tsx)) maps known tokens and renders unknown tokens raw. The staff reorder row shows an on-hand figure ([Reorder.tsx:110-119](../src/screens/staff/screens/Reorder.tsx)) and renders no flags.

## Definitions

- **NO NEED mark:** a per-(submission, item) state meaning "we have more than enough; not counted numerically."
  - It is mutually exclusive with a numeric count for that item in that vendor tab.
  - It satisfies the completeness gate.
  - It carries no quantity.
- **Count cycle:** the `(store_id, date)` of the submission that carries the mark. For the reorder engine, that is a `status='submitted'` submission whose `date = as_of_date`.

## Acceptance criteria

Storage column naming is the architect's call. This spec calls it `eod_entries.no_need`.

### Schema and write paths (pgTAP, new file `supabase/tests/eod_no_need.test.sql`)

- [ ] **AC-1:** `public.eod_entries` has a column `no_need boolean NOT NULL DEFAULT false`.
  - Every pre-existing row reads `false` after the migration.
  - An insert that omits the column reads `false`.
- [ ] **AC-2:** A CHECK constraint enforces that a NO NEED row carries no quantity.
  - `no_need = true` with any of `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each` non-null raises SQLSTATE `23514`.
  - `no_need = false` rows are **not** newly constrained. Legacy null-total rows stay valid.
- [ ] **AC-3:** `staff_submit_eod` accepts an optional per-entry `no_need` key in `p_entries`.
  - Given `{ingredient_id, no_need: true}` with the numeric keys absent or null:
    - (a) an `eod_entries` row is inserted with `no_need = true` and all three numeric columns NULL;
    - (b) `inventory_items.current_stock` and `eod_remaining` for that item are **unchanged**. Pre-seed a value such as 7; it reads 7 afterwards, not 0 and not NULL;
    - (c) `inventory_items.updated_at` is not bumped by that entry;
    - (d) the audit-log row for that entry has `value = 'NO NEED'`, not NULL;
    - (e) the returned `stock_updates` array omits that item.
- [ ] **AC-4:** In `staff_submit_eod`, a `p_entries` element **without** a `no_need` key behaves byte-identically to today: `no_need = false`, and the on-hand write and audit row are unchanged. The existing `staff_submit_eod_cases_each.test.sql`, `staff_role_eod_rls.test.sql`, and `eod_submissions_multi_vendor.test.sql` suites pass unmodified.
- [ ] **AC-5:** In `staff_submit_eod`, an element with `no_need: true` **and** a non-null `actual_remaining` is refused: SQLSTATE `23514` (or a `22023` raise, at the architect's choice). The whole call rolls back, leaving no parent row, no entries, and no on-hand change.
- [ ] **AC-6:** An authenticated store member (admin path, direct PostgREST) can INSERT an `eod_entries` row with `no_need = true` under a submission in a store they can see. Existing RLS is unchanged and the cross-store trigger `eod_entries_check_store` still fires. A non-member is refused, exactly as today.
- [ ] **AC-7:** The migration is additive and re-runnable. The full pgTAP suite passes, including `permissive_policy_lint`, `po_loop`, every `report_reorder_list_*` file, `reorder_list_has_po`, and `eod_count_mode`.

### Reorder: "suggest 0" (pgTAP, same file)

- [ ] **AC-8:** Fixture: item X with `par_level = 10` and `current_stock = 2`, linked to vendor V. V has a `submitted` submission for `as_of_date` containing X with `no_need = true`. `report_reorder_list(store, {as_of_date, include_stocked: true})` emits X's row on V's card with all of the following:
  - `suggested_qty = 0`, `par_replacement = 0`, `usage_forecasted = 0`, `suggested_units = 0`, `estimated_cost = 0`;
  - `suggested_cases = 0` when `case_qty > 1`, and JSON null otherwise (current formula);
  - `needs_order = false`;
  - `flags` contains `'no_need'` and does **not** contain `'eod_missing_for_item'`;
  - `on_hand` = `current_stock` (2). The stored on-hand is surfaced as-is and never fabricated as 0.
- [ ] **AC-9:** With `include_stocked` absent or false, X is **absent** from the payload. A vendor whose only rows are NO NEED is hidden, as today, and contributes nothing to `kpis.item_count` or `total_estimated_cost`.
- [ ] **AC-10:** A NO NEED row counts as EOD-sourced: the item-level source is `'eod'`. A vendor whose submitted items are all NO NEED still rolls up `on_hand_source = 'eod'`, not `'stock'`, so it shows no STOCK FALLBACK badge.
- [ ] **AC-11 (cycle-scoped):** The same fixture queried with `as_of_date + 1`, with no submission that day, gives X normal case-C math (`suggested_qty = 8`, `needs_order = true`). NO NEED never carries over to the next cycle.
- [ ] **AC-12 (shared item, spec 102):** X is linked to V1 and V2.
  - V1's submitted submission for `as_of_date` marks X NO NEED.
  - V2 either has a submitted submission without an X entry, or has not submitted at all.
  - Result: X's row on **V2**'s card is also NO NEED (suggest 0, `'no_need'` flag), because the mark is item-wide for the count cycle.
  - **Precedence:** if a vendor row has its **own** numeric entry for X, case A applies to that row unchanged. The NO NEED override applies only to rows that would otherwise fall to case B or C (see OQ-2).
- [ ] **AC-13:** A **draft** submission carrying a NO NEED entry does not affect reorder. The engine still reads `submitted` only.
- [ ] **AC-14:** Regression. For fixtures with no NO NEED entries, `report_reorder_list` output is byte-identical to before. The existing reorder pgTAP files pass unmodified.
- [ ] **AC-15:** `report_run_variance` treats a NO NEED entry exactly as an absent entry for that item. Prove it with one assertion comparing a fixture with the NO NEED row against the same fixture without it. This is expected to hold already through the existing `actual_remaining is not null` filter; the assertion pins it.

### Shared rules (jest, pure helper)

- [ ] **AC-16:** A pure helper sits alongside spec 171's `src/lib/eodCountMode.ts` (same module or a sibling, at the architect's choice) and owns the NO NEED rules. Jest covers every row of the following, under each of 171's three effective modes:
  - **counted:** `noNeed || eodHasEntry(mode, caseRaw, unitRaw)`.
  - **entry values:**
    - NO NEED emits `{ noNeed: true, total: null, cases: null, units: null }`. A stale typed value is ignored.
    - Otherwise 171's `eodEntryValues` is unchanged.
  - **toggle:**
    - Setting NO NEED clears both typed boxes for that item in that tab.
    - Typing any character into either box, or any keypad key into either well, clears NO NEED.
    - Tapping NO NEED again when active clears it, and the row returns to uncounted with blank boxes.
- [ ] **AC-17:** `deriveCountedItemIds` gains an optional NO NEED input: a per-vendor set or map, at the architect's choice. An item marked NO NEED in **any** vendor tab is counted in every tab (spec 102 counted-once-globally).
  - Arm (b) needs no change: persisted NO NEED entries are entries.
  - Omitting the new argument reproduces today's output. The existing `EODCountSection.countedOnce` / `customOrder` tests and 171's mode arms pass unmodified.

### Admin desktop (jest, `EODCountSection.tsx` `renderEodRow`)

- [ ] **AC-18:** Each editable row renders a NO NEED control with testID `eod-noneed-<itemId>` next to the CASES/UNITS inputs. The label comes from a new i18n key in [src/i18n/en.json](../src/i18n/en.json), `es.json`, and `zh-CN.json`. Tapping it gives all of the following:
  - (a) the row is counted: no danger border, no red name, and it is included in `countedNum`;
  - (b) both inputs show blank and the active state of the NO NEED control is visible;
  - (c) the `· total N unit` meta suffix is not shown;
  - (d) the final-submit gate no longer blocks on this row.
- [ ] **AC-19:** After NO NEED is set, typing into either enabled input clears NO NEED. Tapping NO NEED while a number is typed clears the number (OQ-1).
- [ ] **AC-20:** The control is disabled and non-interactive whenever the inputs are disabled: rest day, or vendor locked and not in EDIT.
- [ ] **AC-21:** `buildSubmission` emits one entry per NO NEED item with `noNeed: true`, no numeric `actualRemaining*` values, and the row's note preserved. A worksheet whose only marks are NO NEED still builds a non-null submission, for Save Draft and for Submit. `itemCount` includes NO NEED entries.
- [ ] **AC-22:** `submitEODCount` sends `no_need: true` with all three numeric columns null for those entries. It performs **no** `inventory_items` update for them.
- [ ] **AC-23:** The store's optimistic `submitEOD` makes no `currentStock` / `eodRemaining` mirror and no `db.adjustItemStock` call for NO NEED entries. Its audit event `value` is `'NO NEED'`.
- [ ] **AC-24:** The footer `estValue` and `variance` exclude NO NEED rows, the same as untyped rows.
- [ ] **AC-25:** **Locked (read-only) view.** A submitted vendor whose submission holds a NO NEED entry renders that row with blank boxes and the NO NEED control shown active but disabled. It never shows `0`. **EDIT prefill** (`onEditCurrentVendor`) seeds the NO NEED state for that item and does **not** seed `"0"` into units. This replaces the `actualRemaining → units` fallback for NO NEED entries only.
- [ ] **AC-26:** **Read mappers.** `fetchTodaysEODForStores`, `fetchRecentEODSubmissions`, and `fetchEodSubmissionsForStores` select `no_need` and surface it on `EODEntry` (for example `noNeed: true`). None of them turn a NO NEED entry into `actualRemaining: 0` that a numeric consumer would read.

### Numeric consumers stay honest (jest)

- [ ] **AC-27:** Given an otherwise identical submission history with and without one NO NEED entry, each of the following returns identical output:
  - `getStockSeries`, `computeVarianceLines`, `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp` ([cmdSelectors.ts](../src/lib/cmdSelectors.ts));
  - the opening-stock and variance paths in [usageCalculations.ts](../src/utils/usageCalculations.ts);
  - the counted/delta math in [ReconciliationSection.tsx](../src/screens/cmd/sections/ReconciliationSection.tsx).

  The architect picks the mechanism, for example a nullable `actualRemaining` with guarded consumers, or excluding NO NEED entries from the numeric `entries` array. The test is behavioral.

### Admin phone (jest, `PhoneEodCount.tsx` / `PhoneKeypadSheet.tsx`)

- [ ] **AC-28:** Each unlocked `CountRow` renders a NO NEED control with testID `eod-noneed-<itemId>`. Tapping it marks the row counted (the `eod-counted-<id>` check renders) without opening the keypad. The wells render blank.
- [ ] **AC-29:** The keypad sheet renders a NO NEED button with testID `eod-sheet-noneed`. Tapping it:
  - marks the seated item NO NEED and clears its wells;
  - advances to the next uncounted item, or closes when none remain, the same as NEXT ITEM (OQ-5).

  While the seated item is NO NEED, the running total shows the localized NO NEED label instead of `0`, and any digit key clears NO NEED and writes the digit.
- [ ] **AC-30:** `isDone`, `advanceUncounted`, and the "N left / ready" caption treat NO NEED as counted. The locked `CountRow` shows the NO NEED state, never `0`, per AC-25.

### Staff app (jest, `EODCount.tsx` + `eod/StaffEodCountRow.tsx` + `eod/StaffKeypadSheet.tsx`)

- [ ] **AC-31:** `StaffEodCountRow` renders a NO NEED control with testID `eod-noneed-<itemId>` when not `locked`, with the same toggle semantics as AC-16. The label comes from new keys in [src/screens/staff/i18n/en.json](../src/screens/staff/i18n/en.json), `es.json`, and `zh-CN.json`. `StaffKeypadSheet` renders `eod-sheet-noneed` with AC-29 semantics. Existing `StaffEodCountRow.test.tsx` arms pass unmodified, so the new props are optional.
- [ ] **AC-32:** `isCounted`, `countedNum`, the `isBlank` submit gate, `isDone`, and advance all treat NO NEED as counted. The entry builder emits `{ item_id, no_need: true, actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null }` for NO NEED items (the exact key set is the architect's call, but it must satisfy AC-3). The "no counts entered" guard passes when only NO NEED marks exist.
- [ ] **AC-33:** `fetchExistingSubmission` selects `no_need`. `seedFromExisting` restores the NO NEED state for those items and does **not** seed `"0"` into Units. The locked view and the EDIT then Cancel revert both show NO NEED. The `existing` that is synthesized locally after submit, on success or while queued, also renders NO NEED.
- [ ] **AC-34:** **Offline queue.** `isValidEodEntry` accepts the NO NEED entry shape, so a queued NO NEED submission survives hydrate. The drained `staff_submit_eod` call carries `no_need: true`. Previously valid shapes stay valid; `eodQueue.test.ts` arms pass unmodified, plus a new NO NEED arm.

### Spec 171 interaction (jest)

- [ ] **AC-35:** NO NEED is available and behaves identically under all three effective modes (`cases_and_units`, `cases_only`, `units_only`), on every surface. Under `cases_only` / `units_only`, setting NO NEED clears the enabled box. A stale value in a disabled box is already ignored per 171 AC-16 and must not un-set NO NEED. 171's ACs pass unmodified.

### Reorder surfaces (jest)

- [ ] **AC-36:** The admin `FlagChip` maps `no_need` to a labeled chip reading "NO NEED". The rendering of other tokens is unchanged.
- [ ] **AC-37:** `buildLastOrderContext` suppresses the counted-vs-on-hand `delta` when the row's `flags` include `'no_need'`, the same as `eod_missing_for_item`, because the row's `onHand` is not a real count.
- [ ] **AC-38:** On the staff `Reorder.tsx` row and on the admin reorder row in the "Have enough stock" section, a row flagged `no_need` shows the localized NO NEED label in place of the on-hand figure (OQ-3).

### Count export (jest)

- [ ] **AC-39:** `CountExportItem` gains an optional NO NEED flag. For an EOD NO NEED row, the CSV and PDF render Counted Cases and Counted Units blank and Counted Total as the localized NO NEED label (en / es / zh-CN, from the `section.eod.export.*` namespace) (OQ-6). `buildExportGroups` passes the flag from the per-vendor NO NEED state. `inventoryCount` exports are unchanged, and existing `countExport` tests pass unmodified.

### Regression gates

- [ ] **AC-40:** With no NO NEED marks, every EOD surface, every reorder payload, and every report behaves exactly as before. Existing jest suites pass with assertions unmodified. That includes `EODCountSection.*`, `PhoneEodCount`, `StaffEodCountRow`, both `eodKeypad` tests, `eodQueue`, `countExport`, `lastOrderContext`, `fetchReorder`, `cmdSelectors`, and the i18n key-parity tests (admin and staff).
- [ ] **AC-41:** All of these pass: full `npx jest`, `npm run typecheck`, `npm run typecheck:test`, full `npm run test:db`, and `scripts/smoke-staff-eod.sh` against the local stack. The smoke script gains one NO NEED entry and asserts `current_stock` is unchanged.

## In scope

- One additive migration:
  - the `eod_entries.no_need` column and its CHECK;
  - a `create or replace` of `staff_submit_eod` (same 7-arg signature, so grants are preserved) for the `no_need` key, the on-hand skip, and the audit value;
  - a `create or replace` of `report_reorder_list` (same signature) for the NO NEED override in `item_on_hand` / `per_item`.
- New pgTAP file `eod_no_need.test.sql` (AC-1 to AC-15).
- The NO NEED pure helper and the `deriveCountedItemIds` extension.
- Admin desktop row, admin phone row and keypad sheet, staff row, keypad sheet, entry builder, existing-submission fetch, and offline-queue validator.
- `src/lib/db.ts`: the `submitEODCount` write and on-hand skip, the three EOD read mappers, and the `EODEntry` type.
- `useStore.submitEOD`: the optimistic on-hand skip and the audit value.
- Numeric-consumer guards (AC-27).
- Reorder display: the admin `FlagChip` label, the staff and admin "Have enough" row label, and the `lastOrderContext` delta gate.
- Count export NO NEED cell.
- New i18n keys: admin `src/i18n/{en,es,zh-CN}.json` and staff `src/screens/staff/i18n/{en,es,zh-CN}.json`.

## Out of scope (explicitly)

- **Weekly / inventory count screens.** That covers `InventoryCountSection`, `PhoneWeeklyCount`, staff `WeeklyCount`, `inventory_count_entries`, and `submit_inventory_count`. The request is EOD-only.
- **`report_weekly_lowstock`.** It already ignores null-total entries and falls back to `current_stock`, so an item marked NO NEED at EOD can still show as low stock on that day's weekly screen. Acceptable; it is a separate surface.
- **`report_reorder_for_counted_onhand` (spec 105).** It is caller-supplied on-hand from inventory counts and does not read EOD.
- **Persisting a quantity for NO NEED** (for example "copy last on-hand into actual_remaining"). Rejected because it would fabricate a count that variance and COGS would then trust.
- **Carry-over.** NO NEED applies to one count cycle only (AC-11). There is no "NO NEED until …" or per-item standing setting.
- **Per-item or brand-level "never needs counting" setting.** It is a per-count tap, not catalog configuration.
- **Changing what "last counted" means.** `items_last_counted` / `staff_items_updated` are unchanged. A NO NEED mark counts as a sighting (OQ-4).
- **Rehydrating admin drafts into local maps.** Pre-existing; spec 171 N3 is unchanged. A saved draft's NO NEED marks are persisted but, like numeric draft values, are not restored after a refresh.
- **Ordering-side suppression beyond the reorder RPC** (vendor import files, cart-filler extension, PO export). These consume `needs_order` / `suggested_*` and inherit the 0 automatically, with no separate work.
- **Prod apply of the migration.** That is the owner's call via Supabase MCP (see Risks).
- **`app.json` slug.** Not touched.

## Open questions resolved (owner-approved, 2026-10-23)

- Q: Where does the button go? → A: On each EOD count row on all three surfaces: admin desktop (`EODCountSection.tsx` `renderEodRow`), admin phone (`PhoneEodCount.tsx` / `PhoneKeypadSheet.tsx`), and staff (`EODCount.tsx` and its `eod/` row and keypad components).
- Q: What does it mean? → A: "We have more than enough." Tapping it marks the row counted without a number, which satisfies the submit completeness gate. The item's reorder suggestion is 0 for that count cycle, so ordering skips it.
- Q: Same spec as 171? → A: No. It is a separate spec, sequenced after 171.

## Open questions — RESOLVED (owner, 2026-10-23)

Owner decision, verbatim: "Accept all six recommended answers for spec 172 and send it to the architect." Each OQ below is resolved with its **Recommended** answer, which is what the ACs encode. The alternatives listed are rejected.

- **OQ-1 (RESOLVED: recommended). Tapping NO NEED on a row that already has a typed number.** **Recommended:** clear the number silently, with no confirm (AC-19). The value is one keystroke from recovery and a confirm dialog per row would slow counting. Alternative: disable NO NEED while a number is present.
- **OQ-2 (RESOLVED: recommended). Shared-item conflict.** V1 marks X NO NEED and V2 records a number for X on the same day. **Recommended (AC-12):** a vendor row with its own numeric entry uses it (case A). The NO NEED override applies only to rows that would otherwise fall back to `current_stock`. X could therefore still appear under V2's "Needs to Order" if V2's count is below par, because a real count beats a judgment call. Alternative: NO NEED wins item-wide.
- **OQ-3 (RESOLVED: recommended; AC-38 kept). Reorder display of a NO NEED row.** **Recommended (AC-36, AC-38):** show a "NO NEED" chip or label instead of the stale `current_stock` on-hand figure. That figure may be days old, since NO NEED never updates it. If the owner prefers to show the on-hand number, drop AC-38 and keep AC-36.
- **OQ-4 (RESOLVED: recommended). Does NO NEED count as "last counted" (spec 160 admin column) and clear the staff "Updated" badge (spec 128)?** **Recommended:** yes. Leave both functions untouched. The counter physically looked at the shelf.
- **OQ-5 (RESOLVED: recommended). NO NEED in the keypad sheet.** **Recommended (AC-29):** mark and auto-advance, the same as NEXT ITEM, since that is the fast path the button exists for.
- **OQ-6 (RESOLVED: recommended). Export cell.** **Recommended (AC-39):** put the localized "NO NEED" in Counted Total and leave the case and unit cells blank, rather than adding a new column.

## Notes for architect (non-blocking)

- **N1. Representation.** AC-2 forces NO NEED rows to carry NULL numerics. Every reader that does `Number(x) || 0` or `== null ? 0` (listed under Current state) is a latent "NO NEED = 0" bug, so audit the full `actual_remaining` read surface with grep, not only the sites listed here.
  - Two options for the client type:
    - widen `EODEntry.actualRemaining` to `number | null` and add `noNeed?: boolean`;
    - keep NO NEED entries out of the numeric `entries` array and carry them separately, for example `noNeedItemIds` on `EODSubmission`.
  - The second keeps the AC-27 consumers safe by construction. The first is more uniform for the locked view and EDIT prefill. Your call; AC-27 is behavioral.
- **N2. Three on-hand writers must agree** (spec 102's "third copy" warning, useStore.ts L2980): the admin `submitEODCount` loop, the staff RPC, and the optimistic `submitEOD` plus `adjustItemStock`. All three skip NO NEED.
- **N3. Reorder SQL.** The minimum diff appears to be:
  - an item-wide "NO NEED today" set: `(item_id)` from submitted `(store, as_of_date)` submissions with `no_need`;
  - left-joined into `item_on_hand`;
  - then, when the row is not case A and the item is in the set: zero `par_replacement` / `usage_forecasted`, set the item source to `'eod'`, swap `eod_missing_for_item` for `no_need`.

  The envelope keys stay byte-stable; only the `flags` vocabulary grows. Keep `report_reorder_for_counted_onhand` untouched. The `po_loop` parity test compares the pending-PO term, which this does not change.
- **N4. CHECK and the staff RPC.** Because the CHECK enforces AC-5, the RPC can let the INSERT raise. If you prefer a friendlier `22023` with a message, validate before any write.
- **N5. Admin per-vendor state.** A third per-vendor map (`noNeedByVendor`) mirrors `caseCountsByVendor` / `unitCountsByVendor`. It is cleared on successful submit for that vendor, exactly like the other two (EODCountSection.tsx L833-835). `PhoneEodModel` needs read and toggle access.
- **N6. Audit value literal.** `'NO NEED'` is stored English text, matching the existing English audit strings. It is not localized.

## Risks

- **Deploy order is load-bearing.** A new client against an **old** DB is harmful:
  - the admin insert fails on the unknown `no_need` column, so submit errors;
  - the old `staff_submit_eod` ignores the unknown key and writes `current_stock = NULL` for a NO NEED entry.

  Apply the migration to prod (MCP, project `ebwnovzzkwhsdxkpyjka`) **before** pushing the client. A queued offline staff NO NEED submission must never drain against the old RPC. An old client against the new DB is harmless.
- **`db-migrations-applied` goes red on commit** until the migration is applied to prod. Apply before push, as in spec 171 D8.
- **Recreating two live RPCs** (`staff_submit_eod`, `report_reorder_list`). Copy each body verbatim from its latest owner, listed under Current state, with only the NO NEED hunks. Before the prod apply, run the normalized-md5 check of the prod bodies against those files (project memory). If prod has drifted, stop.
- **Stale on-hand next cycle.** NO NEED never updates `current_stock`. A run of NO NEED days leaves the next stock-fallback suggestion based on the last numeric count. This is accepted, and OQ-3's label makes the staleness visible on the day itself.
- **Realtime.** There is no publication change: `eod_entries` is not published, and `eod_submissions` (published, `store-{id}`) gains no column. The realtime-restart gotcha does not apply.

## Dependencies

- **Spec 171** must land first: `eodCountMode.ts` helpers, the `deriveCountedItemIds` mode argument, and the D7 locked-row rule.
- Spec 086: the cases/units split columns.
- Spec 102: counted-once-globally, shared on-hand, junction-membership writes.
- Spec 103: custom order and gate jump.
- Spec 129: staff submitted-lock.
- Spec 141: keypad sheets.
- Spec 138: the latest `report_reorder_list` body.
- Spec 139: count export.
- Spec 151: `lastOrderContext`.
- The `include_stocked` "Have enough stock" split (2026-07).
- Local stack (`npm run dev:db`) for pgTAP and the staff EOD smoke.

## Project-specific notes

- **Cmd UI section / legacy:**
  - Admin: `src/screens/cmd/sections/EODCountSection.tsx` and `src/screens/cmd/sections/eod/` (`PhoneEodCount.tsx`, `PhoneKeypadSheet.tsx`). Display-only touch in `ReorderSection.tsx` (FlagChip, "Have enough" row).
  - Staff subtree: `src/screens/staff/screens/EODCount.tsx`, `eod/StaffEodCountRow.tsx`, `eod/StaffKeypadSheet.tsx`, `lib/eodQueue.ts`, `lib/types.ts`, `screens/Reorder.tsx`.
- **Per-store or admin-global:** per-store. Each mark lives on a store-scoped `eod_submissions` row, governed by the existing `auth_can_see_store()` policies and the `eod_entries_check_store` trigger. No policy change.
- **Realtime channels touched:** none changed. `store-{id}` (`eod_submissions`) already triggers the admin reload after a submit.
- **Migrations needed:** yes, one: the column and CHECK, plus `create or replace` of `staff_submit_eod` and `report_reorder_list`, with signatures unchanged.
- **Edge functions touched:** none.
- **Web/native scope:** both. All touched code is shared React Native / react-native-web, and the staff app ships in the same bundle.
- **Test tracks:**
  - pgTAP: new `eod_no_need.test.sql`, plus the full-suite regression.
  - jest: helper, desktop/phone/staff rows and sheets, `db.ts` mappers and write, `useStore.submitEOD`, `cmdSelectors` / `usageCalculations` / Reconciliation guards, `eodQueue`, `countExport`, `lastOrderContext`, `FlagChip`, i18n parity.
  - Shell smoke: `scripts/smoke-staff-eod.sh` gains a NO NEED arm.

## Backend design

Architect: backend-architect, 2026-10-23. Line numbers are from the **working tree with spec 171 applied** (171's staged backend plus the in-progress 171 frontend edits), not from `c2ac211`. Treat them as pointers. The developer re-reads before editing.

### 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | One migration, `supabase/migrations/20261024000000_eod_entries_no_need.sql`. It sorts after 171's `20261023000000_catalog_eod_count_mode.sql`. It adds a column, a CHECK, and two `create or replace` function bodies with unchanged signatures. It is additive, idempotent, and has no publication change. |
| D2 | **Storage:** `eod_entries.no_need boolean NOT NULL DEFAULT false`, plus CHECK `eod_entries_no_need_no_quantity_check`: `not no_need or (all three numeric columns are null)`. |
| D3 | **Client representation (N1): option 1, uniform entries.** `EODEntry.actualRemaining` widens to `number \| null` and gains `noNeed?: boolean`. NO NEED entries stay in `entries`, so every "counted" consumer works unchanged (arm (b), Dashboard counted set, `eodStatus`, `itemCount`, the locked-row lookup). Every numeric consumer goes through one guard: `isNumericEodEntry` / `numericEodSubmissions`. Rationale: TS strict null checks turn every arithmetic site into a compile error, so `npm run typecheck` acts as the audit. Option 2 (a separate `noNeedItemIds`) would leave the *counted* sites failing silently. |
| D4 | **Read mappers:** `actualRemaining` is `null` **only** for NO NEED rows. Non-NO-NEED rows keep today's `Number(x) \|\| 0`, which is byte-identical (AC-40). `noNeed` is attached **only when true**, through a conditional spread, so existing `toEqual` fixtures don't change shape. |
| D5 | **Staff RPC:** the new `no_need` recordset key is coalesced to false. A NO NEED entry skips the on-hand UPDATE and the `stock_updates` append, and its audit `value` is `'NO NEED'`. AC-5 is enforced by the **CHECK** (`23514`), with no separate pre-validation. That keeps a single source of truth, and the RPC already runs in one transaction, so the parent upsert rolls back with it. |
| D6 | **Reorder:** a new CTE `no_need_items` (item-wide, cycle-scoped, `submitted` only) is left-joined into `item_on_hand`. A row that is **not** case A and whose item is in the set gets `no_need_for_item = true`. That zeroes `par_replacement` / `usage_forecasted`, swaps `eod_missing_for_item` for a `'no_need'` flag, and leaves `on_hand = current_stock` unchanged. The envelope keys are byte-stable. |
| D7 | **AC-10 interpretation (flagged, see §11 OQ-A):** an override row's item source is `'eod'` **only when the row's own vendor submitted this cycle**. A cross-vendor override on a vendor that has **not** submitted keeps `'stock'`. Otherwise a vendor that never counted would lose its STOCK FALLBACK badge (with a null `eod_submitted_at`). |
| D8 | **Pure helper:** a new sibling module `src/lib/eodNoNeed.ts` (171's `eodCountMode.ts` is not edited) owns the counted, entry, toggle, and numeric-guard rules. The staff barrel `src/screens/staff/lib/eodNoNeed.ts` re-exports it (171 idiom). |
| D9 | **Deploy order:** (1) 171 committed and applied to prod; (2) the 172 prod normalized-md5 pre-check on both functions; (3) the MCP apply of 172 plus the `schema_migrations` insert; (4) then push the client. **The build must not start until spec 171 is committed** (shared files, and the helper depends on `eodCountMode.ts`). |

### 1. Data model: migration `20261024000000_eod_entries_no_need.sql`

The migration is additive. Use one `begin; … commit;`. The header comment follows the 171 migration's style: what, RLS, grants, realtime, idempotency, and rollback.

Pseudocode (the developer writes the SQL):

0. `set local lock_timeout = '5s';`. `eod_entries` is the fastest-growing table and staff write to it all evening. A short lock timeout makes the ALTER fail fast rather than queue behind a long reader and stall staff submits. If it times out, re-run off-peak.
1. `alter table public.eod_entries add column if not exists no_need boolean not null default false;`
   - On PG 17 this is metadata-only: a constant default, no rewrite, and a brief AccessExclusive lock.
   - Every existing row reads `false` (AC-1).
2. `alter table public.eod_entries drop constraint if exists eod_entries_no_need_no_quantity_check;` then `add constraint eod_entries_no_need_no_quantity_check check (not no_need or (actual_remaining is null and actual_remaining_cases is null and actual_remaining_each is null));`
   - Drop-then-add is deterministic on re-run (the 171 idiom).
   - `no_need = false` rows are unconstrained, so legacy null-total rows stay valid (AC-2).
   - A violation raises `23514`.
   - The validation scan holds the ADD COLUMN's AccessExclusive lock until commit. `NOT VALID` + `VALIDATE` would not help, because the lock is already held in the same transaction. At expected prod size the scan is sub-second; pre-check with `select count(*) from public.eod_entries` (§9 step 2).
3. `comment on column public.eod_entries.no_need is 'Spec 172: …'`. State that it means "more than enough; not counted numerically"; that the CHECK forces the numerics to NULL; that numeric readers must treat the row as absent; and that the reorder engine treats it as suggest-0 for its `(store, date)` cycle only.
4. `create or replace function public.staff_submit_eod(...)` (§3.2).
5. `CREATE OR REPLACE FUNCTION public.report_reorder_list(...)` (§3.3).
6. `comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is '…'`. Keep the existing 102/086/061 text and prepend the spec-172 sentence. Comments are not part of `pg_get_functiondef`, so they don't affect the md5.

**No index.** `no_need` is only read through the `submission_id` join, which `idx_eod_entries_submission_id` (spec 151) already serves.

**Grants (spec 097).** The column inherits the table-level `grant … on all tables … to anon, authenticated` from `20260618000000_public_grants_explicit.sql`. Per 171 §1, no migration issues column-level grants on public tables. Both functions keep their signatures, so `create or replace` preserves their ACLs. **Do not re-emit grants.** pgTAP pins them (§10).

**Seed.** `supabase/seed.sql` inserts `eod_entries` with an explicit column list, so the default fills `false`. No seed change.

### 2. RLS impact

**No policy changes.** `eod_entries` remains store-scoped through its parent:
- `store_member_read_eod_entries` / `store_member_insert_eod_entries` (`20260504173035_per_store_rls_hardening.sql:87-105`): `auth_can_see_store(s.store_id)` via `eod_submissions`.
- `admin_update_eod_entries` (`20260514120030_eod_submissions_consistency.sql:164`).
- The cross-store trigger `eod_entries_check_store_trg` (BEFORE INSERT/UPDATE) still fires for every insert, whether from the admin PostgREST path or the SECURITY DEFINER RPC (AC-6).
- `staff_submit_eod` keeps its own `auth_can_see_store(p_store_id)` gate (`42501`).
- `report_reorder_list` stays SECURITY INVOKER behind its `auth_can_see_store` gate.

`permissive_policy_lint` is unaffected because no policies are added. `audit_log` (spec 170): the RPC is SECURITY DEFINER, owned by postgres, and bypasses RLS as today. The admin client audit insert keeps passing `audit_log_restrict_insert_actor_is_caller` through `auth_is_privileged()`.

### 3. API contract

#### 3.1 Admin write (PostgREST, existing path), `src/lib/db.ts` `submitEODCount` (L968-1093)

- **Insert payload (L1009-1018).** Every row carries all four keys:
  ```
  actual_remaining:       e.noNeed ? null : e.actualRemaining,
  actual_remaining_cases: e.noNeed ? null : (e.actualRemainingCases ?? null),
  actual_remaining_each:  e.noNeed ? null : (e.actualRemainingEach ?? null),
  no_need:                e.noNeed === true,
  ```
  `no_need` must be sent on **every** row, never omitted for false. supabase-js bulk `insert` defaults to `defaultToNull: true`, so a key present on some rows and missing on others is sent as NULL for the missing rows. That would violate `NOT NULL` (`23502`) on a mixed NO NEED + numeric submission. The null-forcing on the numerics is defense in depth, so the admin path can never trip the CHECK.
- **On-hand loop (L1068-1088).** Add `if (entry.noNeed) continue;` as the first statement, before the membership check (AC-22). The `item_vendors` prefetch stays unconditional, which is the minimal hunk.
- **Errors.** Unchanged. Parent, entry, and prefetch failures throw; the per-item update only warns.

#### 3.2 Staff RPC: verbatim recreate of `public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)`

- **Latest owner:** `20260630000200_staff_submit_eod_multi_vendor.sql:56-247`. I grepped every migration. `20260630000400` only drops the stale 6-arg overload, and `20261022000000` only mentions it in a comment. Nothing later redefines it.
- **Copy the body byte-for-byte**, comments included (the md5 trap in project memory), with exactly these hunks:

| Hunk | Site (in the 20260630000200 body) | Change |
|---|---|---|
| S1 | recordset column list, L165-172 | Add `no_need boolean` after `notes text`. Absent key → NULL. |
| S2 | `insert into public.eod_entries`, L179-185 | Add the column `no_need` with value `coalesce(v_entry.no_need, false)`. A NO NEED element with any non-null numeric fails the CHECK → `23514`, and the whole call rolls back, parent upsert included (AC-5). |
| S3 | on-hand `update public.inventory_items`, L203-210 | Append `and not coalesce(v_entry.no_need, false)` to the WHERE. The UPDATE matches no row, so `current_stock`, `eod_remaining`, and `updated_at` are untouched (AC-3 b/c). |
| S4 | audit `value` expression, L229 | Becomes `case when coalesce(v_entry.no_need, false) then 'NO NEED' else v_entry.actual_remaining::text \|\| ' ' \|\| coalesce(v_entry.unit, ci.unit, '') end` (AC-3d). The else-branch is the old expression verbatim (AC-4). |
| S5 | `v_stock_updates` append, L234-237 | Wrap in `if not coalesce(v_entry.no_need, false) then … end if;` (AC-3e). Off-vendor numeric entries keep appearing, as today. |

- **Request shape.** `p_entries` elements are `{ ingredient_id, actual_remaining, actual_remaining_cases, actual_remaining_each, unit?, notes?, no_need? }`. A NO NEED element is `{ ingredient_id, actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null, no_need: true }`. Omitting the null numerics is equivalent.
- **Response shape.** Unchanged: `{ submission_id, conflict, entry_ids, stock_updates }`. NO NEED items are absent from `stock_updates`.
- **Errors.**
  - Unchanged: `22023` (no vendor), `42501` (not a store member), and the idempotent replay `conflict: true`.
  - New: `23514` when a NO NEED element carries a quantity.
  - The staff hook maps `23514` to its "other error" branch. Online, that is a `failed` toast. During a drain, it bumps `attempts`. The client never builds that shape (§6.3 validator), so this is defense only.
- **Signature and posture.** Byte-identical signature. SECURITY DEFINER and `set search_path = public` preserved. The GRANT to `authenticated` and REVOKE from public/anon/service_role survive `create or replace`.

#### 3.3 Reorder: verbatim recreate of `public.report_reorder_list(uuid, jsonb)`

- **Latest owner:** `20260726000000_reorder_drop_inbound_term.sql:42-681` (spec 138). Grep confirms nothing later redefines it. `20260803000000` and `20260801000200` only reference it in comments.
- Copy the `CREATE OR REPLACE FUNCTION … $function$` block **verbatim** (its `pg_get_functiondef` style, comments included).
- **Do not touch `report_reorder_for_counted_onhand`.** `po_loop.test.sql`'s parity is a behavioral pending-PO assertion, not a text diff, and this change does not touch `(4g)`.

| Hunk | Site | Change |
|---|---|---|
| R1 | after `latest_eod_per_vendor` (L170-178) | New CTE `-- (4e2) SPEC 172 …` `no_need_items as (select distinct e.item_id from latest_eod_per_vendor lev join public.eod_entries e on e.submission_id = lev.submission_id where e.no_need)`. It reuses 4e's `(store, as_of_date, 'submitted')` filter, which makes it cycle-scoped (AC-11) and drafts-excluded (AC-13). |
| R2 | `item_on_hand` (L203-241) | (a) Add `left join no_need_items nn on nn.item_id = ii.id` after the `eod_entries` join. `distinct` means no fan-out.<br>(b) `item_on_hand_source` gains a middle arm: `when lev.submission_id is not null and nn.item_id is not null then 'eod'::text` (AC-10, D7).<br>(c) New output column: `(nn.item_id is not null and not (lev.submission_id is not null and e.actual_remaining is not null)) as no_need_for_item`. Case A wins, per OQ-2 / AC-12.<br>(d) `eod_missing_for_item` gains `and nn.item_id is null`. When there is no NO NEED this is byte-identical.<br>`on_hand` is **unchanged**: a non-case-A row already resolves to `coalesce(current_stock, 0)` (AC-8, never fabricated). |
| R3 | `per_item` (L413-448) | (a) Select `ioh.no_need_for_item,` so it rides `pi.*` / `pis.*`.<br>(b) Wrap both `greatest(…)::numeric` expressions as `case when ioh.no_need_for_item then 0::numeric else <existing expression verbatim> end`, aliased `par_replacement` and `usage_forecasted`.<br>Downstream, with no further edits: `suggested_qty = 0`, `suggested_cases = ceil(0/case_qty) = 0` (case items) or NULL, `estimated_cost = 0`, `suggested_units = 0`, `needs_order = false`. With `include_stocked` false, the row fails `suggested_qty >= 0.001`, so it is hidden and contributes nothing to KPIs or a vendor card (AC-9). |
| R4 | `per_item_filtered` flags (L485-498) | Insert `\|\| case when pis.no_need_for_item then jsonb_build_array('no_need') else '[]'::jsonb end` immediately after the `eod_missing_for_item` term, before `truncated`. The flag vocabulary grows by one token. Envelope keys are unchanged (AC-14). |

**Semantics check against the ACs:**

| Case | Result |
|---|---|
| X NO NEED on V's own submitted submission | Not case A, so the override applies. Source `'eod'`; flags have `no_need` and not `eod_missing_for_item`; suggest 0. AC-8 / AC-10 hold. |
| V1 marks X NO NEED; V2 submitted without X | V2's row was case B. With the override, source is `'eod'` and the flag is `no_need` (AC-12). |
| V1 marks X NO NEED; V2 did not submit | V2's row was case C. With the override, source stays `'stock'` (D7) and the flag is `no_need` with suggest 0 (AC-12). |
| V1 marks X NO NEED; V2 has its own numeric entry for X | V2's row is case A, unchanged (OQ-2). |
| `as_of_date + 1` with no submission | No `nn` row, so normal case-C math applies (AC-11). |
| X's only NO NEED entry is on a **draft** | Not in 4e, so there is no override (AC-13). |

**Performance.** `no_need_items` scans `eod_entries` via `idx_eod_entries_submission_id` for at most one submission per vendor for one day, which is tens of rows. That is negligible next to the recipe walk. The extra `left join` is a hash on `item_id`. There is no measurable change on the seed or in prod.

#### 3.4 Admin reads (PostgREST, existing embeds)

`fetchTodaysEODForStores` (select L1115, map L1137-1151), `fetchRecentEODSubmissions` (L1166 / L1186-1200), and `fetchEodSubmissionsForStores` (L1229 / L1251-1265) each get the same two edits:
- Add `no_need` to the `eod_entries(...)` column list.
- Per entry:
  ```
  actualRemaining: e.no_need === true ? null : (Number(e.actual_remaining) || 0),
  ...(e.no_need === true ? { noNeed: true } : {}),
  ```
  The other keys are unchanged. `actual_remaining_cases` / `_each` are null in the DB for NO NEED rows, so they map to `undefined` as today.

`itemCount` stays `eod_entries.length`, which includes NO NEED (AC-21 parity with the client). Deduplicating the three mappers is project-memory cleanup backlog. It is **not** done here (scope); the same two-line edit goes in all three, and §10 pins all three.

#### 3.5 Staff reads, `fetchExistingSubmission` in `src/screens/staff/screens/EODCount.tsx` (L215-265)

- The select adds `no_need` to `eod_entries(...)`.
- `EntryRow` gains `no_need: boolean | null`.
- Map with `actual_remaining: e.no_need ? null : (e.actual_remaining == null ? 0 : Number(e.actual_remaining))` plus `...(e.no_need ? { no_need: true as const } : {})`. Non-NO-NEED rows are unchanged.

### 4. Edge functions

None. `staff-eod-submit` is a permanent HTTP 410 stub, and no function reads `eod_entries` (grepped `supabase/functions/`).

### 5. Shared pure helper: `src/lib/eodNoNeed.ts` (new, D8)

The module is dependency-free: no React, store, or supabase. It has runtime imports from `./eodCountMode` and type-only imports from `../types`. Exact surface:

```ts
export const EOD_NO_NEED_AUDIT_VALUE = 'NO NEED';      // N6 stored English literal; the SQL RPC hardcodes the same
export const REORDER_FLAG_NO_NEED = 'no_need';         // reorder flag token (R4)

/** AC-16 counted: noNeed || eodHasEntry(mode, caseRaw, unitRaw). */
export function eodRowCounted(noNeed: boolean | undefined, mode: EodCountMode,
  caseRaw: string | undefined, unitRaw: string | undefined): boolean;

/** AC-16 entry values. NO NEED wins over any stale typed value; else 171's eodEntryValues verbatim (null when uncounted). */
export type EodRowEntryValues =
  | { noNeed: true;  total: null;   cases: null;          units: null }
  | { noNeed: false; total: number; cases: number | null; units: number | null };
export function eodRowEntryValues(noNeed: boolean | undefined, mode: EodCountMode,
  caseQty: number | null | undefined, caseRaw: string | undefined, unitRaw: string | undefined): EodRowEntryValues | null;

/** AC-16 transitions over one row's local state. Invariant maintained by all three: noNeed ⇒ caseRaw === '' && unitRaw === ''. */
export interface EodRowState { caseRaw: string; unitRaw: string; noNeed: boolean }
export function eodToggleNoNeed(row: EodRowState): EodRowState;  // row button: on→off or off→on; boxes always cleared (both maps, AC-35)
export function eodSetNoNeed(row: EodRowState): EodRowState;     // sheet button: always { '', '', true } (idempotent)
export function eodTypeInto(row: EodRowState, field: 'cases' | 'units', text: string): EodRowState; // any keystroke/key → { ...row, [field]: text, noNeed: false }

/** AC-27 numeric guards. */
export type NumericEODEntry = EODEntry & { actualRemaining: number };
export function isNumericEodEntry(e: EODEntry): e is NumericEODEntry;   // e.noNeed !== true && typeof e.actualRemaining === 'number'
export type NumericEODSubmission = Omit<EODSubmission, 'entries'> & { entries: NumericEODEntry[] };
/** Returns the SAME object for a submission with no NO NEED entry (no allocation; identity-stable for memos). */
export function numericEodSubmissions(subs: ReadonlyArray<EODSubmission>): NumericEODSubmission[];
```

- **Keypad semantics (AC-16, AC-29).** Every keypad key clears NO NEED: the caller computes `appendKeypadDigit(current, key)` and then `eodTypeInto`. That includes backspace, which leaves the row uncounted with blank wells.
- **Clearing both maps on set (AC-35).** This is allowed by 171 AC-16 ("clearing the stale value … is allowed"). It also guarantees that a stale disabled-box value can never coexist with, or un-set, NO NEED.
- **Staff barrel** `src/screens/staff/lib/eodNoNeed.ts`: a re-export, plus an identity test in the 171 `eodCountMode` barrel idiom.

### 6. Type and `src/lib/db.ts` surface

#### 6.1 `src/types/index.ts`, `EODEntry` (L374-389)

```ts
actualRemaining: number | null;   // spec 172: null iff noNeed (DB CHECK). Numeric consumers MUST use isNumericEodEntry / numericEodSubmissions.
noNeed?: boolean;                 // spec 172: "more than enough", no quantity. Absent on numeric entries.
```

`EODSubmission` is unchanged.

**Compile fallout, which is the audit (all backend-owned, §12):**
- `cmdSelectors.ts`, at L35, L368-378, L481-488, L538-557, and L643-650;
- `usageCalculations.ts`, at L163 and L236-268;
- `ReconciliationSection.tsx`, at L288 and L376;
- `useStore.ts`, at L3014-3015 and L3029.

**Sites that compile but must still change** (TS cannot see them):
- `db.ts` L1013 and L1077-1078 (untyped PostgREST payloads);
- `useStore.ts` L3057 (template literal);
- the `entries.length` proxies at `cmdSelectors.ts` L661 and L1029;
- `ReconciliationSection.tsx` L156.

**Already safe, so leave them:**
- `EODCountSection.tsx` `unitsDisplayFor` (L135, nullable-typed);
- the VarianceLog sum (~L2049, `if (e.actualRemaining == null) continue`);
- the counted-set consumers `DashboardSection.tsx:457` and `eodStatus.ts:43`, where NO NEED *should* count as counted.

`DashboardSection.tsx:1278`'s cosmetic `% 5 + 30` proxy is left untouched (§11 OQ-D).

#### 6.2 `src/lib/db.ts`

- `submitEODCount`: §3.1.
- The three mappers: §3.4.
- Mapping: `no_need` ↔ `noNeed`, conditional, true only.
- No new exported helper. The admin keeps calling `submitEODCount` / `fetch*` exactly as today.

#### 6.3 Staff data contract

- **`src/screens/staff/lib/types.ts` `EodEntry` (L84-89):**
  - `actual_remaining: number | null;`
  - add `no_need?: boolean;`
  - Doc rule: `no_need === true` ⇒ all three numerics null. It is absent on numeric entries.
- **`src/screens/staff/lib/eodQueue.ts` `isValidEodEntry` (L49-58):** accept exactly two shapes.
  - Numeric (today's, unchanged): `item_id` string, `actual_remaining` number, splits number|null, `no_need` absent or `false`.
  - NO NEED: `item_id` string, `no_need === true`, and all three numerics `=== null`.
  - Reject `no_need: true` with any number (it would only ever fail the server CHECK and poison the queue).
  - **No queue-key bump.** v2 is extended compatibly, so every previously valid payload stays valid (AC-34). An older bundle hydrating a NO NEED entry rejects it as malformed. That is protective: an old `entriesForRpc` would strip `no_need` and the RPC would write `current_stock = NULL`.
- **`src/screens/staff/hooks/useEodSubmit.ts` `entriesForRpc` (L70-86):**
  - Widen the return type: `actual_remaining: number | null`, `no_need?: true`.
  - Emit `...(e.no_need === true ? { no_need: true } : {})`. Numeric payloads stay byte-identical, so existing hook tests are unchanged.
  - The queued item carries `entries` verbatim, so the drain sends `no_need: true` (AC-34).

### 7. Realtime impact

- **Publication: no change.** `eod_entries` is not in `supabase_realtime` (`20260514140000_realtime_publication_tighten.sql:46` lists `eod_submissions`, not entries). `eod_submissions` gains no column.
  - **The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.** State this in the migration header so nobody runs it reflexively.
- **Channel:** `store-{id}`, through the existing `eod_submissions` subscription (`useRealtimeSync.ts:48`).
  - Every NO NEED submit, admin (`upsert` parent) or staff (RPC parent upsert), writes the parent row, so other admin clients reload within the 400 ms debounce and re-map `noNeed`.
  - A NO NEED-only submit does not touch `inventory_items`, so no `inventory_items` event fires for those items. That is correct, because on-hand did not change.
- **Staff:** no realtime (spec 062), unchanged.

### 8. Frontend store impact: `src/store/useStore.ts` `submitEOD` (L2943-3078)

- **On-hand loop (L2979-3033).**
  - Compute `const numeric = isNumericEodEntry(entry)`.
  - The `currentStock` / `eodRemaining` mirror and `db.adjustItemStock(...)` run only when `numeric && itemMatchesSubmittedVendor` (AC-23).
  - This is the third copy of the predicate (spec 102 "third copy" warning, L2984). All three writers now skip NO NEED: the `db.ts` loop, RPC S3, and this one.
- **Audit (L3047-3058).** `value: entry.noNeed ? EOD_NO_NEED_AUDIT_VALUE : \`${entry.actualRemaining} ${entry.unit}\``. The audit row still fires for every entry.
- **Merge path (L2958-2972).** Unchanged. NO NEED entries merge by `itemId` like any entry.
- **Optimistic-then-revert.** Unchanged and pre-existing: `submitEOD` is optimistic with no revert, and `EODCountSection` toasts `cloudFailed` on a `submitEODCount` failure. NO NEED inherits that. No `notifyBackendError` change.
- There is no new slice and no new action. Admin per-vendor NO NEED state is **section-local** React state (N5), like the case and unit maps.

### 9. Deploy and dev order (D9)

1. **Gate:** spec 171 is committed (its frontend half is in progress now) and its migration `20261023000000` is applied to prod and recorded. Do not start the 172 build before then.
2. **Local:**
   - Run `npx supabase db reset` (or `migration up --local`).
   - Run `npm run test:db`, `npx jest`, `npm run typecheck`, `npm run typecheck:test`, and `bash scripts/smoke-staff-eod.sh`.
   - No realtime restart is needed (§7).
3. **Prod pre-check (read-only, MCP, project `ebwnovzzkwhsdxkpyjka`), before any apply.**
   - (a) `select version from supabase_migrations.schema_migrations where version in ('20261023000000','20261024000000');` must return only the 171 version.
   - (b) `select column_name from information_schema.columns where table_schema='public' and table_name='eod_entries' and column_name='no_need';` must return 0 rows.
   - (c) `select count(*) from public.eod_entries;` estimates the CHECK scan.
   - (d) The **normalized md5** of both live bodies:
     ```sql
     select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
       'public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)'::regprocedure),
       '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
     select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(
       'public.report_reorder_list(uuid,jsonb)'::regprocedure),
       '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
     ```
     Run the same two queries locally against the **pre-172** state, i.e. before applying `20261024000000` (`docker exec supabase_db_imr-inventory psql -At -c …`).
     - **Equal** means prod matches the repo's latest owners (`20260630000200` / `20260726000000`), so proceed.
     - **Different** means **STOP**. Prod has undeclared drift, and the recreate would clobber it. Surface this to the owner.
4. **Prod apply (owner-approved, MCP `execute_sql`).**
   - Execute the migration SQL. Prefer the exact pgTAP-tested bodies dumped from local with `pg_get_functiondef`, per project memory.
   - Then `insert into supabase_migrations.schema_migrations (version, name) values ('20261024000000','eod_entries_no_need') on conflict (version) do nothing;`. **Do not** use `apply_migration`, because it mints its own timestamp.
5. **Prod post-verify.**
   - Normalized md5 of both functions equals the local post-172 values.
   - `\d public.eod_entries` shows the column and constraint.
   - `has_function_privilege('anon', …, 'execute')` is false and `('authenticated', …)` is true for both.
   - If the admin insert returns `PGRST204` (unknown column `no_need`), run `notify pgrst, 'reload schema';` once.
6. **Then** commit and push to `main`. Afterwards check `test.yml` **and** `db-migrations-applied.yml`, and `e2e.yml` manually per project memory. Push-before-apply races the drift gate (project memory), so do not push first.
7. **Rollback posture.** Roll back the client first, never the DB first.
   - Once NO NEED rows or queued NO NEED entries exist, dropping the column or reverting the RPC is lossy.
   - Reverting the RPC body alone while new clients run would write `current_stock = NULL`.
   - Treat this as roll-forward only. A DB rollback (restore the two prior bodies verbatim, drop the constraint and column) is a deliberate owner action, taken after client rollback and with queues confirmed drained.

### 10. Tests required (beyond the ACs' own lists)

**pgTAP, `supabase/tests/eod_no_need.test.sql`** (new):
- AC-1 to AC-15.
- Plus:
  - (i) exactly one `pg_proc` row each for `staff_submit_eod` and `report_reorder_list` (no overload);
  - (ii) `prosecdef` stays true for `staff_submit_eod` and false for `report_reorder_list`;
  - (iii) `has_function_privilege` for anon (false) and authenticated (true) on both;
  - (iv) AC-12 covers **both** V2 variants: submitted-without-X, where the row source is `'eod'`, and not-submitted, where the row source is `'stock'` and the vendor `on_hand_source` is `'stock'` (D7);
  - (v) OQ-2 precedence: V2's own numeric entry gives case A and no `no_need` flag;
  - (vi) the CHECK admits a legacy `no_need=false` row with all numerics NULL.
- Set up the staff principal as `staff_role_eod_rls.test.sql:121-130` does, and the admin principal as existing EOD suites do.
- **AC-6:** `throws_ok` without pinning the SQLSTATE, or pin whatever `staff_role_eod_rls` already pins for a non-member. The BEFORE trigger and the RLS WITH CHECK can race for which raises first.
- **AC-15:** compare `report_run_variance` output with and without the NO NEED row. If the payload carries a run timestamp, compare the line/KPI sub-objects.

**Jest, backend:**
- `src/lib/eodNoNeed.test.ts`: the AC-16 matrix under all three 171 modes, plus the guards. Assert that `numericEodSubmissions` returns the same reference when there is no NO NEED entry.
- `src/lib/db.eodNoNeed.test.ts`, mirroring `db.eodCountMode.test.ts`:
  - all three mappers, with and without `no_need`. A non-NO-NEED entry has **no** `noNeed` key, and its `actualRemaining` is unchanged;
  - the insert payload has `no_need` on every row of a mixed batch;
  - no `inventory_items` update for NO NEED.
- A `useStore.submitEOD` NO NEED arm: no mirror, no `adjustItemStock`, and audit `'NO NEED'` (AC-23).
- AC-27 behavioral pairs, with and without one NO NEED entry, over:
  - `getStockSeries`, `computeVarianceLines`, `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp`, and `computeStoreFoodCostSeries`;
  - `buildReconciliationLines`;
  - `ReconciliationSection`'s byCategory and timeline tabs (render pair: identical text).
- A new `eodQueue.test.ts` describe block (the existing arms are untouched) and a `useEodSubmit` arm: `p_entries` carries `no_need: true`, and a numeric payload is byte-identical.

**Shell smoke, `scripts/smoke-staff-eod.sh`:** one NO NEED arm.
- Read the item's `current_stock`.
- Call the RPC with a fresh uuid and `[{ingredient_id, no_need: true}]`.
- Assert HTTP 200, `current_stock` unchanged, and `stock_updates` empty.

**typecheck:test:** widening `actualRemaining` can surface test-only arithmetic on fixtures. Fix those with a type-level narrowing in the fixture, never by changing an assertion (AC-40).

### 11. Risks, tradeoffs, and open questions (non-blocking; default = as designed)

- **R1. Deploy order is load-bearing.** A new client against the old DB:
  - fails the three admin read mappers on `no_need`, which return `[]` and blank the EOD views;
  - fails the admin insert;
  - writes `current_stock = NULL` through the old RPC for a staff NO NEED entry.

  §9 enforces DB-first. An old client against the new DB is harmless.
- **R2. Recreating two live RPCs.** Guarded by the §9 step-3 md5 pre-check, the verbatim-copy discipline, the existing suites (`staff_submit_eod_cases_each`, `staff_role_eod_rls`, `eod_submissions_multi_vendor`, every `report_reorder_list_*`, `reorder_list_has_po`, `po_loop`, `eod_count_mode`), and the §10 overload/posture/grant pins.
- **R3. Lock on `eod_entries`.** The ADD COLUMN is metadata-only, but the CHECK scan runs under AccessExclusive until commit. `lock_timeout` makes it fail fast rather than stall staff submits. Apply off-peak (not during closing hours).
- **R4. Stale on-hand.** NO NEED never updates `current_stock` (accepted in the spec). Related pre-existing approximation: `eod_vendor_has_below_par` (spec 149 `order_ready`) reads pre-count `current_stock`. It can therefore emit an "order ready" notification for a vendor whose only below-par items were marked NO NEED. The existing backstop applies (empty order state on the Approve screen). Accepted; not changed.
- **R5. Duplicate rows per (submission, item).** `eod_entries` has no uniqueness (spec 151 note). A NO NEED row and a numeric row for the same item in one submission are impossible from either client, because the state is mutually exclusive per tab. A hand-crafted PostgREST insert could do it and would fan out in `item_on_hand` exactly as duplicates do today. Not addressed; that is the same follow-up as spec 151's.
- **R6. Performance.** All negligible: one boolean column, one tiny CTE, and the O(entries) strip with identity reuse.
- **R7. Edge cold-start:** N/A.
- **OQ-A (D7, flag for the owner).** AC-10's first sentence ("the item-level source is 'eod'") is narrowed to rows whose own vendor submitted this cycle. A cross-vendor NO NEED row on a vendor that has not submitted keeps `'stock'`, so its card still shows STOCK FALLBACK (with a null `eod_submitted_at`). Every AC-10 vendor-level assertion and every AC-12 assertion holds as written. If the owner wants `'eod'` there too, R2(b) becomes `when nn.item_id is not null then 'eod'`, a one-line change.
- **OQ-B (follow-up).** Admin phone ordering (`PhoneOrdering.tsx`) and the reorder CSV/PDF exports (`reorderExport.ts`, `reorderExportStaff.ts`) still print the stale on-hand figure for a NO NEED row. AC-38 names only the staff `Reorder.tsx` and admin `ReorderSection` rows. The `no_need` flag is in the payload, so a follow-up is display-only.
- **OQ-C (accepted).** NO NEED rows keep any `no_par` / `no_usage_rate` flags alongside `no_need`. The admin row shows several chips.
- **OQ-D (accepted).** `DashboardSection.tsx:1278`'s placeholder food-cost proxy (`entries.length % 5 + 30`) counts NO NEED entries. The selector twins at `cmdSelectors.ts:661` / `:1029` are stripped (AC-27), so the two cosmetic proxies can differ by a point on a NO NEED day. Not worth a fourth file.

### 12. Frontend surface rules

**Admin desktop, `src/screens/cmd/sections/EODCountSection.tsx`**
- **State (N5).** Add `noNeedByVendor: Record<vendorId, Record<itemId, boolean>>` beside L209-211, plus the per-vendor accessor and a setter mirroring L227-241.
  - Clear it for the vendor on successful submit, next to L886-888.
  - Draft save does not clear it.
- **`deriveCountedItemIds` (L91-125), AC-17.** Add an optional `noNeedByVendor?` arg. Arm (c): any `true` in any vendor's map counts the item. Arm (b) is unchanged. Omitting the arg gives today's output.
- **Predicates.**
  - `localHasEntry(id)` becomes `eodRowCounted(noNeed[id], liveModeById(id), caseCounts[id], unitCounts[id])`. This is the counted predicate for the gate, `buildSubmission`, and phone.
  - Add `localHasCount(id) = eodHasEntry(...)` (numeric-only) and use it for `estValue` / `variance` (L650-659, AC-24).
  - `hasEntry` is unchanged in form.
- **`buildSubmission` (L752-804).**
  - Values come from `eodRowEntryValues`. A NO NEED item maps to `{ actualRemaining: null, actualRemainingCases: undefined, actualRemainingEach: undefined, noNeed: true }`, and notes are preserved (AC-21).
  - A numeric item keeps 171's mapping verbatim. Do not add a `noNeed` key there.
- **Typing (AC-19).** The case and unit `onChangeText` handlers (L990, L1021) apply `eodTypeInto`: set the text and delete that item's NO NEED.
- **Control (AC-18/20).**
  - `testID="eod-noneed-<id>"`, placed between the UNITS cell and the note.
  - Label from `section.eod.noNeed`. It shows an active style when set.
  - `disabled={inputsDisabled}`.
  - Locked: active iff `submittedEntry?.noNeed`.
  - Tapping applies `eodToggleNoNeed`, which clears both maps.
- **The row needs no other change.** `rowUncounted` and the danger border already key on `hasEntry`. The `· total` suffix already needs a non-blank box (AC-18c).
- **EDIT prefill (L508-549, AC-25).**
  - Seed `noNeedByVendor[vid]` from `sub.entries.filter(e => e.noNeed)`, with the same "user-typed wins" rule: skip an item whose local case/unit text is non-blank, which keeps the invariant.
  - `unitsDisplayFor` already returns `''` for a NO NEED entry (`actualRemaining` null), so no `"0"` is seeded.
- **Export (AC-39).** In `buildExportGroups` (L673-693), add `noNeed: !!noNeedByVendor[v.id]?.[i.id]` to each item.

**Admin phone, `eod/PhoneEodCount.tsx` + `eod/PhoneKeypadSheet.tsx`**
- **`PhoneEodModel` (L40-81)** gains **optional** fields, so existing model fixtures compile:
  - `noNeed?: Record<string, boolean>`
  - `toggleNoNeed?: (id: string) => void`
  - `setNoNeed?: (id: string) => void` (set-only, for the sheet)
  - `clearNoNeed?: (id: string) => void`

  The parent passes all of them.
- **`onKey` (L131-139).** Call `model.clearNoNeed?.(id)` before writing the digit (AC-29).
- **`CountRow`.**
  - Render `eod-noneed-<id>` when unlocked. Tapping calls `toggleNoNeed` and does not open the sheet (AC-28).
  - When locked, render it only if `submittedEntry?.noNeed`, as active and disabled (AC-30).
  - The meta suffix L596 shows the NO NEED label instead of `· {total} {unit}` when NO NEED.
- **Sheet button `eod-sheet-noneed` (OQ-5).**
  - Call `setNoNeed(id)`, then advance with `advanceUncounted(ordered, idx, i => i.id === id || model.hasEntry(i.id))`. The just-marked id **must** be in the predicate, because state is not committed yet and the wraparound would otherwise re-seat the same item.
  - When the result is null, close the sheet and show the same `allCounted` toast as `onNext`'s done path.
- **`PhoneKeypadSheet`.** Add optional props `noNeed?: boolean` and `onNoNeed?: () => void`. The button renders iff `onNoNeed` is set. While `noNeed` is set, the running-total line (L226-228) shows the localized label.

**Staff, `EODCount.tsx` + `eod/StaffEodCountRow.tsx` + `eod/StaffKeypadSheet.tsx`**
- **State.** Add `noNeed: Record<string, boolean>` beside L338-339. Reset it wherever `setCaseCounts({}) / setUnitCounts({})` run (L593-597, L624-627).
- **`seedFromExisting` (L466-487)** also seeds `noNeed` from `e.no_need`. The existing units fallback already yields no seed for a NO NEED row, because `actual_remaining` is null (AC-33).
- **Predicates.**
  - `isCounted` (L396-399) and `isBlank` (L728) use `eodRowCounted`.
  - The entry builder (L760-771) uses `eodRowEntryValues`. NO NEED gives the §6.3 NO NEED shape; numeric entries are unchanged (AC-32).
  - `sheetTotal` is unchanged numerically; the sheet shows the label instead.
- **`onKey` (L429-440)** clears NO NEED for the seated item.
- **Sheet NO NEED** behaves the same as on admin phone, including the just-marked-id advance predicate.
- **`StaffEodCountRow`.** Add optional props `noNeed?: boolean` and `onToggleNoNeed?: (item: EodItem) => void`.
  - The control `eod-noneed-<id>` renders when `onToggleNoNeed` is set and either not locked, or locked with `noNeed` (then it is disabled and active).
  - The total line (L145-152) is suppressed when `noNeed`.
- **`StaffKeypadSheet`.** Add optional `noNeed?` and `onNoNeed?`, mirroring the admin sheet, with `eod-sheet-noneed`. `eod-sheet-total` shows the label.
- The synthesized `existing` after submit (L810-814, L864-868) already carries the `no_need: true` entries, and the inputs are retained, so the locked view shows NO NEED (AC-33).

**Reorder display**
- `ReorderSection.tsx` `FlagChip` (L229-236): add `no_need: { label: 'NO NEED', tone: 'fg3' }`. This uses the existing hardcoded-English chip convention (AC-36).
- `BreakdownLine` (L154-181): when `item.flags.includes('no_need')`, replace the `on hand` segment's value with `T('section.reorder.noNeed')` (AC-38). Use the shared `REORDER_FLAG_NO_NEED` constant.
- Staff `Reorder.tsx` `inStockLabel` (L113-120): return `t('reorder.item.noNeed')` for a `no_need`-flagged row.
- `src/utils/lastOrderContext.ts` L136: `rowFellBackToStock` also returns true for `'no_need'` (AC-37).

**Count export, `src/utils/countExport.ts`**
- `CountExportItem` gains `noNeed?: boolean`.
- When true: `colCountedCases` and `colCountedUnits` return `''`, and `colCountedTotal` returns `H('noNeed', 'NO NEED')`. That gives `en` verbatim and es / zh-CN via `section.eod.export.noNeed` (AC-39).
- `inventoryCount` never sets the flag.

**i18n keys (parity tests enforce all three locales).** The frontend-developer finalizes the es / zh-CN copy. Suggested values are given below.

| Catalog | Key | en | es (suggested) | zh-CN (suggested) |
|---|---|---|---|---|
| admin | `section.eod.noNeed` | NO NEED | NO HACE FALTA | 无需 |
| admin | `section.eod.noNeedAria` | {item}: no need — more than enough | {item}: no hace falta — hay de sobra | {item}：无需——库存充足 |
| admin | `section.eod.export.noNeed` | NO NEED | NO HACE FALTA | 无需 |
| admin | `section.reorder.noNeed` | NO NEED | NO HACE FALTA | 无需 |
| staff | `eod.noNeed` | No need | No hace falta | 无需 |
| staff | `eod.noNeedAria` | {item}: no need — more than enough | {item}: no hace falta — hay de sobra | {item}：无需——库存充足 |
| staff | `reorder.item.noNeed` | No need | No hace falta | 无需 |

### 13. Build split (no file overlap)

**Precondition for both:** spec 171 is committed. Prefer dispatching **backend first**. The frontend codes against the signatures pinned in §5 and §6 and must not create or edit backend-owned files. If they run in parallel, the frontend's typecheck goes green only once the backend half lands.

**backend-developer** (data contract, the pure helper, and the numeric-consumer guards that the type widening forces):
- `supabase/migrations/20261024000000_eod_entries_no_need.sql` (new)
- `supabase/tests/eod_no_need.test.sql` (new)
- `scripts/smoke-staff-eod.sh` (NO NEED arm)
- `src/lib/eodNoNeed.ts` + `src/lib/eodNoNeed.test.ts` (new)
- `src/types/index.ts` (`EODEntry`)
- `src/lib/db.ts` (§3.1, §3.4) + `src/lib/db.eodNoNeed.test.ts` (new)
- `src/store/useStore.ts` (§8) + a new `submitEOD` NO NEED test file
- `src/lib/cmdSelectors.ts`: strip via `numericEodSubmissions` at the top of `getStockSeries`, `computeVarianceLines`, `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp`, and `computeStoreFoodCostSeries`. Add a new AC-27 test file.
- `src/utils/usageCalculations.ts`: strip in `buildReconciliationLines` and pass the stripped list to `getOpeningStock`. Add a test.
- `src/screens/cmd/sections/ReconciliationSection.tsx`:
  - `isNumericEodEntry` guard at L284 (byCategory) and L373 (timeline);
  - numeric count at L156;
  - a new render-pair test.
- `src/screens/staff/lib/types.ts` (`EodEntry`), `src/screens/staff/lib/eodQueue.ts` (validator) + a new describe in `eodQueue.test.ts`, and `src/screens/staff/hooks/useEodSubmit.ts` (`entriesForRpc`) + an arm.
- Local verification (§9 step 2) and the prod md5 pre-check (§9 step 3, read-only). The prod apply happens only on explicit owner approval.

**frontend-developer** (all UI, keypad, staff screens, display, export, and i18n):
- `src/screens/cmd/sections/EODCountSection.tsx` (including `deriveCountedItemIds`) + new `__tests__` arms
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, `eod/PhoneKeypadSheet.tsx` + tests
- `src/screens/staff/screens/EODCount.tsx` (including `fetchExistingSubmission`, §3.5), `eod/StaffEodCountRow.tsx`, `eod/StaffKeypadSheet.tsx` + tests
- `src/screens/staff/lib/eodNoNeed.ts` (barrel) + identity test (new)
- `src/screens/cmd/sections/ReorderSection.tsx` (`FlagChip`, `BreakdownLine`) + test; `src/screens/staff/screens/Reorder.tsx` + test
- `src/utils/lastOrderContext.ts` + test arm; `src/utils/countExport.ts` + test arm
- `src/i18n/{en,es,zh-CN}.json`, `src/screens/staff/i18n/{en,es,zh-CN}.json`

Whichever developer finishes last sets `Status: READY_FOR_REVIEW` and merges both file lists under `## Files changed`.

### Backend implementation notes

backend-developer, 2026-10-23. Built on `main` at `21effa6` (spec 171 committed, its migration applied to prod). Local stack only: nothing touched prod and nothing was pushed. Status stays `READY_FOR_BUILD` until the frontend half lands. All backend files are staged with `git add`; this spec file is not staged.

**Files changed (backend half, §13)**

- Migrations
  - `supabase/migrations/20261024000000_eod_entries_no_need.sql` (new): the column and CHECK, verbatim recreates of `staff_submit_eod` (hunks S1-S5) and `report_reorder_list` (hunks R1-R4), and the updated function comment.
- pgTAP
  - `supabase/tests/eod_no_need.test.sql` (new, 55 assertions): AC-1 to AC-6, AC-8 to AC-13, AC-15, plus §10 (i)-(vi) and D7.
- Shell smoke
  - `scripts/smoke-staff-eod.sh`: new step 8b, the NO NEED arm.
- Shared helper
  - `src/lib/eodNoNeed.ts` (new; exact §5 surface)
  - `src/lib/eodNoNeed.test.ts` (new)
- Types
  - `src/types/index.ts`: `EODEntry.actualRemaining: number | null`, plus `noNeed?: boolean`.
- `src/lib/db.ts`
  - §3.1: `submitEODCount` sends `no_need` on every row, forces the numerics to null for NO NEED, and adds `continue` in the on-hand loop.
  - §3.4: all three mappers select `no_need` and use the conditional `noNeed` spread.
  - Test: `src/lib/db.eodNoNeed.test.ts` (new).
- `src/store/useStore.ts` (§8)
  - `submitEOD` skips the mirror and `adjustItemStock` for non-numeric entries, and audits `'NO NEED'`.
  - Test: `src/store/useStore.submitEOD.noNeed.spec172.test.ts` (new).
- Numeric consumers (AC-27)
  - `src/lib/cmdSelectors.ts`: `numericEodSubmissions` strip at the top of `getStockSeries`, `computeVarianceLines`, `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp`, and `computeStoreFoodCostSeries`. Test: `src/lib/cmdSelectors.eodNoNeed.test.ts` (new).
  - `src/utils/usageCalculations.ts`: strip in `buildReconciliationLines`, with the stripped list passed to `getOpeningStock`. Test: `src/utils/usageCalculations.eodNoNeed.test.ts` (new).
  - `src/screens/cmd/sections/ReconciliationSection.tsx`: `isNumericEodEntry` guards on byCategory and timeline, and a numeric count for "items reconciled". Test: `src/screens/cmd/sections/__tests__/ReconciliationSection.eodNoNeed.spec172.test.tsx` (new).
- Staff data contract (§6.3)
  - `src/screens/staff/lib/types.ts`: `EodEntry`
  - `src/screens/staff/lib/eodQueue.ts`: `isValidEodEntry`, with a new describe block in `eodQueue.test.ts`
  - `src/screens/staff/hooks/useEodSubmit.ts`: `entriesForRpc`, with a new describe block in `useEodSubmit.test.ts`
  - Existing arms in both test files are unmodified.

**Verification (exact results)**

- **Migration apply.** `npx supabase migration up --local` applied `20261024000000_eod_entries_no_need.sql`. A second apply of the same file through `psql -v ON_ERROR_STOP=1` succeeded with only the expected `column "no_need" … already exists, skipping` NOTICE, and the md5 was unchanged, so the migration is re-runnable.
- **Function-body diff.** I compared `pg_get_functiondef` before and after the apply:
  - `staff_submit_eod`: only hunks S1-S5.
  - `report_reorder_list`: only hunks R1, R2(a-d), R3(a-b), and R4.
  - `report_reorder_for_counted_onhand`: byte-identical.
- **Grants after apply.** Both functions: anon has no EXECUTE and authenticated has EXECUTE. `staff_submit_eod` also has no service_role EXECUTE. Each function has exactly one `pg_proc` row, and `prosecdef` is unchanged.
- **Normalized md5 (§9 step 3 formula), local:**

  | Function | pre-172 | post-172 |
  |---|---|---|
  | `staff_submit_eod` | `c7a6f37994683f2c8317c9ee3146fc42` | `41220a3f9a7629c0b13579af3d280020` |
  | `report_reorder_list` | `15eaff54265a3adb0f1bbd9283dea5e8` | `395f8831dbcaf91edcaf3c59227821a2` |

  The pre-172 values are what prod must match before the apply.
- **pgTAP.** `npm run test:db`: **90/90 files passed**. `eod_no_need.test.sql`: **55/55**.
- **jest.** `npx jest`: **246/246 suites, 3115/3115 tests passed**. The new arms are eodNoNeed 100, db 16, cmdSelectors 11, usageCalculations 3, Reconciliation 4, submitEOD 3, eodQueue +9, and useEodSubmit +2. Every pre-existing assertion is unmodified.
- **Typechecks.** `npm run typecheck` exit 0; `npm run typecheck:test` exit 0.
- **Smoke.** `bash scripts/smoke-staff-eod.sh`: all checks passed, exit 0. Step 8b passed: 200, `stock_updates` `[]`, on-hand still 7 (not 0, not NULL), and the row is `no_need=true` with NULL numerics.
- **Mutation check.** With the ReconciliationSection guards removed, all four render-pair arms fail. The test is not vacuous.

**Notes and small deviations, for reviewers (none changes the §5/§6 contract)**

1. **pgTAP (5), AC-1 "pre-existing rows read false", is scoped to quantity-bearing rows.**
   - `supabase/seed.sql` ships no `eod_entries`, so the unscoped probe was vacuous in CI.
   - Locally, the non-transactional smoke step 8b leaves legitimate NO NEED rows behind, and those made the unscoped probe fail.
   - AC-1 is still pinned by (3) NOT NULL and (4) DEFAULT false, which make Postgres fill every pre-existing row on ADD COLUMN, plus (10), an insert that omits the column.
2. **`numericEodSubmissions` tolerates a submission with `entries` undefined.** Several consumers read `sub.entries || []` defensively, so such a submission is passed through by identity. The signature is unchanged.
3. **The smoke primes on-hand before the NO NEED call.**
   - Every item-vendor-linked Frederick item has `current_stock = 0` in the local seed, so "unchanged" would not catch a regression that writes 0.
   - Step 8b therefore first submits a numeric 7, then the NO NEED entry. Like the rest of the smoke, this leaves local residue: that item's on-hand stays at 7.
4. **AC-10 narrowing (D7) is kept as instructed.** Pinned by (42): V2 not submitted means vendor `on_hand_source = 'stock'`. Pinned by (47): V2 submitted with no entries means `'eod'`.
5. **Not done here, by instruction or ownership:**
   - the §9 step-3 **prod** md5 pre-check (local only this pass; owner or MCP step);
   - the staff barrel `src/screens/staff/lib/eodNoNeed.ts` and every UI, i18n, export, and `lastOrderContext` file (frontend-owned).
6. **Staff type widening.** Widening staff `EodEntry.actual_remaining` to `number | null` compiles cleanly against the current `EODCount.tsx`. The frontend's §3.5 / §12 edits build on it.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec (## Backend design, §13 build split — no file overlap). Do NOT start until spec 171 is committed; prefer backend first, frontend codes against the §5/§6 pinned signatures. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed. Prod apply only on explicit owner approval, after the §9 step-3 normalized-md5 pre-check passes.
payload_paths:
  - specs/172-eod-no-need.md
  - specs/171-eod-count-mode.md

### Frontend implementation notes

frontend-developer, 2026-10-23. Built on the staged backend half (§5/§6 surfaces used as pinned; no backend-owned file edited). Owner decisions OQ-1..OQ-6 implemented as recommended. Nothing committed; all files staged with `git add`.

**What landed (per §12)**

- Admin desktop (`EODCountSection.tsx`): section-local `noNeedByVendor` map (N5) beside the case/unit maps, cleared on a successful submit (not on draft). Row transitions go through `eodToggleNoNeed` / `eodSetNoNeed` / `eodTypeInto` via a small `rowStateOf` + `commitRow` pair (a map key is written only when its value changes). `localHasEntry` is `eodRowCounted`; a new numeric-only `localHasCount` feeds est. value / variance (AC-24). `buildSubmission` uses `eodRowEntryValues` and emits `{ actualRemaining: null, noNeed: true }` with the note for NO NEED; numeric entries are 171's mapping verbatim (no `noNeed` key). `deriveCountedItemIds` gains optional `noNeedByVendor` (arm c). EDIT prefill seeds NO NEED with the user-typed-wins rule. Export passes `noNeed`. The `eod-noneed-<id>` control sits between UNITS and the note (blank header spacer keeps the columns aligned); disabled with the inputs; locked state shows the submitted entry's flag.
- Admin phone (`PhoneEodCount.tsx`, `PhoneKeypadSheet.tsx`): optional `noNeed` / `toggleNoNeed` / `setNoNeed` / `clearNoNeed` on `PhoneEodModel`; row control (locked: only when the submitted entry is NO NEED, active + disabled); meta suffix shows the label instead of `· N unit`; `onKey` clears NO NEED first; sheet NO NEED marks + advances with the just-marked id in the predicate, closing with the `allCounted` toast when none remain. The sheet button renders iff `onNoNeed` is passed, so `PhoneWeeklyCount` (which does not pass it) is unchanged.
- Staff (`EODCount.tsx`, `StaffEodCountRow.tsx`, `StaffKeypadSheet.tsx`): §3.5 read (`no_need` selected; NO NEED maps to a null total plus `no_need: true`, never 0), `noNeed` state reset wherever the case/unit maps reset, seeded in `seedFromExisting`, `isCounted` / `isBlank` via `eodRowCounted`, entry builder via `eodRowEntryValues` (NO NEED shape `{ item_id, actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null, no_need: true }`), keypad clears NO NEED, sheet NO NEED with the same advance predicate. Row / sheet props are optional.
- Staff barrel `src/screens/staff/lib/eodNoNeed.ts` + identity test (171 idiom).
- Reorder display: `FlagChip` maps `no_need` → "NO NEED" (`fg3`); admin `BreakdownLine` shows `section.reorder.noNeed` in the `on hand` segment for a flagged row; staff `inStockLabel` returns `reorder.item.noNeed`; `lastOrderContext` suppresses the delta for `no_need` (AC-37).
- Count export: `CountExportItem.noNeed`; EOD-only (ignored for `inventoryCount`); blank case/unit cells and `H('noNeed', 'NO NEED')` in Counted Total.
- i18n: the seven §12 keys in all six catalogs, with the suggested es / zh-CN copy.

**Small deviations / judgment calls (none changes a §5/§6 contract)**

1. **Staff reorder breakdown line.** AC-38 says the label replaces "the on-hand figure". Besides `inStockLabel` (named in §12), the staff row also prints `on hand {onHand} · par {par}`. That figure is also replaced with the label for a `no_need` row, so no stale number shows anywhere on the row.
2. **Admin keypad sheet placement.** The NO NEED button sits full-width under the running total (above the digit pad), not in the SKIP / NEXT footer, so three footer buttons don't crowd at 390 px. The running-total `Text` gained `testID="eod-sheet-total"` (matching the staff sheet).
3. **Active tone.** Admin uses `C.ok` / `C.okBg` and staff uses `success` / `successBg` for the active NO NEED state ("have enough"). No inline colors.
4. **`lastOrderContext.ts` purity header** now lists the one new import (`REORDER_FLAG_NO_NEED` from the pure `../lib/eodNoNeed`).
5. **Tests in new files.** Every existing suite is unmodified (AC-40). New: `EODCountSection.noNeed.spec172.test.tsx` (24), `EODCount.noNeed.spec172.test.tsx` (11), `StaffNoNeed.spec172.test.tsx` (9), staff barrel `eodNoNeed.test.ts` (2), `ReorderSection.noNeed.spec172.test.tsx` (2), `Reorder.noNeed.spec172.test.tsx` (2), `lastOrderContext.noNeed.spec172.test.ts` (3), `countExport.noNeed.spec172.test.ts` (5).

**Verification (exact results)**

- `npx jest`: **254/254 suites, 3173/3173 tests** passed.
- `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0.
- **Browser (local stack, admin@local.test, Towson; Playwright scratch scripts outside the repo):**
  - Desktop 1440 px, RESTAURANT DEPOT tab: `0 of 2` → type 3 on Sweet Potato Fries (`1 of 2`) → NO NEED on it cleared the box (still `1 of 2`, OQ-1) → retyping cleared NO NEED → NO NEED on Lemon Pepper Seasoning → `2 of 2 items counted`, footer variance unaffected → SUBMIT COUNT. DB: Lemon Pepper entry `no_need = t`, numerics NULL; audit value `NO NEED`; `current_stock` stayed at the primed 2 and `updated_at` was not bumped. Locked view: Lemon Pepper shows `✓ NO NEED` (disabled), blank boxes.
  - Ordering (after a temporary Friday `order_schedule` row): Lemon Pepper is under **HAVE ENOUGH STOCK** with `NO USAGE` + `NO NEED` chips, `on hand: NO NEED`, `order: 0 cases · 0 each`, `$0.00`. Sweet Potato Fries (numeric 3, par 5) stays under Needs to Order.
  - Phone 390 px, COSTCO tab: the row NO NEED marks the row counted (`1 OF 6 COUNTED`, ✓) without opening the sheet; in the sheet a digit wrote `= 5 each total`, then NO NEED cleared it and advanced to the next uncounted item; repeated sheet NO NEED closed the sheet at `6 OF 6 COUNTED`; submit OK; the locked view shows every row as NO NEED (never 0). DB: 6/6 entries `no_need`, no `inventory_items` change.
  - No console errors and no 4xx/5xx responses in any run.
  - **Cleanup:** deleted both test submissions (entries cascade), the 8 audit rows, the 2 `notifications` + 4 `in_app_notifications` rows the submit triggers created, and the 2 temporary `order_schedule` rows. Restored the two touched `inventory_items` rows (including `updated_at`) from a pre-run snapshot. The full-table diff against the snapshot is empty. Counts are back to baseline (22 submissions / 22 entries / 26 audit rows / 0 schedule rows). The dev server is stopped.
- **Not browser-verified:** the staff EOD screen (covered end-to-end in jest), dark mode (token-only styling), and native (shared RN code, with no web-only API added).

**Pre-existing issues observed (not touched, surfaced for follow-up)**

- Desktop Ordering: on the first navigation after the EOD submit, the section rendered `0 vendors` even though `report_reorder_list` returned 200 with the vendors; pressing REFRESH showed them. Unrelated to this spec's diff (the load path is untouched).
- Desktop EOD locked view: a submitted case-pack numeric row shows `· total 0 <unit>` in its meta line, because the suffix reads the cleared local maps rather than the submitted entry. Pre-existing.
- Admin phone Ordering (`PhoneOrdering`) and the reorder CSV/PDF exports still show the stale on-hand for a NO NEED row. This is §11 OQ-B, a display-only follow-up.

## Files changed

**Backend half (backend-developer)**
- `supabase/migrations/20261024000000_eod_entries_no_need.sql` (new)
- `supabase/tests/eod_no_need.test.sql` (new)
- `scripts/smoke-staff-eod.sh`
- `src/lib/eodNoNeed.ts` (new), `src/lib/eodNoNeed.test.ts` (new)
- `src/types/index.ts`
- `src/lib/db.ts`, `src/lib/db.eodNoNeed.test.ts` (new)
- `src/store/useStore.ts`, `src/store/useStore.submitEOD.noNeed.spec172.test.ts` (new)
- `src/lib/cmdSelectors.ts`, `src/lib/cmdSelectors.eodNoNeed.test.ts` (new)
- `src/utils/usageCalculations.ts`, `src/utils/usageCalculations.eodNoNeed.test.ts` (new)
- `src/screens/cmd/sections/ReconciliationSection.tsx`, `src/screens/cmd/sections/__tests__/ReconciliationSection.eodNoNeed.spec172.test.tsx` (new)
- `src/screens/staff/lib/types.ts`
- `src/screens/staff/lib/eodQueue.ts`, `src/screens/staff/lib/eodQueue.test.ts`
- `src/screens/staff/hooks/useEodSubmit.ts`, `src/screens/staff/hooks/useEodSubmit.test.ts`

**Frontend half (frontend-developer)**
- `src/screens/cmd/sections/EODCountSection.tsx`
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx` (new)
- `src/screens/staff/screens/EODCount.tsx`
- `src/screens/staff/screens/EODCount.noNeed.spec172.test.tsx` (new)
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx`
- `src/screens/staff/screens/eod/StaffKeypadSheet.tsx`
- `src/screens/staff/screens/eod/StaffNoNeed.spec172.test.tsx` (new)
- `src/screens/staff/lib/eodNoNeed.ts` (new), `src/screens/staff/lib/eodNoNeed.test.ts` (new)
- `src/screens/cmd/sections/ReorderSection.tsx`, `src/screens/cmd/sections/__tests__/ReorderSection.noNeed.spec172.test.tsx` (new)
- `src/screens/staff/screens/Reorder.tsx`, `src/screens/staff/screens/Reorder.noNeed.spec172.test.tsx` (new)
- `src/utils/lastOrderContext.ts`, `src/utils/lastOrderContext.noNeed.spec172.test.ts` (new)
- `src/utils/countExport.ts`, `src/utils/countExport.noNeed.spec172.test.ts` (new)
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- `src/screens/staff/i18n/en.json`, `src/screens/staff/i18n/es.json`, `src/screens/staff/i18n/zh-CN.json`
- `specs/172-eod-no-need.md` (status, notes, this list)

**Review round (test-engineer)**
- `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx` (new)

**Review artifacts**
- `specs/172-eod-no-need/reviews/` (`code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, `backend-architect.md`, `release-proposal.md`)

### Review-fix round 1

backend-developer, 2026-10-23. Applies section A of `specs/172-eod-no-need/reviews/release-proposal.md`, per the owner's decision: "Yes — have the backend developer apply SF-3, SF-4 and the optional pgTAP M-1 cleanup; defer the admin/staff duplication refactor (code-review SF-1/SF-2) to a follow-up." Nothing touched in prod. Nothing committed; all files staged.

**Fixes**

1. **SF-3 (code-reviewer): one NO NEED predicate across the on-hand writers.**
   - `src/lib/db.ts` `submitEODCount` on-hand loop: `if (entry.noNeed) continue;` is now `if (!isNumericEodEntry(entry)) continue;` (new import from `./eodNoNeed`). A non-NO-NEED entry with a null total can no longer write `current_stock = NULL`, and `actualRemaining` narrows to `number` at the write site. The `eod_entries` insert payload is unchanged.
   - `src/store/useStore.ts` `submitEOD`: the on-hand mirror and `db.adjustItemStock` already keyed off `numeric = isNumericEodEntry(entry)`. The audit value now keys off the same flag: NO NEED → `'NO NEED'`; numeric → `` `${actualRemaining} ${unit}` ``; any other entry → `''`. Decision for the third case: it never reads `"null <unit>"` and is never mislabelled as NO NEED. It is the client mirror of `staff_submit_eod` hunk S4's else-branch, which yields a NULL value for a null total (`AuditEvent.value` is `string`, so `''` rather than `null`). No client builds this shape today.
   - Tests: a new arm in `src/lib/db.eodNoNeed.test.ts` (non-NO-NEED entry with `actualRemaining: null` → exactly one `inventory_items` update, for the numeric sibling only; no NULL `current_stock`; entry row still inserted with `no_need: false`). A new arm in `src/store/useStore.submitEOD.noNeed.spec172.test.ts` (same shape → no optimistic on-hand change, `adjustItemStock` only for the numeric sibling, audit value `''`, not containing "null", not "NO NEED").
   - Mutation check: reverting the `db.ts` guard to `entry.noNeed` and the audit value to the old template made exactly these two new arms fail (2 failed / 19 passed); both files restored and re-verified.
2. **SF-4 (code-reviewer): `src/screens/cmd/sections/ReconciliationSection.tsx`.** The duplicated `latest?.entries?.filter(isNumericEodEntry).length ?? 0` is hoisted into `const reconciled` (a plain const beside `largest`, above the phone early-return; not a hook). The "0 / 0, 100%" display (architect M-4) is NOT changed; it stays a follow-up.
3. **M-1 (backend-architect): pgTAP assertion (5) dropped.** It could never fail, because `eod_entries_no_need_no_quantity_check` makes its predicate unsatisfiable. `plan(55)` → `plan(54)`. The other labels keep their numbers so the spec's and reviews' references, e.g. (10) and (42), stay valid; a comment marks (5) as retired. AC-1 remains pinned by (3) NOT NULL, (4) DEFAULT false and (10) omitted-column-reads-false. This supersedes backend implementation note 1 above.

**Deferred (owner decision): code-reviewer SF-1 / SF-2.** The admin/staff duplication refactors are NOT done here and go to a follow-up spec or the cleanup backlog:
- SF-1: an `applyEodRowState` / `patchRecord` helper in `src/lib/eodNoNeed.ts` (backend), adopted by `EODCountSection.tsx` and staff `EODCount.tsx` (frontend).
- SF-2: an `advanceUncountedAfterMark` helper in `lib/eodKeypad.ts`, plus lifting the `allCounted` toast in `PhoneEodCount.tsx` (frontend).

**Verification (exact results, local)**
- `npx jest`: **255/255 suites, 3177/3177 tests passed** (was 3175; +2 new SF-3 arms). 2/2 snapshots passed.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0.
- `npm run test:db`: exit 0, **90/90 DB test files passed**; `eod_no_need.test.sql` **54/54** (was 55/55; assertion (5) removed).

**Files changed in this round**
- `src/lib/db.ts`, `src/lib/db.eodNoNeed.test.ts`
- `src/store/useStore.ts`, `src/store/useStore.submitEOD.noNeed.spec172.test.ts`
- `src/screens/cmd/sections/ReconciliationSection.tsx`
- `supabase/tests/eod_no_need.test.sql`
- `specs/172-eod-no-need.md` (this note)
