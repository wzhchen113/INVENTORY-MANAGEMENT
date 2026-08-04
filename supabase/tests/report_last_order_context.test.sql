-- supabase/tests/report_last_order_context.test.sql
--
-- Spec 151 (AC-28, design §10) — pgTAP coverage for
-- public.report_last_order_context(uuid, uuid[], date), shipped in
-- supabase/migrations/20260803000000_report_last_order_context.sql.
--
-- Plan (41 arms):
--   ANCHOR PRECEDENCE (AC-2 / R-C) — the precedence table walked row by row,
--   one vendor per rung so each pick is isolated rather than inferred from a
--   sequence of deletes:
--     (A1) all four candidate kinds ⇒ the sent/partial/received PO wins (tier 1,
--          'placed'). This ALSO pins R-2: tier DOMINATES recency — a sent PO
--          from June outranks a draft PO from last week.
--     (A2) no tier-1 PO ⇒ the 'ordered' approval wins (tier 2, 'placed').
--     (A3) no tier-1/2 ⇒ the 'approved' approval wins (tier 3, 'recorded').
--     (A4) only a draft PO ⇒ it wins (tier 4, 'recorded').
--   EXCLUSIONS + R-D
--     (X1) a 'cancelled' PO as the ONLY candidate ⇒ the vendor is OMITTED from
--          vendors[] (not returned with a null date — R-D).
--     (X2) a 'pending' approval as the ONLY candidate ⇒ likewise OMITTED.
--   TIE-BREAKS + WINDOW
--     (T1) two sent POs, different reference_date ⇒ the later date wins.
--     (T2) two sent POs, same reference_date ⇒ the later created_at wins.
--     (T3) a sent PO dated EXACTLY p_as_of_date is NOT an anchor ('<' is strict)
--          ⇒ vendor omitted.
--     (T4) R-3 — a PO with a NULL reference_date anchors on its created_at date.
--   COUNTED RESOLUTION (AC-6 / R-E)
--     (F1) an approval with source_submission_id uses THAT submission, even when
--          a different submission exists on the approval's own business_date.
--     (F2) R-E — an approval with a NULL source_submission_id falls back to the
--          (store, vendor, business_date) identity match.
--     (F3) a PO anchor resolves the count by reference_date → eod_submissions.date.
--     (F4) a submission whose status is not 'submitted' does NOT match ⇒
--          counted_date is JSON null.
--   LINES (AC-7 / AC-8 / summing)
--     (L1) two po_items rows for one item on the anchor PO are SUMMED.
--     (L2) the counted figure for that item comes from the anchoring submission.
--     (L3) AC-7 — an item on the order with no count entry has counted_qty_base
--          JSON **null** (asserted via jsonb_typeof, NOT `= 0`).
--     (L4) AC-8 — an item in the anchoring count but NOT on the order has
--          ordered_qty_base JSON **null**.
--   FAN-OUT + MALFORMED ROWS (the two shapes that make ONE bad row poison the
--   WHOLE screen, since this RPC returns one envelope for every vendor)
--     (D1) eod_entries has no (submission_id, item_id) uniqueness and both
--          writers delete-then-insert a client array: TWO entries for one item
--          on the anchoring submission still yield exactly ONE items[] element.
--     (D2) …and its counted_qty_base is the LAST-WRITTEN value, not a sum
--          (summing would invent a total the staff never entered — AC-10).
--     (G1) an approval whose lines[] carries a NON-UUID item_id does not 22P02
--          the read: the malformed element is skipped and the vendor's other
--          item still resolves.
--     (G2) …and the malformed element contributes NO items[] row.
--   AUTHORIZATION (AC-20 / R-B / R-5)
--     (Z1) a store that exists but the caller cannot see ⇒ 42501.
--     (Z2) an unknown store id ⇒ 42501 (same refusal, no information leak).
--     (Z3) R-5 — a store-linked NON-privileged caller does NOT see an
--          order_approvals-sourced anchor: the vendor is omitted.
--     (Z4) …and that same caller still resolves a purchase_orders-sourced anchor.
--          Together: the privilege conjunct is a ROW FILTER, not a feature gate,
--          which is exactly why there is NO top-level auth_is_privileged() gate.
--   BOUNDS (AC-22)
--     (B1) 101 vendor ids ⇒ 22023.  (B2) 100 ⇒ fine.
--     (B3) '{}'::uuid[] ⇒ vendors: [] with no exception.
--     (B4) NULL ⇒ vendors: [] with no exception.
--     (B5) a NESTED (2-D) array of 2 × 51 ids ⇒ 22023. array_length(_, 1) sees
--          only the first dimension and would let 102 (or 100 000) elements
--          through while unnest() flattens them all — cardinality() is the only
--          form that actually enforces the bound.
--     (U1) the per-vendor ITEM cap: 501 ordered items ⇒ items[] has exactly 500
--          elements and items_truncated is true.
--     (U2) …the DROPPED element is the lowest ordered_qty_base (rank 501) …
--     (U3) …and rank 500 is retained — the cap keeps the TOP 500 by quantity,
--          so a truncated payload is reproducible rather than arbitrary.
--   BASIS (R-6)
--     (Q1) a cases+each submission's actual_remaining surfaces as
--          counted_qty_base UNCHANGED (never recomputed from the splits).
--   LINT + SHAPE (AC-21 / AC-23 / R-B)
--    (P1a) the five source tables still carry their EXPECTED NAMED SELECT
--          policies — nothing renamed, nothing added.
--    (P1b) …and every one of those quals still routes through
--          auth_can_see_store (plus auth_is_privileged for order_approvals).
--          Together these are the entire authorization story a SECURITY INVOKER
--          function leans on.
--     (P2) authenticated HAS execute.   (P3) anon does NOT.
--     (P4) idx_eod_entries_submission_id exists (§1.2).
--     (P5) the function is SECURITY INVOKER (prosecdef = false) — R-B, pinned
--          structurally so a future "fix" to definer fails this suite.
--
-- Hermetic: begin; … rollback;. Every fixture is created inside the transaction
-- (green under the committed seed AND on a CI-fresh database). The
-- JWT-impersonation pattern is copied from order_approvals.test.sql.
--
-- NOTE on (P1a)/(P1b): design §10 arm 14 phrases this as "the pg_policies COUNT
-- for the five source tables is unchanged by this migration". A hard-coded count
-- goes red the first time an unrelated spec legitimately adds a policy to one of
-- those tables, and it says nothing about THIS function — so it is not written
-- that way.
--
-- It is also deliberately NOT a re-scoped copy of the spec-053 trivially-wide
-- detector (supabase/tests/permissive_policy_lint.test.sql). That probe already
-- scans ALL of public.*, which includes these five tables, so AC-21 is covered
-- without a second copy — and a second copy is exactly the "inline-not-shared is
-- invisible drift surface" failure mode from CLAUDE.md, with none of the
-- one-function-per-deploy justification the edge-function case has. (The copy
-- that previously lived here had ALREADY drifted: it reproduced the OR-tail
-- regex in its pre-spec-053-arm-4 form, without the negative lookahead + anchor
-- that keeps a legitimately AND-guarded OR-arm from being flagged. It would have
-- gone red inside THIS file for an unrelated spec's policy — the worst possible
-- place to debug that.)
--
-- What (P1a)/(P1b) assert instead is the claim that is specific to this spec:
-- the named SELECT policies this SECURITY INVOKER function delegates its ENTIRE
-- authorization story to still exist under the names and quals it assumes. A
-- future spec renaming or loosening one of them fails here, loudly.

begin;
create extension if not exists pgtap;

select plan(41);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin   (brand A, privileged)
  v_user_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', Frederick+Towson)
  v_store_a  uuid;
  v_brand_a  uuid;
  v_brand_b  uuid := '51b90000-0000-0000-0000-000000000001';  -- test-only foreign brand
  v_store_b  uuid := '51b90001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  select id, brand_id into v_store_a, v_brand_a
    from public.stores where name = 'Frederick' limit 1;
  perform set_config('test.admin_id', v_admin_id::text, true);
  perform set_config('test.user_id',  v_user_id::text,  true);
  perform set_config('test.store_a',  v_store_a::text,  true);
  perform set_config('test.brand_a',  v_brand_a::text,  true);
  perform set_config('test.brand_b',  v_brand_b::text,  true);
  perform set_config('test.store_b',  v_store_b::text,  true);
end $$;

insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 151)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (current_setting('test.store_b', true)::uuid,
        current_setting('test.brand_b', true)::uuid,
        'Foreign Store (test 151)', '1 Foreign Way', 'active', '22:00')
on conflict (id) do nothing;

-- Vendors — one per behavior under test, so no arm depends on another arm's
-- mutations.
insert into public.vendors (id, name, brand_id)
select v.id::uuid, v.nm, current_setting('test.brand_a', true)::uuid
  from (values
    ('51510000-0000-0000-0000-000000000001', '__loc_tier1__'),      -- A1
    ('51510000-0000-0000-0000-000000000002', '__loc_tier2__'),      -- A2
    ('51510000-0000-0000-0000-000000000003', '__loc_tier3__'),      -- A3
    ('51510000-0000-0000-0000-000000000004', '__loc_tier4__'),      -- A4
    ('51510000-0000-0000-0000-000000000005', '__loc_cancelled__'),  -- X1
    ('51510000-0000-0000-0000-000000000006', '__loc_pending__'),    -- X2
    ('51510000-0000-0000-0000-000000000007', '__loc_tie_date__'),   -- T1
    ('51510000-0000-0000-0000-000000000008', '__loc_tie_created__'),-- T2
    ('51510000-0000-0000-0000-000000000009', '__loc_asof__'),       -- T3
    ('51510000-0000-0000-0000-00000000000a', '__loc_nullref__'),    -- T4
    ('51510000-0000-0000-0000-00000000000b', '__loc_srcsub__'),     -- F1
    ('51510000-0000-0000-0000-00000000000c', '__loc_bydate__'),     -- F2
    ('51510000-0000-0000-0000-00000000000d', '__loc_po_count__'),   -- F3
    ('51510000-0000-0000-0000-00000000000e', '__loc_draft_sub__'),  -- F4
    ('51510000-0000-0000-0000-00000000000f', '__loc_lines__'),      -- L1..L4
    ('51510000-0000-0000-0000-000000000010', '__loc_cases_each__'), -- Q1
    ('51510000-0000-0000-0000-000000000011', '__loc_oa_only__'),    -- Z3
    ('51510000-0000-0000-0000-000000000012', '__loc_po_only__'),    -- Z4
    ('51510000-0000-0000-0000-000000000013', '__loc_trunc__'),      -- U1..U3
    ('51510000-0000-0000-0000-000000000014', '__loc_baditem__'),    -- G1/G2
    ('51510000-0000-0000-0000-000000000015', '__loc_dupcount__')    -- D1/D2
  ) as v(id, nm);

-- Catalog + store items. eod_entries_check_store_trg requires the item's store
-- to match the parent submission's store, so every item lives in store A.
insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty)
select c.id::uuid, current_setting('test.brand_a', true)::uuid, c.nm, 'lb', 6
  from (values
    ('51520000-0000-0000-0000-000000000001', '__loc_cat_1__'),
    ('51520000-0000-0000-0000-000000000002', '__loc_cat_2__'),
    ('51520000-0000-0000-0000-000000000003', '__loc_cat_3__'),
    ('51520000-0000-0000-0000-000000000004', '__loc_cat_4__')
  ) as c(id, nm);

insert into public.inventory_items (id, store_id, catalog_id)
select i.id::uuid, current_setting('test.store_a', true)::uuid, i.cat::uuid
  from (values
    ('51520001-0000-0000-0000-000000000001', '51520000-0000-0000-0000-000000000001'),
    ('51520001-0000-0000-0000-000000000002', '51520000-0000-0000-0000-000000000002'),
    ('51520001-0000-0000-0000-000000000003', '51520000-0000-0000-0000-000000000003'),
    ('51520001-0000-0000-0000-000000000004', '51520000-0000-0000-0000-000000000004')
  ) as i(id, cat);

-- (U1..U3) 501 catalog rows + store items for the ONE vendor that exercises the
-- per-vendor 500-item output cap. Generated rather than listed: the point of the
-- fixture is the number 501, and the cap has to be exercised against real SQL
-- execution — a hand-supplied items_truncated in a FE stub only proves the
-- snake→camel mapping, not that the backend enforces anything.
insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty)
select ('51560000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       current_setting('test.brand_a', true)::uuid,
       '__loc_bulk_' || i || '__', 'lb', 6
  from generate_series(1, 501) i;

insert into public.inventory_items (id, store_id, catalog_id)
select ('51570000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       current_setting('test.store_a', true)::uuid,
       ('51560000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
  from generate_series(1, 501) i;

-- ── purchase_orders ────────────────────────────────────────────
-- created_at is set explicitly ONLY where it is load-bearing (the T2 tie-break
-- and the T4 NULL-reference_date arm); everywhere else reference_date decides.
insert into public.purchase_orders (id, store_id, vendor_id, status, reference_date, created_at)
select p.id::uuid,
       current_setting('test.store_a', true)::uuid,
       p.vendor::uuid,
       p.status,
       nullif(p.ref, '')::date,
       coalesce(nullif(p.created, '')::timestamptz, now())
  from (values
    -- (A1) tier 1 — an OLD sent PO that must still beat the newer draft below.
    ('51530000-0000-0000-0000-000000000001', '51510000-0000-0000-0000-000000000001', 'sent',      '2026-06-18', ''),
    ('51530000-0000-0000-0000-000000000002', '51510000-0000-0000-0000-000000000001', 'draft',     '2026-07-28', ''),
    -- (A2) tier 4 draft present, tier 2 approval must win.
    ('51530000-0000-0000-0000-000000000003', '51510000-0000-0000-0000-000000000002', 'draft',     '2026-07-28', ''),
    -- (A3) tier 4 draft present, tier 3 approval must win.
    ('51530000-0000-0000-0000-000000000004', '51510000-0000-0000-0000-000000000003', 'draft',     '2026-07-28', ''),
    -- (A4) tier 4 alone.
    ('51530000-0000-0000-0000-000000000005', '51510000-0000-0000-0000-000000000004', 'draft',     '2026-07-28', ''),
    -- (X1) cancelled, and the only candidate for its vendor.
    ('51530000-0000-0000-0000-000000000006', '51510000-0000-0000-0000-000000000005', 'cancelled', '2026-07-28', ''),
    -- (T1) two sent POs, different reference_date.
    ('51530000-0000-0000-0000-000000000007', '51510000-0000-0000-0000-000000000007', 'sent',      '2026-07-10', ''),
    ('51530000-0000-0000-0000-000000000008', '51510000-0000-0000-0000-000000000007', 'sent',      '2026-07-17', ''),
    -- (T2) two sent POs, SAME reference_date, different created_at.
    ('51530000-0000-0000-0000-000000000009', '51510000-0000-0000-0000-000000000008', 'sent',      '2026-07-11', '2026-07-11 08:00:00+00'),
    ('51530000-0000-0000-0000-00000000000a', '51510000-0000-0000-0000-000000000008', 'sent',      '2026-07-11', '2026-07-11 19:30:00+00'),
    -- (T3) dated EXACTLY the as-of date ⇒ excluded by the strict '<'.
    ('51530000-0000-0000-0000-00000000000b', '51510000-0000-0000-0000-000000000009', 'sent',      '2026-08-01', ''),
    -- (T4) R-3 — NULL reference_date ⇒ anchors on created_at::date.
    ('51530000-0000-0000-0000-00000000000c', '51510000-0000-0000-0000-00000000000a', 'sent',      '',           '2026-07-22 12:00:00+00'),
    -- (F3) PO anchor whose reference_date matches a submitted count.
    ('51530000-0000-0000-0000-00000000000d', '51510000-0000-0000-0000-00000000000d', 'sent',      '2026-07-27', ''),
    -- (F4) PO anchor whose same-date submission is a DRAFT ⇒ no counted match.
    ('51530000-0000-0000-0000-00000000000e', '51510000-0000-0000-0000-00000000000e', 'sent',      '2026-07-28', ''),
    -- (L1..L4) the lines vendor.
    ('51530000-0000-0000-0000-00000000000f', '51510000-0000-0000-0000-00000000000f', 'sent',      '2026-07-29', ''),
    -- (Q1) the cases+each basis vendor.
    ('51530000-0000-0000-0000-000000000010', '51510000-0000-0000-0000-000000000010', 'sent',      '2026-07-30', ''),
    -- (Z4) a PO-sourced anchor the NON-privileged caller must still resolve.
    ('51530000-0000-0000-0000-000000000011', '51510000-0000-0000-0000-000000000012', 'sent',      '2026-07-21', ''),
    -- (U1..U3) the 501-line PO that trips the per-vendor item cap.
    ('51530000-0000-0000-0000-000000000012', '51510000-0000-0000-0000-000000000013', 'sent',      '2026-07-24', ''),
    -- (D1/D2) the anchor whose ONE submission holds TWO entries for one item.
    ('51530000-0000-0000-0000-000000000013', '51510000-0000-0000-0000-000000000015', 'sent',      '2026-07-19', '')
  ) as p(id, vendor, status, ref, created);

insert into public.po_items (po_id, item_id, ordered_qty)
select l.po::uuid, l.item::uuid, l.qty::numeric
  from (values
    -- (L1) TWO lines for the same item on one PO ⇒ summed to 13.
    ('51530000-0000-0000-0000-00000000000f', '51520001-0000-0000-0000-000000000001', '8'),
    ('51530000-0000-0000-0000-00000000000f', '51520001-0000-0000-0000-000000000001', '5'),
    -- (L3) ordered but never counted ⇒ AC-7.
    ('51530000-0000-0000-0000-00000000000f', '51520001-0000-0000-0000-000000000002', '12'),
    -- (Q1)
    ('51530000-0000-0000-0000-000000000010', '51520001-0000-0000-0000-000000000004', '30'),
    -- (D1/D2) one ordered line for the duplicated-count item.
    ('51530000-0000-0000-0000-000000000013', '51520001-0000-0000-0000-000000000001', '10')
  ) as l(po, item, qty);

-- (U1..U3) 501 lines on one PO, ordered_qty = i, so the ranking
-- (ordered_qty_base desc, item_id) is total and the cut is unambiguous:
-- i = 501 is rank 1, i = 2 is rank 500 (kept), i = 1 is rank 501 (dropped).
insert into public.po_items (po_id, item_id, ordered_qty)
select '51530000-0000-0000-0000-000000000012'::uuid,
       ('51570000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       i::numeric
  from generate_series(1, 501) i;

-- ── eod_submissions + eod_entries ──────────────────────────────
-- Seeded BEFORE order_approvals: (F1)'s approval carries a
-- source_submission_id FK into this table.
insert into public.eod_submissions (id, store_id, vendor_id, date, status)
select s.id::uuid,
       current_setting('test.store_a', true)::uuid,
       s.vendor::uuid, s.d::date, s.status
  from (values
    -- (F1) the submission the approval POINTS AT …
    ('51550000-0000-0000-0000-000000000001', '51510000-0000-0000-0000-00000000000b', '2026-07-23', 'submitted'),
    -- … and a decoy on the approval's own business_date, which must LOSE.
    ('51550000-0000-0000-0000-000000000002', '51510000-0000-0000-0000-00000000000b', '2026-07-25', 'submitted'),
    -- (F2) the identity match for the NULL-source_submission_id approval.
    ('51550000-0000-0000-0000-000000000003', '51510000-0000-0000-0000-00000000000c', '2026-07-26', 'submitted'),
    -- (F3) the PO anchor's reference_date match.
    ('51550000-0000-0000-0000-000000000004', '51510000-0000-0000-0000-00000000000d', '2026-07-27', 'submitted'),
    -- (F4) same date as the PO anchor but still a DRAFT ⇒ must NOT match.
    ('51550000-0000-0000-0000-000000000005', '51510000-0000-0000-0000-00000000000e', '2026-07-28', 'draft'),
    -- (L1..L4) the lines vendor's anchoring count.
    ('51550000-0000-0000-0000-000000000006', '51510000-0000-0000-0000-00000000000f', '2026-07-29', 'submitted'),
    -- (Q1) the cases+each count.
    ('51550000-0000-0000-0000-000000000007', '51510000-0000-0000-0000-000000000010', '2026-07-30', 'submitted'),
    -- (D1/D2) the anchoring count that holds TWO entries for the same item.
    ('51550000-0000-0000-0000-000000000008', '51510000-0000-0000-0000-000000000015', '2026-07-19', 'submitted')
  ) as s(id, vendor, d, status);

insert into public.eod_entries (submission_id, item_id, actual_remaining,
                                actual_remaining_cases, actual_remaining_each)
select e.sub::uuid, e.item::uuid, e.rem::numeric,
       nullif(e.cases, '')::numeric, nullif(e.each, '')::numeric
  from (values
    ('51550000-0000-0000-0000-000000000001', '51520001-0000-0000-0000-000000000001', '7',    '', ''),
    ('51550000-0000-0000-0000-000000000002', '51520001-0000-0000-0000-000000000002', '99',   '', ''),
    ('51550000-0000-0000-0000-000000000003', '51520001-0000-0000-0000-000000000001', '3',    '', ''),
    ('51550000-0000-0000-0000-000000000004', '51520001-0000-0000-0000-000000000001', '2',    '', ''),
    ('51550000-0000-0000-0000-000000000005', '51520001-0000-0000-0000-000000000001', '11',   '', ''),
    -- (L2) counted for the summed item …
    ('51550000-0000-0000-0000-000000000006', '51520001-0000-0000-0000-000000000001', '5',    '', ''),
    -- … and (L4) counted but NOT on the order ⇒ AC-8.
    ('51550000-0000-0000-0000-000000000006', '51520001-0000-0000-0000-000000000003', '4',    '', ''),
    -- (Q1) R-6 — a cases+each count whose actual_remaining is the client total.
    ('51550000-0000-0000-0000-000000000007', '51520001-0000-0000-0000-000000000004', '26.5', '4', '2.5')
  ) as e(sub, item, rem, cases, each);

-- (D1/D2) TWO entries for the SAME (submission_id, item_id). This is legal
-- today: eod_entries carries no uniqueness on that pair and both writers
-- delete-then-insert straight from a client-supplied array. created_at is
-- explicit so "last written wins" is a deterministic pin rather than a race.
insert into public.eod_entries (submission_id, item_id, actual_remaining, created_at)
values
  ('51550000-0000-0000-0000-000000000008'::uuid,
   '51520001-0000-0000-0000-000000000001'::uuid, 3::numeric, '2026-07-19 21:00:00+00'),
  ('51550000-0000-0000-0000-000000000008'::uuid,
   '51520001-0000-0000-0000-000000000001'::uuid, 9::numeric, '2026-07-19 22:30:00+00');

-- ── order_approvals ────────────────────────────────────────────
-- Inserted directly (as the test's superuser session) rather than through
-- create_order_approval: these fixtures need explicit statuses and business
-- dates, and the RPC's own coverage lives in order_approvals.test.sql.
insert into public.order_approvals
  (id, store_id, vendor_id, business_date, channel, status, lines, line_count,
   source_submission_id)
select a.id::uuid,
       current_setting('test.store_a', true)::uuid,
       a.vendor::uuid,
       a.bdate::date,
       'manual',
       a.status,
       a.lines::jsonb,
       jsonb_array_length(a.lines::jsonb),
       nullif(a.src, '')::uuid
  from (values
    -- (A1) tiers 2 and 3 present but out-ranked by the sent PO.
    ('51540000-0000-0000-0000-000000000001', '51510000-0000-0000-0000-000000000001', '2026-07-20', 'ordered',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    ('51540000-0000-0000-0000-000000000002', '51510000-0000-0000-0000-000000000001', '2026-07-25', 'approved',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    -- (A2) tier 2 must beat tier 3 and tier 4.
    ('51540000-0000-0000-0000-000000000003', '51510000-0000-0000-0000-000000000002', '2026-07-20', 'ordered',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    ('51540000-0000-0000-0000-000000000004', '51510000-0000-0000-0000-000000000002', '2026-07-25', 'approved',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    -- (A3) tier 3 must beat tier 4.
    ('51540000-0000-0000-0000-000000000005', '51510000-0000-0000-0000-000000000003', '2026-07-25', 'approved',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    -- (X2) 'pending', and the only candidate for its vendor.
    ('51540000-0000-0000-0000-000000000006', '51510000-0000-0000-0000-000000000006', '2026-07-25', 'pending',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":9}]', ''),
    -- (F1) source_submission_id points at the 07-23 count, NOT the 07-25 one
    --      that shares the approval's own business_date.
    ('51540000-0000-0000-0000-000000000007', '51510000-0000-0000-0000-00000000000b', '2026-07-25', 'approved',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":4}]',
     '51550000-0000-0000-0000-000000000001'),
    -- (F2) R-E — NULL source_submission_id ⇒ the (store, vendor, date) fallback.
    ('51540000-0000-0000-0000-000000000008', '51510000-0000-0000-0000-00000000000c', '2026-07-26', 'ordered',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":4}]', ''),
    -- (Z3) an approvals-ONLY vendor: invisible to a non-privileged caller.
    ('51540000-0000-0000-0000-000000000009', '51510000-0000-0000-0000-000000000011', '2026-07-20', 'ordered',
     '[{"item_id":"51520001-0000-0000-0000-000000000001","qty_base":4}]', ''),
    -- (G1/G2) a MALFORMED lines[] element beside a well-formed one. Reachable in
    -- prod: order_approvals has no CHECK on lines[] shape and
    -- privileged_store_insert_order_approvals permits a direct PostgREST INSERT
    -- that never goes through create_order_approval's uuid validation. This
    -- vendor is deliberately part of the MAIN _ctx call below, so an unguarded
    -- (l->>'item_id')::uuid cast does not merely fail this arm — it 22P02s the
    -- whole envelope and takes every other assertion in this file down with it,
    -- which is precisely the blast radius being pinned.
    ('51540000-0000-0000-0000-00000000000a', '51510000-0000-0000-0000-000000000014', '2026-07-24', 'ordered',
     '[{"item_id":"wings","qty_base":3},
       {"item_id":"51520001-0000-0000-0000-000000000002","qty_base":7}]', '')
  ) as a(id, vendor, bdate, status, lines, src);

-- Extractors: pull one vendor block / one item entry out of the envelope by id,
-- so no assertion depends on array position.
create function pg_temp.v151(p_payload jsonb, p_vendor uuid) returns jsonb
language sql immutable as $$
  select vv
    from jsonb_array_elements(p_payload->'vendors') vv
   where vv->>'vendor_id' = p_vendor::text
$$;

create function pg_temp.i151(p_payload jsonb, p_vendor uuid, p_item uuid) returns jsonb
language sql immutable as $$
  select ee
    from jsonb_array_elements(p_payload->'vendors') vv,
         jsonb_array_elements(vv->'items') ee
   where vv->>'vendor_id' = p_vendor::text
     and ee->>'item_id'   = p_item::text
$$;


-- ─── impersonate the seed ADMIN (privileged, sees every brand-A store) ─────
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

-- ONE call covers every vendor on the screen (AC-23) — no per-vendor fan-out.
create temp table _ctx on commit drop as
select public.report_last_order_context(
  current_setting('test.store_a', true)::uuid,
  array[
    '51510000-0000-0000-0000-000000000001'::uuid,
    '51510000-0000-0000-0000-000000000002'::uuid,
    '51510000-0000-0000-0000-000000000003'::uuid,
    '51510000-0000-0000-0000-000000000004'::uuid,
    '51510000-0000-0000-0000-000000000005'::uuid,
    '51510000-0000-0000-0000-000000000006'::uuid,
    '51510000-0000-0000-0000-000000000007'::uuid,
    '51510000-0000-0000-0000-000000000008'::uuid,
    '51510000-0000-0000-0000-000000000009'::uuid,
    '51510000-0000-0000-0000-00000000000a'::uuid,
    '51510000-0000-0000-0000-00000000000b'::uuid,
    '51510000-0000-0000-0000-00000000000c'::uuid,
    '51510000-0000-0000-0000-00000000000d'::uuid,
    '51510000-0000-0000-0000-00000000000e'::uuid,
    '51510000-0000-0000-0000-00000000000f'::uuid,
    '51510000-0000-0000-0000-000000000010'::uuid,
    '51510000-0000-0000-0000-000000000011'::uuid,
    '51510000-0000-0000-0000-000000000012'::uuid,
    '51510000-0000-0000-0000-000000000014'::uuid,
    '51510000-0000-0000-0000-000000000015'::uuid
  ],
  date '2026-08-01'
) as payload;

-- (U1..U3) the 501-item vendor gets its OWN call: 500 returned elements would
-- otherwise bloat every other extractor's scan for no benefit, and the cap is a
-- per-vendor property so nothing is lost by isolating it.
create temp table _ctx_trunc on commit drop as
select public.report_last_order_context(
  current_setting('test.store_a', true)::uuid,
  array['51510000-0000-0000-0000-000000000013'::uuid],
  date '2026-08-01'
) as payload;


-- ─── ANCHOR PRECEDENCE (AC-2 / R-C) ────────────────────────────
select is(
  (select format('%s|%s|%s|%s',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000001')->>'source_id',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000001')->>'source',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000001')->>'confidence',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000001')->>'last_order_date')
     from _ctx),
  '51530000-0000-0000-0000-000000000001|purchase_order|placed|2026-06-18',
  '(A1) AC-2 tier 1 — a sent PO outranks an ordered approval, an approved approval AND a newer draft PO (tier dominates recency, R-2)'
);

select is(
  (select format('%s|%s|%s',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000002')->>'source_id',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000002')->>'source',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000002')->>'confidence')
     from _ctx),
  '51540000-0000-0000-0000-000000000003|order_approval|placed',
  '(A2) AC-2 tier 2 — with no tier-1 PO, the ORDERED approval wins and is labelled placed'
);

select is(
  (select format('%s|%s|%s',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000003')->>'source_id',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000003')->>'source',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000003')->>'confidence')
     from _ctx),
  '51540000-0000-0000-0000-000000000005|order_approval|recorded',
  '(A3) AC-2 tier 3 — the APPROVED approval wins over a draft PO and is labelled recorded (AC-3 NOT CONFIRMED)'
);

select is(
  (select format('%s|%s|%s',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000004')->>'source_id',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000004')->>'source',
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000004')->>'confidence')
     from _ctx),
  '51530000-0000-0000-0000-000000000005|purchase_order|recorded',
  '(A4) AC-2 tier 4 — a draft PO anchors and is labelled recorded'
);


-- ─── EXCLUSIONS + R-D ──────────────────────────────────────────
select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000005') from _ctx),
  null,
  '(X1) AC-2 — a CANCELLED PO is excluded from every tier; with no other candidate the vendor is OMITTED from vendors[] (R-D)'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000006') from _ctx),
  null,
  '(X2) AC-2 — a PENDING approval is excluded from every tier; with no other candidate the vendor is OMITTED from vendors[] (R-D)'
);


-- ─── TIE-BREAKS + WINDOW ───────────────────────────────────────
select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000007')->>'source_id' from _ctx),
  '51530000-0000-0000-0000-000000000008',
  '(T1) AC-2 — within a tier, the later reference_date wins'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000008')->>'source_id' from _ctx),
  '51530000-0000-0000-0000-00000000000a',
  '(T2) AC-2 — on an identical reference_date, the later created_at wins'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000009') from _ctx),
  null,
  '(T3) AC-2 — the window is STRICTLY before p_as_of_date: today''s own PO is not "last time"'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-00000000000a')->>'last_order_date' from _ctx),
  '2026-07-22',
  '(T4) R-3 — a legacy PO with a NULL reference_date anchors on its created_at date instead of vanishing'
);


-- ─── COUNTED RESOLUTION (AC-6 / R-E) ───────────────────────────
select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-00000000000b')->>'counted_date' from _ctx),
  '2026-07-23',
  '(F1) AC-6 — an approval with source_submission_id uses THAT submission, not the one sharing its business_date'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-00000000000c')->>'counted_date' from _ctx),
  '2026-07-26',
  '(F2) R-E — an approval with a NULL source_submission_id falls back to the (store, vendor, business_date) identity match'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-00000000000d')->>'counted_date' from _ctx),
  '2026-07-27',
  '(F3) AC-6 — a PO anchor resolves its count by reference_date → eod_submissions.date'
);

select is(
  (select jsonb_typeof(pg_temp.v151(payload, '51510000-0000-0000-0000-00000000000e')->'counted_date') from _ctx),
  'null',
  '(F4) AC-6 — a submission whose status is not ''submitted'' does NOT anchor the count (counted_date is JSON null)'
);


-- ─── LINES (AC-7 / AC-8 / summing) ─────────────────────────────
select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-00000000000f',
             '51520001-0000-0000-0000-000000000001')->>'ordered_qty_base')::numeric
     from _ctx),
  13::numeric,
  '(L1) two po_items rows for the same item on the anchor PO are SUMMED (8 + 5 = 13 base units)'
);

select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-00000000000f',
             '51520001-0000-0000-0000-000000000001')->>'counted_qty_base')::numeric
     from _ctx),
  5::numeric,
  '(L2) AC-6 — the counted figure comes from the anchoring eod_submissions row, in BASE units, unconverted'
);

select is(
  (select jsonb_typeof(pg_temp.i151(payload,
            '51510000-0000-0000-0000-00000000000f',
            '51520001-0000-0000-0000-000000000002')->'counted_qty_base')
     from _ctx),
  'null',
  '(L3) AC-7 — an item ordered but never counted has counted_qty_base JSON null, NOT 0'
);

select is(
  (select jsonb_typeof(pg_temp.i151(payload,
            '51510000-0000-0000-0000-00000000000f',
            '51520001-0000-0000-0000-000000000003')->'ordered_qty_base')
     from _ctx),
  'null',
  '(L4) AC-8 — an item in the anchoring count but NOT on the anchor order has ordered_qty_base JSON null (items[] is a UNION, not a join)'
);


-- ─── FAN-OUT + MALFORMED ROWS ──────────────────────────────────
-- (D1/D2) counted_lines is DISTINCT ON (vendor_id, item_id). Without it the
-- duplicate entry fans out through the left join and yields a duplicated items[]
-- element, an inflated total_n (so items_truncated could read true below 500
-- DISTINCT items) and a silent last-write-wins pick in the client mapper. sum()
-- is NOT the fix: adding two counts for one item invents a total the staff never
-- entered, which AC-10 forbids.
select is(
  (select jsonb_array_length(pg_temp.v151(payload, '51510000-0000-0000-0000-000000000015')->'items')
     from _ctx),
  1,
  '(D1) two eod_entries rows for ONE item on the anchoring submission still yield exactly ONE items[] element (no left-join fan-out)'
);

select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-000000000015',
             '51520001-0000-0000-0000-000000000001')->>'counted_qty_base')::numeric
     from _ctx),
  9::numeric,
  '(D2) …and its counted_qty_base is the LAST-WRITTEN entry (9), never the sum (12) — a summed duplicate would invent a count the staff never entered'
);

-- (G1/G2) The unguarded form of this cast raises 22P02 for the WHOLE envelope,
-- so if this regresses the failure surfaces on every arm above, not just here.
select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-000000000014',
             '51520001-0000-0000-0000-000000000002')->>'ordered_qty_base')::numeric
     from _ctx),
  7::numeric,
  '(G1) a NON-UUID item_id in an approval''s lines[] is SKIPPED, not fatal: the same approval''s well-formed line still resolves'
);

select is(
  (select jsonb_array_length(pg_temp.v151(payload, '51510000-0000-0000-0000-000000000014')->'items')
     from _ctx),
  1,
  '(G2) …and the malformed element contributes NO items[] row — it renders no context, which is AC-9''s honest state at row grain'
);


-- ─── BASIS (R-6) ───────────────────────────────────────────────
select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-000000000010',
             '51520001-0000-0000-0000-000000000004')->>'counted_qty_base')::numeric
     from _ctx),
  26.5::numeric,
  '(Q1) R-6 — a cases+each submission surfaces actual_remaining UNCHANGED; the _cases/_each splits are never recomputed'
);


-- ─── BOUNDS (AC-22) ────────────────────────────────────────────
select throws_ok(
  format($q$select public.report_last_order_context(%L::uuid,
              (select array_agg(gen_random_uuid()) from generate_series(1, 101)),
              date '2026-08-01')$q$, current_setting('test.store_a', true)),
  '22023',
  null,
  '(B1) AC-22 — 101 vendor ids is refused with 22023 (⇒ HTTP 400), checked on the RAW length before de-duplication'
);

select lives_ok(
  format($q$select public.report_last_order_context(%L::uuid,
              (select array_agg(gen_random_uuid()) from generate_series(1, 100)),
              date '2026-08-01')$q$, current_setting('test.store_a', true)),
  '(B2) AC-22 — exactly 100 vendor ids is accepted (the bound is inclusive)'
);

select is(
  (select public.report_last_order_context(
            current_setting('test.store_a', true)::uuid,
            '{}'::uuid[], date '2026-08-01')->'vendors'),
  '[]'::jsonb,
  '(B3) AC-17/AC-22 — an EMPTY vendor list is a normal empty envelope, not an error'
);

select is(
  (select public.report_last_order_context(
            current_setting('test.store_a', true)::uuid,
            null::uuid[], date '2026-08-01')->'vendors'),
  '[]'::jsonb,
  '(B4) AC-17/AC-22 — a NULL vendor list is a normal empty envelope, not an error'
);

-- (B5) The bypass the bound MUST refuse. PostgREST coerces a nested JSON array
-- to a multi-dimensional uuid[]; array_length(_, 1) reports the FIRST DIMENSION
-- only (here: 2), so a dim-1 bound waves through 102 — or 100 000 — elements
-- while the unnest() inside the function flattens every one of them.
-- cardinality() counts across all dimensions and is the only form that holds.
select throws_ok(
  format($q$select public.report_last_order_context(%L::uuid,
              array[(select array_agg(gen_random_uuid()) from generate_series(1, 51)),
                    (select array_agg(gen_random_uuid()) from generate_series(1, 51))],
              date '2026-08-01')$q$, current_setting('test.store_a', true)),
  '22023',
  null,
  '(B5) AC-22 — a NESTED 2 x 51 uuid[] is refused with 22023: the bound counts ELEMENTS (cardinality), not the first dimension'
);

select is(
  (select format('%s|%s',
                 jsonb_array_length(pg_temp.v151(payload, '51510000-0000-0000-0000-000000000013')->'items'),
                 pg_temp.v151(payload, '51510000-0000-0000-0000-000000000013')->>'items_truncated')
     from _ctx_trunc),
  '500|true',
  '(U1) AC-22 — 501 ordered items for one vendor are capped at 500 items[] elements with items_truncated flagged (exercised against real SQL, not a stubbed envelope)'
);

select is(
  (select pg_temp.i151(payload,
            '51510000-0000-0000-0000-000000000013',
            '51570000-0000-0000-0000-000000000001')
     from _ctx_trunc),
  null,
  '(U2) AC-22 — the element dropped by the cap is the LOWEST ordered_qty_base (rank 501), not an arbitrary one'
);

select is(
  (select (pg_temp.i151(payload,
             '51510000-0000-0000-0000-000000000013',
             '51570000-0000-0000-0000-000000000002')->>'ordered_qty_base')::numeric
     from _ctx_trunc),
  2::numeric,
  '(U3) AC-22 — …and rank 500 is RETAINED: the cap keeps the top 500 by quantity, so a truncated payload is reproducible'
);


-- ─── AUTHORIZATION (AC-20 / R-B) ───────────────────────────────
select throws_ok(
  format($q$select public.report_last_order_context(%L::uuid,
              array['51510000-0000-0000-0000-000000000001'::uuid], date '2026-08-01')$q$,
         current_setting('test.store_b', true)),
  '42501',
  'not authorized for this store',
  '(Z1) AC-20 — a store that EXISTS but the caller cannot see (foreign brand) is refused with 42501 before any read'
);

select throws_ok(
  $q$select public.report_last_order_context(
       '51b90001-0000-0000-0000-0000000000ff'::uuid,
       array['51510000-0000-0000-0000-000000000001'::uuid], date '2026-08-01')$q$,
  '42501',
  'not authorized for this store',
  '(Z2) AC-20 — an unknown store id gets the SAME 42501 refusal (no existence leak)'
);

-- (Z3/Z4) R-5 — a store-linked NON-privileged caller. order_approvals'
-- privilege conjunct clips tiers 2/3 to zero rows under SECURITY INVOKER, so an
-- approvals-only vendor simply has no anchor for this reader, while a
-- PO-sourced vendor still resolves. That asymmetry is the whole reason there is
-- no top-level auth_is_privileged() gate.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

create temp table _ctx_np on commit drop as
select public.report_last_order_context(
  current_setting('test.store_a', true)::uuid,
  array['51510000-0000-0000-0000-000000000011'::uuid,
        '51510000-0000-0000-0000-000000000012'::uuid],
  date '2026-08-01'
) as payload;

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000011') from _ctx_np),
  null,
  '(Z3) AC-20/R-5 — a NON-privileged store member cannot read an order_approvals-sourced anchor; the vendor is omitted'
);

select is(
  (select pg_temp.v151(payload, '51510000-0000-0000-0000-000000000012')->>'source_id' from _ctx_np),
  '51530000-0000-0000-0000-000000000011',
  '(Z4) AC-20/R-5 — …but that same caller STILL resolves a purchase_orders-sourced anchor (privilege is a row filter, not a feature gate)'
);


-- ─── LINT + SHAPE (AC-21 / AC-23 / R-B) ────────────────────────
reset role;
select set_config('request.jwt.claims', null, true);

-- (P1a/P1b) SECURITY INVOKER means these five SELECT policies ARE this
-- function's authorization. There is deliberately NO copy of the spec-053
-- trivially-wide detector here — permissive_policy_lint.test.sql already scans
-- all of public.*, and a second copy is drift surface with nothing to justify it
-- (see the NOTE at the top of this file). What is pinned instead is the thing
-- THIS function depends on and no other gate states: those policies exist, under
-- these names, still routed through the auth_* helpers.
select is(
  (select string_agg(format('%s.%s', tablename, policyname), ', '
                     order by tablename, policyname)
     from pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
      and tablename in ('purchase_orders','po_items','order_approvals',
                        'eod_submissions','eod_entries')),
  'eod_entries.store_member_read_eod_entries, '
  'eod_submissions.store_member_read_eod_submissions, '
  'order_approvals.privileged_store_read_order_approvals, '
  'po_items.store_member_read_po_items, '
  'purchase_orders.store_member_read_purchase_orders',
  '(P1a) AC-20/AC-21 — the five source tables carry EXACTLY their expected named SELECT policies; a rename or an added SELECT policy changes what this SECURITY INVOKER function can read'
);

select is(
  (select string_agg(
            format('%s:%s%s', tablename,
                   case when qual like '%auth_can_see_store%' then 'store'
                        else 'UNSCOPED' end,
                   case when qual like '%auth_is_privileged%' then '+priv'
                        else '' end),
            ', ' order by tablename)
     from pg_policies
    where schemaname = 'public'
      and cmd = 'SELECT'
      and tablename in ('purchase_orders','po_items','order_approvals',
                        'eod_submissions','eod_entries')),
  'eod_entries:store, eod_submissions:store, order_approvals:store+priv, '
  'po_items:store, purchase_orders:store',
  '(P1b) AC-20/R-B — every one of those quals still routes through auth_can_see_store, and order_approvals still carries its auth_is_privileged conjunct (the row filter Z3/Z4 prove is doing the work)'
);

select ok(
  has_function_privilege('authenticated',
    'public.report_last_order_context(uuid, uuid[], date)', 'EXECUTE'),
  '(P2) authenticated HAS execute on report_last_order_context'
);

select ok(
  not has_function_privilege('anon',
    'public.report_last_order_context(uuid, uuid[], date)', 'EXECUTE'),
  '(P3) anon lacks EXECUTE on report_last_order_context (revoked from public AND anon)'
);

select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and tablename = 'eod_entries'
             and indexname = 'idx_eod_entries_submission_id'),
  '(P4) AC-23 — idx_eod_entries_submission_id exists; the counted fetch is not a seq scan of eod_entries'
);

select is(
  (select p.prosecdef
     from pg_proc p
    where p.oid = 'public.report_last_order_context(uuid, uuid[], date)'::regprocedure),
  false,
  '(P5) R-B — the function is SECURITY INVOKER; the caller''s own RLS does the clipping and there is no second copy of the authorization rule'
);

select finish();
rollback;
