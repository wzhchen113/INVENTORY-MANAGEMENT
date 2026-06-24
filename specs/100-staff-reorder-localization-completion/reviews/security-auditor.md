# Security audit for spec 100

Scope: staff reorder (补货) screen localization completion. Changed surface is one
additive `create or replace` of an existing auth-gated RPC plus render-path /
i18n-catalog / type-mapper changes on the staff surface. No new table, no new
edge function, no `config.toml` / `verify_jwt` change, no new RLS policy, no
publication change, no `package.json` change.

## Verification performed (the four focus questions)

1. **Signature + ACL/grants preserved (no privilege change).** Confirmed.
   The function header is byte-identical to the prior on-disk definition:
   `report_reorder_list(p_store_id uuid, p_params jsonb default '{}'::jsonb)
   returns jsonb language plpgsql security invoker set search_path = public`
   (`supabase/migrations/20260623000000_reorder_list_i18n_names.sql:46-53`
   vs `supabase/migrations/20260602000000_reorder_suggested_cases.sql:65-...`).
   Because the signature is unchanged, `create or replace` preserves the
   existing `revoke … from public, anon` + `grant … to authenticated` ACL; the
   migration correctly ships NO grant/revoke statements
   (`20260623000000_reorder_list_i18n_names.sql:593-597`). No privilege widening.

2. **Security model intact.** Confirmed. `security invoker` is preserved
   (`:51`), `set search_path = public` is preserved (`:52`), and the
   `auth_can_see_store(p_store_id)` gate remains the first executable statement,
   raising `42501` on denial
   (`20260623000000_reorder_list_i18n_names.sql:63-67`). The staff fetch
   helper re-throws the PostgREST error so an out-of-store caller hits the
   error pane, not a silent blank (`src/screens/staff/lib/fetchReorder.ts:108`,
   header note `:25-29`). Per-store isolation unchanged.

3. **`i18n_names` is an already-SELECTable column — no new data exposure / RLS
   bypass.** Confirmed. The column was added `jsonb not null default '{}'` to
   `catalog_ingredients` in `20260517000000_user_data_i18n_names.sql:76`. The
   RPC surfaces it from the EXISTING `ci` join
   (`catalog_ingredients ci on ci.id = ioh.catalog_id`,
   `20260623000000_reorder_list_i18n_names.sql:402`) — no new join, no new
   table, no new scan. The row is already read under the caller's RLS; emitting
   one more column off a row the caller already sees adds zero exposure. A
   body-diff against the prior migration shows the change is exactly two
   additive hunks (`ci.i18n_names as i18n_names` in the `per_item` CTE; and the
   `'i18n_names', pif.i18n_names` key in the vendor-rollup `jsonb_build_object`)
   plus comments — no other logic touched, so no stale-body regression of the
   spec-087/088 math. `i18n_names` carries translated display names only, not
   PII or cross-store data.

4. **No injection / unsafe interpolation in render.** Confirmed. The mapper
   coalesces the value with `(it?.i18n_names ?? {}) as LocalizedNames`
   (`src/screens/staff/lib/fetchReorder.ts:78`). The render resolves names via
   the total, pure `getLocalizedName({ name: item.itemName, i18nNames:
   item.i18nNames }, locale)` (`src/screens/staff/screens/Reorder.tsx:199`,
   helper at `src/i18n/localizedName.ts:47-59`) which only ever returns a
   string. All output lands in React Native `<Text>` nodes via `t()`
   interpolation — there is no HTML serialization, no `dangerouslySetInnerHTML`,
   no Resend `html:` email path, and no SQL string-building (`i18n_names` is
   bound through the JSONB projection, never concatenated into `EXECUTE`).
   No XSS / SQLi / template-injection surface introduced.

Catalog parity for the three new keys (`reorder.source.eod`,
`reorder.unit.case`, `reorder.unit.cases`) is present in all three locales
(`src/screens/staff/i18n/{en,es,zh-CN}.json`) — not a security finding, noted
for completeness since the parity jest test is the guard.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
None.

### Dependencies
No `package.json` changes — `npm audit` skipped.

## Conclusion
This is a display/localization change with effectively zero added exposure
surface. The migration is additive and signature-stable (ACL preserved), the
auth gate and `security invoker` model are intact, `i18n_names` rides an
already-SELECTed column under existing RLS, and the render path is string-only
into React Native `<Text>` with no injection vector. No findings at any
severity.
