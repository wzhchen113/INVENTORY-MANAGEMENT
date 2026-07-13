# Security audit for spec 117 — SYSCO Import-Order file export

Scope: STAGED (uncommitted) changes for the SYSCO H/F/P order-file export.
Reviewed the two new util files (`vendorImportShared.ts`, `syscoImport.ts`), the
US Foods refactor onto the shared module, the caller wiring in
`ReorderSection.tsx`, and the db/type map deltas. Owner-relevant threat: `order_code`
(SUPC) is staff-writable through the sibling staff app (gated only by
`auth_can_see_store`), and the resulting file is opened by an admin in a
spreadsheet and uploaded to SYSCO — so field-breakout / formula-injection on
staff-controlled text is in-threat-model.

## Critical (BLOCKS merge)

None. This spec does not clear to `READY_FOR_DEPLOY`-blocking status on security
grounds.

## Should-fix

- `src/utils/syscoImport.ts:74` — **Custom serializer's quote-trigger regex omits
  the lone carriage-return `\r`.** `syscoRow` quotes a field only when it matches
  `/[",\n ]/` (comma, double-quote, LF, space). A bare `\r` with no LF/comma/space
  is emitted **raw and unquoted**. `csvSafe` does not backstop this — it only
  prefixes a `'` when `\r` is the *leading* character (`/^[=+\-@\t\r]/`,
  `vendorImportShared.ts:18`); an embedded/tail `\r` passes through untouched.
  Since the records are joined with `\r\n` and PapaParse / Excel treat a lone
  `\r` as a record terminator, a staff-controlled `order_code` (or item name)
  such as `"\rP"` splits its physical row in two, and the tail fragment can
  present as a spurious `P`-record row in the uploaded file.

  Impact is bounded, which is why this is Should-fix and not Critical: any value
  containing a comma is already force-quoted (the `,` in the regex), so an
  attacker cannot inject arbitrary comma-delimited quantity/SUPC fields — the
  injected fragment is only the *tail* of the real row (fixed, non-attacker
  numeric data), so a *meaningful* fraudulent order line cannot be crafted this
  way. But it is a genuine RFC-4180 breakout in the exact guard whose job is to
  prevent field breakout, and the task explicitly flagged CR handling.

  Note: a proper CRLF (`\r\n`) IS quoted today, because the `\n` in the regex
  catches it — the gap is specifically the *lone* `\r`.

  Fix: add `\r` to the trigger set — `/[",\r\n ]/` — the RFC-4180-correct
  quote-when-present character class (comma, quote, CR, LF). Consider adding a
  test asserting a value containing `\r` (and one containing an embedded `"`)
  round-trips inside a single quoted field.

## Nits

- `src/utils/syscoImport.test.ts` — coverage exercises leading-`=` formula
  neutralization (`:77`) and space-quoting (`:55`), but not embedded-quote
  doubling (`""`) nor CR/LF field-breakout. Adding those would pin the guard the
  Should-fix above hardens. Not blocking.

## Cleared (verified, no action)

- **`csvSafe` neutralizes the documented formula lead-ins.** `/^[=+\-@\t\r]/`
  (`vendorImportShared.ts:18`) covers `= + - @`, tab, and CR — the OWASP set.
  Unchanged from spec 116; behavior identical after the extract-to-shared move.
- **Every free-text sink is `csvSafe`-wrapped.** H-row customer number
  (`syscoImport.ts:95`), SUPC/`order_code` (`:116`), Pack/Size (`:120`), and
  Description/item name (`:123`). Brand, Mfr #, Cust # are literal blanks; Per Lb
  is the literal `'N'`; prices are `toFixed` numerics; the H datetime is
  regex-derived machine text (`toSyscoDate`, `:59`), not user free-text — none
  are injection sinks.
- **Embedded-quote and delimiter escaping is RFC-4180-correct for the covered
  set.** `syscoRow` doubles embedded `"` and wraps on comma/quote/LF/space
  (`:74`) — a crafted item name cannot break out of its field via a comma or a
  double-quote. (The single gap is the lone `\r`, above.)
- **No new DB / RLS / grant surface.** `order_import_format` gains the `'sysco'`
  value in the db map (`db.ts:1807`) and the `Vendor` type (`types/index.ts:470`),
  reusing spec-116 columns and the existing per-store `import_customer_numbers`
  jsonb. No migration in this changeset — nothing newly exposed over PostgREST.
- **Prices stay on the admin surface — no staff leak.** `syscoImport.ts`
  (SYSCO Case $/Each $, derived from the server-rounded `estimatedCost`) is
  imported only by `src/screens/cmd/sections/ReorderSection.tsx:49` (admin Cmd
  UI). No import from `src/screens/staff/**` (grep: only vendor-name string
  matches in staff tests, no builder import). Cost data does not reach the staff
  surface.
- **Per-store customer number resolves correctly and fails loud.**
  `planSyscoExport` (`:167`) resolves `importCustomerNumbers[storeId]` →
  `accountNumber` fallback → `''`, and surfaces `customerNumberMissing` for the
  toast (`:176`) rather than silently emitting a blank. Matches the US Foods
  shape.

### Dependencies

No `package.json` change in this changeset — `npm audit` skipped.
