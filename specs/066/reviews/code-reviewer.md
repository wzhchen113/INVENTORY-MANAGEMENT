## Code review for spec 066

### Critical

None.

### Should-fix

- `supabase/tests/actor_fk_cascade_audit.test.sql:47–259` — The test arms are numbered in PM-table order (1: `inventory_items`, 2: `waste_log`, … 6: `audit_log`, 7: `flags.user_id`, 8: `flags.resolved_by`) while the migration statements are in strict alphabetical-by-table order (`audit_log` first, `flags.resolved_by` before `flags.user_id`). The arm numbers and section headers therefore do not match the migration's statement order. This is not a correctness bug — every arm is still exercised — but it means a future reader tracing "arm (6) failed" back to the migration lands on the wrong statement (line 55 in the migration is `audit_log`, which is the 6th arm, so the mutation-guard trace in the spec's verification record *happens* to be correct; but arms 1–5 in the test map to migrations lines 75–133, not lines 55–73). Recommend renumbering the test arms to match the migration's alphabetical order (or re-ordering the migration to match the PM-table order). Either direction resolves the mismatch; alphabetical-by-table in both is the lowest-friction fix given the migration is already correct.

### Nits

- `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql:54` — The per-statement inline comment for `audit_log.user_id` says "textbook audit-actor null-out." The adjacent comments for the other 10 entries use the consistent phrasing "audit attribution; null out on delete" or "X pointer; null out on delete." The `audit_log` comment is slightly inconsistent in style. Not wrong, just a minor inconsistency within the file.

- `supabase/tests/actor_fk_cascade_audit.test.sql:238–259` — Arms (11) for `prep_recipes.created_by` has a notably longer failure message than arms (1)–(10) because it explains the drop/restore history inline. That's useful context, but if pgTAP truncates long strings in TAP output it can obscure the "got / want" values. The spec 065 reference shape keeps failure messages under ~120 characters. Not a correctness issue; the history rationale is already captured in the arm header comment (lines 237–242).
