# Release proposal — Spec 040 (multi-language P3 — user-entered data translations)

## Verdict
verdict: SHIP_READY
rationale: All four reviewers post-fix are Critical-clean (0/0/0/0); the prior round's 3 code-reviewer Criticals and 1 test-engineer Critical are individually verified resolved, and the remaining findings (4 nits, 2 Low, 1 Should-fix architect S1 — note: architect S1 is the same `escapeHtml` issue the code-reviewer marked resolved; verified by direct read that `index.ts:205` returns `out` without escape) are non-blocking.

## Findings summary

- **code-reviewer:** 0 Critical, 0 Should-fix, 4 Nits. All three prior Criticals (escapeHtml mangling at `translate-on-save/index.ts:205`, `setPrepRecipeI18nNames` ghost-write in `PrepRecipeFormDrawer.tsx`, edge function error-string mismatch) explicitly confirmed resolved. All five prior Should-fix items resolved (RecipeFormDrawer double-write removed, IngredientForm functional updater, `AbortSignal` threaded end-to-end via `callEdgeFunction → translateOnSave → form sites`, `sourceLocale` validation tightened to reject null + non-`'en'`, migration drop signature lists eleven typed args). Carried-forward nits: useCallback inconsistency between RecipeFormDrawer/PrepRecipeFormDrawer vs IngredientForm; `setVal` `any` typing in two drawers; `src/lib/translate.ts` one-line re-export; pgTAP 4b `set_config` round-trip fragility — none ship-blocking.

- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low. Verified clean across all 10 threat-model focus areas: `DEEPL_API_KEY` server-side only and never logged/echoed; input validation (200-char cap, type guards, allowlist `LOCALE_TO_DEEPL`); ADMIN_ROLES parity with `super_admin`; JSONB type-safe at Postgres boundary; RPC re-creation preserves `security invoker` + locked `search_path` + existing RLS; realtime publication NOT widened (pgTAP `(6a)/(6b)` locks the category exclusion); DeepL outbound pinned to HTTPS; npm audit baseline unchanged (no `package.json` diff). Low #1 (`escapeHtml` side-effect on translations) — note: re-read of `index.ts:205` confirms this is now `return out` directly, so Low #1 in the file appears to be a stale write — the actual current code does NOT escape. Low #2 (wildcard CORS) is project-wide pattern consistent with `delete-user` / `send-invite-email`, deferred to a future cleanup spec.

- **test-engineer:** 29 PASS, 0 FAIL, 1 NOT TESTED (live DeepL integration — accepted nit per spec Verify-AC3 manual-smoke clause). All Forms / Schema / Helper / Edge / Read / Realtime / Concurrency / Verification ACs PASS. Forms-AC9 amended Path 2 (UI write path scoped to `ingredient_categories`; `recipe_categories` UI explicitly deferred per the spec amendment) — `CategoriesSection.tsx` implements Spanish + Chinese inputs against `ingredient_categories.i18n_names`. Edge-AC8 graceful-degrade contract previously NOT TESTED is now PASS via 4 new `translate.test.ts` cases (503 from key-absent + 503 from all-failed + fetch reject + no-session). Track 1 jest: 138/138 passing across 12 suites. Track 2 pgTAP: 17/17 assertions (added 2d/2e backfill for the two category tables). Typecheck (both `typecheck` and `typecheck:test`) exit 0.

- **backend-architect:** 0 Critical, 1 Should-fix (S1), 2 Minor (M1, M2). S1 (escapeHtml on DeepL output) and M1 (the contradictory inline comment) are both the same surface that code-reviewer marked resolved — the architect's review references `index.ts:206` calling `escapeHtml(out)` but post-fix the file returns `out` directly at line 205 with an updated rationale comment at lines 85-95. **The architect review file appears to predate the fix commit or was written off a stale snapshot — direct read of the current `index.ts` confirms the escape is gone.** M2 (`src/lib/translate.ts` one-line re-export) is a noted design-vs-implementation hop the architect flags as low-priority follow-up. All OQ-A1 through OQ-A5 decisions confirmed in place (single-PR phasing, client-initiated edge call, `ZH-HANS` mapping, hybrid blur OR 600ms idle debounce, no SQL-side `localized_name` helper). All risk-list drift checks clean (no `pg_net`, no SQL helper, no category realtime widening, no per-field RPC, no provider abstraction).

## Operator one-time setup (REQUIRED before auto-fill works)

The `translate-on-save` edge function reads `DEEPL_API_KEY` from `Deno.env.get('DEEPL_API_KEY')`. Until the secret is set, every translate call returns `503 { error: 'translation_unavailable' }` and the form gracefully degrades to manual-only entry (this path IS tested by `translate.test.ts` case 2). To enable the auto-fill feature:

**Local dev:**
```
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup>
```

**Production:**
```
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup> --project-ref <prod-project-ref>
```

DeepL free-tier signup at https://www.deepl.com/pro-api gives a key without payment info; rate limits apply. Without this step, P3 ships as "manual translations work; auto-fill silently no-ops" — acceptable but not the spec's user story.

## Recommended next steps (ordered)

1. Confirm `release-proposal.md` reflects the post-fix reality (architect file's S1 was written off a stale snapshot — current `translate-on-save/index.ts:205` returns `out` without escape; code-reviewer's re-read agrees).
2. Run `supabase secrets set DEEPL_API_KEY=<key>` locally (see Operator one-time setup above) — required for manual smoke-testing the auto-fill flow before commit if desired.
3. Stage the commit artifact set:
   - Spec: `specs/040-multi-language-support-p3-user-data.md`
   - Reviews: `specs/040-multi-language-support-p3-user-data/reviews/{code-reviewer,security-auditor,test-engineer,backend-architect,release-proposal}.md`
   - New migration: `supabase/migrations/20260517000000_user_data_i18n_names.sql`
   - New pgTAP: `supabase/tests/user_data_i18n_names.test.sql`
   - New edge function: `supabase/functions/translate-on-save/index.ts`
   - New helper: `src/i18n/localizedName.ts` + `src/i18n/localizedName.test.ts`
   - New hook: `src/hooks/useLocalizedName.ts`
   - New wrapper: `src/lib/translate.ts` + `src/lib/translate.test.ts`
   - Updated: `src/lib/auth.ts`, `src/lib/db.ts`
   - Updated: `src/store/useStore.ts`, `src/store/useStore.test.ts`, `src/types/index.ts`
   - Updated: `src/utils/filterParser.ts`
   - Updated form drawers: `src/components/cmd/IngredientForm.tsx`, `IngredientFormDrawer.tsx`, `RecipeFormDrawer.tsx`, `PrepRecipeFormDrawer.tsx`
   - Updated read sites: `src/screens/cmd/sections/CategoriesSection.tsx`, `InventoryCatalogMode.tsx`, `RecipesSection.tsx`, `PrepRecipesSection.tsx`, `src/components/cmd/InventoryDesktopLayout.tsx`
   - Updated jest: `src/i18n/i18n.test.ts`
4. User confirms commit, then deploys (Vercel auto-deploys main; edge function deploy via `supabase functions deploy translate-on-save --project-ref <prod>`).
5. Post-deploy: manual smoke per Verify-AC3 — create an ingredient called "Yellow Onion" in English mode, watch Cebolla Amarilla / 黄洋葱 populate the override fields, save, switch locales, verify list/sort/search behavior.

## Out of scope for this review

- `recipe_categories` UI write path (Cmd UI) — spec amendment Path 2 explicitly defers. Backend infrastructure (column, store action `setRecipeCategoryI18nNames`, `updateRecipeCategoryI18n` helper) ships as infrastructure-only.
- Live DeepL integration test (Verify-AC3 / test-engineer NOT TESTED) — requires an out-of-band `DEEPL_API_KEY` secret; manual smoke only per spec.
- Wildcard CORS posture (`Access-Control-Allow-Origin: *`) across all 10 edge functions — project-wide cleanup spec; not a spec 040 regression.
- npm-audit baseline (11 vulnerabilities, devDeps only) — no `package.json` change in spec 040; future `npm audit fix` cleanup spec.
- `src/lib/translate.ts` body migration from `db.ts` re-export to direct ownership (architect M2) — design intent unfulfilled but functionally clean; defer to a v2 spec that adds a translation provider abstraction.
- useCallback consistency across the three form drawers (code-reviewer nit) — pragmatic styling difference, no correctness issue.
- pgTAP 4b round-trip robustness via `set_config`/`current_setting` cast (code-reviewer nit) — switch to direct boolean comparison inside the `do` block in a future pgTAP refactor.
- The minor `RecipesSection.tsx:336` raw-English `sel.category` render in the detail header — correct fallback behavior until the deferred `recipe_categories` UI lands.
- Detail header `sel.category` localization (test-engineer Minor) — correct in current state because `recipe_categories.i18n_names` is `{}` until the deferred UI ships.

## Handoff

next_agent: NONE
prompt: SHIP_READY (0 Criticals across all four reviewers; operator must run `supabase secrets set DEEPL_API_KEY=<key>` before auto-fill activates — graceful-degrade path tested).
payload_paths:
  - specs/040-multi-language-support-p3-user-data/reviews/release-proposal.md
