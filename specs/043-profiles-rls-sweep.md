# Spec 043: Profiles RLS sweep — cross-brand SELECT + DELETE lockdown

Status: READY_FOR_REVIEW

## User story
As a brand-A admin or master, I must not be able to enumerate or delete
profiles that belong to another brand. As a super_admin, I retain
cross-brand visibility and the ability to delete any profile. As an
end-user (role `user`), I retain the ability to read and write only my
own profile row. The two attack surfaces below — cross-brand SELECT
(information disclosure) and cross-brand DELETE (destructive
action) — must close. The Spec 041 self-DELETE trigger continues to
handle the self-delete case; this spec only tightens which OTHER
profiles a privileged caller can read or delete.

## Acceptance criteria

Migration filename slot: `supabase/migrations/20260517060000_profiles_rls_sweep.sql`.
Test file slot: `supabase/tests/profiles_rls_sweep.test.sql` (pgTAP).

### Policy changes on `public.profiles`

- [ ] The `"Admins can read all profiles"` SELECT policy is dropped and
  re-created. The new `using` clause is
  `(public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid()`.
  Verified by `pg_policies` row for `(schemaname='public', tablename='profiles', policyname='Admins can read all profiles', cmd='SELECT')`
  showing the new expression.
- [ ] The `"Admins can delete profiles"` DELETE policy is dropped and
  re-created. The new `using` clause is
  `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)`.
  Verified by `pg_policies` row for `(cmd='DELETE')` showing the new
  expression.
- [ ] No other policy on `public.profiles` is mutated. In particular:
  the Spec 042 `"Admins can update any profile"`, `"Users can update own profile"`,
  `"Anyone can insert own profile or admin can insert any"`, and
  `"Users can read own profile"` policies are unchanged.

### Trigger / function invariants (no-regression)

- [ ] `profiles_self_delete_lock` (BEFORE DELETE, from Spec 041) still
  blocks self-DELETE by `authenticated`/`anon` callers with the same
  message string contract. Not modified by this spec.
- [ ] `profiles_self_brand_lock` (BEFORE UPDATE, from Spec 041/042) is
  untouched. Spec 042 message-string contracts preserved exactly.
- [ ] `assert_not_last_of_role(target_user_id, target_role)` is
  SECURITY DEFINER and bypasses the new DELETE policy when called via
  RPC. Verified by an arm that calls it from a brand-A admin session
  against a brand-A target.

### Pre-flight defense-in-depth

- [ ] The migration opens with a `do $$ begin … end $$` block that
  raises `'043: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying'`
  if any `profiles` row has `role in ('admin','master') and brand_id is null`.
  Same shape as the Spec 041 / 042 pre-flight blocks.

### Edge-function defense-in-depth (`delete-user`)

- [ ] `supabase/functions/delete-user/index.ts` is amended so that
  BEFORE calling `supabase.auth.admin.deleteUser` (which uses
  service_role and bypasses RLS), the function:
  - Resolves the target's `profiles.role` and `profiles.brand_id` via
    the existing service-role client.
  - If the caller is `super_admin` (per `app_metadata.role` OR fallback
    `profiles.role` lookup), proceed unchanged.
  - Otherwise, the caller's `app_metadata.role` is in
    `{'admin','master'}`. Look up the CALLER's `profiles.brand_id`
    using the service-role client (the existing anon-key client also
    works, but the service-role client is already constructed in
    scope). If `caller.brand_id !== target.brand_id`, respond
    `403 { error: 'forbidden: target is in a different brand' }` BEFORE
    any side-effect deletes (`user_stores`, `profiles`, `invitations`,
    `auth.admin.deleteUser`).
  - Target with no `profiles` row (auth-only): retain the current
    behavior — service-role delete proceeds, no brand check possible.
- [ ] The shape mirrors `requireAdminCaller` — a single helper
  `requireSameBrandOrSuperAdmin(callerId, callerRole, targetUserId)`
  that returns `{ status: 200 } | { error, status: 403 }`. Inline in
  `delete-user/index.ts` per the CLAUDE.md "inline-not-shared" rule
  for edge functions (no `_shared/`).
- [ ] The new gate executes BEFORE
  `assert_not_last_of_role` so a brand-A admin attempting to delete a
  brand-B `super_admin` (already a violation of the new gate) gets
  `403 forbidden`, not a confusing `400 cannot delete the last super_admin`.

### Edge-function defense-in-depth (`send-invite-email`) — scoped

- [ ] `supabase/functions/send-invite-email/index.ts` is reviewed but
  NOT modified by this spec. Rationale: `send-invite-email` does not
  read any `profiles` row other than the caller's own (for the
  fallback role lookup in `requireAdminCaller`). It writes nothing.
  The invitation insertion itself (with `brand_id` set) is performed
  by the caller via PostgREST and is already gated by the Spec
  012a/014a invitations RLS policy. Architect must explicitly confirm
  this by reading the function — if the function DOES make a
  brand-blind decision, broaden this acceptance to include it. See
  Open question 5 below.

### pgTAP test arms

Test file `supabase/tests/profiles_rls_sweep.test.sql`. Plan count and
exact arm body are the architect's call; the arms below are the
minimum coverage shape.

- [ ] **SELECT — same-brand admin reads same-brand profile** → admit
  (1 row returned).
- [ ] **SELECT — same-brand admin reads OWN profile** → admit
  (no-regression for the `id = auth.uid()` arm).
- [ ] **SELECT — cross-brand admin reads foreign-brand profile** →
  0 rows returned (RLS silently filters; Postgres SELECT semantics).
- [ ] **SELECT — super_admin reads ANY brand's profile** → admit
  (positive control for the `auth_is_super_admin` short-circuit
  inside `auth_can_see_brand`).
- [ ] **SELECT — regular user (role `user`) reads OWN profile** → admit
  via the separate `"Users can read own profile"` policy
  (no-regression).
- [ ] **SELECT — regular user reads ANOTHER user's profile** →
  0 rows (no-regression — they never had cross-user SELECT).
- [ ] **DELETE — same-brand admin deletes a same-brand `user` profile** →
  admit. Arm must verify the row count after delete is 0.
- [ ] **DELETE — cross-brand admin deletes a foreign-brand profile** →
  0 rows affected (RLS silently rejects via USING; Postgres DELETE +
  RLS does not raise).
- [ ] **DELETE — super_admin deletes a foreign-brand profile** →
  admit (positive control).
- [ ] **DELETE — self-DELETE by authenticated caller** → still
  rejected with the Spec 041 message string
  `'self-delete not permitted'` (or whatever the current trigger
  string is; verify against `assert_profile_self_delete_blocked`).
  No-regression arm for Spec 041.
- [ ] **DELETE — `assert_not_last_of_role` last-master guard** still
  fires when a super_admin (RLS-permitted) attempts to delete the
  last master via direct RPC. No-regression arm for Spec 031 —
  confirms the SECURITY DEFINER helper still works after policy
  tightening.
- [ ] **No-regression for Spec 041/042 arms**: the `rls_hardening_followups`
  pgTAP file and the `auth_can_see_store_brand_scope` pgTAP file
  continue to pass without modification. Validated by running the
  full pgTAP suite (28 files after this spec adds its own).
- [ ] **TRUNCATE no-regression**: TRUNCATE on `profiles` by
  `authenticated`/`anon` still fails with `42501 permission denied`
  per the Spec 041 round-3 REVOKE.

Fixture pattern: copy the Spec 042 `rls_hardening_followups.test.sql`
fixture block (seed admin/manager/master in brand A, synthetic foreign
brand B, foreign profile, foreign auth.users row). Reuse the
`set local role authenticated; select set_config('request.jwt.claims', …, true)`
JWT impersonation idiom. Wrap the whole file in `begin; … rollback;`
for hermetic isolation.

## In scope

- One migration: `supabase/migrations/20260517060000_profiles_rls_sweep.sql`.
  Pre-flight `do $$` block, drop+create the two policies, comments.
- Two policy tightenings on `public.profiles`: SELECT and DELETE.
- One edge function change: `supabase/functions/delete-user/index.ts`
  gains a brand-match gate before its destructive path.
- One new pgTAP file: `supabase/tests/profiles_rls_sweep.test.sql`.
- Spec-doc trail: this file at `READY_FOR_ARCH` for the architect.

## Out of scope (explicitly)

- **`"Anyone can insert own profile or admin can insert any"` INSERT
  policy tightening.** Spec 042's security audit flagged this as Low
  severity and "operationally inert" because the FK to `auth.users`
  blocks the cross-brand INSERT chain unless the attacker also
  controls service_role to provision the `auth.users` row. Closing
  this is a follow-up sweep, not this spec. Rationale: keeps this
  spec narrow to the two Medium findings; INSERT tightening would
  reopen a broader test matrix.
- **Frontend UI changes.** The store layer (`useStore.ts`) and
  `UsersSection.tsx` already pass `brandId` to `fetchAllUsers` for
  non-super_admin callers. With the SELECT tightening, the
  server-side enforcement matches the client-side filter — no UI
  regression and no UI work needed. If a previously-leaking screen
  is discovered during the architect's call-site walk, that becomes
  an in-scope amendment; otherwise no frontend work.
- **Realtime publication changes.** `profiles` is not in any
  publication today (confirmed by Spec 042's audit `pg_publication_tables`
  walk). Policy changes are RLS-only; no `docker restart
  supabase_realtime_imr-inventory` needed.
- **Service-role direct DELETE.** Service-role bypasses RLS by design
  (per spec 042 Risk register). The `delete-user` edge function uses
  service_role; the new brand gate is enforced in the function body,
  not via RLS. No attempt to revoke service_role's DB DELETE
  privilege — that would break legitimate edge-function flows.
- **`send-invite-email` tightening** unless the architect's read
  surfaces a brand-blind decision (Open question 5).
- **Dependency `npm audit` triage.** Spec 042 carry-forwards
  (`@xmldom/xmldom` high, postcss/dompurify/jest-expo moderate)
  remain out of scope; tracked in spec 037+ register.

## Open questions resolved

- Q: What is the current SELECT policy text? →
  A: `((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (id = auth.uid()))`,
  at `supabase/migrations/20260502071736_remote_schema.sql:381-386`.
  Brand-blind admin arm + self-arm. Allows any admin/master to
  enumerate every profile in every brand.
- Q: What is the current DELETE policy text? →
  A: `((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])))`,
  at `supabase/migrations/20260502071736_remote_schema.sql:372-377`.
  Brand-blind admin arm; no self-arm. Allows any admin/master to
  delete any profile in any brand (subject to Spec 041's BEFORE
  DELETE trigger blocking SELF-delete).
- Q: Does the visibility model differ from Spec 041's? →
  A: No. Same model. `super_admin` bypasses via
  `auth_can_see_brand`'s `auth_is_super_admin` short-circuit;
  `admin`/`master` are scoped to their own brand;
  `user`/`staff` only ever access their own row.
- Q: Does `assert_not_last_of_role` still work after the DELETE
  policy tightening? →
  A: Yes. The helper is SECURITY DEFINER (per Spec 031) and runs
  under the function owner's identity — its internal SELECTs from
  `public.profiles` are not gated by the caller's RLS. The trigger
  is purely a count-the-rows check and raises P0001 when the delete
  would zero a privileged role. Independent of the new policy.
- Q: Does the `delete-user` edge function need the brand gate even
  though `auth.admin.deleteUser` uses service_role? →
  A: Yes — defense-in-depth. Without the gate, a compromised admin
  session for brand-A could still trigger a brand-B delete via the
  edge function. The gate keeps the SQL-side and edge-side guards
  in parity. CLAUDE.md "Edge function role gates mirror
  `auth_is_privileged()`" precedent applies — this spec adds
  brand-scope mirroring.

## Open questions for the architect

1. **pgTAP fixtures interaction with Spec 041 / 042**: do any of the
   27 existing pgTAP files SELECT cross-brand from `public.profiles`
   under `authenticated` role for setup? Walk
   `supabase/tests/*.test.sql` and confirm setup paths use
   `postgres` (which bypasses RLS) or scope their reads to a single
   brand. The `rls_hardening_followups.test.sql` already uses
   `postgres` for fixture setup and `authenticated` only for arms
   under test, so likely safe — but the architect must verify all
   27 explicitly. Same shape as Spec 042's "Composition with Spec
   041 triggers" section.
2. **Frontend call-site walk**: confirm `src/lib/auth.ts:fetchAllUsers`
   and `src/lib/db.ts:fetchBrandAdmins` are the only PostgREST
   `from('profiles').select()` call sites that could enumerate
   cross-brand. The other call sites (`saveSidebarLayout`,
   `saveLocale`, `updateProfileNotifications`, login `fetchProfile`,
   `demoteProfileToUser`, `register` INSERT) are all keyed by `id`
   and either self-scoped or single-row by super_admin context.
   Verify in the design doc.
3. **`assert_not_last_of_role` interaction**: confirm the helper
   (SECURITY DEFINER, RPC-only entry point) bypasses the new DELETE
   policy. The function only reads, doesn't delete. Verified
   theoretically; architect should empirically probe.
4. **`delete-user` edge function** — locate the caller's `brand_id`.
   The function constructs an anon-key client to validate the JWT
   and a service-role client for the destructive path. The brand
   lookup needs the caller's `profiles.brand_id`, which only the
   service-role client can read for any user. Architect: design the
   exact shape — read caller's `brand_id` via service-role lookup
   (`profiles.brand_id where id = callerId`), then compare to
   target's `brand_id`. Mirror the `assert_not_last_of_role`
   pattern (read target's role first, then act).
5. **`send-invite-email` brand-blindness check**: read
   `supabase/functions/send-invite-email/index.ts` end-to-end and
   confirm it does not branch on any `profiles` row's `brand_id`.
   Current read suggests it reads only the caller's profile for
   fallback role lookup. If a brand decision IS made, expand the
   spec.
6. **PostgREST `from('profiles')` call-site enumeration**: nine
   call sites total in `src/lib/auth.ts` and `src/lib/db.ts`. Most
   are self-keyed. The two cross-brand-capable sites are:
   - `src/lib/auth.ts:395` — `fetchAllUsers({ brandId? })`: takes
     optional `brandId` filter. After SELECT tightening, an admin
     calling without `brandId` will silently return only same-brand
     profiles instead of erroring. UI is `UsersSection.tsx`, which
     already passes `brand?.id` for non-super-admin callers and
     `undefined` for super-admin. **Behavior under the new policy
     is equivalent for non-super-admin (filter was always
     redundant) and unchanged for super-admin.** No UI fix needed.
   - `src/lib/db.ts:2732` — `fetchBrandAdmins(brandId)`: always
     filters by `brand_id`. After tightening, only same-brand
     admins can use it; super-admin can use any brand. The
     BrandsSection "Members" tab is super-admin-only per Spec
     012b/012c, so no regression. Architect: confirm by reading
     the gate.
7. **Pre-flight `do $$` block**: same shape as Spec 041/042 — raises
   if any `profiles.role in ('admin','master')` has `brand_id is null`.
   Required because the new SELECT policy reads `brand_id` and would
   silently exclude such rows from cross-admin visibility. Local
   stack and prod were both verified clean by Spec 041's pre-flight;
   this is belt-and-suspenders for the apply window.
8. **Rollback ordering**: rolling back this spec must NOT precede
   rolling back Spec 042 — same lockstep contract as 041/042. If
   ops rolls back 043 alone, only the cross-brand SELECT and DELETE
   reopen; the Spec 042 brand-update tightening and Spec 041 self-edit
   triggers remain in force. Documented in the migration header
   comment.

## Dependencies

- Spec 041 (brand-scoped store visibility) — establishes
  `auth_can_see_brand`, `auth_is_privileged`, `auth_is_super_admin`,
  and the visibility model. Must be applied first.
- Spec 042 (RLS hardening followups) — establishes the matching
  pattern for profiles UPDATE policy + the SECURITY INVOKER trigger.
  This spec's policy tightenings are the cosmetic mirror on SELECT
  and DELETE. Must be applied before 043.
- Spec 031 (`assert_not_last_of_role`) — the SECURITY DEFINER guard
  that the `delete-user` edge function calls AFTER the new brand
  gate. Must stay functional after this spec. No changes to the
  helper itself.
- Spec 028 (escapeHtml in edge functions) — not directly touched,
  but the `delete-user` change must not regress any HTML-escape
  behavior elsewhere in the file (delete-user does not currently
  emit HTML, so no overlap).
- Spec 012b/012c (super-admin UI, BrandsSection) — frontend
  consumer of `fetchBrandAdmins`. No code change to UI; behavior
  remains equivalent.
- Spec 025 (Cmd UI as only client; legacy admin deleted) — confirms
  `UsersSection.tsx` is the only profiles-enumeration screen.

## Project-specific notes

- **Cmd UI section / legacy**: `src/screens/cmd/sections/UsersSection.tsx`
  and `src/screens/cmd/sections/BrandsSection.tsx`. No legacy
  surface — deleted by Spec 025.
- **Per-store or admin-global**: per-BRAND (not per-store). Profiles
  are brand-scoped via `profiles.brand_id`. Per-store scope (via
  `user_stores`) is a separate access ledger and not touched.
- **Realtime channels touched**: NONE. `profiles` is not in any
  publication on the current stack (verified by Spec 042 audit).
- **Migrations needed**: yes — one new migration
  `supabase/migrations/20260517060000_profiles_rls_sweep.sql`.
- **Edge functions touched**:
  - `supabase/functions/delete-user/index.ts` — modified
    (brand-match gate added).
  - `supabase/functions/send-invite-email/index.ts` — reviewed; not
    modified pending Open question 5.
- **Web/native scope**: backend + edge function only. No frontend
  code change. Both web and native consume the tightened policy
  identically via PostgREST / RPC.
- **Test track**: pgTAP DB tests (Spec 022 track 2). New file at
  `supabase/tests/profiles_rls_sweep.test.sql`. Run via
  `scripts/test-db.sh`. Plus the jest track (Spec 022 track 1) for
  the `delete-user` edge function brand gate if the architect
  decides Deno-side coverage warrants it — note that
  `supabase/functions/` is Deno and is not currently in the jest
  surface, so the realistic coverage path is a shell smoke
  (`scripts/test-edge.sh` or similar) hitting the local edge
  runtime.
- **`app.json` slug**: not touched. Stays `towson-inventory`.
- **`assert_brand_id_immutable_for_self` trigger**: not modified by
  this spec. Spec 042 round-4 form (SECURITY INVOKER) stays.
- **`profiles_self_delete_lock` trigger**: not modified by this
  spec. Spec 041 form stays.
- **Cross-brand admin enumeration risk after deploy**: closed for
  SELECT and DELETE. INSERT remains open per "Out of scope" but is
  operationally inert per Spec 042 audit. UPDATE was closed by Spec
  042.
- **Local edge runtime bind-mount gotcha**: per CLAUDE.md, after
  modifying `supabase/functions/delete-user/index.ts` locally, the
  function is hot-reloaded from the existing bind-mount — no
  `supabase stop` needed unless the runtime was first booted from a
  stale CWD. Architect should call this out for the test loop.

## Backend / architecture design

### Summary

Two policy tightenings on `public.profiles` plus one edge-function
defense-in-depth gate. Mechanically simple; the load-bearing work is
**one fixture fix in an existing pgTAP file** (the Spec 042
`rls_hardening_followups.test.sql` arm (9) verification SELECT relies
on the soon-to-be-closed cross-brand admin SELECT path) and the
**`delete-user` edge-function brand gate** shape.

Mirrors Spec 042's two-tier approach: the SQL-side policy is the
authoritative gate; the edge-function gate is defense-in-depth for the
service-role bypass path.

### Data model changes

None. No new columns, indexes, or tables. Two policy drop-and-recreates
on `public.profiles`. Pre-existing columns (`profiles.brand_id`,
`profiles.role`, `profiles.id`) carry all the data the new USING
clauses need.

Migration filename slot: `supabase/migrations/20260517060000_profiles_rls_sweep.sql`.

Strictly additive in the rollback sense — rolling back this migration
restores the brand-blind admin SELECT and DELETE policies. Lockstep
contract with Spec 041 / 042: rolling back 043 alone reopens cross-brand
SELECT + DELETE but leaves the Spec 041 self-edit triggers + Spec 042
UPDATE tightening + Spec 042 trigger broadening in force. Documented
in the migration header.

#### Pre-flight `do $$` block (Open question 7)

Standard belt-and-suspenders shape, identical to Spec 041/042 pre-flight
blocks:

```
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '043: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;
```

Rationale: the new SELECT and DELETE USING clauses read `brand_id`. An
admin/master row with `brand_id is null` would be excluded from
`auth_can_see_brand` for every privileged caller (other than super_admin
who short-circuits) — invisible even to themselves through the admin
arm. The self-arm `id = auth.uid()` would still admit, so total
unreachability is avoided, but cross-admin visibility would silently
disappear. Operator-invisible regression. Belt-and-suspenders fail-closed
matches the Spec 041 / Spec 042 contract.

#### Policy 1 — SELECT tightening

`drop policy if exists "Admins can read all profiles" on public.profiles;`

Recreate with:

```
create policy "Admins can read all profiles"
  on public.profiles for select
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or id = auth.uid()
  );
```

Three-arm semantics:
- `auth_is_super_admin()` short-circuit inside `auth_can_see_brand` →
  super_admin sees every profile in every brand.
- `auth_is_admin()` (JWT) or super_admin (via `auth_is_privileged`) +
  same `brand_id` → admin/master sees own-brand profiles.
- `id = auth.uid()` → every authed caller (regardless of role) sees
  their own profile. No-regression arm for role='user' callers.

Add a `comment on policy` referencing spec 043 mirror of the Spec 042
"Admins can update any profile" rationale.

#### Policy 2 — DELETE tightening

`drop policy if exists "Admins can delete profiles" on public.profiles;`

Recreate with:

```
create policy "Admins can delete profiles"
  on public.profiles for delete
  using (
    public.auth_is_privileged() and public.auth_can_see_brand(brand_id)
  );
```

No self-arm. Self-DELETE is independently blocked by the Spec 041
`profiles_self_delete_lock` BEFORE-DELETE trigger; adding an `id =
auth.uid()` arm here would admit the DELETE row through RLS only for
the trigger to reject — confusing but not unsafe. Cleaner to keep the
policy as the strict admin-only gate and let the trigger be the final
authority on self-DELETE.

Same `auth_is_super_admin` short-circuit reaches the super_admin →
delete-any case via `auth_can_see_brand`.

#### Policies explicitly NOT touched

- `"Users can read own profile"` (the self-arm SELECT policy from
  remote_schema.sql:408-413) — unchanged. After the new admin SELECT
  policy lands, the self-arm of the new policy is functionally redundant
  with this one (both admit `id = auth.uid()`), but keeping both is
  Spec 042's pattern (no churn to existing policies outside scope).
- `"Admins can update any profile"` — unchanged (Spec 042 already
  tightened it).
- `"Users can update own profile"` — unchanged (Spec 042 added the
  WITH CHECK).
- `"Anyone can insert own profile or admin can insert any"` — unchanged
  (out-of-scope per spec body; low severity per Spec 042 audit).

### RLS impact

Policies named and their helpers, after this migration:

| Policy | Verb | Helper | Notes |
|---|---|---|---|
| `"Admins can read all profiles"` | SELECT | `auth_is_privileged() AND auth_can_see_brand(brand_id)` + `id = auth.uid()` | NEW (this spec) |
| `"Users can read own profile"` | SELECT | `id = auth.uid()` | unchanged |
| `"Admins can update any profile"` | UPDATE | Spec 042 form | unchanged |
| `"Users can update own profile"` | UPDATE | Spec 042 form | unchanged |
| `"Anyone can insert own profile or admin can insert any"` | INSERT | remote_schema.sql form | unchanged (out-of-scope) |
| `"Admins can delete profiles"` | DELETE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | NEW (this spec) |
| `super_admin_manage_profiles` (012a) | ALL | super_admin only | unchanged |

Triggers (no-regression):
- `profiles_self_brand_lock` (BEFORE UPDATE, Spec 041 + Spec 042 round-4
  body) — untouched.
- `profiles_self_delete_lock` (BEFORE DELETE, Spec 041 round-2) —
  untouched. Continues to block self-DELETE before the new DELETE
  policy is even evaluated (BEFORE triggers fire pre-RLS in the
  Postgres semantics for the DELETE verb — though both layers must
  pass).
- `profiles_sync_role_to_jwt` (AFTER INSERT/UPDATE OF role) — untouched.

Helpers (no-regression):
- `auth_can_see_brand(uuid)` — Spec 041 / 012a body. Reads
  `auth_is_super_admin()` + `profiles.brand_id` for `auth.uid()`.
- `auth_is_privileged()` — 012a body. `auth_is_admin() OR
  auth_is_super_admin()`.
- `assert_not_last_of_role(uuid, text)` — Spec 031 SECURITY DEFINER.
  Bypasses the new DELETE policy.

### API contract

No new RPCs. No PostgREST view changes. All call sites in `src/lib/`
continue to use the same PostgREST query shapes.

**Cross-brand admin SELECT call site (`fetchAllUsers`):** after the
SELECT tightening, an admin caller invoking `fetchAllUsers()` without
`{ brandId }` will silently return only same-brand profiles. The
current UI (`UsersSection.tsx:49`) always passes `brand?.id` for
non-super-admin callers, so the server-side filter now matches the
client-side filter — equivalent behavior, no UI regression. For
super_admin callers, `brand` is null until they pick one, so the
query runs unfiltered and the new SELECT policy admits all profiles
via the super_admin short-circuit. Documented in Open question 6.

**`fetchBrandAdmins(brandId)` call site:** always filters by `brand_id`
server-side. After tightening, only same-brand admin/master and
super_admin can read the rows. UsersSection passes the active brand,
BrandsSection (super_admin-only per Spec 012b) is the cross-brand
consumer. No UI regression.

### Edge function changes

#### `supabase/functions/delete-user/index.ts` — modified (Open question 4)

`verify_jwt` setting: unchanged (true, default). The function validates
the caller's JWT via `requireAdminCaller()` already.

New inline helper:

```typescript
async function requireSameBrandOrSuperAdmin(
  serviceClient: SupabaseClient,
  callerId: string,
  callerAppRole: string,
  targetUserId: string,
): Promise<{ status: 200 } | { error: string; status: 403 }>
```

Decision shape:
1. **Caller is `super_admin`** (per `app_metadata.role` OR profile-role
   fallback in `requireAdminCaller`) → return `{ status: 200 }`. No
   brand check needed.
2. **Caller is `admin` / `master`** (per the existing `ADMIN_ROLES`
   set, minus super_admin) → service-role read of caller's
   `profiles.brand_id`, service-role read of target's `profiles.brand_id`.
   - If target has NO profiles row (auth-only user, `targetProfile is
     null`) → return `{ status: 200 }`. No brand check possible; the
     pre-existing destructive path is preserved unchanged.
   - If target's profile exists AND `caller.brand_id !== target.brand_id`
     → return `{ error: 'forbidden: target is in a different brand',
     status: 403 }`.
   - Otherwise (same brand or target has NULL brand_id [which would
     itself imply target.role='super_admin' — caught by step 1's check
     on the caller side; for the target side, a brand-A admin
     attempting to delete a super_admin lands here and 403s]) → return
     `{ status: 200 }`.
3. **Else** (defense-in-depth — `requireAdminCaller` should have
   already 403'd) → return `{ error: 'forbidden', status: 403 }`.

Wire-in:

The existing flow at `delete-user/index.ts:48-103` becomes:

```
- requireAdminCaller (existing) → 401/403 short-circuit
- parse userId, self-delete short-circuit (existing)
- create service-role client (moved up — existing line 66)
- NEW: requireSameBrandOrSuperAdmin(service-role client, callerId,
       callerAppRole, userId) → 403 short-circuit on brand mismatch
- existing: lookup targetProfile.role, call assert_not_last_of_role
- existing: cascading deletes + auth.admin.deleteUser
```

The gate runs **before** `assert_not_last_of_role` per the spec's
acceptance criterion. Brand-A admin attempting to delete brand-B
super_admin → 403 (clearer than the misleading 400 "cannot delete the
last super_admin"). Same-brand admin attempting to delete the last
master in their own brand → falls through to the last-of-role guard
and gets 400 "cannot delete the last master" as today.

The caller's `appRole` must flow from `requireAdminCaller` to the new
helper. `requireAdminCaller` already extracts the app_metadata role at
line 29; pass it through in the return envelope so the new helper
doesn't need to re-fetch the caller's profile. Updated
`requireAdminCaller` envelope: `{ userId, appRole, status: 200 }` (was
`{ userId, status: 200 }`). The profile-fallback branch at line 31-33
already reads `profile.role`; use that as the appRole when the JWT
path didn't yield one.

CLAUDE.md "inline-not-shared" rule: helper lives inside
`delete-user/index.ts`. Not pulled into `_shared/`.

#### `supabase/functions/send-invite-email/index.ts` — REVIEWED, NOT MODIFIED (Open question 5)

End-to-end re-read confirms the function:
- Reads only the caller's own `profiles.role` via the anon-key client
  (line 32), gated by `id = auth.uid()` which the new SELECT policy
  admits via the self-arm — no regression.
- Writes nothing to `profiles`.
- Inserts no rows; only sends an email via Resend or invokes
  `auth.admin.inviteUserByEmail` (which writes to `auth.users`, not
  `profiles`).
- Receives `email`, `name`, `role`, `storeNames` from the caller. Does
  NOT branch on any `profiles.brand_id`. The invitation `INSERT INTO
  invitations` happens client-side (caller via PostgREST), gated by
  the Spec 012a/014a invitations RLS policy which already enforces the
  brand match.

Out-of-scope. No changes. Same outcome as the spec author surmised in
Open question 5.

### `src/lib/db.ts` surface

No new helpers. No signature changes. No frontend-store changes.

The new 403 from `delete-user` flows through the existing
`callEdgeFunction` envelope at `src/lib/auth.ts:158`. The error string
`'forbidden: target is in a different brand'` lands in the `error`
field of the `{ error }` return from `deleteUser` (at
`src/lib/auth.ts:473`), which lands in the `notifyBackendError` call
at `src/store/useStore.ts:895`. The user sees a toast with the error
text. Same toast surface as Spec 031 / Spec 032 errors.

No `mapItem`-style snake_case → camelCase changes. The error path
returns strings, not row payloads.

### Realtime impact

None. `profiles` is not in the `supabase_realtime` publication — Spec
042 audit already confirmed via `pg_publication_tables`. Policy
changes are RLS-only; no `docker restart supabase_realtime_imr-inventory`
needed.

### Frontend store impact

None. No slice of `src/store/useStore.ts` changes. The
optimistic-then-revert pattern doesn't apply because no new actions are
added — the existing `deleteProfile` action already calls
`notifyBackendError` on the new 403 path.

### Pre-existing pgTAP test interaction (Open question 1) — IMPORTANT

Walked all 27 existing pgTAP files for `from public.profiles` reads
under `authenticated` role context. Findings:

**At-risk (must fix):** `supabase/tests/rls_hardening_followups.test.sql`
**arm (9)** at lines 421-426. The arm impersonates the brand-A admin
JWT, attempts to UPDATE target_b's name (correctly silently 0 rows),
then verifies via:

```
select is(
  (select name from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  'Target B (test 042)',
  ...
);
```

Under today's SELECT policy this verification SELECT admits the
cross-brand row (admin/master JWT is brand-blind on SELECT). Under
Spec 043's tightening, the SELECT returns 0 rows; the subquery yields
NULL; the assertion fails.

**Fix:** patch this one verification block to use the standard
`reset role + clear claims` pattern that arms (5)-(6) of the same file
already use (lines 286-287, 316-317) and that
`profiles_locale.test.sql` arm (7) uses (lines 195-203). Specifically,
before the `select is(...)` at line 421, insert:

```
reset role;
select set_config('request.jwt.claims', '', true);
```

This bypasses RLS for the verification read while keeping the JWT-bound
UPDATE attempt on lines 417-419 under the brand-A admin context.
Behavior of the arm is unchanged: it still proves the brand-A admin's
UPDATE silently affected 0 rows. The only thing the patch changes is
the verification SELECT's role context — from "brand-A admin" (which
post-043 cannot see target_b at all) to "postgres" (RLS bypass).

After arm (9)'s patch, re-impersonating super_admin in arm (10) at
line 433 is already done (with `set local role authenticated; set
config(jwt)`), so the arm-9 → arm-10 transition continues to work.

**Not at-risk:**

- `supabase/tests/auth_can_see_store_brand_scope.test.sql` — all
  cross-brand SELECTs from `public.profiles` happen under `reset role`
  (postgres, RLS-bypass). Verified by walking the file.
- `supabase/tests/profiles_locale.test.sql` — every profile SELECT
  under authenticated context is self-scoped (`where id =
  manager_id` while impersonating manager). The arm-7 cross-user
  read at line 199 is preceded by `reset role; select set_config(...,
  '', true)` (lines 195-196). Safe.
- `supabase/tests/rls_hardening_followups.test.sql` arms (5)-(6) —
  use `reset role` before the verification SELECT (already shown).
- `supabase/tests/rls_hardening_followups.test.sql` arm (8) — admin
  reads same-brand target_a under admin JWT. After Spec 043, the new
  SELECT policy still admits this via the admin+brand arm. Safe.
- `supabase/tests/rls_hardening_followups.test.sql` arm (10) — reads
  cross-brand target_b under super_admin JWT. The new SELECT policy
  admits via the super_admin short-circuit. Safe.
- `supabase/tests/rls_hardening_followups.test.sql` arm (15) — reads
  target_a under super_admin JWT. Safe.
- `supabase/tests/rls_hardening_followups.test.sql` arm (11) — reads
  own profile (manager_id) under manager JWT. Admitted via `id =
  auth.uid()` self-arm. Safe.
- `supabase/tests/user_data_i18n_names.test.sql` line 62 — `select
  brand_id into v_brand_id from public.profiles where id = v_admin_id`
  runs inside a `do $$` block at the top of the test transaction, BEFORE
  any `set local role authenticated`. Default role is postgres
  (RLS-bypass). Safe.
- `supabase/tests/recipe_categories_super_admin_rls.test.sql` line 55
  — `select role from public.profiles where id = ...` runs under
  default postgres role (the test sets `reset role` at line 41 before
  any JWT impersonation arm). Safe.
- `supabase/tests/copy_brand_catalog.test.sql`,
  `supabase/tests/invitations_super_admin_rls.test.sql`,
  `supabase/tests/delete_last_privileged_guard.test.sql`,
  `supabase/tests/admin_rpcs_privileged.test.sql` — all profile
  UPDATEs run under default postgres role (fixture setup), not
  authenticated. No SELECT-during-JWT-impersonation. Safe.
- The 14 report_*, eod_*, inventory_count* tests do not touch
  `public.profiles`. Safe.

**Net pgTAP impact:** one in-place patch to one verification block in
`rls_hardening_followups.test.sql`. This is the architect's call —
the spec body says "No-regression for Spec 041/042 arms" continues to
pass; the fixture patch is necessary because Spec 043 tightens the
SELECT policy that the test's verification path implicitly depends on.
Document this in the migration body header as "fixture amendment
required" alongside the policy change.

### Pre-existing frontend call sites (Open questions 2, 6)

Walked all 9 `from('profiles')` call sites in `src/`:

| File:line | Verb | Filter shape | Risk post-043 |
|---|---|---|---|
| `src/store/useStore.ts:2085` (persist dark_mode) | UPDATE | `.eq('id', userId)` (self-only) | none — self-policy admits |
| `src/lib/auth.ts:82` (fetchProfile) | SELECT | `.eq('id', userId)` (self-only) | none — self-policy admits |
| `src/lib/auth.ts:335` (register) | INSERT | new own profile | none — INSERT policy unchanged |
| `src/lib/auth.ts:398` (fetchAllUsers) | SELECT | optional `.eq('brand_id', brandId)` | **see Open question 6** |
| `src/lib/db.ts:1324` (updateProfileNotifications) | UPDATE | `.eq('id', userId)` | none — self-policy admits |
| `src/lib/db.ts:1351` (saveSidebarLayout) | UPDATE | `.eq('id', userId)` | none — self-policy admits |
| `src/lib/db.ts:1374` (saveLocale) | UPDATE | `.eq('id', userId)` | none — self-policy admits |
| `src/lib/db.ts:2712` (demoteProfileToUser) | UPDATE | `.eq('id', profileId)` | none — super-admin-only call site |
| `src/lib/db.ts:2737` (fetchBrandAdmins) | SELECT | `.eq('brand_id', brandId)` | none — server-side filter matches client filter |

**`fetchAllUsers` (Open question 6, item 1):** the optional `brandId`
filter is the only PostgREST query that could enumerate cross-brand.
After Spec 043 tightening:
- Non-super-admin caller without `brandId` → silently returns only
  same-brand rows (instead of cross-brand admin getting every brand's
  rows, the pre-043 broken behavior).
- Non-super-admin caller with `brandId` matching own brand → returns
  same-brand rows (unchanged).
- Non-super-admin caller with `brandId` for foreign brand → returns 0
  rows (server-side filter + RLS both reject). New behavior, but no
  call site does this — UsersSection always passes own brand.
- Super-admin caller without `brandId` → returns every brand's rows
  (auth_can_see_brand short-circuits on super_admin). Unchanged.
- Super-admin caller with `brandId` → returns brand-scoped rows
  (unchanged).

UI behavior: equivalent for non-super-admin (the call site only ever
passes own brand); unchanged for super_admin. No UI work needed.

**`fetchBrandAdmins` (Open question 6, item 2):** server-side filter
is `.eq('brand_id', brandId)`. After tightening:
- Same-brand admin/master caller → admits via admin arm + brand match.
  Returns rows.
- Cross-brand admin caller → would never call this (BrandsSection
  members tab is super-admin-only per Spec 012b/012c). Defensive
  check: if a future UI surface added a cross-brand admin call,
  server-side filter + RLS would both return 0 rows. Safe.
- Super-admin → admits via super_admin short-circuit. Unchanged.

No regressions in any call site.

### `assert_not_last_of_role` regression check (Open question 3)

The helper is SECURITY DEFINER (Spec 031,
`supabase/migrations/20260514160000_assert_not_last_of_role.sql:46`).
Body reads `count(*) from public.profiles where role = target_role
and id <> target_user_id`. SECURITY DEFINER means this SELECT runs as
the function owner (postgres), bypassing RLS. The new SELECT policy
gates only `authenticated` / `anon` callers; postgres bypasses RLS by
design.

Call paths:
- Edge function `delete-user/index.ts:92` invokes via service-role
  RPC. service_role bypasses RLS entirely (per Spec 042 risk register).
  Independent of the new policy.
- pgTAP `delete_last_privileged_guard.test.sql` invokes directly under
  default postgres role (no `set local role authenticated`). Bypasses
  RLS.
- Any future authenticated-context RPC caller → would invoke through
  SECURITY DEFINER, function body reads under postgres identity.
  Bypasses RLS.

**No regression.** The helper continues to work after Spec 043. The
acceptance criterion arm (last-of-role helper still fires from a
brand-A admin context after policy tightening) is sufficient regression
coverage. No code change to the helper.

### Empirical probe (per Spec 042 round-4 lesson)

The interaction here is straightforward — the SELECT policy is read by
PostgreSQL during query planning for any authenticated SELECT against
`public.profiles`. The behavior is documented Postgres RLS semantics
(USING-failed SELECT returns 0 rows silently, no error). There's no
subtle SECURITY DEFINER inside DEFINER scenario like Spec 042 round-4.

That said, **one probe is recommended** to confirm the fixture
interaction with `rls_hardening_followups.test.sql` arm (9). The
backend-developer should run this BEFORE applying the migration to
prove the regression diagnosis, and AFTER applying the migration plus
the arm-9 patch to prove the patch is sufficient.

**Probe (run via `docker exec` against the local Supabase Postgres):**

```sql
-- ────── Pre-Spec-043 baseline (or after rollback) ──────
-- This probe runs in a temporary transaction. Roll back at the end so
-- the database state is unchanged.
begin;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);
-- Read a row in the seed brand (brand A) — should return the admin's own row.
select id, brand_id, role from public.profiles
  where id = '11111111-1111-1111-1111-111111111111';
-- Read the seed master (brand A) — same-brand, should return.
select id, brand_id, role from public.profiles
  where id = '33333333-3333-3333-3333-333333333333';
rollback;
```

Expected pre-Spec-043: both reads return 1 row each. The brand-A admin
can already see same-brand peers via the existing brand-blind admin arm.

Expected post-Spec-043: both reads still return 1 row each, because
both targets have `brand_id = brand A`, and `auth_can_see_brand(brand A)`
returns true for the brand-A admin caller.

**Cross-brand probe (synthesizes a brand-B target inside a tx):**

```sql
begin;
-- Seed a brand-B and a brand-B profile (will roll back).
insert into public.brands (id, name) values
  ('b2000000-0000-0000-0000-000000000099', 'Probe Brand B (043)');
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new,
  email_change, email_change_token_current, phone_change,
  phone_change_token, reauthentication_token
) values (
  'aaaaa043-0000-0000-0000-000000000099',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','probe-043@local.test','',
  now(), now(), now(),
  jsonb_build_object('provider','email','providers',array['email'],'role','user'),
  '{}'::jsonb, false, false,
  '','','','','','','',''
);
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values (
  'aaaaa043-0000-0000-0000-000000000099',
  'Probe B Target', 'user', 'PB', '#888', 'active',
  'b2000000-0000-0000-0000-000000000099'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

-- Pre-Spec-043 (or after rollback): expected 1 row.
-- Post-Spec-043: expected 0 rows (admin can no longer see brand-B).
select id, brand_id, role from public.profiles
  where id = 'aaaaa043-0000-0000-0000-000000000099';

rollback;
```

This is the diagnostic for the arm (9) regression: post-Spec-043 it
returns 0 rows, confirming the SELECT policy tightening blocks the
verification SELECT inside arm (9).

The backend-developer documents the probe output in the migration's
commit message or in a PR comment, matching the Spec 042 round-4 probe
documentation precedent (the round-4 SECURITY INVOKER probe is
documented in the migration body itself; this probe is less subtle and
can stay in a commit message).

### pgTAP test arms (Open question 8)

New test file: `supabase/tests/profiles_rls_sweep.test.sql`. Plan(11)
arms minimum. Mirrors the Spec 042 `rls_hardening_followups.test.sql`
fixture pattern verbatim:

- Begin transaction, create pgtap extension.
- Stash UUIDs via `set_config('test.<key>', ...)`.
- Insert test-only foreign brand + test-only foreign-brand
  `auth.users` row + test-only foreign profile (brand B) +
  test-only same-brand profile (brand A).
- Run arms with `set local role authenticated` + JWT impersonation
  per the Spec 041/042 idiom.
- `select * from finish(); rollback;` at the end.

Arms (using the spec's minimum coverage shape):

| # | Arm | Caller | Target | Expected |
|---|---|---|---|---|
| 1 | SELECT own profile | seed admin (brand A) | seed admin row | 1 row (self-arm) |
| 2 | SELECT same-brand peer | seed admin (brand A) | manager_id (brand A) | 1 row (admin+brand arm) |
| 3 | SELECT cross-brand | seed admin (brand A) | target_b (brand B) | 0 rows (RLS silently filters) |
| 4 | SELECT cross-brand as super_admin | promoted master_id (super_admin) | target_b (brand B) | 1 row (super_admin short-circuit) |
| 5 | SELECT own profile as `user` role | seed manager (role='user', brand A) | manager_id | 1 row (Users can read own profile policy) |
| 6 | SELECT another's profile as `user` role | seed manager | admin_id | 0 rows (no cross-user user-tier SELECT) |
| 7 | DELETE same-brand non-admin row | seed admin (brand A) | target_a (brand A, role='user') | row count after = 0 |
| 8 | DELETE cross-brand row | seed admin (brand A) | target_b (brand B) | RLS silently 0 rows affected; row still present |
| 9 | DELETE cross-brand row as super_admin | promoted master_id | target_b (brand B) | row count after = 0 |
| 10 | Self-DELETE no-regression for Spec 041 | seed admin | seed admin row | throws P0001 'profile self-delete is not permitted (use admin delete flow)' |
| 11 | `assert_not_last_of_role` regression | seed admin (brand A) JWT context | last-master probe | call `public.assert_not_last_of_role` via select; helper raises P0001 'cannot delete the last master' (or for super_admin, 'cannot delete the last super_admin') — proves SECURITY DEFINER bypass still works after policy tightening |

Optional 12th arm: **TRUNCATE no-regression** — under brand-A admin
JWT, `truncate public.profiles` raises 42501 (per Spec 041 round-3
REVOKE). Same shape as
`auth_can_see_store_brand_scope.test.sql:486-509`. Recommended for
parity with the spec acceptance criterion that calls TRUNCATE out
explicitly; the file's current `plan(N)` should be 12 if included.

**Verification SELECT pattern for the DELETE arms (7)-(9):** use
`reset role + select set_config('request.jwt.claims', '', true)` BEFORE
the `(select count(*) from public.profiles where id = ...)` verification
read. This bypasses RLS for the inspection step — same pattern as
`rls_hardening_followups.test.sql` arms (5)-(6) and the patched arm (9).

**Fixture detail for arm (11):** the last-of-role probe needs a target
profile that, after counting, would leave zero rows of the given role.
Cleanest shape: inside the transaction, after promoting master_id to
super_admin (the Spec 042 idiom), the `super_admin` role has exactly
one row. The arm asserts:

```sql
set local role authenticated;
select set_config('request.jwt.claims', '<brand-A admin claims>', true);
select throws_ok(
  format(
    $$select public.assert_not_last_of_role(%L::uuid, 'super_admin')$$,
    current_setting('test.master_id', true)
  ),
  'P0001',
  'cannot delete the last super_admin',
  'arm (11): assert_not_last_of_role still works from authenticated context (SECURITY DEFINER bypass)'
);
```

Proves SECURITY DEFINER bypass is intact (helper would otherwise return
brand-scoped count under brand-A admin's RLS view, which would be
zero and silently succeed — wrong answer).

**Fixture cost:** one additional brand row, one additional auth.users
row, one additional profile (brand B target). Same shape as Spec 042's
`rls_hardening_followups.test.sql` lines 102-148.

**Total new pgTAP arms:** 11 (or 12 with the optional TRUNCATE arm). One
in-place patch to `rls_hardening_followups.test.sql` arm (9) (3 lines
added: `reset role; select set_config('request.jwt.claims', '', true);`).

### Risks and tradeoffs

**Migration ordering.** Must apply after 20260517050000 (Spec 042) and
20260517040000 (Spec 041). Filename `20260517060000_profiles_rls_sweep.sql`
respects this. Apply via `supabase migration up` in the local dev loop.

**RLS gap during apply window.** The migration body is a single
transaction: pre-flight check → drop old policies → create new
policies. Between `drop policy` and `create policy` (microseconds, but
non-zero) the table has NO SELECT/DELETE policy for the admin path —
which means authenticated callers fall back to "no policy admits, deny
all" for those verbs during the gap, **except** the still-present
`"Users can read own profile"` SELECT policy admits via `id =
auth.uid()`. So the apply-window risk is: an admin/master in-flight
SELECT for a cross-user profile briefly returns 0 rows. Acceptable —
recovers within the transaction. No data loss. Same shape as Spec 042
policy churn.

**Service-role bypass surface.** Documented in the spec body and
preserved unchanged. The `delete-user` edge function uses service_role
for the actual delete; the new brand gate is enforced in the function
body. A direct service-role call from outside the function (e.g., a
manual psql session, an unauthorized edge function) would still bypass
both RLS and the new gate. Same caveat as every other RLS layer.

**`delete-user` brand-gate ordering.** The new gate runs BEFORE
`assert_not_last_of_role`. A brand-A admin trying to delete a brand-B
super_admin → 403 (not 400 last-of-role). A brand-A admin trying to
delete the last brand-A master → 400 (last-of-role guard fires).
Documented in acceptance criteria.

**Cold-start surface.** The edge-function gate adds one service-role
profile read (target.brand_id) + one service-role profile read
(caller.brand_id) before the existing target.role read. Three reads
total where there used to be one. Cold-start is dominated by container
init (~150ms baseline); three sequential reads add maybe 5-10ms.
Acceptable for an admin-tier destructive op.

**Test brittleness.** The arm-9 patch to
`rls_hardening_followups.test.sql` is mechanical. The new
`profiles_rls_sweep.test.sql` file follows the Spec 042 fixture pattern
verbatim. Risk surface is the same as Spec 042 had at landing — bounded.

**286 KB seed dataset.** No performance impact. The new SELECT
policy's USING clause adds two helper-function calls (`auth_is_privileged()`
+ `auth_can_see_brand(brand_id)`) per row evaluated. Both helpers are
`stable` (cacheable within a query) and operate on `auth.uid()` and a
single profile row; cost is O(1) per row. The seed has tens of
profile rows; no measurable change.

**Cross-brand admin enumeration risk after deploy.** Closed for SELECT
and DELETE. INSERT remains open per spec out-of-scope (low severity,
operationally inert per Spec 042 audit). UPDATE was closed by Spec 042.
The four-corner attack matrix on profiles (SELECT/UPDATE/DELETE +
INSERT) is now closed on three of four after this spec; INSERT is the
deferred follow-up.

### Files changed

The backend-developer implements:

- `supabase/migrations/20260517060000_profiles_rls_sweep.sql` (new) —
  pre-flight + two policy drop-and-recreates + comments.
- `supabase/functions/delete-user/index.ts` (modified) — add
  `requireSameBrandOrSuperAdmin` inline helper; modify
  `requireAdminCaller` to return `appRole`; wire-in the gate before
  `assert_not_last_of_role`.
- `supabase/tests/profiles_rls_sweep.test.sql` (new) — 11 (or 12)
  arm pgTAP plan per the table above.
- `supabase/tests/rls_hardening_followups.test.sql` (in-place patch) —
  three-line insertion before arm (9) verification SELECT (line ~421):
  `reset role; select set_config('request.jwt.claims', '', true);`.
  No other arms modified. Header comment updated to note the Spec 043
  patch context.

The frontend-developer is **not** required. No `src/` changes.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. The work is one
  new migration (`20260517060000_profiles_rls_sweep.sql`), one
  modified edge function (`delete-user/index.ts` — add the inline
  `requireSameBrandOrSuperAdmin` helper and thread `appRole` through
  `requireAdminCaller`), one new pgTAP file
  (`profiles_rls_sweep.test.sql` — 11 arms minimum, see the table in
  the design), and one in-place patch to
  `rls_hardening_followups.test.sql` arm (9) (three lines:
  `reset role; select set_config('request.jwt.claims', '', true);`
  before the verification SELECT at ~line 421). Run the empirical
  probe documented in the design before applying the migration to
  prove the arm-9 regression diagnosis, and after applying to prove
  the patch is sufficient. Spec 042 round-4 lesson applies — read
  the actual probe output, don't assume. No `src/` changes; no
  frontend-developer needed for this spec. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/043-profiles-rls-sweep.md


## Files changed

Backend implementation, no `src/` changes (per architect's design).

### Migrations
- `supabase/migrations/20260517060000_profiles_rls_sweep.sql` (new) —
  pre-flight `do $$` block (raises if any admin/master row has
  `brand_id is null`) + two policy drop-and-recreates on
  `public.profiles`:
  - `"Admins can read all profiles"` SELECT — new USING is
    `(public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid()`.
  - `"Admins can delete profiles"` DELETE — new USING is
    `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)`.
  Comments on both policies reference Spec 043.

### Edge functions
- `supabase/functions/delete-user/index.ts` (modified) —
  - `requireAdminCaller()` envelope now returns `{ userId, appRole,
    status: 200 }` (was `{ userId, status: 200 }`). `appRole` is the
    JWT `app_metadata.role` when in `ADMIN_ROLES`, otherwise the
    `profiles.role` fallback value (mirrors the existing profile-fallback
    branch). Return type is a discriminated union (`AdminGate`) so the
    outer handler narrows on `status === 200` without `!` non-null
    assertions on `gate.userId` / `gate.appRole` (code-reviewer round-2
    cleanup; same approach also closes S2 below cleanly).
  - New inline `requireSameBrandOrSuperAdmin(serviceClient, callerId,
    callerAppRole, targetUserId)` helper — super_admin passes through;
    admin/master compare caller's vs target's `profiles.brand_id` via
    service-role lookups; 403 on mismatch. Auth-only targets (no
    profiles row) pass through (preserves prior cleanup behaviour).
    Return type is the discriminated union `BrandGate`; on the 200 path
    it carries `target: { brand_id, role } | null` so the outer handler
    can reuse the row instead of re-fetching.
  - Code-reviewer round-2 fixes:
    - **S1 (null-vs-null brand_id comparison gap)** — explicit null
      guard on `callerProfile.brand_id` before the strict-inequality
      check. Closes the narrow window where a caller with `brand_id IS
      NULL` (DB CHECK should prevent for admin/master, but mid-backfill
      / disabled-CHECK state is possible) attempting to delete a
      super_admin (also `brand_id IS NULL`) mispasses `null !== null`
      (which is `false` in JS).
    - **S2 (TOCTOU on profile reads)** — the helper's target read is
      now `select("brand_id, role")` in one round-trip; the outer
      last-of-role path consumes `brandGate.target.role` rather than
      issuing a second service-role read. For super_admin callers (who
      skip the brand-gate read entirely) and auth-only targets, the
      outer handler falls through to a single role lookup. Net read
      count: 1 (admin/master, target has profile), 1 (super_admin
      target has profile), 0 (admin/master, auth-only target),
      down from 2 pre-fix.
  - Wire-in order in `Deno.serve`: `requireAdminCaller` → parse `userId`
    → self-delete short-circuit → service-role client → new brand gate
    → existing `assert_not_last_of_role` → existing cascade deletes →
    `auth.admin.deleteUser`. Inline-not-shared per CLAUDE.md spec
    027/028.

### pgTAP tests
- `supabase/tests/profiles_rls_sweep.test.sql` (new) — 12 arms.
  Arms 1-6 SELECT (admin/super_admin/user — own / same-brand /
  cross-brand). Arms 7-9 DELETE (admin same-brand / admin cross-brand /
  super_admin cross-brand). Arms 10-12 no-regression
  (self-DELETE trigger, `assert_not_last_of_role` SECURITY DEFINER
  bypass, TRUNCATE REVOKE). Hermetic begin/rollback + JWT impersonation
  + reset-role-for-verification pattern. Code-reviewer round-2 **S3**
  cleanup: arm-11 comment rewritten to describe the actual SECURITY
  INVOKER failure mode (a SECURITY INVOKER helper would return 0 because
  `auth_can_see_brand` wraps an EXISTS comparing `brand_id =
  p_brand_id`, and `NULL = NULL` yields NULL/false in SQL — so any
  row with `brand_id IS NULL` such as super_admin would never satisfy
  the EXISTS for a brand-admin caller). Behavior of the arm is
  unchanged (comment-only edit).
- `supabase/tests/rls_hardening_followups.test.sql` (in-place patch) —
  three-line insertion before arm (9) verification SELECT:
  `reset role; select set_config('request.jwt.claims', '', true);`.
  Closes the regression where the verification SELECT relied on the
  soon-to-be-closed brand-blind admin SELECT path. No other arms
  modified. Empirical probe confirmed regression before patch
  (1 failing assertion) and 15/15 passing after. Code-reviewer
  round-2 stylistic nit: dropped the `(2026-05-17)` date from the
  arm-9 patch comment header to match the rest of the file.

### Verification

Captured empirically before and after applying the migration:

- **Pre-043 baseline**: `bash scripts/test-db.sh` → 27/27 file(s) passed
  (15/15 arms in `rls_hardening_followups.test.sql`).
- **Pre-043 probe B** (cross-brand SELECT as brand-A admin against
  synthetic brand-B target): 1 row returned (the LEAK).
- **Pre-043 probe C** (mimics arm-9 verification SELECT under admin
  JWT): returned `'Target B (test 042)'` (arm 9 worked because
  brand-blind admin SELECT admitted the cross-brand row).
- **Post-043 + pre-patch** (043 migration applied, arm 9 NOT yet
  patched): `rls_hardening_followups.test.sql` fails arm 9 with
  `# Failed test 9: have: NULL / want: Target B (test 042)`. Confirms
  the regression diagnosis.
- **Post-043 + arm-9 patch**: `rls_hardening_followups.test.sql` →
  15/15 ok. `profiles_rls_sweep.test.sql` → 12/12 ok.
  `auth_can_see_store_brand_scope.test.sql` → 14/14 ok.
- **Full suite**: `bash scripts/test-db.sh` → 28/28 file(s) passed.
- **`npm run typecheck`** → exit 0.
- **Edge function smoke** (live local stack, signed JWTs):
  - Cross-brand admin → brand-B target → HTTP 403,
    `{"error":"forbidden: target is in a different brand"}`,
    target row still present.
  - Same-brand admin → brand-A target → HTTP 200, `{"success":true}`,
    profile + auth.users both removed.
  - Promoted super_admin → brand-B target → HTTP 200,
    `{"success":true}`, profile removed.
- **Manual attack repro** (per user's prompt — cross-brand SELECT
  count under brand-A admin JWT): `cross_brand_visible = 0`.

#### Code-reviewer round-2 verification (S1 + S2 + S3 + nits)

- **S1 + S2 implementation** in `delete-user/index.ts`: discriminated
  union return types added to `requireAdminCaller` (`AdminGate`) and
  `requireSameBrandOrSuperAdmin` (`BrandGate`); helper consolidates to
  one `select("brand_id, role")` round-trip; explicit `if
  (!callerProfile.brand_id)` null guard before the strict-inequality
  brand match; outer handler reuses `brandGate.target?.role` and falls
  back to a single lookup only for super_admin callers / auth-only
  targets.
- **S3 implementation** in `profiles_rls_sweep.test.sql:398-420`:
  arm-11 comment rewritten to call out
  `auth_can_see_brand`'s `brand_id = p_brand_id` EXISTS with
  `NULL = NULL` SQL semantics as the actual reason a SECURITY INVOKER
  helper would count 0.
- **Nit (date stamp)** in `rls_hardening_followups.test.sql:418`:
  dropped `(2026-05-17)` from the patch-comment header.
- `npm run typecheck` → exit 0. `npm run typecheck:test` → exit 0.
- `bash scripts/test-db.sh supabase/tests/profiles_rls_sweep.test.sql`
  → 12/12 ok (comment-only S3 edit verified non-behavioral).
- `bash scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql`
  → 15/15 ok.
- `bash scripts/test-db.sh` → 28/28 file(s) passed.
- `bash scripts/smoke-edge-roles.sh` → all 6 arms pass (CORS,
  unauthorized, admin JWT, super_admin JWT, escape-test, last-super-admin
  delete refusal). Regression detector for the spec 027 super_admin
  ADMIN_ROLES gap and the spec 031 last-of-role guard.
- **Manual edge function smoke (round-2)** against the live local stack:
  - Cross-brand admin → brand-B target → HTTP 403,
    `{"error":"forbidden: target is in a different brand"}`; target row
    still present (`profiles` count = 1). Same outcome as round-1, now
    via the consolidated single-read path.
  - Same-brand admin → brand-A target → HTTP 200, `{"success":true}`;
    `profiles` count = 0 AND `auth.users` count = 0 post-delete.
    Exercises the new discriminated-union narrowing in `requireAdminCaller`,
    the consolidated `brand_id, role` read, the new caller-brand null
    guard (`callerProfile.brand_id` = brand A — non-null, passes), and
    reuse of `brandGate.target.role` ('user' → `assert_not_last_of_role`
    no-ops).
  - Promoted super_admin → brand-B target → HTTP 200, `{"success":true}`;
    `profiles` + `auth.users` both 0 post-delete. Exercises the
    super_admin short-circuit (`target: null`) and the new outer fallback
    role lookup (`gate.appRole === "super_admin"` branch).
- **S1 caller-with-null-brand_id case**: per reviewer note, hard to set
  up locally because the DB CHECK `profiles_role_brand_consistent`
  enforces non-null `brand_id` for admin/master rows. Static code-path
  review: if `callerProfile.brand_id` is falsy, the function returns
  `403 "forbidden: caller has no brand scope"` BEFORE reaching the
  strict-inequality check. Comment in the helper documents the
  reasoning. No behavioral change for the happy path (caller has a
  brand) — both round-1 and round-2 reach the same `!==` check.
