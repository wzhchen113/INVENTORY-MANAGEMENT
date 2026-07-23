# Spec 137: Unify Reorder and Purchase Orders into one "Ordering" destination

Status: READY_FOR_REVIEW

## PM recommendation (read first)

The owner proposed merging Reorder and Purchase Orders because "it's technically
the same thing." My assessment: they are two consecutive steps of ONE workflow
(plan tomorrow's order → send/manage/receive it), but they are NOT the same
thing and should NOT be literally merged into one section/model:

- **Different data shapes.** Reorder is an ephemeral computed view (RPC
  `report_reorder_list`; nothing persisted except the derived `hasPo` flag).
  Purchase Orders is a stateful ledger — persisted `purchase_orders` rows with a
  5-state machine (draft/sent/partial/received/cancelled), a line editor,
  receiving with price-on-receipt, and history.
- **Different moments/users.** Reorder = evening planning off EOD counts.
  Purchase Orders = send-management + delivery-day receiving. The codebase
  already split **Receiving** into its own third section, and that split is not
  confusing — plan → order → receive are naturally distinct moments.
- **Architecture cost.** Each Cmd section is one file. `ReorderSection.tsx`
  ≈ 1,700 lines, `POsSection.tsx` ≈ 810. A literal merge is a ~2,500-line
  mega-section, against the existing cleanup-backlog goal of splitting sections.

**Recommended direction (accepted by owner):** a single **"Ordering"** sidebar
destination that mounts the two EXISTING section components (`ReorderSection`,
`POsSection`) unchanged, as two tabs (Reorder landing tab + Purchase orders),
PLUS a deep-link so `+ CREATE PO` auto-switches to the Purchase-orders tab with
the just-created draft already selected. This delivers the "it's one thing"
mental model and removes the real friction (today the user manually switches
sections and re-finds the draft after `+ CREATE PO`) WITHOUT a mega-file
rewrite, WITHOUT disturbing either lifecycle, and WITHOUT invalidating the two
per-section jest suites (they render each section standalone).

Full merge is rejected. Receiving is out of scope (owner asked only about
Reorder + PO).

## User story
As a store manager doing my evening ordering, I want Reorder and Purchase Orders
to live under one "Ordering" destination — and I want "Create PO" to drop me
straight onto the new draft — so I stop bouncing between two sidebar items and
hunting for the draft I just created.

## Acceptance criteria
- [ ] A single **"Ordering"** sidebar item (in the PLANNING group) replaces the
      separate `Reorder` and `PurchaseOrders` sidebar items. Selecting it opens a
      tabbed surface with two tabs: **Reorder** and **Purchase orders**.
- [ ] The surface defaults to the **Reorder** tab on open.
- [ ] The Reorder tab renders `ReorderSection` and the Purchase-orders tab
      renders `POsSection` — both mounted as-is; no per-section behavior change
      (all existing testIDs and flows continue to work). Switching tabs shows the
      corresponding section content with no loss of current behavior.
- [ ] Pressing `+ CREATE PO` on a Reorder vendor card, on `createPoDraft`
      success, (a) switches the active tab to **Purchase orders** AND (b) selects
      the newly-created draft PO (the returned `poId`) in the list pane, so its
      detail is shown without a manual click.
- [ ] The manual path still works: the user can switch to the Purchase-orders
      tab and select any PO from the list pane by hand, independent of the
      deep-link.
- [ ] The spec-123 duplicate-prevention behavior is preserved: after a PO exists
      for (store, vendor, reorder date), the Reorder card still shows the
      disabled "PO CREATED" chip.
- [ ] **Sidebar-override fallback:** a user with a saved sidebar override
      (spec-008) referencing the old `Reorder` and/or `PurchaseOrders` ids lands
      on the new "Ordering" destination — no dead/dangling sidebar entry, no
      crash, no lost access to either surface. (Mechanism — id remap vs. merge —
      is the architect's to specify.)
- [ ] The existing per-section jest suites (`ReorderSection.test.tsx`,
      `ReorderSectionCases.test.tsx`, `ReorderSection.spec123/130/135.test.tsx`,
      `POsSection.test.tsx`) continue to pass **unchanged**.
- [ ] A new jest test asserts: (1) the "Ordering" shell renders both tabs and
      defaults to Reorder; (2) a simulated `createPoDraft` success routes to the
      Purchase-orders tab with the returned `poId` selected; (3) the
      sidebar-override fallback resolves an old-id override to the "Ordering"
      destination.

## In scope
- A tab shell (a new lightweight section wrapper reusing the existing `TabStrip`
  pattern already used inside `POsSection` and `ReorderSection`) that hosts
  `ReorderSection` and `POsSection` as tabs, defaulting to Reorder.
- Wiring `+ CREATE PO` success to (a) switch to the Purchase-orders tab and
  (b) preselect the new draft. The store already returns the new `poId` from
  `createPoDraft`; a cross-tab select signal is needed (candidate: the existing
  `usePaletteAction` request mechanism, or a small shared selected-PO signal).
- Sidebar registration change: one "Ordering" item in the PLANNING group,
  replacing the two current items; plus the saved-override fallback so old ids
  resolve to the new destination.
- Jest coverage for the shell, the deep-link routing, and the override fallback.

## Out of scope (explicitly)
- **Full data/model merge.** Reorder stays a computed view; POs stays a ledger.
  Rationale: different lifecycles; merging the models buys nothing and adds risk.
- **Merging the section files into one mega-component.** Rationale: fights the
  one-file-per-section architecture and the cleanup-backlog split goal.
- **Receiving.** Stays its own section in the OPERATIONS group. Rationale: owner
  asked only about Reorder + PO; plan → order → receive are distinct moments.
- **Changing PO lifecycle, receiving, share/quick-order, CSV/PDF, or reorder
  math.** This spec is navigation/handoff only.
- **A "today's draft POs" strip embedded inside the Reorder view.** Possible
  future additive enhancement; not needed to satisfy the owner's ask.
- **Any migration, RPC, or edge-function change.**

## Open questions resolved
- Q: Nav aggressiveness — one "Ordering" item with tabs, or keep two items plus a
  deep-link? → A: ONE "Ordering" sidebar item with two tabs. Include a
  sidebar-override id migration/fallback so saved custom layouts referencing the
  old spec-008 ids (`Reorder`, `PurchaseOrders`) still resolve.
- Q: Landing tab? → A: Reorder.
- Q: Name for the unified destination? → A: "Ordering".
- Q: Deep-link scope? → A: Yes — `+ CREATE PO` auto-switches to the
  Purchase-orders tab AND preselects the new draft; the manual path (tab switch +
  list click) stays available too.
- Q: Group placement? → A: Stays in the PLANNING sidebar group (confirmed).

## Dependencies
- `src/lib/cmdSelectors.ts` — sidebar group/item registry (`useDefaultSidebarGroups`); id remap/fallback for spec-008 overrides (`applySidebarOverride`).
- `src/screens/cmd/InventoryDesktopLayout.tsx` — section switch (currently `section === 'Reorder'` / `'PurchaseOrders'` branches, lines ~303-306).
- `src/screens/cmd/sections/ReorderSection.tsx`, `src/screens/cmd/sections/POsSection.tsx` — mounted unchanged as tab panels.
- `src/store/useStore.ts` — `createPoDraft` (returns new `poId`), `refreshPurchaseOrders`, `loadReorderSuggestions` (already chained on create).
- Cross-tab select signal — candidate: `src/lib/paletteAction.ts` (`usePaletteAction`) or a new small shared signal.
- Sidebar override merge — `applySidebarOverride` (spec 008).

## Project-specific notes
- Cmd UI section / legacy: Cmd UI — a new tab shell under `src/screens/cmd/`
  hosting the two existing `sections/` components. No legacy surface involved.
- Per-store or admin-global: per-store (both surfaces already scope to
  `currentStore.id`; no scope change).
- Realtime channels touched: none new. Both surfaces already refresh via
  `refreshPurchaseOrders` + `loadReorderSuggestions` and the `store-{id}` /
  `brand-{id}` realtime sync; unchanged.
- Migrations needed: no. (The sidebar-override fallback is client-side layout
  data, not a DB migration.)
- Edge functions touched: none.
- Web/native scope: admin Cmd shell (web-primary; native parity through the
  existing `ResponsiveCmdShell` / `MobileNavDrawer`). No web-only APIs added.
- Tests: jest track. New shell + deep-link + override-fallback test; existing
  per-section suites must stay green unchanged.

## Backend design

Frontend-only, Cmd-UI navigation/handoff change. Nothing in this spec crosses
the DB/RPC/edge/RLS boundary. The sections stay wired to their existing store
actions and realtime channels; the only new artifacts are a tab shell, a tiny
client-side handoff signal, a sidebar-item rename, and a client-side
override-id remap.

### Data model changes
**N/A.** No new tables, columns, indexes, or migrations. The sidebar-override
fallback is client-side layout JSON (`profiles.sidebar_layout`, spec 008), not a
schema change — self-heals on next save (see §Override fallback). No migration
filename is proposed and nothing is destructive.

### RLS impact
**N/A.** No new or changed store-scoped tables. Both surfaces already scope to
`currentStore.id` through `auth_can_see_store()` on the existing
`purchase_orders` / reorder-RPC paths; this spec does not touch scope, policies,
or helpers.

### API contract
**N/A.** No PostgREST view, no RPC, no request/response shapes. `createPoDraft`
(the only backend touch point in the flow) is UNCHANGED — it already awaits
`refreshPurchaseOrders()` before resolving with the new `poId`
(`src/store/useStore.ts:2788-2805`), so by the time the deep-link fires the new
draft is already present in `orderSubmissions`. No new error cases.

### Edge function changes
**N/A.** No function added or modified; no `verify_jwt` change; no service-token
work.

### `src/lib/db.ts` surface
**N/A.** No new db.ts helper. No frontend call site reaches Supabase directly —
the deep-link is pure client state (a Zustand signal), not a data fetch. No
snake_case→camelCase mapping added.

### Realtime impact
**None new.** Both surfaces already reload via `refreshPurchaseOrders` +
`loadReorderSuggestions` on the existing `store-{id}` / `brand-{id}` channels.
No `supabase_realtime` publication membership change → **no
`docker restart supabase_realtime_imr-inventory` step required.**

---

### Frontend design (the substance of this spec)

#### 1. The "Ordering" tab shell
New file **`src/screens/cmd/sections/OrderingSection.tsx`** — a peer of
`ReorderSection.tsx` / `POsSection.tsx` under `sections/`, NOT a chrome-level
shell. It is a thin wrapper that:

- owns local state `activeTab: 'reorder' | 'pos'`, initial **`'reorder'`**
  (landing tab per AC);
- renders `TabStrip` (`src/components/cmd/TabStrip.tsx`) with two tabs, reusing
  the existing convention verbatim:
  `tabs={[{ id: 'reorder', label: T('sidebar.items.reorder') },
  { id: 'pos', label: T('sidebar.items.purchaseOrders') }]}`,
  `activeId={activeTab}`, `onChange={setActiveTab}`. **No new i18n tab keys** —
  reuse the existing `sidebar.items.reorder` / `sidebar.items.purchaseOrders`
  labels so the tab text matches the palette/legacy labels across locales;
- renders the active section **conditionally** (mount only the active tab):
  `activeTab === 'reorder' ? <ReorderSection onPoCreated={handlePoCreated} /> :
  <POsSection />`.

Conditional render (unmount the inactive tab) is deliberate and correct: today
each section mounts fresh when navigated to, so remount-on-tab-switch reproduces
today's behavior exactly and satisfies "no loss of current behavior" (that AC
means *the section behaves as it does today*, not *transient UI state survives a
tab switch*). It also matches the one-section-at-a-time pattern in
`InventoryDesktopLayout`'s dispatch and keeps two ~1700/~810-line sections from
both being mounted at once.

**Both section files stay behaviorally UNCHANGED.** The only edits:
- `ReorderSection` gains ONE optional prop `onPoCreated?: (poId: string) => void`
  (the sanctioned "minimal prop for the deep-link"), threaded to the
  `CreatePoButton` and invoked inside the existing `createPoDraft(...).then((poId) => { if (poId) { ...toast...; onPoCreated?.(poId); } })`
  at `ReorderSection.tsx:259-269`. When `ReorderSection` is rendered standalone
  (its jest suites), the prop is `undefined` → no-op.
- `POsSection` gains ONE inert effect subscribing to the handoff signal (see §4).
  When rendered standalone the signal is `null` → no-op.

#### 2. Sidebar wiring
`src/lib/cmdSelectors.ts` `useDefaultSidebarGroups()` — in the PLANNING group
(lines 1096-1107) **replace the two items** `{ id: 'PurchaseOrders' }` (1099)
and `{ id: 'Reorder' }` (1105) with a **single** primary item placed first in
the group:
```
{ id: 'Ordering', label: T('sidebar.items.ordering') },
{ id: 'Vendors',  ... },
{ id: 'Recipes',  ... },
{ id: 'PrepRecipes', ... },
```

`src/screens/cmd/InventoryDesktopLayout.tsx` section dispatch (303-306) —
replace the two branches:
```
) : section === 'Reorder' ? ( <ReorderSection /> )
: section === 'PurchaseOrders' ? ( <POsSection /> )
```
with a single:
```
) : section === 'Ordering' ? ( <OrderingSection /> )
```
Remove the now-unused `ReorderSection` / `POsSection` imports from
`InventoryDesktopLayout` (lines 42-43); add `import OrderingSection from
'./sections/OrderingSection'`. (Those two imports move into `OrderingSection`.)

**i18n** — add ONE key `sidebar.items.ordering` to all three catalogs:
- `src/i18n/en.json`: `"ordering": "Ordering"`
- `src/i18n/es.json`: `"ordering": "Pedidos"`
- `src/i18n/zh-CN.json`: `"ordering": "订货"`

(Sanity-check the exact JSON path against the existing `reorder` /
`purchaseOrders` siblings in each catalog; `es`/`zh-CN` strings are a starting
translation — confirm with the owner if a house term already exists.)

**Required companion edit — cross-section deep-link in EODCountSection.**
`src/screens/cmd/sections/EODCountSection.tsx:748` fires
`usePaletteAction.getState().request({ section: 'Reorder', selectedName: null })`
after a successful EOD submit ("jump to the Reorder list it feeds"). Section
`'Reorder'` will no longer exist → it would hit the ComingSoon fallback. Change
the string to `section: 'Ordering'`. It lands on the Ordering destination's
default Reorder tab → identical UX, no behavior change. (This is a hard
requirement, not optional — flag for the developer.)

#### 3. Sidebar-override fallback (spec 008)
The item ids in `useDefaultSidebarGroups` are load-bearing for the spec-008
override merge (`applySidebarOverride`, `src/lib/sidebarLayout.ts`). A saved
override referencing the removed ids `Reorder` / `PurchaseOrders` would today be
*silently dropped* as stale (the merge only positions ids present in
`defaultGroups`; `produceOverride` drops unknown ids). Silent-drop already
avoids a dead/dangling entry or crash — but per AC we want an **active remap** so
a user who moved/hid the old items has that intent carried onto `Ordering`,
and both-present dedupes to one.

Add a pure helper to `src/lib/sidebarLayout.ts` (co-located with the other
override utils, no React/DOM, unit-testable):
```
const LEGACY_SIDEBAR_ID_ALIASES = { Reorder: 'Ordering', PurchaseOrders: 'Ordering' };
export function remapLegacySidebarOverrideIds(
  override: SidebarLayoutOverride | null | undefined,
): SidebarLayoutOverride | null | undefined
```
Behavior: map each entry's `id` through the alias table; **dedupe** by keeping
the FIRST occurrence of a resulting id (deterministic by array order — so
`[Reorder, PurchaseOrders]` collapses to a single `Ordering`); pass everything
else through untouched. Returns the input unchanged when empty/null.

**Exact remap point:** `src/screens/cmd/ResponsiveCmdShell.tsx:98`. Change the
raw selector to a memoized normalization so every downstream
`applySidebarOverride` call (render merge :151, and the three edit-mode seeds
:164 / :191) consumes the remapped value with no other edits:
```
const rawOverride = useStore((s) => s.sidebarLayoutOverride);
const sidebarLayoutOverride = React.useMemo(
  () => remapLegacySidebarOverrideIds(rawOverride ?? null), [rawOverride]);
```
**Self-heal:** once merged, the rendered groups contain `Ordering`, so the next
`produceOverride` (gear → DONE) writes `Ordering` back to
`profiles.sidebar_layout`. The remap then becomes a no-op for that user. No DB
migration; no data backfill.

#### 4. Cross-tab deep-link signal (`+ CREATE PO` → PO tab + preselect)
**Decision: a NEW small shared signal module, not `usePaletteAction`.**
`paletteAction.ts` is semantically the ⌘K/section-nav bridge (`section` +
`selectedName` + `eodFocusItemId`) and is already consumed by BOTH the shell and
`InventoryDesktopLayout`; overloading it with a PO id would entangle a PO-detail
concern with section routing and the shell's consume() timing. The precedent is
`paletteAction.ts` *itself* — a ~30-line dedicated Zustand signal. Mirror it.

New file **`src/lib/orderingHandoff.ts`**:
```
interface OrderingHandoffState {
  pendingPoId: string | null;
  requestPoSelect: (poId: string) => void;
  consume: () => void;
}
export const useOrderingHandoff = create<OrderingHandoffState>((set) => ({
  pendingPoId: null,
  requestPoSelect: (poId) => set({ pendingPoId: poId }),
  consume: () => set({ pendingPoId: null }),
}));
```
Payload shape: a single `poId` string. No section/tab data (the shell owns the
tab; see below).

**Wiring (shell is the orchestrator, no shell↔signal coupling):**
- `OrderingSection.handlePoCreated = (poId) => { setActiveTab('pos'); useOrderingHandoff.getState().requestPoSelect(poId); }`.
  The tab switch is plain shell state; the preselect is the signal. Both run
  synchronously inside ReorderSection's `.then` callback (which completes before
  React unmounts ReorderSection on the tab flip). `createPoDraft` already
  awaited `refreshPurchaseOrders()`, so `orderSubmissions` holds the draft when
  `POsSection` mounts on the `pos` tab.
- **`POsSection` seam = signal subscription** (least invasive of prop / store
  field / subscription — `POsSection` has no external selection prop today and
  its `selectedId` is internal with an auto-select effect at :107-110; a prop
  would fight that effect, a subscription is a clean one-shot). Add, placed
  AFTER the existing auto-select effect:
  ```
  const pendingPoId = useOrderingHandoff((s) => s.pendingPoId);
  React.useEffect(() => {
    if (!pendingPoId) return;
    setSelectedId(pendingPoId);
    useOrderingHandoff.getState().consume();
  }, [pendingPoId]);
  ```
  Ordering is deterministic: the new draft is the newest row, so the auto-select
  effect's `filtered[0]` typically equals `pendingPoId` anyway; when it doesn't
  (a newer PO arrived via realtime), the signal effect wins and the auto-select
  effect then sees `selectedId ∈ filtered` and no-ops. Both settle on `poId`.
- **Manual path** unaffected: with `pendingPoId === null` the effect never runs;
  the operator switches tabs and clicks any PO row as today.
- **Spec-123 "PO CREATED" chip** unaffected — it derives from `hasPo` on the
  reorder refresh, which `createPoDraft` still triggers.

#### 5. Palette / testID rulings
**`nav-Reorder` / `nav-PurchaseOrders` testIDs.** These are auto-derived by
`TreeGroup.tsx:133` as `nav-${item.id}`. Removing the two items removes those
two testIDs; the sidebar now emits **`nav-Ordering`**. Ruling: `nav-Reorder` and
`nav-PurchaseOrders` cease to exist as sidebar testIDs — both surfaces are
reached via `nav-Ordering` then a tab. This is correct and intended. **Risk /
out-of-jest-scope follow-up:** the Playwright e2e track references the old ids —
`e2e/fixtures/constants.ts:116` (`reorder: 'nav-Reorder'`) and
`e2e/reorder.spec.ts` navigate via `getByTestId('nav-Reorder')`. Those e2e
specs WILL fail on the next e2e run. They are NOT part of the jest CI gate
(`test.yml`), so they don't block this spec, but the developer should update the
e2e nav path to `nav-Ordering` + a Reorder-tab click. To make the tabs
clickable from e2e, `OrderingSection` should give its tabs stable testIDs
(`ordering-tab-reorder` / `ordering-tab-pos`); `TabStrip.Tab` has no `testID`
field today, so that needs a small additive optional `testID?: string` on the
`Tab` type + passthrough. Treat the e2e update + `TabStrip.testID` as a scoped
follow-up, surfaced here rather than silently expanded.

**Go-to-anything palette entries.** `SCREEN_ENTRIES_DEFS` in `cmdSelectors.ts`
(172, 177) currently has `PurchaseOrders` and `Reorder` routing to those section
strings — both would break (ComingSoon) once the sections are renamed. Replace
with **three** entries that all route to `'Ordering'`, keeping the two legacy
labels so ⌘K search still matches "reorder" and "purchase orders" (the palette
filter matches on `label` only):
```
{ name: 'Ordering', labelKey: 'sidebar.items.ordering' },
{ name: 'Ordering', labelKey: 'sidebar.items.reorder',        alias: 'reorder' },
{ name: 'Ordering', labelKey: 'sidebar.items.purchaseOrders', alias: 'pos' },
```
Extend the def to carry an optional `alias` used ONLY to disambiguate the built
`id` (`screen:${name}` → `screen:${name}:${alias}` when present) so the three
entries don't collide on id/React key. `route` stays `{ name: 'Ordering' }` for
all three → each opens the Ordering destination on its default Reorder tab.
(Optional, not required: deep-linking the "Purchase orders" palette entry
straight to the PO tab would need a `route.params` tab hint carried through
`paletteAction` + read by the shell — deferred; landing on Ordering satisfies
the ask, and the PO tab is one click away.)

#### 6. Frontend store impact
No new slice in `src/store/useStore.ts`; `createPoDraft` /
`refreshPurchaseOrders` / `loadReorderSuggestions` are used as-is. No new
optimistic-then-revert path (no new write). The only new "state" is the
`orderingHandoff` signal (its own module, not `useStore`) and the local
`activeTab` in `OrderingSection`. `notifyBackendError` is untouched — errors
still surface from the unchanged `createPoDraft`.

#### 7. Jest approach
New test **`src/screens/cmd/sections/__tests__/OrderingSection.test.tsx`**:
1. **Shell render + landing tab** — render `<OrderingSection />`; assert both tab
   labels present and the Reorder tab is active on mount (a `ReorderSection`
   testID visible, e.g. a `reorder-*` node; no `POsSection`-only node). Mock the
   store slices the two sections read, same as the existing per-section suites.
2. **Deep-link create → switch → preselect** — mock `useStore.createPoDraft` to
   resolve `'po-123'` and seed `orderSubmissions` with a draft row `id:'po-123'`
   for the current store (so `POsSection`'s `filtered` contains it after the tab
   flip). Mirror the existing ReorderSection create-PO harness for the
   `confirmAction`/`window.confirm` auto-confirm (jsdom `window.confirm` returns
   false by default — reuse the mock the `ReorderSection.spec123` suite uses).
   Press `reorder-create-po-<vendorId>`; after the promise resolves, assert the
   `pos` tab is active AND `POsSection` shows `po-123` as selected. Note:
   because the real `createPoDraft` awaits `refreshPurchaseOrders`, the mock must
   land the draft in `orderSubmissions` before resolving.
3. **Override remap** — pure unit test of `remapLegacySidebarOverrideIds`:
   `{v:1,items:[{id:'Reorder',group:'Operations'}]}` →
   `{v:1,items:[{id:'Ordering',group:'Operations'}]}`; both legacy ids present →
   a single `Ordering`; then `applySidebarOverride(defaultGroups, remapped)`
   places `Ordering` per the override. (Can live in the shell test or the
   existing `sidebarLayout` test file.)

**Existing suites stay green unchanged** — confirmed: `ReorderSection.*` and
`POsSection.test.tsx` render the section components DIRECTLY
(`render(<ReorderSection />)` / `render(<POsSection />)`,
`src/screens/cmd/sections/__tests__/`), never via the shell. The
`onPoCreated` prop defaults `undefined` and the `orderingHandoff` subscription
reads `null`, so both edits are inert standalone. No existing test asserts on the
absence of the prop or on the module's import list.

### Risks and tradeoffs
- **Migration ordering:** none — no SQL.
- **RLS gaps:** none — no policy surface.
- **Seed/perf (286 KB dataset):** neutral — same two sections, one mounted at a
  time; conditional render avoids mounting both simultaneously. No new query.
- **Edge cold-start:** N/A — no edge change.
- **Override customization loss:** a user who had *moved* or *hidden* the old
  `Reorder`/`PurchaseOrders` items gets that intent remapped onto a single
  `Ordering` (dedupe keeps the first). If they had them in two different custom
  groups, only the first wins — acceptable per AC ("lands on the new Ordering
  destination"); the AC does not require preserving divergent placements of two
  now-merged items.
- **e2e drift (flagged, not blocking):** `e2e/reorder.spec.ts` +
  `e2e/fixtures/constants.ts` reference `nav-Reorder`; they break until updated
  to `nav-Ordering` + tab click. Out of the jest gate; must be handled in the
  same PR or a fast follow to keep the e2e track green.
- **Unmount-during-callback:** ReorderSection's `createPoDraft(...).finally(setBusy(false))`
  runs as the shell unmounts it on the tab flip. React 19 no longer warns on
  set-state-after-unmount, so this is benign; noted for completeness.
- **`app.json` slug:** not touched; no implication.

## Handoff
next_agent: frontend-developer
prompt: Implement spec 137 against the ## Backend design section — a frontend-only
  Cmd-UI change. Create OrderingSection.tsx (tab shell, Reorder landing tab),
  the orderingHandoff signal module, the minimal ReorderSection `onPoCreated`
  prop + POsSection signal subscription, the cmdSelectors sidebar item rename
  (Ordering) + palette-entry update, the sidebarLayout remap helper +
  ResponsiveCmdShell normalization point, the InventoryDesktopLayout dispatch
  branch, the EODCountSection:748 section-string fix, and the three i18n keys.
  Add the OrderingSection jest test; keep the ReorderSection.*/POsSection.*
  suites passing unchanged. Update the e2e nav path (nav-Ordering + tab testIDs)
  in the same PR. After implementation set Status: READY_FOR_REVIEW and list
  files under ## Files changed.
payload_paths:
  - specs/137-unify-reorder-and-purchase-orders.md

## Files changed

Implemented exactly against the ## Backend design section (frontend-only, Cmd-UI
navigation/handoff). No DB/RPC/edge/RLS surface touched.

New files:
- `src/screens/cmd/sections/OrderingSection.tsx` — the tab shell (owns `activeTab`,
  default `'reorder'`; conditionally renders `ReorderSection` / `POsSection`; wires
  `handlePoCreated` → tab flip + `orderingHandoff` signal). Tabs carry stable
  testIDs `ordering-tab-reorder` / `ordering-tab-pos`.
- `src/lib/orderingHandoff.ts` — the ~30-line dedicated Zustand deep-link signal
  (`pendingPoId` / `requestPoSelect` / `consume`), mirroring `paletteAction.ts`.
- `src/screens/cmd/sections/__tests__/OrderingSection.test.tsx` — new jest suite:
  shell render + landing tab, deep-link create→switch→preselect (+ manual path),
  and the `remapLegacySidebarOverrideIds` / `applySidebarOverride` fallback unit
  coverage.

Modified files:
- `src/screens/cmd/sections/ReorderSection.tsx` — added the ONE optional prop
  `onPoCreated?: (poId: string) => void`, threaded to `CreatePoButton` via a
  module-local React context (no `VendorCard` signature churn), fired inside the
  existing `createPoDraft(...).then` on success. Inert (context default
  `undefined`) when rendered standalone.
- `src/screens/cmd/sections/POsSection.tsx` — added the one-shot `orderingHandoff`
  signal subscription after the existing auto-select effect (selects `pendingPoId`
  then consumes). Inert (signal `null`) standalone.
- `src/components/cmd/TabStrip.tsx` — additive optional `testID?: string` on the
  `Tab` type + passthrough (for the ordering tab testIDs / e2e).
- `src/lib/sidebarLayout.ts` — added `LEGACY_SIDEBAR_ID_ALIASES` +
  `remapLegacySidebarOverrideIds()` (pure, deduping remap of `Reorder` /
  `PurchaseOrders` override ids → `Ordering`).
- `src/screens/cmd/ResponsiveCmdShell.tsx` — normalized the raw override through
  `remapLegacySidebarOverrideIds` in a `useMemo` at the :98 selector point so all
  downstream `applySidebarOverride` calls consume the remapped value.
- `src/lib/cmdSelectors.ts` — PLANNING group: replaced the two `Reorder` /
  `PurchaseOrders` items with a single first-in-group `Ordering` item; palette
  `SCREEN_ENTRIES_DEFS`: replaced the two entries with three (`alias` discriminator
  on the built id) all routing to `Ordering` so ⌘K matches "reorder" +
  "purchase orders".
- `src/screens/cmd/InventoryDesktopLayout.tsx` — replaced the two `Reorder` /
  `PurchaseOrders` dispatch branches with one `Ordering` → `<OrderingSection />`;
  swapped the `ReorderSection` / `POsSection` imports for `OrderingSection`.
- `src/screens/cmd/sections/EODCountSection.tsx` — post-submit deep-link section
  string `'Reorder'` → `'Ordering'` (lands on the default Reorder tab).
- `src/i18n/{en,es,zh-CN}.json` — new `sidebar.items.ordering` key
  (Ordering / Pedidos / 订货).
- `e2e/fixtures/constants.ts` + `e2e/reorder.spec.ts` — nav path `nav-Reorder` →
  `nav-Ordering` + `ordering-tab-reorder` click (same-PR e2e update per the design
  ruling).

## Verification

- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- `npx jest` (full) → exit 0; 129 suites / 1376 tests passed. The existing
  `ReorderSection.*` and `POsSection.test.tsx` suites pass UNCHANGED.
- `npx expo export --platform web` → exit 0 (clean metro bundle; catches
  import/bundle errors typecheck misses).
- Interactive browser verification via the `preview_*` tools was NOT run: those
  tools are not available in this agent's toolset. The web-export bundle build
  above is the substituted non-interactive check. A reviewer with preview access
  should exercise the golden path (sidebar → Ordering → Reorder tab → + CREATE PO →
  auto-switch to Purchase orders with the draft preselected) and the 1100px
  responsive boundary.
