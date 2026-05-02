drop extension if exists "pg_net";

create extension if not exists "pg_net" with schema "public";

drop trigger if exists "profiles_sync_role" on "public"."profiles";

drop policy "Store access" on "public"."audit_log";

drop policy "Store access" on "public"."eod_entries";

drop policy "Store access" on "public"."eod_submissions";

drop policy "Admins can write ingredient categories" on "public"."ingredient_categories";

drop policy "Authenticated can read ingredient categories" on "public"."ingredient_categories";

drop policy "Admins can write ingredient conversions" on "public"."ingredient_conversions";

drop policy "Authenticated can read ingredient conversions" on "public"."ingredient_conversions";

drop policy "Store access" on "public"."inventory_items";

drop policy "Store access" on "public"."pos_imports";

drop policy "Store access" on "public"."prep_recipe_ingredients";

drop policy "Store access" on "public"."prep_recipes";

drop policy "Own profile" on "public"."profiles";

drop policy "Store access" on "public"."purchase_orders";

drop policy "Store access" on "public"."recipe_prep_items";

drop policy "Store access" on "public"."recipes";

drop policy "Vendors admin only" on "public"."vendors";

drop policy "Vendors visible to all" on "public"."vendors";

drop policy "Store access" on "public"."waste_log";

alter table "public"."prep_recipes" drop constraint "prep_recipes_created_by_fkey";

alter table "public"."order_schedule" drop constraint "order_schedule_vendor_id_fkey";

alter table "public"."recipe_prep_items" drop constraint "recipe_prep_items_prep_recipe_id_fkey";

drop index if exists "public"."idx_ingredient_conversions_item";

drop index if exists "public"."idx_invitations_email_used";

drop index if exists "public"."idx_order_schedule_store_day";

alter table "public"."eod_entries" add column "actual_remaining_cases" numeric;

alter table "public"."eod_entries" add column "actual_remaining_each" numeric;

alter table "public"."eod_reminder_log" enable row level security;

alter table "public"."ingredient_categories" alter column "id" set default gen_random_uuid();

alter table "public"."ingredient_conversions" drop column "updated_at";

alter table "public"."ingredient_conversions" alter column "base_unit" set default 'g'::text;

alter table "public"."ingredient_conversions" alter column "conversion_factor" set default 1;

alter table "public"."ingredient_conversions" alter column "conversion_factor" set data type numeric using "conversion_factor"::numeric;

alter table "public"."ingredient_conversions" alter column "id" set default gen_random_uuid();

alter table "public"."ingredient_conversions" alter column "inventory_item_id" drop not null;

alter table "public"."ingredient_conversions" alter column "net_yield_pct" set not null;

alter table "public"."ingredient_conversions" alter column "net_yield_pct" set data type numeric using "net_yield_pct"::numeric;

alter table "public"."inventory_items" add column "average_daily_usage" numeric default 0;

alter table "public"."inventory_items" add column "case_price" numeric default 0;

alter table "public"."inventory_items" add column "case_qty" numeric default 1;

alter table "public"."inventory_items" add column "safety_stock" numeric default 0;

alter table "public"."inventory_items" add column "sub_unit_size" numeric default 1;

alter table "public"."inventory_items" add column "sub_unit_unit" text default ''::text;

alter table "public"."invitations" alter column "expires_at" set default (now() + '48:00:00'::interval);

alter table "public"."invitations" alter column "id" set default gen_random_uuid();

alter table "public"."invitations" alter column "profile_id" set not null;

alter table "public"."invitations" alter column "role" set default 'user'::text;

alter table "public"."invitations" enable row level security;

alter table "public"."order_schedule" alter column "delivery_day" set not null;

alter table "public"."order_schedule" alter column "vendor_name" set not null;

alter table "public"."prep_recipe_ingredients" add column "base_quantity" numeric default 0;

alter table "public"."prep_recipe_ingredients" add column "base_unit" text default 'g'::text;

alter table "public"."prep_recipe_ingredients" add column "sub_recipe_id" uuid;

alter table "public"."prep_recipe_ingredients" add column "type" text not null default 'raw'::text;

alter table "public"."prep_recipe_ingredients" alter column "id" set default gen_random_uuid();

alter table "public"."prep_recipe_ingredients" alter column "quantity" set default 0;

alter table "public"."prep_recipe_ingredients" alter column "quantity" set not null;

alter table "public"."prep_recipe_ingredients" alter column "quantity" set data type numeric using "quantity"::numeric;

alter table "public"."prep_recipe_ingredients" alter column "unit" set default ''::text;

alter table "public"."prep_recipes" add column "is_current" boolean default true;

alter table "public"."prep_recipes" add column "parent_id" uuid;

alter table "public"."prep_recipes" add column "version" integer default 1;

alter table "public"."prep_recipes" alter column "category" set default ''::text;

alter table "public"."prep_recipes" alter column "id" set default gen_random_uuid();

alter table "public"."prep_recipes" alter column "notes" set default ''::text;

alter table "public"."prep_recipes" alter column "yield_quantity" set default 0;

alter table "public"."prep_recipes" alter column "yield_quantity" drop not null;

alter table "public"."prep_recipes" alter column "yield_quantity" set data type numeric using "yield_quantity"::numeric;

alter table "public"."prep_recipes" alter column "yield_unit" set default ''::text;

alter table "public"."prep_recipes" alter column "yield_unit" drop not null;

alter table "public"."profiles" drop column "notifications_enabled";

alter table "public"."profiles" add column "nickname" text default ''::text;

alter table "public"."purchase_orders" add column "reference_date" date;

alter table "public"."recipe_categories" alter column "id" set default gen_random_uuid();

alter table "public"."recipe_categories" enable row level security;

alter table "public"."recipe_ingredients" add column "base_quantity" numeric default 0;

alter table "public"."recipe_ingredients" add column "base_unit" text default 'g'::text;

alter table "public"."recipe_prep_items" alter column "id" set default gen_random_uuid();

alter table "public"."recipe_prep_items" alter column "quantity" set default 1;

alter table "public"."recipe_prep_items" alter column "quantity" set not null;

alter table "public"."recipe_prep_items" alter column "quantity" set data type numeric using "quantity"::numeric;

alter table "public"."recipe_prep_items" alter column "unit" set default ''::text;

alter table "public"."recipe_prep_items" alter column "unit" set not null;

alter table "public"."vendors" add column "delivery_days" text[] default '{}'::text[];

alter table "public"."vendors" add column "eod_deadline_time" text;

CREATE UNIQUE INDEX eod_submissions_store_date_key ON public.eod_submissions USING btree (store_id, date);

CREATE INDEX idx_purchase_orders_store_reference_date ON public.purchase_orders USING btree (store_id, reference_date);

CREATE UNIQUE INDEX order_schedule_store_id_day_of_week_vendor_name_key ON public.order_schedule USING btree (store_id, day_of_week, vendor_name);

CREATE UNIQUE INDEX recipes_menu_item_store_id_unique ON public.recipes USING btree (menu_item, store_id);

alter table "public"."eod_submissions" add constraint "eod_submissions_store_date_key" UNIQUE using index "eod_submissions_store_date_key";

alter table "public"."order_schedule" add constraint "order_schedule_store_id_day_of_week_vendor_name_key" UNIQUE using index "order_schedule_store_id_day_of_week_vendor_name_key";

alter table "public"."prep_recipe_ingredients" add constraint "prep_recipe_ingredients_sub_recipe_id_fkey" FOREIGN KEY (sub_recipe_id) REFERENCES public.prep_recipes(id) ON DELETE SET NULL not valid;

alter table "public"."prep_recipe_ingredients" validate constraint "prep_recipe_ingredients_sub_recipe_id_fkey";

alter table "public"."order_schedule" add constraint "order_schedule_vendor_id_fkey" FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE not valid;

alter table "public"."order_schedule" validate constraint "order_schedule_vendor_id_fkey";

alter table "public"."recipe_prep_items" add constraint "recipe_prep_items_prep_recipe_id_fkey" FOREIGN KEY (prep_recipe_id) REFERENCES public.prep_recipes(id) ON DELETE CASCADE not valid;

alter table "public"."recipe_prep_items" validate constraint "recipe_prep_items_prep_recipe_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.broadcast_notification(p_store_id uuid, p_message text, p_exclude_user_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_user uuid;
BEGIN
  FOR v_user IN
    SELECT DISTINCT uid FROM (
      SELECT user_id AS uid FROM user_stores WHERE store_id = p_store_id
      UNION
      SELECT id       AS uid FROM profiles WHERE role IN ('admin', 'master')
    ) targets
    WHERE uid IS NOT NULL
      AND uid <> COALESCE(p_exclude_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  LOOP
    INSERT INTO in_app_notifications (user_id, message) VALUES (v_user, p_message);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_po_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(po_number from 4) as int)), 0) + 1
  into next_num
  from purchase_orders;
  new.po_number = 'PO-' || lpad(next_num::text, 3, '0');
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_role_to_app_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object('role', NEW.role)
  WHERE id = NEW.id;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;


  create policy "auth_manage_audit_log"
  on "public"."audit_log"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_eod_entries"
  on "public"."eod_entries"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_eod_submissions"
  on "public"."eod_submissions"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_ingredient_categories"
  on "public"."ingredient_categories"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_ingredient_conversions"
  on "public"."ingredient_conversions"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_inventory"
  on "public"."inventory_items"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_po_items"
  on "public"."po_items"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_pos_import_items"
  on "public"."pos_import_items"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_pos_imports"
  on "public"."pos_imports"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_prep_recipe_ingredients"
  on "public"."prep_recipe_ingredients"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_prep_recipes"
  on "public"."prep_recipes"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "Admins can delete profiles"
  on "public"."profiles"
  as permissive
  for delete
  to public
using ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])));



  create policy "Admins can read all profiles"
  on "public"."profiles"
  as permissive
  for select
  to public
using (((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (id = auth.uid())));



  create policy "Admins can update any profile"
  on "public"."profiles"
  as permissive
  for update
  to public
using (((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (id = auth.uid())));



  create policy "Anyone can insert own profile or admin can insert any"
  on "public"."profiles"
  as permissive
  for insert
  to public
with check (((id = auth.uid()) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (auth.uid() IS NOT NULL)));



  create policy "Users can read own profile"
  on "public"."profiles"
  as permissive
  for select
  to public
using ((id = auth.uid()));



  create policy "Users can update own profile"
  on "public"."profiles"
  as permissive
  for update
  to public
using ((id = auth.uid()));



  create policy "auth_manage_purchase_orders"
  on "public"."purchase_orders"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_recipe_ingredients"
  on "public"."recipe_ingredients"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_recipe_prep_items"
  on "public"."recipe_prep_items"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_recipes"
  on "public"."recipes"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_stores"
  on "public"."stores"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "Admins can manage all store links"
  on "public"."user_stores"
  as permissive
  for all
  to public
using ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])));



  create policy "Users can manage own store links"
  on "public"."user_stores"
  as permissive
  for all
  to public
using (((user_id = auth.uid()) OR (auth.uid() IS NOT NULL)));



  create policy "Users can read own store links"
  on "public"."user_stores"
  as permissive
  for select
  to public
using ((user_id = auth.uid()));



  create policy "auth_manage_vendors"
  on "public"."vendors"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));



  create policy "auth_manage_waste_log"
  on "public"."waste_log"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));


CREATE TRIGGER profiles_sync_role_to_jwt AFTER INSERT OR UPDATE OF role ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.sync_role_to_app_metadata();


