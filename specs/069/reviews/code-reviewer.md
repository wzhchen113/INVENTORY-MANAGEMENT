## Code review for spec 069

### Critical

None.

### Should-fix

- `supabase/tests/staff_brand_id_backfill.test.sql:156–160` — Arm (1) is stated (in both the test-file header and the spec) as proving "auth_can_see_brand(A) = FALSE AND the catalog SELECT returns 0 rows," but the implementation only asserts the helper function call (`is(auth_can_see_brand(...), false, ...)`). The catalog-row-count half of the "pre-fix proof the bug exists" arm is absent. This matters because a reviewer reading the pgTAP output cannot tell from arm (1) alone that the RLS-block actually prevents a catalog read — the helper returning FALSE is a necessary-but-not-sufficient proof. Suggested fix: add a second `ok(...)` assertion inside arm (1) that selects `count(*) = 0 from public.catalog_ingredients where brand_id = brand_a` under the NULL-brand JWT, matching the stated intent.

### Nits

- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql:255–256` — `array_length(i.store_ids, 1) >= 1` works correctly for an empty array (Postgres returns NULL from `array_length` on `'{}'`, so `NULL >= 1` is NULL, which is falsy in a WHERE clause), but the NULL-returning behavior of `array_length` on an empty array is non-obvious and has surprised contributors before. `cardinality(i.store_ids) > 0` is the clearer idiom: `cardinality` always returns an integer (0 for empty, N for non-empty), making the intent explicit without relying on NULL propagation.

- `src/lib/registerInvitedUser.test.ts:67` — The `delete: jest.fn(() => ({ lt: jest.fn(() => ({ eq: jest.fn(...) })) }))` chain stubs the expired-invite cleanup path used by `inviteUser`, not by `registerInvitedUser`. `registerInvitedUser` never calls `from(...).delete()`, so this dead stub is a minor readability hit. The comment already notes "not exercised," but removing it entirely would make the mock surface match the function under test exactly.

- `supabase/tests/staff_brand_id_backfill.test.sql:318–319` — Arm (8) inserts an invitation with `profile_id = '00000000-0000-0000-0000-000000000000'`. This is the placeholder UUID used by `inviteUser` for not-yet-consumed invitations (established in `src/lib/auth.ts:296`), but there is no inline comment saying so. A future reader who does not recognize the UUID may wonder whether the zero UUID is meaningful to `get_pending_invitation`. A one-line comment (`-- placeholder: invitation not yet consumed, same convention as auth.ts:296`) would close the gap.

---

**Scope check (per scrutiny list):**

- Backfill DO block is idempotent (`WHERE brand_id IS NULL`), has correct pre-flight (multi-brand RAISE EXCEPTION, zero-store RAISE NOTICE + skip), derives the brand via `user_stores` → `stores.brand_id`, and runs as the migration role (postgres superuser, `auth.uid() = NULL`) so `profiles_self_brand_lock` cannot block it. All spec §1b requirements confirmed.
- `get_pending_invitation` uses DROP + CREATE (not CREATE OR REPLACE) because adding a column to the return set requires it — same pattern as `20260510000000_invitations_brand_id.sql:40`. The DROP and CREATE occur within the same migration transaction, so no client observes a missing function. The `grant execute` to `anon, authenticated` is re-applied after the CREATE. All confirmed correct.
- `resolved_brand_id` derivation: `COALESCE(i.brand_id, (select s.brand_id from stores s where ... s.id = (i.store_ids[1])::uuid))`. Admin invites short-circuit on the non-NULL `i.brand_id`. Staff invites derive from `store_ids[1]`. Empty `store_ids` or NULL `store_ids` correctly resolve to NULL (the subquery returns no rows). The RPC is SECURITY DEFINER so the `stores` read bypasses RLS at register time.
- `auth.ts:385–387` — The new branch reads `invitation.resolved_brand_id ?? invitation.brand_id ?? null` for `role='user'`. The double `??` is null-safe: if `resolved_brand_id` is `undefined` (e.g., pre-069 cached RPC shape hitting a stale client), it falls through to `brand_id ?? null`. Admin path reads `invitation.brand_id ?? null` exclusively — unchanged. No regression to admin invite flow.
- `auth.ts` is a documented carve-out (CLAUDE.md) for direct `supabase.*` calls. The spec 069 change stays entirely within that file. No new direct Supabase calls were introduced outside the carve-out.
- No inline color literals, no `Alert.alert`/`window.confirm` calls, no web-only APIs, no legacy file touches, no `app.json` changes, no realtime publication changes, no new realtime channels. Scope is clean.
- Test files: pgTAP test is at `supabase/tests/staff_brand_id_backfill.test.sql` (the established track per spec 022). Jest test is at `src/lib/registerInvitedUser.test.ts` (standard `src/lib/*.test.ts` track). Both follow established patterns.
