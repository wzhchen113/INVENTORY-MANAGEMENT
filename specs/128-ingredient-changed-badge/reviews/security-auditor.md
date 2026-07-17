# Security audit for spec 128

Scope reviewed: `supabase/migrations/20260722000000_ingredient_changed_badge.sql`
(2 nullable `timestamptz` columns, 1 index, 2 `BEFORE UPDATE` trigger fns + triggers,
`staff_items_updated(uuid)` RPC), `src/screens/staff/lib/itemsUpdated.ts`, and the
spec. Threat model focus: cross-store/cross-brand leak, definer escalation, trigger
abuse, new exposure.

## Verdict

Zero blocking findings. This is a low-surface, read-mostly feature and it lands clean
against the threat model. Details below confirm each focus item.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `supabase/migrations/20260722000000_ingredient_changed_badge.sql:47-56, 68-77` —
  The two trigger functions (`stamp_catalog_image_changed_at`,
  `stamp_item_vendor_changed_at`) do not pin `SET search_path`. This is **not a
  finding under this codebase's threat model** and is called out only for
  completeness: neither function is `SECURITY DEFINER` (they run with the caller's
  privileges, so there is no privilege boundary to hijack), and neither resolves any
  schema-qualified object through `search_path` — the only callable referenced is the
  `pg_catalog` built-in `now()`, and the rest is `NEW`/`OLD` record field access. There
  is no reachable search-path-injection vector. No change required; pinning would be
  pure defense-in-depth consistency with the RPC.

## Focus-item confirmations

1. **`staff_items_updated(uuid)` — no leak, no escalation.**
   - `security invoker` + `set search_path = public` confirmed
     (`...20260722000000...sql:103-104`). No `SECURITY DEFINER` anywhere in the
     migration (verified by grep). No definer surface exists.
   - Grants correct: `revoke execute ... from public, anon` then
     `grant execute ... to authenticated` (lines 134-135).
   - Every table the RPC reads has RLS enabled: `inventory_items`, `eod_submissions`,
     `eod_entries` (init_schema.sql:244/247/248), `catalog_ingredients`
     (brand_catalog_p1_additive.sql:77), `inventory_counts` /
     `inventory_count_entries` (inventory_counts.sql:106/130). Because the function
     runs as the caller, a staff user calling it for a store they don't belong to gets
     the `inventory_items` rows filtered out by `auth_can_see_store` → empty set. No
     `42501` gate needed; no cross-store/cross-brand leak.
   - Output columns are `item_id` + two `timestamptz` change/count markers + a boolean.
     No PII, no cost, no other-store rows. A staff user only ever sees timestamps for
     items already visible to them.

2. **Triggers — not abusable, no authz change.**
   - Both are `BEFORE UPDATE ... FOR EACH ROW`, plpgsql, no dynamic SQL, no `EXECUTE`,
     no user-supplied text — they set `image_changed_at`/`vendor_changed_at :=
     now()` only when the watched column `IS DISTINCT FROM` its prior value
     (lines 52-53, 73-74). No injection surface.
   - They do not `ENABLE`/alter any policy and do not touch authorization: the caller
     still needs UPDATE rights on `catalog_ingredients` / `inventory_items` via the
     existing RLS to reach the trigger at all. A trigger cannot admit a write RLS would
     have denied.
   - `INSERT` is intentionally uncovered, so row creation never stamps — correct
     rollout posture, and no way to pre-seed a stale "updated" badge.

3. **No new exposure.**
   - No new table, no new/changed RLS policy, no new grant beyond the single
     `authenticated`-scoped RPC. Columns are timestamps (no PII).
   - `src/screens/staff/lib/itemsUpdated.ts:28-45` is best-effort: on any error it
     routes through `notifyBackendError` and returns an empty `Set` — no data leak on
     failure, count list still renders. It only reads `item_id`/`updated` and never
     logs a token or secret.
   - Migration ordering dependency on spec 127 (`image_path`) is enforced by the
     `20260722…` timestamp and documented; not a security issue, noted for the
     release-coordinator's prod-apply ordering.

### Dependencies
No `package.json` changes in the staged set — `npm audit` skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low (informational
  only — unpinned search_path on two non-DEFINER trigger fns, no reachable vector, no
  change required). Invoker RPC has pinned search_path + correct revoke/grant, all
  underlying tables enforce RLS so cross-store/cross-brand reads return empty, triggers
  carry no user input or dynamic SQL and don't alter authorization, client helper
  degrades to empty on error, no new table/policy/grant/PII. Nothing blocks.
payload_paths:
  - specs/128-ingredient-changed-badge/reviews/security-auditor.md
