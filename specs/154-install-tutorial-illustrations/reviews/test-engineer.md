## Test report for spec 154

### Acceptance criteria status

- AC-1: Every `InstallStep` carries an `art` key; the nine `InstallArt` members
  are each used exactly once across `ios`+`android`+`desktop`, and
  `installSteps()` stays pure/total with its `never` guard intact. → **PASS**
  — `src/lib/installGuide.test.ts::installSteps() — illustration keys (spec
  154 AC-1)` (four `it`s: non-empty art on every step, exactly-9-unique-arts,
  platform-prefix check, pinned step→art assignment matching the spec's
  table). The pre-existing `never`-guard test
  (`rejects a non-member at compile time via the never guard`) is untouched
  and still gated by `npm run typecheck:test` (confirmed clean, see Test run).

- AC-2: `StepIllustration` renders all nine arts without throwing, at any
  `width`, and its registry is `Record<InstallArt, ArtSpec>` so a new member
  fails `npx tsc --noEmit`. → **PASS** —
  `src/components/illustrations/StepIllustration.test.tsx::StepIllustration —
  coverage (AC-1, AC-2)`: a registry↔model-agreement assertion
  (`INSTALL_ART_IDS` sorted vs. the model's flattened `art` list) plus a
  `test.each(INSTALL_ART_IDS)` render-without-throwing pass for all nine, plus
  a four-width render/aspect-ratio check. The `Record<InstallArt, ArtSpec>`
  completeness claim is a compile-time property, not directly unit-testable,
  but is corroborated by `npx tsc --noEmit` passing clean against the full
  nine-member union (verified — see Test run) and by the code shape itself
  (`ART: Record<InstallArt, ArtSpec>` in `StepIllustration.tsx:280`).

- AC-3: The admin sheet renders one illustration per step
  (`install-guide-art-<key>`), switching tabs swaps the illustration set, and
  the "already added" state renders none. → **PASS** —
  `src/components/cmd/InstallGuideSheet.test.tsx::InstallGuideSheet — step
  illustrations (spec 154 AC-3)`: per-step art presence for the active tab
  (iOS, 4/4) + absence of the inactive tab's art; tab-switch swaps the whole
  art set without remounting the sheet; localized OS labels render inside the
  pictures; "already added" renders zero `install-guide-art-*` nodes.

- AC-4: The staff card renders one illustration per step
  (`staff-install-guide-art-<key>`) for the detected platform only, and none
  in the "already added" state. → **PASS** —
  `src/screens/staff/screens/Settings.test.tsx::Settings — Add to Home Screen
  illustrations (Spec 154)`: all 4 iOS-step arts present + Android art absent;
  platform-follow check (Android detected → Android step-2 art present, iOS
  art absent); "already added" → zero art nodes.

- AC-5: No color literal in `StepIllustration.tsx`; every color arrives
  through the `palette` prop, mapped from `useCmdColors()` (admin) and
  `useStaffColors()` (staff) — correct in light and dark. → **PASS** — grep of
  `StepIllustration.tsx` for hex/`rgb(`/`rgba(` literals returns zero matches
  (component-file-only check; the test file's mock palette hex values are
  expected and out of scope). Unit-level: `StepIllustration.test.tsx`'s
  "palette + a11y" block asserts label color is read verbatim off the
  `palette` prop (`highlightInk` / `ink` slots). The light/dark correctness of
  the two call sites' token mappings (`InstallGuideSheet.tsx:74-88`,
  `InstallGuideCard.tsx:54-68`) is asserted in the code-reviewer's report
  (verified `accentBg`/`primaryPressedLight` exist in both token files) rather
  than by a jest theme-flip test — no automated light/dark-specific
  illustration test exists, but this is a reasonable line: the mapping is
  static object literals, not conditional logic, so a compile-time /
  code-review check is adequate coverage for this sub-claim. Flagging as a
  minor gap, not a blocker (see Notes).

- AC-6: Every string drawn inside an illustration comes from
  `chrome.installGuide.art.*` via the surface's own catalog; the five keys
  exist in all six catalog files. → **PASS** — Unit:
  `StepIllustration.test.tsx::StepIllustration — labels come from the prop
  (AC-6)` renders five distinct arts and asserts each drawn label matches the
  `labels` prop value verbatim (proves the component never reads a catalog
  itself). Catalog presence: verified directly by reading all six JSON files
  — `chrome.installGuide.art.{appName,addToHomeScreen,add,installApp,install}`
  present with matching content across both trees
  (`src/i18n/{en,es,zh-CN}.json`, `src/screens/staff/i18n/{en,es,zh-CN}.json`)
  — and enforced going forward by the two catalog-parity suites (AC-REG2).

- AC-7: Zero new image assets — no addition under `assets/` or
  `public/*.png`; the illustrations are vector + tokens only. → **PASS** —
  `git status --porcelain` for the spec's full changeset touches zero files
  under `assets/` or `public/`; the drawing is `react-native-svg` primitives
  only (`Svg`, `Circle`, `Path`, `Rect` — no `Image`, no asset import). `npx
  expo export --platform web` (the spec's own build gate) completed with exit
  0 and produced no new asset files.

- AC-8: Illustrations are decorative to a screen reader (hidden/unlabeled);
  the step prose remains the accessible content. → **PASS** —
  `StepIllustration.test.tsx::StepIllustration — palette + a11y (AC-5, AC-8)`
  asserts `accessible={false}`, `accessibilityElementsHidden={true}`,
  `importantForAccessibility="no-hide-descendants"`, and no
  `accessibilityLabel`. Every illustration query across all three suites
  passes `{ includeHiddenElements: true }` — a query that started passing
  without that flag would itself be evidence the hiding regressed (per the
  implementer's note #3), so the suites are structurally load-bearing on this
  AC, not just assertion-bearing.

### Regression group (AC-REG)

- AC-REG1: Spec-153 behavior is unchanged except the step card gains an
  illustration — tabs, default-tab probe, install-button gates, "already
  added" states, glyph tile, every step string all behave as before; the four
  named suites keep every existing assertion (gain new ones, none deleted or
  weakened). → **PASS** — `git diff --cached -U0` against
  `src/lib/installGuide.test.ts`, `src/components/cmd/InstallGuideSheet.test.tsx`,
  and `src/screens/staff/screens/Settings.test.tsx` shows **0 removed lines**
  in all three (128 lines inserted total, 0 deleted) — confirmed via `grep -c
  '^-[^-]'` on each diff, all three return `0`. `src/screens/cmd/__tests__/
  ResponsiveCmdShell.spec153.test.tsx` — verified by diff-absence: it does not
  appear in `git status --porcelain` at all (last touched at commit `63191f5`,
  the spec-153 landing commit), so it is byte-for-byte unchanged, satisfying
  the spec's claim that this file's suite stays untouched. Full `npx jest`
  (196 suites / 2067 tests) is green, so none of the retained spec-153
  assertions regressed.

- AC-REG2: Both catalog trees stay at parity for the new keys (all three
  locales in each tree), enforced by the two existing parity suites. → **PASS**
  — `src/i18n/i18n.test.ts::i18n catalog parity` (admin tree, `en`/`es`/`zh-CN`
  flattened-key-set equality) and the equivalent
  `src/screens/staff/i18n/i18n.test.ts` (staff tree) both ran green as part of
  the full jest run; both are generic flattened-key-diff assertions, so the
  five new `chrome.installGuide.art.*` keys are covered "for free" exactly as
  the spec's verification section claims, with no test-file edits needed.

- AC-REG3: No backend surface moves (spec 153 AC-REG4, restated) — no
  `supabase/**`, no `src/lib/db.ts`, no store, no `vercel.json`, no
  `app.json`. → **PASS** — full `git status --porcelain` for the spec's
  changeset (14 files: 1 spec doc, 5 component/lib files + their test
  siblings, 6 i18n JSON files) contains zero paths under `supabase/`, no
  `src/lib/db.ts`, no `src/store/**`, no `vercel.json`, no `app.json`.

### Test run

```
$ npx tsc --noEmit
(clean, no output)

$ npm run typecheck:test
> tsc -p tsconfig.test.json --noEmit
(clean, no output)

$ npx jest
Test Suites: 196 passed, 196 total
Tests:       2067 passed, 2067 total
Snapshots:   2 passed, 2 total
Time:        6.038 s
Ran all test suites in 2 projects.
```

Matches the implementer's claimed "196 suites / 2067 tests green (was
195/2033 at spec 153)" exactly.

```
$ npx expo export --platform web
exit 0 — produced dist/_expo/static/js/web/* + index.html + favicon.ico +
metadata.json. No new files under assets/ or public/.
```

pgTAP / shell smokes: not run — correctly out of scope per the spec's own
"No pgTAP (no DB surface), no shell smokes (no HTTP surface)" line, confirmed
by the zero-touch of `supabase/**` and `src/lib/db.ts` above.

### Notes

- **Framework**: no deviation. All new tests land in the existing jest track
  (`src/lib/installGuide.test.ts`, `src/components/illustrations/
  StepIllustration.test.tsx`, `InstallGuideSheet.test.tsx`, `Settings.test.tsx`)
  — no new framework introduced.
- **Diff discipline verified independently, not just asserted by the spec.**
  Re-derived the "additive only" and "file untouched" claims for AC-REG1
  myself via `git diff --cached -U0 | grep -c '^-[^-]'` (0 removed lines in
  all three touched spec-153 test files) and via `git status --porcelain`
  absence for `ResponsiveCmdShell.spec153.test.tsx` — did not take the spec's
  prose at face value.
- **Minor coverage gap (not a blocker):** AC-5's light/dark correctness claim
  ("correct in light **and** dark") has no jest test that renders
  `InstallGuideSheet`/`InstallGuideCard` under both a light-token stub and a
  dark-token stub and diffs the resulting illustration colors. The existing
  coverage (StepIllustration reads color purely off the `palette` prop, plus
  a code-review confirmation that both call sites' token maps resolve to real
  keys in both theme files) is reasonable indirect evidence given the mapping
  is a static object literal with no light/dark branching inside
  `StepIllustration.tsx` itself, but a future spec touching either token file
  would not get an automated signal here if a mapped key silently returned
  `undefined` in dark mode. Not blocking — flagging for awareness only, since
  the component-level design (palette-as-prop, no conditional logic) makes a
  wrong-color-in-dark-mode bug a token-definition bug at the call site, not a
  `StepIllustration` bug, and the call sites are covered by ordinary render
  tests plus the code-reviewer's manual token-existence check.
- **Manual/browser evidence (not independently re-verified by me):** the
  implementer reports a headless-Chromium pass covering the admin sheet at
  1440×900 in light and dark across all three tabs, the admin sheet
  fullscreen at the phone breakpoint (390×844, opened from the hamburger
  drawer), and the staff Settings card at 390×844 as `manager@local.test`,
  with zero console/page errors in every pass. I did not re-run this pass
  myself (no browser-preview tooling was invoked in this review); it is noted
  here as implementer-supplied manual evidence per the task instructions,
  distinct from the jest/typecheck/build gates I did execute directly. Real
  iPhone Safari / real Android Chrome remain uncovered by any automated or
  manual pass in this spec — explicitly carried over from spec 153's existing
  manual-pass gap, not a new hole this spec introduces.
- **No BLOCK.** All 8 primary ACs and all 3 regression ACs are PASS with
  direct or corroborated test evidence; no AC is FAIL or NOT TESTED.
