# Security audit for spec 157 — super_admin RLS parity + honest DB Inspector banner

Auditor: security-auditor. Reviewed the staged surface at working tree (clean `main` @ `6dda20c` + 5 staged files).

Files audited:

- `supabase/migrations/20260809000000_super_admin_policy_parity.sql` (new, 407 lines)
- `supabase/tests/super_admin_policy_parity.test.sql` (new, 428 lines)
- `src/screens/DBInspectorScreen.tsx` (modified)
- `src/screens/__tests__/DBInspectorScreen.test.tsx` (new)
- `specs/157-super-admin-rls-parity.md` (new)

Cross-referenced against: `20260504173035_per_store_rls_hardening.sql:160-181`,
`20260507015244_spec004_ingredient_categories_rls_p6.sql:33-48`,
`20260504073942_brand_catalog_p5_rls.sql:22-27`,
`20260509000000_multi_brand_schema_rls.sql:187-243`,
`20260517020000_admin_rpcs_use_privileged.sql:14-135`,
`20260517050000_rls_hardening_followups.sql:237-241`,
`20260520010000_legacy_permissive_policy_dropout.sql:157-166`,
`supabase/tests/permissive_policy_lint.test.sql:103-130`.

---

## Verdict

**No Critical. No High.** The central question posed — *does any of the seven
policies grant more than intended?* — resolves cleanly to **no**. Every one of the
seven rewritten predicates is a provable strict superset that adds exactly one
principal class (`profiles.role = 'super_admin'`) and nothing else. Nothing blocks
merge from a security standpoint.

The findings below are two Lows and one informational note, all pre-existing or
process-related; none require a diff change in this spec.

---

## The central question, answered arm by arm

### 1. Who newly gains? Exactly `super_admin`, and no one else.

`public.auth_is_privileged()` (`20260509000000_multi_brand_schema_rls.sql:235-239`) is:

```sql
select public.auth_is_admin() or public.auth_is_super_admin();
```

- Left arm is byte-identical to the old predicate → every principal admitted before
  is admitted now. **No principal loses access** (AC-4 holds).
- Right arm (`20260509000000:187-195`) is `exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin')`. The *only* way to gain is to hold a
  `profiles` row with `role = 'super_admin'` keyed on `auth.uid()`.
- `anon` cannot gain: `auth.uid()` is NULL → no `profiles` match → right arm false;
  and an anon JWT has no `app_metadata.role` in `{admin, master}` → left arm false.
  (`auth_is_privileged()` *is* granted to `anon` at `20260509000000:243`, but grant
  ≠ predicate truth — the function returns false for anon.)
- Self-promotion to `super_admin` is closed independently of this diff by the
  SECURITY INVOKER trigger at
  `supabase/migrations/20260517050000_rls_hardening_followups.sql:237-241`
  (`raise exception 'role changes require super_admin'`). So the new principal class
  cannot be self-minted by a staff/user/PWA caller.

**Sibling-app exposure check (customer PWA / staff app hitting the same project):**
neither `audit_log` nor `ingredient_categories` write access is reachable by a PWA
or staff principal before or after this change — both arms of the new predicate are
false for them, and the pgTAP negative arms IC-4/IC-5/IC-6/AL-3/AL-4/AL-7/AL-8 pin
exactly that. No cross-tenant read or write path is opened.

### 2. Are the `to` role lists unchanged? Yes.

None of the seven `create policy` statements in
`20260809000000_super_admin_policy_parity.sql:177-247` carries a `to` clause —
identical to the originals at `20260504173035:160-181` and `20260507015244:37-48`,
which also omit it. Both resolve to `PUBLIC`. The D-0 prod dump recorded at
`specs/157-super-admin-rls-parity.md:806-812` independently confirms `{public}` on
all seven pre-change. No role-list drift.

Kind is also preserved: no `as restrictive` is introduced, so all seven stay
`PERMISSIVE`, matching the pre-change dump. A permissive→restrictive flip would
have been a silent tightening; it did not happen.

### 3. Was any store/brand scope dropped from an OR-arm? No.

- `20260809000000:179-182` (`store_member_read_audit_log`) keeps
  `(store_id is not null and public.auth_can_see_store(store_id))` verbatim; only
  the `store_id is null` arm's helper widens.
- `20260809000000:191-194` (`store_member_insert_audit_log`) — same, on `with check`.
- `20260809000000:203-204` / `212-213` (`admin_update_audit_log` /
  `admin_delete_audit_log`) were **already** unscoped-by-store before this change
  (`20260504173035:174-181`). The diff does not remove a scope that existed; it
  changes the role helper on a predicate that was `auth_is_admin()` alone.
- `20260809000000:234` / `240-241` / `247` (`ingredient_categories` ×3) were
  likewise whole-predicate role checks with no scope to lose — the table is
  intentionally cross-brand master data per spec 004 / 051.

I diffed each new predicate character-for-character against its source-of-truth
migration. The only token that differs anywhere is `auth_is_admin` →
`auth_is_privileged`. Confirmed.

### 4. Is `auth_is_admin()` itself untouched (AC-5)? Yes.

The only statement in the migration naming the function at the function level is
`comment on function public.auth_is_admin()` at `20260809000000:254-268`. That
writes `pg_description`, not `pg_proc.prosrc`. The body at
`20260504073942_brand_catalog_p5_rls.sql:22-27` is not restated anywhere in the
diff. The deliberately-narrow JWT-vs-`profiles.role` distinction — which is what
keeps a forged `app_metadata.role: 'super_admin'` claim worthless — survives
intact. This is the security-load-bearing half of the (a)/(b) decision and the
implementation got it right: option (a) would have moved a profiles-guarded grant
onto a token-guarded surface and would have re-widened the ~40 policies riding
`auth_can_see_store()`'s `auth_is_admin()` OR-arm.

### 5. Does the probe RPC expose anything new beyond the three booleans?

`20260809000000:282-405` vs `20260517020000:14-135` — a mechanical diff yields
**exactly two added lines**:

```
> 'is_privileged', public.auth_is_privileged(),
> 'is_super_admin', public.auth_is_super_admin(),
```

Nothing else changed. Specifically verified unchanged and therefore safe:

- Entry guard `if not public.auth_is_privileged() then raise exception 'admin only'`
  (`20260809000000:290-292`) — still gates, still on the wide helper.
- `security definer` + `set search_path = public` + signature + `returns jsonb`.
- Grants: `create or replace function` preserves ACLs, so the
  `revoke … from public, anon` / `grant execute … to authenticated` pair from
  `20260505065303_admin_rpcs_lock_anon.sql` survives and is correctly **not**
  re-issued (re-issuing a `grant` would have been the risky move here, not omitting it).
- Payload: no row data, no PII, no schema secrets added. The two new keys are
  booleans about the *calling* principal, returned only to a caller who has
  already passed `auth_is_privileged()`. `app_metadata` and `user_id` were already
  emitted and are the caller's own.

No SQL injection surface: the function takes no arguments and contains no
`EXECUTE` / dynamic SQL.

### 6. Does spec-053's permissive lint stay clean with no allowlist row (AC-8)? Yes.

I re-derived this rather than taking the spec's word. `permissive_policy_lint.test.sql:118-127`
flags a predicate only if it matches `auth.uid() is not null`, `true`, or
`auth.role() = 'authenticated'` in head position or in an OR-tail.

- `auth_is_privileged()` is a function call, matching none of the three tokens.
- The widened `audit_log` SELECT/INSERT predicates begin with
  `((store_id IS NOT NULL) AND …` — head-position regex does not match; and the
  OR-tail is `or ((store_id IS NULL) AND …`, which is not one of the tokens either.
- The one genuinely wide policy on `ingredient_categories` —
  `"Authenticated can read ingredient categories"` (`20260520010000:157-166`,
  `to authenticated using (true)`) — is **not in the diff** and is already on the
  2-row allowlist. Confirmed absent from the staged migration.

No allowlist row is added and none is needed. `supabase/tests/permissive_policy_lint.test.sql`
is correctly out of the diff — editing it would itself have been the finding.

### 7. Permissive-policy OR composition (the CLAUDE.md §"ORed" rule)

Full policy inventory on both tables after this migration:

- `public.audit_log` — 4 policies, all four in this diff. RLS enabled at
  `20260405000759_init_schema.sql:254`. No wide `for all` policy survives
  (`auth_manage_audit_log` was dropped at `20260504173035:158`).
- `public.ingredient_categories` — 4 policies: the 3 writes in this diff plus the
  allowlisted SELECT. RLS enabled at `20260424211732_recover_undeclared_tables.sql:37`.
  The legacy `auth_manage_ingredient_categories` `for all using (auth.uid() is not null)`
  was dropped at `20260507015244:23`.

No new permissive policy is created on any `(table, cmd)` pair — each `create policy`
is preceded by a `drop policy if exists` of the *same name*, so the policy count on
both tables is unchanged. There is no ORed-neutralization risk introduced.

### 8. Client-side privilege value used as a security boundary? No.

`classifyAuthBanner()` / `AUTH_BANNER_COPY`
(`src/screens/DBInspectorScreen.tsx`, new block after line 135) feed **display copy
only** — icon, title, detail, colour. No branch of the screen gates a query, a
mutation, or a navigation on `is_privileged` / `is_super_admin`. Server-side
enforcement remains the RPC's own `auth_is_privileged()` guard plus RLS. This is
the correct posture and the AC-15 `unknown` arm (deploy skew → neutral, never a
false green) is the right fail-safe direction: it refuses to *claim* authorization
the DB has not confirmed, rather than refusing access.

The new raw-flag `kvLine` (`is_admin: … · is_privileged: … · is_super_admin: …`)
and the pre-existing `app_metadata` / `user_id` lines echo only the viewing
principal's own claims to that principal. No other user's PII is rendered.

### 9. Secrets / PII / logging

- Zero secrets in the diff. Grepped the full staged diff for JWT-shaped strings,
  `service_role`, `SUPABASE_SERVICE*`, `api_key`, `secret`, `password`, `bearer`,
  `token` — every hit is prose in the spec narrative or an identifier name.
- No `EXPO_PUBLIC_*` variable is added or read.
- No `console.log` / `console.warn` / `notifyBackendError` call is added; the
  screen's existing `catch` path is untouched.
- No new error message returns SQL fragments, stack traces or foreign-store rows.
  The probe's failure mode is still the opaque string `'admin only'`.
- pgTAP fixtures use the collision-proof `__test_spec157_*` prefix and fixed
  `a5000157-…` UUIDs, run inside `begin; … rollback;`, and touch no real seed rows
  beyond an in-transaction `profiles` role flip that is rolled back. No prod-derived
  seed PII is copied into the test file.

---

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260809000000_super_admin_policy_parity.sql:203-216` —
  **`admin_update_audit_log` / `admin_delete_audit_log` remain unscoped by store or
  brand, and the widening adds a second principal class to that pre-existing hole.**
  After this change a `super_admin` can UPDATE or DELETE any `audit_log` row in any
  brand — audit-trail tampering with no scope check. *Impact is genuinely low, and
  deliberately so:* (a) the gap predates this diff and an `admin`/`master` already
  had exactly this reach; (b) `auth_can_see_store()` already short-circuits true for
  `super_admin` (`20260509000000:216-227`), so no net-new *visibility* is granted;
  and (c) a `super_admin` can already promote any account to `admin` via
  `profiles.role` (the role-change trigger admits them), so they could reach these
  policies transitively regardless — the widening grants nothing they could not
  already obtain. *Fix:* none in this spec. It is correctly recorded in-database as
  a deferred gap via `comment on policy` at `20260809000000:206-207` and `215-216`,
  and as FUTURE-1 / OQ-3 in the spec. I concur with the deferral — scoping these
  cannot be done without redesigning `cleanupOldRecords`' global unfiltered
  `delete from audit_log where created_at < cutoff` (`src/lib/db.ts:5831`), and a
  naive `auth_can_see_store(store_id)` tightening would silently turn a brand-admin's
  retention purge into a partial purge and orphan every `store_id IS NULL` row.
  **Recommend the follow-up spec be filed rather than left as a comment**, since the
  comment is only visible to someone running `\d+`.

- `supabase/migrations/20260809000000_super_admin_policy_parity.sql:286` —
  **`set search_path = public` on a SECURITY DEFINER function omits an explicit
  `pg_temp` position.** For relations (not functions), an unlisted `pg_temp` is
  implicitly searched first, so a caller who can create temp tables could in
  principle shadow `recipes` / `prep_recipes` inside the probe body. *Impact is
  negligible here:* the caller must already have passed `auth_is_privileged()`, the
  function only reads counts and duplicate groups, and the only party they could
  deceive is themselves — there is no write path and no cross-principal data return.
  *Fix:* **do not change it in this spec.** The line is copied verbatim from
  `20260517020000:19` and byte-verbatim copying is the contract the reviewers will
  diff against; the same idiom is used by every helper in the schema. Flagging it
  only so it is on record as considered and dismissed, not missed. If it is ever
  hardened, it should be a schema-wide sweep, not a one-function edit.

---

## Non-findings — checked and explicitly cleared

Recorded so the release-coordinator does not have to re-derive them:

- **Migration destructiveness / CI assumption.** The migration is policy DDL +
  one `create or replace function` + comments. No table, column, index, constraint,
  trigger, grant, extension or publication member is created, altered or dropped —
  I verified statement by statement across all 407 lines. Every `create policy` is
  preceded by a `drop policy if exists` of the same name and the whole body is
  `begin; … commit;` wrapped (`:166`, `:407`), which correctly closes the
  drop/create window against the non-atomic MCP `execute_sql` apply path. Nothing
  here needs CI to catch it, which matters given the README's stale-workflow caveat.
- **RLS enablement on new tables.** N/A — no table is created.
- **Edge functions.** Zero files under `supabase/functions/` and no
  `supabase/config.toml` change, so the `verify_jwt` / service-token split, the
  `ADMIN_ROLES ∋ super_admin` mirror rule, the `escapeHtml()` rule, the
  `callEdgeFunction` rule, and the last-of-role / self-guard destructive-action
  rules are all N/A for this diff. Confirmed by `git diff --cached --name-only`.
- **Destructive-action discipline.** No new path takes a `target_user_id` and no
  `auth.admin.deleteUser` / role-demotion / profile-delete is added, so neither the
  spec-031 last-of-role guard nor the spec-050 `caller.id != target.id` self-guard
  is in scope. The existing guards are untouched.
- **Realtime.** Neither `audit_log` nor `ingredient_categories` is a member of the
  `supabase_realtime` publication (`20260514140000_realtime_publication_tighten.sql:43-53`),
  and no publication DDL is in the diff — a client subscribing to `store-{id}` gains
  nothing from this change. The migration header correctly says so and correctly
  declines to add a no-op `docker restart` step.
- **Input validation.** No new RPC argument, no dynamic SQL, no `EXECUTE`, no file
  upload, no URL fetch, no redirect. `admin_db_inspector_probe()` remains
  zero-argument.
- **Dependency surface.** No new import in `DBInspectorScreen.tsx` beyond a
  type-only `React.ComponentProps<typeof Ionicons>` reference to an already-imported
  module.
- **`useRole()` placeholder.** Not touched and not used by any new code (per
  CLAUDE.md, not a finding by construction).
- **LINT-1 standing guard** (`supabase/tests/super_admin_policy_parity.test.sql:405-424`)
  scans `pg_policies` predicates only and never `pg_proc` — correct, since
  `auth_can_see_store()`, `auth_is_privileged()` and the probe RPC all legitimately
  name `auth_is_admin` in their bodies. It fails safe (substring match, so a false
  positive would fail the build rather than let an eighth leftover through). Good
  security regression value.

---

## Deploy-time security condition (not a code finding)

The prod D-0 record at `specs/157-super-admin-rls-parity.md:1627-1636` shows query
(a) returning exactly 7 rows on project `ebwnovzzkwhsdxkpyjka`, query (b) returning
4 non-gate rows, and the gate-only probe returning 0 rows. That closes the
"the repo is not prod" risk (R-1) that would otherwise have made the blast-radius
claim unverifiable. **After the apply, re-run query (a) and confirm it returns zero
rows** — that is the only remaining evidence that the widening landed on all seven
and nowhere else. Per CLAUDE.md, `db-migrations-applied.yml` will sit red between
merge and apply; that is the known window, not drift.

## Dependencies

`package.json` is not in the staged diff — `npm audit` skipped.
