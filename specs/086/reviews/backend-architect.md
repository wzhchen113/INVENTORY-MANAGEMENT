# Spec 086 — backend-architect drift review

Mode: post-implementation drift review. Reviewer: backend-architect (the agent
that authored the design in `specs/086/spec.md` §"Backend design (architect)").
Changes reviewed UNSTAGED. Verdict: **MATCHES DESIGN.** Zero Critical, zero
Should-fix, two Minor (both pre-flagged-optional in the spec). No contract drift,
no scope creep, no `db.ts`-bypass regression.

---

## 1. RPC migration — `20260601000000_staff_submit_eod_cases_each.sql`

**MATCHES DESIGN — byte-for-byte the "two body hunks" specified.**

Diffed `20260601000000_...` against the reference `20260525000000_staff_submit_eod_per_user_jwt.sql`. Every design assertion holds:

- **Signature byte-identical (7-arg).** Both declare
  `(p_client_uuid uuid, p_store_id uuid, p_date date, p_submitted_by text, p_status text, p_entries jsonb, p_vendor_id uuid) returns jsonb` — `20260601...:70-78`. Confirmed.
- **`create or replace`, NOT drop+recreate.** Line 70 — exactly the lower-risk verb my design mandated (§"RPC body change"). The prior migration used `drop function ... ; create function` (`20260525...:52-54`); this one correctly switches to `create or replace` to preserve the GRANT with zero churn.
- **GRANT not re-emitted.** The new file emits NO `revoke`/`grant` statements (the old one had them at `20260525...:221-222`). The header comment at `20260601...:254-260` documents the deliberate omission. Confirmed against design §"API contract" ("no GRANT churn… stay exactly as-is and are NOT re-emitted").
- **Hunk A — `jsonb_to_recordset` column list.** `20260601...:178-186` adds `actual_remaining_cases numeric` and `actual_remaining_each numeric` between `actual_remaining numeric` and `unit text` — matches the design diff (spec lines 569-578) exactly.
- **Hunk B — the `eod_entries` INSERT.** `20260601...:193-199` extends the column list to `(submission_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes)` and the VALUES to write `v_entry.actual_remaining_cases, v_entry.actual_remaining_each` — matches the design diff (spec lines 582-589) exactly.
- **`current_stock`/`eod_remaining` write still uses the TOTAL.** `20260601...:210-215` writes `current_stock = v_entry.actual_remaining` / `eod_remaining = v_entry.actual_remaining` — the total, NOT the splits. Unchanged. Confirmed.
- **Audit-log value still the total.** `20260601...:234` renders `v_entry.actual_remaining::text || ' ' || coalesce(...)` — the total + unit, cases/units breakdown explicitly deferred (OQ-3). Unchanged. Confirmed.
- **Backward-compatible (absent keys → NULL).** `jsonb_to_recordset` yields NULL for absent columns; `eod_entries.actual_remaining_cases`/`_each` are nullable (`20260502071736_remote_schema.sql:55,57`). A `p_entries` element without the two keys still inserts. Confirmed; the admin direct-PostgREST `db.ts submitEODCount` path (which does NOT go through this RPC) is unaffected.
- **No RLS change.** The body keeps the `auth_can_see_store(p_store_id)` gate verbatim (`20260601...:111-114`, identical to `20260525...:95-98`). No policy added/dropped/rewritten. Confirmed.
- **No realtime publication change.** `eod_entries` is not in `supabase_realtime`; no publication membership touched; the `docker restart supabase_realtime_imr-inventory` ritual does not apply. Confirmed (header comment `20260601...:57-63` states this correctly).

Everything between Hunk A and Hunk B and the rest of the body (vendor presence
check, store gate, vendor-name hydration, actor resolution, idempotency check,
on-conflict upsert, delete-then-insert, return envelope) is copied byte-for-byte
from the reference. Confirmed.

The accompanying pgTAP file `supabase/tests/staff_submit_eod_cases_each.test.sql`
(per the spec's Files-changed list) follows the Track-2 contract — splits
persist, legacy entry without split keys still inserts, total stored as-received,
per-store `42501` gate intact, GRANT survival via `has_function_privilege`, no
`set role anon` probe (correctly avoids the spec-067 CI segfault). I did not deep-
read the test body (test coverage is test-engineer's lane), but its named
assertions map to design §"Test contract" Track-2 items 1-4.

## 2. PIN 1 — caseQty source

**MATCHES DESIGN.**

- `fetchItemsForVendor` (`EODCount.tsx:124`) selects
  `catalog:catalog_ingredients(name, unit, case_qty)` — reads `case_qty` from
  `public.catalog_ingredients`, the exact source I specified (mirroring
  `db.ts:166` / the `db.ts:3385` mapper). Confirmed `case_qty` lives on
  `catalog_ingredients`, not `inventory_items`.
- The map (`EODCount.tsx:149`):
  `caseQty: c?.case_qty == null ? null : Number(c.case_qty)` — the
  null-preserving form my design set as the default (deliberate divergence from
  the admin's `parseFloat || 1` collapse, justified in spec lines 398-408 so a
  future pack-size feature can distinguish "1-per-case" from "unknown"). `EodItem`
  is typed `caseQty: number | null` (`types.ts:29`). Net arithmetic identical to
  the admin because `|| 1` is applied at the conversion site. Correct.

## 3. PIN 2 — EodEntry shape + `:v1 → :v2` migrate

**MATCHES DESIGN.**

- **`EodEntry` final shape** (`types.ts:53-58`):
  `{ item_id, actual_remaining, actual_remaining_cases: number | null, actual_remaining_each: number | null }`
  — byte-identical to my finalized shape (spec lines 422-428). The single
  `count` field is REMOVED, not aliased (confirmed via grep: every remaining
  `count` token in the staff slice is either the v1-migrate read path or
  unrelated `{count}` i18n interpolation). `QueuedSubmission`/`SubmitPayload`/
  `ExistingSubmission` all ride the new `EodEntry` (`types.ts:69,103,129`).
- **Migrate is READ-ONCE-MIGRATE, not discard.** `migrateQueueIfNeeded`
  (`eodQueue.ts:158-231`) reads `V1_QUEUE_KEY`, maps each v1 `{item_id, count}`
  via `migrateV1Entry` (`eodQueue.ts:130-140`) to
  `{ actual_remaining: count, actual_remaining_cases: null, actual_remaining_each: count }`
  — the units-only-legacy interpretation I chose (OQ-4 consistent). Matches.
- **App.tsx ordering correct.** `App.tsx:201-203` calls
  `migrateQueueIfNeeded()` → `hydrateQueue()` → `hydrateQueueFromStorage(items)`
  — the exact ordering my design referenced (the migrate runs immediately before
  hydrate). Confirmed.
- **Idempotent + crash-safe.** The idempotency guard (`eodQueue.ts:164-167`)
  returns early when v2 is non-empty (`!= null && !== '' && !== '[]'`), so a
  second mount never clobbers freshly-enqueued v2 items with re-read v1 bytes —
  this is the Critical I flagged in design §Risks (idempotency of the migrate),
  landed correctly. The write ordering (`eodQueue.ts:221-226`) is
  write-v2-THEN-removeItem-v1, so a crash between leaves v1 intact + v2 populated
  and the next mount's guard skips — exactly the crash-safety my design
  specified. Malformed-v1 handling is best-effort (backup + drop, no throw,
  `eodQueue.ts:176-184`). `isValidQueuedSubmission` tightened in lockstep
  (`eodQueue.ts:42-72` — new `isValidEodEntry` element check). Correct.
- `entriesForRpc` (`useEodSubmit.ts:70-86`) is the near-identity map I designed:
  `item_id → ingredient_id` rename, all three split values forwarded. Confirmed.

## 4. Convert formula

**MATCHES DESIGN — byte-identical to the admin worksheet.**

- Admin `itemTotal` (`EODCountSection.tsx:395`): `cases * (i.caseQty || 1) + units`.
- Admin `buildSubmission` (`EODCountSection.tsx:429`): `(cases ?? 0) * (i.caseQty || 1) + (units ?? 0)`.
- Staff `onSubmit` build (`EODCount.tsx:358`): `cases * (it.caseQty || 1) + units`.
- Staff per-row live display (`EODCount.tsx:610-612`): same.

The core `cases × (caseQty || 1) + units` is byte-identical. The staff path uses
`Number.isNaN(...)` where the admin uses global `isNaN(...)` for the `→ 0`
coercion (`EODCount.tsx:356-357` vs `EODCountSection.tsx:393-394`); since both
operands are already `parseFloat` results (numeric), `Number.isNaN` and `isNaN`
are behaviorally identical here — NOT a divergence, same output. The "entered
when either box non-empty" predicate (`EODCount.tsx:353`,605) matches the admin
`hasEntry` rule (`EODCountSection.tsx:397-398`). The legacy pre-fill fallback
`actual_remaining_each ?? actual_remaining` lands at the screen seed step
(`EODCount.tsx:283-289`), mirroring the admin (`EODCountSection.tsx:340-344`).
All correct.

## 5. Reports unchanged

**MATCHES DESIGN — confirmed not touched.**

- `report_run_variance.sql`: no `case_qty`/`actual_remaining_cases`/`_each`
  references (grep clean) — reads the `actual_remaining` total, untouched.
- `report_run_variance_multivendor.sql`: same, grep clean — untouched.
- `report_reorder_list.sql`: reads `e.actual_remaining` (the total) as `on_hand`
  (lines 265,268-269,274) — untouched.

The whole OQ-1 payoff holds: because staff writes the converted total into
`actual_remaining`, the reports keep reading a true on-hand number with zero
report work.

## 6. Scope — staff-only

**MATCHES DESIGN — no admin behavior change.**

- `EODCountSection.tsx`: not modified behaviorally. Its case/unit state,
  conversion, and persistence are the reference and stay as-is.
- `InventoryCountSection.tsx`: not touched (its pre-existing case/unit state
  predates this spec and was correctly left alone).
- No `db.ts` change, no `useStore.ts` change, no edge-function change, no
  `config.toml` change, no `app.json` touch. The staff subtree's direct
  `supabase.*` calls are the documented carve-out (CLAUDE.md "DB access
  centralized") and were correctly NOT routed through `db.ts`. No bypass
  regression.

---

## Findings by severity

### Critical
None.

### Should-fix
None.

### Minor
- **M1 — stale admin comment left uncorrected.** `EODCountSection.tsx:60` still
  reads `// - Single qty input per item (no dual cases/each)`, which is stale
  (the admin worksheet has had dual inputs since before this spec). My design and
  the AC marked this fix **optional** ("NOT modified beyond an optional one-line
  correction"; spec line 244 "Correcting the stale comment … (optional)"). The
  implementation chose to leave it — within contract. Flagging only because the
  comment remains actively misleading to a future reader; a one-line fix in a
  future passing PR would close it. Not blocking.
- **M2 — `isNaN` vs `Number.isNaN` cosmetic divergence.** Staff uses
  `Number.isNaN` (`EODCount.tsx:356-357,608-609,611-612`) where the admin uses
  global `isNaN` (`EODCountSection.tsx:391-394`). Behaviorally identical on the
  numeric `parseFloat` operands in play (no string ever reaches the check), so
  no test or runtime difference. Noted for the record only; the stricter
  `Number.isNaN` is arguably the better choice. Not an action item.

---

## Summary

The implementation matches the design contract with zero drift. The RPC migration
is exactly the two-hunk `create or replace` I specified — signature byte-identical
(7-arg), GRANT preserved and not re-emitted, backward-compatible (absent keys →
NULL), `current_stock` and audit-log still writing the total, no RLS change, no
realtime publication change. Both pins landed as designed: PIN 1 reads `case_qty`
from `catalog_ingredients` with the null-preserving map I set as default; PIN 2's
`EodEntry` is the 3-field shape with `count` removed (not aliased), and the
`:v1 → :v2` migrate is the read-once-migrate I chose — idempotent (guards on a
non-empty v2) and crash-safe (write-v2-then-remove-v1), wired through App.tsx's
`migrateQueueIfNeeded() → hydrateQueue()` ordering. The convert formula is
byte-identical to the admin worksheet, the reports are untouched (the OQ-1
convert payoff holds), and scope is correctly staff-only with no `db.ts` bypass.
The only two findings are Minor and were both pre-flagged optional in the spec.
No architectural blocker to ship.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor
  (both pre-flagged optional in the spec — stale admin comment, cosmetic
  isNaN/Number.isNaN). Implementation matches the design contract with zero
  drift across the RPC migration, both PINs, the convert formula, reports, and
  scope. No db.ts bypass.
payload_paths:
  - specs/086/reviews/backend-architect.md
