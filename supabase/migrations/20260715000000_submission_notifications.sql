-- ============================================================
-- Spec 120 — Brand-scoped submission notification bell (admin Cmd UI)
--
-- Additive migration. Two new tables, four trigger functions + their
-- triggers, one shared SECURITY DEFINER emitter, one pg_net push-enqueue
-- helper, two read RPCs, and one supabase_realtime publication add. No
-- destructive DDL; no change to any existing policy.
--
-- Design authority: specs/120-admin-submission-notification-bell.md
-- "## Backend design" (§0 corrections heeded):
--   • "receiving" is NOT a table — it is a state transition on
--     public.purchase_orders (status → 'partial'|'received').
--   • "po" and "receiving" share purchase_orders as their source; the
--     five notification TYPES come from FOUR source tables. purchase_orders
--     drives two of them off INSERT-or-UPDATE status transitions.
--   • "weekly" is public.inventory_counts filtered to kind='weekly'
--     (spec 019/098 shares that table with spot/open/mid_shift/close).
--
-- Source map (actor/store columns verified against init schema +
-- inventory_counts / weekly-cadence migrations):
--
--   type       | source table       | fires on                              | actor col     | store col
--   -----------+--------------------+---------------------------------------+---------------+----------
--   eod        | eod_submissions    | AFTER INSERT WHEN status='submitted'  | submitted_by  | store_id
--   weekly     | inventory_counts   | AFTER INSERT WHEN kind='weekly'       | submitted_by  | store_id
--   waste      | waste_log          | AFTER INSERT                          | logged_by     | store_id
--   po         | purchase_orders    | AFTER INSERT/UPDATE INTO status=sent  | created_by    | store_id
--   receiving  | purchase_orders    | AFTER INSERT/UPDATE INTO partial|recv | received_by   | store_id
-- ============================================================

-- pg_net powers the best-effort push enqueue (already present locally + on
-- prod via the reminder crons). Assert, do not assume.
create extension if not exists pg_net;


-- ─── Part 1: data model (§1) ──────────────────────────────────────────
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id)   on delete cascade,
  store_id       uuid not null references public.stores(id)   on delete cascade,
  actor_user_id  uuid          references public.profiles(id) on delete set null,
  type           text not null check (type in ('eod','weekly','waste','receiving','po')),
  source_id      uuid not null,                 -- the submission / PO row id
  actor_name     text,                          -- DENORMALIZED at insert (see §1 rationale)
  store_name     text,                          -- DENORMALIZED at insert
  created_at     timestamptz not null default now()
);

-- Dedup spine: one notification per (type, source row). A re-submit or a
-- repeated status transition hits the conflict and no-ops (§3).
create unique index if not exists notifications_type_source_uidx
  on public.notifications (type, source_id);

-- Feed: newest-first, brand-scoped window scan.
create index if not exists notifications_brand_created_idx
  on public.notifications (brand_id, created_at desc);

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
  -- PK (notification_id, user_id) doubles as the read-join index; the count
  -- RPC's anti-join rides notification_id equality. No extra index needed.
);


-- ─── Part 2: RLS (§2) ─────────────────────────────────────────────────
-- notifications: SELECT-only for clients. All writes come from the
-- SECURITY DEFINER emitter (table owner, bypasses RLS). No client
-- INSERT/UPDATE/DELETE policy => default deny for writes.
alter table public.notifications enable row level security;

-- The privileged conjunct is LOAD-BEARING: a same-brand staff `user` row is
-- backfilled with a real brand_id (012a §3), so auth_can_see_brand() alone
-- would return TRUE for them. The spec requires `user`s be
-- submitters-not-recipients; auth_is_privileged() denies them at the DB.
-- super_admin: auth_can_see_brand short-circuits TRUE => all brands.
-- admin/master: only rows whose brand_id matches their profiles.brand_id.
create policy "privileged_brand_read_notifications"
  on public.notifications for select
  using (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));

-- notification_reads: per-viewer ownership. A read is insert-once; re-read is
-- idempotent via ON CONFLICT DO NOTHING, so no UPDATE policy. The SELECT
-- policy clips to auth.uid(), which is what makes a PostgREST embed of
-- notification_reads from notifications return ONLY the caller's own read
-- rows (§5, single round-trip per-viewer `read` flag).
alter table public.notification_reads enable row level security;

create policy "own_reads_select" on public.notification_reads
  for select using (user_id = auth.uid());
create policy "own_reads_insert" on public.notification_reads
  for insert with check (user_id = auth.uid());
create policy "own_reads_delete" on public.notification_reads
  for delete using (user_id = auth.uid());

-- Grants: spec-097 posture. Both tables inherit the ALTER DEFAULT PRIVILEGES
-- grants (SELECT+INSERT+… to anon/authenticated, ALL to service_role) from
-- 20260618000000; RLS is the gate, not the grant layer. Do NOT revoke from
-- anon/authenticated (would trip the spec-097 grant lint). Left untouched.


-- ─── Part 3: push enqueue helper (§4) ─────────────────────────────────
-- SECURITY DEFINER so it can read the service_role-only _edge_auth table and
-- fire pg_net regardless of the submitter's RLS. Reads the function URL from
-- _edge_auth 'submission_push_url' and the shared bearer from the existing
-- 'cron_bearer' row (same infra as the reminder crons). Local dev never seeds
-- submission_push_url => the POST is skipped with a NOTICE, so the local stack
-- never pings prod. pg_net enqueues and sends AFTER commit via its background
-- worker => never blocks the submission.
create or replace function public.enqueue_submission_push(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_bearer text;
begin
  select value into v_url    from public._edge_auth where name = 'submission_push_url';
  select value into v_bearer from public._edge_auth where name = 'cron_bearer';

  if v_url is null then
    raise notice 'submission_push_url not configured in _edge_auth — skipping push fan-out (expected for local dev)';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || coalesce(v_bearer, ''),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('notification_id', p_notification_id),
    timeout_milliseconds := 30000
  );
end $$;

-- Internal-only: invoked by the SECURITY DEFINER emitter. A client must never
-- be able to fire arbitrary push fan-outs.
revoke execute on function public.enqueue_submission_push(uuid) from public, anon, authenticated;


-- ─── Part 4: shared emitter (§3) ──────────────────────────────────────
-- SECURITY DEFINER so it can read stores/profiles + insert notifications
-- regardless of the submitter's RLS. Exception-safe: a notification failure
-- MUST NOT roll back the user's submission (notifications are a side-channel,
-- not part of the submission's durability contract). An inner BEGIN/EXCEPTION
-- turns any failure — table error, push-enqueue error — into a WARNING.
create or replace function public.emit_submission_notification(
  p_type text, p_store_id uuid, p_actor uuid, p_source_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand      uuid;
  v_store_name text;
  v_actor_name text;
  v_new_id     uuid;
begin
  begin
    select s.brand_id, s.name into v_brand, v_store_name
      from public.stores s where s.id = p_store_id;
    if v_brand is null then return; end if;          -- storeless / brandless → skip

    select coalesce(p.username, p.name) into v_actor_name
      from public.profiles p where p.id = p_actor;

    insert into public.notifications
      (brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name)
    values (v_brand, p_store_id, p_actor, p_type, p_source_id, v_actor_name, v_store_name)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort
    end if;
  exception when others then
    raise warning 'emit_submission_notification failed (%/%): %', p_type, p_source_id, sqlerrm;
  end;
end $$;

revoke execute on function public.emit_submission_notification(text, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 5: trigger functions + triggers (§3) ────────────────────────
-- Each trigger function is SECURITY DEFINER (owned by postgres) so it can
-- call the internal emitter — whose EXECUTE is revoked from client roles —
-- regardless of the submitting role's privileges. Trigger firing does not
-- check EXECUTE on the trigger function itself, so revoking it from clients
-- is a harmless belt.

-- eod: AFTER INSERT WHEN status='submitted'.
create or replace function public.tg_notify_eod_submission()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_submission_notification('eod', new.store_id, new.submitted_by, new.id);
  return null;
end $$;
revoke execute on function public.tg_notify_eod_submission() from public, anon, authenticated;

drop trigger if exists notify_eod_submission on public.eod_submissions;
create trigger notify_eod_submission
  after insert on public.eod_submissions
  for each row when (new.status = 'submitted')
  execute function public.tg_notify_eod_submission();

-- weekly: AFTER INSERT WHEN kind='weekly' (filter is critical — the table is
-- shared with spot/open/mid_shift/close counts).
create or replace function public.tg_notify_weekly_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_submission_notification('weekly', new.store_id, new.submitted_by, new.id);
  return null;
end $$;
revoke execute on function public.tg_notify_weekly_count() from public, anon, authenticated;

drop trigger if exists notify_weekly_count on public.inventory_counts;
create trigger notify_weekly_count
  after insert on public.inventory_counts
  for each row when (new.kind = 'weekly')
  execute function public.tg_notify_weekly_count();

-- waste: AFTER INSERT (every waste_log row is a submission).
create or replace function public.tg_notify_waste_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_submission_notification('waste', new.store_id, new.logged_by, new.id);
  return null;
end $$;
revoke execute on function public.tg_notify_waste_log() from public, anon, authenticated;

drop trigger if exists notify_waste_log on public.waste_log;
create trigger notify_waste_log
  after insert on public.waste_log
  for each row
  execute function public.tg_notify_waste_log();

-- po + receiving: ONE function on purchase_orders handling both transitions.
-- Fires on INSERT (a PO born directly at the target status) OR UPDATE (a
-- status transition INTO the target). The distinct-from guard prevents a
-- no-op UPDATE (or an UPDATE that leaves status unchanged) from re-firing;
-- the (type, source_id) unique index is the belt over that.
--   INTO 'sent'                → 'po'        (actor = created_by)
--   INTO 'partial' | 'received'→ 'receiving' (actor = received_by)
create or replace function public.tg_notify_purchase_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- po: transition INTO 'sent'
  if new.status = 'sent'
     and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    perform public.emit_submission_notification('po', new.store_id, new.created_by, new.id);
  end if;

  -- receiving: transition INTO 'partial' | 'received'. The first receive
  -- (→ partial) inserts the row; a later → received hits the (type,source_id)
  -- conflict and no-ops => one 'receiving' notification per PO.
  if new.status in ('partial', 'received')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.emit_submission_notification('receiving', new.store_id, new.received_by, new.id);
  end if;

  return null;
end $$;
revoke execute on function public.tg_notify_purchase_order() from public, anon, authenticated;

drop trigger if exists notify_purchase_order on public.purchase_orders;
create trigger notify_purchase_order
  after insert or update on public.purchase_orders
  for each row
  execute function public.tg_notify_purchase_order();


-- ─── Part 6: read RPCs (§5) ───────────────────────────────────────────
-- SECURITY INVOKER so the notifications SELECT policy does the brand/privilege
-- clipping inside the function (no service-role bypass). The window (last 30d)
-- mirrors the db.ts feed cap.

-- Badge count: notifications visible under RLS in the window with no read row
-- for auth.uid().
create or replace function public.unread_notification_count()
returns integer
language sql
security invoker
set search_path = public
as $$
  select count(*)::integer
    from public.notifications n
   where n.created_at > now() - interval '30 days'
     and not exists (
       select 1 from public.notification_reads r
        where r.notification_id = n.id and r.user_id = auth.uid()
     );
$$;

revoke execute on function public.unread_notification_count() from public, anon;
grant  execute on function public.unread_notification_count() to authenticated;

-- Mark all currently-scoped unread as read for the caller. Inserts
-- (id, auth.uid()) for every RLS-visible unread notification in the window.
-- Idempotent via the PK conflict. Returns rows newly marked.
create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  with inserted as (
    insert into public.notification_reads (notification_id, user_id)
    select n.id, auth.uid()
      from public.notifications n
     where n.created_at > now() - interval '30 days'
       and not exists (
         select 1 from public.notification_reads r
          where r.notification_id = n.id and r.user_id = auth.uid()
       )
    on conflict (notification_id, user_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;
  return v_count;
end $$;

revoke execute on function public.mark_all_notifications_read() from public, anon;
grant  execute on function public.mark_all_notifications_read() to authenticated;


-- ─── Part 7: realtime publication (§7) ────────────────────────────────
-- The bell subscribes to a notifications-{brandId} channel; the table must be
-- in the supabase_realtime publication. LOCAL: after applying this migration,
-- `docker restart supabase_realtime_imr-inventory` to re-snapshot the
-- replication slot (CLAUDE.md / MEMORY.md realtime gotcha). PROD's managed
-- realtime re-snapshots on publication change automatically.
-- notification_reads is intentionally NOT published — a viewer's own read
-- writes are reflected optimistically; publishing them would just replay the
-- viewer's own mark-reads back to them.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
