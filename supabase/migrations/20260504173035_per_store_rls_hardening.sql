-- ============================================================
-- Per-store RLS hardening
--
-- Closes the gap left by the brand-catalog refactor (PR #3, follow-up
-- issue #4). Before this migration, the per-store state tables
-- (inventory_items, eod_*, waste_log, audit_log, purchase_orders,
-- po_items, pos_imports, pos_import_items) used a permissive
--   USING (auth.uid() IS NOT NULL)
-- policy for both reads and writes. Any authed user could hit
-- /rest/v1/inventory_items?store_id=eq.<other-store> and pull data
-- they had no business reading. The Cmd UI's user_stores filter was
-- the only thing hiding it; a curl bypassed it trivially.
--
-- After this migration, those tables filter through user_stores
-- membership server-side. Admins/masters retain cross-store visibility
-- via the existing auth_is_admin() helper (delegated through
-- auth_can_see_store).
--
-- Tables whose policies already do the right thing (flags,
-- order_schedule, pos_recipe_aliases) are intentionally left alone in
-- this migration — they predate this refactor and will be brought into
-- the auth_can_see_store helper in a follow-up if a code-style cleanup
-- is wanted.
--
-- See issue #4 and PR #3 review.
-- ============================================================

-- ─── Helper: caller can see this store ────────────────────────
-- Mirrors auth_is_admin() shape: SECURITY DEFINER + locked search_path
-- so RLS policies can call it freely.
create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_admin()
    or exists (
      select 1 from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;

-- ─── inventory_items ─────────────────────────────────────────
drop policy if exists "auth_manage_inventory" on public.inventory_items;

create policy "store_member_read_inventory_items"
  on public.inventory_items for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_inventory_items"
  on public.inventory_items for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_inventory_items"
  on public.inventory_items for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_inventory_items"
  on public.inventory_items for delete
  using (public.auth_can_see_store(store_id));

-- ─── eod_submissions ─────────────────────────────────────────
drop policy if exists "auth_manage_eod_submissions" on public.eod_submissions;

create policy "store_member_read_eod_submissions"
  on public.eod_submissions for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_eod_submissions"
  on public.eod_submissions for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_eod_submissions"
  on public.eod_submissions for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_eod_submissions"
  on public.eod_submissions for delete
  using (public.auth_can_see_store(store_id));

-- ─── eod_entries (child of eod_submissions) ──────────────────
-- No store_id column; scope through the parent.
drop policy if exists "auth_manage_eod_entries" on public.eod_entries;

create policy "store_member_read_eod_entries"
  on public.eod_entries for select
  using (
    exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  );

create policy "store_member_insert_eod_entries"
  on public.eod_entries for insert
  with check (
    exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  );

create policy "store_member_update_eod_entries"
  on public.eod_entries for update
  using (
    exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  );

create policy "store_member_delete_eod_entries"
  on public.eod_entries for delete
  using (
    exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  );

-- ─── waste_log ───────────────────────────────────────────────
drop policy if exists "auth_manage_waste_log" on public.waste_log;

create policy "store_member_read_waste_log"
  on public.waste_log for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_waste_log"
  on public.waste_log for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_waste_log"
  on public.waste_log for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_waste_log"
  on public.waste_log for delete
  using (public.auth_can_see_store(store_id));

-- ─── audit_log ───────────────────────────────────────────────
-- store_id is nullable in the schema; treat NULL as "no store" and
-- visible only to admins so cross-cutting events (e.g. a user-invite
-- that doesn't pin a store yet) don't leak to non-admins.
drop policy if exists "auth_manage_audit_log" on public.audit_log;

create policy "store_member_read_audit_log"
  on public.audit_log for select
  using (
    (store_id is not null and public.auth_can_see_store(store_id))
    or (store_id is null and public.auth_is_admin())
  );

create policy "store_member_insert_audit_log"
  on public.audit_log for insert
  with check (
    (store_id is not null and public.auth_can_see_store(store_id))
    or (store_id is null and public.auth_is_admin())
  );

create policy "admin_update_audit_log"
  on public.audit_log for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

create policy "admin_delete_audit_log"
  on public.audit_log for delete
  using (public.auth_is_admin());

-- ─── purchase_orders ─────────────────────────────────────────
drop policy if exists "auth_manage_purchase_orders" on public.purchase_orders;

create policy "store_member_read_purchase_orders"
  on public.purchase_orders for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_purchase_orders"
  on public.purchase_orders for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_purchase_orders"
  on public.purchase_orders for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_purchase_orders"
  on public.purchase_orders for delete
  using (public.auth_can_see_store(store_id));

-- ─── po_items (child of purchase_orders) ─────────────────────
drop policy if exists "auth_manage_po_items" on public.po_items;

create policy "store_member_read_po_items"
  on public.po_items for select
  using (
    exists (
      select 1 from public.purchase_orders po
       where po.id = po_items.po_id
         and public.auth_can_see_store(po.store_id)
    )
  );

create policy "store_member_insert_po_items"
  on public.po_items for insert
  with check (
    exists (
      select 1 from public.purchase_orders po
       where po.id = po_items.po_id
         and public.auth_can_see_store(po.store_id)
    )
  );

create policy "store_member_update_po_items"
  on public.po_items for update
  using (
    exists (
      select 1 from public.purchase_orders po
       where po.id = po_items.po_id
         and public.auth_can_see_store(po.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.purchase_orders po
       where po.id = po_items.po_id
         and public.auth_can_see_store(po.store_id)
    )
  );

create policy "store_member_delete_po_items"
  on public.po_items for delete
  using (
    exists (
      select 1 from public.purchase_orders po
       where po.id = po_items.po_id
         and public.auth_can_see_store(po.store_id)
    )
  );

-- ─── pos_imports ─────────────────────────────────────────────
drop policy if exists "auth_manage_pos_imports" on public.pos_imports;

create policy "store_member_read_pos_imports"
  on public.pos_imports for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_pos_imports"
  on public.pos_imports for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_pos_imports"
  on public.pos_imports for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_pos_imports"
  on public.pos_imports for delete
  using (public.auth_can_see_store(store_id));

-- ─── pos_import_items (child of pos_imports) ─────────────────
drop policy if exists "auth_manage_pos_import_items" on public.pos_import_items;

create policy "store_member_read_pos_import_items"
  on public.pos_import_items for select
  using (
    exists (
      select 1 from public.pos_imports pi
       where pi.id = pos_import_items.import_id
         and public.auth_can_see_store(pi.store_id)
    )
  );

create policy "store_member_insert_pos_import_items"
  on public.pos_import_items for insert
  with check (
    exists (
      select 1 from public.pos_imports pi
       where pi.id = pos_import_items.import_id
         and public.auth_can_see_store(pi.store_id)
    )
  );

create policy "store_member_update_pos_import_items"
  on public.pos_import_items for update
  using (
    exists (
      select 1 from public.pos_imports pi
       where pi.id = pos_import_items.import_id
         and public.auth_can_see_store(pi.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.pos_imports pi
       where pi.id = pos_import_items.import_id
         and public.auth_can_see_store(pi.store_id)
    )
  );

create policy "store_member_delete_pos_import_items"
  on public.pos_import_items for delete
  using (
    exists (
      select 1 from public.pos_imports pi
       where pi.id = pos_import_items.import_id
         and public.auth_can_see_store(pi.store_id)
    )
  );
