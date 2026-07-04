# Security audit for spec 109 (cost-on-receipt)

Scope: the new cost-write capability on `receive_purchase_order`
(`item_vendors.case_price/cost_per_unit` upsert incl. INSERT of missing links,
`inventory_items.case_price/cost_per_unit` update) plus the FE slice. Threat
lens: a caller of the shared Supabase backend (staff app, customer PWA, or a
store member) must not be able to write costs to another store's items, inject
an arbitrary vendor/item pair, corrupt numeric data, or replay a cost write.

**Verdict: no Critical findings. The cost path is reachable only through the same
gates as the stock path, and cross-store cost injection was proven impossible on
the live stack.** Two Should-fix items (both test/robustness, not exploitable),
three Nits.

Files audited:
- `supabase/migrations/20260705000000_cost_on_receipt.sql` (the RPC)
- `supabase/migrations/20260704000000_po_loop.sql:160-301` (verbatim source, diffed hunk-by-hunk)
- `supabase/migrations/20260630000000_item_vendors.sql` (the RLS policies the upsert rides)
- `supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql` (column widening)
- `supabase/tests/cost_on_receipt.test.sql` (40 assertions — all green locally)
- `src/lib/db.ts` (`receivePurchaseOrder` arg builder + envelope map; `mapPoItemRow` `caseQty`)
- `src/screens/cmd/lib/priceGuard.ts` + `src/screens/cmd/sections/ReceivingSection.tsx` (FE 30% guard)

---

## What I verified (the load-bearing security claims — all PASS)

### 1. Cross-store cost injection is not possible (the primary threat) — PROVEN

I ran a live probe on the local stack: a store-A-only member (`can_see_A = t`,
`can_see_B = f`) commits a receive against a PO **in store A** (so the top-of-
function `auth_can_see_store(v_store_id)` gate legitimately passes) whose line was
crafted to point at **store B's item**. Result:

```
new row violates row-level security policy for table "item_vendors"
  ... receive_purchase_order line 138 (the item_vendors upsert)
ROLLBACK  — store B's item case_price + current_stock UNCHANGED
```

The layered defense holds even when the auth gate passes:
- `receive_purchase_order` is `security invoker` (`20260705000000:114`), so the
  caller's RLS applies to every write.
- The `item_vendors` upsert (`:253-258`) is blocked by
  `store_member_insert_item_vendors` (`20260630000000:126-129`), whose WITH CHECK
  resolves through the **item's own store** (`inventory_items ii ... auth_can_see_store(ii.store_id)`),
  NOT the PO's store. A caller who can't see store B cannot write store B's link.
- The `inventory_items` UPDATE (`:263-268`) carries `and ii.store_id = v_store_id`
  (`:268`) as a second belt — a cross-store item id silently matches zero rows.
- Because the whole RPC is one transaction, the RLS refusal aborts everything —
  no half-applied stock, no half-applied cost.

So the cost writes are reachable ONLY through the same gates as the stock writes,
exactly as the brief required. The `store_id = v_store_id` pin resolves the item
through the PO's own store for the scalar write, and the `item_vendors` RLS
provides the hard abort.

### 2. The `item_vendors` INSERT can't inject an arbitrary vendor/item pair — PASS

The upsert's `(item_id, vendor_id)` is derived, not caller-supplied:
- `v_item_id` comes from `po_items.item_id` for the line, resolved via the
  `pit.po_id = p_po_id` line pin (`:196-198`) — a caller can't smuggle a line
  from another PO (the UPDATE matches zero rows → `v_item_id` stays NULL → the
  cost block is skipped by the `v_item_id is not null` guard at `:214`).
- `v_vendor_id` comes from `purchase_orders.vendor_id` for THIS PO (`:141-142`),
  never from the request body.
- `is_primary = false` on INSERT (`:254`) — a new link can't hijack the primary;
  the SD-1 primary (`inventory_items.vendor_id`) is untouched. On UPDATE
  `is_primary` is left alone (`:255-258`). pgTAP case (2)/(4) pin both.

### 3. Input validation — PASS

- Negative `new_case_price` → `raise ... P0001` (`:215-218`) aborts the whole
  transaction (stock included); PostgREST maps to HTTP 400. pgTAP case (5) pins
  the abort left stock at 10 (nothing half-applied).
- Non-numeric JSON scalar → the `jsonb_to_recordset(... new_case_price numeric)`
  cast raises `22P02` at parse time, before the loop body. No unvalidated value
  reaches a write.
- No dynamic SQL. Every value is a bound plpgsql local; the only `format()` in the
  file is in the pgTAP fixture, not the RPC.
- `= 0` / absent / equal-to-current are no-ops (the `> 0 and is distinct from`
  change test at `:243-244`) — a stray 0 from a mis-mapped FE field can't zero a
  real cost. pgTAP case (6)/(7).

### 4. Numeric overflow is an error, not silent corruption — CONFIRMED (closes the brief's OQ)

`item_vendors.case_price` is `numeric(10,2)` and both `cost_per_unit` columns are
`numeric(12,6)` (verified live + via `20260701000000:128-129`). I confirmed on the
stack that an out-of-range value raises `22003` (numeric_value_out_of_range):

```
1000000000::numeric(10,2)  →  ERROR 22003: numeric field overflow
```

So a huge case price aborts the transaction rather than corrupting a row. Note the
brief's hypothetical was slightly off on the threshold: `numeric(10,2)` caps at
~10^8 (99,999,999.99), not 10^9, and for a divisor of 1 the derived per-each would
overflow `cost_per_unit numeric(12,6)` (caps at 999,999.999999) even sooner — but
both overflow paths raise `22003` and abort. Behavior is safe; no clamping, no
truncation. (This is a data-integrity property, not an availability concern — the
FE input is a 2dp currency field, so it's unreachable in normal use.)

### 5. Idempotent replay cannot re-apply cost writes — PASS

The dedup short-circuit (`:159-175`) returns BEFORE the step-(3) loop where the
cost writes live, and now also carries `price_changes: '[]'` (`:173`). A replay
with the same `p_client_uuid` never reaches the cost block. pgTAP case (3) pins:
link `case_price` stays 44 (not double-written), scalar stays 44, stock stays 12,
and exactly **one** `'PO price change'` audit row (not duplicated). Sequential
DIFFERENT receives (fresh uuids) each apply (last-wins) — correct per OQ-6.

### 6. Audit rows leak nothing sensitive — PASS

The `'PO price change'` row (`:285-296`) writes `store_id`, `user_id = auth.uid()`
(INVOKER → real caller, spoof-proof — pinned by pgTAP case (8)), a truncated PO id
(`left(p_po_id::text, 8)`), the vendor name, the catalog item name, and old→new
case/per-each prices. All are data the caller already has store-scoped access to
(the row's `store_id = v_store_id` is within the caller's set and the `audit_log`
Store-access policy gates reads). No secrets, no tokens, no cross-store rows, no
SQL fragments. `console.warn('[Supabase] receivePurchaseOrder:', error.message)`
(`db.ts:1607`) logs only a generic PostgREST error string — same posture as the
spec-107 siblings; no PII or token.

### 7. Grants unchanged — CONFIRMED

The migration emits no grant/revoke (`:374-375`). Live ACL after the
create-or-replace: EXECUTE for `postgres`, `authenticated`, `service_role` only —
**no `anon`, no `public`**. The signature is byte-identical
(`receive_purchase_order(uuid, jsonb, uuid)`), so `create or replace` preserved the
spec-107 `revoke ... from public, anon` + `grant ... to authenticated`. No re-emit
was needed and none was added. Correct.

### 8. FE has no new data path outside `db.ts`; the 30% guard is UX only — PASS

- The RPC is called exactly once, through `useStore.receivePurchaseOrder` →
  `db.receivePurchaseOrder` (centralized). No raw `fetch`, no `supabase.from/rpc`
  in `ReceivingSection.tsx` or `priceGuard.ts`. The `db.ts` arg builder omits
  `new_case_price` unless `Number.isFinite` (`db.ts:1600-1602`); the envelope map
  coerces defensively (`String()`/`Number()`, `null` preserved on `old_*`).
- The >30% guard (`priceGuard.ts` + `ReceivingSection.tsx:200-261`) is a pure
  client-side `confirmAction`; declining aborts the whole commit (nothing sent).
  It is correctly a UX control, NOT a security boundary — the RPC is permissive
  by design (accepts what is sent). This is **documented, not accidental**: the
  RPC comment (`20260705000000:377-392`), the migration header, and spec §6 all
  state the RPC accepts what is sent and the client-side confirm is the mechanism.
  The permissiveness is bounded by the same store-scoped RLS as every other write,
  so a client bypassing the confirm can only re-price items in stores it already
  controls (the accepted OQ-1 whipsaw), never another store's.

---

## Critical (BLOCKS merge)

None.

---

## Should-fix (before deploy)

- `supabase/tests/cost_on_receipt.test.sql` — **the store-isolation (non-member
  refusal) case for the cost path is NOT pinned.** The design's §7 case (e)
  ("the `auth_can_see_store` refusal still fires before any cost write — assert
  link + scalar unchanged after the refused call") and the review brief both call
  for it, but the delivered file runs entirely as `master` (who sees all stores
  via `auth_is_admin`) and has no negative-authorization assertion. Every one of
  the 40 assertions exercises the happy authorization path. I proved the isolation
  holds manually on the live stack (§1 above), so this is a **coverage gap, not an
  exploitable hole** — but the single most security-relevant property of this
  feature (a non-member cannot write another store's cost) is currently unguarded
  by CI. If a future refactor moved the `item_vendors` upsert to `security definer`
  or dropped the `ii.store_id = v_store_id` pin, nothing in the suite would catch
  it. Add a case: a member of store A, a PO in store A whose line targets store
  B's item, assert the RPC raises (RLS on `item_vendors`) and store B's
  `case_price`/`cost_per_unit`/`current_stock` are unchanged. (This mirrors the
  spec-107 harness's own auth-refusal assertion at `po_loop.test.sql:255`, which
  the cost-path suite did not carry forward.)

- `supabase/migrations/20260705000000_cost_on_receipt.sql:246` — **the ★ divisor
  `v_case_qty * v_sub_unit_size` is guarded against NULL (via `coalesce(...,1)` at
  `:224`) but not against an explicit `0`.** A catalog row with `case_qty = 0` or
  `sub_unit_size = 0` would make the divisor 0 and raise `22012` (division_by_zero)
  on a priced line, aborting the receive. This is a robustness/availability nit,
  not a security hole (it fails closed — errors, doesn't corrupt), and the design
  §16 explicitly flagged it as a known non-guard consistent with the reorder RPCs.
  I surface it because the whole call (stock included) aborts on a data condition
  a store admin could plausibly create via the catalog editor, and there is no CI
  workflow gating catalog-value sanity (README's `db-migrations-applied` does not
  cover data). The belt-and-suspenders fix the design offered —
  `greatest(v_case_qty * v_sub_unit_size, 1)` — would degrade a 0-packing line to
  a $=case per-each instead of aborting the entire receive. Deploy-blocking only
  if 0-packing catalog rows are reachable in prod; otherwise a follow-up.

---

## Nits

- `supabase/migrations/20260705000000_cost_on_receipt.sql:264` vs `:253` — the
  same `new_case_price` writes `inventory_items.case_price` (unconstrained
  `numeric`, full precision) and `item_vendors.case_price` (`numeric(10,2)`,
  rounds to 2dp). For a >2dp entered price the two columns diverge by a sub-cent.
  Cosmetic, within the spec-104 per-each reconstruction tolerance, and the FE
  input is a 2dp currency field — design §16 already noted it. No action needed.

- `src/lib/db.ts:1607` — `console.warn('[Supabase] receivePurchaseOrder:',
  error.message, error)` logs the full `error` object in addition to the message.
  For a PostgREST/RPC error this is the generic error envelope (no token, no PII,
  no row data), so it is not a leak under this codebase's threat model — but it is
  marginally more verbose than the message-only pattern most `db.ts` siblings use.
  Consistent with the existing spec-107 line; flagging only for symmetry.

- `supabase/tests/cost_on_receipt.test.sql:469-480` — the negative-price case (5)
  asserts `P0001` but not that the `item_vendors`/`inventory_items` cost columns
  are unchanged by the aborted call (it only checks stock). The abort guarantees
  it transitively, and case (5) is otherwise solid; a one-line cost-unchanged
  assert would make the "nothing half-applied" claim explicit. Optional.

---

## Dependencies

No `package.json` changes in this spec — `npm audit` skipped. The migration is
RPC-only (no new dependency, no edge function, no third-party API, no secret
surface). Confirmed against the `## Files changed` list: migration, `db.ts`,
`useStore.ts`, `ReceivingSection.tsx`, `priceGuard.ts`, i18n catalogs, and the
pgTAP/jest test files — none touch `package.json` or `supabase/config.toml`.

## Resolution (main Claude, post-review fix pass — 2026-07-03)

- **Should-fix 1 (non-member cost-write refusal not pinned) — FIXED.**
  `supabase/tests/cost_on_receipt.test.sql` case (13): Charles-store fixtures
  built as master, then the seed 2222 manager (Towson+Frederick member, NOT
  Charles) calls receive with a PRICE-CARRYING line (received_qty 2,
  new_case_price 99) → throws P0002 (INVOKER RLS hides the PO — byte-mirrors
  po_loop.test.sql case (F)), then back as master asserts NOTHING durable
  survived: link price, item scalar, stock, and audit all unchanged (5
  assertions). The cost path's single most security-relevant property is now
  CI-guarded.
- **Should-fix 2 (divide-by-zero non-guard on the ★ divisor) — WAIVED as
  designed.** Pre-flagged in the spec (§16) and by the architect as
  known/accepted: a zero case_qty × sub_unit_size fails CLOSED (22003/22012
  aborts the whole call — availability, not integrity), and the fix belongs to
  catalog data validation, not this RPC. Consistent with the architect's
  post-impl ruling; left for a future catalog-validation spec.
- Nits — no code action (posture confirmations). The audit's live cross-store
  injection proof is additionally now approximated in CI by case (13).

Post-fix gates: pgTAP 55/55 in-file, 62/62 files; jest 927/927; both
typechecks clean. Browser pass detail in code-reviewer.md Resolution.
