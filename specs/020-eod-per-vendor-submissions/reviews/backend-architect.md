# Backend architect — post-impl drift review (spec 020)

Reviewed against the design at `specs/020-eod-per-vendor-submissions/spec.md`
sections 1–13. Files inspected:
- `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql`
- `supabase/migrations/20260514120010_staff_submit_eod_v2.sql`
- `supabase/migrations/20260514120020_report_run_variance_multivendor.sql`
- `supabase/functions/staff-eod-submit/index.ts`
- `src/lib/db.ts`
- `src/store/useStore.ts`
- `src/types/index.ts`
- `src/screens/cmd/sections/EODCountSection.tsx`

Reference points: spec 018's variance template
`supabase/migrations/20260512120000_report_run_variance.sql`, the legacy v1
RPC `supabase/migrations/20260504000001_staff_submit_eod_rpc.sql`, and the
P3 lockdown `supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:59-60`.

## Drift inventory

### 1. Schema migration (`20260514120000_eod_submissions_vendor_id.sql`)

| Item | Verdict | Notes |
|---|---|---|
| `vendor_id uuid` column add (Phase A) | Faithful | Matches §1.1 Phase A exactly; nullable, then enforced NOT NULL post-backfill. |
| `eod_submissions_vendor_id_idx` btree index | Faithful | §1.2 specifies it. |
| Mode-pick backfill, alphabetical-UUID tiebreaker | Faithful | `order by count(*) desc, ii.vendor_id::text asc limit 1` exactly mirrors §1.1 lines 374-379. NULL-vendor entries excluded via `and ii.vendor_id is not null`. |
| No-entries / all-NULL-vendor orphan handling | Faithful | DO block at lines 76-95 selects orphans, RAISE NOTICE, DELETE. Children cascade via existing FK. |
| Drop legacy `(store_id, date)` unique | Faithful + defensive | Drops both the actual prod name `eod_submissions_store_date_key` (from `20260502071736_remote_schema.sql:175-183`) AND the speculative `eod_submissions_store_id_date_key`. Belt-and-braces approach is good. |
| `set not null` on `vendor_id` | Faithful | Phase C line 113-114. |
| New unique `(store_id, date, vendor_id)` | Faithful | Line 119-121, named `eod_submissions_store_id_date_vendor_id_key`. |
| FK to `vendors(id) on delete restrict` | Faithful | Line 125-128. |
| Single transaction `begin … commit` | Faithful | Lines 18 / 130. |
| No publication-membership change | Faithful | Adding a column to a table already in `FOR ALL TABLES`; no docker restart needed (correctly flagged in the header comment). |

**Net:** schema migration is bit-for-bit faithful to §1.1. No drift.

### 2. Backfill correctness

The deterministic ordering is correct. Edge cases (all-NULL vendor entries, zero entries) fall through to the orphan-DELETE branch as designed. The dev reported "18 submissions, 18 inferrable, 0 orphans" against the local seed in the spec at line 1389 — consistent with expectation that pre-spec-020 prod data has one submission per `(store_id, date)` and most entries' items carry a vendor_id post-brand-catalog refactor.

One operational note (not a defect): the migration silently deletes orphan rows with only a `RAISE NOTICE`, no `EXCEPTION`. The architect's §1.1 chose DELETE-with-notice over EXCEPTION explicitly (line 358-364). The spec's risk register at line 263 mentions this; the dev's PR notes called out zero orphans on seed. Acceptable.

### 3. RPC v2 contract (`20260514120010_staff_submit_eod_v2.sql`)

| Item | Verdict | Notes |
|---|---|---|
| Function name | Approved drift | Design said "new v2 function" (§3.1 header); dev used a 7-arg **overload of the same name** `staff_submit_eod` (line 34). The 6-arg signature is preserved (line 179) so callers selecting on arg count still get the right overload. Cleaner than a rename because the existing GRANT to `service_role` is signature-scoped and recreating it for `_v2` would have been more code. PostgREST's named-arg resolution disambiguates correctly. |
| Signature `(p_client_uuid, p_store_id, p_date, p_submitted_by, p_status, p_entries, p_vendor_id)` | Approved drift | Design (§3.1 lines 541-550) listed `p_vendor_id` between `p_date` and `p_submitted_by`. Implementation puts `p_vendor_id` LAST. Function works the same either way since callers use named args; this is purely a cosmetic ordering choice. No risk. |
| `security definer` + `set search_path = public` | Faithful | Lines 44-45. |
| `revoke … from public, anon, authenticated` + `grant execute … to service_role` | Faithful | Lines 169-170. |
| NULL vendor_id check raises errcode 22023 | Faithful | Lines 57-61. |
| Idempotency on `p_client_uuid` | Faithful | Lines 75-86, identical envelope. |
| Upsert on `(store_id, date, vendor_id)` preserving id (EDIT path) | Faithful | Lines 91-97. `do update set status, submitted_at, client_uuid = coalesce(...)`. |
| Entries: delete + re-insert | Faithful | Lines 100-115. |
| **Q6 vendor-scoped `current_stock` write** | Faithful | Line 122-127: `update inventory_items set ... where id = v_entry.ingredient_id and vendor_id = p_vendor_id`. Items belonging to a different vendor (escape hatch) get an `eod_entries` row + audit_log row but NO `current_stock` mutation, exactly per §3.1 #6 and Q6. |
| Audit `· vendor: <name>` suffix on `detail` | Faithful | Lines 142-143: `coalesce(p_submitted_by, 'staff:unknown') || ' · vendor: ' || coalesce(v_vendor_name, 'unknown')`. |
| **Audit-row name/unit source via catalog join** | Approved drift; see §6 below | Lines 144-148 route through `catalog_ingredients ci on ci.id = ii.catalog_id`. v1 used `ii.name` / `ii.unit` directly, which were dropped in P3 lockdown. Confirmed correct fix; see §6 finding. |
| v1 6-arg body replaced with fail-loud RAISE | Faithful | Lines 179-196. errcode `22023` (the dev's note at spec line 1356-1357 says `22023`; design at line 658 said `'P0001'` — minor drift, but `22023` is correct since "invalid_parameter_value" semantically matches missing-required-vendor; design's `P0001` was a "raise_exception" generic. Either passes; `22023` is arguably better.) |

**Net:** RPC migration is faithful with two approved cosmetic drifts (function naming, arg position) and one explicit improvement (audit name/unit source — see §6).

### 4. v1 deprecation fail-loud

Verified. Line 179-196 replaces the 6-arg body with `RAISE EXCEPTION ... USING ERRCODE = '22023'`. Any pre-update sibling-app or in-repo edge function caller hits this and fails loudly. **However** — see §7 below on the in-repo edge function which currently triggers this exact failure mode.

### 5. Variance refactor (`20260514120020_report_run_variance_multivendor.sql`)

| Item | Verdict | Notes |
|---|---|---|
| Drop `v_from_submission_id` / `v_to_submission_id` from DECLARE | Faithful | Compare line 127-148 of spec 018's variance to lines 74-85 here — capture variables removed. |
| Anchor-existence gates use `EXISTS` predicates | Faithful | Lines 146-168. P0002 errcode preserved per §4.1 #4. |
| Default-anchor resolution uses DISTINCT date | Faithful | Lines 97-106 — `select distinct date from eod_submissions ... limit 2`. Necessary because multiple vendor-submissions on one date would otherwise collapse the LIMIT prematurely. |
| `prior_counts` / `current_counts` CTEs become SUM aggregates | Faithful | Lines 320-341: `select e.item_id, sum(e.actual_remaining)::numeric as qty from eod_entries e join eod_submissions s ... where s.store_id = p_store_id and s.date = v_from/v_to and s.status = 'submitted' and e.actual_remaining is not null group by e.item_id`. Bit-for-bit matches §4.1 #2. |
| `prior_only` / `current_only` XOR CTEs filter on `(store_id, date, status)` | Faithful | Lines 212-245 — anchor-date predicate replaces the old per-submission filter. DISTINCT collapses an item appearing under two vendors. |
| Receiving / sales_depletion / waste CTEs unchanged | Faithful | Lines 344-383. They never referenced `submission_id`. |
| Item name via `inventory_items.catalog_id → catalog_ingredients.name` | Faithful (carry-over from spec 018) | Line 409, mirrors spec 018's line 113-117 comment. |
| `security invoker` + `grant execute to authenticated` | Faithful | Lines 71 + 520. Variance is per-store-RLS-gated, not service-role-only. |
| Equality smoke-test runbook in header | Faithful | Lines 33-63. Three day-pair recipe matches §4.2. |

**Net:** variance migration is faithful. The dev's reported variance-equality smoke test ("three day-pair JSON envelopes captured pre-migration; diff against post-migration output → bit-identical") at spec line 1392-1393 is the right verification shape for §4.2.

### 6. v1 audit-row regression — confirmed; v2 fix is correct

The dev flagged that v1's `ii.name` / `ii.unit` references at
`supabase/migrations/20260504000001_staff_submit_eod_rpc.sql:98-99` reference
`inventory_items.name` and `inventory_items.unit`, both of which were DROPPED
in P3 lockdown (`supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:59-60`).
Confirmed:

- v1 staff RPC migration timestamp: `20260504000001` — runs FIRST.
- P3 lockdown timestamp: `20260504072830` — runs LATER same day.
- v1 RPC's audit `INSERT INTO audit_log ... SELECT ... ii.name, ... ii.unit FROM inventory_items ii ...` therefore became a runtime-broken statement the moment P3 lockdown landed.

The v2 implementation's catalog-join fix at lines 144-148 is the correct shape:
```
from public.inventory_items ii
left join public.catalog_ingredients ci on ci.id = ii.catalog_id
where ii.id = v_entry.ingredient_id
```
This mirrors the spec 018 variance migration's own item-name source (line 409
of the new variance migration; documented in spec 018's header comment at
113-117). `left join` (vs inner) tolerates catalog-row absence; the
`coalesce(v_entry.unit, ci.unit, '')` fallback at line 145 preserves the value
column's text shape from the original v1.

**Question for the architect's call (prompt item 8):** should the v1 audit-row
also be patched to use the catalog join before v1 is deprecated?

**Architect's call: NO patch needed.** The v1 body is now a RAISE EXCEPTION
(line 192) — it never reaches the audit insert. The old broken `ii.name` /
`ii.unit` reference is dead code inside the deprecation guard-rail. v1 is
about to die in lockstep with the sibling-app rollout; patching the
guard-rail's dead-code path adds no value.

The architect's design DID inherit the v1 broken reference at §3.1 #7. That's
an architect-side miss that the dev caught and fixed correctly. Recorded as
an architect-design oversight, not implementation drift.

### 7. **CRITICAL — in-repo `staff-eod-submit` edge function NOT updated**

Spec §6 (lines 890-923) and the Files Changed list at line 1300 BOTH require
updates to `supabase/functions/staff-eod-submit/index.ts`:
- Add `vendor_id` to the `Body` interface
- Add `vendor_id` validation
- Change the RPC call from `staff_submit_eod` (6-arg) to `staff_submit_eod_v2` (or the 7-arg overload), passing `p_vendor_id: body.vendor_id`

Verified at `supabase/functions/staff-eod-submit/index.ts:58-66`,
`:68-82`, and `:108-115`:
- `Body` interface (lines 58-66) has NO `vendor_id` field.
- `validate()` (lines 68-82) does NOT require `vendor_id`.
- The RPC call (lines 108-115) still passes 6 args without `p_vendor_id`.

`grep -n "vendor_id\|p_vendor_id"` on the file: zero matches.

**Effect:** every POST to `/staff-eod-submit` now hits the legacy 6-arg
`staff_submit_eod` whose body is the fail-loud `RAISE EXCEPTION ... USING
ERRCODE = '22023'`. The edge function returns 500 with the deprecation
message. This is exactly the fail-loud mode the architect's §6 / §7 designed
FOR THE SIBLING APP — but the in-repo edge function was supposed to be
upgraded BEFORE the migration landed.

**Severity: Critical.** Any sibling-app traffic hitting this repo's edge
function (which is the SOLE consumer of the 6-arg signature) will fail until
the edge function is patched. The dev's "Files changed" list at spec lines
1366-1376 silently omits the edge function. This is a missed scope, not a
deliberate decision.

**Mitigation:** before merging or deploying, the developer must add a fourth
file change:
1. `supabase/functions/staff-eod-submit/index.ts` — add `vendor_id` to Body, validate as uuid, pass `p_vendor_id: body.vendor_id` to the RPC.

The sibling-app coordination plan (§7 steps 5-6) is still valid; this is the
in-repo half of step 5 that the design assumed would land in this PR.

### 8. db.ts surface

| Item | Verdict | Notes |
|---|---|---|
| `submitEODCount` upsert payload includes `vendor_id` | Faithful | Line 356. |
| `onConflict: 'store_id,date,vendor_id'` | Faithful | Line 361. |
| Per-entry inventory update `.eq('vendor_id', submission.vendorId)` | Faithful | Line 402. Q6 mirrored on the client path. |
| Direct PostgREST path retained (architect's §5 option (b)) | Faithful | RPC remains service-role-only; admin JWT path stays on direct PostgREST. |
| Read helpers project `vendor_id` and map to `vendorId` | Faithful | `fetchTodaysEODForStores` (line 431, 443), `fetchRecentEODSubmissions` (line 479, 493), `fetchEodSubmissionsForStores` (line 555, 571). snake_case → camelCase via local mapping helpers, matching the rest of the file's convention. |
| `fetchEODSubmissions` (line 518) selects `*` | Implicitly faithful | The `*` selector picks up `vendor_id` automatically with no code change; downstream callers consume it via the typed interface. |

**Net:** db.ts surface is faithful to §5. The "no new helper for EDIT" decision
(§5.3) is preserved — EDIT flows through the same `submitEODCount` call with
the same `(storeId, date, vendorId)` triple, and the ON CONFLICT does the row
reuse server-side.

### 9. Type surface

| Item | Verdict | Notes |
|---|---|---|
| `EODSubmission.vendorId: string` (required) | Faithful | `src/types/index.ts:241`. |
| `EODSubmission.vendorName?: string` (optional, hydrated client-side) | Faithful | `src/types/index.ts:242`. |
| `EODEntry` unchanged | Faithful | §8.1: entries inherit vendorId transitively via parent's `submission_id`. |

### 10. Frontend store

| Item | Verdict | Notes |
|---|---|---|
| Merge lookup scoped on `(storeId, date, vendorId)` | Faithful | `src/store/useStore.ts:1339-1343`. |
| Vendor-scoped optimistic `current_stock` update | Faithful | Lines 1373-1406. The gate `!subVendorId \|\| !item?.vendorId \|\| item.vendorId === subVendorId` is more permissive than the RPC's strict `vendor_id = p_vendor_id` — it tolerates legacy-data shapes where `subVendorId` or `item.vendorId` could be missing. Note: this client-side permissiveness diverges slightly from the RPC's strict gate, but is the right shape for the local optimistic path while spec-020 data settles. Flagged for awareness; not a critical drift. |
| Audit `detail` includes `· vendor: <name>` suffix | Faithful | Lines 1410-1412. Mirrors the RPC's audit shape. |
| Notification broadcast string includes vendor name | Faithful (additive) | Line 1431-1432: `` `${submitterName} ${verb} today's EOD count${vendorSuffix} for ${submission.storeName}` ``. Not in §10 explicitly but a natural extension; not a drift, just a minor UX add. |
| Optimistic-then-revert via `notifyBackendError` | Faithful | `db.adjustItemStock(...).catch(...)` at line 1399-1405. |

### 11. Frontend section (`EODCountSection.tsx`)

| Item | Verdict | Notes |
|---|---|---|
| Per-vendor draft state `caseCountsByVendor` / `unitCountsByVendor` / `notesByVendor` | Faithful | Lines 86-88. Q4 reshape complete. |
| Per-vendor accessors `setCaseCounts` / `setUnitCounts` / `setNotes` proxy through `selectedVendorId` | Faithful | Lines 100-111. |
| `submittedVendorIds` derived from `eodSubmissions` with defensive falsy `vendorId` guard | Faithful | Lines 265-275. The `if (!s.vendorId) continue` at line 268 is defensive for legacy rows — sound. |
| `isVendorLocked` composite gate | Faithful | Line 282. |
| `currentVendorSubmission` lookup | Faithful | Lines 286-294. |
| Lock-after-submit: inputs render `editable={!inputsDisabled}` with submitted-entry pre-fill | Faithful | Lines 1089-1113 + the per-input gates at 1147, 1178, 1204. |
| EDIT button + "SUBMITTED · LOCKED" chip in rightSlot | Faithful | Lines 711-732. |
| Inline lock banner ("✓ SUBMITTED") + "EDITING" banner | Faithful | Lines 1014-1058. Banner copy includes `selectedIso` for context. |
| `onEditCurrentVendor`: seed draft from submission's entries, user-typed wins | Faithful | Lines 301-346. Spread order `...Object.fromEntries(...) , ...(p[vid] || {})` confirms user-typed-wins (Q4 reading per §9.4). |
| On-successful-submit: clear current-vendor draft only, remove from editing set | Faithful | Lines 495-503. |
| Vendor pill `✓` glyph + green border when in `submittedVendorIds` | Faithful | Lines 830-841 + line 816. |
| history.tsx: VENDOR column between TIME and SUBMITTED BY, hydrated from `useStore.vendors` | Faithful | Lines 1378-1408. Sort: date DESC, then vendor name ASC (case-insensitive), tiebreaker on submission id (lines 1336-1345). |
| variance.log: `filter()` + SUM-aggregate per itemId across today's submissions | Faithful | Lines 1431-1449. Matches §9.6 and the server-side report_run_variance math. |
| Week sidebar day-level status aggregates across vendor submissions | Faithful | Lines 168-200. Picks `'draft'` if any submission is draft, else `'submitted'`/`'late'` based on cumulative coverage. |

**Net:** section is comprehensively faithful to §9. The architect cannot find
a single drift in the frontend section against the design. Every Q4 / Q5 /
Q6 / §9 sub-clause is addressed.

### 12. Forward-compat for spec 021

Spec 021 (`specs/021-reorder-delivery-list/spec.md`) is currently in DRAFT
with the "input signal" question open at A1 (lines 81-99). The recommended
v1 default is `inventory_items.current_stock`, not the EOD anchor. **However**,
the spec also accepts "Most recent EOD submission's `actual_remaining`" as a
candidate (line 86) and explicitly says at line 202-204:

> Spec 020 — if A1 picks "most recent EOD's `actual_remaining`", this spec
> depends on spec 020 landing first because the per-vendor EOD shape
> changes what "most recent EOD for vendor X" means.

**Verification: spec 020's schema gives spec 021 what it needs IF the
"most recent EOD" interpretation lands.**

The shape spec 021 would need is:
```
join eod_entries e on e.submission_id = eod_submissions.id
where eod_submissions.store_id = ? and eod_submissions.vendor_id = ?
  and eod_submissions.status = 'submitted'
order by eod_submissions.date desc, eod_submissions.submitted_at desc
limit 1
```
This is now expressible per-vendor cleanly. The new
`eod_submissions_vendor_id_idx` (line 27 of the schema migration) supports
the `vendor_id = ?` predicate. The new `(store_id, date, vendor_id)` unique
guarantees one row per (store, date, vendor), so a per-vendor "most recent"
lookup is unambiguous.

**However**, spec 021 needs to think carefully about how to handle:
1. Items in `inventory_items` belonging to vendor V that were NOT counted under V (the escape-hatch case Q6 covers). Their `actual_remaining` for V's reorder list lookup will be missing. Spec 021 will need a fallback rule.
2. Multi-vendor count days — the same item appears in two vendors' submissions. For vendor V's reorder calc, only the V-submission's entry is the right input; the SUM aggregation that variance does is the WRONG aggregation for reorder.

These are spec 021's design problems to solve; spec 020's schema supports
both choices cleanly. **No spec 020 changes required for spec 021
forward-compat.**

### 13. Realtime impact

Verified per §11:
- `eod_submissions` is in `supabase_realtime` via `FOR ALL TABLES` (publication membership at `supabase/migrations/20260502190000_realtime_publication.sql:14`).
- Adding `vendor_id` does NOT change publication membership.
- The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
- `useRealtimeSync.ts:36` (per CLAUDE.md) re-reads via the read helpers in `src/lib/db.ts` which now project `vendor_id`.

No realtime drift.

### 14. Sibling staff-app rollout sequence (§7)

The spec's risk register correctly captures the lockstep + fail-loud strategy
(spec lines 244-252, 938-1003). The dev's PR notes (spec lines 1417-1418)
correctly call out that sibling-app coordination is OUT of scope for this PR.

**However**, the in-repo edge function gap (finding §7 above) means the
rollout sequence is currently broken at step 5 — the design said step 5 is
"Deploy this repo's Edge Function update," and that update was not authored.

**Operator coordination is the user's responsibility.** The architect's
recommended order (steps 3+4+4b as a migration triplet, then 5–6 as the
rollout) still stands, but step 5 cannot proceed until the edge function
is patched.

## Block recommendation

**Block reason: one Critical, one architect-side oversight.**

### Critical (must-fix before deploy)

1. **`supabase/functions/staff-eod-submit/index.ts` was not updated.** The design (§6 + Files Changed §13) explicitly requires it; the dev's implementation omitted it. Effect: all sibling-app POSTs hitting this repo's edge function now fail with errcode 22023 ("staff_submit_eod: vendor_id is required as of spec 020"). The patch is small and well-specified at spec §6 lines 894-902: add `vendor_id?: string` to the `Body` interface, validate as a non-empty UUID string in `validate()`, and pass `p_vendor_id: body.vendor_id` in the `admin.rpc()` call at line 108.

### Should-fix (post-merge OK if scoped)

None of the implementation drift is design-breaking. The function-naming
choice (overload vs `_v2` suffix) and the errcode choice (`22023` vs
`P0001`) are both improvements over the design draft. The audit-row catalog
join is also an improvement that fixes a latent v1 bug.

### Architect-side admission

2. The architect's §3.1 #7 audit-row body literally inherited v1's
   `ii.name` / `ii.unit` references. Those columns were dropped in P3
   lockdown (`20260504072830:59-60`). The dev caught this and fixed it via
   the `catalog_ingredients` join — exactly the right shape, mirroring
   what spec 018's variance template already does (line 113-117 of
   `20260512120000_report_run_variance.sql`). The architect should
   acknowledge this oversight; it's a design miss, not implementation
   drift. The v1 RPC has been silently broken at audit-insert time since
   P3 lockdown landed, which is a pre-existing latent bug nobody hit
   because EOD submissions exercise the bug — they all came from the
   Cmd UI's direct-PostgREST path (which builds its own audit_log row
   client-side via `useStore.submitEOD → addAuditEvent`), never via the
   RPC's audit insert.

### Forward-compat note for spec 021

Spec 020's schema is forward-compatible with either resolution of spec 021's
A1 open question. If A1 lands on `current_stock`, no spec 020 hook is needed.
If A1 lands on "most recent EOD's `actual_remaining`," spec 021 needs to
add a per-vendor lookup and a fallback rule for items not counted under
the queried vendor (Q6 escape-hatch case). Both are spec 021's design
problems; spec 020's schema gives 021 the joins it needs.

## Summary line

**Critical: 1.** Edge function `staff-eod-submit/index.ts` is unmodified;
the design explicitly required the update. Patch is small (~10 lines).

**Should-fix: 0.** All other implementation is faithful or approved-drift
improvements.

**Minor: 0.**

Once the edge-function patch lands, the implementation matches the design
end-to-end and the sibling-app rollout sequence (§7) can proceed as
designed. Recommend a release block until the edge function is updated.
