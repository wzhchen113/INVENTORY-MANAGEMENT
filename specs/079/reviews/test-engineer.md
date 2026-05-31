## Test report for spec 079

### Acceptance criteria status

#### P1 — Spec-072 scroll guard + EOD persistence + flake-proofing pass

**Spec-072 scroll guard:**

- AC-072-1: Submit button (`eod-submit`) is within viewport bounds at a 375×812 mobile viewport → PASS — `e2e/eod.spec.ts::AC-072: Submit stays in-viewport; list scrolls internally, body does not` (line 265-268: `box!.y + box!.height <= viewport.height + 1`)
- AC-072-2: Items list is the internal scroll container, not the document body (`overflow-y auto/scroll`, `scrollHeight > clientHeight`, body does NOT body-scroll) → PASS — same test (lines 259-276: three sub-assertions present, tripwire `scrollH > clientH` fires first per design §1)
- AC-072-SEL: Stable `testID="eod-item-list"` on the populated FlatList in `EODCount.tsx` → PASS — `src/screens/staff/screens/EODCount.tsx:523` confirmed; targeted at `list = page.getByTestId('eod-item-list')` in the spec

**EOD submit persistence:**

- AC-EOD-PERSIST-1: After online submit, reload the same (store, vendor, today) and assert `eod-prefill-banner` is visible (UI-only primary) → PASS — `e2e/eod.spec.ts::AC-EOD1 + AC-EOD-PERSIST` (lines 143-144). Sync point is the in-place banner appearance (design correction 2 — `queue-indicator` was vacuous for online path; banner in-place is the deterministic RPC-landed signal)
- AC-EOD-PERSIST-2: ONE service-role read of `eod_submissions` for (Towson, today, US FOOD) asserting row presence + matching entry → PASS — `e2e/eod.spec.ts` lines 154-166, via `serviceRoleClient()` from `e2e/fixtures/db.ts`. Keyed off `(store_id, date, vendor_id)` tuple with `.maybeSingle()`
- AC-EOD-PERSIST-3: Persistence read keys off THIS run's submitted value (`7`), not an absolute row count; idempotent across re-runs via upsert → PASS — `e2e/eod.spec.ts:175`: `expect(Number(entry!.actual_remaining)).toBe(7)`. Scoped to (Towson, today, US FOOD); online case fills `'7'`, offline fills `'5'` (distinct values, design ordering call-out honored)

**Flake-proofing pass:**

- AC-FLAKE-1: All 7 existing v1 specs audited; text-based sidebar nav replaced with `SIDEBAR_NAV` testID map; no fixed sleeps anywhere → PASS. Confirmed:
  - `dashboard.spec.ts`: `getByTestId(SIDEBAR_NAV.dashboard)` (line 24)
  - `reorder.spec.ts`: `getByTestId(SIDEBAR_NAV.reorder)` (line 41)
  - `audit.spec.ts`: `getByTestId(SIDEBAR_NAV.auditLog)` (line 22)
  - `invite.spec.ts`: `getByTestId(SIDEBAR_NAV.users)` (line 56)
  - `SIDEBAR_LABEL` grep across all 5 affected specs/constants: 0 occurrences (fully retired)
  - Zero `waitForTimeout`/sleep across all 7 specs (grep confirmed)
  - `auth.spec.ts` and `dark-mode.spec.ts`: audited clean, no change (spec-documented)
- AC-FLAKE-2: Flake-pattern checklist (8 items) added to `tests/README.md` Track-4 section → PASS — `tests/README.md:617-653`: "Flake-proofing checklist (Track 4)" with all 8 items verbatim matching design §3
- AC-FLAKE-3: No behavioral assertion was changed — only navigation mechanism swapped (label-text → testID); `*-root` visibility checks are identical → PASS — verified by diff of assertion targets in each spec; only the `.click()` locator changed, not the destination checks
- AC-FLAKE-SEL: `testID={`nav-${item.id}`}` added to non-editMode `<TouchableOpacity>` in `TreeGroup.tsx` → PASS — `src/components/cmd/TreeGroup.tsx:133`; editMode branch correctly NOT instrumented

#### P2 — Invite durable-effect + Reorder action depth

- AC-INV-DEPTH-1: After invite drawer closes, assert run-unique email (`e2e-invite+<runId>@local.test`) renders in the Users list → PASS — `e2e/invite.spec.ts:92`: `await expect(page.getByText(email, { exact: false })).toBeVisible()`. Keyed off `uniqueInviteEmail()` (THIS run's email), never a row count. The one documented correct `getByText` in the suite (test-authored content, not chrome)
- AC-REORD-DEPTH-1: Refresh round-trip (guaranteed floor, outside `showExport` gate) + defensive export-gate check when payload is non-empty → PASS — `e2e/reorder.spec.ts:52-73`: clicks `reorder-refresh`, asserts `toHaveText('REFRESH', { timeout: 15_000 })` (loaded transition), section stays mounted; export buttons asserted only when `csv.isVisible()` is true (defensive `if` guard, architect risk #2 honored)
- AC-REORD-DEPTH-SEL: `reorder-export-csv` / `reorder-export-pdf` / `reorder-refresh` testIDs added to `ReorderSection.tsx` → PASS — `src/screens/cmd/sections/ReorderSection.tsx:627, 642, 659`

#### Cross-cutting

- AC-DOC-1: `tests/README.md` Track-4 updated with new behavioral coverage, service-role-read carve-out, `SIDEBAR_NAV` selector strategy, `fixtures/db.ts` layout entry, 8-point flake checklist, AC-PROMO1 restated unchanged → PASS — all items confirmed present in `tests/README.md:450-680`
- AC-CI-1: No `e2e.yml` workflow change; service-role key reused from existing export; all deepenings run inside the existing job → PASS — zero modifications to `.github/workflows/e2e.yml` confirmed; `db.ts` reads `SUPABASE_SERVICE_ROLE_KEY` identically to `global-setup.ts`
- AC-GREEN-1: Suite confirmed green by main Claude pre-handoff (14 passed) AND independently re-run by this reviewer (14 passed, `npx playwright test --project=chromium --project=setup`, exit 0) → PASS

#### Spec-074 window deferral

- The spec-074 Monday-reset dashboard-window E2E is **correctly out of scope**. No dashboard-window test exists in any `e2e/*.spec.ts` file (grep confirmed). The deferral rationale (date-keyed fixture complexity + pgTAP Towson collision + 8 existing jest tests) is recorded in `tests/README.md` and `specs/079-e2e-phase2-behavioral-depth.md §Out of scope`. Nothing in this spec accidentally took it on.

---

### Anti-vacuous audit

**AC-072 scroll guard — the key one:**

The `scrollH > clientH` tripwire (line 260) fires FIRST in the test body, before the Submit-in-viewport assertion (line 268) and the body-scroll negative (line 276). If the OQ-4 fixture stopped running (empty list), `scrollH > clientH` would fail loudly — not silently. If the viewport override (`test.use({ viewport: { width: 375, height: 812 } })`) were dropped, the 31-item US FOOD list at 1280×720 desktop height may not overshoot — the spec notes this as design §1 risk #1 — but the `scrollH > clientH` tripwire would fail if the list genuinely has no overflow (the comment at line 232 is explicit). This is load-bearing: the test cannot pass vacuously if the viewport override is absent because the list would not overshoot at desktop width and `scrollH > clientH` would fail. The nested `test.describe` scope of `test.use({ viewport })` correctly limits the mobile viewport to the scroll-guard test only; the online/offline submit cases run at default Desktop Chrome (no interference).

**AC-EOD-PERSIST-2 service-role read:**

The read filters on `(store_id, date, vendor_id)` and then asserts:
1. `.not.toBeNull()` — row existence
2. The `eod_entries` entry for the specific `itemId` (parsed from the input testid used in this run) is defined
3. `Number(entry!.actual_remaining)).toBe(7)` — the exact submitted value

Assertion 3 is the value-match. A pre-existing row from a prior run with a different filled value would fail assertion 3 — NOT vacuously pass. The `staff_submit_eod` upsert means a re-run with value `7` overwrites the prior run's row, so assertion 3 still holds. The only way this passes vacuously is if a prior run in the SAME session also submitted `7` to the same (store, date, vendor, item) — which cannot happen because each Playwright context has `beforeEach` queue-clearing and a fresh context per test.

**AC-INV-DEPTH-1:**

Keyed off `uniqueInviteEmail()` = `e2e-invite+<RUN_ID>@local.test` where `RUN_ID = process.env.GITHUB_RUN_ID ?? String(Date.now())`. A stale row from a prior run would have a different `RUN_ID` suffix and would not match `getByText(email)`. Not vacuous.

**AC-REORD-DEPTH-1:**

The `toHaveText('REFRESH', { timeout: 15_000 })` assertion would fail if Refresh stayed in a permanent `LOADING…` state (broken data fetch). The export-button assertion is conditional on `csv.isVisible()` — if no payload, the `if` branch is skipped and only the Refresh floor runs. This is correctly defensive per architect risk #2, not a weakness: the guaranteed floor (Refresh round-trip) is always asserted.

---

### Test run

```
# jest (Track 1)
npx jest --ci
Test Suites: 40 passed, 40 total
Tests:       386 passed, 386 total
Exit: 0

# pgTAP (Track 2)
bash scripts/test-db.sh
38/38 DB test file(s) passed
Exit: 0

# e2e TypeScript check
npx tsc --noEmit -p e2e/tsconfig.json
Exit: 0

# Playwright (Track 4)
npx playwright test --project=chromium --project=setup
✓ [setup] authenticate as admin
✓ [setup] authenticate as master
✓ [setup] authenticate as staff
✓ [chromium] dark-mode AC-DARK1
✓ [chromium] dashboard AC-DASH1
✓ [chromium] audit AC-AUDIT1
✓ [chromium] eod AC-EOD1 + AC-EOD-PERSIST (online submit persists)
✓ [chromium] auth AC-S1
✓ [chromium] invite AC-INV1/2 (with durable-effect)
✓ [chromium] auth AC-S2
✓ [chromium] auth AC-S3
✓ [chromium] reorder AC-REORD-DEPTH-1
✓ [chromium] eod AC-EOD2/3 (offline queue drain)
✓ [chromium] eod AC-072 (scroll guard)
14 passed (5.7s)
Exit: 0
```

---

### Notes

1. **Design correction 2 honored correctly.** The spec design §2 originally proposed synchronizing on `eod-queue-indicator.toHaveCount(0)` before the persistence reload. The BE dev's review note 2 (spec files-changed section) identified this as vacuously true for an online submit (item is never queued) — it would let a reload race the in-flight RPC. The implementation correctly waits on `eod-prefill-banner` appearing in-place instead, which is the deterministic "RPC landed + row server-readable" signal. This is within the design's intent and is a strengthening, not a deviation.

2. **`todayIso()` LOCAL vs UTC (design review note 1 honored).** The design §2 parenthetical noted "UTC YYYY-MM-DD" but `EODCount.todayIso()` uses local time (`getFullYear`/`getMonth`/`getDate`). The `e2e/fixtures/db.ts:todayIso()` mirrors the app byte-for-byte with local time — confirmed by direct grep of both files. The date key in the service-role read matches exactly what the app writes.

3. **Spec-074 window deferral is documented in three places** (spec §Out of scope, tests/README.md, and the design §4) and carries zero test code in this spec. The pgTAP Towson collision rationale is correctly stated and accurate (teardown deletes by vendor_ids, not by date; a date-keyed missed-order fixture would not be cleaned by the current teardown).

4. **No new test framework introduced.** All tests use existing Playwright (Track 4) harness. No vitest, no Cypress, no Detox additions.

5. **Zero cheap load-bearing gaps found.** The coverage map is complete and all assertions are load-bearing. No additions were needed.
