# Spec 100: Staff reorder (补货) screen localization completion

Status: READY_FOR_ARCH

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
