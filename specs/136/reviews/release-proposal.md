# Release proposal — spec 136 (notification toggle cross-instance sync)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged any Critical, both CI gates are green at the base commit, all 7 acceptance criteria pass except AC4 which is architecturally excluded from automation and needs only a one-time manual device check.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 2 Nits. Should-fix: the new test has zero JSX, so rename `src/lib/useNotificationToggle.test.tsx` → `.test.ts` and revert both `jest.config.js` `testMatch` hunks — the pre-existing `src/lib/**/*.test.ts` glob would then match with no shared-infra touch and no redundant double-run. Nits: repeated invariant comments in the hook; hand-rolled `renderHook` pair could use a local helper. All verification detail (registration ordering, identity-based self-exclusion, message-preserving `refresh(false)`, dependency arrays, no new `supabase.from/rpc`) checked out clean.
- security-auditor: 0 findings at every severity. No new DB call sites, no secret handling, no data carried through the zero-arg broadcast (no cross-user/tenant leakage possible), no listener leak (cleanup always `delete`s before any early-return), jest glob does not over-capture. Frontend-only in-process UI sync — nothing blocks, nothing to fix before deploy.
- test-engineer: AC1/AC2/AC3/AC6/AC7 PASS via automated jest (verified `--listTests` in both projects + verbose 6/6 green); AC5 PASS by inspection (comment fix). AC4 (real-PWA manual repro of the owner's banner/gear-dot staleness) NOT TESTED and not manually verified post-fix — justified by the architect's §2 scope ruling (a Playwright repro needs a real service-worker push subscription the E2E suite excludes), and the underlying mechanism is covered by the AC1–AC3 unit tests, but the literal on-device observation is unconfirmed. Non-blocking gap: no dedicated unmount-cleanup regression test (would not catch a future dropped `.delete(reprobe)`). Full suite: 129 suites / 1369 tests, exit 0. Agrees with code-reviewer's Should-fix severity on the `.tsx` rename.
- backend-architect (post-impl): not separately filed for this frontend-only spec; the `## Backend design` in the spec explicitly records data-model / RLS / API-contract / edge-function / realtime / `db.ts` as N/A, and code-reviewer + security-auditor + test-engineer all independently confirmed zero backend surface (no `supabase`/`.from(`/`.rpc(` in the four changed files). No contract drift.

CI gate status: latest runs of both `test.yml` and `db-migrations-applied.yml` on `main` were green as of base commit `ec7346b`; this spec's work is uncommitted on top of that and is frontend-only (no migration), so the `db-migrations-applied` gate is unaffected.

## Recommended next steps (ordered)
1. Perform the one manual AC4 device check before or immediately after deploy: on the installed staff PWA, enable notifications in Settings `NotificationSwitcher`, navigate back to EODCount, confirm NO red reminder banner and a GREEN `SettingsGear` dot with no background/reopen/refresh. This is the owner's original live-prod complaint and the only AC with no automated coverage — cheap to confirm on-device and worth doing given the reported-in-prod origin. (Advisory, not a merge blocker; the shared mechanism is unit-tested.)
2. Commit and deploy (user confirms the commit; main Claude does not auto-commit on SHIP_READY).
3. Follow-up (non-blocking, Should-fix): rename `src/lib/useNotificationToggle.test.tsx` → `useNotificationToggle.test.ts` and revert both `jest.config.js` `testMatch` hunks. Smaller diff, stays in the established two-glob pattern, drops the genuinely redundant `component`-project double-run without losing the node-env registration-ordering coverage (which is inherent to the `unit` project, not the `.tsx` extension). code-reviewer and test-engineer concur on scope and severity.
4. Follow-up (non-blocking, test gap): add a registry-cleanup regression test — unmount one instance mid-test, then trigger an action on the remaining instance and assert no stale-setState warning / correct registry size — to durably guard the load-bearing `reprobeListeners.delete(reprobe)` cleanup that is currently backed only by code inspection.
5. Follow-up (Nits, optional): de-duplicate the repeated acting-vs-other invariant comments in the hook; extract a `mountPair()` helper in the test.

## Out of scope for this review
- Decoupled navigation-focus re-probe (belt-and-suspenders) — the architect ruled it OUT (§3) because the mount effect already self-probes late-mounting instances; belongs in a separate spec only if a concrete residual gap appears.
- Migrating the `src/screens/staff/` subtree or this hook into `db.ts` — pre-existing documented carve-out, not this spec.
- Automated E2E/Playwright coverage for the real service-worker push flow — the E2E suite explicitly excludes the native/push surface; would require a separate infrastructure spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/136/reviews/release-proposal.md
