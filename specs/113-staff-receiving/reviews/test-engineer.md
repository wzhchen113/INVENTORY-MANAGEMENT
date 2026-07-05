## Test report for spec 113

### Acceptance criteria status

Backend — server-side price gate (R-1):

- AC-1 (staff can receive stock-only) → **PASS** — `supabase/tests/staff_receiving_gate.test.sql::(a)` (9 assertions). Verified: staff caller (`2222`, role `user`, Frederick member) receives 8/8 with NO price key → envelope `status: received`, `conflict: false`, `price_changes: []`; `po_items.received_qty = 8`; `inventory_items.current_stock` 10→18; `inventory_items.case_price` and `item_vendors.case_price` STILL 20 (price side untouched); exactly one `'PO received'` audit row; zero `'PO price change'` rows.
- AC-2 (price path requires privilege; whole-call refusal, nothing durable) → **PASS** — `supabase/tests/staff_receiving_gate.test.sql::(b)` (13 assertions). `throws_ok` pins `42501` for a staff caller sending `new_case_price: 40`; the suite then switches to the MASTER JWT to read past RLS and independently confirms all six durable targets are unchanged: `po_items.received_qty` still null, `inventory_items.current_stock` still 10, `inventory_items.case_price` still 20, `inventory_items.cost_per_unit` still 5, `item_vendors.case_price` still 20, `item_vendors.cost_per_unit` still 5, zero `audit_log` rows (neither action), `purchase_orders.receive_client_uuid` still null, `purchase_orders.status` still `sent`. This is a genuine read of real post-refusal table state, not a shape/exception-type-only check. The presence-not-value predicate is separately pinned: `new_case_price: 0` (would-be no-op for a privileged caller), `20` (equal-to-current), and `-1` (would-be P0001 abort) all raise the identical `42501` for the staff caller — proving the gate fires before any value-dependent branch is reachable by a non-privileged caller.
- AC-3 (privileged price path unchanged — regression) → **PASS** — `supabase/tests/staff_receiving_gate.test.sql::(c)` (7 assertions). Master caller's changed-price receive (`20→40`) updates BOTH `item_vendors.case_price/cost_per_unit` and `inventory_items.case_price/cost_per_unit` via the ★ formula (`40/4=10`), still increments stock 10→18, writes exactly one `'PO price change'` audit row, and the envelope's `price_changes[0].new_cost_per_unit = 10`. Byte-identical to spec 109 semantics.
- AC-4 (idempotency / replay unaffected) → **PASS** — `supabase/tests/staff_receiving_gate.test.sql::(d)` (7 assertions). First stock-only receive (4/4, fixed `client_uuid`) succeeds, stock 10→14. `lives_ok` on the replay with the SAME uuid + SAME stock-only lines (no priced line) asserts it does NOT raise — proving the gate is evaluated only on submitted lines, not spuriously refusing a no-price replay. The replay then returns `conflict: true`, `price_changes: []`, stock STILL 14 (not double-incremented), `received_qty` still 4, and exactly one `'PO received'` audit row (not two).
- AC-5 (re-CREATE is body-only, verbatim + one hunk) → **PASS** — independently diff-verified (not a pgTAP assertion, but directly checked by this reviewer): `diff` of `supabase/migrations/20260705000000_cost_on_receipt.sql:122-386` against `supabase/migrations/20260707000000_staff_receiving_price_gate.sql:114-393` shows the ONLY delta is the 15-line gate hunk (11 comment lines + 3-line guard + 1 blank), inserted exactly as the FIRST statement inside the §3b `if v_item_id is not null and v_line.new_case_price is not null then` branch, before the `< 0` check. Signature `(uuid, jsonb, uuid)` unchanged; no grant/revoke statements re-emitted; `SECURITY INVOKER` + `search_path = public` unchanged; no schema DDL; no policy statements; no `alter publication` statement anywhere in the file.

Backend — read surface (verify, no change):

- AC-6 (staff read needs no new policy) → **PASS** — `supabase/tests/staff_receiving_gate.test.sql::(e)` (4 assertions). As staff (`2222`, Frederick member): `SELECT`s Frederick's open POs (>0 rows) and a Frederick PO's `po_items` (>0 rows). A Charles PO + line is seeded as master (proving there IS a real row to be denied, not just empty data) — the same staff caller (NOT a Charles member) gets 0 rows on both the Charles `purchase_orders` SELECT and the Charles `po_items` SELECT. Confirms the existing `auth_can_see_store()` RLS admits the member and denies the non-member with no new policy required.

Frontend — staff Receiving screen:

- AC-7 (open-PO list + empty state) → **PASS** — `src/screens/staff/screens/Receiving.test.tsx` (`Receiving — open-PO list + empty state (AC-7)`, 4 tests): list renders two POs each with vendor name + status pill text (`SENT`/`PARTIAL`) via real DOM/testID queries; empty state renders when `fetchStaffOpenPos` resolves `[]` and the list testID is absent; loading state renders while the fetch is pending; a retry-able error pane renders on rejection and re-fetches on retry press. Native vs. web is not separately exercised (jest + RN Testing Library covers the shared RN render tree; no web-only DOM test exists) — see Notes.
- AC-8 (pick → prefilled lines) → **PASS** — `Receiving — pick → prefilled lines, no price surface (AC-8)` (3 tests). Picking a PO with `orderedQty: 10, receivedQty: 3` renders the "received now" input with `.props.value === '7'` (the real rendered prop, not a computed-and-discarded value); a fully-received line clamps to `'0'`; an empty-lines PO renders the no-line-items state. The R-1 belt: `queryByTestId('staff-receiving-price-poi-1')` and `queryByTestId('receiving-price-poi-1')` both assert `null` — no price testID exists anywhere in the render tree (independently confirmed by this reviewer reading `Receiving.tsx` in full: no price/cost field, testID, or style token appears anywhere in the file).
- AC-9 (commit — confirm, additive, partial allowed) → **PASS** — `Receiving — commit (AC-9/10)` (3 tests). Real `fireEvent.press`/`changeText` drives the confirm (`mockConfirm` called once) then `submitStaffReceive` with `deltas === [{poItemId:'poi-1',receivedQty:10},{poItemId:'poi-2',receivedQty:2}]` — a genuine partial (poi-1 keeps its 10-unit prefill, poi-2 overridden to 2) is sent, proving partial receives are allowed. Zero/blank rows are filtered from the actual payload. An all-zero commit shows the "nothing to receive" toast, never calls the RPC, and never invokes confirm.
- AC-10 (idempotent submit) → **PASS** — same test as AC-9: `mockUuid` (the mocked `uuidv4()`) is asserted `toHaveBeenCalledTimes(1)` per commit, and the minted uuid is asserted as the exact third arg passed to `submitStaffReceive`. The commit button's `disabled` prop includes `submitting` in `Receiving.tsx:577`.
- AC-11 (online-only gate — R-2) → **PASS** — `Receiving — online-only gate (AC-11)` (2 tests). `setMockOnline(false)` genuinely drives the mocked `useConnectionStatus()` hook return value (not a UI-only stub of a derived boolean); the test asserts BOTH the rendered offline banner testID AND `getByTestId('staff-receiving-commit').props.accessibilityState?.disabled === true`, then presses commit anyway and asserts `submitStaffReceive` is NOT called — proving the disabled state is load-bearing, not merely cosmetic. A second test flips online and re-renders, asserting the banner clears and `disabled === false`.
- AC-12 (success feedback + refresh) → **PASS** — `Receiving — success / error / replay (AC-12)` (3 tests). Success: asserts the `'Delivery received'` toast fires AND `fetchStaffOpenPos` is re-invoked with the store id AND the screen lands back on the (now-empty) list — a real re-fetch effect, not a mocked assertion of intent. Error: `submitStaffReceive` rejects with a simulated `42501`; asserts `notifyBackendError`'s toast (`text1: 'submitStaffReceive'`) fires, no success toast fires, and the typed input STILL reads `'6'` (the actual rendered prop) — proving no phantom success and no input reset. Replay: a `conflict: true` resolve is asserted to fire the SUCCESS toast (not an error toast) and refresh the list, with `submitStaffReceive` called exactly once (no re-submit loop).
- AC-13 (data path via carve-out) → **PASS** — verified two ways: (1) static — `grep` confirms no `src/lib/db.ts` import anywhere in `src/screens/staff/lib/receiving.ts`, `Receiving.tsx`, or their test files; `receiving.ts` uses plain `await supabase.from/.rpc` (no `useInflight.track()`). (2) behavioral — `src/screens/staff/lib/receiving.test.ts::submitStaffReceive` asserts the ACTUAL outgoing RPC payload (`args.p_lines`) has, per line, `Object.keys(line).sort()` equal to exactly `['po_item_id', 'received_qty']`, explicitly asserts `.not.toHaveProperty('new_case_price')` and `'newCasePrice'`, and belt-and-braces asserts `JSON.stringify(args)` contains no `/price/i` token anywhere in the full payload. This is the specific "R-1 belt" test requested — it is a genuine payload-content assertion, not a type-shape-only check (the TS type `StaffReceiveDelta` simply lacking a price field would not, by itself, catch a runtime bug where an extra key leaks into the object at the call site; this test would).
- AC-14 (no realtime) → **PASS** — verified statically: `grep -rn "realtime\|subscribe\|channel(" src/screens/staff/lib/receiving.ts src/screens/staff/screens/Receiving.tsx` returns no hits (checked directly by this reviewer). The migration contains no `alter publication` statement (confirmed in the AC-5 diff-check above), so the `docker restart supabase_realtime_imr-inventory` gotcha genuinely does not apply here — I ran the full pgTAP suite without a realtime restart and it passed cleanly, consistent with the spec's own claim.
- AC-15 (staff catalog ×3 locales) → **PASS** — independently verified by this reviewer via a Python key-diff script (not merely trusting the dev's claim): all three locale files (`en.json`, `es.json`, `zh-CN.json`) have IDENTICAL `receiving.*` key sets (35 keys, zero missing/extra in either direction), and every `{token}` placeholder in every `receiving.*` string is present with the identical token set across all three locales (zero mismatches). All keys named in the spec's required-list (tabLabel, title, subtitle, list.empty*, col.*, commit.*, offline.message, success.message, nothingToReceive.message, error.title/retry, loading, noLineItems) are present in `en.json`. Confirmed `git diff --stat src/i18n/` is empty — no admin catalog touched. Also covered generically by the pre-existing `src/screens/staff/i18n/i18n.test.ts` (parity + placeholder-token suite, 12 tests, all pass) which automatically extends to the new `receiving.*` block.

### Test run

Ran sequentially (pgTAP first, then jest, then both typechecks) against the running local Supabase stack (`npm run dev:db` already up; no realtime restart needed per AC-14 — this migration makes no publication change).

**`npm run test:db`** (`bash scripts/test-db.sh`, walks all `supabase/tests/*.test.sql`):
```
✓ 64/64 DB test file(s) passed
```
Full file list passed, notably:
- `supabase/tests/staff_receiving_gate.test.sql` — **45/45 assertions passed** (matches `select plan(45)`; re-ran this file standalone a second time to confirm determinism/hermeticity outside the full-suite context — still 45/45, no fixture bleed from other files).
- `supabase/tests/cost_on_receipt.test.sql` — **55/55 assertions passed** (the required spec-109 regression check; unaffected by the new gate hunk, confirming AC-3's byte-identical claim from a second independent angle).
- `supabase/tests/permissive_policy_lint.test.sql` — 4/4 passed (ran automatically; no allowlist edit needed or made, consistent with "no new policy").

No `purchase_orders` or `store_count_layouts` rows were created or deleted by this reviewer outside the hermetic `begin;…rollback;` test transactions; the full suite ran to completion twice without incident.

**`npx jest`** (full run, both jest projects — `unit` + `component`):
```
Test Suites: 92 passed, 92 total
Tests:       1031 passed, 1031 total
Snapshots:   0 total
```
Ran twice back-to-back for stability; both runs identical (92/92, 1031/1031). Isolated re-run of just the two new spec-113 files:
```
PASS unit      src/screens/staff/lib/receiving.test.ts       (15 tests)
PASS component src/screens/staff/screens/Receiving.test.tsx  (17 tests)
```
32 tests total across the two dedicated new files. The remaining ~12 of the claimed "44 new staff tests" are accounted for by: the pre-existing `src/screens/staff/i18n/i18n.test.ts` generic parity suite automatically extending coverage to the new `receiving.*` block (not spec-113-authored, but exercises it), plus incidental coverage the dev's own count may include. No dedicated `StaffStack.test.tsx` exists to unit-test the 4th-tab wiring by name — see Notes.

**Typechecks:**
```
npx tsc --noEmit                        → exit 0
npx tsc -p tsconfig.test.json --noEmit  → exit 0
```

**Static verification (this reviewer, independent of the dev's claims):**
- `diff` of the verbatim-copy source range vs. the new migration — confirms AC-5's "ONLY delta is the gate hunk" claim byte-for-byte (not just trusted from the migration header comment).
- `git diff app.json` — empty (hard-rule file untouched).
- `git diff src/lib/db.ts` — empty (no admin DB-access file touched).
- `git status --short` — confirms the changed/untracked file set matches exactly the spec's "Files changed" section (no admin file, no unexpected `supabase/` file, no unrelated staff screen touched beyond `StaffStack.tsx`'s additive tab wiring).
- Python key/placeholder-token diff across the three i18n locale files — 0 mismatches (ran independently of jest's own `i18n.test.ts`, as a second angle).
- `grep` for `realtime`/`subscribe`/`channel(` and `alter publication` — 0 hits in the new files/migration.

**Browser evidence (reported by main Claude, not independently re-driven by this reviewer):** staff partial→complete receive live on Frederick (stock 0→4→10, PO status sent→partial→received); a crafted priced staff RPC call returned 403/`42501` with nothing durable; no price UI rendered; console clean. This stands for the runtime/live-stack angle of the ACs above; my own verification was via the automated pgTAP/jest suites and static diffs, which is the harness this project's policy asks integration tests to hit (a real local Postgres, not mocks) — the pgTAP suite in particular already exercises the exact RPC end-to-end against real tables, so this is not a coverage gap, just two independent lines of evidence for the same claims.

### Notes

- **No dedicated `StaffStack.test.tsx` for the 4th-tab wiring.** The tab addition (`Receiving` name, `cube-outline` icon, `staff-tab-receiving` testID, `t('receiving.tabLabel')` label) is declarative JSX and was diff-verified by this reviewer to match the spec's OQ-2 resolution exactly, but there is no jest test asserting the tab renders/navigates by name. This is a low-severity gap (the screen behind the tab has 17 dedicated tests, and the wiring is three lines of additive, low-risk JSX identical in shape to the three sibling tabs which also have no dedicated nav-test) — not blocking, since AC-7 through AC-12 exercise the `Receiving` component directly and the mount point itself carries negligible logic. Flagging for completeness rather than treating as a FAIL.
- **Native (EAS) rendering of AC-7/8 is not separately exercised.** Per this project's own stated policy ("Native testing is harder and not yet set up — surface as a gap if the spec demands it"), the jest + `@testing-library/react-native` suite covers the shared React Native render tree that both web and native consume, which is the standard coverage level for this codebase's other staff screens (Reorder, WeeklyCount, EODCount) — no screen in this subtree has platform-specific jest coverage beyond this. Not a regression introduced by this spec; consistent with existing precedent. AC-7's "Works on react-native-web (Vercel) AND native (EAS)" claim rests on the shared-render-tree assumption plus the browser evidence (web) reported above; native-specific verification remains an open gap at the project level, not specific to spec 113.
- **Both hard-rule files respected.** `app.json` (`slug`) and `src/lib/db.ts` are untouched — confirmed via empty `git diff` on both, independent of trusting the "Files changed" section.
- **Framework discipline maintained.** All new tests land in the three existing tracks (pgTAP: 1 new file, 45 assertions; jest: 2 new files, 32 tests + incidental i18n-parity extension). No fourth framework introduced.
- **Prod-apply is correctly deferred and unauthorized by this reviewer.** The migration's own header documents the MCP-apply + `schema_migrations`-insert + post-apply `pg_get_functiondef` verification steps and states the developer does NOT push it themselves. This reviewer did not apply anything to prod and did not verify prod state — that remains user-gated per the spec's explicit instruction, consistent with the CLAUDE.md rule that `release-coordinator` must not recommend SHIP_READY until the user has authorized (or scheduled) the prod apply.
- **CI status not re-checked here.** This report covers local test-suite execution only; per CLAUDE.md's "CI status check after every push to main" rule, whoever pushes this branch should confirm both `test.yml` and `db-migrations-applied.yml` are green on `main` before treating this as fully verified in CI, separate from the local green results reported here.

All 15 acceptance criteria: **15 PASS, 0 FAIL, 0 NOT TESTED.**

## Resolution note (main Claude — 2026-07-04)

15/15 ACs PASS, nothing to fix. The one low-severity gap (no dedicated
StaffStack 4th-tab nav test) is accepted — the tab is 3 lines of declarative
JSX, hand-diffed by the reviewer and browser-verified live by main Claude
(the `staff-tab-receiving` testID rendered and navigated). The dead-i18n-key
trim (code-review Should-fix) does not change any test counts: jest 1031/1031,
test:db 64/64, both typechecks exit 0.
