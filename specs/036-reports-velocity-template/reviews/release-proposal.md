## Verdict
verdict: SHIP_READY
rationale: Zero Critical from all four reviewers; all three code-reviewer Should-fixes resolved inline pre-commit; byte-for-byte security parity with spec 035 vendor; 33/33 ACs PASS with 18/18 pgTAP, 54/54 jest, smoke clean; architect drift review confirms point-by-point design match including the dev's correctly flagged brand-scoped recipe fixture.

## Findings summary
- **code-reviewer**: 0 Critical, 3 Should-fix (S1 stale 8 → 10 comment in `reports_anon_revoke.test.sql:13`, S2 arm-5 single-row-formula mislabel in `report_run_velocity.test.sql`, S3 missing `::numeric` cast on `qty / v_window_days` at `report_run_velocity.sql:322,364`) — **ALL FIXED INLINE by Main Claude pre-commit**; 5 Nits (all cosmetic, including the explicitly-praised fixture-date defensive comment and the well-placed `byOpts` ternary deferral note).
- **security-auditor**: 0/0/0/0 — **clean sweep**. Verified byte-for-byte parity with spec 035 vendor on every security-relevant axis: SECURITY INVOKER + locked search_path + first-statement 42501 auth gate + `revoke … from public, anon` + `grant … to authenticated` on both RPC and re-created dispatcher. Verified defense-in-depth RLS on all three joined tables (`pos_imports`, `pos_import_items`, `recipes`), no dynamic SQL, allow-listed `by` parameter, native `22007`/`22008` date-parse errors sanitized by the existing `runReport` toast path, no schema/PII leak in error messages, no realtime publication impact, no new dependency surface.
- **test-engineer**: 33/33 ACs PASS, 0 FAIL, 3 NOT TESTED — `AC-B6` (22023 from > to arm), `AC-B18` (KPI tone null assertion), `AC-B20` (series non-empty path with ≥2 distinct dates). All three are explicit vendor-precedent carry-overs (spec 035 same gaps, not flagged then), out-of-budget at plan(11), or manual-by-design. `VG6` (manual browser smoke) requires human with local stack — see Recommended next steps. `npm run test:db` 18/18 (was 17, +1 new file), `npm test -- --ci` 54/54, `npm run test:smoke` PASS, `npx tsc --noEmit` clean (only pre-existing TS2688 stubs), `npm run typecheck:test` clean.
- **backend-architect**: 0 Critical, 0 Should-fix, 3 Nits (cosmetic: stale "Mirrors vendor's Top vendor cross-cut" comment in arm 10 — vendor has no such arm, this is net-new coverage; growing per-spec self-reference in `reports_anon_revoke.test.sql` header; empty-string `menu_item` defensive note acceptable per architect §A15 "developer call"). Drift walkthrough confirms point-by-point design match across §A0-§A17 including: 11 design-choice header bullets, top-N=5 constant, dispatcher arm slot order, `v_window_days = (v_to - v_from) + 1` denominator, `qty / v_window_days` velocity formula, all 3 KPIs `"tone": null`, `series '[]'::jsonb` not null on short-circuit, `byOpts` ternary deferral comment verbatim. Dev's brand-scoped recipe fixture adjustment correctly resolves the post-P3 `recipes.store_id` drop via `stores.brand_id` lookup — design-aligned per §A5 / Q9.

## Recommended next steps (ordered)

### SHIP_READY — commit and deploy

1. **Commit** — user runs the commit (Main Claude does not auto-commit per project policy).

2. **POST-MERGE DEPLOY (PROMINENT — required for PREVIEW badge removal):**
   ```
   npx supabase db push --linked --yes
   ```
   This applies `supabase/migrations/20260515120000_report_run_velocity.sql` to production Postgres. Without it the velocity tile still loses its PREVIEW badge (frontend flip is in the bundle), but clicking it will hit the dispatcher's stub envelope path instead of real velocity data. The dispatcher returns a valid envelope so the UI does not error — but no rows render until the migration lands.

3. **Pre-deploy manual smoke (recommended; VG6 is the one outstanding test-engineer gate):**
   - Cmd UI Reports → confirm velocity tile no longer shows the PREVIEW badge.
   - Click tile → modal opens with `template=velocity` pre-filled, `by:` defaults to `'recipe'`.
   - Save → Run → verify three KPIs render (`Total qty sold`, `Total revenue $`, `Top mover`) plus the rows table and series chart.
   - Switch `by:` between `recipe` and `category` → verify distinct row shapes (`recipe / qty_sold / day_count / velocity / revenue` vs `category / recipes_count / qty_sold / day_count / velocity / revenue`). `Top mover` should remain recipe-grouped under both modes (AC-B19).

## Out of scope for this review

Fast-follow / non-blocking — none of these gate ship:

- **test-engineer's optional pgTAP gap — 22023 from > to arm.** Consistent gap with spec 035 vendor (also omitted then, not flagged). Could close all three Reports-template gaps in one follow-up sweep across `report_run_waste.test.sql` / `report_run_vendor.test.sql` / `report_run_velocity.test.sql` by adding a `throws_ok(..., '22023', ...)` arm to each, bumping each plan by 1.
- **test-engineer's optional pgTAP gap — series non-empty path with ≥2 distinct dates.** Same vendor-precedent carry-over; fold into the same sweep above if pursued.
- **test-engineer's optional pgTAP gap — KPI `"tone": null` assertion.** Manual-only per spec; same vendor precedent.
- **code-reviewer's 5 Nits** — all cosmetic (`byOpts` structural divergence between modal map and frame ternary acknowledged, fixture-date defensive comment praised, arm-8 30-day-window note minor reader-clarity polish).
- **backend-architect's 3 Nits** — cosmetic: stale "Mirrors vendor's Top vendor cross-cut" comment in arm 10 (vendor has no such arm; arm 10 is net-new coverage, the comment is misleading), growing header self-reference in `reports_anon_revoke.test.sql` (rewrite as one-liner if it gets noisier), empty-string `menu_item` defensive `nullif(trim(...), '')` left unshipped per architect's explicit "no action needed."
- **Architect §A0 #4 deferral — `byOpts` ternary refactor to `templates.ts` options-prop.** Promote in spec 037 (the final Reports backlog template — custom, sandboxed `EXECUTE` edge function), when the structural divergence between modal's `BY_OPTIONS` map and frame's ternary chain crosses five live templates.
- **`npm audit` baseline cleanup** — 1 high + 5 moderate + 5 low, all in jest-side dev dependencies (`@xmldom/xmldom` via `jest-expo` → `jsdom`, `dompurify` and `postcss` via `expo` toolchain). Not reachable from production or web runtime. Same baseline since spec 035; out of scope for this spec, candidate for a dedicated dev-dep audit sweep.
