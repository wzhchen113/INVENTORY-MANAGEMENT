# Security audit for spec 083

Scope audited: the data-only backfill migration, the `fetchInvitationsForUserLookup`
relaxation in `src/lib/db.ts`, the new pgTAP file, and the two new jest files.
Read-only; the only mutation considered was `npm audit` (not run — no `package.json`
change). Working tree confirms `package.json` is untouched (`git diff --name-only` →
only `src/lib/db.ts` modified + the four new spec-083 files).

## The headline question — does dropping `.eq('brand_id', brandId)` widen non-super-admin reads from `invitations`?

**No. Verified independently against the actual RLS policy. The architect's §2 claim holds.**

Chain of evidence:

1. RLS is enabled on the table — `alter table "public"."invitations" enable row
   level security;` (`supabase/migrations/20260502071736_remote_schema.sql:99`).
2. The live `invitations` SELECT policy is
   `using (public.auth_is_privileged())` —
   `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:33-35`
   (this migration drops the four earlier `['admin','master']` JWT policies from
   `20260424211733_security_fixes.sql:42-57` and replaces them byte-for-byte by
   name, so it is the single live SELECT policy).
3. `public.auth_is_privileged()` is
   `select public.auth_is_admin() or public.auth_is_super_admin();` —
   `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`.
   **It contains no `brand_id` reference and no brand scoping of any kind.**
   Neither `auth_is_admin()` nor `auth_is_super_admin()` constrains rows by brand.

This is therefore the **blanket admin-OR-master-OR-super_admin gate with NO brand
scoping** case described in the audit brief, not the brand-scoped case. The
consequence, stated precisely:

- Any caller for whom `auth_is_privileged()` is true (a brand admin's JWT carries
  `app_metadata.role = 'admin'`, so `auth_is_admin()` is already true for them, as
  well as master and super_admin) **could already read every invitation row across
  every brand** before this change. The database has never row-isolated
  `invitations` SELECT by brand.
- The `.eq('brand_id', brandId)` was a **client-side display/table-read narrowing
  only** — a privileged caller could bypass it at will by issuing any other
  PostgREST query (or omitting the filter, exactly as this change now does). It was
  never a security boundary.
- Dropping it changes *what is fetched to the already-authorized client* (now the
  whole table instead of one brand's slice), but changes **nothing about what is
  authorized**. No invitation row (and therefore no email) becomes readable to any
  principal who could not already read it. **No cross-brand data exposure is
  introduced; no privilege change.**

Two corroborating points that make this safe rather than merely unchanged:

- The brand-isolation that actually scopes *which users a brand admin sees* lives on
  the **`profiles`** query inside `fetchAllUsers` (`src/lib/auth.ts`, filters
  profiles by `brand_id` when supplied), which this spec does **not** touch. So a
  brand admin still only enumerates their own brand's users; they just now also
  resolve the inferred email for a user whose matching invitation happens to carry
  `brand_id = NULL`. Email for that profile is data the admin's policy already
  admits.
- The non-privileged surfaces (staff PWA, customer PWA, anon) do not gain anything:
  `auth_is_privileged()` is false for them, so RLS returns zero `invitations` rows
  regardless of any client-side filter. The only anon/authenticated read path into
  `invitations` is the `SECURITY DEFINER` `get_pending_invitation(p_email)` RPC
  (`20260510000000_invitations_brand_id.sql:42-62`), which is unchanged by this spec
  and self-limits to a single used=false row by exact email. Not in scope, not
  affected.

## Critical (BLOCKS merge)

None. The single change that could have widened authorization (dropping the brand
filter) does not, because the `invitations` SELECT policy is RLS-enforced and
brand-agnostic; the client filter it removes was never the boundary. I find no
Critical findings, and the spec is clear to advance on security grounds.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql` (whole DO
  block) — purely informational, no action required. The backfill runs as the
  postgres/superuser migration role (bypasses RLS, standard and correct for a
  backfill). I confirmed it derives `brand_id` **only** from `public.profiles`
  (`p.brand_id`), never reads `auth.users`, and the `set` target on both UPDATEs is
  `brand_id` exclusively — it never writes `email`, `role`, `profile_id`, `used`, or
  any other column, and never writes NULL or the sentinel back (the `brand_id IS
  NULL` predicate is the idempotency guard). No auth-schema PII handling, no
  injection surface (no dynamic SQL / `EXECUTE`; all values are bound literals or
  column references). No secrets. The `raise notice` / `raise exception` strings emit
  only counts, never row data or emails. Clean.
- `src/lib/db.ts:136-146` — the relaxation **reduces** dynamic query construction
  (removes a conditional `.eq`), so it lowers rather than raises any
  injection/over-fetch surface. `brandId` is now accepted-but-unused; the retained
  param is dead but harmless and the doc comment (`db.ts:119-134`) accurately
  documents the change rather than leaving a stale "scoped at the SQL layer" lie.
  No finding — noting only that the now-unused parameter is an intentional
  call-site-compat choice per design §4, not an oversight.

## Notes on the tests (no security finding, included for completeness)

- `supabase/tests/invitations_brand_id_backfill.test.sql` — the two inline UPDATE
  copies (arms 2/4/6) are byte-identical to the migration's UPDATE #1 / UPDATE #2,
  satisfying the drift-discipline rule the header states; the file is hermetic
  (`begin; … rollback;`) and seeds only synthetic `*@test.local` fixtures (no real
  PII, no secrets). The deliberate absence of a `set role anon` + `throws_ok` arm is
  correct here (data-only migration, no grant/function change) and also dodges the
  spec-067 CI-segfault pattern.
- `src/lib/db.fetchInvitationsForUserLookup.test.ts` /
  `src/lib/auth.fetchAllUsers.test.ts` — fully mocked, no live Supabase, no
  credentials, synthetic `@example.com` data only. The mechanism-pin arm
  (`eqSpy` never called with `('brand_id', …)`) is a useful regression guard against
  silently re-introducing the filter. No security concern.

## Dependencies

No `package.json` changes — `npm audit` skipped. (`git diff --name-only HEAD` shows
no dependency manifest touched; the only modified tracked file is `src/lib/db.ts`.)

## Summary

Spec 083 is a backend, data-only bug fix with no Critical, High, or Medium security
findings. The one change with authorization implications — removing
`.eq('brand_id', brandId)` from `fetchInvitationsForUserLookup` — is safe because the
`invitations` SELECT row-visibility boundary is RLS (`using (auth_is_privileged())`,
a brand-agnostic admin/master/super_admin gate), not the client-side filter; every
principal that can now fetch a given invitation row could already fetch it, and the
brand-isolation of *which users appear* is enforced on the untouched `profiles` query
in `fetchAllUsers`. The backfill migration writes only `brand_id`, derives it solely
from `public.profiles` (never `auth.users`), uses no dynamic SQL, leaks no PII in its
notices, and is idempotent. No secrets, no new input-validation surface, no injection
vector (the change reduces dynamic query construction), no dependency changes. No
finding BLOCKS this spec.
