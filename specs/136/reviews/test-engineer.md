## Test report for spec 136

Scope reviewed: `specs/136-notification-toggle-cross-instance-sync.md`
(problem, acceptance criteria, `## Backend design` §1 registry design, §2 jest
approach), `src/lib/useNotificationToggle.ts`,
`src/lib/useNotificationToggle.test.tsx`, `jest.config.js`,
`src/screens/staff/components/NotificationReminderBanner.tsx`.

### Acceptance criteria status

- AC1: "After one mounted instance completes an **enable** action, every OTHER
  mounted instance re-probes and updates its `view` WITHOUT any
  `visibilitychange` event" → **PASS** —
  `src/lib/useNotificationToggle.test.tsx::"A enabling flips B.view to \"on\"
  via the registry, with no visibilitychange event"`. Verified the test file
  never dispatches `visibilitychange` anywhere (grep confirms zero
  `dispatchEvent`/`visibilitychange` calls in the file); the only
  cross-instance mechanism exercised is the module-scoped registry.

- AC2: "After one mounted instance completes a **disable** action, every other
  mounted instance re-probes... the same way" → **PASS** —
  `src/lib/useNotificationToggle.test.tsx::"A disabling flips B.view back to
  \"off\" the same way"`. Also asserts `mockUnsubscribeFromPush` called
  exactly once (confirms A, not B, performed the action).

- AC3: "The instance that performed the action still shows its just-set
  transient `message`... the broadcast it emits MUST NOT clear its own
  transient message" → **PASS** —
  `src/lib/useNotificationToggle.test.tsx::"preserves the acting instance
  transient failure message through its own broadcast"`. Asserts `A.body ===
  'chrome.notifications.msg.denied'` survives A's own broadcast, and B (which
  received the authoritative `refresh(true)`) has `body === null`, proving the
  split fires in both directions.

- AC4: "Concretely on the staff PWA: enabling notifications from Settings
  `NotificationSwitcher`, then navigating back to EODCount, shows NO red
  reminder banner and a GREEN `SettingsGear` dot, with no
  background/reopen/refresh" → **NOT TESTED (justified, but unverified
  post-fix)**. No automated test (jest or Playwright `e2e/`) exercises this
  end-to-end through the real `NotificationSwitcher` → `SettingsGear` /
  `NotificationReminderBanner` component tree with a live service-worker push
  subscription. The architect's design (§2) explicitly rules this out of
  automated coverage ("a Playwright reproduction would require a real
  service-worker push subscription, which the E2E suite explicitly excludes"),
  and I checked `e2e/*.spec.ts` — there is no notification-related E2E spec, so
  that's an accurate statement, not an omission. However, the developer's own
  "Verification results" section states browser verification of the fix was
  **not performed** ("This session also has no `preview_*` browser-driving
  tools"). So this concrete, owner-reported repro scenario has zero
  post-fix confirmation beyond the unit-level registry test and a `tsc`
  typecheck pass. The unit tests (AC1-AC3) cover the underlying mechanism the
  four consumer components all share, and `NotificationReminderBanner.tsx` /
  `SettingsGear.tsx` / `NotificationSwitcher.tsx` were not edited (only consume
  the hook), so the risk of a mechanical wiring mistake in those three files is
  low — but this AC's literal wording (a concrete on-device/browser
  observation) is not covered by anything that ran in this pipeline. Flagging
  as a gap for the release-coordinator; recommend one manual device check
  before/shortly after ship, given the owner filed this as a live prod
  complaint.

- AC5: "The stale 'Only one screen is mounted...' comment... is corrected" →
  **PASS** — verified by direct read of
  `src/screens/staff/components/NotificationReminderBanner.tsx:11-22`. The
  false "single live probe" claim is replaced with accurate language stating
  the four in-store screens stay mounted simultaneously and that cross-instance
  consistency is guaranteed by the hook's spec-136 broadcast. This is a
  comment-only diff verified by inspection, not a jest assertion — appropriate
  since there's no runtime behavior to assert on a comment.

- AC6 (jest track): "a test renders TWO `useNotificationToggle` instances;
  instance A performs enable; instance B's `view` flips to `'on'` without any
  `visibilitychange` event dispatched" → **PASS** — same test as AC1. Confirmed
  by running `npx jest useNotificationToggle --verbose` — passes in both jest
  projects.

- AC7 (jest track): "a test asserts the acting instance's transient `message`
  is preserved through its own post-action broadcast" → **PASS** — same test
  as AC3.

### Test run

Confirmed the new suite executes in **both** jest projects (this is the exact
concern the `jest.config.js` `testMatch` change was added to address):

```
$ npx jest --selectProjects unit useNotificationToggle --listTests
Running one project: unit
.../src/lib/useNotificationToggle.test.tsx

$ npx jest --selectProjects component useNotificationToggle --listTests
Running one project: component
.../src/lib/useNotificationToggle.test.tsx
```

Both projects pick it up. Verbose run of just this suite:

```
$ npx jest useNotificationToggle --verbose
PASS component src/lib/useNotificationToggle.test.tsx
PASS unit src/lib/useNotificationToggle.test.tsx
Test Suites: 2 passed, 2 total
Tests:       6 passed, 6 total  (3 tests x 2 projects)
```

Full suite, real exit code (not piped through grep/head):

```
$ npx jest > /tmp/te136.log 2>&1; echo $?
0
Test Suites: 129 passed, 129 total
Tests:       1369 passed, 1369 total
Time:        4.445 s
```

Exit code 0, matching the developer's claimed 129 suites / 1369 tests. The two
console.warn/act-warning blocks in the tail of the log are from
`src/screens/staff/screens/EODCount.tsx` and
`src/screens/staff/lib/itemsUpdated.ts` — pre-existing, unrelated to spec 136,
and did not fail any test.

Typecheck (spot-checked, not re-run in full since the developer's report
already shows exit 0 and no files changed since):
`npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` both reported
exit 0 per the spec's own Verification results section; not independently
re-run here since no additional edits were made during this review.

### Notes

**Registry cleanup on unmount — no direct regression test (gap, non-blocking).**
The design (§1) and both the code-reviewer's and security-auditor's reviews
call out that `reprobeListeners.delete(reprobe)` in the effect cleanup is
load-bearing (prevents a listener leak / stale setState-on-unmounted-component
warnings once an instance navigates away and unmounts). I confirmed by
inspection that all three tests in the suite only call `A.unmount();
B.unmount();` at the very END of each test, after all assertions — none of
the three tests unmount ONE instance and then trigger an action on the
OTHER, remaining instance to prove the unmounted one was actually removed from
the `Set` (e.g., unmount B, then have A enable, and assert no warning /
`reprobeListeners.size === <expected>`). This means: if a future edit
accidentally dropped the `.delete(reprobe)` call, this suite would NOT catch
it — the security-auditor's "no listener leak" finding is presently backed
only by code inspection, not by a regression test. This is not one of the
spec's 7 named acceptance criteria, so I'm not marking any AC FAIL for it, but
I recommend a follow-up unit test asserting cleanup (unmount one instance
mid-test, verify the other instance's next reprobe still succeeds without
error and that the unmounted instance's own state is no longer touched) to
close this as a durable regression guard, per the design doc's own framing of
this as "the exact regression the unit test in §2 is the guard against"
(that framing, on inspection, is actually about the mount-effect *ordering*
guard — verified as covered below — not the unmount-cleanup path, which
remains untested).

One thing this suite DOES effectively cover, confirmed by re-derivation: the
"registration must sit BEFORE the web-only `document` guard" ordering
constraint IS exercised, because the `unit` project runs in a `node` env with
no global `document`. If `reprobeListeners.add(reprobe)` were moved inside the
`Platform.OS === 'web' && typeof document !== 'undefined'` guard, the `unit`
project's copy of this suite would fail outright (B would never register, so
B's `view` would never flip) even though the test forces
`Platform.OS = 'web'` via the `react-native/Libraries/Utilities/Platform`
mock — because `typeof document !== 'undefined'` would still be `false` in
node. So running the same suite in both projects is doing real, distinct
work, not just duplicating assertions cosmetically for the registration-order
invariant — though it is fully duplicative for everything else in the file
(the code-reviewer's `.test.ts`-would-have-worked observation is correct for
the OTHER two invariants, just not for this one).

**jest.config.js `testMatch` change — coordinating with code-reviewer's
should-fix, as requested in their review.** I agree with the code-reviewer:
the test file contains zero JSX and the `.tsx` extension is not load-bearing
for the cross-instance-registration-ordering coverage described above (that
coverage comes from the `unit` project's lack of `document`, not from the
`.tsx` extension or the `component` project). The `jest.config.js` double-glob
does correctly make the suite execute in both projects (verified above), so it
is not a false claim in the developer's report — but the code-reviewer's
suggested alternative (rename to `useNotificationToggle.test.ts`, drop both
`jest.config.js` hunks) would NOT lose the ordering-invariant coverage, because
that coverage is inherent to the `unit` project's node env regardless of which
glob matched the file into it — only the `component`-project run would be
lost, and that run is genuinely redundant (identical assertions, no
environment-dependent branch, per the test file's own header comment). My
recommendation: rename the file to `.test.ts` and revert the `jest.config.js`
hunks in a fast-follow — smaller diff, avoids widening shared test
infrastructure for a spec that touches zero backend and is scoped to one hook
file, and loses zero real coverage. Not blocking merge; a Should-fix, matching
the code-reviewer's severity.

**Framework conformance.** No new test framework introduced; the suite uses
the existing jest + `@testing-library/react-native` (`renderHook`/`act`/
`waitFor`) pattern already in use elsewhere in `src/lib/**/*.test.ts`. No CI
workflow changes. Consistent with CLAUDE.md's three-track policy.

**Mocking boundary.** Correctly hybrid-mocked per `tests/README.md`: mocks
`./webPush` (impure I/O) and partially mocks `./notificationState` via
`jest.requireActual` to keep the pure `deriveNotificationState` +
`subscribeCodeToMessageKey` real while stubbing only the impure
`probeNotificationState`. This is real-logic-preserving, not a
mock-everything anti-pattern — consistent with the Track-1-unit mocking tier
in `tests/README.md`.

**Frontend-only spec — no DB/Supabase involvement.** Confirmed via the spec's
own `## Backend design` (explicitly N/A across data model / RLS / API
contract / edge functions / realtime / `db.ts`) and by grep of the four
changed files for `supabase`/`.from(`/`.rpc(` (none found, matching the
security-auditor's finding). `npm run dev:db` / pgTAP / shell smokes do not
apply to this spec; no realtime publication touched, so no
`docker restart supabase_realtime_imr-inventory` needed.

### Summary

5 of 7 explicit acceptance criteria PASS via automated jest tests that
demonstrably execute (verified `--listTests` in both projects and a verbose
run showing 6/6 green). AC5 (comment fix) PASS by direct inspection. AC4 (the
concrete owner-reported PWA repro scenario) is NOT TESTED by any automated
test in this pipeline and was not manually verified post-fix either — this is
consistent with the architect's own scope ruling (no E2E/Playwright coverage
for this spec) but leaves the literal, concrete user-facing repro
unconfirmed. Registry-cleanup-on-unmount has no dedicated regression test
(gap, not a named AC, non-blocking but worth a fast-follow). Full jest suite:
129 suites / 1369 tests, exit code 0.
