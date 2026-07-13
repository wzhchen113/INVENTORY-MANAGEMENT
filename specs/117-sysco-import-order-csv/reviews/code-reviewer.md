## Code review for spec 117 (SYSCO Import-Order CSV export)

Scope: readability, naming, abstraction, duplication, idiomatic RN/TS, CLAUDE.md
conventions. Architecture and security are out of scope (architect / security-auditor).

### Critical

None found. No direct `supabase.from/rpc` calls outside `db.ts`, no legacy-file
edits, no `app.json` slug change, no unguarded web-only API on a path reachable
from native, no `window.confirm`/`Alert.alert` bypass of `confirmAction`, and
`db.ts`'s `order_import_format` mapping already treats `'us_foods' | 'sysco'`
symmetrically end-to-end (`src/lib/db.ts:1807-1814`, `:1834`, `:2970`).

### Should-fix

- `src/utils/usFoodsImport.ts:144-151` / `src/utils/syscoImport.ts:142-149` /
  `src/screens/cmd/sections/ReorderSection.tsx:646-653` — the export-plan
  return shape (`csv`, `filename`, `included`, `skippedNoCode`,
  `otherVendorCount`, `customerNumberMissing`) is defined identically THREE
  times (`UsFoodsExportPlan`, `SyscoExportPlan`, and the local `ImportPlan`
  used only to type `emitImportPlan`'s parameter). This is exactly the kind of
  copy the new `vendorImportShared.ts` seam was supposed to eliminate — a
  future field added to one (e.g. a 4th vendor format, or a new cue flag) can
  silently drift from the other two since nothing forces them to match.
  Export one `VendorImportPlan` interface from `vendorImportShared.ts` and
  have both builders' plan functions and `ReorderSection`'s `emitImportPlan`
  reference it.

- `src/utils/usFoodsImport.ts:162-193` / `src/utils/syscoImport.ts:158-178` —
  `planUsFoodsExport` and `planSyscoExport` are the same function body with
  two differences: which `build*ImportCsv` is called and the filename prefix.
  Both resolve `pv`/`items` off the payload, resolve
  `importCustomerNumbers[storeId] || accountNumber`, resolve the `date`, and
  compute `otherVendorCount` / `customerNumberMissing` identically. This
  should be a single generic planner in `vendorImportShared.ts` (e.g.
  `planVendorImportExport(payload, storeId, storeName, cfg, orderCodeFor,
  { build, filenamePrefix })`), with each vendor file just supplying its
  builder + prefix. As written, a bug fix to the customer-number fallback
  logic in one function (which is business logic, not vendor-format-specific)
  has to be remembered and applied to the other by hand.

- `src/utils/usFoodsImport.ts:96-101` and `src/utils/syscoImport.ts:107-112` —
  per-item derivation is copied verbatim between the two builders' loops:
  `packSize` (`item.caseQty > 1 ? \`${formatQty(item.caseQty)} ${item.unit}\`.trim() : ''`)
  is byte-identical in both files, and the case/unit price derivation
  (`price = qty > 0 ? (item.estimatedCost / qty).toFixed(2) : ''`) is the same
  formula applied twice under different variable names (`csPrice`/`eaPrice` vs
  `casePrice`/`eachPrice`). `vendorImportShared.ts` already exists as the home
  for exactly this kind of format-agnostic per-item logic (it holds
  `orderQuantities`, which these two computations sit right next to) — add a
  `packSizeFor(item)` and/or a price-derivation helper there instead of
  copying the formula into each builder's loop.

- `src/components/cmd/VendorFormDrawer.tsx:406` /
  `src/i18n/en.json:781`, `src/i18n/es.json:781`, `src/i18n/zh-CN.json:781` —
  the per-store customer-number section's hint
  (`importCustomerHint` = "US Foods ship-to per location" / "US Foods ship-to
  per ubicación" / "US Foods 各门店送货地址…") is rendered for BOTH
  `orderImportFormat === 'us_foods'` AND `=== 'sysco'` (the gating condition
  at `VendorFormDrawer.tsx:402` is `brandStores.length > 0`, not
  format-specific), but the copy in all three locales still says "US Foods"
  unconditionally. An admin configuring a SYSCO vendor's per-store customer
  numbers (AC7) sees a hint that names the wrong vendor. Either make the hint
  format-conditional (`us_foods` → "US Foods ship-to…", `sysco` → "SYSCO
  customer # per location") or generalize the copy to name neither vendor.

### Nits

- `src/utils/syscoImport.test.ts:77` — the comment `// formula neutralized
  (then quoted for the space)` is inaccurate: the test's item name
  (`'=SUM(A1)'`) has no space, and after `csvSafe` prefixes it with `'`
  (`'=SUM(A1)`) the string still has no comma/quote/newline/space, so
  `syscoRow` does NOT quote it — the assertion passes for a different reason
  than the comment claims (`toContain` matches the substring regardless of
  whether it's later wrapped in `"..."`). Worth fixing the comment so a future
  reader doesn't infer quoting behavior that isn't happening here.

- `src/i18n/en.json:782` (and the same line in `es.json` / `zh-CN.json`) —
  `importFormatSysco` is appended after `importCustomerHint`, separated from
  its siblings `importFormatLabel`/`importFormatNone`/`importFormatUsFoods`
  (lines 774-777). Purely organizational — grouping it with the other
  `importFormat*` keys would make the option list easier to scan next time
  someone adds a fourth format.

- `src/components/cmd/VendorFormDrawer.tsx:84-105` (`toUpdates`) — switching
  `orderImportFormat` away from `'us_foods'` (e.g. to `'sysco'` or `''`) does
  not clear `importDistributorNumber`/`importDepartment`; they're carried
  through unconditionally and persisted even though the fields are hidden
  once the format changes. Functionally inert (nothing reads them off a
  non-`us_foods` vendor), but it's stale data left in the row. (out-of-scope
  for this diff to fix, but worth a follow-up if a report ever inspects those
  columns directly.)

- `src/utils/syscoImport.ts:70-77` (`syscoRow`) — the quote-trigger regex
  `/[",\n ]/` doesn't include a bare `\r`. Since rows are joined on `\r\n`
  (`syscoImport.ts:132`), a field containing a stray carriage return without
  a paired `\n` (e.g. from a Windows-pasted item name) would go out unquoted
  and could be misread by a downstream CSV parser as a row boundary. Very low
  likelihood given item names come through a single-line `TextInput`
  elsewhere in the app, but cheap to close by adding `\r` to the character
  class alongside `\n`.
