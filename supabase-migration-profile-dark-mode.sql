-- Per-user dark / light mode preference. Restored on login so the user's
-- chosen theme follows them across devices. The local copy in
-- localStorage / AsyncStorage handles instant boot-time hydration to
-- avoid a flash of the wrong theme.
alter table public.profiles
  add column if not exists dark_mode boolean not null default false;
