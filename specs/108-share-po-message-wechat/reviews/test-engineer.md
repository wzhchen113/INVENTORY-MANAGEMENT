## Test report for spec 108

Scope: frontend-only spec (per Backend design section — no migration, no edge
function, no RPC, no RLS surface, no realtime publication change). Tests live
entirely in the **jest track**. No pgTAP or shell-smoke coverage is expected or
applicable to this spec.

Files reviewed:
- `src/utils/poShareText.ts` / `src/utils/poShareText.test.ts` (pure builder)
- `src/screens/cmd/lib/sharePo.ts` / `src/screens/cmd/lib/sharePo.test.ts` (impure orchestrator)
- `src/screens/cmd/sections/POsSection.tsx` / `src/screens/cmd/sections/__tests__/POsSection.test.tsx` (wiring)
- `src/i18n/{en,es,zh-CN}.json` (new `section.purchaseOrders.*` keys)
- `jest.config.js` (testMatch glob extension)
- Cross-checked against `src/lib/db.ts` (`PoLine`, `mapPoItemRow`, `mapItem`),
  `src/i18n/localizedName.ts` (`getLocalizedName`), `src/utils/reorderExport.ts`
  (`formatQty`), and the `src/screens/staff/lib/shareReorder.ts` precedent.

### Acceptance criteria status

- **AC1** ("Share PO" action in the PO detail action row, stable `testID`
  `po-action-share`) → **PASS** —
  `src/screens/cmd/sections/POsSection.tsx:373-382` renders the button with
  `testID="po-action-share"` inside the `TabStrip` `rightSlot`. Verified by
  `src/screens/cmd/sections/__tests__/POsSection.test.tsx::POsSection — Share
  visibility by status` (`it.each(['draft','sent','partial'])('Share IS shown
  on %s')`).

- **AC2** (plain-text from already-loaded `poLinesById[sel.id]`, no new
  network fetch; header = store + reference/order date; one line per item
  = qty × unit × name; trailing line count; **no dollar amounts anywhere**)
  → **PASS** —
  Template pinned byte-for-byte in
  `src/utils/poShareText.test.ts::buildPoShareText — template pin` (header +
  per-item lines + trailing count, exact `toBe` match). No-`$` invariant
  asserted in `buildPoShareText — NO money anywhere (AC)` (`expect(out).not
  .toContain('$')`). No-new-fetch is structurally true — `onShare`
  (`POsSection.tsx:197-245`) reads only `poLinesById[sel.id]`, `inventory`,
  `currentStore`, `sel`, all already-loaded store slices; no `fetch`/
  `supabase`/`.from`/`.rpc` call appears in `onShare`, `sharePo.ts`, or
  `poShareText.ts` (confirmed by grep — also independently confirmed in the
  security-auditor's finding #5).

- **AC3** (item names resolve via `getLocalizedName(inventoryRow, locale)` in
  the **current app locale at share time**, re-resolved against `inventory`
  row's `i18nNames` per line, with per-item **English fallback**)
  → **PASS**, with one **Note** (see below) —
  The injected-resolver contract (never emits `itemName` verbatim; falls back
  to it when the resolver returns the fallback) is pinned in
  `poShareText.test.ts::buildPoShareText — resolver + fallback (OQ-2)`. The
  actual call-site wiring — `inventory.find((i) => i.id === itemId)` then
  `getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale)`,
  falling back to `PoLine.itemName` when no row is found
  (`POsSection.tsx:204-207`) — was verified by direct code trace (not by a
  section-test assertion on the built text; see Notes). Type-shape trace
  confirms `PoLine.itemId` (`src/lib/db.ts:1406`, populated from `r.item_id`
  in `mapPoItemRow`) matches `InventoryItem.id` (`mapItem` sets `id: row.id`
  on the same `inventory_items` row), so the `.find` key is exact —
  `getLocalizedName`'s signature (`src/i18n/localizedName.ts:47-56`) matches
  the call site exactly, including its own internal English-fallback branch
  (`locale === 'en'` short-circuit + empty-translation guard).

- **AC4** (builder is a PURE, framework-free function under `src/utils/`,
  mirrors `reorderExport.ts`, jest-unit-testable; reuses `formatQty`; never
  imports/formats money) → **PASS** —
  `src/utils/poShareText.ts` imports only `formatQty` from `./reorderExport`
  (verified: `formatQty` is exported there and used identically to the
  Reorder precedent) and its own types; no React/theme/supabase import.
  `formatQty` reuse (2-decimal, trailing-zero-stripped) pinned in
  `poShareText.test.ts` (`'reuses formatQty (2-decimal, trailing-zero-
  stripped)'`). No `formatMoney` import anywhere in the file (grep-confirmed).

- **AC5** (platform-branched delivery — native `expo-sharing`
  `Sharing.isAvailableAsync()` gate; mobile-web `navigator.share({ text })`;
  desktop-web clipboard + visible preview) → **PASS**, with one documented
  **implementation deviation from the AC's literal wording** (see Notes) —
  All three branches are covered in `src/screens/cmd/lib/sharePo.test.ts`:
  native availability gate + share (`'gates on Sharing.isAvailableAsync then
  shares the message body'`, asserts `mockIsAvailableAsync` called before
  `mockShare`), mobile-web (`'calls navigator.share({ text }) → shared:true,
  no preview'`), desktop-web clipboard + preview (`'writes to clipboard, fires
  onCopyToast, returns previewText === text'`). The native primitive is RN
  `Share.share({ message })`, not `expo-sharing`'s `shareAsync` — this is a
  **pinned, documented design decision** (D-2 "native text handoff", spec's
  Implementation notes "Native primitive pinned"), not an unpinned gap; the
  AC's literal text says "open the OS share sheet via `expo-sharing`
  (`Sharing.shareAsync`)" but the design + implementation notes explicitly
  override this in favor of RN `Share` for a text body (avoids a stray `.txt`
  file), keeping `Sharing.isAvailableAsync()` as the availability gate per the
  AC. Flagging for visibility since it reads as a literal AC/implementation
  mismatch on first pass — resolved by design-doc authority, not silently.

- **AC6** (desktop-web clipboard write succeeds with success toast on copy;
  does not silently no-op when `navigator.clipboard` unavailable; preview is
  always-present fallback) → **PASS** —
  Three distinct desktop-web sub-cases tested in `sharePo.test.ts`: clipboard
  present + write succeeds → `onCopyToast` fires once, `previewText === text`;
  clipboard present + write rejected (blocked) → `onCopyBlocked` fires, **NOT**
  `Toast.show` (no false error), `previewText` still returned; clipboard
  entirely absent (`navigator = {}`) → `onCopyBlocked` fires, no silent
  success toast, `previewText` still returned. All three assert
  `previewText === TEXT`, confirming the preview is unconditionally present on
  every desktop-web sub-branch.

- **AC7** (auto-prompt "Did you send it? → Mark as sent" after completed
  share/copy on a **draft** PO; reuses EXISTING
  `markPurchaseOrderSentManually(sel.id)`; status never auto-flips without the
  prompt; declining leaves status unchanged) → **PASS** —
  `POsSection.test.tsx::POsSection — draft share triggers the mark-as-sent
  prompt`: (1) completed share → `confirmAction` called with
  `didYouSendTitle` → `markPurchaseOrderSentManually('po-1')` called; (2)
  declining the prompt (`mockConfirmAction` stubbed to not invoke `onConfirm`)
  → `markPurchaseOrderSentManually` **not** called (no-op / status stays
  draft); (3) dismissed share (`shared: false`) → `confirmAction` never
  called, `markPurchaseOrderSentManually` never called. No new store action
  introduced — `POsSection.tsx:236` calls the same
  `markPurchaseOrderSentManually` action `onMarkSent` already used (spec 107).

- **AC8** (Share exposed on draft/sent/partial; hidden on
  received/cancelled; sent/partial re-share is a reminder with **no status
  change** and the prompt **suppressed**; auto-prompt fires only from draft)
  → **PASS** —
  Visibility: `it.each(['draft','sent','partial'])('Share IS shown on %s')`
  and `it.each(['received','cancelled'])('Share is HIDDEN on %s')`. Re-share
  suppression: `POsSection — sent/partial re-share suppresses the prompt`
  (`it.each(['sent','partial'])`) asserts a completed share does **not** call
  `confirmAction` and does **not** call `markPurchaseOrderSentManually`.

- **AC9** (Share is **primary**/accent action; email demoted to
  **secondary**/outlined when `vendors.email` present; no-email hint
  repointed to nudge toward Share; email's `vendorEmail` gate unchanged)
  → **PASS** —
  `POsSection.test.tsx::POsSection — Share is primary; email demoted to
  secondary` renders both buttons and asserts the Share button's text color is
  `'#000'` (the accent-button treatment) while the email-send button's color
  is **not** `'#000'` (demoted to `C.fg2` outlined). No-email-hint repoint
  covered by the existing `'DRAFT + NO vendor email: hides send, shows
  mark-sent + the no-email hint'` test (still asserts `testID="po-no-email-
  hint"` renders; the hint's *content* now resolves through the renamed
  `noEmailShareHint` i18n key per `POsSection.tsx:447`, confirmed by direct
  code read — the key rename itself is a straightforward i18n-lookup swap,
  not independently re-asserted by string content in the section test, which
  is acceptable since the i18n catalog verification below covers the string
  content and the `T()` mock in this suite echoes keys verbatim). Email's
  `canSend && vendorEmail` gate is structurally unchanged from spec 107 (same
  conditional, confirmed by code read).

- **AC10** (all new user-facing strings — button label, dialog title, toast
  text, "Did you send it?" prompt, preview label, repointed no-email hint —
  added to the main i18n catalog in en/es/zh-CN; no hardcoded copy)
  → **PASS** —
  Verified all 13 new `section.purchaseOrders.*` keys
  (`shareAction`, `shareDialogTitle`, `copiedToast`, `didYouSendTitle`,
  `didYouSendBody`, `didYouSendCta`, `sharePreviewLabel`, `noEmailShareHint`,
  `shareBodyHeader`, `shareBodyStoreLabel`, `shareBodyDateLabel`,
  `shareBodyItemsCount`, `shareBodyNoItems`) are present in **all three**
  locale files by direct JSON parse (script run, all 13/13 present in each of
  `en.json`/`es.json`/`zh-CN.json`). The load-bearing **honest-question**
  wording (never an assertion) is preserved as an interrogative in every
  locale: `Did you send it?` / `¿La enviaste?` / `你发送了吗？` — confirmed by
  direct content read, not just key presence. This AC has no dedicated
  automated test (i18n catalog-parity is enforced generically by
  `src/i18n/i18n.test.ts`, which is not spec-108-specific), but was manually
  verified against the raw catalog files as part of this review; no hardcoded
  string literal appears in `POsSection.tsx`'s new code (every new string is
  a `T('section.purchaseOrders.*')` call, confirmed by code read).

- **AC11** (share/copy failures surface via existing toast mechanism, never
  throw to the caller — same posture as `shareReorder.ts`) → **PASS** —
  `sharePo.test.ts`: `'Sharing unavailable → failure toast, no throw, no
  Share.share'` and `'navigator.share non-abort error → failure toast, never
  throws'` both assert the promise **resolves** (`{ shared: false, previewText:
  null }`) rather than rejecting, and that `Toast.show` fires with
  `type: 'error'`. The whole orchestrator body is wrapped in `try/catch`
  (`sharePo.ts:108-141`) matching the `shareReorder.ts` posture verbatim.

### Test run

```
npx jest --silent
Test Suites: 82 passed, 82 total
Tests:       896 passed, 896 total
Snapshots:   0 total
Time:        3.143 s
```

Matches the spec's stated verification claim (82 suites / 896 tests) exactly.
All three new/changed test files ran and passed:
- `PASS unit src/utils/poShareText.test.ts`
- `PASS unit src/screens/cmd/lib/sharePo.test.ts`
- `PASS component src/screens/cmd/sections/__tests__/POsSection.test.tsx`

```
npx tsc --noEmit               → exit 0, no output (clean)
npx tsc -p tsconfig.test.json --noEmit → exit 0, no output (clean)
```

Both typechecks clean, no errors.

**`jest.config.js` testMatch extension verified correct.** The unit project
gained `<rootDir>/src/screens/cmd/lib/**/*.test.ts` (note: `.test.ts`, not
`.test.tsx`). Confirmed:
- `src/screens/cmd/lib/sharePo.test.ts` actually ran under the `unit`
  (node-env) project in the jest output above (`PASS unit
  src/screens/cmd/lib/sharePo.test.ts`), proving the glob addition is live in
  the same jest invocation CI runs (`npx jest` with no extra flags).
- No collision risk with the `component` project's pre-existing
  `<rootDir>/src/screens/**/*.test.tsx` glob: the two globs are
  extension-disjoint (`.ts` vs `.tsx`) and `find` confirms only
  `sharePo.ts` + `sharePo.test.ts` currently exist under
  `src/screens/cmd/lib/` — no `.tsx` file present there to be
  double-matched or accidentally excluded.
- Exact sibling of the pre-existing `src/screens/staff/lib/**/*.test.ts`
  carve-out (spec 063) already in the same array — consistent precedent, not
  a new pattern.

### Notes

**No framework gap.** All new tests land in the existing jest track exactly as
the spec's "Tests" line specifies (`jest track... No pgTAP... no shell
smoke`). No new test framework was introduced. No `package.json` change (D-1
resolved against adding `expo-clipboard`), so no dependency-audit gap either.

**Minor coverage gap (non-blocking) — AC3's exact call-site wiring is not
assertion-tested at the section level.** `POsSection.test.tsx` mocks
`getLocalizedName` down to `(row) => row?.name ?? ''` and never asserts on the
`text` argument actually passed to the mocked `sharePurchaseOrder` (grepped:
no `mock.calls[...][0]` inspection of the built string anywhere in that file).
This means:
- The pure resolver contract (never emit `itemName` verbatim; per-item English
  fallback) IS pinned, byte-for-byte, in `poShareText.test.ts`.
- The platform-branch selection IS pinned in `sharePo.test.ts`.
- But the **glue** in `POsSection.onShare` — that it correctly builds the
  `NameResolver` closure over `inventory` + `locale` and passes `currentStore
  .name` / `(sel.date || '').slice(0,10)` / the right `lines` mapping into
  `buildPoShareText` — is only verified by direct code trace in this review,
  not by an automated assertion. A future refactor that accidentally swapped
  `sel.vendorName` for `currentStore.name` as `storeName`, or dropped the
  `inventory.find` lookup, would not be caught by any current test (all three
  files pass because each mocks around the boundary the other tests).
  This is a real but narrow gap — not sufficient to mark AC3 NOT TESTED, since
  the wiring was independently verified during this review (type-shape trace:
  `PoLine.itemId` = `inventory_items.id` = `InventoryItem.id`; `getLocalizedName`
  signature match) and the two adjacent unit-test layers are solid. Recommend
  a follow-up: one `POsSection.test.tsx` assertion that inspects
  `mockSharePurchaseOrder.mock.calls[0][0]` and confirms it contains the
  inventory-resolved (not plain-English) item name, to close the seam.

**AC5 literal-wording vs. implementation — flagged, resolved by design
authority, not a defect.** The AC bullet's literal text says native delivery
uses "the OS share sheet via `expo-sharing` (`Sharing.shareAsync`)". The
shipped code uses RN `Share.share({ message })` instead (keeping
`Sharing.isAvailableAsync()` only as the availability gate), per the
design doc's D-2 discussion and the Implementation notes section explicitly
titled "Native primitive pinned (D-2 decision (b))". This is a considered,
documented deviation (a PO is a text body, not a file — `expo-sharing`'s
`shareAsync` is file/URI-oriented and would leave a stray `.txt` in the
vendor's chat), pinned in both a module comment (`sharePo.ts:14-18`) and a
jest test comment. Surfacing this explicitly because a literal AC-vs-code diff
would otherwise read as an unflagged contract break; it is not — the design
doc is the authority here and the implementation notes call it out by name.
No action needed, but the release-coordinator should know this AC's letter
and its shipped behavior diverge intentionally.

**Cross-platform note.** This is an admin Cmd-surface-only feature (Out of
scope explicitly excludes the staff app). No native testing gap to report
beyond the general project note that native builds are rare for the
web-primary admin surface — consistent with the spec's own "Web/native scope"
line.

**`app.json` slug** — not touched by this spec; no action needed, no violation
of the hard rule.

**Realtime** — no publication change; the `docker restart
supabase_realtime_imr-inventory` step does not apply here, correctly noted by
the spec itself and not exercised by any test (correctly, since there's
nothing new to exercise).

**No mocked-DB integration test required.** This spec makes zero Supabase
calls in its new code (`poShareText.ts`, `sharePo.ts`); the one DB write in
the whole flow (`markPurchaseOrderSentManually`) is a pre-existing spec-107
action already covered by that spec's own integration tests. Per project
policy ("integration tests must hit a real database"), there is no new
DB-touching surface here to integration-test — the jest-only coverage is the
correct posture for a frontend-only spec, not a shortcut around policy.

### Verdict

All 11 acceptance criteria: **PASS**. No FAIL, no NOT TESTED. Full jest suite
green at 82 suites / 896 tests (matches spec's stated count exactly). Both
typechecks clean. One non-blocking coverage gap noted (AC3's exact
call-site wiring not assertion-tested, only code-traced) and one flagged
literal-AC-vs-implementation divergence (AC5's native primitive, resolved by
design-doc authority). Neither blocks shipping — both are Notes, not
Criticals, per this agent's own findings.
