# Spec 060 — Backend Architect Drift Review

**Verdict:** No Critical drift. One ⚠️ deviation that retroactively
contradicts a sentence in my own design narrative (truncated-on-cycle
intent), four ⚠️ justified deviations or callouts the developer surfaced,
and the rest ✅ matches design. Recommendation: SHIP_READY from this
reviewer.

The implementation faithfully mirrors the
`report_run_variance_multivendor` pattern I cited as the canonical
recursive-CTE idiom; deviations from my written design are all in service
of matching that inherited pattern. Where the pattern has a quirk
(cycle vs. depth-cap distinction), the developer made the right call to
inherit the quirk rather than invent a new mechanism for this RPC.

---

## ✅ Matches design

### Migration shape (`supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql`)

- ✅ **Filename + timestamp** match the design (`20260524000000_compute_menu_capacity_rpc.sql`).
- ✅ **Signature** byte-for-byte matches the table-shape I specified
  (10 OUT columns, types, order).
- ✅ **`security invoker` + `set search_path = public`** present
  ([migration:82-83](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
- ✅ **`auth_can_see_store()` pre-flight** is the first statement after
  the pragma, raises `42501`
  ([migration:94-97](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
  Matches `report_reorder_list` line 119 as designed.
- ✅ **Recursive CTE structure** (`direct_ri` + `recursive_prep` +
  `truncated_recipes` + `prep_leaves` + `all_ri` + per-recipe rollups)
  follows the variance idiom I cited.
- ✅ **Cycle guard** = `visited UUID[]` + `not (sub_recipe_id = any
  (visited))` + `depth < 5`. Verbatim mirror of variance:265-277.
- ✅ **Binding-leaf semantics** — `distinct on (recipe_id) ... order by
  recipe_id, line_capacity asc, catalog_id asc`
  ([migration:240-248](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
  Leaf catalog_id is preserved across the prep DAG walk per my §3
  resolution. Tie-break on catalog_id asc gives deterministic ordering
  (good defensive call not explicitly required by design).
- ✅ **GRANT/REVOKE** matches: `revoke ... from public, anon` + `grant
  ... to authenticated`. The `from public` part is a defensive add
  (PUBLIC inheritance) which is correct project hygiene; design said
  "REVOKE from anon" but developer's explicit `from public` is the
  load-bearing form.
- ✅ **`makeable_qty IS NULL` when no constraint binds** for both
  no-BOM and zero-leaf-prep cases
  ([migration:298, 290-297 comments](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)) —
  matches my §C signature comment "0 when has_recipe=true but capacity
  is 0; NULL when has_recipe=false".
- ✅ **Brand-scoped `all_recipes` CTE** correctly resolves brand via
  `stores.id = p_store_id` lookup — guards against cross-brand leak
  even if RLS broadens later
  ([migration:264-272](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
  Nice defensive belt-and-suspenders not in my spec.

### `src/lib/db.ts` wrapper

- ✅ **`fetchMenuCapacity(storeId)`** signature exactly matches design.
- ✅ **`tracked()` wrapper** with `kind: 'read'` + `label:
  'fetchMenuCapacity'`
  ([db.ts:2763](src/lib/db.ts)) — matches spec 055 invariant.
- ✅ **`.abortSignal(signal)` chained BEFORE await**
  ([db.ts:2747](src/lib/db.ts)).
- ✅ **Inline snake_case → camelCase mapping**
  ([db.ts:2751-2762](src/lib/db.ts)) — pattern matches
  `fetchReorderSuggestions` / `fetchRecipes` as I directed.
- ✅ **Defensive coalesces** on every nullable column (`?? null`, `??
  0`, `?? false`). Beyond spec but consistent with the codebase posture.

### Zustand slice (`src/store/useStore.ts`)

- ✅ **`menuCapacity: Record<string, MenuCapacityRow>`** state shape
  ([useStore.ts:549](src/store/useStore.ts)).
- ✅ **`loadMenuCapacity(storeId?)`** action signature
  ([useStore.ts:455, 2390](src/store/useStore.ts)).
- ✅ **Wired into `loadFromSupabase`** as fire-and-forget tail
  ([useStore.ts:1049](src/store/useStore.ts)) — `get().loadMenuCapacity(sid)`
  NOT awaited, exactly as designed.
- ✅ **Cleared on store switch** ([useStore.ts:995,
  1043](src/store/useStore.ts)) — both the `__all__` super-admin branch
  AND the per-store branch wipe to `{}`. This is BEYOND the design
  (I only specified the per-store path) but is the right call: without
  it, switching from a per-store view back to `__all__` would have left
  stale per-recipe numbers attached to recipes that the `__all__` view
  shows. ✅ Justified addition.
- ✅ **Error path** = `set({ menuCapacity: {} })` + `notifyBackendError`
  ([useStore.ts:2400-2403](src/store/useStore.ts)).
- ✅ **No optimistic-then-revert** — correct for a read-only slice.

### Frontend wiring

- ✅ **Inline `MenuCapacityBadge` mount in RecipesSection** at
  [RecipesSection.tsx:297](src/screens/cmd/sections/RecipesSection.tsx)
  — placed after the cost/margin row per my directive.
- ✅ **MenuImpactSection columns + order** exactly match my §B table
  (menu item / makeable / binding / low count / brand)
  ([MenuImpactSection.tsx:35, 287-322](src/screens/cmd/sections/MenuImpactSection.tsx)).
- ✅ **Default sort** = `makeable` ASC
  ([MenuImpactSection.tsx:115](src/screens/cmd/sections/MenuImpactSection.tsx)).
- ✅ **No-BOM pin-to-bottom** via two-key comparator
  ([MenuImpactSection.tsx:62-63](src/screens/cmd/sections/MenuImpactSection.tsx)
  — `noBomA = a.hasRecipe ? 0 : 1`) — exactly the two-key pattern I
  specified.
- ✅ **Sidebar entry placement** — `MenuImpact` is the FIRST item in
  the INSIGHTS group
  ([cmdSelectors.ts:1091](src/lib/cmdSelectors.ts)).
- ✅ **Dispatch branch location** between `PrepRecipes` and
  `Reconciliation`
  ([InventoryDesktopLayout.tsx:200-201](src/screens/cmd/InventoryDesktopLayout.tsx)).
- ✅ **⌘K palette entry** added to `SCREEN_ENTRIES_DEFS`
  ([cmdSelectors.ts:180](src/lib/cmdSelectors.ts)).
- ✅ **i18n keys** follow the project convention
  (`sidebar.items.menuImpact`, `section.menuImpact.*`,
  `component.menuCapacityBadge.*`) per the existing namespacing.

### pgTAP test coverage

- ✅ All 10 assertion classes I specified are present (direct,
  transitive, leaf-binding, no-BOM, zero stock, unit mismatch, low
  count, cycle no-loop, RLS gate, anon revoke).
- ✅ Hermetic `begin; ... rollback;` envelope.
- ✅ Random-suffix fixture names to avoid UNIQUE collisions on re-run
  (good practice not in spec).

---

## ⚠️ Deviations — judged

### ⚠️ (1) `#variable_conflict use_column` pragma — JUSTIFIED

**Backend-dev's flag**: "no other RPC in the repo uses it. Was your design
implicitly relying on this, or did the dev encounter a real shadowing
issue you didn't anticipate?"

**Verdict:** Real PL/pgSQL behavior I did not anticipate in the design.
**Justified deviation; do not push back.**

`report_reorder_list` and `report_run_variance_multivendor` use
`RETURNS TABLE (...)` with column names that don't clash with the
inner CTE column names, OR the inner query qualifies every reference
through CTE aliases (`rl.recipe_id`, `bpr.makeable_qty`, etc.).

Our RPC has a name collision: the OUT-param `recipe_id uuid` shadows
unqualified `recipe_id` references inside the `all_recipes` /
`binding_per_recipe` / `recipe_rollup` CTEs. PL/pgSQL's default
binding is `variable` first, which raises `column reference is
ambiguous` at execution. The pragma flips this to `column` first.

This is documented Postgres behavior (§43.11.1) and the correct fix —
the alternative (renaming OUT params to `_recipe_id` etc.) would
either change the RPC's public column names (breaking the wrapper's
snake → camel mapping) OR require aliasing everywhere on the output
side (uglier and easier to drift). The pragma is the least-invasive,
correct choice.

I would have specified this in the design if I had hand-rolled the
plpgsql. I did not. **Backend-dev caught a real issue I missed; the
fix is correct.** No action needed.

The Files-changed-(backend) note already documents this rationale
([spec:983-986](specs/060-menu-item-low-stock-warning-capacity.md))
so future maintainers won't be surprised. Adequate.

### ⚠️ (2) `has_unit_mismatch` empty-recipe-unit case — JUSTIFIED

**Backend-dev's flag**: "your spec said 'fire when units differ';
backend-dev added 'empty recipe unit treated as matches'. Is the
edge case rule consistent with the spec intent, or has it silently
widened/narrowed the semantic?"

**Verdict:** Consistent with the spec's intent, and the design implicitly
hinted at this rule. **Justified; ratify in the spec's edge-case list.**

The spec §2 / §C edge case "`recipe_ingredients.unit` empty string →
treated as same unit as catalog (no mismatch flag)"
([spec:947-948](specs/060-menu-item-low-stock-warning-capacity.md))
was explicit in my design narrative. The migration's implementation:

```sql
bool_or(
  a.line_unit <> ''
  and coalesce(lower(nullif(ci.unit, '')), '') <> ''
  and a.line_unit <> coalesce(lower(nullif(ci.unit, '')), '')
)
```

requires BOTH sides non-blank before declaring a mismatch
([migration:207-211](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
That is the conservative direction: a blank recipe-line unit is
treated as "same as catalog" (no false-positive mismatch warning).

The semantic is **narrowed** (fewer mismatches reported) vs. a strict
string-inequality check. That is the right direction — false positives
in the unit-mismatch flag would erode user trust in the "~" qualifier,
which is the only signal that the capacity number is suspect. A false
negative (blank-vs-actual unit) is no worse than the existing variance
report's posture, which doesn't surface a unit signal at all.

**This is a justified silent narrowing.** It matches the spec's edge
case but the spec's main bullet ("fire when units differ") should be
read in light of the edge-case row. No action needed beyond updating
the design narrative if the spec is read in isolation.

### ⚠️ (3) Fire-and-forget `loadMenuCapacity` race — JUSTIFIED, no race

**Backend-dev's flag**: "Does this race with the realtime resubscribe
in `useRealtimeSync`, or is the eventual consistency acceptable?"

**Verdict:** No race. **Justified; design intent met.**

The chain is:

```
useRealtimeSync onChange → 400ms debounce → onSync callback →
useStore.loadFromSupabase(sid) → set({menuCapacity: {}}) +
fire-and-forget get().loadMenuCapacity(sid) → fetchMenuCapacity →
set({menuCapacity: keyed})
```

The realtime resubscribe happens at channel construction in
`useRealtimeSync`, not on every inventory mutation. The fire-and-forget
`loadMenuCapacity` is awaiting Promise resolution from the same
PostgREST endpoint; subsequent realtime triggers fire NEW
`loadFromSupabase` calls (each of which fires a NEW
`loadMenuCapacity`). If an in-flight `fetchMenuCapacity` is superseded
by a fresh one before its `set({menuCapacity: keyed})` lands, you'd
have an "out of order" overwrite where the older response could
clobber the newer one.

BUT — the spec 055 `tracked()` wrapper is the mitigation here:
`fetchMenuCapacity` is wrapped with `kind: 'read'`, which by spec
055's contract means the AbortController is wired up so a superseding
call cancels the in-flight one via the `signal` parameter. The
`.abortSignal(signal)` chain
([db.ts:2747](src/lib/db.ts)) connects this. So the stale-response
race is structurally prevented.

The only "race" left is the inline badge briefly showing nothing
during the 22-25ms RPC window. The badge component handles this:
"renders nothing while the menuCapacity slice is loading" — no
flicker, no incorrect number, just a momentary absence. That is the
design intent ("eventual consistency acceptable").

**No action needed.** Fire-and-forget is correct here.

### ⚠️ (4) Cycle test pgTAP shape — JUSTIFIED, but design wording is imprecise

**Backend-dev's flag**: "the cycle test asserts `makeable_qty = 4` for
reachable leaves but does NOT assert `truncated = true` (because the
visited array short-circuits BEFORE depth 5 fires). Was your design's
intent that the truncated flag MUST fire on a cycle, or just that the
CTE doesn't infinite-loop?"

**Verdict:** Design intent was "doesn't infinite-loop", not "truncated
MUST fire on cycle". **The test correctly omits the truncated assertion;
the design's risks-and-tradeoffs paragraph was imprecise about WHICH
mechanism catches WHICH case.**

The inherited variance/reorder pattern has TWO distinct cycle/depth
protections:

1. **Visited-array guard** — catches a cycle that closes WITHIN the
   depth cap (e.g., 2-node `prep_x ↔ prep_y` closes at depth 3). The
   recursion terminates cleanly via the `not (sub_recipe_id = any
   (visited))` predicate. `truncated = false`, but `makeable_qty`
   reflects only the leaves reached before the cycle closed.

2. **Depth-5 cap** — catches a long-but-acyclic chain (`menu → prep_a
   → prep_b → prep_c → prep_d → prep_e → prep_f`) that hasn't
   terminated by depth 5 AND has an unvisited next hop. `truncated =
   true`. `makeable_qty` reflects the first-5-depth subset.

For the test's 2-node cycle, mechanism (1) fires at depth 3, BEFORE
mechanism (2) ever has a chance to. So `truncated = false` is
**correct** for this specific cycle. Asserting `truncated = true`
would FAIL.

My design's §1 narrative
([spec:301-321](specs/060-menu-item-low-stock-warning-capacity.md))
talked about the cycle case + the depth cap in the same paragraph,
which made it sound like cycles always trigger `truncated`. The
"Risks & tradeoffs" paragraph
([spec:854-860](specs/060-menu-item-low-stock-warning-capacity.md))
"If a brand creates a real prep→prep cycle, the depth cap silently
truncates; `truncated=true` is emitted" was IMPRECISE — it's true
for cycles that BOTH (a) close beyond depth 5 AND (b) have an
unvisited next hop at depth 5. For a 2-node cycle that closes early,
the visited array catches it FIRST and `truncated` stays false.

**The implementation matches the inherited pattern and is correct.
The acceptance criteria § E ("renders an explicit label, not a crash,
not Infinity, not silent zero") is met:**

- For 2-node cycles: `makeable_qty` reflects reachable leaves (4 in
  the test). No crash. Not Infinity. Not silent zero. ✅
- For 6+ deep chains: `truncated = true` fires; UI renders `?`. ✅

**Test coverage gap?** The test exercises case (1) but not case (2).
There is no pgTAP test that constructs a chain longer than depth 5 to
verify the `truncated = true` emission path. **This is a Should-fix
coverage gap, not a bug** — the underlying code path is structurally
the same as `report_run_variance_multivendor`, which has the same
gap. Filed as a recommended follow-up below.

### ⚠️ (5) `MenuCapacityRow` in `types/index.ts` — JUSTIFIED relocation

**Backend-dev's flag**: "Backend-developer relocated this to types/
instead of db.ts to avoid a circular import. Was this a justified
deviation, or did your design implicitly accept a circular dep that
needs another fix?"

**Verdict:** Justified relocation. My design's "interface in db.ts"
WAS an implicit circular-dep, and the developer's move is the correct
fix. **No further action needed.**

The chain my design implied:

```
src/store/useStore.ts        — imports AppState type
src/types/index.ts           — defines AppState
  AppState declares           menuCapacity: Record<string, MenuCapacityRow>
src/lib/db.ts                — would have to be imported by types/index.ts
  defines                     MenuCapacityRow + fetchMenuCapacity + ...
  imports                     types from types/index.ts (Brand, Recipe, etc.)
```

`db.ts` imports from `types/index.ts`. If `types/index.ts` also
imports from `db.ts` (to get `MenuCapacityRow` into `AppState`), that
is a circular import — even with TypeScript's structural typing,
`tsc` will warn and the Metro bundler can break on it.

Developer's fix: define `MenuCapacityRow` in `types/index.ts:782`
(next to `ReorderPayload` and the other store-slice shapes), and
re-export it from `db.ts` for callers that prefer co-location with
the fetcher
([db.ts:2733-2739](src/lib/db.ts)). This is the same pattern used
for `Brand`, `Recipe`, `Vendor`, `ReorderPayload`, etc. — the type
lives in `types/`, fetchers in `db.ts` import from `types/` and
re-export.

**This is project-idiomatic and the right fix.** My original design's
"interface in db.ts" was wrong on a structural level. The developer
absorbed the cleanup without flagging it as a blocker — adequate.

The Files-changed note at
[spec:990-995](specs/060-menu-item-low-stock-warning-capacity.md)
documents the relocation. Good handoff hygiene.

---

## Other checks (matching design)

### Inline badge mount location ✅

`<MenuCapacityBadge recipeId={r.id} />` is mounted in the list-row
`renderItem` at
[RecipesSection.tsx:297](src/screens/cmd/sections/RecipesSection.tsx),
inside the price-row sub-View. The placement is below the cost/margin
row as I specified. The wrapping `<View style={{ flexDirection: 'row',
gap: 6 }}>` is a reasonable styling addition not in the spec.

### MenuImpactSection columns & default sort ✅

Header order:
[MenuImpactSection.tsx:287-322](src/screens/cmd/sections/MenuImpactSection.tsx).

Default `sortCol` = `makeable`, `sortDir` = `'asc'`
([MenuImpactSection.tsx:114-115](src/screens/cmd/sections/MenuImpactSection.tsx)).

Comparator pin-to-bottom logic at
[MenuImpactSection.tsx:62-63](src/screens/cmd/sections/MenuImpactSection.tsx)
matches my two-key spec.

### Sidebar placement ✅

`MenuImpact` is the FIRST item under INSIGHTS:
[cmdSelectors.ts:1086-1091](src/lib/cmdSelectors.ts).

### i18n key naming ✅

Three namespaces: `sidebar.items.menuImpact`,
`section.menuImpact.*`, `component.menuCapacityBadge.*`. All match
the existing convention. Catalog parity test passes (per Files-changed
verification).

---

## Recommendations / follow-ups (not blocking)

### Should-fix (next sprint, not this spec)

1. **pgTAP coverage gap on the depth-5 `truncated=true` path.** The
   current test exercises only the cycle-closes-within-depth-5 case
   (where `truncated=false` is correct). Add a second cycle test with
   a deep chain (e.g., 6 prep recipes in a line) that forces
   `truncated=true` to assert the depth-cap emission path
   independently. Same gap exists in
   `report_run_variance_multivendor`'s test; closing it uniformly is
   appropriate.

2. **Design narrative cleanup.** Update the design narrative
   ([spec:301-321 + 854-860](specs/060-menu-item-low-stock-warning-capacity.md))
   to distinguish (a) visited-array short-circuit (truncated=false,
   capacity from reachable subgraph) from (b) depth-cap emission
   (truncated=true). This is a doc-only change in the spec; the code
   is right.

### Minor

3. **`MenuCapacityRow` location.** Consider adding a one-line
   `// see CLAUDE.md` style comment near
   [types/index.ts:782](src/types/index.ts) explaining WHY this shape
   lives here and not in `db.ts` (circular-import) — the next person
   doing a similar slice will benefit. Backend-dev already added a
   comment at [db.ts:2733-2738](src/lib/db.ts) on the re-export side;
   matching the rationale at the canonical-definition site would
   complete the breadcrumb trail.

4. **`groupby ci.unit` in `recipe_lines`.** The migration's `group
   by` at
   [migration:218-220](supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)
   includes `ci.unit` as a grouping key even though `bool_or(a.line_unit
   <> '' and ... <> catalog_unit)` would aggregate fine without it.
   Functionally correct (1:1 join on catalog_id → 1 unit per
   catalog), but stylistically the group-by could be tightened. Not
   blocking; the SQL planner will collapse identical aggregations.

---

## Architecture verdict

**SHIP_READY from this reviewer.**

The implementation reflects a careful reading of the design AND the
inherited variance/reorder pattern. Where my design was imprecise
(truncated vs. visited-array distinction, `MenuCapacityRow` location,
PL/pgSQL OUT-param shadowing), the developer made the correct call,
documented the rationale in the Files-changed notes, and flagged the
deviations for this review. That is the right kind of developer
agency — neither silent invention nor over-cautious blocking.

No security-critical regressions: `auth_can_see_store()` pre-flight
fires before any side-effect, `security invoker` preserves per-store
RLS, anon is correctly revoked, and the explicit `from public` revoke
closes the inheritance gap.

No realtime regression: publication membership unchanged; no
`docker restart supabase_realtime_imr-inventory` step required.

The two coverage gaps (pgTAP depth-5 truncated path, browser smoke)
are reviewer-handoff items, not blockers.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix
  (depth-5 pgTAP coverage gap + design narrative cleanup), 2 Minor
  (comment hygiene + groupby tightening). All 5 backend-dev-flagged
  deviations judged JUSTIFIED. No blocking findings.
payload_paths:
  - specs/060/reviews/backend-architect.md
