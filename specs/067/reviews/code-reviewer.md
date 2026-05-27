## Code review for spec 067

### Critical

None.

### Should-fix

- `supabase/tests/compute_menu_capacity.test.sql:27–30` — File header comment still describes the old arm numbering from spec 060 and still references the anti-pattern that was deleted. Lines 27–30 read:
  ```
  -- (10) RLS gate: a user with no user_stores grant ...
  -- (11) Anon revoke: SET ROLE anon → permission denied.
  -- (12) Perf: < 100ms on the seed for one of the 4 seed stores.
  ```
  The body now has (9) = RLS gate and (10) = anon revoke via catalog query; there is no perf arm. The header should be updated to match:
  ```
  --  (9) RLS gate: a user with no user_stores grant for the target
  --      store raises SQLSTATE 42501.
  -- (10) Anon revoke: catalog-state assertion via has_function_privilege
  --      (see spec 067 / reports_anon_revoke.test.sql implementation note).
  ```
  The "(11) Anon revoke: SET ROLE anon → permission denied." line is particularly misleading because it describes the exact anti-pattern spec 067 is removing; a future author reading the header could believe the test still exercises runtime role-switching. The "(12) Perf" line describes an arm that never existed in the actual test body and should simply be dropped.

- `supabase/tests/reports_anon_revoke.test.sql:147` — Arm 13's TAP description string (`'(13) anon: REVOKE EXECUTE on compute_menu_capacity(uuid) is intact'`) uses a different style from the 12 existing arms in the same file. Every other arm uses the pattern `'anon lacks EXECUTE on <function_name>'` (no ordinal prefix, lowercase verb phrase). Arm 13 uses an ordinal prefix and a different verb phrase ("REVOKE EXECUTE ... is intact"). The inconsistency will create visual noise in TAP output and in any future diffs that modify this file. The description should follow the established style, e.g.: `'anon lacks EXECUTE on compute_menu_capacity'`.

### Nits

- `supabase/tests/compute_menu_capacity.test.sql:437–444` — The arm (10) comment block (lines 437–444) references `reports_anon_revoke.test.sql` by line numbers (`lines 31-42`). Line numbers in a sibling file are fragile — future additions to `reports_anon_revoke.test.sql` could shift that block without this cross-reference being updated. The spec's own design suggests referencing the implementation note by spec number rather than line: "See the spec 045 implementation note in `supabase/tests/reports_anon_revoke.test.sql`." is more stable.

- `supabase/tests/reports_anon_revoke.test.sql:141–144` — Arm 13's section header comment says "Belt-and-suspenders coverage alongside arm 10 of `supabase/tests/compute_menu_capacity.test.sql` (which uses the same catalog pattern; see spec 067)." The phrase "arm 10" is correct but if compute_menu_capacity.test.sql is ever renumbered the cross-reference will be stale. Consider "alongside the anon-revoke arm in `compute_menu_capacity.test.sql`" to avoid binding on the ordinal.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 2 Nits.
payload_paths:
  - specs/067/reviews/code-reviewer.md
