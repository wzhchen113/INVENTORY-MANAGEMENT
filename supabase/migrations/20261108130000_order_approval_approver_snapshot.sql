-- ============================================================
-- Spec 187 - keep the approver's name on an order approval after their profile
-- is deleted, and let profiles be deleted only through delete-user.
--
-- (1) order_approvals.approved_by_name / approved_by_email / approved_by_id:
--     server-written snapshot of the approver. approved_by_id has no foreign key,
--     so it keeps the approver's id after the profile is deleted and matches
--     detail.target_id on the 'User deleted' audit row. The name is stored
--     trimmed, and a blank name falls back to the email.
--     tg_order_approvals_stamp_approver (BEFORE INSERT, SECURITY DEFINER)
--     overwrites any client value. For an API caller (non-NULL auth.uid()) it
--     also requires status 'pending' and a privileged profiles.role (admin,
--     master or super_admin), before it reads the snapshot (release re-proposal
--     M-R1). postgres and service_role with no claims skip that check.
-- (2) tg_order_approvals_guard: approved_by may also move to auth.uid() while the
--     row is pending, and that re-stamp also writes the snapshot and approved_at.
--     Any other change to the snapshot or approved_at is refused. pending ->
--     approved with no approver is refused. The FK's SET NULL still passes and
--     leaves the snapshot alone.
--     Who may change a pending row (amendment A1): for an API caller (non-NULL
--     auth.uid()), a re-stamp or a change to status, lines, line_count,
--     est_total_cost, channel, external_ref, external_ref_expires_at or
--     ordered_at on a pending row needs (in this order) a non-NULL approver, a
--     privileged profiles.role (admin, master or super_admin, read as the owner,
--     not the JWT claim), and the caller to be that approver. So external_ref is
--     approver-only while pending. Refused, never auto re-stamped. postgres and
--     service_role with no claims skip the rule.
-- (3) create_order_approval: both pending branches stamp the caller. Approved and
--     ordered rows are still returned with no write (R-6).
-- (4) "Admins can delete profiles" is dropped. Table grants stay, so a direct
--     delete removes 0 rows with no error. profiles_self_delete_lock stays as a
--     backstop. delete-user's brand gate (spec 043) is now the only brand scoping
--     on the delete path.
-- (5) 'User deleted' joins spec 170's two restrictive audit_log policies, ahead
--     of delete-user writing those rows. Deploy delete-user AFTER this migration:
--     the rows carry an email and staff would otherwise be able to read them.
--
-- The new columns are nullable with no default, so no table rewrite and no
-- backfill (prod has 0 approvals; check again before applying, see below).
--
-- No publication change, so NO `docker restart supabase_realtime_imr-inventory`
-- step. order_approvals and audit_log are not in supabase_realtime.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): follow "Prod apply" and "Prod-apply
-- additions" in specs/187-order-approval-approver-snapshot.md. STOP if
-- order_approvals has any rows. execute_sql this body via the Supabase MCP BEFORE
-- pushing, INSERT the exact version '20261108130000' into
-- supabase_migrations.schema_migrations, and VERIFY the guard, the RPC and the new
-- trigger function by NORMALIZED-MD5 against local, plus prosecdef, proconfig,
-- owner and proacl.
--
-- ROLLBACK: forward migration only, see "Rollback" in the spec. Do NOT restore the
-- two audit_log policies: that would show staff the 'User deleted' rows already
-- written.
--
-- Tests: supabase/tests/order_approvals_approver_snapshot.test.sql,
--        supabase/tests/audit_log_rls_hardening.test.sql (UD-1..UD-7),
--        scripts/smoke-delete-user.sh
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (1) The snapshot columns and the INSERT trigger ───────────────────────
alter table public.order_approvals
  add column approved_by_name  text,
  add column approved_by_email text,
  add column approved_by_id    uuid;

comment on column public.order_approvals.approved_by_name is
  'spec 187: profiles.name of approved_by, trimmed; a blank name falls back to approved_by_email. Written only by the server (tg_order_approvals_stamp_approver on INSERT, tg_order_approvals_guard on a re-stamp). Stays after the profile is deleted, when approved_by goes NULL.';

comment on column public.order_approvals.approved_by_email is
  'spec 187: auth.users.email of approved_by, trimmed, NULL if blank. Written only by the server (tg_order_approvals_stamp_approver on INSERT, tg_order_approvals_guard on a re-stamp). Stays after the profile is deleted, when approved_by goes NULL.';

comment on column public.order_approvals.approved_by_id is
  'spec 187: the id of approved_by at the stamp. Written only by the server (tg_order_approvals_stamp_approver on INSERT, tg_order_approvals_guard on a re-stamp). No foreign key on purpose, so it survives the profile delete. Matches detail.target_id on the ''User deleted'' audit_log row.';

-- SECURITY DEFINER because an API caller can't read auth.users. An INSERT naming
-- someone else as approved_by reads their email into NEW, then fails
-- privileged_store_insert_order_approvals with 42501, and that error carries no
-- row data. All three columns are assigned on every path: a NULL approved_by or a
-- missing row gives NULL, and a client value never survives.
-- The snapshot block below is textually identical to the one in the guard's
-- re-stamp branch. Keep them that way.
--
-- Who may insert (spec 187, release re-proposal M-R1). For an API caller (non-NULL
-- auth.uid()), the row must be inserted as 'pending', and the caller's own
-- profiles.role must be admin, master or super_admin, in that order. Without
-- this, a stale 'admin' JWT claim could insert a row that is already 'approved'
-- or 'ordered', which the guard's pending-row rule (UPDATE only) can't see. The
-- role read is the same inline exists as the guard's block (a0), with the same
-- message: it reads profiles.role, not the JWT claim, so don't swap in
-- auth_is_privileged() or auth_is_admin(). Both checks run before the snapshot
-- reads, so a refused insert never reads auth.users. postgres and service_role
-- with no claims skip them, which keeps owner-level fixes and fixtures working.
-- channel, the timestamps, line_count, est_total_cost, external_ref,
-- external_ref_expires_at and source_submission_id are still whatever the client
-- sends (audit L4 and re-audit L-R3, a follow-up). A trusted role
-- (service_role, postgres) that carries a user's sub claim counts as an API
-- caller and gets both checks.
create or replace function public.tg_order_approvals_stamp_approver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text;
  v_email text;
begin
  if v_uid is not null then
    if new.status is distinct from 'pending' then
      raise exception 'order approval must be inserted as pending' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.profiles p
                    where p.id = v_uid
                      and p.role in ('admin', 'master', 'super_admin')) then
      raise exception 'order approval caller is not an admin' using errcode = 'P0001';
    end if;
  end if;

  v_name  := (select p.name  from public.profiles p where p.id = new.approved_by);
  v_email := (select u.email from auth.users u      where u.id = new.approved_by);
  new.approved_by_id    := new.approved_by;
  new.approved_by_email := nullif(btrim(v_email), '');
  new.approved_by_name  := coalesce(nullif(btrim(v_name), ''), new.approved_by_email);
  return new;
end $$;

comment on function public.tg_order_approvals_stamp_approver() is
  'spec 187: BEFORE INSERT on public.order_approvals. For an API caller (non-NULL auth.uid()), raises P0001 ''order approval must be inserted as pending'' unless status is ''pending'', then ''order approval caller is not an admin'' unless the caller''s profiles.role is admin, master or super_admin. Then overwrites approved_by_id, approved_by_email and approved_by_name with the values for approved_by (the name trimmed, falling back to the email when blank), or NULL when there is none. Must stay SECURITY DEFINER with a fixed search_path (it reads profiles past the caller''s RLS, and auth.users).';

-- Required: 20260618000000 grants ALL on future functions by default.
revoke execute on function public.tg_order_approvals_stamp_approver() from public, anon, authenticated;

create trigger order_approvals_stamp_approver_trg
  before insert on public.order_approvals
  for each row execute function public.tg_order_approvals_stamp_approver();


-- ─── (2) The guard ─────────────────────────────────────────────────────────
create or replace function public.tg_order_approvals_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_restamp      boolean;
  v_pending_edit boolean;
  v_name         text;
  v_email        text;
begin
  -- Spec 187: is this write the caller taking over a still-pending row in their
  -- own name? That is the only way approved_by may move to a non-NULL value.
  -- This expression is never NULL. Do NOT write new.approved_by = auth.uid():
  -- with a NULL auth.uid() (postgres, service_role) that gives NULL, `not NULL`
  -- is NULL, and the refusal in (a2) is skipped.
  v_restamp := old.status = 'pending'
           and new.approved_by is not null
           and new.approved_by is distinct from old.approved_by
           and new.approved_by is not distinct from v_uid;

  -- Spec 187 (amendment A1): does this write change a client-writable column that
  -- no other block covers? Never NULL: every operand is IS DISTINCT FROM.
  -- approved_by is deliberately absent: its only legal moves are the re-stamp
  -- (checked below through v_restamp) and the FK's SET NULL, which must pass.
  v_pending_edit := new.status                  is distinct from old.status
                 or new.lines                   is distinct from old.lines
                 or new.line_count              is distinct from old.line_count
                 or new.est_total_cost          is distinct from old.est_total_cost
                 or new.channel                 is distinct from old.channel
                 or new.external_ref            is distinct from old.external_ref
                 or new.external_ref_expires_at is distinct from old.external_ref_expires_at
                 or new.ordered_at              is distinct from old.ordered_at;

  -- (a) always-immutable identity + provenance columns.
  if new.id                   is distinct from old.id
  or new.store_id             is distinct from old.store_id
  or new.vendor_id            is distinct from old.vendor_id
  or new.business_date        is distinct from old.business_date
  or new.created_at           is distinct from old.created_at then
    raise exception 'order approval is immutable' using errcode = 'P0001';
  end if;

  -- (a0) spec 187 (amendment A1, audit 187-H1 and 187-H2): who may change a
  -- pending row. Only for an API caller (non-NULL auth.uid()): postgres,
  -- service_role with no sub, owner-level fixes and the FK's SET NULL with no
  -- claims skip it. A write that changes only approved_by (the FK's SET NULL,
  -- even with claims set) is neither a re-stamp nor a pending edit, so it skips
  -- it too. Refused, never auto re-stamped: a late write from a previous approver
  -- must not silently claim lines another admin has just written.
  -- The role read runs as the function owner, past the caller's RLS, and reads
  -- profiles.role, not the JWT claim (the claim is what goes stale). Keep it
  -- inline; don't swap in auth_is_privileged() or auth_is_admin(). The set
  -- mirrors ADMIN_ROLES in the edge functions.
  if old.status = 'pending' and v_uid is not null
     and (v_restamp or v_pending_edit) then
    if new.approved_by is null then
      raise exception 'order approval has no approver' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.profiles p
                    where p.id = v_uid
                      and p.role in ('admin', 'master', 'super_admin')) then
      raise exception 'order approval caller is not an admin' using errcode = 'P0001';
    end if;
    if new.approved_by is distinct from v_uid then
      raise exception 'order approval belongs to another approver' using errcode = 'P0001';
    end if;
  end if;

  -- (a1) spec 187: who approved, and when. The server writes these on a re-stamp,
  -- so a client value in the same UPDATE is overwritten; every other write that
  -- changes them is refused. The FK's SET NULL changes approved_by only, so it
  -- passes here with the snapshot (including approved_by_id) and approved_at
  -- intact. approved_at moves only when the approver changes: a retry by the
  -- same approver keeps it.
  -- The snapshot block is textually identical to tg_order_approvals_stamp_approver's.
  if v_restamp then
    v_name  := (select p.name  from public.profiles p where p.id = new.approved_by);
    v_email := (select u.email from auth.users u      where u.id = new.approved_by);
    new.approved_by_id    := new.approved_by;
    new.approved_by_email := nullif(btrim(v_email), '');
    new.approved_by_name  := coalesce(nullif(btrim(v_name), ''), new.approved_by_email);
    new.approved_at       := now();
  elsif new.approved_at       is distinct from old.approved_at
     or new.approved_by_name  is distinct from old.approved_by_name
     or new.approved_by_email is distinct from old.approved_by_email
     or new.approved_by_id    is distinct from old.approved_by_id then
    raise exception 'order approval is immutable' using errcode = 'P0001';
  end if;

  -- (a2) spec 178: the two ON DELETE SET NULL pointers. Immutable too, except
  -- for the one move their foreign keys make: value -> NULL once the referenced
  -- row is gone. The FK action is an ordinary UPDATE and fires this trigger
  -- after the parent row is deleted, so the row is no longer visible here. While
  -- it still exists the move is a client-side scrub, and it is refused.
  -- Spec 187: approved_by may also take the re-stamp in v_restamp above.
  --
  -- These reads must run as the function owner. SECURITY INVOKER would apply the
  -- caller's RLS, a profile hidden from the caller would look deleted, and the
  -- scrub would pass. The profiles.role read in (a0) and the auth.users read in
  -- (a1) need definer too. Do NOT "fix" this function to invoker.
  if new.approved_by is distinct from old.approved_by
     and not v_restamp
     and not (new.approved_by is null
              and not exists (select 1 from public.profiles p
                               where p.id = old.approved_by)) then
    raise exception 'order approval is immutable' using errcode = 'P0001';
  end if;

  if new.source_submission_id is distinct from old.source_submission_id
     and not (new.source_submission_id is null
              and not exists (select 1 from public.eod_submissions s
                               where s.id = old.source_submission_id)) then
    raise exception 'order approval is immutable' using errcode = 'P0001';
  end if;

  -- (b) status transitions. A no-op (status unchanged) is always legal — the
  -- edge function's write-back sets status='approved' unconditionally and may
  -- land on an already-'approved' row (§5.3).
  if new.status is distinct from old.status then
    if not ((old.status = 'pending'  and new.status = 'approved')
         or (old.status = 'approved' and new.status = 'ordered')) then
      raise exception 'illegal order approval status transition: % -> %',
        old.status, new.status using errcode = 'P0001';
    end if;

    -- Spec 187: nobody accountable has approved these lines. approved -> ordered
    -- stays allowed: the approval already happened and the snapshot names the
    -- approver. create_order_approval re-stamps a pending row, so this can't wedge.
    -- (a0) already refuses this for an API caller; this check still covers a
    -- caller with a NULL auth.uid().
    if old.status = 'pending' and new.status = 'approved' and new.approved_by is null then
      raise exception 'order approval has no approver' using errcode = 'P0001';
    end if;
  end if;

  -- (c) the approved SNAPSHOT is mutable ONLY while still 'pending' (so a
  -- failed mint can be retried with corrected lines — the only write
  -- amplification this spec needs). Frozen the moment status leaves 'pending'.
  if old.status <> 'pending' then
    if new.lines          is distinct from old.lines
    or new.line_count     is distinct from old.line_count
    or new.est_total_cost is distinct from old.est_total_cost
    or new.channel        is distinct from old.channel then
      raise exception 'order approval snapshot is immutable once approved'
        using errcode = 'P0001';
    end if;

  else
    -- (c2) CHANNEL ESCALATION GUARD while still 'pending' (spec 149 post-review
    -- fix — security-auditor Medium 2). `channel` is a general-purpose
    -- PostgREST-writable column (db.advanceOrderApproval exposes it so the OQ-2
    -- retailer-unavailable fallback can re-route a pending row), and
    -- instacart-cart-link gates ONLY on the STORED channel — it never re-derives
    -- it from the vendor. Without a rule here, a privileged caller could PATCH
    -- channel='instacart' onto a pending row whose vendor resolves to
    -- 'extension'/'manual' and reach the IDP mint path, routing around the R-3
    -- precedence that keeps BJ's / Sam's on the live-tuned cart-filler. AC-14 /
    -- §1.2 step 3 promise the channel is SERVER-resolved; this makes that true
    -- for UPDATE as well as INSERT.
    --
    -- Two changes stay legal, and only these two:
    --   • DOWNWARD to 'extension' / 'manual' — the only values the shipped OQ-2
    --     fallback ever writes (useStore `runChannel`), and neither is a mint
    --     path; and
    --   • back to the SERVER-RESOLVED channel for this vendor — which is what
    --     create_order_approval's pending-retry path re-writes after a vendor
    --     config change. Refusing that would WEDGE the row permanently: there is
    --     no DELETE policy, so a pending row that can never be re-created is
    --     unrecoverable without psql.
    --
    -- vendor_order_channel() is SECURITY INVOKER and this trigger is SECURITY
    -- DEFINER, so the vendor read runs as the function owner and is not clipped
    -- by brand_member_read_vendors — the same deliberate posture as
    -- tg_notify_eod_submission (§1.3). Do NOT "fix" it to invoker.
    --
    -- Cost: the vendor lookup only runs when channel actually changed AND the
    -- new value is outside the downward set, i.e. never on the ordinary status
    -- advance or external_ref write.
    if new.channel is distinct from old.channel
       and new.channel not in ('extension', 'manual')
       and new.channel is distinct from public.vendor_order_channel(new.vendor_id) then
      raise exception 'order approval channel may not be changed to %', new.channel
        using errcode = 'P0001';
    end if;
  end if;

  -- (d) external reference: writable at 'pending' and 'approved' (OQ-6 re-open
  -- + expiry re-mint), frozen at 'ordered'.
  if old.status = 'ordered' then
    if new.external_ref            is distinct from old.external_ref
    or new.external_ref_expires_at is distinct from old.external_ref_expires_at then
      raise exception 'order approval external reference is frozen once ordered'
        using errcode = 'P0001';
    end if;
  end if;

  -- (e) auto-set.
  new.updated_at := now();
  if new.status = 'ordered' and old.status is distinct from 'ordered' then
    new.ordered_at := coalesce(new.ordered_at, now());
  end if;

  return new;
end $$;

comment on function public.tg_order_approvals_guard() is
  'spec 149 (AC-20): BEFORE UPDATE guard on public.order_approvals. Legal status '
  'moves are pending→approved, approved→ordered, and any no-op; anything else '
  'raises P0001 (⇒ HTTP 400). Spec 187: pending→approved with no approver raises '
  'P0001 too. Identity/provenance columns are always immutable, except that spec '
  '178 lets approved_by and source_submission_id move to NULL once the referenced '
  'row is gone (their ON DELETE SET NULL action), and spec 187 lets approved_by '
  'move to auth.uid() while ''pending''. That re-stamp also writes '
  'approved_by_id, approved_by_name, approved_by_email and approved_at, which are '
  'otherwise immutable. Spec 187 (amendment A1): for an API caller (non-NULL '
  'auth.uid()), a re-stamp or a change to status, lines, line_count, '
  'est_total_cost, channel, external_ref, external_ref_expires_at or ordered_at on '
  'a ''pending'' row raises P0001 ''order approval has no approver'' when '
  'approved_by is NULL, ''order approval caller is not an admin'' when the '
  'caller''s profiles.role is not admin, master or super_admin, and ''order '
  'approval belongs to another approver'' when approved_by is not the caller, in '
  'that order; so external_ref is approver-only while ''pending''. '
  'The line snapshot freezes once status leaves ''pending''; external_ref freezes '
  'at ''ordered''. While ''pending'', channel may only move DOWNWARD to '
  '''extension''/''manual'' or back to the server-resolved vendor_order_channel() — '
  'a pending row can never be PATCHed onto the ''instacart'' mint path. '
  'Auto-sets updated_at and ordered_at. Must stay SECURITY DEFINER: it reads '
  'profiles (including the caller''s role) past the caller''s RLS, and auth.users.';


-- ─── (3) create_order_approval ─────────────────────────────────────────────
-- Full body from 20260801000100, its only definition. Signature, return type,
-- INVOKER posture and grants are unchanged. The insert is unchanged: the trigger
-- stamps it.
-- SECURITY INVOKER: the caller's RLS does the real clipping on both the read
-- and the write; the explicit gates below exist for a clean, stable error
-- contract (and so the refusal happens BEFORE any write, mirroring the
-- submit_staff_report / get_extension_order_payload discipline).
--
-- Idempotent on (store_id, vendor_id, business_date):
--   • no row                       ⇒ INSERT at status='pending'
--   • existing row status='pending'⇒ UPDATE the snapshot and stamp the caller
--                                    as approver (retry path, spec 187)
--   • existing row approved/ordered⇒ NO WRITE, return the row verbatim (R-6).
--   • LOST RACE (concurrent insert of the same key ⇒ 23505) ⇒ re-read the
--     winner's row and fall through the same retry / R-6 logic, so a lost race
--     is indistinguishable from a plain replay (S-3).
--     The client branches on `status` and renders the already-actioned state
--     (AC-13). Approved and ordered rows are returned with no write.
create or replace function public.create_order_approval(
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_business_date date,
  p_lines         jsonb,
  p_submission_id uuid default null
) returns public.order_approvals
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_channel text;
  v_row     public.order_approvals;
  v_elem    jsonb;
  v_count   integer;
  v_est     numeric(12,4) := 0;
  v_qty     numeric;
  v_cost    numeric;
begin
  -- (1) TOP GATES — before any write.
  if p_store_id is null or p_vendor_id is null or p_business_date is null then
    raise exception 'invalid approval lines: store, vendor and business date are required'
      using errcode = '22023';
  end if;

  if not public.auth_can_see_store(p_store_id) then
    raise exception 'not authorized for this store' using errcode = '42501';
  end if;

  if not public.auth_is_privileged() then
    raise exception 'not authorized to approve orders' using errcode = '42501';
  end if;

  -- (2) VALIDATE p_lines — the server-side mirror of AC-27, so the DB path is
  --     as strict as the edge path. Every violation raises 22023 ⇒ HTTP 400.
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid approval lines: expected a json array'
      using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_lines);
  if v_count < 1 or v_count > 200 then
    raise exception 'invalid approval lines: expected 1..200 lines, got %', v_count
      using errcode = '22023';
  end if;

  for v_elem in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'invalid approval lines: every line must be an object'
        using errcode = '22023';
    end if;

    if nullif(btrim(coalesce(v_elem->>'item_id', '')), '') is null then
      raise exception 'invalid approval lines: item_id is required'
        using errcode = '22023';
    end if;
    begin
      perform (v_elem->>'item_id')::uuid;
    exception when others then
      raise exception 'invalid approval lines: item_id must be a uuid'
        using errcode = '22023';
    end;

    if char_length(btrim(coalesce(v_elem->>'item_name', ''))) not between 1 and 200 then
      raise exception 'invalid approval lines: item_name must be 1..200 characters'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_elem->'qty_base') <> 'number' then
      raise exception 'invalid approval lines: qty_base must be a number'
        using errcode = '22023';
    end if;
    v_qty := (v_elem->>'qty_base')::numeric;
    if v_qty <= 0 or v_qty > 100000 then
      raise exception 'invalid approval lines: qty_base must be > 0 and <= 100000'
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_elem->'cost_per_counted_unit') <> 'number' then
      raise exception 'invalid approval lines: cost_per_counted_unit must be a number'
        using errcode = '22023';
    end if;
    v_cost := (v_elem->>'cost_per_counted_unit')::numeric;
    if v_cost < 0 then
      raise exception 'invalid approval lines: cost_per_counted_unit must be >= 0'
        using errcode = '22023';
    end if;

    v_est := v_est + (v_qty * v_cost);
  end loop;

  -- (3) RESOLVE THE CHANNEL SERVER-SIDE (R-3). The client never supplies it.
  --     NULL ⇒ the vendor is missing or clipped by the caller's RLS ⇒ 404.
  v_channel := public.vendor_order_channel(p_vendor_id);
  if v_channel is null then
    raise exception 'vendor % not found', p_vendor_id using errcode = 'P0002';
  end if;

  -- (4) IDEMPOTENT UPSERT on (store_id, vendor_id, business_date).
  select * into v_row
    from public.order_approvals
   where store_id      = p_store_id
     and vendor_id     = p_vendor_id
     and business_date = p_business_date;

  if not found then
    -- RACE WINDOW (spec 149 post-review fix — backend-architect S-3). The
    -- select above and the insert below are two statements: a SECOND approver
    -- (two admin devices, or a retry racing its own in-flight predecessor) can
    -- commit the same (store_id, vendor_id, business_date) key in between. Both
    -- callers see `not found`; one wins the unique index and the LOSER would
    -- otherwise surface a raw 23505 ⇒ PostgREST 409 ⇒ a raw backend-error toast,
    -- because §3.2's contract has no 23505 row and the client has no branch for
    -- it (`approvalBusy` only guards a single device).
    --
    -- Design guidance 6 is "must not create two approval rows" AND "make the
    -- call safe to repeat". The unique index already gives the first half; this
    -- handler gives the second. The loser re-reads the winner's row and falls
    -- through the SAME retry / R-6 logic as the elsif branch below, so a lost
    -- race is indistinguishable from a plain replay.
    begin
      insert into public.order_approvals
        (store_id, vendor_id, business_date, approved_by, channel, status,
         lines, line_count, est_total_cost, source_submission_id)
      values
        (p_store_id, p_vendor_id, p_business_date, auth.uid(), v_channel, 'pending',
         p_lines, v_count, v_est, p_submission_id)
      returning * into v_row;

    exception when unique_violation then
      -- The winner's row is committed by now (READ COMMITTED gives this
      -- statement a fresh snapshot), so re-read it through the caller's RLS.
      select * into v_row
        from public.order_approvals
       where store_id      = p_store_id
         and vendor_id     = p_vendor_id
         and business_date = p_business_date;

      if not found then
        -- Not the idempotency key, then — some OTHER unique constraint fired.
        -- Do not swallow it: re-raise so the real cause is visible.
        raise;
      end if;

      if v_row.status = 'pending' then
        -- Spec 187: same stamp as the retry path below.
        update public.order_approvals
           set approved_by    = auth.uid(),
               lines          = p_lines,
               line_count     = v_count,
               est_total_cost = v_est,
               channel        = v_channel
         where id = v_row.id
        returning * into v_row;
      end if;
      -- status in ('approved','ordered') ⇒ return the winner's row verbatim (R-6).
    end;

  elsif v_row.status = 'pending' then
    -- Retry path: refresh the snapshot, leave status alone. Spec 187: the caller
    -- becomes the approver. The guard writes the name, email and approved_at when
    -- that changes who approved (this function is INVOKER and can't read the email).
    update public.order_approvals
       set approved_by    = auth.uid(),
           lines          = p_lines,
           line_count     = v_count,
           est_total_cost = v_est,
           channel        = v_channel
     where id = v_row.id
    returning * into v_row;
  end if;
  -- status in ('approved','ordered') ⇒ fall through with NO write (R-6).

  return v_row;
end $$;

comment on function public.create_order_approval(uuid, uuid, date, jsonb, uuid) is
  'spec 149 (§1.2 / §3.2, AC-19/AC-21/AC-27): the insert path the app uses for '
  'public.order_approvals. A direct INSERT is also possible under '
  'privileged_store_insert_order_approvals; the approver and the spec 187 snapshot '
  'are correct either way. SECURITY INVOKER with explicit top gates — 42501 when '
  'the store is not visible or the caller is not privileged, 22023 on invalid '
  'lines, P0002 when the vendor is missing/invisible. Resolves the channel '
  'server-side via vendor_order_channel() (the client never supplies it) and is '
  'idempotent on (store_id, vendor_id, business_date): pending rows are refreshed '
  'and stamped with the caller as approver (spec 187), '
  'approved/ordered rows are returned VERBATIM with no write (R-6). A CONCURRENT '
  'insert of the same key (23505) is caught and resolved by re-reading the '
  'winner''s row, so a lost race behaves exactly like a replay (S-3).';


-- ─── (4) Direct profile deletes ────────────────────────────────────────────
drop policy if exists "Admins can delete profiles" on public.profiles;


-- ─── (5) 'User deleted' joins the two restrictive audit_log policies ───────
-- ALTER, not drop and create: it keeps the name, the comment object and `as
-- restrictive`, so a slip can't turn a restrictive policy permissive.
alter policy "audit_log_restrict_select_store_user_actions" on public.audit_log
  using (
    action not in ('Store user created', 'Store user password set', 'User deleted')
    or public.auth_is_privileged()
  );

comment on policy "audit_log_restrict_select_store_user_actions" on public.audit_log is
  'spec 170: RESTRICTIVE (ANDs with store_member_read_audit_log). Store-user rows carry the target login username in item_ref (spec 167), and User deleted rows carry the target''s name and email (spec 187). Hidden from non-privileged callers per spec 095 anti-enumeration. Closes spec 167 security-auditor M2.';

alter policy "audit_log_restrict_insert_server_only_actions" on public.audit_log
  with check (
    action not in ('Store user created', 'Store user password set',
                   'Order missed', 'catalog_copy', 'User deleted')
  );

comment on policy "audit_log_restrict_insert_server_only_actions" on public.audit_log is
  'spec 170: RESTRICTIVE. These five actions are written only by SECURITY DEFINER RPCs (record_missed_orders_for_day, copy_catalog_rows) or service_role (manage-store-user, delete-user), all of which bypass RLS (owner/BYPASSRLS, no FORCE RLS). Any RLS-subject insert of them is a forgery. Extend this list when ''User invite'' moves server-side. Closes the forgery half of M3.';

commit;
