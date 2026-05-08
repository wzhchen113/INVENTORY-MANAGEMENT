# Spec 007 — release proposal

## Verdict
verdict: SHIP_READY
rationale: All four reviewers report zero Critical findings; the staged surface (migration + backend + frontend slice + mid-build TZ fix) is ready for the user-authorized prod push, with a small set of low-risk doc/code cleanups recommended inline per Spec 003/006 precedent.

## Findings summary

- **code-reviewer**: 0 Critical, 4 Should-fix, 6 Nits.
  Top issues: (1) `EODCountSection.tsx:613-631` `+ vendor` button comment promises `disabled` behavior under `showUnscheduled` / `__all__` that isn't actually wired (real should-fix — the comment lies about the code); (2) `OrderScheduleSection.tsx:179` inline `'#000'` literal for the ✓ glyph instead of routing through `useCmdColors()`; (3) `db.ts:1532-1566` comment references `ON CONFLICT DO NOTHING` but the helper actually uses plain INSERT + 23505 client-swallow — misleading docstring; (4) `useStore.ts:1057-1078` optimistic mutation runs unconditionally even when `vendor.vendorId` is falsy (pathological case but un-reverted).

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 Low (informational).
  Verified safe via local DB probes: RLS on `order_schedule` correct (admin-only WITH CHECK), unique-constraint-vs-RLS ordering correct (no existence side-channel — RLS fires before unique-index check, so 23505 cannot enumerate cross-tenant rows), brand-scope filtering correct at app layer, no `useRole` placeholder reliance, no new secrets, migration is idempotent (re-applies as no-op). Pre-existing `vendors` SELECT-policy looseness noted as upstream backlog item, NOT a Spec 007 finding.

- **test-engineer**: 7 PASS (VERIFIED) / 1 CODE-VERIFIED with accepted scope revision (AC5 cross-tab realtime is a documented V1 trade-off per architect §5) / 1 NOT TESTED (`__all__` defensive branch — near-impossible state in real navigation). Zero FAIL. AC1–AC4, AC6–AC9 all browser-confirmed by main Claude post-fix-pass; TZ fix verified at all 5 call-sites. Quality-gap finding: dual-constraint silent-swallow (vendor-name collision from a different `vendor_id` is dropped by the unconditional 23505 swallow) — minor, not blocking. Migration apply-method deviation (direct psql + manual `schema_migrations` insert because Spec 006's idempotency block prevents `migration up`) is a pre-existing local-state oddity, not a Spec 007 defect. Test framework gap is the project's known limitation.

- **backend-architect (drift)**: 0 Critical, 2 Should-fix, 5 Nits.
  S1 store-action naming (`addOrderScheduleEntry` vs §6's `addScheduledVendor`) — **architect endorses dev's name in retrospect**, two-name pair across layers is the codebase idiom; only spec §6 text needs updating. S2 `delivery_day` NOT NULL — design said optional, table says NOT NULL, dev correctly defaults to `day` argument; **architect endorses fallback** and flags `\d <table>` as a future §0 probe template. Nits N1–N3 are forward-looking architect-template improvements (probe `pg_constraint` and `pg_publication_tables` in §0; audit every `toISOString().slice(0,10)` site in any spec touching calendar-day math). N4–N5 are expected verification gaps (revert-on-RLS-denial path + `__all__` defensive branch). Architectural contract honored end-to-end.

## Recommended next steps (ordered)

Since all reviewers are 0-Critical and the implementation has been browser-verified post-fix-pass, the call is **SHIP_READY** with optional inline cleanup before prod push.

1. **Authorize prod push** of `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql` (the gating action). Migration is idempotent and verified safe; security-auditor confirmed the dedup pre-pass is a no-op on already-deduped tables and the `IF NOT EXISTS` constraint-add block correctly skips on re-apply. **Decision required from user.**

2. **Optional inline doc/code cleanup** before commit (Spec 003/006 precedent: code-side cleanups go in this commit; SQL-file fixes to a shipped migration go in a separate follow-up). Recommended bundle:
   - **code-reviewer #1** (real bug-shaped issue) — wire the `disabled={showUnscheduled}` + opacity treatment on the `+ vendor` button to make the comment true. Two-line fix at `EODCountSection.tsx:613-631`.
   - **code-reviewer #3** — fix the misleading `ON CONFLICT DO NOTHING` comment in `db.ts:1532-1537` to say "plain INSERT; 23505 caught client-side". One-line.
   - **code-reviewer #4** — guard the optimistic `set(...)` in `useStore.ts:1059-1071` with the same `vendor.vendorId` check used before the db call. ~3-line move.
   - **architect S1** — sync spec §6's table cell from `addScheduledVendor` / `removeScheduledVendor` to the shipped names. Spec text only.
   - **architect S2** — add a sentence under spec §3a noting the `delivery_day ?? day` fallback so the next caller knows omitting `deliveryDay` is safe. Spec text only.

3. **Decide on dual-constraint silent-swallow concern** (test-engineer finding 1). Two options, both non-blocking:
   - **Defer as follow-up spec**: enforce `vendors.name` uniqueness at the brand grain, then drop the legacy `order_schedule_store_id_day_of_week_vendor_name_key` constraint as dead weight.
   - **Inline patch now**: narrow the 23505 swallow in `db.ts:1565` to also check `error.message` references the new constraint name (`order_schedule_store_day_vendor_unique`), so a `vendor_name` collision from a different `vendor_id` surfaces as an error rather than a silent no-op.
   Recommended: defer. The primary use case (idempotent re-clicks of the same vendor) works correctly; the silent-swallow is only observable when two distinct vendor records share an exact name within the same brand, which violates an unenforced-but-practical convention.

4. **After commit** — log forward-looking template updates (no action required this cycle, captured in proposal):
   - Add `\d <table>` schema dump to architect's standard §0 probe matrix for every table the design writes to (catches NOT NULL columns and pre-existing constraints in the design phase, not the build phase).
   - Add `select * from pg_publication_tables where tablename='<t>'` to architect's standard §0 probe matrix when realtime is in scope.
   - Add "audit every `toISOString().slice(0, 10)` call site" to architect's standard §0 probe matrix when calendar-day math is in scope. Same TZ-edge bug class shows up in `InventoryDesktopLayout.tsx:129` (`todayStr` in the EOD footer badge) — flagged by code-reviewer as out-of-scope follow-up.
   - Adopt dev's `addOrderScheduleEntry` / `removeOrderScheduleEntry` naming convention (db helper ↔ store action mirror) as the new project pattern, matching Spec 003 precedent of endorsing the dev's choice when better than the architect's draft.

5. **Post-prod-push smoke walk** — exercise the two unverified branches in a real session:
   - The optimistic-revert path (architect N4) — temporarily run as a non-admin user, click `+ vendor`, watch the pill appear and then revert with `notifyBackendError` toast. Code-inspected as correct; live evidence missing.
   - The `__all__` empty state (test-engineer finding 3, architect N5) — defensive guard against a near-impossible state; not a blocker but worth a one-time verification before assumed correct.

## Out of scope for this review

- **Pre-existing loose `vendors` SELECT RLS** (`auth.uid() is not null` allowing any authed user to read every brand's vendors via raw PostgREST) — security-auditor §4 caveat. Not a Spec 007 defect; cited as an upstream backlog item in the architect's hardening notes. Surface as a separate spec if cross-brand admin scoping becomes a concern.
- **Spec 006 idempotency assertion blocking `npx supabase migration up --include-all`** — local-state oddity discovered when applying Spec 007's migration via the standard path. Worked around with direct `psql` + manual `schema_migrations` insert; the recorded version matches what `migration up` would have produced. Belongs in a Spec 006 follow-up or a local-DB cleanup pass, not Spec 007.
- **No automated test framework** (jest/vitest/playwright) — project-wide gap per CLAUDE.md. test-engineer recorded the gap (TZ regression test, dual-constraint coverage, optimistic-revert path) without escalating. Framework introduction requires explicit user approval.
- **`InventoryDesktopLayout.tsx:129` `todayStr` UTC-pattern follow-up** — code-reviewer N4 noted this as the same class of bug just fixed in `EODCountSection`, but it drives only the footer EOD count badge and is display-only / low stakes. Worth a follow-up clean-up pass to use `localDayIso`, but not a Spec 007 surface.
- **Legacy `order_schedule_store_id_day_of_week_vendor_name_key` constraint** — security-auditor §8 and architect N1 agree it's harmless dead weight. Drop in a future cleanup pass once `vendors.name` uniqueness is enforced upstream.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 0 Critical across all 4 reviewers. User decides: (a) apply optional inline cleanup bundle (4 small code/doc fixes per Spec 003/006 precedent) before commit, (b) authorize prod push of `20260507214842_spec007_order_schedule_unique.sql`, (c) defer or inline-patch the dual-constraint silent-swallow quality gap.
payload_paths:
  - specs/007-eod-vendor-day-filter/reviews/release-proposal.md
