# Spec 015: POS menu-item ↔ recipe mapping pickers (Cmd UI)

Status: READY_FOR_REVIEW

## User story

As a store manager who imports POS sales (Breadbot fetch or CSV upload),
I want to map unmapped pos_names to recipes — at import time, on the
mapping tab after the fact, and retroactively for past imports — so that
ghost-sale rows stop accumulating and depletion stays accurate.

## Background

Spec 014 ported the Breadbot fetch and CSV preview into `POSImportsSection`,
but the port stopped at *detecting* unmapped rows. There is no UI to
actually map them. This means:

- Unmapped rows in the Breadbot preview can only be "imported as-is" —
  they record but skip depletion. The user has no way to attach a recipe
  before confirming the import.
- The new `mapping.tsx` tab is read-only (lists confirmed aliases plus
  unmapped count). Its empty-state copy even promises *"confirm an
  unmapped row in imports.tsx review and it will land here"* — but no
  such confirm UI exists in the new section. Aliases can't be added,
  edited, or removed from this surface today.
- The legacy "Items needing mapping (N)" card surfaces past unmapped
  pos_names from the last 30 days; picking a recipe upserts an alias AND
  retroactively flips matching past `pos_import_items` rows to
  `recipe_mapped = true`. That long-tail rescue path was not ported.

The legacy implementation in `src/screens/POSImportScreen.tsx` is the
behavioral reference (frozen — must NOT be modified). The backend
plumbing (`upsertPosRecipeAliases`, `applyAliasToPastImports`,
`fetchUnmappedPosImports`) already exists in `src/lib/db.ts` and the
store actions exist in `src/store/useStore.ts`. This spec is a
pure-frontend port of three UI surfaces onto existing backend.

## Acceptance criteria

### Surface 1 — per-row Map… picker in the Breadbot preview card

- [ ] Each row in `BreadbotPreviewCard` (the in-section preview rendered
      after a single Breadbot fetch) is tappable. Tapping the recipe pill
      opens a recipe picker modal anchored to that row index.
- [ ] The modal shows the POS string (`row.menuItem`) at the top, a
      search box that filters by `recipe.menuItem`, an alphabetically
      sorted list of recipes (sell price as a sub-line), and a "— No
      match (skip this item) —" option that clears the row's recipe.
- [ ] Picking a recipe updates the row's local `previewMatches[idx]` to
      `{ recipeId, matchType: 'alias' }` so the pill re-renders with the
      OK styling and the new recipe label, without re-running
      `matchRecipe` against that row.
- [ ] Picking "No match" sets `{ recipeId: null, matchType: 'none' }`
      and the pill re-renders to "no match" with danger styling.
- [ ] Per-row overrides survive the existing `useEffect` re-match block:
      a user-confirmed override does NOT get reset when `recipes` or
      `posRecipeAliases` changes.
- [ ] On confirm (existing `IMPORT N ITEMS · DATE` button), the override
      is included in the items array AND in the alias upsert. No regression
      to the existing dedup/savePOSImport/importPOS pipeline.
- [ ] testID: `posimport-cmd-row-picker-{idx}` on the pill,
      `posimport-cmd-picker-search` on the search input,
      `posimport-cmd-picker-recipe-{recipeId}` on each option,
      `posimport-cmd-picker-none` on the "No match" option.

### Surface 2 — mapping.tsx editor (add / edit / remove aliases)

- [ ] On the `MappingTab`, each row in the UNMAPPED.LOG panel becomes
      tappable. Tapping the row opens the same recipe picker modal,
      pre-populated with the pos_name. Picking a recipe upserts the
      alias for the current store AND triggers the retroactive flip
      (see Surface 3 mechanics).
- [ ] On the `MappingTab`, each row in ACTIVE_ALIASES.TSV gets two
      controls: an "edit" affordance that opens the picker pre-populated
      with the current pos_name → recipe binding, and a "remove" affordance
      that prompts via `confirmAction` ("Remove alias for {pos_name}?")
      and on confirm calls a new store action to delete the alias row.
- [ ] Edit confirms by upserting the alias against the new recipe (UPSERT
      on `(pos_name, store_id)` already collapses to update — no separate
      RPC needed).
- [ ] Remove deletes the `pos_recipe_aliases` row server-side and removes
      it from local state optimistically; on backend error the row reverts
      and `notifyBackendError` toasts.
- [ ] After any edit / add / remove on `MappingTab`, the `posRecipeAliases`
      slice and the unmapped count derived from `posImports` reflect the
      new state on the next render (no manual refresh).
- [ ] Empty-state copy on ACTIVE_ALIASES.TSV is updated to no longer
      reference *"confirm an unmapped row in imports.tsx review and it
      will land here"* — that flow is now in this tab. New copy:
      *"no aliases yet — tap an unmapped row to map it, or wait for
      auto-matches on the next import"* (final wording at architect's
      discretion; the load-bearing change is removing the broken pointer).
- [ ] testID: `mapping-cmd-unmapped-pick-{posName}` on each unmapped row,
      `mapping-cmd-alias-edit-{posName}` and
      `mapping-cmd-alias-remove-{posName}` on each confirmed row.

### Surface 3 — past-30-days unmapped review with retroactive flip

- [ ] The unmapped rows surfaced on `MappingTab` MUST be the union of
      (a) past unmapped rows from the last 30 days, fetched via
      `fetchUnmappedPosImports(currentStore.id)` server-side, and
      (b) the existing local-state derivation from `posImports.items`
      where `recipeMapped === false`. De-dup by pos_name. Today the tab
      only computes (b), missing rows that were imported in earlier
      sessions and are not in the local `posImports` slice for any
      reason.
- [ ] Mapping an unmapped row from `MappingTab` calls the existing store
      action `applyAliasToPastImports(posName, recipeId)` after the
      alias upsert. The toast message reflects the count returned:
      `Updated N past row${N === 1 ? '' : 's'}.` if N > 0 else
      `Future imports will use this mapping.`
- [ ] After the retroactive flip succeeds, the local `posImports` slice
      is updated so the matching rows show `recipeMapped: true` (and
      `recipeId` populated) without a full reload. This keeps the
      imports.log row counts and the UNMAPPED.LOG panel in sync within
      the same session.
- [ ] Inventory deduction is NOT retroactively applied (matches legacy
      `applyAliasToPastImports` semantics — flips display flag only).
      The toast must state this implicitly via the existing copy
      (*"Updated N past row(s)"*); no inventory-changed claim.
- [ ] If the user re-imports the affected day to recover the deduction,
      the existing dedup guard (`hasPOSImportForDate`) blocks the
      re-import unless they delete the prior row first. This is unchanged
      and out of scope here; surfaced so reviewers know not to flag it.

### Cross-cutting

- [ ] All three surfaces share a single `RecipePickerModal` component at
      `src/components/cmd/RecipePickerModal.tsx`. Centered-overlay,
      Escape-to-close on web, search-as-you-type filter, alphabetical
      sort, optional "No match" entry (shown only for per-row overrides
      where clearing the recipe is meaningful — hidden on
      mapping.tsx where you came from a row that has no alias yet).
- [ ] Picker uses `useCmdColors()` for palette and the `mono`/`sans`
      typography helpers. Search input uses `C.bgSecondary` + `C.borderMedium`.
- [ ] Cancel via tapping the backdrop OR the explicit Cancel button OR
      the Escape key (web) closes the modal without mutation.
- [ ] No new database migrations. No new edge functions. No new RPCs.
- [ ] Existing edge function (`fetch-breadbot-sales`) and PostgREST flows
      unchanged.

## In scope

- New `RecipePickerModal` component in `src/components/cmd/`.
- Modifications to `src/screens/cmd/sections/POSImportsSection.tsx`:
  - `BreadbotPreviewCard`: per-row pill becomes tappable, opens picker,
    writes back to a local match-overrides map; existing re-match
    `useEffect` honors overrides.
  - `MappingTab`: rows in both panels become tappable / editable;
    unmapped panel data source merges in `fetchUnmappedPosImports`;
    confirmed panel rows get edit + remove controls; remove uses
    `confirmAction`.
- New thin store action `removePosRecipeAlias(posName: string)` in
  `src/store/useStore.ts` calling a new thin db.ts helper
  `deletePosRecipeAlias(storeId, posName)`. Optimistic-then-revert per
  the project's standard pattern (see `notifyBackendError`).
- Augment `applyAliasToPastImports` in the store (or call site) so that
  after the RPC returns N, the local `posImports.items` slice is
  patched to set `recipeMapped: true` and `recipeId` for matching rows.
  No new DB write — this is purely local state reconciliation against
  what the server just changed.

## Out of scope (explicitly)

- **CSV-path per-row picker.** Spec 014's architect contract correction
  routes the CSV path through `RunImportModal` (operating on inventory
  diff rows), not through the section's BreadbotPreviewCard. CSV-side
  per-row recipe override would require restructuring `RunImportModal`'s
  shape and is a separate spec. Rationale: keeping spec 015 to one diff
  path avoids cross-cutting changes; the CSV upload flow today still
  benefits from Surface 2 (mapping.tsx editor) and Surface 3 (retroactive
  flip) once an unmapped row lands.
- **Toast / Square / Clover connector wiring.** `sources.tsx` stays
  "NOT YET WIRED". A separate spec covers the `pos_sources` table +
  OAuth + cron — explicitly per user instruction.
- **Inventory deduction retroactivity.** When a past unmapped row is
  flipped to `recipe_mapped = true`, the historical inventory deduction
  for that pos_import_items row is NOT applied. User re-imports the day
  if they need to recover stock state. Matches legacy semantics.
- **Bulk operations.** No "map all unmapped at once" or "remove all
  aliases" affordance. One-by-one only.
- **Cross-store alias copy.** Aliases stay store-scoped. No "copy this
  alias to other stores" affordance.
- **Master / store-null aliases.** `pos_recipe_aliases.store_id` can be
  null (cross-store). The current fetch at `fetchPosRecipeAliases`
  already returns both store-scoped and store-null rows. Editing /
  removing a store-null alias from one store's `MappingTab` would have
  cross-store impact — the picker only writes store-scoped aliases
  (never sets store_id = null), and the remove affordance is hidden
  for any alias whose `store_id` is null. Surface in the UI as a
  read-only badge ("global") on those rows; do not allow remove from
  this section.
- **Undo for alias remove.** Remove is destructive but cheap to recreate
  (just re-pick). No undo affordance; the `confirmAction` prompt is the
  guard.
- **Test framework.** No tests yet; manual verification probes below.

## Open questions resolved

- **Q: All three surfaces in one spec, or split?**
  → A: All three. User listed all three together with rationale; the
  shared picker primitive is the same component; landing them as one
  diff is cheaper than three. Auto-mode call.
- **Q: Recipe picker UX shape?**
  → A: Centered-overlay modal matching `FetchBreadbotModal` /
  `UploadCsvModal` style. Reusable component. Mirrors legacy modal
  shape, consistent with rest of Cmd UI.
- **Q: Retroactive flip semantics?**
  → A: Yes-flip-but-no-deduction. Matches existing
  `applyAliasToPastImports` RPC behavior. Conservative path. Toast wording
  must NOT imply inventory was changed.
- **Q: Mapping tab data source — server vs local-only?**
  → A: Both, merged. Server fetch catches the long tail of past unmapped
  rows that aren't in the current local `posImports` window.
- **Q: Bulk ops?**
  → A: Out. One-by-one only.

## Dependencies

- **Existing backend (no changes):**
  - `src/lib/db.ts`: `upsertPosRecipeAliases`, `applyAliasToPastImports`,
    `fetchUnmappedPosImports`, `fetchPosRecipeAliases`. All present.
  - Database tables: `pos_recipe_aliases`, `pos_imports`,
    `pos_import_items`. No schema changes.
- **New thin backend helper:**
  - `deletePosRecipeAlias(storeId: string, posName: string): Promise<void>`
    in `src/lib/db.ts`. Single DELETE on `pos_recipe_aliases` keyed by
    `(pos_name, store_id)`. Console-warn on error per existing pattern.
- **New / augmented store actions:**
  - `removePosRecipeAlias(posName: string): Promise<void>` —
    optimistic-then-revert wrapper around the new db helper.
  - Augmentation to `applyAliasToPastImports` store action: after the
    db call returns N, patch local `posImports` slice to flip the
    matching items to `recipeMapped: true` and populate `recipeId`. The
    `posName` ↔ `it.menuItem` comparison is case-insensitive trim-match
    (matches the server-side `ilike`).
- **New shared component:**
  - `src/components/cmd/RecipePickerModal.tsx` — props `{ visible,
    onClose, posName, currentRecipeId?, allowNoMatch?, onPick:
    (recipeId: string | null) => void }`. Reads `useStore(s => s.recipes)`
    internally; consumer doesn't pass the list.
- **No new edge function. No new migration. No new RPC.**
- **No `app.json` changes.**
- **No realtime channel changes** (the existing `store-{id}` debounced
  reload picks up `pos_recipe_aliases` writes via the same publication).

## Project-specific notes

- **Cmd UI section vs legacy:** All three surfaces live under
  `src/screens/cmd/sections/POSImportsSection.tsx` and a new
  `src/components/cmd/RecipePickerModal.tsx`. Legacy
  `src/screens/POSImportScreen.tsx` MUST NOT be modified.
  `src/screens/AdminScreens.tsx` MUST NOT be modified.
- **Per-store or admin-global:** Per-store. Aliases are scoped by
  `currentStore.id`. Cross-store aliases (store_id = null) render
  read-only with a "global" badge and cannot be removed from this UI.
- **Realtime channels touched:** None new. Existing `store-{id}` channel
  picks up `pos_recipe_aliases` and `pos_import_items` writes via the
  same publication. The realtime publication gotcha (per project memory)
  applies if `pos_recipe_aliases` is not already in the publication —
  reviewers should verify or call out as a doc-only addendum.
- **Migrations needed:** No. All required tables exist.
- **Edge functions touched:** None.
- **Web/native scope:** Both. Modal uses the `Modal` primitive from
  `react-native`, which is the same primitive used by other Cmd modals
  in this section. Escape-to-close is web-only (DOM listener, gated by
  `Platform.OS === 'web'`).
- **Tests:** No test framework. Manual verification probes only (below).
  Flag for test-engineer that picker logic + retroactive-flip local
  reconciliation are the two highest-risk paths if a runner is wired
  in a future spec.
- **Optimistic-then-revert pattern:** All write paths follow the
  project's standard — local state mutates first, db call follows, on
  error revert + `notifyBackendError` toast. See existing
  `upsertPosRecipeAliases` consumer at `POSImportsSection.tsx:222` for
  shape.
- **Cross-platform confirm:** `removePosRecipeAlias` uses
  `confirmAction` from `src/utils/confirmAction.ts`.
- **Theme:** `useCmdColors()` for palette; `Type.*`, `mono(...)`,
  `sans(...)` for typography. Match the look of existing
  `BreadbotPreviewCard` and `MappingTab` panels.
- **Toast:** `react-native-toast-message`, position `'bottom'`, matching
  existing patterns in the section.

## Manual verification probes

Run each on web (`EXPO_PUBLIC_NEW_UI=true npm run dev`) against the
local Supabase stack (`npm run dev:db`, login `admin@local.test` /
`password`):

### Surface 1 — per-row picker

1. Navigate to POS imports → click FETCH BREADBOT → pick a date with
   sales → preview appears.
2. Click an "auto-matched" pill that picked the wrong recipe (find one
   by inspecting the rows; or seed an alias that points to the wrong
   recipe). Modal opens with that POS string at the top.
3. Search for a different recipe → click it → modal closes → pill
   re-renders to the new recipe with OK styling.
4. Click the "no match" or unmapped pill → pick "No match (skip this
   item)" → pill goes red.
5. Confirm the import. Verify (a) the imports.log row reflects the
   match counts including the override, (b) `pos_recipe_aliases` has
   the new row keyed by the picked POS name → recipe id, (c) the row
   that was set to "No match" has `recipe_mapped = false` in
   `pos_import_items`.
6. Re-fetch the same Breadbot date in a new session — the row that
   was overridden auto-matches via the new alias.

### Surface 2 — mapping.tsx editor

7. Switch to the `mapping.tsx` tab. UNMAPPED.LOG panel lists pos_names
   that are unmapped (local + server-merged). Click one. Picker opens.
   Pick a recipe. Toast: `Alias saved · Updated N past row(s).` if N>0
   else `Alias saved · Future imports will use this mapping.`
8. Verify the row left UNMAPPED.LOG and now appears in
   ACTIVE_ALIASES.TSV pointing at the picked recipe.
9. Click the edit affordance on a confirmed alias. Picker opens with
   the existing recipe pre-selected. Pick a different recipe. The
   alias updates (DB upsert).
10. Click the remove affordance on a confirmed alias. `confirmAction`
    prompt: "Remove alias for {pos_name}?". Confirm. Row leaves
    ACTIVE_ALIASES.TSV. Verify `pos_recipe_aliases` row gone via
    direct DB query.
11. Click the remove affordance on a "global" (store_id = null) alias —
    confirm the affordance is HIDDEN, not just disabled. Verify a
    "global" badge renders on those rows.

### Surface 3 — retroactive flip

12. Pick a pos_name that exists as an unmapped row in
    `pos_import_items` from > 1 day ago (manually insert if needed).
    Map it from `mapping.tsx`. Toast count reflects the rows updated.
13. Switch to `imports.tsx` tab. The imports.log entries containing
    that pos_name now show their match counts updated (more matched,
    fewer in `(−N)` suffix).
14. Verify in DB that the affected `pos_import_items` rows have
    `recipe_mapped = true` and `recipe_id` populated.
15. Confirm `inventory_items.current_stock` for ingredients of the
    picked recipe is UNCHANGED — retroactive flip does NOT deduct.

### Cross-cutting

16. Backend error path: kill the local Supabase, attempt to remove an
    alias. UI optimistically removes, then reverts with a toast.
17. Same for upsert path: attempt to pick a recipe with the DB down.
    UI optimistically updates the local match override + alias slice,
    then reverts with a toast.
18. Native: build with `EXPO_PUBLIC_NEW_UI=true` and run on iOS sim.
    Picker modal opens, search filters, pick fires the callback.
    Escape-to-close is web-only and absent on native (expected).

## Backend design

### 0. PM-flagged contract drift — verified, not real drift

PM noted: legacy call site at `src/screens/POSImportScreen.tsx:365`
passes 2 args to the store action `applyAliasToPastImports(posName,
recipeId)` while the db helper at `src/lib/db.ts:1506` takes 3 args
`(storeId, posName, recipeId)`.

Verified in `src/store/useStore.ts:1455-1464`: the store action
already injects `currentStore.id` and forwards to the db helper.
The 2-arg shape is the public store-action surface; the 3-arg shape
is the underlying db helper. **No drift; no fix required.** New
call sites (Surfaces 1-3) all go through the 2-arg store action.

### 1. Data model changes

**None.** No new migrations, no schema changes.

The three relevant tables already exist:

- `pos_recipe_aliases` — created in a pre-2026-05 migration (the
  per-store-RLS hardening migration at
  [supabase/migrations/20260504173035_per_store_rls_hardening.sql:18-23](supabase/migrations/20260504173035_per_store_rls_hardening.sql)
  explicitly notes `pos_recipe_aliases ... predate this refactor and
  will be brought into the auth_can_see_store helper in a follow-up`
  — see §2 below for the implication).
- `pos_imports`, `pos_import_items` — already on the helper-based
  contract via the hardening migration (lines 253-321).

### 2. RLS impact — and the architectural drift it surfaces

**Status quo.** `pos_recipe_aliases` policies were intentionally left
untouched by the per-store-RLS hardening migration. Per the migration
header comment at lines 18-23, the policy on this table is the older
`auth.uid() IS NOT NULL` (or similar) shape — it does NOT route through
`auth_can_see_store(store_id)`. This means today, any authed user can
read or modify any store's pos_recipe_aliases rows; the Cmd UI is the
only thing that filters by `currentStore.id`.

**For this spec.** No new policies. The new `deletePosRecipeAlias` db
helper does a single DELETE on `pos_recipe_aliases` keyed by
`(pos_name, store_id)` and inherits whatever the existing policies
allow. As long as the existing policies allow authed DELETE — which
they currently do — the helper works without any RLS work in this
spec.

**Architectural-drift FLAG (separate from the super_admin work the PM
prompt mentioned).** This is a second instance of the legacy
"any-authed-user" RLS pattern still in production. Spec 015 does NOT
attempt to fix it (out of scope, additive-only spec). Recommend:

- Open a follow-up "RLS hardening — pos_recipe_aliases" spec that
  drops the legacy "Store access" / `auth.uid() IS NOT NULL` policy
  and adds the four `auth_can_see_store(store_id)`-helper policies
  (read / insert / update / delete) — with a special carve-out for
  `store_id IS NULL` rows ("global" aliases) which should be admin-
  only writes (`auth_is_admin()`) and broadly readable. Until that
  ships, the UI guard (hiding the remove affordance for global
  aliases — see §6 of acceptance criteria) is purely cosmetic — a
  motivated client could DELETE a global alias via direct PostgREST.
  Document this as a known risk in the follow-up spec, not blocking
  for 015.

The PM prompt asked specifically whether other tables still have the
"JWT-only-role" check the recent super_admin work caught. Verified:
the non-helper tables I touched in this spec are `pos_recipe_aliases`,
`pos_imports`, `pos_import_items`. Of those, `pos_recipe_aliases` is
the one stragger; `pos_imports` and `pos_import_items` are already
on the helper. No additional drift detected in the read path of this
spec.

### 3. API contract — PostgREST only, no new RPC

All three surfaces go through PostgREST direct-table access via
existing `src/lib/db.ts` helpers. No new edge functions. No new RPCs.

**Existing helpers reused:**
- `fetchPosRecipeAliases(storeId)` — already loaded into
  `state.posRecipeAliases` by `loadFromSupabase`
  ([src/store/useStore.ts:787](src/store/useStore.ts)).
- `upsertPosRecipeAliases(rows)` — UPSERT on `(pos_name, store_id)`.
  Already wired in the section's existing confirm path
  ([src/screens/cmd/sections/POSImportsSection.tsx:222](src/screens/cmd/sections/POSImportsSection.tsx)).
- `applyAliasToPastImports(storeId, posName, recipeId)` — db helper,
  3-arg. Wrapped by store action `applyAliasToPastImports(posName,
  recipeId)` which injects `currentStore.id`.
- `fetchUnmappedPosImports(storeId)` — last 30 days, returns
  `{ menu_item, count }[]` sorted desc by count.

**New helper (additive — backend-developer scope):**

```ts
// src/lib/db.ts (new — append near line 1500, beside the other
// pos_recipe_aliases helpers)
export async function deletePosRecipeAlias(
  storeId: string,
  posName: string,
): Promise<void> {
  const { error } = await supabase
    .from('pos_recipe_aliases')
    .delete()
    .eq('store_id', storeId)
    .eq('pos_name', posName.trim());
  if (error) {
    console.warn('[Supabase] deletePosRecipeAlias:', error.message);
    throw error;  // bubble so the store action's optimistic-revert path fires
  }
}
```

Two structural notes for the developer:

1. **Throw, don't swallow.** Note the difference from
   `upsertPosRecipeAliases` (line 1475), which only `console.warn`s.
   The remove path NEEDS to throw so the store action's revert
   branch fires. If you copy the upsert pattern, the optimistic
   delete will silently stick on backend failure and the user thinks
   it succeeded.
2. **`store_id` filter is load-bearing.** Filtering on
   `store_id = $storeId` AND NOT just `pos_name` ensures we never
   accidentally delete a global alias (`store_id IS NULL`) when
   removing a store-scoped alias of the same `pos_name`. Frontend
   already gates remove via the `c.store_id !== null` UI guard, but
   the backend filter is a defense-in-depth duplicate.

### 4. Edge function changes

**None.** No edge functions touched. No `verify_jwt` changes.

### 5. `src/lib/db.ts` surface

**One new function, additive:**

| Function | Signature | Notes |
|---|---|---|
| `deletePosRecipeAlias` | `(storeId: string, posName: string) => Promise<void>` | DELETE. Throws on error. snake_case → no return value to map. |

No existing helpers change shape. All three surfaces consume helpers
that already exist.

### 6. Realtime impact — the publication gotcha applies

**Existing publication state — verify.**
[src/hooks/useRealtimeSync.ts](src/hooks/useRealtimeSync.ts) listens on:

- `store-{id}` channel: `inventory_items`, `waste_log`,
  `eod_submissions` only.
- `brand-{id}` channel: `recipes`, `prep_recipes`,
  `catalog_ingredients`, `vendors`, `ingredient_conversions`.

**Neither channel currently subscribes to `pos_recipe_aliases`,
`pos_imports`, or `pos_import_items`.** So the spec's claim at line
244 (*"the existing `store-{id}` debounced reload picks up
`pos_recipe_aliases` writes via the same publication"*) is incorrect
as written — the publication may carry the table, but no client
subscription handler fires today.

**For this spec.** Realtime echo is NOT required. All three surfaces
are single-tab, single-user flows where the local state mutation
inside the Zustand store is the source of truth for the in-session
UI. Cross-tab / cross-user reflection of alias edits is a nice-to-
have, not a correctness requirement.

Decision: **do NOT add realtime subscriptions in this spec.** The
optimistic-update + local-state-patch pattern is sufficient. If a
multi-tab admin workflow ever wants this, it's an additive change to
`useRealtimeSync.ts` (one extra `.on()` per table) that doesn't
require any DB-side migration if the table is already in the
`supabase_realtime` publication. Frontend-developer can verify the
publication membership later if needed; not blocking for 015.

**The publication gotcha (no-op for this spec, but noted for completeness).**
If a future spec adds the realtime subscription AND the table
turns out to NOT be in `supabase_realtime` already, the migration to
`alter publication supabase_realtime add table public.pos_recipe_aliases`
would require restarting the local realtime container with
`docker restart supabase_realtime_imr-inventory` after `npm run dev:db`.
This spec does not change publication membership; reviewers and
release-coordinator can skip the publication-restart check.

### 7. Frontend store impact — slice changes

Spec touches these slices in [src/store/useStore.ts](src/store/useStore.ts):

- `posRecipeAliases: PosRecipeAlias[]` — already exists. Mutated by
  existing `upsertPosRecipeAliases`. New: mutated by
  `removePosRecipeAlias`.
- `posImports: POSImport[]` — already exists, populated by
  `importPOS` action. New: PATCHED in-place by augmented
  `applyAliasToPastImports` to flip `recipeMapped: true` and
  populate `recipeId` on rows whose `it.menuItem` case-insensitive-
  trim-matches the picked `posName`.

**Critical note: `posImports` is NOT hydrated from Supabase by
`loadFromSupabase`.** Verified: looking at the load path at
[src/store/useStore.ts:766-788](src/store/useStore.ts), `posImports`
is not in the slice. It only gets populated client-side via the
`importPOS` action. Implication: after a session reload, the local
`posImports` slice will be empty until the user runs another
import. Surface 3's server fetch via `fetchUnmappedPosImports` is
therefore the ONLY source of truth for "past unmapped pos_names from
prior sessions" — which is exactly the long-tail rescue path the
spec calls for. The server fetch + local derivation merge logic
(§9 below) handles both cases cleanly.

#### 7a. New store action — `removePosRecipeAlias`

```ts
// src/store/useStore.ts — interface declaration (alongside line 213)
removePosRecipeAlias: (posName: string) => Promise<void>;

// implementation (insert at line ~1465, beside applyAliasToPastImports)
removePosRecipeAlias: async (posName) => {
  const storeId = get().currentStore.id;
  if (!storeId || !posName) return;
  const trimmed = posName.trim();
  // Snapshot for revert. Filter is case-insensitive to match the
  // server-side `pos_name` upsert which trims+stores as-is.
  const prev = get().posRecipeAliases;
  set({
    posRecipeAliases: prev.filter(
      (a) => !(
        a.store_id === storeId
        && a.pos_name.trim().toLowerCase() === trimmed.toLowerCase()
      ),
    ),
  });
  try {
    await db.deletePosRecipeAlias(storeId, trimmed);
  } catch (e: any) {
    set({ posRecipeAliases: prev });
    notifyBackendError('Remove alias', e);
  }
},
```

Pattern: optimistic-then-revert, mirrors `deleteVendor`
([src/store/useStore.ts:1378-1385](src/store/useStore.ts)) and
`deleteRecipeCategory` (line 967). `notifyBackendError` already
toasts and console-warns; no extra logging needed.

#### 7b. Augmented store action — `applyAliasToPastImports`

```ts
// src/store/useStore.ts — replace the existing impl at lines 1455-1464
applyAliasToPastImports: async (posName, recipeId) => {
  const storeId = get().currentStore.id;
  if (!storeId) return 0;
  let updated = 0;
  try {
    updated = await db.applyAliasToPastImports(storeId, posName, recipeId);
  } catch (e: any) {
    console.warn('[Supabase] applyAliasToPastImports:', e?.message || e);
    return 0;
  }
  // Local reconciliation — mirror the server-side `ilike` match by
  // doing a case-insensitive trim comparison against `it.menuItem`.
  // This keeps the imports.log row counts and the UNMAPPED.LOG panel
  // in sync within the same session without a full reload.
  if (updated > 0) {
    const target = posName.trim().toLowerCase();
    set((s) => ({
      posImports: s.posImports.map((im) => {
        if (im.storeId !== storeId) return im;
        let dirty = false;
        const items = (im.items || []).map((it) => {
          if (it.recipeMapped) return it;
          const name = (it.menuItem || '').trim().toLowerCase();
          if (name !== target) return it;
          dirty = true;
          return { ...it, recipeMapped: true, recipeId };
        });
        return dirty ? { ...im, items } : im;
      }),
    }));
  }
  return updated;
},
```

Notes:
- Comparison is `.trim().toLowerCase()` — matches Postgres `ilike`
  semantics for the typical ASCII-only POS strings. Unicode-fold edge
  cases (e.g., German `ß` vs `SS`) are out of scope; if a row trips
  it, the server-side `ilike` is the source of truth and a full
  reload restores correctness.
- `dirty` flag avoids `set()`-ing identical objects so React's
  reference-equality bail-out keeps re-render scope minimal.
- `if (updated > 0)` short-circuit avoids walking the slice when the
  RPC matched nothing, which is the common case for newly-imported
  aliases.

#### 7c. Existing store action — `upsertPosRecipeAliases` (no change)

The existing implementation at lines 1433-1453 already covers the
spec needs. Surface 1 (preview confirm), Surface 2 (mapping editor
add/edit), and Surface 3 (unmapped picker) all call it identically.

### 8. `RecipePickerModal` prop shape

Single shared component at `src/components/cmd/RecipePickerModal.tsx`.
Centered overlay, mirrors `RunImportModal` shape for visual
consistency. Reads `useStore(s => s.recipes)` internally so consumers
don't pass the list.

```ts
// src/components/cmd/RecipePickerModal.tsx
export interface RecipePickerModalProps {
  /** Modal visibility. Caller toggles. */
  visible: boolean;
  /** Closed without picking — caller should clear any "picker open
   *  for row idx X" state. Backdrop tap, Escape (web), Cancel. */
  onClose: () => void;
  /** POS string shown at the top of the modal. Read-only. Used to
   *  jog the user's memory ("you're mapping THIS string to THAT
   *  recipe"). */
  posName: string;
  /** The currently-bound recipe id, if any. Drives the active
   *  highlight on the matching row. Used for Surface 1 overrides
   *  and Surface 2 edit. */
  currentRecipeId?: string | null;
  /** When true, render a "— No match (skip this item) —" entry at
   *  the top of the recipe list. Picking it fires `onPick(null)`.
   *  Used for Surface 1 per-row override so the user can clear a
   *  bad auto-match. Hidden on Surface 2 (mapping.tsx) where
   *  picking nothing means "leave it unmapped" — the user just
   *  closes the modal in that case. */
  allowNoMatch?: boolean;
  /** User picked. recipeId === null only when allowNoMatch is true
   *  AND the user picked the "No match" entry. Caller is
   *  responsible for closing the modal (via onClose) AFTER its
   *  side-effect logic runs, so the modal stays visible during the
   *  brief async beat where the alias upsert fires. Or close
   *  immediately and run the side-effects asynchronously — caller's
   *  call. Spec uses the close-immediately pattern; the optimistic
   *  state updates make the picker feel instant. */
  onPick: (recipeId: string | null) => void;
}
```

**Internal behavior (component-local):**

- `useState<string>` for the search query. Filter on
  `recipe.menuItem.toLowerCase().includes(query.toLowerCase())`.
- Sort recipes alphabetically by `menuItem` (case-insensitive).
- Render each recipe as `{menuItem}` + `${sellPrice ? '· $' +
  sellPrice.toFixed(2) : ''}` sub-line.
- Header shows the `posName` prominently with a "POS" pill.
- Escape-to-close on web (gated by `Platform.OS === 'web'`),
  matching `RunImportModal:65-74`.
- Backdrop tap closes via `onClose`.
- testIDs per spec: `posimport-cmd-picker-search` on TextInput,
  `posimport-cmd-picker-recipe-{recipeId}` on each row,
  `posimport-cmd-picker-none` on the "No match" entry.

**Call-site behavior summary:**

| Surface | Trigger | `posName` | `currentRecipeId` | `allowNoMatch` | `onPick` |
|---|---|---|---|---|---|
| 1 (BreadbotPreviewCard row pill) | Tap on per-row pill | `row.menuItem` | `previewMatches[idx]?.recipeId ?? null` | `true` | Set `previewMatches[idx] = { recipeId, matchType: recipeId ? 'alias' : 'none' }` (where the override map is the new local state in §10). Close modal. |
| 2 (MappingTab unmapped row) | Tap on unmapped row | `u.pos_name` | (none) | `false` | Call `upsertPosRecipeAliases([{ posName, recipeId }])` then `applyAliasToPastImports(posName, recipeId)`; toast based on returned count. Close modal. |
| 2 (MappingTab confirmed row edit) | Tap on edit affordance | `c.pos_name` | `c.recipe_id` | `false` | Call `upsertPosRecipeAliases([{ posName, recipeId }])`. Toast `Alias updated`. Close modal. |

### 9. Merge logic for `MappingTab` unmapped panel

Source of truth: union of (a) `fetchUnmappedPosImports(storeId)` from
the server (last 30 days), and (b) the existing local-state derivation
from `posImports.items` where `recipeMapped === false`.

```ts
// MappingTab — pseudocode
const [serverUnmapped, setServerUnmapped] = React.useState<
  { menu_item: string; count: number }[]
>([]);
const [serverLoading, setServerLoading] = React.useState(false);
const [refreshTick, setRefreshTick] = React.useState(0);

React.useEffect(() => {
  if (!currentStore.id) return;
  setServerLoading(true);
  fetchUnmappedPosImports(currentStore.id)
    .then(setServerUnmapped)
    .catch(() => setServerUnmapped([]))
    .finally(() => setServerLoading(false));
}, [currentStore.id, refreshTick]);

// Merge step. Key by case-insensitive trim of the POS name. Server
// rows win for the count (they reflect the full 30-day window);
// local rows fill in any names that aren't in the server result
// (shouldn't happen post-fetch, but defensive in case the user just
// imported and the server hasn't reflected it yet).
const unmapped = React.useMemo(() => {
  const map = new Map<string, { pos_name: string; rows: number; lastSeen?: string }>();

  // Layer A — server (canonical for the 30-day window).
  for (const row of serverUnmapped) {
    const key = row.menu_item.trim().toLowerCase();
    if (!key) continue;
    map.set(key, { pos_name: row.menu_item.trim(), rows: row.count });
  }

  // Layer B — local derivation. Augments any name the server
  // returned with a lastSeen, AND adds any local-only names (e.g.
  // the user just imported and the result isn't in serverUnmapped
  // yet because the fetch fired before the import landed).
  for (const im of posImports.filter((p) => p.storeId === currentStore.id)) {
    for (const it of im.items || []) {
      if (it.recipeMapped) continue;
      const name = (it.menuItem || '').trim();
      const key = name.toLowerCase();
      if (!key) continue;
      const existing = map.get(key);
      if (existing) {
        // Server already counts the row; just attach a lastSeen.
        if (!existing.lastSeen || new Date(im.importedAt) > new Date(existing.lastSeen)) {
          existing.lastSeen = im.importedAt;
        }
      } else {
        map.set(key, { pos_name: name, rows: 1, lastSeen: im.importedAt });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => b.rows - a.rows);
}, [serverUnmapped, posImports, currentStore.id]);

// After any add/edit/remove that mutates aliases, bump refreshTick
// to re-fetch the server-side count. This makes a row that was just
// mapped disappear from UNMAPPED.LOG within the same render tick
// once the retroactive flip has run.
const triggerServerRefresh = () => setRefreshTick((n) => n + 1);
```

Notes:
- De-dup key is the lowercase-trim of the POS name. Display string
  is the server's canonical form (or the local form if server didn't
  return it).
- Server rows DON'T carry `lastSeen` (the helper at line 1480-1501
  groups by name and counts). Local rows DO. So `lastSeen` becomes
  optional in the merged shape — UI uses it where present.
- Sort by `rows` desc — matches the server fetch's existing sort.

### 10. Surface 1 — preview overrides survive the re-match `useEffect`

The existing `useEffect` at
[src/screens/cmd/sections/POSImportsSection.tsx:68-79](src/screens/cmd/sections/POSImportsSection.tsx)
re-runs `matchRecipe` whenever `recipes` or `posRecipeAliases`
changes. To keep user-confirmed overrides sticky, introduce a
parallel `previewOverrides: Record<number, RowMatch>` slice in
section-local state, keyed by row index. The re-match effect uses it
as a fallback ladder:

```ts
// src/screens/cmd/sections/POSImportsSection.tsx — replace the
// existing useEffect at lines 68-79
const [previewOverrides, setPreviewOverrides] = React.useState<
  Record<number, RowMatch>
>({});

React.useEffect(() => {
  if (!breadbotPreview) {
    setPreviewMatches([]);
    setPreviewOverrides({});  // reset overrides when preview clears
    return;
  }
  setPreviewMatches(
    breadbotPreview.rows.map((r, idx) => {
      // Override wins. If the user picked or cleared this row, keep
      // their choice; otherwise re-run matchRecipe.
      if (idx in previewOverrides) return previewOverrides[idx];
      const m = matchRecipe(r.menuItem, recipes, posRecipeAliases);
      return { recipeId: m.recipeId, matchType: m.matchType };
    }),
  );
}, [breadbotPreview, recipes, posRecipeAliases, previewOverrides]);
```

Picker `onPick` writes to both:
```ts
setPreviewOverrides((prev) => ({
  ...prev,
  [idx]: { recipeId, matchType: recipeId ? 'alias' : 'none' },
}));
```

The existing confirm path at lines 184-243 already reads
`previewMatches[idx]` for the items array AND alias upsert; no
change there.

### 11. Cross-store ("global") aliases — UI gate, not RLS gate

`pos_recipe_aliases.store_id` can be null (cross-store / "global").
Per spec line 184-192, the picker UI:

- Shows a "global" badge on confirmed-panel rows where
  `c.store_id === null`.
- Hides (not disables) the remove affordance on those rows.
- Picker writes always set `store_id = currentStore.id` — never null.
  The picker has no "make this global" affordance.

Why "hide" not "disable": disable is a discoverability lure ("can I
unlock this with admin?"); hide is an unambiguous "this is not your
operation". Matches the project's confirmAction → super_admin pattern.

**WARNING — this is UI-only.** As called out in §2 above, the
underlying RLS does NOT prevent a non-super-admin from DELETE-ing a
global alias via direct PostgREST. The fix for that is the follow-up
RLS-hardening spec, not this one.

### 12. Risks and tradeoffs

1. **RLS architectural drift on `pos_recipe_aliases` (§2).** UI
   guards only. Does not regress vs. status quo — the table has been
   in this state since pre-2026-05. Flagged for follow-up spec.
   Severity: low for this spec; medium for product overall.

2. **No realtime echo (§6).** Two admins editing aliases on the same
   store in different tabs won't see each other's changes until one
   of them refreshes. Acceptable today (admin workflows are usually
   single-user); follow-up if multi-tab admin usage grows.

3. **Local reconciliation in §7b is best-effort.** If the
   server-side `ilike` matches a row on a Unicode edge case that
   `.toLowerCase()` doesn't fold the same way, the in-session local
   slice will under-count vs. the server. Mitigation: on the next
   `loadFromSupabase` (login or store switch) the slice gets
   re-loaded from server. Worst case is a stale UI for the rest of
   the current session. Severity: very low (POS strings are ASCII
   in practice).

4. **`posImports` slice is not hydrated from server (§7).** Spec is
   already on the right side of this — Surface 3 explicitly uses the
   server fetch as canonical, with local derivation as augmentation.
   No regression introduced; but reviewers should know that the
   "Ghost rows" StatCard total (line 824) reflects only the current
   session's imports. Out of scope to fix here.

5. **Performance on 286 KB seed dataset.** All three surfaces
   operate on small sets:
   - Surface 1 picker: bounded by `recipes.length` (~50-200 rows in
     practice). Search filter is O(n) per keystroke, no debounce
     needed at this scale.
   - Surface 2 unmapped panel: bounded by 30 days of unmapped
     pos_names — typically <50 rows. Existing `fetchUnmappedPosImports`
     fetches up to 30 days of pos_import_items child rows, dedups
     client-side. At 100 imports/day × 20 items/import × 0.05 unmap
     rate = ~3000 rows over 30 days, ~150 distinct pos_names. Fine.
   - Surface 3 retroactive flip: server-side `ilike` + `in (importIds)`
     on a single recipe_mapped=false UPDATE. O(matched rows). Each
     UPDATE writes ≤ ~30 rows in practice. Bounded.

6. **Migration ordering.** N/A — no new migrations.

7. **Edge function cold start.** N/A — no edge functions touched.

### 13. Files the developer touches

Backend (additive):
- `src/lib/db.ts` — append `deletePosRecipeAlias` near line 1500.

Frontend:
- `src/store/useStore.ts` — add `removePosRecipeAlias` to interface
  + implementation; replace `applyAliasToPastImports` impl with the
  augmented version in §7b.
- `src/components/cmd/RecipePickerModal.tsx` — new file.
- `src/screens/cmd/sections/POSImportsSection.tsx` — wire picker
  into `BreadbotPreviewCard` (per-row pill becomes pressable +
  `previewOverrides` map), augment re-match `useEffect`, wire picker
  into `MappingTab` (unmapped row pressable, confirmed row edit +
  remove with `confirmAction`), add server fetch + merge logic for
  the unmapped panel, update empty-state copy.

No edge function changes. No migration changes. No `app.json`
changes. No realtime sync changes.

## Files changed

### Backend changes (backend-developer)

- `src/lib/db.ts` — added `deletePosRecipeAlias(storeId, posName)` helper
  immediately after `upsertPosRecipeAliases`. DELETE on
  `pos_recipe_aliases` keyed by `(store_id, pos_name)`. Throws on error
  (vs. the upsert helper's `console.warn`-only behavior) so the store
  action's optimistic-revert path fires.
- `src/store/useStore.ts`:
  - Added `removePosRecipeAlias: (posName: string) => Promise<void>` to
    the `AppState` interface beside the existing pos-alias actions.
  - Implemented `removePosRecipeAlias` action — optimistic-then-revert
    mirror of `removeOrderScheduleEntry`. Snapshots `posRecipeAliases`,
    filters out the matching `(store_id, pos_name)` row case-insensitive
    trim-match, calls the new db helper, reverts + `notifyBackendError`
    on backend failure. Skips when `storeId` or `posName` is empty.
  - Replaced `applyAliasToPastImports` impl with the augmented version
    per §7b. After the RPC returns N, when N > 0, walks
    `state.posImports` and patches matching `items[].menuItem` (case-
    insensitive trim-match against `posName`) to `recipeMapped: true`
    with the picked `recipeId`. Uses a `dirty` flag to preserve React
    reference equality on untouched items. Skips the walk entirely when
    N === 0.

Verified by direct PostgREST probe against the local stack: inserted a
test row into `pos_recipe_aliases`, called DELETE with the same
`(store_id, pos_name)` filter shape the helper uses, got HTTP 204, and
confirmed the row was gone via psql. Local-state walker logic was
mental-walked against a hypothetical N=5 case — `target` lowercase-trim
comparison mirrors Postgres `ilike` for ASCII POS strings (the typical
case); Unicode edge cases fall back to the next `loadFromSupabase` per
§12 risk 3.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. The backend
  scope is one additive helper (`deletePosRecipeAlias`) in
  `src/lib/db.ts` — see §3 and §5. The frontend scope is the new
  `RecipePickerModal` component, the per-surface wiring in
  `POSImportsSection.tsx`, the `removePosRecipeAlias` store
  action, and the augmented `applyAliasToPastImports` store
  action — see §7, §8, §9, §10, §11. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/015-pos-mapping-pickers.md

## Files changed

### Backend (already landed in parallel by backend-developer)

- `src/lib/db.ts` — added `deletePosRecipeAlias(storeId, posName)`
  helper near line 1483. Throws on error so the store action's
  optimistic-revert branch fires (intentional contrast with the
  existing `upsertPosRecipeAliases` which only console.warns).
  Filter on `store_id` is load-bearing: prevents accidentally
  deleting a global alias of the same `pos_name`.
- `src/store/useStore.ts`:
  - Interface declaration for `removePosRecipeAlias` at line 220.
  - Augmented `applyAliasToPastImports` (lines 1461-1496) with the
    local `posImports` reconciliation step from §7b — after the
    server-side ilike returns N, walk the slice and patch matching
    items to `recipeMapped: true` + `recipeId`.
  - New `removePosRecipeAlias` action (lines 1501-1521): snapshot
    + optimistic filter + DELETE + revert-on-throw via
    `notifyBackendError`. Mirrors `deleteVendor`.

### Frontend (this implementation)

- `src/components/cmd/RecipePickerModal.tsx` — NEW. Centered-overlay
  modal matching `FetchBreadbotModal` / `RunImportModal` shape.
  Props per architect §8: `visible, onClose, posName,
  currentRecipeId?, allowNoMatch?, onPick`. Reads `recipes`
  from the store internally. Search-as-you-type filter +
  alphabetical sort + optional "No match" entry + Escape-to-close
  (web) + backdrop tap close. testIDs:
  `posimport-cmd-picker-search`,
  `posimport-cmd-picker-recipe-{recipeId}`,
  `posimport-cmd-picker-none`, `posimport-cmd-picker-cancel`.
- `src/screens/cmd/sections/POSImportsSection.tsx`:
  - Section-local `previewOverrides` map + `pickerForIdx` state.
  - Re-match `useEffect` honors `previewOverrides` per architect §10
    so user-confirmed overrides survive subsequent re-matches.
  - `BreadbotPreviewCard`: per-row pill is now a `TouchableOpacity`
    with `onPickRow` callback; testID
    `posimport-cmd-row-picker-{idx}`. Pill renders a `▾` chevron
    so the affordance reads as pickable.
  - `RecipePickerModal` mounted at section level, opened via
    `pickerForIdx`. `allowNoMatch` is true here — picking "No match"
    sets `previewOverrides[idx] = { recipeId: null, matchType: 'none' }`.
  - `MappingTab` rewrite (~lines 880-1060):
    - Server fetch of `fetchUnmappedPosImports(storeId)` with
      `refreshTick` re-fetch after any add/edit/remove.
    - Merge logic per architect §9: server canonical for the 30-day
      count, local fills `lastSeen` and any post-fetch local-only names,
      key by lowercase-trim, sort by row count desc.
    - Unmapped row: `MAP…` button (testID
      `mapping-cmd-unmapped-pick-{posName}`) → opens picker → on pick:
      `upsertPosRecipeAliases` + `applyAliasToPastImports` →
      success toast wording per spec line 110-111
      (`Updated N past row(s).` if N > 0 else
      `Future imports will use this mapping.`) — does NOT imply
      inventory changed.
    - Confirmed row: per-row `EDIT` and `REMOVE` buttons (testIDs
      `mapping-cmd-alias-edit-{posName}` and
      `mapping-cmd-alias-remove-{posName}`). Edit re-opens picker
      with `currentRecipeId` set; remove uses `confirmAction`.
    - Per architect §11, global aliases (`store_id === null`)
      render a `GLOBAL` info badge and HIDE the remove button
      (not disabled). Edit is also hidden for global rows since
      the picker writes store-scoped only.
    - Empty-state copy on ACTIVE_ALIASES.TSV updated to drop the
      stale "confirm an unmapped row in imports.tsx review" pointer:
      now reads *"no aliases yet — tap an unmapped row to map it,
      or wait for auto-matches on the next import"*.
  - Picker mount inside `MappingTab` with `allowNoMatch={false}`
    (per spec §8: mapping.tsx never offers "No match" — the user
    just closes the modal).
- No edge function, RLS, or migration changes — purely additive
  client wiring on top of existing helpers, per architect §1, §3,
  §4, §6.

### Verification notes

- Browser `preview_*` MCP tooling is not available in this
  frontend-developer subagent context. Verification done via:
  - `npx tsc --noEmit` filtered to changed files: zero errors
    introduced (pre-existing repo-wide errors unchanged).
  - `curl http://localhost:8081/App.bundle?platform=web` confirms
    metro bundles successfully (HTTP 200, ~360k lines).
  - Bundle inspection confirms `RecipePickerModal` is imported and
    every spec-mandated testID
    (`posimport-cmd-picker-search`, `posimport-cmd-picker-recipe-{id}`,
    `posimport-cmd-picker-none`, `posimport-cmd-row-picker-{idx}`,
    `mapping-cmd-unmapped-pick-{posName}`,
    `mapping-cmd-alias-edit-{posName}`,
    `mapping-cmd-alias-remove-{posName}`) is emitted into the bundle.
- A reviewer with `preview_*` access (or the user) should run the
  manual verification probes from spec §"Manual verification probes"
  to exercise the three surfaces in the live UI.
