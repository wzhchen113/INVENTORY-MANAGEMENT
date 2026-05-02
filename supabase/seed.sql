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

-- ─── local-only RLS fixup ────────────────────────────────
-- init_schema enables RLS on these tables but defines no policies, so
-- Postgres defaults to "deny all" — the app sees empty arrays for
-- everything. The actual policies live in prod (added via the SQL
-- editor and never captured in a migration). Until those are
-- reconstructed properly, we add permissive policies here so the app
-- works locally. Lives in seed.sql (NOT a migration) so we never
-- accidentally push these to prod.
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'stores', 'user_stores', 'vendors',
    'recipe_ingredients', 'po_items', 'pos_import_items'
  ] loop
    execute format('drop policy if exists "local dev all access" on public.%I', tbl);
    execute format(
      'create policy "local dev all access" on public.%I for all to authenticated using (true) with check (true)',
      tbl
    );
  end loop;
end $$;
