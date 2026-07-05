# Backend-architect post-impl drift review — spec 113 (staff receiving price gate)

Reviewer: backend-architect (post-implementation mode)
Verdict: **IN DESIGN — no drift.** 0 Critical, 0 Should-fix, 3 Minor (all
informational; nothing to change).

Scope reviewed against the `## Backend design` I authored in
`specs/113-staff-receiving.md`:

- `supabase/migrations/20260707000000_staff_receiving_price_gate.sql`
- `supabase/tests/staff_receiving_gate.test.sql`
- `src/screens/staff/lib/receiving.ts` (carve-out path check)
- Diff baseline: `supabase/migrations/20260705000000_cost_on_receipt.sql:122-386`
- Confirmed unmodified: `supabase/tests/cost_on_receipt.test.sql` (still `plan(55)`,
  no spec-113 references), `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`
  (`auth_is_privileged()` = `auth_is_admin() OR auth_is_super_admin()`).

---

## 1. Verbatim body + EXACTLY ONE gate hunk at the fixed site — CONFIRMED

I performed an independent line-by-line alignment of the new migration's
`receive_purchase_order` body (`20260707000000:114-393`) against the current latest
definition (`cost_on_receipt.sql:122-386`). Region-by-region result:

| Region | new migration | cost_on_receipt | Result |
|--------|---------------|-----------------|--------|
| Signature + `declare` block (all locals + comments) | 114-144 | 122-152 | Byte-identical |
| Step (1) auth gate (store + vendor_id select, P0002, 42501) | 145-157 | 153-165 | Byte-identical |
| Step (2) idempotency short-circuit (`price_changes:[]` replay) | 159-181 | 167-189 | Byte-identical |
| Step (3) loop + received_qty UPDATE | 195-204 | 203-212 | Byte-identical |
| Step (3a) STOCK block (incl. "unchanged spec-107 block" comment) | 206-214 | 214-222 | Byte-identical |
| **§3b branch — `if … new_case_price is not null then`** | **220** | **228** | **Identical entry line** |
| **↳ GATE HUNK (11 comment lines + 3-line guard + 1 blank)** | **221-235** | **— (absent)** | **THE ONE DELTA** |
| §3b `< 0` check onward (catalog join, old-value read, change test, both writes, audit, envelope accum) | 236-330 | 229-323 | Byte-identical |
| Step (4) status recompute + `receive_client_uuid` overwrite | 333-357 | 326-350 | Byte-identical |
| Step (5) vendor-name guard + `PO received` audit | 359-377 | 352-370 | Byte-identical |
| Step (6) return envelope | 379-393 | 372-386 | Byte-identical |

The gate is inserted as the **first statement inside the §3b branch, immediately
after `if v_item_id is not null and v_line.new_case_price is not null then` and
BEFORE the `< 0` validation** — the exact fixed site from design §0/§1.

**No other delta of any kind** — behaviorally inert or not. I specifically checked
the two places spec 109's header called out as its own divergences from spec 107
(the §3a "unchanged spec-107 block" comment and the step-5 `if v_vendor_name is
null` reuse-guard): both are preserved verbatim in the new migration, confirming
the developer copied from the spec-109 body (the correct source), not spec 107.
No whitespace drift, no comment re-wording, no re-emission of the sibling RPCs
(`close_short_purchase_order`, `cancel_purchase_order`) or the reorder re-CREATEs.

**Ruling: WITHIN DESIGN.**

## 2. Refusal errcode / string / predicate — CONFIRMED byte-exact

`20260707000000:232-234`:
```
if not public.auth_is_privileged() then
  raise exception 'forbidden: price change requires admin' using errcode = '42501';
end if;
```

- Predicate `not public.auth_is_privileged()` — exact.
- errcode `42501` — exact (matches the `auth_can_see_store` gate three lines up in
  the source, per design §3 error-case table).
- String `forbidden: price change requires admin` — byte-exact vs the pinned
  contract in design §0. `auth_is_privileged()` confirmed at
  `20260509000000_multi_brand_schema_rls.sql:235-239` as `auth_is_admin() OR
  auth_is_super_admin()` (false for `user`/`staff`), so the gate refuses staff and
  admits admin/master/super_admin — as designed.

## 3. Signature-stability / grants / schema / RLS / publication / INVOKER — CONFIRMED

- **Signature stable:** `receive_purchase_order(uuid, jsonb, uuid)` unchanged →
  `create or replace` preserves the spec-107 ACL. **No grant/revoke re-emit** — the
  migration emits none (correct; the header note at `:66-77` documents this and the
  inline comment at `:395-396` states it). Matches the spec-104/107/109 discipline.
- **`security invoker` + `set search_path = public`** (`:120-121`) — unchanged.
- **No schema DDL:** no CREATE/ALTER TABLE, no column/index/constraint. The whole
  migration is `begin;` → one `create or replace function` → `comment on function`
  → `commit;`.
- **No RLS/policy change:** no CREATE/ALTER/DROP POLICY. The price gate is an inline
  SECOND authorization check inside §3b (the OQ-3 resolution — RLS cannot express
  "refuse based on a value inside the jsonb argument"). The stock path is NOT gated
  on privilege (verified: the gate is strictly inside the §3b `if`, never before
  the loop).
- **No publication change:** no `alter publication supabase_realtime`. Body-only.
  The realtime `docker restart` gotcha does not apply — correctly stated in the
  header (`:82-88`).

## 4. Header + comment-on-function honesty — CONFIRMED

- **Header (`:19-98`)** cites the source range `cost_on_receipt.sql:122-386`,
  describes the single HUNK with its exact placement and rationale, and states
  "There are no behaviorally-inert deltas beyond this one hunk" (`:56`). This is a
  stronger claim than spec 109's header (which had to enumerate two inert deltas
  when copying from spec 107 and dropping comments). Here the copy source is spec
  109 and nothing is dropped, so "no inert deltas" is **accurate** — confirmed
  against my line-by-line diff. Header enumerates the ACL/schema/RLS/publication
  no-ops and the prod-apply steps.
- **`comment on function` (`:398-421`)** appends an honest spec-113 gate paragraph
  ("Spec 113 PRICE GATE (R-1)… refused… with SQLSTATE 42501 ''forbidden: price
  change requires admin'' BEFORE any write or idempotency stamp (nothing durable…);
  the stock path is UNCHANGED for store members… privileged caller''s price path is
  UNCHANGED (spec 109 regression)"). The spec-107+109 body of the comment is
  byte-identical to `cost_on_receipt.sql:391-406`. Honest and complete.

## 5. pgTAP suite pins every design case; spec-109 suite untouched — CONFIRMED

`staff_receiving_gate.test.sql` is a NEW file (`plan(45)`, hermetic
`begin;…rollback;`), master (`3333`) + staff-member (`2222`, role `user`, Frederick
member) JWT-claims switch pattern. Case coverage vs design §pgTAP-plan:

- **(a) AC-1** staff stock-only receive succeeds — status→received, conflict:false,
  `price_changes:[]`, received_qty 8, stock 10→18, item + link case_price still 20,
  one `PO received` audit, zero `PO price change`. ✓ (9 assertions)
- **(b) AC-2** staff priced line → `42501` (errcode-only `throws_ok`, third arg
  `null`) + **all six durable targets** asserted unchanged after a master read-past-
  RLS: received_qty null, current_stock 10, item case_price 20, item cost_per_unit
  `5.000000`, link case_price 20, link cost_per_unit `5.000000`, audit_log 0 rows,
  `receive_client_uuid` null, status still `sent`. Plus the **presence-not-value**
  pins: `new_case_price` 0 / 20-equal / **-1** all raise `42501` (the -1 case
  explicitly asserts 42501, NOT the P0001 `<0` abort — proving gate-before-`<0`). ✓
- **(c) AC-3** privileged (master) changed-price regression — item_vendors 20→40 +
  cost_per_unit→`10.000000` (★=40/4), inventory_items 20→40 + cost_per_unit→10,
  stock 10→18, one `PO price change` audit, `price_changes` length 1 with
  `new_cost_per_unit=10`. ✓
- **(d) AC-4** staff replay idempotency — fixed uuid first call (stock 10→14,
  status received), `lives_ok` on the no-priced-line replay (proves gate not
  spuriously reached), then conflict:true, `price_changes:[]`, stock stays 14,
  received_qty stays 4, still one `PO received` audit. ✓
- **(e) AC-6** read confirmation — staff member reads Frederick open POs (>0) + a
  Frederick PO's po_items (>0); a real Charles PO + line seeded as master, then the
  staff (non-Charles-member) SELECTs return 0 rows for both. ✓
- **(f) PINNED string** — `throws_ok(…, '42501', 'forbidden: price change requires
  admin')` (message byte-pin) PLUS an explicit `SQLERRM` equality via a caught
  `exception when others` block. A reword breaks both. ✓

Fixture precision is internally consistent: `case_qty 4 / sub_unit_size 1` →
divisor 4; baselines case_price 20 / cost_per_unit 5.00 / stock 10; assertions use
`5.000000::numeric` / `10.000000::numeric` matching the `numeric(12,6)` widening.
No `set role anon` (spec-067 CI-segfault avoidance). `cost_on_receipt.test.sql`
confirmed **unmodified** (still `plan(55)`, runs as master, unaffected by the gate).

## 6. Prod-apply note present, body-only caveat — CONFIRMED

Header `:90-98`: apply via MCP `execute_sql` against `ebwnovzzkwhsdxkpyjka`, insert
version `20260707000000` into `supabase_migrations.schema_migrations`, and POST-APPLY
verify with the `pg_get_functiondef(oid) like '%forbidden: price change requires
admin%'` probe (because a body-only change is invisible to the migration-list drift
gate — the spec-104/107/109 caveat). "The developer FLAGS the prod-apply… they do
NOT push it" — matches the user-gated posture. The spec's Files-changed section and
Handoff both correctly flag prod-apply as NOT done / user-gated.

## Carve-out path check (frontend file, per task) — SANCTIONED, not a db.ts bypass

`src/screens/staff/lib/receiving.ts` imports `{ supabase } from '../../../lib/supabase'`
(`:37`) and calls `supabase.from`/`supabase.rpc` directly. This is the **sanctioned
staff carve-out** — CLAUDE.md "DB access centralized" explicitly allows "the entire
`src/screens/staff/` subtree" to call supabase directly (spec 063), mirroring
`fetchReorder.ts` / `countLayouts.ts`. **Not** a `db.ts` bypass; no `db.ts` import
present. R-1 belt honored two ways: `submitStaffReceive` (`:218-226`) maps each
line to exactly `{ po_item_id, received_qty }` — no `new_case_price` key anywhere;
`fetchStaffPoLines` (`:155-198`) selects no `cost_per_unit`/`case_price`/`case_qty`/
`sub_unit_size` column. Types (`StaffOpenPo`/`StaffPoLine`/`StaffReceiveDelta`) carry
no price surface. Correct.

---

## Findings (all Minor / informational — nothing to change)

**Minor-1 (informational, no action).** "Nothing durable" (AC-2) relies on the
plpgsql implicit-transaction rollback on `raise`, not on statement order — the §3a
stock UPDATE and the received_qty UPDATE physically precede the gate in the same
loop iteration. This is by design (documented in the migration header `:43-54` and
design §1/§8), is the same property spec 109's `<0` P0001 case relied on, and is
pinned directly by pgTAP case (b) across all six targets. Called out here only
because it is the subtlest correctness point; no change warranted.

**Minor-2 (informational, no action).** `plan(45)` — the developer's finalized count
(design left N to the developer). I counted the enumerated assertions across cases
(0)+(a)+(b)+(c)+(d)+(e)+(f); 45 is consistent with the visible `select ok/is/
throws_ok/lives_ok` calls. CI will hard-fail on any plan/assertion mismatch, so this
is self-enforcing; no manual recount needed for sign-off.

**Minor-3 (informational, no action).** `receive_purchase_order`'s `p_lines` still
projects `new_case_price` in **both** `jsonb_to_recordset` calls (the apply loop at
`:197` and the line-count recordset at `:372`) — byte-identical to spec 109 (HUNK 1).
Correct and intentional: the gate lives in the loop body, not in the projection; the
recordset column list must stay consistent between the two. No drift.

## Cross-check with browser-verified behavior (main Claude)

Main Claude's live check — a crafted staff RPC returns `42501` / "forbidden: price
change requires admin" and leaves nothing durable; admin path unaffected — is
exactly what the code path and pgTAP case (b)/(c)/(f) predict. Consistent with the
static review; no contradiction.

## Bottom line

The implementation matches the `## Backend design` with no drift. The re-CREATE is
verbatim + exactly one gate hunk at the fixed site; the refusal is byte-exact; the
migration is signature-stable, additive, and free of schema/RLS/publication change;
the pgTAP suite pins every AC (a–f) and the spec-109 suite is untouched; the
prod-apply note is present and user-gated; the frontend data path is the sanctioned
staff carve-out, not a `db.ts` bypass. No Critical or Should-fix findings.

## Resolution note (main Claude — 2026-07-04)

IN DESIGN, no drift — nothing to action. Post-review, only the frontend
dead-i18n-key trim landed (no backend/migration change), so the verbatim-copy
+ one-gate-hunk verdict stands unchanged. Prod-apply remains user-gated per
the migration header.
