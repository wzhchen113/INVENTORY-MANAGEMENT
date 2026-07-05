# Backend-architect post-implementation drift review — spec 115

Reviewer: backend-architect (post-impl mode)
Spec: `specs/115-quick-order-usability.md` (Status: READY_FOR_REVIEW)
Verdict: **WITHIN DESIGN.** No Critical, no Should-fix, no Minor drift. Every
design decision landed as written, including the two overturned FLAGGED premises
(OQ-3 publication, OQ-4 UPDATE RLS) and the #1 flagged drift check (the W-1
reconcile-delete data-loss trap).

Scope of this review: architectural/contract drift only. Code quality, i18n
completeness, and coverage sufficiency are other reviewers' fan-out. The
pre-existing POSImportsSection render loop that main Claude found (byte-identical
at 806c6d9) is explicitly NOT attributed to 115 and is not evaluated here.

---

## Design-decision checklist (7 checks requested)

### 1. Migration — WITHIN DESIGN

`supabase/migrations/20260709000000_vendor_order_unit.sql` matches the §1 contract
exactly:

- Additive `add column if not exists order_unit text not null default 'case'
  check (order_unit in ('case','unit'))` — the OQ-5 shape, verbatim (`:107-109`).
- Filename `20260709000000_*` sorts immediately after `20260708000000_item_vendor_
  order_code.sql`, one-migration-per-day cadence preserved.
- **NO policy hunk** — the OQ-4 ruling ("privileged_update_vendors inherited,
  column-agnostic; no new policy") is honored. The file carries no `create policy`.
- **NO publication hunk** — the OQ-3 ruling ("vendors already in supabase_realtime
  since 20260514140000; no membership change") is honored. No `alter publication`.
- The **stale-comment correction** is carried into the migration header
  (`:48-59`): it names `20260517010000_vendors_master_role_fix.sql`'s "UPDATE has
  no policies / intentionally denied" as stale documentation, and points at the
  applied `privileged_update_vendors` (20260509000000:586) as the true gate. The
  header also explicitly flags the docker-restart gotcha as a **deliberate absence**
  (`:74-81`) — the exact "same as spec-114 order_code" framing the design pinned.
- **DDL prod-apply note** present (`:83-101`): execute_sql the alter+comment,
  INSERT version `20260709000000` into `schema_migrations`, verify by COLUMN
  PRESENCE (not body-md5 — correctly notes there is no function here), developer
  flags but does not push. Matches §11.
- `comment on column` (`:111-119`) documents the conversion semantics + RLS
  inheritance + no-backfill, as designed.

No delta.

### 2. The W-1 reconcile trap (the #1 flagged drift check) — WITHIN DESIGN. Closed.

This was the undisclosed data-loss trap in §0/§3 and the design's own #1 post-impl
check. Both halves verified:

**(a) The CSV write resends the FULL existing link set with only the target
orderCode changed.** `src/lib/csvImport.ts` `buildOrderCodeVendorsPayload`
(`:193-214`) maps every existing link to `{ vendorId, costPerUnit (PRESERVED),
casePrice (PRESERVED), orderCode: l.vendorId === resolvedVendorId ? code :
l.orderCode }`, and appends a new non-primary `{ resolvedVendorId, 0, 0, code }`
only when the vendor isn't already linked. `commitImport`'s UPDATE branch
(`:465-482`) calls it with `item?.vendors ?? []` (the item's real hydrated link
set from the `inventory` slice via `CommitContext`), NOT a code-only array. The
blank-cell path omits the `vendors` key entirely (`:479-481`, `...(vendors ? {
vendors } : {})`) → db.ts leaves the link set untouched (AC-4 no-op). This is the
mandatory merge-onto-existing-links rule from §3, implemented precisely.

**(b) `updateInventoryItem`'s full-reconcile semantics (db.ts:474-517) were NOT
altered.** Confirmed byte-identical to the spec-114 baseline: the upsert still
writes `cost_per_unit: v.costPerUnit ?? 0` / `case_price: v.casePrice ?? 0`
(`:499-500`) and the delete-not-in-submitted-set still runs (`:510-517`,
`.not('vendor_id', 'in', ...)`). The reconcile is exactly the mechanism the §0
trap analysis depended on — because csvImport now feeds it the full set, the
reconcile deletes nothing and zeroes nothing for an untouched link. The guard
holds by construction, not by luck.

Additional correctness the design called for and that landed:

- The **`skip('no changes')`-with-a-new-code promotion** (§3, the "must NOT be
  dropped" edge) is implemented in `computeDiff` (`:327-345`): a resolvable code
  whose value differs from the existing link's code promotes the row from
  `skip('no changes')` to an `update` op with an empty item-field payload; an
  equal code stays a true no-op; an unresolvable code stays a skip and is REPORTED
  at commit (`:488-498`). This was flagged as a skip-vs-drop risk (§10) and is
  handled.
- `resolveVendorForCode` (`:161-176`) implements the AC-2 fail-safe: present name
  → case-insensitive `norm()` match → matched vendor, else `unmatched_vendor` skip
  (NEVER falls back to primary — OQ-2); blank name → primary; no primary →
  `no_vendor` skip. A CSV cell never creates a vendor.
- `CommitResult` gains the three AC-5/6 fields (`codesWritten`, `linksCreated`,
  `codeRowsSkipped[]`) with the reasoned-skip shape from §3 (`:385-398`).

No delta.

### 3. db.ts order_unit threading + Vendor.orderUnit shape — WITHIN DESIGN

- `fetchVendors` mapper: `orderUnit: v.order_unit ?? 'case'` (`db.ts:1805`) — the
  defensive `?? 'case'` guard from §5.
- `createVendor` INSERT: `order_unit: vendor.orderUnit ?? 'case'` — unconditional,
  NOT spread-guarded (`db.ts:1823`), exactly as §5 specified (NOT NULL, value
  always in hand).
- `updateVendor` dbUpdates: `if (updates.orderUnit !== undefined)
  dbUpdates.order_unit = updates.orderUnit;` (`db.ts:2949`) — omit-key-to-skip.
  The comment confirms it does NOT touch the pre-existing deliveryDays/categories
  drop (the §0 pre-existing bug stays out of scope, as ruled).
- `Vendor.orderUnit: 'case' | 'unit'` (`src/types/index.ts:462`) — non-optional,
  matching the NOT NULL column and keeping the segmented-control value type total.

snake_case `order_unit` ↔ camelCase `orderUnit` mapping correct in all three
directions. No delta.

### 4. Builder conversion (OQ-6 contract; shared by PO + Reorder) — WITHIN DESIGN

`src/utils/poQuickOrderText.ts`:

- 4th positional param `orderUnit: 'case' | 'unit'` after `resolveName`
  (`:125-130`) — the stable-call-order signature from §6.
- Conversion (`:139-151`): `const cq = line.caseQty && line.caseQty > 0 ?
  line.caseQty : 1` (coalesce, never /0); `exact = orderedQty / cq`; `emitQty =
  Math.ceil(exact)`; `if (emitQty !== exact) roundedCount += 1`. `'unit'` →
  `orderedQty` verbatim. This is AC-11/AC-12 and OQ-6 to the character.
- `PoQuickOrderResult.roundedCount` added (`:85`), sibling to `unmappedCount`; the
  fail-loud signal is EXCLUSIVELY the count — no inline `(rounded from X.Y)`
  sentinel in the block (§6 ruling). The `??? ` unmapped path also carries the
  converted qty (`:157-161`), as designed.
- `formatQty` on a `Math.ceil` integer returns a bare whole-number string
  (`reorderExport.ts:31`, `Number.isInteger` → `String`) — the machine block stays
  clean, no `.0`. AC-14 byte-for-byte pin holds.

**Shared by BOTH paths, byte-for-byte (the spec flag "do NOT fork a second
builder"):**
- PO path `POsSection.onShareQuickOrder` (`:277-284`) passes
  `caseQty: l.caseQty` per line + `orderUnit = selVendor?.orderUnit ?? 'case'` as
  the 4th arg; fires the rounded-count warning.
- Reorder path `ReorderQuickOrderButton.onShareQuickOrder`
  (`ReorderSection.tsx:284-294`) passes `caseQty: it.caseQty` +
  `orderedQty: it.suggestedUnits` (AC-16) + `orderUnit = vendors.find(...
  ).orderUnit ?? 'case'`; resolves the code from the hydrated `inventory` rows
  (not `ReorderItem`); pre-PO (no mark-sent). Same builder call shape.

No delta.

### 5. W-5 memo keys on item.vendors[] (the design's correction) — WITHIN DESIGN

`VendorsSection.tsx` `missingCodeCount` (`:96-103`) filters
`inventory.filter(i => i.storeId === currentStore.id && (i.vendors ?? []).some(v
=> v.vendorId === sel.id && !(v.orderCode ?? '').trim()))`. This is the LINK-scoped
`item.vendors[]` count from §8 — NOT the scalar `i.vendorId === sel.id` the
existing `catalog` memo uses (which would UNDER-count secondary links). It is a
SEPARATE memo, not a reuse of `catalog`, exactly as the design mandated. Rendered
as a 5th detail-pane StatCard (`:362`, `section.vendors.missingCodes` /
`missingCodesSub`). No delta.

### 6. pgTAP proves privileged-gated / non-privileged-denied on order_unit — WITHIN DESIGN

`supabase/tests/vendors_role_access.test.sql` extends the existing file to
`plan(11)` and adds the OQ-4 honesty proof:
- (5a/5b/5c) column shape: `column_default = '''case''::text'`, `is_nullable =
  'NO'`, and a seeded row reads `'case'` from the default (AC-8).
- (6) the CHECK rejects `'pallet'` with `23514` (run as superuser so RLS doesn't
  mask the constraint) — asserts the constraint, not a policy.
- (7a/7b) a privileged admin caller CAN UPDATE `order_unit` via
  `privileged_update_vendors`, and the write persisted.
- (8) a non-privileged `user` caller CANNOT — the RLS USING clause filters the row
  to a 0-row update that raises nothing, so the assertion is correctly
  value-unchanged (`order_unit` stays `'unit'` from the privileged write), NOT
  `throws_ok`. This is the exact mechanism §7 pinned and it makes the stale
  `20260517010000` comment honest.

The dedicated test vendor (`99999999-…-9944`) is seeded as the superuser role (RLS
bypass) in the seed brand every seed profile can see, so `auth_can_see_brand` is
satisfied and the case-(8) DENY is driven purely by `auth_is_privileged()` being
false — the isolation the design required. No delta.

### 7. (bonus) Realtime, edge functions, RLS surface — WITHIN DESIGN

- No `alter publication` anywhere in the migration → no docker-restart step, no
  prod publication apply (§7). Correct per the overturned OQ-3.
- No edge function touched (§4). Confirmed — no `supabase/functions/` change in the
  file list.
- No new RLS policy on `vendors`; `order_unit` inherits the four existing policies
  column-agnostically (§2). The spec-053 permissive-policy lint needs no allowlist
  edit (no policy added) — a green lint here is expected, not a skipped test.

---

## Pre-existing issues re-confirmed as OUT of scope (surfaced, not fixed by 115)

These were called out in §0 as pre-existing and explicitly deferred; the
implementation correctly did NOT touch them, so they remain open for a future
vendor-RLS/vendor-editor spec (noting here only so they are not lost):

1. The second INSERT policy `"Vendors admin only"` (20260517010000) lacks the
   `auth_can_see_brand` clause → a privileged brand-A user could INSERT a vendor
   row for brand B via the ORed permissive policy. Cross-brand INSERT gap,
   predates 115.
2. `db.ts updateVendor` still drops `deliveryDays` and `categories` on update
   (they're in `toUpdates()` but not threaded into `dbUpdates`). The `order_unit`
   thread added its own explicit line and did NOT re-introduce or widen this — but
   the pre-existing partial-write remains.

Neither blocks 115. No action required for this spec.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Should-fix | 0 |
| Minor | 0 |

The implementation matches the backend design on every checked decision. The two
FLAGGED forks resolved as the audit ruled (no publication change, no new UPDATE
policy — both proven, not assumed). The #1 data-loss trap is closed: the CSV write
sends the full existing link set and `updateInventoryItem`'s reconcile is
unaltered. The single builder is shared byte-for-byte by both share paths with the
OQ-6 ceil/coalesce/roundedCount contract. W-5 is link-scoped per the correction.
pgTAP proves the privileged/non-privileged posture on `order_unit`.
