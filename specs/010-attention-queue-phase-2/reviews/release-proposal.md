# Release proposal — Spec 010 (Expiry tracking & spoilage alerts)

## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across all reviewers and all 7 acceptance criteria PASS; two Should-fix bugs are small, surgical, and worth folding into the same commit before pushing.

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix, 5 Nits.
  - Should-fix #1: `IngredientFormDrawer.tsx:62` — blank expiry input does not clear the column. `toUpdates` returns `expiryDate: undefined`, which `updateInventoryItem` treats as "skip field"; the old `expiry_date` value persists in DB despite the form's "blank to clear" affordance. One-line fix: `expiryDate: v.expiryDate || null`.
  - Should-fix #2: `ReceivingSection.tsx:133` — auto-stamp uses UTC date (`new Date().toISOString().slice(0,10)`), causing off-by-one near local-day boundaries. Same TZ class as Spec 007 bug. Fix: derive a local `YYYY-MM-DD` from `getFullYear/Month/Date` before passing to `computeExpiryFromShelfLife`. Mirror the literal-component pattern at `cmdSelectors.ts:886-888`.
  - Nits (5): `computeExpiryFromShelfLife` placement (db.ts vs utils/), bucket-cascade comment for `≤ 0h`, `catalogRow` missing from drawer keyboard-handler dep list, modal `onPress={() => {}}` could be `e => e.stopPropagation()`, `shortExpiry` UTC accessors documented as the conservative choice for date-typed columns. None blocking.

- **security-auditor**: SKIPPED — additive nullable column on `catalog_ingredients` (RLS-clean per spec 005 P5), no new write paths, no new edge function, no new attack surface. Documented decision.

- **test-engineer**: 7 PASS / 0 FAIL / 0 NOT TESTED. AC1-AC7 all CODE-VERIFIED; AC2/AC3/AC4 also LIVE-VERIFIED via main-Claude probes (shelf-life round-trip, MED-bucket alert at ~36h, modal drill-down). Coverage gaps flagged (HIGH/LOW bucket browser walks, multi-item aggregate text, beyond-7d exclusion, reset-to-null) all backed by REPL math proofs and trivially follow from existing code; none represent missing implementation. No test framework exists in repo (project policy).

- **backend-architect**: 0 Critical, 1 Should-fix, 3 Nits. All A1-A4 design decisions resolved as specified. Notable callouts:
  - S1 is the same TZ bug code-reviewer flagged at `ReceivingSection.tsx:133`. Architect explicitly classifies as non-Critical (Receiving is Tier-1 mock; operator can override via drawer) but flags for fix before Receiving promotes to a real `po_items`-backed surface.
  - Architect explicitly **acknowledges the dev's `cmdSelectors.ts:886-888` date-parsing implementation as a correctness fix to the architect's own §3 pseudocode** (which would have double-shifted dates); recommends promoting the local-time literal-component construction as the canonical shape for any future selector pattern.
  - Architect **recommends promoting the modal's snapshot pattern (no re-derivation, all data on `expiryDetail`) as the template for any future drill-down rule** (food-cost streak detail, low-stock list). Forward-looking note for design history.

## Recommended next steps (ordered)

Pre-commit cleanup bundle (matches Spec 003/006/007/008/009 precedent — small inline fixes folded into the implementation commit, not a follow-up):

1. **Fix code-reviewer #1 (Should-fix, "blank doesn't clear" bug)** — `src/components/cmd/IngredientFormDrawer.tsx:62`. Change `expiryDate: v.expiryDate ? v.expiryDate : undefined` → `expiryDate: v.expiryDate || null`. Without this, the form's own "blank to clear" affordance is broken UX. First because it is a real user-visible defect, not a TZ edge case.

2. **Fix code-reviewer #2 / architect S1 (Should-fix, UTC TZ bug in receive auto-stamp)** — `src/screens/cmd/sections/ReceivingSection.tsx:133`. Replace `new Date().toISOString().slice(0, 10)` with a local-date builder (`${y}-${MM}-${DD}` from `getFullYear/Month/Date`). Mirror the `cmdSelectors.ts:886-888` shape per architect's recommendation. Same Spec 007 TZ class — one fix-shape, both reviewers flagged it.

3. **User authorizes prod migration push** for `supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql` (additive nullable column on `catalog_ingredients`; no row rewrites on PG 17; no RLS delta).

4. **Commit + push to GitHub** to trigger Vercel redeploy of admin web.

## Out of scope for this review

These are reviewer-flagged items that should not block ship; they belong in separate follow-up specs or future cleanup passes:

- **Promote the modal snapshot pattern as a drill-down template** (architect forward-looking note). Worth capturing in design history for the next selector that grows a drill-down (e.g. food-cost streak, low-stock).
- **Move `computeExpiryFromShelfLife` from `db.ts` to `src/utils/`** (code-reviewer Nit) — pure date-math helper currently lives in the PostgREST file; minor reader-confusion, not worth a standalone PR.
- **Inline comment on bucket cascade** explaining `≤ 24h` arm covers the already-expired (`≤ 0h`) case (code-reviewer Nit) — small readability win.
- **Add `catalogRow` to drawer keyboard-handler dep list** (code-reviewer Nit) — low-probability staleness in single-operator UI.
- **Modal click-stopper explicitness**: `onPress={() => {}}` → `(e) => e.stopPropagation()` (code-reviewer Nit) — out-of-scope per established pattern in `AddCountModal.tsx`.
- **`updated_at` synthetic write redundancy** if a trigger exists on `catalog_ingredients` (architect N1) — codebase-wide cleanup, not spec-010-scoped.
- **Minute-resolution expiry labels** (architect N2) — `<1h` granularity is sufficient for the alert horizon.
- **`shortExpiry` `getUTC*` vs local-time consistency** (architect N3) — architect-leaning is "fine as-is for date-typed columns"; once the auto-stamp local-date fix lands the file's own convention is consistent.
- **Receiving promoted to real `po_items`-backed surface with per-line expiry override** (architect §9 flag #1) — separate spec, requires backend table work.
- **Test framework introduction** (test-engineer recurring note) — `computeAttentionQueue` and `computeExpiryFromShelfLife` are highly testable pure functions; requires explicit user approval per project policy.
- **Browser-walk coverage gaps** (test-engineer): HIGH bucket, LOW bucket, multi-item aggregate text, beyond-7d exclusion, reset-to-null. All code-verified via REPL math; manual probe backlog only.
- **Pre-existing TypeScript errors** in `useStore.ts:285,373,380,1082,1183` and others — present in baseline `5fa63d3`; not introduced by spec 010.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 2 inline fixes recommended pre-commit (IngredientFormDrawer blank-clear, ReceivingSection UTC->local TZ); apply both, then authorize prod migration push and commit + push to GitHub for Vercel redeploy.
payload_paths:
  - specs/010-attention-queue-phase-2/reviews/release-proposal.md
