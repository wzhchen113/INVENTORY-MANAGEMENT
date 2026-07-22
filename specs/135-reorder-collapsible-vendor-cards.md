# Spec 135: Collapsible vendor cards on the Reorder page

Status: READY_FOR_REVIEW

## User story
As a store manager on the Reorder page, I want to collapse a vendor card's
ingredient list by clicking the vendor, so that I can hide vendors I've already
dealt with and keep a long multi-vendor page scannable.

## Context
`src/screens/cmd/sections/ReorderSection.tsx` renders one `VendorCard` per
vendor (in up to three groups: "needs to order", "have enough stock", and the
already-collapsible "no schedule" group). Each card is a header block
(vendor name + source/schedule badges + short id + a stats row of
`items · qty (base) · est cost`), followed by a column-header strip, the
per-item breakdown rows, and a footer with the per-vendor actions
(CREATE PO / quick-order / CSV / PDF). The owner wants clicking the vendor to
collapse/expand that card's ingredient list. Precedent for the affordance
already exists in this same section: the "NO ORDER SCHEDULE" group toggles via a
`▸`/`▾` chevron `TouchableOpacity` with `accessibilityRole="button"` +
`accessibilityState={{ expanded }}` (ReorderSection.tsx lines 1522-1558).

## Acceptance criteria
- [ ] Each expandable `VendorCard` header renders a `▸`/`▾` chevron affordance
      matching the existing "NO ORDER SCHEDULE" toggle (`▾` when expanded,
      `▸` when collapsed).
- [ ] The tap target for toggling is the chevron together with the vendor-name
      text (the left region of the header row). Tapping badges, the short id,
      the stats row, or any footer action button does NOT toggle the card.
- [ ] The toggle control has `accessibilityRole="button"` and
      `accessibilityState={{ expanded: <bool> }}` reflecting current state.
- [ ] Default state on load is EXPANDED for every card (matches today's
      behavior — no visual change until the user clicks).
- [ ] When a card is collapsed, the column-header strip, all per-item breakdown
      rows, the footer (actions + eod-counted line), and any open quick-order
      preview block are hidden. The header block (vendor name + badges +
      next-delivery line + `items · qty (base) · est cost` stats row) stays
      visible so the page stays scannable.
- [ ] Pressing the CREATE PO / quick-order / CSV / PDF buttons never toggles
      collapse (they live in the footer, which is hidden while collapsed; while
      expanded, pressing them performs their action only).
- [ ] Collapsed/expanded state is per-session component state held in
      `ReorderSection` (a `Set` of collapsed vendor keys), survives the
      debounced realtime payload reloads that re-render the section, and resets
      to all-expanded on store switch or when navigating away and back. No
      persistence to localStorage or the backend.
- [ ] The violet "count not submitted" card (spec 130, `isReorderCountNotSubmitted`)
      renders NO chevron and is NOT collapsible — it has no ingredient list to
      hide and its state block must stay visible.
- [ ] KPI stat cards at the top of the section and any warning banners are
      unaffected.
- [ ] The existing "NO ORDER SCHEDULE" group toggle continues to work; a card
      inside that group is independently collapsible via its own chevron once
      the group is expanded.
- [ ] jest track: a `ReorderSection`-level test asserts collapse hides the item
      rows / column strip / footer while keeping the header stats, and that the
      not-submitted card has no chevron.

## In scope
- Adding a per-card collapse chevron + toggle to `VendorCard` in
  `src/screens/cmd/sections/ReorderSection.tsx`.
- Threading a `collapsed` boolean + `onToggle` callback (or equivalent) from
  `ReorderSection` into each `VendorCard` so state lives at the section level.
- Hiding the column strip, item rows, footer, and quick-order preview while
  collapsed; keeping the header block (incl. stats row) visible.
- a11y: `accessibilityRole="button"` + `accessibilityState={{ expanded }}` on
  the toggle.
- One jest test per the acceptance criteria.

## Out of scope (explicitly)
- Persisting collapsed state across reloads / store switches (localStorage or a
  `profiles`/backend field). Rationale: keeps the slice frontend-only with no
  migration; per-session state satisfies the stated need. A follow-up spec can
  add localStorage persistence if the owner wants it to survive reload.
- A "collapse all / expand all" bulk control. Rationale: not requested; would
  expand the surface.
- Changing the default state to collapsed-on-load. Rationale: owner scannability
  need is met by manual collapse; collapsed-by-default changes behavior for all
  users.
- Any change to the staff Reorder screen (`src/screens/staff/`). Rationale: the
  request is about the admin Reorder page only.
- Adding a chevron / collapse to the "count not submitted" card, or to the
  KPI/warning region.
- Making the footer actions reachable while collapsed. Rationale: collapse hides
  the whole body; the owner expands to act. (Flagged below for architect
  sanity-check.)

## Open questions resolved
- Q: Toggle affordance — whole header row vs a dedicated chevron?
  → A (PM default): dedicated `▸`/`▾` chevron + vendor-name text as the tap
    target, excluding badges / stats / action buttons. Matches "clicking the
    vendor" while protecting the footer buttons; reuses the section's existing
    chevron precedent.
- Q: Persistence of collapsed state?
  → A (PM default): per-session component `Set` in `ReorderSection`. No
    localStorage, no backend field, no migration.
- Q: Default state?
  → A (PM default): expanded (matches today).
- Q: Does the "count not submitted" card get a chevron?
  → A (PM default): no — it has no item list; the state block stays visible.
- Q: What exactly does "collapse" hide?
  → A (PM default): everything below the header block — column strip, item rows,
    footer (actions + eod-counted line), and any open quick-order preview —
    leaving the header block with its `items · qty · est cost` stats visible.
    This mirrors the "NO ORDER SCHEDULE" collapse-to-a-header-line precedent and
    keeps the page scannable. **Architect/owner sanity-check flag:** if the owner
    would rather keep the CREATE PO / quick-order / CSV / PDF footer reachable
    while collapsed (hide only the ingredient list + column strip), that is a
    small variant the architect can flip — call it out in the design doc.

## Dependencies
- None beyond the existing `VendorCard` / `ReorderSection` code. No migration,
  no RPC, no edge function.
- Behavioral note for the architect: `VendorCard` is rendered in up to three
  groups; the same `vendorId` can appear in both the "needs to order" and
  "have enough stock" groups (render keys are `need-${vendorId}` /
  `ok-${vendorId}`). The section-level collapse `Set` MUST key on the SAME
  composite key used for rendering (group-qualified), not the bare `vendorId`,
  or collapsing a vendor's needs card would also collapse its enough-stock card.

## Project-specific notes
- Cmd UI section / legacy: Cmd UI section
  (`src/screens/cmd/sections/ReorderSection.tsx`). No legacy surface.
- Per-store or admin-global: per-store (the Reorder page is store-scoped); this
  change is pure client-side view state and touches no data access, so no RLS
  interaction.
- Realtime channels touched: none (view-state only). Note: the section already
  reloads via the debounced realtime sync; collapse state must survive those
  re-renders, which is why it lives in `ReorderSection` state rather than
  inside `VendorCard`.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: renders on both web and native (the Cmd shell is
  desktop-web-primary); the toggle is platform-neutral (`TouchableOpacity`), no
  web-only APIs. No `app.json` / slug impact.
- Tests: jest track (component-level assertions on the section). No pgTAP or
  shell-smoke work needed.

## Backend design

Frontend-only, view-state-only spec. No backend surface is touched. The
per-section headers below are enumerated for completeness so the developer and
reviewers can confirm nothing crossed a boundary that should not have.

- **Data model changes.** None. No migration, no new table/column/index.
- **RLS impact.** None. This is client-side render state on an already-loaded,
  already-store-scoped payload (`report_reorder_list` RPC via
  `loadReorderSuggestions`). No new policy, no helper change.
- **API contract.** None. No new PostgREST view, no RPC, no change to the
  reorder RPC envelope. `ReorderVendor` / `ReorderItem` types are unchanged.
- **Edge function changes.** None. No `verify_jwt` decision to make.
- **`src/lib/db.ts` surface.** None. No new helper, no mapping change. The whole
  change lives in `src/screens/cmd/sections/ReorderSection.tsx` plus three i18n
  catalog files. No direct-Supabase carve-out is created.
- **Realtime impact.** None to the publication. Behavioral note the developer
  MUST respect: the section already re-renders when the debounced realtime sync
  (`store-{id}` / `brand-{id}`, 400 ms) reloads `reorderPayload`. Because the
  collapse `Set` lives in `ReorderSection` `useState` (not in `VendorCard` and
  not re-derived from the payload), it survives those reloads by construction —
  a re-render does not remount `ReorderSection`. Do NOT lift the state into
  `VendorCard` (each card remounts as the payload array identity churns) and do
  NOT key it off anything derived from the payload. No `supabase_realtime`
  publication membership change → **no `docker restart` dev step**.
- **Frontend store impact.** None. `src/store/useStore.ts` is not touched. This
  is pure component-local view state; the optimistic-then-revert /
  `notifyBackendError` pattern does not apply (no backend write).

### Sanity-check ruling (spec's flagged variant)

**Hide the ENTIRE card body including the footer actions.** Collapse hides the
column-header strip, all `BreakdownLine` item rows, the footer (CREATE PO /
quick-order / CSV / PDF + the eod-counted line), and any open quick-order
preview block. Only the header block (name/badges row + next-delivery line +
`items · qty (base) · est cost` stats row) stays visible. Rationale: the stats
row already carries item count, base qty, and est cost, so the collapsed card
stays scannable; leaving CREATE PO reachable over a hidden ingredient list
invites ordering items the operator can no longer see — the exact failure the
owner's "hide what I've dealt with" request is trying to avoid. This also
matches the existing "NO ORDER SCHEDULE" collapse-to-a-header-line precedent
(lines 1522-1558). No new summary line is introduced — the existing spec-130
stats row IS the collapsed summary.

### Collapse key shape (the PM's keying warning)

The collapse `Set<string>` MUST key on the **group-qualified render key**, never
the bare `vendorId`. `splitReorderVendorsByNeed` splits a vendor by its ITEMS,
so a single vendor with both below-par and at-par items renders a card in BOTH
the needs and enough groups; a bare-`vendorId` key would collapse both at once.
Pin the key to exactly the string already passed as React `key=`:

| Group (render site)            | Current React `key`      | Collapse key (pin)        | Collapsible |
|--------------------------------|--------------------------|---------------------------|-------------|
| needs-to-order (line 1497)     | `` `need-${vendorId}` `` | `` `need-${vendorId}` ``  | yes         |
| have-enough-stock (line 1512)  | `` `ok-${vendorId}` ``   | `` `ok-${vendorId}` ``    | yes         |
| no-schedule group (line 1554)  | `` `${vendorId}` `` (bare) | `` `nosched-${vendorId}` `` | yes    |
| count-not-submitted (line 1482)| `` `nosub-${vendorId}` `` | — (not collapsible)      | no          |

**Change the no-schedule card's React `key` from bare `` `${vendorId}` `` to
`` `nosched-${vendorId}` ``** so the render key and the collapse key are the same
string in all three collapsible groups (the no-schedule partition is disjoint
from needs/enough today, but keying it group-qualified removes the latent
ambiguity and keeps the "collapse key === render key" invariant total). The
count-not-submitted group gets no collapse key and no chevron.

### State + wiring (in `ReorderSection`)

```ts
// section-level, per-session; resets on store switch + on unmount/remount.
const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(() => new Set());
const toggleCollapsed = React.useCallback((key: string) => {
  setCollapsedKeys((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
}, []);
```

- **Reset on store switch:** add `setCollapsedKeys(new Set())` inside the
  `storeChanged` branch of the existing store-switch effect (lines 1164-1175).
  Do NOT reset on the same-store `selectedDate`-change path — collapse should
  survive a date change (keys are vendor-scoped and simply no-op if a vendor
  drops out). Reset on navigate-away-and-back is handled for free by unmount.
- Each of the three collapsible groups passes the group-qualified key:
  ```tsx
  {needsOrderVendors.map((v) => {
    const k = `need-${v.vendorId}`;
    return <VendorCard key={k} vendor={v} needsOrder showExport={showExport}
      collapsible collapseKey={k}
      collapsed={collapsedKeys.has(k)} onToggleCollapse={() => toggleCollapsed(k)} />;
  })}
  ```
  (analogously `ok-` and `nosched-`). The count-not-submitted map keeps its
  current call — no `collapsible` / `collapseKey` / `collapsed` props.

### `VendorCard` prop + affordance (pin)

New optional props (all default to non-collapsible so existing call sites and
the not-submitted early-return path are unaffected):
`collapsible?: boolean`, `collapseKey?: string`, `collapsed?: boolean`,
`onToggleCollapse?: () => void`.

- **Toggle affordance / tap target.** A `TouchableOpacity` wrapping ONLY the
  `▾`/`▸` chevron (`Text`, `mono(700)`, `fontSize: 11`, `color: C.fg2`, `▾` when
  expanded / `▸` when collapsed — byte-matching the group toggle at lines
  1541-1543) together with the vendor-name `Text`. The source/schedule badges,
  the `7-DAY DEFAULT` badge, the short id, the stats row, and every footer
  button stay OUTSIDE this touchable. This requires restructuring `headerNameRow`
  for the counted branch only: today `headerNameRow` is a shared const rendered
  by both the counted and not-submitted branches (lines 514-527). Keep the
  shared const chevron-free for the not-submitted branch; in the counted branch,
  wrap `chevron + vendorName` in the toggle `TouchableOpacity` and render the
  badges / spacer / shortId as siblings. Only render the toggle when
  `collapsible` is true (defensive — the not-submitted branch already returns
  before this point).
- **a11y.** On the toggle: `accessibilityRole="button"`,
  `accessibilityState={{ expanded: !collapsed }}`, and
  `accessibilityLabel={T('section.reorder.collapseVendorAria', { vendor: vendor.vendorName || '' })}`.
  Expanded/collapsed is conveyed by `accessibilityState` (one label covers both
  directions, matching the group toggle which carries no direction word).
- **testID.** `` testID={`reorder-vendor-toggle-${collapseKey}`} `` (e.g.
  `reorder-vendor-toggle-need-v-a`) — group-qualified so the same vendor's needs
  and enough toggles get distinct ids and `getByTestId` never collides.
- **Body gating.** Wrap the column-header strip (lines 649-666), the items map
  (668-720), the footer (722-752), and the quick-order preview block (754-779)
  behind `!collapsed`. The header `View` (lines 619-647, incl. the stats row)
  always renders. `quickPreview` state may stay set while collapsed (it simply
  isn't rendered); it re-appears on expand — acceptable, no reset needed.
- To make the hide assertable, add two testIDs while gating: the column-strip
  `View` gets `` testID={`reorder-vendor-columns-${collapseKey}`} `` and the
  always-visible stats row `View` gets
  `` testID={`reorder-vendor-stats-${collapseKey}`} ``. Each per-item row `View`
  (line 670) gets `` testID={`reorder-vendor-item-${item.itemId}`} ``. (The
  footer's existing `reorder-create-po-${vendorId}` testID already serves as a
  footer-presence probe.)

### i18n (the "×3" the task calls out)

Add ONE new key `section.reorder.collapseVendorAria` (param `{vendor}`) to all
three catalogs — `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
(that is the "×3": one key, three locale files, same shape as the existing
`section.reorder.createPoAria` / `quickOrderAria` aria keys). Suggested copy:
en `"Toggle order list for {vendor}"`, es `"Mostrar u ocultar la lista de {vendor}"`,
zh-CN `"展开或收起 {vendor} 的订货清单"`. No other string changes.

### Testability

No pure-logic extraction is warranted — the entire logic is a `Set` add/delete
toggle, not worth a standalone module; a `ReorderSection`-level component test
exercises it end-to-end. Add `ReorderSection.spec135.test.tsx` following the
established boundary-mock pattern in `ReorderSection.spec130.test.tsx` (mock
`useCmdColors` / `useT` / `TabStrip` / `StatCard` / `useStore`, force
`Platform.OS = 'web'`, everyday schedule so vendors are day-active). Assertions:

1. **Default expanded:** on render, `reorder-vendor-columns-need-v-a`,
   `reorder-vendor-item-a1`, and `reorder-create-po-v-a` (footer) are all
   present; `reorder-vendor-stats-need-v-a` present.
2. **Collapse hides the body, keeps the header:** `fireEvent.press` the toggle
   `reorder-vendor-toggle-need-v-a`; then column strip, item rows, and the
   footer probe (`reorder-create-po-v-a`) are `queryByTestId(...) === null`,
   while `reorder-vendor-stats-need-v-a` (stats row) stays present.
3. **Independent keys:** a vendor that appears in both needs and enough groups —
   collapsing `need-<id>` leaves `ok-<id>`'s body (`reorder-vendor-item-...` /
   footer) present. (Use one vendor with a below-par item and an at-par item so
   `splitReorderVendorsByNeed` yields both cards.)
4. **Not-submitted card has no chevron:** with a `notSubmitted` vendor rendered,
   `queryByTestId('reorder-vendor-toggle-nosub-v-b')` is null and no toggle
   testID resolves for it; its `reorder-count-not-submitted-v-b` block is
   present.
5. **a11y:** the toggle exposes `accessibilityState.expanded === true` before
   press and `false` after (query via role/testID props).

### Risks and tradeoffs

- **Concurrency with spec 134.** Spec 134's build edits `POsSection.tsx` and
  `src/utils/`; this spec touches only `ReorderSection.tsx` + three i18n JSONs.
  No file overlap — but the three i18n catalogs are shared, high-churn files.
  Developer should add the single new key and avoid reformatting so a merge
  stays trivial.
- **Stale keys in the Set.** A collapsed vendor that drops out of the payload
  (date change, EOD submitted) leaves a dangling key; it is inert (the card is
  gone) and is cleared on store switch / remount. No leak of consequence; not
  worth pruning.
- **Section-kept-mounted caveat.** "Reset on navigate-away-and-back" relies on
  `ReorderSection` unmounting when the Cmd shell switches sections. If the Cmd
  navigator keeps sections mounted, collapse state would persist across a
  section switch (but still reset on store switch via the effect). This matches
  the acceptance intent (per-session, no persistence) and is acceptable; flag
  only if a reviewer reads the AC more strictly.
- **Performance.** Negligible on the 286 KB seed — one `Set.has` per card per
  render, no new data fetch, no new list. No cold-start surface (no edge fn).
- **No new permissive-policy / RLS surface**, no db.ts carve-out, no realtime
  publication change — none of the CLAUDE.md backend guardrails are in play.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. All changes live in
  src/screens/cmd/sections/ReorderSection.tsx plus the one new i18n key
  `section.reorder.collapseVendorAria` in src/i18n/{en,es,zh-CN}.json. Hold the
  "collapse key === group-qualified render key" invariant (need- / ok- /
  nosched-), rename the no-schedule card's React key to `nosched-${vendorId}`,
  keep the count-not-submitted card chevron-free, and hide the full body
  (columns + items + footer + quick-order preview) while collapsed, leaving the
  header stats row visible. Add ReorderSection.spec135.test.tsx per the five
  assertions above. Do NOT touch POsSection.tsx or src/utils/ (spec 134 owns
  those concurrently). After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/135-reorder-collapsible-vendor-cards.md

## Files changed

- `src/screens/cmd/sections/ReorderSection.tsx` — added the four optional
  `VendorCard` collapse props (`collapsible` / `collapseKey` / `collapsed` /
  `onToggleCollapse`); added a counted-branch-only `headerNameRowCollapsible`
  with the `▾`/`▸` chevron + vendor-name `TouchableOpacity` toggle
  (`accessibilityRole="button"`, `accessibilityState={{ expanded: !collapsed }}`,
  the new `collapseVendorAria` label, `testID=reorder-vendor-toggle-${collapseKey}`);
  gated the whole card body (column strip + item rows + footer + quick-order
  preview) behind `!collapsed`; added `reorder-vendor-stats-${collapseKey}`,
  `reorder-vendor-columns-${collapseKey}`, and `reorder-vendor-item-${item.itemId}`
  testIDs; added the section-level `collapsedKeys` `Set<string>` state +
  `toggleCollapsed`, reset on store switch in the existing store-switch effect;
  threaded the group-qualified keys (`need-` / `ok-` / `nosched-`) into the three
  collapsible group maps and renamed the no-schedule card's React `key` from bare
  `${vendorId}` to `nosched-${vendorId}`. Count-not-submitted map unchanged (no
  chevron, not collapsible).
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added one new
  key `section.reorder.collapseVendorAria` (param `{vendor}`).
- `src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx` — new
  boundary-mock component test with the five assertions (default expanded,
  collapse-hides-body-keeps-stats, per-group independent keys,
  not-submitted-has-no-chevron, `accessibilityState.expanded` reflects state).

Verification: `npx tsc --noEmit` clean, `npx tsc -p tsconfig.test.json --noEmit`
clean, full `npx jest` green (125 suites / 1358 tests). Browser verification
deferred to the main session.


## Post-ship owner follow-up (2026-07-21)

Owner: "make sure they are hided in the begining." The specced default
(expanded, matching the pre-135 page) is REVERSED: vendor cards start
COLLAPSED, so the Reorder page opens as a scannable per-vendor summary.
Implementation: the per-card Set now tracks EXPANDED keys (empty default =
all collapsed; the store-switch reset re-collapses). Toggle affordance,
group-qualified keys, count-not-submitted exclusion, and body-hiding rules
are unchanged. The spec135 component tests were flipped accordingly
(default-hidden, expand-shows-body, group-key independence from the
collapsed baseline, a11y expanded=false initially).
