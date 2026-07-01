# Security audit for spec 105 — Par-status indicators + counted-on-hand reorder RPC

Scope audited: the new read-only RPC
`supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql`, its
pgTAP suite, the `src/lib/db.ts` fetcher, and the frontend companion fetch +
pure helper. Threat model: multi-tenant per-store (`auth_can_see_store()`),
sibling apps (staff, customer PWA) hit the same Supabase project, so RLS here
protects against their users too.

**Verdict: no Critical, no Should-fix. The RPC is a correctly-gated,
correctly-scoped, invoker-context read-only report. Ships clean.**

## Critical (BLOCKS merge)

None.

## Should-fix (before deploy)

None.

## Nits / confirmations (non-blocking)

- **`::numeric` cast on a caller-controlled value raises, does not silently
  zero — good, and worth keeping.**
  `20260702000000_...sql:229` casts `(p_on_hand ->> ii.id::text)::numeric`. A
  non-numeric value (e.g. `{"<id>":"'; drop"}`) raises `22P02` (invalid text
  representation), which PostgREST surfaces as an error and the FE `.catch`
  degrades on (par badges only, no toast — `InventoryCountSection.tsx:404-409`).
  This is the desired "clean error, not a silent 0" behavior the design called
  for (design §"Error cases"). Note the value is never concatenated into SQL —
  it is a bound `jsonb` argument parsed by `->>`, so there is **no SQLi
  surface** even for a hostile value. Confirmed, not a finding.

- **`_warnings` is hard-coded `'[]'::jsonb`** (`:462`) — reserved, carries no
  data. No leak.

## Detailed findings against the requested focus areas

### 1. AuthZ — the `auth_can_see_store(p_store_id)` gate cannot be bypassed

**PASS.** The gate is the **first executable statement** after `begin`
(`20260702000000_...sql:91-94`), before the empty-map fast path and before any
CTE / table read:

```sql
if not public.auth_can_see_store(p_store_id) then
  raise exception 'Not authorized for store %', p_store_id using errcode = '42501';
end if;
```

- **Byte-identical to the engine** (`...multi_vendor.sql:85-88`) — same helper,
  same errcode, same ordering.
- The function is **`security invoker`** (`:78`) + `set search_path = public`
  (`:79`), so every table read below the gate executes under the **caller's own
  RLS context**. Even if the gate were somehow skipped, RLS on
  `inventory_items` / `item_vendors` / `order_schedule` / `pos_imports` would
  still scope reads to stores the caller can see. The gate is the primary
  control; RLS is defense-in-depth. Both point the same way.
- `auth_can_see_store` itself is `security definer`
  (`20260517040000_...sql:88-108`) — **correct and not a bypass**: it must read
  `user_stores` / `stores` / `brands` regardless of caller RLS to evaluate
  visibility, and it returns only a boolean (super_admin OR admin-in-brand OR
  `user_stores` membership). It grants no data access; it answers a yes/no.
- **A caller cannot read another store's reorder data by passing a foreign
  `p_store_id`.** If they pass a store they can't see, `auth_can_see_store`
  returns false → `42501` before any row is touched. This is the store the
  COUNT belongs to (`detail.storeId`, passed as `row.storeId` at
  `InventoryCountSection.tsx:400`).

**pgTAP assertion is real.** `report_reorder_for_counted_onhand.test.sql:269-277`
uses `throws_ok(..., '42501', ...)` under a **plain user JWT** (manager, seeded
member of Towson+Frederick only) calling for **Charles** (a store they are not a
member of). The JWT context is set via `request.jwt.claims` with
`app_metadata.role = 'user'` (`:259-267`), so this is a genuine non-privileged,
non-member caller — not a master/admin who would pass the gate. The assertion
pins the exact SQLSTATE the gate raises. `plan(9)` matches the 9 assertion calls
present (verified). This is not a hollow assertion.

### 2. Grants — ACL is byte-identical to `report_reorder_list`, not broadened to anon

**PASS.** `20260702000000_...sql:478-481`:

```sql
revoke execute on function public.report_reorder_for_counted_onhand(uuid, jsonb, jsonb)
  from public, anon;
grant  execute on function public.report_reorder_for_counted_onhand(uuid, jsonb, jsonb)
  to authenticated;
```

Compared against the engine's original grant block
(`20260514130000_report_reorder_list.sql:606-609`): **identical shape** —
`revoke ... from public, anon` then `grant ... to authenticated`. The
`revoke ... from public` is present and correct (authenticated/anon inherit the
PUBLIC EXECUTE default; a bare `revoke from anon` would leave it callable via
PUBLIC — the migration comment at `:475-477` calls this out explicitly). **anon
cannot execute this RPC.** The customer PWA (the most-exposed sibling, which
uses `verify_jwt = false` service-token paths) has no authenticated JWT for this
project's admin surface and cannot reach this function. Not broadened.

### 3. `p_on_hand jsonb` input — no SQLi, no cross-store leak

**PASS on both.**

- **No SQL injection surface.** `p_on_hand` is a bound `jsonb` parameter. Its
  keys/values are consumed via `p_on_hand ? ii.id::text` (`:234`, key-existence
  operator) and `(p_on_hand ->> ii.id::text)::numeric` (`:229`, extract +
  cast). **Nothing from the map is ever string-concatenated into a query** —
  there is no `EXECUTE`, no `format(... %s ...)` on map contents, no dynamic
  SQL anywhere in the function body. Hostile keys or values cannot alter the
  query; a hostile value at worst fails the `::numeric` cast (`22P02`, clean
  error).

- **Arbitrary item_ids cannot leak cross-store data.** The `item_on_hand` CTE
  (`:221-235`) drives from `public.inventory_items ii` filtered
  `where ii.store_id = p_store_id`, and only THEN checks
  `p_on_hand ? ii.id::text`. The supplied map is a **filter on the store's own
  items, not a driver**. An `item_id` belonging to a different store never
  matches any `ii.id` where `ii.store_id = p_store_id`, so it produces **no
  row** — no reorder data, no par level, no on-hand echo. Supplying thousands of
  foreign/garbage ids yields at most an empty `items[]`. The
  `join item_vendors iv on iv.item_id = ii.id` further constrains to the store's
  own item→vendor links. The store gate (already passed) + this store-scoped
  join is a belt-and-suspenders scope. Confirmed against the design's claimed
  "store gate + item→store join scopes it."

- **`on_hand` echo is the caller's own supplied value** (`:229`), not a stored
  secret — echoing back what the caller sent leaks nothing.

### 4. `search_path`, cost/PII exposure

**PASS.**

- **`set search_path = public`** is pinned on the function (`:79`), matching the
  engine (`...multi_vendor.sql:73`). No search-path hijack surface (all object
  references are `public.`-qualified anyway).
- **No cost / `$` fields in the output.** Grepped the executable SQL: `cost` /
  `estimated` / `price` / `vendor_total` appear **only in explanatory
  comments**, never in a `jsonb_build_object` output key. The Delta-1
  `item_on_hand` CTE drops `cost_per_unit` from the copied engine body; the
  output envelope (`:435-452`) contains only quantity/par/timing/flag fields.
  This is a deliberate omission (spec 105 out-of-scope; keeps spec 104's
  per-each cost basis disengaged). The `case_price` token in the pgTAP is a
  test-fixture `item_vendors` INSERT column, not RPC output.
- **No PII.** Output is `item_id` (uuid), numeric quantities, dates, boolean
  flags, and a token-vocabulary `flags[]` array (`no_par` / `no_usage_rate` /
  `truncated`). No names, no emails, no user identifiers. The item name is
  deliberately NOT in the payload (design §4k: FE renders its own already-joined
  name from the Zustand inventory array). Nothing sensitive crosses the wire.
- **Error messages are safe.** The only raised exception is
  `'Not authorized for store %'` with the store uuid — no SQL fragment, no
  stack, no row data. The `raise notice` at `:147-148` (depth-cap) prints a
  count, not data, and notices don't reach the client anyway.

### 5. Frontend — read-only, degrades cleanly, no error leak

**PASS.**

- The companion fetch (`InventoryCountSection.tsx:388-417`) fires **after** the
  detail resolves, builds the on-hand map from ONLY below-par/resolvable/
  non-null rows via the pure `buildCountedOnHandMap`
  (`countHistoryPar.ts:71-84`), and short-circuits when the map is empty
  (`:399`) — the RPC is never called with an empty payload from the FE.
- **Read-only degradation is correct.** On RPC failure the `.catch`
  (`:404-409`) does `console.warn` + `setReorderByItem({})` — **no
  `notifyBackendError`, no toast**, and the par ✓/red badges (pure client-side
  off `inventory` + `actualRemaining`) still render. A failed read cannot
  toast-spam or block the badges. The `console.warn` logs `e?.message` only —
  not the RPC payload, not a token. No secret/PII in the log line.
- The `db.ts` fetcher (`db.ts:3271-3323`) routes through the tracked inflight
  chain (`kind: 'read'`), calls `supabase.rpc(...)` with bound params
  (`p_store_id` / `p_on_hand` / `p_params`), re-throws the error for the
  caller's `.catch` (does not swallow), and the mapper drops any cost keys
  (there are none to drop) — `CountedReorderItem` is a cost-free type. No
  `EXPO_PUBLIC_*` secret, no service-role key, no raw `fetch`. Store id is the
  count's own `row.storeId` (`:400`) — the FE cannot smuggle a foreign store id
  here without the server gate rejecting it.
- `todayIso` (`:81-84`) is a pure local-date formatter — no data, no leak.
- The client `useRole()` placeholder is **not** used as a security boundary
  anywhere in this change — the boundary is the server-side
  `auth_can_see_store` gate. (Not a finding; called out per the audit checklist
  to confirm the placeholder wasn't leaned on.)

## Not applicable to this spec

- **Edge functions / `verify_jwt` / service-token / `escapeHtml` / last-of-role
  / self-guard** — N/A. No edge function is added or modified (design
  §"API contract decision"). This is a Postgres RPC via PostgREST, JWT-protected
  by default, gated in-SQL.
- **New tables / RLS policies** — N/A. Additive `create function` only; no
  table, column, index, or policy change (design §"Data model changes").
  The spec 053 permissive-policy lint is not engaged (no new policy).
- **Realtime publication** — N/A. No publication membership change.
- **`ADMIN_ROLES` / `super_admin` role-band** — N/A. The gate is
  `auth_can_see_store()` (per-store), correctly NOT `auth_is_admin()` — managers
  view their own store's history. `auth_can_see_store` already grants
  super_admin all stores (`20260517040000_...sql:92`), so super_admins are not
  silently denied.

## Dependencies

No `package.json` changes in spec 105 (last touch was spec 089, unrelated) —
`npm audit` skipped per process.
