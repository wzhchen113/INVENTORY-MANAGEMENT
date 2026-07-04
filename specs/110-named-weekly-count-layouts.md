# Spec 110: Named, store-shared weekly-count layouts

Status: READY_FOR_REVIEW

> Two related asks from the owner, verbatim: "i want to change 'inventory count'
> from the admin to 'weekly count' same as the staff name. and the custom layout
> to have a save button, that can create 3 customs layouts and name it".
>
> This spec does BOTH: (1) a display-only **rename** of the admin "Inventory
> count" surface to "Weekly count" so it matches the staff label; (2) replacing
> the spec-103 silent auto-saved per-user custom order **on the two Weekly
> surfaces only** with up to **3 named, store-SHARED layouts**. Per the binding
> **OQ-1 ruling (admin-only manage, staff pick)**, only privileged roles (the
> `auth_is_privileged()` set — admin / master / super_admin) can CREATE, RENAME,
> and DELETE the store's layouts, via a **Save** button and rename/delete
> affordances that live **only on the admin Weekly section**; the staff Weekly
> screen becomes **pick-only** (a `Default + <named layouts>` pill row, no Save
> button, no drag). The two EOD surfaces keep their spec-103 per-user auto-saved
> order unchanged.

## User story

As a **store manager (admin "Weekly count" section)**, I want to arrange the
count rows into the path the crew walks the storeroom, press **Save**, and name
that arrangement — and have up to **3 named layouts shared across everyone who
counts at this store** — so I build the walk order once and every counter (admin
and staff) picks the same one instead of each person re-dragging their own; and I
want my admin surface labelled the same "Weekly count" the staff app already
uses. As a **staff counter (staff Weekly count)**, I want to PICK one of those
shared named layouts (or Default) so my count follows the store's agreed walk
order — I do not need to author or edit layouts myself.

Sub-stories:

- **US-1 (rename).** As an admin, I want the sidebar item and section title that
  today read "Inventory count" to read "Weekly count", matching the staff app —
  because it is the same weekly store-wide count, and the two names being
  different is confusing.
- **US-2 (author named layouts — admin only).** As an **admin**, I want to
  arrange rows on the admin Weekly section, press **Save**, and give the
  arrangement a name, so it becomes a reusable, labelled layout for the store
  rather than a nameless auto-saved order. (Only privileged roles author layouts
  — OQ-1.)
- **US-3 (store-shared, up to 3).** As a counter, I want the (≤ 3) named layouts
  to be shared per STORE, so anyone counting at that store sees and can pick the
  same set — an admin builds the walk order once and the whole crew reuses it.
- **US-4 (pick everywhere; manage admin-only).** As **any counter** (admin or
  staff), I want a pill row of `Default + <named layouts>` where I can PICK a
  layout to apply it. As an **admin**, I additionally want to rename and delete
  those layouts, and creating a 4th requires overwriting or deleting one of the
  existing 3. Staff see and pick the same pills but have no rename/delete/Save
  affordances.
- **US-5 (safety preserved).** As a counter, I want a selected layout to behave
  exactly like the spec-103 custom order behaved — a VIEW concern only — so it
  never changes what gets submitted, and the count-everything gate, the "X of N
  counted" label, the red-uncounted marking, and the ingredient-name search all
  keep working, with search composing over the selected layout (spec 103 AC-10).

## Problem / current state (verified in code)

Spec 103 shipped a per-user, private, auto-saved custom order on **four** count
surfaces via `public.user_count_orders`
(`supabase/migrations/20260630000500_user_count_orders.sql`): one row per
`(user_id, screen, vendor_id)`, `item_ids jsonb` ordered array, owner-scoped RLS
(`auth.uid() = user_id`, no admin bypass), with `screen` ∈
`'admin-eod' | 'admin-inventory' | 'staff-eod' | 'staff-weekly'`. The two Weekly
surfaces are `vendor_id NULL` (per-surface, no vendor dimension). Both Weekly
screens today render a **`Default | Custom` two-pill toggle** and, in Custom view,
a flat drag list (`CountOrderDragList` — a cmd variant and a staff variant) that
**auto-saves on every drag** via `saveCountOrder(userId, <screen>, null,
orderedIds)`. Verified anchors (current-state, not prescriptions):

- **Admin "Inventory count"** — `src/screens/cmd/sections/InventoryCountSection.tsx`:
  `viewMode: 'default' | 'custom'` (line 184), loads via
  `fetchCountOrder(uid, 'admin-inventory', null)` (366), auto-saves on drag via
  `saveCountOrder(uid, 'admin-inventory', null, orderedIds)` (391), resets via
  `resetCountOrder(uid, 'admin-inventory', null)` (411), renders
  `CountOrderDragList` (imported line 51), and labels the toggle with
  `T('section.countOrder.viewDefault')` / `viewCustom` / `reset` (i18n block
  `section.countOrder.*`, `src/i18n/en.json:176`).
- **Staff Weekly count** — `src/screens/staff/screens/WeeklyCount.tsx`: the same
  `viewMode` toggle (line 211), `fetchCountOrder(userId, 'staff-weekly', null)`
  (311), `saveCountOrder(userId, 'staff-weekly', null, orderedIds)` on drag (335),
  `resetCountOrder(userId, 'staff-weekly', null)` (349), staff `CountOrderDragList`
  (imported line 39), toggle labelled via the staff catalog `weekly.view.default`
  / `custom` / `reset` (`src/screens/staff/i18n/en.json:48`).

Both Weekly surfaces are windows over the **same underlying store weekly count**
(`inventory_counts` / `inventory_count_entries`). Spec 106 (drafts) also lives on
these two screens and is orthogonal — this spec touches neither the draft table
nor the submit path.

> **Intentional consequence of the OQ-1 + OQ-2 rulings (read before filing a
> regression).** OQ-1 makes layout AUTHORING (create/rename/delete + drag) an
> admin-only capability, and OQ-2 (owner-accepted) removes the surviving per-user
> auto-saved order on the Weekly screens. Together these mean the staff Weekly
> screen **loses the spec-103 drag-to-reorder capability entirely** — staff can no
> longer hand-build or auto-save their own Weekly row order; they can only PICK one
> of the store's shared named layouts (or Default). The drag list survives ONLY in
> the admin Weekly section as the layout-authoring surface. This is a deliberate
> product decision from the two rulings, NOT an accidental capability loss —
> reviewers should treat the staff drag removal as intended. (The two EOD staff/
> admin surfaces keep spec-103 drag + auto-save untouched — R-1.)

**Rename target strings** (display values only — the i18n KEYS and the DB `screen`
tokens `'admin-inventory'` / `'staff-weekly'` stay stable):

| Locale | `sidebar.items.inventoryCount` (line 14) | `section.inventoryCount.title` (line 469) | Target value |
|---|---|---|---|
| en | "Inventory count" | "Inventory count" | **"Weekly count"** |
| es | "Conteo de inventario" | "Conteo de inventario" | **"Conteo semanal"** |
| zh-CN | "库存盘点" | "库存盘点" | **"每周盘点"** |

The staff labels (`weekly.title` = "Weekly count" / "Conteo semanal" / "每周盘点",
`src/screens/staff/i18n/en.json:199`) are **already correct** — the admin values
above are copied to match them exactly. No key rename, no DB-token rename.

## Acceptance criteria

Rename (display-only):

- [ ] **AC-1.** The admin sidebar item and the section header that today render
  "Inventory count" (the `sidebar.items.inventoryCount` + `section.inventoryCount.title`
  values) render **"Weekly count"** in en, **"Conteo semanal"** in es, and
  **"每周盘点"** in zh-CN — byte-identical to the staff `weekly.title` values. The
  i18n KEYS (`inventoryCount`) and the DB `screen` tokens (`'admin-inventory'`,
  `'staff-weekly'`) are UNCHANGED — only the display strings change. A grep for
  the three old admin values in the three catalogs returns zero after the change
  (excluding unrelated keys like `inventoryCountKind` and the "Inventory" nav item
  at `sidebar.items.inventory`, which are NOT touched).

Named layouts — storage + sharing + write authorization (backend):

- [ ] **AC-2.** A store-scoped table exists for named count layouts. Up to **3**
  named layouts may exist **per store**, as ONE shared set that serves BOTH Weekly
  surfaces (admin "Weekly count" and staff Weekly see the identical list). The
  3-per-store cap is enforced server-side (constraint or RPC — architect's call);
  attempting to create a 4th is rejected server-side (the admin FE also prevents it
  — AC-9). Each layout row carries: store scope, a `name`, the ordered `item_ids`
  (JSONB array, spec-103 shape), a stable slot/position, and create/update
  timestamps + a `created_by` author reference. A pgTAP test asserts the cap
  (4th create fails) and store isolation (Store A's layouts are invisible when
  querying as a member of Store B only).
- [ ] **AC-3 (visibility — any store member).** Layouts are **store-SHARED**: any
  member who can see the store (`auth_can_see_store()`) — staff or admin — can READ
  the store's layouts. A user who CANNOT see the store cannot read them (RLS-denied
  → 0 rows). A pgTAP test asserts a member of Store A (including a staff-role
  member) can read Store A's layouts and a non-member cannot. **The shared
  one-set-per-store visibility (both Weekly surfaces see the same list) is
  unchanged by the OQ-1 write-gate.**
- [ ] **AC-3b (write authorization — privileged-only, server-side; OQ-1 ruling).**
  Only a caller in the `auth_is_privileged()` set (admin / master / super_admin)
  may INSERT, UPDATE, or DELETE a `store_count_layouts` row (for a store they can
  see). A non-privileged store member (e.g. a staff-role user) who can READ the
  store's layouts is **denied create / rename / delete server-side** — this gate
  lives in RLS (and/or the SECURITY DEFINER RPC per OQ-6), **NOT** merely in UI
  hiding, so a direct PostgREST/RPC call from a staff session fails. A pgTAP test
  asserts: a privileged member of Store A can INSERT/UPDATE/DELETE its layouts; a
  staff-role member of Store A can SELECT them but is denied INSERT/UPDATE/DELETE
  (RLS WITH CHECK / USING denial or the RPC's role-gate refusal).
- [ ] **AC-4 (admin authors a new layout).** On the **admin** Weekly section, an
  admin arranges rows, presses **Save**, enters a name (with ≤ 2 layouts currently
  existing), and a new layout row is created for the active store with that name
  and the current `item_ids`. It appears in the pill row on BOTH Weekly surfaces
  (admin and staff) for that store after reload (fresh fetch, no client cache).
  Round-trip persistence asserted by a DB test.
- [ ] **AC-5 (admin overwrites the selected layout).** Saving on the **admin**
  section while a named layout is **currently selected** OVERWRITES that layout's
  `item_ids` (and keeps its name) rather than creating a new row — i.e. Save offers
  "overwrite the selected layout" vs "save as a new named layout" (exact affordance
  is the frontend's, but the two outcomes are pinned). Overwrite is persisted and
  reflected on the staff surface after reload.
- [ ] **AC-6 (admin renames / deletes).** On the **admin** section a layout can be
  **renamed** (its `name` updates, `item_ids` unchanged) and **deleted** (the row
  is removed and the pill disappears from BOTH surfaces). Deleting the
  currently-selected layout returns the admin screen to **Default** view; a staff
  screen that had that layout selected falls back to **Default** on its next fetch
  (the pill is gone). Persisted; reflected on the staff surface after reload.
- [ ] **AC-7.** **Concurrency (OQ-3): last-write-wins** by the row's `updated_at`.
  Two admins editing the same layout do not error; the later write wins and the
  earlier is overwritten (no field-level merge). This matches the codebase's
  existing optimistic-write posture; no locking, no conflict UI in v1.

Named layouts — pill row + apply (frontend):

- [ ] **AC-8 (pick, BOTH surfaces).** Each Weekly surface renders a pill row of
  **`Default` + one pill per named layout** (0–3 named pills). Picking `Default`
  renders the screen's built-in order (category-grouped, exactly as spec-103
  `default` view does today — zero change). Picking a named layout applies its
  saved order as a flat Custom view via the existing spec-103 apply path
  (`applyCountOrder(fullItems, savedIds, idOf)`), suppressing category headers
  (spec 103 OQ-2). Picking is available to **any counter** on both surfaces. Works
  on react-native-web (Vercel) AND native (EAS).
- [ ] **AC-8b (author affordances — admin surface ONLY; OQ-1).** On the **admin**
  Weekly section, the pill row additionally exposes: a drag list to (re)arrange the
  selected layout's rows, **rename + delete** per named pill (architect/FE picks
  the exact gesture — e.g. long-press / inline menu), and the **Save** button
  (AC-9). On the **staff** Weekly screen these authoring affordances are **ABSENT**
  — no Save button, no drag list, no rename/delete; the staff pill row is
  **pick-only**. (Consequence of OQ-1 + OQ-2: staff lose the spec-103 Weekly drag
  entirely — see the intentional-consequence callout in "Problem / current state".)
- [ ] **AC-9 (Save — admin surface ONLY).** An explicit **Save** button is present
  **on the admin section** (replacing the spec-103 silent auto-save-on-drag there).
  Pressing Save when a layout is selected → overwrite that layout (AC-5); pressing
  Save with no layout selected (or explicitly choosing "save as new") → prompt for
  a name and create a new layout (AC-4), UNLESS 3 already exist, in which case the
  admin FE blocks the create and directs the admin to overwrite or delete one first
  (AC-2 cap surfaced client-side before the server rejects it — AC-3b). Dragging
  rows updates the on-screen order but does NOT persist until Save is pressed. **No
  Save button exists on the staff surface.**
- [ ] **AC-10.** The ingredient-name search still filters the rendered rows and
  composes with a selected layout on BOTH surfaces: with a search active, the
  visible (matching) rows render in the selected layout's relative order; clearing
  the search restores the full layout order. Search remains render-only and never
  mutates a saved layout. (Spec 103 AC-10 precedent, preserved.)
- [ ] **AC-11.** Submission scope, the "X of N counted" label, the red-uncounted
  marking, and the count-everything gate's "jump to first uncounted" are unchanged
  from spec 103 on BOTH surfaces: submission iterates the full item set
  (`storeInventory` on admin, `items` on staff), never the layout-ordered or
  search-narrowed view; the gate's jump lands on the topmost uncounted row **in the
  selected layout's order** (or the default order when Default is selected). A stale
  item id in a saved layout (item deleted since save) is ignored on apply and never
  crashes the screen (the spec-103 `applyCountOrder` deleted-id tolerance). No count
  RPC is touched.

i18n:

- [ ] **AC-12.** All new strings exist in **all three locales** (en / es / zh-CN)
  in the catalog(s) that actually render them. **Admin catalog** (`src/i18n/*.json`,
  the `section.*` block read via `useT`): the Save button, save-as-new vs overwrite
  choice, name-entry prompt, rename, delete + delete confirm, and the "3 layouts
  max — overwrite or delete one" message (the authoring strings). **Staff catalog**
  (`src/screens/staff/i18n/*.json`, the `weekly.*` block read via `useI18n`): the
  pick-side strings only — the pill labels / any "layout" label the pick-only row
  shows. Because the staff surface has no authoring affordances (AC-8b), the staff
  catalog does NOT need the Save/rename/delete/name-entry strings. No user-visible
  hardcoded English on either surface.

Migration lifecycle:

- [ ] **AC-13 (start fresh — OQ-4).** Existing `user_count_orders` rows for the two
  Weekly `screen` values (`'admin-inventory'`, `'staff-weekly'`) are **not
  migrated** into the new layouts table (start fresh, per R-3). The migration
  **DELETEs** those stale Weekly rows (`where screen in
  ('admin-inventory','staff-weekly')`) so they cannot leak into a stale
  auto-restore — the two EOD `screen` values (`'admin-eod'`, `'staff-eod'`) and
  their rows are **left completely intact** (the EOD surfaces still use them). A
  pgTAP test asserts post-migration that no `user_count_orders` row with a Weekly
  screen value remains and that EOD rows are untouched. (See OQ-4 for the
  delete-vs-ignore decision and its rationale.)

## In scope

- **Rename (display-only):** update the admin `sidebar.items.inventoryCount` and
  `section.inventoryCount.title` display values to "Weekly count" / "Conteo
  semanal" / "每周盘点" in en/es/zh-CN, matching the staff `weekly.title` values.
  Keys and DB `screen` tokens unchanged.
- **A new store-scoped layouts table** (e.g. `store_count_layouts`: `store_id`,
  `name`, `item_ids jsonb`, a slot/position, `created_by`, `created_at`,
  `updated_at`) with **store-member RLS for SELECT** (`auth_can_see_store()`) and a
  **privileged-only write gate** (`auth_is_privileged()` on INSERT/UPDATE/DELETE,
  and/or the SECURITY DEFINER RPC — OQ-1/OQ-6) plus a **3-per-store cap**. ONE
  shared set serving both Weekly surfaces (`vendor_id` absent — Weekly has no
  vendor dimension).
- **Replacing the spec-103 auto-save-on-drag** on the two Weekly surfaces:
  - **admin section** — an explicit **Save** button + a `Default + <named pills>`
    pill row + rename/delete per pill + a name-entry prompt on new-save + a
    save-as-new-vs-overwrite choice + the drag list to arrange the selected layout.
  - **staff screen** — a **pick-only** `Default + <named pills>` pill row (no Save,
    no drag, no rename/delete).
- **Reusing the spec-103 render/apply machinery** verbatim: `applyCountOrder` /
  `firstUncounted` (`src/lib/countOrder.ts`), the flat Custom view that suppresses
  category headers, search composition (AC-10), gate-jump-follows-order (AC-11), and
  the drag component (`CountOrderDragList`) — the cmd variant on the admin authoring
  surface; the staff variant is no longer needed on Weekly (pick-only) though its
  read/apply path is reused for rendering a picked layout.
- **i18n ×3 locales** — admin `section.*` (authoring + pick strings), staff
  `weekly.*` (pick strings only) — per AC-12.
- **The start-fresh migration cleanup** of stale Weekly `user_count_orders` rows,
  leaving EOD rows intact (AC-13).
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **The two EOD count surfaces** (staff EOD `EODCount.tsx`; admin EOD
  `EODCountSection.tsx`). They KEEP the spec-103 per-user, private, auto-saved,
  per-vendor custom order via `user_count_orders` unchanged (R-1). Rationale: EOD is
  per-vendor and the owner scoped this feature to the Weekly surfaces only;
  converting EOD to shared named layouts is a possible later spec.
- **Staff-authored or per-user layouts on the Weekly surfaces (OQ-1 + OQ-2).** Staff
  cannot create/rename/delete layouts (OQ-1: privileged-only), and the surviving
  per-user auto-saved order is removed (OQ-2). There is NO staff Weekly drag, NO
  staff Save, and NO personal auto-saved pill on either Weekly surface. Rationale:
  the two rulings; keeping the pill row to ≤ 4 entries (Default + 3) and layout
  authorship in privileged hands. A future "staff propose a layout" or "my private
  layout too" mode is an explicit later spec, not v1.
- **More than 3 layouts per store**, or a layout LIBRARY / folders / per-vendor
  Weekly layouts. Hard cap of 3, one shared set, no vendor dimension. Rationale:
  the owner said "3 customs layouts"; Weekly has no vendor axis.
- **Field-level merge / conflict-resolution UI.** Concurrency is whole-row
  last-write-wins by `updated_at` (OQ-3). Rationale: consistent with the codebase's
  optimistic-write posture; a merge UI is disproportionate for a shared view pref
  only admins write.
- **Changing what a Weekly count submits, or any count RPC.** `submitInventoryCount`
  (admin) and `submitWeeklyCount` (staff, with its `client_uuid` idempotency) are
  untouched — layouts are render-only (AC-11). Rationale: this is a view/ordering
  feature, exactly as spec 103 was.
- **The spec-106 draft table / draft flow.** `user_count_drafts` and the Save-draft
  affordance are a separate, orthogonal feature that also lives on these screens;
  this spec does not read, write, or repurpose the draft table. Rationale: drafts
  persist in-progress ENTRY state; layouts persist row ORDER — different concerns.
  On the admin section the two "Save" buttons (Save draft vs Save layout) must be
  visually distinct so they are not confused — flagged for the frontend (see Project
  notes). (Note: the staff Weekly screen keeps its spec-106 Save-DRAFT button —
  drafts are per-user and unaffected by OQ-1; only the LAYOUT authoring is removed
  from staff.)
- **Realtime propagation of layout changes.** A newly-saved/renamed/deleted layout
  need not push live to other clients mid-session; it is picked up on the next
  screen open / fetch. Rationale: same posture as `user_count_orders` (not in the
  `supabase_realtime` publication). See OQ-5 and Project notes for the publication
  gotcha as a flagged ABSENCE.
- **Renaming the admin `screen` DB token or the i18n keys.** Only the display
  values change (AC-1). Rationale: the `'admin-inventory'` token is load-bearing in
  `countOrder.ts`, `user_count_orders`, and the spec-106 draft path; renaming it is
  gratuitous churn and would break the EOD-adjacent code that shares the vocabulary.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched
  (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

### Owner rulings collected (binding — cited throughout)

- **R-1 (surfaces).** Weekly screens ONLY — staff Weekly (`WeeklyCount.tsx`) +
  admin "Inventory count" section (`InventoryCountSection.tsx`, renamed "Weekly
  count" by AC-1). The two EOD screens keep the spec-103 single per-user
  auto-saved order UNCHANGED.
- **R-2 (sharing).** Layouts are shared per STORE — store-wide, anyone counting at
  that store can PICK them. NOT per-user. (Who may MANAGE them is OQ-1, below.)
- **R-3 (migration).** Start fresh — existing `user_count_orders` rows for the
  Weekly screens are NOT migrated. (This spec resolves delete-vs-ignore in OQ-4.)

- **OQ-1 — Who can create / rename / delete layouts? (OWNER RULING — binding;
  reversed the PM recommendation).** The PM recommended ANY store member; the owner
  ruled the OTHER way.
  → **A: ADMIN-ONLY MANAGE, STAFF PICK.** Only privileged roles — the
  `auth_is_privileged()` set (admin / master / super_admin) — may CREATE, RENAME,
  and DELETE a store's shared layouts. Staff (and any non-privileged store member)
  may only SELECT/PICK a layout when counting. Consequences threaded through the
  ACs: (a) the Save / rename / delete affordances + the drag list exist ONLY on the
  admin Weekly section (AC-8b, AC-9); the staff Weekly pill row is pick-only with no
  Save button; (b) because OQ-2 also removes the per-user auto-saved order, staff
  lose the spec-103 Weekly drag-to-reorder ENTIRELY — an intentional consequence of
  the two rulings, not a regression (callout in "Problem / current state"); (c) the
  write-side gate is enforced **server-side** — RLS (SELECT via
  `auth_can_see_store()`; INSERT/UPDATE/DELETE additionally gated on
  `auth_is_privileged()`) and/or the SECURITY DEFINER RPC (OQ-6) — **not** by UI
  hiding alone, so a direct call from a staff session is refused (AC-3b). This
  mirrors the existing privileged-write pattern in the codebase (`auth_is_privileged`
  is the admin-OR-super-admin DB predicate; the edge-function `ADMIN_ROLES` set is
  its TS mirror).

- **OQ-2 — Does the per-user custom order survive as an extra personal option on the
  Weekly screens alongside the shared layouts? (OWNER-ACCEPTED default.)**
  → **A: NO — replaced entirely.** The Weekly custom order is fully superseded by
  the shared named layouts; there is no surviving personal auto-saved pill on either
  Weekly surface. Combined with OQ-1 this removes the staff Weekly drag entirely
  (above). Rationale: R-3 "start fresh"; keeps the pill row to ≤ 4 entries
  (`Default` + up to 3 named); a surviving per-user order would reintroduce the
  `user_count_orders` Weekly writes the migration is deleting. **Owner-accepted as
  written.**

- **OQ-3 — Concurrency: two admins editing the same layout. (OWNER-ACCEPTED
  default.)**
  → **A: whole-row LAST-WRITE-WINS by `updated_at`.** The later Save overwrites; no
  lock, no conflict UI, no field-level merge (AC-7). Consistent with the codebase's
  optimistic-then-revert posture. **Owner-accepted as written.**

- **OQ-4 — Do stale Weekly `user_count_orders` rows get DELETED by the migration or
  IGNORED? (OWNER-ACCEPTED default.)**
  → **A: DELETED.** The migration removes rows where `screen in
  ('admin-inventory','staff-weekly')` (AC-13), leaving the EOD rows (`'admin-eod'`,
  `'staff-eod'`) intact. Rationale: (a) once the Weekly screens no longer call
  `fetchCountOrder`/`saveCountOrder`, those rows are dead weight nothing reads; (b)
  DELETE is a clean, explicit "start fresh" (R-3) rather than leaving orphan rows a
  future refactor might resurrect; (c) it is a bounded, targeted `DELETE ... WHERE
  screen IN (...)` that cannot touch EOD rows or any other table. **Owner-accepted
  as written.**

- **OQ-5 — Realtime: should a new/renamed/deleted layout push live to other clients
  mid-session? (OWNER-ACCEPTED default.)**
  → **A: NO.** The layouts table is NOT added to the `supabase_realtime`
  publication; other clients pick up changes on their next screen open / fetch (same
  posture as `user_count_orders`, spec 103 §11). Rationale: a shared view pref does
  not need live push, and adding the table to the publication drags in the
  mid-session-publication `docker restart supabase_realtime_imr-inventory` gotcha
  (project memory) for negligible benefit. **Owner-accepted as written**; flagged in
  Project notes as a deliberate ABSENCE.

- **OQ-6 — Cap + write-gate enforcement mechanism: DB constraint/RLS vs RPC.
  (OWNER-ACCEPTED — architect's call on mechanism.)**
  → **A: architect's call, but two observables are pinned:** (1) the 3-per-store cap
  rejects a 4th create server-side, atomically (AC-2); (2) the privileged-only write
  gate refuses non-privileged writes server-side (AC-3b). PM lean given OQ-1: a
  SECURITY DEFINER RPC (`save_store_count_layout` / `rename_store_count_layout` /
  `delete_store_count_layout`) that internally asserts `auth_is_privileged()` AND
  `auth_can_see_store(store_id)` AND (for create) `count(*) < 3` in one serialized
  transaction is the cleaner path — it co-locates the role gate, the store gate, and
  the cap, and avoids a naive `CHECK` (which cannot count siblings) and a
  create-create race. **If** the architect prefers plain PostgREST like spec 103,
  then the RLS write policies MUST gate on `auth_is_privileged()` (per AC-3b) and the
  cap needs a `BEFORE INSERT` trigger that raises when the store already has 3.
  Either way the SELECT policy stays `auth_can_see_store()` (AC-3) and the write path
  is privileged-only and atomic. The architect fixes the mechanism in the design doc.
  **Owner-accepted (mechanism deferred to architect).**

## Dependencies

- **Spec 103 (live)** — the render/apply machinery this spec REUSES verbatim on
  the Weekly surfaces: `applyCountOrder` / `firstUncounted` (`src/lib/countOrder.ts`),
  the flat Custom view + category-header suppression (OQ-2), search composition
  (AC-10), gate-jump-follows-order (AC-11), and the drag component
  (`CountOrderDragList`) — the cmd variant on the admin authoring surface. This spec
  CHANGES the storage (shared `store_count_layouts` rows, not per-user
  `user_count_orders` rows), the trigger (explicit admin Save, not auto-save-on-drag),
  and the authorization (privileged-only manage) on the two Weekly surfaces ONLY; it
  leaves the spec-103 EOD path fully intact.
- **A new migration** — creates `store_count_layouts` (store-scoped, `name`,
  `item_ids jsonb`, slot/position, `created_by`, timestamps), RLS with a
  **SELECT gate of `auth_can_see_store()`** and a **write gate of
  `auth_is_privileged()`** on INSERT/UPDATE/DELETE (and/or the OQ-6 SECURITY DEFINER
  RPC), explicit `grant … to authenticated` per the spec-097 posture, the
  3-per-store cap (OQ-6), AND the AC-13 cleanup `DELETE` of stale Weekly
  `user_count_orders` rows. Must pass the spec-053 `permissive_policy_lint` probe
  (store-scoped SELECT and privileged-gated writes are not trivially-wide). Applied
  to prod via the Supabase MCP (project memory "Prod migration via Supabase MCP" —
  `db push` lacks the prod password), then the exact version inserted into
  `schema_migrations` so `db-migrations-applied.yml` (spec 064) stays green. The
  developer FLAGS the prod-apply in the handoff; they do not push it themselves.
- **`auth_can_see_store()` and `auth_is_privileged()`**
  (`supabase/migrations/20260504173035_per_store_rls_hardening.sql` and the
  privileged-role predicate) — the store-visibility gate (SELECT) and the
  admin-OR-super-admin gate (write) the layouts RLS/RPC uses. Both work for the admin
  JWT; `auth_can_see_store()` also works for the staff JWT (staff read layouts).
- **`src/lib/db.ts`** — new admin-path helpers (list / create / rename / delete /
  overwrite layout), `track()`-wrapped, snake↔camel-mapped, mirroring the spec-103
  `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` block. If the cap + write-gate
  are an RPC (OQ-6) the write helpers call the RPC; the list (SELECT) helper goes
  through PostgREST either way.
- **The staff-subtree carve-out** (`src/screens/staff/`, spec 063) — a parallel
  staff-local helper that only READS the store's layouts
  (`supabase.from('store_count_layouts').select(...)`, the documented carve-out),
  re-exporting the shared pure `countOrder.ts` helpers so the apply logic stays
  single-sourced. The staff path has **no** create/rename/delete helper (staff cannot
  write — OQ-1).
- **i18n catalogs** — the admin `section.*` block (`src/i18n/*.json`) gains the
  authoring + pick strings; the staff `weekly.*` block (`src/screens/staff/i18n/*.json`)
  gains the pick-side strings only (AC-12); the admin `sidebar.items.inventoryCount`
  + `section.inventoryCount.title` values are edited for the rename (AC-1).
- **Existing helpers reused (no change):** `confirmAction`
  (`src/utils/confirmAction.ts`) for the admin delete confirm; the shared
  `applyCountOrder`/`firstUncounted`; the `CountOrderDragList` cmd variant.

## Project-specific notes

- **Cmd UI section / legacy:** admin side lands in the existing
  `src/screens/cmd/sections/InventoryCountSection.tsx` (renamed "Weekly count" by
  AC-1) — a Cmd UI section, not legacy (no legacy admin surface; spec 025 deleted
  it). This is the layout-AUTHORING surface. Staff side is
  `src/screens/staff/screens/WeeklyCount.tsx` (folded in, spec 063) — pick-only.
- **Which app:** this repo only — admin Cmd UI + the folded-in staff surface. No
  sibling-app (customer PWA) work.
- **Per-store or admin-global:** **per-store, with a privileged-only write gate** —
  the deliberate DIVERGENCE from spec 103 (whose `user_count_orders` was
  per-USER/owner-scoped). Named layouts are **store-scoped and shared**: SELECT RLS
  gates on `auth_can_see_store()` (R-2 — any member reads/picks), and
  INSERT/UPDATE/DELETE gate additionally on `auth_is_privileged()` (OQ-1 — only
  admin/master/super_admin write). `store_id` is a first-class column and the access
  axis for reads; `created_by` records attribution but does NOT gate access (any
  privileged member can edit any of the store's layouts). Do NOT use
  `auth.uid() = user_id` (wrong model — these are shared, not owner-private).
- **Server-side write gate is load-bearing (not UI-only).** Per AC-3b, hiding the
  Save/rename/delete controls on the staff surface is necessary but NOT sufficient —
  a staff session must be refused a direct PostgREST/RPC write server-side. The
  reviewer/security-auditor should confirm the write gate is in RLS/RPC, not just the
  absent staff UI. This mirrors the CLAUDE.md convention that destructive/privileged
  operations enforce the gate server-side (edge-function `ADMIN_ROLES` ⇄
  `auth_is_privileged()` parity), applied here to the layout write path.
- **Realtime channels touched:** **none — deliberate ABSENCE (OQ-5).**
  `store_count_layouts` is NOT added to the `supabase_realtime` publication; no
  `store-{id}` / `brand-{id}` channel replays it (matches `user_count_orders`). The
  mid-session-publication `docker restart supabase_realtime_imr-inventory` gotcha
  (project memory) therefore does NOT apply to this migration — flagged as an ABSENCE
  so the deploy checklist isn't padded. Other clients see a new/renamed/deleted
  layout on their next screen open.
- **Migrations needed:** **yes** — one additive migration: create
  `store_count_layouts` + store-member SELECT RLS + privileged-only write gate +
  explicit grants + the 3-per-store cap (OQ-6) + the AC-13 cleanup DELETE of stale
  Weekly `user_count_orders` rows (the DELETE is the only non-additive hunk, and it
  is a bounded `WHERE screen IN ('admin-inventory','staff-weekly')` that cannot touch
  EOD rows or any other table). Prod-apply via Supabase MCP + `schema_migrations`
  insert (spec 064 gate).
- **Two "Save" buttons on the admin screen (flag for frontend):** spec 106 already
  put a **Save draft** button on both Weekly surfaces; this spec adds a **Save
  layout** button **on the admin section only**. On the admin section they persist
  different things (in-progress entries vs row order) and MUST be visually and
  textually distinct (distinct labels in all three locales, distinct placement) so
  admins do not confuse them. The staff Weekly screen keeps its Save-DRAFT button but
  gains NO Save-layout button (OQ-1). Called out so the frontend-developer designs
  for the coexistence rather than rediscovering it.
- **Edge functions touched:** none expected — PostgREST + RLS on a store-scoped
  table, or a Postgres RPC via `db.ts` / the staff read-only carve-out (OQ-6). No
  `staff-*` / service-token / `pwa-catalog` bearer surface involved.
- **Web/native scope:** **both.** Admin ships web (Vercel) + native (EAS); the staff
  Weekly screen runs on native and web. The admin authoring affordances (pill row,
  Save button, rename/delete, drag, name-entry prompt) and the staff pick-only pill
  row all render on both platforms — the drag component already works on RNW + native
  (spec 103 OQ-6). No web-only affordance.
- **`app.json` slug:** untouched — this feature has no bearing on build identifiers;
  `slug` stays `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):**
  - **pgTAP** (primary): (a) SELECT visibility — a member of Store A (INCLUDING a
    staff-role member) can read Store A's layouts; a non-member cannot (AC-3). (b)
    **Write authorization (OQ-1) — a privileged member of Store A can
    INSERT/UPDATE/DELETE its layouts; a staff-role member of Store A can SELECT but
    is DENIED INSERT/UPDATE/DELETE server-side** (AC-3b) — this is the headline new
    assertion the ruling adds. (c) The 3-per-store cap — a 4th create fails
    atomically (AC-2/OQ-6). (d) Store isolation — Store A's layouts absent when
    querying as a Store-B-only member. (e) Round-trip persistence + rename + delete
    (AC-4/AC-5/AC-6). (f) The AC-13 migration cleanup — no Weekly-screen
    `user_count_orders` row remains post-migration; EOD rows untouched. (g) The
    spec-053 permissive-policy lint arm scans the new policies automatically
    (`auth_can_see_store()` SELECT + `auth_is_privileged()`-gated writes are not
    trivially-wide — no allowlist edit expected).
  - **jest**: any extracted pure helper (the "which layout is selected / can I save a
    4th / overwrite-vs-new" predicate on the admin side, if factored out) and
    confirmation that the reused `applyCountOrder`/`firstUncounted` still produce the
    spec-103 render order and gate-jump against a selected layout's `item_ids`. The
    submission-scope invariant (AC-11: submitted set byte-identical regardless of
    selected layout) is a jest assertion on the Weekly submit builders.
  - **shell smoke**: none anticipated.

---

## Backend design

Author: backend-architect. Resolves OQ-6 (mechanism) and pins every server-side
observable OQ-1/AC-2/AC-3/AC-3b require. Reuses the spec-103 render/apply
machinery verbatim (`src/lib/countOrder.ts`); the ONLY changes below the render
layer are **storage** (new shared `store_count_layouts` table, not per-user
`user_count_orders`), **write trigger** (explicit admin Save via RPC, not
auto-save-on-drag), and **authorization** (privileged-only, server-side). No
edge functions, no realtime publication change.

### 0. Mechanism decision (OQ-6): SECURITY DEFINER RPCs for writes, PostgREST for reads

**Reads (SELECT)** go through **PostgREST** on the table, gated by an RLS SELECT
policy of `auth_can_see_store(store_id)` — identical posture to `inventory_items`
et al. (`20260504173035_per_store_rls_hardening.sql`). This is what lets the
staff carve-out do a plain `supabase.from('store_count_layouts').select(...)`.

**Writes (create / overwrite / rename / delete)** go through **three SECURITY
DEFINER RPCs**, NOT direct PostgREST:

- `save_store_count_layout(...)` — create-or-overwrite (AC-4 / AC-5), atomic cap.
- `rename_store_count_layout(...)` — rename (AC-6).
- `delete_store_count_layout(...)` — delete (AC-6).

Rationale for RPC-over-plain-PostgREST on the write side (the PM lean in OQ-6,
confirmed here):

1. **The 3-per-store cap must be atomic under concurrent creates.** A `CHECK`
   constraint cannot count sibling rows. A `BEFORE INSERT` trigger *can*, but two
   concurrent `INSERT`s both see `count = 2` and both commit (the classic
   count-then-insert race — Postgres does not take a predicate lock on the
   not-yet-inserted rows). The clean fix is to serialize the count+insert inside
   one SECURITY DEFINER function that takes a **transaction advisory lock keyed on
   `store_id`** (`pg_advisory_xact_lock(hashtext('store_count_layouts:' ||
   store_id::text))`) before counting. This makes "count < 3 then insert" a
   critical section per store, so a 4th concurrent create loses the race
   deterministically and is refused — the atomicity AC-2/OQ-6 demand.
2. **Co-locates the two gates.** The RPC asserts `auth_is_privileged()` (role
   gate, OQ-1) AND `auth_can_see_store(store_id)` (store gate) in the function
   body, in one place, mirroring the established pattern
   (`demote_profile_to_user`, `20260520000000`; the admin RPCs,
   `20260517020000`). SECURITY DEFINER bypasses RLS so the inline gates are the
   authorization source of truth.
3. **Defense-in-depth RLS still lands.** Even though writes flow through the
   RPCs, the table ALSO carries `auth_is_privileged() AND auth_can_see_store()`
   RLS write policies (INSERT/UPDATE/DELETE). This closes the "what if someone
   curls PostgREST directly against the table" hole (AC-3b explicitly requires a
   direct staff PostgREST/RPC write to fail), and matches the `eod_submissions`
   posture where the RPC gate and the RLS gate enforce the same boundary
   (`staff_role_eod_rls.test.sql` assertions (5) + (6)). The RPCs are the
   *authoritative* path; the RLS write policies are the belt-and-braces.

This is the same "RPC gate + parallel RLS gate" shape spec 061 landed for
`staff_submit_eod`. It is NOT a new pattern — it is the codebase's standard for a
privileged, store-scoped, cap-or-invariant-bearing write.

### 1. Data model changes

**New table** `public.store_count_layouts`. Proposed migration filename:

    supabase/migrations/20260704000000_store_count_layouts.sql

(sorts after the latest on disk, `20260630000500_user_count_orders.sql`;
references only pre-existing `public.stores` + `public.profiles`, so ordering is
safe.)

Columns:

| column       | type                       | notes |
|--------------|----------------------------|-------|
| `id`         | `uuid pk default gen_random_uuid()` | surface identity for rename/delete/overwrite targeting. |
| `store_id`   | `uuid not null references public.stores(id) on delete cascade` | the access axis (SELECT RLS + write gate). Cascade so deleting a store cleans its layouts. |
| `name`       | `text not null` | display label. CHECK: `length(btrim(name)) between 1 and 60` (rejects empty/whitespace-only and overlong — AC name validation; the RPC also trims + re-checks). |
| `item_ids`   | `jsonb not null default '[]'::jsonb` | spec-103 shape: ordered array of `inventory_items.id` as text. CHECK `jsonb_typeof(item_ids) = 'array'`. Applied client-side by the pure `applyCountOrder` (deleted-id tolerant). |
| `position`   | `smallint not null` | **slot 1..3** (see §1.1). CHECK `position between 1 and 3`. |
| `created_by` | `uuid null references public.profiles(id) on delete set null` | attribution only — does NOT gate access (any privileged member edits any of the store's layouts). `set null` so deleting the author profile does not delete the shared layout. |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()` | last-write-wins key (OQ-3 / AC-7). The RPCs set it explicitly on every overwrite/rename. |

**No `vendor_id` column** — Weekly is vendor-less (R-1; the two Weekly surfaces
are the `vendor_id NULL` family in spec 103). One shared set serves both Weekly
surfaces (AC-2).

**Slot decision (§1.1): explicit `position smallint` 1..3, NOT unslotted.**

The 3-per-store cap could be expressed either as a count cap on unslotted rows or
as three fixed slots. I choose an **explicit `position` slot (1..3)** because:

- It gives the pill row a **stable left-to-right order** across reloads for free
  (`order by position`) — an unslotted table would order by `created_at` (fine)
  but a slot makes "overwrite slot 2" / "the 2nd pill" unambiguous and lets the FE
  key pills by a small stable integer.
- The cap becomes a **partial unique index** (`unique (store_id, position)`) which
  is a hard structural guarantee a 4th distinct slot cannot exist, *complementing*
  (not replacing) the RPC's atomic count. The RPC picks the lowest free slot
  (`1..3`) inside the advisory-locked section; if all three are taken it refuses.

The `position` is an internal ordering key, NOT user-facing "slot naming" — the
owner asked for named layouts, and `name` carries the label. `position` is just
the deterministic pill order + the uniqueness lever.

**Constraints / indexes:**

- `primary key (id)`.
- `unique (store_id, position)` — one layout per (store, slot); the structural cap
  ceiling (with `position` CHECK 1..3, at most 3 rows per store). Call it
  `store_count_layouts_store_position_uq`.
- **No** unique constraint on `(store_id, name)` — **per-store name uniqueness is
  NOT enforced at the DB level.** Rationale: the owner spec never asks for it; two
  layouts named "Walk A" are harmless (they are picked by `id`, ordered by
  `position`); and a hard name-unique constraint would make the overwrite-vs-new
  affordance (AC-5/AC-9) throw an opaque `23505` instead of the intended
  last-write-wins. If the FE wants to *warn* on a duplicate name it can do so
  client-side, but the server does not reject it. (Surfaced as **open question
  OQ-A** below in case the owner wants server-enforced name uniqueness — default
  is NOT enforced.)
- Index for the read path: the `unique (store_id, position)` index already covers
  `where store_id = $1 order by position` (leading column `store_id`), so **no
  separate index is needed** — same reasoning as spec 103 §1.3.

**Destructive vs additive / rollout safety:** the table + policies + RPCs are
**purely additive** (fresh table, no change to any existing table's shape). The
**only non-additive hunk in the migration is the AC-13 cleanup DELETE** on
`public.user_count_orders` (§3). Instant in PG 17 (no backfill; the 286 KB seed
adds zero layout rows — layouts are authored at runtime). Reversible-by-design:
`drop table public.store_count_layouts cascade;` + `drop function
save_store_count_layout / rename_store_count_layout / delete_store_count_layout;`
fully removes the feature (the repo has no down-migration convention).

**Grants (spec-097 explicit-grant posture — defense-in-depth):** re-state
explicitly even though `20260618000000_public_grants_explicit.sql` default
privileges cover a postgres-owned table (matches `user_count_orders`,
`item_vendors`):

    grant select, insert, update, delete, references, trigger
      on public.store_count_layouts to anon, authenticated;
    grant all on public.store_count_layouts to service_role;

(The direct INSERT/UPDATE/DELETE grants to `authenticated` are harmless because
RLS still gates them to privileged callers — grants are necessary-not-sufficient.
TRUNCATE deliberately omitted for anon/authenticated.)

### 2. RLS impact

Enable RLS; four policies on the new table, each a **single permissive policy per
command** (no `auth.uid() IS NOT NULL` OR-arm — the CLAUDE.md OR-compose /
permissive-shadow discipline). Policy names + helper:

| command | policy name | USING / WITH CHECK |
|---------|-------------|--------------------|
| SELECT | `store_member_read_count_layouts` | `using (public.auth_can_see_store(store_id))` — **any** member (staff or admin), AC-3. |
| INSERT | `privileged_insert_count_layouts` | `with check (public.auth_is_privileged() and public.auth_can_see_store(store_id))` — AC-3b. |
| UPDATE | `privileged_update_count_layouts` | `using (...) with check (...)` both `auth_is_privileged() and auth_can_see_store(store_id)` — AC-3b. |
| DELETE | `privileged_delete_count_layouts` | `using (public.auth_is_privileged() and public.auth_can_see_store(store_id))` — AC-3b. |

Notes:

- The SELECT gate is `auth_can_see_store()` only (NOT `auth_is_privileged()`) so
  staff-role members **read/pick** (AC-3). The write gates AND
  `auth_is_privileged()` on top of the store gate (OQ-1 / AC-3b).
- **Permissive-policy lint (spec 053):** all four predicates reference
  `auth_can_see_store(store_id)` / `auth_is_privileged()` — neither is
  trivially-wide (`auth.uid() IS NOT NULL` / `true` / `auth.role() =
  'authenticated'`), and there is no OR-tail. **No `permissive_policy_lint`
  allowlist edit is required** (the SELECT policy is the identical shape to the
  `inventory_items` SELECT policy the probe already tolerates). This mirrors the
  spec-103 note (`user_count_orders_rls.test.sql:41-43`).
- **No pre-existing permissive policy exists on `store_count_layouts`** (brand-new
  table) — so there is no OR-shadow risk from a legacy wide policy on the same
  `(table, cmd)` pair. `pg_policies` was checked: nothing references this table
  name.
- **No changes to any existing table's policies.** `user_count_orders` policies
  are untouched (only rows are deleted, §3).

### 3. AC-13 cleanup DELETE (the one non-additive hunk)

Bounded, targeted, in the same migration, AFTER the CREATE/policy/RPC/grant
block:

    delete from public.user_count_orders
     where screen in ('admin-inventory', 'staff-weekly');

- Removes the two Weekly `screen` families' rows so a stale auto-restore can't
  leak (OQ-4 / AC-13). Cannot touch the two EOD families (`'admin-eod'`,
  `'staff-eod'`) — those rows and the EOD path are left completely intact (R-1).
- Bounded `WHERE screen IN (...)`; cannot touch any other table. Idempotent (a
  re-run deletes zero further rows once the Weekly screens stop writing them —
  which they do after the FE change lands).

### 4. API contract

Reads: **PostgREST** on the table. Writes: **three RPCs**. Error mapping follows
the codebase convention (P0001 → HTTP 400; 42501 → HTTP 403; P0002 → HTTP 404),
matching `demote_profile_to_user`.

#### 4.1 List (PostgREST SELECT — admin path via db.ts, staff path via carve-out)

Request: `from('store_count_layouts').select('id,name,item_ids,position,updated_at').eq('store_id', storeId).order('position')`.
Response: 0–3 rows. RLS returns 0 rows to a non-member (AC-3). No error on empty
(→ Default only).

#### 4.2 `save_store_count_layout` — create OR overwrite (AC-4 / AC-5 / OQ-6 cap)

    save_store_count_layout(
      p_store_id  uuid,
      p_name      text,
      p_item_ids  jsonb,
      p_layout_id uuid default null   -- null → create; non-null → overwrite that row
    ) returns uuid                    -- the created/overwritten layout id

Body order (cheapest-fail-first, mirrors `demote_profile_to_user`):

1. `auth.uid()` null → `42501 'forbidden'` (fail-closed; defense-in-depth).
2. `not auth_is_privileged()` → `42501 'forbidden'` (OQ-1 role gate).
3. `not auth_can_see_store(p_store_id)` → `42501 'forbidden'` (store gate).
4. Normalize + validate name: `v_name := btrim(p_name)`; if
   `length(v_name) not between 1 and 60` → `P0001 'layout name required'` (empty)
   / `P0001 'layout name too long'` (>60). Validate `jsonb_typeof(p_item_ids) =
   'array'` → `P0001 'item_ids must be an array'`.
5. **Overwrite branch** (`p_layout_id is not null`): `update store_count_layouts
   set name = v_name, item_ids = p_item_ids, updated_at = now() where id =
   p_layout_id and store_id = p_store_id returning id`. If `not found` → `P0002
   'layout not found'`. (Last-write-wins, AC-7 — no field merge, no optimistic
   version check.) Returns the id. Note: overwrite does NOT touch `position` (the
   pill keeps its slot) — AC-5 "keeps its name/slot".
6. **Create branch** (`p_layout_id is null`): take
   `pg_advisory_xact_lock(hashtext('store_count_layouts:' || p_store_id::text))`;
   compute the lowest free slot: `select min(s) from generate_series(1,3) s where
   s not in (select position from store_count_layouts where store_id =
   p_store_id)`. If none free (already 3) → `P0001 'layout limit reached'` (AC-2 /
   OQ-6 — the atomic 4th-create refusal; the FE also pre-blocks per AC-9, but this
   is the server-side backstop). Else `insert (... position = v_slot, created_by =
   auth.uid()) returning id`. The advisory lock is released at transaction end,
   serializing concurrent creates for the same store so the count is race-free.

`security definer set search_path = public, auth`. `revoke execute ... from
public, anon; grant execute ... to authenticated;` (mirrors
`demote_profile_to_user` — no anon, no service_role; `auth.uid()` is null for
service_role anyway and step 1 fail-closes it).

#### 4.3 `rename_store_count_layout` — rename (AC-6)

    rename_store_count_layout(p_layout_id uuid, p_name text) returns uuid

Body: steps 1–3 identical role/store gate — but the store gate resolves the
`store_id` FROM the row first: `select store_id into v_store from
store_count_layouts where id = p_layout_id`; if `not found` → `P0002 'layout not
found'`; then `not auth_can_see_store(v_store)` / `not auth_is_privileged()` →
`42501 'forbidden'`. Validate + trim name (step 4 above). `update ... set name =
v_name, updated_at = now() where id = p_layout_id`. `item_ids` unchanged (AC-6).
Returns id. Same grants.

#### 4.4 `delete_store_count_layout` — delete (AC-6)

    delete_store_count_layout(p_layout_id uuid) returns uuid

Body: resolve `store_id` from the row (→ `P0002 'layout not found'` if absent);
role + store gate (→ `42501 'forbidden'`); `delete from store_count_layouts where
id = p_layout_id`. Returns the deleted id (so the FE knows which pill to drop).
Same grants. (A staff screen that had this layout selected falls back to Default
on its next fetch because the row — and its pill — is gone; AC-6. No server action
needed for that fallback; it is a client render concern.)

**Error cases summary (all three RPCs):** non-privileged caller → 403
(`'forbidden'`); non-member store → 403; missing/empty/overlong name → 400;
4th create → 400 (`'layout limit reached'`); overwrite/rename/delete of a
non-existent id → 404 (`'layout not found'`); bad `item_ids` → 400.

### 5. Edge function changes

**None.** No edge function is created or modified. No `verify_jwt` decision, no
service-token validation — this is PostgREST + RLS + Postgres RPCs entirely, per
"Edge functions touched: none expected" in Project notes. (The staff path does NOT
go through a `staff-*` service-token function — those are HTTP 410 stubs; the
staff app talks to PostgREST directly, spec 061.)

### 6. `src/lib/db.ts` surface

New helpers, `track()`-wrapped, snake→camel-mapped, placed adjacent to the
spec-103 `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` block. camelCase
shape:

```ts
export type StoreCountLayout = {
  id: string;
  name: string;
  itemIds: string[];   // from item_ids jsonb array
  position: number;    // from position smallint (1..3)
  updatedAt: string;   // from updated_at (ISO)
};

// LIST (PostgREST SELECT; read). RLS scopes to store members; 0 rows for a
// non-member or an empty store → []. Maps each row snake→camel via a local
// mapStoreCountLayout() helper (item_ids → itemIds, updated_at → updatedAt).
export async function fetchStoreCountLayouts(
  storeId: string,
): Promise<StoreCountLayout[]>;

// CREATE-OR-OVERWRITE (RPC save_store_count_layout; write). layoutId null →
// create (server assigns the slot, enforces the atomic 3-cap); non-null →
// overwrite that layout's name + item_ids (last-write-wins). Returns the
// created/overwritten id. Throws the PostgREST error on refusal (403/400/404)
// so the section reverts + notifyBackendError.
export async function saveStoreCountLayout(
  storeId: string,
  name: string,
  itemIds: string[],
  layoutId?: string | null,
): Promise<string>;

// RENAME (RPC rename_store_count_layout; write). Returns the id.
export async function renameStoreCountLayout(
  layoutId: string,
  name: string,
): Promise<string>;

// DELETE (RPC delete_store_count_layout; write). Returns the deleted id.
export async function deleteStoreCountLayout(
  layoutId: string,
): Promise<string>;
```

The three write helpers call `supabase.rpc('<fn>', { ... }).abortSignal(signal)`
inside `useInflight.getState().track(..., { kind: 'write', label })` — identical
shape to `demoteProfileToUser` (`src/lib/db.ts:4150`). The list helper is
`{ kind: 'read', label: 'fetchStoreCountLayouts' }`. RPC arg names are the
snake_case `p_*` params from §4 (PostgREST passes the JS object keys verbatim as
named args).

**Staff carve-out (read-only)** — new file
`src/screens/staff/lib/countLayouts.ts` (parallel to the existing
`src/screens/staff/lib/countOrder.ts`). It exports ONE function that reads the
store's layouts via the documented direct-`supabase` carve-out:

```ts
// staff READ-ONLY (carve-out). NO create/rename/delete — staff cannot write
// (OQ-1). Same camelCase shape as the admin StoreCountLayout; re-exports the
// pure applyCountOrder/firstUncounted from ../../../lib/countOrder so the apply
// logic stays single-sourced (same pattern as staff/lib/countOrder.ts).
export async function fetchStoreCountLayouts(
  storeId: string,
): Promise<StoreCountLayout[]>;    // supabase.from('store_count_layouts')...
export { applyCountOrder, firstUncounted } from '../../../lib/countOrder';
```

No `track()` on the staff side (plain `await`, matching the staff
`countOrder.ts`). No write helper exists in the staff subtree — a staff attempt
to write would have to hand-roll an RPC call, which the RLS/RPC role gate refuses
server-side anyway (AC-3b).

### 7. Realtime impact

**None — deliberate ABSENCE (OQ-5, owner-accepted).** `store_count_layouts` is
**NOT added to the `supabase_realtime` publication.** No `store-{id}` /
`brand-{id}` channel replays a layout create/rename/delete; other clients pick up
changes on their next screen open / fetch (same posture as `user_count_orders`,
spec 103). **Publication note (stated explicitly per the repo gotcha):** because
this migration makes **zero** `alter publication supabase_realtime add table ...`
change, the mid-session-publication `docker restart
supabase_realtime_imr-inventory` ritual **does NOT apply** to this migration —
there is nothing to re-snapshot. This is flagged as an ABSENCE so the deploy/dev
checklist is not padded with a restart step that is not needed here. (If a future
spec decides layouts SHOULD push live, THAT spec adds the table to the publication
and inherits the `docker restart` requirement — not this one.)

### 8. Frontend store impact

**Admin (`src/store/useStore.ts`):** the layout list + selection is **section-local
React state** in `InventoryCountSection.tsx`, NOT a Zustand slice — mirroring the
spec-103 `savedIds`/`viewMode` which are section-local `React.useState`
(`InventoryCountSection.tsx:184-185`), and the spec-106 draft state. No new
Zustand slice is needed; the section already reads `currentStore` (for
`storeId`) and `currentUser` from the store. The **optimistic-then-revert +
`notifyBackendError`** pattern applies to the three write helpers (Save / rename /
delete): the section optimistically mutates its local layout list, calls the
helper, and on a thrown error reverts the local list + surfaces the toast — the
identical shape to the spec-103 `onReorder`/`onResetOrder` catch blocks
(`InventoryCountSection.tsx:391-399`, `411-419`). Note the create-cap (AC-9) is
pre-checked client-side against the local list length before calling
`saveStoreCountLayout` with `layoutId = null`, so the server `'layout limit
reached'` refusal is a backstop, not the primary UX.

**Staff (`src/screens/staff/store/useStaffStore.ts`):** likewise **screen-local
state** in `WeeklyCount.tsx` (which already reads `activeStore` + `userId` from
the staff store, `WeeklyCount.tsx:198-199`). The staff surface only READS layouts
(pick-only) — no write, so no optimistic-revert on the staff side; picking a pill
is a pure render switch (Default vs a layout's `item_ids` through
`applyCountOrder`). The staff store slice does not change; the layout list is
fetched screen-locally on open, keyed on `activeStore.id`.

### 9. Render-side reuse (spec 103 machinery — storage + trigger change only)

The pill-apply, flat-Custom-view (category-header suppression), `firstUncounted`
gate-jump, and search composition are **reused verbatim from spec 103** — this
spec changes ONLY (a) where the ordered id array comes FROM (a picked
`store_count_layouts.item_ids` instead of the per-user `user_count_orders`
row) and (b) WHEN it is saved (explicit admin Save via RPC, not
auto-save-on-drag). Concretely on both surfaces: picking a named layout sets
`savedIds := layout.itemIds` and `viewMode := 'custom'`, then the existing
`applyCountOrder(fullItems, savedIds, idOf)` produces the render list; picking
Default sets `savedIds := null` → default order. The gate-jump (`firstUncounted`
over the applied order, AC-11) and search composition (AC-10) are unchanged code
paths. The admin drag list (`CountOrderDragList` cmd variant) now edits the
selected layout's on-screen order and persists ONLY on Save (AC-9) — no
per-drag write. Deleted-id tolerance (a stale id in a saved layout) is the
existing `applyCountOrder` behavior (AC-11), so no new handling.

### 10. Rename slice (AC-1) — frontend-only, no backend surface

The admin label rename (`sidebar.items.inventoryCount` + `section.inventoryCount.title`
display values → "Weekly count" / "Conteo semanal" / "每周盘点" ×3 locales, to
match the staff `weekly.title` values) is **display-only** — it edits i18n catalog
VALUES only. The i18n KEYS (`inventoryCount`) and the DB `screen` tokens
(`'admin-inventory'`, `'staff-weekly'`) are UNCHANGED. **This has no backend
surface whatsoever** — no migration, no RLS, no RPC, no db.ts change. It is a pure
frontend-developer task (verified anchors: `src/i18n/en.json:14` and `:469`, plus
the es/zh-CN siblings).

### 11. pgTAP plan (the backend developer must pin these)

New test file `supabase/tests/store_count_layouts.test.sql`, JWT-claims-injection
shape mirroring `staff_role_eod_rls.test.sql` + `user_count_orders_rls.test.sql`
(`set local role authenticated` + `request.jwt.claims` with `app_metadata.role`;
hermetic `begin; ... rollback;`). Fixtures reuse the seed profiles used by the
spec-103 test: **A = `22222222-2222-2222-2222-222222222222`** (seed manager, app
role `'user'` — the **staff-role** stand-in; `user_stores` = Towson + Frederick),
**B = `11111111-1111-1111-1111-111111111111`** (seed admin — the **privileged**
member). Store A = a store A/B are members of (e.g. **Frederick**); Store B-only =
**Charles** (the manager is NOT a member — the non-member negative). Cases:

1. **Privileged create within cap.** As admin B (member of Frederick): `select
   save_store_count_layout(frederick, 'Walk A', '["i1","i2"]', null)` succeeds and
   returns an id; a row exists at `(store_id=frederick, position=1)`.
2. **Round-trip / list.** As B, list Frederick's layouts → the created row with
   the expected `name` + `item_ids` (AC-4). Create two more (`position` 2, 3).
3. **4th create refused atomically.** As B, a 4th `save_store_count_layout(...,
   null)` on Frederick → `throws_ok(..., 'P0001', ...)` (`'layout limit reached'`)
   — the cap (AC-2 / OQ-6). (Serialized-count assertion: the advisory-lock path is
   exercised by the 4th-create refusal; a true concurrency race is out of pgTAP's
   single-session scope, so the atomicity is asserted structurally via the
   `unique (store_id, position)` index test in case (11) below + the count logic.)
4. **Overwrite (AC-5).** As B, `save_store_count_layout(frederick, 'Walk A2',
   '["i9"]', <layout1_id>)` → row 1's `item_ids` = `["i9"]`, `name` = 'Walk A2',
   `position` unchanged = 1, and the row COUNT for Frederick is still 3 (overwrote,
   did not create). `updated_at` advanced (last-write-wins, AC-7).
5. **Rename (AC-6).** As B, `rename_store_count_layout(<id>, 'Renamed')` → `name`
   updates, `item_ids` unchanged.
6. **Delete (AC-6).** As B, `delete_store_count_layout(<id>)` → row gone; Frederick
   layout count drops by 1; a subsequent create can now reuse the freed slot.
7. **Staff-role member SELECTs but is DENIED writes (AC-3b — the headline).** As
   manager A (role `'user'`, member of Frederick): (a) `select ... from
   store_count_layouts where store_id = frederick` → returns the rows (SELECT
   allowed, AC-3); (b) `save_store_count_layout(frederick, 'x', '[]', null)` →
   `throws_ok(..., '42501', ...)` (`'forbidden'` — RPC role gate); (c) a **direct
   PostgREST-style** `insert into store_count_layouts (store_id, name, position,
   item_ids) values (frederick, 'x', 1, '[]')` → `throws_ok(..., '42501', ...)`
   (RLS WITH CHECK denial — defense-in-depth, proves the gate is not merely in the
   RPC); (d) direct `update` / `delete` of an existing Frederick layout as A →
   0 rows affected / RLS-denied (stash-then-assert `row_count = 0` for update/
   delete, matching `user_count_orders_rls.test.sql` cases (4)/(5)).
8. **Non-member sees nothing + cannot write (store isolation, AC-2/AC-3).** As
   manager A (NOT a member of Charles): `select ... where store_id = charles` → 0
   rows; `save_store_count_layout(charles, ...)` → `42501` (store gate). Seed a
   Charles layout via the postgres role (RLS bypass) first, then confirm A sees 0
   (mirrors `staff_role_eod_rls.test.sql` case (8)).
9. **Privileged non-member is also store-gated.** As admin B — but for a store B
   is NOT a member of AND is not admin-visible: verify `auth_can_see_store` is the
   real gate. (Admins have cross-store visibility via `auth_is_admin()` inside
   `auth_can_see_store`, so pick the scenario carefully — this arm confirms the
   store gate composes correctly for the admin path; if all seed stores are
   admin-visible, assert instead that B CAN write to any store B can see and note
   admin cross-store visibility is intended.)
10. **Name validation.** As B: `save_store_count_layout(frederick, '', '[]',
    null)` → `P0001` (`'layout name required'`); `save_store_count_layout(frederick,
    repeat('x', 61), '[]', null)` → `P0001` (`'layout name too long'`); a
    whitespace-only name `'   '` → `P0001` (trimmed to empty).
11. **Structural cap ceiling.** A direct `insert` (postgres role, RLS bypassed)
    of a 4th DISTINCT `position` for a store violates the `position between 1 and 3`
    CHECK / a duplicate `position` violates `store_count_layouts_store_position_uq`
    → `throws_ok(..., '23514' /* check */ or '23505' /* unique */, ...)`. This pins
    the belt-and-braces structural cap independent of the RPC.
12. **AC-13 migration cleanup.** After the migration, assert `select count(*) from
    user_count_orders where screen in ('admin-inventory','staff-weekly')` = 0 AND
    `select count(*) from user_count_orders where screen in ('admin-eod','staff-eod')`
    is unchanged (EOD rows intact). Seed a Weekly row + an EOD row in the test's
    own transaction is NOT the right shape (the migration already ran); instead
    assert the invariant holds against the migrated DB. **Note for the dev:** the
    cleanest pin is a dedicated arm that inserts one Weekly + one EOD row as a
    privileged user, then re-runs the exact cleanup `DELETE` statement and asserts
    the Weekly row is gone and the EOD row survives — testing the DELETE predicate's
    scoping rather than relying on migration replay order.

**Permissive-policy lint (spec 053):** the existing `permissive_policy_lint.test.sql`
auto-scans the four new policies; `auth_can_see_store()` / `auth_is_privileged()`
are not trivially-wide → **no allowlist edit** (assert-by-absence; the lint stays
green with zero changes).

**jest:** if the FE factors out a pure predicate (`canSaveNewLayout(count) =>
count < 3`, or the overwrite-vs-new selection resolver), unit it. Confirm the
reused `applyCountOrder`/`firstUncounted` still produce the spec-103 render order
+ gate-jump against a picked layout's `item_ids` (existing `countOrder` jest
suite covers the pure functions; add a case feeding a `store_count_layouts`-shaped
id array). The AC-11 submission-scope invariant (submitted set byte-identical
regardless of selected layout) is a jest assertion on the Weekly submit builders —
unchanged from spec 103, re-confirm it still holds.

### 12. Prod-apply note (this migration creates a table + policies — NOT body-only)

Per project memory "Prod migration via Supabase MCP" — `supabase db push` lacks
the prod password, so the migration is applied to prod (project
`ebwnovzzkwhsdxkpyjka`) via the **Supabase MCP `execute_sql`**, then the **exact
migration version** (`20260704000000`) is inserted into
`supabase_migrations.schema_migrations` so the `db-migrations-applied.yml` gate
(spec 064) stays green. **The developer FLAGS the prod-apply in the handoff; they
do NOT push it themselves.**

**This migration is NOT body-only** (unlike `demote_profile_to_user`) — it
creates a **table + indexes + 4 RLS policies + 3 functions + grants + a DELETE**.
So the post-apply verification is broader than the normalized-md5 function check
used for body-only RPC migrations:

- **Table + columns:** `select column_name, data_type from
  information_schema.columns where table_schema='public' and
  table_name='store_count_layouts'` matches the §1 shape.
- **Constraints/indexes:** `store_count_layouts_store_position_uq` exists;
  the `position between 1 and 3` and `length(btrim(name)) between 1 and 60` and
  `jsonb_typeof(item_ids)='array'` CHECKs present (`pg_constraint`).
- **RLS:** `select policyname, cmd, qual, with_check from pg_policies where
  tablename='store_count_layouts'` returns exactly the four §2 policies with the
  `auth_can_see_store` / `auth_is_privileged` predicates; RLS is enabled
  (`relrowsecurity`).
- **Functions:** the three RPCs exist with the §4 signatures and are SECURITY
  DEFINER with `search_path = public, auth`; EXECUTE granted to `authenticated`,
  revoked from `anon`/`public` (`has_function_privilege`).
- **Grants:** table grants match the §1 grant block.
- **AC-13 DELETE landed:** `select count(*) from user_count_orders where screen in
  ('admin-inventory','staff-weekly')` = 0 in prod post-apply; EOD count unchanged
  (capture the EOD count BEFORE applying so the "unchanged" claim is verifiable).
- Then insert the exact version into `schema_migrations` and confirm
  `db-migrations-applied.yml` is green on the next run.

### 13. Open question surfaced to the PM/owner (non-blocking)

- **OQ-A (server-enforced per-store name uniqueness?).** The design does **NOT**
  enforce `(store_id, name)` uniqueness at the DB level (default: two layouts may
  share a name; they are picked by `id`, ordered by `position`). If the owner
  wants the server to *reject* a duplicate name (rather than the FE merely warning),
  add a `unique (store_id, lower(btrim(name)))` index and have
  `save_store_count_layout` map its `23505` to `P0001 'layout name already exists'`.
  Flagged because a hard name-unique constraint interacts with the
  overwrite-vs-new affordance (AC-5) — the default keeps last-write-wins simple.
  **Not a blocker;** the build proceeds with the non-enforced default unless the
  owner rules otherwise.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend: author the
  `20260704000000_store_count_layouts.sql` migration (table + 4 RLS policies +
  3 SECURITY DEFINER RPCs + explicit grants + the AC-13 cleanup DELETE) exactly
  per §1–§4, the four db.ts helpers (§6) + the staff read-only carve-out
  `src/screens/staff/lib/countLayouts.ts`, and the pgTAP suite
  `store_count_layouts.test.sql` pinning every case in §11. Do NOT add the table
  to the `supabase_realtime` publication (§7). Flag the prod-apply via Supabase
  MCP in your handoff (§12) — do not push it yourself. Frontend: the AC-1 rename
  (§10, display-only i18n values ×3 locales), the admin Weekly authoring surface
  (Save button + `Default + named` pill row + rename/delete + name-entry prompt +
  overwrite-vs-new + drag persists only on Save) reusing the spec-103 machinery
  (§9), the staff pick-only pill row (no Save/drag/rename/delete), i18n strings
  ×3 locales (admin authoring+pick; staff pick-only), and keep the spec-106
  Save-draft button visually distinct from the new Save-layout button on the admin
  section. After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/110-named-weekly-count-layouts.md

## Files changed

### Backend (backend-developer)

Migrations:
- `supabase/migrations/20260706000000_store_count_layouts.sql` — NEW. Creates
  `public.store_count_layouts` (id / store_id / name / item_ids / position 1..3 /
  created_by / created_at / updated_at; no vendor_id) with the 3 CHECK
  constraints (name trim 1..60, item_ids array, position 1..3) + the
  `store_count_layouts_store_position_uq` unique index (structural 3-cap ceiling);
  the 4 RLS policies (SELECT `auth_can_see_store`; INSERT/UPDATE/DELETE
  `auth_is_privileged() and auth_can_see_store()` defense-in-depth); the 3
  SECURITY DEFINER RPCs `save_store_count_layout` / `rename_store_count_layout` /
  `delete_store_count_layout` (role gate + store gate + atomic 3-cap via
  `pg_advisory_xact_lock` on store_id; P0001/42501/P0002 → 400/403/404); explicit
  grants (table grants to anon/authenticated + service_role per spec-097; EXECUTE
  revoked from public/anon, granted to authenticated on the 3 RPCs); and the
  AC-13 bounded cleanup `DELETE FROM public.user_count_orders WHERE screen IN
  ('admin-inventory','staff-weekly')` (EOD rows intact). NOT added to
  `supabase_realtime` (§7). **VERSION NOTE:** the design draft named
  `20260704000000`, but that version is taken by `po_loop` and `20260705000000`
  by `cost_on_receipt` (both already in prod) — this migration uses
  `20260706000000`.

src/lib/db.ts:
- Added the `StoreCountLayout` camelCase type + `mapStoreCountLayout` local
  helper + four helpers (`fetchStoreCountLayouts` [PostgREST SELECT, read] /
  `saveStoreCountLayout` / `renameStoreCountLayout` / `deleteStoreCountLayout`
  [the 3 write RPCs]), `track()`-wrapped, adjacent to the spec-103
  `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` block. The spec-103 helpers
  are UNCHANGED (still exported for the EOD path + the frontend's in-progress
  section migration).

src/screens/staff/lib/ (staff read-only carve-out):
- `src/screens/staff/lib/countLayouts.ts` — NEW. Read-only staff carve-out:
  `fetchStoreCountLayouts` (direct `supabase.from('store_count_layouts')`) +
  re-exports `applyCountOrder`/`firstUncounted` from `../../../lib/countOrder`.
  NO write helper (staff cannot write — OQ-1).

Tests:
- `supabase/tests/store_count_layouts.test.sql` — NEW. pgTAP suite, plan(27),
  pinning every §11 case: privileged create within cap, round-trip/list, 4th
  create refused (P0001), overwrite (item_ids/name/position/count/updated_at),
  rename, delete + slot reuse, staff-role member SELECTs but is DENIED writes
  (RPC 42501 + direct-INSERT RLS 42501 + direct UPDATE/DELETE 0-rows), non-member
  isolation, privileged admin cross-store visibility, name validation
  (empty/overlong/whitespace), structural cap CHECK (23514), AC-13 cleanup
  predicate. Green locally + in the full `npm run test:db` (63/63 files).
- `src/lib/db.storeCountLayouts.test.ts` — NEW. jest (12 tests) pinning the four
  db.ts helpers (PostgREST list snake→camel + order-by-position; the 3 write RPCs
  called with the exact `p_*` args; throw-on-error). Mirrors the spec-103
  `db.saveCountOrder.test.ts` precedent.

### Frontend (frontend-developer)

AC-1 rename (display-only i18n values; keys + DB screen tokens unchanged):
- `src/i18n/en.json` — `sidebar.items.inventoryCount` + `section.inventoryCount.title`
  → "Weekly count" (byte-match the staff `weekly.title`). Also ADDED the
  `section.countLayout.*` authoring strings block.
- `src/i18n/es.json` — same two values → "Conteo semanal" + the
  `section.countLayout.*` block (Spanish).
- `src/i18n/zh-CN.json` — same two values → "每周盘点" + the `section.countLayout.*`
  block (Chinese).
- `src/screens/staff/i18n/en.json` / `es.json` / `zh-CN.json` — ADDED the
  pick-only `weekly.layout.*` block (`default` + `loadFailed`) in all three
  locales. Staff `weekly.title` was already "Weekly count" (unchanged).

Admin Weekly authoring surface:
- `src/screens/cmd/sections/InventoryCountSection.tsx` — replaced the spec-103
  Default|Custom toggle + auto-save-on-drag with the spec-110 pill row (Default +
  one pill per named layout) + explicit Save-layout (overwrite selected / create
  new via the name modal, client-blocked at 3) + Save-as-new + Rename + Delete
  (confirm-gated) + the drag list persisting ONLY on Save. Removed the
  `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` (`admin-inventory`) usage;
  layout list + selection are section-local state (design §8). Renders the new
  `CountLayoutNameModal`. Reuses the spec-103 `applyCountOrder`/`firstUncounted`
  render/gate/search machinery verbatim (§9). The spec-106 Save-DRAFT button
  (tab-strip) is untouched and visually/verbally distinct from Save-layout.
- `src/components/cmd/CountLayoutNameModal.tsx` — NEW. Lean cross-platform RN
  `Modal` name-entry (create + rename); single text input + Save/Cancel; Esc/Enter
  on web; i18n-driven; testIDs. NOT `window.prompt` (per the spec).

Staff Weekly pick-only surface:
- `src/screens/staff/screens/WeeklyCount.tsx` — replaced the spec-103 Default|Custom
  toggle + reset + drag entry with a PICK-ONLY pill row (Default + up to 3 named
  pills; no Save, no drag, no reset — OQ-1). Loads layouts via the staff read-only
  carve-out `../lib/countLayouts` (`fetchStoreCountLayouts`); a picked layout applies
  through the existing spec-103 `applyCountOrder` flat-Custom-view machinery
  (render + gate-jump + search unchanged). Removed the `CountOrderDragList` import +
  the spec-103 `onReorder`/`onResetOrder` write path from THIS screen. The spec-106
  Save-DRAFT footer button + the EOD surfaces are untouched. Selection persists in
  screen-local state (per-user/per-device, not server state).

Store I/O wrappers:
- `src/store/useStore.ts` — ADDED four thin `notifyBackendError`-funneled I/O
  wrappers (`fetchStoreCountLayouts` / `saveStoreCountLayout` /
  `renameStoreCountLayout` / `deleteStoreCountLayout`) over the db.ts §6 helpers,
  same shape as `submitInventoryCount` (return value-or-null; the section runs its
  optimistic-then-revert around the call). No new Zustand slice — the list +
  selection are section-local (design §8).

Tests (jest):
- `src/screens/cmd/sections/__tests__/InventoryCountSection.layouts.test.tsx` —
  NEW (8 tests). Full-render authoring coverage: pill row (Default + named), AC-1
  renamed "Weekly count" header, Save-no-selection opens the modal → create (AC-4),
  Save-with-selection overwrites without a prompt (AC-5), 3-cap refused CLIENT-SIDE
  (toast, no modal, no RPC — AC-9), Rename opens prefilled → rename action (AC-6),
  Delete confirm-gated → delete action + return to Default (AC-6), Cancel = no RPC.
- `src/screens/staff/screens/WeeklyCount.test.tsx` — REPLACED the spec-103 custom-
  order describe with a spec-110 PICK-ONLY describe (6 tests): pick-only row (no
  save/drag/reset affordances; Save-DRAFT present), Default-only with 0 layouts,
  apply a picked layout as flat Custom view (AC-8), submission byte-identical with
  Default vs a picked layout (AC-11), search composes with the layout (AC-10),
  gate-jump follows the picked layout order (AC-11). Added a `store_count_layouts`
  branch + `mockLayoutsResult` to the supabase mock builder.
- `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx` —
  UPDATED the db.ts mock to add inert `fetchStoreCountLayouts` +
  save/rename/delete stubs (the section now fetches layouts on mount via the store
  action; without the stub the spec-106 AC-14 assertion tripped on a "Load layouts
  failed" toast).

**Frontend verification:** `npx tsc --noEmit` + `npx tsc -p tsconfig.test.json
--noEmit` both exit 0; full `npx jest` green (85 suites / 948 tests). Web-bundle
verification: the full Expo web bundle (`AppEntry.bundle`) compiles HTTP 200
against the local stack with the migration applied, with zero resolve/transform
errors for any changed module, and the compiled bundle contains the new
`CountLayoutNameModal` / `fetchStoreCountLayouts` / `inv-layout-*` /
`weekly-layout-*` / `layout-name-input` symbols + the renamed "Weekly count" /
"Conteo semanal" / "每周盘点" label bytes. (The interactive `preview_*` browser
tools were not available in this environment; the pill-row / Save / rename / delete
/ name-modal golden paths + the renamed-label edge case are exercised by the
full-render jest suites above, which drive both screens via testIDs.)

**Prod-apply (FLAGGED — not done by the developer; §12):** this migration is NOT
body-only (table + indexes + 4 policies + 3 functions + grants + a DELETE). Per
project memory "Prod migration via Supabase MCP", apply to prod (project
`ebwnovzzkwhsdxkpyjka`) via the Supabase MCP `execute_sql`, then insert the exact
version `20260706000000` into `supabase_migrations.schema_migrations` so
`db-migrations-applied.yml` (spec 064) stays green. Capture the EOD
`user_count_orders` count BEFORE applying so the "EOD unchanged" claim is
verifiable post-apply. Applied + recorded locally already (direct psql +
schema_migrations insert).
