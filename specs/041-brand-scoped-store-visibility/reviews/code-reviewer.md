## Code review for spec 041 (re-review — fix pass)

Files reviewed:
- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
- `supabase/tests/auth_can_see_store_brand_scope.test.sql`

Prior review had 2 Critical, 1 Should-fix, 3 Nits. This is the re-review
after the fix pass described in the prompt (raise exception, comment cleanup,
trigger addition, pgTAP expanded to 10 arms).

### Critical

None. All prior Criticals are resolved.

- **Critical #1 resolved** (`raise warning` → `raise exception`):
  `migration:75-84` — The pre-flight DO block now uses `raise exception`
  with an `if exists (…)` form. The `v_bad_count` variable is gone. The
  comment block at lines 55-74 explains the fail-closed semantics and
  explicitly documents that the earlier draft used `raise warning`. The
  fix matches the architect's design contract verbatim.

- **Critical #2 resolved** (misleading citation comment):
  The "Same idiom as 012a:327-331" comment is removed entirely. The
  replacement comment block (lines 55-74) explains why `raise exception`
  is used and cites the spec Q4 rationale. No misleading citation remains.

- **Security-auditor Critical resolved** (`profiles.brand_id` self-write bypass):
  `migration:168-202` — `public.assert_brand_id_immutable_for_self()` is
  installed and `profiles_self_brand_lock` fires `before update on
  public.profiles for each row`. The trigger correctly:
  (a) gates the lockdown on `old.id = auth.uid()` (self-edits only),
  (b) exempts super_admin via `public.auth_is_super_admin()` (profile-row
      check, not JWT — cannot be forged),
  (c) rejects both `brand_id` and `role` mutations for non-super_admin
      self-edits,
  (d) returns `new` unconditionally (correct for BEFORE UPDATE triggers
      that don't want to block).

  The trigger pattern mirrors `user_stores_brand_match` at
  `20260509000000_multi_brand_schema_rls.sql:357-381`. One deliberate
  difference from the reference: `set search_path = public, auth` (vs
  `= public` in `user_stores_brand_match`). This difference is justified
  — the new function calls `auth.uid()` and `public.auth_is_super_admin()`
  (which itself calls `auth.uid()`), so the `auth` schema must be in scope.
  `user_stores_brand_match` does not call `auth.uid()` and correctly omits
  it. No deviation — the search paths differ for the right reason.

  pgTAP arms 7-10 cover:
  - Arm 7: brand-admin self-PATCH on `profiles.brand_id` → `throws_ok`
    with exact SQLSTATE `P0001` and message.
  - Arm 8: brand-admin self-PATCH on `profiles.role` → `throws_ok` with
    exact SQLSTATE `P0001` and message.
  - Arm 9: super_admin updating ANOTHER user's `brand_id` → `is()`
    positive control that the trigger does not over-block.
  - Arm 10: end-to-end proof — after arm 7's rejected self-PATCH, the
    brand-admin still cannot see the foreign-brand store via
    `auth_can_see_store`.

  `select plan(10)` declared; exactly 10 assertions present (8 × `is()` +
  2 × `throws_ok()`). Plan count is correct.


### Should-fix

None.


### Nits

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:163-166`
  — Comment says "auth.uid() returns NULL for the postgres superuser, so
  seed/migration UPDATEs run under the postgres role are also unaffected —
  old.id = NULL is never true." The phrase "old.id = NULL" will read to a
  future maintainer as though `old.id` itself is NULL; the accurate reading
  is that `auth.uid()` returns NULL, making the comparison `old.id =
  auth.uid()` evaluate to NULL (falsy). Suggested rewording: "…so the
  comparison `old.id = auth.uid()` evaluates to NULL/false for postgres-role
  callers — the lockdown branch is never entered."

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:179`
  — `if tg_op = 'UPDATE'` is a dead guard: the trigger binding at line 197
  is `before update on public.profiles`, so `tg_op` is always `'UPDATE'`
  when the function fires. The reference trigger (`user_stores_brand_match`,
  bound to `before insert or update`) checks operations because it serves
  two events; this trigger only serves one. The guard is harmless but
  mildly misleading — a reader might infer the function is also used for
  INSERT or DELETE. Consider removing the `tg_op` check so the body reads:
  "if old.id = auth.uid() and not public.auth_is_super_admin() then …".

- `supabase/tests/auth_can_see_store_brand_scope.test.sql:181` — Arm 5
  updates the JWT via `select set_config(…)` without a preceding
  `set local role` statement. The role is still `authenticated` from arm 4,
  which is the intended state. The behavior is correct, but adding a
  comment "-- role is still authenticated from arm (4)" (one line) would
  make the omission explicit rather than relying on the reader to trace
  back. The architect's M1 minor (super_admin arm tests only the
  foreign-brand store, not both) is deferred to the architect reviewer;
  not restated here.
