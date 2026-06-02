## Code review for spec 088

### Critical

No Critical findings.

---

### Should-fix

- `supabase/migrations/20260602000000_reorder_suggested_cases.sql:5` — Comment says "Body is copied verbatim from spec 021's migration". The file being copied is `20260514130000_report_reorder_list.sql`, but that file was already updated in-place by spec 087 to include the `as_of_date` / EOD-first logic. Developers doing a future `create or replace` of this function need to copy from *this* migration (the one on disk right now), not the spec 021 original. The comment could mislead a developer into fetching the git-blame version of the file from before spec 087, producing a regression. Suggested fix: change line 5 to read "Body is copied verbatim from the *current* `20260514130000_report_reorder_list.sql` (which itself carries spec 087's `as_of_date` / EOD-first additions) …".

- `src/screens/cmd/sections/ReorderSection.tsx:464` — `(item.suggestedCases as number)` is a TypeScript `as` assertion used to suppress the `number | null` type error rather than to fix it. The local variable `isCase` (`item.suggestedCases != null`) narrows the value at runtime, but TypeScript doesn't track narrowing through a stored boolean. The correct pattern is a non-null assertion `item.suggestedCases!` (which is honest about what the developer knows at this point) or restructuring the ternary so TypeScript can infer the narrowing: `item.suggestedCases !== null ? item.suggestedCases : ''`. CLAUDE.md flags `as` assertions used to suppress type errors rather than fix them. The current form is safe at runtime but will mask future type breakage if `isCase`'s definition ever drifts from `suggestedCases != null`.

---

### Nits

- `supabase/tests/report_reorder_list_cases.test.sql:51` — `select plan(12)` is correct (12 assertions confirmed: 1 `isnt` + 10 `is` + 1 `ok`). The plan label comment in the header (line 22) says "12 assertions" but doesn't enumerate them by number the way the reference test (`report_reorder_list_hybrid_formula.test.sql`) does. A brief enumeration in the comment (e.g. "1 fixture resolve, 4 CASE item, 3 EXACT item, 3 PLAIN item, 1 rollup") would make future plan-count audits faster. Minor — no functional impact.

- `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx:235–243` — The two-test `formatSuggestedPdf` suite covers the `cs` abbreviation for a case item and the unchanged non-case render, but omits the singular `1 cs · 24 each` shape (which is tested in `formatSuggested` but not in the PDF variant). Since `formatSuggestedPdf` has no pluralization logic (always `cs`), there is nothing to break, and the function body is simple. Worth adding one assertion but not a correctness risk.

- `src/screens/cmd/sections/ReorderSection.tsx:245` — `itemTotal` still sums raw `suggestedQty` (base units), producing a "total qty" header figure that may disagree with the SUGGESTED column for case-based items (which shows ordered units = `suggestedUnits`). The architect explicitly noted this as a deliberate out-of-scope decision (spec §"Backend design (architect)" open question at the bottom) — flagging here only so the release-coordinator can confirm it matches product intent, not as a code defect. (out-of-scope)

---

### Summary

The implementation is clean and well-bounded. The migration correctly copies the full function body with exactly three additive hunks and preserves the signature byte-for-byte (no grant churn). The `estimated_cost` → `vendor_total_cost` → `kpis.total_estimated_cost` inheritance chain is correct by construction — the single rounding point at `per_item_filtered.estimated_cost` flows through `sum()` in both rollup CTAs automatically. The FE does zero cost math as mandated by Decision B. The pgTAP plan count matches the assertions (12/12). The `formatSuggested` / `formatSuggestedPdf` helpers are exported for jest and tested against the full AC matrix (ceil, exact-multiple, singular/plural, null/0/1 unchanged, EST. TOTAL invariant after day filter). No direct Supabase calls outside `db.ts`, no inline hex colors in React Native code, no new realtime channels, no legacy file edits, no `app.json` slug changes.

The two Should-fix items are: (1) a comment that could mislead a future developer into copying from the wrong git revision of the source migration, and (2) a `as number` type assertion that should be a non-null assertion `!` instead.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in; the 3 Nits deferred (1 is the architect's documented out-of-scope item).

- **S1 (misleading migration comment)** — **fixed.** The header now states the body is copied from the CURRENT on-disk `20260514130000_report_reorder_list.sql` (originally spec 021, updated IN-PLACE by spec 087) and that a future `create or replace` MUST copy the LATEST on-disk body, not the spec-021-era revision. Comment-only — pgTAP unaffected.
- **S2 (`as number` assertion, `ReorderSection.tsx`)** — **fixed.** Replaced `isCase ? (item.suggestedCases as number) : ''` with `item.suggestedCases != null ? item.suggestedCases : ''` — TypeScript now narrows `number | null → number` directly in the truthy branch (no assertion, no `!`). Functionally identical; both typechecks pass.
- **Nits (3)** — deferred: (1) the pgTAP plan-count enumeration comment (cosmetic), (2) a missing singular-`1 cs` assertion in the `formatSuggestedPdf` jest suite (no pluralization logic in the PDF helper, so nothing to break), and (3) the per-vendor "total qty" header still summing base-unit `suggestedQty` — which is the architect's explicitly-flagged out-of-scope open question (per-vendor total stays base-unit), surfaced for the release-coordinator/user to confirm matches product intent, not a defect.

Re-verified post-fix-pass: `npx tsc --noEmit` (base) + `npx tsc -p tsconfig.test.json --noEmit` (test graph) both exit 0; `npx jest src/screens/cmd/sections/__tests__/ReorderSectionCases` 17/17 green. (The migration comment change is inert to pgTAP; the full pgTAP 42/42 + jest 510 baselines from the build still stand.)
