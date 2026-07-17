-- ============================================================
-- Spec 127 — Ingredient photos.
--
-- First use of Supabase Storage in the repo. Adds one brand-level photo per
-- catalog ingredient. Three additive, idempotent things (design §1):
--
--   (a) catalog_ingredients.image_path  — nullable text; stores the object PATH
--       (not a URL), resolved to a public CDN URL client-side. NULL = no photo.
--       No default, no backfill (no bulk import per spec). The existing
--       brand-scoped catalog_ingredients UPDATE policy (auth_is_privileged() AND
--       auth_can_see_brand(brand_id), from 20260509000000_multi_brand_schema_rls)
--       already governs this column write — NO new policy on the table (design §2).
--
--   (b) The PUBLIC-read Storage bucket 'ingredient-images'. Reads are public
--       (plain <Image src={getPublicUrl(path)}>, CDN-cacheable). Tradeoff
--       explicitly accepted (design §0.1): a leaked object URL is viewable
--       without auth — acceptable for low-sensitivity food photos. WRITES are
--       fully RLS-gated (see (c)). A future sensitive image class needs a
--       SEPARATE private bucket + signed URLs — do not downgrade this bucket.
--
--   (c) storage.objects RLS policies scoped to bucket_id = 'ingredient-images'.
--       Path scheme is <brand_id>/<catalog_id>/<uuid>.jpg, so the FIRST path
--       folder is the brand id, gated via (storage.foldername(name))[1]::uuid.
--       ALL of SELECT/INSERT/UPDATE/DELETE require auth_is_privileged() AND
--       auth_can_see_brand(<first folder>). SELECT is scoped (not bare-public)
--       so the authenticated list/select API cannot enumerate other tenants'
--       <brand_id>/<catalog_id> keys (Security Low #1); public image DISPLAY is
--       unaffected because it rides the public-CDN route (getPublicUrl /
--       /object/public/...), which does NOT consult this RLS policy on a
--       public = true bucket. storage.foldername(name) returns
--       text[] (verified against the local storage schema); auth_can_see_brand
--       is SECURITY DEFINER and already granted to authenticated, so it is
--       callable from a storage.objects policy.
--
-- Realtime: NONE. image_path lands on catalog_ingredients (already published);
-- the migration does NOT alter the supabase_realtime publication, so the
-- publication-restart gotcha does NOT apply (design §12).
--
-- Idempotent for the local + prod (MCP) double-apply: `add column if not exists`,
-- `on conflict do update` on the bucket row, and `drop policy if exists` before
-- each `create policy`.
-- ============================================================

-- (a) Column — additive, nullable.
alter table public.catalog_ingredients
  add column if not exists image_path text;

-- (b) Bucket row — idempotent. public=true → CDN public-read. file_size_limit
-- (5 MB) is a backstop; the client downscales to well under that.
-- allowed_mime_types is defense-in-depth (the client always transcodes to JPEG).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ingredient-images', 'ingredient-images', true, 5242880,
        array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- (c) storage.objects policies — all scoped to bucket_id = 'ingredient-images'
-- so they cannot leak onto any other bucket. Wrapped drop-then-create for the
-- local + prod double-apply.

-- SELECT: privileged caller whose brand matches the first path folder — SAME
-- gate as the write policies. This does NOT affect image DISPLAY: the bucket
-- stays public = true, and the app renders images via the public-CDN route
-- (/object/public/... / getPublicUrl), which serves public-bucket objects
-- WITHOUT consulting this RLS policy. This policy only governs the
-- authenticated list/select API (which the app never uses for display), so
-- scoping it closes anon enumeration of every <brand_id>/<catalog_id> across
-- tenants while staff/admin <Image> rendering is unaffected. (Security Low #1.)
drop policy if exists ingredient_images_public_read on storage.objects;
create policy ingredient_images_public_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'ingredient-images'
    and public.auth_is_privileged()
    and public.auth_can_see_brand((storage.foldername(name))[1]::uuid)
  );

-- INSERT: privileged caller whose brand matches the first path folder.
drop policy if exists ingredient_images_admin_insert on storage.objects;
create policy ingredient_images_admin_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'ingredient-images'
    and public.auth_is_privileged()
    and public.auth_can_see_brand((storage.foldername(name))[1]::uuid)
  );

-- UPDATE: gate BOTH the old row (USING) and the new row (WITH CHECK).
drop policy if exists ingredient_images_admin_update on storage.objects;
create policy ingredient_images_admin_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'ingredient-images'
    and public.auth_is_privileged()
    and public.auth_can_see_brand((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'ingredient-images'
    and public.auth_is_privileged()
    and public.auth_can_see_brand((storage.foldername(name))[1]::uuid)
  );

-- DELETE: privileged caller whose brand matches the first path folder.
drop policy if exists ingredient_images_admin_delete on storage.objects;
create policy ingredient_images_admin_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'ingredient-images'
    and public.auth_is_privileged()
    and public.auth_can_see_brand((storage.foldername(name))[1]::uuid)
  );
