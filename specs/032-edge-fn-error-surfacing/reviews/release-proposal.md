## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all three reviewers; the two Should-fix items are test-structure polish (describe name string, untestable-via-deleteUser 2xx `data` gap) that do not affect runtime correctness, and the manual browser smoke originally specified is unreachable through the UI after specs 030/031 stripped the relevant DELETE affordance.

## Findings summary
- code-reviewer: 0 Critical, 2 Should-fix, 4 Nits. Top issues: (1) `describe` block named `'callEdgeFunction (via deleteUser)'` instead of the spec-mandated verbatim `'callEdgeFunction'` (`src/lib/auth.test.ts:61`); (2) 2xx test cases assert only `{ error: null }` and not the `data` field, because `callEdgeFunction` is module-private and `deleteUser` discards `data` — a 2xx-success regression that returned `{ data: null, error: null }` instead of `{ data: <body>, error: null }` would not be caught by current tests. Nits cover redundant optional-chain on `any`-typed catch param, "502" body text paired with a 500 status mock (cosmetic), structural coupling of indirect-access tests to `deleteUser`, and an `any` annotation that is consistent with the architect's rationale.
- security-auditor: 0 Critical, 0 High, 0 Medium, 3 Low (all informational, no remediation required). Edge-function `(e as Error).message` strings now reach an admin's toast where they were previously swallowed, but the audience is privileged admin-only (session check short-circuits before fetch), no stack traces, no cross-tenant data. Toast rendering surface confirmed text-only (`<Toast />` mounted with library defaults, zero `dangerouslySetInnerHTML` / `RenderHtml` hits across `src/`); `escapeHtml` convention does not apply. No package.json delta, so no `npm audit` evaluation needed. Verdict: "Safe to ship."
- test-engineer: 27 PASS, 0 FAIL, 3 NOT TESTED. All 11 jest cases (Helper contract H1-H8, Caller chain C1-C10, Jest coverage T1-T5) pass; spec 031 retroactive correction confirmed; cross-cutting gates V1-V3 green. The 3 NOT TESTED items are AC-V4 (`test:db` sanity gate, no DB changes), AC-V5 (`test:smoke` sanity gate, no smoke changes) — both verified in the spec's Verification section as PASS in the prior run — and AC-V6 (the manual browser self-delete gate, see Recommendation below). Test-engineer flags one documentation nit: architect prose says "17 → 28" but actual was "24 → 35" (mid-spec state drift, not an implementation defect).
- backend-architect: Not invoked. Spec 032 is pure client-side TypeScript with no migrations, no edge-function source changes, no realtime publication touches, no contract changes. The architect's design (§7) explicitly omits this dimension. No drift surface to audit.

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Commit and deploy.** Stage the four touched files (`src/lib/auth.ts`, `src/lib/auth.test.ts`, `CLAUDE.md`, `specs/031-last-super-admin-guard/spec.md`) plus the new `src/lib/auth.test.ts` and the spec 032 files; user runs the commit. Vercel auto-deploys from `main`. No `supabase functions deploy`, no `supabase db push`, no manual deploy step.

2. **Recommendation on the manual browser gate (AC-V6).** Ship without re-running the originally-described self-delete browser smoke. Rationale: spec 030 hid the DELETE button on the self-row; spec 031 hid it on any last-of-role row. The operator literally cannot click DELETE to reach the "cannot delete the last super_admin" toast on their own account through the UI — the affordance is gone before the toast can fire. The spec 032 envelope correctness is already pinned by:
   - 11 jest cases covering all 7 response-shape branches (cases 1-11 in `src/lib/auth.test.ts`),
   - Static code review confirming the implementation matches the architect's §2 walk-through,
   - Caller-chain audit (AC-C1 through AC-C10) confirming `deleteUser` correctly consumes the new envelope and `deleteProfile` short-circuits before optimistic mutation.

   If end-to-end confidence is desired before merge, an alternative smoke is to disable network (devtools "Offline" toggle), attempt a user-management action that goes through `callEdgeFunction` (e.g. invite a fresh user), and confirm a "Network error" or "Failed to fetch" toast fires instead of a fake-success — this exercises the same parsing path with an observable failure mode. This is a substitute, not a blocker.

3. **Fast-follow items (non-blocking, file in a future cleanup spec).**
   - Code-reviewer Should-fix #1: rename `describe` to `'callEdgeFunction'` verbatim (5-minute touch at `src/lib/auth.test.ts:61`). Moves the "via deleteUser" indirection note to a comment above the block.
   - Code-reviewer Should-fix #2: pin the 2xx `data` field via either an `@internal` test-only export of `callEdgeFunction` or a tiny exported wrapper. Currently the 2xx `data` shape is untested because `deleteUser` discards it. Pick (a) or (b) from the code-reviewer's options; (c) "accept and document" is the de-facto current state.
   - Code-reviewer Nit #1: drop the redundant `?.` on `e?.message` in the `catch (e: any)` block (`src/lib/auth.ts:147`) for consistency.
   - Code-reviewer Nit #2: change the mock body string at `src/lib/auth.test.ts:163` from `'upstream nginx 502 error page'` to something that doesn't embed "502" while the status is 500, or add a clarifying comment.
   - Code-reviewer Nit #3 (structural): document the indirect-access coupling in a header comment so a future `deleteUser` refactor doesn't silently break the coverage.
   - Code-reviewer Nit #4: already a non-action (the `any` is intentional per architect rationale).
   - Security Low #1: consider a follow-up edge-function pass that maps `(e as Error).message` in catch-all handlers to a generic "Internal server error" with `console.error(e)` for server-side observability, so the toast surface doesn't leak raw Postgres / Deno error strings. Out-of-scope for this spec; flagged for awareness.
   - Security Lows #2, #3: informational only, no action.
   - Test-engineer documentation nit: the spec prose's "17 → 28" line should be reconciled to "24 → 35" if anyone revisits the spec text; not load-bearing.

## Out of scope for this review
- **Edge-function leak-message hygiene.** Security-auditor Low #1 flags `(e as Error).message` forwarding in `delete-user`, `send-invite-email`, `send-welcome-email` catch-alls. This pre-existed spec 032 and lives in the edge functions; spec 032 only changes the client-side parser. A separate spec can map these to generic "Internal server error" with `console.error` for server-side observability.
- **`useStore.test.ts` jest harness.** Spec 029 / 031 deferred. Still deferred.
- **`canDelete` / `canResetPassword` pure-helper extraction.** Spec 029 deferred. Still deferred.
- **Generic type parameter on `callEdgeFunction<T>(...)`.** Resolved in spec 032 §"Open questions" as "not in v1." A future caller that needs typed `data` adds the generic at that point.
- **Retry / backoff logic, error-object types (string → Error), refactoring fire-and-forget callers to await + console.warn.** All explicitly out of scope per spec §"Out of scope (explicitly)".
- **`fetchBreadbotSales` refactor.** Already uses `supabase.functions.invoke` — the "right" shape that `callEdgeFunction` is now aligning toward. No change.
- **Smoke arm tightening.** Per the architect's §10, the existing smoke Arm 6 covers the server-side surface; jest now covers the client-side parser. Two layers, two test surfaces, no need to overlap.

## Handoff
next_agent: NONE
prompt: SHIP_READY (0 Critical, 0 High, 0 Medium across 3 reviewers; 2 Should-fix items are test-structure polish, fast-follow; manual browser smoke is unreachable post-030/031 affordance-stripping, recommend ship without it or substitute a "disable network → toast" smoke).
payload_paths:
  - specs/032-edge-fn-error-surfacing/reviews/release-proposal.md
