# Spec 089 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode, read-only)
Spec: `specs/089/spec.md` (Status: READY_FOR_REVIEW)
Scope of review: architectural drift vs. the "## Backend design (architect)" section. Changes are UNSTAGED.

Verdict up front: **MATCHES DESIGN.** Zero Critical, zero Should-fix architectural-integrity findings. The one intentional deviation from my written recommendation — decision (C) Option 2 (PDF-everywhere) instead of my recommended Option 1 — is the user-resolved choice the design explicitly routed to the user, so it is *conformance*, not drift. Findings below are all Minor.

---

## Confirm against the design

### NO backend change — CONFIRMED

- **No new/changed migration.** The migration set ends at `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (spec 088, shipped before this spec). No `2026060*_*reorder*` or any spec-089-named migration exists. The `Glob` of `supabase/migrations/*.sql` is identical to the pre-spec inventory.
- **No RLS / grant / RPC / edge / config change.** The diff touches `src/` + `package.json`/`package-lock.json`/`jest.config.js` only — nothing under `supabase/`. The staff fetch calls the EXISTING `report_reorder_list` (manager-callable via `auth_can_see_store`, re-asserted in 20260602000000:83) and reads `order_schedule` (SELECT = `auth_can_see_store(store_id)`, 20260510020000:24-26). Both confirmed manager-readable, no gap, exactly as §0.
- **`order_schedule` column set validated against schema.** `fetchStaffOrderSchedule` selects `day_of_week, vendor_id, vendor_name, delivery_day` ([src/screens/staff/lib/fetchReorder.ts:134](../../../src/screens/staff/lib/fetchReorder.ts)). All four columns exist on `public.order_schedule` ([supabase/migrations/20260424211732_recover_undeclared_tables.sql:86-94](../../../supabase/migrations/20260424211732_recover_undeclared_tables.sql); `delivery_day`/`vendor_name` set NOT NULL in the remote-schema migration). The select is well-formed; no schema assumption is invented.

### (A) Extraction — the main regression surface — CONFIRMED byte-for-byte

1. **Extracted logic is equivalent to the prior inline logic.** `src/utils/reorderExport.ts` carries `formatQty`, `formatMoney`, `slugifyStore`, `todayLocalIso`, `formatSuggested`, `formatSuggestedPdf`, `buildReorderCsv` with the exact spec-088 cases·units semantics: `N cases · M unit` (singular `1 case`), the compact `N cs · M unit` PDF variant, and the fixed CSV column order (`Vendor … Suggested Qty, Cases, Units Per Case, Unit, Est. Cost, Flags, EOD Counted At`) via `Papa.unparse(rows, { columns })`. `suggestedUnits` is server-authoritative; no `cases × caseQty` re-derivation; `Est. Cost` rides `estimatedCost.toFixed(2)` with no `$` (numeric-friendly). This is identical to the logic the admin shipped under spec 088.
2. **Admin `ReorderSection.tsx` is import-only.** The file now imports the seven helpers from `../../../utils/reorderExport` ([ReorderSection.tsx:28-36](../../../src/screens/cmd/sections/ReorderSection.tsx)) and **re-exports** `formatSuggested`/`formatSuggestedPdf`/`buildReorderCsv` ([line 42](../../../src/screens/cmd/sections/ReorderSection.tsx)). The DOM-coupled web orchestrators (`triggerDownload`, `handleCsvExport`, `handlePdfExport`) stay in the admin file, web-gated, unchanged — exactly the (A) split I specified. `VendorCard` / `BreakdownLine` still call `formatSuggested`/`formatQty`/`formatMoney`; the jsPDF `handlePdfExport` still calls `formatSuggestedPdf` and `slugifyStore`/`todayLocalIso`. No behavioral edits beyond the import boundary.
3. **The regression gate stays green via re-export, not import re-pointing.** The design offered two mitigations (re-point the admin jest imports, OR keep a thin re-export). The developer chose the re-export: `ReorderSectionCases.test.tsx:83-87` still imports `formatSuggested`/`formatSuggestedPdf`/`buildReorderCsv` `from '../ReorderSection'` and resolves them through the re-export. This is the stronger choice — it proves the public surface of the admin module is preserved AND the shared util is the single source of truth. The Files-changed claim of "admin reorder jest 22/22 green" is consistent with this wiring.
4. **`reorderExport.ts` is genuinely pure.** Imports are `papaparse` + `import type { ReorderItem, ReorderPayload } from '../types'` only. No React, no theme (`useCmdColors`/`useStaffColors`), no `react-native`, no `supabase`. Both the Cmd section and the staff screen import it without theme bleed — the (A) constraint ("do not import a Cmd component module") is satisfied.

The architectural-integrity check passes: there is no silent drift in the admin Reorder. The admin's on-screen Suggested string, CSV, and jsPDF tables are byte-for-byte what they were.

### (B) Staff fetch carve-out — CONFIRMED

- `src/screens/staff/lib/fetchReorder.ts` is a staff-subtree carve-out calling `supabase.rpc`/`.from` directly (sanctioned per CLAUDE.md "DB access centralized"), NOT `db.ts`, NOT `useInflight.track()`. Plain `await`, mirroring `fetchVendorsForToday`.
- `fetchStaffReorder`'s `mapReorderVendor` ([fetchReorder.ts:45-81](../../../src/screens/staff/lib/fetchReorder.ts)) is a **verbatim** copy of the admin `db.ts:mapReorderVendor` ([src/lib/db.ts:2750-2786](../../../src/lib/db.ts)) — every field and fallback matches, including the spec-088 case fields (`caseQty ?? 1`, `suggestedCases` null-guard, `suggestedUnits ?? suggested_qty`). The envelope mapping (kpis snake→camel, `_warnings`) is identical to `fetchReorderSuggestions` minus the inflight/abort wrapper. This is the duplication-over-coupling decision I specified.
- Returns the **shared** `ReorderPayload`/`OrderSchedule` types ([src/types/index.ts:468-476](../../../src/types/index.ts)), not a staff mirror — so the pure utils consume them without a parallel type. As designed.
- Errors `throw` on PostgREST error; the screen catches → `notifyBackendError` + retry-able error pane ([Reorder.tsx:227-232, 487-504](../../../src/screens/staff/screens/Reorder.tsx)). The 42501-forbidden path propagates as a thrown error → error pane (AC "not a silent blank"). Matches (B).
- **State is screen-local `useState`**, no `useStaffStore` slice ([Reorder.tsx:202-208](../../../src/screens/staff/screens/Reorder.tsx)). `useStaffStore.ts` is untouched. Matches (B).
- Fetch orchestration is the store-switch-aware single effect keyed on `[activeStore?.id, selectedDate]` with the reset-to-today-on-switch guard ([Reorder.tsx:217-249](../../../src/screens/staff/screens/Reorder.tsx)) — a faithful port of `ReorderSection.tsx:567-579`'s anti-stale-as-of fix, with `Promise.all([fetchStaffReorder, fetchStaffOrderSchedule])`. Matches (B).

### (C) Cross-platform export/share — Option 2 (PDF-everywhere) — CONFORMS to the user-resolved choice

This is the one place the implementation differs from my *recommendation*, and it is correct conformance, not drift:

- My design recommended **Option 1** (CSV + text, zero new deps) and wrote an explicit **ESCALATION FOR THE USER** routing the CSV/text-vs-PDF-everywhere-vs-web-only-PDF decision to the user, with "absent a response, build Option 1." The Handoff prompt instructed main Claude to surface (C) to the user before the build.
- The Files-changed section records the user resolved (C) = **Option 2 (PDF EVERYWHERE)**. Building Option 2 against a recorded user decision is exactly the contract — the design *delegated* this call. **No architectural objection.**
- The implementation matches the Option-2 shape I sketched for that branch: `expo-print` added as the only new dep; native PDF via `Print.printToFileAsync` → share sheet; web PDF via `Print.printAsync` (react-native-web shim); admin jsPDF path untouched.
- The pure content builders (`buildReorderCsv`, `buildReorderText`, `buildReorderPdfHtml`) live in the shared `reorderExport.ts`; the impure platform-branched I/O orchestrator (`shareReorder.ts`) is staff-local and branches on `Platform.OS` — web Blob+anchor (mirrors admin `triggerDownload`) vs. native `expo-file-system` cache-dir write + `expo-sharing`. Both wrap errors → staff bottom Toast, never throw. `Sharing.isAvailableAsync() === false` → error toast, no crash ([shareReorder.ts:103-110, 163-166](../../../src/screens/staff/lib/shareReorder.ts)). This is precisely the §(C) module contract.
- The derived-payload invariant holds: `exportPayload = { ...payload, vendors: primary, kpis: computeReorderKpis(primary) }` ([Reorder.tsx:273-276](../../../src/screens/staff/screens/Reorder.tsx)) feeds the share builders, so CSV/text/PDF match the on-screen filtered + as-of cards. `showExport` gates on `primary.length > 0 && !error && !(loading && !payload)`, dropping the admin's web-only clause — as the design directed for the cross-platform staff export.
- `buildReorderPdfHtml` escapes every interpolated value (store name, vendor name, item name, unit, suggested string, date) through an inline five-char `escapeHtml` ([reorderExport.ts:172-179, 198-251](../../../src/utils/reorderExport.ts)). This is the right posture for an HTML-rendering path and mirrors the edge-function email-template convention. (Note: this is the TS/web+native bundle, not a Deno edge function, so the "inline-not-shared" edge rule does not bind here — but the escaping itself is correct and welcome. Defense-in-depth flagged to security-auditor for the canonical pass.)

### (D) Mobile layout + staff-native date picker — CONFIRMED

- `src/screens/staff/screens/Reorder.tsx` reflows to single-column phone layout via `useStaffColors()` + staff `spacing`/`radius`/`typography`/`touchTarget`/`useStaffElevation` tokens — no `useCmdColors`, no `mono`. SafeAreaView `edges={['top','bottom']}` matches EODCount/StorePicker. KPI 2×2 grid, stacked per-item rows (mobile analog of `BreakdownLine`), source badge, warnings via the staff `Banner` (`tone="warning"` — valid per [Banner.tsx:15](../../../src/screens/staff/components/Banner.tsx)), collapsible no-schedule group, and all four states (loading / empty / nothing-to-order / error). Reuses the shared `formatSuggested`/`formatMoney`/`formatQty` for the cases·units string. Matches (D).
- `src/screens/staff/components/ReorderDatePicker.tsx` is a STAFF-NATIVE month-grid (not the Cmd one), themed via `useStaffColors()`, ≥44pt cells (`touchTarget.min`), imports the shared `weekdayName` from `reorderDayFilter.ts` (the locale-invariant parser; traps #1/#2 preserved — local-midnight parse at [line 73](../../../src/screens/staff/components/ReorderDatePicker.tsx), index-array weekday via the shared util), and takes `value`/`onChange`/`maxDate`/`activeWeekdays`. Active-day dot kept distinct from the today ring + selected fill. Matches (D) exactly.

### (E) Navigation — bottom tab bar — CONFIRMED

- `StaffStack.tsx`: the `else if (activeStore)` branch now mounts `StaffTabs` — a `createBottomTabNavigator` with `EODCount` + `Reorder`, `headerShown: false`, staff-themed `tabBarActiveTintColor: c.primary` / inactive `c.textSecondary` / bar bg `c.surface` / top border `c.border`, `sceneContainerStyle: { backgroundColor: c.bg }` to avoid the dark-mode white flash, `@expo/vector-icons` Ionicons, and the `staff-tab-eod`/`staff-tab-reorder` testIDs. Splash + StorePicker branches untouched. This is the (E) render-branch change verbatim.
- Per-screen header preserved: the Reorder screen owns its own header with store name (tap → `setActiveStore(null)` to switch) + sign-out ([Reorder.tsx:341-372](../../../src/screens/staff/screens/Reorder.tsx)), rather than lifting sign-out into the tab bar. Matches the (E) decision.

### (F) Active-store scoping — CONFIRMED

- Reorder reads `useStaffStore((s) => s.activeStore)` (the SAME EOD active store), re-fetches on store switch, and has the post-hooks defensive `if (!activeStore)` guard ([Reorder.tsx:325-333](../../../src/screens/staff/screens/Reorder.tsx)). Switching stores drops the whole tab navigator back to StorePicker (tab bar only mounts in the `activeStore` branch). Matches (F).

### No scope creep — CONFIRMED

- No PO write-path / "mark ordered" / "Create PO" anywhere in the staff screen.
- Admin Reorder behavior unchanged beyond the import-only extraction (re-confirmed under (A)).
- The reorder MATH and the `report_reorder_list` RPC contract are untouched — the FE re-derives nothing the server computes; `computeReorderKpis` is the pre-existing spec-087 pure util, unchanged.

---

## Findings

### Critical
None.

### Should-fix
None.

### Minor

**M1 — `daysUntilNextDelivery === 0` ("today") path in the PDF/text builders is plausibly unreachable but unguarded.** `buildReorderPdfHtml` ([reorderExport.ts:192-197](../../../src/utils/reorderExport.ts)) and the text/admin paths compute a `daysLabel` of `today`/`tomorrow`/`in N days`. The on-screen primary set is filtered to vendors ordering out on the *selected* weekday; the "days until next *delivery*" is a different axis, so 0/negative is possible in principle and the label says "today"/"in -1 days" for a stale schedule. This is pre-existing admin behavior carried verbatim (not a regression), and the figure is cosmetic, but worth a glance from the test-engineer if a negative `daysUntilNextDelivery` fixture is cheap to add. Not blocking.

**M2 — Documentation nit in the design vs. the shipped builder set.** My §(A) extraction manifest listed `buildReorderText` as the only NEW shared builder (because I recommended Option 1). The shipped util correctly adds `buildReorderPdfHtml` too (Option 2). This is a consequence of the user picking Option 2 and is fully consistent with the §(C) Option-2 branch — flagging only so the reviewer fan-out doesn't read the manifest literally and mis-flag `buildReorderPdfHtml` as unplanned. It was planned, under Option 2.

**M3 — `shareReorder.ts` PDF-on-web has no downloadable artifact (by design), but the success toast names a `.pdf` filename.** On web, `Print.printAsync({ html })` opens the browser print dialog (no file written), yet `successToast('pdf', filename)` shows `IMR_Reorder_<store>_<date>.pdf` ([shareReorder.ts:155-173](../../../src/screens/staff/lib/shareReorder.ts)). The filename is slightly misleading on web (the user gets a print dialog, not that file). Cosmetic; the native path does produce that artifact. Consider a web-specific toast string in a follow-up. Not blocking.

**M4 — Device QA gap (already self-flagged by the developer).** The native share path (`expo-file-system` cache write + `expo-sharing` share sheet + `expo-print` PDF) is unit-tested at the orchestrator boundary but not driven on a physical device this session (no preview tooling available). `expo-print` is a brand-new native module → an EAS rebuild is required before native QA, and the `expo-file-system` v19 object API (`new File(Paths.cache, name)` + `create({ overwrite: true })` + sync `write`) is the first in-repo use. This is a release-coordinator note (device QA + EAS rebuild as a ship gate), not an architectural defect.

---

## One-paragraph verdict

The implementation **matches the design**. The one deviation from my written recommendation — shipping decision (C) as Option 2 (PDF everywhere via `expo-print`) rather than my recommended Option 1 — is the user-resolved choice my design explicitly delegated to the user, so it is conformance, not drift. The architectural-integrity check that this review most cared about — the (A) extraction — is clean: the seven pure formatters moved verbatim into a genuinely framework-free `src/utils/reorderExport.ts`, the admin `ReorderSection.tsx` is import-only with a back-compat re-export that keeps the admin reorder jest green against the original module surface, and the spec-088 cases·units string + CSV columns are byte-for-byte preserved, so the admin Reorder is not silently changed. The staff fetch is a proper carve-out (verbatim `mapReorderVendor`, shared types, screen-local state, no `useStaffStore` slice, no `db.ts` touch), the date picker is staff-native reusing the shared `weekdayName`, the bottom-tab-bar wiring leaves the Splash/StorePicker branches untouched, and the export honors the filtered derived-payload invariant. There is genuinely no `supabase/` change — no migration, RLS, RPC, edge, or realtime delta — and `expo-print` is the only new dependency. Zero Critical, zero Should-fix architectural findings; the four Minors are cosmetic or QA-process notes for the reviewer fan-out and release-coordinator.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor findings; implementation matches the design (decision (C) Option 2 is the user-resolved choice the design delegated). Note for release-coordinator: native share/PDF path needs device QA + an EAS rebuild (expo-print is a new native module) before native ship.
payload_paths:
  - specs/089/reviews/backend-architect.md
