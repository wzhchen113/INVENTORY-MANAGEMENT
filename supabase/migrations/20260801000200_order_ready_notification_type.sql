-- ============================================================
-- Spec 149 (§1.3) — the 'order_ready' notification type: CHECK widening, the
-- cheap below-par emit predicate, the thin sibling emitter, and the
-- tg_notify_eod_submission() branch that makes 'order_ready' REPLACE the
-- routine spec-120 'eod' notification for an order-configured vendor (R-1 /
-- AC-3).
--
-- ADDITIVE + NON-DESTRUCTIVE. No new table, no new column, no new index, no
-- policy change, and NO realtime publication change — public.notifications is
-- already in the supabase_realtime publication (spec 120 Part 7), so adding a
-- new row *type* requires no publication edit and therefore NO
-- `docker restart supabase_realtime_imr-inventory` ritual (R-5).
--
-- THIRD (last) of the spec-149 dependency chain — depends on
-- 20260801000000_vendor_order_channel.sql (vendor_order_channel) and, for the
-- overall feature, on 20260801000100_order_approvals.sql.
--
-- The `notify_eod_submission` TRIGGER itself is UNCHANGED (still
-- `after insert on public.eod_submissions for each row when (new.status =
-- 'submitted')`). Only the trigger FUNCTION body branches. Because the branch
-- is exclusive and the trigger is INSERT-only, exactly ONE notification fires
-- per submission (AC-3), deduped by notifications_type_source_uidx on
-- (type, source_id) (AC-2).
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20260801000200' into
-- supabase_migrations.schema_migrations, then VERIFY the widened CHECK by
-- pg_get_constraintdef and all three functions by NORMALIZED-MD5.
--
-- Design authority: specs/149-eod-approve-order-pipeline.md "## Backend design"
-- §1.3 (+ R-1, R-2, §3.3 emit-predicate divergence).
-- ============================================================

begin;

-- ─── Part 1: widen notifications.type CHECK to add 'order_ready' (AC-1) ───
-- Drop (defensively) then re-add under the same auto-generated name with
-- 'order_ready' appended. All EIGHT legacy values are preserved verbatim, so
-- every existing row stays valid; additive-only. Mirrors the spec-121 and
-- spec-126 drop/re-add pattern exactly.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue','order_ready'));


-- ─── Part 2: the cheap below-par emit predicate (R-2, AC-2, §3.3) ─────────
-- DELIBERATE, DOCUMENTED DIVERGENCE from AC-2's literal wording. AC-2 says the
-- emit fires when the vendor "resolves to a non-empty server-computed suggested
-- order". Running report_reorder_list inside the EOD submit trigger would put a
-- recursive recipe-graph walk + a 7-day POS aggregation on the STAFF SUBMIT
-- PATH — an unacceptable latency and failure-coupling regression on a surface
-- AC-REG-5 freezes.
--
-- This predicate is therefore an APPROXIMATION of the engine's `par_replacement`
-- arm (par_level − on_hand > 0) over the same item_vendors join, with no recipe
-- walk.
--
-- WHAT "on_hand" ACTUALLY IS HERE — read this before trusting the predicate
-- (post-review correction, backend-architect S-2; the design's original wording
-- claimed "never a false positive", which is NOT true):
--   notify_eod_submission is AFTER INSERT on public.eod_submissions, and
--   submit_staff_eod_* writes public.eod_entries (and bumps
--   inventory_items.current_stock) only AFTER the parent submission row lands.
--   At trigger time there are therefore NO entries for this submission, and the
--   predicate necessarily reads inventory_items.current_stock — the PRE-COUNT
--   on-hand. The design's `left join public.eod_entries` was inert on every real
--   path, so it has been DROPPED rather than left as a decoy that three
--   reviewers had to re-derive. Zero behavior change; p_submission_id is kept
--   for signature stability (see below).
--
-- Consequence, stated honestly — it approximates in BOTH directions:
--   • pre-count stock HIGHER than the counted remaining (the normal case, stock
--     depleted through the day) ⇒ UNDER-fires ⇒ degrades to the spec-120 'eod'
--     notification, which still pings the admin. Safe.
--   • pre-count stock LOWER than the counted remaining (an unrecorded receipt,
--     or a prior under-count corrected by tonight's count) ⇒ can FIRE when
--     report_reorder_list's par_replacement is ≤ 0 — a false positive. The
--     backstop is AC-13's empty-order state: the admin lands on the Approve
--     Order screen, the vendor is absent from reorderPayload.vendors, and the
--     primary action is disabled. Wrong notification COPY, never a wrong order.
-- Exactness is a follow-up spec (the async post-commit job §3.3 scoped out); it
-- is NOT needed sooner — see §3.3.
--
-- p_submission_id is now UNUSED in the body. It is retained deliberately: the
-- signature is the design's published one and the trigger call site passes it,
-- so dropping it would be a gratuitous contract change (same posture as
-- emit_order_ready's unused p_vendor_id). It is also the parameter a future
-- "make the entries actually participate" change would need.
--
-- SECURITY DEFINER: called from the SECURITY DEFINER trigger function so a
-- staff submitter needs no inventory/vendor read grant for the admin's
-- notification to fire. EXECUTE revoked from every client role — this is an
-- internal predicate, not a client surface.
create or replace function public.eod_vendor_has_below_par(
  p_store_id     uuid,
  p_vendor_id    uuid,
  p_submission_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.inventory_items ii
      join public.item_vendors iv
        on iv.item_id = ii.id and iv.vendor_id = p_vendor_id
     where ii.store_id = p_store_id
       and coalesce(ii.par_level, 0)
           - coalesce(ii.current_stock, 0) >= 0.001
  );
$$;

comment on function public.eod_vendor_has_below_par(uuid, uuid, uuid) is
  'spec 149 (R-2 / §3.3): the CHEAP emit-time "is there an order?" predicate — '
  'the report_reorder_list par_replacement arm only (par_level − on_hand > 0) '
  'over the same item_vendors join, NO recipe walk. IT IS AN APPROXIMATION IN '
  'BOTH DIRECTIONS: the trigger is AFTER INSERT on eod_submissions, so no '
  'eod_entries exist yet and on_hand is the PRE-COUNT '
  'inventory_items.current_stock. Under-fires when stock depleted through the '
  'day (degrades to the spec-120 ''eod'' notification); can over-fire after an '
  'unrecorded receipt, where AC-13''s empty-order state is the backstop. '
  'p_submission_id is unused (signature stability). Internal — EXECUTE revoked '
  'from all client roles.';

revoke execute on function public.eod_vendor_has_below_par(uuid, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 3: emit_order_ready — thin sibling emitter (§1.3.3) ─────────────
-- Mirrors emit_submission_notification / emit_missed_count: SECURITY DEFINER so
-- it can read stores/profiles and INSERT regardless of the submitter's RLS, and
-- wrapped in the same inner begin/exception-when-others → RAISE WARNING envelope
-- so a notification failure can NEVER roll back a staff submit (notifications
-- are a side-channel, not part of the submission's durability contract).
--
-- Unlike 'missed_eod', an 'order_ready' HAS an actor (the submitter), so
-- actor_name keeps its normal semantics (coalesce(username, name)) and
-- actor_user_id is populated — which is what makes the spec-120 fan-out exclude
-- the submitter from the push recipients. The VENDOR NAME rides `body`, the
-- spec-126 general-purpose free-text column explicitly documented as "reusable
-- by any future free-text type". `category` stays NULL.
--
-- p_vendor_id is accepted for call-site symmetry with emit_missed_count and to
-- keep the design's published signature; the vendor NAME (p_vendor_name) is
-- what gets denormalized, so the id itself is intentionally unused here.
create or replace function public.emit_order_ready(
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_vendor_name   text,
  p_actor         uuid,
  p_submission_id uuid
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
      (brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name, body)
    values
      (v_brand, p_store_id, p_actor, 'order_ready', p_submission_id,
       v_actor_name, v_store_name, p_vendor_name)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort
    end if;
  exception when others then
    raise warning 'emit_order_ready failed (%): %', p_submission_id, sqlerrm;
  end;
end $$;

comment on function public.emit_order_ready(uuid, uuid, text, uuid, uuid) is
  'spec 149 (§1.3, AC-2/AC-7): emit ONE ''order_ready'' notification for an EOD '
  'submission whose vendor has a non-empty suggested order. source_id is the '
  'eod_submissions.id (the AC-6 deep-link carrier); body carries the VENDOR NAME '
  '(spec-126 free-text slot reuse — no schema churn); actor_name/actor_user_id '
  'keep normal submitter semantics. Deduped by notifications_type_source_uidx. '
  'Exception-safe: a notify failure raises a WARNING, never rolls back the '
  'staff submit. Internal — EXECUTE revoked from all client roles.';

revoke execute on function public.emit_order_ready(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated;


-- ─── Part 4: branch tg_notify_eod_submission (R-1, AC-3) ──────────────────
-- The TRIGGER is untouched; only this function body changes.
--
-- R-1 / OQ-1: 'order_ready' REPLACES the routine spec-120 'eod' notification
-- when the vendor is order-configured AND the cheap below-par predicate is
-- true. Two pings for one event trains the admin to ignore the bell. The
-- branch is exclusive ⇒ exactly one notification per submission (AC-3).
--
-- "Order-configured" is DELIBERATELY PERMISSIVE: every vendor resolves to some
-- channel (worst case 'manual'), so this gate is effectively "vendor exists AND
-- has below-par items". That is intentional — a 'manual' vendor still benefits
-- from the review screen (AC-18). Restricting order_ready to non-'manual'
-- vendors would be a one-line predicate change; flagged, not built.
--
-- SECURITY-CONTEXT NOTE (deliberate, do NOT "fix"): vendor_order_channel is
-- SECURITY INVOKER and this trigger function is SECURITY DEFINER, so inside
-- here the invoker helper runs as the function owner and
-- brand_member_read_vendors does not clip it. That is the DESIRED behavior — a
-- staff submitter must not need vendor-read privileges to trigger the admin's
-- notification.
--
-- EXCEPTION ENVELOPE (implementation note): the two emit_* helpers each carry
-- their own begin/exception envelope, but the new predicate calls run in the
-- trigger body OUTSIDE them. The whole body is therefore wrapped in the same
-- envelope so the design's stated invariant — "a notify failure can never roll
-- back a staff submit" (§1.3.3), on a surface AC-REG-5 freezes — holds for the
-- predicate path too.
create or replace function public.tg_notify_eod_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.vendor_id is not null
       and public.vendor_order_channel(new.vendor_id) is not null   -- vendor exists
       and public.eod_vendor_has_below_par(new.store_id, new.vendor_id, new.id)
    then
      perform public.emit_order_ready(
        new.store_id,
        new.vendor_id,
        (select v.name from public.vendors v where v.id = new.vendor_id),
        new.submitted_by,
        new.id
      );
    else
      perform public.emit_submission_notification(
        'eod', new.store_id, new.submitted_by, new.id
      );
    end if;
  exception when others then
    raise warning 'tg_notify_eod_submission failed (%): %', new.id, sqlerrm;
  end;

  return null;
end $$;

comment on function public.tg_notify_eod_submission() is
  'spec 120 trigger function, BRANCHED by spec 149 (R-1 / AC-3): emits ONE '
  '''order_ready'' notification when the submission''s vendor exists AND '
  'eod_vendor_has_below_par() is true, otherwise the routine ''eod'' notification. '
  'Exclusive branch ⇒ never both for one submission. The notify_eod_submission '
  'TRIGGER itself is unchanged.';

revoke execute on function public.tg_notify_eod_submission()
  from public, anon, authenticated;

commit;
