## Verdict
verdict: SHIP_READY
rationale: All 5 round-1 Criticals (4 security + 1 frontend) PASS in round 2 with live-PoC re-verification and verified file diffs; no new Critical or High introduced; deferred Mediums/Lows/Nits are non-blocking follow-ups.

## Why SHIP_READY (per CLAUDE.md hard rule)

CLAUDE.md states `release-coordinator` cannot recommend SHIP_READY if **any** reviewer flagged an unresolved Critical. Round-2 status:

- security-auditor round 2: all 4 round-1 Criticals (C1-C4) and the 1 High (H1) **PASS (closed)** via live PoC re-runs under `manager@local.test` JWT impersonation. No NEW Critical or High introduced.
- test-engineer round 2: **40 PASS, 0 FAIL**, 1 NOT TESTED (multi-tab realtime — framework gap, low severity).
- code-reviewer round 1: 1 Critical (C-FE-1) — verified CLOSED by test-engineer round 2 (4 cross-category entries persist; footer and drill-in match).
- backend-architect round 1: 0 Drift, APPROVE — unchanged.

No reviewer currently has an unresolved Critical. SHIP_READY is the correct verdict.

## Independent verification

Reviewed both round-2 review files in full (`specs/019-any-time-inventory-count/reviews/security-auditor.md`, `specs/019-any-time-inventory-count/reviews/test-engineer.md`) and both migration files at source to corroborate the reviewers' claims independently:

- **Triggers present** — `supabase/migrations/20260513120000_inventory_counts_consistency.sql:54-70` defines `inventory_counts_set_submitted_by` + trigger `inventory_counts_set_submitted_by_trg` (BEFORE INSERT OR UPDATE FOR EACH ROW). Lines 79-113 define `inventory_count_entries_check_store` + trigger `inventory_count_entries_check_store_trg` (same shape). Both `security invoker`, `set search_path = public`. Security-auditor re-confirmed via `pg_proc` inspection (review §7). Test-engineer re-confirmed via `tgtype = 23` (BEFORE ROW) check (review §SEC-C1, SEC-C2).
- **UPDATE/DELETE policies dropped** — `20260513120000_inventory_counts_consistency.sql:119-131` drops all four policies (`store_member_update_inventory_counts`, `store_member_update_inventory_count_entries`, `store_member_delete_inventory_counts`, `store_member_delete_inventory_count_entries`). Security-auditor confirmed via `pg_policies` enumeration (only SELECT + INSERT remain on both tables; review §C3). Test-engineer confirmed `SELECT COUNT(*) FROM pg_policies WHERE tablename IN ('inventory_counts','inventory_count_entries') AND cmd IN ('UPDATE','DELETE')` returns 0 (review §SEC-C3, DM-4).
- **Partial-unique is store-scoped** — `20260513000000_inventory_counts.sql:102-104` defines `inventory_counts_store_client_uuid_uidx` on `(store_id, client_uuid) WHERE client_uuid IS NOT NULL`. RPC dedup at lines 284-296 filters on `AND store_id = p_store_id`. Security-auditor confirmed via live PoC: same `client_uuid` in two different stores both succeed with `conflict: false`; same store + same UUID returns `conflict: true` (review §H1). Test-engineer confirmed via `pg_indexes.indexdef` (review §DM-3, SEC-H1).

I do not have a Bash tool grant in this thread, so I could not re-run the psql verification queries the dispatch prompt suggested. The reviewer round-2 reports are themselves the live-PoC verification (they ran psql under JWT impersonation, captured exit codes, row counts, and policy enumerations) and the source migrations match those reports exactly. Treating both reviewer files as primary evidence is consistent with the CLAUDE.md hard rule to "read the actual reviewer files."

## Round-by-round resolution

| Round-1 finding | Severity | Round-2 verdict | Closed by |
|---|---|---|---|
| C-Sec-1 — `submitted_by` audit forgery via direct INSERT | Critical | **PASS** | `inventory_counts_set_submitted_by_trg` BEFORE INSERT/UPDATE override (`20260513120000_inventory_counts_consistency.sql:54-70`); live-PoC verified |
| C-Sec-2 — Cross-store `item_id` spoof via direct entry INSERT | Critical | **PASS** | `inventory_count_entries_check_store_trg` BEFORE INSERT/UPDATE raises 42501 (`20260513120000_inventory_counts_consistency.sql:79-113`); live-PoC verified |
| C-Sec-3 — UPDATE policy lets store members rewrite audit fields | Critical | **PASS** | UPDATE policies dropped on both tables (`20260513120000_inventory_counts_consistency.sql:119-122`); append-only posture |
| C-Sec-4 — DELETE policy lets store members destroy audit history | Critical | **PASS** | DELETE policies dropped on both tables (`20260513120000_inventory_counts_consistency.sql:128-131`); store-cascade-delete still works via postgres role |
| C-FE-1 — Filter-slice data-loss bug (cross-category entries silently dropped on SUBMIT) | Critical | **PASS** | `InventoryCountSection.tsx` `onSubmit`, `nonBlankCount`, `totalItems`, `hasNegative` all derive from `storeInventory` (not `filteredItems`); test-engineer ran 4-entry cross-category PoC → all 4 persisted |
| H1 — `client_uuid` cross-store collision returns raw 23505 instead of clean `conflict:true` | High | **PASS** | Partial-unique reshaped to `(store_id, client_uuid)` (`20260513000000_inventory_counts.sql:102-104`); RPC dedup query filtered on `store_id` (lines 284-296); live-PoC verified — distinct rows in distinct stores both succeed |
| S1 — Dead `inventory_counts` subscription in `useRealtimeSync.ts` | Should-fix | **CLOSED** | Line removed; replaced with explanatory comment; section owns its own `store-${storeId}-inv-counts` channel (test-engineer §RT-2) |
| S2 — `coalesce(v_entry.notes, '')` empty-string coercion | Should-fix | **CLOSED** | RPC passes `v_entry.notes` directly (`20260513000000_inventory_counts.sql:355-362`); NULL stays NULL; live-PoC verified (security-auditor §8) |
| S3 — Non-standard section channel name `inv-count-section-{storeId}` | Should-fix | **CLOSED** | Renamed to `store-${storeId}-inv-counts` (test-engineer §channel-rename) |
| S4 — `client_uuid` minted per store-action call (loses idempotency on retry) | Should-fix | **CLOSED** | `clientUuid` minted once per `onSubmit` invocation in the section (`InventoryCountSection.tsx:308-311`) before `setSubmitting(true)`; store action signature accepts `clientUuid` parameter (`useStore.ts:1421-1451`); same UUID on retry returns `conflict:true` (live-PoC verified) |

## Findings summary

- **code-reviewer (round 1)**: 1 Critical (C-FE-1) — CLOSED in round 2. 4 Should-fix (S1-S4) — all CLOSED in round 2 P1 patch. 5 Nits — deferred (see below).
- **security-auditor (round 2)**: All 4 round-1 Criticals (C1-C4) **PASS** via live PoC re-runs. 1 High (H1) **PASS**. No NEW Critical or High introduced. 4 Medium (M1-M4) + 4 Low (L1-L4) deferred per release proposal §P2. `package.json` unchanged so `npm audit` was correctly skipped.
- **test-engineer (round 2)**: 40 PASS / 0 FAIL / 1 NOT TESTED. Full AC matrix green (DM 5/5, RPC 15/15, FE 12/12 including C-FE-1 closed, DB.ts 4/4, RT 3/3 with multi-tab the only NOT TESTED, TS 2/2). All 5 round-1 BLOCK findings (SEC-C1, SEC-C2, SEC-C3, SEC-C4, C-FE-1) verified CLOSED with primary-source evidence (psql impersonation, bundle grep, pg_policies/pg_indexes inspection).
- **backend-architect (round 1)**: 0 Drift, 0 findings, APPROVE — implementation faithful to design across schema, RPC contract, db.ts shape, Cmd UI integration, and realtime wiring. Two load-bearing invariants intact (no `current_stock` write per Q2, no variance-anchor change per Q3). Architect did not re-run for round 2; consistency migration is a security-posture patch, not a contract change — same shape as REPORTS-1 round-2 where architect also did not re-run.

## Recommended next steps (ordered)

1. **User reviews the round-2 patch and commits.** Staged files already in `git status`:
   - `supabase/migrations/20260513000000_inventory_counts.sql` (edited: store-scoped partial-unique, RPC dedup join on `store_id`, `coalesce` removed from per-entry notes insert).
   - `supabase/migrations/20260513120000_inventory_counts_consistency.sql` (new: 2 triggers + 4 dropped policies).
   - `src/screens/cmd/sections/InventoryCountSection.tsx` (edited: `storeInventory` everywhere instead of `filteredItems`; `clientUuid` minted once per submit; channel renamed; `countedAtLocal` reset post-submit).
   - `src/store/useStore.ts` (edited: `submitInventoryCount` signature accepts `clientUuid: string` parameter; no longer mints internally).
   - `src/hooks/useRealtimeSync.ts` (edited: dead `inventory_counts` subscription removed, comment added).
   - Plus the original adds: `src/lib/db.ts`, `src/types/index.ts`, `cmdSelectors.ts`, `InventoryDesktopLayout.tsx`, the spec file, and the four reviewer files.

2. **(Optional, non-blocking) Deploy and monitor**, then schedule the deferred items below as a follow-up spec.

Per CLAUDE.md memory note: stage only — do not auto-commit. The user runs `git commit` after reviewing the staged diff.

## Out of scope for this review (deferred follow-ups, surface, do not block)

### Deferred Mediums (security-auditor)
- **M1** — Add length cap on `inventory_counts.notes` (suggest 2000 chars) and `inventory_count_entries.notes` (suggest 1000 chars). DoS hardening; not exploitable for data loss.
- **M2** — `inventory_count_entries.unit` is unbounded text; add a length cap or allowlist.
- **M3** — `p_entries` jsonb array is unbounded; add an upper-bound check (suggest ≤ 5000) in the RPC.
- **M4** — `src/lib/db.ts:674` `console.warn('[Supabase] submitInventoryCount:', error.message, error)` echoes the full error object; sibling helpers at `db.ts:706` and `db.ts:748` log only `.message`. Switch for consistency.

### Deferred Lows (security-auditor)
- **L1** — `client_uuid` is returned in `fetchInventoryCount` detail payload (`db.ts:738`, `InventoryCount.clientUuid` at `types/index.ts:273`). Drop from the projection — it has no client-side use.
- **L2** — `inventory_count_entries` is not on the per-store realtime channel filter; entries-level changes don't push. Minor — section refetches on parent-count events.
- **L3** — Migration filenames carry `2026-05-13` date stamps while today is `2026-05-11`; both apply cleanly and load in order. Cosmetic.
- **L4** — Cosmetic name-regex on one error message.

### Deferred Nits (code-reviewer)
- Nit 2 (`countId || ''` silent failure in `db.ts:679` — change to throw or warn).
- Nit 3 (`InventoryCount.entries` non-optional vs `InventoryCountSummary` asymmetry — type expressiveness only).
- Nit 4 (`listInventoryCounts → fetchRecentInventoryCounts` AC-vs-impl rename — documentation discrepancy only).
- Nit 5 (raw `supabase` import in `InventoryCountSection.tsx:9` — used only for realtime, technically compliant).

### Pre-existing project tickets (not introduced by this spec)
- **No test framework** — same gap as every prior spec. Test-engineer used psql impersonation under JWT as the workaround. User approval required before any framework is added per CLAUDE.md. Multi-tab realtime test remains NOT TESTED for this reason; LOW severity because the architecture mirrors EOD's working pattern.
- **Cold-boot React errors** — pre-existing, not introduced by Spec 019.
- **`supabase_realtime FOR ALL TABLES` posture** — pre-existing; new tables auto-join the publication without restart.
- **npm-audit dev-tooling vulnerabilities** — pre-existing; `package.json` unchanged this spec so no new exposure.
- **CLAUDE.md pitfall documentation gap** — security-auditor and test-engineer both flagged that this is the **third** time the `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes pattern has produced Criticals on this codebase (REPORTS-1 round-1, REPORTS-1 round-2, now Spec 019). The fix template is well-established (`20260510130000_report_runs_consistency.sql` and now `20260513120000_inventory_counts_consistency.sql`). Recommend a future documentation spec adds a "RLS — audit-bearing tables also need triggers" note in CLAUDE.md.

## Handoff
next_agent: NONE
prompt: SHIP_READY — all 5 round-1 Criticals PASS (4 security + 1 frontend), 40/40 test checks pass, no NEW Critical/High; user reviews staged diff and commits.
payload_paths:
  - specs/019-any-time-inventory-count/reviews/release-proposal.md
