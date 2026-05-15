## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; both code-reviewer Should-fixes were already applied inline (dead `v_total_qty` removed, arm-5 comment clarified) and 17/17 pgTAP still PASS; remaining items are nits, optional coverage gaps, and an informational security watch-line.

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix (BOTH FIXED inline by Main Claude pre-commit), 2 Nits. Top issues: S1 dead `v_total_qty` variable in the plpgsql declare block (removed; comment now documents why no Total-qty KPI is surfaced); S2 arm-5 "Single-row happy path" label referenced a non-existent architect note (comment rewritten to document the deliberate plan(11) consolidation that exercises both single-row formula and multi-row ordering in one arm). Nits N1 (use `ByOption` alias on the `by` state hook annotation) and N2 ("shared analytic keys" header wording over-promises — `items_affected` is category-only, `unit` is item-only) are non-blocking style/doc.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 Low (informational watch-point only). Byte-for-byte security parity with spec 034 (waste): `language plpgsql` + `security invoker` + `set search_path = public`, `auth_can_see_store(p_store_id)` raising 42501 as the first statement, `revoke from public, anon; grant to authenticated`. Defense-in-depth confirmed across all five joined tables (`purchase_orders`, `po_items`, `vendors`, `inventory_items`, `catalog_ingredients`) — including the orphan-vendor case where a cross-brand vendor row is filtered to NULL by `auth_can_see_brand(v.brand_id)` RLS and surfaces as `'(deleted vendor)'` rather than leaking a name. `by` allow-listed at line 143; no dynamic SQL; range-error message reflects only already-cast `::date` values. Anon-revoke pgTAP extended to plan(10), new arm fires under `set local role anon`. Frontend wiring introduces no new auth surface (React Native `Text` is XSS-safe; RPC's server-side allow-list is the authoritative gate). Low item is a forward-looking note that future contributors must not widen the range-error message to include raw `p_params` substrings.

- **test-engineer**: 30 PASS / 0 FAIL / 8 NOT TESTED. Verification gates all PASS (`tsc --noEmit` clean, `typecheck:test` clean, `npm test -- --ci` 54/54, `npm run test:db` 17/17 with new file +1, `test:smoke` PASS). 7 of 8 untested items are optional pgTAP coverage gaps that the spec's plan(11) budget did not allocate arms for (AC-B5 default-param coercion, AC-B6 22023 raise on `from > to`, AC-B12/13/14 sentinel labels, AC-B18 KPI tone-null, AC-B19 Top vendor KPI presence/format, AC-B20 series multi-date populated path) — all implementations are correct in the migration; the ACs are just not pinned by an assertion. None are in the spec's authored §Tests list. The 8th NOT TESTED is the manual browser smoke (AC-V6), recommended pre-deploy. Arm-numbering nit (spec's §Tests narrative orders missing-cost as arm 6 / status filter as arm 8, but the landed file uses 7 → status filter / 8 → missing-cost because they share an `_env` temp table and the NULL-cost insert has to be last) is documented and coverage is identical.

- **backend-architect**: 0 Critical, 0 Should-fix, 2 Nits. Implementation matches design contract end-to-end across §A1-§A11. Drift table is all PASS: filename slot, signature + auth gate + grants byte-for-byte, header design-notes block, CTE pipeline (shared prelude → columns → totals + top-vendor → empty short-circuit → KPIs → branched rows → series → envelope), dispatcher arm slotted after `'waste'` with all prior arms preserved verbatim, frontend 4-file wiring matches per-line specs, no realtime publication touch, no edge fn / `db.ts` / `useStore.ts` / `app.json` slug change. Nits N1 (pgTAP arm ordering deviates from §A6's enumeration — shared-temp-table constraint that the design author didn't fully account for; coverage identical) and N2 (vendor name-lookup by `name=` is fragile if seed renames SYSCO / RESTAURANT DEPOT — already minimized by named lookup vs hard-coded UUIDs) are documentation-only.

## Recommended next steps (ordered)

SHIP_READY.

### 1. Post-merge deploy (BLOCKING — surface prominently in the merge checklist)

```
npx supabase db push --linked --yes
```

Applies migration `supabase/migrations/20260514180000_report_run_vendor.sql` to production. **Without this step**, the vendor template tile will show live (no PREVIEW badge from `templates.ts:32`) but `report_run('vendor', ...)` will fall through to the dispatcher's `not_implemented` stub envelope and the RUN button will silently return "Runner coming soon" — a confusing UX regression. The developer correctly did NOT auto-run this per spec §Post-merge deploy; it is the release-coordinator's job to flag it here and the user's call to execute after `git push`.

Rollback (if needed): `drop function public.report_run_vendor(uuid, jsonb);` plus re-create the prior dispatcher version from `20260514170000_report_run_waste.sql:425-460`.

### 2. Pre-deploy manual smoke (RECOMMENDED — covers test-engineer's AC-V6)

Boot the local stack (`npm run dev:db`) and exercise the path end-to-end in the Cmd UI:

1. Navigate Reports → confirm **vendor tile loses the PREVIEW badge**.
2. Click the vendor tile → `NewReportModal` opens **pre-filled with `template=vendor`**, three by-chips (`vendor` selected by default, `category`, `item`).
3. Save the report → it appears in "your reports" grid.
4. Open the detail frame → click **Run**.
5. Verify:
   - KPI strip renders **Total spend $**, **Top vendor**, **POs in period** with `tone: null` (no colored band).
   - Table populates with vendor groups; rows sorted dollar-desc.
   - Multi-line chart renders one line per vendor when the window spans ≥2 distinct dates.
6. Toggle the three `by:` modes in the detail frame — verify distinct row shapes:
   - `vendor` → `vendor / po_count / total_qty / dollar_impact`
   - `category` → `category / po_count / total_qty / items_affected / dollar_impact`
   - `item` → `item / po_count / total_qty / unit / dollar_impact`
7. Change the date range → re-runs cleanly against the new window.

### 3. Commit and push

User to confirm the commit per project policy. Suggested commit message shape:

```
Spec 035: Reports vendor template (SHIP_READY)
```

## Out of scope for this review (fast-follow, non-blocking)

Optional pgTAP coverage gaps that fell outside the spec's authored plan(11) budget — convert to a tiny follow-up spec if the reports surface keeps expanding:

- test-engineer's 7 optional gaps: default-param coercion (AC-B5), 22023 raise on `from > to` (AC-B6), sentinel labels `'(no vendor)' / '(deleted vendor)' / '(deleted item)' / '(uncategorized)'` (AC-B12/13/14), KPI tone-null assertion (AC-B18), Top vendor KPI presence/format (AC-B19), series multi-date populated path (AC-B20).
- code-reviewer N1: use `ByOption` alias at `NewReportModal.tsx:124` instead of the inline literal union.
- code-reviewer N2: rewrite the migration header bullet "Shared analytic keys: po_count, items_affected, total_qty, unit" to clarify that `items_affected` is category-only and `unit` is item-only.
- backend-architect N1: doc-only note that pgTAP arm ordering deviates from §A6 enumeration (shared-temp-table constraint).
- backend-architect N2: future-watch line if a seed refresh ever drops or renames SYSCO / RESTAURANT DEPOT (would break arms 5/6/7/9/10 with a clear "no such row" error).
- security-auditor Low: future-contributor watch-point — do NOT widen the `'Vendor report: from > to (% > %)'` raise to include raw `p_params` substrings.

Two backlog Reports templates remain after spec 035 closes: **velocity** and **custom**. Spec 035 is the second of four (post-waste/spec 034); 11 specs shipped this session (025-035).
