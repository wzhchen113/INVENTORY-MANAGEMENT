## Test report for spec 160

### Acceptance criteria status

- AC-1 (derived from count history, never `lastUpdatedAt`) → **PASS** —
  `src/components/cmd/InventoryTable.test.tsx::AC-1 — it does NOT read item.lastUpdatedAt`,
  `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx::AC-1 — mutating lastUpdatedAt (a plain EDIT) does NOT change the value`,
  `src/screens/cmd/sections/phone/__tests__/PhoneInventoryDetail.test.tsx::AC-1`.
  Each fixture sets `lastUpdatedAt` to "just now" while the true count is 40 days
  old and asserts the cell reads `1mo`, not `0s`. This would fail on the
  regression the spec exists to fix.
- AC-2 (max over both sources, byte-identical to `staff_items_updated`) →
  **PASS** — `supabase/tests/items_last_counted.test.sql` assertions (4)(5)(6):
  eod alone, max over both, `inventory_counts` alone (verified against a real
  local Postgres, not mocked).
- AC-3 (submitted-only; drafts excluded) → **PASS** — pgTAP assertions (7)(8):
  a draft `eod_submissions` row and a draft `inventory_counts` row each
  produce `NULL`.
- AC-4 (per `(item, store)` scope) → **PASS** — pgTAP assertions (13)(14):
  same catalog ingredient counted at store A, `NULL` at store B; store A rows
  don't leak into store B's result set.
- AC-5 (never counted → NULL → "never counted" copy) → **PASS** — pgTAP
  assertion (9) at the backend; `InventoryTable.test.tsx`,
  `InventoryDesktopLayout.test.tsx`, `PhoneInventoryDetail.test.tsx` all assert
  the localized phrase renders for a `null` value at the frontend.
- AC-6 (server-side RLS scoping) → **PASS** — pgTAP assertion (15): a caller
  with no `user_stores` grant for the store gets the **empty set** (not
  rows-with-NULL); assertion (16) pins the anon/authenticated grant split.
  This runs against a real local Postgres with RLS enforced, not asserted by
  inspection.
- AC-7 (terse form for counted / localized never-counted, no bare `—`/empty) →
  **PASS**, under the backend-architect's §0.1 supersession (both-formats
  decision — `Aug 14 · 3d`, not relative-only). `InventoryTable.test.tsx::AC-7 / §0.1`
  asserts the composed string; the AC-9 cases confirm `—` is confined to the
  loading state only.
- AC-8 (4-tone grading, named constants, exact boundaries) → **PASS** —
  `src/utils/countAge.test.ts` pins all four boundaries exactly (6d23h→fresh,
  7d00m→stale, 29d23h→stale, 30d00m→cold) plus degenerate inputs (null→never,
  malformed→never, future→fresh); `InventoryTable.test.tsx::AC-8` cross-checks
  the tone→colour mapping against the mocked palette for all four tones.
- AC-9 (loading shows neutral `—`, never "never counted") → **PASS — this is
  the failure mode the review specifically asked about, and it is covered at
  every layer that renders the value.**
  `InventoryTable.test.tsx` has two direct cases (`loaded: false` and the prop
  bundle entirely absent) each asserting `screen.queryByText('never counted')`
  is `null` alongside `screen.getByText('—')`.
  `InventoryDesktopLayout.test.tsx::AC-9` asserts the detail-pane meta row
  shows the loading phrase and NOT the never-counted phrase when
  `lastCountedLoaded: false` (the component's actual default mock state, so
  every OTHER case in that file that doesn't explicitly set the slice also
  exercises this path incidentally).
  `PhoneInventoryDetail.test.tsx::AC-9` mirrors it for the phone surface.
  All three assertions would fail if a future change collapsed the
  `!loaded → —` branch into rendering the never-counted string, or if the
  `catch` branch in `useStore.ts::loadItemsLastCounted` were changed to set
  `lastCountedLoaded: true` with an empty map (the false-accusation-across-149-rows
  regression named in the review prompt).
- AC-10 (a11y label carries absolute date / never phrase) → **PASS** —
  `InventoryTable.test.tsx::AC-10 — the a11y label carries the LONG absolute date`
  matches `/^last counted [A-Za-z]+ \d{1,2}, \d{4} · 3d$/` on
  `getByLabelText`; the never-counted a11y case is covered in the AC-5 test.
  (Note: the design's §0.1 decision also renders the short date inline in the
  cell now, which supersedes the AC text's "absolute dates are NOT rendered
  inline" clause — this is a documented, deliberate spec override, not a test
  gap.)
- AC-11 (detail pane: absolute + relative, both rows consume the new value) →
  **PASS** — `InventoryDesktopLayout.test.tsx::AC-11 — renders the absolute
  date AND the relative age once loaded` matches
  `/^last_counted="[A-Za-z]+ \d{1,2}, \d{4} · 3d"$/` via the key-echoing
  `PropertiesJson` stub; the meta-line's old `"… never ago"` string bug is
  also gone (its removal is implied by the `lastCountedMeta` key wiring, code-read
  confirmed at InventoryDesktopLayout.tsx, though no test asserts the FULL meta
  string with category/vendor — only the `last_counted` properties row is
  directly asserted).
- AC-12 (phone consumes the same value; desktop and phone never disagree) →
  **PASS, structurally** — both `InventoryDesktopLayout.test.tsx` and
  `PhoneInventoryDetail.test.tsx` pin IDENTICAL AC-1/AC-5/AC-9 behavior against
  the same `lastCountedByItem`/`lastCountedLoaded`/`lastCountedStoreId` shape
  (both read `useStore` directly with the same field names — confirmed by
  code read of both components). No single test literally mounts both and
  diffs their output, but the guarantee is structural (one slice, one key) and
  each side is independently pinned to the identical contract.
- AC-13 (column display order) → **PASS** — `InventoryTable.test.tsx`'s pure
  `visibleColumnsForWidth(1400)` assertion pins the exact 8-column order;
  `InventoryDesktopLayout.test.tsx` case 1 asserts the header row order via
  `lastCountedCol` positioned correctly among the others.
- AC-14 (re-prioritized collapse tiers; `lastCounted` survives 1200-1399 and
  1100-1199) → **PASS — verified this is a genuine re-pin of the intended
  product fact, not a loosened assertion.** Per the review's specific ask:
  `InventoryTable.test.tsx` asserts, at width 1250 (`1200-1399` no man's land in
  the OLD table but firmly the AC-14 band), `screen.getByText('last counted')`
  is present AND `screen.queryByText('category')` is `null` — i.e. the test
  positively asserts survival of the column that used to be first-dropped, not
  merely "the render doesn't crash." The floor-tier case (1150) and the
  unbounded-floor pane-open case (920) repeat the same positive assertion.
  `InventoryDesktopLayout.test.tsx` independently re-derives the same tiers
  from `windowWidth` arithmetic (1500→7 cols, category dropped, lastCounted
  kept; pane-open→6 cols, category+vendor dropped, lastCounted kept) — a
  second, differently-mocked path pinning the same fact, which is a reasonable
  redundancy check against a single-file mistake.
- AC-15 (`counted:never` / `counted:stale` semantics) → **PASS** —
  `src/utils/filterParser.test.ts` — `never` admits only `never` tone; `stale`
  admits stale/cold/never, excludes fresh.
- AC-16 (`counted:<other>` → zero rows, no name fallthrough) → **PASS** —
  `filterParser.test.ts::AC-16` — asserts BOTH that the value lands in
  `parsed.filters` (not `parsed.text`) and that it matches zero rows across
  all four tones.
- AC-17 (single source of truth for thresholds) → **PASS, structurally +
  tested** — the matcher signature takes a precomputed `CountAgeTone`, never a
  day count (code-read confirmed, `filterParser.ts` has no day-math);
  `filterParser.test.ts::AC-17` additionally proves the tone consumed by the
  matcher is literally the output of `countAgeTone`.
- AC-18 (`counted:` ANDs with other tokens/status chip) → **PASS** —
  `filterParser.test.ts::AC-18` covers 4 combinations (right tone+cat, wrong
  cat, wrong tone, right both but name misses).
- AC-19 (filter placeholder advertises the token, all 3 catalogs) →
  **PARTIAL / gap on the wiring half.** The i18n content itself is fully
  covered: `filterPlaceholderItems` exists with real (not-English-fallback)
  translations in `en.json`/`es.json`/`zh-CN.json` and passes the
  `i18n.test.ts` parity gate. However, **no jest test asserts the string is
  actually wired to the `FilterInput`'s `placeholder` prop** at either call
  site. `InventoryDesktopLayout.test.tsx` mocks `FilterInput` to
  `() => null` with no prop capture, so the `placeholder={T('section.inventory.filterPlaceholderItems')}`
  edit at InventoryDesktopLayout.tsx:454 (confirmed present by code read) has
  zero regression coverage — a future edit that silently dropped the prop or
  reverted to the untranslated default would not fail any test.
  `PhoneInventoryList.test.tsx` has no placeholder-text assertion either. Code
  read confirms the wiring is correct today; there is simply no automated net
  under it.
- AC-20 (exactly one backend round trip per store view, no N+1) →
  **NOT TESTED.** Code read confirms a single fire-and-forget call site
  (`get().loadItemsLastCounted(sid)` immediately after
  `get().loadMenuCapacity(sid)` inside `loadFromSupabase`, `src/store/useStore.ts:2054`)
  and no per-row `useEffect` anywhere in `InventoryTable.tsx` /
  `InventoryDesktopLayout.tsx` / `PhoneInventoryDetail.tsx` (all three are
  presentational reads off store state / props). But **no test asserts a call
  count** — `grep -rln "fetchItemsLastCounted" src --include="*.test.ts*"`
  returns nothing. Nothing in the delivered test set would fail if a future
  change reintroduced a per-row fetch or a second call per store switch.
- AC-21 (first paint not blocked by the fetch) → **NOT TESTED.** The
  fire-and-forget (`get().loadItemsLastCounted(sid)`, not `await`ed) is
  confirmed by code read, but no test drives a slow/pending
  `fetchItemsLastCounted` promise and asserts the table already rendered rows
  with the AC-9 placeholder before it resolves.
- AC-22 (cached by store id, refetched on switch + existing reload path, not
  on every render/keystroke) → **NOT TESTED at the store-lifecycle level.**
  `grep -rln "lastCounted" src/store --include="*.test.ts*"` returns nothing —
  there is no test on `useStore.ts` itself for `loadItemsLastCounted`
  (success path shape, error path leaving `lastCountedLoaded: false` +
  firing `notifyBackendError`, the `__all__` bail, or the two `loadFromSupabase`
  clear-to-not-loaded branches). The existing
  `src/store/useStore.switching.test.ts` drives `loadFromSupabase` end-to-end
  for the T4/T5 switching-flag cases but its `../lib/db` mock does not stub
  `fetchItemsLastCounted`, so the fire-and-forget tail throws internally on
  every run of that file and the assertion silently never touches the
  spec-160 slice. The client-side cross-store GUARD (map falls back to
  loading when `lastCountedStoreId !== currentStore.id`) IS well tested at the
  render layer (`InventoryDesktopLayout.test.tsx`'s "guards a cross-store map"
  case, `PhoneInventoryDetail.test.tsx`'s equivalent) — but that only proves
  the consumer degrades safely if the store state is stale; it does not prove
  the store itself actually clears-and-refetches on a real switch, or that it
  is NOT re-invoked on filter keystrokes (nothing calls it from the
  `textFiltered` memo, confirmed by code read, but not test-enforced).
- AC-23 (new strings, all 3 catalogs, real translations) → **PASS** —
  `en.json`/`es.json`/`zh-CN.json` diffs show 5 new keys each with distinct,
  real (non-English) es/zh-CN values; `lastCountedCol` reused unchanged as
  required.
- AC-24 (i18n parity) → **PASS** — `src/i18n/i18n.test.ts` passed as part of
  the full jest run (see below); it performs an exact key-set diff across all
  three catalogs, which would fail on any of the five new keys being partial.
- AC-25 (no new hardcoded English in changed cells) → **PASS** — the
  hardcoded `'never'` literal at the old `InventoryTable.tsx:203` is gone
  (code read: replaced by `lastCounted.neverLabel`, a `T()`-resolved prop);
  `InventoryDesktopLayout.tsx`'s meta line no longer hardcodes `"never"` or
  `" ago"`. The two relabel-only surfaces (`InventoryCatalogMode.tsx`,
  `PhoneCatalogList.tsx`) are pre-existing hardcoded-English arrays per the
  architect's explicit scope ruling (§8.3 rows 5/6) and are correctly left
  alone.

### Additional finding — not tied to a formal AC

The architect's design added two RELABEL-ONLY surfaces beyond the spec's
written AC list: `InventoryCatalogMode.tsx` (`last_counted` → `last_edited`
key + `neverEdited` copy) and `PhoneCatalogList.tsx` (`LAST COUNTED` →
`LAST EDITED` label), both confirmed present in the diff. **Neither has any
test coverage** — `InventoryCatalogMode.test.tsx` / `.spec122.test.tsx` have
zero references to `last_counted`/`last_edited`/`neverEdited`, and no
`PhoneCatalogList` test file exists at all (none existed before this spec
either). Per the review prompt's framing ("someone later rewiring the wrong
one would fail a test") — today, nobody would: a future change that
accidentally reverted these relabels, or that mistakenly wired the new
`items_last_counted` data into these BRAND-WIDE catalog surfaces (explicitly
out of scope — catalog.tsv is per-brand, not per-store), would pass the full
suite silently. This is a real gap, but a low-severity one: the architect
flagged both as R9 ("Low" severity, PM-droppable), they are two string
literals with no data-plumbing, and they sit outside the spec's 25 formal
ACs.

### Regression gate — `ingredient_changed_badge.test.sql`

Confirmed via `git diff --cached --stat -- supabase/tests/ingredient_changed_badge.test.sql`
(empty diff) and `git log -1` on that path (last touched by the original spec
128 commit, not this PR) that the file is **byte-unchanged**. Ran it directly
against the local stack: **20/20 assertions pass**, including assertions
14/15 (the never-counted-but-changed → `updated=true` edge that would break
first if the `staff_items_updated` rewrite's `LEFT JOIN` were ever flipped to
an inner join). This is the §0.3 behavior-preservation gate and it holds.

### pgTAP negative control (assertions 11/12)

Verified this is a real, non-trivial control, not a passes-by-construction
assertion. `catalog_ingredients` carries brand-scoped RLS
(`brand_member_read_catalog_ingredients`, confirmed present in
`20260509000000_multi_brand_schema_rls.sql`) gated on `auth_can_see_brand`.
The fixture creates a genuinely separate brand B with its own catalog row,
impersonates a brand-A admin JWT via `set local role authenticated` +
`request.jwt.claims`, and asserts (11) `items_last_counted` still returns the
item whose catalog row is in brand B (count = 1, no catalog join to trip on)
while (12) `staff_items_updated` — unchanged in this dimension, still an
`inner join catalog_ingredients` — drops it (count = 0). Both assertions ran
against a real local Postgres with RLS enforced and passed. If a future
change added a catalog join to `items_last_counted`, assertion (11) would
flip to 0 and fail; if `staff_items_updated`'s catalog join were changed to a
LEFT JOIN, assertion (12) would flip to 1 and fail. The control bites in both
directions.

### countAge.ts boundaries (7d/30d, malformed, future, tz asymmetry)

All requested cases are present and exact in `src/utils/countAge.test.ts`:
the four AC-8 boundaries at hour precision (6d23h/7d00m/29d23h/30d00m), null/
undefined/empty → `never`, unparseable string → `never` (not `fresh` — the
safe-direction rule is asserted, not just implemented), future timestamp →
`fresh`. The timezone asymmetry the review specifically asked about is
directly pinned: `countAgeTone` takes no timezone parameter at all (signature-
level, confirmed by code read), while `formatLastCounted`'s date string is
proven to consume an explicit `timeZone` — the `02:00Z` case asserts `Aug 14`
in `America/New_York` vs `Aug 15` in `UTC` for the SAME instant, and a
separate case proves the same-year comparison (which drives the 2-digit-year
suffix) is evaluated in that timezone, not the test runner's local zone.

### Test run

- `npx jest` → **215/215 suites, 2454/2454 tests passed** (matches the
  developer's reported figures exactly), 2 snapshots passed, 6.4s.
- `npx tsc --noEmit` → clean, exit 0.
- `npm run typecheck:test` → clean, exit 0.
- `npm run test:db` (local Postgres via `scripts/test-db.sh`) →
  **82/82 DB test files passed**, including
  `supabase/tests/items_last_counted.test.sql` (16/16 assertions) and
  `supabase/tests/ingredient_changed_badge.test.sql` (20/20 assertions,
  unedited).
- `git diff --cached --stat -- supabase/tests/ingredient_changed_badge.test.sql`
  → empty (file untouched, confirmed).
- CI on `main` (both gates, prior to this PR): `test.yml` and
  `db-migrations-applied.yml` both green as of the last push
  (run `31995988838` / `31995988875`). This spec's migration
  (`20260817000000_items_last_counted.sql`) is not yet applied to prod —
  expected, since prod-apply is a documented ship-time step (design §1.4),
  not a test-engineer action.

No failing test, no test edited to force a pass, no framework introduced
outside the three in-tree tracks (jest / pgTAP / shell smokes — shell smokes
correctly not used here, per the spec's own Testing section).

### Notes

- **The spec's own AC-7/AC-10 text is superseded by the architect's §0.1
  ruling** (both absolute-date-and-relative-age in the cell, not relative-only;
  absolute dates ARE rendered inline). This is a documented, deliberate
  design decision recorded in the spec file itself, not an unreviewed
  deviation — tests correctly assert the DELIVERED contract (which matches
  §0.1), not the superseded AC wording. Flagging for the release-coordinator's
  awareness, not as a defect.
- **Recommend before merge (not a hard block on its own):** a `useStore.ts`
  unit test for `loadItemsLastCounted` mirroring the existing
  `useStore.switching.test.ts` pattern — mock `db.fetchItemsLastCounted`,
  assert (a) it is called exactly once per `setCurrentStore`/`loadFromSupabase`
  cycle, (b) the error path leaves `lastCountedLoaded: false` +
  `lastCountedByItem: {}` + fires `notifyBackendError` rather than degrading
  to a loaded-empty map, (c) the `__all__` branch never calls it. This is the
  one place in the whole feature where a regression (e.g., someone later
  wiring the fetch into a `useEffect` on `filterText`, or "fixing" the catch
  branch to show an empty-but-loaded map) would ship with the full suite
  green. It is the single largest gap in an otherwise unusually thorough test
  delivery.
- **Recommend:** capture the `placeholder` prop in the `FilterInput` mocks in
  `InventoryDesktopLayout.test.tsx` and add one assertion for
  `filterPlaceholderItems` (AC-19's wiring half); same for
  `PhoneInventoryList.test.tsx`.
- **Optional / PM call, not a blocker:** one smoke assertion each for the two
  relabel-only surfaces (`InventoryCatalogMode.tsx`, `PhoneCatalogList.tsx`)
  so a future accidental revert or accidental data-rewire is caught. The
  architect flagged both as droppable scope additions (R9), so this is a
  nice-to-have, not a spec requirement.

### Verdict

**BLOCK.** AC-20, AC-21, and AC-22 (the entire Performance section) have no
automated test at any layer — not even an incidental one that happens to
exercise the relevant code path. This mirrors the class of gap the prior
spec-159 review correctly blocked on, at a smaller scale: 22 of 25 ACs are
solidly covered with assertions that would genuinely fail on regression
(including, notably, the single most important failure mode named in this
review's brief — AC-9's "never counted while loading" false accusation, which
IS well covered at three layers). AC-19 additionally has a real but narrower
gap (content tested, wiring not). Recommend the developer add the
`loadItemsLastCounted` store-level test described above before this ships;
everything else in the delivery is in good shape and does not need rework.
