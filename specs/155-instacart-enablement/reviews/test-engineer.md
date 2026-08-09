## Test report for spec 155

Tree verified at working-tree state on top of `74ffabe` (branch `main`, nothing
committed — 21 files staged/modified per `git status`). Spec 156
(`specs/156-export-order-recording.md`) is present in the same working tree
but is **spec-doc only** — `git diff --stat` shows zero touched `src/`,
`supabase/`, or `scripts/` files for 156; every gate below is attributable
entirely to spec 155's diff.

### Acceptance criteria status

**A. Store ZIP edit surface (DG-2)**

- AC-1 (edit mode) → PASS — `src/components/cmd/StoreFormDrawer.test.tsx::StoreFormDrawer — edit mode (spec 155 AC-1)` (prefill, EDIT badge, SAVE primary, re-seed on a different row); create-path output/`addStore` payload unchanged, verified against the 7 pre-existing create-mode cases in the same file (unmodified).
- AC-2 (affordance) → PASS — `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx::StoresTab EDIT affordance (spec 155 AC-2)` (per-row `store-edit-<id>` testID, `Edit store <name>` a11y label, `hitSlop:{top:11,bottom:11,left:8,right:8}` ⇒ ≥44×44 effective, ACTIVATE/DEACTIVATE + row content untouched). `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx` confirmed byte-identical (`git diff` = 0 lines) and passes green.
- AC-3 (ZIP validation, shared) → PASS — `src/utils/postalCode.test.ts` pins the full truth table verbatim (incl. `'21204-12'`, `'212045'`, `'21204 1234'`, null/undefined/whitespace); `StoreFormDrawer.test.tsx::shared ZIP validation (spec 155 AC-3)` proves the same validator gates both create and edit paths, with the deliberate create-path behavior delta (AC-REG-1-authorized) called out and not folded into the `n/1 required valid` counter.
- AC-4 (it actually persists — the ★ gotcha) → PASS — `src/store/useStore.updateStore.test.ts::useStore.updateStore — spec 155 postalCode (AC-4)` asserts exactly one `db.updateStore` call carrying `postalCode:'21204'` and a subsequent read reflecting it; `src/store/useStore.ts:3126-3169` shows the literal widened to five named fields (`postalCode` added, `weeklyCountDueDow` still dropped, no spread) and the return type changed to `Promise<boolean>` (never rejects). `StoreFormDrawer.test.tsx::★ saves through useStore.updateStore EXACTLY ONCE with the ZIP (AC-4)` pins it at the component seam too.
- AC-5 (list reflects the edit) → PASS — `StoresTab.edit.test.tsx::StoresTab EDIT → onSaved (spec 155 AC-5 / AC-7)::patches the row in place and re-reads AFTER the resolved write`. Implementation deliberately overrides the PM's `[refresh, drawerOpen]`-effect parenthetical (documented in spec §5.3) with a deterministic `onSaved(patch)` → optimistic row patch → `refresh()` sequence that runs only after the write settles, avoiding the spec-094 refetch race. This is a documented, spec-authorized design decision, not a deviation to flag.
- AC-6 (failure is honest) → PASS — `StoreFormDrawer.test.tsx::a REFUSED write keeps the drawer open... (AC-6)` (updateStore resolves `false` ⇒ drawer stays open, input intact, no success toast) plus `useStore.updateStore.test.ts::resolves FALSE (never rejects) after the revert + notifyBackendError`.
- AC-7 (no new backend surface) → PASS — `git diff --stat HEAD -- supabase/migrations/ supabase/config.toml` is empty; no RLS/RPC change. RLS 0-row-PATCH-as-drift path is exercised by `StoresTab.edit.test.tsx::an RLS 0-row no-op snaps the row back to the server value (no fake success)`.

**B. DG-1 picker disclosure**

- AC-8 (the string) → PASS — `section.approveOrder.instacartPicker` present in `src/i18n/en.json`, `es.json`, `zh-CN.json` (verified directly); `src/i18n/i18n.test.ts` (parity suite) green, unmodified; `src/screens/staff/i18n/*` untouched (confirmed via `git diff --stat`).
- AC-9 (copy) → PASS — en source verbatim `"Opens in Instacart — pick your store there (e.g. BJ's), then check out."`; es/zh-CN mirror the meaning (verified by direct read, not literal gloss).
- AC-10 (render, instacart only) → PASS — `PhoneApproveOrder.test.tsx` render-arm cases assert `phone-approve-disclosure` contains both lines only for `instacart`, and is byte-unchanged (`disclosureCatalog` alone) for `webstaurant`/`extension`/`manual`.
- AC-11 (contract, pinned) → PASS — `disclosureKeyForChannel` replaced by `disclosureKeysForChannel(channel): string[]` (`PhoneApproveOrder.tsx:95-98`); `PhoneApproveOrder.test.tsx::disclosureKeysForChannel — AC-10 / spec 155 AC-11` pins instacart ⇒ `['…disclosureInstacart','…instacartPicker']` in that order, every other channel ⇒ `['…disclosureCatalog']`.
- AC-12 (still first-class) → PASS — `phone-approve-disclosure` remains a bordered block directly above the single primary button, no `numberOfLines`/chevron, `gap:6` (visually inert for single-child case); confirmed by source read of `PhoneApproveOrder.tsx:440-465`. No live-browser 390px-width scroll check was performed (see Notes).

**C. §5.5 retailer probe → advisory**

- AC-13 (no ZIP no longer refuses) → PASS — `instacart-cart-link/index.ts:448-454`: null/blank `postalCode` skips the probe entirely and sets `advisory='no_postal_code'`; the old 409 short-circuit is gone (confirmed by reading the reordered validation block). Wire-level exercised by the updated `scripts/smoke-instacart-cart-link.sh` step 8 (script parses cleanly, `bash -n` clean; arms match the design table — see Test run notes for live-run caveat).
- AC-14 (key-not-in-market no longer refuses) → PASS — `index.ts:499-510`, mints anyway with `advisory='retailer_not_in_zip'`, rationale recorded in the DRIFT #3 header block; smoke step 9 matches.
- AC-15 (probe failure no longer refuses) → PASS — `index.ts:461-517`: the entire probe (fetch + `.json()` + key-set construction) is wrapped in one local `try/catch` so an `UpstreamTimeout` on the probe cannot reach the outer 504 handler (the exact Critical risk called out in spec §11 risk 2); `products_link`'s own 502/504 paths are unchanged (confirmed unchanged in `index.ts`, smoke step 6 asserts this explicitly). Smoke step 10 matches the advisory arm.
- AC-16 (opt-in token still required) → PASS — `index.ts:414-427`: blank `retailerKey` still returns 409 `retailer_unavailable` + `fallbackChannel`, plus new non-load-bearing `reason:'blank_retailer_key'` and a distinct log line; smoke step 7 asserts both the preserved wire token and the new `reason` field.
- AC-17 (advisory surfaces to the human) → PASS — `useStore.ts:3703-3720` (`ADVISORY_TOAST_KEY` lookup, `type:'info'` toast fired before `openExternalOrderUrl`, link always opens); `useStore.approveOrder.spec149.test.ts::approveAndOrder — advisory toasts (spec 155 AC-17)` exercises all three tokens (`it.each`), asserts exactly one info toast per case, the link still opens, the approval still re-reads, and a clean-probe case produces zero extra toasts.
- AC-18 (deploy-skew safety — the client 409 branch stays) → PASS — `useStore.ts:3734-3761` (`retailer_unavailable && allowFallback` branch) confirmed present with unchanged shape; `useStore.approveOrder.spec149.test.ts::approveAndOrder — retailer_unavailable fallback (OQ-2)` (2 cases) pass unmodified alongside the new advisory describe block.
- AC-19 (retailer key documented as advisory) → PASS — `instacart-cart-link/index.ts` header `DRIFT #3` block rewritten (verified by read: escalation-accepted framing, "advisory metadata + explicit opt-in token, NOT a pinning mechanism", R-3 precedence restated); `section.vendors.instacartRetailerKeyHelp` revised in all three admin catalogs (verified directly) and rendered unchanged at `VendorFormDrawer.tsx:497` (file confirmed untouched via `git diff --stat`). No migration shipped (OQ-4 default upheld, confirmed empty `supabase/migrations/` diff).
- AC-20 (secret handling unchanged) → PASS — `Deno.env.get` is still the only read path (grep-confirmed); no plaintext key logging found; the sole `connect.instacart.com` string under `src/` is a header **comment** in `db.ts:2338` restating the invariant, not a fetch call (verified by reading context — no client-side fetch exists). `verify_jwt = true` / `ADMIN_ROLES` / `requireAdminCaller()` / caller-token scoping / 404-before-upstream-contact confirmed unchanged by empty `git diff` on `supabase/config.toml` and unmoved gate code in `index.ts`.

**D. Go-live runbook**

- AC-21 → PASS — the "Go-live runbook" section (spec §"Go-live runbook (operational — documentation, not code)") is present, ordered, and executable: key acquisition (flagged OWNER-only), secret set+verify, ZIP entry, retailer-key discovery, per-vendor opt-in, end-to-end verification, one-action rollback, and an emergency kill switch. Documentation-only, as the AC requires; `scripts/smoke-instacart-cart-link.sh` was updated in place (not replaced) per the AC's explicit constraint.

**E. Regression group**

- AC-REG-1 (create path frozen) → PASS — the 7 pre-existing create-mode `StoreFormDrawer.test.tsx` cases are present unmodified and green (verified by reading the file: no create-mode assertion text changed) with only additive edit-mode + shared-validator describes appended.
- AC-REG-2 (R-3 precedence frozen) → PASS — `src/utils/orderChannel.ts` and `orderChannel.test.ts` show zero diff (`git diff --stat` empty) and pass; `supabase/tests/vendor_order_channel.test.sql` shows zero diff and passes with its original 11 assertions (pgTAP run below).
- AC-REG-3 (other channels byte-unchanged) → PASS — `extension/` shows zero diff; `openExternalUrl.test.ts`, `poQuickOrderText.test.ts`, `fillCartForVendor.spec138.test.ts` all pass unmodified (confirmed present and green in the jest run).
- AC-REG-4 (spec-149 approve flow otherwise unchanged) → PASS — `supabase/tests/order_approvals.test.sql` shows zero diff and passes with its original 24 assertions; `db.orderApprovalMappers.spec149.test.ts` passes unmodified.
- AC-REG-5 (staff untouched) → PASS — `git diff --stat HEAD -- src/screens/staff/` is empty; `src/screens/staff/i18n/*` unmodified.
- AC-REG-6 (desktop/tablet) → PASS by inspection — the only render-tree deltas outside the frozen spec-149 tree are the additive `StoresTab` EDIT button and the drawer's edit mode, both explicitly carved out of the freeze. No live-browser desktop/tablet pass was performed (see Notes).
- AC-REG-7 (`app.json`) → PASS — `git diff --stat HEAD -- app.json` is empty.

**F. Tests (spec 022 tracks)**

- AC-22 (jest) → PASS — see Test run. All named test files present, additive-only where required, and green.
- AC-23 (pgTAP) → PASS — see Test run. 80/80 DB test files pass; `vendor_order_channel.test.sql` and `order_approvals.test.sql` are byte-unchanged (0-line diffs) and their original assertion counts (11 and 24 respectively) are unchanged, confirming no new arms were added and nothing regressed. No migration shipped, so `db-migrations-applied` has nothing to react to for this spec.
- AC-24 (shell smoke) → PASS (static verification; see caveat below) — `scripts/smoke-instacart-cart-link.sh` parses cleanly (`bash -n`) and its steps 7-10 match the design's advisory matrix exactly: step 7 blank-key → 409 + `reason:blank_retailer_key` (unchanged wire token, AC-16/AC-18); step 8 null ZIP → 200 `advisory:no_postal_code` (AC-13); step 9 unknown key → 200 `advisory:retailer_not_in_zip` (AC-14); step 10 probe 5xx/hang → 200 `advisory:retailers_probe_failed`, explicitly asserted NOT 502/504 (AC-15); unchanged arms (CORS preflight, 401, 403 no-upstream-call, 404 cross-store, forced `products_link` non-2xx → 502) are present and untouched. The spec's implementation record states the backend half ran this script live against a stubbed upstream during development — I did not re-run it live in this review (no `INSTACART_IDP_API_KEY`/fixture approval rows were provisioned in this session); treating the developer's live run as documented manual evidence per task instructions, and my own static parse + line-by-line comparison against the design's advisory matrix (§3.2 table) as the independent check. Script remains correctly NOT wired into CI, as designed.

### Test run

```
npx tsc --noEmit                    → clean, 0 errors
npm run typecheck:test              → clean, 0 errors
npx jest                            → 198 suites / 2134 tests, all green (matches the implementer's recorded gate output exactly)
npm run test:db (pgTAP, local stack)→ 80/80 DB test files pass
```

Targeted greps confirming every spec-155-named test file actually ran and
passed inside the full jest run (not run in isolation):

```
PASS component src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx
PASS component src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx
PASS component src/components/cmd/StoreFormDrawer.test.tsx
PASS component src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx
PASS unit src/i18n/i18n.test.ts
PASS unit src/store/useStore.approveOrder.spec149.test.ts
PASS unit src/lib/db.mintInstacartCartLink.spec149.test.ts
PASS unit src/utils/postalCode.test.ts
PASS unit src/lib/db.updateStore.test.ts
PASS unit src/utils/orderChannel.test.ts
```

pgTAP arms relevant to the regression freeze, both with zero source diff and
unchanged assertion counts:

```
== supabase/tests/vendor_order_channel.test.sql ==  PASS (11 assertions)
== supabase/tests/order_approvals.test.sql ==        PASS (24 assertions)
```

No failures encountered anywhere in this review. Nothing was pushed to
`main` during this review, so the CLAUDE.md "CI status check after every
push to main" rule does not apply — the two gates (`test.yml`,
`db-migrations-applied.yml`) were not re-checked against a new push.

### Notes

- **Spec-156 contamination check.** `specs/156-export-order-recording.md` is a
  new spec-doc file only (Status: READY_FOR_ARCH, not yet built). `git diff
  --stat` against every `src/`, `supabase/`, and `scripts/` path touched by
  155 shows zero overlap with any 156 file — none exist yet outside the spec
  doc itself. All gate results above are attributable to spec 155's diff with
  no ambiguity.
- **No live browser pass on the drawer.** The implementer's own "Gates"
  section says explicitly that interactive `preview_*` browser verification
  was not possible in that run, and recommends a human pass through Brands →
  Stores → EDIT before merge. I did not perform a live browser/preview pass
  in this review either — all UI-shape claims (EDIT badge, hitSlop effective
  target, 390px no-horizontal-scroll for the two-line disclosure block, AC-12
  "still first-class" bordered-block styling) are verified by source read +
  RTL component tests, not by rendering the app in a real browser or on a
  phone-width viewport. Flagging this as an open gap rather than a blocker:
  the RTL suites assert the DOM/props shape thoroughly (testID, a11y label,
  hitSlop values, text content, badge text), but do not catch a CSS layout
  regression (e.g., actual wrap/overflow behavior at 390px, or the hitSlop
  visually not landing where expected). Recommend a manual pass before
  merge, consistent with the implementer's own recommendation.
- **AC-24 shell smoke — static verification only in this pass.** Per the
  dispatch instructions, I confirmed the script parses (`bash -n`) and that
  every arm's expected status/body matches the design's §3.2 status/token
  table and §10 Track-3 test plan line-by-line. I did not execute it live
  against a running local `instacart-cart-link` function in this review
  (would require `INSTACART_IDP_API_KEY`, `ADMIN_TOKEN`, and four
  purpose-built `order_approvals` fixture rows — blank-key vendor, null-ZIP
  store, unknown-retailer-key vendor, and a probe-failure stub target — none
  of which exist in the local seed by default). The spec's own "Files
  changed — BACKEND half" section records that the implementing agent did
  run it live against a stubbed upstream during development; per task
  instructions I am treating that as documented manual evidence rather than
  re-deriving it, since AC-24 explicitly designates this track as
  manual/non-CI. This does not block SHIP_READY on its own, but it is the
  one AC in this spec whose live behavior was not independently re-observed
  by test-engineer.
- **No framework drift.** All new tests landed in the existing three
  spec-022 tracks (jest, pgTAP, shell smoke) plus the existing spec-078
  Playwright Track 4 was not touched or needed. No new test framework was
  introduced.
- **CLAUDE.md hard rules respected.** `app.json` slug untouched; no commits
  were made or requested during this review; no `supabase_realtime`
  publication membership changed, so no `docker restart
  supabase_realtime_imr-inventory` step was needed or performed.
