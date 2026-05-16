# Backend architect post-impl review — Spec 038

Mode: post-implementation drift review.
Scope: design contract in spec 038 §0–§9 vs the implementation shipped on
2026-05-16 (files listed under spec's `## Files changed`).

Verdict: **APPROVE with minor noise.** Zero Critical, zero Should-fix.
Three Minor naming / dead-code points. The implementation honors every
load-bearing design decision: migration shape, RLS posture, PostgREST-not-RPC
contract, db.ts surface, hydration ordering, hooks placement, catalog shape,
cache key, LocaleSwitcher mount points, no realtime publication change, no
new edge function.

The two intentional design overrides (`useT()` location moved to
`src/hooks/useT.ts` per spec body; type aliased as `Locale` not `LocaleCode`
in the public i18n module) are improvements and are noted, not flagged.

## Findings (Critical → Should-fix → Minor)

### Critical
None.

### Should-fix
None.

### Minor

**M1. `t()` parameter order reversed from the design pseudocode.**
- Design §8 pseudocode: `t(key: string, locale: LocaleCode, params?)`.
- Implementation at `src/i18n/index.ts:58-62`: `t(locale, key, vars?)`.
- This is a wider divergence on paper than in practice. The function is
  only called from one place (`src/hooks/useT.ts:22`), the call site reads
  cleanly, and the locale-first convention is the more common shape in
  i18n libs (matches `i18next.t(lng, key, opts)` style). No downstream
  call site in the spec extraction code calls `t()` directly — they all
  go through `useT()`. The signature drift is invisible to consumers.
- The implementation also added a parameter-naming change (`params` →
  `vars`). Same story: invisible to consumers.
- **Action: none.** The internal contract is the implementer's call; the
  consumer contract via `useT()` is unchanged. Flag for awareness only.

**M2. Type aliased as `Locale` rather than `LocaleCode`.**
- Design §4 / §5 / §8 prose calls the union `LocaleCode`. The exported
  i18n module names it `Locale` (`src/i18n/index.ts:16`). The store has
  a private local alias `LocaleCode` (`src/store/useStore.ts:50`) — same
  union, different name.
- Consumers (`useLocale.ts:9`, `LocaleSwitcher.tsx:21`) import `Locale`
  from i18n. The store's `LocaleCode` is private and the action
  signatures (`setLocale`, `hydrateLocale`) inline-type the union as
  `'en' | 'es' | 'zh-CN'` instead of importing `Locale`. So there are
  three names for the same union floating around: `Locale` (public),
  `LocaleCode` (private to store), and the inline literal union.
- Mild ergonomic inconsistency. Refactoring the store action signatures
  to use `Locale` (imported from `../i18n`) and dropping the local
  `LocaleCode` alias would normalize this in ~5 line edits. Out of scope
  for any acceptance-criteria gate.
- **Action: none required.** Note for a future cleanup pass.

**M3. Unused type guard `isLocale` in `src/store/useStore.ts:52`.**
- Defined at line 52, never referenced. Likely a relic from an earlier
  iteration of `App.tsx`'s `readCachedLocaleSync`, which uses an inline
  literal-union check instead (`v === 'en' || v === 'es' || v === 'zh-CN'`,
  `App.tsx:78`).
- Dead code in the store module. Not a runtime risk; trips the
  TypeScript-noUnusedLocals rule only if enabled (it isn't here).
- **Action: drop the function or wire it through to `readCachedLocaleSync`
  so the same predicate is used in both places.** Cleanup, not a blocker.

## Cross-check vs the 10 specific review prompts

1. **Migration** — `supabase/migrations/20260516000000_profiles_locale.sql`
   matches the design verbatim: additive `add column if not exists`,
   CHECK with the three locales, `not null default 'en'`, no RLS change,
   no publication change. Comment block explicitly calls out the
   no-publication-change posture. PASS.

2. **`coerceLocale` helper** — Lives at `src/lib/auth.ts:48-50`, exported,
   correct defense-in-depth shape (returns `'en'` for any value that is
   not `'es'` or `'zh-CN'`). Wired into the `fetchProfile()` return at
   `auth.ts:125`. PASS.

3. **`saveLocale` helper** — `src/lib/db.ts:1291-1300`, sits immediately
   after `saveSidebarLayout` (lines 1268-1277). Plain PostgREST
   `.update({ locale }).eq('id', userId)` shape, throws on error. No
   new RPC. PASS.

4. **Store contract** — `locale` slice (initial `'en'`) at
   `useStore.ts:451`; `setLocale` at lines 1947-1961 implements the
   optimistic-then-revert + `notifyBackendError('Save language', e)`
   pattern; `hydrateLocale` at 1967-1969 is the no-persist hydrator;
   logout reset to `'en'` at line 518. All four items match the design
   §5 spec. PASS.

5. **Hooks minimal and pure** — `useLocale` (`src/hooks/useLocale.ts`) is
   a single-line selector. `useT` (`src/hooks/useT.ts`) returns a
   `useCallback`-memoized translator keyed on locale. Both are pure and
   minimal. PASS.

6. **Catalog shape** — three JSON files (`en.json`, `es.json`,
   `zh-CN.json`) with nested-key structure. `t()` does plain string-leaf
   lookup with no generated typed union (per design's explicit decision
   to defer typed keys). PASS.

7. **Cache key** — `LOCALE_KEY = 'imr.locale'` at `useStore.ts:48`,
   namespaced. Exported for `App.tsx` to import. PASS.

8. **`LocaleSwitcher` placement** — Mounted in both `sidebarFooterRight`
   (`ResponsiveCmdShell.tsx:257`) and `railFooter` (line 268) next to
   `ThemeToggle`. PASS.

9. **No `profiles` in realtime publication** — Migration body contains no
   `alter publication` statement. The only `supabase_realtime` mentions
   are explanatory comments. PASS.

10. **No new edge functions** — `grep -r locale supabase/functions/`
    returns zero files. PASS.

## Architectural drift summary

Zero contract-level drift. Three minor naming / dead-code observations.
The two notable implementation choices that diverge from the design's
pseudocode are improvements (parameter order in `t()`) or
indistinguishable from the design intent (`Locale` vs `LocaleCode`).

The implementation is faithful to the design.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  3 Minor (naming inconsistency, unused helper, parameter-order
  divergence in t()). All design contract points pass. Implementation
  is faithful to the design.
payload_paths:
  - specs/038-multi-language-support-p1-chrome/reviews/backend-architect.md
