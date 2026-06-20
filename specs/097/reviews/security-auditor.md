# Security audit for spec 097

Scope: the explicit-grant migration `supabase/migrations/20260618000000_public_grants_explicit.sql`,
its regression probe `supabase/tests/public_grants_explicit.test.sql`, and the
Track-2 CLI pin in `.github/workflows/test.yml`. This is a grant-layer migration
whose security crux is that it must NOT re-open two deliberate, pre-existing
table-level REVOKEs (spec-041 `profiles` TRUNCATE anti-escalation; spec-093 audit
table lock) and must NOT weaken RLS. Every crux question is answered below with
file:line evidence.

Verdict: **no Critical, no High, no Medium. One Low (informational).** The
corrected role-split posture is sound, durable, and complete. The migration is
safe to advance.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `supabase/migrations/20260618000000_public_grants_explicit.sql:161-162` —
  Informational, not a defect. The audit-table re-lock REVOKE lists the six
  privileges (`select, insert, update, delete, references, trigger`) rather than
  `revoke all`. This is correct and arguably superior (it revokes exactly the set
  the broad grant on line 145-146 granted, and cannot accidentally touch a grant
  it didn't create). It does differ verbatim from the source lock at
  `20260602120000_spec093_case_qty_backfill.sql:68` (`revoke all ... from anon,
  authenticated`). The end state is identical because the broad grant never
  granted TRUNCATE to those roles, so "revoke the six" and "revoke all" leave the
  same zero-privilege ACL for anon/authenticated. The probe's negative arm (6a/6b)
  asserts SELECT is absent, pinning the result. No action required; noted only so
  a future reader doesn't mistake the list-vs-`all` difference for a gap.

---

## Answers to the five security-crux questions

### Q1 — Does omitting TRUNCATE durably preserve the spec-041 anti-escalation Critical? YES.

- **Existing tables.** `:145-146` grants anon/authenticated exactly
  `select, insert, update, delete, references, trigger` — TRUNCATE is omitted. The
  spec-041 lock (`20260517040000_auth_can_see_store_brand_scope.sql:305`,
  `revoke truncate on public.profiles from authenticated, anon;`) is preserved AT
  THE SOURCE: this grant can never re-add TRUNCATE regardless of migration
  ordering, because TRUNCATE is never in the grant list.
- **Future tables (the durability half).** `:187-189` (the
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... on tables to anon, authenticated`)
  uses the SAME six-privilege no-TRUNCATE list. So a future `profiles`-like table
  is born without anon/authenticated TRUNCATE — the escalation class is closed by
  construction, not just for `profiles`. This is the key durability point and it
  is correctly implemented.
- **No other re-grant path.** Re-grepped all table-level REVOKE/GRANT to
  anon/authenticated across `supabase/migrations/`. The only `GRANT ... TO
  anon/authenticated` of TRUNCATE-bearing scope in the whole repo would be a
  `GRANT ALL` — and the migration emits `GRANT ALL ON ALL TABLES` only to
  `service_role` (`:153`, `:193`), never to anon/authenticated. There is no second
  path that re-arms TRUNCATE for those two roles.
- **service_role retaining TRUNCATE is safe.** `service_role` is the
  backend/service-role key; PostgREST request sessions run as `anon` (no JWT) or
  `authenticated` (end-user JWT), never as `service_role`. The service-role key is
  held only by edge functions / trusted backend (`Deno.env.get` server-side) and
  is never shipped to a client (no `EXPO_PUBLIC_*` exposure — confirmed nothing in
  this change touches client env). So an untrusted PostgREST caller cannot act as
  `service_role`, and `service_role` retaining TRUNCATE does not reach the
  TRUNCATE+INSERT escalation vector, which required a brand-admin acting through
  the `authenticated` role. The spec-041 migration comment (`:291-294`) states the
  same: "service_role retains TRUNCATE ... migrations and seed flows that run
  under service_role or the postgres superuser are unaffected."

The probe pins this exactly: arm 5a/5b assert
`not has_table_privilege('{authenticated,anon}', 'public.profiles', 'TRUNCATE')`,
and 5c asserts `has_table_privilege('service_role', ..., 'TRUNCATE')` is true.
The developer's meta-test (spec "Local validation": re-applying the flawed
`grant all ... to anon, authenticated` turned 5a/5b red) confirms the arm
genuinely catches a regression rather than passing vacuously.

### Q2 — Is the audit-table re-lock ordering correct and complete? YES.

- **Ordering.** The broad anon/authenticated table grant is `:145-146`; the
  targeted re-lock `revoke ... on public.spec093_case_qty_backfill_audit from
  anon, authenticated` is `:161-162` — strictly AFTER the grant in the same file.
  Within a single migration the later statement wins, so the audit table ends with
  the grant removed for those two roles. Correct.
- **service_role retains its audit-table grant.** The re-lock targets only
  `anon, authenticated` (`:162`). The `grant all on all tables ... to service_role`
  (`:153`) is never revoked, so service_role keeps SELECT/etc on the audit table —
  matching the spec-093 source posture (`20260602120000:68` revoked only
  anon/authenticated). Probe arm 6c asserts `has_table_privilege('service_role',
  ..., 'SELECT')` is true, pinning this asymmetry.
- **Completeness of the result.** Net ACL for anon/authenticated on the audit
  table = no table privileges, identical to the spec-093 source intent. Arm 6a/6b
  assert SELECT is absent for both roles.

### Q3 — Does restoring the broad table grant expose any RLS-locked table? NO.

The grant is the OUTER gate; RLS is the INNER gate; both must pass, and a grant
does NOT bypass RLS. Verified that the two named tables are RLS-enabled with NO
permissive policy, so the restored grant exposes zero rows:

- `public.username_resolve_rate_limit` —
  `20260607130000_username_resolve_rate_limit.sql:80` enables RLS; grep for any
  policy on this table across all migrations returns NONE. Its own comment
  (`:76-79`) states "RLS on, no permissive policy ... anon/authenticated are
  blocked." RLS-on / no-policy = deny-all to anon/authenticated.
- `public._edge_auth` — `20260424211733_security_fixes.sql:144` enables RLS; grep
  for any policy on this table returns NONE. This table stores the cron bearer
  secret (`:146-148`); it stays deny-all to anon/authenticated by RLS even with the
  grant restored.

Both correctly stay OFF the probe allowlist (Category B — "has grant but
RLS-unreachable"). The probe's positive sentinel asserts the grant IS present on
them, faithfully pinning the historical "grant present != row-reachable" posture.
This is the right call: allowlisting them would have stopped asserting their
grant and let a future grant-strand slip by. The secret in `_edge_auth` is
protected by RLS, not by grant absence, and that posture is unchanged by this
migration.

### Q4 — Does the migration touch any RLS policy? NO.

grep over `20260618000000_public_grants_explicit.sql` for `create policy` /
`alter policy` / `drop policy` / `enable row level security` / `disable row` /
`row level security` returns nothing. The migration is grants + default-privileges
only. AC line 115-117 and out-of-scope line 145-153 are satisfied. The spec-053
`permissive_policy_lint.test.sql` invariant is untouched (no policy added).

### Q5 — Any OTHER table-level REVOKEs the broad grant would re-open? NO — exactly two, both handled.

Ran `grep -rniE "revoke .* on .* from .*(anon|authenticated)"
supabase/migrations/` and subtracted the `on function ...` / EXECUTE / routine
lines. The COMPLETE set of TABLE-level REVOKEs from anon/authenticated is exactly
two:

1. `20260517040000_auth_can_see_store_brand_scope.sql:305` — `revoke truncate on
   public.profiles from authenticated, anon;` — handled by OMITTING TRUNCATE from
   the broad grant (Q1).
2. `20260602120000_spec093_case_qty_backfill.sql:68` — `revoke all on
   public.spec093_case_qty_backfill_audit from anon, authenticated;` — handled by
   the targeted re-lock REVOKE after the broad grant (Q2).

Additional checks:
- **No table-level `REVOKE ... FROM public`.** `anon`/`authenticated` inherit the
  `public` group's grants, so a table-level revoke from `public` would also need
  preserving. grep for `revoke ... on ... from public` (minus EXECUTE/routine)
  returns ZERO matches — there is no such table-level revoke to re-open.
- **Routine EXECUTE REVOKEs are correctly left alone.** ~15 migrations do
  `revoke execute on function ... from public, anon[, authenticated]` (specs
  016/061/095: staff RPCs, all `report_run*` RPCs, `check_username_resolve_rate_
  limit`, `demote_profile_to_user`, `consume_invitation`, `copy_*`, admin RPCs,
  etc.). The migration emits NO retroactive `GRANT ... ON ALL ROUTINES` — confirmed
  the only routine grant is the FUTURE-objects `ALTER DEFAULT PRIVILEGES ... on
  functions` (`:203-204`), which never touches the existing hardened RPCs. So none
  of those EXECUTE locks are re-opened. This is the correct approach-7(a) posture
  and the probe deliberately asserts table privileges only (never routine EXECUTE
  for anon/authenticated), keeping probe and migration aligned.

### Additional security observations (no findings)

- **`seed.sql` carries no grant/role setup** — confirmed (the single grep match
  is a comment header for store-access data rows, not a GRANT statement). No
  conflict or duplicate-grant interaction.
- **CI pin** — `.github/workflows/test.yml:139` pins
  `supabase/setup-cli@v1` to a fixed `2.106.0` (off the floating `latest` that
  caused the silent drift), with an accurate comment block (`:127-138`). Fixed pin
  is the lower-risk posture; a future bump is a deliberate one-line PR. No secret
  is introduced or logged by the workflow change. Low-risk and in scope, as the
  prompt notes.
- **`ALTER DEFAULT PRIVILEGES FOR ROLE postgres`** (`:187`, `:192`, `:196`, `:203`)
  is scoped to the role that owns future objects (migrations run as `postgres`),
  so the no-TRUNCATE future-table baseline actually fires. Probe arm 4 doubles as
  a live proof of this inheritance.

### Dependencies
no package.json changes — `npm audit` skipped (confirmed `git status` shows no
`package.json` / lockfile modification).
