## Code review for spec 100

### Critical

None.

Decision B1 is honored: `src/utils/reorderExport.ts` is byte-for-byte unchanged (no `i18n_names`, no locale param, `formatSuggestedParts` untouched). `src/lib/db.ts:mapReorderVendor` (lines 2851-2887) is byte-for-byte unchanged — no `i18nNames` field. Both verified by grep.

### Should-fix

- `src/screens/staff/screens/Reorder.tsx:20` — `Platform` is imported from `react-native` but never referenced anywhere in the file. Dead import; a strict linter will flag it and it creates noise for the next reader who tries to understand what cross-platform branching happens in this file. Remove it from the destructure.

- `src/screens/staff/screens/Reorder.test.tsx:161` — The comment reads "The Suggested string is byte-for-byte the admin `formatSuggested` output." This was accurate for the spec-088 code but is now false: the staff screen no longer calls `formatSuggested` at all (the import was correctly dropped). The string happens to be identical in English because the new `suggestedMainLabel`/`suggestedSubLabel` helpers reproduce the same layout, but the comment mis-states the mechanism and will confuse a future reader who looks for a `formatSuggested` call in the render path. Update to describe what actually produces the string: `suggestedMainLabel` + the `reorder.unit.case/cases` catalog key.

### Nits

- `src/screens/staff/screens/Reorder.tsx:97` — `suggestedMainLabel(item: ReorderItem, tt: typeof t)`. The parameter type `typeof t` resolves to the module-level snapshot `t` from `import { t, useI18n } from '../i18n'`. The actual callsite at line 184 passes the reactive `t` returned by `useI18n()`. The structural types are identical so there is no bug, but the annotation silently equates the snapshot and reactive variants. `typeof t` here is accurate (same signature), but a comment clarifying "the reactive `t` from `useI18n()` is passed here so locale-switch re-renders work" near the parameter would make the reactivity contract explicit without requiring a type change.

- `src/screens/staff/lib/fetchReorder.test.ts:83` — `const item = payload.vendors[0].items[0];` shadows the outer `item` factory function defined at `fetchReorder.test.ts` line... actually `fetchReorder.test.ts` has no outer `item` factory (that's `Reorder.test.tsx`). No actual shadowing — the name `item` as a local constant in a test block is fine. Withdraw this observation.

- `src/screens/staff/screens/Reorder.test.tsx:74` — The `vendor()` fixture factory defaults `vendorName` to `over.vendorId` (`vendorName: over.vendorId`). Several fixtures rely on this default and end up with a vendor whose name is its ID string (e.g., `'v-1'`). This is a convenience but makes test failure messages harder to parse ("vendor name: v-1" looks like a data error rather than a fixture default). Minor readability nit; no functional impact.

- `supabase/tests/report_reorder_list_i18n_names.test.sql:218` — The test file ends with `select * from finish(); rollback;` on separate lines without a blank line separator. All other pgTAP tests in the repo (`report_reorder_list_cases.test.sql`) follow the same style, so this is consistent — no change needed.
