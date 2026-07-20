# Security audit for spec 131

Scope: the unstaged working-tree changes implementing spec 131 (expose the
pending-PO order payload for the browser-extension cart-filler). Primary focus:
`supabase/migrations/20260723000000_extension_ordering.sql` (3 additive columns +
2 SECURITY INVOKER read RPCs). Also reviewed the `db.ts` / `useStore` / types /
builder threading and the frontend vendor/ingredient editor hunks.

Verdict: **no Critical, no High, no Medium findings.** The migration is correctly
RLS-bounded, grants are scoped, no secrets, no injection surface. Two Low
observations (both cross-spec / informational). Clean to advance from a security
standpoint.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260723000000_extension_ordering.sql:123-124`,
  `src/components/cmd/VendorFormDrawer.tsx` (orderPageUrl field) — `vendors.order_page_url`
  and `item_vendors.product_page_url` are stored free-form with no URL-scheme
  validation at the DB, `db.ts`, or editor layer. Inside THIS repo they are inert
  (a text field + a machine-facing payload; never rendered as a clickable link or
  navigated — confirmed: `VendorFormDrawer` only binds them to a text `Field`).
  The risk is downstream: the spec-132 extension does `new URL(order_page_url).origin`
  and navigates to it / to `product_page_url`. A privileged brand member could
  seed a `javascript:`-scheme or off-origin URL that a co-admin's extension later
  opens (phishing/redirect against a co-admin). This is a spec-132 navigation-safety
  concern, not a 131 backend defect — flag so spec 132 validates the scheme
  (allowlist `https:`, verify origin) before navigating. Not a blocker for 131.

- `supabase/migrations/20260723000000_extension_ordering.sql:149-181,203-265` —
  the two RPCs are granted to `authenticated` broadly (not admin/privileged-gated).
  This is **appropriate and NOT a finding to fix**: both are `SECURITY INVOKER`
  with `set search_path = public`, so they can return nothing the caller could not
  already `SELECT` directly from `purchase_orders` / `po_items` / `item_vendors` /
  `vendors` under their own RLS. A non-store-member (incl. a customer-PWA-authed
  user hitting the shared project) gets `[]` from RPC 1 and `42501`/`P0002` from
  RPC 2 because the base-table RLS (`auth_can_see_store` / `auth_can_see_brand`)
  yields no visible rows. Exposing order codes/qtys to any authenticated *store
  member* mirrors the existing access posture on those base tables — no new
  exposure, no privilege escalation. Recorded here only so the release-coordinator
  sees the admin-gating question was considered and resolved as "correctly scoped."

## What was verified (positive findings)

- **SECURITY INVOKER + explicit gate.** Both RPCs are `security invoker` with
  `set search_path = public` (prevents search-path hijack). RPC 1 relies purely on
  caller RLS; RPC 2 (`get_extension_order_payload`) additionally raises `P0002`
  (not found / RLS-hidden) and `42501` when `not auth_can_see_store(v_store_id)`
  BEFORE assembling the payload — belt-and-suspenders defense-in-depth. No
  cross-store/cross-brand read is possible: the vendor `join`, the `po_items` /
  `inventory_items` / `catalog_ingredients` / `item_vendors` joins all run under the
  caller's RLS, so an out-of-visibility PO returns null/empty, never another
  store's rows.
- **Base-table RLS confirmed store/brand-scoped, no `USING(true)`.**
  `purchase_orders` → `store_member_*` policies on `auth_can_see_store(store_id)`
  (`20260504173035_per_store_rls_hardening.sql:186-201`); `po_items` →
  `store_member_*` (same file); `item_vendors` → `store_member_*` via
  `auth_can_see_store(ii.store_id)` parent join (`20260630000000_item_vendors.sql:121-142`);
  `vendors` → `brand_member_read_vendors` (SELECT, `auth_can_see_brand`) +
  `privileged_update_vendors` (`auth_is_privileged() AND auth_can_see_brand`).
  `inventory_items` / `catalog_ingredients` RLS enabled. INVOKER is genuinely bounded.
- **New columns inherit RLS column-agnostically.** No policy added, so a
  non-privileged member cannot set `extension_ordering` / `order_page_url` (gated by
  `privileged_update_vendors`) or `product_page_url` (gated by the store_member
  item_vendors UPDATE policy) the instant the columns exist. Matches spec 115's
  `order_unit` posture. pgTAP coverage present
  (`vendors_role_access.test.sql` plan 13→21: admin CAN set, `user` CANNOT; new
  `extension_ordering.test.sql` plan 18 covers non-member RLS on both RPCs).
- **Grants scoped correctly.** Both RPCs: `revoke all ... from public, anon;
  grant execute ... to authenticated;` (lines 191-192, 276-277). `anon` cannot
  call — no unauthenticated surface. Mirrors the reorder-RPC pattern.
- **No SQL injection.** Both RPCs take typed `uuid` params bound directly; no
  `EXECUTE`, no string interpolation of user input. RPC 1 is `language sql`.
- **No permissive-policy pitfall.** No `CREATE POLICY` in this migration → no
  OR-composition risk, no spec-053 lint allowlist edit needed (stays green).
- **No secrets / service keys introduced.** No `service_role`, no new edge
  function, no `Deno.env`, no `EXPO_PUBLIC_*` addition. The extension (spec 132)
  authenticates as the admin via the public anon key + RLS (design D-5) — no
  service key reaches any client.
- **No PII/data-leak in logs or errors.** RPC errors surface only the PO id and
  store id in the raise message (`purchase order % not found`, `Not authorized for
  store %`) — ids the caller supplied or already targets; no row data, no SQL
  fragments, no stack traces.
- **No vendor-site fetch / stored credentials (AC-7).** The migration reads only
  I.M.R tables and the mark-ordered path is the pre-existing guarded
  `status draft→sent` PostgREST UPDATE. Nothing authenticates to, fetches from, or
  submits on `bjs.com` / `samsclub.com`.
- **db.ts / builder threading is benign.** snake↔camel mapping for the three new
  fields, coalesce-empty→NULL on writes, `?? '' / ?? false / ?? null` hydration.
  The `computePoQuickOrderLines` extraction preserves byte-identical text output.
  No new client-side security boundary, no `useRole()` misuse.

## Dependencies

No `package.json` changes in the working tree — `npm audit` skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low
  (both cross-spec/informational — order_page_url/product_page_url scheme
  validation deferred to spec 132's navigation code, and a positive note that the
  authenticated-not-admin RPC grant is correctly scoped because SECURITY INVOKER
  returns nothing the caller can't already SELECT). The migration's two INVOKER
  RPCs are correctly auth_can_see_store/auth_can_see_brand-bounded, grants revoke
  public/anon and grant authenticated, no permissive-policy pitfall, no injection,
  no secrets, no cross-store/cross-brand leak. Nothing blocks.
payload_paths:
  - specs/131-auto-deliver-order-artifact-on-po-create/reviews/security-auditor.md
