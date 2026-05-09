-- ============================================================
-- Spec 012c — Brand soft-delete + restore + hard-delete cascade
--
-- Single transaction. Idempotent. Re-runnable as a no-op.
--
-- WHAT THIS MIGRATION DOES:
--   1. Flips brand-direct FKs (stores, vendors, recipes, prep_recipes →
--      brands) from RESTRICT/NO ACTION to ON DELETE CASCADE so
--      `delete from brands` actually propagates.
--   2. Flips per-store child FKs (inventory_items, eod_submissions,
--      waste_log, purchase_orders, pos_imports, audit_log → stores) to
--      ON DELETE CASCADE so the second-stage cascade after stores delete
--      doesn't trip a RESTRICT.
--   3. Flips chain-blocking FKs not enumerated by architect §0/§1.2 but
--      required for the full brand cascade to complete in one statement
--      (verified empirically via pg_constraint scan against local seed,
--      2026-05-09):
--        - ingredient_conversions.catalog_id  (was NO ACTION; blocks
--          catalog_ingredients delete which is the brand → catalog
--          cascade).
--      All other "grandchild" tables (recipe_ingredients,
--      prep_recipe_ingredients, recipe_prep_items, eod_entries, po_items,
--      pos_import_items) already cascade through their direct parent
--      (recipes/prep_recipes/eod_submissions/etc.), so their NO ACTION
--      FKs to inventory_items/recipes/catalog_ingredients defer to
--      end-of-statement and find the rows already deleted via the
--      parent cascade chain. Non-issue at runtime.
--   4. Creates `brand_deletion_log` audit table (no FK to brands so the
--      row survives a cascade; super-admin RLS read-only).
--   5. Adds 5 SECURITY DEFINER RPCs:
--        - rename_brand(uuid, text)
--        - soft_delete_brand(uuid)
--        - restore_brand(uuid)              [server-enforces 30-day grace]
--        - preview_brand_cascade(uuid)
--        - hard_delete_brand(uuid)          [strict pre-flight + snapshot]
--      All gated on `auth_is_super_admin()` from 012a.
--
-- ORDERING (per architect §1):
--   FK conversions (additive — only swaps confdeltype) → audit table +
--   indexes + RLS → RPC creations. Single tx; rollback-safe.
--
-- IDEMPOTENT: every DROP CONSTRAINT uses pg_constraint lookup with
-- `if v_conname is not null` guard; CREATE TABLE / INDEX use IF NOT
-- EXISTS; the FK conversions only re-add when the target action differs
-- from CASCADE (`confdeltype <> 'c'`). Re-running the migration is a
-- no-op.
--
-- REALTIME: this migration does NOT touch the supabase_realtime
-- publication (per architect §6). The `docker restart
-- supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- ============================================================
-- VERIFICATION PROBES (run post-deploy; NOT part of this migration)
-- ============================================================
-- Quoted from spec §10. Backend-driven probes 1–11; UI probes 12–16
-- belong to the frontend. Run after `npm run dev:db:reset`.
--
-- Probe 1 — soft-delete a brand makes it disappear from active partition.
--   1. UI: super-admin clicks "Delete brand" on TEST BRAND B; types
--      "TEST BRAND B" in the modal; clicks Delete.
--   2. Verify brand disappears from Active sub-tab list.
--   3. Verify brand appears in Trash sub-tab with strikethrough + DELETED pill.
--   4. SQL: `select deleted_at from brands where id='2b...'` → non-null.
--   5. SQL: `select * from brand_deletion_log where event='soft_deleted'`
--      → has the row with actor_email matching wzhchen113@gmail.com.
--
-- Probe 2 — soft-delete of currentBrandId auto-swaps to null. (UI-only)
--
-- Probe 3 — restore.
--   1. From Trash, select TEST BRAND B; click Restore.
--   2. Brand returns to Active sub-tab.
--   3. SQL: `deleted_at IS NULL`.
--   4. brand_deletion_log has the 'restored' row.
--
-- Probe 4 — restore past 30 days fails.
--   1. SQL: `update brands set deleted_at = now() - interval '31 days'
--           where id='2b...';`
--   2. UI: Restore button is disabled with tooltip "Restore window expired".
--   3. SQL: `select restore_brand('2b...')` → raises EXCEPTION.
--
-- Probe 5 — cascade preview with 0 profiles → counts render, Continue enabled.
--   1. SQL: `update profiles set brand_id=null, role='user'
--           where brand_id='2b...';`
--   2. UI: open CascadePreviewModal for TEST BRAND B.
--   3. blocking_profiles is empty; counts render; Continue enabled.
--
-- Probe 6 — cascade preview with 1+ profiles → red error, Continue disabled.
--   1. SQL: `update profiles set brand_id='2b...', role='admin' where id='44...';`
--   2. UI: open CascadePreviewModal.
--   3. blocking_profiles lists the brandb@local.test admin row.
--   4. Continue is disabled.
--
-- Probe 7 — hard-delete (after clearing profiles) wipes brand + dependents.
--   1. Clear profile per Probe 5 setup.
--   2. UI: open CascadePreviewModal → Continue → type "TEST BRAND B" →
--      PURGE PERMANENTLY.
--   3. SQL: `select count(*) from brands where id='2b...'` → 0.
--   4. SQL: `select count(*) from catalog_ingredients where brand_id='2b...'` → 0.
--   5. SQL: `select count(*) from stores where brand_id='2b...'` → 0.
--   6. SQL: `select count(*) from brand_deletion_log
--           where brand_id='2b...' and event='hard_deleted'` → 1, with
--      cascade_payload populated.
--
-- Probe 8 — hard-delete RPC pre-flight #1 (must be soft-deleted).
--   1. SQL: `select hard_delete_brand('2a000000-...01')` (active brand).
--   2. EXCEPTION: "Brand must be soft-deleted before hard-delete..."
--
-- Probe 9 — hard-delete RPC pre-flight #2 (orphan profiles block).
--   1. Soft-delete a brand that still has admin profiles attached.
--   2. SQL: `select hard_delete_brand('2b...')`.
--   3. EXCEPTION: "Cannot hard-delete brand: N profiles..."
--
-- Probe 10 — non-super-admin cannot call any RPC.
--   1. As brand-A admin (not super-admin):
--      `select rename_brand('2a...', 'BAD')`.
--   2. EXCEPTION: "Only super-admin can rename brands".
--   3. Repeat for soft_delete_brand, restore_brand, preview_brand_cascade,
--      hard_delete_brand.
--
-- Probe 11 — `brand_deletion_log` RLS.
--   1. As brand-A admin: `select count(*) from brand_deletion_log` → 0
--      (RLS hides rows).
--   2. As super-admin: same query returns all rows.
--   3. As any role: `insert into brand_deletion_log (...)` → RLS rejection.
-- ============================================================


-- ─── (1) BRAND-DIRECT FK CASCADE CONVERSION ──────────────────
-- For each direct-brand-child table, drop the existing RESTRICT/NO ACTION
-- FK and re-add as ON DELETE CASCADE. Defensive: look up the actual
-- constraint name from pg_constraint AND only act when the existing FK's
-- confdeltype is not already 'c' (CASCADE). This makes the migration a
-- true no-op on re-apply and on prod where some FKs may have already
-- been hand-tuned to CASCADE.
do $$
declare
  v_tables   constant text[] := array['stores', 'vendors', 'recipes', 'prep_recipes'];
  v_table    text;
  v_conname  text;
  v_confdel  "char";
begin
  foreach v_table in array v_tables loop
    select c.conname, c.confdeltype
      into v_conname, v_confdel
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = v_table
       and c.contype = 'f'
       and c.conkey = (
         select array_agg(a.attnum order by a.attnum)
           from pg_attribute a
          where a.attrelid = t.oid
            and a.attname  = 'brand_id'
       )
     limit 1;

    if v_conname is null then
      raise notice '012c: no brand_id FK found on public.%; skipping', v_table;
      continue;
    end if;

    if v_confdel = 'c' then
      raise notice '012c: public.% brand_id FK (%) already CASCADE; no-op', v_table, v_conname;
      continue;
    end if;

    execute format('alter table public.%I drop constraint %I', v_table, v_conname);
    execute format(
      'alter table public.%I add constraint %I_brand_id_fkey '
      'foreign key (brand_id) references public.brands(id) on delete cascade',
      v_table, v_table
    );
    raise notice '012c: converted public.%.brand_id FK to ON DELETE CASCADE', v_table;
  end loop;
end $$;


-- ─── (2) PER-STORE CHILD FK CASCADE CONVERSION ───────────────
-- When stores delete (via brand cascade), each per-store child must
-- propagate. The init schema declared several FKs without ON DELETE
-- (defaults to NO ACTION); convert those to CASCADE.
--
-- Tables already CASCADE per their dedicated migrations
--   (flags / pos_recipe_aliases / order_schedule / report_definitions /
--    user_stores) are no-ops via the confdeltype guard.
do $$
declare
  v_tables   constant text[] := array[
    'inventory_items', 'eod_submissions', 'waste_log',
    'purchase_orders', 'pos_imports', 'audit_log',
    'flags', 'pos_recipe_aliases', 'order_schedule',
    'report_definitions'
  ];
  v_table    text;
  v_conname  text;
  v_confdel  "char";
begin
  foreach v_table in array v_tables loop
    select c.conname, c.confdeltype
      into v_conname, v_confdel
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = v_table
       and c.contype = 'f'
       and c.conkey = (
         select array_agg(a.attnum order by a.attnum)
           from pg_attribute a
          where a.attrelid = t.oid
            and a.attname  = 'store_id'
       )
     limit 1;

    if v_conname is null then
      raise notice '012c: no store_id FK found on public.%; skipping', v_table;
      continue;
    end if;

    if v_confdel = 'c' then
      raise notice '012c: public.% store_id FK (%) already CASCADE; no-op', v_table, v_conname;
      continue;
    end if;

    execute format('alter table public.%I drop constraint %I', v_table, v_conname);
    execute format(
      'alter table public.%I add constraint %I_store_id_fkey '
      'foreign key (store_id) references public.stores(id) on delete cascade',
      v_table, v_table
    );
    raise notice '012c: converted public.%.store_id FK to ON DELETE CASCADE', v_table;
  end loop;
end $$;


-- ─── (3) CHAIN-BLOCKING FK FIX (architect §0 probe #2 gap) ───
-- Architect §0 probe #2 asserted "ingredient_conversions cascades
-- through catalog_ingredients" but pg_constraint scan against local
-- seed shows ingredient_conversions.catalog_id is NO ACTION (added by
-- 20260504060452_brand_catalog_p1_additive.sql:71 with no ON DELETE
-- clause). Without this conversion, brand cascade → catalog_ingredients
-- delete → ingredient_conversions blocks at end-of-statement.
--
-- Following architect's design intent (full brand cascade so
-- hard_delete_brand functions). Surfaced in build notes as a deviation.
do $$
declare
  v_conname  text;
  v_confdel  "char";
begin
  select c.conname, c.confdeltype
    into v_conname, v_confdel
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'ingredient_conversions'
     and c.contype = 'f'
     and c.conkey = (
       select array_agg(a.attnum order by a.attnum)
         from pg_attribute a
        where a.attrelid = t.oid
          and a.attname  = 'catalog_id'
     )
   limit 1;

  if v_conname is null then
    raise notice '012c: no catalog_id FK on ingredient_conversions; skipping';
  elsif v_confdel = 'c' then
    raise notice '012c: ingredient_conversions.catalog_id FK already CASCADE; no-op';
  else
    execute format('alter table public.ingredient_conversions drop constraint %I', v_conname);
    execute 'alter table public.ingredient_conversions '
            'add constraint ingredient_conversions_catalog_id_fkey '
            'foreign key (catalog_id) references public.catalog_ingredients(id) '
            'on delete cascade';
    raise notice '012c: converted ingredient_conversions.catalog_id FK to ON DELETE CASCADE';
  end if;
end $$;


-- ─── (4) BELT-AND-BRACES FINAL ASSERTION (architect §11 risk #9) ─
-- After all conversions, every brand-direct FK on stores/vendors/recipes/
-- prep_recipes MUST be ON DELETE CASCADE. If any are not, hard_delete_brand
-- will fail at execution time with a FK violation. Fail the migration
-- loudly here rather than silently shipping a broken contract.
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname in ('stores', 'vendors', 'recipes', 'prep_recipes')
     and c.contype = 'f'
     and c.confrelid = 'public.brands'::regclass
     and c.confdeltype <> 'c';

  if v_bad > 0 then
    raise exception '012c: post-conversion assertion failed: % brand-direct FK(s) still not CASCADE', v_bad;
  end if;
end $$;


-- ─── (5) brand_deletion_log AUDIT TABLE ──────────────────────
-- No FK to brands so the row survives `delete from brands`. The brand
-- name is snapshotted to the row at action time so the audit reads even
-- after the brand is gone.
create table if not exists public.brand_deletion_log (
  id              uuid primary key default extensions.gen_random_uuid(),
  brand_id        uuid not null,
  brand_name      text not null,
  event           text not null check (event in ('soft_deleted', 'restored', 'hard_deleted')),
  actor_user_id   uuid,
  actor_email     text,
  cascade_payload jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists brand_deletion_log_brand_id_idx
  on public.brand_deletion_log (brand_id);
create index if not exists brand_deletion_log_created_at_idx
  on public.brand_deletion_log (created_at desc);

comment on table public.brand_deletion_log is
  'Spec 012c forensic audit of brand soft-delete / restore / hard-delete actions. No FK to brands so the row survives a brand cascade. Super-admin RLS read-only; writes only via SECURITY DEFINER RPCs.';

alter table public.brand_deletion_log enable row level security;


-- ─── (6) brand_deletion_log RLS ──────────────────────────────
-- Read: super-admin only. Write: deny all. SECURITY DEFINER RPCs
-- bypass RLS via definer rights, so no INSERT policy is needed.
drop policy if exists "super_admin_read_brand_deletion_log" on public.brand_deletion_log;
create policy "super_admin_read_brand_deletion_log"
  on public.brand_deletion_log for select
  using (public.auth_is_super_admin());


-- ─── (7) RPCs ─────────────────────────────────────────────────
-- All SECURITY DEFINER, locked search_path, gated by auth_is_super_admin()
-- inside the body. RLS already gates super-admin via
-- super_admin_manage_brands; the function-level check is defense-in-depth
-- + cleaner errors than RLS rejection.

-- (7.1) rename_brand --------------------------------------------------
create or replace function public.rename_brand(
  p_brand_id uuid,
  p_new_name text
) returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_trimmed text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can rename brands';
  end if;

  v_trimmed := trim(coalesce(p_new_name, ''));
  if length(v_trimmed) = 0 then
    raise exception 'Brand name cannot be empty';
  end if;

  -- UNIQUE constraint on brands.name will raise on collision (SQLSTATE
  -- 23505). Caller surfaces via notifyBackendError.
  update public.brands
     set name = v_trimmed
   where id = p_brand_id;

  if not found then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  return p_brand_id;
end;
$$;

grant execute on function public.rename_brand(uuid, text) to authenticated;


-- (7.2) soft_delete_brand --------------------------------------------
create or replace function public.soft_delete_brand(
  p_brand_id uuid
) returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_now         timestamptz := now();
  v_brand_name  text;
  v_actor_email text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can soft-delete brands';
  end if;

  select name into v_brand_name from public.brands where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  update public.brands
     set deleted_at = v_now
   where id = p_brand_id
     and deleted_at is null;

  if not found then
    -- Already soft-deleted; idempotent — return existing timestamp
    -- without writing a duplicate audit row.
    return (select deleted_at from public.brands where id = p_brand_id);
  end if;

  select email into v_actor_email from auth.users where id = auth.uid();

  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'soft_deleted', auth.uid(), v_actor_email, null);

  return v_now;
end;
$$;

grant execute on function public.soft_delete_brand(uuid) to authenticated;


-- (7.3) restore_brand -------------------------------------------------
-- Per AC X4: restore is BLOCKED past the 30-day window. UI also disables
-- the button past day 30, but server-side is the contract.
create or replace function public.restore_brand(
  p_brand_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_brand_name  text;
  v_deleted_at  timestamptz;
  v_actor_email text;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can restore brands';
  end if;

  select name, deleted_at
    into v_brand_name, v_deleted_at
    from public.brands
   where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;
  if v_deleted_at is null then
    -- Already active; idempotent no-op.
    return true;
  end if;

  if (now() - v_deleted_at) > interval '30 days' then
    raise exception 'Restore window expired (% days since soft-delete). Use Purge to hard-delete.',
      extract(day from (now() - v_deleted_at))::int;
  end if;

  update public.brands set deleted_at = null where id = p_brand_id;

  select email into v_actor_email from auth.users where id = auth.uid();

  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'restored', auth.uid(), v_actor_email, null);

  return true;
end;
$$;

grant execute on function public.restore_brand(uuid) to authenticated;


-- (7.4) preview_brand_cascade -----------------------------------------
-- Returns a JSONB object with per-table row counts AND a
-- `blocking_profiles` array. UI renders both: counts table + (when
-- blocking_profiles is non-empty) a red error block per AC H2.
create or replace function public.preview_brand_cascade(
  p_brand_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_payload           jsonb;
  v_blocking_profiles jsonb;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can preview brand cascade';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'profile_id', p.id,
      'name',       p.name,
      'email',      u.email,
      'role',       p.role,
      'status',     p.status
    ) order by p.role, p.name
  ), '[]'::jsonb)
    into v_blocking_profiles
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.brand_id = p_brand_id;

  v_payload := jsonb_build_object(
    'brand_id',   p_brand_id,
    'brand_name', (select name from public.brands where id = p_brand_id),
    'deleted_at', (select deleted_at from public.brands where id = p_brand_id),
    'blocking_profiles', v_blocking_profiles,
    'blocking_profile_counts', jsonb_build_object(
      'admins',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role in ('admin', 'master')),
      'users',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role = 'user'),
      'super_admins',
        (select count(*) from public.profiles
          where brand_id = p_brand_id and role = 'super_admin')
    ),
    'counts', jsonb_build_object(
      'catalog_ingredients',
        (select count(*) from public.catalog_ingredients where brand_id = p_brand_id),
      'ingredient_conversions',
        (select count(*) from public.ingredient_conversions ic
          join public.catalog_ingredients ci on ci.id = ic.catalog_id
          where ci.brand_id = p_brand_id),
      'vendors',
        (select count(*) from public.vendors where brand_id = p_brand_id),
      'recipes',
        (select count(*) from public.recipes where brand_id = p_brand_id),
      'recipe_ingredients',
        (select count(*) from public.recipe_ingredients ri
          join public.recipes r on r.id = ri.recipe_id
          where r.brand_id = p_brand_id),
      'recipe_prep_items',
        (select count(*) from public.recipe_prep_items rpi
          join public.recipes r on r.id = rpi.recipe_id
          where r.brand_id = p_brand_id),
      'prep_recipes',
        (select count(*) from public.prep_recipes where brand_id = p_brand_id),
      'prep_recipe_ingredients',
        (select count(*) from public.prep_recipe_ingredients pri
          join public.prep_recipes pr on pr.id = pri.prep_recipe_id
          where pr.brand_id = p_brand_id),
      'stores',
        (select count(*) from public.stores where brand_id = p_brand_id),
      'inventory_items',
        (select count(*) from public.inventory_items ii
          join public.stores s on s.id = ii.store_id
          where s.brand_id = p_brand_id),
      'eod_submissions',
        (select count(*) from public.eod_submissions es
          join public.stores s on s.id = es.store_id
          where s.brand_id = p_brand_id),
      'eod_entries',
        (select count(*) from public.eod_entries ee
          join public.eod_submissions es on es.id = ee.submission_id
          join public.stores s on s.id = es.store_id
          where s.brand_id = p_brand_id),
      'waste_log',
        (select count(*) from public.waste_log w
          join public.stores s on s.id = w.store_id
          where s.brand_id = p_brand_id),
      'purchase_orders',
        (select count(*) from public.purchase_orders po
          join public.stores s on s.id = po.store_id
          where s.brand_id = p_brand_id),
      'po_items',
        (select count(*) from public.po_items pi
          join public.purchase_orders po on po.id = pi.po_id
          join public.stores s on s.id = po.store_id
          where s.brand_id = p_brand_id),
      'pos_imports',
        (select count(*) from public.pos_imports pim
          join public.stores s on s.id = pim.store_id
          where s.brand_id = p_brand_id),
      'pos_import_items',
        (select count(*) from public.pos_import_items pii
          join public.pos_imports pim on pim.id = pii.import_id
          join public.stores s on s.id = pim.store_id
          where s.brand_id = p_brand_id),
      'audit_log',
        (select count(*) from public.audit_log al
          join public.stores s on s.id = al.store_id
          where s.brand_id = p_brand_id),
      'flags',
        (select count(*) from public.flags f
          join public.stores s on s.id = f.store_id
          where s.brand_id = p_brand_id),
      'order_schedule',
        (select count(*) from public.order_schedule os
          join public.stores s on s.id = os.store_id
          where s.brand_id = p_brand_id),
      'pos_recipe_aliases',
        (select count(*) from public.pos_recipe_aliases pra
          join public.recipes r on r.id = pra.recipe_id
          where r.brand_id = p_brand_id),
      'report_definitions',
        (select count(*) from public.report_definitions rd
          join public.stores s on s.id = rd.store_id
          where s.brand_id = p_brand_id),
      'user_stores',
        (select count(*) from public.user_stores us
          join public.stores s on s.id = us.store_id
          where s.brand_id = p_brand_id)
    )
  );

  return v_payload;
end;
$$;

grant execute on function public.preview_brand_cascade(uuid) to authenticated;


-- (7.5) hard_delete_brand --------------------------------------------
-- Strict pre-flight gates per AC H4 (must be soft-deleted) and AC H5 +
-- Q-USER-A (no orphan profiles). Snapshots cascade payload BEFORE the
-- delete fires, writes audit row inside the same tx, then deletes.
-- The whole operation is one transaction (RPC implicit tx) — if the
-- DELETE throws, the audit row is rolled back too.
create or replace function public.hard_delete_brand(
  p_brand_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_brand_name      text;
  v_deleted_at      timestamptz;
  v_actor_email     text;
  v_cascade_payload jsonb;
  v_admins          int;
  v_users           int;
begin
  if not public.auth_is_super_admin() then
    raise exception 'Only super-admin can hard-delete brands';
  end if;

  select name, deleted_at
    into v_brand_name, v_deleted_at
    from public.brands
   where id = p_brand_id;
  if v_brand_name is null then
    raise exception 'Brand % not found', p_brand_id;
  end if;

  -- Pre-flight #1 (AC H4): must be soft-deleted first.
  if v_deleted_at is null then
    raise exception 'Brand must be soft-deleted before hard-delete. Soft-delete first, then purge.';
  end if;

  -- Pre-flight #2 (AC H5, Q-USER-A): no orphan profiles. Strict EXISTS
  -- check; refuse to create orphans by refusing to delete the brand
  -- while any profile still references it.
  select
    count(*) filter (where role in ('admin', 'master')),
    count(*) filter (where role = 'user')
    into v_admins, v_users
    from public.profiles
   where brand_id = p_brand_id;

  if (v_admins + v_users) > 0 then
    raise exception
      'Cannot hard-delete brand: % profiles (% admins, % users) still belong. Reassign or delete them first.',
      v_admins + v_users, v_admins, v_users;
  end if;

  -- Snapshot cascade counts BEFORE the delete fires. Forensic value:
  -- the UI's earlier preview was one round-trip ago; this is the
  -- at-execution-time count.
  v_cascade_payload := public.preview_brand_cascade(p_brand_id);

  select email into v_actor_email from auth.users where id = auth.uid();

  -- Audit row FIRST. brand_deletion_log has no FK to brands so it'd
  -- survive the cascade either way, but logging-then-deleting keeps the
  -- audit and the destructive op atomic — if the cascade somehow
  -- throws, the audit is rolled back too.
  insert into public.brand_deletion_log
    (brand_id, brand_name, event, actor_user_id, actor_email, cascade_payload)
  values
    (p_brand_id, v_brand_name, 'hard_deleted', auth.uid(), v_actor_email, v_cascade_payload);

  -- The cascade. With the FK conversions in (1)/(2)/(3) above, this
  -- propagates to every brand-scoped table.
  delete from public.brands where id = p_brand_id;

  return v_cascade_payload;
end;
$$;

grant execute on function public.hard_delete_brand(uuid) to authenticated;
