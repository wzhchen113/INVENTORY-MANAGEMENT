# Security audit for spec 139

Scope: count CSV/PDF export with a per-export language picker. Read the spec and
every file under `## Files changed`. Frontend-only, no DB/RPC/edge/RLS surface —
so the audit centers on the two client-side attack classes the task named: HTML
injection in the PDF builder and CSV formula injection, plus secrets / PII / data
exposure and the BOM change.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

- `src/utils/countExport.ts:200-214` (`buildCountCsv`) — **CSV formula
  injection is not guarded.** `Papa.unparse` quotes only for CSV *structure*
  (delimiter / quote / newline); it does NOT neutralize spreadsheet formulas. A
  cell whose value begins with `=`, `+`, `-`, `@`, or a leading tab / CR is
  interpreted by Excel / Google Sheets / LibreOffice as a formula when the file
  is opened, enabling DDE command execution or data-exfil `HYPERLINK`/`WEBSERVICE`
  payloads (CWE-1236). The tainted cells here are: item **name** and
  **category** (`itemDisplayName`, `it.category`), the group **label** (vendor
  name for EOD, category for inventory — `group.label`), and the operator-entered
  **note** (`it.note`). Under this project's threat model ("do not assume callers
  of the same Supabase backend are friendly"; sibling staff / customer-PWA users
  write to the same Postgres), a hostile actor who can set a shared
  `catalog_ingredients` name / category or a vendor name plants a formula that
  fires on the admin's machine when they open the exported count sheet — a
  cross-tenant, stored-payload vector, not merely self-inflicted.
  - Fix: prefix any cell value whose first char is in `=+-@`, tab, or CR with a
    leading apostrophe (`'`) or a zero-width guard before handing rows to
    `Papa.unparse` (apply to string cells only, leave numeric cells alone so the
    sheet stays summable). A small `sanitizeCsvCell()` helper covers every string
    column in one place.
  - Severity rationale (Medium, not High): admin-only export surface; modern
    Excel shows a warning before executing DDE; and this exact gap already exists
    (accepted) in the reference `src/utils/reorderExport.ts:167` `buildReorderCsv`,
    so spec 139 is not a *regression* — but it is a **new** export surface that
    additionally carries a free-text operator `note` column, so the guard is
    worth adding now. If the guard lands, mirroring it into `reorderExport.ts` is
    a reasonable (out-of-scope) follow-up, not a blocker for this spec.

## Low

- `src/utils/reorderExport.ts:167` — pre-existing `buildReorderCsv` has the same
  unguarded formula-injection exposure. Explicitly OUT of scope for spec 139
  (reorder is a non-target per the spec), noted only so the release-coordinator
  can decide whether to open a follow-up alongside the Medium above. No action
  required in this spec.

## Cleared checks (positively verified — no finding)

- **HTML injection in `buildCountPdfHtml` — CLEAN.**
  `src/utils/countExport.ts:222-281`: every interpolated value is wrapped in the
  local 5-char `escapeHtml` (`& < > " '`, lines 70-77, byte-identical to the
  reorder copy per the inline-not-shared convention). Confirmed coverage of all
  sinks: column headers (`escapeHtml(c.header)`, line 237); **all** per-row cell
  values incl. item name / category / unit / note (`escapeHtml(String(col.cell(...)))`,
  line 244); the group label and its literal (`escapeHtml(groupLabel)` /
  `escapeHtml(group.label)`, line 250); title, store label + `storeName`, as-of
  label + `dateIso`, and the empty-state string (lines 275-277). No raw `${...}`
  reaches the HTML unescaped — even the i18n-catalog-sourced labels are escaped
  (defense in depth). A catalog item named `<script>` or `"><img onerror=...>`
  or a name/note containing quotes cannot break out of the markup. This is the
  edge-function `escapeHtml` rule satisfied for the expo-print HTML→PDF channel.

- **No secrets.** `countExport.ts` and the two orchestrators import no keys,
  tokens, or service-role material; nothing sensitive is embedded or logged.

- **No new data access.** No `supabase.from` / `supabase.rpc` in the export path
  (grepped both section files and `countExport.ts`). Export is a pure transform
  of already-loaded, RLS-scoped count state — `auth_can_see_store` is unchanged
  and no row is fetched that wasn't already on screen. `countExport.ts` imports
  only `papaparse`, `../i18n`, `getLocalizedName`, and helpers from
  `reorderExport` — framework-free as designed. Matches the `db.ts`-centralized
  data-layer convention (no carve-out violation).

- **No PII in logs.** The export orchestrators log only `e?.message || e` on
  failure (`EODCountSection.tsx:656,689`; `InventoryCountSection.tsx:402,435`) —
  error strings, never row data, names, or tokens. `notifyBackendError` is not on
  the export path (export never writes). No console output of count contents.

- **Export locale is component-local.** Picker state is seeded from `useLocale()`
  and never calls `setLocale` (verified via the `ExportLocalePicker` controlled
  contract in `## Files changed`), so the export picker cannot mutate app-wide
  state — no auth/session/role boundary is touched. `useRole()` is not used as a
  security boundary anywhere in this change.

- **BOM change is safe.** `src/utils/index.ts:126-134` prepends `﻿` to the
  string *before* `new Blob([...])`. `buildCountCsv` itself returns BOM-free CSV
  (single owner of the BOM at the download seam), so there is no double-BOM and
  no corruption of the CSV body. The 3-byte prefix is additive, changes no column
  output, and is the standard Excel/Sheets UTF-8 signal. It does not interact
  with the formula-injection concern above (a leading BOM does not defeat, nor
  enable, formula parsing). The two additionally-affected callers
  (`ExportCsvDrawer`, RecipesSection menu-BOM) receive the same additive prefix —
  not a security-relevant change.

## Dependencies

No `package.json` changes in `## Files changed` — `npm audit` skipped.

## Verdict

No Critical, no High. One Medium (CSV formula-injection guard) and one Low
(pre-existing reorder parity, out of scope). The Medium does not BLOCK — it is a
harden-before-deploy item consistent with an already-accepted pattern elsewhere
in the codebase; the release-coordinator may ship with a tracked follow-up or
request the guard now. The HTML-injection class the spec was most concerned about
is fully mitigated.
