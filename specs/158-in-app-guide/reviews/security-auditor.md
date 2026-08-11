# Security audit for spec 158 — In-app Guide

Reviewed: the staged spec-158 portion of the working tree (`git diff --cached`),
scoped per the dispatch note. **Out of scope / not re-audited** (pre-existing
spec-157 work, already audited): `supabase/migrations/20260809000000_super_admin_policy_parity.sql`,
`supabase/tests/super_admin_policy_parity.test.sql`, `src/screens/DBInspectorScreen.tsx`,
`src/screens/__tests__/DBInspectorScreen.test.tsx`, `specs/157-*`. Attribution verified,
not assumed: the migration header reads `Spec 157 — super_admin parity…`
(`supabase/migrations/20260809000000_super_admin_policy_parity.sql:2`), the DBInspector
diff is annotated `Spec 157` (`src/screens/DBInspectorScreen.tsx` diff hunks, lines 13/24/61
of the added block), and neither file mentions 158.

**Verdict: no Critical, no High, no Medium. Nothing blocks merge.**

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/components/cmd/GuideSheet.tsx:58` — the `?` sheet re-seeds via
  `findGuideTopic('admin', topicId)`, which does **not** apply the role gate, while the
  sheet's *index* view (line 46) correctly uses `visibleGuideTopics('admin', {isMaster,
  isSuperAdmin})`. A caller who could drive the shell's `section` state to `'Users'` or
  `'Brands'` as a non-master would see that topic's body. **Practically unreachable:**
  `section` is fed only by the role-filtered sidebar (`src/lib/cmdSelectors.ts:1166-1183`,
  Admin/Tenancy groups are gated on `isMaster` / `isSuperAdmin`), by
  `applySidebarOverride`, which walks only the *default* groups and therefore cannot
  resurrect a gated id for a demoted user (`src/lib/sidebarLayout.ts:163-173`), and by the
  ⌘K palette, whose `SCREEN_ENTRIES_DEFS` contains neither `Users` nor `Brands`
  (`src/lib/cmdSelectors.ts:164-190`). Impact if it ever were reachable is three lines of
  static English prose that say user management and brands exist — the same information
  the sidebar labels carry — with no data and no action behind it. *Optional
  defense-in-depth fix:* seed from `visibleGuideTopics(...).find(t => t.id === topicId) ?? null`
  so the sheet and the index share one gate.
- `src/lib/guide.ts:269-290` / `src/screens/staff/i18n/en.json:502-510` —
  `GUIDE_CHROME_KEYS` is one flat set shared by both surfaces, so the staff catalogs ship
  admin-oriented **group labels** (`guide.groups.admin` = "Admin", `guide.groups.tenancy`
  = "Brands", plus `insights` / `planning` / `tenancy`). These are chrome, not topic
  strings, so AC-15's literal wording ("no admin topic id, title, purpose or action
  string") is not violated, and no staff view renders group labels at all
  (`src/screens/staff/screens/Guide.tsx` renders title / purpose / actions only). Zero
  information value beyond the words "Admin" and "Brands". Noted only so a future reader
  does not mistake it for a leak; no change requested.

### Findings against the five central questions

**1 — §12 zero-backend bright line: CONFIRMED CLEAN.**
No file attributable to spec 158 touches `supabase/**`, `supabase/config.toml`,
`src/lib/db.ts`, `src/store/useStore.ts`, or `src/screens/staff/store/useStaffStore.ts`.
Grep across the full spec-158 file set (`src/lib/guide.ts`, `src/lib/adminSections.ts`,
`GuideSheet.tsx`, `GuideTopicBody.tsx`, `GuideSection.tsx`, staff `Guide.tsx`,
`HelpButton.tsx`) for `supabase` / `fetch(` / `functions.invoke` / `callEdgeFunction` /
`process.env` / `EXPO_PUBLIC` / `localStorage` / `AsyncStorage` returns **zero hits** —
the feature issues no network request and reads no persisted state. `auth_can_see_store`
appears in zero spec-158 files (only in pre-existing `db.ts`, `userPermissions.ts`,
`UsersSection.tsx` and the staff `lib/` fetchers). No `package.json`, `package-lock`,
`app.json`, `vercel.json`, `eas.json`, `jest.config.js`, `sidebarLayout.ts` or `CLAUDE.md`
change is staged. There is no new table, RPC, edge function, `verify_jwt` entry, realtime
publication change, or role gate on the server side to audit — correctly, since none was
designed.

**2 — AC-15 staff/admin separation: STRUCTURAL, not a bypassable runtime filter.**
Three independent mechanisms, all verified:
- Separate arrays in the model: `STAFF_TOPICS` (`src/lib/guide.ts:177-198`) is a distinct
  literal from `ADMIN_SECTION_TOPICS` (`src/lib/guide.ts:82-151`); `guideTopics()` branches
  on the audience (`src/lib/guide.ts:204-210`) and never merges them.
- Separate catalogs: the staff catalogs contain exactly the 5 staff `topics.*` subtrees
  (verified directly against all three staff locale files — no `users` / `brands` /
  `reconciliation` / `dbInspector` / etc. subtree in any of them), so even if an admin
  topic object reached a staff view it would render dot-paths, not admin copy.
- Literal audience at every staff call site: `guideTopics('staff')`
  (`src/screens/staff/screens/Guide.tsx:41`) and `findGuideTopic('staff', route.params?.topicId)`
  (`src/screens/staff/screens/Guide.tsx:43`). The **audience is never derived from the
  route param, a prop, or a variable** — the caller-controlled input is only the
  `topicId`, which is looked up, never rendered raw. Unknown ids return `null`
  (`src/lib/guide.ts:217-226`) and the screen falls back to the index
  (`src/screens/staff/screens/Guide.tsx:50, 78`), so a crafted `topicId` deep link cannot
  throw, cannot render attacker text, and cannot select an admin topic.
- Enforcement is pinned in CI, not just by convention: `src/lib/guide.i18n.test.ts:110-211`
  asserts the staff catalogs contain exactly the 5 staff subtrees, that no admin topic key
  resolves in a staff catalog, that no admin purpose paragraph appears verbatim in a staff
  catalog, that no non-test file under `src/screens/staff/` contains
  `ADMIN_SECTION_TOPICS` / `ADMIN_STANDALONE_TOPICS` / `adminSections`, and that every
  staff call site passes the literal `'staff'`. I ran these suites plus the nav-parity
  suite: 3 suites / 54 tests, all green.
- Shared-model leak check: the only thing the shared pure model puts on the staff path is
  admin topic **ids and catalog key paths** (`'Users'`, `'topics.users'`) — no admin
  prose. `adminSections.ts` is imported `import type` only (`src/lib/guide.ts:31`), so it
  is erased at runtime. (For completeness: admin and staff already ship in one JS bundle
  via `RoleRouter`, so bundle-level separation was never the property being claimed — view
  reachability is, and it holds.)

**3 — spec-063 isolation: CLEAN.** Grep across `src/screens/staff/screens/Guide.tsx`,
`components/HelpButton.tsx`, `navigation/StaffStack.tsx`, `screens/Settings.tsx`,
`screens/StorePicker.tsx` for `components/cmd`, `screens/cmd`, `useStore`, `src/i18n`,
`adminSections`, `ADMIN_SECTION` returns no import hits (the single textual match is a
comment in `Settings.tsx:35` restating the contract). Both new staff files use only
staff-local theme (`useStaffColors` / `useStaffTokens`), the staff catalog (`useI18n`), and
the shared **pure** `src/lib/guide.ts` — the same footing as `src/lib/installGuide.ts`.
Neither reads `useStaffStore`, which is what makes the dual-branch `Guide` registration in
`StaffStack.tsx:201, 212-218` (including the pre-store `StorePicker` branch) safe: the
screen exposes nothing store-scoped to a user who has not yet selected a store.

**4 — Content review: no secrets, PII, URLs, or interpolation surface.** Scanned all six
catalogs' `guide` subtrees for URLs, email addresses, phone numbers, `supabase`, `key`,
`token`, and `{var}` placeholders. Only hit is the literal label "Key actions". No store
names, vendor names, staff names, internal hostnames, table names beyond generic English
("the raw database tables"), and — per the architect's OQ-4 constraint — **no `{var}`
placeholders anywhere**, so the `t()` substitution path stays unexercised and a future
translator cannot break interpolation or inject a format string. No `console.*` calls and
no `notifyBackendError` payloads in any new file.

**5 — New optional props / testIDs expose nothing privileged.** `TitleBar.onHelpPress`
(`src/components/cmd/TitleBar.tsx:24, 241-263`) and `MobileTopAppBar.onTitlePress` /
`titlePressLabel` (`src/components/cmd/MobileTopAppBar.tsx:27-42, 113-149`) are optional
and render nothing when absent, so no existing caller gains a control. Both handlers, plus
the sidebar item and the staff `HelpButton`, lead only to read-only documentation views:
`GuideTopicBody` (`src/components/cmd/GuideTopicBody.tsx`) does no store read, no
navigation and no mutation; `GuideSection` (`src/screens/cmd/sections/GuideSection.tsx`)
renders text and cannot navigate the user *into* a gated section (index rows call
`setSelectedId` / `drill.open`, never `setSection`); the staff Guide screen only calls
`navigation.goBack()`. `openGuideSheet` (`src/screens/cmd/ResponsiveCmdShell.tsx:311-315`)
closes the phone drawer in the same handler before opening the sheet and never mutates
`section`. The role filter itself is presentation parity with the nav, exactly as the
architect states (spec §2 / R-12) — the enforcing gates remain `auth_is_privileged()` /
`auth_can_see_store()` server-side, and this diff does not touch, weaken, or depend on
them.

Also checked and clean: the three modified existing test files
(`ResponsiveCmdShell.spec153.test.tsx`, `Settings.test.tsx`, `StorePicker.test.tsx`,
`MobileTopAppBar.test.tsx`) add stubs and new blocks only — no security-relevant pin
(spec-152 sign-out ordering, spec-153 install entry) was loosened, and the added `useRole`
stubs return `false` for both `useIsMaster` and `useIsSuperAdmin` rather than widening a
role in tests.

### Dependencies

`package.json` is unchanged (not in the staged diff; AC-17 holds) and no new import of a
third-party module appears in any spec-158 file beyond `@expo/vector-icons` and
`@react-navigation/native`, both already dependencies. **`npm audit` skipped — no
`package.json` change.**
