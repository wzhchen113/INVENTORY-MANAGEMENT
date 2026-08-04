# Spec 151 — architectural drift review (backend-architect, post-impl)

Reviewed against the `## Backend design` section of
[specs/151-last-order-context.md](../../151-last-order-context.md) (§0–§11).

Scope read: the migration, the pgTAP suite, the `db.ts` seam + mapper, the pure
formatter, the store slice, both render tiers, the three i18n catalogs, and the
upstream tables/policies/writers the design leans on.

**Verdict: no Critical. 3 Should-fix, 2 Minor.** The implementation matches the
contract closely — signature, envelope, `security invoker` + `42501` top gate,
tier precedence, `null`-preservation, the single phone insertion point, and the
no-publication-change posture all landed as designed. Every finding below is
either a gap the *design itself* carried (SF-1), a test-shape issue (SF-2), or a
pre-existing schema weakness this RPC newly depends on (SF-3).

---

## Contract conformance (what matched — stated so the deltas are legible)

| Design item | Landed |
|---|---|
| §2 signature `(uuid, uuid[], date default null) returns jsonb` | ✅ [migration:51-58](../../../supabase/migrations/20260803000000_report_last_order_context.sql) |
| R-B `security invoker`, `auth_can_see_store` gate, **no** top-level `auth_is_privileged()` | ✅ :56-73, pinned structurally by (P5) `prosecdef = false` |
| R-C tier CTEs + `distinct on … tier asc, anchor_date desc, created_at desc` | ✅ :115-163 |
| R-D vendor with no anchor **omitted** | ✅ :285-300, pinned by (X1)/(X2) |
| R-E `direct` → `bydate` counted precedence | ✅ :177-195, pinned by (F1)/(F2) |
| AC-7/AC-8 via `item_union` UNION, JSON-null preserved | ✅ :243-247, pinned by (L3)/(L4) with `jsonb_typeof` |
| AC-22 raw-length bound before de-dup | ✅ :75-82 |
| §1.2 the one justified index | ✅ :349-350, pinned by (P4) |
| §3.2 envelope incl. `source_id` / `items_truncated` | ✅ :285-305 |
| §5.2 `useInflight.track` + `.abortSignal`, errors re-thrown, **no `?? 0`** | ✅ [db.ts:4701-4741](../../../src/lib/db.ts) |
| R-G tri-state, silent failure, store-switch reset | ✅ [useStore.ts:966, 1588, 3862-3879](../../../src/store/useStore.ts) |
| AC-14 single phone insertion point | ✅ `PhoneApproveOrder.tsx` has **zero** references — structurally proven |
| AC-24 no new `supabase.from/rpc` outside `db.ts` | ✅ both tiers go through the store |
| AC-REG-7 no publication change ⇒ no `docker restart supabase_realtime_imr-inventory` | ✅ nothing touches `supabase_realtime` |

---

## Should-fix

### SF-1 — the approval-branch `uuid` cast is unguarded; one malformed `lines` element poisons the RPC for the whole store

[migration:216-224](../../../supabase/migrations/20260803000000_report_last_order_context.sql)

```
select a.vendor_id, (l->>'item_id')::uuid, sum((l->>'qty_base')::numeric)
 …
 where a.source = 'order_approval'
   and nullif(btrim(coalesce(l->>'item_id', '')), '') is not null
   and jsonb_typeof(l->'qty_base') = 'number'
```

The `qty_base` half is guarded by `jsonb_typeof(...) = 'number'`. The `item_id`
half is guarded only for **non-emptiness** — `"item_id": "wings"` passes the
`WHERE` and then raises `22P02 invalid input syntax for type uuid` in the
`SELECT`/`GROUP BY`. Because the RPC returns one envelope for the whole screen,
a single bad row fails the read for **every vendor on the screen and every
caller in that store**, not just the offending vendor.

The stated intent in the migration's own comment (:213-214) is "so a hand-written
row cannot crash the cast" — that intent is only half-delivered. **The design is
where this originated** (§2.4 specified exactly these two guards), so this is a
shared gap, not developer drift; I'm flagging it against my own design.

Reachability: `create_order_approval` *does* validate `item_id` as a uuid
([20260801000100:331-339](../../../supabase/migrations/20260801000100_order_approvals.sql)),
so the shipped write path is safe. But it is **not the only** write path —
`privileged_store_insert_order_approvals` (:248-252) permits a direct PostgREST
INSERT by any privileged store member, and the row-shape validation lives in the
RPC, not in a table CHECK. So a hand-written or future-client row is a live
possibility.

Blast radius is bounded by AC-17 (the FE degrades to silent no-context, no
toast), which is why this is Should-fix and not Critical.

**Fix:** add a shape guard in the same `WHERE`, so a malformed element is
*skipped* rather than fatal — a skipped item renders no context, which is AC-9's
honest state at row grain:

```
and l->>'item_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
```

(case-insensitive form, or `~*`). Add one pgTAP arm: an approval whose `lines`
carries a non-uuid `item_id` ⇒ the call `lives_ok` and that vendor's other items
still resolve.

### SF-2 — the (P1) arm re-implements the spec-053 lint detector, and the copy has **already drifted**

[report_last_order_context.test.sql:603-622](../../../supabase/tests/report_last_order_context.test.sql)
vs [permissive_policy_lint.test.sql:118-122](../../../supabase/tests/permissive_policy_lint.test.sql)

The developer replaced my §10 arm 14 ("`pg_policies` count for the five source
tables is unchanged") with a re-scoped copy of the lint regex. **I accept the
rationale and consider it an improvement in intent** — a hard-coded policy count
is a landmine that goes red the first time an unrelated spec legitimately adds a
policy to `purchase_orders`, and the arm as I wrote it tested nothing about this
migration. That part of the deviation is endorsed.

The *implementation* is the problem. The copy reproduces the OR-tail regex in its
**pre-spec-053-arm-4 form**:

- spec 151 (:615-618): `'\bor\s+\(*\s*(…)\s*\)*'`
- canonical (:121-122): `'\bor\s+\(*\s*(…)(?!\s+and\b)\s*\)*\s*($|\s+or\b)'`

The missing negative lookahead + anchor is exactly what arm (4) of the canonical
probe exists to protect (`permissive_policy_lint.test.sql:274-333`): an
AND-guarded OR-arm such as `(x = auth.uid()) OR (auth.uid() IS NOT NULL AND
auth_is_admin())` is a **legitimate** narrowed predicate. The canonical probe
deliberately does not flag it; spec 151's copy does. It is green today only
because no such policy exists on the five tables. The day one lands, the
canonical gate stays green and an unrelated spec's suite goes red inside spec
151's file — the worst possible place to debug it.

This is the CLAUDE.md "inline-not-shared is invisible drift surface" failure mode
reproduced inside the test tier, and unlike the edge-function case there is no
one-function-per-deploy constraint to justify it.

**Fix:** delete the duplicated detector. The canonical probe already scans all of
`public.*`, which includes the five source tables — AC-21 is covered without a
second copy. Replace (P1) with the claim that is actually specific to this spec,
i.e. the thing `security invoker` *depends on*:

> the five source tables still carry their expected named SELECT policies, and
> each qual references `auth_can_see_store` (plus `auth_is_privileged` for
> `order_approvals`).

That fails loudly if a future spec loosens or renames a policy this RPC leans on
for its entire authorization story, which is a far more valuable pin than a
count or a regex echo.

### SF-3 — `counted_lines` is not de-duplicated, and `eod_entries` has no `(submission_id, item_id)` uniqueness

The developer's observation is **correct and worth recording**:
[init_schema.sql:128-135](../../../supabase/migrations/20260405000759_init_schema.sql)
declares `eod_entries` with no unique constraint on `(submission_id, item_id)`,
and both writers delete-then-insert straight from a client-supplied array with no
dedupe — the staff RPC
([20260630000200:154-185](../../../supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql))
and the admin path ([db.ts:882-902](../../../src/lib/db.ts)).

Consequence in this RPC ([migration:231-263](../../../supabase/migrations/20260803000000_report_last_order_context.sql)):
`ordered_lines` aggregates (`sum … group by`), but `counted_lines` does not. A
duplicate entry therefore fans out through `left join counted_lines … using
(vendor_id, item_id)` and produces:

1. a duplicated element in `items[]`;
2. an inflated `total_n` from `count(*) over (partition by vendor_id)`, so
   `items_truncated` can read `true` below 500 *distinct* items and `rn` shifts;
3. a last-write-wins pick in the client `Record` at
   [db.ts:4732](../../../src/lib/db.ts) — i.e. one of the two counted values,
   silently.

Mitigating context (why this is Should-fix, not Critical): the shipped
`report_reorder_list` carries the identical un-deduped `left join
public.eod_entries` shape
([20260726000000:237-239](../../../supabase/migrations/20260726000000_reorder_drop_inbound_term.sql)),
so the exposure is systemic and pre-dates spec 151 rather than being introduced
by it.

**Fix, in this spec:** make `counted_lines` deterministic at one row per
`(vendor_id, item_id)` — `distinct on (cs.vendor_id, e.item_id) … order by
cs.vendor_id, e.item_id, e.created_at desc` (last-written wins, matching what the
EOD screen shows). Do **not** `sum()` here: summing two rows for the same item
would invent a counted total, which the honesty rule forbids. Add one pgTAP arm
seeding two entries for one item and asserting a single `items[]` element.

**Do not** add the unique index in this spec. Prod may already hold duplicate
rows; a unique index needs a dedupe pass and a migration of its own. That, plus
the matching hardening of `report_reorder_list`, is a follow-up spec — record it
as such rather than smuggling a schema constraint into a display feature.

---

## Minor

### M-1 — §7.1's "a realtime replay does not refetch" is not what happens

[ReorderSection.tsx:1470-1484](../../../src/screens/cmd/sections/ReorderSection.tsx)
implements the derived-string-key dep exactly as designed, and the comment
repeats the design's claim that a 400 ms-debounced replay produces an identical
key and therefore no refetch.

It does refetch. `loadFromSupabase` nulls `reorderPayload` in the same `set` that
nulls `lastOrderContext` ([useStore.ts:1580-1588](../../../src/store/useStore.ts)),
and that block runs on **every** realtime reload (the spec-138 comment at :1589
says so explicitly). So the key transitions `'a,b'` → `''` → `'a,b'`, which is two
dependency changes, and the effect fires again on the third render.

Behaviour is correct — the context blanks (R-G `'hidden'`, which AC-17 permits)
and comes back. Cost is one extra RPC per replay, which is what the design was
trying to avoid. Flagging only because the code comment asserts the opposite and
a future reader will optimize against a false premise. Either correct the comment
or drop the string-key indirection in favour of the array identity (same
behaviour now, one less piece of machinery to believe in).

### M-2 — nothing pins that the module's hard-coded i18n keys exist in the catalogs

The pure module carries key literals in two string unions
([lastOrderContext.ts:166-171, 211-215](../../../src/utils/lastOrderContext.ts)),
which is the right call for purity — but the union is only a *typo* guard within
itself, not proof the catalog has the key. The unit suite asserts against a
**local copy** of the templates
([lastOrderContext.test.ts:79-85](../../../src/utils/lastOrderContext.test.ts)),
and the i18n parity test only compares the three catalogs to each other. A rename
in `en.json`/`es.json`/`zh-CN.json` therefore keeps every gate green while
`t()` falls back to returning the raw key plus a `console.warn`
([src/i18n/index.ts:65-73](../../../src/i18n/index.ts)) — i.e. the ordering
screens would render the literal text `section.reorder.lastOrderFull`.

Cheap fix: one jest case that imports `en.json` and asserts every member of
`LastOrderSentence['key']` and `LastOrderDeltaText['key']` (plus
`lastOrderNone` / `lastOrderNotConfirmed`, which the tiers reference directly)
resolves to a non-empty string.

---

## Verdicts on the four flagged deviations

| # | Deviation | Verdict |
|---|---|---|
| 1 | (P1) policy-count arm → lint-consistency assertion | **Rationale accepted, assertion needs rework.** Dropping my brittle count arm was right; re-implementing the spec-053 detector was not, and the copy is already divergent. → SF-2. |
| 2 | missing `eod_entries (submission_id, item_id)` uniqueness | **Observation correct and material.** Fix the fan-out inside this RPC now; the schema constraint is a follow-up spec, not this one. → SF-3. |
| 3 | unguarded approval-branch uuid cast | **Real gap, and it is the design's gap.** Guard the shape in the `WHERE` so a malformed row is skipped, not fatal. → SF-1. |
| 4 | `lastOrderSentence` / `lastOrderDeltaText` / `formatLastOrderDate` in the shared pure module | **Accepted and endorsed — no rework.** §5.3 under-specified "the tier formats it"; template *selection* is identical logic on both tiers, so two copies were guaranteed to drift, which is precisely what design guidance 2 exists to prevent. Both tiers demonstrably call the same selector ([PhoneOrdering.tsx:399-404](../../../src/screens/cmd/sections/phone/PhoneOrdering.tsx), [ReorderSection.tsx:810-815](../../../src/screens/cmd/sections/ReorderSection.tsx)). Purity is preserved — `fmtQty`/`fmtDate` are injected, no i18n/React/supabase import — and the discriminated result the design mandated is unchanged. `formatLastOrderDate`'s ISO-parts parse correctly avoids the `new Date(iso)` UTC day-shift. Only caveat is M-2. |

---

## Not findings (checked, clean)

- **AC-10 honesty rule.** No `suggested*` / `par*` / `pendingPoQty` / `costPerUnit`
  reference anywhere in the RPC, the mapper, or the formatter; the `Pick<>` on
  `buildLastOrderContext` enforces it at the type level as designed.
- **AC-5.** No dollar arithmetic anywhere in the feature — the spec-104 per-each
  bridge is untouched.
- **R-B / R-5.** The privilege conjunct correctly stays a row filter; (Z3)/(Z4)
  pin both halves; (P5) blocks a future flip to `security definer`.
- **AC-REG-7.** No `supabase_realtime` membership change ⇒ the
  `docker restart supabase_realtime_imr-inventory` ritual genuinely does not
  apply here. Correctly asserted rather than performed.
- **Migration ordering / prod apply.** `20260803000000` sorts after
  `20260801000100`; the migration header carries the MCP apply + `schema_migrations`
  insert + normalized-md5 verification steps, and flags the expected RED window on
  `db-migrations-applied.yml`. Prod apply correctly left owner-gated.
