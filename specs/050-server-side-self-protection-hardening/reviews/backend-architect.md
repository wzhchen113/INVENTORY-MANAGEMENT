# Backend-architect drift review — spec 050

Scope: design-contract conformance for the demote self-guard RPC and its
client/test/smoke harness. Reviewing only architectural drift; not
re-deliberating choices the design already pinned.

## Verdict by drift item

### 1. `P0002` refusal string drift — `'profile not found'` → `'target profile not found'`

**Minor.** Single defensive elaboration of an arm I never assertion-tied.
The design's drift table only pinned byte-for-byte stability on the two
strings the test harness asserts on: `'cannot demote self'` and
`'forbidden'`. `'profile not found'` was always non-load-bearing — no
pgTAP arm covers the not-found branch, no smoke arm hits it, no client
swallow-pattern depends on the exact wording. The dev's elaboration to
`'target profile not found'` is mildly *better* — it reads as a
structured error from the RPC's perspective rather than a generic 404
echo. Not a stability violation in the sense the table meant; the
contract is that **asserted strings** don't shift. Note in passing for
future style consistency; do not bounce on this.

### 2. `plan(6)` vs `plan(4)` — Arm (ii) contributes 3 assertions

**Not drift.** Re-read the file: Arm (ii) is `lives_ok` (happy-path
no-throw) + `is(role, 'user')` + `is(brand_id, null)`. Those last two
assertions are the right shape for the AC line "The refusal fires
**before** any UPDATE side-effect — the `profiles` row remains unchanged"
applied *inversely* to the happy path: confirming the UPDATE **did**
land when it should have. Without them, Arm (ii) only proves the call
doesn't raise — it doesn't prove the demotion actually happened. The
plan-count bump from 4 to 6 reflects assertion granularity, not arm-count
drift. Four functional arms are still present, in the ordering I pinned
(self → happy → role-gate → null). Approve.

One ancillary note worth flagging: the dev's `reset role;` between Arm
(ii)'s `lives_ok` and the column-state assertions is necessary because
the post-demote manager row has `brand_id=null`, which the
`Admins can read all profiles` policy filters out via
`auth_can_see_brand(NULL)` short-circuit. The dev's inline comment
(lines 109-117 of the test file) cites three sibling pgTAP files using
the same pattern. Correct and well-documented; this is not drift.

### 3. Smoke Arm 7 post-state — runs after Arm 4's super_admin promotion

**Not drift; design-intent-preserving.** Arm 7 proves "the RPC refuses
when caller.id == target.id regardless of caller's role." It does NOT
purport to prove "an admin (role='admin') cannot self-demote" specifically
— that's pgTAP Arm (i)'s job, where the JWT context is hermetically
fixed. The smoke layer is defense-in-depth across the live PostgREST
mapping path; the role at the time of the call is incidental. The dev's
snapshot-then-compare pattern (PRE_ROLE/PRE_BRAND → POST_ROLE/POST_BRAND)
correctly captures whatever the actual state is and asserts immobility,
which is the load-bearing invariant. If anything, having Arm 7 fire
against a super_admin caller *strengthens* the proof — super_admin is
the role with the most-permissive RLS surface
(`super_admin_manage_profiles` admits its own rows; the original P5
hole). Catching the refusal post-promotion is more demanding than
catching it pre-promotion.

### 4. Local stack apply-via-`docker exec` — fresh-start replay

**Not drift; standard local-dev workflow.** The migration file is at
`supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql`
with an idempotent `create or replace function` body. `npx supabase
start` on a fresh container replays the entire `supabase/migrations/`
directory in timestamp order, so the next contributor's
`supabase start` will apply this migration cleanly. The `docker exec`
hot-apply was the right call for the dev's running stack — there's no
clean way to apply a single new migration to a live Supabase stack
without `supabase stop && supabase start`, which would have lost the
existing seed state. The dev's verification of the function's presence
via the smoke run (which depends on `demote_profile_to_user` existing)
plus the 30/30 pgTAP pass (which calls the function directly) jointly
prove it landed. I did not separately `\df` verify, but the test results
are equivalent evidence.

## Spec hygiene

- `Status: READY_FOR_REVIEW` set at line 3.
- `## Files changed` (lines 1145-1169) is accurate and complete: migration,
  client wrapper, pgTAP, smoke arm, delete-user verify-only note,
  CLAUDE.md bullet, security-auditor.md bullet, verification gates.

## CLAUDE.md and security-auditor.md bullets

Both bullets landed strictly additive (CLAUDE.md line 64 after the spec
031 bullet; security-auditor.md line 52 after the spec 031 audit-rule).
Both correctly name both refusal strings, both reference shapes
(`delete-user/index.ts:168-173` and the migration file), and both flag
the convention for future role-hierarchy specs. Matches design intent.

## Critical findings

None.

## Should-fix findings

None.

## Minor findings

1. `'profile not found'` → `'target profile not found'` is a non-asserted
   string mutation. Acceptable; flagged for the record only. If a future
   spec adds a not-found arm to pgTAP, prefer asserting on the current
   `'target profile not found'` to lock the string going forward.

## Files reviewed

- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts (lines 2747-2766)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/demote_self_guard.test.sql
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/smoke-edge-roles.sh (lines 383-472)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md (line 64)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.claude/agents/security-auditor.md (line 52)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/050-server-side-self-protection-hardening.md (lines 1145-1169)
