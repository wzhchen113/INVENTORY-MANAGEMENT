# Spec 040: Multi-language support — Phase 3 (user-entered data translations)

Status: READY_FOR_REVIEW

## User story

As a store manager who has switched the admin app to Spanish (P1) and now
sees status enums, waste reasons, and audit verbs in Spanish (P2), I want
the *names of my actual ingredients, recipes, prep recipes, and
categories* to render in Spanish too — without me re-typing every name —
so that the app feels usable in my preferred language end-to-end, not
just in the chrome.

Concretely, when I:

- Open Inventory in Spanish mode, I see `Detergente` not `Detergent`.
- Open Recipes in Chinese mode, I see `汉堡` not `Burger`.
- Type a search query in my locale (`detergente`), the row whose
  canonical English `name` is `Detergent` matches.
- Sort by name in Spanish mode, rows order by their Spanish names.
- Create a new ingredient called `Yellow Onion` in English, the form
  auto-suggests `Cebolla Amarilla` / `黄洋葱` for the other locales and
  lets me correct either suggestion before I save.

For rows that don't yet have a translation, the canonical English name
renders silently — no `[untranslated]` tag, no placeholder.

## Acceptance criteria

### Schema

- [ ] A single migration adds `i18n_names jsonb not null default '{}'`
      to each of these five tables (confirmed by reading the schema —
      see §Project-specific notes):
      `catalog_ingredients`, `recipes`, `prep_recipes`,
      `recipe_categories`, `ingredient_categories`.
- [ ] Migration timestamp is `>= 20260517000000` (no clash with
      `20260516000000_profiles_locale.sql`, the P1 migration).
- [ ] Migration is additive only — no rewrites of existing rows beyond
      the `not null default '{}'` backfill that the `add column`
      statement performs atomically. No new RLS policies needed
      (`i18n_names` rides on the parent table's existing row-level
      grants — confirmed in §Project-specific notes).
- [ ] No CHECK constraint enforcing the shape of `i18n_names` beyond
      the default — JSONB validation at write-time is enforced by the
      edge function and the form layer. (Architect may upgrade to a
      check constraint if cheap; out of scope to require it.)
- [ ] pgTAP coverage asserts each of the five tables has the
      `i18n_names jsonb not null default '{}'` shape — one assertion
      block per table, parametrized or repeated.

### Helper module

- [ ] NEW file `src/i18n/localizedName.ts` exports a single function
      with this shape:
      ```ts
      export function getLocalizedName(
        row: { name?: string | null; menu_item?: string | null; i18n_names?: Record<string, string> | null },
        locale: LocaleCode
      ): string
      ```
      Reads `row.i18n_names?.[locale]`. If absent or empty, falls back
      to the canonical English column — `row.name` for four of the
      five tables, `row.menu_item` for `recipes`. The exact
      column-resolution rule is the architect's call; spec mandates
      the silent-English-fallback semantics, not the exact signature.
- [ ] NEW file `src/hooks/useLocalizedName.ts` (or co-located in
      `src/i18n/`) exports a `useLocalizedName(row)` hook that pulls
      the active locale from the same Zustand slice `useT()` does (P1
      §1) and calls `getLocalizedName(row, locale)`. Re-renders flow
      through Zustand subscription exactly like `useT()`.
- [ ] Jest test at `src/i18n/localizedName.test.ts`:
      - `getLocalizedName({name: 'Detergent', i18n_names: {es: 'Detergente'}}, 'es')` → `'Detergente'`.
      - `getLocalizedName({name: 'Detergent', i18n_names: {}}, 'es')` → `'Detergent'` (silent fallback).
      - `getLocalizedName({name: 'Detergent', i18n_names: null}, 'es')` → `'Detergent'`.
      - `getLocalizedName({menu_item: 'Burger', i18n_names: {'zh-CN': '汉堡'}}, 'zh-CN')` → `'汉堡'` (recipes column resolution).
      - `getLocalizedName({name: 'Detergent'}, 'en')` → `'Detergent'` (English mode never reads `i18n_names`).

### Edge function — `translate-on-save`

- [ ] NEW edge function at `supabase/functions/translate-on-save/`
      (architect may rename, but the function bundle is new and
      separate from existing functions).
- [ ] `verify_jwt = true` in [supabase/config.toml](../supabase/config.toml)
      — this is an admin-only path, no service-token shortcut.
- [ ] Bound to `callEdgeFunction` in `src/lib/auth.ts` per the
      project convention (CLAUDE.md "Edge function calls go through
      `callEdgeFunction`"). Returns `{ data: any; error: string | null }`.
- [ ] Request shape: `{ text: string, sourceLocale: 'en', targetLocales: ('es' | 'zh-CN')[] }`.
- [ ] Response shape: `{ translations: { es?: string; 'zh-CN'?: string } }`.
- [ ] Calls DeepL `POST https://api-free.deepl.com/v2/translate` with
      `auth_key=$DEEPL_API_KEY`, `text=<text>`, `source_lang=EN`,
      `target_lang=<ES|ZH>`. (DeepL's locale codes: `ES` for Spanish,
      `ZH` for Chinese. Architect to confirm whether `zh-CN` maps to
      `ZH` or `ZH-HANS` against the current DeepL API spec.)
- [ ] `DEEPL_API_KEY` is loaded from `Deno.env.get('DEEPL_API_KEY')`.
      The user obtains the key from DeepL's free-tier signup and
      stores it as a Supabase secret out-of-band (`supabase secrets
      set DEEPL_API_KEY=...`); see §Out of scope.
- [ ] On DeepL API failure, the function returns
      `{ error: 'translation_unavailable' }` (or similar structured
      string) and the form falls through to a "could not auto-fill,
      please type the translation manually" state — the save itself
      is NOT blocked. (Architect to wire the fallback shape.)
- [ ] Caller authorization: edge function uses `requireAdminCaller()`
      with `ADMIN_ROLES = new Set(['admin', 'master', 'super_admin'])`
      per CLAUDE.md "Edge function role gates mirror
      `auth_is_privileged()`".
- [ ] If the function renders any HTML (it shouldn't — JSON only),
      apply `escapeHtml()` per the CLAUDE.md inline-helper rule.
      Otherwise the rule is moot.

### Forms (write sites — auto-fill + manual override)

- [ ] In every create/edit form for the FOUR in-scope table types
      (see below), when the user types into the canonical English
      `name` (or `menu_item`) field and either tabs out or pauses
      for >500 ms, the form invokes `translate-on-save` with the
      current text and the two non-English target locales,
      populating two manual-override input fields below the
      canonical one labeled "Español" and "中文 (简体)".
- [ ] The user can edit, clear, or accept each suggested translation
      before saving. The save payload sends `i18n_names` as
      `{ es: <override-or-suggestion>, 'zh-CN': <override-or-suggestion> }`,
      omitting keys that the user explicitly cleared.
- [ ] If the canonical English field is empty on submit, the form
      blocks save (existing validation — no change).
- [ ] If `translate-on-save` is in-flight when the user clicks Save,
      the form either (a) awaits the in-flight call and includes its
      result, or (b) saves with whatever overrides the user typed
      and any suggestions already returned. Architect to pick;
      acceptable that this is implementation detail not user-visible.
- [ ] Forms touched (sample; the architect should expand if needed):
      - `src/components/cmd/IngredientForm.tsx` →
        `catalog_ingredients.i18n_names`
      - `src/components/cmd/IngredientFormDrawer.tsx` → same as above
        (consolidated entry point)
      - `src/components/cmd/RecipeFormDrawer.tsx` →
        `recipes.i18n_names` (canonical column = `menu_item`)
      - `src/components/cmd/PrepRecipeFormDrawer.tsx` →
        `prep_recipes.i18n_names`
      - `src/screens/cmd/sections/CategoriesSection.tsx` (the
        ingredient-categories CRUD pane) →
        `ingredient_categories.i18n_names`.
        **`recipe_categories.i18n_names` is OUT OF SCOPE for this
        spec's UI write path** — there is no Cmd UI recipe-categories
        management surface today (only the frozen legacy
        `src/screens/AdminScreens.tsx`, which agents must not extend
        per CLAUDE.md). The DB column, store action
        (`setRecipeCategoryI18nNames`), and `db.ts` helper
        (`updateRecipeCategoryI18n`) remain in scope as
        infrastructure-only so a future Cmd UI surface can wire the
        Spanish/Chinese inputs without further backend changes. Same
        shape as Spec 038's AC-CHROME-5/6 gap and Spec 013's AC9 gap.

### Read sites — list, detail, search, sort

- [ ] Every list display of the five entity types uses
      `useLocalizedName(row)` for the visible name column. Sample
      sites (architect to expand by grepping for the existing
      `.name` / `.menu_item` render):
      - `src/screens/cmd/sections/InventoryCatalogMode.tsx`
      - `src/screens/cmd/InventoryDesktopLayout.tsx` (per-store list)
      - `src/screens/cmd/sections/RecipesSection.tsx`
      - `src/screens/cmd/sections/PrepRecipesSection.tsx`
      - `src/screens/cmd/sections/CategoriesSection.tsx`
      - Any detail header / drawer title showing the same fields.
      - Filter dropdowns that show category names (recipes filter by
        category, inventory filter by ingredient category).
- [ ] Search input matching in each section's existing filter logic
      consults BOTH the localized name AND the canonical English
      `name` / `menu_item`. Implementation hint: pass both strings
      into `matchesQuery()` from P2 (`src/i18n/matchesQuery.ts`):
      ```ts
      matchesQuery(input, [
        getLocalizedName(row, locale),  // localized
        row.name ?? row.menu_item,      // canonical English fallback
      ])
      ```
      This preserves P2's diacritic-folding semantics and matches the
      Q4 spec: type `detergente` in Spanish mode → matches the
      canonical `Detergent` row.
- [ ] Sort-by-name in each section uses the localized name as the
      sort key. Per Q5 the implementation path is **client-side**
      for v1 (all five entity types are already fetched in full into
      the Zustand store; sorts happen post-fetch in section
      components, not via PostgREST `order=`). Sort comparator:
      ```ts
      const a = getLocalizedName(rowA, locale);
      const b = getLocalizedName(rowB, locale);
      return a.localeCompare(b, locale);
      ```
      For `zh-CN`, `localeCompare` uses the JS engine's default
      collator — which is codepoint order on Node and browsers
      without ICU. This is the documented Known Limitation
      (§Risks). Pinyin collation is out of scope for v1.
- [ ] If any read site currently does a server-side sort (rare;
      architect to verify), document the swap from
      `order=name.asc` to a client-side resort after the locale
      gate or omit; the spec accepts either, but the choice is
      recorded in the architect's design doc.

### Realtime

- [ ] No new realtime publication membership. The five tables are
      already in the `supabase_realtime` publication (or their
      updates already reach the existing `store-{id}` / `brand-{id}`
      channels). The `i18n_names` column rides on the existing
      per-table publication automatically — confirmed by reading
      [supabase/migrations/20260502190000_realtime_publication.sql](../supabase/migrations/20260502190000_realtime_publication.sql)
      and [supabase/migrations/20260514140000_realtime_publication_tighten.sql](../supabase/migrations/20260514140000_realtime_publication_tighten.sql).
- [ ] Same realtime-publication gotcha as ever — no schema-membership
      change means **no `docker restart supabase_realtime_imr-inventory`
      step needed on apply.** Architect to confirm; if any of the
      five tables turns out NOT to be in the publication today, the
      gotcha re-applies and the spec scope grows.

### Concurrency model

- [ ] Whole-row last-write-wins per Q6. Two admins simultaneously
      editing the same ingredient's names: the second save clobbers
      the first, including the `i18n_names` field. Documented under
      §Risks. No new RPC, no optimistic-lock token.

### Verification (test tracks)

- [ ] **Track 1 (jest).** `src/i18n/localizedName.test.ts` per
      §Helper module above. Additionally, a small fixture-based
      catalog-parity-style assertion that the five `i18n_names`
      JSONB shapes round-trip consistently through `getLocalizedName`
      (one fixture row per table, asserts the helper picks the right
      canonical column).
- [ ] **Track 2 (pgTAP).** A new test file under `tests/db/` (per
      [tests/README.md](../tests/README.md)) asserts each of the
      five tables has `i18n_names jsonb not null default '{}'`.
      Shape: `information_schema.columns` query, five
      `is(...)` assertions.
- [ ] **Manual smoke (web + native, both).**
      1. Cycle to Spanish (per P1 §1 chrome-language picker).
      2. Open Inventory → Add Item → type `Test Item` in the canonical
         field. Pause; confirm the Spanish-suggestion input fills with
         a DeepL result (e.g. `Artículo de prueba`).
      3. Save. Confirm the new row in the Inventory list renders as
         the Spanish translation.
      4. Sort by name in Spanish mode; confirm the new row sorts
         under `A` not `T`.
      5. Type `prueba` in the search; confirm the row matches.
      6. Switch to English; confirm the row renders as `Test Item`.
      7. Repeat steps 2–6 for one Recipe, one Prep Recipe, and one
         Category.

## In scope

- Schema migration adding `i18n_names jsonb not null default '{}'`
  to the five tables enumerated above.
- `getLocalizedName` helper + `useLocalizedName` hook.
- `translate-on-save` edge function calling DeepL with the
  `DEEPL_API_KEY` env-var contract.
- Form-side auto-fill + manual override UI on the four form
  components + the (ingredient-categories) CRUD pane of
  `CategoriesSection`.
- Read-side rewires in every list, detail header, filter dropdown,
  search input, and sort comparator that today consumes
  `row.name` / `row.menu_item` for the five entity types.
- Track 1 jest + Track 2 pgTAP coverage per §Verification.
- Manual smoke per §Verification.

## Out of scope (explicitly)

- **`recipe_categories` UI write path (Cmd UI).** No Cmd UI surface
  for managing recipe categories exists today — the only management
  UI lives in the frozen legacy `src/screens/AdminScreens.tsx`,
  which agents must not extend per CLAUDE.md. Same shape as Spec
  038's AC-CHROME-5/6 gap and Spec 013's AC9 gap. The DB column
  (`recipe_categories.i18n_names`), store action
  (`setRecipeCategoryI18nNames`), and `db.ts` helper
  (`updateRecipeCategoryI18n`) all ship in this spec as
  infrastructure-only so a future Cmd UI surface for recipe-category
  management can wire the Spanish / Chinese inputs as a simple
  call-site change without further backend work. Until that UI
  lands, `recipe_categories.i18n_names` stays `{}` on the write
  path; read paths still fall back to the canonical English name
  per the silent-fallback rule. See "Known follow-up work" below.
- **Vendor names, brand names, store names.** Proper nouns — Q7
  explicitly excludes them. A future spec can revisit if a customer
  asks.
- **Free-text notes fields** — waste-log notes, item notes,
  audit-log free text. Q7 explicitly excludes them. These are
  long-form user-authored text where translation quality and cost
  trade-offs differ from short labels; deferred.
- **Date / number / currency localization.** P1's `t()` infra does
  not yet handle ICU number / date plumbing; that is a separate
  follow-up. Out of scope for spec 040.
- **Per-field translation history / audit log.** No `i18n_names_audit`
  table, no row-level history of who set which translation when.
  The whole-row audit log (if any) sees the JSONB column as a
  single field. Defer.
- **Bulk back-translation of existing rows.** When this spec ships,
  every existing `catalog_ingredients` / `recipes` / `prep_recipes` /
  `recipe_categories` / `ingredient_categories` row has
  `i18n_names = '{}'`. The silent-English fallback covers those rows
  transparently. Filling them in for existing data is a separate
  one-off operational task (someone runs a script against DeepL
  for the entire backfill); it is NOT a code change in this spec
  and does not need to gate ship.
- **DeepL provider abstraction / fallback to another provider.** Per
  the user's direction, hard-code DeepL in v1. No `TranslationProvider`
  interface, no second-vendor failover. If DeepL is down, the form
  shows manual override fields only; save still works.
- **Adding a 4th language.** Out of scope for spec 040. The JSONB
  shape makes adding `pt-BR` (etc.) a zero-migration operation —
  but the form, the helper, the locale picker, and the DeepL call
  all need broadening, and that work belongs in a follow-up spec.
- **Server-side SQL sort by localized name.** Per Q5 the sort
  happens client-side. Architect may upgrade to a SQL
  `ORDER BY coalesce(i18n_names->>'<locale>', name)` expression
  *only if* a section is found to use server-side pagination AND
  sort — in which case the SQL form belongs in spec 040 as a small
  extension, not a separate spec.
- **Translating the canonical English `name` itself.** The English
  column is the source of truth — never overwritten by DeepL or by
  the form's manual-override fields. Only `i18n_names->>'es'` and
  `i18n_names->>'zh-CN'` are written.
- **Obtaining the DeepL API key.** The user signs up at
  https://www.deepl.com/pro-api and stores the key as a Supabase
  secret out-of-band. The spec defines the env-var contract +
  the edge function code shape; it does not script the signup.
- **Translation glossary / domain-specific term overrides** (e.g.
  forcing DeepL to render `prep` as `prep` not `preparación`).
  DeepL supports glossaries; not for v1.
- **Caching translations to dodge DeepL quota.** No in-memory or
  table cache of `(en_text → es_text)` mappings. Each save burns
  one DeepL call per target locale. Quota math: 500K chars/month
  ÷ ~20 chars per name × 2 target locales = ~12,500 saves/month
  free-tier ceiling. Documented under §Risks.
- **`app.json` slug.** Not touched. Per CLAUDE.md, the slug stays
  `towson-inventory` pending explicit user approval.

## Open questions resolved

- Q1 (storage): JSONB column per row. `i18n_names jsonb not null
  default '{}'` on the parent table. Reads: `coalesce(i18n_names->>'<locale>', name)`.
- Q2 (translation source): Hybrid auto-fill on save + manual
  override. Edge function calls DeepL, form shows the suggestion
  in an editable field, user can correct before saving.
- Q2.5 (provider): DeepL free tier. `DEEPL_API_KEY` stored as a
  Supabase secret; edge function calls `POST /v2/translate`.
- Q3 (fallback): Silent English fallback. No tag, no placeholder.
- Q4 (search): Current locale + English fallback, via
  `matchesQuery(input, [localized, canonical])` reusing P2's helper.
- Q5 (sort): Sort by current-locale name, client-side. zh-CN
  collation falls back to codepoint sort (Known Limitation).
- Q6 (realtime concurrency): Whole-row last-write-wins. Documented
  small clobber risk; no new RPC.
- Q7 (entity scope): YES — catalog ingredients, recipes (menu
  items), prep recipes, recipe categories, ingredient categories.
  NO — vendors, brands, stores, free-text notes.

## Known follow-up work

- **Recipe-categories management UI in Cmd UI.** When a Cmd UI
  recipe-categories management surface is built (currently only in
  the frozen legacy `src/screens/AdminScreens.tsx` — out of scope
  per CLAUDE.md), wire `setRecipeCategoryI18nNames` + the new
  Spanish / Chinese input fields the same way `CategoriesSection`
  wires ingredient categories. All backend plumbing (column, store
  action, db.ts helper) is already in place from this spec; the
  follow-up is a pure UI change. Matches the resolution pattern
  used for Spec 038's AC-CHROME-5/6 gap and Spec 013's AC9 gap.

## Open questions for architect (decision points, not blockers)

- **OQ-A1: Sub-phasing.** This spec is heavy — schema + helper +
  edge function + DeepL plumbing + ~15 read-site rewires + ~5
  form-site rewires + tests across two tracks. The architect
  should consider whether to ship in sub-phases:
  - **P3a:** schema migration + `getLocalizedName` helper +
    `useLocalizedName` hook + every read-site rewire (lists,
    details, filters, search) + Track 1 jest helper test +
    Track 2 pgTAP column-shape test. Search/sort wired against
    the helper. No form changes — forms still write only the
    canonical column, so `i18n_names` stays `{}` for new rows
    until P3b. The silent-English fallback means everything still
    *renders* correctly.
  - **P3b:** `translate-on-save` edge function + DeepL env-var
    contract + form-side auto-fill + manual override fields on
    all five form sites + manual smoke. After P3b ships, new
    rows get translations populated; existing rows still rely
    on the silent fallback.
  - **P3c (deferred to a separate spec or rolled in):** Bulk
    back-translation script for existing data. Out of scope per
    §Out of scope above, but the architect may surface this as
    a one-off operational task once P3b is live.
  The architect should pick P3a+P3b as one spec or split into
  two and call it out in the design doc. The user (PM) defers
  to the architect's call.

- **OQ-A2: Edge function invocation path (DB-trigger vs
  client-initiated).** PM-recommended path is **client-initiated**:
  form submits → store action → `callEdgeFunction('translate-on-save')`
  → returns suggestions → form merges into `i18n_names` payload →
  DB upsert via `src/lib/db.ts`. This follows the existing pattern
  (`send-invite-email`, `pwa-catalog`) and lets the form show a
  "translating..." spinner. The alternative — a Postgres trigger
  using `pg_net` to invoke the edge function on insert/update —
  would hide latency from the form and add `pg_net` + service-token
  plumbing complexity. Architect to confirm or override; PM
  recommends client-initiated.

- **OQ-A3: DeepL target-lang code for `zh-CN`.** DeepL has
  historically accepted `ZH` for simplified Chinese; the current
  API may have moved to `ZH-HANS` / `ZH-HANT`. Architect to verify
  against the live DeepL API docs at design time and pin the
  exact code.

- **OQ-A4: Form debounce strategy.** The auto-fill trigger fires
  on tab-out or pause >500 ms (per §Forms). Architect to confirm
  exact UX: do we hit DeepL on every keystroke (cost), only on
  blur (latency for the user who tabs immediately after typing),
  or on a debounce timer (compromise). PM proposes blur OR
  500 ms-debounced pause, whichever fires first.

- **OQ-A5: SQL-side helper.** Spec proposes client-side sort and
  read-time fallback (`getLocalizedName`). A SQL-side helper —
  `public.localized_name(row, locale)` returning
  `coalesce(i18n_names->>locale, name)` — would let server-side
  sorts work cleanly if a future section needs them. Architect
  may add this as a free-rider migration; PM does not require it
  for v1.

## Dependencies

- Spec 038 (P1) — `src/i18n/index.ts`, `src/hooks/useT.ts`, three
  catalog JSONs, the `useStore` locale slice, the locale picker
  in chrome. P3 reuses every one.
- Spec 039 (P2) — `src/i18n/matchesQuery.ts`. P3's search reuses
  it; the helper's diacritic-folding behavior is essential for
  the Spanish search UX.
- DeepL free-tier account + API key (user provides out-of-band;
  stored as Supabase secret `DEEPL_API_KEY`).
- Existing Supabase edge function infra + `callEdgeFunction`
  helper at `src/lib/auth.ts` per CLAUDE.md.
- Existing realtime publication membership for the five tables
  (architect to verify on read).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI sections under
  `src/screens/cmd/sections/`. Forms under `src/components/cmd/`.
  No legacy admin surface — spec 025 deleted it.
- **Per-store or admin-global:** The five translatable tables
  split:
  - `catalog_ingredients` — brand-scoped (per multi-brand-tenancy
    spec 012).
  - `recipes`, `prep_recipes` — store-scoped via `store_id`.
  - `recipe_categories`, `ingredient_categories` — global today
    (no `store_id` or `brand_id` column; super-admin-managed per
    spec 013 and the recipe_categories super_admin RLS migration).
  `i18n_names` is per-row in all five cases — it inherits whatever
  RLS the parent row has. No new policies needed; the column rides
  on existing row-level grants. Architect to spot-check.
- **Realtime channels touched:** `store-{id}` (for `recipes`,
  `prep_recipes`) and `brand-{id}` (for `catalog_ingredients`).
  `recipe_categories` and `ingredient_categories` may live on a
  global / fan-out channel or on the same brand channel depending
  on their current realtime wiring — architect to verify against
  [supabase/migrations/20260514140000_realtime_publication_tighten.sql](../supabase/migrations/20260514140000_realtime_publication_tighten.sql).
  **No publication-membership change** is part of this spec, so
  no realtime-slot re-snapshot is required on apply.
- **Migrations needed:** YES — one new migration adding
  `i18n_names jsonb not null default '{}'` to five tables.
  Timestamp slot: `20260517000000_i18n_names_p3.sql` or later
  (verified no clash with the latest existing migration,
  `20260516000000_profiles_locale.sql`).
- **Edge functions touched:** ONE NEW — `translate-on-save`
  (architect may rename). `verify_jwt = true`. No existing edge
  function is modified.
- **Web/native scope:** Both. Forms and lists run on both web
  (Vercel) and native (EAS). No web-only or native-only
  carve-outs.
- **Schema confirmation (read before writing the migration):**
  - `catalog_ingredients`:
    [supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:34-47](../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql)
    — canonical column is `name`.
  - `recipes`:
    [supabase/migrations/20260405000759_init_schema.sql:71-78](../supabase/migrations/20260405000759_init_schema.sql)
    — canonical column is **`menu_item`**, not `name`. This is
    the only one of the five with a non-`name` canonical column.
    The `getLocalizedName` helper must handle this.
  - `prep_recipes`:
    [supabase/migrations/20260405000759_init_schema.sql:89-99](../supabase/migrations/20260405000759_init_schema.sql)
    — canonical column is `name`.
  - `recipe_categories`:
    [supabase/migrations/20260424211732_recover_undeclared_tables.sql:24-28](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)
    — canonical column is `name`.
  - `ingredient_categories`:
    [supabase/migrations/20260424211732_recover_undeclared_tables.sql:31-35](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)
    — canonical column is `name`.

## Risks

- **DeepL quota.** 500K chars/month free tier. At ~20 chars/name
  × 2 target locales = ~12,500 saves/month ceiling. The brand's
  current catalog is well under this for normal-use saves, but a
  bulk import (e.g. adding 1,000 catalog ingredients in a day)
  could exhaust the quota. The form-side falls back to manual
  override on DeepL failure, so saves keep working — but
  suggestions stop appearing. No alerting on quota threshold in
  v1.
- **Whole-row last-write-wins clobber.** Two admins editing the
  same row's names simultaneously: the second save overwrites
  the first, including any manual-override translations. Per Q6
  this matches existing realtime behavior on every other field.
  Documented; no mitigation in v1.
- **zh-CN collation.** `localeCompare(a, b, 'zh-CN')` in Node /
  browsers without ICU falls back to codepoint order, which is
  not Mandarin pinyin order. Sort results in Chinese mode will
  look near-random to a native reader. Known Limitation; flag
  to the user in release notes.
- **DeepL API outage.** Form-side falls back to manual override
  fields; save still works. No retries, no queue.
- **Silent-fallback masks missing translations.** A row that
  *should* have been translated but slipped through (e.g.
  DeepL returned an empty string and the override was left
  blank) will look identical to a row that *is* untranslated
  on purpose. No admin-visible "untranslated rows" report in
  v1. The bulk back-translate task (out of scope) can surface
  this list when it runs.
- **Hard-coded DeepL provider.** No abstraction means swapping
  to Google Cloud Translation / Azure Translator later requires
  a code change to the edge function. The user accepted this
  trade-off — provider abstraction NOT required in v1.

## Sample call-site count (PM estimate, architect to verify)

- **Form sites (write):** 5 form components / sections —
  IngredientForm + IngredientFormDrawer (consolidated to one in
  most flows), RecipeFormDrawer, PrepRecipeFormDrawer, the
  CategoriesSection CRUD modal.
- **Read sites (lists, details, filters, search, sort):**
  ~15–20 call sites across the cmd sections. Sampling:
  - Inventory: `InventoryCatalogMode.tsx`, `InventoryDesktopLayout.tsx`,
    `IngredientForm.tsx` (display in audit/history hover).
  - Recipes: `RecipesSection.tsx`, plus the category filter
    dropdown and the recipe-by-name search.
  - Prep recipes: `PrepRecipesSection.tsx` + its recipe-prep-items
    join (where prep recipe names render inside the parent recipe
    drawer — `RecipeFormDrawer.tsx`).
  - Categories: `CategoriesSection.tsx`.
  - Cross-cutting: `AuditHistory.tsx` (renders ingredient + recipe
    names in change rows), `ExpiringItemsModal.tsx` (renders item
    names), filter dropdowns in `RestockSection.tsx`,
    `ReceivingSection.tsx`, `ReorderSection.tsx`,
    `WasteLogSection.tsx`.
  - Reports: `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`
    if any report's row display references the localized column.
  The architect's design doc should produce a definitive list via
  `grep` for `\.name\b` and `\.menu_item\b` on the relevant types
  and decide whether the rewire is single-pass or staged.

## Backend / architecture design

This design covers every architect deliverable enumerated by the PM, including
explicit answers to OQ-A1 through OQ-A5 with rationale.

### 0. Resolved architect decisions (OQ-A1 — OQ-A5)

**OQ-A1 — Sub-phasing. DECISION: ship as ONE spec with explicit
phase boundaries (P3a → P3b → P3c) inside the single implementation
prompt.** Rationale: the schema migration is small (one ADD COLUMN ×
5 tables, all metadata-only in PG17), the read-side rewires are
mechanical (`row.name` → `getLocalizedName(row, locale)`), the
helper / hook / pgTAP / jest tracks are each ~30 LOC, and the form
+ edge function half is genuinely new surface. Splitting into 040a
and 040b would force a second architect-design round-trip for a
mostly-trivial follow-up and would also leave a window where the
column exists but no writer populates it (acceptable per
silent-fallback, but operationally awkward). The recommended
implementation prompt below labels the phases so the developer
ships P3a first as a self-contained PR if review pressure demands,
but the spec stays singular. P3c (bulk back-translate) is
**out of scope** and is left for a separate operational task as
the PM already deferred.

Implementation order inside the single PR (or split into two PRs at
the developer's discretion):

- **P3a (read path, all-or-nothing):** migration + types +
  `getLocalizedName` helper + `useLocalizedName` hook + every read-site
  rewire + Track 1 jest + Track 2 pgTAP. After P3a all rows have
  `i18n_names = '{}'` and the silent-English fallback renders.
- **P3b (write path):** `translate-on-save` edge function + DEEPL_API_KEY
  secret + 5 form sites' auto-fill UI + the small write-path additions to
  `db.ts` and the store slice. After P3b new rows carry filled `i18n_names`.

**OQ-A2 — Edge function invocation model. DECISION: client-initiated,
per PM recommendation.** Rationale: matches the existing five-function
pattern (`send-invite-email`, `delete-user`, `staff-eod-submit`, etc.),
keeps the function call inside `callEdgeFunction` envelope semantics, and
lets the form surface a "translating..." spinner state with a clear
fall-through to the manual-override fields on DeepL failure — none of which
a `pg_net` trigger could do without pumping notifications back through
realtime. `pg_net` would also require an outbound `SERVICE_BEARER`-style
secret on the DB side that this project has not yet introduced; introducing
one in this spec triples the security-audit surface for no UX benefit.

**OQ-A3 — DeepL target-lang code for `zh-CN`. DECISION: use
`ZH-HANS`.** Rationale: DeepL's v2 API split the legacy `ZH` (which
defaulted to Simplified) into the explicit `ZH-HANS` (Simplified) and
`ZH-HANT` (Traditional) target codes in 2024Q3. New integrations should
use the explicit form. The DeepL API still accepts `ZH` as a legacy alias
for Simplified — if a future DeepL deprecation flips that, the explicit
`ZH-HANS` insulates us. The Spanish side stays `ES` (DeepL does not split
`es-ES` vs `es-MX` on the target side). Mapping table the function applies
internally:

| App locale code | DeepL `target_lang` | Source |
|-----------------|---------------------|--------|
| `es`            | `ES`                | DeepL v2 spec        |
| `zh-CN`         | `ZH-HANS`           | DeepL v2 spec (2024+) |

Pin this mapping in a `LOCALE_TO_DEEPL` const at the top of
`index.ts`; one-line change if a fourth locale lands later.

**OQ-A4 — Form debounce strategy. DECISION: hybrid — fire on
either (a) `onBlur` (TextInput loses focus) or (b) 600 ms idle after
the last keystroke, whichever fires first. Both paths funnel through
a single `scheduleTranslate()` helper that cancels any in-flight
fetch and re-issues with the latest text.** Rationale: the existing
forms under `src/components/cmd/` don't use debounce today (every
TextInput is a controlled component with direct onChangeText
`set(...)` calls), so there's no precedent to break. 600 ms (slightly
longer than the 500 ms the PM proposed) gives a typing user time to
finish a multi-word name like "Yellow Onion Wedges" before burning
a DeepL call, while still feeling responsive. Tab-out covers the
power user who tabs immediately. On blur OR idle: cancel any prior
inflight fetch via `AbortController` and resolve only the latest.
The "Save while translating" race is resolved by **option (b) from
the spec**: save with whatever override the user typed and whatever
suggestions have already returned — DeepL is best-effort, the save
is authoritative.

**OQ-A5 — SQL-side `localized_name(row, locale)` helper. DECISION:
DO NOT add for v1. Surface as a follow-up spec if a server-side
sort path emerges.** Rationale: every read site for the 5 tables is
client-side sorted today (the Zustand store hydrates the full list
on login; sections compose their own `[...rows].sort(...)` over the
local slice). No PostgREST `order=` is in flight for any of the
five tables — verified by grepping for `.order(` in `src/lib/db.ts`
on these tables (none gate on localized name). Adding a SQL helper
preemptively would be load-bearing dead code that drifts. If a
future report needs SQL-side localized sort (e.g. a long catalog
that paginates), the function is a single-line `SQL` function
that can land in the spec that introduces the paginated query —
cheaper and more justified at that point. Note this defers the
question only; the column shape `i18n_names jsonb` is forward-
compatible with a future `coalesce(i18n_names->>locale, name)`
expression with zero migration cost.

### 1. Data model changes

**New migration:** `supabase/migrations/20260517000000_user_data_i18n_names.sql`

Slot is open (latest existing is `20260516000000_profiles_locale.sql`).
Single-transaction, additive only, idempotent via `add column if not exists`.

Adds to FIVE tables:

| Table                    | Canonical English column | Scope     |
|--------------------------|--------------------------|-----------|
| `catalog_ingredients`    | `name`                   | brand     |
| `recipes`                | `menu_item`              | brand     |
| `prep_recipes`           | `name`                   | brand     |
| `recipe_categories`      | `name`                   | global    |
| `ingredient_categories`  | `name`                   | global    |

Shape on every table:

```sql
alter table public.<t>
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.<t>.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. English canonical lives in the parent <name|menu_item> column and is never written here.';
```

**Backfill semantics:** `add column ... not null default '{}'` is a
metadata-only ALTER in PG17 (no row rewrite, no table lock beyond
brief AccessExclusive). Existing rows are observable as `{}` the
instant the migration commits. No separate `update` statement
needed.

**CHECK constraint (shape validation). DECISION: skip.** Rationale:
the PM made this optional and the architect's call. The trade-off:

- A strict CHECK like `jsonb_typeof(i18n_names) = 'object' AND
  not (i18n_names ? '<unknown_key>')` either (a) hard-codes the
  three known locales — which means adding `pt-BR` later is a
  CHECK migration the JSONB column was specifically chosen to
  avoid; or (b) requires a regex-style key validator that's
  awkward in pg's JSONB operators.
- The edge function + form layer are the validators in the
  write path. Direct SQL writes (admin-script-style backfills)
  are rare and inspectable.
- The pgTAP test (§Verification) covers the column shape itself
  (`not null default '{}'`); shape-of-VALUE is a value-layer
  concern.

If a future spec adds a 4th locale, the JSONB column accepts the
new key with zero migration. That's the value of the choice.

**GIN index. DECISION: skip for v1.** Rationale: search uses
client-side `matchesQuery` over the already-hydrated Zustand
slice; no `WHERE i18n_names @> ...` or `i18n_names->>'es' ilike
...` query exists in the codebase or is planned. Adding the index
proactively costs WAL bloat on every write (the column is touched
on every form save) for zero current query benefit. A future
server-side search spec (e.g. for the customer PWA's localized
search) can add the GIN index in the same migration that adds the
search query.

**Rollout safety:** additive only. No existing column changes, no
data rewrites. If the migration is rolled back via a `drop column`
in a follow-up migration, the only loss is the JSONB payload —
no read-path code looks for `i18n_names` before this spec, so a
pre-spec-040 client running against a post-spec-040 DB stays
functional (PostgREST returns the column, the client ignores it).

### 2. RLS impact

**No new policies on any of the 5 tables.** Verified by reading:

- `catalog_ingredients` policies are `brand_member_read_catalog_ingredients` +
  `privileged_insert/update/delete_*` from
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:446-473`.
  All are FOR ALL columns and gate on `auth_can_see_brand(brand_id)`
  / `auth_is_privileged()`. `i18n_names` rides on these unchanged —
  no column-scoped grants on Postgres tables exist by default; if a
  reader can see the row they see every column.
- `recipes`, `prep_recipes` policies are the analogous
  `brand_member_read_*` + `privileged_*` set from the same migration
  (lines 490-517 and 532-573). Same conclusion.
- `recipe_categories` write policy is `"Admins can write categories"`
  ON `recipe_categories` FOR ALL using `auth_is_privileged()` from
  `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`
  (super-admin-write path closed in spec 026 follow-up). Read policy
  is permissive ("Authenticated can read categories") — predates the
  helper era. Same conclusion: `i18n_names` rides on the existing
  FOR ALL policy.
- `ingredient_categories` policies are the split set
  ("Authenticated can read ingredient categories" SELECT + four
  admin-gated INSERT/UPDATE/DELETE) from
  `supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql:33-48`.
  Same conclusion.

**One operational nit, surface and proceed:** all five tables'
write policies are scoped to privileged callers — meaning a
non-privileged authed user who somehow obtained a session and
tried to UPDATE `i18n_names` directly via PostgREST gets a 401/403
the same way they would for `name`. The edge function (which
validates `requireAdminCaller()`) and the client form (which only
writes via `useStore`'s privileged-by-design slice) are the
intended write paths.

### 3. API contract (PostgREST + RPC)

**No new RPCs.** All writes to `i18n_names` flow through the existing
PostgREST table endpoints by adding the column to the existing
upsert payloads in `db.ts` (see §6 below). No `update_i18n_names`
RPC needed; PostgREST table writes are sufficient given the existing
RLS already gates the column.

**No PostgREST contract break.** Existing `select * from
catalog_ingredients` (etc.) queries auto-include the new column.
Clients that don't yet know about `i18n_names` will receive the
extra field as JSON and ignore it (TypeScript types omit it). No
existing select projection in `db.ts` explicitly lists columns for
these tables — confirmed by grepping `from('catalog_ingredients')`
and friends; all use `select('*')` or `select('*, foo:join(...)')`.

The 5 `db.ts` mapper functions (`mapItem`, `fetchRecipes`'s inline
mapper, `createRecipe`'s return shape, `fetchPrepRecipes`'s inline
mapper, the `fetchRecipeCategories` / `fetchIngredientCategories`
return-shape upgrade — see §6) need to thread `i18n_names` through
the snake_case → camelCase boundary as `i18nNames`.

### 4. Edge function — `translate-on-save`

**Location:** `supabase/functions/translate-on-save/index.ts`

**`verify_jwt`:** `true` (default — no new entry needed in
`supabase/config.toml` since the file only flags exceptions, and the
default is `true`).

**Caller-side binding:** invoked via `callEdgeFunction` per
[src/lib/auth.ts:146](../src/lib/auth.ts). Returns the standard
`{ data: { translations }, error: null }` envelope on success or
`{ data: null, error: <string> }` on failure (tier-order: parsed
body `error` field → parsed body `message` → `HTTP <status>`).

**Server-side admin gate:** copy the reference shape from
[supabase/functions/delete-user/index.ts:19](../supabase/functions/delete-user/index.ts):

```ts
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);
async function requireAdminCaller(authHeader: string | null) { /* identical to delete-user */ }
```

Mirrors `auth_is_privileged()` per CLAUDE.md. Inlined-not-shared
per CLAUDE.md "Inline-not-shared" rule.

**Request shape (validated server-side):**

```ts
{
  text: string;                          // non-empty, max 200 chars
  sourceLocale: 'en';                    // pinned literal for v1
  targetLocales: ('es' | 'zh-CN')[];     // 1-2 items
}
```

Validation rules and error codes (the function MUST short-circuit
before calling DeepL on any of these):

| Condition                                            | HTTP | `error` string                |
|------------------------------------------------------|------|-------------------------------|
| Missing/empty `text`                                 | 400  | `"text required"`             |
| `text.length > 200`                                  | 400  | `"text too long"`             |
| Missing/empty `targetLocales`                        | 400  | `"targetLocales required"`    |
| Unknown locale in `targetLocales`                    | 400  | `"unsupported target locale"` |
| `sourceLocale !== 'en'`                              | 400  | `"unsupported source locale"` |
| Caller fails `requireAdminCaller()`                  | 401/403 | `"missing bearer token" / "invalid token" / "forbidden"` |

**Response shape (success):**

```ts
{
  translations: {
    es?: string;       // present iff 'es' in targetLocales AND DeepL returned a non-empty translation
    'zh-CN'?: string;  // same condition
  };
}
```

Keys missing from `translations` signal "DeepL declined to
translate this target" — the form handles this as a partial-failure
state (see §7).

**Response shape (failures):**

| Upstream condition                                | HTTP | `error` string             | Notes |
|---------------------------------------------------|------|----------------------------|-------|
| `DEEPL_API_KEY` env var not set                   | 503  | `"translation_unavailable"`| Operator hasn't run `supabase secrets set`. |
| DeepL HTTP 403 (auth failed) or 456 (quota)       | 503  | `"translation_unavailable"`| Don't leak DeepL-specific status. |
| DeepL HTTP 429 (rate limit)                       | 503  | `"translation_unavailable"`| Same as above. |
| DeepL HTTP 5xx                                    | 503  | `"translation_unavailable"`| Same as above. |
| Network error reaching DeepL                      | 503  | `"translation_unavailable"`| Catch fetch rejection. |
| DeepL returned partial success (one locale ok,    | 200  | `null`                     | Return the keys that succeeded; the form fills the rest with empty manual fields. |
| other failed)                                     |      |                            |       |

The deliberate choice to collapse every upstream failure mode into
a single client-visible `"translation_unavailable"` is per the
spec's §Risks "Form-side falls back to manual override fields on
DeepL failure" — surfacing DeepL-specific HTTP codes to the form
would invite the form to render bespoke error UI per code, which
the PM explicitly out-of-scoped. Operators tail the function logs
for the real DeepL response if quota is suspected.

**DeepL call shape (function-internal):**

```
POST https://api-free.deepl.com/v2/translate
Content-Type: application/x-www-form-urlencoded

auth_key=<DEEPL_API_KEY>&text=<text>&source_lang=EN&target_lang=<ES|ZH-HANS>
```

Per OQ-A3, target codes are `ES` and `ZH-HANS`. Issue ONE call
per target locale (DeepL's `text` is repeatable but its
`target_lang` is single-valued per request). Use `Promise.all`
to parallelize across the (1–2) target locales — each call is
~200ms, parallelizing saves the form-spinner ~200ms of perceived
latency.

**DEEPL_API_KEY secret (NEW deploy step the developer must
document in the spec's `## Files changed` section so the deploy
checklist surfaces it):**

```sh
# One-time operator step BEFORE deploying the function; the function
# returns 503 "translation_unavailable" until this is set.
supabase secrets set DEEPL_API_KEY=<your-key-from-deepl-pro-signup>
```

The DeepL free tier gives 500K chars/month. Per the spec's quota
math (~12,500 saves/month ceiling), free tier is sufficient for
normal use. If the operator chooses Pro tier the URL shifts from
`api-free.deepl.com` to `api.deepl.com` — but the spec is explicit
that v1 hard-codes `api-free`. A future spec can add a
`DEEPL_API_URL` env var if Pro becomes necessary.

**No HTML rendering.** The function returns JSON only, so the
CLAUDE.md `escapeHtml` rule is moot. The text we send TO DeepL is
URL-form-encoded (no XSS risk on the wire). The text we receive
back FROM DeepL is consumed as a JSON string and propagated to
client form state — never rendered as raw HTML by the form.

**Cold-start cost:** Deno 2 edge functions cold-start in
~150–300ms locally. The form's "translating..." spinner absorbs
this. DeepL's TLS handshake adds another ~50–100ms. Total worst
case: ~500ms cold + ~200ms DeepL × parallel = ~700ms wall.
Acceptable per the 600ms-debounce UX shape — the user has
already stopped typing.

### 5. `src/lib/db.ts` surface

**Five `db.ts` mapper / writer changes.** Read-path additions:

| Function                          | Change                                                  |
|-----------------------------------|---------------------------------------------------------|
| `mapItem` (line 2777)             | Hydrate `i18nNames: cat.i18n_names ?? {}` from the joined catalog row. Add `i18nNames` to `InventoryItem` type. |
| `fetchRecipes` mapper (line 219)  | Add `i18nNames: r.i18n_names ?? {}` to the returned object. |
| `fetchPrepRecipes` mapper         | Same — locate by grep, add `i18nNames`. |
| `fetchRecipeCategories` (line 1491) | **Signature change** — return `{ name: string; i18nNames: Record<string,string> }[]` instead of `string[]`. See §8 (frontend store impact) for the store-slice cost. |
| `fetchIngredientCategories` (line 1678) | Same signature change. |

Write-path additions (all are partial-update patches; omit the
key if unchanged — matching the existing `updateRecipe` pattern):

```ts
// src/lib/db.ts — new helper function
export async function updateCatalogIngredientI18n(
  catalogId: string,
  i18nNames: { es?: string; 'zh-CN'?: string },
): Promise<void> {
  const { error } = await supabase
    .from('catalog_ingredients')
    .update({ i18n_names: i18nNames })
    .eq('id', catalogId);
  if (error) throw error;
}
```

Plus one each for `updateRecipeI18n(recipeId, ...)`,
`updatePrepRecipeI18n(prepId, ...)`, `updateRecipeCategoryI18n(name, ...)`,
`updateIngredientCategoryI18n(name, ...)`. Categories are keyed by
`name` (not `id`) per the existing `.eq('name', oldName)` pattern in
`db.ts:1501` / `1688`. This means renaming the canonical English
name and updating `i18n_names` in the same save is a two-step PATCH;
do them in a single transaction-style sequence (the existing
`updateRecipeCategory(oldName, newName)` is already not atomic).

**Alternative considered:** extend the existing `updateRecipe`
/ `createRecipe` / `addIngredientCategory` etc. to accept an
optional `i18nNames` field in their payload, side-stepping the
new function surface. Rejected because:

1. The form's translation suggestion may arrive AFTER the save
   (the 600ms debounce + 200ms DeepL + the save click race), and
   the optimistic-then-revert pattern in `useStore` writes the
   row immediately. A separate `update*I18n` call lets the
   suggestion land asynchronously without re-issuing the whole
   row's update. See §7.
2. The signature change is a one-line addition to each of the
   five mapper paths, easier to review.

For *create* paths, the form passes `i18nNames` as a normal field
in the create payload — `createRecipe(recipe)` already takes the
full Recipe shape, so the developer adds `i18n_names: recipe.i18nNames || {}`
to the upsert object in `createRecipe` (db.ts:251), `createPrepRecipe`,
and the `create_inventory_item_with_catalog` RPC's `p_*` params.
The RPC argument list grows by one (`p_i18n_names jsonb default '{}'`);
that needs a parallel RPC signature change in the migration. **The
migration MUST also drop-and-recreate `create_inventory_item_with_catalog`**
to thread the new param into the inner `insert into catalog_ingredients`
statement. Mark this as a load-bearing migration footnote.

**TypeScript type changes** (in `src/types/index.ts`):

```ts
export type LocalizedNames = Partial<Record<Locale, string>>;
// Adds to CatalogIngredient, Recipe, PrepRecipe, RecipeCategory (new), IngredientCategory (new):
i18nNames?: LocalizedNames;
```

`Locale` reused from `src/i18n/index.ts`. `LocalizedNames` is
keyed by `Locale` so adding a 4th language widens the type
automatically. The `?` and `Partial` are deliberate — a row with
no translation should not be required to spell out `{ en: '...' }`
since English lives in the canonical column, not the JSONB.

**New helper file:** `src/i18n/localizedName.ts`. Pseudocode shape
(no implementation; developer authors):

```ts
import type { Locale } from './index';
import type { LocalizedNames } from '../types';

type LocalizableRow = {
  name?: string | null;
  menuItem?: string | null;
  i18nNames?: LocalizedNames | null;
};

export function getLocalizedName(row: LocalizableRow, locale: Locale): string {
  // English mode (or row has no i18nNames): return canonical column.
  // The recipes table is the only one with a non-`name` canonical column;
  // detect by feature-checking `row.menuItem` before `row.name`.
  const canonical = row.menuItem ?? row.name ?? '';
  if (locale === 'en') return canonical;
  const localized = row.i18nNames?.[locale];
  return localized && localized.length > 0 ? localized : canonical;
}
```

Note the `row.menuItem` first / `row.name` second order: the
`recipes` shape exposes BOTH after spec 040 in some intermediate
states (legacy `name` column not present, only `menu_item` →
camelCased to `menuItem`); the helper picks the recipe's
canonical via `menuItem` truthy. Treat the spec's stated
"silent fallback" rule as authoritative — empty-string and
whitespace-only `i18n_names` values fall through to canonical.

**New hook file:** `src/hooks/useLocalizedName.ts` (or
co-located in `src/i18n/`):

```ts
import { useLocale } from './useLocale';
import { getLocalizedName } from '../i18n/localizedName';
export function useLocalizedName(row: LocalizableRow): string {
  const locale = useLocale();
  return getLocalizedName(row, locale);
}
```

Re-renders flow through the existing `useLocale()` selector;
identical pattern to `useT()`. No memoization needed at the hook
level (the function body is one property read + one ternary —
React's per-render cost is below the cost of building a useMemo
dep array).

**Per-row memoization decision:** none. `getLocalizedName` is
O(1) — two object lookups and a ternary. Memoizing it would
cost more in WeakMap bookkeeping than it saves. Tested
indirectly via the Track 1 jest fixture round-trip.

**Search helper (new in `src/i18n/`):** the spec asks for a
`matchesLocalizedName(query, row, locale)` wrapper. **Decision:
DO NOT add a wrapper; call `matchesQuery` directly at the
call site.** Rationale: the wrapper would be a 3-line file
that obscures what's actually happening. Call sites already
know they want both candidates (localized + canonical), and
spelling that out at the call site is clearer:

```ts
matchesQuery(input, [
  getLocalizedName(row, locale),     // localized
  row.menuItem ?? row.name ?? '',    // canonical
]);
```

This is the exact shape the spec acceptance criteria already
spells out. The matchesQuery import is one-line per file.

### 6. Edge function → call site → store wiring

**`src/lib/auth.ts`:** no change. `callEdgeFunction` already
covers this. A new exported helper in `src/lib/db.ts` (or
`src/lib/translate.ts` — see below) wraps `callEdgeFunction`
typedly:

```ts
// New: src/lib/translate.ts  (or top of db.ts)
export type TranslationResult = {
  translations: Partial<Record<Exclude<Locale, 'en'>, string>>;
};

export async function translateOnSave(
  text: string,
  targetLocales: Array<Exclude<Locale, 'en'>>,
): Promise<{ data: TranslationResult | null; error: string | null }> {
  return callEdgeFunction('translate-on-save', {
    text,
    sourceLocale: 'en',
    targetLocales,
  });
}
```

**Decision: put this in a NEW file `src/lib/translate.ts`, not
`db.ts`.** Rationale: db.ts is already ~64 KB. The translate
function is conceptually I/O-not-DB. CLAUDE.md says DB access
flows through `db.ts`; the edge function call is auth + HTTP,
not DB. Co-locate with future translation-related code (provider
abstraction in a v2 spec, glossary, etc.). Keep db.ts focused.

### 7. Store impact — Zustand slice + optimistic pattern

**Catalog ingredient (per-store inventory item) — the load-
bearing case:** the form drives `addInventoryItem` / `updateInventoryItem`
in the existing optimistic-then-revert flow. The translation write
target is `catalog_ingredients.i18n_names`, not `inventory_items.i18n_names`
(`inventory_items` has no name column post-Phase-3). So the new
slice action:

```ts
// useStore.ts surface
setCatalogI18nNames: (catalogId: string, i18nNames: LocalizedNames) => void;
```

Fired by the form AFTER the save returns and the translation
suggestion arrives. The action:

1. Patches the `inventory` slice optimistically:
   `inventory.map(it => it.catalogId === catalogId ? { ...it, i18nNames } : it)`.
2. Calls `db.updateCatalogIngredientI18n(catalogId, i18nNames)`.
3. On error, reverts the slice and `notifyBackendError('Save translation', e)`.

Identical pattern for `setRecipeI18nNames(recipeId, i18nNames)`,
`setPrepRecipeI18nNames(prepId, i18nNames)`,
`setRecipeCategoryI18nNames(name, i18nNames)`,
`setIngredientCategoryI18nNames(name, i18nNames)`.

**Form-flow race resolution.** The "save while translating"
race (OQ-A4 wrap-up):

- User types "Yellow Onion" → 600ms idle fires `translateOnSave('Yellow Onion', ['es', 'zh-CN'])`.
- User clicks Save before the fetch resolves.
- Form payload includes `i18nNames: { es: <whatever was in override field>, 'zh-CN': <ditto> }` — if the user hasn't typed anything, both are empty strings → omit from the JSONB.
- The save fires `addCatalogIngredient(...)` with `i18nNames` populated from whatever the form has.
- The in-flight `translateOnSave` resolves, the form updates its local override state with the suggestions.
- If the user accepts the suggestions and clicks Save again (edit mode now), `setCatalogI18nNames(catalogId, suggestions)` patches the row.
- If the user navigates away without re-saving, the suggestions are discarded — same way every other unsaved form field discards on close.

This deliberately treats DeepL suggestions as "best-effort
post-save hint" rather than "blocking pre-save value." Aligns
with optimistic-then-revert: the save is authoritative, the
translation is a side-channel improvement.

**Categories shape upgrade.** The current `recipeCategories: string[]`
slice must widen to:

```ts
recipeCategories: Array<{ name: string; i18nNames: LocalizedNames }>;
```

Same for `ingredientCategories`. This is a breaking shape change
for every read site that does `s.recipeCategories.map((c) => c)`
expecting a string. **Estimated blast radius:** 5–10 call sites
(category filter dropdowns in `RecipesSection`, `InventoryCatalogMode`,
`PrepRecipesSection`, plus the `CategoriesSection` CRUD modal).
The implementation prompt below names this as a load-bearing
fan-out to call out to the frontend developer.

Alternative considered: keep `recipeCategories: string[]` and
ride translations on a parallel slice `recipeCategoryI18n: Record<string, LocalizedNames>`. **Rejected** — splits a logically
single entity across two slices, every read site has to do
two lookups, and the optimistic-then-revert pattern has to
synchronize two slices on every category write. The shape
upgrade is the right call.

### 8. Realtime impact

**Subscriber audit.** From
[supabase/migrations/20260514140000_realtime_publication_tighten.sql](../supabase/migrations/20260514140000_realtime_publication_tighten.sql):

| Table                    | In `supabase_realtime`? | Channel                      |
|--------------------------|--------------------------|------------------------------|
| `catalog_ingredients`    | YES                      | `brand-{id}`                 |
| `recipes`                | YES                      | `brand-{id}`                 |
| `prep_recipes`           | YES                      | `brand-{id}`                 |
| `recipe_categories`      | **NO**                   | (not subscribed)             |
| `ingredient_categories`  | **NO**                   | (not subscribed)             |

For the three brand-scoped tables, an `i18n_names` update on
brand A is replayed to every connected `brand-{brandId}`
subscriber. `useRealtimeSync.ts` debounces 400ms and triggers
a full reload of the relevant slice; the i18n_names roundtrips
identically to a `name` edit today.

For the two category tables, **no realtime replay happens**.
Today's behavior is "full reload on login or section mount."
Same posture as today; this spec inherits the gap without
widening it.

**CRITICAL — DO NOT add `recipe_categories` or `ingredient_categories`
to the publication in this migration.** Per CLAUDE.md
"Realtime publication gotcha" and project memory: changing
`supabase_realtime` membership requires a `docker restart
supabase_realtime_imr-inventory` on every dev machine for
the slot to re-snapshot. Adding two tables in a spec where
no part of the user story depends on cross-tab category
realtime replay is unnecessary risk. If a future spec wants
category realtime, it does so as the *only* publication
change in that migration, with an explicit deploy/dev step
called out.

**No `docker restart` step needed for this spec.** The
migration adds columns to existing publication-member tables;
publication membership is unchanged.

### 9. Frontend store impact (slice-by-slice)

| Slice                  | Read-path change                                            | Write-path change |
|------------------------|-------------------------------------------------------------|-------------------|
| `inventory`            | Hydrate `i18nNames` via `mapItem` from joined catalog.       | None (writes via `setCatalogI18nNames` action). |
| `recipes`              | Hydrate `i18nNames` in `fetchRecipes` mapper.                | `addRecipe` / `updateRecipe` payload accepts `i18nNames` (create path only). Edit path uses `setRecipeI18nNames`. |
| `prepRecipes`          | Hydrate `i18nNames` in `fetchPrepRecipes` mapper.            | Same shape as recipes. |
| `recipeCategories`     | **Slice type widens** to `{ name; i18nNames }[]`.            | `addRecipeCategory` accepts optional `i18nNames`; rename + retranslate is two-step. |
| `ingredientCategories` | Same shape widen.                                            | Same shape as recipe categories. |

All write paths follow the optimistic-then-revert pattern from
`useStore.ts:1219+` (the `addRecipe` reference shape). Revert on
error + `notifyBackendError`.

**New store actions (5):**

```ts
setCatalogI18nNames: (catalogId: string, i18nNames: LocalizedNames) => void;
setRecipeI18nNames: (recipeId: string, i18nNames: LocalizedNames) => void;
setPrepRecipeI18nNames: (prepId: string, i18nNames: LocalizedNames) => void;
setRecipeCategoryI18nNames: (name: string, i18nNames: LocalizedNames) => void;
setIngredientCategoryI18nNames: (name: string, i18nNames: LocalizedNames) => void;
```

Plus the 5 new `db.ts` partial-update functions feeding them.

### 10. Search and sort wiring

**Search** — implement per spec acceptance criteria using
`matchesQuery` from `src/i18n/matchesQuery.ts` (P2). At every
search-input call site in the section components:

```ts
const locale = useLocale();
const filtered = rows.filter((row) =>
  matchesQuery(searchInput, [
    getLocalizedName(row, locale),
    row.menuItem ?? row.name ?? '',
  ])
);
```

`matchesQuery`'s NFD-decompose + diacritic-strip means
`detergente` matches `Detergent` after fold, and `prueba`
matches `Artículo de prueba` after fold. Tested via the
i18n.test.ts suite (P2).

**Sort** — client-side, using `localeCompare(locale)` with the
helper as sort key:

```ts
const locale = useLocale();
const sorted = [...rows].sort((a, b) =>
  getLocalizedName(a, locale).localeCompare(getLocalizedName(b, locale), locale)
);
```

**zh-CN limitation (documented in §Risks).** `localeCompare(.., 'zh-CN')`
on Hermes / RN-iOS / RN-Android falls back to codepoint order — not
pinyin. The spec explicitly accepts this as a Known Limitation; user
release notes will flag it. Pinyin collation requires an ICU bundle
(~2MB) that's out of scope.

No server-side sort change. No PostgREST `order=` queries gate
on the localized name today (confirmed by grep over `.order(` in
`db.ts` for the 5 tables — only `order_at`, `created_at`, `id`,
`updated_at`, `logged_at` show up).

### 11. Risks and tradeoffs

- **Migration ordering.** The migration runs after
  `20260516000000_profiles_locale.sql`. No cross-migration
  dependency — the profiles.locale column landed in P1; this
  migration only touches 5 catalog tables. Safe to apply
  independently.
- **`create_inventory_item_with_catalog` RPC change is load-bearing.**
  The migration must drop-and-recreate this function to thread the
  new `p_i18n_names` param. If the developer misses this, new
  inventory items created via the inventory form will silently
  drop the translations (they're sent in the form payload but
  not propagated to the RPC's inner catalog insert). pgTAP should
  cover this by exercising the RPC with `p_i18n_names := '{"es":"x"}'::jsonb`
  and asserting the catalog row carries it.
- **RLS gap.** None. All 5 tables' existing FOR ALL policies
  cover the new column. The non-privileged read of `i18n_names`
  on a row the caller can already read is intentional (English-
  fallback is the worst they could trigger).
- **Performance on 286KB seed.** The seed has ~150 catalog
  ingredients per brand, ~60 recipes per brand, ~30 prep
  recipes per brand, dozens of categories. The `i18n_names`
  JSONB is empty `{}` on every existing row — payload
  increase is one byte per row (the `{}` literal). PostgREST
  response size grows by ~5 bytes per row to include the
  `"i18n_names": {}` field. Negligible.
- **Edge function cold-start.** Deno 2 boots in ~150–300ms;
  the form spinner absorbs this. DeepL adds ~200ms. The 600ms
  debounce + cold-start gives a worst-case ~1.0s from
  last-keystroke-to-suggestion. Acceptable for non-blocking
  auto-fill.
- **DeepL quota.** Per §Risks in the spec, the ~12,500
  saves/month free-tier ceiling is well above normal usage.
  Bulk imports could exceed; mitigation is manual override
  on failure. No quota alerting in v1.
- **Last-write-wins on i18n_names.** Two admins editing the
  same row's translations simultaneously: the second save
  clobbers. Same posture as every other field on the row.
  Documented in §Risks.
- **Silent-fallback masks empty translations.** A row where
  DeepL returned empty + override left blank renders as
  canonical English — indistinguishable from an untranslated
  row. The PM explicitly accepted this trade-off.
- **`recipe_categories` / `ingredient_categories` realtime
  silence.** As today; not widened by this spec. If two admins
  edit the same category's translations in different tabs, the
  second tab needs a full reload to see the update. Same
  posture as renaming a category today.

### 12. Verification — test tracks

**Track 1 (jest).** `src/i18n/localizedName.test.ts` exercising
the 5 cases the spec enumerates plus 2 fixture round-trips (one
catalog-ingredient-shaped, one recipe-shaped to cover the
`menuItem` canonical-column path). ~30 LOC.

**Track 2 (pgTAP).** New file under `tests/db/`
(`tests/db/i18n_names_columns.test.sql`?). Five `is(...)`
assertions of the shape:

```sql
select is(
  (select column_default from information_schema.columns
    where table_schema='public' and table_name='catalog_ingredients' and column_name='i18n_names'),
  '''{}''::jsonb',
  'catalog_ingredients.i18n_names default is {}'
);
-- ... × 5 tables
-- Plus: not_null, jsonb data_type assertions.
```

Parametrize via a `do $$ ... loop ... $$` block over the 5 table
names if the runner supports it; otherwise repeat the assertion
block 5 times.

**Plus: pgTAP coverage of the `create_inventory_item_with_catalog`
RPC change.** Insert a row with `p_i18n_names := '{"es":"prueba"}'::jsonb`,
select the catalog row, assert `i18n_names ->> 'es' = 'prueba'`. Catches
the load-bearing RPC-parameter-threading risk from §11.

**Manual smoke.** Per §Verification in the spec — 7 steps cycling
through Spanish + Chinese on each of the 5 entity types.

### 13. File path summary (developer's checklist)

New files:

- `supabase/migrations/20260517000000_user_data_i18n_names.sql`
- `supabase/functions/translate-on-save/index.ts`
- `src/i18n/localizedName.ts`
- `src/hooks/useLocalizedName.ts` (or co-located)
- `src/i18n/localizedName.test.ts`
- `src/lib/translate.ts`
- `tests/db/i18n_names_columns.test.sql`

Modified files (estimated; developer to expand by grep):

- `src/lib/db.ts` (5 mappers + 5 partial-update functions + create-path payload additions)
- `src/types/index.ts` (5 type widenings + new `LocalizedNames` type)
- `src/store/useStore.ts` (5 new actions + 2 slice-shape widenings for categories)
- `src/components/cmd/IngredientForm.tsx` (auto-fill UI)
- `src/components/cmd/IngredientFormDrawer.tsx` (wire the form-level translation state)
- `src/components/cmd/RecipeFormDrawer.tsx`
- `src/components/cmd/PrepRecipeFormDrawer.tsx`
- `src/screens/cmd/sections/CategoriesSection.tsx` (CRUD modal for both category types)
- `src/screens/cmd/sections/InventoryCatalogMode.tsx`
- `src/screens/cmd/InventoryDesktopLayout.tsx`
- `src/screens/cmd/sections/RecipesSection.tsx`
- `src/screens/cmd/sections/PrepRecipesSection.tsx`
- Plus any read site grepped for `\.name\b` / `\.menuItem\b` on these types — the PM's §Sample call-site count enumerates ~15-20 surfaces.

Operator pre-deploy step (one-time):

```sh
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup>
```

The spec's `## Files changed` summary at READY_FOR_REVIEW should
include this step explicitly so the release-coordinator surfaces
it in their proposal.

## Files changed

### Backend (this lane)

**Migration**
- `supabase/migrations/20260517000000_user_data_i18n_names.sql` (new) —
  Adds `i18n_names jsonb not null default '{}'` to five tables
  (`catalog_ingredients`, `recipes`, `prep_recipes`, `recipe_categories`,
  `ingredient_categories`). Drops and re-creates
  `create_inventory_item_with_catalog(...)` with a new
  `p_i18n_names jsonb default '{}'::jsonb` parameter threaded into the
  inner `insert into catalog_ingredients` AND surfaced on the returned
  JSONB shape so the JS-side `mapItem` can hydrate without a follow-up
  fetch. Idempotent. No publication-membership change; no realtime-slot
  restart needed on apply.

**Edge function**
- `supabase/functions/translate-on-save/index.ts` (new) — JWT-protected
  (default; no `verify_jwt = false` exception added to
  `supabase/config.toml`). Validates `{ text, sourceLocale, targetLocales }`,
  fans out one DeepL `POST /v2/translate` per target locale in parallel,
  maps `'es' → 'ES'` and `'zh-CN' → 'ZH-HANS'` (OQ-A3). Inlined
  `requireAdminCaller()` (ADMIN_ROLES = `{admin, master, super_admin}`,
  mirrors `auth_is_privileged()`) and `escapeHtml()` (defense-in-depth on
  DeepL responses — byte-identical to `send-invite-email`'s helper).
  Returns `{ translations: { es?, 'zh-CN'? } }` on success (partial-success
  allowed); collapses every DeepL-upstream failure mode to
  `503 { error: 'translation_unavailable' }`. Returns
  `503 { error: 'DEEPL_API_KEY not configured' }` when the env var is unset.

**pgTAP test**
- `supabase/tests/user_data_i18n_names.test.sql` (new) — 15 assertions
  across (1) column shape on all 5 tables, (2) atomic backfill, (3) RLS
  self-update via admin JWT, (4) `create_inventory_item_with_catalog`
  round-trips `p_i18n_names` into the catalog row AND exposes it on the
  RPC return, (5) the RPC defaults the new param to `{}` for back-compat,
  (6) `recipe_categories` and `ingredient_categories` are NOT in
  `supabase_realtime` (locks in the spec §8 out-of-scope decision) and
  the three brand-scoped tables ARE in the publication. `begin;...rollback;`
  hermetic.

**`src/lib/db.ts`**
- Added `import { callEdgeFunction } from './auth'` (newly exported — see below).
- `fetchInventory` / `mapItem` — selects `catalog_ingredients.i18n_names`
  in the JOIN projection and threads it as `i18nNames` on the returned row.
  Return type widened via intersection (`InventoryItem & { i18nNames }`) so
  src/types/index.ts changes stay in the frontend lane.
- `createInventoryItem` — accepts an optional `i18nNames` on the input
  shape; threads it into the RPC's new `p_i18n_names` parameter.
- `updateInventoryItem` — accepts optional `i18nNames`; writes to
  `catalog_ingredients.i18n_names` alongside the other catalog-level
  fields (brand-wide propagation, same as `name`).
- `fetchRecipes` / `createRecipe` / `updateRecipe` — same treatment;
  `i18n_names` lives on `recipes` and is keyed by recipe id.
- `fetchPrepRecipes` / `createPrepRecipe` / `updatePrepRecipe` /
  `updatePrepRecipeVersioned` — same treatment; new versions carry their
  own translation set (immutable historical snapshot).
- `fetchRecipeCategories` / `addRecipeCategory` / `updateRecipeCategory` —
  **breaking shape change.** Return type widened from `string[]` to
  `Array<{ name; i18nNames }>`. Write helpers accept an optional
  `i18nNames` param. Frontend-developer's lane to absorb the callsite fan-out.
- `fetchIngredientCategories` / `addIngredientCategory` /
  `updateIngredientCategory` — same shape upgrade as recipe categories.
- `fetchCatalogIngredients` — adds `i18nNames` to the returned per-row
  shape so the catalog-mode list can render localized labels.
- `translateOnSave(text, targetLocales)` (new helper, placed after
  `saveLocale`) — wraps `callEdgeFunction('translate-on-save', ...)`.
  Returns `{ data: { translations }, error }` per the standard envelope.
- `updateCatalogIngredientI18n`, `updateRecipeI18n`, `updatePrepRecipeI18n`,
  `updateRecipeCategoryI18n`, `updateIngredientCategoryI18n` (new helpers) —
  dedicated partial-update writers per architect §5 so the form's
  async translation-suggestion arrival doesn't have to re-issue the whole row.

**`src/lib/auth.ts`**
- Exported the previously-private `callEdgeFunction` so `src/lib/db.ts` can
  reuse the project-standard envelope wrapper (CLAUDE.md "Edge function
  calls go through callEdgeFunction"). Pre-spec-040 in-module callers
  (`inviteUser`, `registerInvitedUser`, `deleteUser`) are unaffected.

**`src/lib/translate.ts` (new)**
- One-line re-export of `translateOnSave` so callers can import from a
  translation-specific module per the architect's design §6, while the
  canonical implementation lives in `db.ts` per the user's implementation
  prompt directive. Both import paths work; consumers pick the one that
  fits their module's vocabulary.

### Operator one-time secret-set step

Required before the edge function returns translations in any environment:

```sh
# Local dev (against `supabase start` / `npm run dev:db`):
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup>

# Production (against the linked cloud project — operator runs from the
# repo root with the project linked):
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup> --project-ref <prod-project-ref>
```

Until this is set the edge function returns
`503 { error: 'DEEPL_API_KEY not configured' }` and the form falls through
to manual-override entry — saves still work, suggestions don't appear.

### Frontend (sibling lane, in flight)

_To be populated by frontend-developer._

## Files changed

### Frontend

New files:

- `src/i18n/localizedName.ts` — pure helper `getLocalizedName(row, locale)`
  resolving the silent-English-fallback rule (whitespace-only translations
  treated as missing; null / undefined rows tolerated; `menuItem` preferred
  over `name` for the recipes-table column resolution).
- `src/hooks/useLocalizedName.ts` — `useLocalizedName(row)` hook wrapping
  the pure resolver with `useLocale()`. O(1) — no memoization needed.
- `src/i18n/localizedName.test.ts` — Track 1 jest: 26 cases covering the
  five required scenarios + 8 defensive cases + 15 fixture round-trips
  (one per P3 table × 3 locales).

Modified files:

- `src/types/index.ts` — added `LocalizedNames`, `RecipeCategory`,
  `IngredientCategory` exports. Added optional `i18nNames?: LocalizedNames`
  to `CatalogIngredient`, `InventoryItem`, `Recipe`, `PrepRecipe`. Widened
  `AppState.recipeCategories` / `ingredientCategories` from `string[]` to
  the new `RecipeCategory[]` / `IngredientCategory[]` shape.
- `src/store/useStore.ts` — widened the two categories slices (initial
  state + every read/write site). Added 5 new actions:
  `setCatalogI18nNames` / `setRecipeI18nNames` / `setPrepRecipeI18nNames` /
  `setRecipeCategoryI18nNames` / `setIngredientCategoryI18nNames`. Threaded
  optional `i18nNames` through `addRecipeCategory` / `updateRecipeCategory`
  / `addIngredientCategory` / `updateIngredientCategory`.
- `src/store/useStore.test.ts` — added the 5 new `db.*I18n` mock entries
  to the existing jest mock so the deleteProfile test path keeps resolving.
- `src/screens/cmd/sections/CategoriesSection.tsx` — refactored to use the
  new categories shape; added auto-fill UI (Spanish + Chinese override
  fields) on + ADD and per-row EDIT flows; debounced translate-on-save
  trigger (hybrid 600ms idle / blur) with `AbortController` cancellation.
  Sort uses `localeCompare(locale)` over the localized label.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — list, detail
  header, filter chips, and the category-filter chip rendering all use
  `getLocalizedName`. Search consults both English canonical and current-
  locale labels via `matchesQuery`. Sort uses `localeCompare(locale)`.
- `src/screens/cmd/sections/RecipesSection.tsx` — same shape — list
  display, detail title, filter, sort all localized.
- `src/screens/cmd/sections/PrepRecipesSection.tsx` — list display,
  detail title, and sort localized.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — items list, sort
  comparator, detail title localized.
- `src/utils/filterParser.ts` — extended `matchesFilter` to accept an
  optional `localizedName` candidate; when provided, bare-token search
  consults both English and localized via `matchesQuery` (diacritic +
  case folding).
- `src/components/cmd/IngredientForm.tsx` — added `nameEs` / `nameZh`
  fields to the form-values shape; new translation override TextInputs
  below the canonical name; debounced auto-fill via `translateOnSave`
  with `AbortController` cancellation. Updated the `categoryOptions`
  memo to read from the new `{ name; i18nNames }[]` shape.
- `src/components/cmd/IngredientFormDrawer.tsx` — wires `nameEs` / `nameZh`
  through `fromItem` (read) and `buildI18nNames` → `setCatalogI18nNames`
  (write, edit mode) / `addItem({ ..., i18nNames })` (create mode).
- `src/components/cmd/RecipeFormDrawer.tsx` — added `menuItemEs` /
  `menuItemZh` form fields, auto-fill UI, and side-channel
  `setRecipeI18nNames` PATCH on edit save.
- `src/components/cmd/PrepRecipeFormDrawer.tsx` — added `nameEs` /
  `nameZh` form fields, auto-fill UI, and side-channel
  `setPrepRecipeI18nNames` PATCH on edit save.
- `src/i18n/i18n.test.ts` — added the "spec 040 P3 adds no new t() keys"
  guard assertion confirming the chrome catalog is unchanged.

### Verification

- `npm run typecheck` exit 0.
- `npm run typecheck:test` exit 0.
- `npm test` — all 131 tests pass (26 new in `localizedName.test.ts`,
  plus the existing 105).
- Bundle build (`/node_modules/expo/AppEntry.bundle?platform=web`)
  returns HTTP 200 with 30 occurrences of `getLocalizedName` and 127
  occurrences of `i18nNames` — code is reachable.
- `preview_*` MCP browser tools were NOT available in this session;
  manual smoke per spec §Verification "Manual smoke (web + native, both)"
  remains to be exercised by the reviewer / user. The `DEEPL_API_KEY`
  operator step is required before the auto-fill path will return
  real translations — without it the edge function returns
  `{ error: 'translation_unavailable' }` and the form gracefully
  degrades to manual-fill (override fields stay editable, save still
  succeeds, no toast spam).

### Operator pre-deploy step (one-time, out-of-band)

```sh
supabase secrets set DEEPL_API_KEY=<key-from-deepl-pro-or-free-signup>
```

Until this is set, the edge function returns
`503 { error: 'translation_unavailable' }` and the form falls through
to manual override entry. Saves still work; suggestions just don't appear.
(Previously the missing-key case returned `'DEEPL_API_KEY not configured'`;
the post-review pass collapses this to the same client-visible
`'translation_unavailable'` string per the spec §4 contract — operator
surface for the missing-key case is the function logs.)

## Files changed (review pass — Critical + Should-fix fixes)

### Edge function

- `supabase/functions/translate-on-save/index.ts` —
  - Critical #1: removed the `escapeHtml(out)` wrap on the DeepL response.
    The function returns JSON, not HTML; React Native `<Text>` / `<TextInput>`
    consumers never interpret HTML, so the escape was corrupting names
    containing `& < > " '` (e.g. `Mom's Onion Rings`) into entity-encoded
    JSONB values. Updated the inline comment block to reflect the design
    rationale (JSON-only output is not an HTML rendering surface).
  - Critical #3: missing-`DEEPL_API_KEY` branch now returns
    `503 { error: 'translation_unavailable' }` instead of
    `'DEEPL_API_KEY not configured'`. The spec §4 contract collapses every
    upstream failure mode to the same client-visible string so the form
    doesn't render per-code UI branches.
  - Should-fix #4: tightened `sourceLocale` validation. The condition
    `!== undefined && !== 'en'` accidentally permitted callers to omit
    the field OR pass `null`; both are out-of-contract. Now also rejects
    `null` explicitly.
  - Removed the `escapeHtml` helper function (~10 lines).

### Frontend (form drawers)

- `src/components/cmd/PrepRecipeFormDrawer.tsx` —
  - Critical #2: removed the `setPrepRecipeI18nNames(prep.id, i18n)`
    side-channel PATCH from the edit branch of `handleSave`. The preceding
    `updatePrepRecipe(prep.id, payload)` routes through
    `db.updatePrepRecipeVersioned` which creates a NEW version row; the
    subsequent PATCH would target the now-archived stale row id (ghost
    write). The new version row already carries the i18n payload via the
    `updatePrepRecipe` call. Removed the now-unused
    `setPrepRecipeI18nNames` import from `useStore`.
  - Should-fix #3: threaded `ctrl.signal` through `translateOnSave` so a
    fresh keystroke aborts the in-flight DeepL fetch instead of just
    discarding the stale result.
- `src/components/cmd/RecipeFormDrawer.tsx` —
  - Should-fix #1: removed the `setRecipeI18nNames(recipe.id, i18n)`
    side-channel PATCH from the edit branch of `handleSave`. The preceding
    `updateRecipe(recipe.id, payload)` already includes `i18nNames` in its
    payload; the explicit PATCH was a redundant DB round-trip + second
    optimistic-update pass over the same column. Removed the now-unused
    `setRecipeI18nNames` import from `useStore`.
  - Should-fix #3: threaded `ctrl.signal` through `translateOnSave`.
- `src/components/cmd/IngredientForm.tsx` —
  - Should-fix #2: switched the translate-on-save handler from the
    `valuesRef.current` snapshot pattern to a functional updater
    (`onChange((prev) => ({ ...prev, nameEs, nameZh }))`). If the user
    edited other fields (e.g. category) between when DeepL started and
    resolved, those concurrent edits were getting clobbered by the stale
    `valuesRef.current` snapshot. Widened the `onChange` prop type to
    accept either a value or a functional updater (matching React's
    `Dispatch<SetStateAction>`); the only caller
    (`IngredientFormDrawer.tsx`) passes `setValues` directly which is
    already compatible with the wider type.
  - Should-fix #3: threaded `ctrl.signal` through `translateOnSave`.
- `src/screens/cmd/sections/CategoriesSection.tsx` —
  - Should-fix #3: threaded `ctrl.signal` through `translateOnSave`.

### Frontend lib (envelope plumbing)

- `src/lib/auth.ts` — `callEdgeFunction` now accepts an optional
  `{ signal?: AbortSignal }` options argument and forwards it into
  `fetch(..., { signal })`. Without this the form's `AbortController.abort()`
  only suppressed the stale result; the actual HTTP request kept running,
  burning DeepL quota on every rapid retype.
- `src/lib/db.ts` — `translateOnSave(text, targetLocales, signal?)` accepts
  the new optional signal parameter and threads it through `callEdgeFunction`.

### Migration

- `supabase/migrations/20260517000000_user_data_i18n_names.sql` —
  - Should-fix #5: corrected the inline comment "(10 typed args)" to
    "(11 typed args)". The `drop function if exists` at lines 131-133
    names 11 argument types; the comment was factually wrong.

### pgTAP

- `supabase/tests/user_data_i18n_names.test.sql` —
  - Bumped plan from `plan(15)` to `plan(17)`.
  - Added (2d) `recipe_categories: every existing row backfilled to
    non-null i18n_names`.
  - Added (2e) `ingredient_categories: every existing row backfilled to
    non-null i18n_names`.
  - All 17 assertions pass against the seeded local stack.

### Jest

- `src/lib/translate.test.ts` (new) — 7 cases covering the graceful-
  degrade contract of `translateOnSave`:
  - 200 + valid body resolves to `{ data: { translations }, error: null }`.
  - 503 + `'translation_unavailable'` (missing-key path) resolves to
    `{ data: null, error: 'translation_unavailable' }`.
  - 503 + `'translation_unavailable'` (all-locales-failed path) — same.
  - Fetch rejection resolves with the network error string (does NOT throw).
  - Missing session resolves with `'Not authenticated'` and never calls
    fetch.
  - `signal` argument threads into `fetch(..., { signal })`.
  - Request body matches the `{ text, sourceLocale: 'en', targetLocales }`
    spec contract.
  - Addresses the test-engineer's "NOT TESTED — DEEPL_API_KEY absent
    graceful degrade" note. The save path itself is independent of
    `translateOnSave`'s outcome, so a thrown error or a 503 must NOT
    break form submission; the resolves-on-every-failure contract this
    test pins is what ensures that.

### Spec amendment (test-engineer Critical Forms-AC9, Path 2)

- `specs/040-multi-language-support-p3-user-data.md` —
  - Forms-AC5 (the AC bullet listing form-side write sites) now explicitly
    notes that `recipe_categories.i18n_names` is **out of scope for this
    spec's UI write path**. The DB column, store action, and db.ts helper
    remain in scope as infrastructure-only.
  - Added a new "Out of scope" bullet enumerating the `recipe_categories`
    UI write-path deferral with rationale (frozen legacy `AdminScreens.tsx`;
    matching the Spec 038 AC-CHROME-5/6 and Spec 013 AC9 resolution
    pattern).
  - Added a "Known follow-up work" section describing the future Cmd UI
    recipe-categories management surface follow-up.
  - Updated the §In-scope "Form-side auto-fill" bullet to reflect the
    narrowed scope (`CategoriesSection` ingredient-categories pane only).

### Verification re-run

- `npm run typecheck` — exit 0.
- `npm run typecheck:test` — exit 0.
- `npm test` — 12 suites pass, 138 tests pass (7 new in
  `src/lib/translate.test.ts`; 131 → 138).
- `bash scripts/test-db.sh` — 22/22 DB test files pass, including
  `user_data_i18n_names.test.sql` (15 → 17 assertions).
- `bash scripts/smoke-edge.sh` — all 14 checks pass; no regression in
  the cross-function smoke suite.
- Web bundle build (`/node_modules/expo/AppEntry.bundle?platform=web`)
  serves HTTP 200; `getLocalizedName` and `translateOnSave` references
  reachable in the bundle. Live browser exercise of the
  `translate-on-save` happy path requires a full `supabase stop &&
  supabase start` so the edge runtime's
  `SUPABASE_INTERNAL_FUNCTIONS_CONFIG` env picks up the new function
  bundle (set at container creation time, not at restart) plus the
  out-of-band `supabase secrets set DEEPL_API_KEY=...` step. Static
  evidence: edge function file mounted into the runtime
  (`docker exec ... ls` shows `translate-on-save` in the functions
  list) and the jest test pins the call contract.

## Handoff (review pass)

next_agent: code-reviewer, test-engineer
prompt: Re-review the post-review-pass fixes for spec 040 P3. Three
  Critical findings + five Should-fix items + two Nits + one AC
  amendment have been addressed. See `## Files changed (review pass —
  Critical + Should-fix fixes)` for the per-file change list. Status
  remains `READY_FOR_REVIEW`. The original `backend-architect` and
  `security-auditor` files were already clean (0 Critical / Medium /
  High) — those reviewers were skipped on this pass to avoid
  redundancy. Verification: `npm run typecheck` (exit 0),
  `npm run typecheck:test` (exit 0), `npm test` (12 suites / 138
  tests pass), `bash scripts/test-db.sh` (22/22 DB tests pass,
  including 17 in `user_data_i18n_names.test.sql`),
  `bash scripts/smoke-edge.sh` (14/14 checks pass). Browser exercise
  of the `translate-on-save` happy path against the local stack
  requires a `supabase stop && supabase start` cycle (the edge
  runtime's `SUPABASE_INTERNAL_FUNCTIONS_CONFIG` env is set at
  container creation time, not at restart; the new function bundle
  was added after the initial start). The jest `translate.test.ts`
  pins the call contract end-to-end.
payload_paths:
  - specs/040-multi-language-support-p3-user-data.md
  - supabase/functions/translate-on-save/index.ts
  - supabase/migrations/20260517000000_user_data_i18n_names.sql
  - supabase/tests/user_data_i18n_names.test.sql
  - src/components/cmd/IngredientForm.tsx
  - src/components/cmd/RecipeFormDrawer.tsx
  - src/components/cmd/PrepRecipeFormDrawer.tsx
  - src/screens/cmd/sections/CategoriesSection.tsx
  - src/lib/auth.ts
  - src/lib/db.ts
  - src/lib/translate.test.ts

## Handoff (original design)

next_agent: backend-developer, frontend-developer
prompt: Implement spec 040 P3 against the design in
  `## Backend / architecture design`. Recommended phasing inside
  one PR (or split if review pressure warrants): P3a first
  (migration + types + helper/hook + read-site rewires + jest +
  pgTAP), then P3b (edge function + DEEPL_API_KEY contract +
  form auto-fill UI + store actions + db.ts partial-update
  functions). The categories slice-shape widening from `string[]`
  to `{ name; i18nNames }[]` is load-bearing fan-out — surface
  in the implementation summary. The
  `create_inventory_item_with_catalog` RPC must be re-created in
  the migration to thread `p_i18n_names`; pgTAP test covers this.
  DO NOT add `recipe_categories` or `ingredient_categories` to
  `supabase_realtime` — out of scope per §8. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  `## Files changed`. Include the operator one-time
  `supabase secrets set DEEPL_API_KEY=...` step in the summary so
  release-coordinator surfaces it.
payload_paths:
  - specs/040-multi-language-support-p3-user-data.md
  - specs/038-multi-language-support-p1-chrome.md
  - specs/039-multi-language-support-p2-enums.md
  - supabase/migrations/20260516000000_profiles_locale.sql
  - supabase/migrations/20260504060452_brand_catalog_p1_additive.sql
  - supabase/migrations/20260405000759_init_schema.sql
  - supabase/migrations/20260424211732_recover_undeclared_tables.sql
  - supabase/migrations/20260509000000_multi_brand_schema_rls.sql
  - supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql
  - supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql
  - supabase/migrations/20260514140000_realtime_publication_tighten.sql
  - supabase/functions/delete-user/index.ts
  - supabase/functions/send-invite-email/index.ts
  - src/lib/auth.ts
  - src/lib/db.ts
  - src/store/useStore.ts
  - src/i18n/index.ts
  - src/i18n/matchesQuery.ts
  - src/hooks/useT.ts
  - src/hooks/useLocale.ts
  - src/types/index.ts
