-- ============================================================
-- POS recipe aliases — persistent store-scoped POS-name → recipe mapping.
-- Used by POSImportScreen (in-app import) and breadbot-nightly-sync (cron)
-- to remember user-confirmed matches so the same POS string maps the same
-- recipe on every future import without re-fuzzy-matching.
-- ============================================================

create table if not exists public.pos_recipe_aliases (
  id           uuid primary key default extensions.gen_random_uuid(),
  pos_name     text not null,
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete cascade,  -- NULL = global (future)
  last_used_at timestamptz default now(),
  created_at   timestamptz default now(),
  unique (pos_name, store_id)
);

create index if not exists pos_recipe_aliases_store_lookup
  on public.pos_recipe_aliases (store_id, pos_name);

alter table public.pos_recipe_aliases enable row level security;

drop policy if exists "Read pos_recipe_aliases" on public.pos_recipe_aliases;
create policy "Read pos_recipe_aliases"
  on public.pos_recipe_aliases for select using (
    store_id is null
    or store_id in (select store_id from public.user_stores where user_id = auth.uid())
    or ((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))
  );

drop policy if exists "Write pos_recipe_aliases" on public.pos_recipe_aliases;
create policy "Write pos_recipe_aliases"
  on public.pos_recipe_aliases for all
  using (
    store_id in (select store_id from public.user_stores where user_id = auth.uid())
    or ((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))
  )
  with check (
    store_id in (select store_id from public.user_stores where user_id = auth.uid())
    or ((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))
  );
