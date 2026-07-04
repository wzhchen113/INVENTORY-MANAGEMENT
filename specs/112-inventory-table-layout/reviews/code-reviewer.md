# Code review for spec 112

Scope: frontend-only per OQ-8 (zero backend surface). Reviewed all six files
under `## Files changed`: `src/screens/cmd/lib/itemMoney.ts` (new),
`src/components/cmd/InventoryTable.tsx` (new), `src/screens/cmd/InventoryDesktopLayout.tsx`
(rewritten `per-store` branch + AC-7 post-impl fix), `src/i18n/{en,es,zh-CN}.json`,
and the three new test files. Cross-checked the ★ single-cost invariant against
every `currentStock * ... costPerUnit` / `.toFixed(2)`-with-`$` hit in `src/`,
confirmed `db.ts` untouched, confirmed no direct Supabase calls, confirmed no
inline color literals, confirmed `Platform.OS` gating on the Esc listener, and
traced every `setSelectedName` call site (11 total) to verify the ephemeral-
selection lifecycle.

### Critical

None. The ★ single-cost invariant holds: `itemMoney.ts` is the only module
that computes `currentStock * costPerUnit * subUnitSize` or formats a
`$X.XX`/`$X` cost string in the changed file set, and both `InventoryTable.tsx`
cells and the `DetailPane` header (`InventoryDesktopLayout.tsx:613,616,617,625`)
call the same four exports. No direct `supabase.from/rpc` calls, no color
literals, no legacy-file edits, no slug change, no `window`/`document` access
outside the `Platform.OS === 'web'`-gated Esc listener.

### Should-fix

- `src/screens/cmd/InventoryDesktopLayout.tsx:180-182` — the new store-switch
  effect clears `selectedName` unconditionally, regardless of `viewMode`. AC-8b
  scopes this to the `per-store` (items.tsv) branch, and AC-8 requires
  `catalog.tsv`'s own selection behavior to stay "exactly as today." Because
  `InventoryCatalogMode` shares the same `selectedName`/`setSelectedName` state
  (`:344-345`) and has its own auto-select-first effect
  (`InventoryCatalogMode.tsx:189-192`) keyed on brand-wide (not per-store)
  `filtered` data, a store switch while on the `catalog.tsv` tab now clears the
  selection and that component's own effect immediately re-selects
  `filtered[0]` on the next render — i.e. catalog.tsv's open detail silently
  jumps to a different (the first) catalog row on a store switch, a behavior
  it didn't have before this spec and that isn't mentioned in AC-8's "unchanged"
  contract or covered by the case-8 boundary test (which doesn't touch
  `currentStore.id`). Scope the effect: `if (viewMode === 'per-store')
  setSelectedName(null);` (with `viewMode` added to the dependency array), or
  gate on `section === 'Inventory' && viewMode === 'per-store'` to match the
  existing section-leave effect's style at `:137-139`.

### Nits

- `src/screens/cmd/InventoryDesktopLayout.tsx:406` — `onLayout` on the outer
  row sets `chromeW` from `windowWidth - e.nativeEvent.layout.width` with no
  floor. If the outer row's measured width transiently exceeds `windowWidth`
  by a frame (a plausible race during a rapid resize, before the row's own
  flex layout has caught up to the new window size), `chromeW` goes negative
  for that frame, and the `tableWidth` computation would over-estimate the
  available width and briefly show more columns than actually fit before the
  next `onLayout` self-corrects. The final `tableWidth` already floors at 320
  (`:232-235`) but that floor doesn't protect against `chromeW` itself being
  wrong-signed. A `Math.max(0, windowWidth - e.nativeEvent.layout.width)` at
  the `setChromeW` call site would close this one-frame edge case for free.
  Not blocking — self-correcting within a render, and the spec explicitly
  treats "acceptable for v1" tolerances on this fix.
- `src/screens/cmd/InventoryDesktopLayout.tsx:134` / `:225-235` — the code
  comment above `chromeW`'s declaration and the one above `tableWidth` both
  re-explain the same onLayout-doesn't-refire rationale nearly verbatim (once
  at the `useState` declaration, once at the derived-value computation, plus a
  third restatement in the inline JSX comment at `:399-403`). Three copies of
  the same paragraph in one file is more redundant than the "why" comments
  elsewhere in this codebase tend to be; one of the three could point at the
  others ("see chromeW above") instead of re-deriving the full explanation.
  (out-of-scope) — pre-dates this spec's touch of the file in the sense that
  the file already carries a lot of block-comment context (e.g. the Props /
  section-dispatch header at `:55-67`); not something to fix as part of 112,
  just a pattern to watch if this file keeps growing per the CLAUDE.md
  cleanup-backlog note on section file-splits.
- `src/screens/cmd/lib/itemMoney.ts:39,47` — `stockValue`/`formatStockValue`
  both declare the same `Pick<ItemMoneyFields, 'currentStock' | 'costPerUnit' |
  'subUnitSize'>` parameter type inline rather than as a named type alias. Two
  call sites today; harmless, but if a fifth money helper lands later a
  `type StockValueInput = Pick<...>` would read slightly cleaner. Not worth
  doing for the current three-function surface.
- `src/components/cmd/InventoryTable.tsx:80-89` — `COL_STYLE` is a
  `Record<ColumnId, {...}>` with per-column fixed pixel widths (e.g.
  `onHand: { width: 200 }`) that aren't derived from anything and have no
  comment on how they were chosen (vs. the tier-boundary constants, which are
  well-justified against the design note's table). Cosmetic; the browser
  verification in the spec's post-impl note confirms these render acceptably
  today, so this is a "would appreciate a one-line provenance comment," not a
  defect.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **Should-fix 1 (store-switch clear fires on the catalog tab) — FIXED.** The
  AC-8b effect in InventoryDesktopLayout.tsx is now scoped to the per-store
  tab via a `viewModeRef` read inside the effect (deps stay `[currentStore.id]`
  so tab flips don't re-run it). New jest pin: select on items.tsv → flip to
  catalog.tsv → switch stores there → flip back → the selection SURVIVED (the
  pre-fix unscoped clear would have killed it); the existing case-5 pin
  (per-store switch closes the pane) still passes, and the per-store path was
  re-verified live in the browser (pane open → store switch → pane closed,
  landed on towson).
- **Nit (chromeW one-frame sign edge) — FIXED.** `setChromeW(Math.max(0, …))`.
- **Other nits (comment repetition, stylistic) — LEFT** per their own
  out-of-scope framing.

Also from the test-engineer review: AC-10 + AC-11 suites added (see its
Resolution). Post-fix gates: jest 999/999 (90 suites), both typechecks exit 0.
