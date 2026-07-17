# Backend-architect drift review — Spec 127 (ingredient photos)

Reviewer: backend-architect (post-implementation drift mode)
Scope: staged implementation vs. the `## Backend design` I authored in
`specs/127-ingredient-photos.md`.
Verdict: **No Critical, no Should-fix. Ships as designed.** Five Minor
notes/confirmations below.

Prod apply (migration via MCP `execute_sql` + `schema_migrations` insert on
project `ebwnovzzkwhsdxkpyjka`) is still pending main Claude — flagged, not a
code finding.

---

## Checklist confirmation (all pass)

**(1) Migration `20260721000000_ingredient_photos.sql` — matches design.**
- `catalog_ingredients.image_path` — `add column if not exists ... text`, nullable, no default/backfill. ✓ (§40-42)
- PUBLIC bucket `ingredient-images` — idempotent `insert ... on conflict (id) do update`, `public=true`, `file_size_limit=5242880`, `allowed_mime_types` set. ✓ (§47-53)
- `storage.objects` policies — public SELECT `bucket_id='ingredient-images'`; INSERT/UPDATE/DELETE gate on `auth_is_privileged() AND auth_can_see_brand((storage.foldername(name))[1]::uuid)`; UPDATE gates BOTH USING and WITH CHECK. All four `drop policy if exists` → `create policy`, all bucket-scoped, INSERT/UPDATE/DELETE `to authenticated`. ✓ (§61-106)
- No `catalog_ingredients` policy change (the existing brand-scoped UPDATE policy from `20260509000000` governs the `image_path` write). ✓
- No realtime/publication change — column lands on an already-published table; migration does not touch `supabase_realtime`. Publication-restart gotcha correctly does NOT apply. ✓
- Version no collision — latest prior on disk is `20260720000000`; `20260721000000` is the next free slot. ✓

**(2) uuid-per-upload path scheme.** `` `${brandId}/${catalogId}/${crypto.randomUUID()}.jpg` `` in `uploadIngredientImage` (db.ts:4858). First folder = brand id → matches the policy's `foldername[1]::uuid` gate. Fresh uuid per upload → public URL changes on Replace → free cache-bust. ✓

**(3) db.ts helper sequencing (signature simplification accepted).**
- `uploadIngredientImage(catalogId, brandId, blob)` (db.ts:4837) — reads previous `image_path` internally, uploads under new uuid key, sets column, and on column-update failure best-effort removes the just-uploaded orphan before re-throwing; on success best-effort deletes the previous object. Sequencing is sound and matches the AC orphan-cleanup rule. ✓
- `removeIngredientImage(catalogId)` (db.ts:4900) — reads current path, NULLs the column FIRST (UI stays correct even if the object delete fails), then best-effort removes the object. Sound. ✓
- Both wrapped in `track({ kind: 'write' })`. ✓
- The internally-read-previous-path simplification vs. my §7 `previousPath`/`path` args is documented in the spec's reviewer note. Accepted — see Minor 1.

**(4) `image_path` projection completeness (split across two devs — verified consistent).**
- `fetchInventory` select embeds `image_path` (db.ts:242). ✓
- `mapItem` → `imagePath: cat.image_path ?? null` (db.ts:5273). ✓
- `fetchCatalogIngredients` → `imagePath: c.image_path ?? null` (db.ts:4771). ✓
- Staff EOD select + map (EODCount.tsx:148, :191). ✓
- Staff Weekly select + map (WeeklyCount.tsx:97, :131). ✓
- Types: `InventoryItem.imagePath` (types/index.ts:170), `CatalogIngredient.imagePath` (:122), staff `EodItem`/`WeeklyItem.imagePath` (staff/lib/types.ts:48, :164). ✓
The projection is complete and consistent across the admin `db.ts` path and the staff-subtree carve-out path.

**(5) `ingredientImage.ts` resolver.** `ingredientImageUrl(path)` returns `null` for null/empty, else `getPublicUrl(path).data.publicUrl` (synchronous, no network). Imported by both admin (`IngredientPhotoControl`) and staff (`IngredientThumb`). Pure resolver, no `from/rpc` traffic → consistent with the staff carve-out posture (same as `getLocalizedName`); NOT a carve-out violation. ✓

**(6) Frontend.** Canvas downscale with no new dep (`downscaleImage` — `createImageBitmap` + `<canvas>.toBlob`, Platform-web guarded); web-only photo control (`IngredientPhotoControl`, `Platform.OS==='web'` gate, native view-only; EDIT-mode-only render at IngredientForm.tsx:970 requiring `catalogId` + `currentStore.brandId`); `IngredientThumb` with fixed-box placeholder (no layout shift) composed into EOD/Weekly `leading` nodes. ✓

**MIME/size limit (defense-in-depth) — present.** Bucket sets `file_size_limit=5242880` (5 MB) and `allowed_mime_types=['image/jpeg','image/webp','image/png']`. pgTAP asserts the JPEG allowlist entry (test §6). ✓

---

## Minor notes (no action required to ship)

**Minor 1 — helper signature simplification adds a read round-trip.**
`uploadIngredientImage`/`removeIngredientImage` now issue an extra
`select image_path` to discover the previous/current object, rather than
taking it as an arg. The store already holds `imagePath` in memory, so the
read is redundant latency-wise — but it is authoritative (reads the committed
value, not a possibly-stale store mirror), which is the more robust choice for
a low-frequency admin write. Accepted deviation from design §7; documented in
the spec reviewer note. No change needed.

**Minor 2 — upload store action is post-hoc, not optimistic (correct).**
Design §9 said "optimistically set the new `imagePath`." The shipped
`uploadIngredientImage` store action (useStore.ts:1589) patches `imagePath`
only on success, because the object path is server-generated (uuid) and cannot
be known before the call resolves. This is the correct call and is documented
inline. `removeIngredientImage` (useStore.ts:1611) DOES use optimistic-then-
revert with `notifyBackendError`, as designed. Both patch the catalog row AND
every joined `inventory` row so all brand stores' in-memory items update. ✓

**Minor 3 — client-supplied `brandId` in the path is not cross-checked against
the catalog row's `brand_id`, but RLS backstops it.** The upload path's first
folder is `currentStore.brandId` (client-supplied), not validated server-side
against `catalog_ingredients.brand_id`. Worst case: a brand-A admin could upload
an object under `brandA/<catalogId-of-brandB>/...` (storage INSERT passes — they
can see brandA), but the subsequent `catalog_ingredients` UPDATE on the brandB
row FAILS its brand-scoped policy, leaving only a harmless orphan under the
admin's own brand folder. No cross-brand write, no leak. Orphans are already an
accepted tradeoff (§15). No fix needed; noted for the security reviewer's
independent read.

**Minor 4 — pgTAP is structural (definition-string), not behavioral RLS
impersonation.** `ingredient_photos.test.sql` asserts column + bucket +
policy existence/`cmd`/`qual`/`with_check` shape (14 tests), not a live
brand-A-vs-brand-B INSERT under a simulated JWT. This is exactly the named
fallback in design §14/§15 (storage.objects impersonation is awkward in the
harness; runtime correctness rides on the already-tested `auth_can_see_brand`
/ `auth_is_privileged` helpers). Acceptable as designed; test-engineer owns
whether to push for the harder behavioral test.

**Minor 5 — public SELECT policy has no `to` clause → defaults to role
`public` (incl. anon).** Intended ("lets anon read"), bucket-scoped so it
cannot broaden any other bucket (this is the first bucket). Does not touch
`public.*`, so the spec-053 permissive-lint probe does not apply. Consistent
with design §2. No action.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 5 Minor
  (all accepted deviations / confirmations). Implementation matches the
  contract; migration/RLS/projection/realtime all as designed. Prod apply
  (migration via MCP + schema_migrations insert) remains pending for main Claude.
payload_paths:
  - specs/127-ingredient-photos/reviews/backend-architect.md
