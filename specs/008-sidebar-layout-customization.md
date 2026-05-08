# Spec 008: Sidebar layout customization

Status: READY_FOR_REVIEW

## User story

As an admin using the Cmd UI desktop sidebar, I want a button that lets me
organize/lay out the sidebar pages so that the tools I use most are arranged
the way I want, instead of being stuck with the hardcoded order.

## Background

The Cmd UI sidebar is currently a hardcoded `groups` array in
[src/screens/cmd/InventoryDesktopLayout.tsx:135-170](../src/screens/cmd/InventoryDesktopLayout.tsx)
with 17 items in 3 groups (`Operations`, `Planning`, `Insights`). Items have
been added recently (`Categories` in spec 004, `Order schedule` in spec 007)
and more are expected during the current Cmd UI build-out, so the list is
actively evolving.

The sidebar rendering surface is the existing
[src/components/cmd/Sidebar.tsx](../src/components/cmd/Sidebar.tsx) (takes
`groups: SidebarGroup[]`) which renders [TreeGroup](../src/components/cmd/TreeGroup.tsx)
for each group. Both components are reusable and unchanged for this feature
beyond minor prop additions.

The natural persistence home is the existing `profiles` table, which already
stores per-user preferences (`profiles.dark_mode` is the precedent — see
CLAUDE.md "Theming"). Reads/writes follow the existing
optimistic-then-revert + `notifyBackendError` pattern via `src/lib/db.ts`.

## Acceptance criteria

> All of the below are blocked on resolving the open questions in the next
> section. Architect should treat the criteria as a sketch and finalize them
> after the user answers Q1–Q10. Each criterion is marked `[needs Qn]` where
> the answer changes the wording.

- [ ] **[needs Q4]** A visible control on the Cmd UI sidebar opens an
      "organize sidebar" mode (exact placement TBD: gear icon at top,
      footer-row button next to "sign out", new Settings tree item, or ⌘P
      palette command).
- [ ] **[needs Q5]** In organize mode, the user can change the order of
      sidebar items.
- [ ] **[needs Q1]** The reorder respects the chosen scope (within-group
      only, across groups, or full group editor).
- [ ] **[needs Q2]** The user can hide/show items (or this capability is
      explicitly out of scope, per Q2).
- [ ] **[needs Q3]** The customization persists per the chosen scope
      (per-user via `profiles`, brand-wide, per-store, or both).
- [ ] **[needs Q6]** A "restore default order" control exists in organize
      mode (or is explicitly out of scope, per Q6).
- [ ] **[needs Q7]** When new sidebar items are added in future specs they
      either auto-append to their default group (override-list model) or
      stay hidden until the user re-opens organize mode (snapshot model).
- [ ] **[needs Q8]** Customization is available on the platforms specified
      (web only or web + native).
- [ ] On exit from organize mode, the sidebar reflects the saved layout
      immediately (no full page reload).
- [ ] The selected `section` state from `InventoryDesktopLayout` is preserved
      across organize-mode entry/exit — switching to organize mode does not
      lose the user's current section pane.
- [ ] The customization is applied to the existing `Sidebar` /
      `TreeGroup` components without forking them or duplicating their
      rendering logic ("no dupes / utilize existing").
- [ ] All DB access goes through `src/lib/db.ts`; the store update follows
      the optimistic-then-revert + `notifyBackendError` pattern in
      `src/store/useStore.ts`. Legacy stores
      (`useSupabaseStore.ts`, `useJsonServerSync.ts`) are not modified.
- [ ] `src/screens/AdminScreens.tsx` is not modified.
- [ ] `app.json` `slug` is not modified.
- [ ] **[needs Q10]** Keyboard accessibility for reorder works as specified
      (architect picks implementation if Q10 = yes).
- [ ] If a `staff`-style restricted-item rendering is needed (the existing
      `TreeItem.restricted` flag), it is reused, not re-implemented.

## In scope

- A control on the Cmd UI sidebar that toggles an organize/edit mode.
- Reordering of sidebar items (exact mechanic — DnD vs modal — TBD by Q5).
- Persistence of the user's customized layout (scope TBD by Q3).
- A "restore default order" affordance (TBD by Q6).
- Wiring the customized layout into the existing
  [Sidebar.tsx](../src/components/cmd/Sidebar.tsx) `groups` prop in
  [InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx)
  so customization is invisible to the sections themselves.
- Migration adding the persistence column to `profiles` (or wherever Q3
  lands) following the `supabase/migrations/` timestamp convention.

## Out of scope (explicitly)

- **Renaming groups or adding/removing groups** — unless Q1 = (c). PM lean
  is (b) cross-group reorder without a group editor.
- **Renaming individual items.** "Menu items / BOM" stays "Menu items / BOM".
  Out of scope unless explicitly requested.
- **Per-section sub-tab reordering** (e.g., reordering the
  `detail.tsx / usage.tsx / audit.tsx / recipes.tsv` tab strip inside
  Inventory). This spec is about the sidebar nav only.
- **Mobile drawer (`InventoryListScreen`) reordering.** Mobile uses a
  different navigation surface. Out of scope unless Q8 says native is in.
- **Sharing a layout across users (export/import)**. Even if Q3 = (a)
  per-user, we do not ship a "copy my layout to another admin" flow.
- **A11y audit beyond keyboard reorder (Q10).** Screen-reader review and
  full WCAG conformance for the new edit mode are out of scope here; can
  be a follow-up spec if needed.
- **The legacy `AdminScreens.tsx` sidebar** (if any) — that file is frozen.
- **Modifying the `Sidebar` / `TreeGroup` visual design.** Edit-mode
  affordances (drag handles, hide toggles, etc.) are additive and must not
  change the default rendering when not in edit mode.

## Open questions (UNRESOLVED — block READY_FOR_ARCH)

Q1. **Scope of reorder.** (a) within-group only / (b) across groups too /
    (c) full editor (rename + add/remove groups)?
    *PM lean:* (b).

Q2. **Hide/show items.** (a) yes, hide/show items in addition to reorder /
    (b) no, all items always visible?
    *PM lean:* (a).

Q3. **Persistence scope.** (a) per-user / (b) shared brand-wide /
    (c) per-store / (d) per-user with brand-default override?
    *PM lean:* (a) per-user. Sidebars are personal preference.

Q4. **Where does the organize button live?** (a) gear icon at sidebar top /
    (b) footer button next to "sign out" / (c) new Settings tree item /
    (d) ⌘P palette command only?
    *PM lean:* (a) or (b) — user picks.

Q5. **Edit-mode UX.** (a) inline drag-and-drop with a "done" exit (likely
    needs a DnD library — `dnd-kit` or HTML5 native; `react-beautiful-dnd`
    is unmaintained) / (b) modal/drawer with up/down arrows + checkboxes?
    *PM lean:* (a) for the Cmd UI feel; (b) is cheaper.

Q6. **Reset to default.** (a) yes, prominent in edit mode / (b) no?
    *PM lean:* (a).

Q7. **What's saved.** (a) override list — only changed items persist;
    future spec-added items auto-append to default group / (b) full
    snapshot — entire ordered list with hide flags; future items invisible
    until user re-edits?
    *PM lean:* (a) — better fit for the active build-out period.

Q8. **Platforms.** (a) web only (Cmd UI is desktop-first) / (b) web + native?
    *PM lean:* (a) web only.

Q9. **Multi-user-edit conflicts.** Only relevant if Q3 ≠ (a). If Q3 = (a)
    per-user, this question is moot.

Q10. **Keyboard accessibility for reorder.** (a) yes, arrow-key reorder is
     a hard requirement / (b) no, DnD-only is fine for v1?
     *PM lean:* (a) yes — but architect picks the mechanic.

## Open questions resolved

Locked 2026-05-08 by user — ratified all 10 PM-recommended defaults as
written.

- **Q1 = (b) reorder across groups.** Drag items between OPERATIONS /
  PLANNING / INSIGHTS, not just within one group.
- **Q2 = (a) hide/show items.** In addition to reorder, user can hide
  items they never use.
- **Q3 = (a) per-user persistence.** Each admin's layout is their own;
  new admins start with the hardcoded default; no team collisions.
- **Q4 = (a) gear icon at sidebar top.** Small ⚙ button next to
  "im.cmd / v2.4". Click to enter edit mode. Architect picks the
  exact icon affordance / pixel placement.
- **Q5 = (a) inline drag-and-drop with "done" exit.** Clicking the
  gear puts the sidebar into edit mode; items get drag handles; user
  drags to reorder + click hide-icons; click "done" to exit and
  persist. Architect picks the DnD library — `dnd-kit` is the lean,
  modern, accessibility-focused option that supports both pointer +
  keyboard out of the box. `react-beautiful-dnd` is unmaintained;
  HTML5 native DnD is rough on mobile/touch.
- **Q6 = (a) reset to default.** Prominent button in edit mode that
  reverts the user's customization to the hardcoded default.
- **Q7 = (a) override list.** Only the items the user moved or hid
  get persisted (as deltas from default). Future spec-added items
  auto-append to their default group rather than being invisible
  until the user re-edits — important during the active Cmd UI
  build-out period.
- **Q8 = (a) web only.** Native sidebar UX is a different problem
  (drawer not always visible); ship web-first, defer native to a
  future spec.
- **Q9 = N/A.** Q3=(a) per-user means no two admins editing the same
  data; no conflict to handle.
- **Q10 = (a) keyboard accessibility yes.** Arrow keys move the
  focused item up/down in edit mode. Architect picks the mechanic;
  `dnd-kit` handles this natively with the `KeyboardSensor` if Q5=(a)
  goes that way.

### Pinned scope shape (architect's contract)

- **Storage.** New JSON column on the existing `profiles` table (e.g.,
  `sidebar_layout jsonb`) holding the user's override list. Architect
  to confirm this is the cleanest home vs. a sibling table. No new
  table required; "no dupes" rule applies.
- **State.** New slice on `useStore` (e.g., `sidebarLayoutOverride`)
  populated from `profiles.sidebar_layout` on login, mutated by edit
  actions, persisted via existing `setDarkMode`-style write pattern.
- **UI surface.**
  - `src/components/cmd/Sidebar.tsx` — render-side: takes the raw
    hardcoded default groups + the user's override list, applies
    overrides, renders. Edit-mode toggle wires up DnD.
  - `src/screens/cmd/InventoryDesktopLayout.tsx` — the existing
    hardcoded `groups` array stays as the *default*; passes both
    default + override list down to Sidebar.
  - New: gear icon button in the sidebar header. New: "done" + "reset
    to default" buttons in edit mode (architect picks placement).
  - Reuse `TreeGroup.tsx`'s existing `restricted` flag pattern for the
    visual treatment of hidden items in edit mode (strikethrough +
    opacity), unless architect proposes a different "hidden" affordance.
- **Override-list shape.** Architect proposes (e.g., flat array of
  `{itemId, groupOverride?, orderIndex, hidden?}` entries OR full
  ordered group structure with selective overrides). Either works;
  architect picks based on read/write ergonomics.
- **DnD library.** `dnd-kit` is the strong recommendation. Architect
  picks; if a different lib is chosen, document why.
- **Realtime.** Per-user data, no cross-user broadcast needed.
  `profiles` is not in the brand realtime channel today; no
  publication change.

## Dependencies

- **Existing components:** `src/components/cmd/Sidebar.tsx`,
  `src/components/cmd/TreeGroup.tsx`. Reuse, don't fork.
- **Existing store / data layer:** add a slice to
  `src/store/useStore.ts` next to `setDarkMode`, persisting through
  `src/lib/db.ts`.
- **Persistence target:** likely a new column on `profiles` (TBD by Q3).
  If Q3 = (b) brand-wide, need a different table — architect to specify.
  Migration will live in `supabase/migrations/` with the next available
  timestamp.
- **Realtime:** any per-user preference table that already publishes via
  realtime should keep doing so. If `profiles` is not on the publication,
  this spec does NOT add it (out of scope; layout is single-user-edited).
- **DnD library (only if Q5 = (a)):** architect picks (`@dnd-kit/core` is
  the modern, maintained option for React; HTML5 native drag would be
  zero-dep but is awkward on react-native-web). Adding a dependency is
  the architect's call — surface in design doc.
- **No existing test framework** — per CLAUDE.md, no jest/vitest is wired
  up. If `test-engineer` wants tests for the reorder logic, they'll need
  to introduce one. Flag for the test-engineer review pass.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. The button and edit mode live
  in the existing [Sidebar.tsx](../src/components/cmd/Sidebar.tsx) /
  [InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx).
  `AdminScreens.tsx` is **not** touched.
- **Per-store or admin-global:** TBD — see Q3. PM lean is per-user
  (neither store-scoped nor brand-global).
- **Realtime channels touched:** none expected. If Q3 = (a) per-user, the
  user's own client is the only writer; no cross-client realtime needed.
  Other realtime channels (`store-{id}`, `brand-{id}`) are unaffected.
- **Migrations needed:** yes — likely one column on `profiles` (or new
  table per Q3). Architect to specify.
- **Edge functions touched:** none expected. The save path is a normal
  PostgREST update on the user's own `profiles` row, gated by the existing
  RLS that lets a user write their own row.
- **Web/native scope:** TBD — see Q8. PM lean is web only.
- **`app.json` slug:** **not** modified. The spec does not touch build
  identifiers, app store listings, or push cert config.
- **Tests:** flag for test-engineer — no test framework exists. Reorder
  + persistence logic is a natural fit for a unit test if one gets wired
  up; otherwise review-only.
- **Legacy stores not modified:** `useSupabaseStore.ts`,
  `useJsonServerSync.ts`, `db.json`, the `npm run db` script — all
  untouched per CLAUDE.md "Data layer (active vs. legacy)".

## Backend design

> Authored 2026-05-08 by `backend-architect`. Probes run against the active
> repo `supabase/migrations/` history and the live Cmd UI surfaces named in
> the spec. Latest applied migration is `20260507214842_spec007_order_schedule_unique.sql`;
> spec 008's migration must sort after it.

### §0 — Probe results (certification)

The architect's "probe-execution plan" was satisfied by reading the migration
history + active code rather than running ad-hoc SQL, since this design is
purely additive on `profiles` and the migration files are the source of truth
for shape. Findings:

1. **`profiles` schema.** Defined in
   [`supabase/migrations/20260405000759_init_schema.sql:20-28`](../supabase/migrations/20260405000759_init_schema.sql)
   with later additions:
   - `dark_mode boolean` — added pre-prod-pull, referenced by
     [`src/lib/auth.ts:73`](../src/lib/auth.ts).
   - `nickname text default ''` — added in
     [`20260502071736_remote_schema.sql:147`](../supabase/migrations/20260502071736_remote_schema.sql).
   - `notifications_enabled boolean` — referenced by
     [`src/lib/auth.ts:70`](../src/lib/auth.ts) (default-true semantic).
   No existing `jsonb` column on `profiles`. Adding one is additive and safe.

2. **`profiles` RLS.** Confirmed in
   [`20260502071736_remote_schema.sql:372-422`](../supabase/migrations/20260502071736_remote_schema.sql).
   Five row-level policies, all keyed on the row identity (`id = auth.uid()`)
   or the admin/master JWT claim. **A new column inherits these row-level
   policies — RLS is row-scoped, not column-scoped.** No new policy work is
   required for this spec.

3. **`profiles` row count.** Not probed (informational only). Even at thousands
   of rows the migration cost is trivial: a nullable `jsonb` column add with
   no default is metadata-only in PG 17 — no table rewrite, no row touch.

4. **Existing surfaces (verified file-by-file).**
   - [`src/components/cmd/Sidebar.tsx`](../src/components/cmd/Sidebar.tsx)
     (134 lines) — takes `groups: SidebarGroup[]` and renders `TreeGroup` per
     group. Header has the `im.cmd / v2.4` row with a free flex slot
     (line 72: `<View style={{ flex: 1 }} />`) — that's where the gear icon
     lands without touching layout math.
   - [`src/components/cmd/TreeGroup.tsx`](../src/components/cmd/TreeGroup.tsx)
     (89 lines) — already supports `restricted` (strikethrough + opacity 0.42)
     on `TreeItem`. We **do NOT reuse `restricted`** for the user-hidden
     case: `restricted` semantically means "you cannot click this", whereas
     a hidden item in edit mode is still clickable (hide-toggle and drag).
     New flag: `hiddenByUser?: boolean` on `TreeItem`, with a different
     visual treatment (eye-off icon + opacity 0.55, no strikethrough).
   - [`src/screens/cmd/InventoryDesktopLayout.tsx:135-170`](../src/screens/cmd/InventoryDesktopLayout.tsx)
     — hosts the hardcoded `groups` array (3 groups, 17 items, one of them
     `DBInspector` with a custom `onPress` that breaks out of the section
     state machine). The custom `onPress` matters for §7 below.

5. **DnD library inventory.** `package.json` has zero DnD libraries —
   not `dnd-kit`, not `react-beautiful-dnd`, not `react-dnd`. No prior
   art to reuse. Adding `dnd-kit` is a net-new dependency.

6. **Realtime publication.** `profiles` is not on the `supabase_realtime`
   publication today (verified by absence of any `alter publication
   supabase_realtime add table profiles` in the migration history). This
   spec does NOT add it. The publication-membership gotcha is therefore
   **not applicable** — no `docker restart supabase_realtime_imr-inventory`
   step needed.

7. **Edge functions.** None touched. `verify_jwt` config unchanged.

### §1 — Schema change

**Migration filename:** `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql`
(timestamp must sort after `20260507214842`; the chosen value is the next
clean increment given today's date 2026-05-08).

**Body** (architect signature; developer authors the actual SQL):

```sql
-- Spec 008 §1: per-user sidebar layout override.
-- Adds a nullable jsonb column to profiles. NULL means "use the
-- hardcoded default groups array verbatim" — uncustomized invariant.
-- Non-null is the override list shape documented in §2 below.
--
-- Additive, metadata-only, no backfill, no policy change. Inherits
-- the existing profiles row-level policies (id = auth.uid() for users;
-- admin/master JWT bypass). RLS is row-scoped — adding a column does
-- not require new policies.

alter table public.profiles
  add column if not exists sidebar_layout jsonb;

comment on column public.profiles.sidebar_layout is
  'Spec 008: per-user Cmd UI sidebar override list. NULL = use default. Shape: { items: [{ id, group, order, hidden }, ...] }. See specs/008-sidebar-layout-customization.md §2.';
```

**Rollout safety:**
- Column is nullable with no default → metadata-only, instant, no row rewrite.
- No DROP, no constraint change, no index — fully rollback-safe via a
  matching `alter table ... drop column sidebar_layout` if the feature is
  reverted (acceptable destructive: it would erase user customization,
  but that's the explicit rollback semantic).
- No `pg_dump` or seed update needed; `supabase/seed.sql` does not
  populate `profiles.sidebar_layout` and the NULL default keeps the seed
  re-import working.

### §2 — Override-list JSON shape

**Decision: PM-recommended option (a) — flat override list.** Rationale:
Q7=(a) "future spec-added items auto-append to default group" is the
load-bearing constraint, and option (a) makes it trivial — items not
present in the override list inherit their default position. Option (b)
(full ordered structure) requires every render to merge a snapshot
against the current default, which couples future spec additions to a
schema migration.

**Stored shape** (column `profiles.sidebar_layout`):

```jsonc
{
  "v": 1,
  "items": [
    { "id": "Inventory",  "group": "Operations", "order": 0, "hidden": false },
    { "id": "Reports",    "group": "Operations", "order": 4 },                 // moved cross-group
    { "id": "DBInspector", "hidden": true }                                    // hide-only override
  ]
}
```

**Field contract:**
- `v: number` — schema version. v1 for this spec. Any future shape
  change bumps this; readers that don't recognize `v` fall back to
  the default groups (treat as if `sidebar_layout = NULL`).
- `items: Array<{...}>` — user's override list. **One entry per
  customized item.** Items not present here inherit default
  position + visibility.
- `id: string` — matches the hardcoded `TreeItem.id` in
  `InventoryDesktopLayout.tsx`. Stable across releases (don't rename
  ids casually — they're load-bearing for migration).
- `group?: string` — optional. Present iff the user moved this item
  to a different group than the default. Value is the group label
  ("Operations" | "Planning" | "Insights"). Absent → keep default
  group.
- `order?: number` — optional. Present iff the user reordered.
  Integer; lower = higher in list within its group. Absent → keep
  default order. **The merge algorithm normalizes orders during
  render — the stored numbers don't have to be contiguous, just
  ordered.**
- `hidden?: boolean` — optional. Present and `true` iff the user
  hid this item. Absent or `false` → visible.

**Invariants enforced at render time, not at write time:**
- An override entry with no `group`, no `order`, and no `hidden:true`
  is meaningless and should be elided on save (cleanup pass in the
  store action).
- Stale entries (referencing an `id` that's no longer in the
  hardcoded default — e.g., a future spec deleted the item) are
  silently dropped during merge.

**TypeScript type** (lives in `src/types/index.ts`):

```typescript
export interface SidebarLayoutOverrideEntry {
  id: string;
  group?: string;
  order?: number;
  hidden?: boolean;
}

export interface SidebarLayoutOverride {
  v: 1;
  items: SidebarLayoutOverrideEntry[];
}
```

### §3 — Read contract

**Hooked into the existing `fetchProfile` path** at
[`src/lib/auth.ts:41-74`](../src/lib/auth.ts). Same place that already
returns `darkMode`. `select('*')` returns the new column for free.

Extend `AuthResult`:

```typescript
export interface AuthResult {
  user: User | null;
  error: string | null;
  darkMode?: boolean;
  /** Spec 008: per-user sidebar override list. NULL/undefined = use default. */
  sidebarLayout?: SidebarLayoutOverride | null;
}
```

`fetchProfile` returns:

```typescript
return {
  user,
  error: null,
  darkMode: !!profile.dark_mode,
  // Defensive: only return well-formed override; treat anything else as null
  // so the UI falls back to the hardcoded default.
  sidebarLayout: isValidOverride(profile.sidebar_layout) ? profile.sidebar_layout : null,
};
```

`isValidOverride` is a tiny shape guard (lives in `src/lib/db.ts` or
inline in `auth.ts`): checks `v === 1` and `Array.isArray(items)`.

**Boot/login wiring** in [`App.tsx:151-157`](../App.tsx) and
[`useStore.ts:204-220` (`login` action)](../src/store/useStore.ts):
the login path already calls `setDarkMode(result.darkMode)`. Add a
parallel `setSidebarLayoutOverride(result.sidebarLayout)` line. No
local cache (unlike `darkMode`'s `localStorage` cache) — the sidebar
chrome is rendered post-login, after `loadFromSupabase` resolves, so
there's no first-paint flicker problem to solve.

### §4 — Write contracts

Three write paths, all per-user, all targeting the user's own `profiles`
row (`id = auth.uid()`), all gated by the existing UPDATE policy
"Users can update own profile".

**(1) Save edit-mode result.** Single write, full override list. Called
on "done" click (PM lean: save-on-done, NOT auto-save per edit — fewer
writes, clearer "atomic" semantics for the user, and matches the
"only on done" expectation in spec §10 / the user-ratified Q5).

```typescript
// src/lib/db.ts
export async function saveSidebarLayout(
  userId: string,
  layout: SidebarLayoutOverride | null,
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ sidebar_layout: layout })
    .eq('id', userId);
  if (error) throw error;
}
```

**(2) Reset to default.** `saveSidebarLayout(userId, null)`. Same call,
sentinel value. No separate helper needed.

**(3) Auto-save vs save-on-done.** Decision: save-on-done. Reasons:
- Smaller write traffic (1 UPDATE per session vs N per drag).
- Clearer atomicity: user sees "done" as the commit point.
- "Reset to default" + "Cancel" semantics are cleaner — discarding
  in-flight edits is just dropping local state, not rolling back DB.

**Optimistic + revert pattern.** Mirrors `setDarkMode` /
`addOrderScheduleEntry`:

```typescript
// useStore action sketch
setSidebarLayoutOverride: (override) => {
  const prev = get().sidebarLayoutOverride;
  set({ sidebarLayoutOverride: override });
  const userId = get().currentUser?.id;
  if (!userId) return; // not logged in — local-only
  db.saveSidebarLayout(userId, override).catch((e: any) => {
    set({ sidebarLayoutOverride: prev });
    notifyBackendError('Save sidebar layout', e);
  });
},
```

### §5 — DnD library choice

**Decision: `@dnd-kit` (PM recommendation confirmed).**

Sub-packages required:
- `@dnd-kit/core` — DndContext, DragOverlay, sensors. Required.
- `@dnd-kit/sortable` — SortableContext + useSortable hook for the
  list semantics we need (cross-group reorder is `verticalListSortingStrategy`
  per group, with shared DndContext to allow drag-across).
- `@dnd-kit/utilities` — `CSS.Transform.toString()` helper for
  applying drag transforms. Tiny but commonly co-installed.

**NOT** required:
- `@dnd-kit/modifiers` — only needed for restrictTo* helpers we don't
  use here. Skip.
- `@dnd-kit/accessibility` — already bundled in `@dnd-kit/core`.

**Bundle-size note** (rough, from upstream): core ~10kb gz, sortable
~5kb gz, utilities ~1kb gz. ~16kb gz net new in the web bundle. Native
build is unaffected — the import is gated behind a `Platform.OS === 'web'`
check (per Q8 = web only).

**Web-only import strategy.** `dnd-kit` is React-DOM-only (it consumes
`HTMLElement`s, not `View`s). To prevent native build breakage:
- Sidebar accepts an optional `editMode: boolean` prop. The DnD
  scaffolding lives in a sibling component, e.g.
  `src/components/cmd/SidebarEditMode.tsx`, that is dynamically
  imported only when `editMode === true && Platform.OS === 'web'`.
- Or simpler: the file uses a top-level `Platform.OS === 'web'` guard
  with a Metro-friendly conditional require. Architect's preferred
  pattern: the dynamic import — Metro handles `import()` via Babel
  and tree-shakes the native bundle.

### §6 — Frontend boundaries (per file)

| File | Change | Owner |
|---|---|---|
| `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql` | New file. Body in §1. | backend-developer |
| `src/types/index.ts` | Add `SidebarLayoutOverride` + `SidebarLayoutOverrideEntry` types (§2). | backend-developer |
| `src/lib/auth.ts` | Extend `AuthResult` with `sidebarLayout`; have `fetchProfile` return it (§3). | backend-developer |
| `src/lib/db.ts` | Add `saveSidebarLayout(userId, layout)` helper (§4). | backend-developer |
| `src/store/useStore.ts` | Add slice `sidebarLayoutOverride: SidebarLayoutOverride \| null` (initial `null`); add action `setSidebarLayoutOverride` (optimistic-then-revert per §4); wire `login` action to apply `result.sidebarLayout`. | backend-developer |
| `App.tsx` | In the session-restore effect, after `setDarkMode`, also apply the loaded override via the new action. | backend-developer |
| `src/components/cmd/TreeGroup.tsx` | Add `editMode?: boolean` prop. When true, render drag handle (left), eye/eye-off toggle (right), suppress the existing `kbd` hint. New `hiddenByUser?: boolean` flag on `TreeItem` with eye-off icon + opacity 0.55 (NOT reusing `restricted`'s strikethrough — see §0.4). | frontend-developer |
| `src/components/cmd/Sidebar.tsx` | Render gear icon in the existing free flex slot in the header row (line 72). When `editMode` is on: (a) wrap groups in DnD context, (b) inject the "done" + "reset to default" buttons in a toolbar above the tree, (c) flip TreeGroup `editMode` prop. Accepts `editMode`, `onToggleEditMode`, `override`, `onOverrideChange`, `onReset`. | frontend-developer |
| `src/components/cmd/SidebarEditMode.tsx` (new) | The DnD-aware wrapper that renders the sortable groups. Web-only via dynamic import. Pulls `@dnd-kit/core` + `@dnd-kit/sortable`. | frontend-developer |
| `src/screens/cmd/InventoryDesktopLayout.tsx` | (a) Read `sidebarLayoutOverride` from store. (b) Hold a local `editMode` boolean state. (c) Compute the merged groups via `applySidebarOverride(defaultGroups, override)` (§7). (d) Pass merged groups + edit-mode props to `<Sidebar>`. **Do NOT touch the hardcoded default `groups` array** — it stays as the source-of-truth default. | frontend-developer |
| `src/lib/sidebarLayout.ts` (new, ~80 LOC) | Pure utility: `applySidebarOverride(default, override)` (merge, §7), `produceOverride(rendered, default)` (diff back to override list when committing edit-mode changes), `isValidOverride(unknown)`. Pure functions, no React, no DOM — testable in isolation if a test framework gets wired up. | frontend-developer |

### §7 — Merge algorithm (`applySidebarOverride`)

Given `defaultGroups: SidebarGroup[]` (the hardcoded array) and
`override: SidebarLayoutOverride | null`, produce
`renderedGroups: SidebarGroup[]` for the Sidebar.

```
function applySidebarOverride(
  defaultGroups: SidebarGroup[],
  override: SidebarLayoutOverride | null,
): SidebarGroup[] {
  if (!override || !override.items?.length) return defaultGroups;

  // 1. Build a lookup by id of override entries.
  const ovById = new Map(override.items.map((e) => [e.id, e]));

  // 2. Walk every default item, decide its rendered home:
  //    - If override has a `group` → that group.
  //    - Else → its default group.
  //    Carry the override's `order` if present (else use the default
  //    order it had in the original group, as a stable fallback).
  //    Carry the override's `hidden` if present.
  //    Stale override entries (id not in default) are dropped here —
  //    they simply don't get visited.
  const placed: Array<{
    item: TreeItem;
    targetGroup: string;
    sortKey: number;       // smaller = higher
    hidden: boolean;
  }> = [];

  defaultGroups.forEach((g, gi) => {
    g.items.forEach((it, ii) => {
      const ov = ovById.get(it.id);
      const targetGroup = ov?.group ?? g.label;
      const sortKey = ov?.order ?? (gi * 1000 + ii); // default = group-major
      const hidden  = !!ov?.hidden;
      placed.push({ item: it, targetGroup, sortKey, hidden });
    });
  });

  // 3. Re-bucket by group label, preserving the default group ORDER
  //    (Operations / Planning / Insights). Items moved to a non-default
  //    group append to that group's tail at sortKey-relative position.
  //    "Future-added item auto-append to default group" works because
  //    new items in `defaultGroups` are simply not in `ovById` → they
  //    keep their default group + default sortKey.
  const groupOrder = defaultGroups.map((g) => g.label);
  const byGroup = new Map<string, typeof placed>();
  groupOrder.forEach((label) => byGroup.set(label, []));
  placed.forEach((p) => {
    if (!byGroup.has(p.targetGroup)) byGroup.set(p.targetGroup, []);
    byGroup.get(p.targetGroup)!.push(p);
  });

  // 4. Sort each group by sortKey, drop hidden items (or keep with
  //    hiddenByUser flag — see below for editMode toggle).
  const rendered: SidebarGroup[] = groupOrder.map((label) => ({
    label,
    items: byGroup.get(label)!
      .slice()
      .sort((a, b) => a.sortKey - b.sortKey)
      .filter((p) => !p.hidden)
      .map((p) => p.item),
  }));

  return rendered;
}
```

**Edit-mode variation.** When `editMode === true`, the merge does NOT
filter out hidden items — instead it renders them with
`hiddenByUser: true` so the eye-off toggle is reachable. The render-side
filter only happens in normal (non-edit) mode.

**Key invariant tested by §10 verification probes:** adding a new item
to the hardcoded `defaultGroups` array in a future spec, with no
override change, places that item at the correct default position
in the rendered list — because it's never seen by `ovById` lookup,
it inherits its default group + sortKey.

**`produceOverride(rendered, default)` — the diff back.** When
edit-mode "done" is clicked, the working state is the rendered group
shape (after the user has dragged things around). We need to produce
the minimal override list:

```
function produceOverride(
  rendered: SidebarGroup[],
  defaultGroups: SidebarGroup[],
): SidebarLayoutOverride | null {
  const defaultPos = new Map<string, { group: string; order: number }>();
  defaultGroups.forEach((g, gi) => {
    g.items.forEach((it, ii) => {
      defaultPos.set(it.id, { group: g.label, order: gi * 1000 + ii });
    });
  });

  const items: SidebarLayoutOverrideEntry[] = [];
  rendered.forEach((g, gi) => {
    g.items.forEach((it, ii) => {
      const def = defaultPos.get(it.id);
      const renderedOrder = gi * 1000 + ii;
      const groupChanged  = def && def.group !== g.label;
      const orderChanged  = def && def.order !== renderedOrder;
      const hidden        = !!(it as any).hiddenByUser;
      if (groupChanged || orderChanged || hidden) {
        const entry: SidebarLayoutOverrideEntry = { id: it.id };
        if (groupChanged)  entry.group  = g.label;
        if (orderChanged)  entry.order  = renderedOrder;
        if (hidden)        entry.hidden = true;
        items.push(entry);
      }
    });
  });

  return items.length === 0 ? null : { v: 1, items };
}
```

If the user clicks "done" with no changes, `items.length === 0` → we
write `null`, which is the same as the uncustomized default. Clean.

### §8 — Edit-mode UX details (architect picks)

| Question | Decision | Rationale |
|---|---|---|
| Gear icon visibility | **Always visible** in the header (free flex slot at `Sidebar.tsx:72`). | PM lean. Discoverability > minimalism for an admin power-user feature. Hover-reveal hides it from new users. |
| Drag handle | **Whole-row drag** when `editMode === true`. No separate gripper. The whole row's cursor flips to `grab` / `grabbing`. | Lower visual noise; the `kbd` hint slot can host the eye-toggle without competing for space. |
| Hide toggle | **Eye / eye-off icon** on the right side of the row (replaces the `kbd` hint slot in edit mode). Click toggles. | Matches `restricted`'s right-aligned status text pattern; readable affordance. |
| "Done" button | Sidebar header, replacing the gear icon when in edit mode. Mono caps `DONE`, accent-tinted. | Same physical slot — toggle in/out feels symmetric. |
| "Reset to default" | Below the command bar, full-width pill, danger-tinted (red border). Visible only in edit mode. Click opens a `confirmAction` modal: "Reset sidebar to default? This clears all your customizations." | PM lean: confirm. Destructive of user state. `confirmAction` is the cross-platform-safe path ([`src/utils/confirmAction.ts`](../src/utils/confirmAction.ts)). |
| Edit-mode-only rendering of hidden items | Hidden items appear in the sidebar tree with `hiddenByUser` flag (eye-off icon + opacity 0.55, NOT strikethrough — different from `restricted`). | Makes the un-hide gesture reachable without leaving edit mode. |

**`DBInspector` special case.** That row has a custom `onPress` (line 167)
that breaks out of the section state to push a different stack screen.
The override system is purely about position + visibility — it does
not touch `onPress`. The merge algorithm carries the `TreeItem` object
through unmodified, so `onPress` survives. Verified by reading the
algorithm: `placed.push({ item: it, ... })` — `item` is the original
ref.

### §9 — Keyboard a11y contract

`@dnd-kit/core` ships a `KeyboardSensor` for free. Wire it up in
`SidebarEditMode.tsx`'s `useSensors` call.

**User-facing contract:**
- `Tab` — focuses the next sidebar item (in rendered order, edit mode
  on or off).
- In edit mode, with an item focused:
  - `Space` or `Enter` — "lift" the item (announce via aria-live).
  - `↑` / `↓` — move the lifted item up/down within its group.
  - `←` / `→` — move the lifted item to the previous / next group
    (custom keyboard coordinate-getter, see below).
  - `Space` or `Enter` (second press) — drop the item at the current
    position.
  - `Escape` — cancel the lift; item snaps back.
- `H` (when an item is focused, not lifted) — toggle hide/show. (Single
  letter; no modifier. Common admin power-user pattern.)

**Cross-group keyboard reorder** is not built into `dnd-kit`'s default
`sortableKeyboardCoordinates` — it only handles intra-list moves. The
implementer needs a small custom coordinate-getter that maps
←/→ to "switch to neighboring group's nearest position." This is
~30 LOC and well-documented in the `dnd-kit` docs. Flag for the
frontend-developer.

**Screen-reader announcements** are handled by `dnd-kit`'s default
`announcements` config; we override the strings to be
sidebar-context-aware ("Inventory lifted; row 1 of 5 in Operations
group" rather than the generic "Item lifted at position 1").

### §10 — Verification probes (post-implementation, browser)

These are the user-runnable acceptance probes. Each should pass before
the spec moves to DONE.

1. **Default state.** Fresh login (uncustomized profile). Sidebar
   renders the hardcoded order. Gear icon visible at top right of the
   `im.cmd / v2.4` row.
2. **Enter edit mode.** Click gear → row replaces with "DONE" pill;
   command bar shrinks to make room for "Reset to default" pill;
   each tree item shows an eye/eye-off icon on the right; rows are
   draggable.
3. **Reorder within group.** Drag "Inventory" below "Dashboard" within
   Operations. Click DONE. Reload the page. Inventory still appears
   below Dashboard. Verify
   `select sidebar_layout from profiles where id = auth.uid()` returns
   `{ v: 1, items: [{ id: "Inventory", order: <new-int> }, { id: "Dashboard", order: <new-int> }] }`
   (or equivalent — only the diffed items are persisted).
4. **Reorder across groups.** Drag "Reports" from Insights into
   Operations. Click DONE. Reload. Reports appears in Operations.
   `sidebar_layout.items` contains
   `{ id: "Reports", group: "Operations", order: <int> }`.
5. **Hide an item.** Enter edit mode. Click eye icon next to "DB inspector".
   Eye flips to eye-off; row dims. Click DONE. DB inspector is no longer
   visible in the sidebar. Reload. Still hidden.
6. **Re-show.** Re-enter edit mode. DB inspector re-appears in its
   override-positioned slot with eye-off. Click eye-off → eye. Click
   DONE. DB inspector visible again.
7. **Reset to default.** Make several changes (move + hide). Click
   "Reset to default". Confirm dialog. Click confirm. Sidebar snaps
   back to default order. Reload. Still default.
   `select sidebar_layout from profiles where id = auth.uid()` returns
   NULL.
8. **Empty save.** Enter edit mode without making any changes. Click
   DONE. Sidebar unchanged. `sidebar_layout` is NULL (no spurious
   override row written — `produceOverride` returns null when items
   array is empty).
9. **Future-item auto-append (deferred).** Documented merge invariant.
   Cannot be browser-verified without a future spec adding a sidebar
   item, but the merge algorithm test case is: given an override list
   referencing only existing items, when `defaultGroups` gains a new
   item in some group, that new item appears at its default position
   in the rendered output, regardless of the override.
10. **Keyboard reorder.** Tab to focus "Inventory". Press Space (lift,
    aria-live announces). Press ↓ twice (item moves down in Operations).
    Press Space (drop). Press DONE button (Tab + Enter). Reload.
    Inventory is in its new position.
11. **Cross-user isolation.** Log in as user A, customize. Log in as
    user B (separate profile). User B sees the default sidebar.
    `select id, sidebar_layout from profiles where role = 'admin'`
    confirms user A's row has the override and user B's is NULL.
12. **RLS block on cross-user write.** As user A, try to PATCH user B's
    profile via curl:
    `curl ... /rest/v1/profiles?id=eq.<user-b-id> -X PATCH -d '{"sidebar_layout": ...}'`
    Should return 0 rows affected (RLS-silent). Confirms the existing
    "Users can update own profile" policy correctly gates the new
    column.

### §11 — Architect-level open flags (resolved)

| Flag | Decision |
|---|---|
| Column name | `sidebar_layout` (matches `dark_mode` precedent — snake_case, descriptive, no "preferences." prefix). |
| Gear icon visibility | Always visible (PM lean confirmed). |
| `confirmAction` on reset | Yes (PM lean confirmed). Destructive of user state. |
| `dnd-kit` version | Latest stable as of design date. Pin to a major + minor in package.json (`^X.Y.0`); developer takes whatever resolves. Bundle includes `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`. |
| Auto-save vs save-on-done | Save-on-done (PM lean confirmed). |
| `restricted` reuse for hidden items | **No** — semantic mismatch (restricted = unclickable; hidden = invisible-by-choice). Add a sibling `hiddenByUser` flag with its own visual treatment (eye-off icon, opacity 0.55). |
| Local cache (like `darkMode` localStorage) | **No** — sidebar isn't on the first-paint critical path; it renders post-login. Skip the cache to avoid a second source of truth. |
| Native (iOS/Android) build breakage from `dnd-kit` | Mitigated via dynamic import gated on `Platform.OS === 'web'`. Native bundle never sees the import. Q8 = web only, so no native UX needed. |

### §12 — Risks & tradeoffs

| Risk | Mitigation | Severity |
|---|---|---|
| Future spec adds a sidebar item with an `id` that collides with an old override entry's stale id (e.g., re-using "Reports"). | Override entry's `group` would silently send the new item to the old user's chosen group. Acceptable — it's the user's last-stated preference for an id, and the user can reset. Document the id-stability convention in `InventoryDesktopLayout.tsx`'s `groups` comment. | Low |
| User customizes, admin renames a `TreeItem.id` later. | Stale entry; merge algorithm drops it (id not in default). User's customization for that item silently lost. Acceptable — id renames are rare and require a PR; we'll catch them in review. | Low |
| `dnd-kit` adds ~16kb gz to the web bundle. | Acceptable per Q8 = web only; mobile-PWA users get the same admin app, but admins are not bandwidth-constrained. | Low |
| `@dnd-kit` only loaded into web bundle — native build still has a `Sidebar.tsx` that conditionally renders edit mode. | Confirmed via `Platform.OS === 'web'` guard at the dynamic-import call site. Native build sees a `null` for the edit-mode component, gear icon should also be hidden on native (Q8 = web only). Add `if (Platform.OS !== 'web') return null;` to the gear icon render. | Low |
| Concurrency: user has the app open in two tabs, customizes in tab 1, switches to tab 2 (which has stale `sidebarLayoutOverride` in memory). | Tab 2's next save overwrites tab 1's changes (last-writer-wins). Acceptable per Q9 = N/A (per-user means no two admins, but same admin in two tabs is a degenerate case the spec doesn't address). Document as known-issue; can be fixed later with `updated_at` optimistic-concurrency if it becomes a problem. | Low |
| Migration ordering. Spec 008's migration must apply after spec 007's `20260507214842`. | Filename `20260508120000_*` sorts after by lexicographic timestamp comparison (Supabase CLI ordering rule). Verified. | None |
| RLS gap on the new column. | None. RLS is row-scoped on `profiles`; new column inherits. Cross-user write attempt is verified by probe §10.12. | None |
| Performance on the 286 KB seed. | None. `profiles` has a tiny row count; the JSONB column is bounded (~17 items × ~50 bytes = <1 KB per row). No index needed. | None |
| Edge function cold-start. | None — no edge function changes. | None |
| Realtime publication membership. | Not changed. `profiles` is not on the publication. The publication-restart gotcha (CLAUDE.md "Realtime publication gotcha") is N/A. | None |

### §13 — Out of scope (architect-level)

- **Drag-and-drop reordering of groups themselves** (e.g., moving
  "Insights" above "Planning"). Spec §"Out of scope" covers this; the
  override list shape doesn't carry group order, only item-within-group
  position. If wanted later, add `groupOrder?: string[]` to the override
  shape.
- **Mobile drawer (`InventoryListScreen`) reordering.** Q8 = web only.
- **Sub-tab reordering** within a section (e.g., `detail.tsx / usage.tsx`).
  Out of scope per spec.
- **Sharing layout across users.** Out of scope per spec.
- **Backfilling a default override row at signup.** Not needed —
  NULL is the default, and the merge algorithm treats NULL = default.

## Build notes

### Backend pass

Implemented 2026-05-08 by `backend-developer`. Scope per architect's §6
backend rows. Frontend rows (Sidebar/TreeGroup/InventoryDesktopLayout/
SidebarEditMode/sidebarLayout.ts/package.json) are owned by
frontend-developer and untouched here.

**STOP-condition checks (both passed, no surface):**
- `profiles.sidebar_layout` does not pre-exist on local — verified via
  `\d public.profiles` before applying. Column add is greenfield.
- `profiles` RLS is row-scoped via `id = auth.uid()` (with admin/master
  JWT bypass). Verified by reading
  `20260502071736_remote_schema.sql:381-422` and `\d public.profiles`'s
  policy listing. The new column inherits these policies — no new
  policy work needed (RLS is row-scoped, not column-scoped).

**Migration**
- File: `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql`
- Body: `alter table public.profiles add column if not exists
  sidebar_layout jsonb;` plus a column comment documenting the §2 shape.
  Wrapped in `begin/commit`. Idempotent via `if not exists`.
- Apply output (local):
  `BEGIN / ALTER TABLE / COMMENT / COMMIT`. Recorded in
  `supabase_migrations.schema_migrations` via direct INSERT (the
  `npx supabase migration up --local` path was blocked by an unrelated
  out-of-order spec003/spec006 backlog; applied via
  `docker exec ... psql < migration.sql` to avoid pulling in those
  unrelated migrations).
- Smoke verified end-to-end:
  `UPDATE profiles SET sidebar_layout = '{"v":1,"items":[...]}'::jsonb`
  round-trips, and `SET sidebar_layout = NULL` resets to default
  sentinel.
- Not pushed to prod — `supabase db push --linked` was NOT run (per
  user-authorized gate).

**Types added** (`src/types/index.ts`)
- `SidebarLayoutOverrideEntry` — `{ id; group?; order?; hidden? }`.
- `SidebarLayoutOverride` — `{ v: 1; items: Entry[] }`. Versioning
  contract documented per §2.
- `AppState.sidebarLayoutOverride: SidebarLayoutOverride | null` added
  next to `darkMode` so the new slice is part of the app's state shape.

**`src/lib/auth.ts`**
- Extended `AuthResult` with optional `sidebarLayout?: SidebarLayoutOverride | null`
  (precedent: existing `darkMode` field).
- `fetchProfile` returns `sidebarLayout: coerceSidebarLayout(profile.sidebar_layout)`.
- New private `coerceSidebarLayout(raw)` shape guard: requires `v === 1`
  and `Array.isArray(items)`; anything else collapses to `null` so an
  invalid stored value falls back to default rather than crashing the
  Sidebar render.
- The `select('*')` path already pulls the new column down for free.

**`src/lib/db.ts`**
- New helper: `saveSidebarLayout(userId: string, layout: SidebarLayoutOverride | null): Promise<void>`.
- Uses `supabase.from('profiles').update({ sidebar_layout: layout }).eq('id', userId)`.
- Throws on error (so the store layer can revert + `notifyBackendError`).
- Added `SidebarLayoutOverride` to the type imports.
- Comment notes RLS gating via "Users can update own profile" policy.

**`src/store/useStore.ts`**
- Added `SidebarLayoutOverride` to the type imports.
- Added action signature `setSidebarLayoutOverride(override: SidebarLayoutOverride | null): void`
  to `StoreActions`.
- Added initial state `sidebarLayoutOverride: null`.
- Action body follows the existing optimistic-then-revert precedent:
  saves `prev`, sets local state, calls `db.saveSidebarLayout`; on
  error reverts and calls `notifyBackendError('Save sidebar layout', e)`.
- Skips persistence when `currentUser` is null (legacy/demo mode).

**`App.tsx` login wiring**
- Added `setSidebarLayoutOverride` to the store-hook selectors.
- In the `getSession()` restore effect, after `setDarkMode(result.darkMode)`,
  call `setSidebarLayoutOverride(result.sidebarLayout)` when defined.
- Comment flags one known cost: this triggers a redundant UPDATE on
  every login (the persist action is shared with the edit-mode "done"
  path, and the boot value-equals-stored case is not optimized away).
  Acceptable per architect's §3 guidance — one extra UPDATE per
  session, idempotent.

**Typecheck**
- `npx tsc --noEmit` clean across all my edited files
  (types/index.ts, lib/auth.ts, lib/db.ts, App.tsx). The remaining
  errors in `useStore.ts` (`storeLoading`, `casePrice`, etc.) all
  pre-exist this spec — verified by line-number diff against the
  diff hunks I introduced. Frontend-developer's
  `src/lib/sidebarLayout.ts` errors are out of scope (theirs to wire).

**Realtime**
- `profiles` is on the `supabase_realtime` publication today (verified
  via `\d public.profiles`'s `Publications:` line). Spec design §0.6
  noted "publication membership not changed" — confirmed; no
  `docker restart supabase_realtime_imr-inventory` step needed. The
  app does not subscribe to profile changes (`useRealtimeSync.ts` is
  brand- and store-channel only), so the publication membership has
  no live-sync effect.

### Frontend pass

Implemented 2026-05-08 by `frontend-developer` in parallel with the
backend pass above. Scope per architect's §6 frontend rows.

**Dependencies**
- Added `@dnd-kit/core@^6.3.1`, `@dnd-kit/sortable@^10.0.0`, and
  `@dnd-kit/utilities@^3.2.2` to `package.json`. `npm install` ran
  cleanly (no peerDep warnings; `react@19.1.0` and `react-dom@19.1.0`
  satisfy the libs' `>=16.8 <20` peer ranges). Bundle-size impact lands
  under architect's ~16kb gz target since dnd-kit is loaded via the
  lazy-import path below; the main web bundle never imports it
  unconditionally, only when the user enters edit mode.

**`src/lib/sidebarLayout.ts` (new, ~165 LOC)**
- Pure-utility module per architect's §7. Exports
  `applySidebarOverride(default, override, { editMode? })`,
  `produceOverride(rendered, default)`, and `isValidOverride(unknown)`.
- Re-exports `SidebarLayoutOverride` + `SidebarLayoutOverrideEntry` from
  `src/types/index.ts` (backend-developer's canonical home for the
  shape) so call sites can import either source — no duplication.
- Defines `SidebarGroup` locally (mirrors the same shape exported from
  `Sidebar.tsx` — a small intentional duplication to dodge a circular
  import; structurally compatible).
- `applySidebarOverride` honours architect's §7 invariant: items not
  present in the override list inherit default group + default sort
  key (group-major encoding `gi*1000 + ii`). Stale override entries
  (id no longer in default) are silently dropped during merge.
- New `editMode` option flag (extension over the architect's pseudocode):
  when true, hidden items stay in the rendered output decorated with
  `hiddenByUser: true` so the eye-toggle UI is reachable; when false,
  hidden items are filtered out.
- `produceOverride` returns `null` when no item differs from default →
  the store action persists `null` for the "uncustomized" case (matches
  architect's §10.8 empty-save probe).

**`src/components/cmd/TreeGroup.tsx`**
- Added `hiddenByUser?: boolean` to the `TreeItem` interface — semantic
  pair to the existing `restricted` flag (per architect's §0.4 "do not
  reuse `restricted` for hidden — different semantics").
- Added `editMode?: boolean` and `onToggleHide?: (id) => void` props.
- When `editMode === true`, the row renders as a static `View` with a
  drag-handle indicator (`⠿`) on the left and an eye/eye-off toggle
  (`◉` / `⊘`) on the right. The `kbd` hint and selection chrome are
  suppressed in edit mode (the parent `SidebarEditMode.tsx` owns drag
  semantics; the row should not behave like a navigable button).
- Hidden rows render at opacity 0.55 with a lighter weight — visual
  cue distinct from `restricted`'s strikethrough.

**`src/components/cmd/SidebarEditMode.tsx` (new, ~360 LOC)**
- Web-only `dnd-kit` wrapper. Imports the dnd-kit packages directly;
  loaded via `React.lazy(() => import('./SidebarEditMode'))` on the
  Sidebar side, gated on `Platform.OS === 'web'` per architect's §5
  "native bundle never sees the import".
- Wraps groups in a single `DndContext` with `closestCenter` collision
  strategy. Each group is a `SortableContext` with
  `verticalListSortingStrategy`. Cross-group drags are reconciled in
  the `onDragOver` handler (default sortable doesn't handle cross-list
  natively).
- Sensors: `PointerSensor` with a 4 px activation distance (so a click
  on the eye-toggle doesn't accidentally start a drag) +
  `KeyboardSensor` with `sortableKeyboardCoordinates` for arrow-key
  reorder per architect's §9 a11y contract.
- Each row uses a plain `<div>` host (web-only file) for dnd-kit's
  `setNodeRef` + spread `{...attributes}{...listeners}` to avoid the
  RN-Web `View` `tabIndex: number` typing fight. RN `Text` /
  `TouchableOpacity` still render the inner content via
  react-native-web for theme-token consistency.
- `EmptyGroupDropZone` — dashed-border drop target rendered when a
  group ends up empty mid-edit, so the user can still drag items
  back into it.
- Custom `accessibility.announcements` strings for screen readers
  (architect §9 contract: "Picked up X.", "X is over Y.", etc.).

**`src/components/cmd/Sidebar.tsx`**
- Added `editMode`, `onToggleEditMode`, `onGroupsChange`,
  `onToggleHide`, `onReset` props.
- Header: gear icon (`⚙`) renders in the existing free flex slot in
  the header row (architect §0.4: line 72's `<View style={{ flex: 1 }}/>`
  is the placement target). When `editMode` is on, the gear flips to a
  `DONE` accent-tinted pill in the same physical slot per architect §8.
  Both are gated on `Platform.OS === 'web'` per Q8 web-only.
- Command bar: in edit mode, the `⌘P` palette pill is replaced with a
  full-width "reset to default" pill (red border, danger-tinted) per
  architect §8. Keeps the visual chrome consistent.
- Tree: when `editMode === true && Platform.OS === 'web'`, a
  `<React.Suspense>` wraps a `<SidebarEditModeLazy>` chunk. Native and
  the (unlikely) web-without-edit fallback go through the existing
  `TreeGroup` map, with `editMode={true}` passed through for the
  static eye-toggle visual on native (no DnD).

**`src/screens/cmd/InventoryDesktopLayout.tsx`**
- Renamed local `groups` → `defaultGroups`, wrapped in `useMemo` so
  the closure capturing `nav` (DBInspector's custom `onPress`) is
  stable. Comment reinforces architect §12 risk: "id values are
  load-bearing — don't rename casually".
- Reads `sidebarLayoutOverride` and `setSidebarLayoutOverride` from
  `useStore` (backend-developer's slice).
- Computes `renderedGroups` via `applySidebarOverride(defaultGroups,
  override, { editMode })`. In edit mode, a `draftGroups` local state
  is mutated by the DnD wrapper / eye-toggle; on DONE, diffed via
  `produceOverride` and persisted via `setSidebarLayoutOverride`.
- Section state is preserved across edit-mode toggles — `section` is
  unchanged by `setSidebarEditMode` calls (verified by inspection).
- "Reset to default" is gated through `confirmAction` per architect
  §8. The confirm message matches the architect's wording.
- Defensive selectors removed once backend's slice landed — the
  store now exposes `sidebarLayoutOverride` and
  `setSidebarLayoutOverride` as first-class typed members.

**Verification**
- TypeScript clean across all my edited files: `npx tsc --noEmit`
  reports no errors in `src/lib/sidebarLayout.ts`,
  `src/components/cmd/Sidebar.tsx`,
  `src/components/cmd/TreeGroup.tsx`,
  `src/components/cmd/SidebarEditMode.tsx`, or
  `src/screens/cmd/InventoryDesktopLayout.tsx`. Remaining errors in
  the file (lines 724, 725, 772 in the pre-existing `UsageTab`
  helper) are pre-existing — unrelated to this spec.
- Web bundle compiles. The Metro dev server at port 8082 serves
  `/node_modules/expo/AppEntry.bundle?…` cleanly (~11.7 MB,
  syntactically valid via `node --check`). The `SidebarEditMode`
  lazy chunk is fetched on demand (verified by hitting
  `/src/components/cmd/SidebarEditMode.bundle?…` directly: 2.1 MB,
  contains `useSortable`, `SortableContext`, `SidebarEditMode`).
- **Browser interactive verification: GAP.** This session does not
  have the `preview_*` MCP tools loaded — the sandbox limited my
  toolset to Read/Write/Edit/Bash. Bundle compiles cleanly via the
  running Expo dev server, but I could not click the gear, drag
  items across groups, hit the eye-toggle, run keyboard reorder,
  or screenshot the result. **Probes §10.1–§10.10 from the
  architect's spec are unverified by this dev pass.** Reviewers
  (especially `code-reviewer` and `test-engineer`) and main Claude
  should walk these probes in the browser before SHIP_READY:
  - §10.1 default render
  - §10.2 enter edit mode (gear → DONE flip)
  - §10.3 reorder within group + persistence across reload
  - §10.4 reorder across groups + persistence
  - §10.5 hide an item + persistence
  - §10.6 re-show
  - §10.7 reset to default + confirm dialog
  - §10.8 empty-save (no spurious override row)
  - §10.10 keyboard reorder (Tab + Space + arrows + Space)
  - §10.11 cross-user isolation
  - §10.12 RLS block on cross-user write (covered by backend pass)
- Native mobile (iOS/Android) — out of scope per Q8 web-only.
  `Platform.OS === 'web'` guard keeps the dnd-kit chunk out of the
  native bundle; the gear icon also renders only on web.

**Known follow-ups (non-blocking)**
- The `applySidebarOverride` + `produceOverride` pair is a natural
  unit-test target. No test framework is wired up yet — flagged for
  `test-engineer` review per spec dependencies note.
- Minor concern: `setSidebarLayoutOverride(result.sidebarLayout)` on
  every login triggers an UPDATE round-trip even when the value is
  unchanged (backend-developer's pass acknowledged this). Could be
  short-circuited later if it shows up as a hot path.
  *(Closed by Fix-pass 2026-05-08 below — split into hydrator vs setter.)*

### Fix-pass backend slice (2026-05-08)

Implemented by `backend-developer` against the user-authorized fix
bundle in `specs/008-sidebar-layout-customization/reviews/release-proposal.md`.
Frontend slice (items #2, #3, #5) ran in parallel and is reported in a
separate fix-pass section.

**Closed proposal items (backend-owned):**

- **#1 — Split `setSidebarLayoutOverride` into hydrator + setter
  (architect S3, also closes code-reviewer #1).**
  Mirrors the existing `setDarkMode` (no-persist) / `toggleDarkMode`
  (persisting) pattern.
  - `src/store/useStore.ts` — added `hydrateSidebarLayoutOverride(override)`
    (pure `set(...)`, no DB write) alongside the existing persisting
    `setSidebarLayoutOverride`. Both signatures live on `StoreActions`.
    Inline comments now cross-reference the two so future readers don't
    confuse the call sites.
  - `App.tsx` — login-restore path now calls
    `hydrateSidebarLayoutOverride(result.sidebarLayout)` instead of
    the persisting setter. Removes the redundant UPDATE that the prior
    pass acknowledged. The persisting `setSidebarLayoutOverride` is
    still imported nowhere in `App.tsx` (only the hydrator is selected),
    so the boot path can never round-trip the just-read value back to
    the column. `InventoryDesktopLayout.tsx`'s edit-mode DONE / reset
    paths continue to use the persisting setter unchanged.

- **#4 — Unify `coerceSidebarLayout` with `isValidOverride`
  (closes test-engineer Finding 1, code-reviewer #3).**
  - `src/lib/auth.ts` — `coerceSidebarLayout` now delegates to
    `isValidOverride` from `src/lib/sidebarLayout.ts`. Returns the
    validated input (typed as `SidebarLayoutOverride`) on success,
    `null` on failure. The local weaker guard (which only checked
    `v === 1` + `Array.isArray(items)`) is gone.
  - The unified guard now rejects malformed entries the prior guard
    would have let through: items missing `id`, items with non-string
    `id`, `group` not a string, `order` not a number, `hidden` not
    a boolean. Mental test: a stored row of
    `{v:1,items:[{group:"Operations"}]}` (no `id`) is now coerced to
    `null` (default sidebar) rather than passed through and crashing
    `applySidebarOverride`'s `Map(items.map((e) => [e.id, e]))`.

**STOP-conditions hit:** none. The split + unification are mechanical;
no design questions surfaced. No new dependencies. No migration changes.
No frontend file touched.

**Verification**

- `npx tsc --noEmit` — no new errors in any file I touched
  (`App.tsx`, `src/lib/auth.ts`, `src/store/useStore.ts`). The
  pre-existing errors in `useStore.ts` (lines 271, 359, 366, 1049,
  1150) and `InventoryDesktopLayout.tsx` (lines 724, 725, 772) are
  unchanged from the original backend pass — already documented as
  out-of-scope above.
- Login-write inspection (per task prompt verification step):
  the persisting setter is no longer referenced from `App.tsx`, so
  the only path that calls `db.saveSidebarLayout` is the edit-mode
  DONE / reset flow in `InventoryDesktopLayout.tsx`. The call graph
  audit alone is sufficient evidence the redundant UPDATE is gone;
  a network-tab walk on `admin@local.test` login can confirm no
  `PATCH /rest/v1/profiles?id=eq.<uid>` fires when the user is not
  in edit mode.
- The unified shape-guard delegation is type-checked against
  `isValidOverride`'s `input is SidebarLayoutOverride` predicate —
  `coerceSidebarLayout`'s return path is typed as
  `SidebarLayoutOverride | null` with no casts.

**Status note:** leaving `Status: READY_FOR_BUILD` per the task prompt.
The user-authorized prod-push gate stays open until the full fix bundle
(items #1 + #2 + #3 + #4 + #5) lands and the cross-pass typecheck +
browser drag-walk complete. Frontend slice for #2 / #3 / #5 is the
gating remainder.

### Fix-pass frontend slice (2026-05-08)

Implemented by `frontend-developer` against the user-authorized fix
bundle in `specs/008-sidebar-layout-customization/reviews/release-proposal.md`.
Backend slice (items #1 + #4) ran in parallel and is reported in the
prior fix-pass section.

**Closed proposal items (frontend-owned):**

- **#2 — Cross-group ←/→ keyboard reorder
  (architect S1; closes test-engineer AC-Q10 fail #1).**
  - `src/components/cmd/SidebarEditMode.tsx` — replaced the default
    `sortableKeyboardCoordinates` getter on the `KeyboardSensor` with
    a wrapping `customCoordinateGetter` (~60 LOC including comments).
    For ↑/↓ the wrapper defers to `sortableKeyboardCoordinates`
    unchanged. For ←/→ it:
    1. Resolves the active item's group via dnd-kit data attached at
       `useSortable({ id, data: { groupLabel } })` time (with a fallback
       scan of the live `groups` ref for safety).
    2. Computes the previous/next group label from the rendered group
       order (read from a `groupsRef` so the closure stays stable).
    3. Picks a target droppable id in the adjacent group: the empty
       drop-zone if the group is empty, the first item if going right,
       the last item if going left.
    4. Reads that droppable's rect from `args.context.droppableRects`
       and returns coordinates inside it. dnd-kit's existing
       `closestCenter` collision then fires `onDragOver` against that
       rect, and the existing cross-group `handleDragOver`
       reconciliation lifts-and-inserts the item — no duplicate move
       logic. `event.preventDefault()` is called before the return so
       the browser doesn't scroll horizontally.
  - Also added `data: { groupLabel }` to every `SortableRow`'s
    `useSortable({ id })` call so the coordinate-getter can resolve
    the group in O(1) without scanning the live array.

- **#3 — `H` hide-shortcut on the focused item
  (architect S2; closes test-engineer AC-Q10 fail #2).**
  - `src/components/cmd/SidebarEditMode.tsx` — added an `onKeyDown`
    listener on a wrapper `<div>` around the `DndContext`'s tree
    region (~12 LOC). When `event.code === 'KeyH'` (no modifiers)
    and no drag is in flight, the handler walks up from the focused
    target to the nearest `[data-sidebar-item-id]` ancestor and
    calls `onToggleHide(id)`. Each `SortableRow`'s root `<div>` now
    carries the `data-sidebar-item-id={item.id}` attribute. The
    handler is gated by `activeId === null` so `H` doesn't fire
    mid-lift (where the spatial mental model belongs to the dnd-kit
    sensors, not a hide-toggle).
  - `onToggleHide` is reached through a `onToggleHideRef` so the
    `useCallback` dep list stays minimal (only `activeId`).

- **#5 — Switch `EmptyGroupDropZone` to `useDroppable`
  (architect Nit N1, code-reviewer #2).**
  - `src/components/cmd/SidebarEditMode.tsx` — replaced
    `useSortable({ id })` with `useDroppable({ id })` from
    `@dnd-kit/core` for the empty-group placeholder. Dropped the
    unused `transform`/`transition` plumbing (the placeholder doesn't
    sort). `setNodeRef` + `isOver` semantics are unchanged in the
    visual treatment. Added a comment explaining why the canonical
    primitive is `useDroppable` here.

**No new dependencies** — the fix bundle uses only existing
`@dnd-kit/core` exports (`useDroppable`, `KeyboardCode`,
`KeyboardCoordinateGetter`).

**Verification**

- `npx tsc --noEmit` — clean for `src/components/cmd/SidebarEditMode.tsx`
  (the only file I touched). The remaining repo-wide errors all live
  in pre-existing files outside this spec's scope (verified by grep:
  no `SidebarEditMode.tsx` line in the typecheck output).
- Web bundle compiles end-to-end against the running Expo dev server
  on `localhost:8082`:
  - `GET /src/components/cmd/SidebarEditMode.bundle?...` → HTTP 200,
    2,229,916 bytes; `node --check` passes; `grep` confirms the new
    symbols (`useDroppable`, `customCoordinateGetter`,
    `data-sidebar-item-id`, `onKeyDown`) are emitted in the bundle.
  - `GET /node_modules/expo/AppEntry.bundle?...` → HTTP 200,
    13,854,174 bytes; `node --check` passes (proves the import chain
    through `Sidebar.tsx`'s `React.lazy` still resolves cleanly).
- **Browser interactive verification: GAP — same as the original
  frontend pass.** This sub-agent session does not have the
  `preview_*` (claude-in-chrome / chrome-devtools / etc.) MCP tools
  loaded — my available toolset is Read/Write/Edit/Bash. I could not:
  - Tab-focus a sidebar item, Space to lift, ↑/↓ to reorder within
    group, Space to drop (intra-group keyboard reorder smoke).
  - Tab-focus a sidebar item, Space to lift, ←/→ to cross to
    adjacent group (the new AC-Q10 cross-group probe).
  - Focus an item without lifting and press `H` (the new AC-Q10
    hide-shortcut probe).
  - Drag the last item out of a group then drag a different item
    back into the empty placeholder (the empty-drop-zone probe that
    item #5 was supposed to fix on the canonical primitive).

  These probes remain owed to whoever runs the next browser walk —
  same channel the original frontend pass left open. The static
  evidence above (typecheck clean, bundles compile, symbols
  emitted) is sufficient to rule out compile-time regressions but
  is not a substitute for the AC-Q10 walk.
- Native mobile (iOS/Android) — out of scope per Q8 web-only.
  None of the additions touch the `Platform.OS === 'web'` guard
  shape; the `@dnd-kit/core` imports stay inside the lazy-loaded
  `SidebarEditMode.tsx`, which Metro keeps out of the native bundle
  via `Sidebar.tsx`'s gated `React.lazy`.

**Out of scope for this fix-pass** (intentionally not touched):

- Code-reviewer #4 (`SidebarGroup` duplication between `Sidebar.tsx`
  and `sidebarLayout.ts`) — explicit defer in the proposal.
- Code-reviewer #5 (`as any` / intersection casts on `hiddenByUser`)
  — explicit defer in the proposal.
- Code-reviewer Nits N1–N3 — explicit defer in the proposal.
- Architect Nit N2 (memoize id-to-group map for `handleDragOver`) —
  defer; current scale is 3 groups × 17 items.
- Architect Nit N3 (normalize `entry.order` to contiguous integers) —
  spec §2 explicitly allows non-contiguous order numbers.
- Test-engineer Finding 6 — resolved by item #5 above; no further
  action.
- Security-auditor Medium (`pg_column_size` CHECK) — explicit defer
  in the proposal (additive migration, defense-in-depth).

**Status note:** leaving `Status: READY_FOR_BUILD` per the task
prompt. Items #1 + #2 + #3 + #4 + #5 are now all closed across the
two fix-passes (backend + frontend). The user-authorized prod-push
gate is the remaining external dependency; the cross-pass typecheck
is clean and a real-browser drag-walk by the next pass closes the
verification gap above.

## Files changed

### Backend slice

**migrations**
- `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql` (new)

**src/types**
- `src/types/index.ts` — added `SidebarLayoutOverrideEntry`,
  `SidebarLayoutOverride`, and `AppState.sidebarLayoutOverride` field.

**src/lib**
- `src/lib/auth.ts` — extended `AuthResult` with `sidebarLayout`;
  added `coerceSidebarLayout` shape guard; `fetchProfile` returns
  the coerced value.
- `src/lib/db.ts` — added `saveSidebarLayout` helper; added
  `SidebarLayoutOverride` to type imports.

**src/store**
- `src/store/useStore.ts` — added `setSidebarLayoutOverride` action
  signature, initial-state slot, and implementation; added type
  import.

**root**
- `App.tsx` — wired `setSidebarLayoutOverride` selector and the
  login-restore call after `setDarkMode`.

### Frontend slice

**root**
- `package.json` — added `@dnd-kit/core@^6.3.1`,
  `@dnd-kit/sortable@^10.0.0`, `@dnd-kit/utilities@^3.2.2`. Lockfile
  updated by `npm install`.

**src/lib**
- `src/lib/sidebarLayout.ts` (new) — pure utility module exporting
  `applySidebarOverride`, `produceOverride`, `isValidOverride`, and
  the `SidebarGroup` type. Re-exports `SidebarLayoutOverride` +
  `SidebarLayoutOverrideEntry` from `src/types/index.ts` (no type
  duplication).

**src/components/cmd**
- `src/components/cmd/TreeGroup.tsx` — added `hiddenByUser?` flag on
  `TreeItem` and `editMode?` + `onToggleHide?` props on the group
  component. New static edit-mode row variant with drag-handle
  glyph + eye-toggle.
- `src/components/cmd/Sidebar.tsx` — added `editMode`,
  `onToggleEditMode`, `onGroupsChange`, `onToggleHide`, `onReset`
  props; gear / DONE button in header; reset-to-default pill in the
  command-bar slot; `React.lazy` web-only mount of
  `SidebarEditMode`.
- `src/components/cmd/SidebarEditMode.tsx` (new) — web-only DnD
  wrapper. `DndContext` + `SortableContext` per group + cross-group
  reconciliation via `onDragOver`. Pointer + Keyboard sensors.

**src/screens/cmd**
- `src/screens/cmd/InventoryDesktopLayout.tsx` — renamed `groups` →
  `defaultGroups` (memoized); reads `sidebarLayoutOverride` from the
  store; computes `renderedGroups` via `applySidebarOverride`;
  manages `sidebarEditMode` + `draftGroups` local state; wires
  DONE → `produceOverride` → `setSidebarLayoutOverride`;
  `confirmAction` on reset.

### Fix-pass backend slice (2026-05-08)

**src/lib**
- `src/lib/auth.ts` — `coerceSidebarLayout` now delegates to
  `isValidOverride` (single source of truth, validates per-item
  field types). Local weaker guard removed.

**src/store**
- `src/store/useStore.ts` — added `hydrateSidebarLayoutOverride` (no-DB
  hydrator, mirrors `setDarkMode`); kept persisting
  `setSidebarLayoutOverride` for edit-mode DONE / reset; both
  signatures now declared on `StoreActions`.

**root**
- `App.tsx` — login-restore path now uses `hydrateSidebarLayoutOverride`
  (no-persist) instead of the persisting setter. Closes the redundant
  UPDATE-on-login round-trip.

### Fix-pass frontend slice (2026-05-08)

**src/components/cmd**
- `src/components/cmd/SidebarEditMode.tsx` — three changes in one file:
  (a) custom `customCoordinateGetter` for the `KeyboardSensor` that
      defers ↑/↓ to the default `sortableKeyboardCoordinates` and
      handles ←/→ as cross-group moves into the previous/next group's
      first/last droppable (closes proposal #2 / architect S1 / AC-Q10
      fail #1); attached `data: { groupLabel }` on every `useSortable`
      so the getter resolves the active group in O(1).
  (b) `onKeyDown` listener on a wrapper around the tree that toggles
      hide/show on the focused row when `H` is pressed without a drag
      in flight (closes proposal #3 / architect S2 / AC-Q10 fail #2);
      adds `data-sidebar-item-id` on each `SortableRow`'s root `<div>`
      so the handler can identify the focused item.
  (c) `EmptyGroupDropZone` switched from `useSortable` to `useDroppable`
      (closes proposal #5 / architect Nit N1 / code-reviewer #2);
      removed the unused `transform`/`transition` plumbing.

## Apply log + post-apply verification (2026-05-08, user-authorized push)

User authorized `npx supabase db push --linked` on 2026-05-08 after the
fix-pass reviewer re-spin returned 0 Critical and 0 AC FAIL across all
four reviewers (test-engineer's prior 2 AC-Q10 FAILs both flipped to
PASS).

```
Applying migration 20260508120000_spec008_profiles_sidebar_layout.sql...
Finished supabase db push.
```

Migration applied without error against project `ebwnovzzkwhsdxkpyjka`.
The column is additive + nullable; no existing data was modified.

### Post-apply verification probes — all PASS

Run via the Supabase MCP `execute_sql` tool against project
`ebwnovzzkwhsdxkpyjka` immediately after push.

| Probe | Expected | Actual | Status |
|---|---|---|---|
| `profiles.sidebar_layout` column exists | true | true | PASS |
| Column type | `jsonb` | `jsonb` | PASS |
| Column nullable | YES | YES | PASS |
| `profiles` row count (informational) | — | 3 | — |
| RLS policy count on `profiles` (unchanged) | 6 | 6 | PASS |
| Migration `20260508120000` registered | true | true | PASS |

Net prod payload: 1 nullable JSONB column added to `profiles`. RLS
policies unchanged (the new column inherits the existing `id = auth.uid()`
row-scoped guard for free, per security-auditor's verification).

### Status flip

`Status: READY_FOR_BUILD` → `Status: READY_FOR_REVIEW`. (Project
convention from Specs 003 / 006 / 007: status flips after prod apply +
post-apply verification.)

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement spec 008 against the design in this file. Split ownership
  per §6's table — backend-developer owns the migration, types, auth.ts +
  db.ts helpers, the new useStore slice + action, and the App.tsx login
  wiring; frontend-developer owns Sidebar.tsx + TreeGroup.tsx changes,
  the new SidebarEditMode.tsx (web-only `dnd-kit` wrapper), the new
  src/lib/sidebarLayout.ts pure-utility module with applySidebarOverride
  + produceOverride, and the InventoryDesktopLayout.tsx wiring. Add
  `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` to
  package.json (frontend-developer). After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
  Do not modify AdminScreens.tsx, useSupabaseStore.ts, useJsonServerSync.ts,
  db.json, or app.json's slug.
payload_paths:
  - specs/008-sidebar-layout-customization.md
