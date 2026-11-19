# Spec 201: Reorder suggests a shared item only on its primary vendor's card when its vendors coincide, and reads a shared item's count across vendors

Status: READY_FOR_REVIEW

Build note (backend-developer, 2026-11-18): the backend half is done. See `## Backend implementation notes` and `## Files changed (backend)` at the bottom. The frontend half (the useStore action, ReorderSection / PhoneOrdering / staff Reorder UI, i18n, jest AC-21 to AC-28) is in progress separately with the frontend-developer. The frontend writes its own section and file list.

Numbering: 201 was assigned by the main session on 2026-11-18. Its sibling, spec 200 ([specs/200-staff-eod-shared-item-counted-once.md](200-staff-eod-shared-item-counted-once.md)), is now on disk.

Origin:
- **Part 1 (primary wins).** The owner chose "primary vendor wins" for the double-order risk that spec 102 accepted (spec 102 OQ-1: "surface in both, accept double-order risk, mitigate with a hint").
- **Part 2 (cross-vendor count read).** This comes from the spec 200 cross-spec decision. Spec 200 **omits** untouched, pre-filled shared items from the second vendor's staff submission, so reorder must read a shared item's count from whichever vendor's submission holds it.

The owner answered all open questions on 2026-11-18 with "use recommendations" (see **Open questions resolved**).

## User story

As a store manager ordering for the day, I want a shared ingredient to appear on only one vendor's card when two of its vendors are both up for ordering today. Then I can't buy it twice, and I buy it from the vendor I normally use.

I also want an item that staff counted once, under any vendor, to read as counted on every card it appears on, not as a stock fallback with an "EOD missing" flag.

## The problem (verified in the tree, 2026-11-18)

- **Explosion.** `public.report_reorder_list` joins `inventory_items` to `public.item_vendors` in CTE `(4f) item_on_hand`, so a shared item produces **one row per linked vendor**.
  - `par_level`, `usage_per_portion` and `current_stock` are per item (spec 102 OQ-3), so every card computes the same `suggested_qty` for the item.
- **Only an advisory guard.** The only protection is the per-row hint `other_vendor_count` / `also_from_vendors`, which reads "also available from X — order from one".
  - It is emitted **unconditionally**: every other linked vendor is listed, whether or not that vendor is up today. No coincidence test exists anywhere in the RPC.
  - Admin renders it at [ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) L1084-1102 and staff at [Reorder.tsx](../src/screens/staff/screens/Reorder.tsx) L278-290.
- **How two cards end up on screen together.** The RPC returns every vendor that has suggested items. The admin, staff and phone screens then show only vendors whose `order_schedule.day_of_week` equals the weekday of the as-of date, using `partitionReorderVendors` in [reorderDayFilter.ts](../src/utils/reorderDayFilter.ts) L142-165. Vendors with `scheduleKnown = false` go to a separate, collapsed "no schedule" group.
  - So the double-order case is: **two of the item's vendors both have an order-out row for the as-of weekday**, both cards render, and both carry the item.
- **Every order-placing path is built from card items:**
  - FILL CART → `buildDraftOrderLines` → `upsertVendorDraftOrder`. These drafts feed the Chrome cart-filler extension (`get_pending_extension_orders`, specs 131/132) and BJ's auto-place (spec 162).
  - CREATE PO → `createPoDraft`.
  - Export recording → `recordExportedOrder` (specs 123/156).
  - CSV/PDF exports and the Sysco and US Foods import planners (`resolveExportBase`, [vendorImportShared.ts](../src/utils/vendorImportShared.ts) L76-90).
  - The phone Ordering and Approve Order screens.

  All of them read `reorderPayload.vendors[].items`. `applyReorderEdits` (ReorderSection L119-143) only overlays items already on a card and cannot add one. A row the RPC leaves off a card therefore cannot reach any of these paths.
- **On-hand comes only from the row's own vendor's submission.** In the live body ([20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) L447-547), `item_on_hand` joins each (item, vendor) row only to **its own vendor's** `submitted` submission for (store, as-of date). The three cases:
  - **Case A:** the vendor submitted and has a non-null `actual_remaining` for the item → that value, source `'eod'`.
  - **Case B:** the vendor submitted but has no entry, or a null one → `current_stock`, source `'stock'`, flag `eod_missing_for_item`.
  - **Case C:** the vendor didn't submit → `current_stock`, source `'stock'`.

  Under spec 200's omit decision, a shared item counted under A and left out of B's submission lands in **case B** on B's row. It also lands there on A's row when the count was made under B, which matters when A is the primary. Its number is right, because `current_stock` is the shared on-hand, but it is labelled `'stock'` and flagged as missing.

### Corrections to the brief this spec was written from

- **The latest `report_reorder_list` body** is in [20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) (spec 172, from L319). It is not `20260718000000_reorder_list_has_po.sql`; spec 138's [20260726000000_reorder_drop_inbound_term.sql](../supabase/migrations/20260726000000_reorder_drop_inbound_term.sql) also sits between them. Build from the 20261024 body verbatim, and re-glob for later replacements at build time.
- **Pending-PO netting no longer exists.** Spec 138 changed the `(4g) pending_po_qty` CTE to `where false` in both reorder engines, so `pending_po_qty` is always 0. That is why counting drafts as pending would reverse spec 138 (OQ-5).
- **Spec 102 had no coincidence condition in code.** This spec defines it (OQ-1).

## Open questions resolved

Owner, 2026-11-18: "use recommendations".

- **Primary wins, or keep surfacing on both cards?** → **Primary wins on coincident days.** This supersedes spec 102 OQ-1 for that case only.
- **OQ-1, what "same day" means** → **Same order-out day.** Two vendors are coincident when both have an `order_schedule` row at this store whose `day_of_week` is the weekday of the as-of date. A vendor with no `order_schedule` row (`scheduleKnown = false`) is **never** coincident.
- **OQ-2, the non-primary card** → **Drop the row entirely**, before totals and KPIs. If it was the vendor's only item, the card disappears.
- **OQ-3, what "switch" does** → **A permanent primary change for this store only, admin only, behind a confirm**, using spec 124's demote-first write.
  - **3b:** staff get no switch, only the "also from" text.
  - **3c:** refuse the switch if the item is already on today's order (a non-cancelled `purchase_orders` row for this store, the current primary vendor and the as-of date).
- **OQ-4, no primary among the coincident vendors** (the primary isn't due that day, or the item has no primary at all) → **unchanged.** The item shows on every coincident card with today's hint.
- **OQ-5, count same-day drafts as pending** → **No.** Spec 138 stands.
- **OQ-6, primary vendor's EOD not submitted** → **the primary still wins.** The item stays off the non-primary card. The primary's card renders spec 130's "count not submitted" state until it is counted.
- **Spec 200 cross-spec decision** → reorder treats a shared item counted under **any** vendor's `submitted` submission for (store, as-of date) as EOD-sourced (R9).
- **Does this change EOD counting?** → **No.** Spec 200 owns the staff count. This spec changes only how reorder **reads** counts.

## Requirements

### Part 1: primary wins

- **R1. Where the rule lives.** Implement it in `report_reorder_list`, so every consumer listed under "The problem" inherits it with no per-consumer filtering.
  - Signature, `security invoker`, `search_path = public` and the ACL (including the `reports_anon_revoke` posture) stay unchanged.
- **R2. The rule.** For each item at this store, find its **coincident set**: its linked vendors that have an `order_schedule` row at `p_store_id` whose `day_of_week` matches the weekday of the as-of date.
  - **Matching:** normalize case. Today the column holds capitalized English (`'Monday'`), and the RPC's existing `delivery_day` parse lowercases it.
  - **Dropping:** if the set has 2 or more members **and** includes the item's primary vendor, drop the item's row from every coincident vendor except the primary.
  - **Outside the set:** rows for linked vendors not in the coincident set are unchanged.
  - **Otherwise** (set size below 2, or no primary in the set): nothing changes (OQ-4).
  - **The primary's own EOD status doesn't matter** (OQ-6).
- **R3. Primary source of truth.** Spec 102 SD-1 makes `inventory_items.vendor_id` authoritative and `item_vendors.is_primary` its mirror. Spec 102's post-impl notes show the two have drifted before (the "dangling scalar").
  - The architect picks which one the rule reads and documents the choice.
  - A pgTAP arm pins the behaviour when they disagree.
  - Repairing drift is out of scope.
- **R4. Drop the row before rollup.** The row must be removed before `per_item_filtered` and `vendors_with_items`, so all of the following exclude it with no further edits:
  - the server `kpis` (`vendor_count`, `item_count`, `total_estimated_cost`, the source counts);
  - `vendor_total_cost`;
  - `_warnings` (built from surfaced vendors only);
  - `has_po`.

  The `include_stocked = true` path must not show the dropped row in either section.
- **R5. The primary card's hint.** On a coincident day, the primary vendor's row gains additive data naming the vendors that gave the item up. The architect names the key, for example `yielded_from_vendors: [{vendor_id, vendor_name}]`.
  - The existing `other_vendor_count` / `also_from_vendors` keep their values and meaning.
  - The new key is always present: `[]` when nothing yielded.
  - On non-coincident days every existing key and value is unchanged.
- **R6. UI.**
  - **Admin, desktop and phone:** the primary row renders "also from <vendor names> — switch".
  - **Staff:** the staff Reorder screen renders the "also from" text with **no** switch (3b). Its strings go in `src/screens/staff/i18n/` in en, es and zh-CN.
  - **Admin text:** follow the section's current convention. The existing hint is English-only "to match the byte-for-byte exports"; the architect confirms whether new admin text goes through `T()`.
  - On a primary row that has a non-empty new key, the new line replaces the old "also available from … — order from one" line, so the row doesn't carry two hints. Every other row keeps the old line exactly as today.
- **R7. The switch** (admin desktop and phone only).
  1. **Pre-check (3c).** If the item is on a non-cancelled `purchase_orders` row for (this store, the current primary vendor, the as-of date), the switch is refused with a toast telling the manager to remove it from that order first. Nothing is written.
  2. **Confirm.** Otherwise a `confirmAction` confirm names both vendors and says the change is permanent for this store.
  3. **Write.** On confirm, write through the spec 124 demote-first path in `db.ts`. This store's `inventory_items.vendor_id` becomes the new vendor, and `item_vendors.is_primary` flips to match. There is no duplicate-key error on `item_vendors_one_primary_per_item`, and no other store's rows change.
  4. **Reload.** Then reload the reorder list.
  - **Failure:** use the optimistic-then-revert + `notifyBackendError` pattern.
  - **Architect task:** list the other readers of `inventory_items.vendor_id` (for example the "supplied by" label and the cost fallback), since a switch changes them too. This is documentation only; their behaviour is unchanged.

### Part 2: reading a shared item's count across vendors (spec 200 decision)

- **R8. Borrow source.** For a given (store, as-of date), an item's **borrow source** is the `eod_entries` row with a non-null `actual_remaining` from a submission that matches all of the following:
  - `store_id = p_store_id`;
  - `date` = the as-of date;
  - `status = 'submitted'`. Drafts never count, the same filter as `latest_eod_per_vendor` and spec 200 OQ-2.
  - **Any vendor.** The submitting vendor needn't be a linked vendor of the item.

  If several qualify, the one with the **latest `submitted_at`** wins. The architect adds a deterministic tiebreak for equal timestamps, for example the submission id. The architect also confirms this source set matches spec 200's R1 borrow source byte-for-byte in meaning, so the staff screen and reorder never name different counts.
- **R9. On-hand resolution per (item, vendor) row**, in this order:
  1. **Own case A** (the row's vendor submitted, and its own entry has a non-null `actual_remaining`): unchanged. The own value, source `'eod'`. **The own entry always wins.**
  2. **Borrowed:** otherwise, if the item has a borrow source (R8):
     - `on_hand` = the borrowed `actual_remaining`;
     - the row's item source is `'eod'`;
     - `eod_missing_for_item` is **false**.

     This applies whether or not the row's own vendor submitted.
  3. **Otherwise,** today's case B or C is unchanged.
- **R10. Vendor-level fields keep their own-submission meaning.** Borrowed rows must not change these:
  - the vendor-level `on_hand_source`;
  - `eod_submitted_at`;
  - `kpis.eod_sourced_vendor_count` / `stock_fallback_vendor_count`.

  Concretely, `on_hand_source` is computed from the rows' pre-borrow (own) source, exactly as today. A vendor with no submission of its own keeps `eod_submitted_at = null` and still renders spec 130's "count not submitted" card. This matters for a vendor whose every row was borrowed under spec 200 OQ-1a and so never submitted.
- **R11. NO NEED (spec 172) is unchanged.** `no_need_items` and the `no_need_for_item` predicate stay as they are: the override applies to every row that is not **own** case A.
  - A NO NEED mark for the item under any submission therefore still zeroes a borrowed row.
  - A NO NEED entry is never a borrow source, because its `actual_remaining` is null.
- **R12. Interaction with Part 1.** R9 applies before R2's drop, so the primary row can borrow a count made under a non-primary vendor. For example, staff count X under B first, and A's (the primary's) submission omits X.

### Both parts

- **R13. Unchanged surfaces:**
  - `report_reorder_for_counted_onhand` (spec 105). It reads caller-supplied on-hand and is flat and item-keyed.
  - `report_weekly_lowstock`.
  - EOD writes and the on-hand write path (`staff_submit_eod`, `admin_submit_eod`, `eod_write_submission`).
  - `eod_vendor_has_below_par` (see Out of scope).
  - `upsertVendorDraftOrder`, `createPurchaseOrderDraft` and the extension and auto-place RPCs.

## Acceptance criteria

Fixture terms:
- **Store S; as-of date D.**
- **Item F** at S: linked to A (primary) and B; below par; `suggested_qty > 0`.
- **A and B:** both have an `order_schedule` row at S whose `day_of_week` is D's weekday ("coincident"). Each has a `submitted` EOD for D containing a numeric F entry, unless stated.
- **Item G** at S: linked to B only, below par.
- **"As before":** the value the 20261024000000 body returns for the same fixture.

### Server: primary wins (pgTAP, new suite; the architect names the file)

- [ ] **AC-1 (coincident, primary wins):** with `{as_of_date: D}`, F's row is in A's `items` and absent from B's `items`.
  - F on A has the same `suggested_qty`, `suggested_units`, `suggested_cases` and `estimated_cost` as before.
- [ ] **AC-2 (hint on primary):** on A's F row, the new key names B, and `other_vendor_count` / `also_from_vendors` are as before. On G's row the new key is `[]`.
- [ ] **AC-3 (rollups stay coherent):** B's `vendor_total_cost` equals the sum of its remaining rows' `estimated_cost`. `kpis.item_count` and `kpis.total_estimated_cost` equal the sums over the returned `vendors[].items`.
- [ ] **AC-4 (vendor left empty):** delete G. B is then absent from `vendors`, `kpis.vendor_count` drops by 1, and `_warnings` has no entry for B.
- [ ] **AC-5 (`include_stocked`):** with `{as_of_date: D, include_stocked: true}`, B has no F row in either `needs_order` state. Repeat with F at par.
- [ ] **AC-6 (not coincident):** move B's `day_of_week` to another weekday. F appears under both A and B with every key and value as before, and the new key is `[]`.
- [ ] **AC-7 (three vendors):** F is linked to A (primary), B and C.
  - All three are coincident: F is on A only.
  - A and B are coincident and C isn't: F is on A, absent from B, and C's row is as before.
- [ ] **AC-8 (OQ-4, no primary in the set):**
  - A is not coincident and B and C are: F is on B and C as before, with the new key `[]`.
  - Same result when F has no primary at all.
- [ ] **AC-9 (no-schedule vendor):** B has no `order_schedule` row. B's F row is as before.
- [ ] **AC-10 (OQ-6):** A has no submitted EOD for D and B does. F is absent from B and present on A. A's `eod_submitted_at` is null.
- [ ] **AC-11 (day-name case):** a lower-case `day_of_week` value (`'monday'`) is treated the same as `'Monday'`.
- [ ] **AC-12 (primary source, R3):** when `inventory_items.vendor_id` and `item_vendors.is_primary` disagree for F, the result follows the source the architect documented.

### Server: cross-vendor count read (pgTAP; same suite or a sibling)

Use a non-coincident fixture (B's `day_of_week` ≠ D's weekday) so that both F rows are returned, unless stated.

- [ ] **AC-13 (borrowed into a submitted vendor, spec 200's omit case):** A submitted with F = 5. B submitted with G only (no F entry).
  - B's F row: `on_hand = 5`, `'eod_missing_for_item'` is **not** in `flags`, and the per-item source is `'eod'`.
  - B's vendor-level `on_hand_source` and `eod_submitted_at` are as before (B's own submission).
- [ ] **AC-14 (borrowed into the primary, R12):** the coincident fixture. B submitted with F = 4. A submitted with other items but no F.
  - F appears on A only, with `on_hand = 4` and no `eod_missing_for_item` flag. Its `suggested_qty` uses 4.
- [ ] **AC-15 (latest wins):** a third vendor C (not linked to F) and A both submitted F, at 5 and 7, with C's `submitted_at` later. B submitted without F.
  - B's F row reads C's value.
  - Swapping the timestamps makes it read A's.
  - This also proves an unlinked vendor's submission is a source (R8).
- [ ] **AC-16 (own wins):** A submitted F = 5, and B submitted F = 3 with a later `submitted_at`. B's F row reads 3 and A's F row reads 5.
- [ ] **AC-17 (not a source):** each of the following leaves B's F row as before (case B: `current_stock`, flag present):
  - A's submission for F is `status = 'draft'`;
  - A's submission is for D − 1;
  - A's submission is for another store;
  - A's F entry is NO NEED.
- [ ] **AC-18 (vendor never submitted, R10):** B has no submission, and A submitted F = 5.
  - B's F row: `on_hand = 5`, no flag.
  - B's vendor-level `on_hand_source` is `'stock'` and `eod_submitted_at` is null.
  - `kpis.eod_sourced_vendor_count` and `stock_fallback_vendor_count` are as before.
- [ ] **AC-19 (NO NEED still overrides, R11):** A submitted F = 5. C submitted F as NO NEED. B submitted without F.
  - B's F row has `suggested_qty = 0`, `needs_order = false` and the `'no_need'` flag, as before.
  - A's own row keeps its numeric value, as before.

### Server: posture

- [ ] **AC-20:**
  - Signature, `prosecdef = false`, `proconfig` and the ACL are unchanged.
  - `reports_anon_revoke.test.sql` passes.
  - Every existing `report_reorder_list_*` suite and `eod_no_need.test.sql` pass, except arms the architect lists as pinning the replaced behaviour.
  - Known such arm: `report_reorder_list_multi_vendor.test.sql` arm (3), "shared item appears under the V2 vendor card (explosion to both)". Its fixture is coincident. The arm is **rewritten** to assert the new outcome, or its fixture is moved to a non-coincident day; it is not deleted.
  - Any arm that pins `eod_missing_for_item` on a row now covered by R9 is likewise rewritten, not deleted.
  - The `po_loop.test.sql` (P) parity arm still passes.

### Client (jest)

- [ ] **AC-21 (admin card):** given a payload where F is on A with the new key naming B and absent from B, A's row in ReorderSection renders the "also from B" line with a switch control. The old "order from one" line is not rendered on that row. B's card has no F row, and the KPI strip matches `computeReorderKpis` over the rendered cards.
- [ ] **AC-22 (phone):** PhoneOrdering renders the same line and switch for F on A.
- [ ] **AC-23 (staff):** staff Reorder renders the "also from" line with no switch. The new strings exist in en, es and zh-CN with identical tokens, and `src/screens/staff/i18n/i18n.test.ts` passes.
- [ ] **AC-24 (order paths take no F line for B):**
  - With that payload, `buildDraftOrderLines` for B, `createPoDraft` for B and `resolveExportBase` for a B import config produce no F line.
  - `buildDraftOrderLines` for A contains F.
- [ ] **AC-25 (switch, happy path):**
  1. The admin confirms the switch on A's F row.
  2. The store action writes primary = B through the spec 124 path: one `is_primary = true` link (B), this store's `inventory_items.vendor_id = B`, and no duplicate-key error.
  3. It then reloads the reorder list.
  4. Cancelling the confirm writes nothing.
- [ ] **AC-26 (switch refused, 3c):** when F is on a non-cancelled PO for (S, A, D), the switch is refused with a toast and no write or confirm happens.
- [ ] **AC-27 (switch failure):** a backend error reverts any optimistic state and calls `notifyBackendError`.
- [ ] **AC-28 (gates):** the full `npx jest`, both typecheck gates (base + `typecheck:test`) and the full pgTAP run pass.
  - Re-grep the tests for fixtures that pin the old hint text on shared items (`reorder-also-from-*` testIDs, the staff `Reorder.test.tsx`).
  - `e2e/staff-reorder.spec.ts` stays green.

No shell smoke is required. The RPC's HTTP mapping doesn't change.

## In scope

- One migration with a `create or replace` of `public.report_reorder_list` (same signature), built from the 20261024000000 body verbatim plus the hunks for R2, R4, R5, R8 to R10 and R12.
  - Sort it after the latest migration at build time (currently `20261115120000_apply_item_scalars_store_subset.sql`).
  - The header covers prod apply, rollback and the spec 200 sequencing note.
- `db.ts` mapper and `ReorderItem` type support for the new key, in both the admin mapper (`db.ts` ~L4780) and the staff mapper (`src/screens/staff/lib/fetchReorder.ts` ~L84).
- The primary-row line and switch on the admin desktop (ReorderSection) and phone (PhoneOrdering) surfaces.
- The text-only line and i18n strings on the staff Reorder screen.
- A store action for the switch, routed through `db.ts` and reusing the spec 124 demote-first write.
- New pgTAP arms for AC-1 to AC-20, the rewrites named in AC-20, and the jest arms AC-21 to AC-28.

## Out of scope (explicitly)

- **Non-coincident days for Part 1.** Behaviour is unchanged there by owner direction, including the cross-day case: A is ordered Monday and B Wednesday, and F appears on each card on its own day.
- **Counting same-day drafts as pending (OQ-5).** Spec 138 stands.
- **Any change to EOD writes, the staff count screen, or spec 200's payload rules.** This spec only changes how reorder reads counts.
- **`report_reorder_for_counted_onhand` and `report_weekly_lowstock`.**
- **`eod_vendor_has_below_par` (spec 149's "order ready" notification predicate).** It also explodes by `item_vendors`, so B's count can still fire an "order ready" ping for B because of F. It is a documented approximation, and spec 149 AC-13's empty-order state is the backstop (wrong copy, never a wrong order). Changing it would put the coincidence test on the staff submit path.
- **Rewriting or deleting draft or PO lines** created before this ships, or before a switch. 3c refuses the switch instead.
- **A tiebreak when no primary is in the coincident set (OQ-4)** and repairing `vendor_id` / `is_primary` drift (R3).
- **A "differs from {vendor}" indicator** when own and borrowed counts disagree (spec 200 out of scope too).
- **A brand-wide or multi-store switch,** or a one-off per-date override (OQ-3 b and c, not chosen).
- **A switch on the staff screen** (3b).
- **Changing the `app.json` slug.** It isn't touched.

## Dependencies

- Spec 102 (the `item_vendors` junction and SD-1 primary mirror).
- Spec 124 (the demote-first primary switch in `db.updateInventoryItem`).
- Spec 138 (inbound netting retired; the `po_loop` parity guard).
- Spec 172 (the latest RPC body and the NO NEED override).
- Spec 130 (the count-not-submitted card).
- Spec 087 (the order-out partition).
- **Spec 200 (sequencing).**
  - Spec 200's "omit" payload is only safe once this spec's R9 is live. Otherwise a vendor's reorder card shows the omitted shared item as `'stock'` with `eod_missing_for_item`.
  - **201's migration must be on prod before, or in the same release as, the spec 200 client build that omits borrowed rows** (the Vercel deploy and any EAS build).
  - The architect checks whether spec 200 adds any migration that touches `report_reorder_list` or the EOD tables. If it does, whichever spec lands second carries the other's hunks.
  - R8's borrow source must match spec 200's R1 source set in meaning.
- No library or edge-function dependency.

## Project-specific notes

- **Cmd UI section:** [src/screens/cmd/sections/ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) and phone [PhoneOrdering.tsx](../src/screens/cmd/sections/phone/PhoneOrdering.tsx). PhoneApproveOrder inherits the change through the payload. There's no legacy surface.
- **Which app:** the admin Cmd UI plus the staff Reorder screen, both in this repo (spec 063).
- **Per-store or admin-global:** per-store.
  - The RPC is gated by `auth_can_see_store(p_store_id)`, and coincidence, primary and the borrow source are all read at store grain.
  - The switch writes only this store's `inventory_items` / `item_vendors` rows under their existing RLS.
- **Edge function or PostgREST:** PostgREST RPC plus `db.ts` writes. No edge function.
- **Realtime channels touched:** the switch writes `inventory_items` and `item_vendors`, which already publish on `store-{id}` (`item_vendors` since spec 102). There's no publication change, so the restart gotcha doesn't apply.
- **Migrations needed:** yes, one (see In scope).
- **Edge functions touched:** none.
- **Web/native scope:**
  - Both. The row drop and the cross-vendor read are server-side, so every installed client (web, and native EAS builds) gets them the moment the migration is on prod. Old clients keep showing the old hint on A's row.
  - The new line and the switch arrive with the next Vercel deploy and EAS build.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-20) and jest (AC-21 to AC-28). No shell smoke; `e2e/staff-reorder.spec.ts` stays green.

## Residual risk

- **Drafts created before this ships.** A non-primary vendor's draft for D created before prod apply keeps its F line. FILL CART on that vendor re-upserts its lines and drops F. If that vendor's card is now empty, nobody re-fills it, so the stale draft stays until someone handles it.
- **Primary drift (R3).** A wrong `vendor_id` / `is_primary` pair puts F on the "wrong" card, but never on two.
- **OQ-6.** F can't be ordered at all until the primary vendor's count lands.
- **Borrowed vs `current_stock`.** A borrowed value can differ from `current_stock` if on-hand was written after the borrowed count, for example by a later receipt or an admin edit. Reorder then uses the count, which is the same thing case A does today for an own entry.

## Prod apply and commit (owner, later; not part of this spec's done state)

- **Commit:** stage only; don't commit without the owner's explicit go-ahead.
- **Prod apply** (project `ebwnovzzkwhsdxkpyjka`, via the Supabase MCP), on the owner's go-ahead, and **before** the spec 200 client ships:
  - Pre-check: the normalized md5 of prod's `report_reorder_list` matches the 20261024000000 body.
  - Then run `execute_sql` and insert the exact version into `supabase_migrations.schema_migrations`.
  - Post-check: the md5 matches the new body.
- **Gates:** after the push to `main`, confirm `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.

## Backend design

Backend architect, 2026-11-18. Designed in the same pass as spec 200 so the two contracts agree. The baseline was re-checked in the tree: the newest `create or replace function public.report_reorder_list` is still [20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) L319-999, and the newest migration on disk is `20261115120000_apply_item_scalars_store_subset.sql`.

### 0. Decisions at a glance

| # | Decision | Where |
|---|---|---|
| D1 | **Primary source (R3) = `inventory_items.vendor_id`** (SD-1 authoritative). `item_vendors.is_primary` is not read by the rule. | §3 P1, AC-12 |
| D2 | **Coincident = the vendor would be in the client's "order today" group.** It has an `order_schedule` row at the store whose `lower(btrim(day_of_week))` is the as-of weekday, **and** the RPC's own `schedule_known` is true for it. | §3 P1 |
| D3 | **Borrow source = the cross-spec contract in §2**, shared word for word with spec 200. Tiebreak: `submitted_at DESC NULLS LAST, id DESC`. | §2, §3 B1 |
| D4 | **Drop the non-primary row in `per_item`**, upstream of `per_item_suggested`, `per_item_filtered`, `vendors_with_items`, `kpi_calc`, `vendor_rows` (`has_po`) and `_warnings`. None of those change. | §3 P2 |
| D5 | **Three additive per-item keys:** `yielded_from_vendors` (R5, mapped), and `item_on_hand_source` plus `on_hand_borrowed_from` (diagnostic, needed to observe AC-13/AC-15; not mapped). Envelope keys stay byte-stable. | §4 |
| D6 | **The switch is a new `SECURITY INVOKER` RPC, `public.set_item_primary_vendor`.** It is atomic, uses the spec 124 demote-first order in one transaction, and re-checks 3c server-side. This **deviates** from "reuse `db.updateInventoryItem`" (rationale in §5.1). | §5 |
| D7 | **Two migrations:** the reorder body and the RPC are separate, so prod md5 checks and rollback stay scoped. | §1 |
| D8 | **New admin text goes through `T()`.** The "Admin surface is English" comment at ReorderSection L1089-1090 is stale: the section already makes 44 `T()` calls. The old "order from one" line stays as it is (unchanged rows). | §9 |

### 1. Data model and migrations

No table, column, index, policy, publication or table-grant change. Both migrations are function-only, additive and non-destructive.

**Migration 1: `supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql`**
- **Content:** `create or replace function public.report_reorder_list(p_store_id uuid, p_params jsonb default '{}'::jsonb)`.
  - The body is the 20261024000000 body (L319-999) **verbatim**, plus exactly the hunks in §3. Mark each hunk inline as `SPEC 201 — Hunk <id>`.
  - Same signature, `LANGUAGE plpgsql`, no `SECURITY DEFINER` (`prosecdef = false`), `SET search_path TO 'public'`.
  - **Don't re-emit grants.** The ACL survives `create or replace` (spec 172 posture), so the `reports_anon_revoke` state is unchanged.
- **Header must state:**
  1. **Hunk list and baseline.**
     - Baseline: 20261024000000. Spec 138's `(4g) pending_po_qty ... where false` is untouched.
     - Spec 172's `no_need_items`, `no_need_for_item` and R3/R4 are untouched (R11).
  2. **RLS:** no change. **Realtime:** none; no publication change, so the `docker restart supabase_realtime_imr-inventory` ritual does **not** apply.
  3. **Prod apply** (MCP, project `ebwnovzzkwhsdxkpyjka`):
     - **Pre-check:** the normalized md5 of prod `report_reorder_list` equals the 20261024000000 body.
     - Run `execute_sql` on the file.
     - Insert version `20261118120000` into `supabase_migrations.schema_migrations`.
     - **Post-check:** the md5 equals the new body.
  4. **Sequencing (required wording):** "Must be on prod before, or in the same release as, the spec 200 staff client that omits borrowed rows (Vercel deploy and any EAS build). Spec 200 ships no migration, so there are no hunks to merge."
  5. **Rollback:** re-apply the 20261024000000 `report_reorder_list` body verbatim (function-only, no data).
     - If spec 200's client is already live, rollback brings back `'stock'` / `eod_missing_for_item` on omitted shared rows. The quantities stay correct.
     - So roll back 200's client first, or accept that cosmetic regression.
- **Locking:** `create or replace function` takes only a brief catalog lock, so no `lock_timeout` is needed. Adding `set local lock_timeout = '5s'` is harmless if the developer wants parity with 172.

**Migration 2: `supabase/migrations/20261118120100_set_item_primary_vendor.sql`**
- **Content:** a new function (§5), its `revoke` / `grant`, and a `comment on function`.
- **Header:**
  - posture (invoker, the guards, the stable error strings);
  - realtime: none;
  - prod apply: `execute_sql`, then insert version `20261118120100`, then verify the md5;
  - rollback: `drop function public.set_item_primary_vendor(uuid, uuid, date);`, after the admin client is rolled back.

**Ordering:** 1 then 2, with no dependency between them. Re-glob `supabase/migrations/` at build time. If anything newer than `20261115120000` has landed (specs 188/192/196 are staged in the index), re-date both files to sort after it and keep their relative order. If a newer migration replaces `report_reorder_list`, rebase the hunks onto **that** body instead.

### 2. Cross-spec contract: the borrow source (identical text in specs 200 and 201)

Fixed by the architect on 2026-11-18. Spec 201 R8 (reorder) and spec 200 R1/R2 server sources (staff EOD) use the **same candidate set and the same order**. Changing one means changing both.

1. **Candidates.** `public.eod_submissions` rows where:
   - `store_id` = the store;
   - `date` = the date (reorder: as-of date; staff: count date);
   - `status = 'submitted'`.

   Any `vendor_id` qualifies, including a vendor not linked to the item and, defensively, a legacy null vendor. Drafts, other dates and other stores never qualify.
2. **Order.** `submitted_at DESC NULLS LAST`, then `eod_submissions.id DESC`. The id is the deterministic tiebreak for equal timestamps.
   - Timestamps compare at full microsecond precision.
   - `id` compares as `uuid` in SQL. On the client, the lowercase canonical uuid string orders identically, because it is fixed-width hex with hyphens in fixed positions and PostgREST emits lowercase.
3. **Per item, the first candidate in that order holding a borrowable entry for the item wins.** There is at most one entry per (submission, item) (`eod_entries_submission_item_uidx`, spec 189).
4. **Borrowable entry:**
   - **Reorder (201):** `actual_remaining IS NOT NULL`, numeric only. A NO NEED entry is never a numeric source. NO NEED is applied separately by spec 172's unchanged item-wide `no_need_items` override (R11).
   - **Staff (200):** `actual_remaining IS NOT NULL` **or** `no_need = true`. A legacy blank entry (neither) is skipped and the next candidate is tried, exactly as reorder skips it.
5. **The own entry always wins on both surfaces:** reorder R9 step 1 (own case A), and staff R2 (this vendor's own submission is excluded from the candidates).
6. **Staff-only overlay.** Queued sources (this device, signed-in user) sit on top of the server candidates (spec 200 R1/R2). Reorder can't see them. Once drained, a queued submission is an ordinary server candidate with `submitted_at` = drain time, so the two surfaces converge on the next server read.

**Equivalence.** For any item whose candidate entries are all numeric, both surfaces name the same submission and the same value. The only differences involve NO NEED. Both are spec 172's existing item-wide semantics, which R11 keeps unchanged:
- **The latest borrowable entry is NO NEED** and an older numeric one exists. Staff shows NO NEED. Reorder shows the older number as `on_hand` but zeroes the suggestion with the `no_need` flag. The outcome is the same: don't order.
- **The latest borrowable entry is numeric** and an older one is NO NEED. Staff shows the number. Reorder still zeroes the suggestion on every row that isn't own case A. This is spec 172 AC-12 behaviour today; it is documented, not reconciled.

### 3. `report_reorder_list` hunks

Each hunk below is pseudocode-level; the developer authors the SQL. Every CTE not named here is byte-identical to the baseline.

**Hunk B1: new CTE `(4e3) eod_borrow_source`**, placed right after `(4e2) no_need_items`. It reuses `(4e) latest_eod_per_vendor`, which already filters (store, as-of date, `'submitted'`).
```
eod_borrow_source as (
  select distinct on (e.item_id)
         e.item_id,
         e.actual_remaining::numeric as borrowed_remaining,
         lev.vendor_id               as borrowed_vendor_id,
         bv.name                     as borrowed_vendor_name
    from latest_eod_per_vendor lev
    join public.eod_entries e  on e.submission_id = lev.submission_id
    left join public.vendors bv on bv.id = lev.vendor_id
   where e.actual_remaining is not null
   order by e.item_id, lev.submitted_at desc nulls last, lev.submission_id desc
),
```

**Hunk B2: `(4f) item_on_hand`.** Add `left join eod_borrow_source bs on bs.item_id = ii.id`. It is one row per item, so there's no fan-out. Then:
- **(a) `on_hand`** gains a middle arm. The order is: own case A (unchanged), then `when bs.item_id is not null then bs.borrowed_remaining`, then `coalesce(ii.current_stock, 0)` (unchanged).
- **(b) New column `own_item_on_hand_source`.** This is the 172 `item_on_hand_source` CASE **verbatim** (own A → `'eod'`; own submitted and NO NEED → `'eod'`; else `'stock'`). It feeds only the vendor-level rollup (R10).
- **(c) `item_on_hand_source` (post-borrow):**
  - own A → `'eod'`;
  - `bs.item_id is not null` → `'eod'`;
  - own submitted and `nn.item_id is not null` → `'eod'`;
  - else `'stock'`.
- **(d) `eod_missing_for_item`** gains `and bs.item_id is null`.
- **(e) New column `on_hand_borrowed`:** `not (lev.submission_id is not null and e.actual_remaining is not null) and bs.item_id is not null`. Also new: `bs.borrowed_vendor_id` and `bs.borrowed_vendor_name`.
- **`no_need_for_item` is unchanged (R11).**
- **Don't touch `submission_id` / `submitted_at`.** They stay the row's **own** `lev.*` values, because `vendors_with_items.eod_submitted_at = max(ioh_lev.submitted_at)` reads them (R10, AC-10, AC-18).

**Hunk P1: two new CTEs after `(4j) vendor_delivery`.** Note that `vendor_delivery` must already exist at that point.
```
order_out_today as (                       -- (4j2) coincidence candidates (D2)
  select distinct os.vendor_id
    from public.order_schedule os
    join vendor_delivery vd on vd.vendor_id = os.vendor_id and vd.schedule_known
   where os.store_id = p_store_id
     and (case lower(btrim(os.day_of_week))
            when 'sunday' then 0 when 'monday' then 1 when 'tuesday' then 2
            when 'wednesday' then 3 when 'thursday' then 4 when 'friday' then 5
            when 'saturday' then 6 else null end) = v_today_dow_num
),
item_primary_wins as (                     -- (4j3) R2: >=2 coincident AND primary among them
  select iv.item_id,
         ii.vendor_id as primary_vendor_id,                      -- D1
         coalesce(jsonb_agg(jsonb_build_object('vendor_id', iv.vendor_id, 'vendor_name', v.name)
                            order by v.name, iv.vendor_id)
                    filter (where iv.vendor_id <> ii.vendor_id),
                  '[]'::jsonb)                                   as yielded_from_vendors
    from public.item_vendors iv
    join public.inventory_items ii on ii.id = iv.item_id
    join order_out_today oot       on oot.vendor_id = iv.vendor_id
    join public.vendors v          on v.id = iv.vendor_id
   where ii.store_id = p_store_id
   group by iv.item_id, ii.vendor_id
  having count(*) >= 2
     and bool_or(iv.vendor_id = ii.vendor_id)
),
```
- **What this covers.** A null `vendor_id`, or a dangling one (not linked), makes `bool_or` false, so the item isn't in the set and OQ-4 applies unchanged. If `vendor_id` and `is_primary` drift apart, `vendor_id` wins (AC-12).
- **Why `schedule_known` is included.** It makes server coincidence identical to `partitionReorderVendors`' "primary" group ([reorderDayFilter.ts](../src/utils/reorderDayFilter.ts) L142-165), which puts `scheduleKnown = false` vendors in the separate no-schedule group. A vendor whose rows all have a null or unparseable `delivery_day` is therefore never coincident (see AC clarification C3).
- **Case and whitespace** are normalized with `lower(btrim(...))`, matching the client's `canonicalizeDayName` (`trim().toLowerCase()`). That covers AC-11.

**Hunk P2: `(4k) per_item`.**
- **(a) New joins:** `left join item_primary_wins ipw on ipw.item_id = ioh.item_id` and `left join order_out_today oot on oot.vendor_id = ioh.vendor_id`. Both are distinct-keyed, so there's no fan-out.
- **(b) New `where` (the drop, R2/R4):**
  ```
  where not (ipw.item_id is not null and oot.vendor_id is not null
             and ioh.vendor_id <> ipw.primary_vendor_id)
  ```
- **(c) New select columns:**
  - `ioh.own_item_on_hand_source`, `ioh.on_hand_borrowed`, `ioh.borrowed_vendor_id`, `ioh.borrowed_vendor_name`;
  - `case when ipw.item_id is not null and ioh.vendor_id = ipw.primary_vendor_id then ipw.yielded_from_vendors else '[]'::jsonb end as yielded_from_vendors`.

  They thread through `pi.*` / `pis.*` with no further edit.
- **Why the drop sits here.** The drop is upstream of the `include_stocked` filter, so AC-5 holds in both `needs_order` states.

**Hunk V: `(4l) vendors_with_items`.**
- **(a) R10:** `case when bool_or(pif.own_item_on_hand_source = 'eod') then 'eod' else 'stock' end as on_hand_source`. This is byte-identical in meaning to today, because `own_item_on_hand_source` *is* today's expression.
- **(b)** Three per-item keys appended after `also_from_vendors` (§4).
- **No other rollup changes:** `vendor_total_cost`, `kpi_calc`, `has_po` and `_warnings` all read the already-dropped set (R4, AC-3, AC-4).

**Unchanged on purpose:**
- `(3)` the depth pre-walk, and `(4a)-(4d)`;
- `(4e)` and `(4e2)`;
- `(4f2) item_vendor_set` and the `other_vendor_count` / `also_from_vendors` expressions (R5: same values and meaning);
- `(4g)` (spec 138), `(4h)-(4j)`, `per_item_suggested`, `per_item_filtered` (its flags read the now borrow-aware `eod_missing_for_item`), `(4m)`, `(4n)`, `(5)` and `(6)`.

### 4. Envelope contract (additive per-item keys)

| Key | Type | Value |
|---|---|---|
| `yielded_from_vendors` | `[{vendor_id, vendor_name}]`, sorted by name, then id | Always present. Non-empty **only** on the primary's row for an item in `item_primary_wins`. `[]` everywhere else, including every row on non-coincident days (AC-2, AC-6, AC-8). |
| `item_on_hand_source` | `'eod' \| 'stock'` | The post-borrow per-item source (B2c). Diagnostic; it's what AC-13/AC-14 assert. |
| `on_hand_borrowed_from` | `{vendor_id, vendor_name}` or JSON null | Non-null iff the row took the borrowed arm (B2e). Diagnostic; AC-15 asserts it alongside `on_hand`. |

Every pre-existing item and vendor key and value is unchanged except the intended `on_hand` / `flags` change on borrowed rows. Read AC-6's "every key and value as before" as "every pre-existing key". Mappers that don't know the new keys ignore them, so old web and native clients are safe against the new server.

### 5. Switch RPC: `public.set_item_primary_vendor`

```
public.set_item_primary_vendor(p_item_id uuid, p_vendor_id uuid, p_as_of_date date)
  returns jsonb
  language plpgsql
  security invoker
  set search_path = public
```

Steps, in order. **Every guard fires before any write.**
1. **Required arguments.** If any argument is null → raise `'set_item_primary_vendor: item_id, vendor_id and as_of_date are required'`, errcode `22023`.
2. **Admin only.** If `not public.auth_is_privileged()` → `'set_item_primary_vendor: privileged only'`, `42501` (OQ-3; server-side, not just the UI). This mirrors `apply_item_vendors_to_brand`.
3. **Lock the item.** `select store_id, vendor_id into v_store, v_prev from public.inventory_items where id = p_item_id for update`.
   - Not found (including RLS-hidden) → `'set_item_primary_vendor: item not found'`, `P0001`.
   - The row lock serializes two concurrent switches of the same item.
4. **Store visibility.** If `not public.auth_can_see_store(v_store)` → `'set_item_primary_vendor: caller cannot see store'`, `42501`. This is the explicit house shape on top of RLS.
5. **Link exists.** If there's no `item_vendors` row for (`p_item_id`, `p_vendor_id`) → `'set_item_primary_vendor: vendor is not linked to this item'`, `P0001`.
6. **No-op.** If `v_prev is not distinct from p_vendor_id` → return `{item_id, store_id, previous_vendor_id, vendor_id, changed: false}` with **no writes**. It does not repair an `is_primary` drift, which is out of scope (R3).
7. **3c guard.** If `v_prev is not null` and a matching order line exists, raise `'set_item_primary_vendor: item is on an open order for the current primary vendor'`, `P0001`. The match is:
   ```
   exists (select 1 from public.po_items pi join public.purchase_orders po on po.id = pi.po_id
            where pi.item_id = p_item_id and po.store_id = v_store and po.vendor_id = v_prev
              and po.reference_date = p_as_of_date and po.status <> 'cancelled')
   ```
   The `status <> 'cancelled'` keying matches `has_po`. FILL CART drafts are covered, since `upsertVendorDraftOrder` writes `purchase_orders` with `reference_date`.
8. **Demote:** `update public.item_vendors set is_primary = false, updated_at = now() where item_id = p_item_id and is_primary and vendor_id <> p_vendor_id;`
9. **Promote:** `update public.item_vendors set is_primary = true, updated_at = now() where item_id = p_item_id and vendor_id = p_vendor_id;`
10. **Scalar:** `update public.inventory_items set vendor_id = p_vendor_id, updated_at = now() where id = p_item_id;`. `trg_item_vendor_changed_at` stamps `vendor_changed_at` (spec 128; see §10).
11. **Return** `{item_id, store_id, previous_vendor_id: v_prev, vendor_id: p_vendor_id, changed: true}`.

**Grants:** `revoke execute ... from public, anon; grant execute ... to authenticated;`. This is the same shape as `apply_item_vendors_to_brand`. Pin it in pgTAP.

**HTTP mapping (PostgREST):** `22023` → 400, `42501` → 403, `P0001` → 400. The client matches the 3c refusal by the substring `item is on an open order for the current primary vendor`. The string is stable byte for byte; changing it is a contract change.

**Which CLAUDE.md rules apply:** the self-guard and last-of-role conventions don't, since this targets no profile and deletes nothing. It isn't `SECURITY DEFINER`, so the definer-guard posture doesn't apply either.

#### 5.1 Why an RPC instead of `db.updateInventoryItem` (deviation from In scope / R7.3 wording)

The RPC implements the **same** spec 124 demote-first order as `updateInventoryItem` ([db.ts](../src/lib/db.ts) L612-623) and `apply_item_vendors_to_brand`, in one transaction. Reusing `updateInventoryItem` was rejected for four reasons:
1. **It isn't atomic.** It makes 3-4 PostgREST writes (scalar, demote, upsert, delete). If one fails between the scalar update and the `is_primary` flip, the result is exactly the `vendor_id` / `is_primary` drift that R3 and spec 102's "dangling scalar" describe.
2. **It needs the full link payload.** It upserts every link's cost, case price, order code and product URL from client state, and deletes links not submitted. A switch from a stale client could silently revert another admin's cost edit or drop a link added meanwhile. The switch only needs to touch two `item_vendors` rows and one scalar.
3. **The 3c check can be re-run in the same transaction.** That closes the TOCTOU between the client pre-check and the write, for example FILL CART pressed in another tab.
4. **"Admin only" is enforced server-side** (`auth_is_privileged()`). Today `inventory_items` / `item_vendors` UPDATE is open to any store member under `store_member_update_*`, so the UI would be the only gate.

AC-25's observable outcomes are unchanged: one `is_primary = true` link (the new vendor), this store's `vendor_id` = the new vendor, no duplicate-key error, and no other store's rows touched. If the PM or owner prefers the literal `updateInventoryItem` reuse, the rest of this design stands. Only §5, §7's `setItemPrimaryVendor` and migration 2 change, and the residual risks in reasons 1 and 2 must then be accepted.

### 6. RLS impact

- **No policy is created, dropped or altered.** `permissive_policy_lint` is unaffected, so no allowlist row is needed.
- **`report_reorder_list` stays invoker** and keeps its `auth_can_see_store(p_store_id)` gate. The new CTEs read `order_schedule`, `item_vendors`, `vendors`, `eod_submissions` and `eod_entries` under the caller's existing SELECT policies, the same ones the body already relies on.
- **`set_item_primary_vendor` is invoker**, so RLS stays the second wall behind the explicit gates:
  - `store_member_update_inventory_items` and `store_member_update_item_vendors`;
  - SELECT on `po_items` / `purchase_orders` via `store_member_read_*`.
  - `auth_can_see_store` (current definition [20260517040000_auth_can_see_store_brand_scope.sql](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)) admits super_admin and brand-scoped admins, so every privileged caller who can see the store passes.

### 7. `src/lib/db.ts` surface

- **`mapReorderVendor` (L4746-4807)** adds `yieldedFromVendors: Array.isArray(it?.yielded_from_vendors) ? it.yielded_from_vendors.map((v) => ({ vendorId: String(v?.vendor_id ?? ''), vendorName: String(v?.vendor_name ?? '') })) : []`. This mirrors the `alsoFromVendors` mapping.
  - **Don't map** `item_on_hand_source` / `on_hand_borrowed_from`. They're server diagnostics for now; a later "counted under X" admin label can map them.
- **`ReorderItem` ([src/types/index.ts](../src/types/index.ts) L1017-1076)** adds `yieldedFromVendors?: Array<{ vendorId: string; vendorName: string }>` with a spec 201 doc comment.
  - Also correct the stale `'eod_missing_for_item'` doc (L1012-1014): the flag now means "own vendor submitted, no own numeric entry, no borrow source, no NO NEED".
- **New write:** `export async function setItemPrimaryVendor(itemId: string, vendorId: string, asOfDate: string): Promise<{ changed: boolean; previousVendorId: string | null; vendorId: string }>`
  - `useInflight.getState().track(..., { kind: 'write', label: 'setItemPrimaryVendor' })`;
  - `supabase.rpc('set_item_primary_vendor', { p_item_id, p_vendor_id, p_as_of_date }).abortSignal(signal)`;
  - throw on `error` (raw, so the caller can read `.message`); map snake_case → camelCase.
- **New read:** `export async function isItemOnOpenOrder(params: { storeId: string; itemId: string; vendorId: string; referenceDate: string }): Promise<boolean>`
  - `kind: 'read'`, label `isItemOnOpenOrder`;
  - `supabase.from('po_items').select('id, purchase_orders!inner(id)').eq('item_id', itemId).eq('purchase_orders.store_id', storeId).eq('purchase_orders.vendor_id', vendorId).eq('purchase_orders.reference_date', referenceDate).neq('purchase_orders.status', 'cancelled').limit(1)`;
  - throw on error; return `rows.length > 0`.
  - This is the 3c **pre-check before confirm** (AC-26). The RPC's step 7 is the authoritative backstop.
- **Staff mapper** ([src/screens/staff/lib/fetchReorder.ts](../src/screens/staff/lib/fetchReorder.ts) ~L84) gets the same `yieldedFromVendors` mapping. It's in the staff carve-out, so it stays out of `db.ts`.

### 8. Frontend store impact ([src/store/useStore.ts](../src/store/useStore.ts))

New action on the inventory slice:
```
switchItemPrimaryVendor: (args: {
  itemId: string; fromVendorId: string; toVendorId: string; asOfDate: string;
  confirm: () => Promise<boolean>;          // component wraps confirmAction in a Promise
}) => Promise<'switched' | 'refused' | 'cancelled' | 'failed'>;
```
1. **Pre-check (3c).** `await db.isItemOnOpenOrder({ storeId: currentStore.id, itemId, vendorId: fromVendorId, referenceDate: asOfDate })`.
   - `true` → return `'refused'`. The component shows the refusal toast, and **neither confirm nor any write happens** (AC-26).
   - If the read **throws** → `notifyBackendError('Switch primary vendor', e)` and return `'failed'`. Fail closed: no confirm.
2. **Confirm.** `if (!(await confirm())) return 'cancelled'` (AC-25.4: nothing written).
3. **Optimistic patch.** Patch the `inventory` slice row: `vendorId = toVendorId`, `vendors[].isPrimary = (l.vendorId === toVendorId)`. Keep `prev`.
4. **Write.** `await db.setItemPrimaryVendor(itemId, toVendorId, asOfDate)`.
   - On error whose message contains the 3c substring → revert, return `'refused'` (server backstop; no `notifyBackendError`).
   - Any other error → revert, `notifyBackendError('Switch primary vendor', e)`, return `'failed'` (AC-27).
5. **After success.** `get().loadReorderSuggestions(asOfDate)` (AC-25.3; the same reload pattern as `useStore.ts` ~L4021). Then add an `addAuditEvent` like `updateItem` (L2539-2550), with `action: 'Item edit'` and `detail: 'Primary vendor switched'`. Return `'switched'`.

**No optimistic edit of `reorderPayload`.** The reload is authoritative, because the item moves between cards and the KPIs change.

### 9. UI contract

- **Admin desktop ([ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) ~L1084-1102) and phone ([PhoneOrdering.tsx](../src/screens/cmd/sections/phone/PhoneOrdering.tsx)).**
  - **When it shows:** `(item.yieldedFromVendors?.length ?? 0) > 0`. Then render the new line **instead of** the old "also available from … — order from one" line.
  - **testIDs:** the line is `reorder-yielded-from-${itemId}`; each switch control is `reorder-switch-primary-${itemId}-${vendorId}`.
  - **One switch target per yielded vendor.** AC-7's all-three case yields two vendors, and the switch has to name its target. With one yielded vendor, a single "switch" control is enough.
  - **Old line:** every other row keeps the old line exactly, including its English literal and testID `reorder-also-from-${itemId}`. PhoneOrdering has no old line today (verified), so it only gains the new one.
  - **Flow:** call `switchItemPrimaryVendor`, with `confirm` wrapping [confirmAction](../src/utils/confirmAction.ts) (callback-based) in a Promise. Toast on `'refused'`.
  - **New admin keys** in [src/i18n/en.json](../src/i18n/en.json), `es.json` and `zh-CN.json` under `section.reorder`, with identical tokens. Wording is the frontend's call. Suggested:
    - `yieldedFrom`: "also from {vendors}"
    - `switchPrimaryTo`: "switch to {vendor}"
    - `switchConfirmTitle`: "Make {to} the primary vendor?"
    - `switchConfirmBody`: "{item} will be ordered from {to} instead of {from} at this store from now on. This is permanent for this store."
    - `switchRefused`: "{item} is already on today's {from} order. Remove it from that order first."
- **Staff ([Reorder.tsx](../src/screens/staff/screens/Reorder.tsx) L273-293).** Same condition. Render one text line, `t('reorder.item.yieldedFrom', { vendors })`, with testID `reorder-yielded-from-${itemId}` and **no** switch (3b). The key goes in `src/screens/staff/i18n/{en,es,zh-CN}.json` next to `alsoFromOne` / `alsoFromMany`, with identical `{vendors}` tokens.
- **No change to order paths** (AC-24). FILL CART, CREATE PO, export recording, CSV/PDF and the Sysco / US Foods planners all read `vendors[].items`, which no longer carry the dropped row. AC-24 is tests only.

### 10. Readers of `inventory_items.vendor_id` (R7 documentation task; their behaviour is unchanged)

A switch changes what each of these shows or does for the item at this store:
- **Reorder primary-wins rule (this spec).** The item moves to the new primary's card on coincident days.
- **"Supplied by" label:** [InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx) L291 (`en.json` `suppliedBy`), and the phone vendor label in [PhoneInventoryDetail.tsx](../src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx) L52.
- **Primary-only vendor item lists and counts:**
  - [VendorsSection.tsx](../src/screens/cmd/sections/VendorsSection.tsx) L89;
  - [PhoneVendorsList.tsx](../src/screens/cmd/sections/phone/PhoneVendorsList.tsx) L30 and L142;
  - [ReceivingSection.tsx](../src/screens/cmd/sections/ReceivingSection.tsx) L501.
- **Order-code CSV import:** a blank vendor column resolves to the **primary** link ([csvImport.ts](../src/lib/csvImport.ts) L157-173, [RunImportModal.tsx](../src/components/cmd/RunImportModal.tsx) L80).
- **Legacy-link synthesis and fallbacks when `vendorIds` is absent:**
  - `useStore.ts` L2447-2457;
  - `stockResult.ts` L175;
  - `EODCountSection.tsx` L509/534/554/870;
  - `PhoneEodCount.tsx` L239;
  - `DashboardSection.tsx` L463.
- **DB trigger `trg_item_vendor_changed_at`** ([20260722000000_ingredient_changed_badge.sql](../supabase/migrations/20260722000000_ingredient_changed_badge.sql) L64-82) stamps `vendor_changed_at`. Staff then see the spec 128 "Updated" badge on the item at their next EOD load. That's intended: the product source changed.
- **The cost fallback is NOT a `vendor_id` reader.** `inventory_items.cost_per_unit` (the COGS/variance cost, and the reorder fallback when the junction cost is 0) is per item and isn't touched by a switch. It may still hold the old primary's price. That's documented and out of scope.

### 11. Realtime

**No publication change**, so the restart gotcha does not apply. The RPC writes `inventory_items` and `item_vendors`. Both are already on `supabase_realtime` and reach other admin clients on `store-{id}` (400 ms debounced reload in [useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts)). The spec 175 silent refresh then re-fetches the reorder envelope. The acting client reloads explicitly (§8 step 5). The staff stack has no realtime.

### 12. Tests

**pgTAP (backend-developer).** Every suite follows the house fixture posture:
- `begin; … rollback;`;
- fresh vendors, catalog rows and items created in-transaction, with fresh vendor names to satisfy `order_schedule` unique (store, day, vendor_name);
- a **synthetic as-of date** with `day_of_week` derived via `to_char(D, 'FMDay')`, so nothing depends on the weekday CI runs on;
- master JWT for the reorder calls; no `set role anon`.

The suites:
1. **New `supabase/tests/report_reorder_list_primary_wins.test.sql`:** AC-1 to AC-12, plus the AC-20 posture arms.
   - Posture: one `pg_proc` row, `prosecdef = false`, `proconfig = {search_path=public}`, and anon/authenticated EXECUTE unchanged.
   - For AC-12 (D1), seed `vendor_id = A` with `is_primary` on B: F stays on A and is dropped from B. Add two more arms: dangling `vendor_id` (not linked) and null `vendor_id`. Both behave as OQ-4 (both rows, key `[]`).
   - Add the C3 arm: a vendor with a `day_of_week` = D row but a null `delivery_day` is not coincident.
   - For AC-10, keep F below par on A's borrowed value, or F filters out under the default `include_stocked = false`.
2. **New `supabase/tests/report_reorder_list_borrowed_count.test.sql`:** AC-13 to AC-19.
   - Assert `item_on_hand_source` and `on_hand_borrowed_from` (§4).
   - **Add AC-15b:** equal `submitted_at` → the **higher `eod_submissions.id`** wins. This pins the §2 tiebreak.
   - **AC-17's NO NEED bullet** follows clarification C1.
3. **New `supabase/tests/set_item_primary_vendor.test.sql`:**
   - **Posture:** invoker, `search_path`, anon has no EXECUTE, authenticated has it.
   - **Happy path:** exactly one primary (B), this store's `vendor_id = B`, the same catalog's row in another store unchanged, and `vendor_changed_at` stamped.
   - **No-op:** already primary → `changed = false` and no `updated_at` bump.
   - **3c refused:** `P0001` with the exact string, and nothing written: the primary and `vendor_id` are both still A.
   - **3c does not block for:** a cancelled PO, a PO on D − 1, a PO for B, or a PO for A that lacks F.
   - **Other refusals:** a not-linked vendor → `P0001`; a `role = user` store member → `42501` (no write); null arguments → `22023`.
4. **Rewrite, don't delete, [report_reorder_list_multi_vendor.test.sql](../supabase/tests/report_reorder_list_multi_vendor.test.sql).**
   - **Finding:** its fixture hardcodes `day_of_week = 'monday'` for both vendors while `as_of_date = current_date` (L106-122). So it is coincident **only when CI runs on a Monday**, and under this spec arms (3), (5) and (11) would fail one day in seven.
   - **Fix:** set V1's `day_of_week` to `to_char(current_date, 'FMDay')` and V2's to `to_char(current_date + 1, 'FMDay')`. They are then deterministically non-coincident, and every arm keeps its spec 102 meaning: explosion on non-coincident days.
   - Re-label arm (3) "… on a non-coincident day (explosion to both)". Update header L12-13/L38-40. The coincident outcome is pinned by suite 1, AC-1.
5. **Verified unaffected** (traced against the new hunks): `eod_no_need.test.sql` arms (33)-(51) (it has no `order_schedule` rows, so nothing coincides, and arms (39), (41), (46) and (50) still hold under borrowing), `po_loop.test.sql` (P), and the other `report_reorder_list_*` suites (single-link items can't coincide).
   - The developer still runs the **full** pgTAP. Any other arm that pins `eod_missing_for_item` or old card membership on a now-borrowed or now-dropped row is **rewritten, not deleted**, and listed under `## Files changed`.

**Jest (frontend-developer):** AC-21 to AC-28 as written, plus:
- store-action arms for `switchItemPrimaryVendor`: pre-check `true` → `'refused'` with `confirm` never called; the pre-check throws → `'failed'` with `confirm` never called; cancel → no `setItemPrimaryVendor` call; the server 3c error → revert + `'refused'` with no `notifyBackendError`; any other error → revert + `notifyBackendError`;
- `mapReorderVendor` maps `yielded_from_vendors`, and absent → `[]`.

Re-grep the `reorder-also-from-*` fixtures and the staff `Reorder.test.tsx` (AC-28).

### 13. Risks and tradeoffs

- **Migration ordering and deploy coupling with spec 200.** Migration 1 must be on prod before the spec 200 client deploys. Vercel deploys on push to `main`, so **push spec 200's client only after migration 1 is applied to prod**, or in the same window right after the prod apply. Both directions of version skew are safe for spec 201's own client: the new UI on the old server sees no key → `[]`; the old UI on the new server ignores it.
- **Migration 2 must be on prod before spec 201's admin client.** Otherwise the switch fails with PGRST202 → `notifyBackendError` and a revert, which is safe but broken UX. Apply 1 and 2 together.
- **Performance on the 286 KB seed.** The added work is all store-scoped:
  - `order_schedule`: tens of rows;
  - one `item_vendors` × `order_out_today` aggregate: at most hundreds;
  - one `distinct on` over today's entries for the store: at most a few hundred.

  No new index is needed. `item_vendors_item_id_idx` / `_vendor_id_idx` and the `eod_entries` unique index cover the joins.
- **Spec 130 interplay (R10).** A non-primary vendor that never submitted, and whose rows all borrow, still renders "count not submitted" even though its numbers are counted. That's intended by R10.
- **Vendor badge of a backup vendor that did submit (architect S1). Owner, 2026-11-19: "Accept, relabel later".** Once spec 200 ships, consider a backup vendor whose surfaced items are all shared items that were counted under another vendor and omitted from its own submission. The same happens when its only own count is dropped by primary-wins.
  - **What the user sees:**
    - The card badges `on_hand_source = 'stock'` (STOCK FALLBACK) **with** a non-null `eod_submitted_at`.
    - It loses its last-order deltas.
    - It adds to `kpis.stock_fallback_vendor_count`.
  - **What stays correct:** quantities and every order path, because the borrowed `on_hand` and the suggestions are right.
  - **Follow-up:** a "counted under {vendor}" relabel, for example using the unmapped `on_hand_borrowed_from` diagnostic, is a follow-up spec. It must not be done by editing R10 inside 201, because AC-18 pins the never-submitted direction.
  - **Test pin:** [report_reorder_list_borrowed_count.test.sql](../supabase/tests/report_reorder_list_borrowed_count.test.sql) arms (42)-(46) pin today's behaviour for both the omit shape and the drop shape, so any later change is deliberate.
- **Primary drift (R3).** It's never two cards, sometimes the "wrong" one. The no-op path (§5 step 6) deliberately doesn't repair drift.
- **Pre-ship drafts:** see Residual risk. The 3c guard only protects switches, not the drop itself.
- **Cold start:** no edge function, so not applicable.

### 14. AC clarifications (architect; these change no behaviour)

- **C1, AC-17's 4th bullet (NO NEED).** "As before" there is the **spec 172** result: `on_hand = current_stock`, `'no_need'` present, and `'eod_missing_for_item'` **absent** (172 R2(d) already clears it). The parenthetical "flag present" applies to the first three bullets only.
- **C2, AC-13 / AC-14 "per-item source".** These are observed through the new `item_on_hand_source` key (§4). Before this spec there was no per-item source key in the envelope.
- **C3, AC-9 "no `order_schedule` row".** This extends to "rows exist, but none has a parseable `delivery_day`" (`schedule_known = false`). Such a vendor is never coincident, matching the client's no-schedule group.
- **C4, AC-20 known arm.** The `multi_vendor` fixture is weekday-dependent (§12 item 4). The arm is fixed by moving it to a deterministic non-coincident day, which AC-20 explicitly permits.
- **C5, AC-25 "through the spec 124 path".** It's satisfied by the RPC's in-transaction demote-first order (§5.1). The observable outcomes are as written.
- **C6, AC-6.** "Every key and value as before" means every **pre-existing** key. The three new keys are present (`[]`, a source token, and null).

### Files expected to change (for post-implementation review)

- **backend-developer:**
  - `supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql` (new)
  - `supabase/migrations/20261118120100_set_item_primary_vendor.sql` (new)
  - `supabase/tests/report_reorder_list_primary_wins.test.sql` (new)
  - `supabase/tests/report_reorder_list_borrowed_count.test.sql` (new)
  - `supabase/tests/set_item_primary_vendor.test.sql` (new)
  - `supabase/tests/report_reorder_list_multi_vendor.test.sql` (fixture rewrite)
  - `src/lib/db.ts` (mapper, `setItemPrimaryVendor`, `isItemOnOpenOrder`)
  - `src/types/index.ts` (`ReorderItem`)
  - `src/screens/staff/lib/fetchReorder.ts` (mapper)
- **frontend-developer:**
  - `src/store/useStore.ts`
  - `src/screens/cmd/sections/ReorderSection.tsx`
  - `src/screens/cmd/sections/phone/PhoneOrdering.tsx`
  - `src/screens/staff/screens/Reorder.tsx`
  - `src/i18n/{en,es,zh-CN}.json`
  - `src/screens/staff/i18n/{en,es,zh-CN}.json`
  - jest files for AC-21 to AC-28
- **File overlap with spec 200's frontend work:** `src/screens/staff/i18n/*.json`. Don't run the two frontend passes concurrently on those files (see the handoff).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement spec 201 against the "## Backend design" section.
  - backend-developer owns: both migrations (§1, §3, §5); the three new pgTAP suites plus the multi_vendor fixture rewrite (§12); the db.ts mapper and the two new helpers (§7); the ReorderItem type; the staff fetchReorder mapper.
  - frontend-developer owns: the useStore switchItemPrimaryVendor action (§8); the ReorderSection, PhoneOrdering and staff Reorder UI (§9); admin and staff i18n; jest AC-21 to AC-28.
  - The contract in §4/§5/§7 is fixed, so both can run in parallel.
  - The spec 200 frontend pass touches the same staff i18n JSON files. Run it after this spec's frontend pass, or give both to one frontend-developer.
  - Do NOT push spec 200's client to main before migration 20261118120000 is on prod.
  - After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/201-reorder-shared-item-primary-vendor-wins.md
  - specs/200-staff-eod-shared-item-counted-once.md

## Backend implementation notes

Backend developer, 2026-11-18. Built to the `## Backend design` above, with no design deviations.

- **Migration dates.** I re-globbed the migrations; the newest is still `20261115120000_apply_item_scalars_store_subset.sql`, so the dates are the ones the design gives. No newer migration replaces `report_reorder_list`.
- **Migration 1** is the 20261024000000 body (L319-999) copied verbatim, with hunks B1, B2(a-e), P1, P2(a-c) and V(a-b) each marked `SPEC 201 — Hunk <id>` inline. A diff against the baseline shows only three removed lines, all replaced in place: the `eod_missing_for_item` close-paren, the vendor-level `bool_or`, and the `also_from_vendors` close-paren. Grants are not re-emitted. It keeps `begin; set local lock_timeout = '5s'; … commit;` for parity with spec 172.
- **Migration 2** (`set_item_primary_vendor`) follows §5 step for step. The stable strings and SQLSTATEs are byte-exact, and grants are `revoke … from public, anon; grant … to authenticated`.
- **`db.ts`.** Added `yieldedFromVendors` to `mapReorderVendor`, plus `setItemPrimaryVendor(itemId, vendorId, asOfDate)` (write, label `setItemPrimaryVendor`, throws the raw PostgREST error) and `isItemOnOpenOrder({ storeId, itemId, vendorId, referenceDate })` (read, label `isItemOnOpenOrder`). The names and signatures match §7 exactly. The diagnostic keys `item_on_hand_source` / `on_hand_borrowed_from` are not mapped.
- **Types.** Added `ReorderItem.yieldedFromVendors?`, and corrected the stale `'eod_missing_for_item'` doc.
- **Staff mapper** (`fetchReorder.ts`): same `yieldedFromVendors` mapping.
- **pgTAP notes:**
  - **AC-4.** "Delete G" is modelled by deleting G's only `item_vendors` link. For the RPC this is equivalent (G produces no row), and it avoids a tombstone side effect.
  - **AC-17, other-store bullet.** `eod_entries_check_store` forbids a Frederick item under a Charles submission. The probe therefore inserts that one entry under `set local session_replication_role = replica`, which is rolled back with the test. This proves the borrow source filters on the submission's store.
  - **AC-17, NO NEED bullet (C1).** Observed with `include_stocked = true`, because the zeroed row is otherwise filtered.
  - **C3.** `order_schedule.delivery_day` is `NOT NULL`, so "null delivery_day" is modelled as an unparseable value (`'n/a'`), which gives `schedule_known = false`.
  - **AC-11** also covers `'  MONDAY '`-style padding and upper case.
  - **Mutation check.** Both new reorder suites were re-run with the 20261024 baseline body installed inside the test transaction. 29/60 and 22/41 arms fail there. The arms that still pass are the intended "as before" pins.
- **`report_reorder_list_multi_vendor.test.sql` fixture rewrite (C4).** V1's `day_of_week` is now today's weekday and V2's is tomorrow's. The header and arm (3) are relabelled. No arm was deleted, and all 11 still pass. No other suite needed a rewrite: the full pgTAP run is green.
- **Verification:**
  - **Local apply.** Applied with `supabase migration up`. It also applied the already-committed `20261115120000`, which hadn't been run on this local DB yet.
  - **PostgREST end-to-end** (admin@local.test, a scratch PO and link, all cleaned up afterwards):
    - `isItemOnOpenOrder`'s embedded-filter query returns true for (S, A, D) and false for D-1 and for vendor B.
    - The RPC returns `P0001` with the exact 3c string, then switches, switches back, and no-ops (`changed: false`).
    - `report_reorder_list` items carry all three new keys.
    - Residue: one local `item_vendors.updated_at` moved; no data change.
- **Gates run:**
  - Full pgTAP: 111/111 files pass.
  - Full `npx jest`: 315/315 suites, 4014 tests (run while the frontend half was in progress).
  - `npm run typecheck:test`: exit 0.
  - `npm run typecheck`: 0 real errors. It currently prints only `TS2688 Cannot find type definition file for '<pkg> 2'`, caused by 24 Finder-duplicate `node_modules/@types/* 2` directories on this machine. That is an environment issue outside the repo; `tsc --noEmit --types node,jest` is clean.
- **Not done (owner, later):** prod apply of both migrations via MCP (see each header), and the commit.

### Review follow-up (backend-developer, 2026-11-19)

Owner decision on architect S1: "Accept, relabel later". No function behaviour changed.

- **S1 risk.** Added as a §13 bullet ("Vendor badge of a backup vendor that did submit").
- **S1 pin.** `report_reorder_list_borrowed_count.test.sql` gains arms (42)-(46), on dates `ds1o` and `ds1d`, covering two shapes:
  - **Omit shape** (spec 200): B's only surfaced row is the borrowed F, which reads 5 with per-item source `'eod'`. B's vendor badge is `'stock'`, with `eod_submitted_at` set to B's own submission time.
  - **Drop shape** (coincident primary-wins): B's own-counted F is dropped and only the uncounted G surfaces. B's badge is `'stock'`, with a non-null `eod_submitted_at`.
- **Security-auditor: 3c wording.** In migration 2, the step-7 comment inside the function body now says the in-transaction re-check *narrows* the client pre-check race rather than closing it, and explains why (READ COMMITTED; the row lock does not serialize `po_items` inserts).
  - This is a comment-only change to the body, so `prosrc` and the normalized md5 change, but behaviour does not.
  - The file is not yet on prod, so the prod post-check md5 is simply taken from this version.
  - It was re-applied locally, and the posture was re-verified: invoker, `{search_path=public}`, anon has no EXECUTE, authenticated has EXECUTE.
- **Security-auditor: authorization gaps.** `set_item_primary_vendor.test.sql` gains four arms:
  - (31)-(32): a cross-brand admin (the seed admin moved to a test-only brand, with its `user_stores` rows dropped) gets `P0001 'item not found'`, and nothing is written.
  - (33)-(34): a super_admin (role from `profiles.role`; the JWT role is neither admin nor master) can switch.
  - Both fixtures are rolled back with the test.
- **Full pgTAP after the follow-up:** 112/112 files pass.

## Files changed (backend)

**Migrations (new)**
- `supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql`
- `supabase/migrations/20261118120100_set_item_primary_vendor.sql`

**pgTAP**
- `supabase/tests/report_reorder_list_primary_wins.test.sql` (new; AC-1 to AC-12, C3, AC-20 posture; 60 arms)
- `supabase/tests/report_reorder_list_borrowed_count.test.sql` (new; AC-13 to AC-19 plus AC-15b, and S1 pins (42)-(46); 46 arms)
- `supabase/tests/set_item_primary_vendor.test.sql` (new; posture, happy path, no-op, 3c, refusals, plus cross-brand admin and super_admin arms (31)-(34); 34 arms)
- `supabase/tests/report_reorder_list_multi_vendor.test.sql` (fixture rewritten to deterministic non-coincident days; no arm deleted)

**`src/lib/db.ts`**
- `mapReorderVendor` maps `yieldedFromVendors`.
- New `setItemPrimaryVendor` and `isItemOnOpenOrder`.
- Only these hunks are staged. The file's unrelated, pre-existing invite-comment edit near L2645 is left unstaged.

**Types**
- `src/types/index.ts`: `ReorderItem.yieldedFromVendors?`, and the `eod_missing_for_item` doc fix.

**Staff carve-out**
- `src/screens/staff/lib/fetchReorder.ts`: `yieldedFromVendors` mapping.

## Frontend implementation notes

Frontend developer, 2026-11-18. Built to §8 and §9 against the backend's `db.ts` names, which match §7 exactly. There are two judgement calls in this pass and no deviations from the design.

- **Store action** `switchItemPrimaryVendor` (inventory slice) follows §8 step for step:
  1. Pre-check with `isItemOnOpenOrder`. If it returns true, return `'refused'` without calling the confirm. If it throws, call `notifyBackendError` and return `'failed'`. The confirm is never reached in either case.
  2. Confirm.
  3. Optimistic patch of `inventory`: `vendorId` plus the `vendors[].isPrimary` mirror.
  4. `setItemPrimaryVendor`. On the 3c string, revert and return `'refused'` (no toast from the store). On any other error, revert, call `notifyBackendError('Switch primary vendor', e)` and return `'failed'`.
  5. Await `loadReorderSuggestions(asOfDate)`, add an `'Item edit'` / `'Primary vendor switched'` audit event, and return `'switched'`.

  The store exports `PRIMARY_SWITCH_OPEN_ORDER_REFUSAL`, which holds the byte-exact §5 substring, and `PrimaryVendorSwitchResult`. A `'__all__'` / missing store returns `'failed'` before anything else runs.
- **Shared UI flow** `src/screens/cmd/lib/primaryVendorSwitch.ts`. Desktop and phone both use this one helper, so the confirm copy and the toasts can't drift between them. It:
  - wraps `confirmAction` in a Promise, with Cancel and dismiss resolving false;
  - shows the refusal toast on `'refused'` and a success toast on `'switched'`;
  - shows nothing on `'failed'`, because the store already toasted.
- **Desktop (ReorderSection).** A row whose `yieldedFromVendors` is non-empty shows "also from {vendors}", followed by one switch control per yielded vendor. With one yielded vendor the control reads "switch"; with more, each reads "switch to {vendor}".
  - TestIDs are `reorder-yielded-from-${itemId}` and `reorder-switch-primary-${itemId}-${vendorId}`.
  - The old `reorder-also-from-*` line is unchanged on every other row, including its English literal (D8).
  - While a switch is in flight, the row's control is disabled, so a second press does not fire it twice.
- **Phone (PhoneOrdering `VendorOrderCard`).** Same line, same testIDs.
  - **Judgement call 1:** the switch only renders when `footer === 'default'`, which is the ordering surface. PhoneApproveOrder renders this same card with `footer='none'`. There the line is text-only, because a switch would move the item off the order being approved. The design (§9) doesn't cover the approve screen; this is the least surprising choice. A reviewer can flip it with a one-line change.
- **Staff (Reorder.tsx).** Same condition. One text line, `t('reorder.item.yieldedFrom', { vendors })`, with no switch.
  - **Judgement call 2:** the staff wording is "also from {vendors} — order it here". Without a switch, the bare "also from …" read as incomplete.
- **i18n.**
  - **Admin, `section.reorder`** (en/es/zh-CN, identical tokens): `yieldedFrom`, `switchPrimary`, `switchPrimaryTo`, `switchPrimaryAria`, `switchConfirmTitle`, `switchConfirmBody`, `switchConfirmCta`, `switchRefusedTitle`, `switchRefused`, `switchedToast`. These are inserted as one block after `lastOrderDeltaSame`.
  - **Staff:** one key, `reorder.item.yieldedFrom`, placed right after `alsoFromMany` in all three locales. Spec 200's pass can add its keys next to it without conflict.
- **Browser verification.** I ran a Playwright script from the scratchpad (not committed) against my own `expo start --web --port 8082` on the local stack, as `admin@local.test` / `manager@local.test`. The fixture was Towson on 2026-11-18 (a Wednesday):
  - American Cheese linked to SYSCO (primary) and BJs;
  - both vendors scheduled Wednesday;
  - submitted EODs for both vendors.

  What I saw:
  - **Desktop.** F appears only on SYSCO, as "also from BJs — switch", with no "order from one" line.
  - **Refusal.** With a draft SYSCO PO for D holding F, pressing the switch showed the "Can't switch vendor" toast. No dialog appeared, there was no `set_item_primary_vendor` request, and the DB was unchanged.
  - **Cancel.** The dialog named both vendors and said "permanent for this store"; no write.
  - **Switch.** The RPC fired and the reorder list reloaded. F moved to the BJs card as "also from SYSCO — switch". In the DB:
    - `vendor_id` = BJs, with exactly one `is_primary` link (BJs);
    - the other three stores' rows were unchanged;
    - the audit row was written.
  - **Phone (390 px).** The line and switch render, and switching back via phone worked.
  - **Staff.** "also from BJs — order it here", with no switch.
  - **Console.** No errors; only the existing require-cycle and deprecation warnings.

  The fixture was reverted afterwards. What remains: two local `audit_log` rows, the item's `vendor_changed_at` stamp, and any local notification rows raised by the fixture EOD inserts.
- **Observation (server, for post-impl review; not a frontend issue).** Once F moved off SYSCO's card, SYSCO's vendor badge flipped to STOCK FALLBACK. In this fixture F was the only item in SYSCO's own submission, so this follows R10 (the vendor-level source is computed only from the rows still on the card). Real submissions count every item, so this should be rare.
- **Gates:**
  - Full `npx jest`: 315/315 suites, 4014 tests, run after the backend's `db.ts` landed.
  - `npm run typecheck:test`: exit 0.
  - `npm run typecheck`: only the environmental `TS2688 '<pkg> 2'` errors the backend notes describe. `tsc --noEmit --types <every real @types dir>` exits 0.
  - `e2e/staff-reorder.spec.ts` was **not run**: it needs the e2e global setup and port 8081, which another session's server was holding.

## Files changed (frontend)

- `src/store/useStore.ts`: the `switchItemPrimaryVendor` action plus its interface doc, `PRIMARY_SWITCH_OPEN_ORDER_REFUSAL` and `PrimaryVendorSwitchResult`.
- `src/screens/cmd/lib/primaryVendorSwitch.ts` (new): the shared confirm and toast flow.
- `src/screens/cmd/sections/ReorderSection.tsx`: the yielded-from line and the switch.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: the yielded-from line, plus the switch on the ordering surface only.
- `src/screens/staff/screens/Reorder.tsx`: the text-only yielded-from line.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`: 10 `section.reorder.*` keys.
- `src/screens/staff/i18n/en.json`, `src/screens/staff/i18n/es.json`, `src/screens/staff/i18n/zh-CN.json`: `reorder.item.yieldedFrom`.
- `src/store/useStore.switchItemPrimaryVendor.spec201.test.ts` (new): AC-25, AC-26, AC-27 and the §12 store arms.
- `src/store/useStore.orderPaths.primaryWins.spec201.test.ts` (new): AC-24.
- `src/screens/cmd/sections/__tests__/ReorderSection.primaryWins.spec201.test.tsx` (new): AC-21, plus the component half of AC-25 and AC-26.
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.primaryWins.spec201.test.tsx` (new): AC-22, and text-only on PhoneApproveOrder.
- `src/screens/staff/screens/Reorder.primaryWins.spec201.test.tsx` (new): AC-23, including es/zh-CN rendering and token parity.
- `src/lib/db.reorderYieldedFrom.spec201.test.ts` (new): §12, `mapReorderVendor` maps `yielded_from_vendors`, and an absent key maps to `[]`.
