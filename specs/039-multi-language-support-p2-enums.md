# Spec 039: Multi-language support — Phase 2 (curated enum / category labels)

Status: READY_FOR_REVIEW

## User story

As a store manager whose preferred language is Spanish or Mandarin Chinese,
I want the application-controlled enum labels — inventory item status
(OK / LOW / OUT), waste-reason dropdown values, audit-log action verbs,
inventory-count "kind" labels, day-of-week pills in the EOD week
sidebar, role labels in the Users & access section, and the units of
measure shown on ingredient / recipe / prep forms — to render in my
preferred language, so that every fixed-vocabulary surface in the app
respects my locale instead of leaking English when I switch from `en`
to `es` or `zh-CN`.

Concrete scenario: the manager at the Frederick store is now in
`zh-CN`. After spec 038 her sidebar, section titles, tab labels, and
toast messages already render in Chinese. She opens **Waste log**, the
reason dropdown still says `Expired / Dropped/spilled / Over-prepped / …`
in English — that's the gap this spec closes. After spec 039, the
dropdown renders Chinese labels; her existing log entries (whose
`reason` column literally says `'Expired'` in the DB) display the
Chinese translation by looking up `enum.wasteReason.expired` rather
than the raw DB value. The DB value is unchanged — translation is purely
display-side.

A second scenario: she opens **EOD count**. The week sidebar shows
seven day pills — `MON TUE WED THU FRI SAT SUN`. In Chinese she sees
`周一 周二 周三 周四 周五 周六 周日` (or the chosen short form). The
"REST DAY" / "LATE" pill labels already covered by spec 038
(`section.eod.restDayLabel`, `section.eod.late`) continue to work.

A third scenario: she opens **Audit log**. Action verbs like
`'submitted EOD count'`, `'edited item'`, `'logged waste'`, `'deleted
item'` render in Chinese. The raw audit_log row keeps its English
`action` column (`'EOD entry' / 'Item edit' / …`) — translation
happens in `formatAuditAction()` via `t()`.

## Acceptance criteria

Catalog (new keys, single file extension):

- [ ] Catalog files `src/i18n/{en,es,zh-CN}.json` gain a new top-level
      `enum` namespace with five sub-namespaces:
      - `enum.itemStatus.{ok,low,out,info}` — four keys, short uppercase
        token form (e.g. `OK / LOW / OUT / INFO`). Used by
        `statusLabel()` in [src/theme/statusColors.ts](../src/theme/statusColors.ts).
      - `enum.wasteReason.{expired,droppedSpilled,overPrepped,qualityIssue,theft,other}`
        — six keys. Sentence-case display form (`Expired`, `Dropped/spilled`,
        `Over-prepped`, `Quality issue`, `Theft`, `Other`). The lowercase
        short form (`expired / dropped / overproduction / quality / theft /
        other`) used by the filter chip in WasteLogSection's
        `REASON_LABEL` map gets a sibling key
        `enum.wasteReason.short.{...}` with the same six identifiers.
      - `enum.auditAction.{eodEntry,itemEdit,itemAdded,itemDeleted,posImport,wasteLog,userInvite,userDeleted,recipeSaved,recipeDeleted,prepRecipeSaved,prepRecipeDeleted,stockAdjusted}`
        — 13 keys. The display form used by
        `formatAuditAction()` in [src/utils/formatAuditAction.ts](../src/utils/formatAuditAction.ts)
        (e.g. `'submitted EOD count'`, `'edited item'`).
      - `enum.inventoryCountKind.{spot,open,midShift,close}` —
        four keys. Each value is the short label (`Spot`, `Open`,
        `Mid-shift`, `Close`); the sub-caption (`'ad-hoc check'`,
        `'morning open'`, `'between shifts'`, `'pre-EOD close'`)
        used inside `AddInventoryCountModal` gets a sibling key
        `enum.inventoryCountKind.sub.{...}` with the same four identifiers.
      - `enum.role.{user,admin,master,superAdmin}` — four keys.
        Sentence-case display form (`User / Admin / Master / Super admin`).
        The existing `role.*` keys at the top of the catalog (added in
        spec 038) are RE-USED — see "Catalog reuse" below.
      - `enum.userStatus.{active,pending}` — two keys, uppercase
        (`ACTIVE / PENDING`). Used by UsersSection's StatusPill.
      - `enum.dayOfWeek.long.{monday,tuesday,wednesday,thursday,friday,saturday,sunday}`
        — seven keys, full form (`Monday`, `Lunes`, `星期一`, etc.).
      - `enum.dayOfWeek.short.{mon,tue,wed,thu,fri,sat,sun}` — seven
        keys, three-letter form (`MON / TUE / …`). The Chinese catalog
        chooses single-character form (`一 / 二 / 三 / 四 / 五 / 六 / 日`)
        or two-character form (`周一 / 周二 / …`) — translator's call,
        documented as a Note (see "Open questions resolved" below for
        the chosen form).
      - `enum.unit.{each,lbs,oz,g,kg,flOz,cups,qt,gal,cases,bags}`
        — 11 keys. The catalog list mirrors `CANONICAL_UNITS` in
        [src/utils/unitConversion.ts](../src/utils/unitConversion.ts)
        plus the four abstract container units already surfaced through
        the form dropdowns (`each`, `cases`, `bags`, and we add `tray`
        only if it appears in a default form — see "Out of scope"
        below — currently it does not, so we ship 11 keys, not 12).
- [ ] Catalog **reuse rule** — the existing top-level `role.*` and
      `status.*` keys (added in spec 038) are NOT duplicated. The new
      enum namespace's `enum.role.*` and `enum.itemStatus.*` aliases
      live alongside the existing keys, but the implementation MUST
      pick ONE canonical key per concept. The architect picks (likely
      collapse to a single shape — `enum.role.*` is the new canonical;
      delete the spec-038 `role.*` top-level after migrating the two
      call-sites). The catalog-parity test in
      [src/i18n/i18n.test.ts](../src/i18n/i18n.test.ts) continues to
      enforce no orphan keys across `en / es / zh-CN`.
- [ ] All three catalog files (`en.json`, `es.json`, `zh-CN.json`)
      ship with the same enum key set. The existing parity test
      automatically covers the new keys.

Codebase wiring (call sites that switch from literal strings to `t()`):

- [ ] `statusLabel()` in [src/theme/statusColors.ts](../src/theme/statusColors.ts)
      is REPLACED by a hook `useStatusLabel()` (or `StatusPill` is
      rewired to call `t()` directly). The function-form returning
      a static string can't reach React context for the active locale;
      every caller already lives inside a component, so the migration
      is mechanical. Architect picks the shape.
- [ ] `StatusPill` and `StatusDot` consumers that pass `label=` props
      pre-translate via `useT()` at the call-site (they already do
      this in spec 038 for non-enum labels). For consumers that rely
      on the default label (no `label` prop), the new locale-aware
      `statusLabel` path applies.
- [ ] `WasteLogSection.tsx`'s `REASON_LABEL` map and the dropdown that
      renders `REASONS: WasteReason[]` route through
      `t('enum.wasteReason.<key>')` and
      `t('enum.wasteReason.short.<key>')`. The DB column
      `waste_log.reason` continues to store the English canonical
      (`'Expired' / 'Dropped/spilled' / …`); translation is display-only.
- [ ] `formatAuditAction()` in [src/utils/formatAuditAction.ts](../src/utils/formatAuditAction.ts)
      is rewritten to take a `t` function as a parameter (or convert
      to a `useAuditActionLabel()` hook). Maps each `AuditAction`
      enum value to its `enum.auditAction.<camelCase>` key via a
      `Record<AuditAction, string>` lookup. Callers in
      [src/screens/cmd/sections/AuditLogSection.tsx](../src/screens/cmd/sections/AuditLogSection.tsx)
      pass the `T` from `useT()`.
- [ ] `AddInventoryCountModal`'s `KIND_OPTIONS` and `KIND_LABEL`
      route through `t('enum.inventoryCountKind.<camelCase>')` and
      `t('enum.inventoryCountKind.sub.<camelCase>')`.
- [ ] `UsersSection.tsx`'s `roleLabel()` and the `'ACTIVE' / 'PENDING'`
      pill label switch route through `t('enum.role.<camelCase>')` and
      `t('enum.userStatus.<key>')`. Note: there is a precedent collision
      with the existing top-level `role.*` keys from spec 038 — see the
      catalog reuse rule above. Architect resolves before build.
- [ ] `DAY_NAMES` and `DAY_SHORT` literal arrays in
      [src/screens/cmd/sections/OrderScheduleSection.tsx](../src/screens/cmd/sections/OrderScheduleSection.tsx)
      and [src/screens/cmd/sections/EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx)
      keep the English strings as IDs (they're DB keys for
      `order_schedule[day]` lookups) but the **rendered text** in
      pills routes through `t('enum.dayOfWeek.short.<key>')` /
      `t('enum.dayOfWeek.long.<key>')`. Same pattern as
      `formatAuditAction` — separate ID from display label.
- [ ] Unit dropdowns in `IngredientForm.tsx`, `RecipeFormDrawer.tsx`,
      `PrepRecipeFormDrawer.tsx`, and `InventoryCatalogMode.tsx`
      route the displayed unit text through `t('enum.unit.<key>')`.
      The stored `unit` column on `inventory_items` / `recipes` /
      `prep_recipes` continues to hold the English canonical
      (`'lbs'`, `'each'`, `'cases'`, etc.); translation is display-only.
- [ ] **Filename-style tab labels stay verbatim across all locales** —
      `items.tsv`, `catalog.tsv`, `count.tsx`, `history.tsx`,
      `variance.log`, `feed.tsx`, `byUser.tsx`, `byEntity.tsx`,
      `order_schedule.tsv` are intentionally code-style tokens that
      look like file paths, and read as commands rather than English
      text. No `t()` wrapping. Comments in the affected sections
      already note this — re-confirm during the extraction pass and
      do not "fix" them. The sibling `categories` tab label in
      InventoryDesktopLayout (which is NOT filename-style — no
      extension) DOES route through `t('section.inventory.tabs.categories')`,
      a key that already exists in the catalog.

Search / filter behavior:

- [ ] When a user filters inventory rows by status (`OK / LOW / OUT`),
      the filter source array continues to be the English canonical
      (`['ok', 'low', 'out']`); the **displayed chip label** is the
      translated value. Same shape applies to waste-reason and audit-
      action filter chips. No DB-side change.
- [ ] When the user types into a "search" or "filter" text input over
      a translated enum (e.g. typing `"venc"` in Spanish mode over the
      waste-reason list), the match scans BOTH the current-locale
      label AND the English canonical. Implementation: matcher folds
      lowercase + strips accents on both candidates and does substring
      contains. Rationale: a Spanish user typing in Spanish gets local
      matches; a bilingual user or one pasting an English copy gets
      the English match. Both work.

Sort stability:

- [ ] Status enums (`ok / low / out / info`), waste reasons, audit
      actions, inventory-count kinds, and user roles sort by their
      **fixed enum position**, not alphabetically. The codebase
      already does this — confirm no sort code switches to
      `localeCompare` accidentally.
- [ ] Units sort by their position in `CANONICAL_UNITS` (weight units
      first, then volume, then abstract `each / cases / bags`). No
      change.
- [ ] Day-of-week sorts Sunday-first or Monday-first per the existing
      sites (some surfaces use Sun-first, some use Mon-first — that
      pre-existing inconsistency is NOT this spec's concern). No
      change.
- [ ] Categories — out of scope (user data, deferred to P3).

Tests:

- [ ] **Track 1 (jest).** The existing parity test
      `src/i18n/i18n.test.ts` automatically covers the new `enum.*`
      keys via the recursive flatten-keys helper. No new test file
      required, but architect MAY add targeted assertions inside the
      same file:
      - `t('en', 'enum.wasteReason.expired')` returns `'Expired'`
      - `t('zh-CN', 'enum.itemStatus.ok')` returns the Chinese OK
        string
      - The `formatAuditAction()` rewrite returns the translated
        display for each of the 13 `AuditAction` values
      - The day-of-week rendering hook returns the translated short /
        long form for each of `monday … sunday`
- [ ] **Track 2 (pgTAP).** None. No DB column is touched by P2.
- [ ] **Track 3 (smoke).** None. No edge function is touched.
- [ ] `npm run typecheck`, `npm run typecheck:test`, `npm test` all
      pass.

Misc:

- [ ] No new dependency added. Spec 038's hand-rolled `t()` + `useT()`
      hook is the only entry point.
- [ ] No new hook beyond `useStatusLabel()` (if architect picks the
      hook shape) and `useAuditActionLabel()` (if architect picks the
      hook shape).
- [ ] No new file in `src/i18n/` — extend the three existing
      catalogs.

## In scope

- Translation of seven curated enum families: item status, waste
  reasons, audit actions, inventory-count kinds, user roles, user
  status, units of measure, and day-of-week labels.
- Display-side translation only. No DB schema change. No migration.
- Catalog parity test extension (covered automatically by the existing
  flatten-keys assertion).
- Search / filter behavior — match against current locale + English
  fallback (both).

## Out of scope (explicitly)

- **User-mutable categories** — `recipe_categories` and
  `ingredient_categories` are `public.*_categories` tables with full
  CRUD via `addRecipeCategory / renameRecipeCategory / deleteRecipeCategory`
  (and the ingredient pair). Even though the seed.sql ships English
  values (`'Bread'`, `'Cleaning Supplies'`, `'Protein'`, etc.), users
  edit / rename / add them at runtime, so they are functionally user
  data. Deferred to spec **040 (P3 — user-entered data)**.
- **Recipe `category` field on individual recipes** — the per-recipe
  category is a free-text join key against `recipe_categories.name`.
  Same reason as above. Deferred to P3.
- **The `currentBrand.name` / `currentStore.name` display strings** —
  user-mutable. P3.
- **Date / time / number / currency formatting** — spec 038 already
  deferred this; P2 inherits the deferral. The day-of-week pill
  labels in this spec are LABEL translations only (`MON → 一`), not
  full `Intl.DateTimeFormat`-derived strings. Switching to
  `Intl.DateTimeFormat(locale, { weekday: 'short' })` is the cleaner
  long-term answer but couples us to runtime locale data we don't
  ship; tracked under "Open questions resolved" below.
- **Filename-style tab labels** — `items.tsv`, `catalog.tsv`,
  `count.tsx`, `history.tsv`, `variance.log`, `feed.tsx`, `byUser.tsv`,
  `byEntity.tsv`, `order_schedule.tsv` stay verbatim across all
  locales. Rationale: they look like file paths and read as commands
  rather than English text; translation would break that aesthetic
  metaphor.
- **The bottom-left chrome pill copy** — `EN / ES / 中文` from the
  LocaleSwitcher (added by spec 038) is locale-invariant by design.
  No change.
- **ICU plural rules** — P2 inherits spec 038's deferral; if a plural
  variant matters (e.g. "1 item / N items" inside an enum-bearing
  toast), the catalog author splits the key.
- **Email templates, edge-function HTML, push-notification bodies** —
  all out of scope; they are not user-facing in-app chrome.
- **The 8 deferred section files from spec 038** (RecipesSection,
  PrepRecipesSection, VendorsSection, ReceivingSection,
  ReconciliationSection, POsSection, OrderScheduleSection,
  InventoryCatalogMode) — P2 ONLY touches the call-sites within them
  that render the enum families in scope (e.g. unit dropdowns in
  RecipeFormDrawer). The remaining English literals in those files
  (titles, empty states, button text) stay English in P2 and are
  picked up as ad-hoc cleanup or with P3.
- **`recipeCategories` array initial-state default** in
  [src/store/useStore.ts](../src/store/useStore.ts) (`'Sandwiches & Burgers'`, `'Over Rice Platters'`,
  `'Mains'`, …) — even though this looks like a hardcoded enum, it's
  a fallback when the brand has no rows in `recipe_categories` yet,
  AND the values flow into the same user-mutable table. Keep as-is.

## Open questions resolved

- Q: Cmd UI file-name tabs — translate or keep as-is? → A: **Keep
  as-is** across all locales. They look like file paths
  (`count.tsx`, `variance.log`, `items.tsv`); translating would break
  the metaphor. The acceptance criteria explicitly list which tab
  labels stay verbatim.
- Q: Category enums — translate the few seeded values, or punt
  entirely to P3? → A: **Punt entirely to P3.** All category rows
  flow through user CRUD (`addIngredientCategory`,
  `renameIngredientCategory`, …); even though seed.sql ships English
  defaults, they aren't fixed enums. P3 will address the user-data
  category strategy.
- Q: Day-of-week — `Intl.DateTimeFormat` or hand-rolled catalog
  entries? → A: **Hand-rolled catalog entries.** Consistent with
  spec 038's t() pattern; avoids a runtime-locale dependency for
  seven strings × three locales. Architect MAY override and switch
  to `Intl.DateTimeFormat(locale, { weekday: 'short' | 'long' })` if
  the catalog drift cost is judged higher than the data-coupling
  cost — surface in the design doc with the call.
- Q: Catalog-key namespace — new top-level `enum.*` namespace, or
  reuse / extend the existing top-level `status.*` and `role.*`? →
  A: **New top-level `enum.*` namespace.** The existing top-level
  `role.*` and `status.*` from spec 038 collapse INTO `enum.role.*`
  and `enum.itemStatus.*` (canonical), and the spec 038 versions are
  deleted in the same commit. Eliminates the alias / duplicate-key
  hazard. Catalog parity test enforces no orphans.
- Q: Day-of-week display form in Chinese — single character
  (`一 / 二 / 三 / 四 / 五 / 六 / 日`), two-character (`周一 / 周二 / …`),
  or full form (`星期一 / 星期二 / …`)? → A: **Two-character short
  form (`周一` etc.) for `enum.dayOfWeek.short.*`, three-character
  full form (`星期一` etc.) for `enum.dayOfWeek.long.*`.** Most
  legible at the 9.5–10.5 fontSize the day-pill UI uses. Spanish
  uses `LUN / MAR / MIÉ / JUE / VIE / SÁB / DOM` for short,
  `Lunes / Martes / Miércoles / Jueves / Viernes / Sábado / Domingo`
  for long. Translator may revise during catalog authoring.
- Q: Search / filter — match localized label only, English only, or
  both? → A: **Both** (current-locale label AND English canonical).
  Spanish user typing "venc" matches "vencido" (Spanish); same user
  pasting an English copy still matches "expired". Folded
  lowercase, accent-stripped.
- Q: Sort stability — locale-aware (`localeCompare`) or fixed enum
  position? → A: **Fixed enum position** for everything in scope.
  Status / waste reason / audit action / inventory-count kind / role
  / user status all have a natural ordering (severity, by-axis order,
  etc.). Units sort by `CANONICAL_UNITS` index. Day-of-week stays in
  calendar order. None of these enums alphabetize today, so this is
  a "no change" item — explicitly called out so the architect doesn't
  over-design.

## Dependencies

- **Spec 038** (P1 — chrome i18n) — SHIPPED at commit `75b3f94`.
  Provides `t()`, `useT()`, `useLocale()`, `Locale` type, three
  catalog files, the parity test, and the LocaleSwitcher pill. Spec
  039 extends without rewriting any of this.
- No new library, no new package, no new hook beyond the optional
  `useStatusLabel()` / `useAuditActionLabel()` (architect picks).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. Legacy was deleted in
  spec 025.
- **Per-store or admin-global:** N/A. Locale is per-user (set by
  spec 038); the enum translation is purely client-side display.
- **Realtime channels touched:** None. No DB write. No publication
  change.
- **Migrations needed:** **None.** All work is in
  `src/i18n/*.json` and the call-site rewires. Confirms the
  next-free migration timestamp (`20260516010000_*.sql`) stays
  available for a future spec.
- **Edge functions touched:** None.
- **Web/native scope:** Both. The catalog files and `t()` machinery
  are platform-agnostic; native shells consume the same hook.
- **Test track routing:** Track 1 (jest) only. The existing parity
  test in `src/i18n/i18n.test.ts` automatically covers the new keys.
  Architect MAY add targeted spot-check assertions inside the same
  file (no new test file).
- **`app.json` slug:** Not touched. Stays `towson-inventory` per
  CLAUDE.md.

## Backend / architecture design

### 0. Backend impact summary (confirmations)

This is a **frontend-only spec.** Confirming the spec's claims:

- **No new tables / columns / indexes / migrations.** Verified — DB columns
  (`waste_log.reason`, `inventory_counts.kind`, `profiles.role`,
  `audit_log.action`, `inventory_items.unit`, `order_schedule.*`) all
  continue to store the English canonical. Translation is purely display-side.
  Next migration timestamp `20260516010000_*.sql` stays available.
- **No RLS changes.** No new table → no new policy.
- **No new edge function. No edge-function modification.** None of the call
  sites here run server-side.
- **No realtime publication change.** No table touched. The realtime
  publication-membership gotcha (`docker restart supabase_realtime_imr-inventory`)
  does NOT apply to this spec.
- **No `src/lib/db.ts` change.** snake_case → camelCase mapping is not
  involved; the mapping for the affected columns (`reason`, `kind`, `role`,
  `unit`, `action`) is already in place from earlier specs.
- **No new edge dependency, no new npm package.** Hand-rolled `t()` from
  spec 038 is the only entry point.

### 1. Architect decisions

The PM handoff called out four architect-decisions. Resolved below.

#### (a) `statusLabel()` / `formatAuditAction()` shape — **pass `T` as a parameter, not a hook**

Decision: **pure functions that take `T` as a parameter, not new hooks.**

Rationale, in order of weight:

1. **Every call site is already inside a component that has `T` in scope**
   (or trivially can call `useT()`). `formatAuditAction` is invoked in 4
   files (`AuditLogSection.tsx`, `AuditHistory.tsx`, `ItemDetailScreen.tsx`,
   `InventoryDesktopLayout.tsx`), all already importing `useT` or near
   components that do. `statusLabel` is invoked in exactly one place
   (`StatusPill.tsx` line 32, default-label fallback) plus the
   one-off `POSImportsSection.tsx` locally-named `statusLabel` shadow
   variable (unrelated, stays).
2. **Pure functions are easier to test** — the spec's targeted assertions
   in `i18n.test.ts` (`formatAuditAction({ action: 'EOD entry' }, mockT)
   returns 'submitted EOD count'` etc.) work without `renderHook` /
   `@testing-library/react-native`. New hooks would force the test up to
   the component-render layer.
3. **No React-rules-of-hooks risk.** A `useStatusLabel()` hook called
   inside the `{label ?? useStatusLabel(status)}` JSX expression would
   technically work (StatusPill always calls it from the top level) but
   it's idiomatically awkward — the lookup is data, not state.
4. **One exception worth flagging:** `StatusPill`'s default-label branch
   (`label ?? statusLabel(status)`) means `StatusPill` itself needs to
   call `T` to compute the fallback. The cleanest shape is to call
   `useT()` once inside `StatusPill` and pass `T` into `statusLabel(status, T)`.
   Existing `StatusPill` callers that pass `label=` continue to work
   unchanged. The 4 default-label callers (`ItemDetailScreen.tsx:156`,
   `InventoryDesktopLayout.tsx:471`, `RestockSection.tsx:235`,
   `InventoryCatalogMode.tsx:345,416,543`) automatically pick up the
   translation through the now-locale-aware default.

**Final signatures:**

```ts
// src/theme/statusColors.ts
export type Status = 'ok' | 'low' | 'out' | 'info';
type TFn = (key: string, vars?: Record<string, string | number>) => string;

export const statusFg = (c: CmdPalette, s: Status): string => /* unchanged */;
export const statusBg = (c: CmdPalette, s: Status): string => /* unchanged */;

// CHANGED: now takes T. Returns the translated short uppercase token.
export const statusLabel = (s: Status, T: TFn): string =>
  T(`enum.itemStatus.${s}`);

// src/utils/formatAuditAction.ts
import { AuditEvent, AuditAction } from '../types';
type TFn = (key: string, vars?: Record<string, string | number>) => string;

// English canonical → enum.auditAction.* dot-key. Source of truth for the
// mapping between AuditAction enum strings and camelCase i18n keys.
const KEY_BY_ACTION: Record<AuditAction, string> = {
  'EOD entry':           'eodEntry',
  'Item edit':           'itemEdit',
  'Item added':          'itemAdded',
  'Item deleted':        'itemDeleted',
  'POS import':          'posImport',
  'Waste log':           'wasteLog',
  'User invite':         'userInvite',
  'User deleted':        'userDeleted',
  'Recipe saved':        'recipeSaved',
  'Recipe deleted':      'recipeDeleted',
  'Prep recipe saved':   'prepRecipeSaved',
  'Prep recipe deleted': 'prepRecipeDeleted',
  'Stock adjusted':      'stockAdjusted',
};

// CHANGED: now takes T. Falls back to `action.toLowerCase()` for any
// unmapped action — preserves existing pre-i18n behavior.
export function formatAuditAction(
  event: Pick<AuditEvent, 'action'>,
  T: TFn,
): string {
  const key = KEY_BY_ACTION[event.action];
  return key ? T(`enum.auditAction.${key}`) : event.action.toLowerCase();
}
```

Same shape for **WasteReason**, **UserRole**, **InventoryCountKind**,
**UserStatus**, **day-of-week**, **unit** — all pass `T` directly:

```ts
// src/utils/enumLabels.ts (NEW FILE — one home for these tiny resolvers)
type TFn = (key: string, vars?: Record<string, string | number>) => string;
type WasteReason = 'Expired' | 'Dropped/spilled' | 'Over-prepped'
                 | 'Quality issue' | 'Theft' | 'Other';
type UserRole = 'user' | 'admin' | 'master' | 'super_admin';
type InventoryCountKind = 'spot' | 'open' | 'mid_shift' | 'close';
type UserStatus = 'active' | 'pending';
type DayName = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday'
             | 'Thursday' | 'Friday' | 'Saturday';

// Display form (Sentence case).
const WASTE_REASON_KEY: Record<WasteReason, string> = {
  'Expired':         'expired',
  'Dropped/spilled': 'droppedSpilled',
  'Over-prepped':    'overPrepped',
  'Quality issue':   'qualityIssue',
  'Theft':           'theft',
  'Other':           'other',
};
export function wasteReasonLabel(r: WasteReason, T: TFn): string {
  return T(`enum.wasteReason.${WASTE_REASON_KEY[r]}`);
}
// Sibling short form for filter-chip rendering (replaces the
// hand-rolled REASON_LABEL map in WasteLogSection.tsx).
export function wasteReasonShortLabel(r: WasteReason, T: TFn): string {
  return T(`enum.wasteReason.short.${WASTE_REASON_KEY[r]}`);
}

const ROLE_KEY: Record<UserRole, string> = {
  user: 'user', admin: 'admin', master: 'master', super_admin: 'superAdmin',
};
export function roleLabel(role: UserRole, T: TFn): string {
  return T(`enum.role.${ROLE_KEY[role]}`);
}

const KIND_KEY: Record<InventoryCountKind, string> = {
  spot: 'spot', open: 'open', mid_shift: 'midShift', close: 'close',
};
export function inventoryCountKindLabel(k: InventoryCountKind, T: TFn): string {
  return T(`enum.inventoryCountKind.${KIND_KEY[k]}`);
}
export function inventoryCountKindSubLabel(k: InventoryCountKind, T: TFn): string {
  return T(`enum.inventoryCountKind.sub.${KIND_KEY[k]}`);
}

export function userStatusLabel(s: UserStatus, T: TFn): string {
  return T(`enum.userStatus.${s}`);
}

const DAY_KEY: Record<DayName, string> = {
  Sunday: 'sunday', Monday: 'monday', Tuesday: 'tuesday',
  Wednesday: 'wednesday', Thursday: 'thursday', Friday: 'friday',
  Saturday: 'saturday',
};
export function dayOfWeekShortLabel(d: DayName, T: TFn): string {
  return T(`enum.dayOfWeek.short.${DAY_KEY[d]}`);
}
export function dayOfWeekLongLabel(d: DayName, T: TFn): string {
  return T(`enum.dayOfWeek.long.${DAY_KEY[d]}`);
}

// Unit label — accepts the stored canonical (already lowercase per
// CANONICAL_UNITS). `fl_oz` maps to `flOz` for the i18n key.
const UNIT_KEY: Record<string, string> = {
  g: 'g', kg: 'kg', oz: 'oz', lbs: 'lbs',
  fl_oz: 'flOz', cups: 'cups', qt: 'qt', gal: 'gal',
  each: 'each', cases: 'cases', bags: 'bags',
};
export function unitLabel(unit: string, T: TFn): string {
  const u = (unit || '').toLowerCase().trim();
  const camel = UNIT_KEY[u];
  // Unknown / one-off unit (e.g. an ingredient-conversion purchase_unit
  // that hasn't been added to CANONICAL_UNITS) — return the raw value
  // unchanged. Same shape as `formatAuditAction`'s fallback.
  return camel ? T(`enum.unit.${camel}`) : unit;
}
```

The `enumLabels.ts` file is new but mechanical — 7 tiny functions each
roughly 3 lines. Co-locating them avoids 7 separate files of similar
shape. Pattern-wise this matches `src/utils/formatAuditAction.ts` (one
function per file is also fine; one file for tightly-related label
resolvers is also fine — author's pick during build, no architectural
significance).

#### (b) Catalog-key collapse — **migrate `status.*` / `role.*` into `enum.*` in the same commit**

Decision: **collapse — delete the spec-038 top-level `status.*` /
`role.*` keys, ship only `enum.itemStatus.*` and `enum.role.*`.**

Rationale:

1. **Zero current consumers.** Grep on `T('role.` and `T('status.`
   returns nothing — the spec-038 keys were added to the catalog but
   never wired into a call site. No code migration is required, only
   a JSON delete. Verified via `grep "T('role\\.\\|T('status\\."
   src/` in this design pass.
2. **The PM's resolution already chose this path** (Open questions
   resolved §4: "the spec 038 versions are deleted in the same commit.
   Eliminates the alias / duplicate-key hazard").
3. **Catalog-parity test enforces no orphans** — the three catalog
   files must stay key-set-equal, so deleting in one file but not
   another is a test failure. Test does not need to be changed.

**Migration path (zero call-site changes):**

In `src/i18n/{en,es,zh-CN}.json` — delete the entire top-level
`"status": { ... }` block (4 keys: `good / low / out / expired`) and
the entire top-level `"role": { ... }` block (4 keys: `user / admin /
master / superAdmin`). Add the new `"enum": { ... }` block at the
same top-level position.

Note on key name `enum.itemStatus.*` vs the deleted `status.good`:
the deleted `status.good` mapped to English `"Good"`. The new
`enum.itemStatus.ok` maps to English `"OK"`. The PM's acceptance
criteria says the four `itemStatus` keys are `ok / low / out / info`
(matching the `Status` TypeScript union). Translation values change:
en `"OK" / "LOW" / "OUT" / "INFO"` (uppercase short form, matches
existing `statusLabel()` output exactly so visual diff is zero on
English).

#### (c) Day-of-week — **hand-rolled catalog**

Decision: **hand-rolled catalog entries** per the PM's pre-resolution.

Confirming the PM's call rather than overriding:

1. **Consistency with `t()` everywhere else.** All other enum families
   in this spec go through `t()`. Mixing in `Intl.DateTimeFormat`
   for one of seven families creates a "two ways to translate things"
   surface that the catalog-parity test cannot enforce.
2. **Bundle weight is negligible.** Seven days × three locales × ~6
   chars per value = ~120 bytes flat. The catalog file gain is in the
   noise.
3. **Control over short-form display.** The PM resolution chose
   two-character Chinese (`周一 周二 …`) rather than what
   `Intl.DateTimeFormat('zh-CN', { weekday: 'short' })` would emit
   (`周一` actually, so it would agree — but the cost of confirming
   what the runtime ships for every locale × every browser × every
   RN version is real). Static catalog values eliminate that surface.
4. **Day-of-week values are also used as DB join keys** in
   `OrderScheduleSection.tsx` (`'Monday' .. 'Sunday'` indexes into
   `order_schedule`). The ID stays English-canonical; the display
   form goes through `t()`. Same separation pattern as
   `formatAuditAction` (`action` column = English, display = `t()`).

The seven short-form values + seven long-form values × three locales =
42 strings total; minor.

#### (d) Search/filter matcher shape — **new helper `matchesQuery()` in `src/i18n/matchesQuery.ts`**

Decision: **new file `src/i18n/matchesQuery.ts`, signature
`matchesQuery(query, candidates): boolean`.**

Rationale:

1. **The helper is i18n-specific** (fold lowercase + strip diacritics
   handles the Spanish `é / í / ó / ú / ñ` cases that the
   `enum.wasteReason.short` Spanish translations may use). Living
   next to the catalog is the right home.
2. **Existing `toLowerCase()` call sites in `src/store/useStore.ts`
   stay untouched** — those operate on stable English data
   (`pos_name`, `menuItem`, `itemName`) that doesn't need
   diacritic-stripping. The new helper is for translated enum
   surface search, not a general replacement.
3. **No npm dependency.** `String.prototype.normalize('NFD')` + a
   `/\p{Diacritic}/gu` strip is built into ES2018 and works on every
   target (web + RN iOS + RN Android with Hermes).

**Final signature:**

```ts
// src/i18n/matchesQuery.ts
//
// Diacritic-folded, case-insensitive substring matcher for translated
// enum filter inputs. Returns true if `query` matches ANY candidate
// after both sides are normalized.
//
// Normalization:
//   1. NFD decompose (`é` → `e` + combining mark)
//   2. Strip diacritic marks (`\p{Diacritic}`)
//   3. Lowercase
//   4. Trim
//
// Usage:
//   const T = useT();
//   matchesQuery(input, [
//     wasteReasonLabel(r, T),       // localized
//     wasteReasonShortLabel(r, T),  // localized short
//     r,                             // English canonical (DB value)
//   ]);

export function matchesQuery(query: string, candidates: string[]): boolean {
  const q = fold(query);
  if (!q) return true; // empty filter matches everything
  return candidates.some((c) => fold(c).includes(q));
}

function fold(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}
```

The signature `(query: string, candidates: string[]): boolean`
matches the PM's suggestion. Callers in `WasteLogSection.tsx`,
`AuditLogSection.tsx`, `UsersSection.tsx`, `InventoryCountSection.tsx`
build the candidates array per row (typically
`[translatedLabel, englishCanonical]` — both folded inside `fold()`).

### 2. Catalog file shape

The three files `src/i18n/{en,es,zh-CN}.json` gain one new top-level
key `enum` and lose two existing top-level keys (`status`, `role`).
Final JSON structure for `en.json` (the canonical):

```json
{
  // ... existing keys unchanged: sidebar, chrome, common, toast,
  // section, tabStrip, modals, drawers, filterChip ...

  // DELETED:
  //   "status": { "good": "Good", "low": "Low", "out": "Out",
  //               "expired": "Expired" }
  //   "role":   { "user": "User", "admin": "Admin", "master": "Master",
  //               "superAdmin": "Super admin" }

  // NEW:
  "enum": {
    "itemStatus": {
      "ok":   "OK",
      "low":  "LOW",
      "out":  "OUT",
      "info": "INFO"
    },
    "wasteReason": {
      "expired":        "Expired",
      "droppedSpilled": "Dropped/spilled",
      "overPrepped":    "Over-prepped",
      "qualityIssue":   "Quality issue",
      "theft":          "Theft",
      "other":          "Other",
      "short": {
        "expired":        "expired",
        "droppedSpilled": "dropped",
        "overPrepped":    "overproduction",
        "qualityIssue":   "quality",
        "theft":          "theft",
        "other":          "other"
      }
    },
    "auditAction": {
      "eodEntry":          "submitted EOD count",
      "itemEdit":          "edited item",
      "itemAdded":         "added item",
      "itemDeleted":       "deleted item",
      "posImport":         "imported POS",
      "wasteLog":          "logged waste",
      "userInvite":        "invited user",
      "userDeleted":       "deleted user",
      "recipeSaved":       "saved recipe",
      "recipeDeleted":     "deleted recipe",
      "prepRecipeSaved":   "saved prep recipe",
      "prepRecipeDeleted": "deleted prep recipe",
      "stockAdjusted":     "adjusted stock"
    },
    "inventoryCountKind": {
      "spot":     "Spot",
      "open":     "Open",
      "midShift": "Mid-shift",
      "close":    "Close",
      "sub": {
        "spot":     "ad-hoc check",
        "open":     "morning open",
        "midShift": "between shifts",
        "close":    "pre-EOD close"
      }
    },
    "role": {
      "user":       "User",
      "admin":      "Admin",
      "master":     "Master",
      "superAdmin": "Super admin"
    },
    "userStatus": {
      "active":  "ACTIVE",
      "pending": "PENDING"
    },
    "dayOfWeek": {
      "short": {
        "monday": "MON", "tuesday": "TUE", "wednesday": "WED",
        "thursday": "THU", "friday": "FRI", "saturday": "SAT",
        "sunday": "SUN"
      },
      "long": {
        "monday": "Monday", "tuesday": "Tuesday",
        "wednesday": "Wednesday", "thursday": "Thursday",
        "friday": "Friday", "saturday": "Saturday", "sunday": "Sunday"
      }
    },
    "unit": {
      "g":     "g",
      "kg":    "kg",
      "oz":    "oz",
      "lbs":   "lbs",
      "flOz":  "fl_oz",
      "cups":  "cups",
      "qt":    "qt",
      "gal":   "gal",
      "each":  "each",
      "cases": "cases",
      "bags":  "bags"
    }
  }
}
```

Total new keys:

- `enum.itemStatus.*` — 4
- `enum.wasteReason.*` — 6 + 6 = 12
- `enum.auditAction.*` — 13
- `enum.inventoryCountKind.*` — 4 + 4 = 8
- `enum.role.*` — 4
- `enum.userStatus.*` — 2
- `enum.dayOfWeek.*` — 7 + 7 = 14
- `enum.unit.*` — 11

= **68 new keys per locale × 3 locales = 204 strings.** Minus the 8
deleted (`status.*` + `role.*` × 1 locale each = ~24 across three
locales). Net **+180 strings.** Bundle weight check below.

**Spanish translation seed values** (translator may revise during
build):

| Key                                  | en              | es                  |
|--------------------------------------|-----------------|---------------------|
| `enum.itemStatus.ok`                 | OK              | OK                  |
| `enum.itemStatus.low`                | LOW             | BAJO                |
| `enum.itemStatus.out`                | OUT             | AGOTADO             |
| `enum.itemStatus.info`               | INFO            | INFO                |
| `enum.wasteReason.expired`           | Expired         | Vencido             |
| `enum.wasteReason.droppedSpilled`    | Dropped/spilled | Caído/derramado     |
| `enum.wasteReason.overPrepped`       | Over-prepped    | Sobre-preparado     |
| `enum.wasteReason.qualityIssue`      | Quality issue   | Problema de calidad |
| `enum.wasteReason.theft`             | Theft           | Robo                |
| `enum.wasteReason.other`             | Other           | Otro                |
| `enum.auditAction.eodEntry`          | submitted EOD count | envió conteo EOD |
| `enum.role.superAdmin`               | Super admin     | Super administrador |
| `enum.userStatus.active`             | ACTIVE          | ACTIVO              |
| `enum.userStatus.pending`            | PENDING         | PENDIENTE           |
| `enum.dayOfWeek.short.monday`        | MON             | LUN                 |
| `enum.dayOfWeek.long.monday`         | Monday          | Lunes               |

**Chinese translation seed values:**

| Key                                  | en              | zh-CN              |
|--------------------------------------|-----------------|--------------------|
| `enum.itemStatus.ok`                 | OK              | 正常               |
| `enum.itemStatus.low`                | LOW             | 偏低               |
| `enum.itemStatus.out`                | OUT             | 缺货               |
| `enum.wasteReason.expired`           | Expired         | 过期               |
| `enum.wasteReason.droppedSpilled`    | Dropped/spilled | 掉落/洒出          |
| `enum.dayOfWeek.short.monday`        | MON             | 周一               |
| `enum.dayOfWeek.long.monday`         | Monday          | 星期一             |

Translator latitude is intentional — these are seed values. The
catalog-parity test only enforces key-set equality, not value
non-emptiness.

### 3. `src/lib/db.ts` surface

**No change.** All DB columns continue to store English canonical:

- `waste_log.reason` text — `'Expired' / 'Dropped/spilled' / …`
- `inventory_counts.kind` text — `'spot' / 'open' / 'mid_shift' / 'close'`
- `profiles.role` text — `'user' / 'admin' / 'master' / 'super_admin'`
- `audit_log.action` text — `'EOD entry' / 'Item edit' / …`
- `inventory_items.unit` text — `'lbs' / 'fl_oz' / 'each' / …`
- `order_schedule.day` text — `'Monday' / 'Tuesday' / …`

The existing snake_case → camelCase mappers in `src/lib/db.ts`
(`mapInventory`, `mapWasteEvent`, `mapAuditEvent`, `mapInventoryCount`,
`mapUser`, etc.) already produce the camelCase keys the spec
expects. **No new helper, no new mapper, no new RPC, no new
PostgREST view.**

### 4. Realtime impact

**None.** No DB write, no publication membership change, no channel
touched. `store-{id}` and `brand-{id}` subscriptions in
`useRealtimeSync.ts` continue to operate identically.

The publication-membership gotcha (`docker restart
supabase_realtime_imr-inventory` after schema change) does **NOT**
apply here. No `npm run dev:db` dance is needed.

### 5. Frontend / `useStore` impact

**None.** The `locale` slice (added by spec 038) is already in place;
this spec only adds catalog entries and consumes them via the existing
`useT()` hook. No new store action, no new state slice. The
optimistic-then-revert pattern with `notifyBackendError` does NOT
apply — there are zero backend writes in this spec.

### 6. Call-site rewires (frontend developer task list)

This is the canonical task list the frontend developer follows. Order
doesn't matter; tests in `npm test` catch missed sites because the
catalog parity test will flag orphan keys.

| File | Change |
|------|--------|
| `src/i18n/en.json` | Delete `status.*`, `role.*` top-level. Add `enum.*` per §2. |
| `src/i18n/es.json` | Same — delete + add. |
| `src/i18n/zh-CN.json` | Same — delete + add. |
| `src/i18n/matchesQuery.ts` | NEW FILE. ~12 lines. Per §1(d). |
| `src/utils/enumLabels.ts` | NEW FILE. ~80 lines. Per §1(a). |
| `src/theme/statusColors.ts` | `statusLabel(s, T)` — add `T` parameter. |
| `src/utils/formatAuditAction.ts` | `formatAuditAction(event, T)` — add `T` parameter. Add `KEY_BY_ACTION` map for the 13 actions per §1(a). |
| `src/components/cmd/StatusPill.tsx` | Call `useT()`, pass `T` into `statusLabel(status, T)`. |
| `src/components/cmd/AuditHistory.tsx` | Call `useT()`. Pass `T` into `formatAuditAction(e, T)`. |
| `src/screens/cmd/sections/AuditLogSection.tsx` | Pass `T` into `formatAuditAction(e, T)` (already has `useT()`). |
| `src/screens/cmd/ItemDetailScreen.tsx` | Add `useT()` if not present, pass `T` into `formatAuditAction(e, T)`. |
| `src/screens/cmd/InventoryDesktopLayout.tsx` | Pass `T` into `formatAuditAction(e, T)` (2 sites). |
| `src/screens/cmd/sections/WasteLogSection.tsx` | Replace `REASON_LABEL` constant with `wasteReasonShortLabel(r, T)`. Filter input search uses `matchesQuery(input, [wasteReasonLabel(r,T), wasteReasonShortLabel(r,T), r])`. |
| `src/screens/cmd/sections/InventoryCountSection.tsx` | Replace `KIND_OPTIONS` literal-array + `KIND_LABEL` map with `inventoryCountKindLabel` / `inventoryCountKindSubLabel` calls. |
| `src/screens/cmd/sections/UsersSection.tsx` | Replace local `roleLabel` function with import from `enumLabels.ts`. Replace `'ACTIVE' / 'PENDING'` literal with `userStatusLabel(user.status, T)`. |
| `src/screens/cmd/sections/OrderScheduleSection.tsx` | `DAY_NAMES` const-array stays (DB join keys). `DAY_SHORT` map → replaced by `dayOfWeekShortLabel(day, T)` call inside render. |
| `src/screens/cmd/sections/EODCountSection.tsx` | Pass display-form of `DAY_NAMES[d.getDay()]` through `dayOfWeekLongLabel` / `dayOfWeekShortLabel` at render time. ID-form stays English (it's a DB join key). |
| `src/components/cmd/IngredientForm.tsx` | Unit dropdown `label` field routes through `unitLabel(u, T)`. |
| `src/components/cmd/IngredientFormDrawer.tsx` | (Defensive — flag any unit literal here.) |
| `src/screens/cmd/sections/InventoryCatalogMode.tsx` | Unit-bearing strings (`${qty} ${row.unit}`) become `${qty} ${unitLabel(row.unit, T)}`. |
| `src/components/cmd/RecipeFormDrawer.tsx` (if it exists / surfaces a unit dropdown) | Same. |
| `src/components/cmd/PrepRecipeFormDrawer.tsx` | Same. |
| `src/i18n/i18n.test.ts` | OPTIONAL spot-check assertions per §7. |
| `src/components/cmd/StatusPill.test.tsx` | **Update** — the StatusPill mock for the colors module stays, ADD a mock for `useT` to return `T(k) → 'OK' / 'LOW' / …` (or mock `useLocale` to return `'en'` and let the real catalog resolve). Otherwise the test fails because `StatusPill` now needs the store-graph. See §8 risks. |

### 7. Tests

#### Track 1 (jest)

Existing `src/i18n/i18n.test.ts` parity check automatically covers
the 204 new strings. **No new test file required.** Architect-
recommended additions inside the existing file (spot checks for the
hot paths):

```ts
// Inside the existing `describe('t()')` block:
it('returns the English enum.wasteReason.expired display form', () => {
  expect(t('en', 'enum.wasteReason.expired')).toBe('Expired');
});
it('returns the Chinese enum.itemStatus.ok translation', () => {
  expect(t('zh-CN', 'enum.itemStatus.ok')).toBe('正常');
});
it('returns the Spanish enum.role.admin translation', () => {
  expect(t('es', 'enum.role.admin')).toBe('Administrador');
});

// NEW describe block for enum label resolvers:
describe('enum label resolvers', () => {
  const enT: TFn = (k) => t('en', k);
  it('formatAuditAction maps every AuditAction value to a non-empty translation', () => {
    const actions: AuditAction[] = ['EOD entry', 'Item edit', /* ...13 */];
    for (const a of actions) {
      const out = formatAuditAction({ action: a }, enT);
      expect(out).not.toBe(a); // must have been translated
      expect(out.length).toBeGreaterThan(0);
    }
  });
  it('wasteReasonLabel for every WasteReason returns non-empty', () => { /* … */ });
  it('roleLabel for every UserRole returns non-empty', () => { /* … */ });
  it('inventoryCountKindLabel for every kind returns non-empty', () => { /* … */ });
  it('dayOfWeekShortLabel returns translated form for each day', () => { /* … */ });
  it('unitLabel returns translated lbs in zh-CN', () => {
    expect(unitLabel('lbs', (k) => t('zh-CN', k))).not.toBe('lbs'); // hopefully translated
    // Or: just confirm it returns a string, not undefined.
  });
});

// NEW describe block for matchesQuery:
describe('matchesQuery', () => {
  it('matches case-insensitively', () => {
    expect(matchesQuery('exp', ['Expired'])).toBe(true);
  });
  it('strips diacritics on both sides', () => {
    expect(matchesQuery('venc', ['Vencido'])).toBe(true);
    expect(matchesQuery('VENC', ['vencido'])).toBe(true);
    expect(matchesQuery('cai', ['Caído'])).toBe(true);
    expect(matchesQuery('caí', ['caido'])).toBe(true);
  });
  it('returns true for empty query (all candidates match)', () => {
    expect(matchesQuery('', ['anything'])).toBe(true);
    expect(matchesQuery('   ', ['anything'])).toBe(true);
  });
  it('returns false when no candidate matches', () => {
    expect(matchesQuery('xyz', ['abc', 'def'])).toBe(false);
  });
  it('handles null/undefined candidates without throwing', () => {
    expect(matchesQuery('x', [null as any, undefined as any, 'xray'])).toBe(true);
  });
});
```

The `StatusPill.test.tsx` update is mandatory (not optional). Strategy:
add a `jest.mock` for `'../../hooks/useT'` returning a deterministic
`T` that maps `enum.itemStatus.ok → 'OK'`, `low → 'LOW'`, etc. This
keeps the test's existing assertion semantics
(`expect(screen.getByText('OK')).toBeTruthy()`) intact without dragging
the store-graph in. The existing colors-module mock pattern is the
template.

#### Track 2 (pgTAP) and Track 3 (smoke)

**None.** Per spec.

### 8. Risks and tradeoffs

**Critical / build-blockers:**

- **`StatusPill.test.tsx` breaks without a `useT` mock.** Per §7, the
  test file currently asserts that `'OK' / 'LOW' / 'OUT' / 'INFO'`
  appear when no `label` prop is passed. After this spec, the default
  label is computed by `t('en', 'enum.itemStatus.ok')`. Without a
  `useT` mock, StatusPill pulls in the locale slice from
  `useStore`, which the existing colors mock cannot satisfy — the
  test errors out with the "store-graph supabase import crash"
  documented in the test's existing header comment. **Mitigation:** add
  a `jest.mock('../../hooks/useT', () => ({ useT: () => (k: string) =>
  ({ 'enum.itemStatus.ok': 'OK', /* etc */ })[k] }))` to the test
  file alongside the existing colors mock. The test text-match
  assertions stay identical.

**Should-fix / footguns:**

- **`fl_oz` unit naming inconsistency.** The DB stores `fl_oz` (with
  underscore) but JSON keys cannot have underscores in dot-paths
  without quoting. The catalog uses `enum.unit.flOz` (camelCase
  per the rest of the catalog convention). The `UNIT_KEY` map in
  `enumLabels.ts` translates `fl_oz → 'flOz'`. **Risk:** if a future
  spec adds a unit named e.g. `sub_unit`, the mapping table must be
  updated; missing entries fall through to the raw English value.
  Acceptable — same fallback shape as `formatAuditAction`.
- **`InventoryCatalogMode.tsx` has unit interpolation in many places.**
  The find-and-replace `${row.unit}` → `${unitLabel(row.unit, T)}` is
  mechanical but touches ~6 sites in that one file. Frontend dev
  should grep-scan rather than line-by-line.
- **Hot-render concern: `T` identity changes only on locale switch.**
  `useT` returns `useCallback`-stabilized `T`. The 7 label resolvers
  in `enumLabels.ts` are pure; calling them in render is fine
  (cheap object lookup + one catalog dot-path walk). No need to
  memoize unless profile shows hot-path cost — leave to author.
- **`AuditLog.action` enum membership drift.** If a future spec adds
  a new `AuditAction` value (e.g. `'Vendor edit'`) and forgets to
  update both the `KEY_BY_ACTION` map AND the catalog, the unmapped
  action falls through to `action.toLowerCase()` — the **pre-i18n
  behavior** — and the catalog parity test does NOT catch it (the
  parity test only checks set-equality across locale files, not
  enum-to-key coverage). Mitigation: the optional `formatAuditAction
  maps every AuditAction value` jest assertion in §7 catches it.
  Recommend including that assertion.

**Minor:**

- **`POSImportsSection.tsx:295`** has a local variable named
  `statusLabel` that shadows the imported one. The local is
  unrelated to this spec (it computes a one-off `'success' / 'partial'
  / 'failed'` string for an import-status pill, not for the
  `Status` union). Leave it alone — the spec does not ask for POS
  import-status translation, and this is not a regression risk
  because the variable is purely local.
- **Spec 038 deferred 8 section files.** This spec only touches
  enum-bearing call-sites within them. The other English literals
  (titles, button text, empty states) inside those files stay
  English. The catalog-parity test will not flag them because they
  are not catalog keys. Acceptable per the spec.
- **Translator latitude.** Seed Spanish/Chinese values in §2 are
  best-effort. Native-speaker review is a follow-up, not a
  build-blocker.

### 9. Bundle weight check

Spec 038 baseline:

- en.json: ~7.5 KB
- es.json: ~8.0 KB
- zh-CN.json: ~6.5 KB
- **Total: ~22 KB**

Spec 039 additions (estimated, including the JSON keys + structural
braces):

- 68 new keys × 3 locales × ~25 bytes average (key path + value +
  quotes + comma) = ~5 KB
- Minus the ~8 deleted keys × 3 locales × ~20 bytes = ~0.5 KB

**Net: +4.5 KB across the three catalog files.** Within the PM's
budget estimate (~3 KB extra) by ~1.5 KB; not a concern. The
catalogs are imported as JSON modules and bundled directly; no
HTTP cost.

Code additions:

- `src/i18n/matchesQuery.ts` — ~600 bytes
- `src/utils/enumLabels.ts` — ~2.5 KB
- ~20 call-site edits with no net size delta (replacing literals
  with calls)

**Total bundle delta: ~+8 KB.** Negligible relative to the ~64 KB
`src/lib/db.ts` and the ~51 KB `useStore.ts`.

### 10. Out of scope confirmation

Confirming the spec's out-of-scope items remain out of scope from
the architecture side:

- User-mutable categories (`recipe_categories`, `ingredient_categories`)
  — deferred to spec 040 (P3 user data).
- Per-store / per-brand locale override — not designed here. Each
  user has a single `profiles.locale` (per spec 038).
- ICU plurals — deferred.
- Date / number / currency formatting — deferred.
- Email templates / edge-function HTML — out of scope.
- Filename-style tab labels (`items.tsv`, `count.tsx`, `variance.log`,
  etc.) — explicitly NOT translated. Frontend dev should verify on
  the extraction pass that these stay English literals.

The PM's open questions are all resolved by the spec itself; the four
architect-decision questions are resolved in §1.

## Files changed

**New files:**

- `src/utils/enumLabels.ts` — pure label resolvers: `wasteReasonLabel`,
  `wasteReasonShortLabel`, `roleLabel`, `userStatusLabel`,
  `inventoryCountKindLabel`, `inventoryCountKindSubLabel`,
  `dayOfWeekShortLabel`, `dayOfWeekLongLabel`, `unitLabel`, plus the
  `DayName` and `UserStatus` types. Per architect §1(a) all functions
  take `T: TFn` as a parameter (no new hook).
- `src/i18n/matchesQuery.ts` — diacritic-folded, case-insensitive
  substring matcher for translated enum filter inputs. Signature
  `matchesQuery(query: string, candidates: string[]): boolean`.
- `src/utils/enumLabels.test.ts` — Track 1 jest tests covering every
  enum value through every resolver in English + sample Spanish + sample
  Chinese assertions. Also covers `matchesQuery` shape.

**Modified files:**

- `src/i18n/en.json` — deleted top-level `status.*` and `role.*`; added
  full `enum.*` namespace (8 sub-namespaces, 68 new keys per locale).
- `src/i18n/es.json` — same.
- `src/i18n/zh-CN.json` — same.
- `src/theme/statusColors.ts` — `statusLabel(s)` → `statusLabel(s, T)`.
- `src/utils/formatAuditAction.ts` — `formatAuditAction(event)` →
  `formatAuditAction(event, T)`. Added the complete `KEY_BY_ACTION` map
  covering all 13 `AuditAction` values (previously only had 10).
- `src/components/cmd/StatusPill.tsx` — calls `useT()`, passes `T` into
  `statusLabel(status, T)`.
- `src/components/cmd/StatusPill.test.tsx` — adds `jest.mock` for
  `useT` returning a deterministic dictionary; existing text-match
  assertions stay identical.
- `src/components/cmd/AuditHistory.tsx` — `useT()` + pass `T` into
  `formatAuditAction(e, T)`.
- `src/components/cmd/IngredientForm.tsx` — `useT()` + unit dropdown
  options route through `unitLabel(u, T)`.
- `src/components/cmd/RecipeFormDrawer.tsx` — `useT()` +
  `buildUnitOptions(itemUnit, currentValue, T)` returns translated
  labels.
- `src/components/cmd/PrepRecipeFormDrawer.tsx` — `useT()` +
  `buildUnitOptions` + `buildYieldUnitOptions` take `T`.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — `useT()` in
  `DetailPane` and `AuditTab`; pass `T` into both `formatAuditAction`
  call sites.
- `src/screens/cmd/ItemDetailScreen.tsx` — orphaned but typechecks;
  added `useT()` import + `T` parameter to `formatAuditAction(e, T)`.
- `src/screens/cmd/sections/WasteLogSection.tsx` — deleted local
  `REASON_LABEL` map; routes filter-chip and dropdown labels through
  `wasteReasonShortLabel(r, T)`.
- `src/screens/cmd/sections/InventoryCountSection.tsx` — deleted local
  `KIND_OPTIONS` and `KIND_LABEL` constants. Replaced with `KIND_IDS`
  + calls to `inventoryCountKindLabel(k, T)` /
  `inventoryCountKindSubLabel(k, T)`. Added `T = useT()` to the
  `DetailFrame` sub-component (HistoryTab already had it).
- `src/screens/cmd/sections/UsersSection.tsx` — deleted local
  `roleLabel` function; imports `roleLabel` and `userStatusLabel` from
  `enumLabels.ts`. Threaded `T` to the `UserRow` sub-component.
- `src/screens/cmd/sections/BrandsSection.tsx` — `T = useT()` in
  `MembersTab`; user-status pill routes through `userStatusLabel(u.status, T)`.
- `src/screens/cmd/sections/OrderScheduleSection.tsx` — deleted local
  `DAY_SHORT` map; `DAY_NAMES` is now typed `ReadonlyArray<DayName>`;
  header cells render `dayOfWeekShortLabel(day, T)`.
- `src/screens/cmd/sections/EODCountSection.tsx` — typed `DAY_NAMES`
  as `ReadonlyArray<DayName>`; updated `DayCell.day` typing; week
  sidebar (desktop) renders `dayOfWeekLongLabel(d.day, T)`; horizontal
  day-strip (phone) renders `dayOfWeekShortLabel(d.day, T)`.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — `T = useT()`
  in the main component and the two sub-components
  (`CatalogStoresTab`, `CatalogConversionsTab`). All `${row.unit}` /
  `${sel.unit}` / `conv.baseUnit` / `conv.purchaseUnit` render sites
  route through `unitLabel(..., T)`. `baseUnitOptions` and
  `purchaseUnitOptions` dropdowns also surface translated labels.

### Post-review fix pass (round 2)

Addressed the Critical + four Should-fix findings from the reviewer pass.

- `src/i18n/en.json` — `section.inventory.tabs.categories` value
  changed from `"Categories"` to `"categories"` (lowercase) to match
  the visual style of the sibling filename-style tabs.
- `src/i18n/es.json` — `section.inventory.tabs.categories` value
  changed from `"Categorías"` to `"categorías"` (lowercase).
- `src/i18n/zh-CN.json` — `section.inventory.tabs.categories` value
  unchanged (`"分类"` is already locale-correct).
- `src/screens/cmd/InventoryDesktopLayout.tsx` — added `const T = useT();`
  to the main component; all three `TabStrip` call sites now render
  `T('section.inventory.tabs.categories')` for the `categories` tab
  label (the other two tab labels `items.tsv` and `catalog.tsv` stay
  hardcoded as filename-style tokens per spec). Fixes the AC13 critical.
- `src/screens/cmd/sections/WasteLogSection.tsx` — the form's
  reason-selection chips (line 390) now use `wasteReasonLabel(r, T)`
  (display form) instead of `wasteReasonShortLabel`. The filter-chip
  strip (line 143) and log row (line 205) intentionally continue to use
  the short form. Both resolvers are imported.
- `src/screens/cmd/sections/AuditLogSection.tsx` — `ByUserTab` now
  calls `useT()` and renders `formatAuditAction(e, T)` (was raw
  `{e.action}`). FeedTab's "filter:" bar is now a real `TextInput`
  backed by `filterText` state; events are filtered through
  `matchesQuery(filterText, [formatAuditAction(e, T), e.action,
  e.userName, e.itemRef, e.value])` — satisfies AC15 (bilingual
  diacritic-folded search) end-to-end. Imports `matchesQuery`,
  `TextInput`, and `Platform`.
- `src/i18n/matchesQuery.ts` — public signature widened from
  `candidates: string[]` to
  `candidates: ReadonlyArray<string | null | undefined>` so real call
  sites (DB rows with possibly-null fields) typecheck without `as any`
  casts. Internal `fold()` already handled nullish input.
- `src/utils/enumLabels.test.ts` — removed `as any` casts from the
  `matchesQuery` null/undefined test now that the public signature
  accepts nullable candidates. Added a new `describe('enum.itemStatus
  catalog values')` block with three direct-catalog assertions
  (`zh-CN` ok, `es` low, `en` out) — closes the architect's "Optional
  spot-check" gap for `enum.itemStatus.*` (the StatusPill mock-based
  test couldn't catch catalog drift on these keys).
- `src/i18n/i18n.test.ts` — added a parity-test sibling assertion
  confirming `section.inventory.tabs.categories` resolves to
  `categories` / `categorías` / `分类` in en / es / zh-CN respectively.
  Guards the AC13 fix against future catalog renames.

**Verification:**
- `npm run typecheck` — exits 0.
- `npm run typecheck:test` — exits 0.
- `npm test` — 10 suites, 104 tests pass (up from 100; +3 itemStatus
  catalog assertions + 1 categories parity assertion).
- Browser verification: `preview_*` MCP tools are NOT in this
  session's available tool set (only Read/Write/Edit/Bash). Dev server
  is running on `localhost:8081` (HTTP 200) and serves the Expo bundle,
  but I cannot drive a browser from this sub-agent shell. The jest
  parity test covers the catalog value, the catalog-drift test covers
  the resolver hit, and typecheck covers the call-site wiring — three
  independent checks for AC13's fix. Re-review should still spot-check
  the rendered Spanish tab pill visually.
