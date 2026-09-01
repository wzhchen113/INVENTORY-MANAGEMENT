-- ============================================================
-- Spec 162 — BJ's auto-place order: the attempt audit spine, the 'order_failed'
-- notification type, the failure-email enqueue, and the ONE RPC the extension
-- calls to record a terminal outcome.
--
-- ADDITIVE. One new table, one CHECK widening (drop/re-add, all eight prior
-- values preserved verbatim — the spec-121/126/149 pattern), three new
-- functions. NO change to any existing table, policy, trigger, or realtime
-- publication, so NO `docker restart supabase_realtime_imr-inventory` ritual.
--
-- WHY THIS EXISTS: spec 132 stopped at "fill the cart, the human pays". Spec 162
-- lets the extension click BJ's own place-order button. That turns every failure
-- into money NOT spent on an order the store is counting on, so a failure has to
-- reach a human on two channels (in-app + email), and every attempt — placed or
-- failed — has to leave a durable record.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20260829000000' into
-- supabase_migrations.schema_migrations, then VERIFY the widened CHECK by
-- pg_get_constraintdef and all three functions by NORMALIZED-MD5.
--
-- Design authority: specs/162-bjs-auto-place-order.md "## Design".
-- ============================================================

begin;

-- ─── Part 1: the attempt audit spine (AC-6) ───────────────────────────────
-- One row per TERMINAL place-order outcome. Not a log of every click — the
-- extension records exactly once, at the end of every path including a thrown
-- error, so "no row" means "the operator never pressed the button" and never
-- "it silently died".
--
-- `outcome` is deliberately TWO values, not three. A cap block, a cart
-- mismatch, a CAPTCHA and a declined card are all "the order did not get
-- placed" as far as the store is concerned; WHERE it died is `stage`'s job.
-- Splitting 'blocked' out of 'failed' would fork the notification predicate for
-- no operational gain.
create table if not exists public.vendor_order_attempts (
  id                  uuid primary key default gen_random_uuid(),
  po_id               uuid not null references public.purchase_orders(id) on delete cascade,
  store_id            uuid not null references public.stores(id)          on delete cascade,
  vendor_id           uuid          references public.vendors(id)         on delete set null,
  -- WHO ran it. Kept here rather than on the notification, because the
  -- notification's actor_user_id is deliberately NULL (see emit_order_failed).
  attempted_by        uuid          references public.profiles(id)        on delete set null,
  outcome             text not null check (outcome in ('placed', 'failed')),
  -- Where the run ended. 'confirm' + outcome 'placed' is the ONLY success shape.
  stage               text not null check (stage in (
                        'cart-verify',    -- live cart didn't match the PO plan
                        'cap-check',      -- total over the operator's spend cap
                        'address-verify', -- vendor would ship somewhere else
                        'card-verify',    -- vendor would charge a different card
                        'checkout-nav',   -- couldn't reach / advance the checkout
                        'place',          -- the place-order control never fired
                        'confirm',        -- terminal: order number found, or not
                        'challenge',      -- CAPTCHA / bot wall / login wall
                        'error'           -- an exception escaped the run
                      )),
  detail              text,
  -- The live vendor cart subtotal we read, and the cap it was measured against.
  -- Both denormalized so the failure email can say "$812.40 over your $500 cap"
  -- without re-deriving anything.
  cart_total          numeric(12,2),
  cap_total           numeric(12,2),
  -- BJ's own order number, ONLY ever set on a confirmed placement (AC-5).
  vendor_order_number text,
  -- Client-supplied idempotency key: a retried RPC (flaky network, service
  -- worker restart) must not double-record or double-notify.
  client_uuid         uuid,
  created_at          timestamptz not null default now()
);

create unique index if not exists vendor_order_attempts_client_uuid_uidx
  on public.vendor_order_attempts (client_uuid)
  where client_uuid is not null;

-- Feed shape: "what happened with this PO", newest first.
create index if not exists vendor_order_attempts_po_created_idx
  on public.vendor_order_attempts (po_id, created_at desc);

-- Store-scoped scan for a future "recent auto-order attempts" panel.
create index if not exists vendor_order_attempts_store_created_idx
  on public.vendor_order_attempts (store_id, created_at desc);

comment on table public.vendor_order_attempts is
  'spec 162 (AC-6): one row per TERMINAL auto-place outcome from the cart-filler '
  'extension. outcome is placed|failed; stage says where it ended. Written ONLY '
  'by record_vendor_order_attempt (SECURITY DEFINER) — no client INSERT policy. '
  'Idempotent on client_uuid so a retried RPC cannot double-notify.';


-- ─── Part 2: RLS ──────────────────────────────────────────────────────────
-- SELECT-only for clients, store-scoped. All writes come from the SECURITY
-- DEFINER RPC (table owner, bypasses RLS) => default-deny for writes with no
-- INSERT/UPDATE/DELETE policy at all.
--
-- The policy is SCOPED (auth_can_see_store), never trivially-wide, so it does
-- not trip the spec-053 permissive_policy_lint pgTAP probe and needs no
-- allowlist entry.
alter table public.vendor_order_attempts enable row level security;

drop policy if exists "store_member_read_vendor_order_attempts" on public.vendor_order_attempts;
create policy "store_member_read_vendor_order_attempts"
  on public.vendor_order_attempts for select
  using (public.auth_can_see_store(store_id));

-- Grants: spec-097 posture — the table inherits the ALTER DEFAULT PRIVILEGES
-- grants from 20260618000000; RLS is the gate, not the grant layer. Do NOT
-- revoke from anon/authenticated (would trip the spec-097 grant lint).


-- ─── Part 3: widen notifications.type CHECK with 'order_failed' (AC-7) ────
-- Drop (defensively) then re-add under the same auto-generated name. All EIGHT
-- legacy values are preserved verbatim, so every existing row stays valid.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue','order_ready','order_failed'));


-- ─── Part 4: emit_order_failed — thin sibling of emit_order_ready (AC-7) ──
-- Mirrors emit_order_ready exactly, with two DELIBERATE divergences:
--
--   1. source_id = the ATTEMPT id, NOT the PO id. notifications_type_source_uidx
--      dedupes on (type, source_id); with the PO id, a SECOND failed attempt on
--      the same PO would be silently swallowed — the exact case where the
--      operator most needs a second ping. Each attempt is its own row, so each
--      failure notifies.
--
--   2. actor_user_id is NULL even though there IS a real actor. submission-push-
--      fanout excludes actor_user_id from the push recipient set (spec 120: never
--      ping the submitter about their own submission). That rule INVERTS here:
--      an unattended auto-place means the operator walked away from the browser,
--      so they are precisely the person the push must reach. actor_name still
--      carries their name for the bell's secondary line, and the durable
--      provenance lives on vendor_order_attempts.attempted_by.
--
-- Same exception envelope as every other emitter: a notification failure raises
-- a WARNING and can NEVER roll back the attempt record (AC-9). The attempt row
-- is the durable truth; the notification is a side-channel.
create or replace function public.emit_order_failed(
  p_attempt_id  uuid,
  p_store_id    uuid,
  p_actor       uuid,
  p_vendor_name text,
  p_reason      text
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
      (v_brand, p_store_id, null, 'order_failed', p_attempt_id,
       v_actor_name, v_store_name,
       -- The spec-126 free-text slot, reused: "<vendor> · <reason>" is what the
       -- bell row and the push body both render.
       concat_ws(' · ', nullif(p_vendor_name, ''), nullif(p_reason, '')))
    on conflict (type, source_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- best-effort
    end if;
  exception when others then
    raise warning 'emit_order_failed failed (%): %', p_attempt_id, sqlerrm;
  end;
end $$;

comment on function public.emit_order_failed(uuid, uuid, uuid, text, text) is
  'spec 162 (AC-7): emit ONE ''order_failed'' notification for a failed auto-place '
  'attempt. source_id is the ATTEMPT id (not the PO id) so a retry re-notifies '
  'instead of being deduped away. actor_user_id is deliberately NULL so the '
  'push fan-out reaches the operator who walked away; provenance lives on '
  'vendor_order_attempts.attempted_by. body carries "<vendor> · <reason>". '
  'Exception-safe. Internal — EXECUTE revoked from all client roles.';

revoke execute on function public.emit_order_failed(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;


-- ─── Part 5: enqueue_order_failure_email (AC-8) ───────────────────────────
-- Structural twin of enqueue_submission_push: reads the function URL from
-- _edge_auth 'order_failure_email_url' and the shared bearer from 'cron_bearer'.
-- Local dev never seeds the URL => the POST is skipped with a NOTICE, so the
-- local stack never emails anyone. pg_net enqueues and sends AFTER commit via
-- its background worker => never blocks the RPC.
--
-- Degradation is BY DESIGN: an unconfigured URL loses the email arm but keeps
-- the bell + push arm. A failure still reaches a human.
create or replace function public.enqueue_order_failure_email(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_bearer text;
begin
  select value into v_url    from public._edge_auth where name = 'order_failure_email_url';
  select value into v_bearer from public._edge_auth where name = 'cron_bearer';

  if v_url is null then
    raise notice 'order_failure_email_url not configured in _edge_auth — skipping failure email (expected for local dev)';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || coalesce(v_bearer, ''),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('attempt_id', p_attempt_id),
    timeout_milliseconds := 30000
  );
end $$;

comment on function public.enqueue_order_failure_email(uuid) is
  'spec 162 (AC-8): best-effort pg_net POST to send-order-failure-email with '
  '{attempt_id}, bearing the shared _edge_auth cron_bearer. Skips with a NOTICE '
  'when order_failure_email_url is unset (local dev) — the bell + push arm still '
  'fires. Internal — EXECUTE revoked from all client roles.';

revoke execute on function public.enqueue_order_failure_email(uuid)
  from public, anon, authenticated;


-- ─── Part 6: record_vendor_order_attempt — the ONE client entry point ─────
-- The extension calls this exactly once per terminal outcome (AC-6).
--
-- SECURITY DEFINER because it must insert notifications and fire pg_net, which
-- no client role may do directly. The store gate is therefore EXPLICIT and
-- LOAD-BEARING: auth_can_see_store(p_store_id) is checked FIRST, before any
-- side effect, so a caller cannot record an attempt (or trigger a notification
-- storm) against a store they cannot see. Same posture as the spec-131 RPCs,
-- which get this for free from SECURITY INVOKER + RLS.
--
-- ORDER OF EFFECTS matters:
--   1. store gate                      — refuse before touching anything
--   2. idempotency short-circuit       — a replayed client_uuid returns the
--                                        existing id and does NOTHING else, so
--                                        a retry can never double-notify or
--                                        double-flip the PO
--   3. insert the attempt              — the durable record lands FIRST
--   4. placed  → guarded draft→sent    — `and status = 'draft'` makes it
--                                        idempotent and unable to resurrect a
--                                        received/cancelled PO (the spec-131
--                                        D-4 / architect S-1 required shape)
--      failed  → emit + enqueue email  — both wrapped so neither can roll back
--                                        the record (AC-9)
create or replace function public.record_vendor_order_attempt(
  p_po_id               uuid,
  p_outcome             text,
  p_stage               text,
  p_detail              text    default null,
  p_cart_total          numeric default null,
  p_cap_total           numeric default null,
  p_vendor_order_number text    default null,
  p_client_uuid         uuid    default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id    uuid;
  v_vendor_id   uuid;
  v_vendor_name text;
  v_attempt_id  uuid;
  v_existing    uuid;
begin
  if p_outcome not in ('placed', 'failed') then
    raise exception 'invalid outcome %', p_outcome using errcode = 'P0001';
  end if;

  select po.store_id, po.vendor_id, v.name
    into v_store_id, v_vendor_id, v_vendor_name
    from public.purchase_orders po
    left join public.vendors v on v.id = po.vendor_id
   where po.id = p_po_id;

  if v_store_id is null then
    raise exception 'purchase order not found' using errcode = 'P0001';
  end if;

  -- (1) STORE GATE — before any side effect.
  if not public.auth_can_see_store(v_store_id) then
    raise exception 'not authorized for this store' using errcode = 'P0001';
  end if;

  -- (2) IDEMPOTENCY — a replayed call is a pure read.
  if p_client_uuid is not null then
    select id into v_existing
      from public.vendor_order_attempts
     where client_uuid = p_client_uuid;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- (3) THE DURABLE RECORD.
  insert into public.vendor_order_attempts
    (po_id, store_id, vendor_id, attempted_by, outcome, stage, detail,
     cart_total, cap_total, vendor_order_number, client_uuid)
  values
    (p_po_id, v_store_id, v_vendor_id, auth.uid(), p_outcome, p_stage, p_detail,
     p_cart_total, p_cap_total,
     -- AC-5: an order number is meaningless on a failure; never store one.
     case when p_outcome = 'placed' then p_vendor_order_number else null end,
     p_client_uuid)
  returning id into v_attempt_id;

  -- (4) THE SIDE EFFECTS.
  if p_outcome = 'placed' then
    -- Guarded transition (spec 131 D-4 / architect S-1): idempotent, and cannot
    -- resurrect a received/cancelled PO.
    update public.purchase_orders
       set status = 'sent'
     where id = p_po_id
       and status = 'draft';
  else
    -- Both arms are best-effort side-channels. emit_order_failed carries its own
    -- envelope; the enqueue does not, so wrap it — a pg_net hiccup must not lose
    -- the attempt record (AC-9).
    perform public.emit_order_failed(
      v_attempt_id, v_store_id, auth.uid(), coalesce(v_vendor_name, ''), coalesce(p_detail, '')
    );
    begin
      perform public.enqueue_order_failure_email(v_attempt_id);
    exception when others then
      raise warning 'enqueue_order_failure_email failed (%): %', v_attempt_id, sqlerrm;
    end;
  end if;

  return v_attempt_id;
end $$;

comment on function public.record_vendor_order_attempt(uuid, text, text, text, numeric, numeric, text, uuid) is
  'spec 162 (AC-6/AC-7): the ONE entry point the cart-filler extension calls per '
  'terminal auto-place outcome. SECURITY DEFINER with an EXPLICIT '
  'auth_can_see_store gate checked before any side effect. Idempotent on '
  'p_client_uuid (a replay is a pure read). placed → guarded draft→sent + order '
  'number; failed → emit_order_failed + enqueue_order_failure_email, neither of '
  'which can roll back the attempt record. Returns the attempt id.';

-- Callable by the extension's authenticated admin JWT. The store gate inside is
-- what bounds it — not the grant.
--
-- REVOKE FROM `public` IS LOAD-BEARING, and revoking from `anon` alone is NOT
-- enough: CREATE FUNCTION grants EXECUTE to PUBLIC, and anon INHERITS that, so
-- `revoke ... from anon` leaves anon still able to call it. This is the exact
-- idiom the spec-131 extension RPCs use
-- (20260723000000_extension_ordering.sql:191) and the reason they are correctly
-- anon-denied. Order matters: strip PUBLIC first, then re-grant to the one role
-- that should have it.
revoke all     on function public.record_vendor_order_attempt(uuid, text, text, text, numeric, numeric, text, uuid)
  from public, anon;
grant  execute on function public.record_vendor_order_attempt(uuid, text, text, text, numeric, numeric, text, uuid)
  to authenticated;

commit;
