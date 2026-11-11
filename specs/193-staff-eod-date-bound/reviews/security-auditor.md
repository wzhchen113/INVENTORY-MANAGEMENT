## Security audit for spec 193

Scope: spec 193's changes only. Main files are `supabase/migrations/20261109190000_staff_eod_date_bound.sql` (untracked), `supabase/tests/staff_submit_eod_date_bound.test.sql` (untracked), the date rework in the 8 listed pgTAP suites, `src/screens/staff/hooks/useEodSubmit.test.ts` (test-only), and `scripts/smoke-staff-eod.sh`. I compared against the committed spec 189 migration (`git show HEAD:supabase/migrations/20261109120000_admin_eod_replace.sql`, 97f0f17). Every probe ran on the local stack (`supabase_db_imr-inventory`) inside `BEGIN … ROLLBACK`. Nothing touched prod.

Verdict: **no Critical, no High.** The bound holds against every bypass I tried. The refusal can't make the shipped client dequeue a count. The R9 CTE audits every erased item. The posture of both functions is unchanged from 189.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- **L1. `supabase/migrations/20261109190000_staff_eod_date_bound.sql:161-183` (the R9 CTE). A re-send can blank an item without a `Count cleared` row (accepted residual; recorded so it's on file).** R9 only audits items that are missing from `p_entries`. A store member can re-send the item with `actual_remaining: null` (or `no_need: true`) and hollow out the count instead of dropping it.
  - Probe P3: S had I1=10 and I2=20. I sent `[I1=10, I2=null]`. Afterwards I2's entry has a NULL value, no `Count cleared` row exists, and I2's only trace is the per-entry staff row with `value` NULL. The old 20 is gone.
  - Impact: the caller's uid is still in that row's `detail`, so you can see who touched the item, but not the value they erased. A NULL `value` is also easy to miss when an admin scans the log.
  - This sits inside the spec's own "Out of scope: recording a re-sent item's old value", and the window still limits it to the last 35 days. Not a regression; the M1 fix still covers the drop-an-item case.
  - Fix (future spec, optional): also write `Count cleared` (or a "replaced" row with the old value) when a re-sent item's new value is NULL or NO NEED and the old one was numeric.
- **L2. `scripts/smoke-staff-eod.sh:75-76`. The local-only host guard can be bypassed with `#@` or `?@` in `SUPABASE_URL`, but this can't reach prod's REST or auth API.**
  - Why it passes: the sed strips everything up to the first `@` as userinfo, but `#` and `?` aren't excluded from that match. So `http://evil.invalid#@127.0.0.1` and `http://evil.invalid?@localhost` both reduce to a loopback host and pass the guard.
  - Where the requests actually go: I captured them with a local listener and `--connect-to`. curl sends them to the remote host, but the path gets cut off: `POST /` (fragment form) or `POST /?@127.0.0.1/rest/v1/rpc/staff_submit_eod` (query form).
  - So none of them reaches a Supabase `/rest/v1` or `/auth/v1` route, and no count can be replaced. The only thing that leaves the machine is the step-0 login body (the `STAFF_EMAIL` / `STAFF_PASSWORD`, by default the local test credentials), sent to a host the operator typed in deliberately.
  - Fix: allowlist the whole URL instead of extracting the host. For example: `[[ "$SUPABASE_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] || exit 2`.
  - Side note: `http://[::1]:54321` reduces to `[` and is refused. That's fail-closed and fine.
- **L3. `src/screens/staff/hooks/useEodSubmit.test.ts` (new `spec 193` describe) and design §3.3. The test uses a different error shape than production, but this doesn't affect safety.**
  - In the installed `@supabase/postgrest-js` 2.101.1, `supabase.rpc` without `throwOnError` returns `error` as the **plain parsed JSON object** (`PostgrestBuilder.ts` ~L200: `error = JSON.parse(body)`), not a `PostgrestError` instance. `PostgrestError` is only constructed on the `shouldThrowOnError` path (L225). The test fixture is `Object.assign(new Error(MSG), …)`, and design §3.3 says the error "extends Error".
  - Classification is the same either way:
    - `isForbidden`: false, because `code` is `'22023'`, there's no `status`, and the message has no `42501`.
    - `isNetworkError`: false, because `name` is undefined and none of the substrings match.
  - So the item still takes the "other error" branch: attempts are bumped, the item stays queued and the loop continues. R2's safety property holds.
  - The difference: in production `lastError` is recorded as `'unknown'`, not the message. AC-9's `lastError === MSG` assertion therefore pins behaviour that real traffic won't produce. That matters for the future "needs attention" UI, which would want to show the message.
  - Fix (test-engineer's call): use a plain `{ code, message, details, hint }` object in the fixture, and drop or adjust the `lastError` assertion.

### Verified (no finding)

**The bound can't be bypassed** (migration L401-407):
- **Session time zone / PostgREST `Prefer: timezone`.** The anchor is `(now() at time zone 'America/New_York')::date`. Probe P1d ran under `set local timezone = 'Pacific/Kiritimati'` (UTC+14): A-36 and A+2 were refused, A+1 succeeded. The suite's arms (15)-(22) cover `Etc/GMT-14` and `Etc/GMT+12`, and (36) checks `prosrc` has no `current_date`. `now()` can't be influenced by the caller. `pg_catalog` is searched before `public`, so `search_path = public` can't shadow `now()`.
- **NULL and special dates.** `p_date` NULL is in the predicate and refused (arms 13-14). P1a/b/c: `'-infinity'`, `'infinity'` and `4713-01-01 BC` are all refused with 22023.
- **Privileged check.** I read `auth_is_privileged()`, `auth_is_admin()` and `auth_is_super_admin()` live:
  - `auth_is_admin()` coalesces the JWT claim to `''`, and `auth_is_super_admin()` is an `exists(...)`. So `auth_is_privileged()` can never return NULL, and `not NULL` can't skip the `if` (I checked this three-valued-logic trap specifically).
  - The JWT role comes from `app_metadata` only (not user-writable).
  - A store member can't make themselves super_admin through `profiles.role`. `authenticated` does hold a column UPDATE grant on `role`, but `profiles_self_brand_lock` → `assert_brand_id_immutable_for_self()` raises `role is read-only for self-edits` for a non-super_admin self-edit.
- **Idempotency replay.** Probe P2: a store member replays a stored `client_uuid` with `p_date = A-200` and a different payload. Result: `conflict: true`, and nothing is written at A-200 (read back as postgres: 0 rows). The replay branch only reads, so putting it before the date check gives no write primitive.
- **Other paths to the writer.** There is one `staff_submit_eod` overload (no older un-bounded signature). `eod_write_submission` is `{postgres=X/postgres}` only. Probe P7: an `authenticated` caller gets `permission denied for function eod_write_submission`. `admin_submit_eod` is untouched and stays `auth_is_admin()`-gated.
- **Store gate first.** An out-of-membership caller at A-36 gets 42501 (arm 12).

**The refusal can't lose a count** (`useEodSubmit.ts` L46-68, L176-204):
- The SQLSTATE is 22023, which PostgREST maps to HTTP 400. The smoke's step 8c observed exactly 400 + `22023` + the message.
- The message is constant, lower-cases to nothing in the `isNetworkError` list, and contains no `42501` or `network`. Nothing is interpolated, so a uuid can't inject `42501`.
- With either error shape (see L3), the refused item is kept and retried, and the drain doesn't `break`.

**R9 CTE correctness** (migration L161-183):
- It's a scripted diff against the 189 admin CTE: one hunk, the six values copied exactly.
- The delete stays unconditional, and `NOT EXISTS` sits on the audit insert only.
- Probe P4: sending `[I1]` over {I1, I2} writes exactly one `Count cleared` row, for I2 (`value '20 lbs'`, `user_id` = the store member), and none for I1.
- A NULL or missing `ingredient_id` in the payload matches nothing (no NOT IN trap), and the call then rolls back in the loop anyway (P5).
- A duplicate item can't multiply rows (semi-join), and its 23505 rolls the audit rows back (P6).
- A legacy NULL `item_id` row is audited, with `item_ref` NULL.
- Probe P8: a store member can't DELETE or UPDATE the resulting `audit_log` rows (0 rows affected). Their only window is the privileged 90-day-gated `admin_delete_audit_log`.

**Posture unchanged vs committed 189:**
- Live catalog after the local apply: wrapper `prosecdef = t`, `proconfig = {search_path=public}`, `proacl = {postgres=X/postgres,authenticated=X/postgres}`. Writer `prosecdef = f`, `proconfig = {search_path=public}`, `proacl = {postgres=X/postgres}`. That matches 189.
- The `md5` of each `$$…$$` body in the migration file equals the live `md5(prosrc)` (`dfe77d71…` wrapper, `08d250d9…` writer). Local is running exactly the reviewed text.
- Body diffs against HEAD's 189 file: the wrapper has one added block and nothing removed; the writer has one hunk inside the NULL arm.
- The re-issued revoke and the 55000 pre-flight are fail-closed.
- No new table, policy, grant or publication change. No `EXECUTE` dynamic SQL.

**Smoke can't hit prod:**
- The guard runs before any token fetch. It has no override env, and the remote usage line was removed.
- Cleanup is `docker exec` into the local container, with uuidgen-only values interpolated.
- The one parser gap (L2) can't reach `/rest/v1` or `/auth/v1`.

**pgTAP:** `staff_submit_eod_date_bound.test.sql` runs 69/69 ok locally (hermetic `begin … rollback`). The ACL arms aren't vacuous: (61)-(69) assert `proacl is not null` plus `aclexplode`, and (31)-(33) use `has_function_privilege` for `authenticated`, `anon` and `service_role`.

**Pre-existing, not introduced here:**
- A payload element with a missing or cross-store item raises 42501 from `eod_entries_check_store_trg`, which `isForbidden` treats as a dequeue (seen incidentally in P5).
- Direct-table INSERTs at any date (the named follow-up).

Both are outside spec 193's diff.

### Dependencies
`package.json` isn't in spec 193's change set; its working-tree modification belongs to another session. npm audit skipped.
