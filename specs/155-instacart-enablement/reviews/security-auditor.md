# Security audit for spec 155 — Instacart channel enablement

Reviewed against the staged (uncommitted) tree. Scope: the spec-155 file list only;
`specs/156-export-order-recording.md` is a parallel spec doc and was ignored.

Files read in full or diffed:
`supabase/functions/instacart-cart-link/index.ts`, `scripts/smoke-instacart-cart-link.sh`,
`src/lib/db.ts`, `src/store/useStore.ts`, `src/utils/postalCode.ts`,
`src/components/cmd/StoreFormDrawer.tsx`, `src/screens/cmd/sections/BrandsSection.tsx`,
`src/screens/cmd/sections/phone/PhoneApproveOrder.tsx`, `src/i18n/{en,es,zh-CN}.json`,
plus the unchanged-but-load-bearing `supabase/config.toml:474`,
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:616-643`,
`src/hooks/useRole.ts`.

**Verdict: no Critical, no High. Nothing here blocks the spec from advancing.**

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/lib/db.ts:134` / `src/utils/postalCode.ts:38` — **`stores.postal_code` has no
  server-side validation or length bound; `parsePostalCode` is a client-only gate.**
  `db.updateStore` maps `postalCode || null` straight into a PostgREST PATCH, and the
  column has no `CHECK` (confirmed: no migration ships in this diff, and
  `20260801000000_vendor_order_channel.sql` declared it nullable text). Any privileged
  caller can PATCH `/rest/v1/stores` directly with arbitrary text and the UI validator
  never runs. Impact is genuinely bounded and I do not think it needs fixing now:
  the only server consumer is
  `supabase/functions/instacart-cart-link/index.ts:462-464`, which wraps the value in
  `encodeURIComponent()` before interpolating it into a GET query string — `/`, `?`,
  `&`, `#` are all escaped, so there is no path traversal, no query-parameter
  injection, and no SSRF (the host comes from `INSTACART_IDP_BASE_URL`, a server env
  var, never from the row). A pathological value (huge string, upstream 414) lands in
  the probe's local `try/catch` at `index.ts:512` and degrades to
  `advisory: 'retailers_probe_failed'`. Fix if you want defense in depth: a
  `check (postal_code is null or postal_code ~ '^\d{5}(-\d{4})?$')` on
  `public.stores`, in a future spec — not worth a prod-apply +
  `db-migrations-applied` cycle on its own (consistent with the OQ-4 ruling).

- `src/components/cmd/StoreFormDrawer.tsx:105-118` + `src/store/useStore.ts:3063-3071` —
  **an RLS 0-row PATCH still produces a "Saved store" success toast.** PostgREST
  returns 204 for an UPDATE that matches nothing, so `db.updateStore` resolves,
  `useStore.updateStore` resolves `true`, and the drawer toasts success before
  `onEditSaved` (`BrandsSection.tsx:1146-1160`) re-reads and snaps the row back. The
  architect designed this (§5.3/AC-7: the re-read is the reconciliation) and the row
  state does end up correct, so this is not a persistence bug — but the *toast* is
  briefly a fake success, which is the shape CLAUDE.md's spec-031/032 discipline is
  aimed at. Reachability is low: the drawer only opens from `StoresTab`, whose list is
  already RLS- and brand-filtered (`BrandsSection.tsx:1103-1106`), so a denied write
  requires a mid-session permission change. Noting it so it is a known accepted
  behavior rather than a surprise. A future tightening would be a
  `.select('id')`-returning PATCH in `db.updateStore` so a 0-row write is
  distinguishable — out of scope here.

- `src/screens/cmd/sections/BrandsSection.tsx:1156-1158` — the new `onEditSaved` error
  path surfaces a raw PostgREST error message into a toast (`text2: e?.message`) and
  into `console.warn`. PostgREST errors can carry SQL `detail`/`hint` fragments. This
  is a **byte-for-byte copy of the pre-existing mount-effect handler at
  `BrandsSection.tsx:1115-1118`**, the audience is a super-admin-gated surface, and no
  row data or credential material is involved — so it is consistency, not a new
  exposure. Flagged only because a future error-message-hygiene pass should catch both
  call sites together, not just the old one.

---

## Targeted verifications requested in the dispatch

**1. The demoted probe cannot leak the API key, the minted URL, the ZIP, or the
retailer key — re-verified line by line.** The backend half's assertion holds.

- Key: read once at `index.ts:99` via `Deno.env.get`, used only as an `Authorization`
  header value at `index.ts:470` (probe) and `index.ts:540` (mint). It appears in no
  log line, no response body, and no error path. The `not_configured` arm
  (`index.ts:434-437`) logs only the fact of absence.
- Every new/edited log line on the demoted path was checked individually:
  `:416` (blank key → `reason=blank_retailer_key`), `:452` (`advisory=no_postal_code`),
  `:480` (`advisory=retailers_probe_failed upstream=retailers upstreamStatus=<n>`),
  `:507` (`advisory=retailer_not_in_zip retailers=<n>`), `:514`
  (`advisory=retailers_probe_failed ... timeout=<bool>`). Each carries only
  `correlationId`, `approvalId`, an advisory token, an upstream HTTP status, a retailer
  *count*, and elapsed ms. **No ZIP, no `retailer_key`, no URL, no request body.**
- The single sharpest trap on this path was avoided correctly: `index.ts:512-517`
  catches `probeErr` and logs `timeout=${probeErr instanceof UpstreamTimeout}` rather
  than `probeErr.message`. A Deno `fetch` failure message routinely embeds the full
  request URL — which on this path contains `?postal_code=<ZIP>`. Interpolating the
  error would have been the ZIP leak; it does not happen. Do not "improve" this line
  by adding the message.
- Response bodies: the 200 gains only `advisory` (`index.ts:602`), one of three
  hard-coded server-side tokens — never caller-influenced, never derived from the ZIP
  or the key. `postalCode` on the 409 arm (`index.ts:423`) is pre-existing spec-149
  behavior and is only reachable after a successful caller-token read of that
  `stores` row, so it discloses nothing the caller cannot already `select`.
- Log discipline is asserted programmatically in the smoke at
  `scripts/smoke-instacart-cart-link.sh` (the `grep -qi 'instacart_idp_api_key\|Bearer '`
  body assertion is repeated in the new `assert_advisory` helper for all three
  advisory arms). Re-verified by reading, not by trusting the assertion.

**2. The blank-key 409 `reason` field adds no info leak.** `reason:'blank_retailer_key'`
(`index.ts:424`) reveals that `vendors.instacart_retailer_key` is blank. That arm is
only reachable after `requireAdminCaller()` passed *and* the caller-token read of the
`vendors` row returned a row (`index.ts:369-381`; an invisible vendor collapses into
the same 404 as an invisible approval). So the caller could already `select` the column
under RLS. No leak. `src/lib/db.ts` deliberately does not surface `reason` to the
client, and the `ok:false` result type is unchanged — correct, and it keeps the
AC-18 deploy-skew branch untouched.

**3. The widened `updateStore` cannot smuggle `brandId` — protection held.** Three
independent layers, all intact:
- `src/store/useStore.ts:3063-3070` names five fields explicitly; the drop-comment at
  `:3047-3056` is preserved and extended with "NAME every field explicitly, never
  spread `updates`". No spread was introduced.
- `src/lib/db.ts:116-134` — the `Pick<>` has no `brandId` member and `dbUpdates` is
  built key-by-key, so even a type-cast caller could not reach `brand_id`.
- Server: `privileged_update_stores`
  (`20260509000000_multi_brand_schema_rls.sql:627-636`) has a `WITH CHECK` of
  `auth_is_privileged() AND auth_can_see_brand(brand_id)`, so a brand transfer would be
  refused regardless. Unchanged by this spec.
- The only new writer, `StoreFormDrawer.tsx:105-110`, sends exactly
  `{ name, address, postalCode }`. The `brandId` prop is inert in edit mode.

**4. `postalCode` input is validated and trimmed client-side; server RLS unchanged.**
`parsePostalCode` (`src/utils/postalCode.ts:38-43`) trims, treats
blank/whitespace/`null`/`undefined` as an explicit `null` clear (never `''`), and
otherwise requires `^\d{5}(-\d{4})?$`. It is anchored on both ends, so no
`'21204; DROP'`-style tail is accepted. `StoreFormDrawer.tsx:92-96` refuses the save
and issues **zero** writes on `ok:false` — verified the `return` precedes
`setSubmitting(true)` and both branches. Every non-test writer of `postalCode` goes
through it (grepped: the drawer is the only one). Server side: no migration in the
diff (`git diff --cached --name-only supabase/` → the edge function only), no policy
edit, so `store_member_read_stores` / `privileged_update_stores` are byte-unchanged and
the spec-053 `permissive_policy_lint` allowlist correctly needs no new row. The
client-only nature of the validator is the Low finding above.

**5. The store-edit surface respects existing store RLS and is privileged-only
reachable.** `StoresTab` lives inside `BrandsSection`, which hard-returns on
`!isSuperAdmin` at `BrandsSection.tsx:150` (`useIsSuperAdmin()` reads live
`profiles.role`, `src/hooks/useRole.ts:24-26`). That is a UX gate, not the boundary —
the boundary is `privileged_update_stores` (`auth_is_privileged()` = admin OR master OR
super_admin, AND `auth_can_see_brand(brand_id)`), which is strictly *wider* than the
client gate. That direction is safe: the client shows less than the server allows, and
the edit surface adds no server-side capability that `db.updateStore` did not already
expose (the pre-existing ACTIVATE/DEACTIVATE toggle rides the same policy). The
`refresh()` list is RLS-scoped then brand-filtered (`BrandsSection.tsx:1103-1106`), so a
row from another tenant is never in the state that feeds `setEditStore`. No new code
uses the placeholder `useRole()` as a boundary.

**6. No new call sites outside the documented carve-outs.** Grepped every added `+`
line under `src/` for `supabase.from` / `supabase.rpc` / `supabase.functions` / bare
`fetch(` / `process.env` / `EXPO_PUBLIC` — zero hits. `mintInstacartCartLink` keeps its
`supabase.functions.invoke` transport under `useInflight.track` (the documented
CLAUDE.md exception), and the ZIP write goes through `db.updateStore`. No
`connect.instacart.com` reference exists anywhere under `src/` (the only match is the
comment at `db.ts:2338` saying it would be a Critical) — AC-20 holds.

## Other things checked and found clean

- `supabase/config.toml:474-475` — `[functions.instacart-cart-link] verify_jwt = true`,
  unchanged and out of the diff. The inline `ADMIN_ROLES` set at `index.ts:162` is
  `{"admin","master","super_admin"}` — **includes `super_admin`**, so the spec-026/027
  omission pattern does not recur. The `profiles.role` fallback at `:184-189` checks the
  same set.
- No destructive role-change or deletion path is introduced, so the last-of-role guard
  and the `caller.id != target.id` self-guard rules are N/A here — correctly noted in
  the function header at `index.ts:27`.
- No HTML is rendered anywhere in this diff (JSON responses only, React Native `Text`
  on the client), so `escapeHtml()` is N/A. The advisory toast interpolates
  `{vendor}`/`{store}` into a React Native `Text` node via `translate` — not an HTML
  sink.
- Ordering invariant preserved: every caller-facing refusal (401/403/400/404/409)
  resolves *before* the `INSTACART_IDP_API_KEY` gate at `index.ts:434`, which itself
  precedes the first outbound call. A missing secret still cannot convert the
  cross-store 404 into a 500.
- Advisory tokens are server-generated only and type-guarded on the way in
  (`db.ts:isInstacartAdvisory`), so `ADVISORY_TOAST_KEY[res.advisory]`
  (`useStore.ts:3564`) cannot be indexed by an attacker-chosen string during a
  deploy-skew window.
- The probe's own `try/catch` (`index.ts:461-517`) plus the 3 s
  `RETAILERS_PROBE_TIMEOUT_MS` bound the added latency to ~3 s and keep a probe
  `UpstreamTimeout` out of the outer 504 arm. No new unauthenticated surface, no new
  outbound call on any path that previously made none.
- `scripts/smoke-instacart-cart-link.sh` — no secret is echoed; the key is only used
  for the direct step-1 probe and never printed. Body slices in failure output are
  truncated to 200 chars and are the operator's own data. Still not wired into CI, as
  the banner says — a green `test.yml` is not evidence these arms ran.

### Dependencies

No `package.json` change in this diff (`git diff --cached --name-only | grep package.json`
→ empty) — `npm audit` skipped per process.

### Note for the release-coordinator

No Critical and no High from security. The two active CI gates (`test.yml`,
`db-migrations-applied.yml`) still need to be green on `main` per the CLAUDE.md rule —
that check is yours, not mine. This spec ships no migration, so the migration gate
should be inert for it. The deploy-skew note stands: until
`npx supabase functions deploy instacart-cart-link` runs, prod keeps returning the old
409s, which the preserved client fallback branch handles safely.
