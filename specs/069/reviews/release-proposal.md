## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; the lone Medium is a documented inherent limitation of pgTAP-testing a one-shot data migration, bounded by a deploy-time self-guard, a 1-row prod footprint, and a fully jest-covered durable path.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix, 3 Nits. Should-fix is low-severity: pgTAP arm (1) (`staff_brand_id_backfill.test.sql:156-160`) asserts only `auth_can_see_brand(A) = false` but its header claims a fuller "pre-fix proof the bug exists" — the catalog-row-count half is absent from arm (1). Verified directly: the row-count proof DOES exist in arm (2) (`:192-200`, helper TRUE *and* `count(*) > 0`), so the proof holds in aggregate; arm (1) is just not self-contained. Nits: `cardinality()` vs `array_length()` idiom in the backfill (`:255-256`), a dead `delete` mock stub in `registerInvitedUser.test.ts:67`, and a missing one-line comment on the placeholder zero-UUID in arm (8). Scope check clean — no inline colors, no legacy-file touches, no `app.json` change, `auth.ts` stays inside its documented carve-out.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 2 Low (advisory). **PASS** — this was the gating cross-brand-RLS review. All eight mandatory checks passed: `auth_can_see_brand` provably untouched (defined once in 012a, never redefined — the defining property of Option A vs B), backfill brand derivation unambiguous and fail-loud on multi-brand, staff write-denial preserved (every write keeps its `auth_is_privileged()` conjunct → brand_id stamp grants READ only), profiles SELECT does NOT widen (staff still read only `id = auth.uid()`, cannot enumerate brand peers), 012a cross-brand isolation intact, DROP+CREATE transactional, backfill idempotent (`brand_id IS NULL` predicate). The two Lows are explicitly non-vulnerabilities: an implicit-but-correct ordering dependency in the scalar subquery (load-bearing guard fires before the UPDATE), and the intended "brand follows the assigned store" invite semantic.

- **test-engineer**: 8/8 acceptance criteria PASS. 1 Medium + 3 minor. Medium: the migration's backfill DO block is not itself under CI test — commenting out the backfill UPDATE leaves all 13 pgTAP arms green because the arms stamp `brand_id` inline and the post-backfill invariant arm (11) trivially finds 0 NULL-brand-staff (seed's Tara already carries a brand). Run: 334 jest (35 suites, +4 from 069), 37/37 pgTAP files, both typechecks clean. The "143 → 0" fix is captured by arm (6) against real seed data (143 Towson `inventory_items`, 0 null-name post-fix, with a `count > 0` belt against a vacuous pass). Minors: justified test-filename deviation, an absent (non-required) `EODCount.test.tsx` null-catalog arm, and an absent one-line pgTAP assert that Tara's brand_id is unchanged by the backfill.

- **backend-architect** (post-impl drift): 0 Critical, 0 Should-fix, 3 Minor (all non-blocking). All 8 dispatched drift points are ✅ matches design. Both halves (backfill + `get_pending_invitation` widen + `registerInvitedUser` stamp) shipped together — the §10 risk #2 "re-break on next invite" cycle is closed. `auth_can_see_brand` untouched, cross-brand isolation + write-denial both pgTAP-proven, 012a invariant restored and prospectively protected, scope confined to the 4 declared files. **SHIP_READY from the architecture seat.**

## Assessment of the Medium (non-blocking)

I concur with the test-engineer: the Medium does **not** block ship. Reasoning:

1. **It is a limitation, not a defect.** Nothing in the migration or the fix is wrong — the gap is that pgTAP cannot exercise a one-shot data migration as code-under-test, because the migration has already run by the time `scripts/test-db.sh` executes. The arms therefore replicate the backfill logic inline rather than depending on the DO block. This is inherent to the track, not a developer omission.

2. **The risk it describes is bounded on three independent sides:**
   - The migration **self-guards at deploy time** via a post-backfill `RAISE EXCEPTION` invariant (`:199-203`) that fires if any `role='user'`-with-stores row remains NULL-brand — so a broken WHERE/subquery fails the deploy loudly rather than silently mis-stamping.
   - The **prod footprint is exactly 1 row** (the §8 read-only pre-flight recorded one affected staff user, single-element `derived_brands`, zero multi-brand staff).
   - The **durable future-invite path is fully jest-guarded** (4 tests in `registerInvitedUser.test.ts`, including an admin-path divergence guard) — so the class of bug the backfill repairs cannot silently recur on the next invite.

3. The cheap partial mitigation (test-engineer minor #3 — a one-line assert that Tara's brand_id is unchanged) is worth folding in but is not load-bearing for the verdict.

## Root-cause note (cross-session arc)

This is the 15th spec this session and the **third** manifestation of the NULL-brand-staff root cause (068 fixed the `user_stores` trigger; this catalog-read break is the read-path symptom of the same missing `brand_id`). Critically, **069 fixes the root cause, not just this instance**: staff now carry a `brand_id` (backfilled for the 1 existing row, stamped at invite time going forward), which restores the spec-012a brand-isolation invariant. That closes the *class* of bug — any reader/embed gated on `auth_can_see_brand` for a staff user now resolves correctly.

The broader arc — prod screenshot (spec 060 missing migration) → prod sync → CI crash (067) → invite-form brand bug (068) → this catalog-read bug (069) — traces to exactly two root causes: unpushed migrations and NULL-brand staff. **Both are now closed.** The step 3 prod push below is what discharges the first root cause for this fix.

## Recommended next steps (ordered)

1. **(Optional, recommended) Fold in the two cheap items pre-commit** — both are one-or-two-line, in files already being committed, and tighten test-proof completeness:
   - code-reviewer Should-fix: add a second assertion to pgTAP arm (1) (`:156-160`) selecting `count(*) = 0 from catalog_ingredients where brand_id = brand_a` under the NULL-brand JWT, so the "pre-fix proof" is self-contained as its header claims.
   - test-engineer minor #3: add `is((select brand_id from profiles where id = '22222222...'), brand_a, 'Tara unaffected by backfill')` — a direct partial mitigation for the Medium (asserts the backfill's `brand_id IS NULL` predicate left an already-branded staff row untouched).
   - Defer the 3 nits (cardinality idiom, dead delete-mock stub, placeholder-UUID comment) — pure readability, no behavior. Fine to leave or sweep opportunistically.
   - If folding either item in, re-run `npx supabase db reset` + `bash scripts/test-db.sh` to reconfirm 37/37 before committing.

2. **Commit + push.** (Per project rule, await explicit user confirmation to commit.)

3. **Apply BOTH migrations to prod via `npx supabase db push`** — the backfill (`20260528020000`) AND the `get_pending_invitation` change land in the one migration file. This is the step that actually fixes the user's broken staff EOD screen, and it discharges the "unpushed migration" root cause for this fix. There is no `migrations-applied` CI gate (CLAUDE.md), so this is a manual, operator-confirmed action against the shared prod DB — do not run it without explicit user go-ahead.

4. **Run the §8 read-only prod verification** after applying: confirm the affected staff user can now read `catalog_ingredients` / `vendors` (EOD embed names populate, non-null), and confirm 012a admin cross-brand isolation still returns 0 brand-B rows. No `supabase_realtime` publication changed, so the `docker restart supabase_realtime` ritual does NOT apply here.

## Out of scope for this review

- **Restructuring the pgTAP track to exercise one-shot data migrations as code-under-test** (the Medium's structural root). Would require a seed-state NULL-brand staff row that the migration's DO block fixes at reset time — a test-infrastructure change, not a 069 deliverable. Track as a follow-up if migration-code coverage becomes a recurring need.
- **`store_ids[1]` brand-derivation under a hypothetical cross-brand-invite feature** (backend-architect M2 / security-auditor Low #2). Cross-brand invites are forbidden by the spec-068 single-brand trigger today; if a future spec ever permits them, that spec revisits the first-store derivation. Not a 069 concern.
- **No-down-migration** (backend-architect M3) — consistent with repo convention; the prior RPC body is git-recoverable and a brand_id is super_admin-reversible. Not an action.
- **`EODCount.test.tsx` null-catalog documentation arm** (test-engineer minor #2) — explicitly waived by spec §9 Q4 (no client change landed). Optional documentation polish only.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/069/reviews/release-proposal.md
