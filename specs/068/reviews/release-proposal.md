# Release proposal — Spec 068 (Invite-user store list brand-scoping)

Coordinator: release-coordinator
Date: 2026-05-28
Inputs read (verbatim): `code-reviewer.md`, `security-auditor.md`, `test-engineer.md`,
`backend-architect.md` in `specs/068/reviews/`, plus the spec `specs/068-invite-store-list-brand-scope.md`.

## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; the security-critical NULL-brand cross-brand write hole is genuinely closed at the DB layer and the three remaining Should-fix items are low-severity polish.

## Findings summary

- **code-reviewer**: 0 Critical, 3 Should-fix, 4 Nits. All three Should-fix are low-severity polish, none blocking:
  1. `userPermissions.test.ts:258` — `toEqual(['reisters','towson'])` encodes an `Array.filter` input-order dependency; fragile to a future `ALL_STORES` reorder. Fix: `.sort()` both sides or comment the dependency.
  2. `InviteUserDrawer.tsx:403-404` — the `· N of M selected` counter renders `· 0 of 0 selected` alongside the no-brand notice; uninformative noise. Fix: hide the counter when `!brandId`.
  3. `InviteUserDrawer.tsx:107` — the `eslint-disable exhaustive-deps` comment ("Keyed on brandId, not brandStores") doesn't cross-reference the `useMemo` that guarantees `brandStores` identity tracks `brandId`. Fix: add the cross-ref comment so a future `useMemo` edit doesn't silently break prune granularity.
  Nits (4): describe-block metadata duplication, hardcoded fixture UUIDs (consistent with sibling test, not new), `EXISTS`-vs-`select limit 1` idiom + inline comment, and a confirmed-clean `useStore` mock pattern.

- **security-auditor**: 0 Critical, 0 High, 2 Medium (both explicitly informational — no fix needed), 4 Low (all confirmations / no-action). This was the security-critical review. Key results:
  - **The cross-brand write hole is genuinely closed at the DB layer.** The trigger `before insert or update on public.user_stores` fires on BOTH INSERT and UPDATE, for EVERY writer including `service_role` and direct `psql` (SECURITY DEFINER changes execution identity, not whether the trigger fires). An insert-clean-then-UPDATE-to-foreign-brand bypass is rejected because the conflict lookup excludes the target store_id and still sees the pre-image.
  - **RLS + trigger are complementary, neither is dead weight.** A brand-A admin assigning a brand-B store is stopped by RLS (`auth_can_see_brand(B)` fails the WITH CHECK); the orthogonal cross-brand-SPAN invariant (no single user across >1 brand, incl. the NULL-brand staff case) is stopped by the trigger.
  - Medium #1 (NULL-branch correctness is "consistency among siblings", order-independent) and Medium #2 (raise interpolates brand UUIDs — not PII/secrets, consistent with the existing non-NULL arm) are recorded for completeness, no fix.
  - Low items confirm: partial-insert-then-block on the non-transactional register loop is a UX wart not a vuln (invariant preserved by construction); super_admin NULL-brand residual is a theoretical narrowing that removes access (never grants); the absent client brand pre-check is by design (trigger is authoritative).
  - **Verdict: "no Critical, no High… the spec may advance."**

- **test-engineer**: 0 Critical. 8/8 acceptance criteria PASS with two annotations: AC6 (cleanup-migration branch) NOT ENGAGED — correct, since prod has zero cross-brand rows; AC9 PARTIAL — Cmd+S/Esc keyboard handlers NOT TESTED. The keyboard handler is pre-existing (since spec-029), untouched by 068, and flagged "conditional" in the spec's own §12.1 — a pre-existing coverage gap inherited, not a hole introduced here. Mutation test confirmed: reverting the NULL-brand trigger branch fails exactly pgTAP arm (5) and nothing else, proving the arm is load-bearing. Numbers: 330/330 jest, 36/36 pgTAP (+1 new file, 7 assertions), both typechecks clean. **Explicit SHIP_READY.**

- **backend-architect** (post-impl drift): 0 findings — Critical 0, Should-fix 0, Minor 0. All 7 drift points match the design appendix: §2 InviteUserDrawer filter (all three consumers + handleSave join switched off the global array), §3 `deriveAccessibleStores` predicate (super_admin-first branch order correct), §4 trigger (non-NULL path byte-for-byte identical to the original, NULL-branch at-most-one-brand rule with the idempotent-UPDATE store_id exclusion, P0001/security-definer/search_path preserved, binding re-created idempotently), the three pgTAP harness deviations (7 arms, fresh in-txn admin fixture, SQLSTATE-only `throws_ok`) all justified within-design, no data-cleanup migration (correct), scope clean (no `db.ts`/`auth.ts`/RLS/`app.json` drift). **Explicit SHIP_READY.** Carries forward the non-transactional register-loop note as a documented follow-up (agreeing with security-auditor), not a finding.

### What this fix was (for the record)
Two parts. (1) A **UI brand-filter** display bug — Bobby's chips and the invite STORES list rendered the global all-brands `stores` array instead of brand-scoped stores. (2) A **real-but-unexploited DB write hole** — `user_stores_brand_match()` skipped its cross-brand check for NULL-brand users, which is exactly the state the `role='user'` invite→register path produces. Security-auditor confirmed part (2) is now closed at the DB layer, with RLS as a complementary layer.

### Browser-smoke limitation (recorded honestly)
The cross-brand filter could NOT be visually smoke-tested locally: the local seed carries only the 2AM brand (no Baltimore Seafood store to filter out), so the filter is "correct but invisible" locally. The jest component tests encode the multi-brand scenario explicitly — Bobby's admin/2AM 4-of-5 case in `userPermissions.test.ts` and the Baltimore single-store context in `InviteUserDrawer.test.tsx`. The definitive visual check would be prod, which requires the Chrome-extension pairing that did not connect this session. This is a verification-coverage note, not a defect — the DB-layer guarantee (the security-load-bearing half) is fully proven by pgTAP + mutation test, and prod queries confirmed zero existing cross-brand rows.

## Recommended next steps (ordered)

SHIP_READY — no blocking fixes. Suggested order:

1. **(Optional, pre-commit) Fold in the 3 code-reviewer Should-fix items.** All three are trivial (~3 one-line edits): `.sort()` the order-fragile assertion at `userPermissions.test.ts:258`; hide the `0 of 0` counter when `!brandId` at `InviteUserDrawer.tsx:403-404`; add the `useMemo` cross-reference comment at `InviteUserDrawer.tsx:107`. None changes behavior or the security posture; folding them in now is cheap and avoids a follow-up. Defer to a polish pass only if you'd rather not re-touch the file before commit — neither path blocks ship.
2. **Commit + push to `main`.** (Per project rule, main Claude does not auto-commit; the user confirms.)
3. **Apply the trigger migration to prod via `npx supabase db push`.** Preventive: prod has zero bad rows today (main Claude's prod queries — §0), so this is not a data repair, but it closes the reachable NULL-brand write hole that motivated the spec. There is no `db-migrations-applied` CI gate (CLAUDE.md), so this is a manual step. The migration is additive `create or replace function` + idempotent trigger re-bind; no down-migration, no publication change, no realtime container restart.

## Out of scope for this review

- **Non-transactional `registerInvitedUser` row-by-row insert loop** (`auth.ts:382-384`). Both security-auditor (Low) and backend-architect flagged that a direct-API caller spanning two brands would write grant #1 then have grant #2 rejected — a partial insert. Both assessed it as acceptable for this spec (the invariant holds; the rejected row is the conflicting one; the UI filter prevents legitimate clients from assembling such input). A future hardening spec could move the fan-out into a single SECURITY DEFINER RPC for all-or-nothing semantics. Explicitly NOT in 068's blast radius per design §4.
- **Cmd+S / Esc keyboard-handler test coverage** (`InviteUserDrawer.tsx`). Pre-existing gap since spec-029, untouched by 068; jsdom can synthesize `keydown` if a future spec wants to close it.
- **Pinning pgTAP fixture UUIDs to the seed via subquery** (code-reviewer nit). Consistent with the sibling `auth_can_see_store_brand_scope.test.sql`; a repo-wide fixture-hardening follow-up, not this spec.
