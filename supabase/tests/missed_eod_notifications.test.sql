-- supabase/tests/missed_eod_notifications.test.sql
--
-- Spec 121 — pgTAP coverage for the missed-EOD-count notification type shipped
-- in supabase/migrations/20260716000000_missed_eod_notification_type.sql.
--
-- Seven arms (plan(7)):
--   Emitter (arms 1-4):
--     (1) emit_missed_count generates exactly ONE missed_eod notification.
--     (2) the row denormalizes vendor→actor_name + store→store_name, carries the
--         store's brand_id, and actor_user_id IS NULL (no submitter).
--     (3) dedup: a second emit for the same (store, date, vendor) is a no-op
--         (deterministic md5 source_id + (type, source_id) unique index).
--     (4) a DIFFERENT vendor (same store/date) emits a SEPARATE row — the dedup
--         key includes the vendor.
--   Brand scoping (arms 5-7) — inherited spec-120 RLS, no new policy:
--     (5) brand-A admin SEES the brand-A miss.
--     (6) brand-A admin gets ZERO rows for a brand-B miss (RLS denies).
--     (7) super_admin sees BOTH brands' misses.
--
-- NOTE — the post-midnight minutesSinceDeadline correctness case (architect-
-- flagged Critical: a 22:00 deadline read at 00:30 local must read as "passed")
-- is NOT covered here. minutesSinceDeadline is a TS-only helper local to
-- supabase/functions/eod-reminder-cron/index.ts (no SQL surface), so it cannot be
-- pgTAP'd. Its unit coverage is owed to the jest/frontend track via the
-- escapeHtml src/utils-mirror pattern (CLAUDE.md "TS mirror … exclusively for
-- jest coverage"). Flagged in the handoff.
--
-- JWT-impersonation + hermetic begin/rollback pattern copied from
-- submission_notifications.test.sql (spec 120).

begin;
create extension if not exists pgtap;

select plan(7);

-- ─── fixtures ─────────────────────────────────────────────────
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A → super_admin)
  v_brand_a   uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b   uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_a   uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_b   uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  perform set_config('test.admin_id',  v_admin_id::text,  true);
  perform set_config('test.master_id', v_master_id::text, true);
  perform set_config('test.brand_a',   v_brand_a::text,   true);
  perform set_config('test.brand_b',   v_brand_b::text,   true);
  perform set_config('test.store_a',   v_store_a::text,   true);
  perform set_config('test.store_b',   v_store_b::text,   true);
  -- two vendor ids off the seed for the two-vendor dedup arm
  perform set_config('test.vendor_1', (select id::text from public.vendors order by id limit 1), true);
  perform set_config('test.vendor_2', (select id::text from public.vendors order by id offset 1 limit 1), true);
  perform set_config('test.bizdate', current_date::text, true);
end $$;

-- Test-only foreign brand + store (rolled back at end).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 121)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 121)', '1 Foreign Way', 'active', '22:00'
)
on conflict (id) do nothing;


-- ─── Arm (1): emit → exactly one missed_eod for brand-A store ──
-- Runs as postgres (bypasses RLS). Emit a miss for (store_a, vendor_1, date).
select public.emit_missed_count(
  current_setting('test.store_a', true)::uuid,
  current_setting('test.vendor_1', true)::uuid,
  'Coca-Cola (test)',
  current_setting('test.bizdate', true)::date
);

select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id = current_setting('test.store_a', true)::uuid
      and source_id = md5(
        current_setting('test.store_a', true) || '|' ||
        current_setting('test.bizdate', true) || '|' ||
        current_setting('test.vendor_1', true)
      )::uuid),
  1,
  'arm (1): emit_missed_count generates exactly one missed_eod notification'
);

-- ─── Arm (2): denormalization + NULL actor + store brand_id ────
select is(
  (select actor_user_id is null
          and actor_name = 'Coca-Cola (test)'
          and store_name = (select name from public.stores where id = current_setting('test.store_a', true)::uuid)
          and brand_id = current_setting('test.brand_a', true)::uuid
     from public.notifications
    where type = 'missed_eod'
      and source_id = md5(
        current_setting('test.store_a', true) || '|' ||
        current_setting('test.bizdate', true) || '|' ||
        current_setting('test.vendor_1', true)
      )::uuid),
  true,
  'arm (2): miss row denormalizes vendor→actor_name + store→store_name, brand_id from store, actor NULL'
);

-- ─── Arm (3): dedup — re-emit same (store,date,vendor) is a no-op ─
select public.emit_missed_count(
  current_setting('test.store_a', true)::uuid,
  current_setting('test.vendor_1', true)::uuid,
  'Coca-Cola (test)',
  current_setting('test.bizdate', true)::date
);

select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id = current_setting('test.store_a', true)::uuid
      and source_id = md5(
        current_setting('test.store_a', true) || '|' ||
        current_setting('test.bizdate', true) || '|' ||
        current_setting('test.vendor_1', true)
      )::uuid),
  1,
  'arm (3): re-emit for the same (store, date, vendor) is deduped (on conflict do nothing)'
);

-- ─── Arm (4): a different vendor emits a separate row ──────────
select public.emit_missed_count(
  current_setting('test.store_a', true)::uuid,
  current_setting('test.vendor_2', true)::uuid,
  'Pepsi (test)',
  current_setting('test.bizdate', true)::date
);

select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id = current_setting('test.store_a', true)::uuid),
  2,
  'arm (4): a different vendor (same store/date) emits a separate miss (dedup key includes vendor)'
);

-- ─── Arm (5): a brand-B miss (for the RLS arms below) ──────────
select public.emit_missed_count(
  current_setting('test.store_b', true)::uuid,
  current_setting('test.vendor_1', true)::uuid,
  'Coca-Cola (test)',
  current_setting('test.bizdate', true)::date
);

-- brand-A admin SEES the brand-A miss.
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id = current_setting('test.store_a', true)::uuid
      and source_id = md5(
        current_setting('test.store_a', true) || '|' ||
        current_setting('test.bizdate', true) || '|' ||
        current_setting('test.vendor_1', true)
      )::uuid),
  1,
  'arm (5): brand-A admin SEES the brand-A miss (inherited spec-120 RLS)'
);

-- ─── Arm (6): brand-A admin does NOT see the brand-B miss ──────
select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id = current_setting('test.store_b', true)::uuid),
  0,
  'arm (6): brand-A admin gets ZERO rows for a brand-B miss (RLS denies)'
);

-- ─── Arm (7): super_admin sees BOTH brands' misses ────────────
reset role;
update public.profiles set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'super_admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where type = 'missed_eod'
      and store_id in (current_setting('test.store_a', true)::uuid,
                       current_setting('test.store_b', true)::uuid)),
  3,
  'arm (7): super_admin sees BOTH brands misses (2 brand-A + 1 brand-B)'
);

select finish();
rollback;
