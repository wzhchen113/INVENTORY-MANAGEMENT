-- ============================================================
-- Spec 051: Legacy permissive-policy dropout
--           (stores + user_stores + categories sweep).
--
-- Closes the "ORed-permissive-policy" footgun discovered in prod:
-- a legacy `auth_manage_stores` policy on `public.stores` with
-- `cmd=ALL` and `using (auth.uid() IS NOT NULL)` was never dropped
-- when spec 041 added the brand-scoped `store_member_read_stores`.
-- Postgres ORs permissive policies for the same `(table, command)`
-- pair, so the wide policy silently neutralized the scoped one for
-- every authed caller — re-opening cross-brand visibility (and a
-- catastrophic-if-exploited cross-brand WRITE path).
--
-- Same shape on `public.user_stores`: the legacy
-- `Users can manage own store links` policy uses
-- `((user_id = auth.uid()) OR (auth.uid() IS NOT NULL))`, where
-- the second OR-arm neutralizes the first; the legacy
-- `Admins can manage all store links` policy uses a raw JWT
-- app_metadata check with no brand scope (same shape spec 042
-- closed on profiles).
--
-- The two `*_categories` SELECT policies use the wide pattern
-- intentionally (curated master data shared across brands per
-- spec 004 / 013). This migration DROPs + recreates each as
-- `for select to authenticated using (true)` for clarity
-- (semantically identical to `auth.uid() IS NOT NULL` for the
-- `authenticated` role) and adds an inline `comment on policy`
-- pinning the cross-brand intent.
--
-- After this migration:
--   - `public.stores`: 4 scoped policies cover every command path
--     (`store_member_read_stores` SELECT, `privileged_*_stores`
--     INSERT/UPDATE/DELETE). The wide ALL policy is gone.
--   - `public.user_stores`: 3 policies — own-row ALL
--     (`user_id = auth.uid()`), brand-scoped admin ALL
--     (`auth_is_privileged() AND exists ... auth_can_see_brand`),
--     and the pre-existing own-SELECT policy (unchanged). The
--     `user_stores_brand_match` trigger remains as belt-and-
--     suspenders behind the brand-scoped admin policy.
--   - `public.ingredient_categories`: 4 policies, SELECT
--     semantically unchanged but rewritten for clarity. Write
--     policies untouched.
--   - `public.recipe_categories`: 2 policies, SELECT semantically
--     unchanged but rewritten for clarity. Write policy untouched.
--
-- Policy DDL ONLY. No table-schema changes, no new columns, no
-- new indexes, no new triggers, no new helper functions. The
-- realtime publication is unchanged (neither `stores` nor
-- `user_stores` are members per the spec 045 publication tighten),
-- so the docker restart ritual is NOT required.
--
-- Idempotent + re-runnable: every `drop policy` is
-- `drop policy if exists`. Every `create policy` is preceded by a
-- matching `drop policy if exists` of the same name. Re-applying
-- the migration is a no-op.
--
-- Rollback (operational reference — no down-migration shipped):
--   create policy "auth_manage_stores"
--     on "public"."stores" as permissive for all to public
--     using ((auth.uid() IS NOT NULL));
--   create policy "Users can manage own store links"
--     on "public"."user_stores" as permissive for all to public
--     using (((user_id = auth.uid()) OR (auth.uid() IS NOT NULL)));
--   create policy "Admins can manage all store links"
--     on "public"."user_stores" as permissive for all to public
--     using ((((auth.jwt() -> 'app_metadata') ->> 'role') = ANY
--             (ARRAY['admin'::text, 'master'::text])));
--   -- Categories SELECTs can be restored by re-running spec 004
--   -- P6 (20260507015244) and spec 013 (20260510030000).
--
-- See specs/051-legacy-permissive-policy-dropout.md
-- §"Backend design" for the full before/after policy matrix and
-- per-operation coverage proof.
-- ============================================================


-- ─── (1) public.stores — drop the legacy wide ALL policy ──────
-- The four scoped policies from 012a
-- (20260509000000_multi_brand_schema_rls.sql:610-643) cover every
-- command path. No replacement policy needed.
drop policy if exists "auth_manage_stores" on public.stores;


-- ─── (2) public.user_stores — replace the two legacy policies ─
-- The legacy `Users can manage own store links` predicate
-- `((user_id = auth.uid()) OR (auth.uid() IS NOT NULL))` allowed
-- any authenticated caller to manage any other user's grant rows.
-- The legacy `Admins can manage all store links` predicate gates
-- on raw JWT app_metadata.role with no brand scope (same shape
-- spec 042 closed on profiles). Replace both:
--   (2a) own-row ALL: caller can only manage rows for themselves.
--   (2b) admin ALL:  privileged caller can manage rows whose
--                    store's brand_id is visible to the caller
--                    via auth_can_see_brand. super_admin spans
--                    every brand via the short-circuit inside
--                    auth_can_see_brand.
-- The `Users can read own store links` SELECT policy at
-- remote_schema.sql:489-494 is scoped-correct (`user_id =
-- auth.uid()`) and is NOT touched — after dropping the wide ALL
-- policy, it becomes the sole own-row SELECT gate.
drop policy if exists "Users can manage own store links" on public.user_stores;
drop policy if exists "Admins can manage all store links" on public.user_stores;

create policy "Users can manage own store links"
  on public.user_stores
  as permissive
  for all
  to public
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on policy "Users can manage own store links" on public.user_stores is
  'spec 051: own-row self-management. Drops the legacy OR-arm `auth.uid() IS NOT NULL` that admitted any authed caller to manage any other user''s grants.';

create policy "Admins can manage all store links"
  on public.user_stores
  as permissive
  for all
  to public
  using (
    public.auth_is_privileged()
    and exists (
      select 1
        from public.stores s
       where s.id = user_stores.store_id
         and public.auth_can_see_brand(s.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1
        from public.stores s
       where s.id = user_stores.store_id
         and public.auth_can_see_brand(s.brand_id)
    )
  );

comment on policy "Admins can manage all store links" on public.user_stores is
  'spec 051: admin/master/super_admin arm brand-scoped via auth_can_see_brand on the target store''s brand_id. Closes the same-shape cross-brand admin gap spec 042 closed on profiles. Trigger user_stores_brand_match remains belt-and-suspenders for the super_admin path (admits via brand short-circuit).';


-- ─── (3) public.ingredient_categories — SELECT clarity rewrite ─
-- Semantically identical to the legacy `using (auth.uid() is not
-- null)`: `to authenticated using (true)` admits every
-- authenticated caller and (correctly) denies anon. The cross-
-- brand read is INTENTIONAL — ingredient categories are curated
-- master data shared across brands per spec 004. The
-- `comment on policy` promotes the previously-buried spec 013-era
-- comment ("intentionally left untouched") into a `pg_policies`-
-- visible annotation so future audits see the cross-brand intent
-- without grepping migrations.
--
-- Write policies on `public.ingredient_categories` are NOT touched
-- — they remain gated by `auth_is_admin()` per spec 004 P6
-- (20260507015244_spec004_ingredient_categories_rls_p6.sql:37-48).
drop policy if exists "Authenticated can read ingredient categories" on public.ingredient_categories;

create policy "Authenticated can read ingredient categories"
  on public.ingredient_categories
  as permissive
  for select
  to authenticated
  using (true);

comment on policy "Authenticated can read ingredient categories" on public.ingredient_categories is
  'spec 051: intentionally cross-brand. Ingredient categories are curated master data shared across brands per spec 004. Predicate semantically identical to the legacy `auth.uid() is not null`; the explicit `to authenticated` role gate is clearer.';


-- ─── (4) public.recipe_categories — SELECT clarity rewrite ────
-- Same shape as (3). The cross-brand read is INTENTIONAL per spec
-- 013; the inline source comment at
-- 20260510030000_recipe_categories_super_admin_rls.sql:16-18
-- already documents this. The `comment on policy` promotes that
-- buried comment into a `pg_policies`-visible annotation.
--
-- Write policy on `public.recipe_categories` is NOT touched —
-- spec 013 (20260510030000) already brought it to
-- `auth_is_privileged()`.
drop policy if exists "Authenticated can read categories" on public.recipe_categories;

create policy "Authenticated can read categories"
  on public.recipe_categories
  as permissive
  for select
  to authenticated
  using (true);

comment on policy "Authenticated can read categories" on public.recipe_categories is
  'spec 051: intentionally cross-brand. Recipe categories are curated master data shared across brands per spec 013. Predicate semantically identical to the legacy `auth.uid() is not null`; the explicit `to authenticated` role gate is clearer.';
