## Verdict
verdict: SHIP_READY
rationale: All 8 round-1 Criticals (4 security, 3 code-review, 1 backend-architect) are PASS in round 2; no reviewer currently has an unresolved Critical / High / Should-fix that blocks deploy.

## Findings summary
- backend-architect: round-1 had **1 Critical** (in-repo `staff-eod-submit/index.ts` not updated → every sibling-app POST would fail with errcode `22023` from the legacy 6-arg overload) — **RESOLVED** in round-2 patch (`supabase/functions/staff-eod-submit/index.ts:63,79,125` adds `vendor_id?: string` to `Body`, validates non-empty in `validate()`, passes `p_vendor_id` to the 7-arg overload). Three approved cosmetic drifts (overload-vs-`_v2` naming, `p_vendor_id` arg position, errcode `22023` vs `P0001`) all preserved as improvements over the design draft. Forward-compat for spec 021 confirmed.
- code-reviewer: round-1 had **3 Critical + 3 Should-fix + 6 Nits**.
  - C1 `fetchRecentEodDates` no dedupe → variance template `from == to` 22023 → **RESOLVED** (`src/lib/db.ts:616-636` `Set`-based dedupe; over-fetch via `Math.max(limit*8, 16)`).
  - C2 inverted Q6 guard → admin-JWT `db.adjustItemStock` mutates null-vendor items → **RESOLVED** (`src/store/useStore.ts:1381` strict equality `item?.vendorId === subVendorId`; null-vendor items now bypass the local mutation and the `adjustItemStock` call).
  - C3 legacy `EODCountScreen.tsx` 3× `TS2345` errors on required `vendorId` → **RESOLVED** via `vendorId: ''` stub at line 528 + `(myTodaySubmission as any).vendorId || ''` at line 678 (loud-fail 22P02 if the legacy path is ever executed; behind `EXPO_PUBLIC_NEW_UI=false`, prod runs `true`). Remaining `TS2322` at line 1177 is unrelated pre-existing.
  - All 3 Should-fix addressed (draft-state clears moved inside `try` post-await; `submitted_by` NULL semantics documented in v2 RPC header; audit `· vendor:` suffix shape preserved on both paths).
  - 6 Nits deferred as out-of-scope.
- security-auditor: round-1 had **4 Critical + 1 High + 1 Medium + 2 Low**; round-2 verifies **all** of C1–C4 + H1 PASS via live PoCs on local stack under `manager@local.test` and `admin@local.test` impersonation.
  - C1 `submitted_by` forgery → blocked by `eod_submissions_set_submitted_by_trg` BEFORE INSERT/UPDATE trigger.
  - C2 cross-store `item_id` spoof → blocked by `eod_entries_check_store_trg` BEFORE INSERT/UPDATE trigger (raises `42501` on store mismatch and on RLS-hidden items).
  - C3 store-member UPDATE rewrite → `store_member_update_*` policies dropped; replaced with `admin_update_*` gated on `auth_is_privileged() AND auth_can_see_store(...)`.
  - C4 DELETE by store member → both `store_member_delete_*` policies dropped (append-only; FK cascade from `stores.id` still works as the `postgres` role).
  - H1 edge-function pre-update sibling-app handling → 7-arg RPC wired + `400 vendor_id required` validation.
  - 0 new Critical/High/Medium. 1 informational note: admin EDIT overwrites `eod_submissions.submitted_by` to editor's UID, but `audit_log` preserves the original attribution per submit/edit row (documented in `20260514120030_eod_submissions_consistency.sql` header lines 44-53). 1 informational Low (polish: malformed-UUID `vendor_id` returns 500 instead of 400).
- test-engineer: **12 PASS, 0 FAIL, 0 NOT TESTED** across AC1–AC12. Both round-1 ship-blockers (SB1 edge function + SB2 legacy TS errors) RESOLVED. Round-2 P1 items (Q6 null-vendor guard, `fetchRecentEodDates` dedupe, draft-clear-on-failure) all PASS. C1–C4 trigger/policy verifications all PASS via direct SQL and `curl` against local stack. Pre-existing `AuditLogSection.tsx` audit-detail rendering gap noted as out-of-scope. No regressions introduced. No test framework (project policy per CLAUDE.md).

## Round-1 → Round-2 Critical resolution table

| # | Source | Round-1 Critical | Round-2 Status | Verified by |
|---|---|---|---|---|
| 1 | security-auditor C1 | `submitted_by` forgery via direct PostgREST INSERT | PASS | `eod_submissions_set_submitted_by_trg` BEFORE INSERT/UPDATE trigger live (PoC: manager INSERT with forged `submitted_by='11111…'` returned own UID `22222…`); column-omission vector also closed |
| 2 | security-auditor C2 | Cross-store `item_id` spoof on `eod_entries` INSERT | PASS | `eod_entries_check_store_trg` raises `42501` on store mismatch and on RLS-hidden parent/item lookups; UPDATE-vector also closed |
| 3 | security-auditor C3 | Store-member UPDATE rewrites audit fields | PASS | `store_member_update_*` policies dropped; only `admin_update_*` remain (gated on `auth_is_privileged()`); Cmd UI admin EDIT path preserved |
| 4 | security-auditor C4 | Store-member DELETE destroys audit trail | PASS | Both DELETE policies dropped; manager + admin DELETE both return `0 rows`; FK cascade-from-stores still works as `postgres` role |
| 5 | code-reviewer C1 | `fetchRecentEodDates` does not dedupe → variance template `from == to` | PASS | `src/lib/db.ts:635` `[...new Set(data.map(r => r.date))].slice(0, limit)`; verified against 3 dates × 2 vendors each |
| 6 | code-reviewer C2 | Inverted Q6 guard updates null-vendor item's `current_stock` via admin-JWT path | PASS | `src/store/useStore.ts:1381` strict equality `item?.vendorId === subVendorId`; null-vendor item stayed at `0.000` after LEOPARD submit (value 99.9) |
| 7 | code-reviewer C3 | Legacy `EODCountScreen.tsx` 3× `TS2345` `vendorId` errors → TS-strict build broken | PASS | `npx tsc --noEmit` shows no `vendorId`-related errors at lines 528/537/671; stub strings cause loud `22P02 invalid input syntax for type uuid` if executed; legacy path is gated by `EXPO_PUBLIC_NEW_UI=false`, prod is `true` |
| 8 | backend-architect | In-repo `staff-eod-submit/index.ts` still calls deprecated 6-arg RPC → 500 on every staff-app POST | PASS | `supabase/functions/staff-eod-submit/index.ts:63,79,125` adds `vendor_id` to Body, validates non-empty, passes `p_vendor_id` to the 7-arg overload; `POST` with `vendor_id` → 200, without → 400 clean `"vendor_id required (spec 020 per-vendor partitioning)"` |

## Recommended next steps (ordered)

1. **User reviews the staged diff and commits.** Per CLAUDE.md: do not auto-commit; the user confirms. Verifying triggers + policies + RPC arity on the **prod** database (`pg_trigger`, `pg_policies`, `pg_proc.pronargs`) is a recommended pre-deploy sanity step — the local-stack confirmation in the test-engineer + security-auditor reports does not substitute for the prod-side check.
2. **Coordinate sibling staff-app deploy with this repo's edge-function ship.** This is the load-bearing rollout-order callout. The legacy 6-arg `staff_submit_eod` overload now raises `22023` fail-loud, and the only working callsite is the 7-arg overload via the in-repo edge function patched in round 2. The **sibling staff-app's caller** (which lives in a separate repo, out of scope for this PR) must also be updated to pass `vendor_id` **before or simultaneously with** this repo's PR landing on prod. Per spec §7:
   - Step 3: apply migrations `20260514120000_eod_submissions_vendor_id.sql` + `20260514120010_staff_submit_eod_v2.sql` + `20260514120020_report_run_variance_multivendor.sql` + `20260514120030_eod_submissions_consistency.sql` to prod.
   - Step 4: deploy this repo's edge function update (in this PR).
   - Step 5: deploy the sibling staff-app caller update (out of repo, user-coordinated).
   - Until step 5 lands, the sibling staff-app fails with `400 vendor_id required (spec 020 per-vendor partitioning)` — the architect-designed fail-loud window.
3. **(Optional follow-ups, do NOT block ship; file as separate tickets if desired)**:
   - 6 nits from code-reviewer: defensive-`DROP CONSTRAINT IF EXISTS` comment, `client_uuid` cross-vendor idempotency wording, `currentVendorSubmission` memo subscription scoping, `fetchTodaysEODForStores: Promise<any[]>` vs `EODSubmission[]` return-type inconsistency, `VarianceLogTab` "expected" copy.
   - 2 round-1 Lows: informational `console.error` raw-object PII shape, malformed-UUID `vendor_id` returns 500 instead of 400 (polish only — same shape would apply to `store_id` / `client_uuid`).
   - Admin-EDIT overwrites `eod_submissions.submitted_by` to editor's UID (informational note in security round 2). Audit trail is preserved in `audit_log` rows; if "first-submitter" semantics on the row itself are wanted later, add an immutable `original_submitter_id` column and scope the trigger to write only `submitted_by`.
   - Code-reviewer Should-fix #3: audit detail format diverges between admin-JWT path (store action prefix) and staff-app RPC (`p_submitted_by` prefix) — document as intentional or align.
   - Pre-existing `AuditLogSection.tsx` does not render `e.detail`, so the `· vendor:` suffix is invisible in the Cmd UI feed (test-engineer flag). AC3 still met via the "OR via the linked submission" path. Out of scope; file separately if user wants UI display.
   - Sibling staff-app coordination tracking (separate repo, separate deploy).

## Out of scope for this review

- Pre-existing `EODCountScreen.tsx:1177` `TS2322 rightContent does not exist on CardHeaderProps` — predates spec 020.
- Pre-existing `AuditLogSection.tsx` detail-rendering gap (does not surface `· vendor:` suffix).
- Cold-boot React errors observed during spec-019 smoke tests — pre-existing, project-wide.
- `supabase_realtime FOR ALL TABLES` audit posture — pre-existing project posture; `vendor_id` column add is publication-no-op (no docker-restart ritual needed).
- `npm audit` dev-tooling vulnerabilities — no `package.json` changes in this spec; pre-existing.
- Test-framework gap (no jest/vitest) — project-wide per CLAUDE.md; tests executed via `docker exec psql` + `curl`.
- `useRole()` placeholder hardcoding `'admin'` — security still gated server-side via `auth_is_privileged()` from JWT claims; not a spec-020 concern.
- Legacy `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `npm run db` — frozen per CLAUDE.md.
- `AdminScreens.tsx` 104 KB legacy mega-file — frozen per CLAUDE.md.
- `app.json` slug mismatch (`towson-inventory` vs `imr-inventory`) — frozen per CLAUDE.md.
- CI workflow re-push (`.github/workflows/db-migrations-applied.yml`) — pending token re-scope per CLAUDE.md.
- Spec 021 forward-compat — architect §12 confirms spec 020's schema supports either resolution of spec 021's A1 input-signal question. No spec-020 hooks needed.
- Sibling staff-app caller update — lives in a separate repo, coordinated by user per §7 step 5 above.

## Handoff

next_agent: NONE
prompt: SHIP_READY — all 8 round-1 Criticals PASS in round 2 (4 security via new `_consistency.sql` triggers + policy lockdown, 3 code-review via dedupe/guard/stub fixes, 1 architect via edge-function patch). User reviews + commits; **important callout**: sibling staff-app caller (separate repo) must update to pass `vendor_id` before/with this PR landing on prod, otherwise its POSTs fail loud with `400 vendor_id required`.
payload_paths:
  - specs/020-eod-per-vendor-submissions/reviews/release-proposal.md
