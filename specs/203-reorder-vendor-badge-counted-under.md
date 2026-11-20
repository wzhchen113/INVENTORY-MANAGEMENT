# Spec 203: Reorder labels a vendor card "counted under {vendor}" instead of STOCK FALLBACK when its numbers were counted under another vendor

Status: READY_FOR_ARCH

Numbering: the main session assigned 203 on 2026-11-19. Sibling sessions are writing 202 and 204.

Origin: spec 201 §13, architect risk **S1**. The owner decided on 2026-11-19: "Accept, relabel later". This spec is that relabel. It is a **follow-up**: it does not edit spec 201's text or its R10 code in place. Where it supersedes a spec 201 rule, it says so explicitly.

PM note on open questions: the owner wasn't available while this spec was written, so every open question below has a **PM default — owner to confirm**. The acceptance criteria are written against those defaults. If the owner overrides one, the ACs that cite that OQ change with it. The architect should not design past an override without re-reading the AC.

## User story

As a store manager ordering for the day, I want a vendor card to say its items were counted under another vendor when that's true. Then I don't think the card fell back to stale stock and recount for nothing, and I still see the last-order deltas I use to sanity-check the order.

## The problem (verified in the tree, 2026-11-19)

### What spec 201 left behind (the accepted S1 risk)

- **Rows can borrow a count.** `report_reorder_list` (latest body: [20261118120000_reorder_primary_wins_borrowed_count.sql](../supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql)) lets an (item, vendor) row borrow a shared item's count from whichever vendor's `submitted` EOD holds it (spec 201 R8/R9, CTE `(4e3) eod_borrow_source`).
  - The rule is the cross-spec contract in spec 201 §2: submitted only, `submitted_at DESC NULLS LAST`, then `id DESC`. It is identical to [borrowedEntries.ts](../src/screens/staff/lib/borrowedEntries.ts).
  - A borrowed row has the right `on_hand`, per-item `item_on_hand_source = 'eod'`, no `eod_missing_for_item` flag, and `on_hand_borrowed_from = {vendor_id, vendor_name}`.
- **The vendor-level fields still follow only the vendor's own entries (R10).**
  - The vendor-level `on_hand_source` is `'eod'` iff any **surfaced** row has `own_item_on_hand_source = 'eod'` (migration L750-751).
  - `eod_submitted_at` is `max(own submitted_at)` (L754).
  - `kpis.eod_sourced_vendor_count` / `stock_fallback_vendor_count` filter on that `on_hand_source` (L869-870).
- **The visible result.** Take a vendor B that **submitted** its own EOD but has **no own-counted row among its surfaced rows**, where at least one surfaced row is borrowed. B's card:
  - badges **STOCK FALLBACK** (`on_hand_source = 'stock'`) even though `eod_submitted_at` is non-null;
  - loses its last-order deltas, because `buildLastOrderContext` gates the delta on `onHandSource === 'eod'` ([lastOrderContext.ts](../src/utils/lastOrderContext.ts) L144);
  - counts toward the stock-fallback KPI, both on the server and in the client's `computeReorderKpis` ([reorderDayFilter.ts](../src/utils/reorderDayFilter.ts) L208-228).

  Every number on the card is a real count. The quantities and every order path are correct.

### The two shapes that produce it

1. **Omit shape (spec 200).** In a **mixed** list, spec 200 R8 leaves an untouched borrowed shared item out of B's submission. If B's own-counted items are all at par, then on the admin below-par payload B's only surfaced rows are the borrowed ones.
   - This is pinned by pgTAP arms (42)-(44), date `ds1o`, in [report_reorder_list_borrowed_count.test.sql](../supabase/tests/report_reorder_list_borrowed_count.test.sql).
2. **Drop shape (spec 201 primary-wins).** On a coincident day, B's own-counted shared item F is dropped from B's card in favour of the primary. B is left with whatever rows remain.
   - **Important correction to the brief.** The pinned drop arms (45)-(46), date `ds1d`, leave B with **G, which is genuinely uncounted.** B submitted without G and no other vendor counted G, so G is case B: `current_stock` plus the `eod_missing_for_item` flag. G is **not** a borrowed row.
   - So "STOCK FALLBACK" is literally true for that fixture: the only number on B's card **is** a stock fallback.
   - The drop shape only becomes a "counted under" case when B's surviving rows are **borrowed**. This spec adds a new fixture for that (AC-2) and, under the PM default for OQ-2c, leaves (45)-(46) unchanged.
   - The spec 201 frontend notes record a third route into the drop shape: a **primary switch**. The old primary's only own count moves to the new primary's card.

### Where it actually shows up

- **Admin mostly.** The admin desktop and phone call the RPC below-par only (`include_stocked = false`), so the vendor rollup sees only below-par rows. That is where a submitted vendor can end up with no own-counted surfaced row.
- **Staff rarely.** The staff screen calls with `include_stocked = true` ([fetchReorder.ts](../src/screens/staff/lib/fetchReorder.ts) L138), so every own-counted row surfaces and B rolls up `'eod'`. The only exception is a vendor whose only own entry was dropped by primary-wins.
  - Spec 200's **all-borrowed** exception submits verbatim copies as B's own entries, so an all-borrowed vendor that **did** submit is `'eod'` everywhere.
- **So the same vendor can badge differently on admin and staff.** That is today's behaviour for `on_hand_source` and isn't changed here (see Out of scope).

### What is mapped today

- **`on_hand_borrowed_from` and `item_on_hand_source` are not mapped** to the client. Spec 201 §7 / D5 deliberately left them as server diagnostics. [db.ts](../src/lib/db.ts) L4791-4792 says so, and [db.reorderYieldedFrom.spec201.test.ts](../src/lib/db.reorderYieldedFrom.spec201.test.ts) L105-107 asserts `itemOnHandSource` / `onHandBorrowedFrom` are absent. The staff mapper ([fetchReorder.ts](../src/screens/staff/lib/fetchReorder.ts)) doesn't map them either.
- **Both mappers coerce the vendor source:** `v?.on_hand_source === 'stock' ? 'stock' : 'eod'` (db.ts L4801, fetchReorder.ts L105). Any new third value would therefore reach **old** clients as `'eod'` (relevant to OQ-1).
- **The server `kpis.eod_sourced_vendor_count` / `stock_fallback_vendor_count` are mapped but never displayed.** Both screens recompute KPIs client-side with `computeReorderKpis` (ReorderSection L1783, staff Reorder L533).

## Hard constraints (from the brief; not open)

- **H1. Spec 130 / spec 201 AC-18 unchanged by default.** A vendor with **no own submission** keeps `eod_submitted_at = null` and `on_hand_source = 'stock'`, and renders spec 130's "count not submitted" card, even when every row is borrowed. Whether it should also get the new label is OQ-6. The PM default is **no change**.
- **H2. The borrow rule is untouched.** CTE `(4e3) eod_borrow_source`, spec 201 §2 and [borrowedEntries.ts](../src/screens/staff/lib/borrowedEntries.ts) are not modified. Server and staff must keep naming the same source.
- **H3. No number moves.** `on_hand`, `suggested_*`, `estimated_cost`, `vendor_total_cost`, `flags`, `needs_order`, card membership (primary-wins), `has_po`, `_warnings`, NO NEED (spec 172) and every order path stay byte-identical for every fixture.

## Open questions (PM default — owner to confirm)

### OQ-1. Shape of the vendor-level signal

- **(A)** A third value, `on_hand_source = 'counted_under'`, plus a vendor-level name list.
  - Old web and EAS bundles would coerce it to `'eod'` through the existing mappers. They'd show an EOD badge and deltas: benign, arguably better than today.
  - But it changes the meaning of `on_hand_source`, which spec 201 R10 and arms (44)/(46) pin. It also widens the `OnHandSource` union, which every `=== 'eod'` / `!== 'eod'` site reads (for example PhoneOrdering L672).
- **(B)** Keep `on_hand_source` as `'eod' | 'stock'` with its R10 meaning. Add one **additive vendor-level key**, for example `counted_under_vendors: [{vendor_id, vendor_name}]`. The server computes it; it is `[]` unless the vendor is in the counted-under state.
  - New clients map it and render the label.
  - Old bundles ignore it and keep today's accepted S1 display: no regression and no new behaviour.
  - Arms (44)/(46) still pass as written.
- **(C)** Client-only, with no migration. Map the per-row `on_hand_borrowed_from` and derive the state on the client: `onHandSource === 'stock' && eodSubmittedAt != null && some row borrowed`.
  - This is exact today. On a submitted vendor every row has its own submission, so any NO NEED row would make the vendor `'eod'`. Each row of a submitted `'stock'` vendor is therefore either borrowed or case B.
  - But it relies on that server-internal invariant, the same kind of fragile payload invariant spec 130's risk section warns about. The server KPIs would also stay as they are.
- **(D)** Restore spec 130's documented invariant: `on_hand_source = 'eod'` iff the vendor has its own submission.
  - It's the simplest change, but it is **not** a "counted under" label. It also relabels the (46) fixture, whose only row really is stock fallback, as EOD.

**PM default: (B).** It is the only option that is purely additive on the wire, keeps R10's `on_hand_source` meaning (the brief's "relabel, not an R10 edit"), and is server-authoritative and pgTAP-pinnable. The architect names the key; `counted_under_vendors` is a suggestion.

### OQ-2. Which cards get the label

Over a vendor's **surfaced** rows for that call, where own = `own_item_on_hand_source = 'eod'`, borrowed = took the borrowed arm, and uncounted = case B/C:

- **(a) Own plus borrowed** (with or without uncounted rows): EOD, unchanged. This keeps today's "any own row" rule.
- **(b) Borrowed plus uncounted, no own:** **counted under.** Uncounted rows keep their per-row EOD-missing flag, just as an EOD card can carry EOD-missing rows today.
  - Alternative: STOCK FALLBACK whenever any row is uncounted.
- **(c) Uncounted only, no own, no borrowed, but the vendor submitted** (the (46) fixture): **STOCK FALLBACK, unchanged.** Every number on that card really is `current_stock`.
  - Alternative: a new "count incomplete" label (new scope).

**PM default:** (a) EOD, (b) counted under, (c) unchanged.

### OQ-3. Label when rows borrow from two or more vendors

- **(a)** List every source name, sorted by name then id and comma-joined: "COUNTED UNDER BJS, SYSCO". This is the same `{vendors}` join that spec 201's `yieldedFrom` and spec 102's `alsoFrom*` already use.
- **(b)** A generic "COUNTED UNDER OTHER VENDORS".
- **(c)** The first name plus "+N".

**PM default: (a).** A shared item has 2-3 vendors in practice, so the list is short. If a source's name is null or empty (a legacy null-vendor submission), use the fallback copy "another vendor" (spec 200's `countedUnderOther` wording). If that is the only source, the whole label is the fallback.

### OQ-4. KPIs

- **(a)** A counted-under vendor counts toward `eod_sourced_vendor_count` and **not** toward `stock_fallback_vendor_count`. This applies both server-side and in `computeReorderKpis`. The two buckets still sum to `vendor_count`.
- **(b)** It stays in stock fallback (today).
- **(c)** A new third bucket, for example `counted_under_vendor_count`, excluded from both.
  - The staff strip ("{count} EOD" with sub "{count} stock fallback") would then stop adding up unless it gains a third line.

**PM default: (a).** The admin "N EOD" and staff "{count} EOD" read as "vendors whose numbers are real counts", which is true here.
- **This supersedes spec 201 R10's third bullet for counted-under vendors only.** Spec 201's text isn't edited. AC-18's never-submitted vendor still counts as stock fallback.
- The server `kpis` key set stays byte-stable: spec 201 primary-wins arm (60).

### OQ-5. Last-order deltas on a counted-under card

- **(a)** Show them, gated per row exactly as on an EOD card. Rows flagged EOD-missing or NO NEED still suppress the delta (lastOrderContext L141-144).
- **(b)** Keep them suppressed.

**PM default: (a).** A borrowed row on a mixed EOD card already gets a delta today, so suppressing it only on counted-under cards would be inconsistent. This affects admin desktop and phone only; the staff screen has no last-order context.

### OQ-6. A vendor that never submitted, with every surfaced row borrowed (spec 201 AC-18)

- **(a)** Keep spec 130's "count not submitted" card exactly as AC-18 pins it: `counted_under_vendors = []`, order actions hidden, and grouped in the top "Count not submitted" group.
- **(b)** Give it the counted-under label too. That re-opens spec 130's baked-in decision: its predicate is `eodSubmittedAt == null`, and it hides the order rows and actions. Order rows and actions would come back for a vendor with no submission.

**PM default: (a).** Spec 200's all-borrowed exception exists precisely so that vendor submits (the verbatim copies). The not-submitted card is the nudge that gets that submission made, and the owner accepted this direction in spec 201 §13.

### OQ-7. Exports

The vendor source appears in the admin text and PDF-HTML builders ([reorderExport.ts](../src/utils/reorderExport.ts) L303, L347, English literals), the admin jsPDF ([ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) L1438-1441, `reorderExport.sourceEod` / `sourceStock`), and the staff text and PDF ([reorderExportStaff.ts](../src/screens/staff/lib/reorderExportStaff.ts) L136-139, L209-212, admin-catalog `reorderExport.*` keys).

- **(a)** Print the same counted-under label as the screen.
- **(b)** Print "EOD".
- **(c)** Unchanged (STOCK FALLBACK).

**PM default: (a).**
- New key `reorderExport.sourceCountedUnder` in the admin catalog (`src/i18n/*.json`), which the staff export already reads.
- `reorderExport.ts` stays English-literal, following its current convention.
- The Sysco / US Foods import planners carry no source column and are unchanged.

### OQ-8. Copy (en / es / zh-CN)

Aligned with spec 200's staff EOD wording (`eod.*.countedUnder` = "Counted under {vendor}" / "Contado con {vendor}" / "已在 {vendor} 下清点"), uppercased where the locale has case, to match the existing badges:

| Surface | Key (architect may rename) | en | es | zh-CN |
|---|---|---|---|---|
| Admin badge, desktop and phone | `section.reorder.sourceCountedUnder` | COUNTED UNDER {vendors} | CONTADO CON {vendors} | 已在 {vendors} 下清点 |
| Admin fallback name | `section.reorder.sourceCountedUnderOther` | another vendor | otro proveedor | 其他供应商 |
| Staff badge | `reorder.source.countedUnder` | COUNTED UNDER {vendors} | CONTADO CON {vendors} | 已在 {vendors} 下清点 |
| Staff fallback name | `reorder.source.countedUnderOther` | another vendor | otro proveedor | 其他供应商 |
| Export (admin catalog) | `reorderExport.sourceCountedUnder` | COUNTED UNDER {vendors} | CONTADO CON {vendors} | 已在 {vendors} 下清点 |

- **The fallback name is a substitute.** When a source name is missing, it fills that one name inside `{vendors}`, so no fragments are `+`-joined (the AC-26 pattern from spec 151).
- **Vendor names stay as stored** (English), like every existing reorder badge.
- **New admin text goes through `T()`** (spec 201 D8). The existing English-literal "EOD" / "STOCK FALLBACK" admin badges are not converted (Out of scope).

**PM default:** the table above. A translator pass on es/zh-CN is welcome but doesn't block.

### OQ-9. Badge tone

- **(a)** Reuse the EOD tone: admin `accent`, phone `ok`, staff `success` / `successBg`. No new theme token in [colors.ts](../src/theme/colors.ts) or [staff theme.ts](../src/screens/staff/theme.ts).
- **(b)** A new distinct tone, which needs new tokens in both palettes and light/dark.

**PM default: (a).** It is a counted state, and violet is reserved for spec 130's "no count".

## Requirements

- **R1. Server signal (OQ-1 B).** `report_reorder_list` adds one additive vendor-level key. The architect names it; `counted_under_vendors` is the suggestion.
  - **Shape:** `[{vendor_id, vendor_name}]`, distinct by `vendor_id`, sorted by `vendor_name` then `vendor_id`.
  - **Always present.**
  - **Non-empty iff all of these hold:**
    1. the vendor has its own `submitted` submission for (store, as-of date) (OQ-6 a);
    2. no surfaced row has `own_item_on_hand_source = 'eod'`;
    3. at least one surfaced row took the borrowed arm (`on_hand_borrowed`).
  - **Contents:** the distinct borrow-source vendors of those borrowed rows (OQ-2, OQ-3).
  - **Computed over the rows that call surfaces**, after the primary-wins drop and the `include_stocked` filter, the same set the existing vendor rollup reads.
- **R2. Unchanged vendor fields.** `on_hand_source`, `eod_submitted_at` and every other vendor key keep their spec 201 values. The per-row diagnostics (`item_on_hand_source`, `on_hand_borrowed_from`) keep their values.
- **R3. KPIs (OQ-4 a).**
  - `kpis.eod_sourced_vendor_count` counts vendors with `on_hand_source = 'eod'` **or** a non-empty R1 key.
  - `kpis.stock_fallback_vendor_count` counts `'stock'` vendors whose R1 key is empty.
  - The `kpis` key set is unchanged.
- **R4. Client type and mappers.**
  - `ReorderVendor` gains an optional `countedUnderVendors?: Array<{ vendorId: string; vendorName: string }>`. Both the admin `mapReorderVendor` (db.ts) and the staff `fetchReorder` mapper map it, and an absent key maps to `[]`.
  - The `OnHandSource` union and both mappers' `on_hand_source` coercion are unchanged.
  - The stale `OnHandSource` doc comment (types L995-999: "manager hasn't counted this vendor yet") is corrected to describe the R10 / own-entry meaning.
- **R5. One shared display-state helper.**
  - It lives in [reorderDayFilter.ts](../src/utils/reorderDayFilter.ts) next to `isReorderCountNotSubmitted`. The architect names it; a suggestion is `reorderVendorSourceState(vendor) → 'not_submitted' | 'eod' | 'counted_under' | 'stock'`.
  - **`'not_submitted'`** is exactly `isReorderCountNotSubmitted` (unchanged), and it takes precedence.
  - **`'counted_under'`** is a non-empty `countedUnderVendors`.
  - Every badge, delta gate, KPI and export site reads it, with no inline re-derivation. This mirrors spec 130's `isReorderCountNotSubmitted` / spec 123's `vendorHasPo`.
- **R6. Surfaces.**
  - **Admin desktop** (ReorderSection `sourceBadgeEl`, L749-752): the counted-under badge replaces STOCK FALLBACK.
  - **Admin phone** (PhoneOrdering `statusBadgeFor`, L670-680): the same. This reaches PhoneApproveOrder through the shared `VendorOrderCard`.
  - **Staff** (Reorder `VendorCard`, L164-167): the same.
  - **Tone:** OQ-9. **Copy:** OQ-8.
  - A counted-under card is otherwise a normal counted card: item rows, order actions, its needs/enough split placement and its "Count not submitted" group exclusion are all as today.
- **R7. Deltas (OQ-5 a).** `buildLastOrderContext`'s vendor gate admits `'eod'` and `'counted_under'`. The per-row EOD-missing / NO NEED suppression is unchanged.
- **R8. Client KPIs (OQ-4 a).** `computeReorderKpis` counts a counted-under vendor in `eodSourcedVendorCount`, not `stockFallbackVendorCount`.
- **R9. Exports (OQ-7 a).** All five export source-label sites print the counted-under label for a counted-under vendor.

## Acceptance criteria

Fixture terms:
- **Store S; as-of date D.**
- **F** is shared by A (primary) and B.
- **K** is shared by B and C, with C not coincident.
- **G** and **M** are linked to B only.
  - The letter M avoids the existing suite's H (C only) and J (A only).
- Items are below par unless stated. "B's surfaced rows are only X" means every other B-linked item is at par or has no `item_vendors` link in that scenario.
- **"As the 201 body"** means the value [20261118120000](../supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql) returns for the same fixture, or the latest body at build time.
- These ACs assume the PM defaults. Overrides change the ACs that cite the OQ.

### Server (pgTAP; extend `report_reorder_list_borrowed_count.test.sql` or a sibling the architect names)

- [ ] **AC-1 (omit shape, arms (42)-(44) fixture `ds1o`).** On the admin call (`include_stocked` false), B has `on_hand_source = 'stock'` and `eod_submitted_at` = B's own time, as before, and the R1 key is `[{A}]`.
  - `kpis.eod_sourced_vendor_count` includes B; `stock_fallback_vendor_count` excludes B.
- [ ] **AC-2 (drop shape with a borrowed survivor, new fixture).** A and B are coincident. B submitted `{F = 4}` only. C submitted `{K = 3}`.
  - B's surfaced rows are only K, borrowed from C. B's R1 key is `[{C}]`, `on_hand_source = 'stock'`, and `eod_submitted_at` is non-null.
- [ ] **AC-3 (drop shape with an uncounted survivor, fixture `ds1d`, OQ-2c).** B's R1 key is `[]` and B counts as stock fallback in `kpis`. Arms (45)-(46) pass with their assertions unchanged.
- [ ] **AC-4 (own plus borrowed, OQ-2a).** B submitted `{M}` (M below par), and F is borrowed from A. B is `'eod'` with the R1 key `[]`.
- [ ] **AC-5 (borrowed plus uncounted, OQ-2b).** B submitted `{G at par}`. F is borrowed from A, and M is below par with no entry anywhere.
  - The R1 key is `[{A}]`.
  - M keeps `eod_missing_for_item`.
- [ ] **AC-6 (two sources, OQ-3).** B's surfaced rows borrow F from A and K from C. The R1 key is `[{A}, {C}]`, sorted by name then id, with no duplicate when two rows borrow from the same vendor.
- [ ] **AC-7 (never submitted, H1 / OQ-6a).** This is spec 201's AC-18 fixture.
  - B's R1 key is `[]`, `on_hand_source = 'stock'`, and `eod_submitted_at` is null.
  - Arms (29)-(36) pass unchanged.
- [ ] **AC-8 (`include_stocked`).** On the AC-1 fixture with `include_stocked = true`, B's at-par own G surfaces, so B is `'eod'` with the R1 key `[]`.
- [ ] **AC-9 (nothing else moves, H3).** For every scenario in the borrowed-count and primary-wins suites, every per-row key and value and every pre-existing vendor key and value equal the 201 body's. The only additions are the R1 key and the R3 KPI re-bucketing.
  - The architect states how this is proved, for example a same-transaction diff against the 201 body, as spec 201's mutation check did.
- [ ] **AC-10 (borrow rule untouched, H2).** CTE `(4e3)` is byte-identical to the 201 body, and `src/screens/staff/lib/borrowedEntries.ts` has no diff.
- [ ] **AC-11 (posture).**
  - Signature, `prosecdef = false`, `proconfig` and the ACL are unchanged; `reports_anon_revoke.test.sql` passes.
  - The `kpis` key set is unchanged: primary-wins arm (60).
  - Every existing `report_reorder_list_*`, `eod_no_need` and `po_loop` (P) arm passes.
  - Arms (44) and (46) keep their assertions. Only their descriptions drop "(pinned, accepted)" and cite this spec.

### Client (jest)

- [ ] **AC-12 (mappers).** The admin `fetchReorderSuggestions` and staff `fetchStaffReorder` map the R1 key to `countedUnderVendors` (camelCase, order kept). An absent key maps to `[]`, and `onHandSource` coercion is unchanged.
- [ ] **AC-13 (helper).** The R5 helper returns:
  - `'not_submitted'` for null `eodSubmittedAt`, even with a non-empty list;
  - `'eod'` for `'eod'`;
  - `'counted_under'` for `'stock'` plus non-null `eodSubmittedAt` plus a non-empty list;
  - `'stock'` otherwise.
- [ ] **AC-14 (admin desktop).** A counted-under vendor renders the counted-under badge with names per OQ-3 and doesn't render "STOCK FALLBACK".
  - Its item rows and `reorder-create-po-*` / quick-order / CSV / PDF actions render as for an EOD vendor.
  - It isn't in the "Count not submitted" group.
- [ ] **AC-15 (admin phone).** `statusBadgeFor` returns the counted-under label with the OQ-9 tone. PhoneApproveOrder shows the same badge.
- [ ] **AC-16 (staff).** The staff `VendorCard` renders the localized counted-under badge in en, es and zh-CN with the OQ-9 tone, and does not render `reorder.source.stockFallback`.
- [ ] **AC-17 (fallback name).** A source with an empty or null name renders the localized "another vendor" inside the label on all three surfaces.
- [ ] **AC-18 (deltas, OQ-5).** On a counted-under card, a row with a last-order count and no EOD-missing / NO NEED flag renders its delta. A flagged row doesn't. A `'stock'` card with an empty list still renders none.
- [ ] **AC-19 (KPIs, OQ-4).** `computeReorderKpis` counts a counted-under vendor in `eodSourcedVendorCount` and not in `stockFallbackVendorCount`. The admin "N EOD" stat and the staff `reorder.kpi.sourceValue` / `sourceSub` reflect this.
- [ ] **AC-20 (exports, OQ-7).** For a counted-under vendor:
  - `buildReorderText` / `buildReorderPdfHtml`, the admin jsPDF builder, and the staff text/PDF builders print the counted-under label.
  - Existing export snapshots, whose fixtures have no counted-under vendor, are byte-unchanged.
- [ ] **AC-21 (spec 130 untouched).** A never-submitted vendor whose rows are all borrowed still renders `reorder-count-not-submitted-*` / `staff-reorder-count-not-submitted-*`, with no badge change and no actions.
- [ ] **AC-22 (old-server payload).** A payload without the R1 key renders exactly as today on all three surfaces, including STOCK FALLBACK for a submitted `'stock'` vendor.
- [ ] **AC-23 (i18n).** The OQ-8 keys exist in all three locales of both catalogs with identical tokens, and the admin and staff i18n parity suites pass.
- [ ] **AC-24 (gates).** The full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and the full pgTAP run pass.
  - Re-grep for tests pinning "STOCK FALLBACK" on a submitted vendor and for the spec 201 jest files named below. Any arm that pins the old S1 display is **rewritten, not deleted**, and listed under `## Files changed`.

No shell smoke: the RPC's HTTP mapping doesn't change.

## In scope

- **One migration** with `create or replace function public.report_reorder_list` (same signature), built verbatim from the latest body at build time plus the R1 and R3 hunks.
  - Today the latest body is 20261118120000. Re-glob first: specs 188/192/196 and siblings 202/204 may have landed something newer.
  - The header covers prod apply (MCP, normalized-md5 pre-check and post-check, the `schema_migrations` insert), rollback (re-apply the prior body; it's function-only) and the realtime "none" note.
- The `ReorderVendor` type, both mappers, and the R5 helper.
- Badge changes on ReorderSection, PhoneOrdering (and through it PhoneApproveOrder) and staff Reorder.
- The delta gate (R7), `computeReorderKpis` (R8), and the five export sites (R9).
- Admin and staff i18n keys (OQ-8).
- pgTAP AC-1 to AC-11 and jest AC-12 to AC-24.

## Out of scope (explicitly)

- **Any change to the borrow rule** (H2), to spec 200's omit / all-borrowed payload rules, or to the staff EOD screen. This spec only reads what spec 201 already computes.
- **Relabelling the never-submitted vendor** (OQ-6 b, not the default). It would re-open spec 130.
- **A "count incomplete" label for a submitted vendor whose surfaced rows are all uncounted** (OQ-2c alternative; the (46) fixture). Its numbers really are stock fallback.
- **A per-row "counted under {vendor}" hint on reorder item rows,** for example on mixed EOD cards. The goal is the vendor badge. The per-row diagnostic stays unmapped unless the architect needs it for R1.
- **Making the vendor badge agree between the admin (below-par) and staff (`include_stocked`) calls.** It is computed over surfaced rows today, and that's unchanged.
- **Restoring spec 130's `eodSubmittedAt == null ⇔ 'stock'` payload invariant** (OQ-1 D). Spec 130's helper keys off `eodSubmittedAt` alone and is unaffected.
- **Converting the existing English-literal "EOD" / "STOCK FALLBACK" admin badges to `T()`.** Only new text is localized.
- **`report_reorder_for_counted_onhand` (spec 105), `report_weekly_lowstock`, and `eod_vendor_has_below_par` (spec 149).** They are separate engines.
- **The `app.json` slug.** It isn't touched.

## Open questions resolved

- Q: Should the relabel edit spec 201 R10 in place? → A: No. It's a follow-up spec. `on_hand_source` keeps R10's meaning, and only the KPI bucket is superseded, for counted-under vendors only (OQ-4). (Brief, 2026-11-19.)
- Q: Can the borrow rule change? → A: No (H2).
- Q: Can quantities, suggestions, order paths or NO NEED change? → A: No (H3).
- Q: Does a never-submitted vendor keep spec 130's card? → A: Default yes (H1). The owner confirms via OQ-6.
- OQ-1 to OQ-9: **PM default — owner to confirm** (see above).

## Dependencies

- **Spec 201** (`report_reorder_list` body with `own_item_on_hand_source`, `on_hand_borrowed`, `borrowed_vendor_id/_name` and `on_hand_borrowed_from`). **Its migration 20261118120000 must be on prod before this spec's migration.** 201 is `READY_FOR_REVIEW` and its prod apply is still owner-pending. This spec's pre-check md5 is taken against whatever body is on prod at apply time.
- **Spec 200** (the omit shape that makes AC-1 common). There is no hard ordering: this spec only relabels.
- **Spec 130** (the count-not-submitted card and the `isReorderCountNotSubmitted` predicate, both unchanged).
- **Spec 151** (`buildLastOrderContext` delta gate), **spec 172** (NO NEED), **spec 123/183** (admin and phone export paths) and **spec 087** (the client KPI recompute).
- **Sibling specs 202/204.** If either replaces `report_reorder_list`, whichever lands second carries the other's hunks.
- No library or edge-function dependency.

## Project-specific notes

- **Cmd UI section:** [ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) and phone [PhoneOrdering.tsx](../src/screens/cmd/sections/phone/PhoneOrdering.tsx) (PhoneApproveOrder inherits). Staff peer: [Reorder.tsx](../src/screens/staff/screens/Reorder.tsx). There is no legacy surface.
- **Which app:** the admin Cmd UI and the staff Reorder screen, both in this repo (spec 063).
- **Per-store or admin-global:** per-store. The RPC is gated by `auth_can_see_store(p_store_id)`, and R1 reads only rows the RPC already computes at store grain. No RLS change.
- **Edge function or PostgREST:** a PostgREST RPC (`create or replace`, read-only). No edge function.
- **Realtime channels touched:** none. It's a read-only function change with no publication change, so the `docker restart supabase_realtime_imr-inventory` gotcha doesn't apply.
- **Migrations needed:** yes, one, function-only (under OQ-1 B; none under OQ-1 C).
- **Edge functions touched:** none.
- **Web/native scope:** both.
  - The server key is additive, so old web and EAS bundles ignore it and keep today's S1 display (AC-22).
  - The label arrives with the next Vercel deploy and the next EAS build of the staff app.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-11) and jest (AC-12 to AC-24). No shell smoke.
- **Spec 201 tests likely to need deliberate edits:**
  - pgTAP arms (44) and (46): description only under the defaults.
  - [db.reorderYieldedFrom.spec201.test.ts](../src/lib/db.reorderYieldedFrom.spec201.test.ts) L105-107: only if the architect maps the per-row `on_hand_borrowed_from` (OQ-1 C).
  - [Reorder.primaryWins.spec201.test.tsx](../src/screens/staff/screens/Reorder.primaryWins.spec201.test.tsx): its fixture is `'eod'`, so it should pass unchanged, but re-check it.
  - The staff [Reorder.test.tsx](../src/screens/staff/screens/Reorder.test.tsx) L410 STOCK FALLBACK arm stays valid only while its fixture has no counted-under list.

## Residual risk

- **Old staff native bundles** keep showing STOCK FALLBACK on counted-under cards until users update. This is the already-accepted S1 display, not a regression.
- **The OQ-2b label sits next to EOD-missing rows.** A counted-under card can carry a flagged, genuinely uncounted row. The per-row flag tells the truth, just as on an EOD card today.
- **The admin and staff badges can differ** for the same vendor and date, because the two calls surface different row sets. This predates this spec.
