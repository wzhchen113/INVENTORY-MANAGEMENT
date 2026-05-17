# Code review for spec 040 — re-review post-fix pass

_Re-review after the developer fix pass. All 3 Criticals and 5 Should-fix items from the prior review were addressed; findings below reflect the current state of the code._

---

### Critical

None.

All three prior Criticals are resolved:

- `escapeHtml(out)` removed from `translate-on-save/index.ts` (line 205 now returns `out` directly); the rationale comment at lines 85-95 explains why no escaping applies.
- `setPrepRecipeI18nNames` ghost-write call is absent from `PrepRecipeFormDrawer.tsx`; comment at line 168 explains why.
- Edge function error string collapses to `"translation_unavailable"` in both the DEEPL_API_KEY-absent branch (line 233) and the all-locales-failed branch (line 282).

---

### Should-fix

None.

All five prior Should-fix items are resolved:

- `setRecipeI18nNames` double-write removed from `RecipeFormDrawer.tsx`; `updateRecipe` carries `i18nNames` in its payload and the comment at line 178 explains there is no side-channel PATCH.
- `IngredientForm.tsx` translate callback uses the functional-updater pattern (`onChangeRef.current((prev) => {...})`) at line 229.
- `callEdgeFunction` in `src/lib/auth.ts` accepts `{ signal? }` at line 161; `translateOnSave` in `src/lib/db.ts` threads it at line 1417; all four form sites pass `ctrl.signal`.
- `sourceLocale` validation at `supabase/functions/translate-on-save/index.ts:139` now correctly rejects both `null` and non-`'en'` string values.
- Migration drop signature at line 132 of `20260517000000_user_data_i18n_names.sql` lists eleven typed args matching the prior function signature.

---

### Nits

- `src/components/cmd/RecipeFormDrawer.tsx:251–258` — `scheduleTranslate` and `handleMenuItemBlur` are plain function declarations (not `useCallback`). `runTranslate` is a `useCallback` but these two wrappers are re-created on every render and passed as inline event handlers via the JSX at lines 361-362. Same pattern in `PrepRecipeFormDrawer.tsx:246-252`. The functions close over only stable values (`runTranslate`, `timerRef`, `valuesRef`), so the re-creation is harmless but inconsistent with `runTranslate` itself being memoized. Low priority; `IngredientForm.tsx` already uses `useCallback` for both (`scheduleTranslate` at line 242, `handleNameBlur` at line 247) and the inconsistency is visible in a side-by-side read.

- `src/components/cmd/RecipeFormDrawer.tsx:263` and `PrepRecipeFormDrawer.tsx:258` — `setVal` types its value parameter as `any`. The helper is a concise internal convenience and only the keys of `FormValues` can be passed for `k`, so TypeScript can't propagate the value type through the computed property. The `any` is a pragmatic choice in both drawers; worth a comment noting the intent, or alternatively typed as `FormValues[typeof k]` with a cast inside the body. Not a correctness issue.

- `src/lib/translate.ts:1` — the re-export file is one line (`export { translateOnSave } from './db'`). The extended JSDoc comment (lines 1-18) explains the dual-home design. This is fine as written but a future reader who tries to find the implementation will need to follow the re-export. If `translateOnSave` migrates to this file per the comment's stated plan, the re-export pattern will resolve itself; no action needed now.

- `supabase/tests/user_data_i18n_names.test.sql:274` — the RPC round-trip assertion (4b) stashes `v_result->'catalog'->>'i18n_names'` as a `text` value via `set_config` and then casts it back to `jsonb` in the assertion (`current_setting(...)::jsonb`). `jsonb_build_object(...)` produces `{"es": "esRoundtrip", ...}` with a `json` key order that may differ from the text representation Postgres stores for the result column. In practice Postgres normalizes key order on output so this round-trip works; it is slightly fragile if a future Postgres version or extension changes normalization. A direct `(v_result->'catalog'->'i18n_names') = jsonb_build_object(...)` comparison inside the `do` block and stashing a boolean would be more robust. Out-of-scope to fix now; noting for the next person who touches this file.
