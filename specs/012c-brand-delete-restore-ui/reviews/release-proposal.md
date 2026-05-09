# Release proposal — Spec 012c

## Verdict

**FIXES_NEEDED** (2 code-reviewer Criticals — both mechanical fixes; small inline cleanup bundle suffices, no rework).

rationale: Two Critical findings (double-toast on soft-delete-of-current; misleading `counts` variable name in `mapCascadePreview`) are real but ~3 LOC total. Per the hard rule, any Critical forces FIXES_NEEDED, but the destructive round-trip is otherwise sound (probe walk PASS, 0 security Criticals, 0 architect drift, 14/14 testable ACs PASS).

## Reviewer roll-up

| Reviewer            | Critical | Should-fix | Notes / Nits / Deviations           | Output file                                                          |
|---------------------|----------|------------|--------------------------------------|----------------------------------------------------------------------|
| code-reviewer       | 2        | 5          | 5 nits                               | `specs/012c-brand-delete-restore-ui/reviews/code-reviewer.md`        |
| security-auditor    | 0        | 0          | 7 warnings (all pre-existing or defensive observations) | `specs/012c-brand-delete-restore-ui/reviews/security-auditor.md`     |
| test-engineer       | 0        | 0          | 14 PASS, 0 FAIL, 2 NOT TESTED (R4 no-impl, U1 covered by probe walk); 4 minor deviations | `specs/012c-brand-delete-restore-ui/reviews/test-engineer.md`        |
| backend-architect   | 0 drift  | 3          | 4 acceptable deviations (filename bump; `ingredient_conversions` chain blocker fix; P3 stale entries; revert-path toast pair) | `specs/012c-brand-delete-restore-ui/reviews/backend-architect.md`    |
| probe-walk (§10)    | —        | 1          | Super-admin destructive path PASS at desktop 1440 (DELETE → soft-delete → Trash → RESTORE round-trip). Inline rename click did not trigger edit mode. | `specs/012c-brand-delete-restore-ui/reviews/probe-walk.md`           |

Security verdict: ships safely. The single behavioral concern (W1 — `callEdgeFunction` swallows non-2xx) is pre-existing and surfaced because 012c is the load-bearing consumer; flag as out-of-scope follow-up.

## Cleanup bundle (apply pre-commit AND pre-prod-push)

> This is the destructive-ops spec — the bundle MUST be applied before the user authorizes prod push, not just before commit. The local migration is applied locally only; prod push happens after this bundle lands and the user explicitly authorizes "push to prod".

Ordered by severity. Items deduplicated where reviewers overlapped (architect should-fix #1 ≈ probe-walk caveat; code-reviewer should-fix on `'#FFF'` literals dedup'd against code-reviewer should-fix on `as any` since both are "small frontend hygiene"; test-engineer items 4 and 6 dedup'd against architect's commentary).

### Critical (block ship — must apply)

1. **`src/screens/cmd/sections/BrandsSection.tsx:149` (+ ref `src/store/useStore.ts:543-551`)** — Double toast on soft-delete-of-current-brand. Remove the screen-level `Toast.show({ type: 'info', text1: 'Soft-deleted "X"' ... })` in `handleSoftDelete` and rely solely on the store-side auto-swap toast (which has better copy: "Switched to All brands view"). ~2 LOC.

2. **`src/lib/db.ts:1757`** — Rename misleading `counts` local in `mapCascadePreview` to `profileCounts` (or `roleCounts`). It holds `p?.blocking_profile_counts`, not the per-table counts read at line 1774. Maintenance trap, not a runtime bug. ~1 LOC.

### Should-fix (apply in same bundle to keep destructive-ops surface tidy)

3. **`src/screens/cmd/sections/BrandsSection.tsx:865`** — Extend `MembersTab.canActOn` to include `'user'` role (architect should-fix #1, also flagged by probe walk caveat). Without this, a stale `user`-role profile blocking H5 pre-flight forces the super-admin to drop to SQL — exactly the workflow the spec set out to avoid. Q-A's strict REJECT semantic relies on the operator having a UI affordance. Smallest patch: change `(u.role === 'admin' || u.role === 'master')` → `(u.role === 'admin' || u.role === 'master' || u.role === 'user')`.

4. **`src/store/useStore.ts:558`** — `softDeleteBrand` revert path calls `setCurrentBrandId(prevBrandId)` which side-effects a full `loadFromSupabase`. On intermittent failures the operator gets a correct revert plus a redundant full reload. Use `set({ currentBrandId: prevBrandId })` directly. ~1 LOC.

5. **`supabase/migrations/20260510010000_brand_delete_cascade.sql:619`** — `preview_brand_cascade` returns the `user_stores` table count under JSON key `'user_stores_links'`. CascadePreviewModal renders the key verbatim, so the operator sees a label that sounds like an FK relationship instead of the actual table name. Rename the key to `'user_stores'` in the RPC. (Migration is applied locally only — re-running `npx supabase db reset` against the edited migration is the cheapest path; no separate fix-up migration required pre-prod-push.) **Important: this MUST land before prod push, since the migration would otherwise ship the wrong key name to prod.**

6. **`src/store/useStore.ts:626-633`** — `loadBrandStatsIncludingDeleted` overwrites the shared `brandStats` slice with soft-deleted brands. No other consumer today, but contract drift is silent. Either add a separate `brandStatsWithDeleted` slice (cleaner) or document at the type definition. Recommend the doc-comment route for now to keep the bundle small; defer the slice split to a follow-up.

7. **`src/components/cmd/TypeToConfirmModal.tsx:298` + `src/screens/cmd/sections/BrandsSection.tsx:704`** — Replace `as any` casts on `outlineStyle: 'none'` with the typed `webInputStyle` extension pattern already established in `BrandFormDrawer`. CLAUDE.md prohibits `as any` for type-error suppression. ~4 LOC.

### Nits (bundle if cheap; fine to defer)

8. **`src/components/cmd/CascadePreviewModal.tsx:95`** — Comment cites `§211` (line-number artefact). Change to `§11 risk #4`.

9. **`src/components/cmd/TypeToConfirmModal.tsx:194`, `CascadePreviewModal.tsx:251`, `BrandsSection.tsx:890`** — Inline `'#FFFFFF'` / `'#FFF'` literals on destructive button text. Reuse `C.accentFg` with a comment, or add `dangerFg` token. Cosmetic.

10. **Spec body update (not code)** — `specs/012c-brand-delete-restore-ui.md` references migration filename `20260510000000_*` in §0 probe #9 and §12, but the actual filename is `20260510010000_*` (012b took the earlier slot). Update spec body to reflect actual filename. Per CLAUDE.md, release-coordinator does not edit the spec — surface for the user.

## Justification

The hard rule is unambiguous: any reviewer Critical forces FIXES_NEEDED. Code-reviewer flagged 2 Criticals. Both are mechanical (~3 LOC total) and well-scoped — they do not require redo, redesign, or re-review. The established session pattern (Specs 010, 011, 012a, 012b) has been: apply small Should-fix cleanup bundle inline pre-commit, user authorizes commit, user authorizes prod push. That pattern fits cleanly here, with the reinforcement that **for this destructive-ops spec the cleanup bundle MUST land before prod push** — particularly item #5 (the migration JSON key rename), which would ship a wrong label to prod if pushed before the fix.

Otherwise, the spec is solid: the security audit verified five gating layers on hard-delete and zero PII exfiltration vectors, the architect found zero critical drift (only one absorbed-into-design lesson about the `ingredient_conversions` chain blocker), the test engineer marked 14/14 testable ACs PASS, and the probe walk confirmed the super-admin destructive round-trip works end-to-end at desktop 1440 with zero console errors.

## Out-of-scope follow-ups

These were flagged by reviewers but belong to a separate spec, not this commit:

- **W1 from security-auditor** — `callEdgeFunction` (`src/lib/auth.ts:108-127`) silently swallows non-2xx edge-function responses. Pre-existing; surfaced because 012c is the first spec to wire `deleteUser` into a destructive UI flow that depends on observing the result. Worth its own small spec.
- **W2 from security-auditor** — `demoteProfileToUser` is a direct PostgREST UPDATE, not a SECURITY DEFINER RPC. Re-exposes the base `Own profile` policy surface. Architect explicitly accepted as-is for 012c. Future spec should wrap as SECURITY DEFINER with `caller.id != target.id` server-side check.
- **Server-side self-protection for `demoteProfileToUser` and `delete-user`** (test-engineer §3, security-auditor W3 caveat). UI guard is currently the sole protection. Future hardening spec.
- **Single "MANAGE" button vs. two distinct "Manage admins" / "Manage users" deep links** (test-engineer item 2). Functionally equivalent today; will need splitting only if user-management ever lives in a separate section.
- **`preview_brand_cascade` includes `super_admin` in `blocking_profiles` while `hard_delete_brand` H5 pre-flight excludes them** (test-engineer item 3). Currently impossible-by-CHECK-constraint to hit, but worth aligning the mental model in a future cleanup.
- **`loadBrandStatsIncludingDeleted` swallows errors via `console.warn` instead of `notifyBackendError`** (test-engineer item 4). Minor; defer.
- **`MembersTab.handleDemote` uses `confirmAction`, which on native always labels the destructive button "Delete"** (architect should-fix #2). Would mislabel a Demote action as "Delete" on native. Fix lives outside 012c — either parameterize `confirmAction` or use a custom inline confirm.
- **Inline rename click did not trigger edit mode** (probe walk #10 + architect should-fix #3). Architect's drift review and probe walk both surfaced; rename happy path is verified at the RPC layer (R1 PASS), but the inline-rename-from-h1-click affordance needs investigation. Defer to a small frontend follow-up unless the user wants it folded into this bundle.
- **Test framework gap** (test-engineer §"Test framework gap"). Sixth consecutive spec with no automated coverage. Recommend explicit prioritization at next spec planning session.
- **Belt-and-braces final assertion scope** (architect notes) — the §4 assertion in the migration scans only the four brand-direct FKs; backend-dev caught the `ingredient_conversions.catalog_id` chain blocker via a separate full pg_constraint scan. Future architect should tighten the assertion to include all FKs reachable via the brand cascade chain.
- **`brandDeletionLog` slice in store is unused by any v1 UI** — wired up for a future History tab. Acknowledge but do not gate ship.

## Handoff

next_agent: NONE
prompt: FIXES_NEEDED, 2 Criticals + 5 Should-fix in cleanup bundle (~mechanical, ~30 LOC total). Bundle MUST land pre-commit AND pre-prod-push for this destructive-ops spec — particularly the `user_stores_links` → `user_stores` JSON-key rename in the migration. Top: double-toast on soft-delete-of-current-brand.
payload_paths:
  - specs/012c-brand-delete-restore-ui/reviews/release-proposal.md
