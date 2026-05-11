# Security audit for spec 018 — Reports Variance Template (REPORTS-3)

Scope: `supabase/migrations/20260512120000_report_run_variance.sql`,
`src/lib/db.ts` (new `fetchRecentEodDates` helper),
`src/components/cmd/NewReportModal.tsx` (variance-mode branch),
`src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (chip labels),
`src/screens/cmd/sections/ReportsSection.tsx` (override gating),
`src/screens/cmd/sections/reports/templates.ts` (status flip).

Verdict: **no Critical, no High, no Medium, 2 Low (advisory)**. Posture is
solid — the RPC mirrors the COGS pattern faithfully, every cross-store
join path is gated by `auth_can_see_store(p_store_id)` + explicit
`store_id = p_store_id` joins, and the dispatcher swap is conservative.
Two Low items are minor UX/observability notes that do not block deploy.

---

### Critical (BLOCKS merge)

_None._

### High (must fix before deploy)

_None._

### Medium

_None._

### Low

- `supabase/migrations/20260512120000_report_run_variance.sql:177` —
  `RAISE NOTICE` on `v_truncated_recipe_count > 0` (line 251-252) and
  the structured-error path for `P0001`/`P0002`/`22023` write the store
  UUID into the Postgres log (`'Not authorized for store %', p_store_id`
  at line 134) and the date strings into the message. This is **not a
  PII leak** — Postgres logs are admin-only in Supabase Cloud and
  `db.runReport` sanitizes every non-`Not authorized` message to
  `'Run failed — check server logs'` before persisting to
  `report_runs.error_message` (`src/lib/db.ts:1722-1727`). But it does
  mean that a user hitting the modal's CREATE-then-RUN flow with a
  hand-crafted PostgREST request who picks an anchor date that matches
  some *other* store's EOD calendar will receive the generic
  `'Run failed'` message rather than the spec-intended
  `'no submitted EOD for store on YYYY-MM-DD (anchor: from)'` — the
  sanitizer treats P0002 the same as any other error. This is **better
  for security** (no anchor-existence oracle) but a small UX regression
  vs. the spec's AC (line 82-84). No action needed; flagged so the
  release-coordinator notes the trade-off. Fix only if the spec author
  wants the structured P0002 message to surface — that would require an
  allow-list addition to the sanitizer at `src/lib/db.ts:1722`.

- `src/components/cmd/NewReportModal.tsx:264` — when the user has 0 or 1
  submitted EODs and `varianceBlocked` is true, the modal disables
  CREATE client-side. A hand-crafted PostgREST `INSERT` against
  `report_definitions` with `template_id='variance'` and arbitrary
  `params` is **not blocked** — the server constraint is that RUN raises
  `P0001` at execution time, not that the definition row is rejected.
  This is **acceptable per spec line 268-269** (the spec explicitly
  resolves this: "The CREATE button is NOT disabled... pressing RUN
  against an unresolvable anchor will surface the RPC's 'P0002' error
  via the standard toast"). Flagged so it's documented that the
  client-side `varianceBlocked` toggle (line 259-265) is UX-only, not a
  server constraint. The blast radius is bounded: the user can only
  write definitions for stores `auth_can_see_store()` allows them to
  (RLS on `report_definitions` from
  `20260510120000_report_runs.sql`), and the worst outcome is a saved
  definition that always errors on RUN. No fix needed.

### Specific things requested — sign-offs

1. **RPC posture.** Verified.
   - `language plpgsql` (line 113), `security invoker` (line 114),
     `set search_path = public` (line 115). No `security definer`.
   - `auth_can_see_store(p_store_id)` raise on line 133-136 is the FIRST
     executable statement after `begin` — mirrors COGS line 102-105
     verbatim. Errcode `'42501'` matches the dispatcher's pattern.
   - `revoke execute on function public.report_run_variance(uuid, jsonb)
     from public, anon;` (line 587) — matches COGS pattern at line 684.
     Both `public` and `anon` are explicitly revoked (not just `anon`,
     so the `revoke from public` is meaningful — anon is not a no-op
     here because `public.anon` is a separate role grant inheritance).
   - `grant execute ... to authenticated;` (line 588) — matches COGS.
   - Dispatcher re-creation at line 607-640 preserves the auth gate
     (line 617-620) AND the `stub`/`cogs`/`variance`/`not_implemented`
     arms in the spec-required order. `revoke ... from public, anon;
     grant ... to authenticated;` at line 642-643 re-applies the lock.

2. **Input validation.** Verified.
   - `nullif(p_params->>'to', '')::date` (line 157) — empty string
     coerced to NULL; malformed date strings raise SQLSTATE `22008`
     (`datetime_field_overflow`) or `22007` (`invalid_datetime_format`)
     natively; both bypass the `Not authorized` allow-list at
     `src/lib/db.ts:1722` and get sanitized to `'Run failed'` (correct
     posture — schema details don't leak).
   - `from > to` raises `22023` (line 184-186). `from == to` raises
     `22023` (line 188-192). Both messages contain only the date
     strings the caller already passed in — no PII leak.
   - `P0001` (no two-EOD history, line 175-179) and `P0002` (anchor
     does not exist, lines 201-205 and 210-214) raises are structured
     as the spec required.
   - No `format()` / `execute` dynamic-SQL — all parameter use is
     parameterized via the standard `$1` plpgsql binding (`p_params`,
     `v_from`, `v_to`, `p_store_id`). **No SQL-injection surface.**

3. **Error-message data leakage.** Verified safe.
   - P0001 message (`'Not enough EOD history — need at least two
     submitted EODs to compute variance'`) — no PII, no date strings.
   - P0002 messages (lines 203, 212) include the date string the
     caller passed in and an `(anchor: from|to)` literal. Since the
     caller already knew the date (they passed it), no information
     leaks via the error — the only signal would be "this date does
     not exist in this store's EOD calendar," which by definition the
     caller is already authorized to see (the `auth_can_see_store`
     gate fired earlier on line 133).
   - 22023 messages (`'Variance report: from > to (%) > (%)'`, etc.)
     contain only the date strings the caller passed in.
   - **None of the structured raises start with `'Not authorized'`**,
     so all of them get sanitized to `'Run failed — check server
     logs'` by `db.runReport`'s allow-list at `src/lib/db.ts:1722`.
     Verified by inspection: P0001 starts with `'Not enough'`, P0002
     starts with `'Variance report: no submitted'`, 22023 starts with
     `'Variance report: from'`. None match `startsWith('Not
     authorized')`. The user gets a clean `'Run failed'` toast; the
     raw error is `console.warn`-only.

4. **Cross-store leakage via the recursive CTE.** Verified.
   - `prior_counts` (line 377-382) and `current_counts` (383-388) join
     `eod_entries` via `submission_id = v_from_submission_id` /
     `v_to_submission_id`. Both submission IDs were resolved earlier
     via `select id ... from eod_submissions where store_id =
     p_store_id and date = ... and status = 'submitted'` (lines
     198-200, 207-209). A foreign-store submission ID cannot be
     resolved because the SELECT has `store_id = p_store_id`. RLS on
     `eod_submissions` (per
     `20260504173035_per_store_rls_hardening.sql:66-81`) is an
     additional belt-and-suspenders here, but the explicit
     `store_id = p_store_id` clause is the primary gate.
   - `receiving` CTE (line 391-402) — `where po.store_id =
     p_store_id`. `po_items` joined via `pi2.po_id = po.id` only — no
     direct `po_items.store_id` reference exists (none is needed; the
     parent `purchase_orders` row carries the store).
   - `sales_depletion` CTE (line 407-425) — `where pi.store_id =
     p_store_id` AND `inner join inventory_items ii on ii.catalog_id =
     ari.catalog_id and ii.store_id = p_store_id`. **The
     `inventory_items` join is strictly store-scoped** — a foreign
     store's `inventory_items` row with the same `catalog_id` is
     dropped by the join.
   - `waste` CTE (line 428-437) — `where w.store_id = p_store_id`.
   - `joined` CTE (line 444-475) — `join public.inventory_items ii on
     ii.id = pc.item_id and ii.store_id = p_store_id`. Even if
     `eod_entries.item_id` somehow referenced a different store's
     `inventory_items.id` (it shouldn't — same store_id is enforced
     at write time, but isn't a hard FK), the `ii.store_id =
     p_store_id` clause filters it out.
   - All four data sources are store-scoped explicitly. No leakage
     path via the CTE.

5. **`fetchRecentEodDates` helper.** Verified.
   - `src/lib/db.ts:594-606` — parameterized via
     `.eq('store_id', storeId)` (line 597). No string concat. PostgREST
     binds the value.
   - RLS on `eod_submissions` (`20260504173035_per_store_rls_hardening.sql:66-69`)
     adds `using (auth_can_see_store(store_id))` — even if the caller
     passed a `storeId` they don't own, the `eq` filter intersects with
     the RLS gate and the helper returns `[]`.
   - Return shape is `string[]` of ISO dates — no count, no metadata.
     Worst-case oracle: a caller iterating store UUIDs and probing
     `fetchRecentEodDates(otherStoreId, 2)` learns nothing they don't
     learn from any other PostgREST query against the same table (and
     the existing RLS already protects).
   - **Important nuance:** the helper logs the PostgREST error message
     via `console.warn` (line 602). PostgrestErrors from RLS denials
     are typically "0 rows" rather than "permission denied" (RLS
     intersects, doesn't reject), so no error path is expected in
     practice. But if a malformed `storeId` (e.g. non-UUID string)
     triggers a `22P02 invalid_text_representation`, the message could
     reach the JS console. Console logs are dev-tools-visible; not a
     remote disclosure. **No fix needed.**

6. **Variance-mode CREATE block.** Verified per Low #2 above.
   Server-side, `report_run_variance` raises P0001 when the user
   hand-crafts a definition for a store with <2 EODs and tries to RUN
   it. Client-side `varianceBlocked` (NewReportModal:259) is UX-only.
   Acceptable per spec line 268-269. Blast radius bounded — RLS on
   `report_definitions` ensures the user can only write definitions
   for stores they already see.

7. **Anchor-date forgery via the modal.** Verified.
   - `fetchRecentEodDates` only returns dates for the caller's
     visible stores (RLS-enforced). The pre-fill never reveals foreign
     dates.
   - When the user manually edits to a date that matches a foreign
     store's EOD calendar:
     - The RPC's `auth_can_see_store(p_store_id)` gate fires FIRST
       (line 133) before any date logic runs. If the user is not
       authorized for `p_store_id`, they get the
       `'Not authorized for store <UUID>'` message — and that's the
       only one the sanitizer surfaces (line 1722). Cannot probe
       cross-store via this RPC.
     - Within their authorized store, picking a date with no matching
       EOD raises P0002 which gets sanitized to `'Run failed'`. The
       error message does not differentiate "no EOD for THIS store"
       from "EOD exists somewhere else but not here" — both produce
       the same sanitized output. **No cross-store oracle.**
   - The sanitization layer at `src/lib/db.ts:1722-1727` is what
     keeps the date-existence oracle closed. It's load-bearing for
     this audit; flagging it explicitly so the release-coordinator
     knows the sanitizer is part of the security boundary.

8. **`idx_waste_log_store_logged_at`.** Verified safe.
   - `create index if not exists idx_waste_log_store_logged_at on
     public.waste_log (store_id, logged_at);` (line 598-599).
   - Idempotent — `if not exists` guard. RLS on `waste_log`
     (`20260504173035_per_store_rls_hardening.sql`) is unaffected by
     index choice; the planner uses the index for `where store_id =
     $1 and logged_at::date > $2 and logged_at::date <= $3` only
     after RLS evaluates. No data-leak via planner-choice.

9. **`npm audit` run.** No package.json changes in this spec
   (verified via `git diff --stat HEAD package.json package-lock.json`
   — empty). Pre-existing audit baseline at HEAD (Spec 016 baseline):
   `5 moderate, 1 high` in dev-tooling chain (postcss in
   `@expo/metro-config` → `@expo/cli` → `expo`; @xmldom/xmldom). These
   are inherited from prior specs and are not introduced or aggravated
   here. **Not a finding for spec 018.** Recommend a tooling-bump
   pass as a separate follow-up (out of scope for REPORTS-3).

### Dependencies

`npm audit --audit-level=high` summary (no `package.json` change in
this spec — pre-existing baseline):

| Severity | Count | Path |
|----------|-------|------|
| high     | 1     | `@xmldom/xmldom` (transitive, dev) |
| moderate | 5     | `postcss` chain → `@expo/metro-config` / `@expo/cli` / `expo` |

Same six findings as Spec 016 / 017 baseline. None introduced by
REPORTS-3. Not blocking.
