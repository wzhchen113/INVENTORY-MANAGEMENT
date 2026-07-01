# Backend-architect drift review — spec 104 (per-each cost basis rework)

Reviewer: backend-architect (post-implementation mode)
Verdict: **No Critical drift. No Should-fix drift. 2 Minor observations.**
The implementation matches the REVISED `## Backend design` (option (b),
widen-first, unconditional bridges, R1 write-side snapshot) with high fidelity.
Every architectural decision I asked to be verified landed as designed.

Severity legend: Critical (contract/RLS/build broken, blocks ship) →
Should-fix → Minor (nit / doc-correctness, non-blocking).

---

## Verified AGAINST design intent (no drift)

### 1. Migration — widen-first → option (b) → RPC re-CREATEs (matches §0/§1/§4)
`supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql`

- **Widen FIRST, inside the txn.** Both `ALTER TABLE … type numeric(12,6)` are
  the first statements after `begin` (lines 128-129), before any snapshot or
  UPDATE — as §1/§R2 require so the re-derivation writes sub-cent without
  `(10,2)` truncation. `catalog_ingredients.default_cost` correctly left
  unconstrained (no DDL).
- **Option (b) re-derivation is `cost_old / sub_unit_size`, NOT from
  `case_price`,** on all three targets (inventory_items 183, item_vendors 245,
  catalog 300). The predicate is `coalesce(cost,0) > 0` for population D and
  `<= 0` for population X on every target — the exact membership §1 (revised)
  specified. `item_vendors` correctly divides the link's OWN `iv.cost_per_unit`
  (244), not the item's. No `case_price` is read by any UPDATE — the `case_price`
  columns are captured to the audit table for provenance only (182/206, 244/263,
  301/317).
- **Audit-keyed idempotency on all three UPDATEs.** Each snapshot INSERT carries
  a `not exists (… audit …)` guard (188-191, 210-213, 251-254, 269-272, 304-307,
  320-323); each UPDATE joins the audit table on `population='D' and new_cost is
  not null` (220-227, 276-282, 328-335). This is the ONLY double-divide guard
  under option (b) (the predicate does not self-extinguish) — present and
  correct, and the local/prod caveat is documented in the header (86-96).
- **`report_reorder_list` re-CREATE — the two additive hunks are UNCONDITIONAL.**
  Hunk 1 surfaces `coalesce(ci.sub_unit_size,1)::numeric as sub_unit_size` off
  the existing `ci` join (780); Hunk 2 multiplies BOTH `estimated_cost` branches
  by `pis.sub_unit_size` with no discriminator (840-841). The rest of the body
  is the spec-102 multi-vendor body verbatim (the per-vendor coalesce at 571 and
  the junction explode at 592 are intact — no silent revert of 088/100/102). No
  grant/revoke restated (signature byte-identical) — ACL preserved as designed.
- **`staff_log_waste` re-CREATE snapshots `cost_per_unit × sub_unit_size`**
  (= cost_old) at the insert (1132), keeping `waste_log.cost_per_unit`
  per-counted-unit across the flip (R1 option (a)). Signature, SECURITY DEFINER,
  search_path, client_uuid idempotency, stock decrement, audit row, envelope all
  unchanged.
- **BACKOUT restores VALUES first (while columns are still `numeric(12,6)`),
  THEN re-narrows** (1199-1228), with the ordering rationale spelled out
  (1177-1185). `inventory_items_cpu_backup_20260626` referenced and explicitly
  NOT dropped (98-102, 1195-1197). Matches §1 non-negotiable ordering.
- **`numeric(12,6)` sufficiency** is proven both in the header (36-38) and by the
  local AC table (spec lines 1129-1143): every store's `kpis.total_estimated_cost`
  round-trips to within $0.001 (max per-row reconstruction error $0.000050). The
  prior `(10,2)` attempt's +$68.54 Frederick drift is gone. This is the (★)
  round-trip proof obligation from §1, satisfied.

### 2. The `staff_log_waste` `ci.name/ci.unit` deviation — WITHIN design intent
The dev changed the item lookup to read `ci.name as name, ci.unit as unit` from a
`left join catalog_ingredients` (1108-1113) instead of the phase-13d body's bare
`inventory_items.name/unit`. This is a **necessary, in-intent deviation, not
unmanaged drift**:
- P3 (`brand_catalog_p3_lockdown`) dropped `inventory_items.name/unit`, so a
  byte-verbatim copy of the phase-13d body would raise `column ii.name does not
  exist` against today's schema — it would not compile. The re-CREATE had to
  touch this function anyway (for the R1 snapshot bridge), and it reads name/unit
  from the SAME catalog join it adds for `sub_unit_size` — mirroring exactly how
  the reorder RPC copy in this file already reads `ci.name`.
- The RPC has had **no live caller since spec 061** (edge fn `staff-waste-log`
  returns HTTP 410; the RPC is service_role-only), so the P3 break was
  latent/dormant — the re-CREATE fixes a pre-existing compile hazard as a
  side-effect of a change it had to make regardless. It is NOT a contract
  redesign; the downstream `v_item.name/unit` references are unchanged. The
  header documents this fully (1040-1055). I explicitly bless this as within the
  "copy the latest body, make it valid against today's schema" envelope — the
  function-header copy rule is about not reverting *behavior*, and behavior
  (signature, semantics, envelope) is preserved.

### 3. The two FE in-code decisions (spec "Open issues surfaced") — MATCH design
Both are decisions I anticipated in the revised design and would make the same
way; they are NOT drift I would reject.

- **(a) `calcUnitCost(_, 0, _) === 0` guard preserved over the identity.**
  `src/utils/unitConversion.ts:310` applies `if (caseQty <= 0) return 0;` BEFORE
  the `piecesPerCase` divisor. The guard AC (line 81) and the single-source
  identity AC (line 83) are genuinely inconsistent over the dead `caseQty=0`
  domain (piecesPerCase floors 0→1, so the identity would yield `20/5=4`). The
  dev picked the owner-pinned concrete value (`=== 0`) and asserted the identity
  over the positive domain — which is the live domain (`case_qty` defaults to 1;
  no live row has `case_qty <= 0`). The jest suite pins BOTH readings correctly
  (`IngredientForm.test.ts:307,316-326`). This is the right call — the guard
  protects malformed editor input, the identity holds everywhere it matters.
- **(b) `InventoryCatalogMode.weightedCost` LEFT unbridged.**
  `src/screens/cmd/sections/InventoryCatalogMode.tsx:147` keeps
  `weightedCost += currentStock × costPerUnit` with NO `× subUnitSize`, and the
  call site carries a 14-line rationale (133-146). This is **correct and matches
  my design's actual intent**, notwithstanding that §7's flat consumer list named
  it as a bridge target. `weightedCost` is a stock-weighted-average-COST numerator
  (it feeds `avgCost = weightedCost / totalStock` → the "Avg cost / each" StatCard
  → the `perEachCost` fallback), NOT a stock-value total. Bridging it would make
  `avgCost` per-counted-unit and simultaneously break (i) the OQ-3 per-each avg
  display and (ii) the fallback-identity instruction — the three are mutually
  exclusive, and the dev resolved the contradiction the way the invariant
  demands: a cost-average numerator must track the BASIS of `costPerUnit` (now
  per-each), only stock-VALUE totals get the bridge. §7 listed it under the
  stock-value sweep by over-reach; the dev's exclusion is the architecturally
  correct reading, not drift. (I am flagging §7's original mention as a spec
  imprecision, not the code as wrong — see Minor-1.)

### 4. Consumer-bridge completeness — every live `× costPerUnit` site named in
the revision sweep is bridged; the waste-snapshot reads are NOT (matches §7)

Confirmed present with an unconditional `× (subUnitSize || 1)`:
- `getInventoryValue` (useStore.ts:2565), `getIngredientLineCost` all three
  branches (2693 short-circuit; 2702 standard-conversion drops the 2nd divide;
  2713 abstract-conversion bridges into `costPerBase`).
- Revision-sweep additions: `RestockSection:73`, `POsSection:77`,
  `ReceivingSection:102`, `EODCountSection:585` + `:1791`, `RecipesSection:681`
  (the inline short-circuit copy).
- Originals: `DashboardSection:243` + `:799`, `ReconciliationSection:85/271/356`,
  `ItemDetailScreen:97`, `InventoryDesktopLayout:449`, plus `ExportCsvDrawer:29`
  (the CSV stock-value column — found in the sweep, correctly bridged).

Confirmed correctly LEFT UNBRIDGED (frozen snapshot reads — R1 write-side fix):
- `getWasteThisWeek` (useStore.ts:2574) and `DashboardSection` waste (:257) read
  the FROZEN `waste_log.cost_per_unit` snapshot, which the write side keeps
  per-counted-unit (logWasteEntry + staff RPC). Both carry guard comments. No
  read-side bridge — exactly as §7/§R1 require.

Write-side snapshot bridge landed on both paths:
- `logWasteEntry` (db.ts:704) persists `entry.costPerUnit × subUnitSize`, reading
  `sub_unit_size` from the item's catalog row directly (690-698) rather than
  trusting the caller — a *stronger* implementation than my design sketched, and
  sound. The staff RPC mirror is in the migration (1132).

`perEachCost` fallback is IDENTITY (`return costPerUnit`, perEachCost.ts:80),
resolving the double-divide once `costPerUnit` is per-each — matches §8 R4.

### 5. Editor fold-in + pgTAP — as designed
- `derivedUnitCost` is 3-arg (IngredientForm.tsx:262); all three existing
  handlers thread `values.subUnitSize`; the NEW `handleSubUnitSizeChange`
  (860-863) recomputes headline + per-vendor costs and is wired to the sub-unit
  input (994) — the stale-derived-cost gap §7 called out is closed.
- `report_reorder_list_per_each_cost.test.sql`: 6 assertions, cent-level epsilon
  (§8 R7), self-seeds its own `item_vendors` links (CI-safe on an empty
  junction), covers case-size + high-`sub_unit_size` fixtures, the (★)-inverse
  round-trip (228-237), and pins the exposed `cost_per_unit` key stays raw
  per-each (204-208, only `estimated_cost` bridged). Matches the test contract.

---

## Minor observations (non-blocking)

### Minor-1 — §7 named `weightedCost` as a bridge target; the code's exclusion is
correct (spec-text imprecision, not code drift)
The revised §7 flat-listed `InventoryCatalogMode.tsx:133 weightedCost` under the
"add `× subUnitSize` bridge" sweep, which — read literally — conflicts with the
fallback-identity + OQ-3 per-each-display instructions in the same section. The
dev caught the contradiction, made the architecturally correct call (leave the
cost-average numerator unbridged), and documented it at the call site and in
"Open issues surfaced" #2. **No code change needed.** This is a note that the
design text should have distinguished "stock-VALUE totals get the bridge" from
"cost-AVERAGE numerators track the basis" rather than listing `weightedCost`
alongside true value totals. Recorded so a future reader of §7 doesn't
"correct" the code back into the bug. Action: none on code; if the spec is ever
revised, tighten the §7 wording.

### Minor-2 — per-unit display cell vs bridged line total on POs/Receiving
(pre-existing display-only mismatch, correctly deferred)
"Open issues surfaced" #3 notes that POsSection (~290) / ReceivingSection show
the raw per-each `unitCost` next to a bridged `lineCost`, so `unitCost × qty ≠
lineCost` *visually* for sub>1 items. This is **not a dollar-total drift** (the
totals are bridged correctly; I verified `POsSection:74 unitCost` is the raw
per-each and `:77 lineCost` is bridged). Reconciling the per-unit *display* cell
to per-counted-unit is genuinely outside this spec's "every consumer-visible
dollar TOTAL stays unchanged" contract. Correct to defer as a follow-up; noted
so the release proposal can surface it as a known cosmetic.

---

## Orthogonality confirmations requested

### The spec-102 empty-`item_vendors`-on-reset gap IS orthogonal (a follow-up,
not something spec 104 must fix)
Confirmed by inspection:
- `item_vendors` has **0 rows in `supabase/seed.sql`** (grep: no matches). It is
  populated only by the spec-102 backfill in
  `20260630000000_item_vendors.sql:161-166`, which selects from
  `inventory_items where vendor_id is not null`.
- On a fresh local `db reset`, migrations run BEFORE seed.sql loads any rows, so
  that backfill sees zero `inventory_items` and produces an **empty junction**;
  seed.sql carries no `item_vendors` rows to compensate. This is a **spec-102
  seed-completeness gap that predates spec 104 entirely** — the same
  migrations-before-seed ordering the spec-104 header documents as inherent
  (lines 86-96).
- Spec 104 does **not** touch the `inventory_items.vendor_id → item_vendors`
  backfill path; it only re-derives the `cost_per_unit` *value* on rows that
  already exist. Its reorder pgTAP test self-seeds its own links (test lines
  157-161) *precisely because* it cannot rely on the junction being populated on
  a reset — the dev worked around the gap rather than depending on it or
  papering over it. Nothing in spec 104's contract requires a populated junction
  on reset.
- Verdict: genuinely orthogonal. A spec-102 follow-up (regen seed to include
  `item_vendors`, or add the backfill to seed) is the right home — NOT this spec.

---

## Summary

The developer implemented the REVISED design faithfully. Both post-build
blockers (B1 truncation → widen-first `numeric(12,6)`; B2 mixed-basis → option
(b) `cost_old / sub_unit_size`) are resolved exactly as the revision specified,
and the local AC proof (per-store reorder totals round-trip to the cent, max
$0.000050/row reconstruction error) confirms the `numeric(12,6)` bound holds.
The two in-code decisions the FE dev flagged (guard-over-identity;
`weightedCost` unbridged) are the architecturally correct calls and match my
intent — the only wrinkle is that §7's flat consumer list *named* `weightedCost`
as a bridge target, which is a spec-text imprecision, not code drift. The
`staff_log_waste` `ci.name/ci.unit` change is a necessary, documented,
in-envelope schema-drift fix, not unmanaged drift. Consumer bridging is complete
and the waste-snapshot reads are correctly left unbridged with the write-side
fix on both paths. The spec-102 empty-`item_vendors`-on-reset gap is genuinely
orthogonal and correctly deferred.

No Critical, no Should-fix. Two Minor notes, both non-blocking and both already
documented at the call sites by the dev.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor
  (both non-blocking, both documented at the call sites). Implementation matches
  the revised design intent; the staff_log_waste ci.name/unit change and the two
  FE in-code decisions are within design intent, and the spec-102
  empty-item_vendors-on-reset gap is confirmed orthogonal (a follow-up).
payload_paths:
  - specs/104-per-each-cost-basis-rework/reviews/backend-architect.md
