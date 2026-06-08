# Release proposal — spec 095 (username login)

Round: 2 (re-review after two fix passes — security Medium-1 rate limiter +
`auth.signIn.test.ts` typecheck:test blocker). Coordinator: release-coordinator.
Date: 2026-06-07. Supersedes the round-1 FIXES_NEEDED proposal.

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical; all five round-1 FIXES_NEEDED items are
confirmed closed, every acceptance criterion is PASS or NOT-TESTED (no FAIL), all
local gates are green, and login was verified end-to-end in a browser this round.

## Findings summary
- code-reviewer: 0 Critical / 2 Should-fix / 7 Nits. Top issues: (SF-1) misleading
  comment at `20260607130000_username_resolve_rate_limit.sql:143` (the
  `service_role` table-grant rationale reads as a broken sentence — the grant
  itself is correct, comment only); (SF-2) `username-resolve/index.ts:95` creates
  the service-role client INSIDE the request handler instead of module scope — the
  inline comment claims it is hoisted but it is not, so it instantiates per
  request (perf only, not a correctness or security bug). All 5 round-1
  FIXES_NEEDED items explicitly confirmed closed (typecheck:test fix, rate limiter,
  narrowed 23505 heuristic, documented secret, lowercase-on-input).
- security-auditor: 0 Critical / 0 High / 0 Medium / 5 Low. Prior Medium-1 (no
  rate limit on the bundle-public-token resolver) RESOLVED by the DB-backed
  fixed-window per-IP limiter (20 req/min/IP). Verified the 429 does NOT reopen
  the enumeration oracle (limiter keys on client IP only, never username; success
  path still ALWAYS `200 { email: string | null }`). New RPC SECURITY DEFINER /
  search_path / RLS posture all PASS; all 7 original anti-oracle checks re-confirmed
  PASS. Lows (none blocking): timing side-channel (residual, blunted by the cap),
  CORS `*` (no credentialed auth → not CSRF), the narrowed InviteUserDrawer
  heuristic (effectively closed), XFF-spoofable IP key (inherent to edge per-IP
  limiting), limiter fails-open on RPC error (correct availability tradeoff).
- test-engineer: 19 PASS / 0 FAIL / 4 NOT-TESTED across the acceptance criteria.
  Gates green: `npm run typecheck` (exit 0), `npm run typecheck:test` (exit 0 —
  the round-1 BLOCKING TS7022/TS7024 is resolved), jest 632/632 over 62 suites,
  pgTAP 46/46 via `scripts/test-db.sh`. NOT-TESTED (none new, none blocking):
  AC-L4 post-login role-branch (unchanged by this spec), AC-S3 LIKE-metacharacter
  escaping at runtime (smoke arms SKIP when token unset; one-line escape verified
  by code review), `registerInvitedUser` username-stamping at the TS mock layer
  (covered by pgTAP arm 16 + code review), `LoginScreen.tsx` rendering (no jest
  component test / no automated E2E — but verified manually in-browser this round).
- backend-architect: 0 Critical / 0 Should-fix / 4 Minor. Rate-limiter fix is
  endorsed as the correct boundary (DB-backed shared atomic counter over
  in-memory/KV, which cannot enforce a budget across stateless isolates), matches
  the `record_missed_orders_for_day` privileged-RPC convention, preserves the
  anti-oracle contract, and CLOSES the original design's mitigation-(3) gap
  (convergence, not drift). Minors: M1 prune retention (1h) vs cron cadence (daily)
  leaves a benign ~24h tail; M2 prune predicate has no `window_start` index (seq
  scan, trivial at this row count); M3 per-IP keying coarse-grains NAT'd locations
  (inherent); M4 `service_role` table DML grant is redundant-by-design (documented,
  do not "tidy" away).

## CI status on main
Per the CLAUDE.md post-push CI rule, the latest `test.yml` run on `main` must be
green before this slice can ship. The dispatch notes the prior EOD-vendor push to
`main` was green; this coordinator could not run `gh run list --branch main
--limit 1` in this turn, so step 1 below records re-verification as a pre-commit
gate. Nothing from spec 095 has been pushed to `main` yet, so the
latest-green-on-main precondition holds pending that re-check.

## Recommended next steps (ordered)

SHIP_READY.

1. Confirm the latest `test.yml` run on `main` is green before committing
   (`gh run list --branch main --limit 1`). If red or in-progress, surface the run
   URL and hold per CLAUDE.md. Pre-commit gate.
2. Commit and push the spec-095 slice (migrations + edge function + frontend +
   tests). Main Claude does not auto-commit; the user confirms the commit.
3. Execute the REQUIRED manual deploy steps — username login is BROKEN until all
   are done (email login is unaffected throughout):
   - `supabase secrets set USERNAME_RESOLVE_SERVICE_TOKEN=<token>` (server).
   - Set `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` to the SAME value in Vercel + EAS.
   - `supabase functions deploy username-resolve` (ships the resolver AND the
     newly-added rate-limit call).
   - `npx supabase db push --linked` (applies `20260607120000_profiles_username`
     and `20260607130000_username_resolve_rate_limit`; the
     `db-migrations-applied` gate will flag both until this runs).
4. After the push to `main` lands, re-confirm `test.yml` is green on `main`.

## Optional follow-ups (NOT blocking ship)

The user previously scoped this work to Blocker + Should-fix, deferring nits. The
two round-2 Should-fix items are both non-functional (a misleading comment and a
per-request client instantiation with no correctness/security impact). Listing
them plus the Lows/Minors/Nits as optional follow-ups; none gates the release.

- code-reviewer SF-1 — fix the broken/misleading comment at
  `20260607130000_username_resolve_rate_limit.sql:143` (grant is correct; only the
  prose is ambiguous).
- code-reviewer SF-2 — hoist `const admin = createClient(...)` in
  `username-resolve/index.ts` to module scope so it is reused across hot
  invocations, matching the `pwa-catalog` pattern and the code's own stated intent
  (perf only).
- security Low-4 — if the platform ever exposes a trustworthy gateway-stamped
  client-IP header, prefer it over the spoofable XFF first hop for the limiter key.
- architect M1/M2 — revisit prune cadence/retention and add a `window_start`
  index only if this table's traffic ever grows (not at current scale).
- code-reviewer nits — stale `AdminScreens.tsx:1604` comment reference in
  `InviteUserDrawer.tsx` (predates this spec); `delete` grant symmetry for the
  prune path; an `anon` arm in the RLS pgTAP; awareness-only smoke/RANDOM-IP nit.
- test gaps — add a `LoginScreen.tsx` component/E2E test, a `registerInvitedUser`
  username-payload assertion, an automated LIKE-metacharacter-escape arm, and a
  window-reset pgTAP arm; wire `smoke-username-resolve.sh` into
  `npm run test:smoke`. All currently covered indirectly (code review / pgTAP /
  the manual browser verification this round).

## Out of scope for this review
- The manual deploy steps (step 3 above) are a deploy-time action, not a code fix;
  track them in the PR description.
- Phone-number login, social/SSO login, username-based password reset, and
  self-service username changes — explicitly out of scope per the spec.
- Migrating `src/screens/staff/` auth code into `db.ts` — pre-existing spec-063
  carve-out.
- `app.json` slug change — load-bearing, untouched per CLAUDE.md.
- Future "user-editable username" work (self-UPDATE arm + uniqueness re-check) —
  flagged by the architect as a separate spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY — verify test.yml green on main, then commit + run the 4 manual deploy steps (USERNAME_RESOLVE_SERVICE_TOKEN / EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN / functions deploy / db push); username login is broken until done.
payload_paths:
  - specs/095-username-login/reviews/release-proposal.md
