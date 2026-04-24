-- ============================================================
-- Security fixes: RLS gaps + invitation lockdown + function hardening
-- ============================================================
-- 1. Enable RLS on vendor_reminder_log, order_schedule
-- 2. Lock invitations to admin-only; expose registration lookup via SECURITY DEFINER RPCs
-- 3. Tighten recipe_categories (SELECT authenticated, WRITE admin)
-- 4. Add admin SELECT on eod_reminder_log
-- 5. Pin search_path on helper functions
-- ============================================================

-- ─── vendor_reminder_log ─────────────────────────────────
alter table public.vendor_reminder_log enable row level security;

drop policy if exists "Admins can read vendor_reminder_log" on public.vendor_reminder_log;
create policy "Admins can read vendor_reminder_log"
  on public.vendor_reminder_log for select
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));
-- Writes: service_role (cron) bypasses RLS.

-- ─── order_schedule ──────────────────────────────────────
alter table public.order_schedule enable row level security;

drop policy if exists "Store members can read order_schedule" on public.order_schedule;
create policy "Store members can read order_schedule"
  on public.order_schedule for select
  using (
    store_id in (select store_id from public.user_stores where user_id = auth.uid())
    or ((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))
  );

drop policy if exists "Admins can write order_schedule" on public.order_schedule;
create policy "Admins can write order_schedule"
  on public.order_schedule for all
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- ─── invitations ─────────────────────────────────────────
drop policy if exists "Anyone can read invitations by email" on public.invitations;
drop policy if exists "Authenticated users can insert invitations" on public.invitations;
drop policy if exists "Authenticated users can update invitations" on public.invitations;

create policy "Admins can read invitations"
  on public.invitations for select
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

create policy "Admins can insert invitations"
  on public.invitations for insert
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

create policy "Admins can update invitations"
  on public.invitations for update
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

create policy "Admins can delete invitations"
  on public.invitations for delete
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- Anon-callable lookup used by registerInvitedUser (fetches exactly one row
-- for the supplied email — filters expired / used rows out).
create or replace function public.get_pending_invitation(p_email text)
returns table (
  id uuid,
  email text,
  name text,
  role text,
  store_ids text[],
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, email, name, role, store_ids, expires_at
    from public.invitations
   where email = lower(p_email)
     and used = false
     and (expires_at is null or expires_at > now())
   limit 1;
$$;

grant execute on function public.get_pending_invitation(text) to anon, authenticated;

-- Marks the invitation used after the caller has completed auth.signUp.
-- Caller must be freshly authenticated (auth.uid() present) and must know both
-- the invitation id and its email — prevents anon drive-by invalidation.
create or replace function public.consume_invitation(p_invitation_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if auth.uid() is null then
    return false;
  end if;
  update public.invitations
     set used = true
   where id = p_invitation_id
     and lower(email) = lower(p_email)
     and used = false
     and (expires_at is null or expires_at > now());
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

grant execute on function public.consume_invitation(uuid, text) to authenticated;

-- ─── recipe_categories ───────────────────────────────────
drop policy if exists "Anyone can manage categories" on public.recipe_categories;

create policy "Authenticated can read categories"
  on public.recipe_categories for select
  using (auth.uid() is not null);

create policy "Admins can write categories"
  on public.recipe_categories for all
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- ─── eod_reminder_log ────────────────────────────────────
drop policy if exists "Admins can read eod_reminder_log" on public.eod_reminder_log;
create policy "Admins can read eod_reminder_log"
  on public.eod_reminder_log for select
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- ─── Pin search_path on helper functions ─────────────────
alter function public.update_updated_at() set search_path = public;
alter function public.generate_po_number() set search_path = public;
alter function public.sync_role_to_app_metadata() set search_path = public;

-- ─── eod-reminder-cron shared-bearer auth ────────────────
-- pg_cron does not sign JWTs, so the previous `verify_jwt: true` + role check
-- broke the schedule with "Missing authorization header". We instead store a
-- random bearer in a service_role-only table and verify it inside the function.
create table if not exists public._edge_auth (
  name   text primary key,
  value  text not null,
  created_at timestamptz default now()
);
alter table public._edge_auth enable row level security;

insert into public._edge_auth (name, value)
select 'cron_bearer', encode(extensions.gen_random_bytes(32), 'hex')
where not exists (select 1 from public._edge_auth where name = 'cron_bearer');

do $$
begin
  if exists (select 1 from cron.job where jobname = 'eod-reminder-cron') then
    perform cron.unschedule('eod-reminder-cron');
  end if;
end $$;

select cron.schedule(
  'eod-reminder-cron',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://ebwnovzzkwhsdxkpyjka.supabase.co/functions/v1/eod-reminder-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from public._edge_auth where name = 'cron_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);
