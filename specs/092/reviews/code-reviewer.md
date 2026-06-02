# Code review for spec 092

## Critical

- `e2e/global-teardown.ts:125` — The spec-080 store-delete error handler calls `return` on failure, which silently skips the entire spec-092 cleanup block (lines 133–217). If the spec-080 store delete ever fails (e.g. because a prior run left a child row that was not cleaned and the cascade did not cover it), the two dedicated reorder stores, their `inventory_items`, `order_schedule`, `user_stores`, and the `catalog_ingredients` row are all left behind permanently — the exact cross-track-collision risk the teardown exists to prevent. The spec-092 block is not a sequential extension of a shared happy path; it is an independent cleanup for different stores. The fix is to convert the `return` on line 125 to a `console.warn` (fall-through), matching the non-fatal posture the same block uses for its own child-table deletes (lines 104–113). Alternatively, restructure so each of the three cleanup blocks is a top-level sequential section rather than a chain gated by the prior block's success. As written, the spec-092 teardown is conditionally unreachable.

## Should-fix

- `e2e/staff-reorder.spec.ts:300-301` — The KPI "1" assertion (`root.getByText('1', { exact: true }).first()`) is fragile as a secondary guard. The digit `"1"` almost certainly appears elsewhere in the rendered root (store name character counts, tab indices, price values, etc.), so `.first()` picks an arbitrary element and the assertion passes vacuously on any page that contains at least one "1" somewhere. The design (§6) already acknowledges the no-app-change KPI route is secondary and the vendor-card tripwire is the real guard — but if this assertion is kept at all it should be scoped more tightly (e.g. locating the KPI card by its sibling label first, then asserting the value within that subtree). As written it does not provide the secondary guard it claims to.

- `e2e/global-teardown.ts:210` — The `return` inside the `catalogErr` handler at line 210 exits after the catalog delete fails, but the success log at lines 213–217 is the only place a "all three resources removed" confirmation is emitted. On a catalog-delete failure the caller gets a `console.warn` and the function returns — that is reasonable. The issue is structural: this `return` is INSIDE the implicit "only runs if spec-080 store delete succeeded" branch (due to the Critical above). If the Critical is fixed (converting line 125 to warn + fall-through), this `return` becomes fine in isolation. Document this dependency explicitly in the comment so the next reader does not reintroduce the gatekeeping pattern.

## Nits

- `e2e/staff-reorder.spec.ts:276` — The single test that covers AC-092-NAV, AC-092-LIST, AC-092-CASES, and AC-092-EXPORT is named with a `/`-joined concatenation of four ACs. That is consistent with the eod spec's naming style and not wrong, but the test title is long enough to be truncated in most Playwright reporters. A shorter name like `'AC-092-NAV/LIST/CASES/EXPORT: reorder list renders with cases display and export buttons'` would be no worse; this is a preference.

- `e2e/fixtures/constants.ts:66` — `e2eReorderItemId` ends in `0000000000a1`, which is valid hex but the `a1` suffix does not read as cleanly as the `0092`/`0093` pattern used for the store ids. The spec notes the developer was free to finalize the suffix as long as it is hex-valid; the comment in the spec (§5) flagged this. Not wrong, just slightly inconsistent with the `…0092`/`…0093` convention the store ids establish.

- `e2e/staff-reorder.spec.ts:258` — `await expect(picker.or(reorderTab).first()).toBeVisible()` — The `.first()` call on an `or()`-locator here matches the `gotoTowsonEod` pattern in `eod.spec.ts:83` exactly. On some Playwright versions `.first()` on an `or()` locator evaluates only the first resolved element in DOM order, not necessarily the picker. The eod spec uses this shape and it runs green, so this is not a new risk — but it is worth noting that `page.locator(':visible').first()` would be more explicit if this ever causes ordering surprises. (Out-of-scope: pre-existing pattern.)

---

**Summary.** One Critical: the spec-092 teardown block is conditionally unreachable because the spec-080 store-delete error handler (line 125) does an early `return` that gates all subsequent cleanup. This is a correctness bug in the teardown — on any run where the spec-080 store fails to delete, the two dedicated reorder stores and all their children (including the `inventory_items` row that has no CASCADE) will be left behind, exactly the cross-track pollution the teardown was designed to prevent. One Should-fix: the KPI "1" assertion is too broad and does not provide the secondary guard it claims to. One more Should-fix: document the cascaded `return` dependency so it is not silently re-introduced after the Critical is fixed. No app code, no migrations, no store mutations, no `src/lib/db.ts` changes — the scope is correctly test-only and the FK ordering, idempotency, and non-anchor-id discipline are otherwise well-executed.

---

## Resolution (post-review fix-pass — main Claude)

The Critical + both Should-fixes folded in; the 3 Nits deferred (cosmetic).

- **Critical (`global-teardown.ts:125` — spec-092 cleanup conditionally unreachable)** — **fixed.** Converted the spec-080 store-delete error handler from `{ warn; return; }` to `{ warn; } else { log; }` (fall-through). The spec-092 reorder-store cleanup block now runs UNCONDITIONALLY — it is no longer gated on the (independent, different-store) spec-080 delete succeeding, so a spec-080 failure can no longer leak the dedicated reorder stores + their non-cascading `inventory_items`.
- **Should-fix #2 (document the cascaded-`return` dependency)** — **fixed.** Added a note above the spec-092 block stating it's now reached unconditionally and that the lone `return` at the block's end is the function's last statement (skips only the final success log, never a sibling cleanup), so it doesn't re-introduce the gatekeeping pattern.
- **Should-fix #1 (vacuous KPI `"1"` assertion, `staff-reorder.spec.ts`)** — **fixed.** Removed the `root.getByText('1', { exact: true }).first()` assertion (a "1" appears in many nodes; `.first()` picks arbitrarily → vacuous) + documented why. The KPI secondary guard is now just the specific `"Vendors"` label visibility; the real no-vacuous-pass guards (the vendor-card tripwire + the by-the-case-string regex) are unchanged.
- **Nits (3)** — deferred (cosmetic): the long test title, the `e2eReorderItemId` `a1` suffix vs the `0092`/`0093` convention, and the pre-existing `or().first()` locator pattern (ported verbatim from `eod.spec.ts`).

Re-verified post-fix-pass: `npx tsc -p e2e/tsconfig.json --noEmit` exit 0; `npx playwright test e2e/staff-reorder.spec.ts` → **5 passed** (3 auth-setup + 2 spec), and the teardown logs confirm the spec-092 block now executes + removes both dedicated stores + the catalog row (zero leak).
