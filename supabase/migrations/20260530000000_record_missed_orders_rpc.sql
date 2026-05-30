-- ============================================================
-- Spec 075 — first-class `audit_log` parity for missed vendor orders.
--
-- THE GAP
-- -------
-- Spec 074 windowed the Dashboard "attention queue" to Monday-reset, so
-- last-week's unconfirmed-PO ("missed order") events disappear from the
-- queue on Monday morning. Operators still want a longer-timeline view of
-- the same misses for reconciliation: "open AuditLog, filter to last
-- week, see one row per missed (store, vendor, date)". Pre-spec-075 the
-- audit_log carried zero rows for missed orders — the live attention
-- queue was computed entirely from `orderSchedule` + `orderSubmissions`
-- client-side, so once 074's window closed there was nothing on disk to
-- look back at.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- One additive SECURITY DEFINER RPC `record_missed_orders_for_day(p_date date)`
-- that, for a given business date, inserts one `audit_log` row per
-- (store_id, vendor_id-or-vendor_name) triple where:
--   (a) the store's `order_schedule` lists the vendor on
--       `to_char(p_date, 'FMDay')` — the TitleCase weekday string the
--       table stores per `src/lib/db.ts:3452-3454`'s contract.
--   (b) no row exists in `purchase_orders` matching (store_id,
--       reference_date = p_date, vendor) — the canonical
--       "order placed" predicate from `cmdSelectors.ts:889-896` lifted
--       into SQL (with the case-insensitive vendor-name match
--       preserved byte-for-byte: lower(...) = lower(...)).
--   (c) idempotency — no `audit_log` row already exists for the
--       (store_id, action='Order missed', detail-string) triple.
--
-- Plus:
--  - REVOKE all + GRANT EXECUTE to (postgres, service_role) only — cron
--    and service-role only path; anon and authenticated lack EXECUTE.
--  - A daily `cron.schedule('record-missed-orders-daily', '0 7 * * *', …)`
--    that runs the RPC for "yesterday in UTC" — the architect's
--    safe-global-hour decision (07:00 UTC = 02-03:00 ET, post-close
--    pre-open everywhere in the Americas; non-Americas brands log misses
--    a few hours late, accepted v1 tradeoff matching spec 074's same
--    brand-wide TZ approximation).
--  - A 28-day backfill loop at apply time covering [today-28, today-1]
--    in UTC days. Idempotent on re-run via the detail-string dedupe
--    predicate (see DEDUPE-KEY commentary below).
--
-- DEDUPE-KEY (architect's correction to the PM spec)
-- --------------------------------------------------
-- The PM spec proposed `(store_id, action, item_ref, created_at::date)`
-- as the idempotency key. THIS HAS A BUG for the backfill path: when
-- the migration applies on day D and backfills business dates
-- [D-28, D-1], `created_at = now()` (= D) for every inserted row, so
-- `created_at::date = D` is always the apply date — NOT the business
-- date — and a re-applied migration would *insert duplicates* for every
-- one of the 28 backfilled days (the dedupe predicate's date-equality
-- would always be false against rows whose `created_at::date` is the
-- previous apply day).
--
-- Architect's fix: dedupe on `lower(detail) = lower(<computed detail>)`.
-- The `detail` string is constructed deterministically from `p_date`
-- ('<VendorName> order missed (YYYY-MM-DD)'), so two runs against the
-- same business date produce the same detail string regardless of when
-- they execute. `lower()` defends against future stylistic vendor-name
-- normalization drift between runs. pgTAP arm E2 pins this.
--
-- WHY `to_char(p_date, 'FMDay')` (architect's D2)
-- -----------------------------------------------
-- `extract(dow FROM date)` returns 0..6 — would need a second mapping
-- step to TitleCase, which is the silent-drop hazard the PM spec
-- flagged. `to_char(p_date, 'Day')` is space-padded ("Monday   ", 9 chars)
-- — would need TRIM. `to_char(p_date, 'FMDay')` ("FM" = fill mode, strip
-- trailing spaces) returns bare TitleCase ("Monday") that matches the
-- byte-for-byte storage shape — no second translation, no TRIM. Used
-- inline as the join key.
--
-- `'FMDay'` is locale-dependent (follows `lc_time`). Supabase containers
-- ship with `lc_time = 'C'` (English TitleCase), and prod is the same per
-- the 2026-05-02 schema-pull. Defense-in-depth: the RPC body does
-- `SET LOCAL lc_time = 'C'` so a future GUC change cannot silently drop
-- misses.
--
-- MULTI-REGION TIMEZONE (architect-flagged risk, deferred)
-- --------------------------------------------------------
-- The brand carries one timezone today (`useStore.timezone =
-- 'America/New_York'`, no DB column). The daily cron runs at "yesterday
-- in UTC" — non-Americas brands will see misses logged a few hours
-- after their local end-of-day. Accepted v1 tradeoff (architect option
-- (b), single safe-global-hour cron) matching spec 074's identical
-- brand-wide TZ approximation. Per-store timezone is a follow-up spec
-- flagged in spec 074 §"Out of scope" and inherited by spec 075.
--
-- REALTIME / PUBLICATION
-- ----------------------
-- `audit_log` is NOT in `supabase_realtime` per
-- `20260514140000_realtime_publication_tighten.sql:42-53` — the
-- publication explicitly lists 10 tables, audit_log is not one of them.
-- This migration does NOT change publication membership. The
-- `docker restart supabase_realtime_imr-inventory` ritual the CLAUDE.md
-- realtime gotcha calls out is **NOT required** for this spec. New rows
-- surface on next `AuditLogSection` mount via the existing
-- `fetchAuditLog` path (`src/lib/db.ts:1242-1265`).
--
-- RLS
-- ---
-- No policy changes on `audit_log`. The RPC is SECURITY DEFINER and
-- runs as the function-owner role (postgres), bypassing RLS for the
-- INSERT — same pattern as spec 050's `demote_profile_to_user`. Existing
-- policies (`store_member_read_audit_log`, `store_member_insert_audit_log`,
-- `admin_update_audit_log`, `admin_delete_audit_log` from
-- `20260504173035_per_store_rls_hardening.sql:160-180`) remain the guard
-- for session-mediated traffic. Operators reading the new rows still
-- go through `auth_can_see_store(store_id)` — unchanged surface.
--
-- CLAUDE.md "Permissive RLS policies are ORed" lint: N/A — no new policy.
-- CLAUDE.md "last-of-role" / "self-guard": N/A — not a destructive
-- role-change or deletion operation.
--
-- ORDERING
-- --------
-- 20260530000000 sorts AFTER 20260528020000 (the latest at authoring
-- time). Strictly additive: one new function, one new cron job, one
-- one-shot backfill loop wrapped in a DO block. Rollback by
-- `drop function … + select cron.unschedule('record-missed-orders-daily')`.
-- ============================================================


-- ─── The RPC ───────────────────────────────────────────────────
create or replace function public.record_missed_orders_for_day(
  p_date date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
set lc_time = 'C'
as $$
declare
  v_inserted int;
begin
  -- Defense-in-depth: explicit null-arg refusal so a caller that sneaks
  -- a NULL into the cron body gets a structured error rather than a
  -- silent no-op (which would mask a misconfigured cron).
  if p_date is null then
    raise exception using
      errcode = 'P0001',
      message = 'p_date is required';
  end if;

  -- One INSERT … SELECT … WHERE NOT EXISTS. The `lower(detail)` dedupe
  -- predicate is the canonical idempotency key (see DEDUPE-KEY block
  -- in the file header). The `lower(coalesce(pv.name, '')) =
  -- lower(coalesce(v.name, os.vendor_name, ''))` predicate mirrors the
  -- TS attention-queue check at `cmdSelectors.ts:891-896` —
  -- case-insensitive name match, joined to canonical vendors when
  -- `vendor_id` is set and falling back to `order_schedule.vendor_name`
  -- otherwise (the SQL is slightly more correct than the TS — it
  -- prefers the canonical vendors.name; documented in spec design
  -- §"Risks and tradeoffs / Vendor name normalization").
  with v_ins as (
    insert into public.audit_log (
      store_id, user_id, action, detail, item_ref, value
    )
    select
      os.store_id,
      null::uuid                                                  as user_id,
      'Order missed'                                              as action,
      coalesce(v.name, os.vendor_name) || ' order missed ('
        || to_char(p_date, 'YYYY-MM-DD') || ')'                   as detail,
      'vendor:' ||
        coalesce(os.vendor_id::text, os.vendor_name)              as item_ref,
      coalesce(v.name, os.vendor_name)                            as value
      from public.order_schedule os
      left join public.vendors v on v.id = os.vendor_id
     where os.day_of_week = to_char(p_date, 'FMDay')
       -- (b) no matching purchase_orders row for (store, vendor, date)
       and not exists (
         select 1
           from public.purchase_orders po
           left join public.vendors pv on pv.id = po.vendor_id
          where po.store_id = os.store_id
            and coalesce(po.reference_date, po.created_at::date) = p_date
            and lower(coalesce(pv.name, '')) =
                lower(coalesce(v.name, os.vendor_name, ''))
       )
       -- (c) detail-string dedupe — the architect-corrected idempotency
       --     predicate. Survives the backfill-re-run hole the PM spec's
       --     `(store_id, action, item_ref, created_at::date)` key
       --     opened. `lower()` defends against future stylistic drift.
       and not exists (
         select 1 from public.audit_log al
          where al.store_id = os.store_id
            and al.action  = 'Order missed'
            and lower(al.detail) = lower(
                  coalesce(v.name, os.vendor_name) ||
                  ' order missed (' ||
                  to_char(p_date, 'YYYY-MM-DD') || ')'
                )
       )
    returning 1
  )
  select count(*)::int into v_inserted from v_ins;

  return v_inserted;
end;
$$;

comment on function public.record_missed_orders_for_day(date) is
  'Spec 075 — for the given business date, inserts one audit_log row
   per (store, vendor) triple where the store had the vendor on its
   order_schedule for to_char(p_date, ''FMDay'') but no matching
   purchase_orders row exists. Idempotent via the detail-string dedupe
   predicate (lower(detail) = lower(<computed detail>)). SECURITY DEFINER
   so cron + the migration backfill (both running as postgres) can
   bypass RLS for the audit_log INSERT. anon + authenticated lack
   EXECUTE — cron + service-role only.';


-- ─── Grants ────────────────────────────────────────────────────
-- Revoke from public (and therefore from anon, which inherits it; and
-- from authenticated, which is the session-driven role we want to
-- block). Grant explicitly to postgres (the role pg_cron + migration
-- backfill execute under) and service_role (defense-in-depth for a
-- future "rerun for date" admin endpoint; not used today). Tighter
-- than spec 050's `demote_profile_to_user` because this RPC has zero
-- session callers — only cron + the one-shot backfill.
revoke execute on function public.record_missed_orders_for_day(date)
  from public, anon, authenticated;
grant  execute on function public.record_missed_orders_for_day(date)
  to postgres, service_role;


-- ─── pg_cron schedule ──────────────────────────────────────────
-- 07:00 UTC daily — 02:00 ET (EDT) or 03:00 ET (EST), post-close
-- pre-open in the Americas. The architect's safe-global-hour
-- choice (option (b)). The body computes "yesterday in UTC" as
-- the business date to process. Multi-region brands accept a
-- few-hours-late log for non-Americas timezones — flagged as a
-- follow-up spec inherited from 074.
--
-- The `if exists … unschedule` block makes the migration safe to
-- re-apply: if the job is already scheduled it gets dropped before
-- re-creation. Same shape as spec 026's eod-reminder-cron at
-- `20260424211733_security_fixes.sql:161-163`.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'record-missed-orders-daily') then
    perform cron.unschedule('record-missed-orders-daily');
  end if;

  perform cron.schedule(
    'record-missed-orders-daily',
    '0 7 * * *',
    $cron$
      select public.record_missed_orders_for_day(
        ((now() at time zone 'UTC') - interval '1 day')::date
      );
    $cron$
  );
end $$;


-- ─── 28-day backfill loop ──────────────────────────────────────
-- Inclusive range [today-28, today-1] in UTC days. The detail-string
-- dedupe inside the RPC drops re-applied-migration inserts to zero —
-- safe on re-run. Worst-case row count (per spec design §28-day
-- backfill): 2 stores × 5 vendors × 28 days = 280 rows × ~150 B ≈
-- 42 KB. Trivial against the 286 KB seed.
--
-- Uses `now() at time zone 'UTC'` to match the daily cron's "yesterday
-- in UTC" semantics. The brand-wide TZ approximation applies here too
-- (see file header).
--
-- `raise notice` shape mirrors spec 007's idempotency-report pattern
-- (`20260507214842_spec007_order_schedule_unique.sql:61`) so re-applied
-- migrations leave a visible breadcrumb in the migration log.
do $$
declare
  d            date;
  v_inserted   int;
  v_total      int := 0;
begin
  for d in
    select generate_series(
      ((now() at time zone 'UTC')::date - 28),
      ((now() at time zone 'UTC')::date - 1),
      interval '1 day'
    )::date
  loop
    select public.record_missed_orders_for_day(d) into v_inserted;
    v_total := v_total + v_inserted;
  end loop;
  raise notice
    'spec075: backfilled missed-order audit rows for 28 days, total inserted = %',
    v_total;
end $$;
