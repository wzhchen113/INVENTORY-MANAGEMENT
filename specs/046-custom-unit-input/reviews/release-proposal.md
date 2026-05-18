## Verdict
verdict: SHIP_READY
rationale: All round-1 Critical and Should-fix findings have explicit round-2 patches in `IngredientForm.tsx` / `IngredientForm.test.ts`; no other reviewer raised a Critical and the test suite (163/163) + typecheck pass.

## Findings summary
- code-reviewer: round 1 = 2 Critical + 4 Should-fix + 4 Nits; round 2 = all Critical and all Should-fix addressed (C1 `committedRef` latch, C2 `knownLowercaseKeys` arg, SF1 redundant `onKeyPress` removed, SF2 `curRaw` for banner display, SF3 mock-placement comment, SF4 test loop now driven by imported `CANONICAL_UNITS`), plus the comment-refresh and test-header nits.
- security-auditor: not invoked — UI-only, no DB / RLS / migration / edge function surface; `text` column already accepts arbitrary input and is rendered through React Native `Text` (auto-escaped). No new attack surface.
- test-engineer: not invoked — 21 jest cases in the new `IngredientForm.test.ts` cover the `validateCustomUnit` contract (empty / whitespace / 30-char boundary / 31-char rejection / case-insensitive snap of every `CANONICAL_UNITS` entry / `knownLowercaseKeys` snap for `each` and conversion-derived units / case-preserving pass-through). AC1–AC8 verified by the dev (typecheck + 163/163 jest).
- backend-architect: design-mode pre-build only (no migration / RPC / edge function changes); post-impl pass not required because the design explicitly ruled out backend surface and the implementation stayed inside that envelope.

## Recommended next steps (ordered)
1. Commit and deploy. Frontend-only; Vercel auto-deploys on push to `main`. No operator step, no migration, no edge function deploy.
2. (optional follow-up) The pre-existing `&amp;` JSX entity at `IngredientForm.tsx:602-604` and the `CustomUnitInput` `autoFocus` hardcoding are out-of-scope nits — defer to a future cleanup spec.

## Out of scope for this review
- `&amp;` HTML entity in `IngredientForm.tsx` JSX (predates spec 046).
- `CustomUnitInput` `autoFocus?: boolean` prop for forward-compat (low risk).
- i18n key for the `'+ custom…'` label (deferred per spec 038's English-only IngredientForm decision).
- Auto-redirect from custom-unit commit to the Conversions tab (architect Q2: banner-only, deferred as a heavier UX change).

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/046-custom-unit-input/reviews/release-proposal.md
