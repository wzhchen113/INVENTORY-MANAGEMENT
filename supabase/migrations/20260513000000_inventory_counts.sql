-- ============================================================
-- Spec 019 — Any-time inventory count
--
-- Adds parallel tables to the EOD flow so a store manager can submit a
-- count of all (or some) inventory items at any wall-clock instant —
-- spot-check, opening, mid-shift, closing — without overwriting the
-- existing EOD record for that date.
--
-- Path A (per spec Q1, user-ratified). `eod_submissions` and
-- `eod_entries` are left untouched; `staff_submit_eod` and the variance
-- template anchor keep working unchanged.
--
-- Hard rules baked into the RPC below (mirroring REPORTS-1/2/3 patterns):
--   • `security invoker` — RLS gates per-store visibility via
--     `auth_can_see_store(store_id)`. Cross-store visibility for
--     super-admin / admin / master is preserved because that helper
--     short-circuits to `auth_is_admin()` (see
--     `20260504173035_per_store_rls_hardening.sql:33-41`).
--   • `set search_path = public` — locks the schema.
--   • REVOKE EXECUTE from PUBLIC + anon, GRANT to authenticated.
--     Postgres' default `EXECUTE TO PUBLIC` lets `anon` (which inherits
--     from PUBLIC) bypass a bare `REVOKE … FROM anon`, so the revoke
--     from PUBLIC is the load-bearing step. Mirror of
--     `20260505065303_admin_rpcs_lock_anon.sql:24` and
--     `20260510120000_report_runs.sql:205-211`.
--   • `submitted_by` is server-canonical (`auth.uid()`); the client
--     cannot forge the audit trail. Closes the REPORTS-1-style
--     attribution-forgery vector (see
--     `20260510130000_report_runs_consistency.sql:48-88`).
--
-- ─── Design notes documented for reviewers ──────────────────
--
-- • Idempotency model. `client_uuid` is a per-submit-attempt UUID
--   minted by the caller. A repeat call with the same UUID returns the
--   existing `inventory_counts.id` with `conflict: true` — no second
--   row is inserted. Mirrors `staff_submit_eod` (see
--   `20260504000001_staff_submit_eod_rpc.sql:43-54`) and waste's
--   `staff_log_waste_rpc`. The UNIQUE index is PARTIAL (`where
--   client_uuid is not null`) so admin/legacy rows without an
--   idempotency key don't collide on NULL.
--
-- • `inventory_count_entries.item_id` is `ON DELETE RESTRICT`, not
--   CASCADE. Rationale: counts are historical snapshots; deleting an
--   inventory item six months later should not silently drop count
--   history. RESTRICT forces the deleter to confront the count history
--   first (or wait for a future soft-delete posture on inventory
--   items). `eod_entries.item_id` has the same posture
--   (no cascade in the original `init_schema`).
--
-- • No UNIQUE on `(store_id, counted_at)`. Two managers in different
--   rooms can submit at the same wall-clock second; the idempotency
--   key handles the only real duplicate case (single submitter
--   re-clicks Submit). EOD's `(store_id, date)` unique is intentional
--   because EOD is per-day; any-time counts are per-instant.
--
-- • RPC does NOT write `inventory_items.current_stock` or
--   `eod_remaining`. Per spec Q2 default (user-ratified), spot /
--   open / mid_shift / close counts are advisory historical
--   snapshots. EOD remains the only path that overwrites live stock.
--   Reviewers should confirm there is no `UPDATE … inventory_items`
--   anywhere in this file.
--
-- • Realtime: `supabase_realtime` is `FOR ALL TABLES` (see
--   `20260502190000_realtime_publication.sql:14`); the new tables
--   join the publication automatically. No `docker restart
--   supabase_realtime_imr-inventory` step required.
-- ============================================================

-- ─── Table: inventory_counts ─────────────────────────────────
create table if not exists public.inventory_counts (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores(id) on delete cascade,
  counted_at      timestamptz not null default now(),
  kind            text not null
                    check (kind in ('spot','open','mid_shift','close')),
  submitted_by    uuid null references public.profiles(id) on delete set null,
  submitted_at    timestamptz not null default now(),
  status          text not null default 'submitted'
                    check (status in ('draft','submitted')),
  client_uuid     uuid null,
  notes           text null,
  created_at      timestamptz not null default now()
);

-- Read pattern: "Recent counts" list for the active store, descending
-- by `counted_at`. Drives `fetchRecentInventoryCounts`.
create index if not exists inventory_counts_store_counted_at_idx
  on public.inventory_counts(store_id, counted_at desc);

-- Read pattern: "last spot count" / "last open count" lookups. Cheap
-- to add now; supports future variance-anchor work if spec Q3 is ever
-- flipped.
create index if not exists inventory_counts_store_kind_counted_at_idx
  on public.inventory_counts(store_id, kind, counted_at desc);

-- Idempotency. Partial so legacy NULL rows don't collide. Store-scoped
-- so a cross-store `client_uuid` collision returns the documented
-- `conflict: true` envelope under the caller's RLS instead of leaking a
-- raw `23505 duplicate key` from a foreign store's row (security-auditor
-- H1). The RPC's dedup `select` (below) is filtered on `store_id`
-- to match.
create unique index if not exists inventory_counts_store_client_uuid_uidx
  on public.inventory_counts(store_id, client_uuid)
  where client_uuid is not null;

alter table public.inventory_counts enable row level security;

-- ─── Table: inventory_count_entries ──────────────────────────
create table if not exists public.inventory_count_entries (
  id                       uuid primary key default gen_random_uuid(),
  count_id                 uuid not null references public.inventory_counts(id) on delete cascade,
  item_id                  uuid not null references public.inventory_items(id) on delete restrict,
  actual_remaining         numeric(10,3) null,
  actual_remaining_cases   numeric(10,3) null,
  actual_remaining_each    numeric(10,3) null,
  unit                     text null,
  notes                    text null,
  created_at               timestamptz not null default now()
);

-- Entry lookup by parent count. Drives `fetchInventoryCount` detail.
create index if not exists inventory_count_entries_count_id_idx
  on public.inventory_count_entries(count_id);

-- Supports a future "last spot count of item X" pull (e.g. a
-- per-item history side panel).
create index if not exists inventory_count_entries_item_created_idx
  on public.inventory_count_entries(item_id, created_at desc);

alter table public.inventory_count_entries enable row level security;

-- ─── RLS: inventory_counts ───────────────────────────────────
-- Four-policy template per `per_store_rls_hardening.sql:46-61`.
drop policy if exists "store_member_read_inventory_counts"   on public.inventory_counts;
drop policy if exists "store_member_insert_inventory_counts" on public.inventory_counts;
drop policy if exists "store_member_update_inventory_counts" on public.inventory_counts;
drop policy if exists "store_member_delete_inventory_counts" on public.inventory_counts;

create policy "store_member_read_inventory_counts"
  on public.inventory_counts for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_inventory_counts"
  on public.inventory_counts for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_inventory_counts"
  on public.inventory_counts for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_inventory_counts"
  on public.inventory_counts for delete
  using (public.auth_can_see_store(store_id));

-- ─── RLS: inventory_count_entries (scoped through parent) ────
-- Same `EXISTS` shape as `eod_entries`
-- (`per_store_rls_hardening.sql:87-132`). The parent's `store_id` is
-- the source of truth; child rows inherit visibility through the
-- join.
drop policy if exists "store_member_read_inventory_count_entries"   on public.inventory_count_entries;
drop policy if exists "store_member_insert_inventory_count_entries" on public.inventory_count_entries;
drop policy if exists "store_member_update_inventory_count_entries" on public.inventory_count_entries;
drop policy if exists "store_member_delete_inventory_count_entries" on public.inventory_count_entries;

create policy "store_member_read_inventory_count_entries"
  on public.inventory_count_entries for select
  using (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  );

create policy "store_member_insert_inventory_count_entries"
  on public.inventory_count_entries for insert
  with check (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  );

create policy "store_member_update_inventory_count_entries"
  on public.inventory_count_entries for update
  using (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  );

create policy "store_member_delete_inventory_count_entries"
  on public.inventory_count_entries for delete
  using (
    exists (
      select 1 from public.inventory_counts c
       where c.id = inventory_count_entries.count_id
         and public.auth_can_see_store(c.store_id)
    )
  );

-- ─── RPC: submit_inventory_count ─────────────────────────────
-- Atomic insert of the parent count + non-blank entries, in a single
-- PostgREST request (which wraps the RPC body in an implicit
-- transaction). Per spec §3 / architect §3:
--   • Gate FIRST on `auth_can_see_store(p_store_id)` → raise 42501.
--   • Validate `p_kind` allowlist → raise 22023. `'eod'` is excluded
--     intentionally — that flow goes through `staff_submit_eod`.
--   • Validate `p_status` allowlist → raise 22023.
--   • Validate `p_entries` is a non-empty JSON array → raise 22023.
--   • Idempotency: if `p_client_uuid` matches an existing row, return
--     that row's id with `conflict: true` and NO entry rewrite.
--   • Walk entries; skip fully-blank rows (no `actual_remaining*` set).
--     Validate non-negativity → raise 22023. Validate `item_id`
--     belongs to `p_store_id` → raise 23503.
--   • Require ≥1 non-blank entry to commit (raise 22023 → parent
--     insert rolls back via the implicit txn).
--   • `submitted_by` is canonical `auth.uid()` — the client cannot
--     forge attribution.
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

  -- (b) Kind allowlist — reject 'eod' explicitly. The CHECK on the
  --     column would also catch this on INSERT, but raising here with
  --     22023 gives the frontend a cleaner error class than the raw
  --     CHECK violation.
  if p_kind is null or p_kind not in ('spot','open','mid_shift','close') then
    raise exception 'invalid kind %', p_kind using errcode = '22023';
  end if;

  -- (c) Status allowlist.
  if coalesce(p_status, 'submitted') not in ('draft','submitted') then
    raise exception 'invalid status %', p_status using errcode = '22023';
  end if;

  -- (d) p_entries must be a JSON array with at least one element. The
  --     "≥1 NON-BLANK" rule is enforced AFTER we walk the array (h).
  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 then
    raise exception 'p_entries must be a non-empty array' using errcode = '22023';
  end if;

  -- (e) Idempotency check — mirrors staff_submit_eod:43-54. Store-scoped
  --     match: the partial-unique index is on `(store_id, client_uuid)`,
  --     so a cross-store UUID collision returns the documented
  --     `conflict: true` envelope rather than a raw 23505. (security-
  --     auditor H1.)
  if p_client_uuid is not null then
    select id into v_existing_id
      from public.inventory_counts
     where client_uuid = p_client_uuid
       and store_id    = p_store_id;
    if v_existing_id is not null then
      return jsonb_build_object(
        'count_id', v_existing_id,
        'conflict', true,
        'entry_ids', '[]'::jsonb
      );
    end if;
  end if;

  -- (f) Insert the parent row. `submitted_by` is canonical auth.uid()
  --     — closes the REPORTS-1-style attribution-forgery vector.
  insert into public.inventory_counts
    (store_id, counted_at, kind, submitted_by, status, client_uuid, notes)
  values
    (p_store_id,
     coalesce(p_counted_at, now()),
     p_kind,
     auth.uid(),
     coalesce(p_status, 'submitted'),
     p_client_uuid,
     p_notes)
  returning id into v_count_id;

  -- (g) Walk entries. Blank rows (all three remaining-* null) are
  --     SKIPPED, not stored. Non-null entries must validate against
  --     `inventory_items` in this store.
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
    -- Skip fully-blank entries (spec Q6).
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

    -- Item must exist AND belong to this store. The `exists` is cheaper
    -- than `select … into` and the per-row RLS read policy on
    -- inventory_items combined with this store-id check closes any
    -- cross-store spoof attempt.
    if not exists (
      select 1 from public.inventory_items
       where id = v_entry.item_id and store_id = p_store_id
    ) then
      raise exception 'item % not in store %', v_entry.item_id, p_store_id
        using errcode = '23503';
    end if;

    -- Pass-through `notes` as-is. NULL stays NULL — empty-string
    -- coercion would diverge from the parent `inventory_counts.notes`
    -- shape and break downstream `where notes is not null` filters
    -- (code-reviewer S2).
    insert into public.inventory_count_entries
      (count_id, item_id, actual_remaining, actual_remaining_cases,
       actual_remaining_each, unit, notes)
    values
      (v_count_id, v_entry.item_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       v_entry.unit, v_entry.notes)
    returning id into v_entry_id;

    v_entry_ids := array_append(v_entry_ids, v_entry_id);
    v_kept_count := v_kept_count + 1;
  end loop;

  -- (h) At least one non-blank entry required per AC §Frontend Q6.
  --     The parent insert above rolls back automatically because the
  --     whole RPC body runs inside PostgREST's implicit transaction.
  if v_kept_count = 0 then
    raise exception 'no non-blank entries' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'count_id', v_count_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids)
  );
end;
$$;

-- REVOKE from public + anon is the load-bearing step: Postgres'
-- default `EXECUTE TO PUBLIC` would otherwise leak through to `anon`
-- (which is a member of PUBLIC) even after a bare `… FROM anon`.
-- Mirror of `report_runs.sql:205-211`.
revoke execute on function public.submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text) from public, anon;
grant  execute on function public.submit_inventory_count(uuid, uuid, text, timestamptz, text, jsonb, text) to authenticated;
