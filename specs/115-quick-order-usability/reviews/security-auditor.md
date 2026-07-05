# Security audit for spec 115

Scope: per-vendor `order_unit` on `public.vendors` (W-2) + bulk CSV order-code
import write path (W-1) + reorder-card export (W-3) + stub removal (W-4) +
missing-code stat (W-5). Threat model: multi-tenant per-store RLS
(`auth_can_see_store`), brand-scoped vendors (`auth_can_see_brand`), admin-only
via `auth_is_privileged`. Sibling apps (staff, customer PWA) hit the same
Supabase project, so DB RLS is the tenant boundary against their users too.

All four verification asks were checked LIVE against the running local stack
(`supabase_db_imr-inventory`, psql -U postgres). Findings below.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

None.

---

## What was verified (evidence)

### 1. `order_unit` inherits `privileged_update_vendors` — proven LIVE

Live `pg_policies` on `public.vendors` (applied state, not the repo comment):

| cmd | policy | gate |
|-----|--------|------|
| SELECT | `brand_member_read_vendors` | `auth_can_see_brand(brand_id)` |
| INSERT | `privileged_insert_vendors` **OR** `Vendors admin only` | `auth_is_privileged() [AND auth_can_see_brand]` |
| UPDATE | `privileged_update_vendors` | `auth_is_privileged() AND auth_can_see_brand(brand_id)` (USING + WITH CHECK) |
| DELETE | `privileged_delete_vendors` | same as UPDATE |

`order_unit` is a plain column on this row-level-gated table, so it inherits the
UPDATE gate the instant it exists — no new policy needed (matches the architect's
OQ-4 finding; the `20260517010000` "UPDATE is denied" comment is stale). The
migration adds no policy hunk, so the spec-053 permissive-policy lint arm stays
green with no allowlist edit — a green lint here is expected, not a skipped test.

Independently reproduced on the live stack against the **2222 manager (role
`user`)**, whose `profiles.brand_id` is the seed brand `2a000000-…-0001`:

- `auth_is_privileged()` returns `f` (false) for the `user` JWT.
- The 2222 user **CAN SELECT** the brand vendor `023cba00-1b67-4218-a906-cb18a8e62964`
  (`count = 1` via `brand_member_read_vendors`) — confirms they have legitimate
  read on a brand/vendor they can see.
- The 2222 user's `UPDATE vendors SET order_unit='unit'` on that vendor affects
  **`UPDATE 0`** rows (the `privileged_update_vendors` USING clause filters the
  row) and the value stays `case` — the flip is **DENIED**, no error surfaced.
  This is the correct RLS no-op behavior (0 rows, value unchanged), exactly what
  `supabase/tests/vendors_role_access.test.sql` case (8) asserts.
- The **privileged admin (1111)** `UPDATE … SET order_unit='unit'` affects
  `UPDATE 1` — a privileged admin CAN set it, so the legitimate editor flow works.
- The **CHECK** `vendors_order_unit_check = CHECK (order_unit IN ('case','unit'))`
  rejects `'pallet'` with `23514` even for the admin — off-vocabulary is refused
  at the DB. The `VendorFormDrawer` control is a `SegmentField<'case'|'unit'>`
  whose value type is total, so the CHECK is a defense-in-depth backstop, not a
  user-reachable error path.

The pgTAP extension in `supabase/tests/vendors_role_access.test.sql:136-170`
(cases 7a/7b/8) proves privileged-CAN / non-privileged-CANNOT at the DB boundary,
making the stale `20260517010000` comment honest. Confirmed.

### 2. W-1 CSV order-code write path — no SQLi, no HTML sink, RLS-gated

- **No string interpolation into SQL.** Order codes are operator-entered free
  text. The write rides `commitImport` (`src/lib/csvImport.ts:409`) → the store's
  `addItem`/`updateItem` → db.ts `createInventoryItem`/`updateInventoryItem`,
  which use parameterized PostgREST `.insert()`/`.update()` (`item_vendors`
  upsert). Grepped every spec-115 changed file for `rpc(\`` / `from(\`` / `.raw(`
  / `EXECUTE` / template-literal SQL — **none found**. No dynamic SQL anywhere.
- **No HTML sink.** Grepped all changed `.ts/.tsx` for
  `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` /
  `document.write` / `WebView` / `srcDoc` — **none found**. The operator-entered
  code and the raw `vendor_name` (`codeRowsSkipped[].vendorName`, `res.name`) are
  rendered exclusively through RN `<Text>` with `T(...)` interpolation
  (`RunImportModal.tsx` code-preview row, `numberOfLines={1}`). The quick-order
  block is plain-text (TAB-delimited) to clipboard / share sheet, not HTML. No
  mail sink, no Resend `html:` field (this spec touches no edge function).
- **Write is RLS-gated and cannot cross stores.** `item_vendors`
  INSERT/UPDATE/DELETE are all gated LIVE by
  `EXISTS(… inventory_items ii WHERE ii.id = item_vendors.item_id AND
  auth_can_see_store(ii.store_id))` — transitive store scope. A CSV cannot write a
  code to another store's item. The `store_member_*_item_vendors` policies are
  unchanged from spec 114/102; W-1 adds no new RLS surface.
- **`vendor_name → vendorId` resolution is bounded to the RLS-scoped slice.**
  `resolveVendorForCode` (`csvImport.ts:161`) matches against
  `brandVendors = vendors.map(v => ({id, name}))` — the already-`brand_member_read_vendors`-scoped
  `vendors` store slice (`POSImportsSection.tsx:45`, `RunImportModal.tsx`). A
  resolved code can only ever target a vendor the caller can already see; an
  unmatched name is a reasoned skip (`{skip:'unmatched_vendor'}`), never a
  guessed write, and **a CSV cell never auto-creates a vendor** (AC-2 fail-safe).
- **Data-loss trap (architect §0) is closed and tested — not a code-only array.**
  `buildOrderCodeVendorsPayload` (`csvImport.ts:193`) resends the item's FULL
  existing link set with only the target `orderCode` changed and preserves each
  other link's `costPerUnit`/`casePrice`, so `updateInventoryItem`'s reconcile
  deletes nothing and zeroes nothing. A blank cell sends NO `vendors` key
  (omit-key-to-skip). `csvImport.test.ts:122-196` pins this (other links + costs
  preserved, blank no-op). This is a correctness/integrity guard the architect
  owns; from a security standpoint it is not an authz gap (the write was always
  RLS-scoped to the caller's own store) — noted here only to confirm it is not an
  under-policied exfil/destruction path.

### 3. Additive DDL only — no destructive change, no grant/policy/publication drift

`supabase/migrations/20260709000000_vendor_order_unit.sql` non-comment body is
exactly two statements: `ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS
order_unit text NOT NULL DEFAULT 'case' CHECK (order_unit IN ('case','unit'))`
and a `COMMENT ON COLUMN`. Grepped for `DROP` / `TRUNCATE` / `DELETE` / `GRANT` /
`REVOKE` / `ALTER PUBLICATION` / `CREATE POLICY` / `DROP POLICY` / `CREATE TYPE`
outside comments — **none**. Live checks:

- Column landed `text NOT NULL DEFAULT 'case'::text` with the two-value CHECK.
- `public.vendors` is **already** in `supabase_realtime` (confirmed live) — the
  migration adds no publication membership change, so the docker-restart gotcha
  does NOT apply (matches the architect's OQ-3 correction). No prod publication
  apply.
- Table-level grants on `public.vendors` extend to the new column automatically
  (combined with the spec-097 explicit-grants migration); no grant hunk, no leak.

Additive, non-destructive, reversible-by-design (`drop column order_unit`). The
CI assumption caveat (README's migration gate) does not bite here — there is
nothing destructive for a missing gate to fail to catch.

Note: the prod-apply is flagged in the migration header (execute_sql via Supabase
MCP + insert version `20260709000000` into `schema_migrations`). `db push` lacks
the prod password; the developer flags, does not push. Not a security finding —
an operator step. `db-migrations-applied.yml` will sit red until that row lands
(expected, resolves on apply).

### 4. No secrets, no new attack surface

- **No edge function** touched (confirmed — 115 is PostgREST-only). No
  `verify_jwt` change, no service-token surface, no `escapeHtml`/mail sink to
  audit, no last-of-role / self-guard surface (no deletion or role-change path).
- Grepped all changed files for `fetch(` / `Deno.env` / `service_role` /
  `SERVICE_ROLE` / `serviceToken` / `Bearer` / `EXPO_PUBLIC` — **none found**. No
  secret in code, config, log, or error message. No PII in the import-result
  toast (counts + a vendor name the operator themselves typed).
- The client-side `useRole()` placeholder is not used as a new security boundary
  anywhere in this spec (correctly, per CLAUDE.md).

## Dependencies

`package.json` unchanged for spec 115 (0 entries in the changed set;
`package-lock.json` also unchanged). `npm audit` skipped per process.

---

## Verdict

No Critical, High, Medium, or Low findings. The W-2 `order_unit` column correctly
inherits `privileged_update_vendors` — a non-privileged member CANNOT flip it
(proven live: `UPDATE 0`, value unchanged), a privileged admin CAN, and the CHECK
rejects off-vocabulary. The W-1 CSV write path is parameterized (no SQLi), renders
operator input only through RN `<Text>`/clipboard plain text (no HTML sink), and
is RLS-gated by the transitive `store_member_*_item_vendors` policies (a CSV
cannot cross stores; vendor resolution is bounded to the RLS-scoped `vendors`
slice and never auto-creates a vendor). The migration is additive-only with no
grant/policy/publication drift. Spec 115 is clear from a security standpoint.
