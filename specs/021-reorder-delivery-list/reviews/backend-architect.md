# Spec 021 — Reorder / delivery list — Backend-Architect drift review

Reviewer: backend-architect (post-impl mode)
Date: 2026-05-13
Scope: drift between Backend Architecture (§§0-14) in
`specs/021-reorder-delivery-list/spec.md` and the implementation under
`supabase/migrations/20260514130000_report_reorder_list.sql` plus the
frontend changes in `src/lib/db.ts`, `src/store/useStore.ts`,
`src/types/index.ts`, `src/screens/cmd/sections/ReorderSection.tsx`,
`src/lib/cmdSelectors.ts`, `src/screens/cmd/InventoryDesktopLayout.tsx`,
and `src/hooks/useRealtimeSync.ts`.

## Verdict at a glance

| Area | Status |
|---|---|
| RPC signature, security mode, search_path, auth gate, error class | Faithful |
| JSONB envelope shape vs `ReorderPayload` TS type | Faithful (1 minor field-name caveat) |
| Next-delivery math — 7-day fallback path | Faithful |
| Next-delivery math — today-is-delivery + cutoff path | Approved Drift (tz caveat) |
| Next-delivery math — multi-delivery-day picker | **DRIFT — bug** |
| EOD-first / current_stock fallback | Faithful |
| Hybrid formula `max(par_replacement, usage_forecasted)` | Faithful |
| `pending_po_qty=0` v1 placeholder + v2 swap-point documentation | Faithful |
| Frontend TS contract / chip mapping | Faithful |
| Sidebar placement | Faithful |
| `purchase_orders` realtime subscription | Faithful |
| v1 vs v2 split | Faithful |

Block recommendation: **DO NOT BLOCK release**, but raise one
Should-fix bug (D-1) to be addressed before the v2 PO-subtraction swap
lands. The bug surfaces only for vendors with more than one
`delivery_day` per week; single-day vendors and zero-day vendors are
fine.

---

## Drift inventory (ranked)

### Should-fix

#### D-1. Multi-delivery-day vendor picks "lowest DOW number" instead of "nearest day"

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:354-372`

The `vendor_delivery_offsets` CTE chooses the next delivery day by:

```sql
select min(case lower(os2.delivery_day) when 'sunday' then 0 ... end)
  as delivery_day_dow
  from public.order_schedule os2
 where os2.store_id  = p_store_id
   and os2.vendor_id = v.id
```

This selects the *lowest DOW number* across the vendor's delivery days,
**then** computes `days_offset = (delivery_day_dow - today_dow_num + 7) % 7`.
That order is wrong — `min()` should apply to the **distance**, not to the
raw DOW.

**Concrete failure case.** Today = Wednesday (DOW=3). Vendor X has
`delivery_day` rows for Monday (DOW=1) and Thursday (DOW=4). Today's
correct next delivery is **Thursday (1 day away)**. The current SQL
picks `MIN(1, 4) = 1` (Monday), then computes
`(1 - 3 + 7) % 7 = 5` → reports "next delivery in 5 days, Monday".

The architect's design §6 case 3 is explicit about this:

> Vendor has multiple delivery days/week. … We take the MIN distance
> across all of that vendor's delivery_days. So if vendor X delivers
> Mon and Thu, on Tuesday we'd pick Thu (2 days), not Mon (6 days).

**Suggested fix.** Move the `min` to wrap the offset expression:

```sql
select min(
  case
    when delivery_day_dow = v_today_dow_num then
      -- today: cutoff-aware (per case 1)
      case when v.order_cutoff_time is not null
            and v_today_time > v.order_cutoff_time::time
           then 7 else 0 end
    else ((delivery_day_dow - v_today_dow_num + 7) % 7)
  end
) as days_offset
  from (
    select case lower(os2.delivery_day) when 'sunday' then 0 ... end
             as delivery_day_dow
      from public.order_schedule os2
     where os2.store_id  = p_store_id
       and os2.vendor_id = v.id
       and os2.delivery_day is not null
  ) days
 where delivery_day_dow is not null;
```

(The dev's preferred shape may differ — the architect cares only that
the `min()` applies to the offset, not to the raw DOW.)

**Impact in v1.** Cosmetic mis-statement of next-delivery date for
vendors with more than one delivery day per week. Suggested qty
contribution via `usage_forecasted = usage_per_portion × qty_per_day ×
days_until` would over-report by the same days delta, so vendors with
usage signal see inflated suggestions. The Towson seed has no
`order_schedule` rows so this is invisible on the demo dataset; the
bug bites the first time a real prod store has a multi-day vendor.

#### D-2. Cutoff-time comparison is UTC, vendor cutoff is "store local time"

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:133, 346`

```sql
v_today_time := (now() at time zone 'utc')::time;
…
when v.order_cutoff_time is not null
 and v_today_time > v.order_cutoff_time::time
then 7
```

`vendors.order_cutoff_time` is documented as HH:MM **store-local time**
(`20260424001643_vendor_order_cutoff.sql:7`: "Admin-settable order
cutoff on the vendor (HH:MM, store local time)"). The implementation
compares it against UTC wall-clock. Where the store is east of UTC,
the cutoff effectively shifts forward in absolute time; west of UTC,
backward. Eastern-US store + 09:00 cutoff means "cutoff at 09:00
ET = 14:00 UTC". The current SQL says cutoff passes at 09:00 UTC,
which is 04:00/05:00 ET — five hours too early.

The architect flagged this in §6 case 5 ("Server TZ vs store TZ.
v1 acceptance: `as_of_date` defaults to server's `current_date` UTC;
explicit override via `p_params->>'as_of_date'` lets the client pass
the store's local date") — but the design only addresses `as_of_date`,
not `order_cutoff_time`. The implementation inherits the UTC default
for both. Approved Drift to call out and document; the architect's
v1 acceptance does mean this isn't a release-blocker, but it should
be added to the v2 punchlist alongside D-1 since both touch the
same CTE.

**Suggested mitigation note in v2 spec.** Either (a) accept a
`p_params.now_local` time string from the client (same pattern as
`as_of_date`), or (b) add a `stores.timezone` text column and compare
in store-local. (b) is the cleaner long-term fix; (a) is the cheaper
follow-up. Defer to PM.

---

### Minor

#### M-1. `flags` ordering not specified; implementation is OK but not deterministic across recipe changes

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:441-454`

The architect's design §3 lists known flag tokens but does not specify
their order. The SQL builds via repeated `jsonb_build_array(...) ||`,
which gives a deterministic order *per row*:
`no_par → no_usage_rate → eod_missing_for_item → truncated`. That
order is fine. Worth surfacing because the spec was silent; the
frontend's `FlagChip` map is order-agnostic so this is a write-up
note, not a fix.

#### M-2. `eod_submitted_at` collapse via `max()` on every item join — relies on spec-020 invariant

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:474`

```sql
max(ioh_lev.submitted_at) as eod_submitted_at
```

This sources `submitted_at` via the `item_on_hand` row's `lev`
projection — which means stock-fallback items also bring a NULL
into the `max()`. That's fine since `max()` ignores NULLs. The
comment claims "one submission per vendor per day post-spec-020,
so this collapses" — true given the unique constraint
`(store_id, date, vendor_id)` added in `20260514120000_eod_submissions_vendor_id.sql:118-121`.
Faithful, just worth surfacing that the correctness here depends on
spec 020's invariant holding. If spec 020 ever rolls back, this
collapses to "some arbitrary submission's timestamp" silently.

#### M-3. Vendor "eod"-source can flip to "stock" when all EOD-counted items happen to be at par

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:470-471`

```sql
case when bool_or(pif.item_on_hand_source = 'eod') then 'eod'
     else 'stock' end as on_hand_source
```

The architect's design §3 said the vendor-level source rolls up to
`'eod'` iff **any item drew from EOD**. The SQL achieves that with
`bool_or` over `per_item_filtered` (i.e. post-filter). If a vendor
has an EOD submission today but every EOD-counted item happens to be
at par (suggested_qty=0, filtered out), the vendor card shows
`'stock'` despite the EOD existing. Same shape as if there were no
EOD at all. Cosmetic mis-statement; the user would only notice if
they specifically check the badge against the EOD log.

Optionally fix by rolling up `on_hand_source` from the *pre-filter*
`item_on_hand` set instead of `per_item_filtered`. Not a release
blocker.

#### M-4. RPC envelope server key `_warnings` vs TS field name `warnings`

**File:** `supabase/migrations/20260514130000_report_reorder_list.sql:576` ↔ `src/lib/db.ts:2055`, `src/types/index.ts:637`

The SQL builds `'_warnings'` (with underscore prefix); the TS type
calls the same field `warnings` (camelCased, no underscore). The
mapper at `db.ts:2055` reads `envelope._warnings` and emits
`warnings`. Faithful translation — the underscore-prefix on the
server is the architect's design §3 envelope shape. No drift; this
is documented for posterity since the rest of the envelope uses
snake_case without underscore prefixes.

---

## Faithful checks (no findings)

- **RPC signature** — `public.report_reorder_list(uuid, jsonb)`,
  `language plpgsql`, `security invoker`, `set search_path = public`.
  Matches design §2.
- **Auth gate** — first non-declaration statement is
  `if not public.auth_can_see_store(p_store_id) then raise exception
  ... errcode = '42501'`. Matches design §4.
- **Grants** — `revoke execute … from public, anon; grant execute …
  to authenticated;`. Matches design §4.
- **JSONB envelope keys** — `{ as_of_date, vendors[items{ item_id,
  item_name, unit, on_hand, pending_po_qty, par_level, usage_forecasted,
  par_replacement, suggested_qty, cost_per_unit, estimated_cost, flags
  }, schedule_known, next_delivery_date, days_until_next_delivery,
  on_hand_source, eod_submitted_at, vendor_total_cost], kpis{
  vendor_count, item_count, total_estimated_cost,
  eod_sourced_vendor_count, stock_fallback_vendor_count }, _warnings[] }`.
  Every field name from design §3 is present in the SQL output and
  read by `db.ts`'s `mapReorderVendor`.
- **EOD-first lookup** — `latest_eod_per_vendor` filters
  `status='submitted'` (matches the variance runner's draft-exclusion
  shape) and joins by `(store_id, date, vendor_id)` per the spec-020
  invariant. Per-item case A/B/C resolution in `item_on_hand` matches
  design §5 step 4.
- **`per_item_filtered` suggested_qty < 0.001 cutoff** matches design
  §5 step 8.
- **Vendor rollup filters empty cards** — implicit via `INNER JOIN`
  on `per_item_filtered` → no rows → no vendor. Matches AC line 62.
- **Truncated propagation** — `recipe_meta` rolls truncated up to
  recipes; `pos_daily_per_item` rolls it to items via `bool_or`.
  Matches design §5 step 7.
- **Hybrid formula** — `greatest(0, par_level - on_hand -
  pending_po_qty)` for par_replacement; `greatest(0, usage_per_portion
  × qty_per_day × days_until - on_hand - pending_po_qty)` for
  usage_forecasted; `greatest(par_replacement, usage_forecasted)` for
  suggested_qty. Matches A2 / design §5 step 8.
- **`pending_po_qty=0` v1 placeholder** — the `pending_po_qty` CTE
  emits `0::numeric` for every item. The migration header comment
  (lines 12-34) AND the inline CTE comment (lines 290-293) both
  document the v2 swap point and reference the audit findings in
  spec §1. Forward-compatibility is explicit.
- **TS contract surface** — `ReorderPayload`, `ReorderVendor`,
  `ReorderItem`, `OnHandSource` exported from `src/types/index.ts`.
  `fetchReorderSuggestions(storeId, asOfDate?)` returns
  `Promise<ReorderPayload>`. Camel-case mapping in `mapReorderVendor`
  is faithful. Matches design §8.
- **UI consumes all envelope fields** — `BreakdownLine` renders
  `on_hand | pending_po_qty | par_level → suggested_qty`; `VendorCard`
  surfaces `nextDeliveryDate`, `daysUntilNextDelivery`, `vendorTotalCost`,
  `eodSubmittedAt`. Three badges (`EOD`/`STOCK FALLBACK`/`SCHEDULE
  UNKNOWN`) align with the `(scheduleKnown, onHandSource)` matrix in
  design §11. `FlagChip` maps all four documented tokens
  (`no_par`/`no_usage_rate`/`eod_missing_for_item`/`truncated`) and
  renders unknown tokens raw — forward-compatible.
- **Sidebar placement** — `Reorder` registered in `SCREEN_ENTRIES`
  at `cmdSelectors.ts:170` (after Restock) and in the `Planning`
  group at `cmdSelectors.ts:1061` (after Restock). Matches design §11.
- **InventoryDesktopLayout dispatch arm** at `InventoryDesktopLayout.tsx:167-168`
  is correctly positioned between `Restock` and `PurchaseOrders`.
- **`purchase_orders` realtime subscription** — added to `store-{id}`
  channel at `useRealtimeSync.ts:42` with `filter: store_id=eq.${storeId}`.
  v1 no-op (since `pending_po_qty=0`); v2-ready when the swap lands.
- **Realtime publication gotcha** — `supabase_realtime` is `FOR ALL
  TABLES` (`20260502190000_realtime_publication.sql:14`), and the
  migration does NOT modify the publication. No
  `docker restart supabase_realtime_imr-inventory` needed. Faithful
  to architect §7.
- **`loadReorderSuggestions` slice pattern** — error to
  `reorderError` (panel render), not `notifyBackendError` (toast).
  Matches architect §9 and the reports detail-frame precedent.

---

## v2 forward-compat checklist

What the next architect / spec needs to swap in once the PO write
path lands and/or the cutoff timezone issue is properly addressed:

1. **Pending-PO subtraction (A3 mechanics).** Replace the
   `pending_po_qty` CTE (`20260514130000_report_reorder_list.sql:294-298`)
   with a real join through `po_items` + `purchase_orders`. Filter
   `status IN ('submitted', 'sent', 'partial') AND received_at IS NULL`
   per architect §1 — `received_at IS NULL` is the receipt gate that
   works regardless of which status string is in use. No payload
   shape change; the UI's `pendingPoQty` column / "inbound" segment
   stays unchanged.
2. **`purchase_orders.status` lifecycle audit (Q2 in architect §Open
   questions).** Either add a CHECK constraint enforcing the canonical
   enumeration, refactor `db.createPurchaseOrder` to write
   `'submitted'` → `'sent'`, or document `received_at IS NULL` as the
   canonical "in flight" gate. PM decision required.
3. **`db.createPurchaseOrderWithItems` / `db.upsertPoDraft` helper
   (Q1 in architect §Open questions).** Required to wire the
   "Create PO" button — currently a disabled-with-tooltip affordance
   in `ReorderSection.tsx:151-176`. The `DisabledCreatePoButton`
   already names spec 022 as the v2 target, which keeps the v1/v2
   split explicit in the codebase.
4. **Multi-delivery-day fix (D-1 in this review).** Apply the
   `min(offset)` reshape in `vendor_delivery_offsets`. Should land
   independently of the PO swap — it's a defect, not a feature gap.
5. **Cutoff timezone fix (D-2 in this review).** Either
   `p_params.now_local` time-string input or a `stores.timezone`
   column. Same-day cutoff math currently assumes server tz = store
   tz. Defer to v2 with the rest of the timezone audit.
6. **Realtime swap-in verification.** The `purchase_orders`
   subscription at `useRealtimeSync.ts:42` is already wired. When
   `pending_po_qty` becomes non-zero in v2, this no-op signal
   becomes a real refresh trigger automatically — no JS change
   needed.

## Block recommendation

**Do not block release.** D-1 (multi-delivery-day picker) is the only
real defect and only fires when a real prod store wires
`order_schedule` rows with more than one `delivery_day` per
`(store_id, vendor_id)` pair. The Towson seed and current prod state
have no such rows; the demo path and single-day vendors are correct.
D-2 (cutoff tz) is an existing class of drift in this codebase
(architect's design admits the `as_of_date` UTC default as a v1
acceptance); flagging it for the v2 timezone-pass spec, not blocking
v1 ship.

All other AC paths are faithfully implemented. The contract surface
(RPC signature, envelope shape, TS types, helper, slice, sidebar,
realtime subscription) is clean enough that v2's PO-subtraction swap
can land without breaking any frontend code.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix,
  4 Minor findings. D-1 (multi-delivery-day picker) is a real defect
  but invisible on the current seed; recommend follow-up spec or
  in-flight patch before any prod store wires multi-day vendors.
  D-2 (cutoff tz) is a pre-existing class of drift accepted by
  architect's v1 design.
payload_paths:
  - specs/021-reorder-delivery-list/reviews/backend-architect.md
