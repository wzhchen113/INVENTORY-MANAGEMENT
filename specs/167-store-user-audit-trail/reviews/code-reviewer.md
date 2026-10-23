## Code review for spec 167

Scope: working-tree diff for the files listed in the spec's `## Files changed` (spec 166 changes ignored). Read-only review. `git diff` was not available to me, so I read each file in full and judged the spec-167 hunks against the design. No hunk of `manage-store-user/index.ts` touches the pinned `placeholder-email` or `reserved-usernames` blocks (lines 50-75 are unchanged).

### Critical
- None. Checked specifically:
  - No `supabase.from` outside `db.ts` in new frontend code. The only new DB access is inside edge functions, which is the established pattern.
  - No `app.json` slug change.
  - No legacy-file edits.
  - No inline color literals. The frontend changes are tone-token map entries and strings.
  - No `window` / `Platform` concerns.
  - No new test files outside the three tracks.

### Should-fix
- `scripts/smoke-edge-roles.sh:507` and `:543` — `sd_psql` ends in `| tr -d ' '`, so its exit status is `tr`'s (always 0), not psql's. `-v ON_ERROR_STOP=1` therefore never reaches the caller. The guard `if [[ -n "$SELFDEL_ID" ]] && sd_psql "insert into public.profiles ..." >/dev/null; then` can never take the `fail "could not create the disposable admin fixture"` branch on an insert error. A failed profile insert (for example, a signup trigger that already created a profile row) would fall through to the sign-in. The delete-user calls would then come back 403 instead of 400, and the arm would report confusing `HTTP 403 ... (expected 400 ...)` failures instead of the real cause. Fix: capture the psql output first and test its status, or use `${PIPESTATUS[0]}` inside the helper.
  ```bash
  sd_psql() { local o; o=$(docker exec -i ... psql ... -tAc "$1" 2>/dev/null) || return 1; printf '%s' "$o" | tr -d ' '; }
  ```
  The `$(sd_psql "select count ...")` comparisons keep working with this form.

### Nits
- `supabase/functions/manage-store-user/index.ts:22-24` — the file header says "Log hygiene ... Only error code/status and the compensation orphan id are logged." That is now stale: the audit helpers also log caller id, target id and action (AC-3/AC-4). The `// ── Audit trail (spec 167)` block at :218-221 documents it correctly, so just extend the header sentence to point at it. The header's endpoint summary (lines 1-7) also never mentions that create / set_password now write `audit_log`.
- `supabase/functions/manage-store-user/index.ts:275-284` and `:297-309` — the error-code-or-exception-name logging shape (4 identical fields, two prefixes) is written four times. A tiny `logAuditFailure(prefix, ctx, codeOrName)` would remove the duplication and make it harder for a future edit to leak `error.message` in just one of the four sites. Optional.
- `supabase/functions/manage-store-user/index.ts:260-268` — the "target has no stores" `console.warn` lives in `writeStoreUserAudit`, while the "store read failed" log lives in `readTargetStoreIds`. The create path can never hit the zero-row branch. It works, but the store-less case is conceptually a set_password concern. Moving that check next to `readTargetStoreIds`' caller would keep `writeStoreUserAudit` a pure "insert these rows". Optional.
- `src/utils/formatAuditAction.ts:26-27` — the two new entries break the column alignment of the surrounding `KEY_BY_ACTION` entries (`'Store user created':  'storeUserCreated',` is misaligned and the second entry overruns). Same in `src/screens/cmd/sections/AuditLogSection.tsx:35-36`, which aligns the new pair to each other but not to the block above. Harmless, but align or leave consistently unaligned.
- `scripts/smoke-store-user.sh:497` — A7 hard-codes the expected delta `7`, which has to be kept in lockstep with every create / set_password success earlier in the script. Any future arm that adds one (spec 166 is mentioned as a possible folder-in) will fail A7 with a non-obvious message. Consider building the expected number from named counters, or add a one-line comment pointing future arm authors at it. The comment at :493-495 already enumerates the 7, so a "update me when adding a success arm" note is probably enough.
- `scripts/smoke-store-user.sh:502` — `item_ref like 'zz_s165%'`: `_` is a LIKE wildcard. It is harmless here (it only over-matches), and the same pattern already exists in `cleanup()`. If you want it exact, use `like 'zz\_s165%'`.
- `scripts/smoke-store-user.sh:461-466` — if `TRIGGER_INSTALLED` is still `1`, A3 SKIPs but A7's fixed `7` would then also fail. That only happens when Arm C's own cleanup failed, which already fails loudly. No change needed. Noting it only so A3/A7 are read together.
- `scripts/smoke-edge-roles.sh:505` — reading `SUPABASE_SERVICE_ROLE_KEY` via `docker exec ... printenv` and the `SELFDEL_*` naming are fine, but the arm and `smoke-store-user.sh` Arm 14 now each carry their own copy of the "create admin fixture via /auth/v1/admin/users + profile insert" snippet. (out-of-scope) A shared `scripts/lib` helper could be a later cleanup.

### Spec-conformance notes (no action)
- AC-1/AC-2 field mapping, bulk-insert-per-action, outside-the-compensating-try placement and strictly-after-last-side-effect ordering all match the design.
- AC-4/AC-6 log hygiene: only caller id, target id, action and `error.code` / exception class name are logged.
- AC-8: `delete-user` normalizes once, guards before any read, and the refusal string is byte-identical. The non-string / null / array body path now yields `userId required` instead of a TypeError.
- AC-9 to AC-11, AC-14: the `AuditAction` union, `KEY_BY_ACTION` (typed `Record<AuditAction, string>`, so drift is a compile error), the three catalogs (en/es/zh-CN lines 1738-1739, matching the spec strings and the catalog's 门店 convention), both `ACTION_TONE` maps, `inferKind`, and the `enumLabels.test.ts` additions are complete and consistent with the neighboring `Order missed` pattern.

---

## Delta re-review (fix pass) — 2026-10-19

Scope: `delete-user/index.ts`, `manage-store-user/index.ts` header, `scripts/smoke-edge-roles.sh` (`sd_psql`, Arm 8), `scripts/smoke-store-user.sh` (Arm AF, cleanup trap, A7 comment), `AuditLogSection.tsx` / `phone/PhoneAuditLog.tsx` (now export `ACTION_TONE` / `inferKind`), the new `AuditLogSection.storeUser.spec167.test.tsx`, and `PhoneAuditLog.test.tsx`. Read-only; I could not run jest or the smokes, so everything below is by inspection.

### Prior Should-fix: CLOSED
- `scripts/smoke-edge-roles.sh:512-516` — `sd_psql` now captures psql output with `o=$(docker exec ... -v ON_ERROR_STOP=1 -tAc "$1" 2>/dev/null) || return 1` and only then pipes through `tr`. psql's status reaches the caller, so the `if [[ -n "$SELFDEL_ID" ]] && sd_psql "insert ..." >/dev/null; then` guard at :552 can now take the `fail "could not create the disposable admin fixture"` branch. The `[[ "$(sd_psql "select count ...")" == "1" ]]` comparisons still work. `local o` is declared on its own line, so the `||` tests the substitution's status and not `local`'s. The Arm 8 header comment documents why.

### Critical
- None.

### Should-fix
- None new.

### Previously-listed nits, status
- manage-store-user header log-hygiene sentence (`index.ts:22-26`) is fixed: it now names the caller id, target id, action name and error code or exception class name, and says never the message, rows or username. The endpoint summary at lines 1-7 still does not mention the `audit_log` writes (very minor, optional).
- A7 hard-coded tally: now has the "UPDATE THIS TALLY whenever a success arm that writes audit rows is added" note and mentions that Arm AF adds 0 (`smoke-store-user.sh:566-570`). Addressed.
- Remaining nits (alignment of the new map entries, four-times-duplicated audit-failure log shape, `_` LIKE wildcard, shared fixture helper) are unchanged and still optional.

### Review of the new and changed pieces

`delete-user/index.ts` (clean)
- `UUID_RE` (:26) is byte-identical to `manage-store-user` `UUID_RE`. Its comment states why (supabase-js `deleteUser` throws on non-canonical ids while Postgres accepts them).
- :172-191 order is correct: parse, then `typeof` narrowing with no `any`, then trim and lowercase, then empty-or-regex refusal, then self-guard against `gate.userId.toLowerCase()`, then service client. The refusal strings `userId required` and `cannot delete self` are unchanged. Every later use (`requireSameBrandOrSuperAdmin`, the role lookup, the `assert_not_last_of_role` RPC, the three deletes, `auth.admin.deleteUser`) takes the normalized `userId`.
- Unchanged behavior for invalid JSON (throws, caught, 500). It was that way before this spec, so I am not flagging it.

`scripts/smoke-store-user.sh` Arm AF (sound)
- Trigger lifecycle is right. `AUDIT_TRIGGER_INSTALLED` is set only after a successful install and cleared only after a successful drop. The EXIT trap `cleanup()` (:97-101) retries the drop when it is still 1, and the header recovery block (:36-46) lists the trigger, the function and the `audit_log` rows. The trigger is scoped to `new.item_ref = U_AUD`, so no other row in the run is affected. Cleanup also deletes `zz_s165%` audit rows and users, which covers `U_AUD` (`zz_s165_f<6 hex>`, 15 chars, within `USERNAME_RE`).
- `AUDIT_BASE` / A7: AF writes zero audit rows by construction, so the expected delta stays 7. The comment says so.
- The log assertion matches the code. `manage-store-user/index.ts:277` is one `console.error("[manage-store-user] audit write failed", callerId, targetId, action, error.code)`, so "audit write failed", the target id and `P0001` land on one line, and `-ge 2` (create plus set_password) is right. The pipeline `grep -F | grep -F | grep -cF` is fine under `set -u` with no `-e`. `AF_T0` is taken after the trigger is installed and truncated to the second, so it is inclusive.
- The "never contains the trigger's message" check is the right negative assertion for AC-4.
- The AF checks cover response shape, account kept (profile, auth user, `user_stores`), new password works, and zero audit rows. That is complete for AC-4.

`AuditLogSection.tsx` / `PhoneAuditLog.tsx`
- `export const ACTION_TONE` and `export function inferKind` are the minimal change for testability. The default export is unchanged and nothing else was moved. Both tone maps carry the same two entries (`ok` / `warn`), and `inferKind` returns `'user'` for both actions, consistent with the existing `User invite`. No inline colors.

`AuditLogSection.storeUser.spec167.test.tsx` (new)
- Placement and pattern are right: jest track, under `sections/__tests__/`, with the same `supabase` mock shape as `PhoneAuditLog.test.tsx`. The mock path `../../../../lib/supabase` resolves to `src/lib/supabase` from this directory, and the `types` import path is correct.
- The `event()` fixture supplies every required `AuditEvent` field (checked against `src/types/index.ts:588-600`), so it should pass `typecheck:test` without casts. Only `'admin'` is used for `userRole`, which is a valid `UserRole`.
- The test earns its keep. `ACTION_TONE` is `Partial<Record<...>>`, so the compiler cannot catch a missing entry, and the phone-equals-desktop assertion guards the two copies against drifting.

`PhoneAuditLog.test.tsx`
- The new case seeds two rows and asserts the visible text `created store user frontdesk` / `set store user password backdesk`. This matches the en catalog (`en.json:1738-1739`) and the row's `formatAuditAction` + ` ${itemRef}` + empty-`value` composition (`PhoneAuditLog.tsx:183-185`, no ` · ` suffix when `value` is empty). It uses `as any` for the seed like the surrounding tests, so no new convention break.

### New nits
- `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx:46` — `describe` title and the file name carry the spec number. That is fine and matches other `*.spec###.test.tsx` files, but the `PhoneAuditLog` comment ("Spec 167 AC-11") is the only place the phone half of the AC is pinned; acceptable as is.
- (out-of-scope) `AuditLogSection.tsx` and `PhoneAuditLog.tsx` now each export non-component values alongside a component, which disables React Fast Refresh for those modules in dev. Harmless for a test-only seam; if it bites, move `ACTION_TONE` / `inferKind` to a small shared module in a later pass.

Totals: 0 Critical, 0 Should-fix, 2 Nits (new). Prior Should-fix closed.
