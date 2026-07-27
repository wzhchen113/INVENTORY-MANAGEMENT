## Code review for spec 140

Scope reviewed: `src/lib/eodKeypad.ts` (+ `.test.ts`), `src/screens/cmd/sections/eod/PhoneEodCount.tsx`,
`src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx`, `src/theme/typography.ts` (`PhoneType`),
`src/screens/cmd/sections/EODCountSection.tsx` (diff surface), the three `eod/__tests__/*` files, and
`src/i18n/{en,es,zh-CN}.json`.

### Critical

None.

### Should-fix

- `src/screens/cmd/sections/eod/PhoneEodCount.tsx:206` — the phone header date line hardcodes
  English and bypasses the app's locale system: `` `WK ${model.wkNum} · ${new Date(...).toLocaleString('en', { month: 'short', year: 'numeric' })...}` ``.
  The desktop tree one screen away renders the equivalent value through the i18n catalog —
  `T('section.eod.weekShort', { num: wkNum })` (`EODCountSection.tsx:1106`), and `en.json` /
  `es.json` / `zh-CN.json` all carry a translated `section.eod.weekShort` key (`"wk {num}"` /
  `"sem {num}"` / `"第 {num} 周"`). This file is otherwise careful about i18n — the day-of-week
  label two lines below correctly goes through `dayOfWeekShortLabel(d.day, T)` — so the header
  line reads as an oversight rather than a deliberate choice, and it will show "WK 30 · JUL 2026"
  to a Spanish/Chinese-locale manager. Use the existing `weekShort` key for the "WK N" segment and
  either accept the English month/year (documented) or route the `Intl`/`toLocaleString` call
  through the current `Locale` (`useLocale()`, already a hook in this codebase) rather than a
  literal `'en'`.

### Nits

- `src/screens/cmd/sections/eod/PhoneEodCount.tsx:215` — `const [dom] = [d.date.split(' ')[1] ?? d.date];`
  wraps a single value in an array only to immediately destructure it back out. Equivalent to,
  and clearer as, `const dom = d.date.split(' ')[1] ?? d.date;`.
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx:440` and `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx:217` —
  `... as any` casts to smuggle a web-only style key (`pointerEvents`, `outlineStyle`) past RN's
  `StyleProp` typing. This mirrors the pre-existing pattern in `ResponsiveSheet.tsx` (e.g.
  `boxShadow` casts), so it's consistent with the codebase's established idiom for this exact
  RNW/RN type gap rather than a new problem — flagging only because CLAUDE.md calls out `as`
  casts used to suppress type errors; no action expected here given the precedent.
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx:126` — `accessibilityLabel="Close"` is a
  hardcoded English string. Same as `InviteUserDrawer.tsx`, `BrandFormDrawer.tsx`,
  `VendorFormDrawer.tsx`, and several other drawers in the codebase — pre-existing, inconsistent
  convention across the codebase (some drawers use `T('common.close')`), not something this spec
  introduced or should be on the hook to fix alone.

### Verification notes (not findings)

- **AC-REG / early-return shape** (`EODCountSection.tsx:1044-1088`): confirmed the only textual
  edits to this file are (1) the `import PhoneEodCount from './eod/PhoneEodCount'` line, (2) the
  `if (isPhone) return <PhoneEodCount model={{...}} />` block placed after the `__all__` guard and
  the `storeLoading` skeleton guard and before the desktop `return (<> ...`, and (3) `export` added
  to `function EODHistoryTab()` (line 1836) and `function VarianceLogTab()` (line 1953). The
  `model` object is built entirely from state/memos/handlers that already existed above the early
  return (`week`, `vendorTabs`, `countedItemIds` from the pre-existing `deriveCountedItemIds`
  memo, `onSubmit`, etc.) — nothing new is computed on the desktop path. The vestigial `isPhone`
  sub-branches still inside the desktop return tree (day-strip ~1129, `ScrollView` wrappers
  ~1502/1628, footer wrap bits) are dead code post-early-return, exactly as the spec's Risks
  section calls out and explicitly asks reviewers not to file as a fresh bug — treating that as
  accepted, not flagged above.
- **`src/lib/eodKeypad.ts`**: pure, total, no React/store/Supabase imports. `appendKeypadDigit`
  correctly clamps at `maxLen` (default 5) as a character clamp (not numeric), allows exactly one
  `.`, and backspace on empty is a safe no-op. `activeFieldFor` treats `undefined`/`null`/`0`/`1`
  as `'units'` and anything `> 1` as `'cases'`, matching AC-7. `advanceUncounted` searches forward
  from `fromIndex + 1`, wraps via `((fromIndex + step) % n + n) % n` (also normalizes a negative
  `fromIndex`), covers all `n` positions so a list whose only uncounted row is the current one
  still resolves to itself, and returns `null` on an empty list or when everything is counted —
  no edge-case gaps found, and `eodKeypad.test.ts` exercises all of the above including the
  negative-index normalization and the 5-char/decimal-inside-budget cases.
- **No new `@gorhom`/Reanimated-on-web, no duplicated count state**: `PhoneKeypadSheet.tsx` is
  built entirely on the sanctioned `ResponsiveSheet` (`presentation={{ phone: 'bottom-sheet' }}`,
  RN `Modal` + `Animated`); count/unit/note fields are `Pressable`/`Text` (not `TextInput`) except
  the note field, matching the spec's rationale. All digit/note writes go through
  `model.setCaseCounts` / `model.setUnitCounts` / `model.setNotes` (the parent's existing state
  setters) — no local shadow copy of the count maps, no new store fields. `onSubmit`,
  `firstUncounted`, `deriveCountedItemIds` (via the `countedItemIds` prop), and
  `usePaletteAction.getState().request(...)` (inside the parent's unmodified `onSubmit`) are all
  reused verbatim, not reimplemented.
- **`pendingFocusItem` double-consumer ordering**: `PhoneEodCount.tsx:102-110`'s synchronous
  `useEffect` (snapshotting into `sheetItemId` local state) runs before the parent's
  double-`requestAnimationFrame` clearing effect (`EODCountSection.tsx:236-250`), so the capture
  is robust as designed; verified both effects and the ordering claim.
- **`PhoneType` additive contract**: `typography.ts` leaves the existing `Type` map byte-unchanged
  and introduces `PhoneType` as a new top-level export; `metaMono.fontSize` (11) and
  `microCaption.fontSize` (9) both clear their stated floors (≥10.5 / ≥8.5); no new palette values
  are referenced anywhere in the two new component files — every color used (`accent`, `accentBg`,
  `accentFg`, `panel2`, `border`, `borderStrong`, `ok`, `warn`, `info`, `violet`, `violetBg`, `fg`,
  `fg2`, `fg3`) already exists in `src/theme/colors.ts`.
- **i18n parity**: `section.eod.phone.{skip,nextItem,done,left,ready,sent,counted,casesWell,runningTotal,allCounted}`
  present with the same 10 keys, in the same order, across `en.json`/`es.json`/`zh-CN.json`.
