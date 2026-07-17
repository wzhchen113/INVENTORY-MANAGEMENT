# Spec 128: "Updated" badge for changed ingredients on staff count screens

Status: READY_FOR_REVIEW

## User story
As a counting staff member, when an ingredient's product has effectively changed — its photo was updated, or its primary vendor was switched — I want a subtle "Updated" badge on that item's row in the EOD and Weekly count screens so that I notice the item now looks different (or comes from a different vendor) and count the right physical thing, instead of grabbing the wrong item or not realizing it changed.

As a store manager (admin), I do not want stale badges: once my store has actually counted the changed item, the badge should disappear for my store (the change has been "seen"), while still showing for other stores that have not yet re-counted it.

## Context
Two write paths already exist that constitute a "product effectively changed" event:
- **Photo change (brand-level):** `catalog_ingredients.image_path` set/cleared via spec-127 `uploadIngredientImage` / `removeIngredientImage`. A photo change affects **every store's** row for that catalog ingredient.
- **Primary-vendor change (per-store):** `inventory_items.vendor_id` (the primary `item_vendors` link) changed via `db.updateInventoryItem` (vendorId / vendors[] reconcile), plus the spec-119 `apply_item_vendors_to_brand` and spec-122 fan-outs. Affects only the store(s) whose item's primary vendor moved.

The staff count screens already fetch items through the catalog→inventory join and (as of spec 127) surface `imagePath` on `EodItem` / `WeeklyItem`. The "since that store last counted" reference exists in `eod_submissions` (per store, per vendor, per date) and `inventory_counts` (weekly), both carrying a submitted timestamp the staff count fetch already reads.

## Acceptance criteria
- [ ] After an admin changes an ingredient's photo (`catalog_ingredients.image_path` set or cleared via spec-127 helpers), that ingredient shows an **"Updated" badge** on the EOD and Weekly count rows for **every store in the brand** whose most recent relevant count did not include the change.
- [ ] After an admin changes a store's item primary vendor (`inventory_items.vendor_id` via `updateInventoryItem` / the spec-119 / spec-122 fan-outs that touch the primary vendor), that item shows the "Updated" badge on **that store's** EOD and Weekly count rows — not on other stores' rows (unless they also changed).
- [ ] The badge **clears for a store** once that store submits a count (EOD or Weekly per the architect's defined comparison) that includes the item, and does **not** clear for other stores that have not yet re-counted it. (Per-store clearing; store A counting does not clear store B.)
- [ ] An unchanged item (no photo change and no primary-vendor change since the store's last relevant count) shows **no badge**.
- [ ] The badge is a **subtle, in-context visual** on the item row, pairing with the spec-127 photo/thumbnail (e.g. a small "Updated" pill/dot near the thumbnail or name) — it must not shift row layout or overlap the count input, and it must render on both web and native (staff runs both).
- [ ] The `changed`/`updated` signal reaches the row through the **existing staff count fetch/projection** (same path spec 127 used to add `imagePath`), as a computed boolean (or `changed_at` + `last_counted_at` that the row resolves) — **no separate per-row query**.
- [ ] Staff have **no acknowledge/dismiss control** — the only way to clear the badge is by the store completing a count that includes the item.
- [ ] Delivery is **visual only** — no web-push, no admin bell/notification, no new notification rows.

## In scope
- Recording a "product effectively changed" timestamp when a **photo** changes (brand-level) and when a **primary vendor** changes (per-store), at the write paths listed in Dependencies.
- Computing, per (store, item), whether the item changed **since that store last counted it**, and surfacing that as a `changed`/`updated` signal on the staff EOD + Weekly count fetch/projection (mirroring how spec 127 added `imagePath`).
- Rendering a subtle "Updated" badge on the EOD (`src/screens/staff/screens/EODCount.tsx`) and Weekly (`WeeklyCount.tsx`) count rows, composed near the spec-127 `IngredientThumb` (`src/screens/staff/components/`).
- Per-store clearing driven by the store's own count submissions (`eod_submissions` / `inventory_counts`).
- Migration for the new change-timestamp column(s) (see open questions) — additive, applied to prod via MCP per project policy, kept in sync with `schema_migrations` for the `db-migrations-applied` gate.
- Tests naming the track: pgTAP (the change-timestamp stamping / the per-(store,item) "changed since last count" comparison at the DB level) + jest (the badge render logic and the changed-vs-unchanged / clears-after-count row states). Track routing per test-engineer.

## Out of scope (explicitly)
- **Web-push / any push notification.** This is a passive staff-side visual only; the existing spec-120/121/126 notification infra is admin-facing and is NOT used here. Rationale: the request explicitly scopes delivery to an in-context badge.
- **Admin bell / admin-side surfacing.** No admin badge, no notification row, no admin "what changed" list.
- **Reorder screens or any surface other than the two staff count screens (EOD + Weekly).** Rationale: request scopes delivery to the count screens.
- **A new "brand" field or any additional change trigger.** Triggers are exactly: photo change OR primary-vendor change. No price, unit, name, category, or par-level change is a trigger in v1.
- **Per-user acknowledgement / dismiss.** Clearing is by the store completing a count, not by an individual staffer tapping the badge. No per-user "seen" state.
- **History / audit surface.** No "changed on X, was vendor Y" detail view, no change log, no drill-down in v1 — just the presence/absence of the badge.
- **Realtime live-update of the badge** as the change happens. It appears on the staff screen's next data load (staff v1 has no realtime, per spec 062). If the architect wants live update, `brand-{id}` / `store-{id}` is the channel and the realtime-publication gotcha applies — flagged as a risk, not a requirement.

## Open questions resolved (from the feature request — do NOT re-open)
- Q: What counts as a "product effectively changed" event? → A: A **photo change** (`catalog_ingredients.image_path`, brand-level) **OR** a **primary-vendor change** (`inventory_items.vendor_id`, per-store). No new brand field.
- Q: How is it delivered to staff? → A: An in-context **"Updated" badge** on the item rows of **both** staff count screens (EOD + Weekly). No push. Optional top-of-screen "N updated" banner is left to the architect (see open question 5).
- Q: How does the badge clear? → A: **Per-store**, when that store next counts the item. It shows for changes **since that store last counted the item**, and clears for a store once it counts the item again. Store A counting does not clear it for store B.
- Q: Is this admin-facing at all? → A: **No.** Passive staff-side visual only; admin notification infra is not used.

## Open questions for the architect (genuinely open — decide in design doc)
1. **Where the change timestamp lives, and how brand + per-store combine into one comparable `changed_at`.** Photo is brand-level (candidate: `catalog_ingredients.image_updated_at`) but the primary-vendor change is per-store (candidate: `inventory_items.product_changed_at`). Define how a brand-level photo `changed_at` and a per-store vendor `changed_at` combine into a single effective "last changed" per (store, item) the count fetch can compare — e.g. `greatest(catalog.image_updated_at, inventory_item.product_changed_at)`. Confirm column names, nullability (NULL = never changed), and where the `greatest()` is evaluated (view, RPC, or the existing select projection).
2. **The "since last counted" reference and the exact appear/clear comparison.** Define the reference time per (store, item): the store's most recent **submitted** EOD/weekly count that **included the item**, vs a simpler store-level "last count of that kind." Specify the exact predicate that makes the badge appear (`effective_changed_at > last_counted_at`) and clear, and whether it is per-item or per-count-cycle. Address the two count kinds (EOD is per-vendor/date via `eod_submissions`; Weekly is via `inventory_counts`) — is the reference the max over both, or per-screen?
3. **How the flag reaches the row.** Surface a computed `changed`/`updated` boolean (or `effective_changed_at` + `last_counted_at`) through the staff EOD (`EODCount.tsx` `fetchItemsForVendor`) and Weekly (`WeeklyCount.tsx` `fetchAllItemsForStore`) fetch/projection onto `EodItem` / `WeeklyItem`, mirroring how spec 127 added `imagePath`, so the row renders the badge with no extra per-row query. Decide: compute in SQL (view/RPC returning the boolean) vs compute client-side from two timestamps in the projection.
4. **Bump points — triggers vs. explicit stamping.** Enumerate exactly which write paths must stamp the change timestamp and how:
   - **Photo:** spec-127 `uploadIngredientImage` / `removeIngredientImage` (set `catalog_ingredients.image_updated_at`).
   - **Vendor:** `db.updateInventoryItem` primary-vendor reconcile, the spec-119 `apply_item_vendors_to_brand`, and the spec-122 scalar fan-out **if and only if** it changes the primary `vendor_id` (stamp `inventory_items.product_changed_at` only when `vendor_id` actually changes, not on every write).
   Decide DB trigger (e.g. `BEFORE UPDATE ... WHEN (old.vendor_id IS DISTINCT FROM new.vendor_id)`) vs explicit stamping in each helper. A trigger is more robust against missed call sites; explicit stamping is more visible. Recommend one and justify.
5. **Top-of-screen "N items updated" banner — v1 or deferred?** The request leaves this to the architect ("architect can decide if it's cheap"). If the changed-count is already derivable from the projected rows, a small banner is nearly free; decide whether to include it in v1 or defer, and if included, its exact copy/placement so it does not conflict with existing count-screen chrome.

## Dependencies
- **Spec 127** (ingredient photos) — provides `catalog_ingredients.image_path`, the spec-127 upload/remove helpers (the photo bump point), the `imagePath` projection onto `EodItem`/`WeeklyItem`, and `IngredientThumb` (the badge composes next to it). This spec builds directly on 127's fetch/projection changes.
- **Spec 119** `apply_item_vendors_to_brand` and **spec 122** scalar fan-out — vendor bump points that must stamp the per-store change timestamp when they move the primary `vendor_id`.
- `db.updateInventoryItem` (`src/lib/db.ts`) vendor reconcile — the primary interactive vendor-change path.
- `eod_submissions` and `inventory_counts` — the "last counted" reference tables (already read by the staff fetches).
- Staff fetch/projection sites: `src/screens/staff/screens/EODCount.tsx` (`fetchItemsForVendor`), `src/screens/staff/screens/WeeklyCount.tsx` (`fetchAllItemsForStore`); staff types `src/screens/staff/lib/types.ts` (`EodItem`, `WeeklyItem`); `src/screens/staff/components/IngredientThumb.tsx` and the EOD/Weekly `leading`-node composition.
- New migration: change-timestamp column(s) on `catalog_ingredients` and/or `inventory_items` (+ any trigger). Additive; prod apply via Supabase MCP per project policy; must land in prod `schema_migrations` to keep `db-migrations-applied` green.

## Project-specific notes
- **Cmd UI section / legacy:** no admin UI in this spec beyond the *existing* write paths that stamp the timestamp (spec-127 photo helpers, `updateInventoryItem` vendor reconcile). The visible surface is the **staff** count screens (staff subtree, peer to cmd/, spec 063). No new Cmd section.
- **Per-store or admin-global:** **mixed and this is the crux** — the photo trigger is brand-level (all stores), the vendor trigger and the "seen/cleared" state are **per-store**. The effective badge is computed per (store, item). Respects per-store scoping via `eod_submissions` / `inventory_counts` being store-scoped.
- **Realtime channels touched:** none required for v1 (staff has no realtime per spec 062; badge appears on next data load). If the architect opts into live update, `brand-{id}` (photo) / `store-{id}` (vendor) apply and the realtime-publication gotcha is a risk.
- **Migrations needed:** yes — change-timestamp column(s) and possibly a trigger. Additive.
- **Edge functions touched:** none expected (stamping happens in existing RPC/PostgREST write paths; the badge rides the existing staff projection). Architect to confirm.
- **Web/native scope:** the badge render is **web + native** (staff app runs both). The stamping write paths are wherever they already run (admin Cmd editor is web; the vendor RPCs are DB-side).
- **Tests:** pgTAP (stamping on photo/vendor change + the per-(store,item) "changed since last count" predicate) and jest (badge render states: changed vs unchanged, clears-after-count). Track routing per test-engineer.
- **app.json slug:** not touched. No build-identifier / push-cert change in this spec.

---

## Backend design

### 0. Resolution of the five open questions (decisions)

1. **Where the change timestamp lives.** Two nullable `timestamptz` columns, NULL = never changed:
   `catalog_ingredients.image_changed_at` (brand-level, one row shared by all stores) and
   `inventory_items.vendor_changed_at` (per-store). The effective per-(store, item) `changed_at` is
   `greatest(catalog.image_changed_at, item.vendor_changed_at)` — Postgres `greatest()` ignores NULLs
   and returns NULL only when both are NULL, which is exactly the semantics we want.
2. **"Since last counted" reference.** `last_counted_at(store, item)` = `max(submitted_at)` over the
   union of **submitted** EOD counts (`eod_submissions` ⨝ `eod_entries`) and **submitted** weekly/any-time
   counts (`inventory_counts` ⨝ `inventory_count_entries`) for that `(store_id, item_id)`. Predicate:
   `updated = changed_at IS NOT NULL AND (last_counted_at IS NULL OR changed_at > last_counted_at)`.
   Reference is the **max over both** count kinds (not per-screen): a change is "seen" once the store
   counts the item in *any* count flow. `submitted_at` (wall-clock write) is the comparison basis on both
   sides — a late/back-dated EOD still has `submitted_at = now()`, so counting after a change clears it.
3. **How the flag reaches the row.** All comparison logic is computed **in SQL, one place**: a new
   `security invoker` set-returning RPC `staff_items_updated(p_store_id)`. Each screen fetches the result
   once (best-effort, in parallel with the item fetch — same posture as `fetchLowStock` in WeeklyCount),
   builds a `Set<item_id>` of updated items, and merges `updated: boolean` onto each `EodItem`/`WeeklyItem`
   before `setItems` — mirroring how spec 127 rides `imagePath`. No per-row query; one store-scoped RPC call.
4. **Bump points → DB TRIGGERS (not explicit stamping).** Confirmed: two `BEFORE UPDATE` row triggers.
   Bypass-proof — they catch `updateInventoryItem`'s per-store `vendor_id` write, the spec-119
   `apply_item_vendors_to_brand` scalar mirror, the spec-122 scalar fan-out, `uploadIngredientImage` /
   `removeIngredientImage`, and any future/direct-SQL path, stamping **only when the watched column actually
   changes** (`IS DISTINCT FROM`). See §5 for the SD-1 non-interference confirmation.
5. **Top-of-screen "N updated" banner → DEFERRED (not dropped).** v1 ships the per-row badge only. The
   updated count is trivially derivable from the merged rows (`items.filter(i => i.updated).length`), so a
   future banner is nearly free — noted for a follow-up.

### 1. Data model changes

New migration: **`supabase/migrations/20260722000000_ingredient_changed_badge.sql`** — additive, non-destructive.

> **Hard ordering dependency:** this migration references `catalog_ingredients.image_path`, which is added by
> spec 127's `20260721000000_ingredient_photos.sql`. The `20260722…` timestamp guarantees it runs after 127
> both locally and in prod. 128 must not be applied to prod before 127.

Columns (additive, nullable, no default, no backfill → existing rows stay NULL → nothing renders "updated"
retroactively, which is the correct rollout posture):

```sql
alter table public.catalog_ingredients add column if not exists image_changed_at  timestamptz;
alter table public.inventory_items     add column if not exists vendor_changed_at timestamptz;
```

Cheap insurance index for the RPC's per-item aggregate (`inventory_count_entries` already has an
`(item_id, created_at)` index from spec 019; `eod_entries` has none on `item_id`):

```sql
create index if not exists eod_entries_item_id_idx on public.eod_entries(item_id);
```

Two `BEFORE UPDATE` triggers (trigger fns + `drop trigger if exists` → `create trigger`, all idempotent for
the local + prod-MCP double-apply):

```sql
create or replace function public.stamp_catalog_image_changed_at() returns trigger
language plpgsql as $$
begin
  if new.image_path is distinct from old.image_path then
    new.image_changed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_catalog_image_changed_at on public.catalog_ingredients;
create trigger trg_catalog_image_changed_at
  before update on public.catalog_ingredients
  for each row execute function public.stamp_catalog_image_changed_at();

create or replace function public.stamp_item_vendor_changed_at() returns trigger
language plpgsql as $$
begin
  if new.vendor_id is distinct from old.vendor_id then
    new.vendor_changed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_item_vendor_changed_at on public.inventory_items;
create trigger trg_item_vendor_changed_at
  before update on public.inventory_items
  for each row execute function public.stamp_item_vendor_changed_at();
```

Rollout safety: additive columns + `BEFORE` triggers that only *set a NEW column on the row being written*.
`INSERT` is not covered (creation is not a "change" — an item's initial `vendor_id` and a catalog's initial
`image_path` do not stamp), matching the intent. No lock beyond the brief `ALTER TABLE ADD COLUMN` (metadata-only
in PG11+). Applied to prod via Supabase MCP per project policy; register the exact version string in
`supabase_migrations.schema_migrations` to keep the `db-migrations-applied` gate green.

### 2. RLS impact

**No new tables, no new/changed policies.** The two columns live on existing tables whose policies already
govern them (Postgres RLS is row-level, not column-level; the columns are trigger-written, so no client ever
writes them directly). `catalog_ingredients` read/write stays under the brand-scoped policies
(`auth_is_privileged()` + `auth_can_see_brand`); `inventory_items` stays under the per-store four-policy
template (`auth_can_see_store`). The RPC (§3) is `security invoker`, so it reads under the caller's existing
RLS — a manager only ever sees their own store's `inventory_items` / count rows, and brand-visible catalog rows.
Passing a store the caller can't see returns an empty set (RLS filters the `inventory_items` rows), so no
explicit `42501` gate is required.

### 3. API contract

**New RPC (PostgREST-callable), the single source of truth for the badge:**

```sql
create or replace function public.staff_items_updated(p_store_id uuid)
returns table(item_id uuid, changed_at timestamptz, last_counted_at timestamptz, updated boolean)
language sql stable security invoker set search_path = public
as $$
  select
    ii.id,
    ge.changed_at,
    lc.last_counted_at,
    (ge.changed_at is not null
       and (lc.last_counted_at is null or ge.changed_at > lc.last_counted_at)) as updated
  from public.inventory_items ii
  join public.catalog_ingredients ci on ci.id = ii.catalog_id
  cross join lateral (select greatest(ci.image_changed_at, ii.vendor_changed_at) as changed_at) ge
  left join lateral (
    select max(t.submitted_at) as last_counted_at
    from (
      select es.submitted_at
        from public.eod_submissions es
        join public.eod_entries ee on ee.submission_id = es.id
       where es.store_id = p_store_id and ee.item_id = ii.id and es.status = 'submitted'
      union all
      select ic.submitted_at
        from public.inventory_counts ic
        join public.inventory_count_entries ice on ice.count_id = ic.id
       where ic.store_id = p_store_id and ice.item_id = ii.id and ic.status = 'submitted'
    ) t
  ) lc on true
  where ii.store_id = p_store_id;
$$;
revoke execute on function public.staff_items_updated(uuid) from public, anon;
grant  execute on function public.staff_items_updated(uuid) to authenticated;
```

- **Request:** `supabase.rpc('staff_items_updated', { p_store_id })`.
- **Response:** array of `{ item_id, changed_at, last_counted_at, updated }`. The client only consumes
  `item_id` + `updated`; the two timestamps are returned to aid pgTAP assertions and debugging (harmless —
  brand-level image timing is not sensitive).
- **Error cases:** RLS-invisible store → empty array (no raise). RPC-level failure surfaces to the
  best-effort `.catch()` in the screen → no badges, list still renders.
- **No new PostgREST table/view route** — the existing `item_vendors` (EOD) and `inventory_items` (Weekly)
  embeds are untouched; the badge rides a parallel RPC rather than bloating those selects with correlated
  aggregates. This is the `report_weekly_lowstock` pattern already proven on WeeklyCount.

### 4. Edge function changes

**None.** Stamping is trigger-driven at the DB; the badge rides an RPC and the existing staff projection.
`verify_jwt` settings unchanged.

### 5. SD-1 / vendor-mirror non-interference (confirmed)

The vendor trigger fires on `public.inventory_items` and only when `inventory_items.vendor_id IS DISTINCT
FROM` its prior value. The SD-1 "one writer owns both" invariant governs `item_vendors.is_primary` mirroring
the scalar — those writes are on the **`item_vendors`** table, which the trigger never touches. In
`updateInventoryItem` the scalar `vendor_id` write (the `perStore` UPDATE, db.ts:457-463) and the
`item_vendors` reconcile (db.ts:477-532) are separate statements; the trigger stamps only on the former and
only on a real change. `apply_item_vendors_to_brand` and the spec-122 scalar fan-out both write
`inventory_items.vendor_id` per store, so the trigger catches those too — again only on an actual change.
A cost-only or vendors-only edit that leaves `vendor_id` unchanged does **not** stamp. No client code change
is required at any of these paths (the whole point of the trigger).

### 6. Client surface

**No `src/lib/db.ts` change** — the staff subtree is a documented direct-`supabase` carve-out (spec 063), and
this fetch mirrors the existing `fetchLowStock` / `fetchCountOrder` direct-RPC posture. New staff-local helper:

- **`src/screens/staff/lib/itemsUpdated.ts`** →
  `export async function fetchUpdatedItemIds(storeId: string): Promise<Set<string>>`
  Calls `supabase.rpc('staff_items_updated', { p_store_id: storeId })`, returns
  `new Set(rows.filter(r => r.updated).map(r => r.item_id))`. snake→camel: none needed (consumes `item_id`
  as the merge key, `updated` as the flag).

**Type additions** (`src/screens/staff/lib/types.ts`): add `updated?: boolean` to both `EodItem` and
`WeeklyItem` (absent/false → no badge). `InventoryItem` in `src/types/index.ts` is **not** touched — no admin
surface consumes this.

**Fetch merge:**
- **EOD** (`EODCount.tsx`, the `fetchItemsForVendor` effect, ~L420): add
  `fetchUpdatedItemIds(activeStore.id).catch(() => new Set<string>())` to the existing `Promise.all`, then
  map `updated: set.has(item.id)` onto `nextItems` before `setItems`. Best-effort (`.catch` → empty set) so a
  badge-fetch failure never breaks the count list.
- **Weekly** (`WeeklyCount.tsx`, the `fetchAllItemsForStore` mount effect, ~L286): fetch
  `fetchUpdatedItemIds` in parallel (`Promise.all([...])`, `.catch(() => new Set())`) and merge
  `updated: set.has(r.id)` onto the mapped items before `setItems`. (Keeps the merge on the item type rather
  than a separate map, per the spec-127 `imagePath` precedent.)

### 7. Badge UI

New shared staff component **`src/screens/staff/components/UpdatedBadge.tsx`** (mirrors `IngredientThumb` as a
small, self-contained, colors/tokens-aware view — used by both screens so the pill is byte-identical). Renders
a subtle pill reading `t('chrome.updatedBadge')` ("Updated") in an **info/primary** tone (distinct from the
Weekly `LOW` warning pill), no layout shift, web + native. New staff i18n key `chrome.updatedBadge` (shared
`chrome` catalog) + an accessibility label.

- **WeeklyCount** already has the exact shape: an `itemNameRow` wrapping the name + the `LOW` pill
  (renderWeeklyRow, ~L933). Add `{item.updated ? <UpdatedBadge testID={\`weekly-updated-badge-${item.id}\`}/> : null}`
  into that row alongside the LOW badge.
- **EOD** (renderEodRow, ~L729) currently puts the name directly in `leadingText`; wrap the name `Text` in a
  small row (like Weekly's `itemNameRow`) and add
  `{item.updated ? <UpdatedBadge testID={\`eod-updated-badge-${item.id}\`}/> : null}`.

The badge composes next to the name (not overlapping the trailing count inputs), satisfying the "no layout
shift / no input overlap / web+native" AC.

### 8. Realtime impact

**No publication change** → the `docker restart supabase_realtime_imr-inventory` gotcha does **not** apply.
The new columns land on `catalog_ingredients` and `inventory_items`, which are already in `supabase_realtime`
(`FOR ALL TABLES`); no `alter publication`. Staff has no realtime in v1 (spec 062), so the badge appears on the
next data load — matching every other staff signal. Admin's `brand-{id}` / `store-{id}` channels replay the
underlying catalog/item changes as before; the new columns simply ride along. Live badge update is out of
scope (per spec).

### 9. Frontend store impact

**None in `src/store/useStore.ts` and none in `useStaffStore`.** The badge is read-only screen-local state
(the `updated` flag merged onto `items`, exactly like `imagePath`), so the optimistic-then-revert /
`notifyBackendError` pattern does not apply to the badge itself. The admin write paths that *cause* a change
(spec-127 photo helpers, `updateInventoryItem` vendor reconcile) are unchanged — the stamping is now
server-side via triggers, needing no client edit.

### 10. Risks and tradeoffs

- **Migration ordering (Critical to get right):** 128 depends on 127's `image_path`. Enforced by timestamp;
  do not push 128 to prod before 127. Both must land in `schema_migrations`.
- **RPC performance on prod:** per-store scan of `inventory_items` (hundreds of rows) × two lateral aggregates.
  `inventory_count_entries(item_id, …)` is indexed (spec 019); the migration adds `eod_entries(item_id)`.
  Bounded per-store history keeps this cheap; on the 286 KB seed it is trivial. If it ever shows up hot, the
  `updated` set could be materialized, but that's premature for v1.
- **`greatest()` NULL semantics** are load-bearing — pgTAP must pin "photo-only", "vendor-only", "both", and
  "neither (NULL)" cases so a future refactor to `coalesce`/`max` doesn't silently change behavior.
- **`submitted_at` vs `counted_at`/`date` choice:** using `submitted_at` on both sides is deliberate (the
  wall-clock moment the store recorded the count). A back-dated EOD or a backdated `counted_at` therefore still
  clears the badge, which is correct (the physical recount happened after the change). Documented so a reviewer
  doesn't "fix" it to `date`.
- **Draft counts:** filtered out (`status = 'submitted'`) on both sides — a saved-but-unsubmitted weekly draft
  must not clear the badge.
- **Trigger scope:** `IS DISTINCT FROM` guards against no-op stamping (a save that re-writes the same
  `vendor_id`/`image_path` won't bump). Confirmed not to disturb SD-1 (§5).
- **Edge/RPC cold-start:** N/A — it's an in-DB RPC, not an edge function.

### 11. Test surface

**pgTAP** (`supabase/tests/ingredient_changed_badge.test.sql`):
- Columns `image_changed_at` / `vendor_changed_at` exist, nullable, `timestamptz`; both triggers exist.
- `update catalog_ingredients set image_path=…` stamps `image_changed_at`; a name-only update does **not**.
- `update inventory_items set vendor_id=…` stamps `vendor_changed_at`; a cost-only update does **not**;
  re-writing the same `vendor_id` does **not** (`IS DISTINCT FROM`).
- `staff_items_updated`: never-counted edge (`changed_at` set, no count → `updated=true`);
  `changed_at > last_counted_at` → true; a submitted count after the change → `updated=false` (clears);
  `changed_at` NULL → false; `last_counted_at` = max over BOTH eod and weekly submitted counts; a
  `status='draft'` weekly does not clear; `greatest()` photo-only / vendor-only / both.

**jest**:
- `UpdatedBadge` renders its text/testID.
- `renderEodRow` / `renderWeeklyRow` show the badge iff `item.updated` (testIDs
  `eod-updated-badge-*` / `weekly-updated-badge-*`), hidden when false/undefined.
- Merge: `fetchUpdatedItemIds` set → items receive the `updated` flag (extract the merge into a small pure
  helper if convenient for unit coverage).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the Backend design in specs/128-ingredient-changed-badge.md. Backend:
  author migration 20260722000000_ingredient_changed_badge.sql (two columns + eod_entries(item_id) index +
  the two BEFORE UPDATE triggers + the staff_items_updated RPC with revoke/grant) and the pgTAP file
  supabase/tests/ingredient_changed_badge.test.sql. Frontend: add the fetchUpdatedItemIds staff helper,
  updated?: boolean on EodItem/WeeklyItem, the shared UpdatedBadge component + chrome.updatedBadge i18n key,
  and the fetch-merge + badge render in EODCount.tsx and WeeklyCount.tsx, plus jest. Do NOT touch src/lib/db.ts
  (staff carve-out) or the app.json slug. After implementation set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/128-ingredient-changed-badge.md

## Files changed (frontend — spec 128)

New:
- `src/screens/staff/lib/itemsUpdated.ts` — `fetchUpdatedItemIds(storeId)` best-effort staff carve-out (calls `staff_items_updated`, returns `Set<item_id>`, swallows errors to empty).
- `src/screens/staff/lib/itemsUpdated.test.ts` — jest (call shape, Set projection, error/thrown/non-array degrade).
- `src/screens/staff/components/UpdatedBadge.tsx` — subtle "Updated" pill (info tone), shared by both count screens.
- `src/screens/staff/components/UpdatedBadge.test.tsx` — jest (label, testID, a11y label).

Modified:
- `src/screens/staff/screens/EODCount.tsx` — fetch `fetchUpdatedItemIds` in the item-load `Promise.all`, merge `updated` onto items, render `<UpdatedBadge>` in a new `itemNameRow`.
- `src/screens/staff/screens/EODCount.test.tsx` — `rpc` mock channel + `mockUpdatedResult`; badge-render / empty-set / RPC-failure tests.
- `src/screens/staff/screens/WeeklyCount.tsx` — fetch `fetchUpdatedItemIds` in parallel with `fetchAllItemsForStore`, merge `updated`, render `<UpdatedBadge>` next to the LOW pill.
- `src/screens/staff/screens/WeeklyCount.test.tsx` — `rpc` mock now dispatches `staff_items_updated` to `mockUpdatedResult`; badge-render / empty-set / RPC-failure tests.
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json` — added `chrome.count.updatedBadge` (Updated / Actualizado / 已更新).

NOT modified by frontend (owned by backend, per task): `src/screens/staff/lib/types.ts` (the `updated?: boolean` field on `EodItem`/`WeeklyItem` landed via the parallel backend change during implementation; frontend consumes it), `supabase/migrations/*`, `src/lib/db.ts`, `app.json`.

## Verification (frontend)
- `npx tsc --noEmit` — clean.
- `npm run typecheck:test` — clean.
- `npx jest` (full) — 120 suites / 1285 tests passing, including the new spec-128 helper, badge, EOD/Weekly merge+render suites and the staff i18n parity test.
- Browser: the staff count surface is only mounted for staff-role sessions (unreachable via the admin-only local login), and no `preview_*` tooling was available in this environment. The badge's **web** render path is instead covered by the jsdom/react-native-web render tests (`UpdatedBadge.test.tsx` plus the `EODCount`/`WeeklyCount` badge tests run through react-native-web under jest-expo). Flagged explicitly rather than claimed.
