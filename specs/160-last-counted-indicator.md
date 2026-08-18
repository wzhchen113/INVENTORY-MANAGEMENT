# Spec 160: Truthful "last counted" indicator on admin Inventory

Status: READY_FOR_REVIEW

## Context the architect must read first

The admin Inventory table **already has a `lastCounted` column** (spec 112,
[src/components/cmd/InventoryTable.tsx:200](../src/components/cmd/InventoryTable.tsx)).
It is backed by the wrong value:

```tsx
case 'lastCounted':
  return ( ... {relativeTime(it.lastUpdatedAt) || 'never'} ... );
```

`item.lastUpdatedAt` is `inventory_items.updated_at` mapped to a *locale
string* at [src/lib/db.ts:5999](../src/lib/db.ts) — it moves on **any** row
edit (price change, par change, vendor swap, stock adjust), not on a physical
count. So today the column silently reports "last edited" under a "last
counted" header. Three other surfaces repeat the same wrong value:

| Surface | Line |
|---|---|
| Desktop table cell | [src/components/cmd/InventoryTable.tsx:200](../src/components/cmd/InventoryTable.tsx) |
| Desktop detail pane, `last_counted` prop row | [src/screens/cmd/InventoryDesktopLayout.tsx:751](../src/screens/cmd/InventoryDesktopLayout.tsx) |
| Desktop detail pane, meta line ("… last counted X ago") | [src/screens/cmd/InventoryDesktopLayout.tsx:754](../src/screens/cmd/InventoryDesktopLayout.tsx) |
| Phone detail `LAST COUNTED` prop row | [src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx:79](../src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx) |

Second reason the user cannot see this today: the column is the **first one
dropped** by the width-collapse tiers — `visibleColumnsForWidth` drops
`lastCounted` below a 1400px list width, and the user's screenshot shows 7
columns (so their list width is in the 1200–1399 band). Even the wrong value
is invisible to them.

**Prior art — the aggregate already exists.** Spec 128 shipped
`public.staff_items_updated(p_store_id)`
([supabase/migrations/20260722000000_ingredient_changed_badge.sql:101-134](../supabase/migrations/20260722000000_ingredient_changed_badge.sql)),
which already computes, in **one set-based query per store**, exactly the
semantics this spec wants:

> `last_counted_at = max(submitted_at)` over the UNION of SUBMITTED eod counts
> (`eod_submissions ⨝ eod_entries`) and SUBMITTED `inventory_counts ⨝
> inventory_count_entries`, per `(store, item)`; NULL when never counted.

pgTAP already pins those semantics
([supabase/tests/ingredient_changed_badge.test.sql](../supabase/tests/ingredient_changed_badge.test.sql),
assertions 15 / 19). The architect decides whether to reuse, generalize, or
sibling this function — but **do not invent different count semantics**; a
divergence between the staff "Updated" badge and the admin "last counted"
column would be a bug.

## User story

As a store manager on the admin Inventory page, I want each ingredient row to
show when it was last physically counted — and to say "never counted" when it
never has been — so that I can trust the on-hand number in front of me and go
find the rows nobody has ever verified.

## Acceptance criteria

### Data correctness

- [ ] AC-1 The displayed value is derived from **count history**, never from
  `inventory_items.updated_at` / `item.lastUpdatedAt`. Editing an item's price,
  par, vendor, or category does NOT change its last-counted value.
- [ ] AC-2 The value is `max(submitted_at)` over **both** count sources for the
  `(store, item)` pair: `eod_submissions ⨝ eod_entries` and `inventory_counts ⨝
  inventory_count_entries` (all `kind` values: `spot`, `open`, `mid_shift`,
  `close`, and the weekly kind). Semantics are byte-identical to
  `staff_items_updated`'s `last_counted_at`.
- [ ] AC-3 Only rows with `status = 'submitted'` contribute. A `draft` EOD
  submission or a `draft` inventory count does NOT set the date.
- [ ] AC-4 Scope is per `(item, store)`. An item counted at Towson but never at
  Charles reads "never counted" while the Charles store is active.
- [ ] AC-5 An item with no qualifying count in any source resolves to NULL from
  the backend and renders as the localized **"never counted"** string.
- [ ] AC-6 Per-store visibility is enforced **server-side** (RLS /
  `auth_can_see_store()`), not by client-side filtering. A caller who cannot see
  a store gets no last-counted rows for it.

### Display

- [ ] AC-7 The desktop table cell renders `relativeTime(lastCountedAt)` — the
  existing terse form (`3h`, `2d`, `2mo`) from
  [src/utils/relativeTime.ts](../src/utils/relativeTime.ts) — for counted items,
  and the localized "never counted" phrase for never-counted items. No bare `—`
  and no empty cell for either case.
- [ ] AC-8 Freshness is visually graded by a single exported pure function
  (e.g. `countAgeTone(lastCountedAt, now)`) returning exactly one of
  `'fresh' | 'stale' | 'cold' | 'never'`:
  - `fresh` — counted < 7 days ago → muted tone (`C.fg3`, today's styling).
  - `stale` — counted ≥ 7 and < 30 days ago → warning tone.
  - `cold` — counted ≥ 30 days ago → danger tone.
  - `never` — no count ever → danger tone **and** the words "never counted".
  Thresholds are named constants in one module; jest asserts each boundary
  (6d23h → fresh, 7d exactly → stale, 29d23h → stale, 30d exactly → cold).
- [ ] AC-9 While the last-counted data is still loading, the cell renders a
  neutral placeholder (`—`, `fresh`-toned) — **never** "never counted".
  Loading must not be indistinguishable from a true never-counted row.
- [ ] AC-10 Each cell carries an `accessibilityLabel` containing the absolute
  date (e.g. `last counted 2026-08-14`) or the localized never-counted phrase,
  so the terse `3d` glyph has a non-visual long form. Absolute dates are NOT
  rendered inline in the 104px cell.
- [ ] AC-11 The desktop detail pane shows the absolute date **and** the relative
  age — the `last_counted` prop row at
  [InventoryDesktopLayout.tsx:751](../src/screens/cmd/InventoryDesktopLayout.tsx)
  and the meta line at :754 both consume the new value, not `lastUpdatedAt`.
- [ ] AC-12 The phone detail `LAST COUNTED` row
  ([PhoneInventoryDetail.tsx:79](../src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx))
  consumes the same new value. Desktop and phone never disagree for the same
  item + store.

### Column layout

- [ ] AC-13 `visibleColumnsForWidth` display order becomes:
  `name, onHand, status, lastCounted, costEach, stockValue, vendor, category`.
  Last-counted sits next to the number it qualifies (ON HAND / STATUS).
- [ ] AC-14 Collapse tiers are re-prioritized so `lastCounted` survives the
  bands the user actually runs at:
  - `≥ 1400` → all 8 columns.
  - `1200–1399` → drop `category` (7 columns; `lastCounted` survives).
  - `1100–1199` → drop `category` + `vendor` (6 columns, floor; `lastCounted`
    survives).
  Column width stays 104px, so the ≥1400 width budget is unchanged. The
  existing tier assertions in
  [InventoryTable.test.tsx](../src/components/cmd/InventoryTable.test.tsx) and
  [InventoryDesktopLayout.test.tsx](../src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx)
  pin the OLD order and MUST be updated — that is an intended behavior change,
  not a regression to work around.

### Filtering

- [ ] AC-15 [src/utils/filterParser.ts](../src/utils/filterParser.ts) gains one
  key, `counted:`, with exactly two accepted values:
  - `counted:never` → only items with no count ever.
  - `counted:stale` → items whose tone is `stale`, `cold`, **or** `never`
    (i.e. "not counted in the last 7 days, including never").
- [ ] AC-16 `counted:<anything else>` matches zero rows (same shape as an
  unknown `status:` value today). It does NOT fall through to a name search.
- [ ] AC-17 The `counted:` filter and the column tone read from the **same**
  source of truth — the threshold constants are not duplicated in the matcher.
- [ ] AC-18 `counted:` ANDs with the existing tokens and the status chip:
  `counted:never cat:produce` returns produce items never counted.
- [ ] AC-19 The Inventory filter placeholder
  (`section.inventory.filterPlaceholder`, currently `cat:protein vendor:sysco`)
  advertises the new token in all three catalogs.

### Performance

- [ ] AC-20 The whole page's last-counted data is fetched with **one** backend
  round trip per store view. No per-item query, no N+1, no per-row `useEffect`
  fetch. With ~149 items the request count attributable to this feature is
  exactly 1.
- [ ] AC-21 First paint of the Inventory table is not blocked by this fetch —
  rows render immediately from existing store state, with AC-9's placeholder,
  and fill in when the aggregate resolves. No measurable regression in the
  section's existing time-to-first-row.
- [ ] AC-22 Results are cached in the admin Zustand store keyed by store id and
  refetched on store switch and on the section's existing reload path — not on
  every render or every keystroke in the filter box.

### i18n

- [ ] AC-23 New user-visible strings exist in **all three** catalogs
  ([en.json](../src/i18n/en.json), [es.json](../src/i18n/es.json),
  [zh-CN.json](../src/i18n/zh-CN.json)) with **real translations**, not English
  fallbacks: at minimum the "never counted" phrase and the accessibility long
  form. The existing column header key `section.inventory.lastCountedCol`
  already exists in all three and is reused unchanged.
- [ ] AC-24 [src/i18n/i18n.test.ts](../src/i18n/i18n.test.ts) parity passes.
- [ ] AC-25 No new hardcoded English literal ships in the changed cells — the
  current hardcoded `'never'` at InventoryTable.tsx:203 is replaced by a
  catalog lookup.

## In scope

- Backend aggregate producing per-`(store, item)` `last_counted_at` with the
  spec-128-identical union semantics, RLS-scoped, one call per store.
- Plumbing through [src/lib/db.ts](../src/lib/db.ts) (the DB-access convention;
  no direct `supabase.from/rpc` outside the documented carve-outs) into the
  admin Zustand store.
- Desktop Inventory table: correct value, tone grading, never-counted copy,
  a11y label, new column order + collapse tiers.
- Desktop Inventory detail pane: `last_counted` prop row + meta line.
- Phone Inventory **detail** prop row (`PhoneInventoryDetail.tsx:79`) —
  in scope because it already claims the "LAST COUNTED" label and would
  otherwise disagree with desktop.
- `counted:never` / `counted:stale` filter token.
- i18n keys in all three catalogs.
- jest + pgTAP coverage (see Testing).

## Out of scope (explicitly)

- **Per-column sorting.** The list is sorted urgency-then-name by
  `applyInventoryStatusView`; adding sort to one column invites it on all eight
  and would fight that contract. Separate spec.
- **A last-counted column on the phone Inventory *list***
  ([PhoneInventoryList.tsx](../src/screens/cmd/sections/phone/PhoneInventoryList.tsx))
  and on the `<1100` narrow-tier
  [InventoryRow](../src/components/cmd/InventoryRow.tsx) card. Neither shows a
  last-counted value today; adding one is new surface area, not a correction.
- **The catalog.tsv (brand-wide) tab.** Last-counted is per-store by definition;
  a brand-wide roll-up is a different product question.
- **Thresholds derived from the store's weekly-count cadence** (`due_dow` from
  `weekly_count_status`, spec 098). v1 uses fixed 7d / 30d constants. Making the
  stale threshold cadence-aware is a follow-up.
- **Alerts / notifications / a "stale count" dashboard KPI.** This spec makes
  the signal visible on Inventory; it does not push it anywhere.
- **Backfilling or writing a `last_counted_at` column** on `inventory_items`.
  The value stays derived; a denormalized column is a perf optimization the
  architect may propose only if AC-20/AC-21 cannot otherwise be met, and would
  need its own migration + trigger review.
- **Changing what `lastUpdatedAt` means or removing it.** It is still correct
  data for "last edited"; it is only wrong *under this label*. Other consumers
  ([ExportCsvDrawer](../src/components/cmd/ExportCsvDrawer.tsx),
  [InventoryCatalogMode](../src/screens/cmd/sections/InventoryCatalogMode.tsx),
  [PhoneCatalogList](../src/screens/cmd/sections/phone/PhoneCatalogList.tsx))
  keep using it unchanged.
- **`app.json` slug.** Untouched (see CLAUDE.md "DO NOT AUTO-FIX").

## Open questions resolved

- Q: Which count source marks an item as counted — EOD, inventory counts, or
  both? → **A (user, locked): both.** Any physical count sets the date —
  nightly EOD plus `spot` / `open` / `mid_shift` / `close`. "Never counted"
  means no count of any kind has ever recorded that item.
- Q: Build path? → **A (user, locked): full agent pipeline.**
- Q: Do draft counts count? → **A: no — `status = 'submitted'` only.** Carried
  from main Claude's stated assumption, uncontradicted. Matches the existing
  `staff_items_updated` semantics, so choosing otherwise would fork the two.
  *(Flagged as confirmable but not architecture-blocking.)*
- Q: Is scope per (item, store) or per item across stores? → **A: per (item,
  store).** Carried from main Claude's stated assumption, uncontradicted; also
  the only reading consistent with per-store RLS and with an on-hand number
  that is itself per-store.
- Q: Absolute date, relative age, or both? → **A: relative in the 104px cell
  (`3d`), absolute in the detail pane and in the a11y label.** The request said
  "date", but the operational value is *staleness*, and the cell has 104px.
- Q: Should age be visually graded? → **A: yes — 4 tones, fresh/stale/cold/never
  (AC-8).** A flat gray column would answer "when" but not "is this a problem",
  which is the actual reason to look.
- Q: Sortable and/or filterable? → **A: filterable in v1 (`counted:never`,
  `counted:stale`); sorting out of scope** with the rationale above.
- Q: Where does the column go and what gives? → **A: 4th position; `category`
  gives at 1200–1399, `vendor` also gives at the 1100–1199 floor.** Nothing is
  added to the ≥1400 width budget because the 104px column already exists.
- Q: Phone tier in or out? → **A: phone detail in (it already shows the wrong
  value under this exact label); phone list out.**

## Dependencies

- `public.staff_items_updated(p_store_id)` and its migration
  [20260722000000_ingredient_changed_badge.sql](../supabase/migrations/20260722000000_ingredient_changed_badge.sql)
  — reference semantics, possible reuse target.
- `public.eod_submissions` / `eod_entries`, `public.inventory_counts` /
  `inventory_count_entries` — the two count sources.
- Per-store RLS hardening
  ([20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql))
  / `auth_can_see_store()`.
- [src/lib/db.ts](../src/lib/db.ts), [src/store/useStore.ts](../src/store/useStore.ts)
  — loader + cached slice. Spec 159's `fetchXForStores(storeIds, since)`
  cross-store loaders are usable prior art for the loader shape; **spec 159's
  scope picker itself is not part of this spec.**
- [src/utils/relativeTime.ts](../src/utils/relativeTime.ts) (already used on
  Dashboard and by the current column).
- [src/utils/filterParser.ts](../src/utils/filterParser.ts) — **shared with
  [RecipesSection](../src/screens/cmd/sections/RecipesSection.tsx)**; adding a
  key to `KEY_ALIASES` changes parsing there too (a literal `counted:x` typed
  into the recipe search would stop being a name token). Low risk, but the
  architect should confirm the key is only *matched* on inventory rows.
- Existing tests that will need updating: `InventoryTable.test.tsx`,
  `InventoryDesktopLayout.test.tsx`, `PhoneInventoryDetail.test.tsx`,
  `PhoneInventory.acReg.test.tsx`.

## Testing

- **jest** — tone-threshold boundaries (AC-8), cell rendering for
  counted / never / loading (AC-7, AC-9), a11y label (AC-10), new column order
  + collapse tiers (AC-13/14), `counted:` parse + match incl. the unknown-value
  case (AC-15/16/18), i18n parity (AC-24).
- **pgTAP** — if a new or modified RPC/view lands: both sources union,
  submitted-only exclusion of drafts, per-store isolation (counted at store A ⇒
  NULL at store B), never-counted ⇒ NULL, and RLS invisibility ⇒ empty set.
  Mirror the existing assertions in
  [supabase/tests/ingredient_changed_badge.test.sql](../supabase/tests/ingredient_changed_badge.test.sql)
  rather than re-deriving them.
- **shell smokes** — not required.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI —
  [src/screens/cmd/sections/InventoryCountSection.tsx](../src/screens/cmd/sections/InventoryCountSection.tsx)
  → [src/screens/cmd/InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx)
  → [src/components/cmd/InventoryTable.tsx](../src/components/cmd/InventoryTable.tsx).
  No legacy admin surface (deleted in spec 025).
- **Per-store or admin-global:** per-store. Server-side scoping via
  `auth_can_see_store()`; the active store comes from the existing
  `currentStore.id` used by `storeInventory`.
- **Realtime channels touched:** reads only. If the architect wants the column
  to move live when staff submit a count, that needs `eod_submissions` /
  `inventory_counts` in the realtime publication — **risk:** mid-session
  publication changes require `docker restart supabase_realtime_imr-inventory`
  to re-snapshot the slot (the known publication gotcha), and adding tables to
  the publication is a prod change. v1 target is refresh on store switch +
  the section's existing reload path; live-on-submit is optional and must be
  called out explicitly if taken.
- **Migrations needed:** likely yes (new or generalized RPC). Architect decides
  reuse-vs-new. Any migration must be applied to prod and pass the
  `db-migrations-applied` gate.
- **Edge functions touched:** none expected. This is PostgREST/RPC territory —
  no service-token surface, no new public endpoint.
- **Web/native scope:** both. Desktop web is the primary surface; the phone-tier
  detail row is in scope, and nothing here is web-only (no CSS/web-push).
- **app.json slug:** untouched.

---

# Backend design

Author: backend-architect (design mode). Supersedes the spec's §format position
per the user decision recorded in §0 below.

## 0. Decisions taken before anything else

### 0.1 User decision that supersedes the spec

The table cell shows **BOTH** the absolute date AND the relative age, together:
`Aug 14 · 3d`. This overrides the "Open questions resolved" entry that chose
relative-only, and it overrides **AC-10's** parenthetical "Absolute dates are
NOT rendered inline in the 104px cell". The a11y long form (AC-10's substance)
still stands, and the 104px width budget does not — re-derived in §6.

Everything else the user re-affirmed stands unchanged: the 4-tone colour grading
(`fresh` < 7d muted / `stale` 7–30d warn / `cold` ≥ 30d danger / `never` danger +
literal words), and AC-9's "loading shows `—`, **never** 'never counted'".

### 0.2 Reuse / generalize / sibling — the ruling

**GENERALIZE, by extraction.** Not reuse-as-is, not a sibling copy.

- Add `public.items_last_counted(p_store_id uuid)` containing the union
  aggregate **verbatim** from
  [20260722000000_ingredient_changed_badge.sql:119-132](../supabase/migrations/20260722000000_ingredient_changed_badge.sql).
- Rewrite `public.staff_items_updated(p_store_id)` to consume it, via
  `create or replace` with a **byte-identical signature and return table**.

Why not each alternative:

| Option | Rejected because |
|---|---|
| **Reuse `staff_items_updated` from admin db.ts** (zero migration) | Cheapest, and it does satisfy AC-1..AC-6/AC-20 today. Rejected on two grounds. (a) It `join`s `catalog_ingredients` **inner** — an `inventory_items` row whose `catalog_id` is dangling or whose catalog row is RLS-invisible is silently **omitted from the result set**, and the admin client cannot distinguish "omitted" from "never counted" (an AC-9 violation delivered by the backend rather than the frontend). (b) It couples a live admin column to a function whose return table a future staff spec may change; that change would be a `drop`+`create`, and the admin surface would break with no compile-time signal. |
| **Sibling function with copy-pasted union SQL** | This is the fork the prompt forbids. Two textually-identical definitions drift on the first one-sided edit; nothing in CI compares them. |
| **Denormalized `inventory_items.last_counted_at` column + trigger** | Explicitly out of scope in the spec unless AC-20/AC-21 cannot otherwise be met. They can (§4). Not taken. |

### 0.3 Can the staff "Updated" badge change as a side effect?

The staff badge is live ([src/screens/staff/lib/itemsUpdated.ts](../src/screens/staff/lib/itemsUpdated.ts),
consumed by the EOD + Weekly count screens). It **must not** change. Three
things make that true, and one of them is the review checkpoint:

1. **Signature and return table are unchanged**, so `create or replace`
   succeeds without a `drop`. There is no window in which the RPC is absent.
   *If the developer finds themselves needing `drop function` — stop. That means
   the return table changed, which is out of contract for this spec.*
2. **The `updated` boolean is derived from the same `last_counted_at`**, so if
   `last_counted_at` is preserved the badge is preserved by construction.
3. **The join to `items_last_counted` MUST be a `LEFT JOIN`.** This is the one
   and only way this refactor can silently break the staff surface: an inner
   join would drop never-counted items from the badge result set, and a
   never-counted item with a changed photo is precisely the row that *should*
   show "Updated" (`changed_at is not null and last_counted_at is null` →
   `updated = true`, pinned by
   [ingredient_changed_badge.test.sql](../supabase/tests/ingredient_changed_badge.test.sql)
   assertions 14–15). Reviewers: check the join type first.

**Regression gate:** [supabase/tests/ingredient_changed_badge.test.sql](../supabase/tests/ingredient_changed_badge.test.sql)
must pass **completely unedited**. Editing that file in this PR is itself the
defect. It is the contract that the generalization was behavior-preserving.

Behavior that *does* change for staff, in a strictly-good direction: the badge
query goes from 149 correlated laterals to one grouped scan joined once (§9).

> **Post-implementation correction (M1, backend-architect self-review,
> release-proposal item 5):** the sentence above is **wrong**. `set search_path
> = public` on `items_last_counted` makes `pg_proc.proconfig` non-null, which
> blocks `inline_set_returning_function()` — so `staff_items_updated` still
> executes `items_last_counted` as a separate correlated function scan per
> item, not one grouped scan joined once. See §1.2's correction for the
> mechanics and the measured perf numbers (13.2 ms / 11.9 ms at ~52 400
> `eod_entries` — well inside budget; `search_path` pinning is not
> negotiable, so no code action follows from this). Left uncorrected here
> would be a false premise for a future perf spec to inherit.

---

## 1. Data model changes

**Migration:** `supabase/migrations/20260817000000_items_last_counted.sql`
(latest on disk is `20260809000000_super_admin_policy_parity.sql`, so ordering
is clean both locally and in prod).

**Additive and non-destructive.** No new table, no new column, no data
backfill, no `drop`. Two `create or replace function` statements and nothing
else. Fully idempotent for the local + prod (MCP) double-apply.

### 1.1 New: `public.items_last_counted(p_store_id uuid)`

```
returns table(item_id uuid, last_counted_at timestamptz)
language sql
stable
security invoker
set search_path = public
```

Contract — three properties the frontend depends on, all of which pgTAP pins:

- **One row per `inventory_items` row in `p_store_id`.** Every item appears,
  even never-counted ones. Row presence is therefore NOT load-bearing for the
  client; a NULL value is the never-counted signal. (Deliberately different
  from `staff_items_updated`, which inner-joins `catalog_ingredients` — this
  helper does **not** join the catalog, so a dangling/invisible catalog row
  cannot make an item vanish.)
- **`last_counted_at` = `max(submitted_at)`** over the `union all` of
  `eod_submissions ⨝ eod_entries` and `inventory_counts ⨝
  inventory_count_entries`, both filtered `status = 'submitted'`, both filtered
  `store_id = p_store_id`. Copy the inner `left join lateral (...) lc on true`
  block **verbatim** from spec 128 lines 119-132 so a reviewer can diff it
  character-for-character. Do not "tidy" it into a `group by` — textual
  identity to the pinned original is the point.
- **NULL means never counted**, in this store, by any kind
  (`spot` / `open` / `mid_shift` / `close` / `weekly` / EOD). Satisfies AC-2,
  AC-3, AC-4, AC-5.

Shape (design sketch, developer authors the SQL):

```
select ii.id as item_id, lc.last_counted_at
  from public.inventory_items ii
  left join lateral ( <verbatim spec-128 union-max block> ) lc on true
 where ii.store_id = p_store_id;
```

Grants, mirroring spec 128 lines 136-137 exactly:

```
revoke execute on function public.items_last_counted(uuid) from public, anon;
grant  execute on function public.items_last_counted(uuid) to authenticated;
```

### 1.2 Modified: `public.staff_items_updated(p_store_id uuid)`

`create or replace`, signature and `returns table(...)` byte-identical. Body
keeps its `catalog_ingredients` join and its `greatest()` `changed_at` lateral;
only the `lc` lateral is replaced by:

```
left join public.items_last_counted(p_store_id) lc on lc.item_id = ii.id
```

`security invoker` on both sides means RLS is evaluated as the end caller
through the whole chain — no privilege escalation is introduced by the nesting.
`language sql` + `stable` keeps `items_last_counted` inlinable by the planner
when called in a `FROM` clause.

> **Post-implementation correction (M1, backend-architect self-review,
> release-proposal item 5):** the inlining claim in the paragraph above is
> **false**. `set search_path = public` (§1.1) sets `pg_proc.proconfig` to a
> non-null value, and `inline_set_returning_function()` refuses to inline any
> function with a non-null `proconfig` — regardless of `language sql` /
> `stable`. So `items_last_counted` executes as a separate function scan
> inside `staff_items_updated`, i.e. still one correlated call per row rather
> than a single grouped scan joined once (§0.3 carried the same false
> premise; corrected there too). **No code action follows:** `search_path`
> pinning is a security posture, not negotiable for this fix, and the
> measured cost is small regardless — 13.2 ms (`items_last_counted`) / 11.9 ms
> (`staff_items_updated`) against a synthetic year of history (~52 400
> `eod_entries`), well inside budget. Flagged so a future perf spec does not
> inherit "the badge query is one grouped scan" as fact.

### 1.3 Indexes — none needed

All three access paths are already covered; **do not add an index in this
migration.**

| Path | Existing index | Source |
|---|---|---|
| `eod_entries` by `submission_id` | `idx_eod_entries_submission_id` | [20260803000000_report_last_order_context.sql:400](../supabase/migrations/20260803000000_report_last_order_context.sql) (spec 151) |
| `eod_entries` by `item_id` | `eod_entries_item_id_idx` | [20260722000000_ingredient_changed_badge.sql:43](../supabase/migrations/20260722000000_ingredient_changed_badge.sql) (spec 128) |
| `inventory_count_entries` by `item_id` | `inventory_count_entries_item_created_idx` | [20260513000000_inventory_counts.sql:127](../supabase/migrations/20260513000000_inventory_counts.sql) (spec 019) |

Because there is no index build, this migration takes no `SHARE` lock on
`eod_entries` and carries none of spec 151's off-peak-apply caveat.

### 1.4 Rollout safety

- **Prod apply:** required before the frontend ships, and the
  `db-migrations-applied` gate will hard-fail on `main` until it is applied
  (see the memory note: prod applies go via Supabase MCP `execute_sql` + an
  explicit `schema_migrations` insert of the exact version string, project
  `ebwnovzzkwhsdxkpyjka`).
- **Order of operations:** function-only, so applying the migration *before*
  the frontend merges is safe — `items_last_counted` simply has no callers yet,
  and `staff_items_updated` is behaviorally identical the instant it lands.
- **Rollback:** re-apply spec 128's `staff_items_updated` body and
  `drop function public.items_last_counted(uuid)`. No data is at risk.

---

## 2. RLS impact

**No new policies. No policy edits. No `alter table … enable row level
security`.** `security invoker` on both functions means every read rides the
existing per-store policies.

| Table read | Policy that gates it | Helper |
|---|---|---|
| `inventory_items` | `store_member_read_inventory_items` | `auth_can_see_store(store_id)` — [20260504173035_per_store_rls_hardening.sql:47-48](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) |
| `eod_submissions` | existing store-scoped read policy | `auth_can_see_store(store_id)` |
| `eod_entries` | `store_member_read_eod_entries` (EXISTS through parent submission) | transitive |
| `inventory_counts` | existing store-scoped read policy | `auth_can_see_store(store_id)` |
| `inventory_count_entries` | `store_member_read_inventory_count_entries` (EXISTS through parent count) — [20260513000000_inventory_counts.sql:166-174](../supabase/migrations/20260513000000_inventory_counts.sql) | transitive |

**AC-6 is satisfied structurally, not incidentally:** the outer driver is
`inventory_items where store_id = p_store_id`. A caller who cannot see that
store gets zero driver rows, so the function returns the **empty set** — not
"rows with NULL". The client then holds an empty map with `loaded = true`, and
because the map is keyed by item id and the item list itself is RLS-clipped by
`fetchAllForStore`, there are no rows to render against it. There is no
`42501` gate and none is wanted (same posture spec 128 chose and pgTAP pinned).

**Permissive-policy lint (CLAUDE.md / spec 053):** this migration adds no
policy, so [supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)
needs no allowlist entry.

---

## 3. API contract

**RPC, not PostgREST.** A view or table read cannot express `max()` over a
two-source union per item in one round trip without either a client-side join
or a materialized column, and the whole point of §0.2 is that the aggregate has
exactly one definition. RPC also inherits the grant posture spec 128 already
established.

### Request

```
POST /rest/v1/rpc/items_last_counted
{ "p_store_id": "<uuid>" }
```

Bearer: the caller's normal Supabase JWT. `authenticated` role required.

### Response — `200`

```json
[ { "item_id": "uuid", "last_counted_at": "2026-08-14T23:11:02.441Z" },
  { "item_id": "uuid", "last_counted_at": null } ]
```

One element per `inventory_items` row in the store. `last_counted_at` is
`timestamptz` serialized as ISO-8601 UTC, or `null`.

### Error cases

| Case | Response | Client behavior |
|---|---|---|
| Store not visible to caller (RLS) | `200 []` | Empty map, `loaded = true`. No rows to key against. |
| Store id is a well-formed uuid with no items | `200 []` | Same. |
| Malformed uuid | `400` (`22P02`) | `notifyBackendError` toast; slice stays `loaded = false` → cells keep the `—` placeholder. |
| Not authenticated / anon | `404` or `42501` per PostgREST | Same as above. Note: "permission denied for function …" is the known anon-caller fingerprint (spec 152 memory note) — treat it as a session problem, not a data problem. |
| Network failure | rejected promise | Same as above. |

**Critical client-side rule:** the db.ts helper **throws** on error (like
[fetchMenuCapacity](../src/lib/db.ts) at db.ts:4920, `if (error) throw error`),
it does **not** swallow to `[]` (like `fetchWeeklyCountStatus` does at
db.ts:1427). Swallowing to `[]` here would be indistinguishable from "this
store has no items", which the store slice would then render as… nothing, but
worse, a *partial* failure model would render as "never counted" for missing
keys. AC-9's guarantee has to be enforced at the network boundary, not just in
the cell.

### Not chosen

- No edge function. **No `supabase/config.toml` change, no `verify_jwt`
  decision, no service-token surface.** This is PostgREST/RPC territory
  exactly as the spec anticipated.

---

## 4. `src/lib/db.ts` surface

New type in [src/types/index.ts](../src/types/index.ts), next to
`WeeklyCountStatus` (~line 410):

```ts
/** Spec 160 — camelCase mirror of one items_last_counted row. */
export interface ItemLastCounted {
  itemId: string;
  /** ISO-8601, or null = never counted at this store (any kind, any source). */
  lastCountedAt: string | null;
}
```

New helper in [src/lib/db.ts](../src/lib/db.ts), placed immediately after
`fetchWeeklyCountStatus` (db.ts:1440) so the two count-aggregate RPCs sit
together:

```ts
export async function fetchItemsLastCounted(
  storeId: string,
): Promise<ItemLastCounted[]>
```

Implementation shape — reuse `fetchMenuCapacity` (db.ts:4912-4935) verbatim as
the template:

- `useInflight.getState().track(async (signal) => { … }, { kind: 'read', label: 'fetchItemsLastCounted' })`
- `supabase.rpc('items_last_counted', { p_store_id: storeId }).abortSignal(signal)`
- `if (error) throw error`
- snake_case → camelCase mapping: `item_id → itemId` (`String(...)`),
  `last_counted_at → lastCountedAt` (`?? null`, never coerced to `''`).

No other db.ts change. **No call site outside db.ts may touch `supabase.rpc`
for this** — the staff carve-out does not extend to admin surfaces.

---

## 5. Admin store (`src/store/useStore.ts`) surface

Mirrors the spec-060 `menuCapacity` slice exactly (state at useStore.ts:1253,
action at :4405, fire-and-forget call at :2000, store-switch clear at :1932 and
:1994). Reuse that shape; do not invent a new one.

### 5.1 State

```ts
/** Spec 160 — itemId → ISO last-counted, or null = never counted. */
lastCountedByItem: Record<string, string | null>;
/** Which store the map describes. Guards a cross-store render during a switch. */
lastCountedStoreId: string | null;
/** false = not loaded yet OR the load failed. Drives AC-9's `—` placeholder. */
lastCountedLoaded: boolean;
```

All three go in **both** initial-state blocks (useStore.ts:~1106 and ~1253),
matching how `menuCapacity` / `weeklyCountStatus` are declared twice.

Three fields, not one, on purpose:
- `lastCountedLoaded` is what makes "loading" distinguishable from "never"
  (AC-9). An empty `Record` alone cannot express it.
- `lastCountedStoreId` prevents store A's map from being rendered against store
  B's rows in the window between `set(...)` and the async tail resolving.

### 5.2 Action

```ts
loadItemsLastCounted: (storeId?: string) => Promise<void>;
```

Body, modelled on `loadMenuCapacity` (useStore.ts:4405-4419):

- `const sid = storeId || get().currentStore?.id; if (!sid || sid === '__all__') return;`
  — the `__all__` bail is required and matches `loadMenuCapacity`. In All-Stores
  mode `storeInventory` (InventoryDesktopLayout.tsx:159-162) is empty anyway, and
  last-counted is per-store by definition (spec: brand-wide roll-up is a
  different product question).
- `try { const rows = await db.fetchItemsLastCounted(sid); … set({ lastCountedByItem: keyed, lastCountedStoreId: sid, lastCountedLoaded: true }); }`
- `catch (e) { set({ lastCountedByItem: {}, lastCountedStoreId: null, lastCountedLoaded: false }); notifyBackendError('Load last counted', e); }`

**This is the exact "degrade to what" answer.** On any error the slice stays
`loaded = false`, so **every cell renders the neutral `—` placeholder in the
muted tone, forever, until the next reload** — plus one toast via
`notifyBackendError` ([src/store/useStore.ts:23](../src/store/useStore.ts)).
It never degrades to "never counted", never degrades to a stale previous
store's values, and never blocks the table. Consequence to state in the PR
description: while unloaded/errored, `counted:never` and `counted:stale` match
**zero** rows (§8).

**Optimistic-then-revert does NOT apply** — this is a read-only derived
aggregate with no write path. No optimistic mutation, no revert. The only
`notifyBackendError` use is the load-failure toast above.

### 5.3 Wiring into the existing load

Two edits inside `loadFromSupabase` (useStore.ts:1843):

1. In the per-store `set({...})` block, alongside `menuCapacity: {}`
   (useStore.ts:1994), clear all three fields. Same rationale as the
   `lastOrderContext` comment at :1976-1981 — clearing to *not loaded* (rather
   than leaving stale) is load-bearing, because item ids differ across stores
   but a partially-overlapping map would render silently wrong values.
2. In the `__all__` branch's `set({...})` (useStore.ts:1932), clear them too.
3. Immediately after `get().loadMenuCapacity(sid);` (useStore.ts:2000), add
   `get().loadItemsLastCounted(sid);` — **fire-and-forget, not awaited**.

That single line satisfies **AC-20** (exactly one RPC per store view),
**AC-21** (first paint is never blocked; the table renders from `inventory`
which is already in the `set` above), and **AC-22** (keyed by store, refetched
on store switch and on every existing reload path, never on render or
keystroke).

### 5.4 Optional, recommended: refresh after an admin-side count submit

An admin submitting a count from
[InventoryCountSection](../src/screens/cmd/sections/InventoryCountSection.tsx)
writes `inventory_counts`, which is deliberately **not** on the realtime store
channel (§7). Where that section's success path already bumps its local
`refreshTick`, add `void useStore.getState().loadItemsLastCounted(storeId)`
alongside it. **Do not invent a new refresh path for this** — if the developer
cannot find an existing post-submit refresh hook in one read, skip it and rely
on the next `loadFromSupabase`. Cost/benefit does not justify new plumbing.

---

## 6. Column layout — the width budget, re-derived

The spec's AC-14 claim *"Column width stays 104px, so the ≥1400 width budget is
unchanged"* is **false** under the both-formats decision. Here is the actual
arithmetic.

### 6.1 What has to fit

Cell font is `mono(400)` at 10.5px = JetBrains Mono ([typography.ts:19](../src/theme/typography.ts)),
advance width 0.6 em → **6.3px/char**. There is no intra-cell padding; the 12px
inter-column `gap` (InventoryTable.tsx:116, :230) is the only separation, so the
string may use the full column width before it ellipsises.

| String | Chars | Width |
|---|---|---|
| `Aug 14 · 3d` (typical) | 11 | 69px |
| `Sep 30 · 11mo` | 13 | 82px |
| `Aug 14, 25 · 1y` (prior-year form) | 15 | 95px |
| `sept 30, 25 · 1y` (es worst case) | 16 | 101px |
| `never counted` / `nunca contado` | 13 | 82px |
| header `LAST COUNTED` @ `Type.caption` (mono 600 10px + 0.75 letterSpacing) | 12 | 81px |
| header `último conteo` | 13 | 88px |

104px leaves **3px** of slack against the es worst case. That is inside the
error bar of the font-metric estimate — it will ellipsise in production and
`3d` will render as `3…`, which is worse than the bug being fixed.

### 6.2 Ruling: `lastCounted` widens 104 → **124px**

124px = 19.7 mono chars, ~23px slack over the worst realistic string. If the
developer measures overflow in the browser, bump to 132 and take it from `name`
— **do not** truncate and do not drop the date.

### 6.3 What actually gives

`name` is `flex: 1` (InventoryTable.tsx:81); every other column is fixed. So
the +20px is absorbed by `name`, not by overflow.

Fixed widths under the AC-13 order (`name, onHand, status, lastCounted,
costEach, stockValue, vendor, category`): 200 / 84 / **124** / 116 / 108 / 150
/ 130. Non-name budget = Σfixed + (n−1)×12 gap + 32 horizontal padding.

| Tier | Columns | Non-name budget (old → new) | `name` at the tier floor (old → new) |
|---|---|---|---|
| ≥ 1400 | all 8 | 1008 → **1028** (+20) | 392 → **372** |
| 1200–1399 | drop `category` | 892 → **886** (−6) | 308 → **314** |
| 1100–1199 (floor) | drop `category` + `vendor` | 750 → **724** (−26) | 350 → **376** |

Read that table carefully, because it is the answer to "what gives":

- **Only the ≥1400 tier gets tighter**, by 20px, entirely out of the flexible
  `name` column (372px ≈ 57 chars of InterTight 600 @13px — comfortably beyond
  the longest seed ingredient name). Nothing is dropped and nothing overflows.
- **The two tiers the user actually runs at get *roomier*, not tighter**,
  because in each of them `lastCounted` (124) replaces something wider
  (`category` 130 at the middle tier; additionally `vendor` 150 at the floor).
  The re-prioritization is not a width tradeoff at those bands — it is a
  strict improvement.

So: AC-14's *intent* holds and its *stated justification* does not. The
correct sentence is "the ≥1400 budget grows by 20px, absorbed by the flex `name`
column; the 1200–1399 and 1100–1199 tiers each gain headroom."

### 6.4 `visibleColumnsForWidth` — new definition

```
all = ['name','onHand','status','lastCounted','costEach','stockValue','vendor','category']
≥1400            → all 8
1200–1399        → all minus 'category'                    (7)
<1200 (floor)    → all minus 'category' minus 'vendor'     (6)
```

Note the floor branch is the `else`, unbounded below — same structure as today
(InventoryTable.tsx:52-60). That matters: when the detail pane is open,
`tableWidth = windowWidth − chrome − 620` (InventoryDesktopLayout.tsx:279-282)
can fall well under 1100 while the table still renders, and under the new
ordering `lastCounted` survives that too. Under today's code it would be the
first thing dropped, so opening a row would make the column the user asked for
disappear. This is a real, if unstated, win — call it out in the PR.

Update the doc comments at InventoryTable.tsx:34-35 and :47-51, which currently
describe the spec-112 priority order and would otherwise be actively wrong.

### 6.5 Test churn is expected — confirmed

The prompt asks whether the broken tier assertions signal a wrong plan. **They
do not.** Reasoning:

- The failing assertions are
  [InventoryTable.test.tsx:136-152](../src/components/cmd/InventoryTable.test.tsx)
  (and :122-133) and
  [InventoryDesktopLayout.test.tsx:441-471](../src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx).
  Every one of them asserts *column identity at a width* — i.e. they encode
  spec 112's priority ordering as a product fact. AC-13/AC-14 exist to change
  that fact. A test that pins the thing you are deliberately changing is
  supposed to fail; updating it 1:1 with the new tier table is the correct
  response.
- The distinguishing signal: these edits touch **only** which column ids /
  header strings appear at which width. They touch **no** rendering-semantics,
  money-formatting, selection, or a11y assertion.
- **Stop condition for the developer:** if a test outside those two files
  starts failing — particularly anything in
  `src/screens/cmd/sections/phone/__tests__/`, `itemMoney`, or
  `inventoryStatusView` — that IS the signal the plan is wrong. Do not "fix"
  it; report it.

---

## 7. Realtime impact

### 7.1 The publication gotcha does NOT apply here

**This migration changes no `supabase_realtime` publication membership.** It
creates two functions and nothing else. There is **no** `docker restart
supabase_realtime_imr-inventory` step after `npm run dev:db` for spec 160.
(Stated explicitly because the spec's "Project-specific notes" raised it as a
risk and it is worth closing.)

### 7.2 Does the value update live? — YES for EOD, NO for inventory counts

Stated rather than left implicit:

- **EOD submissions: live, for free.** `eod_submissions` is already subscribed
  on the `store-{storeId}` channel with `filter: store_id=eq.{storeId}`
  ([useRealtimeSync.ts:48](../src/hooks/useRealtimeSync.ts)) and is already in
  the publication. A staff EOD submit fires `onSync` → the 400ms debounce in
  [CmdNavigator.tsx:63-70](../src/navigation/CmdNavigator.tsx) →
  `loadFromSupabase(sid)` → the fire-and-forget `loadItemsLastCounted(sid)`
  tail added in §5.3. **Zero additional realtime wiring, zero publication
  change.** Since EOD is the dominant count source, the column is effectively
  live for the common case.
- **`inventory_counts` (`spot`/`open`/`mid_shift`/`close`/`weekly`): NOT live.**
  It is deliberately kept off the store channel
  ([useRealtimeSync.ts:55-59](../src/hooks/useRealtimeSync.ts), spec 019 §7
  Option A). A count submitted by *another* client lands in the admin column on
  the next store switch / reload / EOD-triggered sync, and §5.4 covers the
  *same* client's own submit.
- **Ruling: do not add `inventory_counts` to the channel or the publication in
  this spec.** It is a prod publication change plus the docker-restart dev step,
  it reverses a deliberate spec-019 decision for a non-dominant source, and it
  is not required by any AC (AC-22 asks only for store-switch + existing reload
  path freshness). If the PM wants it, it is its own spec.

### 7.3 Staleness of the tone while a tab sits open

`countAgeTone` is a function of `now`. Do **not** add a timer — 149 rows
re-rendering on a tick is not worth it. `now` is captured once per host render
and re-anchored on every map reload (§8.4). A tab left open across a threshold
boundary shows the old tone until the next sync; given the 400ms-debounced
realtime reload on `eod_submissions`, that window is small in practice.
Acceptable — state it in the PR, don't engineer around it.

---

## 8. Frontend contract

### 8.1 New pure module — `src/utils/countAge.ts`

No React, no RN, no store imports. Jest-targetable directly.

```ts
export const COUNT_STALE_DAYS = 7;
export const COUNT_COLD_DAYS  = 30;

export type CountAgeTone = 'fresh' | 'stale' | 'cold' | 'never';

/** AC-8. `now` is injected so tests pin boundaries without fake timers —
 *  same convention as cmdSelectors (see cmdSelectors.eodAndStreak.test.ts:15). */
export function countAgeTone(
  lastCountedAt: string | null | undefined,
  now: Date,
): CountAgeTone;

export interface CountAgeFormatOpts {
  now: Date;
  locale: string;      // useLocale()
  timeZone: string;    // useStore(s => s.timezone)
  neverLabel: string;  // T('section.inventory.neverCounted')
  style: 'short' | 'long';
}

/** The composed display string. 'short' = table cell, 'long' = detail pane. */
export function formatLastCounted(
  lastCountedAt: string | null | undefined,
  opts: CountAgeFormatOpts,
): string;
```

**Boundary semantics (AC-8), stated precisely:**

- `ageMs = now.getTime() - Date.parse(lastCountedAt)`.
- `fresh` ⟺ `ageMs < COUNT_STALE_DAYS * 86_400_000`
- `stale` ⟺ `COUNT_STALE_DAYS*86.4e6 <= ageMs < COUNT_COLD_DAYS*86.4e6`
- `cold`  ⟺ `ageMs >= COUNT_COLD_DAYS * 86_400_000`
- `never` ⟺ input is `null` / `undefined` / `''`.
- **Negative age** (future timestamp, clock skew) → `fresh`. Not an error case
  worth surfacing.
- **`Date.parse` → NaN** (malformed value) → **`never`**. Rationale, because
  this is a judgement call a reviewer will question: the only realistic source
  is corrupt data, and over-reporting staleness is the safe direction for an
  operational trust signal — the operator goes and counts the item, which is
  harmless. Under-reporting (defaulting to `fresh`) would silently launder bad
  data into "this number is trustworthy", which is the exact bug this spec
  exists to fix.
- Boundaries pin exactly as AC-8 demands: 6d23h → `fresh`; 7d00m00s → `stale`;
  29d23h → `stale`; 30d00m00s → `cold`. Note these are **elapsed-duration**
  boundaries, `<` on the low side and `>=` on the high side.

**Timezone handling — the important distinction:**

- **`countAgeTone` takes NO timezone and must not.** "7 days" here is
  7 × 86 400 000 ms of elapsed wall time, which is timezone- and DST-invariant.
  This is deliberately *unlike* the Dashboard's Monday-reset rule
  ([src/utils/weekWindow.ts](../src/utils/weekWindow.ts), consumed at
  [cmdSelectors.ts:884](../src/lib/cmdSelectors.ts)), which needs
  `useStore.timezone` because it anchors on a **calendar boundary**. Duration
  thresholds don't; calendar boundaries do. Adding a timezone to `countAgeTone`
  would be cargo-culting the Dashboard and would introduce a DST-day off-by-one
  where none exists today.
- **The absolute-date *string* DOES need the timezone.** A count submitted at
  `2026-08-15T02:00Z` is *August 14* in `America/New_York`; rendering "Aug 15"
  would disagree with the store's own operating day and with the EOD screens.
  So `formatLastCounted` formats via
  `Intl.DateTimeFormat(locale, { timeZone, … })` using
  `useStore(s => s.timezone)` (useStore.ts:1186, default `America/New_York`,
  surfaced by [TimezoneBar](../src/components/TimezoneBar.tsx)). This is an
  app/brand-level timezone, not a per-store column — accept that; it matches
  how the Dashboard and EOD status already behave, and per-store timezones are
  not in this spec.
- **Do NOT use `getNowInTZ()`** from [src/utils/timezone.ts](../src/utils/timezone.ts)
  for the age math. Its own docstring warns the underlying epoch is offset — it
  is a formatting-only helper. Age math uses a real `Date`; display uses `Intl`
  with an explicit `timeZone`. Getting this backwards is the classic trap here.

**Format definitions:**

| style | date part (`Intl`, with `timeZone`) | composed |
|---|---|---|
| `short` (cell) | same year as `now`: `{month:'short', day:'numeric'}` → `Aug 14`. Different year: add `{year:'2-digit'}` → `Aug 14, 25` | `` `${date} · ${relativeTime(iso)}` `` |
| `long` (detail pane, a11y) | `{year:'numeric', month:'long', day:'numeric'}` → `August 14, 2026` | `` `${date} · ${relativeTime(iso)}` `` |

The "same year" comparison is evaluated **in `timeZone`**, not in the runner's
local zone. The age fragment always comes from the existing
[relativeTime()](../src/utils/relativeTime.ts) — AC-7's terse `3h`/`2d`/`2mo`
form is not re-derived.

`null` input returns `neverLabel` verbatim for both styles.

### 8.2 Cell rendering (`src/components/cmd/InventoryTable.tsx`)

`InventoryTable` stays **presentational** (it takes `labels` as a prop today
rather than calling `T` — keep that posture). One new **optional** prop:

```ts
lastCounted?: {
  byItem: Record<string, string | null>;
  loaded: boolean;
  timezone: string;
  locale: string;
  neverLabel: string;    // T('section.inventory.neverCounted')
  loadingLabel: string;  // T('section.inventory.lastCountedLoading')
  ariaTemplate: string;  // T-resolved 'last counted {date}' — pass the raw
                         // template; the cell interpolates {date}.
  now: Date;
};
```

Optional so existing tests that don't pass it still render (they land on the
`loaded: false` path). The `case 'lastCounted'` branch becomes:

1. `!lastCounted || !lastCounted.loaded` → render `—` in `C.fg3`
   (`fresh` tone), `accessibilityLabel = loadingLabel`. **AC-9.**
2. otherwise `const iso = lastCounted.byItem[it.id] ?? null`;
   `tone = countAgeTone(iso, now)`; `text = formatLastCounted(iso, {…, style:'short'})`.
3. **One** `<Text numberOfLines={1}>` carrying the whole composed string in the
   graded colour. Not two sibling Texts, not a nested Text — one leaf, so it is
   one truncation unit and one jest `getByText` target.
4. `accessibilityLabel` = `neverLabel` when `never`, else `ariaTemplate` with
   `{date}` replaced by the `long`-style string. **AC-10.**

Tone → colour, using the existing Cmd palette (no new tokens):

| tone | colour |
|---|---|
| `fresh` | `C.fg3` (today's styling, unchanged) |
| `stale` | `C.warn` |
| `cold` | `C.danger` |
| `never` | `C.danger` + the literal `neverLabel` words |

`COL_STYLE.lastCounted.width` → `124`.

### 8.3 The four mis-labelled surfaces — individual rulings

The prompt is right not to assume all four want the same fix. All four in the
spec's table **are** rewires, because all four are per-store *item* surfaces
where the label is literally "last counted". But the spec's list is
**incomplete** — see §8.3.5/§8.3.6, and those two are relabel-only.

| # | Surface | Ruling |
|---|---|---|
| 1 | [InventoryTable.tsx:200-205](../src/components/cmd/InventoryTable.tsx) | **REWIRE** per §8.2. Also replaces the hardcoded `'never'` at :203 with the catalog lookup (AC-25). |
| 2 | [InventoryDesktopLayout.tsx:751](../src/screens/cmd/InventoryDesktopLayout.tsx) — `properties.json` `last_counted` row | **REWIRE** to `formatLastCounted(..., style:'long')` → `"August 14, 2026 · 3d"` (AC-11: absolute **and** relative; no width constraint here). The surrounding keys in that array are DB-ish snake_case literals (`cost_per_unit`, `par_level`), so the key name `last_counted` stays and is **not** i18n'd — matching its siblings. Do **not** add an `updated_at` row: `lastUpdatedAt` is already exported honestly as `updated_at` by [ExportCsvDrawer.tsx:31](../src/components/cmd/ExportCsvDrawer.tsx), and adding a row is new surface area. |
| 3 | [InventoryDesktopLayout.tsx:754](../src/screens/cmd/InventoryDesktopLayout.tsx) — meta line | **REWIRE**, and fix a pre-existing string bug while you are in it: today the never case renders `"… last counted never ago"`. Introduce `section.inventory.lastCountedMeta` = `"last counted {value}"` and pass either the `long` string or `neverLabel` as `{value}`, with **no** trailing `" ago"`. Scope discipline: the rest of that template (`{category} · {vendor} · …`, `'no vendor'`) is hardcoded English today and stays that way — pre-existing, out of scope. Only the last-counted fragment becomes a catalog lookup, which is the minimum AC-25 requires for a changed cell. |
| 4 | [PhoneInventoryDetail.tsx:79](../src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx) — `LAST COUNTED` prop row | **REWIRE**. This component already reads the store directly (`useStore((s) => s.vendors)` etc. at :37-39), so it reads `lastCountedByItem` / `lastCountedLoaded` / `timezone` itself — no prop threading. Value = `long` style, or `neverLabel`, or `loadingLabel` when `!loaded`. The `'LAST COUNTED'` **label** stays a hardcoded literal: that whole `propRows` array is hardcoded English from spec 142 and i18n-ing it is out of scope; AC-25 governs the value. **AC-12** (desktop/phone agreement) holds because both read the same slice keyed by the same `item.id`. |
| 5 | [InventoryCatalogMode.tsx:737](../src/screens/cmd/sections/InventoryCatalogMode.tsx) — brand catalog `properties.json` `last_counted` | **RELABEL ONLY → `last_edited`.** Not in the spec's list; found during design. This is a brand-wide `max(lastUpdatedAt)` reduce (:228-233) — it genuinely means "last edited", and a brand-wide last-*counted* roll-up is explicitly a different product question (spec: catalog.tsv out of scope). Evidence this is the right read: the meta line two hundred lines up (:637-638) already labels the *same* reduce with `T('section.inventory.neverEdited')`. So the properties row is simply mislabelled. Change the literal key `last_counted` → `last_edited` and `'never'` → `T('section.inventory.neverEdited')`. Zero data plumbing. |
| 6 | [PhoneCatalogList.tsx:78](../src/screens/cmd/sections/phone/PhoneCatalogList.tsx) — `LAST COUNTED` prop row | **RELABEL ONLY → `LAST EDITED`.** Same reduce over `lastUpdatedAt` (:68-71), same reasoning. Hardcoded-English literal in a hardcoded-English `propRows` array; no new i18n key. |

Why 5 and 6 are in scope at all despite catalog.tsv being out of scope: this
spec *creates* the inconsistency. After it lands, items.tsv would say "never
counted" while catalog.tsv says "last_counted: 3d" for the same ingredient.
Relabelling is the cheapest way to leave the codebase honest without importing
a brand-wide aggregate. **PM: flag if you disagree — it is two string literals
and can be dropped without touching anything else in this design.**

### 8.4 Where the map lives and how it reaches the table

`InventoryDesktopLayout` (the Inventory host) reads the slice and passes the
prop bundle down; it already reads `currentStore`, `getItemStatus`, etc. the
same way.

```
useStore → lastCountedByItem / lastCountedLoaded / lastCountedStoreId / timezone
         → guard: effectiveLoaded = lastCountedLoaded && lastCountedStoreId === currentStore.id
         → now = useMemo(() => new Date(), [lastCountedStoreId, lastCountedLoaded])
         → <InventoryTable lastCounted={{ … }} />
         → <DetailPane lastCountedAt={…} lastCountedLoaded={effectiveLoaded} />
```

- `effectiveLoaded` is where `lastCountedStoreId` earns its place: during a
  store switch the map may briefly describe the previous store. Guarding here
  means the cells fall back to `—`, never to another store's dates.
- `now` is re-anchored only when the map reloads (§7.3) — not per render, not
  per keystroke.
- `DetailPane` gets two new props on `DetailProps` (InventoryDesktopLayout.tsx:695-708),
  matching how `vendor` / `status` / `series` are already threaded rather than
  read from the store inside it.

**No component may call `db.fetchItemsLastCounted` directly** and no per-row
`useEffect` may fetch — AC-20.

---

## 9. Filtering — `counted:` and the shared-parser blast radius

### 9.1 Blast radius assessment — ruled ACCEPT, no RecipesSection code change

[filterParser.ts](../src/utils/filterParser.ts) has two consumers of
`parseFilter` and two of `matchesFilter`:

| Consumer | Uses | Effect of adding `counted` to `KEY_ALIASES` |
|---|---|---|
| [InventoryDesktopLayout.tsx:163,176](../src/screens/cmd/InventoryDesktopLayout.tsx) | both | the intended one |
| [PhoneInventoryList.tsx:113,115](../src/screens/cmd/sections/phone/PhoneInventoryList.tsx) | both | see §9.4 |
| [RecipesSection.tsx:102](../src/screens/cmd/sections/RecipesSection.tsx) | `parseFilter` only | **the PM's flagged risk** |
| [InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx) | neither (own filter) | none |

The RecipesSection change, precisely: today `counted:never` typed into the
recipe search is not a recognized key, so it falls into `parsed.text` and
substring-matches `menuItem` → **0 results**. After the alias it becomes a
`filters` entry, RecipesSection's loop (:104-106) only acts on
`key === 'category'` and ignores it → the token is silently dropped → **all
results**.

**Ruling: accept, with no code change to RecipesSection.** Two reasons:

1. This is *already the documented, deliberate posture* for `status:` and
   `vendor:` in Recipes. The comment at
   [RecipesSection.tsx:90-93](../src/screens/cmd/sections/RecipesSection.tsx)
   reads: *"status / vendor are accepted but no-op (don't apply to recipes), so
   users can paste a query copied from the inventory filter without errors."*
   `counted:` joining that set is the design working as intended, not a
   regression.
2. The alternative — not adding the alias — makes `counted:` a *name-substring*
   token on the Inventory side, which directly violates **AC-16**.

Required of the developer: extend that comment at :90-93 to name `counted`, and
add one jest assertion in the recipes test that `counted:never` is a no-op
(returns the full list) rather than a name search. Comment + test, no logic.

### 9.2 `parseFilter`

`ParsedFilter['filters'][number]['key']` widens to
`'status' | 'category' | 'vendor' | 'counted'`; `KEY_ALIASES` gains
`counted: 'counted'`. `KV_RE` already accepts it (`/^([a-z]+):([\w-]+)$/i`).
Update the doc comment at :9-10.

### 9.3 `matchesFilter`

Signature gains a **fifth optional positional** param (keeps both existing call
sites compiling unchanged):

```ts
export function matchesFilter(
  item: InventoryItem,
  parsed: ParsedFilter,
  getStatus: (i: InventoryItem) => ItemStatus,
  localizedName?: string,
  /** Spec 160 — the row's tone, precomputed by countAgeTone at the call site.
   *  undefined = last-counted data unavailable for this surface. */
  countedTone?: CountAgeTone,
): boolean
```

Matcher branch for `key === 'counted'`:

| `value` | admits |
|---|---|
| `never` | `countedTone === 'never'` |
| `stale` | `countedTone ∈ {'stale','cold','never'}` |
| anything else | **false** (AC-16 — matches zero rows, same shape as an unknown `status:` value; does not fall through to a name search) |
| — and if `countedTone === undefined` | **false** for any `counted:` filter |

**AC-17 is satisfied more strongly than the AC asks:** the matcher never sees a
threshold at all. It receives a tone that `countAgeTone` produced, so the
constants exist in exactly one module and cannot be duplicated into the matcher
even by accident.

The `countedTone === undefined` → false rule is what makes `counted:never`
match **zero** rows while the aggregate is loading or errored, rather than
matching **every** row. Getting this backwards would turn a transient load state
into "your entire inventory has never been counted", which is the AC-9 failure
mode re-entering through the filter.

**AC-18** (ANDs with other tokens and the status chip) is free: the branch sits
inside the same `for` loop over `parsed.filters`, and the status chip is applied
downstream by `applyInventoryStatusView` (InventoryDesktopLayout.tsx:189-198).

Call site (InventoryDesktopLayout.tsx:174-184): pass
`countAgeTone(effectiveLoaded ? (byItem[i.id] ?? null) : undefined, now)` — or
`undefined` outright when `!effectiveLoaded`. The `textFiltered` memo's dep list
grows by `lastCountedByItem`, `effectiveLoaded`, `now`. That is a **recompute**
(O(149), trivial), not a refetch — AC-22 is about refetching and is unaffected.

### 9.4 Phone Inventory list — RECOMMENDED small addition

[PhoneInventoryList.tsx:115](../src/screens/cmd/sections/phone/PhoneInventoryList.tsx)
shares `matchesFilter`. Without wiring, `counted:` there matches zero rows.
Since §9.5 puts the token in a placeholder that phone surfaces render, that is a
visible dead end.

**Recommendation: wire it** — the component already reads `useStore`, so it is
the same 5 lines as the desktop call site (read the three slice fields, compute
the tone, pass the 5th arg). This adds **no column** to the phone list, so the
spec's "phone list out of scope" ruling on *display* is untouched; it only makes
an advertised filter work. If the PM refuses, then §9.5's placeholder must not
reach the phone list.

### 9.5 AC-19 is based on a wrong premise — pushing back

AC-19 says to advertise the token in `section.inventory.filterPlaceholder`.
**That key is not the desktop Inventory items.tsv placeholder.**
[InventoryDesktopLayout.tsx:454](../src/screens/cmd/InventoryDesktopLayout.tsx)
renders `<FilterInput value={filterText} onChangeText={setFilterText} />` with
**no `placeholder` prop**, so it falls back to `FilterInput`'s hardcoded English
default `'status:low cat:produce'`
([FilterInput.tsx:20](../src/components/cmd/FilterInput.tsx)).

`section.inventory.filterPlaceholder` is consumed by four *other* surfaces —
[InventoryCatalogMode:314](../src/screens/cmd/sections/InventoryCatalogMode.tsx),
[PhoneInventoryList:215](../src/screens/cmd/sections/phone/PhoneInventoryList.tsx),
[PhoneCatalogList:236](../src/screens/cmd/sections/phone/PhoneCatalogList.tsx),
[PhoneWasteLogSheet:148](../src/screens/cmd/sections/phone/PhoneWasteLogSheet.tsx)
— in three of which `counted:` is a no-op or zero-match. Editing it advertises a
token that does nothing, on three surfaces, while leaving the one surface AC-19
is actually about still showing hardcoded English.

**Ruling — amended AC-19:**

- Add a **new** key `section.inventory.filterPlaceholderItems` (all three
  catalogs), value `counted:never cat:produce` (es `counted:never cat:proteína`,
  zh-CN `counted:never cat:蛋白` — parallel to how the existing key localizes the
  example *value*, not the token).
- Wire it explicitly at InventoryDesktopLayout.tsx:454, and at
  PhoneInventoryList.tsx:215 **iff** §9.4 is taken.
- **Do not touch** `section.inventory.filterPlaceholder`.

Bonus: this also removes a hardcoded English default from the primary Inventory
surface, which is squarely in AC-25's spirit.

---

## 10. i18n

All keys under `section.inventory`, in **all three** catalogs
([en](../src/i18n/en.json) / [es](../src/i18n/es.json) /
[zh-CN](../src/i18n/zh-CN.json)) with real translations, ~line 533 next to the
existing `lastCountedCol`. [i18n.test.ts](../src/i18n/i18n.test.ts) parity
(AC-24) enforces presence.

| key | en | es | zh-CN |
|---|---|---|---|
| `neverCounted` | `never counted` | `nunca contado` | `从未盘点` |
| `lastCountedAria` | `last counted {date}` | `último conteo {date}` | `上次盘点 {date}` |
| `lastCountedLoading` | `loading` | `cargando` | `加载中` |
| `lastCountedMeta` | `last counted {value}` | `último conteo {value}` | `上次盘点 {value}` |
| `filterPlaceholderItems` | `counted:never cat:produce` | `counted:never cat:proteína` | `counted:never cat:蛋白` |

- `section.inventory.lastCountedCol` is **reused unchanged** (AC-23).
- `section.inventory.neverEdited` is **reused unchanged** for §8.3 rows 5/6.
- `lastCountedLoading` exists only as the loading cell's `accessibilityLabel`
  (the visible glyph is `—`). Without it a screen reader announces a bare dash,
  which is the a11y equivalent of AC-9's failure mode.
- No new keys for the catalog relabels (§8.3.5/6) — those are literals in
  already-hardcoded arrays.

---

## 11. Testing

### pgTAP — new file `supabase/tests/items_last_counted.test.sql`

Mirror the existing assertions in
[ingredient_changed_badge.test.sql](../supabase/tests/ingredient_changed_badge.test.sql)
rather than re-deriving them (the spec is right about this).

1. Function exists with the expected `returns table` column names/types
   (`has_function` / `col_type_is` shape as at :46/:58).
2. Both sources union — `last_counted_at` = max across a submitted EOD **and** a
   submitted `inventory_counts` row (mirrors assertion 19).
3. A `draft` `eod_submissions` row does **not** set the date (AC-3).
4. A `draft` `inventory_counts` row does **not** set the date (AC-3).
5. Per-store isolation — counted at store A ⇒ NULL when queried for store B
   (AC-4).
6. Never counted ⇒ `last_counted_at IS NULL` (mirrors assertion 15, AC-5).
7. **Row cardinality: one row per `inventory_items` row in the store**,
   including never-counted and including an item whose `catalog_id` is NULL or
   dangling. This is the contract §0.2 rejected direct reuse over — pin it.
8. RLS: as a user with no `user_stores` row for the store ⇒ **empty set**
   (AC-6).
9. Grants: no `execute` for `anon` / `public`; `execute` for `authenticated`.

**And:** `ingredient_changed_badge.test.sql` runs **unedited** and green. That
is the staff-badge non-regression gate (§0.3). If it needs an edit, the
generalization was not behavior-preserving — stop.

### jest

- `src/utils/countAge.test.ts` — the four AC-8 boundaries exactly (6d23h /
  7d00m / 29d23h / 30d00m), `never` for null, negative age → `fresh`,
  malformed → `never`; `formatLastCounted` short vs long, the prior-year
  `, 25` variant, and a fixed-`timeZone` case proving a `02:00Z` timestamp
  renders as the previous day in `America/New_York`.
- `InventoryTable.test.tsx` — cell for counted / never / **loading**; the a11y
  label carries the long date; the new tier table (§6.4) at 1400 / 1399 / 1200 /
  1150 / and one pane-open width < 1100 showing `lastCounted` survives.
- `InventoryDesktopLayout.test.tsx` — updated header-presence assertions per
  §6.4; the detail-pane `last_counted` row and meta line read the new value and
  are unaffected by mutating `lastUpdatedAt` (AC-1's negative test).
- `filterParser` — `counted:never` / `counted:stale` parse + match, the
  unknown-value zero-match (AC-16), `countedTone === undefined` ⇒ zero-match,
  and the AND case `counted:never cat:produce` (AC-18).
- `RecipesSection` — `counted:never` is a no-op there (§9.1).
- `PhoneInventoryDetail.test.tsx` / `PhoneInventory.acReg.test.tsx` — updated
  for the new value source.
- `i18n.test.ts` — parity, automatic.

**Run the full `npx jest`**, not a subset (per the standing memory note: a
stale EOD test previously turned `main` red).

---

## 12. Risks and tradeoffs

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **The `staff_items_updated` rewrite silently breaks the live staff badge** via an inner join dropping never-counted items. | **High** — it is the only way this design can break a shipped surface. | `LEFT JOIN` mandated (§0.3); `ingredient_changed_badge.test.sql` runs unedited as the gate; named as the first reviewer checkpoint. |
| R2 | **Migration ordering / prod drift.** `db-migrations-applied` hard-fails on `main` until the migration is in prod's `schema_migrations`. | Medium | Apply via MCP + explicit version insert before/with the merge. No CI *gate* invents itself here — manual verification is the reality (CLAUDE.md "CI workflow"). Also: the gate's CLI is pinned to 2.108.0; a red gate is not automatically drift — diff repo vs `schema_migrations` first. |
| R3 | **Load failure renders `—` indefinitely**, and the operator may read a whole column of dashes as "the feature is broken". | Medium | One `notifyBackendError` toast fires. This is the deliberate tradeoff over the alternative (rendering "never counted"), which would be actively false. Accepted. |
| R4 | **Perf on prod after a year.** `eod_entries` grows ~149 rows/store/day (~54k/store/year); the union scans one store's submitted history per call. | Medium | All three index paths already exist (§1.3). The grouped form replaces 149 correlated laterals for the *staff* path — net faster there. The 286 KB seed is not a meaningful load test; the developer should `EXPLAIN (ANALYZE)` `items_last_counted` against a store with realistic `eod_entries` volume and report the plan in the PR. If it ever regresses, the escape hatch is the denormalized column the spec pre-authorized — **not** in this spec. |
| R5 | **Column width estimate is font-metric arithmetic, not a measurement.** | Low | 124px carries ~23px slack over the worst string (§6.1). If it ellipsises in the browser, bump to 132 and take it from `name`; never truncate, never drop the date. Verify in the browser per the standing preference to exercise UI changes with the preview tools. |
| R6 | **`name` column loses 20px at ≥1400.** | Low | 372px ≈ 57 chars; no seed name is close. Tiers below 1400 gain room (§6.3). |
| R7 | **`inventory_counts` writes are not live** (§7.2). | Low | Explicit, stated, and matches the deliberate spec-019 decision. §5.4 covers the same-client case. Reversing it is its own spec. |
| R8 | **Tone goes stale in a long-lived tab** (§7.3). | Low | No timer, by choice. Re-anchors on every reload; EOD-driven syncs are frequent. |
| R9 | **Scope additions beyond the written spec** — §8.3 rows 5/6 (catalog relabels), §9.4 (phone list filter), §9.5 (new placeholder key). | Low | Each is called out for PM visibility with a one-line "drop it if you disagree". None is silent. |
| R10 | Edge-function cold start | **N/A** | No edge function is touched. No `verify_jwt` decision, no service-token surface, no `config.toml` change. |
| R11 | `app.json` slug | **N/A** | Untouched (CLAUDE.md "DO NOT AUTO-FIX"). Nothing in this spec implies it. |

---

## 13. Files the implementation should touch

**Backend**
- `supabase/migrations/20260817000000_items_last_counted.sql` (new)
- `supabase/tests/items_last_counted.test.sql` (new)
- `supabase/tests/ingredient_changed_badge.test.sql` — **must NOT change**

**Data layer**
- `src/types/index.ts` — `ItemLastCounted`
- `src/lib/db.ts` — `fetchItemsLastCounted`
- `src/store/useStore.ts` — slice + action + 3 wiring edits in `loadFromSupabase`

**Frontend**
- `src/utils/countAge.ts` (new) + `src/utils/countAge.test.ts` (new)
- `src/utils/filterParser.ts`
- `src/components/cmd/InventoryTable.tsx`
- `src/screens/cmd/InventoryDesktopLayout.tsx` (host + `DetailPane` :751/:754 + FilterInput :454)
- `src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx`
- `src/screens/cmd/sections/phone/PhoneInventoryList.tsx` (§9.4, recommended)
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` (relabel only)
- `src/screens/cmd/sections/phone/PhoneCatalogList.tsx` (relabel only)
- `src/screens/cmd/sections/RecipesSection.tsx` (comment only)
- `src/i18n/en.json`, `es.json`, `zh-CN.json`

**Tests to update**
- `src/components/cmd/InventoryTable.test.tsx`
- `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx`
- `src/screens/cmd/sections/phone/__tests__/PhoneInventoryDetail.test.tsx`
- `src/screens/cmd/sections/phone/__tests__/PhoneInventory.acReg.test.tsx`
- recipes test (§9.1 no-op assertion)

---

## Files changed

### Backend (backend-developer)

**Migrations**
- `supabase/migrations/20260817000000_items_last_counted.sql` (new) — adds
  `public.items_last_counted(p_store_id uuid) returns table(item_id uuid,
  last_counted_at timestamptz)` holding spec 128's union-max block VERBATIM
  (§1.1), and `create or replace`s `public.staff_items_updated(p_store_id)`
  with a byte-identical signature + return table, its inline `lc` lateral
  swapped for `left join public.items_last_counted(p_store_id) lc on
  lc.item_id = ii.id` (§1.2). `security invoker` + `stable` on both; grants
  mirror spec 128 (`revoke … from public, anon` / `grant … to authenticated`).
  No `drop`, no new policy, no index, **no `alter publication`** — so no
  realtime container restart (§7.1).

**pgTAP**
- `supabase/tests/items_last_counted.test.sql` (new, 16 assertions) — structure
  + byte-pinned return table + STABLE/SECURITY INVOKER; eod source alone; max
  over BOTH sources; inventory_counts source alone; draft eod and draft
  inventory_count each excluded; never-counted ⇒ NULL; one row per
  `inventory_items` row in the store; **the RLS-invisible-catalog case with
  `staff_items_updated` as the negative control** (items_last_counted returns
  it, staff_items_updated drops it — the §0.2 rationale, pinned); per-store
  isolation both directions; no-visibility caller ⇒ empty set; anon/authenticated
  grants.
- `supabase/tests/ingredient_changed_badge.test.sql` — **UNCHANGED and green**
  (20/20). The §0.3 behavior-preservation gate.

**Data layer**
- `src/types/index.ts` — new `ItemLastCounted` interface (next to
  `WeeklyCountStatus`); three new `AppState` fields next to `menuCapacity`:
  `lastCountedByItem`, `lastCountedStoreId`, `lastCountedLoaded`.
- `src/lib/db.ts` — new `fetchItemsLastCounted(storeId)` after
  `fetchWeeklyCountStatus`, on the `fetchMenuCapacity` template
  (`useInflight.track` + `.abortSignal(signal)` + `if (error) throw error`).
  **Throws rather than degrading to `[]`** — commented at the function, because
  `[]` is indistinguishable from "this store has no items" and would let a
  missing key render as "never counted" (§3, AC-9). Import list gains
  `ItemLastCounted`.

**Store**
- `src/store/useStore.ts` — `loadItemsLastCounted(storeId?)` action (modelled on
  `loadMenuCapacity`, `__all__` bail included); the three state fields in both
  initial-state blocks (`SIGNED_OUT_DATA_RESET` + the `create()` literal);
  cleared in both `loadFromSupabase` `set({...})` branches (`__all__` and
  per-store); fire-and-forget `get().loadItemsLastCounted(sid)` immediately
  after `get().loadMenuCapacity(sid)` — never awaited (AC-20/21/22). On error
  the slice stays `lastCountedLoaded: false` (neutral `—` forever) + one
  `notifyBackendError` toast; never "never counted", never a stale store's
  dates.

**Verification (local stack only — prod apply is a separate ship-time step)**
- `npx supabase migration up --local` applied cleanly.
- `npm run test:db` → **82/82 files green**, including the unedited spec-128
  gate.
- `npx tsc --noEmit` and `npm run typecheck:test` clean.
- PostgREST end-to-end against `admin@local.test`: `rpc/items_last_counted`
  → 200 with 143 rows for Towson (112 null / 31 dated), keys `item_id` +
  `last_counted_at`; anon → 401 `42501 permission denied for function
  items_last_counted`; malformed uuid → 400. Matches §3's contract table.
- Behavior preservation on seed data: `staff_items_updated.last_counted_at`
  vs `items_last_counted.last_counted_at` for Towson → **0 mismatches**,
  143 rows each.
- R4 perf probe: with a synthetic year of history for one store
  (~52 400 `eod_entries`, `analyze`d, inside a rolled-back txn)
  `items_last_counted` executes in **13.2 ms** and `staff_items_updated` in
  **11.9 ms** (3.3 / 3.0 ms on the untouched seed). No index added; the three
  existing index paths cover it (§1.3).

### Frontend (frontend-developer)

**New pure module**
- `src/utils/countAge.ts` (new) — `COUNT_STALE_DAYS` / `COUNT_COLD_DAYS`,
  `CountAgeTone`, `countAgeTone(iso, now)` and `formatLastCounted(iso, opts)`
  per §8.1. `countAgeTone` takes NO timezone (elapsed-duration thresholds are
  DST-invariant); `formatLastCounted` formats the absolute date through `Intl`
  with an explicit `timeZone`, and the same-year test is evaluated IN that
  zone. `getNowInTZ()` is deliberately NOT used for age math. Malformed
  timestamp → `never` (safe direction); future timestamp → `fresh`.
- `src/utils/countAge.test.ts` (new, 16 assertions) — the four AC-8 boundaries
  exactly (6d23h / 7d / 29d23h / 30d), null / malformed / future inputs, short
  vs long format, the prior-year `, 25` variant, and the `02:00Z → previous day
  in America/New_York` timezone property (with a UTC control).

**Filter DSL**
- `src/utils/filterParser.ts` — `counted` added to `KEY_ALIASES`; the
  `ParsedFilter` key union widens; `matchesFilter` gains a 5th OPTIONAL
  positional `countedTone?: CountAgeTone` (both pre-existing call sites keep
  compiling). `never` ⇒ tone `never`; `stale` ⇒ everything but `fresh`;
  any other value ⇒ zero rows (AC-16, no name fallthrough); `undefined` tone
  (loading / errored / unwired) ⇒ zero rows. The matcher never sees a
  threshold — AC-17 holds structurally.
- `src/utils/filterParser.test.ts` (new, 14 assertions) — the file had no
  direct coverage before; pins the `counted:` matrix plus a regression net for
  `status:` / `vendor:` / bare tokens.

**Desktop table**
- `src/components/cmd/InventoryTable.tsx` — `ColumnId` re-ordered to
  `name, onHand, status, lastCounted, costEach, stockValue, vendor, category`
  (AC-13); `visibleColumnsForWidth` drops `category` at 1200–1399 and
  `category + vendor` at the unbounded floor (AC-14) — `lastCounted` survives
  every tier, including the pane-open sub-1100 widths; `COL_STYLE.lastCounted`
  104 → **124** (§6.2, the es worst case had ~3px of slack at 104); one new
  OPTIONAL `lastCounted` prop bundle (byItem / loaded / timezone / locale /
  neverLabel / loadingLabel / ariaTemplate / now) keeping the component
  presentational; the cell renders ONE `<Text numberOfLines={1}>` carrying
  `Aug 14 · 3d` in the graded colour (`fresh` C.fg3 / `stale` C.warn / `cold`
  + `never` C.danger), with `accessibilityLabel` = the long-form date via the
  `{date}` template, or the never phrase. Unloaded/absent ⇒ `—` in C.fg3 with
  a `loading` a11y label (AC-9). Header doc comments rewritten (they described
  the spec-112 priority order).
- `src/components/cmd/InventoryTable.test.tsx` — the tier assertions were
  REWRITTEN to the new tier table (the intended AC-13/14 behavior change, per
  §6.5), plus 8 new cases for the cell: loading (both `undefined` prop and
  `loaded: false`), counted, never, missing-key, the a11y long form, the
  AC-1 negative (a fresh `lastUpdatedAt` does not move the value), and a
  computed-colour assertion for all four tones.

**Desktop host + detail pane**
- `src/screens/cmd/InventoryDesktopLayout.tsx` — reads
  `lastCountedByItem / lastCountedLoaded / lastCountedStoreId / timezone`;
  `lastCountedReady` guards a cross-store map during a switch; `now` is
  re-anchored only on map reload (no timer, §7.3); `matchesFilter` gains the
  precomputed tone (recompute, not refetch); `<FilterInput>` at :454 now gets
  an explicit `placeholder={T('section.inventory.filterPlaceholderItems')}`
  (§9.5 — the surface previously fell back to FilterInput's hardcoded English
  default; `section.inventory.filterPlaceholder` is UNTOUCHED); the table gets
  the prop bundle; `DetailPane` gains `lastCountedAt` + `lastCountedLoaded`
  props (threaded like `vendor` / `status` / `series`) and renders the
  `last_counted` properties row + the meta line from `formatLastCounted(…,
  style: 'long')` — the pre-existing `"… last counted never ago"` string bug is
  gone via the new `lastCountedMeta` key. `item.lastUpdatedAt` is no longer
  read there.
- `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx` — tier
  assertions updated to the new table; the `PropertiesJson` stub now echoes
  `key=value` so the rewired row is assertable; 5 new cases (loading, loaded
  long-form, never, the AC-1 negative, and the cross-store guard).

**Phone tier**
- `src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx` — the
  `LAST COUNTED` prop row reads the same slice keyed by the same item id
  (AC-12), guarded on `item.storeId`; loading ⇒ the loading phrase, never
  "never counted". The hardcoded-English `'LAST COUNTED'` LABEL stays (that
  whole array is spec-142 hardcoded English; AC-25 governs the value).
- `src/screens/cmd/sections/phone/__tests__/PhoneInventoryDetail.test.tsx` —
  5 new cases mirroring the desktop pane.
- `src/screens/cmd/sections/phone/PhoneInventoryList.tsx` (§9.4) — wires the
  tone into `matchesFilter` (≈5 lines, NO column added) so the advertised
  `counted:` token is not a dead end, and switches its search placeholder to
  `filterPlaceholderItems`.
- `src/screens/cmd/sections/phone/__tests__/PhoneInventoryList.test.tsx` —
  3 new cases (`counted:never`, `counted:stale`, and zero-rows-while-unloaded).

**Relabel-only (no data plumbing) — §8.3 rows 5/6**
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — properties row
  `last_counted` → `last_edited`, and its `'never'` literal → the existing
  `T('section.inventory.neverEdited')`. It is a brand-wide
  `max(lastUpdatedAt)` reduce; the meta line 200 lines above already labels the
  same reduce `neverEdited`.
- `src/screens/cmd/sections/phone/PhoneCatalogList.tsx` — `LAST COUNTED` →
  `LAST EDITED` on the same brand-wide reduce.

**Shared-parser blast radius (§9.1) — comment + test, no logic change**
- `src/screens/cmd/sections/RecipesSection.tsx` — the accepted-but-no-op
  comment now names `counted` alongside `status` / `vendor`.
- `src/screens/cmd/sections/__tests__/RecipesSection.countedFilter.spec160.test.tsx`
  (new) — pins that `counted:never` returns the FULL recipe list (was 0 name
  matches), that `cat:` still applies alongside it, and that bare tokens still
  narrow by name.

**i18n (all three catalogs, real translations, next to `lastCountedCol`)**
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — new
  `section.inventory.neverCounted`, `lastCountedAria`, `lastCountedLoading`,
  `lastCountedMeta`, `filterPlaceholderItems`. `lastCountedCol` and
  `neverEdited` reused unchanged; `filterPlaceholder` deliberately untouched.

**Verification (frontend)**
- `npx tsc --noEmit` clean · `npm run typecheck:test` clean ·
  **full `npx jest` → 215/215 suites, 2454/2454 tests green.** No failure
  outside the two files §6.5 predicted would churn.
- Browser (local stack + Expo web on :8081, Playwright-driven Chromium,
  admin@local.test on Towson — 143 items, 31 counted / 112 never):
  - **window 1300 → list ≈1060 (floor): 6 columns and `LAST COUNTED` is
    PRESENT** (`name · on hand · status · last counted · cost/ea · stock
    value`). Under the old ordering it was the first column dropped.
  - window 1560 → list ≈1300 (the owner's band): 7 columns, `category`
    dropped, `vendor` kept, `LAST COUNTED` present.
  - window 1760 → list ≈1500: all 8, no ellipsis.
  - Cells render `Aug 16 · 2h` (muted) and `never counted` (danger).
  - Tone grading exercised by temporarily backdating the two Towson
    `eod_submissions` on the LOCAL stack (then restored byte-exactly):
    10d → `Aug 7 · 10d` in the warn tone; 45d → `Jul 3 · 2mo` in danger.
  - Filters: `counted:never` → 112; `counted:stale` → 112 (and 143 once the
    31 counted rows were backdated past 7d); `counted:bogus` → **0** (AC-16);
    `cat:protein` 17 → `counted:never cat:protein` **11** (matches the DB) and
    `counted:never cat:dairy` **0** while `cat:dairy` is 7 (AC-18).
  - Detail pane on a never-counted row: `last_counted "never counted"` and the
    meta line `Dairy & Sauce · SYSCO · last counted never counted` (the old
    `"… never ago"` bug is gone). On a counted row:
    `last_counted "August 16, 2026 · 2h"`.
  - Dark mode re-checked at 1300 (danger/muted tones both legible).
  - es / zh-CN re-checked at 1760: `último conteo` / `上次盘点` headers and
    `nunca contado` / `从未盘点` cells all measure `scrollWidth == clientWidth
    == 124` — **no ellipsis at 124px**, so R5's "bump to 132" escape hatch was
    not needed.
  - Zero page errors and zero failed requests across every pass (only the
    pre-existing `shadow*` / require-cycle warnings).

**Observations for review (not changed — flagging, not patching)**
- The meta line for a never-counted item reads `last counted never counted`,
  which is the literal composition §8.3 row 3 specified (`lastCountedMeta` +
  `neverLabel`). It is honest but reads oddly; a one-key copy tweak is a PM
  call, not a mid-implementation redesign.
- With the detail pane open at a 1300px window the table's flex `name` column
  compresses to ~0 (only the fixed columns are legible). This is PRE-EXISTING
  narrow-pane behavior and is strictly BETTER after this spec — the floor tier's
  fixed budget drops from 658px (spec 112) to 632px, giving `name` 26px more
  room, exactly as §6.3 predicted.

### Fix pass — release-proposal items 1-5 (test-engineer)

Applied in the coordinator's dependency-driven order from
`specs/160-last-counted-indicator/reviews/release-proposal.md`.

1. **S2 post-submit refresh** — `src/screens/cmd/sections/InventoryCountSection.tsx`:
   the section-local `inventory_counts` realtime handler (the one whose entire
   prior body was `setRefreshTick((t) => t + 1)`) now also fires
   `void useStore.getState().loadItemsLastCounted(storeId)`, so an admin's own
   count submit (not just another client's, and not just the next
   `loadFromSupabase`) refreshes the Inventory column. One line, no new
   plumbing, per the design's own escape hatch not applying (the hook was
   found in one read).
2. **The BLOCK — `loadItemsLastCounted` store-lifecycle test** (new file
   `src/store/useStore.lastCounted.spec160.test.ts`, 12 assertions) covering
   AC-20 (exactly one RPC per `loadFromSupabase` per-store cycle, PLUS a
   static source-grep enumerating the only two legitimate invocation call
   sites — `useStore.ts`'s fire-and-forget tail and item 1's new
   `InventoryCountSection.tsx` call — so a future per-row `useEffect` fails
   this suite even though a single-cycle call-count assertion cannot see it.
   **Scope of that net, stated precisely:** the grep matches the member
   access `.loadItemsLastCounted`, NOT `.loadItemsLastCounted(`. The paren
   form was the first attempt and was too narrow — it matches only direct
   member calls and misses the two-line selector idiom this codebase already
   uses for loader actions (`const load = useStore((s) => s.loadX)` then
   `void load(...)`, as at `InventoryCountSection.tsx:167/507` and
   `ReorderSection.tsx:1529/1552`), which is a likely shape for exactly the
   regression being guarded. The member-access form covers both shapes;
   verified by injecting a selector-idiom reference and confirming the suite
   fails. It still does NOT catch an aliased or dynamic reference
   (`const { loadItemsLastCounted } = useStore.getState()`), so it is a net
   against the idiomatic mistake, not a proof of absence),
   AC-21 (`loadFromSupabase` resolves while `lastCountedLoaded` is still
   `false` — the tail is genuinely unawaited, proven with a caller-controlled
   deferred promise), and AC-22 (cached by store id; both `loadFromSupabase`
   branches clear to NOT LOADED, not loaded-empty; `__all__` never fetches;
   refetch on a genuine store switch). Plus the error path (leaves
   `lastCountedByItem: {}` / `lastCountedLoaded: false`, fires exactly one
   `notifyBackendError` toast, never degrades to a loaded-empty map).
   **Bundled fix:** `src/store/useStore.switching.test.ts`'s `../lib/db` mock
   now stubs `fetchItemsLastCounted` — previously absent, so the spec-160
   fire-and-forget tail threw internally on every run of that file and was
   silently swallowed by `loadItemsLastCounted`'s own `catch`; the suite was
   green while permanently exercising only the error path.
   **Proof the new test bites (per the coordinator's ask, reverted after):**
   (a) changing the fire-and-forget call to `await get().loadItemsLastCounted(sid)`
   deadlocked the AC-21 test and one AC-22 test (5000ms timeout — the awaited
   call can never resolve because it awaits a deferred promise the test only
   resolves AFTER `loadFromSupabase` returns); (b) removing the
   `sid === '__all__'` guard inside the action itself flipped the "action
   bails on `__all__`" assertion from pass to a genuine `toHaveBeenCalled()`
   failure. Both reverted; full 12/12 green again.
   **Security Low #3 (the missing "granted store A, asks for store B" pgTAP
   arm) was NOT taken in this pass** — it is filed under the release
   proposal's "take now if cheap, otherwise follow-up" tier, not the five
   must-fix items, and it is a pgTAP/SQL change to a different file
   (`supabase/tests/items_last_counted.test.sql`) than this item's scoped
   JS store-lifecycle test. Left for a follow-up per the proposal's own
   framing.
3. **AC-19 wiring (PARTIAL → PASS)** — two new assertions, no production code
   change (the wiring was already correct):
   - `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx`: the
     `FilterInput` mock now echoes its `placeholder` prop as text (was
     `() => null`); a new case asserts the items.tsv surface renders
     `filterPlaceholderItems`, not the untouched `filterPlaceholder` key.
     Reverting the `placeholder` prop at the call site was confirmed to fail
     this assertion, then reverted.
   - `src/screens/cmd/sections/phone/__tests__/PhoneInventoryList.test.tsx`:
     a new case reads the real `TextInput`'s `placeholder` prop directly
     (this surface isn't mocked) and asserts it equals
     `en.json`'s `section.inventory.filterPlaceholderItems`, not
     `filterPlaceholder`.
4. **S3 composed copy** — `src/screens/cmd/InventoryDesktopLayout.tsx`'s
   `DetailPane`: the meta line no longer wraps the never-counted OR the
   loading phrase in `lastCountedMeta`'s `"last counted {value}"` template
   (previously "last counted never counted" / "last counted loading"); a new
   `metaLastCountedFragment` ternary renders the bare localized phrase for
   those two cases and keeps the `"last counted {date}"` composition only for
   a genuine counted date. Extended to the loading case per the coordinator's
   ruling (the architect's write-up only covered `never`). Three new jest
   cases in `InventoryDesktopLayout.test.tsx` (loading / never / counted) pin
   all three branches of the ternary.
5. **M1 doc correction (spec text only, no code)** — §0.3 and §1.2 each gained
   a "Post-implementation correction" callout stating the inlining claim
   ("one grouped scan joined once") is false: `set search_path = public`
   makes `proconfig` non-null, which blocks
   `inline_set_returning_function()`, so `items_last_counted` still executes
   as a separate function scan inside `staff_items_updated`. No code action —
   measured 13.2 ms / 11.9 ms at ~52 400 `eod_entries`, well inside budget,
   and `search_path` pinning is not negotiable.

**Verification (fix pass) — full local gate set, all green:**
`npx tsc --noEmit` clean · `npm run typecheck:test` clean ·
**full `npx jest` → 216/216 suites, 2471/2471 tests** (215/2454 baseline + 17
new assertions across the new lifecycle file and the three touched test
files) · `npm run test:db` → **82/82 files**, including
`items_last_counted.test.sql` (16/16) and the still byte-unedited
`ingredient_changed_badge.test.sql` (20/20, confirmed via
`git diff --stat` showing zero hits on that path). No SQL migration
semantics touched; no prod-apply attempted (separate user-run step per the
release proposal's ship sequence).
