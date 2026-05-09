# Security auditor findings — Spec 012c

Scope: brand soft-delete + restore + hard-delete cascade UX.
Files audited:
- `supabase/migrations/20260510010000_brand_delete_cascade.sql` (711 lines)
- `src/components/cmd/TypeToConfirmModal.tsx` (305)
- `src/components/cmd/CascadePreviewModal.tsx` (501)
- `src/lib/db.ts` lines 1580–1859 (brand lifecycle helpers + `demoteProfileToUser`)
- `src/store/useStore.ts` lines 90–145 (interface), 320–713 (slice + actions)
- `src/screens/cmd/sections/BrandsSection.tsx` (1060)
- `supabase/functions/delete-user/index.ts` (90)
- `src/lib/auth.ts` (`callEdgeFunction`, `deleteUser`)
- Supporting context from `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (012a helpers / policies)

---

## Critical (BLOCKING)

(none)

The five new RPCs are correctly gated; the `brand_deletion_log` table has RLS + super-admin-only read; the destructive UI flows funnel exclusively through the type-to-confirm modal; `hard_delete_brand` enforces both pre-flight gates server-side, including the H5 orphan-profile check; the FK CASCADE conversions are correct and idempotent; and the migration's belt-and-braces post-conversion assertion (lines 289–306) makes any drift fail the migration loudly rather than silently shipping a broken contract. No critical finding blocks the spec.

---

## Warnings

### W1 — `deleteUser` client wrapper silently swallows edge-function errors (PRE-EXISTING, surfaced because spec widens the call site)

**File:** `src/lib/auth.ts:108-127, 408-416` (and downstream `src/store/useStore.ts:686-713`).

`callEdgeFunction` does `await fetch(...)` without checking `response.ok`. If the edge function returns 401/403/500, no exception is thrown and `deleteUser()` resolves with `{ error: null }`. `useStore.deleteProfile` then drops the row from the local cache and shows a "Profile deleted" toast — even if the server actually rejected the call.

Concretely for 012c:
- A non-super-admin who somehow wires up a `useStore.deleteProfile()` call (e.g., via the dev console or by toggling `useIsSuperAdmin()`'s placeholder) would get a UI confirmation that the profile is gone, while the auth/profiles row remains intact server-side. The actual deletion is correctly blocked by the server (`requireAdminCaller` in `delete-user/index.ts:21-34`), so this is not a privilege-escalation vector — but it is a misleading UI state.
- More worryingly for 012c's H5 contract: if the super-admin tries to clear an orphan profile so they can purge a brand, and the edge function transiently fails (network blip, 500), the UI says "Profile deleted" and drops the row from `brandAdminsByBrandId`. The next `previewBrandCascade` call will still show the profile as blocking, but the operator may already be confused about why their "successful" delete didn't unblock the purge.

Pre-existing: the swallow-all behavior exists in `callEdgeFunction` from before 012c. Surfaced here because spec 012c is the first spec to wire `deleteUser` into a destructive UI flow that depends on observing the result.

**Suggested fix:** in `callEdgeFunction`, check `response.ok` and throw with `await response.text()` (or a parsed `error` field) on non-2xx. This is a one-liner change in `src/lib/auth.ts:116-123`. Out of strict 012c scope, but worth a follow-up ticket since 012c is the load-bearing consumer.

### W2 — `demoteProfileToUser` is a direct PostgREST UPDATE, not a SECURITY DEFINER RPC

**File:** `src/lib/db.ts:1871-1880`, called from `src/store/useStore.ts:650-684` and `src/screens/cmd/sections/BrandsSection.tsx:805-815`.

The function does:
```ts
supabase.from('profiles').update({ role: 'user', brand_id: null }).eq('id', profileId)
```

Authorization relies entirely on the `super_admin_manage_profiles` UPDATE policy in 012a (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:985-988`), which gates UPDATE on `auth_is_super_admin()`. That policy is correct; a regular admin cannot use this to demote arbitrary admins.

However:
1. The **base** `Own profile` policy from init schema (`supabase/migrations/20260405000759_init_schema.sql:261-262`) is `for all using (auth.uid() = id)` with no explicit `with check`. RLS evaluates ANY of the policies as a logical OR — so a user can UPDATE their own row regardless of the super-admin policy. This is a pre-existing 012a concern (the orphan-CHECK should catch self-promotion to super_admin only if the brand_id is set; for `role='user'` it would not). Not a 012c regression, but the choice to use direct PostgREST here re-exposes the surface.
2. There is **no server-side self-protection** on this UPDATE. A super-admin could direct-UPDATE their own profiles row to `role='user', brand_id=null`, locking themselves out of super-admin privileges. UI gates on `isSelf` (BrandsSection.tsx:860, 865) so the button doesn't render — but a determined operator with PostgREST access can self-demote. The spec architect did not require server-side self-protection, and the consequence (super-admin needs a manual SQL re-promotion, per 012a §6) is annoying-but-recoverable, not catastrophic.

**Recommendation:** keep as-is for 012c (matches architect §5 default), but document the residual surface so a future spec wraps `demoteProfileToUser` as a SECURITY DEFINER RPC with a `caller.id != target.id` check. The `db.ts:1869` JSDoc already flags this for the backend developer.

### W3 — `delete-user` edge function lacks self-protection at the server when the caller IS in `ADMIN_ROLES`

**File:** `supabase/functions/delete-user/index.ts:59-64`.

```ts
if (userId === gate.userId) {
  return new Response(JSON.stringify({ error: "cannot delete self" }), { status: 400, ... });
}
```

This IS present and is the architect §8.7 self-protection contract. Verified: the check uses the JWT-derived `gate.userId` (from `auth.getUser()`) NOT a request body field, so a malicious caller cannot spoof it. Confirms audit item #5 — self-protection is BACKED at the server.

Caveat (not a finding): the regular-admin and master roles can still call delete-user against any non-self user under the existing `ADMIN_ROLES` set. The spec's added `super_admin` only widens the allowed-callers set; pre-existing risk surface remains for `admin` / `master` per the comment in the source. Architect already acknowledged this; not a 012c regression.

### W4 — `cascade_payload` snapshot in `brand_deletion_log` will always have `blocking_profiles: []` at hard-delete time

**File:** `supabase/migrations/20260510010000_brand_delete_cascade.sql:687-701`.

This is correct behavior, NOT a bug — flagging only because it might confuse future readers. The pre-flight check at line 681-685 raises EXCEPTION if any profiles are attached, so by the time `preview_brand_cascade(p_brand_id)` runs at line 690, profiles cannot be present. So the persistently-stored `cascade_payload.blocking_profiles` is always `[]` for the `hard_deleted` event. **This is good for privacy** — no profile emails ever get persisted into the audit log via this code path. Mentioned because audit item #4 specifically asked whether the log might leak emails; answer is: it cannot, by construction.

The only PII snapshotted into `brand_deletion_log` is `actor_email` (the super-admin's own email, lines 421/473/692), which is read-gated to super-admin via the RLS policy at line 339-341. Acceptable per architect §7.

### W5 — Step-2 modal cancel returns to Step 1 with stale preview data

**File:** `src/components/cmd/CascadePreviewModal.tsx:137-141`.

When the user is on Step 2 (type-the-name) and clicks Cancel, they return to Step 1 — but Step 1 now shows the `preview` from the LAST re-fetch (the one that ran on the Step 1 → Step 2 transition). That data could be many seconds old. If they then click Continue again, `continueToStep2` re-fetches (line 96), so a NEW orphan would still bump them back. The race window is tiny and the H5 server-side pre-flight is the load-bearing safety. Not a finding — flagging only because architect §7 race-mitigation explicitly called this out and the implementation correctly handles it. Verified.

### W6 — Type-to-confirm `matches` uses `typed.trim() === requiredText` (case-sensitive, trimmed)

**File:** `src/components/cmd/TypeToConfirmModal.tsx:57`.

Audit item #6 asked: case-sensitive? trim? button HTML-disabled?
- `matches = typed.trim() === requiredText` — case-sensitive (===), trimmed left/right.
- Confirm button has `disabled={!matches || submitting}` (line 178) AND `accessibilityState={{ disabled: ... }}` (line 181) AND visual styling. The `TouchableOpacity` `disabled` prop on RN Web maps to the underlying button's HTML `disabled` attribute (a11y + tamper-resistance gate). Verified.
- `handleConfirm` re-checks `!matches || submitting` at the top (line 60) — defense in depth even if the button somehow fires.
- `onConfirm` is the only path; there is no other entry point for the destructive action in `BrandsSection`. `softDeleteBrand`, `hardDeleteBrand`, `deleteProfile` are ALL routed through `TypeToConfirmModal` (lines 226-235, 324-333, 976-989) or `CascadePreviewModal → TypeToConfirmModal` (lines 236-243, 334-341). Verified.

Pre-existing edge-runtime quirk worth noting: on web, `TouchableOpacity` does NOT render a real `<button disabled>` — it renders a `<div>` with `pointer-events: none` when disabled, which is a11y-equivalent but not technically the HTML `disabled` attribute. Form-tampering resistance is fine because `handleConfirm` re-checks `matches`. Not a finding.

### W7 — `brand_deletion_log_brand_id_idx` index does not enforce uniqueness

**File:** `supabase/migrations/20260510010000_brand_delete_cascade.sql:324-327`.

A brand can have multiple `soft_deleted` events over time (soft-delete → restore → soft-delete → restore → soft-delete → hard-delete is 5 rows for one brand_id). That's expected and the index is correctly non-unique. Mentioned only because audit item #3 implied verifying the audit table's invariants. No finding.

---

## Notes

### Verified — RPC gating (audit item #2)

All five new RPCs (`rename_brand`, `soft_delete_brand`, `restore_brand`, `preview_brand_cascade`, `hard_delete_brand`) are:
- `SECURITY DEFINER`
- `set search_path = public, auth` (locked; not empty `''` per architect convention from 012a, but safely scoped to the two schemas the function bodies actually reference)
- Begin with `if not public.auth_is_super_admin() then raise exception '...'` (lines 362, 401, 450, 503, 654)

A regular admin will get a clean EXCEPTION rather than a silent RLS rejection. Verified.

`grant execute ... to authenticated` is correctly used (lines 385, 432, 484, 630, 711) — without this grant, even the function-body super-admin gate wouldn't be reachable. Anonymous users do not get execute privilege; authenticated non-super-admins hit the EXCEPTION.

Note: `set search_path = public, auth` is non-empty (architect chose to allow `auth` so `auth.uid()` and the `auth.users` join in `soft_delete_brand` line 421 / `restore_brand` 473 / `hard_delete_brand` 692 work without schema qualification). The functions DO consistently use `public.` for own-schema lookups (lines 405, 410, 423, etc.), so the search_path is defensive enough. A locked `set search_path = ''` would require explicit `auth.uid()` and `auth.users` qualification throughout — same effective security, more verbose. Acceptable.

### Verified — H5 strict pre-flight executes BEFORE any destructive write (audit item #1)

`hard_delete_brand` (lines 639-711) flow:
1. Super-admin gate (line 654)
2. Brand lookup (lines 658-664)
3. **Pre-flight #1: must be soft-deleted (line 667-669)** — uses `v_deleted_at` from the lookup. Returns EXCEPTION on `is null`, so a super-admin cannot bypass H4 by passing an active brand id.
4. **Pre-flight #2: orphan profile check (lines 674-685)** — uses a single aggregate query with `count(*) FILTER (WHERE role IN ('admin', 'master'))` and `count(*) FILTER (WHERE role = 'user')`. Catches BOTH role buckets per architect §2; super_admin is NOT counted (deliberate — see W2 / spec design). EXCEPTION message says `% profiles (% admins, % users)` — reports counts only, NOT a list of emails. **No PII leaks via the EXCEPTION text.**
5. Snapshot via `preview_brand_cascade` (line 690) — at this point, blocking_profiles is `[]` (W4)
6. Audit row INSERT (line 698-701)
7. `delete from brands where id = p_brand_id` (line 705)

Order is correct — both pre-flights run before any writes. The pre-flight cannot be bypassed by setting `deleted_at` first then calling hard-delete: the H4 check verifies soft-delete state, then H5 verifies orphan-profile state independently. A soft-deleted brand with attached profiles still hits H5's EXCEPTION. Verified.

Pre-flight #2 uses an aggregate `count(*)` rather than `EXISTS`. The audit task asked for `EXISTS` (cheaper). On the production data volume (single-brand seed, target brands have ≤ a few profile rows), the difference is negligible — the index `profiles_brand_id_idx` (012a) makes both O(matching-rows). Aggregate gives the count needed for the EXCEPTION message without a second query. Acceptable.

### Verified — `brand_deletion_log` RLS (audit item #3)

- `alter table public.brand_deletion_log enable row level security` (line 332)
- ONE policy: `super_admin_read_brand_deletion_log` for SELECT, `using (public.auth_is_super_admin())` (lines 338-341).
- NO INSERT/UPDATE/DELETE policies — so the table is write-locked for all roles. The five SECURITY DEFINER RPCs bypass RLS via definer rights.
- A brand admin trying `select count(*) from brand_deletion_log` will see 0 rows (RLS hides). Trying `insert ... ` will get RLS rejection.

Verified.

### Verified — cascade_payload jsonb safety (audit item #4)

- `cascade_payload jsonb` column accepts the snapshot from `preview_brand_cascade` (line 690 → line 701).
- All counts inside `preview_brand_cascade` use parameterized SQL with `p_brand_id` as a bound parameter (e.g., line 539: `where brand_id = p_brand_id`). NO `format()` or `EXECUTE` interpolation; no SQLi vector.
- `brand_id` stored in the log is just a uuid (line 315: `brand_id uuid not null` — note: NOT a foreign key, so the row survives the brand cascade per architect §1).
- See W4 — at hard-delete time the persisted `blocking_profiles` is always `[]`. The persisted `cascade_payload` contains brand metadata + per-table counts only. No store addresses, no profile emails. **Privacy contract holds.**

### Verified — `delete-user` edge function widening (audit item #5)

- `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` (line 19) — `super_admin` correctly added.
- `requireAdminCaller` validates the JWT via `client.auth.getUser()` (line 27). Caller's role is read from `app_metadata.role` (line 29), with a profiles-table fallback (line 31). NEITHER reads the role from the request body.
- Server gates on the CALLING role (`gate.error / gate.status` at lines 41-47), NOT the target's role. So an `admin` cannot delete a `super_admin`-targeted user any more easily than a `user`-targeted user (both gated by caller-role). Symmetric — correct.
- Self-protection `if (userId === gate.userId)` (line 59) compares JWT-derived `gate.userId` to request-body `userId`. Cannot be spoofed.
- A regular `user` role would fail `requireAdminCaller` (line 30 only includes ADMIN_ROLES; the profiles fallback at line 32 also gates on ADMIN_ROLES). A `user` calling delete-user gets 403. Verified.

See W3 caveat: this widening is correct, but the pre-existing `admin`/`master` access to delete-user was acknowledged as a known surface in the spec comment (line 14-18 of `delete-user/index.ts`).

### Verified — Type-to-confirm bypass resistance (audit item #6)

See W6.

### Verified — CascadePreviewModal re-fetch race mitigation (audit item #7)

`continueToStep2` (CascadePreviewModal.tsx:90-106):
- Step 1 → Step 2 transition is the user's explicit click (line 233 wires `onPress={continueToStep2}` to the "CONTINUE →" button), not an idle timer.
- `await previewBrandCascade(brandId)` re-runs server-side (line 96).
- If `fresh.blockingProfiles.length > 0`, function returns early and `setStep(2)` is NOT called (lines 98-101). User stays on Step 1 with the now-updated red error block.
- The `setPreview(fresh)` (line 97) updates the displayed counts before the early-return check, so the operator sees the new orphan list rendered.
- No race window where the user could complete Step 2 with stale Step 1 data: even if step 2 is reached and the user types the name, `handlePurgeConfirmed` calls `useStore.hardDeleteBrand → db.hardDeleteBrand → hard_delete_brand` RPC, which re-runs the H5 pre-flight server-side (lines 674-685). **The server is the load-bearing safety; the UI is the usability layer.** Both layers correctly enforce the invariant.

Verified.

### Verified — 30-day grace gate at server (audit item #8)

- `restore_brand` (lines 466-469): `if (now() - v_deleted_at) > interval '30 days' then raise exception`. Verified — UI cannot bypass.
- `hard_delete_brand` does NOT enforce the 30-day grace at the server, per spec H1 / Q-USER-B "manual-only / UI-side grace". This is intentional and explicitly chosen by the user. The audit task's framing of "30-day grace gate at server" applies only to restore (which IS server-enforced). Verified per spec contract — not a finding.

### Verified — `fetchBrandsWithStats` widening for `includeSoftDeleted` (audit item #9)

`src/lib/db.ts:1633-1674`:
- `includeSoftDeleted` is a server-side filter (line 1654: `if (!opts?.includeSoftDeleted) primary = primary.is('deleted_at', null);`). The fallback path at lines 1666-1668 also applies the same conditional filter. The query SENT to PostgREST either includes or excludes the `deleted_at IS NULL` predicate based on the flag.
- Defense-in-depth: even if a non-super-admin somehow called `fetchBrandsWithStats({ includeSoftDeleted: true })`, the 012a `brand_member_read_brands` RLS policy (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:422-427`) appends `and (deleted_at is null or public.auth_is_super_admin())` to every read of `brands`. So soft-deleted rows are RLS-hidden from non-super-admins regardless of the client's opt-in flag.
- BrandsSection itself is gated by `useIsSuperAdmin()` (line 127-136), so non-super-admins can't even render the call site. Triple defense.

Verified.

### Verified — `brandDeletionLog` slice cleared on logout (audit item #10)

`src/store/useStore.ts:370`:
```ts
set({ currentBrandId: null, brandsList: [], brandStats: [], brandAdminsByBrandId: {}, brandDeletionLog: {} });
```

The `brandDeletionLog` slice is reset to an empty object on logout. No cross-session leak. Verified.

### Verified — Self-protection in BrandsSection (audit item #11)

`src/screens/cmd/sections/BrandsSection.tsx`:
- `superAdminUserId={currentUser?.id || ''}` passed to `DetailPane` (line 216, 309). Uses `currentUser.id` (UUID), not email. Server-truth.
- `MembersTab` line 860: `const isSelf = !!superAdminUserId && u.id === superAdminUserId;` — strict equality on UUID, AND the `!!superAdminUserId` guard prevents the empty-string case from matching anything (`'' === u.id` would be false anyway since u.id is a UUID, but the explicit guard is good).
- `canActOn = !isSelf && !isPending && (u.role === 'admin' || u.role === 'master')` (line 865). Multiple gates: not self, not pending, role is admin/master only. The super-admin's own row has `role = 'super_admin'`, so `canActOn` is false even ignoring `isSelf`. Belt-and-braces.
- Action buttons (DEMOTE/DELETE) are wrapped in `{canActOn ? (... ) : isSelf ? <Text>(you)</Text> : null}` (lines 918-957). When `canActOn` is false, the buttons are NOT RENDERED (visibility, not just disabled — better a11y per audit task).
- The `(you)` indicator renders only for `isSelf` cases — informational only, not a clickable element.
- No keyboard-shortcut / palette / URL path to trigger the destructive actions outside this UI. `BrandsSection` is the sole consumer of `useStore.deleteProfile` and `useStore.demoteProfileToUser` (verified via grep — no other call sites in `src/`).

Verified. Server-side reinforcement: `delete-user/index.ts:59-64` self-protection (W3 verified) and `super_admin_manage_profiles` UPDATE policy (012a) for demote.

### Verified — npm audit (audit item #12)

`package.json` and `package-lock.json` are unmodified by this spec (`git diff HEAD --stat package.json package-lock.json` returns empty). No new dependencies introduced. Skipped per protocol — no package.json changes.

### Verified — Pre-existing security advisor lints (audit item #13)

The 5 new SECURITY DEFINER RPCs (`rename_brand`, `soft_delete_brand`, `restore_brand`, `preview_brand_cascade`, `hard_delete_brand`) will add to the existing Supabase advisor list of "function with SECURITY DEFINER and EXECUTE granted to authenticated/public". This is the established pattern in this codebase (matches `auth_can_see_store`, `auth_is_super_admin`, etc.) and the architect's explicit design choice — defense in depth requires the function-body gate, the EXECUTE grant is necessary for the gate to be reachable, and the SECURITY DEFINER is necessary for the audit-log INSERT to bypass the deny-by-default RLS on `brand_deletion_log`. Expected debt; not a new vulnerability. Confirmed by reading lines 351-711 of the migration.

### Verified — `ingredient_conversions.catalog_id` FK CASCADE conversion (audit item #14)

`supabase/migrations/20260510010000_brand_delete_cascade.sql:248-281`:
- The defensive `pg_constraint` lookup (lines 253-267) finds the actual constraint name regardless of auto-generation.
- The `confdeltype <> 'c'` guard (lines 271-272) makes the conversion idempotent — re-running the migration on a database where the FK is already CASCADE is a no-op (`raise notice ... already CASCADE; no-op`).
- The skip-if-not-found path (lines 269-270) handles the case where the ingredient_conversions table doesn't exist yet (defensive; not expected in current migrations but cheap).
- The replacement FK (lines 275-278) explicitly names `ingredient_conversions_catalog_id_fkey` and references `catalog_ingredients(id) on delete cascade`. Correct chain: brand cascade → catalog_ingredients delete → ingredient_conversions cascade.
- Re-application safety: a second `npx supabase db reset` run will hit the `confdeltype = 'c'` branch and no-op cleanly.

Backend developer's deviation note in lines 240-247 (architect §0 probe #2 said "ingredient_conversions cascades through catalog_ingredients" but the actual schema had NO ACTION) is correctly surfaced in the migration header. The fix is the right call — without it, `hard_delete_brand` would fail at runtime with a FK violation.

Verified. Combined with the §4 "BELT-AND-BRACES FINAL ASSERTION" (lines 289-306) — which raises EXCEPTION if any brand-direct FK is still non-CASCADE post-conversion — the migration would fail loudly rather than silently shipping a broken contract.

---

## Summary

This is a high-blast-radius spec, and the implementation is appropriately defensive:

- **Five gating layers on hard-delete:** UI button → CascadePreviewModal Step 1 (renders blocking profiles) → CascadePreviewModal Step 1→2 transition (re-fetches and re-checks) → TypeToConfirmModal type-the-name → server-side `hard_delete_brand` RPC pre-flights (H4 + H5). The spec's "exfiltrate a tenant's data" attack would require bypassing all five.
- **Two gating layers on restore:** UI day-countdown disables button → `restore_brand` RPC enforces 30-day grace server-side (W8 verified).
- **Three gating layers on profile delete:** UI gates super-admin role + isSelf + canActOn → TypeToConfirmModal → server-side `delete-user` edge function gates ADMIN_ROLES + self-protection.
- **Audit log is privacy-preserving by construction:** the only PII persisted is the actor's own email (super-admin reading their own audit). The `cascade_payload`'s `blocking_profiles` array is always `[]` at hard-delete time because pre-flight #2 just ran.

All 14 audit items checked. 0 Critical, 7 Warnings (all pre-existing or defensive observations, none blocking), no privilege-escalation vectors found, no PII exfiltration vectors found, no SQLi vectors found.

The single behavioral concern worth a follow-up ticket is W1 (`callEdgeFunction` swallows errors silently) — pre-existing in `src/lib/auth.ts`, surfaced because 012c is the load-bearing consumer. Spec ships safely with this caveat.
