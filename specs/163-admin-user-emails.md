# Spec 163: Show real emails for every user on admin Users & Brands screens

Status: READY_FOR_REVIEW

## User story
As a brand admin (or super_admin) on the Cmd UI "Users & access" screen, I want to see each user's real login email, including accounts that were created without an invitation (for example the prod staff accounts "Towson Staff", "Charles Staff", "Frederick Staff"). That way I can tell accounts apart, send password resets, and stop seeing "(email not loaded)".

## Background / root cause
- `fetchAllUsers` ([src/lib/auth.ts:596](../src/lib/auth.ts)) reads `profiles` and guesses each user's email from `invitations` rows, matching on `profile_id` first and `name` second, via `fetchInvitationsForUserLookup` ([src/lib/db.ts:227](../src/lib/db.ts)). The client cannot read `auth.users`.
- So any account with no matching invitation row ends up with `email: ''`. In the Users screen that shows as "(email not loaded)", or as just `@username · shortId` when a username exists.
- `fetchBrandAdmins` ([src/lib/db.ts:5388](../src/lib/db.ts)) uses the same invitation-guessing for the Brands section members tab ([src/screens/cmd/sections/BrandsSection.tsx:972](../src/screens/cmd/sections/BrandsSection.tsx)), so it has the same problem.
- No current RPC returns other users' emails. Existing SECURITY DEFINER functions only read `auth.users` for the caller's own row.

## Acceptance criteria

### Backend (RPC)
- [ ] A new migration under `supabase/migrations/` creates a SECURITY DEFINER, STABLE SQL/plpgsql function in `public`. It returns a set of `(user_id uuid, email text)` built from `auth.users` joined to `public.profiles` on `id`. The exact name and argument list (none, or an optional id-array filter) are the architect's call. The name is used below as `<rpc>`.
- [ ] The function pins `search_path`, following the same pattern as the existing `auth_*` helpers.
- [ ] **Visibility matches the `profiles` SELECT policy exactly** ([supabase/migrations/20260517060000_profiles_rls_sweep.sql:96-101](../supabase/migrations/20260517060000_profiles_rls_sweep.sql)). A row for profile `p` is returned only if `public.auth_is_privileged() and public.auth_can_see_brand(p.brand_id)`. Concretely:
  - [ ] A `super_admin` caller gets a row for every profile in every brand, including profiles with `brand_id IS NULL`.
  - [ ] An `admin` caller gets rows only for profiles whose `brand_id` equals the caller's `brand_id`. Profiles in another brand and NULL-brand profiles return no row.
  - [ ] A `master` caller follows the same own-brand-only rule as `admin`.
  - [ ] A non-privileged authenticated caller (role `user`, staff) gets **zero rows**, not an error. That includes its own row.
  - [ ] The `anon` role cannot run the function; calling it raises permission denied.
- [ ] Only `auth.users` rows that have a matching `public.profiles` row are returned. Orphan auth users never appear.
- [ ] Explicit grants follow the spec 097 pattern: `revoke execute ... from public, anon;` and `grant execute ... to authenticated;` in the same migration.
- [ ] The migration adds no RLS policies. The permissive-policy lint (spec 053) is unaffected.

### Data layer
- [ ] A new exported helper in [src/lib/db.ts](../src/lib/db.ts) calls `<rpc>` through `useInflight.getState().track(..., { kind: 'read', label: ... })`. It returns a `Map<userId, email>` or an equivalent lookup. No other file calls `supabase.rpc('<rpc>')` directly.
- [ ] `fetchAllUsers` ([src/lib/auth.ts](../src/lib/auth.ts)) picks each active profile's `email` in this order:
  1. the `<rpc>` email for that `user_id`, if non-empty
  2. else the invitation match by `profile_id`
  3. else the invitation match by `name`
  4. else `''`
- [ ] `fetchBrandAdmins` ([src/lib/db.ts](../src/lib/db.ts)) uses the same order for its active (`profiles`-sourced) rows. Pending `invitation:<id>` rows keep using the invitation's own email, unchanged. The pending-row dedup against active emails (`activeEmails`) now uses the resolved emails.
- [ ] If `<rpc>` errors (network failure, permission denied, or function missing because prod has not been migrated yet), `fetchAllUsers` and `fetchBrandAdmins` still return their full user list, using invitation-based emails only. The failure is logged with `console.warn` and **no toast is shown**.
- [ ] If the `<rpc>` email and the invitation email differ for the same user, the `<rpc>` (`auth.users`) value is shown.

### UI
- [ ] With the RPC deployed, the Users identity line shows `@username · <email> · <shortId>` for an account that has a username and an `auth.users` email but no invitation. Example: a prod staff account like "Towson Staff".
- [ ] The staged identity-line logic in [src/screens/cmd/sections/UsersSection.tsx:373-378](../src/screens/cmd/sections/UsersSection.tsx) is kept unchanged: `@username`, then email, then shortId. "(email not loaded)" appears only when there is no username and no email. This spec makes no further rendering changes to that line.
- [ ] For a profile whose email now resolves through `<rpc>`, the Brands members tab shows the real email instead of "(email not loaded)".
- [ ] [src/screens/cmd/sections/phone/PhoneUsers.tsx](../src/screens/cmd/sections/phone/PhoneUsers.tsx) gets the emails for free through the shared `fetchAllUsers` host. It needs no code change.
- [ ] Two existing behaviors now apply to accounts that used to have no email. Neither one needs code changes. Both are listed here so reviewers expect them:
  - The SEND RESET action sends a password-reset email instead of showing the "No email on file" toast ([UsersSection.tsx:80-88](../src/screens/cmd/sections/UsersSection.tsx)).
  - The delete-confirm typed text (`requiredText`) becomes the email instead of the name, because `email || name` now resolves to the email.

### Tests
- [ ] **pgTAP** (new file under `supabase/tests/`) covers:
  - super_admin sees rows across two brands plus a NULL-brand profile
  - brand-A admin sees only brand-A rows (no brand-B row, no NULL-brand row)
  - master behaves the same as admin
  - a `user`-role caller gets 0 rows
  - anon gets permission denied
  - an orphan `auth.users` row with no profile is not returned
  - `has_function_privilege` checks: `authenticated` has EXECUTE; `anon` and `public` do not
  - the function is `prosecdef = true` with `search_path` pinned
- [ ] **jest**: `fetchAllUsers` and `fetchBrandAdmins` both have tests for:
  - RPC email beats invitation email
  - invitation fallback when the RPC has no row for that user
  - `''` when neither source has an email
  - the RPC throwing still returns the user list with invitation emails
- [ ] Existing mocks of `./db` that list exports explicitly are updated so the new helper is mocked: [src/lib/auth.signIn.test.ts](../src/lib/auth.signIn.test.ts), [src/lib/auth.fetchAllUsers.test.ts](../src/lib/auth.fetchAllUsers.test.ts), [src/lib/db.fetchBrandAdmins.test.ts](../src/lib/db.fetchBrandAdmins.test.ts), and [src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx](../src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx) if affected. Full `npx jest`, `typecheck`, and `typecheck:test` pass.

### Rollout
- [ ] The migration is applied to prod (project `ebwnovzzkwhsdxkpyjka`) through the Supabase MCP: run the migration SQL with `execute_sql`, insert the exact migration version into `supabase_migrations.schema_migrations`, and confirm the deployed function body matches the repo using the normalized-md5 check.
- [ ] After the push to `main`, the latest runs of both `.github/workflows/test.yml` and `.github/workflows/db-migrations-applied.yml` on `main` are green.

## In scope
- One new SECURITY DEFINER read RPC returning `(user_id, email)` for profiles the caller is allowed to see, with explicit grants
- A new `db.ts` helper that calls it
- Wiring it as the main email source in `fetchAllUsers` (Users screen, desktop and phone) and `fetchBrandAdmins` (Brands members tab), keeping invitation-based emails as the fallback
- pgTAP and jest coverage as listed above
- Applying the migration to prod via MCP

## Out of scope (explicitly)
- **Removing invitation-based email lookup.** It stays as the fallback (user-approved direction). Removing it can be a later cleanup once the RPC is proven in prod.
- **Adding an `email` column to `profiles` or a sync trigger from `auth.users`.** This would be a bigger schema change with its own drift risk. The RPC reads the source of truth directly.
- **Changing who appears on the Users or Brands screens.** The profiles query and its brand filter are unchanged. Only the `email` field changes.
- **Changing the UsersSection identity-line format or the staged username change.** That work is already done and must not be undone.
- **Removing the unused `brandId?` parameter of `fetchInvitationsForUserLookup`.** This is unrelated tidy-up.
- **Showing emails in the staff app or any non-admin surface.** Non-privileged callers get zero rows by design.
- **Letting admins edit a user's email.** Not requested.
- **Realtime refresh of emails.** The screens already reload on mount and after changes, and `auth.users` is not in the realtime publication.

## Open questions resolved
- Q: Should `master` see all users' emails across brands ("super_admin/master see all" in the request), or follow the `profiles` SELECT policy? → A: Follow the policy, as the request also explicitly asks. Since spec 043, `master` (like `admin`) sees only its own brand. Only `super_admin` sees every brand. Returning emails for profiles a master can't load would serve no purpose and would leak PII across brands. *(Resolved by PM from the request's explicit "match the profiles SELECT policy" instruction. Flag this if you intended masters to see across brands.)*
- Q: Is the Brands members tab (`fetchBrandAdmins`) in scope? → A: Yes. The same RPC covers it directly, because it uses the same profile visibility and needs the same per-user email lookup for its active rows.
- Q: How should a non-privileged caller be refused: error or empty result? → A: Empty result (0 rows) for authenticated non-privileged callers, matching how RLS refuses reads. `anon` has no EXECUTE grant, so it gets permission denied.
- Q: If the RPC email and the invitation email disagree, which wins? → A: The RPC (`auth.users`) value. It is the real login identity, while the invitation email can be out of date.
- Q: What happens if the RPC fails? → A: The list still loads using invitation-based emails only, with a `console.warn` and no toast. This also makes the frontend safe to ship before or after the prod migration.
- Q: Which test tracks? → A: pgTAP for the RPC's visibility, grant, and definer properties. jest for the email order and fallback in `fetchAllUsers` / `fetchBrandAdmins`. No shell smoke is needed: no edge function is involved.
- Q: Web and native, or web only? → A: Both. This is a data-layer change with no platform-specific APIs.

## Dependencies
- The staged, uncommitted username-on-identity-line change in [src/screens/cmd/sections/UsersSection.tsx](../src/screens/cmd/sections/UsersSection.tsx). This spec builds on it and must not revert it.
- Existing helpers `public.auth_is_privileged()`, `public.auth_can_see_brand(uuid)`, and `public.auth_is_super_admin()` ([supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
- The spec 043 `profiles` SELECT policy, which defines the visibility contract
- The spec 097 explicit-grant pattern ([supabase/migrations/20260618000000_public_grants_explicit.sql](../supabase/migrations/20260618000000_public_grants_explicit.sql))
- The pgTAP runner at `scripts/test-db.sh`
- Supabase MCP access to prod for rollout

## Project-specific notes
- **Cmd UI section:** `src/screens/cmd/sections/UsersSection.tsx` (desktop) and `phone/PhoneUsers.tsx`, both through `fetchAllUsers`, plus `src/screens/cmd/sections/BrandsSection.tsx` members tab through `fetchBrandAdmins`. No section files are expected to change. All changes are in the data layer (`src/lib/db.ts`, `src/lib/auth.ts`).
- **Per-store or admin-global:** Brand-scoped, not per-store. Visibility is `auth_is_privileged() and auth_can_see_brand(profile.brand_id)`, with super_admin seeing everything. `auth_can_see_store()` is not involved.
- **Realtime channels touched:** None.
- **Migrations needed:** Yes. One migration with the RPC and explicit grants. It must be applied to prod via MCP and recorded in `schema_migrations`, or the `db-migrations-applied` gate goes red.
- **Edge functions touched:** None. This is a PostgREST RPC called through `src/lib/db.ts`.
- **Web/native scope:** Both.
- **Security note for the architect and auditor:** This RPC exposes PII (emails) from `auth.users` through a SECURITY DEFINER function. The visibility predicate must be enforced inside the function body, because RLS does not apply to definer reads of `auth.users`. Any caller-supplied filter argument may only narrow the result, never widen it.
- **`app.json` slug:** Not touched.

## Backend design

### 0. Summary of decisions

| Decision | Choice |
|---|---|
| RPC name / signature | `public.get_profile_emails(p_user_ids uuid[]) returns table (user_id uuid, email text)` |
| Argument | **Required** id array, narrow-only. `NULL` or `'{}'` returns 0 rows (fail-closed). There is no "return everything" mode. |
| Language / volatility | `language sql`, `stable`, `security definer`, `set search_path = public, auth` (the same shape as `auth_is_super_admin` / `auth_can_see_brand` / `auth_is_privileged`, [20260509000000_multi_brand_schema_rls.sql:187-239](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)) |
| Visibility predicate | `public.auth_is_privileged() and public.auth_can_see_brand(p.brand_id)`, copied **verbatim** from the privileged arm of the spec-043 `"Admins can read all profiles"` policy ([20260517060000_profiles_rls_sweep.sql:98-101](../supabase/migrations/20260517060000_profiles_rls_sweep.sql)). The self-arm (`or id = auth.uid()`) is **deliberately left out** (AC: non-privileged callers get 0 rows, own row included). |
| Grants | `revoke all on function … from public, anon;` then `grant execute on function … to authenticated;`. This is the spec-162 idiom ([20260829000000_auto_place_order_attempts.sql:368-378](../supabase/migrations/20260829000000_auto_place_order_attempts.sql)). |
| db.ts helper | `fetchProfileEmails(userIds: string[]): Promise<Map<string, string>>`. It **throws** on RPC error, like every other db.ts reader. The two consumers catch it locally and fall back. |
| Realtime | None. No publication change. |
| Edge functions | None. |
| Who builds | `backend-developer` only. All changes are in the migration, pgTAP, `src/lib/db.ts`, `src/lib/auth.ts`, and jest. No section/UI file changes. |

### 1. Data model changes

- **No tables, columns, or indexes.** The RPC joins `public.profiles.id` (PK) to `auth.users.id` (PK). Both lookups are PK-indexed.
- **Migration:** `supabase/migrations/20261008000000_get_profile_emails.sql`. The latest on disk is `20260829000100_store_addresses_for_auto_place.sql`, so this sorts last. Before committing, the developer must re-check that no newer migration has landed and bump the timestamp if one has.
- **Additive only.** It creates one function plus its grants and comment. Nothing is dropped or altered. Rollback is `drop function public.get_profile_emails(uuid[]);`, and the client degrades to invitation-only emails because of §5's fallback. There is no down migration (repo convention).
- **Migration contents, in order** (pseudocode, not committed SQL):
  1. Header comment covering the spec reference, the PII rationale, and the lockstep note in §7 R1. It must also say "REALTIME: no publication change".
  2. `create or replace function public.get_profile_emails(p_user_ids uuid[]) returns table (user_id uuid, email text) language sql stable security definer set search_path = public, auth as $$ … $$;`
     Body:
     ```
     select p.id, u.email::text
       from public.profiles p
       join auth.users      u on u.id = p.id          -- inner join: orphan auth users never appear
      where p.id = any(p_user_ids)                     -- narrow-only; NULL/empty array -> 0 rows
        and public.auth_is_privileged()                -- verbatim spec-043 privileged arm …
        and public.auth_can_see_brand(p.brand_id)      -- … (super_admin short-circuits inside)
        and coalesce(u.email, '') <> ''                -- phone-only / blank auth users emit no row
     ```
     Every relation and function reference is schema-qualified, so the pinned `search_path` is belt-and-suspenders, not load-bearing. Cast `auth.users.email` (`varchar(255)`) to `text` so it matches the declared return type. Use `language sql`, not plpgsql. With `RETURNS TABLE (user_id, email)`, plpgsql would turn the output columns into variables that collide with unqualified column references. SQL has no such hazard, and it matches the `auth_*` helpers.
  3. `comment on function public.get_profile_emails(uuid[]) is '…'`. Name spec 163 and state the lockstep rule: "visibility MUST equal the privileged arm of the profiles SELECT policy `Admins can read all profiles`; change both together."
  4. `revoke all on function public.get_profile_emails(uuid[]) from public, anon;`
     `grant execute on function public.get_profile_emails(uuid[]) to authenticated;`
     **Revoking from `public` is load-bearing.** `CREATE FUNCTION` grants EXECUTE to PUBLIC, and anon inherits it. On top of that, spec 097's `ALTER DEFAULT PRIVILEGES … grant all on functions to anon, authenticated, service_role` ([20260618000000_public_grants_explicit.sql:205-206](../supabase/migrations/20260618000000_public_grants_explicit.sql)) gives anon an **explicit** grant. So both `public` and `anon` must appear in the revoke. `service_role` keeps its default-privilege grant. That is harmless: it has no `auth.uid()`, so `auth_is_privileged()` is false and the call returns 0 rows.

### 2. RLS impact

- **No policies added, changed, or dropped.** The spec-053 permissive lint ([supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)) and the spec-157 LINT-1 (which scans `pg_policies` predicates only, not function bodies) are unaffected.
- **Why the predicate must live in the body:** the function is `SECURITY DEFINER`, owned by `postgres`. RLS on `public.profiles` does not filter definer reads, and `auth.users` has no client-facing RLS. The `where` clause is the **only** gate. `auth.uid()` / `auth.jwt()` still resolve to the *caller* inside a definer function, because they read the `request.jwt.claims` GUC and not `current_user`. That is why the helper calls behave the same as they do inside a policy.
- **Predicate truth table** (this is the AC contract; the pgTAP below pins every row):

| Caller | `auth_is_privileged()` | `auth_can_see_brand(p.brand_id)` | Result |
|---|---|---|---|
| super_admin (profiles.role, brand NULL) | true (via `auth_is_super_admin`) | true for every brand **and** for NULL (short-circuit) | all requested profiles, NULL-brand included |
| admin, brand A (JWT `app_metadata.role='admin'`) | true (via `auth_is_admin`) | true only when `p.brand_id = A`. `NULL = A` is false. | own-brand rows only |
| master, brand A | true (`auth_is_admin` covers `'master'`) | same as admin | own-brand rows only (the confirmed PM decision) |
| user / staff | false | n/a | 0 rows, own id included, no error |
| anon | no EXECUTE grant | n/a | `42501 permission denied for function` |

- **The caller filter can only narrow.** `p_user_ids` only ever ANDs in. Passing an out-of-brand id returns nothing, exactly as if the id did not exist. This gives no existence oracle beyond what the profiles SELECT policy already exposes.

### 3. API contract

**PostgREST RPC** (not a view). A view over `auth.users` would need `security_invoker = false` plus grants on an `auth`-schema join. That is a wider and less reviewable surface than one definer function with an explicit body gate.

- **Request:** `POST /rest/v1/rpc/get_profile_emails` with body `{ "p_user_ids": ["<uuid>", …] }`. supabase-js: `supabase.rpc('get_profile_emails', { p_user_ids: ids })`.
- **Response:** `200` with `[{ "user_id": "<uuid>", "email": "<text>" }, …]`. Order is unspecified; consumers index by `user_id`. Ids that are not visible, not found, or have no email are simply absent.
- **Error cases:**
  - `42501` permission denied: anon (no session). The client never hits this in practice, because the admin Cmd UI is session-gated.
  - `22P02` invalid input syntax for uuid: any element is not a uuid. **The whole call fails.** Consumers must pass only real `profiles.id` values, never the synthetic `invitation:<id>` ids from `fetchBrandAdmins`' pending rows (§5).
  - `PGRST202` function not found in schema cache: prod has not been migrated yet, or the PostgREST cache is stale (§8).
  - Network / `InflightTimeoutError` (30s hard abort from [src/lib/inflight.ts](../src/lib/inflight.ts)).
  - All of these are handled the same way by the consumer fallback in §5.

### 4. Edge function changes

None. No `verify_jwt` change in [supabase/config.toml](../supabase/config.toml).

### 5. `src/lib/db.ts` surface

**New helper.** Place it directly below `fetchInvitationsForUserLookup` ([src/lib/db.ts:227](../src/lib/db.ts)) so the email-source helpers sit together:

```ts
/** Spec 163 — real login emails (auth.users) for the given profile ids, limited
 *  server-side to profiles the caller may see (privileged arm of the spec-043
 *  profiles SELECT policy). Non-privileged callers get an empty map. Throws on
 *  RPC error; callers that must degrade gracefully catch it locally. */
export async function fetchProfileEmails(userIds: string[]): Promise<Map<string, string>>
```

Behavior contract:
- Dedupe `userIds`. If the result is empty, return `new Map()` **without** a network call.
- `useInflight.getState().track(async (signal) => { … }, { kind: 'read', label: 'fetchProfileEmails' })`.
- `const { data, error } = await supabase.rpc('get_profile_emails', { p_user_ids: ids }).abortSignal(signal);`. Thread the signal per the spec-055 discipline, the same way the sibling RPC wrappers at [db.ts:364](../src/lib/db.ts) and [db.ts:595](../src/lib/db.ts) do.
- `if (error) throw error;`
- Map snake_case to the lookup: `row.user_id` becomes the key and `row.email` the value. Skip any row whose email is falsy (defense-in-depth on top of the SQL `<> ''` filter). There is no camelCase object type. The `Map<userId, email>` *is* the mapped shape.
- This is the **only** `supabase.rpc('get_profile_emails')` call site in the repo.

**Email precedence (both consumers, identical):**

```
email = rpcEmails.get(p.id) || (invByProfileId.get(p.id) ?? invByName.get(p.name))?.email || ''
```

This is an inline expression, with no new shared helper. Both loaders already duplicate the invitation-index block, and pulling one out would widen the `./db` mock surface in `auth.fetchAllUsers.test.ts` for no gain.

**Graceful-degradation wrapper (required shape).** Each consumer wraps the call in a local **`async` function with `try { return await fetchProfileEmails(ids) } catch (e) { console.warn('[<loader>] fetchProfileEmails failed; falling back to invitation emails:', e?.message || e); return new Map(); }`**. No toast, no `notifyBackendError`.
- **This must be an `async` function with `try/await/catch`, not `fetchProfileEmails(ids).catch(…)` chaining.** In the existing jest suites that mock `./db` with an explicit export list, an un-mocked `fetchProfileEmails` is `undefined`. Calling it throws a **synchronous** `TypeError`. `.catch()` chaining would not catch that, and inside `Promise.all([...])` it would escape to `fetchAllUsers`' outer `catch { return [] }` and **blank the whole Users list**, which is exactly the failure the spec forbids. An `async` wrapper turns the sync throw into a rejection it catches itself.

**`fetchAllUsers` ([src/lib/auth.ts:596](../src/lib/auth.ts)):**
- Import `fetchProfileEmails` from `./db` next to the existing `fetchInvitationsForUserLookup` / `fetchStoreIdsForBrand` imports.
- After `userIds` is computed (line 610), start the safe email fetch **concurrently** with the existing invitation read, e.g. `const [invitations, rpcEmails] = await Promise.all([fetchInvitationsForUserLookup(opts?.brandId), safeEmails(userIds)])`. It needs only `userIds`, so it can also overlap the `user_stores` / `fetchStoreIdsForBrand` reads. The developer chooses the exact overlap; the requirement is that it adds no extra serial round-trip.
- Replace `email: invitation?.email || ''` (line 664) with the precedence expression above.
- Delete the stale comment at lines 635-637 ("We can't query auth.users from client…"). It is now false. Replace it with a one-line pointer to spec 163.
- No other behavior change. The profiles query, brand filter, store clipping, and the `master` → `'MASTER'` name override all stay.

**`fetchBrandAdmins` ([src/lib/db.ts:5388](../src/lib/db.ts)):**
- After `userIds` is computed (line 5428), run the safe email fetch **concurrently** with the `user_stores` follow-up read: `Promise.all([userStoresRead, safeEmails(userIds)])`. Only pass `userIds` from `profilesRes`, **never** pending `invitation:<id>` ids (22P02 risk, §3).
- Calling `fetchProfileEmails` from inside the outer `track()` creates a nested `track()`. That is acceptable: the inflight counter goes 2 → 1 → 0, and the inner call has its own 30s abort. Do **not** call `supabase.rpc` inline to reuse the outer signal; one call site is the contract.
- `activeRows[].email` uses the precedence expression (line 5471).
- `activeEmails` (line 5499) needs no code change. It is derived from `activeRows`, so it automatically dedups against the resolved emails. **Expected behavior change, called out for reviewers:** an unconsumed brand-scoped invite whose email matches an active user's `auth.users` email (but which was never linked by `profile_id` or name) is now suppressed as a pending row. Before this change it showed up as a phantom "pending" duplicate. That is the intended outcome of the AC.
- Pending rows keep `email: inv.email`, unchanged.
- The outer `if (profilesRes.error) throw profilesRes.error;` stays. Only the email fetch degrades gracefully. A profiles failure still propagates to `loadBrandAdmins`' existing `console.warn` ([src/store/useStore.ts:1770-1772](../src/store/useStore.ts)).

### 6. Realtime impact

**None.** No `supabase_realtime` publication change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply to this migration. `auth.users` is not (and must not be) in the publication. Neither `store-{id}` nor `brand-{id}` carries this data. The Users / Brands screens already refetch on mount and after their own mutations.

### 7. Frontend store impact

- **None in [src/store/useStore.ts](../src/store/useStore.ts).** `loadBrandAdmins` (line 1760) is unchanged. `UsersSection` / `PhoneUsers` keep calling `fetchAllUsers` directly, and `BrandsSection` keeps reading `brandAdminsByBrandId`.
- The **optimistic-then-revert + `notifyBackendError` pattern does not apply**. This is a read-only enrichment, and the spec explicitly forbids a toast on RPC failure.
- **[src/screens/cmd/sections/UsersSection.tsx](../src/screens/cmd/sections/UsersSection.tsx) must not be edited.** Its staged (uncommitted) identity-line change at lines 373-378 is a dependency of this spec. The developer must leave the file's staged state intact: no `git checkout`, `git stash`, or reformat on that path. The same applies to `BrandsSection.tsx` and `phone/PhoneUsers.tsx`.

### 8. Tests

**pgTAP: `supabase/tests/get_profile_emails.test.sql`**, hermetic `begin; … rollback;`, `select plan(18);`.

Fixtures (inserted as `postgres`, mirroring [supabase/tests/profiles_rls_sweep.test.sql:63-137](../supabase/tests/profiles_rls_sweep.test.sql)):
- Seed: admin `11111111-…` (admin, brand A `2a000000-0000-0000-0000-000000000001`), manager `22222222-…` (user, brand A), master `33333333-…` (master, brand A). **Do not promote the master.** The master arm needs it as a master.
- Synthetic brand B `b2000000-0000-0000-0000-000000000163`.
- Synthetic `auth.users` + `profiles` rows, with all token columns set to `''` (see the NULL-token gotcha), and emails following the `*-163@local.test` pattern:
  - `T_A` (user, brand A)
  - `T_B` (user, brand B)
  - `T_NULL` (user, `brand_id NULL`; the CHECK allows this for `role='user'`)
  - `SA` (**super_admin**, `brand_id NULL`). This is a synthetic super_admin, so the seed master stays a master. No profiles INSERT trigger blocks a `postgres`-role insert.
- `ORPHAN`: an `auth.users` row with **no** profiles row. There is no `on auth.users` trigger that would auto-create one (verified).
- Impersonation: `set local role authenticated` + `set_config('request.jwt.claims', jsonb{sub, role:'authenticated', app_metadata:{role:…}}, true)`. Use `reset role` + cleared claims between principals, per the existing pattern.

| # | Arm | Assertion |
|---|---|---|
| 1 | exists | `has_function('public','get_profile_emails', array['uuid[]'])` |
| 2 | definer | `pg_proc.prosecdef = true` for `'public.get_profile_emails(uuid[])'::regprocedure` |
| 3 | search_path pinned | `proconfig` contains `'search_path=public, auth'` |
| 4 | stable | `provolatile = 's'` |
| 5 | authenticated EXECUTE | `has_function_privilege('authenticated', …, 'EXECUTE')` |
| 6 | anon denied | `not has_function_privilege('anon', …, 'EXECUTE')` |
| 7 | PUBLIC denied | `not has_function_privilege('public', …, 'EXECUTE')` |
| 8 | super_admin cross-brand | as SA, ids `[T_A,T_B,T_NULL]` gives 3 rows |
| 9 | super_admin email value | as SA, the `T_B` row's `email` equals its fixture email exactly |
| 10 | orphan excluded | as SA, ids `[ORPHAN]` gives 0 rows |
| 11 | admin own-brand | as admin A, `[T_A]` gives 1 row with the correct email |
| 12 | admin cross-brand | as admin A, `[T_B]` gives 0 rows |
| 13 | admin NULL-brand | as admin A, `[T_NULL, SA]` gives 0 rows |
| 14 | master own-brand | as master A (JWT `role:'master'`), `[T_A]` gives 1 row |
| 15 | master cross/NULL | as master A, `[T_B, T_NULL]` gives 0 rows |
| 16 | user gets nothing | as manager (JWT `role:'user'`), the full fixture id list **including its own id `22222…`** gives 0 rows, no error (`lives_ok` not needed; a count of 0 implies it ran) |
| 17 | NULL array | as admin A, `get_profile_emails(null)` gives 0 rows |
| 18 | empty array | as admin A, `get_profile_emails('{}')` gives 0 rows |

**Spec AC adjustment (test mechanism only, intent unchanged):** the AC "anon gets permission denied" is pinned with the catalog check (arms 6-7), **not** with `set role anon` + `throws_ok`. `set role anon` segfaults the CI Postgres image (spec 067; see [supabase/tests/reports_anon_revoke.test.sql:36-40](../supabase/tests/reports_anon_revoke.test.sql) and about 10 sibling files). No EXECUTE privilege is exactly what produces the runtime 42501, so the catalog check is the equivalent assertion. Run it via `scripts/test-db.sh`. The "planned N but ran M" detector requires all 18 arms to execute.

**jest:**
- [src/lib/auth.fetchAllUsers.test.ts](../src/lib/auth.fetchAllUsers.test.ts): add `fetchProfileEmails: (ids: string[]) => mockFetchProfileEmails(ids)` to the `./db` mock, with a per-test `Map` or `mockRejectedValue`. New cases:
  - the RPC email beats an invitation email for the same user
  - invitation fallback (profile_id, then name) when the RPC map lacks the user
  - `''` when neither source has the user
  - the RPC rejecting still returns the full list with invitation emails, and calls `console.warn` (spy) with **no** toast
  - one extra guard case: `fetchProfileEmails` mocked as a **synchronous throw** still returns the full list. This pins the §5 async-wrapper requirement.
  - Existing spec-083 cases must still pass unchanged, with the default mock returning an empty `Map`.
- [src/lib/db.fetchBrandAdmins.test.ts](../src/lib/db.fetchBrandAdmins.test.ts): extend the `./supabase` mock with `rpc: (fn, args) => mockRpc(fn, args)` returning a builder whose `.abortSignal()` resolves to a per-test `rpcResult`. The default is `{ data: [], error: null }`. Same four cases, plus:
  - the RPC is called with **only** profile ids (no `invitation:` ids)
  - pending-row dedup now suppresses an unconsumed invite whose email matches an RPC-resolved active email
  - Existing spec-082/084 cases must stay green.
- [src/lib/auth.signIn.test.ts](../src/lib/auth.signIn.test.ts): add `fetchProfileEmails: jest.fn()` to the explicit `./db` mock list.
- [src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx](../src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx) mocks `lib/auth` (`fetchAllUsers`), not `lib/db`, so it is **unaffected**. Confirm and leave it alone. The Proxy-based `lib/db` mocks elsewhere auto-stub any new export.
- Per the project memory: grep for tests pinning `email: ''` / "(email not loaded)" behavior and run the **full** `npx jest`, `npm run typecheck`, and `npm run typecheck:test`. `typecheck:test` is a separate CI gate that jest does not cover.

### 9. Rollout (dev and prod)

1. **Local:** `npm run dev:db` (or `npx supabase migration up` against the running stack), then `scripts/test-db.sh`. No realtime restart is needed (§6).
2. **Prod via Supabase MCP** (project `ebwnovzzkwhsdxkpyjka`, per the established runbook):
   - `execute_sql` with the migration body
   - insert version `20261008000000` (the exact filename prefix, plus name `get_profile_emails`) into `supabase_migrations.schema_migrations`
   - verify with the normalized-md5 comparison of `pg_get_functiondef('public.get_profile_emails(uuid[])'::regprocedure)` against the repo body
   - also verify `select has_function_privilege('anon', 'public.get_profile_emails(uuid[])', 'EXECUTE')` returns `false` in prod
3. **PostgREST schema cache:** Supabase's DDL event trigger normally reloads it. If the first client call returns `PGRST202`, run `notify pgrst, 'reload schema';` once. The client fallback hides this from users, which is why step 4 exists.
4. **Functional verification must go through the UI.** MCP `execute_sql` runs as `postgres` with no JWT, so `auth.uid()` is NULL and the RPC correctly returns 0 rows. An empty result from MCP is **not** evidence of breakage, and it is not evidence of success either. Sign in as a prod admin, open Users & access, and confirm that "Towson Staff" (or a similar no-invitation account) shows a real email.
5. **Ordering vs the gate:** apply to prod **before** pushing the migration file to `main`, so `db-migrations-applied.yml` never goes red. The client code is safe in either order because of the fallback. After the push, confirm that the latest runs of both `test.yml` and `db-migrations-applied.yml` on `main` are green (CLAUDE.md hard rule). Per memory, also check `e2e.yml` manually.

### 10. Risks and tradeoffs

- **R1 — Policy/function drift (PII leak class).** The function copies the profiles SELECT predicate instead of inheriting it. If a future spec changes `"Admins can read all profiles"` (for example a role-hierarchy spec), this function will not follow automatically. Mitigations: the `comment on function` lockstep note, and pgTAP arms 8-16 encoding the same matrix as `profiles_rls_sweep.test.sql` arms 1-6, so a change to one surfaces in review of the other. A stronger option is a pgTAP parity arm comparing `get_profile_emails(ids)` with `select id from profiles where id = any(ids)` under the same JWT, excluding the self-arm. It was rejected as over-engineering for v1, and can be added if a reviewer wants it.
- **R2 — Silent degradation hides a broken prod RPC.** By design (AC), a failing RPC only `console.warn`s. Mitigation: rollout step 4 (UI verification) is mandatory, not optional.
- **R3 — Stale JWT role.** `auth_is_admin()` reads `app_metadata.role` from the JWT, so a just-demoted admin keeps email visibility until token refresh (≤ 1h). This is identical to every existing RLS policy built on `auth_is_privileged()`, so it is accepted and not new.
- **R4 — 22P02 on a bad id** fails the whole call and falls back silently. Mitigated by passing only `profilesRes` / `profiles` ids (§5) and by the jest case asserting the RPC args.
- **R5 — `has_function_privilege` vs runtime anon.** Pinned by the catalog check because of the spec-067 segfault (§8). The prod verification query in step 2 closes the same gap in prod.
- **R6 — Performance.** Negligible. The profile set per call is on the order of tens of rows. `auth_can_see_brand` does one PK lookup on `profiles` per row, and the join is PK-to-PK. The 286 KB seed has a handful of profiles. Running concurrently with existing reads (§5) adds no serial round-trip. The nested `track()` in `fetchBrandAdmins` briefly double-counts in the top progress bar, which is cosmetic.
- **R7 — Edge cold start.** N/A (no edge function).
- **R8 — Migration ordering.** Single additive migration that depends only on helpers from `20260509000000` and the profiles schema. The timestamp sorts last. Bump it if anything newer lands first.
- **R9 — UI side effects (expected, no code change):** SEND RESET now works for formerly email-less accounts. The delete-confirm `requiredText` becomes the email. The Brands pending-row dedup gets stricter (§5). Reviewers should treat these as intended.
- **Spec background correction (non-blocking):** "Existing SECURITY DEFINER functions only read auth.users for the caller's own row" is slightly off. `public.preview_brand_cascade` ([20260510010000_brand_delete_cascade.sql:491-519](../supabase/migrations/20260510010000_brand_delete_cascade.sql)) already returns other users' emails, gated to super_admin. This does not change the design, but `get_profile_emails` is the first such reader exposed to brand admins/masters.

### 11. Expected files changed

- `supabase/migrations/20261008000000_get_profile_emails.sql` (new)
- `supabase/tests/get_profile_emails.test.sql` (new)
- `src/lib/db.ts` (`fetchProfileEmails` added; `fetchBrandAdmins` wired)
- `src/lib/auth.ts` (`fetchAllUsers` wired; stale comment replaced)
- `src/lib/auth.fetchAllUsers.test.ts`, `src/lib/db.fetchBrandAdmins.test.ts`, `src/lib/auth.signIn.test.ts`
- **Not changed:** `src/screens/cmd/sections/UsersSection.tsx` (staged change preserved), `BrandsSection.tsx`, `phone/PhoneUsers.tsx`, `src/store/useStore.ts`, `supabase/config.toml`, `app.json`.

## Files changed

Implemented by backend-developer, local only. Nothing has been applied to prod, committed, or staged.

**Migrations**
- `supabase/migrations/20261008000000_get_profile_emails.sql` (new). Creates `public.get_profile_emails(uuid[])` as `language sql stable security definer set search_path = public, auth`, adds a lockstep `comment on function`, runs `revoke all … from public, anon`, and runs `grant execute … to authenticated`. No publication change.

**pgTAP**
- `supabase/tests/get_profile_emails.test.sql` (new). `plan(18)`, with arms 1-18 as described in §8.

**src/lib/db.ts**
- `fetchProfileEmails(userIds)` added below `fetchInvitationsForUserLookup`. It dedupes the ids, returns early with an empty Map when there are none, calls `track(kind:'read')` and `.abortSignal(signal)`, and throws on error. This is the only `get_profile_emails` call site.
- `fetchBrandAdmins` now runs a `safeProfileEmails` async try/await wrapper in parallel with the `user_stores` read through `Promise.all`. It passes only profile ids. The precedence is `rpcEmails.get(p.id) || fallback?.email || ''`. Pending rows are unchanged.

**src/lib/auth.ts**
- `fetchAllUsers` imports `fetchProfileEmails`. It starts a `safeProfileEmails` async try/await wrapper right after `userIds` is computed, so the call overlaps the `user_stores`, `fetchStoreIdsForBrand`, and invitation reads, and is awaited together with the invitations through `Promise.all`. The stale "can't query auth.users" comment is replaced with a pointer to spec 163. Email precedence follows §5.

**jest**
- `src/lib/auth.fetchAllUsers.test.ts`: adds `fetchProfileEmails` to the `./db` mock, which returns an empty Map by default. Adds 5 spec-163 cases: RPC wins, invitation fallback by id and then by name, `''`, rejection falls back with a warn and no toast, and a synchronous throw falls back.
- `src/lib/db.fetchBrandAdmins.test.ts`: adds `supabase.rpc` to the mock. Adds 8 spec-163 cases: RPC wins, fallback, `''`, an RPC error falls back with a warn and no toast, a synchronous rpc throw falls back, only profile ids are sent, the RPC is skipped when there are no profiles, and pending dedup matches against the RPC email.
- `src/lib/auth.signIn.test.ts`: adds `fetchProfileEmails: jest.fn()` to the explicit `./db` mock list.
- `src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx`: confirmed it is unaffected (it mocks `lib/auth`). Not changed.

**Not changed:** `src/screens/cmd/sections/UsersSection.tsx` (its staged change is preserved), `BrandsSection.tsx`, `phone/PhoneUsers.tsx`, `src/store/useStore.ts`, `supabase/config.toml`, `app.json`.

### Local verification
- Migration applied to the local DB with `psql -f`. `npx supabase migration up` was not used, because local `schema_migrations` is missing `20260819000000`, `20260829000000`, and `20260829000100` even though their objects are present, so `migration up` would try to re-run them. The new version is also not recorded in local `schema_migrations`, which matches those three.
- `bash scripts/test-db.sh supabase/tests/get_profile_emails.test.sql`: 18/18 passed. Mutation check: with the `auth_is_privileged()` gate removed and a self-arm added, the file fails arm 16 as expected.
- `npm run test:db`: 86/86 files passed, including `permissive_policy_lint`.
- `npx jest`: 218 suites and 2519 tests passed. `npx tsc --noEmit -p .` and `npm run typecheck:test` both exit 0.
- PostgREST end-to-end against the local stack:
  - `admin@local.test` gets emails for all 3 local profiles. None of those profiles has an invitation row, so all 3 were "(email not loaded)" before this change.
  - `manager@local.test` (role `user`) gets `[]` with HTTP 200.
  - The anon key gets `42501 permission denied for function get_profile_emails`.

### Not done (outside this run's scope)
- The prod rollout (§9 steps 2-5) is pending user approval.
- In-browser UI verification of the Users and Brands screens was not done. The data-layer path was checked over HTTP only.
