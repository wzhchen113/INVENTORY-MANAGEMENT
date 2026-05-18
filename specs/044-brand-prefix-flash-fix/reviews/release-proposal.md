## Verdict
verdict: SHIP_READY
rationale: Sole reviewer (code-reviewer) closed all Should-fix items in a single revision round; 0 Critical across the review surface, acceptance criteria browser-verified at first paint, 142/142 jest + typecheck clean.

## Findings summary
- code-reviewer: 0 Critical, 2 Should-fix (both resolved), 4 Nits (3 of 4 resolved as comment polish; 1 declined per reviewer's "current typing is correct" framing). Top issues were S1 (test (3) idempotent claim unbacked by assertion — addressed by adding a fourth test arm) and S2 (no-db-call comment unenforceable — addressed by explicit `not.toHaveBeenCalled()` assertions on `fetchStores` / `fetchAllForStore`).
- security-auditor: not invoked — frontend-only UI-flash fix piggybacks on existing `brand_member_read_brands` RLS policy with no schema, edge function, or auth surface changes.
- test-engineer: not invoked — jest track only, hydrator coverage hand-rolled in `src/store/useStore.test.ts` (4 new arms: 3 core + 1 idempotency); architect's Q3 framed test as recommended-not-blocking.
- backend-architect: design-round approval recorded inline in spec §"Backend / architecture design" (RLS walk-through across all four user classes, ordering rationale for hydrate-before-login, AuthResult-additive safety, embed silent-null acknowledged). Post-impl review not invoked — three-file shape matched the approved design with no contract drift.

## Recommended next steps (ordered)
1. Commit and deploy. Single squash commit covering `src/lib/auth.ts`, `src/store/useStore.ts`, `App.tsx`, `src/store/useStore.test.ts`, plus the spec and reviewer/proposal artifacts under `specs/044-brand-prefix-flash-fix/`.
2. (optional, non-blocking) Follow-up: add a jest mock-supabase test against `getSession()` asserting the `brand: { id, name } | null` envelope per architect's Q3 second half — would cover the embed contract directly rather than transitively through the hydrator. Architect tagged this as "not blocking ship" and frontend-developer deferred citing absent mock plumbing in `auth.test.ts`; it remains a clean future-spec carve-out.
3. (optional, non-blocking) Reviewer nit on `hydrateBrand` param type (`{ id; name } | null` vs `Brand | null` for surface consistency) — reviewer explicitly framed current typing as correct, so leave-as-is is defensible. Revisit only if a future caller wants to pass a full `Brand` and trips the structural mismatch.

## Out of scope for this review
- Soft-deleted-brand UX (architect's Q5) — `inv://` fallback is intentional "weird state" signaling per spec §"Out of scope (explicitly)"; any cleaner sentinel (`xx://`, empty prefix) is a separate UX spec.
- super_admin "All brands" prefix behavior — explicitly preserved by `result.brand === null` path in AC line 28-30; no change in scope here.
- TitleBar `brandPrefix()` refactor — spec §"Out of scope" pins the fix as hydration-timing-only.
- Vercel rebuild / EAS native rebuild operator step — none required; frontend-only TS change ships on the next push.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/044-brand-prefix-flash-fix/reviews/release-proposal.md
