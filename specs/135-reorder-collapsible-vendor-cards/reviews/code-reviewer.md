# Code review for spec 135

Scope reviewed: `src/screens/cmd/sections/ReorderSection.tsx`,
`src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx`, and the
`section.reorder.collapseVendorAria` key in `src/i18n/{en,es,zh-CN}.json`.
Concurrent spec-134 hunks in `POsSection.tsx` / `src/utils/` were left alone,
per instructions, and confirmed absent from this diff.

Summary: the implementation matches the design pin closely. The
collapse-key === render-key invariant holds across all three collapsible
groups (`need-`, `ok-`, `nosched-`), the no-schedule card's React `key` was
correctly renamed from bare `${vendorId}` to `nosched-${vendorId}` with no
other code relying on the old bare key (verified — no test or sibling file
references a bare-vendorId render key), the toggle touchable wraps only the
chevron + vendor-name `Text` with badges/shortId/stats/footer as siblings, the
count-not-submitted card is untouched (no chevron, no collapse props passed at
its call site), collapsed body-gating hides column strip + items + footer +
quick-order preview while keeping the header (incl. stats row) visible, the
store-switch effect resets `collapsedKeys` only in the `storeChanged` branch
(not on the same-store date-change path), a11y wiring
(`accessibilityRole="button"`, `accessibilityState={{ expanded: !collapsed }}`,
the new aria label) is correct, and the chevron glyph/style
(`mono(700)`, `fontSize: 11`, `color: C.fg2`, `▾`/`▸`) byte-matches the
existing "NO ORDER SCHEDULE" group toggle. The i18n key was added identically
across all three catalogs in the same position, matching the shape of the
neighboring `createPoAria`/`quickOrderAria` keys, with no reformatting churn.

No Critical or Should-fix findings.

### Critical

None.

### Should-fix

None.

### Nits

- `src/screens/cmd/sections/ReorderSection.tsx:1233-1247` vs `:1305-1313` —
  the store-switch effect calls `setCollapsedKeys(new Set())` (line 1242)
  roughly 60 lines before `collapsedKeys`/`setCollapsedKeys` are declared via
  `useState` (line 1305). This is safe at runtime (the effect closure doesn't
  execute until after the full render pass completes, by which point the
  state is initialized), but it reads oddly top-down — a maintainer skimming
  the effect has to jump forward to find where `setCollapsedKeys` comes from.
  Consider moving the `collapsedKeys`/`toggleCollapsed` declaration above the
  store-switch effect so the state is introduced before its first use site.

- `src/screens/cmd/sections/ReorderSection.tsx:536-549` and `:565-590` —
  `headerNameRow` and `headerNameRowCollapsible` duplicate the badges/spacer/
  shortId markup (~10 lines) between the two consts; only the name+chevron
  portion differs. The spec explicitly pins this shape ("restructuring
  headerNameRow for the counted branch only... render the badges / spacer /
  shortId as siblings"), so this isn't a developer oversight, but it's worth
  flagging: a future badge/shortId change now needs to land in two places
  instead of one, since one of the two consts (`headerNameRow`) is only
  reachable when `collapsible` is falsy — which is never true from any actual
  call site today. (out-of-scope for this review — architect-pinned shape.)

- `src/screens/cmd/sections/ReorderSection.tsx:481-497` — the four new
  `VendorCard` props (`collapsible`, `collapseKey`, `collapsed`,
  `onToggleCollapse`) are independently optional rather than a discriminated
  union. A hypothetical future call site that passes `collapsible` without
  `collapseKey` would silently render `testID="reorder-vendor-toggle-undefined"`
  (line 568) rather than fail to typecheck. Not reachable from any of the
  current three call sites (all three always pass `collapsible` + `collapseKey`
  together), so no live bug — just a latent type-safety gap if a caller is
  added later without care.

- `src/screens/cmd/sections/ReorderSection.tsx:567-579` — the new per-card
  chevron+name touchable has no padding (`gap: 8` only), unlike the existing
  "NO ORDER SCHEDULE" group toggle which wraps the *entire* row in
  `paddingVertical: 10, paddingHorizontal: 14`. This is spec-directed (the tap
  target is deliberately narrowed to chevron+name, excluding the rest of the
  row), so not a defect, but the resulting hit region is noticeably smaller
  than the sibling toggle's. Since the Cmd shell also renders on native (per
  the spec's "Web/native scope" note), a small `hitSlop` would cheaply improve
  touch ergonomics without widening the visual tap affordance.

- `src/screens/cmd/sections/ReorderSection.tsx:738` — the new
  `reorder-vendor-item-${item.itemId}` testID is not group-qualified. If the
  same `itemId` is ever rendered under two vendor cards simultaneously in the
  same group (the section already supports a shared item appearing under
  multiple vendors via `alsoFromVendors`/`otherVendorCount`), `getByTestId`
  would throw on multiple matches and `queryByTestId` assertions in a
  collapse test could pass against the wrong card's row. This shape is pinned
  verbatim by the spec, and the shipped test avoids the edge case by using
  distinct itemIds (`c1`/`c2`) for its two-cards-per-vendor scenario, so
  nothing is broken today — flagging only as a latent test-fragility note
  for whoever extends coverage next (test-engineer territory more than a
  code defect).
