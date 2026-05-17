# Security audit for spec 041 — brand-scoped per-store visibility (round-4 final verify)

This file overwrites the round-1, round-2, and round-3 audits. Round-3
flagged 1 Critical (TRUNCATE+INSERT bypass), 1 High (carry-forward), 2
Medium (carry-forward), 6 Low. The dev landed the round-3 fix:

- `revoke truncate on public.profiles from authenticated, anon;` at
  `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:305`.
- pgTAP plan extended 13 → 14 in
  `supabase/tests/auth_can_see_store_brand_scope.test.sql` (arm 14).
- Spec 041 body updated with `### Truncate-path lockdown` sub-section.

## Round-4 summary up front

The round-3 Critical (TRUNCATE+INSERT bypass) is **LIVE-VERIFIED-BLOCKED**.
The REVOKE TRUNCATE is in effect at the grant layer; the brand-admin's
TRUNCATE attempt fails with `permission denied for table profiles`
(SQLSTATE 42501) BEFORE any trigger or RLS policy evaluation. The
attack chain dies at step 1.

**No new escalation paths found.** I aggressively swept every variant
on the brief's checklist (DROP/ALTER/CREATE TRIGGER, COPY TO/FROM,
INSERT ... ON CONFLICT DO UPDATE, INSERT FROM SELECT, user_stores
cross-brand insertion, direct `auth.users` tampering, SECURITY DEFINER
RPC abuse, direct `auth.users.role` update, `set_config` JWT spoofing,
`set role` privilege escalation) plus additional ones (schema-level
CREATE on public/auth, granting privileges to authenticated,
session_replication_role bypass, table-owner ALTER TRIGGER). Every
single path is blocked by a pre-existing or spec-041-introduced
defense.

**Recommendation: spec proceeds to release-coordinator.** The three
"same end-state, different verb" attack paths the security audit
identified across rounds 1, 2, and 3 are now all closed by
complementary defenses (round-1 UPDATE trigger, round-2 DELETE
trigger, round-3 TRUNCATE REVOKE). 14/14 pgTAP arms pass; 26/26
DB test files pass; no new vulnerabilities since round-3.

## Live-verification of round-3 fix

### Step 1: REVOKE TRUNCATE in effect (grant layer)

```
$ docker exec supabase_db_imr-inventory psql -U postgres -c "\dp public.profiles"
 Schema |   Name   | Type  |       Access privileges
--------+----------+-------+-----------------------------
 public | profiles | table | postgres=arwdDxtm/postgres +
        |          |       | anon=arwdxtm/postgres      +     ← lowercase d only (DELETE), NO uppercase D (TRUNCATE)
        |          |       | authenticated=arwdxtm/postgres+  ← lowercase d only (DELETE), NO uppercase D (TRUNCATE)
        |          |       | service_role=arwdDxtm/postgres
```

The privilege strings on `authenticated` and `anon` are `arwdxtm` — no
uppercase `D`. The privilege strings on `postgres` and `service_role`
are `arwdDxtm` (full TRUNCATE retained). Cross-check via
information_schema:

```
$ docker exec ... psql -c "select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'profiles'
   and privilege_type = 'TRUNCATE'"
   grantee    | privilege_type
--------------+----------------
 postgres     | TRUNCATE
 service_role | TRUNCATE
(2 rows)
```

**STATUS: LIVE-VERIFIED-IN-EFFECT.** TRUNCATE on `public.profiles` is
granted only to `postgres` and `service_role`. The brand-admin's
authenticated/anon roles have no TRUNCATE privilege.

### Step 2: Round-3 attack rejected (brand-admin TRUNCATE)

```
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';
truncate table public.profiles;
→ ERROR:  permission denied for table profiles
rollback;
```

Also verified with CASCADE:

```
begin;
set local role authenticated;
set local request.jwt.claims to '{… "role": "admin" …}';
truncate table public.profiles cascade;
→ ERROR:  permission denied for table profiles
rollback;
```

**STATUS: LIVE-VERIFIED-BLOCKED.** The round-3 TRUNCATE+INSERT chain
dies at step 1 with SQLSTATE 42501 before any trigger or RLS policy
fires. CASCADE variant blocked identically.

### Step 3: pgTAP suite passes

```
$ bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql
== supabase/tests/auth_can_see_store_brand_scope.test.sql ==
  PASS supabase/tests/auth_can_see_store_brand_scope.test.sql (14 assertion(s) passed)
✓ 1/1 DB test file(s) passed

$ bash scripts/test-db.sh
… (full sweep)
✓ 26/26 DB test file(s) passed
```

All 14 arms in the spec 041 test (including the new arm 14 for the
round-3 REVOKE) pass. The full 26-file pgTAP suite passes — no
regression in any sibling test.

## Aggressive escalation-path sweep (round-3 brief step 4)

### A. DROP / ALTER / CREATE TRIGGER from authenticated — NOT REACHABLE

```
-- Drop existing trigger
drop trigger profiles_self_delete_lock on public.profiles;
→ ERROR:  must be owner of relation profiles

-- Disable a specific trigger
alter table public.profiles disable trigger profiles_self_brand_lock;
→ ERROR:  must be owner of table profiles

-- Disable ALL triggers (postgres-superuser-only shortcut)
alter table public.profiles disable trigger all;
→ ERROR:  must be owner of table profiles

-- Create a new evil trigger that elevates on update
create or replace function public.escalate() returns trigger language plpgsql as $$ … $$;
→ ERROR:  permission denied for schema public
```

`authenticated` has zero CREATE on `public` (verified via
`has_schema_privilege` — `auth_create: f` for `public`, `auth`, and
`pg_catalog`). Cannot create functions, tables, types, or extensions
to side-load malicious triggers.

### B. COPY TO / COPY FROM — NOT REACHABLE as escalation

```
-- COPY FROM (write)
copy public.profiles (id, role, brand_id) from stdin with (format csv);
→ ERROR:  COPY FROM not supported with row-level security
   HINT:   Use INSERT statements instead.
```

Postgres explicitly refuses `COPY FROM` on RLS-enabled tables. So even
though COPY FROM would fire row-level INSERT triggers (documented
Postgres semantics), the path is foreclosed earlier.

```
-- COPY TO (read)
copy public.profiles to stdout;
→ … returns rows visible under SELECT RLS policy …
```

COPY TO respects RLS. An admin sees all 3 seed profiles because of the
legitimate "Admins can read all profiles" policy (gated on JWT
`app_metadata.role IN ('admin','master')`). A non-admin user
(`profiles.role='user'`) sees only their own row via the "Users can
read own profile" policy. Not a bypass — policy operating as designed.

### C. INSERT ... ON CONFLICT DO UPDATE — UPDATE TRIGGER FIRES, BLOCKED

```
insert into public.profiles (id, name, role, brand_id)
values ('11111111-…', 'Local Admin', 'super_admin', null)
on conflict (id) do update set role = 'super_admin', brand_id = null;
→ ERROR:  brand_id is read-only for self-edits (super_admin only)
   CONTEXT: PL/pgSQL function assert_brand_id_immutable_for_self() …
```

UPSERT's UPDATE branch correctly fires the BEFORE UPDATE trigger.
Also tested with only `role` changing — blocked with `role is read-only
for self-edits`. Defense holds.

### D. INSERT with SELECT FROM another_table — PK COLLISION BLOCKS

```
-- standalone INSERT
insert into public.profiles (id, name, role, brand_id)
values ('11111111-…', 'Reborn', 'super_admin', null);
→ ERROR:  duplicate key value violates unique constraint "profiles_pkey"

-- INSERT FROM SELECT (different syntax, same end-state)
insert into public.profiles (id, name, role, brand_id)
select '11111111-…', 'X', 'super_admin', null from public.stores limit 1;
→ ERROR:  duplicate key value violates unique constraint "profiles_pkey"
```

PK collision still blocks any standalone INSERT, regardless of source
table or SELECT form. Confirms the round-2 architect's analysis: the
attack chain requires step 1 (DELETE or TRUNCATE) to clear the
existing row, and both are now blocked.

### E. user_stores cross-brand INSERT — NOT REACHABLE

```
-- Attempt: brand-admin self-grants a user_stores row for foreign-brand store
insert into public.user_stores (user_id, store_id)
values ('11111111-…', 'b1000001-…');
→ ERROR:  cross-brand user_stores assignment rejected: user brand=2a000000-…, store brand=b1000000-…
   CONTEXT: PL/pgSQL function user_stores_brand_match() line 15 at RAISE
```

The `user_stores_brand_match_trg` BEFORE INSERT trigger from 012a
(`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357-381`)
enforces user.brand_id = store.brand_id. Any cross-brand assignment is
rejected at the row level. Tested also with TRUNCATE+INSERT
(user_stores DOES still have TRUNCATE granted to authenticated, see
**Low** #1 below), confirmed the BEFORE INSERT trigger fires on the
new row regardless and still rejects cross-brand:

```
truncate table public.user_stores cascade;
→ TRUNCATE TABLE        (allowed; no privilege guard on this table)

insert into public.user_stores (user_id, store_id)
values ('11111111-…', 'b1000001-…');
→ ERROR:  cross-brand user_stores assignment rejected: user brand=…, store brand=…
```

So even though user_stores TRUNCATE is grantable, the cross-brand
escalation is closed because the row-level INSERT trigger fires AFTER
TRUNCATE on any new INSERT. The brand-admin's own profile.brand_id
remains brand A (protected by `profiles_self_brand_lock`), so any
user_stores row they try to insert for a foreign-brand store is
trigger-rejected.

### F. Direct `auth.users.raw_app_meta_data` UPDATE — NOT REACHABLE

```
update auth.users set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{role}', '"super_admin"') where id = auth.uid();
→ ERROR:  permission denied for table users
```

`authenticated` and `anon` have zero grants on `auth.users` (verified
via `information_schema.role_table_grants`).

### G. DELETE via SECURITY DEFINER RPC — NOT REACHABLE

Enumerated all 25 SECURITY DEFINER functions in `public` and reviewed
the ones that could plausibly mutate profiles:

- `hard_delete_brand`, `soft_delete_brand`, `restore_brand`,
  `rename_brand`, `preview_brand_cascade` — all gate on
  `auth_is_super_admin()` and READ profiles for blocking-checks but
  do not WRITE profiles. The `hard_delete_brand` function explicitly
  refuses if profiles still belong to the brand (`'Cannot
  hard-delete brand: % profiles still belong'`).
- `copy_brand_catalog` — gates on `auth_is_privileged()`; copies
  recipe/ingredient/category rows, doesn't touch profiles.
- `consume_invitation` — gates on `auth.uid() is not null`; updates
  only `invitations.used = true`. Does NOT mutate profiles.
- `admin_dedupe_recipes`, `admin_dedupe_prep_recipes` — gate on
  `auth_is_privileged()`; touch recipe rows, not profiles.
- `staff_submit_eod`, `staff_log_waste`, `broadcast_notification` —
  staff-side RPCs, no profile mutation.
- `sync_role_to_app_metadata` (trigger function) — mirrors
  `profiles.role` into `auth.users.raw_app_meta_data` AFTER profile
  role updates. Since profile role updates are blocked by
  `profiles_self_brand_lock` (UPDATE trigger), the trigger fan-out
  cannot be reached via self-escalation.
- `user_stores_brand_match` (trigger function) — already discussed
  in §E above.
- The helpers (`auth_is_admin`, `auth_is_privileged`,
  `auth_is_super_admin`, `auth_can_see_brand`, `auth_can_see_store`)
  return boolean only, no mutation.
- The asserts (`assert_brand_id_immutable_for_self`,
  `assert_profile_self_delete_blocked`, `assert_not_last_of_role`)
  are trigger or guard functions, no mutation.

**No SECURITY DEFINER RPC opens a brand-admin path to mutate their
own profile.role or profile.brand_id outside the trigger-protected
direct UPDATE path.**

### H. Direct `update auth.users.role` — NOT REACHABLE

Same as F. `permission denied for table users`. `auth.users.role`
column is also not the privilege-bearing column anyway — that's
`raw_app_meta_data->>'role'`.

### I. `set_config('request.jwt.claims', …)` JWT spoof — NOT EFFECTIVE

```
set local role authenticated;
set local request.jwt.claims to '{… "role": "admin" …}';
-- Try to spoof super_admin via set_config
select set_config('request.jwt.claims', '{… "role": "super_admin" …}', true);
select public.auth_is_super_admin();
→ f
```

`auth_is_super_admin()` reads `profiles.role` server-side (NOT
JWT claims). Spoofing JWT claims via `set_config` does not flip the
helper. The only way to change `auth_is_super_admin()`'s answer is to
mutate `profiles.role` — which is blocked by the trigger stack.

(Note: in real PostgREST traffic, `request.jwt.claims` is set by
PostgREST from the signed JWT. A client cannot forge a JWT without
the JWT secret. The `set_config` test demonstrates that even if a
hypothetical attacker had session-level access to mutate the GUC, the
server-side check is the actual privilege boundary.)

### J. `set role` privilege escalation — NOT REACHABLE in real traffic

`authenticator` (the role PostgREST connects as) has membership in
`anon`, `authenticated`, and `service_role` — and `service_role`
retains TRUNCATE. In theory `set role service_role; truncate
public.profiles;` would succeed. **But this path is not reachable
from a PostgREST request body or RPC argument:**

- PostgREST request handlers parse JSON/REST and construct one SQL
  statement — they don't accept raw SQL.
- RPCs (`/rpc/<name>`) execute a SECURITY DEFINER function whose
  body is fixed at function definition time, not caller-supplied.
- No SECURITY DEFINER function in `public` calls `set role
  service_role` (enumerated all 25 functions, verified via grep on
  the source dump — zero matches).

The `set role` privilege boundary is enforced at the PostgREST and
connection layer, not at the SQL-engine layer. A raw-SQL injection
into a SECDEF function would be a separate generic bug (not 041);
no such injection point exists in the spec-041 surface.

### K. `session_replication_role = 'replica'` trigger bypass — NOT REACHABLE

```
set session_replication_role = 'replica';
→ ERROR:  permission denied to set parameter "session_replication_role"
```

Confirms round-3 finding. Even if reachable, would only bypass
non-system triggers; statement-level RLS still applies.

### L. Grant-yourself-privileges — NOT REACHABLE

```
grant truncate on public.profiles to authenticated;
→ WARNING:  no privileges were granted for "profiles"
```

The brand-admin caller has no grant authority on `public.profiles`
(table owner is `postgres`, only the owner or a role with GRANT
OPTION can re-grant). The WARNING confirms the GRANT is a no-op.

### M. Other paths swept and confirmed not reachable

- `truncate auth.users` — NOT REACHABLE (zero grants on auth.users).
- `alter table public.profiles owner to authenticated` — NOT
  REACHABLE (must be owner).
- `create policy` / `drop policy` on profiles — NOT REACHABLE (must
  be owner).
- `vacuum full public.profiles` (would not bypass anyway) — NOT
  REACHABLE (must be owner).
- `set search_path = …` to shadow `auth_is_super_admin` with a fake
  function — the helpers all `set search_path = public, auth`
  internally, so the caller's search_path is ignored inside the
  SECDEF body. Defense-in-depth holds.

## Critical (BLOCKS merge)

**None.** The round-3 Critical (TRUNCATE+INSERT bypass) is
LIVE-VERIFIED-BLOCKED. No new escalation paths found in the round-4
sweep.

## High (must fix before deploy)

**None new.**

- **Carry-forward from rounds 1-3 (NOT BLOCKING this spec).**
  `supabase/migrations/20260502071736_remote_schema.sql` — "Users can
  update own profile" policy still has no `with check` clause. The
  spec 041 triggers close the highest-impact specific column attacks
  (brand_id, role) — both confirmed blocked in this round's
  live-verify. But the policy itself remains a wide-open self-write
  surface for any column. Status: preserved through rounds 1-4 of
  spec 041; the next security-load-bearing column added to `profiles`
  would silently re-open this hole. No such column exists today.
  Tracked for follow-up spec (add `with check` enumerating writable
  columns, or assert security-load-bearing columns are `not distinct
  from old`).

## Medium

**None new.**

- **Carry-forward (out of scope per release-proposal — NOT BLOCKING).**
  `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:28-31`
  — `order_schedule` WRITE policy still gates only on
  `auth_is_privileged()`, no `auth_can_see_store(store_id)` check.
  Re-verified policy state unchanged:
  ```
  Admins can write order_schedule | * | auth_is_privileged() | auth_is_privileged()
  ```
  Brand-admin can INSERT/UPDATE/DELETE foreign-brand order_schedule
  rows post-spec. Tracked for follow-up spec.

- **Carry-forward (out of scope per release-proposal — NOT BLOCKING).**
  `supabase/migrations/20260502071736_remote_schema.sql` — "Admins
  can update any profile" policy permits brand-A admin to UPDATE any
  brand-B user's profile columns other than `brand_id` / `role`
  (those are blocked by `profiles_self_brand_lock` only on SELF-edits
  — cross-user edits are unblocked by the trigger). Tracked for
  follow-up spec.

## Low

- **NEW (informational, not blocking).** `public.user_stores` retains
  TRUNCATE granted to `authenticated` and `anon` (verified via
  `\dp public.user_stores` — `anon=arwdDxtm`, `authenticated=arwdDxtm`,
  both with uppercase D). The TRUNCATE+INSERT cross-brand escalation
  via user_stores is closed (the BEFORE INSERT trigger
  `user_stores_brand_match_trg` fires on the new row regardless and
  rejects cross-brand). But this leaves a destructive-attack vector:
  any authenticated user can TRUNCATE user_stores and wipe every
  staff-to-store assignment project-wide — a denial-of-service for the
  staff app. Pre-existing, not introduced by spec 041. The same
  destructive-DoS finding from round-3 Low #1 applies (15 other public
  tables also have TRUNCATE on authenticated/anon). Recommended
  follow-up: extend the round-3 REVOKE to all destructive-action-
  sensitive tables in a separate spec. Out of scope for 041.

- **NEW (informational, not blocking).** `authenticator` (the role
  PostgREST connects as) has `MEMBER` of `service_role`, and
  `service_role` retains TRUNCATE on `public.profiles`. **This is NOT
  exploitable from real PostgREST traffic** (see §J above for the
  reasoning) — but it is worth noting that if a future SECURITY
  DEFINER function were added that performed `set role service_role`
  inside its body (e.g., for an intentional privileged operation), it
  would unintentionally re-open the TRUNCATE path. Recommended
  defense-in-depth: do NOT add such a function without an explicit
  `assert_not_truncating_profiles` guard inside it. Tracked.

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:305`
  — `revoke truncate on public.profiles from authenticated, anon`
  is idempotent (re-running on a role with no TRUNCATE is a no-op).
  Migration is safe to re-apply. Verified.

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:75-84`
  — Pre-flight DO block uses `raise exception` (not warning). Aligns
  with architect's spec §0 Q4 contract. Carried from round-1.

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:88-108`
  — `auth_can_see_store` retains `language sql stable security
  definer set search_path = public, auth`. All references inside the
  body are fully qualified. No untrusted function calls. Safe.

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:122-123,201-202,262-263`
  — `comment on function` clauses on all three new functions
  (`auth_can_see_store`, `assert_brand_id_immutable_for_self`,
  `assert_profile_self_delete_blocked`) correctly document semantics
  and reference spec 041. Maintenance-friendly.

- **All other paths from rounds 1-3 confirmed re-verified.** Direct
  `auth.users` tampering NOT REACHABLE; `session_replication_role`
  bypass NOT REACHABLE; `alter table … disable trigger` NOT
  REACHABLE; new function grant audience harmless.

## Dependencies

`npm audit --audit-level=high` reports the same backlog as round-3:
- 1 high: `@xmldom/xmldom` (Multiple Parsing Issues, Misinterpretation)
- 5 moderate: `dompurify` (3 advisories), `postcss` (1 advisory)
- 5 low: misc

No package.json changes between round-3 and round-4 (`git log --oneline
-5 -- package.json` last touched at spec 027 — six specs ago). Backlog
is the same one carry-forward through specs 037, 038, 039, 040, 041.
Not 041-specific, not blocking.

## Summary

**Round-3 fix LIVE-VERIFIED-BLOCKED.** The round-3 Critical
(TRUNCATE+INSERT chain) is now closed. The REVOKE TRUNCATE is in
effect at the grant layer; the brand-admin's TRUNCATE attempt fails
with `permission denied for table profiles` (SQLSTATE 42501) before
any trigger or RLS policy fires. The pgTAP arm 14 (added in round-3)
asserts this with both SQLSTATE and exact-message pinning.

**No new escalation paths found.** The round-4 sweep exhaustively
checked DROP/ALTER/CREATE TRIGGER, COPY TO/FROM, INSERT ... ON
CONFLICT DO UPDATE, INSERT FROM SELECT, user_stores cross-brand
INSERT (including TRUNCATE-then-INSERT bypass attempt — also closed
by the INSERT trigger), direct `auth.users` tampering, all 25 public
SECURITY DEFINER functions, direct `auth.users.role` update,
`set_config` JWT spoofing, `set role` privilege escalation,
schema-level CREATE on public/auth, grant-yourself-privileges,
`session_replication_role` bypass, and table-owner ALTER TRIGGER.
**Every single path is blocked** by a pre-existing or
spec-041-introduced defense.

**The three "same end-state, different verb" attack paths the
security audit identified across rounds 1, 2, and 3 are now all
closed by complementary defenses:**

| Round | Verb     | Defense                                                                                            |
|-------|----------|----------------------------------------------------------------------------------------------------|
| 1     | UPDATE   | `profiles_self_brand_lock` BEFORE UPDATE trigger (assert_brand_id_immutable_for_self)              |
| 2     | DELETE   | `profiles_self_delete_lock` BEFORE DELETE trigger (assert_profile_self_delete_blocked)             |
| 3     | TRUNCATE | `revoke truncate on public.profiles from authenticated, anon` (closes at the grant layer)          |

Layered defense: triggers for surgical verb-bound blocking on UPDATE
and DELETE; REVOKE for the privilege-layer block on TRUNCATE (the
verb that doesn't fire row-level triggers).

**Carry-forward findings** (`order_schedule` WRITE policy missing
`auth_can_see_store`, "Admins can update any profile" no with-check,
"Users can update own profile" no with-check) remain unchanged and
out-of-scope per the release-proposal carve-outs. Not blocking spec
041. Tracked for follow-up specs.

**Spec 041 can proceed to release-coordinator.** Round-3 Critical
LIVE-VERIFIED-BLOCKED; no new Critical or High introduced in round-4.
14/14 spec-041 pgTAP arms pass; 26/26 full DB test suite passes;
dependency backlog unchanged.

## Handoff
next_agent: NONE
prompt: Security audit round-4 final verify complete. Round-3 Critical (TRUNCATE+INSERT bypass) is LIVE-VERIFIED-BLOCKED — the REVOKE TRUNCATE on public.profiles from authenticated, anon is in effect at the grant layer (verified via \dp output showing arwdxtm without uppercase D for authenticated/anon, while postgres/service_role retain arwdDxtm). Brand-admin TRUNCATE attack against the round-4 build fails with `permission denied for table profiles` (SQLSTATE 42501) before any trigger fires. CASCADE variant blocked identically. Aggressive sweep across 13 additional escalation-path categories (DROP/ALTER/CREATE TRIGGER, COPY TO/FROM, INSERT ON CONFLICT DO UPDATE, INSERT FROM SELECT, user_stores cross-brand INSERT including TRUNCATE-then-INSERT variant, direct auth.users tampering, all 25 public SECDEF RPCs reviewed for profile mutation, direct auth.users.role update, set_config JWT spoofing, set role privilege escalation, schema-level CREATE, grant-yourself-privileges, session_replication_role bypass) found NO new privilege-escalation paths — every single path closed by pre-existing or spec-041-introduced defenses. The three "same end-state, different verb" attack paths from rounds 1/2/3 are now all closed by complementary defenses (UPDATE trigger / DELETE trigger / TRUNCATE REVOKE). 14/14 spec-041 pgTAP arms pass; 26/26 full DB suite passes. Dependency backlog unchanged from round-3 (1 high xmldom, 5 moderate dompurify+postcss, 5 low; no package.json changes since spec 027). Two new informational Lows (user_stores TRUNCATE still grantable but not a privilege-escalation path due to BEFORE INSERT trigger; authenticator -> service_role -> TRUNCATE path exists at the role-membership layer but is not reachable from PostgREST request bodies or any current SECDEF function). Carry-forward Highs/Mediums (order_schedule WRITE, "Admins can update any profile", "Users can update own profile" no with-check) remain unchanged and out-of-scope per release-proposal carve-outs. 0 Critical, 0 High new (1 High carry-forward NOT BLOCKING), 0 Medium new (2 Medium carry-forward NOT BLOCKING), 8 Low. Spec 041 cleared for release-coordinator.
payload_paths:
  - specs/041-brand-scoped-store-visibility/reviews/security-auditor.md
