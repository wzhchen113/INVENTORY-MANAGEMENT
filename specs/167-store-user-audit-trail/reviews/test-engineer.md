## Test report for spec 167

### Acceptance criteria status
- AC-1: create writes one audit_log row per store (store_id, user_id=caller, action, item_ref=username, value '', detail JSON) → PASS — `scripts/smoke-store-user.sh` Arm A1/A2/A3 (`check_audit`: exact row count, store_id set, user_id, empty value, detail.target_id / brand_id, exact key set `{brand_id,target_id}`). `created_at` is not written by the function (code inspection), so the default applies.
- AC-2: set_password reads current user_stores and writes one row per store → PASS — smoke-store-user.sh Arm A4 (2 rows, stores {A1,A2}, same field checks). `item_ref` comes from `profiles.username` (diff inspection).
- AC-3: store-less target writes no row, no NULL-store row, one console line, still returns 200 `{success:true}` → PASS — smoke-store-user.sh Arm A6 (200, body exactly `{"success":true}`, 0 rows for the target, 0 `store_id IS NULL` rows). The console line was confirmed in the edge runtime logs: `[Warning] [manage-store-user] audit skipped: target has no stores <caller> <target> Store user password set`. Only ids and the action appear.
- AC-4: audit failure is best-effort; response unchanged; no compensation; log carries code only → PASS, but by a one-off manual run, not a committed test. No committed arm injects an audit failure. I installed a temporary BEFORE INSERT trigger on `audit_log` that raises `P0001` with a distinctive message, then ran create and set_password through the real edge function:
  - create returned 201 `{id,username}`. The profile, auth user and user_stores row all remained (no rollback), and 0 audit rows were written.
  - set_password returned 200 `{"success":true}`.
  - The logs showed `audit write failed <caller> <target> Store user created P0001` and the same line for `Store user password set`.
  - 0 hits in the logs for the trigger's message text, the password or `no-email.invalid`.
  - The trigger and fixtures were removed afterwards (verified: 0 leftover rows or users).
  - Scratch script: `/private/tmp/claude-501/-Users-will-Documents-GitHub-INVENTORY-MANAGEMENT/56811e59-622d-4d6e-970d-1ef1b6cb7d10/scratchpad/ac4.sh`. It is not in the repo. See Notes.
- AC-5: refused or failed actions write zero rows → PASS — smoke-store-user.sh Arm A7 (global tally: exactly 7 rows added by the whole run, so no refused path in any arm wrote a row). Also A1 (409 / duplicate arms wrote nothing), A3 (compensated attempt wrote nothing) and A4 / A5 (short-password and role-gate refusals wrote nothing).
- AC-6: no password or placeholder in any audit column or new log line → PASS — smoke-store-user.sh Arm A8 (7 rows scanned for PW1, PW2 and `no-email.invalid`) and Arm A9 (edge runtime logs since the smoke started contain neither password). A9 scans passwords only, per design. The one-off AC-4 run also found no placeholder substring in the logs.
- AC-7: no change to request or response shapes, status codes, refusal strings or gate ordering → PASS — all pre-existing spec 165 arms (1-17, 18-20) still pass unchanged. The diff shows the only edits before the side effects are one extra column in the step-4 select, and the audit write sits after the last side effect. `src/lib/placeholderEmail.parity.test.ts` passes in the full jest run.
- AC-8: delete-user self-guard is case-insensitive, trimmed, non-string safe, string unchanged → PASS — `scripts/smoke-edge-roles.sh` Arm 8 (uppercased id → 400 `cannot delete self`; uppercased + padded → 400 `cannot delete self`; numeric `userId` → 400 `userId required`). Arm 6 (existing self-delete refusal) also still passes.
- AC-9: `AuditAction` gains both values → PASS — `npm run typecheck` (the `Record<AuditAction,string>` in `formatAuditAction.ts` forces the mapping) and `src/utils/enumLabels.test.ts` (ACTIONS list).
- AC-10: `KEY_BY_ACTION` mapping plus en/es/zh-CN strings → PASS — `src/utils/enumLabels.test.ts` (drift test over ACTIONS, plus four exact-string es / zh-CN assertions: `storeUserCreated` and `storeUserPasswordSet`). `src/i18n/i18n.test.ts` catalog parity passes.
- AC-11: tones on desktop and phone, `inferKind` returns `'user'`, rows appear via `fetchAuditLog` → NOT TESTED (automated) — the diff shows the correct entries:
  - Desktop `ACTION_TONE`: created `ok`, password set `warn`.
  - Phone `ACTION_TONE`: the same tones.
  - `inferKind`: `'user'` for both.
  - No jest test covers any of this. `ACTION_TONE` is `Partial<Record<…>>`, so typecheck does not enforce it, and there is no render test or e2e for either audit view.
  - Rows being readable per store is only indirectly supported: the existing RLS arm on `audit_log` is unchanged and the rows carry a non-NULL `store_id`.
  - This is display-only and low risk, but by the project rule it counts as unverified.
- AC-12: smoke-store-user.sh arms (a)-(e) → PASS — (a) A1, (b) A4, (c) A8 / A9, (d) A5 / A7 plus the exactly-N counts in A1 and A4, (e) A6. See the AC-4 note about the gap in failure-path coverage.
- AC-13: smoke-edge-roles.sh uppercased-self arm → PASS — Arm 8 (disposable same-brand admin; the post-checks confirm the profile, the auth user and user_stores are intact; the EXIT trap removed the fixture).
- AC-14: drift test includes the new actions; full jest + typecheck + typecheck:test pass → PASS — see the test run below.

Summary: 12 PASS (one of them, AC-4, is a manual run only), 1 NOT TESTED (AC-11 automated coverage), 0 FAIL, out of 14 criteria.

### Test run
Local stack was up. All 12 `supabase_*_imr-inventory` containers were running. The edge-runtime bind mount points at `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`, which is the repo root, so it was fine. I restarted `supabase_edge_runtime_imr-inventory` before the smokes. (`npx supabase status` fails on this machine with "No matching Supabase CLI binary package found for darwin-arm64". The stack itself is healthy per `docker ps`.)

- `npx jest` → `Test Suites: 229 passed, 229 total`, `Tests: 2652 passed, 2652 total`, `Snapshots: 2 passed, 2 total`.
- `npm run typecheck` → clean, no output after `tsc --noEmit`.
- `npm run typecheck:test` → clean, no output after `tsc -p tsconfig.test.json --noEmit`.
- `bash scripts/smoke-store-user.sh` → exit 0, `ALL ARMS PASSED`. Log tally: 85 PASS lines, 0 FAIL, 1 SKIP. The SKIP is the existing username-resolve step, because the local `USERNAME_RESOLVE_SERVICE_TOKEN` is unset or mismatched (HTTP 500). It is unrelated to this spec. Cleanup passed.
- `bash scripts/smoke-edge-roles.sh` → exit 0, `all checks passed`, 24 PASS, 0 FAIL, 0 SKIP. The admin restore and the Arm 8 disposable-admin removal both passed.
- After all runs, the DB had 0 leftover `zz_%` auth users and 0 leftover `zz_%` audit rows.

### Notes
- **AC-4 has no committed regression test.** The best-effort path (audit insert error → response unchanged, no compensation, code-only log) is only proven by my one-off trigger-injection run. A cheap permanent arm would be to install a temporary `audit_log` BEFORE INSERT failure trigger (the same pattern as Arm C's `user_stores` trigger), then assert 201 / 200, the account still exists, and the logs contain the code but not the trigger's message. I did not add it, because my brief was not to edit implementation files and the design did not call for it. Recommend the release-coordinator weigh this as a coverage gap, not a defect. The behavior itself is verified.
- **AC-11 display wiring has no automated test.** A small jest case on `inferKind` (it would need an export) and on tone assignment would close it. The i18n labels themselves are covered.
- `npx supabase status` could not run locally (a missing CLI binary for darwin-arm64 in the npx cache). The stack state was checked with `docker ps` and `docker inspect` instead.
- `app.json` slug untouched. No implementation files were edited. Nothing committed.
- The unstaged diff for spec 166 was ignored, as instructed.
- Heads-up: `scripts/smoke-store-user.sh` and `manage-store-user/index.ts` are also modified by the spec 166 session. The runs above exercised the combined working tree.

## Delta re-review (fix pass) - 2026-10-19

Scope: the unstaged fix pass plus the untracked `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx`. Spec 166 ignored. No implementation files edited. Nothing committed.

### Acceptance criteria status (changed or re-checked)
- AC-4: audit failure is best-effort; response unchanged; no compensation; log carries code only -> PASS, now a committed test. `scripts/smoke-store-user.sh` Arm AF installs a temporary `zz_s167_fail_audit_log` BEFORE INSERT trigger (raises P0001 only for the AF user's `item_ref`). It asserts:
  - create returns 201 with keys exactly `{id, username}`.
  - Profile, auth user and user_stores row are kept (no compensation).
  - set_password returns 200 `{"success":true}` and the new password logs in.
  - 0 audit rows for the AF user.
  - The trigger is dropped, and the EXIT trap has a guarded drop as a backstop.
  - The edge logs show 2 `audit write failed ... P0001` lines for the target and never contain the trigger's message.
  - A7's tally stays at 7 (AF adds 0 by design).
  - Observed: all AF lines PASS and A7 PASS. After the run, 0 leftover non-internal triggers on `audit_log`.
- AC-11: tones on desktop and phone, `inferKind` returns `'user'`, rows appear via `fetchAuditLog` -> PASS (automated now).
  - `AuditLogSection.storeUser.spec167.test.tsx`:
    - `inferKind` returns `'user'` for both actions.
    - Desktop tones: created `ok`, password set `warn`.
    - Phone tone equals desktop for both actions.
  - `PhoneAuditLog.test.tsx::renders store-user audit rows as translated verb + username` renders both rows and asserts the text `created store user frontdesk` and `set store user password backdesk`.
  - `fetchAuditLog` (`src/lib/db.ts:2810`) filters on `store_id` only, with no action allowlist, so the new rows surface. This is by code inspection. The rows carry a non-NULL `store_id`, and the audit_log RLS arm is unchanged.
  - The only change to production source is the `export` keyword on `ACTION_TONE` and `inferKind`; behavior is unchanged.
  - Residual: no end-to-end render of the desktop table with these rows (only the helper-level checks). That is low risk.
- AC-8 and AC-13 (extension): PASS. `scripts/smoke-edge-roles.sh` Arm 8 now also checks that the caller's own id in braces and with hyphens removed return 400 `userId required` (canonical `UUID_RE` gate in `delete-user`, before the self-guard). The post-checks confirm the caller's profile, auth user and user_stores are intact. The pre-existing arms (uppercased -> `cannot delete self`, uppercased + padded -> `cannot delete self`, numeric `userId` -> `userId required`) still pass, so the `cannot delete self` string is unchanged. The `sd_psql` fix (return psql's exit status) is a harness improvement and is exercised by the successful fixture creation.
- AC-1, 2, 3, 5, 6, 7, 9, 10, 12, 14: unchanged from the original report. They were re-exercised by the full runs below and all still pass.

Summary after the fix pass: 14 PASS, 0 FAIL, 0 NOT TESTED out of 14 criteria. The two gaps from the original report (AC-4 manual-only, AC-11 untested) are closed.

### Test run (verbatim counts)
Stack: all 12 `imr-inventory` containers up. I restarted `supabase_edge_runtime_imr-inventory` first. The bind mount is `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`, which is the repo root.
- `npx jest` -> `Test Suites: 230 passed, 230 total`, `Tests: 2658 passed, 2658 total`, `Snapshots: 2 passed, 2 total` (was 229 / 2652; +1 suite and +6 tests from the new AC-11 coverage).
- `npm run typecheck` -> clean, no output after `tsc --noEmit`.
- `npm run typecheck:test` -> clean, no output after `tsc -p tsconfig.test.json --noEmit`.
- `bash scripts/smoke-store-user.sh` -> exit 0, `ALL ARMS PASSED`. 96 PASS result lines (97 if you also count the `ALL ARMS PASSED` banner, which is the developer's "97"), 0 FAIL, 1 SKIP. The SKIP is the existing username-resolve step (local `USERNAME_RESOLVE_SERVICE_TOKEN` unset or mismatched, HTTP 500), unrelated to this spec. Cleanup passed.
- `bash scripts/smoke-edge-roles.sh` -> exit 0, `all checks passed`. 26 PASS, 0 FAIL, 0 SKIP.
- After the runs: 0 `zz%` auth users, 0 `zz%` profiles, 0 `zz%` audit rows, 0 non-internal triggers on `public.audit_log`.

### Notes
- No new findings. `deno check` and the proof that the pre-fix delete-user returns HTTP 500 and half-deletes on the new Arm 8 inputs are claimed by the developer in the spec. I did not re-run the swap.
- `npx supabase status` was not used (known missing darwin-arm64 binary); stack health was checked via `docker ps` / `docker inspect`.

## Handoff
next_agent: NONE
prompt: Test report complete. Original pass: 12 PASS, 1 NOT TESTED (AC-11). Superseded by the delta re-review above (2026-10-19): 14 PASS, 0 FAIL, 0 NOT TESTED across 14 acceptance criteria.
payload_paths:
  - specs/167-store-user-audit-trail/reviews/test-engineer.md
