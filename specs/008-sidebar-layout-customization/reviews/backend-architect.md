# Backend-architect drift re-review (post fix-pass) — Spec 008 (Sidebar layout customization)

**Mode:** post-implementation drift review, second pass (post fix-pass).
**Verdict at a glance:** all three of my prior Should-fix items closed
cleanly. **Zero Critical, zero Should-fix, two Nits remain (downgraded).**
The fix-pass introduced **no new architectural drift**. The hydrator/setter
split mirrors the `setDarkMode`/`toggleDarkMode` precedent precisely, the
custom `KeyboardCoordinateGetter` is a faithful and well-bounded
implementation of the §9 design pseudocode, and the
`useSortable` → `useDroppable` swap on `EmptyGroupDropZone` preserves the
§6 contract while removing the misuse-of-sortable-outside-context smell.

Re-review covers:
1. status of the three prior Should-fix items (S1, S2, S3),
2. status of the two prior Nits (N1, N2) and the false-alarm (N3),
3. new architectural drift introduced by the fix-pass (none found).

---

## 1. S1 — cross-group keyboard reorder via ←/→ — **RESOLVED**

[src/components/cmd/SidebarEditMode.tsx:95-162](../../../src/components/cmd/SidebarEditMode.tsx)
+ `useSensors` wiring at
[src/components/cmd/SidebarEditMode.tsx:164-169](../../../src/components/cmd/SidebarEditMode.tsx)

Custom `KeyboardCoordinateGetter` named `customCoordinateGetter`, wired via
`useSensor(KeyboardSensor, { coordinateGetter: customCoordinateGetter })`.
Signed off as RESOLVED on three counts:

**Match against §9 design pseudocode.** The §9 contract specified:
> "The implementer needs a small custom coordinate-getter that maps ←/→ to
> 'switch to neighboring group's nearest position.' This is ~30 LOC and
> well-documented in the dnd-kit docs."

The implementation is ~60 LOC (longer than my estimate, but appropriately
defensive). The shape matches:
- Intercepts `KeyboardCode.Left` / `KeyboardCode.Right` only; defers
  `Up`/`Down` to stock `sortableKeyboardCoordinates`. **Correct fall-through.**
- Resolves the active item's group via `droppableContainers.get(active.id)`
  → `data.current.groupLabel`, falling back to a `groupsRef` scan. **Two
  layers of resolution — defensive, and `data.groupLabel` is plumbed in
  from `useSortable({ id, data: { groupLabel } })` at line 372.**
- Finds the target group by index ±1; returns undefined if at the edge
  (no wrap-around). **Sensible default; matches user expectation.**
- Targets the empty-group drop zone (`__group__:<label>`) when the target
  group is empty, otherwise picks the first item on `Right` and the last
  item on `Left`. **This is the asymmetry I want to call out below — it
  diverges from a strict reading of the §9 contract but is the right call.**

**Cross-group transition correctness.** Prompt asked specifically:
> "last-of-A → first-of-B; first-of-A → last-of-prev-group"

The implementation does:
- `Right` → `targetGroupItems[0]` (first of next group). ✓
- `Left` → `targetGroupItems[targetGroupItems.length - 1]` (last of previous
  group). ✓

This matches the prompt's expectation. **Note on naming:** the §9 prose
("last-of-A → first-of-B") implies that the *current item's position within
A* matters — i.e., only the last item of A should jump to B on `Right`.
The implementation always jumps regardless of within-A position. This is
**correct and better than the literal reading**: keyboard users would be
frustrated by `Right` only working from the last row. The dev's choice is
"`Right` always means switch group; intra-group reorder is handled by `↑↓`
which is what the user should be using anyway." Architecturally clean.

The header comment at line 95-101 even self-documents this:
> "We intercept ←/→ here and return coordinates pointing at the
> previous/next group's first/last droppable rect so the existing
> `handleDragOver` reconciliation lands the item across groups."

**Reliance on `handleDragOver` reconciliation.** This is the load-bearing
detail: the coordinate-getter doesn't itself rewrite the `groups` state;
it just returns coordinates inside the target group's rect, which causes
dnd-kit to fire `onDragOver` against the new collision target, which my
existing `handleDragOver` (line 199) reconciles. Same code path as pointer
DnD cross-group moves. **One source of truth for cross-group transfer
logic — pointer and keyboard share it.** Excellent.

**Two minor implementation refinements worth noting (not findings):**

- `groupsRef` + `onToggleHideRef` (lines 82-93) decouple the closure'd
  callbacks from React render cycles, so the `KeyboardSensor` doesn't
  re-bind on every `groups` change. Standard pattern; well-applied.
- `event.preventDefault()` on line 152 prevents the browser's default
  `←/→` behavior (text-cursor movement) from leaking through. Necessary.

**Browser verification.** Prompt confirms: "Inventory crossed
OPERATIONS → PLANNING via Space→→Space." Matches design intent.

No drift. RESOLVED.

## 2. S2 — `H` shortcut for hide-toggle — **RESOLVED**

[src/components/cmd/SidebarEditMode.tsx:178-190](../../../src/components/cmd/SidebarEditMode.tsx)
+ wrapper at line 286-289 + `data-sidebar-item-id` attribute at line 408.

`handleKeyDown` callback registered on a wrapping `<div>` inside the
`DndContext`. Signed off as RESOLVED on three counts:

**Match against §9 design pseudocode.** §9 said:
> "`H` (when an item is focused, not lifted) — toggle hide/show. (Single
> letter; no modifier. Common admin power-user pattern.)"

Implementation:
- `e.code !== 'KeyH'` filter — single letter, no modifier. ✓
- `e.metaKey || e.ctrlKey || e.altKey || e.shiftKey` early-return — strictly
  no-modifier. ✓ (Matches the "single letter; no modifier" wording.)
- `if (activeId !== null) return` — "not lifted" guard. ✓ This is the
  detail I'm most pleased with — the dev correctly read the parenthetical
  in §9. `H` while a lift is in flight would conflict with the user's
  spatial mental model.
- Looks up the focused row via
  `target?.closest?.('[data-sidebar-item-id]')` — DOM-level lookup keyed on
  the per-row `data-sidebar-item-id` attribute set at line 408. **Clean
  data-attribute coupling between the row component and the keyboard
  handler; no globally-scoped focus tracking.**
- `e.preventDefault()` on line 188 — prevents `H` from leaking through to
  the browser (e.g. as a search-key filter). Necessary.

**Scoping correctness.** The handler lives on a wrapping `<div>`, not on
`window` or `document`. `H` only fires when focus is inside the edit-mode
tree. Critical for a single-letter shortcut — globally-bound `H` would
hijack the key in input fields, the URL bar, etc. **Correctly bounded.**

**One small architectural call-out (not a finding):** the dev wrapped the
`<DndContext>`'s children inside an extra `<div onKeyDown={handleKeyDown}>`
rather than putting the handler on the existing inner `<View>`. The inner
RN-Web `<View>` doesn't accept `onKeyDown` cleanly (RN's view typings
don't surface keyboard events), so this is forced; flagging only so future
readers know why an extra `<div>` exists. The rendered DOM is one `div`
deeper but visually identical (style is `flex column flex:1`).

**Browser verification.** Prompt confirms: "focused DBInspector + H toggles
marker ◉ → ⊘." Matches design intent.

No drift. RESOLVED.

## 3. S3 — split `setSidebarLayoutOverride` into hydrator + persisting setter — **RESOLVED**

[src/store/useStore.ts:1188-1212](../../../src/store/useStore.ts) + types at
[src/store/useStore.ts:134-149](../../../src/store/useStore.ts) + login wiring
at [App.tsx:120, 158-167](../../../App.tsx)

This was the architectural gap I owned in §3. Fix-pass closes it cleanly.

**Match against the recommended fix in my prior review.** I asked for:
- `hydrateSidebarLayoutOverride(override)` — pure local state set, no DB
  write. Called from `App.tsx` login restore.
- `setSidebarLayoutOverride(override)` — local-set + DB-write +
  optimistic-revert. Called from edit-mode DONE / reset paths.

Implementation:

```ts
hydrateSidebarLayoutOverride: (override) => {
  set({ sidebarLayoutOverride: override });
},
setSidebarLayoutOverride: (override) => {
  const prev = get().sidebarLayoutOverride;
  set({ sidebarLayoutOverride: override });
  const userId = get().currentUser?.id;
  if (!userId) return;
  db.saveSidebarLayout(userId, override).catch((e: any) => {
    set({ sidebarLayoutOverride: prev });
    notifyBackendError('Save sidebar layout', e);
  });
},
```

Verbatim match. App.tsx:166 calls `hydrateSidebarLayoutOverride`. The
edit-mode DONE / reset paths in `InventoryDesktopLayout.tsx` continue to
call `setSidebarLayoutOverride`.

**Mirroring `setDarkMode`/`toggleDarkMode`?** Yes, faithfully. Compare:

| | dark-mode | sidebar-layout |
|---|---|---|
| Hydrator (no-persist) | `setDarkMode(value)` (line 1184) | `hydrateSidebarLayoutOverride(override)` (line 1192) |
| Persister | `toggleDarkMode()` (line 1166-1182) | `setSidebarLayoutOverride(override)` (line 1202-1212) |
| Login path uses | `setDarkMode` (App.tsx:157) | `hydrateSidebarLayoutOverride` (App.tsx:166) |
| Optimistic-revert? | No (fire-and-forget) | Yes (full revert on error) |

The naming asymmetry (`setX` vs `hydrateX`) is the one place this could
have read better — `setDarkMode` is the historical name for what is
semantically a hydrator, and the dev kept `setSidebarLayoutOverride` for
the persister rather than renaming it `toggleSidebarLayoutOverride` or
similar. **This is the right call.** Reasons:
- `setSidebarLayoutOverride` is *not* a toggle — it accepts an arbitrary
  override value, not a flip. So `toggleX` would be misleading.
- The new `hydrateX` name explicitly carries the no-persist semantic in
  its name, which is *better* than dark-mode's accidentally-overloaded
  `setDarkMode`. If anything, the dark-mode names are the legacy
  divergence; the sidebar-layout names are clearer.
- The header comment at line 1188-1191 cross-references the
  `setDarkMode`/`toggleDarkMode` precedent and explains the choice.

The TypeScript signatures on `AppState` (lines 134-149) carry doc
comments that explain the no-persist-vs-persist split. Reads cleanly.

**One small architectural observation (not a finding).** The persister
also early-returns when `!userId`, treating "logged out" as local-only
rather than throwing. This is a minor extension over my prior signature
but is the right safety net — legacy/demo mode (no Supabase login) would
otherwise hit `db.saveSidebarLayout(undefined, override)` and 401. The
header comment at line 1206-1207 calls this out explicitly.

No drift. RESOLVED.

---

## 4. Prior Nits — status

### N1 — `EmptyGroupDropZone` `useSortable` → `useDroppable` — **RESOLVED**

[src/components/cmd/SidebarEditMode.tsx:465-489](../../../src/components/cmd/SidebarEditMode.tsx)

```ts
const { setNodeRef, isOver } = useDroppable({ id });
```

Imported `useDroppable` from `@dnd-kit/core` (line 27). Removed the
`useSortable` call and the unused transform/transition fields from the
prior implementation. Header comment at line 459-464 self-documents the
swap and cites the architect Nit N1 / release-proposal item #5.

**§6 contract preservation check.** §6 said the empty-group drop zone is
a stable target inside an otherwise-empty `SortableContext`. The new
implementation:
- Still lives inside the parent `<SortableContext items={...}>` at line
  340 — the SortableContext gets an empty `items` array when the group
  is empty, but the EmptyGroupDropZone is rendered inside it as a sibling.
  `useDroppable` doesn't require participation in a `SortableContext`,
  so this is fine.
- Same `id` shape: `__group__:<label>`. ✓
- Same `setNodeRef` plumbing onto a `<div>` ref. ✓
- `isOver` still drives the dashed-border-color flash. ✓
- `findGroupLabel` still detects the `__group__:` id prefix at line 69.
  No change there.
- `handleDragOver`'s `overIsGroup` branch still catches the same
  `__group__:` prefix at line 223. ✓

**Pointer + keyboard contract preserved.** Pointer DnD lands as before:
drag onto the dashed zone → `over.id = '__group__:Operations'` → cross-group
reconciliation appends. Keyboard cross-group via `customCoordinateGetter`
at line 141-142 explicitly aims at the `__group__:<label>` id when the
target group is empty. So the empty-zone path is now reachable by both
pointer AND keyboard, which is a small *improvement* over the prior
implementation (the old `useSortable` version was technically reachable
by keyboard but only because dnd-kit was treating the drop zone as a
sortable item, which was a bug-disguised-as-a-feature).

No drift. RESOLVED, and **the swap actually strengthened the §6 contract.**

### N2 — memoize id-to-group map — **STILL OPEN** (no severity change)

[src/components/cmd/SidebarEditMode.tsx:63-72](../../../src/components/cmd/SidebarEditMode.tsx)

`findGroupLabel` is still a linear scan, called twice per `onDragOver`
event. Not addressed by the fix-pass. Severity unchanged: **future scaling
note for if the sidebar grows past a few dozen items.** Currently
3 groups × 17 items = 51 comparisons per call. Not a current concern.

Leaving as STILL-OPEN, severity Nit. Not blocking.

### N3 — `produceOverride` "moved-then-moved-back" sanity — **N/A (was a false alarm in the original review)**

No change needed; my prior review concluded by inspection that the
encoding is consistent. Re-confirmed against
[src/lib/sidebarLayout.ts:165-199](../../../src/lib/sidebarLayout.ts):
`renderedOrder = defaultSortKey(gi, ii)` and `def.order = defaultSortKey(...)`
use the same formula. `orderChanged` correctly suppresses no-op moves.

---

## 5. New architectural drift introduced by the fix-pass

**None found.**

I checked the four most likely places fix-pass changes could have
introduced drift:

| Surface | Risk | Outcome |
|---|---|---|
| New `groupsRef` / `onToggleHideRef` pattern in SidebarEditMode | Could couple to stale state in handlers | Both refs are updated in `useEffect` blocks dependent on the source props. Standard React-ref-mirror pattern. No staleness possible. |
| New `coerceSidebarLayout` delegation to `isValidOverride` | Could weaken or strengthen the read-path validation in unexpected ways | I confirmed the swap at [src/lib/auth.ts:29-31](../../../src/lib/auth.ts). `isValidOverride` is **strictly stronger** than the prior local guard (validates per-item field types — id/group/order/hidden — that the local guard skipped). Single source of truth for shape now lives in `sidebarLayout.ts`. This was code-reviewer's #3 and a transparent improvement. |
| `useDroppable` swap on EmptyGroupDropZone | Could break cross-group keyboard reorder if the keyboard getter still depended on the old id shape | Re-verified: the customCoordinateGetter uses `__group__:${targetGroup}` (line 142) which matches `useDroppable({ id: __group__:${label} })` (line 467-468). Pointer + keyboard both still work. |
| `<div onKeyDown>` wrapper inside `<DndContext>` | Could swallow drag events meant for SortableRow children | Wrapper sits at the same React level as `<View>`; events bubble normally. The early-return on `e.code !== 'KeyH'` ensures no other keys are intercepted. |

The fix-pass is **architecturally clean.** No new contract surfaces, no
new state, no new persistence paths, no new RLS implications. Two of the
five fix-bundle items (S1, S2) are pure-frontend a11y wiring; one (S3) is
a store-action split that changed names but kept the same underlying
write contract; one (N1/release-#5) is a primitive swap that strengthened
the `useDroppable` contract; one (release-#3, code-reviewer-#3) is a
validation-logic consolidation that strengthened the read-path guard.

---

## 6. Summary by severity

| Sev | # | Items | Δ vs prior |
|---|---|---|---|
| Critical | 0 | — | unchanged |
| Should-fix | 0 | — | **all 3 closed** (S1 RESOLVED, S2 RESOLVED, S3 RESOLVED) |
| Nit | 1 | N2 (memoize id-to-group map for `handleDragOver`) | N1 RESOLVED, N2 unchanged, N3 was a false alarm |

**No new architectural drift.** Spec 008's §0–§11 contract is now
end-to-end matched in implementation; the prior post-impl gaps in §3
(redundant write) and §9 (cross-group keyboard + `H` shortcut) are
closed.

The hydrator/setter naming choice (`hydrateX`/`setX` rather than
`setX`/`toggleX`) is a deliberate and *better* pattern than the
dark-mode legacy precedent — the new names carry the no-persist
semantic explicitly. Recommend this naming as the going-forward
convention if any future spec adds a similar persisted-preference slot
on the store.

The implementation is now a faithful and complete execution of §0–§11.

## Handoff
next_agent: NONE
prompt: Architectural drift re-review complete (post fix-pass). 0 Critical,
  0 Should-fix, 1 Nit (N2 memoize id-to-group map — deferrable). All three
  prior Should-fix items (S1 cross-group keyboard reorder, S2 `H` shortcut,
  S3 hydrator/setter split) and one prior Nit (N1 useDroppable swap) are
  RESOLVED. Fix-pass introduced no new architectural drift. Spec 008 is
  contract-complete from an architecture standpoint; release-coordinator
  can re-evaluate SHIP_READY against the updated reviewer file set.
payload_paths:
  - specs/008-sidebar-layout-customization/reviews/backend-architect.md
