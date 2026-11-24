# Spec 207: backend-architect post-implementation review

Reviewer: backend-architect (post-impl mode), 2026-11-24.
Reviewed against: `## Backend design` D-0 to D-13 in [specs/207-recompute-costs-on-unit-change.md](../../207-recompute-costs-on-unit-change.md).

**Verdict: no Critical findings. 1 Should-fix, 5 Minor.** The migration matches the design contract object by object. RLS, grants and trigger shape landed as designed. No client code, `db.ts`, store, edge function or `config.toml` change was made.

**Method note.** This reviewer has no shell, so `git diff` and `diff` could not be run. The seven modified pgTAP files were reviewed in their current state at every spec-207 hunk (found by grepping for `207` / `R3` / `derive`) and at the assertions those hunks feed. `receive_purchase_order` was compared by reading the two line ranges side by side (see "receive_purchase_order verification").

## Files reviewed

- `supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql`
- `supabase/tests/cost_rederive_on_pack_size.test.sql` (plan 59, recounted and correct)
- `supabase/tests/list_cost_drift.test.sql` (plan 17)
- `src/utils/perEachCost.spec207.test.ts`
- Spec-207 hunks in `apply_item_scalars_store_subset`, `apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `inventory_items_identity_lock`, `item_vendors_backfill`, `item_vendors_rls` and `stock_store_from_store` (`.test.sql`)
- For reference: `20260707000000_staff_receiving_price_gate.sql` L114-393, `20261115120000_apply_item_scalars_store_subset.sql` L72-79, `20260618000000_public_grants_explicit.sql`, `src/utils/perEachCost.ts`, `src/utils/unitConversion.ts` L309-313

## Design conformance (D-0 to D-13)

| Item | Result |
|------|--------|
| D-0 filename / object set | Matches. All seven objects are present under the designed names. |
| D-1 no table, column, index or policy change; no data written | Matches. |
| D-2 helpers | Matches: `immutable parallel safe`, `search_path = ''`, `< 'Infinity'` bound, schema-qualified inner call. Grants: revoke from public, grant to anon/authenticated/service_role (migration L651-656). |
| D-3 R3 triggers | Matches: column lists, `WHEN (new.case_price > 0)`, INVOKER, never raises, `zz_` name. Trigger functions are revoked from public/anon/authenticated (L660-665). |
| D-4 R1 trigger | Matches: AFTER UPDATE OF case_qty, sub_unit_size, DEFINER, early return when pieces are unchanged, `is distinct from` write filter, `item_vendors.updated_at = now()`, each link uses its own `case_price`. |
| D-5 `list_cost_drift` | Matches the signature, both `kind` predicates, the `current_user in ('anon','authenticated')` gate with 42501 `privileged only`, RLS-only scoping (no `auth_visible_store_ids()` filter), `#variable_conflict use_column`, grants (revoke public/anon, grant authenticated/service_role). |
| D-6 `receive_purchase_order` | Matches: verbatim body with one changed line (see below). |
| D-7 RLS | No new policy. The spec 053 and spec 205 lints are unaffected. The FORCE-RLS and owner facts are pinned (test S8). |
| D-8 client / db.ts / realtime | No change. No publication change, so no docker-restart step. |
| D-9 tests | Covered, with two justified deviations (judged below) and one weakened pin (S-1). |
| D-10 file shape | Matches: header sections, `begin`/`commit`, `lock_timeout`, object order, `drop trigger if exists`, BACKOUT. |
| D-11 prod rollout | Not run (owner-gated, correctly). Release note below. |

## receive_purchase_order verification

- **Latest definition.** `receive_purchase_order(` is defined only in 20260704000000, 20260705000000, 20260707000000 and the new migration. 20260707000000 is the latest, so it is the correct base.
- **Delta.** New migration L366-645 and 20260707000000 L114-393 are both 280 lines. Read side by side, they differ only at new L519 / old L267:
  - `- v_new_cost_per_unit := v_line.new_case_price / (v_case_qty * v_sub_unit_size);`
  - `+ v_new_cost_per_unit := public.per_each_cost(v_line.new_case_price, v_case_qty, v_sub_unit_size);`
  - Every other line is unchanged: the spec 113 gate and its pinned string, the coalesced locals, both cost writes, the audit rows and the envelope.
- **ACL and comment.** The signature is unchanged and the migration has no grant, revoke or comment for this function, so `create or replace` keeps both.
- **Header range.** The header cites L114-393, where the design said L114-396. The function ends at `$$;` on L393, so the developer's range is the accurate one.
- **Call is reachable.** The function is INVOKER with `search_path = public`. Its call to `public.per_each_cost` works because `authenticated` holds EXECUTE (S7).

## Developer's stated deviations

1. **anon refusal checked only with `has_function_privilege` (no `throws_ok` under `set role anon`). Accept.**
   - Spec 067 makes `set role anon` a known CI segfault, and every anon check in the suite uses this form.
   - The grant is the primary gate.
   - The body gate's `current_user in ('anon', …)` arm is defense in depth: if a later migration re-granted anon by mistake, anon would still get 42501 `privileged only`.
   - Test (2) also pins PUBLIC = false. That is the arm spec 097's default privileges could reopen.
2. **Savepoint plus xmin/ctid write detection. Accept. This corrects an error in my D-9.**
   - D-9 said "any UPDATE gives the row a new xmin". That is false for a row updated inside the transaction that inserted it: the new tuple version carries the same top-level xid.
   - Running each action in its own SAVEPOINT gives a written row the subtransaction xid. Adding ctid makes the check strict, because any UPDATE (HOT included) creates a new tuple at a new ctid.
   - The detector is proven non-vacuous: AC-1 asserts `isnt` on store B's version after R1 (cost_rederive L348-352).
3. **Stale verbatim comment in `receive_purchase_order`. Accept** (see M-1). Keeping the body byte-identical to its base matters more than fixing the comment, and the header already says `case_qty = 0` no longer divides by zero.
4. **`apply_item_scalars_to_brand` (15), the "NULL means skip" check. Partly accept.** The new comment is accurate, but the assertion no longer protects the behavior it names. See S-1.

## Findings

### Critical

None.

### Should-fix

**S-1. `apply_item_scalars_to_brand.test.sql` (15) no longer tests the RPC's NULL-means-skip handling of cost (AC-12: "not weakened").**
- **Where:** [supabase/tests/apply_item_scalars_to_brand.test.sql](../../../supabase/tests/apply_item_scalars_to_brand.test.sql) L222-243, testing RPC [20261115120000](../../../supabase/migrations/20261115120000_apply_item_scalars_store_subset.sql) L74 (`cost_per_unit = coalesce(p_cost_per_unit, ii.cost_per_unit)`).
- **Problem:** Charles's row is priced (case 240, pieces 12). The RPC's SET list always includes `cost_per_unit`, so R3 always rewrites the cost to 240/12 = 20, whatever the RPC writes. A regression to `cost_per_unit = p_cost_per_unit` (writing NULL), or to `coalesce(p_cost_per_unit, 0)`, would still pass (15).
- **Why it matters:** NULL-means-skip is still observable, and still matters, on **unpriced** rows. There R3 does not fire, and the RPC's coalesce is the only thing that keeps a hand-set cost. That is the R3 rule "an unpriced row keeps the cost written to it".
- **Fix (test-only, small):** add an unpriced X row to the fixture at Frederick or Reisters, e.g. `case_price 0, cost_per_unit 3.33`.
  - That changes `updated_count` / `skipped_count` in (3)-(5). If that churn is unwanted, use a second fresh catalog row and a separate NULL-skip call instead.
  - Assert the unpriced row still reads 3.33 after the `(…, 7, null, null)` call.
  - Keep (15) as written: it correctly pins the priced-row outcome.

### Minor

**M-1. Stale in-body comments in `receive_purchase_order` (accepted deviation; optional header line).**
- Migration L389-390 ("coalesced ≥ 1"), L394 ("computed per-each = new_case_price / (case_qty × sub_unit_size)") and L493-496 ("the divisor is ≥ 1 and never zero") no longer describe the code. A `case_qty = 0` row stays 0 after `coalesce`; `per_each_cost` is the guard, and it also rounds.
- No change is needed in the body. If anything, add one sentence to the "receive_purchase_order SOURCE DISCIPLINE" header (L78-88) saying those in-body comments are kept verbatim and are superseded by `per_each_cost`, so a later re-CREATE does not carry the claim forward.

**M-2. Rows whose catalog row belongs to another brand (the FU-3 gap) get different derived values depending on who writes them.**
- **Where:** migration L162-188 (R3 lookup runs as the caller) vs L222-274 (R1 runs as owner) and L284-360 (`list_cost_drift`). Pinned by cost_rederive L736-762, and excluded by hand at L813.
- **What happens:**
  - A brand member's write derives the cost with pieces = 1, because the INVOKER lookup cannot see the other brand's catalog row. That is the intended no-leak behavior.
  - R1, and `list_cost_drift` run as `postgres`, use the real pieces count.
  - So such a row can flip between the two values depending on the last writer, and the MCP drift listing reports it as `drift`.
  - R1 also writes the other brand's pieces-derived cost into a row the writer can read. The INVOKER no-leak property therefore holds only until the catalog's brand changes the pack size. Pieces counts are low-sensitivity, so this is not a security finding.
- **Recommendation:**
  - (a) In D-11 steps 1 and 4: if the baseline or AC-13 drift count is non-zero, first check whether the flagged rows have `stores.brand_id <> catalog_ingredients.brand_id` before treating it as new drift and stopping.
  - (b) Raise FU-3's priority. Enforcing store brand = catalog brand on insert removes this class of row entirely.

**M-3. The R3 re-point columns are untested.** `UPDATE OF catalog_id` on `inventory_items` and `UPDATE OF item_id` on `item_vendors` are in the trigger column lists. S2/S3 pin them structurally, but no test re-points a row and checks the cost re-derives. No current writer re-points, so this is optional: one assertion per table in cost_rederive would do.

**M-4. e2e not run locally (D-9 asked for it before READY_FOR_REVIEW).**
- The developer's reason (another session holds port 8081, and `reuseExistingServer` would write into the shared DB) is sound. The grep found no hard-coded dollar amounts.
- CI's seed load now rewrites about 470 priced rows through R3, which moves inventory value and dashboard KPIs. `dashboard.spec.ts` asserts structure only, so the risk is low.
- Treat `e2e.yml` on the post-push run as the required evidence (checked by hand, per project memory), or run locally once the port is free.

**M-5. Unrelated changes in the working tree.**
- `git status` shows modifications to `app.json`, `CLAUDE.md`, `.claude/agents/*`, `specs/181-native-internal-build.md` and `src/lib/nativeAppConfig.spec181.test.ts`. None belong to spec 207, and the spec states "No change to … app.json".
- This is not a defect in the 207 work. Commit 207 from a separate index (the shared-index technique in project memory) so the app-identity files do not ride along.

## Things verified with no finding

- **R1 / R3 stacking is structurally correct.**
  - AFTER timing means R3 reads the new pack size.
  - Unpriced rows skip R3 through `WHEN`.
  - The last-check asserts (cost_rederive L807-828) show every priced fixture row ends on the rule.
- **AC-5 no-op paths write nothing:** rename, i18n, image, eod mode, resend, the (2,3)→(3,2) swap, and 0/NULL ↔ 1. Each is proven by an anti-vacuity check plus the version detector.
- **AC-6 reach:** a brand-2 store row is re-derived, and an anti-vacuity check confirms the admin cannot see that store.
- **AC-7:** 0.014286 and 0.500010 pinned; cost-0 rows are not written.
- **AC-8 hot path:** the stock / par / EOD / vendor_id / order_code / url / is_primary updates leave an off-rule cost unchanged.
- **AC-9:** the envelope, both stored columns and the audit text agree at 13.333333 (this would fail on the old body). The `case_qty = 0` receive succeeds.
- **AC-11:** po_items and waste_log rows are unwritten.
- **RLS message still wins on INSERT** (spec 179 T72 intent): cost_rederive L721-730.
- **The R3 lookup cannot fail for anon:** spec 097 grants anon table SELECT on `catalog_ingredients` / `inventory_items`, so the lookup returns no rows under RLS instead of raising.
- **T72 / T73 pins are tighter, not looser:** T72 names the single allowed BEFORE INSERT trigger instead of counting 0, and T73 appends it last.
- **`item_vendors_rls` option 2** (`case_price = 0`) is the right call. A priced link would make the "non-member write did not land" probe vacuous.
- **`apply_item_vendors_to_brand` (11)/(12)** still discriminate, because the submitted V1 pair (99, 999) is off the rule.
- **`stock_store_from_store` T-3** now reads "verbatim" while the value is in fact recomputed. It still passes meaningfully because T-9 compares whole rows byte for byte.
- **The jest matrix matches the pgTAP `_m` matrix row for row.** NaN stands in for SQL NULL, and `calcUnitCost` is checked only for `caseQty > 0`, as D-2 directed.

## Release notes for release-coordinator

- **Prod apply has not happened.** Per D-11, run the MCP apply (version `20261123130000` inserted before `commit;`) **before** pushing. Otherwise `db-migrations-applied.yml` goes red on `main`.
- Record the AC-13 counts under `## Rollout notes`, keeping M-2(a) in mind.
- The developer reports `npm run typecheck` fails locally only on duplicate `node_modules/@types/* 2` folders. Rely on CI's typecheck job for the gate.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 6 findings by severity: 0 Critical, 1 Should-fix (S-1 apply_item_scalars_to_brand NULL-skip pin no longer tests the RPC on priced rows; add an unpriced-row assertion), 5 Minor (M-1 stale verbatim comments, M-2 cross-brand-catalog rows derive differently by writer and need an AC-13 runbook note, M-3 untested re-point columns, M-4 e2e not run locally, M-5 unrelated working-tree changes to keep out of the 207 commit).
payload_paths:
  - specs/207-recompute-costs-on-unit-change/reviews/backend-architect.md
