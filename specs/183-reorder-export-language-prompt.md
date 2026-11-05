# Spec 183: Ask for a language before each Ordering-page export (CSV / PDF / Quick-order list)

Status: READY_FOR_REVIEW

## User story

As a store manager on the admin Ordering page, when I click **CSV**, **PDF** or
**Quick-order list** for a vendor, I want to be asked which language the file
should be in. Then I can send a vendor or a teammate an order in the language
they read, without switching the whole app's language and switching it back.

Concrete scenario: the manager runs the app in 中文. Tomorrow's produce vendor
reads Spanish. The manager clicks **Quick-order list** on that vendor's card,
picks **ES** in the prompt, and gets the list with Spanish item names. The app
stays in 中文. Next, the manager clicks **PDF** on the same card. The prompt
offers only **EN / ES** with **EN** preselected (Chinese can't be rendered in
this PDF). The manager confirms and the English PDF downloads.

## Background (current behaviour, verified 2026-10-26)

- Desktop Ordering page: [src/screens/cmd/sections/ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx).
  - `ReorderQuickOrderButton` (~L355) builds text with `buildPoQuickOrderText`.
    Its `resolveName` calls `getLocalizedName(..., locale)`, then
    `sharePurchaseOrder`. On `shared === true` it calls `recordExportedOrder`
    (spec 156) and then `clearReorderEditsForVendor` (spec 138). The desktop
    preview is lifted to `VendorCard` through `onPreview`.
  - `ReorderVendorExportButtons` (~L488) is web-only (the parent gates it on
    `showExport`).
    - `onCsv`: if `pickImportVendor(narrowed, vendorsList)` matches, it calls
      `handleImportExport`, which writes a US Foods / SYSCO order file keyed on
      order codes. Otherwise it calls `handleCsvExport(narrowed, store, locale)`.
    - `onPdf`: calls `handlePdfExport(narrowed, store, locale)`.
    - On `ok`, both handlers call `recordExportedOrder` and then
      `clearReorderEditsForVendor`.
  - `handlePdfExport` (~L1195) turns `zh-CN` into `en`, because jsPDF's
    Helvetica has no CJK glyphs (owner decision, 2026-07).
  - Today all three buttons take `locale` from `useLocale()`, which is the app
    UI language.
- Phone tier: [src/screens/cmd/sections/phone/PhoneOrdering.tsx](../src/screens/cmd/sections/phone/PhoneOrdering.tsx).
  `OverflowSheet` (~L590-740) has `runQuickOrder`, `runCsv` and `runPdf`. They
  use the same builders, the same spec-156/138 tail, and `locale` from
  `useLocale()`. Each one calls `onClose()` first. On native, `runCsv` and
  `runPdf` return early with the `common.availableOnDesktop` toast.
- Security-review snapshot rule (2026-08-08, Mediums 1+2): every export site
  captures `{ storeId, referenceDate: asOfDate }` for `recordExportedOrder`
  from the store and payload it builds the file from, before its first `await`.
- Precedent: spec 139 added
  [src/components/cmd/ExportLocalePicker.tsx](../src/components/cmd/ExportLocalePicker.tsx),
  an EN / ES / 中文 segmented control. It is scoped to the export, never calls
  `setLocale`, and reuses the `chrome.localeSwitcher.labels.*` labels.
  Spec 139 used it inline. This spec uses it inside a prompt.
- Quick-order text depends on language only through item names. Mapped lines
  print `<order code>\t<qty>`. Names appear on `???` unmapped lines and on the
  plain-name list used for vendors with no codes. The owner still wants the
  prompt for every quick-order (decision 3).

## Acceptance criteria

### Prompt behaviour

- [ ] **AC-1.** On the desktop Ordering page, clicking a vendor card's
      **Quick-order list** button opens a language prompt. Before the user
      confirms, nothing is built, shared, copied, downloaded or recorded:
      `buildPoQuickOrderText`, `sharePurchaseOrder` and `recordExportedOrder`
      are not called.
- [ ] **AC-2.** On the desktop Ordering page, clicking a vendor card's **PDF**
      button opens a language prompt. `handlePdfExport` is not called before
      the user confirms.
- [ ] **AC-3.** On the desktop Ordering page, clicking **CSV** on a vendor card
      where `pickImportVendor(narrowed, vendors)` returns `null` (the generic
      reorder CSV) opens a language prompt. `handleCsvExport` is not called
      before the user confirms.
- [ ] **AC-4 (import-file skip).** Clicking **CSV** on a vendor card where
      `pickImportVendor` returns a vendor config (US Foods / SYSCO) opens no
      prompt. `handleImportExport` runs right away, as it does today. The
      spec-156 record and spec-138 clear on success are unchanged. On that same
      card, **PDF** and **Quick-order list** still open the prompt (AC-1, AC-2).
- [ ] **AC-5 (options).** The CSV and Quick-order prompts offer exactly three
      options: EN, ES and 中文 (`en`, `es`, `zh-CN`). The PDF prompt offers
      exactly two: EN and ES. 中文 is not rendered at all for PDF (not shown
      greyed out). Option labels come from `chrome.localeSwitcher.labels.*`, so
      they read EN / ES / 中文 whatever the UI locale is.
- [ ] **AC-6 (default).** When the prompt opens, the current UI locale
      (`useLocale()`) is preselected and visibly highlighted
      (`accessibilityState.selected === true` on that option). Exception: if the
      UI locale is `zh-CN`, the PDF prompt preselects `en`.
- [ ] **AC-7 (confirm).** The prompt has an explicit confirm control and a
      Cancel control. Confirming with the default unchanged exports in the UI
      locale (or in `en` for a zh-CN PDF). Choosing a different option and then
      confirming exports in that language.
- [ ] **AC-8 (export-scoped).** Choosing an option or confirming never calls
      `setLocale`. Neither does any other part of the prompt. The app UI
      language, `profiles` locale state and the persisted locale preference are
      the same before and after the export. The next prompt opens on the
      current UI locale again; the last-picked language is not remembered.
- [ ] **AC-9 (cancel is a no-op).** Cancelling the prompt in any way (the Cancel
      control, a backdrop tap, Escape on web, the Android back button, or the
      sheet's close gesture) has no side effects:
      - no file is downloaded
      - `sharePurchaseOrder` is not called, and nothing is shared or copied
      - `recordExportedOrder` is not called, so no draft PO is written
      - `clearReorderEditsForVendor` is not called, so the vendor's inline
        edits in `reorderEdits` are unchanged
      - no success or error toast appears
      - the desktop quick-order preview (`onPreview`) is not updated

### Language actually applied

- [ ] **AC-10 (Quick-order).** After a language is confirmed, `resolveName`
      calls `getLocalizedName(..., <picked locale>)` instead of the UI locale.
      Unmapped `???` lines and plain-name-list lines carry item names in the
      picked language. The silent English fallback from `getLocalizedName` is
      unchanged. Mapped `<code>\t<qty>` lines are byte-identical whichever
      language is picked.
- [ ] **AC-11 (CSV).** After a language is confirmed, `handleCsvExport` receives
      the picked locale as its `locale` argument. The headers and item names
      from `buildReorderCsv` follow the picked locale. When `en` is picked, the
      output is byte-identical to today's `en` output.
- [ ] **AC-12 (PDF).** After a language is confirmed, `handlePdfExport` receives
      the picked locale (`en` or `es`). Its existing `zh-CN → en` coercion
      stays in place as defense in depth.
- [ ] **AC-13 (unchanged around the file).** Export filenames, the
      `sharePurchaseOrder` dialog title, success/failure toasts, the unmapped
      and rounded warning toasts, and the desktop preview's `unitNote` all stay
      in the UI language. Only the exported file or text content follows the
      picked language.

### Regression guards (specs 138 / 156 / security snapshot)

- [ ] **AC-14 (record + clear only on success, only after confirm).** At all six
      export sites (3 desktop, 3 phone):
      - `recordExportedOrder` and then `clearReorderEditsForVendor` run only
        after a language is confirmed, and only when the export succeeded:
        `shared === true` for quick-order, `ok === true` for CSV / import /
        PDF.
      - The record call still comes before the clear (spec 156 AC-10). It is
        still invoked and not awaited, with `.catch` (spec 156 D-3).
      - A failed export (`ok === false`) or a dismissed share sheet
        (`shared === false`) after a confirmed language records nothing and
        clears nothing.
- [ ] **AC-15 (snapshot-before-await).** The `{ storeId, referenceDate }` passed
      to `recordExportedOrder` must:
      - be captured synchronously in the code path that runs on confirm,
        before that path's first `await`
      - come from the same `currentStore` / `reorderPayload` values used to
        build the exported file
      Neither value may be read after an `await`. If `currentStore` or
      `reorderPayload` is null when the user confirms (for example, a store
      switch while the prompt was open nulled the payload), the confirm is a
      no-op: no export, no record, no clear. This matches the existing
      `if (!reorderPayload || !currentStore) return;` guard. The architect may
      decide whether the prompt should also close itself on a store switch.
- [ ] **AC-16 (no double-fire).** While a desktop quick-order prompt or export is
      in progress, a second click on the same button does not open a second
      prompt or start a second export. This keeps the `busy` guard from
      spec 115.

### Phone tier

- [ ] **AC-17.** In the `PhoneOrdering` overflow action sheet:
      - **Quick-order list** opens the language prompt after the action sheet
        closes, on both web and native.
      - **Export CSV** and **Export PDF** open the prompt on web only.
      - AC-1 through AC-16 apply to these paths in the same way. AC-4's
        import-file skip applies to phone `runCsv`.
- [ ] **AC-18 (native CSV/PDF unchanged).** On native, phone **Export CSV** and
      **Export PDF** show the `common.availableOnDesktop` toast exactly as they
      do today. No language prompt appears first, and nothing is recorded or
      cleared.
- [ ] **AC-19.** The prompt opened from the phone sheet is still shown and
      usable after `OverflowSheet` unmounts. Closing the action sheet must not
      silently drop the prompt.

### Cross-platform, i18n and gates

- [ ] **AC-20.** The prompt uses no browser-only primitive such as
      `window.prompt` or `window.confirm`. It renders on web and native, like
      the existing `ResponsiveSheet` / Cmd modal surfaces. It has an
      accessibility label from the new i18n keys below. The options keep the
      `radiogroup` / `radio` roles from `ExportLocalePicker`.
- [ ] **AC-21.** Every new user-facing string in the prompt comes from the i18n
      keys listed below. Each key is present in all three catalogs
      (`src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`) with the
      same key set, so the existing catalog-parity tests pass.
- [ ] **AC-22.** `npx jest` (full suite), `npm run typecheck` and the
      test-graph typecheck (`typecheck:test`) are green. Existing jest pins on
      the reorder export, quick-order, spec 138 edit-clear and spec 156
      draft-PO recording paths still pass. Any test that clicks CSV / PDF /
      Quick-order and expects an immediate export is updated to go through the
      prompt (or the import-file skip). Such a test must not be deleted.

## New i18n keys (all three catalogs)

Proposed keys and English copy are below. The architect may rename keys within
the `section.reorder.exportLanguagePrompt.*` namespace. es and zh-CN
translations are supplied by the developer and checked at review.

| Key | en |
|---|---|
| `section.reorder.exportLanguagePrompt.title` | `Which language?` |
| `section.reorder.exportLanguagePrompt.subtitle` | `{format} · {vendor}` |
| `section.reorder.exportLanguagePrompt.formatCsv` | `CSV` |
| `section.reorder.exportLanguagePrompt.formatPdf` | `PDF` |
| `section.reorder.exportLanguagePrompt.formatQuickOrder` | `Quick-order list` |
| `section.reorder.exportLanguagePrompt.pdfLatinOnly` | `PDF is available in English or Spanish.` (shown only in the PDF prompt) |
| `section.reorder.exportLanguagePrompt.confirm` | `Continue` |
| `section.reorder.exportLanguagePrompt.aria` | `Choose export language` |

Existing keys reused (do not duplicate):
- `chrome.localeSwitcher.labels.{en,es,zh-CN}` for the option labels
- `chrome.localeSwitcher.aria` for the radiogroup label, if `ExportLocalePicker`
  is reused as-is
- `common.cancel` for the Cancel control

## In scope

- One language prompt shared by the three per-vendor export actions on the
  desktop Ordering page (`ReorderSection.tsx`).
- The same prompt on the phone-tier Ordering overflow sheet
  (`PhoneOrdering.tsx`): Quick-order on web and native, CSV and PDF on web only.
- A PDF-only option set (EN / ES), with `zh-CN` UI locale defaulting to EN.
- Skipping the prompt for US Foods / SYSCO import-file CSVs.
- Passing the picked locale through to the existing builders
  (`buildPoQuickOrderText` name resolver, `handleCsvExport`,
  `handlePdfExport`). No changes to the builders' output contracts.
- New i18n keys in en / es / zh-CN.
- Jest coverage (see Tests).

## Out of scope (explicitly)

- **Purchase Orders section quick-order** (`src/screens/cmd/sections/POsSection.tsx`).
  Owner decision 5: that button keeps using the UI locale with no prompt.
- **CJK PDF for the reorder export.** Owner decision 5; separate future spec.
  The reorder PDF stays Helvetica (Latin only). Spec 139 added a CJK font path
  for count PDFs. This spec does NOT port it to the reorder PDF.
- **Remembering the last-picked language** (per session, per vendor or
  per user). Owner decision 5. Every prompt opens on the UI locale.
- **Prompting for the US Foods / SYSCO import file.** Owner decision 3. That
  file is keyed on order codes and has no language.
- **Skipping the quick-order prompt for vendors whose lines are all
  code-mapped**, even though their text has no language. Owner decision 3
  says quick-order always prompts.
- **Localizing the export chrome.** Filenames, toast text (including the
  hardcoded English `CSV exported` / `SYSCO order` toasts), the hardcoded
  `CSV` / `PDF` button labels and their English `accessibilityLabel`s stay as
  they are. Not requested.
- **Count-export (spec 139) screens.** They keep their inline picker.
- **Staff app** (`src/screens/staff/`) and the **customer PWA**. Not admin
  Ordering.
- **Any change to `setLocale`, `LocaleSwitcher`, or how the UI locale is
  stored.**
- **Native CSV/PDF export.** Still desktop-only, as today (AC-18).

## Open questions resolved

- Q: When does the language get chosen: inline toggle, or a prompt after the
  click? → A: A prompt opens on click, before anything is generated. The
  current UI locale is preselected. The choice is for that one export only and
  never changes the app UI language. Cancel/dismiss means no export, no draft
  PO and no edit-clear.
- Q: Should the PDF prompt offer 中文, given jsPDF can't render it? → A: No. PDF
  offers EN / ES only. If the UI locale is zh-CN, the PDF prompt defaults to
  EN. CSV and Quick-order offer EN / ES / 中文.
- Q: Should the CSV prompt appear for vendors whose CSV is the US Foods / SYSCO
  import file? → A: No, skip it. That file uses order codes and has no
  language. PDF and Quick-order for those vendors still prompt.
- Q: Desktop only, or the phone tier too? → A: Both: desktop `ReorderSection`
  and the `PhoneOrdering` action sheet.
- Q: What is out of scope? → A: POsSection quick-order, CJK PDF support (future
  spec), and remembering the last-picked language.
- Q (PM call, low risk): Should the PDF prompt explain why 中文 is missing? → A:
  Yes, one hint line (`pdfLatinOnly`), so a zh-CN user doesn't read the missing
  option as a bug. This is copy only. Drop the key if the owner objects at
  review.

## Dependencies

- `src/components/cmd/ExportLocalePicker.tsx` (spec 139). Reuse it as the
  option control if possible. It has no way to restrict options today, so
  hiding 中文 for PDF needs a backward-compatible prop (for example an optional
  `options?: Locale[]` that defaults to all three). The spec 139 call sites in
  `EODCountSection.tsx` and `InventoryCountSection.tsx` must behave exactly as
  before. The architect decides whether to extend it or wrap it.
- `ResponsiveSheet` / existing Cmd modal primitives for the prompt surface.
- `useLocale()` / `Locale` type (`src/i18n/index.ts`), `getLocalizedName`.
- Existing export functions, signatures unchanged: `handleCsvExport`,
  `handlePdfExport`, `handleImportExport`, `pickImportVendor`,
  `buildPoQuickOrderText`, `sharePurchaseOrder`.
- Store actions, unchanged: `recordExportedOrder` (spec 156) and
  `clearReorderEditsForVendor` (spec 138).
- No migrations, no RPCs, no edge functions.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI. `src/screens/cmd/sections/ReorderSection.tsx`
  and `src/screens/cmd/sections/phone/PhoneOrdering.tsx`. A new shared prompt
  component under `src/components/cmd/` is expected.
- **Per-store or admin-global:** Per-store, by inheritance. The exports already
  act on the active store's reorder payload. This spec adds no data access. The
  store snapshot rule (AC-15) keeps the draft PO filed under the store the file
  was built for.
- **Realtime channels touched:** None new. `recordExportedOrder` already writes
  a draft PO, which echoes on `store-{id}`; spec 175 keeps the payload across
  that same-store reload. Nothing changes here. The prompt must survive a
  realtime reload that happens while it is open. Under spec 175, a same-store
  reload keeps `reorderPayload`.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:**
  - Desktop CSV / PDF stay web-only (gated by `showExport`).
  - Desktop Quick-order: web and native, wherever it renders today.
  - Phone Quick-order: web and native.
  - Phone CSV / PDF: web prompts; native keeps the `availableOnDesktop` toast
    (AC-18).
- **`app.json` slug:** Not touched.
- **Tests:** Jest track only. No pgTAP (no DB change), no shell smoke (no edge
  function). Expected coverage:
  - Prompt component: option sets per format, default selection including the
    zh-CN to EN PDF default, confirm passes the picked locale, cancel paths,
    and `setLocale` never called.
  - `ReorderSection` and `PhoneOrdering` interaction tests:
    - prompt shown or skipped per AC-1 to AC-4 and AC-17 / AC-18
    - picked locale reaches the builder
    - cancel triggers no record or clear
    - record then clear on success only (AC-14)
    - snapshot captured before the await (AC-15)
  - `ExportLocalePicker` regression for the spec 139 call sites if the
    component is extended.
- **Risks:**
  1. **Phone sheet lifecycle.** `OverflowSheet` calls `onClose()`, which
     unmounts it before `run*` continues. A prompt held as local state in
     `OverflowSheet` would vanish. The prompt state likely has to move up to
     `PhoneOrdering`. Two stacked `ResponsiveSheet`s on native may also need
     sequencing (AC-19).
  2. **Snapshot timing.** The prompt is user-paced, so the store or payload can
     change while it is open. AC-15 pins the snapshot to the confirm path,
     taken from the same values used to build the file.
  3. **Existing tests** that press CSV / PDF / Quick-order and expect an
     immediate export will fail until they go through the prompt. Grep for
     them and update them; do not delete them (AC-22; per the
     run-full-jest-before-commit practice).

## Backend design

Architect: backend-architect, 2026-10-26. Design mode.

### 0. Backend scope confirmed: none

I checked the "frontend-only" claim against the code and it holds.

- **Data model / migrations:** none. No table, column, index or publication change, so no `supabase_realtime` publication change and no `docker restart supabase_realtime_imr-inventory` step.
- **RLS:** none. The only DB write on these paths is the existing spec-156 `recordExportedOrder` draft-PO upsert, and it is unchanged: same action, same arguments, same store-side guard.
- **API contract (PostgREST / RPC):** none. No new or changed RPC.
- **Edge functions:** none. `verify_jwt` settings are untouched.
- **`src/lib/db.ts`:** no new helper. Nothing in this spec calls Supabase.
- **Realtime:** no new channel or event. The draft-PO write still echoes on `store-{id}`, and spec 175 still keeps `reorderPayload` across that same-store reload. The prompt has to survive that reload (§6).
- **`src/store/useStore.ts`:** no slice change. `recordExportedOrder`, `clearReorderEditsForVendor`, `setLocale` and `locale` are untouched. Prompt state is component-local (desktop) or `PhoneOrdering`-local (phone). It never goes in the global store, so it cannot leak across stores or sessions (AC-8: nothing is remembered).
- **Optimistic-then-revert / `notifyBackendError`:** not applicable. There is no new backend call, and the existing export toasts are unchanged (AC-13).

The rest of this section is the **frontend contract** the frontend-developer builds against.

### 1. Prompt component: new `ExportLanguagePrompt`, built on an extended `ExportLocalePicker`

Decision: **extend** `ExportLocalePicker` with optional, backward-compatible props, and **add** a thin new prompt component that hosts it inside `ResponsiveSheet`. Neither component alone can do the job:

- `ExportLocalePicker` stays the single EN/ES/中文 segmented control. That keeps one code path for the `chrome.localeSwitcher.labels.*` labels and the `radiogroup` / `radio` roles (AC-20).
- `ExportLanguagePrompt` owns the modal surface: title, confirm/cancel, the per-format option rule, the default rule, the once-guard and the store-switch auto-dismiss. Putting these in the picker would make the spec-139 inline call sites carry modal concerns.

#### 1a. `src/components/cmd/ExportLocalePicker.tsx`: additive props only

```ts
interface Props {
  value: Locale;
  onChange: (locale: Locale) => void;
  /** Spec 183. Subset of locales to render. Default: all three. Rendered in the
   *  canonical order en → es → zh-CN whatever order the caller passes.
   *  A locale not listed is NOT rendered (not greyed out; AC-5). */
  options?: readonly Locale[];
  /** Spec 183. 'compact' (default) = the exact spec-139 styles.
   *  'touch' = phone-safe targets: each segment flex:1, minHeight 44,
   *  centered, label fontSize ~12. */
  size?: 'compact' | 'touch';
  /** Spec 183. Overrides the radiogroup label. Default: T('chrome.localeSwitcher.aria'). */
  accessibilityLabel?: string;
  /** Spec 183. When set, each segment gets testID `${testIDPrefix}-${locale}`.
   *  Default: no testID (spec-139 render unchanged). */
  testIDPrefix?: string;
}
```

Backward-compatibility contract (Critical if broken):

- With none of the new props, the render tree is identical to today: same three segments, same styles, same labels, same `accessibilityLabel`, no `testID`.
- `EODCountSection.tsx` (L1822) and `InventoryCountSection.tsx` (L1694) are **not edited**. Their existing suites must pass unedited. That is the regression signal.
- Filter with `SEGMENTS.filter((s) => options.includes(s))` so the order is canonical. The `borderLeftWidth: i === 0 ? 0 : 1` divider must use the index in the **filtered** list, so the PDF prompt's EN segment has no left border.

Why `size` is needed: the spec-139 segments are about 15 px tall. The phone tier's Hard Rule is that every tappable is at least 44×44 (`PhoneOrdering.tsx` header comment), and this prompt renders on phone.

Why `accessibilityLabel` is needed: `chrome.localeSwitcher.aria` reads "Change language". Inside an export prompt, that tells a screen-reader user the app language will change, which is exactly what AC-8 forbids. The prompt passes `section.reorder.exportLanguagePrompt.aria` instead.

#### 1b. New `src/components/cmd/ExportLanguagePrompt.tsx`

```ts
export type ReorderExportFormat = 'csv' | 'pdf' | 'quickOrder';

/** Pure: pdf → ['en','es']; csv | quickOrder → ['en','es','zh-CN']. */
export function exportLocaleOptions(format: ReorderExportFormat): readonly Locale[];

/** Pure: uiLocale if it is in exportLocaleOptions(format), else 'en'.
 *  Covers AC-6's zh-CN → en PDF exception AND an undefined / unknown
 *  uiLocale (the desktop jest mocks have no `locale` in state). */
export function defaultExportLocale(format: ReorderExportFormat, uiLocale: Locale | undefined): Locale;

interface ExportLanguagePromptProps {
  format: ReorderExportFormat;
  vendorName: string;
  /** The store id the prompt was OPENED for (see "Store switch" below). */
  storeId: string;
  /** Called at most once per mount, synchronously, from the Continue press. */
  onConfirm: (locale: Locale) => void;
  /** Called at most once per mount, from any dismiss path. */
  onCancel: () => void;
}
export const ExportLanguagePrompt: React.FC<ExportLanguagePromptProps>;
```

Behaviour contract:

1. **Mount = open.** There is no `visible` prop. The host mounts the prompt only while an export is pending. Selection state is `useState(() => defaultExportLocale(format, useLocale()))`, so it is reseeded from the current UI locale on every open. The last pick is not remembered (AC-6, AC-8).
2. **Options:** `<ExportLocalePicker value={picked} onChange={setPicked} options={exportLocaleOptions(format)} size="touch" accessibilityLabel={T('section.reorder.exportLanguagePrompt.aria')} testIDPrefix="export-lang-option" />`. `onChange` only updates local state.
3. **No `setLocale`.** The component never imports or calls `setLocale` and never writes `profiles` or AsyncStorage/localStorage (AC-8). This is pinned by test.
4. **Once-guard.** A `firedRef` makes the first of {confirm, cancel} win. Later calls of either are no-ops. This covers a double-click on Continue, and Continue followed by a backdrop tap in the same frame. It is how CSV/PDF meet "no double-fire"; quick-order also keeps its `busy` guard (§2).
5. **Confirm is synchronous.** The Continue `onPress` calls `onConfirm(picked)` directly, with no `await`, `setTimeout` or `requestAnimationFrame` before it. AC-15's snapshot depends on this, and it keeps the existing synchronous jest assertions valid (e.g. `ReorderSection.spec123.test.tsx:283` asserts `buildReorderCsv` was called right after the press).
6. **Cancel paths (AC-9).** All of these route to the guarded `onCancel`:
   - the Cancel button
   - `ResponsiveSheet.onClose`, which covers both the backdrop tap and the RN `Modal.onRequestClose`
   - `onRequestClose` covers the Android back button and Escape on web: react-native-web 0.21 `ModalContent` calls `onRequestClose` on an Escape keyup (verified in `node_modules/react-native-web/dist/exports/Modal/ModalContent.js:26-35`)

   `ResponsiveSheet` has no drag-to-dismiss (its header comment says so), so AC-9's "sheet's close gesture" is the backdrop tap on this surface. No extra handling is needed.
7. **Store switch closes the prompt (answering the spec's open risk: yes).** The component reads `useStore((s) => s.currentStore?.id)`.
   - If that differs from `props.storeId`, it renders `null` immediately, so nothing flashes.
   - A `useEffect` keyed on the mismatch flag then calls the guarded `onCancel()` so the host clears its pending state.

   Rationale: a draft PO and a file must never come from a prompt opened for a different store. Without the clear, switching back to the original store would make a stale prompt reappear. In practice the full-screen modal scrim blocks the TitleBar and phone store switchers, so this mostly guards keyboard and palette-driven switches. It is cheap, it lives in one place, and it is the strictest reading of AC-15.
8. **Surface:** `<ResponsiveSheet visible onClose={cancel} presentation={{ desktop: 'center-modal', phone: 'bottom-sheet' }} tabletSheetHeight={0.45} accessibilityLabel={T('section.reorder.exportLanguagePrompt.aria')} header={…} footer={…}>`.
   - Web desktop is a centered modal. It uses the same shape as `TypeToConfirmModal`, `SetStoreUserPasswordModal` and `CascadePreviewModal`. `center-modal` is fixed at `min(720, vw-32)` wide, so the content column should cap itself at about 380 px wide. Do **not** add a width prop to `ResponsiveSheet` (38 consumers; out of scope).
   - Tablet and phone (web or native) use a bottom sheet at 45% of the viewport height, with the safe-area bottom inset that `ResponsiveSheet` already applies.
   - Native uses the RN `Modal` underneath, so it is a real modal window and is unaffected by the card's `overflow: 'hidden'`.
   - No `window.prompt` / `window.confirm` (AC-20).
9. **Content:**
   - title `exportLanguagePrompt.title`
   - subtitle `exportLanguagePrompt.subtitle` with `{ format: T(formatKey), vendor: vendorName }`
   - the picker
   - **PDF only:** the `exportLanguagePrompt.pdfLatinOnly` hint line, wrapped in its own `{format === 'pdf' ? … : null}` block with testID `export-lang-pdf-hint`. **REMOVABLE**: the owner did not ask for it. Main Claude will raise it. Removing it means deleting that one block, one key in each of the three catalogs and its one test assertion. Nothing else depends on it.
   - footer: Cancel (`common.cancel`, testID `export-lang-cancel`) and Continue (`exportLanguagePrompt.confirm`, testID `export-lang-confirm`, primary/accent style), each at least 44 px tall.
   - root sheet content testID `export-lang-prompt`.

### 2. Desktop `ReorderSection.tsx`: split into "open prompt" and "confirm(locale)"

Shared rule for all three desktop sites:

- The press handler only decides whether to open the prompt (or, for the import CSV, to export immediately).
- The `run*(locale)` function is the existing handler body. Its only change is that `locale` becomes a parameter instead of `useLocale()`.
- Hoist the snapshot helper to module scope and `export` it, so the phone tier imports it the same way it already imports `handleCsvExport`:
  ```ts
  export function exportSnapshot(store: Store, payload: ReorderPayload): { storeId: string; referenceDate: string | undefined }
  // = { storeId: store.id, referenceDate: payload.asOfDate || undefined }
  ```
  All six sites use it, which removes the three slightly different inline variants.

#### `ReorderVendorExportButtons` (sites 2 + 3, web-only via `showExport`)

```
const uiLocale = useLocale();   // still needed: passed to the import branch (ignored there)
const [prompt, setPrompt] = useState<{ format: 'csv' | 'pdf'; storeId: string } | null>(null);

runCsv = async (locale: Locale) => {            // == today's onCsv body, locale param
  if (!reorderPayload || !currentStore) return;  // AC-15 no-op guard (unchanged)
  const exportedAt = exportSnapshot(currentStore, reorderPayload);   // before first await
  const narrowed = narrowReorderToVendor(reorderPayload, vendor);
  const importCfg = pickImportVendor(narrowed, vendorsList);         // re-evaluated at run time
  const ok = importCfg ? handleImportExport(narrowed, currentStore, importCfg, inventory)
                       : await handleCsvExport(narrowed, currentStore, locale);
  if (ok) { void recordExportedOrder?.(vendor, exportedAt).catch(...); clearReorderEditsForVendor(vendor.vendorId); }
};
runPdf = async (locale: Locale) => { /* today's onPdf body, locale param */ };

onCsvPress = () => {
  if (prompt) return;
  if (!reorderPayload || !currentStore) return;
  const importCfg = pickImportVendor(narrowReorderToVendor(reorderPayload, vendor), vendorsList);
  if (importCfg) { void runCsv(uiLocale); return; }           // AC-4: no prompt, runs NOW as today
  setPrompt({ format: 'csv', storeId: currentStore.id });      // AC-3
};
onPdfPress = () => {
  if (prompt) return;
  if (!reorderPayload || !currentStore) return;
  setPrompt({ format: 'pdf', storeId: currentStore.id });      // AC-2
};
// render, inside the existing fragment after the two buttons:
{prompt ? <ExportLanguagePrompt format={prompt.format} vendorName={vendor.vendorName || ''}
   storeId={prompt.storeId} onCancel={() => setPrompt(null)}
   onConfirm={(loc) => { const f = prompt.format; setPrompt(null); void (f === 'csv' ? runCsv(loc) : runPdf(loc)); }} /> : null}
```

Notes:

- `runCsv` keeps the `importCfg` branch. If the vendor's import format flips while the prompt is open (a realtime vendors reload), the confirm still emits the correct file type. The locale is ignored on that branch, as it is today.
- The spec-156 tail is unchanged: one `if (ok)`, record invoked and not awaited, with `.catch`, then clear (AC-14).
- `handlePdfExport`'s `zh-CN → en` coercion stays as is (AC-12). The prompt never offers zh-CN for PDF, so the coercion becomes defense in depth.

#### `ReorderQuickOrderButton` (site 1, web + native)

```
const [prompt, setPrompt] = useState<{ storeId: string } | null>(null);

onPress = () => {
  if (busy || prompt) return;                 // AC-16: no second prompt while open or exporting
  if (!currentStore?.id) return;
  setPrompt({ storeId: currentStore.id });    // AC-1: nothing built / shared / recorded yet
};
runQuickOrder = async (locale: Locale) => {
  if (!reorderPayload || !currentStore) return;   // NEW for this site, per AC-15 (matches CSV/PDF)
  if (busy) return;
  setBusy(true);
  const exportedAt = exportSnapshot(currentStore, reorderPayload);   // before first await
  try {
    /* today's body verbatim, except resolveName uses `locale` (param), not useLocale().
       dialogTitle / toasts / onPreview unitNote keep T() = UI language (AC-13). */
  } finally { setBusy(false); }
};
// render: wrap the existing TouchableOpacity in a fragment and add
{prompt ? <ExportLanguagePrompt format="quickOrder" vendorName={vendor.vendorName || ''}
   storeId={prompt.storeId} onCancel={() => setPrompt(null)}
   onConfirm={(loc) => { setPrompt(null); void runQuickOrder(loc); }} /> : null}
```

Notes:

- `onPreview` is called only inside `runQuickOrder`, so cancel never touches the preview (AC-9).
- The button's `disabled={busy}` and opacity are unchanged. While the prompt is open the modal scrim covers the button anyway; the `prompt` check in `onPress` is defense in depth.
- **Closure freshness (AC-15):** the prompt is rendered by the host, so the `onConfirm` it receives comes from the host's **latest** render. `currentStore`, `reorderPayload` and `vendor` are read at confirm time, and the snapshot and the file come from the same values. Do not capture these values when the prompt opens or store them in the pending state. Only `storeId` (for the store-switch check) and `format` go there.

`VendorCard` is unchanged: it still renders `<ReorderVendorExportButtons vendor={vendor} />` and `<ReorderQuickOrderButton … />` in the header row. The prompts portal out (react-native-web `Modal` uses a portal; native `Modal` is a separate window), so they add no layout to the `gap: 10` row.

Desktop store switch: `loadFromSupabase` nulls `reorderPayload`, so `partitionReorderVendors` returns nothing, every `VendorCard` unmounts and any open prompt unmounts with it. The prompt's own store-id check (§1b.7) is the second layer.

### 3. Phone tier `PhoneOrdering.tsx`: prompt state and run logic lift to `PhoneOrdering`

Problem: `OverflowSheet` calls `onClose()`, which sets `sheetVendorId = null` and unmounts it, so any state or closure that lives in it is gone. A prompt confirm needs a host that stays mounted and re-renders with fresh store values.

Decision: **`PhoneOrdering` (the root) owns the pending-export state AND the three `run*` functions.** `OverflowSheet` becomes an intent emitter.

**`OverflowSheet` changes:**

- New prop `onExport: (format: ReorderExportFormat) => void`.
- Drop its store selectors and the `run*` bodies, which move up.
- Actions:
  - quick: `onClose(); onExport('quickOrder');` on web and native.
  - csv: `onClose(); if (Platform.OS !== 'web') { Toast.show({ type: 'info', text1: T('common.availableOnDesktop') }); return; } onExport('csv');`
  - pdf: the same as csv, with `'pdf'`.

  The native early return stays byte-identical and stays in the sheet. So AC-18 holds: there is no prompt on native CSV/PDF, nothing is recorded or cleared, and the existing spec-156 AC-9 native pins pass unchanged in substance.
- `runOrderSchedule` is unchanged.

**`PhoneOrdering` additions.** All hooks go above the no-store early return, following the guard-after-hooks discipline (AC-REG-3 lineage). Selectors stay at the top of the body (AC-REG-8 lineage).

```
const vendorsSlice = useStore((s) => s.vendors);
const clearReorderEditsForVendor = useStore((s) => s.clearReorderEditsForVendor);
const recordExportedOrder = useStore((s) => s.recordExportedOrder);
const uiLocale = useLocale();
const [exportPrompt, setExportPrompt] =
  useState<{ vendorId: string; format: ReorderExportFormat; storeId: string } | null>(null);
const [promptReady, setPromptReady] = useState(false);   // native handoff (below)

runQuickOrder(v: ReorderVendor, locale: Locale)   // today's OverflowSheet body minus onClose(), plus the
runCsv(v: ReorderVendor, locale: Locale)          //   `if (!reorderPayload || !currentStore) return;` guard,
runPdf(v: ReorderVendor, locale: Locale)          //   exportSnapshot() before the first await, the picked
                                                  //   locale in place of useLocale(), and the spec-156 tail as-is.
requestExport(vendorId, format):
  const v = vendors.find((x) => x.vendorId === vendorId);   // the edit-overlaid list = today's sheetVendor
  if (!v || !currentStore?.id) return;
  if (format === 'csv') {
    if (!reorderPayload) return;
    if (pickImportVendor(narrowReorderToVendor(reorderPayload, v), vendorsSlice)) { void runCsv(v, uiLocale); return; }  // AC-4 / AC-17
  }
  setPromptReady(Platform.OS === 'web');
  setExportPrompt({ vendorId, format, storeId: currentStore.id });

onPromptConfirm(locale):
  const p = exportPrompt; setExportPrompt(null); setPromptReady(false);
  if (!p) return;
  const v = vendors.find((x) => x.vendorId === p.vendorId); if (!v) return;
  void (p.format === 'quickOrder' ? runQuickOrder(v, locale) : p.format === 'csv' ? runCsv(v, locale) : runPdf(v, locale));
onPromptCancel(): setExportPrompt(null); setPromptReady(false);
```

Render: `<OverflowSheet … onExport={(f) => requestExport(sheetVendor.vendorId, f)} />` is unchanged otherwise, plus:

```
{exportPrompt && promptReady && promptVendor
  ? <ExportLanguagePrompt format={exportPrompt.format} vendorName={promptVendor.vendorName || ''}
      storeId={exportPrompt.storeId} onConfirm={onPromptConfirm} onCancel={onPromptCancel} />
  : null}
```

Here `promptVendor = vendors.find(v => v.vendorId === exportPrompt.vendorId)`. If the vendor drops out of the list (a date reload, or the vendor no longer ordered out today), the prompt is not rendered and an effect clears the pending state. That is a silent cancel, which AC-9 allows: no side effects.

AC-19 holds structurally: the pending state lives in the component that outlives `OverflowSheet`.

**Native two-sheet sequencing.** On iOS, presenting a `Modal` in the same commit that another `Modal` is dismissing is a known UIKit failure ("Attempt to present … while a presentation is in progress"). The second modal silently never shows, which is exactly the AC-19 failure. So:

- **Web** (including the phone-tier web layout): `promptReady` is set to `true` in the same handler as the pending state, and the prompt mounts in the same commit that unmounts `OverflowSheet`. react-native-web modals are DOM portals, so there is no presentation conflict.
- **Native:** `promptReady` starts `false`. A `useEffect` keyed on `exportPrompt` runs `setTimeout(() => setPromptReady(true), PHONE_SHEET_HANDOFF_MS)` with `PHONE_SHEET_HANDOFF_MS = 350`. That is a module constant: the `Modal` fade (about 300 ms) plus margin. The effect cleanup clears the timer, so cancel, store switch or unmount during the window leaves nothing behind.
- The confirm path is still synchronous once the prompt shows, so AC-15 is unaffected by the delay.

Alternative considered and **rejected for now**: swap the overflow sheet's contents to a "language" step inside one `Modal`. That avoids the two-modal race entirely, but it contradicts AC-17's literal "after the action sheet closes" sequence and the PM's risk framing. If the first live iOS pass (still blocked on the Xcode install, spec 181) shows the 350 ms handoff is unreliable or janky, this is the fallback. It is a host-only change: the `ExportLanguagePrompt` contract stays the same apart from rendering its body without the `ResponsiveSheet` wrapper.

Phone store switch: the prompt's own store-id check closes it (§1b.7). The `useEffect` timer cleanup keyed on `exportPrompt` also covers the native handoff window. The phone `PhoneStoreSwitch` sheet cannot be reached while the prompt's scrim is up.

### 4. i18n keys (all three catalogs, identical key set)

Namespace `section.reorder.exportLanguagePrompt.*`, nested under the existing `section.reorder` object. I kept the PM's key names. The developer supplies the es and zh-CN copy, and review checks it. Suggested copy:

| Key | en | es (suggested) | zh-CN (suggested) |
|---|---|---|---|
| `title` | Which language? | ¿En qué idioma? | 使用哪种语言？ |
| `subtitle` | `{format} · {vendor}` | `{format} · {vendor}` | `{format} · {vendor}` |
| `formatCsv` | CSV | CSV | CSV |
| `formatPdf` | PDF | PDF | PDF |
| `formatQuickOrder` | Quick-order list | Lista de pedido rápido | 快速订货清单 |
| `pdfLatinOnly` **(REMOVABLE)** | PDF is available in English or Spanish. | El PDF está disponible en inglés o español. | PDF 仅提供英文或西班牙文版本。 |
| `confirm` | Continue | Continuar | 继续 |
| `aria` | Choose export language | Elegir idioma de exportación | 选择导出语言 |

Reused keys (do not duplicate): `chrome.localeSwitcher.labels.{en,es,zh-CN}` (segment labels, via `ExportLocalePicker`), `common.cancel`. `chrome.localeSwitcher.aria` is **not** used by the prompt; it is replaced by the `aria` override (§1a). `src/i18n/i18n.test.ts` catalog parity must stay green (AC-21).

### 5. Jest test plan

**New suites**

1. `src/components/cmd/ExportLanguagePrompt.test.tsx`. Mock `useStore` with `currentStore`, `locale` and a `setLocale` spy, and mock `useT` as a key→string dict. Cover:
   - Pure helpers: the `exportLocaleOptions` matrix, and the `defaultExportLocale` matrix ({en, es, zh-CN, undefined} × {csv, pdf, quickOrder}; zh-CN+pdf → en; undefined → en).
   - AC-5: csv and quickOrder render 3 options; pdf renders 2, and `export-lang-option-zh-CN` is **absent**, not disabled.
   - AC-6: the default option has `accessibilityState.selected === true`, including zh-CN UI + PDF → EN.
   - AC-7: confirm with the default passes the UI locale; change to ES, then confirm, passes `'es'`.
   - AC-9: Cancel button, `ResponsiveSheet` backdrop, and `UNSAFE_getByType(Modal).props.onRequestClose()` (the Escape / Android-back path). Each calls `onCancel` once and never `onConfirm`.
   - Once-guard: double Continue gives one `onConfirm`; Continue then cancel gives no `onCancel`.
   - AC-8: `setLocale` is never called on option press, confirm or cancel. Remount after picking ES reseeds from the UI locale.
   - Store switch: change the mocked live `currentStore.id` and rerender. The prompt renders nothing and `onCancel` is called exactly once.
   - AC-20: the sheet's `accessibilityLabel` is the `aria` key; `radiogroup` / `radio` roles are present.
   - `export-lang-pdf-hint` is present only for PDF. **(Removable with the key.)**
2. `src/screens/cmd/sections/__tests__/ReorderSection.exportLanguagePrompt.spec183.test.tsx`. Clone the boundary mocks from `ReorderSection.recordExport.spec156.test.tsx` and partially mock `utils/poQuickOrderText` to spy on `buildPoQuickOrderText`. Cover:
   - AC-1/2/3: pressing QO, PDF or generic CSV mounts `export-lang-prompt`. `buildPoQuickOrderText`, `sharePurchaseOrder`, `buildReorderCsv`, jsPDF `save` and `recordExportedOrder` are all not called.
   - AC-4: a US Foods vendor's CSV opens no prompt, the import runs and records once. On the same card, PDF and QO still prompt.
   - AC-10: an unmapped row with `i18nNames.es` → pick ES → the `sharePurchaseOrder` text carries the es name. A mapped `<code>\t<qty>` line is identical for en vs es.
   - AC-11: `buildReorderCsv` receives `'es'` after an ES pick, and `'en'` on a default-en confirm.
   - AC-12: PDF with ES → a known es-catalog header string appears in the jsPDF `text` spy calls. Optionally pin zh-CN coercion by calling the exported `handlePdfExport` directly with `'zh-CN'`.
   - AC-9 per site: cancel → no record, no clear, no `Toast.show`, and no quick-order preview block rendered.
   - AC-14 per site through the prompt: `['record','clear']` on success, nothing on a failure or a dismissed share.
   - AC-15:
     - (a) Open the prompt, replace `mockState.reorderPayload` with a different `asOfDate`, `rerender`, confirm. The recorded `referenceDate` and the exported payload's `asOfDate` are both the new date (one source).
     - (b) Open the prompt, set `mockState.reorderPayload = null`, `rerender`. The prompt is gone and nothing runs.
     - (c) Open the prompt, change `mockState.currentStore`, `rerender`. The prompt auto-dismisses and nothing runs.
   - AC-16: a second QO press while the prompt is open → still exactly one `export-lang-prompt`. A held `sharePurchaseOrder` promise plus another QO press → no new prompt and no second share.
   - AC-8: `mockState.setLocale` spy is never called.
3. `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.exportLanguagePrompt.spec183.test.tsx`. Use the real store via `useStore.setState`, cloned from the phone spec-156 suite. Cover:
   - Web: QO, CSV and PDF → the `phone-order-sheet-*` rows are gone, `export-lang-prompt` is present, nothing is called before confirm, and confirm runs with the picked locale (AC-17, AC-19).
   - Native (`mockPlatform.OS = 'ios'`, `jest.useFakeTimers()`): QO → the prompt is absent until `PHONE_SHEET_HANDOFF_MS` has elapsed, then present, then confirm → share. CSV and PDF → the `availableOnDesktop` toast, no prompt ever, even after the timers run (AC-18).
   - A US Foods vendor's CSV opens no prompt.
   - Store switch via `useStore.setState({ currentStore: … })` while the prompt is open → the prompt closes and nothing is recorded or cleared.
   - Cancel is a no-op.
   - `useStore.setState({ locale: 'zh-CN' })` + PDF → EN is selected and there is no 中文 segment.
4. Additions to `src/components/cmd/ExportLocalePicker.test.tsx`. **Keep the four existing tests unedited.** Add:
   - `options={['en','es']}` renders 2 segments in canonical order, even if passed reversed.
   - Default props: no segment has a `testID`, and a segment's style still has `paddingVertical: 3` and label `fontSize: 9.5` (the spec-139 byte-identical pin).
   - The `accessibilityLabel` override applies to the radiogroup.
   - `testIDPrefix` produces `${prefix}-${locale}`.

**Existing suites to update** (go through the prompt; **delete no test case**, per AC-22):

| File | Press sites | Change |
|---|---|---|
| `src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx` | 16 | Add a `confirmExportPrompt()` helper (`fireEvent.press(getByTestId('export-lang-confirm'))`) after every QO, generic-CSV and PDF press. The US Foods and SYSCO CSV cases get **no** confirm, plus an `expect(queryByTestId('export-lang-prompt')).toBeNull()`. The store-switch / null-payload "Medium 1/2" cases: press QO, confirm, **then** mutate during the held share (the window they pin is unchanged). |
| `src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx` | 6 | Add a confirm after each press. The spec-156 header note "spec-138 suite stays UNEDITED" was a spec-156 constraint; spec 183 AC-22 explicitly authorizes routing it through the prompt. |
| `src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx` (L275) | 1 | Add a confirm after the CSV press. The synchronous `buildReorderCsv` assertion stays valid (§1b.5). |
| `src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx` (L280) | 1 | Same as above. |
| `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx` | 12 | Change `pressSheetAction(testID, { confirm })` to take an **explicit** `confirm` flag. Do not make it conditional on "prompt present", which would weaken the pins. Quick, generic CSV and PDF on web use `confirm: true`. The US Foods case and the native AC-9 cases use `confirm: false`. Describe names that mention `OverflowSheet.run*` may be renamed to `PhoneOrdering.run*`; keep the case bodies. |

These must pass **unedited**, as regression signals: `PhoneOrdering.test.tsx`, which only asserts the sheet rows render, and the spec 130/135/123 QO-existence checks. Also every `EODCountSection` / `InventoryCountSection` suite (spec 139 picker unchanged), `i18n.test.ts`, and the `PhoneApproveOrder` suites (it imports `VendorOrderCard` / `LineStepper`, which are untouched).

Gates (AC-22): full `npx jest`, `npm run typecheck`, `npm run typecheck:test`. `typecheck:test` is a CI gate that jest does not cover; the new `onExport` prop on `OverflowSheet` and the changed `pressSheetAction` signature will both show up there.

### 6. Risks and tradeoffs

1. **iOS modal → modal handoff (phone QO on native).** The 350 ms deferral is a timing heuristic. It cannot be verified until the first live iOS pass (spec 181: Simulator blocked on the Xcode install). If it fails, the symptom is no prompt, which is safe: nothing is exported or recorded. The fallback is the single-`Modal` step design (§3), as a host-only change.
2. **Already true today, not introduced here: iOS share sheet right after a modal dismisses.** Today `OverflowSheet` calls `onClose()` and then immediately `Share.share`. After this spec, prompt-confirm closes the prompt `Modal` and then immediately calls `sharePurchaseOrder`, which has the same race. I am not changing it here, because deferring the share would split AC-15's "snapshot and file at confirm" path. Flag it for the same live iOS pass. If it reproduces, a follow-up should build the text and take the snapshot synchronously, then defer only the native `sharePurchaseOrder` call.
3. **Desktop card remount while the prompt is open.** `VendorCard` keys are group-qualified (`need-` / `ok-` / `nosched-`). A same-store realtime refresh that moves a vendor across the needs/enough split remounts the card and silently drops its prompt. That counts as a cancel with no side effects (AC-9), and it is rare. Lifting desktop prompt state to section level would avoid it, but it would mean moving three handlers' selectors up for an edge case. Rejected.
4. **Test churn.** About 36 press sites across 5 existing files. The `confirmExportPrompt` helper keeps the diffs mechanical. The risk is a developer "fixing" a test by deleting it, which AC-22 forbids. Reviewers should diff test-case counts per file.
5. **Shared-component regression (spec 139).** Mitigated by additive props with byte-identical defaults, plus the new style pin in the picker test. The count sections are not edited.
6. **`center-modal` is 720 px wide** for a small prompt. This is accepted for consistency with `TypeToConfirmModal` and its siblings. The content caps its own width. `ResponsiveSheet` is not touched.
7. **Phone guard-after-hooks.** The new `PhoneOrdering` hooks must sit above `if (!currentStore?.id || currentStore.id === '__all__') return …`. The phone-tier hook-order bug class from specs 140-148 applies.
8. **Performance and cold start.** No network, and no edge function, so no cold start. jsPDF's dynamic import still fires only after confirm, as today; the user may see the same chunk-load delay after Continue. The 286 KB seed dataset is irrelevant here, since there are no queries.
9. **Spec ambiguity resolved, not invented:** AC-15 asks for a null-payload no-op on confirm. Desktop and phone **quick-order** have no such guard today (they use optional chaining in the snapshot). This design adds it to both quick-order sites, as AC-15 requires. Under the new guard, a confirm after a store switch that nulled the payload exports nothing. Today the quick-order would still share.

### 7. Files expected to change

- NEW `src/components/cmd/ExportLanguagePrompt.tsx`, `src/components/cmd/ExportLanguagePrompt.test.tsx`
- MOD `src/components/cmd/ExportLocalePicker.tsx` (additive props), `src/components/cmd/ExportLocalePicker.test.tsx` (additions only)
- MOD `src/screens/cmd/sections/ReorderSection.tsx`: the two button components and the exported `exportSnapshot`
- MOD `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: `OverflowSheet` becomes an intent emitter; run logic and prompt state move to the root
- MOD `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- NEW `src/screens/cmd/sections/__tests__/ReorderSection.exportLanguagePrompt.spec183.test.tsx`, `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.exportLanguagePrompt.spec183.test.tsx`
- MOD the five existing suites listed in §5
- **Not touched:** `EODCountSection.tsx`, `InventoryCountSection.tsx`, `POsSection.tsx`, `ResponsiveSheet.tsx`, `useStore.ts`, `src/lib/db.ts`, `supabase/**`, `app.json`

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (frontend-only; no migrations, RPCs, edge functions or RLS). After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed. Keep the `pdfLatinOnly` hint isolated as designed (§1b.9). Main Claude is confirming it with the owner and it may be removed.
payload_paths:
  - specs/183-reorder-export-language-prompt.md

## Implementation notes (frontend-developer, 2026-10-26)

Built to the `## Backend design` as written. No deviations.

- The `pdfLatinOnly` hint is one isolated block in `ExportLanguagePrompt.tsx` (testID `export-lang-pdf-hint`). To remove it, delete that block, the key in the three catalogs, and the one test in `ExportLanguagePrompt.test.tsx` ("the PDF-only hint renders for PDF only").
- `PHONE_SHEET_HANDOFF_MS = 350` is exported from `PhoneOrdering.tsx`. All new `PhoneOrdering` hooks sit above the no-store early return.
- Existing suites were routed through the prompt. No test case was deleted. Per-file case counts are unchanged: spec156 desktop 16, spec138 reset 6, spec138 5, spec123 7, spec156 phone 12. The picker suite went from 4 to 9, with the original 4 unedited.
- Gates: full `npx jest` passed 284/284 suites and 3560/3560 tests. `npm run typecheck:test` exits 0. `npm run typecheck` reports 0 code errors, but it exits 2 because of 24 `TS2688` errors. Those come from empty duplicate dirs `node_modules/@types/* 2` (created 2026-10-26 21:47, before this work, and not touched by it). The same `tsc` with those dirs excluded from `--types` exits 0.
- Browser-verified on the local stack (desktop 1440, phone 390, and a zh-CN UI). The temporary local seed rows used for verification were reverted.

## Files changed

- `src/components/cmd/ExportLanguagePrompt.tsx` (new)
- `src/components/cmd/ExportLanguagePrompt.test.tsx` (new)
- `src/components/cmd/ExportLocalePicker.tsx` (additive optional props)
- `src/components/cmd/ExportLocalePicker.test.tsx` (additions only)
- `src/screens/cmd/sections/ReorderSection.tsx`
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`
- `src/i18n/en.json`
- `src/i18n/es.json`
- `src/i18n/zh-CN.json`
- `src/screens/cmd/sections/__tests__/ReorderSection.exportLanguagePrompt.spec183.test.tsx` (new)
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.exportLanguagePrompt.spec183.test.tsx` (new)
- `src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx`
- `src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx`
- `src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx`
- `src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx`
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx`
- `specs/183-reorder-export-language-prompt.md`
