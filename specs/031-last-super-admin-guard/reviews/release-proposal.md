## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; the two Should-fix items are pre-existing or comment-clarity, neither introduced by spec 031, and the design contract held end-to-end with all 31 automatable acceptance criteria passing.

## Findings summary
- code-reviewer: 0 Critical, **2 Should-fix**, 3 Nits.
  - S1 (pre-existing, NOT introduced by 031): `src/lib/auth.ts:109-127` `callEdgeFunction` uses bare `await fetch(...)` with no `response.ok` check and a blanket catch that swallows non-2xx — every HTTP 400 from `delete-user` (including spec 028's escape path and the existing self-delete refusal) resolves as success client-side; the spec's §9 misstates the toast behavior. Affects every edge-function call site (deleteUser, inviteUser, etc.).
  - S2: `supabase/tests/delete_last_privileged_guard.test.sql:38-41` plan(4) comment understates why this differs from the sibling pattern (which uses an `isnt(...)` 4th plan arm); comment-clarity only.
  - Nits: dead `else` arm in migration `case` block (matches architect's N1), missing one-line PGRST116 carve-out comment in edge fn, unreachable `lastOfRole` clauses for non-master callers in `UsersSection`.
- security-auditor: 0 Critical, 0 High, 0 Medium, **3 Low** (all spec-acknowledged trade-offs):
  - TOCTOU window between count + delete (spec §14 rates Negligible; concurrent privileged operators only).
  - Smoke Arm 6 accepts either refusal string because self-delete fires first (pgTAP carries the load-bearing assertion for the new helper path).
  - Helper grant to `authenticated` allows binary probing of last-of-role state (spec §14 Low; info leak is non-secret).
  - SECURITY DEFINER hygiene clean. Edge function ordering correct. Bypass surface bounded. No console / log leakage. No new env vars. No realtime publication change.
- test-engineer: **31 PASS / 0 FAIL, 1 manual-only (AC-X6 pre-deploy gate)**.
  - 8/8 server-side ACs, 6/6 client-side ACs, 6/6 pgTAP ACs, 10/10 smoke ACs, 3/3 convention-doc ACs, 5/5 cross-cutting gates PASS.
  - Pre-verified by dev: `npx tsc --noEmit` clean, `npm run typecheck:test` clean, `npm test -- --ci` 24/24 PASS, `npm run test:db` 15/15 PASS (new test included), `bash scripts/smoke-edge-roles.sh` 6/6 arms PASS, `npm run test:smoke` PASS.
  - Notes (informational): master-role last-of-role has no smoke arm (only pgTAP arm (i) covers it); Arm 6 SKIPs when operator pre-supplies `SUPER_ADMIN_BEARER`; `stable` annotation on a function that raises is a style nit.
- backend-architect: 0 Critical, 0 Should-fix, **1 Nit (N1)** — defensive `else` arm in the SQL `case` block is unreachable (same as code-reviewer's first nit; harmless dead code). Both dev divergences (plan(4) sans fixture-sanity assertion; `id <> target_user_id, count = 0` count predicate vs spec's `count <= 1`) confirmed logically equivalent and within the design's accepted range. Out-of-scope files (`src/lib/db.ts`, `src/store/useStore.ts`, realtime publication, `config.toml`) untouched per grep.

## Recommended next steps (ordered)

If SHIP_READY:

1. **Pre-deploy manual gate (AC-X6)** — REQUIRED before production deploy:
   - Log in as the seed admin and run the same promotion dance Arm 4 uses to mint the sole super_admin (`admin@local.test` promoted via psql).
   - Open `UsersSection` in Cmd UI; verify the DELETE button is absent on that super_admin row.
   - Curl `delete-user` directly with the super_admin's own userId and bearer; confirm HTTP 400 with `{"error":"cannot delete the last super_admin"}` (or `"cannot delete self"` — either is per-spec correct because self-delete fires first).

2. **Two-step production deploy — STRICT ORDER (reversing → HTTP 500 on every privileged delete; fail-closed but disruptive):**
   1. `npx supabase db push --project-ref ebwnovzzkwhsdxkpyjka` (migration MUST land first so the function exists when the edge function RPCs it).
   2. `npx supabase functions deploy delete-user --project-ref ebwnovzzkwhsdxkpyjka`.
   - Verify step 1 with: `select prokind, proname from pg_proc where proname = 'assert_not_last_of_role';` (expect one row, `f` / `assert_not_last_of_role`).
   - No CI gate enforces this order — per CLAUDE.md, `db-migrations-applied.yml` is NOT on disk.

3. **Commit and deploy** — user confirms the commit; main Claude does not auto-commit. Staged files per `git status`:
   - `supabase/migrations/20260514160000_assert_not_last_of_role.sql` (new)
   - `supabase/tests/delete_last_privileged_guard.test.sql` (new)
   - `supabase/functions/delete-user/index.ts` (modified)
   - `src/screens/cmd/sections/UsersSection.tsx` (modified)
   - `scripts/smoke-edge-roles.sh` (modified)
   - `CLAUDE.md` (modified — additive bullet)
   - `.claude/agents/security-auditor.md` (modified — additive bullet)

4. **Fast-follow (own spec, NOT blocking 031 ship): `callEdgeFunction` silent-success on non-2xx (code-reviewer S1).**
   - File: `src/lib/auth.ts:109-127`.
   - Symptom: HTTP 400 from any edge function resolves as `{ error: null }` in `deleteUser` / `inviteUser` / etc.; success toast fires; local cache updates; row reappears on next refresh.
   - Affected call sites: every `callEdgeFunction` consumer (deleteUser, inviteUser, others).
   - Pre-dates spec 031 (the existing self-delete 400 has the same silent path). Spec 031's §9 claim that "the new HTTP 400 will surface as a toast via `notifyBackendError`" is incorrect in current production.
   - Recommended fix shape: add a `response.ok` check in `callEdgeFunction` that parses the JSON body and throws with the parsed `error` field, so destructive calls (`deleteUser`, `inviteUser`) surface server refusals as toasts. Optionally add a dedicated `callEdgeFunctionChecked` variant for destructive ops to avoid changing behavior for non-destructive callers.
   - Worth its own spec (032 candidate). Severity: Should-fix. Surface area is broader than spec 031 — this affects the UX contract for every privileged edge-function refusal.

5. **Optional follow-up nits (not blocking, addressable in a cleanup spec):**
   - Remove the dead `else` arm in `assert_not_last_of_role` (`...migration:71`) OR replace with `ASSERT false, 'unreachable';` (code-reviewer + architect both flagged).
   - Add the one-line `// .maybeSingle() returns data=null, error=null for zero rows — no PGRST116 guard needed` comment in `delete-user/index.ts:84-89`.
   - Add the parenthetical "(effective only when isMaster; non-master callers already exclude super_admin/master rows via the base predicate)" near `UsersSection.tsx:280-283`.
   - Tighten the pgTAP plan(4) comment to explicitly state "Because the UUIDs are compile-time literals, not runtime lookups, there is no drift risk and no sanity arm is needed."
   - Consider `volatile` over `stable` on `assert_not_last_of_role` (test-engineer style nit).

## Out of scope for this review

- **Role-demotion guard (edit role, not delete).** A master demoting the only super_admin via a role-edit picker is the same foot-gun shape but a different code path (role-mutation, not `delete-user`). Spec 031 explicitly defers; filed for a follow-up spec.
- **Brand-scope "last master in brand X" semantics.** Spec 031 v1 covers the global predicate only; deferred.
- **Cascade on brand deletion if that brand's last master is also globally last.** `delete-brand` is a separate surface and audit.
- **"Replace before delete" UX flow.** Deferred polish.
- **Tooltip / disabled-button affordance on hidden DELETE.** Spec 031 ships button-absent; tooltip is a future UX pass.
- **TOCTOU hardening via transactional wrapper RPC.** Security-auditor Low; spec §14 rates Negligible. Optional follow-up; not v1.
- **Restrict `assert_not_last_of_role` GRANT to `service_role` only with an admin-only wrapper.** Security-auditor Low; adds complexity, not recommended for v1.
- **Smoke arm targeting a different user's last-of-role row** (to exercise the new helper path end-to-end without self-delete collision). Out of scope per spec.
- **`useStore.test.ts` jest harness.** Spec 029 deferred follow-up; remains deferred.
- **Symmetric guard on the role-edit code path (`updateProfile` / role mutation).** Spec 031 explicitly defers; follow-up spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY. 0 Critical across all four reviewers. 2 Should-fix items: S1 is a pre-existing client-layer silent-success on non-2xx in `src/lib/auth.ts callEdgeFunction` (affects all edge-function call sites; recommend dedicated follow-up spec 032); S2 is pgTAP comment clarity. Two-step deploy strictly ordered (db push → functions deploy) and the AC-X6 manual pre-deploy login + curl gate are required before production rollout.
payload_paths:
  - specs/031-last-super-admin-guard/reviews/release-proposal.md
