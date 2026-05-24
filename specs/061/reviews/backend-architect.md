# Spec 061 — Backend Architect Post-Implementation Review

**Status on entry:** READY_FOR_REVIEW
**Reviewer mode:** post-implementation drift review (Status NOT mutated)
**Scope:** the 6 implementation deliverables called out in §2/§4/§8/§9 of
the design doc, plus the imr-staff scaffold (§B1, §B2, §B10).

## Verdict overview

| Area | Verdict |
|---|---|
| §2 RPC body rework (migration `20260525000000`) | matches design |
| §4 edge function 410 deprecations (3 files) | matches design |
| §8 pgTAP coverage (`staff_role_eod_rls.test.sql`) | matches design (11 assertions; well-justified 10→11) |
| §9 shell smoke (`smoke-staff-eod.sh`) | matches design (9 steps, all present) |
| §B1/§B2/§B10 imr-staff scaffold | matches design |
| Q3 NetInfo implementation choice | matches design |
| §11 risk #1 (cross-brand write hole) | matches design — gate landed, test covers it |
| §11 other risks | addressed or carried forward as open notes |

No Critical findings. Three Should-fix findings, four Minor findings. All
are deviations from the design that are either (a) defensible
improvements or (b) low-cost corrections the developer can land in
follow-up without blocking SHIP_READY.

---

## §2 RPC body rework — `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`

**Design specified (§2 + §1 Q1 + §8 risk #1):**

1. `create or replace function` (or drop+create) with same 7-arg signature
2. Store-membership gate via `auth_can_see_store(p_store_id)` as first
   guard after the existing vendor-presence NOT NULL check
3. `auth.uid()::text` three-tier fallback for `audit_log.detail` actor
   attribution (`auth.uid()` → `p_submitted_by` → `'staff:unknown'`)
4. `p_submitted_by` retained in signature, ignored in body for trust
5. `security definer` + `set search_path = public` retained
6. `revoke all from public, anon, authenticated, service_role` + `grant
   execute … to authenticated`
7. `comment on function` documenting new posture

**Implementation:**

- [x] matches design — drop+create at L52 with the exact 7-arg signature.
- [x] matches design — membership gate at L95-L98 fires AFTER the vendor
  presence NOT NULL check (L78-L82) and BEFORE the vendor-name hydration
  (L104-L106). Raises `42501` with a precise message. **Note the
  developer's leading comment at L84-L94 correctly explains that
  service_role callers won't reach this line because of the GRANT
  REVOKE — defense-in-depth narration without redundant code.**
- [x] matches design — `v_actor` derived at L114 with the exact
  three-tier fallback. Used at L192 (audit detail concat). The
  `p_submitted_by` parameter stays in the signature (L58) but is no
  longer trusted.
- [x] matches design — `security definer` (L64) + `set search_path =
  public` (L65) retained. Body still owns the cross-RLS writes to
  `eod_submissions` / `eod_entries` / `inventory_items` /
  `audit_log` — same posture as v2.
- [x] matches design — `revoke all from public, anon, authenticated,
  service_role` at L221 + `grant execute … to authenticated` at L222.
  Belt-and-braces (the broad revoke before the targeted grant).
- [x] matches design — `comment on function` at L224-L225 mentions
  spec 061, the auth.uid() fallback, and the GRANT swap.

**No deviation.** Migration is exactly the design.

---

## §4 edge function 410 deprecations

**Design specified:**

- HTTP 410 status
- JSON body shape: `{ error: "staff-<fn>: deprecated as of spec 061 —
  staff app now talks to Supabase directly via per-user JWT", reference:
  "specs/061-staff-app-eod-count.md" }` — verbatim from AC A3
- `verify_jwt = false` retained in `supabase/config.toml`
- CORS headers preserved (for browser preflight)
- All routes (including OPTIONS preflight) handled

**Implementation:**

- [x] matches design — all three files
  (`supabase/functions/staff-{catalog,eod-submit,waste-log}/index.ts`)
  return HTTP 410 with the exact JSON body shape pinned in AC A3.
  Verified `error` and `reference` fields are byte-for-byte identical to
  the spec text.
- [x] matches design — `supabase/config.toml:391-398` still has
  `verify_jwt = false` for all three. No drift.
- [x] matches design — CORS headers (`Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Headers: authorization, content-type,
  x-client-info`, `Access-Control-Allow-Methods: …`) preserved on all
  three. OPTIONS preflight short-circuits to 200 "ok" before the 410
  path. This matches the design's reasoning about avoiding "CORS
  preflight 401" ambiguity.

**Minor variation:** `staff-catalog/index.ts:24` declares
`Access-Control-Allow-Methods: GET, OPTIONS` (because it was a GET
endpoint originally); the other two declare `POST, OPTIONS`. This is
correct per-function and not a deviation — it's accurate to the original
HTTP shape of each function. Not a finding.

**No deviation.** Three 410-shape files are byte-for-byte aligned with
the §4 contract.

---

## §8 pgTAP coverage — `supabase/tests/staff_role_eod_rls.test.sql`

**Design specified 10 assertions (§8):**

1. In-membership RPC call succeeds
2. Returned row exists in `eod_submissions` for the staff user's store
3. `submitted_by` on the persisted row is `auth.uid()`
4. `audit_log` row carries the staff user's id, not a forged value
5. Staff CANNOT call RPC for out-of-membership store (42501 via the new
   gate)
6. Staff CANNOT direct-INSERT into `eod_submissions` for non-membership
   store (RLS path)
7. Staff CAN SELECT `eod_submissions` for in-membership store
8. Staff CANNOT SELECT `eod_submissions` for non-membership store
9. Staff CANNOT INSERT into `recipes`
10. Idempotency replay returns `conflict: true` with same submission_id

**Implementation:**

- `plan(11)` at L47 — implementation adds an 11th assertion (10:
  service_role has no EXECUTE on the RPC) AND keeps all 10 of the
  designed assertions.
- The 11th assertion (`has_function_privilege('service_role', …)`) at
  L111-L118 is **a justified addition**: it verifies the LOCKDOWN half
  of the GRANT swap (which my design only verified implicitly through
  the existing migration body). It fits cleanly in the "GRANT swap is
  correct" coverage and runs BEFORE the role switch (correct — it needs
  postgres privilege to read `has_function_privilege`).
- All 10 designed assertions land at the right places: (1) L161, (2)
  L175, (3) L194, (4) L211, (5) L228, (6) L258, (7) L275, (8) L314,
  (9) L330, (11 in the file = my "10" idempotency) L362.

**Two structural decisions worth calling out:**

1. **Test-only date `'1999-12-31'`** at L148, L181, L199, L280, L350.
   The developer's leading comment at L137-L143 explains this — avoids
   collision with `smoke-staff-eod.sh` (which writes to today/Frederick
   in step 5 and is non-transactional). The developer is right that the
   smoke residue can leak into pgTAP if both run before a `db reset`;
   using a far-past date insulates the test. This is a real-world
   pragma that I did not specify but should have. matches design intent.
2. **Charles row seeding via `reset role`** at L290-L301 to set up
   assertion 8. The design specified this shape; the implementation
   matches.

**One observation that is NOT a finding:**

- Assertion 4 (audit_log spoof-proof) uses `like '<manager_id>%'`
  matching the prefix. My design specified the same shape (§8 #4). The
  implementation correctly orders by `id desc limit 1` so the
  most-recent audit row is checked — correct, because earlier audit
  rows might have non-staff-061 detail strings.

**No deviation.** Test is the design plus a justified 11th assertion.

---

## §9 shell smoke — `scripts/smoke-staff-eod.sh`

**Design specified 9 steps (§9):**

1. Login as `manager@local.test` → capture `access_token`
2. Discover a vendor
3. Discover an inventory_item at STORE_ID
4. Generate `client_uuid`
5. First call to `staff_submit_eod` → assert 200 + submission_id +
   conflict=false
6. Confirm `eod_submissions` row exists (PostgREST under staff JWT)
7. Replay with same client_uuid → 200 + conflict=true + same
   submission_id
8. Out-of-membership store negative test
9. Edge function deprecation smoke (all three return 410)

**Implementation:**

- [x] matches design — all 9 steps are present, in the order specified.
- [x] matches design — step 5 asserts HTTP 200, parses `submission_id`,
  asserts `conflict=false`.
- [x] matches design — step 6 reads the row back under the staff JWT
  (proving SELECT-RLS works) AND adds a spec-061 spoof-proof check
  asserting `submitted_by == '22222222-…'` (the manager seed user's
  id). This is a justified additional check — it verifies the trigger
  fires under the per-user JWT path, which is the spec 020 round-2
  promise being re-confirmed under spec 061's GRANT model.
- [x] matches design — step 7 asserts 200, conflict=true, same
  submission_id as step 5.
- [x] matches design — step 8 (negative case for non-membership store)
  asserts non-200, then queries `eod_submissions` to confirm no row
  landed. The "from staff POV" caveat in the comment is correct (RLS
  would hide a leaked row too, so the real check is CODE3 != 200; the
  defense-in-depth row check is informational).
- [x] matches design — step 9 loops over all three deprecated edge
  functions, asserts 410, asserts body contains "spec 061".
- Env defaults match the design: Frederick = `0f240390-…`, Charles =
  `1ea549bb-…`. STAFF_EMAIL = `manager@local.test`. STAFF_PASSWORD =
  `password`. SUPABASE_URL = local. Correct anon key.
- Troubleshooting header at L37-L42 references the edge-runtime
  bind-mount gotcha from CLAUDE.md — good.

**One small lift that exceeds the spec but isn't a deviation:** the
smoke uses `staff-catalog` with GET (L309 case statement) vs the others
with POST. Correct — the original `staff-catalog` was a GET endpoint.

**No deviation.** Smoke is the design plus one (defensible) extra
spoof-proof check in step 6.

---

## §B1/§B2/§B10 imr-staff scaffold

**Design specified (§B1):**

- Expo SDK 54, React Native 0.81, TypeScript 5.3 strict
- Zustand 4.5
- `@supabase/supabase-js` 2.101
- React Navigation 6
- `@react-native-async-storage/async-storage`
- `@react-native-community/netinfo` (per Q3)
- `@/*` → `src/*` alias
- `babel-preset-expo`
- Metro with zustand-ESM shim (mirroring imr-inventory)

**Implementation (`~/Documents/GitHub/imr-staff/package.json`):**

- [x] `expo` `^54.0.0`, `react-native` `0.81.5`, `react` `19.1.0` —
  matches design
- [x] `typescript` `^5.3.0`, `tsconfig.json` `strict: true` — matches
  design
- [x] `zustand` `^4.5.4`, `@supabase/supabase-js` `^2.101.1` — matches
  design
- [x] `@react-navigation/native` `^6.1.17` + `@react-navigation/stack`
  `^6.3.29` — matches design (RN6 stack)
- [x] `@react-native-async-storage/async-storage` `2.2.0` — matches
  design
- [x] `@react-native-community/netinfo` `^11.0.0` — matches design,
  honors Q3 resolution
- [x] `@/*` → `src/*` alias in `tsconfig.json:5-7` — matches design
- [x] `babel-preset-expo` in `babel.config.js:4` — matches design
- [x] Metro zustand-ESM shim in `metro.config.js:8-15` — matches
  design (explicit comment "Same shim as imr-inventory" — correct
  attribution)
- [x] `app.json` has `slug: imr-staff` — correct per the spec's
  hard-rule note that imr-inventory's `towson-inventory` slug stays
  unchanged and the new repo's slug is owned by the new repo
- [x] One initial commit on `main` per §C5

**§B2 CLAUDE.md verification:**

- [x] "What this is" + companion-repo reference at L4-L14 — matches
  design (single-sourced contract at the absolute path of spec 061)
- [x] Stack list at L16-L29 — matches design
- [x] Backend coupling at L29-L38 — matches design (no backend half
  in this repo)
- [x] Auth model at L54-L67 — matches design (`profiles.role = 'user'`
  + `user_stores` empty → sign out flows)
- [x] Conventions at L69-L91 — matches design (no admin UI, no brand
  catalog, no recipe management; optimistic-then-revert + toast;
  cross-platform confirm; connectivity = NetInfo on native + onLine on
  web)
- [x] i18n English-only at L77-L78 — matches design
- [x] Realtime: NONE in v1 at L90-L91 — matches design
- [x] Deprecated edge function list at L120-L125 — matches design (DO
  NOT call `/functions/v1/staff-*`)

**§B10 README.md verification:**

- [x] Stack list at L17-L33 (with the explicit "notably absent" call-out
  for jspdf, papaparse, etc.) — matches design
- [x] Setup steps with `npm install` at L37-L39 — matches design
- [x] Env vars table at L41-L46 — matches design
  (`EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY`)
- [x] Test command `npm test` at L65 + `npm run typecheck` at L67 —
  matches design
- [x] Deploy targets at L75-L80 — matches design (EAS native primary,
  Vercel web preview nice-to-have)
- [x] "Backend lives in imr-inventory" pointer at L82-L93 — matches
  design (with absolute paths to spec 061 and the migration)

**No deviation.** Scaffold is the design.

---

## Q3 NetInfo implementation choice

**Design said:** use `@react-native-community/netinfo` on native;
`navigator.onLine` on web; do NOT depend on the spec 059 Phoenix-Socket
hook because the staff app has no realtime subscriptions to read state
from.

**Implementation:** `package.json:16` adds
`@react-native-community/netinfo: ^11.0.0`. `app.json:21-23` declares
`ACCESS_NETWORK_STATE` permission on Android (NetInfo needs this).
iOS doesn't need a permission for NetInfo. `CLAUDE.md:85-89` documents
the choice and cites Q3.

[x] matches design — Architect's reasoning (Phoenix Socket is lazy and
only connects on `subscribe()`) is honored. NetInfo is added at the
right version. Android permission is correctly declared.

---

## §11 risks reviewed

### Risk #1 — Cross-brand write hole (LOAD-BEARING)

**Design said:** the RPC body MUST add an `auth_can_see_store(p_store_id)`
gate at the top, or the GRANT-to-authenticated swap becomes a
cross-brand write hole. pgTAP assertion 5 must cover the negative case.

**Implementation:**

- [x] Gate landed at `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql:95-98`
- [x] pgTAP assertion 5 at `supabase/tests/staff_role_eod_rls.test.sql:228-250`
  asserts the gate fires for a staff user against Charles (non-membership)
  with `errcode = '42501'`
- [x] Smoke step 8 (`scripts/smoke-staff-eod.sh:257-300`) end-to-end
  verifies the negative case via PostgREST

**Critical risk addressed.** No drift.

### Risk #2 — PostgREST returns 200 with conflict body, not HTTP 409

This is a frontend contract risk, not a backend code risk. The contract
in §7 (a) of the design doc pinned the body shape and explicitly warned
the spec-062 frontend implementer about it. The pgTAP idempotency
assertion (assertion 11) reads `result ->> 'conflict'` from the JSONB
envelope — matching the contract.

**Carried forward to spec 062 correctly.** No drift in spec 061.

### Risk #3 — Manager seed user is shared across multiple pgTAP tests

The implementation uses the manager seed user (`22222222-…`). The
existing `eod_submissions_consistency.test.sql` also uses this user.
Both use `begin; ... rollback;` wrappers so no cross-test contamination
at the data layer. The design's mitigation (pin the user id, fail loud
if seed changes) is partially honored — the test pins the id but
doesn't add an explicit "seed assertion" check.

**Minor finding — not a blocker.** See findings table below.

### Risk #4-9 — minor/operational

All carried forward as open notes by the developer in `## Open notes for
reviewers`. No drift.

### Risk #10 — AC A2 mutation

The design doc §0 revised AC A2 explicitly ("staff CAN read brand-shared
tables; CANNOT write"). The pgTAP assertion 9 (`recipes` INSERT blocked
by `auth_is_privileged`) verifies the new write-block posture. No
positive-case assertion verifies the read access (e.g., "staff CAN
SELECT recipes") — but the design doc didn't require one (it noted the
behavior is by-design via existing `brand_member_read_recipes` policy
that's already covered by `multi_brand_schema_rls.test.sql`-class
tests). **No drift.**

---

## Findings

### Critical

**None.**

### Should-fix

1. **Smoke residue creates non-hermetic FK on
   `eod_submissions.submitted_by` if `db reset` is skipped before
   re-running unrelated pgTAP tests.** The developer's own open note #1
   surfaces this honestly. The pgTAP test sidesteps via a far-past date,
   but the residual `eod_submissions` row in `today/Frederick/vendor`
   has `submitted_by = '22222222-…'` and FK-cascades into the
   `auth_can_see_store_brand_scope.test.sql` super_admin-deletion
   assertion when that test runs against a dirty DB. This isn't caused
   by spec 061 (it was always a pre-existing brittleness), but spec
   061's smoke is the first thing to make it visible. **Recommendation
   for follow-up (not blocking SHIP_READY):** add a "cleanup" line at
   the end of `smoke-staff-eod.sh` that deletes the rows it just
   created — `curl -X DELETE … /rest/v1/eod_submissions?client_uuid=eq…`
   under the staff JWT. The current smoke doesn't even pretend to be
   hermetic, which is consistent with other `smoke-*.sh` scripts in
   the repo, but a cleanup step would prevent the FK cascade issue.
   File: `scripts/smoke-staff-eod.sh:333-340` (after the existing exit
   logic).

2. **§11 risk #3 mitigation only partially honored.** The pgTAP test
   pins the manager id (`22222222-…`) but does NOT add a "seed
   manager user exists" pre-assertion that would fail loud if the seed
   is renamed/removed in a future migration. If `manager@local.test`
   ever gets a different uuid (e.g., a seed rebake), the test silently
   passes assertion 1 (RPC succeeds) but then assertion 3
   (`submitted_by == '22222222-…'`) fails with a confusing "expected
   X got Y" diff. **Recommendation for follow-up (not blocking):** add
   a `select isnt((select id from profiles where id =
   '22222222-…'::uuid), null, 'manager seed user exists')` at the top
   of the test, before `set local role authenticated`. File:
   `supabase/tests/staff_role_eod_rls.test.sql:107` (before the
   pre-role-switch service_role assertion).

3. **The migration's correctness depends on `service_role` lacking
   EXECUTE, but does NOT verify the deployment will fail loud if a
   service_role caller hits the RPC after deploy.** The design said:
   "if the deploy is split, the operator MUST deploy A3 first." This
   is a deployment-runbook concern, not a code concern, but the
   migration's leading comment at L38-L42 does mention it. The §1 Q1
   discussion in the design doc (the "Wait — does service_role bypass
   GRANTs?" tangent) settled on "no, service_role is bound by EXECUTE
   REVOKE." The pgTAP assertion 10 verifies this at the DB level. **No
   action needed if A1 + A3 ship together (which is the design's
   recommendation).** Flagging here only as a confirmation that the
   risk-#1 + service_role-EXECUTE dependency is internally consistent
   in the implementation. Not actually a finding — withdrawn upon
   second pass.

### Minor

4. **Migration uses `drop function if exists ... ; create function ...`
   instead of `create or replace function`.** The design said "drop+
   recreate to mirror the spec 020 round-2 pattern" — and the
   developer's L49-L51 comment correctly explains the choice ("makes
   the intent explicit and surfaces signature drift"). The signature
   stays the same in this case, so `create or replace` would have
   worked. The `drop` path is slightly more defensive (will fail loud
   if a prior migration created an incompatible signature) but is also
   slightly noisier in the postgres logs. **Either choice is defensible;
   no change requested.**

5. **`smoke-staff-eod.sh` step 3 (Charles inventory_item discovery) is
   skipped — the script just reuses the Frederick item id.** Comment
   at L126-L131 explains the choice correctly: the membership gate
   fires on `p_store_id` BEFORE the item is dereferenced, so any uuid
   works for the negative case. This is correct and avoids a second
   PostgREST call that would 0-result anyway (staff can't SELECT
   Charles inventory_items). **No change needed.**

6. **CLAUDE.md in imr-staff uses absolute paths to imr-inventory.** All
   `imr-inventory/...` references at L8-L14 are absolute filesystem
   paths (`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/...`).
   This works on the dev machine but won't be valid for any
   collaborator. The README uses relative paths (`../INVENTORY-MANAGEMENT`)
   which is the more portable choice. **Recommendation for follow-up:**
   pick one convention. Absolute paths are simpler for solo dev;
   relative paths assume sibling-repo layout but are portable. Either
   way, document the choice somewhere. Not blocking.

7. **`@react-native-async-storage/async-storage: 2.2.0`** is pinned to
   a major version, while `@react-native-community/netinfo: ^11.0.0`
   uses a caret. Inconsistent. AsyncStorage 2.x is the Expo-SDK-54
   compatible major (correct pin); NetInfo's caret allows minor/patch
   upgrades automatically. The pin/caret inconsistency is benign — the
   developer likely followed `expo install` conventions. **Not a
   finding, just noting for the spec 062 implementer.**

---

## Files reviewed

Implementation files reviewed against the design:

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/staff-catalog/index.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/staff-eod-submit/index.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/staff-waste-log/index.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/staff_role_eod_rls.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/smoke-staff-eod.sh`
- `/Users/will/Documents/GitHub/imr-staff/package.json`
- `/Users/will/Documents/GitHub/imr-staff/tsconfig.json`
- `/Users/will/Documents/GitHub/imr-staff/babel.config.js`
- `/Users/will/Documents/GitHub/imr-staff/metro.config.js`
- `/Users/will/Documents/GitHub/imr-staff/app.json`
- `/Users/will/Documents/GitHub/imr-staff/App.tsx`
- `/Users/will/Documents/GitHub/imr-staff/CLAUDE.md`
- `/Users/will/Documents/GitHub/imr-staff/README.md`
- `/Users/will/Documents/GitHub/imr-staff/src/README.md`
- `/Users/will/Documents/GitHub/imr-staff/.gitignore`

Cross-referenced against:

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/config.toml:391-398`
  (verify_jwt = false preserved)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260514120010_staff_submit_eod_v2.sql`
  (prior 7-arg signature being replaced)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260514120030_eod_submissions_consistency.sql:78-94`
  (the BEFORE INSERT/UPDATE trigger that re-derives submitted_by — confirms
  spec 020 round-2 promise still holds under per-user JWT path)

---

## Summary

The implementation matches the design across every load-bearing
decision: the auth.uid()-derived audit attribution (§2), the
`auth_can_see_store` membership gate (§11 risk #1), the GRANT swap (§1
Q1), the 410 edge function deprecations (§4), the pgTAP coverage (§8),
and the imr-staff scaffold (§B1/B2/B10). The developer's three
additions beyond the design — the 11th pgTAP assertion (service_role
EXECUTE lockdown), the spoof-proof check in smoke step 6, and the
far-past test date — are all defensible improvements that strengthen
the contract.

The three Should-fix findings are post-SHIP follow-ups, not blockers.
No Critical findings. Architecturally sound.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix
  (smoke cleanup, seed pre-assertion), 4 Minor findings. No blockers.
  Implementation matches design across §2, §4, §8, §9, §B1, §B2, §B10
  and addresses §11 risk #1 (cross-brand write hole) with both code
  gate and test coverage.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061/reviews/backend-architect.md
