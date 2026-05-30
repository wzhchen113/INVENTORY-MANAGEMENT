-- supabase/tests/missed_order_audit_rpc.test.sql
--
-- Spec 075 — pgTAP coverage for `record_missed_orders_for_day(date)` at
-- supabase/migrations/20260530000000_record_missed_orders_rpc.sql.
--
-- The RPC is SECURITY DEFINER + cron-invoked + has a 28-day backfill
-- loop. The two highest-risk pieces (per the architect's design
-- §"Risks and tradeoffs") are (a) the security surface — SECURITY
-- DEFINER + grant lockdown — and (b) the idempotency dedupe correctness
-- (the PM spec proposed a `(store_id, action, item_ref, created_at::date)`
-- key that has a backfill-rerun hole; the architect's corrected
-- `lower(detail) = lower(<computed detail>)` predicate is what arms E1
-- and E2 pin).
--
-- Seven arms (plan(9) — arm C contributes 2 assertions, the rest 1 each):
--
--   Arm A  — function signature exists (`record_missed_orders_for_day(date)`).
--            Catalog-query, fail-closed against a stray signature drift.
--   Arm B  — SECURITY DEFINER flag + grant lockdown. catalog-query
--            (NOT `set local role anon` — see reports_anon_revoke.test.sql
--            lines 31-42 for the spec 045 implementation note: the
--            runtime-role-switch pattern segfaults Postgres in CI under
--            the newer pg-version image).
--   Arm C  — positive case: scheduled vendor on Monday with NO matching
--            purchase_orders row → exactly 1 audit_log row inserted with
--            the shape the architect specified (action='Order missed',
--            user_id NULL, detail='<vendor> order missed (YYYY-MM-DD)',
--            item_ref='vendor:<id>', value='<vendor>').
--   Arm D  — negative case: scheduled vendor on Monday WITH a matching
--            purchase_orders row → 0 rows.
--   Arm E1 — idempotency on second call same date → 0 additional rows.
--   Arm E2 — backfill loop simulation: call the RPC 3 times for the
--            same date → exactly 1 audit_log row at the end. Pins the
--            architect's `lower(detail)` dedupe — would fail if someone
--            reverted to the spec's vacuous
--            `(store_id, action, item_ref, created_at::date)` key
--            inside this txn (all three calls share the same
--            `created_at::date`, so a date-key dedupe would coincidentally
--            also keep this arm at 1 row; the architect's correction is
--            documented + tested both here and in the migration file
--            header's DEDUPE-KEY block).
--   Arm F  — case-insensitive vendor-name match (architect-flagged,
--            code-reviewer Should-fix). Seeds order_schedule with
--            vendor_name='bjs' (lowercase) and a purchase_orders row
--            referencing the BJs vendor (pv.name='BJs', uppercase). The
--            RPC's `lower(coalesce(pv.name,'')) = lower(coalesce(v.name,
--            os.vendor_name,''))` predicate must match across the case
--            boundary and suppress the insert. Pins parity with
--            cmdSelectors.ts:891-896's `.toLowerCase()` comparison.
--   Arm G  — vendor_id NULL fallback for `item_ref` (spec AC E1, line
--            762-766). Seeds order_schedule with vendor_id=NULL and
--            vendor_name='ACME'. Asserts the inserted row's
--            item_ref = 'vendor:ACME' (NOT 'vendor:' empty string),
--            guarding the `coalesce(os.vendor_id::text, os.vendor_name)`
--            expression at migration line 168 against an accidental drop.
--
-- Hermetic isolation: `begin; ... rollback;` framing leaves the seed
-- untouched. The 28-day backfill at migration apply time inserted 0 rows
-- against the empty-order_schedule seed; this test's INSERTs into
-- order_schedule are local to the txn and don't survive the outer
-- rollback.
--
-- No savepoints — pgTAP's plan counter is per-transaction and
-- `rollback to savepoint` discards the recorded test count. Instead,
-- each arm uses a distinct (store, p_date) fixture so state doesn't
-- bleed between arms. Two seed stores (Towson, Frederick) are
-- available; each arm picks one and a unique business date (all
-- Mondays so `to_char(p_date, 'FMDay') = 'Monday'`).
--
-- Calls into the RPC run as the migration role (postgres) — no role
-- switch needed because the cron + backfill are the only real callers
-- and both run as postgres. The arm-B grant-catalog assertion confirms
-- that anon/authenticated cannot reach the RPC at runtime.

begin;
create extension if not exists pgtap;

select plan(9);


-- ─── Arm A: function signature exists ──────────────────────────
select has_function(
  'public',
  'record_missed_orders_for_day',
  array['date'],
  'A: public.record_missed_orders_for_day(date) exists'
);


-- ─── Arm B: SECURITY DEFINER + grant lockdown ──────────────────
-- Catalog-query against pg_proc.prosecdef and has_function_privilege
-- (the spec-045 catalog-query pattern; see reports_anon_revoke.test.sql
-- lines 31-42 for the rationale).
select ok(
  (select prosecdef
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'record_missed_orders_for_day'
      and pg_get_function_arguments(p.oid) = 'p_date date')
  and not has_function_privilege(
    'anon',          'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and not has_function_privilege(
    'authenticated', 'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and     has_function_privilege(
    'service_role',  'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and     has_function_privilege(
    'postgres',      'public.record_missed_orders_for_day(date)', 'EXECUTE'),
  'B: SECURITY DEFINER + anon/authenticated REVOKE + postgres/service_role EXECUTE'
);


-- ─── Shared fixtures: two seed stores + seed vendor + a Monday ─
-- 2026-05-25, 2026-05-18, 2026-05-11, 2026-05-04 are all Mondays
-- (verified via `extract(dow from date '2026-05-25') = 1`).
do $$
declare
  v_towson    uuid := '00000000-0000-0000-0000-000000000001';   -- seed Towson
  v_frederick uuid := '0f240390-edda-4b25-8c72-45eeb2ce1988';   -- seed Frederick
  v_charles   uuid := '1ea549bb-8b50-4078-9301-479311d9fdec';   -- seed Charles
  v_reisters  uuid := '298e092c-3f6e-4626-a569-54fb8e72f649';   -- seed Reisters
  v_vendor_id uuid := 'b1ee724a-8626-45ab-85d4-14a99e7cbc45';   -- seed BJs
begin
  perform set_config('test.store_c',  v_towson::text,    true);
  perform set_config('test.store_d',  v_frederick::text, true);
  perform set_config('test.store_e1', v_charles::text,   true);
  perform set_config('test.store_e2', v_reisters::text,  true);
  perform set_config('test.vendor',   v_vendor_id::text, true);
  perform set_config('test.date_c',   '2026-05-25',      true);  -- Monday
  perform set_config('test.date_d',   '2026-05-18',      true);  -- Monday
  perform set_config('test.date_e1',  '2026-05-11',      true);  -- Monday
  perform set_config('test.date_e2',  '2026-05-04',      true);  -- Monday
  -- Arms F + G reuse the existing seed stores with distinct dates so
  -- the detail-filter on the audit_log assertion cannot collide with
  -- earlier arms' inserts.
  perform set_config('test.store_f',  v_towson::text,    true);
  perform set_config('test.date_f',   '2026-04-27',      true);  -- Monday
  perform set_config('test.store_g',  v_frederick::text, true);
  perform set_config('test.date_g',   '2026-04-20',      true);  -- Monday
end $$;


-- ─── Arm C: positive case — exactly 1 row inserted ─────────────
-- store_c = Towson, p_date = 2026-05-25.
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_c',  true)::uuid,
  'Monday',
  current_setting('test.vendor',   true)::uuid,
  'BJs',
  'Tuesday'
);

-- C.1: RPC returns 1.
select is(
  (select public.record_missed_orders_for_day(
     current_setting('test.date_c', true)::date)),
  1,
  'C.1: positive case — RPC returns 1 (one row inserted)'
);

-- C.2: exactly 1 audit_log row with the expected shape exists for
-- (store_c, p_date_c). Filtered by store_id so it cannot collide with
-- other arms' fixtures.
select is(
  (select count(*)::int
     from public.audit_log
    where store_id = current_setting('test.store_c', true)::uuid
      and user_id is null
      and action  = 'Order missed'
      and detail  = 'BJs order missed (2026-05-25)'
      and item_ref = 'vendor:' || current_setting('test.vendor', true)
      and value   = 'BJs'),
  1,
  'C.2: positive case — exactly 1 audit_log row with the architect-specified shape'
);


-- ─── Arm D: negative case — submission exists → 0 rows for (store_d) ─
-- store_d = Frederick, p_date = 2026-05-18. The RPC scans the whole
-- order_schedule per call, so the *returned* int is not the right
-- assertion — other arms' order_schedule rows (Towson from arm C)
-- would inflate it for the unrelated p_date_d run. The architect-
-- specified semantics are per-(store, vendor, date), so the assertion
-- checks the audit_log row count for the specific (store_d, detail) —
-- the suppression contract. Pre-arm-D audit_log has zero
-- (Frederick, '… (2026-05-18)') rows; post-arm-D it must STILL have
-- zero because the matching purchase_orders row suppressed the insert.
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_d',  true)::uuid,
  'Monday',
  current_setting('test.vendor',   true)::uuid,
  'BJs',
  'Tuesday'
);

-- The "matching submission" is a purchase_orders row at (store, vendor,
-- reference_date = p_date). reference_date is the column added by
-- 20260502071736 (verified at lines 149, 177 in that migration). The
-- RPC's coalesce(reference_date, created_at::date) fallback is exercised
-- when reference_date is NULL; here we set it explicitly.
insert into public.purchase_orders
  (store_id, vendor_id, reference_date, status)
values (
  current_setting('test.store_d',  true)::uuid,
  current_setting('test.vendor',   true)::uuid,
  current_setting('test.date_d',   true)::date,
  'sent'
);

-- Drive the RPC for arm D's date. The return value may include inserts
-- for OTHER stores' Monday rows that this txn previously created (arm
-- C's Towson Monday row for example) — that is correct RPC behavior and
-- not what arm D asserts. Wrap in a DO block so the returned int does
-- not surface to the pgTAP runner.
do $$
begin
  perform public.record_missed_orders_for_day(
    current_setting('test.date_d', true)::date);
end $$;

select is(
  (select count(*)::int
     from public.audit_log
    where store_id = current_setting('test.store_d', true)::uuid
      and action   = 'Order missed'
      and detail   = 'BJs order missed (2026-05-18)'),
  0,
  'D: negative case — matching purchase_orders row suppresses the (store_d, p_date_d) insert'
);


-- ─── Arm E1: idempotency on second call same date ──────────────
-- store_e1 = Charles, p_date = 2026-05-11. Independent from arms
-- C and D so the audit_log rows already accumulated do not affect
-- this assertion.
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_e1', true)::uuid,
  'Monday',
  current_setting('test.vendor',   true)::uuid,
  'BJs',
  'Tuesday'
);

-- First call inserts (return value not asserted — the C arms already
-- pinned that). Wrap in a DO block so the result row doesn't surface to
-- the pgTAP runner (top-level SQL has no PERFORM).
do $$
begin
  perform public.record_missed_orders_for_day(
    current_setting('test.date_e1', true)::date);
end $$;

-- Second call: the architect's `lower(detail)` dedupe predicate finds
-- the row inserted above and refuses the duplicate.
select is(
  (select public.record_missed_orders_for_day(
     current_setting('test.date_e1', true)::date)),
  0,
  'E1: idempotency — second call for the same p_date returns 0'
);


-- ─── Arm E2: backfill simulation — 3 calls → exactly 1 row ─────
-- store_e2 = Reisters, p_date = 2026-05-04. Pins the dedupe predicate
-- end-to-end across three sequential calls. Asserts exactly 1 row
-- ends up in audit_log for the (store_e2, p_date_e2) pair.
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_e2', true)::uuid,
  'Monday',
  current_setting('test.vendor',   true)::uuid,
  'BJs',
  'Tuesday'
);

do $$
begin
  perform public.record_missed_orders_for_day(
    current_setting('test.date_e2', true)::date);
  perform public.record_missed_orders_for_day(
    current_setting('test.date_e2', true)::date);
  perform public.record_missed_orders_for_day(
    current_setting('test.date_e2', true)::date);
end $$;

select is(
  (select count(*)::int
     from public.audit_log
    where store_id = current_setting('test.store_e2', true)::uuid
      and action   = 'Order missed'
      and detail   = 'BJs order missed (2026-05-04)'),
  1,
  'E2: backfill — 3 calls for the same p_date leave exactly 1 audit_log row'
);


-- ─── Arm F: case-insensitive vendor-name match ────────────────
-- store_f = Towson (different date than arm C), p_date = 2026-04-27.
-- The schedule row lists vendor_name='bjs' (lowercase, NULL vendor_id),
-- the purchase_orders row points to the BJs vendor (uppercase
-- pv.name='BJs'). The RPC's `lower(coalesce(pv.name,'')) =
-- lower(coalesce(v.name, os.vendor_name,''))` predicate must match
-- across the case boundary → 0 inserts. If a future refactor drops the
-- `lower()` on either side, this arm fails (the case mismatch would
-- let the insert through).
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_f',  true)::uuid,
  'Monday',
  NULL,
  'bjs',
  'Tuesday'
);

insert into public.purchase_orders
  (store_id, vendor_id, reference_date, status)
values (
  current_setting('test.store_f',  true)::uuid,
  current_setting('test.vendor',   true)::uuid,    -- BJs vendor (pv.name='BJs')
  current_setting('test.date_f',   true)::date,
  'sent'
);

do $$
begin
  perform public.record_missed_orders_for_day(
    current_setting('test.date_f', true)::date);
end $$;

select is(
  (select count(*)::int
     from public.audit_log
    where store_id = current_setting('test.store_f', true)::uuid
      and action   = 'Order missed'
      and detail   = 'bjs order missed (2026-04-27)'),
  0,
  'F: case-insensitive vendor-name match — lowercase ''bjs'' schedule + uppercase ''BJs'' PO suppress the insert'
);


-- ─── Arm G: vendor_id NULL fallback for item_ref ──────────────
-- store_g = Frederick (different date than arm D), p_date = 2026-04-20.
-- order_schedule row has vendor_id=NULL and vendor_name='ACME'; no
-- purchase_orders match. The RPC must INSERT one audit_log row whose
-- item_ref = 'vendor:ACME' (NOT 'vendor:' empty string). Pins the
-- `coalesce(os.vendor_id::text, os.vendor_name)` expression at
-- migration line 168 — a future refactor that drops the coalesce
-- would silently produce 'vendor:' here.
insert into public.order_schedule
  (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_g',  true)::uuid,
  'Monday',
  NULL,
  'ACME',
  'Tuesday'
);

do $$
begin
  perform public.record_missed_orders_for_day(
    current_setting('test.date_g', true)::date);
end $$;

select is(
  (select item_ref
     from public.audit_log
    where store_id = current_setting('test.store_g', true)::uuid
      and action   = 'Order missed'
      and detail   = 'ACME order missed (2026-04-20)'),
  'vendor:ACME',
  'G: vendor_id NULL fallback — item_ref is ''vendor:ACME'' (from coalesce of vendor_name, NOT empty string)'
);


select * from finish();
rollback;
