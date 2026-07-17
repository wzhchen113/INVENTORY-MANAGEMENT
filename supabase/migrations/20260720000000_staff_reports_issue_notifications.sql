-- ============================================================
-- Spec 126 — Staff "Report an issue" → admin notification bell ('issue' type)
--
-- Additive, non-destructive migration extending the spec-120
-- (20260715000000_submission_notifications.sql) / spec-121
-- (20260716000000_missed_eod_notification_type.sql) notification system with:
--   • a new durable table `public.staff_reports` (future inbox; RLS admin-read
--     only, no client write policy);
--   • two nullable general-purpose columns on `public.notifications`:
--     `body` (free-text) + `category` (bell badge token);
--   • a widened `notifications_type_check` adding 'issue';
--   • `public.submit_staff_report(...)` — a SECURITY DEFINER RPC that derives
--     brand/store/reporter server-side, gates on auth_can_see_store, writes the
--     report, then emits the 'issue' notification (exception-safe) + best-effort
--     push enqueue. The single forgery-proof write path.
--
-- Latest migration on disk is 20260719000000 — 20260720000000 is strictly after
-- it, no collision.
--
-- NO realtime publication change: public.notifications is already in the
-- supabase_realtime publication (spec 120 Part 7). Adding a new row *type* AND
-- new nullable columns to an already-published table changes NO publication
-- membership, so there is NO `docker restart supabase_realtime_imr-inventory`
-- step for this migration.
--
-- Design authority: specs/126-staff-settings-page.md "## Backend design".
-- ============================================================


-- ─── Part 1: widen notifications.type CHECK to add 'issue' (§1) ────────
-- Drop (defensively) then re-add under the same auto-generated name with
-- 'issue' appended. All existing rows use the legacy values and remain valid;
-- additive-only. Mirrors spec 121's drop/re-add pattern.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue'));


-- ─── Part 2: additive nullable columns on notifications (§1) ──────────
-- Both nullable + general-purpose. Existing rows keep NULL and stay valid; no
-- backfill. `body` is the first free-text notification payload (reusable by any
-- future free-text type); `category` is a bounded badge token (only set for
-- 'issue' today; no CHECK here — the source-of-truth CHECK lives on
-- staff_reports.category).
alter table public.notifications
  add column if not exists body     text;
alter table public.notifications
  add column if not exists category text;


-- ─── Part 3: durable report table (§1) ────────────────────────────────
-- Keeps a future admin "issues inbox" cheap without overloading notifications.
-- brand_id/store_id/reporter are derived server-side by the RPC (never client
-- trusted); reporter_name + store_name are denormalized at insert like the
-- spec-120 emitter. status defaults 'open' (no workflow in v1).
create table if not exists public.staff_reports (
  id                uuid primary key default gen_random_uuid(),  -- also the notification source_id
  brand_id          uuid not null references public.brands(id)   on delete cascade,
  store_id          uuid not null references public.stores(id)   on delete cascade,
  reporter_user_id  uuid          references public.profiles(id) on delete set null,
  reporter_name     text,                          -- DENORMALIZED (coalesce(username, name))
  store_name        text,                          -- DENORMALIZED
  category          text not null check (category in ('equipment','inventory','app_tech','other')),
  message           text not null check (char_length(message) between 1 and 2000),
  status            text not null default 'open',
  created_at        timestamptz not null default now()
);

-- Future inbox feed: newest-first, brand-scoped window scan. Mirrors
-- notifications_brand_created_idx.
create index if not exists staff_reports_brand_created_idx
  on public.staff_reports (brand_id, created_at desc);


-- ─── Part 4: RLS on staff_reports (§2) ────────────────────────────────
-- Client writes go ONLY through the SECURITY DEFINER RPC (table owner, bypasses
-- RLS), so there is NO client INSERT/UPDATE/DELETE policy => default-deny for
-- writes. One SELECT policy for the future inbox + admin reachability, mirroring
-- the notifications read policy EXACTLY.
--
-- The privileged conjunct is LOAD-BEARING: a same-brand staff `user` row carries
-- a real brand_id, so auth_can_see_brand() alone would return TRUE for them.
-- Staff are reporters, not readers — auth_is_privileged() denies them at the DB.
-- super_admin: auth_can_see_brand short-circuits TRUE => all brands.
-- Single permissive SELECT policy; predicate is not trivially-wide ⇒ passes the
-- spec-053 permissive-policy lint with no allowlist edit.
alter table public.staff_reports enable row level security;

create policy "privileged_brand_read_staff_reports"
  on public.staff_reports for select
  using (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));

-- Grants: spec-097 posture. Inherits ALTER DEFAULT PRIVILEGES grants from
-- 20260618000000; RLS is the gate, not the grant layer. Do NOT revoke from
-- anon/authenticated (would trip the spec-097 grant lint).


-- ─── Part 5: submit_staff_report RPC (§ API contract) ─────────────────
-- SECURITY DEFINER so it derives brand/store/reporter from trusted rows and
-- emits the admin notification in ONE forgery-proof place. Staff never INSERT
-- staff_reports or notifications directly.
--
-- Order of operations:
--   1. Top gate: auth_can_see_store(p_store_id) — fires FIRST, before any write
--      (same discipline as the receiving RPCs). Cross-store/other-brand attempt
--      → 42501 (PostgREST → HTTP 403).
--   2. Validate category ∈ CHECK set and 1 ≤ len(trim(message)) ≤ 2000, else
--      22023 (PostgREST → HTTP 400).
--   3. Derive brand_id + store_name from stores; reporter_name from
--      profiles(auth.uid()). Guard brandless store.
--   4. INSERT the durable staff_reports row (atomic, the source of truth).
--   5. Best-effort notification wrapped in an inner begin/exception (a notify
--      failure MUST NOT roll back the report — same principle as
--      emit_submission_notification) + best-effort push enqueue.
--   6. Return the report id.
create or replace function public.submit_staff_report(
  p_store_id uuid,
  p_category text,
  p_message  text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand         uuid;
  v_store_name    text;
  v_reporter_name text;
  v_message       text;
  v_report_id     uuid;
  v_new_id        uuid;
begin
  -- (1) top-of-function visibility gate — before any write.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'not authorized to report for this store'
      using errcode = '42501';
  end if;

  -- (2) input validation.
  if p_category is null
     or p_category not in ('equipment','inventory','app_tech','other') then
    raise exception 'invalid report category: %', p_category
      using errcode = '22023';
  end if;

  v_message := trim(coalesce(p_message, ''));
  if char_length(v_message) < 1 or char_length(v_message) > 2000 then
    raise exception 'report message must be between 1 and 2000 characters'
      using errcode = '22023';
  end if;

  -- (3) derive trusted brand/store/reporter server-side.
  select s.brand_id, s.name into v_brand, v_store_name
    from public.stores s where s.id = p_store_id;
  if v_brand is null then
    raise exception 'store % has no brand', p_store_id
      using errcode = '22023';
  end if;

  select coalesce(p.username, p.name) into v_reporter_name
    from public.profiles p where p.id = auth.uid();

  -- (4) durable, atomic report insert.
  insert into public.staff_reports
    (brand_id, store_id, reporter_user_id, reporter_name, store_name, category, message)
  values
    (v_brand, p_store_id, auth.uid(), v_reporter_name, v_store_name, p_category, v_message)
  returning id into v_report_id;

  -- (5) best-effort notification side-channel — a notify failure MUST NOT roll
  -- back the report. source_id = the report id (distinct per report; the
  -- (type, source_id) dedup spine is satisfied for free).
  begin
    insert into public.notifications
      (brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name, category, body)
    values
      (v_brand, p_store_id, auth.uid(), 'issue', v_report_id, v_reporter_name, v_store_name, p_category, v_message)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort push
    end if;
  exception when others then
    raise warning 'submit_staff_report notify failed (report %): %', v_report_id, sqlerrm;
  end;

  return v_report_id;
end $$;

-- The reporter is the caller (a legitimate user-invoked op), so unlike the
-- internal emit_* helpers this GRANTS execute to authenticated. Anon/public are
-- revoked (staff sign in as authenticated).
revoke execute on function public.submit_staff_report(uuid, text, text) from public, anon;
grant  execute on function public.submit_staff_report(uuid, text, text) to authenticated;
