# Security audit for spec 003

Scope: post-apply audit of `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql` (262 lines, applied to prod project `ebwnovzzkwhsdxkpyjka` 2026-05-07 under user authorization). 399 rows DELETEd from `prep_recipe_ingredients`. No code, no schema, no policy changes. No `package.json` change.

Verdict: clean. No Critical, no High, no Medium. One Low (advisory) plus a project-meta note on snapshot policy.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:251-252` — operator-visible audit trail is a single `RAISE NOTICE` line at COMMIT (`Spec 003: cleared 399 orphans (332 matching-deduped, 67 divergent-discarded) across 7 preps`). No row written to `audit_log`. This matches Spec 001 / 003 / 005 / 006 convention and is consistent with prior precedent (and `audit_log` policy on `20260504173035_per_store_rls_hardening.sql:160-181` would require a `store_id`-or-admin-checked write that doesn't fit a brand-level superuser-context migration cleanly anyway). Not a finding to act on for spec 003 — the apply log was captured in the spec's `### Apply log + post-apply verification (2026-05-07, user-authorized push)` section, which serves the audit purpose. Surfacing only as future-spec policy meta: if/when the project adds a structured migration-audit table (separate from `audit_log`), retroactive backfill should include this entry. No action required for 003.

### Dependencies

No `package.json` changes in this spec — `npm audit` skipped. Verified via `git status --short` (only spec markdown and the migration are modified/added).

---

## Specific check responses (per request)

### 1. RLS confirmation

Architect's §10 claim verified clean.

- `supabase/migrations/20260504173035_per_store_rls_hardening.sql` covers exactly: `inventory_items`, `eod_submissions`, `eod_entries`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`. `prep_recipe_ingredients` is NOT in that list. Same posture as Spec 006 — confirmed by direct read of the per-store hardening file.
- `prep_recipe_ingredients` policies live in `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:101-123`:
  - SELECT: `auth.uid() is not null`
  - INSERT/UPDATE/DELETE: `auth_is_admin()`
- The migration runs under `postgres` superuser via `supabase db push` — superuser bypasses RLS entirely. WITH CHECK doesn't fire on DELETE in any case. No helper function (`auth_can_see_store`, `auth_is_admin`) is invoked by the migration body.
- No new policies or helper-function changes shipped by this migration.

### 2. SQL injection / dynamic SQL

Clean. The migration body uses:
- One `constant uuid := '2a000000-...'` literal (`v_brand_id`)
- One `constant int := 399` literal (`v_grand_total_expected`)
- A hardcoded `IN (...)` list of 7 prep-name string literals (lines 100–108, 123–130)
- Standard parameterized PL/pgSQL — no `EXECUTE`, no `format()`, no concatenation, no untrusted input

The migration takes no parameters from the caller; the caller is `supabase db push` running as `postgres`. SQLi is structurally impossible here.

### 3. Prod recovery story without snapshot

Architect/user made a deliberate no-snapshot call (§11 cites PITR + seed.sql as joint inverse; §12 Q7 explicitly accepts this trade-off). My read:

- The 399 orphan rows were *generated* by `supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql`. The pre-apply state is reconstructible from migrations + seed alone, plus Supabase's automatic PITR window (default 7 days for paid tiers).
- Spec 006 took filesystem snapshots (`scripts/recovery-snapshots/20260507T040300Z-spec006/`) because that 7-row cleanup hit a smaller, more bespoke condition (`House Special Blend (Sauce)` drift) where the orphan content diverged from canonical in subtle ways and seed.sql was the *only* canonical pre-state record. Spec 003's 399 rows are bulk byproducts of P2 backfill, with the canonical-side equivalents already proved byte-identical pre/post (per §9 verification: 47 canonical rows unchanged) — making PITR sufficient.
- Volume (399 vs Spec 006's 7) is a red herring here. What matters for snapshot decisions is: (a) is the original pre-state easily reconstructible from existing artifacts (yes — seed.sql + P2 backfill migration), (b) is the mutation provably non-destructive of canonical data (yes — verified post-apply: 47 canonical rows pre = 47 post, byte-identical). Both true → PITR-only is defensible.

Not a security finding. Surfacing as project-meta: Spec 006 set a snapshot-precedent specifically for "prod-only data not in seed". Spec 003's data WAS in seed (the architect's §12 Q7 rationale (a) explicitly cites this). Future specs touching prep_recipe_* should make the snapshot decision on the seed-coverage criterion, not the row-count criterion.

### 4. Audit trail

The `RAISE NOTICE` at line 251–252 is the only operator-visible audit trail. The apply log (`Apply log + post-apply verification (2026-05-07, user-authorized push)` in the spec) captures the NOTICE verbatim, and §9 verification probes pre- and post-apply are recorded. No `audit_log` row inside the transaction.

Sufficient for a one-shot superuser data-repair migration. Same shape as Specs 001 / 005 / 006. The `audit_log` table's existing per-store/admin policy doesn't fit a brand-shared (no `store_id`) data-repair event cleanly — so omitting it isn't a defect, it's a convention. See Low item above for forward-looking note.

### 5. `useRole.ts` placeholder

Irrelevant to this migration. Migration runs as `postgres`, executes server-side, never touches the client. The placeholder hardcoded-`'admin'` in `src/hooks/useRole.ts` cannot influence migration behavior. No new code uses `useRole()` in this spec (no client code changes at all). Confirmed.

### 6. Secrets

No new secrets introduced. The migration contains:
- One brand UUID (`2a000000-0000-0000-0000-000000000001`) — public-shape identifier, present in many other migrations and the seed.
- 7 prep-name literals — public product names.
- Hardcoded count integers — public domain knowledge from the architect's certified probe.

No tokens, no keys, no PII. No `console.log` / `notifyBackendError` paths. Confirmed.

### 7. Brand-scope leakage

Closed. The DELETE targets are derived as follows:

- `_spec003_orphan_decisions.orphan_id` is populated only from rows where `pr.is_current = false` (the `orphans` CTE at lines 142–154 joins `prep_recipe_ingredients` to `prep_recipes` on `is_current = false`).
- Per gate_5 (probe) and `v_brand_id` constant — only brand `2a000000-...` has any non-current `prep_recipes` rows with orphans.
- The matching/divergent classification predicate at line 173 enforces `c.brand_id = o.brand_id` — a hypothetical canonical in another brand can never match an orphan in this brand. Even if a future re-application surfaced cross-brand orphans, the per-prep manifest assertion would catch it (the manifest is brand-implicit via the prep-name list, all of which are 2AM PROJECT brand).
- The final DELETEs (lines 229–241) filter only on `id IN (SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = ...)`. No DELETE can touch a row that wasn't first classified as a non-current orphan.

The §9 post-apply probe (`verify_pri_total_remaining = 65 = 47 canonical + 18 non-affected`) confirms zero collateral on non-affected preps and zero collateral on canonical rows of affected preps. Brand-scope leakage path: structurally and empirically closed.

### 8. Per-prep assertion strictness

Confirmed. The migration places per-prep assertion at lines 185–224 — strictly BEFORE the two DELETEs at lines 229 and 237. This is stricter than the architect's §7 sketch which placed the assertion after mutation. The improvement: a per-prep manifest mismatch RAISEs and rolls back without ever touching live rows. There is no scenario where a partial-delete state can be left in the DB on a manifest mismatch.

Additional defense: lines 210–220 catch orphans whose `prep_name` is *not* in the manifest at all (would mean a new affected name surfaced post-probe), with diagnostic NOTICEs naming each unexpected prep. This goes beyond the architect's sketch and is the right call.

The grand-total assertion at lines 245–249 is now defense-in-depth, not the primary gate. Correct ordering.

---

## Handoff

next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low (advisory: audit-trail convention note, not actionable for spec 003). RLS posture clean (architect's §10 claim verified). No SQLi surface. Brand-scope leakage path closed by both classification predicate and §9 verification. Per-prep assertion correctly placed before mutation. No new secrets, no client/edge-function code touched, no `package.json` change. Recovery posture (PITR + seed.sql, no snapshot) is defensible for this spec — surfaced as project-meta for future specs to make the snapshot call on seed-coverage criterion rather than row-count criterion. Spec is safe to ship from a security perspective.
payload_paths:
  - specs/003-prep-recipe-ingredients-orphans/reviews/security-auditor.md
