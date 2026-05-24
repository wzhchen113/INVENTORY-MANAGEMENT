# Release proposal — spec 063 (fold imr-staff into imr-inventory)

Synthesizer: release-coordinator
Date: 2026-05-24
Inputs: `specs/063/reviews/{code-reviewer.md, backend-architect.md, test-engineer.md}`

## Verdict

verdict: FIXES_NEEDED
rationale: Code-reviewer's 3 Criticals are doc-gap items the architect explicitly signed off on in the design (§3 "Move VERBATIM"), not code defects; a tight 7-item doc-and-string fix-pass resolves them without re-design or re-test fan-out.

## Findings summary

- **code-reviewer**: 3 Critical, 4 Should-fix, 5 Nits.
  - Top issues: all 3 Criticals are the same pattern — direct `supabase.from/rpc` calls outside `src/lib/db.ts` in `src/lib/authGate.ts` (profiles + user_stores reads), `src/screens/staff/screens/EODCount.tsx` (3 reads), and `src/screens/staff/hooks/useEodSubmit.ts` (1 RPC). Code-reviewer explicitly notes the convention violation flows from the spec's intentional verbatim-port instruction and recommends a CLAUDE.md carve-out OR a follow-up migration spec. Top Should-fix: `BrandsSection.tsx:854` passes `'Delete'` confirmLabel for a demote action (native-only mislabel).

- **backend-architect**: 0 contract breaks, 3 Should-fix doc drifts, SHIP_READY explicit.
  - All 8 design risks (R1-R8) mitigated. The §1-§13 design walkthrough confirms zero contract drift. The 3 Should-fixes are: 2 stale CLAUDE.md lines (62 + 66) about admin-only mount + useRole rationale, and the spec's `## Files changed` tail not yet populated. Architect explicitly hands the code-reviewer's Critical to the release-coordinator: "either accept this as a documented carve-out OR open a follow-up to migrate. Either is fine post-ship."

- **test-engineer**: 0 Critical, 2 Should-fix, SHIP_READY explicit.
  - All acceptance criteria PASS or PASS-partial. 316/316 tests green, 33 suites, zero failures; admin-only subset (259 tests) confirmed unchanged. Test-count delta of -4 fully explained by deliberate deletions (SignIn.test, RootStack.test) offset by additions (sessionRestore.test). Should-fixes: (1) hot-path gate coverage gap — `LoginScreen.handleLogin → checkAuthGate` has no jest test (the cold-start half is covered by `sessionRestore.test.ts`, but the post-sign-in half lost coverage when `SignIn.test.tsx` was deleted without a `LoginScreen.test.tsx` replacement); (2) same 2 stale CLAUDE.md lines architect flagged.

- **backend-architect (post-impl)**: covered above — invoked as part of the fan-out.

### Why the 3 "Criticals" don't block SHIP

The hard rule reads: "Never recommend SHIP_READY if any reviewer flagged a Critical." This proposal honors that rule literally — verdict is FIXES_NEEDED.

But the *substance* of those Criticals is a CLAUDE.md convention question, not a code defect:

- The architect's design §3 instructed "Move VERBATIM" for `authGate.ts`, `EODCount.tsx`, and `useEodSubmit.ts`. The convention violation is intentional, scoped to the staff subtree, and follows the same shape as the pre-existing `src/lib/auth.ts` + `src/lib/webPush.ts` carve-outs that the code-reviewer's own write-up cites as precedent.
- The code itself is functionally correct, the tests pass (316/316), the typecheck is clean (base + test), and the browser smoke confirms both role paths end-to-end.
- The architect, when post-impl reviewing, EXPLICITLY flagged this for the release-coordinator's decision and rated it non-blocking.

Resolution path is documentation, not refactor: add a CLAUDE.md bullet naming the carve-outs, plus close the doc-drift Should-fixes the architect and test-engineer surfaced.

## Recommended next steps (ordered)

The fix-pass is tightly scoped (~30 min of edits, no architecture change, no test refactor). After items 1-7 land, code-reviewer should spot-check the CLAUDE.md update is sufficient. If item 8 is included, test-engineer should re-run; otherwise it's already SHIP_READY by their verdict. Backend-architect re-review is NOT needed (no architecture change).

1. **CLAUDE.md carve-out documentation (resolves all 3 code-reviewer Criticals).** Add a bullet under "Conventions already in use" naming the allowed exceptions to the "All PostgREST/RPC traffic flows through `src/lib/db.ts`" rule:
   - `src/lib/auth.ts` — already exempt (pre-existing, edge-function helper).
   - `src/lib/webPush.ts` — already exempt (pre-existing).
   - `src/lib/authGate.ts` — new exemption (spec 063 verbatim port; reads `profiles` + `user_stores` on the post-sign-in / cold-start auth path; lives outside db.ts to keep staff concerns out of the admin data layer).
   - `src/lib/sessionRestore.ts` — new exemption (cold-start session probe; routes through `authGate.ts`).
   - `src/screens/staff/**` — new exemption (staff subtree is a verbatim port from imr-staff; reads `order_schedule`, `inventory_items`, `eod_submissions`; future migration through `src/lib/db.ts` is out of scope for spec 063 and tracked as a separate follow-up spec).
   - Note the rationale: "the carve-out covers code intentionally isolated outside the admin data layer; a future spec may migrate the staff reads if a unified data layer is desired."

2. **CLAUDE.md stale lines (resolves architect Should-fix #3a and test-engineer Should-fix #2).** Update line 62 ("Cmd UI is the only client. App.tsx mounts `CmdNavigator` unconditionally") → "App.tsx mounts `RoleRouter`, which dispatches to AdminStack (Cmd UI) or StaffStack based on `profiles.role`." Update line 66 ("intentional because staff use a separate app") → "Role gating now happens at RoleRouter via `profiles.role`; the legacy `useRole` hook returns `'admin'` and is unused by RoleRouter — keep until a future spec wires fine-grained admin sub-roles through it."

3. **Spec 063 `## Files changed` tail (resolves architect Should-fix #3b).** Populate the section at the bottom of `specs/063-fold-imr-staff-into-imr-inventory.md` with the actual files-changed list (visible via `git status`). The FE-dev was killed before completing this step.

4. **`src/screens/cmd/sections/BrandsSection.tsx:854` (resolves code-reviewer Should-fix #1).** Change the 4th arg from `'Delete'` to `'Demote'`. On native, the Alert button currently reads "Delete" for an action that demotes a user role — semantically wrong and a regression introduced by the new optional `confirmLabel` arg.

5. **`src/screens/cmd/sections/POSImportsSection.tsx:988` (resolves code-reviewer Nit, same pattern as #4).** Change the 4th arg from `'Delete'` to `'Remove'` for the "Remove alias" action. Lower severity than #4 because "delete"/"remove" are closer in meaning, but the same fix shape.

6. **Stale file header comments (resolves code-reviewer Nits).** Fix the path comments at the top of:
   - `src/screens/staff/screens/EODCount.tsx:1` → `src/screens/staff/screens/EODCount.tsx`
   - `src/screens/staff/screens/EODCount.test.tsx:1` → matching test path
   - `src/screens/staff/screens/StorePicker.test.tsx:1` → matching test path

7. **`src/screens/staff/README.md` (resolves code-reviewer Nit + architect Should-fix on the surviving scaffold doc).** Replace the stale "scaffold directory for the imr-staff app" text with a brief description of the staff subtree's role in the merged app.

8. **(Optional) LoginScreen hot-path gate test (resolves test-engineer Should-fix #1).** Add `src/screens/LoginScreen.test.tsx` covering the post-sign-in gate path that the deleted `src/screens/staff/screens/SignIn.test.tsx` used to cover. The four test shapes from the deleted file (bad credentials, not-staff gate, no-stores gate, happy path with single store) translate directly to LoginScreen's `handleLogin → checkAuthGate` flow. Lower priority than items 1-7 because the cold-start half of the gate IS covered by `sessionRestore.test.ts` and the hot-path was confirmed by the live browser smoke; this is coverage backfill, not a correctness gap.

### Re-review after fix-pass

- **code-reviewer**: re-run, narrow scope — verify the CLAUDE.md carve-out bullet is well-formed and that items 4-7 landed.
- **test-engineer**: re-run only if item 8 is included.
- **backend-architect**: NOT needed — no architecture change.
- Release-coordinator: re-synthesize after re-review. Expected single-cycle resolution.

## Out of scope for this review

- Migrating staff reads through `src/lib/db.ts`. The architect explicitly flagged this as a valid future follow-up — open a separate spec if/when a unified data layer is desired. Tracked in the CLAUDE.md carve-out's "future spec may migrate" rationale (item 1).
- Adding `RoleRouter.test.tsx` (test-engineer noted no dedicated test exists; manual browser smoke confirmed both paths; component is thin).
- `roleRouterNavRef` cleanup (code-reviewer Should-fix #2/#3). The ref is exported but never imported; safe to leave for now since the rollback-safety pattern is documented and a future spec wiring imperative navigation will use it.
- `StaffStack.tsx:65` React import style (code-reviewer Should-fix #4). Build passes via global type resolution; cosmetic inconsistency only.
- `App.tsx:18` alias-vs-string-tag minor redundancy (code-reviewer Nit).
- imr-staff GitHub repo archival (track D AC3/AC4) — happens after this ship is committed, per the spec's deliberate sequencing.

## Handoff

next_agent: NONE
prompt: FIXES_NEEDED, 7 items (plus 1 optional), top: add CLAUDE.md carve-out bullet documenting staff-subtree + authGate/sessionRestore as allowed exceptions to the db.ts convention; resolves all 3 code-reviewer Criticals without code refactor since the architect's design explicitly intended the verbatim port. Test suite green (316/316), zero contract drift, both reviewers other than code-reviewer signaled SHIP_READY.
payload_paths:
  - specs/063/reviews/release-proposal.md
