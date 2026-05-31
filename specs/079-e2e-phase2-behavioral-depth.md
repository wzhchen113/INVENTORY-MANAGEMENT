# Spec 079: E2E Phase 2 — behavioral depth + flake-proofing

Status: READY_FOR_REVIEW

## Problem / context

Spec 078 shipped the Playwright E2E framework with broad-but-shallow v1
coverage — 13 tests across 8 spec files, most of which assert "does the
section render?" (`dashboard-root`/`dashboard-kpis` visible, `reorder-root`
visible, `audit-root` visible) rather than exercising behavior. The harness
itself is proven: storageState-per-role auth, the OQ-4 `order_schedule`
runtime fixture (2 vendors × 7 weekdays on Towson), the separate non-blocking
`e2e.yml`, and the `testID`→`data-testid` contract all landed and are green.

Two motivations for Phase 2:

1. **Close the manual-verification gap.** Several flows in this development
   run were only ever hand-verified by main Claude in the browser, never
   automated — they can silently regress. Two named cases:
   - **Spec 072 (staff scroll / pinned footer):** main Claude verified the fix
     by DOM inspection of computed styles at a 375×812 viewport (the items
     `FlatList` becomes the `overflow: hidden auto` scroll container; the
     Submit footer stays in-viewport). No automated guard exists. This is a
     web-only CSS-layout regression class that jest cannot catch (it requires a
     real viewport-sized DOM) but Playwright can.
   - **EOD submit persistence:** `e2e/eod.spec.ts` today asserts the queue
     indicator clears — it proves the queue drained, NOT that the submission
     persisted. The `eod-prefill-banner` ("Last submitted at HH:MM — your
     changes will overwrite") that renders on reload after a successful submit
     is the durable persistence signal and is currently unasserted.
2. **Earn a trustworthy promotion.** `e2e.yml` is non-blocking today; spec 078
   AC-PROMO1 promotes it to a required check after **≥20 consecutive green runs
   on `main`** AND **observed flake rate < 5%**. A flaky OR shallow suite never
   earns that. Phase 2 both deepens coverage AND flake-proofs every spec so the
   20-green / <5%-flake bar becomes reachable.

This spec **EXTENDS the spec-078 harness; it does NOT rebuild it.** No config
rewrite, no new workflow, no new auth model.

### Locked (inherited from spec 078 — do NOT re-litigate)

- Playwright, web-only. No Cypress, no Detox/native driver.
- The existing **separate non-blocking** `.github/workflows/e2e.yml`. Not
  folded into `test.yml`.
- The `e2e/` tree structure (config at repo root, specs + fixtures under
  `e2e/`).
- storageState-per-role auth (admin / staff / master) via the `setup` project.
- The OQ-4 `e2e/global-setup.ts` fixture (`order_schedule` for 7 weekdays × 2
  vendors on Towson) + its `e2e/global-teardown.ts` cleanup.
- The master-role invite path (the Users section is master-gated per spec 030).
- `testID`→`data-testid` selectors; the §7 contract names from spec 078 are
  frozen and reused.
- The AC-PROMO1 promotion rule (≥20 green / <5% flake) — Phase 2 makes it
  reachable, it does not change the rule.

## User stories

- As a **developer**, I want the spec-072 scroll fix and EOD submit-persistence
  guarded by E2E tests, so a future refactor that re-breaks body-scroll or
  silently fails to persist a count is caught by CI instead of by a user.
- As a **reviewer**, I want every E2E spec to use deterministic,
  non-text-fragile waits and assertions, so the suite stops short of the
  20-green / <5%-flake bar only on genuine regressions, never on harness flake.
- As the **team**, I want `e2e.yml` to credibly approach promotion-to-required,
  so we eventually gate merges on a behaviorally-meaningful browser suite.

## Acceptance criteria

Criteria are grouped by internal phase. Both phases land in this one spec
(mirroring how 078 phased within a single spec). P1 is the highest-value,
lowest-fixture-risk depth + the flake-proofing pass; P2 is the remaining depth.

### P1 — Spec-072 scroll guard + EOD persistence + flake-proofing pass

Spec-072 scroll guard (web-only layout regression):
- [ ] AC-072-1: A new E2E test loads a populated EOD list as staff (reusing the
      OQ-4 fixture — Towson, US FOOD has 31 items so the list overshoots a
      mobile viewport), at a **mobile viewport** (375×812, set via
      `test.use({ viewport: { width: 375, height: 812 } })` or
      `page.setViewportSize`), and asserts the **Submit button
      (`eod-submit`) is within the viewport bounds** after the list renders —
      i.e. `boundingBox().y + height <= viewport.height`. This is the exact
      property main Claude verified by DOM inspection (footer not pushed below
      the fold).
- [ ] AC-072-2: The same test asserts the items list is the **internal scroll
      container, not the document body** — assert the computed `overflow-y` of
      the `FlatList` outer is a scrolling value (`auto`/`scroll`) AND/OR that
      the element's `scrollHeight > clientHeight` (it has scrollable overflow)
      while the document body does NOT body-scroll (`document.body.scrollHeight
      <= window.innerHeight + tolerance`). The architect picks the most robust
      computed-style probe; the property under test is "list scrolls internally,
      page does not." This needs a stable selector on the items `FlatList`
      outer (see AC-072-SEL).
- [ ] AC-072-SEL: A stable `testID` is added to the items `FlatList` so the
      scroll-container probe targets it deterministically rather than walking
      the DOM parent chain (which spec 072 itself documented is brittle —
      "chain idx 3 (was 4)"). Proposed name `eod-item-list` on the populated
      `<FlatList>` at [EODCount.tsx:522](../src/screens/staff/screens/EODCount.tsx).
      This is the one net-new production `testID` in this spec (frontend
      disjoint-split item, see §"Division of labor").

EOD submit persistence (deepen the existing online-submit case):
- [ ] AC-EOD-PERSIST-1: After the online submit in the EOD spec succeeds (the
      existing `AC-EOD1` flow — fill a count, click `eod-submit`, queue
      indicator stays empty), the test **reloads the EOD screen for the same
      (store, vendor, today)** and asserts the **`eod-prefill-banner` is
      visible** — proving the submission persisted server-side (the banner only
      renders when `fetchExistingSubmission` returns a row for today). This is
      UI-only (black-box) and is the primary persistence assertion.
- [ ] AC-EOD-PERSIST-2: As a single belt-and-suspenders proof, the EOD
      persistence case ALSO performs **one service-role read** of
      `eod_submissions` for (Towson, today, US FOOD) using the existing
      service-role client pattern from `e2e/global-setup.ts`, and asserts a row
      exists with at least one matching `eod_entries` row for the item that was
      filled. This is the ONE service-role assertion in the suite (everything
      else stays UI-only). It is co-located in `e2e/eod.spec.ts` via a small
      helper (a service-role `@supabase/supabase-js` client guarded by the same
      `assertLocalStack` guard that `global-setup.ts` exports).
- [ ] AC-EOD-PERSIST-3: The persistence case keys off **the same run's**
      submitted count value (not an absolute row count) so it is idempotent
      across re-runs against a non-reset local DB. `staff_submit_eod` upserts on
      (store, date, vendor), so a re-run overwrites rather than duplicates — the
      assertion reads the row for today and confirms presence + the entry, not a
      count of submissions.

Flake-proofing pass (ALL existing v1 specs + the new ones):
- [ ] AC-FLAKE-1: Every existing v1 spec (`auth`, `eod`, `invite`, `dashboard`,
      `reorder`, `audit`, `dark-mode`) is audited and hardened against the known
      flake patterns. Concretely:
  - Replace any **text-based sidebar navigation** (`getByText('Dashboard',
    {exact:true})`) that is fragile to copy/i18n changes with a stable
    `testID`-based nav where a sidebar `testID` exists, OR document why the
    label-text click is the documented approach (per `constants.ts` SIDEBAR_LABEL
    note) and harden it with a stable wait. (See AC-FLAKE-SEL — adding sidebar
    nav-item testIDs is the cleaner fix and is offered as a frontend item.)
  - Replace any fixed `waitForTimeout`/sleep with an `expect`-based
    auto-retrying wait (web-first assertions) or `expect.poll`.
  - Confirm every navigation asserts the destination `*-root` is visible before
    interacting (no implicit "the click worked" assumptions).
- [ ] AC-FLAKE-2: A short **flake-pattern checklist** is added to the
      `tests/README.md` Track-4 section documenting the patterns the suite
      avoids (text-fragile nav, fixed sleeps, asserting absence-by-timeout,
      shared-context localStorage bleed) so future spec authors don't
      reintroduce them. This is the durable artifact that keeps the suite at
      <5% flake as it grows.
- [ ] AC-FLAKE-3: The flake-proofing pass MUST NOT change any spec's
      *behavioral assertion* — it hardens HOW the suite waits/navigates, not
      WHAT it asserts. (Exception: the deepenings in P1/P2 add NEW assertions;
      those are additive, not rewrites of existing ones.)
- [ ] AC-FLAKE-SEL (frontend, optional-but-recommended): Stable `testID`s are
      added to the admin Cmd sidebar nav items the specs click
      (`nav-dashboard`, `nav-reorder`, `nav-audit`, `nav-users` or equivalent),
      so sidebar navigation is `getByTestId`-based and immune to label/i18n
      drift. If the architect judges the label-text nav sufficiently stable, this
      becomes documented-as-intended instead and the specs keep label clicks —
      architect's call, but the testID path is the recommended flake-kill.

### P2 — Invite durable-effect + Reorder action depth

- [ ] AC-INV-DEPTH-1: The invite spec is deepened from "the drawer closes" to
      asserting a **durable effect**: after submit, the test asserts the newly
      invited user appears in the Users list as a row
      (`user-row-{id}` — the per-row `testID` from spec 078 §7 #11 exists), OR
      (if the new row id is not addressable without a service-role lookup) that
      the invited email text appears in the rendered Users list. The assertion
      keys off **this run's uniquified email** (`e2e-invite+<runId>@local.test`),
      never an absolute row count, preserving AC-INV2 isolation.
- [ ] AC-REORD-DEPTH-1: The reorder spec is deepened from "the section renders"
      to **exercising an action and asserting its visible effect, within the
      action surface that actually exists**. The Reorder section has NO durable
      mutating action (no mark-ordered / generate-PO) — its only actions are
      **CSV export, PDF export, and Refresh**
      ([ReorderSection.tsx:604-673](../src/screens/cmd/sections/ReorderSection.tsx)).
      So the deepening is: assert the **export controls become enabled when the
      reorder payload has vendors** (the `showExport` gate), click **Refresh**,
      and assert the section returns to a loaded state (the `reorder-root`
      stays mounted and the loading→loaded transition completes — the REFRESH
      button label returns from `LOADING…` to `REFRESH`). A file-download
      assertion on CSV/PDF is OPTIONAL (Playwright `page.waitForEvent('download')`)
      and the architect decides whether to include it (it adds a download-handler
      dependency; the enable+refresh assertion is the v1 floor). No durable DB
      effect is asserted because none exists in this surface.
- [ ] AC-REORD-DEPTH-SEL (frontend, conditional): If the reorder deepening
      asserts the export-button state, the CSV/PDF/Refresh `TouchableOpacity`s
      need addressable `testID`s (`reorder-export-csv`, `reorder-export-pdf`,
      `reorder-refresh`) — they have `accessibilityLabel`s today but no
      `testID`. Add them only if the architect keeps the export/refresh
      assertion (it is the recommended floor). These are frontend
      disjoint-split items.

### Cross-cutting

- [ ] AC-DOC-1: `tests/README.md` Track-4 section is updated with: the
      new behavioral coverage (scroll guard, EOD persistence, invite
      durable-effect, reorder action), the single service-role-read carve-out
      and why it is the lone exception to UI-only, and the AC-FLAKE-2 flake
      checklist. The promotion criteria (AC-PROMO1) is restated unchanged.
- [ ] AC-CI-1: The deepened + new tests run inside the **existing** `e2e.yml`
      with no workflow change beyond what the new specs need at runtime. The
      single service-role read (AC-EOD-PERSIST-2) reuses the service-role key
      `e2e.yml` already exports for the OQ-4 fixture (the quote-stripped
      `$GITHUB_ENV` export from the spec-078 post-merge fix) — no new secret, no
      new step. If the architect finds a new step IS needed, that is surfaced as
      a design decision, but the default is zero workflow change.
- [ ] AC-GREEN-1: After this spec lands and is pushed to `main`, the most recent
      `e2e.yml` run on `main` is confirmed green (per the CLAUDE.md "CI status
      check after every push to `main`" rule). The deepened suite passing green
      is part of done. (The 20-green streak toward promotion starts counting from
      a stable green; this spec does not flip the gate — that remains a separate
      user-authorized follow-up.)

## In scope

- A spec-072 scroll-regression E2E guard at a mobile viewport (Submit
  in-viewport + list-scrolls-internally), plus ONE net-new `testID`
  (`eod-item-list`) to target the scroll container.
- Deepening `e2e/eod.spec.ts` online-submit to assert persistence via the
  `eod-prefill-banner` on reload (UI-only) PLUS one service-role read as a
  single belt-and-suspenders proof.
- Deepening `e2e/invite.spec.ts` to assert the invited user appears in the
  Users list (durable effect), keyed off the run-unique email.
- Deepening `e2e/reorder.spec.ts` to exercise the export-enable + refresh
  action surface that exists (NOT a DB mutation — none exists there).
- A flake-proofing audit + hardening pass across ALL seven existing v1 specs
  (text-fragile nav, fixed sleeps, race-prone waits), plus optional sidebar
  nav-item `testID`s and reorder action `testID`s to make navigation/actions
  `getByTestId`-based.
- A flake-pattern checklist added to `tests/README.md` Track 4.
- Confirming the suite runs green in the existing `e2e.yml` with no workflow
  rewrite.

## Out of scope (explicitly)

- **The spec-074 dashboard-window E2E (Monday-reset attention queue).**
  Deferred. Rationale: it requires PAST-DATED missed-order data —
  `order_schedule` rows on past *dates* with NO matching submission — but the
  current fixture is **weekday-keyed** (`day_of_week`), not date-keyed, and the
  derivation of a "miss" is schedule-vs-submission per date. Building that
  fixture is genuinely new scope AND collides with the pgTAP
  `supabase/tests/missed_order_audit_rpc.test.sql` arm-C test, which already
  uses **Towson** as its positive-case store and asserts the missed-order RPC
  returns exactly 1 (documented in `e2e/global-teardown.ts`). A date-based
  Towson fixture would corrupt that assertion; a separate non-Towson store would
  need its own inventory + teardown. Spec 074 ALREADY has 8+ deterministic jest
  tests pinning the Monday-reset windowing with injected `now`
  (`cmdSelectors.unconfirmedPoWindow.test.ts` + `weekWindow.test.ts`). The
  marginal value of an E2E layer over that is low relative to the fixture +
  flake cost. **Flagged as a follow-up spec (080) candidate** if the user wants
  end-to-end window coverage later, with the explicit prerequisite of a
  date-keyed fixture on a dedicated non-Towson store.
- **Rebuilding the spec-078 harness.** No `playwright.config.ts` rewrite, no new
  workflow, no new auth model, no change to the OQ-4 fixture's shape (the scroll
  + persistence specs REUSE it as-is).
- **Promoting `e2e.yml` to a required/gating check.** Unchanged from 078 — it
  stays advisory until the AC-PROMO1 bar is met; flipping it is a separate
  user-authorized follow-up. This spec makes the bar *reachable*, it does not
  flip the gate.
- **New browser projects (Firefox/WebKit) or parallelism.** chromium-only,
  `workers: 1` in CI stays (per 078). Re-enabling parallelism is a separate
  decision behind per-worker uniquification.
- **Native (Detox/device) E2E.** Locked out by 078 #1.
- **Service-role reads beyond the single EOD persistence spot-check.** Every
  other assertion stays UI-only/black-box. The lone service-role read is the
  documented exception, not a new pattern to spread.
- **A Reorder mutating action (mark-ordered / generate PO).** That product
  surface does not exist; building it to make a "durable effect" assertion
  possible is out of scope. The reorder deepening uses the export/refresh
  surface that exists.
- **Backend / RPC / migration / edge-function changes.** This spec adds E2E test
  depth + at most a handful of frontend `testID`s. No new RPC, no edge function,
  no migration. (The service-role read in AC-EOD-PERSIST-2 is test code in the
  `e2e/` tree — it does not widen the `src/lib/db.ts` centralization rule, per
  the spec-078 §0 precedent.)
- **Changing the `app.json` slug.** Untouched; load-bearing per CLAUDE.md.
- **Visual-regression / screenshot-diff testing.** Still deferred (078). The
  scroll guard uses a computed-style/bounding-box probe, NOT `toHaveScreenshot`.

## Open questions resolved

These four were genuinely strategic. AskUserQuestion is unavailable inside this
agent, so each is resolved here with the PM's recommended default (auto-mode);
each is grounded in code/specs read during scoping and is reversible by the
architect or user. Surfaced transparently rather than buried.

- Q: **Persistence-verification strategy — service-role read vs UI-only?**
  → A: **UI-only primary + one service-role spot-check.** The
  `eod-prefill-banner` ("Last submitted at HH:MM") on reload is the black-box
  persistence signal and is the standard assertion for the suite. The EOD
  persistence case ALSO does ONE service-role read of `eod_submissions` as a
  single belt-and-suspenders proof (reusing the `global-setup.ts` service-role
  client + `assertLocalStack` guard). Best of both: less-brittle default,
  precise proof on the highest-value persistence case, no new pattern sprawl.
- Q: **Is the spec-074 dashboard-window E2E worth the fixture complexity?**
  → A: **No — defer it.** It needs date-keyed past-dated missed-order data the
  current weekday-keyed fixture can't provide, collides with the pgTAP
  missed-order test on Towson, and the windowing already has 8+ deterministic
  jest tests. Phase 2 focuses on the high-value low-fixture-risk flows.
  Follow-up spec 080 candidate.
- Q: **Flake-proofing scope — all specs or new ones only?**
  → A: **Audit + harden ALL seven existing v1 specs** plus author the new ones
  cleanly. The AC-PROMO1 promotion (≥20 green / <5% flake) requires the WHOLE
  suite stable, not just the new files — a single flaky v1 spec blocks the
  streak. Plus a flake checklist in `tests/README.md` to keep new specs clean.
- Q: **Phasing — one spec or split?**
  → A: **One spec, two internal phases** (P1 = scroll + EOD persistence +
  flake-proof pass; P2 = invite-depth + reorder action). Mirrors how 078 phased
  within a single spec; splitting into 079/080 is heavier ceremony for what is
  largely test authoring on a proven harness.

## Dependencies

- **The spec-078 harness, in full** — `playwright.config.ts`,
  `e2e/auth.setup.ts`, `e2e/global-setup.ts` + `e2e/global-teardown.ts` (the
  OQ-4 fixture + its `assertLocalStack` export), `e2e/fixtures/constants.ts`
  (SEED UUIDs, STORAGE_STATE paths, DEMO accounts, `uniqueInviteEmail`,
  SIDEBAR_LABEL), and the seven existing flow specs. This spec edits/extends
  these; it does not recreate them.
- The local Supabase stack (`npm run dev:db`) + committed `supabase/seed.sql`
  with the demo accounts. Towson + US FOOD + RESTAURANT DEPOT seed rows (the
  OQ-4 fixture's anchors) must remain.
- `@supabase/supabase-js` (already a dependency) for the single AC-EOD-PERSIST-2
  service-role read — reused from the existing `global-setup.ts` pattern, no new
  install.
- Frontend `testID` additions (in-repo, no backend coupling):
  - `eod-item-list` on the populated items `FlatList`
    ([EODCount.tsx:522](../src/screens/staff/screens/EODCount.tsx)) — required
    for AC-072-2/AC-072-SEL.
  - Sidebar nav-item `testID`s (`nav-*`) — recommended for AC-FLAKE-SEL
    (architect confirms).
  - Reorder action `testID`s (`reorder-export-csv`/`-pdf`/`-refresh`) —
    conditional on the reorder deepening keeping the export/refresh assertion
    (AC-REORD-DEPTH-SEL).
- No new RPCs, edge functions, or migrations.
- The existing `e2e.yml` workflow (no rewrite; reuses the spec-078 quote-stripped
  service-role-key export for the lone service-role read).

## Project-specific notes

- **Cmd UI section / legacy:** Touches the admin Cmd surface
  ([src/screens/cmd/sections/ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx),
  the Cmd sidebar nav) and the staff surface
  ([src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx))
  for `testID` instrumentation only — no behavior change. No legacy surface
  (spec 025 deleted it).
- **Per-store or admin-global:** Mixed, same as 078. The scroll + EOD persistence
  specs exercise the per-store staff surface (Towson, scoped by
  `auth_can_see_store()` / `user_stores`) as `manager@local.test`. Invite +
  reorder run as admin/master against admin-global / per-store-selected surfaces.
  No scope change — validating existing RLS composition end-to-end.
- **Realtime channels touched:** None directly. Staff has no realtime (spec 062);
  admin realtime (`store-{id}` / `brand-{id}`) is incidental and no E2E spec
  asserts cross-client propagation. Risk note (carried from 078): if a future
  E2E spec ever asserts realtime, the CLAUDE.md realtime-publication gotcha
  (`docker restart supabase_realtime_imr-inventory` after mid-session pub
  changes) applies. Not engaged here.
- **Migrations needed:** No.
- **Edge functions touched:** None. The invite flow still reaches the invite
  RPC / `send-invite-email` through the existing app code path, exercised
  black-box via the UI.
- **Web/native scope:** **Web only** — locked. The spec-072 scroll guard is
  *intrinsically* web-specific (the bug is a react-native-web layout loophole;
  native Yoga has no equivalent — per spec 072 root-cause). Native scroll is not
  testable via Playwright and stays out.
- **Tests:** This spec deepens **Track 4 (browser E2E / Playwright)** only. No
  new jest or pgTAP tests are required — the spec-074 windowing jest tests
  already exist and are untouched; the spec-072 fix is guarded by the new E2E
  test (jest cannot reproduce a viewport-sized layout). The `testID` additions
  are non-behavioral attributes and need no new jest assertion (a component-test
  reviewer may spot-check that no existing jest test keyed on the absence of a
  `testID`).
- **CI:** Uses the existing `.github/workflows/e2e.yml` (separate,
  non-blocking). Per CLAUDE.md, after the push to `main` the latest `e2e.yml`
  run on `main` must be confirmed green (AC-GREEN-1). This spec does NOT flip
  `e2e.yml` to required — that is the separate user-authorized AC-PROMO1
  follow-up.

## Division of labor (preview for the architect)

The spec-078 clean split applies again: the **frontend-developer** owns the
net-new production `testID`s only; the **backend/harness-developer** owns the
`e2e/` spec edits, the flake-proofing pass, and the `tests/README.md` doc. The
frozen contract between them is the `testID` names. Disjoint file sets:

- **Frontend (production `src/` only):**
  - `src/screens/staff/screens/EODCount.tsx` — `eod-item-list` on the populated
    `<FlatList>` (AC-072-SEL).
  - Cmd sidebar component — `nav-*` testIDs (AC-FLAKE-SEL, if kept).
  - `src/screens/cmd/sections/ReorderSection.tsx` — `reorder-export-csv`/`-pdf`/
    `-refresh` (AC-REORD-DEPTH-SEL, if kept).
- **Harness/backend (`e2e/` + docs only, no `src/` edits):**
  - `e2e/eod.spec.ts` — scroll guard test (AC-072-*), persistence deepening
    (AC-EOD-PERSIST-*).
  - `e2e/invite.spec.ts` — durable-effect deepening (AC-INV-DEPTH-1).
  - `e2e/reorder.spec.ts` — action deepening (AC-REORD-DEPTH-1).
  - All seven specs — flake-proofing hardening (AC-FLAKE-1/3).
  - `e2e/fixtures/constants.ts` — any new shared selector constants (e.g. the
    `eod-item-list` / `nav-*` names) so specs reference one source of truth.
  - `tests/README.md` — Track-4 doc update + flake checklist (AC-DOC-1,
    AC-FLAKE-2).

The architect finalizes which optional `testID`s (AC-FLAKE-SEL, AC-REORD-DEPTH-SEL)
are in, the exact computed-style probe for AC-072-2, whether the reorder
download-event assertion is included, and the precise service-role-read helper
shape for AC-EOD-PERSIST-2.

## Handoff

next_agent: backend-architect
prompt: Design the contract for this spec (design mode). There is real design
  surface: (1) the exact computed-style/bounding-box probe for the spec-072
  scroll guard (Submit-in-viewport + list-scrolls-internally) and whether
  AC-072-SEL's `eod-item-list` testID is the right anchor; (2) the
  service-role-read helper shape for the single AC-EOD-PERSIST-2 spot-check
  (reuse global-setup's client + assertLocalStack guard; confirm it needs no
  e2e.yml change); (3) the flake-proofing patterns to standardize and whether
  sidebar/reorder action testIDs (AC-FLAKE-SEL / AC-REORD-DEPTH-SEL) are in or
  the label-text nav stays; (4) confirm the spec-074 window E2E is correctly
  deferred (the date-keyed-fixture + pgTAP-Towson-collision rationale). Produce
  the design doc, freeze the testID contract, and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/079-e2e-phase2-behavioral-depth.md

---

## Backend / Frontend design

Author: backend-architect (design mode). Like spec 078, this is **test
infrastructure**: no DB migration, no RPC, no edge-function change, no
`src/lib/db.ts` surface. The "Data model" rubric resolves to *test fixtures and
the production `testID` contract*, not schema. This spec **extends** the proven
078 harness — every config, the `e2e/` tree, storageState-per-role, the OQ-4
`order_schedule` fixture, the `assertLocalStack` guard, and the `testID` →
`data-testid` mapping are all reused as-is. No rebuild.

I read the full 078 design + every artifact it produced before designing:
`e2e/global-setup.ts` + `global-teardown.ts` (the service-role client +
`assertLocalStack` pattern), `e2e/fixtures/constants.ts`, all 8 existing specs,
`EODCount.tsx` (the FlatList at L522, the `styles.container`/`itemListBody`
scroll mechanics, `fetchExistingSubmission`, the `eod-prefill-banner` gate at
L447), `ReorderSection.tsx` (the export/refresh `showExport` gate L597 + the
three `TouchableOpacity`s L626-673), and the section-nav chain
`ResponsiveCmdShell` → `Sidebar` → `TreeGroup` → `TreeItem` (the section ids in
`cmdSelectors.ts` L1088/1108/1121/1140).

### 0. Scope confirmation against the existing system (the architect rubric)

- **No `src/lib/db.ts` change.** E2E specs drive the app through the browser.
  The single AC-EOD-PERSIST-2 service-role read is *test code* in the `e2e/`
  tree (same posture as the OQ-4 fixture insert) — it does not widen the
  centralization rule. This is the 078 §0 precedent, reaffirmed.
- **No edge-function change.** The invite flow still reaches `send-invite-email`
  / the invite RPC through the existing `inviteUser()` → `callEdgeFunction` path,
  exercised black-box via the UI. No `verify_jwt` setting, no service-token
  validation, no `_shared/` module touched. **Answer to the rubric's
  "verify_jwt posture of any new/modified function": none modified.**
- **No realtime publication change.** This spec adds no migration and changes no
  `supabase_realtime` membership. **The CLAUDE.md
  `docker restart supabase_realtime_imr-inventory` gotcha does NOT apply.**
  Staff has no realtime (spec 062); admin realtime is incidental and no E2E spec
  asserts cross-client propagation. Flagged explicitly per the architect rubric.
- **No migration.** `db-migrations-applied.yml` is untouched.
- **No frontend store impact.** No slice of `src/store/useStore.ts` or
  `useStaffStore.ts` changes. The `testID` adds are attribute-only; they do not
  touch state, selectors, actions, or the optimistic-then-revert /
  `notifyBackendError` pattern.

### 1. Item 1 — the spec-072 scroll guard probe (AC-072-1/2/SEL)

**The behavior under test, traced in code.** `EODCount` renders a
`SafeAreaView` whose `styles.container` is `StyleSheet.absoluteFillObject`
(EODCount.tsx:606) — it sizes the screen to the React-Navigation Card (~100vh)
rather than growing with content. Inside it, the populated-branch `<FlatList>`
(EODCount.tsx:522) carries `style={styles.itemListBody}` which is `flex: 1`
(L685-687). On react-native-web, that `flex:1` child of a fixed-height
absolute-fill parent becomes the **internal scroll container** (`overflow:
hidden auto`), leaving the pinned `styles.footer` (Submit + queue indicator,
L573) in-viewport. The regression class (spec 072 root cause): if the
`flex:1`/absolute-fill shape breaks, the page falls back to **body-scroll** and
the footer is pushed below the fold. This is a react-native-web layout loophole
with no native-Yoga equivalent — jest cannot reproduce it (needs a real
viewport-sized DOM), Playwright can.

**AC-072-SEL — the testID anchor: CONFIRMED `eod-item-list` on the FlatList
outer.** Spec 072 itself documented the DOM parent-chain is brittle ("chain idx
3 (was 4)"). A dedicated `testID` on the populated `<FlatList>` is the robust
target. **One net-new staff `testID`; frontend disjoint-split item.** Note: on
web, RN `FlatList`'s `style` prop lands on the **outer ScrollView host node**
(the scroll container) while `contentContainerStyle` lands on the inner content
node — so `testID` on the FlatList maps to the *outer* node, which is exactly
the element whose `overflow-y` / `scrollHeight` we probe. This is the correct
node; no `dataSet` fallback needed.

**Mobile viewport: REQUIRED.** The suite default is `Desktop Chrome`
(1280×720), where 31 items do NOT overshoot and the body never scrolls — the
test would pass vacuously and never guard the regression. The scroll-guard test
**must** override to a phone size to reproduce the overshoot. Use
`test.use({ viewport: { width: 375, height: 812 } })` at the `test.describe`
block for the scroll case (matches the 375×812 main-Claude hand-verified at).
Keep it scoped to that describe block so the EOD submit/persistence cases stay
desktop (they don't need the phone viewport, and isolating avoids re-rendering
cost). Do **not** change the global config viewport.

**The exact assertion shape (AC-072-1 + AC-072-2) — pick (c): BOTH, three
sub-assertions.** After `gotoTowsonEod(page)` selects US FOOD (31 Towson items,
guaranteed overshoot at 812px height) and at least one `eod-item-input-*` is
visible:

```
// --- AC-072-1: Submit footer stays in-viewport (the property hand-verified) ---
const box = await page.getByTestId('eod-submit').boundingBox();
expect(box).not.toBeNull();
const viewport = page.viewportSize()!;            // { width:375, height:812 }
// footer bottom edge is at or above the fold (small tolerance for sub-pixel)
expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

// --- AC-072-2a: the items list IS the internal scroll container ---
const list = page.getByTestId('eod-item-list');
const scroll = await list.evaluate((el) => ({
  overflowY: getComputedStyle(el).overflowY,
  scrollH: el.scrollHeight,
  clientH: el.clientHeight,
}));
expect(['auto', 'scroll']).toContain(scroll.overflowY);   // it CAN scroll
expect(scroll.scrollH).toBeGreaterThan(scroll.clientH);    // it HAS overflow

// --- AC-072-2b: the document body does NOT body-scroll ---
const bodyScrolls = await page.evaluate(
  () => document.body.scrollHeight > window.innerHeight + 1,   // 1px tolerance
);
expect(bodyScrolls).toBe(false);
```

Rationale for all three (not just one):
- **(072-1) Submit-in-viewport** is the literal user-facing property spec 072
  fixed ("footer not pushed below the fold"). It is the highest-signal single
  assertion and survives even if RN-web changes which node owns the overflow.
- **(072-2a) list `overflow-y` + `scrollHeight > clientHeight`** proves the
  *mechanism* (internal scroll exists on the list), so a regression that keeps
  Submit barely-in-viewport but moves the scroll to the body still fails.
- **(072-2b) body-does-not-scroll** is the complementary negative — it's what
  distinguishes "list scrolls internally" from "page scrolls." Together 2a+2b
  pin the exact property "list scrolls, page does not."

**Pre-assertion guard against a vacuous test (carried from 078 §9):** before the
scroll assertions, assert the list actually overshot — i.e. `scrollHeight >
clientHeight` is the overshoot proof itself, and the `eod-item-input-*`
visibility check in `gotoTowsonEod` already confirms items rendered. If the
OQ-4 fixture ever stops running (empty list), `scrollH > clientH` fails loudly
rather than the test passing on an empty screen. Keep that ordering.

**Why US FOOD (31 items) is enough:** verified the seed has US FOOD at Towson
heavily populated; 31 rows × (~64px row + separator) ≫ 812px minus the
header+footer chrome. The overshoot is structural, not data-flaky. If a future
seed trims US FOOD below the overshoot threshold, 2a/2b fail loudly (self-
explaining), not silently.

### 2. Item 2 — the service-role read helper (AC-EOD-PERSIST-1/2/3)

**AC-EOD-PERSIST-1 (UI-only primary) — the design.** The `eod-prefill-banner`
is the black-box persistence signal. Traced: after a successful online submit,
`onSubmit` re-runs `fetchExistingSubmission(store, todayIso(), vendor)` and
`setExisting(fresh)` (EODCount.tsx:333-340); on a fresh reload, the
vendor-change effect (L225-256) calls the same fetch and the banner gate
`existing && submittedTime` (L447) renders `eod-prefill-banner` (L451). So a
**page reload** after the AC-EOD1 submit is the cleanest proof. Sequence:

```
// (continues the existing AC-EOD1 case in eod.spec.ts)
await page.getByTestId(inputTestId).fill('7');
await page.getByTestId('eod-submit').click();
await expect(page.getByTestId('eod-queue-indicator')).toHaveCount(0);   // drained

// AC-EOD-PERSIST-1: reload the SAME (store, vendor, today) → banner proves persist
await gotoTowsonEod(page);   // re-navigates picker → EOD → re-selects US FOOD
await expect(page.getByTestId('eod-prefill-banner')).toBeVisible();
```

`gotoTowsonEod` already re-selects US FOOD (the same vendor), so the reload hits
the same `(store, date, vendor)` tuple the submit wrote — the banner only
renders if the row persisted server-side. This is UI-only, black-box, and the
**standard persistence assertion** for the suite.

**AC-EOD-PERSIST-2 (the ONE service-role read) — the helper.**

- **Where it lives: a new shared `e2e/fixtures/db.ts`.** Today `global-setup.ts`
  and `global-teardown.ts` each duplicate the same 8-line client construction
  (URL + service-role key + the demo-key fallback) and `global-teardown.ts`
  already imports `assertLocalStack` *from* `global-setup.ts`. That cross-import
  is a smell — the guard and the key live in a setup file. Extract a small DRY
  module so the new read, the setup, and the teardown share one client factory.
  This is the right time (a third consumer is landing). Shape:

```
// e2e/fixtures/db.ts — shared service-role client for the e2e/ tree.
// LOCAL-stack only; the key is the well-known demo service key (env-overridable).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '<well-known local demo key>';

export function assertLocalStack(url: string): void { /* moved verbatim from global-setup */ }

export function serviceRoleClient(): SupabaseClient {
  assertLocalStack(SUPABASE_URL);                  // guard fires on every construction
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

  `global-setup.ts` and `global-teardown.ts` are refactored to import
  `serviceRoleClient` + `assertLocalStack` from `e2e/fixtures/db.ts` (behavior
  identical — same URL, same key, same guard; pure de-duplication). This keeps
  the "service-role touches DB only in the `e2e/` tree" boundary intact and
  gives the EOD spec one import. **This refactor is backend-developer-owned
  (`e2e/` tree); it touches no `src/`.**

- **The read itself, co-located in `e2e/eod.spec.ts`:**

```
import { serviceRoleClient } from './fixtures/db';

// AC-EOD-PERSIST-2: belt-and-suspenders — ONE service-role read.
const db = serviceRoleClient();
const { data, error } = await db
  .from('eod_submissions')
  .select('id, eod_entries(item_id, actual_remaining)')
  .eq('store_id', SEED.towsonStoreId)
  .eq('date', /* today ISO, same derivation as todayIso() */)
  .eq('vendor_id', SEED.vendorUsFoodId)
  .maybeSingle();
expect(error).toBeNull();
expect(data, 'expected an eod_submissions row for (Towson, today, US FOOD)').not.toBeNull();
// AC-EOD-PERSIST-3: assert the ENTRY for the item we filled exists (presence,
// not a count of submissions). itemId is parsed from inputTestId
// ('eod-item-input-<uuid>' → <uuid>).
const itemId = inputTestId.replace('eod-item-input-', '');
const entry = (data!.eod_entries ?? []).find((e) => e.item_id === itemId);
expect(entry, `expected an eod_entries row for item ${itemId}`).toBeDefined();
expect(Number(entry!.actual_remaining)).toBe(7);   // the value THIS run submitted
```

- **AC-EOD-PERSIST-3 (idempotent across re-runs): SATISFIED by design.**
  `staff_submit_eod` upserts on `(store, date, vendor)`, so a re-run **overwrites
  rather than duplicates**. The read uses `.maybeSingle()` keyed on
  `(store, date, vendor)` and asserts **presence of the row + the entry for the
  filled item + the value this run submitted (7)** — never a count of
  submissions. So it converges on a non-reset local DB and is safe against the
  invite/EOD specs running before it. The date must use the **same derivation as
  `todayIso()`** (UTC `YYYY-MM-DD` from `new Date()`, EODCount.tsx:58-62) so the
  read's date key matches what the app wrote — replicate that one-liner in the
  spec (or export a tiny `todayIso()` from `e2e/fixtures/db.ts`; recommended, so
  the test and app agree on the date boundary by construction).

- **Scoped to this test's own submission: CONFIRMED.** The read filters
  `store_id = Towson AND date = today AND vendor_id = US FOOD` — the exact tuple
  AC-EOD1 wrote. No other spec writes EOD for that tuple (the offline case in the
  same file fills `'5'` but **the AC-EOD1 case fills `'7'` and persists online**;
  ordering note below). It cannot be polluted by the invite/reorder/dashboard
  specs (different tables).

- **NO `e2e.yml` change needed: CONFIRMED.** The service-role key is already
  exported into `$GITHUB_ENV` by the spec-078 post-merge fix-pass step (the
  quote-stripped `sed -E 's/^([A-Za-z_]+)="(.*)"$/\1=\2/'` export). The new read
  reads `SUPABASE_SERVICE_ROLE_KEY` from env exactly as `global-setup.ts` does —
  same env var, same step. No new secret, no new step, no workflow edit. This is
  AC-CI-1's "zero workflow change" default and it holds.

**Ordering call-out for the EOD spec author (not a blocker):** put the
persistence assertions in the **AC-EOD1 online case** (which fills `'7'` and
submits online → persists), NOT the AC-EOD2/3 offline case (which may leave the
item queued mid-test). The online case is the one whose write definitely reached
the server by the time the reload + service-read run. Keep the two cases'
filled values distinct (`'7'` online, `'5'` offline) so a stale-row read can
never accidentally match the wrong case.

### 3. Item 3 — flake-proofing patterns (AC-FLAKE-1/2/3 + AC-FLAKE-SEL)

I audited all 7 existing specs. The harness is already in good shape — the 078
developer used `expect().toBeVisible()` / `toHaveCount()` (auto-retrying
web-first assertions) and `expect.poll` for the offline timing, **zero
`waitForTimeout`/sleep anywhere**, and every navigation asserts the destination
`*-root` before interacting. The **one** real flake surface is text-based
sidebar nav.

**AC-FLAKE-SEL — sidebar nav testIDs: IN. Add `nav-${item.id}` to `TreeGroup`.**
The specs navigate via `page.getByText(SIDEBAR_LABEL.x, { exact: true })`
(invite/dashboard/reorder/audit). This is fragile to copy/i18n changes AND
`getByText` can match a stray occurrence of the same string elsewhere on screen
(e.g. a section header or a command-palette entry), forcing the brittle
`.first()` qualifier the specs already carry. The clean kill: the section nav
items flow `cmdSelectors.ts` (ids `'Dashboard'`/`'Reorder'`/`'AuditLog'`/
`'Users'`, L1088-1140) → `TreeItem.id` → `TreeGroup`'s non-editMode
`TouchableOpacity` (TreeGroup.tsx:130-167, `key={item.id}`). Add **one leaf
attribute** there:

```
// TreeGroup.tsx — the non-editMode <TouchableOpacity key={item.id} ...>
testID={`nav-${item.id}`}
```

This instruments **every** sidebar item at once (not just the four sections)
with a stable, i18n-immune id. The four the specs use become
`nav-Dashboard`, `nav-Reorder`, `nav-AuditLog`, `nav-Users`. The specs then
navigate via `page.getByTestId('nav-Reorder').click()` — no `.first()`, no
label text, no i18n coupling. **This is the single highest-value flake-kill in
the spec.** It is a frontend disjoint-split item (one file: `TreeGroup.tsx`).

Edge cases I checked:
- The **editMode** branch renders a static `<View>` (no nav) — correctly NOT
  instrumented (it's not navigable). Only the navigable `TouchableOpacity` gets
  the testID. Good.
- **`restricted` items** render the touchable with `disabled` — still get the
  testID, which is fine (a disabled nav item is addressable but `.click()` is a
  no-op; the specs only click enabled sections their role can see). The master
  session sees `Users` enabled; admin sessions never render it (master-gated),
  so `nav-Users` simply won't exist for admin — the invite spec correctly runs
  as master.
- **Three breakpoints:** desktop uses `Sidebar` → `TreeGroup`; the rail
  (`RailSidebar`) and mobile (`MobileNavDrawer`) are separate components.
  Playwright runs **Desktop Chrome** → the desktop `Sidebar`/`TreeGroup` path,
  so instrumenting `TreeGroup` covers every spec that navigates. The rail/mobile
  nav is out of the E2E path and out of scope (no spec drives a phone-width
  admin shell). If a future spec does, it instruments those then. **Constants:
  replace `SIDEBAR_LABEL` with a `SIDEBAR_NAV` testID map** in
  `e2e/fixtures/constants.ts` (`{ dashboard: 'nav-Dashboard', reorder:
  'nav-Reorder', auditLog: 'nav-AuditLog', users: 'nav-Users' }`); keep
  `SIDEBAR_LABEL` only if any non-converted call site remains (it should not —
  convert all four).

**AC-FLAKE-1 hardening checklist (what the BE dev does to each spec):**
- **auth.spec.ts** — no nav; already clean (web-first assertions, no sleeps). No
  change beyond a possible `waitForLoadState` nicety after `goto('/')` if the
  cold-boot first paint races the `signin-email` locator (the `expect(...
  ).toBeVisible()` auto-retry already covers this — only add the explicit wait
  if a flake is observed; do NOT add speculative waits).
- **dashboard / reorder / audit.spec.ts** — swap `getByText(SIDEBAR_LABEL.x,
  {exact:true}).first().click()` → `getByTestId(SIDEBAR_NAV.x).click()`.
  Behavioral assertion (`*-root` visible) unchanged (AC-FLAKE-3).
- **invite.spec.ts** — same sidebar swap for `nav-Users`. Plus the P2 deepening
  (§5 below). Behavioral assertions preserved.
- **eod.spec.ts** — already clean (the `expect.poll(navigator.onLine)` pattern
  is the canonical offline-timing guard). Gets the P1 deepenings (scroll +
  persistence). No nav-text to swap (it uses `store-row-{id}` testIDs already).
- **dark-mode.spec.ts** — already clean (computed-bg assertion, addInitScript
  seed, no sleeps). No change.

**AC-FLAKE-3 — behavioral assertions UNCHANGED.** Every swap above changes only
*how* the suite navigates (testId vs label text); the `expect(...
).toBeVisible()` / `toHaveCount()` targets are identical. The P1/P2 deepenings
ADD assertions (additive, per the AC-FLAKE-3 exception); they rewrite no
existing one.

**AC-FLAKE-2 — the flake-pattern checklist for `tests/README.md` Track 4.**
Verbatim content the BE dev adds (the durable artifact):

> **Flake-proofing checklist (Track 4).** Every E2E spec MUST follow these.
> The suite must hold <5% flake to earn the AC-PROMO1 promotion; one flaky
> spec blocks the 20-green streak for the whole suite.
> 1. **Navigate by `getByTestId`, never `getByText`.** Sidebar sections use the
>    `nav-<SectionId>` testIDs (`nav-Dashboard`, `nav-Reorder`, `nav-AuditLog`,
>    `nav-Users`). Label text is i18n/copy-fragile and can match a stray
>    occurrence elsewhere on screen. Reference: `e2e/fixtures/constants.ts`
>    `SIDEBAR_NAV`.
> 2. **No fixed `waitForTimeout`/sleep.** Use web-first auto-retrying assertions
>    (`await expect(locator).toBeVisible()` / `.toHaveCount(0)` / `.toBeEnabled()`)
>    or `expect.poll(...)` for non-DOM conditions (e.g. `navigator.onLine`).
>    A fixed sleep is either too short (flake) or too slow (wasted CI time).
> 3. **Assert the destination before interacting.** After any navigation, assert
>    the target `*-root` testID is visible before clicking inside it. Never
>    assume "the click worked."
> 4. **Assert absence with `toHaveCount(0)`, never a timeout.** Proving a thing
>    is gone (queue drained, drawer closed) uses `expect(locator).toHaveCount(0)`
>    (auto-retries up to the expect timeout), not a sleep-then-check.
> 5. **Each test starts from clean per-test state.** Playwright gives each test a
>    fresh `BrowserContext` (fresh localStorage). storageState carries auth ONLY
>    (the setup project never submits EOD). The EOD specs additionally clear the
>    offline-queue key (`imr-staff:eod-queue:v1`) in `beforeEach` via
>    `addInitScript` — defense against localStorage bleed.
> 6. **Key mutating-flow assertions off THIS run's unique input, never an
>    absolute row count.** Invite uses `e2e-invite+<runId>@local.test`; EOD reads
>    the row for `(store, today, vendor)` and asserts presence + the value this
>    run submitted. A non-reset local DB must not break a re-run.
> 7. **Reproduce viewport-specific layout at the right viewport.** The scroll
>    guard runs at 375×812 (`test.use({ viewport })`); the default Desktop Chrome
>    viewport would pass it vacuously.
> 8. **Service-role DB access stays in the `e2e/` tree** via
>    `e2e/fixtures/db.ts` `serviceRoleClient()` (LOCAL-stack only, guarded by
>    `assertLocalStack`). It is the lone exception to UI-only assertions and is
>    used by exactly one assertion (EOD persistence). Do not spread it.

### 4. Item 4 — confirm the spec-074 dashboard-window E2E deferral: **CONFIRMED. Defer to a future spec 080.**

The PM's rationale holds on both legs, verified against code:

1. **Date-keyed fixture the current harness can't produce.** The Monday-reset
   attention queue (spec 074) windows `unconfirmed_po` to "this work-week" and
   the missed-order derivation is *schedule-vs-submission per calendar date*. The
   OQ-4 fixture is **weekday-keyed** (`order_schedule.day_of_week`,
   `WEEKDAYS[d.getDay()]`), not date-keyed — it deliberately schedules *every*
   weekday so "today" always has chips. To exercise a *miss*, you need
   `order_schedule` expectations on **past dates** with **no** matching
   `eod_submissions` on those dates — genuinely new fixture scope (a date-series
   generator + submission gaps), not a tweak to the existing weekday fixture.

2. **The pgTAP Towson collision is real.** `supabase/tests/
   missed_order_audit_rpc.test.sql` arm C uses **Towson** as its positive-case
   store and asserts the missed-order RPC returns **exactly 1**. This is the
   exact collision `e2e/global-teardown.ts` was *added in the 078 fix-pass to
   prevent* — the teardown deletes the OQ-4 Towson `order_schedule` rows
   precisely because, left behind, the RPC counts them and arm C fails. A
   date-based missed-order fixture on Towson would re-introduce that collision in
   a form the current vendor-scoped teardown does NOT clean (it deletes by the
   two fixture vendor_ids on all weekdays; date-keyed miss rows would need a
   different, date-scoped teardown). Building it on Towson is a regression
   waiting to happen.

3. **Already covered deterministically at the jest layer.** Spec 074's windowing
   has 8+ jest tests with injected `now` (`cmdSelectors.unconfirmedPoWindow.test
   .ts` + `weekWindow.test.ts`). The marginal value of an E2E layer over
   injected-clock jest unit tests is low relative to the fixture + flake +
   teardown cost.

**Verdict: defer, do not pull in.** If the user later wants end-to-end window
coverage, the clean path (for spec 080) is a **dedicated non-Towson e2e store**
with its own inventory + a **date-keyed** `order_schedule`/`eod_submissions`
fixture and a **date-scoped teardown** — so it never touches Towson and never
collides with the pgTAP arm C. That is net-new scope and the right home is its
own spec. I record it as the explicit prerequisite, matching the PM's framing.

### 5. P2 deepenings — concrete shapes

**AC-INV-DEPTH-1 (invite durable effect).** The existing invite spec asserts the
drawer closes (`invite-email` count 0) + back on `users-root`. Deepen to assert
the invited user appears in the Users list, keyed off this run's uniquified
email. The §7 #11 per-row testID from 078 is `user-row-{id}` — but the **new
row's id is not addressable without a service-role lookup** (the UI doesn't
surface it post-invite). So per AC-INV-DEPTH-1's own fallback, assert the
**invited email text appears in the rendered Users list**:

```
const email = uniqueInviteEmail();
// ... fill + submit (existing) ...
await expect(page.getByTestId('invite-email')).toHaveCount(0);   // drawer closed
await expect(page.getByTestId('users-root')).toBeVisible();
// Durable effect: the invited email now renders as a row in the Users list.
// Keyed off THIS run's unique email (AC-INV2 isolation preserved) — NOT a count.
await expect(page.getByText(email, { exact: false })).toBeVisible();
```

This is the **one place a `getByText` is correct** — it asserts *content the
test itself created* (the unique email), not navigation chrome. It is not
i18n-fragile (the email is the test's own data). It needs no new testID. (If the
Users list virtualizes and the new row is off-screen, the BE dev scrolls the
list container into view first or filters by the email if a search box exists —
note for the implementer; the seed user count is small so virtualization is
unlikely to hide it.) **No frontend testID required for this AC.**

**AC-REORD-DEPTH-1 (reorder action depth) + AC-REORD-DEPTH-SEL.** The Reorder
section has **no durable mutating action** (verified: ReorderSection.tsx:604-673
— the only actions are CSV export, PDF export, Refresh; no mark-ordered /
generate-PO). The deepening exercises the action surface that exists:

```
await page.getByTestId(SIDEBAR_NAV.reorder).click();
await expect(page.getByTestId('reorder-root')).toBeVisible();

// showExport gate (L597): export controls render only when the payload has
// vendors. Seed has Towson inventory across vendors → the reorder payload is
// non-empty for the admin's selected store → export buttons render.
await expect(page.getByTestId('reorder-export-csv')).toBeVisible();
await expect(page.getByTestId('reorder-export-pdf')).toBeVisible();

// Exercise Refresh: click it, assert the loading→loaded transition completes
// (the label returns from 'LOADING…' to 'REFRESH') and the section stays mounted.
await page.getByTestId('reorder-refresh').click();
await expect(page.getByTestId('reorder-refresh')).toHaveText('REFRESH', { timeout: 15_000 });
await expect(page.getByTestId('reorder-root')).toBeVisible();   // still mounted
```

- **AC-REORD-DEPTH-SEL: IN. Add three testIDs to ReorderSection.tsx** — the
  CSV/PDF/Refresh `TouchableOpacity`s (L626/L640/L656) have `accessibilityLabel`s
  but no `testID`. Add `reorder-export-csv`, `reorder-export-pdf`,
  `reorder-refresh`. Frontend disjoint-split items (one file).
- **`showExport` precondition check:** `showExport` (L597) requires
  `Platform.OS === 'web'` (true under Playwright) AND `reorderPayload.vendors
  .length > 0` AND no error AND not initial-loading. The admin's default selected
  store must yield a non-empty reorder payload. **Implementer must verify** the
  admin session's active store has reorder-eligible inventory in the seed; if the
  default store yields an empty payload, the export buttons won't render and the
  test must first select a store that does (or the assertion narrows to: if
  `showExport`, assert buttons; always assert Refresh + the loaded transition).
  The **Refresh button always renders** (it's outside the `showExport` gate), so
  the Refresh + loaded-transition assertion is the **guaranteed floor**; the
  export-button-visible assertion is the richer add that depends on payload
  content. Recommend keeping both but writing the export check defensively.
- **The CSV/PDF download-event assertion (`page.waitForEvent('download')`):
  OPTIONAL — EXCLUDE from v1.** Rationale: it adds a download-handler dependency
  and jsPDF/PapaParse blob downloads on react-native-web are an extra flake
  surface (the download event timing + the headless-Chromium download path).
  The enable + refresh + loaded-transition assertion is the AC-REORD-DEPTH-1
  floor and exercises the action surface meaningfully without the download
  dependency. If the user later wants download coverage, it's a one-case add
  behind a `page.waitForEvent('download')` with a saved-path assertion — note it
  as a follow-up, don't build it now.

### 6. The frozen testID contract (the FE disjoint-split, exactly like 078 §7)

These are the **only** production `src/` edits in this spec. Every one is a
non-behavioral leaf attribute add (or, for `TreeGroup`, a templated leaf on the
existing navigable touchable). The frozen names below are the contract between
the FE dev and the BE dev — the BE specs reference these exact strings.

| # | File | Element | testID to add | AC | In/Out |
|---|------|---------|---------------|-----|--------|
| 1 | `src/screens/staff/screens/EODCount.tsx` — the populated `<FlatList>` (L522) | items list outer (scroll container) | `eod-item-list` | AC-072-SEL / AC-072-2 | **IN** (required) |
| 2 | `src/components/cmd/TreeGroup.tsx` — the non-editMode `<TouchableOpacity key={item.id}>` (L130-167) | every sidebar nav item | `nav-${item.id}` (→ `nav-Dashboard`, `nav-Reorder`, `nav-AuditLog`, `nav-Users`) | AC-FLAKE-SEL | **IN** (recommended flake-kill) |
| 3 | `src/screens/cmd/sections/ReorderSection.tsx` — CSV `<TouchableOpacity>` (L626) | export CSV | `reorder-export-csv` | AC-REORD-DEPTH-SEL | **IN** |
| 4 | `src/screens/cmd/sections/ReorderSection.tsx` — PDF `<TouchableOpacity>` (L640) | export PDF | `reorder-export-pdf` | AC-REORD-DEPTH-SEL | **IN** |
| 5 | `src/screens/cmd/sections/ReorderSection.tsx` — Refresh `<TouchableOpacity>` (L656) | refresh | `reorder-refresh` | AC-REORD-DEPTH-1 | **IN** |

**Explicitly OUT (no new testID needed, decided):**
- **Invite durable-effect (AC-INV-DEPTH-1)** needs **no** new testID — it asserts
  the run-unique email text (`getByText(email)`), which is test-created content,
  not chrome. `user-row-{id}` (078 §7 #11) exists but the new row's id isn't
  addressable post-invite without a service lookup; the email-text assertion is
  the AC's own fallback and is cleaner.
- **`eod-prefill-banner`** already exists (EODCount.tsx:451, added pre-079) —
  AC-EOD-PERSIST-1 reuses it. Not net-new.
- **`eod-queue-count`** (078 optional #17) stays unused/unadded — the persistence
  case keys on the banner + the service read, not a queue count.

**Total net-new production testIDs: 5** (1 staff FlatList + 1 templated nav leaf
covering all sidebar items + 3 reorder actions), across **3 files**
(`EODCount.tsx`, `TreeGroup.tsx`, `ReorderSection.tsx`). Clean, disjoint from the
`e2e/` tree.

### 7. API contract / data model / RLS / realtime (rubric completeness)

- **Data model changes:** None. No table, column, index, or migration. The only
  "fixture" is the existing OQ-4 `order_schedule` runtime insert (unchanged) +
  the new EOD persistence service-read (a SELECT, no write).
- **RLS impact:** None. The service-role read bypasses RLS by design (it's a
  test-side verification, local-stack only, guarded by `assertLocalStack`). No
  policy is added or changed. The E2E flows continue to *exercise* existing RLS
  end-to-end (staff EOD under `auth_can_see_store()`, master invite under the
  master gate) — validating composition, not changing it.
- **API contract (PostgREST vs RPC):** No new contract. The persistence read is
  a plain PostgREST `select` on `eod_submissions` + embedded `eod_entries`
  (mirrors `fetchExistingSubmission`'s shape, EODCount.tsx:149-155) via the
  service-role client. No new RPC.
- **Edge function changes:** None (see §0).
- **Realtime impact:** None (see §0 — gotcha does not apply).
- **`src/lib/db.ts` surface:** None. No new helper, no snake_case→camelCase
  mapping. The service read is raw `supabase-js` in test code (raw snake_case
  columns read directly in the spec — acceptable, it's test code, not app code).

### 8. CI impact (AC-CI-1, AC-GREEN-1)

- **Zero `e2e.yml` change.** The service-role key the new read needs is already
  exported (the quote-stripped fix-pass step). The scroll/persistence/invite/
  reorder deepenings are spec edits that run inside the existing job. No new
  step, no new secret, no workflow rewrite. **AC-CI-1 default holds.**
- **`db reset` already runs in CI** (078 OQ-3a) before the suite, so the persist
  read starts from a clean seed each CI run; locally it converges via upsert
  idempotency (AC-EOD-PERSIST-3).
- **AC-GREEN-1** is a post-merge verification step (confirm the latest `e2e.yml`
  run on `main` is green per the CLAUDE.md CI rule); the design makes the suite
  green-able, the developer + release flow confirm it. **This spec does NOT flip
  `e2e.yml` to required** — the AC-PROMO1 gate flip stays a separate
  user-authorized follow-up.

### 9. Risks and tradeoffs (explicit)

- **(Should-fix) The scroll guard is only meaningful at the phone viewport.** If
  the implementer forgets the `test.use({ viewport: { width: 375, height: 812 }
  })` override, the test passes vacuously on Desktop Chrome (no overshoot) and
  guards nothing — the exact silent-degradation class 078 §9 warned about. The
  `scrollHeight > clientHeight` sub-assertion is the tripwire: at desktop width
  the 31 items may still not overshoot 720px, so 2a fails loudly if the viewport
  override is missing. Implementer MUST set the viewport AND keep the
  overshoot-proof assertion. Flagged as the #1 implementation risk.
- **(Should-fix) `showExport` payload dependency for the reorder export
  assertion.** The export buttons render only when the admin's selected store has
  a non-empty reorder payload. If the seed's default-selected store is empty, the
  export-visible assertion fails. Mitigation: the **Refresh** assertion (outside
  the gate) is the guaranteed floor; write the export check defensively (assert
  buttons only after confirming the payload is non-empty, or select a known-good
  store first). Implementer verifies against the seed.
- **(Minor) `e2e/fixtures/db.ts` refactor touches `global-setup`/`global-
  teardown`.** Extracting the shared client is pure de-duplication (identical URL/
  key/guard), but it edits two working files. Risk: a botched extraction breaks
  the OQ-4 fixture. Mitigation: behavior-preserving move (same constants, same
  `assertLocalStack` body); the BE dev runs the fixture once after to confirm 14
  idempotent rows + the teardown still cleans them. Low risk, contained to `e2e/`.
- **(Minor) The persistence reload re-walks StorePicker → EOD.** `gotoTowsonEod`
  re-navigates the full path on reload; if the active-store key isn't persisted
  the second navigation re-taps the store row (already handled — the helper taps
  `store-row-{id}` every time). No extra state needed; just slightly slower (one
  extra navigation). Accepted on a non-blocking job.
- **(Minor) `nav-${item.id}` instruments ALL sidebar items, not just the four
  sections.** Intentional (one templated leaf is cleaner than four conditional
  adds) and harmless — extra addressable nav items cost nothing. The ids are
  stable code constants (`cmdSelectors.ts`), not i18n.
- **(Minor) Cold Metro / flake budget (carried from 078).** Unchanged — the
  deepenings add assertions, not new server boots. The 180s `webServer.timeout`
  + `retries: 2` posture is inherited. The whole point of Phase 2 is to make the
  20-green/<5%-flake bar *reachable*; the flake checklist (AC-FLAKE-2) is the
  durable guard.
- **No CI-gate assumption.** Per CLAUDE.md "No CI assumption," `e2e.yml` stays
  advisory; nothing else gates on it. `db-migrations-applied.yml` is untouched
  (no migration).

### 10. Division of labor (clean disjoint split — exactly like 078 §10)

The two developers work in **disjoint file sets**. The frozen contract is the §6
testID names (5 testIDs across 3 files).

**frontend-developer — production `testID` instrumentation ONLY (3 files):**
- `src/screens/staff/screens/EODCount.tsx` — `eod-item-list` on the populated
  `<FlatList>` (§6 #1).
- `src/components/cmd/TreeGroup.tsx` — `testID={`nav-${item.id}`}` on the
  non-editMode navigable `<TouchableOpacity>` (§6 #2).
- `src/screens/cmd/sections/ReorderSection.tsx` — `reorder-export-csv` /
  `reorder-export-pdf` / `reorder-refresh` (§6 #3-5).
- No other `src/` edits. No store, no behavior, no copy.

**backend-developer — `e2e/` tree + docs ONLY (no `src/` edits):**
- `e2e/fixtures/db.ts` — NEW. Extract `serviceRoleClient()` + `assertLocalStack`
  + `todayIso()` (the shared service-role client; §2).
- `e2e/global-setup.ts` / `e2e/global-teardown.ts` — refactor to import from
  `e2e/fixtures/db.ts` (behavior-identical de-duplication; §2).
- `e2e/eod.spec.ts` — scroll guard (§1, at 375×812) + persistence deepening (§2,
  banner reload + ONE service read).
- `e2e/invite.spec.ts` — durable-effect deepening (§5, run-unique email text) +
  the `nav-Users` sidebar swap.
- `e2e/reorder.spec.ts` — action deepening (§5, export-visible + Refresh + loaded
  transition) + the `nav-Reorder` swap.
- `e2e/dashboard.spec.ts` / `e2e/audit.spec.ts` — the `nav-*` sidebar swaps
  (behavioral assertion unchanged).
- `e2e/auth.spec.ts` / `e2e/dark-mode.spec.ts` — audited clean; no change (do not
  add speculative waits).
- `e2e/fixtures/constants.ts` — add `SIDEBAR_NAV` testId map (`nav-Dashboard`
  etc.); retire/convert `SIDEBAR_LABEL` call sites.
- `tests/README.md` — Track-4 update (AC-DOC-1): the new behavioral coverage, the
  single service-role-read carve-out + why it's the lone UI-only exception, and
  the AC-FLAKE-2 flake checklist (§3 verbatim). Restate AC-PROMO1 unchanged.

**Why the split is clean:** FE touches only `src/` (3 files); BE touches only
`e2e/` + `tests/README.md`. No co-owned file. The only contract is the 5 testID
names in §6 — frozen here, so the BE dev authors specs against `getByTestId(
'eod-item-list')` / `getByTestId('nav-Reorder')` / `getByTestId('reorder-
refresh')` before the FE edits land (specs fail until the testIDs exist, expected
in a parallel split). Both can start immediately.

**Developer split recommendation: `backend-developer, frontend-developer` in
parallel.** New testIDs ARE needed (5 of them, §6), so the disjoint two-dev split
applies, not a backend-solo. BE owns `e2e/` + flake-proofing + README; FE owns
the 3-file production testID additions.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend / Frontend design in this spec, in
  parallel, in DISJOINT file sets. backend-developer owns the e2e/ tree + docs
  ONLY (no src/ edits): the new e2e/fixtures/db.ts shared service-role client
  (extract serviceRoleClient + assertLocalStack + todayIso, refactor global-
  setup/global-teardown to import it — behavior-identical), the eod.spec.ts
  scroll guard at 375×812 (Submit-in-viewport + list-scrolls-internally + body-
  does-not-scroll, three sub-assertions per §1) and EOD persistence deepening
  (eod-prefill-banner reload + the ONE service-role read of eod_submissions per
  §2/AC-EOD-PERSIST), the invite.spec.ts durable-effect deepening (run-unique
  email text), the reorder.spec.ts action deepening (export-visible + Refresh +
  loaded transition per §5; NO download-event assertion), the nav-* sidebar
  testId swaps across dashboard/reorder/audit/invite specs, the SIDEBAR_NAV
  constant in e2e/fixtures/constants.ts, and the tests/README.md Track-4 doc +
  flake checklist (§3 verbatim, AC-DOC-1/AC-FLAKE-2). DO NOT add speculative
  waitForTimeout. frontend-developer owns ONLY the §6 testID contract in src/
  (3 files): eod-item-list on the EODCount populated FlatList; nav-${item.id} on
  the non-editMode TreeGroup TouchableOpacity (yields nav-Dashboard/Reorder/
  AuditLog/Users); and reorder-export-csv/-pdf/-refresh on the three
  ReorderSection action TouchableOpacitys. The frozen contract is the 5 testID
  names in §6 — do not rename them. No e2e.yml change (the service-role key is
  already exported). After implementation, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed.
payload_paths:
  - specs/079-e2e-phase2-behavioral-depth.md

---

## Files changed (backend/e2e)

This is the **harness/spec half** of the disjoint parallel split (§10). It owns
the `e2e/` tree + `tests/README.md` ONLY — **zero `src/` production edits** (the
frontend-developer owns the §6 testIDs in parallel). No `e2e.yml` change (the
service-role key is already exported by the 078 fix-pass). No migration, no RPC,
no edge function.

### e2e/ tree — fixtures

- **`e2e/fixtures/db.ts`** (NEW) — shared service-role client for the `e2e/`
  tree. Exports `serviceRoleClient()` (the `@supabase/supabase-js` client with
  the local demo service-role key), `assertLocalStack(url)` (the 078 prod-URL
  guard, byte-for-byte unchanged), and `todayIso()` (LOCAL-time `yyyy-mm-dd`, a
  byte-for-byte mirror of `EODCount.todayIso()` — see review note 1). The
  service-role helper was **EXTRACTED, not newly introduced** — it previously
  lived in `global-setup.ts` and `global-teardown.ts` cross-imported it; the
  078 security audit already cleared it.
- **`e2e/global-setup.ts`** — refactored to import `serviceRoleClient` from
  `e2e/fixtures/db.ts` instead of constructing the client + guard inline.
  Behavior-identical (same URL, same key, same guard; same 14-row idempotent
  `order_schedule` upsert). The guard now fires inside `serviceRoleClient()`.
- **`e2e/global-teardown.ts`** — refactored to import `serviceRoleClient` from
  `e2e/fixtures/db.ts` instead of cross-importing `assertLocalStack` from
  `global-setup.ts` and constructing the client inline. Behavior-identical (the
  Towson `order_schedule` vendor-scoped delete still fires — verified: pgTAP
  `missed_order_audit_rpc` arm C stays green and zero stale fixture rows remain
  after a run).
- **`e2e/fixtures/constants.ts`** — replaced `SIDEBAR_LABEL` (i18n label-text
  map) with `SIDEBAR_NAV` (the `nav-*` testID map: `nav-Dashboard` /
  `nav-Reorder` / `nav-AuditLog` / `nav-Users`). All four call sites converted.

### e2e/ tree — specs

- **`e2e/eod.spec.ts`** — (a) AC-072 scroll guard: a nested `test.describe` with
  `test.use({ viewport: { width: 375, height: 812 } })` (scoped — Desktop Chrome
  would pass it vacuously), asserting Submit-in-viewport + `eod-item-list`
  internal-scroll (overflow-y auto/scroll AND scrollHeight>clientHeight, the
  anti-vacuous tripwire) + body-does-not-scroll, via `page.evaluate`/
  `boundingBox`. (b) AC-EOD-PERSIST: the online case now waits on the in-place
  `eod-prefill-banner` as the deterministic submit-success checkpoint (see
  review note 2), reloads + re-asserts the banner (durable persistence), then
  performs the suite's ONE service-role read of `eod_submissions` for (Towson,
  today, US FOOD) asserting the row + the filled item's value (7). Also made the
  `gotoTowsonEod` helper robust to BOTH landing states (StorePicker on a fresh
  context; direct-to-EODCount on reload via the persisted active-store key) —
  required for the persistence reload to work.
- **`e2e/invite.spec.ts`** — `nav-Users` swap + AC-INV-DEPTH-1 durable-effect:
  after the drawer closes, assert the run-unique email
  (`e2e-invite+<runId>@local.test`) renders as a row in the Users list (the one
  correct `getByText` — test-authored content, not chrome). Keyed off this
  run's email, never a count.
- **`e2e/reorder.spec.ts`** — `nav-Reorder` swap + AC-REORD-DEPTH-1: click
  `reorder-refresh` (the guaranteed floor, outside the export gate) and assert
  the LOADING→REFRESH loaded transition + section stays mounted; DEFENSIVELY
  assert `reorder-export-csv`/`-pdf` are enabled only WHEN visible (the
  `showExport` payload gate — architect risk #2). No download-event assertion
  (excluded from v1).
- **`e2e/dashboard.spec.ts`** — `nav-Dashboard` swap (behavioral assertion
  unchanged, AC-FLAKE-3).
- **`e2e/audit.spec.ts`** — `nav-AuditLog` swap (behavioral assertion unchanged).
- `e2e/auth.spec.ts` / `e2e/dark-mode.spec.ts` — audited clean (no `getByText`
  nav, no `waitForTimeout`); NOT changed (no speculative waits added).

### docs

- **`tests/README.md`** — Track-4 update (AC-DOC-1): the new behavioral coverage
  (scroll guard, EOD persistence, invite durable-effect, reorder action), the
  single service-role-read carve-out + why it's the lone UI-only exception, the
  `nav-*` selector-strategy update, the `fixtures/db.ts` layout entry, and the
  verbatim 8-point flake checklist (AC-FLAKE-2). AC-PROMO1 restated unchanged.

### Verification (local)

- `npx tsc --noEmit -p e2e/tsconfig.json` → exit 0.
- `npx jest` → 386/386 pass, 40/40 suites (untouched; `EODCount.test.tsx` still
  green).
- `scripts/test-db.sh` → 38/38 pgTAP (incl. the Towson `missed_order_audit_rpc`
  arm C — proves the fixtures/db.ts refactor preserved teardown behavior).
- `npx playwright test --project=setup --project=chromium` → **9 passed**; the
  **5 failures are EXCLUSIVELY blocked on the not-yet-landed §6 frontend
  testIDs** (`eod-item-list`, `nav-Dashboard/Reorder/AuditLog/Users`) — expected
  mid-parallel-build. The parts verifiable independent of the new testIDs all
  pass: the EOD persistence service-role read (proven green end-to-end), the
  fixtures/db.ts refactor lifecycle (14 rows inserted / removed per run), auth,
  dark-mode, and the offline EOD case. The scroll-probe LOGIC was validated at
  375×812 against the live DOM via a throwaway probe (the FlatList outer is
  `overflow-y:auto`, scrollHeight 799 > clientHeight 533, Submit bottom 800 ≤
  812, body does not scroll) — it will go green the moment `eod-item-list` lands
  on the FlatList outer.

### Review notes (design corrections within the e2e/ surface — NOT contract changes)

1. **`todayIso()` is LOCAL time, not UTC.** The design §2 parenthetical wrote
   "(UTC `YYYY-MM-DD`)", but `EODCount.todayIso()` (EODCount.tsx:57-63 — the
   source of truth the read must match) uses LOCAL time (`getFullYear`/
   `getMonth`/`getDate`). I matched the actual app derivation byte-for-byte,
   which is what the design's overriding instruction ("the same derivation as
   `todayIso()`") required. The "(UTC...)" note was a factual slip; the frozen
   contract is unaffected.
2. **Persistence sync point is the in-place banner, not the queue indicator.**
   The design §2 sequence used `eod-queue-indicator toHaveCount(0)` as the
   post-submit checkpoint before reloading. For an ONLINE submit the item is
   never queued, so that assertion is vacuously true from the start and does NOT
   wait for the RPC — the reload then raced the in-flight submit (observed: zero
   rows persisted, banner absent). I synchronize on the `eod-prefill-banner`
   appearing IN-PLACE instead (`onSubmit` re-runs `fetchExistingSubmission` +
   `setExisting` on success, EODCount.tsx:333-340), which is the deterministic
   "submit landed + row server-readable" signal. This strengthens the assertion
   and is fully within the design's intent (the banner IS the named persistence
   signal). The queue-indicator check is retained as the "submitted online, not
   queued" assertion. No frontend testID change.

## Files changed (frontend/testID)

Author: frontend-developer. The §6 frozen contract — 5 net-new production
`testID`s across 3 `src/` files, all non-behavioral leaf attribute adds (RN
`testID` → DOM `data-testid` on web). Names match §6 byte-for-byte; no renames,
no variants. Disjoint from the `e2e/` tree (BE-dev surface, untouched).

- **`src/screens/staff/screens/EODCount.tsx`** — added `testID="eod-item-list"`
  on the populated items `<FlatList>` (the `style={styles.itemListBody}` /
  `contentContainerStyle={styles.itemList}` branch). RN-web lands the FlatList
  `style` on the outer ScrollView host node, so this is the scroll-container the
  spec-072 guard probes for `overflow-y` + `scrollHeight > clientHeight`. (§6 #1,
  AC-072-SEL / AC-072-2)
- **`src/components/cmd/TreeGroup.tsx`** — added ``testID={`nav-${item.id}`}`` on
  the non-editMode navigable `<TouchableOpacity key={item.id}>`. `item.id` is
  typed `string` on the `TreeItem` interface, so the template literal typechecks.
  This instruments every sidebar nav item at once; the four the specs address
  render as `nav-Dashboard`, `nav-Reorder`, `nav-AuditLog`, `nav-Users`. The
  editMode static-`<View>` branch is intentionally NOT instrumented (not
  navigable). (§6 #2, AC-FLAKE-SEL)
- **`src/screens/cmd/sections/ReorderSection.tsx`** — added three testIDs on the
  TabStrip `rightSlot` action `<TouchableOpacity>`s:
  - `testID="reorder-export-csv"` on the CSV export button (`onPress={onCsvPress}`,
    inside the `showExport` gate). (§6 #3, AC-REORD-DEPTH-SEL)
  - `testID="reorder-export-pdf"` on the PDF export button (`onPress={onPdfPress}`,
    inside the `showExport` gate). (§6 #4, AC-REORD-DEPTH-SEL)
  - `testID="reorder-refresh"` on the Refresh button (`onPress={refresh}`, outside
    the `showExport` gate). (§6 #5, AC-REORD-DEPTH-1)

### Verification (frontend)

- `npx tsc --noEmit -p tsconfig.json` → **exit 0**, zero diagnostics (the
  `nav-${item.id}` template literal typechecks — `item.id: string`).
- `npx jest` → **386 passed / 386 total, 40/40 suites** — baseline preserved,
  testID adds are inert (the `EODCount.test.tsx` `act(...)` console.error is a
  pre-existing VirtualizedList warning, not a failure).
- `npx playwright test` (local stack up, chromium) → **14 passed** (3 setup + 11
  chromium), exit 0. The 5 specs the BE dev flagged as blocked on these testIDs
  all go green with them landed: `eod.spec.ts` scroll guard (L237) +
  AC-EOD1/persist (L109), `reorder.spec.ts` AC-REORD-DEPTH-1 (L35),
  `dashboard.spec.ts` (L20), `audit.spec.ts` (L18), and `invite.spec.ts` (L46,
  via `nav-Users`). This is the visual proof: a real browser drives these screens
  and resolves every testID-targeted selector.
- Preview MCP tools (`mcp__Claude_Preview__*`) are not in this agent's loadout;
  the green browser-driven Playwright run (which renders the screens for real)
  supersedes an eyeballed screenshot for confirming the invisible testID adds.
