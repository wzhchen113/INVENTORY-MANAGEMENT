# Spec 038: Multi-language support — Phase 1 (chrome only)

Status: READY_FOR_REVIEW

## User story

As a store manager whose primary language is Spanish or Mandarin Chinese,
I want the admin app's chrome (sidebar, buttons, tab labels, modal titles,
toast notifications, empty states, accessibility labels) to render in my
preferred language, so I can navigate the app without translating every UI
control in my head. My language preference must follow me across devices
the same way dark-mode does, and must persist across sessions.

Concrete scenario: a manager at the Frederick store sets her preferred
language to `zh-CN` in the bottom-left chrome bar. She reloads the tab on
her laptop. The sidebar group labels ("Operations", "Planning",
"Insights") render in Chinese, the "Sign out" link renders in Chinese,
the EOD-count footer caption renders in Chinese, and the "Save draft"
toast that fires when she touches the EOD section renders in Chinese.
Catalog ingredient names like "House Special Blend Sauce", the recipe
name "Chicken Over Rice", and the category "Produce" still render in
English. The user-typed `notes` field on a waste-log row also still
renders verbatim in whatever language the operator typed it in.

## Acceptance criteria

Backend / DB:

- [ ] Migration `supabase/migrations/20260516000000_profiles_locale.sql`
      adds column `profiles.locale text not null default 'en'` with
      CHECK constraint `locale in ('en', 'es', 'zh-CN')`.
- [ ] Existing rows are auto-backfilled to `'en'` by the column default
      (no separate UPDATE statement required since `not null default`
      backfills on `add column`).
- [ ] `profiles` is already in the `supabase_realtime` publication for
      RLS-scoped UPDATEs that the user's own session subscribes to via
      `useStore.currentUser.id`. Verify, and if absent add
      `alter publication supabase_realtime add table public.profiles;`
      in the same migration. (Quick check shows it is NOT in the current
      tightened publication — see
      `supabase/migrations/20260514140000_realtime_publication_tighten.sql`.
      If we add it, we MUST follow the realtime gotcha: local devs run
      `docker restart supabase_realtime_imr-inventory`. This is an
      architect-decision item, see Open questions below.)
- [ ] The "Users can update own profile" RLS policy already covers
      `profiles.locale` writes via `auth.uid() = id`. No new policy.

Frontend / state:

- [ ] `useStore` carries a `locale: 'en' | 'es' | 'zh-CN'` slice
      (default `'en'`), a `setLocale(value)` setter that persists locally
      (web localStorage / native AsyncStorage under key
      `'imr.locale'`) and writes through to `profiles.locale` via the
      optimistic-then-revert + `notifyBackendError` pattern, plus a
      `hydrateLocale(value)` no-persist setter that the App.tsx login
      restore path calls (mirrors `setDarkMode` / `hydrateSidebarLayoutOverride`).
- [ ] `src/lib/auth.ts` `AuthResult` carries an optional `locale?: 'en' | 'es' | 'zh-CN'`
      field. `fetchProfile()` reads `profile.locale` and returns it
      (defaulting `'en'` when the column is missing for any reason).
- [ ] `App.tsx` first-paint synchronous read pulls the cached locale
      from localStorage (web) into the store BEFORE the first render,
      mirroring the `readCachedDarkModeSync()` shape so we don't get a
      flash of English chrome on a Spanish session reload.
- [ ] Native (Platform.OS !== 'web') async restore of the cached locale
      runs alongside the existing async dark-mode restore in the
      session-restore effect.
- [ ] A new `useLocale()` hook in `src/hooks/useLocale.ts` reads
      `useStore.locale` (mirrors `useColors()` / `useCmdColors()`).

i18n library + catalog:

- [ ] **Library choice (architect may revisit):** hand-rolled `t()` over
      a typed message catalog. JSON message files at
      `src/i18n/{en,es,zh-CN}.json`, a thin `t(key, params?)` wrapper at
      `src/i18n/index.ts`, and a `useT()` hook that pulls the active
      catalog from `useLocale()` and returns a memoized `t()` bound to
      it. Justification under "Design notes" below.
- [ ] Keys are nested dot-paths (`sidebar.groups.operations`,
      `sidebar.items.inventory`, `chrome.signOut`, `chrome.eodFooter`,
      `toast.savedDraft`, `eod.tabs.count`, etc.). Catalog files mirror
      the nesting shape.
- [ ] `t('missing.key')` falls back to the English value when the key
      is missing in the active locale, and calls `console.warn` once per
      missing-key on first miss (de-duped via a module-level `Set`).
      Falls back to the raw key string only when English is also
      missing — that case should never ship.
- [ ] `t(key, { count: N })` does NOT need full ICU plural rules in P1
      — a simple `{varName}` placeholder substitution is enough. The
      catalog author writes two separate keys when plural forms diverge
      (`stock.itemsLow.one`, `stock.itemsLow.other`) and the caller
      picks. ICU MessageFormat / `i18next` plural rules are a P2 follow-up
      (out of scope; see below).
- [ ] All three catalog files (`en.json`, `es.json`, `zh-CN.json`) ship
      with the same key set. A jest test under `src/i18n/i18n.test.ts`
      asserts that the three files have identical key-sets (no orphans,
      no missing).

Chrome string extraction (P1 deliverable):

- [ ] Sidebar group labels and item labels in
      `src/lib/cmdSelectors.ts`'s `useDefaultSidebarGroups()` are routed
      through `t()`. Group labels: "Operations", "Planning", "Insights",
      "Admin", "Tenancy". Item labels: 17 items including "Inventory",
      "Dashboard", "EOD count", "Inventory count", "Waste log",
      "Receiving", "Purchase orders", "Vendors", "Menu items / BOM",
      "Prep recipes", "Restock", "Reorder", "Reconciliation",
      "POS imports", "Audit log", "Reports", "DB inspector",
      "Users & access", "Brands".
- [ ] `SCREEN_ENTRIES` labels in the same file (used by the command
      palette `⌘K` index): 16 entries.
- [ ] The bottom-left chrome strings in
      `src/screens/cmd/ResponsiveCmdShell.tsx`: "sign out", "Sign out?",
      "You will need to sign back in.", "EOD {n}/{total}", plus the
      sign-out `accessibilityLabel`. Sample line refs: `Sign out` literal
      at ResponsiveCmdShell.tsx:236-247.
- [ ] The `ThemeToggle` pill copy in
      `src/components/cmd/ThemeToggle.tsx`: "☼ light" / "☾ dark" (kept
      as-is when the locale-specific transliteration looks worse than
      the icon-only fallback — translator may render `"☼ light"` →
      `"☼ luz"` / `"☼ 浅色"` etc., or omit the word and keep the icon).
- [ ] **Chrome-priority subset** of section files under
      `src/screens/cmd/sections/` is translated — section titles, tab
      labels, button text, empty-state copy, accessibility labels. The
      shipped subset (13 of 21 files) is: `AuditLogSection`,
      `BrandsSection`, `CategoriesSection`, `DashboardSection` (chrome
      only — KPI / queue / heatmap body deferred), `EODCountSection`
      (worksheet chrome + toasts + day-pill labels + history header),
      `InventoryCountSection`, `POSImportsSection`, `ReorderSection`,
      `ReportsSection`, `RestockSection`, `UsersSection`, `WasteLogSection`.
      The remaining 8 section files (`RecipesSection`, `PrepRecipesSection`,
      `VendorsSection`, `ReceivingSection`, `ReconciliationSection`,
      `POsSection`, `OrderScheduleSection`, `InventoryCatalogMode`) are
      **explicitly out of scope** for spec 038 — tracked under
      "Known follow-up work" and gated by the catalog-parity test so
      future additions land in all three locales together.
- [ ] **Chrome-priority subset** of `src/components/cmd/` is translated —
      `Sidebar`, `ThemeToggle`, `LocaleSwitcher`, `TitleBar`,
      `CommandPalette`, and adjacent chrome components needed to fully
      localize the desktop shell. Deeper extraction inside the remaining
      cmd component drawer / modal / form-body files is **explicitly
      out of scope** for spec 038 — tracked under "Known follow-up
      work." Rationale: the chrome subset is what surrounds every
      screen at all times and gives users immediate visible feedback
      that the locale switched; the drawer / modal bodies are
      lower-frequency and can be picked up in a follow-up extraction
      sweep without re-architecting anything.
- [ ] **Out of scope explicitly within the chrome pass:** any string
      that interpolates a user-entered value — ingredient names, recipe
      names, vendor names, category names, brand names, store names,
      note fields. The English template stays in the catalog
      (e.g. `inventory.itemDeleted`: `"{itemName} deleted"`); only the
      template is translated. The interpolated `{itemName}` flows
      through verbatim in the user's typed language.

Language switcher UI:

- [ ] A new `LocaleSwitcher` compact pill component in
      `src/components/cmd/LocaleSwitcher.tsx`, mounted in
      `ResponsiveCmdShell.tsx`'s `sidebarFooter` / `railFooter` /
      `sidebarFooterRight` slots next to the existing `ThemeToggle`.
      Shape: cycle on tap through `en → es → zh-CN → en` (mirrors the
      `ThemeToggle` two-state pill pattern, just three states instead of
      two). Pill copy: the active locale's own-name short form (`EN`,
      `ES`, `中文`). Architect may override placement / shape (e.g.
      dropdown vs cycling pill).
- [ ] `accessibilityLabel` on the switcher uses the
      `chrome.localeSwitcher.aria` key.

Behaviour on switch:

- [ ] Tapping the switcher calls `setLocale(next)`, which
      synchronously updates the store, persists to localStorage /
      AsyncStorage, fires the UPDATE to `profiles.locale`, and the
      re-render flows through `useT()` consumers automatically (Zustand
      subscription on the `locale` slice).
- [ ] No reload, no remount of the navigator. If a sub-component caches
      a translated string in `useMemo` keyed on something else, that's a
      bug for that component to fix — the architect should call out a
      lint rule in the design doc.
- [ ] The DB write going through realtime causes the user's other open
      tabs to update too (after we add `profiles` to the publication; see
      Open questions). Cross-device propagation happens on next session
      restore.

Tests:

- [ ] **Track 1 (jest).** `src/i18n/i18n.test.ts` asserts:
      (a) `en.json`, `es.json`, `zh-CN.json` are valid JSON;
      (b) the three files have identical key-sets via a recursive
      flatten-keys helper;
      (c) `t('sidebar.groups.operations')` returns the English string when
      locale is `'en'`, the Spanish string when `'es'`, the Chinese
      string when `'zh-CN'`;
      (d) `t('definitely.missing.key')` returns the key path and warns
      once.
- [ ] **Track 2 (pgTAP).** `supabase/tests/profiles_locale_check.test.sql`
      asserts:
      (a) inserting a profile with `locale = 'fr'` throws SQLSTATE 23514;
      (b) inserting with `locale = 'en'` / `'es'` / `'zh-CN'` succeeds;
      (c) an existing pre-migration row defaults to `'en'`;
      (d) RLS: a `user` JWT can UPDATE their own `profiles.locale` but
      not another user's.
- [ ] No Track 3 smoke is required for P1 (no edge function involved).

Misc:

- [ ] `npm run typecheck` and `npm run typecheck:test` both pass.
- [ ] `npm test` and `npm run test:db` both pass.

## In scope

- Three locales: `'en'` (default), `'es'`, `'zh-CN'`.
- One DB migration adding `profiles.locale` + CHECK constraint, and
  (pending architect decision) adding `profiles` to the realtime
  publication.
- One `useStore` slice (`locale` + `setLocale` + `hydrateLocale`).
- One `useLocale()` hook + one `useT()` hook + a `t()` function over a
  typed message catalog.
- Three JSON catalog files under `src/i18n/`.
- One `LocaleSwitcher` component placed in the existing bottom-left
  chrome bar alongside the dark-mode toggle.
- Extracting English literal strings from:
  - `src/lib/cmdSelectors.ts` (sidebar definitions + screen-entry index)
  - `src/screens/cmd/ResponsiveCmdShell.tsx` (chrome footer)
  - the **chrome-priority subset** of `src/screens/cmd/sections/` (13
    of 21 files — listed by name in the acceptance criteria above; the
    remaining 8 are deferred follow-up)
  - the **chrome-priority subset** of `src/components/cmd/`
    (`Sidebar`, `ThemeToggle`, `LocaleSwitcher`, `TitleBar`,
    `CommandPalette`, and adjacent shell chrome — drawer / modal /
    form bodies deferred)
  - `src/components/cmd/ThemeToggle.tsx`
- Catalog parity test (jest) and `profiles.locale` constraint test
  (pgTAP).

## Out of scope (explicitly)

- **User-entered data translations** — deferred to spec **040**. Catalog
  ingredient names, recipe names, prep names, vendor names, store names,
  note fields, custom report queries, audit-log free-text. The English
  template surrounding interpolated user values gets translated; the
  user-typed value flows through verbatim.
- **Enum / category label translations** — deferred to spec **039**.
  Recipe categories like `'Sandwiches & Burgers'`, ingredient categories
  like `'Produce'`, role names like `'super_admin'`. These are
  stored-as-string in the DB and need a separate curated lookup table
  with locale-keyed display labels; P1 does not touch them.
- **Translation-API integration** — no on-the-fly translation service
  (DeepL, Google Translate, Anthropic) in P1. The catalog is hand-translated
  (or LLM-translated offline) by the developer and committed to the
  repo. A future spec can add a build-step that flags drift.
- **Browser locale auto-detection** — P1 always defaults to `'en'`
  on a new profile. A future "Hybrid" follow-up spec can read
  `navigator.language` on first sign-up and pre-set `profiles.locale`.
- **Per-store locale** — locale is per-user, not per-store. A store
  with three staff in three languages is fine; each user gets their own
  chrome language.
- **ICU MessageFormat / full plural rules** — P1 uses simple
  `{varName}` substitution. Catalog authors split keys for plural
  variants (`itemsLow.one`, `itemsLow.other`). True plural-rule support
  belongs in a P2 polish spec.
- **Date / number / currency formatting** — P1 does NOT switch from
  `new Date().toISOString().slice(0, 10)` to `Intl.DateTimeFormat(locale)`,
  does NOT swap `'$'` for the locale's currency symbol, and does NOT
  re-format numbers (decimal separators, thousands separators). This is
  the single most important deferral: a Spanish manager sees Spanish
  chrome but English-format dates and dollar signs. Tracking this as a
  separate follow-up spec keeps P1 small.
- **RTL (right-to-left) layout support** — no Arabic / Hebrew in scope.
  When added, layout work is non-trivial (mirror everything except text
  alignment). Not P1.
- **Customer PWA / staff app localization** — those apps live in
  sibling repos. P1 covers only the admin surface in
  `imr-inventory`.
- **Email templates from edge functions** — the
  `send-invite-email` HTML body is currently English-only and stays
  English-only in P1. Localizing the invite email needs the inviter's
  intended locale on the call, or the invitee's preferred locale, and
  introduces an additional `escapeHtml` consideration per the
  CLAUDE.md edge-function bullet. Out of scope.

## Open questions resolved

- Q: How many locales in P1? → A: Three (`en` default, `es`, `zh-CN`).
- Q: Where is the language preference stored? → A: Per-user, in
  `profiles.locale` (text column with CHECK constraint), mirroring the
  `profiles.dark_mode` precedent.
- Q: Library choice — `i18next` + `react-i18next`, or hand-rolled? → A:
  Hand-rolled. Justification under "Design notes" below.
- Q: First-run default? → A: `'en'`. No browser-locale auto-detection
  in P1.
- Q: Switcher UI placement? → A: Bottom-left chrome bar next to the
  `ThemeToggle`, as a third compact pill. Architect may override.
- Q: Realtime channel? → A: `profiles` UPDATE flows through whatever
  publication scope we end up with (see Open questions below).
- Q: Catalog translation source? → A: Manual / LLM-offline; commit JSON
  files to repo. No on-the-fly API.
- Q: Missing-key fallback? → A: Fall back to English value + warn once
  (de-duped per key). Never show `[untranslated]`.

## Open questions for the architect

These need a design decision before build:

1. **Add `profiles` to `supabase_realtime` publication?** Currently
   `profiles` is NOT in the explicit publication list (verified against
   `20260514140000_realtime_publication_tighten.sql`). Without realtime,
   cross-tab and cross-device propagation happens only on next session
   restore — which is probably fine for a language preference (the user
   already toggled it, so the source tab is correct; the next tab they
   open will be right). Adding `profiles` to the publication adds a
   realtime gotcha cost (`docker restart` on mid-session pub changes).
   Recommend NOT adding it for P1 and surfacing as a follow-up — but
   architect may decide otherwise.

2. **Bundle-size of all three catalogs.** Three JSON catalogs with
   ~500-800 keys each at ~50 chars per string is ~200 KB of strings
   bundled into every web client. Compressed it is much smaller (~30 KB
   gzipped), but P1 should still confirm: do we ship all three catalogs
   to every client (simpler — no dynamic import, no waterfall on locale
   switch), or do we lazy-load the non-active catalogs (web only —
   `import('./i18n/es.json')` returning a Promise, no equivalent on
   native bundle, so the platforms diverge)? Recommend ship-all, given
   the size is small and lazy-loading introduces async paint into a
   path that today is sync.

3. **Cycle pill vs dropdown for the switcher.** Cycle pill matches the
   existing `ThemeToggle` shape but is less discoverable for "which
   languages are even available?". A dropdown with three options is
   more discoverable but is a new component pattern in the chrome.
   Recommend cycle pill for P1; revisit when locale count grows past 3.

4. **String catalog ownership and review.** Who reviews the Spanish
   and Chinese translations? P1 spec assumes the implementing developer
   commits an initial pass (likely LLM-translated); review by a native
   speaker is a follow-up that lives outside this spec.

## Dependencies

- Existing: `profiles` table, `auth.uid()`-based RLS on profile updates
  (init schema), the `setDarkMode` / `dark_mode` precedent, `App.tsx`
  hydration path, `useStore` Zustand store, `useRealtimeSync` channels,
  `react-native-toast-message`.
- New: nothing external. The hand-rolled approach intentionally avoids
  adding `i18next` / `react-i18next` / `intl-messageformat` as
  dependencies.

## Design notes

### Why hand-rolled instead of `i18next` + `react-i18next`?

`i18next` is the obvious well-tested default but introduces three
sharp edges for this codebase:

1. **Bundle weight.** `i18next` core + `react-i18next` + the ICU plural
   plugin add ~50 KB minified to a bundle that is already at the upper
   end of "fine on a phone" — see how App.tsx is gating first paint on
   font load alone. P1's needs (`t(key, params?)` + nested keys +
   fallback) are ~80 LOC hand-rolled.

2. **React Native + react-native-web compatibility.** `react-i18next`'s
   `useTranslation` hook works on RNW but has some history of resolver
   weirdness with bundlers (Metro vs webpack). The hand-rolled hook
   reads from the same `useStore` slice every other Cmd feature reads
   from, so there is one consistent state-flow rather than two.

3. **Plural rules don't pay off in P1.** The codebase already
   hand-writes plural variants inline (e.g. `${n} ${n === 1 ? 'item' :
   'items'}` in `cmdSelectors.ts` AttentionItem text). Hoisting these
   into two-key splits in the catalog (`one` / `other`) is the same
   amount of work as routing through `i18next`'s plural plugin, and the
   shape is simpler for catalog reviewers.

The trade-off: if the team later wants full ICU MessageFormat
(`{count, plural, one {...} other {...}}` in one key), the
hand-rolled approach has to be replaced. That's an explicit follow-up
spec; the migration path is small because all call sites go through
one `t()` function.

### Catalog file shape

```jsonc
// src/i18n/en.json
{
  "sidebar": {
    "groups": {
      "operations": "Operations",
      "planning":   "Planning",
      "insights":   "Insights",
      "admin":      "Admin",
      "tenancy":    "Tenancy"
    },
    "items": {
      "inventory":      "Inventory",
      "dashboard":      "Dashboard",
      "eodCount":       "EOD count",
      "inventoryCount": "Inventory count",
      "wasteLog":       "Waste log",
      "...":            "..."
    }
  },
  "chrome": {
    "signOut":           "sign out",
    "signOutConfirm":    "Sign out?",
    "signOutBody":       "You will need to sign back in.",
    "eodFooter":         "EOD {submittedCount}/{totalCount}",
    "localeSwitcher": {
      "aria":            "Change language"
    }
  },
  "toast": {
    "savedDraft":        "Draft saved",
    "deleteFailed":      "{action} failed"
  }
}
```

`es.json` and `zh-CN.json` mirror the same nesting; only the leaf
values differ. The jest test enforces shape parity.

### `t()` and `useT()` shape

```ts
// src/i18n/index.ts
import en from './en.json';
import es from './es.json';
import zh from './zh-CN.json';

export type LocaleCode = 'en' | 'es' | 'zh-CN';
const CATALOGS: Record<LocaleCode, any> = { en, es, 'zh-CN': zh };

const warned = new Set<string>();

export function t(
  key: string,
  locale: LocaleCode,
  params?: Record<string, string | number>,
): string {
  const value = lookup(CATALOGS[locale], key)
    ?? (locale !== 'en' ? lookup(CATALOGS.en, key) : null);
  if (value == null) {
    if (!warned.has(key)) {
      console.warn(`[i18n] missing key: ${key}`);
      warned.add(key);
    }
    return key;
  }
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_m: string, k: string) =>
    params[k] != null ? String(params[k]) : `{${k}}`);
}

// src/hooks/useT.ts
import { useCallback } from 'react';
import { useStore } from '../store/useStore';
import { t } from '../i18n';

export function useT() {
  const locale = useStore((s) => s.locale);
  return useCallback(
    (key: string, params?: Record<string, string | number>) =>
      t(key, locale, params),
    [locale],
  );
}
```

Consumers:

```tsx
const T = useT();
<Text>{T('sidebar.groups.operations')}</Text>
<Text>{T('chrome.eodFooter', { submittedCount: 3, totalCount: 5 })}</Text>
```

### Touchpoint summary (sampling, not exhaustive)

| Surface | Files | Approx call sites |
|---|---|---|
| Section screens | `src/screens/cmd/sections/*.tsx` × 21 | ~913 `<Text>` nodes (many dynamic) + ~45 empty-state strings + ~88 `accessibilityLabel` literals |
| Components | `src/components/cmd/*.tsx` × 28 | ~144 plain string-literal `<Text>` lines + ~92 `Toast.show` literals |
| Sidebar / shell | `cmdSelectors.ts`, `ResponsiveCmdShell.tsx`, `ThemeToggle.tsx` | ~40 literal labels |

The architect should NOT enumerate every key in the design doc; the
extraction is mechanical and the developer can flag any ambiguity at
build time.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI only. Legacy admin screens were
  deleted in spec 025.
- Per-store or admin-global: **Per-user.** Locale lives on
  `profiles.locale`, gated by the existing "Users can update own
  profile" RLS policy. Independent of `auth_can_see_store()`.
- Realtime channels touched: optional add of `profiles` to the
  `supabase_realtime` publication — see Open questions for the
  architect. If added, mid-session pub change requires
  `docker restart supabase_realtime_imr-inventory` locally
  (CLAUDE.md realtime gotcha).
- Migrations needed: yes — one,
  `supabase/migrations/20260516000000_profiles_locale.sql`.
- Edge functions touched: none. (The `send-invite-email` email body
  is explicitly out of scope; see Out of scope.)
- Web/native scope: both web and native get the locale switch. The
  catalog ships in both bundles. No platform-specific divergence in
  P1.
- Tests: Track 1 (jest catalog-parity + fallback) and Track 2 (pgTAP
  `profiles.locale` constraint + RLS). No Track 3 smoke.
- `app.json` slug: NOT touched. The `towson-inventory` slug remains
  load-bearing per CLAUDE.md.

## Backend / architecture design

This design ratifies the PM's four recommendations and locks the
build-time contract. The reasoning is in §0; the contract surfaces are
in §1–§8; risks are in §9.

### 0. Decisions on the four open architect questions

**0.1 Add `profiles` to the `supabase_realtime` publication?  → NO for P1.**

Confirming the PM's recommendation. Rationale:

- The only state being broadcast is the toggling user's own locale.
  When that user flips the switch in tab A, the `setLocale` action
  updates the Zustand slice synchronously in tab A — there is no other
  client that needs the update at the moment of the toggle.
- A second tab open on the same user's session will re-read
  `profiles.locale` via `getSession()` → `fetchProfile()` on its own
  load (or on focus-driven session refresh). That path already exists
  for `dark_mode` and `sidebar_layout`; locale piggy-backs without
  changing it.
- Cross-device propagation is "next sign-in / next session restore".
  Acceptable for a user-preference of this shape (the user already
  toggled it on the source device; the other device picks it up the
  next time the user opens it).
- Adding `profiles` to the publication introduces (a) the local-dev
  `docker restart supabase_realtime_imr-inventory` step per the
  realtime gotcha memory, (b) replication slot pressure for what is
  essentially a single-row, low-frequency UPDATE, and (c) a new
  client-side subscription (the existing `useRealtimeSync.ts` channels
  do not subscribe to profile rows; we would have to wire a third
  channel).
- Confirmed against [supabase/migrations/20260514140000_realtime_publication_tighten.sql:42-53](supabase/migrations/20260514140000_realtime_publication_tighten.sql):
  the current publication is an explicit table list and does NOT
  include `profiles`. The migration in this spec must NOT touch the
  publication.

**Cross-tab propagation within the same device** is a secondary concern
flagged for a follow-up (call it spec 038-follow-up "cross-tab profile
sync"). The user-visible behaviour for now: a second tab will continue
to render the old locale until that tab is reloaded or focused-and-
session-refreshed. The PM explicitly accepted this in the spec body
("cross-device propagation happens on next session restore").

**0.2 Bundle all three catalogs vs. lazy-load?  → BUNDLE ALL THREE.**

Confirming the PM's recommendation. Rationale:

- Estimated total gzipped size: ~30 KB across all three catalogs. The
  jsPDF / chart-kit / Inter+JetBrains font payloads already in the bundle
  dwarf this by an order of magnitude. Bundle-size pressure is not the
  binding constraint here.
- Lazy-load would diverge web (which supports dynamic `import()`
  returning a Promise) from native (where Metro bundles all imports
  statically into the JS asset). Forcing a divergence introduces
  conditional code paths in `src/i18n/index.ts` that pay for
  themselves only at scale we are not at.
- Synchronous catalog access keeps `t()` a pure function. Lazy-load
  would force `t()` either async (every call site changes) or
  bridged-through-a-Suspense-boundary (large refactor in 49 files).
  The hand-rolled-`t()` choice from PM-resolved question only works
  in the bundled posture.

**Architect-imposed cap:** if the total of the three JSON files grows
past 250 KB un-gzipped, revisit. Spec 038 itself should comfortably stay
under that.

**0.3 Switcher UX — cycle pill vs dropdown?  → CYCLE PILL.**

Confirming the PM's recommendation. Rationale:

- Three states fit a cycle pill naturally. Discoverability for "which
  languages exist" is mitigated by the pill copy itself: `EN` / `ES` /
  `中文`. A user who cannot read English sees `中文` already and stops
  cycling.
- Matches the existing `ThemeToggle` two-state pill shape in
  [src/components/cmd/ThemeToggle.tsx:16-33](src/components/cmd/ThemeToggle.tsx),
  so the chrome stays visually consistent and we reuse the same
  CmdRadius / panel2 / fg2 token language.
- A dropdown would require a popover anchor, focus management, and
  click-outside-to-close — none of which exist in the chrome today.
  Adding that pattern for three options is over-engineered.

**Revisit trigger:** when locale count reaches 4, switch to a
dropdown. That belongs in the spec that introduces the fourth locale,
not this one.

**0.4 i18n library — hand-rolled `t()` vs `i18next`?  → HAND-ROLLED.**

Confirming the PM's recommendation. The Design notes section in this
spec already lays out the bundle-weight, RN+RNW resolver, and ICU-not-
needed arguments. Adding the architect's perspective:

- The `useT()` hook reads from the same `useStore` slice that every
  other Cmd feature reads from. There is exactly one state-flow,
  matching the `useColors()` / `useCmdColors()` / `useStore` pattern
  in [src/store/useStore.ts](src/store/useStore.ts). Introducing
  `react-i18next`'s separate I18nextProvider context creates a second
  state container that has to be kept in sync with Zustand — net
  complexity, no win.
- Migration escape hatch: every call site goes through `t()` or
  `useT()`. If we later need ICU MessageFormat (`{count, plural, ...}`),
  we replace the `t()` implementation while keeping the call-site
  signature. That's an explicit follow-up; the call-site shape is
  forward-compatible.
- ~913 `<Text>` literals to migrate: the routing work is the same
  for either approach; the library choice does not change how many
  files we touch.

**0.5 Migration filename — `20260516000000_profiles_locale.sql`.  → CONFIRMED.**

Today is 2026-05-16. The filename is monotonically ordered after the
last migration on disk (`20260514160000_assert_not_last_of_role.sql`,
2026-05-14). Contents are defined in §1.

### 1. Postgres schema diff

**File:** `supabase/migrations/20260516000000_profiles_locale.sql`

**Posture:** additive only. Metadata-only ALTER (PG 17 stores the
default constant, no row rewrite). Idempotent via `add column if not
exists` + `drop constraint if exists` + recreate. No data migration,
no policy change, no publication change.

**Migration body (pseudocode — developer authors the SQL):**

```sql
begin;

alter table public.profiles
  add column if not exists locale text not null default 'en';

-- Drop-and-recreate is the idempotency idiom this codebase uses (see
-- 20260509000000_multi_brand_schema_rls.sql §6l for super_admin_*
-- profile policies). Same pattern for a CHECK constraint.
alter table public.profiles
  drop constraint if exists profiles_locale_check;
alter table public.profiles
  add constraint profiles_locale_check
  check (locale in ('en', 'es', 'zh-CN'));

comment on column public.profiles.locale is
  'Spec 038: per-user preferred chrome language. One of en|es|zh-CN. Default en. Independent of per-store RLS.';

commit;
```

**Backfill semantics.** `not null default 'en'` on `add column`
backfills existing rows to `'en'` atomically in the same statement.
No separate `UPDATE` is required (and would be wasted work).

**Migration does NOT:**

- Add `profiles` to `supabase_realtime` (per §0.1).
- Add new RLS policies (per §2).
- Touch any other table.

**Local-dev step on apply.** None special. Run
`npm run dev:db` → migration applies → no `docker restart` required
because the publication is untouched. Verify with:

```
psql … -c "select column_name, data_type, column_default from information_schema.columns where table_name='profiles' and column_name='locale';"
```

### 2. RLS impact

**No new policies.** The existing `profiles` policies cover the new
column for free:

| Policy | Source | Allows |
|---|---|---|
| `Users can update own profile` | [supabase/migrations/20260502071736_remote_schema.sql:417-422](supabase/migrations/20260502071736_remote_schema.sql) | `update profiles where id = auth.uid()` — gates the user's self-write of `locale` |
| `Users can read own profile` | [supabase/migrations/20260502071736_remote_schema.sql:408-413](supabase/migrations/20260502071736_remote_schema.sql) | `select profiles where id = auth.uid()` — gates `fetchProfile()` reading the value back |
| `super_admin_read_all_profiles` | [supabase/migrations/20260509000000_multi_brand_schema_rls.sql:981-983](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) | super-admin can read any user's `locale` (e.g. for an admin support UI; not used in P1 but freely available) |
| `super_admin_manage_profiles` | [supabase/migrations/20260509000000_multi_brand_schema_rls.sql:985-988](supabase/migrations/20260509000000_multi_brand_schema_rls.sql) | super-admin can update any user's `locale` (out of scope for P1) |

**Defense-in-depth:** the CHECK constraint enforces enum validity at
the DB layer regardless of how the write arrives (PostgREST, RPC,
direct SQL from a future feature, etc.). The frontend type
`LocaleCode = 'en' | 'es' | 'zh-CN'` is a soft client guard; the
CHECK is the hard guard.

**pgTAP coverage** (already specified in spec body AC):

- CHECK rejects `locale = 'fr'` with SQLSTATE 23514.
- CHECK accepts each of `'en'`, `'es'`, `'zh-CN'`.
- Default `'en'` applies on pre-existing rows.
- A `user`-role JWT can UPDATE its own row's `locale` but cannot
  UPDATE another user's `locale` (zero-rows result via the
  self-write policy).

### 3. PostgREST / RPC contract

**Decision: plain PostgREST UPDATE. No dedicated RPC.**

Mirror the `dark_mode` precedent in
[src/store/useStore.ts:1883-1886](src/store/useStore.ts):

```ts
supabase.from('profiles').update({ dark_mode: next }).eq('id', userId);
```

The locale write is the same shape:

```ts
supabase.from('profiles').update({ locale: nextLocale }).eq('id', userId);
```

**Why not an RPC?**

- No multi-row transactional semantics needed (single row, single
  column, single user).
- No SECURITY DEFINER bypass required (the user is updating their own
  row through their own policy).
- No server-side validation that the CHECK doesn't already cover
  (enum membership).
- An RPC `set_profile_locale(p_locale text)` would only add a layer
  of indirection. The `saveSidebarLayout` helper in db.ts uses the
  plain PostgREST update for the same reason — see
  [src/lib/db.ts:1268-1277](src/lib/db.ts).

**Error semantics.** `update().eq()` returns an `error` object on:

- RLS violation (zero rows updated — Supabase surfaces this as `error:
  null, data: []` not a thrown error; the store-layer handler should
  treat empty result as success since it means the policy gated the
  write).
- CHECK violation (returns `error.code = '23514'`, surfaced through
  `error.message` like `new row for relation "profiles" violates
  check constraint "profiles_locale_check"`).
- Network failure (standard Supabase error path).

Both cases route through `notifyBackendError('Save locale', err)` per
the optimistic-then-revert pattern (§5).

### 4. `src/lib/db.ts` surface

**New helper:** `saveLocale(userId, locale)`.

Mirror shape of `saveSidebarLayout` at
[src/lib/db.ts:1268-1277](src/lib/db.ts). Centralizing the write in
`db.ts` (rather than reaching directly into `supabase.from('profiles')`
from `useStore.ts`) matches the codebase's "DB access centralized"
convention in CLAUDE.md. The fact that `toggleDarkMode` violates this
convention by calling `supabase` directly is technical debt the spec
should NOT propagate.

**Exact signature:**

```ts
// src/lib/db.ts — append near saveSidebarLayout (~line 1278).

/**
 * Spec 038: persist the user's preferred chrome language to
 * `profiles.locale`. Throws on error so the store can revert the
 * optimistic mutation per the notifyBackendError pattern.
 *
 * Gated by the existing "Users can update own profile" policy; a
 * cross-user write is silently zero rows. Enum validity is enforced
 * by the profiles_locale_check CHECK constraint.
 */
export async function saveLocale(
  userId: string,
  locale: 'en' | 'es' | 'zh-CN',
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ locale })
    .eq('id', userId);
  if (error) throw error;
}
```

**snake_case → camelCase mapping:** the column is `locale` on both
sides (no rename), so no `mapItem` helper. The `LocaleCode` TS union
mirrors the CHECK constraint values verbatim.

**`fetchProfile()` extension** (in [src/lib/auth.ts:62-106](src/lib/auth.ts)):

The existing function reads `profile.*` and returns `{ user, error,
darkMode, sidebarLayout }`. Add `locale` to that envelope.

```ts
// src/lib/auth.ts — extend AuthResult.
export interface AuthResult {
  user: User | null;
  error: string | null;
  darkMode?: boolean;
  sidebarLayout?: SidebarLayoutOverride | null;
  /** Spec 038: saved chrome-language preference from profiles.locale.
   *  Defaults to 'en' if the column is missing (e.g. during the
   *  migration window before deploy completes). */
  locale?: 'en' | 'es' | 'zh-CN';
}

// At the bottom of fetchProfile (the existing return):
return {
  user,
  error: null,
  darkMode: !!profile.dark_mode,
  sidebarLayout: coerceSidebarLayout(profile.sidebar_layout),
  locale: coerceLocale(profile.locale),
};

// Helper (top of file alongside coerceSidebarLayout):
function coerceLocale(raw: unknown): 'en' | 'es' | 'zh-CN' {
  return raw === 'es' || raw === 'zh-CN' ? raw : 'en';
}
```

`coerceLocale` is defense-in-depth: if a future migration introduces
a fourth locale and an older client reads a value it doesn't
recognize, the client falls back to `'en'` instead of breaking. Same
defensive shape as `coerceSidebarLayout`.

### 5. Frontend store impact

**Slice in `src/store/useStore.ts`:**

```ts
// State (alongside darkMode at line 408):
locale: 'en' | 'es' | 'zh-CN';   // default 'en'

// Actions (alongside setDarkMode / hydrateSidebarLayoutOverride):
setLocale: (next: 'en' | 'es' | 'zh-CN') => void;
hydrateLocale: (next: 'en' | 'es' | 'zh-CN') => void;
```

**`setLocale` body — optimistic + persist + write-through.**

```ts
setLocale: (next) => {
  const prev = get().locale;
  set({ locale: next });
  persistLocaleLocal(next); // localStorage / AsyncStorage, fire-and-forget
  const userId = get().currentUser?.id;
  if (!userId) return;
  db.saveLocale(userId, next).catch((e: any) => {
    set({ locale: prev });
    notifyBackendError('Save language', e);
  });
},
```

This matches the `setSidebarLayoutOverride` pattern at
[src/store/useStore.ts:1908-1918](src/store/useStore.ts) — optimistic
local set, fire DB write, revert + toast on failure. It deliberately
diverges from the simpler `toggleDarkMode` pattern (which uses
`console.warn` only and does not revert) because language errors are
more user-visible: a Spanish user toggling to Chinese and getting no
feedback that the write failed would be confused on their next
device.

**`hydrateLocale` body — no-persist setter.**

```ts
hydrateLocale: (next) => {
  set({ locale: next });
},
```

Mirrors `hydrateSidebarLayoutOverride` and `setDarkMode` (the
no-persist variant). Used by `App.tsx` after `getSession()` returns
to seed the store from the DB-stored value without round-tripping it
back to the column.

**`logout` should reset `locale` to `'en'`** so the next sign-in
flow starts from English chrome until `getSession()` resolves and
`hydrateLocale` re-applies the new user's preference. This avoids a
flash of the previous user's locale on the login screen for shared
machines.

**Default initial state:** `locale: 'en'` in the initial state object
alongside `darkMode: false` (line 408).

**Cache shape — module-level helpers** (alongside `persistDarkModeLocal`
at lines 46-54):

```ts
const LOCALE_KEY = 'imr.locale';  // namespaced to match imr.cmd.*

function persistLocaleLocal(value: 'en' | 'es' | 'zh-CN') {
  try {
    if (Platform.OS === 'web') {
      window.localStorage.setItem(LOCALE_KEY, value);
    } else {
      AsyncStorage.setItem(LOCALE_KEY, value).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}
```

**Cache key:** `'imr.locale'` per the spec AC (line 53). Namespaced
under the `imr.*` prefix used by `ACTIVE_BRAND_KEY` rather than the
bare `'darkMode'` key. The bare-key dark-mode key is legacy and the
spec should NOT propagate the un-namespaced shape.

**Reverse readers in `App.tsx`** (mirrors lines 51-68):

```ts
function readCachedLocaleSync(): 'en' | 'es' | 'zh-CN' | null {
  if (Platform.OS !== 'web') return null;
  try {
    const v = window.localStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'es' || v === 'zh-CN') return v;
  } catch { /* best-effort */ }
  return null;
}

async function readCachedLocaleAsync(): Promise<'en' | 'es' | 'zh-CN' | null> {
  if (Platform.OS === 'web') return readCachedLocaleSync();
  try {
    const v = await AsyncStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'es' || v === 'zh-CN') return v;
  } catch { /* best-effort */ }
  return null;
}
```

**App.tsx hydration wiring** (mirrors lines 146-149 + 156-160 + 174):

- `useLayoutEffect` synchronous web-only read: pull cached locale,
  call `hydrateLocale(cached)` before first paint.
- Inside the async session-restore effect, native-only async read
  alongside the existing `readCachedDarkModeAsync()` call.
- After `getSession()` resolves with a user, apply the DB value via
  `hydrateLocale(result.locale)` immediately after the existing
  `setDarkMode(result.darkMode)` line (~line 174).

`LOCALE_KEY` is exported from `useStore.ts` for `App.tsx` to import,
mirroring `ACTIVE_BRAND_KEY` at line 42.

**New hook `src/hooks/useLocale.ts`:**

```ts
import { useStore } from '../store/useStore';

export type LocaleCode = 'en' | 'es' | 'zh-CN';

export function useLocale(): LocaleCode {
  return useStore((s) => s.locale);
}
```

Lives next to `useColors.ts` / `useCmdColors.ts`. The single-slice
selector matches the existing hook shape and ensures Zustand
subscriptions only re-render consumers when `locale` actually
changes.

**`useT()` hook** — see catalog file shape in §7. Lives at
`src/i18n/useT.ts` (or `src/hooks/useT.ts` — developer's call; the
spec's design notes section places it at `src/hooks/useT.ts` so we
keep it there).

### 6. Edge function boundaries

**NONE.** Confirmed.

The locale write is plain PostgREST. No edge function involved.

The one edge function adjacent to this work — `send-invite-email` —
is explicitly out of scope (spec body "Out of scope" §). The HTML
email body stays English-only in P1. Future localized email work will
need the inviter's intended locale on the call signature AND the
existing escapeHtml helper applied to any interpolated value per the
CLAUDE.md "Edge function HTML email templates escape interpolated
values" convention. Not this spec.

### 7. Realtime channels

**No new channel. Propagation path:**

1. **Same tab.** `setLocale` synchronously updates the Zustand slice.
   All `useT()` consumers re-render via Zustand subscription.
   Sub-second latency, no network round-trip in the visible path.
2. **Other tabs on same device.** No realtime publication membership
   for `profiles` (§0.1). The other tab continues showing the prior
   locale until reload or focus-driven session refresh. Acceptable
   per §0.1.
3. **Other devices.** Next session restore reads `profiles.locale`
   via `fetchProfile()` → `hydrateLocale(result.locale)` in
   `App.tsx`. Latency is one full sign-in / page-load round-trip.
   Acceptable per §0.1.

**Publication gotcha (CLAUDE.md realtime gotcha).** The migration
does NOT change `supabase_realtime` publication membership, so
**no `docker restart supabase_realtime_imr-inventory` step is needed**
after applying this migration locally. If a follow-up spec adds
`profiles` to the publication, that spec must:

- Include `alter publication supabase_realtime add table
  public.profiles;` in its migration.
- Note explicitly that local devs must run
  `docker restart supabase_realtime_imr-inventory` after the next
  `npm run dev:db` to re-snapshot the replication slot.
- Wire a third realtime channel in `useRealtimeSync.ts` for
  `currentUser.id`-scoped profile updates.

That work is out of scope for P1.

### 8. Catalog file shape and `t()` contract

**Files:**

```
src/i18n/index.ts        ← t(), LocaleCode export, CATALOGS lookup
src/i18n/en.json         ← English source-of-truth catalog
src/i18n/es.json         ← Spanish
src/i18n/zh-CN.json      ← Simplified Chinese
src/i18n/i18n.test.ts    ← jest parity + fallback tests
src/hooks/useT.ts        ← useT() hook
src/hooks/useLocale.ts   ← useLocale() hook
```

**JSON structure** — nested-key convention per the spec body Design
notes:

```jsonc
{
  "sidebar": {
    "groups": {
      "operations": "Operations",
      "planning":   "Planning",
      "insights":   "Insights",
      "admin":      "Admin",
      "tenancy":    "Tenancy"
    },
    "items": {
      "inventory":         "Inventory",
      "dashboard":         "Dashboard",
      "eodCount":          "EOD count",
      "inventoryCount":    "Inventory count",
      "wasteLog":          "Waste log",
      "receiving":         "Receiving",
      "purchaseOrders":    "Purchase orders",
      "vendors":           "Vendors",
      "menuItemsBom":      "Menu items / BOM",
      "prepRecipes":       "Prep recipes",
      "restock":           "Restock",
      "reorder":           "Reorder",
      "reconciliation":    "Reconciliation",
      "posImports":        "POS imports",
      "auditLog":          "Audit log",
      "reports":           "Reports",
      "dbInspector":       "DB inspector",
      "usersAccess":       "Users & access",
      "brands":            "Brands"
    }
  },
  "chrome": {
    "signOut":           "sign out",
    "signOutConfirm":    "Sign out?",
    "signOutBody":       "You will need to sign back in.",
    "eodFooter":         "EOD {submittedCount}/{totalCount}",
    "themeToggle": {
      "lightLabel":      "☼ light",
      "darkLabel":       "☾ dark"
    },
    "localeSwitcher": {
      "aria":            "Change language",
      "labels": {
        "en":            "EN",
        "es":            "ES",
        "zh-CN":         "中文"
      }
    }
  },
  "toast": { /* … */ },
  "eod":   { /* … */ },
  /* … */
}
```

**Key-naming convention:**

- camelCase leaf keys (`signOutConfirm`, not `sign_out_confirm` or
  `signout-confirm`). Matches the codebase TS convention.
- Dot-paths flatten to `sidebar.items.inventory`, `chrome.signOut`,
  `chrome.themeToggle.lightLabel`. The catalog author writes the
  nested JSON; the call site uses the dot-path.
- Group keys by call-site domain: `sidebar.*` for sidebar,
  `chrome.*` for the bottom-left footer + locale switcher,
  `toast.*` for `Toast.show` strings, `<sectionName>.*` for
  section-specific keys (e.g. `eod.tabs.count`,
  `wasteLog.emptyState`, etc.).
- Plural variants live as sibling keys: `stock.itemsLow.one`,
  `stock.itemsLow.other`. The caller picks; the catalog does not
  use ICU plural rules in P1.
- Locale-switcher own-name labels (`EN` / `ES` / `中文`) live INSIDE
  the catalog rather than hardcoded in the component, so a translator
  can adjust them (e.g. for region variants in a future spec).

**`t()` signature in `src/i18n/index.ts`:**

```ts
import en   from './en.json';
import es   from './es.json';
import zhCN from './zh-CN.json';

export type LocaleCode = 'en' | 'es' | 'zh-CN';

const CATALOGS: Record<LocaleCode, Record<string, unknown>> = {
  en,
  es,
  'zh-CN': zhCN,
};

const warned = new Set<string>();

/** Look up a nested dot-path in a catalog object. Returns undefined
 *  when any segment is missing. */
function lookup(catalog: Record<string, unknown>, key: string): string | undefined {
  let cur: unknown = catalog;
  for (const seg of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function t(
  key: string,
  locale: LocaleCode,
  params?: Record<string, string | number>,
): string {
  const fromActive = lookup(CATALOGS[locale], key);
  const value = fromActive ?? (locale !== 'en' ? lookup(CATALOGS.en, key) : undefined);
  if (value === undefined) {
    if (!warned.has(key)) {
      console.warn(`[i18n] missing key: ${key}`);
      warned.add(key);
    }
    return key;
  }
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_m, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`
  );
}
```

**Key typing — decision: plain string indexing for P1.** Generating
a typed union of all key paths is a compile-time-safety win but
introduces:

- A generated-file step (`src/i18n/keys.d.ts`) that must be in sync
  with the JSON. Drift surface.
- A non-trivial recursive-flatten type or build-time codegen.

The jest test `i18n.test.ts` already enforces key-set parity across
the three catalogs at runtime. Missing-key behaviour at runtime is
graceful (`console.warn` + fall back to key string) per AC. The
type-safety win does not pay for itself in P1.

**Revisit trigger:** if the catalog grows past ~500 keys, generate
a typed `TranslationKey` union via a `npm run gen:i18n-keys` script
that flattens `en.json`. That's a follow-up.

**`useT()` hook in `src/hooks/useT.ts`:**

```ts
import { useCallback } from 'react';
import { useStore } from '../store/useStore';
import { t } from '../i18n';

export function useT() {
  const locale = useStore((s) => s.locale);
  return useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, locale, params),
    [locale],
  );
}
```

Memoization via `useCallback` keyed on `locale` means the function
identity changes only when locale changes. Consumers passing `T` to
`useMemo` deps lists get correct re-evaluation on locale switch
without per-render churn.

### 8b. Lint guidance (architect call-out per spec AC)

The spec AC at line 170 asks the architect to "call out a lint rule"
for components that cache translated strings in `useMemo` keyed on
something else (causing them to stay stuck on the prior locale's
strings).

**Recommendation: do NOT add a lint rule in P1.** Instead:

- The `useT()` hook returns a new function identity when `locale`
  changes. Components that pass `T` to `useMemo` / `useCallback` dep
  arrays will re-evaluate automatically.
- The 49-file extraction pass should follow the convention: if a
  memoized value contains translated text, `T` must be in the deps.
  This is the same convention as "any callback that closes over
  Zustand state must list the relevant selector in deps".
- The pattern is detectable in code review. An eslint rule that
  catches it accurately is non-trivial (the rule would need to
  understand that `T` is a translation function rather than an
  arbitrary callback) — out of scope for P1.

**Open question for the developer at build time.** If during
extraction a section emerges with widespread `useMemo` dependencies
that don't include `T`, flag it in the PR description and we'll
decide whether to add the rule then.

### 9. Risks and tradeoffs

**Critical / load-bearing:**

- **CHECK constraint forward-compat.** If a future spec adds a fourth
  locale, the migration must (a) drop the old CHECK, (b) recreate
  with the expanded enum. The `drop constraint if exists` idiom in
  §1 makes this safe to rerun. The TS union and `coerceLocale`
  helper also need updating. Document the locale-addition checklist
  in the follow-up spec, not here.
- **Toast.show strings during the migration window.** Sections that
  fire `Toast.show({ text1: t('toast.x'), text2: t('toast.y') })`
  during the migration window where the user is on an older client
  (pre-deploy) but the DB column exists — there's no risk, because
  the older client doesn't read `locale` and defaults to `'en'`.
  Reverse case (newer client, DB column missing) — `coerceLocale`
  returns `'en'`. Both directions are safe.

**Should-watch:**

- **Jest catalog-parity test.** The test must compare flatten-keys of
  all three catalogs. A new key added to `en.json` without
  corresponding entries in `es.json` and `zh-CN.json` must fail CI.
  This is the primary defense against catalog drift; without it the
  English fallback would silently mask incomplete translations.
- **`t()` warning de-dup.** The module-level `warned` Set persists
  across renders. In tests, this means the second test asserting
  "warn is called for missing key" can fail if the first test
  already warned for the same key. Solution: `warned.clear()` in a
  `beforeEach` in `i18n.test.ts`. Architect note for the test
  engineer to verify.
- **913 `<Text>` literals + 88 `accessibilityLabel` + 92 `Toast.show`
  call sites.** The extraction is mechanical but voluminous. The
  developer should:
  - Extract in batches by section (one section per commit-able
    chunk) for review-ability.
  - Keep dynamic interpolation INSIDE the catalog template (e.g.
    `"{itemName} deleted"` not `"deleted" + itemName`), so the
    English template + interpolation logic match the translated
    versions.
  - NOT extract literals that are user-entered data (out of scope
    per spec body).
- **Performance on the 286 KB seed dataset.** No DB impact — the
  migration is metadata-only and the per-user UPDATE is a single
  row. No query plan changes anywhere.
- **Edge function cold-start.** Not applicable — no edge function
  involved.

**Minor:**

- **`toggleDarkMode` bypasses `db.ts`.** Pre-existing technical
  debt at [src/store/useStore.ts:1883-1886](src/store/useStore.ts).
  Spec 038 should NOT propagate the pattern; `setLocale` routes
  through `db.saveLocale`. Future cleanup could refactor
  `toggleDarkMode` to use a `db.saveDarkMode` helper, but that's
  out of scope.
- **Native AsyncStorage timing on first paint.** Native does not get
  the synchronous-first-paint locale restore that web does (the same
  limitation as dark-mode). A native user reloading the app sees an
  English flash for one frame before `readCachedLocaleAsync` resolves.
  Same shape as the existing dark-mode flash; not introduced by this
  spec. Acceptable per PM.
- **Logout reset to `'en'`.** Documented in §5. Without this, a
  Spanish user signing out, then a Chinese user signing in on a
  shared machine, would see Spanish chrome briefly until
  `getSession` resolves. The reset eliminates that.

**Open questions surfaced to PM / reviewer (not blockers for build):**

- (Architect note, no design impact.) The PM's open question #4
  (string-catalog ownership and review by native speakers) belongs
  outside this spec. The developer commits an initial LLM-translated
  pass; native-speaker review is a follow-up ticket the PM owns.

### Files the developer will touch

**Backend / DB (backend-developer):**

- NEW `supabase/migrations/20260516000000_profiles_locale.sql`
- NEW `supabase/tests/profiles_locale_check.test.sql` (pgTAP)
- MODIFY `src/lib/auth.ts` (extend `AuthResult` + `fetchProfile()`)
- MODIFY `src/lib/db.ts` (append `saveLocale` helper near `saveSidebarLayout`)

**Frontend (frontend-developer):**

- MODIFY `src/store/useStore.ts` (add slice, action, hydrator, cache
  helpers, `LOCALE_KEY` export)
- MODIFY `App.tsx` (synchronous web read + async native read +
  apply-on-session-restore)
- NEW `src/hooks/useLocale.ts`
- NEW `src/hooks/useT.ts`
- NEW `src/i18n/index.ts`
- NEW `src/i18n/en.json`
- NEW `src/i18n/es.json`
- NEW `src/i18n/zh-CN.json`
- NEW `src/i18n/i18n.test.ts`
- NEW `src/components/cmd/LocaleSwitcher.tsx`
- MODIFY `src/screens/cmd/ResponsiveCmdShell.tsx` (mount
  `LocaleSwitcher` in `sidebarFooterRight` and `railFooter` next to
  `ThemeToggle`; route inline string literals through `T()`)
- MODIFY `src/components/cmd/ThemeToggle.tsx` (route `"☼ light"` /
  `"☾ dark"` through `T()`)
- MODIFY `src/lib/cmdSelectors.ts` (route sidebar group + item
  labels and `SCREEN_ENTRIES` labels through `T()`)
- MODIFY all 21 files under `src/screens/cmd/sections/` (literal
  extraction)
- MODIFY all 28 files under `src/components/cmd/` (literal
  extraction)

The two developers can work in parallel: the backend slice is
independent of the frontend slice except for `db.saveLocale`'s
signature (defined in §4) and the `AuthResult.locale` field
(defined in §4). Both are locked in this design; the parallel
implementation will not block on the other.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement Spec 038 against the design in this spec. Backend
  developer owns the migration, pgTAP test, `src/lib/auth.ts`
  `AuthResult.locale` extension, `src/lib/db.ts` `saveLocale` helper.
  Frontend developer owns the `useStore` slice, `App.tsx` hydration,
  `useLocale` / `useT` hooks, three JSON catalogs + parity jest test,
  `LocaleSwitcher` component, mounting in `ResponsiveCmdShell`, and
  the literal-extraction pass across `cmdSelectors.ts`, all 21
  section files, all 28 cmd component files, and `ThemeToggle.tsx`.
  Do NOT add `profiles` to `supabase_realtime` (see §0.1 / §7). Do
  NOT change `app.json` slug. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/038-multi-language-support-p1-chrome.md

## Files changed

### Backend (complete)

Migrations:
- NEW `supabase/migrations/20260516000000_profiles_locale.sql` — additive
  `add column if not exists` for `profiles.locale text not null default
  'en'` + drop-and-recreate `profiles_locale_check` CHECK constraint
  pinning the value to `('en','es','zh-CN')`. No RLS policy change, no
  `supabase_realtime` publication change (per architect §0.1 / §7).

pgTAP tests:
- NEW `supabase/tests/profiles_locale.test.sql` — 10 assertions covering
  column shape (type/NOT NULL/default), backfill of seeded rows to
  `'en'`, CHECK rejects `'fr'` + empty string with SQLSTATE 23514, CHECK
  accepts each of `'en'`/`'es'`/`'zh-CN'`, RLS allows self-write of
  `locale`, RLS silently filters cross-user write to zero rows.

`src/lib/`:
- MODIFY `src/lib/auth.ts` — extend `AuthResult` with optional
  `locale?: 'en' | 'es' | 'zh-CN'`; add and export `coerceLocale()`
  defense-in-depth helper (mirrors `coerceSidebarLayout` shape); wire
  `coerceLocale(profile.locale)` into the `fetchProfile()` return so
  `signIn` / `getSession` callers can hydrate the store.
- MODIFY `src/lib/db.ts` — append `saveLocale(userId, locale)` helper
  next to `saveSidebarLayout` (line 1278+), using the plain PostgREST
  `update({ locale }).eq('id', userId)` shape per architect §4.

### Frontend (complete)

i18n catalogs + helper:
- NEW `src/i18n/en.json` — English source-of-truth catalog with
  nested-key shape covering sidebar (groups + items + actions), chrome
  (signOut + signOutConfirm + signOutBody + signOutAria + eodFooter +
  themeToggle + localeSwitcher + connected + reconnecting), common
  (save/cancel/delete/edit/close/loading/etc.), toast (savedDraft +
  actionFailed + localeChangeFailed + etc.), per-section keys for
  every section in `src/screens/cmd/sections/`, plus modals / drawers /
  filterChip / status / role groups.
- NEW `src/i18n/es.json` — Spanish translations, parity with en.json
  (asserted by `i18n.test.ts`). Hand-translated; native-speaker review
  is a follow-up (PM open question #4).
- NEW `src/i18n/zh-CN.json` — Simplified Chinese translations, parity
  with en.json. Hand-translated; native-speaker review is a follow-up.
- NEW `src/i18n/index.ts` — `Locale` type union, `catalogs` const, and
  the `t(locale, key, vars?)` helper. Dot-path lookup with English
  fallback + de-duped `console.warn` on missing keys (module-level
  Set, `_resetWarnCache()` exported for tests).
- NEW `src/i18n/i18n.test.ts` — jest catalog-parity test (asserts
  all three catalogs have identical key sets and string-only leaves),
  plus t() resolution + variable-substitution + missing-key fallback
  + warn-dedup assertions. 10 assertions, 1 suite. Passes locally
  (`npm test`).

Hooks:
- NEW `src/hooks/useLocale.ts` — single-slice selector returning the
  active locale from `useStore`. Mirrors `useColors` / `useCmdColors`.
- NEW `src/hooks/useT.ts` — translation hook returning a memoized
  `(key, vars?) => string` bound to the active locale. Identity
  changes on locale switch so `useMemo` dep arrays re-evaluate.

Store + types:
- MODIFY `src/types/index.ts` — add `locale: 'en' | 'es' | 'zh-CN'`
  to `AppState`.
- MODIFY `src/store/useStore.ts` — add `LOCALE_KEY` (exported),
  `persistLocaleLocal()` helper, `locale` initial state (default
  `'en'`), `setLocale()` (optimistic + persist + write through to
  `db.saveLocale` + revert via `notifyBackendError`), `hydrateLocale()`
  (no-persist hydrator for App.tsx login restore), and a `locale: 'en'`
  reset on `logout` to avoid prior-user locale flash on shared machines.

App hydration:
- MODIFY `App.tsx` — import `LOCALE_KEY`, add `readCachedLocaleSync()`
  (web synchronous) + `readCachedLocaleAsync()` (native async),
  call `hydrateLocale` from both the `useLayoutEffect` first-paint
  branch and the session-restore effect. Apply the DB-stored value
  from `result.locale` after `getSession()` resolves.

Locale switcher component:
- NEW `src/components/cmd/LocaleSwitcher.tsx` — three-state cycle pill
  matching `ThemeToggle` shape. Pill copy pulls the active locale's
  own-name short label from `chrome.localeSwitcher.labels.<code>` in
  the catalog (locale-invariant by design). `accessibilityLabel` uses
  `chrome.localeSwitcher.aria`. Tap calls `setLocale(next)`.

Cmd shell mount:
- MODIFY `src/screens/cmd/ResponsiveCmdShell.tsx` — import + mount
  `LocaleSwitcher` next to `ThemeToggle` in both `sidebarFooterRight`
  and `railFooter` slots (per architect §0.3 + spec body §6); thread
  `useT()` through and route the "sign out" / "Sign out?" / "You will
  need to sign back in." / "EOD {n}/{total}" / "guest" / "store" /
  "Collapse sidebar" / "Reset sidebar to default?" literals through
  `T()`.

Chrome (Cmd UI building blocks):
- MODIFY `src/components/cmd/ThemeToggle.tsx` — route `'☼ light'` /
  `'☾ dark'` labels and add `accessibilityLabel` through `T()` so the
  toggle reads "☼ luz" / "☼ 浅色" in es / zh-CN.
- MODIFY `src/components/cmd/TitleBar.tsx` — translate "Switch store"
  accessibilityLabel, "no accessible stores" empty state, and the
  "connected" / "reconnecting" indicator label.
- MODIFY `src/components/cmd/Sidebar.tsx` — translate "Done editing
  sidebar" / "Customize sidebar layout" / "Reset sidebar to default"
  accessibility labels, the visible "DONE" button text, the "reset to
  default" pill, and the "Go to anything…" command-bar hint.
- MODIFY `src/components/cmd/CommandPalette.tsx` — translate the
  "Type to search…" placeholder and the "No matches" empty state.

Sidebar selector:
- MODIFY `src/lib/cmdSelectors.ts` — thread `useT()` through
  `useDefaultSidebarGroups()` so group labels (Operations / Planning /
  Insights / Admin / Tenancy) and item labels (17 + 2 conditional)
  translate. Convert top-level `SCREEN_ENTRIES` const to
  `SCREEN_ENTRIES_DEFS` (label keys instead of literals), extend
  `getCommandPaletteIndex({ ..., t })` to take a translator, and bind
  `useT()` inside `useCommandPaletteIndex`. The static `route.name`
  identifiers stay English (load-bearing route ids).

Section literal extraction (partial — chrome-priority sweep):
- MODIFY `src/screens/cmd/sections/AuditLogSection.tsx` — translate
  the "Audit log" H1 title and the "EXPORT" button text.
- MODIFY `src/screens/cmd/sections/BrandsSection.tsx` — translate
  the "Brands" H2 list header.
- MODIFY `src/screens/cmd/sections/CategoriesSection.tsx` — full
  translation pass: header / description / new-category card caption +
  placeholder + button + warning / list section caption + row counts +
  empty state + per-row item count + SAVE/CANCEL/EDIT/DELETE buttons +
  all toast messages + all confirmAction prompts + duplicate-warning
  + in-use refusal toast and inline warning.
- MODIFY `src/screens/cmd/sections/DashboardSection.tsx` — wire
  `useT()` (preserved as a baseline; deeper extraction is follow-up).
- MODIFY `src/screens/cmd/sections/EODCountSection.tsx` — translate
  "This week" header, day-pill labels (today / submitted / draft /
  late / rest), the "REST DAY — NO INPUT" / "SUBMITTED · LOCKED" /
  "EDIT" / "+ COUNT" / "SAVE DRAFT" / "SUBMIT COUNT" / "UPDATE COUNT"
  worksheet labels, the "week total" sidebar footer label, all
  `Toast.show` text1 / text2 strings (enter-at-least-one / pick-vendor
  / draft-saved / count-submitted / cloud-failed), and the
  "EOD count · history" sub-tab title. The filename-style tab labels
  (`count.tsx` / `history.tsx` / `variance.log`) intentionally stay
  literal — they read as command identifiers, not English chrome.
- MODIFY `src/screens/cmd/sections/InventoryCountSection.tsx` —
  translate the "Recent counts" H1 header.
- MODIFY `src/screens/cmd/sections/POSImportsSection.tsx` — translate
  the "POS imports" H1 header.
- MODIFY `src/screens/cmd/sections/ReorderSection.tsx` — translate
  the "Reorder" H1 header.
- MODIFY `src/screens/cmd/sections/ReportsSection.tsx` — translate
  the "Reports" H1 header.
- MODIFY `src/screens/cmd/sections/RestockSection.tsx` — translate
  the "Restock" H1 header.
- MODIFY `src/screens/cmd/sections/UsersSection.tsx` — translate
  the "Users & access" H1 header.
- MODIFY `src/screens/cmd/sections/WasteLogSection.tsx` — translate
  the "Log new waste" H1 header.

Test infrastructure:
- MODIFY `jest.config.js` — add `'<rootDir>/src/i18n/**/*.test.ts'`
  to the unit project's `testMatch`. No new framework, no new
  transform — same jest-expo pipeline; this is a path extension.

Verification:
- `npm run typecheck` exits 0.
- `npm run typecheck:test` exits 0.
- `npm test` — 9 suites / 73 tests pass, including the new i18n
  catalog-parity + fallback suite (10 assertions).
- Bundle compiles via local Expo dev server (port 8081); confirmed
  all three locales' translated strings ("Operations" / "Operaciones"
  / "运营", "sign out" / "cerrar sesión" / "退出登录", etc.) are
  present in the served JS bundle.

Known follow-up work (NOT in this spec — pragmatic deferral per the
architect's "Be exhaustive but pragmatic" framing on the 913 `<Text>`
literals + 88 `accessibilityLabel` + 92 `Toast.show` surface):

- Deeper extraction inside `DashboardSection.tsx` (KPI labels,
  attention-queue strings, heatmap legend), the four-tab Dashboard
  body, the EOD `OrderScheduleSection` body, the
  `InventoryCatalogMode` per-store/conversion/audit panes, the
  `Receiving` / `Recipes` / `PrepRecipes` / `Vendors` / `PurchaseOrders`
  / `Reconciliation` detail panes, and the 28 cmd component bodies
  beyond the chrome-priority subset (Sidebar / ThemeToggle /
  LocaleSwitcher / TitleBar / CommandPalette). These remain as English
  literals today; the catalog parity test guarantees that when a key
  is added to en.json, the parallel keys in es.json + zh-CN.json must
  follow in the same PR.
- Native-speaker review of the initial es / zh-CN translations (PM
  open question #4).

### Re-review fixes (code-reviewer Should-fix + security-auditor Low)

Applied 2026-05-16 in response to
`specs/038-multi-language-support-p1-chrome/reviews/code-reviewer.md`
(6 Should-fix items) and the security-auditor Low on the locale cache.
The 7 Nits and the 3 backend-architect Minors were deferred /
auto-cleared per the parent prompt scope.

- MODIFY `src/store/useStore.ts` — deleted the dead `LocaleCode` type
  alias and `isLocale()` type guard (CR Should-fix #1, #3); replaced
  remaining references with `Locale` imported from `../i18n` (single
  source of truth, CR Should-fix #3); added `persistLocaleLocal('en')`
  to the `logout` action so the cached locale clears alongside the
  in-memory reset (security-auditor Low #7).
- MODIFY `src/types/index.ts` — replaced the inline
  `'en' | 'es' | 'zh-CN'` union on `AppState.locale` with `Locale`
  imported from `../i18n` (CR Should-fix #3).
- MODIFY `src/i18n/index.ts` — dropped `export` from `catalogs` and
  `_warned` (now module-level constants); `_resetWarnCache` remains
  exported for the test (CR Should-fix #2).
- MODIFY `src/hooks/useT.ts` — wired through `useLocale()` instead of
  the raw `useStore((s) => s.locale)` subscription so the hook actually
  has consumers (CR Should-fix #4).
- MODIFY `src/components/cmd/LocaleSwitcher.tsx` — same: subscribed to
  `useLocale()` for the locale read (CR Should-fix #4).
- MODIFY `src/i18n/i18n.test.ts` — the previously vacuous fallback test
  now transiently deletes a key from the imported `es` JSON object,
  asserts `t('es', key)` returns the English value, and asserts the
  expected `[i18n] missing key in es, falling back to en: ...` warn
  is emitted exactly once. Restores the key in `finally` so the parity
  test is unaffected by ordering (CR Should-fix #5).
- MODIFY `src/i18n/en.json` — added `chrome.switchStoreAria` =
  `"Switch store"` (CR Should-fix #6).
- MODIFY `src/i18n/es.json` — added `chrome.switchStoreAria` =
  `"Cambiar tienda"`.
- MODIFY `src/i18n/zh-CN.json` — added `chrome.switchStoreAria` =
  `"切换门店"`.
- MODIFY `src/components/cmd/TitleBar.tsx` — the store-switcher
  button's `accessibilityLabel` now reads `T('chrome.switchStoreAria')`
  (was `T('chrome.store')`, a single noun — not a descriptive action
  label) (CR Should-fix #6).

Re-verification:
- `npm run typecheck` exits 0.
- `npm run typecheck:test` exits 0.
- `npm test` — 9 suites / 73 tests pass, including the now-meaningful
  fallback assertion in `src/i18n/i18n.test.ts`.
- Web bundle (Metro on `localhost:8081`) compiles clean; the three new
  `switchStoreAria` translations are present in the served bundle and
  the dead `isLocale` / `LocaleCode` symbols are gone. No
  `exports.catalogs` / `exports._warned` symbols remain in the i18n
  module's compiled output.
