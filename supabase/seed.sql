-- ============================================================
-- Local-dev seed. Runs automatically after migrations on
-- `supabase db reset`. NEVER applied to prod (Supabase ignores
-- supabase/seed.sql for remote pushes).
--
-- Login: admin@local.test / password
--
-- Stores (Towson + Baltimore) come from the init_schema migration —
-- they're the real prod store IDs, so seed grants admin access to
-- them rather than creating synthetic ones.
-- ============================================================

-- ─── admin user ──────────────────────────────────────────
-- gotrue's Go scanner cannot read NULL for the *_token columns even
-- though the columns are nullable. Setting them to '' (empty string)
-- avoids "Database error querying schema" on /token requests.
do $$
declare
  admin_id constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into auth.users (
    id, instance_id, aud, role,
    email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_anonymous,
    confirmation_token, recovery_token,
    email_change_token_new, email_change,
    email_change_token_current, phone_change,
    phone_change_token, reauthentication_token
  ) values (
    admin_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'admin@local.test',
    crypt('password', gen_salt('bf')),
    now(), now(), now(),
    jsonb_build_object(
      'provider', 'email',
      'providers', array['email'],
      'role', 'admin'
    ),
    '{}'::jsonb,
    false, false,
    '', '', '', '', '', '', '', ''
  )
  on conflict (id) do nothing;

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), admin_id, admin_id::text,
    jsonb_build_object('sub', admin_id::text, 'email', 'admin@local.test', 'email_verified', true),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  insert into public.profiles (id, name, role, initials, color, status)
  values (admin_id, 'Local Admin', 'admin', 'LA', '#378ADD', 'active')
  on conflict (id) do nothing;
end $$;

-- ─── grant admin access to all prod stores ───────────────
insert into public.user_stores (user_id, store_id)
select '11111111-1111-1111-1111-111111111111', id from public.stores
on conflict do nothing;

-- ─── vendors ─────────────────────────────────────────────
-- Matches the design handoff's data.jsx vendor list. Deterministic
-- UUIDs (`aaaaaaaa-…`) so item rows can reference them without lookups.
insert into public.vendors (id, name, contact_name, phone, email, lead_time_days, categories) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Sysco',              'Mark Davis',     '301-555-0101', 'mark@sysco.com',          1, array['Protein','Dry Goods']),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'US Foods',           'Susan Lin',      '301-555-0102', 'susan@usfoods.com',       1, array['Protein']),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Lancaster',          'Bill Reuter',    '717-555-0103', 'bill@lancasterfresh.com', 1, array['Produce']),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Samuels',            'Anna Park',      '410-555-0104', 'anna@samuels.com',        2, array['Seafood']),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'Trickling Springs',  'Greg McCoy',     '717-555-0105', 'greg@tricklingspr.com',   1, array['Dairy']),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'H&S Bakery',         'Jen Wells',      '410-555-0106', 'jen@hsbakery.com',        1, array['Bakery'])
on conflict (id) do nothing;

-- ─── inventory items (Towson) ────────────────────────────
-- 12 items matching the design's mock + cost / par data. Deterministic
-- UUIDs (`bbbbbbbb-…`) keyed on item slug suffix so seed re-runs don't
-- duplicate rows after `supabase db reset` followed by a partial
-- restore.
insert into public.inventory_items (id, store_id, name, category, unit, cost_per_unit, current_stock, par_level, vendor_id) values
  ('bbbbbbbb-0001-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Beef tenderloin',  'Protein',   'lb',  22.40, 12.4, 18, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0002-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Chicken thigh',    'Protein',   'lb',   4.80, 38.0, 30, 'aaaaaaaa-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0003-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Atlantic salmon',  'Seafood',   'lb',  14.20,  4.2, 12, 'aaaaaaaa-0000-0000-0000-000000000004'),
  ('bbbbbbbb-0004-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Heirloom tomato',  'Produce',   'lb',   3.10, 18.6, 20, 'aaaaaaaa-0000-0000-0000-000000000003'),
  ('bbbbbbbb-0005-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Romaine hearts',   'Produce',   'ea',   1.80,  0.0, 24, 'aaaaaaaa-0000-0000-0000-000000000003'),
  ('bbbbbbbb-0006-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Heavy cream',      'Dairy',     'qt',   4.40,  6.0,  8, 'aaaaaaaa-0000-0000-0000-000000000005'),
  ('bbbbbbbb-0007-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Unsalted butter',  'Dairy',     'lb',   3.90, 14.0, 10, 'aaaaaaaa-0000-0000-0000-000000000005'),
  ('bbbbbbbb-0008-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'AP flour',         'Dry goods', 'lb',   0.62, 50.0, 50, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0009-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Olive oil EV',     'Dry goods', 'gal', 38.00,  2.1,  6, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0010-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Brioche buns',     'Bakery',    'ea',   0.55, 36.0, 48, 'aaaaaaaa-0000-0000-0000-000000000006'),
  ('bbbbbbbb-0011-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Smoked paprika',   'Spices',    'lb',  18.00,  1.4,  2, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0012-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Maine lobster',    'Seafood',   'lb',  28.00,  0.0,  8, 'aaaaaaaa-0000-0000-0000-000000000004')
on conflict (id) do nothing;

-- ─── inventory items (Baltimore — sample subset) ─────────
-- Smaller set so the second store has data for cross-store testing
-- (store switch, fleet-wide EOD overview).
insert into public.inventory_items (id, store_id, name, category, unit, cost_per_unit, current_stock, par_level, vendor_id) values
  ('bbbbbbbb-0001-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Beef tenderloin',  'Protein', 'lb',  22.40,  8.0, 14, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0003-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Atlantic salmon',  'Seafood', 'lb',  14.20,  6.5, 10, 'aaaaaaaa-0000-0000-0000-000000000004'),
  ('bbbbbbbb-0007-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Unsalted butter',  'Dairy',   'lb',   3.90,  9.0, 12, 'aaaaaaaa-0000-0000-0000-000000000005')
on conflict (id) do nothing;

-- ─── EOD submissions (last 5 days, Towson) ──────────────
-- Gives getStockSeries non-flat data for the chart, and audit log
-- entries for the activity card. Atlantic salmon trends down from
-- 11 to 4.2 over 14 days — matches the design's mock series.
do $$
declare
  admin_id  constant uuid := '11111111-1111-1111-1111-111111111111';
  store_id  constant uuid := '00000000-0000-0000-0000-000000000001';
  salmon_id constant uuid := 'bbbbbbbb-0003-0000-0000-000000000001';
  beef_id   constant uuid := 'bbbbbbbb-0001-0000-0000-000000000001';
  romaine_id constant uuid := 'bbbbbbbb-0005-0000-0000-000000000001';
  i int;
  d date;
  sub_id uuid;
  -- Salmon trend: 14 days ago → today
  salmon_series numeric[] := array[11.0, 10.0, 9.0, 9.0, 8.0, 8.0, 7.0, 7.0, 6.0, 6.0, 5.0, 5.0, 4.5, 4.2];
begin
  for i in 1..14 loop
    d := (current_date - (14 - i))::date;
    sub_id := gen_random_uuid();
    insert into public.eod_submissions (id, store_id, date, submitted_by, submitted_at, status)
    values (sub_id, store_id, d, admin_id, d::timestamp + interval '22 hours', 'submitted')
    on conflict do nothing;

    -- salmon — daily count from the trend series
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes)
    values (sub_id, salmon_id, salmon_series[i], '')
    on conflict do nothing;

    -- beef — flatter trend
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes)
    values (sub_id, beef_id, 18 - (i * 0.4), '')
    on conflict do nothing;

    -- romaine — out the last 3 days
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes)
    values (sub_id, romaine_id, case when i >= 12 then 0 else 22 - (i * 1.5) end, '')
    on conflict do nothing;
  end loop;
end $$;

-- ─── audit log (recent activity for the dashboard card) ──
-- Matches the design's RECENT_ACTIVITY mock — 6 events with
-- 12m / 38m / 1h / 2h / 3h / 5h relative timestamps.
insert into public.audit_log (store_id, user_id, action, detail, item_ref, value, created_at)
values
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'EOD entry',     'Remaining count submitted', '24 items',          '',             now() - interval '12 minutes'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Waste log',     'spoilage logged',           'Atlantic salmon',   '1.2 lb',       now() - interval '38 minutes'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Stock adjusted','Receiving complete',         'Sysco PO #4821',    '12 items',     now() - interval '1 hour'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'POS import',    'POS CSV uploaded & reconciled', 'toast_2026-04-30','40 items',   now() - interval '2 hours'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Item edit',     'par level updated',         'Heirloom tomato',   'par 18→20',    now() - interval '3 hours'),
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Waste log',     'expired logged',            'Heavy cream',       '0.8 qt',       now() - interval '5 hours')
on conflict do nothing;
