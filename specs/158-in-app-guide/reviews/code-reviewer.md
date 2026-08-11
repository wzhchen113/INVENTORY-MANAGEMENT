# Code review for spec 158

Scope: the spec-158 in-app Guide diff only. `supabase/migrations/20260809000000_super_admin_policy_parity.sql`,
`supabase/tests/super_admin_policy_parity.test.sql`, `src/screens/DBInspectorScreen.tsx` (+ test), and
`specs/157-*` are pre-existing spec-157 work in the same staged diff — not reviewed here, not drift.

Overall: this is a clean, disciplined implementation of the corrected (`## Backend design` §0 C-1..C-5) spec.
Zero backend surface confirmed (no `supabase.from`/`rpc`/`functions.invoke`/`fetch`, no `auth_can_see_store` hits,
no `db.ts`/`useStore.ts`/`useStaffStore.ts`/`app.json`/`sidebarLayout.ts` edits found under any guide-related
file). Staff isolation (spec 063) holds: `guide.ts` is pure, staff files only import the four allowed exports,
and every staff call site passes the literal `'staff'` audience (verified both by inspection and by the
`guide.i18n.test.ts` grep suite). The compile-time seam (`NavItem`/`AdminSectionId`/`Record<Exclude<...>>`)
is wired with no `as`-cast defeats. `GuideTopicBody` is genuinely the single renderer, mounted verbatim by
both `GuideSection` and `GuideSheet`. Optional-prop additions (`TitleBar.onHelpPress`, `MobileTopAppBar
.onTitlePress`) are correctly additive and pinned byte-identical by `ResponsiveCmdShell.spec153.test.tsx`
/ `MobileTopAppBar.test.tsx`'s "no `onTitlePress`" case. `AC-11`'s "no other file under
`src/screens/cmd/sections/` touched" holds (only `GuideSection.tsx`/`.test.tsx` under that tree reference
"Guide"; `phone/PhoneDrillScaffold.tsx` and `phone/usePhoneDrill.ts` are imported, not modified, matching
Deviation #3).

### Critical

None found.

### Should-fix

- `src/screens/cmd/ResponsiveCmdShell.tsx:310-314` (`openGuideSheet`) + `src/screens/cmd/sections/GuideSection.tsx:116-146`
  (`indexList`/`GuideIndexRow`, testID `cmd-guide-index-<id>`) + `src/components/cmd/GuideSheet.tsx:127-151`
  (index view, same testID) — **the `?` affordance is never suppressed when the active section IS `Guide`
  itself**, so pressing it while already on the Guide page opens `GuideSheet` in its index fallback (correct
  per the `findGuideTopic` null-safety contract — `GuideSheet.test.tsx`'s "the `Guide` section itself falls
  back to the index" case covers that half) **on top of `GuideSection`'s own always-visible index pane**
  (desktop/tablet two-pane left column, or the phone `PhoneDrillScaffold` list). Both trees render rows under
  the identical testID `cmd-guide-index-<id>` simultaneously. No test exercises `GuideSection` and `GuideSheet`
  mounted together (`GuideSection.test.tsx` never mounts `GuideSheet`; `ResponsiveCmdShell.spec158.test.tsx`
  mocks `InventoryDesktopLayout`'s body down to a stub, so the real `GuideSection` never renders inside a shell
  test either). In production this is a confusing redundant full-index popup over an already-visible full
  index, and the duplicate testID is a latent trap for the next integration test that tries `getByTestId` in
  that state. Suggest either a no-op guard in `openGuideSheet` when `section === 'Guide'`, or hiding
  `onHelpPress`/`onTitlePress` when the active section is already `Guide`.

### Nits

- `src/screens/cmd/sections/GuideSection.tsx:49-79` (`GuideIndexRow`) vs. `src/components/cmd/GuideSheet.tsx:127-151`
  (inline index row) — near-identical row markup (title + purpose, same testID convention, same touch-target
  shape) implemented twice rather than factored into one shared row component, the way `GuideTopicBody` was
  for the detail view. Spec only mandated a single renderer for the *topic body*, so this isn't a violation,
  but it's the same duplication risk in miniature — a future copy/style tweak to one index row can silently
  drift from the other. (out-of-scope for this review to redesign; flagging for awareness only.)
- `src/i18n/en.json:1842` / staff `groups.staff` and admin `groups.admin`/`groups.tenancy`/`groups.overview` —
  by design (§8 R-9 / Deviation #6) every `GUIDE_CHROME_KEYS` entry, including group labels the audience never
  renders (e.g. `groups.staff` on the admin surface, `groups.admin`/`groups.tenancy` on the staff surface),
  ships in all six catalogs for parity-test simplicity. Confirmed intentional per the spec's own rationale —
  not flagging as a defect, just noting for the release-coordinator that the extra strings are expected, not
  scope creep.
