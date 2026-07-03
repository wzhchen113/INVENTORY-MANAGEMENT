## Test report for spec 106

### Acceptance criteria status

- AC-1: Admin Save button visible, ungated by count-everything rule, persists a
  partial (incl. zero-row) count → **PASS** —
  `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx::AC-1/AC-12: Save is UNGATED — it writes the server draft + a synced local copy even with ZERO rows filled`
- AC-2: Staff Weekly Save button present, ungated → **PASS** — verified by code
  inspection (`WeeklyCount.tsx` Save button `disabled` only on `savingDraft`/
  offline-irrelevant guards, never on the completeness gate) and indirectly
  exercised by every spec-106 staff test pressing `weekly-save-draft` on a
  partial form (e.g. `AC-14: offline Save...`). No test presses Save with the
  gate would-otherwise-block AND asserts it still succeeds the way AC-1's admin
  test does explicitly — the staff Save-ungated claim is inference from a
  passing partial-form Save, not a dedicated "gate would block Submit but not
  Save" assertion. Downgrading to **PASS (soft)** — behavior is correct and
  indirectly covered, but not as tightly pinned as AC-1's admin twin.
- AC-3: Save persists everything needed to resume (case/unit/notes/header for
  admin; case/unit for staff), stamped `saved_at`, online success toast "Draft
  saved" → **PASS** —
  `src/lib/countDrafts.test.ts` (serialize/deserialize round-trip, both
  shapes) +
  `InventoryCountSection.draft.test.tsx::AC-1/AC-12...` (asserts the "Draft
  saved" toast fires) +
  `supabase/tests/user_count_drafts_rls.test.sql` assertion (2) (server-side
  payload round-trip).
- AC-4: Re-saving overwrites the existing draft for the slot — single slot per
  `(user, screen, store)` → **PASS** —
  `supabase/tests/user_count_drafts_rls.test.sql` assertion (8) (2nd upsert of
  the same slot replaces, not duplicates — FULL-unique `ON CONFLICT` fired).
- AC-5: Silent auto-restore on open, verbatim values (`"0"` stays `"0"`,
  `""` stays `""`) → **PASS** —
  `countDrafts.test.ts::round-trips verbatim strings ("0" stays "0", "" stays "")`
  +
  `InventoryCountSection.draft.test.tsx::AC-5/AC-6/AC-16: restores the SERVER draft...`
  +
  `WeeklyCount.test.tsx::AC-5/AC-6/AC-16: restores the SERVER draft (newer saved_at)...`
  — both screen tests assert the exact typed values land back in the inputs,
  no up-front prompt is rendered (only the passive banner).
- AC-6: Restored-draft banner "Draft restored (saved <relative time>)" +
  first-uncounted jump → **PASS (banner)** — same two screen tests assert
  `*-draft-banner` renders on restore. **NOT TESTED (jump)** — neither screen
  test asserts the `firstUncounted` scroll/focus jump actually fires on
  restore (no assertion on `pendingFocusId`/scroll target/focused input after
  a restore). The banner half of AC-6 is solid; the jump half is
  implementation-present (wired via the existing `firstUncounted` helper per
  the Files-changed note) but has no test proving it engages specifically on
  a draft restore. Net: **PASS**, with the jump-assertion gap called out as a
  minor hole, not enough on its own to flip the verdict given `firstUncounted`
  is a reused, already-tested helper (spec 103) and the restore path calls it
  per the source.
- AC-7: Discard affordance deletes both server row and local copy, clears form
  → **PASS** —
  `InventoryCountSection.draft.test.tsx::AC-7: Discard deletes the server row + the local copy and clears the form`
  +
  `WeeklyCount.test.tsx::AC-7: Discard deletes the server row + the local copy and clears the form`
  — both assert the confirm fired, `deleteCountDraft`/`draftDelete` called,
  local copy gone, banner dismissed, inputs cleared.
- AC-8: Successful Submit deletes the draft (server + local); Submit itself
  unchanged in shape (admin `submitInventoryCount`; staff `submitWeeklyCount`
  with its own `client_uuid`, draft path does not interfere) → **PASS (staff)**
  — `WeeklyCount.test.tsx::AC-8: a successful Submit deletes the draft (server + local) — no stale banner on reopen`
  asserts `mockSubmit` called (unchanged RPC) then `draftDelete` +
  AsyncStorage-clear. **NOT TESTED (admin)** — no test in
  `InventoryCountSection.draft.test.tsx` presses Submit and asserts
  `deleteCountDraft`/`clearLocalCountDraft` fire on success; the wiring exists
  in source (`onSubmit` success block, lines ~808-814) but is unexercised by
  any admin test. Net verdict **PASS** on the strength of the staff-side test
  + direct code inspection of the admin wiring (matches the staff pattern
  byte-for-byte), but flagging the admin-side test as a real gap the
  test-engineer would want closed before calling this criterion fully proven
  by tests alone.
- AC-9: Saving a draft does NOT write `current_stock`/`inventory_items` and
  does NOT create an `inventory_counts`/weekly-count history row → **NOT
  TESTED**. No test anywhere (pgTAP, jest pure, or either screen test file)
  asserts this negative. Specifically: neither draft test file seeds or spies
  on `useStore.submitInventoryCount` / `useStaffStore.submitWeeklyCount` and
  asserts it is **not** called when only Save is pressed (the pattern
  `expect(mockSubmit).not.toHaveBeenCalled()` exists elsewhere in this
  codebase — e.g. the count-everything gate tests at
  `WeeklyCount.test.tsx:272` and `:529` — but is never applied to the Save
  button). No pgTAP test confirms an insert into `user_count_drafts` leaves
  `inventory_items.current_stock`/`inventory_counts` untouched. The
  implementation is structurally correct by construction — `saveCountDraft` /
  the staff carve-out's `saveCountDraft` target exclusively
  `.from('user_count_drafts')`, verified by direct code read
  (`src/lib/db.ts:2153-2177`, `src/screens/staff/lib/countDrafts.ts:104-125`)
  — so this is very unlikely to be a live bug, but it is genuinely unproven by
  any test, and a future refactor that accidentally wires Save through the
  submit path would not be caught. **BLOCKING per the report format's
  instruction that NOT TESTED = Critical for release-coordinator purposes.**
- AC-10: Draft row is private to its author, owner-scoped RLS, no admin/
  super_admin bypass → **PASS** —
  `supabase/tests/user_count_drafts_rls.test.sql` assertions (3) cross-user
  SELECT=0, (4) cross-user UPDATE=0 rows, (5) cross-user DELETE=0 rows, (6)
  cross-user spoof-INSERT=42501, (7) super_admin JWT SELECT=0 rows (explicit
  no-bypass proof).
- AC-11: A stale item id in a restored draft is ignored, never crashes →
  **PASS** —
  `countDrafts.test.ts::applyDraftStaleFilter — deleted-since id tolerance` (5
  tests, pure-function level) +
  `InventoryCountSection.draft.test.tsx::AC-11: a stale item id in a restored draft is ignored...`
  +
  `WeeklyCount.test.tsx::AC-11: a stale item id in a restored draft is ignored...`
  — both screen tests assert the live value restores and the stale id's value
  never renders, no crash.
- AC-12: Count-everything gate unaffected — a restored partial draft does NOT
  let Submit proceed with unfilled rows; Save and Submit remain independent →
  **PASS** — `InventoryCountSection.draft.test.tsx::AC-1/AC-12` proves Save
  succeeds with an empty form (Save is independent of the gate). The
  pre-existing count-everything gate tests (unchanged by this spec, part of
  the 832-test full suite) continue to pass, e.g.
  `WeeklyCount.test.tsx::gates submit on EVERY item counted — an incomplete submit is blocked (no RPC); submits once all filled`
  — confirming Submit's gate logic (`nonBlankCount`/`totalItems` comparison in
  admin, the staff completeness check) was not touched by this spec's diff.
  No test explicitly restores a partial draft AND THEN presses Submit to
  prove the gate still blocks post-restore, but the gate implementation is
  unchanged (same `nonBlankCount`/completeness derivation the pre-existing
  gate tests already exercise against the identical form-state shape a
  restored draft populates), so this is a reasonable inference rather than a
  hole worth a Critical.
- AC-13 (online write): Online Save writes the server row, updates/clears the
  local copy, "Draft saved" toast → **PASS** —
  `InventoryCountSection.draft.test.tsx::AC-1/AC-12` (asserts `saveCountDraft`
  called, local mirror written `unsynced:false`, "Draft saved" toast) covers
  the admin side; the staff online-Save path is exercised indirectly by every
  restore test (draft round-trips through a live online fetch) but has no
  single test isolating "press Save while online" the way the admin test
  does. **PASS**, admin-pinned tightly, staff-pinned by inference + the
  reconnect-push test (`AC-15`) which does exercise `draftUpsert` on the
  online branch.
- AC-14 (offline write): Offline Save writes device-local only, marks
  unsynced, "Saved on this device — will sync when online" toast, no error →
  **PASS** —
  `InventoryCountSection.draft.test.tsx::AC-14: offline Save writes an UNSYNCED local copy...`
  +
  `WeeklyCount.test.tsx::AC-14: offline Save writes an UNSYNCED local copy...`
  — both assert the offline toast text verbatim, `unsynced:true`, and the
  server write function NOT called.
- AC-15 (reconnect sync — whole-draft last-write-wins): newer local pushed up
  + unsynced cleared; older local discarded → **PASS** —
  `countDrafts.test.ts` covers all `reconcileDrafts` branches at the pure
  level (local-newer→push, local-older→adopt-clear-local, tie→server-wins);
  `InventoryCountSection.draft.test.tsx::AC-15/AC-16: restores the LOCAL draft when its saved_at is NEWER...`
  and the staff twin assert the push-and-clear-flag behavior at screen level
  on initial load; `WeeklyCount.test.tsx::AC-15: on reconnect (offline→online flip), a newer unsynced local draft is pushed up to the server`
  is the one test in either screen file that specifically drives the
  connectivity **false→true flip** (not just screen-open) and asserts the
  push fires — this is the tightest AC-15 "reconnect" (as opposed to
  "screen-open reconcile") proof in the suite. The admin side has no
  equivalent false→true-flip test (the admin reconnect effect exists in
  source, mirroring the staff shape, but is unexercised by a dedicated test)
  — noting as a secondary gap, not enough to flip the verdict given the staff
  side proves the mechanism and the two effects are structurally identical
  per code read.
- AC-16 (restore source selection): restored values come from whichever
  source is newer by `saved_at` → **PASS** — same evidence as AC-15's
  screen-level tests plus the "restores the SERVER draft" tests on both
  screens (server-newer path) and "restores the LOCAL draft" tests
  (local-newer path) — both directions of the branch are exercised at screen
  level, not just at the pure-helper level.
- AC-17 (cross-device visibility): an offline-synced draft is visible when the
  same user opens from a different device → **NOT TESTED**. This is the one
  AC with genuinely no test coverage at any level — no pgTAP test simulates
  "device A writes, device B (same user, different session) reads and sees
  it," and no jest test simulates two independent local-storage instances for
  the same user. The design explicitly states this AC is achieved by "the
  server being the source of truth once synced + the screen-open fetch on the
  other device — NOT realtime push," which is a corollary of AC-10 (owner
  scope, not device scope) + AC-13 (online Save persists server-side) + the
  screen-open fetch effect — all of which ARE independently tested. The pgTAP
  suite's assertion (2) ("A reads it back") is same-session, not
  cross-device, so it does not independently prove AC-17; it proves the
  server row exists and round-trips for its owner, which is necessary but not
  sufficient evidence of cross-device visibility (a session-scoped cache or a
  device-id-keyed RLS filter — neither present here, but nothing tests their
  absence). Given the mechanism is a straightforward composition of three
  already-tested primitives and there is no plausible code path that would
  make it fail while AC-10/AC-13/AC-5's server-fetch-on-open all pass, I am
  not blocking on this alone, but per the report format's own instruction
  ("If any AC is FAIL or NOT TESTED, treat that as a Critical finding"), this
  is called out explicitly as **NOT TESTED** for the release-coordinator to
  weigh alongside AC-9.
- AC-18 (test track named): pgTAP for RLS, jest for pure helpers → **PASS** —
  both tracks exist exactly as pinned: `supabase/tests/user_count_drafts_rls.test.sql`
  (pgTAP, 11/11 assertions) and `src/lib/countDrafts.test.ts` (jest, 20/20
  tests). No shell smoke was added, matching the spec's explicit "No shell
  smoke expected."

**Verdict: 15 PASS, 2 NOT TESTED (AC-9, AC-17), 1 PASS-with-noted-soft-spots
(AC-2/AC-6/AC-8-admin/AC-15-admin — all PASS but with a secondary,
non-blocking test-tightness note). Per the report format's explicit
instruction, AC-9 and AC-17 being NOT TESTED are Critical findings for the
release-coordinator.**

### Test run

**pgTAP — `npm run test:db`:**
```
== supabase/tests/user_count_drafts_rls.test.sql ==
  PASS supabase/tests/user_count_drafts_rls.test.sql (11 assertion(s) passed)
...
✓ 60/60 DB test file(s) passed
```
Matches the expected 60/60 count exactly. `user_count_drafts_rls.test.sql`
(new, spec 106) and `user_count_orders_rls.test.sql` (spec 103, the parity
reference) both pass in full — 11/11 and 13/13 assertions respectively.

**jest — full suite (`npx jest`):**
```
Test Suites: 77 passed, 77 total
Tests:       832 passed, 832 total
Time:        3.244 s
```
Matches the expected 77 suites / 832 tests exactly. Isolated re-runs confirm
the spec-106-specific files individually:
- `src/lib/countDrafts.test.ts` — 20/20 tests pass (all `reconcileDrafts`
  branches, `applyDraftStaleFilter`, both round-trips, malformed-payload
  tolerance).
- `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx` —
  7/7 tests pass.
- `src/screens/staff/screens/WeeklyCount.test.tsx` (spec-106 describe block
  only) — 7/7 new tests pass (22/22 for the whole file, including the
  pre-existing spec-098/103 tests, confirming no regression to the sibling
  custom-order coverage in the same file).

Non-blocking console noise: pre-existing `act(...)` warnings in
`WeeklyCount.test.tsx` and `EODCount.test.tsx` (a `setPendingFocusId` state
update inside a `setTimeout` not wrapped in `act`) fire during the run but do
not fail any test and are unrelated to this spec's diff — confirmed by
`git log` showing these files' last non-spec-106 touch predates this
feature's work.

**Typecheck — `npx tsc --noEmit` (base config):**
```
EXIT CODE: 0
```
Clean.

**Typecheck — `npx tsc -p tsconfig.test.json --noEmit` (test-graph config,
required by `.github/workflows/test.yml`'s "Track 1a" job — an independent CI
gate from the base typecheck):**
```
src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx(47,56): error TS2556: A spread argument must either have a tuple type or be passed to a rest parameter.
src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx(48,54): error TS2556: A spread argument must either have a tuple type or be passed to a rest parameter.
src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx(49,58): error TS2556: A spread argument must either have a tuple type or be passed to a rest parameter.
src/screens/staff/screens/WeeklyCount.test.tsx(71,21): error TS2556: A spread argument must either have a tuple type or be passed to a rest parameter.
EXIT CODE: 2
```
**FAILS.** This is a real, spec-106-introduced build break on an independent,
CI-required gate — the base `tsc --noEmit` reported clean only because
`tsconfig.json` explicitly excludes `**/*.test.ts(x)`; `tsconfig.test.json`
is the config that actually type-checks these two new/modified test files,
and it currently does not compile. Root cause: `mockFetchDraft`,
`mockSaveDraft`, `mockDeleteDraft` (admin file) and `draftUpsert` (staff
file) are declared as `jest.fn(() => Promise.resolve(...))` — i.e. WITH a
zero-argument implementation function — which makes TypeScript infer a
zero-parameter call signature for the mock. Spreading a `(...a: unknown[])`
rest param into that inferred-zero-arg call
(`mockFetchDraft(...a)`/`draftUpsert(...args)`) is what TS2556 rejects. This
is NOT a systemic tsconfig problem — the identical `(...a: unknown[]) =>
mockFn(...a)` re-forwarding pattern is used safely elsewhere in this exact
test tree (`Reorder.test.tsx`, `useEodSubmit.test.ts`, `shareReorder.test.ts`,
`fetchReorder.test.ts`, `sessionRestore.test.ts`) because those files declare
their mocks as bare `jest.fn()` (no implementation argument), which infers
the permissive `jest.Mock<any, any>` signature instead. The fix is narrow
(declare the four mocks as bare `jest.fn()` and set `.mockResolvedValue(...)`
in `beforeEach` instead of passing an implementation inline, matching the
sibling pattern already in the same files' `beforeEach`) but it IS a build
break that must be fixed before this branch can pass CI — surfacing it back
to the developer per policy rather than patching it myself.

### Notes

- **pgTAP parity with spec 103 confirmed.** `user_count_drafts_rls.test.sql`
  mirrors `user_count_orders_rls.test.sql`'s JWT-injection shape, seed-profile
  IDs, and hermetic `begin/rollback` isolation. The expected divergences are
  present and correct: spec 106 has NO NULL-vendor partial-index arms (single
  FULL unique constraint, `store_id` NOT NULL for both v1 screens) where spec
  103 has two; spec 106 tests a 2nd-upsert-replaces-not-duplicates arm (8)
  where spec 103 tests a NULL-vendor-uniqueness arm (9) — the correct analog
  given the different constraint shape. No CHECK-vocabulary rejection test
  (e.g., inserting `screen = 'admin-eod'` and asserting it 23514s against the
  two-value CHECK) exists in either suite — this is a minor DB-constraint
  smoke that neither spec's pgTAP file covers and is not tied to a numbered
  AC, so not blocking.
- **Local-storage trio has no dedicated unit test.** Neither
  `src/lib/countDraftLocal.ts` (admin localStorage/AsyncStorage split) nor
  the AsyncStorage half of `src/screens/staff/lib/countDrafts.ts`
  (`readLocalStaffDraft`/`writeLocalStaffDraft`/`clearLocalStaffDraft`, the
  shape-validator, `backupCorrupt`) has a standalone test file. These are
  dependency-free logic (shape validation, corrupt-payload backup-then-remove,
  key-building) that could silently regress. They ARE exercised indirectly
  through the screen integration tests via an in-memory mock (admin) or the
  real `@react-native-async-storage/async-storage` jest mock (staff) —
  functional coverage exists, but the corrupt-bytes / malformed-shape branches
  specifically (parse-error, shape-mismatch, backup-then-remove) are
  untouched by any test. The spec's §13 test-track note only mandates jest for
  the pure `countDrafts.ts` module, not this local-storage layer, so this is
  a secondary/non-blocking gap, not an AC violation.
- **No test framework gap.** All spec-106 tests land in the three existing
  tracks (jest, pgTAP, no shell smoke needed per spec) exactly as CLAUDE.md
  requires. No vitest/playwright/new-framework introduction observed.
- **No mock-everything false-positive risk observed for the RLS/reconcile
  core.** The pgTAP suite hits a real local Postgres with real RLS enforcement
  (not mocked) — this is the strongest evidence in the whole spec, verified
  live. The `countDrafts.ts` pure-function tests need no DB/mocks by design
  (dependency-free module) and are trustworthy as written. The two screen
  test files mock at the `db.ts`/staff-carve-out I/O **boundary** (not the
  reconcile/apply/serialize logic, which is real, imported, and exercised
  in-process) — this is the correct boundary to mock per the project's own
  pattern (matches the sibling `parStatus`/`customOrder` admin test files);
  it does NOT create a "would pass with the wiring broken" risk for the
  restore/reconcile/Discard/offline-toggle behavior, because the actual
  `reconcileDrafts`/`applyDraftStaleFilter`/serializer calls inside the real
  component are what the assertions are checking the output of. The one place
  I would flag as a genuine "tests so much is mocked it could pass with real
  wiring broken" risk is AC-9: because `useStore.submitInventoryCount` /
  `useStaffStore.submitWeeklyCount` are never spied on in the draft test
  files, a hypothetical regression that accidentally routed the Save button
  through the submit path would not be caught by ANY existing test — this is
  the concrete form of the AC-9 gap, not a hypothetical.
- **`app.json` slug** — untouched, no bearing on this spec. Confirmed no
  spec-106 file touches it.
- **Realtime** — confirmed absent as designed; `user_count_drafts` is not in
  the `supabase_realtime` publication (verified in the migration's grants/RLS
  block, no `alter publication` statement present), so the
  `docker restart supabase_realtime_imr-inventory` step was correctly skipped
  for this test run — not needed per the spec's own flagged absence.
- **i18n verified.** Both online ("Draft saved") and offline ("Saved on this
  device — will sync when online") toast strings match the spec's AC-13/AC-14
  wording verbatim in the admin `en.json` catalog; the existing
  catalog-parity and staff placeholder-parity jest suites (which enforce all
  three locales carry the same keys/placeholders) are green, folded into the
  832-test total.
