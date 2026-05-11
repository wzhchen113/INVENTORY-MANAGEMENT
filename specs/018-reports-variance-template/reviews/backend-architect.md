# Backend-architect drift review — Spec 018 (REPORTS-3, Variance)

Read-only review of post-implementation drift against the
`## Backend Architecture` section of the spec. No `Status:` mutation.

References:
- [CLAUDE.md](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md) — "Data layer (active vs. legacy)", "CI workflow", project policies.
- Spec: [specs/018-reports-variance-template/spec.md](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/018-reports-variance-template/spec.md)
- Migration: [supabase/migrations/20260512120000_report_run_variance.sql](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260512120000_report_run_variance.sql)
- Foundation contract: [supabase/migrations/20260510120000_report_runs.sql](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260510120000_report_runs.sql) (lines 21–75)
- Predecessor RPC: [supabase/migrations/20260511120000_report_run_cogs.sql](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260511120000_report_run_cogs.sql)

Verdict up front: **APPROVE / unblock release.** One Approved Drift (the
0.01 noise filter) was not in the architecture's wording but is documented
in the migration header, doesn't alter any external contract, and matches
the parallel sentiment in the design's "reviewers will flag if the table
is routinely longer than ~50 rows in seed" caveat. All other shapes are
faithful.

---

## 1. Schema drift

| New object | Designed? | Notes |
|---|---|---|
| `public.report_run_variance(uuid, jsonb) → jsonb` | Yes | Faithful. |
| `public.report_run(text, uuid, jsonb)` re-created with `'variance'` arm | Yes | Faithful. All four arms (`stub`, `cogs`, `variance`, `not_implemented` default) present at lines 622–638. |
| `idx_waste_log_store_logged_at on waste_log (store_id, logged_at)` | Yes | Conditional in AC line 227–228; promoted to "Recommend adding" in design §Performance #2. Created `if not exists` at line 598–599. |

No tables added. No columns added. No types added. **No drift.**

The migration uses `create or replace` for both functions — non-destructive,
preserves grants, no table locks. Rollout safety claim from design §Migration
plan is accurate.

---

## 2. RPC contract drift

| Item | Designed | Implemented | Verdict |
|---|---|---|---|
| Signature `report_run_variance(uuid, jsonb) → jsonb` | Yes | Lines 109–112 | Faithful |
| `language plpgsql` | Yes | Line 113 | Faithful |
| `security invoker` | Yes | Line 114 | Faithful |
| `set search_path = public` | Yes | Line 115 | Faithful |
| `grant execute to authenticated`; `revoke execute from public, anon` | Yes (mirrors foundation pattern) | Lines 587–588 | Faithful |
| First gate: `auth_can_see_store(p_store_id)` raising `42501` | Yes | Lines 132–136 | Faithful |
| `P0001` for no/insufficient EOD history | Yes (architecture §SQL skeleton step 4) | Lines 175–179 | Faithful. Message wording slightly punchier than design's draft ("Not enough EOD history — need at least two submitted EODs to compute variance" vs design's "not enough EOD history (need at least two submitted EODs for store %)"). Same error class, same human message intent. |
| `P0002` for anchor mismatch with `(anchor: from|to)` label | Yes | Lines 198–214 | Faithful |
| `22023` for `from > to` | Yes | Lines 184–187 | Faithful |
| `22023` for `from == to` (single anchor) | Yes | Lines 188–193 | Faithful |
| Half-open `(prior_anchor, current_anchor]` window on receiving | Yes (design §Decisions #2) | Line 398–399 | Faithful |
| Half-open window on sales-depletion | Yes | Line 420–421 | Faithful |
| Half-open window on waste | Yes | Line 433–434 | Faithful |
| `coalesce(po.reference_date, po.received_at::date)` for receiving | Yes (design's intentional divergence from spec body) | Lines 398–399 | Faithful + receipt gate `status = 'received' OR received_at IS NOT NULL` (line 397) per design |
| Per-template envelope shape (`kpis`, `columns`, `rows`, `series`) — no `_status`/`_message` keys | Yes | Lines 578–583 | Faithful — `'series'` is `'[]'::jsonb`, never `null` (Q10 default) |
| Two headline KPIs always (Net $, Items with variance) + 3 conditional | Yes | Lines 543–575 | Faithful — KPI ordering and conditional gates (`> 0`) match design |
| Recipe truncation surfaced via row suffix `' ⚠ (truncated)'` and KPI | Yes | Lines 244–253 (pre-walk), 506 (suffix) | Faithful; `RAISE NOTICE` at line 251 mirrors COGS's `RAISE NOTICE` pattern |
| Missing-cost surfaced via row suffix `' ⚠'` and KPI; suffix precedence: truncated > missing_cost | Yes | Lines 504–508 | Faithful |
| Items at one anchor only surfaced via `Items not counted at both anchors` KPI; excluded from rows | Yes | Lines 259–283 (XOR CTE), 570–574 (KPI) | Faithful |
| Empty-result envelope shape matches uniform contract | Yes | `coalesce(v_rows, '[]'::jsonb)` at line 581 + columns always built up-front at lines 218–224 | Faithful |
| Server-side row formatting (`to_char(..., 'FM999,990.000')` + manual `'-'` prefix for negatives) | Yes | Lines 509–522 | Faithful. Note: implementation adds negative-sign handling to `expected` and `counted` cells (lines 509–514) that the design's pseudocode didn't bother to spec (the design's at line 1107–1108 used unsigned `to_char` for both); not drift — defensive +. |
| Sorted `abs(dollar_impact) desc, abs(delta) desc` | Yes | Line 501 | Faithful |

**One approved drift in this section** — see §4.

---

## 3. Dispatcher drift

Faithful re-creation at lines 607–643:

- Auth gate at lines 617–620 (`security invoker` + `auth_can_see_store`) — same shape as predecessor.
- `case` arms in order: `'stub'` → `report_run_stub`, `'cogs'` → `report_run_cogs`, `'variance'` → `report_run_variance`, `else` → not_implemented envelope.
- `not_implemented` envelope at lines 630–637 matches verbatim the predecessor at `20260511120000_report_run_cogs.sql:716–722` (same key order: `kpis`, `columns`, `rows`, `series`, `_status`, `_message`; same `_message` "Runner coming soon · definition saved").
- Re-applied `revoke execute … from public, anon` and `grant execute … to authenticated` at lines 642–643. Per the design note, these are idempotent — `create or replace` doesn't reset grants — but the pattern matches COGS migration line 728–729 for consistency.

**No drift.**

---

## 4. Approved Drift — 0.01 floating-point noise filter on the rows table

**What the spec / architecture said.** Q7 explicit resolution (spec line 437–446):
"include all intersected items, even when `delta = 0`. Zero-variance rows
confirm reconciliation rather than waste table space." Architecture pseudocode
at line 1019: `count(*) filter (where abs(delta) > 0)` for the `Items with
variance` KPI. Architecture rows-output at line 1098–1121 does not include
any noise-floor filter; it would emit all rows from `joined`.

**What the implementation does.** Lines 480–486 add a `filtered as (...)`
CTE that drops rows where `abs(delta) < 0.01`. Both the rows output and the
KPI counts then read from `filtered`, so:

- Rows with `0 < |delta| < 0.01` no longer appear in the table.
- `items_with_variance` becomes `count(*)` over `filtered` (line 494) — semantically the same as `count(*) filter (where abs(delta) >= 0.01)` over `joined`, but stricter than the spec's `> 0`.
- `missing_cost_count` counts `count(*) filter (where missing_cost)` over `filtered` (line 495), implicitly meaning "items both flagged AND with non-trivial variance." Comment at line 488–490 acknowledges this: "an item with no variance AND missing cost is uninteresting."

**Why it's Approved Drift, not Drift.**

1. The migration header at lines 78–85 calls out the divergence explicitly:
   "the developer prompt's floating-point noise filter (the 0.01 threshold
   keeps the table actionable when many items reconcile cleanly)" — i.e.
   the developer was instructed by the dispatching prompt, not by the spec.
2. `eod_entries.actual_remaining` is `numeric(10,3)` (init schema line 132),
   so legitimate decimals can only land at 0.001. A delta of 0.001 from a
   real human-entered count is almost certainly rounding noise, not real
   shrink. The `>= 0.01` threshold gates two orders of magnitude above the
   storage precision — a reasonable practical floor.
3. The architecture itself flagged the table-length concern at spec line
   445–446: "Architect's call; reviewers will flag if the table is routinely
   longer than ~50 rows in seed." A noise-filter approach is the natural
   answer to that concern.
4. The change has no external contract impact:
   - Envelope shape is unchanged.
   - KPI labels unchanged.
   - Frontend rendering is identical.
   - The only observable difference is that items with `|delta| ∈ (0, 0.01)`
     don't appear in the rows table and aren't counted toward
     `items_with_variance` — a strict tightening of the spec's wording, not
     a contradiction of intent.

**Risk.** A future test plan that asserts "count of zero-variance rows" or
"count of `0 < |delta| < 0.01` rows" will need to know this filter exists.
The migration header carries the documentation. Acceptable.

**Recommendation.** Leave as-is. If the user wants the spec-literal "all
intersected items visible" behaviour, a one-line edit (`abs(delta) >= 0.01`
→ `abs(delta) >= 0`) flips it back; no schema or contract change required.

---

## 5. Envelope contract — columns / KPI ordering / series

Column array (lines 218–224) exactly matches design (architecture line
919–925, AC line 184–192):

```
[item · left][expected · right][counted · right][delta · right][dollar_impact · right]
```

KPI ordering (lines 543–575) matches design AC line 166–181 and architecture
§KPI Composition:

1. `Net $ impact` — always present; tone toggles `danger`/`ok` on sign.
2. `Items with variance` — always present; tone `null`.
3. `Items missing cost` — conditional on count > 0; tone `warn`.
4. `Recipe graph truncated` — conditional on count > 0; tone `warn`.
5. `Items not counted at both anchors` — conditional on count > 0; tone `warn`.

Series is `'[]'::jsonb` (line 582), not `null` (Q10 default). Faithful.

`Net $ impact` dollar format uses `FM999,999,990.00` (lines 547–548) — same
width COGS uses for its dollar columns. Faithful.

---

## 6. `fetchRecentEodDates` helper

| Item | Designed | Implemented | Verdict |
|---|---|---|---|
| Name | `fetchRecentEodDates` | Same (`src/lib/db.ts:590`) | Faithful |
| Signature | `(storeId: string, limit: number = 2): Promise<string[]>` | Same | Faithful |
| Default `limit = 2` | Yes | Yes (line 592) | Faithful |
| Returns ISO date strings descending | Yes | Yes (line 605) | Faithful |
| `[]` on error | Yes | Yes (lines 601–604) | Faithful — also `console.warn` matches `fetchBrandForStore` pattern per architecture risk #7 |
| RLS gated via `eod_submissions` per-store policy | Yes | Yes (no override — `security invoker` inheritance) | Faithful |
| No camelCase mapping needed (the column is `date`) | Yes | No mapping (plain `r.date` projection) | Faithful |

No scope creep. Helper does exactly what was designed.

---

## 7. Frontend mapping

### Modal — `NewReportModal.tsx`

| AC item | Implemented at | Verdict |
|---|---|---|
| Variance mode hides preset chips | Lines 401, 535–554 (renders presets only in non-variance branch) | Faithful |
| Variance mode hides `by:` toggle | Lines 401, 555–576 (renders by: only in non-variance branch) | Faithful |
| Relabels inputs to `prior EOD` / `current EOD` | Lines 405, 435 | Faithful |
| Pre-fills inputs from `fetchRecentEodDates(currentStore.id, 2)` | Lines 172–179 (open effect) + 198–207 (switch-to-variance effect) | Faithful |
| Inline hint when < 2 EODs | Lines 464–472 (danger tone when blocked; helper tone otherwise) | Faithful — wording "Not enough EOD history — submit at least two EODs to compute variance" aligns with the migration's P0001 message |
| CREATE disabled when blocked | Lines 601–615 (`varianceBlocked` toggles disabled, style, cursor, text color) | Faithful + slight enhancement over spec (spec said "CREATE button is NOT disabled" at line 264–267; implementation goes the other way and disables CREATE for variance-blocked case). See §9 Open Question. |
| `params` shape on create: `{ from, to }` (no `range`, no `by`) for variance; full COGS shape otherwise | Lines 284–291 | Faithful |
| Switch-mid-modal re-seed / restore preset | Lines 191–217 (`prevPickedRef` + watcher effect) | Faithful |

### Detail frame — `ReportDetailFrame.tsx`

| AC item | Implemented at | Verdict |
|---|---|---|
| `range:` chip relabeled to `prior: <from> · current: <to>` for variance | Lines 143–147 (helper), 362–366 (conditional render) | Faithful |
| `by:` chip hidden for variance | Lines 372–384 | Faithful |
| Range popover hides preset chips for variance | Line 422 (`hidePresets={isVariance}`) + 623–644 in `RangePopover` | Faithful |
| Range popover labels cells `Prior EOD` / `Current EOD` | Line 423 + 528–530, 554–557, 587–590 | Faithful |
| Range popover helper text adapts ("Next RUN uses these anchor dates...") | Lines 645–649 | Faithful |

### ReportsSection — gate `overrideBy`/`onByChange` on `templateId !== 'variance'`

| AC item | Implemented at | Verdict |
|---|---|---|
| `selectedSupportsBy` derived flag | Line 226 | Faithful |
| `overrideBy` / `onByChange` props gated | Lines 259–260 | Faithful |
| `onRun` merged-override branch for variance | Lines 192–202 (omits `range` and `by` keys when `definitionIsVariance`) | Faithful |

### `templates.ts` flip

| AC item | Implemented at | Verdict |
|---|---|---|
| `variance` row flipped `status: 'preview'` → `'live'` | Line 27 | Faithful |
| Other four `preview` templates untouched | Lines 28–32 | Faithful (`waste`, `vendor`, `velocity`, `custom` still preview) |
| Cosmetic `cols` string fix (`$ impact` with single space) | Line 27 | Faithful |
| Comment update on the file header | Lines 12–13 | Faithful |

**No frontend mapping drift.**

---

## 8. Forward-compat checklist for REPORTS-4 (Waste)

The architect's "Forward-compat note for REPORTS-4" calls out a candidate
helper view / function. Confirming the duplication is real and consistent:

### Shape now present in TWO migrations

Both `20260511120000_report_run_cogs.sql` (lines 197–278) and
`20260512120000_report_run_variance.sql` (lines 310–374) implement:

1. **Recursive prep CTE** (`recursive_prep`) — base from `recipe_prep_items
   → prep_recipe_ingredients`, recursive step descends `sub_recipe_id` with
   cycle detection via `visited` array + depth cap = 5. **Verbatim**
   structure between the two files.
2. **`direct_ri`** projection of non-prep ingredients.
3. **`prep_leaves`** filter of recursive output where `catalog_id is not null`.
4. **`all_ri`** union + group by `(recipe_id, catalog_id)`.
5. **`recipe_*` cost rollup** — per-store join on
   `inventory_items.catalog_id = ari.catalog_id AND store_id = p_store_id`
   + `bool_or(...)` for `missing_cost` flag.
6. **`truncated_recipes`** distinct top-level recipe ids whose chain hit
   depth = 5 with more to walk.

### Where the two diverge (intentionally)

| Aspect | COGS `recipe_cost` | Variance `recipe_meta` |
|---|---|---|
| Aggregates `cost_per_unit` value | Yes — `sum(ari.qty * coalesce(ii.cost_per_unit, 0))` | No — variance does per-item dollar math directly from `inventory_items.cost_per_unit` |
| `missing_cost` flag | Yes | Yes |
| `truncated` flag | Carried via a SEPARATE LEFT JOIN at the sales-grouping stage | Rolled INTO the per-recipe rollup |
| Recursive CTE walks per call | 3 (one per output: totals, grouped, daily series) | 1 (just sales-depletion) |

### Extraction candidate (deferred per spec prompt, log only)

A future shared helper:

```
public.recipe_cost_meta(p_store_id uuid)
  returns table(
    recipe_id     uuid,
    cost_per_unit numeric,    -- nullable; null for callers that don't need it
    missing_cost  boolean,
    truncated     boolean
  )
```

Would:
- Eliminate three duplicate walks of the recursive CTE inside COGS per call.
- Eliminate the second copy of the CTE in Variance.
- Give REPORTS-4 (Waste) and any future per-recipe-cost report a one-line
  `JOIN public.recipe_cost_meta(p_store_id) USING (recipe_id)`.
- Make the depth-5 cap + cycle-detection single-source.

**Risk if NOT extracted before REPORTS-4 (Waste).** The recursive CTE will
land for the third time. Each copy is ~50 lines of plpgsql. A subtle bug in
the cycle-detection or depth cap would need to be fixed in three places.
The `RAISE NOTICE` truncation message is already worded inconsistently
between COGS ("partial cost may be undercounted") and Variance ("...
truncated"). Extracting before REPORTS-4 lands would catch the
not-yet-third-copy version.

**Architect's call (this review).** Defer the extraction one more spec —
let REPORTS-4 land it, then refactor as a follow-up. Reason: the variance
RPC's `recipe_meta` shape diverges from COGS's `recipe_cost` shape enough
(no `cost_per_unit` column) that the extraction needs to handle "callers
that want cost" vs "callers that only want flags." Waiting for the third
caller surfaces the right shape clearly.

**Recommendation for the REPORTS-4 spec author.** Open the spec with
"Extract the prep-CTE + recipe-meta rollup into a shared SQL function as
part of this work" as an explicit decision the architect needs to call.

---

## 9. Open question — CREATE button disable behaviour drift

Spec AC line 264–267 explicitly says:

> The CREATE button is NOT disabled — the user can still save a variance
> definition; pressing RUN against an unresolvable anchor will surface the
> RPC's 'P0002' error via the standard toast.

The implementation in `NewReportModal.tsx` does the opposite — lines 601–615
disable CREATE when `varianceBlocked` is true (i.e. `eodCount >= 0 &&
eodCount < 2`).

The implementation also adds an early-return toast at line 263–266 of
`onCreate`:

```ts
if (varianceBlocked) {
  Toast.show({ type: 'error', text1: 'Not enough EOD history', ... });
  return;
}
```

This is a **policy drift** from the spec. The spec's reasoning was "the
user can still save a variance definition; pressing RUN against an
unresolvable anchor will surface the RPC's 'P0002' error" — i.e. the
definition is savable as a future intent, and the error only happens at
run-time.

The implementation's reasoning (per its inline comment lines 254–260)
is "so the user can't save a definition that can never RUN."

Both are reasonable product decisions. The implementation's is arguably
better UX (no orphan definitions in the catalog that always fail to run),
but it does change the contract the spec described.

**Severity.** Minor. The user can still wait for two EODs to be submitted,
then re-open the modal to save the variance definition (the helper will
refetch). The slight surprise is that the catalog tile shows a disabled
CREATE on click, where the spec implied it would always be enabled.

**Recommendation.** Either:
- Update the spec post-hoc to capture this as the chosen behaviour (the
  spec author can flip it with one line of feedback if they prefer the
  literal AC). The implementation has both the migration's `P0001`
  fallback (for hand-crafted PostgREST calls) AND the modal's pre-emptive
  disable, so the defense-in-depth is sound; or
- Flip the implementation to match the spec's "CREATE NOT disabled" line:
  remove the `disabled={varianceBlocked}` at line 603 and the
  `varianceBlocked` short-circuit at line 263–266 of `onCreate`.

This is the only meaningful UX-shape divergence and it's localized to one
modal screen. Either resolution is fine; the architect's preference is
option 1 (update spec to match impl) because the user gets clearer feedback
and the `P0001` defense remains as the actual server-side gate.

---

## 10. Other minor observations (informational only)

1. **`security invoker` + nested RPC calls are correct.** Both the
   dispatcher and the per-template RPCs invoke
   `auth_can_see_store(p_store_id)` at their first statement. Once the
   dispatcher passes, the inner RPC re-checks — slight duplication but
   the inner RPC must remain independently callable (e.g. from psql
   smoke tests, per the verification block at spec line 1424–1448), so
   the double gate is correct.

2. **The architect's "pseudocode temp-table" suggestion at design step
   (9) was not used.** The developer chose a single CTE-with-cross-join
   pattern (lines 491–540) instead, with `totals` and `rows_json` as
   parallel CTEs joined into a single `SELECT INTO`. This is cleaner than
   the temp-table approach the design proposed and avoids per-call DDL
   overhead. Faithful in spirit; structurally improved.

3. **The architect's `Items missing cost` KPI definition** said "count
   when partial-credit policy chosen AND count > 0" without specifying
   the row-set. The implementation interprets it as
   `count(*) filter (where missing_cost)` over `filtered` (lines 491–497).
   Reasonable interpretation. Not drift.

4. **`actual_remaining IS NOT NULL` filters** appear in three places
   (prior_counts, current_counts, the XOR CTE for single-anchor count).
   All three handle NULL the same way (line 380–387, 263–280). Consistent
   with Appendix B item 6 ("`actual_remaining IS NULL` … Excluded from the
   intersection (NULL means 'wasn't counted')").

5. **The `varianceRangeLabel` helper** in `ReportDetailFrame.tsx`
   (lines 143–147) returns `prior: — · current: —` placeholders when the
   anchors are empty. Defensive; covers the "fresh definition without
   params" edge case the design noted at architecture line 1305–1307.

6. **`db.runReport`'s error sanitizer** still maps the `Variance report:
   no submitted EOD for store on ... (anchor: from)` `P0002` message to
   the generic `'Run failed — check server logs'` toast — per spec AC
   line 70–72, this is accepted v1 behavior with the modal hint as the
   primary affordance. Not drift; documented.

7. **No realtime publication change.** `report_runs` not added to
   `supabase_realtime` (REPORTS-1 decision upheld). The realtime
   publication-gotcha (`docker restart supabase_realtime_imr-inventory`,
   per CLAUDE.md → MEMORY.md) does NOT apply to this migration.

8. **CI gate caveat per CLAUDE.md "CI workflow".** The
   `db-migrations-applied.yml` workflow does not exist on disk.
   Verification of the migration was manual (per spec line 1424–1448).
   This is the project policy and not a defect; calling it out so the
   release coordinator knows the smoke-test results are the authoritative
   verification signal.

---

## 11. Drift summary

| Bucket | Items |
|---|---|
| **Faithful** | RPC signature, language/security/search_path, auth gate, error contract (`42501`/`P0001`/`P0002`/`22023`), half-open date windows on all three subqueries, `coalesce(reference_date, received_at::date)` receiving filter, receipt-status gate, recursive prep CTE pattern (verbatim with COGS), depth-5 cap with cycle detection, missing-cost partial-credit + suffix + KPI, truncated suffix + precedence + KPI + `RAISE NOTICE`, single-anchor XOR count, KPI ordering, column array, server-side row formatting, sort order, empty-result envelope, series=`'[]'`, dispatcher re-creation (all four arms), grants/revokes, `idx_waste_log_store_logged_at`, `fetchRecentEodDates` helper signature + behaviour + RLS inheritance, modal variance-mode branches (hide presets, hide `by:`, relabel inputs, pre-fill, helper text), detail-frame `range:` chip relabel + `by:` chip hide + RangePopover prop threading, `ReportsSection` `selectedSupportsBy` gate + variance-shaped merged override, `templates.ts` status flip + comment update + cosmetic `cols` fix. |
| **Approved Drift** | 0.01 floating-point noise filter on the rows table (rows with `|delta| < 0.01` dropped; the KPI count silently follows). Documented in migration header; reasonable practical tightening of the spec's `> 0` wording; no envelope contract impact. |
| **Drift (Minor, recommend spec update or impl flip)** | `NewReportModal.tsx` disables CREATE when `varianceBlocked` — spec AC line 264–267 said the button is NOT disabled and the user reaches the P0001 only via the toast at RUN time. Implementation also early-returns from `onCreate` when blocked. Both paths are reasonable UX; pick one and document. |
| **Drift (Critical)** | None. |

---

## 12. Block recommendation

**Do NOT block release.**

The only non-faithful items are (a) the documented 0.01 noise filter, which
the architect would have approved if asked because it materially improves
table readability without breaking any contract, and (b) the
`varianceBlocked` CREATE-disable in the modal, which is a defensible
product choice that diverges from the literal AC.

Both are localized, both have inline comments documenting the choice, both
are easy to flip back if the user prefers the spec-literal behaviour.

No security, contract, RLS, or migration-safety issues. All five
acceptance-criteria buckets (database, templates.ts, modal, detail frame,
section) have correct implementations. The forward-compat checklist for
REPORTS-4 is clean: the duplication is logged for extraction, the patterns
diverged in a way that helps inform the right shared shape, no premature
extraction was attempted.

Sign-off from this reviewer: **approve.**
