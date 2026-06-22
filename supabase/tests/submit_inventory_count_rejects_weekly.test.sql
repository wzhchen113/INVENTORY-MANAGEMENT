-- supabase/tests/submit_inventory_count_rejects_weekly.test.sql
--
-- Spec 098 §10 regression — the column CHECK now admits 'weekly', but the
-- GENERIC admin RPC public.submit_inventory_count MUST keep rejecting
-- kind='weekly' (defense-in-depth allowlist, design §0 point 1). 'weekly'
-- is a staff-cadence concept that goes through submit_weekly_count only.
-- Without this guard the admin count form could mint weekly rows.
--
-- The generic RPC's in-body allowlist raises 22023 for any kind outside
-- ('spot','open','mid_shift','close'), so 'weekly' raises 22023 — distinct
-- from a raw CHECK violation (which would be 23514).
--
-- Hermetic: begin; ... rollback;

begin;
create extension if not exists pgtap;

select plan(2);

do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_item       uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_item from public.inventory_items where store_id = v_frederick limit 1;
  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.item_id',      v_item::text,       true);
end $$;

select isnt(current_setting('test.item_id', true), '',
  'fixture: a Frederick inventory_item resolves from seed');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.submit_inventory_count(
         gen_random_uuid(),
         %L::uuid,
         'weekly',
         now(),
         'submitted',
         %s::jsonb,
         null)$q$,
    current_setting('test.frederick_id', true),
    format('[{"item_id":%L,"actual_remaining":5}]', current_setting('test.item_id', true))
  ),
  '22023',
  'generic submit_inventory_count still rejects kind=weekly (allowlist intact)'
);

select * from finish();
rollback;
