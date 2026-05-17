# Security audit for spec 042 (round-4 final)

## Audit summary

Live-verified all three carry-forward findings from Spec 041's security audit
plus the Row J trigger broadening. Empirical verification was run against the
local Supabase stack with migration `20260517050000_rls_hardening_followups`
applied and confirmed via `supabase_migrations.schema_migrations`. All 27 pgTAP
files pass (15/15 for the new spec-042 plan + 14/14 for the spec-041 plan,
zero regressions).

The SECURITY INVOKER swap on `public.assert_brand_id_immutable_for_self` is
empirically correct: `current_user='authenticated'` resolves inside the trigger
body for PostgREST-routed callers, the allowlist fires the role-immutability
branch, and `auth_is_super_admin()` continues to read profiles reliably under
its own SECURITY DEFINER mode. No new escalation vector introduced.

The hostile-context discriminator
`current_user in ('authenticated','anon')` is the correct shape — `anon` cannot
issue write-paths to profiles in any PostgREST flow because the relevant
policies require either `auth_is_privileged()` (false for anon) or
`id=auth.uid()` (anon's `auth.uid()` is NULL); both fail.

### Critical (BLOCKS merge)

_None._ All three carry-forward findings are closed. Row J is closed. No new
critical vector observed.

### High (must fix before deploy)

_None._

### Medium

- `supabase/migrations/20260502071736_remote_schema.sql:381-386` — **"Admins
  can read all profiles" is still permissive across brands.** A brand-A admin
  can issue `GET /rest/v1/profiles?select=*` and enumerate every profile in
  every brand (name, role, email-derivable id, brand membership). The WRITE
  path is now closed by spec 042; the READ path is not. Spec 042 explicitly
  declares this out of scope (§"Out of scope" + Risk #3). Carry-forward to a
  follow-up sweep spec.
- `supabase/migrations/20260502071736_remote_schema.sql:372-377` — **"Admins
  can delete profiles" is still permissive across brands.** A brand-A admin
  can `DELETE /rest/v1/profiles?id=eq.<foreign>` and remove a brand-B profile
  row. Live-verified — see Attack 12 below. The `profiles_self_delete_lock`
  trigger only catches self-DELETE; cross-brand DELETE remains. The
  `assert_not_last_of_role` guard (spec 031) is called only by the
  `delete-user` edge function via RPC, not by the policy. Spec 042 explicitly
  declares this out of scope (Risk #4). Carry-forward to a follow-up sweep
  spec. Same severity as the READ gap above.

### Low

- `supabase/migrations/20260502071736_remote_schema.sql:404-414` — **"Anyone
  can insert own profile or admin can insert any" admin arm is brand-blind.**
  A brand-A admin can INSERT a profiles row with `brand_id=<foreign-brand>`
  and `role='super_admin'`, but the FK constraint `profiles_id_fkey →
  auth.users.id` operationally blocks the chain unless the attacker also has
  service_role access to provision an `auth.users` row first. Live-verified
  (Attacks 13 + 14 below) — INSERT without auth.users row fails with SQLSTATE
  `23503`, INSERT with id=self fails with PK collision (`23505`), and the
  spec-041 self-DELETE / TRUNCATE locks close the "delete first then
  re-INSERT" chain. Spec 042 explicitly declares this out of scope (Risk #5).
  Operationally inert; documented.
- `supabase/migrations/20260517050000_rls_hardening_followups.sql:248` —
  **`comment on function` includes the phrase "in hostile contexts (current_user
  in authenticated, anon)" without the SQL-syntax quotes around the role
  names.** This is a doc-string nitpick, not a security finding — the function
  body uses the correct `current_user in ('authenticated', 'anon')` shape. The
  comment is purely informational and reads slightly ambiguous; future
  reviewers should consult the function body, not the comment, for the literal
  allowlist.

### Dependencies

`package.json` was not modified by this spec; `npm audit --audit-level=high`
shows 1 high (`@xmldom/xmldom` — DoS + XML injection) and a moderate
backlog (postcss XSS, dompurify FORBID_TAGS bypass, jest-expo transitive
DoS). All findings are carry-forward from spec 037+ and explicitly
declared out of scope by spec 042 §"Out of scope" line 200-201. Not a
spec-042 blocker.

## Live-verification probe results

All probes run as 2026-05-17 against `supabase_db_imr-inventory` with
migration 20260517050000 confirmed applied.

### Spec assertion 1 — `order_schedule` WRITE policy

```
set local role authenticated;
set request.jwt.claims = { sub: '11111111-...', role: 'authenticated', app_metadata.role: 'admin' };
insert into public.order_schedule (store_id=<foreign-brand-store>, day_of_week='monday', ...);
```

Result: **PASS** — SQLSTATE `42501` "new row violates row-level security policy
for table order_schedule". Cross-brand admin INSERT correctly rejected by the
WITH CHECK clause `auth_is_privileged() AND auth_can_see_store(store_id)`.

### Spec assertion 2 — "Admins can update any profile" cross-brand

```
set local role authenticated;
set request.jwt.claims = { sub: '11111111-...', role: 'authenticated', app_metadata.role: 'admin' };
update public.profiles set name='Tampered cross-brand' where id='<brand-B-target>';
```

Result: **PASS** — UPDATE silently affects 0 rows (Postgres RLS USING
rejection). Verified that target's name was NOT modified.

### Spec assertion 3 — "Users can update own profile" WITH CHECK row-key forgery

```
set local role authenticated;
set request.jwt.claims = { sub: '22222222-...', role: 'authenticated', app_metadata.role: 'user' };
update public.profiles set id='<other-user-id>' where id='22222222-...';
```

Result: **PASS** — SQLSTATE `42501` "new row violates row-level security policy
for table profiles". The new WITH CHECK clause `id = auth.uid()` correctly
blocks post-write row-key forgery on BOTH the user-self policy AND the admin
policy's self-arm.

### Row J attack — brand-A admin promoting same-brand user to super_admin

```
set local role authenticated;
set request.jwt.claims = { sub: '11111111-...', role: 'authenticated', app_metadata.role: 'admin' };
update public.profiles set role='super_admin' where id='<same-brand-target>';
```

Result: **PASS** — SQLSTATE `P0001` "role changes require super_admin". The
SECURITY INVOKER trigger body's `current_user in ('authenticated','anon')`
allowlist correctly fires the cross-user role-immutability branch.

### Trigger inspection

`pg_proc.prosecdef = f` for `public.assert_brand_id_immutable_for_self` —
confirmed SECURITY INVOKER as per round-4 design. Inner helpers
(`auth_is_super_admin`, `auth_can_see_brand`, `auth.uid`) remain
SECURITY DEFINER and continue to read profiles correctly under postgres
identity.

### Aggressive sweep — new escalation vectors

| # | Attack | Result | Notes |
|---|--------|--------|-------|
| 1 | anon role w/ no JWT attempting UPDATE | PASS — RLS rejects at USING (0 rows) | anon's `auth.uid()=NULL` fails self-arm; no admin arm for anon |
| 2 | brand-A admin demoting master to user | PASS — `P0001 role changes require super_admin` | Trigger fires correctly cross-user |
| 3 | brand-A admin promoting user to admin | PASS — `P0001 role changes require super_admin` | Trigger blocks lateral elevation |
| 4 | brand-A admin promoting user to master | PASS — `P0001 role changes require super_admin` | Trigger blocks lateral elevation |
| 5 | brand-A admin self-promote to super_admin | PASS — `P0001 role is read-only for self-edits` | Spec 041 self-edit branch holds |
| 6 | brand-A admin self brand_id mutation | PASS — `P0001 brand_id is read-only for self-edits` | Spec 041 self-edit branch holds |
| 7 | service_role direct UPDATE on role | NOTED — succeeds by design | service_role bypasses RLS + trigger allowlist excludes it; spec Risk #10 |
| 8 | authenticated → SET ROLE postgres | BLOCKED via authenticator session | Local psql test misleading; PostgREST flows use `authenticator` session role which cannot SET ROLE postgres |
| 9 | authenticated → SET ROLE supabase_admin | BLOCKED — `42501 permission denied` | Cannot escalate to admin Postgres role |
| 10 | authenticated TRUNCATE profiles | PASS — `42501 permission denied for table profiles` | Spec 041 round-3 REVOKE TRUNCATE holds |
| 11 | brand-A admin no-op role with name change | PASS — admit | Trigger uses `is distinct from`, no-op role doesn't fire branch |
| 12 | brand-A admin DELETE foreign-brand profile | NOTED — succeeds (Medium finding above) | Out of scope per spec Risk #4 |
| 13 | brand-A admin INSERT foreign-brand profile | NOTED — succeeds when auth.users pre-exists | Out of scope per spec Risk #5; FK to auth.users blocks if no pre-existing user |
| 14 | brand-A admin INSERT profile w/ no auth.users | BLOCKED — `23503 FK constraint violation` | Operationally inert per spec Risk #5 |
| 15 | postgres direct DB w/ admin JWT | NOTED — bypasses trigger | By design; direct DB access is fully trusted |
| 16 | Self-INSERT with role=super_admin after self-DELETE | BLOCKED — `P0001 self-delete not permitted` | Spec 041 round-2 lockdown holds |
| 17 | Self-INSERT with role=super_admin after TRUNCATE | BLOCKED — `42501 permission denied` | Spec 041 round-3 REVOKE holds |

### SECURITY DEFINER RPC walk

Reviewed all 24 SECURITY DEFINER functions in `public` schema. None mutate
`profiles.role` or `profiles.brand_id`:

- `admin_db_inspector_probe` / `admin_dedupe_recipes` / `admin_dedupe_prep_recipes`
  — gated `auth_is_privileged()`, no profiles mutation.
- `assert_not_last_of_role` — read-only count check, no mutation.
- `assert_profile_self_delete_blocked` / `assert_brand_id_immutable_for_self`
  / `sync_role_to_app_metadata` / `user_stores_brand_match` — internal
  trigger functions, no caller-controlled write.
- `auth_*` — boolean predicates.
- `broadcast_notification` / `consume_invitation` / `get_pending_invitation`
  — no profiles mutation.
- `copy_brand_catalog` — gated `auth_is_privileged() AND auth_can_see_brand`
  for both source and target. Operates on `catalog_ingredients`, not profiles.
- `hard_delete_brand` / `soft_delete_brand` / `restore_brand` / `rename_brand`
  / `preview_brand_cascade` — super_admin gated (`auth_is_super_admin`). Read
  profile counts for pre-flight; do not mutate profile rows.
- `staff_submit_eod` / `staff_log_waste` — staff app surface, no profile
  mutation.

The SECURITY DEFINER caveat in §13 ("A SECURITY DEFINER RPC that runs as
`postgres` and forwards a caller-controlled `new.role` would bypass this
guard") is correctly characterized as a forward-looking invariant. No
current RPC violates it.

### Composition with Spec 041 triggers (UPDATE + DELETE + TRUNCATE)

- **`profiles_self_brand_lock` (BEFORE UPDATE) — SECURITY INVOKER**: Spec 042
  body, fires on impersonated `authenticated`/`anon` callers. Verified.
- **`profiles_self_delete_lock` (BEFORE DELETE) — SECURITY DEFINER**: Spec 041
  body, unchanged. Verified self-DELETE still blocked.
- **`REVOKE TRUNCATE ON public.profiles FROM authenticated, anon`**: Spec 041
  round-3, unchanged. Verified TRUNCATE still rejected with `42501`.
- **No unexpected composition**: the three layers are orthogonal (UPDATE /
  DELETE / TRUNCATE) and the SECURITY INVOKER swap only affects the UPDATE
  trigger's `current_user` resolution — it has no effect on the DELETE
  trigger or the REVOKE.

### Realtime publication impact

`order_schedule` and `profiles` are not listed in any `pg_publication_tables`
output on the running stack — confirms spec §6 that this migration does not
touch the realtime publication. No `docker restart` needed.

## Conclusion

Spec 042 round-4 final correctly closes all three carry-forward findings from
Spec 041's audit, plus the Row J same-brand role-escalation attack. The
SECURITY INVOKER trigger composition with SECURITY DEFINER inner helpers is
empirically sound. The `current_user in ('authenticated','anon')` discriminator
is the correct positive allowlist for PostgREST-hostile contexts.

The three Medium/Low carry-forward findings (admin cross-brand READ,
admin cross-brand DELETE, admin cross-brand INSERT-with-auth-user) are
explicitly declared out of scope by Spec 042 and are tracked in the spec's
Risk #3/4/5 register for a follow-up sweep spec.

No Critical findings. No High findings. Spec is shippable.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 2 Medium, 2 Low.
payload_paths:
  - specs/042-rls-hardening-followups/reviews/security-auditor.md
