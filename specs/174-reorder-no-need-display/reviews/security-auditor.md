## Security audit for spec 174

Scope: client-only display change, reviewed with `git diff` against `f7b2759` plus the five untracked test files and three `.snap` files. Source files: `src/lib/eodNoNeed.ts`, `src/screens/staff/lib/eodNoNeed.ts`, `src/utils/reorderExport.ts`, `src/screens/staff/lib/reorderExportStaff.ts`, `src/screens/cmd/sections/ReorderSection.tsx`, `src/screens/cmd/sections/phone/PhoneOrdering.tsx`. I confirmed there is no migration, RLS, RPC, edge-function, `config.toml`, `db.ts` or `useStore.ts` change, so none of the RLS, `verify_jwt`, ADMIN_ROLES, last-of-role or self-guard checks apply. I ignored the staged spec 173 files.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `src/screens/staff/lib/reorderExportStaff.ts:101`: **already present before this spec, not introduced by it.** `buildStaffReorderCsv` calls `Papa.unparse(rows, { columns })` directly. The admin builder goes through `unparseCsvSafe` (`src/utils/reorderExport.ts:191`, used at `:275`), which puts a quote in front of cells that start with `= + - @ \t \r`. So the staff CSV does not neutralize spreadsheet formulas in its free-text cells: vendor name (`:84`), item name (`:87`) and unit (`:94`). Names come from the admin-managed catalog and vendor tables, so only an admin can plant a formula. The same class of issue was flagged in spec 139's audit for `countExport.ts`. **The new cell from spec 174 is not exploitable.** The On Hand value at `:89` is a fixed label (`'NO NEED'` / `'NO HACE FALTA'` / `'无需'`), and none of these start with a formula character. Suggested follow-up, not blocking spec 174: change line 101 to `return unparseCsvSafe(rows, columns);`. `unparseCsvSafe` is already exported from `../../../utils/reorderExport`, which this file already imports from. Normal data stays byte-identical, so the existing pins still hold.

### Focus-area verification (no findings)
- **HTML escaping, admin PDF-HTML** (`src/utils/reorderExport.ts:368`): the new value is passed through `escapeHtml(reorderNoNeedLabel('en'))`, the local five-character escape at `:328`. The label is a constant literal, so this is defense in depth. The other branch, `formatQty(item.onHand)`, is numeric output and is unchanged.
- **HTML escaping, staff PDF-HTML** (`src/screens/staff/lib/reorderExportStaff.ts:238`): the localized label goes through `escapeHtml(...)` (local helper at `:178`, five characters). The label comes from the i18n catalog (`section.reorder.noNeed`), which is a static bundled JSON and not user-controlled, but it is escaped anyway. The convention is met.
- **CSV formula injection, admin** (`src/utils/reorderExport.ts:258`): the new string cell passes through `unparseCsvSafe` → `csvSafeCell`. Its first character is N, so it passes through unchanged. Any future translation that starts with a formula character would still be guarded on the admin path. The staff path is covered by the Low finding above.
- **Staff text builder** (`reorderExportStaff.ts:159-169`): plain-text share output (no HTML or CSV parser). The item name was already interpolated before this change. The label is a constant. No new sink.
- **jsPDF** (`ReorderSection.tsx:1217-1218, 1327, 1335`): `doc.autoTable` body cells are drawn as text, not markup, so there is no injection surface. The label uses the coerced `locale`, so no CJK glyph reaches Helvetica (a rendering concern, not a security one).
- **Phone tag** (`PhoneOrdering.tsx:430-448`): the text is a catalog key rendered through RN `<Text>`, which escapes on web. `testID` interpolates `item.itemId` (a server UUID) into an attribute, which React sets safely. The tag is non-interactive. It is not used as an auth boundary, and there is no `useRole()` dependency.
- **Data exposure**: the change only lowers what an export shows. A NO NEED row's stale `onHand` is replaced by a label, and the `no_need` flag token was already in the Flags column and in `ReorderItem.flags` (spec 172 R4). No new fields are fetched and no new API path exists. The payload still comes from `report_reorder_list` under its existing RLS and RPC gating.
- **Logging and secrets**: no new `console.*` or `notifyBackendError` calls and no env access. The new tests contain no tokens, keys or real PII (grep came back clean). Fixtures are synthetic.
- **`isReorderNoNeed`** (`src/lib/eodNoNeed.ts:30-32`): a pure, null-safe array check with no I/O. The staff barrel re-export (`src/screens/staff/lib/eodNoNeed.ts:13`) is a symbol-only change.

### Dependencies
`package.json` and `package-lock.json` are unchanged, so `npm audit` was skipped.
