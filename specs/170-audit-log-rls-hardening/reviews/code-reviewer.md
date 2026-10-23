## Code review for spec 170

Scope: `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`, `supabase/tests/audit_log_rls_hardening.test.sql`, `supabase/tests/super_admin_policy_parity.test.sql` (amended), `src/lib/db.ts` (`deleteStore`, line 185). Spec 167/168/169 files ignored. Read-only review; I did not run pgTAP or jest.

Project-policy checks, all clean:
- No new `supabase.from(...)` call outside `db.ts`. The only client change deletes a call.
- No inline color literals, `Alert.alert`, or web-only APIs.
- No deleted legacy files touched, and `app.json` slug untouched.
- Policies use `auth_is_privileged()`, `auth_is_super_admin()` and `auth_can_see_store()`. No `auth_is_admin()` and no custom `current_setting('jwt...')` SQL. `super_admin_policy_parity` LINT-1 stays at 0.
- The migration is a single newest file with `begin/commit`, `drop policy if exists` before every `create`, a rollback block, and `comment on policy` citing spec 170 on all four new or changed policies (AC-2).
- The test file is the existing pgTAP track: hermetic `begin/rollback`, no rolled-back savepoints, plan count 45 matches the arms present.

### Critical
- None.

### Should-fix
- `supabase/tests/super_admin_policy_parity.test.sql:328-337` (AL-8), with stale prose at `:63-73` and `:312-316` (AL-7/AL-8 comments).
  - AL-8 deletes fixture `…0004`, which is still created with `default` (fresh). After spec 170 nobody can API-delete a fresh row, so the arm passes even if the plain user were privileged. It no longer proves "plain user is refused by the privilege gate", which is what its message claims.
  - The header at `:70-73` still calls AL-7/AL-8 "the sharpest arms in the suite", and the AL-7 comment (`:312-316`) says "proves the UPDATE policy ... is what refuses". There is no UPDATE policy any more.
  - Suggested fix: age fixture `…0004` to `now() - interval '91 days'` in the fixture insert (`:137-139`). The plain user can still SELECT it via the Towson grant, so the read-back stays meaningful, and the arm is sharp again.
  - Reword the AL-7 comment to say it is now covered by default-deny.
  - `audit_log_rls_hardening` D-7 covers the same property with an aged row, so this is test-quality debt rather than a coverage hole. The spec's N1 says AL-8 "keeps passing unchanged", but the prose it carries is now false.

### Nits
- `supabase/tests/audit_log_rls_hardening.test.sql:265-272` (S-7) — `count(*) = 5` over `pg_proc` by `proname` assumes exactly one overload per function. It fails if any of the five (for example `staff_submit_eod`) gains a second overload. That is likely to be misread as an owner-bypass regression. Consider `count(distinct proname) = 5` and drop the count from the `bool_and` semantics, or add a failure-message hint. Currently green because older overloads were dropped.
- `supabase/tests/audit_log_rls_hardening.test.sql:222,231` (S-3/S-4) — the literals pin `pg_policies` deparsed text. They are brittle across Postgres major versions or a different CLI image, though CI and local use the same one today. If they ever flake, compare against `pg_get_expr` of the stored value or assert the semantic fragments instead. The spec asked for the pinned literal, so no change is needed now.
- `supabase/tests/audit_log_rls_hardening.test.sql:600` (W-4) — asserts `detail = brand_b`, which couples the arm to the exact string `copy_catalog_rows` writes into `detail`. It matches today. Keying on `action = 'catalog_copy' and user_id = super_id` plus a before/after delta would be more robust to a message tweak.
- `supabase/tests/audit_log_rls_hardening.test.sql:434` (W-3) — likewise pins the literal `'BJs order missed (1999-12-27)'`. Fine, but a second point of coupling to `record_missed_orders_for_day`'s message format.
- `src/lib/db.ts:179` — the comment "Delete all related data first" is now slightly inaccurate, since audit_log rows are deliberately left to the cascade. The new line-185 comment explains the why well. Optionally fold the two together, for example "Delete the non-cascading related data first".
- (out-of-scope) `src/lib/db.ts:5997` — the 90-day literal in `cleanupOldRecords` is now coupled to the `admin_delete_audit_log` policy predicate. The policy comment documents this, but the client has no reciprocal comment. AC-18 requires `cleanupOldRecords` to be unchanged, so I am only noting it.
- (out-of-scope) `deleteStore` has zero callers, per architect F-170-2. It is already tracked as a follow-up.

---

## Delta re-review (fix pass) — 2026-10-22

Read directly: the migration, `audit_log_rls_hardening.test.sql`, `super_admin_policy_parity.test.sql`, and `src/lib/db.ts:178-189`. I also grepped `src/lib/db.ts` and `supabase/` for `audit_log` inserts that set `created_at`. I did not run pgTAP or jest.

### Prior Should-fix: closed
- AL-8 (`super_admin_policy_parity.test.sql:155-157`): fixture `…0004` is now inserted at `now() - interval '91 days'`. The plain user holds the Towson `user_stores` grant, so the age gate and `auth_can_see_store()` both admit the row. Only `auth_is_privileged()` can refuse, so the arm is sharp again. Message (`:357`) and comment (`:347-349`) say "aged (>90d)" and match the fixture.
- Stale prose is fixed. The "sharpest arms in the suite" phrase is gone (grep finds no match). The header (`:50-58`, `:85-89`) now explains the aged AL-8 fixture, that AL-7 is refused by default-deny, and that the fixture inserts run as postgres so the `created_at = now()` policy does not apply. The AL-7 comment (`:330-335`) no longer claims an UPDATE policy refuses it.
- The coverage list at `:30-32` also matches. Plan stays at 20.
- `src/lib/db.ts:179` nit is also closed. The comment now reads "except audit_log (left to the stores FK cascade)" and is consistent with line 185.

### New code checked: no Critical, no Should-fix
- **Policy (f)** `audit_log_restrict_insert_created_at_now` (migration `:167-179`):
  - Correct shape: RESTRICTIVE, INSERT, no `to` clause. It is listed in the rollback block (`:74`) and has a `comment on policy` citing spec 170, with `drop policy if exists` first.
  - An omitted `created_at` takes the column default `now()` before WITH CHECK, so it passes. An explicit NULL yields `NULL = now()`, which is not true, so it is refused with 42501. The comment says both, and C-2/C-6 cover the NULL case.
  - The only client insert, `addAuditEvent` (`db.ts:2838-2845`), omits `created_at`. No migration in `supabase/` that inserts into `audit_log` sets `created_at` (only `record_missed_orders_rpc` matched, and it omits the column). The policy's claim that "no RLS-subject writer sets created_at" holds, and a multi-row PostgREST insert shares one transaction `now()`.
  - Policy count is consistent: the header of the migration, S-1 (seven policies, alphabetical order is stable under both C and linguistic collation), and S-6 (five `spec 170:` comments, since the dropped UPDATE policy takes its description with it).
- **C-1..C-8** (`:405-434`, `:579-607`): each arm sets `store_id` to S1, `user_id` to the caller, and an ordinary action. The permissive policy, (b) and (c) all pass, so only (f) can refuse, as the comments say. Staff and admin are both covered, which matches "no privileged exemption". Future, NULL and past are covered, and the omitted case is the positive control (C-4, C-8). The `now() - interval '91 days'` in C-7 is the sharper arm, because it would otherwise slip under a "not in the future" mutant. No issues.
- **D-10** (`:620-641`, `:834-844`):
  - It isolates the DELETE store scope correctly. The probe `using (true)` SELECT policy is created as postgres, then the admin JWT records that the row is visible (`test.d10_visible`, a transaction-local setting that survives the role switch). That precondition rules out a vacuous pass. The probe is dropped before the next block, and the final arm asserts the row survives and the probe is gone.
  - The `reset role` / `set local role authenticated` pair keeps the JWT claims, so the second block still runs as the brand-A admin.
  - The permissive-lint test runs in its own transaction, as the header states.
  - The fixture `…0027` is separate from D-4's `…0023`, and the D-4 message now says it is SELECT-masked and points at D-10.
- **Arm count**: S 7 + F 1 + R 4 + I 16 + W 6 + U 2 + C 8 + D 10 = 54, which matches `plan(54)` and the "Arm map (54)" header. The header arithmetic (45 + 8 + 1) is right.

### Nits (new, all optional)
- `supabase/tests/audit_log_rls_hardening.test.sql:626-628` — the comment records "Verified to FAIL against a spec 157 negative control ... and the mutant `... or true` (spec 170 review fix pass)". This is a one-time provenance claim that no CI run re-checks. It is useful today but will go stale and cannot be confirmed from the file. Consider moving it to the review or spec notes and leaving only the "why".
- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql:11-30` — the shape list heading says "owner-approved, spec 170 'Open questions resolved'", but (f) is approved by "owner decision 9, in chat" per `:30-31`. It is already stated inline at (f), so this is only a heading precision nit.
- The earlier S-7, S-3/S-4, W-3 and W-4 nits are unchanged and still optional. No new Critical or Should-fix items.

### Totals for the delta
0 Critical, 0 Should-fix (prior one closed), 2 new Nits. The full file now stands at 0 Critical, 0 Should-fix, and the prior and new Nits listed above.
