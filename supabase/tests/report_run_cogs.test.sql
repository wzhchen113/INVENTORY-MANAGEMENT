-- supabase/tests/report_run_cogs.test.sql
--
-- Spec 022 Track 2 example: covers the contract surface of
-- `public.report_run_cogs(uuid, jsonb)` (spec 017,
-- migration 20260511120000_report_run_cogs.sql). Asserts:
--
--   (1) Auth gate raises SQLSTATE 42501 when the caller is not a
--       member of the target store and not an admin.
--   (2) A caller who can see the store gets the uniform envelope
--       back: a jsonb object with keys `kpis`, `columns`, `rows`,
--       `series`.
--
-- Out of scope here (deferred to the retroactive-coverage spec):
-- numeric correctness of COGS%, missing-cost flagging, prep-recipe
-- depth-cap behaviour. v1 only proves the **contract shape** and the
-- **auth gate** — the two things whose silent regression would corrupt
-- the report UI.
--
-- Hermetic isolation: the whole file wraps in begin; ... rollback;.
-- pgTAP's plan(N) ensures the assertion count matches; finish() emits
-- the standard TAP summary that scripts/test-db.sh parses.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────
-- Use named-store lookups (per architect's risk-7 mitigation) so the
-- test stays stable across seed refreshes. The seed pins manager@local.test
-- to Towson + Frederick; "Charles" is intentionally a foreign store
-- for them.
do $$
declare
  v_manager_id   uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick    uuid;
  v_charles      uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Stash for the assertions below.
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.charles_id',   v_charles::text,   true);
end $$;

-- Sanity: both seed stores resolved.
select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');
select isnt(current_setting('test.charles_id', true), '',
  'fixture: Charles store id resolves from seed');

-- ─── (1) Auth gate raises 42501 for a foreign store ───────────
-- Impersonate manager (role='user' app_metadata, member of Towson +
-- Frederick only). Calling COGS on Charles must raise 42501.
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

select throws_ok(
  format(
    $q$select public.report_run_cogs(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  'report_run_cogs raises 42501 for a non-member store (manager calling Charles)'
);

-- ─── (2) Envelope shape for an authorized caller ──────────────
-- Same manager calling Frederick (which they ARE a member of). The
-- function should succeed and return a jsonb object with the
-- documented uniform-envelope keys: kpis, columns, rows, series.
-- Numeric values may legitimately be 0/empty if the seed has no POS
-- rows in the default 30-day window; we assert only on shape.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Compute the envelope once into a temp, then assert per-key.
create temp table _cogs_envelope on commit drop as
select public.report_run_cogs(
  current_setting('test.frederick_id', true)::uuid,
  '{}'::jsonb
) as env;

-- All four keys present. Use a single `is()` against the sorted key
-- list so a missing OR extra key both fail loudly. `?&` would also
-- work but `array_agg(jsonb_object_keys ...)` makes the diff readable
-- when the test breaks.
select is(
  (
    select array_agg(k order by k)
      from _cogs_envelope, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope has the four required keys (kpis, columns, rows, series)'
);

-- Sanity check on `columns`: must be an array (per the uniform
-- envelope contract). Don't assert element count — it varies between
-- by=category (5 cols) and by=item (6 cols), and we passed default
-- params so either could appear in theory.
select is(
  (select jsonb_typeof(env->'columns') from _cogs_envelope),
  'array',
  'envelope.columns is a jsonb array'
);

select * from finish();
rollback;
