## Security audit for spec 113 — Staff-side receiving + `receive_purchase_order` price-path privilege gate

**Verdict: PASS. No Critical, no Should-fix. The load-bearing R-1 fix is correct and proven on the live stack.**

The vulnerability this spec closes (pre-spec, `receive_purchase_order` gated only on
`auth_can_see_store()`, so any authenticated store member — including a staff-role
`user` — could craft an RPC call with `new_case_price` and rewrite item costs via the
spec-109 ★ path) is **closed**. The migration
`20260707000000_staff_receiving_price_gate.sql` adds `if not public.auth_is_privileged()
then raise … 42501 'forbidden: price change requires admin' … end if` as the first
statement in the §3b cost branch, and the fix behaves exactly as specified when probed
against the live local stack (docker `supabase_db_imr-inventory`, applied; prod NOT
applied — flagged below).

### Method

Probed the **live** function (not just the SQL text) as the genuine test identities via
`request.jwt.claims` GUC + `set role authenticated`, exactly the pgTAP posture:
- **2222** = `manager@local.test`, `app_metadata.role='user'`, `profiles.role='user'`,
  a Towson+Frederick store member — a genuine non-privileged store member
  (`auth_is_privileged()` = **false**, `auth_can_see_store('Towson')` = **true**, verified live).
- **3333** = `master@local.test`, `app_metadata.role='master'` (`auth_is_privileged()` = **true**).

Each scenario ran inside `begin … rollback` against a controlled PO fixture built on a
real item (Red Hot Pepper Relish, `08c917cd…`, store Towson, case_price 39 /
cost_per_unit 9.75 / case_qty 4 / sub_unit_size 1) whose primary `item_vendors` link
(`d5e3adcc…`) matches the PO vendor, so the price path — if reached — would actually
write.

### Live verification results (all 7 task cases + the crux)

**(1)+(2) Staff priced receive → 42501, nothing durable — INCLUDING the crux.** As 2222,
a receive whose line1 is stock-only and line2 carries `new_case_price:999` raises
`sqlstate=42501 'forbidden: price change requires admin'`. Trapping the exception in a
nested block so the outer txn survived to READ durable state proved, **after the aborted
call**: `line1.received_qty=0`, `line2.received_qty=0`, `current_stock` unchanged,
`inventory_items.case_price`/`cost_per_unit` unchanged, `item_vendors.case_price`
unchanged, `inventory_items.updated_at` unchanged, `receive_client_uuid` NULL, and
`audit_log` delta 0. **The crux holds: the §3a stock `UPDATE` for line1 runs EARLIER in
the same loop (source-order before §3b), yet the `raise` aborts the implicit transaction
and rolls that write back — the earlier-iteration stock increment does not survive.** This
is `receive_purchase_order` body line 115-116; the atomic-rollback reasoning in the
migration header (lines 43-54) is correct as executed.

**(2) Presence-not-value — no oracle, no partial application.** As 2222, `new_case_price`
of `0`, `-1`, `39` (equal-to-current), and `999` (different) **all** raise the identical
`sqlstate=42501 'forbidden: price change requires admin'`. Critically, `-1` returns
**42501, not P0001** — the gate fires BEFORE the `< 0` validation (live body: gate at line
115, `<0` at line 119), so a non-privileged caller cannot distinguish a negative from any
other value. No same-price bypass (`39` equal-to-current still refuses). No value-dependent
branch is reachable by a non-privileged caller.

**(3) Master price path STILL works (regression).** As 3333, `new_case_price:120` on the
relish (÷ (4×1) ⇒ per-each 30) succeeds: `inventory_items.case_price → 120`,
`cost_per_unit → 30`, `item_vendors.case_price → 120`, status `received`, one
`'PO price change'` audit row, and `price_changes[]` carries the entry. Byte-identical to
spec 109.

**(4) Staff stock-only receive (no price key) succeeds — gate doesn't over-block.** As
2222, a stock-only receive of 6/10 returns `status:partial`, `price_changes:[]`;
`received_qty=6`, `current_stock +6`, one `'PO received'` audit row, zero `'PO price
change'` rows. The gate is strictly inside the §3b price branch — the stock path is NOT
gated on privilege (R-1 is stock-FOR-staff).

**(4/AC-4) Idempotency unaffected.** As 2222, a stock-only receive (qty 4) then a replay
with the SAME `client_uuid` returns `conflict:true`, `received_qty` stays 4 (not 8), stock
delta 4 (not 8). The dedup short-circuit fires before the loop and re-applies nothing; a
replay carrying no priced line is not spuriously refused.

**(5) Gate fires before any cost side-effect; no grant/RLS/search_path drift.** Live
function: SECURITY INVOKER (`prosecdef=f`), `search_path=public`, signature unchanged.
EXECUTE grants: `authenticated`, `postgres`, `service_role` only — **no `anon`, no
`public`** (the spec-107 ACL preserved by `create or replace`; no grant re-emit). RLS SELECT
policies confirmed live: `store_member_read_purchase_orders` → `auth_can_see_store(store_id)`
and `store_member_read_po_items` → resolves to `auth_can_see_store(po.store_id)`; no new
policy added (AC-6). `purchase_orders` already in `supabase_realtime`; `po_items` is not —
publication unchanged. **Verbatim-copy discipline verified byte-for-byte**: a normalized
diff of the spec-113 `receive_purchase_order` body against the spec-109 source
(`20260705000000_cost_on_receipt.sql`) shows **15 lines added, 0 removed** — the gate
comment + the 3-line guard + one blank line, nothing else. No stock/status/idempotency/
envelope/privileged-cost line drifted, so no behavior silently regressed under cover of the
"one hunk" claim.

**(6) Frontend belt — server gate is the real control.** `src/screens/staff/lib/receiving.ts`
`submitStaffReceive` maps each line to **exactly two keys** (`po_item_id`, `received_qty`)
— never `new_case_price` (line 218-226). `StaffPoLine`/`StaffReceiveDelta` carry no price
field; `fetchStaffPoLines` selects no `cost_per_unit`/`case_price`. A grep of the entire
`src/screens/staff/` subtree finds no price/cost surface in the receiving path (the
`caseQty`/`costPerUnit` hits are all in EOD/Weekly/Reorder, unrelated). `Receiving.tsx`
mints the client uuid once per commit, builds deltas via `buildReceiveDeltas` (drops
zero/negative rows), and routes errors to `notifyBackendError` (no phantom success). The
belt is correct — and the live probes confirm a **crafted client cannot bypass the server
gate** (a hand-rolled `new_case_price` from a `user` session is refused server-side with
nothing durable).

**(7) Cross-store — staff of A cannot receive/price B's PO.** As 2222, a PO in a
non-member store is invisible under RLS (`select count(*)` on it returns 0), so the RPC's
own `select store_id from purchase_orders where id=…` (SECURITY INVOKER, caller RLS)
returns NULL → `P0002 'not found'` for BOTH the stock-only and the priced attempt; nothing
written. `auth_can_see_store` still holds — the store/visibility gate wins before the price
gate, which is the correct ordering.

### `auth_is_privileged()` provenance (defense-in-depth note, not a finding)

The gate calls `public.auth_is_privileged()` = `auth_is_admin() OR auth_is_super_admin()`
(SECURITY DEFINER, `search_path=public,auth`). `auth_is_admin()` reads
`auth.jwt() -> 'app_metadata' ->> 'role'` — `app_metadata` is server-controlled in Supabase
(only the service-role / admin API can write it; the client-writable surface is
`user_metadata`), so a staff session cannot forge admin/master. `auth_is_super_admin()` is a
live `profiles.role='super_admin'` lookup. The gate mirrors the DB-side canonical predicate
and the edge-function `ADMIN_ROLES` set (admin OR master OR super_admin) per CLAUDE.md — no
role-band omission.

### Critical (BLOCKS merge)

None.

### Should-fix (before deploy)

None.

### Nits / informational

- **Prod not yet applied (owner-gated — expected, flagged by design).** The migration is
  applied to LOCAL only; prod (`ebwnovzzkwhsdxkpyjka`) is NOT. Until it is applied via the
  Supabase MCP + the `20260707000000` row inserted into `schema_migrations`, **the hole
  remains open in prod** — a staff `user` in prod can still rewrite costs via a crafted
  `new_case_price`. This is a body-only change, invisible to the `db-migrations-applied`
  drift gate, so POST-APPLY verify with the header's probe
  (`pg_get_functiondef … like '%forbidden: price change requires admin%'`). This is not a
  code finding — it is the documented owner-gated rollout — but it is the one thing that
  keeps this fix from being live where it matters. Surfaced so the release-coordinator
  tracks the prod-apply as a release gate.
- **Adjacent pre-existing surface, out of scope, NOT a spec-113 finding.**
  `public.create_inventory_item_with_catalog` (SECURITY INVOKER, EXECUTE to
  `authenticated`, no privilege gate; migration `20260504173843…`, predates this spec)
  writes `case_price`/`cost_per_unit` on item *creation* and rides only
  `store_member_insert_inventory_items` → `auth_can_see_store(store_id)`, which a store
  `user` passes — so a staff member could craft an item-create with an arbitrary cost. This
  is the item-*creation* path, entirely separate from the receive/re-price path spec 113
  closes, is not a regression introduced here, and touching it would be scope-creep. Noted
  only so it is on record; it does not undermine the spec-113 fix (the `receive_purchase_order`
  re-price path is now correctly gated) and is not a blocker for this spec.

### Dependencies

No `package.json` changes in the spec-113 change set (not in `HEAD`, not in the pending
diff) — `npm audit` skipped. Backend is a single body-only SQL migration; frontend is
staff-subtree TS with no new dependency.

## Resolution note (main Claude — 2026-07-04)

No security findings to action (0 Critical / 0 Should-fix). The R-1 gate is
verified correct live across all 7 cases including the atomic earlier-stock-line
rollback. Two informational nits:
- Prod-apply is owner-gated (the escalation hole stays open in prod until the
  MCP apply of 20260707000000 lands) — folded into the ship checklist, NOT
  waived; this is a real security fix that should reach prod.
- The pre-existing, out-of-scope ungated cost writer `create_inventory_item_with_catalog`
  is spun off as a separate follow-up task (not a spec-113 finding).
