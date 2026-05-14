-- supabase/tests/report_run_unknown_template.test.sql
--
-- Spec 023 / A1 — retroactive coverage for spec 016 dispatcher contract.
--
-- The dispatcher `public.report_run(text, uuid, jsonb)` at
-- `supabase/migrations/20260510120000_report_runs.sql:222-253` (and the
-- updated dispatcher carrying the 'variance' arm at
-- `20260512120000_report_run_variance.sql:628-661`) documents a hard contract
-- for unknown templates: rather than `RAISE EXCEPTION`, the dispatcher MUST
-- return the uniform "not_implemented" envelope so the frontend frame can
-- render a graceful "Runner coming soon" branch without bespoke UI per
-- template.
--
-- The envelope shape (`20260510120000_report_runs.sql:62-66`):
--   { "kpis": [], "columns": [], "rows": [], "series": null,
--     "_status": "not_implemented",
--     "_message": "Runner coming soon · definition saved" }
--
-- This test pins the load-bearing contract field (`_status`) and the
-- standard envelope keys. Future-proof — even if `_message` copy changes,
-- the FE branch still works as long as `_status` says `not_implemented`.

begin;
create extension if not exists pgtap;

select plan(4);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── impersonate manager (member of Frederick) ────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Capture the envelope into a temp table so multiple assertions read
-- the same RPC invocation.
create temp table _env on commit drop as
select public.report_run(
  'not_a_real_template',
  current_setting('test.frederick_id', true)::uuid,
  '{}'::jsonb
) as env;

-- ─── (1) Envelope is a jsonb object (shape sanity) ────────────
select is(
  (select jsonb_typeof(env) from _env),
  'object',
  'unknown template returns a jsonb object (NOT a raise exception)'
);

-- ─── (2) `_status` flag pins the not_implemented contract ─────
select is(
  (select env->>'_status' from _env),
  'not_implemented',
  '_status flag signals unknown template per spec 016 contract'
);

-- ─── (3) Standard envelope keys present and shaped per contract
-- The contract: rows='[]', series=null, kpis='[]', columns='[]'.
-- Asserting on the sorted key list catches both missing AND extra keys.
select is(
  (
    select array_agg(k order by k)
      from _env, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope retains the four standard keys (kpis, columns, rows, series)'
);

select * from finish();
rollback;
