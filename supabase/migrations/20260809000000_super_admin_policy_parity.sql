-- ============================================================
-- Spec 157 — super_admin parity for the last seven bare
--            `auth_is_admin()` RLS policies, plus an additive
--            privilege payload on admin_db_inspector_probe().
--
-- Background. This database has three role helpers:
--   * public.auth_is_admin()      — NARROW. Reads the JWT
--     (`app_metadata.role`) and admits only 'admin' / 'master'.
--   * public.auth_is_super_admin() — reads `profiles.role`,
--     deliberately NOT the JWT ("super-admin must NOT be
--     settable from any UI" — 012a §2).
--   * public.auth_is_privileged() — the two, ORed. This is the
--     helper essentially every write policy in the schema uses.
--
-- Seven policies were never migrated off the narrow helper when
-- 012a (20260509000000_multi_brand_schema_rls.sql) introduced
-- super_admin. Because an UPDATE/DELETE whose USING clause fails
-- is not an ERROR — the rows simply do not match — PostgREST
-- returns 204 and `src/lib/db.ts` reports success. The owner's
-- super_admin account was therefore SILENTLY denied on:
--   * ingredient-category add / rename / delete, and
--   * every audit_log UPDATE / DELETE (including the audit
--     cascade inside deleteStore and the 90-day retention purge),
--   * plus SELECT/INSERT of store-less (`store_id IS NULL`)
--     audit rows.
-- Spec 051 explicitly noticed and deferred the
-- `ingredient_categories` three
-- (20260520010000_legacy_permissive_policy_dropout.sql:154-156);
-- this migration closes them and the four audit_log leftovers.
--
-- Fix shape. Replace `public.auth_is_admin()` with
-- `public.auth_is_privileged()` in each predicate and change
-- NOTHING else — not the policy name, not the `to` role list,
-- not the `store_id IS NOT NULL AND auth_can_see_store(store_id)`
-- OR-arms, not the permissive/restrictive kind. Every rewritten
-- predicate is a strict SUPERSET of its predecessor: 'admin' and
-- 'master' JWTs are admitted exactly as before, 'super_admin'
-- newly passes, and every non-privileged principal is still
-- refused. No principal loses access. This is the same shape
-- specs 013 (recipe_categories), 042 (order_schedule), 051
-- (user_stores) and 20260517020000 (the three admin RPCs) chose.
--
-- Policy names are kept VERBATIM (quoted-identifier spelling and
-- all). Renaming them into a `privileged_*` family would be
-- tidier but would show in `pg_policies` as a drop + an add per
-- policy, breaking the "exactly seven rows differ" regression
-- assertion this change is pinned by.
--
-- `public.auth_is_admin()` is deliberately NOT broadened.
-- Option (a) — teaching the narrow helper to accept the string
-- 'super_admin' — was evaluated and rejected: it would move
-- super_admin's grant onto the JWT (the one place 012a
-- deliberately kept it OFF), it would not fix a caller whose
-- profile was promoted mid-session (stale token), and it would
-- silently re-widen the ~40 store-scoped policies that ride
-- `auth_can_see_store()`'s `auth_is_admin()` OR-arm. Its body is
-- byte-unchanged here; the only statement below that names it at
-- the function level is a `comment on function`, which is
-- metadata (`pg_proc.prosrc` is untouched — verifiable with a
-- normalized md5 of `pg_get_functiondef` before/after).
--
-- Also in this migration: `public.admin_db_inspector_probe()` is
-- `create or replace`d with two ADDITIVE keys in its `auth`
-- object — `is_privileged` and `is_super_admin` — so the DB
-- Inspector banner can tell the truth about a super_admin caller
-- instead of keying off `is_admin` and rendering a red "you are
-- NOT admin" alarm. `is_admin` is KEPT (it tells you which arm
-- admitted you). The body is otherwise copied verbatim from
-- 20260517020000_admin_rpcs_use_privileged.sql; the entry guard,
-- `security definer`, `set search_path`, signature and grants are
-- unchanged (`create or replace` preserves grants — the
-- revoke/grant pair from 20260505065303 is intentionally NOT
-- re-issued).
--
-- Transaction wrapper. This file is explicitly `begin; … commit;`
-- wrapped, mirroring
-- 20260528000000_actor_fk_cascade_audit.sql:52. That is REQUIRED,
-- not decorative: (1) it guarantees no concurrent session
-- observes the sub-millisecond window between a `drop policy` and
-- its matching `create policy`, and (2) the house prod-apply path
-- is Supabase MCP `execute_sql` (the CLI lacks the prod
-- password), which does not guarantee statement-level atomicity
-- across a multi-statement body — a half-applied migration would
-- leave some policies widened and the probe unreplaced.
--
-- Policy DDL + one function replace + comments ONLY. No table,
-- column, index, constraint, trigger, grant, extension or
-- publication member is created, altered or dropped. Neither
-- `audit_log` nor `ingredient_categories` is a member of the
-- `supabase_realtime` publication at all (see
-- 20260514140000_realtime_publication_tighten.sql:43-53), so the
-- `docker restart supabase_realtime_imr-inventory` ritual does
-- NOT apply and must not be added to any checklist as a
-- defensive no-op.
--
-- Idempotent + re-runnable to a no-op: every `create policy` is
-- preceded by a `drop policy if exists` of the same name, the
-- function is `create or replace`, and comments overwrite.
-- No data migration, no backfill, nothing destructive.
--
-- Known, DEFERRED gap (not introduced here): the two
-- `admin_*_audit_log` policies have no store or brand scope at
-- all — any privileged caller can mutate any audit row in any
-- brand. That predates this migration; widening the role helper
-- adds a second principal class to a pre-existing hole rather
-- than opening a new one (and `auth_can_see_store()` already
-- short-circuits true for super_admin, so there is no net-new
-- visibility). Scoping it requires co-designing the retention
-- purge in `cleanupOldRecords`, which issues a global unfiltered
-- `delete from audit_log where created_at < cutoff`. Own spec.
-- Annotated inline via `comment on policy` below.
--
-- Rollback (operational reference — no down-migration shipped).
-- Paste the seven PRE-CHANGE statements to revert:
--
--   drop policy if exists "store_member_read_audit_log" on public.audit_log;
--   create policy "store_member_read_audit_log"
--     on public.audit_log for select
--     using (
--       (store_id is not null and public.auth_can_see_store(store_id))
--       or (store_id is null and public.auth_is_admin())
--     );
--
--   drop policy if exists "store_member_insert_audit_log" on public.audit_log;
--   create policy "store_member_insert_audit_log"
--     on public.audit_log for insert
--     with check (
--       (store_id is not null and public.auth_can_see_store(store_id))
--       or (store_id is null and public.auth_is_admin())
--     );
--
--   drop policy if exists "admin_update_audit_log" on public.audit_log;
--   create policy "admin_update_audit_log"
--     on public.audit_log for update
--     using (public.auth_is_admin())
--     with check (public.auth_is_admin());
--
--   drop policy if exists "admin_delete_audit_log" on public.audit_log;
--   create policy "admin_delete_audit_log"
--     on public.audit_log for delete
--     using (public.auth_is_admin());
--
--   drop policy if exists "Admins can write ingredient categories" on public.ingredient_categories;
--   create policy "Admins can write ingredient categories"
--     on public.ingredient_categories for insert
--     with check (public.auth_is_admin());
--
--   drop policy if exists "Admins can update ingredient categories" on public.ingredient_categories;
--   create policy "Admins can update ingredient categories"
--     on public.ingredient_categories for update
--     using (public.auth_is_admin())
--     with check (public.auth_is_admin());
--
--   drop policy if exists "Admins can delete ingredient categories" on public.ingredient_categories;
--   create policy "Admins can delete ingredient categories"
--     on public.ingredient_categories for delete
--     using (public.auth_is_admin());
--
-- Reverting the probe RPC: re-apply the function body from
-- 20260517020000_admin_rpcs_use_privileged.sql:14-135 verbatim.
-- The client tolerates the missing fields by design (it renders a
-- neutral "unknown" banner rather than a false green), so a probe
-- rollback is safe to do independently of a bundle rollback.
-- ============================================================

begin;

-- ─── (1) public.audit_log — four policies ─────────────────────
-- Source of truth for the pre-change text:
-- 20260504173035_per_store_rls_hardening.sql:160-181.
-- The `store_id is not null and auth_can_see_store(store_id)`
-- arms are byte-unchanged; only the store-less OR-arm's role
-- helper widens.

drop policy if exists "store_member_read_audit_log" on public.audit_log;

create policy "store_member_read_audit_log"
  on public.audit_log for select
  using (
    (store_id is not null and public.auth_can_see_store(store_id))
    or (store_id is null and public.auth_is_privileged())
  );

comment on policy "store_member_read_audit_log" on public.audit_log is
  'spec 157: store-scoped arm delegates to auth_can_see_store() (unchanged). The store_id IS NULL arm — cross-cutting events with no store yet — widened from auth_is_admin() to auth_is_privileged() so super_admin can read them. Strict superset; admin/master unchanged.';

drop policy if exists "store_member_insert_audit_log" on public.audit_log;

create policy "store_member_insert_audit_log"
  on public.audit_log for insert
  with check (
    (store_id is not null and public.auth_can_see_store(store_id))
    or (store_id is null and public.auth_is_privileged())
  );

comment on policy "store_member_insert_audit_log" on public.audit_log is
  'spec 157: mirror of store_member_read_audit_log on the INSERT path. Store-scoped arm unchanged; the store_id IS NULL arm widened from auth_is_admin() to auth_is_privileged().';

drop policy if exists "admin_update_audit_log" on public.audit_log;

create policy "admin_update_audit_log"
  on public.audit_log for update
  using (public.auth_is_privileged())
  with check (public.auth_is_privileged());

comment on policy "admin_update_audit_log" on public.audit_log is
  'spec 157: widened auth_is_admin() -> auth_is_privileged() so super_admin is not silently denied (an RLS-shadowed UPDATE returns 0 rows, not an error, so db.ts reported success). KNOWN DEFERRED GAP, pre-dating this change: this policy has NO store or brand scope — any privileged caller may update any audit row in any brand. Scoping it requires co-designing cleanupOldRecords'' global unfiltered retention purge (src/lib/db.ts) and deciding who may purge store_id IS NULL rows. Own spec; see spec 157 OQ-3 / FUTURE-1.';

drop policy if exists "admin_delete_audit_log" on public.audit_log;

create policy "admin_delete_audit_log"
  on public.audit_log for delete
  using (public.auth_is_privileged());

comment on policy "admin_delete_audit_log" on public.audit_log is
  'spec 157: widened auth_is_admin() -> auth_is_privileged(); see admin_update_audit_log for the identical rationale. KNOWN DEFERRED GAP, pre-dating this change: no store or brand scope. Own spec; see spec 157 OQ-3 / FUTURE-1.';


-- ─── (2) public.ingredient_categories — three write policies ──
-- Source of truth for the pre-change text:
-- 20260507015244_spec004_ingredient_categories_rls_p6.sql:37-48.
-- The fourth policy on this table — "Authenticated can read
-- ingredient categories" (SELECT, `to authenticated using
-- (true)`, rewritten by spec 051 and on the spec-053 lint
-- allowlist) — is deliberately NOT touched. No SELECT clause is
-- loosened here and no allowlist row is added:
-- `auth_is_privileged()` is a function call, not one of the
-- trivially-wide tokens the spec-053 regex matches.

drop policy if exists "Admins can write ingredient categories" on public.ingredient_categories;

create policy "Admins can write ingredient categories"
  on public.ingredient_categories for insert
  with check (public.auth_is_privileged());

drop policy if exists "Admins can update ingredient categories" on public.ingredient_categories;

create policy "Admins can update ingredient categories"
  on public.ingredient_categories for update
  using (public.auth_is_privileged())
  with check (public.auth_is_privileged());

drop policy if exists "Admins can delete ingredient categories" on public.ingredient_categories;

create policy "Admins can delete ingredient categories"
  on public.ingredient_categories for delete
  using (public.auth_is_privileged());


-- ─── (3) The narrow/wide rule, recorded in-database ───────────
-- Metadata only. `public.auth_is_admin()`'s body is NOT modified
-- by this migration (or by anything in spec 157).

comment on function public.auth_is_admin() is
  'NARROW tier. Reads the JWT only: true iff app_metadata.role is ''admin'' or ''master''. '
  'super_admin is INTENTIONALLY excluded — its source of truth is profiles.role via '
  'public.auth_is_super_admin(), deliberately not the token, so super-admin cannot be granted '
  'from any UI (012a §2). Consequence: this helper returns FALSE for a super_admin caller, and '
  'that is correct, not a bug. '
  'NEW RLS policies and SECURITY DEFINER guards should gate on public.auth_is_privileged() '
  '(= auth_is_admin() OR auth_is_super_admin()) unless they deliberately mean to exclude '
  'super_admin — in which case the exclusion MUST be stated in a `comment on policy` (see '
  'public.user_count_drafts / public.user_count_orders for the deliberate-no-privileged-bypass '
  'counter-example). '
  'Spec 157 closed the last seven leftovers that gated on this helper directly: audit_log x4 '
  '(store_member_read/insert_audit_log store-less OR-arm, admin_update/delete_audit_log) and '
  'ingredient_categories x3 (write/update/delete). An eighth is a regression — '
  'supabase/tests/super_admin_policy_parity.test.sql arm LINT-1 fails the build on one.';


-- ─── (4) public.admin_db_inspector_probe() — additive payload ─
-- Body copied VERBATIM from
-- 20260517020000_admin_rpcs_use_privileged.sql:14-135. The ONLY
-- change is inside the 'auth' jsonb_build_object: two added keys.
-- Signature, volatility, security definer, search_path, the
-- `auth_is_privileged()` entry guard, and the schema / counts /
-- recipe_groups / prep_groups blocks are byte-identical.
-- Grants are preserved by `create or replace`; the revoke/grant
-- pair from 20260505065303_admin_rpcs_lock_anon.sql is
-- intentionally NOT re-issued.

create or replace function public.admin_db_inspector_probe()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.auth_is_privileged() then
    raise exception 'admin only';
  end if;

  select jsonb_build_object(
    'auth', jsonb_build_object(
      'is_admin', public.auth_is_admin(),
      'is_privileged', public.auth_is_privileged(),
      'is_super_admin', public.auth_is_super_admin(),
      'app_metadata', coalesce(auth.jwt() -> 'app_metadata', '{}'::jsonb),
      'user_id', auth.uid()
    ),
    'schema', jsonb_build_object(
      'recipes_has_store_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'recipes' and column_name = 'store_id'
      ),
      'recipes_has_brand_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'recipes' and column_name = 'brand_id'
      ),
      'prep_has_store_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'prep_recipes' and column_name = 'store_id'
      ),
      'prep_has_brand_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'prep_recipes' and column_name = 'brand_id'
      ),
      'has_p3_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'recipes_brand_menu_item_unique'
      ),
      'has_legacy_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'recipes_menu_item_store_id_unique'
      ),
      'has_prep_partial_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'prep_recipes_brand_name_current_unique'
      )
    ),
    'counts', jsonb_build_object(
      'recipes_total', (select count(*) from recipes),
      'prep_total', (select count(*) from prep_recipes),
      'prep_current', (select count(*) from prep_recipes where is_current)
    ),
    'recipe_groups', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand_id', brand_id,
          'lname', lname,
          'display_name', display_name,
          'total', total,
          'rows', rows
        )
      )
      from (
        select
          r.brand_id,
          lower(r.menu_item) as lname,
          (array_agg(r.menu_item order by r.created_at))[1] as display_name,
          count(*) as total,
          jsonb_agg(jsonb_build_object(
            'id', r.id,
            'menu_item', r.menu_item,
            'created_at', r.created_at,
            'recipe_ingredients_count', (select count(*) from recipe_ingredients ri where ri.recipe_id = r.id),
            'recipe_prep_items_count',  (select count(*) from recipe_prep_items rpi where rpi.recipe_id = r.id),
            'pos_import_items_count',   (select count(*) from pos_import_items pii where pii.recipe_id = r.id),
            'pos_recipe_aliases_count', (select count(*) from pos_recipe_aliases pra where pra.recipe_id = r.id)
          ) order by r.created_at) as rows
        from recipes r
        group by r.brand_id, lower(r.menu_item)
        having count(*) > 1
      ) g
    ), '[]'::jsonb),
    'prep_groups', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand_id', brand_id,
          'lname', lname,
          'display_name', display_name,
          'total', total,
          'current_count', current_count,
          'rows', rows
        )
      )
      from (
        select
          p.brand_id,
          lower(p.name) as lname,
          (array_agg(p.name order by p.created_at desc))[1] as display_name,
          count(*) as total,
          count(*) filter (where p.is_current) as current_count,
          jsonb_agg(jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'version', p.version,
            'is_current', p.is_current,
            'parent_id', p.parent_id,
            'created_at', p.created_at,
            'prep_recipe_ingredients_count', (select count(*) from prep_recipe_ingredients pri where pri.prep_recipe_id = p.id),
            'recipe_prep_items_count',       (select count(*) from recipe_prep_items rpi where rpi.prep_recipe_id = p.id),
            'sub_recipe_refs_count',         (select count(*) from prep_recipe_ingredients pri where pri.sub_recipe_id = p.id)
          ) order by p.created_at desc) as rows
        from prep_recipes p
        group by p.brand_id, lower(p.name)
        having count(*) > 1
      ) g
    ), '[]'::jsonb)
  )
  into result;
  return result;
end
$$;

commit;
