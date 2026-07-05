## Test report for spec 114

### Acceptance criteria status

- **AC-1** (`order_code` column exists, nullable text, insert/update with and without a code both succeed) → **PASS** — `supabase/tests/item_vendors_rls.test.sql::(9) has_column`, `::(10a) col_is_null`, `::(10b) col_type_is`, `::(11a) omitted order_code persisted as SQL NULL`, `::(11b) member CAN write + read order_code`. All five assertions hit the live local Postgres container (not a mock) — confirmed by direct read of `information_schema`-backed pgTAP catalog functions plus a genuine INSERT (no code) → SELECT (NULL) → UPDATE (code) → SELECT (code) round-trip inside the transaction.

- **AC-2** (RLS unchanged — store member can write/read, non-member denied) → **PASS** — `item_vendors_rls.test.sql::(12) non-member UPDATE cannot write order_code on a Charles link (stays NULL — RLS regression pin)`. This is a genuine pin, not shape-only: it seeds a real Charles-store row under `postgres` (bypassing RLS), re-impersonates the Frederick-only manager, issues a real `UPDATE ... SET order_code = 'HACK-1'` against that row, then re-reads under `postgres` and asserts the value is STILL `NULL` (0-row no-op under the USING clause, not a raised error — correctly modeled, since Postgres RLS UPDATE filters silently rather than throwing). It sits alongside the pre-existing assertion (6) (`cost_per_unit` unmutated), giving two independent columns proving the whole-row policy still gates the row, which is exactly the "did the added column escape the policy" regression this AC asks to rule out. The companion positive case (11b, member CAN write+read on Frederick) is present too, so both directions of AC-2 are covered by the same file.

- **AC-3** (`db.ts` threads the code through embed / mapItem / create-upsert / update-reconcile-upsert; round-trip asserted; empty→NULL not `"undefined"`) → **PASS** — two-layer coverage, both genuine:
  - Live-DB layer: `item_vendors_rls.test.sql::(11a)/(11b)` is an actual PostgREST-adjacent round-trip (raw SQL INSERT/UPDATE/SELECT against the real column) proving the wire-level contract (omitted → NULL, present → persists, reads back).
  - Pure-payload layer: `src/components/cmd/IngredientForm.test.ts` — "carries per-vendor codes independently across two links" and "attach V1+V2, set only V2's code → V2 payload carries it, V1's stays undefined" assert the exact payload shape (`{ vendorId, costPerUnit, casePrice, orderCode?: string }`) that `db.ts`'s `createInventoryItem`/`updateInventoryItem` `vendors?` params consume verbatim (confirmed by reading `db.ts:303`/`:403` — identical shape). I read `db.ts` directly and confirmed the 5-point D-5 threading (embed `:239`, mapItem `:4811`, create-upsert `:373`, update-reconcile-upsert `:504`, both payload types `:303`/`:403`) is present and null-coalesces `l.orderCode || null` / `lv.order_code || ''` exactly as designed — never the literal string `"undefined"`.
  - No dedicated jest unit test exists that calls `db.ts`'s exported `createInventoryItem`/`updateInventoryItem` against a mocked/live Supabase client directly (the codebase has no such harness for this file generally, consistent with existing `db.ts` test conventions elsewhere in the repo) — the live pgTAP + pure-payload combination is the project's established pattern for this class of change and is sufficient here.

- **AC-4** (order-code input in each per-vendor card, keyed on `vendorId`, per-card isolation, trim-on-save, empty→NULL) → **PASS** — `IngredientForm.test.ts::"patches only the targeted vendorId's orderCode; other rows untouched (per-card isolation)"`, `::"editing orderCode leaves cost + case price of the SAME row untouched"`, `::"trims surrounding whitespace on the code"`, `::"maps an empty code to orderCode: undefined"`, `::"maps an all-whitespace code to undefined"`. These are genuine behavior pins against the real `updateVendorLinkField`/`vendorRowsToLinkPayload` exports (imported directly, not re-implemented in the test), and the isolation assertion explicitly constructs a two-row fixture and asserts the untouched row's full object equality — a real cross-row leak would fail this test. Confirmed in source (`IngredientForm.tsx:1261-1268`) that the third `InputLine` is free-form (no `numericOnly`, no `readOnly`) and keyed on `row.vendorId` via `handleVendorOrderCodeChange(row.vendorId, v)`.

- **AC-5** (saving persists each card's code; reopening the drawer shows it; no new save path) → **PASS (indirect, structurally verified)** — no dedicated jest test re-opens `IngredientFormDrawer` and asserts a saved code repopulates the field, but this is covered by the combination of AC-3 (payload correctly carries the code into the reconcile) + AC-1/AC-2 pgTAP (the DB round-trip persists it) + the `IngredientFormDrawer.tsx` hydration code (read directly: both `it.vendors` branches add `orderCode: v.orderCode || ''`, matching the same pattern the pre-existing `costPerUnit`/`casePrice` hydration already uses, which IS the existing reopen-repopulates behavior this spec explicitly says to reuse — no new save button, no new RPC). I consider this criterion satisfied by structural equivalence to an already-tested pattern rather than a fresh end-to-end drawer-reopen test; flagging as a minor coverage gap below, not a blocker, since the mechanism is identical to an already-verified sibling field and the browser evidence (TOGO-9001 persisted, reopened, blank→NULL) closes the loop empirically.

- **AC-6** (second Share affordance, distinct from spec-108 Share, same status gate: draft/sent/partial, absent on received/cancelled) → **PASS** — `POsSection.test.tsx::"Quick-order IS shown on %s (same gate as Share)"` (parameterized over draft/sent/partial), `::"Quick-order is HIDDEN on %s"` (parameterized over received/cancelled), `::"Quick-order is a SECOND, distinct button next to the human-readable Share"` (asserts both testIDs resolve to different elements). Genuine — reads real rendered output via `@testing-library/react-native`, not a snapshot. Confirmed in source both buttons share the identical `canShare` gate expression.

- **AC-7** (paste-ready block, `<order code><TAB><qty>`, one line per PO item, NO prices/NO `$`, qty via `formatQty`) → **PASS** — `src/utils/poQuickOrderText.test.ts` asserts the literal TAB byte three independent ways: `expect(res.text).toContain(TAB)`, `expect(res.text).not.toBe('CODE9 5')` (rules out a space), `expect(res.text).not.toContain(',')` (rules out a comma) — this is a genuine byte-level pin, not an implementation-shape assertion. `formatQty` reuse confirmed both by a dedicated test (`2.5` → `"2.5"`, matching `formatQty`'s documented trailing-zero-stripped shape) and by direct source read (`poQuickOrderText.ts` imports `formatQty` from `reorderExport.ts`, the exact shared formatter the spec names). No-`$` is asserted on a mixed mapped+unmapped fixture in `poQuickOrderText.test.ts` AND independently re-asserted in `POsSection.test.tsx::"hands sharePurchaseOrder a bare block... "` on the text actually passed to the mocked orchestrator (`expect(passedText).not.toContain('$')`) — two independent layers, not a duplicate assertion of the same call.

- **AC-8** (code resolved via `PoLine.itemId` + `sel.vendorId` → the item's `ItemVendorLink.orderCode`, from the hydrated `inventory` rows; `PoLine` NOT extended) → **PASS** — `POsSection.test.tsx`'s quick-order describe block seeds `state.inventory` with `vendors: [{ vendorId: 'vendor-1', orderCode: 'US-1001' }]` on one item and an empty-code entry on another, then asserts the resolved output correctly maps the FIRST to `US-1001` and the SECOND to the `???` placeholder — this exercises the real `resolveCode` closure in `onShareQuickOrder` (read directly: `row?.vendors?.find(v => v.vendorId === sel.vendorId)?.orderCode`), which is precisely the (item, PO-vendor) lookup AC-8 specifies. Confirmed `PoLine`/`poLinesById` fixtures in the test carry no `orderCode`/`vendorSku` field — `PoLine` genuinely is not extended.

- **AC-9** (unmapped items surfaced with `??? <name> <qty>` placeholder + aggregate count warning, never dropped) → **PASS** — `poQuickOrderText.test.ts` covers null/empty/whitespace/missing-key as all "unmapped," each producing the placeholder line and incrementing `unmappedCount`; a mixed-input test asserts the correct count (1) alongside correct ordering/format of both mapped and unmapped lines in the SAME block (nothing dropped — array length and order are checked via full-string equality, not just presence checks). `POsSection.test.tsx::"fires the unmapped-count warning toast when a line has no code"` asserts a real `Toast.show` call with `type: 'error'` and the literal warning i18n key; `::"does NOT warn when every line is mapped"` is the negative control (proves the toast is conditional on `unmappedCount > 0`, not unconditional noise). Both toast tests are genuine (assert against the mocked `Toast.show`, not a snapshot).

- **AC-10** (reuses `sharePurchaseOrder` verbatim — same branching/never-throw/AbortError posture; desktop-web returns preview text; works web + native) → **PASS (jest-verifiable portion)** — `POsSection.test.tsx` mocks `sharePurchaseOrder` at the module boundary and asserts `onShareQuickOrder` calls it exactly once with the built text as the first argument (`mockSharePurchaseOrder.mock.calls[0][0]`), and that when the mock returns a `previewText`, the SAME `po-share-preview` testID pane used by the existing Share renders it (`::"renders the desktop-web preview pane when the orchestrator returns previewText"`) — proving the wiring is a call-through, not a reimplementation of `sharePo.ts`'s branching logic. The never-throw/AbortError-swallow behavior itself is NOT re-tested here (correctly — that's `sharePo.ts`'s own existing spec-108 test surface, and this spec correctly reuses it "verbatim" rather than re-verifying it). Native-path (EAS) coverage is out of reach for jest in this repo per CLAUDE.md's cross-platform note ("native testing is harder and not yet set up"); the shared code path through `sharePurchaseOrder` is the same call for both platforms, so this is a structural argument for native correctness, not a native-run test — flagged below as the expected gap, not a blocker.

- **AC-11** (i18n ×3 for all new user-visible strings; block itself NOT localized) → **PASS** — direct read of `src/i18n/en.json`, `es.json`, `zh-CN.json` confirms all five new keys (`orderCodeLabel`, `orderCodeHelp`, `quickOrderAction`, `quickOrderDialogTitle`, `quickOrderCopiedToast`, `quickOrderUnmappedWarning` — six, not five; the spec's own enumeration undercounts by one, all six exist) present in all three locales with real, non-machine-translated-looking strings (es/zh-CN are genuine translations, not English copies). No jest test asserts key-parity programmatically (e.g., no "all three JSON files have the same key set" lint test) — this is verified by my direct read, not by an automated CI gate; noting as a process gap below (pre-existing across the whole i18n catalog, not spec-114-specific). The pasted block correctness (not localized) is covered by AC-7/AC-9's byte-for-byte pins already listed.

### Test run

**pgTAP — `npm run test:db`** (against the running local Supabase Postgres container, per project policy — real DB, not mocked):

```
== supabase/tests/item_vendors_rls.test.sql ==
  PASS supabase/tests/item_vendors_rls.test.sql (14 assertion(s) passed)
...
✓ 64/64 DB test file(s) passed
```

Ran sequentially, alone (no concurrent invocation), no rows mutated outside the test's own `begin;`/`rollback;` transaction framing. `permissive_policy_lint.test.sql` also stayed green (4/4) with no allowlist edit needed — consistent with the design's claim that no new RLS policy was added.

**jest — `npx jest`**:

```
Test Suites: 93 passed, 93 total
Tests:       1062 passed, 1062 total
Time:        3.127 s
```

Individually re-ran the three spec-114-touched files verbosely to confirm test names/counts:

```
PASS unit src/utils/poQuickOrderText.test.ts        (15 cases, all pass)
PASS unit src/components/cmd/IngredientForm.test.ts (spec-114 block: 8 new cases, all pass;
                                                       pre-existing spec-102 cases updated with
                                                       orderCode: '' literals — all pass)
PASS component src/screens/cmd/sections/__tests__/POsSection.test.tsx
                                                     (spec-114 block: 12 new cases, all pass;
                                                       pre-existing spec-107/108 cases unaffected)
Test Suites: 3 passed, 3 total
Tests:       109 passed, 109 total
```

A pre-existing `act(...)` console warning noise cluster appears in `src/screens/staff/screens/WeeklyCount.test.tsx` during the full run — unrelated to spec 114 (staff subtree, different spec lineage), does not fail the suite, not introduced by this change. Noted for completeness, not a spec-114 finding.

**Typechecks**:

```
npx tsc --noEmit                          → exit 0
npx tsc -p tsconfig.test.json --noEmit    → exit 0
```

Both green. Notably, `ItemVendorLink.orderCode` is a **required** `string` (not optional) on the hydrated type — confirmed by direct read of `src/types/index.ts:187-194`. This is a deliberate design choice (D-5: "non-optional... mirroring how `vendorName` is a required string on the same interface") and it has a real coverage-strengthening side effect: because the field is required, the TypeScript compiler itself forces every literal-construction call site (the pre-existing `VendorLinkRow` literals throughout `IngredientForm.test.ts`, and the optimistic `linkSet.map` bodies in `useStore.ts` at three sites) to supply a value or fail to compile. I confirmed this ripple actually happened — the pre-existing spec-102 `VendorLinkRow` test literals now all carry `orderCode: ''`, and `useStore.ts`'s three `orderCode: l.orderCode || ''` sites are present. This closes off a "silently omit the field at some call site and nothing catches it" bug class at the type layer, on top of the explicit tests — worth calling out because it means the coverage here is stronger than the test count alone suggests.

### Notes

**Deviations from the spec's own review-prompt claims — all confirmed accurate, no discrepancies found:**
- pgTAP file: `plan(8)→plan(14)` claim confirmed exactly (file header says "Fourteen assertions" and the actual `select plan(14);` + 14 numbered assertion blocks are present and all pass).
- `npm run test:db` "64/64 files" claim confirmed exactly.
- `npx jest` "93 suites / 1062 tests" claim confirmed exactly.
- Both typechecks exit 0, confirmed.
- i18n: the spec's own AC-11 text lists five new keys but six actually exist across the three catalogs (`orderCodeLabel`, `orderCodeHelp`, `quickOrderAction`, `quickOrderDialogTitle`, `quickOrderCopiedToast`, `quickOrderUnmappedWarning`) — a harmless undercount in the spec's own prose, not a code or test defect; all six are present ×3 locales with real translations.

**Shape-only vs. genuine test call-outs (per the review request):**
- No shape-only tests found in the spec-114 surface. Every test I inspected asserts either (a) a byte-level output string via full equality or `.toContain`/`.not.toContain` on a literal delimiter/character, (b) a real call recorded against a jest mock at the actual production call site (`mockSharePurchaseOrder.mock.calls[0][0]`, `Toast.show` call args, `mockConfirmAction`/`markPurchaseOrderSentManually` NOT-called assertions), or (c) a live-DB read/write against the running Postgres container via pgTAP. I did not find a test that merely checks a function was "called" without checking its arguments, or a snapshot test standing in for a behavior assertion, in the files touched by this spec.
- The one test I'd flag as **structural-equivalence rather than direct** is AC-5 (drawer-reopen-shows-saved-code) — see the AC-5 entry above. I do not consider this a blocking gap because the mechanism (hydration branch) is byte-identical to the already-tested `costPerUnit`/`casePrice` reopen path, and the user's own browser evidence (below) empirically closes the loop for this exact scenario. If the release-coordinator wants zero structural inference, a follow-up jest test on `IngredientFormDrawer.tsx`'s `fromItem` hydration asserting `orderCode` repopulates from a fixture item would close it in under 10 lines — flagging as a nice-to-have, not a Critical.

**Browser evidence (from main Claude, not independently re-run by me — reported here per the reviewed prompt, cross-checked against source for internal consistency):**
- TOGO-9001 entered on a vendor card → persisted to `item_vendors.order_code`; blank on another item → SQL NULL. Consistent with the pgTAP (11a/11b) live-DB assertions and the `IngredientForm.tsx`/`vendorRowsToLinkPayload` trim/empty→undefined logic I read directly.
- PO export produced `TOGO-9001\t5` + `??? #3 Togo Box\t8`, no `$`, unmapped warning, no mark-sent prompt. Consistent with `poQuickOrderText.ts`'s exact output format and `onShareQuickOrder`'s absence of any `confirmAction`/`runMarkSent` call (confirmed by reading the full function body — no such call exists anywhere in it).
- Console clean. I did not independently drive the browser, but nothing in the read source (i18n keys all present ×3, no missing prop types, both buttons correctly gated) suggests a console warning/error should occur on this flow; the jest suite's `render()` calls for the equivalent component tree also produce no unexpected console output beyond the pre-existing unrelated staff-subtree `act()` noise noted above.

**Framework/process gaps (not spec-114-specific, surfaced per instructions):**
- No automated i18n key-parity lint exists across `en.json`/`es.json`/`zh-CN.json` (a missing key in one locale would only be caught by manual read, as I did here). Pre-existing gap across the whole codebase, not introduced by this spec — flagging per the "surface any framework/coverage gap" instruction, not recommending a new framework.
- No test framework changes were introduced by this spec (jest + pgTAP only, matching the three in-tree tracks). No fourth framework was silently added.
- Prod-apply of the migration (`20260708000000_item_vendor_order_code.sql`) is outside test-engineer scope per the spec's own D-12 ("the developer FLAGS the prod-apply in the handoff and does NOT push it themselves"). The local pgTAP run above IS a genuine live-Postgres verification of the column's shape and RLS behavior — sufficient for this report's purposes — but does not by itself confirm the migration has been applied to the prod project or that `db-migrations-applied.yml` is green. That is a release-coordinator / deploy-checklist concern, not a missing test.
- The hard-rule file (`app.json` slug) was not touched by this spec — confirmed by absence from every file list I read (migration, `db.ts`, `IngredientForm.tsx`, `POsSection.tsx`, i18n catalogs). No violation.

**No Critical findings.** All 11 acceptance criteria are PASS. AC-5 and AC-11's key-parity are noted as minor, non-blocking coverage-depth observations, not FAIL/NOT TESTED.
