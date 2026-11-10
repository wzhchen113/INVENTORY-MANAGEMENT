-- Spec 194 prod verification queries (D-11 steps 0 and 4). READ-ONLY.
-- Run each block through the Supabase MCP execute_sql on project
-- ebwnovzzkwhsdxkpyjka, and compare every value with "Expected" in
-- specs/194-kept-records-delete-hardening.md D-11 (computed on local).
-- The catalog strings are the same expressions as arms C-1a, C-1b, C-2, C-4
-- and C-5 in supabase/tests/kept_records_delete_hardening.test.sql.

-- ─── V0: BEFORE apply ──────────────────────────────────────────
-- V0a: spec 186's three policy comments are byte-identical to the repo file
-- (the rollback restores that text). Expect the three md5s in D-11 step 0.
select pol.polname, md5(d.description) as comment_md5
  from pg_policy pol
  join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
 where pol.polname in ('purchase_orders_restrict_delete_aged', 'waste_log_restrict_delete_aged',
                       'pos_imports_restrict_delete_aged')
 order by pol.polname;

-- V0b: none of spec 194's objects exists yet. Expect 0 / 0 / 0.
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('kept_record_lock_date', 'purchase_orders_block_return_to_draft',
                     'po_items_lock_po_id', 'pos_import_items_lock_import_id')) as fns,
  (select count(*) from pg_trigger where not tgisinternal
     and tgname in ('purchase_orders_lock_created_at_trg', 'waste_log_lock_logged_at_trg',
                    'pos_imports_lock_imported_at_trg', 'purchase_orders_no_return_to_draft_trg',
                    'po_items_lock_po_id_trg', 'pos_import_items_lock_import_id_trg')) as trgs,
  (select count(*) from pg_policies where schemaname = 'public'
     and policyname in ('po_items_restrict_delete_non_draft', 'pos_import_items_restrict_delete')) as pols;

-- ─── V1: AFTER apply ───────────────────────────────────────────
-- V1a (= C-1a): PERMISSIVE policies on the five tables.
select string_agg(tablename || '/' || policyname || '/' || cmd, ', ' order by tablename, policyname) as c1a
  from pg_policies
 where schemaname = 'public'
   and tablename in ('purchase_orders', 'po_items', 'waste_log', 'pos_imports', 'pos_import_items')
   and permissive = 'PERMISSIVE';

-- V1b (= C-1b): RESTRICTIVE policies with their qual.
select string_agg(tablename || '/' || policyname || '/' || cmd || '/' || qual, ', ' order by tablename, policyname) as c1b
  from pg_policies
 where schemaname = 'public'
   and tablename in ('purchase_orders', 'po_items', 'waste_log', 'pos_imports', 'pos_import_items')
   and permissive = 'RESTRICTIVE';

-- V1c (= C-2): the six triggers, including tgargs.
select string_agg(format('%s/%s/%s/%s/%s/%s/%s',
         t.tgrelid::regclass, t.tgname, t.tgenabled, t.tgtype, p.proname,
         (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])),
         encode(t.tgargs, 'escape')), ', ' order by t.tgname) as c2
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where not t.tgisinternal
   and t.tgname in ('purchase_orders_lock_created_at_trg', 'waste_log_lock_logged_at_trg',
                    'pos_imports_lock_imported_at_trg', 'purchase_orders_no_return_to_draft_trg',
                    'po_items_lock_po_id_trg', 'pos_import_items_lock_import_id_trg');

-- V1d (= C-2b, C-3): no user DELETE trigger on the line tables; trigger order.
select
  (select count(*) from pg_trigger where not tgisinternal
     and tgrelid in ('public.po_items'::regclass, 'public.pos_import_items'::regclass)
     and (tgtype & 8) <> 0) as line_delete_trgs,
  (select array_agg(tgname::text order by tgname collate "C") from pg_trigger
    where tgrelid = 'public.po_items'::regclass and not tgisinternal
      and tgname in ('po_items_check_store_trg', 'po_items_lock_po_id_trg')) as c3;

-- V1e (= C-4, plus D-11's md5 / owner / ACL): the four functions.
select p.proname,
       format('%s/%s/%s/%s', p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'execute'),
              has_function_privilege('authenticated', p.oid, 'execute')) as c4,
       md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))) as norm_md5,
       pg_get_userbyid(p.proowner) as owner,
       p.proacl::text as acl
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('kept_record_lock_date', 'purchase_orders_block_return_to_draft',
                     'po_items_lock_po_id', 'pos_import_items_lock_import_id')
 order by p.proname;

-- V1f (= C-5, plus md5): all five policy comments (3 rewritten, 2 new).
select pol.polname,
       format('%s:%s:%s',
              d.description like 'spec 186: RESTRICTIVE.%',
              d.description not like '%Not a security boundary%',
              d.description like '%Since spec 194 (kept-records delete hardening), staff cannot change%') as c5,
       md5(d.description) as comment_md5
  from pg_policy pol
  join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
 where pol.polname in ('purchase_orders_restrict_delete_aged', 'waste_log_restrict_delete_aged',
                       'pos_imports_restrict_delete_aged', 'po_items_restrict_delete_non_draft',
                       'pos_import_items_restrict_delete')
 order by pol.polname;

-- V1g: the version is recorded. Expect one row.
select version, name from supabase_migrations.schema_migrations where version = '20261109170000';
