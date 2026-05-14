# Security audit for spec 026 — Post-spec-025 cleanup batch

Scope reviewed:
- `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` (Track A, the only security-relevant change)
- `supabase/tests/invitations_super_admin_rls.test.sql` (Track A regression test)
- `CLAUDE.md`, `.claude/agents/*.md` (Track B doc-rot — verified no security framing was weakened)
- `package.json` / `package-lock.json` (Track C — devDep removal only)

Verdict at a glance: **No Critical or High findings.** Track A is a strict superset of the prior policy with no new attack surface. Track B preserved the security-auditor agent prompt verbatim and did not water down threat-model framing in CLAUDE.md or peer agent prompts. Track C reduces surface (one transitive tree removed). The high-severity npm-audit finding is pre-existing, not introduced or aggravated by this spec.

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

None.

---

### Low

- `supabase/tests/invitations_super_admin_rls.test.sql:73-138` — Coverage gap. The pgTAP test exercises only INSERT for all three role bands (admin / super_admin / non-privileged user). SELECT, UPDATE, and DELETE policies were rewritten in the same migration but are not directly exercised. The spec (AC A4) explicitly scoped the test to INSERT, and because all four new policies have identical shape (`using/with check (public.auth_is_privileged())`), the INSERT result gives high confidence the others behave the same. Not a blocker, but if a follow-up regression is observed on UPDATE/DELETE/SELECT (e.g. a super-admin who can INSERT an invitation but cannot mark it `used = true`), that arm is silently uncovered.
- `supabase/functions/send-invite-email/index.ts:16` — Pre-existing inconsistency surfaced by Track A. `ADMIN_ROLES = new Set(["admin", "master"])` here, but `delete-user/index.ts:19` includes `super_admin`. With Track A landed, a super-admin's RLS INSERT into `public.invitations` now succeeds — but the immediate `callEdgeFunction('send-invite-email', ...)` in `src/lib/auth.ts:192` will be 403-rejected for super-admins. End-result for the user: invite row created, no email sent, silent fan-out failure. This is not introduced by spec 026 (the gap pre-exists), and spec 026 explicitly puts edge function changes out of scope (Out of scope §7). Flagged as a follow-up — the release-proposal already enumerates 9 deferred items and this fits the pattern. Recommendation: file as a follow-up spec; do not block 026 on it.

---

### Dependencies

Ran `npm audit --audit-level=high` against post-uninstall state.

- **Total:** 11 vulnerabilities (1 high, 5 moderate, 5 low).
- **High:** `@xmldom/xmldom <= 0.8.12` (DoS via uncontrolled recursion + XML injection). Pulled in transitively via `expo → @expo/cli → @expo/plist → @xmldom/xmldom` (confirmed via `npm ls @xmldom/xmldom`). **Not** a dependency of the removed `json-server`. Pre-existing condition; not introduced or worsened by this spec.
- **Track C impact:** removing `json-server` removes 599 transitive package entries from `package-lock.json` (per `git diff --stat`). Pure reduction in attack surface — no new vulns introduced. Net positive for `npm audit`.
- Recommendation: file a separate spec to follow up on the Expo-transitive vulns. Out of scope for 026.

---

## Detailed verification

### 1. RLS regression check — strict-superset claim verified

The architect's claim that the new policy is a strict superset of the old holds. Walking the truth table:

| Caller | Old check `(jwt.app_metadata.role) in ('admin','master')` | `auth_is_admin()` (`20260504073942_brand_catalog_p5_rls.sql:23-27`, reads JWT) | `auth_is_super_admin()` (`20260509000000_multi_brand_schema_rls.sql:187-195`, reads `profiles.role`) | `auth_is_privileged()` | Old result | New result |
|---|---|---|---|---|---|---|
| anon (`auth.jwt()` empty / `auth.uid() = null`) | `'' in ('admin','master')` → false | false (coalesces to `''`) | false (no `profiles` row at null uid) | false | DENY | DENY |
| authenticated user-role (`app_metadata.role = 'user'`, profiles.role = 'user') | false | false | false | false | DENY | DENY |
| authenticated user-role with **profiles.role flipped to 'super_admin'** | false | false | **true** | **true** | DENY | **ALLOW (intended)** |
| admin JWT (`app_metadata.role = 'admin'`) | true | true | false (assuming no super_admin in profiles) | true | ALLOW | ALLOW |
| master JWT (`app_metadata.role = 'master'`) | true | true | false | true | ALLOW | ALLOW |
| super_admin JWT (`app_metadata.role = 'super_admin'`, profiles.role = 'super_admin') | false (`'super_admin' not in ('admin','master')`) | false | true | true | **DENY (regression bug)** | **ALLOW (fix target)** |

Confirms:
- Admin / master JWTs: behavior unchanged.
- super_admin JWT *or* super_admin via `profiles.role`: now allowed (this is the fix's intent).
- anon and ordinary users (no super_admin profile row): still denied.
- No unintended new path. `service_role` bypasses RLS entirely regardless of policy contents.

### 2. `auth_is_super_admin()` source-of-truth is `profiles.role`

Confirmed at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-195`. The helper reads `public.profiles.role`, not the JWT. Implication: a JWT issued for an attacker can never satisfy `auth_is_super_admin()` unless the attacker has write access to `public.profiles.role` for their own row. Write access to profiles requires either:
  - `service_role` (server-side only, not exposed to clients), or
  - super_admin self via the `super_admin` RLS branch (chicken-and-egg — a non-super_admin cannot mutate their own role).

Cross-checked: `supabase/functions/delete-user/index.ts:19` correctly treats `super_admin` as privileged. `supabase/functions/send-invite-email/index.ts:16` does NOT — flagged as Low above. No other policy or RPC depends on `profiles.role` for privilege escalation in a way 026 changes.

### 3. Policy DROP + CREATE atomicity

`supabase/migrations/20260514150000_invitations_super_admin_rls.sql` has no explicit `begin`/`commit`. This matches the rest of the migration set (`20260510020000_order_schedule_super_admin_rls.sql`, `20260510030000_recipe_categories_super_admin_rls.sql`). Postgres DDL is transactional, and Supabase CLI's `db push` wraps each migration in a single transaction by default. If the migration fails mid-statement (e.g., between drop #3 and create #1), the entire migration rolls back and the original four policies remain. **No window of policy-free table exists.** Safe.

### 4. pgTAP test fidelity

`plan(4)`:
1. Fixture assertion — `isnt(current_setting('test.admin_id'), '')`. Confirms the seed UUIDs resolve. Sanity guard.
2. Arm (i) admin JWT INSERT — JWT `app_metadata.role='admin'` → `auth_is_admin()` true → `auth_is_privileged()` true → INSERT succeeds. Regression check that the fix didn't accidentally raise the bar for the previously-passing role.
3. Arm (ii) super_admin via `profiles.role` — JWT `app_metadata.role='user'` (intentionally non-admin) + `profiles.role='super_admin'` for the impersonated `auth.uid()` → `auth_is_admin()` false, `auth_is_super_admin()` true, `auth_is_privileged()` true → INSERT succeeds. This is the load-bearing assertion for the fix.
4. Arm (iii) plain user JWT — JWT `app_metadata.role='user'` + `profiles.role='user'` for `33333333...` (the seeded manager UUID, never promoted in this txn) → both helpers false → `auth_is_privileged()` false → `throws_ok(..., '42501', ...)`. Negative assertion confirms denial path.

Hermetic isolation via `begin; ... rollback;` — the `UPDATE profiles SET role='super_admin'` does not persist. The trigger `profiles_sync_role_to_jwt` (`20260502071736_remote_schema.sql:515`) fires on the UPDATE and mutates `auth.users.raw_app_meta_data`, but that mutation is also inside the transaction and rolls back cleanly. No state leaks.

Coverage gaps (Low above): SELECT, UPDATE, DELETE arms are not exercised. Acceptable per the spec's explicit scope, but a follow-up could add three more `plan` items if regression risk warrants.

### 5. Doc-rot pass — security framing intact

Verified the following did NOT change in Track B:

- `.claude/agents/security-auditor.md` — untouched (verified via `git diff HEAD -- .claude/agents/security-auditor.md` returning empty).
- CLAUDE.md sections "Auth: Supabase email+password; admin role via JWT `app_metadata.role` ... per-store visibility via `auth_can_see_store()`", per-store RLS hardening reference, brand-catalog refactor reference — all preserved.
- `.claude/agents/code-reviewer.md` re-tightened the "deleted in spec 025" rule rather than relaxing it — the rule explicitly calls re-creation of those files Critical.
- Frozen-file list collapsed to `app.json` slug — this is the only meaningful security item on that list (RLS-bypass risk via cert reuse is not a thing here; the slug is load-bearing for build identity, not auth).
- AC B5 grep gate (`grep -rEni 'AppNavigator|featureFlags|EXPO_PUBLIC_NEW_UI|useJsonServerSync|useSupabaseStore' CLAUDE.md .claude/agents/`) returns only historical-context matches. Confirmed.

No security messaging was watered down. The "do-not-modify" rule was simplified to the single load-bearing item (`app.json` slug), removing references to files that no longer exist. That is correct — a do-not-modify rule that references a non-existent file is dead text, not a defense.

### 6. Track C — `json-server` removal

`git diff HEAD -- package.json` shows exactly one line removed (`"json-server": "^1.0.0-beta.15"`). `package-lock.json` shrinks by 599 lines (per `git diff --stat`). No new deps added. No runtime references survived: pre-existing consumers (`db.json`, `useJsonServerSync.ts`, `src/lib/api.ts`, the `npm run db` script) were already deleted in spec 025. Net effect: dependency surface reduced.

`npm audit` post-removal: 11 vulns. Comparing tree to pre-spec-025 state, no `json-server`-rooted vulns appear in the current output — confirming the removal closed at least that branch of the tree cleanly.

### 7. Realtime / leak surface

`public.invitations` is NOT in the realtime publication (`supabase/migrations/20260514140000_realtime_publication_tighten.sql:43-53` does not list it). Broadening the SELECT policy from `['admin','master']` to `auth_is_privileged()` therefore does not change what subscribers can see — there are no subscribers. No new leak path opens via realtime.

### 8. Edge function impact

None of the ten edge functions read invitations RLS — they use service-role keys that bypass policies entirely. Track A is therefore invisible to the edge layer. The pre-existing `send-invite-email` super_admin gap (Low) is orthogonal to Track A.

---

## Handoff

next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low. No blockers. Strict-superset RLS broadening verified against a six-row truth table; no anon path opens, no service-role surface change, no realtime leak. Doc-rot pass preserved security framing intact (security-auditor agent file untouched; threat-model language in CLAUDE.md preserved). `npm audit` finds one pre-existing high-severity vuln (`@xmldom/xmldom` via Expo) unrelated to and unaggravated by this spec. Two Low findings recorded as follow-ups: pgTAP test covers only INSERT (UPDATE/DELETE/SELECT inferred from identical policy shape), and `send-invite-email` edge function does not include `super_admin` in its `ADMIN_ROLES` set (will silently 403 super-admins after this fix lands — pre-existing, out of spec 026's scope per Out-of-scope §7).
payload_paths:
  - specs/026-post-025-cleanup/reviews/security-auditor.md
