## Code review for spec 153

Scope: all files under the spec's `## Files changed` list (bottom of
`specs/153-pwa-install-tutorial.md`). Read against CLAUDE.md conventions and
the architect's binding design rulings in the spec's `## Backend design`
section.

### Ruling on the three flagged deviations (Implementation notes)

1. **`src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` (new, beyond
   the plan).** Approved — strictly additive, follows the codebase's established
   `<Component>.specNNN.test.tsx` sibling-suite convention (19 existing precedents,
   e.g. `ReorderSection.spec138.test.tsx`, `useStore.sessionLoss.spec152.test.ts`),
   lands in the `component`/jsdom jest project per `jest.config.js`'s
   `src/screens/**/*.test.tsx` glob, and does not touch the base
   `ResponsiveCmdShell.tsx` or weaken any existing suite. It pins exactly what §7
   flagged as expensive-to-cover (the three breakpoint branches, the collapsed-rail
   twin, the single-node testID claim, and the phone drawer-closes-before-sheet-opens
   ordering) with real jest assertions instead of "read the branches at review
   time." This is a strict improvement over the architect's fallback, not a
   deviation that needs walking back.
2. **`_resetInstallPrompt()` also tears down the installed `window` listeners,**
   not just the captured event + subscribers. Approved — the function is
   test-only (grep confirms its only two call sites are `installGuide.ts`'s own
   definition and `installGuide.test.ts`), it's strictly wider than the spec's
   description rather than narrower, and it's what makes
   `startInstallPromptCapture()`'s idempotency test able to start clean in every
   `it` block. No production code path is affected by the widened scope.
3. **`promptInstall()` maps a throwing `prompt()` to `'dismissed'`** rather than
   leaving that case unstated. Approved — the spec's contract for this function
   was "never throws," and a `try/catch` around `await e.prompt()` /
   `await e.userChoice` is the only way to honor that against a real
   `BeforeInstallPromptEvent`, which can throw `InvalidStateError` on a second
   `prompt()` call or reject the `userChoice` promise. Mapping a rejected/thrown
   prompt to `'dismissed'` (a non-install) rather than `'unavailable'` (nothing
   was ever captured) is the more accurate of the two available codes — the ref
   *was* captured and *was* used, it just didn't result in an install. Correctly
   pinned by `installGuide.test.ts`'s "a throwing prompt() never escapes as a
   rejection" case.

None of the three rise to Should-fix; all are reasonable, narrowly-scoped
interpretations of a design that explicitly left them open ("under-specifies,"
"leaving the mid-prompt failure unstated").

### Critical

None.

### Should-fix

None.

### Nits

- `src/lib/installGuide.test.ts:129-136` — the "glyphs live in the model, never
  in a catalog" pin only spot-checks one glyph per platform (`ios[1]`,
  `android[0]`, `desktop[0]`). `ios` ships four steps with four distinct glyphs
  (`◉ ↑ ⊞ ✓`) and only one is pinned; a future edit could swap `step1`'s `◉` for
  something else without this test catching it. Minor — flagging for
  test-engineer rather than blocking, since it's a coverage completeness
  question, not a correctness bug.
- `src/screens/cmd/ResponsiveCmdShell.tsx:319-341` vs `:365-375` — the install
  entry is hand-duplicated between `sidebarFooterLeft` (text chip) and
  `railFooter` (glyph-only twin) rather than factored into one small shared
  `InstallEntryChip` component parameterized on `compact`. Both call sites are
  short and the JSX genuinely differs (label text vs. bare glyph), so this is a
  preference nit, not a duplication problem — the `showInstallEntry` gate itself
  is computed once and reused correctly in both places.
- `src/components/cmd/InstallGuideSheet.tsx:78` — the sheet title uses
  `Type.caption` (mono, uppercase, 10px) where the reference shape it says it's
  copying (`PhoneNotifications.tsx:248`) uses an inline `fontSize: 11` literal
  with the same visual intent. Using the actual typed token here is better than
  the reference's inline literal, not worse — noting only because a future
  diff-against-reference reviewer might wonder why the two don't match
  byte-for-byte; they're supposed to look the same, just one uses a token.

### Verified clean (no findings)

- **Module-cycle ruling (§1) holds.** `notificationState.ts` has zero import of
  `installGuide.ts` (only a comment mentioning it); the dependency is strictly
  `installGuide → notificationState`. `detectStandalone()`'s body in
  `notificationState.ts:127-139` is byte-identical to the pre-existing inline
  expression per the spec's own diff description, and
  `src/lib/notificationState.test.ts` is untouched and still imports only
  `deriveNotificationState` / `subscribeCodeToMessageKey` / `DeriveInput`
  (AC-REG1 holds by construction).
- **`public/sw.js` diff is exactly the no-op `fetch` listener** (lines 14-26):
  registers, never calls `respondWith`, no `caches.*`. The `install` / `activate`
  / `push` / `notificationclick` handlers are unchanged. No hard-prohibition
  violation.
- **i18n parity, all six catalogs.** `chrome.installGuide.*` lands identically
  shaped in `src/i18n/{en,es,zh-CN}.json` and
  `src/screens/staff/i18n/{en,es,zh-CN}.json` — same key tree, no glyphs leaked
  into any catalog string (glyphs stay in `installGuide.ts`'s model), `chip` is
  kept short in all three locales per §8.5's footer-width warning.
- **Drawer-close-before-sheet ordering.** `ResponsiveCmdShell.tsx:290-293`'s
  `openInstallGuide` calls `setMobileDrawerOpen(false)` before
  `setInstallGuideOpen(true)` in the same handler, exactly per §3's nested-Modal
  Critical, and it's pinned by
  `ResponsiveCmdShell.spec153.test.tsx`'s "phone: the press CLOSES the drawer
  before opening the sheet" test.
- **No direct Supabase calls, no store mutations, no `notifyBackendError` import**
  anywhere in the diff (grep-confirmed on `installGuide.ts`) — consistent with
  the backend design's explicit "this spec is frontend-only" verdict.
- **No inline color literals** in production code (`InstallGuideSheet.tsx`,
  `InstallGuideCard.tsx`, the `ResponsiveCmdShell.tsx` additions) — everything
  routes through `useCmdColors()` / `useStaffColors()`. Hex literals only appear
  inside test-file `jest.mock` color-token stubs, which is the established
  pattern for these suites.
- **`app.json` untouched**, `public/manifest.json` diff is exactly the one
  `"purpose"` token on the 512 icon, everything else byte-identical.
- **Web-only guards present everywhere a browser global is touched**
  (`Platform.OS === 'web'` / `typeof window !== 'undefined'` /
  `typeof navigator === 'undefined'` checks in `installGuide.ts`,
  `InstallGuideSheet.tsx`, `InstallGuideCard.tsx`), following the project's
  guard-after-hooks convention (also used in `ReorderSection.tsx`).
- **Test-track placement is correct.** `installGuide.test.ts` matches the `unit`/
  node jest project's `src/lib/**/*.test.ts` glob;
  `InstallGuideSheet.test.tsx`, `Settings.test.tsx`, and
  `ResponsiveCmdShell.spec153.test.tsx` all match the `component`/jsdom project's
  `src/screens/**/*.test.tsx` / `src/components/**/*.test.tsx` globs. No ad-hoc
  test file outside the three established tracks.
- **`Settings.tsx` section order preserved** (Notifications → Language → Text
  size → InstallGuideCard → Report an issue → Sign out) and the spec-152
  sign-out ordering pins in `Settings.test.tsx` are unmodified in assertion
  shape, only gaining new `jest.mock` boundaries for `lib/installGuide` and the
  `Platform` module.
