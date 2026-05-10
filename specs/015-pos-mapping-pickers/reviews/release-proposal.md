## Verdict
verdict: SHIP_READY
rationale: All three surfaces verified end-to-end; no real Critical (the code-reviewer's flag is a convention dispute the architect resolved by design in §9, and the security-auditor / test-engineer / backend-architect found 0 Criticals between them).

## Findings summary

- **code-reviewer:** 1 Critical (debatable), 4 Should-fix, 7 Nits.
  - The "Critical" — `fetchUnmappedPosImports` called directly from the screen — does not match the hard-rule definition (security / broken AC / contract drift / broken build). CLAUDE.md says "All PostgREST/RPC traffic flows through `src/lib/db.ts`"; the helper IS in `db.ts`. The reviewer's own caveat acknowledges the architect's §9 explicitly designed this and that spec 014's `savePOSImport` is the same shape. Treat as a project-wide convention question (store-mediated vs. direct-from-screen), not a 015 deploy blocker.
  - Top Should-fix items: (a) unreachable `catch` in `handlePickForUnmapped` because `upsertPosRecipeAliases` swallows errors (matches architect's M2); (b) missing `void` on fire-and-forget `removePosRecipeAlias` call; (c) `removePosRecipeAlias` uses async/await + try/catch instead of the spec's referenced `.catch()` pattern (functionally equivalent); (d) "esc" hint label rendered on native (handler is correctly web-gated, label is not).
  - Nits are low-value (style, comment requests, micro-refactors).

- **security-auditor:** 0 Critical, 0 High, 0 Medium, 3 Low. **All Lows are pre-existing or stale-spec-doc, none introduced by 015.** Important correction surfaced by the auditor: the spec body's §2 RLS warning ("any-authed-user can DELETE a global alias via direct PostgREST") and the architect's matching follow-up recommendation are **stale** — the 2026-05-09 multi-brand RLS migration (`20260509000000_multi_brand_schema_rls.sql:909-970`) already replaced those policies with `auth_is_privileged()` + `auth_can_see_brand()`. Cross-brand isolation IS enforced by RLS today; only intra-brand cross-store cleanup remains, and the UI filter mitigates it. Defense-in-depth on `removePosRecipeAlias` (UI hide + store-action store_id filter + `.eq('store_id', storeId)` PostgREST filter + RLS) verified at three layers. The architect's recommended "follow-up RLS hardening" spec should be re-scoped doc-only, not actioned as written.

- **test-engineer:** 23 PASS, 0 FAIL, 6 NOT TESTED. Acceptance criteria status:
  - Surface 1 (BreadbotPreviewCard per-row picker): 2 PASS, 5 NOT TESTED — environmental (live Breadbot upstream unreachable from local stack, same gap as spec 014). Static analysis confirms wiring is correct on all 5.
  - Surface 2 (mapping.tsx editor): 6 PASS, 1 NOT TESTED — the EDIT button on a confirmed alias was not exercised in the walkthrough. Static analysis confirms the path is wired correctly.
  - Surface 3 (past-30-days unmapped review + retroactive flip): 5 PASS, 0 NOT TESTED.
  - Cross-cutting (single picker component, palette, escape-to-close, no migrations): 5 PASS, 0 NOT TESTED.
  - **No FAIL findings.** No acceptance criterion is broken; the 6 NOT TESTED items are all "couldn't exercise live" not "doesn't work."

- **backend-architect (post-impl drift):** 0 Critical, 0 Should-fix, 2 Minor. M1: EDIT button hidden alongside REMOVE on global rows — defensible per §11 spirit (avoids the footgun of silently shadowing a global with a store-scoped override); recommend updating spec line 94 wording rather than the code. M2: `upsertPosRecipeAliases` swallows errors (`console.warn` only, never throws) — this is pre-existing code from spec 014, NOT introduced by 015, and the spec design §3/§7c explicitly carries it forward unchanged. Same surface code-reviewer flagged in their unreachable-catch Should-fix.

## Recommended next steps (ordered)

1. **Commit and deploy.** Browser walkthrough verified all three surfaces end-to-end (mapping tab interactive, picker modal opens, search filters, recipe pick → alias created + retroactive flip toast, REMOVE → alias deleted, GLOBAL badge + remove hidden for `store_id=null` aliases). Type-check clean. No Critical findings under the hard-rule definition. Commit at the user's discretion (per CLAUDE.md: "Main Claude does not auto-commit on SHIP_READY").

2. *(optional, follow-up)* **Doc-only spec amendment for the stale RLS warnings.** Update `specs/015-pos-mapping-pickers.md:382-423` and the related "follow-up RLS hardening — pos_recipe_aliases" recommendation to reflect post-2026-05-09 reality: RLS already enforces `auth_is_privileged()` + `auth_can_see_brand()`; the remaining gap is intra-brand cross-store, not "any-authed-user." Architect §11's "purely cosmetic" framing of the global-alias UI gate should be softened to "defense-in-depth within a brand." This is a doc fix, not a code change.

3. *(optional, follow-up spec)* **Align `upsertPosRecipeAliases` with the throw-on-error contract.** Change the existing store action to throw + revert (mirroring `removePosRecipeAlias` and `deletePosRecipeAlias`). Once that lands, the wrapping try/catch in `handlePickForUnmapped` becomes meaningful, the missing-`void` style nit goes away (it stops being fire-and-forget), and the silent-failure path the architect flagged in M2 closes. This is a project-wide consistency improvement that touches spec 014's confirm path too.

4. *(optional, follow-up)* **Trivial polish in the same area when convenient:**
   - Wrap the "esc" hint label in `Platform.OS === 'web' ? ... : null` in `RecipePickerModal.tsx:128, 289` (the keydown handler is already web-gated; the label isn't).
   - Add a one-line comment on the `previewOverrides` useEffect dep list (`POSImportsSection.tsx:78-91`) explaining why it's needed, so a future maintainer doesn't strip it.
   - Either update the spec wording on line 94 to "EDIT button hidden on global rows per §11" OR re-introduce EDIT on global rows with a picker-side warning (architect M1's recommendation: update the spec, not the code).

5. *(optional, follow-up)* **Promote the 6 NOT TESTED acceptance criteria to PASS** when a Breadbot token is wired into local dev or when a manual probe of the EDIT button on a seeded store-scoped alias is run. None of these are blocking; the Surface 1 NOT TESTED items have the same env constraint as spec 014, which already shipped under the same gap.

## Out of scope for this review

- **Convention question — store-mediated vs. direct-from-screen PostgREST calls.** The code-reviewer's Critical and the trailing nit on spec 014's `savePOSImport` both point at this. Today the codebase has both shapes; if the team wants one canonical pattern, that's a CLAUDE.md amendment + a refactor spec touching multiple call sites, not a 015 fix.
- **Per-store RLS boundary inside a brand for `pos_recipe_aliases`.** The 012a multi-brand migration moved this table to brand-scoped RLS via the parent recipe. Deciding whether per-store isolation inside a brand is a real security boundary or just a UX convenience is a separate scoping question (security-auditor L3).
- **No-test-framework gap.** Persistent across the project per CLAUDE.md. Surface to PM for prioritization; not a per-spec deliverable.
- **Live-Breadbot test pass for Surface 1 acceptance criteria.** Same env constraint as spec 014; needs a Breadbot token or a mocked upstream, not a code fix.
- **CSV-path per-row picker, Toast/Square/Clover connector wiring, retroactive inventory deduction.** Explicitly out of scope per spec §"Out of scope" — all honored by the implementation.
