# Spec 141: Staff EOD count — keypad-sheet redesign (touch-first parity with spec 140)

Status: READY_FOR_REVIEW

> Sibling of spec 140. Spec 140 brought the touch-first "keypad-sheet" counting
> UX to the ADMIN console's phone-tier EOD section. This spec brings the SAME
> design language to the STAFF app's EOD count screen
> (`src/screens/staff/screens/EODCount.tsx`) — a large-target counted/uncounted
> row + a keypad bottom-sheet entry flow — re-implemented against STAFF
> primitives.
>
> This is a **RE-IMPLEMENTATION**, not a port: the staff app is a separate
> codebase with its own theme, components, store, i18n, and submit path (per
> CLAUDE.md). Nothing from the admin `src/screens/cmd/` subtree is imported.

## ⛔ HARD NON-GOAL (owner guardrail — read first)

Owner request, verbatim: *"Apply same to staff users, but keep the current
permissions they have right now."*

This is a **PURELY PRESENTATIONAL** redesign. It must NOT widen OR narrow what a
staff user can see, submit, or do — not by one iota. **ABSOLUTELY NO changes to:**

- authentication, `RoleRouter` dispatch, or which surface staff land on
  (staff role → `StaffStack`, unchanged);
- RLS policies, the `staff_submit_eod` RPC, any other RPC or edge function,
  `user_stores` per-store visibility, or the price/receiving gates (spec 113);
- which stores, vendors, or items a staff user sees;
- which dates a staff user may submit for (the existing Today/Yesterday window
  is preserved exactly — see AC-REG-5 and Out of scope; a wider date range would
  be a capability change and is out of scope).

**If the redesign appears to require a permission, RPC, RLS, or capability
change, STOP and flag it to the PM — it is out of scope.** No backend,
migration, edge-function, or RLS work is part of this spec.

## User story
As a store staffer entering end-of-day counts on my phone in a walk-in with one
gloved thumb, I want the same large-target, keypad-driven count entry that the
admin console just got, with a clear counted / not-counted indicator on every
row, so I can finish the count fast without fat-fingering — while everything I
was already allowed (and not allowed) to do stays exactly the same.

## Acceptance criteria

### New / redesigned presentation

**Count row + indicator**
- [ ] AC-1: Each count row shows a counted/uncounted **indicator** (staff-themed:
  a small square/dot) — uncounted = dashed `borderStrong`; counted = `primary`
  tint + a ✓ in `primary`. This REPLACES the current red-item-name treatment
  (`{ color: entered ? c.text : c.error }` on the name at `EODCount.tsx:813`):
  the name renders in `c.text` always; the indicator carries the counted state.
- [ ] AC-2: The row keeps the existing item metadata — localized name
  (`getLocalizedName`), `IngredientThumb`, `UpdatedBadge` (spec 128), unit ·
  `case of N` line, and the running-total line once counted. It shows **two
  count wells** (large tap targets): a "CS ×N" well shown only when
  `(caseQty ?? 0) > 1`, and a units well. An empty well reads "—"; a filled well
  shows its value. Tapping either well opens the keypad sheet (AC-4).

**Keypad bottom-sheet (the count-entry flow — custom in-app digit pad, OQ-STAFF-1 = A)**
- [ ] AC-3: A **staff bottom-sheet primitive** is introduced (there is NO
  `ResponsiveSheet` in the staff subtree; the architect chooses RN
  `Modal` + `Animated` slide-from-bottom vs a small reusable staff component —
  it MUST NOT import the admin `ResponsiveSheet`, and MUST NOT add
  `@gorhom/bottom-sheet` or Reanimated). It renders on the staff **light**
  palette (`useStaffColors()` → `surface` / `border` / `primary` / `text`
  tokens; the staff theme is light-only per CLAUDE.md), respects
  `useStaffTokens()` UI scale, and dismisses on scrim tap + a ✕ close (no
  drag-to-dismiss).
- [ ] AC-4: Tapping a well opens the keypad sheet seated on that item, with the
  tapped well as the active field. The sheet contains: item name + meta + ✕
  close; the two field wells (active field = `primary` border + tint); a note
  input (a real `TextInput` — native keyboard is correct there); a running total
  ("= 112 lbs total"); a 3-column in-app digit pad (1–9, `.`, 0, ⌫); and a
  footer with SKIP → and NEXT ITEM → / DONE ✓.
- [ ] AC-5: Digits append to the active field via a pure helper: `0-9` append;
  `.` appends only if none present; `⌫` drops the last char; max 5 chars, single
  `.`. `0` is a valid count. Writes go through the SAME `caseCounts` /
  `unitCounts` maps that submission reads (`onSubmit` at `EODCount.tsx:617`),
  so the row indicator, "X of N counted" label, and gate update live and SKIP /
  close need no separate commit step. The note field writes to the same
  submission path as today (parity — if notes are not persisted today, they are
  not persisted now; flag any gap rather than adding persistence).
- [ ] AC-6: The active field defaults to the CS well when `(caseQty ?? 0) > 1`,
  else the units well; tapping the other well switches the active field.
- [ ] AC-7: **NEXT ITEM** advances to the next uncounted item **with
  wraparound**, reusing `firstUncounted` (`src/screens/staff/lib/countOrder.ts`)
  over the CURRENT on-screen order (default order, or the saved custom order when
  `viewMode === 'custom'` — spec 103). When nothing uncounted remains, the button
  relabels to **DONE ✓**; tapping DONE ✓ closes the sheet. **SKIP** advances
  without recording a value for the current item.

**Day + vendor + progress chrome (restyle only)**
- [ ] AC-8: The existing Today / Yesterday count-date toggle is restyled to match
  the new touch-first language (larger targets, staff-themed) — **still exactly
  two states (today, yesterday)**; the late/yesterday semantics, the
  `yesterdayIncomplete` red-alert treatment, and the late banner are unchanged
  (AC-REG-5).
- [ ] AC-9: The vendor switcher and the per-vendor submitted status dot (spec
  129: green submitted / red outstanding, `submittedVendorIds`) are restyled but
  behaviorally unchanged, including the single-vendor static label + dot.
- [ ] AC-10: The "X of N counted" progress remains, restyled (may add a progress
  bar), driven by the SAME `countedNum` / `items.length` derivation.

### Regression guards (behavior that MUST NOT change)

- [ ] AC-REG-1: **Completeness gate + jump.** Submit still blocks until every
  item in the full `items` list is counted; the blocked-submit toast, the
  `search`-clear, and the jump-to-first-uncounted via `pendingFocusId` /
  `firstUncounted` all fire as today. In keypad-sheet terms the jump seats the
  target item and opens its keypad sheet (the `caseInputRefs` DOM-focus path may
  become a no-op when the native input is replaced by a well — the sheet-open
  must replace it so the gate still lands the user on the right item).
- [ ] AC-REG-2: **Counted-once (spec 102).** A row reads counted when its cases
  OR units field is non-blank; the shared-item counted-once-globally behavior at
  the fetch/submit layer is untouched (no change to `fetchItemsForVendor` /
  `item_vendors` querying).
- [ ] AC-REG-3: **Post-submit state machine (spec 129).** The
  UNSUBMITTED → SUBMITTED_LOCKED → EDITING derivation (`existing` + `editing`),
  the read-only lock, the Edit / Cancel affordances, `seedFromExisting`,
  `onCancelEdit`, and `submittedVendorIds` optimistic-green all behave exactly as
  today. Locked rows render read-only wells (no keypad on tap when locked).
- [ ] AC-REG-4: **Offline queue.** Counting works offline and syncs later:
  `useEodSubmit` (`submit` / `pending` / `draining`), the `eodQueue`, and the
  `QueueIndicator` are unchanged; all four submit outcomes (`success`,
  `success-replay`, `queued`, `forbidden`, error) keep their current handling and
  toasts.
- [ ] AC-REG-5: **Date window unchanged.** Staff can still submit for today or
  yesterday ONLY (`dayOffset ∈ {0,1}`); no new dates are reachable. The
  submit-time date capture (`§11 risk c`) is preserved.
- [ ] AC-REG-6: **Custom count order (spec 103).** `CountOrderDragList`, the
  Default ⇄ Custom toggle, per-vendor saved order (`fetchCountOrder` /
  `saveCountOrder` / `resetCountOrder`), and the drag-disabled-while-searching
  rule are preserved; the on-screen order feeds the NEXT ITEM advance (AC-7).
- [ ] AC-REG-7: **i18n + search + per-store.** EN / ES / 中文 parity is
  maintained for all new strings (skip / nextItem / done wells / running total /
  etc.); the ingredient-name search (localized + English, `matchesQuery`) still
  narrows the list; per-store scoping via `activeStore.id` is unchanged.
- [ ] AC-REG-8: **No backend delta.** `git diff` touches no file under
  `supabase/` and no `src/lib/db.ts` / RPC / edge-function surface. The staff
  submit path still flows through `useEodSubmit` → the existing RPC.

## In scope
- Restyle + rebuild of `src/screens/staff/screens/EODCount.tsx`'s count-entry UX:
  the counted/uncounted indicator, the two count wells replacing the inline
  `decimal-pad` inputs, the keypad bottom-sheet, and the SKIP / NEXT ITEM →
  DONE ✓ advance-with-wraparound.
- A new staff bottom-sheet primitive under `src/screens/staff/components/`
  (architect's call on the exact shape) built on RN `Modal` + `Animated`.
- Pure keypad/advance helpers for the staff subtree (jest surface) — either a new
  `src/screens/staff/lib/eodKeypad.ts` or reuse of an existing staff helper
  module (architect decides; must not import from `src/lib/`).
- Restyle of the Today/Yesterday toggle, vendor switcher, status dots, and the
  "X of N counted" progress to the touch-first language.
- EN / ES / 中文 additive i18n keys in the staff catalog
  (`src/screens/staff/i18n/`).
- Both native (iOS/Android) and web (react-native-web) — the staff app renders
  on both; the staff palette is light-only and there is no phone/desktop fork, so
  the redesign applies to the whole staff EOD screen (no `useIsPhone` gate).

## Out of scope (explicitly)
- **Any permission / auth / RLS / RPC / edge-function / migration change** — see
  the HARD NON-GOAL block. This is presentation only.
- **A 7-day day strip** (spec 140's AC-1). Staff's date model is a 2-state
  today/yesterday window; widening it to arbitrary dates would change which dates
  staff may submit for — a capability change barred by the owner guardrail. The
  existing 2-state toggle is restyled, not replaced. (Reconciliation of spec
  140's "day strip" vs staff's toggle — see Open questions resolved.)
- **The native decimal keyboard.** The owner chose the custom in-app digit pad
  (OQ-STAFF-1 = A); the native-keyboard fallback is dropped. Build ONLY the
  custom keypad-sheet flow.
- **The staff Reorder and Weekly count screens.** Mirroring spec 140's tight
  scope, only the EOD count screen is redesigned. A keypad pass on Reorder /
  Weekly is a possible follow-up spec.
- **The admin console EOD** (spec 140) — already shipped; untouched.
- **Importing any admin `src/screens/cmd/` code** (`PhoneEodCount`,
  `PhoneKeypadSheet`, `ResponsiveSheet`, `useCmdColors`, `PhoneType`,
  `usePaletteAction`, `eodKeypad`). The staff app must not depend on the admin
  subtree.
- **`@gorhom/bottom-sheet` / Reanimated-on-web.** New sheet uses RN
  `Modal` + `Animated`, matching the sanctioned idiom.
- **Realtime.** The staff stack does not use realtime (spec 062); this spec adds
  none.
- **Note-field persistence changes.** If notes are/aren't persisted today, that
  is preserved as-is; adding persistence is a separate scope question.
- **`app.json` slug** — untouched (load-bearing, see CLAUDE.md).

## Open questions resolved
- Q: OQ-STAFF-1 — custom in-app digit-pad sheet vs native decimal keyboard for
  staff count entry? → A (owner): the **custom in-app digit-pad sheet** — full
  parity with the admin spec-140 keypad flow (in-app number buttons, running
  total, SKIP / NEXT ITEM → DONE advance, active-field select), replacing the
  native decimal keyboard on the staff EOD count screen. Build ONLY this flow;
  the native-keyboard fallback is dropped from scope. AC-3..AC-7 stand as written.
- Q: Spec 140 has a 7-day day strip; the staff screen has a 2-state
  Today/Yesterday toggle — reconcile. → A (PM decision, guardrail-driven): keep
  the **2-state toggle**, restyled only. A 7-day strip would change which dates
  staff can submit for, which violates "keep the current permissions." Owner can
  revisit in a follow-up if they explicitly want a wider staff date window.
- Q: Which count screens? → A: **EOD count only** (mirrors spec 140's EOD-only
  scope). Reorder / Weekly are follow-ups.

## Dependencies
- Existing staff primitives (no new libs): `useStaffColors()` / `useStaffTokens()`
  / `useStaffElevation()` (`src/screens/staff/theme.ts`), `Button`, `Input`,
  `Banner`, `ListRow`, `IngredientThumb`, `UpdatedBadge`, `QueueIndicator`,
  `CountOrderDragList` (`src/screens/staff/components/`).
- Existing staff logic reused verbatim: `useEodSubmit` (`src/screens/staff/hooks/`),
  `eodQueue`, `applyCountOrder` / `firstUncounted` / `fetchCountOrder` /
  `saveCountOrder` / `resetCountOrder` (`src/screens/staff/lib/countOrder.ts`),
  the `caseCounts` / `unitCounts` maps + `onSubmit` gate, spec-129 state machine,
  `submittedVendorIds`, the Today/Yesterday `dayOffset` logic.
- Staff i18n catalog (`src/screens/staff/i18n/`) — additive keys, EN/ES/中文.
- New: a staff bottom-sheet component (RN `Modal` + `Animated`) — architect
  specifies the shape.
- No blocking open questions remain — ready for architecture.

## Project-specific notes
- **Cmd UI section / legacy:** Neither. This is the STAFF surface
  (`src/screens/staff/screens/EODCount.tsx`), a peer to the admin Cmd UI (spec
  063). No admin-subtree imports.
- **Which app:** This repo's staff surface only. Admin console untouched;
  customer PWA is a sibling repo, untouched.
- **Per-store or admin-global:** Per-store, scoped to `activeStore.id` exactly as
  today. No RLS or `auth_can_see_store()` change.
- **Edge function or PostgREST:** Neither is modified. Submission continues
  through the existing `useEodSubmit` path; no `verify_jwt` change; the retired
  `staff-*` 410 stubs are untouched.
- **Realtime channels touched:** None. Staff stack uses no realtime (spec 062);
  the realtime-publication gotcha does not apply.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** Both (native EAS + web-on-Vercel via react-native-web).
  Not web-only; not native-only. The staff palette is light-only (per CLAUDE.md;
  `src/screens/staff/theme.ts`) with a UI-scale switcher — no phone/desktop tier
  fork exists to gate against, so the redesign is the whole staff EOD screen.
- **Tests (spec 022 tracks):** **jest track only.** No pgTAP (no DB change) and
  no shell smoke (no edge fn / curl path). New/updated jest tests: (a) pure
  keypad/advance helpers (append rules, single `.`, max-5, `0` valid, NEXT/SKIP
  advance-with-wraparound → DONE); (b) indicator + "X of N" derivation incl.
  counted-once; (c) keypad-sheet open on well tap, digit entry updates well +
  running total; (d) the completeness-gate block + jump-opens-sheet; (e) the
  spec-129 lock/edit and offline-queue outcome regressions stay green unchanged.

---

## Backend design

> **Mode:** design. **Author:** backend-architect. This is a purely
> presentational, frontend-only redesign. The section below is deliberately
> heavy on "N/A and why" because the HARD NON-GOAL guardrail demands a paper
> trail that no backend surface moves.

### 0. Blockers / deviations surfaced to the PM (read first)

Three items the developer and reviewers must be aware of. Only OQ-A is a genuine
scope question; the other two are resolved with a recommended call.

- **OQ-A (spec-vs-system contradiction — note field). LOUD.** AC-4 lists a note
  `TextInput` inside the keypad sheet ("a note input (a real `TextInput`)"), but
  the **staff EOD submit path has never carried a per-item note.** There is no
  `notes` state in `EODCount.tsx`, and `onSubmit` (`EODCount.tsx:656-673`) builds
  each `EodEntry` as `{ item_id, actual_remaining, actual_remaining_cases,
  actual_remaining_each }` only — no note field reaches `useEodSubmit` → the
  `staff_submit_eod` RPC. (This is unlike admin spec 140, whose parent owns a
  `notes` map.) Rendering a note input that persists nothing would be a
  misleading dead control; wiring persistence would require a new store field +
  an RPC/edge/`db.ts` change — **barred by AC-REG-8 and the HARD NON-GOAL.**
  AC-5 itself pre-authorizes the resolution: *"if notes are not persisted today,
  they are not persisted now; flag any gap rather than adding persistence."*
  **Design decision: OMIT the note field from `StaffKeypadSheet` entirely.** No
  note UI, no `notes` state, no RPC change. This is the flagged gap. The owner
  may fund note persistence as a separate spec (store field + `staff_submit_eod`
  arg + RLS re-verify); that is out of scope here. **AC-4 must be read as
  "sheet minus the note row" for this build** — reviewers should not fail the
  build for a missing note input.

- **OQ-B (palette wording — light vs dark). Flag.** AC-3 and the project notes
  say the staff sheet renders on the "staff **light** palette (light-only per
  CLAUDE.md)". That is stale: spec 070 pinned `useStaffColors()` /
  `useStaffElevation()` to the **DARK** palette *unconditionally*
  (`src/screens/staff/theme.ts:148-150, 330-332` — "every staff user sees
  dark"). CLAUDE.md's file-map comment ("light-only theme") was never updated and
  the spec inherited it. **Resolution: consume the hooks
  (`useStaffColors()`/`useStaffTokens()`/`useStaffElevation()`), never hardcode a
  palette.** The redesign is then correct regardless of which palette is pinned —
  it tracks the app. Token *names* in AC-1/AC-3 (`surface`/`border`/
  `borderStrong`/`primary`/`text`) exist identically in both palettes
  (`StaffColors = typeof lightColors`), so nothing breaks. Reviewers verifying
  against a running staff app will see the sheet in **dark**, not light — that is
  correct, not a defect. No token or theme file changes.

- **OQ-C (pure-helper import path). Resolved.** In-scope §153 says the staff
  keypad helper "must not import from `src/lib/`". That line is over-broad and
  contradicts sanctioned precedent: `src/lib/eodKeypad.ts` is **framework-free**
  (no React, no store, no `supabase`, no theme — verified) exactly like
  `src/lib/countOrder.ts`, which the staff subtree already imports
  (`src/screens/staff/lib/countOrder.ts:33` re-exports `applyCountOrder`/
  `firstUncounted` from it; the spec-063 carve-out is explicitly about
  `supabase.from/rpc` *call sites*, not pure helpers — see the header of
  `src/lib/countOrder.ts:1-13`). Per the dispatch instruction ("prefer sharing
  the pure module over duplicating"), **share, do not duplicate.** This touches
  no file under `src/lib/` (read-only import) so AC-REG-8 holds.

### 1. Data model changes

**N/A.** No new tables, columns, indexes, or constraints. No migration file.
This is presentation only; the count maps (`caseCounts`/`unitCounts`), the
submission shape (`EodEntry`), and every read helper in `EODCount.tsx`
(`fetchItemsForVendor`, `fetchExistingSubmission`, `fetchVendorsForToday`,
`fetchSubmittedVendorIds`, `fetchYesterdayIncomplete`, `fetchCountOrder`) are
untouched. `git diff` touches nothing under `supabase/`.

### 2. RLS impact

**N/A.** No new tables → no new policies. No existing policy changes.
`auth_can_see_store(store_id)` and `auth_is_admin()` are not referenced by this
change. Per-store scoping stays exactly where it is today — every staff read is
already keyed to `activeStore.id`; that keying is not touched. No widening or
narrowing of visibility (AC-REG-7, HARD NON-GOAL).

### 3. API contract

**N/A — no PostgREST or RPC surface added or modified.** Submission continues
through `useEodSubmit` → the existing `staff_submit_eod` RPC with the identical
request payload (`{ store_id, date, vendor_id, entries[] }`) and the identical
`{ kind: 'success' | 'success-replay' | 'queued' | 'forbidden' | error }`
outcome union (`EODCount.tsx:696-778`). No request/response shape change, no new
error cases. The `staff-*` 410 stubs remain retired and untouched
(`verify_jwt` unchanged for every function).

### 4. Edge function changes

**N/A.** No edge function is new or modified. `supabase/config.toml` is
untouched; no `verify_jwt` flag moves; no service-token validation path is
added or changed.

### 5. `src/lib/db.ts` surface

**N/A.** The staff subtree does not route through `db.ts` (documented spec-063
carve-out — the entire `src/screens/staff/` subtree calls `supabase` directly
via its own thin helpers). `db.ts` is not imported by this change and gains no
new helper. No snake_case→camelCase mapper is added. (AC-REG-8 explicitly names
`src/lib/db.ts` as off-limits.)

**New frontend-only modules (all under `src/screens/staff/`, none under
`src/lib/`, none under `supabase/`):**

1. **`src/screens/staff/components/BottomSheet.tsx`** — staff-local sheet
   primitive (see §6).
2. **`src/screens/staff/screens/eod/StaffEodCountRow.tsx`** — presentational
   count row (indicator + meta + two wells).
3. **`src/screens/staff/screens/eod/StaffKeypadSheet.tsx`** — presentational
   keypad-entry sheet.
4. **`src/screens/staff/lib/eodKeypad.ts`** — a *pure re-export barrel*, mirroring
   `src/screens/staff/lib/countOrder.ts`:
   ```ts
   // src/screens/staff/lib/eodKeypad.ts
   // Staff-local barrel: re-export the framework-free keypad helpers from the
   // shared pure module so staff screens import from one staff-local path
   // (mirrors countOrder.ts's re-export-of-pure idiom; no supabase carve-out
   // here because there is no I/O — it is a pure re-export).
   export {
     appendKeypadDigit,
     activeFieldFor,
     advanceUncounted,
     KEYPAD_BACKSPACE,
   } from '../../../lib/eodKeypad';
   ```
   `firstUncounted` is already re-exported by
   `src/screens/staff/lib/countOrder.ts` — the sheet's `isDone` + the gate jump
   reuse it from there, unchanged.

Only one existing file is materially rewritten:
`src/screens/staff/screens/EODCount.tsx` (the orchestrator — see §7).

### 6. Staff bottom-sheet primitive (AC-3)

**Location:** `src/screens/staff/components/BottomSheet.tsx` (peer to `Banner`,
`ListRow`, `Input`, `Button` — the staff-local component set).

**Why new:** there is NO `ResponsiveSheet` in the staff subtree, and importing
the admin one (`src/components/cmd/ResponsiveSheet.tsx`) is FORBIDDEN by
Out-of-scope §177. `@gorhom/bottom-sheet` and Reanimated are barred (§181). So a
staff-local primitive on RN `Modal` + `Animated` is the only sanctioned path —
this is the same idiom `ResponsiveSheet` itself uses, so it is proven.

**Shape (model on `ResponsiveSheet`'s `bottom-sheet` branch, staff-simplified —
there is no breakpoint fork; the staff app is always the bottom-sheet form):**

```ts
interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;              // scrim tap + ✕ both call this
  heightFraction?: number;          // default ~0.68 of viewport height
  header?: React.ReactNode;         // sticky (flexShrink: 0)
  footer?: React.ReactNode;         // sticky (flexShrink: 0)
  children: React.ReactNode;        // scrollable middle
  accessibilityLabel?: string;
}
```

- **Container:** RN `Modal` (`transparent`, `animationType="fade"`,
  `onRequestClose={onClose}`).
- **Scrim:** full-bleed `TouchableOpacity` (`activeOpacity={1}`,
  `onPress={onClose}`), background `c.overlay` (staff token — `rgba(0,0,0,0.60)`
  dark / `rgba(17,20,24,0.45)` light). `justifyContent: 'flex-end'` so the sheet
  seats at the bottom.
- **Sheet body:** `Animated.View`, `height = Math.round(vh * heightFraction)`,
  `width: '100%'`, `backgroundColor: c.surface`, top corners
  `T.radius.lg`, `borderTopWidth: 1` + `borderTopColor: c.borderStrong`,
  `paddingBottom: insets.bottom` (`useSafeAreaInsets`), plus
  `useStaffElevation().modal` for the platform-branched shadow. An inner
  `TouchableOpacity` (`activeOpacity={1}`, `onPress={() => {}}`) swallows taps so
  presses inside the sheet do not fall through to the scrim — same guard
  `ResponsiveSheet` uses.
- **Slide-in:** `Animated.Value` seeded to `vh` (off-screen bottom), animate to
  `0` over ~220ms `Easing.out(Easing.cubic)` on `visible`; `translateY: anim`.
  `useNativeDriver: Platform.OS !== 'web'` (RN-Web has no native animated
  module — passing `true` warns and falls back to JS; native keeps `true`).
  Copy this exactly from `ResponsiveSheet.tsx:101-125` (it is verified on
  RN-Web 0.21).
- **No drag-to-dismiss** (AC-3): dismissal is scrim tap + ✕ only.
- **Tokens:** `useStaffColors()`, `useStaffTokens()` (UI scale — the sheet's
  paddings/radii/type all read from `T`), `useStaffElevation()`. **Never
  hardcode a palette** (OQ-B).

This primitive is deliberately generic (header/footer/children slots) so it can
be reused by a future staff Reorder/Weekly keypad pass without another sheet.

### 7. Component structure (AC-1..AC-7, regression preservation)

`EODCount.tsx` stays the **orchestrator** and keeps ownership of everything it
owns today: `caseCounts`/`unitCounts` maps, the completeness gate + `onSubmit`,
`useEodSubmit`/`eodQueue`/`QueueIndicator` wiring, the `dayOffset` day toggle,
the spec-129 state machine (`existing`/`editing`/`inputsLocked`/`seedFromExisting`/
`onCancelEdit`/`submittedVendorIds`), spec-103 `viewMode`/`savedIds`/
`orderedItems`/`onReorder`/`onResetOrder`, and `search`/`visibleItems`. **No new
store fields**, no `useStaffStore` slice change — the only additions are two
pieces of local screen state and a handful of pure handlers.

**New local state in `EODCount`:**
```ts
const [sheetItemId, setSheetItemId] = useState<string | null>(null);
const [activeField, setActiveField] = useState<'cases' | 'units'>('units');
```

**Derived (memoized) in `EODCount`:**
- `sheetItem = (viewMode === 'custom' ? orderedItems : items).find(i => i.id === sheetItemId) ?? null`
  — deriving from the id (not storing the item) means a vendor switch that drops
  the item auto-closes the sheet (`visible = !!sheetItem`), matching admin.
- `orderedForAdvance = viewMode === 'custom' ? orderedItems : items` — the FULL
  on-screen order (NOT the search-narrowed `visibleItems`).
- `isDone = firstUncounted(orderedForAdvance, isCounted) === null` where
  `isCounted(it) = (caseCounts[it.id] ?? '').trim() !== '' || (unitCounts[it.id] ?? '').trim() !== ''`
  (the exact spec-102 counted-once predicate already used by `countedNum` and the
  gate). **Note the deliberate divergence from admin:** admin advances over
  `filteredItems`; staff advances/`isDone` over the FULL ordered set so NEXT ITEM
  can still reach an uncounted row hidden behind an active search, and DONE ✓
  only appears when the WHOLE list is counted — keeping NEXT/DONE consistent with
  the whole-list submit gate. This is intentional and testable.

**New handlers in `EODCount` (all pure/local — no backend):**
```ts
const openSheet = (item, field) => {           // AC-4/AC-6
  if (inputsLocked) return;                     // AC-REG-3: locked → no keypad
  setSheetItemId(item.id);
  setActiveField(field);
};
const closeSheet = () => setSheetItemId(null);
const onKey = (key) => {                         // AC-5
  if (!sheetItem) return;
  const id = sheetItem.id;
  const setter = activeField === 'cases' ? setCaseCounts : setUnitCounts;
  setter(p => ({ ...p, [id]: appendKeypadDigit(p[id] || '', key) }));
};
const advance = () => {                          // AC-7 (SKIP + NEXT share this)
  if (!sheetItem) return;
  const idx = orderedForAdvance.findIndex(i => i.id === sheetItem.id);
  const res = advanceUncounted(orderedForAdvance, idx, isCounted);
  if (!res) { closeSheet(); return; }
  setSheetItemId(res.item.id);
  setActiveField(activeFieldFor(res.item.caseQty));
};
const onSkip = () => advance();
const onNext = () => { if (isDone) closeSheet(); else advance(); };
```
Writes go **through the existing `setCaseCounts`/`setUnitCounts`**, so the row
indicator, the "X of N counted" label, the gate, and the running total all
update live with no separate commit step (AC-5). SKIP/close need no commit.

**`renderEodRow` (kept as the shared callback fed to BOTH the default `FlatList`
and `CountOrderDragList`)** now returns `<StaffEodCountRow …/>` instead of the
inline `<ListRow>` with two `<Input>`s. Because both list paths still call one
`renderEodRow`, spec-103 Custom view stays byte-identical to Default (AC-REG-6).

**`StaffEodCountRow`** (`src/screens/staff/screens/eod/StaffEodCountRow.tsx`) —
keeps the existing `<ListRow>` card wrapper so the staff card chrome, spacing,
and elevation are unchanged; only the leading indicator and the trailing wells
are new:
```ts
interface StaffEodCountRowProps {
  item: EodItem;
  displayName: string;         // getLocalizedName(...) computed by the orchestrator
  counted: boolean;            // isCounted(item)
  caseValue: string;           // caseCounts[id] ?? ''
  unitValue: string;           // unitCounts[id] ?? ''
  total: number;               // cases*(caseQty||1)+units (existing math)
  hasPack: boolean;            // (caseQty ?? 0) > 1
  locked: boolean;             // inputsLocked
  onOpenWell: (item: EodItem, field: 'cases' | 'units') => void;
}
```
Layout inside `<ListRow>`:
- **leading:** `[indicator] [IngredientThumb] [name/meta column]`. The name
  renders in `c.text` **always** (AC-1 — deletes the `entered ? c.text : c.error`
  treatment at `EODCount.tsx:813`). `UpdatedBadge` (spec 128), the `unit · case of
  N` line, and the running-total line (once counted) are preserved verbatim
  (AC-2).
- **indicator (AC-1):** a small square. Uncounted → `borderWidth: 1`,
  `borderStyle: 'dashed'`, `borderColor: c.borderStrong`, transparent fill.
  Counted → fill `c.primaryPressedLight` (the existing **translucent-primary**
  token — present in both palettes, so no new token is added) + a ✓ glyph in
  `c.primary`. `testID={`eod-counted-${item.id}`}` on the ✓.
- **trailing:** two wells (AC-2), each a `Pressable` (never a `TextInput`, so no
  OS keyboard opens): a **CS ×N** well shown only when `hasPack`, and a units
  well. Empty well shows `—` in `c.textSecondary`; filled shows the value in
  `c.text`. Filled → `borderStyle: 'solid'`, `borderColor: c.border`,
  `backgroundColor: c.surfaceAlt`; empty → `borderStyle: 'dashed'`,
  `borderColor: c.borderStrong`. `onPress={() => onOpenWell(item, field)}`;
  `disabled={locked}` + `opacity: 0.6` when locked (AC-REG-3 — locked rows are
  read-only wells, no keypad on tap). `testID={`eod-well-${item.id}-${field}`}`.
  Keep `testID={`eod-item-cases-${item.id}`}`/`eod-item-units-…` on the two wells
  too so existing tests that target those ids keep resolving (map old ids onto
  the wells).

**`StaffKeypadSheet`** (`src/screens/staff/screens/eod/StaffKeypadSheet.tsx`) —
built on the §6 `BottomSheet`. Props mirror admin `PhoneKeypadSheet` **minus the
note** (OQ-A):
```ts
interface StaffKeypadSheetProps {
  visible: boolean;
  item: EodItem | null;
  displayName: string;
  activeField: 'cases' | 'units';
  setActiveField: (f: 'cases' | 'units') => void;
  caseValue: string;
  unitValue: string;
  runningTotal: number;
  isDone: boolean;
  onKey: (key: string) => void;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}
```
Contents (AC-4): header = `displayName` + `unit · case of N` meta + ✕ close
(`accessibilityLabel` from a new i18n key); the two field wells (active field =
`c.primary` border + `c.primaryPressedLight` tint; tapping the inactive well
calls `setActiveField` — AC-6); a running-total line
(`t('eod.sheet.runningTotal', { total, unit })`); a **3-column digit pad** from
`DIGIT_KEYS = ['1'..'9','.', '0', KEYPAD_BACKSPACE]` (flex-wrap rows at 33.33%
width, no CSS grid — matches admin), each key `onPress={() => onKey(k)}`; a
footer with **SKIP →** (`onSkip`) and **NEXT ITEM →** / **DONE ✓** (`onNext`,
label switches on `isDone`). `testID`s: `eod-sheet-well-cases`/`-units`,
`eod-key-1`..`eod-key-9`/`-dot`/`-0`/`-back`, `eod-sheet-skip`,
`eod-sheet-next`, `eod-sheet-title`. **No note `TextInput` is rendered** (OQ-A).
Default active field on open = `activeFieldFor(item.caseQty)` (AC-6), set by the
orchestrator's `openSheet`/`advance`.

The sheet mounts once at the bottom of `EODCount`'s tree:
`<StaffKeypadSheet visible={!!sheetItem} item={sheetItem} … />`.

### 8. Preserved behaviors — how each survives (regression map)

- **AC-REG-1 (completeness gate + jump).** `onSubmit`'s gate is unchanged: it
  still checks the FULL `items` list, shows the blocked-submit toast, and clears
  `search`. The **jump is re-expressed**: the `caseInputRefs` DOM-focus path
  (`EODCount.tsx:330,594-615,848`) is removed (wells are not focusable inputs).
  The `pendingFocusId` effect is rewritten to **open the sheet** on the target:
  find the target in `orderedForAdvance`, `setSheetItemId(target.id)` +
  `setActiveField(activeFieldFor(target.caseQty))`, then clear `pendingFocusId`.
  Because the sheet seats the item directly (not via list scroll), the target no
  longer has to be rendered/un-hidden first — but keep the `setSearch('')` in the
  gate (preserved behavior) and keep resolving the target via `firstUncounted`
  over the full ordered set exactly as today (`EODCount.tsx:637-640`). `listRef`
  may be retained harmlessly or dropped; `caseInputRefs` is dropped.
- **AC-REG-2 (counted-once, spec 102).** The `isCounted`/`isBlank` predicate
  ("cases OR units non-blank") is byte-identical and now also feeds the
  indicator, `isDone`, and `advance`. `fetchItemsForVendor` / `item_vendors`
  querying is untouched.
- **AC-REG-3 (spec-129 state machine).** `existing`/`editing`/`inputsLocked`,
  `seedFromExisting`, `onCancelEdit`, `submittedVendorIds`, the Edit/Cancel/Submit
  footer, and the optimistic-green paths (`enterLockedAfterWrite`, the queued
  branch) are all unchanged. `inputsLocked` now gates `openSheet` (early-return)
  and mutes the wells — locked rows render read-only, no keypad. Because staff
  **seeds `caseCounts`/`unitCounts` from `existing`** (`seedFromExisting`), the
  locked wells read the submitted values straight from the maps (simpler than
  admin, which reads `currentVendorSubmission`).
- **AC-REG-4 (offline queue).** `useEodSubmit` (`submit`/`pending`/`draining`),
  `eodQueue`, `QueueIndicator`, and all five outcome branches
  (`success`/`success-replay`/`queued`/`forbidden`/error) are untouched — the
  keypad only mutates local maps; counting and the queued-submit path work
  offline exactly as today.
- **AC-REG-5 (date window).** The `dayOffset ∈ {0,1}` model, `countDate`/
  `countIso`/`isLate`, the submit-time date capture (`§11 risk c`), the
  `yesterdayIncomplete` alert, and the late banner are unchanged. The
  Today/Yesterday control is **restyled to a 2-cell day strip** (larger,
  touch-first targets sized to `T.touchTarget.min`, staff-themed) — still exactly
  two states, `[1, 0]` order preserved, NOT a 7-day strip (Out-of-scope §166).
- **AC-REG-6 (custom order, spec 103).** `CountOrderDragList`, the Default⇄Custom
  toggle, `fetchCountOrder`/`saveCountOrder`/`resetCountOrder`, the
  drag-disabled-while-searching rule, and `onReorder`/`onResetOrder`
  optimistic-then-revert (`notifyBackendError`) are unchanged. Both list paths
  still call the one shared `renderEodRow`, so Custom renders identical rows. The
  on-screen order (`orderedForAdvance`) feeds NEXT ITEM (AC-7).
- **AC-REG-7 (i18n + search + per-store).** New strings get EN/ES/中文 keys
  (§9). `matchesQuery`/localized+English search and `visibleItems` narrowing are
  unchanged; per-store scoping via `activeStore.id` is unchanged.
- **AC-REG-8 (no backend delta).** `git diff` touches nothing under `supabase/`
  and does not touch `src/lib/db.ts` / any RPC / any edge function. The only
  `src/lib/` interaction is a **read-only import** of the framework-free
  `src/lib/eodKeypad.ts` (unmodified). Submit still flows `useEodSubmit` → the
  existing RPC.

### 9. i18n keys (additive, EN/ES/中文 — AC-REG-7)

All additive under the existing `eod` namespace in the three staff catalogs
(`src/screens/staff/i18n/{en,es,zh-CN}.json`). Reuse existing keys where they
already fit (`eod.col.casesAria`/`unitsAria`, `eod.row.caseOf`, `eod.date.*`,
`eod.countedOfTotal`, `eod.status.*`). New keys:

```
eod.sheet.close          EN "Close"                 (✕ aria)
eod.sheet.casesWell      EN "CS ×{qty}"             (CS well label, both row + sheet)
eod.sheet.runningTotal   EN "= {total} {unit} total"
eod.sheet.skip           EN "Skip →"
eod.sheet.nextItem       EN "Next item →"
eod.sheet.done           EN "Done ✓"
eod.sheet.backspace      EN "Backspace"             (⌫ key aria)
eod.sheet.title          EN "Count {item}"          (sheet accessibilityLabel)
eod.row.counted          EN "Counted"               (indicator aria)
eod.row.uncounted        EN "Not counted"           (indicator aria)
```
ES/中文 translations required for all ten before merge (jest parity guard —
existing i18n key-parity test will fail otherwise). NO note-field key is added
(OQ-A). The `—` empty-well glyph and the digit glyphs are not localized.

### 10. Realtime impact

**N/A.** The staff stack uses no realtime (spec 062); this spec adds none. **The
`supabase_realtime` publication is NOT touched, so the
`docker restart supabase_realtime_imr-inventory` publication gotcha does not
apply to this spec** — no dev/deploy realtime step. (Called out explicitly per
the architect checklist even though it is a no-op here.)

### 11. Frontend store impact

- **`src/store/useStore.ts` (admin Zustand store): N/A** — that is the admin
  store; the staff surface does not use it.
- **`src/screens/staff/store/useStaffStore.ts`: no slice change.** The redesign
  reads the same existing slices (`locale`, `activeStore`, `authState`, UI scale
  via `useStaffTokens`). No new fields, actions, or selectors.
- **Optimistic-then-revert + `notifyBackendError`:** applies only to the
  unchanged persistence paths (`onReorder`/`onResetOrder`/submit). The keypad
  entry itself is **pure local `useState`** (`caseCounts`/`unitCounts`) with no
  backend call, so the optimistic-revert pattern does not apply to digit entry —
  correct and unchanged. Backend errors on submit still surface via the existing
  toast/outcome union.

### 12. Test plan (jest track only — AC / §238)

No pgTAP (no DB change), no shell smoke (no edge/curl path). Staff app is
light-only in spec text but **dark-pinned at runtime** (OQ-B) — tests should
render via the components' own hooks and not assert on a specific palette; the
pure `resolveStaffColors` path already defaults to light under jest
(`theme.ts:136-140`), which is fine and existing tests rely on it.

- **(a) Pure keypad/advance helpers.** Unit-test the shared helpers **through the
  staff barrel** `src/screens/staff/lib/eodKeypad.ts` (so the barrel is
  exercised): `appendKeypadDigit` (append 0–9, single `.`, `⌫` drop, max-5 char
  clamp, `'0'` valid); `activeFieldFor` (caseQty>1 → cases, else units);
  `advanceUncounted` (forward-from-index, wraparound, current-only-uncounted
  resolves to self, all-counted → null). Note: the shared `src/lib/eodKeypad`
  already has admin-side unit tests; the staff test asserts the barrel re-exports
  the same functions (identity), it need not re-prove the logic exhaustively.
- **(b) Indicator + "X of N" derivation.** `StaffEodCountRow` renders the dashed
  indicator when uncounted and the ✓ (`eod-counted-${id}`) when counted; the
  name is always `c.text` (never `c.error`). `countedNum` derivation incl.
  counted-once (cases-only and units-only both count).
- **(c) Keypad-sheet flow.** Tapping a well (`eod-well-…`) opens the sheet
  (`eod-sheet-title` visible); a digit key updates the active well value and the
  running total; tapping the inactive well switches `activeField`; NEXT ITEM
  advances to the next uncounted and relabels to DONE ✓ when none remain; SKIP
  advances without recording.
- **(d) Completeness gate + jump-opens-sheet.** A blocked submit shows the toast,
  clears the search, and **opens the sheet seated on the first uncounted item**
  (the sheet replaces the old DOM-focus jump). Gate still checks full `items`.
- **(e) Regression guards stay green unchanged.** The existing `EODCount` tests
  (spec-129 lock/edit, offline-queue outcomes, day toggle, vendor status dots,
  spec-103 custom order) must pass without modification EXCEPT where a test
  asserts the old red-name treatment or targets a removed `TextInput` by a
  behavior that no longer exists — those specific assertions are re-pointed to
  the indicator / wells (behavior-preserving edits, not new behavior). Grep for
  `c.error` name assertions, `eod-item-cases`/`eod-item-units` `.type()` calls,
  and `caseInputRefs`/focus assertions and migrate them to the well/sheet flow.
  Run the FULL staff jest suite (per user memory — a subset let a stale EOD test
  slip through and turned `main` red).

### 13. Risks & tradeoffs

- **Note-field gap (OQ-A) — highest.** If the owner actually wanted per-item
  notes on staff EOD, this build does not deliver them (correctly, per AC-5 +
  the guardrail). Surface OQ-A for explicit sign-off before/at review. A future
  note-persistence spec is a clean backend delta (store field + RPC arg + RLS
  re-verify).
- **Palette wording (OQ-B).** Low risk given the hook-consumption rule, but a
  reviewer expecting a "light" sheet will see dark — pre-empt by citing OQ-B.
- **Test churn (12e).** The biggest labor risk is retrofitting existing `EODCount`
  tests that pin the old inline-input UX. This is mechanical but must be complete
  — a missed stale assertion is exactly the class of failure user memory warns
  about. Budget for a full-suite run.
- **Advance-over-full-set divergence from admin (§7).** Intentional (keeps
  NEXT/DONE aligned with the whole-list gate) but differs from `PhoneEodCount`'s
  `filteredItems` advance — call it out in the PR so a reviewer cross-checking
  the two doesn't read it as a bug.
- **Performance:** per-vendor lists are tens of rows; the list stays un-windowed
  (as today) and the sheet mounts a single 12-key pad — no concern on the 286 KB
  seed. No edge-function cold-start (no edge path). No migration ordering concern
  (no migration).
- **`app.json` slug:** untouched — not implicated by this spec.

### 14. Migration ordering / rollout safety

**N/A — no migration, additive or destructive.** Nothing to `db push`, nothing
for the `db-migrations-applied` gate to diff. Rollout is a pure frontend deploy
(Vercel web + EAS native). Fully reversible by reverting the frontend commit; no
data or schema state is created or changed.

## Handoff
next_agent: frontend-developer
prompt: Implement spec 141 against the ## Backend design above. This is
  frontend-only — do NOT touch anything under supabase/, src/lib/db.ts, any RPC,
  or any edge function (AC-REG-8). Build the staff BottomSheet primitive
  (§6), StaffEodCountRow + StaffKeypadSheet (§7), and the pure re-export barrel
  src/screens/staff/lib/eodKeypad.ts (§5/OQ-C — share, don't duplicate). Rework
  EODCount.tsx as the orchestrator per §7 (add sheetItemId/activeField + the pure
  handlers; rewrite the pendingFocusId jump to open the sheet per §8/AC-REG-1;
  drop caseInputRefs). OMIT the note field entirely (OQ-A — flagged gap, do not
  add persistence). Consume useStaffColors/useStaffTokens/useStaffElevation, never
  hardcode a palette (OQ-B). Add the ten additive EN/ES/中文 i18n keys (§9).
  Cover the jest surface in §12 and migrate — do not delete — the stale EOD
  assertions in §12e; run the FULL staff jest suite. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/141-staff-eod-count-keypad-redesign.md

---

## Files changed

Frontend only — nothing under `supabase/`, no `src/lib/db.ts`, no RPC, no edge
function, no `src/lib/*` modification (the shared `src/lib/eodKeypad.ts` is
imported read-only via the new staff barrel). AC-REG-8 holds.

New:
- `src/screens/staff/components/BottomSheet.tsx` — staff-local sheet primitive
  (RN `Modal` + `Animated`; scrim + ✕ dismiss; safe-area; staff hooks only —
  no admin import, no @gorhom/Reanimated). §6.
- `src/screens/staff/lib/eodKeypad.ts` — thin re-export barrel over the
  framework-free `src/lib/eodKeypad.ts` (OQ-C — share, don't duplicate).
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx` — count row: 20×20
  counted/uncounted indicator (replaces red-name), two count wells, locked
  read-only state; preserves thumb / UpdatedBadge / meta / running-total. §7.
- `src/screens/staff/screens/eod/StaffKeypadSheet.tsx` — keypad-entry sheet
  (active-field wells, running total, 3-col digit pad, SKIP / NEXT-ITEM→DONE).
  NO note field (OQ-A). §7.
- `src/screens/staff/lib/eodKeypad.test.ts` — barrel identity + smoke tests. §12(a).
- `src/screens/staff/screens/eod/StaffEodCountRow.test.tsx` — indicator + wells +
  lock + metadata. §12(b).
- `src/screens/staff/screens/eod/StaffKeypadSheet.test.tsx` — sheet contract:
  wells, digit keys, active-field switch, running total, SKIP/NEXT/DONE, close,
  no-note. §12(c).

Modified:
- `src/screens/staff/screens/EODCount.tsx` — reworked as the orchestrator:
  `sheetItemId`/`activeField` state + pure handlers (openSheet/closeSheet/onKey/
  advance/onSkip/onNext), `isCounted`/`isDone`/`orderedForAdvance` derivations,
  the pendingFocusId jump now OPENS the sheet (caseInputRefs dropped),
  `renderEodRow` delegates to `StaffEodCountRow`, `StaffKeypadSheet` mounted once;
  Today/Yesterday restyled to a 2-cell day strip + progress bar. Advance/isDone
  iterate the FULL ordered set (flagged divergence from admin). §7–§8.
- `src/screens/staff/screens/EODCount.test.tsx` — migrated (not deleted) the
  stale inline-input assertions to the well+sheet flow via an `enterCount`
  helper; value reads target the well value text, lock reads target the well's
  disabled a11y state; gate-jump now asserts the sheet opens on the target. §12(d)/§12(e).
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — ten additive keys
  (`eod.sheet.{close,casesWell,runningTotal,skip,nextItem,done,backspace,title}`,
  `eod.row.{counted,uncounted}`), EN/ES/中文 parity. §9.
