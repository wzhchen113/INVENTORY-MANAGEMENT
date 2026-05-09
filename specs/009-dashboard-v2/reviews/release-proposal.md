# Release proposal — Spec 009 (Dashboard v2)

Coordinator: release-coordinator
Date: 2026-05-06

## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across all reviewers and all 12 acceptance criteria PASS (live + code-verified); remaining items are quality cleanups, not blockers.

## Findings summary

- **code-reviewer**: 0 Critical, 5 Should-fix, 9 Nits.
  - Top issues: R3 parity probe should be removed before merge (its job is done); `getItemStatus` prop typed `(i: any) => …` instead of `(i: InventoryItem) => ItemStatus`; three KPI tiles ship hard-coded delta strings (`"+4.2%"`, `"+8%"`, `"+25%"`) that read as real percentage changes; `eslint-disable` over an inline `.map().join()` dep array; `StoreColProps` couples to `ReturnType<typeof useStore.getState>` instead of explicit `InventoryItem[]` / `AuditEvent[]`.

- **security-auditor**: NOT RUN — no rationale to re-audit. Spec 009 introduces no new write paths, no RLS surface, no new secrets, no JSONB or user-input attack surface, no new edge functions. The only DB additions are two read selectors (`fetchEodSubmissionsForStores`, `fetchPosImportsForStores`) that read tables already covered by `auth_can_see_store()` RLS. Skip is appropriate; flagging here for audit-trail honesty.

- **test-engineer**: 12 PASS / 0 FAIL / 0 NOT TESTED. 2 Minor findings.
  - All 12 ACs verified (mix of live browser evidence A1/A3/A5/A6/A11/A12 and static code inspection for the rest).
  - A7 spec-text vs §7-rule-table simplification: implementation correctly follows the authoritative §7 ladder; A7 summary is shorthand and should be reconciled in a doc cleanup pass.
  - A10 partial atom reuse: `StatusPill` and `StatusDot` rebuilt inline inside `<StoreCol>` instead of imported from `src/components/cmd/`. Behavior equivalent, consistency dings only.
  - Standing gap: no test framework. `cmdSelectors.ts` is now ~960 LOC of pure functions with `now` injectable — highest-value vitest target on the codebase. Surface as a separate spec, not a blocker for 009.

- **backend-architect (drift)**: 0 Critical, 5 Should-fix, 6 Nits. All 6 architect Decisions D1–D6 implemented per spec; Reconciliation refactor math verified equivalent one-for-one to pre-refactor inline path.
  - **S1 (headline)**: `useStoreFoodCostHeatmap` and `useAttentionQueueByStore` shipped as dead-end hooks. Their leading comments tell callers NOT to use them; the dashboard correctly bypasses them. Footgun for the next contributor who greps `cmdSelectors.ts`. Recommend delete.
  - **S2 (doc drift, not code drift)**: spec §0 / D2 rationale leaned on `__all__`-mode partiality, but `__all__` is decommissioned per `useStore.ts:248-263` (silent redirect). D2(b) is still the right answer for a different reason — `useStore.eodSubmissions` is always single-focal-store now, so cross-store data genuinely has to be fetched.
  - **S3**: CoGS card is focal-store-only while header reads cross-store ("All stores · day in progress"); same focal-vs-fleet framing question as S2.
  - **S4**: hard-coded delta pills on three KPIs (mirrors code-reviewer #3).
  - **S5**: R3 parity probe bails silently when `latest` is undefined — quiet console doesn't distinguish "selector matched" from "probe didn't run."
  - **D3 footgun re-emergence**: `DashboardSection.tsx:24` redeclares `TARGET_FOOD_COST_PCT = 30` instead of importing `TARGET_FOOD_COST_PCT_DEFAULT` from `cmdSelectors.ts`. Trivial 2-line fix.

## Recommended next steps (ordered)

This is SHIP_READY. The list below is the optional pre-commit cleanup bundle (consistent with the precedent set by Specs 003 / 006 / 007 / 008), then the ship steps.

### Optional pre-commit cleanup bundle (recommended, ~10 min)

1. **Delete the two dead hooks** (architect S1) — `useStoreFoodCostHeatmap` (`cmdSelectors.ts:851-874`) and `useAttentionQueueByStore` (`cmdSelectors.ts:941-959`). The dashboard already calls `computeStoreFoodCostVariancePp` and `computeAttentionQueue` directly with cross-store data. Removing the hooks eliminates documented footguns. Highest-value cleanup — the most likely thing to bite the next contributor.
2. **Import `TARGET_FOOD_COST_PCT_DEFAULT`** instead of the local `TARGET_FOOD_COST_PCT = 30` redeclaration at `DashboardSection.tsx:24` (architect D3 sub-finding). Restores single-source-of-truth that the architect explicitly designed for. Fixes nit N4 from code-reviewer at the same time (`StoreCol.foodPct` magic 30s).
3. **Decide on the R3 parity probe** at `ReconciliationSection.tsx:81-118`. Two acceptable options:
   - (a) Remove it. Its job (verify the refactor matches inline math) is done; architect's direct math sanity check confirms one-for-one equivalence. Removing it deletes ~38 lines of dev-only instrumentation and resolves both code-reviewer #1 and architect S5.
   - (b) Add a `console.log('[Spec 009 R3] no latest EOD — probe skipped')` one-liner at the early-return so a quiet console means "selector matched", not "probe wasn't tested" (architect S5 directly).
   Recommendation: option (a) — the probe has served its purpose.
4. **Fix the three hard-coded KPI delta strings** (code-reviewer #3 + architect S4) at `DashboardSection.tsx:296` / `309` / `326`. Either drive deltas from `synthSeries` first vs last point, or set `delta=""` for the synthetic KPIs (TOTAL INV / WASTE / STOCK ALERTS) to match how the EOD tile suppresses its pill when complete. The synthetic *series* are tagged `SYNTHETIC_KPI_SERIES` and acceptable for Phase 1; the hard-coded *delta pills* read as precise percentages and are a stricter form of the R1 risk.
5. **Spec doc-drift fix** (architect S2): update §0 / D2 rationale text in `specs/009-dashboard-v2.md` to note that `__all__` mode is decommissioned (per `useStore.ts:248-263` redirect) and that D2(b) holds for the new reason — `useStore.eodSubmissions` is always single-focal-store, so cross-store data has to be fetched. Spec text only; no code change.

### Ship steps (after optional bundle)

6. Stage all changes and report ready (per memory: never run `git commit` without "commit it").
7. After user confirms commit, push to GitHub. **No `supabase db push` this time** — Spec 009 is UI + selectors only, no DB migration.
8. Vercel auto-redeploys on push to `main`; verify the new dashboard is live.

### Defer (not blocking ship, surface as separate specs / backlog)

- 9 code-reviewer Nits (label-prop on Sparkline N1, `useMemo([])` on `lastNDates` N2, double `.filter` N3, `foodPct` magic 30 N4 [resolved by item 2 above], heatmap row key N5, `todayISO` re-compute N6, duplicate `DAY_NAMES` N7, O(N²) `findIndex` in `computeStoreFoodCostVariancePp` N8, Unicode minus vs ASCII hyphen inconsistency N9). All are quality polish.
- Architect S3 (CoGS focal-vs-fleet framing) and N3 (EOD delta-pill semantics) — UX/PM call, requires product input on whether CoGS card and header should fan out or relabel.
- Architect N1 (`storeName` backfill), N2 (lookback range docs + queue-spam stress test), N4 (heatmap legend missing 1.5–2.5 swatch), N5 (deps array cleanup with `useMemo`-derived key), N6 (extend R3 probe to diff `pct`).
- Test-engineer A7 spec-text reconciliation with §7 rule table (doc-only).
- Test-engineer A10 inline `StatusPill` / `StatusDot` swap to imports from `src/components/cmd/`.

## Out of scope for this review

- **Test framework introduction.** test-engineer's strongest standing recommendation: introduce vitest as a devDependency and target `src/lib/cmdSelectors.ts` first (pure functions, `now` injectable, ~960 LOC of testable logic, three acceptance-criteria ladders currently verified only by code reading). The architect §8 anticipated this. Surface as its own spec — not a 009 blocker.
- **Spec §7 rule-table vs A7-summary doc reconciliation** — drop into the A7 cleanup pass when next touching the spec. Code is correct against §7 (authoritative).
- **Cross-store inventory KPIs / fleet-vs-focal framing** (architect S2 / S3) — needs PM call on whether the dashboard hero strip and CoGS card should fan out across all visible stores or honestly relabel as focal-store. Not a Spec 009 fix; warrants its own scoped change.
- **Heatmap legend completeness** (architect N4) — visual polish, separate UI pass.
- **`storeName` backfill contract** in `fetchEodSubmissionsForStores` (architect N1) — cosmetic until a downstream consumer reads it.

---

Note on the system reminders that arrived mid-context (computer-use MCP instructions, auto-mode notice): both are environmental notices unrelated to this proposal task. Honored by not invoking any computer-use tool and by executing the proposal write immediately without asking for confirmation. No action required from them on this spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY — Spec 009 (Dashboard v2). 0 Critical across all reviewers, 12/12 ACs PASS, security audit appropriately skipped (no write paths / RLS / secrets). Recommend optional pre-commit cleanup bundle (4 small fixes + 1 spec doc fix, ~10 min): delete 2 dead hooks (architect S1), import TARGET_FOOD_COST_PCT_DEFAULT instead of redeclaring (D3), remove the R3 parity probe (its job is done), neutralize hard-coded KPI delta pills, and patch the §0/D2 rationale doc-drift. No prod migration this spec — UI + selectors only; after commit just push to GitHub for Vercel redeploy. Test-framework introduction surfaced as a separate spec candidate.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/009-dashboard-v2/reviews/release-proposal.md
