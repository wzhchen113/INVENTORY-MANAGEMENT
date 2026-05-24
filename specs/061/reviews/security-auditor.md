## Security audit for spec 061

Spec 061 explicitly opens a new authorization surface: staff users (`profiles.role = 'user'`, `app_metadata.role = 'user'`) can now call `public.staff_submit_eod` directly via per-user JWT under the `authenticated` role, where previously only `service_role` could. This audit walks every attack vector flagged in the dispatcher prompt and the architect's §11 risk table.

**Bottom line: no Critical findings. The migration lands the load-bearing membership gate correctly, is spoof-proof against caller-supplied identity, and the GRANT swap is internally consistent. Three Low/informational findings noted below for follow-up; none block deploy.**

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql:95-98` — The membership gate raises `'staff_submit_eod: caller cannot see store %'` which interpolates the raw `p_store_id` UUID into the error message. The store_id is caller-supplied so this is not a data-leak (caller already knows the value they passed), and PostgREST will surface the message back to that same caller. Not a finding per the threat model. Informational: if the message ever changes to interpolate something server-derived (e.g. caller's own user_id), reconsider. As-shipped this is fine — same shape as `report_run`'s `'Not authorized for store %'` at `supabase/migrations/20260510120000_report_runs.sql:178`.

- `scripts/smoke-staff-eod.sh:53,56` — Hardcoded local-dev credentials (`SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`, `STAFF_PASSWORD=password`). The anon key is a publishable key safe to commit (its comment block makes this explicit, and matches `scripts/smoke-rpc.sh`); the password is the documented local-dev seed (`manager@local.test` / `password` from `supabase/seed.sql`). Not a finding — these are local-dev defaults the script is designed to be overridden via env vars for any non-local run. Per the User-MEMORY "Local Supabase dev stack" note, the password is project convention.

- `scripts/smoke-staff-eod.sh:88` — Logs `${#STAFF_TOKEN}` length only (`got staff access_token (${#STAFF_TOKEN} chars)`); the token itself is never written to stdout. Reviewed all 9 steps — no path leaks the bearer JWT. Cleanly handled.

### Verification notes (the 10 attack vectors from the dispatcher prompt)

The audit findings list is short because the implementation correctly addresses each load-bearing concern. The notes below document what I checked and why it lands.

#### 1. Cross-brand write hole (§11 risk #1)

**Verdict: closed.**

The gate at `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql:95-98`:

```sql
if not public.auth_can_see_store(p_store_id) then
  raise exception 'staff_submit_eod: caller cannot see store %', p_store_id
    using errcode = '42501';
end if;
```

fires AFTER the vendor-presence check (line 78-82) and BEFORE the vendor-name hydration (line 104-106), the idempotency check, and any INSERT/UPDATE statement. Sequence audited statement-by-statement: lines 77→82 (vendor-NULL check) → 95→98 (the gate) → 100→106 (SELECT FROM vendors, read-only) → 120→131 (idempotency SELECT, read-only) → 143→149 (the first write, an INSERT into eod_submissions).

No write happens before the gate. The errcode is `42501` (insufficient_privilege) which PostgREST maps to HTTP 403. The gate uses the project's canonical `public.auth_can_see_store(uuid)` helper, defined at `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:88-108` with three-arm semantics (super_admin sees all; admin/master sees own brand; everyone else sees only stores in their `user_stores`). A staff user from brand X cannot pass this gate for a store in brand Y because the third arm checks `user_stores.user_id = auth.uid() AND store_id = p_store_id` which would return no rows for a cross-brand store.

pgTAP coverage: `supabase/tests/staff_role_eod_rls.test.sql:228-250` (assertion 5) impersonates the seed manager user (`22222222-…`, `user_stores` for Towson + Frederick only) and attempts to call the RPC with `p_store_id = Charles`. The test asserts `throws_ok(..., '42501', ...)`. The `set local role authenticated` + `set_config('request.jwt.claims', ...)` pattern at lines 121-130 is the correct PostgREST-equivalent impersonation shape and matches the rest of the suite (`supabase/tests/eod_submissions_consistency.test.sql`).

#### 2. Identity spoofing (Q1 architect ruling)

**Verdict: closed.**

The `p_submitted_by` parameter stays in the signature (line 58) but the body NEVER uses it as a trusted identity source. The trust resolution is at line 114:

```sql
v_actor := coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown');
```

`auth.uid()` wins when present — and under the new GRANT-to-authenticated path it ALWAYS returns the caller's auth.users.id, not the function-definer's id (this is intentional behavior: `auth.uid()` reads `request.jwt.claims->>'sub'` from the GUC PostgREST sets per-request, not the session-current_user). `security definer` does NOT shadow this — it changes only the privileges Postgres uses for permission checks on subsequent SQL, not the JWT claim GUC.

`p_submitted_by` is only consulted on the second tier (the function-definer/service-role path where `auth.uid()` is NULL — defense in depth for the deprecation window). For any caller that successfully passes the gate at line 95 (which requires `auth_can_see_store(p_store_id) = true`, which requires the third arm because the first two require admin/super-admin role and admit through their own truthiness), `auth.uid()` MUST be non-null. So the spoofable second tier is unreachable for any staff caller — and even if reached (e.g. by service_role, which is REVOKE'd from EXECUTE anyway), the caller-supplied value lands only in the audit row, not in any RLS-bearing field.

`eod_submissions.submitted_by` is server-derived independently via the `eod_submissions_set_submitted_by_trg` trigger at `supabase/migrations/20260514120030_eod_submissions_consistency.sql:78-94` — a `BEFORE INSERT/UPDATE` trigger that overrides `submitted_by` to `auth.uid()` regardless of what the RPC body wrote (the RPC writes `null` at migration line 144, but the override fires either way). Defense in depth.

pgTAP coverage:
- Assertion 3 at `supabase/tests/staff_role_eod_rls.test.sql:194-204` confirms `eod_submissions.submitted_by` equals `auth.uid()` (the manager seed user id), proving the trigger fires under the new GRANT.
- Assertion 4 at lines 211-221 confirms `audit_log.detail` starts with the manager user id, NOT the caller-supplied `null` (i.e. NOT the fallback `'staff:unknown'`).
- Note: assertion 4 passes `p_submitted_by = null` but does NOT pass a spoofed value like `'some-other-user'` to prove the body ignores it. This is a coverage gap for the "explicitly spoofed" case but NOT a finding — the `coalesce(auth.uid()::text, p_submitted_by, ...)` shape makes the precedence trivially auditable, and `auth.uid()` will dominate whenever non-null. The smoke script at `scripts/smoke-staff-eod.sh:204-209` reads `submitted_by` from the persisted row and asserts the manager UUID, providing an end-to-end equivalent.

#### 3. GRANT swap correctness

**Verdict: correct.**

Migration line 221-222:

```sql
revoke all on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) to authenticated;
```

The `REVOKE ALL FROM public, anon, authenticated, service_role` first wipes any inherited PUBLIC grant (per the project convention at `supabase/migrations/20260505065303_admin_rpcs_lock_anon.sql` — Postgres' default is `EXECUTE TO PUBLIC` and `anon` inherits from PUBLIC, so a REVOKE-from-anon-only would leave the function callable). Then GRANT EXECUTE TO authenticated. Result state:
- public: no EXECUTE
- anon: no EXECUTE (inherited from public was wiped)
- authenticated: EXECUTE
- service_role: no EXECUTE (the destructive half of the swap)

pgTAP assertion 10 at `supabase/tests/staff_role_eod_rls.test.sql:111-118` verifies the service_role lockdown explicitly via `has_function_privilege('service_role', ..., 'EXECUTE')`. The assertion runs BEFORE the `set local role authenticated` block so it executes under the still-postgres role (which has the privilege to read the function ACL).

The function remains `security definer` (line 64). This is intentional and necessary — the body writes to `inventory_items.current_stock` (line 174-179) and `audit_log` (line 187-197). Flipping to `security invoker` would require additional grants to the staff user on those tables. With `security definer` + the explicit membership gate at line 95, the gate IS the only authorization check (RLS does not auto-enforce for INSERTs on tables owned by the function-definer / postgres role per standard Postgres semantics).

This shape mirrors `report_run_stub` at `supabase/migrations/20260510120000_report_runs.sql:170-180` (the project's canonical "RPC + explicit auth_can_see_store gate" pattern, though `report_run_stub` is `security invoker` because it only reads). The architect chose the right tradeoff: keep `security definer` for cross-table writes, gate manually instead of relying on RLS.

#### 4. `security definer` + missing membership

**Verdict: not present.**

I read the full RPC body (migration lines 76-211) statement by statement. There is NO write before the gate. Specifically:
- Lines 78-82: `if p_vendor_id is null then raise exception ...` — read-only check.
- Lines 95-98: the gate. Fires here.
- Lines 100-106: `select v.name into v_vendor_name from public.vendors` — read-only.
- Lines 120-131: idempotency check via SELECT FROM eod_submissions — read-only, and returns early without writing.
- Lines 143-149: first write (INSERT into eod_submissions).
- Line 152: DELETE FROM eod_entries (clears the existing entries for replace semantics).
- Lines 156-203: loop INSERTing eod_entries + UPDATEing inventory_items + INSERTing audit_log.

No conditional branch skips the gate. The gate runs unconditionally on every non-null-vendor call. The only way to bypass the gate would be to call the function from a session that doesn't go through PostgREST — i.e. directly from psql as a role that has EXECUTE. The GRANT lockdown forces that to be `authenticated` (which always has `auth.uid()` populated via JWT), the function-definer/postgres (which is meta and out-of-band), or service_role (which is REVOKE'd).

Edge case: if Postgres' `auth.uid()` somehow returned NULL for a JWT-authenticated PostgREST caller (e.g. a malformed claim), the gate would still fire because `auth_can_see_store` checks all three arms and the third (`user_stores`) needs a non-NULL `auth.uid()` to match. A NULL `auth.uid()` would fail all three arms and the gate would refuse. Verified via reading `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:88-108`. Safe.

#### 5. Deprecated edge functions

**Verdict: correct.**

All three functions (`supabase/functions/staff-eod-submit/index.ts`, `supabase/functions/staff-catalog/index.ts`, `supabase/functions/staff-waste-log/index.ts`) are now 40-line files that:

- Return HTTP 410 for every non-OPTIONS method (no echoing of request body — the response body is a static JSON literal with `error` + `reference` fields citing the spec).
- Return `"ok"` 200 for OPTIONS (CORS preflight), preserving the original CORS posture so a hypothetical browser caller's preflight doesn't fail at the CORS layer and mask the 410.
- Do NOT echo any caller-supplied data. The response body is identical for every caller.
- Do NOT validate or read any bearer token. No `STAFF_SERVICE_TOKEN` lookup, no service-role client construction, no Supabase client at all.
- `verify_jwt = false` retained in `supabase/config.toml:391-398` (config unchanged by this spec). This is intentional per the architect (§4 of spec): a 401 at the gateway layer would obscure the 410 deprecation signal.

The deletion of the `createClient` import, the `STAFF_SERVICE_TOKEN` env lookup, and the `checkAuth` helper is complete in all three files (verified by reading each end-to-end). No "dangling secret" path — the functions don't read `STAFF_SERVICE_TOKEN` anymore. The env var stays defined in the deploy environment (architect §4: "removing it is a follow-up cleanup spec; operationally harmless once the functions stop reading it") and that's correct: removing it from a live deploy without first removing the readers would be the riskier order.

Smoke coverage: `scripts/smoke-staff-eod.sh:306-331` loops over all three function names, asserts HTTP 410, and asserts the body contains the string `'spec 061'`. Solid.

#### 6. Cross-store cross-brand SELECT exposure

**Verdict: matches the architect's §0 ruling — by-design and bounded.**

Architect's §0 (lines 288-349 of the spec) explicitly revises AC A2 because the original "staff CANNOT read recipes/purchase_orders/brand-catalog" was unenforceable under the existing brand-catalog refactor. Staff users CAN read brand-shared tables (recipes, catalog_ingredients, prep_recipes, vendors, ingredient_categories) because those are gated by `auth_can_see_brand(brand_id)` which admits any caller whose `profiles.brand_id` matches. The seed manager user has `brand_id = '2a000000-…'` and so does the entire 2AM PROJECT brand, so this passes.

Staff users CAN read per-store tables (`purchase_orders`, `audit_log`, `eod_submissions`, `inventory_items`) for stores in their `user_stores`. They CANNOT read for stores NOT in their `user_stores` — verified by pgTAP assertion 8 at `supabase/tests/staff_role_eod_rls.test.sql:286-323` which seeds a row at Charles as postgres (bypasses RLS), then under the staff impersonation reads zero rows.

Staff users CANNOT cross-brand read: a hypothetical brand-Y row in any of the brand-shared tables would be invisible because the brand-Y catalog has `brand_id = brand-Y-uuid` and `auth_can_see_brand(brand-Y-uuid)` checks `profiles.brand_id = p_brand_id`, which is false for a 2AM-PROJECT staff user. (This is the spec-041 brand-scoping enforcement and predates 061.) Spec 061 introduces no new cross-brand read surface.

Staff users CANNOT write to any brand-shared table — pgTAP assertion 9 at lines 330-340 confirms a direct INSERT into `recipes` raises 42501 via the `auth_is_privileged`-gated `privileged_insert_recipes` policy. Same shape applies to catalog_ingredients, prep_recipes, etc.

This is the right boundary for the threat model: brand-shared READS are an acceptable widening (line cooks need recipes); brand-shared WRITES remain admin-only.

#### 7. Realtime publication scope

**Verdict: unchanged.**

`grep "alter publication supabase_realtime"` on the new migration returns zero matches. No tables added to `supabase_realtime`, no membership change. The migration is auth-and-grant only. The existing realtime subscriptions on `eod_submissions` continue to fire for staff submissions — by design, the admin app's `useRealtimeSync` picks up staff submissions in real time (architect §6, A5 regression behavior).

No `docker restart supabase_realtime_imr-inventory` ritual needed (the migration comment at lines 44-46 explicitly notes this).

#### 8. OWASP Top 10 sweep

- **A01 Broken Access Control**: addressed by the explicit gate + GRANT swap. Covered above.
- **A02 Cryptographic Failures**: no new secrets, no new cryptographic surface. JWT signing is Supabase Auth's responsibility, unchanged.
- **A03 Injection**: the RPC is `language plpgsql` with parameter binding throughout. The only "dynamic" element is `jsonb_to_recordset(p_entries)` at line 157, which is a built-in safe deserializer with explicit column types (`ingredient_id uuid, actual_remaining numeric, unit text, notes text`); jsonb values that don't match the type are rejected by the recordset cast, not concatenated into SQL. No `EXECUTE`, no `format(... %s ...)`, no string concatenation that touches user input. The audit_log INSERT at line 187-197 uses parameter binding (`v_actor`, `v_vendor_name`, `v_entry.actual_remaining::text`) — `v_actor` is built from `auth.uid()::text` (a UUID, no quote chars) or `p_submitted_by` (a text caller-supplied) or `'staff:unknown'` (literal), and `v_vendor_name` is a SELECT-fetched column. Both are safe parameter-bound values, not string-interpolated SQL.

  **Edge case worth noting**: `p_submitted_by` is caller-supplied `text` with no length cap or shape validation. A malicious caller could pass a 10 MB string and have it land in `audit_log.detail`. The audit_log INSERT uses parameter binding so this is not a SQL injection, but it IS a low-severity DoS / log-pollution surface. Practical mitigation: (a) `auth.uid()` wins in the coalesce so `p_submitted_by` is only used when `auth.uid()` is null, which under the new GRANT shape is impossible for any authenticated caller; (b) the cost of writing 10 MB to audit_log is borne by the caller (the row is what it is); (c) the caller is identified — they spoofed nothing, the row is attributed to their `auth.uid()` via the trigger. Not a finding; flagging for posterity only.

- **A04 Insecure Design**: the design has been audited by the architect (§11) and the spec explicitly enumerates risks 1-10. The load-bearing change (gate before write) is implemented.
- **A05 Security Misconfiguration**: `verify_jwt = false` on three edge functions is correctly retained for the deprecation deploy (would otherwise mask 410 with a 401). `STAFF_SERVICE_TOKEN` env var is operationally dead but harmless.
- **A06 Vulnerable Components**: no `package.json` change.
- **A07 Authn Failures**: JWT-based auth via Supabase Auth, unchanged. The new RPC relies on `auth.uid()` being trustworthy, which is the existing project assumption (the JWT is gateway-validated by PostgREST before `request.jwt.claims` is populated).
- **A08 Software/Data Integrity Failures**: `audit_log.actor_id` is correctly server-derived (verified above).
- **A09 Logging Failures**: no PII in error messages. The 42501 message interpolates the caller's own store_id, not server-side data.
- **A10 SSRF**: N/A — no outbound HTTP from the RPC or deprecated edge functions.

#### 9. Shell smoke script

**Verdict: clean.**

`scripts/smoke-staff-eod.sh` reviewed end-to-end:

- Local-dev defaults only (`SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_ANON_KEY=<publishable>`, `STAFF_EMAIL=manager@local.test`, `STAFF_PASSWORD=password`). All overridable via env vars; the script's header comments document the override mechanism.
- JWT acquired at line 80 via Supabase Auth REST. Token length is logged (`got staff access_token (${#STAFF_TOKEN} chars)`) but the token contents are never echoed. The `STAFF_TOKEN` env-var override path (line 75) lets a CI runner inject a pre-acquired token without the script ever doing a login round-trip.
- The token is sent as a Bearer header (lines 97, 147, 192, 217, 261, 290). It does NOT appear in any log line or assertion message.
- The negative case at lines 257-300 uses a fresh `client_uuid` so it cannot collide with the happy-path row. `CODE3 != 200` is the assertion; either 403 (PostgREST default for 42501) or 500 (PG error surfaced raw) is acceptable, which is correct since the architect's spec doesn't pin the exact mapping.
- The edge-function smoke at lines 306-331 uses no auth at all (no `apikey`, no `Authorization`), proving the 410 is unconditional and not gated on a missing bearer.

Note: the script writes a non-transactional row to today's `eod_submissions` / `eod_entries` / `audit_log` (steps 5-6 with `TODAY=$(date +%Y-%m-%d)`). This residue is documented in the spec's "Open notes for reviewers" #1 — known issue, not a security issue, just operational hygiene. Architect's mitigation (use `1999-12-31` in the pgTAP test, which DOES roll back via `begin/rollback`) is sensible.

#### 10. imr-staff scaffold

**Verdict: clean.**

Reviewed:
- `/Users/will/Documents/GitHub/imr-staff/App.tsx` — a 47-line placeholder rendering "Hello from imr-staff". Contains a one-line absolute-filesystem-path pointer to the spec at `imr-inventory/specs/061-staff-app-eod-count.md`. The path is in a comment, not a runtime string. Not leaky — the spec is in a sibling repo on the same machine; the path is informational for the next agent reading the file.
- `/Users/will/Documents/GitHub/imr-staff/CLAUDE.md` — 162-line project-instructions doc. Documents:
  - Stack
  - Auth model (per-user JWT, no shared secrets, explicit "NOT included: any service token")
  - Conventions (no admin UI, no brand catalog UI)
  - Env vars (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` only — the publishable ones)
  - Deprecated edge function list (so a future agent doesn't try to call them)
  - Hard rules (do not change imr-inventory's app.json slug, do not add admin UI, do not call deprecated edge functions)
  - Roadmap (spec 062+)
  No secrets, no service-role keys, no real production URLs (only the env-var names — the values are supplied at deploy time). Cleanly written.
- The bash-tool sandbox blocked me from `ls -la`'ing the imr-staff repo root (auto mode classifier flagged the sibling-repo listing as scope escalation) so I cannot personally verify `.gitignore` excludes `.env*`. The spec's "Files created" section at line 1462 of the spec claims `.gitignore — standard Expo/RN ignores plus .env* local variants`. I trust the spec author's claim because (a) the App.tsx and CLAUDE.md I CAN read contain no secrets, (b) `EXPO_PUBLIC_*` env vars are public by definition, (c) the project does not use any service-role key on the staff app side. Recommendation for the release-coordinator: confirm `.gitignore` contains `.env*` either via the user or via direct file read. This is a documentation-level concern, not a vulnerability — the placeholder App.tsx never loads any env var.

#### Migration-level concerns audit

A few additional checks beyond the dispatcher's 10 vectors:

- **Search_path lockdown**: `set search_path = public` at migration line 65. Matches the project convention for `security definer` functions. Prevents a search_path attack where a malicious schema in `pg_temp` shadows `public.auth_can_see_store` — verified pattern at `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:90` (`set search_path = public, auth`) and the report_run helper.

- **Drop-then-recreate**: line 52 (`drop function if exists ...`) before recreate. Per the migration's leading comment (line 49-51): "mirrors the spec 020 round-2 / spec 020 v2 pattern. `create or replace` would also work but drop+recreate makes the intent explicit and surfaces signature drift." Safe — the signature hasn't changed and the GRANT block at lines 221-222 is the source of truth for the new ACL after recreate.

- **Race between drop and recreate**: in a transaction (which a Supabase migration is implicitly), the function disappears between line 52 and line 54 from the caller's perspective. Any concurrent call during the migration window would 500. This is the same posture as every other `drop function ... if exists; create function ...` migration in the project (spec 020, spec 022, etc.) — accepted operational tradeoff. Not a security issue.

- **`auth.uid()` shadowing**: `auth.uid()` is in the `auth` schema. The function's `search_path = public` does NOT shadow `auth.uid()` because `auth.` is explicitly schema-qualified in the call (`auth.uid()::text` at line 114). Safe.

- **The trigger's `security invoker` posture interacting with `security definer` RPC**: the BEFORE INSERT trigger `eod_submissions_set_submitted_by_trg` is `security invoker`, meaning it runs as the calling role. When the RPC body's INSERT into `eod_submissions` fires the trigger, the trigger runs under the function-definer role (because `security definer` rebinds `current_user` for the duration of the function body). At that point, `auth.uid()` continues to read from `request.jwt.claims->>'sub'` — which is the JWT-authenticated staff user. Verified by the architect's §1 commentary (lines 386-394 of the spec) and pgTAP assertion 3 (which would FAIL if the trigger somehow saw a different uid). Subtle and correct.

### Dependencies

No `package.json` changes — `npm audit` skipped per process. (The new repo `imr-staff` has its own `package.json` but I cannot inspect it from the project sandbox and the per-spec ownership says imr-staff frontend deps are a spec 062 concern, not a spec 061 deliverable. The dispatcher prompt noted this explicitly.)

### Summary

This spec correctly executes a high-stakes authorization-surface expansion. The three load-bearing changes (membership gate, spoof-proof audit attribution, GRANT swap) are implemented, internally consistent, and well-covered by pgTAP + smoke. The deprecated edge functions cleanly return 410 with no information disclosure. The seed-user impersonation pattern in pgTAP correctly exercises the new boundary. No Critical, no High, no Medium findings. Three Low/informational notes for follow-up, none blocking deploy.

The spec author and backend developer chose the right tradeoff at every fork: `security definer` retained (because the body writes across tables that would otherwise need fresh grants); membership gate added in the body (because RLS doesn't auto-enforce inside `security definer`); audit attribution server-derived (because the alternative is spoofable); GRANT swap atomic with the edge-function deprecation (because a split deploy would leave a stale service-role caller hitting a REVOKE'd EXECUTE).

This audit recommends SHIP_READY from the security perspective.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low (all informational, none blocking deploy).
payload_paths:
  - specs/061/reviews/security-auditor.md
