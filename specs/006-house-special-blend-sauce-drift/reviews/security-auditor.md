# Security audit for spec 006

Spec scope: direct prod data mutation (DELETE 1 `prep_recipes` row + 6
`prep_recipe_ingredients` rows) via a single migration, plus an owner-notes
edit and a recovery-snapshot directory committed to git. No edge functions,
no `db.ts` changes, no UI, no new env vars. Migration was applied to prod
on 2026-05-07 with user authorization. This audit is post-apply.

Files reviewed:

- `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
- `docs/internal/prep-canonicalness-notes.md` (line 99 edit)
- `scripts/recovery-snapshots/20260507T040300Z-spec006/prep_recipes_4fbd90.tsv`
- `scripts/recovery-snapshots/20260507T040300Z-spec006/prep_recipes_4fbd90.json`
- `scripts/recovery-snapshots/20260507T040300Z-spec006/prep_recipe_ingredients_4fbd90.tsv`
- `scripts/recovery-snapshots/20260507T040300Z-spec006/prep_recipe_ingredients_4fbd90.json`

Cross-references read for context:

- `supabase/migrations/20260504173035_per_store_rls_hardening.sql`
- `supabase/migrations/20260502071736_remote_schema.sql` (lines 354–368, current `prep_recipes` / `prep_recipe_ingredients` policies)
- `supabase/migrations/20260405000759_init_schema.sql` (lines 89–113, table shape; lines 255–281, original RLS)

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None. The migration is already applied; this section is empty by virtue of
the operation having landed cleanly with all four §5 verification probes
passing. No vulnerability was introduced.

### Medium

None.

### Low

- `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
  — **No `audit_log` row written for the destructive operation.** Spec §2
  explicitly chose filesystem-snapshot over an in-transaction `audit_log`
  insert, with reasoned rationale (full row image restorable via
  `\copy ... FROM`, no JSON shape coupling on the rollback path). The
  filesystem snapshot at `scripts/recovery-snapshots/20260507T040300Z-spec006/`
  is a sufficient recovery substrate. The trade-off worth noting: the
  prod database itself has no record that these 7 rows ever existed or
  who/what removed them — anyone querying prod's `audit_log` for
  "what touched `prep_recipes` recently" sees nothing. The spec file
  + snapshot directory in the repo is the only paper trail. This is an
  intentional architect decision and acceptable given the low blast
  radius (1 brand-scoped recipe, 6 ingredient rows, no PII), but if the
  pattern of "destructive prod migration with snapshot-only audit"
  recurs, consider an additive convention: write an `audit_log` row
  with `entity = 'spec_migration'`, `entity_id = <spec number>`,
  `action = 'delete'`, and `details = {file_paths, row_counts}` so the
  prod-side audit trail is queryable. Not a finding to fix on this spec;
  flagged for the next prod-mutating spec to consider as a convention
  upgrade.

- `supabase/migrations/20260502071736_remote_schema.sql:354-368` —
  **Pre-existing weak RLS on `prep_recipes` and `prep_recipe_ingredients`
  is unchanged by this spec, but worth re-flagging.** The current policies
  are `auth_manage_*` permissive `auth.uid() IS NOT NULL` — any
  authenticated user (including customer-PWA users hitting the same
  Supabase project) can read all prep recipes and all prep ingredient
  rows across all brands. The brand-catalog refactor's per-store
  hardening (`20260504173035_per_store_rls_hardening.sql`) deliberately
  excluded these tables (they are brand-level, not store-level). For a
  single-brand deployment (2AM PROJECT) this is the intended posture and
  not a finding. **Spec 006 does not introduce, worsen, or interact with
  this** — but if a future spec adds a second brand to the same Supabase
  project, the brand isolation gap on these tables becomes a real cross-
  tenant leak. Surface to the architect when multi-brand hosting is
  contemplated. Not a Spec 006 finding; informational only.

- `scripts/recovery-snapshots/20260507T040300Z-spec006/` — **Recovery
  snapshot data review: clean.** Read all four files:
    - `prep_recipes_4fbd90.tsv` / `.json`: 1 row of recipe metadata
      (name `House Special Blend (Sauce)`, category `Sauces`, yield
      `42.228 lbs`, version 1, `is_current = false`, brand UUID,
      `created_at`). `created_by` is `null` — no user identifier
      captured. No PII.
    - `prep_recipe_ingredients_4fbd90.tsv` / `.json`: 6 rows of
      ingredient links (id, prep_recipe_id, quantity, unit,
      base_quantity, base_unit, type, sub_recipe_id, catalog_id).
      All UUIDs and numerics; no free-text payload, no notes column,
      no PII.
  No service tokens, no API keys, no `created_by` user ids, no store
  ids (these are brand-level rows). The `to_jsonb(t.*)` capture path
  did not pick up anything sensitive. Committing to git is appropriate
  per the architect's §16 decision and creates no exposure concern.

### Confirmation against the asks in the dispatch prompt

1. **RLS confirmation.** Architect's §6 verified by direct read of
   `supabase/migrations/20260504173035_per_store_rls_hardening.sql`. The
   per-store policy fan-out covers `inventory_items`, `eod_submissions`,
   `eod_entries`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`,
   `pos_imports`, `pos_import_items` — `prep_recipes` and
   `prep_recipe_ingredients` are not in that set. Their actual policies
   (from `20260502071736_remote_schema.sql:354-368`) are the permissive
   `auth_manage_*` `auth.uid() IS NOT NULL` shape — a known pre-existing
   posture for brand-level catalog tables, intentional per the
   brand-catalog refactor. Migration apply via `supabase db push` runs
   under superuser context, bypassing RLS regardless. Both architect
   claims are correct. (I did not re-run `pg_policies` via Supabase MCP
   because the migration files on disk are sufficient evidence and the
   spec's §6 doesn't make any claim that requires live-prod confirmation
   beyond what the migration files already prove.)
2. **Snapshot data sensitivity.** Reviewed in the Low item above. Clean.
3. **Snapshot file permissions / git history.** Snapshot is committed
   intentionally per architect §16. Contents non-sensitive. No concern.
4. **Migration SQL injection-safety.** All identifiers are static UUID
   literals (`'4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid`,
   `'2a000000-0000-0000-0000-000000000001'::uuid`). No `EXECUTE`, no
   `format()`, no string concatenation, no untrusted input — the
   migration takes no input at all. SQLi-safe.
5. **Audit trail.** Filesystem snapshot is a sufficient substrate for
   this spec (no PII deleted, low row count, restorable). Logged as Low
   re: future-spec convention upgrade.
6. **`useRole.ts` placeholder.** Migration is pure SQL; no app-layer
   code touched. The placeholder client hook is irrelevant here. ✓ N/A.
7. **No new secrets.** Zero env vars, API keys, or service tokens
   introduced in any of the changed files. ✓.

### Dependencies

No `package.json` changes — `npm audit` skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low.
  Migration is post-apply and structurally clean. Two of the three Low items
  are convention/forward-looking observations (audit_log substrate convention
  for future destructive specs; pre-existing prep-recipes RLS posture if a
  second brand is ever added). The third Low item confirms the recovery
  snapshot is data-clean (no PII, no secrets, no user ids). No blockers for
  release.
payload_paths:
  - specs/006-house-special-blend-sauce-drift/reviews/security-auditor.md
