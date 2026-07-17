# Spec 127: Ingredient photos

Status: READY_FOR_REVIEW

## User story
As a store manager (admin), I want to attach one photo to each catalog ingredient so that staff counting inventory can visually identify the physical item instead of guessing from a name.

As a counting staff member, I want to see a thumbnail of each item next to its count row on the EOD and Weekly count screens so that I count the right physical product.

## Acceptance criteria

### Admin (Cmd editor, web-only)
- [ ] The Cmd ingredient editor (`src/components/cmd/IngredientForm.tsx` / `IngredientFormDrawer.tsx`) shows a photo control: current photo (or placeholder), plus **Upload**, **Replace**, and **Remove** actions.
- [ ] Upload uses a web `<input type="file">` picker (image files only); native builds do NOT render an upload control (view-only or hidden) — web-only for v1.
- [ ] On upload, the selected image is stored in Supabase Storage under the agreed brand-scoped path and `catalog_ingredients.image_path` is set to the stored object path. A subsequent load of the editor shows the uploaded photo.
- [ ] **Replace** overwrites/updates the stored object and the row's `image_path` still resolves to the new image after reload.
- [ ] **Remove** clears `catalog_ingredients.image_path` (and deletes/orphans the storage object per architect decision); the editor then shows the placeholder.
- [ ] The write helper lives in `src/lib/db.ts` and performs the storage upload + `image_path` update as one logical operation (upload, then set column; on column-set failure the partial upload is surfaced/cleaned per architect decision).
- [ ] A non-admin (or an admin of a different brand) cannot write an image for the ingredient: `storage.objects` policies reject INSERT/UPDATE/DELETE outside the caller's brand path, and the `catalog_ingredients` UPDATE respects existing brand RLS.

### Staff (count screens)
- [ ] EOD count rows (`src/screens/staff/screens/EODCount.tsx`) and Weekly count rows (`WeeklyCount.tsx`), both rendered via `src/screens/staff/components/ListRow.tsx`, display a thumbnail for the ingredient when a photo exists.
- [ ] The photo appears for **every store in the brand** (brand-level, not per-store): a photo set once shows on all stores' count screens.
- [ ] When an ingredient has no photo, the row shows a graceful placeholder (no broken-image, no layout shift).
- [ ] Staff have NO upload/replace/remove control — view-only.
- [ ] `image_path` (or the resolved URL) flows onto `InventoryItem` through the existing catalog→inventory join / `mapItem` path used for other catalog fields (e.g. `i18nNames`), so the staff count fetch surfaces it without a separate query per row.

## In scope
- One photo per catalog ingredient, at brand/catalog level (`catalog_ingredients`), shared across all brand stores.
- New `image_path` (or `image_url`) column on `catalog_ingredients` (architect chooses; see open questions — spec recommends `image_path`).
- First Supabase Storage bucket in the repo, with write RLS gating admins to their own brand's path.
- Admin upload/replace/remove in the Cmd ingredient editor (web-only).
- Staff view-only thumbnail on EOD + Weekly count rows via `ListRow.tsx`, with placeholder for no-photo.
- `db.ts` upload helper (storage upload + `image_path` set).
- Tests: pgTAP for storage-write RLS + column, jest for the editor photo control and the placeholder/thumbnail render logic. (Track selection per test-engineer; both tracks named because both the DB policy and UI change are testable.)

## Out of scope (explicitly)
- **Per-store photos.** Decided: brand-level only. A per-store override is a future spec.
- **Staff camera / staff upload in v1.** Staff are view-only; no capture, no mobile upload path.
- **Native (iOS/Android) admin upload.** Admin Cmd UI is desktop-web; upload uses the web file picker only. Native upload is a future spec.
- **Multi-image gallery / multiple photos per ingredient.** One photo per ingredient.
- **Photo on other surfaces** — reorder screens, admin inventory tables, PDFs/CSVs. Count screens (EOD + Weekly) only. (If the same `ListRow`/`InventoryItem` field trivially renders elsewhere with zero extra work, that is acceptable but not a requirement and not a target for this spec.)
- **Backfilling photos for existing ingredients.** No bulk import; photos are added one-by-one by admins going forward.
- **Image moderation / content scanning.**

## Open questions resolved (from the feature request — do NOT re-open)
- Q: Per-store or brand-level photo? → A: **Brand/catalog level** (`catalog_ingredients`), shared across all brand stores.
- Q: Who can upload? → A: **Admins only**, in the Cmd ingredient editor, web file picker. Staff view-only.
- Q: Where do staff see it? → A: **EOD + Weekly count rows** via `ListRow.tsx`.
- Q: Native admin upload? → A: **Out of scope**, web-only for v1.

## Open questions for the architect (genuinely open — decide in design doc)
1. **Storage bucket access model.** PUBLIC-read bucket (simplest: plain `<Image src>` via `getPublicUrl`; food photos are low-sensitivity) vs authenticated/signed-URL reads. **PM recommendation: public-read, WRITE gated by RLS.** Confirm and record the sensitivity call.
2. **Storage write RLS + path scheme.** Proposed path `<brand_id>/<catalog_id>.<ext>`. Define `storage.objects` policies so only `auth_is_privileged()` admins whose `auth_can_see_brand(<first path folder>)` is true can INSERT/UPDATE/DELETE; reads open (public) or authenticated per Q1. Confirm the first-folder = brand_id convention and how `<ext>` / content-type is constrained.
3. **DB column.** `catalog_ingredients.image_path` (store object path, resolve URL client-side) vs full `image_url`. **PM recommendation: store the path** (survives bucket/CDN changes). Confirm.
4. **Upload mechanics.** Web `<input type="file">` in RN-web Cmd editor. Decide: client-side canvas downscale/compression for cheap small thumbnails vs a simple file-size + type cap for v1. Decide how the `db.ts` helper sequences upload + `image_path` set (and cleanup on partial failure), and whether Replace reuses the same object key (overwrite) or writes a new key.
5. **Image → staff flow.** Confirm `image_path` rides the existing catalog→inventory join onto `InventoryItem` (same as `i18nNames` via `mapItem`), how the staff subtree resolves path→URL (given the staff-subtree `db.ts` carve-out), and the exact placeholder asset/component for no-photo.
6. **Native admin upload** — confirmed out of scope (web-only admin). Flagged only to confirm no native branch is expected in v1.

## Dependencies
- New migration: add image column to `catalog_ingredients` + create the Storage bucket + `storage.objects` RLS policies. (Prod apply via Supabase MCP per project policy; the migration must also land in prod's `schema_migrations` to keep the `db-migrations-applied` gate green.)
- RLS helpers already available: `auth_is_privileged()`, `auth_can_see_brand(brand_id)`, `auth_can_see_store()`.
- A new client dependency may be needed for the file input / image handling — architect to confirm whether the web `<input type="file">` + canvas path needs any package (repo currently has NO image-picker dep).
- Existing catalog→inventory join / `mapItem` hydration path in `db.ts`.
- `src/screens/staff/components/ListRow.tsx`, `EODCount.tsx`, `WeeklyCount.tsx`.
- `src/components/cmd/IngredientForm.tsx`, `IngredientFormDrawer.tsx`.

## Project-specific notes
- **Cmd UI section / legacy:** admin write path is the Cmd ingredient editor (`src/components/cmd/IngredientForm*.tsx`); no legacy surface. Staff read path is the staff subtree (peer to cmd/, spec 063).
- **Per-store or admin-global:** brand-level (shared across all brand stores), gated by `auth_can_see_brand`. Not admin-global, not per-store.
- **Realtime channels touched:** none required for v1. A photo change does not need to push live to counting staff; it appears on next data load. (If the architect wants live updates, `brand-{id}` is the channel and the realtime-publication gotcha applies — flagged as a risk, not a requirement.)
- **Storage:** FIRST use of Supabase Storage in the repo — greenfield bucket, no existing `storage.from`/image-picker usage. New bucket + `storage.objects` policies required.
- **Migrations needed:** yes — `catalog_ingredients` column + Storage bucket + `storage.objects` RLS.
- **Edge functions touched:** none expected (direct storage upload + PostgREST/RPC via `db.ts`). Architect to confirm no edge function is needed for the atomic upload+set.
- **Web/native scope:** admin upload is **web-only**; staff thumbnail render is **web + native** (staff app runs both).
- **Tests:** pgTAP (storage-write RLS + column presence), jest (editor photo control, placeholder/thumbnail render). Track routing per test-engineer.
- **app.json slug:** not touched. No build-identifier / push-cert change in this spec.

---

## Backend design

First Supabase Storage feature in the repo. Greenfield bucket + `storage.objects`
policies live IN the migration so they apply to prod via MCP the same way every
other migration does. No edge function — direct storage upload + PostgREST
UPDATE through `db.ts` is sufficient and avoids a cold-start on the upload path.

### 0. Open questions — resolved

1. **Bucket access model → PUBLIC-read bucket `ingredient-images`.** Confirmed.
   Reads are public (plain `<Image src={getPublicUrl(path)}>`, no signed-URL
   churn, CDN-cacheable). **Tradeoff, explicitly accepted:** anyone who obtains
   the object URL can view the image without auth. The path embeds two UUIDs
   (`<brand_id>/<catalog_id>/<uuid>.jpg`) so URLs are unguessable, but they are
   NOT secret — a leaked/shared URL is viewable. This is acceptable for
   ingredient food photos (low sensitivity, no PII, no pricing). **WRITES are
   fully RLS-gated** (see §2). If a future spec adds a sensitive image class,
   that class needs a *separate private bucket* with signed URLs — do not
   downgrade this bucket.
2. **Write RLS + path scheme → `<brand_id>/<catalog_id>/<uuid>.jpg`.** Confirmed.
   First folder = brand id, gated via `(storage.foldername(name))[1]::uuid`.
   See §2 for the verified policy shape. Content constrained to JPEG (client
   always transcodes to JPEG in §4); no server-side MIME allowlist in v1
   (bucket-level `allowed_mime_types` is set as defense-in-depth, see §1).
3. **DB column → `catalog_ingredients.image_path text` (nullable).** Confirmed.
   Store the object PATH, resolve the public URL client-side. Survives bucket/
   CDN renames; NULL = no photo. Not `image_url`.
4. **Upload mechanics → new-uuid-per-upload + client-side canvas downscale.**
   Confirmed. Cap longest edge ~800px, JPEG q≈0.8. New `<uuid>.jpg` key every
   upload → the public URL changes on replace → zero stale-CDN/browser-cache
   risk (no cache-control juggling). Old object best-effort deleted. Sequencing
   + orphan cleanup in §4.
5. **Image → staff flow → rides `mapItem` / the catalog embed** exactly like
   `i18nNames`. Path→URL resolved by a shared helper. See §5/§6.
6. **Native admin upload → out of scope.** Confirmed. The upload control is
   `Platform.OS === 'web'`-gated; native renders view-only (thumbnail + name),
   no picker. Staff thumbnail render is web + native (read path only).

### 1. Data model changes

**Migration:** `supabase/migrations/20260721000000_ingredient_photos.sql`
(verified no collision — latest on disk is `20260720000000_staff_reports_issue_notifications.sql`;
`20260721000000` is the next free slot). Additive, non-destructive.

The migration does three things:

**(a) Column** — additive:
```sql
alter table public.catalog_ingredients
  add column if not exists image_path text;
```
NULL = no photo. No default, no backfill (per spec: no bulk import).

**(b) Bucket row** — idempotent insert into `storage.buckets`:
```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ingredient-images', 'ingredient-images', true, 5242880,
        array['image/jpeg','image/webp','image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
```
`public = true` → CDN public-read. `file_size_limit` 5 MB is a backstop; the
client downscales to well under that. `allowed_mime_types` is defense-in-depth
(the client always sends JPEG). `on conflict do update` makes it safe to re-run
on both local and prod.

**(c) `storage.objects` policies** — see §2. Wrapped in `drop policy if exists`
then `create policy` so the whole migration is idempotent for the local+prod
double-apply.

**Indexes:** none. `image_path` is only ever read as a projected column on rows
already fetched by `catalog_ingredients.id` / `brand_id` (both already indexed);
never filtered/joined on. No new index warranted on the 286 KB seed.

**Rollout safety:** additive column + new bucket + new policies. No existing
policy on `catalog_ingredients` changes (the existing brand-scoped UPDATE policy
already governs the `image_path` write — see §2). Safe to apply to prod before
frontend ships (column reads as NULL; UI degrades to placeholder).

### 2. RLS impact

**`catalog_ingredients` (existing table) — NO policy change.** The `image_path`
UPDATE is a plain column update on an existing brand-scoped row; the existing
`catalog_ingredients` UPDATE policy (`auth_is_privileged() AND
auth_can_see_brand(brand_id)`, from `20260509000000_multi_brand_schema_rls.sql`)
already gates it. No new policy needed on the table.

**`storage.objects` (new policies, scoped to `bucket_id = 'ingredient-images'`).**
Verified against Supabase's storage schema: `storage.objects` has RLS enabled by
default; `storage.foldername(name)` returns a `text[]` of the path segments, so
`(storage.foldername(name))[1]` is the first folder = brand id. Policy names and
helpers:

| Policy name | Command | USING / WITH CHECK |
|---|---|---|
| `ingredient_images_public_read` | SELECT | `bucket_id = 'ingredient-images'` (public — bucket is public anyway; explicit SELECT policy documents intent and lets anon read via PostgREST/storage API) |
| `ingredient_images_admin_insert` | INSERT | WITH CHECK: `bucket_id = 'ingredient-images' AND auth_is_privileged() AND auth_can_see_brand((storage.foldername(name))[1]::uuid)` |
| `ingredient_images_admin_update` | UPDATE | USING **and** WITH CHECK: same predicate as insert (USING gates the old row's brand folder, WITH CHECK gates the new) |
| `ingredient_images_admin_delete` | DELETE | USING: same predicate |

Notes:
- All four are **permissive** but every one is `bucket_id`-scoped, so they cannot
  leak onto other buckets. The public SELECT is intentionally wide *within this
  bucket only* — it does not touch `public.*` so the spec-053 permissive-lint
  probe (which scans `public.*`) does not apply. Still, flagged for the
  security reviewer: confirm no other repo bucket exists that this SELECT could
  broaden (there is none — this is the first bucket).
- `auth_can_see_brand` is `security definer` and already `grant`ed to
  `authenticated, anon`, so it is callable from a `storage.objects` policy.
- The first-folder cast `::uuid` will raise on a malformed path; that is
  acceptable (a write with a non-UUID first segment is rejected, which is the
  desired deny). The client always constructs a valid `<brand_uuid>/...` path.

**Idempotency:** each policy is `drop policy if exists <name> on storage.objects;`
then `create policy ...`. Safe to re-run locally and via prod MCP.

**Verification the reviewer/test track should confirm:** a non-privileged user,
and a privileged user of brand B, both fail INSERT/UPDATE/DELETE for a
`brandA/...` key; a brand-A admin succeeds for a `brandA/...` key. SELECT works
for anon.

### 3. API contract

No RPC and no edge function. Two PostgREST/storage interactions, both wrapped in
`db.ts` helpers (§7):

- **Upload:** `supabase.storage.from('ingredient-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false })`. Errors: RLS denial → storage returns a 4xx with `{ error, message }`; surfaced through the helper's throw → `notifyBackendError`. `upsert:false` because every key is a fresh uuid.
- **Column set:** `supabase.from('catalog_ingredients').update({ image_path }).eq('id', catalogId)`. Errors: brand-RLS denial (42501) → thrown.
- **Delete (remove/replace-cleanup):** `supabase.storage.from('ingredient-images').remove([oldPath])`. Best-effort; a failed delete is logged, not surfaced as a hard error (orphan is harmless — see §4 risk).
- **Public URL resolve (read):** `supabase.storage.from('ingredient-images').getPublicUrl(path).data.publicUrl`. Pure, synchronous, no network.

### 4. Upload mechanics, sequencing, cleanup

**Downscale util** (new pure module, jest-tested): `src/utils/downscaleImage.ts`
```ts
// web-only (uses document/canvas). Longest edge capped at maxEdge, JPEG quality q.
export async function downscaleToJpegBlob(
  file: Blob, maxEdge = 800, quality = 0.8,
): Promise<Blob>
```
Loads the File into an `Image`/`createImageBitmap`, draws to a `<canvas>` scaled
so `max(w,h) <= maxEdge`, `canvas.toBlob(cb, 'image/jpeg', quality)`. No new npm
dependency — canvas + File API are web platform built-ins. (Confirmed: repo has
no image-picker dep and needs none; the `<input type="file">` + canvas path is
pure browser.)

**Upload sequencing** (in `uploadIngredientImage`, §7):
1. Generate `newPath = ` `${brandId}/${catalogId}/${uuid()}.jpg` (reuse the
   existing uuid util — staff has `src/screens/staff/lib/uuid`; admin side use
   `crypto.randomUUID()` which is available in the RN-web/browser target).
2. `storage.upload(newPath, blob)`. On failure → throw (nothing to clean up).
3. `update catalog_ingredients.image_path = newPath where id = catalogId`.
   **On failure → best-effort `storage.remove([newPath])` to avoid an orphan,
   then re-throw** the original column-update error. This is the
   "clean up the orphan" rule from AC.
4. On success, if there was a `previousPath` (Replace), best-effort
   `storage.remove([previousPath])`. A failed old-delete is swallowed (logged) —
   the row already points at the new object, so a stale old object is a harmless
   orphan, not a correctness bug.
5. Return `newPath` so the caller updates local store state.

**Remove** (`removeIngredientImage`): read/receive the current `image_path`,
`update ... set image_path = null`, then best-effort `storage.remove([path])`.
Column-clear first so that even if the delete fails the UI is correct; orphan is
harmless.

**Replace = Upload with a `previousPath` arg** — same helper, no separate key
reuse (new uuid every time → cache-bust for free, per §0.4).

### 5. `InventoryItem` / catalog embed — staff read flow

`image_path` rides the existing `catalog:catalog_ingredients(...)` embed and
`mapItem`, mirroring `i18nNames`:

- **`fetchInventory` select** (db.ts:242): add `image_path` to the
  `catalog:catalog_ingredients(...)` projection.
- **`mapItem`** (db.ts:5060): add `imagePath: cat.image_path ?? null` to the
  returned object (intersection type widened the same way `i18nNames` was —
  `InventoryItem & { i18nNames..., imagePath: string | null }` or just add
  `imagePath?` to the canonical `InventoryItem` type; see §8).
- **`fetchCatalogIngredients`** (db.ts:4750): add
  `imagePath: c.image_path ?? null` to the mapped `CatalogIngredient` (select is
  already `*`, so no projection change there).
- **Staff EOD fetch** (`EODCount.tsx` `fetchItemsForVendor`, line 147): add
  `image_path` to `catalog:catalog_ingredients(name, unit, case_qty, i18n_names)`
  → `(..., image_path)`; map `imagePath: c?.image_path ?? null` onto `EodItem`.
- **Staff Weekly fetch** (`WeeklyCount.tsx` `fetchAllItemsForStore`, line 96):
  same projection + map onto `WeeklyItem`.

The staff subtree keeps its verbatim-port carve-out (its selects live in the
screens, not `db.ts`) — this change is a minimal projection+map addition, not a
rewrite, consistent with the spec-063 carve-out.

### 6. Path → public URL helper

New tiny shared helper, importable from BOTH admin and staff subtrees (pure,
no store coupling, so it does not violate the staff carve-out — same posture as
`getLocalizedName`):

`src/lib/ingredientImage.ts`
```ts
import { supabase } from './supabase';
/** Resolve a stored ingredient-images object path to its public CDN URL.
 *  Returns null for a null/empty path so callers render the placeholder. */
export function ingredientImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from('ingredient-images').getPublicUrl(path).data.publicUrl;
}
```
Staff imports it relatively (`../../../lib/ingredientImage`) — it is a pure
resolver, no `supabase.from/rpc` traffic beyond the synchronous getPublicUrl, so
it is an acceptable staff-side import (mirrors how staff imports the shared
`LocalizedNames` type and `getLocalizedName`).

### 7. `src/lib/db.ts` surface (admin write path)

Two new exported helpers, wrapped in the existing `track()` pattern:

```ts
/** Upload a (pre-downscaled) JPEG blob for a catalog ingredient, set
 *  catalog_ingredients.image_path to the new object path, and best-effort
 *  delete the previous object. Returns the new stored path. On column-update
 *  failure the just-uploaded object is removed before re-throwing. */
export async function uploadIngredientImage(
  catalogId: string,
  brandId: string,
  blob: Blob,
  previousPath?: string | null,
): Promise<string>

/** Clear catalog_ingredients.image_path and best-effort delete the object. */
export async function removeIngredientImage(
  catalogId: string,
  path: string | null,
): Promise<void>
```
snake_case↔camelCase: the only column is `image_path` ↔ `imagePath`, handled in
the update payload and in `mapItem` / `fetchCatalogIngredients` (§5).

These are `kind: 'write'` in `track()`. Optimistic-then-revert applies at the
store layer (§9), not inside the helper — the helper throws on failure and the
store reverts + `notifyBackendError`s.

### 8. Types

- **`src/types/index.ts` `InventoryItem`:** add `imagePath?: string | null;`
  (JSDoc: brand-shared, hydrated from `catalog_ingredients.image_path` via
  `mapItem`; NULL = no photo). Adding it to the canonical type is cleaner than
  the intersection dance used for `i18nNames` — do it directly here.
- **`src/types/index.ts` `CatalogIngredient`:** add `imagePath?: string | null;`.
- **Staff `src/screens/staff/lib/types.ts`:** add `imagePath?: string | null;`
  to `EodItem` and `WeeklyItem` (JSDoc mirroring the `i18nNames` note).

### 9. Frontend store impact

`src/store/useStore.ts` — the catalog/inventory slice. The Cmd editor save path
already round-trips catalog fields; add a thin action or call the `db.ts`
helpers directly from the drawer's save handler and patch the in-memory item's
`imagePath`. Optimistic-then-revert (with `notifyBackendError`) applies:
optimistically set the new `imagePath` on the item in the store, call
`uploadIngredientImage`, and on throw revert to the prior `imagePath` and toast.
Because the write is brand-level (catalog), the update should reflect on all
brand stores' in-memory items on the next `fetchInventory` — the existing
brand-channel realtime replay covers this (see §11).

### 10. Admin editor UI (frontend-developer)

`IngredientForm.tsx` / `IngredientFormDrawer.tsx`: a "Photo" control block —
- Thumbnail preview of the current `imagePath` (via `ingredientImageUrl`), or a
  placeholder icon when null.
- **Upload / Replace:** `Platform.OS === 'web'` gated `<input type="file"
  accept="image/*">` (hidden input triggered by a styled button, the standard
  RN-web pattern). On pick: `downscaleToJpegBlob(file)` → `uploadIngredientImage`.
- **Remove:** calls `removeIngredientImage`, clears preview to placeholder.
- Native build: render the thumbnail/placeholder read-only, NO picker (guarded
  by `Platform.OS === 'web'`).
- New-ingredient (+NEW) mode: the row has no `catalogId` yet, so the photo
  control is disabled/hidden until the ingredient is saved once (upload needs a
  `catalogId` for the path). Flag this to the frontend dev — simplest is
  "save the ingredient first, then a photo control appears on edit."

### 11. Staff ListRow thumbnail + placeholder (frontend-developer)

`ListRow.tsx` currently takes `leading`/`trailing` ReactNodes. Rather than
threading image props through the primitive, the EOD/Weekly `renderRow`
callers compose the thumbnail INTO the `leading` node (an
`<Image source={{ uri }}>` + the existing name/unit `<View>` in a horizontal
row). Add a small `<IngredientThumb path={item.imagePath} />` staff component
under `src/screens/staff/components/` that:
- resolves `ingredientImageUrl(path)`,
- renders `<Image>` when non-null (fixed ~40×40, `T.radius`),
- renders a placeholder (a neutral surface square with an icon glyph — reuse an
  existing icon; no new asset needed) when null,
- never shifts layout between the two states (same fixed box).

This keeps `ListRow` generic (no new props) and confines the thumbnail to the
count screens (per the out-of-scope "count screens only" boundary).

### 12. Realtime impact

**None required.** `image_path` lives on `catalog_ingredients`, which is already
replayed by the existing `brand-{id}` channel — a photo change lands on the next
debounced reload for admin surfaces. Staff v1 does not use realtime (spec 062);
staff see the photo on their next fetch, which the AC explicitly accepts ("it
appears on next data load"). **The migration does NOT alter `supabase_realtime`
publication membership** (it only adds a column to an already-published table and
creates a new bucket/policies), so the `docker restart
supabase_realtime_imr-inventory` publication gotcha does **not** apply here.
No dev/deploy realtime step.

### 13. Prod apply

Per project policy, `db push` lacks the prod password: apply the migration SQL
via Supabase MCP `execute_sql` against project `ebwnovzzkwhsdxkpyjka`, then
insert the exact `20260721000000` version into
`supabase_migrations.schema_migrations` so the `db-migrations-applied` gate stays
green. The bucket insert + policies are idempotent (§1/§2) so a re-run is safe.
Verify: `storage.buckets` has the `ingredient-images` row (`public = true`); the
four `storage.objects` policies exist; `catalog_ingredients.image_path` column
present.

### 14. Test surface

- **pgTAP** (`supabase/tests/`): (a) column presence on `catalog_ingredients`;
  (b) bucket row exists and `public = true`; (c) **storage write-gate** — set
  `request.jwt.claims` for a brand-A privileged user and assert an INSERT into
  `storage.objects` with a `brandA/...` key succeeds while a `brandB/...` key
  and a non-privileged user are rejected (this exercises the
  `auth_can_see_brand((storage.foldername(name))[1])` predicate). If direct
  `storage.objects` INSERT under RLS proves impractical in the pgTAP harness,
  fall back to at least a `policies_exist` smoke on `storage.objects` for the
  four named policies + the column/bucket assertions. (test-engineer picks.)
- **jest:** (a) `downscaleToJpegBlob` util (mock canvas/`toBlob`, assert edge cap
  + JPEG type); (b) `uploadIngredientImage` — mock storage+PostgREST, assert
  sequencing (upload→update→delete-old) and the orphan-cleanup-on-column-failure
  branch; (c) `removeIngredientImage` clears column then deletes; (d)
  `IngredientThumb` renders `<Image>` when path set and the placeholder when
  null (no layout shift); (e) the admin editor photo control is web-gated.

### 15. Risks & tradeoffs

- **Public bucket = URL-is-viewable.** Accepted for food photos (§0.1). Guard
  against scope creep: a sensitive image class needs a separate private bucket.
- **Orphaned objects.** Best-effort deletes on Replace/Remove/column-fail mean a
  crash between steps can leave an orphan object. Harmless (public bucket, no PII,
  small JPEGs, storage cheap). No GC job in v1; a future sweep could reconcile
  `storage.objects` against non-null `image_path`s. Flagged, not blocking.
- **`::uuid` cast in the policy** raises on a malformed first segment → the write
  is denied (desired). The client never constructs a malformed path.
- **New-ingredient mode has no `catalogId`** → photo control deferred to edit
  (§10). Frontend dev must handle the disabled state.
- **pgTAP storage-RLS testability** — writing to `storage.objects` under a
  simulated JWT in the pgTAP harness may be awkward; the fallback smoke is
  named (§14).
- **Migration ordering** — additive, no dependency on any unshipped migration;
  `20260721000000` is strictly after the current head. Safe to apply to prod
  ahead of the frontend.
- **Native admin** — upload path is web-gated; a native admin build shows
  view-only. No native branch expected in v1 (§0.6).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend:
  author migration `20260721000000_ingredient_photos.sql` (column + idempotent
  bucket insert + four idempotent `storage.objects` policies), add
  `uploadIngredientImage`/`removeIngredientImage` to `src/lib/db.ts`, add the
  `image_path` projection to `fetchInventory`/`mapItem`/`fetchCatalogIngredients`,
  create `src/lib/ingredientImage.ts` and `src/utils/downscaleImage.ts`, widen
  the types (§8), and add the pgTAP surface (§14). Frontend: the web-gated photo
  control in `IngredientForm*.tsx` (§10), the `IngredientThumb` staff component +
  ListRow composition on EOD/Weekly (§11), the staff-fetch projection additions
  (§5), store optimistic-then-revert wiring (§9), and jest (§14). After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/127-ingredient-photos.md

## Files changed

Frontend implementation (this pass). Backend-owned files
(`src/lib/db.ts`, `src/lib/ingredientImage.ts`, `src/types/index.ts`,
`src/screens/staff/lib/types.ts`, the migration, and the pgTAP test) landed in
parallel and are NOT listed here — they are consumed, not modified.

New:
- `src/utils/downscaleImage.ts` — web-only canvas downscale/JPEG-transcode util (`downscaleImage`, `fitWithinMaxEdge`).
- `src/utils/downscaleImage.test.ts` — jest: aspect/no-upscale math, browser happy path, env guards.
- `src/components/cmd/IngredientPhotoControl.tsx` — admin photo control (web upload/replace/remove, native view-only).
- `src/components/cmd/IngredientPhotoControl.test.tsx` — jest: downscale→upload wiring, remove wiring, upload/replace/remove states.
- `src/screens/staff/components/IngredientThumb.tsx` — staff count-row thumbnail with graceful placeholder (no layout shift).
- `src/screens/staff/components/IngredientThumb.test.tsx` — jest: Image-vs-placeholder render, fixed-box invariant.

Modified:
- `src/components/cmd/IngredientForm.tsx` — new optional `item` prop; renders `IngredientPhotoControl` in EDIT mode when `catalogId` + brand are known.
- `src/components/cmd/IngredientFormDrawer.tsx` — passes `item` to both `IngredientForm` render sites.
- `src/store/useStore.ts` — `uploadIngredientImage` / `removeIngredientImage` store actions (optimistic-then-revert + `notifyBackendError`), patching `imagePath` on the catalog row + joined inventory rows.
- `src/screens/staff/screens/EODCount.tsx` — `image_path` added to the catalog projection + mapped to `imagePath`; `IngredientThumb` composed into the count-row `leading` node; leading-row styles.
- `src/screens/staff/screens/WeeklyCount.tsx` — same projection + map + thumbnail composition for the weekly full-store count rows.

### Verification
- `npx tsc --noEmit` — clean (exit 0).
- `npm run typecheck:test` — clean.
- `npx jest` — 117 suites / 1263 tests passing (includes the 3 new suites; the existing EOD/Weekly screen suites now render rows through `IngredientThumb`).
- Browser preview tools were not available in this environment, so tsc/jest are the gate. The staff thumbnail path would need a staff login to smoke manually.

### Note for reviewers (contract drift, resolved)
The backend simplified the `db.ts` helper signatures vs the spec §7 sketch:
`uploadIngredientImage(catalogId, brandId, blob)` reads the previous path
internally (no `previousPath` arg) and `removeIngredientImage(catalogId)` reads
the current path internally (no `path` arg). The store actions + photo control +
tests were aligned to the shipped backend signatures.
