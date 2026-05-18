# Release proposal — Spec 049 (Cross-brand catalog copy) — RE-SYNTHESIS

## Verdict
verdict: SHIP_READY
rationale: All five FIXES_NEEDED items from the prior proposal landed cleanly; every reviewer is green (0 Critical / 0 Should-fix across code, security, test, and architect post-impl), the full pgTAP suite (29/29), jest suite (182/182), and typecheck all pass, and no new findings were introduced by the fixes.

## Findings summary
- code-reviewer: 0 Critical, 0 Should-fix, 4 Nits (all pre-existing carry-overs, explicitly out of scope for the fix pass). Confirmed each of SF1-SF5 is resolved: dead `v_source_count` + two table scans gone from the migration; both new section tests have the required negative-gate + positive-control shape; audit-row count tightened to `=4` with header/assertion now in agreement; admin-profile rejection arm (1b) split out using a transaction-scoped `UPDATE profiles SET role='admin'` fixture; `selectAllAria` removed uniformly across en/es/zh-CN.
- security-auditor: 0 Critical, 0 High, 0 Medium, 2 Low. Posture explicitly unchanged from the prior pass — both Low items are pre-existing and architect-acknowledged (P0001 vs 42501 SQLSTATE convention per §K8/§L; audit_log SELECT-policy gap for super-admin per §K9). Auditor confirmed the five fixes were bounded to test additions, a dead-var removal, a tightened assertion, and a dead-i18n-key cleanup — none touched the authorization boundary, INSERT paths, audit shape, GRANT lockdown, search_path, or gate-set ordering. The arm-split actually strengthens role-gate evidence (now exercises `profiles.role='admin'` as an independent call).
- test-engineer: 13 AC PASS, 0 FAIL, 2 NOT TESTED. Both prior Criticals are CLOSED. AC-B4/AC-N2 now have three independent role-rejection arms (1a master-profile, 1b admin-profile, 2 master with matching JWT). AC-N1/AC-F3 covered by 4 new jest arms across InventoryCatalogMode and VendorsSection (2 negative-gate + 2 positive-control per section). The two NOT TESTED items (AC-B5 defense-in-depth `auth_can_see_brand` rejection paths; AC-B7 explicit transactional-rollback arm) were never in the spec's §M plan and are explicitly accepted — not BLOCK findings. Full suite: 182/182 jest, 29/29 pgTAP, typecheck clean.
- backend-architect (post-impl): 0 Critical, 0 Should-fix, 0 new Minor. Per-fix verification of SF1-SF5 all PASS; cross-cutting contract checks (RPC signature, composite type, SECURITY DEFINER, gate ordering, ON CONFLICT semantics, skipped_names 20-bound, audit row mapping, GRANT/REVOKE shape, TS wrapper, no new rpc call sites, realtime publication unchanged) all unchanged. Three prior Minor findings are positive-direction carry-overs (audit `names` captures copied set vs source-ids set; TS interface shortened to `CopyCatalogResult`; pgTAP plan grew from designed 9 to implemented 14). No architectural drift.

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Commit the implementation** and deploy. The migration `20260518000000_spec049_cross_brand_copy.sql` is dev-applied and the test suites are green; production deploy can proceed under the standard migration path. The migration is additive (new vendors unique index with a pre-flight collision DO block, new composite type, new RPC, no destructive shape changes) and includes a pre-flight DO block that aborts cleanly if any `(brand_id, lower(name))` collision exists in `vendors` so the operator can dedupe before re-applying.

2. **(Optional, not blocking ship)** Run the manual browser walkthrough the implementer documented in spec §"Browser verification — NOT performed in this slice" — login as super_admin, exercise both bulk-copy and per-row copy on Ingredients and Vendors, then login as admin/master to verify the negative-gate hides all three affordances. The automated jest positive-control arms cover the render-tree gating; this is belt-and-braces verification before the first real super-admin uses the feature in prod.

3. **(Optional follow-ups, separate specs)** Items the reviewers flagged for tracking but not blocking this ship:
   - AC-B5 defense-in-depth `auth_can_see_brand` rejection arms in pgTAP — low value today because super-admin short-circuits to TRUE; add when a future scope-tightening spec lands.
   - AC-B7 explicit partial-failure rollback test — plpgsql transaction semantics make this implicit; add only if a real partial-failure scenario emerges.
   - SQLSTATE `P0001` → `42501` swap — architect-recommended to defer until a generic errcode-mapping layer lands and is applied in lockstep with `copy_brand_catalog`.
   - Code-reviewer's 4 carry-over Nits: `search_path = public, auth` vs `public`-only precedent (line 124 of the migration); `CopyCatalogResult` vs spec §F's `CopyCatalogRowsResult` name; redundant `e.stopPropagation?.()` optional chaining in both section files; `submitting` dep in `handleConfirm`'s `useCallback`. All cosmetic / low-impact and were explicitly out of scope for the FIXES_NEEDED pass.

## Out of scope for this review
- **Audit_log schema rewrite** to add `brand_id` + `payload jsonb` columns. Architect explicitly chose to adapt the audit row to the existing column inventory in §C rather than absorb a cross-cutting schema change into Spec 049. Separate spec.
- **`audit_log` SELECT policy widening** so super-admin can read its own cross-brand audit rows through PostgREST. Pre-existing gap flagged by both security-auditor and architect §K9. Separate spec.
- **Recipes / prep_recipes cross-brand copy.** Explicitly v2 per Spec 049 scope §"Out of scope"; FK remap to target-brand `catalog_ingredients` is the messy part.
- **`pos_recipe_aliases` and `ingredient_conversions` cross-brand copy.** Tightly menu/unit-coupled; v1 excluded by design.
- **Conflict-policy enum** (overwrite / append-with-suffix / refuse-on-conflict). v1 ships skip-only matching existing `copy_brand_catalog` semantics.
- **Multi-source-brand selection.** v1 is one-source → one-target only.
- **`app.json` slug change.** Stays `towson-inventory` per CLAUDE.md "DO NOT AUTO-FIX".

## Handoff
next_agent: NONE
prompt: SHIP_READY — all 5 prior FIXES_NEEDED items resolved; 0 Critical / 0 Should-fix across all four reviewers; full suite green (182/182 jest, 29/29 pgTAP, typecheck clean)
payload_paths:
  - specs/049-cross-brand-catalog-copy/reviews/release-proposal.md
