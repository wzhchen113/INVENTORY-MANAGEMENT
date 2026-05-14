# Release proposal — Spec 024 (TypeScript hygiene cleanup, non-legacy graph)

Date: 2026-05-13
Coordinator: release-coordinator (advisory)

## Verdict
verdict: SHIP_READY
rationale: All three reviewers report 0 Critical; AC1-AC11, AC12, AC14-AC16 verified PASS (16/16 ACs green per test-engineer); AC3/AC13 partial-by-design coverage gap is explicitly deferred to spec 025 per spec scope.

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix, 5 Nits.
  - S1 — `src/lib/db.ts:2775` `expiryDate` mapper uses `|| ''` fallback; under the new `string | null` type, the fetch-path mapper never delivers `null`. Pre-existing inconsistency made visible by spec 024's type widening.
  - S2 — `StockHistoryChart.tsx:186-190` `as object` cast strips all type information from the spread; a narrow interface cast (e.g. `as { onMouseEnter?: () => void; onMouseLeave?: () => void; }` or `as React.HTMLAttributes<SVGCircleElement>`) would preserve handler types and document intent better. Satisfies AC5 as-written; weaker than spec intent.

- **security-auditor**: SKIPPED per spec scope. Spec 024 is a pure TypeScript hygiene pass (no auth surface, no edge functions, no migrations, no data-flow change). The CI workflow's least-privilege `permissions: contents: read` (file-level, inherited by the new `typecheck` job) closes the spec-022 M1 finding by inheritance — no new security surface introduced.

- **test-engineer**: 16/16 acceptance criteria PASS, 4/4 test tracks green.
  - `npm run typecheck:test` → exit 0.
  - `npm test -- --ci` → 17/17 pass (3 suites).
  - `npm run test:db` → 13/13 files pass.
  - `npm run test:smoke` → 4 PASS + 2 SKIP (edge) + 3 PASS (rpc).
  - Regression-gate probe (injected error in `relativeTime.ts`) confirmed the new CI job fires.
  - `AppNavigator.tsx` cascade-win verified: the two `s.storeLoading` errors at lines 502 + 697 are gone; one unrelated `detail` error remains (legacy, out of scope).

- **backend-architect** (post-impl): 0 Critical, 0 Should-fix, 1 Minor (StockHistoryChart `as object` cast — same finding as code-reviewer S2, classified as non-blocking). Three deviations classified Approved Drift (`@types/react-dom@~19.1.11` tilde pin, `StockHistoryChart` typed-spread cast, `InventoryDesktopLayout.tsx` bonus errors fixed). Four items Faithful. Verdict: APPROVE.

## Dev-deviation resolution table

| # | Deviation                                                | Architect verdict | Coordinator action |
| - | -------------------------------------------------------- | ----------------- | ------------------ |
| 1 | `@types/react-dom` pinned `~19.1.11` (tilde, not caret)  | Approved Drift    | ACCEPT — architect's risk-mitigation note explicitly anticipated this fallback; the caret would have resolved into 19.2.x and conflicted with the locked `@types/react@~19.1.10` peer-dep. |
| 2 | `StockHistoryChart.tsx` typed-spread `as object` cast    | Approved Drift    | ACCEPT — real type narrowing (not a suppression directive), satisfies AC5; the dev correctly discriminated that only line 183's directive was unused. Tighter-cast follow-up is non-blocking (see Recommendations below). |
| 3 | `InventoryDesktopLayout.tsx` 3 bonus errors fixed        | Approved Drift    | ACCEPT — falls under AC4's wording ("additional non-legacy errors fall under AC4 and the spec adds an in-line note rather than a new AC"); fix shape matches the existing `v ?? 0` pattern at the sum28d reducer; zero runtime delta. |

## Recommendation on the 2 code-reviewer Should-fix items

Recommendation: **DEFER both as follow-ups; do NOT block ship**.

- **S1 (`db.ts:2775` `expiryDate ?? null`)** — defer. This is a pre-existing inconsistency made *visible* by spec 024's type widening, not introduced by it. Spec 024 explicitly noted "no `db.ts` change needed" in §Backend Architecture; reopening that surface during the review pass would expand scope beyond the spec's contract. Spec 025's legacy sweep is the natural place to land the mapper fix alongside the consumer-side audit (the code-reviewer's `InventoryDesktopLayout.tsx:577 every((v) => v === 0)` nit calls out a related consumer-side gap that would be addressed in the same pass).

- **S2 (`StockHistoryChart` cast tightening)** — defer. Both code-reviewer and backend-architect flagged this as the same Minor; architect explicitly classified it as "non-blocking; surface as a one-line follow-up if the team wants the extra rigor". Tightening to `as { onMouseEnter?: () => void; onMouseLeave?: () => void; }` or `as React.HTMLAttributes<SVGCircleElement>` is ~5 lines and preserves handler types, but the current code already satisfies AC5 and the runtime is correct. Slot into spec 025 alongside the other Cmd UI component touch-ups, when the base `tsc --noEmit` CI gate goes in and `StockHistoryChart` will be under CI protection.

Rationale for deferring rather than inlining: both items are low-risk to ship as-is, both have natural homes in spec 025's punch-list, and inlining now would re-trigger reviewer + CI cycles for ~15 minutes of work that delivers no user-visible delta.

## Pre-existing follow-ups (already scheduled)

- **Spec 025 — legacy TS sweep + base `tsc --noEmit` CI gate.** Architect's forward-compat note enumerates the workstreams:
  - Legacy file errors (`AdminScreens.tsx`, `EODCountScreen.tsx`, `IngredientsScreen.tsx`, `PrepRecipesScreen.tsx`, `IngredientEditor.tsx`, `AppNavigator.tsx`, `scripts/test-unit-conversion.ts`).
  - The four Cmd UI component files outside the test-reachable graph (`BrandPicker.tsx`, `TitleBar.tsx`, `IngredientFormDrawer.tsx`, `StockHistoryChart.tsx`) — currently verified only by manual base `tsc --noEmit` at PR time per the spec 024 §Q5a corollary.
  - `InventoryDesktopLayout.tsx` — caught by dev in this pass, also outside test-reachable subset.
  - Test-engineer's spec-025 forward-compat survey enumerates ~70 Deno-runtime errors in `supabase/functions/` that the base gate will need to either exclude or stub — surfaced for spec 025 design phase.
  - Architect-side lesson absorbed: when widening a public component prop shape, grep call sites for narrowing assumptions (the `InventoryDesktopLayout.tsx` miss).

- **5 code-reviewer Nits** — defer to spec 025 (or pick up opportunistically):
  - `types/index.ts:418-424` `OrderSubmission.storeName` JSDoc references concrete impl detail.
  - `types/index.ts:483-489` `storeLoading` JSDoc calls out legacy `AppNavigator` as reader (will be stale post-spec-025 cleanup).
  - `.github/workflows/test.yml` header comment numbering implies sequential ordering when jobs run in parallel.
  - `src/lib/webPush.ts:182` return type `BufferSource` diverges from the constructed `Uint8Array` — intermediate annotation would clarify intent.
  - `src/screens/cmd/InventoryDesktopLayout.tsx:577` `series.every((v) => v === 0)` doesn't handle all-`null` series under the widened type (pre-existing logic gap; surfaces alongside S1's mapper fix).

- **1 architect Minor** — same as code-reviewer S2 (StockHistoryChart `as object` tightening). Defer to spec 025 per the recommendation above.

## Recommended next steps (ordered)

1. **User reviews this proposal + the four reviewer files in `specs/024-typescript-hygiene/reviews/`.**
2. **User confirms commit.** Coordinator does not auto-commit per CLAUDE.md hard rule ("Main Claude does not auto-commit on SHIP_READY. The user confirms the commit.").
3. **No prod migration needed.** Spec 024 is pure dev tooling (CI YAML, `package.json` devDep, README) + type-only source fixes. No SQL migrations, no edge functions, no RLS changes, no runtime behavior delta (AC9 dead-defaults removal is verified zero-delta per architect's CSV-importer + IngredientFormDrawer.toUpdates trace).
4. **Post-merge: enable `typecheck` as a required status check** in GitHub branch protection settings for `main`, alongside the existing `jest` job. AC12 lands the workflow definition; the required-status toggle is a one-time repo-settings task outside the YAML.
5. **Spec 025 drafting** picks up the legacy sweep + base typecheck gate + the deferred S1 / S2 / 5 Nits items per the table above.

## Out of scope for this review

- Legacy file TS errors (~25 errors in 5 `src/` files + 1 do-not-modify file + 1 one-off script per test-engineer's enumeration) — spec 025.
- ~70 Deno-runtime errors in `supabase/functions/` — spec 025 design-phase decision (exclude vs Deno-stub).
- `s.detail` error at `AppNavigator.tsx:262` — legacy, spec 025.
- Pre-existing `@ts-ignore` directives at `InventoryCountSection.tsx:507` + `BrandsSection.tsx:749, 782` — not introduced by spec 024 and untouched per scope.
- `db.ts:2775` `expiryDate` mapper `|| ''` → `?? null` (code-reviewer S1) — defer to spec 025.
- `StockHistoryChart` `as object` → narrow-interface cast (code-reviewer S2 / architect Minor) — defer to spec 025.
- 5 code-reviewer Nits — defer.

## Handoff
next_agent: NONE
prompt: SHIP_READY. 0 Critical across all reviewers; 16/16 ACs PASS; 3 dev deviations all Approved Drift. Recommend deferring both code-reviewer Should-fix items (db.ts mapper + StockHistoryChart cast tightening) to spec 025 alongside the legacy sweep + base typecheck CI gate. User reviews + commits; no prod migration needed.
payload_paths:
  - specs/024-typescript-hygiene/reviews/release-proposal.md
