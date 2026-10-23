## Code review for spec 174

Scope: unstaged source edits (`src/lib/eodNoNeed.ts`, `src/screens/staff/lib/eodNoNeed.ts`, `src/utils/reorderExport.ts`, `src/screens/staff/lib/reorderExportStaff.ts`, `src/screens/cmd/sections/ReorderSection.tsx`, `src/screens/cmd/sections/phone/PhoneOrdering.tsx`) and the five new `*.spec174.test.ts(x)` files. Spec 173 staged files ignored. I could not run git diff or jest (no shell in this review session), so I read the edited regions of each file directly and checked them against spec section 7.

Checked against the project rules, all clean:
- No `supabase.from/rpc` call, no new store mutation, no `window` / `Alert` / `Platform` issue.
- No inline hex or named color in `PhoneOrdering.tsx`; the tag uses `C.border`, `C.fg3`, `CmdRadius.pill` and `mono(600)`.
- No new realtime channel, no new i18n key, no `app.json` change, no legacy-file edit.
- No literal `'no_need'` added outside `eodNoNeed.ts` (the only new literal is the en label `'NO NEED'`, which is intentional per design 5.2).
- Staff code takes the predicate from the staff barrel (`./eodNoNeed`), as AC-1 requires.
- `item.flags || []` stays null-safe inside `isReorderNoNeed`.
- Tests are new files only, on the jest track. The existing `reorderExport.test.ts` and `reorderExportStaff.test.ts` are not edited.

### Critical
None.

### Should-fix
None.

### Nits

- `src/screens/staff/lib/reorderExportStaff.ts:159-169` — the have-enough `itemLine` is now a nested ternary three levels deep, and the new NO NEED arm has its own en / non-en split. Both arms print `{name}: {label}`, and `reorderNoNeedLabel('en')` equals `reorderNoNeedLabel(locale)` when `locale === 'en'`. The split exists only to keep `item.itemName` on the en path, which the spec requires. It could collapse to one template, or the existing numeric branch could be hoisted into a small named helper. Non-blocking; it matches the design as written.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx:430-448` — the pill's style values (`0.5` border, `9` px, `letterSpacing: 0.3`, `paddingHorizontal: 7` / `paddingVertical: 2`) are copied from the private desktop `FlagChip` in `ReorderSection.tsx`. This is a deliberate decision (design N5), but the two now have to be kept in step by hand. If the desktop fg3 pill changes, nothing fails here. The in-JSX comment already names `FlagChip`; add a mirror note on the `FlagChip` side if you want drift to be findable from both directions.
- `src/utils/reorderExport.noNeed.spec174.test.ts:21-104`, `src/screens/staff/lib/reorderExportStaff.noNeed.spec174.test.ts:22-103` and `src/screens/cmd/sections/__tests__/ReorderSection.pdfNoNeed.spec174.test.tsx:75-148` — the `row()`, `vendor()`, `payloadOf()` and WINGS / SAUCE / LEMONS / Napkins fixtures are copy-pasted across three files. Deliberate, because the snapshot pins must not move and each file is self-contained. The cost is that a future `ReorderItem` field addition needs three edits. A shared `__fixtures__` helper would be a follow-up, not part of this spec.
- `src/lib/eodNoNeed.ts:29` — the doc comment says "(flag token R4)", which only makes sense with spec 172's migration open beside it. The line directly above (L26) already explains R4, so this is fine as is. Low priority.
- `specs/174-reorder-no-need-display.md` (Files changed) — the three `.snap` files and four of the five test files are untracked in `git status` (`?? src/screens/cmd/sections/__tests__/__snapshots__/`, `?? src/screens/staff/lib/__snapshots__/`, `?? src/utils/__snapshots__/...`). The byte-identity pins are what prove AC-4 / 7 / 9 / 10 / 12, so they must be staged with the sources. Under `jest --ci` a missing `.snap` fails rather than silently re-recording, but a stage that omits them would still leave the pins out of the commit. Keep the staging scoped to spec 174 paths because spec 173's files share the index.
- (Verification gap, not a code defect) AC-23, the 390 px browser check, is recorded in the spec as not yet run. The jest coverage for the pill is thorough: tag present, absent, localized, themed, `numberOfLines === 1`, through both `PhoneOrdering` and `PhoneApproveOrder`. It does not exercise real layout, so the "does not push the stepper off a 390 px row" claim in AC-15 rests on that browser check.

### Overall
The implementation follows the design closely and is easy to read. Every non-flagged path is the original expression moved into the else arm of a ternary, so byte-identity is credible, and snapshots captured before the source edit back it up. The `onHandOf` helper in `handlePdfExport` correctly uses the coerced `locale` (`ReorderSection.tsx:1206-1218`), so zh-CN gets the English label. Tests cover the AC-20 "zero but not flagged" arm in every builder file. Ready from a code-quality standpoint.
