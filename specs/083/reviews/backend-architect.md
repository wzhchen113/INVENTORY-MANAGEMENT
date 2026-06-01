# Spec 083 — backend-architect post-implementation drift review

Mode: post-implementation drift review (READ-ONLY). Status on entry: READY_FOR_REVIEW.
Verdict: **MATCHES DESIGN (no drift).** 0 Critical, 0 Should-fix, 2 Minor (both acceptable; pre-existing-comment staleness, not introduced by this spec).

Reviewed against my design in `specs/083/spec.md` "## Backend design (architect)" §0–§8.

## Files verified

- `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql`
- `src/lib/db.ts` (`fetchInvitationsForUserLookup`, lines 114-146; `fetchBrandAdmins`, lines 3242-3266 — verify-untouched)
- `src/lib/auth.ts` (`fetchAllUsers`, lines 440-512 — verify-untouched)
- `supabase/tests/invitations_brand_id_backfill.test.sql`
- `src/lib/db.fetchInvitationsForUserLookup.test.ts`
- `src/lib/auth.fetchAllUsers.test.ts`

## Load-bearing points — each verified

### 1. Migration `20260531010000_invitations_brand_id_backfill.sql` — MATCHES §1

- **Pre-flight ambiguity `raise notice`** (lines 116-130): present, counts NULL-brand + `profile_id = sentinel` invitations whose name matches `> 1` distinct non-null brand. Matches §1 verbatim.
- **UPDATE #1 — profile_id join** (lines 138-144): keys off `i.brand_id is null` AND `i.profile_id <> sentinel` AND `p.id = i.profile_id` AND `p.brand_id is not null`. Exactly §1.
- **UPDATE #2 — name fallback** (lines 155-169): keys off `i.brand_id is null` AND `i.profile_id = sentinel` AND the `count(distinct p.brand_id) = 1` exactly-one guard; the SET subquery is `select distinct p.brand_id … where p.brand_id is not null`. Exactly §1.
- **Mutual exclusivity confirmed:** UPDATE #1 predicate is `profile_id <> sentinel`; UPDATE #2 is `profile_id = sentinel`. The two WHERE clauses are disjoint, so no row is double-touched and UPDATE order is irrelevant — as the design and the header comment (lines 53-56) both assert.
- **Post-backfill `raise exception` invariant** (lines 178-200): counts NULL-brand rows still resolvable via either path; raises `'083: post-backfill invariant violated …'` if `> 0`. Fail-closed, matches §1.
- **Filename sort order:** Glob confirms `20260531010000` sorts strictly after `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082) and is the latest migration on disk. The load-bearing ordering dependency (UPDATE #1 relies on spec 082's `profile_id` backfill) is satisfied and documented in the header (lines 71-79). MATCHES §8.
- **Data-only / no DDL / no RLS / no grant / no function body:** confirmed — the file is a single `do $$ … $$` block. MATCHES §1, §2.

### 2. `fetchInvitationsForUserLookup` (`src/lib/db.ts:136-146`) — MATCHES §4

- **`.eq('brand_id', brandId)` dropped:** the query now reads `supabase.from('invitations').select('email, profile_id, name, brand_id').abortSignal(signal)` with no conditional brand filter (lines 140-143). Confirmed against the grep of all `.eq('brand_id'` sites in db.ts — none remain in this function.
- **`brandId?` param KEPT:** signature is `fetchInvitationsForUserLookup(brandId?: string)` (lines 136-138), retained-but-unused per my §4 caller-compat decision. The doc comment (lines 133-134) correctly states it is "RETAINED for call-site compatibility … but is currently UNUSED."
- **Doc comment rewritten:** lines 119-131 replace the old (now-false) "scoped at the SQL layer" claim with the spec-083 rationale (email-inference-only, per-user profile_id/name match scopes, filtering hid NULL-brand invitations, whole-table read justified as tiny/low-cardinality). MATCHES §4's documentation-lie requirement.
- **`fetchAllUsers` in `auth.ts` NOT edited:** lines 440-512 are byte-for-byte the pre-existing function — still does the `invByProfileId.get(p.id) ?? invByName.get(p.name)` resolution (line 496) and `email: invitation?.email || ''` (line 502). The one caller of the relaxed helper at line 471 passes `opts?.brandId` unchanged. Read-only verify satisfied, no scope creep. MATCHES §4.

### 3. `fetchBrandAdmins` NOT touched — MATCHES §7

- `fetchBrandAdmins` (`src/lib/db.ts:3242-3266`) still carries `.eq('brand_id', brandId)` on its invitations read at line 3259 — unchanged. The dev did not ride-along the symmetric relaxation I deferred to a follow-up (spec 084-ish). Confirmed via the `.eq('brand_id'` grep: lines 3250/3259/3264 (the three `fetchBrandAdmins` Promise.all reads) are all intact. MATCHES §7.

### 4. pgTAP byte-identical inline-UPDATE discipline — MATCHES §5

The two inline UPDATEs in `supabase/tests/invitations_brand_id_backfill.test.sql` are token-identical to the migration's, modulo the accepted DO-block 2-space de-indent (spec-082 convention):

- **UPDATE #1** — test lines 94-100 vs migration lines 138-144: identical tokens; migration's DO-block `  update` / `     set` de-indents cleanly to the test's `update` / `   set`. Re-used verbatim in the arm-6 idempotency re-run (test lines 237-243).
- **UPDATE #2** — test lines 159-173 vs migration lines 155-169: identical tokens, same de-indent. Re-used in arm 5 (lines 210-224) and arm 6 (lines 245-259).
- The migration's pre-flight notice and post-backfill `raise exception` invariant are correctly OUTSIDE the inline-copy scope (§5 scopes the discipline to the two UPDATEs only); the test instead asserts the invariant's *consequences* directly via arms 2-5. Correct.
- The test header (lines 28-33) states the drift-discipline rule explicitly, as §5 required.

Arm coverage matches §5's suggested plan(6) exactly: fixture sanity (arm 1), UPDATE #1 core invariant (arm 2), NULL-brand-profile-left-NULL (arm 3), UPDATE #2 name fallback (arm 4), UPDATE #2 ambiguity-left-NULL with an in-txn second brand `b1000000-…` (arm 5), idempotency (arm 6). The "NO grant / NO `set role anon`" guard (§5, avoiding the spec-067 segfault pattern) is honored — header lines 35-38 and no such arm present.

### 5. No RLS / edge-function / realtime / frontend / `useStore.ts` changes — MATCHES §6

- **RLS:** the migration touches no policy; no `pg_policies`-affecting DDL. The permissive-policy-ORed lint (spec 053) is not engaged. MATCHES §2/§6.
- **Edge functions:** none touched. No `verify_jwt` / service-token changes. MATCHES §6.
- **Realtime:** no `supabase_realtime` publication membership change; the `docker restart supabase_realtime_imr-inventory` ritual correctly does NOT apply and the migration header (lines 89-93) flags it so it is not cargo-culted. MATCHES §6.
- **Frontend / `useStore.ts`:** `src/store/useStore.ts` is untouched (its only references to this domain — lines 724/903 — are pre-existing `fetchBrandAdmins` call sites, not edited). `UsersSection.tsx` consumes `fetchAllUsers` with an unchanged signature. No optimistic-then-revert / `notifyBackendError` path applies (read-path correctness fix). MATCHES §6.

## jest coverage — matches the §5 test contract

- `src/lib/db.fetchInvitationsForUserLookup.test.ts`: 2 arms — (a) NULL-brand invitation returned when `brandId` passed (headline AC), (b) `eq` never called with `('brand_id', …)` (mechanism pin). Builder stub mirrors `db.fetchBrandAdmins.test.ts`. MATCHES §5.
- `src/lib/auth.fetchAllUsers.test.ts`: 2 arms exercising `fetchAllUsers` end-to-end — brand-scoped call resolves a non-empty email for a NULL-brand invitation matched by profile_id (the literal spec AC), and the all-brands (no brandId) call resolves it too. This is the "at least one arm must exercise `fetchAllUsers`" requirement from §5, satisfied. MATCHES §5.

## Minor findings (acceptable — not drift)

- **Minor / acceptable-deviation — stale pre-existing comment in untouched `fetchAllUsers`.** `src/lib/auth.ts:468-470` still reads "Cleanup #16 scopes the query to the current brand when brand-filtered so the table read doesn't span every tenant." That is now false (the helper no longer scopes by brand). My §4 explicitly told the dev NOT to edit `fetchAllUsers` (read-only verify, same discipline spec 082 applied), so leaving this comment is the correct call under the design — touching it would have been the scope creep I warned against. The authoritative correction now lives in the `db.ts` doc comment (lines 119-131). Flagging for the eventual `fetchBrandAdmins` follow-up (spec 084-ish) to sweep up alongside the symmetric relaxation; not a spec-083 blocker.
- **Minor — `fetchAllUsers` comment at `auth.ts:468-469` references "Cleanup #16" in the invitations-fetch lead-in.** Same root as above (the inference-query is no longer brand-scoped); same disposition — out of scope for a read-path-only fix, correctly left alone.

Both Minors are pre-existing-comment staleness in a function the design deliberately froze, not implementation drift introduced by this spec.

## Summary

The implementation is a faithful, disciplined realization of the §0–§8 design with zero architectural drift and zero scope creep. The data-only migration lands both sentinel-aware UPDATEs with the mutually-exclusive `<> sentinel` / `= sentinel` predicates, the exactly-one ambiguity guard, the pre-flight notice, and the fail-closed post-backfill invariant exactly as specified; the filename sorts strictly after spec 082's `20260531000000`, preserving the load-bearing ordering that UPDATE #1 depends on. `fetchInvitationsForUserLookup` drops `.eq('brand_id', brandId)` while retaining the now-unused `brandId?` param and replacing the false doc comment, with `fetchAllUsers` and `fetchBrandAdmins` both correctly left untouched (the latter deferred to a follow-up per §7). The pgTAP inline UPDATEs are token-identical to the migration's modulo the accepted DO-block de-indent, and the jest arms cover both the bare `db.ts` helper and the end-to-end `fetchAllUsers` resolution. No RLS, edge-function, realtime, frontend, or `useStore.ts` changes leaked in. The only findings are two Minor pre-existing-comment staleness notes in the deliberately-frozen `fetchAllUsers`, which the design itself instructed the dev not to touch — acceptable deviations, suitable for the `fetchBrandAdmins` follow-up, not blockers.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor (both acceptable pre-existing-comment staleness in the deliberately-frozen fetchAllUsers; the design instructed no edit there). Verdict: MATCHES DESIGN (no drift, no scope creep). Implementation faithfully realizes §0-§8.
payload_paths:
  - specs/083/reviews/backend-architect.md
