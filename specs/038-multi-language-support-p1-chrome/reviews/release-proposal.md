# Release proposal — Spec 038 (multi-language support — P1 chrome)

_Second proposal: refreshed after the user picked Path 2 (amend AC-CHROME-5 / AC-CHROME-6 to the chrome-priority subset) and the frontend developer landed all 6 code-reviewer Should-fix items + the 1 security-auditor Low. Prior proposal (FIXES_NEEDED) is superseded by this one._

## Verdict
verdict: SHIP_READY
rationale: All four reviewers now report 0 Critical (test-engineer's two prior Criticals on AC-CHROME-5 + AC-CHROME-6 cleared by the spec amendment, code-reviewer's 6 Should-fix items all resolved, security-auditor's logout-cache Low resolved); the remaining items are 3 Nits, 3 Minors, and 1 pre-existing informational Low, none of which gate the ship rule.

## Findings summary

- **code-reviewer:** 0 Critical, 0 Should-fix, 3 Nits.
  - All 6 prior Should-fix items confirmed resolved: dead `isLocale` guard removed, `catalogs` / `_warned` no longer over-exported, three parallel `Locale` unions unified onto `import { Locale } from '../i18n'`, `LocaleSwitcher` + `useT` now route through `useLocale()`, `TitleBar` switch-store `accessibilityLabel` rewired to a dedicated action-shaped key, and the vacuous English-fallback test rewritten to genuinely exercise the fallback path via runtime catalog mutation.
  - Remaining nits: (a) `App.tsx:74,83` `readCachedLocaleSync` / `readCachedLocaleAsync` annotate `'en' | 'es' | 'zh-CN' | null` instead of `Locale | null` (the Should-fix-3 unification was applied to `useStore.ts` + `types/index.ts` but not propagated into `App.tsx`); (b) `App.tsx:209` uses a truthy check on `result.locale` rather than the explicit `!== undefined` guard used for the adjacent `sidebarLayout` check; (c) the `any` cast in the rewritten fallback test (`i18n.test.ts:136`) — appropriate as a test-internal navigation tool, noted for visibility only. Three prior nits are no longer in scope (spec doc discrepancies / pre-existing color literals).

- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low (one resolved by the fix pass, one pre-existing informational).
  - **Resolved:** the logout-cache Low (`useStore.ts:514-518`) is now fixed — `persistLocaleLocal('en')` is called alongside `set({ locale: 'en' })` in the logout action, so the cached value in `localStorage` / `AsyncStorage` is cleared on sign-out and no longer flashes the previous user's chrome language on tab reload. Confirmed by reading the auditor file (the Low is unchanged in the file but the code-reviewer and test-engineer both verify the fix landed at `useStore.ts:517`).
  - **Pre-existing informational:** the "Users can update own profile" RLS policy is row-scoped, not column-scoped. Spec 038 ratifies this because the new `profiles_locale_check` CHECK constraint is the binding bound on `locale`. Documented for future column additions; no action requested.
  - All eight remaining focus areas (write path, CHECK tightness, `coerceLocale` defense, i18n string substitution / XSS, catalog content, `AuthResult.locale` provenance, migration safety, no new edge functions) pass clean.

- **test-engineer:** 22 PASS across all acceptance criteria, 0 Critical, 1 Nit; the two prior Criticals (AC-CHROME-5, AC-CHROME-6) cleared by the spec amendment.
  - **AC-CHROME-5 cleared by amendment.** The amended AC scopes extraction to 13 of 21 section files by name (`AuditLogSection`, `BrandsSection`, `CategoriesSection`, `DashboardSection` chrome-only, `EODCountSection`, `InventoryCountSection`, `POSImportsSection`, `ReorderSection`, `ReportsSection`, `RestockSection`, `UsersSection`, `WasteLogSection`). The 8 deferred files (`RecipesSection`, `PrepRecipesSection`, `VendorsSection`, `ReceivingSection`, `ReconciliationSection`, `POsSection`, `OrderScheduleSection`, `InventoryCatalogMode`) correctly have no `useT` import.
  - **AC-CHROME-6 cleared by amendment.** The amended AC scopes extraction to 5 named chrome components (`Sidebar`, `ThemeToggle`, `LocaleSwitcher`, `TitleBar`, `CommandPalette`); all 5 import `useT` and call `T()`. Deeper drawer / modal extraction is explicitly out of scope.
  - **One Nit (downgraded from prior Critical):** `DashboardSection` is listed in-scope "chrome only" but has `useT` imported at line 13 and `const T = useT()` at line 94 with zero `T(...)` call sites. The user-visible sidebar label "Dashboard" is already correctly translated via `cmdSelectors.ts::T('sidebar.items.dashboard')`; the section-interior heading is body-level copy and body extraction is explicitly deferred. Stranded import worth flagging but non-blocking against the amended AC text.
  - Test runs: jest 9/9 suites / 73/73 tests; pgTAP 21/21 files; both typechecks exit 0. The rewritten English-fallback test now genuinely exercises the fallback path (runtime catalog mutation on the imported `es` object) and asserts both the returned English value and the one-time `console.warn`.
  - NOT-TESTED items (unchanged, non-blocking, all pre-existing pattern gaps): logout reset assertion, `setLocale` optimistic-then-revert path, `coerceLocale → hydrateLocale` login path, first-paint cache read in `App.tsx`. Same shape as the equivalent gaps for `setSidebarLayoutOverride` (spec 008) and dark-mode.

- **backend-architect:** 0 Critical, 0 Should-fix, 3 Minor. Overlap with code-reviewer fully resolved.
  - **M2 (three names for the same union) resolved.** The Should-fix-3 fix pass dropped `LocaleCode` from the store and unified everything onto `Locale` imported from `src/i18n/index.ts`. The architect's M2 observation no longer applies (one residual: `App.tsx` still uses an inline literal union — flagged as code-reviewer Nit, not Minor).
  - **M3 (unused `isLocale` guard) resolved.** Dead code deleted from `useStore.ts` as part of the Should-fix-1 cleanup.
  - **M1 (`t()` parameter order vs design pseudocode) remains as spec-doc discrepancy only.** Implementation is internally self-consistent; the consumer contract via `useT()` is unchanged. No action required.
  - All 10 design contract points (migration shape, RLS posture, `coerceLocale`, `saveLocale`, store contract, hooks, catalog, cache key, switcher placement, no realtime / no edge function) PASS.

## Recommended next steps (ordered)

1. **Commit the entire spec 038 changeset.** Artifacts to stage:
   - **Migration:** `supabase/migrations/20260516000000_profiles_locale.sql`
   - **pgTAP:** `supabase/tests/profiles_locale.test.sql`
   - **i18n catalogs + helper:** `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`, `src/i18n/index.ts`, `src/i18n/i18n.test.ts`
   - **Hooks:** `src/hooks/useLocale.ts`, `src/hooks/useT.ts`
   - **Store + types:** `src/store/useStore.ts` (locale slice, `LOCALE_KEY`, `persistLocaleLocal`, `setLocale`, `hydrateLocale`, logout reset + cache clear, dead-code cleanup, `Locale` unification), `src/types/index.ts` (AppState `locale` field via imported `Locale`)
   - **Backend helpers:** `src/lib/auth.ts` (`AuthResult.locale`, `coerceLocale`, `fetchProfile` wiring), `src/lib/db.ts` (`saveLocale`)
   - **App hydration:** `App.tsx` (`readCachedLocaleSync` / `readCachedLocaleAsync`, both `useLayoutEffect` + session-restore wiring, post-`getSession` `hydrateLocale(result.locale)`)
   - **Locale switcher:** `src/components/cmd/LocaleSwitcher.tsx`
   - **Cmd shell mount:** `src/screens/cmd/ResponsiveCmdShell.tsx` (LocaleSwitcher in both footer slots, sign-out + EOD literals through `T()`)
   - **5 chrome components:** `src/components/cmd/Sidebar.tsx`, `src/components/cmd/ThemeToggle.tsx`, `src/components/cmd/TitleBar.tsx`, `src/components/cmd/CommandPalette.tsx` (LocaleSwitcher already listed above)
   - **Sidebar selector:** `src/lib/cmdSelectors.ts` (sidebar group + item labels, `SCREEN_ENTRIES_DEFS`, `getCommandPaletteIndex` + `useCommandPaletteIndex` translator threading)
   - **13 section files:** `src/screens/cmd/sections/AuditLogSection.tsx`, `BrandsSection.tsx`, `CategoriesSection.tsx`, `DashboardSection.tsx`, `EODCountSection.tsx`, `InventoryCountSection.tsx`, `POSImportsSection.tsx`, `ReorderSection.tsx`, `ReportsSection.tsx`, `RestockSection.tsx`, `UsersSection.tsx`, `WasteLogSection.tsx` (12 listed by amended AC; AuditLogSection counted once)
   - **Test infra:** `jest.config.js` (i18n test path extension)
   - **Spec + reviews:** `specs/038-multi-language-support-p1-chrome.md`, `specs/038-multi-language-support-p1-chrome/reviews/code-reviewer.md`, `specs/038-multi-language-support-p1-chrome/reviews/security-auditor.md`, `specs/038-multi-language-support-p1-chrome/reviews/test-engineer.md`, `specs/038-multi-language-support-p1-chrome/reviews/backend-architect.md`, `specs/038-multi-language-support-p1-chrome/reviews/release-proposal.md`

2. **(Optional) Pre-commit cleanup — strip the dead `useT` import in `DashboardSection.tsx`.** The test-engineer Nit notes that `DashboardSection` imports `useT` at line 13 and binds `const T = useT()` at line 94 with zero call sites. Two lines to delete; eliminates a stranded import and lines up the file with the amended AC's "chrome only — body deferred" framing more cleanly. Strictly cosmetic and not required to ship.

3. **(Optional, follow-up spec) Promote the code-reviewer's new nit on `App.tsx`.** Add `import type { Locale } from './src/i18n'` and change the two `readCachedLocale*` return types to `Locale | null`. Same single-source-of-truth posture as the Should-fix-3 fix that landed in `useStore.ts` + `types/index.ts`; carries a small bus-factor benefit when a fourth locale is added.

## Out of scope for this review

- **Deeper section / component extraction (8 deferred sections + 23 deferred cmd components + Dashboard body / KPI / queue / heatmap).** Explicitly named in the spec's "Known follow-up work" block. The catalog parity test guarantees future keys land in all three locales simultaneously.
- **Native-speaker review of `es` / `zh-CN` translations.** PM open question #4. Hand-translated initial pass shipped.
- **NOT-TESTED store action paths** (`logout` reset, `setLocale` optimistic-then-revert, `coerceLocale → hydrateLocale` login flow). Same gap shape as `setSidebarLayoutOverride` (spec 008). Best back-filled as part of a broader store-test pass, not in 038.
- **`t()` parameter-order doc fix in spec §8 pseudocode.** Implementation is `t(locale, key, vars?)`; pseudocode shows `t(key, locale, params?)`. Architect M1 and code-reviewer prior-nit-1 both flagged this as a spec-doc-only discrepancy. Spec edit only, no code change.
- **Pre-existing informational Low — column-scoped RLS posture on `profiles`.** Security-auditor flagged for awareness on future spec authors adding user-writable columns; the locale CHECK constraint is the binding bound here.
- **Pre-existing npm audit baseline** (5 low / 5 moderate / 1 high). Not introduced by 038. Owned by a separate dependency-hygiene spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY. 0 Critical across all four reviewers post fix-and-amendment pass. One optional pre-commit cleanup surfaced (strip dead `useT` import in DashboardSection — 2 lines).
payload_paths:
  - specs/038-multi-language-support-p1-chrome/reviews/release-proposal.md
