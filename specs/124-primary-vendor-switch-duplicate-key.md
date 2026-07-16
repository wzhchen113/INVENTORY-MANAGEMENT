# Spec 124: Primary-vendor switch fails with duplicate-key on multi-vendor ingredient

Status: READY_FOR_REVIEW

## User story
As a store manager editing a multi-vendor ingredient, I want to change which
vendor is the primary and save, so that the item is supplied by the vendor I
picked — without hitting a duplicate-key error that silently discards the
switch.

## Bug summary (confirmed with evidence)
Saving a multi-vendor ingredient while switching which vendor is primary fails
with the toast:

`Update item failed — duplicate key value violates unique constraint "item_vendors_one_primary_per_item"`

Repro (from a user screen recording): ingredient `Tortilla 10"` has two
vendors, SAMS CLUB (currently primary) + US FOOD. Manager makes US FOOD the
primary and saves → the error fires and the switch does NOT persist (item still
shows "supplied by SAMS CLUB").

## Root cause
- `item_vendors` has a PARTIAL UNIQUE index
  `item_vendors_one_primary_per_item ON (item_id) WHERE is_primary` — at most
  one primary vendor per item (confirmed in prod). This constraint is CORRECT.
- The per-store save path `db.updateInventoryItem` reconciles vendor links with
  a SINGLE batch upsert ([src/lib/db.ts:495-510](src/lib/db.ts:495)) that sets
  `is_primary` per row but NEVER demotes the old primary first. When the new
  primary (US FOOD) row is upserted with `is_primary=true` while the old
  primary (SAMS CLUB) still has `is_primary=true`, the partial unique index is
  transiently violated within the statement → duplicate-key error → the whole
  write rolls back.
- The brand-wide RPC `apply_item_vendors_to_brand` (spec 119) already handles
  this: it runs an UPDATE demoting any existing primary that isn't the new one
  BEFORE the upsert
  ([supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql](supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql)).
  The single-store client path lacks that pre-step.

## Acceptance criteria
- [ ] Switching the primary on a 2-vendor item (old primary A → new primary B)
      saves with no error toast; after reload item is "supplied by" B.
- [ ] After the switch, exactly one `item_vendors` row for the item has
      `is_primary=true` (the new primary B), and the old primary A row has
      `is_primary=false` — verified by a DB read, not just the UI.
- [ ] The legacy scalar `inventory_items.vendor_id` mirrors the new primary
      after save (SD-1 invariant preserved).
- [ ] `primaryVendorId = null` case (no primary selected) demotes ALL existing
      primaries for the item and leaves zero `item_vendors` rows with
      `is_primary=true`; no duplicate-key error.
- [ ] Par / cost / case-price / order-code edits submitted in the same save
      still persist correctly (no regression to the existing upsert).
- [ ] Single-vendor saves and no-primary-change saves are unaffected (same
      resulting rows as before this fix).
- [ ] Removing a vendor (de-selected link) still deletes that link (existing
      AC-C behavior from spec 102 preserved).
- [ ] Test track named per the "Tests" note below; the primary-switch case is
      covered.

## In scope
- Fix the write-path ordering in `db.updateInventoryItem`
  ([src/lib/db.ts:475-519](src/lib/db.ts:475)) so any existing primary that is
  not the newly-selected primary is demoted BEFORE the upsert marks the new one
  `is_primary=true` — mirroring the spec-119 RPC's demote-first step.
- Correctly handle `primaryVendorId = null`: demote all existing primaries for
  the item (no row left `is_primary=true`).
- Preserve the existing `primaryVendorId` fallback logic for vendors-only /
  cost-only edits (the `updates.vendorId === undefined` branch at
  [src/lib/db.ts:485-493](src/lib/db.ts:485)).
- Note in the design whether `createInventoryItem` (and any other client path
  writing `item_vendors.is_primary`) can hit the same ordering issue. Create
  starts with no existing rows, so it is expected to be safe — but the spec
  requires the architect/dev to confirm and state it explicitly rather than
  assume.

## Out of scope (explicitly)
- Changing or dropping the `item_vendors_one_primary_per_item` partial unique
  index. The constraint is correct; the bug is write-path ordering. — rationale:
  the invariant "one primary per item" is exactly what we want to keep.
- The brand-wide RPC `apply_item_vendors_to_brand` — already correct (spec 119),
  no change.
- Any UI/UX change to the vendor picker or primary selector. This is a
  data-write fix; the editor behavior is unchanged.
- Retroactive cleanup of any items currently in a bad `is_primary` state (none
  known — the failing save rolls back, so no partial state is written). If a
  data-repair pass is wanted, it is a separate spec.
- Broader migration of the staff subtree or `item_vendors` reconcile refactor
  beyond this fix.

## Open questions resolved
- (No user-facing open questions — this is a confirmed bug with a diagnosed
  root cause and evidence.) The one design-level decision below is delegated to
  the architect, not the user.

## Open question for the architect (flag, do not pre-decide)
The current client reconcile is TWO sequential PostgREST calls (upsert +
delete). Adding a demote makes THREE non-atomic calls — a mid-sequence failure
could transiently leave the item with zero primaries (reconciled by
optimistic-revert + realtime, but not transactionally atomic). Two options:

1. **Client-side pre-demote (minimal).** Add a demote UPDATE before the upsert
   in `db.ts`. Matches the existing 2-call non-atomic risk profile, smallest
   change, ships fast.
2. **SECURITY DEFINER RPC (atomic).** Move the whole `item_vendors` reconcile
   for the single-store path into a small RPC, transactionally correct like the
   spec-119 path. Bigger change, but no transient zero-primary window.

PM recommendation: option 1 (minimal client-side pre-demote) for v1 — it fixes
the reported bug with the least surface area and does not worsen the existing
non-atomic profile. Architect to rule and record the decision in the design.

## Dependencies
- [src/lib/db.ts](src/lib/db.ts) — `updateInventoryItem` (fix site);
  `createInventoryItem` (confirm-safe note).
- [supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql](supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql)
  — reference for the correct demote-first ordering (spec 119).
- Prod partial unique index `item_vendors_one_primary_per_item` (unchanged;
  behavioral dependency).
- If the architect chooses the RPC option: a new migration + prod apply path.

## Project-specific notes
- Cmd UI section / legacy: admin Cmd UI, ingredient/inventory editor under
  `src/screens/cmd/sections/` (write path only; no UI change).
- Per-store or admin-global: per-store save path (`updateInventoryItem` writes
  ONLY the current store's item, respecting `auth_can_see_store()`). The
  brand-wide fan-out is a separate, already-correct path.
- Realtime channels touched: `store-{id}` (item_vendors change reloads via the
  debounced sync). No new channel. Optimistic-revert + realtime are what
  currently mask the non-atomic window — call out as a risk if option 1 is
  chosen.
- Migrations needed: NO for option 1 (client-side fix). YES if the architect
  chooses the RPC option.
- Edge functions touched: none.
- Web/native scope: both (shared `db.ts` path; no platform-specific code).
- Tests: this is a behavior change to a DB write path. Primary track is the
  shell/DB smoke or pgTAP that exercises `item_vendors` state after a
  primary-switch save; a jest unit around the `db.ts` reconcile ordering is
  also in-bounds. Architect/test-engineer to name the exact track — the
  duplicate-key repro and the `primaryVendorId=null` case must both be covered.

## Backend design

### Decision: Option 1 (minimal client-side pre-demote). No RPC, no migration.

I rule for the PM's recommendation. Reasoning, weighed explicitly:

- **The reconcile is already non-atomic.** Today's path (`db.ts:495-518`) is
  two sequential PostgREST calls — an upsert then a delete — with no
  transaction wrapping them. Adding a third (the demote) does not introduce a
  new *class* of risk; it widens an already-open window by one call. The bug is
  a *within-statement* constraint violation (the multi-row upsert transiently
  holds two `is_primary=true` rows), and a single extra UPDATE issued *before*
  the upsert removes that violation entirely. That is the whole fix.
- **The codebase already solved this exact problem the exact same way.** The
  spec-119 RPC `apply_item_vendors_to_brand`
  ([supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql:116-124](supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql))
  runs `update item_vendors set is_primary = false where item_id = … and
  is_primary and (p_primary_vendor_id is null or vendor_id <> p_primary_vendor_id)`
  BEFORE its upsert. Its own comment says it "Mirrors updateInventoryItem's
  proven ordering" — that comment is currently *aspirational*; this spec makes
  it literally true. Reusing the established demote-first ordering is the
  reuse-existing-patterns rule applied directly.
- **Optimistic-then-revert + realtime already mask partial states.** The Cmd
  editor applies the change optimistically and reverts on `notifyBackendError`;
  the `store-{id}` realtime channel reloads `item_vendors` after any write
  (item_vendors joined the `supabase_realtime` publication in spec 102). A
  transient mid-sequence state is never authoritative in the UI. Promoting this
  one write path to a SECURITY DEFINER RPC would buy true atomicity but at the
  cost of a new prod-apply migration, a new RLS-bypassing surface to audit, and
  divergence from the sibling create path — disproportionate to a
  three-call-window that the existing two-call window already tolerates.

Rejecting Option 2 (RPC) for v1. If a future spec wants transactional
guarantees for the whole single-store reconcile, it should fold BOTH the update
and create paths into one shared RPC rather than doing it piecemeal here.

### Data model changes

**None.** No schema change, no new table/column/index, **no migration.** The
partial unique index `item_vendors_one_primary_per_item ON (item_id) WHERE
is_primary` stays exactly as-is — it is the correct invariant and this fix
makes the client honor it. The `db-migrations-applied.yml` gate is unaffected
(nothing added to `supabase/migrations/`).

### RLS impact

**None.** No new table, no policy change. The demote UPDATE runs as the
authenticated caller through PostgREST against `item_vendors`, gated by the
existing per-store policies that already govern the upsert/delete on the same
table in this same block (`auth_can_see_store(store_id)` via the item's store).
No new access path is opened.

### API contract

PostgREST, not RPC — consistent with the existing reconcile in this block. One
additional statement inserted before the upsert:

`UPDATE item_vendors SET is_primary = false WHERE item_id = :id AND is_primary = true [AND vendor_id <> :primaryVendorId]`

- **Request shape (supabase-js):**
  ```
  let demote = supabase.from('item_vendors')
    .update({ is_primary: false })
    .eq('item_id', id)
    .eq('is_primary', true);
  if (primaryVendorId) demote = demote.neq('vendor_id', primaryVendorId);
  const demoteRes = await demote.abortSignal(signal);
  if (demoteRes.error) throw demoteRes.error;
  ```
- **Response:** standard PostgREST update envelope; only `error` is inspected
  (thrown to the `track()` wrapper on failure, surfaced via `notifyBackendError`
  optimistic-revert). No rows are read back.
- **`primaryVendorId = null` case:** the `.neq('vendor_id', …)` filter is
  OMITTED, so the statement demotes ALL primaries for the item → zero rows left
  `is_primary=true` after the subsequent upsert marks every link
  `is_primary = (v.vendorId === null)` = false. Satisfies AC "primaryVendorId =
  null demotes all primaries."
- **Error cases:** demote error → thrown, whole save reverts (same failure
  handling as the existing upsert/delete). Idempotent: a save with no primary
  change demotes nothing that shouldn't be demoted (the new primary is excluded
  by `.neq`; any already-`false` rows are untouched).

Do NOT set `updated_at` in the client `.update({...})` payload. The existing
client upsert (`db.ts:496-508`) does not set `updated_at` either — the column
is maintained by the table's trigger/default. Setting it here would diverge
from the sibling client writes on this table. (The spec-119 RPC sets
`updated_at = now()` explicitly because it is a SECURITY DEFINER server path
that also mirrors the scalar; the client path leaves it to the DB.)

### Exact placement and ordering in `src/lib/db.ts`

Inside the `if (updates.vendors !== undefined)` block (db.ts:475-519), after
`primaryVendorId` is resolved (db.ts:485-493) and INSIDE the
`if (updates.vendors.length > 0)` guard (db.ts:495), immediately BEFORE the
`item_vendors` upsert. Rationale for gating on `length > 0`: when
`updates.vendors` is `[]` (remove-all), the existing delete at db.ts:513-518
removes every link including all primaries, so a pre-demote would be redundant.
The demote only matters when an upsert is about to run.

Confirmed final ordering within the block:

1. **demote old primary** — `UPDATE … set is_primary=false` (new step)
2. **upsert links** — existing db.ts:496-508 (marks new primary `is_primary=true`)
3. **delete de-selected** — existing db.ts:513-518
4. **mirror legacy scalar** — already handled: `perStore.vendor_id = vendorId`
   is written by the earlier `inventory_items` UPDATE at db.ts:457-464 when
   `updates.vendorId` is present (SD-1 mirror preserved; no change needed here).

This matches the spec-119 RPC's demote → upsert → delete → mirror-scalar order.

### createInventoryItem — confirmed SAFE, no change

`createInventoryItem` (db.ts:288-382) cannot hit this ordering bug:

- It starts from a brand-new item row created by the
  `create_inventory_item_with_catalog` RPC (db.ts:315), so there are **zero
  pre-existing `item_vendors` rows** for `data.id` — nothing to demote, no old
  primary to collide with.
- Its link upsert (db.ts:363-379) marks `is_primary = l.vendorId === vendorId`
  against the single scalar `vendorId`. Because `vendorId` is one value, **at
  most one** synthesized/submitted link can match → at most one
  `is_primary=true` row. The partial unique index cannot be violated.

No other client path writes `item_vendors.is_primary` besides these two and the
spec-119 RPC (already correct). Confirmed explicitly per In-scope §4.

### Edge function changes

**None.** No edge function touches this path.

### `src/lib/db.ts` surface

No new exported helper and no signature change. `updateInventoryItem(id,
updates, …)` keeps its shape; the fix is an internal added statement.
snake_case ↔ camelCase mapping is unchanged (the demote writes the literal
column `is_primary` and filters on `item_id` / `vendor_id`, matching the
adjacent upsert). The frontend calls the same `db.updateInventoryItem` it
already calls from the Cmd inventory editor — no caller changes.

### Realtime impact

`store-{id}` channel replays the `item_vendors` change (already in the
`supabase_realtime` publication since spec 102 — `20260630000000_item_vendors.sql`).
**Publication gotcha does NOT apply:** this spec adds no migration and changes
NO publication membership, so the `docker restart
supabase_realtime_imr-inventory` ritual is not needed. The debounced 400 ms
reload in `useRealtimeSync.ts` reconciles other admin clients as it does today.

### Frontend store impact

The Cmd inventory editor slice of `src/store/useStore.ts` that calls
`db.updateInventoryItem` is UNCHANGED. The optimistic-then-revert pattern
(with `notifyBackendError`) continues to apply: the store applies the primary
switch optimistically; if any of the three PostgREST calls throws, the write
reverts and toasts. This fix's benefit is that the *happy path* no longer
throws on a primary switch, so the optimistic state now sticks instead of
reverting (which is the observed bug — the switch silently discarded).

### Risks and tradeoffs (explicit)

- **Non-atomic 3-call window (acknowledged, accepted).** The reconcile becomes
  demote → upsert → delete: three PostgREST calls without a wrapping
  transaction. A failure BETWEEN demote and upsert would transiently leave the
  item with zero primaries (old primary demoted, new one not yet upserted).
  This is reconciled by optimistic-revert (the store reverts to the
  pre-save state on the thrown error) and by the `store-{id}` realtime reload,
  neither of which treats the transient DB state as authoritative. This does
  NOT worsen the existing risk profile — today's upsert→delete is already
  non-atomic and a failure between them already leaves a partial state. Accepted
  for v1 per the Option-1 decision; the escape hatch if it ever bites is the
  Option-2 RPC.
- **Migration ordering:** N/A — no migration.
- **RLS gaps:** none — no new access surface; demote runs under the same
  per-store policies as the sibling upsert/delete.
- **Performance on the 286 KB seed:** negligible. One extra indexed UPDATE
  (`item_id` predicate, backed by the composite unique / item_id index) touching
  at most the item's handful of vendor links. No new cold-start (no edge fn).
- **Contract-drift watch:** ensure the demote is placed INSIDE
  `if (updates.vendors.length > 0)` and BEFORE the upsert. Placing it after the
  upsert (or outside the length guard) reintroduces the bug or needlessly
  demotes on remove-all.

### Test surface (named track)

This is a **client-ordering fix over PostgREST — NOT a migration** (state this
plainly so no one looks for a `.sql`). Two tracks:

1. **Primary track — jest unit (ordering assertion).** In the jest DB-mock
   suite, mock `supabase.from('item_vendors')` and assert that on a
   primary-switch save (item with vendors A[primary], B; `updates.vendorId = B`,
   `updates.vendors = [A, B]`) the `.update({ is_primary: false })` demote call
   is issued **before** the `.upsert(...)` call, and that the demote filters on
   `item_id`, `is_primary=true`, and `vendor_id <> B` (`.neq('vendor_id', B)`).
   Add the `primaryVendorId = null` variant: assert the demote is issued WITHOUT
   the `.neq` filter (demote-all). This is the regression lock for the fix's
   core behavior and does not require a live DB.
2. **Optional confirmation — pgTAP / shell DB smoke (end-state).** Against the
   local stack, drive a primary switch through the real write path and assert
   the DB end-state has exactly one `item_vendors` row with `is_primary=true`
   for the item (the new primary), the old primary is `false`, and
   `inventory_items.vendor_id` mirrors the new primary (SD-1). Add the
   `primaryVendorId=null` case: zero `is_primary=true` rows, no duplicate-key
   error. This is the acceptance-criteria proof by DB read (AC-2, AC-3, AC-4).

The jest ordering test is the must-have (fast, deterministic, pins the exact
bug); the pgTAP/shell end-state check is the belt-and-suspenders the PM note
called for. test-engineer to confirm final placement in the existing jest DB
suite and the shell/pgTAP runner (`scripts/test-db.sh`).

## Handoff
next_agent: backend-developer
prompt: Implement the client-side pre-demote in `db.updateInventoryItem`
  (src/lib/db.ts) exactly per the Backend design above — one
  `UPDATE item_vendors SET is_primary=false` issued INSIDE the
  `if (updates.vendors.length > 0)` guard, BEFORE the existing upsert, filtering
  `item_id=id AND is_primary=true` and adding `.neq('vendor_id', primaryVendorId)`
  only when `primaryVendorId` is non-null; thread `.abortSignal(signal)`; throw
  on error. Do NOT set `updated_at`. No migration, no RPC, no edge function,
  no createInventoryItem change (confirmed safe). Add the jest ordering test
  (demote-before-upsert, plus the primaryVendorId=null demote-all variant); the
  pgTAP/shell end-state check is optional per the Test surface. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/124-primary-vendor-switch-duplicate-key.md

## Files changed

### src/lib/db.ts
- `updateInventoryItem` — added the Spec 124 pre-demote `UPDATE item_vendors SET
  is_primary=false` INSIDE the `if (updates.vendors.length > 0)` guard, BEFORE
  the existing upsert. Filters `item_id=id AND is_primary=true`, and adds
  `.neq('vendor_id', primaryVendorId)` only when `primaryVendorId` is non-null
  (null → demote ALL primaries). Threads `.abortSignal(signal)`, throws on error.
  No `updated_at` in the payload. Final ordering: demote → upsert → delete.
  `createInventoryItem` unchanged (confirmed safe).

### tests (jest)
- `src/lib/db.updateInventoryItemPrimarySwitch.test.ts` — NEW. Mocks
  `supabase.from(...)` and records call order. Asserts: demote-before-upsert on a
  primary switch; demote filters `item_id` / `is_primary=true` / `vendor_id <> B`;
  no `updated_at` in the demote payload; the `primaryVendorId=null` variant
  demotes all primaries WITHOUT a `.neq`; demote error is thrown (optimistic-revert
  contract).
