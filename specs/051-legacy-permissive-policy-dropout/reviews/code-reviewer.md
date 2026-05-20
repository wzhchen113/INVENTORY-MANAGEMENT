## Code review for spec 051

### Critical

_(none)_

### Should-fix

- `specs/051-legacy-permissive-policy-dropout.md:657` — The §2 Matrix B per-operation coverage table still says "Tightened at the policy layer instead of the trigger layer. Same end state, **cleaner error class (RLS 42501 vs trigger raise)**" for the `brand-A admin INSERTs grant for brand-A user on brand-B store` row. This is now factually wrong: arm (11) documents and proves the trigger fires first (BEFORE ROW, before RLS WITH CHECK), so the error class is P0001, not 42501. The spec's `## Files changed` section at line 1232 acknowledges the correction, but the design narrative in §2 is still unedited. A future reader consulting the design table will get the wrong mental model. The correction is one cell in the matrix — update to something like "Trigger raises P0001 first (BEFORE ROW); policy is the structural backstop." No migration or test change needed.

### Nits

- `supabase/tests/legacy_permissive_policy_dropout.test.sql:338-386` — The super_admin cross-brand arm (5) bundles four mutation operations inside a `do $$` anonymous block and stashes a `bool_and` result in a `set_config`. This is functionally correct — `set local role authenticated` applied before the block remains in scope inside it — but readers may need to trace the JWT/role state across the block boundary. The pattern is unique in the project's pgTAP corpus. A one-line comment like `-- role remains 'authenticated' (set local) for all ops inside this block` above the `do $$` would save the next reader a confirmation lookup.

- `supabase/tests/legacy_permissive_policy_dropout.test.sql:96` — `plan(13)` counts thirteen arms across four concerns. The test header (lines 13-68) already names every arm and maps them to concerns, so the count is verifiable. No change needed, but if a future arm is added the plan number is easy to mis-count (no guard). Low priority — the pgTAP runner will fail with `# Looks like you planned 13 tests but ran 14` so the safety net exists at CI.

- `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:104,115` — Both recreated `user_stores` policies use `to public` (the Postgres default when `to` is omitted). The two `*_categories` clarity rewrites in this same migration use the explicit `to authenticated` role gate (lines 159, 183) as the stated "clearer" alternative. For consistency within this migration, the `user_stores` policies could also be `to authenticated` — any caller who satisfies `user_id = auth.uid()` or `auth_is_privileged()` is necessarily authenticated. This is a style point, not a correctness issue (anonymous callers have `auth.uid() = null` which fails both predicates regardless), and the existing `stores` scoped policies in `20260509000000_multi_brand_schema_rls.sql` also use `to public`. Do not change without aligning with the existing `stores` policies.
