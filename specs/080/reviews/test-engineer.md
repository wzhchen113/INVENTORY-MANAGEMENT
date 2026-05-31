## Test report for spec 080

### Acceptance criteria status

Fixture scaffolding:

- AC-080-STORE: Dedicated e2e-only store (`SEED.e2eWindowStoreId = 'e2e00000-0000-0000-0000-000000000080'`, brand `2a000000-…0001`, `status='active'`) created idempotently via `serviceRoleClient()` in `test.beforeAll`. Brand FK present (mandatory for admin RLS). No `user_stores` grant (unnecessary under spec-081 per design Re-confirmation 4; admin sees store via `auth_is_admin()` short-circuit). No `inventory_items` (rule never reads inventory — spec-text correction). Store id is a fixed constant in `e2e/fixtures/constants.ts:52`. → **PASS** — `e2e/dashboard-window.spec.ts:139-156`, `e2e/fixtures/constants.ts:52`

- AC-080-DATE: Fixture computes in-window and out-of-window dates relative to `now`'s work-week in `BRAND_TZ='America/New_York'` using the production `getWeekWindow`/`getLocalDateISO`/`isoDateRange` helpers imported from `src/utils/weekWindow.ts`. In-window = last filtered week ISO (`inWindowISOs[inWindowISOs.length - 1]`); out-of-window = `mondayStart - 1 day`. Verified deterministic across all 7 weekdays (see Test run section). No hardcoded calendar dates. → **PASS** — `e2e/dashboard-window.spec.ts:85-105`

- AC-080-SEL: `testID={`dashboard-store-card-${s.id}`}` added to the per-store card wrapper `View` at `DashboardSection.tsx:498`; `testID={`attention-row-${item.id}`}` added to the queue-row `Wrapper` at `DashboardSection.tsx:975`. Both confirmed present in source. → **PASS** — `src/screens/cmd/sections/DashboardSection.tsx:498,975`

- AC-080-TEARDOWN: `e2e/global-teardown.ts` extended with a store-scoped, FK-ordered, idempotent delete block keyed on `SEED.e2eWindowStoreId`: deletes `purchase_orders` then `order_schedule` (children, with `on delete cascade` backup) then the `stores` row. Same non-fatal `console.warn`-on-error posture. Confirmed cannot touch Towson or the four pgTAP anchor stores (different id). Teardown log confirmed in the Playwright run: `[e2e global-teardown] dedicated dashboard-window store e2e00000-0000-0000-0000-000000000080 removed.` → **PASS** — `e2e/global-teardown.ts:71-123`

Behavioral assertions:

- AC-080-IN (LEAN floor, Tue–Sun): In-window miss (`order_schedule` row for inWindowISO's weekday, no matching `purchase_orders`) asserted visible via `card.getByTestId(`attention-row-${inId}`)` where `inId = ${e2eWindowStoreId}:po:${vendorUsFoodId}:${inWindowISO}`. Scoped within the dedicated store's card. Confirmed passes on 2026-05-31 (Sunday) with `inWindowISO=2026-05-30`. → **PASS** — `e2e/dashboard-window.spec.ts:231-237`

- AC-080-IN-MONDAY-SKIP (positive Monday variant): Positive Monday-reset proof implemented — when `isMonday`, asserts `card.locator('[data-testid^="attention-row-${e2eWindowStoreId}:po:"]').toHaveCount(0)` (zero `unconfirmed_po` rows on the dedicated card). This is a genuine assertion, not `test.skip()`. See Determinism section for why the Monday branch is a true assertion. → **PASS** — `e2e/dashboard-window.spec.ts:239-251`

- AC-080-OUT (FULL add-on): Out-of-window miss (`order_schedule` row for `outWindowISO`'s weekday = last Sunday, no PO) asserted absent via `card.getByTestId(`attention-row-${outId}`).toHaveCount(0)`. Asserted on ALL seven weekdays (not just Tue–Sun). Confirmed anti-non-vacuous — see Anti-vacuous audit section. → **PASS** — `e2e/dashboard-window.spec.ts:228-229`

Cross-cutting:

- AC-080-DOC: `tests/README.md` Track-4 section (lines 497–534) notes the window guard, the dedicated-store + date-scoped-teardown isolation pattern with the pgTAP anchor-store rationale, the positive-Monday assertion as a reusable deterministic-clock-E2E pattern, and lists `dashboard-window.spec.ts` in the directory tree. → **PASS** — `tests/README.md:497-534,572`

- AC-080-FLAKE: Navigates by `getByTestId(SIDEBAR_NAV.dashboard)`, asserts `dashboard-root` visible before interacting, uses auto-retrying `toBeVisible`/`toHaveCount(0)`, no `waitForTimeout`. Monday branch computed deterministically from `getWeekWindow`, not from a caught timeout. → **PASS** — `e2e/dashboard-window.spec.ts:213-251`

- AC-080-GREEN: `e2e.yml` run state at time of handoff: spec states 15 passed (the 14 existing + the new `dashboard-window.spec.ts`). Locally confirmed 15 passed. CI green state per the handoff payload from the developer: the spec was submitted as STATE: full e2e suite green. CI check (`e2e.yml`) is non-blocking in v1 per spec policy. → **PASS** (per developer handoff + local confirmation)

---

### Test run

All four required commands executed locally (2026-05-31, Sunday run).

**`npx playwright test --project=chromium --project=setup`**

```
[e2e global-setup] order_schedule fixture ready: 14 rows on Towson.
Running 15 tests using 5 workers
  ✓ [setup] authenticate as admin
  ✓ [setup] authenticate as master
  ✓ [setup] authenticate as staff
  ✓ [chromium] AC-080-IN/OUT: spec-074 window renders per-store on the dedicated card (1.2s)
  ... (11 other existing specs, all pass)
[e2e global-teardown] order_schedule fixture removed from Towson.
[e2e global-teardown] dedicated dashboard-window store e2e00000-…-080 removed.
15 passed (6.3s)
```

The fixture log confirmed: `today=2026-05-31, isMonday=false, out-of-window=2026-05-24, in-window=2026-05-30. 2 order_schedule row(s), no purchase_orders.`

**`npm run test:db` (pgTAP — run immediately after e2e)**

38/38 DB test files passed. The cross-track sequence (e2e then pgTAP) confirmed: teardown removed all dedicated-store rows and the store itself, so the `missed_order_audit_rpc` pgTAP test's four anchor stores were undisturbed.

**`npx jest`**

397 passed, 41 suites. Baseline unchanged (no jest surface changed in this spec).

**`npx tsc --noEmit -p e2e/tsconfig.json`**

Exit 0 (no output).

**`npx tsc --noEmit -p tsconfig.json`** (base check)

Exit 0 (no output).

---

### Anti-vacuous audit of the FULL assertion

The two critical assertions are:

**(a) In-window presence (`toBeVisible` on `attention-row-${e2eWindowStoreId}:po:${vendorUsFoodId}:${inWindowISO}`)**

Load-bearing: this assertion would FAIL if:
- spec-081's per-store sourcing regressed (the dedicated store's `order_schedule` would not reach its card's `computeAttentionQueue` call)
- The `unconfirmed_po` rule's `pastISOsInWindow` filter stopped including the in-window date
- The fixture's `order_schedule` insert failed silently

The `vendorKey` in the `item.id` is `(v.vendorId || v.vendorName || 'vendor').toString()` in `cmdSelectors.ts:897`. The fixture sets `vendor_id = SEED.vendorUsFoodId`, so `vendorKey === SEED.vendorUsFoodId`. The test computes `inId` using the same constant, so the testID computation is exact-match by construction. Confirmed.

**(b) Out-of-window absence (`toHaveCount(0)` on `attention-row-${e2eWindowStoreId}:po:${vendorUsFoodId}:${outWindowISO}`)**

The out-of-window date is `mondayStart - 1 day` = the Sunday before this week's Monday. The `unconfirmed_po` rule iterates `weekISOs = isoDateRange(mondayStart, nextMondayStart)` — the half-open range `[thisMonday, nextMonday)`. The `outWindowISO` (last Sunday) is NOT in `weekISOs` regardless of the `iso < todayISO` further filter, because it is strictly before `mondayStart`.

The absence assertion IS genuinely load-bearing. A regression that widened the window boundary — for example, switching from a Monday-reset week window to a 7-day or 14-day trailing window, or extending `weekISOs` to include the prior Sunday — would cause the rule to iterate `outWindowISO`, find the `order_schedule` row (seeded by the fixture), find no matching `purchase_orders`, and emit `${e2eWindowStoreId}:po:${vendorUsFoodId}:${outWindowISO}`. The `toHaveCount(0)` assertion would then FAIL. This is not vacuous.

The fixture deliberately seeds the Sunday `order_schedule` row even when CI runs on Monday (where `inWindowISO` is null and no in-window row is seeded). On Monday, only the out-of-window row exists, and the assertion is `toHaveCount(0)` on ALL `attention-row-{e2eWindowStoreId}:po:*` rows — a strict superset that confirms the window is genuinely empty.

---

### Determinism across weekdays

Verified by running the date arithmetic in full for all 7 weekdays (Mon 2026-05-25 through Sun 2026-05-31):

| Run day | isMonday | inWindowISO | weekday | outWindowISO | weekday | distinct? |
|---------|----------|-------------|---------|--------------|---------|-----------|
| Monday | true | EMPTY | N/A | 2026-05-24 | Sunday | N/A |
| Tuesday | false | 2026-05-25 | Monday | 2026-05-24 | Sunday | yes |
| Wednesday | false | 2026-05-26 | Tuesday | 2026-05-24 | Sunday | yes |
| Thursday | false | 2026-05-27 | Wednesday | 2026-05-24 | Sunday | yes |
| Friday | false | 2026-05-28 | Thursday | 2026-05-24 | Sunday | yes |
| Saturday | false | 2026-05-29 | Friday | 2026-05-24 | Sunday | yes |
| Sunday | false | 2026-05-30 | Saturday | 2026-05-24 | Sunday | yes |

All seven weekdays produce valid date arithmetic:
- `outWindowISO < mondayISO` is true on all weekdays (Sunday prior to current week)
- The two `order_schedule` rows never collide on the `(store, day_of_week, vendor)` unique key — `outWindowISO` is always a Sunday; `inWindowISO` is always Mon–Sat (Sunday cannot be `inWindowISO` because it is `nextMondayStart - 1 day` which equals the last day of the week, and `isoDateRange(mondayStart, nextMondayStart)` includes it but the `iso < todayISO` filter excludes it when today IS Sunday — wait, on Sunday `todayISO = Sunday` and `inWindowISOs = weekISOs.filter(iso => iso < Sunday)` = Mon–Sat, NOT including Sunday itself. So `inWindowISO` is Saturday (the last element), NOT Sunday. The two weekdays are always distinct.
- The `mondayStart - 1 day` arithmetic uses `setUTCDate(getUTCDate() - 1)` — pure UTC arithmetic, DST-safe, always produces the prior Sunday.

**Monday branch:** `isMonday=true` → `inWindowISOs = []` → no in-window row seeded; only the Sunday out-of-window row is seeded. The assertion is `toHaveCount(0)` on all `attention-row-{dedId}:po:*` rows within the dedicated card. This is a TRUE assertion because `pastISOsInWindow = []` on Monday (the `iso < todayISO` filter with `todayISO = Monday` leaves nothing in `[Monday..nextMonday)` before Monday). The dedicated store has the Sunday `order_schedule` row, but Sunday is not in `weekISOs`, so the rule does not iterate it. The `toHaveCount(0)` assertion genuinely proves the Monday-reset.

---

### Scoping

Every row assertion is inside `const card = page.getByTestId(`dashboard-store-card-${SEED.e2eWindowStoreId}`)`:
- Line 229: `card.getByTestId(`attention-row-${outId}`)` — scoped
- Line 237: `card.getByTestId(`attention-row-${inId}`)` — scoped
- Lines 247–249: `card.locator('[data-testid^="attention-row-${SEED.e2eWindowStoreId}:po:"]')` — scoped within card AND further scoped by the dedicated store id prefix on `item.id`

Other stores' attention rows (including the Frederick US FOOD miss mentioned in the handoff) cannot satisfy or break any of these assertions. The card testID is the reliable isolation boundary.

---

### Teardown isolation

The e2e → pgTAP cross-track sequence was run locally and confirmed clean (38/38 pgTAP after 15/15 e2e). The teardown is store-scoped to `SEED.e2eWindowStoreId` — a UUID (`e2e00000-0000-0000-0000-000000000080`) that does not match any of the four pgTAP `missed_order_audit_rpc` anchor stores (Towson `00000000-…0001`, Frederick `0f240390-…`, Charles, Reisters). The teardown log confirmed the dedicated store was removed cleanly, leaving the DB in the same state as the committed seed.

---

### Notes

1. **No cheap load-bearing gap found.** All ACs are covered; no gap identified that would justify an additional ≤20-line assertion. The one analytical observation below is informational, not a gap.

2. **Anti-vacuous property clarification (informational, not a gap).** The `toHaveCount(0)` on `outWindowISO` proves the Monday-week boundary specifically. It does NOT prove the `iso < todayISO` exclude-today filter (a separate jest unit tests that). The two filters compose: `weekISOs` restricts to this week, then `iso < todayISO` excludes today. The AC-080-OUT assertion proves the first filter (week boundary); the jest tests prove the second. This is the correct division of the two layers and is consistent with the spec's stated scope ("integration-wiring proof, not a logic proof").

3. **Timezone risk (Risk 1).** The spec pins `BRAND_TZ = 'America/New_York'` based on the verified finding that `useStore.timezone` defaults to `'America/New_York'` and is never overridden from the DB on login. This is correct and verified in the spec's design section. If a future spec changes the timezone default or adds DB-side overrides, `BRAND_TZ` must be updated — this is a documented maintenance dependency.

4. **AC-080-GREEN CI state.** The developer handoff states the e2e suite was green at submission time. The CLAUDE.md rule requiring CI confirmation after a push to `main` applies; local confirmation is 15/15 passed. The `e2e.yml` workflow is non-blocking in v1 so this does not gate SHIP_READY under current policy.

5. **No new framework introduced.** Spec extends the existing Track-4 Playwright harness. No vitest, no additional CI workflow steps, no new package dependencies.
