-- supabase/tests/ingredient_photos.test.sql
--
-- Spec 127 / design §14 — structural pgTAP coverage for the ingredient-photos
-- migration (20260721000000_ingredient_photos.sql):
--   (a) catalog_ingredients.image_path column exists and is nullable.
--   (b) the public `ingredient-images` Storage bucket exists and public = true.
--   (c) the four storage.objects policies exist with the intended shape:
--       - ingredient_images_public_read  : SELECT, bucket-scoped, PUBLIC
--         (does NOT reference the privilege/brand helpers — reads are open).
--       - ingredient_images_admin_insert : INSERT, WITH CHECK references
--         auth_is_privileged + auth_can_see_brand + storage.foldername.
--       - ingredient_images_admin_update : UPDATE, BOTH USING and WITH CHECK
--         reference the privilege + brand helpers.
--       - ingredient_images_admin_delete : DELETE, USING references the
--         privilege + brand helpers.
--
-- Design §14 / §15 note: full storage.objects RLS impersonation (INSERT a
-- brandA/... key under a simulated brand-A JWT and prove a brandB/... key is
-- rejected) is awkward in the pgTAP harness — the storage schema's own row
-- machinery (owner columns, triggers) is outside the migration's surface. Per
-- the design's named fallback, this file asserts the column + bucket +
-- policy existence/definition (the migration's actual surface). The predicate
-- CORRECTNESS (auth_can_see_brand on the first path folder) is pinned by the
-- policy-definition string assertions below; the runtime behaviour rides on the
-- already-tested auth_can_see_brand / auth_is_privileged helpers.
--
-- Hermetic: begin; ... rollback; (this file makes no writes, but keeps the
-- project-standard framing).

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── (a) column ────────────────────────────────────────────────
select has_column(
  'catalog_ingredients', 'image_path',
  '(1) catalog_ingredients has an image_path column'
);
select col_type_is(
  'catalog_ingredients', 'image_path', 'text',
  '(2) catalog_ingredients.image_path is text'
);
select col_is_null(
  'catalog_ingredients', 'image_path',
  '(3) catalog_ingredients.image_path is nullable (NULL = no photo)'
);

-- ─── (b) bucket ────────────────────────────────────────────────
select is(
  (select count(*)::int from storage.buckets where id = 'ingredient-images'),
  1,
  '(4) the ingredient-images bucket row exists'
);
select is(
  (select public from storage.buckets where id = 'ingredient-images'),
  true,
  '(5) the ingredient-images bucket is PUBLIC (public = true)'
);
select ok(
  (select allowed_mime_types @> array['image/jpeg']
     from storage.buckets where id = 'ingredient-images'),
  '(6) the bucket allows image/jpeg (defense-in-depth MIME allowlist)'
);

-- ─── (c) storage.objects policies ──────────────────────────────
-- RLS is enabled on storage.objects (Supabase default) — the policies only
-- take effect because of this.
select ok(
  (select relrowsecurity from pg_class
     where relname = 'objects' and relnamespace = 'storage'::regnamespace),
  '(7) storage.objects has RLS enabled'
);

-- SELECT: privilege + brand gated — the SAME predicate as the write policies.
-- Security Low #1: the SELECT policy is NO LONGER bare-public, so the
-- authenticated list/select API cannot enumerate other tenants' keys. Public
-- image DISPLAY is unaffected (it rides the public-CDN route, which does not
-- consult this RLS policy).
select is(
  (select cmd from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_public_read'),
  'SELECT',
  '(8) ingredient_images_public_read is a SELECT policy'
);
select ok(
  (select qual like '%ingredient-images%'
        and qual like '%auth_is_privileged%'
        and qual like '%auth_can_see_brand%'
        and qual like '%foldername%'
     from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_public_read'),
  '(9) SELECT is bucket-scoped AND privilege/brand-gated on the first path folder (anon enumeration closed — Security Low #1)'
);

-- INSERT: WITH CHECK references the privilege gate, the brand gate, and the
-- first-folder extraction.
select ok(
  (select cmd = 'INSERT'
        and with_check like '%auth_is_privileged%'
        and with_check like '%auth_can_see_brand%'
        and with_check like '%foldername%'
     from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_admin_insert'),
  '(10) admin_insert is INSERT, WITH CHECK gates on auth_is_privileged + auth_can_see_brand(foldername)'
);

-- UPDATE: BOTH USING (old row) and WITH CHECK (new row) reference the gates.
select ok(
  (select cmd = 'UPDATE'
        and qual like '%auth_is_privileged%'
        and qual like '%auth_can_see_brand%'
     from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_admin_update'),
  '(11) admin_update is UPDATE with a USING that gates the OLD row on privilege + brand'
);
select ok(
  (select with_check like '%auth_is_privileged%'
        and with_check like '%auth_can_see_brand%'
     from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_admin_update'),
  '(12) admin_update WITH CHECK gates the NEW row on privilege + brand'
);

-- DELETE: USING references the gates.
select ok(
  (select cmd = 'DELETE'
        and qual like '%auth_is_privileged%'
        and qual like '%auth_can_see_brand%'
     from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'ingredient_images_admin_delete'),
  '(13) admin_delete is DELETE, USING gates on auth_is_privileged + auth_can_see_brand'
);

-- All four policies scoped to the ingredient-images bucket (no bucket leak).
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'ingredient_images_%'
       and (qual like '%ingredient-images%' or with_check like '%ingredient-images%')),
  4,
  '(14) all four ingredient_images_* policies are scoped to the ingredient-images bucket'
);

select * from finish();
rollback;
