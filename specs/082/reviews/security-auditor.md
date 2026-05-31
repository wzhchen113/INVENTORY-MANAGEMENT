# Security audit for spec 082

Scope reviewed:
- `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql` — the `consume_invitation` redefinition (adds `profile_id = auth.uid()`) + the one-time `auth.users`-reading backfill.
- `supabase/migrations/20260424211733_security_fixes.sql:87-110` — the original `consume_invitation` body + its grants (the pre-existing surface).
- `src/lib/db.ts` `fetchBrandAdmins` (~3225-3334) — the read change (dropped `.eq('used', false)`).
- `supabase/tests/consume_invitation_sets_profile_id.test.sql` — the pgTAP regression (no PII logged, drift-disciplined).
- Invitations RLS: `20260514150000_invitations_super_admin_rls.sql` (all four policies gate on `auth_is_privileged()`).
- Anon-lockdown precedent: `20260505065303_admin_rpcs_lock_anon.sql`.

Verdict: **no Critical, no High.** No privilege escalation and no unauthorized-data-exposure path. The six load-bearing concerns the dev/architect flagged are addressed below; the PUBLIC/anon grant is rated Low (defense-in-depth deviation, not exploitable). Nothing here BLOCKS.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql:103` (and the pre-existing surface at `supabase/migrations/20260424211733_security_fixes.sql:87-110`) — **`consume_invitation` retains the Postgres-default `PUBLIC` EXECUTE grant plus an implicit `anon` reachability; this spec re-affirms only the `authenticated` grant and leaves the PUBLIC/anon surface untouched.** Not exploitable: the function's first statement is `if auth.uid() is null then return false; end if;` (lines 85-87). An anon JWT has no `sub` claim, so `auth.uid()` is null, so an anon/PUBLIC caller is a guaranteed no-op — it returns `false` and mutates zero rows. Confidentiality and integrity are intact via the guard; the grant cannot be turned into data exposure or a write. **Why it is still a finding (and why Low, not nothing):** this codebase has an explicit, documented posture for exactly this shape. `20260505065303_admin_rpcs_lock_anon.sql` REVOKE'd `EXECUTE FROM PUBLIC, anon` from three SECURITY DEFINER RPCs — and its own rationale (lines 9-11) notes the dedupe RPCs were "safe in practice — they raise immediately if `auth_is_admin()` returns false" yet locked them down anyway as defense-in-depth. `consume_invitation`'s `auth.uid()`-null guard is the same "safe in practice" shape, so leaving the grant is a deviation from the project's own established standard. **Fix (follow-up, not a blocker):** add `revoke execute on function public.consume_invitation(uuid, text) from public, anon;` immediately before the `grant ... to authenticated` re-affirmation, mirroring the spec-005-era hotfix. The dev correctly surfaced this rather than silently changing the grant surface; the design (§10) directed re-affirming only `authenticated`. Rating it Low because the guard genuinely neutralizes the grant — this is hygiene/consistency, not a live hole.

- `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql:88-94` — **the new `profile_id = auth.uid()` write lets an authenticated caller stamp THEIR OWN id onto any unused, unexpired invite whose email they can supply, marking it consumed.** Assessed for privilege-escalation / invitation-hijack and found to be neither, for four independent reasons:
  1. **No new access is granted.** `fetchBrandAdmins` (`src/lib/db.ts:3280-3294`) uses `profile_id` solely as a map key to attach an *email label* to an already-existing profile row. The link does NOT confer the invitation's `role` or `store_ids` on the caller — role/store membership lives on the profile's own `role` column and `user_stores`, set by separate admin-gated paths, not by this link. So a malicious consume cannot elevate the caller's privileges.
  2. **The grief vector (invalidating a pending invite) is PRE-EXISTING and unchanged.** Before spec 082, any authenticated caller who knew a valid `(invitation_id, email)` pair could already flip `used = true` and burn the invite — the same `where ... and used = false` predicate gated it. Spec 082 adds nothing to that vector. The original function's own comment (`security_fixes.sql:85-86`) acknowledges the design: "must know both the invitation id and its email — prevents anon drive-by invalidation."
  3. **The only NEW effect is a cosmetic mislabel, gated behind an unguessable secret.** If an attacker consumes a victim's pending invite, the victim invite's email would resolve into `inviteByProfileId[attacker.id]`, so the attacker's row in the admin Users view could display the victim invite's email. That is a label mismatch in an admin-only screen (RLS-gated to `auth_is_privileged()`), confers no access, and requires the attacker to already be authenticated AND to know a v4 UUID invitation id (unguessable) AND the matching email.
  4. **Cross-user collision is bounded.** `auth.users.email` is unique, so a used invite can only ever link to one real user; the WHERE's email match plus `used = false` mean the caller cannot retarget an already-consumed invite. **Fix:** none required for this spec — the impact is cosmetic + gated behind an unguessable id, and the destructive-action conventions (last-of-role / self-guard) do not apply (this is not a role-change or deletion path). Noted as Low so it is on record; if a future spec ever lets `profile_id` drive authorization, this write must be re-reviewed.

### Informational (no action — concerns explicitly cleared)

These were the dev's flagged items; confirming each is clean so the release-coordinator has the full picture:

- **Concern 3 — backfill reads `auth.users` in-migration.** Acceptable. The `do $$ ... $$` block (lines 122-135) runs as `postgres` at apply time; reading `auth.users.email` to resolve `profiles.id` is a one-time privileged admin operation, not an exposed runtime path. It is the same pattern as `staff_brand_id_backfill` and `legacy_permissive_policy_dropout`. **No `auth.users` data is logged** — the only `raise notice` (line 134) emits a row *count* (`v_linked`), no emails, no ids. Confirmed.

- **Concern 4 — search_path / SECURITY DEFINER hygiene.** Clean. `SET search_path = public` is preserved verbatim on the redefined function (line 80), matching the original (`security_fixes.sql:91`). No injection surface: `p_invitation_id` (uuid) and `p_email` (text) are used only as bound predicate values (`id = p_invitation_id`, `lower(email) = lower(p_email)`); there is no dynamic `EXECUTE` anywhere in the function or the backfill. The backfill is static SQL with literal-typed comparisons (`'00000000-...'::uuid`). The write target `profile_id = auth.uid()` is server-derived, not caller-supplied. No SQLi surface.

- **Concern 5 — `fetchBrandAdmins` read change (dropped `used=false`).** No new data exposure. The `invitations` table's SELECT policy is `using (public.auth_is_privileged())` (`20260514150000_invitations_super_admin_rls.sql:33-35`) — admin OR master OR super_admin only — and that policy does not distinguish `used` from unused rows. Dropping the client-side `.eq('used', false)` filter makes `fetchBrandAdmins` read consumed invites it already had full RLS authority to read; an unprivileged role still sees zero invitation rows. The emails newly surfaced were already visible to the same admins via the sibling `fetchInvitationsForUserLookup` (which has no `used` filter, per spec §root-cause) and the BrandsSection members tab. Brand scoping (`.eq('brand_id', brandId)`, `src/lib/db.ts:3242`) is preserved — no cross-brand bleed. Confirmed: same authorization boundary, more rows the caller already owned.

- **Concern 6 — dependencies.** No `package.json` / `package-lock.json` change in this spec (working tree shows only `src/lib/db.ts` modified + new migration/test files). `npm audit --audit-level=high` reports **17 vulnerabilities (16 moderate, 1 high)** — identical to the stated baseline. The single `high` (`ws` 8.0.0–8.20.0 uninitialized-memory disclosure, GHSA-58qx-3vcg-4xpx) and the moderate Expo/`xcode`/`uuid` chain are all pre-existing transitive deps untouched by this spec. **0 new vulnerabilities introduced.**

- **pgTAP test hygiene** — `supabase/tests/consume_invitation_sets_profile_id.test.sql` is hermetic (`begin; ... rollback;`), reuses seeded auth ids rather than minting synthetic UUIDs, sets an authenticated JWT context to exercise the real `auth.uid()` path (arms A/B), and carries an explicit drift note (lines 36-40) that the inline backfill UPDATE must stay byte-identical to the migration. I diffed the inline copy (lines 151-157 / 176-182) against the migration's backfill (lines 126-132) — predicates match. No secrets or PII in assertions (emails used are the seed's own `@local.test` fixtures + an `.invalid` ghost). Confirmed clean.

### Dependencies

`npm audit --audit-level=high`: **17 vulnerabilities (16 moderate, 1 high) — unchanged from baseline.** No `package.json` change in spec 082, so 0 new vulns. The `high` is `ws` (uninitialized memory disclosure, transitive); the moderate cluster is the Expo `xcode → @expo/config-plugins → @expo/config → expo-constants/expo-asset/expo-notifications/jest-expo` chain plus `uuid`. All pre-existing and out of scope for this spec.

---

## Summary

Spec 082 is a backend/data-layer change that links `invitations.profile_id` on consume and backfills legacy rows. It introduces **no Critical and no High** findings:

- The new `profile_id = auth.uid()` write grants no access — it only labels an existing profile's email in an admin-only, RLS-gated view. The one griefable side effect (invalidating a pending invite) is pre-existing and gated behind an unguessable UUID + matching email.
- The read change exposes nothing new — the invitations SELECT policy already restricted to `auth_is_privileged()` regardless of `used`, and the emails were already visible to the same admins.
- The backfill is a standard privileged in-migration `auth.users` read, logs only a count, and is injection-free static SQL.
- SECURITY DEFINER hygiene (`search_path = public`) is preserved.
- 0 new dependency vulns (no `package.json` change).

The two Low findings (pre-existing PUBLIC/anon grant left in place; the cosmetic mislabel vector from the new write) are on-record hygiene/consistency items, not blockers. The dev correctly surfaced the grant question rather than silently changing the surface; my call is that a one-line `revoke ... from public, anon` is a worthwhile defense-in-depth follow-up to match this codebase's own spec-005 anon-lockdown posture, but it does not block deploy.
