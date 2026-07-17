# Backend-architect drift review — Spec 129 (EOD vendor status + submit/edit flow)

Mode: post-implementation drift review. Scope: frontend-only staff-surface change.
Verdict: **matches the design. No Critical or Should-fix drift. Two Minor notes.**

Reviewed against `## Backend design` in `specs/129-eod-vendor-status-edit-flow.md`.
Files inspected: `src/screens/staff/lib/submittedStatus.ts`,
`src/screens/staff/screens/EODCount.tsx`, `src/screens/staff/screens/EODCount.test.tsx`,
`src/screens/staff/hooks/useEodSubmit.ts`, the three staff i18n locales,
`supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql`, `src/lib/db.ts`.

## Confirmations (all 5 requested points hold)

**(1) No backend change.** Confirmed. No spec-129 migration (the only new migration
on disk, `20260721000000_ingredient_photos.sql`, is spec 127). No RPC change — the
re-submit rides the existing `staff_submit_eod` upsert: `on conflict (store_id, date,
vendor_id) do update` + delete-then-insert of `eod_entries` (migration lines 145-154),
so EDIT→Submit overwrites cleanly with no new write surface. No `db.ts` touch for 129
(grep clean); `submittedStatus.ts` reads `supabase` directly, correctly staying inside
the documented `src/screens/staff/` carve-out — same posture as `fetchExistingSubmission`
/ `fetchYesterdayIncomplete`. RLS/realtime unaffected.

**(2) `submittedStatus.ts` matches the design.** One scoped select
(`select vendor_id ... eq store_id ... eq date`) folded to a `Set<string>`, null
`vendor_id` skipped, best-effort (throw → `notifyBackendError` → empty Set, no false
green). Keyed on (store, countIso). Fetched in the vendor-load effect keyed on
`[activeStore, countDate, countIso]`, cancelled-guarded (EODCount.tsx:461-471).
See Minor note 1 on the added `status` predicate.

**(3) Derived state machine matches.** `existing` + client-only `editing` derive
UNSUBMITTED / SUBMITTED_LOCKED / EDITING exactly per the design table (no `mode` enum).
`inputsLocked = existing != null && !editing` (line 348). Cancel reverts via the shared
`seedFromExisting` helper (lines 354-388) — the load effect and Cancel share one seed
implementation, so the subtle spec-086 legacy-row fallback can't drift. Vendor switch
resets `editing` in the vendor-change effect (line 479, fires on both the guard and load
branches). Read-only via `editable={!inputsLocked}` on both Cases and Units inputs
(lines 858, 881) — the RN-canonical prop, plus a muted `countInputLocked` opacity cue.
EDIT is not gated by the count-complete guard; Submit still carries
`disabled={items.length === 0 || forbidden}` (line 1382).

**(4) Navigate-to-Reorder removed on all branches + queued is optimistic-green.**
No `navigation.navigate('Reorder')` remains, and the now-dead `useNavigation`/`navigation`
binding is fully removed (grep clean in EODCount.tsx). The queued branch (lines 751-769)
adds the vendor to `submittedVendorIds`, synthesizes a local `existing`
(`submission_id: '(queued)'`, `submitted_at: now`, the just-built `entries`), sets
`editing = false`, and does NOT clear `caseCounts`/`unitCounts` — the old §B7 clear is
gone, so the locked inputs still show the entered values. Test at :575-595 pins exactly
this (values retained, `editable === false`, chip "Submitted", `mockNavigate` not called).

**(5) Chip badge is additive, not unified with the spec-126 notification red.** The
selection highlight stays on the Pressable (`backgroundColor: active ? c.primary :
c.surface`); the status dot is a separate absolute-positioned `View`
(`vendorStatusDot`, top-right, surface-colored ring) using `c.success` / `c.error`
(lines 1085-1094), with an inline variant for the lone-vendor row (lines 1117-1133).
It uses the generic error token, independent of the spec-126 notification red-dot
(which lives in the settings/notification components) — the out-of-scope boundary is
respected. i18n keys `eod.edit`, `eod.cancel`, `eod.status.submitted`,
`eod.status.outstanding` are present and at parity across en/es/zh-CN.

## Minor notes (non-blocking)

**Minor 1 — `submittedStatus.ts` adds a `status = 'submitted'` predicate the design §1
query shape omitted.** Design §1 listed only `eq('store_id')` + `eq('date')`; the
implementation also filters `.eq('status', 'submitted')` (submittedStatus.ts:37). This
matches the spec's own `## Files changed` note and the admin convention
(`fetchRecentEodDates` filters the same), and is harmless in practice because the staff
client always writes `p_status: 'submitted'` (useEodSubmit.ts:97) — `eod_submissions.status`
is only ever `'draft' | 'submitted'` and staff never writes `'draft'`. Theoretical
seam: `fetchExistingSubmission` (which drives the state-machine lock) does NOT filter
status, so a hypothetical `'draft'` row for a (store, date, vendor) would lock the inputs
(`existing != null`) while the chip stayed red. Not reachable through the staff surface;
noting only because the two reads of the same table now differ by one predicate. If a
future spec introduces staff-written drafts, reconcile the two filters.

**Minor 2 — the `success-replay` branch skips the authoritative chip reconcile.** The
`success` branch (lines 707-728) does both the optimistic `.add()` and the authoritative
`fetchSubmittedVendorIds` union-reconcile. The `success-replay` branch (lines 729-748)
does only the optimistic `.add()` for the just-submitted vendor and omits the reconcile.
The design said "on the `success` / `success-replay` outcomes ... keep the authoritative
refetch too." Effect is negligible: replay is a rare path, and the only thing missed is
picking up OTHER vendors submitted meanwhile — the current vendor still flips green and
locks correctly. Optional tightening, not a correctness bug.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor
  (both non-blocking): submittedStatus adds a benign `status='submitted'` predicate
  beyond the design query, and the success-replay branch omits the authoritative chip
  reconcile the success branch performs. All 5 requested confirmations hold. No prod
  apply (frontend-only).
payload_paths:
  - specs/129-eod-vendor-status-edit-flow/reviews/backend-architect.md
