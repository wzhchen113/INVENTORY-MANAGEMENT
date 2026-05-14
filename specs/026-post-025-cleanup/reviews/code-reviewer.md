# Code review for Spec 026

## Summary

- 0 Critical
- 1 Should-fix
- 2 Nits

## Critical

None.

## Should-fix

- `supabase/tests/invitations_super_admin_rls.test.sql:70-72` — Comment says "profile_id is NOT NULL with no default and no FK constraint" but the column definition at `supabase/migrations/20260424211732_recover_undeclared_tables.sql:106` declares it as `profile_id uuid` — nullable, no NOT NULL constraint. The phrasing "is NOT NULL" is the opposite of the actual constraint. The INSERT happens to supply the value anyway so there is no functional bug, but the comment will mislead the next developer auditing the test fixture.

  Fix: change to "profile_id has no default and no FK constraint (nullable; we supply the caller's UUID to match prod behaviour)".

## Nits

- `supabase/migrations/20260514150000_invitations_super_admin_rls.sql:6` — Awkward sentence boundary. "...check against ['admin','master']. 012a (20260509000000_multi_brand_schema_rls.sql) introduced..." reads as a sentence break with "012a" hanging at the start with no article or verb intro. Prior-art migrations (`20260510020000`, `20260510030000`) phrase this inline without the preceding period. Consider semicolon-joining: "...check against ['admin','master']; 012a (20260509000000_multi_brand_schema_rls.sql) introduced the super_admin role..."

- `supabase/tests/invitations_super_admin_rls.test.sql:38-39` — Inline UUID comments `-- seed admin` / `-- seed master, repurposed` / `-- seed manager` could be more precise about which test arm uses each. The deviation from the architect's pseudocode (where `v_user_uid = '33333333...'`) is correct and well-explained in the file header (lines 21-27), but inline labels like `-- seed manager (plain-user arm)` would let readers identify the arm without cross-referencing the header.

## Coverage notes (no findings)

- Migration shape matches prior art (`20260510020000_order_schedule_super_admin_rls.sql`, `20260510030000_recipe_categories_super_admin_rls.sql`). Four policies dropped and recreated, names match byte-for-byte, `DROP POLICY IF EXISTS` makes the migration idempotent.
- pgTAP test uses the seed-UID-with-ON-CONFLICT approach (not synthetic UUIDs) — correct because `profiles.id FK → auth.users(id)` makes synthetic UUIDs nonviable. Consistent with architect caveat (b).
- `plan(4)` matches exactly four assertions.
- AC B5 grep gate clean; all 8 agent files updated per spec enumeration; CLAUDE.md edits clean.
- `package.json` + `package-lock.json` show `json-server` fully removed with no unrelated dep changes.
- AC A1-A6 / B1-B5 / C1-C4 all met.
