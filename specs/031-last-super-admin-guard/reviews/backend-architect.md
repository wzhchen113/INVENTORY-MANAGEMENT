# Architectural drift review — spec 031 (last-super-admin / master deletion guard)

Reviewer: backend-architect (post-impl mode).
Scope: 7 files listed in `## Files changed`. Walk every design contract from
the spec's `## Backend design` section against the landed code.

Summary: **no drift findings**. The implementation matches the design with
one cosmetic enhancement (a defensive `else` arm in the SQL `case` statement
that cannot fire at runtime). Both flagged divergences from the developer
are logically equivalent to the design and acceptable. All
"explicitly-enumerated-files-only" boundaries hold.

---

## Critical

None.

## Should-fix

None.

## Nits

### N1 — Defensive `else` arm in `case` is unreachable, fine to leave as-is.

`supabase/migrations/20260514160000_assert_not_last_of_role.sql:68-72`
adds a third arm to the `case target_role` block:

```sql
v_message := case target_role
  when 'super_admin' then 'cannot delete the last super_admin'
  when 'master'      then 'cannot delete the last master'
  else format('cannot delete the last %s', target_role)
end;
```

The early-return at line 55 (`if target_role is null or target_role not in
('super_admin', 'master') then return;`) makes the `else` arm unreachable —
by the time control flows to line 67, `target_role` is provably one of the
two literal values. My design at spec §1 (line 526-529) listed only the two
explicit arms.

Impact: zero. The `else` is dead code that defends against a future where
someone removes the early-return guard. Slight redundancy with a comment-
documented invariant. Not a finding; mentioned only for completeness.

---

## Walk against the design contract

Each item from the dispatching prompt's "What to verify" block, in order.

### 1.A — Migration filename `20260514160000_assert_not_last_of_role.sql`

Design (§1, spec line 467): filename specified verbatim, with the rationale
"strictly greater than `20260514150000_invitations_super_admin_rls.sql`
(the spec 026 sibling) and on the same calendar day."

Landed: file at that exact path, slot `20260514160000` is the new tail of
the migrations directory (verified by glob — sorts last in the
`20260514*` cluster). Correct.

### 1.B — Helper signature

Design (§1, spec lines 497-500):
```sql
create or replace function public.assert_not_last_of_role(
  target_user_id uuid,
  target_role    text
)
returns void
```

Landed (`supabase/migrations/20260514160000_assert_not_last_of_role.sql:39-43`):
byte-for-byte identical signature. Correct.

### 1.C — SECURITY DEFINER, search_path, GRANT shape

Design (§1, spec lines 503-505, 537):
- `stable security definer set search_path = public, auth`
- `grant execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;`

Landed (lines 44-47, 80):
- `language plpgsql / stable / security definer / set search_path = public, auth` — correct.
- `grant execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;` — byte-exact.
- `anon` correctly NOT granted (matches §2 design intent).

### 1.D — Stable error messages byte-exact

Design (§5, spec lines 750-769) and §1 case block (lines 526-529):
- `'cannot delete the last super_admin'`
- `'cannot delete the last master'`

Landed (`supabase/migrations/...:69-70`):
```sql
when 'super_admin' then 'cannot delete the last super_admin'
when 'master'      then 'cannot delete the last master'
```
Byte-exact. The pgTAP arms at `supabase/tests/delete_last_privileged_guard.test.sql:67-68`
and `:104-105` assert these strings literally. Smoke arm at
`scripts/smoke-edge-roles.sh:360` regex-matches them. All three layers
agree on the stable identifier.

### 1.E — Edge function ordering: AFTER self-delete refusal, BEFORE data-cleanup deletes

Design (§4, spec lines 730-739): the new guard goes AFTER the self-delete
refusal (line 59-64) and BEFORE the existing `user_stores` / `profiles` /
`invitations` / `auth.admin.deleteUser` sequence.

Landed (`supabase/functions/delete-user/index.ts`):
- Lines 59-64: self-delete refusal (unchanged).
- Line 66: service-role client construction (was at line 66 pre-change, kept at line 66 — same logical position).
- Lines 78-103: new guard block (role lookup + RPC call).
- Lines 105-107: existing `user_stores` / `profiles` / `invitations` deletes.
- Line 109: `auth.admin.deleteUser`.

Ordering correct. The guard is atomic — a refusal returns before any
`.delete()` runs, satisfying "no partial cleanup on refused delete" (spec
AC line 65-66).

### 1.F — Client `canDelete` predicate matches §5 verbatim

Design (§7, spec lines 807-816):
```ts
const canDelete = (isMaster
  ? !isSelf
  : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
  && !(user.role === 'super_admin' && lastOfRole.super_admin)
  && !(user.role === 'master'      && lastOfRole.master);
```

Landed (`src/screens/cmd/sections/UsersSection.tsx:284-288`): byte-exact
match. Even the alignment-whitespace (`'master'      &&`) is preserved
from the design.

The `lastOfRole` derivation at lines 76-79 also matches §7 verbatim:
```ts
const lastOfRole = {
  super_admin: rawUsers.filter((u) => u.role === 'super_admin').length <= 1,
  master:      rawUsers.filter((u) => u.role === 'master').length <= 1,
};
```

Derived from `rawUsers` (NOT `visibleUsers`) as the design called out
explicitly (§7 line 786-790).

### 1.G — Smoke Arm 6 matches §11 design

Design (§11, spec lines 942-998): six sub-steps inside Arm 6.

Landed (`scripts/smoke-edge-roles.sh:325-381`):
1. SKIP if `$PROMOTED != "1"` — matches step 1 (line 328-329).
2. SKIP if pre-existing super_admin count != 1 — matches step 2 (lines 333-338).
3. Resolve admin uid via docker exec psql — matches step 3 (lines 342-345).
4. POST `delete-user` with promoted user's own id — matches step 4 (lines 350-355).
5. Assert HTTP 400 + body regex `"error":"cannot delete (self|the last super_admin)"` — matches step 5 (lines 359-364).
6. Re-query super_admin count, assert unchanged — matches step 6 (lines 370-378).
7. Failures accumulate into `$FAILED` via existing `fail()` (line 79) — matches step 7 (whole-script pattern).

Inherits the existing refuse-non-local guard at lines 53-60. Correct.

### 1.H — Convention bullets match §12 verbatim wording

Design §12.1 (spec line 1009) one-line bullet for CLAUDE.md.

Landed at `CLAUDE.md:63`: verbatim. The bullet was inserted AFTER the
spec-028 escapeHtml bullet (line 62) and BEFORE the "Imports" bullet
(line 64) — exactly the position the design specified.

Design §12.2 (spec line 1021) one-line bullet for `.claude/agents/security-auditor.md`.

Landed at `.claude/agents/security-auditor.md:51`: verbatim. Inserted AFTER
the spec-028 escapeHtml audit bullet (line 50) and BEFORE the "Secrets"
section (line 53) — exactly the position the design specified.

### 2 — Are the dev's two flagged divergences acceptable?

**Divergence 1: `plan(4)` without a leading `isnt(...)` fixture-resolution
sanity assertion.**

Confirmed acceptable. My design at §10 (spec lines 894-927) specified
`plan(4)` with four functional arms. I did NOT require a leading
fixture-resolution sanity assertion. The dev's argument — "literal UUIDs
can't fail to resolve" — is correct; the seed UUIDs are stable across
`supabase db reset` and the test setup uses `set_config` rather than
querying for the UUIDs, so there's nothing to sanity-check. `plan(4)` is
honest. No drift.

**Divergence 2: count predicate formulation
(`where role = target_role and id <> target_user_id, count = 0` vs.
`where role = target_role, count <= 1`).**

Confirmed acceptable.

- My design: count includes target → refuse when `<= 1` (covers 0 or 1).
- Dev's: count excludes target → refuse when `= 0`.

For the production call path (edge function reads `target_role` from
`profiles.role` of the actual target, then passes both target_user_id and
that role), the target IS in the table with that role. In both
formulations:
- If the target is the sole row of that role: my version counts 1, refuses; dev's counts 0, refuses. Both refuse. Identical.
- If there's exactly one OTHER row: my version counts 2, allows; dev's counts 1, allows. Both allow. Identical.

The dev's formulation is more directly self-documenting ("any OTHER rows
of this role?" maps to the prose intent more cleanly than "count including
target <= 1"). The pgTAP arms exercise both refusal and non-refusal paths
(Arms i+iii vs. ii+iv), so any semantic asymmetry would have surfaced.
Tests are 15/15 per the dev's report. No drift.

### 3 — Boundary violations / unintended changes

None.

Grepped for `assert_not_last_of_role` and `lastOfRole` across the
out-of-scope files:
- `src/lib/db.ts` — no matches. Untouched.
- `src/store/useStore.ts` — no matches. Untouched.
- `src/hooks/useRealtimeSync.ts` — no matches. Untouched.

The 7 files in the dev's `## Files changed` list match the spec's §16
"Files the developer will touch" exactly (the 2 new + 4 modified + 2
convention-doc edits, where smoke and convention docs collectively are 3
file edits on disk, totaling 7 files when migration + pgTAP are counted
as 2 new and the rest as modified).

### 4 — Realtime / migrations / db.ts / frontend boundaries

**Realtime**: the migration is a function-only addition — no `alter
publication` statement, verified by grep. The design at §8 (spec lines
861-869) called out "no publication change" and "no docker restart needed."
Header comment at `supabase/migrations/...:18-19` documents this. Correct.

**Migrations**: only the new file `20260514160000_assert_not_last_of_role.sql`
landed. No existing migration files touched. Filename slot is strictly
greater than the prior tail `20260514150000_invitations_super_admin_rls.sql`.
Correct.

**db.ts**: untouched (grep clean). The design at §6 (spec lines 771-779)
explicitly said no `src/lib/db.ts` change because the edge function uses
its own service-role client and the client never directly calls the new
helper. Confirmed.

**Frontend store**: `useStore.ts` untouched. Per §9 (spec lines 872-886),
`deleteProfile`'s existing `notifyBackendError` path surfaces the new HTTP
400 via toast without code change. Confirmed.

### 5 — Two-step deploy

`supabase db push` and `supabase functions deploy delete-user` are deploy
steps the user runs manually post-merge. The spec's `## Files changed`
section at lines 1210-1217 enumerates both commands in the correct order
(`db push` first, then `functions deploy`). The dev correctly did NOT
execute either — these are user-driven production deploy actions per
auto-mode safety guardrails ("not a license to destroy" / "modifies shared
or production systems still needs explicit user confirmation").

Confirmed: no `git log` evidence of either command being run, and the
spec's "Post-merge deploy steps" subsection is the documented handoff to
the user.

---

## Conclusion

Design contract held end-to-end. The implementation matches my §1 through
§16 design with one cosmetic enhancement (dead `else` arm — leave). Both
developer-flagged divergences are logically equivalent to the design and
acceptable. Out-of-scope files (db.ts, useStore.ts, realtime publication,
config.toml) are untouched. The two-step deploy is correctly deferred to
the user.

No findings at Critical or Should-fix severity. One Nit (N1) is
informational only.
