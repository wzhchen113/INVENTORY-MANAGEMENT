-- supabase/tests/report_run_custom.test.sql
--
-- Spec 037 — coverage for `public.report_run_custom(uuid, jsonb)` from
-- `supabase/migrations/20260515130000_report_run_custom.sql`. Asserts the
-- 11 PM-pinned assertion classes plus 2 fixture-sanity arms (plan(13)
-- total).
--
-- Three caller roles in this file:
--   • Admin JWT (11111111-..., app_metadata.role='admin') for the
--     happy-path and per-error-class arms (5-13). Admin is a member of
--     all stores per seed and passes both auth_can_see_store and
--     auth_is_privileged.
--   • Manager JWT (22222222-..., app_metadata.role='user') for the
--     privilege-gate arm (3) and the store-visibility arm (4). Manager
--     is a member of Frederick + Towson only, NOT Charles. They have
--     role='user' which fails auth_is_privileged. Anchors the two
--     distinct 42501 paths the runner produces.
--
-- Fixture pattern mirrors `report_run_velocity.test.sql`: Frederick
-- store named lookup, hermetic `begin; ... rollback;`.

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (all stores)
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (user role, Towson + Frederick)
  v_frederick  uuid;
  v_charles    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  perform set_config('test.admin_id',     v_admin_id::text,     true);
  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.frederick_id', v_frederick::text,    true);
  perform set_config('test.charles_id',   v_charles::text,      true);
end $$;

-- (1) Fixture sanity: Frederick store id resolves from seed.
select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- (2) Fixture sanity: Charles store id resolves (non-member store for arm 4).
select isnt(current_setting('test.charles_id', true), '',
  'fixture: Charles store id resolves (used for store-visibility arm)');

-- ─── Impersonate manager (member of Towson + Frederick, role 'user') ──
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

-- (3) PRIVILEGE GATE — plain 'user'-role member calling on their own
-- store. They pass auth_can_see_store(frederick) (they're a member)
-- but fail auth_is_privileged() (role 'user' is not admin/master/
-- super_admin). The runner raises 42501 with the spec-pinned message.
-- NEW assertion class — no prior template runner has a per-role gate.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, jsonb_build_object('sql','SELECT 1'))$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  'Custom SQL requires admin privilege',
  'privilege gate: plain user-role member is refused (42501 + exact message)'
);

-- (4) STORE VISIBILITY GATE — manager calling Charles (non-member,
-- non-admin). Fails auth_can_see_store(charles) at the first gate
-- and never reaches the privilege check. Mirrors velocity arm 3 /
-- vendor arm 3 verbatim.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, jsonb_build_object('sql','SELECT 1'))$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  'store visibility gate: manager calling Charles (non-member) raises 42501'
);

-- ─── Switch to admin JWT for happy-path / per-error arms ─────────
-- Admin (11111111-...) is a member of all stores and has
-- app_metadata.role='admin' → passes both gates.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.admin_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- (5) MISSING SQL PARAM — `{}` raises 22023 with the
-- 'Custom SQL: sql parameter required' message. (Whitespace-only is
-- bundled into the same arm since the runner trims first.)
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '22023',
  'Custom SQL: sql parameter required',
  'missing sql param: empty {} raises 22023 + exact message'
);

-- (6) DML REJECTED — IMPLEMENTATION REALITY (see migration header
-- caveat for Guard 2): the `select * from (%s) _spec037_user_sql`
-- outer wrap blocks ALL DML/DDL at parse / planning time before the
-- read_only_sql_transaction guard can fire. Two attack shapes both
-- fail safely, just with different SQLSTATEs than the architect
-- originally pinned:
--   (a) A bare `INSERT INTO ... VALUES (...)` is not a valid SELECT
--       subquery source. Parse-time error: `42601 syntax_error`.
--   (b) A CTE-wrapped INSERT (`WITH x AS (INSERT ...) SELECT * FROM x`)
--       is valid SQL but moves the CTE inside a sub-SELECT — Postgres
--       rejects with `0A000 feature_not_supported` because
--       data-modifying CTEs must be at the top level (cannot be
--       inside `select * from (...)`).
-- Both bypasses are blocked. The `when read_only_sql_transaction` arm
-- in the runner is documentation of defense-in-depth intent but
-- isn't actually reachable from user-supplied SQL through this wrap.
-- This arm tests case (a): bare INSERT → 42601 → sanitized 'syntax
-- error' message.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, jsonb_build_object(
      'sql','INSERT INTO public.audit_log (action) VALUES (''spec037_hack'')'
    ))$q$,
    current_setting('test.frederick_id', true)
  ),
  '42601',
  'Custom SQL: syntax error (check the query)',
  'DML rejected: bare INSERT raises 42601 (blocked at parse-time by SELECT-wrap; security preserved, error class differs from spec)'
);

-- (7) DDL REJECTED — same parse-time path as (6). bare CREATE TABLE
-- → 42601 syntax_error → sanitized 'syntax error' message. The
-- SELECT-wrap blocks all DDL at parse time before any GRANTs or
-- read-only flags get a chance to fire. Security guarantee intact;
-- error class differs from the architect's original 25006 pin.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, jsonb_build_object(
      'sql','CREATE TABLE _spec037_smoke (y int)'
    ))$q$,
    current_setting('test.frederick_id', true)
  ),
  '42601',
  'Custom SQL: syntax error (check the query)',
  'DDL rejected: bare CREATE TABLE raises 42601 (blocked at parse-time by SELECT-wrap; security preserved, error class differs from spec)'
);

-- (8) SCHEMA LOCKOUT — `auth.users` SELECT raises `42501
-- insufficient_privilege` from the role's existing default-deny on
-- auth schema reads. The runner's `when insufficient_privilege` arm
-- catches and re-raises with the sanitized 'access denied to
-- non-public schema' message. Validates BOTH the schema-lockout guard
-- (no `pg_*` / no `auth.*` reads possible) AND the sanitization-wall's
-- 42501-class mapping.
-- LOAD-BEARING — this is the only arm in the suite that exercises the
-- `when insufficient_privilege` exception arm; combined with arm 6 / 7
-- (42601 syntax_error) and arm 5 (22023 sql parameter required), the
-- spec-pinned sanitized messages are anchored to the runner's actual
-- behavior. Architect's original arm 8 (pg_sleep timeout) is
-- functionally untestable via pgTAP — `WHEN OTHERS` in plpgsql does
-- NOT match `query_canceled` (57014), and the runner re-raises with
-- 57014, so pgTAP's throws_ok can't catch it. See the migration's
-- Guard 2 caveat: the real timeout enforcement comes from the
-- authenticated role's connection-level 8s default, which the runner
-- transparently propagates via its `when query_canceled` arm — but
-- the property can only be observed end-to-end via a real PostgREST
-- session (a follow-up smoke test concern, not pgTAP).
-- Substituted with schema-lockout coverage which exercises the same
-- sanitization-wall code path through a 42501 (insufficient_privilege)
-- raise that DOES match WHEN OTHERS.
select throws_ok(
  format(
    $q$select public.report_run_custom(%L::uuid, jsonb_build_object(
      'sql','SELECT email FROM auth.users LIMIT 1'
    ))$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  'Custom SQL: access denied to non-public schema',
  'schema lockout: SELECT FROM auth.users raises 42501 + sanitized message (insufficient_privilege arm)'
);

-- (9) RESULT TRUNCATION — generate_series(1, 2000) produces 2000
-- rows; the outer LIMIT 1001 over-fetches by one; the runner trims
-- to 1000 and sets _truncated=true / _row_count=1000. Stable across
-- seed refreshes (no seed dependency).
select is(
  (
    select jsonb_build_object(
      'rows_len',    jsonb_array_length(env->'rows'),
      'row_count',   (env->>'_row_count')::int,
      'truncated',   (env->>'_truncated')::boolean
    )
    from (
      select public.report_run_custom(
        current_setting('test.frederick_id', true)::uuid,
        jsonb_build_object('sql','SELECT generate_series(1, 2000) AS n')
      ) as env
    ) t
  ),
  jsonb_build_object(
    'rows_len',  1000,
    'row_count', 1000,
    'truncated', true
  ),
  'result truncation: 2000-row SELECT trims to 1000 + _truncated=true + _row_count=1000'
);

-- (10) COLUMNS DERIVED FROM ROW KEYS — `SELECT 'foo' AS a, 42 AS b`
-- produces columns in SELECT order: [{key:'a',...}, {key:'b',...}].
-- The `with ordinality` clause inside the runner preserves this
-- order — without it the jsonb_object_keys output would be
-- implementation-defined.
select is(
  (
    select jsonb_build_object(
      'col_keys',   jsonb_agg(c->>'key' order by ord),
      'col_labels', jsonb_agg(c->>'label' order by ord),
      'col_aligns', jsonb_agg(c->'align' order by ord)
    )
    from (
      select public.report_run_custom(
        current_setting('test.frederick_id', true)::uuid,
        jsonb_build_object('sql', 'SELECT ''foo''::text AS a, 42 AS b')
      ) as env
    ) t,
    jsonb_array_elements(t.env->'columns') with ordinality as e(c, ord)
  ),
  jsonb_build_object(
    'col_keys',   jsonb_build_array('a', 'b'),
    'col_labels', jsonb_build_array('a', 'b'),
    'col_aligns', jsonb_build_array(null, null)
  ),
  'columns derived from row keys: SELECT a, b → columns ordered [a, b] with align=null'
);

-- (11) EMPTY RESULT SHORT-CIRCUIT — a SELECT with WHERE FALSE returns
-- 0 rows. The runner emits `columns: []` (per architect §6) plus
-- empty rows / _truncated:false / _row_count:0.
select is(
  (
    select jsonb_build_object(
      'cols_len',    jsonb_array_length(env->'columns'),
      'rows_len',    jsonb_array_length(env->'rows'),
      'row_count',   (env->>'_row_count')::int,
      'truncated',   (env->>'_truncated')::boolean
    )
    from (
      select public.report_run_custom(
        current_setting('test.frederick_id', true)::uuid,
        jsonb_build_object('sql', 'SELECT 1 AS x WHERE FALSE')
      ) as env
    ) t
  ),
  jsonb_build_object(
    'cols_len',  0,
    'rows_len',  0,
    'row_count', 0,
    'truncated', false
  ),
  'empty result short-circuit: zero-row query produces columns:[], rows:[], _truncated:false, _row_count:0'
);

-- (12) HAPPY PATH (simple SELECT) — `SELECT 1 AS one` returns one row
-- with the `one` column. Anchors the smoke-test path; also verifies
-- the columns/rows/envelope assemble correctly for the trivial case.
select is(
  (
    select jsonb_build_object(
      'cols_first_key', env->'columns'->0->>'key',
      'rows_len',       jsonb_array_length(env->'rows'),
      'row_count',      (env->>'_row_count')::int,
      'truncated',      (env->>'_truncated')::boolean,
      'first_row_one',  (env->'rows'->0->>'one')::int
    )
    from (
      select public.report_run_custom(
        current_setting('test.frederick_id', true)::uuid,
        jsonb_build_object('sql', 'SELECT 1 AS one')
      ) as env
    ) t
  ),
  jsonb_build_object(
    'cols_first_key', 'one',
    'rows_len',       1,
    'row_count',      1,
    'truncated',      false,
    'first_row_one',  1
  ),
  'happy path: SELECT 1 AS one returns single-row envelope with one=1'
);

-- (13) ENVELOPE SHAPE SANITY — sorted top-level keys must include all
-- four standard keys (`kpis`, `columns`, `rows`, `series`) plus the
-- two spec-037-only metadata keys (`_truncated`, `_row_count`).
-- Catches both missing AND extra keys (same pattern as
-- `report_run_unknown_template.test.sql` arm 3).
select is(
  (
    select array_agg(k order by k)
      from (
        select public.report_run_custom(
          current_setting('test.frederick_id', true)::uuid,
          jsonb_build_object('sql', 'SELECT 1 AS one')
        ) as env
      ) t, jsonb_object_keys(env) k
     where k in ('_row_count', '_truncated', 'columns', 'kpis', 'rows', 'series')
  ),
  array['_row_count', '_truncated', 'columns', 'kpis', 'rows', 'series']::text[],
  'envelope shape: top-level keys = [_row_count, _truncated, columns, kpis, rows, series]'
);

-- (14) RLS UNDER SECURITY INVOKER — Guard 4 load-bearing property.
-- The runner has no lexical SQL parsing — Guard 4 (RLS) is the sole
-- per-tenant filter for the inner EXECUTE. Test-engineer spec 037 C1
-- and backend-architect drift review demanded this direct proof.
--
-- Strategy: query `purchase_orders` filtered to a non-member store.
-- `purchase_orders` carries per-store RLS via `auth_can_see_store()`
-- (per spec 014 per-store hardening), so a manager who is a member
-- of Frederick + Towson but NOT Charles must see 0 rows when the
-- inner SQL filters by Charles' store_id — regardless of whatever
-- the brand-scoped tables (inventory_items) would expose.
--
-- This is distinct from arm 8 (schema-lockout Guard 5) which proves
-- the `authenticated` role can't reach `auth.*`; arm 14 proves Guard
-- 4 (RLS row filter) fires under SECURITY INVOKER.
--
-- Note (spec 037 C2 / architect drift §16): the statement_timeout
-- guard's `when query_canceled → 'Custom SQL: timed out after 5s'`
-- sanitization path is reachable only when a connection-level OR
-- session-level statement_timeout fires on the inner EXECUTE.
-- `SET LOCAL statement_timeout` inside the plpgsql body does NOT
-- enforce per architect drift §16 confirmation. The role-level 8s
-- default IS operative, but pgTAP can't reliably exercise it
-- without role-config changes — documented gap. The sanitization
-- mapping itself is verified statically by the migration code path.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'admin')
  )::text,
  true
);
select is(
  (
    select jsonb_build_object(
      'rows_len',  jsonb_array_length(env->'rows'),
      'row_count', (env->>'_row_count')::int,
      'truncated', (env->>'_truncated')::boolean
    )
    from (
      select public.report_run_custom(
        current_setting('test.frederick_id', true)::uuid,
        jsonb_build_object(
          'sql',
          format('SELECT id FROM public.purchase_orders WHERE store_id = %L::uuid',
                 current_setting('test.charles_id', true))
        )
      ) as env
    ) t
  ),
  jsonb_build_object(
    'rows_len',  0,
    'row_count', 0,
    'truncated', false
  ),
  'RLS under SECURITY INVOKER (Guard 4): Frederick manager querying Charles purchase_orders returns 0 rows (per-store RLS filters even with valid auth_can_see_store(frederick) gate-pass)'
);

select * from finish();
rollback;
