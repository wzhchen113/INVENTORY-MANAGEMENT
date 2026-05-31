## Code review for spec 082

### Critical

_(none)_

### Should-fix

- `supabase/tests/consume_invitation_sets_profile_id.test.sql:110-135` — Arm B's stated purpose is two claims: (1) second `consume_invitation` returns `false`, AND (2) `profile_id` is NOT overwritten. The test only asserts (1). The comment at line 112 explicitly says "must NOT overwrite the profile_id set in Arm A" and the spec §8 says "does NOT change profile_id (proves the `where used = false` guard)" — but there is no `select is(...)` after `reset role;` that reads back the row's `profile_id` and asserts it equals `test.admin_id`. The mechanical safety argument (zero rows updated → nothing changed) is sound, but the test does not directly witness the invariant it describes. Add a second assertion after `reset role;` (e.g. `select is((select profile_id from public.invitations where email = current_setting(...) limit 1), current_setting('test.admin_id', true)::uuid, 'arm B: profile_id is unchanged after a no-op consume')`) and bump `plan(7)` to `plan(8)`.

### Nits

- `src/lib/db.fetchBrandAdmins.test.ts:149,150` — Test fixture (b) uses `profile_id: 'p-sam1'` and `'p-sam2'` — short strings, not UUID format. The code path under test only checks `!== '00000000-...'` (sentinel sentinel), so the test is logically correct and passes. But the fixture misrepresents what a real row looks like (`profile_id` is a `uuid NOT NULL` column in prod). Using recognisable UUID-shaped values (e.g. `'a1a1a1a1-0000-0000-0000-000000000000'` for sam1, `'a2a2a2a2-0000-0000-0000-000000000000'` for sam2) would make the fixture self-documenting about the real data shape without changing the assertion.

- `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql:134` — The `raise notice` message says "(0 expected on local — seed has no invitations)". This is accurate for the current seed but becomes misleading if the seed is later amended (e.g. to add the hermetic registered-user row the spec §8 open-question flags). Not a bug; just a comment that will age.

- `src/lib/db.ts:3253` — `invitesRes.error` is silently ignored (`const invites = invitesRes.data || []`). If the invitations query fails, the function returns active rows with `email: ''` — i.e. the original bug is indistinguishable from a query failure. This is pre-existing (not introduced by spec 082) and `profilesRes.error` is thrown, so at least a total failure is caught; but the silent empty-array fallback for invites is a latent footgun now that the fix depends on that query returning data. Surfacing as a nit (out-of-scope) — fixing it is a one-liner (`if (invitesRes.error) throw invitesRes.error;`) and would make future debugging easier, but it is not part of this spec's scope.

---

## Resolution (post-review fix-pass — main Claude)

- **Should-fix (arm-B profile_id-not-overwritten unasserted)** — **fixed by test-engineer** during its review pass: added a `select is(profile_id, admin_id, …)` after the 2nd consume (which returns false), `plan(7)→plan(8)`. The "used=false guard prevents overwrite" invariant is now witnessed, not just mechanical.
- **Nits (3)** — deferred (cosmetic): the jest fixture's non-UUID `profile_id` strings, the migration `raise notice`'s "0 expected on local" staleness, and the pre-existing silent `invitesRes.error` swallow (out-of-scope — a separate hardening). None affect correctness.

### Security-auditor Low #1 + architect recommendation folded in (revoke anon)

Both the security-auditor and the post-impl architect recommended folding in the `revoke` to match the spec-005 anon-lockdown house standard (the function pre-dated it + carried legacy PUBLIC/anon EXECUTE grants; neutralized by the `auth.uid()` guard but inconsistent). Since the migration already `CREATE OR REPLACE`s the function, added:
`revoke execute on function public.consume_invitation(uuid, text) from public, anon;`
right after the `grant … to authenticated`. Pinned with a new pgTAP **arm E** (catalog-query `has_function_privilege` — NOT the spec-067-segfault `set role anon` + throws_ok pattern): asserts anon has no EXECUTE and authenticated retains it. `plan(8)→plan(9)`.

Re-verified post-fix-pass: `supabase db reset` applies the migration (revoke included); pgTAP **39/39** (the 082 file now **9 assertions** incl. arm E); jest 402 + tsc 0 unaffected (.sql-only change). Security-auditor Low #2 (cosmetic email-mislabel vector) — no action (not a real risk per the audit).
