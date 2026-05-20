# Code review — Spec 050

Date: 2026-05-20
Reviewer: code-reviewer

## Verdict

0 Critical, 1 Should-fix, 4 Nits. No blocking issues; all project conventions correctly followed.

## Critical

None.

## Should-fix

- **`supabase/tests/demote_self_guard.test.sql:19`** — Header comment says "Four arms (plan(4))" but the actual plan count is 6 (`select plan(6)` at line 57). Arm (ii) contributes 3 assertions (lives_ok + two `is()` checks), bringing the total to 6, and the comment block immediately above `select plan(6)` (lines 55-56) correctly documents this. The contradiction in the header will mislead any reviewer who reads the top-of-file summary and then does the arithmetic. Fix: change the header's `plan(4)` to `plan(6)`.

## Nits

- **`supabase/tests/demote_self_guard.test.sql:8-9`** — The comment references `src/lib/db.ts:2757` as the function location. The actual `export async function demoteProfileToUser` declaration is at line 2761; line 2757 is inside the JSDoc block for that function. The reference is close enough to be navigable but a future reader who jumps to `:2757` lands mid-comment. Consider `src/lib/db.ts:2761`.

- **`supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:67`** — `auth.uid()` is called inside the `DECLARE` block assignment (`v_caller_id uuid := auth.uid()`). This is correct and idiomatic for plpgsql. The long block comment explaining WHY the null-caller path reuses the `'cannot demote self'` string (rather than a separate `'caller is null'` string) is justified and non-obvious, so it's appropriate here. No change needed.

- **`src/lib/db.ts:2747-2760`** — The JSDoc comment explaining the RPC, the SQLSTATE, and the sibling guard is thorough. Two of the three paragraphs explain the WHAT (what the RPC does, what the error code is) rather than the WHY, which is mildly over-commented by project convention. The third paragraph ("Errors surface via…") is the only genuinely non-obvious piece. Minor.

- **`scripts/smoke-edge-roles.sh:447`** — Arm 7's message-string grep uses `'"message":"cannot demote self"'` (no spaces around the colon), relying on the PostgrestError JSON serialization never inserting a space. This is safe in practice because PostgREST's JSON output is always compact, but it's a point of fragility compared to the Arm 6 pattern. Worth noting if the smoke script is ever adapted for a different PostgREST version.

## Drift correction

The `'target profile not found'` string at `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:124` is NOT drift from the architect's design. The architect's own code sketch in the spec (line 608) already uses `'target profile not found'`. The review-brief framed this as a one-word drift based on comparing to prose in the spec's design summary, not the authoritative code block. Implementation matches the design.

## Conventions verified

- DB access centralized: `supabase.rpc(...)` lives entirely in `src/lib/db.ts:2762-2763`. No direct Supabase call outside `db.ts`.
- Optimistic-then-revert: `useStore.ts:863-896` untouched. Catch block at 892-895 still reverts and routes through `notifyBackendError`.
- No inline color literals, no `window.confirm` / `Alert.alert`, no new realtime channels, no legacy files re-introduced.
- CLAUDE.md addition is strictly additive.
