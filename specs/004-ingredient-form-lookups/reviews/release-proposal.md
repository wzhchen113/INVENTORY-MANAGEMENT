# Release proposal — Spec 004 (Ingredient form lookups) — re-review after fix-pass

Coordinator: release-coordinator
Date: 2026-05-06 (supersedes prior FIXES_NEEDED proposal)

## Verdict

verdict: SHIP_READY
rationale: Zero Criticals across all four reviewers, all prior actionable findings RESOLVED, every fix browser-verified by main Claude, and the one remaining Should-fix is a two-line abstraction tidy with zero behavioral impact.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix, 5 Nits.
  - All 3 prior Criticals RESOLVED (slice typing cascade fully clean — `IngredientConversion[]` non-optional in `AppState`, `(s: any)` selectors gone, `(c: any)` cast and dead `c.catalogId` branch gone).
  - All 6 prior Should-fixes RESOLVED (S1 categories-delete dead-toast path, S2 snake_case fallbacks + `(conv: any)` casts, S3 `(s: any)` in `IngredientForm`, S4 regex de-dup into `validators.ts`, S5 `updateIngredientConversion` return-value chained into state, S6 `each` carve-out comment).
  - **New Should-fix**: `InventoryCatalogMode.tsx:562` calls `NUMERIC_RE.test(v)` directly while `IngredientForm.tsx:92` uses the `isNumericInput(v)` wrapper — both from the new shared `validators.ts`. Behaviorally identical today; cleanup is one import + one call-site swap. Two redundant empty-string guards (also in both call sites) are nits folded into the same edit.
  - 4 Nits carried over from prior review (N1 temp-id pattern, N3 `SelectField` import coupling, N4 misleading "base unit" header label, N6 backfill SQL CTE duplication) — all explicitly deferred by the prior proposal.

- **security-auditor**: 0 Critical, 0 High, 2 Medium STILL-OPEN by scope, 2 Low STILL-OPEN by threat model.
  - **Prior High RESOLVED**: new migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` audited verbatim against the P5 template. Live `pg_policies` shows 4 admin-gated policies; live behavior probes against `supabase_db_imr-inventory` confirm non-admin INSERT rejected, non-admin UPDATE/DELETE return 0 rows, admin INSERT succeeds. References `auth_is_admin()` (not inline JWT). Idempotent. Static SQL only — injection-impossible. No new secrets.
  - Prior `net_yield_pct` and `NUMERIC_RE` Mediums RESOLVED (range clamp surfaces Toast on out-of-range; tightened regex `/^(\d+\.?\d*|\d*\.\d+|)$/` rejects lone `.`, `..`, `1.2.`, `+1`, `-1`, `1e2`, ` 1`, `NaN`, `Infinity`).
  - 2 Mediums still open are scope-bound to multi-brand-future (`deleteIngredientConversion` brand check; realtime cross-brand chatter as a refetch trigger). 2 Lows still open are admin-threat-model accepted (vendor cross-brand FK; `notifyBackendError` raw PG errors).
  - No new attack surface introduced by the fix-pass: regex has no ReDoS (alternation is non-nested, deterministic), validators module has no I/O, categories-delete TOCTOU window is identical to pre-fix (and bounded by admin-only access anyway), yield clamp is purely tightening.
  - Auditor's bottom line: "The spec is clear from a security standpoint to advance."

- **test-engineer**: 19 PASS / 1 PARTIAL / 2 NOT-TESTED. All 5 prior coverage gaps moved forward:
  - GAP-1 (AC-F6 save-then-reload) → VERIFIED in browser (Dish Detergent: Cleaning Supplies → Dry goods, each → lbs, persisted across hard reload, including `subUnitUnit` and vendor).
  - GAP-2 (AC-F5 numeric keystroke) → REGEX-VERIFIED (`a`, `-1`, `1.2.3`, `.` rejected; `''`, `.5`, `1.`, `1.5`, `0.0` accepted).
  - GAP-3 (AC-C3 catalog-only category check) → PARTIAL (unchanged; documented in `CategoriesSection.tsx:30-32`; single-tenant-OK because `inventory` items carry `.category` from the catalog join).
  - GAP-4 (AC-C4 cross-client realtime for `ingredient_categories`) → NOT-TESTED (deferred by architect §4 design; documented in spec).
  - GAP-5 (AC-F7 SAVE-disabled vs Toast) → VERIFIED (empty-form CREATE → "Required field missing" toast; toast handler at `handleSave:102-104` now reachable).
  - One residual `(c: any)` cast at `useStore.ts:1288` is pre-existing, unrelated to spec 004's three Criticals, and explicitly marked nit/harmless. Not a regression.
  - Standing recommendation (fourth spec asking): adopt Playwright + Jest. Not a blocker.

- **backend-architect**: 0 Critical, 0 Should-fix, 1 Nit (carried over for Spec 006 cleanup). "Spec 004 is architecturally clean."
  - Slice-typing cascade verified at all 9 cited consumer sites — no `(s: any)` / `(c: any)` left on the `ingredientConversions` slice.
  - `updateIngredientConversion` return contract matches `addIngredientConversion`'s replace-on-save pattern; `db.updateIngredientConversion` returns `Promise<IngredientConversion>` with all six fields. Narrow `Pick<>` on the patch type is defensive (not drift) — prevents re-keying the catalog FK.
  - New RLS p6 migration is verbatim P5 shape, all four DML operations gated by `auth_is_admin()`, idempotent (5 legacy policy names dropped), injection-safe; `ingredient_categories` was already in `supabase_realtime` so no publication membership edits required (no realtime-restart gotcha applies).
  - `each` carve-out comment lands at the right line and explains WHY (cost-calc resolves via `subUnitSize × subUnitUnit`), not just THAT.
  - `useRealtimeSync.ts` correctly untouched. `upsertIngredientConversion` retained but unused (deferred to Spec 006 dead-code pass per prior proposal).

## Recommended next steps (ordered)

1. **Commit and ship.** All in-scope acceptance criteria are met or explicitly deferred-by-design. The prior FIXES_NEEDED items are all resolved and main-Claude-verified in the browser (save-then-reload, regex tightening, SAVE/DELETE toast paths, yield range clamp). The new RLS migration is policy-equivalent to P5 and live-probe-confirmed.
2. **(Optional, ~2 lines, can fold pre-commit OR follow up)** Tighten the `validators.ts` consumer surface — folds in code-reviewer's lone Should-fix:
   - `src/screens/cmd/sections/InventoryCatalogMode.tsx:21` — change import from `{ NUMERIC_RE }` to `{ isNumericInput }`.
   - `src/screens/cmd/sections/InventoryCatalogMode.tsx:562` — change `if (v === '' || NUMERIC_RE.test(v))` to `if (isNumericInput(v))` (drops both the misleading `v === ''` guard and the direct regex use; `isNumericInput('')` already returns true).
   - Optional bonus for symmetry: `src/components/cmd/IngredientForm.tsx:92` — drop the redundant `next !== ''` short-circuit (`isNumericInput('')` already returns true).
   - Coordinator's read: this is abstraction hygiene, not a correctness fix. Either fold pre-commit (the change is ~30 seconds) or schedule as a one-line follow-up. Both are defensible.
3. **(Optional defense-in-depth)** Run `SELECT policyname FROM pg_policies WHERE tablename = 'ingredient_categories'` against the local stack post-commit to satisfy test-engineer's NEW-GAP-3 observation (RLS migration was reviewed by SQL inspection, not by live application in their pass). Note: the security-auditor already ran this exact check — `docker exec` against `supabase_db_imr-inventory` showed the 4 expected policies, plus admin/non-admin behavior probes — so this is duplicative defense-in-depth, not gating.

## Out of scope for this review

The following are deferred-by-design and were already accepted as scope boundaries by the prior release proposal. They remain out of scope here and **do not block ship**:

- **Multi-brand-future security surface** (security-auditor):
  - `deleteIngredientConversion(id)` raw `delete().eq('id', id)` without brand check — single-brand 2026 deployment makes this bounded; revisit on multi-brand transition.
  - Realtime cross-brand chatter on `ingredient_conversions` — architecturally bounded to refetch-trigger usage, not a row-payload trust point.
- **Admin-threat-model accepted Lows** (security-auditor):
  - Vendor cross-brand FK in dropdown filter (admins are intentionally cross-brand).
  - `notifyBackendError` raw Postgres error surfacing (pre-existing pattern, not a spec 004 regression).
- **AC-C3 partial — catalog-only category check** (test-engineer GAP-3): single-tenant-OK; documented in `CategoriesSection.tsx:30-32`. Re-evaluate when multi-store ships.
- **AC-C4 NOT-TESTED — cross-client realtime for `ingredient_categories`** (test-engineer GAP-4): explicitly deferred by backend-architect's design §4; documented in spec.
- **Spec 006 cleanup queue** (carry-over Nits, none introduced by this fix-pass):
  - `useStore.ts:1282-1283` cost-calc dual-check dead branch (architect N2).
  - `db.ts:1102-1113` `upsertIngredientConversion` retained but unused by new write UI (architect N3).
  - `useStore.ts:504` temp-id pattern departs from `makeId` convention (code-reviewer N1).
  - `InventoryCatalogMode.tsx:16` `SelectField` import from `IngredientForm` (code-reviewer N3).
  - `InventoryCatalogMode.tsx:804` misleading "base unit" header label (code-reviewer N4).
  - `20260507010946_spec004_ingredient_categories_backfill.sql:38-82` duplicate CTE branches (code-reviewer N6).
  - `useStore.ts:1288` residual `(c: any)` cast — pre-existing, not introduced by this spec; harmless given typed `allConversions`.
- **DB-side CHECK constraint on `net_yield_pct`** — defense-in-depth follow-up. Client-side clamp is now in place; DB-side gate is admin-threat-model optional.
- **Standing project-level ask**: adopt Playwright (web) + Jest test framework (test-engineer, fourth spec asking). Belongs in its own spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY. 0 Criticals across all 4 reviewers. All prior FIXES_NEEDED items resolved and main-Claude-verified in browser (save-then-reload, regex tightening, SAVE/DELETE toast paths, yield range clamp). New RLS migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` is verbatim P5 shape with admin probes confirming gated writes. Optional 2-line cleanup (swap `NUMERIC_RE` → `isNumericInput` in `InventoryCatalogMode.tsx:21,562`) folds in code-reviewer's lone Should-fix; can ship as-is or fold in pre-commit. Awaiting user decision to commit.
payload_paths:
  - specs/004-ingredient-form-lookups/reviews/release-proposal.md
