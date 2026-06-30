# Spec 103: Per-user custom drag-to-reorder for count screens

Status: READY_FOR_REVIEW

## User story

As a store manager or staff counter, I want to drag the ingredient rows on a
count screen into the exact order I walk my storeroom in, saved to my own
account, so that my next count follows my physical path — without my arrangement
changing what anyone else sees.

Sub-stories:

- **US-1 (manual arrangement).** As a counter, I want to drag a row up or down
  to any position and have that arrangement become the render order on that
  screen — not pick a sort criterion from a dropdown, but build the order by
  hand.
- **US-2 (private per-user).** As a counter, I want my arrangement saved to my
  own account and applied only for me; another user counting the same store sees
  their own arrangement (or the default), never mine.
- **US-3 (independent per screen).** As a counter who uses all four count
  surfaces, I want a separate saved arrangement on each surface, so reordering
  one screen never moves rows on the others.
- **US-4 (reset).** As a counter, I want a per-screen "reset to default order"
  affordance, so I can discard my arrangement and return to the screen's
  built-in order.
- **US-5 (safety preserved).** As a counter, I want the custom order to behave
  like the existing name-search — a view concern only — so it never changes
  which items get submitted, and the existing count-everything gate, "X of N
  counted" label, and red-uncounted marking keep working.

## Acceptance criteria

Storage + privacy (backend):

- [ ] AC-1: A per-user store exists for saved orders. A signed-in user can read
  and write ONLY their own order rows; an attempt to read or write another
  user's order rows is denied by RLS (the policy gates on the caller's
  `auth.uid()` equalling the owning user column). A pgTAP test asserts user A
  cannot SELECT or UPSERT user B's order under any of the four screen keys.
- [ ] AC-2: Saved orders are keyed by `(user, screen[, scope])` where `screen`
  is one of exactly four stable identifiers — admin-eod, admin-inventory,
  staff-eod, staff-weekly (final string values are the architect's call; see
  OQ-7). The four keys are independent: writing one never mutates another
  (asserted by test).
- [ ] AC-3: Saving an order and reloading the screen (fresh fetch, no client
  cache) renders the rows in the saved order. Round-trip persistence is asserted
  by a test on the chosen storage path.
- [ ] AC-4: Reset removes (or empties) the caller's saved order for one screen
  key only; after reset that screen renders the screen's default order and the
  other three keys are untouched (asserted by test).

Drag UX + apply (frontend), all four surfaces:

- [ ] AC-5: On each of the four screens a user can initiate a drag on an
  ingredient row (via an explicit drag handle or long-press — affordance is
  OQ-6) and drop it at a new position; on drop the new arrangement becomes the
  visible render order. Works on react-native-web (Vercel) AND native (EAS).
- [ ] AC-6: The arrangement persists on drop (no separate "save" press). After a
  successful drop the new order is written to the per-user store; a failed write
  surfaces via the screen's existing `notifyBackendError` path and does not
  corrupt the on-screen order.
- [ ] AC-7: On screen open the saved order is fetched and applied as the initial
  render order before the user interacts; while the order is loading the screen
  shows its normal list/skeleton (no flash of default-then-reorder is required,
  but the loaded order MUST win once it arrives).
- [ ] AC-8: A per-screen "reset to default order" affordance is present and,
  when used, returns the screen to its default order (the same order it shows
  for a user with no saved arrangement) and persists the reset (AC-4).

Coexistence with existing behavior (all four surfaces):

- [ ] AC-9 (submission unchanged): Submission scope is identical with and
  without a custom order. The custom order is render-only — `buildSubmission` /
  the `onSubmit` entry-builder still iterate the full item set
  (`filteredItems` on admin EOD, `storeInventory` on admin Inventory, `items` on
  staff EOD and staff Weekly), never the reordered view alone. A test asserts
  the submitted entry set is byte-identical for the same inputs regardless of
  arrangement.
- [ ] AC-10 (search composes): The existing ingredient-name search still filters
  the rendered rows. When a search is active the visible (matching) rows render
  in the user's custom relative order; clearing the search restores the full
  custom order. Search remains render-only and does not alter the saved
  arrangement.
- [ ] AC-11 ("X of N counted" unchanged): The live "X of N counted" label counts
  the same set in the same way regardless of arrangement (it is order-
  independent), and the red-uncounted row marking still applies per row. No
  change to either is required beyond not breaking them.
- [ ] AC-12 (gate follows custom order): The count-everything gate still blocks
  submit until every item is counted. When it blocks, "jump to the first
  uncounted item" lands on the TOPMOST uncounted row in the USER'S CUSTOM ORDER
  (not alphabetical, not category-grouped default) — i.e. the first uncounted
  row as the user currently sees them top-to-bottom. A test asserts the jump
  target is the first uncounted row in the active custom order.
- [ ] AC-13 (admin EOD / staff Weekly category interaction): The custom order
  coexists with category grouping on the two grouped screens per the resolution
  of OQ-2 (the architect's design states whether it is reorder-within-category
  or a flat "Custom" view that suppresses category headers). Whichever is
  chosen, the gate's jump (AC-12) and submission scope (AC-9) remain correct.
- [ ] AC-14 (new / unranked items): An item with no saved rank (newly added to
  the store, or present before the user ever reordered) appears at a defined,
  documented position per OQ-3 (default: appended after all ranked items, in the
  screen's default relative order) and is fully countable. It never silently
  disappears from the list.

## In scope

- A new per-user, RLS-scoped storage path for saved row orders, with read/write
  limited to the owning user (AC-1).
- Four independent saved arrangements per user, one per count surface (AC-2):
  - admin EOD count — `src/screens/cmd/sections/EODCountSection.tsx`
  - admin Inventory count — `src/screens/cmd/sections/InventoryCountSection.tsx`
  - staff EOD count — `src/screens/staff/screens/EODCount.tsx`
  - staff Weekly count — `src/screens/staff/screens/WeeklyCount.tsx`
- Drag-to-reorder UX on each screen, working on web (Vercel) and native (EAS).
- Persist-on-drop, load-and-apply-on-open, and a per-screen reset-to-default
  affordance.
- Preserving every recently-shipped count behavior: the count-everything gate,
  the "X of N counted" label, the red-uncounted marking, and the ingredient-name
  search — with the gate's jump following the custom order.
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **Sort-by-criterion (name / category / par / vendor) dropdowns.** The user
  chose manual drag; an automatic sort mode is a different feature. Not built.
- **Shared / store-wide / role-wide orders.** Orders are private per user
  (US-2). A "manager publishes a recommended order to staff" feature is a
  separate future spec.
- **Reordering anywhere other than the four count surfaces.** Other lists
  (recipes, brand catalog, reports, history tabs, the EOD week rail, the vendor
  tab strip) keep their current ordering. Out of scope — they are not count
  entry surfaces.
- **Cross-device ordering nuance beyond "saved to the account."** The order is
  stored server-side per user, so it follows the account across devices by
  construction; no extra per-device handling is specified.
- **Changing what a count submits, or any RPC that writes counts.** Submission
  contracts (`submitEOD` / `submitEODCount`, `submitInventoryCount`,
  `staff_submit_eod`, `submitWeeklyCount`) are untouched — the sort is render-
  only (AC-9). If the architect finds the order can be derived/applied entirely
  client-side from a single read, no count RPC changes at all.
- **Persisting the order through the EOD per-vendor draft maps, EDIT mode, or
  the inventory `kind` selector.** Those are unrelated session states; the saved
  order is orthogonal to them.
- **Realtime propagation of order changes.** A private per-user view preference
  does not need to push live to other clients; the admin realtime channels are
  not involved (see Project-specific notes).
- **Animated reorder polish beyond a functional drag.** A working drag-and-drop
  that lands the row in the new slot satisfies the spec; bespoke spring
  animations are not required.

## Open questions resolved

- Q: Sort type — drag-to-reorder or sort-by-criterion?
  → A: Manual drag-to-reorder. The user builds the arrangement by hand.
- Q: Whose order is it / who can see it?
  → A: Per-user and private. New per-user storage with RLS so a user reads/writes
  only their own rows; invisible to and unaffected by other users.
- Q: One order across all screens, or separate per screen?
  → A: Separate, independent order per screen — four surfaces, four keys.
- Q: Which surfaces?
  → A: All four count screens (the two admin Cmd sections + the two staff
  screens) listed above.
- Q: Is a "reset to default order" wanted?
  → A: Yes — a per-screen reset affordance is in scope (US-4 / AC-8). Exact
  placement is OQ-5.

## Open questions (for the architect — noted, not blocking)

These are design/storage/UX-shape decisions appropriate to resolve in the design
doc. None changes the user-confirmed scope above.

- **OQ-1 (EOD per-vendor key granularity).** The two EOD screens show a
  different item subset per vendor tab (admin: `vendorItems` for the selected
  tab; staff: `fetchItemsForVendor` for the selected vendor). Is the saved EOD
  order ONE ranking for the whole EOD surface (applied to whichever vendor's
  subset is on screen) or a SEPARATE ranking per vendor tab? "Separate per
  screen" suggests per-surface, but this directly changes the storage key
  (`screen` vs `(screen, vendor)`). PM lean: per-surface single ranking applied
  to each tab's subset, with unranked items appended (OQ-3) — simplest mental
  model and storage. Architect to confirm.
- **OQ-2 (category grouping vs flat custom order).** Admin EOD (`grouped` memo)
  and staff Weekly (`sections` memo) currently render category-grouped. Does a
  hand-built custom order (a) reorder rows WITHIN each category (categories stay,
  order is per-category), or (b) switch the screen to a flat "Custom" view that
  suppresses category headers and honors one global hand-built order? Affects
  AC-13 and the gate's jump (AC-12). Admin Inventory also groups by category but
  the same resolution should apply for consistency. Needs the user's call if the
  architect can't pick a clearly-better default; PM lean: (b) a flat Custom view,
  since the whole point is matching a physical walk that crosses categories.
- **OQ-3 (placement of new / unranked items).** Where does an item with no saved
  rank appear until the user places it — appended at the end (PM default), or
  inserted at its default position? Default in AC-14 is "appended after all
  ranked items in the screen's default relative order"; confirm.
- **OQ-4 (reset affordance placement + confirm).** Where does the per-screen
  reset control live on each surface (admin Cmd `rightSlot` cluster vs a list-
  header control; staff header vs footer), and does reset need a confirm
  (`confirmAction`) or is it a one-tap undo-via-redrag? PM lean: one-tap, no
  confirm (re-dragging is the undo), placement per each screen's existing header
  chrome.
- **OQ-5 (storage shape).** Architect's call, flagged: a per-`(user, screen[,
  vendor], item)` `sort_index` row-per-item table vs a per-`(user, screen)`
  single row holding a JSONB ordered id array. Must define how the order stays
  consistent when items are added to / removed from the store (orphaned ids
  ignored on read; new ids appended per OQ-3). Note the project DB-access
  convention: admin reads/writes route through `src/lib/db.ts`; the
  `src/screens/staff/` subtree has a documented carve-out to call
  `supabase.from/rpc` directly — so the staff screens may read/write the order
  store directly while the admin screens go through `db.ts`.
- **OQ-6 (drag mechanism, web + native).** Architect/frontend call: a library
  (e.g. an RN draggable-list package that supports react-native-web) vs a hand-
  rolled handle + gesture. Must work on BOTH react-native-web (Vercel) and
  native (EAS). Note the admin and staff surfaces have different component stacks
  (admin: `ScrollView`/`FlatList` + Cmd UI; staff: its own components + theme +
  `FlatList`/`SectionList`), and staff Weekly deliberately renders the whole
  list un-windowed (spec 102) so the gate jump can reach any row — the drag
  approach must not reintroduce windowing that breaks that.
- **OQ-7 (screen key string values).** The four stable `screen` identifiers'
  exact string values (e.g. `admin-eod` vs `eod-admin`) are the architect's to
  fix in the contract; AC-2 only requires four stable, independent keys.

## Dependencies

- Existing count screens and their derivations (verified against code; see
  "Current state of the four screens"). The custom sort wraps each screen's
  existing render-order step.
- The auth session / `auth.uid()` (Supabase email+password; per-store RLS
  hardening migration `20260504173035_per_store_rls_hardening.sql`) for the
  owning-user RLS gate.
- `src/lib/db.ts` for admin read/write of the order store; the documented
  `src/screens/staff/` direct-`supabase` carve-out for the staff screens.
- The staff store (`useStaffStore`) and admin store (`useStore`) for holding the
  loaded order in memory.
- A new migration for the per-user order storage + its RLS policies (see
  Project-specific notes). The permissive-policy lint probe (spec 053) applies:
  the new RLS policy must be owner-scoped (`auth.uid() = <owner>`), NOT a
  trivially-wide `auth.uid() IS NOT NULL` policy, or it fails the
  `permissive_policy_lint` pgTAP gate.
- The `db-migrations-applied` CI gate (spec 064): the new migration must be
  `supabase db push`ed to prod, or that gate goes red.

## Current state of the four screens (verified against code)

- **admin EOD** (`EODCountSection.tsx`): items grouped by category in the
  `grouped` memo (`Map<category, items[]>`, sorted by category then the source
  list's alpha order), inside per-vendor tabs. Render scope per tab is
  `vendorItems` (junction membership, spec 102) → `filteredItems` (category chip
  + `+ COUNT` extras) → `grouped` applies the name search (render-only) on top.
  Submission derives from `filteredItems` via `buildSubmission`, NOT the search-
  narrowed `grouped` — the search-safety invariant. Count-everything gate in
  `onSubmit` checks `filteredItems`; on a blocked submit it clears the search and
  sets `pendingFocusItem` to `missing[0].id` (the gate already jumps to the first
  uncounted; today `missing` follows `filteredItems` order). Live "X of N
  counted" via `hasEntry` (counted-once-globally across vendor tabs, spec 102).
- **admin Inventory** (`InventoryCountSection.tsx`): full-store list, no vendor
  scope, with a count `kind` selector. `storeInventory` → `filteredItems`
  (category chip + name search) → `grouped` (category map) for render. Counters,
  the negative-value guard, and submission all derive from `storeInventory` (the
  category chip is view-only; submitting on `filteredItems` was a fixed
  regression, C-FE-1). No count-everything gate or "jump to first uncounted" on
  this screen today (its footer shows `nonBlankCount/totalItems` and submit is
  enabled at ≥1 entry) — so AC-12's gate-follows-order applies to the three
  screens that HAVE the gate; this screen only needs AC-9/AC-10/AC-14 + the drag.
- **staff EOD** (`EODCount.tsx`): vendor-scoped `FlatList` over `visibleItems`
  (name search, render-only). `items` is `fetchItemsForVendor` (junction, spec
  102). Submission and the gate iterate the full `items`, never `visibleItems`.
  Count-everything gate in `onSubmit` jumps to `uncounted[0]` (today `uncounted`
  follows `items` order); `pendingFocusId` + `listRef.scrollToIndex` +
  `caseInputRefs` focus the row. Live "X of N counted" via `countedNum`.
- **staff Weekly** (`WeeklyCount.tsx`): full-store `SectionList` grouped by
  category (`sections` memo). Renders the whole list un-windowed
  (`initialNumToRender`/`maxToRenderPerBatch` sized to `items.length*3+10`,
  `windowSize` ≥ items) specifically so the gate jump can reach any row (spec
  102). Search is render-only (`sections`). The gate's `onSubmitPress` sorts a
  copy of `items` by `(category, name)` to find the TOPMOST uncounted in the
  on-screen order, then `scrollToLocation` + focus. Submission iterates the full
  `items`. Live "X of N counted" via `countedNum`.

In all four, the custom sort is a VIEW concern like search: it must change only
the render order and the gate's jump target — never the submission scope, the
counter math, or the red marking.

## Project-specific notes

- **Cmd UI section / legacy:** Touches two admin Cmd sections
  (`src/screens/cmd/sections/EODCountSection.tsx`,
  `InventoryCountSection.tsx`) and two staff screens
  (`src/screens/staff/screens/EODCount.tsx`, `WeeklyCount.tsx`). No legacy
  surface.
- **Per-store or admin-global:** Neither — the saved order is per-USER and
  private (RLS gates on the owning user, not the store). It is read/applied
  within whatever store the screen is already showing; the order rows themselves
  are not store-scoped (a user's storeroom-walk order is theirs across the app).
  The architect should confirm whether an order key should ALSO include store
  (PM lean: no — keep it `(user, screen[, vendor])` for the simplest model; if a
  user wants different orders per store that is a future extension).
- **Realtime channels touched:** None. A private per-user view preference does
  not propagate to other clients; the admin `store-{id}` / `brand-{id}` channels
  and the staff no-realtime posture (spec 062) are unchanged.
- **Migrations needed:** Yes — one new migration for the per-user order table +
  owner-scoped RLS policies. Must pass the `permissive_policy_lint` pgTAP probe
  (spec 053; owner-scoped, not trivially-wide) and be pushed to prod so
  `db-migrations-applied` (spec 064) stays green.
- **Edge functions touched:** None expected (PostgREST + RLS on a per-user
  table, or an RPC via `db.ts`). The `staff-*` service-token edge functions are
  not involved.
- **Web/native scope:** Both. Web ships to Vercel, native to EAS; the drag
  mechanism (OQ-6) must work on react-native-web and native.
- **`app.json` slug:** Not touched. (Surfaced per CLAUDE.md policy; this feature
  does not go near build identifiers.)
- **Tests:** Two tracks. (1) pgTAP DB tests for the RLS owner-scoping (AC-1),
  key independence (AC-2), round-trip + reset (AC-3/AC-4), and the permissive-
  policy lint. (2) jest for the render-order application, the submission-scope
  invariant (AC-9), search composition (AC-10), and the gate-jump-follows-custom-
  order behavior (AC-12) on the screens that have the gate. No new shell smoke
  track is anticipated.

---

## Backend design

Architect: backend-architect (design mode). All seven OQs are resolved by the
dispatching prompt; this section designs to those resolutions and does not
re-open them. Where the prompt's resolution and the PM-lean in the spec body
diverge (OQ-1, OQ-2), the **prompt wins** (per-vendor EOD keys; flat Custom
view).

### 0. Resolved-decision recap (the contract these choices serve)

| OQ | Resolution (binding) | Design consequence |
|----|----------------------|--------------------|
| OQ-1 | EOD order is **per-vendor**: a separate saved order per `(surface, vendor)`. Inventory + Weekly are per-surface only. | The key carries a **nullable `vendor_id`**: non-null for the two EOD surfaces, NULL for Inventory + Weekly. |
| OQ-2 | **Flatten** category-grouped screens into one walk order in Custom view. Default view keeps category grouping. | Per-screen `viewMode` toggle: `default` (grouped/alpha) ↔ `custom` (flat draggable). An existing saved order opens directly in `custom`. |
| OQ-3 | Unranked items **append at the end** in the screen's default relative order. | The stored order is a **sparse `item_ids` array**; apply = stable partition (ranked-in-saved-order, then unranked-in-default-order). Deleted ids ignored on read. |
| OQ-4 | Per-screen **reset** clears that one key. | `DELETE` the row for `(user, screen, vendor?)`. Reset is render+persist; placement is frontend's (see §8). |
| OQ-5 | **Architect's call** (decided below): **side table, row-per-`(user, screen, vendor?)` holding a JSONB `item_ids` array.** | See §1 rationale. |
| OQ-6 | **Architect/frontend's call** (named below): `react-native-draggable-flatlist`, with a fallback. New dependency — flagged for review. See §9. |
| OQ-7 | Four stable screen keys: **`admin-eod`, `admin-inventory`, `staff-eod`, `staff-weekly`**. | Encoded as a CHECK-constrained `text` column `screen`. |

### 1. Storage shape (OQ-5) — decision + rationale

**Decision: a new side table `public.user_count_orders`, one row per
`(user_id, screen, vendor_id)`, holding the order as a JSONB ordered array of
item-id strings (`item_ids`).** NOT a `profiles` column; NOT a row-per-item
`sort_index` table.

Rationale, weighed against the three alternatives the prompt named:

- **vs. a `profiles` JSONB column** (the dark_mode / sidebar_layout / locale
  precedent). Rejected. The per-user-pref precedent is real, but every existing
  pref is a single scalar/blob with ONE value per user. This feature is
  2–3-dimensional (`screen` × optional `vendor`), so a profiles column would be
  one nested blob `{ "admin-eod": { "<vendorId>": [...] }, "admin-inventory":
  [...], ... }`. Two hard problems kill it: (a) **the staff subtree never loads
  `profiles`** — the admin login-restore reads `profiles.*` in
  [src/lib/auth.ts:170](src/lib/auth.ts) (`select('*, brands(id,name)')`), but
  the staff app (`useStaffStore`) has no profile-hydration path at all, so the
  staff screens would have to fetch+patch a shared profiles blob the admin app
  also writes — concurrent partial writes to one JSONB column across two
  independent surfaces is exactly the lost-update footgun a side table avoids;
  (b) a per-drop write would `UPDATE profiles SET count_orders = <entire blob>`,
  rewriting all four screens' orders (and every vendor map) on every single
  drop. A side table writes exactly one `(user, screen, vendor?)` row per drop.
- **vs. a row-per-item `sort_index` table.** Rejected. A drop that moves one row
  past N others renumbers up to N rows → N UPDATEs (or a fragile gap-renumber
  scheme), and "consistency when items change" means reconciling orphan/sparse
  rows on every read. The JSONB-array-per-key shape makes **a drop one `UPSERT`
  of one row** (the whole new ordering is a single array), and **apply is a pure
  client-side function** over `(savedIds[], currentItems[])` — trivial to unit
  test (AC-3, AC-9, AC-12) and trivially consistent under item add/remove (new
  ids append per OQ-3, deleted ids are filtered on apply). RLS is also simpler:
  one owner predicate on one table, vs. an owner predicate plus a join to prove
  per-item ownership.

The array-of-ids shape directly serves OQ-3 (sparse ranking; missing→append,
deleted→ignore) and AC-9 (render-only: the array is never the submission
source — submission keeps iterating the full item set).

#### 1.1 Table DDL (illustrative — backend-developer authors the migration)

```sql
-- supabase/migrations/<YYYYMMDDHHMMSS>_user_count_orders.sql
create table if not exists public.user_count_orders (
  user_id    uuid    not null references public.profiles(id) on delete cascade,
  screen     text    not null
             check (screen in ('admin-eod','admin-inventory','staff-eod','staff-weekly')),
  -- NULL for admin-inventory / staff-weekly (per-surface).
  -- Non-null for admin-eod / staff-eod (per-vendor, OQ-1).
  vendor_id  uuid    null references public.vendors(id) on delete cascade,
  -- Ordered, possibly-sparse list of inventory_items.id (as text).
  -- Apply is client-side: rank by index here, append unranked in default order.
  item_ids   jsonb   not null default '[]'::jsonb
             check (jsonb_typeof(item_ids) = 'array'),
  updated_at timestamptz not null default now(),
  -- Composite PK doubles as the upsert conflict target. COALESCE the nullable
  -- vendor into the uniqueness via two partial unique indexes (a PK cannot
  -- contain a nullable column and treat NULLs as equal). See §1.2.
  primary key (user_id, screen, vendor_id)
);
```

#### 1.2 The NULL-vendor uniqueness gotcha (flag for backend-developer)

A composite PK `(user_id, screen, vendor_id)` does **not** enforce "one row per
`(user, 'admin-inventory')`" because Postgres treats `NULL` as distinct in
unique constraints — two `(uA, 'admin-inventory', NULL)` rows would both be
admitted, and `ON CONFLICT (user_id, screen, vendor_id)` would not fire for the
NULL-vendor case. Resolve with **two partial unique indexes** instead of (or in
addition to) leaning on the PK for the NULL branch:

```sql
create unique index user_count_orders_vendor_uq
  on public.user_count_orders (user_id, screen, vendor_id)
  where vendor_id is not null;
create unique index user_count_orders_novendor_uq
  on public.user_count_orders (user_id, screen)
  where vendor_id is null;
```

The two write helpers (§5) must therefore branch their upsert on vendor
presence: `onConflict: 'user_id,screen,vendor_id'` for the EOD (vendor) path and
`onConflict: 'user_id,screen'` for the Inventory/Weekly (no-vendor) path — OR
use the "delete-then-insert within one statement" pattern. Backend-developer's
call which; partial-index + matching `onConflict` is the lower-risk path and is
what the helper signatures in §5 assume.

#### 1.3 Indexing + dataset note

The composite PK + the two partial unique indexes fully cover the only read
pattern (`where user_id = auth.uid() and screen = $1 [and vendor_id = $2]`). No
separate index needed. Rows are tiny and bounded (≤ 4 screens × per-user vendor
count); the 286 KB seed adds zero rows (orders are user-created at runtime), so
there is no seed-scale or backfill concern. Additive + non-destructive: a fresh
table, no change to any existing table, instant in PG 17.

### 2. RLS impact (AC-1; spec-053 lint compliance)

`user_count_orders` is **owner-scoped, not store-scoped** — a user's
storeroom-walk order is theirs (per Project-specific notes; no store column).
The owner predicate is `user_id = auth.uid()` — the same shape as
[`flags`](supabase/migrations/20260502190001_flags_table.sql) ("Read own flags")
and [`push_subscriptions`](supabase/migrations/20260421192250_push_subscriptions_rls.sql).
Do **not** use `auth_can_see_store()` (wrong axis — these rows aren't
store-scoped) and do **not** use `auth_is_admin()` (staff write these too).

Four policies, all gating on the owner column. **`auth.uid() = user_id` is NOT
trivially-wide** (it references the owning column), so it passes the spec-053
`permissive_policy_lint` head-token + OR-tail detector — no allowlist entry
required. Critically: keep each policy a **single permissive policy per
command** with the owner predicate as the WHOLE clause; do not add any
`auth.uid() IS NOT NULL` arm (that would shadow the owner scope via the OR-compose
rule — CLAUDE.md "Permissive RLS policies … are ORed").

```sql
alter table public.user_count_orders enable row level security;

create policy "Users read own count orders"
  on public.user_count_orders for select
  using (auth.uid() = user_id);

create policy "Users insert own count orders"
  on public.user_count_orders for insert
  with check (auth.uid() = user_id);

create policy "Users update own count orders"
  on public.user_count_orders for update
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own count orders"
  on public.user_count_orders for delete
  using (auth.uid() = user_id);
```

Grants: the spec-097 explicit-grant posture
([20260618000000_public_grants_explicit.sql](supabase/migrations/20260618000000_public_grants_explicit.sql))
means the new table needs explicit `grant select, insert, update, delete on
public.user_count_orders to authenticated;` in the migration — do not rely on
the default `public.*` grant (the Supabase-CLI image revokes it; that asymmetry
is exactly what spec 097 fixed). Backend-developer: include the grant.

**No `auth_is_admin` / `auth_is_privileged` path exists or is wanted here** —
there is intentionally no admin-reads-another-user's-order policy (US-2: private;
out-of-scope "shared/role-wide orders"). A super_admin does NOT get to read these
rows; that is correct and the pgTAP test asserts it (§10).

### 3. API contract (PostgREST vs RPC)

**PostgREST direct table access — no RPC.** The reads/writes are trivial
single-table CRUD fully constrained by RLS; an RPC would add a SECURITY DEFINER
surface and a migration-coupled signature for zero benefit. This mirrors how the
`profiles`-pref writes go straight through PostgREST (`.from('profiles').update`).

- **Read (on screen open).** `select item_ids from user_count_orders where
  user_id = <uid> and screen = $1 [and vendor_id = $2 / is null]`. Response:
  `{ item_ids: string[] }` or zero rows (→ no saved order → default view).
  Error cases: network/RLS error → surface via the screen's `notifyBackendError`
  and fall back to default order (AC-7: the screen still renders; the order just
  isn't applied). A zero-row result is **not** an error (it's the
  no-custom-order state).
- **Write (on drop / on reset).**
  - Drop → `upsert({ user_id, screen, vendor_id, item_ids, updated_at })` on the
    appropriate conflict target (§1.2). Response: ignored on success; on error,
    revert the on-screen order and `notifyBackendError` (AC-6).
  - Reset → `delete … where user_id and screen and (vendor_id eq/is null)`.
    Response ignored; on error, `notifyBackendError`. After a successful delete
    the screen falls back to default view (AC-4/AC-8).
- **No count RPC changes.** `submitEOD`/`submitEODCount`, `submitInventoryCount`,
  `staff_submit_eod`, `submitWeeklyCount` are untouched (AC-9; spec "Out of
  scope"). The order is applied entirely client-side from the one read — exactly
  the "if derivable client-side, no count RPC changes" path the spec calls for.

### 4. Edge function changes

**None.** No new or modified edge function; no `verify_jwt` decision needed. The
`staff-*` service-token functions are not involved. PostgREST + RLS covers both
the admin (authenticated JWT) and staff (authenticated JWT — the staff app is a
signed-in Supabase session, the service-token split only applies to the
`staff-*` edge functions, not to direct `supabase.from()` table reads) paths.

### 5. `src/lib/db.ts` surface + the staff carve-out

The **admin** screens (EODCountSection, InventoryCountSection) route through
`db.ts` (project convention). The **staff** screens (EODCount, WeeklyCount) use
the documented `src/screens/staff/` direct-`supabase` carve-out (CLAUDE.md;
spec 063) — they do NOT import `db.ts`. So the read/apply logic is authored
**twice** intentionally; to keep them byte-aligned, the **pure apply function**
(§7) lives in a shared, dependency-free module both import (it touches no
`supabase`, so it violates no carve-out and centralizes the only logic worth
unit-testing).

#### 5.1 Shared pure module (new) — `src/lib/countOrder.ts`

Dependency-free (no `supabase`, no store). Importable by both `db.ts` and the
staff subtree.

```ts
// The four stable screen keys (OQ-7). Exported so call sites don't stringly-type.
export type CountOrderScreen =
  | 'admin-eod' | 'admin-inventory' | 'staff-eod' | 'staff-weekly';

// Apply a saved sparse order to the current item set (OQ-3).
// - ranked items (present in savedIds) come first, in savedIds order
// - unranked items (new / never-placed) append in their default (input) order
// - savedIds referencing now-deleted items are ignored
// Pure + total; this is the unit-test surface for AC-3 / AC-9 / AC-12.
export function applyCountOrder<T>(
  items: readonly T[],
  savedIds: readonly string[] | null | undefined,
  idOf: (item: T) => string,
): T[];

// Resolve "first uncounted in the user's CURRENT on-screen order" (AC-12).
// Caller passes the already-ordered list (custom when active, else default)
// and an isCounted predicate; returns the first item failing it, or null.
export function firstUncounted<T>(
  orderedItems: readonly T[],
  isCounted: (item: T) => boolean,
): T | null;
```

#### 5.2 `db.ts` helpers (admin path) — new

Mirror the `saveSidebarLayout` shape ([db.ts:1854](src/lib/db.ts)): `track()`-wrapped,
throw-on-error so the store reverts. snake_case row → camelCase: the row is
`{ item_ids }` → the helper returns a plain `string[]` (the only field the screen
needs), so there is **no mapItem-style object** to map — just `data?.item_ids ?? null`.

```ts
// READ — returns the saved id array, or null when no row exists (default view).
export async function fetchCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,   // null for admin-inventory; the vendor id for admin-eod
): Promise<string[] | null>;

// WRITE (persist-on-drop) — upsert the full ordered array.
export async function saveCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
  itemIds: string[],
): Promise<void>;   // throws on error (store reverts + notifyBackendError)

// RESET — delete the one (user, screen, vendor?) row.
export async function resetCountOrder(
  userId: string,
  screen: CountOrderScreen,
  vendorId: string | null,
): Promise<void>;   // throws on error
```

Internals: `fetchCountOrder` builds the query with `.eq('vendor_id', vendorId)`
when non-null and `.is('vendor_id', null)` when null (PostgREST distinguishes
these — `.eq` against null does not match). `saveCountOrder` upserts with the
matching `onConflict` per §1.2. All three `.eq('user_id', userId)` so a
cross-user write is 0 rows under RLS (defense-in-depth; the policy already
blocks it).

#### 5.3 Staff carve-out helpers (staff path) — new

Co-located with the staff screens (e.g. `src/screens/staff/lib/countOrder.ts`),
calling `supabase.from('user_count_orders')` directly (the documented carve-out),
importing the **pure** `applyCountOrder`/`firstUncounted` from
`src/lib/countOrder.ts` (cross-subtree import of a pure module is fine — the
staff subtree already imports `src/i18n/matchesQuery`, `src/i18n/localizedName`,
`src/utils/confirmAction` from outside its tree). Same three operations
(fetch/save/reset), same `{ data, error }` handling the staff fetchers already
use (e.g. `fetchItemsForVendor`), errors via the staff
`notifyBackendError` ([src/screens/staff/lib/notifyBackendError.ts](src/screens/staff/lib/notifyBackendError.ts)).

The userId for the staff path comes from
`currentStaffUserId(authState)` ([useStaffStore.ts:320](src/screens/staff/store/useStaffStore.ts)).

### 6. Hydration / where the order is held in memory

The order is **fetched per-screen on open** (and per vendor-change on the EOD
surfaces), not hydrated at login. Reasons: it is screen-local and vendor-scoped
(the EOD case), the staff app has no login-time profile-hydration path, and a
per-screen fetch keeps the read pattern uniform across admin + staff. This
differs from dark_mode/sidebar_layout (which DO hydrate at login via
`src/lib/auth.ts`) precisely because those are single global scalars and this is
a per-screen/per-vendor set. AC-7 ("loaded order MUST win once it arrives") is
satisfied by fetching in a `useEffect` on mount/vendor-change and applying once
it resolves; while loading the screen shows its normal list (default order) and
the loaded order replaces it on arrival — the spec explicitly does not require
suppressing a default-then-reorder flash.

- **admin EOD / staff EOD:** refetch on `(store, vendor)` change. The order is
  per-vendor (OQ-1) so switching vendor tabs loads that vendor's order. Hold in
  a `Record<vendorId, string[] | null>` (admin, mirroring the existing
  per-vendor `caseCountsByVendor` map) or a single `string[] | null` for the
  current vendor (staff, which already scopes to one vendor at a time and
  refetches on vendor change).
- **admin Inventory / staff Weekly:** fetch once on mount (no vendor); hold a
  single `string[] | null` + the `viewMode` flag.

### 7. How each screen applies the order + toggles view (OQ-2)

All four gain a per-screen `viewMode: 'default' | 'custom'` UI state. `default`
renders today's view verbatim (grouped/alpha — zero behavior change when the
user never engages the feature). `custom` renders a single **flat** draggable
list ordered by `applyCountOrder(fullItems, savedIds, i => i.id)`. On open, if a
saved order exists for the active key, the screen starts in `custom` (AC-7); else
`default`. The toggle + reset live in each screen's existing header chrome (§8).

The submission-scope and gate invariants are honored by keeping the existing
derivations as the source of truth and only re-pointing the **render list** and
the **gate's "first" resolution**:

- **admin EOD ([EODCountSection.tsx](src/screens/cmd/sections/EODCountSection.tsx)).**
  Custom view replaces the `grouped` memo's grouped output with a flat list =
  `applyCountOrder(searchFiltered(filteredItems), savedIdsForVendor, …)`. The
  search still composes (filter first, then order the survivors — AC-10).
  `buildSubmission` + the `onSubmit` gate KEEP iterating `filteredItems` (the
  full set, never the ordered/searched view) — AC-9 unchanged. **Gate jump
  (AC-12):** today `missing = filteredItems.filter(!hasEntry)` and it focuses
  `missing[0]`. Change ONLY the ordering used to pick "first": when
  `viewMode==='custom'`, compute the missing set against
  `applyCountOrder(filteredItems, savedIdsForVendor, …)` (NOT the search-narrowed
  list — clear search first as today, then resolve first-uncounted in the custom
  order). Use `firstUncounted(orderedFullItems, hasEntry)`. The counted-once
  semantics (`hasEntry` = local OR cross-tab `countedItemIds`) are unchanged.
- **admin Inventory ([InventoryCountSection.tsx](src/screens/cmd/sections/InventoryCountSection.tsx)).**
  Custom view = `applyCountOrder(searchFiltered(filteredItems), savedIds, …)`
  flat. Counters/guards/submission keep deriving from `storeInventory` (AC-9; the
  C-FE-1 regression guard stays). **No gate** today — do NOT add one (per prompt
  + spec line 262). This screen gets drag + storage + reset only; vendor_id is
  always `null` here.
- **staff EOD ([EODCount.tsx](src/screens/staff/screens/EODCount.tsx)).** Already
  a flat `FlatList` over `visibleItems` — flatten is a no-op. Custom view orders
  `visibleItems`'s underlying full `items` by `applyCountOrder(items,
  savedIdsForVendor, …)` then applies the search filter for render (AC-10). The
  order is per-vendor (OQ-1) and refetched on vendor change.
  Submission + gate keep iterating the full `items`. **Gate jump (AC-12):** today
  `uncounted = items.filter(isBlank)` → `pendingFocusId = uncounted[0].id`.
  Change to resolve "first" against `applyCountOrder(items, savedIdsForVendor,…)`
  when custom is active (i.e. `firstUncounted(orderedItems, notBlank)`); the
  existing `scrollToIndex`/`caseInputRefs` focus path is unchanged and resolves
  against `visibleItems` as it does today.
- **staff Weekly ([WeeklyCount.tsx](src/screens/staff/screens/WeeklyCount.tsx)).**
  This is the un-windowed `SectionList` (spec 102). Custom view replaces
  `sections` with a **single flat section** (or a plain list) ordered by
  `applyCountOrder(items, savedIds, …)` — suppressing the category headers per
  OQ-2. **Critical (OQ-6):** the Custom flat list must keep ALL rows mounted —
  carry the same un-windowed posture the SectionList uses today
  (`initialNumToRender`/`maxToRenderPerBatch` ≈ `items.length*3+10`,
  `windowSize ≥ items`) onto whatever flat draggable component renders Custom
  view, so the gate jump still reaches any row. Do NOT introduce a virtualized
  draggable that unmounts far rows. **Gate jump (AC-12):** today `onSubmitPress`
  sorts a copy of `items` by `(category, name)` to find the topmost uncounted in
  the on-screen order. When custom is active, replace that sort with
  `applyCountOrder(items, savedIds, …)` and take `firstUncounted(…, notBlank)`;
  when default is active, keep today's `(category, name)` sort. Submission keeps
  iterating the full `items` (AC-9).

In all four, **search remains render-only and composes with custom order**
(AC-10): filter the survivors, then order them by the custom ranking (or order
first then filter — equivalent for a stable filter; filter-then-order is cheaper
and matches today's "apply search in the render memo" placement). The "X of N
counted" label + red-uncounted marking are order-independent and unchanged
(AC-11).

### 8. Reset + toggle placement (OQ-4) — frontend's call, constraints noted

Per-screen `viewMode` toggle + reset affordance live in each screen's existing
header chrome:
- admin EOD / admin Inventory: the `TabStrip` `rightSlot` cluster (where the
  date/EDIT/SUBMIT controls already live) or the sticky filter strip — same row
  as the existing search/category chips.
- staff EOD / staff Weekly: the header block under the title (next to the
  `LocaleSwitcher`) or adjacent to the search input.

Reset is **one-tap, no `confirmAction`** (PM lean; re-dragging is the undo) — but
place it so it is not adjacent-and-identical to a primary action (don't let it
sit flush against SUBMIT). Frontend decides exact pixels; this is not
load-bearing for the contract.

### 9. Drag mechanism (OQ-6) — concrete approach + dependency flag

**Recommended: `react-native-draggable-flatlist`** (the de-facto RN draggable
list; works on react-native-web via `react-native-gesture-handler` +
`react-native-reanimated`, both already transitively present in an Expo SDK 54
app — backend-developer/frontend-developer must CONFIRM they're installed and on
RNW-compatible versions, and that `GestureHandlerRootView` wraps the app root).
**This is a NEW dependency — flag for code-reviewer + security-auditor review**
(bundle size, web-gesture parity, EAS native build impact). It exposes an
explicit drag handle (`onLongPress`/`drag` render-prop) that satisfies AC-5 on
both platforms.

Two hard constraints on whichever component is chosen:
1. **Un-windowed for staff Weekly + admin Inventory** (OQ-6 / spec 102): the
   Custom list must keep every row mounted so the gate jump reaches any row.
   `react-native-draggable-flatlist` extends `FlatList`, so pass the same
   un-windowing props the staff Weekly SectionList uses today. If the chosen lib
   cannot be forced un-windowed, fall back to the second option.
2. **Fallback if the lib doesn't land cleanly on RNW:** a hand-rolled up/down
   "move" control (▲/▼ buttons per row, or a long-press + reorder) over the
   existing `ScrollView`/`FlatList`. Less slick but satisfies AC-5's "drop it at
   a new position → becomes the visible render order" without a new dependency.
   The persist-on-drop contract (§5) is identical either way — the UI mechanism
   is orthogonal to the storage/apply contract, which is the part this design
   pins down.

Frontend owns the final pick; if it diverges from the recommendation, note it in
`## Files changed`.

### 10. Frontend store impact

- **Admin (`useStore.ts`).** The order is screen-local view state — it does NOT
  need to live in the global Zustand store (it's not shared across sections, not
  realtime-synced, and is re-fetched on open). Hold `viewMode` + the fetched
  `savedIds` (per-vendor map for EOD) in the **section components'** local
  `useState`, calling the `db.ts` helpers directly (the sections already call
  `db.ts` functions like `submitEODCount`, `fetchRecentInventoryCounts`
  directly). **Optimistic-then-revert applies on drop:** set the new on-screen
  order immediately, call `saveCountOrder`; on throw, revert to the prior order
  and `notifyBackendError` (AC-6) — the same pattern as `setSidebarLayoutOverride`
  ([useStore.ts:2344](src/store/useStore.ts)) but local to the section. No new
  global slice is required; if the developer prefers a slice for symmetry that's
  acceptable but not mandated.
- **Staff (`useStaffStore`).** Same: screen-local `useState` in EODCount /
  WeeklyCount, staff carve-out helpers, staff `notifyBackendError` on revert. No
  new staff-store slice required.

### 11. Realtime impact

**None.** `user_count_orders` is a private per-user view pref; it is NOT added to
the `supabase_realtime` publication and NO channel (`store-{id}` / `brand-{id}`)
replays it (spec "Out of scope"; Project-specific notes). Because the migration
does **not** touch publication membership, **the publication-restart gotcha does
NOT apply** — there is no `docker restart supabase_realtime_imr-inventory` step
for this spec. (Flagging the absence explicitly so the deploy checklist isn't
padded with an unnecessary step.)

### 12. Migration + prod-apply

One additive migration `supabase/migrations/<YYYYMMDDHHMMSS>_user_count_orders.sql`
(backend-developer mints the real timestamp at author time, after the latest
existing migration `20260618000000`): create table + two partial unique indexes
+ enable RLS + four owner-scoped policies + explicit `grant … to authenticated`.
Additive, non-destructive, instant in PG 17, no backfill.

**Prod-apply step (db-migrations-applied gate, spec 064):** this repo applies
prod migrations via the Supabase MCP (project memory: "Prod schema mirrored
locally"; do not drift via dashboard SQL editor). The developer must **flag the
prod-apply to the user** — the developer does NOT push to prod themselves. After
the migration lands on `main`, the user (or a release step) applies it to prod so
`db-migrations-applied.yml` stays green; otherwise that gate hard-fails (a repo
migration missing from prod's `schema_migrations`). Call this out in the handoff
and in `## Files changed`.

### 13. Tests (both tracks)

**pgTAP — `supabase/tests/user_count_orders_rls.test.sql` (new).** Under two
synthetic auth users A and B (set `request.jwt.claims` per the existing RLS test
fixtures, e.g. `rls_hardening_followups.test.sql`):
- A inserts/upserts its own `(admin-eod, vendorX)` order → succeeds; reads it
  back (AC-3 round-trip at the SQL layer).
- B cannot `SELECT` A's row (0 rows) and cannot `UPDATE`/`UPSERT`/`DELETE` it
  (0 rows affected / RLS denial) under ANY of the four screen keys (AC-1).
- A super_admin JWT also cannot read A's row (asserts no admin bypass exists —
  US-2 privacy).
- Key independence (AC-2): A writes `admin-eod`+vendorX and `admin-inventory`
  (NULL vendor); asserts writing one leaves the other's `item_ids` unchanged, and
  that the NULL-vendor and non-NULL-vendor rows for the same `(user, screen?)`
  coexist correctly (exercises the §1.2 partial-unique-index design — two
  `admin-eod` rows under different vendors coexist; a second NULL-vendor
  `admin-inventory` upsert REPLACES rather than duplicates).
- Reset (AC-4): A deletes `admin-eod`+vendorX; asserts that row is gone and
  `admin-inventory` is untouched.
- The existing `permissive_policy_lint.test.sql` arm (1)/(2) will scan the four
  new policies automatically; `auth.uid() = user_id` is not trivially-wide, so it
  must pass with **no** allowlist edit. (If the developer accidentally writes a
  wide arm, this existing probe catches it — no new lint test needed.)

**jest — pure-logic + screen behavior.**
- `src/lib/countOrder.test.ts` (new): `applyCountOrder` — ranked-then-unranked
  partition (OQ-3), deleted-id ignore, empty/null saved order = identity in
  default input order, stable order of unranked tail. `firstUncounted` —
  resolves first failing item in the given order, null when all counted.
- Screen-level (extend existing EOD/Weekly/Inventory test files or add focused
  ones): **AC-9** — the submitted entry set is byte-identical with and without a
  custom order for the same inputs (assert `buildSubmission`/the entry-builder
  output is unchanged when `viewMode` flips). **AC-12** — with a custom order
  active and a known set of uncounted rows, the gate's jump target (the
  `pendingFocusItem`/`pendingFocusId` value, or the computed first-uncounted) is
  the first uncounted row **in the custom order**, not alphabetical/category
  order — for the three gated screens (admin EOD, staff EOD, staff Weekly).
  **AC-10** — with search active, the visible rows are the search survivors in
  custom relative order. Admin Inventory: assert it has NO gate (submission at
  ≥1, no first-uncounted jump) and that the drag/apply doesn't introduce one.

### 14. Risks & tradeoffs (explicit)

- **NULL-vendor uniqueness (§1.2)** is the single highest-risk detail: get the
  partial unique indexes + matching `onConflict` wrong and either Inventory/Weekly
  orders silently duplicate (two NULL-vendor rows) or the EOD per-vendor upsert
  clobbers across vendors. The pgTAP key-independence arm (§13) is the guard.
- **Two write paths (admin via db.ts, staff via carve-out)** can drift. Mitigated
  by the shared pure `countOrder.ts` (the only logic worth testing is centralized;
  the I/O is thin and structurally identical). Accepting the duplicated thin I/O
  is consistent with the spec-063 carve-out posture (staff fetchers are
  deliberately not in db.ts yet).
- **New dependency (`react-native-draggable-flatlist` + reanimated/gesture-handler)**
  is the biggest build risk: RNW web-gesture parity and EAS native build must both
  be verified, and the staff-Weekly un-windowing constraint must survive the swap.
  The hand-rolled ▲/▼ fallback (§9) de-risks this — the storage/apply contract is
  identical, so a fallback does not change anything in §1–§7.
- **Gate-jump correctness across the custom/default toggle (AC-12)** is subtle:
  three screens, each with a slightly different existing jump mechanism. The
  design re-points only the "first" resolution to `firstUncounted(orderedItems,…)`
  and leaves the scroll/focus machinery intact — but the developer must be careful
  that "orderedItems" is the **full** item set in custom order (NOT the
  search-narrowed view), matching today's clear-search-then-jump behavior.
- **Flat Custom view drops category headers (OQ-2)** — a deliberate UX change on
  three grouped screens. Default view is unchanged, so a user who never enters
  Custom view sees zero difference; this is the intended behavior, not a
  regression, but worth calling out for the reviewers.
- **No store column** means a user gets ONE order per screen across all stores
  (Project-specific notes; future extension if needed). For the EOD per-vendor
  case this means the same vendor's order is shared across stores — acceptable
  per the resolved scope.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the Backend design in
  specs/103-count-screen-custom-sort-per-user.md. Backend-developer: author the
  additive migration (new `public.user_count_orders` table, two partial unique
  indexes for the NULL-vendor uniqueness per §1.2, RLS enable + the four
  owner-scoped policies in §2, explicit grant to authenticated per spec 097),
  the `db.ts` helpers `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` (§5.2),
  the shared pure `src/lib/countOrder.ts` (`applyCountOrder`/`firstUncounted`,
  §5.1), and the pgTAP RLS/key-independence/reset test (§13). Do NOT push the
  migration to prod yourself — flag the prod-apply (Supabase MCP) to the user per
  §12 so the db-migrations-applied gate stays green. Frontend-developer: add the
  per-screen `viewMode` toggle + flat Custom draggable view + persist-on-drop +
  reset on all four count screens (§7), wiring admin screens through the db.ts
  helpers and the staff screens through a staff-subtree carve-out helper
  (§5.3) that imports the pure `countOrder.ts`; pick the drag mechanism (§9,
  recommend `react-native-draggable-flatlist` with the ▲/▼ fallback) and flag any
  new dependency; keep staff Weekly's Custom list un-windowed (§7/§9); add the
  AC-9/AC-10/AC-12 jest coverage (§13). After implementation set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/103-count-screen-custom-sort-per-user.md

---

## Backend implementation (backend-developer — BACKEND SLICE ONLY)

Status note: spec stays **READY_FOR_BUILD** — this is the backend phase only.
The frontend phase (the four screens' viewMode toggle + Custom draggable view +
persist-on-drop + reset, the staff carve-out helper, the drag dependency, the
AC-12 gate-jump rewire) is still pending. Do NOT treat this as
READY_FOR_REVIEW until the frontend lands.

Built exactly to the Backend design above — no design changes, no screen/store
edits, no count-RPC changes (AC-9 honored: only the order-storage read/write
path was added).

### Files changed (backend slice)

Migrations:
- `supabase/migrations/20260630000500_user_count_orders.sql` (new) — additive.
  The `public.user_count_orders` table (§1.1): columns
  `(user_id, screen, vendor_id nullable, item_ids jsonb default '[]' with a
  jsonb_typeof='array' CHECK, created_at, updated_at)`; `screen` CHECK-
  constrained to the four OQ-7 keys. The TWO partial unique indexes for the
  NULL-vendor uniqueness gotcha (§1.2): `user_count_orders_vendor_uq` on
  `(user_id, screen, vendor_id) where vendor_id is not null` and
  `user_count_orders_novendor_uq` on `(user_id, screen) where vendor_id is
  null` (no PK — a PK cannot treat NULLs as equal). RLS enabled + the FOUR
  owner-scoped policies (§2, `auth.uid() = user_id`; NOT store-scoped, NOT
  admin-gated, no super_admin bypass). Explicit
  `grant select, insert, update, delete, references, trigger … to anon,
  authenticated` (TRUNCATE omitted) + `grant all … to service_role`
  (spec-097 class, matching `item_vendors`). NOT added to the
  `supabase_realtime` publication (§11 — no realtime, no container-restart
  step).

src/lib (admin path + shared pure module):
- `src/lib/countOrder.ts` (new) — the shared PURE module (§5.1). Dependency-free
  (no `supabase`, no React), importable by both `db.ts` and the staff carve-out.
  Exports `type CountOrderScreen` (the four keys), `applyCountOrder(items,
  savedIds, idOf)` (stable partition: ranked-in-saved-order then unranked-in-
  default-order; deleted ids ignored; null/empty = identity; de-dups duplicate
  saved ids; never drops an input item), and `firstUncounted(orderedItems,
  isCounted)` (AC-12 gate-jump resolution against the on-screen order).
- `src/lib/db.ts` (modified, +134 lines) — added the three admin helpers (§5.2)
  after `saveLocale`: `fetchCountOrder` (`kind:'read'`, `.maybeSingle()`,
  returns `string[] | null`; branches `.is('vendor_id', null)` vs
  `.eq('vendor_id', v)`), `saveCountOrder` (`kind:'write'`, upsert with the
  branch-on-vendor `onConflict` target — `'user_id,screen'` for no-vendor,
  `'user_id,screen,vendor_id'` for per-vendor — throws on error), and
  `resetCountOrder` (`kind:'write'`, delete one key, throws on error). All
  `track()`-wrapped with `.abortSignal()`, all pin `.eq('user_id', userId)` as
  defense-in-depth. Added a type-only `import type { CountOrderScreen } from
  './countOrder'`.

Tests:
- `supabase/tests/user_count_orders_rls.test.sql` (new, 13 assertions) — RLS
  owner-scoping (A round-trips own row; B cannot SELECT/UPDATE/DELETE A's rows
  and cannot INSERT-as-A → 42501; super_admin cannot SELECT A's rows = no
  bypass), key independence + the §1.2 NULL-vendor uniqueness (admin-inventory
  NULL-vendor coexists with admin-eod/vendorX; 2nd NULL-vendor upsert REPLACES
  not duplicates; two admin-eod vendors coexist; one key's write leaves another
  unchanged), and reset (delete admin-eod/vendorX leaves admin-inventory
  untouched). Uses two seed profiles as users A/B inside `begin; … rollback;`.
- `src/lib/countOrder.test.ts` (new, 16 assertions) — `applyCountOrder`
  (ranked+unranked+deleted partition, null/undefined/empty identity, fresh-array
  + same-reference stability, duplicate-id de-dup, empty-set) and
  `firstUncounted` (first failing in the given order, null when all counted,
  AC-12 "follows custom order not default" regression).

### Local verification results (NOT pushed to prod)

- Migration applied to the local stack cleanly. Verified: 6 columns; the two
  partial unique indexes present with the correct predicates; RLS enabled; the
  four policies present (SELECT/DELETE qual = `auth.uid() = user_id`,
  INSERT/UPDATE with_check = `auth.uid() = user_id`); grants to authenticated.
- **NULL-vendor uniqueness proof:** inserting a NULL-vendor admin-inventory row
  twice for the same `(user, screen)` → exactly 1 row (the 2nd upsert replaced
  item_ids via `user_count_orders_novendor_uq`); two admin-eod rows under
  different vendors → coexist (2 rows). Manual SQL probe passed.
- **RLS-denies-non-owner proof (inside a transaction so `set local role` takes
  effect):** user B SELECT of A's row → 0; B UPDATE → 0 rows affected; B DELETE
  → 0 rows affected; B INSERT-as-A → 42501 (with-check). Owner A SELECT own → 1;
  A UPDATE own → 1 affected. super_admin SELECT of A's row → 0 (no bypass).
- pgTAP: new file 13/13; `permissive_policy_lint.test.sql` 4/4 (the four new
  owner-scoped policies pass with NO allowlist edit — `auth.uid() = user_id` is
  not trivially-wide). FULL suite **57/57 files** green (was 56).
- jest: new file 16/16; FULL suite **740/740** green (was 724). `tsc --noEmit`
  exit 0.

### Carryover — FRONTEND PHASE (not done here)

- The per-screen `viewMode: 'default' | 'custom'` toggle + flat Custom
  draggable view + persist-on-drop + per-screen reset on all four count screens
  (§7): `EODCountSection.tsx`, `InventoryCountSection.tsx` (admin, via the new
  `db.ts` helpers), `staff/screens/EODCount.tsx`, `staff/screens/WeeklyCount.tsx`
  (staff, via a NEW `src/screens/staff/lib/countOrder.ts` carve-out helper that
  calls `supabase.from('user_count_orders')` directly and imports the pure
  `applyCountOrder`/`firstUncounted` from `src/lib/countOrder.ts`, §5.3).
- The AC-12 gate-jump rewire on the three GATED screens (admin EOD, staff EOD,
  staff Weekly): when `viewMode==='custom'`, resolve "first uncounted" via
  `firstUncounted(applyCountOrder(fullItems, savedIds, idOf), isCounted)` against
  the FULL item set (clear search first, as today). Admin Inventory has NO gate
  — do not add one.
- The drag mechanism (§9): `react-native-draggable-flatlist` is a NEW dependency
  — flag it for code-reviewer + security-auditor (or use the ▲/▼ fallback; the
  storage/apply contract is identical). Keep staff Weekly's Custom list
  UN-WINDOWED (§7/§9) so the gate jump reaches any row.
- Screen-level jest (§13): AC-9 submission byte-identical with/without custom
  order, AC-10 search composes with custom order, AC-12 gate-jump target.

### PENDING: prod-apply (flagged per §12 — user authorizes)

The migration `20260630000500_user_count_orders.sql` was applied to LOCAL only.
It has NOT been pushed to prod. Per project memory ("Prod schema mirrored
locally") this repo applies prod migrations via the Supabase MCP — the user (or
a release step) must apply this migration to prod so the
`db-migrations-applied.yml` gate stays green (a repo migration missing from
prod's `schema_migrations` hard-fails that gate). Additive + non-destructive +
no backfill; no `supabase_realtime` publication change (so no
`docker restart supabase_realtime_imr-inventory` step).

---

## Frontend implementation (frontend-developer — FRONTEND SLICE)

Built to the Backend design above (flat Custom view per OQ-2, per-vendor EOD
keys per OQ-1, AC-12 gate-jump rewire on the three gated screens, AC-9
render-only safety preserved). Drag mechanism: the repo's blessed pattern —
**`@dnd-kit` on WEB + `▲/▼` move buttons on NATIVE** (NOT
`react-native-draggable-flatlist`, which a prior pass proved silently no-ops on
this project's reanimated@4 web build). No new dependency (`@dnd-kit` was
already installed + in the jest `transformIgnorePatterns` allow-list for
spec 008). Reused the SidebarEditMode/Sidebar lazy-load shape: the web `@dnd-kit`
file is dynamically `import()`ed behind `Platform.OS === 'web'` so the native
bundle never pulls `@dnd-kit`.

### 🔴 CRITICAL — blocking backend contract gap (persist-on-drop is broken)

**`saveCountOrder` cannot persist any order through PostgREST as designed.** The
design (§1.2 / §5.2) stores uniqueness as TWO PARTIAL unique indexes
(`… where vendor_id is not null` / `… where vendor_id is null`) and the backend's
`db.ts` `saveCountOrder` upserts with `onConflict: 'user_id,screen,vendor_id'`
(vendor branch) / `onConflict: 'user_id,screen'` (no-vendor branch). **Postgres
rejects a PARTIAL unique index as an `ON CONFLICT` arbiter** unless the statement
also supplies the index predicate (`ON CONFLICT (…) WHERE vendor_id IS …`), which
PostgREST's `onConflict` parameter CANNOT express. Result: **both** branches fail
at runtime with SQLSTATE `42P10` ("there is no unique or exclusion constraint
matching the ON CONFLICT specification").

Verified live against the local stack with the project's own supabase-js client,
signed in as `manager@local.test`:

```
NO-VENDOR upsert (onConflict 'user_id,screen')         → 42P10  ❌
VENDOR    upsert (onConflict 'user_id,screen,vendor_id') → 42P10  ❌
plain INSERT                                            → OK     ✅
2nd plain INSERT on same key                           → 23505 unique violation ✅ (index works as a CONSTRAINT)
READ (.is('vendor_id', null).maybeSingle())            → OK     ✅
DELETE (reset)                                          → OK     ✅
```

So the index is sound and load / reset work; ONLY the upsert arbiter inference
fails. The backend pgTAP suite passed because it exercised raw SQL
`INSERT … ON CONFLICT (…) WHERE …` (which Postgres allows), NOT the PostgREST
`.upsert({ onConflict })` path the screens actually call.

This is a **backend/design Critical**, not a frontend bug — the frontend wiring is
correct against the *intended* contract (optimistic set → `saveCountOrder` → on
throw, revert the on-screen order + notify). When `saveCountOrder` throws `42P10`,
the optimistic-revert fires and the new order simply does not persist (the visible
symptom: a reorder "snaps back" after reload). Per the frontend-developer hard
rule ("if the design is flawed, STOP and surface — do not patch over it"), I did
NOT patch `db.ts` or invent a storage change. Fix options for backend-architect /
backend-developer (pick one; the frontend apply/load/reset/gate code is agnostic
to which):

1. **Delete-then-insert in the write helpers** (no migration): `saveCountOrder`
   does `delete … where (user, screen, vendor?)` then `insert`. Cheapest; keeps
   the two partial indexes (which correctly prevent duplicates). Minor: two
   round-trips, a sub-millisecond window with no row (acceptable for a private
   view pref). Touches `src/lib/db.ts` + `src/screens/staff/lib/countOrder.ts`.
2. **A `SECURITY DEFINER` RPC** `save_count_order(p_screen, p_vendor_id, p_item_ids)`
   that runs the raw `INSERT … ON CONFLICT (…) WHERE …` server-side (raw SQL CAN
   name the predicate). New migration + an RPC contract; the cleanest "real
   upsert" but more surface.
3. **One TOTAL unique index** over a non-null expression
   (`coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid)`) — but
   PostgREST cannot target an EXPRESSION index by column name either, so this
   still needs a delete-then-insert or RPC on the client. Not recommended.

PM/architect lean from the frontend chair: **option 1** (delete-then-insert) — no
migration, no new RPC surface, the partial indexes stay as the duplicate guard,
and it is a ~6-line change in each of the two write helpers. The frontend does
not change for any option.

### Files changed (frontend slice)

Shared / new components + helpers:
- `src/components/cmd/CountOrderDragListWeb.tsx` (new) — admin web-only
  `@dnd-kit` flat sortable list (one `DndContext` + one `SortableContext` +
  `useSortable` rows, grip-handle is the only drag surface so row inputs stay
  focusable). Reuses the spec-008 SidebarEditMode pattern for a flat list.
- `src/components/cmd/CountOrderDragList.tsx` (new) — admin wrapper: lazy-loads
  the web file behind `Platform.OS === 'web'`; renders per-row `▲/▼` move
  buttons on native. Exports the pure `nudge(ids, index, delta)` reorder helper.
- `src/screens/staff/components/CountOrderDragListWeb.tsx` (new) — staff
  web-only `@dnd-kit` list (staff-local theme; staff-isolation per CLAUDE.md).
- `src/screens/staff/components/CountOrderDragList.tsx` (new) — staff wrapper
  (web `@dnd-kit` / native `▲/▼`); renders a plain mapped column (UN-WINDOWED,
  every row mounted) so the staff-Weekly gate jump reaches any row (spec 102).
- `src/screens/staff/lib/countOrder.ts` (new) — staff carve-out I/O
  (`fetchCountOrder`/`saveCountOrder`/`resetCountOrder` via direct
  `supabase.from('user_count_orders')`), re-exporting the PURE
  `applyCountOrder`/`firstUncounted` from `src/lib/countOrder.ts`. Mirrors the
  `db.ts` helper contract (and inherits the §1.2 upsert flaw above).

Screens (the four count surfaces):
- `src/screens/cmd/sections/EODCountSection.tsx` — per-`(admin-eod, vendor)`
  `viewMode` + per-vendor `savedIdsByVendor` map; fetch-on-vendor-change; Default
  ⇄ Custom toggle + reset in the filter strip; flat Custom view via
  `CountOrderDragList` (category headers suppressed) using a factored
  `renderEodRow`; AC-12 gate-jump rewired to
  `firstUncounted(applyCountOrder(filteredItems, savedIds, idOf), hasEntry)` when
  custom. Submission/`buildSubmission`/counters still iterate `filteredItems`
  (AC-9 untouched).
- `src/screens/cmd/sections/InventoryCountSection.tsx` — per-`admin-inventory`
  (vendor null) `viewMode` + `savedIds`; fetch-on-mount; toggle + reset in the
  header strip; flat Custom view via `CountOrderDragList` using a factored
  `renderInventoryRow`. **NO gate added** (per spec line 262). Counters/guards/
  submission still derive from `storeInventory` (AC-9; C-FE-1 guard intact).
- `src/screens/staff/screens/EODCount.tsx` — per-`(staff-eod, vendor)` `viewMode`
  + `savedIds`; fetch-on-vendor-change; toggle + reset by the search row; flat
  Custom view (already a flat `FlatList`) via `CountOrderDragList` using a
  factored `renderEodRow`; AC-12 gate-jump rewired to `firstUncounted(...)` when
  custom. Submission + gate iterate the full `items` (AC-9).
- `src/screens/staff/screens/WeeklyCount.tsx` — per-`staff-weekly` (vendor null)
  `viewMode` + `savedIds`; fetch-on-mount; toggle + reset by the search row; flat
  Custom view that replaces the `SectionList` with an UN-WINDOWED mapped drag
  list (category headers suppressed) using a factored `renderWeeklyRow`; the
  blocked-submit jump effect branches for Custom view (focus the mounted target,
  no `scrollToLocation`); AC-12 gate-jump rewired to `firstUncounted(...)` when
  custom. Submission iterates the full `items` (AC-9).

i18n (EN / ES / 中文 on both surfaces; i18n-parity jest stays green):
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — new
  `section.countOrder.{viewDefault,viewCustom,reset,moveUp,moveDown}`.
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json` — new
  `eod.view.*` + `eod.reorder.*` and `weekly.view.*` + `weekly.reorder.*`.

Tests (jest):
- `src/components/cmd/CountOrderDragList.nudge.test.tsx` (new, 6) — the native
  `▲/▼` `nudge` reorder math (up/down swap, first-up/last-down no-op, round-trip,
  no-mutation).
- `src/screens/staff/screens/EODCount.test.tsx` (extended, +4) — spec-103:
  opens-in-Custom in saved order (AC-3/AC-7); **AC-9** submit byte-identity
  across view; **AC-12** gate jump targets first uncounted in the CUSTOM order;
  reset → default. Mock extended: a dedicated `user_count_orders` builder
  channel (`maybeSingle`/`is`/`upsert`/`delete`) so the count-order read never
  consumes a vendor/item/existing fixture.
- `src/screens/staff/screens/WeeklyCount.test.tsx` (extended, +5) — spec-103:
  opens-in-Custom with category headers suppressed (AC-7/AC-13); **AC-9** submit
  byte-identity; **AC-10** search composes with custom order; **AC-12** gate jump
  follows custom order; reset → default category-grouped view. Mock extended the
  same way; added the `Toast` import.

### Verification (LOCAL only — no prod)

- `npx tsc --noEmit` → exit 0.
- `npx jest` → **755 passed, 69 suites** (was 740 / 68; +15: 4 EOD, 5 Weekly, 6
  nudge). i18n-parity tests green with the new keys.
- Live against the local stack (dev server `:8081` + Supabase `:54321`, signed
  in as `manager@local.test`): the table is reachable + RLS-gated (anon → `[]`);
  READ / plain-INSERT / DELETE all work; the partial unique index correctly
  blocks a duplicate (`23505`). **The `.upsert({ onConflict })` persist path
  fails (`42P10`) on BOTH branches** — the Critical above. All probe rows I
  created were torn down in the same script (`delete … where user_id = <uid>`);
  a final `select` confirmed zero `user_count_orders` rows remain for the test
  user. No counts were submitted.
- Browser preview tooling was not available in this environment; verification was
  done via the running dev server + direct supabase-js probes against the same
  endpoints the screens call. The drag/apply/gate/view-toggle/reset UI is proven
  by the jest render-level tests (staff EOD + Weekly) + the pure
  `applyCountOrder`/`firstUncounted`/`nudge` units. The ONLY unproven-good path
  end-to-end is persist-on-drop, which is blocked by the backend `42P10`.

### Teardown

All `user_count_orders` rows created during live probing were deleted (each
probe script ended with `delete … where user_id = <manager uid>`; a follow-up
`select` returned zero rows). No EOD/weekly/inventory counts were submitted. No
prod writes.

---

## Review fix-pass (frontend-developer)

Addressed the blockers + key should-fixes from the four `specs/103/reviews/`
files. Did NOT touch anything security/architecture blessed: the
delete-then-insert persist (BLESSED by backend-architect Deviation 1 +
security-auditor), the `@dnd-kit`/▲▼ drag mechanism (BLESSED Deviation 2), the
RLS/migration, or the count RPCs. No `package.json` / migration / edge-function
changes.

### Blockers fixed (Critical)

1. **A11y labels on the Weekly drag row** (code-reviewer Critical). The staff
   `CountOrderDragList` hardcoded `eod.reorder.moveUp/Down` for the native ▲/▼
   `accessibilityLabel`, so the Weekly Custom view announced EOD actions. Added a
   `moveUpLabel`/`moveDownLabel` prop pair (defaults preserve the prior EOD
   labels). `WeeklyCount.tsx` now passes `t('weekly.reorder.*')`; `EODCount.tsx`
   passes `t('eod.reorder.*')` (both keys already in the staff catalog —
   confirmed `en/es/zh-CN` lines 53/233). New deterministic CI proof:
   `CountOrderDragList.a11y.test.tsx`.

2. **Persist-on-drop regression test** (test-engineer Critical #1 + architect
   SF-1). Added jest pinning BOTH write paths to delete-then-insert so a revert
   to the broken `.upsert({ onConflict })` (42P10) fails CI:
   - `src/lib/db.saveCountOrder.test.ts` (admin path)
   - `src/screens/staff/lib/countOrder.persist.test.ts` (staff carve-out)
   Each asserts `.delete()` THEN `.insert()`, never `.upsert()`, for the vendor
   (`.eq('vendor_id', …)`) and no-vendor (`.is('vendor_id', null)`) branches, plus
   a delete-errors-before-insert case.

3. **Admin screen AC jest** (test-engineer Critical #2). Added admin-section AC
   coverage following the `EODCountSection.countedOnce.test.tsx` pattern (the
   section's `buildSubmission`/gate are closures, so these exercise the EXACT
   composition the section performs — for AC-12 using the section's OWN exported
   gate predicate `deriveCountedItemIds` with the shared `applyCountOrder` /
   `firstUncounted`):
   - `EODCountSection.customOrder.test.tsx` — AC-9 (submission entry set
     byte-identical / iterates `filteredItems` not the reordered view), AC-10
     (search composes with the custom order), AC-12 (gate jump = topmost
     uncounted in the CUSTOM order, not default/alpha).
   - `InventoryCountSection.customOrder.test.tsx` — AC-9 (submission iterates
     `storeInventory`; the C-FE-1 category-chip-is-view-only invariant), AC-10
     (search composes), and the explicit NO-gate property (submit governed by
     `nonBlankCount`, no first-uncounted jump — AC-12 N/A here).

### Key should-fixes fixed

4. **Inventory i18n toasts** (code-reviewer). Added
   `section.countOrder.{saveFailed,saveFailedDetail,resetFailed}` to `en/es/zh-CN`
   and replaced the hardcoded English `Toast.show` text in
   `InventoryCountSection` onReorder/onResetOrder with `T(...)`. i18n-parity jest
   stays green (3 keys × 3 locales).

5. **Dedup `nudge`** (code-reviewer + architect). Moved the identical 7-line
   `nudge` reorder helper into the shared dependency-free `src/lib/countOrder.ts`
   (next to `applyCountOrder`/`firstUncounted`); both wrappers
   (`src/components/cmd/CountOrderDragList.tsx`,
   `src/screens/staff/components/CountOrderDragList.tsx`) now import it (and keep
   re-exporting it). `CountOrderDragList.nudge.test.tsx` now imports `nudge` from
   the shared module (dropping its supabase boundary mock — the shared module is
   pure). Also deduped the staff `CountOrderRow` interface — the staff wrapper now
   `import type { CountOrderRow }` from `./CountOrderDragListWeb` (matching the
   admin side).

6. **Stale / inaccurate comments**. Updated the staff `countOrder.ts` header +
   `saveCountOrder` doc (and the admin `db.ts` `saveCountOrder` doc, architect
   N-1) from the old "branches the onConflict target" / "explicitly here on
   update" wording to "delete-then-insert" with the accurate abort-mid-way note
   (an aborted insert after a committed delete leaves the row ABSENT, not
   reverted; the next drop re-saves).

### Verification (LOCAL only — no prod)

- `npx jest` → **771 passed, 74 suites** (was 755 / 69; +16 tests / +5 suites:
  db.saveCountOrder 3, staff persist 3, EODCountSection.customOrder 3,
  InventoryCountSection.customOrder 5, staff a11y 2; nudge stayed 6).
  i18n-parity green.
- `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` → both exit 0.
- **Web compile**: `npx expo export --platform web` (the Vercel build command)
  succeeds; output emits the two separate `CountOrderDragListWeb-*.js` chunks
  (admin + staff), confirming the lazy `Platform.OS === 'web'` `@dnd-kit`
  code-split survives the dedup/label changes.
- **Browser preview tools (`preview_*`) were not available in this environment**
  (same limitation the original frontend pass noted). Blocker 1 is instead pinned
  by the deterministic `CountOrderDragList.a11y.test.tsx` render assertion (the
  native ▲/▼ buttons carry the labels passed by each call site) — a durable
  CI-gated proof rather than a one-time manual inspection.
- **Teardown**: this fix-pass made NO DB writes (verification was jest +
  typecheck + web export, no live drag/persist), so it created zero
  `user_count_orders` rows; a local anon read returns `[]`. No prod writes.

### Files changed (review fix-pass)

Production:
- `src/lib/countOrder.ts` — added the shared pure `nudge(ids, index, delta)`.
- `src/components/cmd/CountOrderDragList.tsx` — import `nudge` from
  `../../lib/countOrder` (removed the local copy; keeps the re-export).
- `src/screens/staff/components/CountOrderDragList.tsx` — import `nudge` from the
  shared module; `import type { CountOrderRow }` from `./CountOrderDragListWeb`
  (dedup); added `moveUpLabel`/`moveDownLabel` props driving the native ▲/▼
  `accessibilityLabel`.
- `src/screens/staff/screens/WeeklyCount.tsx` — pass `t('weekly.reorder.*')` to
  `CountOrderDragList`.
- `src/screens/staff/screens/EODCount.tsx` — pass `t('eod.reorder.*')` to
  `CountOrderDragList`.
- `src/screens/cmd/sections/InventoryCountSection.tsx` — `T(...)` for the
  onReorder/onResetOrder error toasts; `T` added to the two useCallback deps.
- `src/lib/db.ts` — corrected the `saveCountOrder` doc comment (no UPDATE leg;
  abort-mid-way accuracy).
- `src/screens/staff/lib/countOrder.ts` — corrected the header + `saveCountOrder`
  doc comments (delete-then-insert; abort-mid-way accuracy).
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `section.countOrder.{saveFailed,saveFailedDetail,resetFailed}`.

Tests:
- `src/lib/db.saveCountOrder.test.ts` (new) — admin persist = delete-then-insert.
- `src/screens/staff/lib/countOrder.persist.test.ts` (new) — staff persist =
  delete-then-insert.
- `src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx` (new)
  — admin EOD AC-9 / AC-10 / AC-12.
- `src/screens/cmd/sections/__tests__/InventoryCountSection.customOrder.test.tsx`
  (new) — admin Inventory AC-9 / AC-10 / no-gate.
- `src/screens/staff/components/CountOrderDragList.a11y.test.tsx` (new) —
  screen-aware native ▲/▼ a11y labels.
- `src/components/cmd/CountOrderDragList.nudge.test.tsx` (modified) — imports the
  shared `nudge`; dropped the now-unneeded supabase mock.
