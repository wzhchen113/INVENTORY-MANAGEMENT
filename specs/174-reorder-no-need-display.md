# Spec 174: Show NO NEED instead of a stale on-hand in reorder exports and on the phone Ordering card

Status: READY_FOR_REVIEW

Origin: the display-only follow-up named in spec 172 §11 **OQ-B** ([specs/172-eod-no-need.md](172-eod-no-need.md), §11 and the "Pre-existing issues observed" list in the frontend implementation notes). The owner approved the scope and decisions D1 and D2 below in chat on 2026-10-23, before this spec was written. They are recorded as resolved. No questions remain open.

**Numbering:** spec 173 belongs to a separate in-flight session (`specs/173-catalog-update-error-surfacing*`). This spec does not touch it.

**Sequencing:** this spec builds on spec 172 (commit `f7b2759`). It needs no migration and no RPC change, because the `no_need` token is already in `ReorderItem.flags`. Line numbers below are from `main` at `f7b2759`. Treat them as pointers.

## User stories

1. As a **manager exporting the reorder list** (CSV or PDF, desktop or phone), I want a row that was counted NO NEED to say "NO NEED" in its On Hand cell. The number printed there today is a stale `current_stock` that may be days old, and the export should not imply it is today's count.
2. As a **staff member sharing the reorder list** (CSV, text, or PDF), I want the same: a NO NEED row says NO NEED instead of an old on-hand figure.
3. As a **manager adjusting an order on the phone**, I want to see that an item was counted NO NEED when I step its quantity up from 0. Then I know I am overriding a "we have more than enough" call, not filling a gap.

## Current state (verified 2026-10-23, `main` at `f7b2759`)

**The flag.** `report_reorder_list` emits the token `'no_need'` in `ReorderItem.flags` for a NO NEED row (spec 172 hunk R4).
- The constant is `REORDER_FLAG_NO_NEED = 'no_need'` in [src/lib/eodNoNeed.ts:27](../src/lib/eodNoNeed.ts). The staff subtree re-exports it through `src/screens/staff/lib/eodNoNeed.ts`.
- A NO NEED row has `suggestedQty = suggestedUnits = estimatedCost = 0` and `needsOrder = false`.
- Its `onHand` is the last numeric `current_stock`, which a NO NEED mark never updates (spec 172 AC-8, Risks "Stale on-hand").

**Already done in spec 172 (not touched here):**
- Desktop `BreakdownLine` ([ReorderSection.tsx:155-187](../src/screens/cmd/sections/ReorderSection.tsx)) shows `T('section.reorder.noNeed')` in the `on hand` segment for a flagged row (L162, L170).
- Desktop `FlagChip` ([ReorderSection.tsx:235-271](../src/screens/cmd/sections/ReorderSection.tsx)) maps the token to a hardcoded-English `'NO NEED'` pill, `tone: 'fg3'` (L242). The fg3 pill style is: transparent background, hairline `C.border` border, pill radius, `mono(600)` 9 px text in `C.fg3`. `FlagChip` is module-private (not exported).
- Staff [Reorder.tsx](../src/screens/staff/screens/Reorder.tsx) shows `tt('reorder.item.noNeed')` in place of the on-hand figure (`inStockLabel` ~L113-123 and the breakdown ~L269).

**Gaps. Each one prints `item.onHand` for every row, flagged or not:**

| # | Surface | Site | What prints today |
|---|---|---|---|
| G1 | Admin CSV, `buildReorderCsv` | [src/utils/reorderExport.ts:194-261](../src/utils/reorderExport.ts), `[cOnHand]: item.onHand` at L243 | The raw number. The Flags column (L255) already carries `no_need`. |
| G2 | Admin jsPDF, `handlePdfExport` | [ReorderSection.tsx:1194-~1430](../src/screens/cmd/sections/ReorderSection.tsx), needs table L1321 and have-enough table L1329 | `formatQty(item.onHand)` in both tables. |
| G3 | Shared PDF-HTML, `buildReorderPdfHtml` | [src/utils/reorderExport.ts:328-403](../src/utils/reorderExport.ts), L351 | `formatQty(item.onHand)`. It has no live caller outside jest: staff `shareReorder.ts` uses the staff builder. It is fixed here for consistency. |
| G4a | Staff CSV, `buildStaffReorderCsv` | [src/screens/staff/lib/reorderExportStaff.ts:48-99](../src/screens/staff/lib/reorderExportStaff.ts), L86 | The raw number. |
| G4b | Staff share text, `buildStaffReorderText` | same file, have-enough line L153-159 | en: `  - {itemName}: on hand {qty} {unit}`. Other locales: `reorderExport.onHandLine` (`"on hand {qty} {unit}"` / `"en existencia …"` / `"现有 …"`). |
| G4c | Staff PDF-HTML, `buildStaffReorderPdfHtml` | same file, L226 | `formatQty(item.onHand)`, in both the needs and have-enough tables. |
| G5 | Admin phone Ordering card, `VendorOrderCard` | [src/screens/cmd/sections/phone/PhoneOrdering.tsx:155-~540](../src/screens/cmd/sections/phone/PhoneOrdering.tsx) | No on-hand figure anywhere. The line filter (L195-197) is `suggestedUnits > 0 \|\| itemId in vendorEdits`, so an unedited NO NEED row is hidden. A row the manager stepped up renders like any other line, with **no indication** that it was counted NO NEED. `PhoneApproveOrder.tsx` renders the same exported card. |

**Not a gap:**
- `buildReorderText` ([reorderExport.ts:275-308](../src/utils/reorderExport.ts)) prints no on-hand.
- The phone overflow sheet's CSV and PDF actions (PhoneOrdering.tsx ~L643, ~L660) call the desktop `handleCsvExport` / `handlePdfExport`, so fixing G1 and G2 covers the phone exports.
- A `src/` grep for `.onHand` (non-test) finds no other export or reorder display site. The remaining hits are spec 151's `lastOrderContext` delta (already gated by spec 172 AC-37) and menu-capacity math, which is unrelated.

**Facts that shape the ACs:**
- **Admin jsPDF forces English for zh-CN** ([ReorderSection.tsx:1200-1205](../src/screens/cmd/sections/ReorderSection.tsx)). The reason is that jsPDF's built-in Helvetica has no CJK glyphs; the owner made this call in 2026-07. In a zh-CN session that PDF is all-English, so its NO NEED label is the English one. The es admin PDF is localized. The CSV, the staff text, and the staff HTML PDF are fully localized, zh-CN included.
- **`buildReorderPdfHtml` takes no `locale`.** It is English-only today.
- **All builders, the staff builders included, resolve labels through the admin root catalog** (`t` from `src/i18n`, `reorderExport.*` at en.json ~L1812). The staff catalog key `reorder.item.noNeed` ("No need") is not reachable from them as written.
- **Existing NO NEED keys:**
  - admin root `section.reorder.noNeed`: en "NO NEED", es "NO HACE FALTA", zh-CN "无需" (en.json ~L1243);
  - admin `section.eod.export.noNeed`, with the same values (~L710);
  - staff `reorder.item.noNeed`: "No need" / "No hace falta" / "无需".
  - There is no `reorderExport.noNeed` key.
- **CSV injection guard.** The admin CSV goes through `unparseCsvSafe`, which prefixes only string cells that start with `= + - @ \t \r`. None of the NO NEED labels start that way. The staff CSV calls `Papa.unparse` directly. That is pre-existing and unchanged.

## Definitions

- **NO NEED row:** a `ReorderItem` whose `flags` array includes `REORDER_FLAG_NO_NEED` (`'no_need'`). Nothing else marks a row NO NEED. In particular, `suggestedQty === 0` or `needsOrder === false` alone does not.
- **NO NEED label:** the localized string printed in place of the on-hand value. The en value is "NO NEED". Its es and zh-CN values come from the catalog key the architect picks (see D2 and N3). Reusing `section.reorder.noNeed` gives "NO HACE FALTA" / "无需".

## Acceptance criteria

All jest. There is no pgTAP or shell-smoke track, because there is no DB change.

### Shared rule

- [ ] **AC-1:** Every surface in G1-G4 decides "is this a NO NEED row" with `item.flags` (null-safe, as `(item.flags || [])` is today) `.includes(REORDER_FLAG_NO_NEED)`. It imports the spec 172 constant from `src/lib/eodNoNeed.ts` (admin) or the staff barrel (staff). No new literal `'no_need'` is added outside `eodNoNeed.ts`. A tiny shared predicate such as `isReorderNoNeed(item)` is allowed; where it lives is the architect's call.

### Admin CSV, `buildReorderCsv` (G1)

- [ ] **AC-2:** For a NO NEED row, the On Hand cell is the NO NEED label for the requested locale: en "NO NEED"; es and zh-CN are the localized label. The cell does not contain the `onHand` number.
- [ ] **AC-3:** For that same row, every other cell is unchanged: Vendor, Needs Order, Item Name, Pending PO, Par Level, Suggested Qty, Cases, Units Per Case, Unit, Est. Cost, Flags (still the raw `no_need` token), and EOD Counted At.
- [ ] **AC-4:** For a payload with no NO NEED rows, the CSV output is **byte-identical** to before in en, es, and zh-CN. Existing `src/utils/reorderExport.test.ts` assertions and snapshots pass unmodified.

### Admin jsPDF, `handlePdfExport` (G2)

- [ ] **AC-5:** With `jspdf` / `jspdf-autotable` mocked (the `ReorderSection.resetAfterExport.spec138.test.tsx` idiom), capture the `body` passed to `autoTable`. For a NO NEED row, the On Hand column (index 1) is the NO NEED label in whichever table the row appears in (needs or have-enough). Item, Pending, Par, Suggested, Unit (have-enough only), and Est. Cost cells are unchanged.
- [ ] **AC-6:** Locale behavior:
  - with `localeIn = 'es'`, the label is the es label;
  - with `localeIn = 'zh-CN'`, the label is the **English** "NO NEED", consistent with the existing whole-PDF English fallback (L1200-1205). No CJK glyph is passed to jsPDF.
- [ ] **AC-7:** For a payload with no NO NEED rows, the captured `head` and `body` arrays are deep-equal to before. Existing ReorderSection export tests pass unmodified.

### Shared PDF-HTML, `buildReorderPdfHtml` (G3)

- [ ] **AC-8:** For a NO NEED row, the On Hand `<td class="num">` contains the English NO NEED label, HTML-escaped through the file's existing `escapeHtml`, and no `onHand` number. The other six cells in the row are unchanged. The builder's signature is unchanged (no `locale` parameter is added; see Out of scope).
- [ ] **AC-9:** For a payload with no NO NEED rows, the output is byte-identical to before.

### Staff builders, `reorderExportStaff.ts` (G4)

- [ ] **AC-10 (CSV, G4a):** `buildStaffReorderCsv` follows the AC-2 / AC-3 / AC-4 rules for its own column set: the On Hand cell is the NO NEED label, and Needs Order, Item Name, Pending PO, Par Level, Suggested Qty, Cases, Units Per Case, Unit, Flags, and EOD Counted At are unchanged. Numeric-only output is byte-identical in all three locales.
- [ ] **AC-11 (share text, G4b):** In the HAVE ENOUGH STOCK section, a NO NEED row's line replaces the on-hand phrase with the label and prints no on-hand number and no unit.
  - en: `  - {itemName}: NO NEED`.
  - es / zh-CN: `  - {localized name}: {localized label}`. The architect may define the exact template through a new key, but the line must not contain "on hand" / "en existencia" / "现有" or the `onHand` number.
  - The NEEDS TO ORDER line format is unchanged. A NO NEED row only reaches that section if `needsOrder !== false`, which the RPC never emits for it.
  - Every non-NO-NEED line, the headers, and the footer are byte-identical to before.
- [ ] **AC-12 (PDF-HTML, G4c):** In `buildStaffReorderPdfHtml`, a NO NEED row's On Hand `<td>` contains the escaped, localized label (en / es / zh-CN), in whichever section box it appears. Item, Pending, Par, Suggested, and Unit (enough box only) are unchanged. Numeric-only output is byte-identical in all three locales.
- [ ] **AC-13:** Existing `src/screens/staff/lib/reorderExportStaff.test.ts` assertions and snapshots pass unmodified.

### Admin phone Ordering card, `VendorOrderCard` (G5, D1)

- [ ] **AC-14:** When a NO NEED row is in the card's displayed `lines` (that is, it has an entry in `vendorEdits`), its line (`phone-order-line-<itemId>`) renders a tag with testID `phone-order-noneed-<itemId>`.
  - The text is `T('section.reorder.noNeed')`, so it is localized: "NO NEED" / "NO HACE FALTA" / "无需".
  - It sits under or beside the item name, inside the name column. The exact placement is the architect's or frontend's call.
- [ ] **AC-15:** The tag uses the desktop fg3 flag-pill styling (transparent background, hairline `C.border` border, pill radius, `mono(600)` ~9 px `C.fg3` text) through theme tokens only, with no inline hex. Whether to export `FlagChip` or add a phone-local pill is the architect's call. It is non-interactive and does not push the stepper or the cost column off a 390 px row: the item name keeps `numberOfLines={1}` truncation.
- [ ] **AC-16:** A displayed line that is **not** a NO NEED row renders no `phone-order-noneed-*` node.
- [ ] **AC-17:** The line filter is unchanged. An **unedited** NO NEED row (`suggestedUnits === 0`, no `vendorEdits` entry) renders neither `phone-order-line-<itemId>` nor `phone-order-noneed-<itemId>`. The card stats line (lines, cases, est) is computed exactly as before.
- [ ] **AC-18:** `PhoneApproveOrder.tsx` is not edited. It inherits the tag because it renders the same `VendorOrderCard`, and its existing tests pass unmodified.
- [ ] **AC-19:** A new phone render test (under `src/screens/cmd/sections/phone/__tests__/`, following the `PhoneOrdering.lastOrderContext.spec151.test.tsx` idiom) covers AC-14, AC-16, and AC-17. That means a NO NEED row with an edit (tag shown), the same row without an edit (no line, no tag), and a non-flagged edited row (no tag). Existing PhoneOrdering tests pass unmodified.

### Regression and gates

- [ ] **AC-20:** The label replaces the on-hand value **only** for NO NEED rows. A row with `onHand === 0`, `suggestedQty === 0`, or `needsOrder === false` but no `no_need` flag prints its number exactly as today. Each builder test file includes one such "zero but not NO NEED" arm.
- [ ] **AC-21:** If a new i18n key is added, it exists in all three locale catalogs with matching shape, and the admin and staff i18n key-parity tests pass. If only existing keys are reused, no catalog changes.
- [ ] **AC-22:** Full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` all pass. Every pre-existing assertion is unmodified.
- [ ] **AC-23:** **Browser check** on the local stack (`npm run dev:db`, admin@local.test), phone width (390 px), Ordering:
  - for a vendor with a NO NEED item, step that item up with `+`;
  - the line appears with the NO NEED tag under or beside its name, and no other line shows a tag;
  - from the same card's overflow, export CSV and PDF and confirm the On Hand cell reads NO NEED for that item;
  - no console errors.

  Seed and clean up test data as spec 172's frontend notes did, restoring touched rows to the pre-run snapshot.

## In scope

- `src/utils/reorderExport.ts`: `buildReorderCsv` and `buildReorderPdfHtml` (G1, G3).
- `src/screens/cmd/sections/ReorderSection.tsx`: `handlePdfExport` body rows (G2). If the architect chooses to share the fg3 pill with the phone, an `export` of `FlagChip` or an extracted pill component is also in scope.
- `src/screens/staff/lib/reorderExportStaff.ts`: all three builders (G4).
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: the `VendorOrderCard` line tag (G5, D1).
- New jest arms or files for every builder and the phone card. New test files are preferred, so existing suites stay byte-untouched (the spec 172 idiom).
- At most one new i18n key per namespace if the architect decides an export key is needed, added to `src/i18n/{en,es,zh-CN}.json` (and the staff catalogs only if a staff key is added).

## Out of scope (explicitly)

- **Any DB, RPC, or migration change.** The `no_need` flag is already in the payload. `report_reorder_list` is untouched.
- **Un-hiding NO NEED rows on the phone card,** or any change to its `suggestedUnits > 0 || edited` line filter (D1).
- **Staff `Reorder.tsx` and the desktop `BreakdownLine` / `FlagChip`.** Done in spec 172 (AC-36 / AC-38). The desktop chip stays hardcoded English, per the existing chip convention.
- **Adding a `locale` parameter to `buildReorderPdfHtml`.** It has no live caller, and localizing it is a separate change. It gets the English label only (AC-8).
- **Moving the admin jsPDF onto a CJK-capable engine.** That is the pre-existing 2026-07 follow-up. zh-CN keeps the English PDF (AC-6).
- **`buildReorderText`.** It prints no on-hand.
- **Changing the CSV column set,** adding a NO NEED column, or dropping the raw `no_need` from Flags. The Flags cell is unchanged (AC-3).
- **Showing an on-hand figure on the phone card** for any row. It shows none today, and the tag is a flag, not a quantity.
- **The staff text builder's pre-existing en-path use of `item.itemName`** instead of the localized name. It is unrelated to NO NEED and stays as is.
- **The staff CSV's lack of `csvSafeCell` guarding.** Pre-existing. The NO NEED labels never start with a formula meta-character.
- **`app.json` slug.** Not touched.

## Open questions resolved (owner-approved, 2026-10-23)

- Q: Scope of the follow-up? → A: The spec 172 §11 OQ-B gaps only. That means the admin CSV and jsPDF, the shared `buildReorderPdfHtml`, the three staff builders, and the phone Ordering card. Display only, with no DB or RPC change.
- **D1 (phone).** Q: How should the phone card handle a NO NEED row? → A: When a NO NEED row is visible on the card (because it was edited), show a small NO NEED tag on that line, under or beside the item name, styled like the desktop fg3 flag pill. Hidden rows stay hidden. Do not change the line filter.
- **D2 (exports).** Q: What should an export print for a NO NEED row's on-hand? → A: Every export that prints an on-hand cell or line prints the NO NEED label instead for a flagged row: the admin CSV, the admin PDF, the shared `buildReorderPdfHtml`, and all three staff builders. Numeric rows are unchanged byte-for-byte. Reuse the spec 172 flag constant and the existing i18n keys where possible (`section.reorder.noNeed`; staff `reorder.item.noNeed`). If an export namespace needs its own key, the architect decides.

## Notes for architect (non-blocking)

- **N1. zh-CN admin PDF.** The caller asked that the label be checked in zh-CN. Verified: `handlePdfExport` rewrites `zh-CN` to `en` before any label lookup (L1205), so the zh-CN admin PDF prints the English "NO NEED". This matches the rest of that PDF and avoids feeding CJK glyphs to Helvetica. AC-6 pins it. Every other export is localized in zh-CN.
- **N2. Label source for the staff builders.** They import the admin `t`, so `section.reorder.noNeed` ("NO NEED", uppercase) is reachable with no new key. The staff on-screen label `reorder.item.noNeed` ("No need", sentence case) lives in the staff catalog, which these builders do not import today. The options are:
  - (a) reuse `section.reorder.noNeed` everywhere. This needs no new keys, but staff exports say "NO NEED" while the staff screen says "No need";
  - (b) add `reorderExport.noNeed` to the admin root catalog for all export builders, admin and staff;
  - (c) import the staff catalog into the staff builders.

  Your call. AC-21 covers parity if a key is added. Whatever you pick, the en value in exports must be "NO NEED" or match what you pin in the tests.
- **N3. The staff text template for non-en** (AC-11). `reorderExport.onHandLine` cannot be reused for a NO NEED line (it embeds `{qty} {unit}`). Either print `{name}: {label}` directly or add a key. Your call.
- **N4. CSV cell type.** The On Hand cell becomes a string for flagged rows only. `unparseCsvSafe` passes it through unchanged (no leading meta-character), so numeric rows keep number cells and the en byte-identity holds.
- **N5. Phone pill reuse.** `FlagChip` is private to `ReorderSection.tsx`, and its labels are hardcoded English. The phone tag must be localized (AC-14), so a direct reuse of `FlagChip` with the token would print English. Export the pill shell, or build a small phone-local pill with the same tokens.
- **N6. One predicate.** Six call sites test the same flag (five builders plus the phone card). A shared `isReorderNoNeed(item: { flags?: string[] | null })` next to `REORDER_FLAG_NO_NEED` in `src/lib/eodNoNeed.ts` would keep them aligned. That module is pure and already imported by `ReorderSection.tsx` and `lastOrderContext.ts`. It is optional (AC-1).

## Risks

- **Byte-identity regressions.** These builders feed vendor-facing files, and their en output is pinned by snapshots and string assertions (spec 089 "byte-for-byte load-bearing"). Mitigation: the label branch is gated on the flag only; AC-4, AC-7, AC-9, AC-10, AC-12, and AC-13 require existing tests to pass unmodified; AC-20 adds a "zero but not flagged" arm per builder.
- **Phone row width.** A pill under the item name adds height to a stepped-up NO NEED line only. Placing it beside the name could squeeze the truncation at 390 px. AC-15 and AC-23 cover this.
- **Deploy.** Client-only, with no migration, so the `db-migrations-applied` gate is unaffected. After pushing, check `test.yml` and `db-migrations-applied.yml` (CLAUDE.md), and `e2e.yml` manually (project memory).
- **Realtime.** None. No table or publication changes.

## Dependencies

- **Spec 172** (`f7b2759`): the `no_need` flag in `report_reorder_list`, `REORDER_FLAG_NO_NEED`, the staff barrel, and the `section.reorder.noNeed` / staff `reorder.item.noNeed` keys.
- Spec 089: the shared and staff export builders, with the byte-for-byte contract.
- The 2026-07 localized-downloads work: the `locale` parameters, the `reorderExport.*` namespace, and the zh-CN jsPDF English fallback.
- Spec 139: `unparseCsvSafe`.
- Specs 143 and 149: the phone `VendorOrderCard`, also rendered by `PhoneApproveOrder`.
- Spec 156: the phone overflow CSV/PDF actions, which call the desktop orchestrators.
- Local stack (`npm run dev:db`) for the AC-23 browser check.

## Project-specific notes

- **Cmd UI section / legacy:**
  - Admin `src/screens/cmd/sections/ReorderSection.tsx` (jsPDF export only, plus a possible pill export) and `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (`VendorOrderCard`).
  - Pure utils `src/utils/reorderExport.ts`.
  - Staff subtree `src/screens/staff/lib/reorderExportStaff.ts`.
  - No legacy surface.
- **Per-store or admin-global:** per-store, inherited. Every surface renders the store-scoped `report_reorder_list` payload (`auth_can_see_store` gate). No RLS or policy change.
- **Realtime channels touched:** none.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. The builders are pure and shared by web download and the native share sheet (staff `shareReorder.ts`). The phone card is shared React Native / react-native-web. The admin jsPDF and CSV orchestrators are web-only, as they are today.
- **Test tracks:**
  - jest only: the builder arms for G1-G4 (including the mocked jsPDF `autoTable` capture), a phone `VendorOrderCard` render test, and i18n parity if a key is added.
  - Plus `npm run typecheck` and `npm run typecheck:test`.
  - No pgTAP and no shell smoke, because there is no DB change.

## Backend design

Architect: backend-architect, 2026-10-23, against `main` at `f7b2759`. Line numbers below were re-verified on that tree. They are pointers, not contracts.

### 0. Summary

The change is client-only and display-only. It adds one pure predicate, one pure label helper, and edits five builders plus one phone line. There are **no new i18n keys**: every surface reuses `section.reorder.noNeed`. There are **no new components**: the phone tag is an inline phone-local pill.

| Layer | Change |
|---|---|
| DB / migration | **None.** No `supabase/migrations/*` file. `report_reorder_list` is untouched. |
| RLS | **None.** Every surface renders the existing store-scoped payload (`auth_can_see_store`). |
| API (PostgREST / RPC) | **None.** The `no_need` token already rides in `ReorderItem.flags` (spec 172 hunk R4). |
| Edge functions | **None.** |
| `src/lib/db.ts` | **Not touched.** Spec 173's in-flight session has it staged; this design must not touch it. |
| `src/store/useStore.ts` | **Not touched.** No new slice, action, or optimistic path. `applyReorderEdits` already preserves `flags` through `...item` ([ReorderSection.tsx:129-135](../src/screens/cmd/sections/ReorderSection.tsx)), so an edited NO NEED row still carries the token into the phone card and the exports. |
| Realtime | **None.** No table or publication change, so the realtime container restart is not needed. |
| i18n catalogs | **None.** AC-21 is satisfied trivially: no catalog edits and no parity impact. |

### 1. Data model changes

None. No migration, so the `db-migrations-applied` gate is unaffected.

### 2. RLS impact

None. No table, policy, or helper is touched.

### 3. API contract

Unchanged. The contract this spec consumes is `ReorderItem.flags: string[]` ([src/types/index.ts:1031](../src/types/index.ts)). A NO NEED row is exactly one whose flags include `REORDER_FLAG_NO_NEED`. Nothing else makes a row NO NEED (see Definitions).

### 4. Edge function changes

None.

### 5. `src/lib/db.ts` surface

None. This spec adds two pure helpers, both outside `db.ts`:

**5.1 Predicate. `src/lib/eodNoNeed.ts`, added directly below `REORDER_FLAG_NO_NEED` (L27).** This is the N6 option.

```ts
/** Spec 174 — true iff a reorder row was counted NO NEED (flag token R4). Null-safe. */
export function isReorderNoNeed(item: { flags?: ReadonlyArray<string> | null }): boolean
// body: (item.flags || []).includes(REORDER_FLAG_NO_NEED)
```

- Why this module: it is pure and dependency-free (its only import, `./eodCountMode`, has no imports). It already owns the token, and `ReorderSection.tsx` and `lastOrderContext.ts` already import it. Importing it from `src/utils/reorderExport.ts` creates no cycle: `eodNoNeed` → `eodCountMode` / `types` only.
- The parameter is structural (`{ flags? }`), not `ReorderItem`, so both admin and staff item shapes satisfy it without casts.
- **Staff barrel.** Add `isReorderNoNeed` to the re-export list in [src/screens/staff/lib/eodNoNeed.ts:10-18](../src/screens/staff/lib/eodNoNeed.ts). AC-1 requires staff code to take it from the barrel. The existing barrel test checks identity per symbol, not the key set, so it stays green unmodified.
- **Existing call sites are not migrated.** These are the desktop `BreakdownLine` L162, staff `Reorder.tsx` L117/L267, and `lastOrderContext.ts` L143. All three are out of scope (spec 172 surfaces), and the spec says not to touch them. Moving them onto the predicate is an optional follow-up, not part of this build.

**5.2 Export label. `src/utils/reorderExport.ts`, exported, placed directly after `itemDisplayName` (L47-50).**

```ts
/** Spec 174 — the NO NEED label printed in an export's On Hand cell/line. */
export function reorderNoNeedLabel(locale: Locale): string
// body: locale === 'en' ? 'NO NEED' : t(locale, 'section.reorder.noNeed')
```

- This follows the file's existing `H()` / `L()` idiom: the en path returns the English literal and never consults the catalog, so en byte-identity cannot drift through a catalog edit. Other locales go through the root `t`.
- Values: en "NO NEED", es "NO HACE FALTA", zh-CN "无需" ([en.json:1243](../src/i18n/en.json) / es / zh-CN, same line).
- One helper serves all six export call sites: the admin CSV, the admin jsPDF, the shared HTML, and the three staff builders. The staff builder already imports from this module (L23-29), so it reaches the label with no new dependency direction.

### 6. Decisions on the open notes

**N2 (label source): option (a), reuse `section.reorder.noNeed` everywhere, behind `reorderNoNeedLabel`.**
- *It is the same concept as the on-screen label.* `section.reorder.noNeed` is the reorder NO NEED label that the desktop `BreakdownLine` (L170) and the new phone tag (AC-14) already print. A shared key keeps the screen and the exports consistent: a future wording change moves both together, which is what we want.
- *There is precedent for export builders reading outside `reorderExport.*`.* `localizeUnit` resolves through `enum.unit.*` ([reorderExport.ts:43-45](../src/utils/reorderExport.ts)). The builders already walk the whole root catalog, not one namespace.
- *Option (b) was rejected.* A new `reorderExport.noNeed` would copy the three existing strings into a fourth location. The caller asked to reuse keys, and a duplicated label is a drift surface.
- *Option (c) was rejected.* Importing the staff catalog into the staff builders would tie them to two dictionaries. Today they deliberately use one: the file header L35-37 says "there is one dictionary".
- **Accepted tradeoff (worth stating to the owner).** Staff exports print "NO NEED" / "NO HACE FALTA" in caps, while the staff screen prints "No need" / "No hace falta" in sentence case (zh-CN "无需" is identical in both). Only the case differs, and the uppercase matches the export chrome: section titles are uppercased (staff text L146/L151) and the admin PDF titles too. If the owner wants sentence case in staff exports, that is a one-line follow-up adding a key. It does not block this spec.

**N3 (staff share text for non-en): no new key. Print `{name}: {label}` directly.**
- Every locale already uses the `:` separator on the needs line: `` `  - ${nameOf(item, locale)}: ${formatSuggested(item, locale)}` `` (L148) is a locale-agnostic template. The NO NEED line reuses that shape, so a template key would add nothing.
- en line: `` `  - ${item.itemName}: ${reorderNoNeedLabel('en')}` ``, giving `  - Napkins: NO NEED`. It keeps the en path's pre-existing `item.itemName`, as the Out of scope note requires.
- es / zh-CN line: `` `  - ${nameOf(item, locale)}: ${reorderNoNeedLabel(locale)}` ``, giving for example `  - Servilletas: NO HACE FALTA` and `  - 餐巾: 无需`.
- No `.trimEnd()` is needed (the label has no trailing space or unit). Adding one is harmless.

**N5 (phone pill): use a phone-local inline pill. Do not export `FlagChip` and do not extract a shell.**
- `FlagChip` is token-driven and hardcoded English. The phone needs a localized label. Either export path would mean refactoring a desktop component that spec 172's suite (`ReorderSection.noNeed.spec172.test.tsx`) pins, for a roughly 10-line `View`/`Text`.
- `PhoneOrdering.tsx` already draws its own inline pills with theme tokens (the status badge at L281-295). An inline pill matches the file's existing idiom. The spec 149 "do not fork" rule covers `LineStepper` / `VendorOrderCard`, components with behavior. A static pill with no behavior is not a fork.
- `ReorderSection.tsx` therefore changes only inside `handlePdfExport`, plus one import line.

**N1, N4: confirmed as written.** zh-CN admin jsPDF falls back to English (`locale` is coerced at L1205 before any lookup). The CSV On Hand cell becomes a string only for flagged rows, and `csvSafeCell` passes it unchanged.

### 7. Exact edit sites

All edits are additive branches gated on `isReorderNoNeed(item)`. Every non-flagged code path stays character-for-character as it is today; the existing expression moves into the `else` arm unchanged.

**7.1 `src/lib/eodNoNeed.ts`.** Add `isReorderNoNeed` after L27 (§5.1).

**7.2 `src/screens/staff/lib/eodNoNeed.ts`.** Add `isReorderNoNeed,` to the export list L10-18.

**7.3 `src/utils/reorderExport.ts`**
- Imports (after L27): `import { isReorderNoNeed } from '../lib/eodNoNeed';`
- After L50: add `reorderNoNeedLabel` (§5.2).
- **G1** `buildReorderCsv`, L243: `[cOnHand]: isReorderNoNeed(item) ? reorderNoNeedLabel(locale) : item.onHand,`. The Flags cell (L255) is unchanged, so it still prints the raw `no_need` token (AC-3).
- **G3** `buildReorderPdfHtml`, L351: `` <td class="num">${isReorderNoNeed(item) ? escapeHtml(reorderNoNeedLabel('en')) : formatQty(item.onHand)}</td> ``. The signature is unchanged (AC-8). `'en'` is hardcoded because the builder is English-only.

**7.4 `src/screens/staff/lib/reorderExportStaff.ts`**
- Imports: add `reorderNoNeedLabel` to the existing `../../../utils/reorderExport` import (L23-29). Add a new `import { isReorderNoNeed } from './eodNoNeed';` from the staff barrel, per AC-1.
- **G4a** `buildStaffReorderCsv`, L86: `[cOnHand]: isReorderNoNeed(item) ? reorderNoNeedLabel(locale) : item.onHand,`.
- **G4b** `buildStaffReorderText`, the `itemLine` of the HAVE ENOUGH section (L153-159). Wrap it as `(item) => isReorderNoNeed(item) ? <N3 line> : <existing en/non-en ternary verbatim>`. The NEEDS line (L148) is **not** changed (AC-11).
- **G4c** `buildStaffReorderPdfHtml`, L226: `` <td class="num">${isReorderNoNeed(item) ? escapeHtml(reorderNoNeedLabel(locale)) : formatQty(item.onHand)}</td> ``. This one site covers both the needs and enough boxes, because `vendorBlock` is shared. Unlike the surrounding chrome `L()` calls, the label **is** passed through `escapeHtml`, per AC-12. None of the three values contain escapable characters, so this is defense in depth only.

**7.5 `src/screens/cmd/sections/ReorderSection.tsx` (G2, `handlePdfExport` only)**
- L12: extend the import to `{ REORDER_FLAG_NO_NEED, isReorderNoNeed }`.
- L36-47: add `reorderNoNeedLabel` to the `../../../utils/reorderExport` import list. Do **not** add it to any re-export.
- After `nameOf` (L1211-1212), add a local: `const onHandOf = (item: ReorderItem) => (isReorderNoNeed(item) ? reorderNoNeedLabel(locale) : formatQty(item.onHand));`. It must use the **coerced** `locale` from L1205, not `localeIn`. That gives English for zh-CN (AC-6) and ensures no CJK glyph reaches Helvetica.
- L1321 and L1329: replace `formatQty(item.onHand)` with `onHandOf(item)`.
- No change to `head`, `columnStyles`, `didParseCell` / `didDrawCell` (they key on column 4 / `parts[row.index]`, which this edit does not touch), `BreakdownLine`, or `FlagChip`.

**7.6 `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (G5)**
- Import (after L33): `import { isReorderNoNeed } from '../../../../lib/eodNoNeed';`
- In `lines.map` (L374-472), between the item-name `<Text>` (ends L423) and the `sub` `<Text>` (L424), add the tag only when `isReorderNoNeed(item)`. Placement is **under the name, not beside it**, so the name keeps its full flex width and `numberOfLines={1}` truncation at 390 px (AC-15). The extra height applies only to stepped-up NO NEED lines.
  - Outer `View`: `testID={`phone-order-noneed-${item.itemId}`}`, `alignSelf: 'flex-start'`, `marginTop: 3`, `paddingHorizontal: 7`, `paddingVertical: 2`, `borderRadius: CmdRadius.pill`, `borderWidth: 0.5`, `borderColor: C.border`, `backgroundColor: 'transparent'`.
  - Inner `Text`: `fontFamily: mono(600)`, `fontSize: 9`, `letterSpacing: 0.3`, `color: C.fg3`, `numberOfLines={1}`, content `T('section.reorder.noNeed')`.
  - These are exactly the desktop `FlagChip` fg3 values ([ReorderSection.tsx:255-268](../src/screens/cmd/sections/ReorderSection.tsx)). Only tokens are used, with no hex (AC-15). `CmdRadius` and `mono` are already imported (L26-27).
  - It is not wrapped in a `Touchable`, so it is non-interactive.
- The tag uses the component's existing `T` (active locale). It does **not** use `reorderNoNeedLabel`, which is an export helper.
- **Do not change** the `lines` filter (L195-197), `totalCases` / `est` (L198-199), the stats line, `qtyOf`, or the stepper (AC-17).
- `PhoneApproveOrder.tsx` is **not** edited (AC-18). It renders this same exported `VendorOrderCard`, so it inherits the tag.

### 8. Frontend store impact

None. There is no store slice, no action, and no `notifyBackendError` path; nothing is written. The phone tag reads `item.flags` from the already-hydrated `reorderPayload`, after it passes through `applyReorderEdits`.

### 9. Tests (all new files; no existing suite is edited)

New files only, the spec 172 idiom. **Do not add arms to `src/utils/reorderExport.test.ts` or `reorderExportStaff.test.ts`.** AC-4 and AC-13 require those suites to pass *unmodified*. Leaving them byte-untouched makes that provable with `git diff --stat`, and the NO NEED arms read more clearly as one spec-scoped file.

**Byte-identity technique (AC-4/7/9/10/12).**
1. *Pre-change pin.* For each builder, build a fixed numeric-only fixture. It must include an AC-20 "zero but not flagged" row: `onHand: 0`, `suggestedQty: 0`, `needsOrder: false`, `flags: ['no_par']`. Capture its output **on the unmodified `f7b2759` builder, before editing the source**, as an inline string literal (or `toMatchSnapshot`, committed with the test). Pin en, es, and zh-CN for every localized builder. Pin en only for `buildReorderPdfHtml`, and en + es for jsPDF.
2. *Flag-toggle differential.* For the same fixture plus one row with `onHand: 37` (a distinctive number) and `flags: ['no_need']`, compare against the identical payload with that row's flags set to `[]`. The outputs must differ **only** in that row's On Hand cell or line, plus the CSV Flags cell. Compare by line split, or by parsed CSV rows via `Papa.parse(..., { header: true })`.

| New test file | Covers |
|---|---|
| `src/lib/eodNoNeed.spec174.test.ts` | AC-1, AC-20. `isReorderNoNeed`: true for `['no_need']` and `['no_par','no_need']`; false for `[]`, `null`, `undefined`, `['no_par']`, and for a fixture with `onHand 0 / suggestedQty 0 / needsOrder false` and no flag. Staff barrel identity: `barrel.isReorderNoNeed === shared.isReorderNoNeed`. |
| `src/utils/reorderExport.noNeed.spec174.test.ts` | `reorderNoNeedLabel`: en `'NO NEED'`, es `'NO HACE FALTA'`, zh-CN `'无需'`, and `reorderNoNeedLabel('en') === t('en','section.reorder.noNeed')`, which pins that the literal and the catalog agree. **G1** `buildReorderCsv`: AC-2 (On Hand cell is the label in en/es/zh-CN and does not contain `37`), AC-3 (every other column equals the unflagged clone; Flags `=== 'no_need'`), AC-4 (pre-change pins in 3 locales), AC-20 arm. **G3** `buildReorderPdfHtml`: AC-8 (the second `<td class="num">` of the flagged row is `NO NEED`, with no `37`; the other six cells match the unflagged clone), AC-9 (en pin), AC-20 arm. |
| `src/screens/staff/lib/reorderExportStaff.noNeed.spec174.test.ts` | **G4a** AC-10 (3 locales + pins). **G4b** AC-11: en line `=== '  - Napkins: NO NEED'`; es line `=== '  - <es name>: NO HACE FALTA'` and zh-CN `=== '  - <zh name>: 无需'` (give the fixture `i18nNames` so the localized name is exercised); no line contains `on hand` / `en existencia` / `现有` or `37`; every other line equals the unflagged output, and the needs section is unchanged. **G4c** AC-12: the label sits in the On Hand `<td>` in the enough box, in 3 locales. Also cover a needs-box placement using a fixture row with `needsOrder` unset plus the `no_need` flag. The RPC never emits that combination; the row exists only to prove the shared `vendorBlock` site. AC-20 arm. AC-13 is satisfied by leaving `reorderExportStaff.test.ts` untouched. |
| `src/screens/cmd/sections/__tests__/ReorderSection.pdfNoNeed.spec174.test.tsx` | **G2** AC-5, AC-6, AC-7. Call the exported `handlePdfExport(payload, store, localeIn)` **directly**; no section render is needed. Mock the same boundaries as `ReorderSection.resetAfterExport.spec138.test.tsx`: Platform web, Toast, useStore, theme, the jspdf class. Use `jspdf-autotable` `default: jest.fn()` and capture `opts.head` / `opts.body` per call. Assert `body[i][1]` is the label in whichever table the row lands. Use a `needsOrder: false` flagged row (have-enough table), plus a needs-table arm with `needsOrder` unset. Assert the other cells match the unflagged run. Locales: `'es'` gives `'NO HACE FALTA'`; `'zh-CN'` gives `'NO NEED'`, and every captured `body` cell and every `doc.text` argument matches no `/[㐀-鿿]/`. AC-7: pin `head` / `body` for a numeric-only payload, captured pre-change, en + es. Also check `handlePdfExport` resolves `true`. |
| `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.noNeed.spec174.test.tsx` | **G5** AC-14, AC-16, AC-17, AC-18, AC-19. Follow the `PhoneOrdering.lastOrderContext.spec151.test.tsx` idiom (real store, supabase/db stubbed), and run the arms through **both** `SURFACES` (PhoneOrdering + PhoneApproveOrder), which proves AC-18 by inheritance. Arms: (a) NO NEED row (`suggestedUnits: 0`, `needsOrder: false`, `flags: ['no_need']`) **with** a `reorderEdits` entry renders `phone-order-line-<id>` and `phone-order-noneed-<id>` with text `NO NEED`; (b) the same row **without** an edit renders neither testID; (c) a non-flagged edited row renders a line and no `phone-order-noneed-*`; (d) the stats-line text is identical with the row's flag on and off; (e) `useStore.setState({ locale: 'es' })` gives tag text `NO HACE FALTA`. AC-15 styling: assert the tag's flattened style has `borderColor` equal to the theme's `border` token and `backgroundColor: 'transparent'`, and the item-name `Text` still has `numberOfLines === 1`. |

Gates for AC-22: full `npx jest` (not a subset; see project memory), `npm run typecheck`, `npm run typecheck:test`. AC-23 is the developer's browser check on the local stack at 390 px.

### 10. Realtime impact

None. Channels `store-{id}` / `brand-{id}` are unchanged. No `supabase_realtime` publication change, so no `docker restart supabase_realtime_imr-inventory` step.

### 11. Risks and tradeoffs

- **Byte identity (highest risk).** Vendor-facing files are pinned byte-for-byte (spec 089). Mitigations: every edit is a ternary whose `else` arm is the existing expression verbatim; there is no shared refactor of the `H()` / `L()` helpers; pre-change pins are captured before the source edit (§9); existing suites are untouched.
- **Mixed-type CSV column.** In a spreadsheet, On Hand becomes text for flagged rows, so a `SUM` over it skips them. That is the correct result, because the stale number is exactly what the owner does not want summed. Number cells are unchanged.
- **jsPDF column width.** "NO HACE FALTA" (es) is wider than a typical quantity in the right-aligned On Hand column. autoTable auto-sizes and wraps, so there is no clipping. It is cosmetic, and the AC-23 check runs in en only. zh-CN prints English, so no glyph risk (AC-6).
- **Staff label case.** Staff exports print uppercase while the staff screen prints sentence case (§6 N2). This is accepted; changing it is a one-key follow-up.
- **The predicate is not yet universal.** Three spec 172 sites still inline `flags.includes(REORDER_FLAG_NO_NEED)`. They agree semantically. Migrating them is out of scope and needs no action now.
- **Spec 173 collision.** None of the files in §7 or §9 is `src/lib/db.ts` or a spec 173 test. The developer must not `git add -A`; stage only the spec 174 paths, because spec 173's staged files share the index.
- **Performance.** O(rows) `includes` on a flags array of at most a few elements, inside builders that already iterate every row. Negligible on the 286 KB seed dataset. No edge function, so no cold-start concern.
- **Deploy.** Vercel web build only. After the push, confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` manually (project memory).

### 12. Open questions

None blocking. One owner-visible tradeoff is recorded (§6 N2, staff export label case). Nothing in this spec implies an `app.json` slug change.

### 13. Files the build is expected to touch

- `src/lib/eodNoNeed.ts`
- `src/screens/staff/lib/eodNoNeed.ts`
- `src/utils/reorderExport.ts`
- `src/screens/staff/lib/reorderExportStaff.ts`
- `src/screens/cmd/sections/ReorderSection.tsx` (`handlePdfExport` + 2 import lines only)
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (`VendorOrderCard` line + 1 import)
- New tests: the five `*.spec174.test.ts(x)` files listed in §9.

There are no catalog, migration, `db.ts`, `useStore.ts`, `PhoneApproveOrder.tsx`, or staff `Reorder.tsx` edits.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (## Backend design, §5-§9). It is client-only: no migration, no db.ts, no catalog change. Capture the pre-change byte-identity pins on the unmodified builders BEFORE editing the source. Stage only the spec 174 paths, because spec 173 has staged files in the same index. After implementation, set Status: READY_FOR_REVIEW and list the files changed under ## Files changed.
payload_paths:
  - specs/174-reorder-no-need-display.md

## Files changed

Frontend implementation (frontend-developer, 2026-10-23). Client-only; no migration, `src/lib/db.ts`, `src/store/useStore.ts`, i18n catalog, `PhoneApproveOrder.tsx`, or staff `Reorder.tsx` edits. Existing suites `src/utils/reorderExport.test.ts` and `src/screens/staff/lib/reorderExportStaff.test.ts` are byte-untouched.

**Source**
- `src/lib/eodNoNeed.ts` — `isReorderNoNeed` predicate (§5.1).
- `src/screens/staff/lib/eodNoNeed.ts` — barrel re-exports `isReorderNoNeed` (§7.2).
- `src/utils/reorderExport.ts` — `reorderNoNeedLabel` helper (§5.2); G1 `buildReorderCsv` On Hand cell; G3 `buildReorderPdfHtml` On Hand cell (English).
- `src/screens/staff/lib/reorderExportStaff.ts` — G4a CSV On Hand cell; G4b HAVE ENOUGH line `{name}: {label}`; G4c PDF-HTML On Hand cell (escaped, localized).
- `src/screens/cmd/sections/ReorderSection.tsx` — `handlePdfExport` only: `onHandOf` local using the coerced `locale` (zh-CN gives English), applied to the needs and have-enough body rows; two import lines.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` — `VendorOrderCard` line: inline fg3 pill `phone-order-noneed-<itemId>` under the item name, text `T('section.reorder.noNeed')`; one import line. The line filter, stats, and stepper are unchanged.

**Tests (new files only)**
- `src/lib/eodNoNeed.spec174.test.ts`
- `src/utils/reorderExport.noNeed.spec174.test.ts`
- `src/utils/__snapshots__/reorderExport.noNeed.spec174.test.ts.snap`
- `src/screens/staff/lib/reorderExportStaff.noNeed.spec174.test.ts`
- `src/screens/staff/lib/__snapshots__/reorderExportStaff.noNeed.spec174.test.ts.snap`
- `src/screens/cmd/sections/__tests__/ReorderSection.pdfNoNeed.spec174.test.tsx`
- `src/screens/cmd/sections/__tests__/__snapshots__/ReorderSection.pdfNoNeed.spec174.test.tsx.snap`
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.noNeed.spec174.test.tsx`

**Implementation notes**
- Byte-identity pins (AC-4/7/9/10/12): the 15 snapshots in the three `.snap` files were written by running the pin `describe` blocks against the UNMODIFIED builders, before any source edit. They passed unchanged (`--ci`) after the edit. Pins cover: admin CSV in en/es/zh-CN, admin PDF-HTML in en, staff CSV/text/PDF-HTML in en/es/zh-CN, and the jsPDF `head`/`body` in en/es. Each pin fixture includes the AC-20 "zero but not flagged" row (`onHand 0`, `suggestedQty 0`, `needsOrder false`, `flags ['no_par']`).
- Flag-toggle differentials: each builder renders the same payload with the `onHand: 37` Napkins row flagged and unflagged. The tests assert that only that row's On Hand cell or line differs (plus the CSV Flags cell).
- Gates: full `npx jest --ci` gave 262 suites / 3280 tests passed, 17 snapshots passed. `npm run typecheck` exit 0, `npm run typecheck:test` exit 0.
- AC-23 (browser check at 390 px on the local stack) has NOT been run by frontend-developer, because this session has no preview tools. Main Claude owns it.

