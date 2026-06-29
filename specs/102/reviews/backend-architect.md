# Backend-architect post-implementation review — spec 102 (multi-vendor ingredients)

Mode: post-implementation architectural drift review. Reviewed the STAGED
implementation against the `## Backend design` section I authored. Scope of the
verdict is contract/architecture drift; test-coverage severity is the
test-engineer's call (flagged here as input, not as a binding gate).

**Verdict: no Critical drift.** The two highest-risk traps the dispatch named —
(a) the RPC-body copy silently reverting a prior spec, and (b) the three
on-hand paths disagreeing — are both clean. The backfill is reset-safe and will
not corrupt or duplicate on prod. Findings below are Should-fix and Nit only.

---

## Verification of the dispatch's named risks (all PASS)

**RPC-body drift (reorder, 20260630000100) — PASS.** Diffed the new body against
the latest prior body `20260623000000_reorder_list_i18n_names.sql` (which itself
carries spec 087 as_of_date/EOD-first + spec 088 case math + spec 100 i18n). No
prior-spec logic reverted:
- spec 100 i18n: `ci.i18n_names as i18n_names` in `per_item` (line 438) and the
  `'i18n_names'` per-item key (line 537) — present.
- spec 088 case math: `case_qty` surfaced (line 440), `suggested_cases` ceil +
  case-rounded `estimated_cost` (lines 486-491), the three additive case keys
  `case_qty`/`suggested_cases`/`suggested_units` (lines 551-555) — present.
- hybrid `suggested_qty` = `greatest(par_replacement, usage_forecasted)` (line
  471), as_of_date/EOD-first resolution, schedule/next-delivery DOW-offset math
  (the spec-088-era MIN-over-offset-distance correctness fix) — all byte-equal.
- The ONLY changes are the three documented hunks (4f junction explosion +
  per-vendor cost with OQ-5 fallback; the `item_vendor_set` sub-CTE; the two
  OQ-1 `other_vendor_count`/`also_from_vendors` keys) plus the two flagged
  deltas (see below). Envelope `{vendors[], kpis, _warnings, as_of_date}`
  unchanged. `security invoker` + GRANT preserved via `create or replace`.

**RPC-body drift (staff, 20260630000200) — PASS.** Diffed against
`20260601000000_staff_submit_eod_cases_each.sql`. The 7-arg body is verbatim
except exactly one hunk: the inventory write predicate `and vendor_id =
p_vendor_id` → `and exists (select 1 from public.item_vendors iv where
iv.item_id = ii.id and iv.vendor_id = p_vendor_id)` (lines 203-210). Preserved:
spec 086 `actual_remaining_cases`/`actual_remaining_each` recordset + insert,
spec 061 three-tier `v_actor` JWT logic, `auth_can_see_store` gate, the
`(store,date,vendor)` on-conflict upsert, delete-then-insert entry replacement,
both consistency triggers' contract, the audit row (still emits for off-vendor
entries), and the GRANT (signature byte-identical → preserved). The write
already set BOTH `current_stock` + `eod_remaining` in the prior body — unchanged.

**Three on-hand paths agree (junction membership, not scalar) — PASS.**
- admin `db.ts submitEODCount` (db.ts:751-783): prefetches
  `select item_id from item_vendors where vendor_id = submission.vendorId` into
  `linkedItemIdsForVendor`, gates each per-entry write on
  `linkedItemIdsForVendor.has(entry.itemId)`, dropped `.eq('vendor_id', …)`,
  sets both `current_stock` + `eod_remaining`. Matches §5a.
- staff `staff_submit_eod` RPC: `exists(item_vendors …)` (above). Matches §5b.
- admin store optimistic mirror (useStore.ts:1762-1764):
  `const itemVendorIds = item?.vendorIds ?? (item?.vendorId ? [item.vendorId] :
  []); const itemMatchesSubmittedVendor = !!subVendorId &&
  itemVendorIds.includes(subVendorId)`. Matches §5c.
  All three resolve "countable under this vendor" as junction membership, with
  the escape-hatch (no link → skip the on-hand write, keep the entry/audit)
  preserved identically. Server / staff-server / admin-optimistic now agree.

**Reorder CTE explosion — no double-count — PASS, both flagged fixes sound.**
- Delta #1 (`vendor_delivery_offsets` EXISTS, lines 396-402): the existence
  filter changed from `ii.vendor_id = v.id` to `join item_vendors iv …
  iv.vendor_id = v.id`. Correct and necessary — a vendor linked to an item ONLY
  via the junction (not the scalar) must still get a `vendor_delivery` row, or
  its exploded `per_item` rows get dropped by the inner `join vendor_delivery`.
  Same membership semantics the (4f) inner join already implies.
- Delta #2 (`pending_po_qty` `select distinct`, lines 299-303): correct. `(4f)
  item_on_hand` is now per-(item,vendor) so it carries duplicate `item_id`s for
  a shared item; `pending_po_qty` keys on `item_id` and is LEFT-joined back into
  `per_item` ON `item_id`, so without DISTINCT a shared item's `per_item` row
  fans out by its vendor-link count (a real duplication — "Flour twice in the
  BJs card"). `distinct` collapses to one row per item; value is 0 in v1 so only
  the row count changes. This was a genuine bug caught in local verification and
  the fix is complete (no other per-item CTE left-joins `item_on_hand` on a
  non-vendor key — `pos_daily_per_item` already groups by `ii.id`).
- OQ-1 additive keys: `item_vendor_set` (lines 273-284) computes per-item linked
  vendors; `other_vendor_count` = `greatest(0, link_count - 1)` and
  `also_from_vendors` excludes the card's own vendor (lines 566-571). KPIs
  unchanged (still count exploded rows — coincident-day double-count surfaced
  honestly per the OQ-1 resolution, not hidden). Envelope shape unchanged.

**db.ts create/update `Omit<…,'vendors'>` type fix — PASS (genuinely type-only).**
`createInventoryItem` is `Omit<InventoryItem,'id'|'vendors'> & { vendors?:
payload }` (db.ts:287-295); `updateInventoryItem` is
`Omit<Partial<InventoryItem>,'vendors'> & { vendors?: payload }` (db.ts:381-390).
This only overrides the `ItemVendorLink[]` field (which carries
`vendorName`/`isPrimary`) with the editor's `{vendorId, costPerUnit?,
casePrice?}` payload shape — the prior intersection was uninhabitable. No
query-logic change. The link-reconciliation body is correct: upsert present
links with `onConflict: 'item_id,vendor_id'`, then delete de-selected
(`.not('vendor_id','in','(…)')`; empty set → delete ALL links). No half-applied
writes — both the upsert and the delete throw on error inside the same
`track()`. Cost edits land on exactly the submitted link; removing a vendor
deletes its link. The early-return guard was correctly restructured so a
`vendors`-only edit isn't short-circuited by the empty-`perStore` path
(db.ts:438-449 comment + logic).

**Pre-existing stale 6-arg `staff_submit_eod` overload — NOT an ambiguity risk;
correctly left alone.** The legacy 6-arg signature
`(uuid,uuid,date,text,text,jsonb)` still exists but was converted to a fail-loud
`raise exception … using errcode='22023'` stub in
`20260514120010_staff_submit_eod_v2.sql:189-206`. PostgREST resolves the 7-arg
and 6-arg as distinct signatures (no overload ambiguity), and the 6-arg path
hard-raises rather than silently corrupting. **Recommendation: do NOT drop it in
this spec.** It is out of scope, it is a deliberate fail-loud guard for any
pre-update sibling-app deploy, and the v2 migration's comment documents that its
presence keeps the rollback story simple. Dropping it is gratuitous risk with no
benefit to 102. (If a future cleanup spec removes it, that spec must also drop
the GRANT and confirm no caller sends 6 args.)

**Migration ordering / reversibility / backfill prod-safety — PASS.**
- Order: `…000000` (table+RLS+grants+backfill+publication) sorts before
  `…000100`/`…000200`/`…000300`, each of which depends on `item_vendors`
  existing. Lexicographic order is correct.
- Backfill is idempotent (`on conflict (item_id, vendor_id) do nothing`) and
  additive (only `vendor_id IS NOT NULL` items → one `is_primary=true` link
  carrying current cost/case_price). Re-run = `INSERT 0 0`. Null-vendor items →
  0 rows. **Prod-safe against populated tables:** the backfill is a plain
  `INSERT … SELECT … ON CONFLICT DO NOTHING` over `inventory_items` — it reads
  the live cost/case_price and writes one link per vendor-bearing item; it
  cannot duplicate (composite unique) and cannot corrupt (it never UPDATEs
  inventory_items). AC-A count/cost-preservation holds because the reorder RPC
  falls back to `ii.cost_per_unit` when the junction cost is null/0, and the
  backfill copies the exact current cost.
- Reset-vs-seed nuance: confirmed the design intent that on `supabase db reset`
  the seed loads AFTER migrations, so the backfill runs against an empty
  `inventory_items` and produces 0 links (the "CI-fresh truncate" state). The
  RPCs are written to behave correctly with 0 links (items simply don't explode)
  — but see Should-fix #2 re: the one test that depends on links existing.
- Grants: `…000000` re-states `grant select,insert,update,delete,references,
  trigger … to anon, authenticated` + `grant all … to service_role`
  (idempotent defense-in-depth against the spec-097 silent-grant-revocation
  class). Sound.
- `db push` compat: all four are forward-only DDL / idempotent DML /
  `create or replace`. Each MUST be pushed to prod or `db-migrations-applied`
  goes red (the backend notes correctly flag prod push as still PENDING).
- Realtime publication add (`alter publication supabase_realtime add table
  public.item_vendors`) + the `useRealtimeSync.ts` explicit `item_vendors`
  subscription (no store filter, `ingredient_conversions` posture) are both
  present and consistent. The `docker restart supabase_realtime_imr-inventory`
  dev/deploy step is correctly flagged in the migration header, the hook
  comment, and the carryover notes.

---

## Should-fix

**SF-1 — `db.ts fetchWeeklyLowStock` is dead code; the staff screen forked its
own copy.** The design (§9 + the §10 contract table) named
`db.fetchWeeklyLowStock(storeId, asOfDate?)` as the single surface for the
weekly low-stock RPC, and the backend slice built it (db.ts:3048-3082). But
`WeeklyCount.tsx` consumes a SEPARATE staff-carve-out `fetchLowStock` with a
direct `supabase.rpc` (WeeklyCount.tsx:121-126) and never imports the db.ts
helper. Grep confirms `db.fetchWeeklyLowStock` has **zero callers** — it is dead
code, and there are now two hand-maintained snake→camel mappers for the same
envelope. The staff-subtree direct-rpc carve-out is permitted by CLAUDE.md, so
this is not a layering violation, but shipping the design's named helper unused
is real drift: a future maintainer editing one mapper won't know the other
exists. Resolve one of two ways: (a) delete the unused `db.fetchWeeklyLowStock`
+ trim §9/§10 to say "staff carve-out, mapped in WeeklyCount.tsx", or (b) wire
WeeklyCount to `db.fetchWeeklyLowStock` (note: it currently runs outside
`track()` on the staff side, which is consistent with the staff carve-out). The
two mappers are currently byte-equivalent so there's no behavioral bug today —
this is a maintenance/intent-drift fix. (Cite: db.ts:3048, WeeklyCount.tsx:121,
spec §9/§10.)

**SF-2 — AC-I pgTAP coverage of the NEW multi-vendor behavior is missing; one
changed path is untested on a fresh DB.** The six reorder pgTAP suites were
patched to insert `item_vendors` link rows so they keep passing, but that only
proves the RPC still works for the SINGLE-vendor shape. There is no new
dedicated test asserting any of: backfill idempotency + count/cost preservation
(AC-A / AC-I), the new RLS policies' store isolation (AC-B / AC-I), the reorder
explosion-to-two-vendors + per-vendor cost + OQ-1 hint (AC-G / AC-I), the staff
RPC's junction-membership on-hand write, or `report_weekly_lowstock`. More
sharply: `staff_submit_eod_cases_each.test.sql` selects its mutate-target item
by the scalar `vendor_id` (lines 79-83) and contains NO `insert into
item_vendors`, so under the CI-fresh `truncate item_vendors` / seed-after-reset
condition the new `exists(item_vendors …)` predicate yields false and the
inventory mutation is skipped — the suite passes only because it doesn't assert
the on-hand effect, OR (worse) it would regress if it did. This is exactly the
local-green/CI-red asymmetry CLAUDE.md repeatedly warns about. The backend
notes' "51/51 PASS under both states" attests the EXISTING suites survive, not
that the new contract is covered. Severity weighting is the test-engineer's
call; flagging because the RPC-body-drift and backfill-corruption defenses the
dispatch is most worried about ultimately rest on these tests existing.
(Cite: supabase/tests/staff_submit_eod_cases_each.test.sql:79-83; the absence of
item_vendors-backfill / item_vendors-RLS / report_weekly_lowstock test files.)

---

## Nit / observations (non-blocking)

**N-1 — `is_primary` can transiently land zero-primary for a non-form caller.**
In both `createInventoryItem` and `updateInventoryItem`, `is_primary` is derived
as `l.vendorId === vendorId` where `vendorId` comes from the same payload's
scalar (db.ts:360, 469). The IngredientForm always sends `vendorId` as one of
the `vendors[]` rows (IngredientFormDrawer.toUpdates:100-108) and re-points it on
primary-row removal (IngredientForm.tsx:790-802), so the UI path always yields
exactly one `is_primary=true`. The residual: a non-form caller that passes
`vendors[]` with a `vendorId` NOT in the set would upsert all-`false` primaries.
The partial unique index permits zero primaries (only ≤1), so this doesn't
error — it just leaves the SD-1 mirror momentarily out of sync with no primary.
Low impact (reorder/EOD don't read `is_primary`), but a defensive "if no row
matches the scalar, mark the first row primary" in the db.ts writers would make
SD-1 robust to non-form callers. Optional.

**N-2 — `deriveCountedItemIds` credits DRAFT submissions, slightly broader than
§6c's wording.** §6c said "an already-submitted submission"; the impl
(EODCountSection.tsx:83-87) adds entries from ALL submissions for the (store,
date) regardless of status, with a comment that a draft entry is a recorded
count. This only makes the gate MORE lenient (never falsely-blocking), is
internally consistent, and is arguably more correct. Noting as an intentional,
documented broadening, not a defect.

**N-3 — staff weekly `fetchLowStock` passes `p_params: {}` (no `as_of_date`).**
WeeklyCount.tsx:122-125 omits `as_of_date`, so the RPC falls back to server
`current_date` (UTC) — the documented time-zone caveat shared with the reorder
runner. Acceptable for an advisory surface (the design accepted this), but the
admin-side `db.fetchWeeklyLowStock` does plumb `asOfDate` and is unused (see
SF-1); if SF-1 is resolved toward wiring db.ts, pass the store-local day there.

**N-4 — admin `submitEODCount` membership prefetch has no explicit store
filter.** db.ts:751-755 selects `item_id from item_vendors where vendor_id =
submission.vendorId` with no `store_id` predicate. This is RLS-scoped (the read
policy gates on `auth_can_see_store(ii.store_id)`), and `entry.itemId`s are this
store's, so a cross-store collision is implausible (UUIDs). Sound as written;
noting only because the staff fetch (`fetchItemsForVendor`) DOES add the
explicit `.eq('item.store_id', storeId)` and the asymmetry could read as an
omission to a future maintainer.

---

## Summary

Contract held. The reorder and staff RPC bodies copied the LATEST prior bodies
with no prior-spec reversion; the three on-hand predicates agree on junction
membership; the two flagged CTE fixes (DISTINCT fan-out, EXISTS via junction)
are sound and complete; the `Omit<…,'vendors'>` fix is type-only with a correct
reconciliation body; the 6-arg overload is a fail-loud stub and correctly left
in place; and the backfill is idempotent, additive, and prod-safe. The two
Should-fix items are (SF-1) a dead db.ts helper / forked staff mapper and (SF-2)
missing pgTAP coverage of the new multi-vendor behavior — including one changed
path that is untested on a fresh DB. Neither blocks on architectural grounds;
SF-2's final severity is the test-engineer's call.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. No Critical drift; 2 Should-fix
  (dead db.ts fetchWeeklyLowStock vs forked staff mapper; missing pgTAP coverage
  of the new multi-vendor behavior with one staff-RPC path untested on a fresh
  DB) + 4 nits. RPC-body copies, the three on-hand paths, and the backfill all
  verified clean.
payload_paths:
  - specs/102/reviews/backend-architect.md
