# Backend Architect — Post-Implementation Drift Review (Re-review after SF1/SF2/SF3)

**Spec:** 048 — Recipe Categories — Cmd UI management surface
**Mode:** Post-implementation drift re-review after code-reviewer SF1/SF2/SF3 fixes
**Reviewer:** backend-architect
**Verdict summary:** No backend drift detected. 0 Critical, 0 Should-fix, 2 Minor advisory notes (carried over from prior pass; both are pre-existing and out of scope here).

---

## Scope of this re-review

Code-reviewer raised three Should-fix items against the initial Spec 048
implementation:

- **SF1** — `RecipesSection.tsx` repeated the `TabStrip` tabs array at three
  call sites. Hoist into a single module-level constant.
- **SF2** — `RecipesSection.tsx`'s `!sel` empty-selection branch did not
  render the `TabStrip`, so a user with no recipe selected could not reach
  the new `categories.tsx` tab. Render the strip (without rightSlot) above
  the "select a recipe" message.
- **SF3** — `RecipeCategoriesSection.tsx`'s `handleDelete` re-summed the
  per-table counts (`recipeUsageCount + prepRecipeUsageCount`) for the
  block-on-use guard instead of reading the pre-summed `row.totalUsageCount`
  that the row column already displays. Read from `totalUsageCount` directly
  so the displayed column, the guard, and the toast all consult one source.

All three fixes are scoped as **frontend-only**. The architect's original
design (this agent, design mode) explicitly required: no migrations, no
`src/lib/db.ts` edits, no new store actions, no new RPC, no new edge
function, no realtime publication membership change. This re-review verifies
the prior "no backend drift" posture still holds after the three fixes
landed.

---

## Drift surface, point-by-point

### 1. Did SF1/SF2/SF3 add anything to `src/lib/db.ts`?

**No.** Verified:

- `grep` for `listRecipeCategoriesWithUsage` across the entire repo: zero
  matches.
- `grep` for `Spec 048|spec 048` against `src/lib/db.ts`: zero matches —
  the file was not edited as part of this spec or the fix-up pass.
- The five pre-existing helpers
  (`fetchRecipeCategories`, `addRecipeCategory`, `updateRecipeCategory`,
  `deleteRecipeCategory`, `updateRecipeCategoryI18n`) remain at their
  pre-spec line numbers
  ([src/lib/db.ts:1477, 1710, 1727, 1740, 1750](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts)).

Architect verdict: design honoured.

### 2. Did SF1/SF2/SF3 add anything to `src/store/useStore.ts`?

**No.** Verified:

- `grep` for `Spec 048|spec 048|recipe_categories` against
  `src/store/useStore.ts`: zero matches. The store file was not touched in
  the fix-up pass.
- The four pre-existing write actions
  (`addRecipeCategory`, `updateRecipeCategory`, `deleteRecipeCategory`,
  `setRecipeCategoryI18nNames`) at
  [src/store/useStore.ts:1163-1213](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts)
  are unchanged.

Architect verdict: design honoured.

### 3. Did SF1/SF2/SF3 land any migration under `supabase/migrations/` or any edge function under `supabase/functions/`?

**No.**

- Latest migration on disk remains `20260517060000_profiles_rls_sweep.sql`
  (dated 2026-05-17). No 2026-05-18 migration. The fix-up pass added zero
  SQL.
- Edge function count remains 11 (`eod-reminder-cron`,
  `fetch-breadbot-sales`, `breadbot-nightly-sync`, `staff-waste-log`,
  `staff-catalog`, `pwa-catalog`, `staff-eod-submit`, `send-invite-email`,
  `send-welcome-email`, `translate-on-save`, `delete-user`) — identical to
  pre-spec baseline. No new function, no edits to
  `supabase/config.toml`.

Architect verdict: design honoured.

### 4. Realtime publication membership unchanged after the fix-up pass?

**Yes — unchanged.** No migration was added in the fix-up pass, and the
existing `recipe_categories` posture (intentionally NOT in the
`supabase_realtime` publication, per the comment at
[supabase/migrations/20260517000000_user_data_i18n_names.sql:53-55](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517000000_user_data_i18n_names.sql))
stands. The realtime container restart gotcha (`docker restart
supabase_realtime_imr-inventory`) does not apply to this spec.

Architect verdict: design honoured.

### 5. Did the three fixes land where they were supposed to?

**Yes.** Verified all three textually:

- **SF1** — `RECIPE_TABS: Tab[]` constant hoisted at
  [RecipesSection.tsx:32-38](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipesSection.tsx).
  Three `TabStrip` call sites at lines 294, 308, 321 all pass
  `tabs={RECIPE_TABS}` instead of inline literals. Typed as `Tab[]` (not
  `as const`) per the in-spec verification note about `TS4104` against
  `TabStrip`'s mutable `Tab[]` prop. One source for the tabs array; adding
  a new tab is now a one-line edit.

- **SF2** — the `!sel` empty-selection branch at
  [RecipesSection.tsx:301-318](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipesSection.tsx)
  now renders `<TabStrip tabs={RECIPE_TABS} activeId={tabId}
  onChange={setTabId} />` above the empty-state message. `rightSlot` is
  intentionally omitted in this branch (the duplicate/delete/edit
  affordances only make sense with a selected recipe), and the `setTabId`
  setter is the same one used by the other two branches, so flipping to
  `categories.tsx` from the empty state works end-to-end.

- **SF3** — `handleDelete` at
  [RecipeCategoriesSection.tsx:229-258](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipeCategoriesSection.tsx)
  reads `const total = row?.totalUsageCount ?? 0;` and tests `if (total > 0)`
  for the block-on-use guard. The split counts (`recipeUsageCount`,
  `prepRecipeUsageCount`) are still pulled from the same `row` for the
  toast body, but the gate itself uses the pre-summed total. Single
  source: `sorted.find(...).totalUsageCount` is the same value the row's
  right-aligned count column reads at line 421.

Architect verdict: all three fixes implemented at the right files / lines
with no collateral edits to backend surfaces.

### 6. No-bypass-of-db.ts check after the fix-up pass

Re-grep across both edited frontend files for direct Supabase calls
(`supabase\.|\.from\(|\.rpc\(|fetch\(['"]/functions/v1/`): zero hits.
The mandatory `src/lib/db.ts` chokepoint is preserved. SF1/SF2/SF3 are
all pure JSX/TS-level refactors and did not reach for the network.

Architect verdict: design honoured.

---

## Findings ranked

### Critical
**None.**

### Should-fix
**None.**

### Minor

The two Minor advisory notes from the prior pass are carried over verbatim
because they are pre-existing and unaffected by the fix-up pass. Neither
requires action for this spec; both are flagged so they don't get lost.

**M1 — Pre-existing rename-cascade inconsistency, more visible now that the section exists.**
([architect design §6, useStore.ts:1183-1185](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts), 
[db.ts:1740-1748](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts))

`updateRecipeCategory` in the store optimistically rewrites
`recipes.category` text locally on rename, but `db.updateRecipeCategory`
does NOT cascade the rename to `recipes` server-side. On the next reload
the local rewrite reverts and recipes "snap back" to the old category
text. Knock-on:
- Usage count locally shows N=0 right after rename (recipes look re-tagged
  client-side).
- After reload, jumps back to N>0 because the server-side recipes still
  reference the old category text.
- Block-on-use guard then incorrectly blocks delete on the post-rename
  name when the user thought they'd migrated everything.

Flagged in the original design as out-of-scope; **not introduced by the
fix-up pass** and not a regression caused by SF1/SF2/SF3. Recommended
follow-up: either (a) cascade-rewrite in `db.updateRecipeCategory`, or
(b) drop the optimistic local rewrite in the store so displayed state
matches the server.

**M2 — `handleDelete` row-lookup fallback to zero remains fail-open.**
([RecipeCategoriesSection.tsx:236-239](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipeCategoriesSection.tsx))

`handleDelete` still does `const row = sorted.find((c) => c.name === name)`
and falls back to `0` via `?? 0` if the row is missing. SF3 made the guard
read `total = row?.totalUsageCount ?? 0` rather than re-summing, which
collapses three sources to one — that addresses what code-reviewer flagged.
The lookup-miss fail-open class remains: if a future refactor stops
including a category in `sorted` while still rendering its delete button,
the guard silently bypasses. Today this is purely defensive — the user
necessarily clicked the row's own delete button so the `find` always
matches.

The original design (line 451-466) sketched passing the row directly into
the handler:

```tsx
const handleDelete = (row) => {
  if (row.totalUsageCount > 0) { ... }
};
```

That shape eliminates the lookup-miss entirely, but the current
implementation is acceptable. **No action required.** Flagged so a future
refactor of the row-render boundary doesn't accidentally widen the blast
radius.

---

## What was checked (re-review pass, beyond the original pass)

Files inspected in this re-review:

- [specs/048-recipe-categories-cmd-ui.md](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/048-recipe-categories-cmd-ui.md) — Status: READY_FOR_REVIEW, the spec's `## Files changed` section enumerates the three SF fixes.
- [src/screens/cmd/sections/RecipesSection.tsx](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipesSection.tsx) — verified `RECIPE_TABS: Tab[]` constant at 32-38; verified three `TabStrip` call sites at 294, 308, 321 all use `tabs={RECIPE_TABS}`; verified SF2 branch at 301-318 renders the strip in the empty-selection state.
- [src/screens/cmd/sections/RecipeCategoriesSection.tsx](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/RecipeCategoriesSection.tsx) — verified SF3 `handleDelete` at 229-258 reads `total = row?.totalUsageCount ?? 0` and gates on `total > 0`.

Drift re-checks (delta from prior pass):

- `grep` for `listRecipeCategoriesWithUsage|Spec 048|spec 048` against
  `src/lib/db.ts`: zero matches. db.ts is unchanged.
- `grep` for `Spec 048|spec 048|recipe_categories` against
  `src/store/useStore.ts`: zero matches. useStore.ts is unchanged.
- Migration glob over `supabase/migrations/2026051*.sql`: latest remains
  `20260517060000_profiles_rls_sweep.sql`; no 2026-05-18 entry.
- Edge function glob: 11 functions, identical to prior pass.
- `recipe_categories` membership in `supabase_realtime` publication:
  unchanged (no migration added, the design-note comment at
  `20260517000000_user_data_i18n_names.sql:53-55` is still authoritative).
- Bypass-of-db.ts grep against
  `RecipeCategoriesSection.tsx`/`RecipesSection.tsx` for direct
  `supabase.` / `.from(` / `.rpc(` / `fetch('/functions/v1/`): zero hits.

All five backend-drift bullet points the dispatcher asked me to confirm
remain satisfied:

| Drift surface                                                                 | Status        |
|-------------------------------------------------------------------------------|---------------|
| No new `src/lib/db.ts` helpers                                                | Confirmed     |
| No new store actions in `src/store/useStore.ts`                               | Confirmed     |
| No migrations under `supabase/migrations/`                                    | Confirmed     |
| No edge function changes (`supabase/functions/`, `supabase/config.toml`)      | Confirmed     |
| No realtime publication membership changes                                    | Confirmed     |

---

## Handoff

next_agent: NONE
prompt: Architectural drift re-review complete after SF1/SF2/SF3 fixes. 0 Critical, 0 Should-fix, 2 Minor advisory notes carried over from the prior pass (both pre-existing, both out of scope here). No backend changes were made by the fix-up pass and none should have been per spec design; the prior "no backend drift" posture is unchanged.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/048-recipe-categories-cmd-ui/reviews/backend-architect.md
