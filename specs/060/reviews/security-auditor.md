# Security audit for spec 060

Scope: new `public.compute_menu_capacity(uuid)` RPC migration
([supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)),
the `fetchMenuCapacity` wrapper in
[src/lib/db.ts:2741](../../../src/lib/db.ts), the `loadMenuCapacity`
slice in [src/store/useStore.ts:2390](../../../src/store/useStore.ts),
the `MenuCapacityBadge` /
`MenuImpactSection` components, and the pgTAP coverage at
[supabase/tests/compute_menu_capacity.test.sql](../../../supabase/tests/compute_menu_capacity.test.sql).

No edge function added; no new auth surface; no realtime publication
change; no third-party dependency added (clean `git status` on
`package.json` / `package-lock.json`).

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/tests/compute_menu_capacity.test.sql:42` — Plan is
  `plan(16)`, and there are 16 actual `select is/ok/isnt/throws_ok`
  assertions (counted). The migration design comment block at the top
  of the test file lists twelve numbered scenarios (1) through (12)
  including a `(12) Perf: < 100ms on the seed` item, but the file does
  **not contain** a perf assertion. This is a test-coverage gap, not a
  security finding (capacity perf is a DoS mitigation only at extreme
  prep-DAG depths, and the depth-5 cap is the load-bearing guardrail
  which IS exercised by assertion #8). Flagging here so test-engineer
  can see the cross-reference; not blocking from a security posture.

- `src/screens/cmd/sections/MenuImpactSection.tsx:482` — The
  `bindingCatalogName` field returned by the RPC is rendered through
  a React Native `<Text>` element. RN + react-native-web both
  escape text-node children automatically (no `dangerouslySetInnerHTML`
  surface), so a catalog name containing `<script>` or HTML entities
  cannot execute. Confirmed clean. Listed for completeness — the spec's
  audit question #6 about XSS surface is answered: ALL user-controlled
  strings in `MenuCapacityBadge` and `MenuImpactSection` flow through
  `<Text>` children (`row.bindingCatalogName`, `row.brandName`,
  `row.name`) or `numberOfLines={1}` `<Text>` cells, never through
  `dangerouslySetInnerHTML`, never as i18n keys (the `T()` calls embed
  values via `{ count }` interpolation into pre-defined i18n strings,
  not as keys).

### Audit checks performed

**1. RLS / authorization — PASS.**

The RPC declares `language plpgsql security invoker set search_path = public`
([20260524000000_compute_menu_capacity_rpc.sql:81-83](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)).
`security invoker` (NOT `security definer`) is correct — every read inside
the function runs as the caller, so the per-table RLS policies
(`store_member_read_inventory_items`, `auth_read_*` from P5) gate each
SELECT.

The `auth_can_see_store(p_store_id)` pre-flight is the FIRST statement
in the function body
([line 94-97](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)),
raising SQLSTATE `42501` BEFORE any CTE executes. Matches
`report_reorder_list` migration line 119 verbatim, which is the
canonical pattern referenced in the spec instructions.

`auth_can_see_store` itself (defined in
[20260517040000_auth_can_see_store_brand_scope.sql:88-108](../../../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql))
returns TRUE only for super-admins (all stores), brand-scoped admins
whose `brand_id` matches the target store's brand via
`auth_can_see_brand`, or users with an explicit `user_stores` row. No
escape hatch.

Grants:
[lines 315-318](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)
- `revoke execute on function public.compute_menu_capacity(uuid) from public, anon;`
- `grant execute on function public.compute_menu_capacity(uuid) to authenticated;`

This is the correct pattern (revoke from PUBLIC+anon then grant to
authenticated) — a bare `revoke from anon` would leave the function
callable via the PUBLIC default. The pgTAP `(10) anon: permission denied`
assertion exercises this with `set local role anon`
([compute_menu_capacity.test.sql:437-446](../../../supabase/tests/compute_menu_capacity.test.sql)).

The pgTAP foreign-store assertion `(9) RLS: foreign-store call raises
SQLSTATE 42501`
([compute_menu_capacity.test.sql:426-434](../../../supabase/tests/compute_menu_capacity.test.sql))
swaps the JWT to `manager_id` (whom the seed grants to Towson + Frederick
ONLY) and calls the RPC with the Charles store id. The expected SQLSTATE
`42501` from the `auth_can_see_store` raise gate is asserted with
`throws_ok`. Correct shape.

**2. SQL injection — PASS.**

`target_store_id` is declared as `uuid` at the function signature
([line 68](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)),
not text. Any non-UUID input is rejected by PostgREST before reaching
the function (PostgREST type-coerces RPC args; a malformed UUID returns
HTTP 400 from the gateway).

The recursive CTE references `p_store_id` ONLY as a bound parameter
(`ii.store_id = p_store_id` at line 215, `r.brand_id = (select s.brand_id
from public.stores s where s.id = p_store_id ...)` at line 269,
`select id as recipe_id` everywhere else). No string concatenation, no
`EXECUTE` dynamic SQL, no `quote_ident`/`quote_literal` round-trips. The
`#variable_conflict use_column` pragma is a name-resolution
directive, not an injection surface.

The pgTAP test file at line 426-434 uses `format($q$...select * from
public.compute_menu_capacity(%L::uuid)$q$, current_setting(...))` to
build the inner SQL for `throws_ok` — `%L` quotes correctly and the
input is a UUID-typed text from `set_config`. Test-only path; fine.

**3. Data exposure / cross-brand leak — PASS.**

The `all_recipes` CTE
([lines 264-272](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql))
filters `recipes.brand_id = (select stores.brand_id where id =
p_store_id)`. A caller whose JWT grants them stores in brands X and Y
calling the RPC with a store in brand X will get back ONLY brand-X
recipes — even if RLS were broader on `recipes`. The auth gate already
rejected the foreign-store case at the entry. Defence-in-depth
satisfied.

`binding_catalog_id` and `binding_catalog_name` are denormalized from
`catalog_ingredients` filtered by `recipe_lines.catalog_id` (the leaf
the recursive walk reached). Since `catalog_ingredients` is brand-scoped
and the RLS policies enforce per-brand visibility, no cross-brand leak.

**4. Recursive CTE DoS / depth control — PASS.**

The recursive arm at
[lines 142-156](../../../supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql)
includes both:

- `not (rp.sub_recipe_id = any (rp.visited))` — visited-array cycle
  guard. Same shape as `report_run_variance_multivendor:277` and
  `report_reorder_list:152`.
- `rp.depth < 5` — depth cap. Identical literal to the variance/reorder
  pattern.

The pgTAP `(8) cycle: makeable_qty reflects reachable leaves`
assertion seeds `prep_x → prep_y → prep_x` (a closed two-prep cycle)
and verifies the query terminates and produces a sane number. pgTAP's
30-second statement timeout would catch an actual loop — reaching the
assertion means no infinite recursion.

The depth-5 cap also bounds the worst-case row count from a fan-out
attack. Per the spec design's perf section: worst-case `breadth^5`
rows; with current real-world breadth (~7), `~16,800` rows in the
recursive table — well under any DoS threshold.

Attacker cannot force deeper recursion: depth is hardcoded at 5, no
caller-controlled parameter influences it.

**5. Realtime publication / subscription scoping — PASS.**

The spec adds NO tables to `supabase_realtime`. Verified via
`grep "alter publication supabase_realtime"` across the migrations
directory — only the existing 2026-05-07 and 2026-05-14 publication
migrations touch membership; the new 2026-05-24 migration is
function-only.

`recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items` are
NOT in the publication
([20260514140000_realtime_publication_tighten.sql:43-53](../../../supabase/migrations/20260514140000_realtime_publication_tighten.sql)).
This means mutations to those tables do NOT broadcast at all to ANY
subscriber. There is no leak path: a table that isn't in the publication
can't accidentally leak through the publication. The architect's design
called this out explicitly as the "acceptable gap" and the implementation
honors it.

The published tables the RPC reads from (`inventory_items`, `recipes`,
`prep_recipes`, `catalog_ingredients`) each carry their own RLS policies
restricting realtime row visibility to the caller's store/brand. The
client-side `useRealtimeSync` channel filters (`store-{id}` filtered
by `store_id`, `brand-{id}` filtered by `brand_id`) provide
defence-in-depth; the actual server-side RLS check is what gates row
delivery.

**6. Frontend XSS / template injection — PASS.**

`MenuCapacityBadge` ([line 1-175](../../../src/components/cmd/MenuCapacityBadge.tsx))
renders only:
- i18n strings from `T(...)` ([lines 49, 57, 69, 77, 106, 108-111](../../../src/components/cmd/MenuCapacityBadge.tsx))
- the integer `Math.floor(qty)` ([line 99](../../../src/components/cmd/MenuCapacityBadge.tsx))
- the constants `~` and `?` ([lines 100-101](../../../src/components/cmd/MenuCapacityBadge.tsx))

All values flow through React Native `<Text>` children, which escape
automatically. No `dangerouslySetInnerHTML`. The web-only `title`
attribute spread at line 122 carries an i18n string only (no
user-controlled data) — and HTML `title` is plain-text by the standard.

`MenuImpactSection` ([line 1-571](../../../src/screens/cmd/sections/MenuImpactSection.tsx))
renders `row.name`, `row.bindingCatalogName`, `row.brandName`,
`row.lowCount` — all as `<Text>` children at lines 482, 508, 522, 529.
Same escape posture as above. The `numberOfLines={1}` cells correctly
clip without exposing raw input.

A `bindingCatalogName` of `<script>alert(1)</script>` would render as the
literal string in the cell, not as executable HTML. Confirmed safe.

**7. i18n key injection — PASS.**

Every `T(...)` call site I inspected uses a literal string key
(`'component.menuCapacityBadge.canMake'`,
`'section.menuImpact.colMenuItem'`, etc.). The `{ count: displayQty }`
interpolation argument at line 106 of `MenuCapacityBadge.tsx` and
`{ filtered, total }` at line 200 of `MenuImpactSection.tsx` are
parameters to the i18n template, NOT keys. No
`T(\`section.${userControlledValue}\`)` pattern anywhere.

**8. OWASP Top 10 sweep — PASS.**

- A01 Broken Access Control: gated by `auth_can_see_store()` + `security
  invoker` + RLS on each underlying table. Foreign-store + anon both
  asserted in pgTAP.
- A02 Cryptographic Failures: N/A — no new secrets, no new crypto.
- A03 Injection: parameter-bound UUID, no dynamic SQL. Safe.
- A04 Insecure Design: capacity math is read-only; no mutate path. The
  "approx" `~` / `?` qualifiers correctly surface uncertainty to the
  user rather than silently misrepresenting it.
- A05 Misconfiguration: grants are explicit and least-privilege
  (revoke PUBLIC+anon, grant authenticated only).
- A06 Vulnerable Components: NO `package.json` change in this spec
  (verified `git status` and `git diff HEAD -- package.json` clean) —
  no `npm audit` required.
- A07 Identification & Authentication: caller identity flows from the
  Supabase JWT through `auth.uid()` inside the helper functions; no
  new auth surface to break.
- A08 Software & Data Integrity: migration is idempotent (`create or
  replace function`), no data backfill, no destructive operation.
- A09 Logging Failures: no new logging that exposes PII or secrets. The
  `notifyBackendError('Load menu capacity', e)` at
  `src/store/useStore.ts:2402` follows the existing pattern (toast +
  console.warn of a sanitized error message).
- A10 SSRF: N/A — no outbound network calls.

### Dependencies

No `package.json` changes — skipped (`git diff HEAD -- package.json
package-lock.json` is empty; no new packages, no version bumps).

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low.
  Both Lows are observational (a documentation-only test-coverage cross-
  reference re: the perf assertion the design comment promises but the
  test file omits, and a positive confirmation that the user-controlled
  catalog-name string is safely rendered via `<Text>` children). The
  RPC's `security invoker` + `auth_can_see_store()` pre-flight + UUID
  parameter typing + visited-array cycle guard + depth-5 cap + explicit
  `revoke from public, anon` + `grant to authenticated` mirror the
  canonical `report_reorder_list` pattern verbatim. The realtime
  publication is unchanged. The frontend renders all RPC-returned
  strings through React Native `<Text>` (auto-escaped) and uses i18n
  keys as literal strings (no key injection surface).
payload_paths:
  - specs/060/reviews/security-auditor.md
