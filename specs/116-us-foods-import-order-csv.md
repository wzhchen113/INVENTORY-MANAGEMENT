# Spec 116: US Foods "Import Order" CSV export

Status: READY_FOR_REVIEW

> Retroactive spec. This feature was built directly and is STAGED (uncommitted)
> at the time of writing. The spec documents intended behavior so the staged
> implementation can be reviewed against testable criteria before commit. Owner
> decisions were captured via direct Q&A (see "Open questions resolved"); no
> further blocking questions remain.

## User story
As a store manager for a US-Foods-supplied 2AM PROJECT store, I want the reorder
CSV export for my US Foods vendor to produce a file in the US Foods MOXē "Import
Order" upload format so that I can upload my reorder directly into US Foods
instead of re-keying every line by hand.

## Acceptance criteria
- [ ] `vendors` gains three additive nullable columns via migration
  `20260712000000_vendor_import_order_fields.sql`: `order_import_format` (text
  tag, NULL = none / `'us_foods'`), `import_distributor_number` (text),
  `import_department` (text). No default; a vendor with none set behaves exactly
  as before.
- [ ] `VendorFormDrawer` shows an "Order import format" segmented control
  (None / US Foods). Selecting "US Foods" reveals editable "Distributor #" and
  "Department" fields. CUSTOMER NUMBER is NOT a new field — it reuses the
  existing "Account #".
- [ ] `db.ts` `fetchVendors` maps `order_import_format` →
  `orderImportFormat` (undefined when null), `import_distributor_number` →
  `importDistributorNumber`, `import_department` → `importDepartment`.
- [ ] `db.ts` `createVendor` and `updateVendor` both persist the three new
  fields; empty string on update clears the column to NULL.
- [ ] `db.ts` `updateVendor` persists `accountNumber` edits (latent bug: it was
  previously written only on create, so editing "Account #" silently no-oped on
  update). Empty string clears to NULL.
- [ ] `buildUsFoodsImportCsv(items, header, orderCodeFor)` is a pure function
  (no DOM/theme/supabase) that emits the exact 19-column template header in the
  template's column order.
- [ ] Only ordered items are written: `needsOrder !== false` AND
  (`suggestedCases > 0` OR `suggestedQty > 0`). At/above-par items are excluded
  and are NOT counted as skipped.
- [ ] An ordered item with no resolvable `order_code` is SKIPPED (never emitted
  with a blank PRODUCT NUMBER) and counted in `skippedNoCode`.
- [ ] Case-sized items (`suggestedCases != null`) write CS = `suggestedCases`,
  EA = 0. No-case items write CS = 0, EA = `suggestedQty`.
- [ ] DATE renders as M/D/YYYY (no leading zeros) from the `YYYY-MM-DD`
  `asOfDate`; DEPARTMENT defaults to `'0'` when blank; PRODUCT NUMBER is the
  per-(item, vendor) `order_code`; DESCRIPTION is the item name; EXTENDED PRICE
  is the server-rounded `estimatedCost`.
- [ ] An empty order still yields a valid header-only file (header row present,
  zero data rows).
- [ ] In `ReorderSection`, `onCsvPress` detects whether any displayed reorder
  vendor has `orderImportFormat === 'us_foods'`; if so it emits that vendor's
  Import-Order file named `USFoods_ImportOrder_<store-slug>_<date>.csv` instead
  of the generic reorder CSV. Otherwise the generic CSV path is unchanged.
- [ ] The US Foods export toast reports the included count and, when > 0, the
  skipped-no-code count.
- [ ] jest: `usFoodsImport.test.ts` covers header shape, case→CS mapping,
  no-case→EA mapping, skip-no-code counting, exclude-have-enough, and
  header-only empty file. Full jest suite stays green.

## In scope
- The migration, the pure CSV builder + its unit test, the `db.ts` vendor
  field mapping (3 new fields), the bundled `account_number`-on-update fix,
  the `VendorFormDrawer` segmented control + conditional header fields, and the
  `ReorderSection` branch that swaps the generic CSV for the US Foods file.
- Populating the optional/informational columns (DESCRIPTION, PACK SIZE,
  CS PRICE, EA PRICE, EXTENDED PRICE) for human review even though US Foods
  ignores them on upload.

## Out of scope (explicitly)
- The data step that wrote 36 order codes across 141 US FOOD `item_vendors`
  links in all 4 stores — already DONE in prod, not part of the staged code.
- Any second vendor format (e.g. Sysco). The `order_import_format` text tag is
  designed so a new format is a value + a new builder, not a schema change, but
  no other format is built here.
- Multi-vendor single-file export. The US Foods import is inherently
  single-vendor; if the day-filter ever shows US FOOD alongside other vendors,
  the emitted file contains only US FOOD items (see Risk 1).
- Backfilling $0 costs on the newly created US FOOD links (see Risk 2). Prices
  are informational and ignored by US Foods on upload.
- Any change to the reorder engine (`report_reorder_list`) or the generic
  reorder export path for non-US-Foods vendors.
- Editing PO NUMBER / CUST PROD # / BRAND per line (left blank).

## Open questions resolved
- Q: Where do CUSTOMER NUMBER / DISTRIBUTOR / DEPARTMENT come from? →
  A: Editable vendor fields. CUSTOMER NUMBER reuses existing `account_number`;
  DISTRIBUTOR and DEPARTMENT are the two new columns.
- Q: Extra button or replacement? → A: The US Foods CSV REPLACES the generic
  reorder CSV for a US-Foods-configured vendor (same button, branched behavior).
- Q: Populate the optional/price columns US Foods ignores? → A: Yes, for
  human readability.
- Q: How is PRODUCT NUMBER resolved? → A: The per-(item, vendor) `order_code`
  from spec 114, read off the hydrated inventory rows (same pattern as the
  quick-order path).

## Dependencies
- Spec 114 — per-vendor `item_vendors.order_code` SKU mapping + universal
  quick-order list. PRODUCT NUMBER is that order code.
- Spec 102 — multi-vendor ingredients (an item can link to multiple vendors;
  the resolver picks the US FOOD link).
- The reorder engine `report_reorder_list` (payload shape: `ReorderPayload`,
  `ReorderItem` with `suggestedCases` / `suggestedQty` / `estimatedCost`).
- Commit d66d6d2 (localized reorder downloads) — this branch coexists with it
  on the generic-CSV path.
- Existing `reorderExport.ts` helpers (`formatQty`, `triggerDownload`,
  `slugifyStore`, `todayLocalIso`).

## Risks (assess in review)
1. **Single-vendor file when multiple vendors displayed.** If the reorder
   day-filter shows US FOOD alongside other vendors, the emitted US Foods file
   contains only US FOOD items; the other vendors' rows are dropped from that
   CSV. `onCsvPress` picks the FIRST US-Foods vendor found. Typically the
   day-filter isolates one vendor, so acceptable — but there is no UI cue that
   other vendors were omitted. Consider whether a toast note is warranted.
2. **$0 prices on newly created links.** New US FOOD links start at $0 cost, so
   CS/EA/EXTENDED PRICE render as `0.00` until pricing is entered. US Foods
   ignores prices on upload, so functionally harmless; cosmetic only.
3. **No live click-through.** Builder unit tests (6) pass, full jest (1136)
   green, typecheck clean, and a CSV was rendered from live RPC data matching
   the template — but a browser click-through of the Vendors form + reorder
   button was NOT completed (preview-tool flakiness). The form control and the
   button branch have no automated UI coverage.

## Project-specific notes
- Cmd UI section / legacy: admin Cmd UI — `src/screens/cmd/sections/ReorderSection.tsx`
  and `src/components/cmd/VendorFormDrawer.tsx`. No legacy surface.
- Per-store or admin-global: vendor is brand-shared (US FOOD spans the 4 stores);
  the exported file is per-store (store slug + store's reorder items). Vendor RLS
  already gates the new columns under brand visibility — no RLS change.
- Realtime channels touched: none. Vendor edits already flow through existing
  channels; no new publication.
- Migrations needed: yes — `20260712000000_vendor_import_order_fields.sql`
  (additive, nullable; already applied to prod + recorded in schema_migrations
  per the staged state).
- Edge functions touched: none. Pure client-side CSV build; vendor writes via
  PostgREST through `db.ts`.
- Web/native scope: the export uses `Blob` + `triggerDownload` (web download).
  The vendor form control is cross-platform; the file-download button is
  effectively web (consistent with the existing generic reorder CSV export).
- Tests: jest track — `src/utils/usFoodsImport.test.ts` (builder) and the
  existing `src/lib/db.updateVendor.test.ts` (vendor UPDATE persistence). No
  pgTAP change required (additive nullable columns, no policy/logic change).
```
