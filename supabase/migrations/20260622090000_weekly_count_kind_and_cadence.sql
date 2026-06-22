-- ============================================================
-- Spec 098 — Migration A: weekly count kind + per-store cadence
--
-- Reuses the spec 019 `inventory_counts` + `inventory_count_entries`
-- tables for the staff weekly full-store count (advisory snapshot,
-- Q1-A). This migration:
--
--   1. Widens the `inventory_counts.kind` CHECK to admit 'weekly'.
--      Additive/safe — widening a CHECK to admit a new value never
--      invalidates existing rows.
--   2. Adds `stores.weekly_count_due_dow smallint` (0=Sunday .. 6=Saturday,
--      JS Date.getDay() convention). NULL = no cadence = "not scheduled".
--   3. Adds the staff write RPC `submit_weekly_count` — a thin wrapper that
--      hard-codes kind='weekly' so the client cannot smuggle a different
--      kind and so the generic `submit_inventory_count` allowlist can stay
--      closed (defense-in-depth).
--   4. Adds the read RPC `weekly_count_status` — deterministic local-time
--      week window ending on the configured due day. Uses extract(dow ...)
--      (0=Sun..6=Sat) for JS getDay() parity — NOT isodow.
--
-- No down migration (project convention). No new index needed:
-- `inventory_counts_store_kind_counted_at_idx (store_id, kind,
-- counted_at desc)` already covers "latest weekly count for store X".
--
-- Realtime: `inventory_counts` is already in the FOR ALL TABLES
-- publication; no membership change → no realtime container restart
-- required for this spec.
-- ============================================================

-- ─── (1) Widen the kind CHECK to admit 'weekly' ──────────────
-- The original constraint is an inline unnamed CHECK at
-- 20260513000000_inventory_counts.sql:74-75; Postgres generated the name
-- `inventory_counts_kind_check`. Look it up defensively (in case a future
-- image names it differently) and drop+recreate.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'inventory_counts'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%kind%';
  if v_conname is not null then
    execute format('alter table public.inventory_counts drop constraint %I', v_conname);
  end if;
end $$;

alter table public.inventory_counts
  add constraint inventory_counts_kind_check
  check (kind in ('spot','open','mid_shift','close','weekly'));

-- ─── (2) Per-store weekly cadence column ─────────────────────
-- 0=Sunday .. 6=Saturday, matching JS Date.getDay() and the WEEKDAYS
-- array in EODCount.tsx. NULL = not scheduled (excluded from reminders
-- and overdue status). Additive nullable column — safe on the seed; no
-- backfill.
alter table public.stores
  add column if not exists weekly_count_due_dow smallint null
    check (weekly_count_due_dow between 0 and 6);

-- ─── (3) RPC: submit_weekly_count (staff write) ──────────────
-- Thin wrapper around the same shape as submit_inventory_count, but
-- hard-codes kind='weekly' and exposes no kind/status params for the
-- client to forge. SECURITY INVOKER → per-store RLS gate via
-- auth_can_see_store. NO UPDATE inventory_items anywhere (advisory
-- snapshot — pgTAP asserts current_stock unchanged).
create or replace function public.submit_weekly_count(
  p_client_uuid uuid,
  p_store_id    uuid,
  p_counted_at  timestamptz,
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

  -- (b) p_entries must be a non-empty JSON array. The "≥1 NON-BLANK"
  --     rule is enforced after the walk (g).
  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 then
    raise exception 'p_entries must be a non-empty array' using errcode = '22023';
  end if;

  -- (c) Idempotency — store-scoped (store_id, client_uuid) match reuses
  --     the EXISTING partial-unique index inventory_counts_store_client_uuid_uidx.
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

  -- (d) Insert the parent row. kind hard-coded to 'weekly';
  --     submitted_by is canonical auth.uid() (also enforced by the
  --     BEFORE INSERT trigger inventory_counts_set_submitted_by_trg).
  insert into public.inventory_counts
    (store_id, counted_at, kind, submitted_by, status, client_uuid, notes)
  values
    (p_store_id,
     coalesce(p_counted_at, now()),
     'weekly',
     auth.uid(),
     'submitted',
     p_client_uuid,
     p_notes)
  returning id into v_count_id;

  -- (e) Walk entries; skip fully-blank; non-negative check; item-in-store
  --     check. Identical to submit_inventory_count's walk.
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
    if v_entry.actual_remaining is null
       and v_entry.actual_remaining_cases is null
       and v_entry.actual_remaining_each is null then
      continue;
    end if;

    if coalesce(v_entry.actual_remaining, 0) < 0
       or coalesce(v_entry.actual_remaining_cases, 0) < 0
       or coalesce(v_entry.actual_remaining_each, 0) < 0 then
      raise exception 'counted_qty must be >= 0' using errcode = '22023';
    end if;

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
       v_entry.unit, v_entry.notes)
    returning id into v_entry_id;

    v_entry_ids := array_append(v_entry_ids, v_entry_id);
    v_kept_count := v_kept_count + 1;
  end loop;

  -- (f) At least one non-blank entry required. The parent insert rolls
  --     back via PostgREST's implicit transaction.
  if v_kept_count = 0 then
    raise exception 'no non-blank entries' using errcode = '22023';
  end if;

  -- (g) NO UPDATE inventory_items — advisory-snapshot guarantee.

  return jsonb_build_object(
    'count_id', v_count_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids)
  );
end;
$$;

-- REVOKE from public + anon is load-bearing: anon inherits EXECUTE TO
-- PUBLIC. Mirror of submit_inventory_count:387-388.
revoke execute on function public.submit_weekly_count(uuid, uuid, timestamptz, jsonb, text) from public, anon;
grant  execute on function public.submit_weekly_count(uuid, uuid, timestamptz, jsonb, text) to authenticated;

-- ─── (4) RPC: weekly_count_status (read) ─────────────────────
-- Deterministic local-time week window ending on the store's configured
-- due day-of-week. The window math takes the caller's local as-of date
-- (NOT now()::date) to avoid the UTC off-by-one the spec warns about.
--
-- Window (per design §3): given p_as_of_date and due_dow,
--   days_since_due = (extract(dow from p_as_of_date)::int - due_dow + 7) % 7
--   window_end     = p_as_of_date - days_since_due   (most recent due-day, or today)
--   window_start   = window_end - 6
-- Completed iff a kind='weekly' count exists for the store whose
-- counted_at (in the server DEFAULT_TIMEZONE, America/New_York) falls in
-- [window_start, window_end].
--
-- Status: 'not_scheduled' (due_dow NULL), 'completed', 'open'
-- (uncompleted and as_of < window_end), 'overdue' (uncompleted and
-- as_of == window_end, i.e. it IS the due day). The UI collapses
-- open|overdue → "show banner / overdue".
--
-- SECURITY INVOKER → rows are clipped by stores / inventory_counts RLS
-- (auth_can_see_store short-circuits to auth_is_admin for admins).
-- p_store_id NULL = all visible active stores (admin tab); non-null =
-- one row (staff banner).
create or replace function public.weekly_count_status(
  p_store_id   uuid,
  p_as_of_date date
) returns table (
  store_id        uuid,
  due_dow         smallint,
  window_start    date,
  window_end      date,
  status          text,
  last_count_id   uuid,
  last_counted_at timestamptz
)
language sql
security invoker
set search_path = public
as $$
  -- Single-TZ assumption (server DEFAULT_TIMEZONE = America/New_York),
  -- matching the eod-reminder-cron and the weekly-reminder-cron. A
  -- per-store timezone column is a known follow-up (design §9). Hardcoded
  -- as a literal rather than a GUC because no app.* timezone GUC
  -- convention exists in this schema.
  with tz as (
    select 'America/New_York'::text as zone
  ),
  scoped as (
    select s.id, s.weekly_count_due_dow
      from public.stores s
     where s.status = 'active'
       and (p_store_id is null or s.id = p_store_id)
  ),
  windowed as (
    select
      sc.id as store_id,
      sc.weekly_count_due_dow as due_dow,
      case when sc.weekly_count_due_dow is null then null::date
           else p_as_of_date
                - ((extract(dow from p_as_of_date)::int
                    - sc.weekly_count_due_dow + 7) % 7)
      end as window_end
    from scoped sc
  ),
  bounded as (
    select
      w.store_id,
      w.due_dow,
      w.window_end,
      case when w.window_end is null then null::date
           else w.window_end - 6
      end as window_start
    from windowed w
  ),
  latest as (
    select
      b.store_id,
      b.due_dow,
      b.window_start,
      b.window_end,
      ic.id as last_count_id,
      ic.counted_at as last_counted_at
    from bounded b
    cross join tz
    left join lateral (
      select c.id, c.counted_at
        from public.inventory_counts c
       where c.store_id = b.store_id
         and c.kind = 'weekly'
         and b.window_start is not null
         and (c.counted_at at time zone tz.zone)::date
               between b.window_start and b.window_end
       order by c.counted_at desc
       limit 1
    ) ic on true
  )
  select
    l.store_id,
    l.due_dow,
    l.window_start,
    l.window_end,
    case
      when l.due_dow is null then 'not_scheduled'
      when l.last_count_id is not null then 'completed'
      when p_as_of_date >= l.window_end then 'overdue'
      else 'open'
    end as status,
    l.last_count_id,
    l.last_counted_at
  from latest l;
$$;

revoke execute on function public.weekly_count_status(uuid, date) from public, anon;
grant  execute on function public.weekly_count_status(uuid, date) to authenticated;
