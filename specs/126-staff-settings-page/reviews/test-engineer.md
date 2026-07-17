## Test report for spec 126

### Acceptance criteria status

**Entry point & navigation**
- AC1: Gear (⚙) renders in the shared in-store header on all four in-store
  screens (EODCount, Reorder, WeeklyCount, Receiving), reachable without
  returning to StorePicker → PASS — `src/screens/staff/screens/Settings.test.tsx::renders the switchers, report form, and sign-out action`;
  static verification `<SettingsGear />` is mounted in
  `src/screens/staff/screens/{EODCount,Reorder,Receiving,WeeklyCount}.tsx`.
- AC2: Tapping the gear navigates to a new `Settings` `Stack.Screen` registered
  in `StaffStack.tsx` alongside `StaffTabs`/`StorePicker`/`Splash`, with a way
  back → PASS — `src/screens/staff/components/SettingsGear.test.tsx::navigates to the Settings screen on press`
  (calls `navigation.navigate('Settings')`); `StaffStack.tsx:209` registers
  `<Stack.Screen name="Settings" component={Settings} />`; back affordance
  verified in `Settings.tsx` (`staff-settings-back` → `navigation.goBack()`).
- AC3: Gear has accessibilityLabel + stable testID (`staff-settings-gear`) →
  PASS — `SettingsGear.test.tsx::exposes an accessibility label`; default
  `testID ?? 'staff-settings-gear'` in `SettingsGear.tsx`.

**Settings screen contents**
- AC4: Settings renders notification/language/scale switchers, sign-out, and
  report form, each clearly labeled → PASS —
  `Settings.test.tsx::renders the switchers, report form, and sign-out action`.
- AC5: Changing language on Settings updates staff UI copy live (same
  behavior as the inline switcher) → NOT INDEPENDENTLY TESTED for the
  Settings-screen mount specifically — `LocaleSwitcher` is reused verbatim
  (no re-implementation) and its live-update behavior already has coverage
  elsewhere in the suite (`LocaleSwitcher` is exercised by the existing
  staff i18n tests / inline-switcher tests on the four in-store screens);
  the Settings render test asserts the switcher is present but does not
  drive a language change and assert copy updates. Low risk — this is a
  reuse-not-reimplementation AC and the component itself is unmodified, but
  strictly speaking no test exercises the *live-update* behavior through the
  Settings screen's render tree. Judgment call: not blocking (component is
  reused as-is per the architect's Q4 decision, not new logic), but flagging
  since the AC text explicitly calls out "on Settings."
- AC6: Sign out from Settings performs the identical action as the existing
  in-store sign-out (routes back through RoleRouter to sign-in portal) →
  PASS by code inspection (verbatim-replicated block, per spec design,
  confirmed at `Settings.tsx:76-98` matching `Reorder.tsx:485`'s sequence:
  `unsubscribeFromPush()` → `supabase.auth.signOut()` → `setActiveStore(null)`
  → toast → `setAuthState({kind:'signed-out'})`) — NOT covered by a dedicated
  Settings-screen jest assertion (no test presses `staff-settings-sign-out`
  and asserts the call sequence/`setAuthState` call from *this* screen). The
  four in-store screens already have their own sign-out test coverage for the
  identical block; the Settings copy is byte-identical per code review. Not
  high-risk (no new logic), but a NOT TESTED gap on this specific screen's
  wiring — a typo/paste error in the Settings copy would not be caught by
  jest today.

**Report an issue**
- AC7: Report form has a category picker with exactly Equipment / Inventory /
  App/Tech / Other, plus a free-text message field → PASS —
  `Settings.test.tsx::submits with the active store, selected category, and message`
  exercises the picker; static check confirms
  `CATEGORIES = ['equipment','inventory','app_tech','other']` (exactly 4,
  matching the `staff_reports.category` CHECK and i18n keys in all three
  locales).
- AC8: Submitting with non-empty message persists category, message,
  reporter user_id, store_id, brand_id, server timestamp — server-derived,
  never client-forgeable → PASS —
  `supabase/tests/staff_reports_issue.test.sql` arm (1) (one `staff_reports`
  row with derived brand/store + trimmed message) + arm (3)
  (`reporter_user_id = auth.uid()`, `status` defaults `open`). Client-side:
  `Settings.test.tsx::submits with the active store, selected category, and message`
  confirms only `(storeId, category, message)` are sent — `brand_id`/
  `reporter` are never passed from the client, matching the RPC contract.
- AC9: Submitting emits a new `'issue'`-type notification to the spec-120
  recipient model (brand admin/master + all super-admins) → PASS (write +
  shape) — `staff_reports_issue.test.sql` arm (2) (exactly one `issue`
  notification, `source_id`=report id, `category`+`body` populated,
  `actor_name`=reporter, correct `brand_id`); arms (10)/(11)/(12) confirm
  brand-scoped RLS visibility (brand-A admin sees brand-A, not brand-B;
  super_admin sees both). Recipient FAN-OUT (who actually gets bell+push) is
  NOT independently pgTAP-covered for the `issue` type specifically — the
  `submission-push-fanout` recipient-selection logic (super_admins all-brand +
  admin/master of the notif brand, minus actor) is Deno/edge-function code,
  outside pgTAP's reach, and no shell-smoke test in
  `scripts/smoke-edge.sh`/`smoke-rpc.sh` exercises the `issue` TYPE_LABEL
  branch (the spec itself says "No shell smoke anticipated"). The RLS-based
  bell-visibility proof (arms 10-12) is the strongest available proxy — it
  proves who CAN see the row via the bell's read path — but the push-fanout
  recipient SET construction itself (the `admin/master of brand + all
  super_admins, minus actor` logic added to `submission-push-fanout`) is
  untested end-to-end. This mirrors the existing spec-120/121 pattern (their
  own push-fanout logic is likewise not shell-smoke-tested), so it is not a
  new gap introduced by this spec, but it is a genuine coverage hole for
  "notification lands only in the right brand" beyond the RLS read-path proof.
- AC10: Reported message and category are readable by the recipient in the
  bell (not a placeholder) → PASS —
  `src/components/cmd/NotificationBell.issue.test.tsx::renders the reported message and a category badge`;
  DB-side the message/category are denormalized onto `notifications.body`/
  `notifications.category` and asserted present in arm (2) above.
- AC11 (highest-risk — anti-forgery): a staff user can only file a report for
  their own store/brand; the notification cannot be forged for a brand the
  staff user cannot see (server-side enforced) → PASS —
  `staff_reports_issue.test.sql` arm (4): a store the caller cannot see raises
  `42501` via the `auth_can_see_store` gate, which fires FIRST (before any
  write, confirmed by reading the RPC body: gate → validate → derive → insert).
  Arm (9)/(11) additionally confirm a brand-A admin cannot read a brand-B
  report/notification even if one existed (RLS backstop).
- AC12: Submit gives success feedback and clears/disables the form; a failed
  submit surfaces an error, no silent success → PASS —
  `Settings.test.tsx::clears the message and shows success after a successful submit`
  and `::surfaces an error and does NOT claim success on a rejected submit`;
  `::submit is disabled with an empty message` covers the disable arm.
- AC13: Category labels + report form copy translated in staff catalog
  (en/es/zh); admin bell label for `issue` translated in admin surface →
  PASS — verified directly: `chrome.reportIssue.*` (incl. all 4
  `category.*` keys) present in `src/screens/staff/i18n/{en,es,zh-CN}.json`;
  `chrome.submissionBell.type.issue` + `issueCategory.*` (4 keys) present in
  `src/i18n/{en,es,zh-CN}.json`; `npx jest i18n.test` (24/24 pass, key-parity
  check across catalogs) is green.

**Highest-risk ACs called out in the dispatch prompt — explicit status:**
- (a) anti-forgery store gate → PASS (arm 4, confirmed gate fires before any write).
- (b) staff cannot read `staff_reports` → PASS (arm 8: same-brand `user`
  role sees ZERO rows; the RLS policy's `auth_is_privileged()` conjunct is
  the load-bearing gate and is exercised, not just asserted in a comment).
- (c) notification lands only in the right brand → PASS for the DB-side/bell
  read-path (arms 10/11/12); NOT TESTED for the edge-function push-fanout
  recipient-set construction specifically (see AC9 note) — same posture as
  the existing spec-120/121 fanout logic, not a new gap, but noted per the
  dispatch instruction to be explicit.

### Test run

**pgTAP** — `bash scripts/test-db.sh` (full suite, after `supabase db reset`
to apply migrations through `20260720000000_staff_reports_issue_notifications.sql`
cleanly — see Notes):
```
72/72 DB test file(s) passed
```
Targeted file: `supabase/tests/staff_reports_issue.test.sql` — 12/12
assertions pass (arms 1-12 all green, matching the file's own header count).

**jest** — `npx jest Settings SettingsGear NotificationBell.issue reports`:
```
Test Suites: 3 passed, 3 total
Tests:       8 passed, 8 total
```
- `Settings.test.tsx` (5): renders controls; empty-message disabled submit;
  submit sends `(storeId, category, message)`; success clears form; error
  surfaces without claiming success.
- `SettingsGear.test.tsx` (2): navigates to Settings; accessibility label.
- `NotificationBell.issue.test.tsx` (1): renders message + category badge.

**i18n parity** — `npx jest i18n.test`: 2 suites / 24 tests pass.

**Full jest** — `npx jest`: 112 suites / 1229 tests pass (matches the
developer's reported count in "## Files changed").

**Typechecks** — `npx tsc --noEmit`: clean. `npm run typecheck:test`: clean.

### Notes

- **Local DB drift required a full reset.** Before running pgTAP, the local
  Postgres container was 5 migrations behind
  (`20260716000000`-`20260720000000` unrecorded in
  `supabase_migrations.schema_migrations`), and a partial prior application
  of `20260720000000` had already created `staff_reports` / the new
  `notifications` columns without recording the migration — `supabase
  migration up --include-all` then failed on `create policy
  "privileged_brand_read_staff_reports"` (not idempotent; no `drop policy if
  exists` guard, unlike the table/column/index statements in the same file
  which all use `if not exists`). Resolved via `supabase db reset` (fresh
  apply of all 66 migrations + seed from scratch), which is exactly what CI
  does, so this is not itself a test gap — but it IS a real migration
  robustness note: if `20260720000000` is ever re-run against a database
  where the table exists but the policy doesn't (a plausible partial-failure
  recovery scenario), the file has no re-run safety on the `create policy`
  statement. Not spec-126-scope for this reviewer to fix (backend-developer /
  code-reviewer territory), surfacing here because it blocked the pgTAP run
  until reset.
- **Realtime**: confirmed via `pg_publication_tables` that
  `public.notifications` is already in `supabase_realtime` post-reset with no
  new table added — matches the spec's claim that no
  `docker restart supabase_realtime_imr-inventory` is needed for this
  migration.
- **Framework**: all new tests land in the existing jest / pgTAP tracks
  (spec 022). No new framework introduced. No shell-smoke test was added for
  the `submission-push-fanout` `issue` branch — the spec itself says "No
  shell smoke anticipated," and this matches the existing spec-120/121
  precedent of not smoke-testing the fanout recipient logic. Flagged above
  (AC9 / highest-risk item c) as the one genuine coverage hole, but it is
  pre-existing project posture, not something this spec regressed.
- **Two AC items (AC5, AC6) are PASS-by-code-inspection / reuse rather than a
  dedicated jest assertion exercising them through the Settings screen
  specifically.** Both are low-risk: AC5's `LocaleSwitcher` is mounted
  unmodified (already covered elsewhere in the suite for its own live-update
  behavior), and AC6's sign-out block is a byte-identical replica of
  already-tested code (per code-reviewer's craft note, which also flagged the
  five-way duplication as backlog). Not blocking, but noted per "every
  acceptance criterion maps to at least one test" — these two map to
  *indirect* coverage rather than a direct one.
- No mocked-DB tests were used; pgTAP hit the real local Postgres container.
  `app.json` slug untouched.

### Verdict

No high-risk AC is uncovered to a degree that warrants a BLOCK. All three
highest-risk items named in the dispatch (anti-forgery gate, staff read
denial, brand-scoped notification) have direct, passing pgTAP coverage for
the DB write/RLS layer, which is the layer where the actual security
guarantee lives (PostgREST/RPC + RLS, not the edge-function fanout). The one
real gap (edge-function recipient-set construction for `issue`) is
pre-existing project posture inherited from spec 120/121, not a new
regression, and is not on the dispatch's highest-risk list. AC5/AC6 are
minor indirect-coverage notes, not failures.
