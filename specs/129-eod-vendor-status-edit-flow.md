# Spec 129: EOD vendor submission status + submit/edit flow

Status: READY_FOR_REVIEW

## User story
As a store staff member entering the end-of-day count, I want each vendor chip
to show whether that vendor's count is still outstanding or already submitted,
and I want a clear "done / edit" state after I submit — so that I don't
silently re-submit, I don't get bounced off the screen, and I can see at a
glance which vendors I still owe a count for today.

## Acceptance criteria

### Per-vendor chip status (red/green)
- [ ] On the EOD count screen (`src/screens/staff/screens/EODCount.tsx`), each
  vendor chip shows a **RED** status indicator when that vendor has NO
  `eod_submissions` row for the current store + current count date.
- [ ] Each vendor chip shows a **GREEN** status indicator (check/dot) when that
  vendor HAS an `eod_submissions` row for the current store + current count date.
- [ ] The status indicator is **additive/separate** from the existing selection
  highlight — the active/selected chip's green background behavior is unchanged;
  the red/green status indicator is a distinct visual element on the chip.
- [ ] A vendor that has been partially counted but NOT yet submitted still shows
  **RED** (status reflects submission, not in-progress input).
- [ ] Per-vendor submitted status is fetched for ALL of today's vendors (not just
  the selected one), scoped to the current `store_id` + count `date`.
- [ ] After a successful submit for the selected vendor, that vendor's chip flips
  to **GREEN** without a full-screen reload (status refreshes for that
  store/date).

### Submit → EDIT/Cancel state machine (selected vendor)
- [ ] When the selected vendor is NOT submitted for the current date: the
  Cases/Units inputs are **editable** and the primary button reads **"Submit"**.
- [ ] After a successful Submit, the screen **stays on the EOD screen** — it does
  NOT auto-navigate to Reorder (the existing navigate-to-Reorder-on-success
  behavior at `EODCount.tsx:662-681` is removed).
- [ ] After a successful Submit, the count for that vendor **locks read-only**,
  displaying the submitted values, and the primary button reads **"EDIT"**.
- [ ] Tapping **"EDIT"** makes the inputs editable again, seeded from the
  submitted values; the primary button reads **"Submit"**; a **"Cancel"**
  affordance appears.
- [ ] Tapping **"Cancel"** discards the in-progress edits, reverts the inputs to
  the last-submitted values, re-locks the count read-only, and returns the
  primary button to **"EDIT"** (Cancel affordance disappears).
- [ ] Tapping **"Submit"** from the edit state re-submits (UPSERT via the existing
  `staff_submit_eod` RPC), returns to read-only + **"EDIT"**, and the chip stays
  **GREEN**.
- [ ] Selecting a DIFFERENT vendor chip loads that vendor's own state: read-only +
  "EDIT" if already submitted today, editable + "Submit" if not.

### Offline / queued behavior
- [ ] When a submit is queued offline rather than confirmed by the server, the UI
  behaves sanely per the architect's design of the offline path — it does not
  falsely show GREEN/read-only as if the server confirmed. (Exact treatment —
  optimistic vs. pending indicator — is deferred to architect; see Open questions.)

## In scope
- Per-vendor "submitted today" status fetch for the EOD screen's vendor chips
  (generalize `fetchYesterdayIncomplete` in
  `src/screens/staff/lib/yesterdayStatus.ts`, or fan `fetchExistingSubmission`
  across today's vendors — architect's call).
- Red/green status indicator rendering on the vendor chips
  (`EODCount.tsx:957-1002`).
- Refresh of per-vendor status after a submit so the just-submitted chip flips
  green.
- Submit/EDIT/Cancel state machine for the selected vendor, including read-only
  lock of the Cases/Units inputs.
- Removal of the auto-navigate-to-Reorder-on-submit-success behavior
  (`EODCount.tsx:662-681`).

## Out of scope (explicitly)
- **Any backend / RPC / migration change.** `staff_submit_eod` already UPSERTs on
  `(store_id, date, vendor_id)` and replaces `eod_entries` (delete+insert), so
  re-submitting overwrites cleanly — confirmed in
  `20260630000200_staff_submit_eod_multi_vendor.sql`. This spec is UI-only.
- **The Weekly count screen.** Weekly has no vendor tabs and its own draft flow;
  no changes there.
- **Redefining what "counted" means.** Status reflects submission state only.
- **The reserved notification red usage elsewhere** (settings/notif red-dot
  nudge, spec 126). This is a count-screen status color, a separate concern —
  do not touch or unify with the notification red.
- **Admin Cmd UI.** Staff surface only.
- **Realtime.** Staff stack does not use realtime in v1 (spec 062); status is
  fetched on load and refreshed after local submit, not pushed live from other
  clients.

## Open questions resolved
- Q: Should the chip show submission status per vendor? → A: Yes — RED dot until
  submitted for the current date, GREEN check/dot once submitted.
- Q: Does a partially-counted-but-not-submitted vendor show green? → A: No — RED
  until SUBMITTED.
- Q: After submit, navigate to Reorder? → A: No — stay on the EOD screen; lock
  read-only; button becomes EDIT.
- Q: How does the user re-edit a submitted vendor? → A: EDIT button unlocks
  inputs (seeded from submitted values) + shows Cancel; Submit re-submits.
- Q: What does Cancel do? → A: Discard edits, revert inputs to last-submitted
  values, re-lock read-only, button back to EDIT.
- Q: Does the selection-highlight (green chip background) change? → A: No — the
  status indicator is separate/additive; selection highlight stays as-is.

## Open questions for architect / UI (genuinely open)
- Exact placement + form of the red/green indicator on the chip (leading dot,
  trailing check, corner badge) — pick something that reads clearly against both
  the selected (green-background) and unselected chip states without colliding
  with the selection highlight.
- Cancel on a vendor with NO prior submission (e.g. user hit EDIT semantics on a
  never-submitted vendor, or an edge path): confirm Cancel simply clears the
  inputs and returns to the un-submitted editable "Submit" baseline (there is no
  prior-submitted value to revert to).
- Offline-queued submit UX: whether to show an intermediate "pending" chip state
  distinct from confirmed-green, or optimistically show green and reconcile on
  flush. Architect to specify given the staff offline queue (`lib/eodQueue`).

## Dependencies
- Existing RPC `staff_submit_eod` (no change) —
  `supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql`.
- `src/screens/staff/lib/yesterdayStatus.ts` (`fetchYesterdayIncomplete`) as the
  reference/base for the per-vendor "submitted today" query.
- `EODCount.tsx` existing fetch/seed/submit paths:
  `fetchExistingSubmission` (`:199-249`), input seed (`:450-469`),
  `onSubmit` (`:577-711`, navigate-to-Reorder at `:662-681`),
  `selectedVendorId` (`:277`), chip render (`:957-1002`).
- Staff offline queue `src/screens/staff/lib/eodQueue` for the offline path.

## Project-specific notes
- Cmd UI section / legacy: neither — this is the **staff EOD surface**
  (`src/screens/staff/screens/EODCount.tsx`), peer to `cmd/` (spec 063).
- Per-store or admin-global: **per-store** — status is fetched scoped to the
  current `store_id` + count `date`.
- Realtime channels touched: none — staff stack has no realtime in v1 (spec 062);
  status refreshes on load + after local submit only.
- Migrations needed: **no**.
- Edge functions touched: **none** (staff writes go through the `staff_submit_eod`
  RPC via PostgREST; the `staff-*` edge functions are retired 410 stubs, spec 061).
- Web/native scope: **both** — staff app ships web (Vercel) and native (EAS); no
  web-only or native-only surface in this change. Read-only input lock must work
  on both.
- Tests: **jest** track — the staff subtree already stubs `fetchYesterdayIncomplete`
  as a mock seam (see `yesterdayStatus.ts` header); the per-vendor status helper
  should follow the same mockable-seam shape, and the EOD screen tests should
  cover the Submit → read-only/EDIT → EDIT → Cancel-reverts / Submit-re-locks
  transitions and the red/green chip status. No pgTAP (no DB change) and no shell
  smoke needed.
```

## Backend design

**Posture: frontend-only. No migration, no RPC change, no edge function, no pgTAP.**

### No-backend-change confirmation

Confirmed the posture holds. The editing path needs no new write surface:

- `staff_submit_eod` (`supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql`)
  already UPSERTs the `eod_submissions` row on `(store_id, date, vendor_id)` and
  replaces `eod_entries` (delete-then-insert). Re-submitting the SAME
  `(store, date, vendor)` overwrites cleanly — this is exactly the "EDIT then
  Submit" case. Editing is therefore just a second call through the existing
  `useEodSubmit().submit()` outcome contract; the client already routes that
  outcome (`success` / `success-replay` / `forbidden` / `queued` / `failed`).
- Reading which vendors are submitted today is a plain PostgREST `select` on
  `eod_submissions` scoped to `(store_id, date)` — the same table + RLS path the
  screen already reads via `fetchExistingSubmission`. Per-store RLS
  (`auth_can_see_store`) already governs that table; no policy change.
- No new columns are needed. "Submitted" = a row exists; the state machine is
  derived entirely from the existing `existing` (ExistingSubmission | null) plus
  a new client-only `editing` boolean.

**RLS impact:** none. **Realtime impact:** none (staff stack has no realtime in
v1, spec 062; status refreshes on load + after local submit). **`src/lib/db.ts`
surface:** none — this lives entirely in the `src/screens/staff/` carve-out
subtree, which reads `supabase` directly per the spec 063 documented carve-out.
This is not a new pattern; it mirrors the sibling helpers `fetchVendorsForToday`,
`fetchExistingSubmission`, and `fetchYesterdayIncomplete` already colocated in
this screen / `lib/`.

### 1. Per-vendor "submitted today" status fetch

New helper, new module for a clean mock seam (mirrors `yesterdayStatus.ts`'s
rationale header verbatim):

`src/screens/staff/lib/submittedStatus.ts`

```ts
// Returns the set of vendor_ids that have an eod_submissions row for the
// given store + count date. Best-effort by contract: the caller treats a
// thrown error as "empty set" (no false green). Staff carve-out — direct
// supabase read, same posture as fetchExistingSubmission / fetchYesterdayIncomplete.
export async function fetchSubmittedVendorIds(
  storeId: string,
  countIso: string,   // local YYYY-MM-DD — the same countIso the screen keys on
): Promise<Set<string>>;
```

Query shape (single round-trip, no join — we only need the vendor ids):

```
supabase.from('eod_submissions')
  .select('vendor_id')
  .eq('store_id', storeId)
  .eq('date', countIso)
```

Collect non-null `vendor_id` into a `Set<string>` and return. This is the
generalization the spec asked for: `fetchYesterdayIncomplete` does the same
`eod_submissions` read but folds it to a boolean against yesterday's schedule;
here we surface the raw Set against the current `countIso` so the chip row can
color each chip independently. (We deliberately do NOT fan N `fetchExistingSubmission`
calls across today's vendors — that would be N round-trips and pull full entry
rows we don't need. One scoped select is strictly better.)

**Where it slots into EODCount.tsx.** Add a state slice next to the existing
vendor state:

```ts
const [submittedVendorIds, setSubmittedVendorIds] = useState<Set<string>>(new Set());
```

Fetch it in the SAME effect that loads the vendor list (the
`fetchVendorsForToday` effect keyed on `[activeStore, countDate]`, ~:393-410),
because both are scoped to `(store, date)` and both must refresh when the
Today/Yesterday toggle flips the count date. Fetch it best-effort in parallel
(don't block the vendor list on it):

- On success → `setSubmittedVendorIds(ids)`.
- On error → `setSubmittedVendorIds(new Set())` (no false green; matches the
  `fetchYesterdayIncomplete` best-effort posture).
- Guard with the existing `cancelled` pattern used by the yesterday-incomplete
  effect so a store/date switch mid-flight can't land a stale set.

**Refresh after a successful submit (red→green flip).** On the `success` /
`success-replay` outcomes, and on the optimistic `queued` outcome (see §3c), add
the just-submitted `selectedVendorId` to the set immediately so the chip flips
without a round-trip:

```ts
setSubmittedVendorIds((prev) => new Set(prev).add(selectedVendorId));
```

Keep the authoritative refetch too (re-run `fetchSubmittedVendorIds` after the
confirmed refetch of `existing`) so the set reconciles with the server on the
confirmed path — but the optimistic `.add()` is what makes the flip feel
instant. The existing `submitTick` bump already re-runs the yesterday effect;
reuse the same `submitTick` dependency for a status refetch OR fold the refetch
into the `onSubmit` success block next to the `fetchExistingSubmission` refresh
(architect's preference: fold it into `onSubmit` alongside the `existing`
refetch, so the two reads that both key on `(store, countIso)` stay together).

### 2. Selected-vendor submit → EDIT/Cancel state machine

New client-only state, added next to `existing`:

```ts
const [editing, setEditing] = useState<boolean>(false);
```

The three states are DERIVED, not stored — no `mode` enum. Derivation:

| Condition                          | State            | Inputs   | Primary button | Cancel | Chip  |
|------------------------------------|------------------|----------|----------------|--------|-------|
| `existing == null`                 | UNSUBMITTED      | editable | "Submit"       | hidden | red   |
| `existing != null && !editing`     | SUBMITTED_LOCKED | read-only| "EDIT"         | hidden | green |
| `existing != null && editing`      | EDITING          | editable | "Submit"       | shown  | green |

Transitions:

- **EDIT tap** (only rendered in SUBMITTED_LOCKED): `setEditing(true)`. Inputs
  are already seeded from `existing` (the vendor-change effect at :430-469
  seeds `caseCounts`/`unitCounts` from `existing` on load), so unlocking shows
  the submitted values with no re-seed needed.
- **Cancel tap** (only rendered in EDITING): re-seed `caseCounts`/`unitCounts`
  from `existing` (reuse the exact seed logic from the vendor-change effect —
  factor the case/unit seed into a small `seedFromExisting(existing)` helper so
  the effect and Cancel share one implementation and can't drift), then
  `setEditing(false)`. Returns to SUBMITTED_LOCKED.
- **Submit tap from EDITING**: unchanged `onSubmit` path. On `success` /
  `success-replay`: refetch `existing`, `setEditing(false)` (→ SUBMITTED_LOCKED),
  refresh `submittedVendorIds`. Chip stays green.
- **Submit tap from UNSUBMITTED**: unchanged `onSubmit` path. On success:
  `existing` becomes non-null via the refetch, `editing` is already false →
  SUBMITTED_LOCKED, chip flips green.
- **Vendor switch**: the vendor-change effect (:413-479) MUST also
  `setEditing(false)` so a new vendor always lands in its own derived state
  (UNSUBMITTED or SUBMITTED_LOCKED per its own `existing`). Add `setEditing(false)`
  to both the guard-clause branch (no vendor) and the load branch.

**Button wiring.** The footer `Button` (:1243-1249) currently always reads
`t('eod.submit')` and calls `onSubmit`. Change to:

- SUBMITTED_LOCKED → label `t('eod.edit')` (new i18n key), `onPress` =
  `() => setEditing(true)`, not `onSubmit`.
- UNSUBMITTED / EDITING → label `t('eod.submit')` (or `t('eod.submitting')`
  while submitting), `onPress` = `onSubmit`.
- Cancel affordance in EDITING: a secondary `Button`/`Pressable` in the footer
  `submitWrap` row, label `t('eod.cancel')` (new key), `onPress` = the Cancel
  handler above. Hidden otherwise.

The `disabled={items.length === 0 || forbidden}` guard stays for the Submit
label; EDIT should NOT be disabled by the count-complete gate (you're just
unlocking).

**Read-only mechanism for Cases/Units inputs.** `renderEodRow` builds two
`Input`s (:776, :796). The lock must work on web AND native. Pass a derived
`readOnly` down into `renderEodRow` (add it to the `useCallback` deps):

```ts
const inputsLocked = existing != null && !editing; // SUBMITTED_LOCKED
```

Preferred mechanism: `editable={!inputsLocked}` on the `TextInput`/`Input` —
this is the RN-canonical read-only prop, honored by react-native-web (renders
`readonly` on the DOM input) and native alike, and it keeps the value visible
(unlike `pointerEvents` which only blocks touch and leaves a focus/caret gap on
web). Confirm the staff-local `Input` component forwards `editable` to its inner
`TextInput`; if it doesn't, that forward is a one-line addition (surface to the
developer). Give locked inputs a muted style cue (e.g. `backgroundColor:
c.surfaceAlt` / reduced opacity) so read-only reads visually, but that's
cosmetic. Do NOT rely on `pointerEvents="none"` as the primary lock.

### 3. Resolved open UI questions

**(a) Indicator placement.** A small status dot/check badge on the chip's
top-right corner — additive to, and independent from, the existing selection
background highlight (which stays exactly as-is: `c.primary` bg when
`active`). The corner badge is a ~10px dot: `c.error` (red) when the vendor id
is NOT in `submittedVendorIds`, `c.primary`/green (a check glyph or filled dot)
when it IS. Absolute-position it in the chip's top-right so it reads against
both the unselected (surface bg) and selected (primary bg) chip — give it a thin
surface-colored ring/border so a green dot stays legible on the green selected
background. This is the "distinct visual element" AC-3 requires. Explicitly do
NOT reuse or unify with the notification red-dot (spec 126) — separate concern,
separate token usage, per the out-of-scope note. Also apply the status to the
single-vendor label branch (:1003-1018) for consistency, OR accept that the lone
static "Vendor: X" label carries no dot (recommend: add the dot there too so a
one-vendor day still shows red/green — small, keeps the model uniform). Flag the
single-vendor dot as a minor/optional call for the developer.

**(b) Cancel with no prior submission → N/A by construction. Confirmed.** Cancel
is rendered ONLY in the EDITING state, and EDITING is reachable ONLY from
SUBMITTED_LOCKED (via EDIT), which requires `existing != null`. There is no
transition into EDITING from UNSUBMITTED. Therefore Cancel always has a prior
`existing` to revert to; the "clear inputs to blank baseline" edge path cannot
occur. No special-casing needed. (Defensive note for the developer: the Cancel
handler should still no-op safely if `existing == null` — e.g. guard
`if (!existing) { setEditing(false); return; }` — purely as belt-and-suspenders,
not a reachable path.)

**(c) Offline-queued submit UX → optimistic green, remove the auto-navigate.**
When `submit()` returns `kind: 'queued'` (offline or network error), treat it
optimistically:

- Add `selectedVendorId` to `submittedVendorIds` → chip flips green immediately.
- Transition to SUBMITTED_LOCKED. Since the confirmed `existing` refetch won't
  return the just-queued row (it isn't on the server yet), synthesize a local
  `existing` from the entries just submitted so the lock has values to display:
  set `existing` to `{ submission_id: '(queued)', submitted_at: new Date().toISOString(), entries }`
  (the same `entries` array built in `onSubmit`), and `setEditing(false)`. This
  keeps the current inputs shown as the locked/submitted values and reads as
  "done" — the queue will drain and reconcile.
- REMOVE the current `setCaseCounts({}) / setUnitCounts({})` clear on the queued
  branch (:698-700) — clearing would wipe the values the lock now displays.
- REMOVE `navigation.navigate('Reorder')` on ALL branches (see below).

**Recommendation: keep it simple (optimistic green) for v1.** A distinct
"pending sync" chip state (amber, or a third color) is explicitly OPTIONAL and
flagged as a future enhancement — the footer already surfaces sync state via the
existing `QueueIndicator` (`pending` / `draining`, :1241), so the queued item is
not invisible to the user even without a per-chip pending cue. If the developer
wants a minimal cue, a subtle title-attr / a11y label on the chip
("submitted — pending sync") is acceptable, but not required for AC. AC-"offline"
says the UI "does not falsely show GREEN/read-only as if the server confirmed" —
we satisfy this via the footer QueueIndicator remaining the source of truth for
"not yet synced"; the chip green here means "counted + locked locally", which is
the honest optimistic state given the offline queue is durable and will drain.
(If the release reviewers judge optimistic-green too strong a claim, the
fallback is: on `queued`, lock read-only + EDIT but leave the chip a distinct
amber until drain — the developer can implement the amber variant behind the
same `submittedVendorIds`/a parallel `queuedVendorIds` set. Recommended posture
stays simple/green for v1.)

### Remove auto-navigate-to-Reorder — confirmed

Confirmed: remove `navigation.navigate('Reorder')` from the `success`
(:681) and `success-replay` (:689) branches, and do NOT add it to `queued`.
The screen stays put after submit; the vendor locks read-only + EDIT and the
chip goes green in place. The `useNavigation` import / `navigation` binding can
be dropped if it's now unused (verify no other consumer in the file — the header
store-switch uses `setActiveStore`, not navigation; so it likely becomes dead —
developer to remove the now-unused `navigation` + its comment at :258-259).

### jest surface (staff track)

New / updated tests (mockable-seam shape, same as `yesterdayStatus.test.ts`):

1. `src/screens/staff/lib/submittedStatus.test.ts` (new) — unit test the helper:
   returns the Set of vendor ids with a row for `(store, date)`; empty Set when
   none; swallows a thrown query error into an empty Set (best-effort contract);
   ignores null `vendor_id` rows.
2. `src/screens/staff/screens/EODCount.test.tsx` (extend) — mock
   `fetchSubmittedVendorIds` + `fetchExistingSubmission` + `useEodSubmit` and
   assert:
   - **Chip color from the Set** — a vendor in the set renders the green badge;
     one not in the set renders the red badge; selection highlight is unchanged
     (independent of the badge).
   - **State-machine transitions**:
     - `existing == null` → inputs editable + button "Submit" (UNSUBMITTED).
     - after a `success` submit → button "EDIT" + inputs read-only + chip green,
       and NO navigation to Reorder fired.
     - `existing != null` on load (already submitted) → SUBMITTED_LOCKED
       (read-only + "EDIT"), no Cancel.
     - EDIT tap → inputs editable + "Submit" + Cancel shown (EDITING).
     - Cancel tap → inputs revert to submitted values + re-lock + "EDIT" + Cancel
       gone.
     - Submit from EDITING (re-submit) → back to read-only + "EDIT", chip stays
       green (assert the re-submit went through `submit()`).
   - **Read-only lock** — inputs carry `editable={false}` (or equivalent
     read-only prop) in SUBMITTED_LOCKED and `editable={true}` in
     UNSUBMITTED/EDITING.
   - **Vendor switch resets editing** — switching chips from an EDITING vendor to
     another lands the new vendor in its own derived state (not EDITING).
   - **Queued path (offline)** — `submit()` returns `queued` → chip green +
     SUBMITTED_LOCKED, inputs NOT cleared, no navigation fired.

No pgTAP (no DB change), no shell smoke.

### Risks / tradeoffs

- **Optimistic-green vs. server truth (offline).** Documented above; QueueIndicator
  remains the authoritative "not synced" surface. Low risk given the durable
  queue; flagged for reviewer judgment.
- **`existing` refetch race on the confirmed path.** The vendor-change effect and
  the post-submit refetch both write `existing`/`submittedVendorIds`; keep the
  `cancelled`/guard pattern so a fast vendor-switch after submit can't land a
  stale write. Same shape as the yesterday-incomplete effect already in the file.
- **`Input` `editable` forwarding.** If the staff-local `Input` doesn't forward
  `editable`, the lock silently no-ops. The developer must verify the forward
  (one-line fix if missing) and the test asserting `editable={false}` guards
  against regression.
- **Seed-logic duplication.** Cancel must re-seed identically to the load effect;
  factor `seedFromExisting` once to prevent the two paths drifting (the load
  effect's legacy-row fallback logic at :457-462 is subtle and must not be
  re-derived by hand in Cancel).
- **Perf on the 286 KB seed.** Negligible — one extra scoped `select vendor_id`
  per store/date, no join, tens of rows.

## Handoff
next_agent: frontend-developer
prompt: Implement against the ## Backend design in this spec. It is
  frontend-only — no migration, RPC, edge function, or pgTAP. Add
  `src/screens/staff/lib/submittedStatus.ts` (`fetchSubmittedVendorIds`), wire the
  per-vendor red/green corner badge on the vendor chips, implement the
  derived UNSUBMITTED / SUBMITTED_LOCKED / EDITING state machine (via a new
  `editing` boolean + read-only `editable` lock on the Cases/Units inputs),
  remove the post-submit navigate-to-Reorder, and apply the optimistic-green
  queued path. Add the named jest tests. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/129-eod-vendor-status-edit-flow.md

## Files changed

### New
- `src/screens/staff/lib/submittedStatus.ts` — `fetchSubmittedVendorIds(storeId, countIso)`:
  one scoped `select vendor_id from eod_submissions where store_id = ? and
  date = ? and status = 'submitted'`, folded to a `Set<string>`. Best-effort —
  degrades to an empty Set + `notifyBackendError` on any error.
- `src/screens/staff/lib/submittedStatus.test.ts` — unit tests: query scoping,
  returns the id Set, empty when none, ignores null vendor_id, degrades to empty
  on a query error.

### Modified
- `src/screens/staff/screens/EODCount.tsx`
  - New state: `editing` (client-only) + `submittedVendorIds` (`Set<string>`).
  - Fetch per-vendor submitted status in the vendor-load effect (keyed on
    store + countIso, best-effort, cancelled-guarded).
  - Per-vendor red/green corner badge on each vendor chip + on the single-vendor
    label (`eod-vendor-status-<vendorId>`, surface-colored ring, a11y label).
  - Derived UNSUBMITTED / SUBMITTED_LOCKED / EDITING state machine: footer button
    reads Submit / Edit; Cancel shown only in EDITING; `inputsLocked` drives
    `editable={false}` + a muted style on the Cases/Units inputs.
  - `seedFromExisting` helper shared by the load effect and the Cancel revert.
  - Vendor switch resets `editing`.
  - `onSubmit`: removed `navigation.navigate('Reorder')` (all branches) and the
    now-dead `useNavigation`/`navigation` binding; success/replay refetch
    `existing` + lock read-only + optimistic-green (union reconcile); queued path
    is optimistic-green + synthesized local `existing`, no longer clears inputs.
  - New styles: `vendorStatusDot`, `vendorStatusDotInline`, `vendorSingleRow`,
    `countInputLocked`; `submitWrap` gains a gap for the stacked Cancel/Submit.
- `src/screens/staff/screens/EODCount.test.tsx` — added `fetchSubmittedVendorIds`
  mock seam; replaced the navigate-to-Reorder test with a stays-on-screen
  assertion; replaced the queued-clears-inputs test with the optimistic-locked
  behavior; new `spec 129` describe block covering chip red/green from the Set
  and all state transitions (Submit→locked+Edit, load-locked, Edit→editable+Cancel,
  Cancel→revert+relock, Submit-from-edit→relock, vendor-switch resets editing).
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json` — added `eod.edit`,
  `eod.cancel`, and `eod.status.submitted` / `eod.status.outstanding` (badge a11y
  labels), all three locales at parity.

### Not changed (verified sufficient)
- `src/screens/staff/components/Input.tsx` — already forwards `editable` to its
  inner `TextInput` via `{...rest}`; no change needed (the design flagged this as
  a possible one-liner). The `editable={false}` read-only lock is exercised by the
  new tests.
