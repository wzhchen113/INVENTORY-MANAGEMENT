# Backend-architect post-implementation drift review — spec 110

Reviewer: backend-architect (post-impl mode)
Scope: verify the implementation matches the `## Backend design` (§0–§12) I authored.
Verdict per decision: WITHIN DESIGN / DRIFT. Contract-only lens.

Files reviewed:
- `supabase/migrations/20260706000000_store_count_layouts.sql`
- `src/lib/db.ts` (StoreCountLayout + 4 helpers, lines 2366–2478)
- `src/screens/staff/lib/countLayouts.ts`
- `supabase/tests/store_count_layouts.test.sql`
- `src/store/useStore.ts` (4 I/O wrappers, lines 372–387 iface, 1984–2023 impl)
- `src/screens/cmd/sections/InventoryCountSection.tsx`
- `src/screens/staff/screens/WeeklyCount.tsx`
- `src/components/cmd/CountLayoutNameModal.tsx`

**Bottom line: 0 Critical, 0 Should-fix, 0 Minor drift.** Every pinned server-side
observable and every FE contract point matches the design. The migration-version
correction is ruled WITHIN DESIGN below. A handful of implementation choices are
tighter than the design text (defensive supersets); all are flagged as
within-design deltas, none behaviorally divergent. Two informational notes at the
end for the release-coordinator (neither is a finding).

---

## Migration-version correction ruling (the explicit ask)

**RULING: WITHIN DESIGN — correction is correct and necessary.** My handoff and
design §1 named `20260704000000_store_count_layouts.sql`, sorting "after the latest
on disk, `20260630000500_user_count_orders.sql`." Between design and build, three
migrations landed (`20260703000000_user_count_drafts`, `20260704000000_po_loop`,
`20260705000000_cost_on_receipt`) — so `20260704000000` AND `20260705000000` are
both TAKEN (verified on disk: `supabase/migrations/20260704000000_po_loop.sql`,
`supabase/migrations/20260705000000_cost_on_receipt.sql`). The dev bumped to
`20260706000000`, which sorts strictly last on disk. The migration references only
pre-existing objects (`public.stores`, `public.profiles`, `public.user_count_orders`)
so no ordering hazard is introduced by the later slot. The dev also updated the
in-file ORDERING comment (lines 64–69) to cite the correct predecessor
(`20260705000000_cost_on_receipt.sql`) and documented the version bump inline plus
in the spec's Files-changed VERSION NOTE. This is exactly the right correction —
picking a colliding version would have produced two migrations at one timestamp and
a `schema_migrations` ambiguity. The `§12` prod-apply note text still says insert
version `20260704000000` in ONE spot (spec line 1057) but the Files-changed block
(line 1256) and the migration header both say `20260706000000`; see Note 1.

---

## §0 Mechanism (OQ-6): RPC-for-writes + PostgREST-for-reads + parallel RLS

WITHIN DESIGN. Reads are PostgREST `.from('store_count_layouts').select(...)`
(db.ts:2403, staff carve-out:62). Writes are the three SECURITY DEFINER RPCs. The
table ALSO carries the privileged-gated RLS write policies (defense-in-depth) — the
"RPC gate + parallel RLS gate" shape I specified. AC-3b's "direct PostgREST write
must fail" is pinned by pgTAP cases (16)/(17)/(18).

## §1 Data model / table shape

WITHIN DESIGN — column-for-column.

- `id uuid pk default gen_random_uuid()` ✓ (migration:82)
- `store_id uuid not null references public.stores(id) on delete cascade` ✓ (:85)
- `name text not null check (length(btrim(name)) between 1 and 60)` ✓ (:88–89) —
  matches the design CHECK exactly.
- `item_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(item_ids) = 'array')`
  ✓ (:92–93).
- `position smallint not null check (position between 1 and 3)` ✓ (:98–99) — the
  explicit slot-1..3 decision from §1.1.
- `created_by uuid null references public.profiles(id) on delete set null` ✓ (:102)
  — attribution-only, `set null` on author delete, as specified.
- `created_at` / `updated_at timestamptz not null default now()` ✓ (:103–106).
- **No `vendor_id`** ✓ — Weekly is vendor-less (R-1).
- `unique (store_id, position)` as `store_count_layouts_store_position_uq` ✓
  (:122–123) — the structural cap ceiling + read-path index (leading `store_id`),
  no separate read index. Matches §1.1.
- **No `(store_id, name)` unique** ✓ (:117–121 comment) — the OQ-A default (name
  uniqueness NOT enforced), preserving last-write-wins over an opaque 23505.

Position-slot SEMANTICS pinned exactly: create picks the lowest free slot 1..3
(RPC:272–276), overwrite does NOT touch position (RPC:250–256, no `position` in the
SET list), delete frees a slot that a later create reuses (pgTAP (12)/(13)). CHECKs
+ unique both exercised structurally by pgTAP (26).

## §1 Grants (spec-097 explicit-grant posture)

WITHIN DESIGN. `grant select, insert, update, delete, references, trigger ... to
anon, authenticated;` + `grant all ... to service_role;` (:137–139) — byte-match to
the design's grant block, TRUNCATE omitted for anon/authenticated.

## §2 RLS impact — policy predicates

WITHIN DESIGN — all four policies match name + helper + predicate exactly.

| command | policy name (design → impl) | predicate |
|---------|------------------------------|-----------|
| SELECT | `store_member_read_count_layouts` ✓ | `using (public.auth_can_see_store(store_id))` ✓ (:158–160) |
| INSERT | `privileged_insert_count_layouts` ✓ | `with check (auth_is_privileged() and auth_can_see_store(store_id))` ✓ (:163–165) |
| UPDATE | `privileged_update_count_layouts` ✓ | `using (...) with check (...)`, both privileged AND store ✓ (:168–171) |
| DELETE | `privileged_delete_count_layouts` ✓ | `using (auth_is_privileged() and auth_can_see_store(store_id))` ✓ (:174–176) |

- Single permissive policy per command, no `auth.uid() IS NOT NULL` OR-arm ✓ — the
  CLAUDE.md OR-compose / permissive-shadow discipline honored.
- Helper arity verified against source: `auth_can_see_store(uuid)` (one-arg,
  `20260517040000_auth_can_see_store_brand_scope.sql:88`) and `auth_is_privileged()`
  (no-arg, `20260509000000_multi_brand_schema_rls.sql:235`). The migration calls both
  with correct arity everywhere.
- SELECT gate is `auth_can_see_store()` ONLY (staff read/pick, AC-3); writes AND
  `auth_is_privileged()` on top (OQ-1/AC-3b). ✓
- spec-053 permissive-policy-lint: no trivially-wide predicate, no OR-tail → no
  allowlist edit. ✓ (pgTAP header line 71–73 asserts-by-absence.)
- RLS enabled (`alter table ... enable row level security`, :155). ✓

## §3 AC-13 cleanup DELETE (the one non-additive hunk)

WITHIN DESIGN. `delete from public.user_count_orders where screen in
('admin-inventory', 'staff-weekly');` (:408–409) — verbatim the design predicate,
placed AFTER the create/policy/RPC/grant block. Bounded, cannot touch the two EOD
families. Predicate-scoping pinned by pgTAP (27) (`'0/1'` — Weekly gone, EOD
survives).

## §4 API contract — RPC signatures, gate order, error codes

WITHIN DESIGN across all three RPCs.

### §4.2 `save_store_count_layout(p_store_id uuid, p_name text, p_item_ids jsonb, p_layout_id uuid default null) returns uuid`
Signature ✓ (:201–207). Body order matches §4.2 cheapest-fail-first:
1. null caller → `42501 'forbidden'` ✓ (:220–222)
2. `not auth_is_privileged()` → `42501 'forbidden'` ✓ (:226–228)
3. `not auth_can_see_store(p_store_id)` → `42501 'forbidden'` ✓ (:231–233)
4. trim + validate name (`< 1` → `'layout name required'`; `> 60` → `'layout name
   too long'`), validate item_ids array → `'item_ids must be an array'` ✓ (:236–245)
5. OVERWRITE branch: `update ... set name, item_ids, updated_at = now() where id =
   p_layout_id and store_id = p_store_id`; not-found → `P0002 'layout not found'`;
   position untouched ✓ (:249–261)
6. CREATE branch: `pg_advisory_xact_lock(hashtext('store_count_layouts:' ||
   p_store_id::text))` then lowest-free-slot via `generate_series(1,3)`; none free →
   `P0001 'layout limit reached'`; else insert with `created_by = auth.uid()` ✓
   (:270–286)

`security definer set search_path = public, auth` ✓ (:209–210). `revoke execute ...
from public, anon; grant execute ... to authenticated;` ✓ (:290–291).

### §4.3 `rename_store_count_layout(p_layout_id uuid, p_name text) returns uuid`
Signature ✓ (:296–299). Resolves `store_id` from the row first (→ `P0002` if
absent), then role+store gate, then trim+validate name, `update ... set name,
updated_at`; item_ids untouched ✓ (:310–346). Grants ✓ (:350–351).

### §4.4 `delete_store_count_layout(p_layout_id uuid) returns uuid`
Signature ✓ (:359–361). Resolve store (→ `P0002`), role+store gate, delete, return
deleted id ✓ (:367–394). Grants ✓ (:398–399).

Error-mapping (P0001→400 / 42501→403 / P0002→404) matches `demote_profile_to_user`
convention; all refusal strings byte-identical to §4 (verified: `'forbidden'`,
`'layout name required'`, `'layout name too long'`, `'item_ids must be an array'`,
`'layout limit reached'`, `'layout not found'`).

**Within-design delta (tighter, not divergent):** step-4 item_ids check is written
`jsonb_typeof(coalesce(p_item_ids, 'null'::jsonb)) is distinct from 'array'`
(:243) rather than the design's bare `jsonb_typeof(p_item_ids) = 'array'`. This is
a defensive superset — it additionally rejects a SQL-NULL `p_item_ids` with the
same `P0001 'item_ids must be an array'` instead of letting NULL slip past the `=`
comparison (which returns NULL, not true) into the insert. Same error code, same
message, stricter input domain. WITHIN DESIGN. Likewise name validation coalesces
`p_name` to `''` before trim (:236) — NULL name → `'layout name required'`, again a
superset of the design intent.

## §5 Edge function changes

WITHIN DESIGN. None. No edge function created or modified; no `verify_jwt`
decision. PostgREST + RLS + RPCs only. Confirmed no `staff-*`/service-token surface
touched.

## §6 `src/lib/db.ts` surface + camelCase mapping

WITHIN DESIGN.

- `StoreCountLayout` type: `{ id, name, itemIds: string[], position: number,
  updatedAt: string }` ✓ (db.ts:2366–2372) — exact shape.
- `mapStoreCountLayout` snake→camel: `item_ids → itemIds` (`?? []` defensive),
  `updated_at → updatedAt`, `position`/`name`/`id` passthrough ✓ (:2376–2390).
- `fetchStoreCountLayouts(storeId): Promise<StoreCountLayout[]>` — PostgREST
  `.select('id,name,item_ids,position,updated_at').eq('store_id', storeId)
  .order('position')`, `{ kind: 'read', label: 'fetchStoreCountLayouts' }` ✓
  (:2399–2412). Select list is exactly the §4.1 columns; ordered by position.
- `saveStoreCountLayout(storeId, name, itemIds, layoutId?)` → `rpc('save_store_count_layout',
  { p_store_id, p_name, p_item_ids, p_layout_id: layoutId ?? null })`, throws on
  error, `{ kind: 'write' }` ✓ (:2422–2440). RPC arg names are the snake_case `p_*`
  params ✓.
- `renameStoreCountLayout(layoutId, name)` → `rpc('rename_store_count_layout',
  { p_layout_id, p_name })` ✓ (:2446–2460).
- `deleteStoreCountLayout(layoutId)` → `rpc('delete_store_count_layout',
  { p_layout_id })` ✓ (:2468–2478).
- All four `track()`-wrapped with `.abortSignal(signal)`; the three writes labelled
  `kind: 'write'` ✓ — matches the `demoteProfileToUser` shape I cited.

**Staff carve-out** `src/screens/staff/lib/countLayouts.ts`: WITHIN DESIGN. Exports
`fetchStoreCountLayouts(storeId): Promise<StoreCountLayout[]>` via the documented
direct-`supabase.from('store_count_layouts')` carve-out (:59–75), re-exports
`applyCountOrder`/`firstUncounted` from `../../../lib/countOrder` (:38) so apply
logic is single-sourced, re-declares the same camelCase `StoreCountLayout` shape
locally (:43–49). **NO write helper** — no save/rename/delete in the staff subtree
(OQ-1). Plain `await`, no `track()`. Exactly the read-only shape §6 specified.

## §7 Realtime impact — the ABSENCE

WITHIN DESIGN. The migration makes ZERO `alter publication supabase_realtime add
table ...` change (grepped: no publication statement anywhere in the file). Header
comment (:49–54) documents the deliberate absence and that the `docker restart
supabase_realtime_imr-inventory` ritual does NOT apply. No `store-{id}`/`brand-{id}`
channel replays a layout mutation — as designed (OQ-5).

## §8 Frontend store impact

WITHIN DESIGN. No new Zustand slice — the four `useStore.ts` entries (:1984–2023)
are thin `notifyBackendError`-funneled I/O wrappers over the db.ts helpers,
return-value-or-null so the section runs optimistic-then-revert around the call
(same shape as `submitInventoryCount`). Layout list + selection live in
section-local `React.useState` on both screens (admin
`InventoryCountSection.tsx:199–206`; staff `WeeklyCount.tsx:219–222`). The
optimistic-then-revert + toast pattern is present in the admin `persistLayout` /
rename / delete handlers (:462–482, 524–533, 558–568). Staff surface is pick-only,
read on open keyed on `activeStore.id` (:325–346) — no write, no optimistic-revert.

## §9 Render-side reuse (spec-103 machinery — storage + trigger change ONLY)

WITHIN DESIGN — this was the sharpest thing to verify, and it is clean on both
surfaces.

- Both screens import `applyCountOrder, firstUncounted` from the SAME
  `src/lib/countOrder` source (admin directly at `InventoryCountSection.tsx:24`;
  staff transitively via the carve-out re-export). No fork.
- Picking a named layout on BOTH screens sets `savedIds := layout.itemIds` +
  `viewMode := 'custom'` (admin `onPickLayout` :417–424; staff :357–361) — the exact
  spec-103 lever. Picking Default sets `savedIds := null` → category-grouped
  (admin :411–415; staff :351–355).
- Render list is the unchanged `applyCountOrder(items, savedIds, (i) => i.id)`
  (admin :288, :589; staff :377, :700, :877). Gate-jump is the unchanged
  `firstUncounted(ordered, ...)` over the applied order (admin :595; staff :383,
  :883) — AC-11 gate-jump-follows-selected-order preserved.
- The admin drag list writes to `savedIds` ON SCREEN ONLY and persists solely on
  Save (`onReorder` :436–439, comment pins "writes nothing"; `persistLayout` reads
  `savedIds` back at Save time :453–464) — the §9 "explicit Save, not
  auto-save-on-drag" trigger change. No per-drag write remains on the admin surface.
- The ONLY things that changed below the render layer are (a) WHERE the id array
  comes from (a picked `store_count_layouts.item_ids` instead of a per-user
  `user_count_orders` row) and (b) WHEN it persists (explicit admin Save via RPC).
  Storage + trigger change only, exactly per §5/§9. Deleted-id tolerance is the
  unchanged `applyCountOrder` behavior — no new handling added.
- Staff drag removal: `CountOrderDragList` import + the spec-103 `onReorder`/
  `onResetOrder` write path are gone from `WeeklyCount.tsx` (grep: no
  `CountOrderDragList`, no save/rename/delete RPC). This is the intended OQ-1+OQ-2
  consequence, not a regression.

**No db.ts bypass on the admin surface:** grep for `supabase.from(`/`supabase.rpc(`
in `InventoryCountSection.tsx` returns nothing — all layout I/O routes through the
`useStore` actions → db.ts. The staff `supabase.rpc`/`supabase.from` hits in
`WeeklyCount.tsx` are the pre-existing spec-106 `user_count_drafts` /
`report_weekly_lowstock` / `ingredient_categories` carve-outs, NOT layout writes —
the staff layout read goes through `../lib/countLayouts`. Clean.

## §10 Rename slice (AC-1) — no backend surface

WITHIN DESIGN (backend lens). Purely i18n value edits per the Files-changed block;
no migration/RLS/RPC/db.ts change attributable to the rename. Nothing for a backend
reviewer to gate. (The string byte-match to the staff `weekly.title` is a
frontend/i18n concern — deferred to code-reviewer/test-engineer.)

## §11 pgTAP plan — every case pinned

WITHIN DESIGN. `plan(27)` (test:80) with exactly 27 `is/isnt/ok/throws_ok`
assertions (grep count = 27). Case-by-case against the §11 list:

- §11.1 create-within-cap + position=1 → cases (1)(2) ✓
- §11.2 round-trip + fill to 3 → (3)(4) ✓
- §11.3 4th create refused `P0001` → (5) ✓
- §11.4 overwrite: item_ids+name / position kept / count still 3 / updated_at
  advanced → (6)(7)(8)(9) ✓ (with the created_at back-date trick so the txn-fixed
  now() is provably later — correct handling of the txn-frozen-clock gotcha)
- §11.5 rename: name updates / item_ids unchanged → (10)(11) ✓
- §11.6 delete + slot reuse → (12)(13) ✓
- §11.7 staff SELECT-yes / RPC-42501 / direct-INSERT-42501 / direct-UPDATE-0rows /
  direct-DELETE-0rows → (14)(15)(16)(17)(18) ✓ — the AC-3b headline, both the RPC
  role gate AND the RLS defense-in-depth arm.
- §11.8 non-member 0 rows / RPC store-gate 42501 / seeded-then-still-0 →
  (19)(20)(21) ✓
- §11.9 privileged admin cross-store write succeeds → (22) ✓ (brand-wide admin
  visibility documented; holds because all seed stores are 2AM-brand — see Note 2)
- §11.10 name validation empty/61-char/whitespace → (23)(24)(25) ✓
- §11.11 structural cap CHECK 23514 → (26) ✓
- §11.12 AC-13 cleanup predicate (`'0/1'`) → (27) ✓

Fixtures are the design's specified seed profiles (A = `2222...` staff-role
stand-in role `'user'`; B = `1111...` admin), Store A = Frederick, Store-B-only =
Charles. `set local role authenticated` + `request.jwt.claims` injection, hermetic
`begin; ... rollback;`, no `set role anon` (segfault avoidance) — the shape §11
prescribed. The one design-noted concession (true concurrency race is out of
single-session pgTAP scope; atomicity asserted structurally via the unique index +
count logic) is honored as written.

## §12 Prod-apply note

WITHIN DESIGN (as a flagged step). The migration header (:56–62) and the spec's
Files-changed block (spec:1252–1259) both carry the "NOT body-only → broader
post-apply verification" note and flag the Supabase-MCP prod-apply + the exact
`schema_migrations` version insert for `db-migrations-applied.yml`. The developer
flagged it and did not push to prod. The §12 verification checklist (table/columns,
constraints/indexes, RLS policies, function signatures + SECURITY DEFINER +
search_path + EXECUTE grants, table grants, AC-13 DELETE landed, EOD count
captured-before) is present in the spec. **This is the release-coordinator's gate to
confirm executed before SHIP_READY** — the version to record is `20260706000000`
(see Note 1).

---

## Informational notes (NOT findings — for the release-coordinator)

**Note 1 — one stale `20260704000000` reference in the §12 prose.** Spec §12 body
(spec line 1057) still reads "the **exact migration version** (`20260704000000`) is
inserted into `supabase_migrations.schema_migrations`." Both the migration file
header (:64–69), the migration Files-changed VERSION NOTE (spec:1138–1141), the
handoff prose, and the prod-apply Files-changed note (spec:1256) correctly say
`20260706000000`. The `20260704000000` in §12 is a design-doc-authored stale string
(mine), not an implementation artifact — the migration is on disk as
`20260706000000` and there is no `20260704000000` layout artifact anywhere. No code
or migration change needed; the release-coordinator should just record
`20260706000000` in `schema_migrations` at prod-apply. Flagged only so nobody keys
off the wrong number. Not drift (the deliverable — the migration — is correctly
versioned).

**Note 2 — admin cross-store visibility is brand-scoped, and the test's (22)
assumption is sound.** The currently-effective `auth_can_see_store` on disk is the
brand-scoped `20260517040000` version (admin sees a store only if
`auth_can_see_brand(store.brand_id)`), NOT unconditional admin-sees-all. pgTAP case
(22) asserts admin B CAN write to Charles; this holds ONLY because every seed store
is in the 2AM brand (the test comments this, test:56–59, 425–428). The assertion is
correct for the seed, and the store gate composes as designed. Calling it out so a
future reviewer does not misread (22) as "admins bypass the store gate" — they do
not; they pass it via brand visibility. No action.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity (0 Critical /
  0 Should-fix / 0 Minor) — the implementation matches the ## Backend design §0–§12
  decision-for-decision: table shape + position-slot semantics + CHECKs + unique
  (store_id, position); the RPC trio's gate order (null/role/store) + advisory lock
  + P0001/42501/P0002 error codes and byte-identical refusal strings; the four RLS
  policies with exactly the designed auth_can_see_store / auth_is_privileged
  predicates + grants; the AC-13 bounded cleanup DELETE; NO supabase_realtime
  membership; the staff read-only carve-out; the §6 camelCase mapping + db.ts
  signatures; and the render-side reuse of the spec-103 applyCountOrder/firstUncounted
  path (storage + trigger change only). The migration-version correction to
  20260706000000 is ruled WITHIN DESIGN (20260704000000 and 20260705000000 are both
  taken in prod). Two informational notes for the release-coordinator: (1) record
  version 20260706000000 in schema_migrations — one stale 20260704000000 string
  survives in the §12 prose only, not in any artifact; (2) confirm the flagged
  Supabase-MCP prod-apply + §12 post-apply verification runs before SHIP_READY.
payload_paths:
  - specs/110-named-weekly-count-layouts/reviews/backend-architect.md

## Resolution note (main Claude — 2026-07-04)

No drift findings to action. Post-review, two reviewer fixes touched designed
artifacts — both hold the design's contracts: (1) SEC SF-1 moved the
`auth_is_privileged()` gate ahead of the row-resolve in rename/delete
(cheapest-fail-first preserved; store gate still runs against the resolved
store; error codes unchanged; save RPC untouched); (2) the Custom-view drag
gate now also covers category chips (render-side only — §5/§9's storage +
trigger contract unchanged). pgTAP grew to 30 assertions; local stack
re-applied and green (63/63).
