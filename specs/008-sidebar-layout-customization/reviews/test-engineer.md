## Test report for spec 008

**Re-walk pass — 2026-05-08. Prior report had 2 FAIL on AC-Q10. Fix-pass
closed all 5 release-proposal items. This pass verifies the fix-pass claims.**

---

### Acceptance criteria status

#### Resolved-question-locked criteria (Q1–Q10 answers now firm)

- **AC-Q4: Gear icon visible at sidebar top** → PASS
  - `Sidebar.tsx:102–133`: `Platform.OS === 'web'` guard renders a `⚙`
    `TouchableOpacity` in the `flex:1` slot of the header row. Placement
    matches architect §0.4 (line 72 free-flex-slot). Browser-verified by
    main Claude in first pass.

- **AC-Q5: Edit mode entry/exit (gear → DONE flip)** → PASS
  - `Sidebar.tsx:103–133`: when `editMode` is false the gear renders; when
    true the DONE pill renders in the same physical slot.
    `onToggleEditMode` is wired through `InventoryDesktopLayout.tsx:288`.
    Browser-verified by main Claude in first pass (DONE button + "reset to
    default" pill + drag handles + hide toggles visible on gear click).

- **AC-Q5: Inline drag-and-drop reorder (within group)** → CODE-VERIFIED
  - `SidebarEditMode.tsx:247–255`: `handleDragEnd` handles same-group reorder
    using `arrayMove`. `PointerSensor` with `distance: 4` activation threshold
    registered. `DndContext` wraps all groups in a single context.
  - Drag-to-reorder NOT browser-tested in this review pass (dnd-kit drag
    simulation is brittle without browser tooling). Code path is structurally
    correct per the DnD wiring.

- **AC-Q1: Cross-group reorder (drag across Operations / Planning / Insights)** → CODE-VERIFIED
  - `SidebarEditMode.tsx:199–229`: `handleDragOver` handles cross-group move
    by detecting `activeGroup !== overGroup`, splicing the item out of the
    source group, and inserting at the over-position. `handleDragEnd` returns
    early when groups differ (cross-group was already reconciled by `dragOver`).
  - NOT browser-tested.

- **AC-Q2: Hide/show items** → PASS
  - `InventoryDesktopLayout.tsx:239–255`: `handleToggleHide` toggles
    `hiddenByUser` on the draft group. `applySidebarOverride` with
    `editMode:true` keeps hidden items visible with `hiddenByUser:true`.
    Without `editMode`, hidden items are filtered out.
  - Browser-verified by main Claude in first pass: `◉` → `⊘` toggle on
    DB inspector visible and functional; DB inspector hidden after DONE;
    persists across hard reload.

- **AC-Q3: Per-user persistence via `profiles.sidebar_layout`** → PASS
  - Migration `20260508120000_spec008_profiles_sidebar_layout.sql` adds
    `sidebar_layout jsonb` to `profiles`. `saveSidebarLayout` in `db.ts:895–904`
    writes per-user. `fetchProfile` in `auth.ts:59–101` reads it back.
    `setSidebarLayoutOverride` in `useStore.ts:1202–1212` follows
    optimistic-then-revert pattern.
  - Browser-verified by main Claude in first pass: DB inspector hidden state
    persisted across hard browser reload.

- **AC-Q6: Reset to default** → PASS
  - `InventoryDesktopLayout.tsx:257–267`: `handleReset` calls
    `confirmAction('Reset sidebar to default?', 'This clears all your
    customizations.', ...)` which calls `setSidebarLayoutOverride(null)` and
    `setSidebarEditMode(false)`.
  - Browser-verified by main Claude in first pass.

- **AC-Q7: Override-list model — future items auto-append** → CODE-VERIFIED
  - `sidebarLayout.ts:113–121`: items not in `ovById` fall through to
    `targetGroup = g.label` and `sortKey = defaultSortKey(gi, ii)`, placing
    them at their default position. Stale override entries (id not in
    `defaultGroups`) are never visited — dropped silently.
  - Pure-function invariant; no browser interaction required. The algorithm
    matches architect §7 spec exactly.

- **AC-Q8: Web-only platform scope** → PASS
  - `Sidebar.tsx:41–43, 76`: `SidebarEditModeLazy` is `null` on non-web
    platforms; `showEditAffordances = Platform.OS === 'web'` gates the gear
    icon. No DnD or edit affordances render on native.

- **AC-Q10: Keyboard accessibility for reorder** → PASS (was FAIL — now FIXED)

  **Cross-group keyboard reorder (`←`/`→`):**
  - `SidebarEditMode.tsx:102–162`: `customCoordinateGetter` intercepts
    `KeyboardCode.Left` / `KeyboardCode.Right` when a lift is in progress.
    For `↑`/`↓` it falls through to `sortableKeyboardCoordinates`. For `←`/`→`:
    1. Resolves the active item's group via `data.groupLabel` from the
       `useSortable({ id, data: { groupLabel } })` call on each `SortableRow`
       (line 372), with a fallback scan of `groupsRef.current`.
    2. Computes `targetIdx = activeIdx ± 1` from the live group order.
    3. Picks a target droppable id: `__group__:<label>` when the target group
       is empty, the first item when going right, the last when going left.
    4. Reads that droppable's rect from `args.context.droppableRects` and
       returns `{ x: rect.left, y: rect.top }`.
    5. Calls `event.preventDefault()` before returning to suppress horizontal
       browser scroll.
    - dnd-kit's `closestCenter` collision then fires `onDragOver` against
      that rect, and the existing `handleDragOver` cross-group splice logic
      moves the item. No duplicate reconciliation path.
  - `KeyboardSensor` is wired at line 168: `useSensor(KeyboardSensor, {
    coordinateGetter: customCoordinateGetter })`.
  - Main Claude browser-verified (Space→→Space moved Inventory from
    OPERATIONS to PLANNING).
  - **STATUS: PASS** (Fix-pass item #2 closed. Prior FAIL resolved.)

  **`H` hide-shortcut:**
  - `SidebarEditMode.tsx:178–190`: `handleKeyDown` on a wrapper `<div>`
    (lines 286–299) wrapping the full groups tree. Fires when
    `event.code === 'KeyH'` with no modifiers and `activeId === null` (not
    mid-drag). Walks up from `event.target` to
    `closest('[data-sidebar-item-id]')` to identify the focused item id.
    Calls `onToggleHideRef.current(id)`. Each `SortableRow`'s root `<div>`
    carries `data-sidebar-item-id={item.id}` (line 408).
  - Main Claude browser-verified (focused DBInspector + `keydown { key: 'h' }`
    flipped `◉` → `⊘`).
  - **STATUS: PASS** (Fix-pass item #3 closed. Prior FAIL resolved.)

  **Intra-group keyboard reorder (`↑`/`↓`):**
  - `customCoordinateGetter` defers `↑`/`↓` to `sortableKeyboardCoordinates`
    (line 105), which handles intra-`SortableContext` moves natively.
  - CODE-VERIFIED (not separately browser-tested, but this is the default
    dnd-kit keyboard behavior unchanged from the original pass).

  **Space/Enter lift + drop, Escape cancel:**
  - `onDragCancel={() => setActiveId(null)}` at line 270 wires the Escape
    cancel path. Space/Enter lift+drop are handled by `KeyboardSensor`
    natively (no custom wiring needed per dnd-kit architecture).
  - CODE-VERIFIED.

  **Screen-reader announcements:**
  - `DndContext.accessibility.announcements` (lines 271–281): strings are
    `"Picked up X."`, `"X is over Y."`, `"X dropped over Y."`,
    `"Dragging X cancelled."`.
  - Still diverges from the spec §9 ideal of `"Inventory lifted; row 1 of 5
    in Operations group"` (no row-position or group context). The spec §9
    contract says the richer form, but the §"Out of scope" block explicitly
    defers a full a11y audit. This is a degraded but functional announcement
    experience. Not a blocking criterion per the spec's own scoping.
  - STATUS: Minor divergence from §9 ideal; not a blocking AC.

#### Unconditional criteria

- **Exit from edit mode reflects saved layout immediately (no full page reload)** → PASS
  - `InventoryDesktopLayout.tsx:200–210`: `renderedGroups` is a memoized
    derivation of `sidebarLayoutOverride`; when `setSidebarLayoutOverride` is
    called on DONE, the memo recomputes and `<Sidebar>` re-renders
    immediately. No navigation or page reload.

- **Section state preserved across edit-mode entry/exit** → PASS
  - `section` is `useState('Inventory')` at `InventoryDesktopLayout.tsx:81`.
    `handleToggleEditMode` only mutates `sidebarEditMode` and `draftGroups` —
    `setSection` is never called. Section state is structurally isolated from
    edit-mode transitions.
  - Browser-verified by main Claude in first pass.

- **No dupes / utilize existing Sidebar + TreeGroup** → PASS
  - `Sidebar.tsx` is extended with new props, not forked. `TreeGroup.tsx` is
    extended with `editMode`, `hiddenByUser`, `onToggleHide` props, not forked.
    `SidebarEditMode.tsx` is a new DnD engine component; it does not replace
    `TreeGroup` in the normal-mode render path. The normal-mode path
    (`Sidebar.tsx:225–228`) still renders `<TreeGroup>` unchanged.

- **All DB access through `src/lib/db.ts`; optimistic-then-revert pattern** → PASS
  - `useStore.ts:1202–1212`: `setSidebarLayoutOverride` saves `prev`, sets
    local state, calls `db.saveSidebarLayout`, on error reverts and calls
    `notifyBackendError`. No direct `supabase.*` call in the store for this
    feature.
  - `db.ts:895–904`: `saveSidebarLayout` is the sole write path, throws on
    error for the store to catch.

- **`src/screens/AdminScreens.tsx` not modified** → PASS
  - No spec-008 changes present in that file.

- **`app.json` slug not modified** → PASS
  - `app.json:4`: `"slug": "towson-inventory"` unchanged.

- **`restricted` flag is reused, not re-implemented (if needed)** → PASS
  - `TreeGroup.tsx:13–22`: `restricted` (strikethrough + opacity 0.42) and
    `hiddenByUser` (opacity 0.55, no strikethrough) are distinct flags with
    documented semantic difference. The existing `restricted` rendering is
    untouched per architect §11.

- **Legacy stores not modified** → PASS
  - `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json` — none of these
    files are referenced by any spec-008 diff.

---

### Fix-pass closure verification

| Proposal item | Claim | Code evidence | Verdict |
|---|---|---|---|
| #1 — Split hydrator / setter | `App.tsx` uses `hydrateSidebarLayoutOverride` on login-restore; persisting setter never called at boot | `App.tsx:120,166`: `hydrateSidebarLayoutOverride` selected from store; `setSidebarLayoutOverride` not imported there | CLOSED |
| #2 — Cross-group ←/→ keyboard | Custom `KeyboardCoordinateGetter` intercepts `Left`/`Right`, returns target-group rect | `SidebarEditMode.tsx:102–162,168`: `customCoordinateGetter` wired to `KeyboardSensor` | CLOSED |
| #3 — `H` hide-shortcut | `onKeyDown` on wrapper `<div>` fires `onToggleHide` on focused row when `KeyH` pressed | `SidebarEditMode.tsx:178–190,286–299`: handler + wrapper confirmed | CLOSED |
| #4 — Unify `coerceSidebarLayout` with `isValidOverride` | `auth.ts`'s `coerceSidebarLayout` now delegates to `isValidOverride` from `sidebarLayout.ts` | `auth.ts:4,29–31`: imports and delegates; per-item type check now enforced | CLOSED |
| #5 — `EmptyGroupDropZone` uses `useDroppable` | Replaced `useSortable` with `useDroppable` (canonical primitive) | `SidebarEditMode.tsx:460–468`: `useDroppable({ id })` with comment | CLOSED |

---

### Remaining findings

#### Finding 1: Screen-reader announcement format diverges from spec §9 ideal (Minor — not blocking)

The spec §9 contract gives `"Inventory lifted; row 1 of 5 in Operations group"` as the target announcement. The implementation announces `"Picked up Inventory."` — correct intent but missing row-position and group context. The spec's own `§"Out of scope"` block explicitly defers a full a11y audit to a follow-up spec, so this is not a blocking AC. The announcement is functional (it fires); it just lacks richer context. Documented for a follow-up a11y pass.

#### Finding 2: `handleDragOver` still uses closure-captured `groups` not `groupsRef` (Low — not blocking)

`handleDragOver` (lines 199–229) reads from `groups` prop directly, not `groupsRef.current`. The fix-pass added `groupsRef` for the keyboard coordinate-getter (which needs stable closure semantics), but `handleDragOver` uses the live prop. This is the correct pattern for a React event handler — it receives the latest `groups` via the render cycle — so this is not a bug. The `groupsRef` is only needed for the stable `useCallback` in `customCoordinateGetter`. No action required.

#### Finding 3: Empty-save probe (§10.8) — `produceOverride` null path (Code-verified)

When the user enters and exits edit mode without changes, `produceOverride` returns `null` (line 198: `return items.length === 0 ? null : { v: 1, items }`). `setSidebarLayoutOverride(null)` is then called, which is a write to DB. The spec §10.8 says "sidebar_layout is NULL (no spurious override row written)" — this is satisfied because `null` is the uncustomized sentinel and the DB column is already NULL for a fresh user. For an already-customized user clicking DONE with no changes, the existing override is overwritten with `null`, which is semantically wrong (it resets their customization). However, this edge case only occurs if the user opens edit mode and closes it immediately without making changes after previously saving customizations. In practice, the `draftGroups` path (`InventoryDesktopLayout.tsx:226–230`) diffs from `draftGroups`, which is seeded with the current override-applied view on enter — so if nothing changed in the draft, `produceOverride` comparing rendered-from-override against default will correctly emit only the items that differ from default. This is actually correct: the diff accounts for the current override, not a blank-slate comparison. Code-verified correct; not a bug.

---

### Test run

No automated test suite exists. All verification performed via:
- Code inspection (CODE-VERIFIED items)
- Main Claude browser interactive verification (PASS items marked "browser-verified")
- Fix-pass build notes (bundle compile, tsc clean) carried forward from spec

---

### Summary of AC verdicts

| # | Criterion | Verdict |
|---|---|---|
| Q4 | Gear icon at sidebar top | PASS |
| Q5 | Edit mode entry/exit (gear/DONE) | PASS |
| Q5 | Inline DnD reorder | CODE-VERIFIED |
| Q1 | Cross-group reorder (drag) | CODE-VERIFIED |
| Q2 | Hide/show items | PASS |
| Q3 | Per-user persistence | PASS |
| Q6 | Reset to default | PASS |
| Q7 | Future items auto-append | CODE-VERIFIED |
| Q8 | Web-only | PASS |
| Q10 | Cross-group ←/→ keyboard reorder | PASS (was FAIL) |
| Q10 | `H` hide-shortcut | PASS (was FAIL) |
| Q10 | Intra-group ↑/↓ keyboard reorder | CODE-VERIFIED |
| Q10 | Space/Enter lift+drop, Escape cancel | CODE-VERIFIED |
| — | Exit reflects layout immediately | PASS |
| — | Section state preserved | PASS |
| — | No dupes / utilize existing | PASS |
| — | DB access through db.ts + optimistic-revert | PASS |
| — | AdminScreens.tsx untouched | PASS |
| — | app.json slug untouched | PASS |
| — | `restricted` reused not re-implemented | PASS |
| — | Legacy stores untouched | PASS |

**0 FAIL. 5 CODE-VERIFIED (keyboard intra-group ↑/↓, Space/Enter, Escape, drag reorder within group, drag reorder cross-group). 16 PASS.**

The two prior FAIL items (AC-Q10 cross-group keyboard reorder, `H` key shortcut) are both PASS in this re-walk.

All 5 release-proposal items are confirmed CLOSED by code inspection.
No blocking findings. The open minor items (screen-reader announcement richness, deferred code-reviewer nits) are all explicitly deferred in the proposal and do not map to acceptance criteria.
