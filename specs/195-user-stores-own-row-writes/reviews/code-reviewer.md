## Code review for spec 195

Scope: `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`, `supabase/tests/user_stores_own_row_writes.test.sql`, the arm (9) and comment edits in `supabase/tests/legacy_permissive_policy_dropout.test.sql`, and the spec 164 L160 correction.

Limits of this review: I had no shell, so I could not run `git diff` or the pgTAP suite. For `legacy_permissive_policy_dropout.test.sql` I read the changed regions in place (header L35-45, L104-117, arms 8-11 at L445-560) and did not see a before/after diff. I did not run the mutation checks (M1, M5, M6) or the fail-closed hand test, so I can't confirm the spec's `## Files changed` claims about them.

Nothing here touches `src/`, `app.json`, legacy files, `supabase.from` calls, or realtime. The project-specific checklist has no hits.

### Critical
None.

### Should-fix
- `specs/195-user-stores-own-row-writes.md` D-1 and D-8 (around L285-288, plus any later `…160000` mentions) — The spec's backend design names the migration `20261109160000_user_stores_drop_own_row_writes.sql`, but the file on disk is `20261109195000_…`. The migration header and the prod-apply `insert into schema_migrations` snippet use `195000`. The AC-R2 text is the contract for the prod apply, so a stale version string there is a real mis-apply risk. Update the spec to `20261109195000`, or add a one-line "built as 195000" note in `## Files changed`.
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql:2-3,41` — Two comments in a permanent migration point at things that won't survive:
  - "Renumbered from spec 190" is session-history noise, and it is confusing because a different spec 190 (`po-number-sequence`) is on disk. Drop it. The spec file already records the renumber.
  - "(spec 064 gate, project MEMORY)" cites the user's private memory notes. A future reader of the repo can't open them. Say what the step is: apply via `execute_sql`, then insert the exact version into `schema_migrations`. The gate is `db-migrations-applied.yml`.
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql:72-73` — The `comment on policy` text enumerates the remaining write paths ("admin policy, register_invited_profile(), service-role edge functions"). That string lives in `pg_description` and will go stale as soon as a new writer is added, and nothing tests it. Keep it to the durable fact, for example "own-row READ only; no own-row write policy by design (spec 195)". Leave the writer inventory in the migration header, which is already dated and reviewable.
- `supabase/tests/user_stores_own_row_writes.test.sql:198-208` (T3) — Two points:
  - The comment says "md5 of qual and of with_check: b05a4d44…". That reads as one hash covering two values. State what was hashed (the two are textually identical, so one md5 covers both) or drop the hash.
  - The pinned literal embeds PG's pretty-printed deparse, including `\n   FROM` indentation. It will break on a Postgres deparse change even though the policy is unchanged, and the failure message won't say why. This is acceptable because "byte-identical" is the AC. Add a one-line "if this fails after a PG major bump with no policy edit, re-capture from `pg_policies`" so the next person doesn't treat it as a security regression.

### Nits
- `supabase/tests/user_stores_own_row_writes.test.sql` (about 10 sites) — The `set local role authenticated; select set_config('request.jwt.claims', jsonb_build_object('sub', …, 'role', 'authenticated', 'app_metadata', jsonb_build_object('role', …))::text, true);` block is repeated nine times. It matches the sibling file's style, so this is not a violation. A small local helper such as `pg_temp.as_caller(uuid, text)` would cut about 60 lines and make each arm's "who is calling" obvious. Optional.
- `supabase/tests/user_stores_own_row_writes.test.sql:416-427` (T14 setup) — The manager's claims are set without `set local role authenticated`, so the arm silently relies on the role left over from the T12/T13 demoted block. This works, but a reorder would break it with an unobvious failure. Add a one-line comment ("role is still authenticated from above") or set the role explicitly.
- `supabase/tests/user_stores_own_row_writes.test.sql:360-362` — `exception when others then v_n1 := -1` swallows every error, including a typo in the test SQL, and reports it as "-1". The reason is explained in the header. Narrowing to `when sqlstate 'P0001' or sqlstate '42501'` would keep the mutation-safety without hiding a broken test.
- `supabase/tests/user_stores_own_row_writes.test.sql:1-70` — The header is long but accurate. "Twenty-three arms" is stated in both the header and `plan(23)`. That is two places to update if an arm is added. Fine as is.
- `supabase/tests/legacy_permissive_policy_dropout.test.sql:109-111` — The reworded comment "whose own-row INSERT arm (9) asserts is refused" is ungrammatical. Suggest: "Distinct from the seed manager, whose own-row INSERT is refused in arm (9)."
- `supabase/tests/legacy_permissive_policy_dropout.test.sql:480` — `(spec 195 "Every writer")` cites a spec section by name. It is fine now, but cite the spec number only and drop the section title in case the spec is reorganised.
- `supabase/tests/legacy_permissive_policy_dropout.test.sql:541-542` — The sentence "there is no own-row write arm (spec 195). Pre-051 the wide ALL policy…" is fused into one run-on clause. Split it.
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql:1-61` — The header is about 60 lines (policy diff, rollback, prod-apply steps). It is thorough and matches the 164/170/187 house style, but the PROD-APPLY and ROLLBACK blocks duplicate spec D-8. If D-8 changes, this header goes stale. Consider keeping only the rollback SQL here and pointing to the spec for the apply procedure.
- (out-of-scope) `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql:127-128` — The "still brand-scoped" check is `position('auth_can_see_brand' in …)`. A string search is cheap and fine as a tripwire, but it would also pass if the function name appeared in a comment or a dead branch. The T3 pin in the test file is the real guard, so no change is needed.

### What looks good
- The fail-closed DO block runs inside the same transaction as the drop. The `195:` prefixes and the messages that include found counts, names and quals are clear and debuggable.
- The test file pins the RLS message text, not just SQLSTATE 42501. That is what separates an RLS refusal from a grant revoke.
- T8 versus T12 correctly separates the trigger layer (P0001) from the RLS layer (42501), and the comments explain why.
- Fixtures use `''` token columns, per the project memory.
- Fixture ids are hermetic (`195`-marked) and the file rolls back.
- The arm (9) rewrite keeps `plan(13)` unchanged and keeps arm (10)'s role and claim setup working.
- The spec 164 correction is appended below L159 without rewriting the original line, as AC-16 requires.
