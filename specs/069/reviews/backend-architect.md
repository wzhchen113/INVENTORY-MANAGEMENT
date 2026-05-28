# Spec 069 — backend-architect post-implementation drift review

**Mode:** post-implementation drift review (Status: READY_FOR_REVIEW on entry — not changed).
**Option built:** A (user-approved) — `profiles.brand_id` backfill + `get_pending_invitation` widen + `registerInvitedUser` stamp.
**Verdict:** clean. No Critical, no Should-fix, no contract break. **SHIP_READY** from the architecture seat.

Files reviewed against the §-numbered design appendix in `specs/069-staff-brand-id-catalog-read-fix.md`:

- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql`
- `src/lib/auth.ts` (`registerInvitedUser`)
- `supabase/tests/staff_brand_id_backfill.test.sql`
- `src/lib/registerInvitedUser.test.ts`

Reference points cross-checked: `20260510000000_invitations_brand_id.sql:42-64` (prior RPC shape),
`20260509000000_multi_brand_schema_rls.sql:200-210` (`auth_can_see_brand` body),
`20260528010000_user_stores_brand_match_null_brand_guard.sql` (spec-068 single-brand guarantee).

---

## Drift points (the 8 the dispatch asked for)

### 1. Backfill migration vs §3 design — ✅ matches design

The Half-1 `DO` block (`:115-204`) is the §3/§2 design built to spec:

- **Idempotent** — the `UPDATE` predicate is `p.brand_id is null` (`:185`), so a second run no-ops. ✅
- **Match predicate** — `where p.role = 'user' and p.brand_id is null and exists(user_stores)` (`:184-186`), exactly §3 step 2 and the §8 pre-flight shape. ✅
- **`limit 1` / single-brand derivation** — derived via `select distinct s.brand_id … where us.user_id = p.id` (`:178-183`). My design said "derive the single store brand"; the implementation uses `distinct` (a scalar subquery that errors loudly if it ever returns >1 row) rather than `limit 1`. This is **stronger** than my wording, not a deviation: pre-flight (a) already proved at most one distinct brand exists, and a bare `distinct` scalar subquery will raise `21000 (more than one row returned by a subquery used as an expression)` if the 068 invariant is ever violated mid-flight — a fail-loud belt to the pre-flight's braces. Correct call.
- **§3a flagging** — multi-brand → `RAISE EXCEPTION` fail-closed (`:140-144`); zero-store → `RAISE NOTICE` + per-row id/name listing + skip (`:156-169`); post-backfill invariant → `RAISE EXCEPTION` if any role='user'-with-stores row remains NULL-brand (`:199-203`). All three §3a behaviors present and matching the 012a `:268-271` fail-closed posture I cited. ✅
- **Timestamp** — `20260528020000` is the latest on disk; sorts strictly after `20260528010000` (the 068 trigger the backfill depends on). Confirmed against the full `2026052*` glob — no collision, correct dependency ordering (§10 "Migration ordering"). ✅

### 2. `get_pending_invitation` extension — ✅ matches design

- **Server-side derivation, shape as specified** — `resolved_brand_id = coalesce(i.brand_id, (select s.brand_id from stores s where store_ids non-empty and s.id = (store_ids[1])::uuid))` (`:250-259`). Byte-for-byte the §4 "preferred shape." `SECURITY DEFINER` + `set search_path = public` preserved (`:240-241`) so the `stores` lookup bypasses RLS at register time — which is the entire reason the derivation lives server-side (§4: client-side `stores` read would be RLS-blocked because `user_stores` rows are inserted *after* the profile INSERT). ✅
- **role='user' path only; admin passthrough** — the function returns the SAME `resolved_brand_id` expression for every row; the role split lives in `registerInvitedUser`, not the RPC. For an admin invite `i.brand_id` is non-NULL so `COALESCE` short-circuits to it → `resolved_brand_id == brand_id` (pgTAP arm 9 proves this). This is correct and is in fact *better* than gating inside the RPC: the function stays role-agnostic and the consumer decides. The admin path reads `invitation.brand_id` exclusively in `auth.ts` (see #3), so admin is unchanged either way. ✅
- **DROP+CREATE safety** — the prior definition (`20260510000000:42-51`) returned 7 columns; the new one (`:229-238`) returns 8 (adds `resolved_brand_id`). A changed return-type column set makes `CREATE OR REPLACE` raise `42P13`, so `drop function if exists` then `create` (`:226-228`) is **required**, not stylistic — and it mirrors the same DROP+CREATE the prior migration used (`20260510000000:40`). Both statements are in the one migration transaction, so no client observes a missing function (§10 risk #3). The `grant execute … to anon, authenticated` is re-asserted (`:278`), matching the prior grant (`20260510000000:64`) — without it `anon` (the register-time caller) would lose execute after the DROP. The TS read is loose (`invitation.resolved_brand_id ?? …`), so adding a column is backward-compatible for any pre-deploy client. ✅

### 3. `registerInvitedUser` stamp — ✅ matches design

`auth.ts:385-387`:

```ts
brand_id: invitation.role === 'user'
  ? (invitation.resolved_brand_id ?? invitation.brand_id ?? null)
  : (invitation.brand_id ?? null),
```

Byte-for-byte the §4 "after (preferred shape)" snippet. role='user' uses `resolved_brand_id` with a `brand_id ?? null` fallback chain (defensive against a pre-069 cached RPC shape — exercised by jest case 2); the admin/else branch reads `invitation.brand_id` only — the §4 "admin invites are unchanged" guarantee, and the AC's "no regression to admin-invite brand handling." The admin pre-flight guard (`:345-350`) and the `inviteUser` path (`:294-303`) are untouched. Lives in `src/lib/auth.ts`, the documented carve-out (§4 "no `db.ts` surface change"). ✅

### 4. Both halves present — ✅ matches design (§10 risk #2 satisfied)

Both halves ship in this PR: Half-1 backfill + Half-2 RPC widen in the one migration file, and the `auth.ts` stamp that consumes `resolved_brand_id`. My §10 risk #2 ("a backfill alone re-breaks on the next staff invite") is satisfied — the stamp stops the regression at its source so the backfill does not re-break. This was flagged as "the #1 thing post-impl review must confirm landed together"; **confirmed landed together.** ✅

### 5. `auth_can_see_brand` untouched — ✅ matches design (Option A's defining property)

Grepped every migration for `create or replace function public.auth_can_see_brand` — the **only** match is `20260509000000_multi_brand_schema_rls.sql`. The spec-069 migration does **not** redefine the helper; it contains no reference to it. Confirmed the body is still the two-arm `auth_is_super_admin() OR (profiles.brand_id = p_brand_id)` (`20260509000000:200-210`) — the store-member arm that Option B *would* have added is absent. Option A's defining property (only `profiles.brand_id` *data* changed; the brand-isolation helper that gates 15 call sites is byte-identical) holds. The §3 "policies are already correct; only the data they read was wrong" claim is realized: zero policy text changes, zero new tables. ✅

### 6. pgTAP arms vs §9 — ✅ matches design (superset)

`plan(13)`. Mapping to §9's required assertions:

| §9 arm | Implemented | Notes |
|---|---|---|
| 1 pre-fix proof | arm (1) `:156-160` | `auth_can_see_brand(A)=FALSE` for NULL-brand staff. ✅ |
| 2 core fix (A variant) | arm (2) `:192-200` | sets `brand_id=A`, asserts helper TRUE + catalog >0 rows. ✅ |
| 3 cross-brand isolation | arm (3) `:206-214` | **the no-over-broadening arm.** brand-A staff reading brand-B → helper FALSE + 0 rows. ✅ |
| 4 write-denial | arm (4) `:221-230` | `throws_ok(… , '42501', …)` on catalog INSERT — **the write-denial arm.** ✅ |
| 5 vendors class | arm (5) `:237-244` | vendors SELECT for brand A >0 rows. ✅ |
| 6 EOD embed join | arm (6) `:257-274` | `inventory_items ⋈ catalog_ingredients` non-null name, with a belt-and-braces `count>0` so a vacuous 0-rows-0-nulls can't pass. ✅ |
| 7 012a admin isolation | arm (7) `:293-305` | brand-A admin sees 0 brand-B catalog AND 0 brand-B vendors. ✅ |
| 8 backfill correctness | arm (10) `:382-387` | ✅ |
| 9 post-backfill invariant | arm (11) `:392-402` | duplicates the migration's own `RAISE EXCEPTION` at test level. ✅ |
| 10 zero-store skipped | arm (12) `:435-440` | left NULL, no error. ✅ |

Plus three arms **beyond** §9, all justified: arm (8) `get_pending_invitation` staff-invite `resolved_brand_id` derivation, arm (9) admin passthrough, arm (13) zero-store-invite `resolved_brand_id` NULL — these cover the Half-2 RPC, which §9 only gestured at via the jest track. Good additions. **The two arms the dispatch specifically called out — cross-brand isolation (3) and write-denial (4) — are both present and correctly shaped.** ✅

One thing I checked because it's the most common pgTAP self-foot-gun on this table family: the brand_id mutations at arms (2) and (10) (`:175-179`, `:366-369`) `reset role` / clear `request.jwt.claims` to `'{}'` *before* the postgres-role UPDATE, so `auth.uid()` is NULL during the mutation and the `profiles_self_brand_lock` trigger's `old.id = auth.uid()` guard doesn't self-block. The inline comments (`:168-174`, `:363-365`) call out exactly why, and it mirrors how the real migration's backfill runs (migration role, `auth.uid()` NULL — §1b). The test reproduces the production NULL-brand state honestly rather than trusting the seed's brand-A value (the §"asymmetry" point). Fixture hygiene is correct: hermetic `begin … rollback`, brand-B + store + catalog + vendor all inside the txn, zero-store fixture inserts the `auth.users` FK parent first (`:410-418`). ✅

### 7. Scope — ✅ no drift

No `git diff` tool is available to me in this harness, so I confirmed scope two independent ways: a grep for the `spec 069 / 069: / spec-069` tag markers and a grep for the new `resolved_brand_id` symbol across the whole tree. **Both sweeps return the identical four-file set** — `supabase/migrations/20260528020000_staff_brand_id_backfill.sql`, `src/lib/auth.ts`, `supabase/tests/staff_brand_id_backfill.test.sql`, `src/lib/registerInvitedUser.test.ts` — which is exactly the `## Files changed` list. No undeclared source edits, no stray `db.ts` / store / component churn (consistent with §7 "no frontend store impact" and §5 "no edge function change"). Recommend main Claude run `git diff --name-only` as the authoritative confirmation before commit, but the symbol-level evidence shows no drift surface. ✅

### 8. The 012a-invariant restoration — ✅ matches design (the recommendation's load-bearing premise)

My Option-A recommendation rested on: *"012a already backfilled all role='user' to 2AM (`20260509000000:283-286`); the post-012a invite flow regressed it for staff invited after 012a."* The implementation restores **exactly** that invariant and no more:

- The backfill touches only `role='user' AND brand_id IS NULL AND has user_stores` — i.e. precisely the rows the regression left NULL, deriving the same store brand 012a would have stamped. It does not touch admins, super_admins, or already-branded staff (idempotent guard).
- The post-backfill `RAISE EXCEPTION` (`:199-203`) **is** the invariant, asserted: zero role='user'-with-stores rows may remain NULL-brand. Verification log confirms `backfilled 0` on the local seed (the seed's manager already carries brand-A — the `is null` guard correctly skips, proving idempotency on already-restored data).
- The stamp (`auth.ts:385-387`) prevents future regression at the source — new staff invites land WITH a brand, so the invariant holds going forward. The §10 risk #2 "re-break" cycle is closed.

The fix is a regression repair to the system's own established invariant, exactly as the recommendation argued — not a new design that overloads `auth_can_see_brand` (which Option B would have). ✅

---

## Minor (non-blocking, optional, for future awareness)

- **M1 — pgTAP filename diverged from §9, justified.** §9 named the file `staff_null_brand_catalog_read.test.sql` and suggested an *optional* separate `staff_brand_backfill.test.sql` for the backfill arms ("developer's call"). The developer shipped one file, `staff_brand_id_backfill.test.sql`, folding all 13 arms in. This is within the latitude §9 explicitly granted and matches the dispatch handoff's own filename. ⚠️ deviation justified — not a contract break. No action.
- **M2 — `resolved_brand_id` derives from `store_ids[1]` only.** Half-2 resolves the brand from the *first* assigned store. For a multi-store-but-single-brand staff invite (the only legal shape post-068) this is correct and unambiguous. If a future spec ever permits cross-brand invitations (it must not, per 068), `store_ids[1]` would silently pick one brand — but that would be an upstream 068 violation, and the backfill's own multi-brand `RAISE EXCEPTION` is the catch for the data-at-rest equivalent. The RPC has no such assert because at invite time there is no `user_stores` to aggregate over; the COALESCE-first-store is the only server-side signal available. Acceptable as designed (§4). Flag only so a future cross-brand-invite spec revisits it. No action now.
- **M3 — no down migration.** Consistent with repo convention and stated in the migration header (`:108-110`); the prior RPC body is git-recoverable and a brand_id can be re-nulled by a super_admin. ✅ as-is.

---

## Summary

Every one of the 8 drift points is ✅ matches design. The single filename divergence (M1) is within latitude my own §9 granted. The build is a faithful, complete realization of the approved Option A: both halves shipped together, `auth_can_see_brand` untouched, cross-brand isolation and write-denial both pgTAP-proven, the 012a invariant restored and prospectively protected, and scope confined to the four declared files. No contract break, no Critical, no Should-fix.

From the architecture seat: **SHIP_READY.**

(Deploy reminders for the release/apply step, already in the spec — not review blockers: no `supabase_realtime` publication change → the `docker restart supabase_realtime_imr-inventory` ritual does NOT apply (§6); no migrations-applied CI gate exists, so the migration was manually verified against the 286 KB seed and pgTAP — re-run `npx supabase db reset` + `scripts/test-db.sh` on the apply host; run the §8 read-only prod probes after applying to confirm Charles's catalog/vendor embeds are non-null and 012a admin isolation still returns 0.)

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Minor (all
  non-blocking: justified pgTAP filename divergence, store_ids[1] brand derivation
  note for a future cross-brand-invite spec, no-down-migration per convention).
  Build faithfully realizes approved Option A — both halves shipped together,
  auth_can_see_brand untouched, cross-brand isolation + write-denial pgTAP-proven,
  012a invariant restored and prospectively protected, scope confined to the four
  declared files. SHIP_READY from the architecture seat.
payload_paths:
  - specs/069/reviews/backend-architect.md
