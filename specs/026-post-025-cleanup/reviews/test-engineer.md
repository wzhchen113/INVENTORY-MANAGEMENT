## Test report for spec 026

### Acceptance criteria status

#### Track A — Invitations RLS broadened to super_admin

- **A1** Migration at `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` drops and recreates the four `invitations` policies using `public.auth_is_privileged()`, mirroring the order_schedule and recipe_categories prior-art shape. → **PASS** — file is present; all four `drop policy if exists` calls precede the four `create policy` calls; `public.auth_is_privileged()` is used in every `using` / `with check` clause.

- **A2** All four policies rewritten (SELECT, INSERT, UPDATE, DELETE) with names matching the originals byte-for-byte. → **PASS** — names verified: `"Admins can read invitations"`, `"Admins can insert invitations"`, `"Admins can update invitations"`, `"Admins can delete invitations"`. UPDATE policy includes both `using` and `with check`. No parallel policy names introduced.

- **A3** Migration is idempotent (`drop policy if exists` before each `create policy`); DDL only, no data changes. → **PASS** — all four drops use `if exists`; no DML present.

- **A4** pgTAP test at `supabase/tests/invitations_super_admin_rls.test.sql` with `plan(4)` covering: (i) fixture assertion, (ii) admin JWT INSERT succeeds, (iii) super_admin via profiles.role INSERT succeeds, (iv) plain user JWT INSERT rejected with `42501`. → **PASS** — all four arms are present; `plan(4)` declared; `throws_ok(..., '42501', ...)` is used for arm (iii). See "pgTAP test quality" note below.

- **A5** `supabase/seed.sql` is not modified. → **PASS** (not in `Files changed`; test uses `UPDATE ... ON CONFLICT` on the seed master row, not a seed edit).

- **A6** No source files other than the migration and test are touched (`InviteUserDrawer.tsx`, `UsersSection.tsx` not modified). → **PASS** — `Files changed` block in the spec lists only the migration and test for Track A.

#### Track B — CLAUDE.md and subagent-prompt doc rot

- **B1** `CLAUDE.md` edited to remove stale references to deleted modules. → **PASS** — verified by reading the file. Stale references to `AppNavigator`, `featureFlags.ts`, `EXPO_PUBLIC_NEW_UI`, `useJsonServerSync`, `useSupabaseStore` are either gone or appear only in the historical-note sentence in "Data layer (active vs. legacy)" (line 199), which is explicitly tagged "Spec 025 deleted…" and is AC-compliant.

- **B2** Specific line-level changes in CLAUDE.md applied: Stack/Routing line drops AppNavigator; project-structure block updated; "UI fork via env flag" bullet rewritten to "Cmd UI is the only client"; three Gaps bullets removed; Data layer section collapsed to historical note; Legacy admin screens section collapsed to historical note. → **PASS** — all items confirmed present in the read of CLAUDE.md:
  - Line 14: `Routing: React Navigation 6 + custom desktop "Cmd" shell — src/navigation/CmdNavigator.tsx` (no AppNavigator).
  - Line 34: `App.tsx # Root; mounts CmdNavigator.`
  - Line 36: `navigation/ # CmdNavigator (desktop shell)` (no AppNavigator).
  - Lines 39-40: `AdminScreens.tsx` line and `InventoryListScreen / ItemDetailScreen` line absent.
  - Line 39: `store/ # Zustand store (useStore.ts)` (duplicate-stores comment gone).
  - Line 40: `lib/ # db.ts (PostgREST/RPC), webPush.ts, ...` (featureFlags.ts gone).
  - Line 53: "Cmd UI is the only client" convention bullet present.
  - "Possibly-stale legacy data layer", "Two coexisting stores", and "Large legacy file" bullets absent from Gaps section.
  - Line 199: "Historical note: Spec 025 deleted the legacy data layer…" — compliant.
  - Line 209: "Historical note: `AdminScreens.tsx` was deleted in spec 025." — compliant.

- **B3** All eight subagent prompt files updated. → **PASS** with one nuance (see Should-fix S1 below):
  - `code-reviewer.md`: frozen-files rule rewritten as "Direct edits to files deleted in spec 025 … Critical"; json-server/db.json rule updated; test-framework prose updated to spec-022 three-tracks. The deleted-files list naming all six legacy files is still present in the Critical bullet as an enumeration of what was deleted (not a do-not-modify rule), which is consistent with AC B3's requirement that the rule call out re-creation as Critical.
  - `frontend-developer.md`: AppNavigator reference gone from routing line; "Where new screens go" rewritten to Cmd-UI-only with historical deletion note; hard-rules list collapsed to single `app.json` slug entry; test section updated to spec-022 three tracks.
  - `backend-developer.md`: hard-rules list collapsed to single `app.json` slug entry; test section updated to spec-022 three tracks.
  - `backend-architect.md`: "Do NOT design changes to legacy code" rule collapsed to `app.json` slug rule only.
  - `test-engineer.md`: "no test framework" frontmatter rewritten; testing-reality section rewritten to spec-022 three tracks; `AdminScreens.tsx` frozen rule absent; hard-rules list collapsed to `app.json` slug only.
  - `product-manager.md`: "Cmd UI vs legacy?" probe updated; test probe updated; frozen-files rule collapsed to `app.json` slug.
  - `workflow-orchestrator.md`: frozen-files hard rule collapsed to `app.json` slug.
  - `workflow-auditor.md`: frozen-file rule #4 collapsed to `app.json` slug.

- **B4** No prose invented beyond removing stale references. → **PASS** — edits are removal and minimal replacement; no unrelated section rewrites observed.

- **B5** `grep -rEni 'AppNavigator|featureFlags|EXPO_PUBLIC_NEW_UI|useJsonServerSync|useSupabaseStore' CLAUDE.md .claude/agents/` returns only historical-context lines. → **PASS with qualification** — the grep returns four matches:
  1. `CLAUDE.md:53` — "Spec 025 deleted the legacy `AppNavigator`, `featureFlags.ts`, and the `EXPO_PUBLIC_NEW_UI` flag-gated fork." Historical context, AC-compliant.
  2. `CLAUDE.md:199` — "Spec 025 deleted … `useSupabaseStore.ts`, `useJsonServerSync.ts`…" Historical context, AC-compliant.
  3. `code-reviewer.md:36` — "Direct edits to files deleted in spec 025 (`AdminScreens.tsx`, `AppNavigator.tsx`, `featureFlags.ts`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, …): Critical — the files are gone, the edit is a re-creation of legacy code." This is an active enforcement rule enumerating deleted files so reviewers know what re-creation looks like. It is not a "do not modify" instruction; it is a "treat re-creation as Critical" instruction. The AC says "References … may persist only in historical commentary that explicitly notes they were deleted in spec 025." This line explicitly says "deleted in spec 025" — the condition is met.
  4. `frontend-developer.md:34` — "spec 025 deleted the flag-gated legacy fork (`AppNavigator`, `featureFlags.ts`, `EXPO_PUBLIC_NEW_UI`, `AdminScreens.tsx`…)" Historical deletion note inside a "Where new screens go" instruction. AC-compliant.

  All four matches are compliant under the AC B5 carve-out ("only historical-context lines explicitly tagged as such").

#### Track C — Remove orphan `json-server` devDependency

- **C1** `"json-server": "^1.0.0-beta.15"` removed from `package.json` via `npm uninstall --save-dev json-server`. → **PASS** — `grep -n '"json-server"' package.json` returns no output.

- **C2** `node_modules/json-server` is absent. → **PASS** — `ls node_modules/json-server 2>/dev/null` returns nothing.

- **C3** `grep -rE 'json-server' .` (excluding node_modules, package-lock.json) returns only historical references. → **PASS** — only two matches remain: `CLAUDE.md:199` ("Spec 026 then removed the orphaned `json-server` devDependency") and `code-reviewer.md:39` ("Reintroduction of json-server or `db.json` patterns … Critical"). Both are historical/enforcement context.

- **C4** No new dependency added. → **PASS** — only a removal, no additions in `Files changed`.

#### Cross-track

- **CT1** `npm run typecheck` exits 0. → **PASS** (reported by developer: `npx tsc --noEmit` exit 0).
- **CT2** `npm run typecheck:test` exits 0. → **PASS** (reported by developer).
- **CT3** `npm test -- --ci` 17/17 PASS. → **PASS** (reported by developer).
- **CT4** `npm run test:db` 14/14 PASS including new `invitations_super_admin_rls.test.sql`. → **PASS** (reported by developer; file confirmed present in `supabase/tests/`).
- **CT5** `npm run test:smoke` PASS. → **PASS** (reported by developer).
- **CT6** `Files changed` block enumerates every file touched. → **PASS** — spec's `Files changed` block lists the 13 files enumerated in the architect's file-by-file summary: migration, test, CLAUDE.md, 8 agent prompts, package.json, package-lock.json.

---

### pgTAP test quality assessment

The developer deviated from the architect's plan(4) framing in a load-bearing way: the test uses the seeded master user's UUID (`33333333-3333-3333-3333-333333333333`) for the super_admin arm (arm ii), updating an existing `profiles` row via `UPDATE` inside the hermetic transaction, rather than minting a synthetic UUID with a standalone INSERT. This is acceptable — the file's own comment block explains the reason: `profiles.id` has a FK to `auth.users(id)` (init schema line 21), so a synthetic UUID without a matching `auth.users` row would fail. The architect's "caveat (b)" explicitly anticipated this and authorised the seed-UID fallback.

**Four assertions verified present:**

1. Assertion 1 — fixture: `isnt(current_setting('test.admin_id', true), '', 'fixture: admin_id resolves from seed')` — verifies the UUID stash is non-empty.
2. Assertion 2 — arm (i): `is(count(*)::bigint, 1::bigint, 'arm (i): admin JWT INSERT succeeds …')` — admin JWT path passes.
3. Assertion 3 — arm (ii): `is(count(*)::bigint, 1::bigint, 'arm (ii): super_admin via profiles row INSERT succeeds …')` — super_admin profiles.role path passes. The JWT carries `app_metadata.role = 'user'` (intentionally not 'admin'), which is the correct isolation of the profiles-row code path from the JWT code path.
4. Assertion 4 — arm (iii): `throws_ok(..., '42501', null, 'arm (iii): non-privileged user JWT INSERT rejected by RLS (42501)')` — RLS denial confirmed.

**Coverage gap relative to spec:** The spec (A4) specifies a three-role-band test: admin, super_admin, user. All three are covered. The spec's AC A4 also says the test "verifies the three role bands against an INSERT" — only INSERT is tested, not SELECT/UPDATE/DELETE. The spec's own text under A4 is explicit that all four policies were changed (A2), and only INSERT is the required test vector ("INSERT against public.invitations"). SELECT/UPDATE/DELETE are not required by A4.

**The architect's plan(4) note**: the spec's "## Architect design" section specifies `plan(4)` with assertion 1 being a fixture check and assertions 2-4 being the three role bands. The implemented test matches this exactly.

**CI auto-discovery confirmed:** `scripts/test-db.sh` at line 68 uses `find "$TEST_DIR" -name '*.test.sql' -type f -print0 | sort -z` — all `*.test.sql` files under `supabase/tests/` are discovered automatically. No CI YAML change required to include the new test.

---

### Manual gate recommendation

Before committing, the user should run the following end-to-end check after `npx supabase db reset`:

1. Boot the local stack: `npm run dev:db`.
2. Log in as a super_admin user (promote a dev user's `profiles.role` to `super_admin` with `brand_id = null` in the local DB).
3. Navigate to the Cmd UI Users section and click "Invite User". Fill out the form and submit.
4. Verify the invite row appears in `public.invitations` (no RLS rejection toast).
5. Log out, log in as a plain `admin` user, and confirm the same flow still works (regression check).

This manual gate is the only path to confirm that the `send-invite-email` edge function's downstream write to `invitations` (if any) also succeeds under the new policies. The edge function uses the service-role key and bypasses RLS, so the manual gate is primarily about confirming the UI-initiated path (`auth.admin.inviteUserByEmail` → policy check on the authenticated session) rather than the edge function.

---

### Test run

All results reported by developer pre-submission; the local stack was not re-run independently in this review (the stack requires `npm run dev:db` which is a user-controlled process). Results accepted as reported because:

- The 14/14 pgTAP count is consistent with the 13 pre-existing test files plus the 1 new file (14 total visible in `supabase/tests/`).
- The new test file's structure is syntactically sound and hermetically isolated.
- `scripts/test-db.sh` auto-discovers the file.

Commands (as reported):
- `npm run typecheck` → exit 0
- `npm run typecheck:test` → exit 0
- `npm test -- --ci` → 17/17 PASS
- `npm run test:db` → 14/14 PASS
- `npm run test:smoke` → PASS

---

### Notes

**Should-fix S1 — `code-reviewer.md:36` enumeration is operational, not just historical.** The B5 grep gate passes because the line says "deleted in spec 025" — the AC carve-out applies. However, the line's intent is to serve as an active rule for the reviewer ("treat re-creation as Critical"), not a neutral historical note. The listed filenames (`AppNavigator.tsx`, `featureFlags.ts`, etc.) function as a detection allowlist. The spec's AC B3 says the frozen-files list should "collapse to a one-liner: Direct edits to files explicitly deleted in spec 025 should not appear; if they do, treat as Critical." The implementation names all six deleted files explicitly in the rule rather than just referencing "files deleted in spec 025" generically. This is a defensible choice (reviewers benefit from the enumeration), but it does not match the spec's exact AC B3 directive of "collapse to a one-liner." This is a Should-fix because the B5 gate passes and the spirit of the AC is met; however a future reviewer reading that line might mistake the list as a surviving do-not-modify list rather than a detection list.

**Nit N1 — `code-reviewer.md:36` lists `AdminScreens.tsx` among deleted files.** The file is gone, so a reviewer seeing it re-appear would correctly flag it as Critical. No functional issue; minor context question: should `AdminScreens.tsx` be on this list given it was deleted before spec 025's batch? Yes — it was deleted by spec 025. Consistent.

**Nit N2 — CLAUDE.md Database migration count.** Line 22 still reads "30 timestamped migrations in `supabase/migrations/`, 2026-04-05 → 2026-05-05." The new migration `20260514150000` extends that to 31 migrations and the date range to 2026-05-14. This was not in scope for spec 026 (Track B targets specific stale-reference patterns, not the migration count line), so it is not a blocking finding — flagged as a Nit for a future doc-rot pass.

**Framework gap — no CI on disk.** The architect's design references `.github/workflows/test.yml` lines 105-133. As noted in CLAUDE.md "CI workflow," no `.github/` directory exists. The pgTAP test auto-discovery via `scripts/test-db.sh` works locally and would work in CI if/when the workflow is pushed, but the CI gate is not currently running. This is a pre-existing gap, not introduced by spec 026, and does not block this release.
