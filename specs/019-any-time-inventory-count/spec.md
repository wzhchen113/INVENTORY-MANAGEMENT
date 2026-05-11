# Spec 019: Any-time inventory count

Status: READY_FOR_REVIEW

> The user's verbatim ask: *"create an any day inventory count of all
> ingredient, doesn't matter which day and time."*
>
> This spec ports that ask into a concrete feature that coexists with the
> existing EOD count flow without breaking it. Three of the seven product
> decisions below are load-bearing on the data model and adjacent features
> (variance reporting, current_stock semantics, who can submit). All three
> have now been ratified by the user (see `⟪RESOLVED: user accepted default⟫`
> markers below); the four smaller decisions stay on their committed
> auto-mode defaults. Spec is ready for architect.

## User story

As a 2AM PROJECT store manager, I want to submit an inventory count of all
ingredients at any time of day — not just at end-of-day — so I can spot-check
stock when something looks off, recount after a delivery, or capture an
opening count for the morning, without losing my actual EOD record for that
date.

## Acceptance criteria

### Data model

- [ ] New table `public.inventory_counts` exists with columns:
      `id uuid pk default gen_random_uuid()`,
      `store_id uuid not null references stores(id) on delete cascade`,
      `counted_at timestamptz not null default now()`,
      `kind text not null check (kind in ('spot','open','mid_shift','close','eod'))`,
      `submitted_by uuid null references profiles(id)`,
      `submitted_at timestamptz not null default now()`,
      `status text not null default 'submitted' check (status in ('draft','submitted'))`,
      `client_uuid uuid null` (idempotency, mirrors `eod_submissions`),
      `notes text null`.
      Index on `(store_id, counted_at desc)` and `(store_id, kind, counted_at desc)`.
- [ ] New table `public.inventory_count_entries` exists with columns:
      `id uuid pk default gen_random_uuid()`,
      `count_id uuid not null references inventory_counts(id) on delete cascade`,
      `item_id uuid not null references inventory_items(id) on delete restrict`,
      `actual_remaining numeric(10,3) null`,
      `actual_remaining_cases numeric(10,3) null`,
      `actual_remaining_each numeric(10,3) null`,
      `unit text null`,
      `notes text null`,
      `created_at timestamptz not null default now()`.
      Index on `(count_id)` and `(item_id, created_at desc)`.
- [ ] `inventory_counts` and `inventory_count_entries` both have RLS enabled
      with per-store policies that delegate to `public.auth_can_see_store(store_id)`,
      mirroring the pattern in `20260504173035_per_store_rls_hardening.sql`.
      `inventory_count_entries` derives store visibility through its parent
      via an `EXISTS` join (mirrors how `eod_entries` is gated).
- [ ] EOD remains untouched. `eod_submissions` and `eod_entries` keep their
      `(store_id, date)` unique key and existing semantics. The new
      `inventory_counts` table is **additive**; the EOD path is not migrated
      into it as part of this spec.

### RPC

- [ ] New RPC `public.submit_inventory_count(p_client_uuid uuid, p_store_id
      uuid, p_kind text, p_counted_at timestamptz, p_status text, p_entries
      jsonb)` exists, returning `jsonb { count_id, conflict, entry_ids[] }`.
- [ ] RPC is `SECURITY INVOKER`, `SET search_path = public`, granted to
      `authenticated` and revoked from `PUBLIC`, `anon`. (Differs from
      `staff_submit_eod`, which is `SECURITY DEFINER` and locked to
      `service_role` because it's called from the staff edge function. See
      Q4 — if staff-app entry point is added later, a sibling
      service-role-gated function can be introduced then.)
- [ ] RPC validates: `p_kind in ('spot','open','mid_shift','close')`
      (rejects `'eod'` — EOD flows through `staff_submit_eod`),
      `p_entries` is a non-empty JSON array,
      caller can see `p_store_id` via `auth_can_see_store`.
- [ ] RPC is idempotent on `client_uuid` (same shape as `staff_submit_eod`):
      a repeat call with the same UUID returns the existing `count_id` with
      `conflict: true`.
- [ ] RPC writes the parent `inventory_counts` row and all child entries in
      one transaction (PostgREST implicit transaction).
- [ ] RPC does **not** update `inventory_items.current_stock`. Spot/open/
      mid_shift/close counts are advisory historical snapshots only. (See
      Q2 default — auto-mode committed read-only.)

### Frontend (Cmd UI, admin web + native)

- [ ] New section route `inventory-count` in `src/screens/cmd/sections/`
      named `InventoryCountSection.tsx` (or extends the existing
      `EODCountSection.tsx` — see Q5 default).
- [ ] Sidebar entry "Inventory count" sits next to "EOD count" in the Cmd
      UI sidebar layout. EOD count stays where it is. (See Q5 default —
      sibling, not replacement.)
- [ ] Screen lets the admin pick `kind` (`spot` | `open` | `mid_shift` |
      `close`) via a segmented control, with `spot` as default.
- [ ] Screen lets the admin pick `counted_at` (date + time picker,
      defaults to `now()`). A real-time clock label is fine.
- [ ] Screen lists all `inventory_items` for the active store, one row per
      item, with a numeric input for `actual_remaining` (plus optional
      `cases` and `each` inputs to mirror EOD's case/each split where the
      item has a case unit). Required: at least one entry. (See Q6 default
      — all-items default with submit allowed even if some are blank;
      blanks are skipped rather than zero-defaulted.)
- [ ] Submit button calls `submitInventoryCount` in `src/lib/db.ts`, which
      calls the RPC with a fresh `client_uuid`. On success: toast "Count
      submitted", clear form, optimistic-then-revert + `notifyBackendError`
      pattern (matches existing screens in `src/store/useStore.ts`).
- [ ] After submit, the screen shows a "Recent counts" list (last 10 for
      this store, any kind, descending by `counted_at`) with submitter
      name, timestamp, kind, and entry count. Clicking a row opens a
      read-only detail view of the entries.

### `db.ts` API additions

- [ ] `src/lib/db.ts` exports:
      - `submitInventoryCount(input: { storeId, kind, countedAt, status, entries, clientUuid })` →
        `{ countId: string; conflict: boolean; entryIds: string[] }`.
      - `listInventoryCounts(storeId: string, limit?: number)` →
        `Array<{ id, storeId, kind, countedAt, submittedBy, submittedAt, status, itemCount, submitterName? }>`.
      - `getInventoryCount(countId: string)` →
        `{ id, storeId, kind, countedAt, status, entries: Array<{ itemId, itemName, actualRemaining, actualRemainingCases?, actualRemainingEach?, unit?, notes? }> }`.
      All three follow the existing snake_case → camelCase `mapItem` pattern
      and route through `supabase.from(...)` / `supabase.rpc(...)`.
- [ ] No new state in `useStore.ts` for the count rows themselves — the
      section reads them directly via `db.ts` on mount and on a debounced
      400 ms realtime refresh. (Matches how Reports / EOD detail screens
      pull data on demand rather than mirroring it in the store.)

### Realtime

- [ ] `inventory_counts` and `inventory_count_entries` are included in the
      `supabase_realtime` publication (the publication is `FOR ALL TABLES`,
      so this is automatic, but call it out — and note the realtime
      publication restart gotcha in MEMORY.md applies if a manual
      `ALTER PUBLICATION` is ever needed).
- [ ] The `useRealtimeSync` hook treats inserts/updates on
      `inventory_counts` for the active `store_id` as a trigger to refetch
      the "Recent counts" list in the section if it's mounted.

### Out of scope (explicitly)

- **EOD migration / unification.** Not collapsing `eod_submissions` into the
  new table. Defer to a future spec. EOD keeps its `(store_id, date)` unique
  key and its `current_stock` overwrite behavior. Rationale: doing both in
  one spec touches the staff app's `staff_submit_eod` RPC and the variance
  template anchor, which multiplies the blast radius.
- **Variance template integration.** REPORTS-3 (spec 018) keeps anchoring on
  `eod_submissions` only. Spot counts are not yet selectable as variance
  anchors. (See Q3 default.) Future spec can extend the variance RPC to
  accept either count source.
- **Mobile camera / barcode scanning input.** Defer.
- **Approval workflow.** No manager-approves-spot-count step.
- **Real-time multi-user editing.** Single submitter per submit click.
- **Forecasting / predictive counts.** Defer.
- **Partial-category counts.** Defer. The screen lists all ingredients;
  user can submit with some blank entries (treated as "not counted, skip"),
  but the UI doesn't let them filter to a single category yet.
- **Retention / archive policy.** No automatic purge of old counts in this
  spec. The existing `prune-data` infrastructure can be extended later.
- **Staff-app entry point.** The staff app (separate repo) is not extended
  in this spec. (See Q4 default.)
- **Per-store unit toggle for `cases`/`each` display.** Reuse whatever the
  EOD screen already does for the same items; no new unit-display logic.

## Open questions

> Auto-mode defaults are committed for all seven so the architect has a
> consistent target. The three load-bearing questions (Q1, Q3, Q4) were
> ratified by the user — see `⟪RESOLVED: user accepted default⟫` markers
> below. The four smaller decisions stay on their committed auto-mode
> defaults.

### Q1 — New flow vs. relaxed EOD ⟪RESOLVED: user accepted default⟫

- **Default (auto-mode):** Path A — new `inventory_counts` table parallel
  to `eod_submissions`. EOD stays untouched.
- **Why this default:** Smallest blast radius. `staff_submit_eod`, the
  variance template anchor, and the staff app's existing contract all keep
  working unchanged. Easy to unify later if desired.
- **Alternatives the user can pick:**
  - Path B: Generalize `eod_submissions` → `inventory_count_submissions`.
    Drop the `(store_id, date)` unique key. EOD becomes a `kind`. Higher
    blast radius — touches staff app, variance, and existing data.
  - Path C: Keep `eod_submissions` but drop the unique key so multiple
    same-day submissions are allowed. Blurs "EOD" semantics.
- **If flipped to B or C:** the data-model section above changes
  substantially, REPORTS-3's anchor query may need rework, and `eod` would
  re-enter the allowed `kind` enum (Q3 becomes coupled).

### Q2 — Does an any-time count update `current_stock`?

- **Default (auto-mode):** No. Spot/open/mid_shift/close counts are
  read-only historical snapshots. `current_stock` is overwritten only by
  EOD and by receiving/waste paths that already do so today.
- **Why this default:** Variance is anchored on `eod_entries.actual_remaining`,
  not on `current_stock`. So variance keeps working. And a 2am spot-check
  shouldn't overwrite the live stock figure that drives reorder alerts
  later that day.
- **Alternatives:** always-overwrite (most-recent-wins), or per-kind opt-in
  via an RPC param. Easy to flip later if the user wants spot counts to
  drive live stock.

### Q3 — Does an any-time count anchor variance? ⟪RESOLVED: user accepted default⟫

- **Default (auto-mode):** No. Variance (REPORTS-3, spec 018) keeps
  anchoring on `eod_submissions` only. Spot counts are advisory.
- **Why this default:** REPORTS-3 just shipped. Extending its anchor source
  is a separate concern with its own UX (the user has to pick a count by
  timestamp, not by date). Don't mix it in.
- **Alternatives:** allow any count as an anchor; or add a `kind` filter
  param to the variance RPC. If flipped, the variance RPC contract from
  spec 018 needs an additive change in a follow-up spec.

### Q4 — Who can submit? ⟪RESOLVED: user accepted default⟫

- **Default (auto-mode):** Admin web (and native build) only. The RPC is
  `SECURITY INVOKER`, granted to `authenticated`. RLS gates per-store
  visibility.
- **Why this default:** This repo is admin-only (per CLAUDE.md). The staff
  app lives in a sibling repo and would need its own service-token gated
  edge function (mirror of `staff-submit-eod`). That's a cross-repo change
  out of scope for this spec.
- **Alternatives:** staff-app-only (no admin UI, just admin read view) or
  both. If flipped to "both", a sibling `staff_submit_inventory_count` RPC
  + edge function would be needed in a follow-up spec and probably in the
  staff-app repo.

### Q5 — Sidebar UX

- **Default (auto-mode):** Add a new "Inventory count" sibling entry next
  to "EOD count" in the Cmd UI sidebar. EOD count entry is unchanged.
- **Why this default:** Doesn't change muscle memory for existing users.
  Easy to roll into a single entry later if usage patterns suggest it.
- **Alternatives:** rename "EOD count" → "Inventory count" with a `kind`
  toggle inside; or replace EOD count entirely. Both have larger UX impact
  and touch a screen used daily.

### Q6 — Partial counts

- **Default (auto-mode):** Screen lists all ingredients. Submit is allowed
  with some blank entries; blanks are skipped (not stored as zero). At
  least one entry must be non-blank to submit.
- **Why this default:** Matches the user's verbatim ask ("count of all
  ingredient") while accommodating the realistic spot-check scenario where
  a user only wants to confirm a couple of items. Zero-defaulting blanks
  would overwrite history with false data.
- **Alternative:** require every item to have a value (true full-count
  semantics). Easy to flip with a frontend validation change.

### Q7 — History / audit display

- **Default (auto-mode):** Show the last 10 counts for the active store in
  a "Recent counts" panel on the same section, descending by `counted_at`.
  Click a row to see entry details (read-only). No pagination, no filters
  in this spec.
- **Why this default:** Mirrors the lightweight "recent X" pattern other
  Cmd UI sections use. Easy to extend with pagination/filters later if the
  list grows past 10.
- **Alternative:** dedicated "Inventory count history" subsection with
  pagination, filters by kind / date range / submitter. Defer to a future
  spec.

## Dependencies

- Migration files in `supabase/migrations/` — at least one creating the two
  tables, the RPC, and the RLS policies. Timestamp must be after
  `20260510130000_report_runs_consistency.sql` (the most recent migration
  on disk at spec-write time).
- `public.auth_can_see_store(uuid)` — already shipped in
  `20260504173035_per_store_rls_hardening.sql`. Reused.
- `public.auth_is_admin()` — already shipped. Reused (delegated through
  `auth_can_see_store`).
- `inventory_items` table (existing) — referenced by entries.
- `stores`, `profiles` tables (existing) — referenced.
- `src/lib/db.ts` — three new functions.
- `src/screens/cmd/sections/InventoryCountSection.tsx` — new file (or
  extends `EODCountSection.tsx`).
- `src/lib/cmdSelectors.ts` — sidebar/section registration (whatever the
  existing pattern is for new Cmd sections — see `EODCountSection.tsx`
  registration as a reference).
- `src/hooks/useRealtimeSync.ts` — adds the two new table names to the
  watched set for the active store (one-line change if the hook is
  table-list-driven; if it's wildcard, no change).
- `useStore.ts` — no new state needed.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI (`src/screens/cmd/sections/`). The
  legacy `src/screens/AdminScreens.tsx` is explicitly NOT touched.
- **Per-store or admin-global:** Per-store. Both new tables are gated by
  `auth_can_see_store(store_id)`.
- **Realtime channels touched:** `store-{id}`. New tables included in the
  existing `FOR ALL TABLES` publication automatically.
- **Migrations needed:** Yes. One new migration creating the two tables,
  RLS policies, indexes, and the `submit_inventory_count` RPC.
- **Edge functions touched:** None in this spec. (Q4 default keeps this an
  admin-web-only feature; staff-app entry point would add a sibling
  `staff-submit-inventory-count` function in a future spec.)
- **Web/native scope:** Both. Pure React Native components in the Cmd UI
  section; no web-only or native-only APIs needed.
- **`app.json` slug:** Not touched. (Spec doesn't change build identifiers.)
- **Tests:** No test framework wired up yet. If reviewer wants automated
  coverage, test-engineer will need to flag what to add. Manual smoke-test
  pattern from prior specs: insert via RPC with a non-admin JWT, confirm
  RLS denies cross-store reads, confirm idempotency on duplicate
  `client_uuid`.

## Risks & gotchas

- **Realtime publication restart gotcha (MEMORY.md).** New tables auto-join
  the `FOR ALL TABLES` publication, but if anyone has run a mid-session
  `ALTER PUBLICATION`, `docker restart supabase_realtime_imr-inventory` is
  needed for the slot to re-snapshot. Flag to release-coordinator.
- **Counts vs. current_stock divergence.** With Q2 default = "no
  overwrite", `current_stock` will diverge from the most recent
  `inventory_count_entries.actual_remaining` between EODs. This is
  intentional but should be called out in the UI ("This count is for the
  record — does not affect live stock until the next EOD.").
- **Q1, Q3, Q4 load-bearing questions resolved.** User ratified all three
  auto-mode defaults (Path A new table; no variance anchor change; admin
  web/native only). No follow-up spec rewrites needed before architect.

## Backend Architecture

> Architect output for `READY_FOR_BUILD`. PM-resolved decisions are not
> re-litigated. All snippets are *design illustrations* — the developer
> authors the committed `.sql` and `.ts` content.

### 0. Summary

- **One new migration**, `supabase/migrations/20260513000000_inventory_counts.sql`.
- **No edge function changes.** Admin-only RPC, `security invoker`,
  granted to `authenticated`.
- **No realtime publication change.** `supabase_realtime` is `FOR ALL TABLES`
  (see `20260502190000_realtime_publication.sql:14`); new tables join the
  publication automatically. The `docker restart
  supabase_realtime_imr-inventory` ritual does NOT apply.
- **No `useStore.ts` slice for the count rows themselves.** Section
  fetches via `db.ts` on mount + on a debounced 400ms realtime nudge —
  mirrors how `loadLatestRun` keeps the boot payload bounded
  (`src/store/useStore.ts:368-369, 1915-1925`).
- **Three new `db.ts` helpers** plus three new TypeScript types.
- **One new Cmd section file** `InventoryCountSection.tsx`, registered
  in `cmdSelectors.ts` (sidebar) and dispatched from
  `InventoryDesktopLayout.tsx`.

### 1. Data model

Two tables, both per-store, both gated by `auth_can_see_store(store_id)`.

#### 1.1 `inventory_counts`

Columns per AC §Data model:

| column          | type                       | notes                                                              |
|-----------------|----------------------------|--------------------------------------------------------------------|
| `id`            | `uuid pk default gen_random_uuid()` |                                                                    |
| `store_id`      | `uuid not null references stores(id) on delete cascade` | cascade matches `eod_submissions`                                  |
| `counted_at`    | `timestamptz not null default now()` | user-pickable; defaults to submission time                        |
| `kind`          | `text not null check (kind in ('spot','open','mid_shift','close'))` | `'eod'` excluded — EOD flows through `staff_submit_eod`           |
| `submitted_by`  | `uuid null references profiles(id) on delete set null` |                                                                    |
| `submitted_at`  | `timestamptz not null default now()` |                                                                    |
| `status`        | `text not null default 'submitted' check (status in ('draft','submitted'))` |                                                                    |
| `client_uuid`   | `uuid null`                | idempotency; mirrors `eod_submissions.client_uuid`                  |
| `notes`         | `text null`                |                                                                    |
| `created_at`    | `timestamptz not null default now()` | trailing audit column matching the rest of the schema             |

Indexes:
- `inventory_counts_store_counted_at_idx (store_id, counted_at desc)` —
  drives "Recent counts" list pull.
- `inventory_counts_store_kind_counted_at_idx (store_id, kind, counted_at desc)` —
  drives any future "last spot count" / "last open count" lookups; cheap
  to add now.
- `unique (client_uuid) where client_uuid is not null` — idempotency.
  Partial so legacy NULL rows don't collide.

**`kind` as a CHECK, not an enum.** Match `eod_submissions.status` style.
Easier to extend in a follow-up if the user wants `'inventory_audit'`,
`'cycle_count'`, etc. without an `ALTER TYPE`.

**Unique key on `(store_id, counted_at)`?** No. The spec answer to
"multiple counts at the same instant" is: allow. Two managers in different
rooms can submit at the same wall-clock second. The `client_uuid`
idempotency key handles the only real duplicate case (single submitter
re-clicks Submit).

#### 1.2 `inventory_count_entries`

| column                    | type                                       | notes                                                              |
|---------------------------|--------------------------------------------|--------------------------------------------------------------------|
| `id`                      | `uuid pk default gen_random_uuid()`        |                                                                    |
| `count_id`                | `uuid not null references inventory_counts(id) on delete cascade` |                                                                    |
| `item_id`                 | `uuid not null references inventory_items(id) on delete restrict` | see below                                                          |
| `actual_remaining`        | `numeric(10,3) null`                       | total in base units                                                |
| `actual_remaining_cases`  | `numeric(10,3) null`                       | mirrors `eod_entries.actual_remaining_cases`                       |
| `actual_remaining_each`   | `numeric(10,3) null`                       | mirrors `eod_entries.actual_remaining_each`                        |
| `unit`                    | `text null`                                | captured at submit time to survive later unit changes              |
| `notes`                   | `text null`                                |                                                                    |
| `created_at`              | `timestamptz not null default now()`       |                                                                    |

Indexes:
- `inventory_count_entries_count_id_idx (count_id)` — entry lookup.
- `inventory_count_entries_item_created_idx (item_id, created_at desc)` —
  supports a future "last spot count of item X" pull.

**FK on `item_id`: `ON DELETE RESTRICT`.** Rationale: spot counts are
historical snapshots. If the user deletes an inventory item six months
later, we don't want the count history to silently lose rows. `RESTRICT`
forces the deleter to confront the count history first (or soft-delete
the item, which doesn't exist yet — surface as future work). EOD entries
use the same posture (`eod_entries.item_id` is NOT marked cascade in
`init_schema`).

**No `actual_remaining` NOT NULL.** AC §Frontend Q6 = "blanks are skipped,
not zero-defaulted." We could enforce that the RPC drops blank entries
client-side — but a defensive NULL allowance at the column level also
protects against a future "save partial draft" flow that wants to keep
blank rows around. The RPC's validation rule is "at least one entry has a
non-null `actual_remaining`" (see §3).

### 2. RLS

Four policies per table, all delegating to `auth_can_see_store(store_id)`.
Child table reads through `EXISTS` on the parent (same shape as
`eod_entries`, `20260504173035_per_store_rls_hardening.sql:87-132`).

```sql
-- inventory_counts: store_member_read/insert/update/delete
create policy "store_member_read_inventory_counts"
  on public.inventory_counts for select
  using (public.auth_can_see_store(store_id));
-- (insert/update/delete follow the exact same template as report_runs:118-132)

-- inventory_count_entries: scoped through parent
create policy "store_member_read_inventory_count_entries"
  on public.inventory_count_entries for select
  using (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  );
-- (insert/update/delete follow eod_entries:87-132)
```

Cross-store visibility for super-admin / admin / master is preserved
because `auth_can_see_store` short-circuits to `auth_is_admin()`
(`per_store_rls_hardening.sql:33-41`).

### 3. RPC: `public.submit_inventory_count`

```sql
create or replace function public.submit_inventory_count(
  p_client_uuid uuid,
  p_store_id    uuid,
  p_kind        text,
  p_counted_at  timestamptz,
  p_status      text,
  p_entries     jsonb,
  p_notes       text
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_count_id    uuid;
  v_entry       record;
  v_entry_ids   uuid[] := ARRAY[]::uuid[];
  v_entry_id    uuid;
  v_kept_count  int := 0;
begin
  -- (a) Auth gate FIRST — raise 42501 if not visible.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (b) Kind allowlist — reject 'eod' explicitly.
  if p_kind is null or p_kind not in ('spot','open','mid_shift','close') then
    raise exception 'invalid kind %', p_kind using errcode = '22023';
  end if;

  -- (c) Status allowlist.
  if coalesce(p_status, 'submitted') not in ('draft','submitted') then
    raise exception 'invalid status %', p_status using errcode = '22023';
  end if;

  -- (d) p_entries must be a JSON array with at least one element. The
  --     "≥1 NON-BLANK" rule is enforced AFTER we walk the array (below).
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 1 then
    raise exception 'p_entries must be a non-empty array' using errcode = '22023';
  end if;

  -- (e) Idempotency check — mirrors staff_submit_eod:43-54.
  if p_client_uuid is not null then
    select id into v_existing_id
      from public.inventory_counts
     where client_uuid = p_client_uuid;
    if v_existing_id is not null then
      return jsonb_build_object(
        'count_id', v_existing_id,
        'conflict', true,
        'entry_ids', '[]'::jsonb
      );
    end if;
  end if;

  -- (f) Insert the parent row.
  insert into public.inventory_counts
    (store_id, counted_at, kind, submitted_by, status, client_uuid, notes)
  values
    (p_store_id,
     coalesce(p_counted_at, now()),
     p_kind,
     auth.uid(),           -- canonical — never trust a client-supplied submitter
     coalesce(p_status, 'submitted'),
     p_client_uuid,
     p_notes)
  returning id into v_count_id;

  -- (g) Walk entries. Blank rows (all three remaining-* null) are
  --     SKIPPED, not stored. Non-null entries must validate against
  --     inventory_items in this store.
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      item_id uuid,
      actual_remaining numeric,
      actual_remaining_cases numeric,
      actual_remaining_each numeric,
      unit text,
      notes text
    )
  loop
    -- Skip fully-blank entries.
    if v_entry.actual_remaining is null
       and v_entry.actual_remaining_cases is null
       and v_entry.actual_remaining_each is null then
      continue;
    end if;

    -- Non-negative check on whatever values were supplied.
    if coalesce(v_entry.actual_remaining, 0) < 0
       or coalesce(v_entry.actual_remaining_cases, 0) < 0
       or coalesce(v_entry.actual_remaining_each, 0) < 0 then
      raise exception 'counted_qty must be >= 0' using errcode = '22023';
    end if;

    -- Item must exist AND belong to this store. The `exists` cheaper
    -- than `select … into` and the RLS read policy ensures the
    -- visibility check is enforced at the row level.
    if not exists (
      select 1 from public.inventory_items
       where id = v_entry.item_id and store_id = p_store_id
    ) then
      raise exception 'item % not in store %', v_entry.item_id, p_store_id
        using errcode = '23503';
    end if;

    insert into public.inventory_count_entries
      (count_id, item_id, actual_remaining, actual_remaining_cases,
       actual_remaining_each, unit, notes)
    values
      (v_count_id, v_entry.item_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       v_entry.unit, coalesce(v_entry.notes, ''))
    returning id into v_entry_id;

    v_entry_ids := array_append(v_entry_ids, v_entry_id);
    v_kept_count := v_kept_count + 1;
  end loop;

  -- (h) At least one non-blank entry required per AC §Frontend Q6.
  if v_kept_count = 0 then
    raise exception 'no non-blank entries' using errcode = '22023';
    -- The parent insert above will roll back automatically because the
    -- whole RPC body runs inside PostgREST's implicit transaction.
  end if;

  return jsonb_build_object(
    'count_id', v_count_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids)
  );
end;
$$;

revoke execute on function public.submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text) from public, anon;
grant  execute on function public.submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text) to authenticated;
```

Notes:
- **`security invoker`** — RLS gates the data. Differs from
  `staff_submit_eod` which is `security definer` + service-role only
  because the staff app uses a service-token edge function. See spec Q4.
- **`set search_path = public`** — locks the schema.
- **REVOKE from `public, anon`** — Postgres defaults grant EXECUTE to
  PUBLIC and `anon` inherits from PUBLIC; matches the pattern in
  `report_runs.sql:210`.
- **`submitted_by` is server-canonical**: the RPC writes `auth.uid()`
  unconditionally. Client cannot forge submitter (parallels the
  `report_runs.ran_by` lockdown in `20260510130000_report_runs_consistency.sql:58-61`).
- **Counts vs `current_stock`**: the RPC does NOT touch
  `inventory_items.current_stock` or `eod_remaining`. Per Q2 default —
  spot counts are advisory. Reviewers should confirm no path in here
  writes to `inventory_items`.

### 4. Helper RPC for history — RECOMMENDATION: PostgREST direct

No new RPC for the "Recent counts" panel. Use PostgREST embed:

```ts
supabase.from('inventory_counts')
  .select(`
    id, store_id, kind, counted_at, submitted_by, submitted_at, status, notes,
    submitter:profiles!submitted_by(name),
    inventory_count_entries(count)
  `)
  .eq('store_id', storeId)
  .order('counted_at', { ascending: false })
  .limit(10);
```

Rationale: matches the existing `fetchRecentEODSubmissions` shape
(`src/lib/db.ts:458-500`) and avoids an RPC for a read that RLS already
gates. The `inventory_count_entries(count)` aggregate gives the
`itemCount` per row in a single round-trip, same trick as the EOD path.

For the read-only detail drill-in (Q7), still PostgREST:

```ts
supabase.from('inventory_counts')
  .select(`
    id, store_id, kind, counted_at, submitted_by, submitted_at, status, notes,
    submitter:profiles!submitted_by(name),
    inventory_count_entries(
      id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, unit, notes, created_at,
      item:inventory_items(catalog:catalog_ingredients(name, unit))
    )
  `)
  .eq('id', countId)
  .single();
```

### 5. `src/lib/db.ts` surface

Three new exported helpers added at the end of the EOD section
(after `fetchEodSubmissionsForStores`, ~line 600). All three follow the
existing snake_case → camelCase `mapItem`-style pattern.

```ts
// ─── INVENTORY COUNTS (Spec 019) ────────────────────────────────────────

import type { InventoryCount, InventoryCountKind, InventoryCountEntry } from '../types';

export async function submitInventoryCount(input: {
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;             // ISO; defaults to now() server-side if null
  status?: 'draft' | 'submitted';
  entries: Array<{
    itemId: string;
    actualRemaining?: number | null;
    actualRemainingCases?: number | null;
    actualRemainingEach?: number | null;
    unit?: string | null;
    notes?: string | null;
  }>;
  notes?: string | null;
  clientUuid: string;            // caller mints; idempotency
}): Promise<{ countId: string; conflict: boolean; entryIds: string[] }>;

export async function fetchRecentInventoryCounts(
  storeId: string,
  limit?: number,                // default 10
): Promise<InventoryCountSummary[]>;

export async function fetchInventoryCount(
  countId: string,
): Promise<InventoryCount | null>;
```

`InventoryCountSummary` is the list-row shape (no entries, just count +
submitter). `InventoryCount` is the detail shape (full entries with item
name hydrated via the `catalog:catalog_ingredients(name, unit)` embed —
same trick as `fetchRecentEODSubmissions`).

`submitInventoryCount` calls the RPC via `supabase.rpc(...)`. On RPC
error, throw — the caller (store action) routes through
`notifyBackendError` per `useStore.ts:25`.

### 6. Store slice

**No new persistent slice.** The section reads counts on mount via
`db.ts` directly. This mirrors `loadLatestRun` (`useStore.ts:305,
1915-1925`) — designed to keep boot payload bounded.

Two new store-level actions only:

```ts
// useStore.ts — Spec 019 actions
submitInventoryCount: (input: {
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;
  status?: 'draft' | 'submitted';
  entries: Array<...>;
  notes?: string | null;
}) => Promise<{ countId: string; conflict: boolean } | null>;
// Mints client_uuid internally (crypto.randomUUID()), calls db.submitInventoryCount.
// On error: console.warn + notifyBackendError('Submit inventory count', e).
// No optimistic mutation (no persistent slice to mutate).
```

That's it. The section component owns the form state, the recent-counts
fetch, and the detail-drill fetch — all via `useState` + `useEffect`.

The blank-skip rule is enforced TWICE for defense in depth:
1. Frontend (`InventoryCountSection.tsx`) strips fully-blank rows before
   handing the array to `submitInventoryCount`.
2. RPC body's per-entry NULL-skip + final `v_kept_count = 0` guard.

### 7. Realtime

- **Publication membership**: no change. `supabase_realtime` is
  `FOR ALL TABLES` (`20260502190000_realtime_publication.sql:14`); the
  new tables join automatically. **No `docker restart
  supabase_realtime_imr-inventory` step required.**
- **`useRealtimeSync`**: add `inventory_counts` to the per-store channel
  filtered on `store_id=eq.${storeId}`. We do NOT need
  `inventory_count_entries` on the channel — when the parent row lands,
  the section refetches the list, which embeds the entry count, which
  forces the entries to load on detail-drill. (Same trick as
  `eod_submissions` not needing `eod_entries` on the channel.)

```ts
// useRealtimeSync.ts addition
.on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_counts',
                          filter: `store_id=eq.${storeId}` }, onSync)
```

- **The 400ms debounced reload** triggers the global `loadFromSupabase`,
  which is what every other section already uses. But since spec 019
  doesn't add a persistent slice, the global reload is a no-op for counts.
  The section itself needs to re-pull on the same realtime nudge. Two
  options:
  - **Option A (recommended):** subscribe directly in
    `InventoryCountSection` with a local `useEffect` + `supabase.channel`.
    Mirrors how Reports does its own per-run fetch.
  - **Option B:** extend `useRealtimeSync`'s `onSync` callback to also
    bump a `inventoryCountsRefreshTick` counter in the store, which the
    section watches.
  - Pick A. Simpler; doesn't pollute the store with a tick counter that
    only one section consumes.

### 8. Cmd UI section

- **New file**: `src/screens/cmd/sections/InventoryCountSection.tsx`.
  Structure mirrors `EODCountSection.tsx`:
  - Worksheet pane (no week sidebar — the date is per-submit, not per-day).
  - `TabStrip` at the top: `count.tsx` (form) + `history.tsx` (recent).
  - Inside `count.tsx` tab:
    - **Header strip**: segmented control for `kind` (`spot` default),
      date+time picker for `counted_at` (defaults to live clock label),
      optional notes input.
    - **Item list**: all `inventory_items` for the active store. Group
      by category (same pattern as EOD). Each row has the same dual
      `box/case` + `count` inputs as EOD when `caseQty > 1`, single
      `count` input otherwise. Blank rows render as empty inputs (no
      zero-default placeholder swap).
    - **Sticky footer**: counted-non-blank/total counter, est. value,
      SUBMIT COUNT button. Disabled when zero non-blank entries.
  - Inside `history.tsx` tab:
    - Recent counts list (10 rows, descending by `counted_at`).
    - Click a row → slide-in detail panel (or modal on phone) showing
      the entries read-only.
- **Sidebar registration** in `src/lib/cmdSelectors.ts`:
  - Add `{ id: 'InventoryCount', label: 'Inventory count' }` to the
    `Operations` group's `items` array, immediately after the existing
    `{ id: 'EODCount', label: 'EOD count' }` line
    (`cmdSelectors.ts:1038`).
  - Add the same id+label to `SCREEN_ENTRIES` (`cmdSelectors.ts:162`)
    so the ⌘K palette routes to it as a screen jump.
- **Section dispatch** in `src/screens/cmd/InventoryDesktopLayout.tsx`:
  - Import `InventoryCountSection` at the top
    (`InventoryDesktopLayout.tsx:33`).
  - Add an `else if (section === 'InventoryCount')` arm to the
    dispatch ladder, immediately after the `EODCount` arm
    (`InventoryDesktopLayout.tsx:157-158`).
- **Coming-soon fallback**: not needed once the section is wired — the
  generic `ComingSoonPanel` arm below catches anything not listed.

### 9. TypeScript types

Add to `src/types/index.ts` near the EOD types (line 214 onward):

```ts
export type InventoryCountKind = 'spot' | 'open' | 'mid_shift' | 'close';

export interface InventoryCountEntry {
  id: string;
  countId: string;
  itemId: string;
  itemName: string;                      // hydrated via catalog join
  actualRemaining: number | null;
  actualRemainingCases?: number | null;
  actualRemainingEach?: number | null;
  unit?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface InventoryCount {
  id: string;
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;
  submittedBy: string | null;
  submitterName?: string;                // hydrated via profiles join
  submittedAt: string;
  status: 'draft' | 'submitted';
  clientUuid?: string | null;
  notes?: string | null;
  createdAt: string;
  entries: InventoryCountEntry[];        // populated by fetchInventoryCount only
}

// List-row shape — no entries, includes derived itemCount.
export interface InventoryCountSummary {
  id: string;
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;
  submittedBy: string | null;
  submitterName?: string;
  submittedAt: string;
  status: 'draft' | 'submitted';
  itemCount: number;
}
```

### 10. Frontend mapping (form-to-RPC contract)

1. **List rendering**: all items in `useStore.inventory` filtered by
   `currentStore.id`, grouped by `category`, sorted within group by
   `name`. Same shape as EOD's `storeInventory` / `grouped` derivations
   in `EODCountSection.tsx:165-248`.

2. **Blank-skip rule (Q6)**: a row is "blank" when all three of
   `caseCounts[id]`, `unitCounts[id]`, and (the implicit total) are
   empty strings or parse to NaN. The submit handler filters the
   item list to non-blank rows, then maps each kept row into the RPC
   `entries[]` array as:

   ```ts
   {
     item_id: it.id,
     actual_remaining: total,                // cases × caseQty + each
     actual_remaining_cases: parsedCases,    // undefined → null
     actual_remaining_each:  parsedEach,
     unit: it.unit,
     notes: notes[it.id] || null,
   }
   ```

3. **Submit-button gating**: disabled when
   `nonBlankCount === 0 || submitting || !currentStore.id`. No "rest day"
   logic — the spec ditches the week filter (spot counts happen any day).

4. **`client_uuid`**: minted in the store action via
   `crypto.randomUUID()`. Recorded ONCE per submit click; re-clicking
   with the same UUID returns `{ conflict: true }` and the toast says
   "Already submitted" instead of "Count submitted".

5. **On success**: `Toast.show({ type: 'success', text1: 'Count submitted',
   text2: \`${kept} items · ${kindLabel}\` })`. Clear form. Bump local
   `recentCountsRefreshTick` to force the history tab to refetch.

6. **On error**: `notifyBackendError('Submit inventory count', e)` —
   toast + console.warn. Don't optimistically mutate — there's no
   persistent slice to revert.

7. **Detail drill-in (Q7)**: clicking a row in the history tab fires
   `db.fetchInventoryCount(countId)` and renders a read-only entries
   table in a side panel. Use the same `ReportDetailFrame`-style
   slide-out OR a modal on phone (same breakpoint as EOD's
   `useIsPhone()`).

### 11. Risks and tradeoffs

- **`current_stock` divergence (Q2 acknowledged).** Between EODs,
  `inventory_items.current_stock` may diverge from the most recent
  spot-count `actual_remaining`. Intentional — the spec says spot counts
  are advisory. UI should call this out with a one-liner: "This count is
  for the record — it does not affect live stock until the next EOD."
- **Variance feature gap (Q3 acknowledged).** REPORTS-3
  (`20260512120000_report_run_variance.sql`) keeps anchoring on
  `eod_submissions` only. A future spec can extend its inner runner to
  accept a `kind` filter; nothing in this spec blocks that.
- **Cross-table consistency**: no trigger needed. Unlike `report_runs`
  (which had a forgeable `definition_id` cross-store spoof — see
  `20260510130000_report_runs_consistency.sql:48-88`),
  `inventory_count_entries` is gated through its parent via the
  `EXISTS` RLS clause, AND the RPC's per-entry validation already
  asserts `inventory_items.store_id = p_store_id`. The two checks
  combined close any cross-store spoof attempt.
- **Large batches**: a single submission with 200 entries iterates the
  `for v_entry in jsonb_to_recordset ...` loop 200 times with one
  `exists` check + one `insert` per iteration. ~400 round-trips of
  planner work inside a single transaction. Acceptable for v1; if
  someone bulk-pastes 1000+ entries we can move to a `select ... from
  jsonb_to_recordset(...)` set-based insert with a single `exists`
  precheck via `EXCEPT`. Out of scope.
- **Stale item between load and submit**: an item gets deleted in
  another tab while the form is open. The RPC's `exists` check raises
  `23503`; the frontend toasts "Item no longer exists in this store"
  and refuses the submit. The user reloads the form to see the
  current item list. Realtime nudge on `inventory_items` already
  drives this refresh.
- **Migration ordering**: filename `20260513000000_inventory_counts.sql`
  sorts strictly after the latest existing migration
  (`20260512120000_report_run_variance.sql`). Manual application is the
  current reality — README's `db-migrations-applied.yml` CI workflow is
  not on disk (CLAUDE.md "CI workflow"), so the developer must run
  `supabase migration up` locally and verify before commit.
- **No staff-app integration.** Spec is admin-only (Q4). If the staff
  app ever needs to write counts, a sibling
  `staff_submit_inventory_count(...)` RPC + edge function will be
  needed, with the same `security definer` + service-role lockdown as
  `staff_submit_eod`. That's a separate spec in a separate repo.

### 12. Files the developers will touch

| file                                                          | change                                                         |
|---------------------------------------------------------------|----------------------------------------------------------------|
| `supabase/migrations/20260513000000_inventory_counts.sql`     | NEW — tables, indexes, RLS, RPC                                |
| `src/types/index.ts`                                          | +`InventoryCountKind`, `InventoryCountEntry`, `InventoryCount`, `InventoryCountSummary` |
| `src/lib/db.ts`                                               | +`submitInventoryCount`, `fetchRecentInventoryCounts`, `fetchInventoryCount` (+ a `mapInventoryCount`-style helper) |
| `src/store/useStore.ts`                                       | +`submitInventoryCount` action (no new state slice)            |
| `src/lib/cmdSelectors.ts`                                     | +sidebar entry + +SCREEN_ENTRIES entry                         |
| `src/screens/cmd/InventoryDesktopLayout.tsx`                  | +import + +dispatch arm                                        |
| `src/screens/cmd/sections/InventoryCountSection.tsx`          | NEW                                                            |
| `src/hooks/useRealtimeSync.ts`                                | +1 line — `inventory_counts` on the per-store channel          |

No edge function changes. No `vercel.json` / `eas.json` changes. No
`app.json` slug change.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the Backend Architecture section in this spec.
  Backend-developer owns the migration (tables, RLS, RPC) and the new
  `db.ts` helpers + `useStore.ts` action. Frontend-developer owns the
  new `InventoryCountSection.tsx`, the sidebar registration in
  `cmdSelectors.ts`, the dispatch arm in `InventoryDesktopLayout.tsx`,
  the type additions in `src/types/index.ts`, and the 1-line addition
  to `useRealtimeSync.ts`. Both: after implementation, set
  `Status: READY_FOR_REVIEW` and list files changed under `## Files
  changed`.
payload_paths:
  - specs/019-any-time-inventory-count/spec.md

## Files changed

### Backend (this developer)

Migrations:
- `supabase/migrations/20260513000000_inventory_counts.sql` — NEW. Tables
  `inventory_counts` + `inventory_count_entries` with indexes
  (`(store_id, counted_at desc)`, `(store_id, kind, counted_at desc)`,
  partial-unique on `client_uuid`, `(count_id)`, and
  `(item_id, created_at desc)`); RLS enabled on both with the four
  per-store policies (entries scoped through parent via `EXISTS`); RPC
  `public.submit_inventory_count(p_client_uuid, p_store_id, p_kind,
  p_counted_at, p_status, p_entries, p_notes)` — `security invoker`,
  `set search_path = public`, REVOKE EXECUTE from `public, anon`, GRANT
  to `authenticated`. Server-canonical `submitted_by := auth.uid()`.
  Validates kind/status allowlists (raises `22023`), `auth_can_see_store`
  (raises `42501`), per-entry non-negativity (`22023`), cross-store
  `item_id` (`23503`); skips fully-blank entries; requires ≥ 1 non-blank
  to commit; idempotency on `client_uuid`. Header comment documents
  idempotency model, `ON DELETE RESTRICT` rationale, no
  `(store_id, counted_at)` unique, and the no-`current_stock`-write
  property.

Frontend-developer also touched the following files in parallel; the
backend-relevant additions are listed for reviewer context:

- `src/types/index.ts` — `InventoryCountKind`, `InventoryCountEntry`,
  `InventoryCount`, `InventoryCountSummary` types.
- `src/lib/db.ts` — `submitInventoryCount`, `fetchRecentInventoryCounts`,
  `fetchInventoryCount` helpers (snake→camel mapped). Calls the RPC and
  the two PostgREST embeds described in §4 of the architect's design.
- `src/store/useStore.ts` — `submitInventoryCount` action (lazy-load
  model, mints `client_uuid` via `crypto.randomUUID()`, routes errors
  through `notifyBackendError('Submit inventory count', e)`). No
  persistent slice for count rows.
- `src/hooks/useRealtimeSync.ts` — adds `inventory_counts` to the
  per-store channel filtered on `store_id=eq.${storeId}`.

### Verification performed

- Migration applied locally via
  `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres`.
- 11 RPC smoke tests under `set_config('request.jwt.claims', …, true)`
  impersonation (manager@local.test, scoped to Towson but not Charles):
  happy path (3 entries, `submitted_by` canonical), `kind='eod'`/`bogus`
  reject (`22023`), cross-store `p_store_id` reject (`42501`), negative
  qty reject (`22023`), all-blank reject + mixed-blank accept,
  idempotent re-submit returns same id with `conflict: true` (no
  duplicate, original qty untouched), cross-store `item_id` reject
  (`23503`), RLS read scoping (manager only sees Towson). Confirmed
  `inventory_items.current_stock` UNCHANGED after smoke run; confirmed
  `eod_submissions` / `eod_entries` row counts UNCHANGED.
- TypeScript: `npx tsc --noEmit` produced no new errors in any file I
  touched. (Pre-existing errors in legacy/in-flight files like
  `AdminScreens.tsx`, `AppNavigator.tsx`, the pending
  `InventoryCountSection.tsx`, etc., remain — none introduced by this
  spec.)

### Frontend (this developer)

New files:
- `src/screens/cmd/sections/InventoryCountSection.tsx` — NEW. Mirrors
  `EODCountSection.tsx` structure. Sections: header strip (kind segmented
  control over `'spot' | 'open' | 'mid_shift' | 'close'`, `counted_at`
  picker — `<input type="datetime-local">` on web, "now" label on native
  per the architect's no-new-libraries rule — and an optional `notes`
  field); category-chip filter; per-category grouped item rows with
  dual `box/case` + `count` inputs (case input disabled when
  `caseQty <= 1`, matching EOD's dual-input rendering); sticky footer
  with non-blank counter + "SUBMIT COUNT" CTA. SUBMIT is disabled when
  zero non-blank entries OR when any entry is negative; client-side
  negative-input rendering paints the input red, matching the RPC's
  per-entry `≥ 0` check. On success: clears the form, toasts
  "Count submitted", bumps a local `refreshTick` to refetch the recent
  list. On `conflict: true`: toasts "Already submitted" (idempotency
  surfacing per the architect's design). Errors flow through the
  store action's `notifyBackendError`.
  - Second tab `history.tsx`: lists the last 10 counts via
    `db.fetchRecentInventoryCounts(storeId, 10)`. Each row shows a
    `kind` badge, relative `counted_at`, full timestamp, submitter
    name, and `itemCount`. Click → drills into a read-only detail view
    via `db.fetchInventoryCount(countId)`. Uses local `view: 'list' |
    'detail'` state, mirroring REPORTS-1's pattern at
    `ReportsSection.tsx`. Web-only `Escape` key returns to the list.
  - Owns a per-store realtime subscription
    (`channel('inv-count-section-${storeId}')` on `inventory_counts`,
    filtered by `store_id`) which bumps `refreshTick`. Architect §7
    Option A — keeps the store free of a single-section tick counter.

Edits:
- `src/types/index.ts` — added `InventoryCountKind`,
  `InventoryCountEntry`, `InventoryCount`, `InventoryCountSummary` per
  architect §9. Placed adjacent to `EODSubmission` for locality with
  the EOD types. (Coordinated with backend-developer — same shapes; no
  conflicts.)
- `src/lib/db.ts` — added `submitInventoryCount`,
  `fetchRecentInventoryCounts`, `fetchInventoryCount` helpers per
  architect §5. Imports the new types from `src/types`. Mappings
  follow the existing snake_case → camelCase pattern. The recent-
  counts helper handles both PostgREST aggregate-shape variants
  (`[{count: N}]` vs `{count: N}`) defensively.
- `src/store/useStore.ts` — added the `submitInventoryCount` action
  per architect §6. Mints `client_uuid` via `crypto.randomUUID()`
  (with a fallback when `crypto` is unavailable). Routes errors
  through `notifyBackendError('Submit inventory count', e)`. No
  persistent slice — section reads on demand. Imports
  `InventoryCountKind` from `src/types`.
- `src/lib/cmdSelectors.ts` — added `{ id: 'InventoryCount', label:
  'Inventory count' }` to the `Operations` group immediately after
  `EODCount` per architect §8 (Q5 default — sibling, not replacement);
  added the same entry to `SCREEN_ENTRIES` so the ⌘K palette routes to
  it as a screen jump.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — added import +
  dispatch arm for `InventoryCountSection`, immediately after the
  `EODCount` arm.
- `src/hooks/useRealtimeSync.ts` — added the `inventory_counts`
  channel subscription on the per-store channel, filtered on
  `store_id=eq.${storeId}`. Entries table is intentionally NOT on the
  channel (mirrors EOD's `eod_submissions`-only subscription).

### Verification performed (frontend)

- `npx tsc --noEmit` — no NEW errors in files I touched. The only
  pre-existing errors flagged in the run all live in legacy / unrelated
  files (`AdminScreens.tsx`, `IngredientsScreen.tsx`,
  `InventoryDesktopLayout.tsx` lines ~547/595 which are inside the
  pre-existing `UsageTab`, etc.). Specifically grepping the typecheck
  output for `InventoryCountSection|InventoryCount\b` returned zero
  matches.
- Web bundle compile — `curl
  http://localhost:8081/node_modules/expo/AppEntry.bundle?platform=web&dev=true`
  returns 200 OK with a 14 MB bundle. `grep -o
  'InventoryCountSection|fetchInventoryCount|fetchRecentInventoryCounts|submitInventoryCount|submit_inventory_count|inventory_counts'`
  on the bundle returns the full set of unique tokens, confirming the
  section and the db helpers were tree-shaken in and reachable.
- Browser preview (preview_* / Chrome MCP) — NOT performed. The
  frontend-developer subagent in this run does not have access to the
  preview tools; only Bash/Read/Write/Edit are available. Static
  verification (typecheck + bundle compile + token-in-bundle search)
  was used as the next-best signal. Reviewer should treat the
  acceptance-criteria checks (sidebar entry shows up; submit flow
  clears form + emits toast; recent panel renders; drill-in opens
  read-only detail; negative inputs blocked; EOD section untouched)
  as outstanding manual-verification items.

### Round-2 fixes (review reroll)

Addressing the 5 Criticals + 6 Should-fix items from
`specs/019-any-time-inventory-count/reviews/release-proposal.md`. The 4
security Criticals follow the REPORTS-1 round-2 template
(`20260510130000_report_runs_consistency.sql`); the 1 frontend Critical
was a filter-slice submit data-loss bug.

Migrations:

- `supabase/migrations/20260513000000_inventory_counts.sql` — EDITED in
  place (uncommitted). Three deltas:
  (a) Partial-unique on `client_uuid` re-scoped to `(store_id,
  client_uuid)`; renamed index from `inventory_counts_client_uuid_uidx`
  to `inventory_counts_store_client_uuid_uidx` (closes security-auditor
  H1).
  (b) RPC's dedup `SELECT` filter at the top of `submit_inventory_count`
  body adds `AND store_id = p_store_id` to match the new partial-unique
  shape; this restores the documented `conflict: true` envelope for
  same-store re-clicks and prevents cross-store UUIDs from leaking a
  raw `23505` to the toast.
  (c) Per-entry insert switched from `coalesce(v_entry.notes, '')` to
  `v_entry.notes` — NULL pass-through; matches the parent
  `inventory_counts.notes` convention so downstream `WHERE notes IS NOT
  NULL` queries behave consistently (code-reviewer Should-fix #2).

- `supabase/migrations/20260513120000_inventory_counts_consistency.sql`
  — NEW. Mirrors `20260510130000_report_runs_consistency.sql`. Adds:
  (1) BEFORE INSERT/UPDATE trigger on `inventory_counts` running
  `inventory_counts_set_submitted_by` which overrides
  `new.submitted_by := auth.uid()` unconditionally. Closes C-Sec-1
  (submitted_by forgery via direct PostgREST INSERT) and partially
  closes C-Sec-3 (submitted_by rewrite via UPDATE).
  (2) BEFORE INSERT/UPDATE trigger on `inventory_count_entries` running
  `inventory_count_entries_check_store` which raises `42501` whenever
  the entry's `item_id.store_id` does not match the parent count's
  `store_id`. Closes C-Sec-2 (cross-store item_id spoof).
  (3) Drops the `store_member_update_inventory_counts` and
  `store_member_update_inventory_count_entries` policies — append-only
  posture chosen over admin-only-edit. Without a policy, RLS denies
  UPDATE for any non-superuser caller. Closes the remainder of C-Sec-3.
  (4) Drops the `store_member_delete_inventory_counts` and
  `store_member_delete_inventory_count_entries` policies. Same posture.
  Closes C-Sec-4 (DELETE by store member). The
  `stores(id) on delete cascade` path still works because the cascade
  runs as the postgres role under admin store-deletion, not via
  PostgREST.

Edits:

- `src/screens/cmd/sections/InventoryCountSection.tsx` — five changes:
  (a) `nonBlankCount`, `totalItems`, `hasNegative` now derive from
  `storeInventory` (every item in the active store) instead of
  `filteredItems`. Closes C-FE-1 (release-proposal C-FE) — the category
  chip is purely a VIEW filter; SUBMIT always sends every non-blank
  entry across all categories.
  (b) `onSubmit` builds the `entries[]` array by iterating
  `storeInventory`, not `filteredItems`. Same fix; this is the
  surface where the actual data loss was happening.
  (c) `client_uuid` is now minted ONCE per submit-button press at the
  top of `onSubmit` (right before the `setSubmitting(true)` gate) and
  threaded through `submitInventoryCount({…, clientUuid})`. Restores
  the documented "same UUID on retry returns conflict:true" boundary
  (code-reviewer Should-fix #3 / architect §6 + §10).
  (d) Section's realtime channel renamed from
  `inv-count-section-${storeId}` to `store-${storeId}-inv-counts`,
  matching the documented `store-{id}` / `brand-{id}` naming
  convention (code-reviewer Should-fix #4).
  (e) Post-submit clear block now calls
  `setCountedAtLocal(localNowForInput())` so the next count starts at
  "now" instead of the previous wall-clock value (code-reviewer Nit
  #1).
- `src/store/useStore.ts` — two changes:
  (a) `submitInventoryCount` AppState typedef adds the required
  `clientUuid: string` parameter.
  (b) Implementation no longer mints `client_uuid` internally; it
  accepts the caller's UUID via `input.clientUuid` and passes through
  to `db.submitInventoryCount`. Comment updated to explain that the
  section is the canonical "one UUID per submit-press" boundary.
- `src/hooks/useRealtimeSync.ts` — removed the `inventory_counts` line
  from the `store-${storeId}` channel. The section owns its own per-
  store channel (architect §7 Option A); the global hook entry was
  triggering a redundant no-op `loadFromSupabase()` on every count
  insert with no consumer (code-reviewer Should-fix #1).

### Round-2 verification

Re-ran the 4 security-auditor Critical PoCs from
`specs/019-any-time-inventory-count/reviews/security-auditor.md` against
the patched DB. All 4 now blocked:

- C-Sec-1 (submitted_by forgery): manager INSERTs with forged
  `submitted_by = admin's UID`; row inserted with `submitted_by =
  manager's UID` (trigger overrode). PASS.
- C-Sec-2 (cross-store item_id spoof): manager creates legit Towson
  count, then attempts to attach a Charles `item_id` to its entries.
  Trigger raises `42501 insufficient_privilege`. PASS.
- C-Sec-3 (UPDATE rewrite): manager attempts to rewrite a count's
  `submitted_by`. `UPDATE … WHERE id = …` matches 0 rows (no UPDATE
  policy). PASS.
- C-Sec-4 (DELETE by store member): admin inserts a count, manager
  attempts to DELETE. `DELETE … WHERE id = …` matches 0 rows (no
  DELETE policy). PASS.

Happy-path RPC regression-verified: legit submit returns
`conflict: false`, same-UUID + same-store returns `conflict: true`,
same-UUID + different-store inserts a fresh row (no `23505` leak).
Notes pass-through regression-verified: entry with `notes: null`
persists NULL; entry with `notes: "text"` persists "text" (no
empty-string coercion).

TypeScript: `npx tsc --noEmit` clean on every file I touched — no new
errors. Pre-existing errors in `useStore.ts` (lines 801, 889, 896,
1681, 1782) are unrelated to spec 019 and were present before this
round.

Web bundle: compiles 200 OK at ~14.5 MB. Grep confirms the new
channel name `store-${storeId}-inv-counts`, the new
"Mint the idempotency key" comment, and the `storeInventory.filter(i =>
hasEntry…)` derivation are all in the bundle.
