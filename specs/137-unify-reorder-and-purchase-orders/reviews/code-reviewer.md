## Code review for spec 137

Scope: frontend-only Cmd-UI navigation/handoff unification of Reorder + Purchase
Orders into one "Ordering" destination. Reviewed for craftsmanship only —
architecture/drift and security are covered by other reviewers.

### Critical
None.

### Should-fix
- `src/lib/orderingHandoff.ts` + `src/screens/cmd/sections/POsSection.tsx:113-127`
  — the one-shot handoff signal (`pendingPoId`) is a global Zustand singleton
  with no cleanup path if the consuming component never mounts. `handlePoCreated`
  (`OrderingSection.tsx:31-34`) sets `pendingPoId` and flips `activeTab`; in the
  overwhelmingly common case `POsSection` mounts on the very next render and
  `consume()`s it immediately. But there is no guard against the (narrow, but
  real) case where the shell itself unmounts — the operator navigates to a
  different sidebar destination — in the gap between `requestPoSelect` and
  `POsSection`'s effect running. In that case `pendingPoId` is left armed
  indefinitely, and the *next* time `POsSection` mounts (a manual visit, possibly
  much later or after a store switch), it silently preselects a stale PO id
  instead of doing nothing. This directly touches the "no leak" requirement
  called out for this spec. Suggested fix: consume/clear the signal in a cleanup
  effect on `OrderingSection` unmount (`useEffect(() => () =>
  useOrderingHandoff.getState().consume(), [])`), or have the `POsSection` effect
  validate the pending id still belongs to `currentStore` before honoring it.

### Nits
- `src/screens/cmd/sections/ReorderSection.tsx:1371-1712` — the new
  `OnPoCreatedContext.Provider` wraps the entire existing return block, but the
  ~340-line subtree wasn't re-indented (the `Provider` and the `View
  testID="reorder-root"` sit at the same indent level, and the two closing tags
  at the end are similarly flush). Harmless today, but it means the file's
  indentation no longer reflects real JSX nesting depth, which will read oddly
  for the next person scanning this file. Consider re-indenting the block in a
  follow-up formatting pass.
- `src/screens/cmd/sections/__tests__/OrderingSection.test.tsx:67-85` — the
  `TabStrip` mock hardcodes `testID: 'tabstrip'` on the wrapping `View`, so when
  both `OrderingSection`'s own `TabStrip` and the active section's internal
  `TabStrip` are mounted simultaneously, two nodes share that testID. No test in
  this file queries `getByTestId('tabstrip')` so it doesn't currently break
  anything, but it's a latent trap for whoever adds an assertion against it
  later. Trivial fix: key it off `tabs[0]?.id` or drop the testID from the mock
  wrapper entirely since it's unused.
- (out-of-scope) `src/i18n/es.json:17` — `"ordering": "Pedidos"` reads close
  enough to "orders" that it could be confused with `purchaseOrders`
  ("Órdenes de compra") for a Spanish-reading manager scanning the sidebar. The
  spec itself already flags the es/zh-CN strings as "a starting translation —
  confirm with the owner," so this is a product/i18n call, not a code defect;
  noting it here only so it doesn't get lost.

### What checked out clean
- Design fidelity: `OrderingSection.tsx`, `orderingHandoff.ts`, the sidebar item
  rename, the `InventoryDesktopLayout` dispatch swap, the `EODCountSection:750`
  string fix, the palette `SCREEN_ENTRIES_DEFS` three-entry alias scheme, and the
  `sidebarLayout.ts` remap helper all match the spec's `## Backend design`
  section precisely, including the exact wiring points cited (ResponsiveCmdShell
  `:98`/`:151`/`:164`/`:191` equivalents).
- Inert seams verified: `ReorderSection`'s `onPoCreated` prop defaults to
  `undefined` via a module-local `OnPoCreatedContext` (default value
  `undefined`), and every existing `ReorderSection.*` suite calls
  `render(<ReorderSection />)` with no props — the context param and the
  `= {}` destructure default (matching the existing `POHistoryTab` convention in
  the same file) make standalone rendering a true no-op. `POsSection`'s signal
  subscription reads `null` when `useOrderingHandoff` was never armed, so its own
  suite is equally unaffected. Grepped the repo for any leftover
  `section === 'Reorder'` / `'PurchaseOrders'` dispatch branches or hardcoded
  `nav-Reorder`/`nav-PurchaseOrders` references outside the e2e fixtures that
  were explicitly updated — none found.
- One-shot signal semantics: `POsSection`'s effect at
  `POsSection.tsx:122-127` guards on `if (!pendingPoId) return;`, is placed after
  the pre-existing auto-select effect (so both settle deterministically per the
  spec's reasoning), and calls `consume()` synchronously inside the effect body
  so a second render with the same `pendingPoId` value can't re-fire (dependency
  array is `[pendingPoId]`, and consume resets it to `null`).
- Override remap: `remapLegacySidebarOverrideIds` (`sidebarLayout.ts:82-97`) is
  pure (no React/DOM), dedupes deterministically by first-occurrence using a
  `Set`, passes non-legacy ids and null/empty input through unchanged, and is
  wired through exactly one normalization point in `ResponsiveCmdShell.tsx`
  (`useMemo` at the raw-override selector) so every downstream
  `applySidebarOverride` call — the render merge and both edit-mode seeds —
  consumes the same remapped value. Test coverage in
  `OrderingSection.test.tsx:293-346` exercises both single-id remap, dedupe of
  both legacy ids, pass-through of unrelated ids, null/empty inputs, and the
  full `applySidebarOverride` integration.
- Palette aliasing: the three `SCREEN_ENTRIES_DEFS` entries routing to
  `'Ordering'` (`cmdSelectors.ts:178-180`) get distinct `id`s via the `alias`
  discriminator (`screen:Ordering`, `screen:Ordering:reorder`,
  `screen:Ordering:pos`) — no id/key collision, and `PaletteEntry.id` isn't
  parsed anywhere downstream (only used as a list key), so the compound id shape
  is safe.
- i18n: `sidebar.items.ordering` is present at the correct JSON path
  (`sidebar.items.*`, alongside the existing `reorder`/`purchaseOrders` siblings)
  in all three catalogs (`en.json:17`, `es.json:17`, `zh-CN.json:17`).
- Dead code: no leftover imports, branches, or comments referencing the removed
  `Reorder`/`PurchaseOrders` sidebar item ids or the old two-branch dispatch
  in `InventoryDesktopLayout.tsx`; the two imports were correctly moved into
  `OrderingSection.tsx`.
- No direct Supabase calls, no inline color literals (both new files route
  through `useCmdColors()`), no `window`/`Alert.alert` bypass of
  `confirmAction`, no new realtime channels, and the new jest suite
  (`OrderingSection.test.tsx`) follows the existing per-section suite's mocking
  conventions (colors/T/confirmAction/toast/store) rather than inventing a new
  pattern.
