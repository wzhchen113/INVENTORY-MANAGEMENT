# Code review for spec 079

## Summary

The implementation is clean and well-structured. Both halves (BE `e2e/` + FE `testID`s) are in good shape. The DRY extract into `fixtures/db.ts` is sound, the scroll guard hits all three sub-assertions in the correct order, the persistence sync point correction (in-place banner over vacuous queue-indicator) is the right call, and `todayIso()` correctly mirrors the app's local-time derivation. No Critical findings. Two Should-fix items and a small cluster of Nits.

---

### Critical

None.

---

### Should-fix

- `e2e/reorder.spec.ts:67` — `csv.isVisible()` is a one-shot snapshot call, not an auto-retrying assertion. After clicking Refresh (line 53-56), the payload reload is async; `csv.isVisible()` could evaluate to `false` during the loading window and skip the export assertion even when the payload is non-empty after settling. The defensive intent is correct (skip if the payload is genuinely empty) but the timing boundary is wrong: use `await csv.isVisible()` after the `toHaveText('REFRESH', { timeout: 15_000 })` wait has already confirmed the reload settled. In practice this is likely fine because `toHaveText('REFRESH')` at line 56 waits for the loaded state before line 67 runs — but the snapshot call is not idiomatic Playwright and will mislead future readers about why the conditional exists. Fix: add an explicit comment that this is a deliberately non-retrying snapshot read taken AFTER the reload settled, or replace with `await expect(csv).toBeVisible({ timeout: 0 }).then(() => true, () => false)` to make the non-retrying intent explicit. As written, the race is benign but the code's intent is unclear.

- `e2e/reorder.spec.ts:71-73` — The export-button check asserts `reorder-export-csv` only via `toBeEnabled()` (no explicit `toBeVisible()` first) while `reorder-export-pdf` gets both `toBeVisible()` then `toBeEnabled()` as separate round-trips. The asymmetry is confusing: a reader expects symmetrical treatment for two buttons governed by the same `showExport` gate. Since both buttons render together under `showExport`, and `csv` was already confirmed visible at line 67, the correct idiomatic fix is to assert `toBeEnabled()` only for both (skipping redundant visibility re-checks) or to assert `toBeVisible()` for both before `toBeEnabled()` for both. Current state: CSV gets `toBeEnabled()`, PDF gets `toBeVisible()` + `toBeEnabled()`. Suggested fix — replace lines 71-73 with:
  ```ts
  await expect(page.getByTestId('reorder-export-csv')).toBeEnabled();
  await expect(page.getByTestId('reorder-export-pdf')).toBeEnabled();
  ```
  Both are already known visible (same gate); the extra `toBeVisible()` on the PDF is a redundant round-trip.

---

### Nits

- `e2e/fixtures/db.ts:67` — `todayIso(d = new Date())` accepts an injected date argument, which is useful for unit-testing the helper in isolation. However, no test exercises the optional `d` parameter, and the call sites in `eod.spec.ts:159` use the zero-argument form. The parameter is harmless and matches the app's own `todayIso(d = new Date())` signature (EODCount.tsx:57) — a clean mirror. Noting it only because a future maintainer might wonder why it's injectable; a one-line comment `// injectable for testing; call sites use zero-argument form` would close that question.

- `e2e/eod.spec.ts:78` — `picker.or(eodHeader).first()` is correct — on a fresh context only one is in the DOM, so `.first()` resolves to whichever rendered. On the reload path both are in mutually exclusive render branches so co-presence is not a real risk. Worth a brief inline comment explaining why `.first()` is safe here (the two elements are never simultaneously visible — they live in mutually exclusive branches of the component tree), so the next reader doesn't reach for `.nth(0)` or restructure it unnecessarily.

- `e2e/eod.spec.ts:109` — The test name `'AC-EOD1 + AC-EOD-PERSIST: online submit persists (banner on reload + service read)'` is accurate but longer than the rest of the suite's naming style. Not wrong; just slightly verbose. Minor.

- `e2e/fixtures/constants.ts:84-89` — `SIDEBAR_NAV` values are `'nav-Dashboard'`, `'nav-Reorder'`, `'nav-AuditLog'`, `'nav-Users'`. The keys are `dashboard`, `reorder`, `auditLog`, `users`. The camelCase `auditLog` key for the `'nav-AuditLog'` value is correct (the code constant from `cmdSelectors.ts` is `AuditLog`, not `AuditLog`). No bug, just noting the key-to-value casing difference (`auditLog` → `nav-AuditLog`) is intentional and matches the `item.id` from `cmdSelectors.ts`; a reader cross-checking the two might pause. The comment at line 82-88 already explains this ("stable code constants from cmdSelectors.ts"). Fine as-is.

- `e2e/eod.spec.ts:171` — The local type alias `type Entry = { item_id: string; actual_remaining: number | string | null }` is declared inline mid-test. This is functional and fine for a one-off usage, but if a second service-role read is ever added, this type would need to be re-declared or extracted. Low priority; the comment "Presence + value, not a row count" is a sufficient usage guide.

- `src/components/cmd/TreeGroup.tsx:133` — The new `testID={\`nav-${item.id}\`}` is on the `TouchableOpacity` that wraps the nav row. The `editMode` branch (line 71-128) renders a `View` without a `testID`, which is correct per the spec's design (edit-mode items are not navigable). No finding; noting for completeness that the asymmetry is intentional and documented in both the spec and the file header.

- `tests/README.md:616-653` — The flake checklist (8 points) was added verbatim per AC-FLAKE-2. Point 6 says `"EOD reads the row for (store, today, vendor)"` — this accurately describes what the code does. Slight wording improvement opportunity: `"EOD reads eod_submissions for (store, today, vendor)"` to distinguish the DB table from the EOD submit action; the current wording is not wrong.

- `(out-of-scope)` `e2e/eod.spec.ts` — the offline test case (`AC-EOD2/3`) fills `'5'` but the spec comment says the distinction from `'7'` is to prevent a stale-row read from matching the wrong case. The offline case never performs a service-role read so the value `'5'` is not actually needed for isolation — the ordering call-out in the design noted this correctly as "not a blocker." Future cleanup could simply note that `'5'` and `'7'` are arbitrary distinct values; a comment already appears in the online test at line 116 but the offline test has no parallel note.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fix addressed in `e2e/reorder.spec.ts`; the 7 Nits are cosmetic and deferred.

- **Should-fix #1 (non-retrying `csv.isVisible()` snapshot intent)** — **fixed.** Added an explicit comment documenting that this is a DELIBERATE one-shot snapshot taken AFTER the Refresh reload settled (the `toHaveText('REFRESH')` wait at line 56 gates the loaded state), and WHY a snapshot is correct here rather than an auto-retrying assertion: "buttons absent" is a legitimate terminal state (empty payload), so a retrying `toBeVisible()` would hang 10s then fail on that valid path. The race the reviewer flagged is benign (already settled); the comment makes the intent unambiguous for future readers.
- **Should-fix #2 (asymmetric CSV vs PDF assertions)** — **fixed.** Both export buttons now assert `toBeEnabled()` only (symmetric). Removed the redundant `toBeVisible()` round-trip on the PDF button — both render together under the same `showExport` gate and CSV's visibility was already confirmed by the snapshot above.
- **Nits (7)** — left as-is. All cosmetic: optional clarifying comments (injectable `todayIso` param, `.first()` mutual-exclusivity note, the offline `'5'`-vs-`'7'` arbitrary-distinct note), a slightly-verbose test name, a README wording tweak, and confirmations-of-intent (the `auditLog`→`nav-AuditLog` key casing, the edit-mode TreeGroup branch having no testID). None affect correctness or flake-resistance.

Re-verified post-fix-pass: `tsc -p e2e/tsconfig.json` exit 0; reorder spec green (`AC-REORD-DEPTH-1` passes); global-teardown still fires. The full-suite green (14 Playwright / 386 jest / 38 pgTAP) from the pre-fix-pass run is unaffected — the change is comment + one assertion-line simplification in a single spec.
