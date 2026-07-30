## Test report for spec 148

Track confirmation: frontend-only per the spec header. `git show --stat
1661d54` shows zero touched files under `supabase/`, `scripts/`, or `e2e/` for
the whole six-spec batch (143-148). **Jest track only**, no fourth framework
introduced (the pre-existing spec-078 Playwright `e2e/` track is untouched).

This is the final spec in the batch, so this report also carries the
cross-cutting findings that apply across specs 143-148 (the `typecheck:test`
gate and one undocumented file change) — referenced from the other five
reports rather than repeated in full there.

### Acceptance criteria status

- AC1 (Login: `im.cmd▮` mark w/ accent cursor, 48px wells, 50px accent SIGN
  IN, honest FORGOT PASSWORD toast, store/version footer; every tappable
  ≥44×44; both themes via tokens) → PASS on the behavioral half — see Notes
  (fork pin + honest toast are directly tested); layout/dimension claims are
  structural/manual per the batch-wide pattern. Dispatcher's live browser pass
  covered phone login per the task brief.
- AC2 (Notifications: bell opens the sheet; rows deep-link + mark read; MARK
  ALL READ works; push toggle in the footer; badge red ONLY with an unread
  `missed_eod`, else accent; every tappable ≥44×44) → PASS — the spec-121
  badge rule is precisely pinned (see Notes); row deep-link/mark-read and MARK
  ALL READ are both directly asserted. Dispatcher's live browser pass verified
  the badge accent-vs-danger states and the sheet rows/toggle per the task
  brief.
- AC3 (Store switch: chip in the drawer header; store rows show CURRENT/
  SWITCH; a switch fires the spec-111 takeover + toast + closes the drawer;
  brand section only for super-admin; access filtering matches the desktop
  switcher) → PASS — all named behaviors directly tested (see Notes).
  Dispatcher's live browser pass covered the store-switch sheet per the task
  brief.
- AC4 (Desktop/tablet `LoginScreen` render output byte-unchanged, AC-REG; the
  phone-branch chrome swaps — bell → `PhoneNotifications`, drawer `storeChip`
  — touch only the `isPhone` branch of `ResponsiveCmdShell` + an additive
  optional `MobileNavDrawer` prop, desktop/tablet chrome untouched) →
  **PARTIAL.** The `LoginScreen` half is fully PASS:
  `PhoneLogin.test.tsx`'s fork-pin test mounts the REAL `LoginScreen` at all
  three tiers and confirms phone → `PhoneLogin`, desktop/tablet → the
  byte-unchanged card, mirroring the AC-REG pattern used everywhere else in
  the batch. The `ResponsiveCmdShell`/`MobileNavDrawer` half is **NOT
  jest-tested at all** — there is no test file anywhere in the repo that
  imports or mounts `ResponsiveCmdShell` or `MobileNavDrawer` directly
  (confirmed via `grep -rl` across all `*.test.tsx`/`*.test.ts` — zero hits
  for either component as a render target; a few files reference
  `PhoneInventory.acReg.test.tsx` and `StoreSwitchOverlay.test.tsx` but neither
  mounts the shell or drawer). I read the actual diff
  (`git show 1661d54 -- src/screens/cmd/ResponsiveCmdShell.tsx
  src/components/cmd/MobileNavDrawer.tsx`) and independently confirmed by
  inspection that: (1) the `<PhoneNotifications />` swap for
  `<NotificationToggle variant="bar" />` sits strictly inside the existing
  `if (isPhone) { … }` branch (line ~398 onward) — the tablet/desktop
  `NotificationToggle` callers noted in the spec's deviations section
  (tablet rail, full variant) are in a different code path untouched by this
  diff; and (2) `MobileNavDrawer`'s new `storeChip` prop is additive-optional
  (`storeChip?: React.ReactNode`) and only renders
  `{storeChip ? <View>{storeChip}</View> : null}` — a caller that doesn't pass
  it renders nothing extra. Both of these read as correct on inspection, but
  "correct on inspection" is not the same evidentiary bar the rest of this
  batch holds itself to (real component mounts + assertions) — there is no
  regression net here if a future change to `ResponsiveCmdShell` accidentally
  moves the `PhoneNotifications`/`PhoneStoreSwitch` mounts outside the
  `isPhone` branch, or if `MobileNavDrawer` stops treating `storeChip` as
  optional. `PhoneNotifications.test.tsx` and `PhoneStoreSwitch.test.tsx` both
  mount ONLY the standalone sub-component (with `model`/props stubbed), never
  through the real shell/drawer — so the "wiring" claim in this AC is
  source-verified, not test-verified. Scoring this PARTIAL rather than FAIL
  because the sub-components themselves are thoroughly tested and the wiring
  diff is small/additive/inspectable, but this is a real, identifiable gap:
  **NOT TESTED for the `ResponsiveCmdShell`/`MobileNavDrawer` wiring claim
  specifically.**
- AC5 (`npx tsc --noEmit` clean; full `npx jest` green — spec claims 1658,
  matching the final batch total) → **PARTIAL — see the consolidated
  `typecheck:test` finding below.** `npx tsc --noEmit` is clean (0 errors).
  Full `npx jest`: **172 suites / 1658 tests, all green** — exactly matches
  this spec's stated target and the task prompt's expected ~172/1658. However
  `npm run typecheck:test` (the CI Track 1a gate in
  `.github/workflows/test.yml`, named in this project's "Typecheck gates")
  **FAILS with 3 errors**, none of which are in spec 148's own files (they
  belong to specs 143, 144, and 146 — see below).

### Test run

```
npx tsc --noEmit                        → clean, 0 errors
npm run typecheck:test                  → FAILS, 3 errors
npx jest                                 → Test Suites: 172 passed, 172 total
                                           Tests: 1658 passed, 1658 total
                                           Snapshots: 2 passed, 2 total
                                           Time: ~6.5s
```

### CONSOLIDATED FINDING — `npm run typecheck:test` is broken (applies to specs 143, 144, 146)

Every one of the six specs' "Acceptance" sections claims `npx tsc --noEmit
clean`, which is TRUE and I verified it myself. None of the six specs claims
`typecheck:test` cleanliness in their acceptance text, so this is not,
strictly, a violation of any of the six specs' own stated AC3/AC5. But
`typecheck:test` **is** one of the two standing project-wide typecheck gates
(`.github/workflows/test.yml`'s "Track 1a — typecheck (test graph)" job runs
exactly `npm run typecheck:test`), and it is currently red on `main` (well, on
this branch's `HEAD`) because of three new files from this batch:

```
src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx(56,5):
  error TS2322: Type 'null' is not assignable to type 'OrderSchedule | undefined'.
  [spec 143 — seeds `orderSchedule: null`; store slice type is non-nullable]

src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx(57,5):
  error TS2322: Type 'null' is not assignable to type 'WeeklyCountStatus[] | undefined'.
  [spec 144 — seeds `weeklyCountStatus: null`; store slice type is non-nullable]

src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx(37,54):
  error TS2556: A spread argument must either have a tuple type or be passed
  to a rest parameter.
  [spec 146 — `inviteUser: (...args: unknown[]) => mockInviteUser(...args)`
   spreads into a zero-arg jest.fn()]
```

Reason this matters and isn't a nitpick: jest itself doesn't typecheck test
files (babel-jest strips types), so `npx jest` is fully green and gives no
signal that CI's separate typecheck job would fail. This is exactly the
"local-green / CI-red asymmetry" pattern this project's CLAUDE.md has been
burned by before (spec 060's pgTAP crash, the migrations-drift gate) — a
different gate, same failure shape: a claim of "tsc --noEmit clean" in the
spec text is true but incomplete, because a sibling gate (`typecheck:test`)
that covers the same new files is not run and is broken.

**This is a Critical finding for the batch** (would fail CI Track 1a on push)
and should block SHIP_READY until fixed. The fix is small and mechanical in
all three cases — either cast the seeded value (`orderSchedule: null as any`
— low quality but matches the existing test-file idiom of `as any` used
elsewhere in the same seed blocks) or seed the correctly-typed empty value
(`orderSchedule: {}`, `weeklyCountStatus: []`), and give `mockInviteUser` a
`(...args: unknown[]) => Promise<...>` signature instead of a zero-arg one.
None of these touch product code — all three are test-file-only fixes.

pgTAP (`npm run test:db`) and shell smokes (`npm run test:smoke`) were not run
for any of the six specs — none of them touch `supabase/`, `scripts/`, or
edge-function contracts; consistent with all six specs' own "jest track only"
framing and confirmed by the file-list diff.

### CROSS-CUTTING NOTE — undocumented file change in the shared commit

`src/screens/cmd/sections/eod/PhoneEodCount.tsx` was modified in this same
commit (`1661d54`) — the `TabStrip` (history.tsx / variance.log /
order-schedule tabs) was removed from the phone EOD-count worksheet per "Hard
Rule 4" (no desktop file-tab strips on phone), per the commit message. This
file is **not listed in any of the six specs' "Files changed" sections**
(specs 140/141 own `PhoneEodCount.tsx`, but neither spec 143 through 148
claims this edit). I checked both `PhoneEodCount.test.tsx` and
`EODCountSection.acReg.test.tsx` (the two suites that touch this component) —
**neither asserts the TabStrip is now absent** (no `queryByText`/
`queryByTestId` negative assertion for the removed tabs). This is a real,
un-pinned regression risk for a real behavior change (a user could no longer
reach history/variance/order-schedule tabs from the phone EOD screen — which
may be entirely intentional per Hard Rule 4, but there is no test that would
catch it silently coming back, nor one that would catch a future accidental
re-introduction of a broken/duplicate tab strip). Since this change isn't
claimed as an AC of any of the six specs under review, I'm not scoring it
against any specific spec's AC — flagging it here as a housekeeping gap for
the release-coordinator's attention: either back-fill a spec note (even a
short "spec 148 also touched PhoneEodCount.tsx as tightening of spec 140's
Hard-Rule-4 compliance") or add the missing regression test, ideally both.

### Notes (behavioral coverage detail)

- **Login fork pin + honest FORGOT PASSWORD toast** — PASS —
  `PhoneLogin.test.tsx` mounts the REAL `LoginScreen` for its fork-pin
  assertion (phone → `PhoneLogin`; desktop/tablet → byte-unchanged card, no
  phone component) and separately asserts `SIGN IN` calls the lifted
  `onSubmit`, FORGOT PASSWORD fires a `Toast.show` (not a fake reset flow),
  and a surfaced auth error renders. The spec's own flagged deviation (Login
  is the shared pre-auth portal — the restyle necessarily reaches staff too on
  phone, since role is unknown pre-auth) is honestly surfaced in the spec
  text itself, not hidden; I agree with the spec's own conclusion that a role
  gate is structurally impossible here (role is unknown until `signIn`
  resolves) — this is a deviation flag, not a coverage gap.
- **spec-121 badge rule — danger ONLY with unread `missed_eod`** — PASS,
  precisely pinned across all three states: unread `missed_eod` present →
  danger; unread present but submission-only (no missed) → accent; the missed
  row IS read (but another unread submission exists) → stays accent. This
  three-state test (not just "has some vs has none") is the correct level of
  rigor for a rule this consequential (a false-danger or false-accent state
  would mislead staff-miss triage), and it reuses `NotificationBell`'s
  exported `feedHasUnreadMissed`/`badgeBackgroundColor`/`badgeTextColor`
  rather than a forked copy, per the spec's reuse mandate — I verified this by
  checking `PhoneNotifications.tsx`'s imports, which do pull from
  `NotificationBell`, not a duplicated local implementation.
- **`sectionForNotification` deep-link map, incl. `issue → null`** — PASS —
  the pure map is unit-tested directly, and the `issue`-row-is-mark-read-only
  (no navigation) behavior has its own dedicated test, matching the spec's
  explicit note that a staff report has no admin section to jump to.
- **Store switch: CURRENT/SWITCH rows, takeover trigger, brand gate, access
  filtering** — PASS — `PhoneStoreSwitch.test.tsx` asserts: picking a
  different store calls `setCurrentStore` + shows a toast + calls
  `onSwitched`; picking the CURRENT store still closes the drawer as a no-op
  (a real edge case — tapping your own current store shouldn't silently do
  nothing with no drawer-close feedback); regular-user access filtering
  (scoped to `user_stores` grants) is asserted distinctly from the admin/
  master/super-admin "sees all" case; and the super-admin brand section is
  asserted hidden for a plain admin and shown + functional
  (`setCurrentBrandId`) for a super-admin.
- **i18n parity** — verified programmatically across all three catalogs for
  the whole six-spec batch (0 missing/extra keys anywhere), including this
  spec's `chrome.phone.login.*` / `chrome.phone.notifications.*` /
  `chrome.phone.storeSwitch.*` keys.
- **Full-batch jest total matches every intermediate spec's stated count** —
  each of specs 143→148 states an incrementally larger `npx jest` total
  (1567 → 1583 → 1595 → 1605 → 1636 → 1658); I did not re-run jest at each
  intermediate commit (only `HEAD`), but the final total (1658) matches this
  spec's claim exactly, and the per-spec test-file counts I inspected are
  consistent with the stated deltas (spec 143 adds 2 new files worth of
  tests, etc.) — no red flag of an inflated/rounded total.

### Verdict for this spec (and the batch)

**No FAIL on any of this spec's core behavioral claims** — the spec-121
badge rule, the deep-link map, the store-switch access filtering, and the
Login fork pin are all directly and precisely tested. Two things prevent a
clean PASS-across-the-board for spec 148 specifically, and one applies to the
batch as a whole:

1. **NOT TESTED**: the `ResponsiveCmdShell`/`MobileNavDrawer` wiring claim in
   AC4 (bell → `PhoneNotifications`, drawer `storeChip` → `PhoneStoreSwitch`,
   confined to the `isPhone` branch, additive-optional prop) has zero direct
   test coverage — verified correct by source inspection only. Since this
   project's convention treats "no test for a claimed AC" as a Critical
   (per the test-engineer brief), I'm scoring this specific sub-claim as
   **NOT TESTED**, while noting the sub-components it wires together
   (`PhoneNotifications`, `PhoneStoreSwitch`) are each thoroughly tested in
   isolation.
2. **Batch-wide Critical**: `npm run typecheck:test` fails on 3 files spread
   across specs 143/144/146 (not 148's own files). This blocks CI Track 1a
   and should be fixed — mechanically simple — before this batch ships.

Recommendation: fix the three `typecheck:test` errors (test-file-only,
low-risk) and add one focused test mounting `ResponsiveCmdShell` (or, at
minimum, extend an existing chrome test) to pin the bell/drawer wiring at the
phone tier, before treating this batch as fully verified. Everything else
across all six specs is solid: jest is fully green (172/172 suites, 1658/1658
tests), every named pure-function boundary case (±15% variance, stepper
clamp, spec-121 badge, four never-the-accent tone helpers) is precisely
pinned, i18n parity is clean across all three catalogs, and no fourth test
framework was introduced.

## Handoff
next_agent: NONE
prompt: Test report complete for spec 148 (and the consolidated batch finding
  across specs 143-148). 5 of 6 reports have no FAIL; one Critical
  (typecheck:test broken — specs 143/144/146) and one NOT TESTED
  (ResponsiveCmdShell/MobileNavDrawer wiring — spec 148) block a clean
  SHIP_READY read; PhoneUsers (spec 146) also has weaker-than-batch visual
  evidence (no drawer nav entry to browser-verify against, pre-existing gap).
payload_paths:
  - specs/143-phone-ordering-tier/reviews/test-engineer.md
  - specs/144-phone-weekly-count-tier/reviews/test-engineer.md
  - specs/145-phone-dashboard-tier/reviews/test-engineer.md
  - specs/146-phone-users-tier/reviews/test-engineer.md
  - specs/147-phone-list-screens-tier/reviews/test-engineer.md
  - specs/148-phone-shell-trio/reviews/test-engineer.md
