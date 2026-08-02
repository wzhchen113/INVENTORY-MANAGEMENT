-- supabase/tests/order_approvals.test.sql
--
-- Spec 149 — pgTAP coverage for public.order_approvals, its BEFORE UPDATE guard
-- and its per-store RLS, shipped in
-- supabase/migrations/20260801000100_order_approvals.sql.
--
-- Plan (24 arms):
--   SHAPE (AC-19)
--     (S1) the table exists.
--     (S2) the (store_id, vendor_id, business_date) UNIQUE index exists — it IS
--          the design-guidance-6 idempotency spine.
--     (S3) NO delete policy exists ⇒ DELETE is default-denied ⇒ "append-only in
--          spirit" is enforced by RLS, not convention.
--   create_order_approval (AC-19 / AC-21 / AC-27 / R-6)
--     (C1) a privileged same-store caller creates a 'pending' row with the
--          SERVER-resolved channel, line_count and est_total_cost.
--     (C2) idempotent on (store, vendor, date): a replay creates no second row.
--     (C3) a still-'pending' row's snapshot IS refreshed by the retry path.
--     (C5) AC-27 — qty_base = 0 is refused with 22023 and nothing is written.
--     (C6) an unknown / invisible vendor raises P0002 (⇒ HTTP 404).
--     (C4) R-6 — once 'approved', a re-approval returns the row VERBATIM with no
--          write. Re-approval is refused, not overwritten.
--     (C7) S-3 — a LOST RACE (the pre-select misses, the INSERT hits the unique
--          index) returns the winner's row idempotently instead of a raw 23505.
--   STATUS GUARD (AC-20)
--     (G1) pending → ordered is REJECTED (P0001).
--     (G6) an identity/provenance column (store_id) is ALWAYS immutable (P0001).
--     (G7) security-auditor Medium 2 — a PENDING row cannot be PATCHed onto the
--          'instacart' mint path when its vendor does not resolve there (P0001).
--     (G8) …but a DOWNWARD channel change (→ 'manual') is allowed while pending —
--          that is the shipped OQ-2 retailer-unavailable fallback.
--     (G9) …and a restore to the SERVER-RESOLVED channel is allowed, so
--          create_order_approval's retry path can never wedge a pending row.
--     (G2) pending → approved succeeds, carrying the external_ref write.
--     (G3) approved → pending is REJECTED (P0001).
--     (G5) the line snapshot is IMMUTABLE once status left 'pending' (P0001).
--     (G4) approved → ordered succeeds AND auto-sets ordered_at.
--   RLS (AC-21)
--     (R1) a store-linked NON-privileged user sees ZERO rows — the
--          auth_is_privileged() conjunct is load-bearing (staff submit, they do
--          not approve; AC-REG-5).
--     (R2) that same user is REFUSED on create (42501).
--     (R3) a privileged caller is refused for a store they cannot see
--          (cross-brand) — the AC-24 refusal in its SQL form.
--     (R4) DELETE is a 0-row no-op even for the owning privileged admin.
--   LINT (AC-21)
--     (L1) none of order_approvals' policies is trivially-wide — the spec-053
--          permissive_policy_lint probe stays green with NO allowlist row.
--
-- Hermetic: begin; … rollback;. Fixtures created inside the transaction (green
-- under the committed seed AND on a CI-fresh database). JWT-impersonation
-- pattern copied from submission_notifications.test.sql / extension_ordering.

begin;
create extension if not exists pgtap;

select plan(24);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin  (brand A)
  v_user_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', Frederick+Towson)
  v_brand_a  uuid;
  v_brand_b  uuid := 'b1490000-0000-0000-0000-000000000001';  -- test-only foreign brand
  v_store_a  uuid;
  v_store_b  uuid := 'b1490001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  select id into v_brand_a from public.brands limit 1;
  select id into v_store_a from public.stores where name = 'Frederick' limit 1;
  perform set_config('test.admin_id', v_admin_id::text, true);
  perform set_config('test.user_id',  v_user_id::text,  true);
  perform set_config('test.brand_a',  v_brand_a::text,  true);
  perform set_config('test.brand_b',  v_brand_b::text,  true);
  perform set_config('test.store_a',  v_store_a::text,  true);
  perform set_config('test.store_b',  v_store_b::text,  true);
end $$;

insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 149)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (current_setting('test.store_b', true)::uuid,
        current_setting('test.brand_b', true)::uuid,
        'Foreign Store (test 149)', '1 Foreign Way', 'active', '22:00')
on conflict (id) do nothing;

-- Vendors: one resolving to 'extension' (the specs-131/132 flag), one 'manual',
-- one in the foreign brand for the cross-store refusal arm, and one genuinely
-- resolving to 'instacart' (declared channel + a non-blank retailer key — the
-- only combination that beats the extension flag, R-3) for the (G9) arm.
insert into public.vendors (id, name, brand_id, order_channel, instacart_retailer_key, extension_ordering)
values
  ('49910000-0000-0000-0000-000000000001', '__oa_vendor_ext__',
   current_setting('test.brand_a', true)::uuid, 'extension', null, true),
  ('49910000-0000-0000-0000-000000000002', '__oa_vendor_manual__',
   current_setting('test.brand_a', true)::uuid, null, null, false),
  ('49910000-0000-0000-0000-000000000003', '__oa_vendor_foreign__',
   current_setting('test.brand_b', true)::uuid, null, null, false),
  ('49910000-0000-0000-0000-000000000004', '__oa_vendor_instacart__',
   current_setting('test.brand_a', true)::uuid, 'instacart', '__oa_retailer_key__', false);

-- A fixed two-line payload reused by several arms.
-- est_total_cost = 24×1.25 + 10×0.50 = 35.0000
select set_config('test.lines', $j$[
  {"item_id":"49920000-0000-0000-0000-000000000001","item_name":"Fries",
   "qty_base":24,"case_qty":6,"unit":"each","cost_per_counted_unit":1.25},
  {"item_id":"49920000-0000-0000-0000-000000000002","item_name":"Buns",
   "qty_base":10,"case_qty":1,"unit":"each","cost_per_counted_unit":0.50}
]$j$, true);


-- ─── SHAPE ─────────────────────────────────────────────────────
select has_table('public'::name, 'order_approvals'::name,
  '(S1) public.order_approvals exists');

select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and tablename = 'order_approvals'
             and indexname = 'order_approvals_store_vendor_date_uidx'),
  '(S2) the (store_id, vendor_id, business_date) UNIQUE index — the idempotency spine — exists'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'order_approvals' and cmd = 'DELETE'),
  0,
  '(S3) NO delete policy exists ⇒ DELETE default-denied ⇒ append-only enforced by RLS'
);


-- ─── impersonate the seed ADMIN (privileged, sees every brand-A store) ─────
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

-- (C1) happy path — pending row, SERVER-resolved channel, derived aggregates.
create temp table _oa on commit drop as
select public.create_order_approval(
  current_setting('test.store_a', true)::uuid,
  '49910000-0000-0000-0000-000000000001'::uuid,
  date '2026-08-01',
  current_setting('test.lines', true)::jsonb,
  null
) as row;

select is(
  (select format('%s|%s|%s|%s', (row).status, (row).channel, (row).line_count,
                 (row).est_total_cost) from _oa),
  'pending|extension|2|35.0000',
  '(C1) create_order_approval writes a pending row with the SERVER-resolved channel + derived line_count/est_total_cost'
);

-- (C2) replay (double-tap / post-network-error retry) — no second row.
create temp table _oa_replay on commit drop as
select public.create_order_approval(
  current_setting('test.store_a', true)::uuid,
  '49910000-0000-0000-0000-000000000001'::uuid,
  date '2026-08-01',
  current_setting('test.lines', true)::jsonb,
  null
) as row;

select is(
  (select count(*)::int from public.order_approvals
    where store_id      = current_setting('test.store_a', true)::uuid
      and vendor_id     = '49910000-0000-0000-0000-000000000001'
      and business_date = date '2026-08-01'),
  1,
  '(C2) a replayed create_order_approval creates NO second row (the unique key IS the idempotency spine)'
);

-- (C3) the retry path REFRESHES a still-pending snapshot (2 lines → 1).
select is(
  (select (row).line_count from (
     select public.create_order_approval(
       current_setting('test.store_a', true)::uuid,
       '49910000-0000-0000-0000-000000000001'::uuid,
       date '2026-08-01',
       $j$[{"item_id":"49920000-0000-0000-0000-000000000001","item_name":"Fries",
            "qty_base":6,"case_qty":6,"unit":"each","cost_per_counted_unit":1.25}]$j$::jsonb,
       null) as row
   ) r),
  1,
  '(C3) the retry path refreshes a still-pending snapshot (line_count 2 → 1)'
);

-- (C5) AC-27 — qty_base = 0 is refused with 22023, nothing written.
select throws_ok(
  format($q$select public.create_order_approval(%L::uuid,
              '49910000-0000-0000-0000-000000000002'::uuid, date '2026-08-02',
              $lines$[{"item_id":"49920000-0000-0000-0000-000000000001","item_name":"Fries",
                       "qty_base":0,"case_qty":6,"unit":"each","cost_per_counted_unit":1.25}]$lines$::jsonb,
              null)$q$, current_setting('test.store_a', true)),
  '22023',
  null,
  '(C5) AC-27 — qty_base = 0 is refused with 22023 (⇒ HTTP 400) and no row is written'
);

-- (C6) unknown vendor ⇒ P0002.
select throws_ok(
  format($q$select public.create_order_approval(%L::uuid,
              '49910000-0000-0000-0000-0000000000ff'::uuid, date '2026-08-02',
              %L::jsonb, null)$q$,
         current_setting('test.store_a', true), current_setting('test.lines', true)),
  'P0002',
  null,
  '(C6) an unknown / RLS-invisible vendor raises P0002 (⇒ HTTP 404)'
);


-- ─── STATUS GUARD (AC-20) ──────────────────────────────────────
select set_config('test.approval_id', (
  select id::text from public.order_approvals
   where store_id      = current_setting('test.store_a', true)::uuid
     and vendor_id     = '49910000-0000-0000-0000-000000000001'
     and business_date = date '2026-08-01'
), true);

-- (G1) pending → ordered is REJECTED.
select throws_ok(
  format($q$update public.order_approvals set status = 'ordered' where id = %L$q$,
         current_setting('test.approval_id', true)),
  'P0001',
  null,
  '(G1) AC-20 — pending → ordered is rejected server-side'
);

-- (G6) an identity/provenance column is ALWAYS immutable.
select throws_ok(
  format($q$update public.order_approvals set store_id = %L where id = %L$q$,
         current_setting('test.store_b', true), current_setting('test.approval_id', true)),
  'P0001',
  'order approval is immutable',
  '(G6) AC-20 — store_id (identity/provenance) is always immutable'
);

-- ─── CHANNEL ESCALATION GUARD while pending (security-auditor Medium 2) ────
-- `channel` is a general-purpose PostgREST-writable column (db.advanceOrderApproval
-- exposes it for the OQ-2 fallback) and instacart-cart-link gates ONLY on the
-- STORED channel. These three arms pin the rule that closes that gap.

-- (G7) the escalation itself: the fixture row's vendor resolves to 'extension'
-- (extension_ordering = true), so PATCHing it onto the mint path is refused.
select throws_ok(
  format($q$update public.order_approvals set channel = 'instacart' where id = %L$q$,
         current_setting('test.approval_id', true)),
  'P0001',
  'order approval channel may not be changed to instacart',
  '(G7) a PENDING row cannot be PATCHed onto the instacart mint path when its vendor does not resolve there'
);

-- (G8) the downward move the shipped OQ-2 fallback actually performs.
select lives_ok(
  format($q$update public.order_approvals set channel = 'manual' where id = %L$q$,
         current_setting('test.approval_id', true)),
  '(G8) a DOWNWARD channel change (→ manual) is allowed while pending — the OQ-2 retailer-unavailable fallback'
);

-- (G9) the anti-wedge half: a row for a vendor that GENUINELY resolves to
-- 'instacart' can be moved down and back up to the server-resolved value. That
-- is exactly what create_order_approval's pending-retry path re-writes after a
-- vendor config change; refusing it would strand the row forever (no DELETE
-- policy exists).
select set_config('test.instacart_approval_id', (
  select ((row).id)::text from (
    select public.create_order_approval(
      current_setting('test.store_a', true)::uuid,
      '49910000-0000-0000-0000-000000000004'::uuid,
      date '2026-08-07',
      current_setting('test.lines', true)::jsonb,
      null) as row) r
), true);

update public.order_approvals set channel = 'manual'
 where id = current_setting('test.instacart_approval_id', true)::uuid;

select lives_ok(
  format($q$update public.order_approvals set channel = 'instacart' where id = %L$q$,
         current_setting('test.instacart_approval_id', true)),
  '(G9) a restore to the SERVER-RESOLVED channel is allowed — the retry path can never wedge a pending row'
);

-- Put the fixture row back on its resolved channel before the status arms.
update public.order_approvals set channel = 'extension'
 where id = current_setting('test.approval_id', true)::uuid;


-- (G2) pending → approved succeeds, carrying the external_ref write.
select lives_ok(
  format($q$update public.order_approvals
              set status                  = 'approved',
                  external_ref            = 'https://www.instacart.com/store/shopping_lists/xyz',
                  external_ref_expires_at = now() + interval '30 days'
            where id = %L$q$, current_setting('test.approval_id', true)),
  '(G2) AC-20 — pending → approved succeeds, with the external_ref write'
);

-- (G3) approved → pending is REJECTED.
select throws_ok(
  format($q$update public.order_approvals set status = 'pending' where id = %L$q$,
         current_setting('test.approval_id', true)),
  'P0001',
  null,
  '(G3) AC-20 — approved → pending is rejected server-side'
);

-- (G5) the line snapshot is frozen once status left 'pending'.
select throws_ok(
  format($q$update public.order_approvals set line_count = 99 where id = %L$q$,
         current_setting('test.approval_id', true)),
  'P0001',
  'order approval snapshot is immutable once approved',
  '(G5) AC-20 — the line snapshot is immutable once status left pending'
);

-- (C4) R-6 — re-approval of an already-'approved' key returns the row VERBATIM.
select is(
  (select format('%s|%s', (row).id::text, (row).line_count) from (
     select public.create_order_approval(
       current_setting('test.store_a', true)::uuid,
       '49910000-0000-0000-0000-000000000001'::uuid,
       date '2026-08-01',
       current_setting('test.lines', true)::jsonb,
       null) as row) r),
  format('%s|1', current_setting('test.approval_id', true)),
  '(C4) R-6 — re-approving an already-approved key returns the row verbatim (no overwrite, no status change)'
);

-- (G4) approved → ordered succeeds and auto-sets ordered_at.
update public.order_approvals set status = 'ordered'
 where id = current_setting('test.approval_id', true)::uuid;

select is(
  (select (ordered_at is not null and status = 'ordered')
     from public.order_approvals
    where id = current_setting('test.approval_id', true)::uuid),
  true,
  '(G4) AC-20 — approved → ordered succeeds and auto-sets ordered_at'
);


-- ─── RLS (AC-21) ───────────────────────────────────────────────
-- (R1/R2) a store-linked NON-privileged user: zero rows, refused on create.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

select is(
  (select count(*)::int from public.order_approvals
    where id = current_setting('test.approval_id', true)::uuid),
  0,
  '(R1) AC-21 — a store-linked NON-privileged user sees ZERO approvals (the auth_is_privileged conjunct is load-bearing)'
);

select throws_ok(
  format($q$select public.create_order_approval(%L::uuid,
              '49910000-0000-0000-0000-000000000001'::uuid, date '2026-08-03',
              %L::jsonb, null)$q$,
         current_setting('test.store_a', true), current_setting('test.lines', true)),
  '42501',
  'not authorized to approve orders',
  '(R2) AC-21 — a store-linked NON-privileged user is refused on create (42501)'
);

-- (R3) a privileged caller is refused for a store they cannot see. The seed
-- admin is brand-A scoped; the fixture store B is in a foreign brand.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select throws_ok(
  format($q$select public.create_order_approval(%L::uuid,
              '49910000-0000-0000-0000-000000000003'::uuid, date '2026-08-01',
              %L::jsonb, null)$q$,
         current_setting('test.store_b', true), current_setting('test.lines', true)),
  '42501',
  'not authorized for this store',
  '(R3) AC-21/AC-24 — a privileged caller is refused for a store they cannot see (cross-brand)'
);

-- (R4) DELETE is a 0-row no-op even for the owning privileged admin.
with d as (
  delete from public.order_approvals
   where id = current_setting('test.approval_id', true)::uuid
  returning 1
)
select is((select count(*)::int from d), 0,
  '(R4) AC-19/AC-21 — DELETE is a 0-row no-op even for the owning privileged admin (no delete policy)');


-- ─── LINT (AC-21) — spec-053 permissive_policy_lint stays green ────────────
reset role;
select set_config('request.jwt.claims', null, true);

select is(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and tablename  = 'order_approvals'
      and permissive = 'PERMISSIVE'
      and (
        lower(regexp_replace(coalesce(qual, ''), '\s+', ' ', 'g'))
          ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        or lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g'))
          ~ '^\s*\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*(\s+or\s+.*)?\s*$'
        or lower(regexp_replace(coalesce(qual, ''), '\s+', ' ', 'g'))
          ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*'
        or lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g'))
          ~ '\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*'
      )),
  0,
  '(L1) AC-21 — no order_approvals policy is trivially-wide; permissive_policy_lint stays green with NO allowlist row'
);


-- ─── (C7) S-3 — the LOST RACE returns the winner's row, not a raw 23505 ─────
-- create_order_approval does select-then-insert. A second approver (two admin
-- devices, or a retry racing its own in-flight predecessor) can commit the same
-- (store_id, vendor_id, business_date) key between those two statements: both
-- callers see `not found`, one wins the unique index, and the loser used to get
-- a raw 23505 ⇒ PostgREST 409 ⇒ a raw backend-error toast.
--
-- HOW THIS ARM REPRODUCES THAT WINDOW WITHOUT TWO SESSIONS. A pgTAP file is one
-- session inside one `begin; … rollback;`, so genuine concurrency is not
-- available (a second connection could not see, and would deadlock against, our
-- uncommitted fixtures). Instead we make the function's PRE-SELECT miss a row
-- that demonstrably exists, which is byte-for-byte the state the loser of a race
-- is in when it reaches its INSERT:
--   • a test-only RESTRICTIVE SELECT policy hides EXACTLY ONE row, EXACTLY ONCE
--     (the predicate function disarms itself the first time it is asked about
--     the armed id), so the pre-select returns NOT FOUND;
--   • the INSERT still collides — unique indexes are enforced regardless of RLS;
--   • the new unique_violation handler re-reads the row (now visible again) and
--     falls through the same retry / R-6 logic.
-- The arm asserts the marker `<consumed>` alongside the row, so it fails loudly
-- if the hide never fired and the arm silently degraded into a plain replay.
-- Both test-only objects are dropped immediately after, and the whole file rolls
-- back regardless.
reset role;

create function public._t149_peek_visible(p_id uuid) returns boolean
language plpgsql volatile as $$
begin
  if coalesce(current_setting('test.oa_hide', true), '') = p_id::text then
    perform set_config('test.oa_hide', '<consumed>', true);
    return false;
  end if;
  return true;
end $$;
grant execute on function public._t149_peek_visible(uuid) to authenticated;

create policy "t149_race_hide_once" on public.order_approvals
  as restrictive for select using (public._t149_peek_visible(id));

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

-- The "winner": a pending two-line approval on a fresh key.
select set_config('test.race_id', (
  select ((row).id)::text from (
    select public.create_order_approval(
      current_setting('test.store_a', true)::uuid,
      '49910000-0000-0000-0000-000000000002'::uuid,
      date '2026-08-09',
      current_setting('test.lines', true)::jsonb,
      null) as row) r
), true);

-- The "loser": same key, one line, with the winner's row hidden from its
-- pre-select. Captured in a DO block so the ordering of the call and the
-- marker read is deterministic.
do $$
declare
  v_row public.order_approvals;
begin
  perform set_config('test.oa_hide', current_setting('test.race_id', true), true);
  v_row := public.create_order_approval(
    current_setting('test.store_a', true)::uuid,
    '49910000-0000-0000-0000-000000000002'::uuid,
    date '2026-08-09',
    $j$[{"item_id":"49920000-0000-0000-0000-000000000001","item_name":"Fries",
         "qty_base":6,"case_qty":6,"unit":"each","cost_per_counted_unit":1.25}]$j$::jsonb,
    null);
  perform set_config('test.race_result',
    format('%s|%s|%s|%s',
           v_row.id, v_row.status, v_row.line_count,
           coalesce(current_setting('test.oa_hide', true), '<unset>')), true);
end $$;

select is(
  format('%s|%s',
         current_setting('test.race_result', true),
         (select count(*)::int from public.order_approvals
           where store_id      = current_setting('test.store_a', true)::uuid
             and vendor_id     = '49910000-0000-0000-0000-000000000002'
             and business_date = date '2026-08-09')),
  format('%s|pending|1|<consumed>|1', current_setting('test.race_id', true)),
  '(C7) S-3 — a lost create/create race returns the WINNER''s row through the normal retry path (no 23505, no second row)'
);

reset role;
select set_config('request.jwt.claims', null, true);
drop policy "t149_race_hide_once" on public.order_approvals;
drop function public._t149_peek_visible(uuid);

select finish();
rollback;
