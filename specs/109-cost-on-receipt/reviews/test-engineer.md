## Test report for spec 109

### Acceptance criteria status

Backend / data:

- AC1 (optional `new_case_price`; absent → stock-only; differs → cost update; equal → no-op) → **PASS** — `supabase/tests/cost_on_receipt.test.sql::(1)` (case-1 items, priced change), `::(6)/(7)` (absent/zero/equal → no-op on both tables + no audit row), plus the jest arg-builder pin `src/lib/db.poLoop.test.ts::"emits new_case_price ONLY for lines carrying a finite price"`.
- AC2 (`item_vendors.case_price` + `cost_per_unit` recompute via ★, persists) → **PASS** — `cost_on_receipt.test.sql::(1)` assertions on `item_vendors.case_price`/`cost_per_unit` (20→40, 5.00→10.000000).
- AC3 (OQ-1 AGGRESSIVE — `inventory_items` scalar ALWAYS recomputes via the SAME ★ divisor, regardless of `is_primary`) → **PASS** — `cost_on_receipt.test.sql::(2)`, the load-bearing OQ-1 pin: a receive against V2 (secondary, `is_primary=false`) still rewrites the item scalar (20→55, per-each 13.75) while the V1 primary link is asserted UNCHANGED. Link/item per-each agreement verified in case (1) (both 10.000000 off the same divisor 4).
- AC4 (OQ-2 — `catalog_ingredients.default_cost` NEVER written) → **NOT TESTED** — design §15 explicitly names this case (f): "capture default_cost before/after a changed-price receive; assert unchanged." No such read/assertion exists anywhere in `cost_on_receipt.test.sql` (grepped the full 663-line file — `default_cost` appears only twice, both as fixture-seed INSERT values at lines 96/573, never read back). Code inspection of the migration confirms no `catalog_ingredients` UPDATE exists in the new body (correct by inspection), but there is zero automated regression pin — a future edit that accidentally wrote `default_cost` would not be caught by this suite. This is a distinct, explicitly-named AC ("The RPC **NEVER** writes... A per-store receipt does not move the brand-wide catalog seed"), not incidental — flagging as uncovered per the instructions' "watch: does anything pin..." framing extended to this AC.
- AC5 (audit_log old→new, house shape, `user_id = auth.uid()`, recoverable) → **PASS** — `cost_on_receipt.test.sql::(8)` (exactly one row, `detail` old→new CASE `like '%case 20.00 → 40%'`, `value` old→new PER-EACH `like 'each 5.00%→ 10%'`, `user_id` = the INVOKER master id) and `::(4)` (link-missing renders old as `'—'`).
- AC6 (cost update fully inside the idempotent receive — replay does NOT re-apply on either table, no dup audit row) → **PASS** — `cost_on_receipt.test.sql::(3)` replay block: `conflict:true`, `price_changes: []`, link+scalar stay at the first-call value (44.00, not double-written), stock stays at 12 (not double-incremented), exactly 1 `'PO price change'` row (not 2).
- AC7 (spec-107 stock/status unchanged for no-price lines) → **PASS** — `cost_on_receipt.test.sql::(10)` (priced receive still increments `current_stock` +8 and flips status → `received`) and `::(6)` (zero/equal/absent lines still receive stock, cumulative +2+2+2 = 16). Also `ReceivingSection.test.tsx`'s pre-existing "outstanding prefill + commit deltas" describe block (untouched by this spec) still passes.
- AC8 (SECURITY INVOKER + search_path + `auth_can_see_store` gate fires BEFORE any cost or stock write) → **NOT TESTED for the cost-specific claim.** By code inspection, the migration is verbatim-copied from `20260704000000_po_loop.sql` for the auth-gate block (§1, unchanged), and `po_loop.test.sql:246-262` already pins a non-member refusal (P0002) for the *stock* path on the byte-identical gate. But `cost_on_receipt.test.sql` has **zero** test exercising a non-member/refused caller against a price-carrying line — no assertion that "link + scalar unchanged after a refused call" exists anywhere in the new file (grepped for `auth_can_see_store`, `42501`, `P0002`, "non-member", "refused" — only one incidental comment match, no actual test). Design §15 case (e) explicitly calls for this. The gate almost certainly holds (it's the same `if not auth_can_see_store(...) raise` statement, unconditionally before the per-line loop, that spec-107 already proved refuses BEFORE any write), but there is no dedicated regression pin for the cost-write half of this guarantee specifically — a future refactor that moved the auth check after the loop (unlikely, but the kind of change this suite exists to catch) would not be caught here.
- AC9 (OQ-6 last-entry-wins across partial receives, each own audit row) → **PASS** — Design's dedicated last-wins case is (g), but I could not find a standalone 2-sequential-different-price test isolated to that label; however the requirement ("two sequential receives with different prices leave the LAST price... and a recoverable trail of BOTH changes") is *functionally* exercised by the combination of: `::(6)` running three sequential receives against the SAME line/item (0, 20, absent) and `::(1)`+`::(2)`+`::(4)` each being independent single-price-change receives on distinct items. **Correction on closer read:** none of the 40 assertions isolates the "two DIFFERENT non-zero prices on the SAME item, sequential receives, assert last-wins + 2 audit rows" scenario the design's case (g) describes verbatim — the closest analog (case 6) only exercises 0/equal/absent, never two distinct non-zero prices in sequence on one item. Reclassifying: **NOT TESTED** as a standalone case, though the underlying mechanism (each call independently passes the "changed AND positive AND distinct-from-current" test, so a second differently-priced call on the same item necessarily re-triggers) is implied by the change-test logic proven correct elsewhere (case 1 proves a single change applies; case 3 proves idempotent replay of the SAME price+uuid does not re-apply — the "different price, different uuid" combination that AC9/OQ-6 specifically names is never directly exercised end-to-end in one continuous scenario).

- AC10 (>30% guard is client-side confirm required; RPC accepts what is sent, may echo) → **PASS** — RPC side: code inspection confirms no server-side rejection of any price magnitude (only `<0` P0001 and the `>0`+`distinct` change test — no percentage check), matching "the RPC otherwise accepts what is sent." Client side: `priceGuard.test.ts` (exact bridge math, >30% up/down flagged, ≤30% not flagged incl. exact-30%-boundary, no-baseline, non-finite) + `ReceivingSection.test.tsx::"fires the SECOND (30%) confirm ONLY when a changed price trips >30%, and proceeds on confirm"` + `::"DECLINING the 30% confirm aborts the whole commit — the RPC is NOT called"`. Verified the decline mechanism is real, not shape-only: `confirmResponses = [true, false]` causes the mocked second `confirmAction` call to skip invoking its `onConfirm` callback (`runReceive`), and the test asserts `state.receivePurchaseOrder` was never called — this genuinely exercises the two-confirm chain in `ReceivingSection.tsx`'s `onCommit`, not a stubbed pass-through.

Frontend (admin Cmd UI, `ReceivingSection` PO-mode):

- AC11 (ghosted "case price this delivery" input; unchanged ghost does NOT trigger cost update) → **PASS** — `ReceivingSection.test.tsx::"ghosts the case-price input with the expected price (costPerUnit × caseQty)"` and `::"sends NO newCasePrice when the case price is left at the ghost (unchanged)"` / `::"...cleared to empty"`.
- AC12 (OQ-3 — CASE price input, per-each recompute server-side; a differing value marks the line + sends `newCasePrice`) → **PASS** — `ReceivingSection.test.tsx::"threads newCasePrice when the entered case price DIFFERS from the ghost"`; server-side recompute already covered under AC2/AC3.
- AC13 (OQ-4 basis-bridged 30% client confirm, naming item + old→new, decline returns with value intact) → **PASS** — see AC10 above; the "declining aborts" test also confirms the value stays in the `prices` state (the component never clears `prices` on decline — no test explicitly re-asserts the input's `.value` post-decline, but the code path (`onCommit` returns early inside the nested `confirmAction` callback without touching `setPrices`) makes state-loss structurally impossible; this is a minor documentation gap rather than a behavior gap).
- AC14 (post-commit cost reflected in item editor / vendor card / reorder within one realtime debounce, no new subscription) → **NOT DIRECTLY TESTED** — this AC is architecturally satisfied by design (no new realtime subscription is added; the existing `purchase_orders` UPDATE + the already-proven `useStore.receivePurchaseOrder` await-then-refresh chain — `loadPurchaseOrderLines` → `refreshPurchaseOrders` → `loadFromSupabase` → `loadReorderSuggestions` — is unchanged code, and the pgTAP suite proves the new cost values land in `inventory_items`/`item_vendors`, which `loadFromSupabase` reads). There is no dedicated jest test on `useRealtimeSync.ts` or an integration test that exercises the debounced multi-client reload end-to-end — consistent with this codebase's existing pattern (no realtime hook has direct jest coverage; spec 107 treated its own equivalent realtime AC the same way). Not a fresh gap introduced by spec 109, but not independently verified either.
- AC15 (OQ-5 — admin `ReceivingSection` PO-mode ONLY; no staff surface touched) → **PASS** — `git diff`/`Files changed` shows zero touches under `src/screens/staff/`; the new `priceGuard.ts`/`.test.ts` live under `src/screens/cmd/lib/`; i18n additions are under `section.receiving.*`, not the staff-only catalog. Confirmed by inspection (no staff-surface test needed since the change simply never touches that subtree).

### Test run

**pgTAP** — `npm run test:db` (`scripts/test-db.sh`, all files under `supabase/tests/`):
```
✓ 62/62 DB test file(s) passed
```
`supabase/tests/cost_on_receipt.test.sql` — 40/40 assertions passed (matches `select plan(40);`). `supabase/tests/po_loop.test.sql` (spec 107, unchanged) — 30/30 assertions passed.

*Process note:* my first two invocations of `npm run test:db` were run concurrently (overlapping Bash calls) as part of my initial exploration and produced 2 spurious failures (`report_run_custom.test.sql` test 14, `report_run_vendor.test.sql` duplicate-key on `purchase_orders_po_number_key`). Root-caused to a pre-existing, non-spec-109 issue: `generate_po_number()` (init_schema, live since 2026-04-05) computes the next PO number via a live `MAX(...)+1` table scan with no advisory lock/sequence, which is not safe against concurrent transactions against the same live table — running the test runner twice at once let one of my own invocations leave an uncommitted-looking row (`PO-001`, draft status) that then collided with a legitimate test's insert. Every test file in the suite properly ends in `rollback;` (verified across all 62 files) — the leak was from my own concurrent-invocation mistake, not a test-isolation bug in any file, and not something spec 109 introduced (both `po_loop.test.sql` and `cost_on_receipt.test.sql` share the identical pattern of inserting `purchase_orders` rows without setting `po_number`, relying on the same pre-existing trigger). Cleaned the stray row and reran serially (as `test-db.sh`, `test:all`, and CI always do) — clean 62/62, and `select count(*) from purchase_orders` returns to 0 after the run, confirming full transactional isolation. **Flagging the underlying `generate_po_number()` MAX+1-scan-without-lock pattern as a latent flakiness risk** if CI or a developer ever parallelizes DB test invocations — worth a follow-up ticket, not a spec-109 blocker.

**jest** — `npx jest`:
```
Test Suites: 83 passed, 83 total
Tests:       925 passed, 925 total
Time:        3.284 s
```
Spec-109-relevant suites confirmed individually: `PASS component src/screens/cmd/sections/__tests__/ReceivingSection.test.tsx`, `PASS unit src/screens/cmd/lib/priceGuard.test.ts`, `PASS unit src/lib/db.poLoop.test.ts`. (Unrelated `act(...)` console warnings from `src/screens/staff/screens/WeeklyCount.test.tsx` are pre-existing noise, not failures — that suite is green and untouched by this spec.)

**Typechecks:**
```
npx tsc --noEmit                        → exit 0, no output
npx tsc -p tsconfig.test.json --noEmit  → exit 0, no output
```

**Combined `npm run test:all`** (jest + pgTAP) is implied green by the two independent runs above (both exit 0 individually; not re-run as the combined script since each half was already verified serially-clean).

**Not run:** `npm run test:smoke` (shell smokes) — the spec explicitly marks this track "optional" for cost-on-receipt (§15: "shell smoke — optional; a receive-with-price round-trip if the architect adds one") and no such smoke script was added (`scripts/smoke-rpc.sh` has no `cost_on_receipt`/`new_case_price` references). Not a gap — matches the spec's own stated scope.

### Notes

**Real findings (code inspection confirms the implementation is correct; the gap is test-coverage, not a functional bug):**

1. **OQ-2 (`catalog_ingredients.default_cost` never written) has no automated pgTAP pin**, despite being both a named acceptance criterion and design §15 case (f). By code inspection the migration is safe (no `catalog_ingredients` UPDATE statement exists anywhere in the new function body), but nothing in `cost_on_receipt.test.sql` would catch a regression here. This is the AC I'd weight highest to close before ship, given OQ-2's explicit "NEVER" framing and the fact that `default_cost` seeds every new item in every store on the brand (a silent write here would be brand-wide blast radius, not per-store).
2. **The auth-gate-fires-before-any-cost-write AC (design case (e)) has no dedicated pgTAP pin** in the new file. `po_loop.test.sql` already proves the identical gate refuses a non-member BEFORE the stock loop (P0002); this migration's gate code is verbatim-unchanged from that file, so the risk of an actual regression is low — but the cost-specific half of the guarantee ("both the item_vendors and the inventory_items write" refused) is asserted nowhere for this spec's new writes specifically.
3. **OQ-6 "last-entry-wins across two sequential DIFFERENT non-zero prices on the same item" is not exercised as a standalone end-to-end scenario.** The closest coverage (case 6) only sequences 0/equal/absent prices on one item (proving no-ops chain correctly), and cases 1/2/4 are each a single price-change on separate items. The underlying change-test logic (`new_case_price > 0 AND distinct from current`) is proven correct in isolation, and by that logic a second differently-priced call necessarily re-triggers — but the spec explicitly named this as its own pgTAP case (g), and it isn't present as its own scenario with its own audit-row-count assertion (design calls for "TWO `'PO price change'` audit rows exist").
4. **The `22P02` non-numeric-scalar cast-guard half of design case (i) is untested** (only the `<0 → P0001` half is present) — the design itself flagged this half as "(Optional/defensive)," so this is the lowest-priority of the four gaps.

None of these four gaps indicate the underlying RPC behaves incorrectly — I read the full migration body and, by inspection, it matches the design and the ACs. But per the test-engineer brief ("A criterion with no test is a BLOCK" / "If any AC is FAIL or NOT TESTED, treat that as a Critical finding"), AC4 (OQ-2) and AC8 (auth-gate-before-cost-write) are both explicitly-named, spec-called-out acceptance criteria with no direct automated test, and AC9 (OQ-6 last-wins) is a named design case not exercised as its own scenario. I'm treating these as **BLOCK-worthy gaps** per the instructions, even though the fix is almost certainly "add ~6-8 more pgTAP assertions to the existing file" rather than a code change — this looks like straightforward, low-risk additional test-writing, not a redesign.

**What I verified is genuinely solid (not shape-only):**
- The pgTAP assertion count (40) matches `plan(40)` exactly, and every assertion I read compares concrete expected values (not just "row exists" placeholders) — e.g. `10.000000::numeric` for the ★-formula recompute, `'%case 20.00 → 40%'` for audit detail text, exact `jsonb_array_length` checks on the envelope.
- The OQ-1 whipsaw pin (case 2) is real and precise: it builds a genuinely separate secondary-vendor link, receives against it, and asserts BOTH that the item scalar rewrote AND that the untouched primary link's price is unchanged — this is the single most load-bearing test in the file given the owner's explicit "reviewers must not revert this" framing, and it's correctly and thoroughly covered.
- The "declining the 30% confirm aborts — RPC not called" jest test genuinely exercises the confirm-decline mechanism (verified by reading the `confirmResponses` array wiring in the mock and the two-tier `confirmAction` nesting in `ReceivingSection.tsx`'s `onCommit`), not a stubbed pass-through.
- The `db.poLoop.test.ts` return-shape update is a legitimate, honest widening (old `{status, conflict}` assertions replaced with `{status, conflict, priceChanges}`, plus new dedicated tests for the finite-only `new_case_price` emission and null-preserving snake→camel mapping) — not masking a behavior change.
- i18n parity confirmed across all three locales (en/es/zh-CN) for every new `section.receiving.*` key with no missing keys and no unresolved `{placeholder}` leaks in the `priceGuard.test.ts` real-`t()` interpolation block.
- The stock-math regression pin the task specifically asked me to watch for ("does anything pin that a pure stock receive produces ZERO cost changes end-to-end") is present and correct: pgTAP case (6c)/the combined (6)/(7) assertions plus the jest "sends NO newCasePrice" tests both independently confirm a no-price receive touches neither `item_vendors.case_price`/`cost_per_unit` nor `inventory_items.case_price`/`cost_per_unit` nor writes an audit row, while stock still increments.
- No `app.json` slug touch; no new test framework introduced (pgTAP/jest only, matching spec 022 tracks).

## Resolution (main Claude, post-review fix pass — 2026-07-03)

All four NOT TESTED gaps addressed in `supabase/tests/cost_on_receipt.test.sql`
(plan 40 → 55) except AC14, which is waived with rationale:

- **AC9 / OQ-6 last-entry-wins → case (11), 7 assertions.** Two sequential
  receives, DISTINCT client_uuids, case 24 then 36: last price lands on both
  tables (+ ★ per-each), both transitions audit-recoverable (existence-based
  assertions — same-transaction created_at ties).
- **AC8 / auth-gate-before-cost-write → case (13), 5 assertions.** Non-member
  (2222 manager) against a Charles PO with a price-carrying line → P0002
  (mirrors po_loop case (F)); link/scalar/stock/audit all proven unchanged.
- **AC4 / OQ-2 default_cost never written → case (14), 1 assertion.** After
  ALL churn (PRICED→40, NONPRI→55, NOLINK→30, REPLAY→44, LASTWIN→24→36),
  zero SPEC109-% catalog rows deviate from seeded default_cost 5.00.
- **Design case (i) 22P02 half → case (12), 2 assertions.** Non-numeric
  new_case_price ('abc') raises 22P02 at the recordset cast; the abort leaves
  stock untouched.
- **AC14 (realtime reflection) — WAIVED, consistent with the report's own
  note:** it rides the unchanged, already-tested `store-{id}` refresh chain
  and this codebase has no realtime integration-test track. Observed live in
  the browser pass instead: after the priced receive, the debounced reload
  re-prefilled the line (ALREADY 6 / OUTSTANDING 30) without manual refresh.

Also fixed from the parallel code review: busy-gate across both confirms
(+2 jest pins → 927/927) and the migration header's delta enumeration.
Post-fix: pgTAP 55/55 in-file, 62/62 files; both typechecks clean. The stray
`generate_po_number()` concurrency observation is noted as a latent,
pre-spec-107 flakiness risk — out of scope here, left for a follow-up.
