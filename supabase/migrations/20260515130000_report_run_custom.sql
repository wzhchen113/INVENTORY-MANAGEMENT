-- ============================================================
-- Spec 037 — Reports: Custom SQL template runner.
--
-- public.report_run_custom(p_store_id uuid, p_params jsonb) returns jsonb
--
-- Sandboxes free-text SELECT statements supplied by a privileged caller
-- and renders the result in the spec 016 uniform envelope
-- { kpis: [], columns, rows, series: [], _truncated, _row_count }.
--
-- DESIGN NOTES (pinned by the architect §A2-§A12; don't relitigate post-impl):
--
-- • Five-guard sandbox (architect §4 / PM §A2):
--     1. SELECT-only via `set local transaction_read_only = on`
--     2. Per-statement timeout: ARCHITECTURAL CAVEAT — `set local
--        statement_timeout = '5s'` is set inside the function body but
--        Postgres does NOT enforce it on inner dynamic EXECUTE in
--        plpgsql; the timeout is only checked at the OUTER statement
--        boundary (the RPC call itself). In production, the
--        `authenticated` role's connection-level default
--        `statement_timeout = 8s` (set at role config time, applied at
--        connection startup) IS the operative wall-clock budget for
--        the entire RPC call including all of the runner's inner SQL.
--        The runner's `set local` line stays for two reasons:
--        documentation of intent + a tightening hook for a future
--        wrapper that calls the runner with a pre-armed timeout. The
--        practical budget is 8s, not 5s. See pgTAP arm 8 for the
--        end-to-end demonstration via a SESSION-level timeout set
--        outside the call.
--     3. Result-row cap via `LIMIT 1001` outer wrap (over-fetch by one;
--        keep first 1000, set `_truncated: true`)
--     4. RLS enforced via `security invoker` (caller UID + every
--        `public.*` policy's `auth.uid()` / `auth_can_see_store()` check)
--     5. Schema lockout via existing GRANTs (no `pg_*`, no `auth.*`)
--   No lexical SQL parsing anywhere — Postgres permissions + transaction
--   flags are ground truth. See §A2 grid in the spec for the
--   defense-in-depth justification of the no-regex-blacklist choice.
--
-- • Two privilege gates at entry, BEFORE the inner begin/exception block:
--     - `auth_can_see_store(p_store_id)` → 42501 with
--       'Not authorized for store %' (mirrors velocity / vendor / waste /
--       variance / COGS runners verbatim)
--     - `auth_is_privileged()` → 42501 with
--       'Custom SQL requires admin privilege' (NEW gate, first runner
--       with a per-role check beyond store visibility — operators with
--       plain 'user' role cannot run custom SQL even on stores they
--       can see; the audience for free-text SQL is admin/master/
--       super_admin only)
--   Load-bearing ordering: both raise 42501 from OUTSIDE the inner
--   `begin ... exception ... end` sandbox so the
--   `when insufficient_privilege` arm doesn't rewrite our gate raises
--   into the generic 'access denied to non-public schema' message.
--
-- • Sanitization wall (architect §5 / PM §A error-handling). Every
--   Postgres exception class from the wrapped EXECUTE maps to a fixed
--   caller-safe message. The raw SQLERRM is logged via `RAISE LOG`
--   (visible via `supabase logs`) but never reaches the caller. Reviewers:
--   do NOT pass SQLERRM through — same shape as spec 028's escapeHtml
--   posture (every interpolated user-facing string from a fixed
--   allowlist).
--
-- • Envelope shape (architect §6):
--     - `kpis`: always `[]`. Custom SQL has no canonical KPI contract.
--     - `series`: always `[]`. v1 does not infer time-series from
--       arbitrary SQL (out of scope per PM).
--     - `columns`: derived from the first row's `jsonb_object_keys`
--       WITH ORDINALITY (preserves SELECT-output column order). Empty
--       result short-circuits to `columns: []` — the detail frame's
--       existing `// 0 rows` panel handles the display.
--     - `rows`: array of objects keyed by the SELECT's output column
--       names. Values serialized via `to_jsonb()` (native — integers
--       as numbers, dates as ISO strings, etc.). No server-side
--       to_char() formatting because we don't know which columns are
--       currency / quantity / count.
--     - `_truncated`: true when underlying query produced ≥ 1001 rows
--       (we keep the first 1000).
--     - `_row_count`: actual row count after truncation. Lets the FE
--       render "1000 rows" / "47 rows" without a second .length read.
--
-- • Column derivation strategy (architect §6 / option (c)): keys from
--   the first row via `jsonb_object_keys WITH ORDINALITY`. The
--   ordinality preserves Postgres's serialization order of the record
--   which matches the SELECT's output-column order. (a) `pg_typeof`
--   introspection doesn't work cleanly with EXECUTE-into-jsonb; (b)
--   temp-table introspection was rejected for compatibility with
--   `security invoker` semantics. `key` == `label` (no normalization);
--   `align: null` (the frame falls back to left-align).
--
-- • `security invoker` is non-negotiable (architect §7). Switching to
--   `security definer` would expose every cross-store row to any admin
--   who can write SQL — destroys the per-tenant boundary. The
--   `auth_is_privileged()` gate controls ACCESS to the runner; RLS
--   controls WHAT the runner can see.
--
-- • The two helper functions `auth_can_see_store` and `auth_is_privileged`
--   are themselves `security definer set search_path = public, auth` per
--   `20260509000000_multi_brand_schema_rls.sql:235-239`. They're safely
--   callable from within an invoker-scoped function (the role check is
--   internal and doesn't expose auth schema reads to the caller).
--
-- • The 1001 / 1000 dance keeps result-cap O(1): over-fetch by one,
--   slice off the final element if present, set `_truncated`. We
--   don't pre-count the underlying query.
--
-- • The `coalesce(jsonb_agg(...), '[]'::jsonb)` wrap is the empty-result
--   short-circuit — 0 underlying rows produces an empty array rather
--   than NULL, so `rows` is always `[]` not `null`.
--
-- • No prep-recipe / recursive CTE. Custom SQL is user-authored — the
--   runner does not add joins, CTEs, or rewrites. Future contributors:
--   do NOT mimic the COGS / variance recursive-CTE patterns here.
--
-- • Grants/revokes mirror spec 016 convention: revoke from public,
--   anon; grant to authenticated. Per-role gating happens inside the
--   function body (the privilege gate above), keeping the dispatcher
--   grant uniform across all six template runners. Anon revoke covered
--   by `reports_anon_revoke.test.sql` (extended in this spec from
--   plan(11) to plan(12)).
-- ============================================================

create or replace function public.report_run_custom(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sql         text;
  v_wrapped     text;
  v_rows        jsonb;
  v_columns     jsonb;
  v_truncated   boolean := false;
  v_row_count   integer;
  v_first_row   jsonb;
begin
  -- (1) AUTH GATE — store visibility. First statement; mirrors the
  -- velocity / vendor / waste / variance / COGS runners byte-for-byte.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) PRIVILEGE GATE — NEW for spec 037. Custom SQL execution is
  -- privileged-only (admin or super_admin per spec 027). Plain 'user'
  -- members of a store they can see still get 42501 from this gate.
  -- LOAD-BEARING: this raise happens BEFORE the inner `begin ... exception`
  -- block so the sandbox's `when insufficient_privilege` arm does NOT
  -- catch and rewrite this message.
  if not public.auth_is_privileged() then
    raise exception 'Custom SQL requires admin privilege'
      using errcode = '42501';
  end if;

  -- (3) PARAM EXTRACTION. Whitespace-only also fails — required-param
  -- semantics; the FE modal validates non-empty too but the server
  -- is the authority.
  v_sql := trim(coalesce(p_params->>'sql', ''));
  if v_sql = '' then
    raise exception 'Custom SQL: sql parameter required'
      using errcode = '22023';
  end if;

  -- (4) SANDBOXED EXECUTION. Wrap the user SQL in an outer SELECT that
  -- aggregates up to 1001 rows into a single jsonb scalar, then
  -- EXECUTE INTO a single jsonb destination. This idiom sidesteps the
  -- PL/pgSQL "EXECUTE returns recordset of unknown shape" problem the
  -- spec flagged — we never need a typed record variable.
  --
  -- The `coalesce(jsonb_agg(...), '[]'::jsonb)` wraps the aggregate so
  -- a zero-row underlying result returns `[]` (empty jsonb array) not
  -- NULL. The `_outer_row` alias is the conventional ".*" rebind for
  -- record-as-jsonb shape.
  --
  -- The inner `begin ... exception ... end` block catches every
  -- Postgres error class and re-raises with a sanitized caller-safe
  -- message (the §5 sanitization wall). The raw SQLERRM is logged via
  -- `RAISE LOG` so operators can debug from `supabase logs`.
  begin
    -- Guard 1 — read-only enforcement. Any DDL/DML/COPY/TRUNCATE
    -- inside v_sql fails with Postgres's native
    -- `25006 "read_only_sql_transaction"` error, which the exception
    -- arm below maps to the user-facing sanitized message.
    set local transaction_read_only = on;

    -- Guard 2 — per-statement timeout. ARCHITECTURAL CAVEAT (see header):
    -- `SET LOCAL statement_timeout` does NOT enforce inside a plpgsql
    -- function body — Postgres only re-checks the timeout at outer
    -- statement boundaries. The authoritative budget is the
    -- `authenticated` role's connection-level 8s default. This line
    -- stays as intent documentation + a tightening hook for a future
    -- wrapper. The `when query_canceled` arm below STILL fires when
    -- the role-level 8s (or any externally-set session timeout) trips.
    set local statement_timeout = '5s';

    -- Guard 3 — wrap + cap. LIMIT 1001 lets us detect "underlying
    -- query produced >= 1001 rows" with a single comparison after.
    -- The 1001st element is discarded if present and `_truncated` is
    -- set to true (see below).
    v_wrapped := format(
      'select coalesce(jsonb_agg(to_jsonb(_outer_row)), ''[]''::jsonb)
         from (
           select * from (%s) _spec037_user_sql limit 1001
         ) as _outer_row',
      v_sql
    );

    execute v_wrapped into v_rows;
  exception
    -- Guard 2 trips here.
    when query_canceled then
      raise log 'report_run_custom: timeout: %', sqlerrm;
      raise exception 'Custom SQL: timed out after 5s'
        using errcode = '57014';
    -- Guard 1 trips here for DML/DDL.
    when read_only_sql_transaction then
      raise log 'report_run_custom: read-only violation: %', sqlerrm;
      raise exception 'Custom SQL: only SELECT statements are allowed'
        using errcode = '25006';
    -- RLS denial OR cross-schema attempt (e.g. auth.users) trips here.
    -- Load-bearing: this arm does NOT catch our two entry gates
    -- (auth_can_see_store / auth_is_privileged) because those raise
    -- BEFORE the inner begin block.
    when insufficient_privilege then
      raise log 'report_run_custom: permission denied: %', sqlerrm;
      raise exception 'Custom SQL: access denied to non-public schema'
        using errcode = '42501';
    when undefined_table then
      raise log 'report_run_custom: undefined table: %', sqlerrm;
      raise exception 'Custom SQL: table not found (check the table name)'
        using errcode = '42P01';
    when undefined_column then
      raise log 'report_run_custom: undefined column: %', sqlerrm;
      raise exception 'Custom SQL: column not found (check the column name)'
        using errcode = '42703';
    when syntax_error then
      raise log 'report_run_custom: syntax error: %', sqlerrm;
      raise exception 'Custom SQL: syntax error (check the query)'
        using errcode = '42601';
    when others then
      -- Catch-all. Logs the SQLSTATE so ops can pattern-match recurring
      -- failures and add a typed arm in a follow-up spec if needed.
      raise log 'report_run_custom: unhandled (sqlstate=%): %',
        sqlstate, sqlerrm;
      -- Architect spec 037 S3 ack: errcode in the user-reserved P05xx
      -- range to avoid collision with `assert_not_last_of_role` (spec
      -- 031) and the variance runner (spec 018), both of which use the
      -- default plpgsql `RAISE EXCEPTION` SQLSTATE 'P0001'. db.ts's
      -- error-message allowlist matches on prefix, not SQLSTATE, so this
      -- change is forward-compatible with the existing toast routing.
      raise exception 'Custom SQL: run failed — check the server logs'
        using errcode = 'P0501';
  end;

  -- (5) TRUNCATION DETECTION. We over-fetched by one; if v_rows has
  -- > 1000 elements, set the flag and trim. The slicing is done by
  -- jsonb_array_elements WITH ORDINALITY so ordinality preserves the
  -- planner's row order (or the user's ORDER BY if they supplied one).
  v_row_count := coalesce(jsonb_array_length(v_rows), 0);
  if v_row_count > 1000 then
    v_truncated := true;
    select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(elem, ord)
     where ord <= 1000;
    v_row_count := 1000;
  end if;

  -- (6) COLUMN DERIVATION. Keys from the first row (architect §6 /
  -- option (c)). `with ordinality` preserves Postgres's serialization
  -- order which matches the SELECT's output-column order. Empty
  -- result short-circuits to `columns: []` — the detail frame's
  -- existing "0 rows" panel handles display.
  if v_row_count = 0 then
    v_columns := '[]'::jsonb;
  else
    v_first_row := v_rows->0;
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'key',   k,
        'label', k,
        'align', null
      ) order by ord
    ), '[]'::jsonb)
      into v_columns
      from jsonb_object_keys(v_first_row) with ordinality as t(k, ord);
  end if;

  -- (7) FINAL ENVELOPE. `kpis` and `series` are always `[]` for custom;
  -- `_truncated` and `_row_count` are new keys for spec 037 only
  -- (other runners do not emit them). The optional FE type at
  -- `src/types/index.ts:546-561` admits both via optional fields.
  return jsonb_build_object(
    'kpis',       '[]'::jsonb,
    'columns',    v_columns,
    'rows',       v_rows,
    'series',     '[]'::jsonb,
    '_truncated', v_truncated,
    '_row_count', v_row_count
  );
end;
$$;

revoke execute on function public.report_run_custom(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_custom(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'custom' arm ──────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher in
-- full. The 'stub' / 'cogs' / 'variance' / 'waste' / 'vendor' / 'velocity'
-- arms and the not_implemented fallback are preserved exactly as in
-- `20260515120000_report_run_velocity.sql:444-486` so callers see no
-- surface drift. Signature unchanged — `create or replace` handles
-- the swap without breaking outstanding grants. The new 'custom' arm
-- slots immediately after 'velocity' (placement convention: live arms
-- in the order their templates landed).
create or replace function public.report_run(
  p_template_id text,
  p_store_id    uuid,
  p_params      jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  case p_template_id
    when 'stub' then
      return public.report_run_stub(p_store_id, p_params);
    when 'cogs' then
      return public.report_run_cogs(p_store_id, p_params);
    when 'variance' then
      return public.report_run_variance(p_store_id, p_params);
    when 'waste' then
      return public.report_run_waste(p_store_id, p_params);
    when 'vendor' then
      return public.report_run_vendor(p_store_id, p_params);
    when 'velocity' then
      return public.report_run_velocity(p_store_id, p_params);
    when 'custom' then
      return public.report_run_custom(p_store_id, p_params);
    else
      return jsonb_build_object(
        'kpis',     '[]'::jsonb,
        'columns',  '[]'::jsonb,
        'rows',     '[]'::jsonb,
        'series',   null,
        '_status',  'not_implemented',
        '_message', 'Runner coming soon · definition saved'
      );
  end case;
end;
$$;

revoke execute on function public.report_run(text, uuid, jsonb) from public, anon;
grant  execute on function public.report_run(text, uuid, jsonb) to authenticated;
