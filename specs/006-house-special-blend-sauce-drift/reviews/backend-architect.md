# Backend architect — post-impl drift review (Spec 006)

Spec: `specs/006-house-special-blend-sauce-drift.md`
Mode: post-implementation drift review (Status: READY_FOR_REVIEW)
Author: backend-architect (same agent that authored §0–§16 design)

## Verdict

**Clean — no drift.** The implementation matches my design under §0–§16 with
one user-authorized correction (the §3 assertion-2 tightening) that I should
have written into the design originally. All four §5 verification probes
returned the predicted values on prod. The recovery-snapshot substitution
(architect's `psql \copy TO` → dev's `supabase db query --linked` +
`to_jsonb`) preserves the §14 rollback contract. Owner-notes line 99 landed
verbatim. Path A applied cleanly; paths B and C remain consistent with the
matrix in §13.

Findings: **0 Critical, 0 Should-fix, 2 Nits.** Both nits are documentation
hygiene on the design side, not implementation drift.

---

## 1. Was the §3 tightening the right call? — RESOLVED

My original intent for §13 path-C was **structural abort** ("we deliberately
do not make the migration tolerant of 'row exists but with `is_current = true`'
— that would mask exactly the kind of drift this spec is cleaning up"). That
prose is unambiguous. The dev's read was correct.

What I shipped in §3 contradicted my own §13 prose: assertion 2's parent
SELECT was unfiltered on `is_current`, so on local-with-seed the
`v_parent = 1` branch would have fired, the `v_ing = 6` check passed (since
local-with-seed does have 6 ingredient rows), neither RAISE branch tripped,
and the DELETEs would have wiped local canonical data silently. That is the
exact silent-mutation failure §13 path-C was advertised to prevent.

The dev's `AND is_current = false` addition (one clause, mirroring assertion
1's filter) restores §13 path-C's promised behavior — the
`v_parent = 0 AND v_ing = 6` shape now triggers the second RAISE branch with
the named exception verbatim, ROLLBACK clean, no local data touched. The
build notes' executed dry-run output:

```
NOTICE:  assertion_1: v_count = 0
NOTICE:  assertion_2: v_parent = 0, v_ing = 6
ERROR:  spec006: parent stale row absent but 6 orphan ingredient rows
        remain (idempotency invariant violated)
ROLLBACK
```

matches the §13 path-C predicted shape exactly.

**Verdict: design defect in my §3 draft, not over-conservatism in the fix.**
The tightening is load-bearing and the user-authorized one-line correction
was the right move. No revert. Mark RESOLVED.

(The §13 prose did not need correction — only the §3 SQL needed to be brought
into agreement with §13. That happened.)

---

## 2. §3 contract integrity post-tightening — VERIFIED

Re-derived `(v_count, v_parent, v_ing)` and which RAISE branch fires under
each apply path, against the actual landed migration at
`supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`:

| Path | Where | `v_count` (a1) | `v_parent` (a2) | `v_ing` (a2) | Branch behavior | Outcome |
|------|-------|----------------|-----------------|--------------|-----------------|---------|
| **A — prod normal** | `db push --linked` against remote | 1 | 1 | 6 | Both RAISE skipped (v_count ∈ {0,1}; `v_parent=1 AND v_ing<>6` false; `v_parent=0 AND v_ing<>0` false). DELETEs run: a3 sees 6 (∈{0,6}), a4 sees 1 (∈{0,1}). | COMMIT — payload landed |
| **A' — prod re-apply** | idempotency | 0 | 0 | 0 | Both RAISE skipped. DELETEs no-op: a3 sees 0, a4 sees 0. | COMMIT — clean no-op |
| **B — empty local DB** | `db reset --local` pre-seed | 0 | 0 | 0 | Same as A'. | COMMIT — no-op |
| **C — local with seed** | `db reset --local` + seed | 0 | 0 | 6 | a1 OK (`v_count=0` ∈ {0,1}). a2: `v_parent=0 AND v_ing<>0` TRUE → second RAISE fires. | ROLLBACK — named exception |

All four RAISE branches still reachable:

- **a1's `NOT IN (0,1)`** — would fire on `v_count >= 2`, structurally
  impossible since `id` is the PK. Defensive only; correct.
- **a2 first branch** (`v_parent=1 AND v_ing<>6`) — would fire if prod's
  ingredient fan-out drifts post-probe. Not exercised on the path-A actual
  apply.
- **a2 second branch** (`v_parent=0 AND v_ing<>0`) — confirmed firing on
  local path-C dry-run.
- **a3's `NOT IN (0,6)`** — defensive against partial cascade weirdness.
- **a4's `NOT IN (0,1)`** — defensive against PK violation paranoia.

Contract integrity preserved across all three apply paths.

---

## 3. §5 verification probes — CONFIRMED

| Probe | Expected | Spec build notes | Verdict |
|-------|----------|------------------|---------|
| verify_a — stale row gone | 0 | 0 | PASS |
| verify_b — orphan ings for stale id gone | 0 | 0 | PASS |
| verify_c — canonical untouched | `36016d31` / `is_current=true` | match | PASS |
| verify_d — Spec 003 grand-total drift closed | 399 (was 405; Δ=−6) | 399 | PASS |

The verify_d arithmetic (405 → 399, Δ=−6) is consistent with my §5
prediction. The 6 deleted `prep_recipe_ingredients` rows were the only
left-join hits affected; the deleted `prep_recipes` parent doesn't appear in
the left-join's count. No drift.

---

## 4. §2 recovery-snapshot substitution — ROLLBACK CONTRACT INTACT

**My §2 design specified:** `psql "$REMOTE_DB_URL"` with `\copy ... TO` of
TSVs to filesystem under
`scripts/recovery-snapshots/<timestamp>-spec006/`.

**Dev shipped:** `npx supabase db query --linked` with `to_jsonb(t.*)`
projections written to JSON files PLUS matching TSVs in the same shape my
§2 specified. Reason cited in handoff: `.env.local` doesn't carry
`REMOTE_DB_URL` and the Supabase CLI's saved auth token doesn't expose a
password, so direct `psql` connection wasn't available without the dev
manually fetching the connection string from a different channel.

**Rollback contract check.** §14's restore procedure is:

```
\copy prep_recipes FROM '$SNAP/prep_recipes_4fbd90.tsv'
  WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
\copy prep_recipe_ingredients FROM '$SNAP/prep_recipe_ingredients_4fbd90.tsv'
  WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
```

The shipped TSVs:

- `prep_recipes_4fbd90.tsv` — 2 lines (1 header + 1 row). Header columns
  match the live `prep_recipes` schema (`id, name, category, yield_quantity,
  yield_unit, notes, created_by, created_at, version, is_current, parent_id,
  brand_id`). Tab-delimited. Restorable.
- `prep_recipe_ingredients_4fbd90.tsv` — 7 lines (1 header + 6 rows). Header
  columns match `prep_recipe_ingredients` schema (`id, prep_recipe_id,
  quantity, unit, base_quantity, base_unit, type, sub_recipe_id,
  catalog_id`). Tab-delimited. Restorable.

The §14 `\copy ... FROM` procedure works against these files as-is. The
substitution is method-only, not artifact-shape — the TSVs that §14 expects
are present and well-formed. **Rollback contract preserved.**

The JSON pair files (`*.json`) are additive — not part of §14's restore
procedure. They serve as a human-readable cross-reference and impose no
contract burden. No drift.

Whether the dev should have surfaced this substitution as an architect-level
spec amendment before applying is a process question, not a contract
question. The build notes acknowledge it but don't call out the §2 method
delta explicitly. See Nit #1 below.

---

## 5. §4 owner-notes edit — VERIFIED

Read of `docs/internal/prep-canonicalness-notes.md` line 99:

```
### House Special Blend (Sauce) (canonical prefix: 36016d31)
```

Matches my §4 specified after-text exactly. Lines 100–105 (the 6 ingredient
lines beneath) untouched per §4 and §15's owner-notes-drift risk. No drift.

---

## 6. §13 apply-path matrix — CONSISTENT

- **Path A** — applied cleanly on prod via user-authorized
  `npx supabase db push --linked` on 2026-05-07. §5 verifies confirm payload
  landed correctly. Matches §13 row 1.
- **Path B** — empty-DB no-op contract. Not exercised on this build (no
  reason to), but the migration shape (`v_count=0, v_parent=0, v_ing=0`,
  all branches skipped) is unchanged from my §13 prediction. Idempotent.
- **Path C** — local-with-seed dry-run executed at build time, ROLLBACK
  clean with the named exception, no local data mutated. Build notes record
  the executed output verbatim. Matches §13 row 3 (after the §3 tightening).

All three paths consistent with what shipped.

---

## 7. §16 carry-forward flags — VERIFIED

| §16 flag | Architect's call | Landed |
|----------|------------------|--------|
| Snapshot committed in same commit as migration | YES — durable rollback artifact | YES — under `scripts/recovery-snapshots/20260507T040300Z-spec006/` |
| Migration filename `20260507030000_spec006_…` | proposed | `20260507030000_spec006_house_special_blend_sauce_cleanup.sql` — exact match |
| `audit_log` row inside transaction | NO — filesystem snapshot is sufficient | not added; matches design |

All three landed as planned.

---

## 8. Spec 003 unblock — CONFIRMED

verify_d's drop from 405 → 399 closes Spec 003's gate_1 grand-total +6 stop
condition (per Spec 006 Q4 resolution: "Spec 006 does close the +6
grand-total drift currently triggering Spec 003's gate_1 stop condition").
Spec 003 retry is now eligible to re-probe without that stop condition
firing.

The other gate_1 condition — Spec 003's name-keyed manifest check — is
unaffected by Spec 006 (Spec 003's manifest never included House Special
Blend (Sauce); see Spec 006 §"Out of scope"). No interaction with that gate.

---

## Findings

### Critical: 0

### Should-fix: 0

### Nits (design-side hygiene, optional follow-ups, not gating)

**Nit #1 — §2 should call out the `psql "$REMOTE_DB_URL"` assumption as a
prereq, not a given.** My §2 reads `psql "$REMOTE_DB_URL"` with no caveat
about how `REMOTE_DB_URL` is sourced. The dev hit exactly this — the env
var doesn't exist in `.env.local` and the Supabase CLI's saved token doesn't
expose the password. Future ops on this pattern will hit the same wall. A
one-line note in §2 saying "developer must source `REMOTE_DB_URL` via
`supabase status --linked` / dashboard / `.env` — not assumed available"
would prevent the next build from re-discovering this. Cite:
`specs/006-house-special-blend-sauce-drift.md` §2 line ~430.

**Nit #2 — §3 should self-document the `is_current = false` filter on
assertion 2's parent SELECT.** The landed migration has the filter (the
dev's user-authorized fix), but the design's §3 still shows the unfiltered
SELECT. If a future operator references §3 as a template for a similar
drift-cleanup migration, they will copy the unfiltered shape. The §3 SQL
in the spec file should be updated post-hoc to mirror what shipped, with a
brief comment explaining why path-C demands the filter. This is design
documentation drift, not implementation drift. Cite:
`specs/006-house-special-blend-sauce-drift.md` §3 lines 502–504.

Both nits are paper-trail cleanup, not blockers. Neither affects ship
readiness for Spec 006.

---

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  2 Nits — both design-documentation hygiene, not implementation drift.
  Implementation matches design with one user-authorized §3 correction
  (assertion 2 `AND is_current = false`) that resolved a defect I should
  have caught at design time. All §5 verification probes PASS on prod.
  Rollback contract intact despite the §2 method substitution. Spec 003
  gate_1 +6 stop condition closed.
payload_paths:
  - specs/006-house-special-blend-sauce-drift/reviews/backend-architect.md
  - specs/006-house-special-blend-sauce-drift.md
  - supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql
