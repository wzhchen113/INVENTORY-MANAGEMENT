# Security audit for spec 043 — Profiles RLS sweep

Reviewer: security-auditor
Date: 2026-05-17

## Scope

Spec 043 closes the two carry-forward Medium findings from Spec 042's
security audit — cross-brand SELECT (information disclosure) and
cross-brand DELETE (destructive action) on `public.profiles`. One
migration, one edge-function defense-in-depth gate, one new pgTAP
file, and one in-place patch to the Spec 042 pgTAP file.

Files audited:
- `supabase/migrations/20260517060000_profiles_rls_sweep.sql` (new)
- `supabase/functions/delete-user/index.ts` (modified)
- `supabase/tests/profiles_rls_sweep.test.sql` (new)
- `supabase/tests/rls_hardening_followups.test.sql` (in-place patch
  around arm 9, lines 418-440)

## Live-verify results

All eight attack surfaces tested empirically against the running
local stack (Spec 042 round-4 lesson — read the actual probe output,
don't assume). Probes seed a synthetic brand-B + foreign-brand
profile, then verify post-attack state with `reset role` so the
inspection step bypasses RLS.

| # | Attack vector | Result | Expected |
|---|---|---|---|
| 1 | Brand-A admin `SELECT * FROM profiles WHERE brand_id=<brand_B>` | 0 rows | 0 rows |
| 2 | Brand-A admin `DELETE FROM profiles WHERE id=<brand_B_user>` | `DELETE 0`, row still present | RLS silently rejects |
| 3a | super_admin `SELECT` brand-B profile | 1 row | 1 row |
| 3b | super_admin `DELETE` brand-B profile | `DELETE 1`, row gone | success |
| 4a | Edge function: brand-A admin → brand-B target | HTTP 403 `forbidden: target is in a different brand`, target still present | 403 + target preserved |
| 4b | Edge function: brand-A admin → brand-A target | HTTP 200 `{"success":true}`, target gone | 200 + delete cascade |
| 4c | Edge function: super_admin → brand-B target | HTTP 200 `{"success":true}`, target gone | 200 + delete cascade |
| 5 | Self-DELETE via SQL (brand-A admin → own row) | P0001 `'profile self-delete is not permitted'` | P0001 (spec 041 trigger) |
| 5b | Self-DELETE via edge function | HTTP 400 `'cannot delete self'` | 400 (spec 030 short-circuit) |

Aggressive sweep:

- **JOIN through `invitations` → `profiles`**: brand-A admin
  `SELECT p.* FROM invitations i JOIN profiles p ON i.profile_id=p.id
  WHERE i.profile_id=<foreign>` returns 0 rows. RLS correctly applies
  to the joined `profiles` rows.
- **`brand_id` enumeration**: `SELECT count(*) FROM profiles WHERE
  brand_id=<foreign>` returns 0 rows.
- **`id IN (...)` enumeration**: a known-foreign UUID alongside the
  admin's own UUID returns only the admin's own row.
- **Subquery through `invitations.email`**: also returns 0 rows.
- **`assert_not_last_of_role` SECURITY DEFINER bypass**: still works
  from `authenticated` context — RPC raises P0001 even when the
  caller's RLS view excludes the super_admin row (spec 031 invariant
  preserved).
- **Service-role direct call**: by design bypasses RLS (per spec
  043 risk register); the edge-function brand gate is the in-app
  defense, and TEST 4a empirically proves it fires.
- **TRUNCATE on `profiles` by authenticated**: still rejected with
  42501 (spec 041 round-3 REVOKE intact — verified via
  `information_schema.role_table_grants`: TRUNCATE not granted to
  `authenticated`/`anon`).
- **Body field spoofing**: extra `brandId`, `callerBrandId`,
  `role`, `appRole` keys in the edge-function POST body are ignored.
  `req.json()` only destructures `userId` (line 126); all
  brand/role decisions flow from JWT-validated `getUser()` and
  service-role-keyed DB lookups on `profiles`.
- **JWT spoofing**: even a JWT signed with the local secret claiming
  `app_metadata.role: 'super_admin'` for a non-super_admin user
  fails to bypass the gate. `client.auth.getUser()` re-reads the
  canonical `raw_app_meta_data` from `auth.users`; the spoofed JWT
  payload is not trusted. TEST 6 empirically confirmed: brand-A
  admin with spoofed super_admin claim → HTTP 403.

pgTAP suite: 28/28 files pass (`bash scripts/test-db.sh`).
`profiles_rls_sweep.test.sql` 12/12 arms green;
`rls_hardening_followups.test.sql` 15/15 arms green after the
architect-designed three-line arm-9 patch.

`pg_policies` final state on `public.profiles`:

```
"Admins can delete profiles"  DELETE  (auth_is_privileged() AND auth_can_see_brand(brand_id))
"Admins can read all profiles" SELECT ((auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid()))
```

Matches the spec exactly. No `USING (true)` and no
brand-blind admin arms remain on either verb.

`pg_publication_tables` for `profiles`: 0 rows (no realtime
leakage path). `relrowsecurity = t` (RLS enabled).
`relforcerowsecurity = f` (service-role/postgres bypass by design —
edge-function gate is the defense for the service-role path).

`npx tsc --noEmit`: exit 0.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None introduced by spec 043. The two carry-forward Mediums from spec
042 (cross-brand SELECT and DELETE on profiles) are now CLOSED by
this spec. Live-verify confirms both attack vectors return 0 rows
post-migration.

## Low

- `supabase/functions/delete-user/index.ts:81, 96, 179` — the new
  brand-gate helper (and the pre-existing `assert_not_last_of_role`
  lookup) propagate raw DB error messages to the response body
  (`targetErr.message`, `callerErr.message`, `lookupError.message`).
  In the steady state these are simple service-role `eq('id', uuid)`
  filters on `profiles` and the only realistic failure modes are
  network/connection drops where the message is benign. However, an
  unexpected DB-side error (e.g., custom RAISE inside a trigger
  added later) could surface internal schema or error text to the
  admin caller. Pre-existing pattern across the codebase (same
  shape at lines 192, 206), consistent with how `notifyBackendError`
  in the client toast surface is already wired. Not exploitable;
  not introduced by this spec. Tracking as a low-priority defense
  hardening for a future sweep. Fix shape would be a constant
  string like `'database lookup failed'` plus `console.warn` of the
  internal message in the function logs.

- `supabase/functions/delete-user/index.ts:80, 95` — when `targetErr`
  or `callerErr` is non-null, the function returns HTTP 403 with the
  DB error message. Semantically the status should be 500 (server
  error during DB lookup, not an authz refusal). The spec explicitly
  flows the 403 status through `brandGate.status`, so this is a
  deliberate choice — but it means an operator debugging a transient
  DB issue would see a `403 forbidden` toast in the admin UI instead
  of a clearer 5xx signal. Not a security issue (failing closed is
  correct); just a UX/observability finding. Pre-existing pattern is
  to use 500 for DB-side errors (line 180-183 lookup error is 500).

## Spec 042 carry-forwards (out-of-scope but worth flagging)

These are NOT findings against spec 043 — they were explicitly
deferred in the spec's "Out of scope" section. Surfacing here for
the release-coordinator's running risk register only.

- `public.invitations` table still has brand-blind admin policies
  (verified via `\d public.invitations`):
  `"Admins can read invitations" USING (auth_is_privileged())` —
  no brand check. JOIN LEAK 5 probe confirmed a brand-A admin can
  still SELECT a brand-B `invitations` row (yielding `email`,
  `profile_id`, `brand_id`). This is a cross-brand information
  disclosure surface separate from `profiles`, equivalent severity
  to the Medium spec 043 just closed on `profiles`. Recommend a
  follow-up sweep modeled on this spec (drop+recreate the four
  invitations policies with `auth_can_see_brand(brand_id)`). Not
  blocking for spec 043 — it was already open before this spec.

- `"Anyone can insert own profile or admin can insert any"` INSERT
  policy on `profiles` still has no brand check. Per spec 042
  audit and spec 043 §"Out of scope" this is operationally inert
  (the FK to `auth.users` and the
  `profiles_role_brand_consistent` CHECK block the cross-brand
  INSERT chain unless service_role is already compromised).
  Tracking only; no action needed in this spec.

## Dependencies

`npm audit --audit-level=high` (run despite no `package.json`
change, per audit prompt):

```
11 vulnerabilities (5 low, 5 moderate, 1 high)

High:
- @xmldom/xmldom <=0.8.12 — DoS via uncontrolled recursion,
  XML injection (4 advisories).

Moderate:
- dompurify <=3.3.3 — FORBID_TAGS / SAFE_FOR_TEMPLATES /
  Prototype Pollution to XSS (4 advisories).
- postcss <8.5.10 — XSS via unescaped </style> in CSS stringify.
- jest-environment-jsdom → jsdom → http-proxy-agent → @tootallnate/once
  — Incorrect Control Flow Scoping (jest-only).
```

All carry-forward from spec 042's audit. No new dependency
findings introduced by spec 043 (no `package.json` change in this
spec). Per spec 043 §"Out of scope": "Dependency `npm audit`
triage. Spec 042 carry-forwards (`@xmldom/xmldom` high,
postcss/dompurify/jest-expo moderate) remain out of scope; tracked
in spec 037+ register."

## Verdict

Spec 043 cleanly closes the two carry-forward Mediums from spec
042's audit. The SQL-side policy tightening is correct (verified by
`pg_policies` + live attack reproduction). The edge-function
defense-in-depth gate is well-shaped: caller's brand pulled from
service-role-keyed DB lookup (cannot be spoofed via request body
or JWT payload), runs BEFORE `assert_not_last_of_role` (delivers
the right error in the right order), and preserves the
auth-only-user cleanup path. Empirical attack reproductions all
fail correctly. No regressions in the 28-file pgTAP suite. The
architect-designed arm-9 patch to `rls_hardening_followups.test.sql`
correctly closes the test-side regression introduced by the new
SELECT policy (verified: 15/15 arms pass after patch).

No Critical or High findings. Two Lows on edge-function error
surfacing are pre-existing patterns, not new in this spec.

Spec is clear to ship from a security perspective.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low.
payload_paths:
  - specs/043-profiles-rls-sweep/reviews/security-auditor.md
