## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical, both code-reviewer Should-fixes are resolved and re-verified, 12/12 acceptance criteria pass, the architect confirms MATCHES DESIGN, and the latest test.yml on main is green.

## Findings summary
- **code-reviewer**: 0 Critical / 2 Should-fix / 3 Nits. Both Should-fixes RESOLVED in the documented post-review fix-pass: (S1) the misleading migration comment now points to the current on-disk `20260514130000_report_reorder_list.sql` body (not the spec-021-era revision); (S2) `ReorderSection.tsx` `(item.suggestedCases as number)` replaced with proper narrowing `item.suggestedCases != null ? item.suggestedCases : ''`. Re-verified: both typechecks exit 0, affected jest 17/17. The 3 Nits are deferred and non-blocking.
- **security-auditor**: 0 Critical / 0 High / 0 Medium / 0 Low — clean PASS. Verified directly (not from design notes): `auth_can_see_store()` gate byte-identical, `security invoker` + `search_path` preserved, signature byte-identical so the `revoke from public, anon` + `grant to authenticated` ACL is preserved across the `create or replace` (no `drop function`), three new keys are pure scalar derivations of already-in-scope data (no cross-store/cross-brand leak), no dynamic SQL / `EXECUTE` / `format()`, FE display-only (no new auth surface, no secrets, no `EXPO_PUBLIC_*`), `package.json` unchanged (no new deps), pgTAP avoids `set role anon`.
- **test-engineer**: 12/12 ACs PASS (none FAIL or NOT TESTED). pgTAP 42/42 files (new `report_reorder_list_cases.test.sql` 12/12) from a clean `db reset`; jest 51 suites / 510 tests (new `ReorderSectionCases.test.tsx` 17/17); base + test-graph typechecks exit 0. Key assertions confirmed non-vacuous: cost-rounding ("NOT 49", whole-case `estimated_cost=72`), exact-multiple no-spurious-case (48/24 → 2), and the EST. TOTAL == sum-of-visible-per-row-Est$ invariant including after a spec-087 day filter.
- **backend-architect**: MATCHES DESIGN — 0 Critical / 0 Should-fix / 2 Minor (both non-actionable). Confirmed the migration body is byte-identical to the baseline except the three specified hunks, signature/grants preserved, and the cost-integrity chain (`estimated_cost` → `vendor_total_cost` → `kpis.total_estimated_cost`) holds by construction; `reorderDayFilter.ts` production code unmodified. Minors: (M1) `suggested_units` realized inline in the JSON object vs as a named column — behavior identical; (M2) the per-vendor `total qty` rollup left in base units, which is the design's own flagged open question (see "Surface for the user" below).

## Recommended next steps (ordered)
SHIP_READY:
1. **Commit** the unstaged work (the user commits at the explicit gate). The commit covers:
   - `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (NEW) + `supabase/tests/report_reorder_list_cases.test.sql` (NEW)
   - `src/types/index.ts` (`ReorderItem` +3 fields), `src/lib/db.ts` (`mapReorderVendor`)
   - `src/screens/cmd/sections/ReorderSection.tsx` (`formatSuggested`/`formatSuggestedPdf`, SUGGESTED column, `order:` sub-line, CSV `Cases`/`Units Per Case` columns, PDF `Suggested` cell)
   - `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` (NEW) + `src/utils/reorderDayFilter.test.ts` (fixture type-completeness fix)
   - `specs/088/`
2. **Apply the prod migration:** post-merge run `npx supabase db push --linked` to apply `20260602000000_reorder_suggested_cases.sql` to prod. The RPC change is additive + backward-compatible (items with `case_qty` null/≤1 are byte-for-byte unchanged), so nothing breaks during rollout. NOTE: the `db-migrations-applied` gate will go RED after the push until this `db push` runs — this is the expected spec-064 safety net, not a failure.
3. **Confirm CI after push:** per the CLAUDE.md post-push rule, confirm the next `test.yml` run on `main` is green via `gh run list --branch main --limit 1`.
4. (optional) Pick up the deferred follow-ups below in a later pass — none block ship.

### Surface for the user to confirm (deliberate scope edge, NOT a blocker)
- The per-vendor **`total qty`** header still sums base-unit `suggestedQty`, so for case-based items it can disagree with the per-item `N cases · M units` figure (e.g. the header shows the raw base-unit total while the row shows ordered units `M = cases × case_qty`). Both the architect (open question) and code-reviewer (Nit) flagged this as a **deliberate out-of-scope decision** — the ACs scope cases to the SUGGESTED figure + Est $ only, and the implementation correctly did NOT silently change the rollup. Confirm this matches product intent; if you want the rollup in ordered-units, it is a one-line follow-up (`i.suggestedUnits` in the reduce) tracked in a separate spec.

## Out of scope for this review
- **Deferred follow-ups (non-blocking, no severity above Nit/Minor):**
  - code-reviewer Nit: enumerate the 12 pgTAP assertions by number in the test header comment (cosmetic).
  - code-reviewer Nit: add a singular `1 cs · 24 each` assertion to the `formatSuggestedPdf` jest suite (no pluralization logic in the PDF helper, so nothing to break).
  - code-reviewer Nit / architect M2: the per-vendor `total qty` base-unit rollup (the scope edge above) — confirm-or-spec, not a defect.
  - architect M1: `suggested_units` realized inline vs as a named `per_item_filtered` column (cosmetic, behavior identical).
- **Pre-existing, untouched by this spec:** the standing `npm audit` advisories (`@xmldom/xmldom` high; `dompurify`/`postcss`/`brace-expansion` moderate, all transitive under `@expo/*` and the jsPDF/SVG toolchain) — baseline dependency-hygiene, no new deps introduced here.

---

**Summary:** Spec 088 is SHIP_READY. The change is a tightly-bounded, additive `create or replace` of the `report_reorder_list` RPC (server-side whole-case cost rounding per Decision B, three new derived JSON keys, signature byte-identical so grants are preserved) plus display-only frontend formatting; security is a clean PASS with no new authz/injection/exposure/deps surface, all 12 acceptance criteria pass with non-vacuous tests (pgTAP 42/42, jest 510, both typechecks exit 0), and the architect confirms it MATCHES DESIGN with the cost-integrity chain holding by construction. No reviewer flagged a Critical, both code-reviewer Should-fixes were folded in and re-verified, and the latest `test.yml` on `main` is green — so the "any Critical blocks SHIP_READY" and "no SHIP_READY on red main" hard rules are both satisfied. Remaining items are 3 Nits + 2 Minors, all non-blocking; the only thing for the user to actively confirm is the deliberate base-unit per-vendor `total qty` rollup. On commit, push to `main`, then run `npx supabase db push --linked` to apply the migration to prod and confirm the next `test.yml` run is green.

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 Criticals across all four reviewers, both code-reviewer Should-fixes resolved and re-verified, 12/12 ACs pass, architect MATCHES DESIGN, main test.yml green. Commit the unstaged work, push, then run `npx supabase db push --linked` to apply migration 20260602000000 to prod (db-migrations-applied gate goes red until then — expected). One scope edge for the user to confirm: the per-vendor `total qty` header stays base-unit by design.
payload_paths:
  - specs/088/reviews/release-proposal.md
