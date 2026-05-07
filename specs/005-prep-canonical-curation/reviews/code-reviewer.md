## Code review for Spec 005

### Critical

None.

---

### Should-fix

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:144–156` — **Target-canonical sanity check uses an aggregate count rather than per-name guards.** The check asserts `v_target_canon_count <> 3` (total `is_current = true` rows across the three distinct target names), matching build-stop 5's spirit but not its letter. Build-stop 5 says "count ≠ 1 for ANY of the three target names." An aggregate of 3 could theoretically be satisfied by a (2, 1, 0) or (3, 0, 0) split across the three names. In practice the partial unique index `prep_recipes_brand_name_current_unique` prevents > 1 canonical per `(brand_id, lower(name))`, which eliminates the over-count scenarios — so the only real failure mode the check misses is an already-degenerate state where one target has 0 canonicals and another happens to have an extra one at a different `lower(name)` match (unlikely but possible if the index were somehow bypassed). Suggest replacing the aggregate with an EXISTS check that enforces per-name = 1 explicitly:

  ```sql
  -- Per build-stop 5: each distinct new_name must have exactly 1 current canonical.
  IF EXISTS (
    SELECT 1
      FROM (SELECT DISTINCT new_name FROM _spec005_renames) dn
      LEFT JOIN public.prep_recipes pr
        ON pr.brand_id = v_brand_id AND pr.is_current = true AND pr.name = dn.new_name
     GROUP BY dn.new_name
    HAVING COUNT(pr.id) <> 1
  ) THEN
    RAISE EXCEPTION
      'Spec 005: one or more manifest target names does not have exactly 1 is_current=true canonical — rolling back';
  END IF;
  ```

  This is fully consistent with the corrected design in spec section 2 and section 8 build-stop 5 ("count ≠ 1 for any of the three target names"), and makes the in-migration guard as strict as the build-stop condition it is encoding.

---

### Nits

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:41–44` — **Filename note references the wrong latest-migration timestamp.** The comment at lines 41–44 says "sorts immediately after `20260505065303_admin_rpcs_lock_anon.sql`, which is the latest migration in the original run (before the spec004 cluster)." A `20260505055228_prep_recipes_brand_name_current_unique.sql` migration also exists and is already applied locally (confirmed via gate_7 in spec section 1). The prose isn't load-bearing, but the factual claim in the comment is off — the latest migration in the pre-spec004 run would be whatever sorts latest among the `20260505*` files. Low impact; just clarify or omit the "before the spec004 cluster" qualifier since the comment's main point (the timestamp sorts after the `20260505*` cluster) is correct.

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:62–72` — **`mechanic` CHECK constraint retains dead values.** The `CHECK (mechanic IN ('rename-only', 'rename-plus-flip-is-current', 'rename-into-collision'))` allows two mechanic values that are never used in this migration. The spec explicitly permits retaining them "for parity with the original design (and for safety if a future spec needs it)" so this is intentional — but a clarifying comment on the CHECK line explaining the intentional retention would help a future engineer avoid removing the seemingly-dead values. Example: `-- other mechanics retained for parity with the original design; all rows in Spec 005 use 'rename-into-collision'`.

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:182` — **`0 is_current flips` is hardcoded in the success NOTICE.** The NOTICE message reads `(0 is_current flips)` as a literal, not derived from a counter. This is correct under amendment #3's no-flip design, and the spec explicitly approves either "include the `0 is_current flips` parenthetical or omit it entirely." However, a later spec that copies this migration as a template and introduces a flip mechanic could accidentally emit a misleading `0 is_current flips` message by cargo-culting this NOTICE. Consider a one-line comment here noting that the `0` is intentional, not a counter: `-- 0 is_current flips is a literal: amendment #3 removed all flip mechanics`.

- `specs/005-prep-canonical-curation.md:481–482` — **(out-of-scope) Gate-2 query artifact is acknowledged but not corrected.** The spec correctly notes that gate_2's `current_count` is tautologically 0 due to the `WHERE pr.id IN (... is_current = false)` outer filter, and explicitly calls it a "minor query artifact, not a finding." Worth noting for whoever extends this probe SQL for Spec 006 or Spec 003's retry: the `current_count` column in gate_2 will always be 0 and should either be removed from the SELECT list or computed via a separate correlated subquery that doesn't inherit the outer filter's `is_current = false` predicate.

- `specs/005-prep-canonical-curation.md` (build notes, final apply section) — **`pwa-catalog` smoke deferred but not explicitly closed.** The final apply section (line 1364–1366) says "Deferred. … Available as a tripwire if the user wants it; not run today since the expected diff is zero." This leaves an open action item without a definitive disposition. Given that the spec's own analysis in section 7 (amended) confirms "zero diff on the catalog payload" as the expected outcome, this is not blocking, but it means the smoke's outcome is officially unrecorded. A one-sentence note — "Smoke deferred and not required per amended section 7 (catalog payload invariant); formally closed as N/A" — would make the audit trail unambiguous for whoever reads the spec in six months.
