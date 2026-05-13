# Spec 020: EOD count per-vendor submissions + lock-after-submit

Status: READY_FOR_REVIEW

## User story

As a store manager doing end-of-day counts, I want each vendor's submission to be
tracked independently so that submitting "Leopard (Seafood)" and then "Tai
Trading Company (Togo Container)" on the same day both appear in the audit log
as separate, completed counts. Once a vendor's count is submitted for a given
day, that vendor should be locked on that day (read-only, with an EDIT
affordance) so I cannot accidentally re-submit and overwrite my work — but
other vendors I haven't counted yet should still be fillable from scratch.

## Background — the bug today

The user submitted EOD counts on 2026-05-12 (Tuesday) for two vendors:
**Leopard (Seafood)** and **Tai Trading Company (Togo Container)**. Only the
second vendor's submission shows in the audit log; the first vendor's entries
were silently overwritten.

Root cause (already confirmed in code):

- `eod_submissions` has a unique constraint on `(store_id, date)` — see
  `supabase/migrations/20260405000759_init_schema.sql:119-126`. There is no
  `vendor_id` column on the table.
- `staff_submit_eod()` upserts on `(store_id, date)` and then
  `DELETE FROM eod_entries WHERE submission_id = v_submission_id` before
  re-inserting — see
  `supabase/migrations/20260504000001_staff_submit_eod_rpc.sql:58-67`.
- Client-side `submitEODCount()` follows the same pattern via direct PostgREST
  — see `src/lib/db.ts:343-393`.
- The vendor tab strip in `EODCountSection.tsx` is a UI filter only; the
  selected vendor is never sent to the backend
  (`src/screens/cmd/sections/EODCountSection.tsx:81, 218-220, 606`).

Result: the second vendor submit drops the first vendor's `eod_entries` rows
and replaces them with only the second vendor's items, producing exactly the
"only one vendor in history" symptom the user reported.

## Acceptance criteria

- [ ] Schema: `eod_submissions` has a `vendor_id uuid NOT NULL references vendors(id)`
  column. New unique key is `(store_id, date, vendor_id)`. Legacy rows are
  backfilled per Q7 below.
- [ ] Submitting "Leopard (Seafood)" and "Tai Trading Company (Togo Container)"
  on the same `(store_id, date)` produces TWO rows in `eod_submissions` and
  TWO sets of `eod_entries`, one per vendor. Neither overwrites the other.
- [ ] The audit log (`audit_log` table) contains separate `'EOD entry'` rows
  for every item across BOTH vendors, with the vendor identifiable in the
  audit detail or via the linked submission.
- [ ] After a vendor is submitted on a given day, that vendor's tab on the
  count screen renders in a locked / read-only state. The submit button is
  hidden or disabled; an EDIT affordance is visible.
- [ ] Tapping EDIT on a locked vendor opens the count screen for that vendor
  pre-filled with the existing `actual_remaining` values, and re-submitting
  overwrites only THAT vendor's entries (preserves the `eod_submissions.id`
  for FK stability; updates `actual_remaining` and `notes`; bumps
  `submitted_at`). Other vendors' submissions for the same day are not
  touched.
- [ ] Vendors that have NOT been submitted on the selected day remain
  fully fillable from scratch (no lock).
- [ ] Variance report (`report_run_variance`, spec 018) continues to produce
  identical numerical output for any day-pair tested. The anchor lookup that
  currently filters `eod_submissions` by `(store_id, date, status='submitted')`
  (see `supabase/migrations/20260512120000_report_run_variance.sql:208-224`)
  must SUM-aggregate `eod_entries.actual_remaining` per item across all of
  that date's vendor submissions. A smoke run before-and-after migration must
  produce equal numbers on the existing seed data.
- [ ] Existing historical `eod_submissions` rows are backfilled by inferring
  `vendor_id` from the most common `inventory_items.vendor_id` among each
  submission's entries (mode). Ties and no-items cases handled
  deterministically per Q7. No prod data is lost.
- [ ] The `staff_submit_eod` RPC accepts and persists a `p_vendor_id` arg
  (NOT NULL). Idempotency via `p_client_uuid` still works.
- [ ] `current_stock` overwrite is vendor-scoped: a vendor's EOD submit only
  updates `inventory_items.current_stock` for items where
  `inventory_items.vendor_id` matches the submitted vendor. Items from other
  vendors are untouched.
- [ ] Switching vendor tabs preserves typed-but-unsubmitted values for the
  duration of the session (local per-vendor client state). Refreshing the
  page or losing the session still discards them — draft autosave is out of
  scope.
- [ ] Realtime: a vendor-submit on `store-{id}` channel makes other open
  clients re-render the count screen with that vendor now showing locked.

## In scope

- Migration adding `vendor_id NOT NULL` to `eod_submissions` (column + unique
  key shift to `(store_id, date, vendor_id)` + backfill per Q7).
- `staff_submit_eod()` RPC signature change to accept `p_vendor_id` (NOT NULL).
- Client-side `submitEODCount()` to send `vendor_id` and surface
  per-vendor-locked state.
- `EODCountSection.tsx`: locked-tab rendering, EDIT affordance, pre-filled
  inline edit path, per-vendor in-memory state so typed-but-unsubmitted values
  survive tab switches within the session.
- Aggregation update inside `report_run_variance` so per-day variance lookups
  SUM `eod_entries.actual_remaining` per item across all vendor-submissions on
  that date.
- Audit log: include vendor identification in audit rows.
- History view (`HistorySection.tsx` or wherever the audit log is surfaced)
  shows one row per vendor-submission per day, not collapsed.

## Out of scope (explicitly)

- Any-time inventory counts (spec 019) — that uses a parallel
  `inventory_counts` table and is not impacted by this change.
- The reorder/delivery list feature — that is spec 021.
- Cross-store EOD aggregation in reports.
- Changing how `inventory_items.eod_remaining` is computed downstream.
- Touching `src/screens/AdminScreens.tsx` (legacy file, see CLAUDE.md).
- Replacing the `staff-app` Edge Function entirely — only the RPC signature
  and the body's vendor-scoping changes.
- Draft autosave / per-vendor server-side drafts. Typed-but-unsubmitted values
  live only in client state for the session.
- A separate "amend" UI. EDIT is pre-filled inline only.
- A "discard submission" UI. The flow is EDIT → re-submit (overwrite with
  audit trail), not delete-and-restart.

## Open questions resolved

### Q1 — Unique key on `eod_submissions` ⟪RESOLVED⟫

Strict NOT NULL `vendor_id` on `eod_submissions`. New unique key is
`(store_id, date, vendor_id)`. Cleanest invariant; every submission must
declare a vendor. Legacy rows backfilled per Q7 so the NOT NULL is enforceable.

### Q2 — Un-submit / append semantics ⟪RESOLVED⟫

Overwrite-with-audit-trail. Each vendor-submit overwrites that vendor's
previous `eod_entries` for the day (same pattern as today's `staff_submit_eod`,
just vendor-scoped). The audit_log rows from prior attempts are preserved so
the history shows the trail. No separate "discard submission" UI — EDIT →
re-submit is the only path.

### Q3 — Variance aggregation across multi-vendor-per-day rows ⟪RESOLVED⟫

SUM-aggregate `eod_entries.actual_remaining` per item across all of a date's
vendor submissions when `report_run_variance` looks up an anchor. The architect
must update the anchor SQL in spec 018's migration so the join unions across
all `eod_submissions` rows for `(store_id, date, status='submitted')` and
groups by `item_id` with `sum(actual_remaining)`. Same item appearing under
two vendors on one date adds; this matches the new partitioning intent and
preserves the unscheduled-item escape hatch's contribution to the anchor total.

### Q4 — Mid-flight typed-but-unsaved state ⟪RESOLVED⟫

Local per-vendor client state. Switching vendor tabs preserves typed-but-
unsubmitted values for the duration of the session. The current flat
`caseCounts` / `unitCounts` map keyed by item id must be re-shaped to be
keyed by `(vendor_id, item_id)` (or a per-vendor sub-map) so two vendors'
typed-but-unsaved drafts don't collide on shared item ids — see the
unscheduled-item escape hatch. Page refresh still discards. Server-side draft
autosave is explicitly out of scope.

### Q5 — EDIT affordance UX ⟪RESOLVED⟫

Pre-filled inline edit. Click EDIT on a submitted vendor → inputs unlock with
prior `actual_remaining` values pre-populated → submit overwrites that
vendor's submission (preserves the `eod_submissions.id` for FK stability;
updates `actual_remaining` and `notes`; bumps `submitted_at`). No new "amend"
mental model.

### Q6 — `current_stock` overwrite scoping ⟪RESOLVED⟫

Vendor-scoped writes. A vendor's EOD submit only updates
`inventory_items.current_stock` for items where `inventory_items.vendor_id`
matches the submitted vendor. Items from other vendors that the user counted
via the unscheduled-item escape hatch are NOT written to `current_stock`
(their `eod_entries` row is still persisted for audit, but the inventory
mutation is skipped). Architect should document this branch explicitly.

### Q7 — Migration path for existing historical rows ⟪RESOLVED⟫

Migration backfills existing prod `eod_submissions` rows by inferring
`vendor_id` from the most common `inventory_items.vendor_id` among each
submission's `eod_entries` (mode). Tiebreaker and no-items edge case are the
architect's call — recommend a deterministic lexicographic pick of `vendor_id`
on tie, and skip the row (or assign a sentinel) if the submission has zero
entries. Edge cases the architect must document:
- Tie: deterministic-pick (e.g., smallest `vendor_id` UUID, or first by name).
- No entries at all: deterministic skip or sentinel; whichever, must not
  block the NOT NULL constraint going on the column.
- An entry's item has a NULL `inventory_items.vendor_id`: treat as no signal
  and exclude from the mode count.

## Q&A resolved by audit (informational, not for the user to re-decide)

- "Where does the vendor tab live in the UI?" — `selectedVendorId` local
  state at `src/screens/cmd/sections/EODCountSection.tsx:81`, with
  filtering at line 218-220. Today it never reaches the backend.
- "What does the audit log get?" — see
  `supabase/migrations/20260504000001_staff_submit_eod_rpc.sql:92-101`,
  one `'EOD entry'` row per item with vendor never recorded.
- "Was this in legacy?" — `AdminScreens.tsx` had a per-vendor count flow
  but the same `eod_submissions(store_id, date)` schema; legacy had the
  same overwrite bug, the user is misremembering the lock-after-submit
  affordance.

## Dependencies

- Migration: `supabase/migrations/[NEW]_eod_submissions_vendor_id.sql` —
  alters `eod_submissions`, modifies unique key to `(store_id, date, vendor_id)`,
  backfills per Q7, then enforces NOT NULL on `vendor_id`.
- Migration: `supabase/migrations/[NEW]_staff_submit_eod_v2.sql` — new RPC
  signature with `p_vendor_id` (NOT NULL), vendor-scoped `current_stock`
  writes per Q6.
- Migration: `supabase/migrations/[NEW]_report_run_variance_multivendor.sql`
  — anchor aggregation update per Q3 (SUM across vendor-submissions per date).
- `src/lib/db.ts`: `submitEODCount` signature change, history readers update.
- `src/screens/cmd/sections/EODCountSection.tsx`: locked state, EDIT
  affordance, pre-filled values, per-vendor typed-but-unsaved state per Q4.
- `src/screens/cmd/sections/AuditLogSection.tsx`: surface vendor in audit
  rows.
- `src/screens/cmd/sections/HistorySection.tsx` if it exists — show per-vendor
  history rows.
- Staff app (`supabase/functions/staff-*`) — likely needs its callers
  updated to pass `vendor_id`. SIBLING APP, may need a coordinated change
  there. SURFACE THIS AS A RISK BEFORE BUILD.

## Project-specific notes

- **Cmd UI section / legacy**: New work in
  `src/screens/cmd/sections/EODCountSection.tsx`. NOT in `AdminScreens.tsx`
  (legacy, frozen per CLAUDE.md).
- **Per-store or admin-global**: Per-store. Submissions are scoped by
  `store_id`; vendors are global but inventory_items carry per-store
  `vendor_id`.
- **Realtime channels touched**: `store-{store_id}` — vendor-locked status
  must propagate so a manager who submits on one device sees the lock
  appear on another.
- **Migrations needed**: YES — three migrations as listed above.
- **Edge functions touched**: `staff-eod-submit` (in the sibling staff
  app, but the RPC it calls lives in THIS repo's migrations). Coordinate.
- **Web/native scope**: Both — `EODCountSection.tsx` runs on both, no
  web-only or native-only branches added by this work.
- **Tests**: No test framework. The acceptance criteria are testable but
  must be exercised via the smoke-edge.sh path and manual verification per
  the dev runbook. test-engineer reviewer should flag this and recommend
  a path forward.
- **app.json**: No changes. Slug stays `towson-inventory`.

## Risk register

- **Sibling staff-app coordination**: The `staff_submit_eod` RPC is called
  by an Edge Function `verify_jwt=false` path. The sibling app's deployed
  build must be updated to pass `vendor_id` in lockstep with this repo's
  migration. Because Q1 is strict-NOT-NULL, there is no back-compat shim
  to ride on — architect must propose a rollout sequence (e.g., deploy a
  transitional RPC overload that accepts NULL and routes to a sentinel
  vendor, OR coordinate timing such that sibling app ships first). Surface
  this in the design.
- **Variance report regression**: `report_run_variance` already shipped
  (spec 018). Numeric output must remain identical for any day-pair
  tested against existing prod data. The architect must produce a
  before/after equality smoke test as part of the design.
- **Audit log breakage**: Existing dashboards or PDFs that read the audit
  log may assume "one EOD per day per store". Spot-check
  `src/screens/cmd/sections/AuditLogSection.tsx` and any PDF export.
- **Backfill correctness (Q7)**: The mode-inference backfill may produce
  surprising assignments for legacy submissions whose entries straddle
  vendors. Architect must define the tiebreaker, the no-entries edge case,
  and the NULL-vendor-on-item edge case explicitly in the design doc, and
  call out any pre-migration audit step (e.g., a one-off SELECT that lists
  rows where the mode is ambiguous) before the migration is applied.

## Backend Architecture

### 0. Topology summary

Three new migrations land in strict order. Each is fully transactional
(wrap each file body in `begin; … commit;` if running by hand — Supabase
CLI wraps each file automatically).

```
20260514120000_eod_submissions_vendor_id.sql      # schema shift + backfill
20260514120010_staff_submit_eod_v2.sql            # new RPC signature + v1 shim
20260514120020_report_run_variance_multivendor.sql # variance anchor refactor
```

Three files, not one, so any single-file rollback is surgical: if the
backfill blows up, the RPC and variance migrations have not yet run; if
the variance refactor goes wrong post-deploy we can re-apply the
existing `20260512120000_report_run_variance.sql` in a hotfix without
touching `eod_submissions`. The middle file (v2 RPC) is the
sibling-staff-app coordination lever — see §6.

Realtime: `supabase_realtime` is `FOR ALL TABLES`
(`20260502190000_realtime_publication.sql:14`). Adding a column to a
table that is already in the publication does NOT change publication
membership, so the `docker restart supabase_realtime_imr-inventory`
ritual does NOT apply for any of these three migrations. Recorded
explicitly because most readers will assume it does. The realtime
payload widens by one column (`vendor_id`) automatically.

---

### 1. Data model changes

#### 1.1 New file: `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql`

Destructive vs additive: column add is additive; the UNIQUE constraint
drop is destructive but only of an index/constraint, not data. The
backfill writes; it does not read-only inspect. A full prod export of
`eod_submissions` and `eod_entries` should be taken before applying
this migration (out-of-band; this is not a CI gate per CLAUDE.md).

**Full SQL outline.** Note: this is the architect's design intent; the
backend developer will commit the literal file.

```sql
-- ============================================================
-- Spec 020 — vendor_id on eod_submissions (per-vendor partitioning)
-- 
-- Three-phase shape (single transaction):
--   Phase A: add nullable vendor_id column + supporting index
--   Phase B: backfill via mode of inventory_items.vendor_id across
--            each submission's eod_entries
--   Phase C: drop old (store_id, date) unique, enforce NOT NULL on
--            vendor_id, add new (store_id, date, vendor_id) unique,
--            add FK with ON DELETE RESTRICT
--
-- Realtime: no publication change; supabase_realtime is FOR ALL TABLES.
-- ============================================================

begin;

-- ─── Phase A — Add nullable column ─────────────────────────
alter table public.eod_submissions
  add column if not exists vendor_id uuid;

-- Index on the new column. Indexed BEFORE the backfill so the
-- backfill UPDATE's WHERE on id can co-plan reasonably; idempotency
-- not load-bearing here.
create index if not exists eod_submissions_vendor_id_idx
  on public.eod_submissions(vendor_id);

-- ─── Phase B — Backfill ────────────────────────────────────
-- For each existing eod_submissions row, infer vendor_id from the
-- mode of inventory_items.vendor_id across its eod_entries:
--   • SKIP entries whose inventory_items.vendor_id IS NULL (no signal).
--   • Mode = the vendor_id with the highest entry count among the
--     remaining (non-null-vendor) entries.
--   • Tiebreaker: lexicographically smallest vendor_id::text (i.e.,
--     UUID string compare). Deterministic and reproducible across
--     rerunning the backfill.
--
-- Edge cases:
--   • Submission with all entries' items having NULL vendor_id:
--     leaves vendor_id NULL (the eligible set is empty). The
--     NOT-NULL enforcement in Phase C WILL FAIL — so we run a
--     pre-check below and either RAISE or skip.
--   • Submission with zero eod_entries rows: same — eligible set
--     empty, vendor_id stays NULL.
-- 
-- Operator policy: any row left NULL after backfill is unusable.
-- The pre-check raises NOTICE listing each id; we then delete those
-- rows in the same transaction OR abort with EXCEPTION. Chosen:
-- DELETE with a NOTICE — these rows are unrecoverable garbage (no
-- signal of which vendor they belong to). Audit-log entries for
-- those submissions stay in audit_log; only the parent + child
-- entries are removed. This is the only intentionally destructive
-- step in the migration and is gated behind the post-backfill
-- recheck below.

with mode_pick as (
  select
    s.id                              as submission_id,
    -- inner subquery: per-(submission, vendor_id) counts, ordered
    -- by count desc then vendor_id::text asc, take first.
    (
      select ii.vendor_id
      from   public.eod_entries e
      join   public.inventory_items ii on ii.id = e.item_id
      where  e.submission_id = s.id
        and  ii.vendor_id is not null
      group by ii.vendor_id
      order by count(*) desc, ii.vendor_id::text asc
      limit 1
    ) as inferred_vendor_id
  from public.eod_submissions s
  where s.vendor_id is null
)
update public.eod_submissions s
   set vendor_id = mp.inferred_vendor_id
  from mode_pick mp
 where mp.submission_id = s.id
   and mp.inferred_vendor_id is not null;

-- Post-backfill recheck. Any rows still NULL are unrecoverable.
do $$
declare
  v_orphans int;
  v_ids uuid[];
begin
  select count(*), array_agg(id)
    into v_orphans, v_ids
    from public.eod_submissions
   where vendor_id is null;
  if v_orphans > 0 then
    raise notice
      'spec020 backfill: % submission(s) have NULL vendor_id after backfill (no entries OR all entries had NULL item vendor). Deleting: %',
      v_orphans, v_ids;
    -- Children cascade via FK (eod_entries.submission_id … on delete
    -- cascade — see init_schema.sql:130). Audit_log rows for those
    -- entries STAY because audit_log is not FK-cascaded from
    -- eod_submissions.
    delete from public.eod_submissions where vendor_id is null;
  end if;
end$$;

-- ─── Phase C — Enforce + reshape constraints ───────────────
-- Drop the original (store_id, date) unique from init_schema. Original
-- constraint was created implicitly via the `on conflict (store_id,
-- date)` shape inside staff_submit_eod's upsert — there's no named
-- constraint on init_schema. We must add one if not present, then
-- drop. Use a defensive `if exists` style.
--
-- The unique constraint used by ON CONFLICT in the existing RPC was
-- added separately or relied on a unique INDEX. Audit both shapes:
--   (a) `alter table … add constraint eod_submissions_store_id_date_key`
--   (b) `create unique index eod_submissions_store_id_date_idx`
-- Drop whichever exists. The new RPC's ON CONFLICT will use the new
-- (store_id, date, vendor_id) shape.

-- Drop old unique constraint name(s) if present.
alter table public.eod_submissions
  drop constraint if exists eod_submissions_store_id_date_key;
drop index if exists public.eod_submissions_store_id_date_idx;

-- Enforce NOT NULL — safe now, all rows backfilled or deleted.
alter table public.eod_submissions
  alter column vendor_id set not null;

-- New unique constraint (store_id, date, vendor_id). Two same-day
-- submissions for the SAME vendor still merge (idempotent re-submit
-- of one vendor), but different vendors coexist.
alter table public.eod_submissions
  add constraint eod_submissions_store_id_date_vendor_id_key
  unique (store_id, date, vendor_id);

-- FK with ON DELETE RESTRICT (per prompt). Preserves history; a
-- vendor delete must first clean up its EOD submissions.
alter table public.eod_submissions
  add constraint eod_submissions_vendor_id_fkey
  foreign key (vendor_id) references public.vendors(id)
  on delete restrict;

commit;
```

**Pre-migration operator audit (recommended, not part of the
committed migration).** Run on a copy of the prod dataset before
applying the migration to verify the mode picks are sane. This is
the architect's "spot-check before pulling the lever" step the spec's
Risk Register asks for.

```sql
-- How many rows will be auto-inferred?
select count(*) as inferrable
  from public.eod_submissions s
 where exists (
   select 1 from public.eod_entries e
   join public.inventory_items ii on ii.id = e.item_id
   where  e.submission_id = s.id
     and  ii.vendor_id is not null
 );

-- How many rows will end up NULL (will be DELETED by Phase B
-- post-recheck)? Flag if non-zero.
select count(*) as orphans
  from public.eod_submissions s
 where not exists (
   select 1 from public.eod_entries e
   join public.inventory_items ii on ii.id = e.item_id
   where  e.submission_id = s.id
     and  ii.vendor_id is not null
 );

-- Per-submission mode breakdown for sanity checking. Returns one
-- row per (submission, vendor) with counts and a "winner" flag.
-- Eyeball anything where the winning vendor isn't an obvious
-- majority.
with counts as (
  select s.id as submission_id, ii.vendor_id, count(*) as n
    from public.eod_submissions s
    join public.eod_entries e on e.submission_id = s.id
    join public.inventory_items ii on ii.id = e.item_id
   where ii.vendor_id is not null
   group by s.id, ii.vendor_id
)
select submission_id, vendor_id, n,
       row_number() over (
         partition by submission_id
         order by n desc, vendor_id::text asc
       ) as rank
  from counts
 order by submission_id, rank;
```

#### 1.2 Indexes

- `eod_submissions_vendor_id_idx` (new). Supports per-vendor history
  queries and the `report_run_variance` per-date join (the variance
  query joins on `(store_id, date, status='submitted')` and unions
  across vendor submissions — a vendor_id index is not load-bearing
  for that path but lights up audit/history views).
- `eod_submissions_store_id_date_vendor_id_key` (new unique). Replaces
  the old `(store_id, date)` unique implicitly used by the upsert
  ON CONFLICT.

---

### 2. RLS impact

**No change required.** The existing four-policy template on
`eod_submissions` (`per_store_rls_hardening.sql:64-81`) gates on
`auth_can_see_store(store_id)`. Adding a `vendor_id` column does not
alter the per-store scoping; vendors are brand-global today (see
`vendors` policies at `init_schema.sql:283-284`, refined by the
brand-catalog refactor) and are visible across stores the user can
see. There is no per-vendor RLS requirement in the spec.

`eod_entries` policies (`per_store_rls_hardening.sql:87-132`) likewise
unchanged — they scope through the parent's `store_id`.

---

### 3. RPC re-creation: `staff_submit_eod_v2`

#### 3.1 New file: `supabase/migrations/20260514120010_staff_submit_eod_v2.sql`

**Naming choice: new v2 function, NOT a re-create of v1.** Justified
in §6 (sibling-app rollout). The v1 function stays in place as a
guard-rail shim that raises a clear error so any pre-update sibling
deploy fails loudly instead of silently corrupting data.

**Signature.**

```
public.staff_submit_eod_v2(
  p_client_uuid uuid,
  p_store_id    uuid,
  p_date        date,
  p_vendor_id   uuid,     -- NEW; NOT NULL enforced inside body
  p_submitted_by text,
  p_status      text,
  p_entries     jsonb
) returns jsonb
```

Returns the same envelope shape as v1:

```
{
  "submission_id": uuid,
  "conflict":      boolean,        // true on client_uuid replay or EDIT detect
  "reason":        text | null,
  "entry_ids":     uuid[],
  "stock_updates": [ { ingredient_id, new_stock }, ... ]
}
```

**Body behavior (design intent).**

1. Auth: `security definer`, locked to `service_role` like v1
   (`staff_submit_eod_rpc.sql:121-122`). Edge function (this repo)
   continues to use the service-role key.

2. Vendor presence check. `if p_vendor_id is null then raise
   exception '... using errcode = 22023'`. Strict per Q1.

3. Idempotency. Reshaped from v1:
   - Look up existing row by `(p_client_uuid)` first (per-attempt
     idempotency). If found, return `{ conflict: true, reason:
     'client_uuid already processed' }` — same as v1 behavior. The
     existing partial-unique index `eod_submissions_client_uuid_idx`
     (`staff_api_idempotency.sql:26-28`) handles enforcement.
   - If `p_client_uuid` is not seen, look up existing row by
     `(p_store_id, p_date, p_vendor_id)`. If found, treat as EDIT:
     same path as v1's `on conflict do update` re-uses the row id;
     entries are deleted + re-inserted; `submitted_at` bumps;
     `client_uuid` is overwritten with the new attempt's value.
     Return `{ conflict: false }` (the EDIT is the intended write,
     not an idempotency conflict).

4. Upsert. Use the new unique:
   ```
   insert into eod_submissions (store_id, date, vendor_id, ...)
   values (...)
   on conflict (store_id, date, vendor_id) do update
     set status      = excluded.status,
         submitted_at= excluded.submitted_at,
         client_uuid = excluded.client_uuid
   returning id into v_submission_id;
   ```

5. Replace entries: `delete from eod_entries where submission_id =
   v_submission_id` then insert from `p_entries`. Same shape as v1
   (`staff_submit_eod_rpc.sql:67-87`).

6. **Vendor-scoped stock update (Q6).** Per-entry update only
   touches `inventory_items.current_stock` when the item belongs
   to the submitted vendor. Pseudocode:
   ```
   update inventory_items
      set current_stock = v_entry.actual_remaining,
          eod_remaining = v_entry.actual_remaining,
          updated_at    = now()
    where id = v_entry.ingredient_id
      and vendor_id = p_vendor_id;   -- new gate

   if not found then
     -- Item belongs to a different vendor (unscheduled-item escape
     -- hatch). Still write the eod_entries row (already inserted
     -- above) and skip the inventory mutation. Document this in the
     -- function header. The audit_log row below still emits so the
     -- count is traceable.
   end if;
   ```
   Document this branch explicitly in the function comment, per the
   prompt.

7. Audit row. Same as v1 (`staff_submit_eod_rpc.sql:92-101`), with
   one shape change: **append the vendor name to the `detail`
   column** so the audit log surfaces vendor identification per AC.
   No new column on `audit_log` — the existing `detail` field is
   text and re-use avoids a schema change to a permission-sensitive
   table.
   ```
   detail = coalesce(p_submitted_by, 'staff:unknown') || ' · vendor: '
            || coalesce((select name from vendors where id = p_vendor_id), 'unknown')
   ```
   Frontend (AuditLogSection) parses the `· vendor: X` suffix if it
   wants to surface vendor as a column; otherwise the suffix is
   visible inline. Lightweight, no migration on audit_log itself.

8. GRANT/REVOKE: same as v1.
   ```
   revoke all on function … from public, anon, authenticated;
   grant execute on function … to service_role;
   ```

#### 3.2 v1 guard-rail (same file)

After defining `staff_submit_eod_v2`, replace v1's body with a
straight-up failure path:

```
create or replace function public.staff_submit_eod(
  p_client_uuid uuid, p_store_id uuid, p_date date,
  p_submitted_by text, p_status text, p_entries jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  raise exception
    'staff_submit_eod (v1) deprecated by spec 020 — caller must pass p_vendor_id via staff_submit_eod_v2'
    using errcode = 'P0001';
end;
$$;
```

This is the "fail loudly" mode. Any sibling-app deploy that hasn't
been updated to call v2 (and hasn't been updated to pass `vendor_id`
through the edge-function shim — see §5) will receive an explicit
P0001 error and the staff app's existing toast/log path surfaces it
to the operator. **No silent data corruption.** v1 is left in place
(not dropped) so the function GRANT on service_role doesn't disappear
mid-migration and so the rollback path is straightforward.

**Rollback plan.** If something blows up, the rollback is to re-run
the previous v1 file (`staff_submit_eod_rpc.sql`) — Postgres'
`create or replace function` swaps the body in place. The Phase 1.1
migration is harder to roll back; the operational guidance is "do
not roll back the schema migration in isolation."

---

### 4. Variance anchor refactor: `report_run_variance`

#### 4.1 New file: `supabase/migrations/20260514120020_report_run_variance_multivendor.sql`

The current variance migration anchors `(store_id, date)` and looks
up a SINGLE `v_from_submission_id` / `v_to_submission_id`
(`report_run_variance.sql:208-224`). Post-Spec-020, multiple
submissions exist per `(store_id, date)`. The anchor refactor:

1. **Replace single-id anchor lookup with array.** The existence
   gates at lines 208-224 currently raise P0002 when no submission
   is found. They become "no submissions" gates, plural:
   ```
   -- existence checks become EXISTS predicates, no id capture:
   if not exists (
     select 1 from eod_submissions
      where store_id = p_store_id and date = v_from and status = 'submitted'
   ) then raise exception 'no submitted EOD for store on % (anchor: from)' …
   end if;
   ```
   (Same for v_to.) The `v_from_submission_id` / `v_to_submission_id`
   variables are dropped from the DECLARE block.

2. **`prior_counts` / `current_counts` CTEs become SUM-aggregates
   over all date-matching submissions** (per Q3). Current shape
   filters `where e.submission_id = v_from_submission_id` (one
   submission). New shape:
   ```
   prior_counts as (
     select e.item_id,
            sum(e.actual_remaining)::numeric as qty
       from public.eod_entries e
       join public.eod_submissions s on s.id = e.submission_id
      where s.store_id = p_store_id
        and s.date     = v_from
        and s.status   = 'submitted'
        and e.actual_remaining is not null
      group by e.item_id
   ),
   current_counts as ( -- same shape with v_to
     ...
   )
   ```
   This is the SUM aggregation per Q3. An item appearing under two
   vendors on the same anchor date contributes both rows; the
   downstream INNER JOIN to `current_counts` (also summed) then
   produces a single per-item anchor pair. Q3 explicit decision:
   if the user counted "soda" via Vendor A (5 units) AND via the
   unscheduled-item escape hatch under Vendor B (3 units) on the
   same date, the anchor qty is 8.

3. **Single-anchor-XOR KPI** (current code at lines 269-293).
   `prior_only` and `current_only` CTEs filter on
   `submission_id = v_*_submission_id`. They become filters on
   `(store_id, date, status)` to match. The XOR semantics are
   preserved.

4. **Anchor-existence raise messages.** Keep `errcode = 'P0002'`,
   same shape. Frontend's modal error UI already handles P0002.

5. **No other downstream changes.** Receiving / sales_depletion /
   waste CTEs already aggregate over the half-open date window —
   they have nothing to do with submission_id and are unaffected.

#### 4.2 Before-and-after equality smoke test

The spec demands "any day-pair tested against existing prod data
produces equal numbers." Test design:

1. **Pre-migration capture.** Before applying the spec-020 migrations,
   run the existing `report_run('variance', store_id, params)` against
   the seed dataset for at least three day-pairs that have real EOD
   coverage. Dump the JSON envelope to disk. Suggested pairs (architect
   intuits from the seed):
   - 2026-05-08 → 2026-05-09 (consecutive)
   - 2026-05-04 → 2026-05-08 (multi-day)
   - any pair where the seed has multi-vendor entries on either anchor
     (currently impossible because the bug overwrites — so this case
     is "single-anchor before" and the equality is trivially true).

2. **Apply all three migrations.**

3. **Post-migration capture.** Run the same `report_run('variance',
   …)` calls. Dump the same JSON envelopes.

4. **Compare.** A `diff` of the JSON files (or a quick Python
   `json.loads`/`assert ==` script) MUST come out clean for the
   `kpis`, `rows`, `series`, `columns` fields. Sorting is server-side
   and deterministic (already designed in the existing migration —
   `abs_dollar desc, abs_delta desc`), so JSON equality is the right
   bar.

Why this works: pre-migration, every date in the seed has exactly
ONE submission (the bug forces this). The new SUM aggregation over
`(store_id, date, status)` reduces to `sum(actual_remaining)` over
the one matching submission's entries, which is the same single-row
qty the old per-submission filter pulled. The math is bit-identical
because PostgreSQL `sum(x)` over one row returns x. The first
genuine multi-vendor anchor will appear AFTER the spec is shipped
and a manager submits two vendors on one day; that case is new
functionality and is exercised by the AC, not the regression test.

The backend developer must include this script (or a one-paragraph
runbook calling it out) in the PR. Test-engineer should flag the
absence of a test runner per CLAUDE.md — manual smoke is the
current reality.

---

### 5. `src/lib/db.ts` surface

#### 5.1 `submitEODCount` signature change

Today's signature (`src/lib/db.ts:343`):
```ts
export async function submitEODCount(
  submission: Omit<EODSubmission, 'id'>
): Promise<string>
```

New signature — same shape, but the `EODSubmission` interface gains
`vendorId: string` (see §7) so the call surface to the section is
unchanged; the section already knows the selected vendor:
```ts
// Same outer signature; the new field rides on the existing
// submission shape, so call sites in EODCountSection.tsx pick it up
// for free. RPC body changes below.
export async function submitEODCount(
  submission: Omit<EODSubmission, 'id'>
): Promise<string>
```

**Internals change:** instead of direct PostgREST `upsert` +
`delete` + `insert` against `eod_submissions` / `eod_entries`, the
helper switches to **calling `staff_submit_eod_v2` via
`supabase.rpc(...)`** for parity with the staff app. Justification:

- Today the Cmd UI's path (direct PostgREST) and the staff app's
  path (RPC) diverge. The bug is partly a function of that
  divergence — two write paths, two opportunities to forget
  vendor_id. Folding the Cmd UI onto the RPC eliminates the divergence.
- The RPC is currently `security definer` + `grant execute to
  service_role`. The Cmd UI runs under an authenticated user JWT,
  not service-role, so a straight RPC call would fail.
  **Two options here, architect picks (b):**
  - (a) Loosen the GRANT to authenticated. Risk: any authed user
    can now call the RPC with any `submitted_by` value, undermining
    the staff-token-bearer integrity.
  - **(b) Keep the RPC service-role-only AND keep the Cmd UI's
    direct-PostgREST path.** The Cmd UI's path is updated to
    pass `vendor_id` in the parent insert, and the new
    `(store_id, date, vendor_id)` unique handles same-vendor
    re-submit dedup. The vendor-scoped `current_stock` write (Q6)
    is reproduced in db.ts: filter the per-entry `update
    inventory_items` to `.eq('vendor_id', submission.vendorId)`.
    The audit_log write is reproduced too (it already happens
    client-side via `useStore.submitEOD` → `addAuditEvent`, see
    `useStore.ts:1389-1400`; we append `vendorName` to the detail
    string there to mirror the RPC).

Picking (b). Justification: the Cmd UI's authed-user JWT path is
already RLS-gated; the new constraint shape gives us per-vendor
isolation server-side; the audit attribution stays canonical
(`auth.uid()` via RLS-gated PostgREST writes); no GRANT change.
The cost is: the design-intent EDIT-overwrite logic is re-duplicated
between db.ts and the RPC, but the upsert ON CONFLICT does most of
the heavy lifting — db.ts's `.upsert(..., { onConflict:
'store_id,date,vendor_id' })` matches the RPC's
`on conflict (store_id, date, vendor_id)` shape.

**Concrete change list inside `submitEODCount` (`src/lib/db.ts:343`):**

- The `.upsert(...)` payload at line 347 adds `vendor_id:
  submission.vendorId`.
- The `onConflict` at line 354 changes from `'store_id,date'` to
  `'store_id,date,vendor_id'`.
- The per-entry inventory update at lines 388-391 adds a vendor gate:
  `.eq('vendor_id', submission.vendorId)`. This is the Q6 vendor-scoped
  current_stock branch on the client path.
- No interface change on this function — callers still pass an
  `Omit<EODSubmission, 'id'>` and the existing field is filled.

#### 5.2 Read helpers — vendor_id passthrough

`fetchRecentEODSubmissions`, `fetchEodSubmissionsForStores`,
`fetchTodaysEODForStores`, `fetchEODSubmissions` all select-and-map
from `eod_submissions`. Each adds `vendor_id` to the column list and
to the mapped output:

```ts
.select(`id, store_id, date, vendor_id, submitted_by, submitted_at, ...`)

// mapped:
vendorId: row.vendor_id,   // snake_case → camelCase
```

`vendorName` is NOT joined server-side — it stays a frontend lookup
against `useStore.vendors` (the brand-shared vendor list is already
in store). Same shape as `submittedBy` (name) which the section
backfills from `useStore.profiles`-style state.

#### 5.3 New helper: `editEODCount(submissionId, …)` — NOT NEEDED

The EDIT path (Q5) flows through the same `submitEODCount` call.
`onConflict` does the row reuse server-side; the same eod_submissions.id
survives the EDIT (per `on conflict do update`, not delete-and-insert).
No new helper is needed. The frontend just calls `submitEODCount` again
with the same `(storeId, date, vendorId)` triple.

---

### 6. Edge function changes (`supabase/functions/staff-eod-submit/index.ts`)

The Edge Function in THIS repo is a passthrough wrapper around
`staff_submit_eod`. Two coordination paths exist:

- **This repo's Edge Function** — we own this file. Changes:
  - Add `vendor_id` to the `Body` interface (line 58) and the
    `validate(b)` function (line 68): require `vendor_id` as a uuid
    string. Reject with 400 if missing.
  - Change the RPC call (line 108) from `staff_submit_eod` to
    `staff_submit_eod_v2`, passing `p_vendor_id: body.vendor_id`.
  - `verify_jwt = false` unchanged (`supabase/config.toml:381`).
  - Service-token bearer validation unchanged.

- **Sibling staff-app repo** — we do NOT own this. The sibling app's
  POST body needs to gain `vendor_id`. See §7 for the rollout
  sequence.

**Backward-compatibility shim during rollout.** Per the prompt's
"OR" path, I am NOT recommending a `vendor_id`-optional Edge
Function with NULL fallback to a sentinel vendor. Reasons:
- Q1 mandates strict NOT NULL; any inserted "sentinel" row
  would have to point at a real vendor or fail.
- A sentinel "Unknown" vendor would distort the variance
  aggregation (per-vendor SUM would mix real and sentinel buckets).
- Q7 is about backfilling LEGACY rows, not creating a forward
  fallback. Forward NULLs are an antipattern given Q1.

Instead, this repo's Edge Function will reject pre-vendor_id
POSTs with a clean 400 starting from the moment migration ships.
The sibling staff-app deploy that adds `vendor_id` MUST land
before/with the migration, OR sibling-app traffic will start
returning 400s until they catch up. This is the "fail loudly" mode
preserved end-to-end. The rollout sequence in §7 lays this out.

---

### 7. Sibling-app rollout sequence

Two valid sequences considered. Recommending **B** (lockstep)
because it's safer with strict NOT NULL.

**A. Soft-fallback (transitional NULL shim) — REJECTED.** Would
require a `staff_submit_eod_v2` that accepts NULL `p_vendor_id` and
either routes to a sentinel vendor or to v1's behavior. Cleanest in
ops but the data corruption mode (multiple vendors funneled into
one sentinel row over the rollout window) is exactly the bug we're
fixing. NOT pursued.

**B. Lockstep (recommended).** Six steps, ordered:

1. **Sibling staff-app codepath updated first** (in the sibling
   repo): add `vendor_id` to the POST body. **Behind a feature flag
   or version gate so it only activates after step 5.** Pre-flag,
   the sibling app continues to POST without `vendor_id` and this
   repo's Edge Function (unchanged at this point) continues to
   accept it.

2. **Architect/PM verify with staff-app team:** the staff-app build
   is on shelf and ready to flip its flag/version.

3. **Apply schema migration in prod** (`20260514120000_eod_submissions_vendor_id.sql`).
   - Take a backup of `eod_submissions` + `eod_entries` first.
   - Run the pre-migration audit script (§1.1) to confirm
     `orphans` count is acceptable.
   - Apply migration.
   - Verify post-migration state: every row has a `vendor_id`;
     the new unique exists; the old one is gone.

4. **Apply RPC migration in prod** (`20260514120010_staff_submit_eod_v2.sql`).
   - Creates `staff_submit_eod_v2`.
   - Replaces `staff_submit_eod` v1 body with the deprecation
     guard-rail RAISE.
   - **Important window:** Any in-flight staff-app POST hitting
     this repo's Edge Function (still pointing at v1) AFTER this
     step lands raises P0001. The Edge Function returns 500 with
     the raise message. This is the failure-mode the rollout is
     scheduled around — should be a small window (next step).

5. **Deploy this repo's Edge Function update** (`staff-eod-submit/index.ts`)
   pointing at v2 with `vendor_id` validated. Step 4's failure
   window closes here.

6. **Sibling staff-app flips its flag/version** to start sending
   `vendor_id`. Steps 5 and 6 should be coordinated to within
   minutes; if step 5 ships first the sibling app's pre-flag POSTs
   start receiving 400s (missing `vendor_id`); if step 6 ships
   first the sibling app's POSTs hit Edge Function v1's signature
   check (no `vendor_id` validation), then the RPC raises P0001.
   Either failure mode is loud and recoverable.

7. **Apply variance migration in prod**
   (`20260514120020_report_run_variance_multivendor.sql`). Strictly
   speaking this can run before step 6 (the SUM aggregation
   correctly handles single-vendor cases — see §4.2 equality
   reasoning), so the architect's recommended order is to run it
   right after step 4 with the schema in shape, ensuring the
   variance template is correct before any post-migration EOD
   submissions land. **Updating the recommended order:** run
   migrations in step 3+4+(new 4b: variance) as a triplet inside
   one maintenance window, then steps 5–6 as the rollout.

**Rollback.** If the orphan count is unacceptable at step 3, abort
before the schema enforcement. If the deploy stutters between
step 4 and step 5/6, the deprecation raise gives a clear staff-app
toast — operators know to wait. The variance template can be
rolled back independently by re-applying the old
`20260512120000_report_run_variance.sql` (the function is
`create or replace`, swapping in place).

**This is not a "ship in parallel and accept downtime" approach
to the sibling app.** It's a fail-loud coordination plan. The
downtime window between step 4 and step 5+6 is minutes if the
deploys are pre-staged.

---

### 8. TypeScript types

#### 8.1 `src/types/index.ts`

Update the `EODSubmission` interface at line 231:

```ts
export interface EODSubmission {
  id: string;
  date: string;
  storeId: string;
  storeName: string;
  vendorId: string;        // NEW; spec 020. Always populated post-migration.
  vendorName?: string;     // NEW; optional, hydrated client-side from
                           // useStore.vendors for display. Server payload
                           // doesn't include the join; the section/audit
                           // surfaces look it up locally.
  submittedBy: string;
  submittedByUserId: string;
  timestamp: string;
  itemCount: number;
  status: 'draft' | 'submitted';
  entries: EODEntry[];
}
```

`EODEntry` is unchanged — entries are already submission-scoped via
`submission_id` and inherit the parent's `vendorId` transitively.

---

### 9. Cmd UI section changes (`src/screens/cmd/sections/EODCountSection.tsx`)

#### 9.1 Per-vendor lock state

The current code (lines 81-86, 218-220, 593-606) keeps a single
flat `caseCounts: Record<string, string>` keyed by item id. Per
Q4 this must be reshaped to per-vendor:

```ts
// Replace lines 83-85:
const [caseCountsByVendor, setCaseCountsByVendor] =
  React.useState<Record<string /*vendorId*/, Record<string /*itemId*/, string>>>({});
const [unitCountsByVendor, setUnitCountsByVendor] =
  React.useState<Record<string, Record<string, string>>>({});
const [notesByVendor, setNotesByVendor] =
  React.useState<Record<string, Record<string, string>>>({});
```

All four read/write sites for the existing maps update accordingly:
- input `value`s pull from `caseCountsByVendor[selectedVendorId]?.[id] ?? ''`
- input `onChangeText` writes `setCaseCountsByVendor((p) => ({ …p,
  [selectedVendorId]: { …(p[selectedVendorId] || {}), [id]: text } }))`
- `buildSubmission` reads from `caseCountsByVendor[selectedVendorId]`.
- after a successful submit, only `caseCountsByVendor[selectedVendorId]`
  is cleared (not the entire map). Other vendors' typed-but-unsaved
  drafts survive the submit.

This is the spec's Q4 reshape.

#### 9.2 Vendor tab "submitted" indicator

`eodSubmissions` reload via realtime carries the new `vendorId` field.
For the selected day:

```ts
const submittedVendorIds = React.useMemo(() => {
  const ids = new Set<string>();
  for (const s of eodSubmissions) {
    if (s.storeId === currentStore.id && s.date === selectedIso && s.status === 'submitted') {
      ids.add(s.vendorId);
    }
  }
  return ids;
}, [eodSubmissions, currentStore.id, selectedIso]);
```

The vendor pill rendering (lines 605-668) adds a `submitted` glyph
(e.g., a green dot or a "✓ SUBMITTED" tag) when `submittedVendorIds.has(v.id)`.

#### 9.3 Locked vendor + EDIT button

When the selected vendor is in `submittedVendorIds`:
- Inputs render `editable={false}` with prior values pre-populated
  from the matching `eod_submissions` row's entries (already in
  `eodSubmissions` post-realtime).
- The footer "SUBMIT COUNT" button is replaced by an "EDIT" button.
- Pressing EDIT flips a per-vendor `editingVendorIds: Set<string>`
  state. Once editing, inputs unlock and the button reverts to
  "SUBMIT COUNT" (which now overwrites — same RPC/db helper call
  as a fresh submit; the existing row is reused via
  `(store_id, date, vendor_id)` ON CONFLICT).
- After a successful overwrite, `editingVendorIds.delete(vendorId)`
  is fired so the vendor relocks.

When the vendor is NOT in `submittedVendorIds` (and not in editing
mode), behavior is unchanged — fully-fillable from scratch.

#### 9.4 Pre-fill values on EDIT entry

When the user presses EDIT on a locked vendor, the section reads
the existing submission's entries and seeds the per-vendor draft
map:

```ts
const onEdit = (vendorId: string) => {
  const sub = eodSubmissions.find(
    (s) => s.storeId === currentStore.id && s.date === selectedIso && s.vendorId === vendorId,
  );
  if (!sub) return;
  setEditingVendorIds((prev) => new Set(prev).add(vendorId));
  // Seed the per-vendor draft from the submission's entries. Don't
  // overwrite any keys that the user has already typed in this
  // session (per Q4 — typed-but-unsubmitted survives tab switches);
  // we pre-fill only the empty slots.
  setCaseCountsByVendor((p) => ({
    ...p,
    [vendorId]: {
      ...Object.fromEntries(sub.entries.map((e) => [e.itemId, String(e.actualRemainingCases ?? '')])),
      ...(p[vendorId] || {}),
    },
  }));
  setUnitCountsByVendor((p) => ({
    ...p,
    [vendorId]: {
      ...Object.fromEntries(sub.entries.map((e) => [e.itemId, String(e.actualRemainingEach ?? e.actualRemaining ?? '')])),
      ...(p[vendorId] || {}),
    },
  }));
  setNotesByVendor((p) => ({
    ...p,
    [vendorId]: {
      ...Object.fromEntries(sub.entries.map((e) => [e.itemId, e.notes || ''])),
      ...(p[vendorId] || {}),
    },
  }));
};
```

Spread-order matters: user-typed values win over server-loaded
pre-fills. This is a small UX nicety; if the test-engineer wants
the inverse (server wins), it's a one-line spread flip.

#### 9.5 history.tsx — vendor column

The existing `EODHistoryTab` at line 1022 groups by `(date)`. The
new shape groups by `(date, vendorId)` since each row is now a
distinct submission. The table gains a "VENDOR" column between
"DATE" and "SUBMITTED BY", read from `sub.vendorName` (hydrated
client-side from `useStore.vendors.find((v) => v.id === sub.vendorId)?.name`).
- Sort order stays date desc; secondary sort by `vendorName` asc.
- The header pluralizes counts as today ("3 counts" for one date
  with three vendors).

#### 9.6 variance.log tab — `todaySub`

The current `VarianceLogTab` (line 1105) reads `todaySub =
eodSubmissions.find(...date===todayStr)`. Post-migration there are
N today-subs. Replace `.find(...)` with `.filter(...)` and SUM
`actual_remaining` per `itemId` across them, matching the
`report_run_variance` aggregation. Test-engineer should call out
that this client-side computation is a parallel implementation of
the server-side SUM — the dashboards are advisory; the variance
template is authoritative. The two MUST yield matching numbers,
which they will if the math is the same shape (SUM per item across
date submissions).

---

### 10. Frontend store impact (`src/store/useStore.ts`)

`submitEOD` action at line 1331:

- The merge lookup at 1335-1339 changes from `(storeId, date)` to
  `(storeId, date, vendorId)`. Two same-day submissions for different
  vendors create two separate entries in `eodSubmissions`; an EDIT
  on the same vendor still merges.
- The audit-event emit at 1389-1400 changes `detail` to include
  vendor name (parity with the RPC's audit row):
  ```ts
  detail: `${existing ? 'Count updated' : 'Remaining count submitted'} · vendor: ${submission.vendorName || 'unknown'}`,
  ```
- The current_stock optimistic update inside the `entries.forEach`
  loop at 1362-1389 must be **vendor-scoped per Q6**: only update
  `inventory.find((i) => i.id === entry.itemId && i.vendorId === submission.vendorId)`.
  Items belonging to other vendors (the unscheduled-item escape
  hatch case) skip the optimistic mutation, mirroring the RPC/db
  behavior.
- The optimistic-then-revert pattern via `notifyBackendError`
  applies as today — the db.ts call returns a promise and any
  failure is caught and toasted.

`loadFromSupabase` at line 800 — no change beyond the type widening;
the returned `eodSubmissions` already flow through `fetchAllForStore`
→ `fetchRecentEODSubmissions`, which (per §5.2) now select+map
`vendor_id`.

---

### 11. Realtime impact

`useRealtimeSync.ts:36` already listens to `eod_submissions` on
`store-{storeId}` with `store_id` equality filter. Per
`20260502190000_realtime_publication.sql:14`, the publication is
`FOR ALL TABLES` — column adds are picked up automatically. **No
publication-membership change**, therefore the
`docker restart supabase_realtime_imr-inventory` step does NOT
apply.

The realtime payload after migration includes `vendor_id` so the
client-side `useRealtimeSync` callback (a debounced `loadFromSupabase`,
`CmdNavigator.tsx:87`) just re-reads via the read helpers, which now
carry `vendorId` through (§5.2).

---

### 12. Risks and tradeoffs

1. **Backfill ambiguity** (Q7). Mode-pick + alphabetical-UUID
   tiebreaker is deterministic but can mis-attribute a legacy
   submission whose entries genuinely span multiple vendors (the
   user did multi-vendor counts via the unscheduled-item hatch and
   they currently coexist in a single eod_submission row). The
   pre-migration audit script (§1.1) surfaces those; ops can choose
   to manually correct after migration. There is no "split a legacy
   row into multiple new rows" path in the migration — too
   destructive to commit a guess about which entries belong to
   which vendor.

2. **Orphan-delete in Phase B**. A submission with zero non-NULL
   inventory_items.vendor_id signals is unrecoverable; the
   migration deletes the parent + entries. Audit_log rows for those
   submissions stay (they have no FK to eod_submissions). Risk
   level: low — these rows are by definition uninterpretable. Ops
   should run the pre-migration audit first and not be surprised.

3. **Sibling app coordination window**. Between step 4 (RPC swap)
   and step 5+6 (Edge Function + sibling-app flip), staff-app
   POSTs raise P0001. This is the "fail loud" mode. Mitigation:
   schedule the migrations during a low-traffic window; pre-stage
   step 5's Edge Function deploy.

4. **Variance equality test runs manually** per CLAUDE.md (no test
   framework). The script must be in the PR; release-coordinator
   should call out if it isn't.

5. **Audit-log detail-string parsing**. Surfacing vendor via the
   existing `detail` text column avoids a schema change to a
   permission-sensitive table but is brittle — any code that does
   substring parsing on detail (currently none, per a grep) would
   break. Documented; alternative is to add a `vendor_id` column
   to audit_log in a follow-up.

6. **Performance on 286 KB seed dataset**. The variance refactor
   adds one inner JOIN (`eod_entries × eod_submissions(store_id,
   date, status)`) to two CTEs that previously filtered on a
   single submission_id. At seed scale this is negligible; the
   `eod_submissions(store_id, date)` and the new
   `eod_submissions(store_id, date, vendor_id)` unique both light
   up. No new indexes needed.

7. **Cmd UI EDIT EDGE CASE**. If the user opens EDIT on vendor A,
   then switches to vendor B, then submits B fresh, then comes
   back to vendor A while it is still in `editingVendorIds`: the
   "is locked" gate evaluates against `submittedVendorIds`
   (server-state), so A still appears in the editing pose with
   pre-fill spread underneath any user typing. This is the
   intended Q4 behavior — drafts persist across tab switches
   regardless of submit activity on other tabs.

8. **`AdminScreens.tsx` left alone** per CLAUDE.md "Legacy admin
   screens" rule. Spec explicitly out-of-scopes touching the legacy
   surface (spec line 111).

9. **app.json slug**. No change needed per CLAUDE.md "app.json
   slug mismatch (DO NOT AUTO-FIX)". Confirmed unaffected by this
   spec.

10. **CI gate absence**. Per CLAUDE.md "CI workflow" section, no
    `db-migrations-applied.yml` is running. Manual migration
    verification per §7 step 3 is the current reality. The
    test-engineer reviewer should reaffirm.

---

### 13. Files changed (after backend + frontend developers run)

Migrations (developer authors):
- `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql`
- `supabase/migrations/20260514120010_staff_submit_eod_v2.sql`
- `supabase/migrations/20260514120020_report_run_variance_multivendor.sql`

Code:
- `supabase/functions/staff-eod-submit/index.ts`
- `src/lib/db.ts` (submitEODCount + read helpers)
- `src/types/index.ts` (EODSubmission gains vendorId/vendorName)
- `src/store/useStore.ts` (submitEOD action + audit detail)
- `src/screens/cmd/sections/EODCountSection.tsx` (per-vendor state
  shape, lock-after-submit, EDIT, history vendor column)

Out-of-band:
- Sibling staff-app repo: POST body adds `vendor_id`. Coordinated
  per §7.
- Pre-migration audit script (§1.1) run by operator before applying
  the migrations.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.

  Backend-developer scope: the three migrations (§1.1, §3.1+3.2,
  §4.1), the Edge Function update (§6), the `submitEODCount` +
  read-helper updates in `src/lib/db.ts` (§5), and `src/types/index.ts`
  (§8). Include the §4.2 variance-equality smoke-test runbook in the
  PR description. Run the §1.1 pre-migration audit on the seed
  dataset before committing — surface the orphan count in the PR.

  Frontend-developer scope: `src/store/useStore.ts` `submitEOD`
  reshape (§10), and `src/screens/cmd/sections/EODCountSection.tsx`
  per-vendor state + lock + EDIT (§9). Coordinate types with the
  backend-developer if `EODSubmission.vendorId` lands in a different
  PR slice — the section will not typecheck until the type widens.

  Sibling staff-app repo coordination (§7) is OUT of scope for this
  PR — flag in PR description.
payload_paths:
  - specs/020-eod-per-vendor-submissions/spec.md

## Files changed

Backend-developer slice (first hand-off) plus frontend-developer slice
(this hand-off). The frontend changes coordinate with backend-dev's type
widening and `submitEODCount` shape — the section now passes `vendorId` on
every submission and reads `vendorId` off rehydrated `eod_submissions`.

Migrations (run in order, each transactional):
- `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql` — adds
  nullable `vendor_id`, backfills via mode-of-entries with
  alphabetical-UUID tiebreaker, deletes orphans (zero in local seed), drops
  legacy `(store_id, date)` unique, enforces `NOT NULL`, adds new
  `(store_id, date, vendor_id)` unique + `vendor_id` FK with
  `ON DELETE RESTRICT`.
- `supabase/migrations/20260514120010_staff_submit_eod_v2.sql` — new 7-arg
  `staff_submit_eod(p_vendor_id)` with vendor-scoped `current_stock`
  writes (Q6), `· vendor: <name>` audit-detail suffix, ON CONFLICT on
  `(store_id, date, vendor_id)` for EDIT-path id stability. The legacy
  6-arg signature stays in place but its body now `RAISE EXCEPTION` with
  `errcode = '22023'` so any pre-update staff-app deploy fails loudly.
- `supabase/migrations/20260514120020_report_run_variance_multivendor.sql`
  — `report_run_variance` refactored to SUM `eod_entries.actual_remaining`
  per item across all `(store_id, date, status='submitted')` submissions
  for each anchor. Single-anchor XOR KPI also switched to anchor-date
  predicate. Single-id capture replaced with `EXISTS` for the P0002
  anchor-existence gates. Equality smoke-test runbook is in the file's
  header comment.

Application code:
- `src/lib/db.ts` — `submitEODCount` writes `vendor_id` to the parent
  upsert, switches `onConflict` to `'store_id,date,vendor_id'`, and the
  per-entry `inventory_items.update` is vendor-scoped via
  `.eq('vendor_id', submission.vendorId)` to mirror the RPC's Q6
  behavior. Three read helpers (`fetchTodaysEODForStores`,
  `fetchRecentEODSubmissions`, `fetchEodSubmissionsForStores`) project
  `vendor_id` and map it to `vendorId` in the camelCase output.
- `src/types/index.ts` — `EODSubmission` interface gains
  `vendorId: string` (required) and `vendorName?: string` (optional,
  hydrated client-side from `useStore.vendors` for display).

Notable design adjustment surfaced for reviewer attention:
- The architect's §3.1 #7 audit-row body reused v1's `ii.name` / `ii.unit`
  literally, but those columns were dropped in P3 lockdown
  (`20260504072830:59-60`). The v1 RPC has been silently broken at audit-
  insert time since then. The v2 RPC routes through
  `inventory_items.catalog_id → catalog_ingredients.name/unit` (mirroring
  the variance template, `20260512120000:113-117`) so the audit insert
  actually succeeds. Same fallback shape as v1 (the `coalesce(unit, '')`
  is the only material change). Recorded here for the post-impl review.

Verification performed locally (`npm run dev:db` stack):
- Pre-migration audit: 18 submissions, 18 inferrable, 0 orphans.
- Schema migration applied cleanly; new constraints present; FK with
  `ON DELETE RESTRICT` confirmed.
- Variance equality smoke test: three day-pair JSON envelopes captured
  pre-migration; `diff` against post-migration output → bit-identical.
- Two-vendor happy path: US FOOD + LEOPARD on `2026-05-12` → two rows in
  `eod_submissions`, four `eod_entries` (no overwrite), `current_stock`
  updated only for matching-vendor items.
- Vendor-scoped write (Q6): submitted same item from a non-owning vendor;
  `current_stock` left untouched, `eod_entries` row still persisted.
- Variance SUM-aggregation: same item under two vendors on one anchor
  date contributes `sum(actual_remaining)` to that anchor's qty.
- Idempotency replay: same `client_uuid` returns `conflict=true` with
  the existing submission id; entries unchanged.
- EDIT path: new `client_uuid`, same `(store, date, vendor)` triple →
  `conflict=false`, `submission_id` preserved, `submitted_at` bumped,
  entries replaced.
- Old 6-arg signature: `SQLSTATE 22023` with the deprecation message.
- TypeScript: `db.ts` and `types/index.ts` are clean (other pre-existing
  errors elsewhere in the repo are out of scope per CLAUDE.md).

Open items the post-impl reviewers should weigh in on:
- The v1-audit-row inheritance bug noted above — confirm the catalog
  join is the right fix shape.
- The Cmd UI path still uses direct PostgREST (architect's §5 option (b)).
  Frontend-developer's `useStore.submitEOD` slice will own the audit
  emit in this path; that file also needs the `· vendor:` suffix on
  the detail string to mirror the RPC's audit shape.
- Sibling staff-app coordination (§7) — out of scope this PR.

Frontend-developer slice (second hand-off):
- `src/store/useStore.ts` — `submitEOD` action reshape:
  - Merge lookup is now scoped on `(storeId, date, vendorId)` to mirror
    the DB's new unique. Two same-day submissions for different vendors
    create two separate local rows; same-vendor EDIT still merges.
  - Vendor-scoped `current_stock` write per Q6: the optimistic inventory
    mutation + `db.adjustItemStock` persistence only fire when the
    counted item's `vendorId` matches the submission's `vendorId`. Items
    counted via the unscheduled-item escape hatch (vendor mismatch) still
    emit the audit row + the eod_entries row (via `submitEODCount`) but
    skip the inventory mutation. Mirrors the RPC/db.ts branch.
  - Audit `detail` includes `· vendor: <name>` suffix to match the RPC's
    audit shape.
  - Notification broadcast string includes the vendor name in parens.
- `src/screens/cmd/sections/EODCountSection.tsx` — per-vendor count UX:
  - Per-vendor draft state (`caseCountsByVendor`, `unitCountsByVendor`,
    `notesByVendor` keyed by `vendorId → itemId → string`). Switching
    vendor tabs preserves typed-but-unsubmitted values for the session
    (Q4). Page refresh still discards (draft autosave is out of scope).
  - `submittedVendorIds` derived from `eodSubmissions` filtered by
    `(storeId, date, status='submitted')`. Defensive falsy `vendorId`
    guard for legacy rows that bypass the migration.
  - Vendor pill renders a `✓` glyph in `C.ok` and a green border when
    that vendor is in `submittedVendorIds`. Submitted-or-not is computed
    once per (date, store) so swapping the day or store updates pills.
  - Lock-after-submit:
    - When `isVendorLocked` (submitted + not editing), inputs render
      read-only with the prior submission's `actualRemainingCases` /
      `actualRemainingEach` / `actualRemaining` / `notes` values shown
      in place of the (empty) draft.
    - Submit/save-draft footer buttons hide; "EDIT" button appears.
    - Inline "✓ SUBMITTED" lock banner explains the read-only state and
      points the user at EDIT.
    - "SUBMITTED · LOCKED" chip in the tab strip's rightSlot echoes the
      banner.
  - EDIT flow: clicking EDIT adds the vendorId to `editingVendorIds`,
    pre-fills the per-vendor draft from `currentVendorSubmission.entries`
    (user-typed values win over server pre-fill on spread), unlocks the
    inputs, and switches the SUBMIT button copy to "UPDATE COUNT". An
    "EDITING" banner replaces the lock banner.
  - On successful submit (fresh OR update), only the current vendor's
    per-vendor draft slot is cleared and the vendor is removed from
    `editingVendorIds`. Other vendors' drafts survive.
  - history.tsx tab: now renders one row per submission with a VENDOR
    column (160px) between TIME and SUBMITTED BY. Sort: date DESC, then
    vendor name ASC (case-insensitive) with stable tiebreaker on
    submission id. Vendor name hydrated client-side from
    `useStore.vendors`; falls back to `'—'` when no vendor row matches
    (legacy / NULL vendor_id edge cases).
  - variance.log tab: replaces the single-row `find()` with a
    `filter()` and SUM-aggregates `actual_remaining` per `itemId` across
    all of today's submitted submissions, matching the server-side
    `report_run_variance` anchor math (Q3). "Items counted" stat-card
    sub-text shows the vendor count.
  - Week sidebar: per-day counted/status now aggregates across all of
    that day's vendor submissions. Day-level status picks `'draft'` if
    any draft exists, else `'submitted'`/`'late'` based on cumulative
    coverage vs total inventory.

Frontend verification:
- TypeScript: the two changed files are clean. Pre-existing TS errors
  elsewhere in the repo are out of scope per CLAUDE.md (the legacy
  `src/screens/EODCountScreen.tsx` now reports three new errors at lines
  528/537/671 because backend-dev tightened `EODSubmission.vendorId` to
  required and the legacy screen constructs submissions without it; this
  is a known runtime breakage of legacy by spec 020, not a new defect
  introduced by frontend-dev — see "Open items" below).
- Browser smoke verification per the acceptance criteria checklist was
  not performed by frontend-dev because the preview/chrome MCP tooling
  is not loaded in this agent's tool context. The dev server is up at
  `http://localhost:8081/`; manual verification by the reviewer is
  needed. The implementation matches the architect's §9 + §10 design
  intent and the typed-tab persistence, lock-after-submit, EDIT
  pre-fill, history vendor column, and variance SUM aggregation are
  each isolated to small, reviewable diffs in the section file.

Open items the post-impl reviewers should weigh in on (frontend side):
- Legacy `src/screens/EODCountScreen.tsx` is a downstream consumer of
  `EODSubmission` and was NOT updated by either developer. Backend-dev's
  `vendorId: string` (required) breaks its compile (three TS errors) and
  its runtime path also fails under the new NOT NULL constraint. Per
  CLAUDE.md the legacy AppNavigator flow is on a deprecation timer; the
  reviewer should confirm whether legacy needs a transitional patch
  before this spec ships, or whether the legacy screen is acceptably
  broken given Cmd UI is the active surface.
- Draft-save reload behavior is unchanged: drafts saved via SAVE DRAFT
  land on the server with status='draft', but on reload my section's
  per-vendor draft map starts empty (drafts don't auto-rehydrate). This
  matches Q4 ("Refreshing the page or losing the session still discards
  them — draft autosave is out of scope") and is the pre-existing
  behavior — flagged for confirmation.
- The EDIT flow's spread order favors user-typed values over the
  server-loaded pre-fill (architect §9.4). Reviewer should confirm
  this is the desired UX — the alternative is server-wins (one-line
  spread flip).

### Round-2 fixes (post-review patch)

Round-1 came back FIXES_NEEDED with 8 Critical findings across 4 reviewers
(see `specs/020-eod-per-vendor-submissions/reviews/release-proposal.md`).
This patch addresses every Critical + the 3 Should-fixes the proposal
asked to bundle. Path A chosen for B3 (legacy stub) and posture (a)
admin-only for C3 UPDATE policy (preserves Q5 EDIT).

**P0 — Critical**

1. `supabase/functions/staff-eod-submit/index.ts` — added `vendor_id`
   to the `Body` interface and `validate()`, and forwarded it as
   `p_vendor_id` to the RPC. Pre-update sibling-app POSTs now receive
   a clean 400 (`"vendor_id required (spec 020 per-vendor partitioning)"`)
   instead of falling through to the legacy 6-arg signature's fail-loud
   RAISE. Closes architect-C1 / security-H1 / test-C1 (single
   omission flagged by three reviewers).

2. `src/lib/db.ts` — `fetchRecentEodDates` deduped via `Set`. Over-
   fetches `max(limit*8, 16)` rows, applies `[...new Set(…)].slice(limit)`
   so the variance template's `{from, to}` pair seeds with distinct
   dates even when N vendor submissions exist on a single day.
   Closes code-reviewer C1 (the 22023 errcode on `from == to`).

3. `src/store/useStore.ts` — fixed the inverted Q6 guard at the
   admin-JWT path. Old shape was
   `!subVendorId || !item?.vendorId || item.vendorId === subVendorId`
   which short-circuited true for null-vendor items (the escape-hatch
   case the spec explicitly intends to GATE), letting
   `db.adjustItemStock` overwrite their `current_stock` on the server.
   New shape is `item?.vendorId === subVendorId` (strict equality —
   matches the RPC's `where vendor_id = p_vendor_id` semantics).
   Audit row still fires regardless of vendor match so escape-hatch
   counts remain traceable. Closes code-reviewer C2.

4. `src/screens/EODCountScreen.tsx` (legacy AppNavigator) —
   added `vendorId: ''` stub at both submission-construction sites
   (line ~515 `confirmSubmit` and line ~659 `handleUpdate`). The
   `handleUpdate` site reuses `myTodaySubmission.vendorId` when present
   so an EDIT path originating from a Cmd UI submission carries the
   real vendor through. Runtime DB insert will trip the NOT NULL
   constraint on `vendor_id` if anyone hits this code path with a
   blank-string vendorId, but the Cmd UI is the primary surface and
   `EXPO_PUBLIC_NEW_UI` defaults on next month per CLAUDE.md
   "Legacy admin screens". Path A from the release proposal.
   Closes code-reviewer C3 (TS strict build break) / test-C2.

5. `supabase/migrations/20260514120030_eod_submissions_consistency.sql`
   — new migration mirroring spec 019's
   `20260513120000_inventory_counts_consistency.sql`. Closes the 4
   security-auditor Criticals (C1-C4):
   - **C1 closed**: BEFORE INSERT/UPDATE trigger
     `eod_submissions_set_submitted_by` overrides
     `new.submitted_by := auth.uid()` unconditionally. Live-PoC
     verified — manager attempting to attribute to admin produces a
     row with `submitted_by = manager's UID`. Service-role callers
     produce NULL, matching the v2 RPC's explicit NULL write.
   - **C2 closed**: BEFORE INSERT/UPDATE trigger
     `eod_entries_check_store` re-asserts
     `inventory_items.store_id == eod_submissions.store_id`. Live-PoC
     verified — manager with cross-store visibility (Towson + Frederick)
     attempting an entry with Frederick item under Towson submission
     raises `42501: eod_entries: item store mismatch with parent submission`.
   - **C3 closed (admin-only UPDATE per posture (a))**: Dropped
     `store_member_update_eod_submissions` /
     `store_member_update_eod_entries`. Replaced with
     `admin_update_eod_submissions` / `admin_update_eod_entries`
     gated on `auth_is_privileged() AND auth_can_see_store(store_id)`.
     Manager UPDATE matches 0 rows; admin UPDATE matches 1 row
     (Q5 EDIT flow preserved). Live-PoC verified.
   - **C4 closed**: Dropped DELETE policies on both tables entirely
     (append-only posture per spec 019's pattern). Manager DELETE
     matches 0 rows; admin DELETE also matches 0 rows. Live-PoC
     verified. Store-cascade-delete still works (cascade runs as
     postgres role).

**P1 — Should-fix (bundled)**

6. `src/screens/cmd/sections/EODCountSection.tsx` — moved per-vendor
   draft state clear (`setCaseCountsByVendor` /
   `setUnitCountsByVendor` / `setNotesByVendor` /
   `setEditingVendorIds`) INSIDE the `try` block after
   `await submitEODCount(submission)` resolves. Cloud failure no
   longer drops the user's typed-but-unsubmitted escape-hatch values.
   Closes code-reviewer S1.

7. `supabase/migrations/20260514120010_staff_submit_eod_v2.sql` —
   added a header comment to the parent INSERT explaining
   `submitted_by` NULL semantics for staff-app callers. The new
   `submitted_by` override trigger (item 5a above) naturally produces
   NULL for service_role callers (`auth.uid()` returns NULL), so the
   explicit NULL write in the INSERT VALUES is belt-and-braces
   defensive. Closes code-reviewer S2.

8. `src/store/useStore.ts` — updated the audit-detail comment to
   document the convention. Both paths share the `· vendor: <name>`
   suffix; the admin-JWT path prefixes with the action verb
   (`"Count updated"` / `"Remaining count submitted"`) while the
   RPC path prefixes with `p_submitted_by` (display name). Parsers
   that split on `" · vendor: "` get consistent vendor identification
   across both paths. No code change beyond clarifying comment.
   Closes code-reviewer S3.

**Verification performed**

- New migration applied locally via
  `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -f -`.
- All four security-auditor PoCs re-run as `manager@local.test`
  (UID `22222222-2222-2222-2222-222222222222`) inside transactions
  with `set local "request.jwt.claims"` — all four closed (see
  output captured above for the migration apply).
- Admin EDIT path verified (UPDATE matches 1 row for admin UID
  `11111111-1111-1111-1111-111111111111`).
- v2 RPC end-to-end via service-role direct call — returns
  `{conflict: false, entry_ids, stock_updates}` correctly.
- Edge function smoke (`POST /functions/v1/staff-eod-submit`) with
  `vendor_id` — 200 OK with submission_id. Without `vendor_id` —
  400 with `"vendor_id required (spec 020 per-vendor partitioning)"`.
- `npx tsc --noEmit` on the four touched code files (`db.ts`,
  `useStore.ts`, `EODCountSection.tsx`, `EODCountScreen.tsx`) —
  the three previously-blocking spec-020 errors at
  `EODCountScreen.tsx:528 / 537 / 671` are gone. Remaining errors
  in the global typecheck are pre-existing (not introduced by this
  round; documented as out-of-scope in the release proposal).

**Round-2 files changed**

Migration:
- `supabase/migrations/20260514120030_eod_submissions_consistency.sql` (NEW) — 4 security closures (submitted_by override trigger, cross-store entry consistency trigger, admin-only UPDATE policy, no-DELETE policy).

Edge function:
- `supabase/functions/staff-eod-submit/index.ts` — `vendor_id` validation + `p_vendor_id` RPC arg.

Migration text-only fix:
- `supabase/migrations/20260514120010_staff_submit_eod_v2.sql` — comment-only addition documenting `submitted_by` NULL semantics (no behavior change).

Application code:
- `src/lib/db.ts` — `fetchRecentEodDates` dedupe via `Set` + over-fetch.
- `src/store/useStore.ts` — Q6 guard inversion fix (strict equality) + audit-detail convention comment.
- `src/screens/cmd/sections/EODCountSection.tsx` — `onSubmit` draft-state clear moved inside `try` block.
- `src/screens/EODCountScreen.tsx` (legacy) — `vendorId: ''` stub at both submission constructions (Path A from release proposal).

**Out of scope**

- Code-reviewer's 6 Nits (per release proposal P2).
- Security-auditor's 2 Low + 1 Medium findings (per release proposal P2).
- Pre-existing items (cold-boot React errors,
  `supabase_realtime FOR ALL TABLES` posture, `npm audit`).
- Sibling staff-app repo coordination (§7) — out of scope this PR.
