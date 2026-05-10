# Security audit for spec 017 — Round 2

Scope: REPORTS-2 (COGS template runner), round-2 re-audit. Verifying that the depth-cap resolution (NOTICE + KPI + suffix), the new overrides-reconcile `useEffect`, the round-2 NOTICE log content, and the new `commitDate` Toast did not regress any round-1 finding or introduce new attack surface. Round-1 audit is the baseline — every prior finding is re-verified below.

## Round-1 finding verification

### Medium (depth-cap divergence) — PASS · RESOLVED

The architect's round-2 design ratified option 2 (NOTICE + envelope-surfacing) over the original `54001` raise. The migration now mirrors that contract:

- `supabase/migrations/20260511120000_report_run_cogs.sql:140-170` — the pre-walk `_walk` recursive CTE now `select count(distinct recipe_id) into v_truncated_recipe_count` from rows at `depth = 5` with non-null `sub_recipe_id`. The `bool_or(missing_cost)` semantic that round-1 verified is preserved alongside.
- `supabase/migrations/20260511120000_report_run_cogs.sql:167-170` — NOTICE log when `v_truncated_recipe_count > 0`.
- `supabase/migrations/20260511120000_report_run_cogs.sql:357-370` — compositional KPI assembly. Base 2 always present; append `Recipes missing cost` when its count > 0; append `Recipe graph truncated` when ITS count > 0. Both checks gate on the integer counter, so empty inputs cannot leak nulls (no spread of `null` into an array — both appends use `||` against `jsonb_build_array(...)`).
- `supabase/migrations/20260511120000_report_run_cogs.sql:411-422, 514-520` — `truncated_recipes` CTE materializes the same set in each row-aggregation branch (`by='item'` and `by='category'`), feeds `(tr.recipe_id is not null) as truncated` into `sales`, then `bool_or(truncated)` into `grouped_*`. Row label suffix at lines 474-477 / 569-572 prefers `' ⚠ (truncated)'` over `' ⚠'` per spec.

Contract drift from round-1 is now CLOSED — the spec, migration header (lines 45-64), and architect's round-2 recommendation all agree on the same path. Re-verified across the depth-cap question:

- **KPI value confidentiality** — `v_truncated_recipe_count` is `count(distinct recipe_id)` (bigint scalar). The KPI value is the integer only — no recipe id, name, or store id is leaked into the envelope. Verified at `supabase/migrations/20260511120000_report_run_cogs.sql:161-165, 368`.
- **Row suffix confidentiality** — `' ⚠ (truncated)'` and `' ⚠'` are static string literals (`supabase/migrations/20260511120000_report_run_cogs.sql:474-477, 569-572`). They are appended to the row's own label — never expose another row's label, recipe name from a foreign store, or PII. The row label itself (`r.menu_item` / `r.category`) comes from the BRAND-scoped `recipes` table, which the caller already has read access to via the existing brand-member RLS policies — no new exposure surface.
- **Cross-store containment of `bool_or` propagation** — the `truncated` flag is computed from `recursive_prep` walking BRAND-CATALOG tables (`recipe_prep_items`, `prep_recipe_ingredients`), not store-scoped tables. The `bool_or(truncated)` aggregate runs over rows in `grouped_item` / `grouped_category`, both downstream of the `sales` CTE which is gated by `pi.store_id = p_store_id` (`supabase/migrations/20260511120000_report_run_cogs.sql:296, 453, 550`). The `inventory_items` join (`supabase/migrations/20260511120000_report_run_cogs.sql:274-276, 437, 535`) is still per-store. No foreign-store data leaks through the truncated flag.
- **Empty-case behavior** — when no recipes are truncated, the `_walk` CTE yields no rows at `depth = 5` with un-walked `sub_recipe_id`, so `v_truncated_recipe_count = 0`, the `if v_truncated_recipe_count > 0` guard at line 366 falsifies, and the 4th KPI is NOT appended. Same for the `Recipes missing cost` KPI (line 361). The compositional `||` chain does not introduce nulls — `v_kpis` is always a non-null jsonb array of at least 2 elements after line 357, and `||` on two valid jsonb arrays cannot null-poison.

Verdict: round-1 Medium finding is RESOLVED. No new finding here.

### Low #1 (params storage bloat) — PASS · UNCHANGED

The persisted `params` jsonb in `report_runs` (`src/lib/db.ts:1710`) is still the merged object including any chip overrides; storage bloat surface is still admin-only / single-tenant and gated by per-store RLS. Round-2 didn't change the persistence shape. Informational only.

### Low #2 (UUID in 42501 error message is caller's own store) — PASS · UNCHANGED

`supabase/migrations/20260511120000_report_run_cogs.sql:102-105` still raises `'Not authorized for store %', p_store_id`. The frontend sanitizer at `src/lib/db.ts:1692-1697` still preserves messages starting with `'Not authorized'` verbatim. The leaked UUID is still the caller's own input — not cross-tenant leakage. Informational only.

### Low #3 (duplicate `isISODate`) — code-reviewer's space, SKIPPED

Per round-2 instructions; not re-audited.

## New surface (round 2)

### 5. `useEffect([myReports])` reconcile loop — PASS

Audited `src/screens/cmd/sections/ReportsSection.tsx:90-111`:

- **No infinite re-render loop.** The effect's dependency array is `[myReports]` (line 111). `myReports` is `useMemo`-derived from `savedReports.filter(...)` keyed on `[savedReports, currentStore.id]` (`src/screens/cmd/sections/ReportsSection.tsx:71-74`). Reference stability holds when neither input changes. Inside the effect, `setOverrides` writes a NEW Map only when entries actually need pruning; line 109 short-circuits via `return changed ? next : prev` to return the same reference otherwise. Since Zustand's `useStore` selector isn't reading from `overrides` (it's local React state), there's no cross-component churn to amplify. Verified.
- **No stale-state read.** The effect uses functional `setOverrides((prev) => …)` (`src/screens/cmd/sections/ReportsSection.tsx:96`) — `prev` is the latest committed state, not a stale closure capture. The Map is also re-cloned (`new Map(prev)` at line 100) before mutation so React's strict-mode double-invoke doesn't double-delete.
- **No race condition on definition creation.** A new definition appears in `savedReports` first (via the store's `addReportDefinition` action). `myReports` recomputes via `useMemo`, fires the effect — but the new definition's id IS in `valid`, so it's NOT deleted. The user can only set an override AFTER a definition exists in `myReports`, so the `setOverrideRange` / `setOverrideBy` writes are always for ids that are valid in the next reconcile. The inline delete path (`src/screens/cmd/sections/ReportsSection.tsx:298-310`) is the only race-adjacent code: it (a) clears the override Map FIRST, (b) calls `deleteReportDefinition` SECOND. If the optimistic delete reverts on backend failure, the store re-adds the row to `savedReports`, the reconcile fires, the row's id is now back in `valid` and the (now-cleared) override stays cleared — which is correct (override is in-memory only; losing it on a transient failure is acceptable per spec scope).
- **No data exposure.** The reconcile only touches React state — no network call, no log emission. The pruned ids are local store-scoped UUIDs the user already saw.

### 6. NOTICE log content — PASS

`supabase/migrations/20260511120000_report_run_cogs.sql:168-169`:

```sql
raise notice 'COGS report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated; partial cost may be undercounted)',
  v_truncated_recipe_count;
```

Single positional substitution: `v_truncated_recipe_count` (bigint scalar). No recipe id, no recipe name, no store id, no user id, no JWT claim. The NOTICE goes to the Postgres server log via the standard `RAISE NOTICE` channel — visible to the database admin (Supabase platform operator) but NOT returned in the RPC envelope. Multi-tenant exposure is zero: a tenant cannot read another tenant's NOTICE because they don't have shell/log access.

If Supabase's log aggregator forwards NOTICEs into the per-project logs UI, the only payload there is the same integer — still safe.

### 7. Toast on invalid date — PASS

`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:225-238`:

- `Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' })` — the `text1` is a STATIC string literal. The user's raw input is NOT echoed into the Toast message. There's no reflection surface to leverage even if Toast did concat.
- Verified the Toast library renders text via `<Text>{text1}</Text>` (`node_modules/react-native-toast-message/lib/src/components/BaseToast.js:9-11`) — React Native auto-escapes text content. No XSS on web; native equivalent is non-rendering of HTML by design.
- The matching modal path (`src/components/cmd/NewReportModal.tsx:159-167`) uses the same static text and same library. Both surfaces are safe.

## Per-area verification (round 2 deltas only)

1. **Migration auth gate, posture, grant/revoke** — UNCHANGED from round-1. Re-verified at `supabase/migrations/20260511120000_report_run_cogs.sql:75-105, 684-685`. PASS.

2. **`columns` header construction moved earlier** — `supabase/migrations/20260511120000_report_run_cogs.sql:172-191`. Moved to be built BEFORE the main aggregation (vs. inline in the envelope). This is the empty-result branch's early-return optimization. Same static-schema arrays; no user data flows into `columns`. PASS.

3. **The new `truncated_recipes` CTE in both row branches and the bool_or propagation** — verified at `supabase/migrations/20260511120000_report_run_cogs.sql:411-422, 447, 452, 465, 475, 514-520, 544, 549, 561, 570`. All branches: derived from brand-catalog tables, joined via `left join` into the store-scoped `sales` CTE, propagated as a bool only. No cross-store leakage. PASS.

4. **Section (10) series consolidation** — `supabase/migrations/20260511120000_report_run_cogs.sql:601-672`. The previous duplicate recursive walk is now a single CTE chain. The `daily` CTE filters on `pi.store_id = p_store_id` (line 648) and `pii.recipe_id is not null and pii.recipe_mapped = true` (lines 650-651). Same per-store guarantees as before. The new branch-free aggregation (line 661-670) selects `case when (select n from daily_count) < 2 then '[]'::jsonb else …` — no `nullable` series leakage. PASS.

5. **Frontend reconcile / delete inline cleanup** — `src/screens/cmd/sections/ReportsSection.tsx:304-309` — the pre-delete `setOverrides((prev) => { if (!prev.has(r.id)) return prev; … })` skips the state write when the entry doesn't exist, sparing a needless render. Pairs cleanly with the `useEffect`-based reconcile that handles realtime deletes from sibling tabs. No security finding.

6. **Dispatcher re-creation** — unchanged. `supabase/migrations/20260511120000_report_run_cogs.sql:694-729` preserves the `auth_can_see_store` gate, the 'stub' arm, and the not_implemented fallback verbatim. PASS.

## Dependencies

`package.json` and `package-lock.json` UNCHANGED versus the round-1 working tree. No new advisories. The pre-existing pre-REPORTS-2 advisories (1 high `@xmldom/xmldom`, 5 moderate `dompurify` / `postcss` through Expo CLI / metro-config) remain unchanged and still do not intersect the COGS RPC path (server-side jsonb aggregation, RN `<Text>` rendering, no DOM purification, no XML, no user-CSS).

## Critical (BLOCKS merge)

- None.

## High (must fix before deploy)

- None.

## Medium

- None new in round 2. The round-1 Medium (depth-cap divergence) is RESOLVED.

## Low

- `supabase/migrations/20260511120000_report_run_cogs.sql:386-489, 489-584, 601-672` — three near-identical inline copies of the recursive prep-flatten + recipe_cost chain (one in section (4), one per `by` branch in section (9), one in section (10)). Each copy is gated correctly (every `inventory_items` join still filters `store_id = p_store_id`), so this is a maintainability / DRY concern owned by the architect / code-reviewer, NOT a security finding. The four CTE invocations all enforce identical store isolation; a future spec extracting them into `public.v_recipe_cost_flat(store_id)` (per the architect's forward-compat note) would reduce drift risk. Documenting for completeness.

## Dependencies

`npm audit` skipped re-run — no `package.json` / `package-lock.json` delta since round 1. Baseline still: 6 advisories (1 high `@xmldom/xmldom`, 5 moderate `dompurify`/`postcss`), all pre-existing, none intersecting the REPORTS-2 surface.

## Bottom line

Round-2 changes are clean. The depth-cap resolution (NOTICE + count KPI + truncated suffix) replaces the round-1 fatal-raise contract with a partial-credit + envelope-surfaced approach that the architect ratified; the implementation honours the new contract end-to-end. The new compositional KPI assembly, NOTICE text, row-suffix logic, and the `useEffect`-based overrides reconcile loop all hold the per-store boundary, do not introduce new logged secrets / PII, and do not reflect user input back into UI strings in a way that could be XSS-leveraged. No new Critical, High, or Medium findings introduced.

Round-1 Medium (depth-cap divergence): VERIFIED RESOLVED.
Round-1 Lows: still informational; unchanged.

**No block recommendation.** Spec is safe to advance.
