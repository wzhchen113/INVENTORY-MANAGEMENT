# Spec 201: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-11-18.
Scope: the implementation compared with `## Backend design` §1-§13 in [specs/201-reorder-shared-item-primary-vendor-wins.md](../../201-reorder-shared-item-primary-vendor-wins.md).

**Method note.** This reviewer had no shell, so `git diff --cached` could not be run. Each changed file was read in the working tree. The migration body was compared hunk by hunk against the baseline [20261024000000_eod_entries_no_need.sql](../../../supabase/migrations/20261024000000_eod_entries_no_need.sql) L319-999. The (4f) CASE expressions and the (4l) rollup were compared line by line. Untouched CTEs were spot-checked; this was not a mechanical byte diff. Before prod apply, the release coordinator should still rely on the developer's baseline diff ("only three removed lines, all replaced in place") and on the md5 pre-check and post-check in the migration header.

## Verdict

**No contract drift.** Both migrations, the `db.ts` surface, the `ReorderItem` type, the staff mapper and the `switchItemPrimaryVendor` store action match §1-§9.

- **Critical:** 0
- **Should-fix:** 1. A design-documentation gap I own, not developer drift: the vendor-level badge question raised by the frontend.
- **Minor:** 4

## Contract conformance (checked, no finding)

### Migration 1: [20261118120000_reorder_primary_wins_borrowed_count.sql](../../../supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql)
- **Hunk B1** (L259-272) matches §3: `distinct on (e.item_id)` over `latest_eod_per_vendor`, `actual_remaining is not null`, ordered by `submitted_at desc nulls last, submission_id desc`. This is the §2 cross-spec contract.
- **Hunk B2** (L311-384):
  - (a) The borrowed arm sits between own case A and `current_stock`.
  - (b) `own_item_on_hand_source` is byte-identical to the baseline `item_on_hand_source` (baseline L515-523).
  - (c), (d) and (e) are as designed.
  - `submission_id` / `submitted_at` stay the row's own `lev.*` values (R10).
  - `no_need_for_item` is untouched (R11).
- **Hunk P1** (L539-581): `order_out_today` joins `vendor_delivery ... and vd.schedule_known` (D2/C3) and uses `lower(btrim(day_of_week))` (AC-11). `item_primary_wins` reads `ii.vendor_id` (D1) and has `having count(*) >= 2 and bool_or(iv.vendor_id = ii.vendor_id)`. A null or dangling `vendor_id` falls through to OQ-4.
- **Hunk P2** (L660-671): the drop sits in `per_item`, upstream of `per_item_filtered` (so AC-5 holds in both `needs_order` states) and of `vendors_with_items`, `kpi_calc`, `has_po` and `_warnings` (R4). Both new left joins are distinct-keyed, so there is no fan-out.
- **Hunk V** (L750, L812-818):
  - The vendor-level `bool_or` reads `own_item_on_hand_source`.
  - The three additive keys are appended after `also_from_vendors`.
  - `on_hand_borrowed_from` is a JSON null when the row did not borrow.
- **Posture:** the signature is unchanged and the function is invoker. `SET search_path TO 'public'` is kept, and grants are not re-emitted. The (4g) spec 138 `where false` is untouched.
- **Header:** covers the hunk list, RLS, realtime (no publication change, so no `docker restart supabase_realtime_imr-inventory`), prod apply with md5 checks, the required spec 200 sequencing wording, and rollback.

### Migration 2: [20261118120100_set_item_primary_vendor.sql](../../../supabase/migrations/20261118120100_set_item_primary_vendor.sql)
- All guards follow §5 steps 1-7 in order, and every one fires before the first write.
- The error strings and SQLSTATEs are byte-exact to §5.
- `for update` lock on the item row.
- The no-op returns `changed: false` without repairing `is_primary` drift (R3).
- The 3c predicate is keyed exactly like `has_po`.
- Writes are demote, then promote, then scalar (spec 124 order).
- Grants: `revoke ... from public, anon; grant ... to authenticated`.
- **RLS:** invoker. `store_member_update_inventory_items` and `store_member_update_item_vendors` both resolve through `auth_can_see_store` ([20260504173035](../../../supabase/migrations/20260504173035_per_store_rls_hardening.sql) L54-57, [20260630000000](../../../supabase/migrations/20260630000000_item_vendors.sql) L131-137). Brand-scoped admins therefore pass both the `FOR UPDATE` lock and the writes.

### `src/lib/db.ts`
- `mapReorderVendor` (L4793-4798) maps `yielded_from_vendors` to `yieldedFromVendors` with `[]` as the fallback. The diagnostic keys are deliberately not mapped (§7).
- `setItemPrimaryVendor` (L4838-4859): write, label `setItemPrimaryVendor`; throws the raw error; snake_case → camelCase.
- `isItemOnOpenOrder` (L4870-4892): read, label `isItemOnOpenOrder`; uses the `po_items` → `purchase_orders!inner` embedded filter with `neq status cancelled`, and throws on error.
- Signatures match §7 exactly.
- No new direct `supabase.from` / `rpc` call was added outside `db.ts`. The staff mapper is inside the documented `src/screens/staff/` carve-out.

### Types and staff mapper
- `ReorderItem.yieldedFromVendors?` is in [src/types/index.ts](../../../src/types/index.ts) L1079-1091.
- The `eod_missing_for_item` doc is corrected (L1012-1017).
- The staff mapper [fetchReorder.ts](../../../src/screens/staff/lib/fetchReorder.ts) L93-102 is identical to the admin mapping.

### Store action: [useStore.ts](../../../src/store/useStore.ts) L2624-2692
Follows §8 steps 1-5:
1. The pre-check fails closed before the confirm.
2. Cancel writes nothing.
3. The `inventory` row is patched optimistically, including the `isPrimary` mirror.
4. The 3c substring maps to revert plus `'refused'` with no toast. Any other error maps to revert plus `notifyBackendError` plus `'failed'`.
5. On success: an awaited `loadReorderSuggestions(asOfDate)`, then an `'Item edit'` audit event.

`reorderPayload` is not patched optimistically (§8). The pre-check's `fromVendorId` is the card's vendor. A yielded row only exists on the primary's card, so this equals the RPC's `v_prev`, and the client pre-check and the server backstop key on the same vendor.

### UI (§9)
- Desktop and phone use the `reorder-yielded-from-*` / `reorder-switch-primary-*-*` testIDs.
- There is one switch per yielded vendor, and every new string goes through `T()` (D8).
- The old "order from one" line is unchanged on every other row.
- Staff get text only.
- `confirmAction` is wrapped with `onCancel` passed, so the busy flag is released on Cancel and on Android dismiss.

## Question 1: is the badge flip to STOCK FALLBACK intended?

**The implementation is not drifting. This is the designed outcome of R10 combined with D4, and the frontend's fixture produced a truthful badge.** My §13 did not call out this direction, though, so one documentation and test item is filed below.

**Why it happens.** The vendor-level `on_hand_source` has always been `bool_or` over **the rows on the card**, meaning `per_item_filtered`, which comes after the below-par filter. Baseline L837 already reads `bool_or(pif.item_on_hand_source = 'eod')`.

- **The baseline already does this.** A vendor that submitted, but whose own-counted items are all at par (filtered out) and whose surfaced rows are all uncounted, already badges STOCK FALLBACK.
- **What spec 201 changes.** It keeps that semantic ("exactly as today", R10). D4 places the primary-wins drop upstream of `vendors_with_items` "with no further edit". So when F, SYSCO's only own-counted row, leaves SYSCO's card, SYSCO's remaining rows are own case B. They carry the `eod_missing_for_item` flag and on-hand from `current_stock`. **STOCK FALLBACK is literally true for those numbers**, and `eod_submitted_at` stays non-null, so spec 130's "count not submitted" state is correctly *not* shown.

**Where the badge stops being truthful.** The frontend's reassurance, "Real submissions count every item, so this should be rare", no longer holds once spec 200 ships. Under spec 200 OQ-1a, a second vendor's submission **omits** shared items already counted under another vendor. Take a backup vendor whose surfaced items are all shared (a club store backing up a broadline distributor):

1. Its card rows are all **borrowed**: `on_hand` is an EOD count and there is no flag.
2. R10 forbids borrowed rows from making the vendor `'eod'`.
3. So the card badges STOCK FALLBACK on desktop (with "eod counted: <time>" next to it) and on phone ([PhoneOrdering.tsx](../../../src/screens/cmd/sections/phone/PhoneOrdering.tsx) L670). It also counts toward `stock_fallback_vendor_count`.
4. It suppresses the spec 151 last-order delta for every row ([lastOrderContext.ts](../../../src/utils/lastOrderContext.ts) L144), even though every number on the card is a real count.

Quantities and order paths are correct; only the label and the delta are affected. R10's own rationale only considered the *never-submitted* direction ("a vendor whose every row was borrowed ... and so never submitted"). The submitted-but-everything-borrowed direction was not decided explicitly by the PM or by my §13.

## Findings

### Critical

None.

### Should-fix

**S1. Document the vendor-badge consequence of R10 + D4 and pin it in pgTAP (no behaviour change).** This is a design gap I own: §13's "Spec 130 interplay" bullet covers only the never-submitted direction.
- **Spec:** add a §13 risk bullet. A vendor that submitted, but whose surfaced rows are all non-own-EOD (dropped by primary-wins, below par, or borrowed under spec 200's omit), badges STOCK FALLBACK with a non-null `eod_submitted_at`, and its last-order deltas are suppressed. Quantities are correct. A relabel would be a follow-up spec, for example a third vendor-level token or "counted under {vendor}" using the unmapped `on_hand_borrowed_from` diagnostic. It must not be done by editing R10 inside 201, because AC-18 pins the never-submitted direction.
- **Test:** add one arm to [report_reorder_list_primary_wins.test.sql](../../../supabase/tests/report_reorder_list_primary_wins.test.sql). Use the coincident fixture where B's only own-counted item is F, with B having one other below-par uncounted item. Assert that B's `on_hand_source = 'stock'` and `eod_submitted_at` is non-null. Today no arm pins the vendor-level source under the drop: `on_hand_source` is not asserted anywhere in that suite, and only AC-10 asserts `eod_submitted_at`. Any later change will then be deliberate.
- **Release coordinator:** surface this to the owner as an informed-acceptance item that comes with spec 200.

### Minor

**M1. The text-only switch on PhoneApproveOrder: ratified as consistent with §9.**
- **Why it's consistent.** §9 and R7 name the switch surfaces as ReorderSection and PhoneOrdering. The spec's project notes say PhoneApproveOrder "inherits the change through the payload", meaning the row drop, not the control.
- **Why text-only is right.** The approve screen is a single-vendor approval flow reached from the spec 149 notification. A switch there would move the item off the very order being approved, and the post-switch reload would reshape the payload under the approval. 3c would not stop it either, because no PO exists yet before approval.
- **Implementation detail.** The choice is keyed on `footer === 'default'` ([PhoneOrdering.tsx](../../../src/screens/cmd/sections/phone/PhoneOrdering.tsx) L215). Today only [PhoneApproveOrder.tsx](../../../src/screens/cmd/sections/phone/PhoneApproveOrder.tsx) L425 passes `footer="none"`, so this is correct. It does overload a layout prop with a behaviour gate.
- **Suggestions:** an explicit `allowPrimarySwitch?: boolean` prop (default true) would make the intent self-documenting. Record the decision in the spec's §9 as an addendum.

**M2. A stale equivalence claim in [reorderDayFilter.ts](../../../src/utils/reorderDayFilter.ts) L197-199.** The comment says `eodSubmittedAt == null` is "equivalent to `onHandSource === 'stock'` per the payload contract".
- This was already untrue in the baseline: a submitted vendor whose rows are all case B badges `'stock'`.
- Spec 201 and spec 200 widen the gap (S1).
- The code correctly keys on `eodSubmittedAt`; only the comment is wrong. Reword it to say "implies, not equivalent".

**M3. Refusal copy says "today's".** `section.reorder.switchRefused` reads "{item} is already on today's {from} order" ([en.json](../../../src/i18n/en.json) L1349). The check keys on the envelope's `asOfDate`, not on "today". These are the same in normal use (store-local today), but they would diverge if the as-of date were ever not today. This is a wording nit only, and the wording is the frontend's call per §9.

**M4. The inherited (4f) header comment** ([migration 1](../../../supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql) L276-283) still describes case B and case C as resolving to `current_stock`. That is now only true when there is no borrow source. It was copied verbatim from the baseline by design, and Hunk B2 is documented inline below it, so this is an optional one-line pointer ("see Hunk B2(a)"). It is not a drift finding.

## Prod-apply reminder (no finding)

- Apply both migrations together, before the spec 201 admin client deploys and before any spec 200 client push. The headers state this correctly.
- No publication change, so the realtime restart ritual does not apply.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (S1: document and pgTAP-pin the vendor-badge consequence of R10 + D4; no behaviour change; owner informed-acceptance with spec 200), 4 Minor (M1: PhoneApproveOrder text-only switch ratified, with an optional explicit prop and a §9 addendum; M2: stale reorderDayFilter comment; M3: "today's" in the refusal copy; M4: inherited (4f) comment pointer).
payload_paths:
  - specs/201-reorder-shared-item-primary-vendor-wins/reviews/backend-architect.md
