## Test report for spec 149

All three gates were re-run independently in this session (not taken on the
developers' word): `npx tsc --noEmit`, `npm run typecheck:test`, full `npx
jest`, `npm run test:db`, the `extension/` vitest suite, and — beyond the
brief's ask — a **live** round trip against the running local stack (real
admin/staff JWTs, a real `create_order_approval` RPC call, and real HTTP
calls to the deployed `instacart-cart-link` edge function) to independently
verify claims that no static read of the code could confirm. Results below.

### Acceptance criteria status

**A. Notification**
- AC-1 (CHECK widened, additive) → PASS — `supabase/tests/order_ready_notifications.test.sql` (lives_ok on `order_ready` + all 7 legacy values, throws_ok on a bogus value)
- AC-2 (emit, deduped on `(type,source_id)`) → PASS — `supabase/tests/order_ready_notifications.test.sql`; re-run-is-no-op arm in `supabase/tests/submission_notifications.test.sql` (arm 10)
- AC-3 (no double ping; replaces `eod`) → PASS — `supabase/tests/order_ready_notifications.test.sql` (both branches) + `supabase/tests/submission_notifications.test.sql` arms 5a (no linked items ⇒ exactly one `eod`) / 5b (below-par linked item ⇒ exactly one `order_ready`, zero `eod`)
- AC-4 (badge rules preserved) → PASS — `src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx` ("an unread order_ready keeps the accent badge and an accent row dot"; "an unread missed_eod alongside an order_ready still wins the red badge"). Verified independently: `src/components/cmd/NotificationBell.tsx` and its test file have **zero diff** in this changeset (`git diff --cached` empty) — the four helpers are reused, not forked, exactly as the AC requires.
- AC-5 (row copy + i18n) → PASS — `PhoneNotifications.test.tsx` ("an order_ready row shows the vendor and deep-links..." asserts the literal `'Order ready to approve · Frederick'` text) + `src/i18n/i18n.test.ts` parity (re-ran: 38/38 green) + manually diffed all three catalogs (`en`/`es`/`zh-CN`) for `chrome.submissionBell.type.order_ready` — present in all three with matching key sets.
- AC-6 (deep link, marks read + navigates vendor/date-scoped) → PASS — `PhoneNotifications.test.tsx` (asserts `markRead` called + `pending.orderApproval` payload) and `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.acReg.test.tsx` ("Approve Order fork — AC-6 (deep link both directions)")
- AC-7 (push copy, no "submitted") → **NOT TESTED** — see Notes. Verified correct only by manual code read of `supabase/functions/submission-push-fanout/index.ts`.

**B. Approve Order screen**
- AC-8 (screen renders server-computed lines) → PASS — `PhoneApproveOrder.test.tsx` ("renders the vendor, the server line, and the totals line")
- AC-9 (steppers, case-aware, clamp ≥0) → PASS — `PhoneApproveOrder.test.tsx` ("reuses the spec-143 stepper: writes BASE units, clamped ≥ 0 (AC-9)")
- AC-10 (fee/markup disclosure, per channel) → PASS — `PhoneApproveOrder.test.tsx` (3 cases: catalog-cost copy, Instacart markup+fees copy, and the R-3 edge case where an `instacart`-flagged vendor with no retailer key still shows catalog-cost copy because it actually resolves to the cart-filler) + i18n parity
- AC-11 (one primary action) → PASS — `PhoneApproveOrder.test.tsx` ("renders exactly ONE primary button and no FILL CART competitor")
- AC-12 (a11y / phone-tier bar: full names, ≥44×44, no h-scroll, token-only theming) → PASS (by reuse-transitivity) — `LineStepper`/`VendorOrderCard` are **exported, not forked**, from `PhoneOrdering.tsx` (confirmed via diff: additive `export` keyword + additive `footer` prop defaulting to `'default'`); the existing `PhoneOrdering` suite (which pins these properties) stays green unmodified (re-ran: 9/9). No fresh independent a11y assertion exists in the new screen's own test file, but since AC-REG-1 pins byte-identical component output, the component-level guarantees carry over. Flagged as inherited, not freshly asserted.
- AC-13 (empty/stale/already-actioned states) → PASS — `PhoneApproveOrder.test.tsx` "AC-13 states" block: EMPTY, VENDOR ABSENT, COUNT CHANGED, ALREADY APPROVED, ALREADY ORDERED, CROSS-STORE, LOAD ERROR — all seven branches asserted with distinct copy + primary-button state.

**C. Per-vendor routing**
- AC-14 (channel resolution, data-driven, precedence pinned) → PASS — `supabase/tests/vendor_order_channel.test.sql` (all 8 truth-table rows + blank-key edge + unknown-vendor NULL + CHECK bound = 11 assertions) **and** `src/utils/orderChannel.test.ts` (the same 8 rows against the TS mirror, plus whitespace-key and unknown-literal edges) — both tracks independently pin the same truth table, matching the design's "shared fixture" instruction.
- AC-15 (Instacart channel, no fake success) → PASS — `src/store/useStore.approveOrder.spec149.test.ts` + `src/lib/db.mintInstacartCartLink.spec149.test.ts` ("a 2xx with no url is an error, not ok:true", etc.). **Live-verified**: I created a real `order_approvals` row via the RPC and called the deployed edge function against it — it correctly returned `409 {"ok":false,"error":"wrong_channel",...}` with a `correlationId` and no secret material in the body, matching the "never a silent fake success" contract end to end.
- AC-16 (WebstaurantStore channel, no API call) → PASS — `useStore.approveOrder.spec149.test.ts` ("webstaurant: opens the order page, records the approval, makes NO api call"; "refuses instead of half-approving" when no order page is configured)
- AC-17 (extension channel, frozen contract) → PASS — `useStore.approveOrder.spec149.test.ts` ("extension: runs the UNCHANGED spec-138 fillCartForVendor handoff (AC-REG-3)") + independently re-ran the **Chrome extension's own vitest suite** (`extension/`, `npm test`): 31/31 green, and `git diff --stat -- extension/` is empty — the frozen build truly wasn't touched.
- AC-18 (manual channel, no new export builders) → PASS — `useStore.approveOrder.spec149.test.ts` ("manual: runs the EXISTING quick-order share path, then approves"; "a DISMISSED share does not advance the approval")

**D. Backend / audit trail**
- AC-19 (`order_approvals` shape) → PASS — `supabase/tests/order_approvals.test.sql` (S1 table exists, S2 idempotency unique index exists, S3 zero DELETE policies). Live-verified: I called `create_order_approval` directly via a real RPC POST and got back the full documented row shape (all 14 columns, correct snake_case keys later mapped by `db.ts`).
- AC-20 (status transitions guarded) → PASS — `order_approvals.test.sql` guard arms G1–G6: `pending→ordered` rejected (P0001), `approved→pending` rejected, identity columns always-immutable, `pending→approved` succeeds with `external_ref` write, line snapshot frozen once non-pending, `approved→ordered` auto-sets `ordered_at`.
- AC-21 (RLS, per-store) → PASS — `order_approvals.test.sql` R1–R4: store-linked non-privileged user sees 0 rows and is refused on INSERT (42501), a privileged caller is refused for a store they can't see (cross-brand, 42501), DELETE is a 0-row no-op even for the owning admin. `supabase/tests/permissive_policy_lint.test.sql` stayed green in the full run (4/4) with **no allowlist edit**, confirming the three `order_approvals` policies are non-trivial conjunctions.
- AC-22 (edge function holds the API key) → PASS (verified by direct inspection) — `grep -rn "connect.instacart" src/` returns only the rule-reminder comment in `db.ts`; no client-side fetch exists anywhere under `src/`. The key is read via `Deno.env.get` inside `instacart-cart-link/index.ts` only.
- AC-23 (role gate) → PASS — code contains `ADMIN_ROLES` + `requireAdminCaller()` mirroring the `delete-user` reference shape. **Live-verified**: I signed in as a real non-privileged local user (`manager@local.test`, role `user`) and POSTed to the deployed function — got `403 {"error":"forbidden"}`.
- AC-24 (store-scope gate, no client-trust) → PASS — code builds a caller-token client and reads the approval through RLS. **Live-verified**: a cross-store/unknown `approvalId` against the deployed function returned `404 {"error":"approval not found"}`, before any upstream contact.
- AC-25 (client call path via `callEdgeFunction`/`invoke`) → PASS — `src/lib/db.ts`'s `mintInstacartCartLink` uses `supabase.functions.invoke(...)`, the documented exception for structured-body needs (matching the `fetchBreadbotSales` precedent), never a bare `fetch`.
- AC-26 (no HTML surface) → PASS (by inspection) — function returns JSON only; explicitly called out in a header comment as the spec asked.
- AC-27 (input validation) → PASS — `order_approvals.test.sql` (C5: `qty_base = 0` refused with `22023`, nothing written) exercises the RPC-side mirror; the edge-function-side validation is code-reviewed (line-count bound, quantity `>0` and `≤9999`, name length bound) but not independently exercised live in this session beyond the structural checks above.

**E. Regression group**
- AC-REG-1 (PhoneOrdering unchanged) → PASS — re-ran `PhoneOrdering.test.tsx` + `PhoneOrdering.acReg.test.tsx`: 9/9 green, unmodified per git diff of the test files. Diff of `PhoneOrdering.tsx` itself is additive-only (`export` added to two components; `footer` prop is optional, defaults to `'default'`, and the default path's JSX is unchanged).
- AC-REG-2 (desktop/tablet byte-unchanged) → PASS — `PhoneApproveOrder.acReg.test.tsx` ("desktop renders the desktop tree even with an approval pending", "tablet also stays on the desktop tree..."). Independently read the `ReorderSection.tsx` and `InventoryDesktopLayout.tsx` diffs: the new hook (`usePaletteAction` read) sits with the other hooks above the `isPhone` guard (guard-after-hooks preserved), and the `InventoryDesktopLayout` consume-deferral is a boolean-condition edit only, no render change.
- AC-REG-3 (extension contract frozen) → PASS — `extension/` has zero diff; extension's own vitest suite (31/31) re-run and green; `supabase/migrations/20260723000000_extension_ordering.sql` untouched.
- AC-REG-4 (spec-121 badge rule) → PASS — same evidence as AC-4.
- AC-REG-5 (staff surface untouched) → PASS — `src/screens/staff/` does not appear anywhere in `git status --short`; zero files touched.

**F. Tests**
- AC-28 (jest) → PASS — full suite re-run: **178 suites / 1739 tests, all green** (matches the developer's claimed numbers exactly). Every sub-item the AC lists (render, stepper, disclosure, channel routing, badge/dot, deep-link, stale states, acReg fork) has a concrete test, enumerated above.
- AC-29 (pgTAP) → PASS — full suite re-run: **79/79 files pass** (matches claimed numbers), including the three new suites (`order_ready_notifications.test.sql`, `order_approvals.test.sql`, `vendor_order_channel.test.sql`) and the modified `submission_notifications.test.sql` (12 assertions, the 5a/5b split).
- AC-30 (shell smoke) → PASS (structurally verified) — `scripts/smoke-instacart-cart-link.sh` exists, is executable, `bash -n` syntax-checks clean, and I ran it **live** against the local stack rather than only reading it: CORS preflight (200 + headers) PASS, no-auth POST → 401 PASS, non-privileged JWT → 403 `forbidden` PASS, cross-store `approvalId` → 404 `approval not found` PASS. The remaining two checks (happy-path 200 mint and forced-502 upstream) legitimately SKIP without `INSTACART_IDP_API_KEY` + a real `instacart`-channel `approvalId` — this matches the script's own documented behavior and the spec's own framing of OQ-2/the retailer probe as an **operator gate**, not a CI-automatable check. Confirmed not wired into CI (no reference to it in `.github/workflows/`).

### Test run

```
npx tsc --noEmit                → clean, no output
npm run typecheck:test          → clean, no output
npx jest                        → 178 suites / 1739 tests passed, 2 snapshots passed, 5.8s
npm run test:db                 → 79/79 DB test file(s) passed
extension/: npm test (vitest)   → 5 files / 31 tests passed
bash -n scripts/smoke-instacart-cart-link.sh → syntax OK
scripts/smoke-instacart-cart-link.sh all (live, local stack, real admin+staff JWTs)
  → preflight PASS, no-auth 401 PASS, non-privileged 403 PASS, cross-store 404 PASS,
    retailer probe / happy-path mint / forced-502 SKIP (no INSTACART_IDP_API_KEY — expected)
Live curl against deployed instacart-cart-link with a real order_approvals row (channel=manual)
  → 409 {"ok":false,"error":"wrong_channel","channel":"manual","correlationId":"..."} — no fake success, no secret leak
```

All numbers match what the implementers' handoff claimed; I did not take those claims on faith — every gate above was re-executed in this session, and the edge-function/RPC claims were additionally cross-checked with live HTTP calls I made myself against the running local stack (not just reading the test files).

### Notes

1. **Gap — AC-7 has no automated test in any track (jest / pgTAP / shell smoke).**
   `supabase/functions/submission-push-fanout/index.ts`'s new `isOrderReady`
   branch (title "Order ready to approve", body `"<store> · <vendor>"`, and
   the "must not contain 'submitted'" requirement) is not exercised by
   anything I could find. This is genuinely a criterion with zero test
   coverage, so per the review rules I'm marking it **NOT TESTED**, which
   the release-coordinator should treat as a Critical-severity finding for
   ship purposes. Mitigating context, not an excuse: this is a **pre-existing
   infrastructure gap**, not something spec 149 introduced — the `isMiss`
   (spec 121) and `isIssue` (spec 126) branches in the same function have
   *also* never had test coverage in any track, and there is no test harness
   anywhere in the repo for Deno functions with `verify_jwt = false` /
   pg_net-cron-invoked functions (unlike `verify_jwt = true` functions, which
   get shell-smoke coverage the way `instacart-cart-link` now does). The fix
   is either (a) a small jest-testable pure-function extraction of the
   title/body derivation logic out of the Deno handler, mirrored the way
   `src/utils/escapeHtml.ts` mirrors the Deno `escapeHtml()` helpers, or (b)
   a new shell smoke against `submission-push-fanout` directly. Either is a
   real, scoped fix — not a redesign — and I'd recommend the PM decide
   whether it blocks this ship or becomes an immediate fast-follow, given the
   low blast radius (wrong push copy is cosmetic, not a security or data
   issue) versus the "every AC needs a test" rule this project holds itself to.

2. **Should-fix — new vendor/store config UI has no test coverage.**
   `VendorFormDrawer.tsx`'s new ORDER CHANNEL segmented control + INSTACART
   RETAILER KEY input, and `StoreFormDrawer.tsx`'s new POSTAL CODE input
   (§7.6 / R-8, the "flagged scope addition"), have zero jest coverage —
   `VendorFormDrawer.test.tsx` wasn't touched, and `StoreFormDrawer` has no
   test file at all (pre-existing gap, not introduced here). This isn't tied
   to a single numbered AC (AC-14 is about the *resolution* logic, which
   pgTAP + jest both pin thoroughly), but it's the only UI surface an
   operator has to actually set the data AC-14 depends on, so a typo in the
   field wiring (e.g. wrong key name in `toUpdates`) would ship silently.
   Not a Critical, but worth a fast-follow.

3. **Should-fix — the `db.ts` snake_case→camelCase mapping for the new
   surfaces (`mapOrderApproval`, `mapOrderApprovalLine`, and `mapVendor`'s two
   new fields) has no direct jest unit test.** `useStore.approveOrder.spec149.test.ts`
   mocks the `db` module entirely (by design, matching the
   `fillCartForVendor` precedent), so the actual JS translation layer is
   untested at the jest level. I partially closed this gap myself by calling
   the real RPC via curl and confirming the raw (snake_case) shape PostgREST
   returns matches what `mapOrderApproval` expects to consume — but the JS
   mapper itself (property renames, the `external_ref_expires_at →
   externalRefExpiresAt` etc. renames) was not exercised through actual
   TypeScript code in this session. Low risk (this file follows a
   well-established `mapItem`-style convention elsewhere in `db.ts`), but
   flagging per the rule that implementation-adjacent glue code with no test
   is exactly the kind of thing that silently drifts.

4. **Not a test gap, but must be carried into the release decision (per the
   spec's own flag) — the Instacart retailer-pinning field does not exist in
   the live IDP API.** The implementers' "IDP contract reconciliation" section
   documents that `products_link` has no `retailer_key`/`retailer_id`
   parameter as of the 2026-08-01 doc check, contradicting §5.4's original
   assumption. This means if the `instacart` channel is ever turned on for a
   vendor, the admin would land on a shopping list where **they pick the
   retailer themselves** rather than a pre-pinned cart — a real product-level
   deviation from the PM summary's "opens an Instacart cart that is already
   filled" framing. It does not block this ship because the recommended
   posture (leave `order_channel` NULL on BJ's/Sam's) means the Instacart
   channel is dark at ship time and behavior is identical to today (R-3
   resolves to `extension`). This is a PM decision, not a test-engineer
   finding, but the release-coordinator should not let it get lost.

5. **Prod migration state (not a test gap, a deploy-checklist item).** The
   three `20260801*` migrations are applied and pgTAP-verified against the
   **local** stack only. Per project policy, prod apply must go through the
   Supabase MCP `execute_sql` path with an explicit
   `schema_migrations` insert — `db-migrations-applied.yml` will read red
   until that happens. This is expected per the spec's own §10.5 and must be
   flagged to the user/release-coordinator, not silently "fixed" by anyone.

6. **CI gates not yet independently confirmable on `main`** — this changeset
   is still staged/uncommitted in the working tree (per `git status`), so
   there is no GitHub Actions run yet to check for this exact commit. My
   local reproduction of `test.yml`'s two jobs (jest + pgTAP) both went
   green, matching the numbers the implementers claimed, but the
   release-coordinator should still confirm the actual CI run once this is
   pushed, per the CLAUDE.md CI-status-after-push rule.

7. **No framework drift.** All new tests landed in the three existing tracks
   (jest, pgTAP, shell smoke) exactly as spec 022 requires. The
   `extension/` package's pre-existing vitest suite (established in specs
   131/132, before spec 022's three-track policy applied to this repo) was
   not touched and is not a new framework introduced by this spec — it's a
   separate, already-existing sub-package with its own toolchain, and I
   re-ran it only to independently verify AC-REG-3, not because it's a
   fourth track added here.
