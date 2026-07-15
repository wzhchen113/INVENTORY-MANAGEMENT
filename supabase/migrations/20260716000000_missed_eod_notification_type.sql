-- ============================================================
-- Spec 121 — Missed EOD count alerts (admin notification bell)
--
-- Additive, non-destructive migration extending the spec-120
-- (20260715000000_submission_notifications.sql) notification system with a
-- new TYPE, `missed_eod`, plus a thin sibling emitter. No new table, no new
-- column, no new index, and NO realtime publication change — public.notifications
-- is already in the supabase_realtime publication (spec 120 Part 7), so adding
-- a new row *type* requires no publication edit and therefore NO
-- `docker restart supabase_realtime_imr-inventory` ritual.
--
-- Design authority: specs/121-missed-eod-count-alerts.md "## Backend design"
-- (§1 data model, §3 deterministic source_id, §4 emitter).
-- ============================================================


-- ─── Part 1: widen the notifications.type CHECK (§1) ──────────────────
-- The constraint was created inline in the spec-120 create table, so Postgres
-- named it `notifications_type_check`. Drop (defensively) then re-add under the
-- same name with 'missed_eod' added. All existing rows use the legacy five
-- values and remain valid; additive-only.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod'));


-- ─── Part 2: thin sibling emitter — emit_missed_count (§4) ────────────
-- emit_submission_notification cannot be called directly for a miss: it
-- denormalizes actor_name from profiles(p_actor) (a profiles FK — a vendor id
-- can't ride there) and has no slot for the vendor name we want to display.
-- So this thin sibling mirrors the spec-120 emitter's exception-safe shape
-- (inner begin/exception when others → raise warning) so a miss-detection
-- failure NEVER breaks the cron run — notifications are a side-channel.
--
-- VENDOR-NAME DENORMALIZATION (deliberate slot reuse — not drift): a miss has
-- NO actor, so the scheduled vendor name is stored in the existing `actor_name`
-- display slot rather than adding a `vendor_name` column. Both consumers already
-- read actor_name (the bell's secondary line renders `actorName ?? unknownActor`;
-- the fanout body reads actor_name), so a miss row naturally displays
-- "<vendor> · 5m ago" in the bell and lets the push body read "<store> · <vendor>"
-- with zero schema churn. actor_user_id = NULL (no submitter to exclude).
--
-- SECURITY DEFINER (table owner) so it bypasses RLS to INSERT, exactly like
-- emit_submission_notification. EXECUTE revoked from public/anon/authenticated
-- so no client can forge a miss; service_role retains execute (revokes do not
-- touch it), which is what lets the cron call it.
create or replace function public.emit_missed_count(
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_vendor_name   text,
  p_business_date date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand      uuid;
  v_store_name text;
  v_source     uuid;
  v_new_id     uuid;
begin
  begin
    select s.brand_id, s.name into v_brand, v_store_name
      from public.stores s where s.id = p_store_id;
    if v_brand is null then return; end if;          -- storeless / brandless → skip

    -- Deterministic dedup key: a miss has no submission row to point at.
    -- Postgres casts a 32-hex md5 straight to uuid; no uuid-ossp needed.
    v_source := md5(
      p_store_id::text || '|' || p_business_date::text || '|' || p_vendor_id::text
    )::uuid;

    insert into public.notifications
      (brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name)
    values (v_brand, p_store_id, null, 'missed_eod', v_source, p_vendor_name, v_store_name)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort push
    end if;
  exception when others then
    raise warning 'emit_missed_count failed (%/%/%): %',
      p_store_id, p_vendor_id, p_business_date, sqlerrm;
  end;
end $$;

revoke execute on function public.emit_missed_count(uuid, uuid, text, date)
  from public, anon, authenticated;
