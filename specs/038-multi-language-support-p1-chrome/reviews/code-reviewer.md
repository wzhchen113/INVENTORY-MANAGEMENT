# Code review for spec 038

_Re-review post Should-fix pass. All 6 prior Should-fix items confirmed resolved. Security-auditor Low (logout cache) confirmed resolved._

---

## Critical

_None._

---

## Should-fix

_None._

---

## Nits

All 7 nits from the prior review are re-assessed below.

**Nit 1 (prior) — `t()` argument order reversed from spec pseudocode.**
`src/i18n/index.ts:60` — `t(locale, key, vars?)` (locale-first) vs spec §8 pseudocode showing key-first. Unchanged. The implementation is internally self-consistent; this is a spec-doc discrepancy only. Deferred to spec author to update the pseudocode.

**Nit 2 (prior) — double `useStore` subscription in `LocaleSwitcher`.**
Resolved. `LocaleSwitcher.tsx` now reads `locale` via `useLocale()` at line 34 and `useT()` internally does the same via `useLocale()`. Both go through the hook; the raw `useStore((s) => s.locale)` at the old line 33 is gone.

**Nit 3 (prior) — `App.tsx:209` truthy check on `result.locale`.**
`App.tsx:209` — `if (result.locale) hydrateLocale(result.locale)` still uses a truthy check rather than the explicit undefined-guard (`!== undefined`) that the adjacent `sidebarLayout` check uses. Safe for the current locale values (all non-empty strings), but inconsistent with the surrounding pattern. Still a nit.

**Nit 4 (prior) — `logout` not persisting locale reset to localStorage.**
Resolved. `src/store/useStore.ts:517` — `persistLocaleLocal('en')` is now called alongside `set({ locale: 'en' })` in the logout action.

**Nit 5 (prior) — untranslated English literals in `AuditLogSection.tsx`.**
`src/screens/cmd/sections/AuditLogSection.tsx:125,141` — unchanged, still explicitly deferred by the spec's partial-extraction note. Out-of-scope for this cycle.

**Nit 6 (prior) — `'#000'` color literals in `CategoriesSection.tsx`.**
`src/screens/cmd/sections/CategoriesSection.tsx:167,221` — unchanged pre-existing debt. Out-of-scope.

**Nit 7 (prior) — pgTAP test file naming mismatch vs spec AC.**
`supabase/tests/profiles_locale.test.sql` vs original AC text `profiles_locale_check.test.sql` — unchanged. The "Files changed" section of the spec now matches the actual filename; no action needed.

**New nit — `App.tsx` inline locale union not using `Locale` type.**
`App.tsx:74,83` — `readCachedLocaleSync` and `readCachedLocaleAsync` both annotate their return type as `'en' | 'es' | 'zh-CN' | null` rather than `Locale | null`. The Should-fix 3 was correctly applied to `useStore.ts` and `types/index.ts` (both now import `Locale` from `src/i18n`), but `App.tsx` was not updated. `Locale` is not imported in `App.tsx`. When a fourth locale is added these two function signatures will need a manual update that the TS compiler won't catch. Fix: add `import type { Locale } from './src/i18n';` to `App.tsx` and change both return-type annotations to `Locale | null`.

**Residual test nit — `any` cast in fallback test.**
`src/i18n/i18n.test.ts:136` — `let cur: any = es` to navigate the nested JSON object. The `try/finally` correctly restores the deleted key. The technique is sound (Jest module cache shares the same object reference the i18n module holds). The `any` is appropriate here as a test-internal navigation tool; there's no safer typed alternative without significantly complicating the helper. Noting for visibility only.
