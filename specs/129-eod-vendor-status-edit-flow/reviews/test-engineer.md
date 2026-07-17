## Test report for spec 129

Frontend-only spec (no migration/RPC/edge function). Per spec, only the jest
track applies; no pgTAP, no shell smoke.

### Acceptance criteria status

**Per-vendor chip status (red/green)**
- AC: RED status indicator when vendor has no `eod_submissions` row for
  (store, date) → PASS — `src/screens/staff/screens/EODCount.test.tsx::EODCount — spec 129 vendor status + edit flow > colors each vendor chip green (submitted) vs red (outstanding) from the set` (asserts `eod-vendor-status-v-2` a11y label `"Not submitted"`); also `submittedStatus.test.ts::returns an empty set when no rows match`.
- AC: GREEN status indicator when vendor HAS a row → PASS — same test (`eod-vendor-status-v-1` → `"Submitted"`); `submittedStatus.test.ts::returns the set of vendor_ids that have a submitted row`.
- AC: status indicator additive/separate from selection highlight → PASS — same test explicitly asserts `vendor-chip-v-1` `accessibilityState.selected === true` while the badge coloring is independently driven by the Set, and the source renders the badge as an absolutely-positioned sibling view (`vendorStatusDot`) distinct from the chip's own `backgroundColor`.
- AC: partially-counted-but-not-submitted still shows RED → PASS (by construction, not a dedicated fixture) — `fetchSubmittedVendorIds` only reads `eod_submissions` (a row that exists only once a submission lands, per the design doc and the `staff_submit_eod` RPC contract which is out of scope for this spec); no code path adds a vendor to `submittedVendorIds` except a confirmed/optimistic submit. No test types partial cases/units and checks the badge stays red, so this is inferred from the data model rather than directly exercised — flagged as a minor gap below, not blocking (the property follows deterministically from the Set-driven design, not from any separate "partial" logic that could regress independently).
- AC: fetched for ALL of today's vendors, scoped to store+date → PASS — `submittedStatus.test.ts::scopes the query to store, date, and status=submitted` pins the `eq()` calls; `EODCount.tsx` fetches once per (store, countDate) in the vendor-load effect, not per-selected-vendor.
- AC: after successful submit, chip flips GREEN without full-screen reload → PASS — `EODCount.test.tsx::after a successful Submit: locks read-only, button becomes "Edit", chip green, no navigate` asserts `eod-vendor-status-v-1` a11y label `"Submitted"` post-submit with no remount/navigation.

**Submit → EDIT/Cancel state machine**
- AC: not-submitted → inputs editable + "Submit" → PASS — `UNSUBMITTED (no existing): inputs editable + primary button reads "Submit"`.
- AC: after Submit, stays on EOD screen (no auto-navigate to Reorder) → PASS — `stays on the EOD screen after a successful submit (spec 129 — no navigate to Reorder)` and the spec-129 describe block's submit test, both assert `mockNavigate` not called. Source-level: `useNavigation` import/binding and all `navigation.navigate('Reorder')` calls are absent from `EODCount.tsx` (confirmed via grep — zero matches).
- AC: after Submit, count locks read-only with submitted values + "EDIT" → PASS — same test: `editable` flips to `false`, button text becomes `"Edit"`.
- AC: EDIT tap → editable, seeded from submitted values, "Submit" + "Cancel" appears → PASS — `EDIT tap: inputs become editable, Cancel appears`.
- AC: Cancel discards edits, reverts to last-submitted values, re-locks, back to "EDIT" → PASS — `Cancel: reverts inputs to submitted values, re-locks, Cancel disappears` (types `99` into the field, taps Cancel, asserts value reverts to `'3'`, `editable === false`, Cancel button gone). This is the highest-risk AC and it is directly exercised with a genuine before/after value mutation, not just a state-shape assertion.
- AC: Submit from EDITING re-submits, returns to read-only + "EDIT", chip stays GREEN → PASS — `Submit from EDITING: re-submits and returns to read-only + "Edit"` (asserts `mockSubmit` called, then read-only + Cancel gone).
- AC: selecting a different vendor loads that vendor's own state → PASS — `switching vendor resets the editing flag (target lands locked, not editing)`.

**Offline / queued behavior**
- AC: queued submit does not falsely show GREEN/read-only as if server-confirmed → PASS against the architect's resolved design (optimistic-green is the explicitly chosen posture, not a deviation) — `queued (offline): optimistic lock + green, inputs NOT cleared (spec 129)` asserts inputs keep their just-entered values (not cleared), lock engages, chip badge reads `"Submitted"`, and no navigation fires. This matches the spec's §3c resolution verbatim (footer `QueueIndicator` remains the authoritative "not-synced" signal); there is no separate pending/amber-chip test because the spec explicitly marks that variant optional/deferred.

### Read-only lock mechanism (cross-cutting, backs multiple ACs above)
- `editable={false}` in SUBMITTED_LOCKED / `editable={true}` in UNSUBMITTED and EDITING is asserted directly via `.props.editable` in essentially every spec-129 test (both Cases and Units inputs get equivalent coverage through the Units assertions plus the cases-value assertions in the Cancel/queued tests). `Input.tsx` confirmed to forward `editable` via `{...rest}` to the inner `TextInput` (no silent no-op risk).

### Test run

```
npx jest submittedStatus EODCount
```
Test Suites: 4 passed, 4 total
Tests: 56 passed, 56 total

```
npx jest
```
Test Suites: 121 passed, 121 total
Tests: 1298 passed, 1298 total (matches the expected ~1298 baseline)

```
npx tsc --noEmit
```
Exit 0, no errors.

```
npm run typecheck:test
```
Exit 0, no errors.

```
npx jest i18n.test
```
Test Suites: 2 passed, 2 total
Tests: 24 passed, 24 total — confirms `eod.edit`, `eod.cancel`, `eod.status.submitted`, `eod.status.outstanding` exist at parity across `en`/`es`/`zh-CN` (manually spot-checked all three locale files in addition to the parity test).

No failures anywhere. No `console.error`/`act()` warnings are new regressions — they're pre-existing async-effect noise (yesterday-incomplete fetch, updated-items fetch, VirtualizedList) already present before this spec and unrelated to spec 129's behavior.

### Notes

- **Framework**: jest only, as directed by the spec (`Tests: jest track`). No pgTAP, no shell smoke — correctly, since this is UI-only with zero DB/RPC/edge-function changes. No fourth framework introduced.
- **Minor gap, not blocking**: no test explicitly types partial Cases/Units values *without* submitting and asserts the chip stays red. The AC holds by construction (the Set is populated only from `eod_submissions` rows / a confirmed-or-queued submit outcome, never from `caseCounts`/`unitCounts` state), and every existing UNSUBMITTED-state test implicitly exercises "not-yet-submitted → red" via the default empty Set. If the release-coordinator wants this pinned as a named regression guard (e.g., someone later wires the chip color to `countedNum` instead of `submittedVendorIds`), that would be a one-line addition to the developer's follow-up, not a blocker for this ship.
- **Single-vendor label parity**: the design doc flags the single-vendor status dot (`eod-vendor-status-<id>` on the `eod-vendor-single` row) as "minor/optional." It IS implemented in the source (`vendorStatusDotInline`) but I did not find a dedicated single-vendor-badge test — the spec-129 describe block's fixtures all use 2-vendor scenarios (`vendors.length > 1` branch). Not a blocker since the spec itself marked this optional and the two-vendor badge path is the one directly required by AC text ("each vendor chip").
- All named test files/behaviors from the design's "jest surface" section are present: `submittedStatus.test.ts` (5 cases: scoping, populated set, empty set, null-id filtering, error-degrades-to-empty) and the extended `EODCount.test.tsx` spec-129 describe block (chip color, all 3 states + all transitions, vendor-switch reset, queued path).
- `app.json` slug untouched; no destructive/self-guard/role-hierarchy code touched by this spec — none of the other hard-rule carve-outs apply here.

No AC is FAIL or NOT TESTED. Nothing blocks.
