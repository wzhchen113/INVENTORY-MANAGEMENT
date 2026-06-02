# Security audit for spec 089

Staff Reorder page (view + cross-platform CSV/text/PDF export). Frontend-only —
verified no backend/RPC/RLS/edge/migration/realtime change. The export/share path
(`expo-print` HTML→PDF + `expo-sharing`/`expo-file-system` temp-file write) is the
real new attack surface; the HTML-injection check on the PDF builder was the
highest-priority item.

Files reviewed:
- `src/utils/reorderExport.ts` (new — pure builders incl. `buildReorderPdfHtml`)
- `src/utils/reorderExport.test.ts` (new — incl. the HTML-escape guard)
- `src/screens/staff/lib/shareReorder.ts` (new — platform-branched I/O orchestrator)
- `src/screens/staff/lib/fetchReorder.ts` (new — staff carve-out fetch)
- `src/screens/staff/screens/Reorder.tsx` (new — screen)
- `src/screens/staff/components/ReorderDatePicker.tsx` (new — staff date picker)
- `src/screens/cmd/sections/ReorderSection.tsx` (changed — import-only)
- `package.json` + `package-lock.json` (changed — `expo-print` added)
- `src/types/index.ts` (read — `ReorderItem`/`ReorderVendor`/`ReorderPayload` field types)
- `supabase/migrations/20260514130000_report_reorder_list.sql` (read — `as_of_date` derivation)

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

None.

---

### Low

- `src/screens/staff/lib/shareReorder.ts:66` — `failureToast` logs
  `console.warn('[imr-staff] reorder ${format} export failed:', message)` where
  `message` is the raw thrown error. For this code path the thrown errors are
  benign (PapaParse / expo-file-system / expo-print / `'Sharing is not available
  on this device'`), and the reorder data itself is RLS-scoped to the manager's
  own store — so nothing cross-store or secret can reach the log. Noting only for
  completeness: if a future error source on this path ever carried row data or a
  token, this `console.warn` would surface it. No action required for 089.

---

### Focus-item verdicts (per the review brief)

**1. HTML injection into the PDF (highest priority) — PASS.**
`buildReorderPdfHtml` (`src/utils/reorderExport.ts:187-255`) interpolates exactly
the following into the HTML string that `expo-print` renders to PDF. Every
user/catalog-controlled STRING is wrapped in the local `escapeHtml`
(`reorderExport.ts:172-179`, full five-char escape `& < > " '`):
- `escapeHtml(vendor.vendorName || 'unnamed vendor')` — line 198 ✓
- `escapeHtml(vendor.nextDeliveryDate || '—')` — line 198 ✓
- `escapeHtml(item.itemName)` — line 203 ✓
- `escapeHtml(formatSuggestedPdf(item))` — line 207 ✓ (this also covers
  `item.unit`, which `formatSuggestedPdf` embeds — escaping the whole result
  neutralizes a malicious unit string)
- `escapeHtml(item.unit)` — line 208 ✓
- `escapeHtml(storeName)` — line 249 ✓
- `escapeHtml(date)` — line 249 ✓

The remaining interpolations are NON-string and cannot inject markup:
`sourceLabel` (fixed literal `'EOD'`/`'STOCK FALLBACK'`), `daysLabel` (derived
from the `number` `daysUntilNextDelivery` into fixed literals or `in ${n} days`),
`formatQty(onHand|pendingPoQty|parLevel)` (numeric → digits only; `'0'` for
non-finite), `formatMoney(estimatedCost|totalEstimatedCost)` (numeric → `$`,
digits, `.`), and `payload.kpis.itemCount` (number). The corresponding type
fields are all declared `number` in `src/types/index.ts:705-742,755-761`, AND
`mapReorderVendor` (`fetchReorder.ts:45-81`) runs `Number(...)` coercion on every
one of them, so even a hostile RPC payload with a string in a numeric slot is
coerced to `number`/`NaN` before it reaches the template. Defense-in-depth holds
end-to-end. The escape behavior is pinned by an explicit jest guard
(`reorderExport.test.ts:241-256`) asserting `<`, `>`, `&`, `"` are escaped in
vendor name, item name, and store name, and that the raw form does not leak.
This is the same class as the CLAUDE.md edge-function `escapeHtml` rule, correctly
applied to a client-rendered HTML→PDF. `buildReorderText`
(`reorderExport.ts:134-167`) is shared as `text/plain` only and never reaches an
HTML sink, so it needs no escaping.

**2. File-write safety (`expo-file-system`) — PASS.**
Native writes go to `new File(Paths.cache, filename)` (`shareReorder.ts:100`) —
the ephemeral cache dir, not `documentDirectory` or an arbitrary path, matching
the design. The filename is `IMR_Reorder_${slugifyStore(storeName)}_${asOf}.{ext}`
(`shareReorder.ts:44-46`). Both dynamic segments are traversal-proof:
- `slugifyStore` (`reorderExport.ts:65-67`) strips every char outside
  `[A-Za-z0-9_-]` (removing `/` and `.`) and caps at 60 chars, with a `'store'`
  fallback. `../` cannot survive it.
- `asOf` comes from `payload.asOfDate.slice(0,10)`, and `asOfDate` is
  SERVER-generated: the RPC emits `to_char(v_as_of_date, 'YYYY-MM-DD')`
  (`report_reorder_list.sql:595`) where `v_as_of_date` is cast `::date`
  (`report_reorder_list.sql:129`). A Postgres `date` formatted as `YYYY-MM-DD`
  is structurally digits-and-hyphens only — it cannot contain `/`, `.`, or `..`,
  and a non-date input throws `22007` rather than echoing back. No path-traversal
  vector exists from either segment.

**3. Data exposure via share — PASS.**
The exported artifact (CSV/text/PDF) carries only the manager's own store's
reorder rows. `fetchStaffReorder` calls `report_reorder_list(p_store_id =
activeStore.id, ...)` (`fetchReorder.ts:92-95`), which is gated server-side on
`auth_can_see_store(p_store_id)` (existing RLS, confirmed by the architect). The
screen scopes every fetch to `useStaffStore.activeStore` and re-fetches on store
switch; there is no cross-store or cross-brand fan-out. No tokens, keys, user ids,
or PII beyond the store's own vendor/item/cost data appear in any builder output —
the builders only read `vendorName`, `itemName`, `unit`, numeric qty/cost fields,
`nextDeliveryDate`, and the client-recomputed KPIs. Share metadata is benign
(`dialogTitle: 'Share reorder list'`, `mimeType`, `UTI`). A non-granted store
yields the RPC's 42501 propagated as a thrown error → on-screen error pane
(`fetchReorder.ts:96`, `Reorder.tsx:227-232`), not a silent leak or blank.

**4. New dependency `expo-print` — PASS.**
`expo-print@~15.0.8` is the ONLY new dependency. The `package-lock.json` diff is
exactly 11 lines and adds a single node with `peerDependencies` only (`expo`,
`react-native`) — it pulls in ZERO transitive packages (`npm ls expo-print`
confirms a leaf). It is an Expo-maintained, MIT-licensed package. See Dependencies
section for the `npm audit` result and the introduced-vs-pre-existing split.

**5. No new auth surface — PASS.**
The manager calls the already-gated `report_reorder_list` RPC and reads
`order_schedule` (existing `auth_can_see_store` SELECT policy) via the sanctioned
`src/screens/staff/` carve-out — both read-only, no writes, no PO path. No
privilege change. No use of the client-side `useRole()` as a security boundary
(the screen gates only UI rendering on `activeStore`, which is correct). The admin
`ReorderSection.tsx` change is genuinely import-only (deletes the seven local pure
helpers, re-exports them from the shared util) — no authz or behavior change.

---

### Dependencies

`npm audit --audit-level=high` reports one high-severity advisory
(`@xmldom/xmldom <=0.8.12` — XML DoS / injection) plus moderate advisories
(`dompurify`, `postcss`, `uuid`, `brace-expansion`). **All are pre-existing and
unrelated to this spec.** `npm ls @xmldom/xmldom` traces it to
`expo → @expo/cli → @expo/plist` and `@expo/config-plugins → xcode →
simple-plist → plist` — Expo build-toolchain transitive deps that predate 089.
`expo-print` adds NO transitive dependencies (verified: 11-line lockfile diff, a
single leaf node with peerDeps only), so it introduces zero new advisories. None
of the flagged packages are reachable from the runtime reorder export path. No
finding attributable to spec 089. (Toolchain-dep remediation, if desired, is a
separate maintenance item — `npm audit fix --force` wants `expo@56`, a breaking
upgrade out of scope here.)

---

### Summary

Spec 089 is clean from a security standpoint — no Critical, High, or Medium
findings, and one informational Low. The highest-risk item, HTML injection into
the `expo-print` PDF, is fully mitigated: every user/catalog-controlled string
interpolation in `buildReorderPdfHtml` is wrapped in a correct five-character
`escapeHtml`, all numeric interpolations are type-`number` AND `Number()`-coerced
at the mapper boundary, and a jest guard pins the escape behavior. The native
temp-file path is traversal-proof (cache dir + `slugifyStore`-sanitized store name
+ a server-generated `YYYY-MM-DD` date that is structurally digits-and-hyphens
only). The export carries only the manager's own RLS-scoped store data with no
secret/PII/cross-store leakage, the only new dependency (`expo-print`) is an
Expo-maintained leaf that adds no transitive packages or advisories, and there is
no new auth surface — the manager hits the already-gated `report_reorder_list` RPC
read-only and the admin file touch is import-only. The pre-existing `npm audit`
advisories all live in the Expo build toolchain, are unrelated to this change, and
are not introduced by it.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low. The
  highest-priority check — HTML injection into the expo-print PDF builder
  (buildReorderPdfHtml) — PASSES: every user/catalog-controlled string is
  escapeHtml-wrapped, numerics are type-number + Number()-coerced, and a jest
  guard pins the escape. Native temp-file write is traversal-proof (cache dir +
  slugifyStore + server-generated YYYY-MM-DD). No cross-store/secret leakage in
  the export, no new auth surface, expo-print is the only new dep (Expo-maintained
  leaf, zero transitive deps, zero new advisories). All npm audit findings are
  pre-existing Expo-toolchain transitive deps unrelated to 089. No Critical — does
  not block.
payload_paths:
  - specs/089/reviews/security-auditor.md
