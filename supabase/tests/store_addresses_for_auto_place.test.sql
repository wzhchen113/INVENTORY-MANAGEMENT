-- supabase/tests/store_addresses_for_auto_place.test.sql
--
-- Spec 162 (rev 2) — pgTAP coverage for
-- supabase/migrations/20260829000100_store_addresses_for_auto_place.sql.
--
--   stores_address_present:
--     (A1) the constraint exists and is NOT VALID — a validated one would have
--          failed the migration on any prod store missing an address;
--     (A2) an INSERT with a NULL address is refused;
--     (A3) an INSERT with a BLANK/whitespace address is refused (a NOT NULL
--          alone would have accepted both);
--     (A4) an INSERT with a real address succeeds;
--     (A5) an UPDATE that blanks an existing address is refused.
--
--   get_extension_store_addresses:
--     (R1) returns the caller's visible stores with the picker's four keys;
--     (R2) a store WITHOUT an address is returned with hasAddress=false rather
--          than filtered out — a vanished store is unactionable, a flagged one
--          is a gap the operator can fix;
--     (R3) SECURITY INVOKER: a store the caller cannot see is NOT in the list;
--     (R4) inactive stores are excluded;
--     (R5) anon CANNOT execute it — `revoke ... from anon` alone is not enough,
--          because CREATE FUNCTION grants EXECUTE to PUBLIC and anon inherits
--          it. The revoke has to name `public`;
--     (R6) authenticated still CAN.
--
-- Hermetic: begin; … rollback;. No `set role anon` (segfaults CI per spec 067).

begin;
create extension if not exists pgtap;

select plan(12);

do $$
declare
  v_brand_id uuid;
begin
  select id into v_brand_id from public.brands limit 1;
  perform set_config('test.brand_id',   v_brand_id::text, true);
  -- The MASTER, not the 2222 store-scoped manager: a brand-wide role sees the
  -- freshly-inserted fixtures without needing user_stores links, so (R4)'s
  -- "inactive is excluded" arm can't pass vacuously through invisibility.
  perform set_config('test.manager_id', '33333333-3333-3333-3333-333333333333', true);
end $$;

-- ─── (A1) the constraint's SHAPE is the point ──────────────────────────────
-- If someone "tidies" this into a validated constraint or a NOT NULL, the
-- migration stops being safe to apply to a prod that still has addressless
-- stores. Pin NOT VALID explicitly.
select ok(
  (select count(*) = 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname  = 'stores_address_present'
      and contype  = 'c'),
  '(A1a) stores_address_present exists as a CHECK constraint'
);
select ok(
  (select not convalidated from pg_constraint
    where conrelid = 'public.stores'::regclass and conname = 'stores_address_present'),
  '(A1b) …and is NOT VALID, so pre-existing addressless stores are grandfathered'
);

-- ─── (A2)–(A5) it actually bites on writes ─────────────────────────────────
select throws_ok(
  $$insert into public.stores (name, address, brand_id)
    values ('__spec162_null__', null, current_setting('test.brand_id', true)::uuid)$$,
  '23514',
  null,
  '(A2) a NULL address is refused on INSERT'
);

select throws_ok(
  $$insert into public.stores (name, address, brand_id)
    values ('__spec162_blank__', '   ', current_setting('test.brand_id', true)::uuid)$$,
  '23514',
  null,
  '(A3) a whitespace-only address is refused — btrim, not just NOT NULL'
);

select lives_ok(
  $$insert into public.stores (id, name, address, brand_id)
    values ('99999999-9999-9999-9999-999999990162', '__spec162_ok__',
            '1 Real St, Baltimore MD 21201', current_setting('test.brand_id', true)::uuid)$$,
  '(A4) a real address inserts fine'
);

select throws_ok(
  $$update public.stores set address = '' where id = '99999999-9999-9999-9999-999999990162'$$,
  '23514',
  null,
  '(A5) blanking an existing address is refused on UPDATE'
);

-- ─── the picker source ─────────────────────────────────────────────────────
-- A grandfathered addressless store, inserted with the constraint bypassed the
-- only way a pre-existing row could have got there: directly, before the
-- constraint existed. `set constraints` cannot defer a CHECK, so drop-and-
-- restore inside the transaction — the rollback undoes it either way.
alter table public.stores drop constraint stores_address_present;
insert into public.stores (id, name, address, brand_id)
values ('99999999-9999-9999-9999-999999990163', '__spec162_legacy__', null,
        current_setting('test.brand_id', true)::uuid);
insert into public.stores (id, name, address, brand_id, status)
values ('99999999-9999-9999-9999-999999990164', '__spec162_inactive__', '2 Gone St',
        current_setting('test.brand_id', true)::uuid, 'inactive');
alter table public.stores
  add constraint stores_address_present
  check (address is not null and btrim(address) <> '') not valid;

-- Impersonate a real member so RLS is doing the scoping, not superuser bypass.
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

select is(
  (select count(*)::int from jsonb_array_elements(public.get_extension_store_addresses()) e
    where e->>'storeName' = '__spec162_ok__'
      and (e->>'hasAddress')::boolean
      and e->>'address' = '1 Real St, Baltimore MD 21201'),
  1,
  '(R1) a visible addressed store is returned with address + hasAddress=true'
);

select is(
  (select count(*)::int from jsonb_array_elements(public.get_extension_store_addresses()) e
    where e->>'storeName' = '__spec162_legacy__' and not (e->>'hasAddress')::boolean),
  1,
  '(R2) an ADDRESSLESS store is returned with hasAddress=false, not filtered out'
);

select is(
  (select count(*)::int from jsonb_array_elements(public.get_extension_store_addresses()) e
    where e->>'storeName' = '__spec162_inactive__'),
  0,
  '(R4) inactive stores are excluded from the picker'
);

-- (R3) SECURITY INVOKER — a caller who can see NOTHING gets an empty list. A
-- non-existent uid satisfies no stores policy, so this is the strongest form of
-- "RLS, not the function, is what scopes this".
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);
select is(
  public.get_extension_store_addresses(),
  '[]'::jsonb,
  '(R3) a caller with no visible stores gets an empty list — RLS scopes it, not the function'
);

-- ─── (R5)-(R6) the grant shape ─────────────────────────────────
set local role postgres;
select ok(
  not has_function_privilege('anon', 'public.get_extension_store_addresses()'::regprocedure, 'execute'),
  '(R5) anon CANNOT execute get_extension_store_addresses'
);
select ok(
  has_function_privilege('authenticated', 'public.get_extension_store_addresses()'::regprocedure, 'execute'),
  '(R6) authenticated CAN'
);

select * from finish();
rollback;
