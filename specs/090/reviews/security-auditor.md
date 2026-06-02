# Security audit for spec 090

Scope: prevent NULL-brand user/manager invitations at the source. App-level / auth-path
change only; the architect confirmed no migration, RLS, edge-function, or realtime change.
Files audited (UNSTAGED — `git diff HEAD` + untracked):

- `src/components/cmd/InviteUserDrawer.tsx` (the `inviteUser` call site — primary fix)
- `src/lib/auth.ts` (`inviteUser` defense-in-depth derive + stale doc-comment fix)
- `src/lib/inviteUser.test.ts` (new jest)

Supporting (read-only, to verify the auth claims): the `invitations` and `stores` RLS
policies, `auth_can_see_store`, and the spec-068 `user_stores_brand_match` trigger.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

None.

---

## What I verified (the auth-adjacent claims this spec hinges on)

### 1. The invite flow is server-side privilege-gated — the derive can't be triggered by a non-admin

The actual security boundary on the whole flow is the `invitations` INSERT RLS policy, NOT
the UI button:

- `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:37-39` —
  `"Admins can insert invitations" ... with check (public.auth_is_privileged())`.
  `auth_is_privileged()` = admin OR master OR super-admin. A non-privileged caller's INSERT is
  rejected by RLS regardless of the client. So the entire `inviteUser` path (and therefore the
  new `stores` derive read inside it) is reachable only by a privileged caller.

Note on the client gate: the `+ INVITE USER` button (`UsersSection.tsx:137`) is rendered in the
TabStrip `rightSlot` and is NOT wrapped in an `isMaster` check, so the drawer is openable by any
role that can reach `UsersSection`. This is NOT a finding: (a) per CLAUDE.md the client role hook
is not a security boundary — server-side `auth_is_privileged()` is; (b) it is pre-existing, not
introduced by spec 090; (c) a non-privileged caller who opens the drawer and submits gets an RLS
denial on the `invitations` INSERT, surfaced via the existing `Toast.show({ type: 'error' })`.
No data is exposed.

### 2. The new `stores` read is RLS-bounded to stores the caller can already see — no foreign-brand leak

`src/lib/auth.ts:313-320` runs `supabase.from('stores').select('brand_id').eq('id', storeIds[0]).single()`
under the inviting caller's anon-key + JWT session (not the service-role client). The governing
policy is:

- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:616-618` —
  `"store_member_read_stores" ON public.stores FOR SELECT USING (public.auth_can_see_store(id))`.
- `auth_can_see_store` (`20260517040000_auth_can_see_store_brand_scope.sql:88-108`): super-admin →
  all; admin/master → only stores in their own brand (`auth_can_see_brand(s.brand_id)`); everyone
  else → only `user_stores`-granted stores.
- RLS is enabled on `stores` (`20260405000759_init_schema.sql:241`).

Consequence for the "could a caller craft a `storeIds[0]` for a store they can't see?" question:
they can pass any UUID, but the SELECT is filtered by `auth_can_see_store(id)`, so an unseen store
returns **zero rows** → `.single()` resolves `{ data: null }` → `store?.brand_id ?? null` → the
invite stays NULL-brand. This is the pre-existing benign state, not a leak. The read can only ever
return the `brand_id` of a store the caller is already authorized to see. **Fails SAFE.**

### 3. Cross-brand integrity — the derived brand always matches the assigned store's *real* brand

Both layers derive the brand from authoritative data, not a client assertion:

- Drawer (`InviteUserDrawer.tsx:154-159`): `brandStores.find(s => s.id === storeIds[0])?.brandId`,
  where `brandStores` is filtered to the single active brand (`:84-87`, spec 068) and stale
  cross-brand selections are pruned on a brand switch (`:96-111`). So the value passed is the
  brand of an actually-selected, brand-filtered store.
- `inviteUser` (`auth.ts:313-320`): reads the store's `brand_id` straight from the DB.

Neither path lets a user be invited into brand B while assigned brand-A stores. Even the
hypothetical "a future caller passes a mismatched non-null `brandId` for a `role='user'` invite"
is caught downstream by the spec-068 `user_stores_brand_match` trigger
(`20260528010000_...`), which rejects any `user_stores` grant whose store brand ≠ the
(now non-null) profile brand — so the user cannot end up with brand-A store access under a brand-B
profile. That mismatched-non-null path is also NOT introduced by this spec: the old code wrote
`brand_id: opts.brandId` verbatim too; spec 090 only changed the `brandId === null` branch
(deriving instead of leaving null), which strictly narrows exposure.

### 4. The no-throw fallback fails safe — cannot mint a wrong-brand invite

`resolvedBrandId = store?.brand_id ?? null` (`auth.ts:319`). If the read errors or returns nothing,
`brandId` stays `null` → a NULL-brand invite, which is the pre-existing benign state (the profile
is later stamped at register time from `get_pending_invitation.resolved_brand_id`, spec 069). The
fallback can only ever produce NULL or the real store brand — never a *different* brand. Confirmed
fails safe.

### 5. No new exposure, no secret handling, no new grant, no PII in logs

- No `app_metadata` / role write; no privilege escalation surface. The admin missing-brand guard
  (`auth.ts:279-281`) fires before any new code and is unchanged.
- The `invitations` write path and its RLS are unchanged; the only field whose *value* changes is
  `brand_id` (now `resolvedBrandId`). Insert shape is otherwise identical.
- No secrets touched. The read uses the existing anon-key client session; no service-role key, no
  `Deno.env`, no `EXPO_PUBLIC_*` change.
- No new `console.*` / `notifyBackendError` calls; the derived `brand_id` (a UUID, not PII) is
  never logged. The fire-and-forget `send-invite-email` payload is unchanged (no brand surfaced).
- The new jest mock (`inviteUser.test.ts`) returns no session for `getSession`, so no live network
  call and no token handling in the test.

## Dependencies

No `package.json` / `package-lock.json` changes (`git status` clean for both) — `npm audit`
skipped, consistent with the spec ("no new deps").

---

## Summary + verdict

Spec 090 is a tightly-scoped, fail-safe write-path fix. The single new auth-path read
(`stores.brand_id` by PK) runs under the inviting caller's own session and is bounded by the
existing `auth_can_see_store(id)` SELECT policy, so it can only read the brand of a store the
caller is already authorized to see; an unreadable/crafted store id returns null and the invite
stays benignly NULL-brand. The derived brand is always the store's *real* brand (never a
client-asserted one), the spec-068 trigger backstops any downstream cross-brand mismatch, the
no-throw fallback cannot mint a wrong-brand invite, and there is no secret handling, no new grant,
no role/`app_metadata` write, and no PII in logs. The whole flow remains gated server-side by
`auth_is_privileged()` on the `invitations` INSERT. No migration/RLS/edge/realtime change. I found
zero Critical, High, Medium, or Low findings.

**Verdict: PASS** — no findings; nothing blocks the spec.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 0 Low — PASS. The new
  stores brand-derive read in inviteUser runs under the caller's session and is bounded by
  the existing auth_can_see_store SELECT policy (an unseen/crafted store id returns null → benign
  NULL-brand invite, fails safe); the derived brand is always the store's real brand and the
  spec-068 user_stores_brand_match trigger backstops any cross-brand mismatch; whole flow gated
  server-side by auth_is_privileged() on the invitations INSERT. No secrets, no new grant, no PII
  in logs, no package.json change.
payload_paths:
  - specs/090/reviews/security-auditor.md
