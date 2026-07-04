# Code review for spec 110

Scope reviewed: `supabase/migrations/20260706000000_store_count_layouts.sql`,
`src/lib/db.ts` (§6 helpers), `src/screens/staff/lib/countLayouts.ts`,
`supabase/tests/store_count_layouts.test.sql`,
`src/lib/db.storeCountLayouts.test.ts`,
`src/screens/cmd/sections/InventoryCountSection.tsx`,
`src/screens/staff/screens/WeeklyCount.tsx`,
`src/components/cmd/CountLayoutNameModal.tsx`, `src/store/useStore.ts`, the six
i18n catalogs, and the three new/updated test files. Cross-checked every claim
in the spec's "Files changed" section against the actual code rather than
taking it at face value (migration version collision, dead-key claims,
permissive-policy-lint auto-scan, drag/filter interaction, RLS-before-unique
ordering in the pgTAP suite, testMatch glob coverage).

Overall this is a clean, disciplined implementation. Both the SECURITY
DEFINER RPCs and the RLS write policies gate identically
(`auth_is_privileged() AND auth_can_see_store()`), the 3-cap is genuinely
atomic via the advisory lock, the staff carve-out is read-only with no write
helper anywhere reachable, the rename is byte-identical across all three
locales in both catalogs, and the two "Save" buttons are visually/texually
distinct as the spec required. No Critical findings.

### Critical

None.

### Should-fix

- `src/screens/cmd/sections/InventoryCountSection.tsx:1710-1730` (drag list
  gating) + `:436-439` (`onReorder`) — dragging while a **category chip**
  other than "All" is selected silently narrows what gets persisted. The drag
  list only disables itself when a **search** is active
  (`search.trim() ? ... : <CountOrderDragList items={customVisibleItems} onReorder={onReorder} .../>`
  at line ~1721), but `customVisibleItems` is already category-filtered
  (`applyCountOrder(filteredItems, savedIds, ...)`, line 288, where
  `filteredItems` is category+search narrowed, line 263-270). `onReorder`
  replaces `savedIds` wholesale with whatever ids were visible at drag time
  (line 436-437: `setSavedIds(orderedIds)`). If an admin selects a category
  chip, drags within it, and presses Save (`persistLayout`, line 445 —
  `const ids = savedIds ?? [...]`), the persisted `item_ids` for the
  **store-shared** layout permanently omits every item outside that category
  — there is no unranked-tail self-heal on the *server* row the way there was
  cosmetically on re-render in spec 103 (`applyCountOrder`'s pass-2 only
  patches the render, not what `persistLayout` sends). This interaction is
  not new to spec 110 (the category-filter/drag wiring predates this spec),
  but spec 110 raises the stakes: what was previously a private, per-user,
  auto-saved view preference is now an explicit, store-wide, shared artifact
  that every counter (admin and staff) will pick and count against. Neither
  the new pgTAP suite nor the new jest suites (`InventoryCountSection.layouts.test.tsx`)
  exercise a category-filtered Save, so this looks like an oversight rather
  than an accepted tradeoff. Suggested fix: either (a) disable/hide the drag
  list whenever `selectedCategory !== 'all'` (matching the existing
  search-active guard), or (b) have `onReorder` merge the dragged subset's new
  relative order back into the FULL `savedIds` array (splice the visible ids
  back into their positions) rather than replacing it wholesale, or (c) at minimum
  have `persistLayout` warn/toast when `layouts.length` of the item set about to
  be saved is smaller than `storeInventory.length` and a category filter is active.

- `src/screens/cmd/sections/InventoryCountSection.tsx:462-471` (`persistLayout`
  failure path) — `const prevLayouts = layouts;` followed by
  `setLayouts(prevLayouts)` on a falsy `savedId` is a no-op revert: `layouts`
  was never optimistically mutated before the `await saveStoreCountLayout(...)`
  call, so this line sets the state to the same value it already holds. The
  comment above it ("nothing to revert (we hadn't optimistically mutated the
  list yet") correctly documents this, so it isn't a functional bug, but the
  dead `setLayouts(prevLayouts)` call is confusing self-contradictory code —
  the comment says "nothing to revert" immediately followed by a revert call.
  Either drop the no-op `setLayouts(prevLayouts)` line (the comment already
  explains why it's unnecessary) or remove the misleading half of the comment.
  This is Should-fix rather than a Nit because a future edit that DOES add an
  optimistic mutation to this function is likely to leave the now-load-bearing
  revert line unexamined, given the comment currently asserts it does nothing.

### Nits

- `src/i18n/en.json:198,205-208` (and the `es.json`/`zh-CN.json` mirrors at the
  same keys) — `section.countLayout.nameRequired`, `saveFailed`,
  `renameFailed`, `deleteFailed`, and `loadFailed` are defined in all three
  admin-catalog locales but never referenced by any component — the section
  delegates all layout-action failures to the generic `notifyBackendError`
  toast (`src/store/useStore.ts:1984-2023`) instead of these dedicated
  strings. Same for the staff catalog's `weekly.layout.loadFailed`
  (`src/screens/staff/i18n/en.json:239` + es/zh-CN mirrors) — the staff screen
  also calls `notifyBackendError('fetchStoreCountLayouts', err)` directly
  (`WeeklyCount.tsx:337`) rather than this key. Harmless dead i18n (AC-12 asks
  for strings "in the catalog(s) that actually render them"), but five keys
  across three locales (fifteen dead string entries total) is worth trimming
  or wiring in a follow-up pass rather than carrying dead translations
  indefinitely.

- `src/screens/cmd/sections/InventoryCountSection.tsx:494-499` vs `:503-510`
  (`onSaveLayout` vs `onSaveAsNew`) — both callbacks independently repeat the
  identical `if (layouts.length >= MAX_LAYOUTS) { Toast.show(...); return; }`
  cap-check block, byte-for-byte. Small (4 lines), but a shared
  `blockIfAtCap()` helper would remove the duplication and guarantee the two
  paths can't drift on the toast copy or the threshold check in a future edit.
  (out-of-scope) not asking for a refactor beyond this spec's files — just
  noting it since both call sites are new code from this same PR.

- `supabase/migrations/20260706000000_store_count_layouts.sql:290-291,350-351,398-399`
  — the three `revoke execute ... from public, anon;` / `grant execute ... to
  authenticated;` pairs are copy-pasted three times with only the function
  signature changing. Consistent with the existing single-function-per-block
  convention elsewhere in the codebase (not a deviation), just noting the
  repetition for awareness — no action needed given the codebase's established
  per-RPC grant-block style.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **Should-fix 1 (category-filtered drag narrows the persisted layout) —
  FIXED via option (a).** The Custom-view drag list now disables itself when
  `selectedCategory !== 'all'`, exactly matching the existing search guard
  (static rows render instead), with the rationale in the comment at the gate.
  Covers BOTH platform affordances (the web @dnd-kit list and the native ▲/▼
  movers sit behind the same conditional). New jest pin drives the native
  branch (movers appear in Custom, vanish under a category chip, return on
  All); browser-verified on the web branch live: 143 drag handles → 0 with a
  chip active → 143 on All.
- **Should-fix 2 (no-op revert in persistLayout) — FIXED.** The dead
  `setLayouts(prevLayouts)` line and the `prevLayouts` capture are removed;
  the comment now states plainly that nothing is optimistically mutated on
  this path. (`layouts` also dropped from the useCallback deps.) The rename
  path's REAL optimistic revert is untouched.
- **Nit 1 (15 dead i18n entries) — FIXED.** `section.countLayout.{nameRequired,
  saveFailed,renameFailed,deleteFailed,loadFailed}` removed ×3 admin locales;
  `weekly.layout.loadFailed` removed ×3 staff locales. Verified unreferenced
  first (the one grep hit was spec-106's separate `weekly.draft.saveFailed`).
- **Nit 2 (duplicated cap check) — FIXED.** Shared `blockIfAtCap()` helper;
  both create paths call it.
- **Nit 3 (per-RPC grant-block repetition) — NO ACTION**, per the reviewer's
  own note (established house style).

Also from the parallel reviews: test-engineer's two minors landed — a
"Save as new" press-test (creates with layoutId null even while another layout
is selected) and the modal backdrop's hardcoded `accessibilityLabel="Close"`
now uses the existing `common.close` key (translated in all three locales).

Post-fix gates: jest 950/950 (85 suites, +2), both typechecks exit 0, pgTAP
63/63 files (layouts file 30/30). Browser-verified after the fixes: create →
pill, category-chip drag gate, delete (privileged path through the reordered
RPC gates). No layout rows left behind.
