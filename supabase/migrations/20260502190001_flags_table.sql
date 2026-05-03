-- ============================================================
-- `flags` table — staff-submitted issue reports surfaced in admin's
-- Insights inbox. Backs the FLAG ISSUE button in ItemDetailScreen
-- (cmd theme, staff role).
--
-- Per design handoff §"Interactions": staff opens a form (type,
-- photo, note) → writes here with userId / itemId / type / note /
-- photoUrl / resolved=false. Admin sees flags as an inbox.
-- ============================================================

create table if not exists public.flags (
  id           uuid primary key default extensions.gen_random_uuid(),
  store_id     uuid references public.stores(id) on delete cascade,
  item_id      uuid references public.inventory_items(id) on delete set null,
  user_id      uuid references public.profiles(id),
  type         text not null check (type in ('damage', 'quality', 'out', 'wrong-item', 'other')),
  note         text,
  photo_url    text,
  resolved     boolean default false,
  resolved_by  uuid references public.profiles(id),
  resolved_at  timestamptz,
  created_at   timestamptz default now()
);

create index if not exists flags_store_unresolved
  on public.flags (store_id, created_at desc)
  where resolved = false;

create index if not exists flags_item
  on public.flags (item_id);

alter table public.flags enable row level security;

-- Staff (and admin) can write flags for items in their assigned stores.
drop policy if exists "Staff can submit flags" on public.flags;
create policy "Staff can submit flags"
  on public.flags for insert
  with check (
    user_id = auth.uid()
    and store_id in (
      select store_id from public.user_stores where user_id = auth.uid()
    )
  );

-- Staff sees their own submissions; admin sees everything for their stores.
drop policy if exists "Read own flags" on public.flags;
create policy "Read own flags"
  on public.flags for select
  using (
    user_id = auth.uid()
    or ((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))
  );

-- Only admin/master can mark resolved.
drop policy if exists "Admins resolve flags" on public.flags;
create policy "Admins resolve flags"
  on public.flags for update
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));
