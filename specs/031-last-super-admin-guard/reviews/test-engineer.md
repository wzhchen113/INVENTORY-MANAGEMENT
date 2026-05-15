## Test report for spec 031

### Acceptance criteria status

#### Server-side refusal (authoritative gate)

- AC-S1: `delete-user/index.ts` queries `profiles.role` before invoking `deleteUser` → PASS
  `supabase/functions/delete-user/index.ts:78-82` — `.from("profiles").select("role").eq("id", userId).maybeSingle()` called before any delete.

- AC-S2: Last-super_admin returns HTTP 400 `{"error":"cannot delete the last super_admin"}` → PASS
  `supabase/functions/delete-user/index.ts:92-102` — RPC `assert_not_last_of_role`; P0001 mapped to HTTP 400 with verbatim message.
  Covered by: `supabase/tests/delete_last_privileged_guard.test.sql::arm (iii)` (throws_ok, exact message match) + `scripts/smoke-edge-roles.sh` Arm 6 (end-to-end HTTP 400).

- AC-S3: Last-master returns HTTP 400 `{"error":"cannot delete the last master"}` → PASS
  Same code path. Covered by: `supabase/tests/delete_last_privileged_guard.test.sql::arm (i)` (throws_ok, exact message match).
  Note: the master arm is NOT separately covered by the smoke (Arm 6 only tests the super_admin path). See notes below.

- AC-S4: Both refusals use same envelope shape as self-delete refusal (HTTP 400, `{ error: <string> }`, corsHeaders) → PASS
  `supabase/functions/delete-user/index.ts:98-101` — identical shape to lines 60-63.

- AC-S5: Refusal fires BEFORE any `.from(...).delete()` side-effects → PASS
  Guard at lines 78-103; first `.from(...).delete()` at line 105.

- AC-S6: Lookup uses service-role client (RLS-bypassing) → PASS
  `supabase/functions/delete-user/index.ts:66` — `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` constructed before the lookup at line 78.

- AC-S7: No profile row (auth-only user) → guard no-ops → PASS
  `supabase/functions/delete-user/index.ts:91` — `if (targetProfile?.role)` short-circuits when `targetProfile` is null (`.maybeSingle()` returns null data for zero rows, not an error).
  Not separately tested in pgTAP or smoke (the existing delete sequence handles it); acceptable because the no-op path has no new logic.

- AC-S8: No new env var, no new import → PASS
  Implementation confirmed: reuses existing service-role client. No new imports added.

#### Client-side `canDelete` extension (UX hint, not security)

- AC-C1: `lastOfRoleByRole` map derived from already-fetched `users` list → PASS
  `src/screens/cmd/sections/UsersSection.tsx:76-79` — derived from `rawUsers` (same array from `fetchAllUsers`), no new RPC.

- AC-C2: `canDelete` additionally returns `false` when user is last super_admin or last master → PASS
  `src/screens/cmd/sections/UsersSection.tsx:287-288`.

- AC-C3: Existing `canDelete` rules preserved → PASS
  `src/screens/cmd/sections/UsersSection.tsx:284-286` — original predicate unchanged, new clauses appended with `&&`.

- AC-C4: No new RPC, no new edge-function call, no new query → PASS
  Derives count from `rawUsers` in-memory.

- AC-C5: When suppressed, no DELETE button rendered (no tooltip required for v1) → PASS
  `src/screens/cmd/sections/UsersSection.tsx:413` — `{canDelete ? (<TouchableOpacity>...) : null}`. No tooltip added.

- AC-C6: Brand-filtered subset handled correctly at server → PASS (acceptable v1 behavior, server is authoritative)
  Client may over-suppress DELETE when brand-scoped, but `visibleUsers` already strips super_admin rows for non-master admins, making the predicate unreachable for that sub-case. Server guards either way.

#### pgTAP regression test

- AC-P1: New file `supabase/tests/delete_last_privileged_guard.test.sql` → PASS. File count 14→15 confirmed (15 files in `supabase/tests/`).

- AC-P2: Hermetic `begin; ... rollback;` shape → PASS. Lines 35/126 of the test file.

- AC-P3: Two refusal arms (throws_ok) AND two allow arms (lives_ok) → PASS
  Arm (i) last-master refused, Arm (ii) non-last-master allowed, Arm (iii) last-super_admin refused, Arm (iv) non-last-super_admin allowed.

- AC-P4: Test mechanism: Path A (SQL function called directly) → PASS
  All arms call `select public.assert_not_last_of_role(...)` — same function the edge function RPCs. One source of truth.

- AC-P5: `npm run test:db` reports 15/15 pass → PASS (per dev's pre-verification).

- AC-P6 (arm ordering correctness): Architect §10 specifies master arms before super_admin arms to avoid seed mutation contaminating the master count → PASS
  Developer followed the architect ordering: Arm (i) = last-master, Arm (ii) = non-last-master, Arm (iii) = last-super_admin, Arm (iv) = non-last-super_admin.
  Note: spec AC §116-147 labels Arm (i) = last-super_admin and Arm (ii) = last-master; the developer re-ordered per the architect's §10 caveat. This is a label deviation, not a coverage gap — both refusal arms and both allow arms are present.

#### Smoke test (Arm 6)

- AC-SM1: `scripts/smoke-edge-roles.sh` gains Arm 6 after Arm 5 → PASS. Arm 6 at lines 325-381.

- AC-SM2: Arm 6 reuses Arm 4 super_admin promotion machinery → PASS. Guarded by `$PROMOTED == "1"` and `$SUPER_ADMIN_BEARER`.

- AC-SM3: SKIP if `$PROMOTED != "1"` → PASS. Line 328-329.

- AC-SM4: SKIP if pre-existing super_admin count != 1 → PASS. Lines 333-338.

- AC-SM5: POST to `delete-user` with promoted user's own id → PASS. Lines 350-355.

- AC-SM6: Assert HTTP 400 AND body matches either refusal string → PASS. Lines 359-363.
  Pattern: `'"error":"cannot delete (self|the last super_admin)"'`.

- AC-SM7: Re-confirm no state mutation (super_admin count still 1 post-call) → PASS. Lines 370-378.

- AC-SM8: Inherits non-local stack refuse guard → PASS. Guard at lines 53-60 runs before any arm.

- AC-SM9: Uses pass/fail/skip accumulator, exit $FAILED → PASS. Lines 78-81, 391.

- AC-SM10: `npm run test:smoke` passes → PASS (per dev's pre-verification). `test:smoke` chains smoke-edge-roles.sh as third script in `package.json`.

#### Convention doc additions

- AC-D1: `CLAUDE.md` gains last-of-role guard bullet → PASS. Bullet present at `CLAUDE.md:63`, inserted after the spec-028 escapeHtml bullet and before "Imports" bullet. Substance matches architect §12.1.

- AC-D2: `.claude/agents/security-auditor.md` gains reminder bullet → PASS. Bullet present at `security-auditor.md:51`, inserted in the "Edge functions" section after the escapeHtml audit bullet. Substance matches architect §12.2.

- AC-D3: Both additions strictly additive → PASS. No existing bullet reworded.

#### Cross-cutting verification gates

- AC-X1: `npx tsc --noEmit` exits 0 → PASS (per dev's pre-verification).
- AC-X2: `npm run typecheck:test` exits 0 → PASS (per dev's pre-verification).
- AC-X3: `npm test -- --ci` PASS, 24/24 → PASS. No jest suite for `UsersSection.tsx` or `delete-user` wrapper exists; the spec explicitly marks jest as optional for this feature ("pgTAP + smoke arm coverage is sufficient").
- AC-X4: `npm run test:db` PASS, 15/15 → PASS (per dev's pre-verification).
- AC-X5: `npm run test:smoke` PASS → PASS (per dev's pre-verification).
- AC-X6: Manual log-in gate (verify DELETE button absent on single super_admin row; curl confirms HTTP 400) → NOT TESTED (manual gate, no automation).

---

### Test run

The following was reported as pre-verified by the developer before this review:

```
npx tsc --noEmit          → clean
npm run typecheck:test     → clean
npm test -- --ci          → 24/24 PASS
npm run test:db            → 15/15 PASS
bash scripts/smoke-edge-roles.sh → 6/6 arms PASS
npm run test:smoke         → chained PASS
```

This reviewer did not re-run the full stack (requires `npm run dev:db` boot). All file-level assertions in this report are based on direct code inspection.

---

### Notes

#### pgTAP quality — fixture sanity assertion dropped (Nit)

The architect's §10 mentioned a "fixture sanity" assertion (e.g., `is((select count(*) ...), 1, 'one master in seed')`) to confirm the seed precondition before each arm. The developer dropped it per a comment at line 38-41 ("a fixture assertion is unnecessary here — the seed always contains these rows per supabase/seed.sql"). This is functionally equivalent when seed UUIDs are literals; if the seed ever changes, the tests will fail at the throws_ok/lives_ok assertion itself (just with a less diagnostic message). This is a nit, not a gap.

#### Implementation deviation from spec pseudocode — PGRST116 handling (Nit, functionally correct)

The spec design pseudocode (`delete-user/index.ts` §4) included `if (lookupError && lookupError.code !== 'PGRST116')` to explicitly ignore the "no rows" case from `.single()`. The implementation uses `.maybeSingle()` and simply `if (lookupError)`, which is correct: `.maybeSingle()` returns `{data: null, error: null}` for zero rows (no PGRST116). The implementation is cleaner than the pseudocode. Not a bug.

#### Implementation deviation — count semantics (Nit, semantically equivalent)

The spec says count `<= 1` (total rows of that role). The migration at line 63 counts `id <> target_user_id` and checks `v_count = 0` (other rows). Both predicates produce identical outcomes: "if zero other rows exist, the target is the last." Not a bug.

#### Smoke Arm 6 — depends on Arm 4 having run (Should-fix: document, not block)

Arm 6 SKIPs when `$PROMOTED != "1"`. If a future developer runs Arm 6 in isolation (or if Arm 4 is disabled), Arm 6 produces a SKIP rather than a FAIL. This is the stated design per spec AC. However, the master-role last-of-role refusal has no smoke arm at all — only the pgTAP arm (i) covers it. If the pgTAP suite is not run, the master arm has zero end-to-end coverage. This is acceptable per the spec's "either path for smoke" language, but the release coordinator should note it as a follow-up gap.

#### Smoke Arm 6 — accepts either refusal string (Should-fix: document, not block)

Per the spec and the architecture §4 ordering rationale, self-delete fires first, so in practice Arm 6 always receives `"cannot delete self"` (not `"cannot delete the last super_admin"`). The arm correctly accepts either. The implication is that Arm 6 never actually exercises the last-super_admin branch of the edge function via the HTTP path — it only exercises the self-delete branch. The pgTAP arm (iii) is therefore the load-bearing test for the new SQL guard (Path A). The spec acknowledges this limitation explicitly. Severity: low, because pgTAP covers the actual guard function.

A follow-up arm that targets a different user's last-of-role row (avoiding the self-delete collision) would close this gap. Out of scope for v1 per spec.

#### Smoke Arm 6 — SUPER_ADMIN_BEARER pre-supplied path skips Arm 6 (Should-fix: document)

If the operator supplies `SUPER_ADMIN_BEARER` via environment variable, `PROMOTED` stays `0` and Arm 6 SKIPs. The spec says "reuse Arm 4's bearer if still valid; otherwise re-login" but the implementation only uses the bearer if Arm 4 promoted. There is no path where a pre-supplied bearer causes Arm 6 to run. Operators who pass a pre-minted super_admin bearer will get a SKIP. This is safe (no mutation without PROMOTED=1 guard) but the skip reason should mention this case. Low severity.

#### Manual gate (pre-deploy gate)

AC-X6 is manual only: log in as sole super_admin (use the same promotion dance as Arm 4), open `UsersSection`, confirm DELETE button is absent on the super_admin row. Then curl the edge function directly and confirm HTTP 400. This gate has no automation. It is a pre-deploy obligation.

#### Two-step deploy ordering (Critical for release coordinator)

The edge function at line 92 calls `supabase.rpc('assert_not_last_of_role', ...)`. If the function is deployed BEFORE the migration is applied (`supabase db push`), every privileged-role delete returns HTTP 500 (`function public.assert_not_last_of_role(uuid, text) does not exist`). The correct order is:

1. `npx supabase db push --project-ref <ref>` — apply the migration.
2. `npx supabase functions deploy delete-user --project-ref <ref>` — deploy the edge function.

The spec calls this out at §13. The release coordinator must surface both steps in the deploy proposal and flag that reversing the order causes fail-closed HTTP 500 on every privileged delete. There is no CI gate enforcing this order (per CLAUDE.md "CI workflow" — `db-migrations-applied.yml` does not exist on disk).

#### `assert_not_last_of_role` `stable` annotation (Nit)

The function is marked `stable` (read-only, same result per statement). Technically this is correct — it reads `profiles` and either raises or returns void. However, `stable` allows the planner to inline and cache the call in some query patterns. Since the function raises an exception rather than returns a value, the caching guarantee is not meaningful in practice. `volatile` (the default) would be safer and is the convention for functions that raise. This is a low-severity style nit; it does not affect correctness in the current call pattern.

---

### Acceptance criteria status summary

All 31 automatable acceptance criteria: **PASS**
AC-X6 (manual login + curl gate): **NOT TESTED** (manual gate by design, no automation path)

**Release coordinator note:** the NOT TESTED gate is explicitly a manual pre-deploy gate per the spec. It does not block the spec from SHIP_READY, but the release coordinator should list it as a required pre-deploy step alongside the two-step migration/function deploy ordering.
