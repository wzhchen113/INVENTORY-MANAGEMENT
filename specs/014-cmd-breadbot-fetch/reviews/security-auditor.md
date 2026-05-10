# Security audit for spec 014 — Cmd UI Breadbot fetch port

Scope: `src/lib/posBreadbot.ts` (new), `src/components/cmd/FetchBreadbotModal.tsx` (new), `src/screens/cmd/sections/POSImportsSection.tsx` (modified). Backend (`supabase/functions/fetch-breadbot-sales/index.ts`, `src/lib/db.ts`, `useStore.importPOS`) is out of scope for redesign per spec but audited at boundary level.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/functions/fetch-breadbot-sales/index.ts:91-117` — pre-existing, NOT introduced by this spec, but worth flagging once for the record. The edge function validates the caller's JWT but does NOT confirm the user is associated with the requested `storeName`. An authenticated admin scoped to store A could call `fetchBreadbotSales('Towson', '...')` even if their JWT only covers store B and read sales data for a store they cannot otherwise see in `pos_imports`. The follow-on `savePOSImport` write into `pos_imports` would still be blocked by RLS (`auth_can_see_store(store_id)` at `supabase/migrations/20260504173035_per_store_rls_hardening.sql:262`), but the read happens out-of-band of RLS. Spec 014 explicitly defers backend hardening ("Backend wiring already shipped, do not redesign"); the Cmd port inherits the same surface the legacy `POSImportScreen.tsx` has. Recommend a separate spec to add a per-store check inside `fetch-breadbot-sales` (e.g. `select 1 from user_stores where user_id = auth.uid() and store_id = (select id from stores where name = $1)`).

## Notes (informational, no action requested)

- Auth path is correct. `src/lib/db.ts:907-921` uses `supabase.functions.invoke('fetch-breadbot-sales', ...)` against the singleton client created at `src/lib/supabase.ts:13` with the publishable anon key and a persisted user session. `supabase-js` automatically attaches `Authorization: Bearer <user JWT>` to function invocations, satisfying the edge function's `verify_jwt = true` (default — no override in `supabase/config.toml:381-398` for `fetch-breadbot-sales`) and the function's own `auth.getUser()` gate at `supabase/functions/fetch-breadbot-sales/index.ts:91-102`. The Cmd port does not bypass this — it only routes through the same `fetchBreadbotSales` helper as legacy.
- No secrets in client code. `BREADBOT_API_KEY` is read via `Deno.env.get(...)` inside the edge function (line 77). The new client files (`src/lib/posBreadbot.ts`, `src/components/cmd/FetchBreadbotModal.tsx`, modified `src/screens/cmd/sections/POSImportsSection.tsx`) reference no `process.env`, no `EXPO_PUBLIC_*`, no Breadbot URL or token, and no service-role key. Verified with grep across the three files.
- RLS path on writes is intact. `savePOSImport` (`src/lib/db.ts:831-864`) inserts into `pos_imports` and `pos_import_items` via the user-session-scoped client; both tables are gated by `auth_can_see_store(store_id)` (and a parent-row exists check for items) per `supabase/migrations/20260504173035_per_store_rls_hardening.sql:253-311`. `hasPOSImportForDate` (`src/lib/db.ts:869-880`) uses the same session client; SELECTs are also covered by the read policy. Even if a malicious client tampered with `currentStore.id` in memory, the INSERT would fail the `with check (auth_can_see_store(store_id))` policy. The new modal does not introduce any RPC, view, or service-role path that would skirt this.
- Input validation. `storeName` and `date` are validated server-side at `supabase/functions/fetch-breadbot-sales/index.ts:111-117` — `storeName` must be non-empty after trim and must be in `STORE_MAP`; `date` must match `^\d{4}-\d{2}-\d{2}$`. The client's `BREADBOT_STORES` set in `src/lib/posBreadbot.ts:25-29` is documented as a UI guard only ("edge function is the source of truth") — a malicious client bypassing the guard cannot fetch un-mapped stores because the edge function rejects them. The 30-day backfill cap is enforced client-side (`src/components/cmd/FetchBreadbotModal.tsx:197-205`); circumventing it would just result in slow throttled fetches against the same JWT-protected endpoint, so no DoS surface added.
- No data exfiltration. Fetched rows flow only to: section-local React state (`breadbotPreview`, `backfillResults`), `savePOSImport` (which writes to `pos_imports` / `pos_import_items` on the same Supabase project), `importPOS` (Zustand-only), and `upsertPosRecipeAliases` (`pos_recipe_aliases` on the same project). No raw `fetch(...)`, no `console.log` of row content, no third-party transmission. Verified by grep — zero `console.*` calls in any of the three new/modified files.
- Toast error surfaces use `e?.message` from the edge function's structured error responses (`{ error: 'Breadbot 502' }`, `{ error: 'storeName required' }`, etc.). No stack traces, no SQL fragments, no JWTs. The fallback string `'Check API key and network'` (`FetchBreadbotModal.tsx:168`) is a verbatim port of legacy copy and is just user-facing guidance, not a key value.
- Realtime subscriptions are unchanged. New rows in `pos_imports` flow through the existing `store-{currentStore.id}` channel; the publication is unchanged so realtime auth (`auth_can_see_store(store_id)` on the row) still gates which clients see the insert.
- `useRole()` is not used as a security boundary anywhere in the new code (verified by grep — no `useRole` imports in any of the three files). Visibility of the FETCH BREADBOT button is gated only on `BREADBOT_STORES.has(currentStore.name)`, which is a UX filter, not a privilege check; the privilege check is the underlying RLS + edge-function JWT.
- One non-finding: the modal's `Modal.onRequestClose` and outer-overlay `onPress` are no-op'd while a fetch or backfill is in flight (`FetchBreadbotModal.tsx:274-277`). This is a UX choice, not a security issue — the user cannot orphan an in-flight request because the network call is already on the wire; the no-op just prevents a confusing partial-state close.

## Dependencies

No `package.json` changes — `npm audit` skipped per audit charter.
