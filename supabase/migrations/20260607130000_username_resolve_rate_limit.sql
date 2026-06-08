-- ============================================================
-- Spec 095 (review fix — security Medium-1) — rate limit for username-resolve.
--
-- THE GAP
-- -------
-- The username-resolve edge function gates on a bundle-public client token
-- (EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN ships in `npx expo export`), so the
-- service-token gate stops only callers who never loaded the app — NOT a
-- determined attacker who extracts the token. The backend design
-- (spec §API contract, mitigation (3)) called for "a light per-IP rate limit"
-- but the original implementation shipped without one, leaving a scriptable
-- username→email PII-enumeration surface (security-auditor Medium-1, amplified
-- by the predictable email-local-part backfill, Medium-2).
--
-- WHY DB-BACKED (not in-memory / not Deno KV)
-- -------------------------------------------
-- Edge functions are stateless Deno isolates that scale horizontally — an
-- in-memory counter resets on cold start and is not shared across instances, so
-- it cannot enforce a real per-IP budget. Deno KV is not a guaranteed primitive
-- in the Supabase edge runtime. A small Postgres table + a SECURITY DEFINER RPC
-- (the same model already used for record_missed_orders_for_day and the staff
-- RPCs) gives a single, shared, atomic, testable choke point. The function
-- already holds a service-role client for the username lookup, so the extra
-- round-trip is cheap and on the same connection path.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. username_resolve_rate_limit table — one row per (ip, window_start),
--      holding a request counter for a FIXED 60-second window.
--   2. check_username_resolve_rate_limit(p_ip text) SECURITY DEFINER RPC — an
--      atomic upsert that increments the current window's counter and returns
--      TRUE iff the request is within budget (<= the per-window limit). The
--      window length (60s) and limit (20) are inlined constants; 20 req/min/IP
--      sits inside the design's "~10-30 requests/minute/IP" guidance and is
--      comfortably above the handful of retries a legitimate human login needs
--      while throttling a scripted harvester to ~20 username probes/min.
--   3. prune_username_resolve_rate_limit() housekeeping RPC + a daily pg_cron
--      job so the table does not grow unbounded (rows older than the current
--      window are dead weight).
--
-- ANTI-ORACLE NOTE: the limiter keys on the CLIENT IP, never on the username, so
-- it reveals nothing about whether any specific username exists. When the budget
-- is exceeded the edge function returns HTTP 429 with a generic body — 429 is a
-- per-IP signal ("you are calling too often"), not a per-username signal, so it
-- does not reopen the enumeration oracle the rest of spec 095 closes. The
-- non-429 success path remains ALWAYS 200 { email: string | null }.
--
-- GRANTS: EXECUTE on both RPCs is revoked from public/anon/authenticated and
-- granted ONLY to service_role — the edge function calls them with the
-- service-role client. No session-driven caller path. RLS is enabled on the
-- table with NO permissive policy, so anon/authenticated cannot read or write it
-- via PostgREST even though the SECURITY DEFINER RPC (running as owner) can.
--
-- REALTIME: no supabase_realtime publication change. The
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- ORDERING: 20260607130000 sorts AFTER 20260607120000 (the username column
-- migration). Strictly additive: one table, two functions, one cron job.
-- Rollback = drop table + drop functions + cron.unschedule. No down migration
-- (repo convention).
-- ============================================================


-- ─── Part 1: the counter table ─────────────────────────────────
create table if not exists public.username_resolve_rate_limit (
  ip            text        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0,
  primary key (ip, window_start)
);

comment on table public.username_resolve_rate_limit is
  'Spec 095 — fixed-window per-IP request counter for the username-resolve edge
   function. One row per (client IP, 60s window). Written ONLY by the
   check_username_resolve_rate_limit SECURITY DEFINER RPC (service-role); not
   reachable by anon/authenticated (RLS on, no permissive policy).';

-- RLS on, no policy → only the SECURITY DEFINER RPC owner (postgres) and
-- service_role's table grants below can touch it; anon/authenticated are blocked.
alter table public.username_resolve_rate_limit enable row level security;


-- ─── Part 2: the atomic fixed-window limiter RPC ───────────────
-- Returns TRUE if the request is allowed (within budget for the current window),
-- FALSE if the per-window limit is exceeded. The increment + check is atomic via
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so concurrent calls from the
-- same IP cannot race past the limit.
create or replace function public.check_username_resolve_rate_limit(
  p_ip text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Fixed-window parameters. 20 requests / 60 seconds / IP — inside the design's
  -- "~10-30 req/min/IP" guidance.
  c_window_seconds constant integer := 60;
  c_limit          constant integer := 20;

  v_ip      text;
  v_window  timestamptz;
  v_count   integer;
begin
  -- Defensive: a missing/blank IP collapses to a single shared bucket
  -- ('unknown') rather than minting an unbounded set of buckets. This is the
  -- conservative choice — if the platform ever fails to forward the client IP,
  -- ALL such callers share one budget (fail toward throttling, not toward an
  -- unmetered hole).
  v_ip := coalesce(nullif(btrim(p_ip), ''), 'unknown');

  -- Truncate "now" to the start of the current fixed window.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / c_window_seconds) * c_window_seconds
  );

  insert into public.username_resolve_rate_limit (ip, window_start, request_count)
  values (v_ip, v_window, 1)
  on conflict (ip, window_start)
  do update set request_count = public.username_resolve_rate_limit.request_count + 1
  returning request_count into v_count;

  return v_count <= c_limit;
end;
$$;

comment on function public.check_username_resolve_rate_limit(text) is
  'Spec 095 — atomic fixed-window (60s) per-IP rate limiter for username-resolve.
   Increments the current window''s counter for p_ip and returns TRUE iff the
   request is within budget (20/min), FALSE if exceeded. SECURITY DEFINER so the
   service-role edge function can write the counter table (which has RLS on and
   no permissive policy). Keys on IP only — never on the username — so it leaks
   no username-existence signal.';

revoke execute on function public.check_username_resolve_rate_limit(text)
  from public, anon, authenticated;
grant  execute on function public.check_username_resolve_rate_limit(text)
  to service_role;

-- The RPC writes the table as its owner; service_role also needs direct table
-- grants are NOT required (the function is the only writer), but grant DML to
-- service_role for defense-in-depth parity with the function's blast radius.
grant select, insert, update on public.username_resolve_rate_limit to service_role;


-- ─── Part 3: housekeeping (prune + daily cron) ─────────────────
create or replace function public.prune_username_resolve_rate_limit()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  -- Anything older than 1 hour is well past any 60s window and is dead weight.
  with del as (
    delete from public.username_resolve_rate_limit
     where window_start < now() - interval '1 hour'
    returning 1
  )
  select count(*)::int into v_deleted from del;
  return v_deleted;
end;
$$;

comment on function public.prune_username_resolve_rate_limit() is
  'Spec 095 — deletes username_resolve_rate_limit rows older than 1 hour so the
   per-IP counter table does not grow unbounded. Run daily by pg_cron.';

revoke execute on function public.prune_username_resolve_rate_limit()
  from public, anon, authenticated;
grant  execute on function public.prune_username_resolve_rate_limit()
  to postgres, service_role;

-- Daily prune. The `if exists … unschedule` block makes the migration safe to
-- re-apply (same shape as record_missed_orders_for_day's cron block).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-username-resolve-rate-limit') then
    perform cron.unschedule('prune-username-resolve-rate-limit');
  end if;

  perform cron.schedule(
    'prune-username-resolve-rate-limit',
    '17 4 * * *',
    $cron$ select public.prune_username_resolve_rate_limit(); $cron$
  );
end $$;
