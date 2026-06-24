# Spec 100: Staff reorder (补货) screen localization completion

Status: READY_FOR_BUILD

## User story
As a store manager using the staff app in 中文 (zh-CN), I want the reorder /
补货 tab fully localized — item names and unit labels included — so the
replenishment screen reads the same way the EOD and Weekly screens already do
after the recent localization work.

## Background / what was reported
Recent commits localized the staff app (EN / ES / zh-CN), including a most-recent
commit that localized item names + category headers for the EOD + Weekly screens
only. The reorder (补货) tab was missed. In zh-CN the reorder tab still shows:

1. Item names ("4LB Brown Paper Bag", "Shrimp - Head Off") in English.
2. Unit labels ("在库 0.5 cases", "安全库存 2 cases", "在库 0 CASE",
   "安全库存 12 CASE") — the unit noun stays English AND the casing is
   inconsistent (lowercase "cases" vs uppercase "CASE").
3. Vendor grouping headers ("TAI TRADING COMPANY", "AMAZON") — vendor proper
   nouns.
4. The green "EOD" badge on each vendor card.

Correctly localized already (reference): tab bar, 退出登录, 刷新, 全部,
在库/安全库存/订购 labels, the reorder-buffer warning banner, the date.

## Investigation findings (code-confirmed)

### Gap 1 — item names: REAL BUG, requires RPC + screen change
- `src/screens/staff/screens/Reorder.tsx:150` renders `{item.itemName}` raw.
- EOD/Weekly resolve names via `getLocalizedName(item, locale)`
  (`src/i18n/localizedName.ts`) using a per-row `i18nNames` field they fetch
  client-side from `catalog_ingredients.i18n_names`
  (`EODCount.tsx:132`, `fetchItemsForVendor`).
- The reorder screen gets its data from the RPC `report_reorder_list`, mapped by
  `src/screens/staff/lib/fetchReorder.ts:mapReorderVendor`. That mapper has no
  `i18nNames` field because the RPC does not emit it:
  `supabase/migrations/20260602000000_reorder_suggested_cases.sql:480-504`
  joins `catalog_ingredients ci` (line 414) but the per-item
  `jsonb_build_object` only emits `item_name` (= English `ci.name`, line 482).
- **Consequence:** the localized names are not present in the payload at all.
  This is the architectural reason the EOD/Weekly fix could not be applied to
  reorder the same way. Fix requires (a) the RPC to emit `ci.i18n_names`,
  (b) `mapReorderVendor` + the shared `ReorderItem` type to carry it,
  (c) `Reorder.tsx` to resolve via `getLocalizedName(item, locale)`.

### Gap 2 — unit nouns + casing: REAL, two distinct sources
- "case"/"cases" in the 订购 (suggested-order) line is hardcoded ENGLISH in the
  SHARED pure util `formatSuggestedParts`
  (`src/utils/reorderExport.ts:54`, `const caseWord = cases === 1 ? 'case' : 'cases'`).
  That util is imported by BOTH the staff screen AND the admin desktop Reorder
  section, AND by the CSV / text / PDF export builders, whose output is
  documented byte-for-byte load-bearing.
- The "CASE" / "lb" tokens on the 在库 / 安全库存 lines are the RAW
  `item.unit` string (`Reorder.tsx:157-159`), which comes straight from the
  free-text `catalog_ingredients.unit` column — NOT an enum. There is no unit
  translation source in the schema, so it cannot be key-translated cleanly.
- The casing inconsistency the user saw is exactly these two different sources
  (util emits lowercase "cases"; raw DB column holds uppercase "CASE").

### Gap 3 — vendor names: INTENTIONAL (proper nouns) — OUT OF SCOPE
- Rendered raw at `Reorder.tsx:121` / chips at `:584`. No `i18n_names` exists for
  vendors anywhere in the schema. Localizing would require new schema + data.

### Gap 4 — "EOD" badge: localize (acronym, but cheap catalog key) — IN SCOPE
- `Reorder.tsx:102`: `vendor.onHandSource === 'eod' ? 'EOD' : t('reorder.source.stockFallback')`.
  The sibling "STOCK FALLBACK" already goes through the catalog; "EOD" is the
  one hardcoded acronym and gets the same treatment.

## Decisions locked (resolved with user 2026-06-23)

- **Q-A (unit nouns) → A2.** Localize the "case/cases" suggested-order noun AND
  display-normalize the raw `item.unit` token to lowercase on the staff render
  (CASE → case) so casing is consistent. No DB write — display-only.
- **Q-B (shared util safety) → B1.** Localize ONLY in the staff render path. Do
  NOT thread a locale/translator param through the shared `reorderExport.ts`
  util. The staff screen normalizes/localizes after calling the util (or via its
  own render path). Admin desktop UI and the byte-for-byte CSV/text/PDF exports
  stay unchanged.
- **Q-C (vendor + badge) → C2.** Localize the "EOD" badge only (add a catalog
  key, mirroring its "STOCK FALLBACK" sibling). Vendor names stay English
  (proper nouns) and are out of scope.

## Acceptance criteria
- [ ] In zh-CN, every item name on the reorder tab renders its `i18n_names['zh-CN']`
      value when present, falling back silently to the English `name` when absent
      (identical rule to EOD/Weekly via `getLocalizedName`).
- [ ] The reorder RPC `report_reorder_list` emits `i18n_names` per item;
      `mapReorderVendor` + the `ReorderItem` type carry it; the admin desktop
      Reorder section is unaffected (it maps by named fields and ignores the new
      key).
- [ ] In zh-CN (and es), the "case/cases" suggested-order noun renders localized
      on the staff reorder screen. The shared `reorderExport.ts` util is NOT
      modified — localization happens in the staff render path only.
- [ ] On the staff reorder render, the raw `item.unit` token (e.g. "CASE") is
      display-normalized to lowercase ("case"). This is display-only; no write to
      `catalog_ingredients.unit`.
- [ ] Admin desktop Reorder output and the CSV/text/PDF export bytes are
      byte-for-byte unchanged (verified: the shared util stays English and is
      untouched; localization + casing normalization are render-path only).
- [ ] The "EOD" badge renders localized in zh-CN / es (new catalog key, mirroring
      `reorder.source.stockFallback`).
- [ ] Vendor grouping headers and vendor chips remain English (no change).
- [ ] Locale switching on the reorder screen re-translates the newly-localized
      strings (item names, case noun, EOD badge) live — it already uses the
      reactive `useI18n()` t + reads the `locale` slice (the pattern spec 099
      established).
- [ ] New catalog keys exist in all three locales (en / es / zh-CN); the
      catalog-parity jest test sees them in all three.

## In scope
- Item-name localization on the staff reorder/补货 screen (RPC emits
  `i18n_names` + mapper + type + `getLocalizedName` in `Reorder.tsx`), matching
  the EOD/Weekly approach.
- Localizing the "case/cases" suggested-order noun in the staff render path only
  (Q-A=A2 / Q-B=B1) — a new staff catalog key, NOT a change to
  `reorderExport.ts`.
- Display-only lowercase normalization of the raw `item.unit` token on the staff
  reorder render (Q-A=A2) — no DB write.
- Localizing the "EOD" badge (Q-C=C2) — new catalog key.
- zh-CN + es + en catalog entries for any new keys (all three, per the
  catalog-parity rule).

## Out of scope (explicitly)
- The shared `src/utils/reorderExport.ts` util and its `formatSuggestedParts`
  signature — NOT modified (Q-B=B1). Rationale: it backs the admin desktop UI and
  the byte-for-byte CSV/text/PDF exports, which are load-bearing.
- Admin desktop Reorder section behavior and the CSV/text/PDF export format —
  left byte-for-byte unchanged. Rationale: load-bearing and outside the reported
  bug's surface.
- Vendor-name localization (Q-C=C2: vendors stay English). No i18n source exists
  for vendors; localizing them would be a separate schema+data effort.
- Any change to the stored `catalog_ingredients.unit` values — display-only
  lowercase normalization on render at most; no migration to the data.
- Full unit i18n via a known-unit translation map (the rejected Q-A=A4 option) —
  only the "case/cases" noun is key-localized; other raw unit tokens (e.g. "lb")
  are casing-normalized only, not translated.
- The EOD and Weekly screens — already localized; this spec only touches reorder.

## Open questions resolved
- Q-A (unit nouns): how far to take unit localization? → A2 — localize the
  "case/cases" noun AND display-normalize the raw `item.unit` casing
  (CASE → case). Fixes the reported casing inconsistency without a DB change.
- Q-B (shared util safety): how to localize the case noun without regressing the
  shared util's admin + export callers? → B1 — localize at the staff render path
  only; keep `reorderExport.ts` English and untouched.
- Q-C (vendor names + EOD badge scope): → C2 — localize the EOD badge only;
  vendor names stay English (proper nouns, out of scope).

## Dependencies
- `getLocalizedName` (`src/i18n/localizedName.ts`) — existing, reused.
- `catalog_ingredients.i18n_names` — existing column the RPC must surface.
- Shared `ReorderItem` type (`src/types`) and `mapReorderVendor`
  (`src/screens/staff/lib/fetchReorder.ts`).
- RPC migration superseding/extending `report_reorder_list`
  (current: `20260602000000_reorder_suggested_cases.sql`).
- Staff i18n catalogs (`src/screens/staff/i18n/{en,es,zh-CN}.json`).

## Project-specific notes
- Cmd UI section / legacy: neither — this is the STAFF surface
  (`src/screens/staff/screens/Reorder.tsx`), peer to cmd/.
- Per-store or admin-global: per-store. RPC already gated by
  `auth_can_see_store(store_id)`; no auth change.
- Realtime channels touched: none. Staff stack does not use realtime (spec 062).
- Migrations needed: YES — a new migration to make `report_reorder_list` emit
  `i18n_names` per item (additive; admin payload consumers tolerate the extra key
  because they map by named fields).
- Edge functions touched: none (PostgREST RPC path, not an edge function).
- Web/native scope: both (staff app ships web + native; no platform-only code).
- Tests: pgTAP track for the RPC shape change (assert `i18n_names` present in the
  per-item JSON); jest track for the screen/mapper localized-name resolution, the
  case-noun + casing-normalization render logic, and catalog-parity coverage of
  the new keys across all three locales.

## Backend design

### 0. Confirmation of locked scope against the code

All four decisions are code-confirmed against the current tree:

- The RPC's per-item `jsonb_build_object` (migration
  `20260602000000_reorder_suggested_cases.sql:480-504`) emits `item_name`
  (= `ci.name`, line 482/389) but never `ci.i18n_names`. The `ci` join is
  already present (line 414), so surfacing `i18n_names` is a zero-new-join,
  zero-new-scan change.
- The case noun lives only in the shared pure util
  (`reorderExport.ts:54` / `:68`) and the raw `item.unit` token renders verbatim
  at `Reorder.tsx:157-159`. Confirmed B1: the util must NOT change.
- The "EOD" literal at `Reorder.tsx:102` is the one hardcoded acronym; its
  sibling already reads `t('reorder.source.stockFallback')`.
- The localized-name pattern (`getLocalizedName(row, locale)` +
  `useStaffStore((s) => s.locale)`) is established verbatim by
  `EODCount.tsx:228/659` and `WeeklyCount.tsx:139` — reused, no new pattern.

### 1. Data model changes

**No table/column/index changes.** `catalog_ingredients.i18n_names` already
exists and is already SELECTed via the `ci` join in the RPC. The change is one
additive key in the RPC's per-item JSON projection.

**New migration:** `supabase/migrations/20260623000000_reorder_list_i18n_names.sql`
(adjust the timestamp to creation time; it must sort AFTER
`20260602000000_reorder_suggested_cases.sql`, which is the latest on-disk
definition of this function).

- `create or replace function public.report_reorder_list(uuid, jsonb)` —
  **additive, non-destructive.** Per the function's own header rule ("a future
  `create or replace` MUST copy the LATEST on-disk body, not the spec-021-era
  revision"), the body is copied **verbatim** from
  `20260602000000_reorder_suggested_cases.sql` with exactly two hunks:
  1. In the `per_item` CTE (around line 389-391), add to the select list:
     `ci.i18n_names as i18n_names` (alongside the existing `ci.name as item_name`).
     The column rides through `per_item_suggested` (`pi.*`) and
     `per_item_filtered` (`pis.*`) unchanged.
  2. In the vendor-rollup `jsonb_build_object` (around line 480-504), add ONE
     key: `'i18n_names', pif.i18n_names`. Place it immediately after
     `'item_name', pif.item_name` for readability. `i18n_names` is JSONB; a
     NULL catalog value serializes to JSON `null`, which the mapper coalesces
     to `{}`.

- **Rollout safety:** additive JSON key only. The function SIGNATURE is
  byte-identical, so `create or replace` PRESERVES the existing
  `revoke … from public, anon` + `grant … to authenticated` ACL — **no GRANT
  statements in the migration** (re-stating would be redundant churn; matches
  the existing migration's closing note).

**Admin-consumer safety (AC line 89-91).** The only two consumers of this RPC's
output both map by NAMED JSON fields and ignore unknown keys:
- Admin desktop: `src/lib/db.ts:mapReorderVendor` (feeds
  `src/screens/cmd/sections/ReorderSection.tsx`).
- Staff: `src/screens/staff/lib/fetchReorder.ts:mapReorderVendor` (verbatim copy).

Neither reads positionally; both pick specific keys off `it`. An extra
`i18n_names` key is inert for the admin path until the admin mapper opts in
(it will not — admin stays English per scope). **Adding the field is safe.**

### 2. RLS impact

**None.** No new table; no policy added or changed. The function is
`security invoker` and already gates on `auth_can_see_store(p_store_id)` as its
first statement (line 83-86). The `i18n_names` column is read from the same
`catalog_ingredients` row already SELECTed under the caller's RLS via the `ci`
join — no new row is exposed. Confirmed against the spec's own §Project-specific
notes ("per-store. RPC already gated by `auth_can_see_store(store_id)`; no auth
change").

### 3. API contract

**PostgREST RPC, unchanged transport.** Request and envelope shape are
identical; only the per-item object grows one key.

- Request: `report_reorder_list(p_store_id uuid, p_params jsonb)` — unchanged.
- Response envelope: `{ as_of_date, vendors[], kpis, _warnings }` — unchanged.
- Per-item object (inside `vendors[].items[]`) gains:
  - `i18n_names` — JSONB object, e.g. `{"zh-CN": "虾仁去头", "es": "Camarón sin cabeza"}`,
    or JSON `null` when the catalog row has no overrides.
- Error cases: unchanged — `42501` on RLS denial (propagates as a thrown
  PostgREST error → staff error pane). No new error path.

### 4. Edge function changes

**None.** This is the PostgREST RPC path, not an edge function. No
`config.toml` / `verify_jwt` change.

### 5. `src/lib/db.ts` surface

**No change to `db.ts`.** The staff Reorder screen does NOT route through
`db.ts` — it uses the sanctioned staff carve-out
(`src/screens/staff/lib/fetchReorder.ts`, documented in CLAUDE.md "DB access
centralized"). The admin `db.ts:mapReorderVendor` deliberately does NOT pick up
the new key (admin stays English, per scope). Leave it untouched.

**Type + mapper carry-through (the only TS-type change):**

- `src/types/index.ts` — extend `ReorderItem` (interface at line 736) with:
  ```ts
  /** Spec 100 — per-item localized-name overrides surfaced by the RPC from
   *  catalog_ingredients.i18n_names. Optional + defaults to {} so the admin
   *  path (which never reads it) and any old payload tolerate absence.
   *  Rendered via getLocalizedName(item, locale) on the staff reorder screen
   *  only; EOD/Weekly already do the same. */
  i18nNames?: LocalizedNames;
  ```
  (`LocalizedNames` is already imported/defined in this file at line 19. This
  mirrors the existing optional `i18nNames?` on `InventoryItem` / catalog
  types at lines 114/154/180/226.)

- `src/screens/staff/lib/fetchReorder.ts:mapReorderVendor` (line 47-67) — add to
  the per-item object:
  ```ts
  i18nNames: (it?.i18n_names ?? {}) as LocalizedNames,
  ```
  snake_case → camelCase: `i18n_names` → `i18nNames`; NULL/absent coalesces to
  `{}` so `getLocalizedName` falls through silently to English. Import
  `LocalizedNames` from `../../../types`.

  Note: the header comment in `fetchReorder.ts` says "If the report's per-item
  shape changes, BOTH copies update." The admin `db.ts:mapReorderVendor` copy is
  intentionally NOT updated here — admin stays English. The backend-developer
  should add a one-line note to that comment recording the intentional
  divergence (staff carries `i18nNames`, admin does not) so a future reader
  doesn't "fix" the asymmetry.

### 6. Realtime impact

**None.** The staff stack does not use realtime (spec 062; confirmed in the
spec's §Project-specific notes). No `supabase_realtime` publication membership
change in the migration → **no `docker restart supabase_realtime_imr-inventory`
dev step required.** This migration is publication-neutral.

### 7. Frontend store impact

**No `useStore.ts` (admin) slice change** and **no `useStaffStore` slice
change.** The screen reads the existing `locale` slice via
`useStaffStore((s) => s.locale)` (the exact pattern at `EODCount.tsx:228`). The
reorder data is screen-local `useState` (no store slice — per spec 089 decision
B), so the **optimistic-then-revert / `notifyBackendError` pattern does not
apply** (this is a read-only render-path localization change; no write path).

### 8. Staff-render-only localization strategy (Q-A=A2, Q-B=B1) — exact locations

`reorderExport.ts` stays byte-for-byte untouched. All three render changes live
in `src/screens/staff/screens/Reorder.tsx` (the `VendorCard` component,
lines 97-185):

1. **Item name (Gap 1).** Read `const locale = useStaffStore((s) => s.locale);`
   at the top of `VendorCard` (or hoist to the screen and thread down — match
   whichever EODCount does; EODCount reads it in the screen body). Replace the
   raw `{item.itemName}` at line 151 with
   `{getLocalizedName(item, locale)}`. `getLocalizedName` is total and takes
   `{ name?, menuItem?, i18nNames? }` — `ReorderItem` now satisfies it via
   `itemName`→ pass as `name`. **Adapter:** `getLocalizedName` reads `row.name`,
   but `ReorderItem` field is `itemName`. Pass a shaped object:
   `getLocalizedName({ name: item.itemName, i18nNames: item.i18nNames }, locale)`.
   (Do NOT widen `getLocalizedName` to read `itemName` — keep the helper's
   five-entity contract intact; the callsite adapts.)

2. **Case noun (Gap 2, Q-A=A2 / Q-B=B1).** `formatSuggestedParts(item)` still
   returns the English `main`/`sub` from the shared util. The staff screen
   localizes the case NOUN in its own render path WITHOUT touching the util.
   The recommended shape: stop consuming the util's English case word and
   instead build the suggested string from the server-authoritative numeric
   fields already on `ReorderItem` (`suggestedCases`, `suggestedUnits`,
   `suggestedQty`, `unit`) using two NEW staff catalog keys (see §9). Concretely
   in `VendorCard`, replace the use of `suggested.main` / `suggested.sub`
   (lines 140, 162-167) with a small screen-local helper, e.g.:
   ```ts
   // pseudocode — NOT committed util code
   function suggestedMain(item, t, locale) {
     if (item.suggestedCases != null) {
       return t('reorder.unit.cases', { count: item.suggestedCases }); // ICU-ish: 1→case, n→cases
     }
     return `${formatQty(item.suggestedQty)} ${normalizeUnit(item.unit)}`;
   }
   function suggestedSub(item) {
     return item.suggestedCases != null
       ? `${formatQty(item.suggestedUnits)} ${normalizeUnit(item.unit)}`
       : null;
   }
   ```
   The staff `t()` does not do ICU plural selection, so model the case noun as
   two keys (`reorder.unit.case` singular / `reorder.unit.cases` plural) and
   branch on `count === 1` in the helper — mirroring the util's own
   `cases === 1 ? 'case' : 'cases'` test. `formatQty` is still imported from the
   shared util (pure number formatting — locale-neutral, fine to reuse).

   This leaves `reorderExport.ts` and all admin/export callers untouched
   (AC line 98-100): the staff screen no longer renders the util's `main`/`sub`
   STRINGS for the case path, it composes localized strings from the same
   numeric fields the util reads.

3. **Unit casing normalization (Gap 2, Q-A=A2, display-only).** Add a tiny
   screen-local pure helper in `Reorder.tsx`:
   `const normalizeUnit = (u: string) => u.trim().toLowerCase();`
   Apply it everywhere the raw `item.unit` is rendered on this screen — the
   breakdown line (lines 157-159: the `onHand`/`par` interpolations) and the
   suggested sub/non-case main (above). **Display-only — never written back to
   `catalog_ingredients.unit`** (AC line 95-97). Do NOT apply it inside the
   shared util or the export builders (those keep the raw `unit`, byte-for-byte).

4. **EOD badge (Gap 4, Q-C=C2).** At `Reorder.tsx:102` replace the hardcoded
   `'EOD'` with `t('reorder.source.eod')` (new key, §9), mirroring the existing
   sibling `t('reorder.source.stockFallback')`.

All of these are reactive: `VendorCard` already calls `useI18n()` (line 100) for
`t`, and reading `useStaffStore((s) => s.locale)` subscribes the component to
locale changes — so a live switch re-renders item names, the case noun, and the
badge (AC line 105-107; the spec-099 pattern).

### 9. New staff i18n catalog keys (all three locales — en / es / zh-CN)

Added under the existing `reorder` namespace in
`src/screens/staff/i18n/{en,es,zh-CN}.json`. The catalog-parity jest test
requires identical key sets across all three.

| Key                        | en              | es                | zh-CN     |
|----------------------------|-----------------|-------------------|-----------|
| `reorder.source.eod`       | `EOD`           | `EOD`             | `EOD`     |
| `reorder.unit.case`        | `{count} case`  | `{count} caja`    | `{count} 箱` |
| `reorder.unit.cases`       | `{count} cases` | `{count} cajas`   | `{count} 箱` |

(Translations above are an architect's first pass; the frontend-developer should
confirm the es/zh-CN noun choices. zh-CN has no plural form, so `case`/`cases`
collapse to the same string but BOTH keys must exist for parity and so the
EN/ES singular/plural branch works. `reorder.source.eod` stays the literal
acronym "EOD" in all three — it is a defined term, mirroring how the admin
exports keep "EOD"; localizing the badge here just routes it through the catalog
so it is catalog-managed, not so its value differs per locale.)

### 10. Risks and tradeoffs

- **Migration ordering (Critical to get right).** The new migration MUST copy
  the body from the LATEST on-disk definition
  (`20260602000000_reorder_suggested_cases.sql`), not the spec-021 original. The
  function header documents this trap explicitly. Copying an older body would
  silently revert the spec-087 EOD-first logic and spec-088 case math. The
  pgTAP shape test guards the new `i18n_names` key but does NOT guard against a
  stale-body copy — code review must verify the diff is exactly the two additive
  hunks in §1.
- **Mapper divergence.** `fetchReorder.ts:mapReorderVendor` is a verbatim copy
  of `db.ts:mapReorderVendor` by design. This change intentionally diverges them
  (staff gains `i18nNames`, admin does not). Documented in §5 — flag in the
  comment so it is not "repaired" later.
- **`getLocalizedName` adapter.** `ReorderItem.itemName` ≠ the helper's expected
  `name` field. The callsite must shape `{ name: item.itemName, i18nNames }`.
  Forgetting the adapter (passing `item` directly) yields silent English-only
  (helper reads `row.name` which is undefined → falls to `''` then canonical
  `''`). Jest must cover the zh-CN-present and absent cases through the actual
  callsite shape.
- **Performance on the 286 KB seed.** Negligible. `i18n_names` is already
  fetched by the `ci` join; emitting it adds one JSONB key per item row to the
  payload. No new scan, no new join, no index need.
- **Export byte-stability (AC line 98-100).** The risk is a developer
  "simplifying" by threading locale into the shared util. The design forbids it;
  the existing jest export-bytes tests (CSV/text/PDF) are the guard and must
  stay green unchanged.
- **Edge function cold-start.** N/A — no edge function touched.

### 11. Backend vs frontend work split (for dispatch)

**Backend (backend-developer):**
- New migration `supabase/migrations/20260623000000_reorder_list_i18n_names.sql`
  — verbatim copy of the latest body + the two additive hunks in §1.
- pgTAP test asserting the per-item JSON carries `i18n_names` (present as an
  object when the catalog row has overrides; JSON `null`/absent tolerated when
  not).

**Frontend (frontend-developer):**
- `src/types/index.ts` — add `i18nNames?: LocalizedNames` to `ReorderItem`.
- `src/screens/staff/lib/fetchReorder.ts` — map `i18n_names → i18nNames` in
  `mapReorderVendor`; annotate the intentional admin divergence.
- `src/screens/staff/screens/Reorder.tsx` — read `locale`; localize item name
  via `getLocalizedName` adapter; localize the case noun via the new keys +
  screen-local helper (NOT the shared util); `normalizeUnit` casing
  display-fix; localize the EOD badge.
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — the three new keys in §9.
- jest: localized-name resolution through the callsite shape; case-noun
  singular/plural + casing-normalization render logic; catalog-parity across
  all three locales.

These are sequential-ish (frontend mapper change is harmless before the
migration lands because `i18n_names` simply arrives as absent → `{}`), so they
can be dispatched in parallel.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend: the
  additive `create or replace` migration for `report_reorder_list` (verbatim
  copy of the latest on-disk body + the two additive `i18n_names` hunks in §1)
  plus a pgTAP shape assertion. Frontend: the `ReorderItem` type field, the
  `fetchReorder.ts` mapper carry-through, the four render-path changes in
  `Reorder.tsx` (item name via getLocalizedName adapter, case noun via new keys
  + screen-local helper leaving reorderExport.ts untouched, unit-casing
  normalization, EOD badge), the three new catalog keys across en/es/zh-CN, and
  jest coverage. Do NOT modify `src/utils/reorderExport.ts` or
  `db.ts:mapReorderVendor`. After implementation, set Status: READY_FOR_REVIEW
  and list files changed under ## Files changed.
payload_paths:
  - specs/100-staff-reorder-localization-completion.md

## Files changed (frontend — spec 100)

- `src/types/index.ts` — added optional `i18nNames?: LocalizedNames` to the
  `ReorderItem` interface (mirrors the existing optional `i18nNames?` on the
  catalog/inventory types; `LocalizedNames` already imported in this file).
- `src/screens/staff/lib/fetchReorder.ts` — `mapReorderVendor` now maps
  per-item `i18n_names → i18nNames` (coalesced to `{}` so it's harmless before
  the RPC migration lands / when a catalog row has no overrides); imported
  `LocalizedNames`; annotated the intentional admin (`db.ts`) divergence in the
  header comment. Admin `db.ts:mapReorderVendor` was NOT touched.
- `src/screens/staff/screens/Reorder.tsx` — render-path localization only:
  - read the reactive `locale` slice in `VendorCard`;
  - item names via `getLocalizedName({ name: item.itemName, i18nNames }, locale)`
    (adapter — `ReorderItem.itemName` ≠ the helper's `name` field);
  - new screen-local `normalizeUnit` (display-only `CASE → case`) applied to the
    breakdown line + the composed suggested strings;
  - new screen-local `suggestedMainLabel` / `suggestedSubLabel` that compose the
    case-noun string from the server-authoritative numeric fields via the new
    `reorder.unit.case` / `reorder.unit.cases` keys (NOT the shared
    `reorderExport.ts` strings — that util is untouched);
  - EOD badge routed through the new `reorder.source.eod` key;
  - dropped the now-unused `formatSuggestedParts` import (kept `formatMoney`,
    `formatQty`).
- `src/screens/staff/i18n/en.json` — added `reorder.source.eod`,
  `reorder.unit.case`, `reorder.unit.cases`.
- `src/screens/staff/i18n/es.json` — same three keys (es translations).
- `src/screens/staff/i18n/zh-CN.json` — same three keys (zh-CN translations;
  case/cases collapse to `{count} 箱` — no plural form — but both keys exist
  for catalog parity).
- `src/screens/staff/screens/Reorder.test.tsx` — added a `localization (spec
  100)` describe: item name in zh-CN, English fallback when the override is
  missing, plural + singular case-noun in es, unit-casing normalization on the
  breakdown + non-case order line, and the EOD/STOCK-FALLBACK badge routing.
  Added `locale: 'en'` reset to `beforeEach`.
- `src/screens/staff/lib/fetchReorder.test.ts` — added mapper coverage for
  `i18n_names → i18nNames` (present) and the `{}` coalesce (missing / null).

NOT modified (by design): `src/utils/reorderExport.ts` (decision B1 — the shared
admin + byte-for-byte export builder; `reorderExport.test.ts` stays green
unchanged) and `src/lib/db.ts:mapReorderVendor` (admin stays English).

## Files changed

> Status NOTE: backend portion (§11 backend split) is COMPLETE and verified
> against the local stack (migration applies cleanly; new pgTAP test + all four
> existing `report_reorder_list_*` pgTAP tests pass). `Status:` is intentionally
> left at READY_FOR_BUILD pending the parallel frontend portion (§11 frontend
> split) so the spec is only flipped to READY_FOR_REVIEW once BOTH halves land.

### migrations
- `supabase/migrations/20260623000000_reorder_list_i18n_names.sql` — additive
  `create or replace public.report_reorder_list(uuid, jsonb)`. Body copied
  verbatim from the latest on-disk definition
  (`20260602000000_reorder_suggested_cases.sql`) with exactly two additive
  hunks: (1) `ci.i18n_names as i18n_names` in the `per_item` CTE; (2)
  `'i18n_names', pif.i18n_names` in the vendor-rollup `jsonb_build_object`
  (placed immediately after `item_name`). No signature change → ACL preserved,
  no GRANT statements. No RLS / realtime / publication change.

### tests (pgTAP track)
- `supabase/tests/report_reorder_list_i18n_names.test.sql` — 7 assertions pinning
  the new per-item `i18n_names` key: present + value-equal for a catalog row with
  overrides; present + `{}` for a default (empty) catalog row; JSON-object type
  guard on both. Mirrors `report_reorder_list_cases.test.sql` fixture/JWT/rollback
  shape.
