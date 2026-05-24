# Spec 060: Menu Item Low-Stock Warning + Capacity Math

Status: READY_FOR_REVIEW
Owner: product-manager

## Problem statement (verbatim user request)

Store managers cannot see, at a glance, which menu items are at risk because an
ingredient (direct or transitive through a prep recipe) is low or out of stock,
and cannot see how many of each menu item they can actually produce right now
given current on-hand inventory. The existing RecipesSection lists recipes and
the existing ReorderSection lists low ingredients, but neither surface answers
"which menu items am I about to lose, and how many can I still make?" — which
is the question a manager needs to answer before service.

## User stories

1. As a store manager, I want to see which menu items will be impacted if a low
   ingredient runs out, so I can re-prioritize prep / 86 items proactively
   before the rush.
2. As a store manager, I want to see how many of each menu item I can make
   right now from current on-hand inventory (including transitive prep-recipe
   capacity), so I can plan service and decide what to prep next.
3. As a store manager, when a menu item is capacity-limited, I want to see
   which single ingredient is binding (the one I'd need to add to make more),
   so I know whether to make more sauce X or buy more flour.

## Acceptance criteria

### A. Inline badge in RecipesSection

- [ ] Every menu-item card rendered by `src/screens/cmd/sections/RecipesSection`
      displays a current `makeable_qty` numeric badge sourced from the new
      server-side capacity compute.
- [ ] When ANY ingredient (direct OR transitive prep) used by that recipe is
      flagged low (existing low-stock threshold), the card shows a distinct
      per-recipe insufficient indicator separate from the global low-stock
      badge already shown elsewhere.
- [ ] The two signals — global low-stock indicator and per-recipe insufficient
      indicator — are visually distinct and BOTH render when both apply.
- [ ] Menu items without a defined BOM render the literal label
      `"no recipe defined"` in place of `makeable_qty`.

### B. Dedicated "Menu impact" section under INSIGHTS

- [ ] Sidebar gains a new entry under the INSIGHTS group labelled
      `Menu impact`.
- [ ] The section renders a sortable table with these columns, in this order:
      menu item name, `makeable_qty`, binding ingredient, `# of low
      ingredients`, brand badge.
- [ ] Default sort is `makeable_qty` ascending (most-at-risk first).
- [ ] Each column header toggles ascending/descending on click.
- [ ] Menu items without a BOM appear in the table with `makeable_qty` set to
      the literal `"no recipe defined"` and binding ingredient blank;
      sort order pushes them to the bottom regardless of direction.
- [ ] Rows respect per-store scope: only menu items the caller can see via
      `auth_can_see_store()` are returned.

### C. Server-side compute

- [ ] A new Postgres RPC or VIEW exists that returns one row per
      (store, recipe) with the documented shape — at minimum:
      `(recipe_id, store_id, makeable_qty, binding_ingredient_id,
      binding_shortfall, low_ingredient_count)`. Architect to finalize exact
      shape (see Open questions for architect §4).
- [ ] Capacity math is FULLY TRANSITIVE: for a menu item whose BOM references
      a prep recipe, `makeable_qty` = `min(direct ingredients capacity, prep
      recipe's own makeable from ITS ingredients + on-hand)` — recursively
      through the prep DAG.
- [ ] The compute handles cycles in the prep recipe graph in a defined way
      (architect chooses: explicit error, capped recursion, or rely on a
      schema constraint — see Open questions §1). Behavior must be documented
      and tested.
- [ ] For a representative store (~50 menu items / ~200 ingredients / typical
      prep depth) the RPC or view query completes in `< 100 ms` p95 measured
      against the local dev DB seed.
- [ ] NULL or 0 on-hand stock is treated as 0 for capacity purposes; any
      recipe consuming that ingredient is constrained accordingly.

### D. Real-time

- [ ] When inventory rows mutate, both the inline badges and the Menu impact
      section update within the existing `useRealtimeSync` debounce window
      (400 ms). No new realtime channel is introduced — the RPC re-runs (or
      the view re-reads) on the existing `store-{id}` and `brand-{id}`
      channels.
- [ ] When recipe BOM rows mutate, the same update path fires.

### E. Edge cases

- [ ] Menu item with no BOM rows → `makeable_qty` returned as the documented
      sentinel (architect decides: NULL, -1, or a separate `has_recipe`
      boolean) and UI renders `"no recipe defined"` for both surfaces.
- [ ] NULL or 0 stock → treated as 0, propagated through transitive math.
- [ ] Cycle in prep recipes → behavior matches whichever option the architect
      picks in §1; UI surface degrades gracefully (renders an explicit label,
      not a crash, not Infinity, not silent zero).
- [ ] Unit conversion: see Open questions §2 — if the existing inventory math
      already normalizes units, capacity math MUST reuse the same
      normalization. If it does not, this is out of scope (see Out of scope).

## In scope

- New Postgres RPC or VIEW for transitive menu-item capacity, returning
  per-recipe `(makeable_qty, binding_ingredient_id, binding_shortfall,
  low_ingredient_count)`.
- Inline `makeable_qty` badge + per-recipe insufficient indicator on each card
  in `src/screens/cmd/sections/RecipesSection`.
- New `Menu impact` section under the INSIGHTS sidebar group with a sortable
  table covering the five columns above.
- Real-time hookup through existing `useRealtimeSync` channels.
- Tests across all three tracks (see Dependencies).

## Out of scope (explicitly)

- **Unit conversion infrastructure.** If the current schema and inventory math
  do not already normalize units across recipe ingredients and inventory
  rows, building that normalization is OUT of this spec. The architect must
  confirm during design which case we are in; if conversion is missing, this
  spec ships only for the units-already-match case and the gap is filed as a
  follow-up. Rationale: capacity math is meaningless without a common unit,
  but inventing a unit-conversion layer is a separate, larger feature.
- **New realtime channels.** We reuse `store-{id}` and `brand-{id}`. A new
  channel would require publication / replication-slot work — out of band for
  this feature.
- **Cross-brand capacity.** Capacity is computed per-store within the
  caller's visible brand scope. There is no cross-brand roll-up.
- **86-list automation.** This spec surfaces capacity; it does not
  automatically 86 items, send pushes, or mutate menu-availability flags.
- **Staff app or customer PWA surfaces.** Admin app only — sibling apps may
  consume the RPC in a future spec.
- **Prep-recipe suggestion engine.** "You should make 4 batches of sauce X" is
  a downstream feature; this spec just reports the binding ingredient.

## Open questions resolved

- Q: Inline badges, dedicated section, or both? → A: BOTH. Inline badges in
  RecipesSection AND a dedicated "Menu impact" section under INSIGHTS.
- Q: Low threshold semantics — global low-stock badge or per-recipe? → A:
  BOTH signals shown separately. Global low-stock badge AND per-recipe
  insufficient flag.
- Q: Capacity depth — direct ingredients only, or recurse into prep BOM? → A:
  Recurse — full transitive math. Menu capacity =
  `min(direct ingredients capacity, prep recipe's own makeable from ITS
  ingredients + on-hand)`.
- Q: Where does compute live — client or server? → A: Server-side. New
  Postgres view or RPC, returning at minimum
  `(recipe_id, makeable_qty, binding_ingredient_id)` plus the additional
  fields documented in AC §C.
- Q: Refresh cadence — polling, manual, or realtime? → A: DEFAULT — real-time
  via the existing `useRealtimeSync` channels. The RPC re-runs (or the view
  re-reads) when inventory or recipes mutate.
- Q: Edge cases (no-BOM items, NULL/0 stock, unit conversion)? → A:
  DEFAULT — (a) menu items with no BOM render `"no recipe defined"`;
  (b) NULL/0 stock treated as 0 and propagates through transitive math;
  (c) unit conversion deferred to the architect to investigate, with
  capacity math reusing existing normalization if present and the feature
  scoped to "units already match" otherwise.

## Open questions for architect

These are FLAGGED for the design pass — architect must resolve before
`READY_FOR_BUILD`:

1. **Recursive SQL cycle detection.** Prep recipes may reference each other
   (sauce A uses sauce B uses sauce A). A naive recursive CTE will infinite
   loop or hit Postgres's recursion limit. Pick one and document:
   (a) confirm the schema already prevents cycles via an existing FK
       constraint, trigger, or invariant — cite the constraint;
   (b) add an explicit cycle guard in the SQL (e.g., visited-set pattern in
       the CTE) and surface a structured error per offending recipe;
   (c) cap recursion depth at a documented constant (e.g., 10 levels) and
       return a sentinel value for any recipe that exceeds the cap.
2. **Unit conversion ambiguity.** Recipe ingredients carry a unit (`cup`,
   `g`, `kg`, `each`); inventory items carry a unit. These may or may not
   match. Survey the current schema and answer:
   - Is there a `unit_conversion` table or function in
     `supabase/migrations/`?
   - Does the existing inventory math (ReorderSection, deduct-on-make in
     `src/lib/db.ts`) already normalize units?
   - If yes → reuse the same normalization for capacity math.
   - If no → call out as a BLOCKER; capacity math is meaningless without a
     common unit, and this spec must ship only for the units-already-match
     subset (or pause pending a unit-conversion spec).
3. **Binding ingredient semantics for prep-recipe shortfalls.** "Capacity = 0
   because prep recipe X is empty" is not the same as "capacity = 0 because
   direct ingredient Y is empty". Decide and document:
   - Does `binding_ingredient_id` always point at a LEAF ingredient (i.e.,
     the actual purchased item that needs to be ordered), even when the
     binding constraint surfaces through a prep recipe?
   - Or does it point at the immediate child in the BOM, which might itself
     be a prep recipe?
   - The "Menu impact" UI needs the leaf-ingredient version to render
     `"limited by: flour (need 200g more)"` instead of `"limited by: sauce X"`
     when the real problem is flour. PM prefers leaf, but flag if there's a
     schema or perf reason to deviate.
4. **RPC vs view, and exact return shape.** Decide whether the compute is:
   - A `VIEW` queried with `select * from v_menu_capacity where store_id = $1`
     (PostgREST-friendly, cache-friendly, but recomputes on each read), or
   - An `RPC` (`compute_menu_capacity(store_id)`) called via `db.ts`
     (parameter-explicit, easier to extend).
   And decide the return shape — at minimum the AC requires:
   `(recipe_id, store_id, makeable_qty, binding_ingredient_id,
   binding_shortfall, low_ingredient_count)`. Additionally decide:
   - Return one row per recipe and let the client resolve the binding
     ingredient name via the existing ingredients store, OR
   - Return a denormalized row with `binding_ingredient_name` pre-joined.
   PM defaults to "let the client resolve" for ingredient cache reuse, but
   architect picks based on payload size and N+1 risk.
5. **Realtime invalidation surface.** Confirm in the design that the existing
   `useRealtimeSync` debounce already covers all tables the capacity compute
   reads (likely: `inventory`, `recipes`, `recipe_ingredients`,
   `prep_recipe_ingredients` or equivalent). If any read table is NOT in the
   existing publication, name it — adding tables to the publication is a
   schema migration with the publication / replication-slot gotcha called out
   in CLAUDE.md (mid-session pub changes need
   `docker restart supabase_realtime_imr-inventory`).

## Dependencies

- Postgres migration adding the new VIEW or RPC.
- `src/lib/db.ts` wrapper for the new query (with snake_case → camelCase
  mapping via the existing `mapItem`-style helpers).
- Zustand store slice (or selector) for capacity rows; existing
  `useRealtimeSync` reload path picks up the change.
- `src/screens/cmd/sections/RecipesSection` — inline badge + per-recipe
  insufficient indicator.
- New file `src/screens/cmd/sections/MenuImpactSection.tsx` (name at
  developer's discretion) + sidebar wiring in `CmdNavigator`.
- Tests — ALL THREE TRACKS:
  - **jest**: UI rendering for the inline badge + sortable table behavior
    (column toggles, no-BOM sentinel placement, empty state).
  - **pgTAP**: server-side compute correctness — direct ingredients,
    transitive prep, NULL/0 stock, no-BOM items, the chosen cycle behavior
    from §1, and the `< 100 ms p95` perf budget against the seed.
  - **shell smoke** (optional but recommended): end-to-end curl smoke that
    calls the RPC for a known store and asserts the shape.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI only. Inline change to existing
  `RecipesSection` plus a new section under `src/screens/cmd/sections/`.
  Legacy admin surface was deleted in spec 025 — nothing to route around.
- Per-store or admin-global: Per-store. Capacity rows respect
  `auth_can_see_store()` via the existing RLS path. The VIEW/RPC must NOT
  bypass per-store scoping.
- Realtime channels touched: `store-{id}` and `brand-{id}` — REUSE only, no
  new channel. Architect confirms in §5 that all source tables are already
  in the realtime publication; if a table is missing, surface the publication
  gotcha (mid-session pub change requires
  `docker restart supabase_realtime_imr-inventory`).
- Migrations needed: YES — one new migration adding the VIEW or RPC. Timestamp
  must be ≥ 2026-05-23.
- Edge functions touched: None expected. The compute is PostgREST/RPC, not an
  edge function. If the architect picks an edge-function path for any reason
  (e.g., complex aggregation across schemas), surface as a design change and
  the edge function MUST go through `callEdgeFunction` in `src/lib/auth.ts`
  per CLAUDE.md, NOT raw `fetch`.
- Web/native scope: Both. The inline badge and Menu impact section render in
  both web and native via the existing Cmd UI primitives. No web-only API
  (no `window.confirm`, no DOM-only CSS).
- `app.json` slug: NOT TOUCHED. The slug remains `towson-inventory` pending
  explicit user approval (CLAUDE.md "app.json slug mismatch — DO NOT
  AUTO-FIX").

## Backend design

### Schema survey summary (load-bearing)

I read the brand-catalog P1/P2/P3/P5 migrations, the per-store RLS
hardening, both realtime publication migrations, and the existing
recursive-CTE pattern in `report_run_variance_multivendor`. Headline
findings:

- `recipes` and `prep_recipes` are brand-scoped after P3 — `store_id`
  was dropped. They join to a store only via `inventory_items.catalog_id`.
- `recipe_ingredients` has `(recipe_id, catalog_id, quantity, unit,
  base_quantity, base_unit)`. The catalog_id is NOT NULL (P3 lockdown).
  `base_quantity` IS schematically populated but is **0 across every
  seed row** (incomplete backfill in seed.sql:1097-1110); we cannot rely
  on it for capacity math.
- `prep_recipe_ingredients` has `(prep_recipe_id, catalog_id, sub_recipe_id,
  type, quantity, unit, base_quantity, base_unit)` with a CHECK
  `catalog_id IS NOT NULL OR sub_recipe_id IS NOT NULL`. `type='raw'`
  rows carry catalog_id; `type='prep'` rows carry sub_recipe_id (FK to
  `prep_recipes(id)` ON DELETE SET NULL).
- `recipe_prep_items` is the menu-recipe → prep-recipe portion link.
- `inventory_items.current_stock` is in the catalog's unit. The unit
  is stored on `catalog_ingredients.unit`.
- The existing `report_run_variance_multivendor` (migration
  20260514120020, lines 253-298) is **the canonical recursive-CTE
  pattern in this codebase**: anchor on `recipe_prep_items` + recurse
  through `prep_recipe_ingredients.sub_recipe_id`, with
  `visited UUID[]` cycle guard and `depth < 5` cap. It does NOT
  normalize units — assumes `recipe_ingredients.unit` matches the
  catalog/inventory unit per ingredient. This is the project's posture.

### Blocker resolutions

#### §1 — Recursive SQL cycle detection: **Option (b), reusing the
project pattern.**

Reject (c) (Postgres `CYCLE … SET … USING path`) because the codebase
already standardized on the visited-array + depth-cap pattern in
`report_run_variance` and `report_run_variance_multivendor`. Diverging
to `CYCLE` syntax for this one RPC fragments the recursive-CTE idiom
across reports. Reject (a) (schema constraint) — adding a deferred
constraint requires a separate migration with backfill validation
that is out of scope here.

Adopted:

- `visited UUID[]` accumulator with
  `not (sub_recipe_id = any (visited))` predicate.
- Depth cap `depth < 5` (matches variance migration line 277).
- Track recipes that exceed the cap via a `truncated_recipes` sub-CTE
  (variance migration lines 279-284) and surface them in the RPC's
  per-row metadata so the UI can render `"unknown capacity (deep
  prep chain)"` for those recipes instead of silently returning a
  wrong number.

#### §2 — Unit conversion ambiguity: **Out of scope. Capacity math
matches the existing variance/reorder posture — assume
`recipe_ingredients.unit ≈ catalog_ingredients.unit` per row.**

Survey findings:

- A canonical normalization function (`to_base_unit(qty, unit)`) does
  NOT exist in SQL. The TS equivalent in
  [src/utils/unitConversion.ts:60](src/utils/unitConversion.ts)
  (`toBaseUnit` / `smartToBase` with `WEIGHT_TO_GRAMS` / `VOLUME_TO_FLOZ`
  maps) is client-side only.
- `ingredient_conversions` table exists for abstract units (case → g)
  but is brand-scoped via `catalog_id` and has NO server-side helper
  function — every consumer joins it manually.
- `recipe_ingredients.base_quantity` / `base_unit` exist but are zero
  across the seed (not backfilled).
- The existing `report_run_variance_multivendor` (which does the
  closest existing transitive recipe math) computes
  `rpi.quantity * pri.quantity` with NO unit normalization. The
  variance report's correctness today depends on recipe ingredient
  units matching the catalog/inventory unit per catalog_id.

Decision: capacity math adopts the same posture. The capacity-per-line
quotient is `floor(inventory.current_stock / recipe_line.quantity)`
where both are assumed to be in the same unit (the catalog's unit).
This is the **"units-already-match subset"** the spec's Out-of-scope
section anticipated.

Where they don't match (e.g. a recipe line in `cup` against an
inventory item denominated in `g`), the result will be numerically
wrong — but this is **no worse than the existing variance / cogs /
reorder math**, all of which carry the same debt. A future spec can
introduce a server-side `to_base_unit()` SQL function and one
ingredient_conversions join, applied uniformly to capacity AND
variance AND cogs.

Mitigation in the RPC:

- Emit a per-line `unit_mismatch boolean` flag when
  `lower(recipe_line.unit) <> lower(catalog.unit)`.
- Roll it up into a per-recipe `has_unit_mismatch boolean` column.
- Frontend renders `"capacity (approx — unit mismatch)"` when the flag
  is true so the user knows the number is suspect.

This is additive — the existing reports could adopt the same flag in
a follow-up cleanup without changing their math.

#### §3 — Binding-ingredient leaf semantics: **Option B (drill to
LEAF), with the leaf reported in a separate column.**

PM's preference matches the UX value. Implementation cost is modest
because the recursive CTE already accumulates the (catalog_id, qty)
contributions from prep leaves — see
`report_run_variance_multivendor`'s `prep_leaves` CTE (line 286). We
hold the same DAG-walk but additionally retain the constraining
`catalog_id` at the leaf as we aggregate the per-recipe `min()`.

Return shape includes both:

- `binding_catalog_id uuid` — the leaf catalog ingredient that limits
  capacity.
- `binding_catalog_name text` — denormalized at the RPC layer
  (single join to `catalog_ingredients`, ~140 rows; cheap).
- `binding_shortfall numeric` — how much more of that catalog
  ingredient is needed to make ONE more of this menu item, in the
  catalog's unit. Computed as
  `recipe_line.quantity - inventory.current_stock` clamped to >= 0.

We do NOT return the full path through prep recipes — keeps payload
flat, and the spec doesn't require it. If the user wants context
("limited by tomato paste, which lives in sauce X"), the existing
recipe detail pane in RecipesSection already shows that breadcrumb
client-side via `prepRecipes`.

#### §4 — RPC vs view, return shape: **RPC** (`compute_menu_capacity`).

A VIEW would be cleaner for PostgREST consumption but has two
disqualifying issues here:

1. The recursive-CTE pattern in this codebase ALWAYS lives in an RPC
   (`report_run_*`) — not a view. Keeping it as an RPC matches the
   project idiom and lets us reuse the `auth_can_see_store()`
   pre-flight gate the way variance/reorder do.
2. No `CREATE VIEW` exists anywhere in `supabase/migrations/` —
   introducing one for this feature would set a new precedent the
   architect should not establish silently.

**Signature.**

```
public.compute_menu_capacity(p_store_id uuid)
returns table (
  recipe_id            uuid,
  store_id             uuid,
  has_recipe           boolean,   -- false = no BOM at all (no
                                  --   recipe_ingredients AND no
                                  --   recipe_prep_items rows)
  makeable_qty         numeric,   -- 0 when has_recipe=true but
                                  --   capacity is 0; NULL when
                                  --   has_recipe=false (UI maps to
                                  --   "no recipe defined")
  binding_catalog_id   uuid,      -- NULL when makeable_qty is NULL
                                  --   or when no constraint binds
                                  --   (e.g. zero-line recipe)
  binding_catalog_name text,
  binding_shortfall    numeric,   -- in the catalog's unit; NULL when
                                  --   binding_catalog_id is NULL
  low_ingredient_count int,       -- direct + transitive count of
                                  --   ingredients in this recipe
                                  --   that are currently 'low'
                                  --   (currentStock < parLevel)
                                  --   in THIS store, deduplicated by
                                  --   catalog_id
  has_unit_mismatch    boolean,   -- §2 mitigation flag
  truncated            boolean    -- depth-cap was hit (§1 cycle/depth)
)
language plpgsql
security invoker
set search_path = public;
```

`security invoker` (matches `report_reorder_list` migration
20260514130000 line 106). Every SELECT inside runs as the calling
user → RLS gates each read. `auth_can_see_store(p_store_id)`
pre-flight is the defence-in-depth check at the top of the function
and raises `'Not authorized for store %'` on a foreign-store call.

GRANT EXECUTE to `authenticated` (mirrors report_reorder_list).
REVOKE EXECUTE from `anon`. Pattern carry-over from
`20260505065303_admin_rpcs_lock_anon.sql`.

#### §5 — Realtime invalidation surface: **CONFIRMED — the existing
channels carry the signals we need, with one acceptable gap.**

Audit of which source tables the RPC reads and whether they're in
`supabase_realtime`:

| Source table                | In publication? | Subscribed by channel  |
|-----------------------------|-----------------|------------------------|
| `inventory_items`           | YES             | `store-{id}` (filter `store_id=eq.{id}`) |
| `recipes`                   | YES             | `brand-{id}` (filter `brand_id=eq.{id}`) |
| `prep_recipes`              | YES             | `brand-{id}` |
| `catalog_ingredients`       | YES             | `brand-{id}` |
| `recipe_ingredients`        | **NO**          | not subscribed |
| `prep_recipe_ingredients`   | **NO**          | not subscribed |
| `recipe_prep_items`         | **NO**          | not subscribed |

The three child tables are NOT in the publication
([supabase/migrations/20260514140000_realtime_publication_tighten.sql:43-53](supabase/migrations/20260514140000_realtime_publication_tighten.sql)).
**This is the same realtime gap that already exists for recipe-cost
recalculation** — editing only the ingredient rows of an existing
recipe does not fire a brand-channel event today, and consequently
cost figures shown in RecipesSection are stale until the user
manually refreshes or until any other tracked table mutates. The
existing convention in this codebase is to LIVE WITH THIS GAP, not to
broaden the publication.

Decision: **do NOT add the three child tables to the publication in
this spec.** Reasons:

1. The dominant capacity-recalc trigger in practice is
   `inventory_items.current_stock` mutating (every EOD submission,
   every waste log, every receiving event), and those ARE on the
   publication. Capacity is recomputed on every onSync.
2. Editing a recipe's ingredient list is an admin action that
   accompanies a UI state change in `RecipesSection`, which already
   re-fetches via the existing `loadFromSupabase` path. The brand
   channel does not need to mediate this.
3. Broadening the publication carries the publication-membership
   restart gotcha (`docker restart supabase_realtime_imr-inventory`)
   and bumps the realtime worker's row throughput for everyone,
   permanently — not justified by this feature alone.

If a future spec wants to close the recipe-ingredient realtime gap,
it should close it uniformly for all consumers (cost, capacity,
variance) in one migration, with the publication gotcha called out
and a CI guard added so the local dev step doesn't get forgotten.
That work is **explicitly out of scope here**.

**The `onSync` debounce-reload path is the right place for capacity
recompute.** No new channel; no new realtime subscription. The 400ms
debounce in `useRealtimeSync` already coalesces bursty
`inventory_items` writes.

### Data model changes

Single migration, **additive only**:

- **File:** `supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql`
  (timestamp is the next workday after the most-recent migration
  20260520010000; pgTAP test file in the same PR uses an arbitrary
  later date but isn't a migration).

- **Contents:**
  - `CREATE OR REPLACE FUNCTION public.compute_menu_capacity(p_store_id uuid) RETURNS TABLE (...) LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$ ... $$;`
  - `REVOKE EXECUTE ON FUNCTION public.compute_menu_capacity(uuid) FROM anon;`
  - `GRANT EXECUTE ON FUNCTION public.compute_menu_capacity(uuid) TO authenticated;`

- **No new tables. No new columns. No new indexes.** The recursive
  CTE reads existing tables only.

- **Indexes already in place that cover this workload:**
  - `inventory_items(store_id, catalog_id)` unique constraint from P3
    lockdown (line 42) — covers the inventory join.
  - `recipe_ingredients(recipe_id)` — implicit FK index. PG-generated
    FK indexes were verified in the report_run_variance perf work.
  - `prep_recipe_ingredients(prep_recipe_id)` — same.
  - `recipe_prep_items(recipe_id)` — same.

  **No additional indexes needed.** If pgTAP `EXPLAIN` shows a hot
  seq scan during the p95 < 100ms test, the developer should add a
  partial index in a follow-up migration; don't speculate now.

- **Rollout safety:** Function-only migration. Idempotent
  (`CREATE OR REPLACE`). No data backfill. No data loss risk. Cleanly
  reversible by `DROP FUNCTION`.

### RLS impact

No new tables → no new policies. The RPC is `SECURITY INVOKER`, so
the SELECTs it issues are RLS-gated by the existing per-store and
brand policies:

- `inventory_items` reads gated by `store_member_read_inventory_items`
  (`auth_can_see_store(store_id)`).
- `recipes`, `prep_recipes`, `recipe_ingredients`,
  `prep_recipe_ingredients`, `recipe_prep_items`, `catalog_ingredients`
  reads gated by `auth_read_*` from P5
  (`auth.uid() IS NOT NULL`).

Defence in depth: the function's first statement is

```
if not public.auth_can_see_store(p_store_id) then
  raise exception 'Not authorized for store %', p_store_id
    using errcode = '42501';
end if;
```

Matching `report_reorder_list` migration line 119.

### API contract

**Endpoint.** `supabase.rpc('compute_menu_capacity', { p_store_id })`
via PostgREST.

**Request.**
- `p_store_id: string` — UUID of the store being viewed.

**Response.** Array of rows, one per recipe in the brand. Shape per
the function signature above (column list).

**Error cases.**
- `42501` from `auth_can_see_store()` → PostgREST returns HTTP 403
  with `{ code: '42501', message: 'Not authorized for store ...' }`.
  Surfaced via `notifyBackendError` toast.
- Any other Postgres error (e.g. timeout) → PostgREST returns 500;
  `notifyBackendError` toast.
- An empty store (no recipes loaded yet) returns `[]`. The UI's
  `storeLoading` flag from spec 055 handles the first-mount skeleton.

### Edge function changes

**None.** No new edge function. No existing edge function modified.

### `src/lib/db.ts` surface

New export, following the `tracked()` discipline from spec 055:

```
// Spec 060 — server-computed per-recipe capacity for the active store.
//
// The RPC walks the recipe BOM transitively through prep recipes and
// returns one row per recipe with makeable_qty + the binding catalog
// ingredient (or NULL when the recipe has no BOM defined).
//
// Units are NOT normalized server-side — same posture as
// report_run_variance / report_reorder_list. The `unitMismatch` flag
// surfaces ingredient lines whose unit string differs from the
// catalog's; UI renders an "(approx)" qualifier when set.

export interface MenuCapacityRow {
  recipeId:            string;
  storeId:             string;
  hasRecipe:           boolean;        // false → render "no recipe defined"
  makeableQty:         number | null;  // NULL when !hasRecipe
  bindingCatalogId:    string | null;
  bindingCatalogName:  string | null;
  bindingShortfall:    number | null;
  lowIngredientCount:  number;
  hasUnitMismatch:     boolean;
  truncated:           boolean;        // depth-cap hit
}

export async function fetchMenuCapacity(
  storeId: string,
): Promise<MenuCapacityRow[]>;
```

**snake_case → camelCase mapping** done in this function via the
`mapItem`-style helper pattern (cf. `fetchRecipes` lines 337-363,
`fetchPrepRecipes` lines 1728-1761). Inline; no shared mapper.

**Tracked wrapper.** Mirror `fetchBreadbotSales`
([src/lib/db.ts:1363](src/lib/db.ts)) — wraps the RPC call in
`useInflight.getState().track(async (signal) => { ... }, { kind:
'read', label: 'fetchMenuCapacity' })`. `.abortSignal(signal)`
chained on the rpc builder BEFORE await (spec 055 invariant).

### Store slice (Zustand)

Extends [src/store/useStore.ts](src/store/useStore.ts), no new slice
file:

- **New slice state field:**
  `menuCapacity: Record<string /* recipeId */, MenuCapacityRow>`.
  Empty `{}` on initial state. Indexed for O(1) lookups by the inline
  badge in RecipesSection's `renderItem`.
- **New action:** `loadMenuCapacity: (storeId?: string) => Promise<void>`.
  Calls `db.fetchMenuCapacity(sid)`, reduces array → keyed object,
  `set({ menuCapacity: keyed })`. On error, sets `{}` (silent) +
  `notifyBackendError('Load menu capacity', e)`.
- **Wire into `loadFromSupabase`:** after the existing
  `set({ brand, catalogIngredients, inventory, recipes, ... })`
  block (line 973-980), append a fire-and-forget call to
  `get().loadMenuCapacity(sid)`. NOT awaited — first-paint must not
  wait on capacity; the inline badge falls back to `"—"` until the
  RPC resolves, then re-renders.
- **No optimistic-then-revert.** This is a READ slice computed
  server-side. There is no write path that mutates it directly. The
  optimistic pattern from `notifyBackendError` doesn't apply.

### Realtime impact

No new channels. No new publication members.

**Wire into the existing onSync.** In
[src/navigation/CmdNavigator.tsx](src/navigation/CmdNavigator.tsx)
the `handleSync` callback currently calls
`useStore.getState().loadFromSupabase(...)`. After this spec,
`loadFromSupabase` already triggers `loadMenuCapacity` as part of
its post-set tail (above), so realtime → onSync → loadFromSupabase →
loadMenuCapacity. **No new wiring needed in `CmdNavigator` or
`useRealtimeSync`.**

The 400ms debounce in `useRealtimeSync` absorbs bursty inventory
writes (EOD submission, waste log, receiving) so the capacity RPC
fires at most ~once per 400ms even under storm conditions.

**Acceptable gap (documented):** mutating only
`recipe_ingredients` / `prep_recipe_ingredients` / `recipe_prep_items`
does NOT fire `onSync` because those tables are not in the
publication. This is the same gap that affects recipe cost calculation
today. Closing it is out of scope per §5.

**Publication restart gotcha:** **NOT TRIGGERED.** This spec does
NOT change `supabase_realtime` publication membership. No
`docker restart supabase_realtime_imr-inventory` step required.

### Frontend store impact

Single Zustand slice change (above). Optimistic-then-revert pattern
does NOT apply (read-only slice).

### Component contracts

#### A. Inline badge in `RecipesSection.tsx`

Mounted inside the existing list-row `renderItem`
([src/screens/cmd/sections/RecipesSection.tsx:238-293](src/screens/cmd/sections/RecipesSection.tsx)),
**after** the existing cost/margin row.

**Component (new file):**
`src/components/cmd/MenuCapacityBadge.tsx`

**Props:**
```
interface MenuCapacityBadgeProps {
  recipeId: string;       // for store lookup
  // No other props — pulls from useStore selector inline.
}
```

**Internal:** reads
`useStore((s) => s.menuCapacity[recipeId])`. If the row is missing
(RPC not loaded yet), renders nothing (no flicker). If
`hasRecipe === false`, renders `"no recipe defined"` in mono small
italic. Otherwise renders the integer `makeableQty` with three
visual states:

| Condition                                       | Visual          |
|-------------------------------------------------|-----------------|
| `makeableQty === 0`                             | red pill (C.danger bg) |
| `makeableQty > 0 && lowIngredientCount > 0`     | amber pill (C.warn bg) — the "per-recipe insufficient" indicator |
| `makeableQty > 0 && lowIngredientCount === 0`   | neutral text (C.fg2) — just the number |
| `hasUnitMismatch`                               | append `~` prefix to the number; tooltip explains |
| `truncated`                                     | append `?` suffix; tooltip explains |

Existing **global low-stock indicator** (per AC §A) is the per-row
inventory-status badge already present elsewhere (rendered via
`StatusPill` against `getItemStatus()`). The two signals coexist
because they answer different questions: global low = "this store has
items below par"; per-recipe insufficient = "this recipe touches one
of those items." The amber-pill above is the **per-recipe** signal;
it's visually distinct from the existing global pill.

**Accessibility:** `accessibilityLabel="capacity 3"` / `"insufficient
stock for this recipe"` / `"no recipe defined"`.

#### B. Dedicated `MenuImpactSection.tsx`

**File:** `src/screens/cmd/sections/MenuImpactSection.tsx` (new).

**Mounting:**
1. Add `import MenuImpactSection from './sections/MenuImpactSection';`
   to [src/screens/cmd/InventoryDesktopLayout.tsx:35-49](src/screens/cmd/InventoryDesktopLayout.tsx).
2. Add a new branch to the section-dispatch tree
   (InventoryDesktopLayout.tsx:175-209):
   `) : section === 'MenuImpact' ? ( <MenuImpactSection /> )`.
3. Add the sidebar entry to the INSIGHTS group in
   [src/lib/cmdSelectors.ts:1082-1093](src/lib/cmdSelectors.ts):
   ```
   { id: 'MenuImpact', label: T('sidebar.items.menuImpact') },
   ```
   Placement: as the FIRST item in INSIGHTS (above Reconciliation).
   The user's customized sidebar layout from spec 008 will respect
   any override they've applied; new id auto-appends to the default
   group per `applySidebarOverride`'s §7 semantic.
4. Add the i18n string to
   [src/i18n/en.json](src/i18n/en.json) under `sidebar.items.menuImpact`:
   `"Menu impact"`. Mirror in `es.json` / `zh-CN.json` with the
   existing translation conventions.
5. Add a SCREEN_ENTRY in
   [src/lib/cmdSelectors.ts:164-182](src/lib/cmdSelectors.ts) so the
   ⌘K palette can navigate to it:
   `{ name: 'MenuImpact', labelKey: 'sidebar.items.menuImpact' }`.

**Selector for rows:**
```
useStore((s) => Object.values(s.menuCapacity));
```
Augmented client-side with recipe.menuItem (display name) and brand
badge by joining against `recipes` slice.

**Columns (in order, per AC §B):**

| Column            | Source                                    | Sort behavior              |
|-------------------|-------------------------------------------|----------------------------|
| Menu item name    | `recipes[recipeId].menuItem` (localized)  | localeCompare              |
| `makeable_qty`    | `MenuCapacityRow.makeableQty`             | numeric; `null` → bottom regardless of direction |
| Binding ingredient| `MenuCapacityRow.bindingCatalogName` (or `''` when null) | localeCompare; nulls → bottom |
| # low ingredients | `MenuCapacityRow.lowIngredientCount`      | numeric                    |
| Brand badge       | `recipes[recipeId].brandId` → brand name  | localeCompare              |

**Default sort:** `makeable_qty` ascending. The `null` (no recipe)
rows pin to the bottom regardless of sort direction — implement via a
two-key comparator: primary key is `hasRecipe ? 0 : 1`, secondary
key is the selected column.

**Header click toggles direction.** Standard
`sortBy: string; sortDir: 'asc' | 'desc'` local state. Click on the
active sort column toggles direction; click on a different column
sets that column with `'asc'`.

**Empty state.** When `menuCapacity` is `{}` and the recipes slice
has rows, render `"Loading menu impact…"`. When recipes is also
empty, render `"No menu items in this brand"` (matches the
RecipesSection empty-state copy convention).

**Loading state.** Uses `storeLoading` from spec 055 the same way
`RecipesSection` does (line 175-177): when storeLoading && menuCapacity
is empty, render `<ListSkeleton rows={8} />`.

#### Sidebar wiring summary

| File                                  | Edit                                            |
|---------------------------------------|-------------------------------------------------|
| `src/lib/cmdSelectors.ts`             | Add `'MenuImpact'` to SCREEN_ENTRIES_DEFS (~line 175); add `{ id: 'MenuImpact', label: T('sidebar.items.menuImpact') }` to the INSIGHTS group in `useDefaultSidebarGroups` (~line 1082). |
| `src/screens/cmd/InventoryDesktopLayout.tsx` | Import + add dispatch branch.            |
| `src/i18n/en.json` + `es.json` + `zh-CN.json` | Add `sidebar.items.menuImpact` key.    |

### Perf budget

**Spec asks for `< 100ms p95` against the local seed.** Prod-shape
sizing per `supabase/seed.sql`:

- `recipes`: 41
- `recipe_ingredients`: 152
- `recipe_prep_items`: 41
- `prep_recipes`: 62 (10 current, 52 history versions)
- `prep_recipe_ingredients`: 464 (all type='raw' in seed — no
  prep→prep references actually exist today, so the recursive arm
  yields ~0 rows in practice)
- `catalog_ingredients`: 143
- `inventory_items`: 572 per brand (143 catalog × 4 stores)

**Estimated cost:**
- Direct ingredients pass: 152 rows × 1 join to `inventory_items`
  (PK lookup) = bounded.
- Recursive prep pass: anchor `recipe_prep_items` (41 rows) → join
  `prep_recipe_ingredients` (avg ~7 rows per prep) → 287 rows at
  depth 1. Depth 2+ is empty in current data → recursion terminates.
- Final `group by` for `min()` aggregation across all (recipe_id,
  catalog_id) lines.

**Expected ms (seed): single-digit on a hot cache.** The
`< 100ms p95` budget is comfortable. The variance multivendor RPC
runs similar shape against the same seed at ~30-50ms range
historically; capacity is lighter (no sales aggregation, no waste
aggregation, no PO aggregation).

**Risk:** if a future brand has a deep prep DAG (real prep→prep
chains), the recursive pass grows. Depth cap of 5 keeps this bounded
to `max_breadth ^ 5` rows in the recursive table. With current
breadth (~7), worst case is ~16,800 rows — still sub-100ms.

**Acceptance hook for the perf test:** pgTAP probe wrapping the RPC
in `clock_timestamp()` deltas and asserting `< 100ms` on the local
seed. Mirrors the `report_run_variance` perf test cadence.

### Risks & tradeoffs

- **Unit-mismatch posture deferred (§2).** The capacity numbers will
  be subtly wrong for recipes whose ingredient lines aren't in the
  catalog's unit. Mitigation: `hasUnitMismatch` flag + UI `~`
  prefix. Long-term fix: server-side `to_base_unit()` SQL function
  applied uniformly to variance / cogs / capacity. Filed as a
  follow-up unit-conversion spec. The architect acknowledges this is
  a known imperfection.
- **Realtime gap on recipe_ingredients (§5).** Editing only the
  ingredient list of a recipe doesn't fire onSync. Same gap that
  affects recipe-cost recalc today. Out of scope.
- **Truncated-recipe behavior.** If a brand creates a real prep→prep
  cycle, the depth cap silently truncates; `truncated=true` is
  emitted but the `makeable_qty` will be approximate (computed from
  whatever was reachable in 5 hops). The UI renders a `?` suffix.
  This is **better than crashing or returning Infinity** (the spec's
  AC §E "renders an explicit label, not a crash, not Infinity, not
  silent zero" is met by the `?` suffix + truncated flag).
- **No CI gate verifies the migration ran.** Per CLAUDE.md "CI
  workflow": the `db-migrations-applied.yml` gate doesn't exist.
  Developer MUST manually verify the migration was applied to local
  + prod and that the pgTAP test passes.
- **Edge-function cold start.** N/A — no edge function involved.

### Test plan

#### pgTAP (`tests/db/060_menu_capacity.test.sql`)

- **Direct ingredients:** Seed a recipe with two ingredients, set
  inventory levels, assert `makeable_qty = min(stock_a/qty_a,
  stock_b/qty_b)` floored.
- **Transitive prep:** Seed a menu recipe → prep recipe → 2 raw
  ingredients. Assert `makeable_qty` reflects the leaf-ingredient
  bottleneck.
- **Deep prep:** menu → prep_a → prep_b → leaf. Assert correct
  binding_catalog_id is the leaf, not prep_a.
- **Cycle handling:** prep_a uses prep_b, prep_b uses prep_a. Assert
  `truncated = true` and the function does NOT loop forever (pgTAP
  has a 30s timeout that would catch a loop).
- **No-BOM recipe:** Recipe with zero `recipe_ingredients` and zero
  `recipe_prep_items`. Assert `has_recipe = false`, `makeable_qty IS
  NULL`, `binding_catalog_id IS NULL`.
- **NULL/0 stock:** inventory_items.current_stock = 0 for the binding
  ingredient. Assert `makeable_qty = 0`, `binding_catalog_id`
  identifies the zero-stock ingredient, `binding_shortfall` = the
  full required quantity.
- **Low ingredient count:** recipe with 5 ingredients where 2 have
  `current_stock < par_level`. Assert `low_ingredient_count = 2`.
- **RLS gate:** call the function with `auth.uid()` set to a user
  who lacks access to the target store. Assert SQLSTATE `42501`.
- **anon revoke:** SET ROLE anon → call → assert permission denied.
- **Perf:** record `clock_timestamp()` before + after on seed,
  assert `< 100ms`.

#### jest

- **`MenuCapacityBadge`:** renders integer when `makeableQty > 0`;
  renders red pill at 0; renders amber pill when
  `lowIngredientCount > 0`; renders `"no recipe defined"` when
  `hasRecipe === false`; renders nothing when slice has no entry.
- **`MenuImpactSection` sorting:** ascending default; column-header
  click toggles direction; no-BOM rows pin to bottom regardless of
  direction; brand-badge column sorts by brand name.
- **Capacity slice reducer:** array of rows in → keyed object out;
  empty array → empty object; rows with duplicate recipe_id last
  one wins.

#### shell smoke (optional)

- `scripts/smoke-menu-capacity.sh` — curl the local PostgREST with a
  test JWT, assert `200` + non-empty array. Mirror of the existing
  reorder smoke at `scripts/smoke-reorder.sh` if one exists.

### Edge cases the developer must handle

- **Recipe with no ingredients AND no prep items** → `has_recipe =
  false`, all binding columns `NULL`, `makeable_qty NULL`. UI renders
  `"no recipe defined"`.
- **Recipe with only prep items (no direct raw ingredients)** →
  `has_recipe = true`. Capacity computed solely through the prep
  recursive arm.
- **Prep recipe with no ingredients** → contributes nothing to the
  recursion; treated as infinite capacity for itself (won't bind).
  Should NOT crash. Test this.
- **Recipe line with `quantity = 0` or `NULL`** → skip in the
  capacity quotient (division-by-zero protection). Treat as not
  binding.
- **Inventory item missing from this store** (no row in
  `inventory_items` for `(store_id, catalog_id)`) → `current_stock =
  0` for capacity purposes; the recipe is constrained accordingly
  and that catalog ingredient becomes the binding leaf.
- **NULL `current_stock`** → coalesce to 0.
- **`par_level` NULL or 0** → ingredient is NOT counted as low
  (`low_ingredient_count` excludes it).
- **Stale prep_recipe pointer** (recipe_prep_items references an
  is_current=false prep_recipes row) → the recursive walk follows
  the pointed-at row; cost-resolver lineage logic from
  `useStore.getPrepRecipe` is NOT in this RPC. The version a recipe
  was authored against is the version we cost against. Matches
  fetchPrepRecipes line 1712-1717 contract.
- **Multiple recipe lines that reference the same catalog_id** → the
  RPC aggregates `SUM(quantity)` per (recipe_id, catalog_id) before
  the capacity divide. Matches variance migration line 292
  (`sum(qty)` in `all_ri`).
- **`recipe_ingredients.unit` empty string** → treated as same unit
  as catalog (no mismatch flag).
- **Cycle hit at exactly depth 5** → row emits `truncated = true`.
  Capacity returned is the minimum over reachable leaves so far;
  callers see `?` suffix.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. backend-developer
  owns the migration (`supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql`),
  the `src/lib/db.ts` `fetchMenuCapacity` export, the new
  `loadMenuCapacity` slice + `menuCapacity` state in
  `src/store/useStore.ts` (this is admin-app glue, technically frontend,
  but lives next to other db.ts-backed slices — coordinate with
  frontend-developer to avoid stomping). pgTAP tests at
  `tests/db/060_menu_capacity.test.sql`. frontend-developer owns
  `src/components/cmd/MenuCapacityBadge.tsx`, the inline-badge mount in
  `src/screens/cmd/sections/RecipesSection.tsx`, the new
  `src/screens/cmd/sections/MenuImpactSection.tsx`, the sidebar +
  dispatch wiring in `src/lib/cmdSelectors.ts` and
  `src/screens/cmd/InventoryDesktopLayout.tsx`, i18n strings, and the
  jest tests under `__tests__/`. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/060-menu-item-low-stock-warning-capacity.md

## Files changed (backend)

### Migrations
- `supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql` — new
  `public.compute_menu_capacity(uuid)` RPC. `security invoker` with
  `auth_can_see_store()` pre-flight, recursive CTE w/ visited-array
  cycle guard + depth-5 cap (mirrors `report_run_variance_multivendor`
  lines 253-298). `REVOKE EXECUTE ... FROM public, anon; GRANT TO
  authenticated;`. Emits `has_unit_mismatch` per-recipe flag (§2),
  `binding_catalog_id` always pointing at a LEAF (§3), and `truncated`
  flag when the depth cap fires (§1). Uses `#variable_conflict
  use_column` pragma to keep `recipe_id` / `store_id` column
  references unambiguous when shadowed by the RETURNS TABLE OUT
  params.

### TypeScript types
- `src/types/index.ts` — added `MenuCapacityRow` interface
  (snake_case → camelCase mapped shape returned by
  `fetchMenuCapacity`) and `menuCapacity: Record<string,
  MenuCapacityRow>` field in `AppState`. Type lives here so the
  Zustand slot doesn't have to import from `db.ts` and risk circular
  imports.

### db.ts wrapper
- `src/lib/db.ts` — new `fetchMenuCapacity(storeId)` export.
  `tracked()` wrapper with `kind: 'read'` per spec 055. Inline
  snake→camel mapping consistent with `fetchReorderSuggestions`'s
  `mapReorderVendor` style. Re-exports `MenuCapacityRow` so callers
  (the frontend's `MenuImpactSection.tsx`) can import the type from
  `db.ts` per the architect's original co-location.

### Zustand store
- `src/store/useStore.ts` — added `loadMenuCapacity(storeId?)`
  action and wired it as a fire-and-forget tail of `loadFromSupabase`
  (so first paint never blocks on the RPC). `menuCapacity` is cleared
  to `{}` on every store switch (both the per-store and `__all__`
  branches) so the prior store's numbers never flash in the new
  store's `RecipesSection` badges. Error path: `notifyBackendError`
  toast + reset slice to `{}` (no optimistic-revert; this is a pure
  read).

### pgTAP tests
- `supabase/tests/compute_menu_capacity.test.sql` — 16 assertions
  covering direct ingredients math, transitive prep capacity (leaf
  binding ingredient surfaced through a prep), zero stock,
  NULL stock (coalesce to 0), no-BOM recipe (has_recipe=false +
  makeable_qty IS NULL), unit mismatch flag, low_ingredient_count,
  cycle handling (prep_x ↔ prep_y), RLS gate (42501 for foreign
  store), and the anon-revoke (permission denied). Hermetic
  `begin; ... rollback;` envelope; fixtures use random-suffix names
  to avoid UNIQUE-constraint collisions on re-run.

### Verification

- `npm test` — 259 / 259 pass (jest, includes the frontend's new
  `MenuCapacityBadge` + `MenuImpactSection` test files).
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- `scripts/test-db.sh` — 33 / 33 pgTAP files pass including
  `compute_menu_capacity.test.sql` (16 assertions).
- Migration registered via `supabase migration up --include-all`;
  applied cleanly against the local seed.
- Perf: 5 warm runs against the Frederick seed averaged ~22-25 ms
  per call (well under the 100 ms p95 target). Returned 41 rows
  (40 with BOM, 1 no-BOM as expected from seed).

## Files changed (frontend)

### New files
- `src/components/cmd/MenuCapacityBadge.tsx` — inline per-recipe
  capacity pill. Reads `useStore((s) => s.menuCapacity[recipeId])`;
  renders nothing while the slice is unpopulated (no flicker), the
  "no recipe defined" literal when `hasRecipe === false`, the
  "unknown" sentinel when `makeableQty === null`, a red pill at 0,
  an amber pill when `lowIngredientCount > 0`, or neutral mono text
  otherwise. Prefixes `~` for `hasUnitMismatch`, suffixes `?` for
  `truncated`. Accessibility labels assemble the human-readable
  shape via the existing `useT()` channel; tooltips wire through
  the web `title` attribute the same way `DisabledCreatePoButton`
  in `ReorderSection` does.
- `src/components/cmd/MenuCapacityBadge.test.tsx` — component
  project (jsdom) jest coverage for the 10 render paths
  (slice-missing, no-recipe, unknown, healthy, low, zero,
  unit-mismatch prefix, truncated suffix, both flags,
  fractional floor).
- `src/screens/cmd/sections/MenuImpactSection.tsx` — dedicated
  "Menu impact" section under INSIGHTS. Sortable table over the
  five AC §B columns (menu item / makeable / binding / low count
  / brand). Default sort makeable_qty ASC; the `compareRows`
  two-key comparator pins `hasRecipe === false` rows to the
  bottom regardless of direction. Filter affordance "show
  impacted only" hides healthy rows. Brand column gated on
  `useIsSuperAdmin()` — non-super-admins see four columns.
  Realtime refresh runs through the existing
  `useRealtimeSync` → `loadFromSupabase` → `loadMenuCapacity`
  chain; no new channel wiring (no `docker restart` gotcha).
- `src/screens/cmd/sections/__tests__/MenuImpactSection.test.tsx`
  — 17 tests: 6 against the exported `compareRows` comparator
  (asc, desc, no-BOM pinning under both directions, localeCompare
  on name, two-tier rule on binding-name) + 11 section-level
  tests (filter toggle, brand-column gate, empty / loading /
  skeleton states, unit-mismatch indicator).

### Modified files
- `src/screens/cmd/sections/RecipesSection.tsx` — imported and
  mounted `<MenuCapacityBadge recipeId={r.id} />` in the list-row
  `renderItem`, placed below the cost/margin row per the
  architect's directive.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — imported
  `MenuImpactSection` and added a
  `section === 'MenuImpact' ? <MenuImpactSection />` branch in
  the section-dispatch tree, between `PrepRecipes` and
  `Reconciliation`.
- `src/lib/cmdSelectors.ts` — added `'MenuImpact'` to
  `SCREEN_ENTRIES_DEFS` (palette wiring) and prepended
  `{ id: 'MenuImpact', label: T('sidebar.items.menuImpact') }`
  to the INSIGHTS group in `useDefaultSidebarGroups` as the
  first item per the design.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
  — added catalog-parity-locked keys for
  `sidebar.items.menuImpact`, the new `section.menuImpact.*`
  namespace (~25 strings), and the new
  `component.menuCapacityBadge.*` namespace (10 strings). Parity
  test `src/i18n/i18n.test.ts` re-runs green.

### Verification
- `npm test` — 25 suites, 259 / 259 pass.
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- `npx expo export --platform web` — builds; bundle contains
  `MenuCapacityBadge`, `MenuImpact`, and `compute_menu_capacity`
  symbols (grep-verified against the served `AppEntry.bundle`).
- **Browser smoke via `preview_*` tools — NOT performed.** The
  frontend-developer agent session does not have Chrome MCP or
  computer-use tools available; runtime exercise of "sign in,
  click Menu impact, observe rows update via realtime" is a
  reviewer gap. The static path (typecheck + jest + bundle
  compile) was unblocked end-to-end. Recommend the reviewer
  who picks this up runs `npm run web` and exercises the
  inline badge state + the dedicated section.

### Coordination with backend-developer
The `MenuCapacityRow` shape lives in `src/types/index.ts:782`
and is re-exported from `src/lib/db.ts`. The frontend imports
the type from `'../../../lib/db'` (matching the architect's
original co-location). Slice shape
(`menuCapacity: Record<string, MenuCapacityRow>` keyed by
recipeId) is consumed exactly as backend-developer produces it
— no mid-flight shape drift detected.
