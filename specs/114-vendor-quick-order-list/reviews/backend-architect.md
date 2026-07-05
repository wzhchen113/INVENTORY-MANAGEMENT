# Spec 114 — Backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Spec: `specs/114-vendor-quick-order-list.md` (Status: READY_FOR_REVIEW)
Design authored by this agent: §§ D-1–D-12 in the spec.
Verdict: **No Critical, no Should-fix. 0 blocking findings.** The implementation
matches the contract. Two Minor notes (both behaviorally inert), and one
explicit ruling on the required-vs-optional `ItemVendorLink.orderCode` shape:
**WITHIN DESIGN.**

The decisive call the dispatch asked for is at Finding 2. The rest is
confirmation that each design decision landed as specified.

---

## The decisive call — required `orderCode: string` + the useStore.ts touches

**Finding 2 (ruling): WITHIN DESIGN.**

The design body (D-5) shows `ItemVendorLink` gaining `orderCode: string` — the
`## Files changed` block later in the SAME design (spec:840-850) makes this
required-and-defaulted explicit and enumerates the `useStore.ts` optimistic-body
+ param-signature touches as its downstream consequence. So the required shape
is not a deviation from the design as committed — it IS the design as committed.
Assessing it on the merits anyway, because the dispatch framed it as the
open question:

- **The required `orderCode: string` (default `''`) is the correct realization,
  not drift.** It mirrors the sibling required fields on the exact same interface:
  `vendorName: string`, `costPerUnit: number`, `casePrice: number`, `isPrimary:
  boolean` (`src/types/index.ts:187-197`) are ALL required on the hydrated shape,
  because `mapItem` always produces them. `orderCode: lv.order_code || ''`
  (`db.ts:4811`) always produces a string too, so an optional `?` would be a lie
  about the hydrated shape and would force every reader to `?? ''` at the call
  site. The `POsSection` resolver reads `...?.orderCode` off the hydrated link
  and passes it into a `CodeResolver` that already tolerates `null | undefined |
  ''` — so the required-string hydrated shape and the tolerant-resolver boundary
  compose exactly. This is the same choice spec 102 made for `vendorName`; my
  D-5 note "mirroring how vendorName is a required string on the same interface"
  is the governing precedent, and the developer followed it.

- **The `'' → SQL NULL` coalescing is correct and consistent on BOTH edges.**
  The write edge collapses empty→NULL (`order_code: l.orderCode || null` at
  `db.ts:373` create, `v.orderCode || null` at `db.ts:504` update); the read edge
  expands NULL→`''` (`lv.order_code || ''` at `db.ts:4811`). The pure form helper
  also collapses to `undefined` BEFORE it reaches db.ts (`vendorRowsToLinkPayload`
  → `(r.orderCode || '').trim() || undefined`, `IngredientForm.tsx:265`), so the
  wire never carries `''` and never `"undefined"` — exactly AC-3's contract, and
  the pgTAP (11a)/(12) pin it as SQL NULL. The asymmetry (`''` in the app-side
  hydrated model, `NULL` at rest) is intentional and matches how the rest of the
  link fields behave. No round-trip can produce the literal string `"undefined"`.

- **The `useStore.ts` touches are FORCED by the required type, not gratuitous.**
  D-8 said "no `useStore.ts` slice change" — that referred to *no new slice
  field / no new action / no new revert path*, and that still holds: `inventory`
  gains no field, no new action exists, the optimistic-then-revert path is
  unchanged. What the required `orderCode` DID force is that the existing
  optimistic `linkSet.map` bodies in `addItem`/`updateItem` must now populate
  `orderCode` (else they'd construct an `ItemVendorLink` missing a required
  field — a type error), and the `vendors?` param signatures must carry
  `orderCode?: string` (else the editor payload couldn't reach db.ts). Both
  landed: `addItem` map + scalar-fallback (`useStore.ts:1269`, `:1279`),
  `updateItem` map (`:1335`), both param signatures (`:193`, `:200`). These are
  the minimal, type-driven closures of the required-field decision — they add no
  behavior, only satisfy the compiler. The design's `## Files changed` block
  predicted every one of these edits by name. **Converge cleanly — within
  design.** An optional `orderCode?` would have avoided these three edits but at
  the cost of a dishonest hydrated type and `?? ''` noise at every reader; the
  required shape is the better trade and the one the design chose.

Rule: **required-`''` is WITHIN DESIGN; the useStore.ts touches are WITHIN
DESIGN (type-forced, behaviorally inert).** Nothing to correct.

---

## 1. Column (D-1) — CONFIRMED

`supabase/migrations/20260708000000_item_vendor_order_code.sql`:

- Additive `add column if not exists order_code text` — nullable, **no default,
  no backfill, no drop, no existing-column change** (migration:78-79). Matches D-1.
- **Sorts after `20260707000000_staff_receiving_price_gate.sql`** — verified it is
  the last file in `supabase/migrations/` (the 2026070x series ends at
  `…08000000`). D-1's ordering prediction holds exactly.
- **Inheritance claim holds.** The migration touches NO policy, NO grant, NO
  publication — it is a lone `alter table … add column` + `comment on column`.
  Because `item_vendors`' four `store_member_*` policies gate the whole row via
  `exists(… inventory_items ii … auth_can_see_store(ii.store_id))`
  (`20260630000000_item_vendors.sql:121-142`), the added column is covered
  row-level with zero policy edit. Table-level grants (`:98`, `:100`) + the
  spec-097 explicit-grants migration cover the new column automatically. The
  table is already in `supabase_realtime` (`:172`) and already subscribed in
  `useRealtimeSync.ts` — so an `order_code` edit replays on `store-{id}` with no
  wiring change. **All three inheritance legs (4 policies + spec-097 grants +
  realtime membership) are unchanged, as claimed in D-1/D-2/D-7.**
- **DDL prod-apply note present** (migration:54-69): execute_sql the ALTER +
  `schema_migrations` insert '20260708000000' + verify by COLUMN PRESENCE (not a
  body-only normalized-md5, correctly distinguished as a function-body technique).
- **Realtime `docker restart` gotcha correctly flagged as a deliberate ABSENCE**
  (migration:46-52) — column-add on an already-published table does not change
  publication membership, so the restart step does not apply. Matches OQ-5 / D-7.
- **spec-053 permissive-lint arm** — no policy added, so no allowlist edit;
  the CI lint stays green untouched, as D-1 stated.

## 3. db.ts threading (D-5) — CONFIRMED, all four edits + no PoLine change

1. **Embed** (`db.ts:238-239`) — `order_code` added to the
   `item_vendors:item_vendors(…)` projection. Matches D-5.1.
2. **mapItem hydration** (`db.ts:4800`, `:4811`) — `vendorLinks` element type gains
   `orderCode: string`; `.map` adds `orderCode: lv.order_code || ''`. Matches D-5.2.
3. **Create upsert** (`db.ts:373`) — `order_code: l.orderCode || null`. Matches D-5.3.
4. **Update reconcile upsert** (`db.ts:504`) — `order_code: v.orderCode || null`.
   Matches D-5.4.
5. **Both `vendors?` payload types** (`db.ts:303` create arg, `:403` update arg) —
   gain `orderCode?: string`. Matches D-5.5.

**Empty → NULL never `""`/`"undefined"`:** confirmed on both write edges
(`|| null`) and the read edge (`|| ''`); the form helper pre-collapses to
`undefined` (`IngredientForm.tsx:265`). No path produces `"undefined"`.

**The export reads `order_code` off the EXISTING inventory embed — no new fetch,
no PoLine change:** CONFIRMED, exactly as D-3 predicted. `onShareQuickOrder`'s
`resolveCode` is `inventory.find(...)?.vendors?.find(v => v.vendorId ===
sel.vendorId)?.orderCode` (`POsSection.tsx:260-263`) — in-memory off the same
`inventory` slice `onShare` already reads. `fetchPurchaseOrderLines` / `PoLine`
are untouched (grep for `order_code`/`orderCode` in the PO-lines path returns
nothing). No `(po.vendor_id, line.item_id)` fetch fan-out. D-3 held.

## 4. Builder + surface (D-3/D-4/D-7/D-8/D-9) — CONFIRMED

**`src/utils/poQuickOrderText.ts`:**

- Pure — imports only `formatQty` from `./reorderExport` (the same shared
  formatter `poShareText.ts` uses); no React / theme / supabase / i18n /
  formatMoney import. Matches D-9.
- **Delimiter is literal TAB** (`const DELIM = '\t'`, line 71). Mapped line
  `` `${code}${DELIM}${qty}` ``; unmapped `` `??? ${name}${DELIM}${qty}` ``
  (`UNMAPPED_PREFIX = '??? '`, line 67). One line per input line, joined with
  `\n`, no header/labels/trailing count. Matches D-9 / OQ-6.
- **`??? ` sentinel** on unmapped (null/blank code or no matching link), name
  resolved via injected `resolveName` (current-locale, OQ-8). `unmappedCount`
  returned for the caller's toast. Matches D-9 / AC-9.
- **NO `$` anywhere** — no money field on `PoQuickOrderLine`, no formatMoney;
  the jest pin asserts `!text.includes('$')` per the design. Matches AC-7.
- Empty input → `{ text: '', unmappedCount: 0 }` (total). Matches D-9.
- Signature matches D-9 byte-for-byte (`buildPoQuickOrderText(lines,
  resolveCode, resolveName) → { text, unmappedCount }`, injected
  `CodeResolver`/`NameResolver`).

**Second Share surface in `POsSection.tsx`:**

- `onShareQuickOrder` (`:256-289`) hands the block to the **existing**
  `sharePurchaseOrder` orchestrator verbatim (`:275`), sets the shared
  `sharePreview` from `previewText` (`:279`). No new I/O plumbing. Matches AC-10.
- **NO mark-sent auto-prompt on this path** — CONFIRMED. `onShare` fires the
  draft "did you send it?" prompt (`:235-242`); `onShareQuickOrder` deliberately
  does NOT (`:280-288` fires only the unmapped-count toast, no `confirmAction`,
  no `runMarkSent`). The divergence is documented in the handler's header
  comment (`:251-255`). Matches D-8's deliberate divergence exactly.
- **Second button is textually + visually distinct** — `testID=
  "po-action-quick-order"`, outlined secondary (`borderWidth: 1`, `mono(500)`,
  `C.fg2`) next to the accent primary Share (`testID="po-action-share"`,
  `backgroundColor: C.accent`, `mono(700)`) (`:417-440`). Same `canShare` gate
  (`draft`/`sent`/`partial`) on both (`:297`, `:417`, `:431`). Matches AC-6.

**`sharePurchaseOrder` reused verbatim (D-8 no-mark-sent):** CONFIRMED — the
quick-order handler calls the same imported orchestrator with a different
`dialogTitle`/`onCopyToast`; the orchestrator source is untouched.

## 5. pgTAP (D-11) — CONFIRMED, plan is exact, sibling suites untouched

`supabase/tests/item_vendors_rls.test.sql`:

- `plan(8)` → `plan(14)`. I counted 14 emitted assertions: (9) has_column,
  (10a) col_is_null, (10b) col_type_is, (1) fixture isnt, (4) member-INSERT is,
  (2) member-SELECT is, (3) non-member-SELECT is, (11a) omitted→NULL is,
  (11b) member write+read is, (5) non-member-INSERT throws_ok(42501), (6)
  cost-unchanged is, (12) order_code-stays-NULL is, (7) item-swap throws_ok(42501),
  (8) member-DELETE is. **14 assertions = plan(14). No plan skew** (a skew would
  fail CI). Matches D-11.
- **Inherited-policy regression pinned (12):** the non-member UPDATE of
  `order_code` on the Charles link is a USING no-op — re-read under `postgres`
  proves it stayed NULL (`:248-266`). This is the exact "added column did not
  escape the whole-row policy" proof D-2/D-11 required. (11a) also proves
  omitted→SQL NULL (not `''`/`"undefined"`) directly.
- **Hermetic** (`begin; … rollback;`), reuses the existing
  manager-impersonation + postgres-seeded-Charles pattern, `is_primary=false`
  on seeded links to respect the one-primary-per-item partial-unique index, no
  `set role anon` (spec 067 segfault avoided). Clean.
- **Spec-113 / spec-109 suites untouched:** `staff_receiving_gate.test.sql`
  (spec 113) and `cost_on_receipt.test.sql` (spec 109) are separate files; the
  order-code coverage correctly extended `item_vendors_rls.test.sql` IN PLACE
  rather than touching either sibling. Confirmed by file listing — neither is in
  the spec's `## Files changed`, and both remain distinct on disk.

---

## Minor findings (non-blocking, behaviorally inert)

**Minor 1 — unmapped-count toast uses `type: 'error'`, design said "warning
Toast".** `POsSection.tsx:283-287` fires `Toast.show({ type: 'error', … })` for
the unmapped-count surface. D-9 described it abstractly as a "warning Toast";
`react-native-toast-message` has no `warning` type, so `error` (red, attention-
grabbing) is the reasonable realization of "warn the operator". The interpolated
`quickOrderUnmappedWarning` count string carries the actual semantics, and
`position: 'bottom'` keeps it distinct from the top success toast. **WITHIN
DESIGN** — the design pinned the *observable* (a count surfaced, not silently
dropped, AC-9) not the toast enum, and the observable is met. No change needed;
noted only so the reviewer fan-out doesn't re-flag it.

**Minor 2 — export block itself carries `order_code` from `inventory`, but the
resolver returns `undefined` (not `''`) for a link with no code.** `resolveCode`
returns `row?.vendors?.find(...)?.orderCode`, which is `''` for a hydrated link
with an empty code (mapItem default) but `undefined` when the item has no link
to `sel.vendorId` at all (`.find` misses). The builder's `(rawCode ?? '').trim()`
treats `null`/`undefined`/`''` identically as unmapped (`poQuickOrderText.ts:96`),
so both the "linked-but-blank" and "not-linked-at-all" cases correctly produce a
`??? ` line — exactly AC-9's "null/empty vendor_sku, or no matching link". This
is correct; noting only that the two distinct upstream states (blank vs absent
link) collapse to one output, which is the intended AC-9 behavior, not a gap.

---

## Undeclared deltas

None found. Every edit in the working tree is enumerated in the spec's
`## Files changed` block and tagged `Spec 114`. The obsolete item-level
`values.vendorSku` stub is untouched (`IngredientForm.tsx:1283`, still
`readOnly` "schema pending"), honoring OQ-4. `csvImport.ts`'s `vendor_sku` alias
is untouched (out of scope, D-1). No file bypasses `db.ts` to hit Supabase
directly — the export reads the in-memory `inventory` slice, the writes ride the
existing `createInventoryItem`/`updateInventoryItem` reconcile. No new edge
function, no publication change, no RPC — matching D-3/D-4 "PostgREST only".

## Bottom line

Contract matched end-to-end. RLS landed as inherited (row-level, column-agnostic;
pgTAP (12) proves the non-member write is still denied). The one architectural
judgment call the dispatch flagged — required `orderCode: string` forcing the
useStore.ts touches — is **WITHIN DESIGN**: it is the sibling-`vendorName`
precedent the design cited, the touches are minimal and type-forced (no new
behavior), and both halves converge cleanly. Browser-verified round-trip + TAB
export + `???` flagging + no-`$` (per the dispatch) corroborate the static read.
0 Critical, 0 Should-fix, 2 Minor (both inert).

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor
  (both behaviorally inert). Decisive call — the required `ItemVendorLink.orderCode:
  string` shape and its forced `src/store/useStore.ts` optimistic-body + param-
  signature touches — ruled WITHIN DESIGN (mirrors the sibling required `vendorName`
  on the same interface; the useStore.ts edits are minimal and type-forced, adding
  no behavior). All four db.ts threading edits, the export-reads-the-existing-embed
  prediction (no PoLine change, no new fetch), the TAB/`???`/no-`$` builder, the
  no-mark-sent second Share button, and the pgTAP inherited-policy regression pin
  (plan(14), 14 assertions, exact) all match §§ D-1–D-12. Migration sorts last and
  the inheritance claim (4 policies + spec-097 grants + realtime membership
  unchanged) holds. No undeclared deltas; spec-113/109 suites untouched.
payload_paths:
  - specs/114-vendor-quick-order-list/reviews/backend-architect.md
