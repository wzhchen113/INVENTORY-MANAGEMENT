# Release proposal — spec 080 (un-deferred): E2E dashboard attention-queue weekly-window guard (FULL)

## Verdict
verdict: SHIP_READY
rationale: Both reviewers clear — code-reviewer 0 Critical (the lone Should-fix already fixed in the post-review pass), test-engineer PASS on 11/11 ACs with a load-bearing anti-vacuous audit; no Critical anywhere, no migration/RPC/RLS/contract surface, and the prior-spec gates (`test.yml` + `e2e.yml`) were green on main at spec 081.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix (FIXED), 5 Nits (deferred, all cosmetic).
  - Should-fix (FIXED in post-review pass): `outWindowISO = isoDateRange(beforeMonday, mondayStart)[0]` was an unguarded `[0]` access. An empty array would have set `outWindowISO = undefined`, producing a `${undefined}` testID that never matches — making the out-of-window absence assertion `toHaveCount(0)` pass **vacuously**. The fix replaces the bare `[0]` with a guard that throws loud if the range doesn't yield exactly 1 ISO, matching the `beforeAll` loud-failure posture. Re-verified: e2e tsc exit 0; spec still passes; fixture log confirms the date math.
  - 5 Nits deferred (no correctness/determinism impact): the `inWindowISO as string` cast (safe under the `!isMonday` guard), the collection-vs-execution comment wording, a teardown success-log asymmetry between the Towson and dedicated-store blocks, the non-v4 sentinel-UUID comment, and the README "un-blocked by 081" phrasing.

- **security-auditor**: NOT INVOKED — and correctly not invoked. The fixture is the established local-stack `serviceRoleClient()` pattern already cleared on specs 078/079/081; the created store is local-only and torn down store-scoped (FK-ordered, idempotent, keyed on a non-anchor UUID); the 2 net-new `testID`s are inert leaf attributes (no behavior/layout/conditional change). No new secret, no new auth surface, no service-role *read* assertion (UI-only per AC-080-Q6). No security surface to audit.

- **test-engineer**: PASS — 11/11 ACs. Anti-vacuous audit confirms BOTH FULL assertions are load-bearing:
  - In-window presence (`toBeVisible`) is exact-match by construction (`vendorKey === SEED.vendorUsFoodId`); it fails if 081 per-store sourcing regresses, if the `pastISOsInWindow` filter drops the in-window date, or if the fixture insert fails silently.
  - Out-of-window absence (`toHaveCount(0)`) is genuine — `outWindowISO` is the prior Sunday, a date the `unconfirmed_po` rule WOULD emit absent the window filter (a scheduled weekday with no PO), so its absence proves the spec-074 Monday boundary, not "no data."
  - Determinism verified across all 7 weekdays: Monday is a positive windowed-empty assertion (`toHaveCount(0)` on all `attention-row-{dedId}:po:*`), **not** a `test.skip()`; the out-of-window date is always the prior Sunday; the in-window date (Mon–Sat) never collides with it on the `(store, day_of_week, vendor)` unique key.
  - Cross-track isolation confirmed: pgTAP run **immediately after** e2e = 38/38, with the four `missed_order_audit_rpc` anchor stores (Towson/Frederick/Charles/Reisters) undisturbed — the exact local cross-track scenario the store-scoped teardown protects.

- **backend-architect (post-impl)**: NOT INVOKED — and correctly not invoked. This spec consumes the already-shipped spec-081 cross-store helpers (`fetchOrderScheduleForStores` / `fetchOrderSubmissionsForStores`) verbatim; it adds NO `db.ts` helper, RPC, view, migration, RLS policy, or edge function. There is no contract to review for drift. The fan-out (code-reviewer + test-engineer only) is proportionate to a test-coverage spec whose entire `src/` footprint is two inert `testID` attributes.

## Recommended next steps (ordered)

SHIP_READY:

1. **Commit and push to `main`** — the commit is the user's to authorize (main Claude does not auto-commit on SHIP_READY). Both halves are staged: the backend/e2e half (`e2e/dashboard-window.spec.ts` NEW, `e2e/global-teardown.ts` EXTENDED, `e2e/fixtures/constants.ts` EXTENDED, `tests/README.md` Track-4 note) and the disjoint frontend/testID half (two one-line attributes in `src/screens/cmd/sections/DashboardSection.tsx`).

2. **No migration / no DB surface to apply.** NO migration, NO RPC, NO RLS policy, NO `db.ts` change, NO edge function, NO `useStore.ts` change. The CLAUDE.md realtime-publication gotcha (`docker restart supabase_realtime_imr-inventory`) is N/A — no publication-membership change. The `db-migrations-applied.yml` drift gate has nothing new to reconcile.

3. **Watch the `e2e.yml` run after push (AC-080-GREEN).** `dashboard-window.spec.ts` runs in `e2e.yml` for the **FIRST time** on this push. `e2e.yml` is a proven-green workflow (3 prior green runs), but this is a brand-new SPEC within it, so confirm the post-push `e2e.yml` run on `main` is green per the CLAUDE.md "CI status check after every push to `main`" rule. **Monday-branch caveat:** if a future CI run lands on a Monday, the spec asserts the windowed-empty state (`toHaveCount(0)` on the dedicated card's `unconfirmed_po` rows) — this is GREEN by design (a genuine Monday-reset proof), not a flake or skip. Note: `e2e.yml` is non-blocking in v1, so AC-080-GREEN is a post-push confirmation, not a merge gate — but it MUST be checked.

4. **Promotion clock (informational):** this counts as `e2e.yml` green run **#4** toward the 20-green promotion clock (AC-PROMO1, the separate 078/079 follow-up). This spec does NOT flip `e2e.yml` to required.

5. **080↔081 arc closure (record in the commit narrative).** This closes the 080→081 arc: 080 was DEFERRED when its own design pass discovered that the dashboard `unconfirmed_po` rule rendered the *focal* store's schedule on every card (no per-store loader; focal store non-deterministic because `fetchStores` has no `.order()`) → that finding was implemented as **spec 081** (the per-store cross-store loaders) → 081 shipped green → 080 was un-deferred against the now-genuinely-per-store rule and now passes FULL (both window directions) in a real DOM. The durable artifact of the prior RE-DEFER pass (the recommended `fetchOrderScheduleForStores` follow-up) became the unblock. The RE-DEFER analysis is preserved verbatim in the spec for trace.

## Out of scope for this review

- **Promoting `e2e.yml` to a required/blocking gate** — the separate AC-PROMO1 follow-up from specs 078/079, gated on the 20-green clock (this is run #4). Not part of 080.
- **The 5 deferred code-reviewer Nits** — all cosmetic (the safe `as string` cast, comment wording, teardown log asymmetry, sentinel-UUID comment, README phrasing). A future housekeeping pass could fold them in; none block ship and none affect correctness or determinism.
- **Re-testing the spec-074 windowing LOGIC** — already pinned by ~8 deterministic jest tests (`cmdSelectors.unconfirmedPoWindow.test.ts` + `weekWindow.test.ts`), untouched. 080 adds the integration-render layer only.
- **A clock-freeze E2E harness** for the documented sub-second near-midnight flake window (Risk 2) — accepted as the same class of risk spec 079 accepts; not worth the harness for a non-blocking workflow. A future spec could revisit if flakes ever materialize.
- **Timezone-source maintenance dependency** — `BRAND_TZ='America/New_York'` is pinned to the verified runtime `useStore.timezone` default. If a future spec changes the timezone default or adds DB-side tz overrides, `BRAND_TZ` must be updated. Documented in the spec; out of scope here.

---

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 080 (un-deferred) FULL dashboard-window E2E; 0 Critical, code-reviewer Should-fix already fixed, test-engineer 11/11 PASS with load-bearing anti-vacuous audit, no migration/RPC/RLS/contract change. Commit is the user's to authorize; watch the first `e2e.yml` run on main after push (AC-080-GREEN; Monday branch is green-by-design); this is `e2e.yml` green run #4 toward the 20-green promotion clock. Closes the 080→081 arc.
payload_paths:
  - specs/080/reviews/release-proposal.md
