# Security audit for spec 151 — last-order context on count and ordering rows

Scope: the staged spec-151 surface only. The co-staged spec-150 files
(`App.tsx`, `src/components/cmd/TitleBar.tsx`, `src/lib/storeVisibility.ts`,
`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx`,
`src/store/useStore.ts` spec-150 hunks and their tests) were audited under
spec 150 and are excluded here.

Reviewed: `supabase/migrations/20260803000000_report_last_order_context.sql`,
`supabase/tests/report_last_order_context.test.sql`, `src/lib/db.ts`
(spec-151 hunks), `src/store/useStore.ts` (spec-151 hunks),
`src/types/index.ts`, `src/utils/lastOrderContext.ts`,
`src/screens/cmd/sections/ReorderSection.tsx`,
`src/screens/cmd/sections/phone/PhoneOrdering.tsx`, the three i18n catalogs.

Live verification was performed against the running local stack: the pgTAP
suite (32/32 assertions green, 0 failures), `pg_proc.prosecdef`, the function
grants, and a PostgREST-level probe of the AC-22 vendor bound as an
authenticated admin.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- `supabase/migrations/20260803000000_report_last_order_context.sql:78-82` —
  **the AC-22 vendor-list bound is bypassable with a multi-dimensional array.**
  The gate is `v_raw_n := coalesce(array_length(p_vendor_ids, 1), 0)`, which
  returns the length of the **first dimension only**, while the `unnest` on
  line 85 flattens **every** element into `v_ids`. A caller who posts a nested
  JSON array to `/rest/v1/rpc/report_last_order_context` gets a 2-D `uuid[]`
  whose dim-1 length is ≤ 100 and sails past the check.

  Verified end-to-end on the local stack as an authenticated admin (not
  theoretical):

  | request body `p_vendor_ids` | result |
  |---|---|
  | flat, 100 ids | `200` `{"vendors":[]}` (correct) |
  | flat, 101 ids | `400` `22023 invalid vendor list … got 101` (correct) |
  | nested, 2 × 5 000 = 10 000 ids | **`200`** — accepted |
  | nested, 2 × 50 000 = 100 000 ids | **`200`** — accepted (0.16 s) |

  And at the SQL level: `array_length(array[[a,b],[c,d]], 1) = 2` while
  `cardinality(...) = 4`.

  Impact is bounded, which is why this is Medium and not High: the caller must
  already pass `auth_can_see_store(p_store_id)`, **no additional data is
  exposed** (the output is still one anchor per real vendor, items capped at
  500), and per-request cost grows only with the array the attacker uploads.
  But this is exactly the "a hostile 10 000-element array … must be REFUSED,
  not silently collapsed" case the migration comment at lines 75-77 claims to
  handle, and it is the only input-validation control this RPC has.

  Fix (one word): `v_raw_n := coalesce(cardinality(p_vendor_ids), 0);` —
  `cardinality()` counts elements across all dimensions. Add a pgTAP case
  beside `(B1)` (`supabase/tests/report_last_order_context.test.sql:515`) that
  passes a nested literal, e.g. `array[[…51 ids…],[…51 ids…]]::uuid[]`, and
  asserts `22023`, so the regression can't come back.

### Low

- `src/store/useStore.ts:1047-1064` — `logout()` does not clear
  `lastOrderContext` (line 966 / 1588). Residue is in-memory only (nothing is
  persisted to localStorage/AsyncStorage), and it is reset to `null` by the
  `loadFromSupabase` block at line 1588 on the next sign-in's store load, so
  the exposure window is "shared device, logout, next user reaches the Ordering
  section before `loadFromSupabase` resolves". This matches the pre-existing
  treatment of `reorderPayload` / `orderSubmissions` and is not a regression
  introduced here — noted for parity, not as a required change. If it is
  cleaned up, do it for the whole reorder group in one pass, not just this
  slice.
- `supabase/migrations/20260803000000_report_last_order_context.sql:349-350` —
  the migration is strictly additive (one `create or replace function`, one
  `create index if not exists`; no `drop`, no column change, no policy change,
  no publication change — I re-read the whole file to confirm). The one
  operational caveat worth stating explicitly, because no CI gate checks
  migration *safety*: a non-concurrent `create index` inside the
  `begin;…commit;` takes a `SHARE` lock on `public.eod_entries` for the build,
  blocking staff EOD writes for its duration. `eod_entries` is called out in
  the design as the fastest-growing table in the schema. Apply off-peak, or
  check the prod row count first and use `create index concurrently` outside
  the transaction if it is large. Rollback is a clean
  `drop function public.report_last_order_context(uuid, uuid[], date);` with no
  coordinated FE deploy required.
- Deploy note (not a finding): `db-migrations-applied.yml` will be red between
  the commit and the MCP prod-apply of version `20260803000000`. Expected per
  the design §1.1; the release-coordinator must not treat a green `test.yml`
  alone as sufficient (CLAUDE.md CI rule).

### Verified clean (the checks this spec was routed for)

- **Invoker posture (R-5 / R-B) holds.** `security invoker` declared at
  migration line 57 and confirmed on the live DB (`prosecdef = false`, pinned
  by `(P5)`). One explicit `auth_can_see_store(p_store_id)` gate raising
  `42501` at lines 71-73, before any read; a null `p_store_id` is refused with
  `22023` at lines 67-69 ahead of even that. No `security definer`, no
  hand-rolled `current_setting('jwt…')`, no second copy of an authorization
  rule anywhere in the function.
- **No privilege escalation across the union.** Both places that touch
  `order_approvals` — the `oa_candidates` anchor CTE (lines 138-151) and the
  `ordered_lines` approval branch's re-read (lines 215-224) — run under the
  caller's own RLS, so the shipped
  `privileged_store_read_order_approvals` (`auth_is_privileged() and
  auth_can_see_store(store_id)`,
  `supabase/migrations/20260801000100_order_approvals.sql:244-246`) row-filters
  them to zero for a non-privileged store member. The correlated
  `source_submission_id` lookup at lines 184-186 is subject to the same policy
  (invisible row ⇒ NULL ⇒ falls through to the `bydate` identity match, not to
  a wider one). Pinned and **green live**: `(Z3)` a non-privileged store member
  gets the approvals-sourced vendor omitted entirely, `(Z4)` the same caller
  still resolves a `purchase_orders`-sourced anchor. Deliberately **no**
  top-level `auth_is_privileged()` gate — correct: adding one would refuse PO
  data the caller can already read directly via PostgREST.
- **Cross-store isolation.** `(Z1)` a store in a foreign brand and `(Z2)` a
  non-existent store both return the identical `42501` string — no existence
  oracle. Every source read is additionally pinned to `p_store_id` or joined
  through a row that is (`counted_sub`'s `direct.store_id = p_store_id`
  defense-in-depth at line 187). Client-side, `lastOrderContext` is reset to
  `null` on store switch (`src/store/useStore.ts:1588`), so a vendor shared
  across two stores cannot render store A's quantities on store B's lines.
- **No new RLS surface (AC-21).** Zero `create policy` / `alter table … enable
  row level security` / publication statements in the migration. The `(P1)`
  probe over all five source tables is green with **no** allowlist row added to
  `supabase/tests/permissive_policy_lint.test.sql`. The CLAUDE.md
  permissive-OR rule is N/A — nothing new to OR against.
- **Grants are least-privilege.** `revoke all … from public, anon` +
  `grant execute … to authenticated` (lines 332-335), byte-mirroring
  `create_order_approval`. Confirmed live: `(P2)` authenticated has EXECUTE,
  `(P3)` anon does not. No table grants touched, so the spec-097 grant lint is
  unaffected.
- **No injection surface.** Pure PL/pgSQL with a single static SQL statement —
  no `EXECUTE`, no string-built SQL, no `format()` into a query. All three
  parameters are typed (`uuid`, `uuid[]`, `date`) and bound; `p_as_of_date`
  only feeds a `<` comparison. The one JSON traversal
  (`jsonb_array_elements(oa.lines)`) guards the cast with
  `jsonb_typeof(l->'qty_base') = 'number'` and a non-empty `item_id` check
  (lines 222-223), so a hand-written prod row cannot crash it. Output is
  bounded: ≤ 500 items per vendor with `items_truncated` flagged (lines
  253-277).
- **No secrets, no PII leakage.** Grepped the whole spec-151 diff for JWT-shaped
  strings, `service_role`, API keys, and password tokens: none. No new
  `EXPO_PUBLIC_*` variable. The two new log lines (`src/lib/db.ts:4695` vendor
  count only; `src/store/useStore.ts:3876` the error message) carry no tokens,
  ids, or row data. The RPC's error strings are static contract text with no
  SQL fragment, stack trace, or foreign-store row content. `source_id` in the
  envelope is an in-store PO/approval id the caller can already read — not a
  leak.
- **Client path discipline (AC-24).** The only new `supabase.rpc` call site is
  `fetchLastOrderContext` inside `src/lib/db.ts:4683-4723`, wrapped in
  `useInflight.track` with `.abortSignal(signal)`; grepping
  `src/utils/lastOrderContext.ts`, `ReorderSection.tsx` and `PhoneOrdering.tsx`
  returns zero direct `supabase.from/rpc` calls, so the CLAUDE.md carve-out
  list is not extended. No edge function is added or modified — the
  `verify_jwt` / service-token, `ADMIN_ROLES ∋ super_admin`, `escapeHtml`,
  last-of-role and `caller.id != target.id` self-guard checks are all N/A here
  (this spec adds no destructive path and no HTML-rendering path). No use of
  the client-side `useRole()` as a security boundary.
- **Render layer.** React Native `<Text>` only; i18n templates are interpolated
  with server-supplied numbers/dates through `T(key, vars)` — no HTML sink, no
  `dangerouslySetInnerHTML`, no `Linking`/URL construction, no new tappable
  target.

### Dependencies

`package.json` unchanged in this spec — `npm audit` skipped.
