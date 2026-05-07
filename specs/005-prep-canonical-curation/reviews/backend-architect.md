# Spec 005 — backend-architect post-impl drift review

**Reviewed:** 2026-05-06
**Spec:** [`specs/005-prep-canonical-curation.md`](../../005-prep-canonical-curation.md) — Status: READY_FOR_REVIEW (local apply complete; remote push pending)
**Implementation:** [`supabase/migrations/20260506000000_rename_prep_canonicals.sql`](../../../supabase/migrations/20260506000000_rename_prep_canonicals.sql) — 193 lines, single `DO $$` block, atomic transaction
**Mode:** post-implementation drift review against the post-amendment-#3 design contract

## Summary

The migration is a faithful implementation of the post-amendment-#3 design. Every load-bearing structural element — manifest shape, mechanic, expected counts, assertion pattern, idempotency, atomic-transaction, target-canonical sanity check — is in place and matches the design's section 4 / section 7 sketches. Local apply succeeded with the expected NOTICE; idempotent re-run was verified.

The amendment trail did NOT leave behind material design fragments that the implementation followed by mistake. The architect's amendments to the **active** design surfaces (sections 0, 2, 4, 5, 7, 8) all converge on the 4-row / 16-grand-total / no-flips shape; the migration matches that shape. Sections that retained pre-amendment text (section 3 destructive-vs-additive prose, section 7 risk surface) carry inline `**Amended ...:**` callouts that supersede the original prose; the developer correctly read those callouts.

Findings: **0 Critical, 0 Should-fix, 4 Minor.** The 4 Minor findings are stale design-text remnants (audit-trail callouts that contradict each other) and a documentation seam to sibling Spec 006 — none of which BLOCK SHIP_READY. Migration is structurally sound on local; remote push is the user's call.

---

## Findings (ranked)

### Critical

None.

### Should-fix

None.

### Minor

#### M1 — Section 3 "Description string" line is stale (preserved-original artifact)

[`specs/005-prep-canonical-curation.md:610`](../../005-prep-canonical-curation.md) reads:

> Description string `rename_prep_canonicals` — names the action (rename) and the affected entity (canonical prep names).

This is correct against the actual filename `20260506000000_rename_prep_canonicals.sql` and matches the implementation. **No issue here** — flagging only because section 3 has TWO `**Amended:**` callouts at the top (lines 597–602 and the sub-callouts inside section 4) that explicitly mark "atomic line" and "destructive vs additive" as superseded but do NOT explicitly bless the description string. A fresh reader of section 3 might wonder if the description string is also stale. It's not. The migration's actual filename is correct.

**Impact:** documentation clarity only. No code change needed.

#### M2 — Section 4 manifest sketch retains `/* TBD */` placeholders and the `'rename-plus-flip-is-current'` mechanic value

[`specs/005-prep-canonical-curation.md:661–668`](../../005-prep-canonical-curation.md) (Original sketch, preserved):

```sql
INSERT INTO _spec005_renames (...) VALUES
  ('Tumeric Mix',                  ..., 'rename-into-collision',       /* TBD */, NULL),
  ('House Special Seasoning Mix',  ..., 'rename-plus-flip-is-current', /* TBD */, '38678f'),
  ...
```

The amendment-#1 callout above this sketch (lines 618–624) says "the developer should consult the corrected dev-step encoding in section 7's verification protocol" — and the developer did exactly that. Section 7's step 5 (lines 837–842) lists the post-amendment-#3 4-row INSERT with concrete counts (4 / 8 / 3 / 1) and `flip_target_uuid_prefix = NULL` on every row. The migration matches section 7 step 5 verbatim.

However, the section 4 sketch text itself was never updated to reflect the corrected manifest values, only superseded via callout. This is an audit-trail choice (preserve original for history); not a defect. The migration's manifest INSERT (lines 74–78 of the SQL) correctly carries `'rename-into-collision'` on all 4 rows and `flip_target_uuid_prefix = NULL` on all 4 rows.

**Impact:** none on code correctness. Future readers walking section 4 top-to-bottom must read the amendment callouts first, then jump to section 7 step 5 for the actual values to author. Spec hygiene flag, not a defect.

#### M3 — Section 7 "Pre-build" step 4 has been "OBSOLETED 2026-05-06 #3" but the literal step text says "(NEW, 2026-05-06 #2; OBSOLETED 2026-05-06 #3)"

[`specs/005-prep-canonical-curation.md:836`](../../005-prep-canonical-curation.md):

> 4. **Apply-time source-name re-probe (NEW, 2026-05-06 #2; OBSOLETED 2026-05-06 #3):** ~~run the SQL ...~~

The step is correctly struck-through and the OBSOLETED tag is on. The amendment-#3 callout above the step list (line 831) reads:

> The amendment-#2 step list below is preserved for audit; the **active flow** is steps 1, 2, 3, 5, 6 with the 4-row manifest INSERT — no step 4 (no apply-time source-name re-probe is required because there is no 5th row to substitute).

A fresh reader has to compute "active steps = {1,2,3,5,6}" from the prose callout because the renumbering wasn't applied to the literal step list. The migration was correctly authored against this — it does NOT include any apply-time source-name re-probe — but a reader of section 7 step-by-step must mentally skip step 4. Minor spec readability issue.

**Impact:** none on code correctness. Spec hygiene flag.

#### M4 — Sibling Spec 006 reference is forward-looking only; no spec file exists yet

[`specs/005-prep-canonical-curation.md:243`](../../005-prep-canonical-curation.md):

> They are deferred to a sibling **Spec 006** (PM is filing in parallel; do not block on it):

Spec 005 references Spec 006 as the owner of `House Special Blend (Sauce)` cleanup in 8 distinct places (sections 0, 2, 4, 5, 7, 8, the Handoff payload, and the Final-apply Build notes). The reference is precise about scope: (a) the 1 non-current `prep_recipes` row at `4fbd90cc...`, (b) the 6 orphan `prep_recipe_ingredients` rows pointing at it, and (c) the owner-notes-prefix-vs-remote-canonical reconciliation (`4fbd90` per notes vs `36016d31` on remote).

A fresh reader of Spec 005 alone CAN find Spec 006's scope from these references. However, **`specs/006-*.md` does not exist on disk yet** as of this review (Spec 005's section 0 says "PM is filing in parallel"). If a fresh reader tries to navigate to spec 006, they will not find it. This is an unresolved seam between specs.

**Impact:** if Spec 003 retries before Spec 006 is filed, the Spec 003 architect/dev needs to resolve `House Special Blend (Sauce)` by some path that doesn't depend on Spec 006 existing. The post-impl-pass safety net here is to flag the seam; the dependency is the user's to resolve.

**Recommendation (advisory, not blocking):** PM files Spec 006 before Spec 003 retry is dispatched, OR Spec 003 retry's PM-pass references the `## Build notes` "Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)" subsection of Spec 005 directly for the data shape the Spec 003 retry would inherit.

---

## Section-by-section drift confirmation

### Section 2 mechanic table (post-amendment-#3, 4 rows)

Design spec section 2 lines 555–561:

| Old name | New name | Mechanic | Expected affected count |
|---|---|---|---|
| `Tumeric Mix` | `Tumeric Seasoning (House Mix)` | rename-into-existing-collision (no `is_current` flip) | 4 |
| `House Special Seasoning Mix` | `House Special Seasoning (House Mix)` | rename-into-existing-collision (no `is_current` flip) | 8 |
| `2AM Sauce` | `2AM SAUCE` | rename-into-existing-collision (no `is_current` flip) | 3 |
| `2AM SAUCE 10` | `2AM SAUCE` | rename-into-existing-collision (no `is_current` flip) | 1 |

Migration lines 74–78:

```sql
INSERT INTO _spec005_renames (...) VALUES
  ('Tumeric Mix',                  'Tumeric Seasoning (House Mix)',         'rename-into-collision', 4, NULL),
  ('House Special Seasoning Mix',  'House Special Seasoning (House Mix)',   'rename-into-collision', 8, NULL),
  ('2AM Sauce',                    '2AM SAUCE',                             'rename-into-collision', 3, NULL),
  ('2AM SAUCE 10',                 '2AM SAUCE',                             'rename-into-collision', 1, NULL);
```

Row-for-row match. Grand total: 4 + 8 + 3 + 1 = 16. **No drift.**

The CHECK constraint on the `mechanic` column (lines 65–69) admits all three legacy values (`rename-only`, `rename-plus-flip-is-current`, `rename-into-collision`) even though only the third is used. This matches the architect's amendment-#1 note (line 620) that the schema is retained for parity with the original design. **No drift.**

### Section 4 manifest INSERT

The INSERT in the migration (lines 74–78) matches section 7 step 5's certified values (lines 837–842) verbatim. The `flip_target_uuid_prefix` column is retained on the temp table (line 71) and is `NULL` on all 4 rows, matching amendment #1's "retained for parity" note. **No drift.**

### Section 5 apply-path matrix (Path B-revised)

Design (Path B-revised, line 748): "`db reset --local` runs all migrations (including this one) against empty DB → no-op via count=0 branch; `seed.sql` re-loads the 4 affected names with the local probe-certified counts. Developer re-executes the migration body via psql against the now-seeded local DB."

Migration's Path B-revised behavior (verified by Build notes "Local apply (Path B-revised)" subsection at lines 1287–1295):

```
$ docker exec -i supabase_db_imr-inventory psql ... < supabase/migrations/20260506000000_rename_prep_canonicals.sql
BEGIN
NOTICE:  Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)
DO
COMMIT
```

Matches design — 16 rows renamed, 4 names, 0 is_current flips. **No drift.**

Idempotent re-run path (Path D, line 750) verified at Build notes lines 1350–1356:

```
NOTICE:  Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)
```

Wording matches the spec's recommendation in section 7 ("`Spec 005: no-op (no rows to rename — already curated)`") **except for the parenthetical phrasing** — the migration's actual NOTICE adds "pre-seed apply OR already curated" instead of just "already curated". This is the **neutral-wording lesson from Spec 001** that the migration comment (lines 31–34) explicitly cites. **Improvement over design, not drift.** The neutral phrasing covers both reset-to-empty-DB and post-curation re-apply correctly.

### Section 7 verification protocol (assertion structure)

Design (sections 4 + 7, summarized):

1. Pre-mutation grand-total snapshot via JOIN against manifest.
2. Branch on grand total: `= 0` → no-op; `= expected` → proceed; else → abort.
3. Pre-mutation per-name actuals snapshot into `_spec005_actuals` (BEFORE the UPDATE).
4. Per-name strictness assertion via `LEFT JOIN ... USING (old_name)` + `COALESCE(actual_count, 0) <> expected_rename_count`.
5. Diagnostic NOTICE LOOP per mismatched name, then `RAISE EXCEPTION`.
6. Pre-mutation target-canonical sanity check: 3 `is_current = true` rows expected across the 3 distinct manifest target names.
7. Single `UPDATE ... SET name = m.new_name` driven by manifest join.
8. Grand-total post-UPDATE assertion via `GET DIAGNOSTICS v_renamed_count = ROW_COUNT`.
9. Idempotent re-run path: count=0 branch.
10. Atomic transaction wrapper.

Migration mapping:

| Step | Design | Migration line |
|---|---|---|
| 1 | Pre-mutation grand-total snapshot | 83–86 |
| 2 | Branch on `= 0` / `= expected` / `else` | 93, 96, 185 |
| 3 | `_spec005_actuals` snapshot before UPDATE | 102–110 |
| 4 | LEFT JOIN + COALESCE strictness | 116–121 |
| 5 | Diagnostic NOTICE LOOP + RAISE EXCEPTION | 123–136 |
| 6 | Target-canonical sanity check (= 3) | 144–156 |
| 7 | Single UPDATE driven by manifest join | 163–167 |
| 8 | Grand-total post-UPDATE assertion | 169–177 |
| 9 | Count = 0 → no-op NOTICE | 93–95 |
| 10 | BEGIN / COMMIT wrapper | 46, 193 |

**Every step is present in the migration.** No drift.

One **bonus** in the migration not strictly required by the design: line 180 reads `SELECT COUNT(*) INTO v_name_count FROM _spec005_renames` for the success NOTICE (line 182). Section 4's success-NOTICE sketch (lines 732–735) included a `v_name_count` variable too; the migration faithfully implements it. **No drift.**

### Section 8 build-stops (1–8)

Design states (after amendment #3):
- Build-stops 1, 3, 4, 5, 6 active.
- Build-stop 2 RESOLVED by user direction (2AM SAUCE 10 included).
- Build-stop 7 OBSOLETED.
- Build-stop 8 OBSOLETED.

Migration's pre-build verification (Build notes "Resumption — 2026-05-06 (post-amendment)" + "Final apply (amendment #3)"):

- Build-stop 1 (cross-brand): local probe gate 4 = 1 brand. Pass.
- Build-stop 3 (sub_recipe_id orphans): local probe gate 5 = 0 dangling, 0 non-current, 0 total. Pass.
- Build-stop 4 (per-name `current_count` ≠ 0): local probe gate 1 = 0 current at all 4 names. Pass.
- Build-stop 5 (target name canonical count ≠ 1): local probe gate 1b = 1 current at all 3 targets. Pass. **Plus** the migration enforces this in-band as an additional pre-mutation check (lines 144–156) — a defense-in-depth move that goes beyond the design's "pre-build probe" placement. **Improvement over design, not drift.**
- Build-stop 6 (local-vs-remote drift): RESOLVED via amendment #3 (`House Special Blend (Sauce)` is sibling Spec 006's territory). Confirmed in Build notes "Local-vs-remote side-by-side" at lines 1069–1110.
- Build-stops 2, 7, 8: marked appropriately (RESOLVED / OBSOLETED) in the spec.

**No build-stop was silently bypassed.** No drift.

---

## Architectural integrity post-amendment chain

I designed Spec 005 across three amendment passes today:

- **Amendment #1** (post-local-probe): corrected mechanic table from "1 flip on `38678f`" to "0 flips, all rename-into-collision"; obsoleted build-stop 7; resolved build-stop 2.
- **Amendment #2** (post-remote-probe refuting hypothesis (c)): extended manifest from 4 rows / 16 grand total to 5 rows / 22 grand total to cover `House Special Blend (Sauce)`; added build-stop 8 to block on Reading 1 vs Reading 2 disambiguation.
- **Amendment #3** (post-apply-time source-name re-probe confirming Reading 2 + user decision): reverted manifest to 4 rows / 16 grand total; obsoleted build-stop 8; deferred `House Special Blend (Sauce)` to sibling Spec 006.

The implementation matches amendment #3's final shape exactly. **No "stale-amendment text leaked into the implementation" artifacts found.** I did spot-check the most likely failure modes:

1. **Did the migration accidentally include the 5th-row `House Special Blend (Sauce)` extension from amendment #2?** No — only 4 rows in the manifest INSERT (lines 74–78) and only 4 source names in the migration's prose comment (lines 16–19).
2. **Did the migration accidentally retain the `is_current` flip CASE branch from the original design?** No — line 164 reads `SET name = m.new_name` only, no CASE.
3. **Did the migration accidentally encode `flip_target_uuid_prefix = '38678f'` from the original design?** No — line 78 has `NULL` on the `House Special Seasoning Mix` row (the row the original design wanted the flip on).
4. **Did the migration's grand-total expectation accidentally pick up amendment #2's `IN (16, 22)` 2-tuple?** No — line 51 reads `v_expected_grand constant int := 16`.

The implementation read the post-amendment-#3 spec correctly.

---

## Spec 003 halt-stop closure transition (post-amendment-#3)

The design's "Cross-spec coupling: Spec 003 retry" subsection (section 7, line 799) and Build notes "Verification gates" subsection (lines 1311–1346) jointly cover the closure status:

- **Halt-stop 2** (every affected name resolves to exactly 1 canonical): PASS on Spec 005's 4-name set. The 10-name affected set Spec 003 originally observed has collapsed to 7. Build notes at lines 1330–1340 verify with literal probe output.
- **Halt-stop 3** (variant evidence between `2AM Sauce` and `2AM SAUCE`): PASS. The names have merged; the variant evidence is gone.
- **Halt-stop 6** (local-vs-remote drift): **partial closure on Spec 005's 4-name set; full closure deferred to sibling Spec 006.** This is documented in Build notes line 1346: "Sibling Spec 006's territory per amendment #3 (`House Special Blend (Sauce)` cleanup), explicitly NOT a Spec 005 blocker."

The transition between Spec 005 and Spec 006 is documented at:

- Section 0 "Sibling Spec 006 reference" subsection (lines 239–249).
- Section 7 "Cross-spec coupling: Spec 003 retry" (line 799).
- Section 7 "Halt-stop 6" verification (line 859).
- Build notes line 1346.
- Handoff payload line 901.

A fresh reader can reconstruct the transition. **The seam is documented but not yet bridged** — Spec 006 doesn't exist on disk (M4 finding above). Once Spec 006 is filed, the seam is fully bridged.

---

## Migration filename and timestamp ordering

Filename: `20260506000000_rename_prep_canonicals.sql`.

Most recent applied migration before Spec 005 (verified): `20260505065303_admin_rpcs_lock_anon.sql` (per the migration's prose comment at line 43–44). The dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql` referenced in the design's section 3 (line 606) is the latest with timestamp `2026-05-05`; the `065303` suffix sorts after `000000`, but both are 2026-05-05 and Spec 005's `20260506000000` sorts cleanly after both.

Sibling Spec 006 timestamp considerations: if Spec 006 is filed and its migration takes timestamp `20260506xxxxxx` (any value greater than `000000`), it sorts cleanly after Spec 005 and there is no conflict. If Spec 003 retries with timestamp `20260506yyyyyy` (the design's section 3 line 607 forward-looking note), it must take a timestamp later than Spec 005's. Three migrations with same-day timestamps need at least minute-resolution distinct values; `000000`, `010000`, `020000`, etc. all work.

**No filename ordering drift.** The design's recommendation in section 3 to bump Spec 003's eventual filename to `20260506010000_*` or later remains valid; Spec 006's eventual filename should similarly take a later same-day timestamp slot. Both pending specs' authors must verify no clash with `20260506000000`.

---

## Lessons learned for future spec architecture

The architect went through three amendment rounds today (`#1`, `#2`, `#3`). Reflection on the rework drivers:

### What drove the rework

1. **Architect-can't-shell limitation drove most of amendment #1.** The original design encoded a hypothesis ("`38678f` is at the source name `House Special Seasoning Mix`") that turned out to be wrong. The architect could not run the probe inline; the developer ran it and surfaced build-stop 7 ("`38678f`-prefixed row not found at source name"). This is the exact failure mode the design's section 0 "Architect probe-execution constraint" callout flagged in advance — but the protection (probe SQL + amendment loop) cost one full amendment cycle.

   **Structural improvement candidate:** if the architect had access to a probe-only sandbox tier (read-only psql against local seeded DB, no edge functions, no remote), amendment #1 would have been avoided. The architect could have run the probe at design time and encoded the actuals directly. Cost: one more permission tier. Benefit: 1 amendment round eliminated.

   **Spec 003 had the same constraint.** Spec 003 also halted at probe and required the developer to surface findings to the user before the architect could re-design. The pattern is recurring — formalizing "architect probes locally, dev probes remotely" as the default flow on data-curation specs would shrink the average amendment count from ~2 to ~1.

2. **Hypothesis-driven design without remote read access drove amendment #2.** The architect's hypothesis (c) ("the +6 drift is on `prep_recipe_ingredients`, not `prep_recipes`") was a reasonable bet given the 5%-likelihood estimate in section 6. It happened to be wrong. The probe-gate-2 design caught it loudly, but only after the architect was dispatched twice.

   **Structural improvement candidate:** the design could have explicitly invoked the user's authorization at design time for read-only remote access (similar to the `npx supabase db query --linked` pattern the dev eventually used). Authorizing at design-time saves the round-trip through the developer.

3. **Reading-1-vs-Reading-2 disambiguation drove amendment #3.** Once the 5th-row extension was on the table, the architect couldn't disambiguate which name string to put in the manifest's `old_name` cell without an apply-time re-probe. Build-stop 8 was the right hedge — it forced a STOP-and-surface rather than a guess — but it added an entire amendment cycle.

   **Structural improvement candidate:** when extending a curation contract to cover a name surfaced by a probe, the probe SQL should ALWAYS capture the source name as a literal string (not via a `LIKE` filter) — so the architect can trust the captured string verbatim. Spec 005's gate-2 SQL aggregated by `pr.name` but the JOIN multiplication artifact obscured the actual `prep_recipes` row count vs the orphan ingredient row count. **This is a probe-gate hygiene improvement that I would carry into future curation specs.**

### CLAUDE.md / architect-prompt updates worth proposing

These are advisory notes the user / project owner can act on; not blocking findings on Spec 005.

1. **Add an "architect-may-probe-locally-read-only" tier to the architect's tooling.** Quotes from CLAUDE.md "Resolved questions / project context" do not yet acknowledge this tier. Today the architect must rely on the developer to run any probe.
2. **Codify probe-gate hygiene rules** for curation specs:
   - Probes MUST capture row counts from `prep_recipes` (or other source-of-truth table) DIRECTLY, separately from any `prep_recipe_ingredients` (or join-multiplied) counts.
   - Probes MUST capture name strings as literal column values, not via aggregated `LIKE` predicates.
   - Probes MUST run on remote at design time (with user authorization captured in the spec) before any "remote drift hypothesis" is treated as load-bearing.
3. **When extending a curation contract via amendment**, the architect should re-derive the manifest's `old_name` and `new_name` from probe-captured strings, not from prose summaries written by the developer. (Amendment #2's "the dev's resumption notes describe both source and target as `House Special Blend (Sauce)`" was the source of the Reading 1 vs Reading 2 ambiguity.)
4. **Two amendments is the practical cap** before the spec should be split. Three amendments (Spec 005's count) is at the edge of where a sibling spec is cleaner than a contract extension. The user's correct call to file Spec 006 at amendment #3 instead of further extending Spec 005 demonstrates this — but the threshold could be a project-policy default, not a per-spec decision.

These are observations from the architect's perspective; the user is the right party to evaluate whether they belong in CLAUDE.md.

---

## Verdict

**Implementation matches design at amendment-#3.** No Critical or Should-fix findings. 4 Minor findings, all spec-hygiene flags, none of which BLOCK SHIP_READY. Local apply is clean; remote push is the user's call given the deferred sibling Spec 006 scope.

The migration is safe to ship locally. The design's prediction that the migration is byte-identical for remote (gate 1 + gate 1b agree across environments on the 4 affected names) holds; remote push will replay the same 16-row rename without surprises on the 4-name set. `House Special Blend (Sauce)` remote-only drift is correctly out of Spec 005's scope.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor findings. The migration is a faithful implementation of the post-amendment-#3 design contract; no SHIP_READY blockers. Spec hygiene flags surfaced for documentation cleanup; sibling Spec 006 reference noted as a forward-looking seam pending PM filing.
payload_paths:
  - specs/005-prep-canonical-curation/reviews/backend-architect.md
