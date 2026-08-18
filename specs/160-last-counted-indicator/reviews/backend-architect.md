# Spec 160 — architectural drift review

Reviewer: backend-architect (post-implementation mode)
Spec: [specs/160-last-counted-indicator.md](../../160-last-counted-indicator.md)
Design under review: my own `## Backend design` §0–§13 in that file.
Verdict: **no Critical findings.** 3 Should-fix, 5 Minor. The contract landed
essentially intact, including every one of the five pushbacks.

---

## R1 / §0.3 — the reviewer checkpoint, first

**PASS on both halves.**

1. **The join is a `LEFT JOIN`.**
   [supabase/migrations/20260817000000_items_last_counted.sql:124](../../../supabase/migrations/20260817000000_items_last_counted.sql)

   ```sql
   left join public.items_last_counted(p_store_id) lc on lc.item_id = ii.id
   ```

   `create or replace` with no `drop` (line 106); the `returns table(...)` at
   :107 is byte-identical to spec 128's :102; the `catalog_ingredients` inner
   join (:120) and the `greatest()` `changed_at` cross-lateral (:121-123) are
   unchanged; `updated` is still derived from the same `last_counted_at`
   (:117-118). The one and only way this refactor could have silently broken
   the live staff badge — an inner join dropping never-counted items — did not
   happen.

2. **`supabase/tests/ingredient_changed_badge.test.sql` is unedited.**
   No occurrence of `160` or `items_last_counted` anywhere in the file; it still
   declares `plan(20)` at :39; and in a mtime-ordered listing of
   `supabase/tests/*.sql` it sits at its original 2026-07-22 position (between
   `ingredient_photos.test.sql` and `vendors_role_access.test.sql`), while the
   only file at the tail is the new `items_last_counted.test.sql`. Developer
   reports 20/20 green and 82/82 files green. The behavior-preservation gate
   held; the generalization was behavior-preserving.

---

## 1. Generalize-by-extraction (§0.2 / §1.1) — PASS

Diffed the union block character-for-character:
`20260817000000_items_last_counted.sql:78-91` vs
`20260722000000_ingredient_changed_badge.sql:119-132`. **Identical**, including
the `left join lateral (` opener, the `union all`, the two `where` clauses'
leading single-space indentation, and the `) lc on true` closer. Nobody "tidied"
it into a `group by`.

- No `catalog_ingredients` join in `items_last_counted` — driver is
  `inventory_items` alone (:77, :92), so row presence is never load-bearing and
  a dangling/RLS-invisible catalog row cannot make an item vanish. This is
  pinned by pgTAP arms 11/12, with `staff_items_updated` used as the negative
  control exactly as §0.2 argued
  ([supabase/tests/items_last_counted.test.sql:243-255](../../../supabase/tests/items_last_counted.test.sql)).
- `language sql` / `stable` / `security invoker` / `set search_path = public`
  (:69-72) — matches §1.1 and mirrors spec 128.
- Grants mirror spec 128 exactly (:95-96 vs 128's :136-137).
- 16 pgTAP assertions covering structure, both sources, both draft exclusions,
  never ⇒ NULL, cardinality, the catalog-drop pair, per-store isolation both
  directions, RLS empty-set, grants. Grants are asserted via
  `has_function_privilege`, correctly avoiding the `set local role anon` +
  `throws_ok` pattern that segfaulted CI (spec 045/067).

## 2. 124px and the collapse-tier arithmetic (§6) — PASS, numbers verified

`COL_STYLE` at [InventoryTable.tsx:113-122](../../../src/components/cmd/InventoryTable.tsx):
`onHand 200 / status 84 / lastCounted 124 / costEach 116 / stockValue 108 /
vendor 150 / category 130`, `name` still `flex: 1`. Recomputing the non-name
budget as Σfixed + (n−1)×12 + 32:

| Tier | Old (spec 112) | New | Δ to `name` |
|---|---|---|---|
| ≥1400, 8 cols | 788+84+32 = **1008** | 912+84+32 = **1028** | −20 (392 → 372) |
| 1200–1399, 7 cols | 788+72+32 = **892** | 782+72+32 = **886** | **+6** (308 → 314) |
| floor, 6 cols | 658+60+32 = **750** | 632+60+32 = **724** | **+26** (350 → 376) |

Exactly the §6.3 prediction: the owner's 1200–1399 band gains 6px and the floor
gains 26px; only the ≥1400 tier tightens, entirely out of the flex column, to
372px ≈ 57 chars. `visibleColumnsForWidth` (:56-64) matches §6.4 including the
deliberately unbounded floor `else`, and the header doc comments at :34-37 and
:48-55 were rewritten rather than left describing the spec-112 order. Browser
verification reported `scrollWidth == clientWidth == 124` for the es/zh-CN worst
cases, so R5's "bump to 132" escape hatch was correctly not taken.

## 3. Six-surface split (§8.3) — PASS, all six

| # | Surface | Ruling | Delivered |
|---|---|---|---|
| 1 | InventoryTable cell | REWIRE | :242-291, one `<Text numberOfLines={1}>`, tone map at :141-146, hardcoded `'never'` gone |
| 2 | Desktop `last_counted` property row | REWIRE | InventoryDesktopLayout.tsx:823, `style:'long'` |
| 3 | Desktop meta line | REWIRE + `" ago"` bug fix | :831 via new `lastCountedMeta`, no trailing `" ago"` |
| 4 | PhoneInventoryDetail `LAST COUNTED` | REWIRE, reads slice itself, guarded on `item.storeId` | :45-48, :86-95, :104 |
| 5 | InventoryCatalogMode | RELABEL → `last_edited` + `neverEdited` | :743 |
| 6 | PhoneCatalogList | RELABEL → `LAST EDITED` | :81 |

`item.lastUpdatedAt` is no longer read in `InventoryDesktopLayout` (only
referenced in an explanatory comment at :802), and `ExportCsvDrawer` still
exports it honestly as `updated_at`. §9.4's optional phone-list filter wiring was
also taken (PhoneInventoryList.tsx:103-105, :121-138), so the advertised
`counted:` token is not a dead end on the surface that renders the new
placeholder.

## 4. AC-19 correction (§9.5) — PASS

New key `section.inventory.filterPlaceholderItems` exists in all three catalogs
(en/es/zh-CN line 538) with the localized example value, and is wired explicitly
at [InventoryDesktopLayout.tsx:492](../../../src/screens/cmd/InventoryDesktopLayout.tsx)
(the `FilterInput` that previously fell through to `FilterInput`'s hardcoded
English default) and at PhoneInventoryList.tsx:239.
`section.inventory.filterPlaceholder` is **untouched** — still
`cat:protein vendor:sysco` / `cat:proteína vendor:sysco` / `cat:蛋白 vendor:sysco`
at line 479 of each catalog. The other four consumers of the old key are
unaffected.

## 5. Timezone ruling (§8.1) — PASS

[src/utils/countAge.ts](../../../src/utils/countAge.ts):
`countAgeTone(lastCountedAt, now)` (:51-62) takes **no** timezone and does pure
elapsed-ms arithmetic against `COUNT_STALE_DAYS`/`COUNT_COLD_DAYS` × 86 400 000
— DST-invariant, as ruled. `formatLastCounted` formats the absolute date through
`Intl.DateTimeFormat(locale, { timeZone, … })` (:87-99) with the same-year test
itself evaluated **in** `timeZone` via `yearIn()` (:78-85). `getNowInTZ()` is not
imported anywhere in the module (and the header comment at :20-22 records why).
Degenerate inputs land as specified: null/''/undefined → `never`, unparseable →
`never` (safe direction), future → `fresh`. `countAge.test.ts` pins all four
AC-8 boundaries plus the `02:00Z` → previous-day-in-New-York property with a UTC
control.

## 6. Read path (§3 / §5) — PASS

- `fetchItemsLastCounted` at [db.ts:1466-1482](../../../src/lib/db.ts): inside
  `useInflight.track` with `.abortSignal(signal)`, `if (error) throw error`
  (:1474) — **throws, does not degrade to `[]`**, with the rationale committed
  in the docstring. `last_counted_at` mapped with `?? null`, never coerced to
  `''`. Single RPC call site in the repo (grep for `items_last_counted` returns
  db.ts:1471 and comments only) — nothing bypasses `db.ts`.
- `loadItemsLastCounted` (useStore.ts:4491-4513): `__all__` bail, keyed reduce,
  and the error branch sets `{ byItem: {}, storeId: null, loaded: false }` +
  one `notifyBackendError('Load last counted', e)` — so cells show `—`
  indefinitely, never "never counted", never a stale store's dates.
- Wiring: cleared in both `loadFromSupabase` branches (:1970-1972 `__all__`,
  :2042-2044 per-store) and fired **unawaited** at :2054 immediately after
  `loadMenuCapacity(sid)`. AC-20/21/22 hold.
- Cross-store guard present on all three consumers (`lastCountedReady` at
  InventoryDesktopLayout:178, PhoneInventoryList:121, PhoneInventoryDetail:86).
- `matchesFilter`'s 5th optional positional (`filterParser.ts:72`) returns
  `false` for any `counted:` token when `countedTone === undefined`, so a
  loading/errored slice matches zero rows rather than every row. Only three
  call sites exist and both production ones pass the precomputed tone.

## 7. Realtime (§7) — PASS

No `alter publication` in the migration (grepped: zero matches for
`alter publication`, `create policy`, `create index`). No change to
`useRealtimeSync.ts`. EOD remains live-for-free through the existing
`store-{id}` channel → 400 ms debounce → `loadFromSupabase` → the
fire-and-forget tail. `inventory_counts` was correctly left off the store
channel. **No `docker restart supabase_realtime_imr-inventory` step is required
for this spec** — worth stating in the release notes precisely because the spec
raised it as a risk.

## 8. Out-of-contract list — HELD

No edge function added or modified; no `supabase/config.toml` change (grepped
for `160` / `last_counted` — zero matches); no new RLS policy; no index; no
`drop function`; no `app.json` change. Exactly one new migration on disk after
`20260809000000_super_admin_policy_parity.sql`, so ordering is clean locally and
in prod.

---

# Findings

## Critical

None.

## Should-fix

**S1 — The migration is not in prod; `db-migrations-applied` will hard-fail on
`main` the moment this merges.**
`supabase/migrations/20260817000000_items_last_counted.sql` is reported applied
to the local stack only ("prod apply is a separate ship-time step"). Per
CLAUDE.md this gate is an independent signal and blocks SHIP_READY. Apply via
Supabase MCP `execute_sql` on project `ebwnovzzkwhsdxkpyjka` **plus** an explicit
`supabase_migrations.schema_migrations` insert of the exact version string
`20260817000000`, then verify both gates green before the pipeline continues.
Ordering is safe in either direction: the migration is function-only,
`items_last_counted` has no prod callers until the web bundle ships, and
`staff_items_updated` is behaviorally identical the instant it lands — so
applying it **before** the frontend deploy is the correct sequence.

**S2 — §5.4 (refresh after an admin-side count submit) was skipped, and the hook
it needed is one line away.**
[InventoryCountSection.tsx:457-466](../../../src/screens/cmd/sections/InventoryCountSection.tsx)
already owns a section-local `inventory_counts` realtime channel whose only job
is `setRefreshTick((t) => t + 1)`, and the submit success path sits at :1141.
Because `inventory_counts` is deliberately off the global store channel (§7.2),
an admin who submits a spot/weekly count from the admin UI sees the Inventory
column keep its old value until the next `loadFromSupabase` — i.e. the one count
the admin performs themselves is the one the column does not reflect. My design
made this optional with a "skip it if you can't find the hook in one read"
escape; the hook exists and is unambiguous, so I'd take it now:
`void useStore.getState().loadItemsLastCounted(storeId)` alongside the existing
`setRefreshTick` bump. Not a contract violation — a cheap loop-closing follow-up.

**S3 — "last counted never counted" (the developer's own flag #1).**
The composition is exactly what §8.3 row 3 specified (`lastCountedMeta` =
`"last counted {value}"` + `neverLabel` = `"never counted"`), so this is faithful
implementation, not drift — but the design was wrong about how it would read.
Correct minimal fix, no new key and no plumbing: in `DetailPane`
([InventoryDesktopLayout.tsx:831](../../../src/screens/cmd/InventoryDesktopLayout.tsx)),
skip the `lastCountedMeta` wrapper when the value is the never phrase, yielding
`Dairy & Sauce · SYSCO · never counted`. That reads correctly in all three
catalogs (`nunca contado`, `从未盘点`) whereas swapping in a bare "never" does
not survive translation as cleanly. One ternary. The desktop properties row
(`last_counted "never counted"`) and both phone rows already read fine and should
not change. PM call on the copy; the mechanism is a one-liner either way.

## Minor

**M1 — My §1.2 inlining claim is wrong, and §0.3's perf claim follows it down.**
`items_last_counted` carries `set search_path = public`, so `pg_proc.proconfig`
is non-null and `inline_set_returning_function()` refuses to inline it. The
function therefore executes as a separate function scan inside
`staff_items_updated`, and because the union block was copied verbatim as a
`left join lateral` (correctly — textual identity was the instruction), the
staff badge still performs one correlated lateral per item; it did **not** become
"one grouped scan joined once". The developer implemented what I asked; the
design prose was inaccurate. No action: measured 13.2 ms / 11.9 ms against a
synthetic year of history (~52 400 `eod_entries`), which is well inside budget,
and `search_path` pinning is not negotiable. Flagged so the claim is not carried
forward as fact into a future perf spec.

**M2 — Loading-cell a11y label is undefined when the prop bundle is absent.**
[InventoryTable.tsx:252](../../../src/components/cmd/InventoryTable.tsx) uses
`accessibilityLabel={lastCounted?.loadingLabel}`, so a host that renders the
table with no `lastCounted` prop at all announces a bare `—`. Unreachable from
production today (both hosts always pass the bundle) and a consequence of keeping
the component presentational, which was the right call. Note only.

**M3 — `now` is not re-anchored in the two detail panes.**
`DetailPane` (InventoryDesktopLayout.tsx:807) and `PhoneInventoryDetail`
(:90) call `new Date()` inline per render rather than consuming the memoized
`lastCountedNow`. Harmless: in `style: 'long'` the anchor only feeds the
same-year test, never a tone or a threshold. The table cell — the only
tone-graded surface — does use the memoized anchor (:599).

**M4 — `counted:stale` is implemented as "not fresh" rather than the enumerated
set.** [filterParser.ts:90-91](../../../src/utils/filterParser.ts) returns false
only for `countedTone === 'fresh'`. Behaviorally identical to
`∈ {stale, cold, never}` across today's four-value union, but a future fifth tone
would silently join `stale`. A one-line comment or an explicit set would pin the
intent.

**M5 — pgTAP arm ordering reads out of sequence.** In
[items_last_counted.test.sql](../../../supabase/tests/items_last_counted.test.sql)
arm (15) executes between (12) and (13) so the JWT-impersonation block can be
torn down once. Correct and deliberate (the header comment explains it), but a
reader diffing assertion numbers against execution order will stumble. Cosmetic.

---

# Pushback scorecard

All five design-time pushbacks were honored:

| Pushback | Outcome |
|---|---|
| AC-14's "104px, budget unchanged" is false | Corrected to 124px; the three-tier arithmetic lands exactly as re-derived (§6.3), verified against `COL_STYLE` |
| AC-19 names the wrong key | New `filterPlaceholderItems` wired at the two surfaces that resolve `counted:`; `filterPlaceholder` untouched |
| The four-surface list is incomplete | Six surfaces delivered — four rewired, two relabelled to `last_edited` / `LAST EDITED` |
| AC-10's "no inline absolute date" is superseded by §0.1 | Cell renders `Aug 14 · 3d` as one `Text` leaf; the a11y long form carries `August 14, 2026 · 3d` via the `{date}` template |
| Tier-test churn is intended, not a regression signal | Tier assertions rewritten in exactly the two predicted files; the §6.5 stop condition (a failure in `phone/__tests__`, `itemMoney`, or `inventoryStatusView`) was not tripped — full jest reported 215/215 suites green |

# The two flagged-not-patched items

**"last counted never counted"** — see S3. Faithful to the design; the design was
the problem. One-ternary fix proposed, PM owns the copy call.

**`name` compressing to ~0 with the detail pane open at 1300px** — the
developer's read is correct and matches the §6.3 prediction. At the floor tier
the fixed budget genuinely drops 658 → 632 px (recomputed above), so `name` gains
26px; spec 160 makes this band strictly better, not worse. The residual squeeze
is arithmetic that predates this spec: with the pane taking 620px plus chrome, a
1300px window leaves the list well under the ~724px the six-column floor needs,
and `visibleColumnsForWidth`'s floor branch is unbounded below by design (it was
before this spec too). The real fix is an ultra-floor tier — drop `stockValue` /
`costEach` below ~900, or fall back to the `InventoryRow` card when the pane is
open — which is new layout behavior and belongs in its own spec, not smuggled in
here. Correctly flagged rather than patched.

---

# Contract compliance summary

| Design section | Status |
|---|---|
| §0.3 / R1 — LEFT JOIN + unedited gate test | PASS |
| §1.1 / §1.2 — extraction, verbatim block, byte-identical signature | PASS |
| §1.3 — no index added | PASS |
| §2 — no new/changed RLS policy | PASS |
| §3 — RPC contract, helper throws | PASS |
| §4 / §5 — db.ts + store slice, 3 fields, unawaited tail | PASS |
| §6 — 124px, AC-13 order, new tiers, doc comments | PASS |
| §7 — no publication change, EOD live, `inventory_counts` not live | PASS |
| §8 — countAge module, cell, six surfaces | PASS |
| §9 — `counted:` parse/match, RecipesSection comment + test, phone list, AC-19 key | PASS |
| §10 — five keys × three catalogs, `lastCountedCol`/`neverEdited` reused | PASS |
| §11 — new pgTAP file + unedited gate | PASS |
| §5.4 — optional post-submit refresh | SKIPPED (S2) |
| §12 R2 — prod apply | OUTSTANDING (S1) |
