# Security audit for spec 127 — Ingredient photos (first Supabase Storage surface)

Scope: storage.objects write RLS, public-read exposure, upload helper trust
boundary, content-type/injection, secrets. Read-only review; no code mutated.

## Verdict

No Critical findings. The `storage.objects` write RLS is correct and fails
safe. Three Low observations below — all consciously-accepted-tradeoff or
platform-default confirmations, none block. Spec 127 is clear from a security
standpoint.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260721000000_ingredient_photos.sql:62-65` — the public
  SELECT policy (`using (bucket_id = 'ingredient-images')`, no `to` clause →
  applies to `anon`) grants not just per-URL viewing but **object LISTING** to
  anyone. Any unauthenticated caller of the shared Supabase project can
  `storage.from('ingredient-images').list()` and enumerate every object path
  across ALL brands — i.e. harvest the full set of `<brand_id>/<catalog_id>`
  UUID pairs and per-brand ingredient-photo counts. This is broader than the
  design's stated tradeoff ("a leaked object URL is viewable"; §0.1), which only
  contemplated URL-view, not cross-tenant enumeration. Impact is bounded: the
  leaked identifiers are opaque UUIDs with no PII, no pricing, and the actual
  tenant data stays behind `public.*` RLS; the images themselves are
  accepted-public food photos. But per the multi-tenant threat model ("do not
  assume callers of the same Supabase backend are friendly") the team should
  consciously accept the *enumeration* surface, not just the *view* surface.
  Fix if undesired: scope the SELECT policy to authenticated privileged brand
  members (mirror the write predicate) and rely on the `public = true` bucket's
  CDN endpoint for anon photo rendering — public buckets serve objects over the
  render/CDN path without an RLS SELECT grant, so anon `<Image src>` still works
  while the `list()` enumeration is closed. Not a blocker; record the decision.

- `supabase/migrations/20260721000000_ingredient_photos.sql:55-106` — the
  migration relies on `storage.objects` having RLS already enabled (Supabase
  platform default) but does not assert it. If a future project/branch ever had
  RLS disabled on `storage.objects`, these policies would be inert and writes
  would be ungated. Recommend the prod-apply verification step (design §13) add
  an explicit `select relrowsecurity from pg_class where oid =
  'storage.objects'::regclass` = true check alongside the four `policies_exist`
  assertions. Platform default makes this near-zero risk; flagged for the apply
  checklist only.

- `supabase/migrations/20260721000000_ingredient_photos.sql:76` (and the
  identical UPDATE/DELETE predicates) — `auth_can_see_brand((storage.foldername(
  name))[1]::uuid)` short-circuits to `true` for a **super_admin** even when the
  first path folder is NULL/absent (e.g. an object written at bucket root with
  no `<brand>/` prefix), because `auth_can_see_brand` returns
  `auth_is_super_admin() OR (...)`. Net effect: a super_admin could place an
  object outside the `<brand_id>/…` convention within this bucket. This is NOT a
  cross-brand escalation (super_admins see every brand by design) and NOT
  reachable by any admin/staff/customer caller (for a non-super_admin the NULL
  folder makes the `exists` arm false → deny; a malformed non-empty first
  segment raises on `::uuid` → deny, which is the desired fail-safe). Cosmetic
  path-hygiene only; no action required.

## Positives (confirmed, worth recording)

- **Write RLS is correct and complete.** INSERT carries `with check`, UPDATE
  carries BOTH `using` and `with check`, DELETE carries `using`, all four
  `bucket_id = 'ingredient-images'`-scoped and `to authenticated`
  (migration:69-106). A non-privileged authenticated caller (staff, customer
  PWA) fails `public.auth_is_privileged()`; a brand-A admin fails
  `auth_can_see_brand((foldername)[1])` for a `brandB/…` key. The UPDATE
  with-check closes the "upload then move cross-brand" vector. Confirmed
  (a)/(b)/(c)/(d) from the task all hold.
- **Fail-safe on malformed paths.** A non-super_admin with a bad first segment
  is denied (NULL → `exists` false; non-UUID text → `::uuid` raises → statement
  rejected). Deny-by-default, not allow.
- **Bucket-scoped, no cross-bucket leakage.** Every policy filters on
  `bucket_id`; this is the repo's first and only bucket, so the wide SELECT
  cannot broaden reads on any sibling bucket. Does not touch `public.*`, so the
  spec-053 permissive-lint probe correctly does not apply.
- **Column write is brand-RLS-governed.** `catalog_ingredients.image_path` is
  set via a plain `.update().eq('id', catalogId)`
  (`src/lib/db.ts:4866-4870`), gated by the pre-existing
  `privileged_update_catalog_ingredients` policy (`auth_is_privileged() AND
  auth_can_see_brand(brand_id)`, `20260509000000_multi_brand_schema_rls.sql:457`).
  No new table policy needed; confirmed.
- **Client-controlled path is not a trust boundary.** `uploadIngredientImage`
  builds `${brandId}/${catalogId}/${crypto.randomUUID()}.jpg`
  (`src/lib/db.ts:4858`) from client args, but the storage policy gates on the
  path's first folder and the column update gates on the row's real `brand_id` —
  a foreign `brandId`/`catalogId` is rejected by one of the two RLS layers, and
  the orphan-cleanup branch (`src/lib/db.ts:4871-4878`) removes the just-uploaded
  object if the column set is denied. No cross-brand write; no orphan leak of
  another tenant's data.
- **Content-type / payload hygiene.** Upload pins `contentType: 'image/jpeg'`
  (`src/lib/db.ts:4861`); bucket enforces `allowed_mime_types`
  {jpeg,webp,png} + 5 MB `file_size_limit` (migration:47-53); and
  `downscaleImage` re-encodes through a `<canvas>.toBlob('image/jpeg')`
  (`src/utils/downscaleImage.ts:73-75`), which discards the original file bytes
  and any EXIF-/container-borne payload — a genuine defense-in-depth plus. No
  dynamic SQL; all paths are bound params.
- **No secrets.** No service-role key, no service token, no third-party key in
  any changed file. The resolved public URL (`src/lib/ingredientImage.ts:23`) is
  a synchronous CDN string-build, non-sensitive. No token/PII in the two
  `console.warn` orphan-cleanup logs (`src/lib/db.ts:4875,4886,4926`).

## Dependencies

No `package.json` changes — `npm audit` skipped. (The upload path is pure
browser platform built-ins: `<input type=file>` + `createImageBitmap` +
`canvas.toBlob`; no new npm dependency introduced.)

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low. Storage write RLS is correct and fail-safe; the only items are an accepted-public-bucket cross-tenant list-enumeration note, an RLS-enabled apply-checklist assertion, and a benign super_admin root-path path-hygiene note. No blockers.
payload_paths:
  - specs/127-ingredient-photos/reviews/security-auditor.md
