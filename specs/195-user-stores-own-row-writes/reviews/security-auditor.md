## Security audit for spec 195

Auditor: security-auditor, 2026-11-09. Scope: `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`, `supabase/tests/user_stores_own_row_writes.test.sql`, the arm (9) edit in `supabase/tests/legacy_permissive_policy_dropout.test.sql`, and the AC-16 note in `specs/164-profiles-insert-hardening.md`.

### What I ran and what I only read

**Ran**, on `supabase_db_imr-inventory` with the 195 migration already applied locally (`schema_migrations` has `20261109195000`; `pg_policies` shows 2 policies on `user_stores`):
- Two probe scripts. Each ran in one transaction that ended in `ROLLBACK`. Callers were simulated the PostgREST way (`set local role authenticated|anon` plus `request.jwt.claims`). Afterwards 0 probe rows remained in `auth.users`, `brands`, `invitations` and `user_stores`, and the admin policy md5 was unchanged (`b05a4d44…` for both qual and with_check).
- One fail-closed probe: the migration's DO block run against a widened admin arm, in a rolled-back transaction.
- Catalog queries: every function whose `prosrc` mentions `user_stores`, every function using dynamic identifiers (`%I`, `quote_ident`, `execute format`), table grants, triggers, and the policies on `user_stores`, `profiles` and `invitations`.
- pg_graphql introspection and mutations through `graphql.resolve()`.
- `scripts/test-db.sh` on `user_stores_own_row_writes` (23/23), `legacy_permissive_policy_dropout` (13/13), `profiles_insert_hardening` and `user_stores_brand_match_null_brand`. All passed.

**Read only:** `manage-store-user`, `delete-user`, the cron functions, the `e2e/` writers, `src/lib/authGate.ts`, `src/lib/auth.ts`, `src/lib/db.ts` and `UsersSection`. No real HTTP, GoTrue or edge-function call was made.

**Simulated:** GoTrue `signUp`. I inserted an `auth.users` row as postgres, which stands in for `enable_confirmations = false` at `supabase/config.toml:232`.

**Not touched:** spec 191's migration (`20261109191000`) is not on disk or in the local `schema_migrations`, so none of the `profiles`/`invitations` state I saw came from 191.

### Verdict on the spec's own claim

The spec's claim holds. After 195, **no owning-user API route remains that writes `user_stores`**. Every refusal below is **[ran]** and comes back with the RLS message `new row violates row-level security policy for table "user_stores"` (not `permission denied`):

| Caller | Attempt | Result |
|---|---|---|
| Store-less invitee (NULL brand, JWT `user`) | INSERT own link to a brand-B store; upsert `do nothing`; upsert in the `merge-duplicates` shape; pg_graphql `insertIntouser_storesCollection` | all 42501 |
| Same caller | pg_graphql `updateuser_storesCollection` | `affectedCount: 0` |
| Demoted, NULL brand, no links, stale `admin` claim (`auth_is_privileged()` = true) | own link to brand B; own link to brand A (Charles); pg_graphql insert; link *another* NULL-brand user to brand B | all 42501. The admin arm fails because `auth_can_see_brand` reads `profiles` |
| Demoted, NULL brand, holds Towson, stale `admin` | upsert on the existing row with `do update set store_id = <B>` | 42501 |
| Same caller | UPDATE / DELETE own rows; pg_graphql delete | 0 rows each |
| Seed manager (brand A, JWT `user`) | INSERT own link to Charles | 42501 |
| anon | INSERT | 42501 |
| Stale-claim NULL-brand caller | invitation with `store_ids` = a brand-B store (also with `{…}` braces and no-hyphen uuid spellings); invitation with `brand_id` = B | all 42501 on `invitations`. The policy's `LEFT JOIN … s.id IS NULL` makes unmatched spellings fail closed |
| Same caller | `update profiles set brand_id = <B>` on self | refused by `assert_brand_id_immutable_for_self` |
| Same caller | `register_invited_profile()` | `profile already exists` |
| Same caller | `auth_can_see_store(<B>)` after all of the above | false |

**Other writers [ran catalog query, read code]:**
- Only five functions mention `user_stores`: `auth_can_see_store`, `broadcast_notification` and `preview_brand_cascade` (reads only), `register_invited_profile`, and `user_stores_brand_match`.
- `stock_store_from_store`, `copy_catalog_rows`, `consume_invitation` and `prune_audit_log_and_invitations` don't touch the table.
- The only function that builds SQL dynamically is `report_run_custom`. It is SECURITY INVOKER, so RLS applies, privileged-only, and it forces `transaction_read_only = on`.
- `manage-store-user` writes with the service role. Its `requireAdminCaller` uses `auth.getUser()`, which returns the DB-side `app_metadata` (kept in sync by `profiles_sync_role_to_jwt`), so a stale token claim doesn't pass it. It falls back to `profiles.role`, and `readCallerBrand` returns 403 for a NULL-brand caller (`supabase/functions/manage-store-user/index.ts:98-110, 141`). It also only creates *new* accounts. **[read]**

**Read policy [ran]:** `Users can read own store links`, PERMISSIVE, SELECT, `{public}`, qual exactly `(user_id = auth.uid())`. The seed manager sees exactly their 2 links and 0 rows of other users. That is the same query `authGate.ts:72-75` issues, minus the `stores` embed.

**No legitimate break found:**
- **Registration [ran]:** a fresh account ran `register_invited_profile()` after 195 and got its links. The function is SECURITY DEFINER, owned by `postgres`, which has `rolbypassrls`.
- **Admin arm [ran]:** a brand-A admin linked a user to Charles.
- **Not exercised [read]:** `manage-store-user`, `delete-user`, `e2e/staff-reorder.spec.ts:162` and `e2e/global-teardown.ts:183` all use the service role.
- **Client code [read]:** every `from('user_stores')` in `src/` is a SELECT, except `db.ts:190` `deleteStore`, which is admin-arm and has no callers. `UsersSection` has no store-assignment write.
- **Not checked:** sibling apps outside the repo. This is already recorded as an accepted owner risk.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

**H1 (pre-existing, outside this diff, does NOT block 195): any privileged claim can list every brand's pending invitations and squat them. A fresh account then holds another brand's store links, or becomes a durable admin of another brand. [ran, signUp simulated]**

- **Where:**
  - `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:33-35` (`"Admins can read invitations"`, `using (auth_is_privileged())`) and `:47-49` (`"Admins can delete invitations"`, same). Neither is brand-scoped.
  - `supabase/config.toml:227,232` (`enable_signup = true`, `enable_confirmations = false`).
  - `register_invited_profile()` (`supabase/migrations/20261007000000_profiles_insert_hardening.sql`) binds identity to an `auth.users.email` that nothing has verified.
- **What I ran:**
  1. As the seed brand-A admin `1111…`, I `SELECT`ed a brand-B admin invitation (`role=admin, brand_id=B`) and a brand-B staff invitation (`brand_id NULL, store_ids={store B}`). Both were returned with email, role, brand and store ids. The demoted NULL-brand stale-claim caller saw the same rows, and also `DELETE`d a brand-B invitation (1 row).
  2. Simulated `signUp` with each email.
  3. Each new account called `register_invited_profile()`:
     - The staff squat got `role=user, brand_id=B`, a `user_stores` row on store B, and `auth_can_see_store(B) = true`.
     - The admin squat got `role=admin, brand_id=B`, with `raw_app_meta_data.role = 'admin'` synced.
- **Why it matters for this spec:** this is the remaining API route by which an attacker-controlled profile ends up linked to another brand's store. It needs no stale token. Any brand admin can use it, and so can the 187-H2 stale-claim caller. Spec 164 L161 calls invitations SELECT/DELETE "not an escalation path". That holds for SELECT alone, but not combined with 164-M1, because the SELECT removes M1's "guess the email" step. Spec 191 leaves both policies untouched by design (191 L501, K-13 pins `qual = 'auth_is_privileged()'`).
- **Preconditions:**
  - a pending invitation whose email hasn't signed up yet
  - open signup without confirmation on prod (prod auth settings not checked here; 164-M1 has the same caveat)
  - P-3 shows two live brands, so this is cross-tenant
- **Why High, and why it doesn't block 195:** 195 neither creates nor widens it, and 195 is a strict reduction. Holding 195 would leave 164-H1 open too.
- **Fix:** a separate spec, prioritized:
  - (a) Give `invitations` SELECT and DELETE the INSERT/UPDATE predicate: brand in scope, every store in scope, and once 191 lands, its profiles-backed privileged check.
  - (b) Turn on email confirmation on prod, or claim the invitation on first verified sign-in (164-M1).
  - (c) Re-run the 164 P-6 pending-invitation eyeball on prod.

### Medium

**M1 (residual of 187-H2, not closed by 195 or by 191 as designed): if an admin is demoted but keeps their brand, a stale claim lets them self-link to every store in that brand during the token window. Those links last after the token expires. [ran]**

- **Where:**
  - The admin arm `"Admins can manage all store links"` (`supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:115-137`). It trusts `auth_is_privileged()` → `auth_is_admin()`, which reads only the JWT.
  - The `profiles_role_brand_consistent` CHECK allows `role='user'` with a brand.
- **What I ran:** a profile with `role='user', brand_id=A` and a stale `admin` claim INSERTed its own link to Charles. It was admitted. The trigger refused brand B (P0001).
- **Who can produce that state:**
  - A super_admin changing only `role` through `super_admin_manage_profiles`.
  - A future demote that keeps the brand.
  - Today `demote_profile_to_user` NULLs the brand, so it doesn't apply.
- **Impact:**
  - Within one brand only.
  - It turns a window of at most `jwt_expiry` (3600 s locally) of admin-level reads into durable staff access to every store in the brand.
  - Spec 195 lists this as out of scope ("Out of scope", the 164-M2 bullet). Spec 191 C1 covers the demote RPC, invitations INSERT/UPDATE and profiles INSERT, but not this policy.
- **Fix:** when 191 adds `auth_profile_is_privileged()`, use it in this policy's USING and WITH CHECK too (in 191 or a follow-up). The pgTAP arm is the probe above, expecting 42501.

### Low

**L1. The fail-closed admin-arm check is a substring match, so a widened admin arm passes it. [ran]**
- **Where:** `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql:705-708`.
- **What I ran:** in a rolled-back transaction, I altered the admin policy to `auth_is_privileged() OR exists(…auth_can_see_brand…) OR auth.uid() IS NOT NULL`, with WITH CHECK `auth.uid() IS NOT NULL OR auth_can_see_brand(NULL)`, then ran the migration's DO block. It completed without raising.
- **Mitigations already in place:**
  - The T3 byte-pin in CI.
  - The spec 053 lint, which would flag the `auth.uid() IS NOT NULL` form.
  - AC-R2 step 3, which compares P-1 on prod against the T3 literal.
- **The gap:** only the in-migration guard is weak. Since prod is applied by pasting the body, the guard is the one check that runs atomically with the drop.
- **Fix (optional):** compare `md5(qual)` and `md5(with_check)` to `b05a4d4429e322a9cf194d6072b5f6d3` inside the DO block.

**L2. `anon` and `authenticated` hold TRUNCATE (and TRIGGER, REFERENCES) on `user_stores`. TRUNCATE ignores RLS. [ran grants query; reachability read]**
- **Where:** `information_schema.role_table_grants`, from the explicit-grant posture of spec 097 (`20260618000000_public_grants_explicit.sql`).
- **Reachability:** neither PostgREST nor pg_graphql can issue TRUNCATE, and `report_run_custom` forces a read-only transaction. So it is not reachable today, and it can only remove links, not add them.
- **Why I mention it:** it is defense in depth on the table that now gates all store visibility.
- **Fix (optional, project-wide):** `revoke truncate, trigger, references on all tables in schema public from anon, authenticated` in its own spec.

**L3. The brand-match trigger doesn't serialize concurrent first links for a NULL-brand user. [read]**
- **Where:** `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql:83-110`.
- Two transactions that each insert a first link for the same NULL-brand user, in different brands, can't see each other's uncommitted row, so both pass.
- This needs two privileged writers in different brands acting at the same moment, or a super_admin. No unprivileged path exists after 195.
- **Fix (optional):** `perform 1 from public.profiles where id = new.user_id for update;` at the top of the NULL-brand branch.

### Is the brand-match trigger still needed, and is it sufficient for admin writes?

**Still needed [ran].** The admin arm checks only that the caller can see the *store's* brand. Nothing in RLS constrains `user_id`. The trigger is the only control on the target user's side:
- It refused a brand-A admin linking a brand-B admin to a brand-A store (P0001).
- It refused the same admin moving a NULL-brand user's brand-A link to store B through UPDATE (P0001).
- Without it, any admin could plant cross-brand links. That would violate the P-5 invariant and open the brand to outsiders.

**Sufficient for admin writes, with three caveats:**
- An admin can link any NULL-brand user (a store-less invitee, a demoted user from another brand, a super_admin) to their own brand's stores. That is the admin sharing their own data, so it is by design and not an escalation.
- The L3 race.
- It doesn't re-check existing links when `profiles.brand_id` or `stores.brand_id` changes later. That is out of scope here.

The spec's decision not to change the trigger is sound.

### What 187-H2 still leaves open after 195 (and 191 as currently designed)

1. **Cross-brand demote:** 164-H2, which spec 191 fixes.
2. **Cross-brand invitation read/delete plus squatting:** H1. Open, and 191 leaves it untouched.
3. **Same-brand stale-claim link entrenchment:** M1. Open.
4. **A demoted target keeps its pre-demotion `user_stores` links,** and so keeps staff-level access to those stores indefinitely. Recorded as a product decision (191 L219).
5. **`auth_is_admin()` is still JWT-only everywhere else.** A stale claim keeps admin reads within the caller's *profile* brand until expiry. With a NULL brand that is nothing beyond held links, which is consistent with probe B12. The JWT-only `ingredient_categories` / `recipe_categories` write policies are brand-unscoped by design (CLAUDE.md allowlist), so a stale claim can still write those global catalogs for one token lifetime. 191 defers changing `auth_is_admin()`.
6. **A stale NULL-brand claim can still create store-less invitations [ran],** including `role='admin', brand_id=NULL`. `register_invited_profile` R6 refuses the admin one, and the staff one yields a NULL-brand, store-less profile that is harmless after 195. Closed by 191 C1.

### Dependencies

`package.json` differs from HEAD in the working tree only in the `test:smoke` script (it adds `smoke-delete-user.sh`, from another spec). There are no dependency changes and spec 195 doesn't touch it (AC-15), so I skipped `npm audit`.
