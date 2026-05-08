# Release proposal — Spec 008 (Sidebar layout customization) — fix-pass re-synthesis

## Verdict

**verdict: SHIP_READY**

**rationale:** All four reviewers report 0 Critical and 0 acceptance-criteria FAIL after the fix-pass; the prior two AC-Q10 FAILs (cross-group ←/→ keyboard reorder, `H` hide-shortcut) are now PASS, browser-verified by main Claude. Remaining items are deferrable nits and one architecturally-endorsed Medium server-side guard that the auditor explicitly says does not block deploy.

This re-synthesis supersedes the prior FIXES_NEEDED proposal. The fix-pass closed all 5 items from that proposal (architect S1 + S2 + S3, code-reviewer #2 / architect N1, code-reviewer #3 / test-engineer Finding 1). Net delta: from 5 Should-fix + 2 AC FAIL → 1 Should-fix (defensive only, no live bug) + 0 AC FAIL.

---

## Findings summary

- **code-reviewer (re-spun post fix-pass):** 0 Critical, 1 Should-fix, 3 Nits.
  - Should-fix: defensive `H`-shortcut guard against `INPUT` / `TEXTAREA` / `[contenteditable]` focus targets at `src/components/cmd/SidebarEditMode.tsx:178-190`. Reviewer explicitly notes "no text inputs exist in this tree today" — defensive only, no live bug. The eye-toggle button case the reviewer also flags is a focus-context nuance (focus on the eye button while pressing `H` would still toggle hide), not a regression from spec intent.
  - Nits: subtle dnd-kit comment clarification (line 113), `preventDefault` rect-guard comment polish (line 152), over-documented one-line `coerceSidebarLayout` JSDoc (`src/lib/auth.ts:21-31`).
  - Prior items #1, #2, #3 (paired with architect S3, the `useDroppable` swap, and the `coerceSidebarLayout` ↔ `isValidOverride` unify) all explicitly RESOLVED in the status table at the top of the review file.

- **security-auditor (carry-forward; not re-spun because fix-pass touched no RLS / write-path / auth surface):** 0 Critical, 0 High, 1 Medium, 3 Low.
  - Medium: no server-side bound on `profiles.sidebar_layout` JSONB size or shape; recommended additive `pg_column_size(sidebar_layout) < 16384` CHECK constraint. Self-DoS scope only (per-user RLS). Auditor explicitly states "does not block deploy."
  - Low items: `select('*')` in `fetchProfile` (future PII concern, informational); one redundant UPDATE per login on hydration (now informational since fix-pass split it into a hydrator); `setSidebarLayoutOverride` userId-from-store cross-checked clean against existing RLS policies (no finding — passing).
  - Auditor independently re-verified the architect's RLS inheritance claim, the JSONB read-path defenses, the absence of `useRole` branches, the absence of new secrets/PII in logs, and the `@dnd-kit/*` dependency tree (zero new advisories).

- **test-engineer (re-spun post fix-pass):** **16 PASS, 0 FAIL, 5 CODE-VERIFIED.** Both prior AC-Q10 FAILs (cross-group ←/→ keyboard reorder, `H` hide-shortcut) now PASS — verified by code inspection plus main Claude's live browser walk: Space→→Space moved Inventory OPERATIONS → PLANNING; focused DBInspector + `H` flipped ◉ → ⊘. Fix-pass closure table confirms all 5 prior release-proposal items CLOSED. Remaining minor items: screen-reader announcement format diverges from §9 ideal (explicitly out-of-scope per the spec itself); `handleDragOver` closure-vs-ref pattern is correct as-is, no action; `produceOverride` empty-save edge case re-checked and confirmed correct.

- **backend-architect (drift re-review):** 0 Critical, 0 Should-fix, 1 Nit. All three prior Should-fix items (S1 cross-group keyboard, S2 `H` shortcut, S3 hydrator/setter split) RESOLVED. N1 (`useDroppable` swap on `EmptyGroupDropZone`) RESOLVED, with the architect explicitly noting the swap *strengthened* the §6 contract (the prior `useSortable` reach was a "bug-disguised-as-a-feature" for keyboard reachability; the new `useDroppable` is the canonical primitive and is reachable cleanly by both pointer and the new keyboard coordinate-getter). Only N2 remains (memoize id-to-group map for `handleDragOver`; future scaling note, not a current concern at 3 groups × 17 items). Architect explicitly endorses the `hydrateX` / `setX` naming as "better than the legacy dark-mode names" and "the going-forward convention" for any future persisted-preference store slot.

---

## Recommended next steps (ordered)

1. **Commit and deploy.** All four reviewer outputs are clean: 0 Critical, 0 acceptance-criteria FAIL. The two prior AC-Q10 FAILs (the only blockers from the previous proposal) are now PASS, browser-verified by main Claude. Hard-rule check: no reviewer flagged Critical, so SHIP_READY is available.

2. **(optional) Pre-push inline polish — defer recommended.** The code-reviewer's single Should-fix (H-guard for text inputs) is ~3 lines:
   ```ts
   if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || (target as HTMLElement)?.isContentEditable) return;
   ```
   added before the existing `closest('[data-sidebar-item-id]')` walk in `SidebarEditMode.tsx:178-190`. Defensive-only with no live bug today. Recommend deferring to the follow-up chore PR alongside the other deferred items rather than expanding scope on this push.

3. **(forward-looking convention) Record naming endorsement.** The backend-architect explicitly endorses `hydrateX` (no-persist) / `setX` (persisting + optimistic-revert) as the new project convention for persisted-preference store slots, calling out that the legacy `setDarkMode` / `toggleDarkMode` pair carries the no-persist semantic only by accident. Worth capturing in CLAUDE.md or a future spec template note (parallel to spec 003's "pre-mutation per-prep assertion ordering" endorsement). Not blocking.

4. **(separate user-authorized step) Prod migration push.** `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql` is local-only today. Architect and security-auditor both confirm it's purely additive on a per-user RLS-gated row (no breaking change, no policy work needed, no realtime publication work needed). User authorization required to push to prod.

---

## Out of scope for this review (defer to follow-ups)

- **Server-side JSONB size/shape CHECK constraint** (security-auditor Medium) — additive migration; per-user RLS already bounds blast radius (self-DoS only). Project-meta convention for JSONB-size guards; ship as a separate small follow-up at convenience. Not deploy-blocking per the auditor.
- **`H`-shortcut text-input focus guard** (code-reviewer Should-fix) — defensive-only; no live bug because the edit-mode tree contains no text inputs today. Future spec template improvement.
- **Memoize id-to-group map in `handleDragOver`** (architect N2) — future scaling concern; current scale (51 comparisons/event) is fine.
- **Screen-reader announcement richness** (test-engineer Finding 1) — spec §"Out of scope" already defers full a11y audit to a follow-up spec. Functional announcements fire today; only the row-position + group context is missing.
- **Code-reviewer N1–N3** — dnd-kit comment clarification (line 113), `preventDefault` rect-guard comment polish (line 152), over-documented one-line JSDoc on the unified `coerceSidebarLayout` wrapper. Chore PR.
- **Deferred prior-proposal items S4 + S5** — `SidebarGroup` import-dedupe and `as any` / intersection-cast cleanup. Chore PR per the prior release-proposal's explicit deferral.
- **Pre-existing transitive-dep advisories** (`@xmldom/xmldom`, `dompurify`, `postcss`) — not introduced by this spec; tracked separately. `@dnd-kit/*` itself is clean.
- **Design-doc §0.6 wording correction** — `profiles` *is* on the realtime publication (`for all tables`); the substantive "no realtime work needed" claim still holds because RLS scopes deliveries per-JWT and the app does not subscribe to `profiles` changes. Informational doc-only fix.
- **Test framework** — still none in the project per CLAUDE.md "Gaps and unknowns." `applySidebarOverride` / `produceOverride` / `isValidOverride` are designed to be unit-testable but no harness exists. Project-wide decision, not a Spec 008 deliverable.

---

## Handoff
next_agent: NONE
prompt: SHIP_READY. 0 Critical across all four reviewers, both prior AC-Q10 FAILs now PASS (browser-verified), all 5 fix-pass items confirmed CLOSED. Remaining items are deferrable nits + one Medium server-side JSONB-size CHECK (additive follow-up). Authorize prod push of `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql` plus commit + push to GitHub for Vercel redeploy.
payload_paths:
  - specs/008-sidebar-layout-customization/reviews/release-proposal.md
