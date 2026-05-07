## Code review for spec 006

Reviewer: code-reviewer
Date: 2026-05-07
Surface area: migration SQL (126 lines), owner-notes line 99 edit, recovery snapshot (4 files), spec build notes.

---

### Critical

None.

---

### Should-fix

**1. `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql:44–90` + spec build notes — Dry-run was performed against a different version of the SQL than what shipped.**

The path-C dry-run output recorded in `## Build notes` shows `NOTICE` lines:

```
NOTICE:  assertion_1: v_count = 0
NOTICE:  assertion_2: v_parent = 0, v_ing = 6
```

The committed migration has no `RAISE NOTICE` calls anywhere in assertions 1–4. The apply log also refers to "`RAISE NOTICE` lines from the assertion block" and excuses their absence from `db push` output as an "output filter" artifact — but there are no NOTICE statements that could have produced those lines.

This means the dry-run was executed against an intermediate version of the SQL that included NOTICE instrumentation that was stripped before commit. The build notes are therefore a record of a test that was run against code that does not match what shipped. For a prod-mutating one-shot migration the audit trail needs to describe what actually ran.

The finding is not that NOTICEs are missing from the committed SQL (diagnostic output in migrations is optional), but that the build notes and apply log falsely attribute those lines to the committed file. The apply log's sentence beginning "The `RAISE NOTICE` lines from the assertion block..." should be corrected to acknowledge the dry-run used an instrumented version of the SQL, and that the committed migration contains no NOTICE statements.

**Suggested fix:** Add a brief clarifying sentence to the build notes' apply log paragraph: e.g., "The path-C dry-run was run against an instrumented version of the SQL (with `RAISE NOTICE` calls added temporarily). The committed migration omits those calls; the post-apply verification probes serve as the definitive correctness evidence."

---

**2. `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql:44–60` — Assertion 1's `v_count NOT IN (0, 1)` branch is structurally unreachable.**

`id` is the primary key of `prep_recipes`. A `count(*)` filtered by `id = <literal uuid>` can only return 0 or 1. The `RAISE EXCEPTION` branch guarding against `v_count > 1` can never fire. This is not harmful, and the defensive intent is understandable given the "no partial repair" policy, but it adds dead-branch commentary that misleads future readers: the inline comment `-- (the row id is the PK, so >1 should be impossible — fail loudly if it ever happens)` is correct but the branch itself can never trigger, so the comment ends up describing a hypothetical that Postgres's constraint layer has already made impossible.

The same structural observation applies (more subtly) to the v_parent check in assertion 2, though that one is filtered on both `id` AND `is_current = false` — at most 1 row.

**Suggested fix:** Either remove the `NOT IN (0, 1)` check and document why (PK guarantee), or keep it and remove the "if it ever happens" language — the branch truly never fires, so the comment is false advertising. The simpler fix is to replace the guard with a comment: `-- v_count is always 0 or 1 (PK); assertion exists for clarity only.`

This is a minor craftsmanship nit elevated to Should-fix because the comment actively misleads about reachability.

---

### Nits

**3. `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql` — Comment density is higher than the project's default-no-comment convention.**

CLAUDE.md's spirit is to comment the *why*, not the *what*. Lines 1–38 (the file header block) document idempotency contract, apply-path matrix, and rollback pointer — these explain why each path produces the result it does, which is exactly the right level. Lines 42–43, 62–64, 92, 109 (inline `--` banners before each DO block) also name the assertion's purpose, which is fine. No individual comment is wrong. The overall density is at the high end for this project, but for a one-shot prod-mutating migration the documentation value is high and the cost is zero, so this is preference-level, not a defect.

**4. `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql:93–107` — Assertion 3 and assertion 4 are each their own DO block rather than folded into the DELETE block.**

The architect's §3 hint says "wrap the DELETE" (meaning DELETE + GET DIAGNOSTICS in the same block). The developer did exactly that — each DO block contains both the DELETE and the count check. This is correct. However, the comment on line 92 calls this block "Delete: ingredients first (FK respect), with deleted-count assertion" while the code comment header says "─── Assertion 3". The inconsistency between calling the block an assertion in one place and a delete-with-assertion in the comment heading is minor but could confuse a future operator reading the error message `spec006: prep_recipe_ingredients delete affected % rows` and trying to locate which block it came from.

**5. `scripts/recovery-snapshots/20260507T040300Z-spec006/prep_recipes_4fbd90.tsv` — TSV `created_by` and `parent_id` columns are empty strings, not SQL NULLs, but the restore procedure will handle this correctly.**

PostgreSQL `\copy FROM` with `FORMAT csv` treats unquoted empty fields as NULL (not empty string) for typed columns (UUID in this case). So the restore procedure in §14 will correctly insert `NULL` for `created_by` and `parent_id`. No action required — documenting here because the TSV appearance (blank field adjacent to tab) can look ambiguous to a human reader doing a manual restore. The JSON backup captures `null` explicitly, which removes the ambiguity and serves as the authoritative check.

**6. `docs/internal/prep-canonicalness-notes.md:99` — Lines 100–105 (the 6 ingredient lines beneath the heading) now describe the OLD `4fbd90` recipe's ingredient list, not the surviving `36016d31` canonical.**

The architect flagged this in §15 ("Owner-notes drift") and §4 as a follow-up item, and the spec correctly marks it out of scope. The build notes also call it out. This nit is to confirm the reviewer has read and agrees with the out-of-scope designation, not to re-open it. The lines should be re-curated by the owner after Spec 006 ships — ensure the follow-up is tracked.

**7. `specs/006-house-special-blend-sauce-drift.md` (build notes, "Recovery snapshot" table) — The spec table says "Lines: 2" for `prep_recipes_4fbd90.tsv` and "Lines: 7" for `prep_recipe_ingredients_4fbd90.tsv`.**

Confirmed correct: the actual TSV files have 2 lines (1 header + 1 data row) and 7 lines (1 header + 6 data rows) respectively. The JSON files are listed in the table as "Lines: —" because JSON arrays don't have a meaningful line count for the same purpose; this is acceptable. No action required.

---

### Summary

0 Critical findings. 2 Should-fix findings (dry-run audit trail inaccuracy; structurally unreachable guard branch with misleading comment). 5 Nits (4 craftsmanship observations, 1 out-of-scope follow-up reminder).

The migration SQL is structurally sound: the §3 tightening (`AND is_current = false` on assertion 2's parent SELECT) correctly closes the path-C silent-delete gap; the idempotency contract is well-formed; the assertion ordering (count-before-mutate, ingredients before parent) is correct; the STALE_PREP_ID literal matches the probe-pinned UUID; and the owner-notes edit at line 99 (`4fbd90` → `36016d31`) matches the architect's documented before/after exactly. No forbidden files were touched (AdminScreens.tsx, useSupabaseStore.ts, useJsonServerSync.ts, db.json, app.json unchanged). No direct Supabase calls, no frontend changes.
