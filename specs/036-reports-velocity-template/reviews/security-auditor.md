# Security audit for spec 036 — Reports: Item velocity template

Scope reviewed:
- `supabase/migrations/20260515120000_report_run_velocity.sql` (new RPC + dispatcher re-create)
- `supabase/tests/report_run_velocity.test.sql` (new pgTAP, plan 11)
- `supabase/tests/reports_anon_revoke.test.sql` (plan 10 → 11)
- `src/components/cmd/NewReportModal.tsx` (union widening)
- `src/screens/cmd/sections/ReportsSection.tsx` (union widening)
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (union widening)
- `src/screens/cmd/sections/reports/templates.ts` (preview→live flip)

Comparison RPCs cross-walked for byte-equivalent security shape:
- `supabase/migrations/20260514180000_report_run_vendor.sql` (spec 035, byte-for-byte parallel called out by PM)
- `supabase/migrations/20260514170000_report_run_waste.sql` (spec 034)
- `supabase/migrations/20260511120000_report_run_cogs.sql` (spec 017, same POS data source)

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

None.

## Verified — RPC security posture (`report_run_velocity`)

Byte-for-byte equivalent to the spec 035 vendor runner and the spec 034 waste runner on every load-bearing security axis. Cross-referenced lines below.

- `supabase/migrations/20260515120000_report_run_velocity.sql:111-113` — `language plpgsql`, `security invoker`, `set search_path = public`. Matches vendor:103-105 and waste:67-69. Caller's RLS gates apply to every joined read on `pos_imports`, `pos_import_items`, and `recipes`. The `search_path` lock closes the `search_path`-manipulation attack vector flagged in 20260424211733_security_fixes.sql.
- `supabase/migrations/20260515120000_report_run_velocity.sql:132-137` — first statement is the auth gate: `if not public.auth_can_see_store(p_store_id) then raise exception ... using errcode = '42501';`. Mirrors vendor:124-127 and waste:88-92. Short-circuits before any cross-store read.
- `supabase/migrations/20260515120000_report_run_velocity.sql:434-435` — `revoke execute on function public.report_run_velocity(uuid, jsonb) from public, anon;` then `grant ... to authenticated;`. Closes the default PUBLIC→anon bypass; matches the spec 016 lockdown convention.
- `supabase/migrations/20260515120000_report_run_velocity.sql:485-486` — same revoke/grant repeated on the re-created dispatcher. Belt-and-suspenders so anon can't slip through the dispatcher route either. Mirrors vendor:514-515.
- The dispatcher (lines 444-483) preserves the existing `stub` / `cogs` / `variance` / `waste` / `vendor` arms verbatim from vendor:444-481 and only adds the new `when 'velocity'` arm immediately before the `else not_implemented` fallback — no behavioural drift on any other template.

## Verified — Data source RLS (defense in depth)

The `security invoker` posture means each joined read of `pos_imports`, `pos_import_items`, and `recipes` is independently filtered by the caller's RLS context, not just by the function's first-statement auth gate. Cross-walked against the actual RLS policies:

- `pos_imports` — `store_member_read_pos_imports` at `supabase/migrations/20260504173035_per_store_rls_hardening.sql:256-258` (`using (public.auth_can_see_store(store_id))`). Even if the `auth_can_see_store(p_store_id)` first-statement gate inside the RPC were bypassed, the RLS policy on the table would still block cross-store reads on the `where pi.store_id = p_store_id` filter.
- `pos_import_items` — `store_member_read_pos_import_items` at `supabase/migrations/20260504173035_per_store_rls_hardening.sql:276-284` (resolves through `pos_imports.store_id` via the `import_id` FK; same `auth_can_see_store` predicate). The join `pii.import_id = pi.id` is itself doubly filtered.
- `recipes` — `brand_member_read_recipes` at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:490-492` (`using (public.auth_can_see_brand(brand_id))`). The LEFT JOIN on `recipes` cannot leak a recipe row from another brand. If a `pos_import_items.recipe_id` were to point cross-brand (data drift scenario), RLS hides it and the velocity RPC coalesces to `'(deleted recipe)'` / `'(uncategorized)'` — the recipe identity is never exposed.

The `auth_can_see_store` helper at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:216-227` includes the super-admin short-circuit, so super-admin callers transit the auth gate and the data-source RLS uniformly with admin and store-member callers. No edge function `ADMIN_ROLES` Set parity check applies — this spec is RPC-only.

## Verified — Input validation (`p_params`)

- `by` is allow-listed (`supabase/migrations/20260515120000_report_run_velocity.sql:151-155`): explicit `if v_by not in ('recipe', 'category') then v_by := 'recipe';`. Unknown values silently coerce to the default (forward-compat). Used only in non-dynamic `if`/`else` branches — never interpolated into SQL.
- `from` / `to` are extracted via `p_params->>'from'` and `::date`-cast (lines 143-150). Malformed date strings raise native `22007`/`22008` from the Postgres date parser; the input never reaches a dynamic SQL string. The frontend sanitizes those raw SQLSTATE messages to `"Run failed — check server logs"` at `src/lib/db.ts:1923-1929` (only `Not authorized …` is allowed to surface — the rest are localized to `console.warn` and replaced).
- Range validation at lines 162-165: `if v_from > v_to then raise exception 'Velocity report: from > to (% > %)' using errcode = '22023'`. The error message echoes only the user-supplied dates, no schema fragments, no row data, no internal identifiers.
- `v_window_days := (v_to - v_from) + 1` (line 166). Because the prior `from > to` gate raised 22023, `v_to - v_from >= 0`, so `v_window_days >= 1` is invariant. Division by zero on the velocity formula `qty / v_window_days` (lines 322 and 364) is impossible by construction.
- No `EXECUTE`/dynamic SQL anywhere in the function body. All identifiers are literal; all values are parameter-bound through plpgsql. No SQLi surface.
- No file I/O, no URL fetch, no `pg_read_*` or COPY; SSRF/path-traversal not applicable.

## Verified — Information disclosure

- Orphan recipe handling (line 202, 297, 390): `coalesce(r.menu_item, '(deleted recipe)')` and `coalesce(nullif(trim(r.category), ''), '(uncategorized)')`. Both produce static literal labels, never reveal recipe-id internals or cross-brand recipe data (RLS on `recipes` already hides those rows).
- The `Top mover` KPI assembles `v_top_recipe || ' · $' || to_char(v_top_recipe_revenue, ...)` — purely from the RLS-filtered base CTE; no path that surfaces a recipe outside the caller's brand visibility.
- Error messages: `'Not authorized for store %'` and `'Velocity report: from > to (% > %)'` are intentionally narrow; neither leaks schema names, table names, column names, or row data. The frontend sanitizer at `src/lib/db.ts:1924` allowlists only the `Not authorized` raise for client persistence; every other Postgres error becomes the generic `"Run failed — check server logs"`. No raw stack traces reach the user.

## Verified — Test extensions

- `supabase/tests/reports_anon_revoke.test.sql` correctly bumps `plan(10)` → `plan(11)` at line 40 and inserts the new arm at lines 140-152 between the existing vendor arm and `report_reorder_list`. Comment block at lines 14-25 properly enumerates 11 RPCs covered. The arm uses the same `format(...$q$select public.report_run_velocity(...)$q$, ...) → '42501'` shape as the other arms — verifies anon's GRANT-time denial holds end-to-end via the `set local role anon` runner setup at lines 56-63.
- `supabase/tests/report_run_velocity.test.sql` plan 11 (line 34) includes the auth-gate arm (3) at lines 113-122 — manager calling Charles (non-member store) raises `42501`. This is the primary cross-store-leak regression gate at the function-body level (complementing the GRANT-time gate in `reports_anon_revoke`).
- The single-row formula arm (5), unmapped-row-exclude arm (6), and the load-bearing window-days denominator arm (8) all verify that the runner respects the `recipe_id IS NOT NULL AND recipe_mapped = true` filter and the `qty_sold / window_days` formula. None of these are themselves security assertions, but they verify the integrity of the data-shaping path the RLS layer protects.

## Verified — Realtime impact

No change. `pos_imports` and `pos_import_items` are not on the `supabase_realtime` publication (`supabase/migrations/20260514140000_realtime_publication_tighten.sql:43-53`). Spec 036 does not touch the publication, so no realtime-bypass surface is introduced. The realtime-publication-gotcha (docker restart needed after mid-session changes) does not apply here.

## Verified — Frontend changes

The four frontend edits are pure TypeScript union widening from `'reason' | 'vendor' | 'category' | 'item'` to `'reason' | 'vendor' | 'recipe' | 'category' | 'item'` plus one preview→live flip in the catalog tile and one `'recipe'` arm appended to the `BY_OPTIONS` registry. No new auth surface, no new fetch, no new storage of user-supplied data, no console logs of tokens or PII, no new error-message paths, no new client-side authorization decision. The `useRole()` placeholder is not consulted by any of these edits. The frontend never calls `report_run_velocity` directly — only through the existing `report_run` dispatcher path at `src/lib/db.ts:1907-1911`, which is already RLS-protected.

## Dependencies

`package.json` is unchanged in spec 036. `npm audit --audit-level=high` baseline: 1 high-severity vulnerability (`@xmldom/xmldom` via `jest-expo` → `jest-environment-jsdom` → `jsdom` → `http-proxy-agent` → `@tootallnate/once`), all in jest dev dependencies, not shipped to production or web runtime. Five moderate (`dompurify`, `postcss` via `expo` toolchain) and five low — also all dev-side. None introduced or made reachable by this spec. No remediation required for spec 036; the same baseline applied to spec 035 and prior. A general `npm audit fix` pass for the jest-side fix is a follow-up out of this spec's scope.

## Summary

Spec 036 is byte-for-byte equivalent to spec 035 (vendor) on every security-relevant axis: SECURITY INVOKER, locked search_path, first-statement `auth_can_see_store` gate raising 42501, explicit `revoke … from public, anon` followed by `grant … to authenticated` on both the new RPC and the re-created dispatcher, no dynamic SQL, no PII or schema leak in error messages, defense-in-depth RLS on every joined table, native date-parse errors sanitized by the existing `runReport` toast path. The anon-revoke test correctly extends to the new RPC with the matching shape. No critical, high, medium, or low findings.
