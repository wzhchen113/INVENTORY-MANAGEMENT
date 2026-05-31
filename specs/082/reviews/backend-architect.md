# Spec 082 — backend-architect post-impl drift review

Mode: post-implementation drift review (read-only). Comparing shipped artifacts
against the approved `## Backend / Frontend design` (Option A+B) in
`specs/082-users-section-email-not-loaded-fix.md`.

Verdict: **NO DRIFT.** All 6 checklist items PASS. The implementation matches
the design byte-for-byte where byte-shape was specified.

## Checklist results

### 1. consume_invitation byte-shape + the one-line SET addition — PASS
`20260531000000_consume_invitation_sets_profile_id.sql:76-98` vs. the prior body
at `20260424211733_security_fixes.sql:87-108`:
- Signature `(p_invitation_id uuid, p_email text) returns boolean` — identical.
- `language plpgsql` / `security definer` / `set search_path = public` — identical.
- `declare v_updated int;` — identical.
- `if auth.uid() is null then return false; end if;` null-guard — identical.
- WHERE: `id = p_invitation_id` + `lower(email) = lower(p_email)` + `used = false`
  + `(expires_at is null or expires_at > now())` — identical.
- `get diagnostics v_updated = row_count;` + `return v_updated > 0;` — identical.
- The ONLY delta is `profile_id = auth.uid()` added to the SET clause (line 90),
  exactly as designed §1(a). `auth.uid()` is past the null-guard so never writes
  sentinel/NULL.
- `grant execute … to authenticated` re-affirmed (line 103); no anon grant. Matches §1(a).

### 2. The backfill — PASS
`20260531000000:122-135`. Matches design §1(b) line-for-line:
- `update public.invitations i set profile_id = u.id from auth.users u`
- `where i.used = true` AND `i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid`
  (sentinel-guarded, NOT NULL — the §0.1 correction) AND `lower(i.email) = lower(u.email)`
  AND `exists (select 1 from public.profiles p where p.id = u.id)`.
- Wrapped in `do $$ … $$` with `get diagnostics v_linked` + a `raise notice` count
  breadcrumb only (no PII). Idempotent (sentinel guard → 0 rows on re-run).
- Reads `auth.users` in-migration (runs as postgres) — the documented standard pattern.

### 3. fetchBrandAdmins dual-purpose-array split — PASS
`src/lib/db.ts:3225-3337`:
- `.eq('used', false)` DROPPED from the invitations query (3236-3243); select list
  unchanged (already carried `used` + `profile_id`). Comment at 3238-3240 explains the split.
- Maps built from the FULL `invites` array (3282-3287); the sentinel guard at 3283
  (`inv.profile_id !== '00000000-…'`) now does real work.
- Precedence `inviteByProfileId.get(p.id) ?? inviteByName.get(p.name)` at 3294 —
  UNCHANGED, exactly as §4(A.2) directed (id-match wins, name-match fallback).
- Pending rows built from `pendingInvites = invites.filter((inv) => !inv.used)`
  (3317), then the existing `activeEmails` dedup (3318-3320) preserved. This is the
  inference=ALL / pending=!used split, exactly as designed §4(A.3).
- The false `:3266-3271` comment REWRITTEN (now 3268-3279) to state profile_id is
  set by consume_invitation as of spec 082, legacy rows linked by the 082 backfill,
  name-match as the sentinel fallback. Matches §4(A.4).
- Return shape unchanged (`User[]`, same fields, `profile_id` consumed internally
  only). No new helper, no signature change — matches §4.

### 4. No scope creep — PASS
- Backend-only: exactly two production artifacts changed (`db.ts` fetchBrandAdmins
  + the one new migration) plus two test files. No FE surface (`UsersSection.tsx`
  untouched — it already renders `user.email`). No store change. No edge function.
  No RLS/policy change. No `supabase_realtime` publication change.
- super_admin / no-invitation case stays documented out-of-scope (spec §9, Option
  A+B not C). Confirmed.

### 5. Migration sequence / filename — PASS
`20260531000000_consume_invitation_sets_profile_id.sql` is the lexical tail; the
prior migration is `20260530000000_record_missed_orders_rpc.sql` (confirmed via
glob — these are the only two `2026053*` files, and the full listing shows nothing
sorts after). Clean tail append, no reordering of applied prod migrations. Date
matches today (2026-05-31). Matches §1.

### 6. Test parity — PASS (note plan count)
`supabase/tests/consume_invitation_sets_profile_id.test.sql` — `plan(8)`:
- 1 fixture-sanity (`isnt admin_id ''`).
- Arm A = 2 (consume returns true; profile_id after = caller's auth.uid()).
- Arm B = 2 (second consume returns false; **+ the profile_id-NOT-overwritten
  assertion test-engineer added** at lines 141-146 — this is the 8th, the plan
  count was bumped from the dev's original 7 to 8 in the header comment at lines
  11-12 and `select plan(8)` at line 45; consistent).
- Arm C = 2 (linked row; unmatched-email row keeps sentinel).
- Arm D = 1 (re-run idempotent).
- **Semantic identity of the inline backfill UPDATE:** the inline UPDATE at test
  lines 162-168 (and the Arm-D re-run at 187-193) is semantically identical to the
  migration's at `20260531000000:126-132`. Compared token-by-token: same target
  alias `i`, same `set profile_id = u.id`, same `from auth.users u`, same four
  WHERE predicates in the same order (`i.used = true`, sentinel literal,
  `lower(i.email)=lower(u.email)`, the `exists` profiles join). test-engineer's
  note about indentation differing is accurate and immaterial — NO semantic drift.
  The drift-discipline comment is present at test lines 36-40.

`src/lib/db.fetchBrandAdmins.test.ts` — 5 cases (4 inference + empty-brandId
guard): (a) used invite resolves non-empty email; (b) id-match precedence over
name-match for two same-display-name profiles; (c) unconsumed → 1 pending,
consumed-for-active → no dup; (d) sentinel → name-match fallback. Covers every
inference path §4 introduced. The empty-brandId early-return (`fetchBrandAdmins('')`
→ `[]`, supabase untouched) is a sensible defensive addition, not drift.

## Design-authority call: revoke PUBLIC/anon EXECUTE on consume_invitation?

**Verdict: FOLD THE ONE-LINE REVOKE INTO THIS MIGRATION.** In-scope, do not defer.

Reasoning:
1. **We are already CREATE OR REPLACE-ing the exact function.** The grant surface
   is already being touched in this migration (line 103 re-affirms `authenticated`).
   Adding `revoke execute on function public.consume_invitation(uuid, text) from
   public, anon;` immediately after is a single line in a file we already own — it
   is NOT a new migration, NOT a new blast radius. The marginal cost is one line
   and one optional pgTAP assertion.
2. **Direct codebase precedent.** `20260505065303_admin_rpcs_lock_anon.sql` is the
   spec-005 standard: it REVOKEs `from public, anon` on SECURITY DEFINER RPCs that
   are "safe in practice" (they raise/return on a failed auth check) precisely as
   defense-in-depth, with the stated rationale that the Postgres PUBLIC-EXECUTE
   default leaves them anon-reachable. `consume_invitation` is the same shape: its
   `if auth.uid() is null then return false` guard makes an anon call a no-op, which
   is exactly the "safe in practice" the precedent migration revokes anyway. Leaving
   it grant-PUBLIC is the inconsistency, not revoking it.
3. **The revoke is strictly tighter and provably safe here.** The only caller is
   `registerInvitedUser` (`src/lib/auth.ts:402`), which runs AFTER `signInWithPassword`
   — i.e. always as `authenticated`, never anon. So no live call path loses access.
   (`authenticated`'s grant is independent of the PUBLIC grant, so revoking PUBLIC +
   anon does not strip the authenticated path.)
4. **Severity is genuinely LOW** (the security-auditor is right — the auth.uid()
   guard neutralizes the leak; an anon caller gets `false` and zero rows change).
   So this is not a Critical that blocks ship. But "LOW + one line + we're editing
   the function + explicit house standard" is the textbook case for folding in
   rather than spawning a hardening spec. A separate spec for a one-line revoke on
   a function we're already rewriting would be process overhead with no upside.

Distinction worth stating so the boundary stays clean: I would NOT expand this spec
to sweep OTHER unrelated SECURITY DEFINER RPCs for stray PUBLIC grants — that IS a
separate hardening spec (an audit, not a one-liner). The fold-in is justified
*specifically because* consume_invitation is the function this migration already
redefines. If the implementer adds the revoke, it should sit right after the
`grant … to authenticated` (mirroring the order in
`20260505065303_admin_rpcs_lock_anon.sql:24-26`), and optionally pgTAP could assert
`has_function_privilege('anon', 'public.consume_invitation(uuid,text)', 'execute')`
is false — but that assertion is a nice-to-have, not required.

This is the one item I'd send back to the developer before SHIP_READY. It is a
should-fix (LOW security + house-standard alignment), not a Critical, so it does
not block on the "any Critical blocks SHIP_READY" rule — release-coordinator can
weigh it as a should-fix. My architectural recommendation is to land it now.

## Summary

- Checklist 1-6: all PASS, zero drift.
- One should-fix recommendation (not a drift): fold the
  `revoke execute … from public, anon;` one-liner into this migration to match the
  spec-005 anon-lockdown house standard, since we already CREATE OR REPLACE the
  function. LOW severity; does not block ship.
