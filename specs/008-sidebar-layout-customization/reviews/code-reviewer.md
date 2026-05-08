## Code review for spec 008 (fix-pass re-review)

Prior review had 0 Critical, 5 Should-fix, 3 Nits.
Fix-pass closed items #1–#3. Items #4–#5 and all Nits were explicitly deferred
to a follow-up chore PR per the release-proposal — those are not re-flagged.

---

### Status of prior findings

| # | Finding | Status |
|---|---------|--------|
| S1 | Redundant DB write on login-restore (`setSidebarLayoutOverride` split) | **RESOLVED** — `hydrateSidebarLayoutOverride` added, `App.tsx:166` calls hydrator |
| S2 | `EmptyGroupDropZone` misuses `useSortable` outside `SortableContext` | **RESOLVED** — switched to `useDroppable`; no transform/transition props |
| S3 | Duplicate shape-validation: `coerceSidebarLayout` weaker than `isValidOverride` | **RESOLVED** — `auth.ts` now imports and delegates to `isValidOverride` |
| S4 | `SidebarGroup` duplicated instead of imported from `src/types/index.ts` | Deferred (per release-proposal) |
| S5 | Unnecessary `as any` / intersection casts on `TreeItem.hiddenByUser` | Deferred (per release-proposal); both casts still present at `InventoryDesktopLayout.tsx:250` and `sidebarLayout.ts:186` |
| N1–N3 | Nits (cross-ref comment, unused import, screen-reader format) | Deferred (per release-proposal) |

---

### Critical

None.

---

### Should-fix

- `src/components/cmd/SidebarEditMode.tsx:178-190` — **`H` shortcut has no `INPUT`/`TEXTAREA`/`contenteditable` guard.** The handler correctly requires `closest('[data-sidebar-item-id]')` to find an item, which protects against `H` firing outside the edit-mode tree. However, if focus is on the `TouchableOpacity` eye-toggle button (which is inside a `[data-sidebar-item-id]` div), `closest` walks up and finds the row's id, so pressing `H` while the eye-toggle button is keyboard-focused would fire a hide-toggle — not the `H` key's intended UX (the intent is spatial reorder context, not button-focused). Additionally, the guard does not check whether the focused element is a text input (`INPUT`, `TEXTAREA`, or `[contenteditable]`); if any such element is ever nested inside a sortable row in the future, `H` would be silently swallowed. Add `if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || (target as HTMLElement)?.isContentEditable) return;` before the `closest` walk. No text inputs exist in this tree today, but the eye-toggle focus case is live.

---

### Nits

- `src/components/cmd/SidebarEditMode.tsx:113` — `droppableContainers.get(active.id)` retrieves the droppable registered under the active sortable's id. In dnd-kit `useSortable` registers the node as both draggable and droppable with the same id, so this works. The comment above only mentions "prefer the data attached at `useSortable()` time", which is accurate, but it's subtle enough that a reader unfamiliar with dnd-kit internals might think this is a coincidence. A one-line note — `// useSortable registers item.id as both draggable + droppable; data.current carries the groupLabel we attached at SortableRow` — would clarify the intent.

- `src/components/cmd/SidebarEditMode.tsx:152` — `event.preventDefault()` is called only after the `targetRect` guard succeeds (line 150). This means if the target group exists but its droppable rect is not yet measured (e.g. component just mounted or the empty-group `useDroppable` id hasn't registered), the arrow key is not suppressed and falls through to default browser scroll. Functionally this is a no-op miss rather than a bug — dnd-kit keyboard navigation won't move and the browser scrolls. Low-impact but the comment on line 155 implies `preventDefault` is always called on ←/→; it should note the rect-guard condition.

- `src/lib/auth.ts:29-31` — `coerceSidebarLayout` is now a one-liner that delegates entirely to `isValidOverride`. That's correct. The JSDoc above it (lines 21-28) is still longer than the function body. This is fine documentation-wise but the comment repeats things already stated in `isValidOverride`'s own JSDoc in `sidebarLayout.ts`. Not a bug; just slightly over-documented for what is now a trivial wrapper.
