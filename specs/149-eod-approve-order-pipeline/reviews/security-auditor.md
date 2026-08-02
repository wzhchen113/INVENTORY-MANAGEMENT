# Security audit for spec 149 — EOD → Approve & Order pipeline

Reviewed: 2026-08-02. Scope = the full `## Files changed` list (3 migrations, 1 new
edge function + 1 modified, `config.toml`, `db.ts`, `useStore.ts`, the phone
Approve Order screen + notification deep link, the vendor/store drawers, i18n,
the smoke script, 3 new pgTAP suites).

**Verdict: no Critical, no High. 2 Medium, 5 Low.** Nothing here blocks the spec
from advancing.

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

- `src/store/useStore.ts:61-67` and `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx:543-549` —
  **stored URLs are opened with no scheme allowlist.** `openExternalOrderUrl()`
  (webstaurant channel → `vendors.order_page_url`) and `openInNewContext()`
  (RE-OPEN LINK → `order_approvals.external_ref`) pass the string straight to
  `window.open(...)` / `Linking.openURL(...)`. Both sources are operator-writable
  under RLS, not server-minted: `external_ref` is a plain PostgREST column write
  via `advanceOrderApproval` (`src/lib/db.ts:2494-2521`) permitted by
  `privileged_store_update_order_approvals`
  (`supabase/migrations/20260801000100_order_approvals.sql:213-216`), and
  `order_page_url` is free text on the vendor drawer. This is the first code path
  in the repo that opens a stored, admin-editable URL — every prior
  `Linking.openURL` call site builds its own `tel:` string
  (`src/screens/cmd/sections/phone/PhoneVendorsList.tsx:45`). Impact: a
  same-store privileged account (or a mistyped/copy-pasted value) can plant a
  `javascript:`, `data:`, `file:` or custom-scheme URL that a *different* admin
  then taps — script execution in the web tab is browser-dependent, arbitrary
  app-deep-link invocation on native is not. `noopener,noreferrer` is correctly
  set and mitigates reverse-tabnabbing, but not the scheme. Fix: gate both
  helpers on `/^https?:\/\//i.test(url)` and toast/no-op otherwise; ideally also
  reject non-`http(s)` in `advanceOrderApproval`'s `externalRef` mapping and in
  `updateVendor`'s `order_page_url`.

- `supabase/migrations/20260801000100_order_approvals.sql:130-138` +
  `src/lib/db.ts:2509` + `supabase/functions/instacart-cart-link/index.ts:308-313` —
  **the server-resolved channel is client-overwritable while `pending`, and the
  edge function trusts the stored value.** AC-14 / §1.2 step 3 state "the client
  never supplies the channel" and `create_order_approval` correctly resolves it
  through `vendor_order_channel()`. But `tg_order_approvals_guard` only freezes
  `channel` once `status <> 'pending'`, `advanceOrderApproval` exposes
  `patch.channel` as a general-purpose field (needed for the OQ-2 fallback), and
  `instacart-cart-link`'s only channel check is `approval.channel !== 'instacart'`
  — it never re-derives the channel from the vendor. A privileged caller can
  therefore PATCH `channel='instacart'` onto a pending row for a vendor whose
  resolved channel is `extension`/`manual` and reach the mint path. Blast radius
  is genuinely small (the mint still requires a non-blank
  `vendors.instacart_retailer_key`, a `stores.postal_code`, and the retailer to
  serve that ZIP — index.ts:365-426), and the caller is already privileged for
  that store, so no data crosses a tenant boundary. But it defeats a control the
  design claims is server-side, and the R-3 precedence that keeps BJ's/Sam's on
  the tuned cart-filler is the thing being routed around. Fix (cheap): in the
  guard, allow a `pending`-row `channel` change only *downward*
  (`new.channel in ('extension','manual')`), or re-validate
  `new.channel = coalesce(public.vendor_order_channel(new.vendor_id), new.channel)`
  — the OQ-2 fallback only ever writes `extension`/`manual`
  (`src/store/useStore.ts` `runChannel`, fallback branch), so neither form breaks
  the shipped flow.

---

### Low

- `supabase/migrations/20260801000100_order_approvals.sql:254-266, 326-347` —
  `create_order_approval` gates the store and the caller's privilege, and resolves
  the vendor through the invoker-clipped `vendor_order_channel()`, but it never
  cross-checks that the vendor's brand matches the store's brand, nor that
  `p_submission_id` actually belongs to `(p_store_id, p_vendor_id)`. For a
  super_admin (who can see every brand) this permits an audit row that attributes
  an approval to an unrelated submission or an out-of-brand vendor. Audit-trail
  integrity only — no data disclosure. Consider a `select 1 from eod_submissions
  where id = p_submission_id and store_id = p_store_id` guard plus a brand match
  on the vendor.

- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx:346-357` +
  `src/store/useStore.ts` (`loadOrderApproval` catch, `approvalError = e?.message`) —
  the raw PostgREST/Postgres error message is rendered verbatim in-screen. Admin
  surface only, but it can surface SQLSTATE text, constraint names and column
  names to the client. Prefer a fixed i18n string with the raw text kept to
  `console.warn` (which the code already does).

- `supabase/migrations/20260801000200_order_ready_notification_type.sql:147-151`
  and `supabase/functions/submission-push-fanout/index.ts` (`isOrderReady`
  branch) — `notifications` is **brand**-scoped
  (`privileged_brand_read_notifications`, spec 120), not store-scoped, so an
  admin who can only `auth_can_see_store()` one store still receives the bell row
  and the web-push body for a sibling store, now carrying the **vendor name** in
  `body` in addition to the store name. Inherited scoping, marginally widened by
  this spec. The deep link itself is safe — `fetchEodSubmissionContext` is
  store-clipped and the cross-store interstitial (`PhoneApproveOrder.tsx:292-330`)
  refuses to render another store's payload. Flagged for awareness; tightening
  notification RLS to store scope is a separate spec.

- `supabase/functions/instacart-cart-link/index.ts:365-393` — `store.postal_code`
  is accepted and forwarded with no format validation. It is correctly
  `encodeURIComponent`'d into the retailers query (line 391-393) so there is no
  injection or SSRF (`INSTACART_IDP_BASE_URL` is env-only, never
  request-derived), but a garbage ZIP produces an upstream 4xx that surfaces as a
  generic `502 upstream_error`. A `^[A-Za-z0-9 -]{3,10}$` check with a distinct
  400 would be clearer. Same for `instacart_retailer_key`, which is only ever
  compared against the upstream set — never interpolated.

- `supabase/functions/instacart-cart-link/index.ts` (whole handler) — no
  per-caller rate limit on a function that makes up to two outbound third-party
  calls per request. Mitigated by `verify_jwt = true` + `requireAdminCaller()` +
  the live-link reuse short-circuit (lines 315-336) and the 10 s abort, so a
  privileged caller can burn upstream quota but not much else. Noting for the
  record, not asking for a fix in this spec.

---

### What I verified clean (the project-specific checklist)

- **`verify_jwt` declared.** `supabase/config.toml:466-474` pins
  `[functions.instacart-cart-link] verify_jwt = true` with rationale. Not a
  `staff-*` / `pwa-catalog` service-token function, so no bearer-token check is
  owed. `submission-push-fanout` keeps `verify_jwt = false` unchanged (its two
  edits are copy-only).
- **Role gate + `super_admin` parity.**
  `supabase/functions/instacart-cart-link/index.ts:140` —
  `new Set(["admin","master","super_admin"])`, checked in an inline
  `requireAdminCaller()` (lines 148-169) that mirrors
  `supabase/functions/delete-user/index.ts:19-47` including the stale-JWT
  `profiles.role` fallback. Inline, not `_shared/`. No spec-026/027 omission.
- **Store scope without trusting the body.** The request body is
  `{ approvalId }` only (index.ts:273-282, UUID-validated); every read on the
  request path (approval, vendor, store, write-back) uses the anon-key client
  carrying the caller's bearer (lines 151-153, 290-296, 341-350, 483-490), so RLS
  is the cross-store gate and a foreign `approvalId` collapses to an
  indistinguishable 404 before any upstream contact (lines 300-303). No
  service-role client exists in this function.
- **Secret handling (AC-22).** `INSTACART_IDP_API_KEY` is `Deno.env.get` only
  (index.ts:89), never in a response body, never in a log line — I grepped the
  whole tree: the only other mentions are a `config.toml` comment and env-var
  names in `scripts/smoke-instacart-cart-link.sh`. No `connect.instacart.com`
  fetch anywhere under `src/`. No `EXPO_PUBLIC_*` addition. No hardcoded JWT/key
  material in the diff. Log lines carry only `correlationId`, `approvalId`, HTTP
  status, upstream status, elapsed ms — not the minted URL, not the request body
  (lines 266-269, 301, 322-324, 402-408, 419-425, 454-475, 498-512).
- **Upstream error mapping.** 10 s `AbortController` (lines 100-101, 174-185) →
  504 `upstream_timeout`; non-2xx → 502 with `upstreamStatus` only (no upstream
  body echoed); a 2xx missing `products_link_url` is explicitly *not* a success
  (lines 463-475). Client side, `mintInstacartCartLink` (`src/lib/db.ts`) goes
  through `supabase.functions.invoke` (the documented `callEdgeFunction`
  exception) and reads `error.context.json()` — no bare `fetch`, no
  silent-fake-success (spec-031/032 regression closed).
- **`order_approvals` RLS (AC-21).** RLS enabled
  (`20260801000100_order_approvals.sql:197`); all three policies are conjunctions
  of `public.auth_is_privileged()` and `public.auth_can_see_store(store_id)`
  (lines 203-216), INSERT additionally pins `approved_by = auth.uid()`. **No
  DELETE policy** ⇒ default-deny. No `USING (true)`, no
  `auth.uid() IS NOT NULL`, no OR-tail ⇒ spec-053
  `permissive_policy_lint` stays green with no allowlist row (the probe file is
  untouched in this diff, and `order_approvals.test.sql:337-358` re-asserts it
  locally). Brand-new table ⇒ no pre-existing permissive policy to OR against.
  `auth_is_privileged()` = admin OR super-admin
  (`20260509000000_multi_brand_schema_rls.sql:235-239`), so a store-linked staff
  `user` is correctly excluded — pinned by pgTAP arms R1/R2.
- **Status-transition guard (AC-20).** `tg_order_approvals_guard`
  (lines 97-173) enforces `pending→approved→ordered` + no-ops, freezes
  identity/provenance columns unconditionally, freezes the line snapshot once the
  row leaves `pending`, and freezes `external_ref` at `ordered`. All refusals use
  SQLSTATE `P0001` ⇒ HTTP 400. (See Medium #2 for the one column this leaves
  open.)
- **RPC input validation (AC-27).** `create_order_approval` validates array-ness,
  1..200 length, uuid-castable `item_id`, 1..200-char `item_name`, numeric
  `qty_base` in (0, 100000], numeric `cost_per_counted_unit` >= 0 — all before any
  write, all `22023` ⇒ 400 (lines 268-324). The edge function re-validates
  independently before any upstream call (index.ts:203-250: 1..100 lines, finite
  quantity in (0, 9999], 1..200-char name) and returns
  `400 invalid lines: <reason>` with no upstream contact. No dynamic SQL /
  `EXECUTE` anywhere in the three migrations, so no SQLi surface.
- **Function grants.** `vendor_order_channel` and `create_order_approval` revoke
  from `public, anon` and grant only `authenticated`;
  `eod_vendor_has_below_par`, `emit_order_ready`, `tg_notify_eod_submission`,
  `tg_order_approvals_guard` revoke EXECUTE from `public, anon, authenticated` —
  correct, because `20260618000000_public_grants_explicit.sql:205-206` default-grants
  future functions to all three roles. The SECURITY DEFINER / SECURITY INVOKER
  split matches the documented intent (invoker for the client-callable resolver
  and the create RPC; definer for the internal emit predicate/emitter).
- **`notifications.type` CHECK widening.** Additive drop-and-re-add preserving
  all eight legacy values (`20260801000200:41-46`) — same shape as specs 121/126.
  No destructive DDL anywhere in the three migrations (columns are
  `add column if not exists`, no drops, no backfill). No `supabase_realtime`
  publication change, so no realtime-visibility surprise: `order_approvals` is
  deliberately unpublished and cannot leak to a `store-{id}` subscriber.
- **Client call path (AC-25).** Verified no bare `fetch` to any function endpoint
  in the new code.
- **`useRole()`** is not used as a security boundary anywhere in the new code.
- **HTML/escapeHtml (AC-26).** JSON-only responses, no Resend/email surface —
  correctly N/A. Self-guard / last-of-role guards N/A: no role change, no
  deletion, no `auth.admin.*` call in this function.
- **i18n.** `en`/`es`/`zh-CN` additions carry no secrets, no keys, no PII, no
  internal hostnames. (`StoreFormDrawer.tsx` hardcodes the English "Postal code
  (optional)" label — an i18n gap for code-reviewer, not a security finding.)

---

### CI note (not a finding, but do not let it slide)

Per §10.5 and the "Blocker RESOLVED" section, the three `20260801*` migrations
are **local-only**. `db-migrations-applied.yml` will be red between commit and
the Supabase-MCP prod apply. That is expected and must be surfaced, not "fixed" —
and per CLAUDE.md the release-coordinator cannot recommend SHIP_READY while
either gate is red on `main`. Also: `scripts/smoke-instacart-cart-link.sh`
(AC-30) is **manual** — no CI runner exercises it, so the AC-23 (403) / AC-24
(404) / AC-15 (502-not-fake-success) assertions have no automated gate. The
implementer reports having run the equivalent checks locally against a stubbed
upstream; treat that as the evidence, not CI.

### Dependencies

No `package.json` / `package-lock.json` changes in this spec — `npm audit`
skipped.
