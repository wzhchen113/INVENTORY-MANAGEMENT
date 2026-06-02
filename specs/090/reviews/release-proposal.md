# Release proposal — spec 090

## Verdict
verdict: SHIP_READY
rationale: Zero Criticals across all three reviewers, both code-reviewer Should-fixes already folded in and re-verified, and the latest `test.yml` on `main` is green — a tightly-scoped, fail-safe app-level write-path fix with no DB/RLS/edge/realtime change.

## Findings summary
- code-reviewer: 0 Critical / 2 Should-fix / 4 Nits. Both Should-fixes were comment-accuracy only and are RESOLVED in the "## Resolution (post-review fix-pass)" section: S1 — replaced the "user/manager" phrasing in the `auth.ts` derive-block and the `InviteUserDrawer.tsx` Spec-090 comment with "user (non-admin)" so the prose tracks the actual `'admin' | 'user'` type union; S2 — reworded the `InviteUserOptions.brandId` doc comment so it no longer implies a DB-side ("server-side") step (the derive is a client-initiated PostgREST `stores` read under the caller's session). Re-verified post-fix-pass: `npx tsc --noEmit` (base) exit 0; comment-only edits, so the jest 557 + test-graph-tsc baselines stand. The 4 Nits are cosmetic and deferred (test `mockStoreBrandRow: any` matching the reference `registerInvitedUser.test.ts`; comment-block length).
- security-auditor: 0 Critical / 0 High / 0 Medium / 0 Low — PASS. The new `stores.brand_id` PK read in `inviteUser` runs under the inviting caller's own session and is bounded by the existing `auth_can_see_store(id)` SELECT policy, so an unseen/crafted store id returns null → benign NULL-brand invite (fails SAFE); the derived brand is always the store's real brand (never a client-asserted one), the spec-068 `user_stores_brand_match` trigger backstops any cross-brand mismatch, and the whole flow stays gated server-side by `auth_is_privileged()` on the `invitations` INSERT. No secrets, no new grant, no role/`app_metadata` write, no PII in logs, `package.json` unchanged (`npm audit` correctly skipped).
- test-engineer: 7 PASS / 0 FAIL / 0 NOT-TESTED. AC-110 (user-with-store derives non-null brand), AC-122 (zero-store user stays NULL-brand, derive read NOT fired), AC-116 halves 1+2 (admin passthrough verbatim; admin missing-brand error + no INSERT) all PASS; backward-compat and the conditional pgTAP arm are correctly N/A (app-level only, no migration). Full run: 56 suites / 557 tests pass; `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` both exit 0. The headline derive test was confirmed non-vacuous (it would fail if the derive block or the `stores` read were removed). One acceptable noted gap: `InviteUserDrawer.test.tsx` does not assert the `brandId` argument passed to `inviteUser` at the component level — but the durable contract sits on the `inviteUser` derive (`auth.ts`), which is fully covered, so this is logged for future completeness, not a block.
- backend-architect (post-impl): NOT INVOKED — by design. Spec 090 is app-level frontend/auth-path only (no migration, no DB/RPC/contract/grant/policy change per the architect's open-question-C resolution), so there is no backend drift to review.

## Recommended next steps (ordered)
SHIP_READY:
1. Commit the unstaged work. The commit covers `src/lib/auth.ts`, `src/components/cmd/InviteUserDrawer.tsx`, `src/lib/inviteUser.test.ts`, and `specs/090/`. Suggested message: `Spec 090: derive invite brand from assigned store; stop NULL-brand user invites at source (SHIP_READY)`.
2. Push to `main`. NO migration / NO `db push` — this is app-level only; Vercel auto-deploys web on push to `main` (native via EAS as usual). The `db-migrations-applied` gate stays green because 090 adds no migration (prod is in sync).
3. After the push, confirm the next `test.yml` run on `main` is green (per the standing CI-status-check rule) before any further pipeline work.
4. (Preventive, no data step.) This change only stops NEW NULL-brand invitations from being created; existing rows were already backfilled by specs 069/083, so no data migration is needed. The zero-store user invite intentionally still lands NULL-brand and is stamped at register time once a store is assigned (spec 069's durable fallback).

## Out of scope for this review
- The 4 deferred code-reviewer Nits (cosmetic): typing the test's `mockStoreBrandRow` as `{ brand_id: string } | null` instead of `any`, and trimming the inline comment blocks. Non-blocking follow-ups; address opportunistically.
- The drawer-level `brandId`-argument assertion gap noted by test-engineer — a future coverage-completeness add, not required because the `inviteUser` durable-contract layer is fully covered.
- A DB-level guarantee (a `profiles`/`invitations` trigger forbidding a NULL-brand `role='user'` invite WITH stores). Explicitly rejected for this spec by the architect (open question C — it would require a trigger, a migration, a backfill-completeness pre-flight, and pgTAP); it remains a deliberately separable hardening for a future spec, with the 069 register-time `resolved_brand_id` stamp as the durable safety net in the meantime.
- The spec 083/084 read-side relaxations and the 069/083 backfills — landed and correct; this spec is purely the write-side source and does not re-touch them (per the spec's "Out of scope").

---

Summary: Spec 090 closes the NULL-brand-invitation bug class at its source by deriving the brand from the first assigned store in both the `InviteUserDrawer` call site (primary) and `inviteUser` itself (defense-in-depth), while preserving the legitimate zero-store NULL-brand case and leaving the admin path untouched. All three reviewers came back clean of Criticals — security-auditor is a full PASS (the new `stores` read is RLS-bounded and fails safe), test-engineer is 7/7 ACs with a non-vacuous headline test, and code-reviewer's only two Should-fixes were comment-accuracy items already folded in and re-verified (base tsc exit 0, behavior-neutral). The latest `test.yml` on `main` is green and 090 adds no migration, so both CI gates stay green. Every SHIP_READY hard rule is satisfied: no Critical from any reviewer, no unresolved Should-fix, and a green main `test.yml`. Recommend committing, pushing (web auto-deploys via Vercel; no `db push`), and confirming the post-push CI run is green.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 090. 0 Criticals across all three reviewers (security PASS, test 7/7 ACs, code-review's 2 Should-fixes resolved comment-only), main test.yml green, no migration. Commit + push (Vercel auto-deploys web, no db push), then confirm the post-push test.yml run is green. User decides the commit.
payload_paths:
  - specs/090/reviews/release-proposal.md
