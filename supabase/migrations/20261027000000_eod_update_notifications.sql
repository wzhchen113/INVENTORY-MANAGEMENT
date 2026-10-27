-- ============================================================
-- Spec 180 — EOD submit/update pop-up for admins: the backend half.
--
-- What (design §1):
--
--   (a) public.notifications.submission_id — uuid NULL, no FK, no index.
--       Set ONLY on the new 'eod_update' rows (the eod_submissions.id the
--       edit applied to). On PG 17 a nullable add with no default is
--       metadata-only.
--
--   (b) notifications_type_check widened from 9 to 10 values: + 'eod_update'.
--       Same drop/re-add pattern as specs 121, 126, 149, 162.
--
--   (c) public.emit_eod_submit_notification(uuid, uuid, uuid, uuid) — the
--       "fresh EOD notification" branch EXTRACTED VERBATIM from
--       tg_notify_eod_submission (20260801000200 Part 4, spec 149), envelope
--       included. Single source of truth for the eod / order_ready choice,
--       used by both the INSERT trigger and the draft→submitted promotion.
--
--   (d) public.tg_notify_eod_submission() REDEFINED to a one-line call of
--       (c). Behaviour-identical: same actor (new.submitted_by), same branch.
--       The notify_eod_submission TRIGGER itself is NOT touched.
--
--   (e) public.emit_eod_update(uuid, uuid, uuid, uuid) — one 'eod_update' row
--       PER EDIT: source_id = gen_random_uuid() (a per-edit event id, so the
--       (type, source_id) unique index never collapses edits),
--       submission_id = the submission, body = vendor name, actor = editor.
--       Best-effort push, throttled by (f).
--
--   (f) public.eod_update_push_suppressed(uuid, uuid, uuid) — the 60 s
--       per-store edit-push throttle, split out so pgTAP can test it without
--       pg_net. Fresh-submit pushes are NEVER throttled (AC-12).
--
--   (g) public.tg_notify_eod_resubmission() + trigger notify_eod_resubmission
--       AFTER UPDATE OF status, submitted_at ... WHEN (new.status = 'submitted'):
--         (G) auth.uid() is null          → nothing (maintenance writes)
--         (E) old.status = 'submitted'    → emit_eod_update (edit)
--         (R) a fresh row already exists  → emit_eod_update (re-promotion
--                                           after submitted→draft; AC-11)
--         (P) otherwise (draft → submitted) → emit_eod_submit_notification
--                                           (a fresh, non-update row; AC-10)
--
-- An edit is ALWAYS 'eod_update', never re-classified as 'order_ready'
-- (design §1.3): at AFTER UPDATE time the below-par predicate can only see
-- the PREVIOUS count's on-hand, and keeping edits out of 'order_ready' keeps
-- the spec 149 approve-order pipeline structurally untouched (§1.8).
--
-- staff_submit_eod is NOT modified. eod_submissions.submitted_by semantics
-- and audit_log behaviour are unchanged.
--
-- RLS: NO policy change. eod_update rows are read through the existing
-- privileged_brand_read_notifications policy; permissive_policy_lint is
-- unaffected.
--
-- Grants: the new column rides the table-level grants from spec 097
-- (20260618000000_public_grants_explicit.sql); no column grant, no table
-- revoke. Every new function revokes EXECUTE from public, anon and
-- authenticated (internal-only, same posture as every spec 120/149/162
-- emitter). tg_notify_eod_submission keeps its signature, so `create or
-- replace` preserves its ACL; the revoke is re-emitted anyway as a belt.
--
-- Realtime: NONE. public.notifications is already in supabase_realtime
-- (spec 120 Part 7) and adding a column is not a membership change, so the
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- PROD-APPLY (design §9; owner approval required): deploy
-- submission-push-fanout FIRST (backward-compatible), then execute_sql this
-- body via the Supabase MCP, INSERT version '20261027000000' into
-- supabase_migrations.schema_migrations, then verify the CHECK by
-- pg_get_constraintdef, the trigger by pg_get_triggerdef and all five
-- functions by NORMALIZED-MD5. Apply off-peak (not 21:00-23:00 local).
--
-- Design authority: specs/180-eod-submit-admin-popup.md "## Backend design".
-- ============================================================

begin;

set local lock_timeout = '5s';


-- ─── Part 1: notifications.submission_id (design §1.2) ────────────────
alter table public.notifications
  add column if not exists submission_id uuid null;

comment on column public.notifications.submission_id is
  'spec 180: set ONLY on eod_update rows = the eod_submissions.id the edit '
  'applied to. For eod/order_ready rows the submission id is source_id. NULL '
  'on every other type. No FK (matches source_id''s no-FK convention).';


-- ─── Part 2: widen notifications.type CHECK with 'eod_update' ─────────
-- Drop (defensively) then re-add under the same auto-generated name. All NINE
-- current values (20260829000000 Part 3) are preserved verbatim, so every
-- existing row stays valid; additive-only.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue','order_ready','order_failed','eod_update'));


-- ─── Part 3: emit_eod_submit_notification — extracted fresh branch ────
-- The branch body of tg_notify_eod_submission from 20260801000200 Part 4,
-- VERBATIM, envelope included, with the NEW.* references bound to parameters:
--   new.id → p_submission_id, new.store_id → p_store_id,
--   new.vendor_id → p_vendor_id, new.submitted_by → p_actor.
-- See 20260801000200 Part 4 for the R-1 exclusive-branch rationale, the
-- permissive "order-configured" gate and the SECURITY-CONTEXT note on
-- vendor_order_channel (SECURITY INVOKER, run here as the definer — the
-- desired behaviour; do NOT "fix").
create or replace function public.emit_eod_submit_notification(
  p_submission_id uuid,
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_actor         uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if p_vendor_id is not null
       and public.vendor_order_channel(p_vendor_id) is not null   -- vendor exists
       and public.eod_vendor_has_below_par(p_store_id, p_vendor_id, p_submission_id)
    then
      perform public.emit_order_ready(
        p_store_id,
        p_vendor_id,
        (select v.name from public.vendors v where v.id = p_vendor_id),
        p_actor,
        p_submission_id
      );
    else
      perform public.emit_submission_notification(
        'eod', p_store_id, p_actor, p_submission_id
      );
    end if;
  exception when others then
    raise warning 'emit_eod_submit_notification failed (%): %', p_submission_id, sqlerrm;
  end;
end $$;

comment on function public.emit_eod_submit_notification(uuid, uuid, uuid, uuid) is
  'spec 180: the FRESH EOD notification, extracted verbatim from the spec 149 '
  'branch of tg_notify_eod_submission. Emits ONE ''order_ready'' when the vendor '
  'exists AND eod_vendor_has_below_par() is true, otherwise the routine ''eod''. '
  'source_id = the eod_submissions.id, deduped by notifications_type_source_uidx '
  '(exactly-once, AC-7/AC-11). Called by tg_notify_eod_submission (INSERT) and by '
  'tg_notify_eod_resubmission on a draft→submitted promotion. Exception-safe. '
  'Internal — EXECUTE revoked from all client roles.';

revoke execute on function public.emit_eod_submit_notification(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 4: tg_notify_eod_submission — now a thin wrapper ────────────
-- Behaviour-identical to 20260801000200 Part 4: same actor (new.submitted_by)
-- and the same exclusive branch, now living in emit_eod_submit_notification
-- (which carries the exception envelope). The notify_eod_submission TRIGGER
-- (AFTER INSERT ... WHEN (new.status = 'submitted')) is NOT touched.
create or replace function public.tg_notify_eod_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The exception envelope lives in the callee; keep this body argument-passing only.
  perform public.emit_eod_submit_notification(new.id, new.store_id, new.vendor_id, new.submitted_by);
  return null;
end $$;

comment on function public.tg_notify_eod_submission() is
  'spec 120 trigger function, BRANCHED by spec 149 (R-1 / AC-3): emits ONE '
  '''order_ready'' notification when the submission''s vendor exists AND '
  'eod_vendor_has_below_par() is true, otherwise the routine ''eod'' notification. '
  'Exclusive branch ⇒ never both for one submission. The notify_eod_submission '
  'TRIGGER itself is unchanged. spec 180: body extracted into '
  'emit_eod_submit_notification.';

revoke execute on function public.tg_notify_eod_submission()
  from public, anon, authenticated;


-- ─── Part 5: eod_update_push_suppressed — the 60 s edit-push throttle ─
-- TRUE when any EOD-family row (eod / order_ready / eod_update) other than
-- p_notification_id was created for the same brand + store in the last 60 s.
-- Mirrors the pop-up's 60 s grouping: an editing burst gives ~1 push per
-- minute per store, and "submitted then immediately corrected" gives one ping.
-- Rides notifications_brand_created_idx. SECURITY INVOKER — only ever called
-- from the SECURITY DEFINER emit_eod_update, so it runs as the owner there.
create or replace function public.eod_update_push_suppressed(
  p_brand_id        uuid,
  p_store_id        uuid,
  p_notification_id uuid
) returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.notifications n
     where n.brand_id = p_brand_id
       and n.store_id = p_store_id
       and n.type in ('eod', 'order_ready', 'eod_update')
       and n.created_at >= now() - interval '60 seconds'
       and n.id <> p_notification_id
  );
$$;

comment on function public.eod_update_push_suppressed(uuid, uuid, uuid) is
  'spec 180 (§4): the edit-push throttle. TRUE when another eod/order_ready/'
  'eod_update notification for the same brand+store was created in the last '
  '60 s, so emit_eod_update skips enqueue_submission_push. Fresh-submit pushes '
  'never consult it. Internal — EXECUTE revoked from all client roles.';

revoke execute on function public.eod_update_push_suppressed(uuid, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 6: emit_eod_update — one row per edit ───────────────────────
-- Same envelope and store→brand / actor-name resolution as emit_order_ready
-- (20260801000200 Part 3). source_id is a fresh per-edit event id, so the
-- (type, source_id) unique index never collapses two edits; the ON CONFLICT
-- clause can therefore never fire and is kept only for uniformity with every
-- other emitter. submission_id is the durable link back to the submission.
-- The VENDOR NAME rides `body` (the spec-126 free-text slot, as order_ready
-- already does). actor = the EDITOR, so the spec-120 fan-out never pushes the
-- editor about their own edit.
--
-- Switch-off if the owner says "no push for edits": delete the
-- `perform public.enqueue_submission_push(...)` arm below (design §4).
create or replace function public.emit_eod_update(
  p_submission_id uuid,
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_actor         uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand       uuid;
  v_store_name  text;
  v_actor_name  text;
  v_vendor_name text;
  v_new_id      uuid;
begin
  begin
    select s.brand_id, s.name into v_brand, v_store_name
      from public.stores s where s.id = p_store_id;
    if v_brand is null then return; end if;          -- storeless / brandless → skip

    select coalesce(p.username, p.name) into v_actor_name
      from public.profiles p where p.id = p_actor;

    -- Brand-checked (spec 180 review, security Low 3): this runs as definer, so
    -- never denormalize another brand's vendor name into this brand's row. A
    -- mismatched vendor leaves body NULL.
    select v.name into v_vendor_name
      from public.vendors v
     where v.id = p_vendor_id
       and v.brand_id = v_brand;

    insert into public.notifications
      (brand_id, store_id, actor_user_id, type, source_id, submission_id,
       actor_name, store_name, body)
    values
      (v_brand, p_store_id, p_actor, 'eod_update', gen_random_uuid(), p_submission_id,
       v_actor_name, v_store_name, v_vendor_name)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null
       and not public.eod_update_push_suppressed(v_brand, p_store_id, v_new_id)
    then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort
    end if;
  exception when others then
    raise warning 'emit_eod_update failed (%): %', p_submission_id, sqlerrm;
  end;
end $$;

comment on function public.emit_eod_update(uuid, uuid, uuid, uuid) is
  'spec 180 (AC-8/AC-9): emit ONE ''eod_update'' notification per edit of an '
  'EOD submission. source_id = gen_random_uuid() (per-edit event id, so N edits '
  'give N rows); submission_id = the eod_submissions.id; body = VENDOR NAME; '
  'actor_user_id/actor_name = the editor. Best-effort push unless '
  'eod_update_push_suppressed() (60 s per-store throttle). Exception-safe: a '
  'notify failure raises a WARNING, never rolls back the write. Internal — '
  'EXECUTE revoked from all client roles.';

revoke execute on function public.emit_eod_update(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 7: tg_notify_eod_resubmission + trigger (design §1.5) ───────
-- Fires on the ON CONFLICT DO UPDATE branch of BOTH write paths
-- (staff_submit_eod and the db.ts submitEODCount PostgREST upsert). On that
-- branch Postgres fires only UPDATE row triggers, never the INSERT trigger, so
-- notify_eod_submission and notify_eod_resubmission can never both fire for
-- one row.
--
--   (G) auth.uid() is null → every real EOD write carries a user JWT
--       (staff_submit_eod refuses callers without auth_can_see_store and is
--       revoked from service_role; db.ts uses the admin JWT; the old
--       service-role staff edge functions are HTTP 410 stubs). Maintenance
--       UPDATEs (MCP execute_sql, a backfill migration) carry no claims and
--       must never spam the bell. A future service-role EOD writer must
--       revisit this guard.
--   (E) old.status = 'submitted' → an edit of a submitted count.
--   (R) a fresh eod/order_ready row already exists for this submission → a
--       re-promotion after a submitted→draft demotion. AC-11 forbids a second
--       fresh row ('eod' then 'order_ready' are different types, so the unique
--       index alone would let both through) — treat it as an edit.
--   (P) otherwise → a draft (or NULL) → submitted promotion: a FRESH,
--       non-update eod/order_ready row (AC-10).
--
-- The actor is auth.uid() (AC-9): request.jwt.claims is a session GUC, so it
-- still reads the caller's claims inside this SECURITY DEFINER function.
-- Draft→draft and submitted→draft never reach here (WHEN clause).
create or replace function public.tg_notify_eod_resubmission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := auth.uid();
    if v_actor is null then                                  -- (G)
      return null;
    end if;

    if old.status = 'submitted' then                         -- (E)
      perform public.emit_eod_update(new.id, new.store_id, new.vendor_id, v_actor);
    elsif exists (
      select 1 from public.notifications n
       where n.source_id = new.id
         and n.type in ('eod', 'order_ready')
    ) then                                                   -- (R)
      perform public.emit_eod_update(new.id, new.store_id, new.vendor_id, v_actor);
    else                                                     -- (P)
      perform public.emit_eod_submit_notification(new.id, new.store_id, new.vendor_id, v_actor);
    end if;
  exception when others then
    raise warning 'tg_notify_eod_resubmission failed (%): %', new.id, sqlerrm;
  end;

  return null;
end $$;

comment on function public.tg_notify_eod_resubmission() is
  'spec 180 (AC-8/AC-9/AC-10/AC-11): AFTER UPDATE trigger function on '
  'eod_submissions WHEN new.status = ''submitted''. No claims → nothing; '
  'submitted→submitted edit → emit_eod_update; re-promotion of a submission '
  'that already has a fresh eod/order_ready row → emit_eod_update; '
  'draft→submitted → emit_eod_submit_notification (fresh). Actor = auth.uid(). '
  'Exception-safe.';

revoke execute on function public.tg_notify_eod_resubmission()
  from public, anon, authenticated;

-- Column-scoped (spec 180 review, architect M-2 / security Low 1): the trigger
-- fires only when `status` or `submitted_at` is a SET target. Both real write
-- paths name both (the RPC's `do update set status, submitted_at, …`; the
-- db.ts merge-duplicates upsert sets every supplied column). The FK
-- `on delete set null` action on submitted_by (20260527000000) sets ONLY
-- submitted_by, so a JWT-bearing profile delete can no longer fan out one
-- eod_update per submitted row.
drop trigger if exists notify_eod_resubmission on public.eod_submissions;
create trigger notify_eod_resubmission
  after update of status, submitted_at on public.eod_submissions
  for each row when (new.status = 'submitted')
  execute function public.tg_notify_eod_resubmission();

commit;
