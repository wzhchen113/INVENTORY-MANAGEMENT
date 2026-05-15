## Test report for spec 032

### Acceptance criteria status

**Helper contract**

- AC-H1: `callEdgeFunction` signature changes from `Promise<void>` to `Promise<{ data: any; error: string | null }>` → PASS — `src/lib/auth.ts:125-128`; verified via typecheck:test exit 0 and all 11 jest tests compiling against the new signature.
- AC-H2: HTTP 2xx returns `{ data: <parsed JSON or null>, error: null }`; body parse failure is NOT an error → PASS — `src/lib/auth.test.ts::returns { error: null } on HTTP 200 with valid JSON body`, `::returns { error: null } on HTTP 200 with empty body`, `::returns { error: null } on HTTP 200 with non-JSON body (graceful)`.
- AC-H3: HTTP non-2xx returns structured `{ data: null, error: <string> }` with three-tier fallback (JSON `error` field → JSON `message` field → `"HTTP <status>"`) → PASS — `src/lib/auth.test.ts` cases 4–8 cover all three tiers directly.
- AC-H4: Network failure (fetch rejects) returns `{ data: null, error: <e.message || 'Network error'> }` → PASS — `src/lib/auth.test.ts::returns the rejection message on fetch failure (network error)`.
- AC-H5: Missing session returns `{ data: null, error: 'Not authenticated' }` without calling `fetch` → PASS — `src/lib/auth.test.ts::returns { error: "Not authenticated" } when session is null and never calls fetch` (asserts `fetchMock` not called).
- AC-H6: JSDoc documents the contract verbatim (all six envelope variants + fire-and-forget call-out) → PASS — `src/lib/auth.ts:109-123`; matches architect §2 canonical text exactly.
- AC-H7: No new dependencies, no new imports → PASS — `auth.ts` imports unchanged; `auth.test.ts` imports only `./supabase` and `./auth`, both pre-existing.
- AC-H8: Argument shape `(fnName: string, body: Record<string, any>)` preserved → PASS — `src/lib/auth.ts:125-127`.

**Caller chain audit**

- AC-C1: `inviteUser` keeps fire-and-forget (`callEdgeFunction` not awaited at line 242) → PASS — confirmed in `src/lib/auth.ts:242`; no `await` keyword present.
- AC-C2: `registerInvitedUser` keeps fire-and-forget (line 327) → PASS — confirmed in `src/lib/auth.ts:327`; no `await` keyword present.
- AC-C3: `deleteUser` rewritten to destructure `{ error }` from helper, try/catch dropped → PASS — `src/lib/auth.ts:437-439` matches the spec-required snippet exactly.
- AC-C4: `sendPasswordReset` untouched (uses `supabase.auth.resetPasswordForEmail`) → PASS — `src/lib/auth.ts:454-462` unchanged.
- AC-C5: `signIn`/`signOut`/`getSession`/`fetchProfile`/`fetchAllUsers` untouched → PASS — none use `callEdgeFunction`; confirmed by reading `src/lib/auth.ts`.
- AC-C6: `deleteProfile` (`useStore.ts:792-825`) — NO CHANGE REQUIRED; already routes `error` through `notifyBackendError` before any optimistic mutation → PASS — `src/store/useStore.ts:796-800` confirmed: `if (error) { notifyBackendError(...); return false; }` appears BEFORE `set({ brandAdminsByBrandId: next })`.
- AC-C7: `handleConfirmDelete` (`UsersSection.tsx:112-134`) — NO CHANGE REQUIRED; already bails on `!ok` → PASS — `src/screens/cmd/sections/UsersSection.tsx:116-117` confirmed.
- AC-C8: `InviteUserDrawer.handleSave` and `InviteAdminDrawer.handleSave` — NO CHANGE REQUIRED; already inspect `result.error` → PASS — not re-read (out of scope for spec 032; spec marks as unchanged).
- AC-C9: `fetchBreadbotSales` (`db.ts:1143`) — NO CHANGE REQUIRED; uses `supabase.functions.invoke` → PASS — noted in spec as already on the correct shape; outside scope of spec 032.
- AC-C10: Architect-required grep confirms zero `await fetch.*functions/v1` hits outside `src/lib/auth.ts` → PASS — grep output: `src/lib/auth.ts` only.

**Jest test coverage**

- AC-T1: New file `src/lib/auth.test.ts` lands in unit project (`testEnvironment: node`) → PASS — jest config `jest.config.js:64-68` includes `src/lib/**/*.test.ts`; test runs in `unit` project per verbose output.
- AC-T2: Mock `global.fetch` (not `jest.spyOn`) + mock `supabase.auth.getSession` at module boundary → PASS — `jest.mock('./supabase', ...)` at top of file; `(global as any).fetch = jest.fn()` per-test with `beforeEach(jest.clearAllMocks)`.
- AC-T3: All 11 specified test cases present and pass → PASS — 11/11 green per verbose `npm test -- --ci` output. Cases mapped to spec:
  1. HTTP 200 + JSON body — present, passes.
  2. HTTP 200 + empty body — present, passes.
  3. HTTP 200 + non-JSON body — present, passes.
  4. HTTP 400 + `{ error: "cannot delete the last super_admin" }` — present, passes.
  5. HTTP 400 + `{ error: "cannot delete self" }` — present, passes.
  6. HTTP 500 + `{ message: "internal error" }` — present, passes.
  7. HTTP 500 + non-JSON body — present, passes.
  8. HTTP 401 + `{ error: "Unauthorized" }` — present, passes.
  9. fetch rejection — present, passes.
  10. Missing session + fetch never called — present, passes (asserts `fetchMock` not called).
  11. Session present → correct URL path + bearer header + method + body — present, passes (architect-requested URL assertion included).
- AC-T4: All 11 tests PASS under `npm test -- --ci` → PASS — 35/35 total (24 pre-existing + 11 new = 35).
- AC-T5: `describe('callEdgeFunction', ...)` block, `beforeEach(jest.clearAllMocks)`, no `--detectOpenHandles` workarounds → PASS — `src/lib/auth.test.ts:61-63`.

**Spec 031 retroactive correction**

- AC-R1: §9 trailing parenthetical appended at `specs/031-last-super-admin-guard/spec.md` after "The verbatim strings from §5 land in the toast." → PASS — confirmed at spec 031 lines 887-890; wording matches architect §5 canonical text verbatim.
- AC-R2: No other spec 031 prose amended (ACs, design, files-changed sections untouched) → PASS — read lines 860-895; only §9 has the parenthetical addition.

**Cross-cutting verification gates**

- AC-V1: `npx tsc --noEmit` exits 0 on spec 032 code (pre-existing `@types/* 2` TS2688 errors only, same as prior specs) → PASS — confirmed: zero TS errors attributable to spec 032; all 24 errors are pre-existing TS2688 `@types/* 2` cruft explicitly documented in every prior spec verification section.
- AC-V2: `npm run typecheck:test` exits 0 → PASS — exit code 0 confirmed.
- AC-V3: `npm test -- --ci` PASS, count increases by 11 → PASS — 24 → 35; +11 exactly.
- AC-V4: `npm run test:db` PASS (sanity, no DB changes) → NOT TESTED in this session (local DB stack not booted; test:db requires `npm run dev:db`). Per the spec, this is a sanity-only gate with no DB changes and file count expected to stay at 15. The prior run noted in the verification section reports 15/15 PASS. No path in spec 032 touches DB code. Risk of regression: negligible.
- AC-V5: `npm run test:smoke` PASS (sanity, no smoke changes) → NOT TESTED in this session. Same caveat as AC-V4 — requires live local stack. Per the spec and prior run, PASS with no smoke arm changes. Risk of regression: negligible.
- AC-V6: Manual browser verification (promote admin to sole super_admin, attempt self-delete, assert red toast + row stays) → NOT TESTED. See notes below.

**CLAUDE.md convention bullet**

- (Not an explicit numbered AC, but listed in Files Changed): New bullet inserted between spec-031 bullet and `Imports.` bullet in "Conventions already in use" → PASS — `CLAUDE.md` line 64 contains the "Edge function calls go through `callEdgeFunction`" bullet; placement and wording match architect §6 exactly.

---

### Test run

```
npm test -- --ci --verbose

PASS unit src/lib/auth.test.ts
  callEdgeFunction (via deleteUser)
    ✓ returns { error: null } on HTTP 200 with valid JSON body (1 ms)
    ✓ returns { error: null } on HTTP 200 with empty body
    ✓ returns { error: null } on HTTP 200 with non-JSON body (graceful)
    ✓ surfaces the verbatim refusal string on HTTP 400 + { error: "cannot delete the last super_admin" } (1 ms)
    ✓ surfaces the verbatim refusal string on HTTP 400 + { error: "cannot delete self" }
    ✓ falls back to `message` field on HTTP 500 + { message: "internal error" }
    ✓ synthesizes "HTTP <status>" on HTTP 500 + non-JSON body
    ✓ surfaces { error: "Unauthorized" } on HTTP 401
    ✓ returns the rejection message on fetch failure (network error)
    ✓ returns { error: "Not authenticated" } when session is null and never calls fetch
    ✓ calls fetch with the correct edge-function URL and bearer header when session present (1 ms)

PASS component src/components/cmd/StatusPill.test.tsx (5 tests)
PASS unit src/utils/relativeTime.test.ts (9 tests)
PASS unit src/utils/escapeHtml.test.ts (7 tests)
PASS unit src/utils/seedVarianceDates.test.ts (3 tests)

Test Suites: 5 passed, 5 total
Tests:       35 passed, 35 total
Snapshots:   0 total
Time:        0.401 s
```

`npm run typecheck:test` — exit 0 (clean).

`npx tsc --noEmit` — exit 2; all 24 errors are pre-existing TS2688 `@types/* 2` cruft (same error set as all prior specs; zero new type errors from spec 032 code).

---

### Notes

**Manual browser gate (AC-V6) — must run before SHIP_READY**

The spec names a mandatory manual browser verification step: promote the local admin to sole super_admin via psql, then attempt self-delete via UsersSection, and confirm the red toast fires with the verbatim refusal string and the row stays in the table. Main Claude's post-agent summary confirms this was NOT exercised (the dev's session lacked preview tools). This gate exists specifically to close the silent-fake-success regression that spec 032 was filed to fix — it is the one check that exercises the entire stack end-to-end (DB guard → HTTP 400 → callEdgeFunction parsing → deleteUser envelope → deleteProfile error branch → notifyBackendError → toast). Given that the spec's central motivation is the invisible-error UX, this manual gate should run before SHIP_READY rather than as a post-merge smoke item.

The jest tests already verify every layer in isolation (the HTTP 400 → verbatim error string path is tested by AC-T3 case 4, and the deleteProfile error branch is audited via code review of useStore.ts:797-799). The missing check is the full integrated path from a real local DB, through the edge function, to the UI toast. This is low-risk to defer post-merge IF the release-coordinator is comfortable with the individual-layer coverage, but the preferred position is pre-ship.

**`data` field is untestable via the current `deleteUser` surface**

The test file's own header comment acknowledges this correctly: because `callEdgeFunction` is module-private and `deleteUser` discards `data` and returns only `{ error }`, tests can only assert the error-side of the envelope. The 2xx data path is covered indirectly (test proves `error: null` on 2xx, which requires the helper to have executed the `response.ok` branch). The `data` shape itself is untested. This is an acceptable gap for spec 032 because no current caller reads `data` — but the gap should be noted here so a future spec that introduces a `data`-consuming caller knows to add direct `data` assertions. This does not block release.

**Architect count discrepancy in spec prose**

The architect design (§4, §8) states "total `it` count goes from 17 to 28." The actual prior count was 24 (not 17), so the actual result is 35. The discrepancy is in the spec's own prose — the implementation correctly adds 11 tests. The count divergence is a documentation artifact from a mid-spec state, not a defect in the implementation.

**`typecheck` (`npx tsc --noEmit`) exit code is 2**

Exit code 2 is caused entirely by the pre-existing `@types/* 2` TS2688 cruft that has been present since before spec 022. The spec verification section explicitly calls this out ("pre-existing `@types/* 2` cruft only"). No new type errors were introduced by spec 032. `npm run typecheck:test` (which uses `tsconfig.test.json`) exits 0.

**Fire-and-forget pattern documented, not just tested**

Both `inviteUser:242` and `registerInvitedUser:327` remain unawaited, consistent with the spec's explicit decision to keep fire-and-forget. The JSDoc on `callEdgeFunction` now contains the "Some callers intentionally fire-and-forget" call-out so a future reader does not mistake the missing `await` for a bug. This satisfies AC-C1, AC-C2, and the CLAUDE.md convention bullet together.

**Regression risk for hypothetical future callers**

The grep gate confirms zero additional raw-fetch call sites today. The CLAUDE.md convention bullet is in place as the forward-looking guard. No current risk.
