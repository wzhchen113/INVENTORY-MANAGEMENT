# Spec 093 — backend-architect post-implementation drift review

Reviewer: `backend-architect` (post-impl mode). Authored the `## Backend design`
(§0–§12) in `specs/093/spec.md`; this file compares what landed against that
contract. Read-only review.

**Verdict: no drift.** The implementation matches the design on every checked
point. Zero Critical, zero Should-fix. Three Nits, all documentation/wording —
none block ship. The owner-confirmed boundaries (R2 `default_cost` out of scope,
R4 `calcCasePrice` asymmetric, db.ts:278-280 unchanged) all held.

The realtime-publication-snapshot gotcha **does NOT apply** — confirmed below.

---

## Contract conformance (what I verified)

### Migration — `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql`

Matches §1a + §1b exactly:

- **Predicates (§1a).** B-snapshot/UPDATE gate `coalesce(case_qty,1) <= 1 AND
  coalesce(sub_unit_size,1) > 1` (lines 82-83, 123-124); C-snapshot gate
  `coalesce(case_qty,1) > 1 AND coalesce(sub_unit_size,1) > 1` (lines 98-99).
  `coalesce(...,1)` numeric-safety present on every predicate, mirroring reorder
  088 as designed. `sub_unit_unit` is correctly NOT in the predicate (lines
  30-33 comment + absence in WHERE), so empty-unit B mis-files are not skipped.
- **Audit table shape (§1b step 1).** `public.spec093_case_qty_backfill_audit`
  with the exact 10-column shape designed (lines 54-65): `catalog_id` PK, `name`,
  `brand_id`, `old_*` ×3, `new_*` ×2, `population char(1)`, `migrated_at`.
  `create table if not exists` (idempotent). RLS enabled + `revoke all ... from
  anon, authenticated` (lines 67-68) — the §2 back-office posture, explicit.
- **Order: snapshot-then-UPDATE (§1b steps 2-4).** Population B snapshot (lines
  72-84) and Population C snapshot (lines 88-100) both run BEFORE the
  Population-B UPDATE (lines 119-124). The UPDATE touches Population B only.
  `on conflict (catalog_id) do nothing` on both inserts (lines 84, 100) —
  re-run safe per §1b idempotency.
- **RAISE NOTICE of the C count (§1b step 3).** Lines 104-112 — owner sees
  "N split rows flagged for owner hand-review" in the `db push` output.
- **`updated_at = now()` on the UPDATE (§6).** Line 122 — realtime fan-out
  replays the change for an admin with the catalog open during the push.
- **Commented BACKOUT block (§1b step 5).** Lines 128-147 — restore-from-audit
  for Population B, then `drop table`, NOT auto-applied. Matches the designed
  shape verbatim.
- **R1 (Population C never mutated).** Confirmed — C is snapshot-only; no UPDATE
  references the C predicate.
- **R2 (`default_cost` NOT touched).** Confirmed — the UPDATE sets only
  `case_qty`, `sub_unit_size`, `updated_at`. No `default_cost` in the SET list.
  The header comment (lines 16-19) documents this as the deliberate out-of-scope
  boundary, which is the right place for it.
- **Single transaction** (`begin;`/`commit;`, lines 45/126). Sorts strictly
  after `20260602000000_reorder_suggested_cases.sql` (§R3) — depends only on
  `catalog_ingredients` (P1), satisfied.

### `calcUnitCost` + db.ts fallback (§5/§8, Q3a)

- **`src/utils/unitConversion.ts:290-298`** — `calcUnitCost` now divides by
  `caseQty` alone (`const totalPerCase = caseQty;`, line 295). 3-arg signature
  preserved; `subUnitSize` retained and explicitly `void`-ed (line 294) so it
  doesn't read as an accidental omission — exactly the §8 decision. Satisfies the
  AC pin `calcUnitCost(20.00, 20, anything) === 1.00`.
- **R4 — `calcCasePrice` left as-is.** `src/utils/unitConversion.ts:301-303`
  keeps `unitCost * caseQty * subUnitSize`. This is the owner-confirmed
  asymmetric boundary. See Nit-2 below for the practical blast radius (it is
  smaller than the design feared).
- **`src/lib/db.ts:3710-3719`** — the `costPerUnit` IIFE fallback now returns
  `caseQty > 0 && cp > 0 ? cp / caseQty : 0` (line 3719), divide-by-`case_qty`
  alone per §5. Still gated behind the stored-`cost_per_unit`-first check (line
  3712), so seeded data behavior is unchanged in practice, as designed.
- **db.ts:278-280 write mapping unchanged.** Confirmed — `caseQty → case_qty`,
  `subUnitSize → sub_unit_size`, `subUnitUnit → sub_unit_unit` are byte-for-byte
  the §0 "one correct seam." No new helper, no signature change to
  `updateInventoryItem`. The snake_case→camelCase mapping at db.ts:3702-3736 is
  intact.

### Form — `src/components/cmd/IngredientForm.tsx` (§7/§9)

- **Re-bind + relabel (§7).** Case-size `InputLine` (line 718) binds
  `set('caseQty', v)` with label `units / case`; sub-unit `InputLine` (line 724)
  binds `set('subUnitSize', v)` with label `sub-unit / unit`. The `set` helper
  (line 381) writes to discrete keys, so the two axes are structurally
  un-conflatable. Form keys (`caseQty`/`subUnitSize`) unchanged → db.ts mapping
  untouched, as the contract required.
- **Help reword (§9).** Case-size help: "how many tracking units come in one
  case (e.g. 20 lbs per case)". Sub-unit help: "how many sub-units make up ONE
  tracking unit (e.g. a bag of 10 each)" — the per-tracking-unit meaning, fixing
  the contradiction. PACK UNIT help (lines 732, 786, both CustomUnitInput +
  SelectField branches): reworded off "shipping wrapper" to "the unit each
  sub-unit is measured in — each, lb, oz", keeping the Conversions-tab sentence.
- **Readback (§9).** Lines 790-810 — drives off `Number(values.caseQty)`, renders
  `1 case = {caseSize} {contentsUnit}` with `contentsUnit = subUnitUnit || unit
  || 'each'`. The `× … per order` arithmetic is deleted. Finite/positive guard
  preserved (line 801) → renders nothing for empty/zero. Contains "1 case = 20
  lbs", never "20 cases per order" — the exact AC.
- **Doc comment (§7).** `IngredientFormValues.subUnitSize` (line 35) rewritten
  from the bug-encoding "default unit size (e.g. 40 lbs per case)" to
  "sub-units PER ONE TRACKING UNIT … NOT the case size". `subUnitUnit` comment
  (line 36) also clarified. `blankValues()` keeps `caseQty:'1', subUnitSize:'1'`
  (line 66) — correct defaults per §7.
- **R6 preserved.** `CustomUnitInput` "+ custom…" swap (lines 727-788),
  `abstractUnitWarning` block (lines 811-817), pack-unit SelectField placeholder
  (line 784) all intact.

### Tests (§11)

- **Track-2 pgTAP** `supabase/tests/spec093_case_qty_backfill.test.sql` — 8
  assertions: backfill correctness (B 1/500→500/1, C 4/5 unchanged + flagged
  pop 'C', A 450/1 untouched, D 1/1 untouched, 0 mis-encoded remain, B in audit
  with old 1/500 snapshot) + reorder round-trip (`case_qty=20`, par 50 →
  `suggested_cases = ceil(50/20) = 3`). The backfill body is replicated inline
  (documented at lines 31-35) to run inside one rolled-back txn; SQL mirrors the
  migration. No `set role anon` (spec 067 segfault avoidance). Master-JWT pattern
  mirrors `report_reorder_list_cases.test.sql`. Matches §11 Track-2.
- **Track-3 smoke** `scripts/smoke-migrate-spec093.sh` — applies the REAL
  migration to the live container, asserts audit table exists + RLS-on +
  0 anon/authenticated grants + 0 mis-encoded rows + idempotent re-apply.
  Matches §11 Track-3.
- **Track-1 jest** — `IngredientForm.test.ts` calcUnitCost pins (4 cases incl.
  the AC pin + non-positive guard); `IngredientForm.spec093.test.tsx` (9 tests:
  readback contains/excludes, subUnitUnit-empty fallback `1 case = 450 each`,
  empty-case guard, distinct labels, per-tracking-unit help, no-"shipping
  wrapper", independent-axes write); `IngredientForm.help-text.test.tsx`
  PACK_UNIT_HELP constant updated to §9 copy with behavioral assertions
  preserved; `EODCount.test.tsx` round-trip `3 × 20 + 4 = 64`. Matches §11
  Track-1.

### Realtime / publication posture (explicitly confirmed)

**The realtime-publication-snapshot gotcha does NOT apply.** The migration adds
NO table/column to `supabase_realtime`. It UPDATEs existing rows of the
already-published `catalog_ingredients` (replays on `brand-{id}` via the bumped
`updated_at`), and the new `*_audit` table is intentionally NOT added to any
publication. No `docker restart supabase_realtime_imr-inventory` is needed —
this is purely the designed §6 posture, confirmed against the landed SQL.

---

## Findings

### Critical
None.

### Should-fix
None.

### Nits (documentation / wording — do not block ship)

**Nit-1 — Audit table has no lifecycle owner; it persists in prod indefinitely
after the push.**
`public.spec093_case_qty_backfill_audit` is created `if not exists` and is
intentionally NOT dropped by the migration (it is the backout source + the
Population-C hand-review list — correct per §1b). The consequence, which is
correct-by-design but undocumented as an operational follow-up: after the owner
runs `db push` and resolves the Population-C rows by hand, a permanent
back-office table named after a one-shot spec lingers in the prod `public`
schema with no scheduled cleanup. The commented BACKOUT block drops it, but the
*success* path never does. This is a known shape (spec-named one-shot artifact),
not a defect — the migration is correct. Recommend a one-line owner-facing note
(or a tiny follow-up cleanup migration once the C list is resolved) so the table
doesn't become permanent schema cruft. No code change required for ship.
Reference: migration lines 54-65 (create), 145 (drop only in the commented
backout). Surfacing per my §1b design intent; not drift.

**Nit-2 — R4 (`calcCasePrice` asymmetry) has effectively zero runtime blast
radius today — worth recording so the residual risk isn't overstated.**
My §8/§R4 flagged that `calcCasePrice` keeping `× subUnitSize` while
`calcUnitCost` drops it would make cost→price→cost round-trips disagree on
`sub_unit_size > 1` rows. A grep for non-test call sites of BOTH functions
returns only their definitions in `src/utils/unitConversion.ts` — neither
`calcUnitCost` nor `calcCasePrice` is called anywhere in app code (the only
references outside the definitions are the jest pins). So the asymmetry is
currently unreachable at runtime; no round-trip exists to diverge. This is the
owner-confirmed out-of-scope boundary and I am NOT asking to change it — only
recording that R4's *practical* severity is lower than the design's worst case.
If a future spec wires `calcCasePrice` into a real cost→price path, R4 re-arms
and should be revisited then. Reference: grep of `calcUnitCost|calcCasePrice`
across `src/**` (non-test) returns only `src/utils/unitConversion.ts`.

**Nit-3 — Readback noun is hardcoded `1 case = …` regardless of DEFAULT UNIT;
matches the AC but is slightly looser than my §9 nuance note.**
§9's "Label-vs-DEFAULT-UNIT nuance" suggested the readback noun source could
track the pack noun vs. fall back to a literal "case". The implementation
hardcodes the literal `1 case = ${caseSize} ${contentsUnit}` (line 806) for all
inputs. This is FINE — it satisfies the exact AC assertion (contains "1 case =
20 lbs", excludes "20 cases per order") and reads correctly for both the
`cases`/`lbs` and `each`/450 shapes the tests pin. The only edge it doesn't
gracefully handle: if a manager set DEFAULT UNIT to a pack noun that ISN'T
"case" (e.g. `tray`), the readback still says "1 case = …" rather than "1 tray =
…". That was explicitly left to FE's discretion in §9 ("FE picks the noun
source"), the owner has no wording preference, and no AC or test pins the
non-"case" pack noun — so this is acceptable as shipped. Recording it only so a
future reviewer doesn't mistake the hardcoded noun for an oversight. Reference:
`src/components/cmd/IngredientForm.tsx:806`.

---

## Notes acknowledged from the implementation (not drift, not findings)

- **Reset-runs-migrations-before-seed artifact** (backend dev's operational
  note, spec lines 833-841): on a local `supabase db reset`, the migration runs
  against an empty catalog (touches 0 rows, RAISE NOTICE reads "0 split rows");
  the seed then re-inserts the prod-shaped mis-encodings. The Track-3 smoke is
  the tool that exercises the migration against seeded/prod-shaped data. On
  prod, the owner's `db push` runs against the already-populated table and DOES
  fix the live rows. This is a correct read of the reset ordering and is exactly
  why the Track-3 smoke (apply-against-live-seeded-DB) exists alongside the
  pgTAP (apply-against-fixtures-in-txn). No action — the migration is correct;
  the artifact is a property of `db reset`, not of this migration.
- **`db-migrations-applied.yml` drift gate (§R3):** the owner MUST actually run
  `supabase db push` so prod's `schema_migrations` gains the
  `20260602120000` entry, else the next drift-gate run hard-fails on
  missing-in-prod. This is the intended posture (owner-run push). Flagging again
  so the push is not forgotten between SHIP_READY and the next CI run on `main`.
- **Migration ordering (§R3):** `20260602120000` sorts strictly after every
  existing migration including `20260602000000_reorder_suggested_cases.sql`. No
  ordering hazard. Confirmed against the landed filename.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Nits
  (all documentation/wording — audit-table lifecycle, R4 has zero runtime blast
  radius today, readback noun hardcoded-but-AC-compliant). No contract drift;
  owner-confirmed boundaries (R2/R4/db.ts:278-280) all held; the
  realtime-publication gotcha does NOT apply (no publication membership change).
payload_paths:
  - specs/093/reviews/backend-architect.md
