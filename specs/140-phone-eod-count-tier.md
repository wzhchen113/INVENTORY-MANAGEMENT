# Spec 140: Phone-tier EOD count (admin console)

Status: READY_FOR_REVIEW

> First build increment of the admin-console phone-optimization program, driven
> by the external design handoff (`design_handoff_imr_phone`). This spec covers
> ONLY the admin console `im.cmd` **EOD count** section at the phone tier. Later
> increments (Inventory narrow row, Ordering vendor card, shell nav, global type
> floors elsewhere) are separate specs.

## User story
As a store manager standing in a walk-in with one thumb, I want to enter my
end-of-day count on my phone with large, unambiguous touch targets and a clear
counted / not-counted state, so that I can finish the day's most-frequent job
fast and without fat-fingering, then land straight on the Ordering list it feeds.

## Acceptance criteria

All criteria below apply ONLY when `useIsPhone()` is true (viewport < 768px OR
any native platform), inside the existing `ResponsiveCmdShell` phone branch. The
desktop (≥1100px) and tablet (768–1099px) EOD layouts MUST remain unchanged (see
AC-REG). The chosen entry flow is the **keypad sheet** (OQ-1); the stepper and
focus-mode variants are reference-only and NOT built.

**Day strip**
- [ ] AC-1: The 7-day horizontal day strip renders above the vendor tabs. Each
  cell is ≥44×44 tappable (handoff calls 50px), shows day-of-week (mono) over
  day-of-month (mono 600), and a status dot whose color follows the existing
  `deriveDayStatus` result (today=accent, submitted=ok, late=warn, draft=info,
  uncounted=violet, rest=fg3). Selected cell = accent border + `accentBg`.
- [ ] AC-2: Selecting a past submitted/rest day still shows the existing
  read-only/locked behavior (rows locked, banner) — no regression to
  `isVendorLocked` / `isRestDay` gating; the phone layout only restyles it.

**Vendor tabs + progress**
- [ ] AC-3: Vendor tabs render as a horizontal strip; the active tab shows a 2px
  accent underline. Each tab shows per-tab progress "counted/total" (e.g. "6/10")
  that becomes "✓" (ok color) once that vendor is submitted for the selected day.
  Progress uses the existing `hasEntry` predicate, which ORs the current tab's
  local entry with `deriveCountedItemIds` — the **counted-once-globally** rule
  (spec 102): a shared item (linked to ≥2 vendors) counted under ANY vendor tab or
  present in ANY submitted/draft submission for this (store, date) reads as
  counted under every tab it appears in, and is never a blocking gap.
- [ ] AC-4: A progress row under the tabs shows "N OF M COUNTED" (caption ramp) +
  a right-aligned status label + a 3px accent progress bar whose fill width =
  countedNum / total for the active vendor's `filteredItems`.

**Count row (keypad-sheet variant)**
- [ ] AC-5: Each count row shows the counted/uncounted **indicator square** (20×20,
  radius xs): dashed `borderStrong` when the item is uncounted, `accentBg` +
  accent ✓ when counted. This REPLACES the current red-item-name treatment on
  phone (`rowUncounted ? C.danger : C.fg` on the name → name always `C.fg` on
  phone; the square carries the state instead).
- [ ] AC-6: Count row shows item name (itemName ramp, 15/600) + a meta line
  (unit · case · par, plus running total once counted) + **two count wells**
  (62×48 each): a "CS ×N" well (shown only when `caseQty > 1`) and a unit-label
  well. An empty well = dashed border + "—" (fg3); a filled well = `panel2` bg +
  fg value. Tapping either well opens the keypad sheet (AC-7).
- [ ] AC-7: Tapping a well opens the **keypad sheet**, built on `ResponsiveSheet`
  with `presentation.phone: 'bottom-sheet'` (RN `Modal` + `Animated` slide; NOT
  `@gorhom/bottom-sheet`; prefer RN `Animated` over Reanimated-on-web). The sheet
  contains: item name + meta + a ✕ close; two field wells (the tapped well is the
  active field, shown with accent border + `accentBg`); a note input; a running
  total ("= 112 lbs total"); a 3-column digit pad (1–9, ., 0, ⌫); and a footer
  with SKIP → (outline) + NEXT ITEM → (accent primary). Digits append to the
  active field (max 5 chars, one "."); the active field auto-selects the CS well
  when `caseQty > 1`, else the unit well.
- [ ] AC-8: NEXT ITEM advances to the **next uncounted item with wraparound**
  (reusing `firstUncounted` over the on-screen order), and the button label
  becomes **DONE ✓** when nothing uncounted remains; tapping DONE ✓ closes the
  sheet (with the existing all-counted toast). SKIP advances without recording.
  Closing on scrim tap or ✕ dismisses the sheet.
- [ ] AC-9: `0` is a valid count. A row reads as counted when its cases OR units
  field is non-blank (existing `hasEntry` / `localHasEntry` semantics preserved).

**Submit gate + post-submit**
- [ ] AC-10: The submit bar renders in-flow at the bottom of the worksheet: left
  status caption ("N LEFT" warn / "READY" ok / "SENT ✓" ok) + a 48px primary
  button. Disabled state = `panel2` bg + `fg3` text; enabled = `accent` bg +
  `accentFg` text. (Coexists with whatever phone nav lands later — see OQ-2.)
- [ ] AC-11: Submit is gated: it blocks until every item in `filteredItems` is
  counted, reusing the existing gate. On a blocked submit the existing behavior is
  preserved unchanged — toast naming the remaining count, clear search, and
  jump/focus the first uncounted item via the existing `pendingFocusItem` /
  `usePaletteAction` path (in keypad-sheet terms: the jump seats that item and its
  well opens the keypad sheet).
- [ ] AC-12: On a successful submit the existing production side-effects fire
  unchanged: mark vendor submitted, clear that vendor's draft, drop EDIT mode,
  success toast, and navigate to Ordering via
  `usePaletteAction.getState().request({ section: 'Ordering', selectedName: null })`.

**Phone type ramp + hit floors (the one new sub-system)**
- [ ] AC-13: A phone type ramp is introduced (roles: screenTitle, itemName, body,
  metaMono, caption, microCaption, wellValue [keypad sheet 20], keypadKey,
  tableNum per the handoff table). It is applied to the phone EOD surface. It
  composes with the existing `Type` / `sans()` / `mono()` helpers and adds NO new
  palette values. `metaMono` floors at 10.5, `microCaption` at 8.5.
- [ ] AC-14: All tappables on the phone EOD surface are ≥44×44: day cells, vendor
  tabs, count wells (62×48), the ✕ close, keypad keys (50–54 tall), SKIP / NEXT
  ITEM footer buttons, and the primary submit button (48–50).

**Regression guard**
- [ ] AC-REG: With `useIsPhone()` false (tablet + desktop widths, web), the
  EODCountSection render output is byte-unchanged from `main` — all new phone
  code paths are gated behind `isPhone`. A jest snapshot or explicit render
  assertion at a desktop width pins this.

## In scope
- Phone-tier restyle of `src/screens/cmd/sections/EODCountSection.tsx` behind
  `useIsPhone()`: day strip, vendor tabs w/ per-tab progress, progress row, count
  rows with two wells, the counted/uncounted indicator square, and the in-flow
  submit bar.
- ONE count-entry flow: the **keypad sheet**, built on `ResponsiveSheet`
  (`presentation.phone: 'bottom-sheet'`), with the digit pad, note field, running
  total, and SKIP / NEXT ITEM → DONE ✓ advance-with-wraparound behavior.
- The phone type ramp + 44px hit-area floors as a small, scoped sub-system (new
  typography roles / size constants), introduced here and applied to the phone
  EOD surface only. No other section is retrofitted in this spec.
- Both themes (Light + Dark) via existing `useCmdColors()`.
- Web phone (<768px) AND native (iOS/Android always phone tier).

## Out of scope (explicitly)
- **The STAFF app** (`src/screens/staff/`, `StaffStack`). It is a separate surface
  with its own count screens; RoleRouter mounts the Cmd UI only for
  admin/master/super_admin. Not touched.
- **Desktop + tablet EOD layouts** — unchanged; this is additive phone-tier
  behavior only (AC-REG).
- **The stepper and focus-mode entry variants.** Reference-only in the handoff;
  the owner chose keypad-sheet (OQ-1). Building either is out of scope.
- **Phone navigation (bottom-dock vs drawer).** SHELL-WIDE decision affecting all
  19 sections, not EOD-specific. Its own later spec (OQ-2). Spec 140 builds against
  today's hamburger-drawer shell and MUST NOT introduce bottom-dock nav.
- **The other handoff sections** (Inventory narrow row, Ordering vendor card,
  Inventory/weekly count, Dashboard, Waste log, notifications, store switch,
  login, sections 7–17). Each is a later increment / separate spec.
- **New backend / migrations / RPCs / edge functions.** This is a pure
  presentation-layer change; submission still flows through the existing
  `submitEOD` store action + `submitEODCount` in `src/lib/db.ts`.
- **New palette values.** Handoff maps every color 1:1 to existing
  `LightCmd`/`DarkCmd`. Only the type ramp + hit floors are new.
- **`@gorhom/bottom-sheet`.** Architect ruled it out (no RNW support); use the
  sanctioned `ResponsiveSheet` (RN `Modal` + `Animated`). Prefer RN `Animated`
  over Reanimated-on-web for transitions.
- **Drag-to-dismiss** on the keypad sheet (out of scope per ResponsiveSheet
  Phase 1); scrim tap + ✕ dismiss is sufficient.
- **Save-draft / count-order (spec 103) / export (spec 139) UI reflow for phone**
  beyond keeping them functional — a dedicated phone pass on those is not part of
  this spec. Rationale: keep the increment tight to the daily count-entry path.
- **`app.json` slug** — untouched (load-bearing, see CLAUDE.md).

## Open questions resolved
- Q: OQ-1 — Which count-entry flow (keypad-sheet, stepper, or focus-mode)? →
  A: **Keypad sheet** (the recommended variant). Build ONLY this flow: tap a
  Cases/Units well → bottom sheet with a number pad, note field, running total,
  and SKIP / NEXT ITEM that advances to the next uncounted item with wraparound
  and becomes DONE ✓ when nothing's left. The stepper and focus-mode variants are
  reference-only and dropped from scope.
- Q: OQ-2 — Phone navigation: bottom-dock vs drawer? → A: **Separate spec; build
  EOD on the current drawer now.** Spec 140 builds against today's
  hamburger-drawer shell and MUST NOT introduce bottom-dock nav. Bottom-dock vs
  drawer becomes its own later shell-wide spec. Resolved as out of scope here —
  not blocking.

## Dependencies
- Existing primitives (no new libs):
  - `ResponsiveSheet` — `src/components/cmd/ResponsiveSheet.tsx` (keypad sheet uses
    `presentation.phone: 'bottom-sheet'`).
  - `useIsPhone()` / `useBreakpoint()` — `src/theme/breakpoints.ts`.
  - `useCmdColors()` / `CmdRadius` — `src/theme/colors.ts`.
  - `sans()` / `mono()` / `Type` — `src/theme/typography.ts` (extended with the
    new phone ramp roles).
  - Deep-link plumbing: `usePaletteAction` (`src/lib/paletteAction.ts`) — already
    carries `eodFocusItemId`, already consumed by EODCountSection for jump/focus
    and for the post-submit Ordering jump.
  - Count-order + gate helpers: `applyCountOrder`, `firstUncounted`
    (`src/lib/countOrder.ts`); `deriveDayStatus`, `isRestWeekday`
    (`src/lib/eodDayStatus.ts`); `deriveCountedItemIds` (in EODCountSection,
    exported for jest).
- Store: existing `submitEOD` action + `submitEODCount` (`src/lib/db.ts`). No
  store/schema changes.
- No dependency blocks the build — both open questions are resolved.

## Project-specific notes
- **Cmd UI section / legacy:** Admin Cmd UI — `src/screens/cmd/sections/EODCountSection.tsx`. No legacy surface involved (spec 025 deleted it).
- **Which app:** Admin console only. Staff app explicitly out of scope.
- **Per-store or admin-global:** Per-store. All reads/writes stay scoped to
  `currentStore.id` exactly as today; per-store RLS unchanged (no policy edits).
- **Realtime channels touched:** None changed. The existing `store-{id}` /
  `brand-{id}` realtime sync continues to drive reloads; no new publication, so
  the realtime-publication gotcha does not apply to this spec.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** Both. Web phone (<768px) AND native (always phone tier).
  Nothing here is web-only.
- **Tests (spec 022 tracks):** jest track. New/updated jest tests: (a) the
  desktop/tablet regression guard (AC-REG); (b) counted/uncounted indicator +
  progress derivation on phone (incl. counted-once-globally); (c) keypad-sheet
  NEXT/SKIP advance-with-wraparound → DONE ✓; (d) submit-gate + post-submit
  Ordering jump; (e) type-ramp/hit-floor constant assertions. No pgTAP (no DB
  change) and no shell smoke (no edge fn / curl path) needed.
```

## Backend design

> **Scope note.** This is a PHONE-TIER, PRESENTATION-LAYER change to
> `EODCountSection.tsx` gated on `useIsPhone()`. The count data model, the
> submit path (`submitEOD` store action → `submitEODCount` in `src/lib/db.ts`),
> the RLS posture, the realtime channels, and every derived helper already exist
> and are reused verbatim. The design below re-presents that existing state on
> phone; it introduces no new server-side surface.

### Data model changes
**N/A.** No new tables, columns, or indexes. The count entry maps
(`caseCountsByVendor` / `unitCountsByVendor` / `notesByVendor`), submissions
(`eodSubmissions`), and per-user count order (`user_count_orders`, spec 103) are
all unchanged. No migration filename is proposed because no migration is needed.

### RLS impact
**N/A.** No new table → no new policy. Reads/writes stay scoped to
`currentStore.id` exactly as today; `auth_can_see_store(store_id)` on the
EOD/inventory tables continues to gate every row. No policy is added or edited.

### API contract
**N/A.** No new PostgREST view and no new RPC. Submission continues through the
existing `submitEODCount(submission)` (`src/lib/db.ts`) called from the existing
`onSubmit` handler; the request/response shape, the optimistic `submitEOD`
merge, and the error envelope are untouched.

### Edge function changes
**N/A.** No edge function is created or modified. No `verify_jwt` change.

### Realtime impact
**N/A** as a runtime concern, and **no publication change**. The existing
`store-{id}` / `brand-{id}` channels (debounced 400 ms in `useRealtimeSync`)
continue to replay `eod_submissions` changes; the phone layout re-reads the same
`eodSubmissions` store slice. **No `supabase_realtime` publication membership
change → the `docker restart supabase_realtime_imr-inventory` gotcha does not
apply to this spec.**

### `src/lib/db.ts` surface
**No change.** No new helper. The phone flow calls the same `submitEODCount`
already imported by `EODCountSection`. No new snake_case → camelCase mapping.

---

The rest of this design covers the frontend seams, which is where all of the
work lands.

### 1 · Component structure (AC-REG)

`EODCountSection.tsx` is **2031 lines / ~80 KB** — well past the size where an
in-file `isPhone` fork would bloat an already-huge file. **Decision: extract a
presentational `PhoneEodCount` subcomponent** and gate it behind an
**early-return**, NOT an in-file branch inside the shared return tree.

**Placement.** Add one line immediately AFTER the two existing early-return
guards (`__all__` guard ~line 1026, `storeLoading` skeleton ~line 1039) and
BEFORE the main desktop `return (<> … </>)`:

```tsx
if (isPhone) return <PhoneEodCount model={/* built inline, phone-only */} />;
```

**Why this keeps desktop/tablet byte-unchanged (AC-REG):**
- Every hook, `useMemo`, `useState`, `useEffect`, and handler above the return
  already runs identically for all tiers (hooks run before the early return).
- When `useIsPhone()` is false the early return is skipped entirely and the
  existing desktop tree renders with its existing `isPhone ? … : …` ternaries
  resolving to their non-phone side, exactly as today — **zero textual edits to
  the desktop return subtree.**
- The `model` object literal is constructed inline in the early-return branch,
  so it is never allocated on the desktop path.

**Do NOT** simplify or remove the vestigial `isPhone` sub-branches that already
exist inside the desktop return (day-strip at ~1129, the phone `ScrollView`
wrappers at ~1455/~1581, footer `flexWrap` bits). They become unreachable once
phone early-returns, but rewriting that region risks an AC-REG regression for no
functional gain. Leave them textually untouched; a dead-branch cleanup is an
explicit, separate follow-up (noted under Risks).

**Sharing the two sibling tabs.** `history.tsx` and `variance.log` are
out-of-scope for phone reflow (kept functional only). So `PhoneEodCount` renders
its own `TabStrip` and, for the non-count tabs, delegates to the existing
`EODHistoryTab` / `VarianceLogTab` / `OrderScheduleSection`. To let the new file
import them, **add the `export` keyword** to `function EODHistoryTab()` and
`function VarianceLogTab()` (`OrderScheduleSection` is already its own module).
Adding `export` is purely additive — it does not change desktop render output,
so AC-REG holds.

**New files (grouped under a new `eod/` subfolder to avoid cluttering the flat
`sections/` dir — justified: three tightly-coupled phone-only files):**
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx` — the phone worksheet
  (day strip, vendor tabs + progress, progress row, count rows w/ wells, in-flow
  submit bar, tab routing).
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx` — the keypad bottom sheet.
- `src/lib/eodKeypad.ts` — the pure keypad/advance helpers (jest surface, §6).

**The `model` prop bundle.** Rather than 30 loose props, pass one typed
`model` object. Colors/T/insets are re-derived inside the child via
`useCmdColors()` / `useT()` / `useSafeAreaInsets()` (cheap hooks) — the model
carries only data + callbacks:

```ts
interface PhoneEodModel {
  // day strip
  week: DayCell[];
  selectedIso: string;
  setSelectedIso: (iso: string) => void;
  wkNum: number;
  // vendor tabs + per-tab progress
  vendorTabs: Array<Vendor & { count: number }>;
  selectedVendorId: string | null;
  setSelectedVendorId: (id: string) => void;
  setSelectedCategory: (c: string | 'all') => void;
  submittedVendorIds: Set<string>;
  countedItemIds: Set<string>;          // spec 102 counted-once-globally set
  storeInventory: InventoryItem[];      // to derive per-vendor progress purely
  // active worksheet
  filteredItems: InventoryItem[];
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  notes: Record<string, string>;
  setCaseCounts: (u: (p: Record<string,string>) => Record<string,string>) => void;
  setUnitCounts: (u: (p: Record<string,string>) => Record<string,string>) => void;
  setNotes:      (u: (p: Record<string,string>) => Record<string,string>) => void;
  hasEntry: (id: string) => boolean;
  localHasEntry: (id: string) => boolean;
  itemTotal: (i: InventoryItem) => number;
  countedNum: number;
  total: number;
  // gates / locks
  isRestDay: boolean;
  isVendorLocked: boolean;
  isCurrentVendorEditing: boolean;
  currentVendorSubmission: EODSubmission | null;
  submitting: boolean;
  // handlers (reused verbatim from the parent)
  onSubmit: () => void;
  onEditCurrentVendor: () => void;
  // gate-jump / deep-link bridge
  pendingFocusItem: string | null;
  // tab routing (shared strip)
  tabId: string;
  setTabId: (id: string) => void;
}
```

No new store fields are introduced (justified: everything the child needs is
already lifted in the parent and passed down). `onSaveDraft`, `+ COUNT`
(`AddCountModal`), and `+ vendor` (`AddVendorScheduleModal`) are **deferred for
phone v1** — the wells+keypad are the entry path; save-draft/manual-add are not
in the AC list. The cross-section `+ COUNT` **deep-link** still works: the
parent effect that unions `eodFocusItemId` into `additionalItems` and sets
`pendingFocusItem` runs before the early return, so `filteredItems` includes the
item and the child opens the sheet on it (see §4).

### 2 · The keypad sheet (AC-7 / AC-8)

Built on the existing **`ResponsiveSheet`** with
`presentation={{ phone: 'bottom-sheet' }}` — confirmed supported
(`resolvePresentation` maps phone `'bottom-sheet'` → bottom-sheet shape,
slide-from-bottom, RN `Modal` + `Animated.timing` 220 ms `Easing.out(cubic)`;
`ResponsiveSheet.tsx:74-77,108-125`). This is the sanctioned RN-`Animated`
idiom — **not** Reanimated-on-web, **not** `@gorhom/bottom-sheet`. Pass
`tabletSheetHeight={0.72}` (the prop also sizes the phone bottom-sheet, line 144)
so the pad clears the keyboard-free area; `header` = item name + meta + ✕,
`footer` = SKIP → / NEXT ITEM →|DONE ✓, `children` = field wells + note + running
total + digit pad.

**Field wells are `Pressable`/`Text`, NOT `TextInput`** — so the OS keyboard
never opens for the digit pad (custom pad only). The **note field IS a real
`TextInput`** (native text keyboard is correct there).

- **Two wells (62×48).** CS well shown only when `caseQty > 1`; unit-label well
  always. Active field = accent border + `accentBg`; inactive = `panel2` + fg.
- **Active-field default.** On open, `activeFieldFor(caseQty)` → `'cases'` when
  `caseQty > 1`, else `'units'`. Tapping the OTHER well switches the active
  field (AC-7). Whichever well was tapped in the row seeds the active field.
- **Digit append (write-through, single source of truth).** A key press calls
  the parent setter for the active field:
  `setCaseCounts(p => ({ ...p, [id]: appendKeypadDigit(p[id] || '', key) }))`
  (and the unit equivalent). Rules enforced by the pure helper: digits `0-9`
  append; `.` appends only if none present; `⌫` drops the last char; **max 5
  chars, single `.`**. Writing through to the existing count maps means the row,
  progress, and `hasEntry` update live and SKIP/close need no commit logic. Note
  field write-through via `setNotes`.
- **Running total.** `= {itemTotal(item)} {unit} total`, read from the same maps
  via the existing `itemTotal` (cases × caseQty + units). `0` is valid (AC-9).
- **Advance (SKIP / NEXT ITEM → DONE ✓).** Compute the on-screen order once
  (`filteredItems`, or the custom order when active — phone v1 uses
  `filteredItems` default order; custom-view reflow is not in the phone AC set).
  - NEXT ITEM: `advanceUncounted(ordered, currentIndex, hasEntry)` → seat the
    returned item, keep the sheet open, reset active field via `activeFieldFor`.
  - SKIP: same advance call but WITHOUT recording (no setter write for the
    current item).
  - **DONE ✓ label + behavior:** when `firstUncounted(ordered, hasEntry) === null`
    (reusing the existing `firstUncounted` from `src/lib/countOrder.ts`), the
    NEXT ITEM button relabels to **DONE ✓**; tapping it closes the sheet and
    fires the existing all-counted toast. Wraparound is handled by
    `advanceUncounted` (search forward from `currentIndex + 1`, wrap to 0).
  - Scrim tap / ✕ dismiss the sheet (`onClose`); no drag-to-dismiss (out of
    scope per ResponsiveSheet Phase 1).

### 3 · Phone type ramp + 44px hit floors (AC-13 / AC-14 — the one NEW sub-system)

**Location:** a new **additive export `PhoneType`** in
`src/theme/typography.ts` (NOT a local const block). Rationale: the handoff
frames the ramp as shell-wide — later phone specs (Inventory row, Ordering card)
reuse it; centralizing keeps it DRY and gives jest a single import to assert.
The existing `Type` map is **left byte-unchanged** (AC-13), so desktop is
unaffected. `PhoneType` composes with `sans()` / `mono()` and adds NO palette
values.

| role (`PhoneType.*`) | family / weight | fontSize | letterSpacing / transform | floor |
|---|---|---|---|---|
| `screenTitle`   | `sans(600)` | 20   | −0.4 | — |
| `itemName`      | `sans(600)` | 15   | −0.1 | — |
| `body`          | `sans(400)` | 14   | — | — |
| `metaMono`      | `mono(400)` | 11   | — | **≥ 10.5** |
| `caption`       | `mono(600)` | 10.5 | 0.85 / upper | — |
| `microCaption`  | `mono(600)` | 9    | 0.7 / upper | **≥ 8.5** |
| `wellValue`     | `mono(600)` | 16   | tabular | — |
| `wellValueSheet`| `mono(600)` | 20   | tabular | — (keypad-sheet well) |
| `kpiValue`      | `mono(600)` | 19   | −0.3 / tabular | — |
| `keypadKey`     | `mono(500)` | 18   | — | — |
| `tableNum`      | `mono(600)` | 14   | tabular | — (fg3 400/11 suffix rendered separately) |

**Hit floors (AC-14):** every tappable on the phone EOD surface ≥ 44×44 — day
cells (≥44, handoff 50), vendor tabs, count wells **62×48**, ✕ close (44),
keypad keys **50-54 tall**, SKIP / NEXT ITEM footer buttons, submit button
**48-50**. These are enforced by explicit `minWidth`/`minHeight`/`height` on the
`Pressable`s in `PhoneEodCount` / `PhoneKeypadSheet`.

### 4 · Reuse map (existing seams consumed, no new store fields)

- **Counted-once-globally (spec 102):** `deriveCountedItemIds` (exported from
  `EODCountSection`) → `countedItemIds` set → `hasEntry(id) = localHasEntry(id)
  || countedItemIds.has(id)`. Passed into `model`; the indicator square,
  progress row, per-tab progress, and DONE detection all read `hasEntry`. A
  shared item counted under any tab reads counted everywhere and never blocks.
- **Per-tab progress** is derived purely in the child from `storeInventory`
  (items linked to each vendor via `vendorIds ?? [vendorId]`) + `countedItemIds`
  + `submittedVendorIds` (→ "✓"). No new store state.
- **Submit gate + jump (AC-11/12):** reuse the parent's `onSubmit` verbatim. On
  a blocked submit it clears search, resolves the jump target via
  `firstUncounted`, and sets `pendingFocusItem`. The child watches
  `model.pendingFocusItem`; on a non-null value it copies the id into its own
  local sheet state and opens the keypad sheet on that item (phone translation
  of "seat + focus"). The parent's existing RAF focus effect still fires but is
  a no-op on phone (`caseInputRefs` is never populated) and its
  `setPendingFocusItem(null)` is harmless — the child already captured the id
  into local state. **Effect ordering note for the builder:** child `useEffect`
  commits before the parent's clearing `useEffect`, so the capture is robust;
  the child must snapshot into local state (not read `pendingFocusItem` lazily).
- **Post-submit navigation (AC-12):** `onSubmit`'s success path already calls
  `usePaletteAction.getState().request({ section: 'Ordering', selectedName: null })`
  — reused unchanged; nothing to re-wire.
- **Optimistic-then-revert + toast:** `onSubmit` → `submitEOD` (optimistic local
  merge) → `submitEODCount` → toast on failure. Reused verbatim; no new
  `notifyBackendError` call site.

### 5 · Presentational indicators (AC-1..6, read-only over existing state)

- **Counted/uncounted indicator square (20×20, radius `CmdRadius.xs`):** dashed
  `borderStrong` when `!hasEntry(id)`; `accentBg` + accent ✓ when counted.
  **Replaces** the phone red-name treatment — the item name is always `C.fg` on
  phone (desktop keeps `rowUncounted ? C.danger : C.fg`, untouched).
- **Day strip:** 7 cells (≥44, handoff 50), dow (mono) over dom (mono 600) +
  status dot colored by the existing `deriveDayStatus` result; selected = accent
  border + `accentBg`. Reads the existing `week: DayCell[]`. Locked/rest-day
  behavior (`isRestDay`, `isVendorLocked`) is restyled, not re-gated (AC-2).
- **Vendor tabs + per-tab progress:** horizontal strip, active = 2px accent
  underline; per-tab "counted/total" (fg3) → "✓" (ok) when
  `submittedVendorIds.has(vid)` (AC-3).
- **Progress row:** "N OF M COUNTED" (`PhoneType.caption`) + right status label +
  3px accent bar, fill = `countedNum / total` for the active vendor (AC-4).
- **In-flow submit bar (AC-10):** left status caption ("N LEFT" warn / "READY" ok
  / "SENT ✓" ok) + a 48px primary button (disabled `panel2`/`fg3`, enabled
  `accent`/`accentFg`). Rendered in-flow at the worksheet bottom (not absolute),
  coexisting with today's drawer shell (bottom-dock is a separate spec).

### 6 · Test plan (jest track only — no pgTAP, no shell smoke)

**Pure module `src/lib/eodKeypad.ts` (cheap unit surface):**
```ts
appendKeypadDigit(current: string, key: string, maxLen?: number): string  // default 5
activeFieldFor(caseQty: number | undefined): 'cases' | 'units'
advanceUncounted<T>(ordered: readonly T[], fromIndex: number,
                    isCounted: (i: T) => boolean): { item: T; index: number } | null
```
- `appendKeypadDigit`: digit append; `.` once only; `⌫` drops last; max-5 clamp;
  `'0'` from empty → `'0'` (valid count).
- `activeFieldFor`: `caseQty > 1` → `'cases'`, else `'units'` (incl. `undefined`/`1`).
- `advanceUncounted`: forward search, **wraparound**, skips counted, returns
  `null` when none remain (pair with `firstUncounted(...) === null` for DONE).

**Type ramp constants:** assert `PhoneType.metaMono.fontSize >= 10.5`,
`PhoneType.microCaption.fontSize >= 8.5`, and family/weight/size per the table
(AC-13). Assert the existing `Type` map is unchanged (import equality on a couple
of keys) to defend the additive contract.

**Component tests (`PhoneEodCount` / `PhoneKeypadSheet` at a phone width):**
counted/uncounted square + progress derivation incl. counted-once-globally;
sheet open on well tap; digit entry updates well + running total; NEXT/SKIP
advance-with-wrap → DONE ✓; submit-gate block (toast + jump opens sheet) and
success path (Ordering jump via `usePaletteAction`).

**Regression (AC-REG):** the existing `EODCountSection` jest tests must stay
green **unchanged**, plus a desktop-width (≥1100) render/snapshot assertion
pinning byte-unchanged output. Mock `useIsPhone` per case.

### Risks and tradeoffs

- **AC-REG surface.** The single biggest risk is an accidental desktop-tree edit.
  Mitigation: the ONLY edits to `EODCountSection.tsx` are (1) one early-return
  line, (2) the inline `model` literal in that branch, (3) `export` on the two
  tab functions. The desktop return subtree is not touched. The AC-REG snapshot
  guards it.
- **Dead phone branches.** The pre-existing `isPhone` sub-branches in the desktop
  return become unreachable after the early return. Left in place deliberately
  (removing them is churn with AC-REG downside). Flag a follow-up cleanup spec;
  a reviewer may otherwise file it as dead code — that is expected and accepted.
- **Deferred phone affordances.** `+ COUNT` (manual add), `+ vendor`, save-draft,
  export toolbar, and count-order (spec 103) custom view are NOT reflowed for
  phone v1 (out of scope per the spec). The `+ COUNT` deep-link from item detail
  still functions via `pendingFocusItem`. If a reviewer expects manual add on
  phone, that is a scope question for the PM, not a bug.
- **`pendingFocusItem` double-consumer.** Parent (RAF focus) + child (open sheet)
  both react. Robust via child-before-parent effect ordering + child snapshot;
  documented for the builder so it isn't "simplified" away.
- **Performance.** No new queries; the 286 KB seed load path is unchanged.
  Per-tab progress is an O(items) derive over `storeInventory` memoized on
  `countedItemIds`. No edge-function cold-start (none touched).
- **Prop-bundle brittleness.** The `model` object is wide. Accepted over a
  model-hook extraction because the latter would refactor the parent's shared
  state region and endanger AC-REG for no user-facing gain.

## Handoff
next_agent: frontend-developer
prompt: Implement the phone-tier EOD count per the `## Backend design` in this
  spec — extract `PhoneEodCount` + `PhoneKeypadSheet` under
  `src/screens/cmd/sections/eod/`, the pure `src/lib/eodKeypad.ts`, and the
  additive `PhoneType` ramp in `src/theme/typography.ts`; gate via an
  `if (isPhone) return <PhoneEodCount model={…} />` early-return in
  `EODCountSection.tsx` (desktop tree byte-unchanged, add only `export` to the
  two tab functions). Reuse `onSubmit` / `firstUncounted` / `deriveCountedItemIds`
  / `usePaletteAction` verbatim. Add the jest tests in §6. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/140-phone-eod-count-tier.md

## Files changed

New files:
- `src/lib/eodKeypad.ts` — pure keypad/advance helpers (`appendKeypadDigit`,
  `activeFieldFor`, `advanceUncounted`, `KEYPAD_BACKSPACE`).
- `src/lib/eodKeypad.test.ts` — unit tests for the pure module.
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx` — phone worksheet (day strip,
  vendor tabs + per-tab progress, progress row, count rows w/ wells + indicator
  square, in-flow submit bar, tab routing, keypad-sheet host, `pendingFocusItem`
  bridge). Exports `PhoneEodModel` / `PhoneDayCell`.
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx` — keypad bottom sheet on
  `ResponsiveSheet` (`presentation.phone: 'bottom-sheet'`); Pressable wells,
  note TextInput, running total, 3-col digit pad, SKIP / NEXT ITEM → DONE ✓.
- `src/screens/cmd/sections/eod/__tests__/PhoneType.test.tsx` — type-ramp
  constants + floors + `Type`-unchanged assertions (AC-13).
- `src/screens/cmd/sections/eod/__tests__/PhoneEodCount.test.tsx` — component
  tests (indicator square + counted-once-globally, sheet open, digit entry +
  running total, NEXT/SKIP advance-with-wrap → DONE, submit + gate-jump bridge).
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.acReg.test.tsx` —
  AC-REG desktop-vs-phone early-return gate guard.

Modified files:
- `src/theme/typography.ts` — additive `PhoneType` export (existing `Type` map
  byte-unchanged).
- `src/screens/cmd/sections/EODCountSection.tsx` — import `PhoneEodCount`; add
  `export` to `EODHistoryTab` / `VarianceLogTab`; add the
  `if (isPhone) return <PhoneEodCount model={…} />` early-return after the
  store/skeleton guards (desktop return subtree untouched).
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — additive
  `section.eod.phone.*` keys (skip / nextItem / done / left / ready / sent /
  counted / casesWell / runningTotal / allCounted), parity preserved.

## Verification
- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- `npx jest` → exit 0 (141 suites / 1472 tests passed; existing
  `EODCountSection.*` + i18n-parity suites green unchanged).
- Browser pass NOT run by the implementing agent (no preview tools available in
  this environment). Main Claude to run the 375px web + dark/light pass.
