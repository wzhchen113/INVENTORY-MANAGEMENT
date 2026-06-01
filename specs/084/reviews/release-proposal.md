# Release proposal — Spec 084

`fetchBrandAdmins` NULL-brand email-inference blind spot + stale `auth.ts` comment

## Verdict
verdict: SHIP_READY
rationale: All four reviewers returned 0 Critical; the lone Should-fix and 2 nits were comment-accuracy items already folded in and re-verified (jest 9/9, tsc exit 0), so no reviewer findings remain outstanding.

## Findings summary
- **code-reviewer:** 0 Critical, 1 Should-fix, 2 Nits — ALL comment-accuracy items on this spec's own code, ALL resolved in the post-review fix-pass. Should-fix: stale word "brand" in the spec-082 inference-map comment block (the query is no longer brand-scoped for inference) — rewritten. Nit: `auth.ts` "IGNORED" → "UNUSED" to mirror the authoritative `db.ts` doc-block wording — fixed. Nit: arm (e) comment overstated regression-detection vs. the `eq`-ignores-args harness — clarified. The #1 flagged check (strict `inv.brand_id === brandId` predicate, no `|| == null` escape hatch) is correct.
- **security-auditor:** 0 across ALL severities (Critical/High/Medium/Low). Headline question — does dropping `.eq('brand_id', brandId)` widen what a non-super-admin can READ from `invitations`? — answered NO, independently re-verified against the live RLS chain: the `invitations` SELECT boundary is `using (public.auth_is_privileged())` (admin-OR-super_admin, zero brand scoping), not the client filter; any caller who can now read a brand's invitations could already read every brand's. The new strict `pendingInvites` gate is a display-narrowing that is strictly MORE restrictive. The `auth.ts` change is comment-only (operative line byte-for-byte unchanged). No dependency manifest touched (`npm audit` skipped, correctly).
- **test-engineer:** AC1–AC7 all PASS. 4 new jest arms (e NULL-brand inference, f pollution guard, f-bis foreign-brand strict-equality, g in-brand pending preserved); arms (a)-(d) intact. Pollution-guard arm (f) confirmed NON-VACUOUS (fails under both a full Edit-2 revert and the `|| == null` escape-hatch loosening); (f-bis) distinguishes strict equality from a NULL special-case. Local results: jest 44 suites / 410 tests green; targeted `fetchBrandAdmins` 9/9; `tsc --noEmit` (base) exit 0; `tsc -p tsconfig.test.json --noEmit` exit 0. No pgTAP / shell-smoke needed (TS-only, no migration/DB object). Explicitly deferred CI confirmation to the release-coordinator.
- **backend-architect (post-impl drift):** MATCHES DESIGN — 0 Critical, 0 Should-fix, 0 Minor. All five load-bearing decisions landed as designed; the strict-equality pending re-gate at `src/lib/db.ts:3345-3347` has no NULL escape hatch. Scope clean — only the three intended TS files changed; no migration / pgTAP / edge / RLS / realtime / store / frontend ride-along; `fetchInvitationsForUserLookup` / `consume_invitation` / the spec-083 backfill all left untouched. One positive deviation (developer added the optional (f-bis) strict-equality arm) — a strengthening, not drift.

## Recommended next steps (ordered)

SHIP_READY:

1. **Commit the staged change.** It covers 3 TS files plus the spec dir:
   - `src/lib/db.ts` (Edit 1 dropped `.eq('brand_id', brandId)` on the invitations query; Edit 2 added the strict `&& inv.brand_id === brandId` gate to `pendingInvites`)
   - `src/lib/auth.ts` (comment-only rewrite of the `fetchInvitationsForUserLookup` call site)
   - `src/lib/db.fetchBrandAdmins.test.ts` (new arms e / f / f-bis / g)
   - `specs/084/`
   You commit manually at your explicit gate — this proposal informs that decision; main Claude does not auto-commit.

2. **NO prod migration step.** This is TS-only. Spec 083's backfill (`20260531010000_invitations_brand_id_backfill.sql`) already repaired the data for the currently-affected users. Unlike spec 083, there is **NO `npx supabase db push --linked`** to run for 084 — running it would be a no-op. Do not run it.

3. **Deploy to web (Vercel auto-builds on push to `main`).** No native/EAS step required for this read-path fix.

4. **After the push, confirm CI is green.** Per project policy, verify the latest [.github/workflows/test.yml](.github/workflows/test.yml) run on `main` goes green (`gh run list --branch main --limit 1`). The pre-push baseline is already green — run 26729193808 (spec 083, head `140377e`), nothing pushed since — so the "don't SHIP when main's test.yml is red" hard rule is satisfied going in. Confirm the post-084 run lands green before treating the ship as complete.

5. (optional, non-blocking) Awareness item, not a ship blocker — see "Out of scope" below.

## Out of scope for this review

- **Non-admin invites can still be created NULL-brand, unguarded** (`src/lib/auth.ts:294`). Spec 084 fixed the READ-side blind spot (a NULL-brand invite no longer hides from email inference, and a NULL-brand UNCONSUMED invite no longer leaks as a phantom pending row); it did NOT change the WRITE-side policy. Admin invites are guarded (`auth.ts:274-276`); non-admin invites insert `brand_id: opts.brandId` with no guard, so a caller omitting `brandId` can still mint a new NULL-brand unconsumed invitation. This is why the strict-equality pending-row guard is load-bearing for current/future data, not just legacy drift. Whether the non-admin invite path SHOULD require a `brand_id` is a write-side behavior change and a candidate FUTURE spec — explicitly out of scope here (the spec marks it so), and NOT a blocker. If that future spec adds the write guard, it should keep this read-side row gate anyway (defense in depth — different layers).
- **The bootstrap super_admin with no invitation row** remains "(email not loaded)" — there is no invitation to infer from. Accepted gap, identical to spec 083.
- **Adding an email column to `profiles`** — the email-via-`invitations` inference model stays (same model spec 082/083 kept).
