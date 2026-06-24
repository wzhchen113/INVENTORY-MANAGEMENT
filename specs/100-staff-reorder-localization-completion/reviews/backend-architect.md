# Backend-architect drift review — Spec 100 (staff reorder localization)

Mode: post-implementation drift review (against the `## Backend design` I authored).
Scope reviewed: the two backend files only.

- `supabase/migrations/20260623000000_reorder_list_i18n_names.sql`
- `supabase/tests/report_reorder_list_i18n_names.test.sql`

Plus contract-adjacent verification of the frontend mapper carry-through
(`src/screens/staff/lib/fetchReorder.ts`) and the deliberate admin divergence
(`src/lib/db.ts:mapReorderVendor`).

Verdict: **no Critical, no Should-fix. Two Minor notes (both documentation-only).**
The implementation matches the contract.

---

## Critical trap verification (the headline ask)

### Latest-on-disk body confirmed
`report_reorder_list` appears in 4 migration files. Only two DEFINE it:
- `20260514130000_report_reorder_list.sql` (spec 021 original, then spec 087 in-place).
- `20260602000000_reorder_suggested_cases.sql` (spec 088 — latest before this spec).

The other two (`20260524000000_compute_menu_capacity_rpc.sql`,
`20260623000000` header) reference it only in comments. **No migration dated
after `20260602000000` redefines the function** other than the new spec-100
one — so `20260602000000` is correctly the latest on-disk body to copy from.
The new file's timestamp (`20260623000000`) sorts strictly after it. PASS.

### (1) Signature byte-identical → ACL preserved — PASS
New file lines 46–52 vs latest lines 65–71 are byte-for-byte identical:
`report_reorder_list(p_store_id uuid, p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public`.
`create or replace` therefore preserves the spec-021 `revoke … from public,
anon` + `grant … to authenticated` ACL. The migration correctly carries **no
GRANT/REVOKE statements** and documents why (closing NOTE, lines 593–596).
The pgTAP test correctly omits a `has_function_privilege` assertion (header
lines 41–43). PASS.

### (2) No accidental revert of spec-087 / spec-088 logic — PASS
Diffed the full body region-by-region against `20260602000000`:
- spec-087 EOD-first logic intact: `latest_eod_per_vendor` (4e), the three
  on_hand cases + `item_on_hand_source` + `eod_missing_for_item` (4f), the
  vendor-level `bool_or(... = 'eod')` rollup (4l), `as_of_date` resolution (2),
  next-delivery offset math + the multi-delivery-day MIN-on-distance fix (4i).
- spec-088 case math intact: `coalesce(ci.case_qty, 1)::numeric` in `per_item`;
  the `case_qty > 1` `suggested_cases` ceil and case-rounded `estimated_cost`
  in `per_item_filtered`; the three additive keys `case_qty` /
  `suggested_cases` / `suggested_units` in the rollup `jsonb_build_object`.
- Depth-cap walk, warnings block, final envelope, KPI rollup all unchanged.
No stale-body / spec-021 regression. PASS.

### (3) Exactly the two additive hunks, nothing else — PASS
- **Hunk 1** (`per_item` CTE, new line 377): `ci.i18n_names as i18n_names`,
  inserted immediately after `ci.name as item_name` (line 376), drawn from the
  already-present `ci` join (line 402). Zero new join, zero new scan, as
  designed (§1).
- **Hunk 2** (rollup `jsonb_build_object`, new line 476): `'i18n_names',
  pif.i18n_names,` inserted immediately after `'item_name', pif.item_name,`
  (lines 469–470), exactly where §1 specified.
- The column rides through `per_item_suggested (pi.*)` and
  `per_item_filtered (pis.*)` unchanged — verified.
- No other diff. Comment additions (header lines 13–24; inline 367–371,
  471–475) are documentation, not logic. PASS.

---

## Contract conformance against the design

| Design item | Status |
|---|---|
| §1 additive migration, no destructive change | MET |
| §2 RLS unchanged (`security invoker`, `auth_can_see_store` first stmt) | MET (lines 64–67 unchanged) |
| §3 API contract — per-item gains `i18n_names`, envelope unchanged | MET |
| §4 no edge function / config.toml change | MET (none touched) |
| §5 admin `db.ts:mapReorderVendor` NOT updated (stays English) | MET — db.ts mapper ends at `flags`, no `i18nNames` (db.ts:2872) |
| §5 staff `fetchReorder.ts` maps `i18n_names → i18nNames` coalescing to `{}` | MET — `i18nNames: (it?.i18n_names ?? {}) as LocalizedNames` (fetchReorder.ts:78) |
| §5 divergence annotated so it isn't "repaired" later | MET — header comment lines 46–50 spell it out explicitly |
| §6 realtime / publication unchanged — no docker restart step | MET (no publication membership change in the migration) |

### Frontend mapper carry-through — PASS
`fetchReorder.ts:78` reads `it?.i18n_names ?? {}` and casts to `LocalizedNames`
(imported at line 33). NULL/absent → `{}`, matching the contract so
`getLocalizedName` falls through to English silently. The header comment
(lines 46–50) correctly records the intentional staff-vs-admin divergence and
warns against "fixing" it. The admin copy at `db.ts:2851` was correctly left
untouched and English. PASS.

---

## pgTAP test review

`report_reorder_list_i18n_names.test.sql` — `plan(7)`, auto-discovered by
`scripts/test-db.sh` (globs `**/*.test.sql`, no manual registration needed).
Driver mirrors `report_reorder_list_cases.test.sql`: master JWT, hermetic
`begin … rollback`, fixtures created in-txn, no `set role anon` (spec-067
segfault avoidance). Asserts: key-present + value-equal for an OVERRIDES
catalog row, key-present + `{}` for an EMPTY row, and `jsonb_typeof = object`
type guards on both. Solid coverage of the two hunks at the SQL boundary.

---

## Minor notes (documentation only — no code change required)

**Minor-1 — plan count vs header arithmetic.** The header (line 26) says
"7 assertions: 1 fixture resolve + 2 OVERRIDES + 2 EMPTY + 2 type guards" =
7, and `plan(7)` matches the actual `select ok/is(...)` count (1 + 2 + 2 + 2).
Correct. Noting only because an earlier prose line (header line 48) says the
header lists assertions — it all reconciles to 7; no discrepancy. No action.

**Minor-2 — the migration's "NULL → JSON null → mapper coalesces to {}"
narration describes an unreachable path for THIS column.**
`catalog_ingredients.i18n_names` is `jsonb NOT NULL DEFAULT '{}'::jsonb`
(`20260517000000_user_data_i18n_names.sql:76`). So an unset catalog row
serializes as `{}` (a JSON object), never JSON `null` — which is exactly what
the pgTAP test pins (assertion 4 / type guard 6). The migration comment
(lines 21–24, 472–475) and the design §1/§3 describe the NULL→null→`{}`
defense-in-depth as if the catalog column could be NULL; it cannot at the
column level. The `?? {}` coalesce in `fetchReorder.ts` is still correct and
worth keeping (it guards the pre-migration "key absent" window and any future
nullable source), but a reader could be momentarily confused that the SQL
emits JSON `null` for an empty catalog row. The test correctly exercises the
real `{}` path, not the phantom `null` path. Optional: a one-line note that the
`null` branch is mapper-side defense, not a catalog-reachable state. No
functional impact.

---

## Summary

The critical stale-body trap is cleanly avoided: byte-identical signature,
verbatim latest body, exactly the two additive `i18n_names` hunks, spec-087 and
spec-088 logic fully preserved. RLS, realtime, edge, and the admin/export paths
are correctly untouched. The staff mapper carries the new key with the coalesce
the contract specified; the admin mapper was correctly left diverged and
English with the divergence annotated. Two Minor notes, both documentation-only.
