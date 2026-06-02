# Spec 091: Reorder cleanup batch (deferred nits + test-coverage gaps from 087/088/089/090)

Status: READY_FOR_REVIEW

## User story

As a maintainer of the reorder feature, I want the cosmetic nits and the test-coverage gaps that were explicitly deferred (non-blocking) during the 087 / 088 / 089 / 090 review passes folded into a single small cleanup batch, so the codebase reads clearly and the reorder behavior is exhaustively pinned by tests before the next reorder change lands on top of it.

This is a CLEANUP batch: cosmetic comment/rename fixes + a handful of small test additions. There are no design decisions and no behavior changes (the one exception is the per-vendor "total qty" item, which is resolved as documentation, not a behavior change — see Open questions). There is no new feature.

## Right-sizing note (read first)

This batch is **frontend + test only**. There are no design decisions, so the architect can be skipped — go straight to frontend-developer. The reviewer set is **code-reviewer + test-engineer** only:

- **security-auditor: N/A.** No auth, no RLS, no edge function, no HTML-rendering path, no new caller-controlled data flows. The only `escapeHtml` call site (`reorderExport.ts:buildReorderPdfHtml`) is unchanged by this batch. Nothing in scope changes the security surface.
- **backend-architect (post-impl): N/A.** No contract, no RPC signature, no migration logic changes. The one pgTAP touch (item C1) is a header-comment-only edit that does not change any `select`/assertion or the `plan()` count, so there is no contract drift to review.

The developer should execute this as a mechanical punch list. Each item below names the file, the exact change, and why.

## Acceptance criteria

Each item is independently testable. The full `npx jest` suite + base typecheck + test-graph typecheck must stay green after the batch; pgTAP must stay green (item C1 is comment-only, so the existing plan count is unchanged).

### Cosmetic — comment/rename, no behavior change

- [ ] **A1 — `reorderExport.ts:todayLocalIso()` misnamed (UTC, not local).** `src/utils/reorderExport.ts:69-71` `todayLocalIso()` returns `new Date().toISOString().slice(0, 10)` (UTC midnight) despite the "local" name. This is the shared helper (admin + staff both import it; flagged across 087 / 088 / 089). FIX: change the body to local-time components to match its name and match `reportDates.ts:toISODate()` / the staff screen's `todayIso()` — e.g. `const d = new Date(); return \`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}\`;`. AC: a jest test asserts the function returns the local-date components (not the UTC `.toISOString().slice(0,10)` form) for a fixed/mocked `Date`. NB: in production this function is only reached when `payload.asOfDate` is absent (which the RPC never produces), so this is a name-vs-implementation correctness fix with nil runtime impact — the rename-to-correct path is preferred over leaving it UTC.
- [ ] **A2 — staff `Reorder.tsx:maxDate` memoized once (stale past midnight).** `src/screens/staff/screens/Reorder.tsx:197` `const maxDate = useMemo(() => todayIso(), [])` computes only at mount, so the date-picker upper bound goes one day stale if the tab is left open overnight. The admin `ReorderSection.tsx` avoids this by computing `toISODate(new Date())` outside any memo (recomputes every render). FIX: align the staff screen — drop the `useMemo` and compute `const maxDate = todayIso();` on each render (cheap, matches admin). AC: a jest test (or extension of `Reorder.test.tsx`) asserts `maxDate` reflects the current `todayIso()` (no behavior regression in the date picker; the picker still receives a valid `YYYY-MM-DD`). Low-risk: a render-time string compute.
- [ ] **A3 — `reorderDayFilter.ts:weekdayName()` invalid-Date guard idiom.** `src/utils/reorderDayFilter.ts:83-84` guards with `const idx = d.getDay(); if (Number.isNaN(idx)) return null;`. This is correct but non-idiomatic (relies on `getDay()` returning `NaN` for an invalid Date). FIX: replace with an explicit invalid-Date guard — `if (Number.isNaN(d.getTime())) return null;` BEFORE calling `getDay()`. Behavior identical (both return `null` for a malformed input). AC: the existing `reorderDayFilter.test.ts` malformed-input case stays green; add one assertion that a clearly-invalid input (e.g. `'2026-13-40'`) returns `null` if not already covered.
- [ ] **A4 — `ReorderDatePicker.tsx` single-letter `DAY_LABELS`.** `src/components/cmd/ReorderDatePicker.tsx:37` `DAY_LABELS = ['S','M','T','W','T','F','S']` is ambiguous (T = Tue/Thu, S = Sat/Sun). The i18n short weekday labels (`enum.dayOfWeek.short.*`, resolved by `dayOfWeekShortLabel` in `enumLabels.ts`) already exist and are less ambiguous. FIX OPTIONS (developer picks; see Open question note): (a) leave single-letter — lowest churn, but the 087 reviewer flagged it as a UX nit; (b) switch to the i18n short labels — clearer, but `ReorderDatePicker.tsx` deliberately does NOT import `useT` today (see its header comment lines 6-7), so this requires adding a `useT` import + an i18n parity test for the 7 `enum.dayOfWeek.short.*` keys. RECOMMENDATION: prefer (b) for clarity since the keys already exist; if (b) materially expands the diff or breaks the "no `useT` in this component" invariant the developer judges load-bearing, fall back to (a) and note it in the resolution. Either way this is a label-only change — the grid math, parse logic, and testIDs are untouched. AC (if (b)): the 7 short-weekday header cells render the i18n short labels; an i18n parity test asserts all 7 `enum.dayOfWeek.short.*` keys resolve across en/es/zh-CN.
- [ ] **C1 — pgTAP plan-count enumeration comment (088).** `supabase/tests/report_reorder_list_cases.test.sql:51` `select plan(12)` is correct; the header comment (around line 17) describes the five scenarios but does not enumerate the 12 assertions by number the way `report_reorder_list_hybrid_formula.test.sql` does. FIX: add a one-line enumeration in the header comment (e.g. "12 assertions: 1 fixture resolve + 4 CASE item + 3 EXACT item + 3 PLAIN item + 1 rollup"). COMMENT-ONLY — no `select`/`is`/`ok`/`plan()` change; the existing pgTAP plan count is unchanged. AC: pgTAP suite stays green at the same plan count.
- [ ] **C2 — invite test `mockStoreBrandRow` typed (090).** `src/lib/inviteUser.test.ts:35` `let mockStoreBrandRow: any = null;` FIX: tighten to `let mockStoreBrandRow: { brand_id: string } | null = null;` to match the real `supabase.from('stores').single()` data shape and get narrowing in the factory closure. AC: `inviteUser.test.ts` typechecks under the test-graph tsc and stays green. (The over-long Spec-090 comment block in `InviteUserDrawer.tsx:140-154` is explicitly LEFT AS-IS — see Out of scope.)

### Test-coverage gaps — real additions (no production-code change)

- [ ] **B1 — staff i18n weekday-key parity exhaustiveness (087/089).** `src/screens/staff/i18n/i18n.test.ts:119-120` exercises only `reorder.weekday.monday` + `reorder.weekday.sunday`. `Reorder.tsx:weekdayLabel()` can emit any of the 7 keys. All 7 keys ARE present in `en.json` (lines 124-130), so there is no crash risk — but the parity gate is not exhaustive. FIX: extend the `requiredKeys` list (or add a loop) to cover all 7 `reorder.weekday.{sunday..saturday}` keys. AC: the i18n parity test asserts all 7 weekday keys resolve (do not equal the key) and no `console.warn` fires. (This is the single weekday-parity gap; the 087 review's "i18n parity test only exercises 2 of 7 reorder weekday keys" note resolves to THIS staff test — the admin `ReorderSection.test.tsx` uses a key-echoing mock and has no weekday-key parity gate.)
- [ ] **B2 — `formatSuggestedPdf` singular `1 cs` assertion (088).** `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx:235-243` (`describe('formatSuggestedPdf …')`) covers the plural `cs` case and the non-case render, but not the singular shape. `formatSuggestedPdf` has no pluralization logic (always `cs`), so this pins the always-`cs` invariant. FIX: add one assertion, e.g. a case item resolving to `'1 cs · 24 each'`. AC: the new assertion passes; the `formatSuggestedPdf` describe block covers singular + plural + non-case.
- [ ] **B3 — staff Reorder `activeStore === null` gate (089 test-engineer AC2).** `Reorder.tsx:235` `if (!activeStore?.id) return;` (fetch effect) and the `if (!activeStore)` early-return at line 321 are implemented but untested. FIX: add a `Reorder.test.tsx` case that sets `activeStore: null` in the staff store and asserts (a) `fetchStaffReorder` is NOT called, and (b) the `<ActivityIndicator>` defense-in-depth render is shown (no list, no fetch). AC: the new test passes; the null-store branch is exercised.
- [ ] **B4 — staff Reorder date-picker re-fetch at the screen layer (089 test-engineer AC5).** The `useEffect([activeStore?.id, selectedDate, load])` re-fetches when `selectedDate` changes, but no `Reorder.test.tsx` test fires the date picker's `onChange` and asserts a second `fetchStaffReorder` call with the new `as_of_date`. FIX: add a screen-layer test that triggers the `ReorderDatePicker` `onChange` (or sets `selectedDate` via the picker) and asserts `fetchStaffReorder` is called again with the new date. AC: the new test passes; the re-fetch-on-date-change path is exercised at the screen layer (the fetch-layer `as_of_date` test in `fetchReorder.test.ts` already exists — this complements it).
- [ ] **B5 — staff Reorder loading-state testID (089 test-engineer AC8).** `Reorder.tsx:504` renders `<View testID="staff-reorder-loading">` during the initial-load state (`loading && !payload`), but no test asserts it appears. FIX: add a `Reorder.test.tsx` case that holds the fetch promise pending (or sets the initial `loading` true with `payload` null) and asserts `getByTestId('staff-reorder-loading')` is present. AC: the new test passes; all four states (loading / empty / nothing-to-order / error) are now testID-pinned.

### Open-question resolution item (documentation, not behavior)

- [ ] **D1 — per-vendor "total qty" base-unit aggregate (088).** `src/screens/cmd/sections/ReorderSection.tsx:227` `const itemTotal = vendor.items.reduce((acc, i) => acc + i.suggestedQty, 0);` and the "total qty:" header at line 278 sum `suggestedQty` in BASE units. For case-based items this reads differently from the per-item "N cases · M units" Suggested column. The architect scoped this OUT of 088 deliberately. RESOLUTION (per Open question below): this stays a BASE-UNIT sum (NOT forced into "cases" — a cases total across items with different units and case sizes is not well-defined). FIX: add a code comment at `ReorderSection.tsx:227` documenting WHY `itemTotal` is a base-unit sum and that the **est cost** total (already shown at line 283-284, `vendor.vendorTotalCost`) is the meaningful per-vendor aggregate. OPTIONAL (developer's call, low-risk): relabel the header from "total qty:" to a label that signals it is a fuzzy base-unit sum (e.g. "qty (base):") if the developer judges the current label misleading — do NOT change the value. AC: the comment is present; if relabeled, the label change is reflected and no test asserts the old "total qty:" string in a way that breaks. NO math change.

## In scope

- The cosmetic comment/rename fixes A1–A4, C1, C2.
- The test-coverage additions B1–B5.
- The documentation (and optional relabel) of the per-vendor base-unit total, D1.
- Keeping the full jest suite, both typechecks, and pgTAP green.

## Out of scope (explicitly)

- **Any reorder MATH change.** Suggested-qty, cases ceil, cost rounding, KPI recompute — all frozen. D1 explicitly does NOT change the `itemTotal` value (rationale: the resolution is "document, don't recompute"; a per-vendor cases total is not well-defined across mixed units).
- **Re-touching shipped 087/088/089/090 behavior beyond the listed nits.** The store-switch fetch logic, the `escapeHtml` PDF path, the by-the-case display string, the invite NULL-brand guard — all unchanged.
- **The over-long Spec-090 comment block** at `InviteUserDrawer.tsx:140-154`. The 090 reviewer rated trimming it a preference, not a convention violation (it follows the Spec-068 pattern). Left as-is to keep this batch minimal; trimming it is a one-line judgment with no correctness value.
- **New i18n short-weekday wiring beyond A4.** If A4 lands option (a) (keep single-letter), no i18n change ships. (Rationale: the i18n route is a clarity nice-to-have, not a correctness fix.)
- **A Track-4 Playwright e2e for the staff Reorder happy path (deferred to its own follow-up — see Dependencies).** The 089 test contract named `e2e/staff-reorder.spec.ts` but it was never created. It is feasible (the `e2e/.auth/staff.json` fixture and a staff-surface precedent `e2e/eod.spec.ts` already exist, plus an admin `e2e/reorder.spec.ts`), but a full "manager opens Reorder → sees list → exports" e2e — including the cross-platform share-sheet branch — is more than a small mechanical add and risks bloating this cosmetic+unit-test cleanup. DECISION: defer it as a separate small spec (092 or later) rather than fold it here. The unit-level coverage (B3/B4/B5) closes the jest gaps; the e2e remains a named, tracked follow-up. (If the user wants it in THIS batch, it can be promoted — surfaced as a note, not assumed.)

## Open questions resolved

- Q: For the per-vendor "total qty" header (088 nit), should we (a) document why the qty total stays base-unit, (b) drop/relabel it, or (c) force a cases total? → A (PM recommendation, carried into D1): **(a) + optionally (b) — document it as an intentional base-unit sum, and optionally relabel to signal "base units"; do NOT force a cases total.** Rationale: a per-vendor "total qty" sums across items with DIFFERENT units (each / gal / lbs / bags / cases) AND different case sizes — it is inherently a fuzzy aggregate that cannot be cleanly expressed "in cases." The meaningful per-vendor aggregate is the **Est $ total**, which is already shown (`vendor.vendorTotalCost`). The architect deliberately scoped the cases-total OUT of 088 for exactly this reason. So the resolution is documentation (and an optional honest relabel), not a math change. This was surfaced for explicit user confirmation; absent objection, D1 proceeds as documentation + optional relabel.

- Q (A4): switch the calendar weekday header from single-letter to i18n short labels? → A: developer's call between (a) keep single-letter (lowest churn) and (b) i18n short labels (clearer, but adds a `useT` import to a component that intentionally avoids it). PM recommendation: prefer (b); fall back to (a) if it expands the diff or breaks the no-`useT` invariant. Either is acceptable for this batch.

## Dependencies

- No migrations. No edge-function changes. No RPC signature changes.
- pgTAP: item C1 is a HEADER-COMMENT-ONLY edit to `report_reorder_list_cases.test.sql`; it does not change `plan()` or any assertion. No new pgTAP test.
- Follow-up (NOT a dependency of this spec): a future small spec for `e2e/staff-reorder.spec.ts` (Track 4 Playwright), using the existing `e2e/.auth/staff.json` fixture and modeled on `e2e/eod.spec.ts` / `e2e/reorder.spec.ts`.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI — `src/components/cmd/ReorderDatePicker.tsx`, `src/screens/cmd/sections/ReorderSection.tsx`, and shared `src/utils/`. Plus the staff surface `src/screens/staff/screens/Reorder.tsx` + `src/screens/staff/i18n/`. No legacy surface touched.
- **Per-store or admin-global:** N/A — no data-scope change. The staff Reorder remains `activeStore`-scoped (unchanged); B3 only TESTS the existing null-store gate.
- **Realtime channels touched:** none. (Staff stack uses no realtime per spec 062; admin realtime unchanged.)
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** web + native. The changed components run on both (RN + react-native-web). No web-only / native-only behavior is added or changed. The deferred e2e (out of scope) would be web-only (Playwright).
- **Tests — track routing (spec 022):**
  - **jest** (Track 1): A1, A3 (assertion), B1, B2, B3, B4, B5, and the C2 typecheck.
  - **pgTAP** (Track 2): C1 only — comment-only, plan count unchanged; the existing suite must stay green.
  - **shell smokes** (Track 3): none.
  - **Playwright e2e** (Track 4): none in this batch — the staff-reorder e2e is the explicitly-deferred follow-up.
- **app.json slug:** untouched. No build-identifier / push-cert / store-listing change. The `towson-inventory` slug is not in scope.

## Decisions made during implementation

- **A4 → option (a): kept single-letter `DAY_LABELS`.** Switching to the i18n short labels (`MON`/`TUE`/`WED`…, uppercase 3-letter) would (1) risk truncation in the calendar's 1/7-width cell inside a ≤320px-wide modal at 9.5px, and (2) add a `useT` dependency to `ReorderDatePicker.tsx`, which currently has none (it mirrors the i18n-free `DatePicker.tsx`). Per the spec's fallback clause ("if (b) materially expands the diff or breaks the no-`useT` invariant... fall back to (a)"), I kept single-letter and added a comment documenting the known ambiguity + why, noting the unambiguous long weekday name is already surfaced on the trigger pill and the per-cell `accessibilityLabel`. No i18n change shipped (so no new i18n parity test for the admin `enum.dayOfWeek.short.*` keys was needed). Minor: the spec's "header comment lines 6-7" reference for an explicit "no `useT`" statement was slightly off — the component header documents the DatePicker.tsx mirroring but had no literal no-`useT` line; the substance (no i18n dependency today) holds.
- **D1 → documentation + honest relabel (no math change).** Added a code comment at the `itemTotal` site in `ReorderSection.tsx` explaining it is an intentional BASE-UNIT sum (a per-vendor qty total spans mixed units + case sizes, so it can't be cleanly expressed "in cases"; the Est $ total is the meaningful aggregate). Applied the optional honest relabel of the header from `total qty:` to `qty (base):`. The `itemTotal` value is unchanged. Verified no test asserted the old `total qty:` string.

## Files changed

Production code (cosmetic / doc, no behavior change beyond A2 midnight-edge + A1 honest naming):
- `src/utils/reorderExport.ts` — A1: `todayLocalIso()` now builds `YYYY-MM-DD` from local date components (was UTC `toISOString().slice(0,10)`).
- `src/screens/staff/screens/Reorder.tsx` — A2: `maxDate` computed per render (`todayIso()`) instead of mount-only `useMemo` (fixes the past-midnight staleness).
- `src/utils/reorderDayFilter.ts` — A3: `weekdayName()` uses an explicit `Number.isNaN(d.getTime())` invalid-Date guard before `getDay()` (equivalent behavior, clearer idiom).
- `src/components/cmd/ReorderDatePicker.tsx` — A4 (option a): kept single-letter `DAY_LABELS`; added a comment documenting the choice.
- `src/screens/cmd/sections/ReorderSection.tsx` — D1: documented the per-vendor base-unit `itemTotal` sum; relabeled the header `total qty:` → `qty (base):`. No math change.

Tests:
- `src/utils/reorderExport.test.ts` — A1: new `todayLocalIso` describe block (local-components vs UTC-slice + zero-padding) via a stubbed `Date`.
- `src/utils/reorderDayFilter.test.ts` — A3: added a `'2026-13-40'` invalid-date → `null` assertion to the existing malformed-input case.
- `src/screens/staff/i18n/i18n.test.ts` — B1: extended the reorder weekday-key parity from 2 keys to all 7 (`reorder.weekday.{sunday..saturday}`).
- `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` — B2: added a singular `1 cs · 24 each` assertion (pins `formatSuggestedPdf`'s always-`cs`, no-pluralization invariant).
- `src/screens/staff/screens/Reorder.test.tsx` — B3 (activeStore-null gate: no fetch, ActivityIndicator render), B4 (date-picker `onChange` → second `fetchStaffReorder` with a new, earlier `as_of_date`), B5 (`staff-reorder-loading` testID present while the initial fetch is pending).
- `src/lib/inviteUser.test.ts` — C2: typed `mockStoreBrandRow` as `{ brand_id: string } | null` (was `any`).

pgTAP (comment-only):
- `supabase/tests/report_reorder_list_cases.test.sql` — C1: added the 12-assertion enumeration to the header comment. `plan(12)` and all assertions unchanged; still passes 12/12.
