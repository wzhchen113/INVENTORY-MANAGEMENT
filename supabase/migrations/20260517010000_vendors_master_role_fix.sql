-- Fix: master users were blocked from inserting vendors.
--
-- The original `init_schema.sql` shipped a hand-rolled "Vendors admin only"
-- INSERT policy with `(select role from profiles where id = auth.uid()) = 'admin'`
-- — a literal-string comparison that excludes master and super_admin even
-- though both sit above admin in the role hierarchy.
--
-- Mirror the Spec 013 pattern: drop and recreate using the canonical
-- `public.auth_is_privileged()` helper (admin OR master OR super_admin).
-- Strict superset of prior behavior: admin still passes, master + super_admin
-- newly pass. No principal loses access.
--
-- SELECT policy (`"Vendors visible to all"`) is untouched.
-- UPDATE/DELETE on vendors have no policies today; intentionally leaving them
-- denied (separate spec if/when needed).

drop policy if exists "Vendors admin only" on public.vendors;

create policy "Vendors admin only" on public.vendors
  for insert
  with check (public.auth_is_privileged());
