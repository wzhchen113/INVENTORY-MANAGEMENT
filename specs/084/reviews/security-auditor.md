# Security audit for spec 084

Scope audited: the staged TS read-path change — `fetchBrandAdmins` in
`src/lib/db.ts` (drop the `.eq('brand_id', brandId)` from the `invitations`
query + strict `&& inv.brand_id === brandId` gate on `pendingInvites`), the
comment-only rewrite in `src/lib/auth.ts:465-475`, and the four new jest arms in
`src/lib/db.fetchBrandAdmins.test.ts`. Read-only. `npm audit` not run — no
dependency manifest changed (`git diff --staged --name-only` shows only
`specs/084/spec.md`, `src/lib/auth.ts`, `src/lib/db.fetchBrandAdmins.test.ts`,
`src/lib/db.ts`; no `package.json` / lockfile).

## The headline question — does dropping `.eq('brand_id', brandId)` from `fetchBrandAdmins` widen what a non-super-admin can READ from `invitations`?

**No. The reasoning from spec 083's audit transfers identically, and I
re-verified the RLS chain independently against the live policy.**

`fetchBrandAdmins` reads the SAME `invitations` table through the SAME RLS as
`fetchInvitationsForUserLookup` (the function spec 083 relaxed). The row-visibility
boundary is the database policy, not the client `.eq`:

1. RLS is enabled on `public.invitations` (established in spec 083's audit,
   `20260502071736_remote_schema.sql:99`).
2. The live `invitations` SELECT policy is `using (public.auth_is_privileged())`
   — `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:33-35`
   (this migration drops the four older `['admin','master']` JWT policies by name
   and is the single live SELECT policy).
3. `public.auth_is_privileged()` is
   `select public.auth_is_admin() or public.auth_is_super_admin();` —
   `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`.
   **It contains no `brand_id` reference and no brand scoping of any kind.**

So this is the blanket admin-OR-super_admin gate with NO brand isolation, exactly
the case spec 083's audit analyzed (`specs/083/reviews/security-auditor.md`,
"headline question" section). Any caller for whom `auth_is_privileged()` is true
**could already read every invitation row across every brand** before this change
— the DB has never row-isolated `invitations` SELECT by brand. The
`.eq('brand_id', brandId)` was a **client-side table-read narrowing only**, never
a security boundary; a privileged caller could bypass it by issuing any other
PostgREST query. Dropping it changes *what is fetched to the already-authorized
client*, not *what is authorized*. No invitation row (and therefore no email)
becomes readable to any principal who could not already read it. **No new
cross-brand exposure; no privilege change. Spec 084 introduces no exposure beyond
what spec 083 already established as safe.**

Two corroborating points (also confirmed for this function specifically):

- **Which USERS appear is still brand-scoped and untouched.** The `profiles` read
  inside `fetchBrandAdmins` keeps `.eq('brand_id', brandId)`
  (`src/lib/db.ts:3250`) and `profilesRes.error` is still rethrown
  (`src/lib/db.ts:3274`). A brand admin still only enumerates their own brand's
  profiles; the relaxation only lets a NULL-brand invitation resolve the inferred
  email for a profile the admin's policy already admits. Same property spec 083
  relied on for the `profiles` query in `fetchAllUsers`.
- **Non-privileged surfaces gain nothing.** Staff PWA / customer PWA / anon have
  `auth_is_privileged() = false`, so RLS returns zero `invitations` rows
  regardless of any client filter. The only anon/authenticated read path into
  `invitations` is the unchanged `SECURITY DEFINER get_pending_invitation(p_email)`
  RPC, which is not in scope and not touched here.

## Secondary checks

- **`pendingInvites` strict-equality gate (`src/lib/db.ts:3345-3347`).** The new
  predicate `!inv.used && inv.brand_id === brandId` is strict equality — `null ===
  brandId` is `false`, so NULL-brand and foreign-brand unconsumed invites are
  EXCLUDED from every brand's pending list. This is a **display-narrowing that is
  MORE restrictive than the prior behavior**, not less: pre-fix, the dropped query
  filter performed the equivalent narrowing at the SQL layer; post-fix the JS
  predicate performs it in memory. Excluding NULL-brand pending invites from the
  members tab creates **no security issue** — it shows fewer phantom rows, never
  more, and the rows it gates were never a confidentiality concern (the caller is
  already authorized to read every invitation row anyway). No finding. (It is also
  the load-bearing correctness guard the spec/architect flagged; I confirm the
  predicate is the strict form with no `|| inv.brand_id == null` escape hatch that
  would have re-widened the pending list.)
- **No new secrets / no injection surface.** The db.ts change REMOVES a `.eq`,
  reducing client-side dynamic query construction rather than adding any; all
  remaining query construction uses bound PostgREST builder calls. No string
  interpolation into SQL. No new env reads, no tokens/keys, no `console.*` of
  sensitive data introduced.
- **`auth.ts` change is comment-only.** The staged diff
  (`src/lib/auth.ts:465-475`) touches only the comment lines; the operative line
  `const invitations = await fetchInvitationsForUserLookup(opts?.brandId);`
  (`src/lib/auth.ts:475`) is byte-for-byte unchanged. `fetchAllUsers` logic is not
  altered. No behavior change, no security surface. The rewritten comment now
  accurately states 083 dropped the brand filter and that `opts?.brandId` is
  retained-but-ignored — correcting a stale claim, not introducing risk.
- **Tests.** The four new jest arms (e / f / f-bis / g) are fully mocked, use
  synthetic `@example.com` data only, no live Supabase, no credentials. Arm (f)
  and (f-bis) pin the pollution guard (NULL-brand AND foreign-brand unconsumed →
  zero pending rows), which is a useful regression guard against re-widening. No
  security concern; included for completeness.

## Critical (BLOCKS merge)

None. The only change with authorization implications — dropping the client-side
`.eq('brand_id', brandId)` from the `invitations` read — does not widen
authorization, because the `invitations` SELECT boundary is RLS
(`using (auth_is_privileged())`, a brand-agnostic admin/super_admin gate), not the
client filter. Every principal that can now fetch a given invitation row could
already fetch it. The spec is clear to advance on security grounds.

## High (must fix before deploy)

None.

## Medium

None.

## Low

None.

## Dependencies

No `package.json` / lockfile changes — `npm audit` skipped. (`git diff --staged
--name-only` shows no dependency manifest touched; the only modified tracked
source files are `src/lib/db.ts`, `src/lib/auth.ts`, and the jest file.)

## Summary

Spec 084 is a TS-only read-path correctness fix with no Critical, High, or Medium
security findings. The one change with authorization implications — removing
`.eq('brand_id', brandId)` from `fetchBrandAdmins`'s `invitations` read — is safe
for the same reason spec 083's identical change to `fetchInvitationsForUserLookup`
was safe, and I re-verified it independently: the `invitations` SELECT
row-visibility boundary is RLS (`using (public.auth_is_privileged())`, an
admin-OR-super_admin gate with zero brand scoping at
`20260509000000_multi_brand_schema_rls.sql:235-239` and
`20260514150000_invitations_super_admin_rls.sql:33-35`), not the client-side
filter; any caller who can now read a brand's invitations could already read every
brand's invitations, so no new cross-brand email exposure is introduced. The new
strict `inv.brand_id === brandId` gate on `pendingInvites` is a display-narrowing
that is strictly MORE restrictive (NULL-brand and foreign-brand unconsumed invites
are excluded from every brand) and raises no confidentiality concern. The
`auth.ts` change is comment-only with no behavior change. The change REMOVES a
`.eq` (reducing dynamic query construction), introduces no secrets, no injection
vector, and no dependency changes. No finding BLOCKS this spec.
