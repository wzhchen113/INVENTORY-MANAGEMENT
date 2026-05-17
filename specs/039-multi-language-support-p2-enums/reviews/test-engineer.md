## Test report for spec 039 (re-review post-fix)

Re-review after the frontend developer's fix pass: AC13 Critical cleared, AC15 and AC6 wired to production callers. All Criticals are now resolved.

### Acceptance criteria status

**Catalog (new keys, single file extension):**

- AC1: `src/i18n/{en,es,zh-CN}.json` gain a new top-level `enum` namespace with eight sub-namespaces (`itemStatus`, `wasteReason`, `auditAction`, `inventoryCountKind`, `role`, `userStatus`, `dayOfWeek`, `unit`) → **PASS** — all three catalogs have identical top-level keys; 368 leaf keys each. The `enum` namespace contains all eight sub-namespaces.

- AC2: Catalog reuse rule — old top-level `status.*` and `role.*` keys (from spec 038) collapsed into `enum.itemStatus.*` and `enum.role.*`; no duplicates → **PASS** — no top-level `status` or `role` key in any of the three catalogs; no call site uses `T('status.*)` or `T('role.*)`.

- AC3: All three catalog files ship with the same `enum` key set; parity test covers automatically → **PASS** — `src/i18n/i18n.test.ts::i18n catalog parity / en, es, zh-CN have identical key sets` passes green. 368 leaf keys with zero missing and zero extra in any locale.

**Codebase wiring:**

- AC4: `statusLabel()` in `statusColors.ts` now takes `T` as a parameter; `StatusPill.tsx` calls `useT()` and passes `T` into `statusLabel(status, T)` → **PASS** — confirmed in prior review, unchanged.

- AC5: `StatusPill` and `StatusDot` consumers with `label=` override continue to work; default label path is locale-aware → **PASS** — confirmed in prior review, unchanged.

- AC6: `WasteLogSection.tsx`'s `REASON_LABEL` map and dropdown route through `wasteReasonShortLabel(r, T)` (short form) for filter chips and selection buttons; display in log event rows uses `wasteReasonShortLabel(w.reason, T)` → **PASS** — `wasteReasonLabel` (long form) is now wired at the form's reason-selection chip group (line 390 of `WasteLogSection.tsx`), using `wasteReasonLabel(r, T)` for the sentence-case display form. `wasteReasonShortLabel` is used at filter chips (line 143) and inline event-row display (line 205). The full-form export is exercised by a real production render site; no longer unused. Prior "partial / NOT TESTED" finding is resolved.

- AC7: `formatAuditAction()` in `formatAuditAction.ts` takes `T` as a parameter; `KEY_BY_ACTION` maps all 13 `AuditAction` values to camelCase keys; callers pass `T` → **PASS** — confirmed in prior review, unchanged.

- AC8: `AddInventoryCountModal`'s `KIND_OPTIONS` and `KIND_LABEL` replaced by `inventoryCountKindLabel` / `inventoryCountKindSubLabel` calls → **PASS** — confirmed in prior review, unchanged.

- AC9: `UsersSection.tsx`'s `roleLabel()` and `'ACTIVE'/'PENDING'` pill label route through `roleLabel(user.role, T)` and `userStatusLabel(user.status, T)` from `enumLabels.ts` → **PASS** — confirmed in prior review, unchanged.

- AC10: `DAY_NAMES` arrays stay as English DB-join keys; rendered text routes through `dayOfWeekShortLabel` / `dayOfWeekLongLabel` at render time → **PASS** — confirmed in prior review, unchanged.

- AC11: Unit dropdowns in `IngredientForm.tsx`, `RecipeFormDrawer.tsx`, `PrepRecipeFormDrawer.tsx`, and `InventoryCatalogMode.tsx` route display text through `unitLabel(u, T)` → **PASS** — confirmed in prior review, unchanged.

- AC12: Filename-style tab labels stay verbatim, not wrapped in `t()` → **PASS** — confirmed in prior review, unchanged.

- AC13 (Filename-style exception): The `categories` tab label in `InventoryDesktopLayout` routes through `t('section.inventory.tabs.categories')` → **PASS** — all three `TabStrip` sites in `InventoryDesktopLayout.tsx` (lines 199, 217, 240) now use `label: T('section.inventory.tabs.categories')`. The catalog key exists and resolves to `"categories"` / `"categorías"` / `"分类"` in the three locales. The `i18n.test.ts::section.inventory.tabs.categories exists in en / es / zh-CN` test (lines 108–117) guards against future key renames. Prior FAIL (Critical) is now resolved.

**Search / filter behavior:**

- AC14: Filter chip source continues to be English canonical; displayed chip label is translated → **PASS** — confirmed in prior review, unchanged.

- AC15: When the user types into a "search" / "filter" text input over a translated enum, the match scans BOTH the current-locale label AND the English canonical, using `matchesQuery()` → **PASS** — `matchesQuery` is now wired into `FeedTab`'s filter input in `AuditLogSection.tsx` (lines 11, 121–128). The filter passes `[formatAuditAction(e, T), e.action, e.userName, e.itemRef, e.value]` as candidates — scans both the translated action label (`formatAuditAction(e, T)`) and the raw English canonical (`e.action`), satisfying the bilingual-match requirement. A comment at lines 111–115 explicitly documents the spec 039 AC15 guarantee. `matchesQuery` is also covered by 5 unit tests in `enumLabels.test.ts::matchesQuery`. Prior NOT TESTED finding is resolved.

**Sort stability:**

- AC16: Status enums, waste reasons, audit actions, inventory-count kinds, user roles sort by fixed enum position — no accidental `localeCompare` switch → **PASS** — confirmed in prior review, unchanged.

- AC17: Units sort by `CANONICAL_UNITS` position → **PASS** — confirmed in prior review, unchanged.

- AC18: Day-of-week sort unchanged → **PASS** — confirmed in prior review, unchanged.

- AC19: User-mutable categories out of scope → **PASS** — confirmed in prior review, unchanged.

**Tests:**

- AC20: Track 1 (jest) — parity test in `i18n.test.ts` automatically covers new `enum.*` keys → **PASS** — 368 leaf keys covered, including all `enum.*` sub-namespaces.

- AC21: Track 2 (pgTAP) — none; no DB changes → **PASS** — 21/21 pgTAP tests pass.

- AC22: Track 3 (smoke) — none; no edge function touched → **PASS** — no change to smoke scope.

- AC23: `npm run typecheck`, `npm run typecheck:test`, `npm test` all pass → **PASS** — all three exit 0; jest reports 104 tests passed across 10 test suites (up 4 from prior review's 100: 1 catalog parity assertion in `i18n.test.ts` + 3 `enum.itemStatus.*` direct catalog assertions in `enumLabels.test.ts`).

**Misc:**

- AC24: No new npm dependency added → **PASS** — confirmed in prior review, unchanged.

- AC25: No new hook beyond the optional `useStatusLabel()` (architect chose pass-T-over-new-hook) → **PASS** — confirmed in prior review, unchanged.

- AC26: No new file in `src/i18n/` — extend existing catalogs → **FAIL (minor, acknowledged)** — `src/i18n/matchesQuery.ts` is a new file inside `src/i18n/`. The architect explicitly designed this in §1(d) and the spec's "New files" section names it; the AC text and the architect design are in conflict. Implementation follows the architect. This discrepancy was noted in the prior review and is not a blocker; the file is fully tested and intentionally placed. No change in status from prior review.

---

### Scrutiny of newly fixed items

**AC13 — `categories` tab label (prior Critical, now cleared)**

`InventoryDesktopLayout.tsx` grep confirms `label: T('section.inventory.tabs.categories')` at all three `TabStrip` sites (lines 199, 217, 240). The prior `label: 'categories'` hardcoded string is gone. The new test in `i18n.test.ts` (lines 108–117) asserts the key resolves in all three locales and will catch a future rename before it reaches production.

**AC15 — `matchesQuery` production wiring (prior NOT TESTED, now PASS)**

`FeedTab` in `AuditLogSection.tsx` is a real production render path: it is the default tab rendered when the section first loads. The filter input is visible to users. The bilingual match (`formatAuditAction(e, T)` = locale label; `e.action` = English canonical) satisfies the spec's "BOTH the current-locale label AND the English canonical" requirement. Diacritic-folding is implemented in `matchesQuery.ts` via `String.prototype.normalize('NFD')` + Unicode category strip, exercised by 5 unit tests.

**AC6 — `wasteReasonLabel` long form in production (prior partial, now PASS)**

The form's reason-selection chip group at line 390 of `WasteLogSection.tsx` uses `wasteReasonLabel(r, T)` (sentence-case long form). Short form (`wasteReasonShortLabel`) continues at filter chips and event-row inline display. Both forms are now exercised by real production render paths.

**Architect §7 spot-checks for `enum.itemStatus.*` (prior gap, now closed)**

`enumLabels.test.ts` lines 46–61 add three direct catalog assertions:
- `t('zh-CN', 'enum.itemStatus.ok')` asserts `'正常'`
- `t('es', 'enum.itemStatus.low')` asserts `'BAJO'`
- `t('en', 'enum.itemStatus.out')` asserts `'OUT'`

These hit the real JSON catalog — not a mock — and will catch a future catalog rename before it reaches production. The gap identified in the prior review (no direct catalog test for `statusLabel`) is now closed.

---

### Test run

```
npm test -- --no-coverage
```

```
PASS unit src/i18n/i18n.test.ts
PASS component src/components/cmd/StatusPill.test.tsx
PASS unit src/utils/relativeTime.test.ts
PASS unit src/store/useStore.test.ts
PASS unit src/lib/auth.test.ts
PASS unit src/utils/enumLabels.test.ts
PASS unit src/utils/userPermissions.test.ts
PASS unit src/utils/reportParams.test.ts
PASS unit src/utils/seedVarianceDates.test.ts
PASS unit src/utils/escapeHtml.test.ts

Test Suites: 10 passed, 10 total
Tests:       104 passed, 104 total
```

```
npm run typecheck && npm run typecheck:test
```

Both exit 0 — no TypeScript errors.

```
bash scripts/test-db.sh
```

21/21 DB test files passed (no DB changes in this spec).

---

### Notes

All Criticals are cleared. The only remaining non-PASS item is AC26 (minor, acknowledged), which is a spec/architect conflict about the `matchesQuery.ts` file location. The architect's design explicitly placed the file in `src/i18n/` and documented the rationale; the implementation follows the architect. This is not a blocker and requires no further action.

No regressions introduced in the fix pass. Test count increased from 100 to 104.
