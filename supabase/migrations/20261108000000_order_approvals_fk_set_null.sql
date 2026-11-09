-- ============================================================
-- Spec 178 - let order_approvals' two ON DELETE SET NULL foreign keys fire past
-- tg_order_approvals_guard().
--
-- approved_by -> profiles and source_submission_id -> eod_submissions are both
-- ON DELETE SET NULL, and the guard treated both columns as always immutable.
-- The FK action is an ordinary UPDATE, so it fired the guard and failed the
-- delete with 'order approval is immutable'. Once an approval exists, that
-- breaks delete-user for anyone who approved an order, and any server-side
-- delete of a linked EOD submission.
--
-- The only behaviour change: each pointer may now move value -> NULL when the
-- row it references no longer exists. Every other change to either column is
-- still refused, and the rest of the function body is unchanged.
--
-- CREATE OR REPLACE of one function plus its comment. No table, column, index,
-- constraint, policy, trigger, grant or publication change, so NO
-- `docker restart supabase_realtime_imr-inventory` step. The trigger and the
-- function's REVOKE from 20260801000100 carry over.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP BEFORE pushing, INSERT the exact version '20261108000000' into
-- supabase_migrations.schema_migrations, and VERIFY the function by NORMALIZED-MD5
-- against local.
--
-- Tests: supabase/tests/order_approvals_fk_set_null.test.sql
-- ============================================================

begin;

create or replace function public.tg_order_approvals_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (a) always-immutable identity + provenance columns.
  if new.id                   is distinct from old.id
  or new.store_id             is distinct from old.store_id
  or new.vendor_id            is distinct from old.vendor_id
  or new.business_date        is distinct from old.business_date
  or new.approved_at          is distinct from old.approved_at
  or new.created_at           is distinct from old.created_at then
    raise exception 'order approval is immutable' using errcode = 'P0001';
  end if;

  -- (a2) spec 178: the two ON DELETE SET NULL pointers. Immutable too, except
  -- for the one move their foreign keys make: value -> NULL once the referenced
  -- row is gone. The FK action is an ordinary UPDATE and fires this trigger
  -- after the parent row is deleted, so the row is no longer visible here. While
  -- it still exists the move is a client-side scrub, and it is refused.
  --
  -- These reads must run as the function owner. SECURITY INVOKER would apply the
  -- caller's RLS, a profile hidden from the caller would look deleted, and the
  -- scrub would pass. Do NOT "fix" this function to invoker.
  if new.approved_by is distinct from old.approved_by
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
  'raises P0001 (⇒ HTTP 400). Identity/provenance columns are always immutable, '
  'except that spec 178 lets approved_by and source_submission_id move to NULL '
  'once the referenced row is gone (their ON DELETE SET NULL action); '
  'the line snapshot freezes once status leaves ''pending''; external_ref freezes '
  'at ''ordered''. While ''pending'', channel may only move DOWNWARD to '
  '''extension''/''manual'' or back to the server-resolved vendor_order_channel() — '
  'a pending row can never be PATCHed onto the ''instacart'' mint path. '
  'Auto-sets updated_at and ordered_at.';

commit;
