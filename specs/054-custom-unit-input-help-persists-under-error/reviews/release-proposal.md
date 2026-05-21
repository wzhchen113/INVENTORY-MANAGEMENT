# Release proposal — Spec 054 (CustomUnitInput help text persists alongside the error)

## Verdict
verdict: SHIP_READY
rationale: Both reviewers green at the blocking tier (0 Critical from code-reviewer and test-engineer); 8/8 ACs PASS; full jest suite 187/187 green with all five `IngredientForm.help-text` tests including the new test #5; the two Should-fix items are an assertion-style tightening (1 line) and a coverage-symmetry gap (the PACK UNIT branch is architecturally covered by the same shared `CustomUnitInput` body but lacks its own blur test) — recommended as cheap pre-commit polish, not gating, because the fix is correct for both branches by construction and main-Claude's preview verification confirmed the user-visible bug is gone.

## Findings summary

Reviewer-set scope: code-reviewer + test-engineer were dispatched. Security-auditor was intentionally skipped — same rationale as spec 052: this is a copy/JSX-only presentational fix with no auth path, no HTML rendering, no destructive op, no user-controlled input flowing into a sink, and no backend touch. Backend-architect (post-impl) was also intentionally skipped because there is no backend surface (no migration, no edge function, no `src/lib/db.ts` change, no realtime channel, no `useStore` slice) — the spec's Backend design section explicitly enumerates each architect-checklist heading as a no-op.

- **code-reviewer:** 0 Critical, 1 Should-fix, 2 Nits.
  - Should-fix (`src/components/cmd/IngredientForm.help-text.test.tsx:242`) — `expect(screen.getByText('required')).toBeTruthy()` is weaker than the file's prevailing style and swallows RTL's "Unable to find element" message on failure. Every other assertion in the file uses `getAllByText(...).toHaveLength(1)` (lines 124, 131, 155, 170, 202, 241). Inconsistency is small, 1-line fix.
  - Nit 1 (line 205) — test name uses "required" without clarifying it's the raw translation key; `'required' error key` would be more self-documenting.
  - Nit 2 (`src/components/cmd/IngredientForm.tsx:342-351`) — confirming the `gap: 4` on the parent `<View>` already handles inter-element rhythm correctly. No action needed; documentation that the reviewer validated it.

- **test-engineer:** 8/8 ACs PASS, 0 FAIL, 0 NOT TESTED.
  - All eight acceptance criteria verified — AC1 (both strings render simultaneously when both props non-empty) via the new test #5, AC2 (color/font tokens) via source read (acceptable for copy-only spec, see note), AC3/AC4 (empty-prop conditionals) via implementation shape + test #3/#4 regression, AC5 (border logic untouched) via source diff, AC6 (both call sites covered) by shared-component architecture, AC7 (new jest test added) via test #5, AC8 (spec 052's four tests unchanged) via the targeted run output.
  - Test run: 5/5 in `IngredientForm.help-text.test.tsx`; full suite 187/187 across 18 suites.
  - Should-fix (PACK UNIT blur coverage gap, non-blocking) — the fix architecturally covers both DEFAULT UNIT and PACK UNIT custom branches because they share one `CustomUnitInput` component body; however no PACK UNIT-specific blur test exists (test #4 exercises the PACK UNIT flip → help-still-visible path, but does not blur with empty value to assert help+error coexistence). The symmetry is guaranteed by construction; adding a parallel test #6 would close the symmetry-of-coverage gap and act as a regression-detector if the two call sites ever diverge. Tradeoff: ~20 lines of new test (copies test #5 shape with the PACK UNIT trigger) vs. trust-the-architecture.
  - Notes: `fireEvent(inlineInput, 'blur')` vs `fireEvent.blur(inlineInput)` are functionally equivalent (event-handler chain dispatch). Style assertion (computed color/font) absent and accepted — `@testing-library/react-native` does not expose inline styles through text queries, and `toHaveStyle` introduces fragility on a copy-only spec; the source diff confirms the correct tokens. `validateCustomUnit` returns the literal string `'required'` (line 138) and the parent stores it verbatim (line 677) — no translation layer in the assertion path.

- **Preview verification (main Claude, before dispatch):** After triggering DEFAULT UNIT → "+ custom…" → blur with empty value, the rendered outer text was `"default unit × the smallest unit you count one of (each, lb, oz, mL) required"` — both the spec 052 help line and the `required` error line coexist. Bug fixed; ACs 1, 2, 6 confirmed at the rendered-DOM level for the DEFAULT UNIT branch.

- **No security-auditor / backend-architect-post-impl:** intentionally skipped (rationale above). Copy/JSX-only UX with no security surface and no backend.

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Apply the two inline cleanups pre-commit** (recommended; together ~25 lines, both in `src/components/cmd/IngredientForm.help-text.test.tsx`). The file ships tighter and the next maintainer doesn't inherit either footgun:

   a. **Fix assertion style (code-reviewer Should-fix)** at `src/components/cmd/IngredientForm.help-text.test.tsx:242`. Replace:
      ```
      expect(screen.getByText('required')).toBeTruthy();
      ```
      with:
      ```
      expect(screen.getAllByText('required')).toHaveLength(1);
      ```
      Mirrors the prevailing pattern at lines 124, 131, 155, 170, 202, 241; on failure the error message points at the actual count rather than a swallowed `getByText` throw. Trivial 1-line edit.

   b. **Add the PACK UNIT blur test (test-engineer Should-fix)** as a new `it(...)` test #6 immediately after test #5. Copy the test #5 shape exactly, but: (i) press the PACK UNIT display instead of the DEFAULT UNIT display to open the second dropdown, (ii) press its `+ custom…` row to flip `customMode.pack = true`, (iii) target the PACK UNIT inline `TextInput` (placeholder shape is parallel — verify via grep before assuming), (iv) fire `blur` with empty value, (v) assert both `PACK_UNIT_HELP` (one match) AND `'required'` (use the `getAllByText(...).toHaveLength(1)` shape from step (a) for consistency). ~20 lines; closes the symmetry-of-coverage gap and serves as a regression detector if the two call sites ever diverge in the future.

2. **(Optional inline polish, sub-30-second edits)**

   c. **Test name precision (code-reviewer Nit 1)** at `src/components/cmd/IngredientForm.help-text.test.tsx:205`. Change the test description from `"required" error` to `'required' error key` to self-document the key-echoing translator behavior for future readers.

3. **Commit and deploy.** Two-file change — `src/components/cmd/IngredientForm.tsx` (JSX split at lines 342-351, no new imports, no new state, no new styles) and `src/components/cmd/IngredientForm.help-text.test.tsx` (header comment update + one new test, or two new tests if step (b) applied). No migration, no edge function, no client store change, no realtime publication change, no `app.json` edit. The existing CI `test.yml` job picks up the new test automatically; 187/187 on the full jest suite already confirms green.

4. **(Optional, separate follow-up specs — none blocking this ship)**

   - **`InputLine`/`SelectField` harmonization (spec 054 Q4 deferral)** — the identical `{error || help}` swap pattern still exists at `src/components/cmd/IngredientForm.tsx:80, 133, 224`. The user-visible regression only surfaces in `CustomUnitInput` because only it wires a blur-validation path that produces a persistent error string alongside the spec 052 help. If a future blur-validation contract is added to `InputLine` or `SelectField`, that spec inherits the same fix. A standalone harmonization spec (call it 055) could sweep all three components plus their tests; PM-deferred until motivated.
   - **Shared `<HelpAndError>` block (spec 054 Q4 deferral)** — extracting a reusable block across the three components would tighten DRY but introduces a third file and a cross-cutting refactor. Defer with the harmonization spec above.
   - **Ragged vertical-baseline mitigation (architect risk §6)** — when the error appears, the default-unit column grows one row taller than its neighbors (`packs / order`, `units / pack`). Acknowledged unavoidable cost of stacking help + error. If a user later complains, a follow-up spec could mirror the help-line height into `InputLine` so the baseline becomes symmetric (or absorb both into a single fixed-height slot).

## Out of scope for this review

- **`InputLine` / `SelectField` `{error || help}` swap harmonization** — explicitly deferred by spec Q4 resolution. Captured above as a candidate follow-up spec; the surrounding pattern is acknowledged drift, not a new regression.
- **Shared `<HelpAndError>` extraction** — same Q4 deferral; cross-cutting refactor scope.
- **Validation contract changes** — spec is presentational only; `validateCustomUnit` still returns `'required'` byte-for-byte and the parent stores it verbatim. Out of scope.
- **Accessibility additions (`aria-describedby`, error icon)** — out-of-scoped by spec; minimal presentational fix, not a redesign.
- **Help-text typography restyling** — out-of-scoped by spec; visual tokens reused verbatim.
- **PACK UNIT-specific blur test** — flagged as a Should-fix coverage gap rather than a hard requirement; closure recommended as inline cleanup (step 1b above) but architecturally guaranteed by the shared `CustomUnitInput` body, so spec ACs pass without it.
- **`app.json` slug change** — N/A; pure JSX/test change, no client config touched. CLAUDE.md "DO NOT AUTO-FIX" applies regardless.
- **Realtime publication review** — N/A; no schema change, no `docker restart supabase_realtime_imr-inventory` ritual required (spec backend-design §Realtime impact = none).
- **`src/lib/db.ts` and `useStore.ts` review** — N/A; no client store touch, no PostgREST surface (spec backend-design §`src/lib/db.ts` surface, §Frontend store impact = both untouched).
- **Last-of-role / self-guard / publication-restart rules** — none triggered by this change; the spec explicitly records this so the reviewer doesn't re-derive it (architect risk §6).

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 Critical from both reviewers (code-reviewer, test-engineer); 8/8 ACs PASS; full jest 187/187 with all five `IngredientForm.help-text` tests green; preview verification confirmed help + error coexist below the input after blur-with-empty on DEFAULT UNIT; two Should-fix items are pre-commit polish (1-line assertion-style tightening at test line 242, and ~20-line PACK UNIT blur test to close the symmetry-of-coverage gap — the fix is architecturally correct for both branches via the shared `CustomUnitInput` body); security-auditor and backend-architect-post-impl intentionally skipped (copy/JSX-only UX, no security surface, no backend)
payload_paths:
  - specs/054-custom-unit-input-help-persists-under-error/reviews/release-proposal.md
