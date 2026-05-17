# Code review for Spec 042 (round 4 final)

## Critical

None.

## Should-fix

- `supabase/tests/rls_hardening_followups.test.sql:277-280` — The comment for
  arm (5) said "so the profiles_self_brand_lock trigger's
  `auth.uid()-IS-NOT-NULL guard` exempts any incidental profile UPDATEs from
  firing." There is no `auth.uid() is not null` guard in the shipped trigger.
  That mechanism was the round-3 design, empirically refuted, and replaced in
  round-4 with `current_user in ('authenticated', 'anon')`. The actual reason
  claims-clearing matters here is that `reset role` sets
  `current_user = postgres`, which falls outside the
  `in ('authenticated', 'anon')` allowlist — a completely different
  mechanism. **RESOLVED** in dev's follow-up edit (line 278-282 rewritten
  to cite the round-4 mechanism).

- `supabase/tests/rls_hardening_followups.test.sql:332-334` — Same stale-guard
  comment appeared verbatim in the arm (7) explanation. **RESOLVED** in
  dev's follow-up edit (line 333-339 rewritten).

## Nits

- `supabase/migrations/20260517050000_rls_hardening_followups.sql:79` — The
  `comment on policy` for `"Admins can write order_schedule"` ends with a
  period after the comment text, but the other two policy comments (lines
  111, 130) do not. Minor punctuation inconsistency in the same migration.

- `supabase/tests/rls_hardening_followups.test.sql:370-373` — Arm (7) asserts
  the inserted row using `where store_id = ... and day_of_week = 'thursday'`
  without an explicit `id` UUID. Correct SQL; minor stylistic break vs other
  arms.

- `supabase/migrations/20260517050000_rls_hardening_followups.sql:196-248` —
  The trigger function's leading prose comment block (lines 169-195, before
  `create or replace function`) is 27 lines long and overlaps slightly with
  the `comment on function` text at line 247-248. Could be trimmed in
  future cleanup; intentional design-history documentation per spec.

- `supabase/tests/rls_hardening_followups.test.sql:62-65` — Fixture comment
  notes the seed master is "promoted to super_admin mid-txn" but doesn't
  call out that the promotion in arm (7) persists into arms (8)-(15). A
  brief annotation would orient a future maintainer. Non-blocking.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix (both resolved post-review by dev follow-up edit), 4 Nits.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/042-rls-hardening-followups/reviews/code-reviewer.md
