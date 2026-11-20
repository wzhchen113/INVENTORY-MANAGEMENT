# Spec 192: Admin EOD drafts and EDIT stay on their own date

Status: READY_FOR_REVIEW

Origin: a bug reproduced on 2026-11-09 through the real Cmd UI on the local stack (desktop, 1440x900, admin@local.test, Frederick, today Monday 2026-11-09). The full reproduction is `eod-date-leak-repro.md` in session notes `local_59c894ad-1b64-4d3b-bdda-19117741b767`. Its figures are cited here, not re-derived. Code facts were read from the working tree on 2026-11-09, when `EODCountSection.tsx` had no uncommitted diff (spec 189 not yet built). Line numbers are pointers and predate 189's build. Re-read them once 189 lands.

**Urgency:** a real wrong-data path, not an incident. One click on another day in the week list is enough to file one day's counts under another day, and the success toast is the only place the date shows.

## User story

As a **store admin or owner counting or correcting EOD for a particular day**, I want the worksheet to show and submit only that day's values, so that picking another day in the week list never files one day's counts under another day.

## The bug

### Measured (local stack, real UI, from the reproduction)

| Run | Steps | Result |
|---|---|---|
| 1. Typed values, no EDIT | Monday selected, BJs tab, typed Caramel Mouse 1 case and Carrot Cake 8" 2 cases, did not submit. Picked **Sunday** | Sunday's worksheet showed **1 and 2**, "2 of 9 items counted", footer est. value $55.00. Marked the other 7 NO NEED, pressed SUBMIT COUNT. Toast "Count submitted, 9 items · 2026-11-08". DB: one BJs submission **dated 2026-11-08**, 9 entries (6 each / 1 case, 20 each / 2 cases, 7 no_need) |
| 2. EDIT | Re-entered the section (state reset). Sunday BJs SUBMITTED · LOCKED. EDIT, changed Caramel Mouse to 3. Picked **Saturday** (no submission for any vendor) | Saturday stayed in **EDIT**: the "Amending submitted count. Press UPDATE COUNT to overwrite the prior submission." banner, the **UPDATE COUNT** button, values 3 / 2 and the 7 NO NEED marks. UPDATE COUNT created a **new** BJs submission **dated 2026-11-07** (18 each / 3 cases, 20 / 2). Sunday's row unchanged (1 / 2) |
| Both | Worksheet header | Read **"Monday, Nov 9"** throughout, whichever day was selected |

So the typed path and the EDIT-seed path both write to whichever date is selected at submit time. The banner's "overwrite the prior submission" was also false in run 2: there was no prior submission for Saturday.

### Root cause (read from code)

In [EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx):

- `caseCountsByVendor`, `unitCountsByVendor`, `notesByVendor`, `noNeedByVendor` (L235-242) and `editingVendorIds` (L246) are keyed by vendor only.
- `setSelectedIso` is passed raw to the desktop week list (L1421), the inline phone-width strip (L1489) and the phone model (L1319). Nothing resets or re-keys on a date change.
- Everything that reads those maps therefore reads the same values on every date:
  - the worksheet rows, counter and footer (`localHasEntry`, `itemTotal`, `estValue`, L762-784);
  - the completeness gate, through `deriveCountedItemIds` arms (a) and (c) (L118-145), which read every vendor's typed map with no date;
  - `buildSubmission` (L880), which stamps `selectedIso` on whatever is in the maps;
  - the count export, `buildExportGroups` (L798-821), which labels the file with `selectedIso`;
  - `onEditCurrentVendor` (L609-666), whose "local value wins over the seed" rule (L628) lets one date's typed values beat another date's submission.
- The success clear (L1038-1047) clears the vendor's maps and EDIT flag for every date at once.
- `additionalItems` (L333), the rows added through + COUNT, is session-wide across dates and vendor tabs. A row added on Monday also appears on Sunday, carrying Monday's value.
- **Header:** L1534 renders `new Date().toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })`. That's always today, never the selected day, and always English. The phone header ([PhoneEodCount.tsx](../src/screens/cmd/sections/eod/PhoneEodCount.tsx) L266) already uses `model.selectedIso` and the app locale.

### Read from code, not run

- **Phone.** `PhoneEodCount` reads `caseCounts`, `unitCounts`, `noNeed`, `isCurrentVendorEditing` and `onSubmit` from the shared model and calls `model.setSelectedIso` (L279), so the same leak applies.
- **Store switch.** Vendors are brand-scoped (`vendors.brand_id`), the section isn't keyed by store ([InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx) L367), and nothing resets `editingVendorIds` when `currentStore.id` changes. EDIT on BJs at one store probably carries to the other store's BJs tab. Typed values don't show there, because item ids are per store, and `buildSubmission` only ships current-store items.
- **Leaving the section** resets everything (observed in run 2).

### Existing behaviours a cross-date submit triggers (not this bug)

Observed in the reproduction. Listed so nobody fixes them here by accident:

- `inventory_items.current_stock` and `eod_remaining` move to the back-dated values (Caramel Mouse 18, Carrot Cake 20), and `last_updated_by` is set. Spec 189 removes the client's `adjustItemStock`, but its server writer still applies the spec 102 on-hand rule for any date.
- 2 `audit_log` rows per counted item and 1 per NO NEED item.
- An `order_ready` `notifications` row per submit, and `in_app_notifications` text "submitted **today's** EOD count (BJs)" even when back-dated.

## Interaction with spec 189

[Spec 189](189-admin-eod-resubmit-replace.md) is READY_FOR_BUILD, and its build is in progress in another session as of 2026-11-09 (uncommitted diff in `EODCountSection.tsx`, `db.ts` and two EOD tests). It changes the same file and the same functions:

- `buildSubmission` stops filtering by `filteredItems` (189 D-4, design §5). **That makes this bug worse once 189 lands:** a value left under another category pill on another date would ship too, not only the visible ones.
- `onEditCurrentVendor` gets a seed fix (only non-blank local values beat the seed).
- It adds a **baseline** keyed `${storeId}|${dateIso}|${vendorId}`, used to tell "blanked" from "never touched". Its design §5 says the removal path can't fire across dates for that reason, but the input maps and EDIT flags still can.
- `submitEODCount` keeps its name and `track(..., { kind: 'write' })` wrapper but calls the new `admin_submit_eod` RPC (189 design, `db.ts` section).
- 189 design §5 ("Pre-existing bug found, not fixed: counts can leak across dates") and §15 item 3 flag this bug and recommend a small separate spec. This is that spec.

**Order (Q5, owner-confirmed 2026-11-09): this spec is built after 189 lands,** on top of 189's code. It keys the input maps and EDIT flags the same way 189 keys its baseline, so there is one slot key for all per-day draft state. The build of this spec doesn't start until 189's build is committed. AC-19 and AC-20 test the interplay and are unconditional.

## Requirements

- **R1. One slot per (store, date, vendor).** Typed case and unit values, notes, NO NEED marks and the EDIT flag belong to one (store, date, vendor) slot. Drafts are kept per slot for the session: picking another date or store hides the first slot's values, and returning shows them again. The worksheet, counter, footer, completeness gate, export and submit for a selected date read only that date's slots at the current store.
- **R2. Submits stay on their slot.** A SUBMIT, UPDATE COUNT or SAVE DRAFT ships only the values in the slot it was started from, dated with that slot's date. Its success clear, EDIT exit and 189's baseline update touch only that slot, even if the user picks another date while the request is in flight.
- **R3. EDIT reflects the selected date's status.** EDIT is per (store, date, vendor). Another date opens locked or unlocked by its own submission status. The editing banner and UPDATE COUNT label appear only when the selected date's vendor is in EDIT. Returning to the EDIT date resumes EDIT with the edited values.
- **R4. Header shows the selected date** in the app's locale (`useLocale()`), same format as today (long weekday, short month, day), built from local midnight of `selectedIso` so it can't shift a day.
- **R5. + COUNT rows belong to one (store, date).** A row added through + COUNT appears only on the (store, date) it was added on, and stays shared across vendor tabs on that date, as today.
- **R6. Nothing else changes.** Vendor-tab draft preservation within a date (spec 020 Q4), the completeness gate rules, spec 102 counted-once-globally within a date, spec 171 count modes, spec 172 NO NEED, spec 103 custom order, spec 139 export format, spec 184 empty states and the backend (as 189 leaves it) all stay as they are.

## Owner decisions (2026-11-09)

The owner answered "All defaults OK", so each question takes its recommended default. The questions are kept here, without the rejected alternatives, so the rationale stays with the spec.

### Q1. What happens to typed-but-unsubmitted values when the admin picks another date?
**Decided: keep them per date for the session.** Each date shows only its own values, and returning to the first date shows them again. This matches how vendor-tab switching already preserves drafts (spec 020 Q4) and loses nothing. Drafts still vanish on reload or on leaving the section, as today. No confirm, no discard, no blocking of date changes.

### Q2. What happens to EDIT mode on a date change?
**Decided: EDIT is per (date, vendor)** (and per store, from Q4). Another date opens locked or unlocked by its own submission status, and returning to the EDIT date resumes EDIT with the edited values.

### Q3. What should the worksheet header show?
**Decided: the selected date, in the app locale** (`useLocale()`), same format as today (long weekday, short month, day), built from local midnight of `selectedIso`. Today's date is not shown alongside it; the week list already marks today.

### Q4. Include store switch?
**Decided: include.** Drafts and EDIT are scoped by store too, since it's the same keying change and spec 189's baseline key already has the store in it. Returning to a store shows that store's drafts and EDIT state again.

### Q5. Ordering with spec 189?
**Decided: after 189**, building on its slot key `${storeId}|${dateIso}|${vendorId}`.

### Q6. Rows added through + COUNT
**Decided: key `additionalItems` by (store, date), and keep it cross-vendor as today.** A + COUNT on Monday then doesn't add a row to Sunday, and Sunday's completeness gate doesn't ask for it.

## Acceptance criteria

Track for all automated ACs: **jest**, rendering the full `EODCountSection` with the harness the existing EOD suites use (inert `db.ts` Proxy, stubbed supabase, `mockIsPhone` toggle, `submitEOD` spy), for example [EODCountSection.noNeed.spec172.test.tsx](../src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx). Phone arms render the full section with `mockIsPhone = true`, not `PhoneEodCount` alone, because the leak lives in the parent's state. Fixtures use dates relative to today (D0 = today, D-1, D-2, D-3), since the week list is the last 7 days. Below, "submits with" means the `submitEOD` spy and the `submitEODCount` mock (as 189 leaves it, calling `admin_submit_eod`) each receive that submission.

### Typed values (Q1)
- [ ] **AC-1:** Desktop. On D0, BJs tab, type item A = 1 case, item B = 2 units. Select D-1 (no submission). A and B are blank, the counter excludes them, and the footer est. value doesn't include them. Select D0 again: A = 1 and B = 2 are back. (jest)
- [ ] **AC-2:** Same for notes and NO NEED: a note on A and NO NEED on C on D0 aren't shown on D-1, and come back on D0. (jest)
- [ ] **AC-3:** Run 1 negative. With AC-1's D0 values still typed, on D-1 count every BJs item and SUBMIT. It submits once, with `date` = D-1 and only the values typed on D-1. No entry carries a D0 value. Return to D0: A = 1, B = 2 are still there. (jest)
- [ ] **AC-4:** Gate. An item typed only on D0 isn't counted on D-1: SUBMIT on D-1 is blocked by the "Count every item first" gate naming it as missing, and the "N of M" counter on D-1 doesn't include it. `deriveCountedItemIds` (exported) reads only the selected (store, date) slots in arms (a) and (c). Arm (b), submissions for the date, is unchanged. (jest, including a pure arm on `deriveCountedItemIds`)
- [ ] **AC-5:** Within one date, vendor-tab switching still keeps drafts: type on BJs, switch to Costco and back on the same date, values intact. Counted-once-globally (spec 102) still works across vendor tabs on the same date. (jest)
- [ ] **AC-6:** A successful SUBMIT on (D-1, BJs) clears only that slot. D0's BJs values and D-1's other vendor tabs keep theirs. (jest)
- [ ] **AC-7:** Export. On D-1, the EOD CSV export holds only D-1's typed values. A typed only on D0 is blank. On D0 it holds A = 1. (jest, through the `downloadCSV` stub as in the spec 172 suite)

### In-flight submit (R2)
- [ ] **AC-8:** On D-1 press SUBMIT with `submitEODCount` held pending. Select D0, then resolve it. The submission was dated D-1. The D-1 slot is cleared and its EDIT flag dropped. D0's values and EDIT state are untouched, and the success toast names D-1. (jest)
- [ ] **AC-9:** Same, but the write rejects. The existing `savedLocally` / `cloudFailed` toast shows, the D-1 slot keeps its values and EDIT state, and D0 is untouched. Covers SAVE DRAFT too. (jest)

### EDIT (Q2)
- [ ] **AC-10:** Run 2 negative. BJs has a submitted count on D-1, none on D-2. On D-1 press EDIT, change A to 3. Select D-2: no editing banner, the button reads SUBMIT COUNT, and A shows D-2's own value (blank). Fill D-2 and submit: it submits with `date` = D-2 and only D-2's values. Nothing is submitted for D-1. (jest)
- [ ] **AC-11:** Continue AC-10 before submitting D-2: select D-1 again. EDIT resumes: banner, UPDATE COUNT, A = 3. (jest)
- [ ] **AC-12:** BJs submitted on both D-1 and D-3. EDIT on D-1, then select D-3: D-3 shows SUBMITTED · LOCKED with the EDIT button, and its values are D-3's submitted values, read-only. (jest)
- [ ] **AC-13:** EDIT seeds only its own slot. Type A = 5 on D0 for BJs, then on D-1 (BJs submitted with A = 1) press EDIT: A shows 1, not 5. (jest)
- [ ] **AC-14:** A successful UPDATE COUNT on (D-1, BJs) ends EDIT for that slot only. EDIT on (D-3, BJs), if entered, remains. (jest)

### Header (Q3)
- [ ] **AC-15:** Desktop header text equals the selected date formatted with the app locale, `{ weekday: 'long', month: 'short', day: 'numeric' }`, from `selectedIso + 'T00:00:00'`. Checked for D0 and D-1, and with the locale set to `es`. The test computes the expected string the same way, so it doesn't depend on the runtime's ICU data. (jest)
- [ ] **AC-16:** Phone header is unchanged (week number and month / year from `selectedIso`). (jest)

### Store switch (Q4)
- [ ] **AC-17:** Stores S1 and S2 share brand vendor BJs. EDIT on (S1, D-1, BJs), switch to S2: BJs on D-1 opens by S2's own status (locked if submitted there, otherwise SUBMIT COUNT, never the editing banner). Switch back to S1: EDIT resumes with its values. Typed S1 values come back too. (jest)

### Phone
- [ ] **AC-18:** With `mockIsPhone = true`, repeat AC-1, AC-3, AC-10 and AC-11 through the day strip and the keypad sheet. Same results. (jest)

### Spec 189 interplay (Q5)
- [ ] **AC-19:** On D-1 EDIT BJs and blank A. Select D-2, fill and submit: the call carries no removal for A, and D-1's baseline is unchanged. Return to D-1 and UPDATE COUNT: the removal for A is sent with `date` = D-1. (jest)
- [ ] **AC-20:** With 189's pill-agnostic payload: a value typed on D0 under another category pill doesn't ship with a D-1 submit. (jest)

- [ ] **AC-24 (189 residual, added 2026-11-09 at the 189 session's request):** On D0, BJs, item A has a value that is in D0's baseline (saved by SAVE DRAFT or seeded by EDIT). Select D-1 and blank item A's box there without submitting. Return to D0 and SUBMIT or UPDATE COUNT: the call carries **no removal for A**, and A's D0 value is unchanged. Before 192 this path deleted a saved D0 count (spec 189 `reviews/code-reviewer.md` S1 and `reviews/release-proposal.md` "residual the narrow fix doesn't close"). (jest)

### + COUNT rows (Q6)
- [ ] **AC-21:** A row added through + COUNT on D0 doesn't appear on D-1 and isn't asked for by D-1's gate. It appears again on D0. It still appears across vendor tabs on D0. (jest)

### Gates and manual
- [ ] **AC-22:** The existing EOD suites pass, unmodified unless the design says why: `EODCountSection.countedOnce`, `.customOrder`, `.emptyState.spec184`, `eod/__tests__/EODCountSection.acReg`, `.countMode.spec171`, `.noNeed.spec172`, `PhoneEodCount`, plus any EOD suites spec 189 adds or changes. Full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass. (jest)
- [ ] **AC-23:** Browser pass on the local stack, recorded in the review notes: repeat runs 1 and 2 at desktop width and once at phone width. Run 1: Sunday shows blank, the gate blocks, and no submission dated Sunday carries Monday's values. Run 2: Saturday opens without EDIT, and UPDATE COUNT doesn't appear. The header follows the selected day. Remove any test rows afterwards, as the reproduction did. (manual)

## In scope
- Re-keying the admin EOD section's per-day draft state (typed values, notes, NO NEED and EDIT flags by (store, date, vendor); + COUNT rows by (store, date)) in `EODCountSection.tsx`, with any matching change to the `PhoneEodCount` model type.
- Every reader of that state listed under "Root cause", including `deriveCountedItemIds` and the export.
- Capturing the slot at submit time, so success, failure and EDIT exit act on the submitted slot.
- The desktop header date.
- The jest and manual coverage above.

## Out of scope (explicitly)
- **Back-dated submits moving live `current_stock` / `eod_remaining`.** Existing spec 102 rule. Whether a past-date count should move live stock deserves its own decision. Follow-up.
- **Audit rows and the `order_ready` notification on a back-dated submit,** and the "submitted **today's** EOD count" copy. Copy and notification behaviour, not this bug. Follow-up.
- **Persisting drafts across reload or leaving the section.** New behaviour; today they're session-only and stay that way.
- **A marker on week-list days that hold unsaved drafts.** New UI. Possible follow-up now that drafts are kept per date.
- **A confirm or block on date change.** Not chosen (Q1); drafts are kept instead.
- **The week list's own hard-coded `'en'` month labels** (L390). Same class as the header, but the owner asked about the header. Follow-up.
- **The editing banner's wording** ("overwrite the prior submission"). Correct once EDIT can't leak to a date with no submission.
- **A server-side date bound** on EOD writes. 189 O-2 already defers it.
- **The staff EOD app** (`src/screens/staff/`). Separate surface, not shown to leak.
- **Midnight rollover** while the section stays mounted.
- **Backend, migrations, edge functions, realtime, `app.json` slug, EAS or push config.** Not touched.

## Open questions resolved
- Q: Which app? → A: The admin Cmd UI in this repo (`EODCountSection` and its phone tier). Not the staff app or customer PWA.
- Q: Should the cross-date side effects (live stock, audit, notification copy) be fixed here? → A: No, per the caller's brief. Listed as follow-ups.
- Owner's reply on 2026-11-09 to Q1-Q6, verbatim: **"All defaults OK"**. Each question takes its recommended default:
  - Q1: What happens to typed-but-unsubmitted values on a date change? → A: Kept per date for the session; returning to a date shows its values again.
  - Q2: What happens to EDIT mode on a date change? → A: EDIT is per (date, vendor); another date opens by its own submission status.
  - Q3: What does the worksheet header show? → A: The selected date, in the app locale, same format as today.
  - Q4: Include store switch? → A: Yes. Drafts and EDIT are scoped by store too.
  - Q5: Ordering with spec 189? → A: Build after 189, on its `${storeId}|${dateIso}|${vendorId}` slot key.
  - Q6: + COUNT rows? → A: Keyed by (store, date), still shared across vendor tabs.

## Dependencies
- **Spec 189** (READY_FOR_BUILD, build in progress as of 2026-11-09): same file and functions, and the slot key for its baseline. **Must land first** (Q5). This spec's build starts from 189's committed code.
- **Spec 185** (DRAFT, Front and Kitchen counts): if it adds an area to the submission key, the slot key here may need the area too. Its spec should say so when it lands.
- Spec 020 (per-vendor drafts, EDIT flow, Q4), spec 102 (counted-once-globally), spec 103 (custom order), spec 139 (export), spec 140 (phone tier model), spec 171 (count modes), spec 172 (NO NEED), spec 184 (empty states).

## Project-specific notes
- **Cmd UI section / legacy:** `src/screens/cmd/sections/EODCountSection.tsx`, plus `src/screens/cmd/sections/eod/PhoneEodCount.tsx` through the shared model. No legacy surface.
- **Per-store or admin-global:** per store. No RLS change; client state only.
- **Edge function or PostgREST:** neither changes. The existing submit path (189's `admin_submit_eod` through `submitEODCount`) is called with the right date.
- **Realtime channels touched:** none changed. `store-{id}` reloads of `eod_submissions` keep driving the lock state per date. No publication change, so the realtime restart gotcha doesn't apply.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both (shared code). Browser verification at desktop and phone widths only. No native Simulator pass.
- **`app.json` slug:** not touched.
- **Test tracks:** jest (section-level, desktop and phone) and manual (browser pass). No pgTAP or shell smoke needed.
- **Note for the architect (not a design):** spec 189's baseline already uses `${storeId}|${dateIso}|${vendorId}`. Using the same key for the input maps and EDIT flags gives one slot key. `editingVendorIds` becomes a set of slot keys. `additionalItems` is keyed by `${storeId}|${dateIso}`. `deriveCountedItemIds` is exported and tested directly, so its signature change touches the spec 102 and 172 suites (AC-22 allows that, with the reason stated). The submit handlers should capture the slot key before the `await`. Line numbers in this spec predate 189's build.
- **Working tree:** other sessions have uncommitted edits in `src/lib/db.ts`, `src/store/useStore.ts`, `EODCountSection.tsx` (spec 189's build) and several test files. Don't overwrite them; stage by hunk.

## Risks
- **Merge conflict with 189.** Avoided by building after 189 is committed (Q5). Starting early would edit the same functions.
- **The gate gets stricter on other dates.** A date that used to pass the gate on leaked values now asks for its own. That's the point, but it's visible.
- **Drafts on other dates are out of sight.** With drafts kept per date (Q1), unsubmitted values on a date the admin moved away from aren't shown anywhere until they return to it, and still vanish on reload or leaving the section, as today. The week-list marker is a follow-up.
- **A missed reader.** If any reader keeps reading the vendor-only map, the leak survives in that spot. AC-1 to AC-7 cover each reader named in "Root cause".

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD. Client-only change in EODCountSection.tsx and the PhoneEodCount model; build is sequenced after spec 189 lands, on 189's slot key.
payload_paths:
  - specs/192-eod-date-scoped-drafts.md

## Design

Read from code on 2026-11-09, against the working tree, where spec 189's build was still uncommitted in `EODCountSection.tsx`. Nothing was run. Q1 to Q6 are settled and aren't reopened. Line pointers are approximate and will move when 189 lands. Signatures and pseudocode are the contract. The developer writes the TypeScript.

### 0. Decisions in one place

| Question | Decision |
|---|---|
| Slot key | 189's `${storeId}\|${dateIso}\|${vendorId}`, produced by one new pure helper that 189's `baselineKey` also switches to (§2) |
| Day key (for + COUNT rows and the gate) | `${storeId}\|${dateIso}`, from the same helper. A slot key is its day key plus `\|${vendorId}` |
| State shape | Same four maps plus the EDIT set, re-keyed by slot. `additionalItems` re-keyed by day. No reducer refactor (§3) |
| `deriveCountedItemIds` | Stays exported from the section. Its map arguments are **renamed** to `*BySlot` and arms (a) and (c) filter to the selected day. Arm (b) is unchanged (§5.1) |
| In-flight submit | Slot captured before the `await`. Success and failure act on the captured slot only. `submitting` stays one global flag (§7) |
| Jump to Ordering after a success | **Architect addition D-192-1, which can be struck:** skip the jump if the selected (store, date) changed while the write was in flight (§7.3) |
| Header | Inline `new Date(selectedIso + 'T00:00:00').toLocaleDateString(appLocale, { weekday: 'long', month: 'short', day: 'numeric' })`. `appLocale` is already in scope (§9) |
| Store switch | Nothing to reset. The store is in every key (§10) |
| `PhoneEodModel` type | **No change.** The existing fields simply become slot-scoped. `PhoneEodCount.tsx` isn't edited (§11) |
| Backend, `db.ts`, `useStore.ts`, realtime | Not touched (§12) |

### 1. Precondition, and the 189 details this design depends on

**Gate before starting:** spec 189's build is committed, `git diff -- src/screens/cmd/sections/EODCountSection.tsx` is empty, and spec 189 is at least READY_FOR_REVIEW. Q5 requires it.

This design was written against 189's in-progress diff. **Re-check each of these once 189 lands.** If one moved, adapt to whatever 189 committed and leave the rest of this design as it is.

| # | 189 detail this design assumes | If it changed |
|---|---|---|
| P1 | The baseline is a `useRef<Record<slotKey, Record<itemId, EodRowSnapshot>>>`, keyed with the literal `${currentStore.id}\|${selectedIso}\|${vid}` in two places: a `baselineKey(vendorId)` closure and an inline template inside `onEditCurrentVendor` | Point every key site at the §2 helper. If 189 changed the key's format, the helper takes 189's format, so there is still one key |
| P2 | `onSubmit` captures `vid`, `dateIso` and `key` **before** `await submitEODCount(...)`, and its success path (`finishSubmitted`) clears through those captured values | Keep that capture order. It's what AC-8 depends on |
| P3 | `onSaveDraft` computes `key` before the `await`, and advances the baseline only on success | Same |
| P4 | `buildSubmission` reads the **current vendor's** `caseCounts` / `unitCounts` / `notes` / `noNeed` (not the `*ByVendor` maps directly) plus `baselineRef.current[key]`, and passes them to `planEodSubmit` | If 189 made it read the full maps, change it to read the slot's maps |
| P5 | `onEditCurrentVendor`'s seed rule: only a non-blank local value (or a local NO NEED mark keeping its blank boxes) beats the seed | Unchanged here. It now applies inside one slot |
| P6 | `submitEOD(submission, { removedItemIds })` returns an `undo`, and the catch arms call `undo()` then show the `savedLocally` / `cloudFailed` toast, leaving maps, EDIT and baseline alone | Unchanged here. AC-9 relies on it |
| P7 | `src/lib/eodChangeSet.ts` (`planEodSubmit`, `eodRowSnapshot`, `EodRowSnapshot`) takes single-vendor maps | Not touched. It's already slot-agnostic |
| P8 | The phone `model` literal's field list (it matches `PhoneEodModel` today) | If 189 added fields, they need the same slot treatment only if they're derived from the four maps or the EDIT set |
| P10 | (added 2026-11-09 from the 189 session) 189's stale-baseline fix added a pure `eodBaselineKey(storeId, iso, vendorId)` and `dropVendorBaselines`, and a successful SUBMIT drops every baseline key for that vendor, all dates | **Build on these, don't replace them.** The §2 slot key must be 189's `eodBaselineKey` (re-export or wrap it in `eodDraftSlot.ts`; no second key format). Keep `dropVendorBaselines` unless the slot-keyed maps make it unnecessary; narrowing it to the submitted slot is allowed only if 189's S1 jest arm and AC-24 both still pass, and the reason goes under AC-22 |
| P9 | 189's own section suite `eod/__tests__/EODCountSection.resubmit.spec189.test.tsx` works entirely on today's date | If any arm in it crosses dates and relied on the leak, edit that arm and state why under AC-22 |

### 2. Pure helper: new `src/lib/eodDraftSlot.ts`

It's a sibling of `eodChangeSet.ts` / `eodNoNeed.ts`: no React, no store, no supabase. Extracting it gives jest a cheap surface, and gives one source for the key that 189's baseline and this spec's maps share. That one source is the point of Q5. Spec 185's possible area dimension would also change only here.

```ts
/** `${storeId}|${dateIso}` — + COUNT rows, and the gate's day filter. */
export function eodDayKey(storeId: string, dateIso: string): string;

/** `${storeId}|${dateIso}|${vendorId}` — spec 189's baseline key; the input maps and EDIT set use it too. */
export function eodSlotKey(storeId: string, dateIso: string, vendorId: string): string;

/** True iff `slotKey` belongs to (storeId, dateIso). Prefix test on `${eodDayKey(...)}|`. */
export function isEodSlotOfDay(slotKey: string, storeId: string, dateIso: string): boolean;
```

- **Prefix safety.** Store and vendor ids are uuids and `dateIso` is a fixed `YYYY-MM-DD`, so none of them holds `|`. Matching on the prefix `${storeId}|${dateIso}|`, trailing `|` included, can't match another date or store.
- **No branded type.** A `Record` with branded keys doesn't stop object-literal keys in tests, so branding would add noise without catching anything. What makes the compiler flag every stale caller is renaming the `deriveCountedItemIds` arguments (§5.1).
- **New test file:** `src/lib/eodDraftSlot.test.ts`. It checks the format matches 189's literal, that `isEodSlotOfDay` is true for its own day, and that it's false for another date, another store, and a store id that is a prefix of another (`s1` vs `s10`, which the trailing `|` guards).

### 3. State shape (in `EODCountSection`)

| Today (vendor-keyed) | After |
|---|---|
| `caseCountsByVendor: Record<vendorId, Record<itemId, string>>` | `caseCountsBySlot: Record<slotKey, Record<itemId, string>>` |
| `unitCountsByVendor` | `unitCountsBySlot` (same shape) |
| `notesByVendor` | `notesBySlot` |
| `noNeedByVendor: Record<vendorId, Record<itemId, boolean>>` | `noNeedBySlot: Record<slotKey, Record<itemId, boolean>>` |
| `editingVendorIds: Set<vendorId>` | `editingSlots: Set<slotKey>` |
| `additionalItems: Set<itemId>` | `additionalItemsByDay: Record<dayKey, ReadonlySet<itemId>>` |
| `baselineRef` (189), already slot-keyed | Unchanged, apart from using `eodSlotKey` |

- **Rename the state variables**, not just their keys. After the build, a search for `ByVendor\b` and `editingVendorIds` in the section should find only `savedIdsByVendor`. That's a cheap review check against a missed reader, the spec's main risk.
- **`savedIdsByVendor` stays vendor-keyed on purpose.** Spec 103's custom order is per (user, vendor) and isn't a per-day draft.
- **`selectedVendorId`, `selectedCategory`, `search`, `viewMode`, `tabId`, `showUnscheduled` and `submitting` stay as they are.** They're view state, not draft state (R6).
- **Lifetime:** session only. Slots aren't evicted. The most there can be is 7 days × vendors × stores visited, which is small. Unmount discards everything, as today (Q1).
- **A reducer was considered and rejected.** It would be cleaner, but it rewrites the same functions 189 just changed, and the risk isn't worth it.

### 4. Derived per-render keys, accessors and setters

Computed once per render, near the current per-vendor accessors:

```ts
const dayKey = eodDayKey(currentStore.id, selectedIso);
const slotKeyFor = (vid: string) => eodSlotKey(currentStore.id, selectedIso, vid);  // replaces 189's baselineKey
const slot: string | null = selectedVendorId ? slotKeyFor(selectedVendorId) : null;

const caseCounts = slot ? (caseCountsBySlot[slot] || {}) : {};   // likewise unitCounts / notes / noNeed
const isCurrentVendorEditing = !!slot && editingSlots.has(slot);
const additionalItems = additionalItemsByDay[dayKey] ?? EMPTY_ID_SET;  // module-level frozen empty Set
```

- **`EMPTY_ID_SET` is a module-level constant,** not a fresh `new Set()`. `additionalItems` is a dependency of the `filteredItems` memo, and a new identity on every render would invalidate the memo every time and churn `filteredItems` into the phone model.
- **Setters** (`setCaseCounts`, `setUnitCounts`, `setNotes`) keep their signature, `(updater) => void`, so the phone model type doesn't move. They write `p[slot]` instead of `p[selectedVendorId]`, and their `useCallback` dependency becomes `[slot]`.
- **`commitRow` and `clearNoNeed`** (the spec 172 row transitions) close over `slot` instead of `vid`. Their logic is otherwise unchanged.
- **`currentStore.id` before the `__all__` guard.** The hooks already read `currentStore.id` above the early return. A transient `__all__|…` key is harmless, because nothing renders or submits from it.

### 5. Readers (every item under "Root cause")

| Reader | Change |
|---|---|
| Worksheet rows, `localHasEntry`, `localHasCount`, `itemTotal`, `estValue`, `variance`, `renderEodRow` | None in their own code. They read `caseCounts` / `unitCounts` / `notes` / `noNeed`, which are now the slot's maps (AC-1, AC-2) |
| Counter `countedNum`, the gate in `onSubmit` (`missing`, `firstUncounted`) | None in their own code. They go through `hasEntry` = `localHasEntry \|\| countedItemIds.has`, and `countedItemIds` is now day-filtered (§5.1, AC-4) |
| `deriveCountedItemIds` | §5.1 |
| `buildExportGroups` | Each vendor tab reads `caseCountsBySlot[slotKeyFor(v.id)]` (likewise units, notes, NO NEED). Add `currentStore.id` and `selectedIso` to its `useCallback` dependencies (AC-7). The CSV and PDF paths share this builder, so both are fixed together |
| `buildSubmission` | None, if P4 holds: it reads the slot's maps and `baselineRef.current[slotKeyFor(vid)]` (AC-3, AC-20) |
| `onEditCurrentVendor` | §6 |
| Success clear in `onSubmit` | §7 |
| `filteredItems`, gate, `AddCountModal.excludedItemIds` (through `additionalItems`) | §8 |
| Desktop header | §9 |

#### 5.1 `deriveCountedItemIds`, the new signature

```ts
export function deriveCountedItemIds(args: {
  caseCountsBySlot: Record<string, Record<string, string>>;   // renamed from caseCountsByVendor
  unitCountsBySlot: Record<string, Record<string, string>>;   // renamed from unitCountsByVendor
  submissions: ReadonlyArray<{ storeId: string; date: string; status: string; entries: ReadonlyArray<{ itemId: string }> }>;  // unchanged
  storeId: string;                                             // unchanged; now also filters arms (a) and (c)
  dateIso: string;                                             // unchanged; now also filters arms (a) and (c)
  effectiveModeOf?: (itemId: string) => EodCountMode | undefined;   // unchanged
  noNeedBySlot?: Record<string, Record<string, boolean>>;     // renamed from noNeedByVendor
}): Set<string>;
```

- **Arms (a) and (c)** iterate `Object.entries(map)` and skip any slot where `!isEodSlotOfDay(slot, args.storeId, args.dateIso)`. Inside the selected day they still read **every vendor's** slot, which keeps spec 102 counted-once-globally across vendor tabs (AC-5).
- **Arm (b)** doesn't change. AC-4 says so.
- **Why rename, not just re-key.** If the names stayed, an existing pure test that passes `{ vA: {...} }` would keep compiling and fail on its assertion, which doesn't explain why. With the rename, `npm run typecheck:test` points at every caller that needs the slot form. That's the stated reason for AC-22's edits to those suites (§13).
- **Update its header comment.** "Any vendor tab's local input map" becomes "any vendor tab's slot for this (store, date)".
- **The call site** passes `caseCountsBySlot`, `unitCountsBySlot` and `noNeedBySlot`. Its `useMemo` dependencies already include `currentStore.id` and `selectedIso`.

### 6. EDIT per slot, and how it meets 189's baseline

`onEditCurrentVendor`, for `slot = slotKeyFor(vid)`:

1. `baselineRef.current[slot] = baseline`, built from `sub.entries` as 189 builds it (P1, P5).
2. `editingSlots` gains `slot`.
3. The seed overlays `caseCountsBySlot[slot]`, `unitCountsBySlot[slot]` and `notesBySlot[slot]` with 189's non-blank-wins rule. The NO NEED seed reads `caseCountsBySlot[slot]` / `unitCountsBySlot[slot]` for its "typed" check and merges into `noNeedBySlot[slot]`.
4. Its `useCallback` dependencies swap the vendor maps for the slot maps.

What follows from the keying, with no extra code:

| AC | Why it holds |
|---|---|
| AC-10 | D-2's slot isn't in `editingSlots`, so there's no banner and the button reads SUBMIT COUNT. D-2's maps are empty, so A is blank. `buildSubmission` reads D-2's slot and D-2's baseline, which is undefined, so nothing for D-1 can ship |
| AC-11 | D-1's slot is still in `editingSlots`, its maps still hold A = 3, and its baseline is still in the ref |
| AC-12 | D-3's slot isn't in `editingSlots`, so `isVendorLocked` is true there and the rows render from D-3's submission |
| AC-13 | The overlay reads only D-1's slot, so D0's A = 5 is never seen |
| AC-14 | The success clear removes only the captured slot (§7) |
| AC-19 | D-2's submit reads D-2's baseline, so it has no removal for A, and D-1's baseline key is never written. Back on D-1, the blanked A against D-1's baseline produces the removal, with `date` = D-1 |
| R3, the banner and UPDATE COUNT label | Both already read `isCurrentVendorEditing`, desktop and phone, and that's now `editingSlots.has(slot)` |

**One limit, kept as it is.** An EDIT flag stays on a slot whose submission later disappears, for example after a realtime reload. That's today's behaviour within a date and isn't in scope.

### 7. Submits and the in-flight date change (R2, AC-8, AC-9)

#### 7.1 Capture

Both handlers fix the slot **synchronously, before** `setSubmitting(true)` and the `await`:

- `onSubmit`: `vid`, `dateIso = selectedIso`, `storeId = currentStore.id`, `submittedSlot = slotKeyFor(vid)`, `submittedDay = dayKey`. This extends P2: `key` simply becomes `submittedSlot`.
- `onSaveDraft`: `submittedSlot` comes from `built.submission.vendorId` through `slotKeyFor` (P3).

`buildSubmission` runs before the capture, in the same synchronous tick, so the payload's `date` and entries come from the same render as `submittedSlot`.

#### 7.2 Outcomes

| Outcome | What happens |
|---|---|
| SUBMIT succeeds | `finishSubmitted` deletes `baselineRef.current[submittedSlot]`, clears `submittedSlot` from all four `*BySlot` maps (delete the key, or set `{}` as today, since both meet AC-6), and removes `submittedSlot` from `editingSlots`. The toast's `date` is the captured `dateIso` (AC-8). No other slot is touched, whatever is selected by then |
| SAVE DRAFT succeeds | The baseline advances at `submittedSlot` only (189's logic). The maps stay. No EDIT change |
| Either rejects | `undo()` plus the existing toast (P6). No slot state is touched, so D-1 keeps its values and EDIT, and D0 is untouched (AC-9) |
| No-change route (`noop`, no RPC) | Synchronous, so it can't straddle a date change. Same clear as success |

Every write is a functional updater (`(p) => ...`) keyed by the captured slot, so a date change during the request can't redirect it. **Don't read `slot`, `selectedIso` or `currentStore.id` after the `await`.** Use the captured values only.

**`submitting` stays one global flag.** While D-1's write is in flight, D0's SAVE DRAFT and SUBMIT are disabled, as they are today for any second press. Typing on D0 still works. A flag per slot would allow two writes at once from one screen, for no benefit.

**Not changed:** if the user goes back to D-1 during the request and types more, a success clears that typing too. That's today's same-slot behaviour.

#### 7.3 D-192-1: the jump to Ordering (architect addition)

**Owner decision (2026-11-09): kept.** The owner replied "Keep D-192-1". Build it as written below.

A successful SUBMIT calls `usePaletteAction.getState().request({ section: 'Ordering', ... })`. `InventoryDesktopLayout` renders sections conditionally, so the jump **unmounts** `EODCountSection` and throws away every slot. In AC-8's real-app version, that means the D0 values the user is typing get discarded the moment D-1's write resolves. That's the cross-date leak again, through navigation. The jest version of AC-8 can't see this, because the harness renders the section directly and the jump only sets palette state.

**Decision:** keep the jump only when the user is still on the submitted day.

- A `liveDayKeyRef` is updated to `dayKey` each render.
- At resolve time: `if (liveDayKeyRef.current === submittedDay) request Ordering`, otherwise skip the jump. The success toast still shows, naming the submitted date.
- The comparison is by **day**, not slot. Switching vendor tab on the same date during the request still jumps, as today (R6).
- Test: an AC-8 arm asserts `usePaletteAction.getState().pending` is null after resolving with D0 selected, and set to `Ordering` in the plain case.

If the owner strikes this, delete the guard. Nothing else depends on it.

### 8. + COUNT rows (R5, Q6, AC-21)

- **`AddCountModal.onAdd`** adds to `additionalItemsByDay[dayKey]` with a functional updater that copies the day's Set.
- **The palette deep link** (`pendingPaletteAction.eodFocusItemId` effect) does the same with the render's `dayKey`. That's today's date on a fresh mount, which is the normal route. Add `dayKey` to that effect's dependencies. A re-run is a no-op, because the action is consumed the first time.
- **`filteredItems`** reads `additionalItems` (the day's Set, §4), so the gate, counter, footer and `AddCountModal.excludedItemIds` all become day-scoped with no further change. They stay cross-vendor within the day, as Q6 says.
- **Not cleared on a successful SUBMIT.** That's today's behaviour, since `additionalItems` was never cleared.

### 9. Header formatter (R4, AC-15, AC-16)

Replace the desktop header's `new Date().toLocaleDateString('en', …)` with:

```ts
new Date(selectedIso + 'T00:00:00').toLocaleDateString(appLocale, { weekday: 'long', month: 'short', day: 'numeric' })
```

- `appLocale` is the section's existing `useLocale()` value, the one that seeds `exportLocale`.
- The `'T00:00:00'` suffix (no `Z`) parses as local midnight, the same anchor `selectedDayName` and the phone header use, so the date can't shift by a day across timezones.
- **No helper.** It's one expression, and AC-15 has the test build its expected string the same way, independently.
- **Phone:** `PhoneEodCount`'s header already formats `model.selectedIso` in the app locale. No change (AC-16).
- **Unchanged and out of scope:** the week list's `'en'` month labels.

### 10. Store switch (Q4, AC-17)

Nothing new is needed. Every key starts with `currentStore.id`, so after a switch the accessors read the other store's slots, which are empty or that store's own. Switching back reads the first store's slots again, EDIT flags and 189 baselines included.

- **Don't add a reset effect.** It would break "returning to a store shows that store's drafts" (Q4).
- The existing `showUnscheduled` reset on `currentStore.id` (spec 184) stays.
- `selectedIso` and `selectedVendorId` carry across a switch, as today. The vendor-tab effect re-seats `selectedVendorId` if the tab isn't there.

### 11. Phone model

**`PhoneEodModel` doesn't change, and `PhoneEodCount.tsx` isn't edited.** Each field it reads is derived in the parent and becomes slot-scoped there:

| Field | Becomes |
|---|---|
| `caseCounts`, `unitCounts`, `notes`, `noNeed` | The slot's maps |
| `setCaseCounts`, `setUnitCounts`, `setNotes`, `toggleNoNeed`, `setNoNeed`, `clearNoNeed` | Write to the slot |
| `countedItemIds`, `hasEntry`, `countedNum`, `total`, `filteredItems` | Day-scoped |
| `isCurrentVendorEditing`, `isVendorLocked` | From `editingSlots` |
| `onSubmit`, `onEditCurrentVendor` | The same handlers, with the §7 capture |
| `setSelectedIso` | Stays the raw setter. Re-keying makes a raw date change safe |

- **Keypad sheet.** It's an RN `Modal`, so the day strip can't be tapped while it's open. A store switch drops the item from `filteredItems`, which closes it (`sheetItem` derives from that list). So the sheet can't write into a slot the user didn't open it on. No change.
- **`perVendorProgress`** reads `countedItemIds`, which is now day-scoped. That's correct.

### 12. Not changed

- **No migration, RLS, RPC, edge function, `db.ts` or `useStore.ts` change.** `submitEODCount` and `submitEOD` are called exactly as 189 leaves them, with the date of the slot being submitted.
- **Realtime:** `store-{id}` reloads of `eod_submissions` keep driving lock state per date. No publication change, so the `docker restart supabase_realtime_imr-inventory` step doesn't apply.
- **Not touched:** the staff subtree, `app.json` slug, EAS and push.
- **The cross-date side effects** listed under "Existing behaviours" (on-hand, audit, notification copy) stay as they are, per Out of scope.

### 13. Tests

#### 13.1 Existing suites that change (AC-22 reasons)

| Suite | What changes | Why |
|---|---|---|
| `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx` | Every `deriveCountedItemIds` call (about 9): `caseCountsByVendor` becomes `caseCountsBySlot`, and so on. Each vendor key `V` is wrapped as `eodSlotKey(STORE, DATE, V)`, using the `storeId` / `dateIso` the call already passes. **Assertions don't change** | §5.1 renames the arguments and day-filters arms (a) and (c). The suite's meaning, counted-once-globally within a day, is untouched. Put the **AC-4 pure arm** here: a slot for another date and another store is ignored in arms (a) and (c), and arm (b) still credits a same-day submission |
| `src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx` | The one `deriveCountedItemIds` call: same mechanical change | Same |
| `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx` | The AC-12 pure arms (about 5 calls): same mechanical change | Same. The `effectiveModeOf` behaviour being tested is unchanged |
| `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx` | The AC-17 pure arms (2 calls): same change, with `noNeedByVendor` becoming `noNeedBySlot` | Same. Arm (c)'s cross-tab rule is unchanged within a day |

**Expected unchanged; run them and confirm:**

- `EODCountSection.emptyState.spec184`, `eod/__tests__/EODCountSection.acReg`, the `PhoneEodCount` suites, and the rendered (non-pure) arms of the 171 and 172 suites. They work on today's date, and for today in `en` the header text is the same as before.
- `EODCountSection.resubmit.spec189` (P9).

If any of them does change, the review notes say which arm and why.

#### 13.2 New

- **`src/lib/eodDraftSlot.test.ts`** (§2).
- **`src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx`** covers AC-1 to AC-21. It uses the spec 172 / 189 harness: the inert `db.ts` Proxy, stubbed supabase, the `mockIsPhone` toggle, the `submitEOD` spy returning an undo (P6), the `submitEODCount` mock and the `downloadCSV` stub. Phone arms (AC-18) render the full section with `mockIsPhone = true`.

**Fixture notes:**

- **Schedule BJs (and Costco for AC-5) on all seven weekdays, or leave the schedule empty.** A configured schedule with no entry for a weekday makes that day `rest`, which disables inputs and would mask every cross-date arm (`isRestWeekday`).
- **Dates:** D0 to D-3 come from `localDayIso`, as in the 172 suite. Days are selected by pressing the week-list cell (desktop) or the day strip (phone).
- **AC-8 / AC-9:** hold `submitEODCount` on a deferred promise, change the date, then resolve or reject inside `act`. Also assert D-192-1 (§7.3).
- **AC-15:** set the app locale to `es` through the same i18n mechanism other locale tests use. Compute the expected string with the same expression as §9.
- **AC-17:** two stores in `useStore`, sharing brand vendor BJs, with per-store item ids. Switch with `useStore.setState({ currentStore })`.

**Gates:** full `npx jest`, `npm run typecheck`, `npm run typecheck:test`. The last one is what catches a stale `*ByVendor` argument in a test.

**Manual:** AC-23 as written.

### 14. Risks

- **A missed reader.** Renaming the state (§3) and the `deriveCountedItemIds` arguments (§5.1) makes the compiler and a grep find them. AC-1 to AC-7 then check each reader's behaviour.
- **189 drift.** P1 to P9 name every assumption. The one most likely to move is P4, if 189's final `buildSubmission` reads the full maps.
- **D-192-1** is a small behaviour change outside the ACs' literal wording, made to honour AC-8's intent in the real app. It can be struck.
- **A stricter gate on other dates,** and **drafts out of sight on other dates.** Both already accepted in the spec's Risks.
- **Spec 185.** If it adds an area to the submission key, the area goes into `eodSlotKey` / `eodDayKey` in one place. Whether the day key gains the area depends on whether + COUNT rows become per area, which is 185's call.
- **Performance:** none of note. The new filtering in `deriveCountedItemIds` is a string prefix test per slot, over at most a few dozen slots.

### 15. Files expected to change

- `src/lib/eodDraftSlot.ts` (new)
- `src/lib/eodDraftSlot.test.ts` (new)
- `src/screens/cmd/sections/EODCountSection.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (new)
- `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx`
- `src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`

Not expected: `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, `src/lib/db.ts`, `src/store/useStore.ts`, anything under `supabase/`. The working tree has other sessions' uncommitted edits in several of these paths, so stage by hunk.

## Handoff
next_agent: frontend-developer
prompt: Implement against the "## Design" section of this spec. First confirm the §1 gate: spec 189's build is committed and EODCountSection.tsx has no uncommitted 189 diff. Then re-check P1 to P10 against 189's committed code. D-192-1 (§7.3) was kept by the owner on 2026-11-09. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/192-eod-date-scoped-drafts.md
  - specs/189-admin-eod-resubmit-replace.md

## Implementation notes (frontend-developer, 2026-11-10)

**Gate (§1):** spec 189 committed as `97f0f17`; `EODCountSection.tsx` had no uncommitted diff when the build started.

**P1-P10, re-checked against 189's committed code:**

| # | Result |
|---|---|
| P1 | Held, with one difference: the two key sites were `baselineKey(vid)` (closure) and an inline `eodBaselineKey(...)` call in `onEditCurrentVendor`, both already going through 189's helper. Both now use the §2 slot key |
| P2, P3 | Held. Both handlers capture the slot before the `await` (`submittedSlot`; `onSubmit` also `submittedDay` for D-192-1). Nothing after the `await` reads `slot`, `selectedIso` or `currentStore.id` |
| P4 | Held. `buildSubmission` reads the current slot's accessors, so no change beyond the baseline key |
| P5, P6, P7, P8 | Held. `eodChangeSet.ts` untouched; `PhoneEodModel` and `PhoneEodCount.tsx` untouched |
| P9 | One arm drifted, see AC-22 below |
| P10 | `eodBaselineKey` **moved** to `src/lib/eodDraftSlot.ts` as `eodSlotKey` (byte-identical format `${storeId}\|${dateIso}\|${vendorId}`, pinned by `eodDraftSlot.test.ts`), and the section imports it back. There is one key format. `dropVendorBaselines` was **narrowed** to the submitted slot (`delete baselineRef.current[submittedSlot]`, §7.2) and the helper removed. Its reason was that 189's vendor-keyed maps were emptied on every date at once. Slot-keyed maps keep other dates' values, so their baselines must stay too: dropping them would turn a later blank of a saved row there into "never touched" and silently keep the count. Both conditions hold: 189's S1 arm passes (as edited, below) and both AC-24 arms pass |

**D-192-1 (§7.3)** is built as written: `liveDayKeyRef` is updated in an effect, and the jump fires only if the day on screen equals `submittedDay`.

**AC-22, existing suites edited:**

- `EODCountSection.countedOnce`, `.customOrder`, `eod/…countMode.spec171`, `eod/…noNeed.spec172`: the §13.1 mechanical change only. `*ByVendor` args became `*BySlot` with keys wrapped in `eodSlotKey(store, date, vendor)`. No assertion changed. `typecheck:test` flagged exactly these call sites. The AC-4 pure arm was added to `countedOnce` (another date, another store with a prefix id `store-10`, and arm (b) unchanged).
- `eod/…resubmit.spec189`, code-reviewer S1 arm (P9): steps 2 and 3 relied on the leak. Step 2 only counted `d1` on day B because day A's values showed there; step 3 expected day A's rows blank because day B's SUBMIT emptied the vendor-keyed maps. Under 192, day B shows its own blank rows (so step 2 counts all three), and day A keeps its values and baseline (so step 3 reads 5 / 6 back). Steps 4 and 5, which are the arm's point (no removal of day A's drafted rows), are unchanged and pass. The reason is in the arm's header comment.
- Unchanged and passing: `.emptyState.spec184`, `eod/…acReg`, `PhoneEodCount`, `PhoneType`, the rendered arms of 171 and 172, and the rest of 189.

**New coverage:** `src/lib/eodDraftSlot.test.ts` (7) and `eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (30 arms: AC-1 to AC-21 and AC-24, plus D-192-1 positive, same-day tab switch and in-flight negative). Sanity check: the same 30 arms run against 189's committed section, through a temporary copy that was deleted afterwards. 24 fail there, including both AC-24 arms. The 6 that pass are the non-regression arms (AC-5, AC-11 desktop and phone, AC-16, the two D-192-1 jump-still-happens arms).

**Gates:** full `npx jest` 307 suites / 3948 tests green. `npm run typecheck:test` clean. `npm run typecheck` shows only 24 × TS2688 "Cannot find type definition file for '<pkg> 2'". These come from Finder-style duplicate directories `node_modules/@types/* 2` (dated 2026-10-26) in this checkout, an environment issue that predates this change and is not touched here. A run with `types` pinned shows no source errors.

**AC-23:** done at desktop 1440×900 and phone 390×844, recorded in `specs/192-eod-date-scoped-drafts/reviews/manual-verification.md`. The test rows were removed and the counts match the baseline.

## Files changed

- `src/lib/eodDraftSlot.ts` (new)
- `src/lib/eodDraftSlot.test.ts` (new)
- `src/screens/cmd/sections/EODCountSection.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (new)
- `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx`
- `src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx` (P9 arm, see AC-22 above; not in the design's §15 list)
- `specs/192-eod-date-scoped-drafts.md` (status, implementation notes, this list)
- `specs/192-eod-date-scoped-drafts/reviews/manual-verification.md` (new)

Not changed: `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, `src/lib/db.ts`, `src/store/useStore.ts`, anything under `supabase/`.
