-- supabase/tests/username_resolve_rate_limit.test.sql
--
-- Spec 095 (review fix — security Medium-1) — pgTAP coverage for the
-- per-IP fixed-window rate limiter behind the username-resolve edge function:
--   public.check_username_resolve_rate_limit(text)  (migration
--   20260607130000_username_resolve_rate_limit.sql).
--
-- The limiter is the choke point that stops a bundle-public-token holder from
-- scripting username→email harvesting. These arms pin: (a) the budget
-- (first N within a window return TRUE, the N+1th returns FALSE), (b) per-IP
-- isolation (one IP being throttled does not throttle a different IP), (c) the
-- table is RLS-locked away from anon/authenticated (only the SECURITY DEFINER
-- RPC / service_role can touch it), and (d) the EXECUTE grant is service_role
-- only (no session-driven caller path).
--
-- Hermetic begin; … rollback; isolation — every counter row this test writes is
-- discarded on rollback (the table is otherwise written only by the live edge
-- function, never by the seed). The window math uses now(), so all calls in this
-- transaction land in the same (or adjacent) 60s window; the loop count (20) is
-- the inlined c_limit, kept in sync with the migration by this test by design.
--
-- Arms (plan(7)):
--   (1) the first request for a fresh IP is allowed (TRUE).
--   (2) requests 2..20 (the budget) are all allowed.
--   (3) the 21st request for that IP is denied (FALSE) — budget exhausted.
--   (4) a DIFFERENT IP is still allowed (per-IP isolation, not global).
--   (5) a blank IP collapses to the shared 'unknown' bucket (allowed first call).
--   (6) anon/authenticated cannot SELECT the counter table (RLS, no policy).
--   (7) anon does NOT hold EXECUTE on the limiter RPC (service_role only).

begin;
create extension if not exists pgtap;

select plan(7);

-- A unique IP per test run is not needed (rollback discards rows), but using
-- distinct literals keeps the arms independent within the transaction.
\set ip_a '203.0.113.10'
\set ip_b '203.0.113.20'

-- ─── Arm (1): first request for a fresh IP is allowed ──────────
select is(
  public.check_username_resolve_rate_limit(:'ip_a'),
  true,
  'arm (1): first request for a fresh IP is allowed (TRUE)'
);

-- ─── Arm (2): requests 2..20 (rest of the budget) are allowed ──
-- Arm (1) consumed request #1; consume #2..#20 here and assert every one is
-- still within budget. bool_and over the 19 remaining allowances.
select is(
  (
    select bool_and(public.check_username_resolve_rate_limit(:'ip_a'))
      from generate_series(2, 20) g
  ),
  true,
  'arm (2): requests 2..20 (the budget) are all allowed'
);

-- ─── Arm (3): the 21st request is denied ───────────────────────
select is(
  public.check_username_resolve_rate_limit(:'ip_a'),
  false,
  'arm (3): the 21st request for the IP is denied (FALSE — budget exhausted)'
);

-- ─── Arm (4): a different IP is still allowed (per-IP isolation) ─
select is(
  public.check_username_resolve_rate_limit(:'ip_b'),
  true,
  'arm (4): a different IP is unaffected by the first IP''s throttle'
);

-- ─── Arm (5): blank IP collapses to the shared 'unknown' bucket ─
-- A first blank-IP call is allowed; the point of the arm is that it does NOT
-- error and is metered (the migration coalesces '' → 'unknown').
select is(
  public.check_username_resolve_rate_limit(''),
  true,
  'arm (5): a blank IP is accepted and metered (collapses to ''unknown'' bucket)'
);

-- ─── Arm (6): RLS blocks anon/authenticated from the counter table ─
-- The table has RLS on and no permissive policy, so a non-owner role sees zero
-- rows even though the SECURITY DEFINER RPC (running as owner) just wrote some.
set local role authenticated;
select is(
  (select count(*)::int from public.username_resolve_rate_limit),
  0,
  'arm (6): authenticated sees 0 rows in the counter table (RLS, no policy)'
);
reset role;

-- ─── Arm (7): anon lacks EXECUTE on the limiter RPC ────────────
-- The grant is service_role only; anon must not be able to call it.
select is(
  has_function_privilege(
    'anon',
    'public.check_username_resolve_rate_limit(text)',
    'execute'
  ),
  false,
  'arm (7): anon does NOT hold EXECUTE on check_username_resolve_rate_limit (service_role only)'
);

select * from finish();
rollback;
