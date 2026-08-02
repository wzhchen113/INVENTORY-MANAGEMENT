-- ============================================================
-- Spec 149 (§1.2) — public.order_approvals: the APPROVE & ORDER audit trail
-- (AC-19), its status-transition + immutability guard (AC-20), its per-store
-- RLS (AC-21), and the single INSERT path public.create_order_approval().
--
-- STRICTLY ADDITIVE: one new table, two indexes, one BEFORE UPDATE trigger,
-- three RLS policies, one RPC. No existing table, column, policy, or function
-- is modified. No publication change (R-5 — order_approvals is deliberately
-- NOT published in v1; see §6), therefore NO
-- `docker restart supabase_realtime_imr-inventory` step.
--
-- SECOND of the spec-149 dependency chain — depends on
-- 20260801000000_vendor_order_channel.sql for public.vendor_order_channel().
--
-- APPEND-ONLY IN SPIRIT (AC-19) is enforced by RLS, not convention: there is
-- NO delete policy, so DELETE is default-denied for every client role. The
-- only permitted mutations are the AC-20 status transition and the
-- external-reference write, both policed by tg_order_approvals_guard().
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20260801000100' into
-- supabase_migrations.schema_migrations, VERIFY the table + both indexes +
-- the three policies by PRESENCE and both functions by NORMALIZED-MD5.
--
-- Design authority: specs/149-eod-approve-order-pipeline.md "## Backend design"
-- §1.2 + §2 (+ R-6 re-approval refusal, design guidance 6 idempotency).
-- ============================================================

begin;

-- ─── Part 1: the table (AC-19) ────────────────────────────────────────────
create table if not exists public.order_approvals (
  id                      uuid primary key default gen_random_uuid(),
  store_id                uuid not null references public.stores(id)          on delete cascade,
  vendor_id               uuid not null references public.vendors(id)         on delete restrict,
  business_date           date not null,
  approved_by             uuid          references public.profiles(id)        on delete set null,
  approved_at             timestamptz not null default now(),
  channel                 text not null check (channel in ('instacart','webstaurant','extension','manual')),
  status                  text not null default 'pending'
                            check (status in ('pending','approved','ordered')),
  lines                   jsonb not null,
  line_count              integer not null default 0,
  est_total_cost          numeric(12,4) not null default 0,
  external_ref            text,
  external_ref_expires_at timestamptz,
  ordered_at              timestamptz,
  source_submission_id    uuid          references public.eod_submissions(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.order_approvals is
  'spec 149 (AC-19): the APPROVE & ORDER audit trail — who approved what, when, '
  'on which channel, and whether it was actually ordered. ONE row per '
  '(store_id, vendor_id, business_date) — that unique key IS the idempotency '
  'spine for a double-tap or a post-network-error retry (design guidance 6). '
  'Append-only in spirit: no DELETE policy exists (default-deny), and '
  'tg_order_approvals_guard() restricts UPDATE to the AC-20 status transition '
  'plus the external-reference write.';

comment on column public.order_approvals.lines is
  'spec 149 (§1.2): the approved line SNAPSHOT, a jsonb array of '
  '{ item_id, item_name, qty_base, case_qty, unit, cost_per_counted_unit }. '
  'qty_base is BASE / COUNTED units — the same basis fillCartForVendor and '
  'createPurchaseOrderDraft already persist. cost_per_counted_unit is the '
  'spec-104 ★ bridge (ReorderItem.costPerUnit is per-EACH and must be multiplied '
  'by subUnitSize); the client computes it exactly as useStore.fillCartForVendor '
  'does and create_order_approval validates SHAPE only (numeric >= 0). '
  'Frozen once status leaves ''pending''.';

comment on column public.order_approvals.external_ref is
  'spec 149 (AC-19 / OQ-6): the external reference where one exists — the '
  'Instacart products_link_url, the vendor order-page URL, or the extension '
  'PO id. Writable while ''pending'' or ''approved'' (so an expired Instacart link '
  'can be re-minted on demand); FROZEN once ''ordered''.';

-- AC-19 / design-guidance-6 idempotency spine: ONE approval per
-- (store, vendor, business_date). A double-tap or a retry hits this key.
create unique index if not exists order_approvals_store_vendor_date_uidx
  on public.order_approvals (store_id, vendor_id, business_date);

-- Feed / history read path (store-scoped, newest first).
create index if not exists order_approvals_store_approved_idx
  on public.order_approvals (store_id, approved_at desc);


-- ─── Part 2: status-transition + immutability guard (AC-20) ───────────────
-- ONE BEFORE UPDATE trigger. SECURITY DEFINER + set search_path = public,
-- mirroring the spec-120 trigger-function posture.
--
-- Legal status moves:  pending → approved,  approved → ordered,  and any
-- no-op (x → x). EVERYTHING else raises P0001, which PostgREST maps to
-- HTTP 400 — that is the server-side rejection AC-20 asks for, so the status
-- advance + external_ref write can stay plain PostgREST UPDATEs under RLS
-- with no extra RPC surface.
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
  or new.approved_by          is distinct from old.approved_by
  or new.approved_at          is distinct from old.approved_at
  or new.source_submission_id is distinct from old.source_submission_id
  or new.created_at           is distinct from old.created_at then
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
  'raises P0001 (⇒ HTTP 400). Identity/provenance columns are always immutable; '
  'the line snapshot freezes once status leaves ''pending''; external_ref freezes '
  'at ''ordered''. While ''pending'', channel may only move DOWNWARD to '
  '''extension''/''manual'' or back to the server-resolved vendor_order_channel() — '
  'a pending row can never be PATCHed onto the ''instacart'' mint path. '
  'Auto-sets updated_at and ordered_at.';

revoke execute on function public.tg_order_approvals_guard()
  from public, anon, authenticated;

drop trigger if exists order_approvals_guard on public.order_approvals;
create trigger order_approvals_guard
  before update on public.order_approvals
  for each row
  execute function public.tg_order_approvals_guard();


-- ─── Part 3: RLS (§2, AC-21) ──────────────────────────────────────────────
-- The auth_is_privileged() conjunct is LOAD-BEARING, for exactly the same
-- reason as spec 120's privileged_brand_read_notifications and spec 126's
-- privileged_brand_read_staff_reports: auth_can_see_store() returns TRUE for a
-- store-linked staff `user` row. Staff SUBMIT counts; they do not APPROVE
-- orders (AC-REG-5). Without the conjunct a staff session could INSERT
-- approvals. A future "let a shift lead pre-approve" spec must change THIS
-- policy, not route around it with a DEFINER RPC (§10.6).
--
-- spec-053 permissive_policy_lint (AC-21): all three predicates are
-- conjunctions of two helper calls — not `true`, not `auth.uid() IS NOT NULL`,
-- not `auth.role() = 'authenticated'`, and no OR-tail. The probe stays green
-- with NO allowlist row added. Do not add one.
--
-- Permissive-OR audit (CLAUDE.md rule): order_approvals is a brand-new table;
-- pg_policies has zero pre-existing rows for it, so there is no wide policy to
-- OR against and nothing to consolidate.
--
-- Grants: inherits the 20260618000000_public_grants_explicit.sql ALTER DEFAULT
-- PRIVILEGES posture. Do NOT revoke from anon/authenticated — that would trip
-- the spec-097 grant lint. RLS is the gate.
alter table public.order_approvals enable row level security;

drop policy if exists "privileged_store_read_order_approvals"   on public.order_approvals;
drop policy if exists "privileged_store_insert_order_approvals" on public.order_approvals;
drop policy if exists "privileged_store_update_order_approvals" on public.order_approvals;

create policy "privileged_store_read_order_approvals"
  on public.order_approvals for select
  using (public.auth_is_privileged() and public.auth_can_see_store(store_id));

create policy "privileged_store_insert_order_approvals"
  on public.order_approvals for insert
  with check (public.auth_is_privileged()
              and public.auth_can_see_store(store_id)
              and approved_by = auth.uid());

create policy "privileged_store_update_order_approvals"
  on public.order_approvals for update
  using       (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check  (public.auth_is_privileged() and public.auth_can_see_store(store_id));

-- NO delete policy → default-deny (append-only, AC-19). Deliberate absence.


-- ─── Part 4: create_order_approval — the ONLY INSERT path (§1.2 / §3.2) ───
-- SECURITY INVOKER: the caller's RLS does the real clipping on both the read
-- and the write; the explicit gates below exist for a clean, stable error
-- contract (and so the refusal happens BEFORE any write, mirroring the
-- submit_staff_report / get_extension_order_payload discipline).
--
-- Idempotent on (store_id, vendor_id, business_date):
--   • no row                       ⇒ INSERT at status='pending'
--   • existing row status='pending'⇒ UPDATE the snapshot (retry path)
--   • existing row approved/ordered⇒ NO WRITE, return the row verbatim (R-6).
--   • LOST RACE (concurrent insert of the same key ⇒ 23505) ⇒ re-read the
--     winner's row and fall through the same retry / R-6 logic, so a lost race
--     is indistinguishable from a plain replay (S-3).
--     The client branches on `status` and renders the already-actioned state
--     (AC-13). Re-approval is REFUSED, not overwritten — that is what keeps the
--     row genuinely append-only.
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
        update public.order_approvals
           set lines          = p_lines,
               line_count     = v_count,
               est_total_cost = v_est,
               channel        = v_channel
         where id = v_row.id
        returning * into v_row;
      end if;
      -- status in ('approved','ordered') ⇒ return the winner's row verbatim (R-6).
    end;

  elsif v_row.status = 'pending' then
    -- Retry path: refresh the snapshot, leave status alone.
    update public.order_approvals
       set lines          = p_lines,
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
  'spec 149 (§1.2 / §3.2, AC-19/AC-21/AC-27): the ONLY INSERT path for '
  'public.order_approvals. SECURITY INVOKER with explicit top gates — 42501 when '
  'the store is not visible or the caller is not privileged, 22023 on invalid '
  'lines, P0002 when the vendor is missing/invisible. Resolves the channel '
  'server-side via vendor_order_channel() (the client never supplies it) and is '
  'idempotent on (store_id, vendor_id, business_date): pending rows are refreshed, '
  'approved/ordered rows are returned VERBATIM with no write (R-6). A CONCURRENT '
  'insert of the same key (23505) is caught and resolved by re-reading the '
  'winner''s row, so a lost race behaves exactly like a replay (S-3).';

revoke all     on function public.create_order_approval(uuid, uuid, date, jsonb, uuid)
  from public, anon;
grant  execute on function public.create_order_approval(uuid, uuid, date, jsonb, uuid)
  to authenticated;

commit;
