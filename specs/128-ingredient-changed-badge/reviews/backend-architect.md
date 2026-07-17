# Backend-architect drift review — spec 128 (ingredient-changed "Updated" badge)

Mode: post-implementation drift review. Reviewed the STAGED implementation against the
`## Backend design` I authored in `specs/128-ingredient-changed-badge.md`.

Verdict: **No Critical or Should-fix drift.** The implementation is byte-consistent with the
design on every load-bearing point. Three Minor notes below. All six requested confirmation
points hold.

Files reviewed:
- `supabase/migrations/20260722000000_ingredient_changed_badge.sql`
- `supabase/tests/ingredient_changed_badge.test.sql`
- `src/screens/staff/lib/itemsUpdated.ts`
- `src/screens/staff/components/UpdatedBadge.tsx`
- `src/screens/staff/lib/types.ts`
- `src/screens/staff/screens/EODCount.tsx` (merge + render)
- `src/screens/staff/screens/WeeklyCount.tsx` (merge + render)
- `src/screens/staff/i18n/{en,es,zh-CN}.json`
- `src/types/index.ts` (to confirm it was NOT touched by 128)

---

## Requested confirmations

### (1) Migration `20260722000000` — CONFIRMED
- Columns match: `catalog_ingredients.image_changed_at` + `inventory_items.vendor_changed_at`,
  both `timestamptz`, nullable, no default, **no backfill** (correct rollout posture — existing
  rows stay NULL, nothing renders "updated" retroactively). Migration L37-40.
- Two `BEFORE UPDATE` row triggers with `IS DISTINCT FROM` guards on `image_path` / `vendor_id`
  respectively (L46-82). Matches design §1 verbatim.
- **SD-1 non-interference: confirmed.** The vendor trigger fires only on `public.inventory_items`
  and reads/writes only its own row's `vendor_id`/`vendor_changed_at`. It never touches
  `item_vendors`, so the "one writer owns both" `is_primary`-mirror invariant is undisturbed. The
  in-migration comment (L63-67) documents this. A cost-only / vendors-only edit that leaves the
  scalar `vendor_id` unchanged does not stamp.
- `eod_entries(item_id)` insurance index present (L42-44); `inventory_count_entries` already
  carries `(item_id, created_at)` from spec 019, so the union's other leg is covered.
- **Version ordering: correct.** `20260722000000` > `20260721000000` (spec 127), so 128 runs
  strictly after 127 both locally and in prod. No collision. The hard "127-before-128" dependency
  (128 references `catalog_ingredients.image_path`, added by 127's
  `20260721000000_ingredient_photos.sql`) is documented in the migration header (L19-22). I
  independently confirmed `image_path` is added by 127 and not before.

### (2) `staff_items_updated(uuid)` — CONFIRMED
- `language sql stable security invoker set search_path = public` (L101-104). Security-invoker
  is correct — reads under the caller's existing per-store / per-brand RLS; an RLS-invisible store
  returns an empty set with no explicit `42501` gate needed (design §2).
- `changed_at = greatest(image_changed_at, vendor_changed_at)` via `cross join lateral` (L114-116)
  — `greatest()` ignores NULLs and returns NULL only when both are NULL (photo-only / vendor-only /
  both / neither semantics preserved).
- `last_counted_at = max(submitted_at)` over the `union all` of submitted EOD
  (`eod_submissions ⨝ eod_entries`) and submitted weekly/any-time
  (`inventory_counts ⨝ inventory_count_entries`) for that `(store, item)` (L117-131).
- **Draft-excluded on both legs** (`status = 'submitted'`, L123 + L128).
- **Never-counted edge included:** `updated = changed_at IS NOT NULL AND (last_counted_at IS NULL
  OR changed_at > last_counted_at)` (L110-111) — a changed, never-counted item resolves `true`.
- Grants correct: `revoke execute ... from public, anon; grant execute ... to authenticated;`
  (L134-135). The `revoke from public` is the load-bearing step (anon inherits from PUBLIC),
  matching the project RPC template.

### (3) Derived / stateless clearing (no ack table) — CONFIRMED
The migration adds **no new table** — only two columns, one index, two trigger fns/triggers, and
one RPC. Clearing is purely derived at read time (`changed_at` vs `last_counted_at`); there is no
per-user or per-store "seen" state to persist or garbage-collect. A store counting the item is the
sole clear mechanism, exactly as designed. Matches AC "no acknowledge/dismiss control."

### (4) `updated?: boolean` on `EodItem` / `WeeklyItem` only — CONFIRMED
`src/screens/staff/lib/types.ts` L53 (`EodItem`) and L174 (`WeeklyItem`) each carry
`updated?: boolean`. `src/types/index.ts` `InventoryItem` was **not** given an `updated` field —
its git-Modified status is from spec 127's `imagePath` only (L122 / L170), which I verified
directly. Design §6 respected.

### (5) Frontend: best-effort fetch + per-screen merge + badge; banner deferred — CONFIRMED
- `fetchUpdatedItemIds(storeId): Promise<Set<string>>` (itemsUpdated.ts) matches the design
  signature exactly. It is **internally non-throwing** (try/catch → `notifyBackendError` +
  empty set), a slightly stronger guarantee than the design's call-site `.catch`.
- **EOD** (EODCount.tsx L422-436): `fetchUpdatedItemIds` added to the item-load `Promise.all`,
  `updated: updatedIds.has(it.id)` merged onto items before `setItems`.
- **Weekly** (WeeklyCount.tsx L289-297): fetched in parallel with a redundant-but-harmless
  `.catch(() => new Set())`, merged the same way.
- **Badge render:** EOD wraps the name in a new `itemNameRow` and renders
  `<UpdatedBadge testID={`eod-updated-badge-${item.id}`}/>` when `item.updated` (L740-752);
  Weekly adds the badge next to the existing LOW pill (L959-964). Info/teal tone, distinct from
  the amber LOW pill — no layout shift, composed by the name.
- **Banner: deferred (not dropped)** — no top-of-screen "N updated" banner in the implementation,
  matching design §0.5.

### (6) No realtime / publication change — CONFIRMED
The migration contains no `alter publication`. The two columns land on `catalog_ingredients` /
`inventory_items`, already in `supabase_realtime` (`FOR ALL TABLES`). The
`docker restart supabase_realtime_imr-inventory` gotcha does **not** apply. Staff has no realtime
in v1; the badge appears on next data load. Matches design §8.

---

## Minor findings (non-blocking)

- **M1 — i18n key path drift (cosmetic).** Design §7 named the key `chrome.updatedBadge`; the
  implementation uses `chrome.count.updatedBadge` (nested under `chrome.count`), referenced
  consistently in `UpdatedBadge.tsx` L29 and present in all three locale files at L339. No
  functional impact — the component and catalogs agree. Flagging only because the design text and
  code diverge on the literal key.

- **M2 — RPC inner join on `catalog_id` silently drops unlinked items.** `staff_items_updated`
  uses `join public.catalog_ingredients ci on ci.id = ii.catalog_id` (INNER, matching design §3).
  An `inventory_items` row with a NULL `catalog_id` produces no output row and therefore never
  shows a badge — even if its `vendor_changed_at` is set. Post-P3-lockdown / spec-104 every item
  is catalog-linked, so this is effectively unreachable in prod; noting it so a future
  legacy-data or partial-migration scenario doesn't silently suppress vendor-change badges. Not a
  change request — the INNER join matches the approved design.

- **M3 — best-effort posture is doubly-defended, asymmetrically.** EOD relies solely on the
  helper's internal try/catch (no call-site `.catch`), while Weekly adds a redundant
  `.catch(() => new Set())`. Both are safe because the helper is contractually non-throwing;
  the asymmetry is harmless but slightly inconsistent.

---

## Deploy / prod-apply note (for main Claude, not a code change)

Per project policy, `20260722000000_ingredient_changed_badge.sql` is applied to prod via Supabase
MCP `execute_sql`, then the exact version string `20260722000000` is inserted into
`supabase_migrations.schema_migrations` to keep the `db-migrations-applied` gate green. **This must
happen AFTER spec 127's `20260721000000` is applied to prod** (hard ordering dependency —
128 references `image_path`). pgTAP verification is local/CI; I confirmed the test fixtures are
schema-valid against the current prod-mirrored schema (`inventory_items.name`/`unit` were dropped
in P3-lockdown / spec-104, so the `inventory_items` fixture correctly omits them; `eod_submissions.vendor_id`
exists from `20260514120000`; `inventory_counts.kind` admits `'weekly'` from spec 098).

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Minor findings; all six
  requested confirmation points hold. Migration/RPC are byte-consistent with the approved design,
  frontend merge + badge + type additions match §6/§7, no ack table (stateless derived clearing),
  no realtime/publication change. Prod-apply via MCP must land AFTER spec 127 with a
  schema_migrations insert — pending main Claude.
payload_paths:
  - specs/128-ingredient-changed-badge/reviews/backend-architect.md
