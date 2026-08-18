# Code review for spec 160 — Truthful "last counted" indicator

Reviewed the full diff (25 files): migration + pgTAP, `db.ts`/`useStore.ts`
plumbing, `countAge.ts`, the desktop table/layout, the four rewired surfaces,
the two relabel-only surfaces, `filterParser.ts`, the RecipesSection no-op
comment/test, i18n (all three catalogs), and every touched test file.

Overall: this is an unusually disciplined implementation — it follows the
backend design's pseudocode and rationale almost verbatim, the six
`lastUpdatedAt` surfaces land on the correct side of the rewire/relabel split
(verified independently by grepping `lastUpdatedAt` project-wide, not just
trusting the spec's table), the `LEFT JOIN` in the `staff_items_updated`
rewrite is preserved (the one thing that could have silently broken a shipped
surface), `ingredient_changed_badge.test.sql` is genuinely unedited, and the
union block in the new migration is byte-identical to spec 128's. No Critical
findings.

## Critical

None.

## Should-fix

None. (I traced a candidate — whether the `lastCountedNow` `useMemo`'s
`[lastCountedStoreId, lastCountedLoaded]` dependency array actually
re-anchors on a same-store realtime reload, since `CmdNavigator`'s
400ms-debounced sync calls `loadFromSupabase` with the *same* `sid` — and
confirmed it does: `loadFromSupabase` unconditionally clears
`lastCountedStoreId → null` / `lastCountedLoaded → false` before the
fire-and-forget reload repopulates them, so the memo's dependencies genuinely
flip on every reload, same-store or not. The "re-anchored on every map
reload" comment in `InventoryDesktopLayout.tsx:173-182` and
`PhoneInventoryList.tsx` is accurate. No finding here — noting the trace so
it isn't re-litigated.)

## Nits

- `src/components/cmd/InventoryTable.tsx:113-122` — `COL_STYLE`'s key order
  (`name, onHand, status, costEach, stockValue, vendor, category,
  lastCounted`) doesn't match the `ColumnId` display order declared four
  lines above it (`name, onHand, status, lastCounted, costEach, stockValue,
  vendor, category`) or the `all` array in `visibleColumnsForWidth`.
  `lastCounted` is tacked on at the end instead of sitting 4th. Purely a
  read-order nit — a maintainer scanning top-to-bottom for "what's the
  4th column's width" won't find it where they expect. Reorder the object
  literal to match.

- `src/screens/cmd/InventoryDesktopLayout.tsx:831` /
  `src/i18n/en.json:537` (and es/zh-CN) — the composed meta-line string for a
  never-counted item reads `"last counted never counted"`, and for the
  loading state `"last counted loading"`. This is the item the frontend
  developer flagged as deliberately not patched. Agreed with the developer's
  call not to block on it: it's honest (no false claim, unlike the
  pre-existing `"… last counted never ago"` bug this spec fixes) and it's a
  one-key copy problem, not a logic problem. My view for the PM: I'd drop the
  `lastCountedMeta` wrapper for the never/loading cases specifically (e.g.
  render `neverLabel` / `loadingLabel` bare in the meta line instead of
  wrapping them in `"last counted {value}"`), since "last counted" is
  redundant once the value itself says "never counted" or "loading". Low
  priority, ship as-is and pick it up as a follow-up copy tweak in all three
  catalogs together.

- `src/utils/countAge.ts:64-75` — `CountAgeFormatOpts.now` is documented as
  "Anchor for the same-year test. Age itself comes from `relativeTime`" —
  which is accurate and intentional per the backend design (§8.1: "the age
  fragment always comes from the existing `relativeTime()`... not
  re-derived"). Worth flagging only because it's a slightly unusual shape for
  a formatting function to accept a clock parameter that only partially
  drives its output (the same-year boundary, not the headline age string).
  No change requested — the doc comment already disambiguates it — just
  noting it for anyone debugging a same-year vs. relative-age mismatch later.

- `src/screens/cmd/InventoryDesktopLayout.tsx:807` /
  `src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx:90` — both detail
  surfaces call `now: new Date()` inline in the render body rather than
  reusing a memoized anchor (the desktop table host has `lastCountedNow` a
  few lines up in the same component tree). Harmless for a single-item pane
  (cheap, and arguably more accurate than a frozen anchor), but it is an
  inconsistency with the "one shared anchor, no timer" posture the design
  established for the table. Not worth threading a prop for one `Date()`
  call — leaving as a nit rather than should-fix.

- (out-of-scope) `src/screens/cmd/sections/phone/PhoneCatalogList.tsx:81` /
  `src/screens/cmd/sections/InventoryCatalogMode.tsx` relabel rows keep the
  hardcoded English `'never'` literal for the brand-wide "last edited" value
  — pre-existing, and the spec's own ruling (§8.3 rows 5/6) explicitly scopes
  the relabel to the key/label only. Just flagging for visibility, not asking
  for a change here.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 5 Nits (all cosmetic/copy — none block merge).
payload_paths:
  - specs/160-last-counted-indicator/reviews/code-reviewer.md
