# Spec 163: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Scope: the files listed under `## Files changed` in `specs/163-admin-user-emails.md`, checked against `## Backend design` §0-§11.

## Verdict

**No contract drift.** The migration, the pgTAP file, the `db.ts` helper, and both consumers match the design.

- **SQL body.** The function body is the §1 pseudocode exactly. Signature, `language sql stable security definer`, `search_path = public, auth`, the inner join, narrow-only `= any(p_user_ids)`, the verbatim spec-043 privileged arm, and the blank-email filter are all as designed.
- **Grants.** The grant idiom matches spec 162.
- **db.ts surface.** It matches §5 exactly.
- **Async wrapper.** Both consumers use the required `async` try/await wrapper, not `.catch()` chaining.
- **Single call site.** `supabase.rpc('get_profile_emails')` is called in exactly one place.
- **Out-of-scope files.** No section, store, config, or `app.json` files were touched.

Counts: **0 Critical, 1 Should-fix, 4 Minor.**

## Contract conformance checklist

| Design item | Location | Result |
|---|---|---|
| §0 signature `get_profile_emails(p_user_ids uuid[]) returns table (user_id uuid, email text)` | `supabase/migrations/20261008000000_get_profile_emails.sql:44-45` | Match |
| §0 `language sql stable security definer set search_path = public, auth` | migration `:46` | Match. This is the same shape as `auth_is_super_admin` / `auth_can_see_brand` / `auth_is_privileged` (`20260509000000_multi_brand_schema_rls.sql:187-239`). |
| §0/§2 predicate = privileged arm of `"Admins can read all profiles"`, self-arm omitted | migration `:51-52` vs `20260517060000_profiles_rls_sweep.sql:99` | Match, verbatim. I also checked the other SELECT policies on `profiles`. `super_admin_read_all_profiles` (`20260509000000:981-983`) is already covered by `auth_is_privileged()`, so super_admin parity holds. `"Own profile"` (init) is the self-arm and is intentionally excluded. |
| §1 inner join (orphans excluded), fail-closed NULL/`'{}'` | migration `:49-50` | Match. `p.id = any(NULL)` evaluates to NULL, which counts as false, so 0 rows. |
| §1 `coalesce(u.email,'') <> ''` | migration `:53` | Match |
| §1 `comment on function` with lockstep rule | migration `:56-62` | Match |
| §1 `revoke all … from public, anon` then `grant execute … to authenticated` | migration `:71-72` | Match. Same idiom as `20260829000000_auto_place_order_attempts.sql:375-378`. |
| §1 header says "REALTIME: no publication change" | migration `:27-28` | Match. No `docker restart supabase_realtime_imr-inventory` step is needed. |
| §1 timestamp sorts last | `20261008000000` > `20260829000100` (latest other file on disk) | Match |
| §2 no policies added | migration | Match. Spec-053 lint is unaffected; the dev reports `permissive_policy_lint` green. |
| §5 `fetchProfileEmails(userIds: string[]): Promise<Map<string,string>>` | `src/lib/db.ts:247` | Match |
| §5 dedupe + empty short-circuit (no network) | `src/lib/db.ts:248-249` | Match |
| §5 `track(..., { kind: 'read', label: 'fetchProfileEmails' })` + `.abortSignal(signal)` | `src/lib/db.ts:250-253, 260` | Match |
| §5 `if (error) throw error`, skip falsy email, `user_id` → key | `src/lib/db.ts:254-258` | Match |
| §5 only `get_profile_emails` call site | grep across `src/` | Match. Only `src/lib/db.ts:252` calls it. |
| §5 placement below `fetchInvitationsForUserLookup` | `src/lib/db.ts:239` | Match |
| §5 `fetchAllUsers` async try/await wrapper, warn and no toast | `src/lib/auth.ts:618-625` | Match |
| §5 `fetchAllUsers` no extra serial round-trip | `src/lib/auth.ts:626` (started before the `user_stores` await) and `:650-653` (joined with invitations) | Match. The RPC overlaps the `user_stores`, `fetchStoreIdsForBrand`, and invitation reads. `safeProfileEmails` cannot reject, so if the outer `catch` fires early the promise is left dangling but cannot raise an unhandled rejection. |
| §5 precedence `rpcEmails.get(p.id) \|\| invitation?.email \|\| ''` | `src/lib/auth.ts:683`, `src/lib/db.ts:5512` | Match in both consumers |
| §5 stale "can't query auth.users" comment removed | `src/lib/auth.ts:655-656` | Match |
| §5 `fetchBrandAdmins` passes only `profilesRes` ids, concurrent with `user_stores` | `src/lib/db.ts:5452, 5460-5477` | Match. `userIds` comes from `profiles` only. The RPC runs in `Promise.all` with `loadStoreLinks()`. |
| §5 nested `track()` accepted, no inline `supabase.rpc` | `src/lib/db.ts:5462` | Match |
| §5 `profilesRes.error` still throws; pending rows keep `inv.email`; `activeEmails` derived from resolved emails | `src/lib/db.ts:5446, 5540, 5547` | Match |
| §7 no `useStore.ts` / section changes | git status | Match. `UsersSection.tsx` shows only its pre-existing staged change (`M ` in the index column, nothing in the worktree column). |
| §8 pgTAP `plan(18)`, arms 1-18, anon via catalog (spec-067 segfault) | `supabase/tests/get_profile_emails.test.sql` | Match. Arm-for-arm with the §8 table. The master is not promoted, the SA is synthetic, and the orphan has no profile. |
| §8 jest cases (both suites) + `auth.signIn.test.ts` mock | `src/lib/auth.fetchAllUsers.test.ts:164-271`, `src/lib/db.fetchBrandAdmins.test.ts:341-507`, `src/lib/auth.signIn.test.ts:43` | Match. Includes the sync-throw guard case (`auth.fetchAllUsers.test.ts:252-270`) that pins the §5 wrapper requirement, the profile-ids-only arg assertion, and the dedup behavior change. |

## Findings

### Critical

None.

### Should-fix

**S1. The rollout steps the design marked mandatory are still open, and they gate the push to `main`.** (spec §9 steps 2-5, §10 R2)

The spec's "Not done" section says the prod MCP apply and in-browser UI verification have not happened. Neither is a code defect, but both affect the release:

- **Push order.** The migration file is untracked. If it reaches `main` before `20261008000000` is inserted into prod `supabase_migrations.schema_migrations`, `db-migrations-applied.yml` goes red (CLAUDE.md hard rule). Apply to prod first, then push.
- **UI verification is required, not optional.** The §5 fallback deliberately hides a missing or broken RPC (PGRST202 only produces a `console.warn`), and MCP `execute_sql` returns 0 rows by design because there is no JWT. A signed-in UI check that "Towson Staff" shows a real email is the only positive evidence the RPC works in prod. Local HTTP verification (admin gets emails, `user` gets `[]`, anon gets 42501) is good, but it does not replace this.
- **Owner check.** During the normalized-md5 verification, also confirm `pg_proc.proowner` resolves to `postgres`. A definer function owned by a role without SELECT on `auth.users` would fail at runtime, and the fallback would hide that failure silently.

### Minor

**M1. Non-ASCII characters inside the function body.** `supabase/migrations/20261008000000_get_profile_emails.sql:51-52`

The inline SQL comments inside `$$ … $$` use U+2026 (`…`). `pg_get_functiondef` keeps body comments verbatim, so these bytes are part of the §9 normalized-md5 comparison. If the MCP `execute_sql` transport or the comparison script normalizes or escapes Unicode differently from the repo file, you get a false md5 mismatch during rollout. It is harmless at runtime. Options: replace with ASCII `...`, or make sure the md5 script reads the repo file as UTF-8. Comments outside the `$$` body (header, `comment on function`) are unaffected.

**M2. One `fetchBrandAdmins` comment still describes invitations as the email source.** `src/lib/db.ts:5479-5483`

The block comment above the invite maps still opens with "Spec 082 — profiles has no email column; we infer each user's email from the invitation row that registered them." After spec 163, invitation inference is the fallback. `auth.ts` got a spec-163 pointer (`:655-656`); this sibling block did not, although the inline comment at `:5511` partly covers it. Add one line to match `auth.ts` so a future reader does not "simplify" the RPC away.

**M3. No pgTAP arm for the blank-email filter.** `supabase/tests/get_profile_emails.test.sql`

The `coalesce(u.email,'') <> ''` clause (migration `:53`) is in the design body but not in the §8 arm table, so this is a gap in the design, not developer drift. A 19th arm would pin it: a profile whose `auth.users.email` is `''` or NULL, as SA, returns 0 rows. Removing the clause today would not fail any test. The `db.ts` falsy-email skip (`:257`) is the second line of defense, and it is also not directly unit-tested.

**M4. `fetchProfileEmails` has no direct unit test for its own contract.** `src/lib/db.ts:247-261`

Dedupe, the empty-input short-circuit, and the falsy-row skip are only exercised indirectly through `fetchBrandAdmins`. The "skips the RPC entirely when the brand has no active profiles" case covers the short-circuit; dedupe and the falsy skip are not covered. This is low risk because consumers index by `user_id`, but a duplicate id in `p_user_ids` would go unnoticed. It is optional; the design did not require a standalone suite.

## Observations (no action required for this spec)

- **Local `schema_migrations` drift.** The developer reports that local `supabase_migrations.schema_migrations` is missing `20260819000000`, `20260829000000`, and `20260829000100` even though their objects exist, and `20261008000000` was also applied via `psql -f` without being recorded. CI's `db-migrations-applied` gate compares repo to **prod**, so this does not block the spec. It does mean `npx supabase migration up` is unusable locally until the history is repaired. Track it as a dev-env hygiene follow-up; do not fold it into this spec.
- **Nested `track()` in `fetchBrandAdmins`.** The inner abort signal is not chained to the outer one. Both use the 30s hard abort, so the worst case is one extra RPC that finishes after the outer read has already been abandoned. This was accepted in §5/R6, and the implementation matches.
- **Expected behavior changes (R9).** These are intended and need no fix. SEND RESET now works for previously email-less accounts. The delete-confirm `requiredText` becomes the email. The Brands pending-row dedup is stricter, as pinned by `db.fetchBrandAdmins.test.ts:489-506`.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (prod MCP apply + mandatory UI verification must precede the push to main), 4 Minor.
payload_paths:
  - specs/163-admin-user-emails/reviews/backend-architect.md
