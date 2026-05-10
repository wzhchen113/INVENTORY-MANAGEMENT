# Spec 015 — Backend-architect post-impl drift review

Mode: post-implementation drift review (read-only). Spec status NOT mutated.

Scope of inputs reviewed:
- `specs/015-pos-mapping-pickers.md` — Backend design §1-§13, Files-changed manifest.
- `src/components/cmd/RecipePickerModal.tsx` (new component)
- `src/screens/cmd/sections/POSImportsSection.tsx` (Surfaces 1, 2, 3 wiring)
- `src/lib/db.ts` lines 1478-1496 — `deletePosRecipeAlias`
- `src/store/useStore.ts` lines 215-220 — interface declaration; lines 1461-1521 — augmented `applyAliasToPastImports` and new `removePosRecipeAlias`.

Verdict: **No Critical findings. Implementation matches design.** Two Minor
spec/implementation alignment notes worth surfacing for the user. CSV-path
out-of-scope honored.

---

## Critical findings

None.

---

## Should-fix findings

None.

---

## Minor findings

### M1. Edit affordance hidden on global aliases — divergent from spec line 94 testID list

**Location:** `src/screens/cmd/sections/POSImportsSection.tsx` lines 1091-1112.

**Observation:** The implementation wraps the EDIT button in
`isGlobal ? <GLOBAL badge /> : <EDIT button />` — i.e. on rows where
`c.store_id === null`, the EDIT button is HIDDEN (replaced by the GLOBAL
info badge), so the testID `mapping-cmd-alias-edit-{posName}` is not
emitted for global aliases.

Spec acceptance criterion line 94 reads:

> testID: `mapping-cmd-unmapped-pick-{posName}` on each unmapped row,
> `mapping-cmd-alias-edit-{posName}` and
> `mapping-cmd-alias-remove-{posName}` on each confirmed row.

A strict reading of "each confirmed row" includes global rows. Spec §11
(Cross-store "global" aliases) explicitly addresses only the **remove**
affordance: "Hides (not disables) the remove affordance on those rows."
Edit is not mentioned in §11.

**Why it's defensible (not Should-fix):** §11 states "Picker writes
always set `store_id = currentStore.id` — never null. The picker has no
'make this global' affordance." If a user clicked EDIT on a global alias
and re-picked, the picker would silently create a store-scoped alias
shadowing the global — confusing UX. Hiding edit avoids that footgun and
is consistent with the §11 spirit ("not your operation").

**Recommendation:** Surface to the user. Either:
- Update spec line 94 to "on each store-scoped confirmed row" (or add
  parenthetical "edit hidden on global rows per §11"), so the testID
  contract matches reality.
- OR re-introduce EDIT for global rows with an in-picker affordance to
  warn "this will create a store-scoped override." Probably not worth
  the complexity in this spec.

This is purely a docs/contract alignment nit. The current implementation
is the safer behavior; recommend updating the spec rather than the code.

### M2. `upsertPosRecipeAliases` swallows errors — silent-failure path in `handlePickForUnmapped`

**Location:** `src/store/useStore.ts` lines 1454-1458 (existing code,
*not* changed by spec 015), and call site at
`src/screens/cmd/sections/POSImportsSection.tsx` lines 920-944.

**Observation:** `upsertPosRecipeAliases` in the store action only
`console.warn`s on backend error (line 1457) — it does NOT throw. The
new `handlePickForUnmapped` flow at line 920-944 awaits the upsert, then
awaits `applyAliasToPastImports`, with a single `catch` covering both.

Failure mode: if the alias upsert fails server-side (RLS denial,
network blip), the local optimistic state still shows the alias added;
`applyAliasToPastImports` then runs, returns 0 (no past rows match
because the alias was never persisted server-side); user sees the
success toast `Alias saved · Future imports will use this mapping.` —
but the alias is NOT actually persisted. Next session reload removes
the alias from the local slice (re-fetched from server).

**Severity rationale:** Pre-existing behavior of
`upsertPosRecipeAliases` (carried over from spec 014's confirm path at
POSImportsSection.tsx:236), not introduced by spec 015. The same
silent-failure pattern affects the existing Breadbot preview confirm
path (line 232-237) which the spec explicitly preserved as-is. Spec 015
inherits the bug rather than introducing it. The spec design §3 / §7c
calls out that the existing impl is reused unchanged, so this is on
spec by design.

**Recommendation:** Out-of-scope to fix in this spec. Worth a
follow-up spec to align `upsertPosRecipeAliases` with
`deletePosRecipeAlias`'s throw-on-error contract — at which point all
three optimistic paths (upsert / delete / past-imports flip) would
revert cleanly on backend failure. Spec 015's `deletePosRecipeAlias`
already follows the correct pattern; this is the only outlier in the
trio.

---

## Per-section verification against §1-§13

### §1 — Data model changes
**No new migrations.** Verified via the spec's migration manifest and
direct inspection of `src/lib/db.ts:1483-1496`. `deletePosRecipeAlias`
is a single DELETE on the existing `pos_recipe_aliases` table. No
schema drift.

### §2 — RLS impact
No new policies added. Inherits the existing legacy "any-authed-user"
RLS on `pos_recipe_aliases` per the spec's flagged architectural drift.
Spec correctly documented this as out-of-scope follow-up; UI guard on
global-alias remove is cosmetic (also documented). No regression vs.
status quo.

### §3 — API contract
PostgREST direct-table only. No new RPCs. No new edge functions.
`deletePosRecipeAlias` uses `.delete().eq('store_id', ...).eq('pos_name', ...)` —
matches the design's load-bearing dual filter that prevents deleting a
global alias of the same `pos_name`. Verified.

### §4 — Edge function changes
None. ✓

### §5 — `src/lib/db.ts` surface
One additive helper `deletePosRecipeAlias(storeId: string, posName: string)`.
Throws on error per design instruction (§3 "Throw, don't swallow"). No
existing helpers changed shape. ✓

### §6 — Realtime impact
No subscriptions added. No publication membership changes. No
`docker restart supabase_realtime_imr-inventory` step needed. ✓

### §7 — Frontend store impact
- §7a `removePosRecipeAlias` action: snapshot + optimistic filter +
  DELETE + revert-on-throw via `notifyBackendError`. Mirrors
  `removeOrderScheduleEntry` / `deleteVendor`. Filter is
  `(a.store_id === storeId && a.pos_name.trim().toLowerCase() === trimmed.toLowerCase())`
  — correctly preserves global aliases of the same `pos_name` from
  being collateral-removed. ✓
- §7b `applyAliasToPastImports` augmentation: walks `posImports.items`
  with case-insensitive trim-match, dirty flag for reference equality,
  `if (updated > 0)` short-circuit, patches `recipeMapped: true` and
  `recipeId`. ✓ All four design specifications met (§7b notes
  list).
- §7c `upsertPosRecipeAliases` unchanged. ✓ (See M2 above for the
  inherited silent-failure quirk; pre-existing.)

### §8 — `RecipePickerModal` prop shape
Props match exactly:
- `visible: boolean` ✓
- `onClose: () => void` ✓
- `posName: string` ✓
- `currentRecipeId?: string | null` ✓
- `allowNoMatch?: boolean` ✓
- `onPick: (recipeId: string | null) => void` ✓

Internal behavior:
- Reads `recipes` from store internally (line 49) — consumer doesn't
  pass the list ✓
- Search-as-you-type filter on `recipe.menuItem.toLowerCase().includes(q)` ✓
- Alphabetical sort case-insensitive ✓
- "No match" entry only when `allowNoMatch` ✓
- Escape-to-close gated by `Platform.OS === 'web'` ✓ (lines 58-68)
- Backdrop tap close ✓ (lines 82-84)
- Caller responsible for closing — modal does not auto-close on pick ✓
- testID `posimport-cmd-picker-search` ✓
- testID `posimport-cmd-picker-recipe-{recipeId}` ✓
- testID `posimport-cmd-picker-none` ✓
- Bonus testID `posimport-cmd-picker-cancel` (line 279) — additive,
  not in spec but harmless and useful for testing.
- Header shows "POS" pill + posName ✓ (lines 122-127)
- Sell-price sub-line for each recipe ✓ (lines 234-238)
- Cmd palette via `useCmdColors()` ✓
- Search input uses `C.panel2` + `C.borderStrong` (component comment
  notes these are the Cmd-palette equivalents of spec's
  `bgSecondary` + `borderMedium`; visually equivalent) ✓

Call-site behavior matches §8 table:
- Surface 1 picker: `posName=row.menuItem`, `currentRecipeId=previewMatches[idx]?.recipeId ?? null`,
  `allowNoMatch=true`, `onPick` writes to `previewOverrides[idx]`
  (POSImportsSection.tsx 380-396). ✓
- Surface 2 unmapped: `posName=u.pos_name`, no `currentRecipeId`,
  `allowNoMatch=false`, `onPick` calls `upsertPosRecipeAliases` then
  `applyAliasToPastImports` (920-944, 1167-1168). ✓
- Surface 2 confirmed edit: `posName=c.pos_name`, `currentRecipeId=c.recipe_id`,
  `allowNoMatch=false`, `onPick` calls only `upsertPosRecipeAliases`
  (950-967, 1169-1170). ✓

### §9 — `MappingTab` merge logic
Verified at POSImportsSection.tsx lines 843-916:
- `serverUnmapped` state (line 843) + `refreshTick` (line 844)
- Fetch effect with `cancelled` flag for unmount safety (lines 845-852) — additive
- `triggerServerRefresh` callback (line 853) bumps refreshTick
- `unmapped` `useMemo` (lines 889-916):
  - Layer A — server canonical (lines 891-896): keys by lowercase-trim,
    skips empty, takes server count
  - Layer B — local augments + adds (lines 897-914): same key,
    attaches `lastSeen`, adds local-only names
- Sort by `rows` desc (line 915) ✓
- `triggerServerRefresh` is called from `handlePickForUnmapped` `finally`
  block (line 942) — re-fetch after any add ✓
- `removePosRecipeAlias` does NOT call `triggerServerRefresh`. Acceptable:
  remove only mutates `pos_recipe_aliases`, not `pos_import_items`, so
  the unmapped panel doesn't change as a result of removing an alias.
  The confirmed panel re-renders from the locally-mutated `aliases`
  slice. ✓

### §10 — Surface 1 preview overrides survive re-match useEffect
Verified at POSImportsSection.tsx lines 67, 78-91:
- `previewOverrides: Record<number, RowMatch>` state (line 67)
- Fallback ladder in re-match useEffect (lines 84-89): `idx in
  previewOverrides ? previewOverrides[idx] : matchRecipe(...)` ✓
- Resets `previewOverrides({})` when preview clears (line 81) ✓
- Resets when single-fetch lands (line 365) ✓
- Resets when backfill completes (line 372) ✓
- Resets after confirm import (line 246) ✓
- `onCancel` callback in `BreadbotPreviewCard` clears overrides (line 193) ✓
- Picker `onPick` writes to overrides (lines 389-393) ✓

### §11 — Cross-store ("global") aliases UI gate
Verified at POSImportsSection.tsx lines 867-870, 1076-1132:
- Visible aliases include both `store_id === currentStore.id` and
  `store_id === null` (lines 867-870) ✓
- `GLOBAL` badge rendered for `c.store_id === null` (lines 1076-1090)
  using `C.info` / `C.infoBg` ✓
- Remove affordance HIDDEN (not disabled) for global rows (lines
  1115-1132 wrapped in `!isGlobal ? ... : null`) ✓
- Picker writes always set `store_id = currentStore.id` — verified via
  `upsertPosRecipeAliases` store action (line 1440 of useStore.ts)
  injecting `currentStore.id` into the payload ✓

See M1 above for the EDIT-affordance variance.

### §12 — Risks and tradeoffs
All five risks remain accurate as documented; no implementation
escalated severity.

### §13 — Files the developer touched
Manifest matches the spec's "Files changed" section verbatim. ✓

---

## Out-of-scope honored

CSV-path per-row picker (spec lines 165-172): Honored. The CSV upload
flow at POSImportsSection.tsx 335-351 still routes through
`UploadCsvModal` → `RunImportModal` operating on inventory diff rows,
not POS sales rows. No `RecipePickerModal` integration in that path.
Unmapped CSV-uploaded rows still benefit from Surfaces 2 and 3 once
they land in `pos_import_items`. ✓

Toast/Square/Clover connector wiring (spec 173-175): Honored.
`SourcesTab` still renders "NOT YET WIRED" placeholder
(POSImportsSection.tsx 1180-1199). ✓

Inventory deduction retroactivity (spec 176-179): Honored. Toast
wording in `handlePickForUnmapped` matches spec line 110-111 verbatim:
`Updated N past row(s).` if N > 0 else `Future imports will use this
mapping.` — does NOT imply inventory was changed. ✓

---

## Summary

Implementation matches design. Optimistic-then-revert pattern correctly
followed for `removePosRecipeAlias`. Augmented `applyAliasToPastImports`
walks `posImports` with the case-insensitive trim-match + dirty flag +
short-circuit per §7b. `RecipePickerModal` prop shape and behavior
exact match to §8. `MappingTab` merge logic matches §9. Surface 1
override fallback ladder matches §10. Global alias UI guards match §11
modulo the M1 EDIT-affordance variance (defensible, recommend spec
update over code change).

No Critical findings. No Should-fix findings. Two Minor findings (M1
EDIT testID gap on global rows, M2 inherited silent-failure on upsert)
— neither blocking, both recommend follow-up spec rather than rework.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor.
payload_paths:
  - specs/015-pos-mapping-pickers/reviews/backend-architect.md
